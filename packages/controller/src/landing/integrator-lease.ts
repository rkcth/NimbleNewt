import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { taskId as checkTaskId, text } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { ControllerStorage, AggregateRef, Change, JsonObject } from "../storage/types.js";
import type { LeaseHandover } from "../lifecycle/handoff.js";

/**
 * The integrator lease of a landing branch (card L03j; the first part of P10's "fenced, expiring lease per landing branch"). One lease per project and branch. Whoever holds it is the one integrator that may land on that
 * branch; every hold has a fence number that grows by one each time the lease changes hands, so a holder that was replaced (it expired, was released or handed over) is told `fenced` the moment it tries to renew or release
 * with its old number. A lease that is not renewed before `expiresAt` is free: the next `acquire` takes it with a new fence, so a lost integrator never keeps the branch.
 *
 * The service takes no caller: it is for code that builds the services (the landing service of P10, the hand-off). Who may take a lease, and the owner-only rule for moving one to another agent with a hand-off, are decided
 * by that code. Each change is one recorded command, so a repeat of a command ID answers what it did the first time, and a release or move made under another command ID for a fence that is no longer current is refused
 * (`fenced`), never applied twice.
 */
export const LEASE_LIMITS = { ttlMinMs: 60_000, ttlMaxMs: 24 * 3_600_000, branch: 200, note: 300, perTask: 8 } as const;
const KIND = "integrator-lease";
/** The leases a task has held (most recent last, at most `perTask`), so the hand-off finds the sender's without reading every lease. */
const TASK_INDEX = "integrator-lease-task";
const BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]+$/;

export interface IntegratorLeaseBody {
  readonly projectId: string;
  readonly branch: string;
  /** The agent ID of the holder (not its principal ID). */
  readonly holder: string;
  /** The task the holder works the landing under. */
  readonly taskId: string;
  readonly fence: number;
  readonly ttlMs: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly state: "held" | "released";
  readonly releasedAt?: string;
  readonly note?: string;
}
export interface IntegratorLease extends IntegratorLeaseBody { readonly leaseId: string; readonly revision: number; readonly live: boolean }

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const json = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const fenced = (message: string): DomainError => new DomainError("fenced", message);

export class IntegratorLeaseService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): IntegratorLeaseService {
    return new IntegratorLeaseService(new CommandRunner(storage, epoch, options));
  }

  /** The lease record of a project's branch (one per branch, whoever holds it). */
  static leaseIdOf(projectId: string, branch: string): string { return derivedId("ilz", `lease\0${projectId}\0${branch}`); }

  /** Takes the branch's lease for `holder` working on `taskId`. Refused (`unavailable`) while someone else holds it and it has not expired; two at the same moment: one wins, the other is refused. */
  async acquire(command: { commandId: string; projectId: string; branch: string; holder: string; taskId: string; ttlMs: number }): Promise<IntegratorLease> {
    const projectId = text(command.projectId, "projectId", { min: 1, max: 100 });
    const branch = text(command.branch, "branch", { min: 1, max: LEASE_LIMITS.branch });
    if (!BRANCH.test(branch)) invalid("branch", "is not a branch name");
    const holder = text(command.holder, "holder", { min: 1, max: 100 });
    const taskId = checkTaskId(command.taskId);
    const ttlMs = this.#ttl(command.ttlMs);
    const leaseId = IntegratorLeaseService.leaseIdOf(projectId, branch);
    await this.#runner.command("lease.acquire", { commandId: command.commandId, actor: "controller" }, async () => ({
      payload: { projectId, branch, holder, taskId, ttlMs },
      build: async () => {
        const ref: AggregateRef = { kind: KIND, id: leaseId };
        const current = await this.#runner.get(KIND, leaseId);
        const b = current?.body as unknown as IntegratorLeaseBody | undefined;
        if (b !== undefined && this.#live(b)) throw new DomainError("unavailable", `branch ${branch} is leased to agent ${b.holder} for task ${b.taskId} until ${b.expiresAt}`);
        const now = this.#runner.now();
        const body: IntegratorLeaseBody = { projectId, branch, holder, taskId, fence: (b?.fence ?? 0) + 1, ttlMs, acquiredAt: now, expiresAt: this.#after(now, ttlMs), state: "held" };
        return {
          ref, creates: current === undefined,
          changes: [current === undefined ? { type: "create", ref, body: json(body) } : { type: "update", ref, expectedRevision: current.revision, body: json(body) }, ...(await this.#index(taskId, leaseId))],
          detail: { branch, fence: body.fence },
          contention: async () => new DomainError("unavailable", `branch ${branch} was leased by someone else at the same moment`),
        };
      },
    }));
    return (await this.get(leaseId))!;
  }

  /** Extends the hold of the current holder. `fenced` when `fence` is not the current one, the lease was released, or it expired. */
  async renew(command: { commandId: string; leaseId: string; fence: number; holder: string }): Promise<IntegratorLease> {
    await this.#change("lease.renew", command.commandId, command.leaseId, { fence: command.fence, holder: command.holder }, (b) => {
      if (b.fence !== command.fence || b.state !== "held" || b.holder !== command.holder) throw fenced(`lease ${command.leaseId} is not held with fence ${command.fence} by ${command.holder}`);
      if (!this.#live(b)) throw fenced(`lease ${command.leaseId} expired at ${b.expiresAt}; take it again`);
      return { ...b, expiresAt: this.#after(this.#runner.now(), b.ttlMs) };
    });
    return (await this.get(command.leaseId))!;
  }

  /**
   * Lets the lease go. Only the hold named by `fence` is released: a release for an older fence (the lease expired and was taken by another, or it was released already under another command) is refused `fenced`, so a hold
   * is never released twice and never someone else's. An expired hold of this fence that nobody took since is released too (it was free anyway).
   */
  async release(command: { commandId: string; leaseId: string; fence: number; note?: string }): Promise<IntegratorLease> {
    const note = command.note === undefined ? undefined : text(command.note, "note", { min: 1, max: LEASE_LIMITS.note });
    await this.#change("lease.release", command.commandId, command.leaseId, { fence: command.fence, ...(note === undefined ? {} : { note }) }, (b) => {
      if (b.fence !== command.fence || b.state !== "held") throw fenced(`lease ${command.leaseId} is not held with fence ${command.fence}`);
      return { ...b, state: "released", releasedAt: this.#runner.now(), ...(note === undefined ? {} : { note }) };
    });
    return (await this.get(command.leaseId))!;
  }

  /**
   * Moves a live hold to another agent and task with a new fence (the old holder's fence stops working at once). The caller decides who may ask for this (the hand-off: the owner only). `fenced` when the hold is not the
   * one named or has expired (an expired lease is free, so it is not handed to anyone: the recipient takes it like any other integrator).
   */
  async handOver(command: { commandId: string; leaseId: string; fence: number; to: string; taskId: string; note?: string }): Promise<IntegratorLease> {
    const to = text(command.to, "to", { min: 1, max: 100 });
    const taskId = checkTaskId(command.taskId);
    const note = command.note === undefined ? undefined : text(command.note, "note", { min: 1, max: LEASE_LIMITS.note });
    await this.#change("lease.handover", command.commandId, command.leaseId, { fence: command.fence, to, taskId, ...(note === undefined ? {} : { note }) }, (b) => {
      if (b.fence !== command.fence || b.state !== "held") throw fenced(`lease ${command.leaseId} is not held with fence ${command.fence}`);
      if (!this.#live(b)) throw fenced(`lease ${command.leaseId} expired at ${b.expiresAt}, so it is free and not handed to anyone`);
      const now = this.#runner.now();
      return { ...b, holder: to, taskId, fence: b.fence + 1, acquiredAt: now, expiresAt: this.#after(now, b.ttlMs), ...(note === undefined ? {} : { note }) };
    }, taskId);
    return (await this.get(command.leaseId))!;
  }

  async get(leaseId: string): Promise<IntegratorLease | undefined> {
    if (typeof leaseId !== "string" || !/^ilz-[a-z2-7]{20}$/.test(leaseId)) return undefined;
    const found = await this.#runner.get(KIND, leaseId);
    if (found === undefined) return undefined;
    const b = found.body as unknown as IntegratorLeaseBody;
    return { ...b, leaseId, revision: found.revision, live: this.#live(b) };
  }

  /** Whether `fence` is the live hold of the lease: what a landing checks right before it writes. */
  async valid(leaseId: string, fence: number): Promise<boolean> {
    const l = await this.get(leaseId);
    return l !== undefined && l.live && l.fence === fence;
  }

  /** The live leases held for a task (by whoever holds them now), from the task's index. */
  async forTask(taskId: string): Promise<IntegratorLease[]> {
    const ids = ((await this.#runner.get(TASK_INDEX, checkTaskId(taskId)))?.body as unknown as { leases?: unknown } | undefined)?.leases;
    const out: IntegratorLease[] = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const l = typeof id === "string" ? await this.get(id) : undefined;
      if (l !== undefined && l.live && l.taskId === taskId) out.push(l);
    }
    return out;
  }

  #live(b: IntegratorLeaseBody): boolean { return b.state === "held" && Date.parse(b.expiresAt) > Date.parse(this.#runner.now()); }
  #after(at: string, ms: number): string { return new Date(Date.parse(at) + ms).toISOString(); }
  #ttl(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < LEASE_LIMITS.ttlMinMs || value > LEASE_LIMITS.ttlMaxMs) return invalid("ttlMs", `must be a whole number of milliseconds from ${LEASE_LIMITS.ttlMinMs} to ${LEASE_LIMITS.ttlMaxMs}`);
    return value;
  }

  async #index(taskId: string, leaseId: string): Promise<Change[]> {
    const ref: AggregateRef = { kind: TASK_INDEX, id: taskId };
    const current = await this.#runner.get(TASK_INDEX, taskId);
    const ids = ((current?.body as unknown as { leases?: unknown } | undefined)?.leases);
    const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
    if (list.includes(leaseId)) return [];
    const next = [...list, leaseId].slice(-LEASE_LIMITS.perTask);
    return [current === undefined ? { type: "create", ref, body: json({ leases: next }) } : { type: "update", ref, expectedRevision: current.revision, body: json({ leases: next }) }];
  }

  async #change(type: string, commandId: string, leaseId: string, payload: JsonObject, next: (b: IntegratorLeaseBody) => IntegratorLeaseBody, indexTask?: string): Promise<void> {
    if (typeof leaseId !== "string" || !/^ilz-[a-z2-7]{20}$/.test(leaseId)) invalid("leaseId", "is not a lease ID");
    await this.#runner.command(type, { commandId, actor: "controller" }, async () => ({
      payload: { leaseId, ...payload },
      build: async () => {
        const current = await this.#runner.get(KIND, leaseId);
        if (current === undefined) throw new DomainError("not_found", `no lease ${leaseId}`);
        const body = next(current.body as unknown as IntegratorLeaseBody);
        const ref: AggregateRef = { kind: KIND, id: leaseId };
        return {
          ref, creates: false,
          changes: [{ type: "update", ref, expectedRevision: current.revision, body: json(body) }, ...(indexTask === undefined ? [] : await this.#index(indexTask, leaseId))],
          detail: { fence: body.fence, state: body.state },
          contention: async () => fenced(`lease ${leaseId} changed at the same moment; read it again`),
        };
      },
    }));
  }
}

/**
 * The hand-off's view of the leases (card L03j): the sender's live holds for the task, and releasing or moving exactly one fence. A `fenced` or `not_found` answer is final for that entry (the hold is no longer the
 * sender's to give: it expired and was taken, or was released already) and is reported as skipped; anything else is thrown so the hand-off repeats the step.
 */
export function integratorLeaseHandover(leases: IntegratorLeaseService): LeaseHandover {
  const final = (error: unknown): string | undefined => error instanceof DomainError && (error.code === "fenced" || error.code === "not_found") ? error.message.slice(0, 200) : undefined;
  return {
    async held({ taskId, from }) {
      if (from.kind !== "agent") return [];
      return (await leases.forTask(taskId)).filter((l) => l.holder === from.id).map((l) => ({ leaseId: l.leaseId, branch: l.branch, fence: l.fence, expiresAt: l.expiresAt }));
    },
    async release({ commandId, leaseId, fence, note }) {
      try { await leases.release({ commandId, leaseId, fence, note }); return { outcome: "released" }; } catch (error) { const why = final(error); if (why === undefined) throw error; return { outcome: "skipped", reason: why }; }
    },
    async moveTo({ commandId, leaseId, fence, to, taskId, note }) {
      if (to.kind !== "agent") return { outcome: "skipped", reason: "a lease can only be held by an agent" };
      try { await leases.handOver({ commandId, leaseId, fence, to: to.id, taskId, note }); return { outcome: "moved", fence: fence + 1 }; } catch (error) { const why = final(error); if (why === undefined) throw error; return { outcome: "skipped", reason: why }; }
    },
  };
}

/** The sentence for the task's activity record about the leases a hand-off settled (card L03j). */
export function describeLeases(settled: { readonly entries: readonly { readonly branch: string; readonly outcome: string; readonly reason?: string }[] } | undefined): string {
  if (settled === undefined || settled.entries.length === 0) return "";
  const of = (o: string) => settled.entries.filter((e) => e.outcome === o).map((e) => e.branch);
  const parts = [["released", of("released")], ["moved to the recipient", of("moved")], ["no longer the sender's, left as they are", of("skipped")]].filter(([, l]) => l!.length > 0).map(([label, l]) => `${label as string} ${(l as string[]).join(", ")}`);
  return ` Integrator leases: ${parts.join("; ")}.`.slice(0, 600);
}

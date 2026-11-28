import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { assignmentIdOf } from "../domain/assignment-model.js";
import type { AssignmentService } from "../domain/assignments.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { IntegratorCapacity, WakesNow } from "./integrator-capacity.js";
import type { IntegratorLeaseService } from "./integrator-lease.js";
import { frontOf, type LandingQueueService } from "./landing-queue.js";
import type { LandingReach } from "./landing-reach.js";
import type { Principal } from "../security/principals.js";

/**
 * Waking a free integrator for queued work (card P10b, second part of the first clause: "another is woken through admission and budget, with reserved capacity").
 *
 * On each of the controller's rounds, a landing branch whose first place holds approved work, whose lease no active agent holds live, and for which no integrator is woken already, gets one: the free integrator of
 * the project (the pool's rule, `IntegratorCapacity.integrators`: the exact right `integration.lease`, no live lease of a project it serves and no other wake that has not ended; the first by ID) is given a landing
 * task in that project ("Land the approved work queued on <branch>"), made ready, recorded as a landing task and only then assigned to it. From there the attempt starts the way every attempt starts: the inbox admits it and the dispatcher claims it; the
 * dispatcher knows it as a landing task (`landingOf`), so its budget is checked and held (R05) on the task whose approved work it lands, and it asks admission (H03) for a `landing` place of the control lane, which
 * productive (author) attempts can never take and whose queue they cannot fill.
 *
 * A wake ends when its landing task is done or cancelled; the branch may then be woken for again. The same work first in the queue is woken for at most `INTEGRATOR_WAKE_LIMITS.perFront` times, so an integrator that cannot
 * land it does not get new tasks without end; the owner's `landing_queue` view says so. Queues are visited in the pool's order (the first place that waited longest first).
 *
 * Bounded and fail closed: the queues by `queuesWithEntries` (50 pages of 200), the wake records in `INTEGRATOR_WAKE_LIMITS.pages` pages of 200, at most `INTEGRATOR_WAKE_LIMITS.policyReads` landing policies, `INTEGRATOR_WAKE_LIMITS.judged`
 * judgements of a project's integrators and `INTEGRATOR_WAKE_LIMITS.perRound` wakes per round. Leases or wake records that cannot all be read, or a damaged wake record, wake nobody in that round. Every write is a command with an ID derived from the branch and the wake's number, so a round repeated
 * after a crash makes the same task, the same assignment and the same record, never a second; a wake whose round stopped after its records is assigned by the next round. The dispatcher treats a task as a landing
 * task only while it is assigned to the integrator its wake names (`landingOf`).
 */
export const INTEGRATOR_WAKE_LIMITS = { pages: 10, policyReads: 100, judged: 10, perRound: 5, perFront: 3 } as const;
/** The dispatcher's wake round (`round` with `throttled`) runs at most this often. */
export const WAKE_EVERY_MS = 30_000;
export const WAKE_KIND = "integrator-wake";
export const LANDING_TASK_KIND = "landing-task";
export const WAKE_ACTOR = "service:integrator-wake";

/** The current wake of one landing branch (one record per project and branch). `frontWakes` counts the wakes for `frontTaskId`, the work first in the queue when it was made; `wakes` counts them all. */
export interface IntegratorWakeBody {
  readonly projectId: string;
  readonly branch: string;
  readonly frontTaskId: string;
  readonly taskId: string;
  readonly agentId: string;
  /** Always `open` when written; the wake ends when its landing task ends (read from the task, never from this field). */
  readonly state: "open";
  readonly frontWakes: number;
  readonly wakes: number;
  readonly at: string;
}
/** What a landing task lands: the dispatcher's `landingOf` reads it. */
export interface LandingTaskBody { readonly projectId: string; readonly branch: string; readonly frontTaskId: string; readonly agentId: string; readonly wakeId: string; readonly at: string }

export interface WakeRound {
  readonly woken: readonly { readonly projectId: string; readonly branch: string; readonly agentId: string; readonly taskId: string }[];
  /** Branches passed over: their lease is held by an active agent, an integrator is woken for them already, no integrator is free, or their wakes for the first work are used up. */
  readonly held: number; readonly open: number; readonly noneFree: number; readonly spent: number;
  /** Queues that could not be judged (landing settings unreadable, a record that does not match its task, a wake that could not be made). */
  readonly unreadable: number;
  /**
   * Landing tasks this round ended (cancelled) because their wake's work is no longer queued (it landed, or was taken out or returned) or because another active integrator holds the branch's live lease now. Never one
   * with an attempt admitted or running: that one ends through its attempt as usual, and a later round ends the task once the attempt is over.
   */
  readonly ended?: readonly { readonly projectId: string; readonly branch: string; readonly taskId: string; readonly why: "landed" | "taken" }[];
  /** Not every queue was looked at, or the round stopped at one of its bounds. */
  readonly partial: boolean;
  /** Set when the round woke nobody because the leases or the wake records could not all be read. */
  readonly stopped?: string;
  /** A throttled round that did not run (the last one was less than `WAKE_EVERY_MS` ago). */
  readonly skipped?: true;
}

export interface IntegratorWakeDeps {
  readonly queue: Pick<LandingQueueService, "queuesWithEntries">;
  readonly leases: Pick<IntegratorLeaseService, "liveLeases" | "projectOfTask">;
  readonly capacity: Pick<IntegratorCapacity, "integrators">;
  readonly projects: Pick<ProjectService, "createTask" | "getTask" | "transitionTask">;
  readonly assignments: Pick<AssignmentService, "assignTask" | "getAssignment">;
  /** The landing branch the owner's policy names for the project (the lease door's function). */
  readonly landingBranch: (call: { taskId: string; projectId: string }) => Promise<string | undefined>;
  /** Whether an agent ID names an active agent: a live hold of one that is not active does not keep the branch from a wake (the lease door ends it at the next take). */
  readonly activeAgent: (agentId: string) => Promise<boolean>;
}

const json = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const hash = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
const sinceMs = (at: string | undefined): number => { const t = typeof at === "string" ? Date.parse(at) : NaN; return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY; };
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const TIME = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;

/** A stored wake record checked field by field; undefined when it is not what `IntegratorWake` writes (damage is never read as "no wake"). */
export function wakeBodyOf(body: unknown): IntegratorWakeBody | undefined {
  const b = body as Record<string, unknown> | null;
  if (b === null || typeof b !== "object" || Array.isArray(b)) return undefined;
  const ok = typeof b["projectId"] === "string" && ID.test(b["projectId"]) && typeof b["branch"] === "string" && BRANCH.test(b["branch"])
    && typeof b["frontTaskId"] === "string" && ID.test(b["frontTaskId"]) && typeof b["taskId"] === "string" && ID.test(b["taskId"]) && typeof b["agentId"] === "string" && ID.test(b["agentId"])
    && b["state"] === "open" && count(b["frontWakes"]) && count(b["wakes"]) && (b["frontWakes"] as number) <= (b["wakes"] as number) && TIME(b["at"]);
  return ok ? (b as unknown as IntegratorWakeBody) : undefined;
}

export class IntegratorWake {
  readonly #runner: CommandRunner;
  readonly #deps: IntegratorWakeDeps;
  private constructor(runner: CommandRunner, deps: IntegratorWakeDeps) { this.#runner = runner; this.#deps = deps; }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: IntegratorWakeDeps, options: RunnerOptions = {}): IntegratorWake {
    return new IntegratorWake(new CommandRunner(storage, epoch, options), deps);
  }

  static wakeIdOf(projectId: string, branch: string): string { return `iwk-${hash(projectId, branch)}`; }

  /**
   * What a landing task lands, for the dispatcher (budget on `budgetTaskId`, the work's own task; a `landing` admission place). Undefined for any other task, for a record that does not read as one, and while the
   * task is not assigned to the integrator the wake woke: a landing task given to anyone else (an assignment or a transfer after the wake) is ordinary work of its assignee, so it neither takes a reserved place nor
   * spends the queued work's allowance.
   */
  async landingOf(taskId: string): Promise<{ readonly budgetTaskId: string; readonly projectId: string; readonly branch: string; readonly agentId: string } | undefined> {
    const found = await this.#runner.get(LANDING_TASK_KIND, taskId);
    if (found === undefined) return undefined;
    const b = found.body as Partial<LandingTaskBody> | null;
    // A record that does not read as one the wake writes is damage, never "no landing task": read as none, the task would run as ordinary work paid from no allowance. The dispatcher's claim of that one task fails.
    if (b === null || typeof b !== "object" || typeof b.frontTaskId !== "string" || !ID.test(b.frontTaskId) || typeof b.projectId !== "string" || !ID.test(b.projectId) || typeof b.branch !== "string" || !BRANCH.test(b.branch)
      || typeof b.agentId !== "string" || !ID.test(b.agentId) || b.wakeId !== IntegratorWake.wakeIdOf(b.projectId, b.branch)) throw new DomainError("integrity", `the landing record of task ${taskId} is damaged`);
    const owner = (await this.#deps.assignments.getAssignment(taskId))?.owner;
    if (owner === undefined || owner.kind !== "agent" || owner.id !== b.agentId) return undefined;
    return { budgetTaskId: b.frontTaskId, projectId: b.projectId, branch: b.branch, agentId: b.agentId };
  }

  /**
   * What a landing task's own credential reaches (card P10b, second clause; see `LandingReach`): the lease and landing of its one branch, or nothing. Decided from the records on every call: an agent's task credential
   * whose task is a sound landing task of this agent now (`landingOf`, which reads the current assignment), of the credential's project, open, and the task of the branch's current wake by the same agent. A damaged
   * landing record is thrown (`integrity`); the doors read that as no reach (`reachOf`), so it fails closed.
   */
  async landingReach(by: Principal): Promise<LandingReach | undefined> {
    const scope = by.taskScope;
    if (by.kind !== "agent" || scope === undefined || !by.id.startsWith("agent:")) return undefined;
    const agentId = by.id.slice("agent:".length);
    const l = await this.landingOf(scope.taskId);
    if (l === undefined || l.agentId !== agentId || l.projectId !== scope.projectId) return undefined;
    // The branch's current wake must be this very take: a landing task of an earlier wake (its record replaced by a later one) reaches nothing, even before its task is ended.
    const found = await this.#runner.get(WAKE_KIND, IntegratorWake.wakeIdOf(l.projectId, l.branch));
    const w = found === undefined ? undefined : wakeBodyOf(found.body);
    if (w === undefined || w.taskId !== scope.taskId || w.agentId !== agentId || w.projectId !== l.projectId || w.branch !== l.branch) return undefined;
    if (!(await this.#taskOpen(scope.taskId))) return undefined;
    return { taskId: scope.taskId, projectId: l.projectId, branch: l.branch, agentId };
  }

  /**
   * The task a cost of `taskId` is charged to after the fact (card P10b: stop cleanup, background jobs, reviews, the continuation's budget line): the queued work's own task for a landing task (`landingOf`), the task itself
   * otherwise. A landing record that cannot be read as sound charges the task itself: the cost is recorded on the task where it was spent rather than lost (a claim of that task is refused anyway, so nothing runs on it).
   */
  async chargeTaskOf(taskId: string): Promise<string> {
    try { return (await this.landingOf(taskId))?.budgetTaskId ?? taskId; } catch (error) { if (error instanceof DomainError) return taskId; throw error; }
  }

  /**
   * The wakes now, for `IntegratorCapacity` (`wakes`): those whose landing task has not ended (a task that is done, cancelled or gone ends its wake) and the branches whose first work used up its wakes. `partial` when the
   * records could not all be read or one is damaged.
   */
  async now(): Promise<WakesNow> {
    const open: { projectId: string; branch: string; agentId: string; taskId: string; at: string; frontTaskId: string }[] = [];
    const spent: { projectId: string; branch: string; frontTaskId: string; wakes: number }[] = [];
    let after: string | undefined;
    for (let page = 0; page < INTEGRATOR_WAKE_LIMITS.pages; page++) {
      const batch = await this.#runner.list(WAKE_KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of batch) {
        const w = wakeBodyOf(a.body);
        if (w === undefined || a.id !== IntegratorWake.wakeIdOf(w.projectId, w.branch)) return { open: [], spent: [], partial: true };
        if (w.state === "open" && (await this.#taskOpen(w.taskId))) open.push({ projectId: w.projectId, branch: w.branch, agentId: w.agentId, taskId: w.taskId, at: w.at, frontTaskId: w.frontTaskId });
        else if (w.frontWakes >= INTEGRATOR_WAKE_LIMITS.perFront) spent.push({ projectId: w.projectId, branch: w.branch, frontTaskId: w.frontTaskId, wakes: w.frontWakes });
      }
      if (batch.length < 200) return { open, spent, partial: false };
      after = batch[batch.length - 1]!.id;
    }
    return { open, spent, partial: true };
  }

  async #taskOpen(taskId: string): Promise<boolean> {
    const t = await this.#deps.projects.getTask(taskId);
    return t !== undefined && t.state !== "done" && t.state !== "cancelled";
  }

  /** When the throttled round last ran (this runner's clock, in ms); in memory only, so a restart runs at its first round. */
  #lastAt: number | undefined;

  /** One round (see the class). With `throttled` (the dispatcher's call, every tick) it runs at most once per `WAKE_EVERY_MS` of the controller's clock. */
  async round(options: { readonly throttled?: boolean } = {}): Promise<WakeRound> {
    if (options.throttled === true) {
      const nowMs = Date.parse(this.#runner.now());
      if (Number.isFinite(nowMs) && this.#lastAt !== undefined && nowMs >= this.#lastAt && nowMs - this.#lastAt < WAKE_EVERY_MS) return { woken: [], held: 0, open: 0, noneFree: 0, spent: 0, unreadable: 0, partial: false, skipped: true };
      this.#lastAt = nowMs;
    }
    let held = 0, open = 0, noneFree = 0, spent = 0, unreadable = 0;
    const woken: { projectId: string; branch: string; agentId: string; taskId: string }[] = [];
    const nothing = (stopped: string): WakeRound => ({ woken, held, open, noneFree, spent, unreadable, partial: true, stopped });
    const { leases, partial: leasesPartial } = await this.#deps.leases.liveLeases();
    if (leasesPartial) return nothing("the integrator leases could not all be read");
    const wakes = await this.now();
    if (wakes.partial) return nothing("the wake records could not all be read");
    const openOn = new Set(wakes.open.map((w) => `${w.projectId}\0${w.branch}`));
    const justWoken = new Set<string>();

    const { queues, partial: queuesPartial } = await this.#deps.queue.queuesWithEntries();
    const candidates = queues.flatMap((q) => {
      const first = frontOf(q);
      if (first?.entry === undefined) return [];
      return [{ q, taskId: first.taskId, since: q.front !== undefined && q.front.taskId === first.taskId ? q.front.since : first.entry.queuedAt }];
    }).sort((a, b) => sinceMs(a.since) - sinceMs(b.since) || cmp(a.q.projectId, b.q.projectId) || cmp(a.q.branch, b.q.branch));

    let reads = 0, judgedCount = 0, stopped = false;
    let finishes = 0;
    // A wake whose work is done ends with its task (card P10b): its work is no longer queued on the branch (it landed, or was taken out or returned), or another active integrator took the branch. Judged on this
    // round's picture: a queue missing from a partial read of the queues is not taken as landed. At most `policyReads` such ends tried per round.
    const ended: { projectId: string; branch: string; taskId: string; why: "landed" | "taken" }[] = [];
    let ends = 0;
    for (const w of wakes.open) {
      const lease = leases.find((l) => l.projectId === w.projectId && l.branch === w.branch);
      const taken = lease !== undefined && lease.holder !== w.agentId && (await this.#deps.activeAgent(lease.holder));
      const q = queues.find((x) => x.projectId === w.projectId && x.branch === w.branch);
      const landed = w.frontTaskId !== undefined && (q === undefined ? !queuesPartial : !q.entries.some((e) => e.taskId === w.frontTaskId));
      if (!taken && !landed) continue;
      if (ends >= INTEGRATOR_WAKE_LIMITS.policyReads) { stopped = true; break; }
      ends++;
      const why = taken ? "taken" as const : "landed" as const;
      try {
        if (await this.#end(w.taskId, why)) { ended.push({ projectId: w.projectId, branch: w.branch, taskId: w.taskId, why }); openOn.delete(`${w.projectId}\0${w.branch}`); }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        unreadable++;
      }
    }
    for (const c of candidates) {
      const { projectId, branch } = c.q;
      if (openOn.has(`${projectId}\0${branch}`)) {
        open++;
        // A wake whose round stopped after its record and before the assignment (a crash, a refused assignment): it is finished here, assigned to the integrator its record names, so the open wake never sits
        // with nobody to run it. At most `policyReads` such looks per round; one more read per open wake.
        if (finishes < INTEGRATOR_WAKE_LIMITS.policyReads) {
          finishes++;
          const w = wakes.open.find((x) => x.projectId === projectId && x.branch === branch)!;
          try {
            if (await this.#assign(w.taskId, w.agentId, branch, IntegratorWake.wakeIdOf(projectId, branch))) woken.push({ projectId, branch, agentId: w.agentId, taskId: w.taskId });
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            unreadable++;
          }
        }
        continue;
      }
      const own = leases.find((l) => l.projectId === projectId && l.branch === branch);
      if (own !== undefined && (await this.#deps.activeAgent(own.holder))) { held++; continue; }
      if (reads >= INTEGRATOR_WAKE_LIMITS.policyReads || woken.length >= INTEGRATOR_WAKE_LIMITS.perRound) { stopped = true; break; }
      reads++;
      let landing: string | undefined;
      try { landing = await this.#deps.landingBranch({ taskId: c.taskId, projectId }); } catch { unreadable++; continue; }
      if (landing !== branch) continue;
      if ((await this.#deps.leases.projectOfTask(c.taskId)) !== projectId) { unreadable++; continue; }
      const wakeId = IntegratorWake.wakeIdOf(projectId, branch);
      const before = await this.#runner.get(WAKE_KIND, wakeId);
      const prev = before === undefined ? undefined : wakeBodyOf(before.body);
      if (before !== undefined && (prev === undefined || prev.projectId !== projectId || prev.branch !== branch)) { unreadable++; continue; }
      // A record whose landing task ended (`now` did not list it as open) is replaced by the next wake in one guarded write.
      const frontWakes = prev !== undefined && prev.frontTaskId === c.taskId ? prev.frontWakes : 0;
      if (frontWakes >= INTEGRATOR_WAKE_LIMITS.perFront) { spent++; continue; }
      if (judgedCount >= INTEGRATOR_WAKE_LIMITS.judged) { stopped = true; break; }
      judgedCount++;
      const judged = await this.#deps.capacity.integrators(projectId, justWoken, { leases, wakes });
      if (judged === undefined) return { ...nothing("the integrator leases or wakes could not all be read"), woken };
      const agentId = judged.free[0];
      if (agentId === undefined) { noneFree++; continue; }
      try {
        const made = await this.#wake({ wakeId, before, prev, projectId, branch, frontTaskId: c.taskId, frontWakes: frontWakes + 1, agentId });
        justWoken.add(made.agentId);
        woken.push({ projectId, branch, agentId: made.agentId, taskId: made.taskId });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        unreadable++;
      }
    }
    return { woken, held, open, noneFree, spent, unreadable, ...(ended.length === 0 ? {} : { ended }), partial: queuesPartial || stopped };
  }

  /**
   * Ends a wake's landing task (cancelled) when nothing runs on it: true when this call ended it. A task with an attempt admitted or running is left alone (the attempt ends as usual; a later round ends the task). The
   * transition carries a check of the assignment's revision, so an attempt admitted between the look and the write makes the write fail rather than end a task under a running attempt. A task with no assignment yet
   * (the round assigns it first) is not ended here. The command ID derives from the task and the reason, so a repeat after a crash is the same command.
   */
  async #end(taskId: string, why: "landed" | "taken"): Promise<boolean> {
    const ref: AggregateRef = { kind: "assignment", id: assignmentIdOf(taskId) };
    const asg = await this.#runner.get("assignment", ref.id);
    if (asg === undefined || (asg.body as { activeAttemptId?: unknown }).activeAttemptId !== undefined) return false;
    const task = await this.#deps.projects.getTask(taskId);
    if (task === undefined || task.state === "done" || task.state === "cancelled") return false;
    await this.#deps.projects.transitionTask({ commandId: `iwk-end:${taskId}:${why}`, actor: WAKE_ACTOR, taskId, expectedRevision: task.revision, to: "cancelled" }, {
      payload: { landingEnd: why },
      check: async () => {
        const now = await this.#runner.get("assignment", ref.id);
        if (now === undefined || now.revision !== asg.revision || (now.body as { activeAttemptId?: unknown }).activeAttemptId !== undefined) throw new DomainError("invalid_transition", `landing task ${taskId} has an attempt now; it ends through that attempt`);
        return { changes: [{ type: "check", ref, expectedRevision: now.revision }], detail: { landingEnd: why } };
      },
    });
    return true;
  }

  /**
   * Makes one wake: the landing task, made ready, then the records, then the assignment. Each step has a derived command ID, so a repeat after a crash does each step once.
   *
   * The order matters. Only an assigned task gets an attempt, and the dispatcher knows a landing task only by its `landing-task` record; so the records are written before the assignment, and a round that stops in
   * between never leaves an attempt that would be admitted and paid as ordinary work. A round that stopped before the records makes them again under the same command IDs: the task's own command carries only the
   * branch (constant for the wake's ID), so it repeats as the same command even when other work is first in the queue by then. A round that stopped after the records is finished by the next one (`#assign`).
   */
  async #wake(w: { wakeId: string; before: { revision: number } | undefined; prev: IntegratorWakeBody | undefined; projectId: string; branch: string; frontTaskId: string; frontWakes: number; agentId: string }): Promise<{ taskId: string; agentId: string }> {
    const wakes = (w.prev?.wakes ?? 0) + 1;
    const base = `iwk:${w.wakeId.slice(4)}:${wakes}`;
    const taskId = (await this.#deps.projects.createTask({
      commandId: `${base}:task`, actor: WAKE_ACTOR, projectId: w.projectId, title: `Land the approved work queued on ${w.branch}`.slice(0, 150),
      description: `The controller woke an integrator to land the approved work in the landing queue of branch ${w.branch}. Take the branch's integrator lease, land the queue's first place, and finish this task when the queue is landed or nothing more can land now.`.slice(0, 2000),
    })).id;
    const task = await this.#deps.projects.getTask(taskId);
    if (task === undefined) throw new DomainError("not_found", `landing task ${taskId} is missing`);
    if (task.state === "proposed") await this.#deps.projects.transitionTask({ commandId: `${base}:ready`, actor: WAKE_ACTOR, taskId, expectedRevision: task.revision, to: "ready" });
    // Given to someone already (a holder of assignment.manage, in the moment before the records were written): the records still name the integrator this round chose, so the task stays its assignee's ordinary
    // work (`landingOf` answers only for the named integrator) and is not assigned here; the wake ends when the task ends. Never the assignee's word: that would make any agent a landing task's integrator.
    const assigned = await this.#deps.assignments.getAssignment(taskId);
    const agentId = w.agentId;
    const at = this.#runner.now();
    const body: IntegratorWakeBody = { projectId: w.projectId, branch: w.branch, frontTaskId: w.frontTaskId, taskId, agentId, state: "open", frontWakes: w.frontWakes, wakes, at };
    const link: LandingTaskBody = { projectId: w.projectId, branch: w.branch, frontTaskId: w.frontTaskId, agentId, wakeId: w.wakeId, at };
    const ref: AggregateRef = { kind: WAKE_KIND, id: w.wakeId };
    const linkRef: AggregateRef = { kind: LANDING_TASK_KIND, id: taskId };
    await this.#runner.command("landing.wake", { commandId: `${base}:record`, actor: WAKE_ACTOR }, async () => ({
      payload: { projectId: w.projectId, branch: w.branch, frontTaskId: w.frontTaskId, taskId, agentId, wakes },
      build: async () => {
        const now = await this.#runner.get(WAKE_KIND, w.wakeId);
        if ((now?.revision ?? 0) !== (w.before?.revision ?? 0)) throw new DomainError("stale_revision", `the wake of branch ${w.branch} changed meanwhile`);
        const changes: Change[] = [
          now === undefined ? { type: "create", ref, body: json(body) } : { type: "update", ref, expectedRevision: now.revision, body: json(body) },
          { type: "create", ref: linkRef, body: json(link) },
        ];
        return { ref, creates: now === undefined, changes, detail: { taskId, agentId, wakes } };
      },
    }));
    if (assigned === undefined) await this.#assign(taskId, agentId, w.branch, w.wakeId);
    return { taskId, agentId };
  }

  /**
   * Assigns a wake's landing task to the integrator its record names, unless the task has an assignment already (then nothing is done). True when this call assigned it. The command ID derives from the task and the agent,
   * so the wake's own round and a later round finishing it make one assignment.
   */
  async #assign(taskId: string, agentId: string, branch: string, wakeId: string): Promise<boolean> {
    const link = await this.#runner.get(LANDING_TASK_KIND, taskId);
    const l = link?.body as Partial<LandingTaskBody> | undefined;
    // Only the landing task of this very wake is assigned here (a record that does not name it is left alone; the owner's view shows the wake).
    if (l === undefined || l.wakeId !== wakeId || l.agentId !== agentId) throw new DomainError("integrity", `landing task ${taskId} is not the task of wake ${wakeId}`);
    // Assigned already, or assigned and then released (the owner's choice, which a later round does not undo): nothing to do.
    if ((await this.#deps.assignments.getAssignment(taskId)) !== undefined) return false;
    await this.#deps.assignments.assignTask({ commandId: `iwk-own:${taskId}:${hash(agentId).slice(0, 12)}`, actor: WAKE_ACTOR, taskId, owner: { kind: "agent", id: agentId }, reason: `woken to land the approved work queued on ${branch}`.slice(0, 300) });
    return true;
  }
}

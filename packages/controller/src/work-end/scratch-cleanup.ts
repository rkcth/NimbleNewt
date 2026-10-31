import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { redactText } from "../security/redact.js";
import type { Aggregate, AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { ScratchMode } from "./cleanup-settings.js";

const KIND = "scratch-cleanup";
const OPEN_KIND = "scratch-open";
const OPEN_ID = "main";
/**
 * Most leftovers kept in a record and in the report, and the longest description of one. `tries` is how often a leftovers report may fail before the controller gives up on it (the record says so; the owner is told by the failure it raised each time).
 * `perRecover` is how many unfinished records one `recover` looks at, `staleMs` how old a decision must be before `recover` takes it over from a run that may still be going.
 */
export const SCRATCH_LIMITS = { leftovers: 20, what: 200, why: 300, tries: 8, perRecover: 20, staleMs: 60_000 } as const;

/** The attempt whose scratch workspace is in question. */
export interface ScratchAttempt { readonly attemptId: string; readonly taskId: string; readonly projectId: string; readonly agentId: string }

/**
 * The cleanup order the controller gives the host (the HOST PORT). The host executes it on the attempt's controller-created scratch workspace ONLY: the directories the controller itself made for the attempt.
 * It must NOT remove, stop or uninstall anything an agent installed or left running; it lists those in `leftovers` instead and leaves them as they are. `key` is stable per attempt: executing the same order again is harmless
 * (a restart may repeat it). The host may refuse or fail; then the scratch is kept.
 */
export interface ScratchOrder extends ScratchAttempt { readonly key: string }
export interface Leftover { readonly kind: "installed" | "running" | "other"; readonly what: string }
export interface ScratchReport {
  /** True when the scratch workspace is gone. */
  readonly removed: boolean;
  /** What the host found that an agent installed or left running (kept, never removed). */
  readonly leftovers: readonly Leftover[];
  readonly detail?: string;
  /**
   * True when this is a REPEAT of an order the host already carried out (same `key`) and there is nothing left to remove: the scratch is gone because that earlier order removed it. The controller then records it as removed. On a repeat the host should
   * give the leftovers of its FIRST answer again; the controller keeps whatever leftovers the first answer gave it, if it saw one.
   */
  readonly alreadyRemoved?: boolean;
}
export interface ScratchPorts {
  /** The cleanup setting now. */
  mode(): Promise<ScratchMode>;
  /** Hands the order to the host. Absent: no host can execute it, so the scratch is kept. */
  order?(order: ScratchOrder): Promise<ScratchReport>;
  /** Sends the leftovers to the boss (supervisor) as a needs-you message. `key` is stable: a repeat must be harmless. A throw is retried by the next run. */
  report(attempt: ScratchAttempt, leftovers: readonly Leftover[], key: string): Promise<void>;
}

export interface ScratchRecord extends ScratchAttempt {
  /** `ordering`: the order was decided and may have gone out; `removed`/`kept`: final. */
  readonly state: "ordering" | "removed" | "kept";
  readonly why?: string;
  readonly leftovers: readonly Leftover[];
  readonly reported: boolean;
  /** How often the leftovers report failed, and, when the controller stopped trying, why. */
  readonly tries?: number;
  readonly gaveUp?: string;
  readonly decidedAt: string;
  readonly finishedAt?: string;
}
export interface ScratchRun extends ScratchRecord { readonly replayed: boolean }

export const scratchRecordId = (attemptId: string): string => idOf(attemptId);
const idOf = (attemptId: string): string => `scl-${createHash("sha256").update(attemptId).digest("hex").slice(0, 32)}`;
const json = (v: object): JsonObject => v as unknown as JsonObject;
const text = (s: unknown, n: number): string => redactText(String(s ?? "")).replace(/\s+/g, " ").trim().slice(0, n);
/**
 * What the host says is untrusted text that ends up in a message to an agent: only letters, digits, spaces and path punctuation survive, everything else (quotes, brackets, angle brackets, backticks, control characters, line breaks) becomes `?`.
 */
export const SAFE_OUT = /[^\p{L}\p{N} ._\-/\\:@+=,~#%]/gu;
const safe = (s: unknown, n: number): string => text(s, n).replace(SAFE_OUT, "?");
const KINDS = ["installed", "running", "other"] as const;
/** What the host said, bounded and cleaned: a host cannot make a record or a message of unbounded size. */
function leftoversOf(v: unknown): Leftover[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, SCRATCH_LIMITS.leftovers).map((x) => {
    const o = (x ?? {}) as { kind?: unknown; what?: unknown };
    return { kind: (KINDS as readonly unknown[]).includes(o.kind) ? (o.kind as Leftover["kind"]) : "other", what: safe(o.what, SCRATCH_LIMITS.what) };
  });
}

/**
 * Removes the controller-created scratch workspace of an attempt that ended, when everything important was handed onward (owner decision 2026-10-30). Nothing is removed otherwise.
 * - `run(attempt, missing)`: `missing` lists what is not yet handed onward (empty: all of it is). With the setting `keep`, or anything missing, the scratch is KEPT and the reason recorded. Otherwise the order goes to the host.
 * - Anything an agent installed or left running is never removed: the host reports it, and it goes to the supervisor as a needs-you message; the supervisor decides (clean, keep, adopt).
 * - One record per attempt, written before the order goes out and after the host answered: a repeat returns the recorded outcome, a restart between the order and the answer repeats the (idempotent) order, and a leftovers report that failed is retried. Every decision and removal is a recorded command (the log).
 */
export class ScratchCleanupService {
  readonly #runner: CommandRunner;
  readonly #ports: ScratchPorts;
  private constructor(runner: CommandRunner, ports: ScratchPorts) { this.#runner = runner; this.#ports = ports; }
  static withEpoch(storage: ControllerStorage, epoch: number, ports: ScratchPorts, options: RunnerOptions = {}): ScratchCleanupService {
    return new ScratchCleanupService(new CommandRunner(storage, epoch, options), ports);
  }

  async get(attemptId: string): Promise<ScratchRecord | undefined> {
    return (await this.#read(idOf(attemptId)))?.body;
  }

  /**
   * `before` is asked just before the order goes out and may give a reason to keep instead (a concurrent drop of the ending, say); then nothing is ordered and the record says why.
   */
  async run(attempt: ScratchAttempt, missing: readonly string[], before?: () => Promise<string | undefined>): Promise<ScratchRun> {
    const a: ScratchAttempt = { attemptId: attempt.attemptId, taskId: attempt.taskId, projectId: attempt.projectId, agentId: attempt.agentId };
    const id = idOf(a.attemptId);
    let rec = await this.#read(id);
    const replayed = rec !== undefined;
    if (rec === undefined) {
      const mode = await this.#ports.mode().catch((): ScratchMode => "keep");
      const now = this.#runner.now();
      const why = mode === "keep" ? "the cleanup setting is keep" : missing.length > 0 ? `not everything was handed onward yet: ${text(missing.join("; "), SCRATCH_LIMITS.why)}` : this.#ports.order === undefined ? "no host can remove scratch here" : undefined;
      const body: ScratchRecord = { ...a, state: why === undefined ? "ordering" : "kept", ...(why === undefined ? {} : { why, finishedAt: now }), leftovers: [], reported: true, decidedAt: now };
      // Listed first: a crash between the two leaves a listed attempt without a record (dropped by `recover`), never an unfinished record nothing knows of.
      if (why === undefined) await this.#listed(a.attemptId, true);
      rec = await this.#create(id, body);
    }
    if (rec.body.state === "ordering") {
      const hold = before === undefined ? undefined : await before();
      if (hold !== undefined) {
        rec = await this.#update(id, "scratch.cleanup.finish", (b) => b.state !== "ordering" ? b : { ...b, state: "kept" as const, why: text(hold, SCRATCH_LIMITS.why), finishedAt: this.#runner.now() });
      } else {
        let report: ScratchReport | undefined, failure: string | undefined;
        try { report = await this.#ports.order!({ ...a, key: `scratch:${a.attemptId}` }); } catch (error) { failure = `the host could not remove it (${text((error as Error)?.message ?? error, 150)})`; }
        const leftovers = leftoversOf(report?.leftovers);
        // A repeat of an order the host already did: nothing is there because that order removed it.
        const removed = failure === undefined && (report?.removed === true || report?.alreadyRemoved === true);
        rec = await this.#update(id, "scratch.cleanup.finish", (b) => b.state !== "ordering" ? b : ({
          ...b, state: removed ? "removed" as const : "kept" as const, leftovers, reported: leftovers.length === 0, finishedAt: this.#runner.now(),
          ...(removed ? {} : { why: failure ?? (text(report?.detail, SCRATCH_LIMITS.why) || "the host did not remove it") }),
        }));
      }
    }
    if (!rec.body.reported && rec.body.leftovers.length > 0) {
      if ((rec.body.tries ?? 0) >= SCRATCH_LIMITS.tries) {
        rec = await this.#update(id, "scratch.cleanup.gaveup", (b) => b.reported ? b : { ...b, reported: true, gaveUp: `the leftovers could not be reported after ${SCRATCH_LIMITS.tries} tries` });
      } else {
        try { await this.#ports.report(a, rec.body.leftovers, `scratch-leftovers:${a.attemptId}`); } catch (error) {
          await this.#update(id, "scratch.cleanup.retry", (b) => b.reported ? b : { ...b, tries: (b.tries ?? 0) + 1 }).catch(() => undefined);
          throw error;
        }
        rec = await this.#update(id, "scratch.cleanup.reported", (b) => b.reported ? b : { ...b, reported: true });
      }
    }
    if (rec.body.state !== "ordering" && rec.body.reported) await this.#listed(a.attemptId, false).catch(() => undefined);
    return { ...rec.body, replayed };
  }

  /**
   * The sweep: finishes the decisions still open (an order that may have gone out before a restart, a leftovers report that failed), at most `perRecover` per call, only those decided more than `staleMs` ago (a run that is still going is left to finish).
   * One that fails does not stop the others; the failures are reported together at the end. A report that failed `tries` times is given up and recorded as such.
   */
  async recover(): Promise<number> {
    const open = ((await this.#runner.get(OPEN_KIND, OPEN_ID))?.body as unknown as { attempts?: string[] } | undefined)?.attempts ?? [];
    let done = 0;
    const failed: string[] = [];
    const gone: string[] = [];
    const now = Date.parse(this.#runner.now());
    for (const attemptId of open) {
      if (done + failed.length >= SCRATCH_LIMITS.perRecover) break;
      const rec = await this.#read(idOf(attemptId));
      if (rec === undefined || (rec.body.state !== "ordering" && rec.body.reported)) { gone.push(attemptId); continue; }
      if (rec.body.state === "ordering" && now - Date.parse(rec.body.decidedAt) < SCRATCH_LIMITS.staleMs) continue;
      try { await this.run(rec.body, []); done++; } catch (error) { failed.push(`${attemptId}: ${text((error as Error)?.message ?? error, 150)}`); }
    }
    for (const g of gone) await this.#listed(g, false).catch(() => undefined);
    if (failed.length > 0) throw new DomainError("unavailable", `${failed.length} scratch cleanup(s) could not be finished (${done} were): ${failed.slice(0, 5).join("; ")}`);
    return done;
  }

  /** Adds an attempt to the list of unfinished cleanups, or takes it off. */
  async #listed(attemptId: string, add: boolean): Promise<void> {
    const ref: AggregateRef = { kind: OPEN_KIND, id: OPEN_ID };
    for (let n = 0; n < 8; n++) {
      const found = await this.#runner.get(OPEN_KIND, OPEN_ID);
      const cur = ((found?.body as unknown as { attempts?: string[] } | undefined)?.attempts ?? []);
      if (add === cur.includes(attemptId)) return;
      const attempts = add ? [...cur, attemptId] : cur.filter((x) => x !== attemptId);
      const body = json({ attempts });
      try {
        await this.#runner.command("scratch.cleanup.list", { commandId: `${OPEN_ID}:${add ? "add" : "remove"}:${attemptId}:r${found?.revision ?? 0}`, actor: "controller" }, async () => ({
          payload: { attemptId, add },
          build: async () => ({ ref, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref, body } : { type: "update" as const, ref, expectedRevision: found.revision, body }], detail: { attemptId, add }, contention: async () => new DomainError("stale_revision", "the list of cleanups changed at the same moment") }),
        }));
        return;
      } catch (error) { if (!(error instanceof DomainError && (error.code === "stale_revision" || error.code === "integrity" || error.code === "command_conflict"))) throw error; }
    }
    throw new DomainError("stale_revision", "the list of scratch cleanups kept changing");
  }

  async #read(id: string): Promise<{ body: ScratchRecord; revision: number } | undefined> {
    const f: Aggregate | undefined = await this.#runner.get(KIND, id);
    return f === undefined ? undefined : { body: f.body as unknown as ScratchRecord, revision: f.revision };
  }

  async #create(id: string, body: ScratchRecord): Promise<{ body: ScratchRecord; revision: number }> {
    const ref: AggregateRef = { kind: KIND, id };
    try {
      await this.#runner.command("scratch.cleanup.decide", { commandId: `${id}:decide`, actor: "controller" }, async () => ({
        payload: { attemptId: body.attemptId },
        build: async () => ({ ref, creates: true, changes: [{ type: "create" as const, ref, body: json(body) }], detail: { taskId: body.taskId, state: body.state } }),
      }));
    } catch (error) { if (!(error instanceof DomainError)) throw error; }
    const now = await this.#read(id);
    if (now === undefined) throw new DomainError("unavailable", "the scratch cleanup could not be recorded; it is retried");
    return now;
  }

  async #update(id: string, type: string, fn: (b: ScratchRecord) => ScratchRecord): Promise<{ body: ScratchRecord; revision: number }> {
    for (let n = 0; n < 8; n++) {
      const rec = await this.#read(id);
      if (rec === undefined) throw new DomainError("not_found", "no scratch cleanup record");
      const next = fn(rec.body);
      if (next === rec.body) return rec;
      const ref: AggregateRef = { kind: KIND, id };
      try {
        await this.#runner.command(type, { commandId: `${id}:${type}:r${rec.revision}`, actor: "controller" }, async () => ({
          payload: { revision: rec.revision },
          build: async () => ({ ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: rec.revision, body: json(next) }], detail: { taskId: next.taskId, state: next.state }, contention: async () => new DomainError("stale_revision", "the cleanup record changed at the same moment") }),
        }));
      } catch (error) { if (!(error instanceof DomainError && error.code === "stale_revision")) throw error; continue; }
      const after = await this.#read(id);
      if (after !== undefined) return after;
    }
    throw new DomainError("stale_revision", "the scratch cleanup record kept changing");
  }
}

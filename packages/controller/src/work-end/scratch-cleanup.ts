import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { redactText } from "../security/redact.js";
import type { Aggregate, AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { ScratchMode } from "./cleanup-settings.js";

const KIND = "scratch-cleanup";
/** Most leftovers kept in a record and in the report, and the longest description of one. */
export const SCRATCH_LIMITS = { leftovers: 20, what: 200, why: 300 } as const;

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
  readonly decidedAt: string;
  readonly finishedAt?: string;
}
export interface ScratchRun extends ScratchRecord { readonly replayed: boolean }

export const scratchRecordId = (attemptId: string): string => idOf(attemptId);
const idOf = (attemptId: string): string => `scl-${createHash("sha256").update(attemptId).digest("hex").slice(0, 32)}`;
const json = (v: object): JsonObject => v as unknown as JsonObject;
const text = (s: unknown, n: number): string => redactText(String(s ?? "")).replace(/\s+/g, " ").trim().slice(0, n);
const KINDS = ["installed", "running", "other"] as const;
/** What the host said, bounded and cleaned: a host cannot make a record or a message of unbounded size. */
function leftoversOf(v: unknown): Leftover[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, SCRATCH_LIMITS.leftovers).map((x) => {
    const o = (x ?? {}) as { kind?: unknown; what?: unknown };
    return { kind: (KINDS as readonly unknown[]).includes(o.kind) ? (o.kind as Leftover["kind"]) : "other", what: text(o.what, SCRATCH_LIMITS.what) };
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

  async run(attempt: ScratchAttempt, missing: readonly string[]): Promise<ScratchRun> {
    const a: ScratchAttempt = { attemptId: attempt.attemptId, taskId: attempt.taskId, projectId: attempt.projectId, agentId: attempt.agentId };
    const id = idOf(a.attemptId);
    let rec = await this.#read(id);
    const replayed = rec !== undefined;
    if (rec === undefined) {
      const mode = await this.#ports.mode().catch((): ScratchMode => "keep");
      const now = this.#runner.now();
      const why = mode === "keep" ? "the cleanup setting is keep" : missing.length > 0 ? `not everything was handed onward yet: ${text(missing.join("; "), SCRATCH_LIMITS.why)}` : this.#ports.order === undefined ? "no host can remove scratch here" : undefined;
      const body: ScratchRecord = { ...a, state: why === undefined ? "ordering" : "kept", ...(why === undefined ? {} : { why, finishedAt: now }), leftovers: [], reported: true, decidedAt: now };
      rec = await this.#create(id, body);
    }
    if (rec.body.state === "ordering") {
      let report: ScratchReport | undefined, failure: string | undefined;
      try { report = await this.#ports.order!({ ...a, key: `scratch:${a.attemptId}` }); } catch (error) { failure = `the host could not remove it (${text((error as Error)?.message ?? error, 150)})`; }
      const leftovers = leftoversOf(report?.leftovers);
      const removed = report?.removed === true && failure === undefined;
      rec = await this.#update(id, "scratch.cleanup.finish", (b) => b.state !== "ordering" ? b : ({
        ...b, state: removed ? "removed" as const : "kept" as const, leftovers, reported: leftovers.length === 0, finishedAt: this.#runner.now(),
        ...(removed ? {} : { why: failure ?? (text(report?.detail, SCRATCH_LIMITS.why) || "the host did not remove it") }),
      }));
    }
    if (!rec.body.reported && rec.body.leftovers.length > 0) {
      await this.#ports.report(a, rec.body.leftovers, `scratch-leftovers:${a.attemptId}`);
      rec = await this.#update(id, "scratch.cleanup.reported", (b) => b.reported ? b : { ...b, reported: true });
    }
    return { ...rec.body, replayed };
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

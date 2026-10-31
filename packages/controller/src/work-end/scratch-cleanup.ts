import { createHash, randomUUID } from "node:crypto";
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
export const SCRATCH_LIMITS = { leftovers: 20, what: 200, why: 300, tries: 8, perRecover: 20, staleMs: 60_000, orderMs: 120_000, leaseMs: 300_000, retries: 20, recheckMs: 300_000,
  /** One sweep stops starting new work after `passMs` of real time (the serial dispatcher tick must not be held by a silent host); a call to the host that is not an order (a release) is cut off after `callMs`. */
  passMs: 30_000, callMs: 20_000,
  /** The wait before an order that got no answer is sent again: `retryBaseMs` doubling each time up to `retryCapMs`, so an outage of a day does not use up `retries` (about four days of outage in all). */
  retryBaseMs: 300_000, retryCapMs: 6 * 3_600_000,
  /** A decision or a wait for the stop that could not be finished in this long is closed as kept and reported once as unresolved (14 days). */
  unresolvedMs: 14 * 24 * 3_600_000 } as const;
export type ScratchLimits = { -readonly [K in keyof typeof SCRATCH_LIMITS]: number };
/** How long scratch may wait for a worker to confirm it stopped before the supervisor or owner is told (hours; the owner's setting overrides, `null` there means never tell). */
export const DEFAULT_AWAIT_STOP_HOURS = 24;

/** The attempt whose scratch workspace is in question. */
export interface ScratchAttempt {
  readonly attemptId: string; readonly taskId: string; readonly projectId: string; readonly agentId: string;
  /** Where the attempt ran and its generation, when known: carried in the order so the host can tell which attempt's scratch an order is about. */
  readonly hostId?: string; readonly generation?: number;
}

/**
 * The cleanup order the controller gives the host (the HOST PORT). The host executes it on the attempt's controller-created scratch workspace ONLY: the directories the controller itself made for the attempt.
 * It must NOT remove, stop or uninstall anything an agent installed or left running; it lists those in `leftovers` instead and leaves them as they are. `key` is stable per attempt: executing the same order again is harmless
 * (a restart may repeat it). The host may refuse or fail; then the scratch is kept.
 *
 * ATTEMPT-UNIQUE SCRATCH (contract): the order names the attempt (`attemptId`, which is unique to one attempt and never reused), the host it ran on (`hostId`) and its `generation`. The host MUST derive the scratch location and the idempotency
 * key from the attempt (`attemptId`) only, never from the task or the agent alone, so a replayed or late order for an older attempt can only ever touch that attempt's own scratch and never a successor's, which the same task may have now.
 * `key` (`scratch:<attemptId>`) is that identity. The host answers a repeat with `alreadyRemoved`, and `busy` when it is still working on an earlier order of the same key (the controller then asks again later; it does not take that for a refusal).
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
  /** True when the host is still carrying out an earlier order of this key: nothing is decided, the controller asks again later (a `removed: false` with `busy` never finalises the cleanup as kept). */
  readonly busy?: boolean;
}
export interface ScratchPorts {
  /** The cleanup setting now. */
  mode(): Promise<ScratchMode>;
  /** Hands the order to the host. Absent: no host can execute it, so the scratch is kept. */
  order?(order: ScratchOrder, signal?: AbortSignal): Promise<ScratchReport>;
  /** Sends the leftovers to the boss (supervisor) as a needs-you message. `key` is stable: a repeat must be harmless. A throw is retried by the next run. */
  report(attempt: ScratchAttempt, leftovers: readonly Leftover[], key: string): Promise<void>;
  /** Asked again just before an order that the sweep sends (the same check as `before` of `run`): a reason to keep instead (the ending was dropped meanwhile). */
  before?(attempt: ScratchAttempt): Promise<string | undefined>;
  /** Whether the worker of the finished attempt is confirmed stopped now (the host is asked to let go again, or the attempt is seen to be over). The sweep asks it for cleanups that wait for the stop. Absent: never confirmed. */
  workerStopped?(attempt: ScratchAttempt, signal?: AbortSignal): Promise<boolean>;
  /** Hours scratch may wait for a worker to confirm it stopped before somebody is told; `null` means never tell. Absent: `DEFAULT_AWAIT_STOP_HOURS`. */
  patienceHours?(): Promise<number | null>;
  /** Tells the supervisor/owner (once; `key` is stable) that scratch is kept because the worker never confirmed it stopped. A throw is retried by the next sweep. */
  stuck?(attempt: ScratchAttempt, hours: number, key: string): Promise<void>;
  /** Tells the supervisor/owner (once; `key` is stable) that a cleanup could not be finished in `unresolvedMs` and was closed as kept (the attempt may be unknown: a record that never got past `begin`). A throw is retried by the next sweep. */
  unresolved?(attempt: ScratchAttempt, reason: string, key: string): Promise<void>;
  /** Works out the decision again for a record that only got as far as `begin` (the attempt could not be read or the checkpoint check failed at the time): the attempt and what is missing. Absent: such a record stays open. */
  decide?(attemptId: string): Promise<{ readonly attempt: ScratchAttempt; readonly missing: readonly string[]; readonly workerStopped: boolean } | undefined>;
}

export interface ScratchRecord extends ScratchAttempt {
  /** `deciding`: the record exists so the sweep can finish it, the decision is not made yet. `awaiting-stop`: everything else is in order, the worker has not confirmed stopping (re-checked by the sweep). `ordering`: the order was decided and may have gone out. `removed`/`kept`: final. */
  readonly state: "deciding" | "awaiting-stop" | "ordering" | "removed" | "kept";
  /** A sweep that is ordering holds the record until `until` (longer than the host's order time limit); another does not send the same order meanwhile. */
  readonly lease?: { readonly token: string; readonly until: string };
  /** How often the host was busy or did not answer in time. */
  readonly retries?: number;
  /** While awaiting the stop: when the worker was last asked, and whether the owner/supervisor was told it never confirmed. */
  readonly checkedAt?: string;
  readonly stuckNotified?: boolean;
  /** The sweep does not look at this record before this time (backoff after an unanswered order, a check that found nothing). */
  readonly retryAt?: string;
  /** Closed as kept because it could not be finished in `unresolvedMs`; the supervisor/owner was told (once). */
  readonly unresolvedNotified?: boolean;
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
 * What the host says is untrusted text that ends up in a message to an agent: letters, marks and digits of any script, spaces and common path punctuation survive; everything else (double quotes, angle brackets, backticks, control characters,
 * line breaks) becomes `?` or a space. Consecutive spaces are kept (a path may contain them). The message's own framing (a delimiter and numbered lines) is what stops a forged line, not this filter.
 */
export const SAFE_OUT = /[^\p{L}\p{M}\p{N} ._\-/\\:@+=,~#%()[\]'&$!;]/gu;
const safe = (s: unknown, n: number): string => redactText(String(s ?? "")).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, n).replace(SAFE_OUT, "?");
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
  readonly #limits: ScratchLimits;
  /** Aborted by `close()`: every call to the host in flight is told, and the order lease is given up. */
  readonly #down = new AbortController();
  readonly #inflight = new Set<Promise<unknown>>();
  /** Where the sweep starts in the list of open cleanups (in memory), so records that cost time are not always the ones looked at first. */
  #cursor = 0;
  private constructor(runner: CommandRunner, ports: ScratchPorts, limits: ScratchLimits) { this.#runner = runner; this.#ports = ports; this.#limits = limits; }
  static withEpoch(storage: ControllerStorage, epoch: number, ports: ScratchPorts, options: RunnerOptions & { readonly limits?: Partial<ScratchLimits> } = {}): ScratchCleanupService {
    const { limits, ...runner } = options;
    return new ScratchCleanupService(new CommandRunner(storage, epoch, runner), ports, { ...SCRATCH_LIMITS, ...limits });
  }

  /** Shutdown: tells every call in flight to stop (an order's lease is given up, nothing is decided) and waits for the runs and sweeps that are going. */
  async close(): Promise<void> {
    this.#down.abort();
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  #track<T>(p: Promise<T>): Promise<T> {
    this.#inflight.add(p);
    const done = (): void => { this.#inflight.delete(p); };
    p.then(done, done);
    return p;
  }

  /** A call to the host with its own time limit and cancellation (the caller's signal, shutdown, the limit): `timeout` and `aborted` are answers, not errors. */
  async #bounded<T>(ms: number, signal: AbortSignal | undefined, call: (signal: AbortSignal) => Promise<T>): Promise<{ readonly value: T } | "timeout" | "aborted"> {
    const ctl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const stop = (): void => ctl.abort();
    const sources = [this.#down.signal, ...(signal === undefined ? [] : [signal])];
    if (sources.some((x) => x.aborted)) return "aborted";
    for (const x of sources) x.addEventListener("abort", stop, { once: true });
    try {
      const gate = new Promise<"timeout" | "aborted">((resolve) => { timer = setTimeout(() => { ctl.abort(); resolve("timeout"); }, ms); ctl.signal.addEventListener("abort", () => resolve(sources.some((x) => x.aborted) ? "aborted" : "timeout"), { once: true }); });
      const r = await Promise.race([call(ctl.signal).then((value) => ({ value })), gate]);
      return r;
    } finally { if (timer !== undefined) clearTimeout(timer); for (const x of sources) x.removeEventListener("abort", stop); }
  }

  async get(attemptId: string): Promise<ScratchRecord | undefined> {
    return (await this.#read(idOf(attemptId)))?.body;
  }

  /**
   * Makes the cleanup exist (listed and recorded as `deciding`) BEFORE anything that can fail is done to decide it (reading the attempt, the checkpoint), so the sweep can always retry it. Idempotent.
   */
  async begin(attemptId: string): Promise<void> {
    const id = idOf(attemptId);
    if ((await this.#read(id)) !== undefined) return;
    await this.#listed(attemptId, true);
    const now = this.#runner.now();
    await this.#create(id, { attemptId, taskId: "", projectId: "", agentId: "", state: "deciding", leftovers: [], reported: true, decidedAt: now });
  }

  /**
   * `before` is asked just before the order goes out and may give a reason to keep instead (a concurrent drop of the ending, say); then nothing is ordered and the record says why. A throw from it leaves the cleanup open for the sweep.
   * `workerStopped: false` with nothing else missing makes the cleanup wait (`awaiting-stop`) for the sweep to confirm the stop; with something else missing the scratch is kept.
   */
  async run(attempt: ScratchAttempt, missing: readonly string[], before?: () => Promise<string | undefined>, options: { readonly workerStopped?: boolean; readonly signal?: AbortSignal } = {}): Promise<ScratchRun> {
    return this.#track(this.#run(attempt, missing, before, options));
  }

  async #run(attempt: ScratchAttempt, missing: readonly string[], before: (() => Promise<string | undefined>) | undefined, options: { readonly workerStopped?: boolean; readonly signal?: AbortSignal }): Promise<ScratchRun> {
    const a: ScratchAttempt = { attemptId: attempt.attemptId, taskId: attempt.taskId, projectId: attempt.projectId, agentId: attempt.agentId, ...(attempt.hostId === undefined ? {} : { hostId: attempt.hostId }), ...(attempt.generation === undefined ? {} : { generation: attempt.generation }) };
    const id = idOf(a.attemptId);
    await this.begin(a.attemptId);
    let rec = (await this.#read(id))!;
    const replayed = rec.body.state !== "deciding";
    if (rec.body.state === "deciding") {
      const mode = await this.#ports.mode().catch((): ScratchMode => "keep");
      const now = this.#runner.now();
      const stopped = options.workerStopped !== false;
      const why = mode === "keep" ? "the cleanup setting is keep" : (missing.length > 0 || !stopped) ? `not everything was handed onward yet: ${text([...(stopped ? [] : ["the worker was not confirmed stopped"]), ...missing].join("; "), SCRATCH_LIMITS.why)}` : this.#ports.order === undefined ? "no host can remove scratch here" : undefined;
      const waits = why === undefined ? false : mode !== "keep" && missing.length === 0 && !stopped && this.#ports.order !== undefined;
      rec = await this.#update(id, "scratch.cleanup.decide", (b) => b.state !== "deciding" ? b : { ...b, ...a, state: waits ? "awaiting-stop" as const : why === undefined ? "ordering" as const : "kept" as const, ...(waits ? { why: "waiting for the worker to confirm it stopped" } : why === undefined ? {} : { why, finishedAt: now }), decidedAt: now });
    }
    if (rec.body.state === "awaiting-stop") rec = await this.#awaitStop(id, rec, options.signal);
    if (rec.body.state === "ordering") rec = await this.#order(id, rec, a, before ?? (this.#ports.before === undefined ? undefined : () => this.#ports.before!(a)), options.signal);
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
    if ((rec.body.state === "removed" || rec.body.state === "kept") && rec.body.reported) await this.#listed(a.attemptId, false).catch(() => undefined);
    return { ...rec.body, replayed };
  }

  /** Closes a cleanup that could not be finished in `unresolvedMs` as kept (nothing is removed) and tells the supervisor/owner once. The notice comes first: a notice that fails leaves the record open and is tried again by the next sweep. */
  async #giveUp(id: string, rec: { body: ScratchRecord; revision: number }, reason: string): Promise<{ body: ScratchRecord; revision: number }> {
    if (rec.body.unresolvedNotified !== true && this.#ports.unresolved !== undefined) {
      await this.#ports.unresolved(rec.body, reason, `scratch-unresolved:${rec.body.attemptId}`);
    }
    return this.#update(id, "scratch.cleanup.unresolved", (b) => (b.state !== "deciding" && b.state !== "awaiting-stop") ? b : { ...b, state: "kept" as const, why: text(`unresolved: ${reason}`, SCRATCH_LIMITS.why), unresolvedNotified: true, finishedAt: this.#runner.now(), reported: true });
  }

  /** The time before which the sweep leaves a record alone. */
  #later(ms: number): string { return new Date(Date.parse(this.#runner.now()) + ms).toISOString(); }

  /** A cleanup that waits for the worker's stop: asks whether it is confirmed now (at most every `recheckMs`, and each ask has its own time limit), then goes on to order, or keeps (the setting changed), or tells somebody once after the owner's patience, or is closed as unresolved after `unresolvedMs`. */
  async #awaitStop(id: string, rec: { body: ScratchRecord; revision: number }, signal: AbortSignal | undefined): Promise<{ body: ScratchRecord; revision: number }> {
    const a = rec.body;
    const now = Date.parse(this.#runner.now());
    if (a.checkedAt !== undefined && now - Date.parse(a.checkedAt) < this.#limits.recheckMs) return rec;
    if ((await this.#ports.mode().catch((): ScratchMode => "keep")) === "keep") return this.#update(id, "scratch.cleanup.finish", (b) => b.state !== "awaiting-stop" ? b : { ...b, state: "kept" as const, why: "the cleanup setting is keep", finishedAt: this.#runner.now() });
    const asked = this.#ports.workerStopped === undefined ? { value: false } : await this.#bounded(this.#limits.callMs, signal, (s) => this.#ports.workerStopped!(a, s).catch(() => false));
    if (asked === "aborted") return rec;
    const stopped = asked === "timeout" ? false : asked.value;
    if (stopped === true) return this.#update(id, "scratch.cleanup.stopped", (b) => { if (b.state !== "awaiting-stop") return b; const { why: _w, retryAt: _r, ...rest } = b; void _w; void _r; return { ...rest, state: "ordering" as const, decidedAt: this.#runner.now() }; });
    let out = await this.#update(id, "scratch.cleanup.checked", (b) => b.state !== "awaiting-stop" ? b : { ...b, checkedAt: this.#runner.now(), retryAt: this.#later(this.#limits.recheckMs) });
    const hours = this.#ports.patienceHours === undefined ? DEFAULT_AWAIT_STOP_HOURS : await this.#ports.patienceHours().catch((): number | null => DEFAULT_AWAIT_STOP_HOURS);
    if (hours !== null && out.body.state === "awaiting-stop" && out.body.stuckNotified !== true && now - Date.parse(out.body.decidedAt) >= hours * 3_600_000 && this.#ports.stuck !== undefined) {
      await this.#ports.stuck(a, hours, `scratch-stuck:${a.attemptId}`);
      out = await this.#update(id, "scratch.cleanup.stuck", (b) => b.stuckNotified === true ? b : { ...b, stuckNotified: true });
    }
    // A host that can never confirm (it cannot release) leaves the cleanup open for ever otherwise: after `unresolvedMs` it is closed as kept and said once.
    if (out.body.state === "awaiting-stop" && now - Date.parse(out.body.decidedAt) >= this.#limits.unresolvedMs) out = await this.#giveUp(id, out, "the worker never confirmed it stopped, so the scratch was kept and the cleanup closed");
    return out;
  }

  /** The order itself: the record is claimed with a lease first (a second sweep does not send the same order at the same time), the answer is recorded under that claim, and a busy or silent host leaves the cleanup open (spaced by a growing wait). */
  async #order(id: string, rec0: { body: ScratchRecord; revision: number }, a: ScratchAttempt, before: (() => Promise<string | undefined>) | undefined, signal: AbortSignal | undefined): Promise<{ body: ScratchRecord; revision: number }> {
    let rec = rec0;
    if (signal?.aborted === true || this.#down.signal.aborted) return rec;
    const hold = before === undefined ? undefined : await before();
    if (hold !== undefined) return this.#update(id, "scratch.cleanup.finish", (b) => b.state !== "ordering" ? b : { ...b, state: "kept" as const, why: text(hold, SCRATCH_LIMITS.why), finishedAt: this.#runner.now() });
    const token = randomUUID();
    rec = await this.#update(id, "scratch.cleanup.claim", (b) => {
      if (b.state !== "ordering") return b;
      if (b.lease !== undefined && Date.parse(b.lease.until) > Date.parse(this.#runner.now())) return b;
      return { ...b, lease: { token, until: new Date(Date.parse(this.#runner.now()) + this.#limits.leaseMs).toISOString() } };
    });
    // Another run holds the order: its answer decides.
    if (rec.body.state !== "ordering" || rec.body.lease?.token !== token) return rec;
    let report: ScratchReport | undefined, failure: string | undefined, silent = false, aborted = false;
    try {
      const answer = await this.#bounded(this.#limits.orderMs, signal, (s) => this.#ports.order!({ ...a, hostId: rec.body.hostId ?? a.hostId, generation: rec.body.generation ?? a.generation, key: `scratch:${a.attemptId}` } as ScratchOrder, s));
      if (answer === "timeout") silent = true; else if (answer === "aborted") aborted = true; else report = answer.value;
    } catch (error) { failure = `the host could not remove it (${text((error as Error)?.message ?? error, 150)})`; }
    if (aborted) {
      // Shutdown or a cut-off hook: nothing is decided, the lease is given up so the next run can take the order at once, and no retry is used.
      return this.#update(id, "scratch.cleanup.unlease", (b) => { if (b.state !== "ordering" || b.lease?.token !== token) return b; const { lease: _l, ...rest } = b; void _l; return rest; });
    }
    const leftovers = leftoversOf(report?.leftovers);
    // A repeat of an order the host already did: nothing is there because that order removed it.
    const removed = failure === undefined && !silent && (report?.removed === true || report?.alreadyRemoved === true);
    if (silent || (!removed && report?.busy === true)) {
      // Nothing is decided: the host is still on it or did not answer. The lease is given up and the sweep asks again later (after a wait that doubles up to a cap), a bounded number of times.
      return this.#update(id, "scratch.cleanup.pending", (b) => {
        if (b.state !== "ordering") return b;
        const retries = (b.retries ?? 0) + 1;
        const { lease: _l, ...rest } = b; void _l;
        const wait = Math.min(this.#limits.retryCapMs, this.#limits.retryBaseMs * 2 ** Math.min(retries - 1, 20));
        return retries >= this.#limits.retries ? { ...rest, retries, state: "kept" as const, why: silent ? "the host did not answer the order in time, again and again" : "the host stayed busy with an earlier order", finishedAt: this.#runner.now() } : { ...rest, retries, retryAt: this.#later(wait) };
      });
    }
    return this.#update(id, "scratch.cleanup.finish", (b) => {
      // A removal is a fact the host reported: it is recorded even when another run has closed the cleanup as kept meanwhile (kept becomes removed; a removed one is never changed).
      const upgrade = removed && b.state === "kept";
      if (b.state !== "ordering" && !upgrade) return b;
      // Somebody else took the order over after our lease ran out: their answer decides, unless ours says it is gone (a fact).
      if (!removed && b.lease !== undefined && b.lease.token !== token) return b;
      const { lease: _l, why: _w, retryAt: _r, ...rest } = b; void _l; void _w; void _r;
      const kept = upgrade ? b.leftovers : [];
      const merged = leftovers.length > 0 || kept.length === 0 ? leftovers : kept;
      return {
        ...rest, state: removed ? "removed" as const : "kept" as const, leftovers: merged, reported: upgrade && b.reported && merged.length === kept.length ? true : merged.length === 0, finishedAt: this.#runner.now(),
        ...(removed ? {} : { why: failure ?? (text(report?.detail, SCRATCH_LIMITS.why) || "the host did not remove it") }),
      };
    });
  }

  /**
   * The sweep: finishes the decisions still open (a record that was only begun, an order that may have gone out before a restart, a wait for the worker's stop, a leftovers report that failed). Every record looked at counts toward `perRecover`, and the pass
   * stops starting new work after `passMs` of real time, so a silent host cannot hold the dispatcher's tick; where it starts rotates, so records behind the ones that cost time are reached. Only records decided more than `staleMs` ago (a run that is
   * still going is left to finish; the order itself is also guarded by a lease) and not waiting for their `retryAt` are worked on. One that fails does not stop the others; the failures are reported together at the end. A report that failed `tries`
   * times is given up and recorded as such; a decision that cannot be made in `unresolvedMs` is closed as kept and reported once.
   */
  async recover(): Promise<number> {
    return this.#track(this.#recover());
  }

  async #recover(): Promise<number> {
    const open = ((await this.#runner.get(OPEN_KIND, OPEN_ID))?.body as unknown as { attempts?: string[] } | undefined)?.attempts ?? [];
    let done = 0;
    const failed: string[] = [];
    const gone: string[] = [];
    const now = Date.parse(this.#runner.now());
    const began = Date.now();
    const from = open.length === 0 ? 0 : this.#cursor % open.length;
    let looked = 0;
    for (const attemptId of [...open.slice(from), ...open.slice(0, from)]) {
      if (looked >= this.#limits.perRecover || Date.now() - began >= this.#limits.passMs || this.#down.signal.aborted) break;
      looked++;
      const rec = await this.#read(idOf(attemptId));
      if (rec === undefined || ((rec.body.state === "removed" || rec.body.state === "kept") && rec.body.reported)) { gone.push(attemptId); continue; }
      const state = rec.body.state;
      if ((state === "ordering" || state === "deciding") && now - Date.parse(rec.body.decidedAt) < this.#limits.staleMs) continue;
      if (rec.body.retryAt !== undefined && Date.parse(rec.body.retryAt) > now) continue;
      try {
        if (state === "deciding") {
          const d = await this.#ports.decide?.(attemptId).catch((): undefined => undefined);
          if (d === undefined) {
            // Cannot be decided now (the attempt cannot be read, or the ending is still open): looked at again later, and closed as kept once it has been open for `unresolvedMs`.
            if (now - Date.parse(rec.body.decidedAt) >= this.#limits.unresolvedMs) { await this.#giveUp(idOf(attemptId), rec, "the attempt's ending could not be read or decided"); done++; }
            else await this.#update(idOf(attemptId), "scratch.cleanup.look", (b) => b.state !== "deciding" ? b : { ...b, retryAt: this.#later(this.#limits.recheckMs) });
            continue;
          }
          const r = await this.run(d.attempt, d.missing, undefined, { workerStopped: d.workerStopped });
          if (r.state !== state) done++;
        } else {
          const r = await this.run(rec.body, [], undefined);
          // Counted when it got somewhere: the state moved on or the leftovers were reported (a record another run holds, or one still waiting, is not).
          if (r.state !== state || r.reported !== rec.body.reported) done++;
        }
      } catch (error) { failed.push(`${attemptId}: ${text((error as Error)?.message ?? error, 150)}`); }
    }
    this.#cursor = from + looked;
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

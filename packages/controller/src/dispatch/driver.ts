import { DomainError, isDomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { DispatcherService, TickReport } from "./dispatcher.js";
import { DISPATCHER_ACTOR } from "./model.js";

/** The controller's timer, as a port: production uses `realTimer`; tests hand in one that only fires when told. `schedule` runs `fn` once after `ms`; the returned function cancels it. */
export interface TimerPort { schedule(ms: number, fn: () => void | Promise<void>): () => void }

/** A real timer that does not keep the process alive on its own (the controller closes the driver; an operator's process stays up for its listeners). */
export const realTimer: TimerPort = {
  schedule: (ms, fn) => { const handle = setTimeout(fn, ms); handle.unref(); return () => clearTimeout(handle); },
};

export const DRIVER_LIMITS = { intervalMs: 5_000, maxBackoffMs: 60_000, errorsKept: 50, errorText: 300, recordEveryMs: 60_000 } as const;
const HEALTH: AggregateRef = { kind: "dispatch-health", id: "loops" };

/** One kind of error (same source and message): how often it happened, when it was first and last seen. */
export interface DriverError { readonly at: string; readonly firstAt: string; readonly count: number; readonly source: string; readonly message: string }

export interface DriverStatus {
  readonly state: "idle" | "running" | "stopping" | "stopped" | "fenced" | "disabled";
  readonly ticks: number;
  /** Ticks that threw (the store was unreachable, a bug), as opposed to loops inside a tick that reported failure. */
  readonly failedTicks: number;
  readonly consecutiveFailures: number;
  readonly lastTickAt?: string;
  /** How often each named loop reported failure since this driver started. */
  readonly loopFailures: Readonly<Record<string, number>>;
  /** The most recent errors (at most `DRIVER_LIMITS.errorsKept`), newest last. Older ones are counted in `dropped`, not lost silently. */
  readonly errors: readonly DriverError[];
  readonly dropped: number;
  readonly lastReport?: { readonly at: string; readonly started: number; readonly lost: number; readonly scanned: number; readonly complete: boolean };
}

export interface DriverOptions {
  readonly dispatcher: Pick<DispatcherService, "tick" | "shutdown" | "dropWorkers" | "idle">;
  readonly storage: Pick<ControllerStorage, "currentEpoch">;
  /** The epoch this controller took at start. A newer one means another controller instance owns the store: this driver stops and never ticks again. */
  readonly epoch: number;
  readonly intervalMs?: number;
  readonly timer?: TimerPort;
  readonly clock?: () => string;
  /** Called with every error as well as it being recorded (the controller's `onInternalError`). */
  readonly onError?: (error: unknown) => void;
  /** Asked before every tick: false when the owner disabled the dispatcher principal. The driver then closes the attempts it holds, stops for good and calls `onDisabled` (the owner is told). */
  readonly enabled?: () => Promise<boolean>;
  readonly onDisabled?: (reason: string) => Promise<void>;
  /** Where the errors are also written, so they survive a restart (bounded: one record, the last `errorsKept`). Failure to write is itself kept in memory. */
  readonly record?: { readonly storage: ControllerStorage; readonly options?: RunnerOptions };
}

/**
 * The controller's loop (card H12c). It calls `DispatcherService.tick()` (which runs the dispatcher's own work and every service loop wired into it) every `intervalMs` from the injected timer, one tick
 * at a time. Before each tick it checks that the controller still holds the primary epoch: when another instance took over, this one is **fenced** and stops for good, so only one instance ever runs
 * the loops. A tick that throws is recorded and retried later with a growing delay (up to a minute); a loop that reports failure inside a tick is counted by name. Errors are kept in memory
 * (the last 50, the rest counted), passed to `onError` and written to the `dispatch-health` record. `stop()` is graceful: no new tick starts, the tick running finishes, and the live attempts are
 * checkpointed and closed so the next controller resumes them.
 */
export class DispatchDriver {
  readonly #o: DriverOptions;
  readonly #timer: TimerPort;
  readonly #now: () => string;
  readonly #interval: number;
  readonly #runner: CommandRunner | undefined;
  #cancel: (() => void) | undefined;
  #running: Promise<unknown> | undefined;
  #state: DriverStatus["state"] = "idle";
  #ticks = 0;
  #failedTicks = 0;
  #consecutive = 0;
  #lastTickAt: string | undefined;
  #lastReport: DriverStatus["lastReport"];
  #dropped = 0;
  #dirty = false;
  #fresh = false;
  #wroteAt: number | undefined;
  readonly #errors: DriverError[] = [];
  readonly #loopFailures = new Map<string, number>();
  readonly #instance = Math.random().toString(36).slice(2, 10);

  constructor(options: DriverOptions) {
    const interval = options.intervalMs ?? DRIVER_LIMITS.intervalMs;
    if (!Number.isSafeInteger(interval) || interval < 1) throw new DomainError("invalid_command", "intervalMs: must be a whole number of milliseconds, at least 1", { field: "intervalMs" });
    this.#o = options;
    this.#interval = interval;
    this.#timer = options.timer ?? realTimer;
    this.#now = options.clock ?? (() => new Date().toISOString());
    this.#runner = options.record === undefined ? undefined : new CommandRunner(options.record.storage, options.epoch, { ...(options.record.options ?? {}), clock: this.#now });
  }

  /** Starts ticking: the first tick runs after one interval. A second call, or a call on a stopped or fenced driver, does nothing. */
  start(): void {
    if (this.#state !== "idle") return;
    this.#state = "running";
    this.#arm(this.#interval);
  }

  status(): DriverStatus {
    return {
      state: this.#state, ticks: this.#ticks, failedTicks: this.#failedTicks, consecutiveFailures: this.#consecutive,
      ...(this.#lastTickAt === undefined ? {} : { lastTickAt: this.#lastTickAt }), loopFailures: Object.fromEntries(this.#loopFailures), errors: [...this.#errors], dropped: this.#dropped,
      ...(this.#lastReport === undefined ? {} : { lastReport: this.#lastReport }),
    };
  }

  /** One tick now (tests, and an operator's "run it now"). It does what a timer tick does, including the epoch check; a tick already running is joined. Returns undefined when the driver is fenced or stopped. */
  async runOnce(): Promise<TickReport | undefined> {
    if (this.#running !== undefined) return (await this.#running) as TickReport | undefined;
    if (this.#state === "fenced" || this.#state === "stopped" || this.#state === "stopping" || this.#state === "disabled") return undefined;
    const run = this.#once();
    this.#running = run;
    try { return await run; } finally { this.#running = undefined; }
  }

  /** Graceful shutdown. Safe to call twice. A fenced or disabled driver never closes attempts in the store (they are not its to close); its local workers were ended when it was fenced. */
  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    if (this.#state === "idle" || this.#state === "running") this.#state = "stopping";
    this.#cancel?.();
    this.#cancel = undefined;
    await this.#running?.catch(() => undefined);
    // Checked after the last tick: that tick may have been the one that found the epoch gone.
    if (this.#state === "stopping" && (await this.#o.storage.currentEpoch().catch(() => this.#o.epoch)) !== this.#o.epoch) await this.#fence("another controller instance holds the primary epoch");
    if (this.#state === "stopping") {
      try {
        const shut = await this.#o.dispatcher.shutdown();
        for (const e of shut.errors) this.#fail("shutdown", e);
      } catch (error) { this.#fail("shutdown", error); }
    }
    await this.#o.dispatcher.idle().catch(() => undefined);
    await this.#flush(true);
    if (this.#state === "stopping") this.#state = "stopped";
  }

  #arm(ms: number): void {
    this.#cancel = this.#timer.schedule(ms, () => {
      this.#cancel = undefined;
      if (this.#state !== "running") return;
      // Returned, so a timer that wants to (a test's) can wait for the tick and the re-arming; the real timer ignores it.
      return this.runOnce().then(() => { if (this.#state === "running") this.#arm(this.#delay()); });
    });
  }

  #delay(): number { return this.#consecutive === 0 ? this.#interval : Math.min(DRIVER_LIMITS.maxBackoffMs, this.#interval * 2 ** Math.min(this.#consecutive, 16)); }

  async #once(): Promise<TickReport | undefined> {
    try {
      if ((await this.#o.storage.currentEpoch()) !== this.#o.epoch) return await this.#fence("another controller instance holds the primary epoch");
      if (this.#o.enabled !== undefined && !(await this.#o.enabled())) return await this.#disable();
      const report = await this.#o.dispatcher.tick();
      this.#ticks++;
      this.#lastTickAt = report.at;
      this.#lastReport = { at: report.at, started: report.started.length, lost: report.lost.length, scanned: report.scanned, complete: report.complete };
      let failed = false;
      for (const loop of report.loops) {
        if (loop.ok) continue;
        failed = true;
        this.#loopFailures.set(loop.name, (this.#loopFailures.get(loop.name) ?? 0) + 1);
        this.#fail(loop.name, loop.error ?? "failed");
      }
      for (const f of report.failures ?? []) { failed = true; this.#fail(`attempt ${f.attemptId}`, f.error); }
      this.#consecutive = 0;
      await this.#flush(false);
      return report;
    } catch (error) {
      if (isDomainError(error, "stale_epoch")) return this.#fence("a write was refused as from an old epoch");
      this.#failedTicks++;
      this.#consecutive++;
      this.#fail("tick", error);
      await this.#flush(false);
      return undefined;
    }
  }

  /** Another instance owns the store: stop ticking and end the workers this process holds, with no write (the new controller finds the attempts by their leases). */
  async #fence(why: string): Promise<undefined> {
    const was = this.#state;
    this.#state = "fenced";
    this.#cancel?.();
    this.#cancel = undefined;
    if (was !== "fenced") {
      this.#fail("epoch", why);
      await this.#o.dispatcher.dropWorkers().catch(() => undefined);
    }
    return undefined;
  }

  /** The owner disabled the dispatcher: close what it holds cleanly, stop, record, and have the owner told. */
  async #disable(): Promise<undefined> {
    this.#state = "disabled";
    this.#cancel?.();
    this.#cancel = undefined;
    const why = "service:dispatcher was disabled by the owner; the dispatcher stopped";
    this.#fail("dispatcher", why);
    try { const shut = await this.#o.dispatcher.shutdown(); for (const e of shut.errors) this.#fail("shutdown", e); } catch (error) { this.#fail("shutdown", error); }
    try { await this.#o.onDisabled?.(why); } catch (error) { this.#fail("notice", error); }
    await this.#flush(true);
    return undefined;
  }

  /** Counts the error: the same source and message again only raises the count, so a permanent failure neither grows the list nor pushes real errors out of it. */
  #fail(source: string, error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, DRIVER_LIMITS.errorText);
    const at = this.#now();
    const i = this.#errors.findIndex((e) => e.source === source && e.message === message);
    if (i >= 0) this.#errors[i] = { ...this.#errors[i]!, at, count: this.#errors[i]!.count + 1 };
    else {
      this.#errors.push({ at, firstAt: at, count: 1, source, message });
      this.#fresh = true;
      if (this.#errors.length > DRIVER_LIMITS.errorsKept) { this.#errors.shift(); this.#dropped++; }
    }
    this.#dirty = true;
    try { this.#o.onError?.(error instanceof Error ? error : new Error(`${source}: ${message}`)); } catch { /* a failing observer must not stop the loop */ }
  }

  /** Writes the health record when a new kind of error appeared, or when only counts changed and a minute has passed (or `force`): a failure that repeats for ever costs one write a minute. */
  async #flush(force: boolean): Promise<void> {
    if (this.#runner === undefined || !this.#dirty || this.#state === "fenced") return;
    const nowMs = Date.parse(this.#now());
    if (!force && !this.#fresh && this.#wroteAt !== undefined && nowMs - this.#wroteAt < DRIVER_LIMITS.recordEveryMs) return;
    const body = { at: this.#now(), ticks: this.#ticks, failedTicks: this.#failedTicks, dropped: this.#dropped, loopFailures: Object.fromEntries(this.#loopFailures), errors: this.#errors.map((e) => ({ ...e })) } as unknown as JsonObject;
    try {
      const found = await this.#runner.get(HEALTH.kind, HEALTH.id);
      await this.#runner.command("dispatch.health", { commandId: `dpa-health:${found?.revision ?? 0}:${this.#instance}`, actor: DISPATCHER_ACTOR }, async () => ({
        payload: { ticks: this.#ticks, failedTicks: this.#failedTicks, errors: this.#errors.length, dropped: this.#dropped },
        build: async () => ({ ref: HEALTH, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: HEALTH, body } : { type: "update" as const, ref: HEALTH, expectedRevision: found.revision, body }], detail: { errors: this.#errors.length } }),
      }));
      this.#dirty = false; this.#fresh = false; this.#wroteAt = nowMs;
    } catch (error) {
      if (isDomainError(error, "stale_epoch")) { await this.#fence("a write was refused as from an old epoch"); return; }
      // Kept for the next try; not recorded as a new error, which would make every failed write grow the list.
      try { this.#o.onError?.(error); } catch { /* ignore */ }
    }
  }
}

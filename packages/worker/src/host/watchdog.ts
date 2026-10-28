/** Clocks the watchdog reads. `mono` never goes back and does not count time asleep; `wall` does count it, so the difference between them shows a suspend. */
export interface WatchdogClock { mono(): number; wall(): number }
export const systemClock: WatchdogClock = { mono: () => Number(process.hrtime.bigint() / 1_000_000n), wall: () => Date.now() };

export type LossReason = "explicit" | "silent" | "supervisor" | "wake";

export interface WatchdogOptions {
  readonly clock?: WatchdogClock;
  /** The longest lease a renewal may grant, in ms. A longer answer is cut to it. */
  readonly maxLeaseMs: number;
  /** How long after productive work stopped the process is ended if it has not said it is quiet (contained termination). */
  readonly graceMs: number;
  /** A gap between wall time and monotonic time larger than this since the last tick means the machine slept: the lease is treated as gone. Default 5,000. */
  readonly sleepJumpMs?: number;
  /** The supervisor is gone when it has not pulsed for this long. Absent: no supervisor is watched. */
  readonly supervisorMs?: number;
  /** Productive actions stop: no new tool call, model request or write starts. Called once. */
  readonly onStop: (reason: LossReason) => void | Promise<void>;
  /** The process is ended (contained termination). Called once, after the grace, unless the worker reported itself quiet. */
  readonly onTerminate: (reason: LossReason) => void | Promise<void>;
}

/** Thrown by `assertProductive` once the watchdog has stopped productive work. */
export class LeaseLost extends Error {
  constructor(readonly reason: LossReason) { super(`the attempt's authority is gone (${reason}); no productive action may start`); this.name = "LeaseLost"; }
}

/**
 * The worker's own check that its authority is still alive (card H08). It does not ask the controller whether it may go on; it stops by itself:
 * - **Explicit loss** (the controller says the attempt is fenced, revoked or moved) stops productive work at once.
 * - **Silent loss**: the lease is a local deadline. A renewal counts from the moment it was *sent*, on the monotonic clock, so a reply that comes late, or is replayed, never makes the lease longer than the controller meant,
 *   and a lease can only be pushed out by a newer send. When the deadline passes with no renewal, productive work stops.
 * - **Sleep and wake**: if wall time ran ahead of monotonic time since the last tick the machine slept, and the controller may have given the attempt to someone else meanwhile, so the lease is treated as gone without waiting for a renewal.
 * - **Supervisor death**: when the supervisor stops pulsing the worker fails closed the same way.
 * After productive work stops, the process is ended after `graceMs` unless the worker has reported itself quiet (`quiet()`), which is how a clean wind-down is told from a hung one. Nothing here can be undone: a stopped
 * watchdog stays stopped, and a late renewal does not revive it (a new attempt gets a new watchdog).
 */
export class LeaseWatchdog {
  readonly #o: Required<Pick<WatchdogOptions, "maxLeaseMs" | "graceMs" | "sleepJumpMs">> & WatchdogOptions;
  readonly #clock: WatchdogClock;
  #deadline: number;
  #lastMono: number;
  #lastWall: number;
  #lastPulse: number;
  #lost: LossReason | undefined;
  #stoppedAt: number | undefined;
  #quiet = false;
  #terminated = false;
  #stopping: Promise<void> | undefined;

  /** `grantedAt` is the monotonic time the first lease counts from (its `leaseMs` is cut to `maxLeaseMs`). */
  constructor(options: WatchdogOptions, leaseMs: number, grantedAt?: number) {
    this.#o = { sleepJumpMs: 5000, ...options };
    this.#clock = options.clock ?? systemClock;
    const now = this.#clock.mono();
    this.#deadline = (grantedAt ?? now) + Math.min(leaseMs, options.maxLeaseMs);
    this.#lastMono = now;
    this.#lastWall = this.#clock.wall();
    this.#lastPulse = now;
  }

  /** The time to put on a renewal request before it is sent; give it back to `renewed`. */
  sending(): number { return this.#clock.mono(); }

  /** A renewal was answered. It counts from `sentAt`, and never shortens the lease or revives a lost one. */
  renewed(sentAt: number, leaseMs: number): void {
    if (this.#lost !== undefined) return;
    const next = sentAt + Math.min(leaseMs, this.#o.maxLeaseMs);
    if (next > this.#deadline) this.#deadline = next;
  }

  /** The supervisor is alive. */
  pulse(): void { this.#lastPulse = this.#clock.mono(); }

  /** The controller said the attempt is fenced, revoked or moved. */
  lost(): Promise<void> { return this.#stop("explicit"); }

  /** The worker has wound down on its own: no termination is needed. */
  quiet(): void { this.#quiet = true; }

  get productive(): boolean { return this.#lost === undefined; }
  get reason(): LossReason | undefined { return this.#lost; }
  get terminated(): boolean { return this.#terminated; }
  /** Milliseconds of lease left on the monotonic clock (0 when lost). */
  remainingMs(): number { return this.#lost !== undefined ? 0 : Math.max(0, this.#deadline - this.#clock.mono()); }

  /** Call before starting anything productive; throws `LeaseLost` once stopped, and also checks the clocks, so it is safe even if `tick` has not run lately. */
  async assertProductive(): Promise<void> {
    await this.tick();
    if (this.#lost !== undefined) throw new LeaseLost(this.#lost);
  }

  /** Looks at the clocks. Run it on a timer (`run`), and it is also called by `assertProductive`. */
  async tick(): Promise<void> {
    const mono = this.#clock.mono();
    const wall = this.#clock.wall();
    const gap = wall - this.#lastWall - (mono - this.#lastMono);
    const jumped = gap > this.#o.sleepJumpMs;
    // The monotonic clock may not run while the machine sleeps: a shorter sleep than the jump limit still uses up that much of the lease.
    if (!jumped && gap > 0) this.#deadline -= gap;
    this.#lastMono = mono; this.#lastWall = wall;
    if (this.#lost === undefined) {
      if (jumped) await this.#stop("wake");
      else if (mono >= this.#deadline) await this.#stop("silent");
      else if (this.#o.supervisorMs !== undefined && mono - this.#lastPulse >= this.#o.supervisorMs) await this.#stop("supervisor");
    }
    if (this.#lost !== undefined && this.#stoppedAt !== undefined && !this.#quiet && !this.#terminated && mono - this.#stoppedAt >= this.#o.graceMs) {
      this.#terminated = true;
      await this.#o.onTerminate(this.#lost);
    }
  }

  /** Ticks every `everyMs` until the watchdog has terminated or the returned function is called. */
  run(everyMs: number): () => void {
    const timer = setInterval(() => { void this.tick(); }, everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  #stop(reason: LossReason): Promise<void> {
    if (this.#lost !== undefined) return this.#stopping ?? Promise.resolve();
    this.#lost = reason;
    this.#stoppedAt = this.#clock.mono();
    this.#stopping = Promise.resolve(this.#o.onStop(reason));
    return this.#stopping;
  }
}

/**
 * Ends a process and everything it started (contained termination): TERM to its process group, then KILL to the group if it is still there after `termMs`. Returns whether it is gone. The process must have been started
 * as its own group leader (`detached: true`); a pid that is not is refused, since its group would be ours.
 */
export async function killContained(pid: number, options: { termMs?: number; signal?: (pid: number, sig: NodeJS.Signals) => void; alive?: (pid: number) => boolean } = {}): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new RangeError("not a process this host may end");
  if (options.signal === undefined && options.alive === undefined) {
    // Its own group leader or nothing: `-pid` is a group only if the process leads one; otherwise the signal would miss it and the answer "gone" would be false.
    let exists = true; try { process.kill(pid, 0); } catch { exists = false; }
    if (exists) { try { process.kill(-pid, 0); } catch { throw new RangeError("the process is not its own group leader; it cannot be ended as a group"); } }
  }
  const termMs = options.termMs ?? 2000;
  const signal = options.signal ?? ((p, sig) => { try { process.kill(-p, sig); } catch { /* gone */ } });
  const alive = options.alive ?? ((p) => { try { process.kill(-p, 0); return true; } catch { return false; } });
  signal(pid, "SIGTERM");
  const until = Date.now() + termMs;
  while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  if (alive(pid)) { signal(pid, "SIGKILL"); const hard = Date.now() + 1000; while (alive(pid) && Date.now() < hard) await new Promise((r) => setTimeout(r, 25)); }
  return !alive(pid);
}

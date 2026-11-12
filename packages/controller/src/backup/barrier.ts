import { DomainError } from "../domain/errors.js";

/**
 * The maintenance barrier (card K01h): while an operation that replaces or moves the installation's stores runs (a restore), nothing else may write to them. Every store or loop that writes registers a
 * participant: `hold()` makes it stop starting new work, waits for what it has in flight and returns the function that lets it go on. The barrier takes the participants in the order they were added and
 * lets them go in the reverse order; if one cannot be held, those already held are released and the operation does not run. One barrier at a time. No time limit is imposed (a limit is optional: `holdTimeoutMs`).
 */
export interface BarrierParticipant { readonly name: string; hold(): Promise<() => Promise<void> | void> }

export class BarrierRefused extends DomainError {
  constructor(readonly participant: string, why: string) { super("unavailable", `the maintenance barrier could not be raised: ${participant} ${why}`); this.name = "BarrierRefused"; }
}

export interface BarrierState { readonly held: boolean; readonly reason?: string; readonly since?: string; readonly participants: readonly string[] }

export class MaintenanceBarrier {
  readonly #participants: BarrierParticipant[] = [];
  readonly #now: () => Date;
  readonly #timeoutMs: number | undefined;
  #held: { reason: string; since: string; release: () => Promise<void> } | undefined;
  #raising = false;
  constructor(options: { now?: () => Date; /** Optional: give up holding a participant after this long. Off by default. */ holdTimeoutMs?: number } = {}) { this.#now = options.now ?? (() => new Date()); this.#timeoutMs = options.holdTimeoutMs; }

  add(participant: BarrierParticipant): void { if (this.#participants.some((p) => p.name === participant.name)) throw new Error(`barrier participant ${participant.name} is already added`); this.#participants.push(participant); }
  /** True from the moment a raise starts until the barrier is released: stores that write on their own check it before each write. */
  get held(): boolean { return this.#held !== undefined || this.#raising; }
  state(): BarrierState { return { held: this.held, ...(this.#held === undefined ? {} : { reason: this.#held.reason, since: this.#held.since }), participants: this.#participants.map((p) => p.name) }; }
  /** Refuses (typed `unavailable`) while the barrier is up, with the reason. For the entry points that must not write meanwhile. */
  check(): void { if (this.held) throw new DomainError("unavailable", `the installation is in maintenance (${this.#held?.reason ?? "starting"}); try again when it is over`); }

  /** Raises the barrier and keeps it up until the returned function is called (a restore that waits for the restart keeps it up). */
  async raise(reason: string): Promise<() => Promise<void>> {
    if (this.held) throw new DomainError("unavailable", `the installation is already in maintenance (${this.#held?.reason ?? "starting"})`);
    this.#raising = true;
    const releases: { name: string; release: () => Promise<void> | void }[] = [];
    const releaseAll = async (): Promise<void> => { for (const r of releases.splice(0).reverse()) { try { await r.release(); } catch { /* a participant that cannot be let go is its own to report */ } } };
    try {
      for (const p of this.#participants) {
        let release: () => Promise<void> | void;
        try { release = await this.#withTimeout(p); } catch (error) { throw new BarrierRefused(p.name, error instanceof Error ? error.message.slice(0, 200) : "did not stop"); }
        releases.push({ name: p.name, release });
      }
    } catch (error) { await releaseAll(); this.#raising = false; throw error; }
    let done = false;
    const release = async (): Promise<void> => { if (done) return; done = true; this.#held = undefined; await releaseAll(); };
    this.#held = { reason, since: this.#now().toISOString(), release };
    this.#raising = false;
    return release;
  }

  /** Raises the barrier, runs `work`, and lets go whatever the result. */
  async run<T>(reason: string, work: () => Promise<T>): Promise<T> {
    const release = await this.raise(reason);
    try { return await work(); } finally { await release(); }
  }

  async #withTimeout(p: BarrierParticipant): Promise<() => Promise<void> | void> {
    if (this.#timeoutMs === undefined) return p.hold();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("did not stop in time")), this.#timeoutMs); });
    const holding = p.hold();
    try { return await Promise.race([holding, late]); } catch (error) { void holding.then((r) => r(), () => undefined); throw error; } finally { clearTimeout(timer); }
  }
}

/**
 * The named writers that are not stores of their own (card K01i): the retention runner, the notification sweeps, the hand-off and resume sweeps and the maintenance loop each run in the dispatcher's tick or on a timer, and
 * the barrier held them only in effect (the dispatcher was paused, commands refused). Here each one is its OWN participant: `wrap(name, fn)` returns the function the loop calls; while its group is held it does not start
 * (the call returns `undefined`), and `participant(label, names)` holds the groups, waits for what each has in flight and lets them go again. A group whose function was never wrapped (a controller without a dispatcher has no sweeps) is simply held with nothing to wait for; a wrapped function throws what it threw.
 */
export class NamedWork {
  readonly #held = new Set<string>();
  readonly #running = new Map<string, Set<Promise<unknown>>>();
  /** The names that were wrapped. */
  readonly #known = new Set<string>();

  isHeld(name: string): boolean { return this.#held.has(name); }
  get names(): readonly string[] { return [...this.#known]; }

  wrap<A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R> | R): (...args: A) => Promise<R | undefined> {
    this.#known.add(name);
    return async (...args: A): Promise<R | undefined> => {
      if (this.#held.has(name)) return undefined;
      const run = Promise.resolve().then(() => fn(...args));
      let set = this.#running.get(name);
      if (set === undefined) { set = new Set(); this.#running.set(name, set); }
      set.add(run);
      try { return await run; } finally { set.delete(run); }
    };
  }

  /** What is running under `name` now. */
  inFlight(name: string): number { return this.#running.get(name)?.size ?? 0; }

  participant(label: string, names: readonly string[]): BarrierParticipant {
    return {
      name: label,
      hold: async () => {
        for (const n of names) this.#held.add(n);
        // What was started before the hold is waited for (its failure is its own: the hold is about not starting more).
        await Promise.allSettled(names.flatMap((n) => [...(this.#running.get(n) ?? [])]));
        return () => { for (const n of names) this.#held.delete(n); };
      },
    };
  }
}

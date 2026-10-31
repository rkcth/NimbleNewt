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

import type { TimerPort } from "../driver.js";

/** A timer that fires only when a test says so, and remembers the delays it was asked for. */
export class ManualTimer implements TimerPort {
  readonly delays: number[] = [];
  #pending: (() => void | Promise<void>) | undefined;
  cancelled = 0;
  schedule(ms: number, fn: () => void | Promise<void>): () => void { this.delays.push(ms); this.#pending = fn; return () => { if (this.#pending === fn) { this.#pending = undefined; this.cancelled++; } }; }
  get armed(): boolean { return this.#pending !== undefined; }
  /** Fires the timer; resolves when the tick it started has ended and the next timer is armed. */
  async fire(): Promise<void> { const f = this.#pending; this.#pending = undefined; await f?.(); }
}

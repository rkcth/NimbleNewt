import type { Capabilities } from "../hosts/index.js";
import { REMOTE_LIMITS, type Offer, type WorkspaceAsk } from "./protocol.js";
import { WorkerRequestError, type ReconcileAnswer, type RemoteWorkerClient } from "./client.js";

/**
 * How a worker host asks for work (card H07): one poller per host, never one per agent or attempt. It connects, then holds one long poll for offers at a time; the controller answers the moment an offer is made, so an
 * idle host costs the controller about one request every `waitMs`. Heartbeats go at their own interval. Anything that fails is retried with exponential backoff and full jitter (a random delay between none and the
 * current ceiling), a controller's `retry-after` is honoured, and the first connection after a start or a restart waits a random part of `spreadMs`, so a hundred hosts coming back together arrive spread out instead
 * of in a burst. A refused protocol or a revoked credential is not retried quickly: it waits the longest backoff and says so. The sleep and the random source are injected, so the schedule is testable.
 */
export interface PollerOptions {
  readonly client: Pick<RemoteWorkerClient, "connect" | "heartbeat" | "offers" | "session" | "forgetSession"> & Partial<Pick<RemoteWorkerClient, "workspaceRequests" | "workspaceList" | "reconcile">>;
  readonly capabilities: Capabilities;
  /** Called with offers, in order. The poller polls again only after it returns; an offer not accepted is offered again by the controller. */
  readonly onOffers: (offers: readonly Offer[]) => Promise<void>;
  /**
   * Called with the workspace requests the controller has for this host after every round (card H12m). It must return at once: the work of a request runs in the background (a `WorkspaceResponder` does), or the
   * poller would stop beating while an integration runs. Needs a client that has `workspaceRequests`.
   */
  readonly onWorkspace?: (requests: readonly WorkspaceAsk[], withdrawn: readonly string[]) => void;
  /**
   * The attempts this host still holds (card H09b). Given, every new session starts with the recovery handshake: the list (at most `REMOTE_LIMITS.held`, the first ones) goes to the controller before anything else, and its
   * answer goes to `onReconciled`, which acts on each verdict (stop, hold, accept again, wait for the owner). A handshake that fails is tried again before the next poll. Needs a client that has `reconcile`.
   */
  readonly held?: () => readonly { readonly attemptId: string; readonly placement: number }[];
  readonly onReconciled?: (answer: ReconcileAnswer) => Promise<void> | void;
  /** The poll hold, in ms (default 20 000; at most the controller's limit). */
  readonly waitMs?: number;
  /** The gap between heartbeats, in ms (default 15 000). */
  readonly heartbeatMs?: number;
  /** The first retry's ceiling and the greatest ceiling, in ms (defaults 1 000 and 60 000). */
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** The least time between two polls, so a controller that answers at once cannot make a loop of requests (default 1 000). */
  readonly minGapMs?: number;
  /** The window the first connection is spread over (default 10 000). */
  readonly spreadMs?: number;
  /** 0 to 1, injected for tests (default `Math.random`). */
  readonly random?: () => number;
  /** Waits ms; resolves early when the signal aborts (default a timer). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The clock for the heartbeat interval (default `Date.now`). */
  readonly now?: () => number;
  /** Told about every failure and how long the poller will wait. */
  readonly onTrouble?: (event: { readonly error: unknown; readonly retryInMs: number; readonly kind: "connect" | "poll" | "heartbeat" | "offers" | "waiting-for-owner" | "workspace" | "reconcile" }) => void;
}

const timerSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  function done(): void { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});

export class HostPoller {
  readonly #o: Required<Pick<PollerOptions, "waitMs" | "heartbeatMs" | "baseBackoffMs" | "maxBackoffMs" | "minGapMs" | "spreadMs">> & PollerOptions;
  readonly #random: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #now: () => number;
  #failures = 0;
  #sequence = 0;
  /** The session the recovery handshake still has to be made for (card H09b). */
  #reconcileFor: string | undefined;

  constructor(options: PollerOptions) {
    const waitMs = options.waitMs ?? 20_000;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > REMOTE_LIMITS.pollMs) throw new RangeError(`waitMs: must be a whole number from 0 to ${REMOTE_LIMITS.pollMs}`);
    this.#o = { ...options, waitMs, heartbeatMs: options.heartbeatMs ?? 15_000, baseBackoffMs: options.baseBackoffMs ?? 1_000, maxBackoffMs: options.maxBackoffMs ?? 60_000, minGapMs: options.minGapMs ?? 1_000, spreadMs: options.spreadMs ?? 10_000 };
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? timerSleep;
    this.#now = options.now ?? Date.now;
  }

  /** The delay after the `n`th failure in a row: a random part of the ceiling `min(max, base * 2^(n-1))` (full jitter). Never less than the controller's `retry-after`, when it gave one. */
  backoff(failures: number, retryAfterMs = 0): number {
    const ceiling = Math.min(this.#o.maxBackoffMs, this.#o.baseBackoffMs * 2 ** Math.min(30, Math.max(0, failures - 1)));
    return Math.max(retryAfterMs, Math.floor(this.#random() * ceiling));
  }

  /** Runs until the signal aborts. */
  async run(signal: AbortSignal): Promise<void> {
    await this.#sleep(Math.floor(this.#random() * this.#o.spreadMs), signal);
    let beat = Number.NEGATIVE_INFINITY;
    while (!signal.aborted) {
      const started = this.#now();
      try {
        if (this.#o.client.session === undefined) {
          const session = await this.#o.client.connect(this.#o.capabilities as never);
          beat = Number.NEGATIVE_INFINITY;
          if (this.#o.held !== undefined && this.#o.client.reconcile !== undefined) this.#reconcileFor = session.sessionId;
        }
        // The handshake comes first in a new session: nothing the worker holds is taken up again before the controller has answered for it.
        if (this.#reconcileFor !== undefined && this.#reconcileFor === this.#o.client.session?.sessionId && !signal.aborted) {
          try {
            const answer = await this.#o.client.reconcile!(this.#o.held!().slice(0, REMOTE_LIMITS.held));
            await this.#o.onReconciled?.(answer);
            this.#reconcileFor = undefined;
          } catch (error) { await this.#trouble(error, "reconcile", signal); continue; }
        }
        if (this.#now() - beat >= this.#o.heartbeatMs) { await this.#o.client.heartbeat(++this.#sequence); beat = this.#now(); }
        // A hold longer than the time to the next heartbeat would let the heartbeat go late.
        const hold = Math.max(0, Math.min(this.#o.waitMs, this.#o.heartbeatMs - (this.#now() - beat)));
        const offers = await this.#o.client.offers({ waitMs: hold });
        if (offers.length > 0 && !signal.aborted) {
          try { await this.#o.onOffers(offers); } catch (error) { await this.#trouble(error, "offers", signal); continue; }
        }
        if (this.#o.onWorkspace !== undefined && (this.#o.client.workspaceRequests !== undefined || this.#o.client.workspaceList !== undefined) && !signal.aborted) {
          try { const { requests, withdrawn } = this.#o.client.workspaceList !== undefined ? await this.#o.client.workspaceList() : { requests: await this.#o.client.workspaceRequests!(), withdrawn: [] as string[] }; if (requests.length > 0 || withdrawn.length > 0) this.#o.onWorkspace(requests, withdrawn); } catch (error) { await this.#trouble(error, "workspace", signal); continue; }
        }
        this.#failures = 0;
        const gap = this.#o.minGapMs - (this.#now() - started);
        if (gap > 0) await this.#sleep(gap, signal);
      } catch (error) {
        await this.#trouble(error, "poll", signal);
      }
    }
  }

  async #trouble(error: unknown, kind: "connect" | "poll" | "heartbeat" | "offers" | "workspace" | "reconcile", signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    // An attempt that waits for the owner's decision is not a failure: the session stays, the failure count does not grow, and the poller asks again after a calm wait.
    if (error instanceof WorkerRequestError && error.waitingForOwner) {
      const calm = Math.floor(this.#o.maxBackoffMs * (0.5 + 0.5 * this.#random()));
      this.#o.onTrouble?.({ error, retryInMs: calm, kind: "waiting-for-owner" });
      await this.#sleep(calm, signal);
      return;
    }
    this.#failures++;
    let retryAfter = 0; let delay: number;
    if (error instanceof WorkerRequestError && (error.fenced || error.code === "not_connected")) this.#o.client.forgetSession();
    if (error instanceof WorkerRequestError && error.code === "rate_limited") retryAfter = 1000;
    // Refused outright: the longest wait, with a spread so hosts refused together do not return together.
    if (error instanceof WorkerRequestError && (error.code === "protocol_unsupported" || error.status === 426 || error.status === 401 || error.status === 403)) delay = Math.floor(this.#o.maxBackoffMs * (0.75 + 0.25 * this.#random()));
    else delay = this.backoff(this.#failures, retryAfter);
    this.#o.onTrouble?.({ error, retryInMs: delay, kind });
    await this.#sleep(delay, signal);
  }
}

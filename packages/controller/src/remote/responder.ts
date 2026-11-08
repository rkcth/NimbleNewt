import type { RemoteWorkspaceAnswer, WorkspaceAsk } from "./protocol.js";
import type { RemoteWorkerClient } from "./client.js";
import type { WorkspacePort } from "../workspace-ops/workspace-ops.js";

/**
 * The remote worker's side of workspace requests (card H12m): takes the requests the poller read, hands each to the host's workspace port (the worker package's `WorkspaceHost.run`) in the background, and sends the answer back.
 * A request already being carried out here is not started twice (the poll lists it until it is answered); an answer that could not be sent is kept and sent again at the next listing, without running the request again. The
 * port itself carries a request ID out once (its journal), so a restart of this process between the work and the answer gives the same recorded answer, not a second run. Requests are run one after another.
 */
export class WorkspaceResponder {
  readonly #client: Pick<RemoteWorkerClient, "answerWorkspace">;
  readonly #port: WorkspacePort;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #running = new Set<string>();
  readonly #unsent = new Map<string, RemoteWorkspaceAnswer>();
  readonly #withdrawn = new Set<string>();
  readonly #now: () => number;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: { readonly client: Pick<RemoteWorkerClient, "answerWorkspace">; readonly port: WorkspacePort; readonly onError?: (error: unknown) => void; readonly now?: () => number }) {
    this.#now = options.now ?? Date.now;
    this.#client = options.client; this.#port = options.port; this.#onError = options.onError;
  }

  /** Starts the requests not already in hand and returns at once. */
  handle(requests: readonly WorkspaceAsk[], withdrawn: readonly string[] = []): void {
    // A request the controller gave up on is dropped if it has not started; one already running cannot be stopped here, and its answer is accepted and dropped there.
    for (const id of withdrawn) { this.#withdrawn.add(id); this.#unsent.delete(id); }
    if (this.#withdrawn.size > 500) this.#withdrawn.delete(this.#withdrawn.values().next().value as string);
    for (const ask of requests) {
      const unsent = this.#unsent.get(ask.requestId);
      if (unsent !== undefined) { void this.#send(ask.requestId, unsent); continue; }
      if (this.#running.has(ask.requestId) || this.#withdrawn.has(ask.requestId)) continue;
      this.#running.add(ask.requestId);
      this.#tail = this.#tail.then(() => this.#carryOut(ask), () => this.#carryOut(ask));
    }
  }

  /** Waits until everything handed in so far has been answered or has failed (for tests and for a clean stop). */
  async idle(): Promise<void> { await this.#tail; }

  async #carryOut(ask: WorkspaceAsk): Promise<void> {
    let answer: RemoteWorkspaceAnswer;
    // Waiting behind a long request is where a request goes stale: the controller may have stopped waiting and freed the agent meanwhile. The host checks the deadline again before it starts.
    if (this.#withdrawn.has(ask.requestId)) { this.#running.delete(ask.requestId); return; }
    if (ask.expiresAt !== undefined && this.#now() >= Date.parse(ask.expiresAt)) { this.#running.delete(ask.requestId); return; }
    try { answer = await this.#port.run({ ...ask, quietAttempts: [...ask.quietAttempts] }); } catch (error) {
      // The work may be half done: this is told as a failure (`failed`, recorded as such by the controller, never as a clean refusal), and the port's journal refuses to run the request again.
      answer = { ok: false, reason: `the host could not finish the request and may have done part of it: ${String((error as Error)?.message ?? error).slice(0, 300)}`, failed: true };
    }
    await this.#send(ask.requestId, answer);
    this.#running.delete(ask.requestId);
  }

  async #send(requestId: string, answer: RemoteWorkspaceAnswer): Promise<void> {
    try { await this.#client.answerWorkspace(requestId, answer); this.#unsent.delete(requestId); } catch (error) {
      this.#unsent.set(requestId, answer);
      if (this.#unsent.size > 100) this.#unsent.delete(this.#unsent.keys().next().value as string);
      this.#onError?.(error);
    }
  }
}

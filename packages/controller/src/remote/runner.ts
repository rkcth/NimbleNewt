import type { WorkOrder, WorkerHandle, WorkerHost, WorkerTurnResult } from "../dispatch/ports.js";
import { ModelStreamRefused, type ModelStreamTap } from "../dispatch/model-stream.js";
import type { JsonObject } from "../storage/types.js";
import type { RemoteAttempt, RemoteWorkerClient } from "./client.js";
import { WorkerRequestError } from "./client.js";
import type { WorkerAbilities } from "./contract.js";
import type { Offer, SequencedControl } from "./protocol.js";

export interface RemoteOfferRunnerOptions {
  /** The worker's session with the controller (connected by the host's poller). */
  readonly client: Pick<RemoteWorkerClient, "attempt">;
  /**
   * What starts an order in this machine's sandbox: a host that runs the agent's process confined (the worker package's launcher and Pi, behind `LocalWorker`). The model relay it is built with takes this runner's `tap(attemptId)` as the
   * `stream` of each attempt's relay, so every model call the process makes is recorded by the controller through the protocol (card L05d).
   */
  readonly host: Pick<WorkerHost, "start">;
  /** What the worker enforces itself, for the dispatch contract's confirmation. */
  readonly abilities: WorkerAbilities;
  /** The time put on the confirmation (default now). */
  readonly now?: () => string;
  /** The gap between looks at the controller's control messages while the turn runs, in ms (default 500). */
  readonly controlMs?: number;
  /** The worker's batching for the stream messages (defaults 250 ms and 4000 characters; `batchMs: 0` sends every piece). */
  readonly stream?: { readonly batchMs?: number; readonly batchChars?: number };
  /** Told about a trouble that does not end the attempt (a control message that failed, a checkpoint that could not be sent). */
  readonly onTrouble?: (attemptId: string, what: string, error: unknown) => void;
}

/** How an offer ended for this worker. */
export type OfferOutcome = "completed" | "refused" | "fenced" | "failed";

/**
 * The remote worker host's side of one offer (card L05d): it takes the offer up, confirms the dispatch contract, starts the order in the machine's sandbox, runs the turn through the attempt as its tool gateway, follows the controller's
 * control messages (tell, checkpoint, restart, stop) while it runs and sends the result. The model calls of the agent's process go through the machine's own relay, and the relay's `stream` is this runner's `tap`, which is the attempt's
 * protocol tap (`RemoteAttempt.streamTap`): the controller records every reply as a revision-bound generation and may hold a late reply back, exactly as for a local worker. The runner never decides anything the controller decides: a fenced
 * answer to any message ends the attempt here (the work is dropped, the sandbox stopped).
 */
export class RemoteOfferRunner {
  readonly #o: RemoteOfferRunnerOptions;
  readonly #live = new Map<string, { readonly attempt: RemoteAttempt; tap?: ModelStreamTap }>();

  constructor(options: RemoteOfferRunnerOptions) { this.#o = options; }

  /** The attempts this runner is running now. */
  get running(): readonly string[] { return [...this.#live.keys()]; }

  /**
   * The recorder of the model calls of an attempt this runner is running, for the relay's `stream`. An attempt it does not run (or no longer runs) gets a tap that refuses the call before it is sent: no model call goes out that could not
   * be bound to a revision.
   */
  tap(attemptId: string): ModelStreamTap {
    return {
      started: async (call) => {
        const live = this.#live.get(attemptId);
        if (live === undefined) throw new ModelStreamRefused(`attempt ${attemptId} is not running on this worker; the model call is not sent`);
        live.tap ??= live.attempt.streamTap(this.#o.stream ?? {});
        return live.tap.started(call);
      },
    };
  }

  /** Runs one offer to its end. Never throws for the attempt's own failures: they are reported to the controller as the result; a fenced attempt is dropped. */
  async run(offer: Offer): Promise<OfferOutcome> {
    const order = offer.order;
    const attempt = this.#o.client.attempt(order.attemptId, offer.placement);
    this.#live.set(order.attemptId, { attempt });
    let handle: WorkerHandle | undefined;
    const trouble = (what: string, error: unknown): void => { try { this.#o.onTrouble?.(order.attemptId, what, error); } catch { /* ignored */ } };
    try {
      await attempt.accept();
      const honored = await attempt.honorContract(order, this.#o.abilities, this.#o.now?.() ?? new Date().toISOString());
      if (!honored.ok) return "refused";
      try { handle = await this.#o.host.start(order); } catch (error) {
        await attempt.complete({ status: "failed", error: `the worker could not start the order: ${String((error as Error)?.message ?? error).slice(0, 400)}` });
        return "failed";
      }
      const running = handle;
      let over = false;
      const control = this.#follow(attempt, order, running, () => over, trouble);
      let result: WorkerTurnResult;
      try { result = await running.run(attempt); } catch (error) {
        if (error instanceof WorkerRequestError && error.fenced) throw error;
        result = { status: "failed", error: `the worker broke: ${String((error as Error)?.message ?? error).slice(0, 400)}` };
      } finally { over = true; await control; }
      let checkpoint: JsonObject | undefined;
      try { checkpoint = await running.checkpoint(); } catch (error) { trouble("final checkpoint", error); }
      await attempt.complete({ ...result, ...(checkpoint === undefined || result.checkpoint !== undefined ? {} : { checkpoint }) });
      return "completed";
    } catch (error) {
      if (error instanceof WorkerRequestError && (error.fenced || error.code === "not_connected")) return "fenced";
      trouble("offer", error);
      return "failed";
    } finally {
      this.#live.delete(order.attemptId);
      if (handle !== undefined) await handle.stop().catch((error) => trouble("stop", error));
    }
  }

  /** Reads the controller's control messages while the turn runs and acts on them in order. Ends when the turn is over. */
  async #follow(attempt: RemoteAttempt, order: WorkOrder, handle: WorkerHandle, over: () => boolean, trouble: (what: string, error: unknown) => void): Promise<void> {
    let after = 0;
    let checkpoints = 0;
    // A restart that changes what the sandbox reaches or the limits it runs under is confirmed to the controller again before the new sandbox starts (card H12a).
    let held = order.contract === undefined ? undefined : { digest: order.contract.digest, recipe: order.recipe };
    while (!over()) {
      let messages: SequencedControl[] = [];
      try { messages = await attempt.pollControl(after); } catch (error) {
        if (error instanceof WorkerRequestError && error.fenced) { await handle.stop().catch(() => undefined); return; }
        trouble("control poll", error);
      }
      if (held !== undefined && order.contract !== undefined && messages.some((m) => m.kind === "restart")) {
        try {
          const confirmed = await attempt.confirmRestarts(messages, held, order.contract, this.#o.abilities);
          if (confirmed.refused !== undefined) { trouble("restart confirmation", new Error(confirmed.refused.join("; "))); await handle.stop().catch(() => undefined); return; }
          held = { digest: confirmed.digest, recipe: confirmed.recipe };
        } catch (error) { trouble("restart confirmation", error); }
      }
      for (const m of messages) {
        after = Math.max(after, m.seq);
        try {
          if (m.kind === "tell") await handle.tell?.(m.text);
          else if (m.kind === "stop") { await handle.stop(); return; }
          else if (m.kind === "checkpoint") await attempt.putCheckpoint(++checkpoints, await handle.checkpoint() as never, `checkpoint-${m.seq}`);
          else if (m.kind === "restart") await handle.restart(m.recipe, m.checkpoint);
        } catch (error) { trouble(`control ${m.kind}`, error); }
      }
      if (!over()) await new Promise((r) => setTimeout(r, this.#o.controlMs ?? 500));
    }
  }
}

import type { WorkOrder, WorkerHandle, WorkerHost, WorkerTurnResult } from "../dispatch/ports.js";
import { ModelStreamRefused, type ModelStreamTap } from "../dispatch/model-stream.js";
import type { JsonObject } from "../storage/types.js";
import type { RemoteAttempt, RemoteWorkerClient } from "./client.js";
import { WorkerRequestError } from "./client.js";
import type { WorkerAbilities } from "./contract.js";
import { cleanProcessRef } from "./process-ref.js";
import { REMOTE_LIMITS, type Offer, type ProcessReport, type SequencedControl, type ThinkingWire, type ToolBridgeAnswer, type ToolBridgeRequest } from "./protocol.js";

/** The processes of one attempt as this machine's sandbox lists them, the entries a report to the controller carries (card L02e). */
type Held = ProcessReport["processes"];
type Entry = Held[number];

export interface RemoteOfferRunnerOptions {
  /** The worker's session with the controller (connected by the host's poller). */
  readonly client: Pick<RemoteWorkerClient, "attempt">;
  /**
   * What starts an order in this machine's sandbox: a host that runs the agent's process confined (the worker package's launcher and Pi, behind `LocalWorker`). The model relay it is built with takes this runner's `tap(attemptId)` as the
   * `stream` of each attempt's relay, so every model call the process makes is recorded by the controller through the protocol (card L05d).
   */
  readonly host: Pick<WorkerHost, "start"> & Partial<Pick<WorkerHost, "localWork">>;
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
  readonly #live = new Map<string, { readonly attempt: RemoteAttempt; tap?: ModelStreamTap; handle?: WorkerHandle; noThinking?: true }>();

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

  /**
   * The machine's tool bridge for an attempt this runner is running (card L05e): what the agent process's tool request is answered with. The request goes to the controller's own bridge through the attempt (`RemoteAttempt.toolBridge`), so a
   * write is admitted on the controller's generation check and effect ledger, a call ID asked again is the same call, and a stale placement or session is fenced. An attempt this runner does not run (or no longer runs) is refused as an answer,
   * not sent: the process of an ended attempt reaches nothing. A controller that cannot be reached is an answer too (`unavailable`): the extension may ask again with the same call ID.
   */
  async bridge(attemptId: string, token: string, request: ToolBridgeRequest): Promise<ToolBridgeAnswer> {
    const live = this.#live.get(attemptId);
    if (live === undefined) return { ok: false, code: "fenced", message: `attempt ${attemptId} is not running on this worker; the request is not sent` };
    try { return await live.attempt.toolBridge(token, request); } catch (error) {
      if (error instanceof WorkerRequestError) {
        if (error.fenced) return { ok: false, code: "fenced", message: "the controller no longer accepts this attempt; its requests are refused" };
        if (error.status === 0 || error.status >= 500) return { ok: false, code: "unavailable", message: "the controller could not be reached; ask again" };
        return { ok: false, code: error.code === "error" ? "invalid_command" : error.code, message: error.message.slice(0, 300) };
      }
      return { ok: false, code: "unavailable", message: "the controller could not be reached; ask again" };
    }
  }

  /**
   * The model's thinking the agent process of an attempt this runner is running reported (card U09c): sent to the controller's thinking store through the attempt. It is told, not asked: it never throws and never changes the turn. A report for an
   * attempt this runner does not run is dropped; a controller that has no such route (an older one: 404/405, or its refusal of the `blocks` field), or that fenced the attempt, is not asked again for this attempt (said once, without any text); any other
   * failure (the connection, a busy controller) drops that message only. The text is untrusted and is in no log line and no error made here.
   */
  async thinking(attemptId: string, blocks: readonly ThinkingWire[]): Promise<void> {
    const live = this.#live.get(attemptId);
    if (live === undefined || live.noThinking === true || blocks.length === 0) return;
    try { await live.attempt.thinking(blocks); } catch (error) {
      // An older controller refuses the route's body ("blocks is not a field of this message") or does not know the route (404/405): it is not asked again. Any other refusal (400) is of that one message, which is dropped alone.
      if (error instanceof WorkerRequestError && (error.fenced || error.status === 404 || error.status === 405 || (error.status === 400 && error.code === "invalid_command" && error.message.startsWith("blocks is not a field")))) {
        live.noThinking = true;
        try { this.#o.onTrouble?.(attemptId, "thinking report", new Error(error.fenced ? "the attempt is fenced" : `the controller does not take thinking reports (${error.status})`)); } catch { /* ignored */ }
      }
    }
  }

  /**
   * Acts on the controller's verdict for an attempt this worker holds after a reconnect (card H09b, the recovery handshake): `stop` ends the sandbox (the controller moved or ended the attempt), `reaccept` takes the attempt up again in the
   * new session. Any other verdict (`hold`, `pending`, `unknown`) changes nothing here: the attempt goes on or waits. An attempt this runner does not run is ignored. Never throws for a connection trouble: the poller asks again.
   */
  async verdict(attemptId: string, verdict: "stop" | "hold" | "reaccept" | "pending" | "unknown"): Promise<void> {
    const live = this.#live.get(attemptId);
    if (live === undefined) return;
    if (verdict === "stop") await live.handle?.stop().catch((error) => this.#o.onTrouble?.(attemptId, "stop", error));
    else if (verdict === "reaccept") await live.attempt.accept().catch((error) => this.#o.onTrouble?.(attemptId, "reaccept", error));
  }

  /** Runs one offer to its end. Never throws for the attempt's own failures: they are reported to the controller as the result; a fenced attempt is dropped. */
  async run(offer: Offer): Promise<OfferOutcome> {
    const order = offer.order;
    const attempt = this.#o.client.attempt(order.attemptId, offer.placement);
    this.#live.set(order.attemptId, { attempt });
    let handle: WorkerHandle | undefined;
    const trouble = (what: string, error: unknown): void => { try { this.#o.onTrouble?.(order.attemptId, what, error); } catch { /* ignored */ } };
    const reporter = this.#reporter(attempt, order.attemptId, trouble);
    try {
      await attempt.accept();
      const honored = await attempt.honorContract(order, this.#o.abilities, this.#o.now?.() ?? new Date().toISOString());
      if (!honored.ok) return "refused";
      try { handle = await this.#o.host.start(order); } catch (error) {
        await attempt.complete({ status: "failed", error: `the worker could not start the order: ${String((error as Error)?.message ?? error).slice(0, 400)}` });
        return "failed";
      }
      const running = handle;
      const entry = this.#live.get(order.attemptId); if (entry !== undefined) entry.handle = running;
      let over = false;
      const control = this.#follow(attempt, order, running, () => over, trouble, reporter);
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
      if (handle !== undefined) {
        await handle.stop().catch((error) => trouble("stop", error));
        // The worker's last word on the attempt (card L02e): the sandbox was stopped and looked at again; what it still lists (normally nothing) is what is left. Never throws: a report that cannot be made leaves the earlier one standing, unconfirmed.
        await reporter.final();
      }
    }
  }

  /**
   * The worker's report of the processes it holds for an attempt (card L02e): the host's own look at its sandboxes (`localWork`), sent to the controller when it differs from what was sent last, and once more, marked final, after the sandbox was
   * stopped. A host that cannot look reports nothing (the controller then reads a live placement as unknown, as it always did). The sequence rises with every report; a report the controller already has a newer one for is ignored there.
   */
  #reporter(attempt: RemoteAttempt, attemptId: string, trouble: (what: string, error: unknown) => void): { change(): Promise<void>; final(): Promise<void> } {
    const look = this.#o.host.localWork?.bind(this.#o.host);
    let seq = 0;
    let sent: string | undefined;
    const held = async (): Promise<Held | undefined> => {
      if (look === undefined) return undefined;
      const found = await look([attemptId]);
      const own = found.processes.filter((p) => p.attemptId === undefined || p.attemptId === attemptId);
      // Each reference is redacted while whole, cleaned and cut here (`cleanProcessRef`); the controller does it again on what it is sent.
      const items: Entry[] = own.slice(0, REMOTE_LIMITS.processes).map((p) => ({ ref: cleanProcessRef(String(p.ref)), kind: p.kind, state: p.state }));
      // More than a report holds, or more than fits the controller's body limit (review of L02e: 50 long command lines were over it, so every report was refused whole): the rest is said as one more entry, never dropped silently.
      const fits = (list: Held): boolean => Buffer.byteLength(JSON.stringify({ placement: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER, final: false, processes: list }), "utf8") <= REMOTE_LIMITS.processBytes;
      const upTo = (n: number): Held => (n >= own.length ? items.slice(0, n) : [...items.slice(0, n), { ref: `${own.length - n} more processes are not listed`, kind: "process", state: "unknown" }]);
      let shown = own.length > REMOTE_LIMITS.processes ? REMOTE_LIMITS.processes - 1 : own.length;
      while (shown > 0 && !fits(upTo(shown))) shown -= 1;
      return upTo(shown);
    };
    return {
      change: async () => {
        try {
          const items = await held();
          if (items === undefined) return;
          const key = JSON.stringify(items);
          if (key === sent) return;
          // The number is taken before the report goes out (review of L02e): a report whose answer was lost may have arrived, and its number must never carry other figures, or the controller refuses every later report, the final one too.
          seq += 1;
          await attempt.reportProcesses({ seq, final: false, processes: items });
          sent = key;
        } catch (error) { if (error instanceof WorkerRequestError && error.fenced) throw error; trouble("process report", error); }
      },
      final: async () => {
        try {
          const items = await held();
          if (items === undefined) return;
          seq += 1;
          // The last word is tried three times under one number (the same report again is the same answer there): one lost connection would otherwise leave the earlier report standing, unconfirmed, for good.
          for (let tries = 1; ; tries += 1) {
            try { await attempt.reportProcesses({ seq, final: true, processes: items }); return; } catch (error) {
              if (tries >= 3 || (error instanceof WorkerRequestError && (error.fenced || error.status < 500))) throw error;
              await new Promise((r) => setTimeout(r, this.#o.controlMs ?? 500));
            }
          }
        } catch (error) { trouble("final process report", error); }
      },
    };
  }

  /** Reads the controller's control messages while the turn runs and acts on them in order. Ends when the turn is over. */
  async #follow(attempt: RemoteAttempt, order: WorkOrder, handle: WorkerHandle, over: () => boolean, trouble: (what: string, error: unknown) => void, reporter: { change(): Promise<void> }): Promise<void> {
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
        } catch (error) {
          trouble("restart confirmation", error);
          if (error instanceof WorkerRequestError && error.fenced) { await handle.stop().catch(() => undefined); return; }
          // Not confirmed: nothing of this batch is applied (a restart would start a sandbox the controller has not agreed to). The same messages are read again at the next look; each confirmation is keyed by its message.
          if (!over()) await new Promise((r) => setTimeout(r, this.#o.controlMs ?? 500));
          continue;
        }
      }
      try { await reporter.change(); } catch (error) { if (error instanceof WorkerRequestError && error.fenced) { await handle.stop().catch(() => undefined); return; } trouble("process report", error); }
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

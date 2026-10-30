import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { Storage } from "@earendil-works/pi-durable";
import { ChannelError, LineDecoder, WORKER_CHANNEL_VERSION, encodeMessage, parseToChild, requestId, type ChannelStart, type FromChild, type ToChild } from "@nimblenewt/contracts";
import { PiAdapter } from "../adapter.js";
import type { AdapterContextPolicy } from "../context-policy.js";
import { boundTransport, composeTools, createBridge, type Bridge, type BridgeReply } from "../bridge.js";
import { volatileContext } from "../prompt-layout.js";
import { relayFetch } from "./relay-fetch.js";

/**
 * The worker process (card H12b): the Pi conversation of one attempt, run inside the sandbox. It has no network and holds only the task credential it is started with. Its whole connection to the world is the channel on standard input and
 * output (`@nimblenewt/contracts`, worker-channel): the bridge requests of the protected tool bridge go out with the credential and are answered by the controller's execution service; the model's calls go out as relay requests and are made by
 * the host, which keeps the provider's credential. It loads nothing of the controller.
 */

export interface WorkerIo {
  /** What the host writes, in any chunking. */
  readonly input: AsyncIterable<Buffer | string>;
  write(text: string): void;
}

export interface WorkerHooks {
  /** The models for the attempt. Default: one provider whose model calls go through the relay (`fetch`). Tests give a scripted one. */
  readonly models?: (start: ChannelStart, fetch: typeof globalThis.fetch) => Promise<Models> | Models;
  readonly storage?: (directory: string) => Promise<Storage> | Storage;
}

/** The Pi API implementations the process can speak, loaded when a route names one. */
const APIS: Readonly<Record<string, () => Promise<{ stream: unknown; streamSimple: unknown }>>> = {
  "openai-completions": () => import("@earendil-works/pi-ai/api/openai-completions") as never,
  "anthropic-messages": () => import("@earendil-works/pi-ai/api/anthropic-messages") as never,
};

async function relayModels(start: ChannelStart): Promise<Models> {
  const load = Object.hasOwn(APIS, start.model.api) ? APIS[start.model.api] : undefined;
  if (load === undefined) throw new ChannelError(`the process cannot speak ${start.model.api.slice(0, 40)}`);
  const api = await load();
  const baseUrl = `${start.relayBase.replace(/\/+$/, "")}/${start.model.alias}`;
  const models = createModels();
  models.setProvider(createProvider({
    id: start.model.provider, baseUrl,
    // The relay adds the real credential; this placeholder only satisfies the SDK.
    auth: { apiKey: { name: "relay", resolve: async () => ({ auth: { apiKey: "relay" } }) } },
    models: [{ id: start.model.modelId, name: start.model.modelId, api: start.model.api, provider: start.model.provider, baseUrl, reasoning: start.model.reasoning, input: [...start.model.input], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: start.model.contextWindow, maxTokens: start.model.maxTokens }],
    api: api as never,
  } as never));
  return models;
}

/** The longest extract the process keeps of a conversation it must compact without asking the model. */
const EXTRACT_CHARS = 6000;

/**
 * Pi's context settings for what the host asked (card C07b). The extractive summary is the fallback for a model that has no room left to summarise: the start of what is replaced (the task and the first decisions) and its end (where the work
 * stands), cut to a bound, and it says plainly that it is an extract. It cannot hang, so the hook's ceiling is only a second guard.
 */
export function contextPolicyOf(context: ChannelStart["context"]): AdapterContextPolicy | undefined {
  if (context === undefined) return undefined;
  const extractive = context.compaction?.fallback === "extractive";
  return {
    ...(context.streamTimeoutMs === undefined ? {} : { streamTimeoutMs: context.streamTimeoutMs }),
    ...(context.streamMaxRetries === undefined ? {} : { streamMaxRetries: context.streamMaxRetries }),
    ...(context.toolOutputBytes === undefined ? {} : { toolOutputBytes: context.toolOutputBytes }),
    ...(context.toolOutputLines === undefined ? {} : { toolOutputLines: context.toolOutputLines }),
    ...(context.compaction?.timeoutMs === undefined ? {} : { beforeCompactTimeoutMs: context.compaction.timeoutMs }),
    ...(extractive ? {
      beforeCompact: async (request) => {
        const text = request.text;
        const head = Math.floor(EXTRACT_CHARS / 3);
        // A cut never falls inside a surrogate pair (the summary is stored as text and a lone half would be refused).
        const isLow = (at: number): boolean => { const c = text.charCodeAt(at); return c >= 0xdc00 && c <= 0xdfff; };
        const headEnd = head > 0 && isLow(head) ? head - 1 : head;
        let tailStart = text.length - (EXTRACT_CHARS - head);
        if (tailStart < text.length && isLow(tailStart)) tailStart += 1;
        const body = text.length <= EXTRACT_CHARS ? text : `${text.slice(0, headEnd)}\n[… ${tailStart - headEnd} characters left out …]\n${text.slice(tailStart)}`;
        return { summary: `Extract of ${request.messageCount} earlier messages (the model was not asked to summarise them; read the task's decisions and hand-off again for anything that is not here):\n${body}` };
      },
      onHookFailure: (error: unknown) => { console.error(`compaction hook failed: ${String((error as Error)?.message ?? error).slice(0, 300)}`); },
    } : {}),
  };
}

/** A rough size of the stored conversation in tokens (three characters to a token, the budget's own estimate), for the resume decision. */
async function contextTokens(adapter: PiAdapter): Promise<number | undefined> {
  // Not known is not zero: the host then has no size to judge and says so.
  try { return Math.ceil((await adapter.root().transcript()).reduce((n, e) => n + e.text.length, 0) / 3); } catch { return undefined; }
}

/** Runs the process until the host closes it or the input ends. Resolves when everything is released. */
export async function runWorker(io: WorkerIo, hooks: WorkerHooks = {}): Promise<void> {
  const send = (message: FromChild): void => io.write(encodeMessage(message));
  let adapter: PiAdapter | undefined;
  let bridge: Bridge | undefined;
  let relay: ReturnType<typeof relayFetch> | undefined;
  let started: ChannelStart | undefined;
  let nextBridge = 0;
  let toolSchemaChars = 0;
  const bridgeWaiting = new Map<number, (reply: BridgeReply) => void>();
  const realFetch = globalThis.fetch;
  let running: Promise<void> | undefined;
  let closed = false;

  const fault = (message: string, id?: number): void => send({ t: "fault", ...(id === undefined ? {} : { id }), message: message.slice(0, 3900) });

  const begin = async (start: ChannelStart): Promise<void> => {
    started = start;
    relay = relayFetch(start.relayBase, send);
    // Whatever Pi's SDK uses to reach the model goes through the relay: nothing in the process can reach anything else.
    globalThis.fetch = relay.fetch;
    const models = await (hooks.models ?? ((s) => relayModels(s)))(start, relay.fetch);
    const storage = await (hooks.storage ?? ((dir) => openNodeJsonlStorage(dir, BACKGROUND_CONTEXT)))(start.storeDir);
    const transport = boundTransport(start.credential, (token, request) => new Promise<BridgeReply>((resolve) => {
      const id = ++nextBridge;
      bridgeWaiting.set(id, resolve);
      send({ t: "bridge", id, token, request: { op: request.op, callId: request.callId, ...(request.args === undefined ? {} : { args: request.args as never }) } });
    }));
    const cache = start.cache === undefined ? undefined : { policy: () => ({ ...(start.cache!.key === undefined ? {} : { key: start.cache!.key }), ...(start.cache!.retention === undefined ? {} : { retention: start.cache!.retention }) }) };
    bridge = createBridge(transport);
    const tools = composeTools(bridge, [], start.namespaceId);
    toolSchemaChars = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length;
    const contextPolicy = contextPolicyOf(start.context);
    adapter = await PiAdapter.open({
      storage, models, model: { provider: start.model.provider, modelId: start.model.modelId },
      tools, ...(cache === undefined ? {} : { cache }), ...(contextPolicy === undefined ? {} : { contextPolicy }),
    });
    // A conversation resumed from the store already used some provider call IDs; the bridge goes on numbering after them.
    try { bridge.seed((await adapter.root().transcript()).flatMap((e) => e.toolCallIds)); } catch { /* a new conversation has none */ }
    send({ t: "ready", v: WORKER_CHANNEL_VERSION, toolSchemaChars });
  };

  const turn = async (requestIdText: string, content: string): Promise<void> => {
    if (adapter === undefined || started === undefined) return fault("the process was not started");
    try {
      // The request opens with a snapshot of the catalogue's declarations, which go to the model in the volatile context after the stable prompt. A tool registered while the request is in flight appears in the next request's snapshot.
      let shown = "";
      try { await bridge!.declarations.openRequest(requestIdText); shown = bridge!.declarations.textOf(requestIdText); } catch { /* the model works without the list; it can still ask tool-discover */ }
      const handle = await adapter.root().submit({ kind: "input", requestId: requestId(requestIdText), content: shown === "" ? content : `${content}\n\n${volatileContext(shown)}` });
      const result = await handle.result();
      if (result.status === "completed") send({ t: "result", status: "completed", text: result.text });
      else if (result.status === "unanswered" && result.reason === "aborted") send({ t: "result", status: "cancelled" });
      else send({ t: "result", status: "failed", error: result.status === "unanswered" ? `the model did not answer (${result.reason}${"detail" in result && typeof result.detail === "string" ? `: ${result.detail}` : ""})` : `the turn ended as ${result.status}` });
    } catch (error) {
      send({ t: "result", status: "failed", error: String((error as Error)?.message ?? error).slice(0, 2000) });
    } finally { bridge?.declarations.closeRequest(requestIdText); }
  };

  const handle = async (message: ToChild): Promise<void> => {
    if (relay?.accept(message) === true) return;
    switch (message.t) {
      case "start":
        if (message.v !== WORKER_CHANNEL_VERSION) return fault(`the channel speaks version ${WORKER_CHANNEL_VERSION}, not ${message.v}`);
        if (started !== undefined) return fault("the process was already started");
        try { await begin(message.start); } catch (error) { fault(`could not start: ${String((error as Error)?.message ?? error)}`); }
        return;
      case "run":
        if (running !== undefined) return send({ t: "result", status: "failed", error: "a turn was already run in this process" });
        running = turn(message.requestId, message.content);
        return;
      case "checkpoint":
        if (adapter === undefined) return fault("the process was not started", message.id);
        try { const checkpoint = JSON.parse(JSON.stringify(await adapter.root().checkpoint())) as never; const tokens = await contextTokens(adapter); send({ t: "checkpoint.ok", id: message.id, checkpoint, ...(tokens === undefined ? {} : { contextTokens: tokens }) }); } catch (error) { fault(`checkpoint failed: ${String((error as Error)?.message ?? error)}`, message.id); }
        return;
      case "tell":
        if (adapter === undefined || started === undefined) return fault("the process was not started", message.id);
        // The host is answered when the update is placed, not when the turn it landed in ends: a turn can run for minutes and the host's pause observation and further messages wait on this answer. What happens to the
        // placed update afterwards is not reported (a fault with no ID would fail the running turn, and one with the ID has no one waiting).
        try {
          const placed = await adapter.root().submit({ kind: "update", requestId: requestId(`tell-${started.attemptId}-${message.id}`), content: message.text, run: false });
          send({ t: "tell.ok", id: message.id });
          void placed.result().catch(() => undefined);
        } catch (error) { fault(`tell failed: ${String((error as Error)?.message ?? error)}`, message.id); }
        return;
      case "compact":
        if (adapter === undefined) return fault("the process was not started", message.id);
        try { await adapter.root().compact(); const tokens = await contextTokens(adapter); send({ t: "compact.ok", id: message.id, ...(tokens === undefined ? {} : { contextTokens: tokens }) }); } catch (error) { fault(`compact failed: ${String((error as Error)?.message ?? error)}`, message.id); }
        return;
      case "bridge.reply": { const waiting = bridgeWaiting.get(message.id); bridgeWaiting.delete(message.id); waiting?.(message.reply as BridgeReply); return; }
      case "close": closed = true; return;
      default: return;
    }
  };

  const decoder = new LineDecoder();
  try {
    for await (const chunk of io.input) {
      for (const raw of decoder.push(chunk)) {
        let message: ToChild;
        try { message = parseToChild(raw); } catch (error) { fault((error as Error).message); continue; }
        // A message is handled in its own turn of the event loop so a long call (the model's) never holds up the channel.
        void handle(message).catch((error) => fault(String((error as Error)?.message ?? error)));
        if (message.t === "close") closed = true;
      }
      if (closed) break;
    }
  } catch (error) {
    if (error instanceof ChannelError) fault(error.message);
  } finally {
    relay?.closeAll("the channel closed");
    for (const resolve of bridgeWaiting.values()) resolve({ ok: false, code: "unavailable", message: "the channel closed" });
    bridgeWaiting.clear();
    await adapter?.close().catch(() => undefined);
    globalThis.fetch = realFetch;
  }
}

import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { Storage } from "@earendil-works/pi-durable";
import { CHECKPOINT_DURABILITY_ERROR, ChannelError, safeText, findAnchors, stripAnchors, verifyAnchor, LeaseWatchdog, LineDecoder, WORKER_CHANNEL_VERSION, encodeMessage, parseToChild, requestId, type ChannelStart, type CheckpointDurability, type FromChild, type LossReason, type ToChild, type WatchdogClock } from "@nimblenewt/contracts";
import { PiAdapter } from "../adapter.js";
import { assertWorkableWindow, compactionThresholds } from "../compaction-thresholds.js";
import type { AdapterContextPolicy } from "../context-policy.js";
import { boundTransport, composeTools, createBridge, type Bridge, type BridgeReply, type BridgeTransport } from "../bridge.js";
import { DEFAULT_MAX_CONTINUATIONS, type ContinuationPolicy } from "../continuation.js";
import { PI_AGENT_LAYOUT, sharedSystemText, volatileContext } from "../prompt-layout.js";
import { processClock } from "./clock.js";
import { classifyTurnEnd } from "./end-kind.js";
import { nudgeCallId, nudgeText } from "./nudge.js";
import { relayFetch } from "./relay-fetch.js";
import { pendingThinking, type ThinkingMark } from "./thinking-report.js";

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
  /** The lease watchdog's seams (card H08b); it runs only when the start carries a lease. Tests give a fake clock, a tick they drive themselves and a `terminate` that does not end the test process. */
  readonly lease?: {
    readonly clock?: WatchdogClock;
    /** Milliseconds between the watchdog's looks at its clocks. Default 1000. 0: no timer (the test calls `onWatchdog` itself). */
    readonly tickMs?: number;
    /** Receives the watchdog so a test can drive it. */
    readonly onWatchdog?: (dog: LeaseWatchdog) => void;
    /** Ends the process after the grace when it has not wound down. Default: the conversation store is closed (bounded, inside the grace) and the process exits with code 75 (`exit`). */
    readonly terminate?: (reason: LossReason) => void;
    /** How the default termination ends the process. Default `process.exit`. */
    readonly exit?: (code: number) => void;
    /** Milliseconds between renewals of the lease (card H08b). Default a third of the lease, at least a second. 0: no timer (the test renews through `onRenew`). */
    readonly renewMs?: number;
    /** Receives the function that sends one renewal now, so a test can drive it. */
    readonly onRenew?: (renewNow: () => void) => void;
  };
}

/** Of the grace after a loss, the share kept for closing the conversation store before the process exits: at most this, and at most a quarter of the grace. */
const TERMINATE_FLUSH_MS = 1000;
/** Renewals sent and not answered that the process remembers (an answer to one it forgot extends nothing). */
const MAX_RENEWALS = 4;

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

/** The share of the model's window that stays verbatim when the conversation is compacted. */
const KEEP_RECENT_SHARE = 0.1;

/** The longest extract the process keeps of a conversation it must compact without asking the model. */
const EXTRACT_CHARS = 6000;

/**
 * Pi's context settings for what the host asked (card C07b). The extractive summary is the fallback for a model that has no room left to summarise: the start of what is replaced (the task and the first decisions) and its end (where the work
 * stands), cut to a bound, and it says plainly that it is an extract. It cannot hang, so the hook's ceiling is only a second guard.
 */
export function contextPolicyOf(context: ChannelStart["context"], onCompacted?: (note: { readonly messageCount: number; readonly summaryChars: number; readonly digest: string }) => void, keptAnchors?: (firstKept: number) => Promise<readonly string[]>): AdapterContextPolicy | undefined {
  if (context === undefined) return undefined;
  const extractive = context.compaction?.fallback === "extractive";
  // The owner's decisions the controller gave the process (card C07q): written after every summary, so a compaction never drops them. Pi's own summariser (no `extractive`) is not given them: its text is the model's.
  const keep = context.compaction?.keep;
  const kept = keep === undefined || keep.lines.length === 0 ? "" : `\n\n${keep.note}\n${keep.lines.map((l) => `- ${l}`).join("\n")}`;
  // Card W12: the controller's goal anchor, put at the top of every summary (replacing the one in the conversation that is summarised, which is taken out of the extract first), so the conversation that goes on holds one.
  const anchorDigest = context.compaction?.anchor === undefined ? undefined : verifyAnchor(context.compaction.anchor.text);
  const anchor = anchorDigest === undefined ? undefined : context.compaction!.anchor!.text;
  return {
    ...(context.streamTimeoutMs === undefined ? {} : { streamTimeoutMs: context.streamTimeoutMs }),
    ...(context.streamMaxRetries === undefined ? {} : { streamMaxRetries: context.streamMaxRetries }),
    ...(context.toolOutputBytes === undefined ? {} : { toolOutputBytes: context.toolOutputBytes }),
    ...(context.toolOutputLines === undefined ? {} : { toolOutputLines: context.toolOutputLines }),
    ...(context.compaction?.timeoutMs === undefined ? {} : { beforeCompactTimeoutMs: context.compaction.timeoutMs }),
    ...(extractive ? {
      beforeCompact: async (request) => {
        // The anchor of the conversation being summarised (the first prompt's, or the last summary's) is not part of what is extracted: the new summary opens with the current one.
        const text = anchor === undefined ? request.text : stripAnchors(request.text);
        const head = Math.floor(EXTRACT_CHARS / 3);
        // A cut never falls inside a surrogate pair (the summary is stored as text and a lone half would be refused).
        const isLow = (at: number): boolean => { const c = text.charCodeAt(at); return c >= 0xdc00 && c <= 0xdfff; };
        const headEnd = head > 0 && isLow(head) ? head - 1 : head;
        let tailStart = text.length - (EXTRACT_CHARS - head);
        if (tailStart < text.length && isLow(tailStart)) tailStart += 1;
        const body = text.length <= EXTRACT_CHARS ? text : `${text.slice(0, headEnd)}\n[… ${tailStart - headEnd} characters left out …]\n${text.slice(tailStart)}`;
        // The part the summary keeps verbatim may already hold this very block (a later input that carried it, because the view did not show it then): the model would read it twice, so the summary leaves it out (W12 review). A
        // store that cannot be read is taken as not holding it.
        let keptHolds = false;
        if (anchorDigest !== undefined && keptAnchors !== undefined && request.firstKept !== undefined) { try { keptHolds = (await keptAnchors(request.firstKept)).includes(anchorDigest); } catch { keptHolds = false; } }
        const summary = `${anchor === undefined || keptHolds ? "" : `${anchor}\n\n`}Extract of ${request.messageCount} earlier messages (the model was not asked to summarise them; read the task's decisions and hand-off again for anything that is not here):\n${body}${kept}`;
        // Card C07q: the controller is told that the process compacted (how much and the summary's digest, not its text), so the compaction takes its place in the task's chain. A failure to tell never changes the compaction.
        try { onCompacted?.({ messageCount: request.messageCount, summaryChars: summary.length, digest: createHash("sha256").update(summary).digest("hex") }); } catch { /* the compaction stands */ }
        return { summary };
      },
      onHookFailure: (error: unknown) => { console.error(`compaction hook failed: ${safeText(error, 300)}`); },
    } : {}),
  };
}

/**
 * The durability check of a checkpoint just taken (card L04d): the conversation's history up to the checkpoint is read from the store again and checked against it (the adapter's own `verifyCheckpoint`: format, runtime,
 * the entry is a completed-turn boundary and the history digests the same). Never throws: a check that could not run is "not verified", with why, so the controller keeps the capture as incomplete instead of resuming from it.
 */
export async function durabilityOf(adapter: Pick<PiAdapter, "verifyCheckpoint">, checkpoint: Parameters<PiAdapter["verifyCheckpoint"]>[0]): Promise<CheckpointDurability> {
  const why = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, CHECKPOINT_DURABILITY_ERROR);
  try {
    const verdict = await adapter.verifyCheckpoint(checkpoint);
    return verdict.valid ? { verified: true } : { verified: false, error: why(`the checkpoint did not read back: ${verdict.reason}: ${safeText(verdict.detail, 500)}`) };
  } catch (error) { return { verified: false, error: why(`the checkpoint could not be read back: ${safeText(error, 1000)}`) }; }
}

/**
 * Card W12: a process that goes on with a conversation another process of the attempt began (a readmit, a wake, a restart) is sent the whole order again, anchor included. When the conversation the model still sees already holds that very
 * block, the copy in the new input is left out, so the model sees one. A request ID that was already used (a restart of the process in the middle of its turn) is sent again exactly as it was first sent, with or without the block, because
 * other content under the same ID is a conflict; that is judged by the ID (`sentBefore`), not by the text, so a new request whose text equals an earlier input still loses its copy (W12 review). A block that differs (the records changed
 * meanwhile) stays: the next summary replaces every block with the current one. Never throws.
 */
export async function withoutShownAnchor(adapter: Pick<PiAdapter, "root">, content: string, digest: string | undefined, sentBefore?: (candidate: string) => Promise<"unused" | "same" | "different">): Promise<string> {
  if (digest === undefined) return content;
  try {
    const mine = findAnchors(content).filter((a) => a.digest === digest);
    if (mine.length === 0) return content;
    let stripped = content;
    for (const a of mine) stripped = stripped.replace(a.text, "");
    stripped = stripped.replace(/^\s+/, "");
    const use = sentBefore === undefined ? "unused" : await sentBefore(content);
    if (use === "same") return content;
    if (use === "different") return (await sentBefore!(stripped)) === "same" ? stripped : content;
    const entries = await adapter.root().transcript();
    let from = 0;
    for (const e of entries) if (e.head !== undefined) from = e.head;
    if (!entries.some((e) => e.id >= from && findAnchors(e.text).some((a) => a.digest === digest))) return content;
    return stripped;
  } catch { return content; }
}

/** The digests of the anchor blocks that check out in the entries from `firstKept` on (what a summary starting there keeps verbatim). */
async function anchorsFrom(adapter: Pick<PiAdapter, "root">, firstKept: number): Promise<string[]> {
  return (await adapter.root().transcript()).filter((e) => e.id >= firstKept).flatMap((e) => findAnchors(e.text).map((a) => a.digest));
}

/** A rough size of the stored conversation in tokens (three characters to a token, the budget's own estimate), for the resume decision. */
async function contextTokens(adapter: PiAdapter): Promise<number | undefined> {
  // Not known is not zero: the host then has no size to judge and says so.
  // Only what the model still sees counts: a compaction (or a reset) moves the start of its view forward, and the entries before it stay in storage but are not sent.
  try {
    const entries = await adapter.root().transcript();
    let from = 0;
    for (const e of entries) if (e.head !== undefined) from = e.head;
    return Math.ceil(entries.reduce((n, e) => n + (e.id >= from ? e.text.length : 0), 0) / 3);
  } catch { return undefined; }
}

/** Pi's stop reason of the conversation's last assistant reply (the turn's answer once it completed); undefined when it cannot be read. */
async function lastStopReason(adapter: PiAdapter): Promise<string | undefined> {
  try {
    const entries = await adapter.root().transcript();
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.role === "assistant") return entries[i]!.stopReason;
  } catch { /* not known: classified from the text alone */ }
  return undefined;
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
  let dog: LeaseWatchdog | undefined;
  let stopTicking: (() => void) | undefined;
  let stopRenewing: (() => void) | undefined;
  let turnOpen = false;
  /** The agent's work.end was accepted in this process (card W04): no turn of it is continued again. Also written to the conversation's continuation document, so a restarted process knows. */
  let workEnded = false;
  /** Renewals in flight: their ID and the monotonic time each was sent at, which is what an answer counts from. */
  const renewing = new Map<number, number>();
  let nextRenewal = 0;
  /** Set while the process asks whether a fenced bridge answer meant the lease is gone: `from` is the first renewal that counts as the answer (one sent after the fenced answer). */
  let checking: { readonly from: number; readonly done: Promise<void>; readonly open: () => void } | undefined;
  const endCheck = (): void => { const c = checking; checking = undefined; c?.open(); };

  const fault = (message: string, id?: number): void => send({ t: "fault", ...(id === undefined ? {} : { id }), message: safeText(message, 3900) });

  /** Authority is gone (card H08b): the turn is aborted, no further call leaves the process, and the reason is the turn's recorded result. */
  const authorityLost = async (reason: LossReason): Promise<void> => {
    relay?.refuse(`the lease ended (${reason})`);
    relay?.closeAll(`the lease ended (${reason})`);
    for (const resolve of bridgeWaiting.values()) resolve({ ok: false, code: "unavailable", message: `the lease ended (${reason})` });
    bridgeWaiting.clear();
    endCheck();
    try { await adapter?.root().abort(); } catch { /* the turn's result below is what is reported */ }
    // A turn that is running reports in its own `finally`-path; with none running the loss is told here. Either way the process is quiet once it has told the host.
    // With none running the loss is told as its own message: an unsolicited `result` has no waiter on the host and would be dropped.
    if (!turnOpen) { send({ t: "lease.lost", reason }); dog?.quiet(); }
  };

  /** Asks the controller, through the host, to extend the lease (card H08b). The send time is kept, so the answer counts from it. Nothing is asked once the lease is gone. */
  const renewNow = (): void => {
    if (dog === undefined || !dog.productive || closed) return;
    if (renewing.size >= MAX_RENEWALS) renewing.delete(renewing.keys().next().value as number);
    const id = ++nextRenewal;
    renewing.set(id, dog.sending());
    send({ t: "lease.renew", id });
  };

  /**
   * The process did not wind down inside the grace (a turn that ignores the abort): it is ended. The conversation store is closed first, so what it holds is flushed, but only for the share of the grace kept for it; then the process exits
   * with code 75 whether or not the close finished.
   */
  const terminate = (reason: LossReason, flushMs: number): void => {
    if (hooks.lease?.terminate !== undefined) return hooks.lease.terminate(reason);
    const exit = hooks.lease?.exit ?? ((code: number): void => { process.exit(code); });
    let ended = false;
    const end = (): void => { if (!ended) { ended = true; clearTimeout(timer); exit(75); } };
    const timer = setTimeout(end, flushMs);
    void Promise.resolve().then(() => adapter?.close()).catch(() => undefined).finally(end);
  };

  const begin = async (start: ChannelStart): Promise<void> => {
    assertWorkableWindow(start.model.contextWindow);
    started = start;
    if (start.lease !== undefined) {
      // The lease counts from now on this process's own monotonic clock: the controller sent a duration, so a wrong wall clock here changes nothing.
      // The termination comes at the end of the grace the host gave: the watchdog's own grace is shorter by the time kept for closing the store.
      const flushMs = Math.min(TERMINATE_FLUSH_MS, Math.floor(start.lease.graceMs / 4));
      dog = new LeaseWatchdog({ clock: hooks.lease?.clock ?? processClock(), maxLeaseMs: start.lease.leaseMs, graceMs: start.lease.graceMs - flushMs, onStop: authorityLost, onTerminate: (reason) => terminate(reason, flushMs) }, start.lease.leaseMs);
      const tickMs = hooks.lease?.tickMs ?? 1000;
      if (tickMs > 0) stopTicking = dog.run(tickMs);
      const renewMs = hooks.lease?.renewMs ?? Math.max(1000, Math.floor(start.lease.leaseMs / 3));
      if (renewMs > 0) { const timer = setInterval(renewNow, renewMs); timer.unref?.(); stopRenewing = () => clearInterval(timer); }
      hooks.lease?.onWatchdog?.(dog);
      hooks.lease?.onRenew?.(renewNow);
    }
    relay = relayFetch(start.relayBase, send);
    // Whatever Pi's SDK uses to reach the model goes through the relay: nothing in the process can reach anything else.
    globalThis.fetch = relay.fetch;
    const models = await (hooks.models ?? ((s) => relayModels(s)))(start, relay.fetch);
    const storage = await (hooks.storage ?? ((dir) => openNodeJsonlStorage(dir, BACKGROUND_CONTEXT)))(start.storeDir);
    const wire = boundTransport(start.credential, async (token, request) => {
      // After a fenced answer no further call leaves until the controller has said whether the lease still holds (or the lease has ended).
      while (checking !== undefined && dog?.productive === true) await checking.done;
      return await new Promise<BridgeReply>((resolve) => {
      // Nothing productive starts once the lease is gone, and the reply says why.
      if (dog !== undefined && !dog.productive) return resolve({ ok: false, code: "unavailable", message: `the lease ended (${dog.reason})` });
      const id = ++nextBridge;
      bridgeWaiting.set(id, resolve);
      send({ t: "bridge", id, token, request: { op: request.op, callId: request.callId, ...(request.args === undefined ? {} : { args: request.args as never }) } });
      });
    });
    // An accepted work.end ends the agent's work (card W04): nothing is continued after it.
    const transport: BridgeTransport = Object.freeze({
      send: async (request: Parameters<BridgeTransport["send"]>[0]): Promise<BridgeReply> => {
        const reply = await wire.send(request);
        if (request.op === "work.end" && reply.ok) { workEnded = true; await adapter?.markWorkEnded().catch(() => undefined); }
        return reply;
      },
    });
    const cache = start.cache === undefined ? undefined : { policy: () => ({ ...(start.cache!.key === undefined ? {} : { key: start.cache!.key }), ...(start.cache!.retention === undefined ? {} : { retention: start.cache!.retention }) }) };
    bridge = createBridge(transport);
    const tools = composeTools(bridge, [], start.namespaceId);
    toolSchemaChars = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length;
    const contextPolicy = contextPolicyOf(start.context, (note) => send({ t: "compacted", ...note }), async (firstKept) => (adapter === undefined ? [] : anchorsFrom(adapter, firstKept)));
    // Card W04: a turn that yields without a tool call and without work.end is continued, at most three times, with a fixed nudge. Each continuation is asked of the controller first (bridge `turn.continue`): a pause, a stop, a replaced or
    // frozen attempt, or a controller that does not know the operation refuses it, and the answer then ends the turn as it ended (W03 takes it from there). Nothing is continued once the lease is gone, the host has closed the process or work.end
    // was accepted.
    const stopped = (): boolean => closed || workEnded || (dog !== undefined && !dog.productive);
    const continuation: ContinuationPolicy = {
      max: DEFAULT_MAX_CONTINUATIONS,
      decide: async (answer, ask) => {
        if (stopped()) return undefined;
        const endKind = classifyTurnEnd({ stopReason: answer.stopReason, visibleText: answer.visibleText, toolCalls: [] }).endKind;
        const reply = await transport.send({ op: "turn.continue", callId: nudgeCallId(ask.turn, ask.n), args: { n: ask.n, max: ask.max, endKind } });
        if (!reply.ok || reply.result["go"] !== true || stopped()) return undefined;
        return nudgeText(answer.stopReason);
      },
      onError: (error) => { console.error(`continuation hook failed: ${safeText(error, 300)}`); },
    };
    adapter = await PiAdapter.open({
      continuation,
      storage, models, model: { provider: start.model.provider, modelId: start.model.modelId },
      // Card W06: every agent this process runs has the fixed completion rules as its system text, the same bytes for every task, role, readmit, wake and restart (so the cached prefix is kept).
      promptLayout: PI_AGENT_LAYOUT,
      tools, ...(cache === undefined ? {} : { cache }), ...(contextPolicy === undefined ? {} : { contextPolicy }),
      // Card CMP: reserve and background thresholds scale with the window (Pi's defaults make the background threshold zero or below under 49,152 tokens); a window under 8,192 is refused.
      // Pi keeps the newest part of a conversation verbatim when it compacts; its default would be larger than a small model's whole startup share, so nothing would ever be cut. A tenth of the window is kept (provisional, card H12f).
      settings: { compaction: { keepRecentTokens: Math.max(500, Math.floor(start.model.contextWindow * KEEP_RECENT_SHARE)), ...compactionThresholds(start.model.contextWindow, start.model.maxTokens) } },
    });
    // Work an earlier process of this attempt left unfinished stays held (Pi refuses to make progress) until the controller has reviewed it; the host says so in the start when it has (a recipe restart, a resume after loss). Interrupted tool calls are not run again:
    // the bridge answers a repeated call from the controller's ledger, and the model sees what happened to them.
    if (start.recover !== undefined) {
      const found = await adapter.interrupted();
      if (found.held) await adapter.recover({ abandon: [], reason: start.recover.reason, decidedBy: "local-worker-restart" });
    }
    // A conversation resumed from the store already used some provider call IDs; the bridge goes on numbering after them.
    try { bridge.seed((await adapter.root().transcript()).flatMap((e) => e.toolCallIds)); } catch { /* a new conversation has none */ }
    // Pi Durable renders no system text of its own; the system prompt is the layout's sections (card W06: the completion rules), measured as Pi renders them.
    send({ t: "ready", v: WORKER_CHANNEL_VERSION, toolSchemaChars, systemPromptChars: sharedSystemText(PI_AGENT_LAYOUT).length });
  };

  let thinkingSent: ThinkingMark = { entryId: -1, block: -1 };
  const turn = async (requestIdText: string, content: string): Promise<void> => {
    if (adapter === undefined || started === undefined) return fault("the process was not started");
    turnOpen = true;
    try {
      if (dog !== undefined) await dog.assertProductive();
      // The request opens with a snapshot of the catalogue's declarations, which go to the model in the volatile context after the stable prompt. A tool registered while the request is in flight appears in the next request's snapshot.
      // The turn's continuation count (card W04) starts here; the same request run again by a restarted process keeps its count.
      await adapter.beginTurn(requestIdText);
      let shown = "";
      try { await bridge!.declarations.openRequest(requestIdText); shown = bridge!.declarations.textOf(requestIdText); } catch { /* the model works without the list; it can still ask tool-discover */ }
      const anchored = started.context?.compaction?.anchor === undefined ? undefined : verifyAnchor(started.context.compaction.anchor.text);
      const withVolatile = (text: string): string => (shown === "" ? text : `${text}\n\n${volatileContext(shown)}`);
      const body = await withoutShownAnchor(adapter, content, anchored, async (candidate) => adapter!.root().requestUse({ kind: "input", requestId: requestId(requestIdText), content: withVolatile(candidate) }));
      const handle = await adapter.root().submit({ kind: "input", requestId: requestId(requestIdText), content: withVolatile(body) });
      const result = await handle.result();
      // Card U09b: the model's thinking returned in this turn is reported to the host (bounded, untrusted text); a failure to report never changes the turn.
      try {
        const next = pendingThinking(await adapter.root().thinking(), thinkingSent);
        thinkingSent = next.sent;
        for (const blocks of next.messages) send({ t: "thinking", blocks });
      } catch { /* the owner's view is shorter; the turn is not */ }
      // How many times the turn was continued (card W04), from the conversation's document; told with every result so the attempt records it.
      let nudges = 0;
      try { const c = await adapter.continuations(); if (c.turn === requestIdText) nudges = c.used; } catch { /* not known: 0 is not claimed as more */ }
      if (dog !== undefined && !dog.productive) send({ t: "result", status: "failed", error: `lease lost (${dog.reason}): the turn was stopped`, nudges });
      else if (result.status === "completed") {
        // How the turn ended (card W02): told with the result, so the controller can tell a full report from a reply cut off at the output limit, one with nothing visible, or a stop without work.end. After continuations (W04) it is the last answer's.
        const ending = classifyTurnEnd({ stopReason: await lastStopReason(adapter), visibleText: result.text, toolCalls: result.toolCalls });
        send({ t: "result", status: "completed", text: result.text, endKind: ending.endKind, visibleChars: ending.visibleChars, nudges });
      }
      else if (result.status === "unanswered" && result.reason === "aborted") send({ t: "result", status: "cancelled", nudges });
      else send({ t: "result", status: "failed", nudges, error: result.status === "unanswered" ? `the model did not answer (${result.reason}${"detail" in result && typeof result.detail === "string" ? `: ${safeText(result.detail, 500)}` : ""})` : `the turn ended as ${result.status}` });
    } catch (error) {
      send({ t: "result", status: "failed", error: dog !== undefined && !dog.productive ? `lease lost (${dog.reason}): the turn was stopped` : safeText(error, 2000) });
    } finally { turnOpen = false; bridge?.declarations.closeRequest(requestIdText); if (dog !== undefined && !dog.productive) dog.quiet(); }
  };

  /** After the lease is gone nothing that could call the model (or change the stored conversation) is done (card H08b3). */
  const lostFault = (id: number): boolean => { if (dog === undefined || dog.productive) return false; fault(`the lease ended (${dog.reason}): refused`, id); return true; };

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
        if (lostFault(message.id)) return;
        try {
          const taken = await adapter.root().checkpoint();
          const checkpoint = JSON.parse(JSON.stringify(taken)) as never;
          const tokens = await contextTokens(adapter);
          // The durability check of card L04d: the history is read back from the store and the checkpoint is checked against it, so "verified" says the store holds what the checkpoint describes.
          const durable = await durabilityOf(adapter, taken);
          send({ t: "checkpoint.ok", id: message.id, checkpoint, ...(tokens === undefined ? {} : { contextTokens: tokens }), durable });
        } catch (error) { fault(`checkpoint failed: ${String((error as Error)?.message ?? error)}`, message.id); }
        return;
      case "tell":
        if (adapter === undefined || started === undefined) return fault("the process was not started", message.id);
        if (lostFault(message.id)) return;
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
        if (lostFault(message.id)) return;
        try { await adapter.root().compact(); const tokens = await contextTokens(adapter); send({ t: "compact.ok", id: message.id, ...(tokens === undefined ? {} : { contextTokens: tokens }) }); } catch (error) { fault(`compact failed: ${String((error as Error)?.message ?? error)}`, message.id); }
        return;
      case "bridge.reply": {
        const waiting = bridgeWaiting.get(message.id); bridgeWaiting.delete(message.id);
        // A fenced answer can mean the attempt was taken away, or only that it is frozen for a while (the bridge says both the same way): the controller is asked at once whether the lease still holds, and its `lease.fenced` stops the work.
        // Until it answers, no further bridge call leaves the process.
        if (!message.reply.ok && message.reply.code === "fenced" && dog?.productive === true && checking === undefined) {
          let open!: () => void;
          const done = new Promise<void>((resolve) => { open = resolve; });
          checking = { from: nextRenewal + 1, done, open };
          renewNow();
        }
        waiting?.(message.reply as BridgeReply);
        return;
      }
      case "lease.ok": {
        const sentAt = renewing.get(message.id); renewing.delete(message.id);
        if (sentAt !== undefined) dog?.renewed(sentAt, message.leaseMs);
        if (sentAt !== undefined && checking !== undefined && message.id >= checking.from) endCheck();
        return;
      }
      case "lease.fenced": renewing.clear(); await dog?.lost(); return;
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
    stopTicking?.();
    stopRenewing?.();
    endCheck();
    relay?.closeAll("the channel closed");
    for (const resolve of bridgeWaiting.values()) resolve({ ok: false, code: "unavailable", message: "the channel closed" });
    bridgeWaiting.clear();
    await adapter?.close().catch(() => undefined);
    globalThis.fetch = realFetch;
  }
}

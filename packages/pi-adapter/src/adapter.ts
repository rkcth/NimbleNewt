import type { AbortReport, AdapterRequest, BranchRequest, RequestId, RetainedRequest, SemanticResult, ToolCallOutcome } from "@nimblenewt/contracts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models, Static, TSchema } from "@earendil-works/pi-ai";
import {
  ConversationBusy, Harness, createRegistry, defineDoc, defineExtension, defineTool,
  type Conversation, type SettledSubmissionRecord, type Storage, type Submission,
} from "@earendil-works/pi-durable";
import { INPUT_KINDS, turnBoundaries } from "./branches.js";
import {
  AlreadyReadmittedError, ConversationBusyError, InvalidBranchPointError, InvalidToolError, NoBranchPointError, NotRetainedError,
  RequestIdConflictError, UnknownCommandError,
} from "./errors.js";
import { fingerprintOf, fingerprintsMatch, mapReason } from "./results.js";
import { assertSupportedRuntime, type RuntimeInfo } from "./runtime.js";

/** Commands the adapter accepts. None exist yet; F06 adds branch, checkpoint and abort commands. */
const SUPPORTED_COMMANDS: readonly string[] = [];

/** What a running tool call can observe about its own invocation. */
export interface AdapterToolContext {
  /** Fires when the request is aborted or the adapter closes; long-running tools should stop promptly. */
  readonly signal: AbortSignal | undefined;
  readonly callId: string;
}

/** A tool the model may call. It returns plain text, which becomes the tool result the next model step sees. */
export interface AdapterTool<T extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  readonly parameters: T;
  /**
   * Declare "safe" only if re-running the tool after a crash cannot repeat an external effect. The default is that an
   * interrupted call is not re-run and the model is told it was interrupted.
   */
  readonly replay?: "safe";
  execute(args: Static<T>, context: AdapterToolContext): Promise<string>;
}

export interface PiAdapterOptions {
  readonly storage: Storage;
  readonly models: Models;
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly tools?: readonly AdapterTool[];
  /** Pi Durable harness settings, for example compaction thresholds. */
  readonly settings?: NonNullable<Parameters<typeof Harness.open>[1]["settings"]>;
  /** Receives Pi Durable's non-fatal reports (for example a throwing listener). */
  readonly onReport?: (error: unknown) => void;
  /** Override runtime detection; for tests of the unsupported-runtime path. */
  readonly runtime?: RuntimeInfo;
}

export interface SubmissionHandle {
  readonly requestId: RequestId;
  /** Pi's durable submission ID. Equal for every submit of the same request ID. */
  readonly submissionId: number;
  /**
   * Waits for the request to settle and returns its semantic result. The result is recorded durably the first time it
   * is built and every later call, including after compaction or a restart, returns that same record.
   */
  result(): Promise<SemanticResult>;
}

/** Adapter-owned durable record per request ID, kept in a Pi document committed with the transcript. */
interface RequestRecord {
  /** Absent only for a result recorded without a prior claim; an absent fingerprint matches any payload. */
  fingerprint?: string;
  /** The submitted request, kept until its result is recorded (and while it is retained) so it can be readmitted. */
  request?: RetainedRequest["request"];
  /** Set once a retained request has been readmitted, under this new request ID. */
  readmittedAs?: string;
  result?: SemanticResult;
}
/** A branch created for a request ID: the child conversation and the entry it forked after. */
interface BranchRecord {
  childId: number;
  forkedAt: number;
}
interface RequestsState {
  requests: Record<string, RequestRecord>;
  branches?: Record<string, BranchRecord>;
}

/** One entry of a conversation's history, as the adapter exposes it for inspection. */
export interface TranscriptEntry {
  readonly id: number;
  readonly kind: string;
  /** Role of the entry's first model message, if it has one. */
  readonly role: string | undefined;
  /** Text of that message. */
  readonly text: string;
  /** Why the message ended (assistant messages), for example `stop`, `toolUse` or `aborted`. */
  readonly stopReason: string | undefined;
  /** IDs of the tool calls the message makes (assistant messages). */
  readonly toolCallIds: readonly string[];
  /** Application data attached to the entry (for example an update's source). */
  readonly data: unknown;
}

/** A side conversation created from a task's context. */
export interface AdapterBranch {
  readonly conversation: AdapterConversation;
  /** The parent entry the branch forked after; the branch's context is the parent's as of this entry. */
  readonly forkedAt: number;
}

/** Thrown inside the fork's creating commit to roll it back when another call already created this branch. */
class BranchAlreadyExists extends Error {}

const Requests = defineDoc<RequestsState & Record<string, never>>({
  kind: "nimblenewt.requests",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ requests: {} }) as unknown as RequestsState & Record<string, never>,
});

interface EntryLike {
  readonly id: number;
  readonly kind: string;
  readonly model?: readonly unknown[];
  readonly data?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("");
}

function callIdsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: unknown) => {
    const p = part as { type?: string; id?: string } | null;
    return p !== null && typeof p === "object" && p.type === "toolCall" && typeof p.id === "string" ? [p.id] : [];
  });
}

function firstMessage(entry: EntryLike): { content?: unknown } {
  return (entry.model?.[0] ?? {}) as { content?: unknown };
}

function toolOutcome(entry: EntryLike): ToolCallOutcome {
  const message = firstMessage(entry) as { toolName?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown };
  const name = String(message.toolName ?? "");
  const callId = String(message.toolCallId ?? "");
  const diagnostics = (entry.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? [];
  if (diagnostics.some((d) => d.code === "tool_unavailable")) return { callId, name, status: "unknown_tool" };
  return { callId, name, status: message.isError === true ? "error" : "ok", output: textOf(message.content) };
}

/** One Pi conversation: the root task conversation now, inquiry branches and task contexts from F06b. */
export class AdapterConversation {
  /** @internal Use `PiAdapter.root()` or `PiAdapter.conversation()`. */
  constructor(private readonly harness: Harness, private readonly conversation: Conversation, private readonly storage: Storage) {}

  get id(): number {
    return this.conversation.id;
  }

  /**
   * Admit a request. Submitting the same request ID again returns the original submission and result; reusing it with
   * different content or busy policy throws RequestIdConflictError, including while the original is still queued or
   * after compaction.
   */
  async submit(request: AdapterRequest): Promise<SubmissionHandle> {
    if (request.kind === "command") throw new UnknownCommandError(request.name, SUPPORTED_COMMANDS);
    // Record the payload fingerprint before admission: a crash in between leaves a record for the same payload to retry.
    const created = await this.claim(request, fingerprintOf(request));
    let submission: Submission;
    try {
      submission = await this.conversation.submit(
        {
          type: "input",
          content: request.content,
          requestId: request.requestId,
          ...(request.whenBusy === undefined ? {} : { whenBusy: request.whenBusy }),
          // An update is placed as its own kind of entry, so provenance is in the transcript; the model still sees the text.
          ...(request.kind === "update" ? { entry: { kind: "nimblenewt.update", data: { source: request.source === undefined ? null : { conversationId: request.source.conversationId, entryId: request.source.entryId } } } } : {}),
        },
        context,
      );
    } catch (error) {
      if (error instanceof ConversationBusy) {
        // A rejected request was never admitted, so it must not keep the request ID reserved for this payload.
        if (created) await this.release(request.requestId);
        throw new ConversationBusyError(this.id);
      }
      throw error;
    }
    return { requestId: request.requestId, submissionId: submission.id, result: () => this.resultOf(request.requestId, submission) };
  }

  /**
   * Create a side conversation from this task's context, for an inquiry that must not disturb the task. The branch sees
   * the parent's history up to a completed-turn boundary (by default the latest), shares nothing afterwards, and leaves
   * the parent untouched. Idempotent by request ID: repeating the request returns the same branch. A turn still in
   * progress is not part of the branch, because forking inside it would leave a tool call without its result.
   */
  async branch(request: BranchRequest): Promise<AdapterBranch> {
    const id = request.requestId;
    const existing = await this.branchRecord(id);
    if (existing !== undefined) return this.reopenBranch(existing, request);

    const boundaries = turnBoundaries(await this.scan(0, undefined));
    const at = request.at ?? boundaries.at(-1);
    if (at === undefined) throw new NoBranchPointError(`conversation ${this.id} has no completed turn to branch from`);
    if (!boundaries.includes(at)) throw new InvalidBranchPointError(`entry ${at} is not a completed-turn boundary of conversation ${this.id}`);
    try {
      const child = await this.conversation.fork(at as never, {
        ownership: { kind: "ownerless" },
        // Runs in the fork's creating commit, so the branch and its request record exist together or not at all.
        init: async (tx, childId) => {
          const state = (await tx.doc(Requests, this.conversation.id)) as unknown as RequestsState;
          state.branches ??= {};
          if (state.branches[id] !== undefined) throw new BranchAlreadyExists();
          state.branches[id] = { childId: childId as number, forkedAt: at };
        },
      }, context);
      return { conversation: new AdapterConversation(this.harness, child, this.storage), forkedAt: at };
    } catch (error) {
      if (!(error instanceof BranchAlreadyExists)) throw error;
      const winner = await this.branchRecord(id);
      if (winner === undefined) throw error;
      return this.reopenBranch(winner, request);
    }
  }

  private async branchRecord(id: RequestId): Promise<BranchRecord | undefined> {
    return (await this.state()).branches?.[id];
  }

  private async reopenBranch(record: BranchRecord, request: BranchRequest): Promise<AdapterBranch> {
    if (request.at !== undefined && request.at !== record.forkedAt) {
      throw new RequestIdConflictError(`request ID "${request.requestId}" already created a branch at entry ${record.forkedAt}, not ${request.at}`);
    }
    const child = await this.harness.conversation(record.childId as never, context);
    if (child === undefined) throw new InvalidBranchPointError(`branch conversation ${record.childId} no longer exists`);
    return { conversation: new AdapterConversation(this.harness, child, this.storage), forkedAt: record.forkedAt };
  }

  /**
   * The conversation's full history in order, including entries compacted out of the model's view and entries inherited
   * from a parent up to the fork point. Read-only: it does not start the scheduler.
   */
  async transcript(): Promise<TranscriptEntry[]> {
    return (await this.scan(0, undefined)).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      role: (firstMessage(entry) as { role?: string }).role,
      text: textOf(firstMessage(entry).content),
      stopReason: (firstMessage(entry) as { stopReason?: string }).stopReason,
      toolCallIds: callIdsOf(firstMessage(entry).content),
      data: entry.data,
    }));
  }

  /** The recorded result of a request that has already settled and been read; `undefined` otherwise. Never waits. */
  async recorded(id: RequestId): Promise<SemanticResult | undefined> {
    return (await this.record(id))?.result;
  }

  /**
   * Read-only status of a request: its result if it has settled (recording it the first time), `undefined` if it is
   * unknown or still pending. Never waits and never starts the scheduler, so it is safe to use after a restart while
   * interrupted work must stay stopped. A request admitted before a crash can be read this way without resubmitting it.
   */
  async lookup(id: RequestId): Promise<SemanticResult | undefined> {
    const recorded = await this.recorded(id);
    if (recorded !== undefined) return recorded;
    const record = await this.storage.submissionByRequest(this.conversation.id, id, context);
    if (record === undefined || record.type !== "input" || (record.status !== "done" && record.status !== "unanswered")) return undefined;
    return this.settle(id, record);
  }

  /**
   * Abort the running request and withdraw queued ones. The running request settles `unanswered` (reason `aborted`);
   * queued requests settle the same way but are marked `retained`: they never started, nothing of theirs ran, and they
   * stay available through `retainedRequests()` and `readmit()`. Nothing is re-run automatically. A partially streamed
   * tool call is never executed, and Pi leaves it out of the context of later requests.
   */
  async abort(): Promise<AbortReport> {
    const before = await this.abortedSubmissions();
    await this.conversation.abort(context);
    const aborted: RequestId[] = [];
    const retained: RequestId[] = [];
    for (const [id, record] of await this.abortedSubmissions()) {
      if (before.has(id) || record.requestId === undefined) continue;
      (record.entry === undefined ? retained : aborted).push(record.requestId as RequestId);
    }
    return { aborted, retained };
  }

  /** Requests withdrawn before they started and not yet readmitted, in admission order. Read-only. */
  async retainedRequests(): Promise<RetainedRequest[]> {
    const state = await this.state();
    const found: RetainedRequest[] = [];
    for (const record of (await this.abortedSubmissions()).values()) {
      if (record.entry !== undefined || record.requestId === undefined) continue;
      const stored = state.requests[record.requestId];
      if (stored?.request !== undefined && stored.readmittedAs === undefined) found.push({ requestId: record.requestId as RequestId, request: stored.request });
    }
    return found;
  }

  /**
   * Submit a retained request again under a new request ID, an explicit controller decision. Idempotent for the same new
   * ID; a different one is refused, so a request is never readmitted twice.
   */
  async readmit(id: RequestId, newId: RequestId): Promise<SubmissionHandle> {
    const result = await this.lookup(id);
    const record = await this.record(id);
    if (result?.status !== "unanswered" || result.retained !== true || record?.request === undefined) {
      throw new NotRetainedError(`request "${id}" was not withdrawn before starting, or its payload is unavailable`);
    }
    // Claim first, in one commit: exactly one new ID can win, concurrently or across a crash. Only then submit; a retry
    // with the same new ID is idempotent. After a crash between the two steps the request no longer shows as retained,
    // so the controller must repeat the call with the same new ID.
    let claimedBy: string | undefined;
    await this.conversation.commit(async (tx) => {
      const state = (await tx.doc(Requests, this.conversation.id)) as unknown as RequestsState;
      const stored = state.requests[id];
      if (stored === undefined) return;
      if (stored.readmittedAs === undefined) stored.readmittedAs = newId;
      claimedBy = stored.readmittedAs;
    }, context);
    if (claimedBy !== newId) throw new AlreadyReadmittedError(`request "${id}" was already readmitted as "${claimedBy}"`);
    return this.submit({ ...record.request, requestId: newId });
  }

  private async abortedSubmissions(): Promise<Map<number, SettledSubmissionRecord>> {
    const found = new Map<number, SettledSubmissionRecord>();
    let cursor;
    for (;;) {
      const page = await this.storage.scanSubmissions({ conversationId: this.conversation.id, status: "unanswered" }, 100, cursor, context);
      for (const record of page.items) {
        if (record.type === "input" && record.status === "unanswered" && record.reason === "aborted") found.set(record.id, record);
      }
      if (page.next === undefined) return found;
      cursor = page.next;
    }
  }

  /** Compact the conversation's model-visible context now. Older entries stay in storage and results stay readable. */
  async compact(instructions?: string): Promise<void> {
    const task = await this.conversation.compact(instructions, context);
    await this.harness.waitForTask(task, context);
  }

  /** The adapter's document for this conversation; empty when nothing has been recorded yet. */
  private async state(): Promise<RequestsState> {
    const state = (await this.harness.snapshot(Requests, this.conversation.id, context)) as unknown as RequestsState | undefined;
    return state ?? { requests: {} };
  }

  private async record(id: RequestId): Promise<RequestRecord | undefined> {
    return (await this.state()).requests[id];
  }

  /** Records the payload fingerprint for a request ID; returns whether this call created the record. */
  private async claim(request: RetainedRequest["request"], fingerprint: string): Promise<boolean> {
    const id = request.requestId;
    let conflict = false;
    let created = false;
    await this.conversation.commit(async (tx) => {
      const state = (await tx.doc(Requests, this.conversation.id)) as unknown as RequestsState;
      const existing = state.requests[id];
      if (existing === undefined) { state.requests[id] = { fingerprint, request: JSON.parse(JSON.stringify(request)) as RetainedRequest["request"] }; created = true; }
      else if (!fingerprintsMatch(existing.fingerprint, fingerprint)) conflict = true;
    }, context);
    if (conflict) throw new RequestIdConflictError(`request ID "${id}" was already used with different content`);
    return created;
  }

  /** Drops a claim that never led to an admitted submission. A record that already holds a result is kept. */
  private async release(id: RequestId): Promise<void> {
    await this.conversation.commit(async (tx) => {
      const state = (await tx.doc(Requests, this.conversation.id)) as unknown as RequestsState;
      // Another call may have been admitted under this ID while this one was being rejected; its claim must stay.
      const admitted = await tx.submissionByRequest(this.conversation.id, id);
      if (admitted === undefined && state.requests[id]?.result === undefined) delete state.requests[id];
    }, context);
  }

  /** Ascending scan of the conversation's history by entry ID, which includes entries compacted out of the active view. */
  private async scan(min: number, max: number | undefined, stopAt?: (entry: EntryLike) => boolean): Promise<EntryLike[]> {
    const found: EntryLike[] = [];
    let cursor;
    for (;;) {
      const page = await this.conversation.entries(
        { minEntryId: min as never, ...(max === undefined ? {} : { maxEntryId: max as never }), order: "ascending" },
        100,
        cursor,
        context,
      );
      for (const entry of page.items as unknown as EntryLike[]) {
        if (stopAt?.(entry)) return found;
        found.push(entry);
      }
      if (page.next === undefined) return found;
      cursor = page.next;
    }
  }

  private async resultOf(id: RequestId, submission: Submission): Promise<SemanticResult> {
    const stored = (await this.record(id))?.result;
    if (stored !== undefined) return stored;
    return this.settle(id, await submission.wait(context));
  }

  /**
   * Builds the semantic result of a settled submission and records it (first writer wins).
   * Tool calls belong to the request whose input most recently precedes them: a steered-in input starts a new segment,
   * so each call is counted once. The final answer text is shared by requests that were merged into one run.
   */
  private async settle(id: RequestId, settled: SettledSubmissionRecord): Promise<SemanticResult> {
    const ownCalls = async (): Promise<ToolCallOutcome[]> => {
      if (settled.entry === undefined) return [];
      const last = settled.status === "done" ? (settled.answer as number) - 1 : undefined;
      const entries = await this.scan((settled.entry as number) + 1, last, (e) => INPUT_KINDS.has(e.kind));
      return entries.filter((e) => e.kind === "pi.tool-result").map(toolOutcome);
    };
    const toolCalls = await ownCalls();
    let result: SemanticResult;
    if (settled.status === "done") {
      const answerId = settled.answer as number;
      const answer = (await this.scan(answerId, answerId))[0];
      const text = answer === undefined ? "" : textOf(firstMessage(answer).content);
      const unknown = toolCalls.filter((c) => c.status === "unknown_tool").map((c) => c.name);
      result = unknown.length > 0
        ? { status: "failed", requestId: id, code: "unknown_tool", detail: `runtime reported tool(s) unavailable: ${[...new Set(unknown)].join(", ")}`, text, toolCalls }
        : { status: "completed", requestId: id, text, toolCalls };
    } else {
      const reason = mapReason(settled.reason);
      const detail = settled.detail === undefined ? settled.reason : `${settled.reason}: ${JSON.stringify(settled.detail)}`;
      // Withdrawn by an abort before it was ever placed in the transcript: nothing of it ran.
      const neverStarted = settled.reason === "aborted" && settled.entry === undefined;
      result = { status: "unanswered", requestId: id, reason, detail, ...(neverStarted ? { retained: true as const } : {}), toolCalls };
    }

    // First writer wins, so concurrent callers and later calls all see one recorded result.
    await this.conversation.commit(async (tx) => {
      const state = (await tx.doc(Requests, this.conversation.id)) as unknown as RequestsState;
      const existing = state.requests[id];
      if (existing === undefined) state.requests[id] = { result };
      else if (existing.result === undefined) {
        existing.result = result;
        // The payload is only needed to readmit a request that never started.
        if (!(result.status === "unanswered" && result.retained === true)) delete existing.request;
      }
    }, context);
    return (await this.record(id))?.result ?? result;
  }
}

/** Maps NimbleNewt requests onto a pinned Pi Durable harness and Pi results back to semantic results. */
export class PiAdapter {
  private constructor(private readonly harness: Harness, private readonly rootConversation: Conversation, private readonly storage: Storage) {}

  static async open(options: PiAdapterOptions): Promise<PiAdapter> {
    assertSupportedRuntime(options.runtime);
    const tools = options.tools ?? [];
    const seen = new Set<string>();
    for (const tool of tools) {
      if (tool.name.length === 0) throw new InvalidToolError("tool name must not be empty");
      if (seen.has(tool.name)) throw new InvalidToolError(`duplicate tool name "${tool.name}"`);
      seen.add(tool.name);
    }
    const registry = createRegistry();
    registry.install(defineExtension({
      name: "nimblenewt",
      tools: tools.map((tool) => defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.replay === undefined ? {} : { replay: tool.replay }),
        // Pi Durable 1.3.0 reads the model-visible result from `output`; the legacy `content` field is ignored.
        execute: async (args: never, api, toolContext) => ({
          output: [{ type: "text" as const, text: await tool.execute(args as Static<typeof tool.parameters>, { signal: toolContext.abortSignal, callId: api.callId }) }],
        }),
      })),
    }));
    const harness = await Harness.open(
      options.storage,
      {
        models: options.models,
        registry,
        ...(options.settings === undefined ? {} : { settings: options.settings }),
        ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
      },
      context,
    );
    const root = await harness.root(context, { agent: { model: options.model } });
    return new PiAdapter(harness, root, options.storage);
  }

  /** The root conversation, created on first use and the same on every reopen of the same storage. */
  root(): AdapterConversation {
    return new AdapterConversation(this.harness, this.rootConversation, this.storage);
  }

  /** Re-acquire an existing conversation by ID, for example after a restart; `undefined` if there is none. */
  async conversation(id: number): Promise<AdapterConversation | undefined> {
    const found = await this.harness.conversation(id as never, context);
    return found === undefined ? undefined : new AdapterConversation(this.harness, found, this.storage);
  }

  /**
   * Start the scheduler so runs a previous process left unfinished continue. Reopening storage does not do this by itself:
   * the controller decides when interrupted work may run again.
   */
  resume(): void {
    this.harness.resume();
  }

  async close(): Promise<void> {
    await this.harness.close(context);
  }
}


import type {
  AbortReport, AdapterRequest, AuditEvent, BranchInfo, BranchRequest, Checkpoint, CheckpointV1, CheckpointVerdict, ConversationPort, InterruptedWork, StorageInfo, TaskPort, TaskRequest, RecoveryDecision, RequestId, RetainedRequest, RuntimePort, SemanticResult, ToolCallOutcome, TranscriptEntry, UpdateSource,
} from "@nimblenewt/contracts";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ImageContent, Models, Static, TextContent, TSchema } from "@earendil-works/pi-ai";
import {
  ConversationBusy, Harness, createRegistry, defineDoc, defineExtension, defineTool,
  type Conversation, type SettledSubmissionRecord, type Storage, type Submission, type SubmissionDraft, type Tx,
} from "@earendil-works/pi-durable";
import { startsRequestSegment, turnBoundaries } from "./branches.js";
import { CHECKPOINT_DIGEST_PREFIX, CHECKPOINT_FORMAT, HISTORY_FORMAT, RUNTIME_NAME, SUPPORTED_HISTORY_FORMATS, digestHistory, upgradeCheckpoint } from "./checkpoints.js";
import { ensureStorageCompatible, readStorageInfo } from "./storage-compat.js";
import {
  AlreadyReadmittedError, BranchDiscardedError, CheckpointRejectedError, ConversationBusyError, InvalidBranchPointError, InvalidToolError, NoBranchPointError, NotRetainedError,
  IncompatibleStorageError, InterruptedWorkError, InvalidReadmissionError, InvalidRecoveryError, NotHeldError, RequestIdConflictError, TooManyBranchesError, UnknownCommandError,
} from "./errors.js";
import { applyContextPolicy, type AdapterContextPolicy } from "./context-policy.js";
import { fingerprintOf, fingerprintsMatch, mapReason } from "./results.js";
import { CONTRACTS_VERSION } from "@nimblenewt/contracts";
import { PINNED_PI_DURABLE_VERSION, assertSupportedRuntime, type RuntimeInfo } from "./runtime.js";

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
  /** Which end of a result over the output limit is kept (default the start; command output wants the end). Only with `contextPolicy` limits. */
  readonly outputRetain?: "head" | "tail";
  execute(args: Static<T>, context: AdapterToolContext): Promise<string>;
}

export interface PiAdapterOptions {
  readonly storage: Storage;
  readonly models: Models;
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly tools?: readonly AdapterTool[];
  /** Pi Durable harness settings, for example compaction thresholds. */
  readonly settings?: NonNullable<Parameters<typeof Harness.open>[1]["settings"]>;
  /** Explicit stream timeout and retries, per-tool output limits and the controller's summariser hook (card C07b). */
  readonly contextPolicy?: AdapterContextPolicy;
  /**
   * Most branches (side conversations) of each kind, inquiries and restored checkpoints counted separately, a conversation
   * may have open at once; discarded branches do not count. Default 8. Branches are cheap but each is a full conversation the controller must eventually review or discard.
   */
  readonly maxActiveBranches?: number;
  /** Most independent tasks (see `createTask`) that may be open at once; discarded tasks do not count. Default 16. */
  readonly maxActiveTasks?: number;
  /**
   * What the model sees of an input whose request was aborted after it had started. `frame` (default) replaces it, for
   * the model only, with the same text marked as aborted and not to be continued unless asked again; the transcript keeps
   * the original. `keep` leaves it as it was, so the model may carry the aborted instruction forward.
   */
  readonly abortedInputs?: "frame" | "keep";
  /**
   * Refuse anything that would make progress while the storage holds interrupted work, until the controller has reviewed
   * it and called `releaseHold()`. Default true. Pi's scheduler is harness-wide, so without the hold almost any call
   * (submit, abort, compact, waiting for a result) would silently re-run every interrupted run.
   */
  readonly holdInterrupted?: boolean;
  /**
   * Receives an audit event after each controller-reviewed action has taken effect (abort, readmission, discarding a
   * branch, restoring a checkpoint, recovery). Awaited; if it throws, the error reaches the caller although the action
   * has already happened, so a controller that must not lose audit records should make its sink durable and retrying.
   */
  readonly audit?: (event: AuditEvent) => void | Promise<void>;
  /**
   * Test seams, not part of the supported API.
   * @internal
   */
  readonly testHooks?: {
    /** Called for every input submission after its request ID is claimed and before it is handed to Pi. */
    readonly beforeAdmission?: (conversationId: number) => Promise<void>;
  };
  /**
   * Accept a storage that has data but no NimbleNewt compatibility marker (written by an earlier build of this adapter or by
   * Pi Durable directly). The adapter scans it read-only first and writes its marker only if the scan finds nothing wrong;
   * without this flag such a storage is refused and left untouched. Default false.
   */
  readonly adoptUnmarkedStorage?: boolean;
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
  /** Set once the aborted input of this request has been framed (or deliberately kept) for later model context. */
  framed?: boolean;
  result?: SemanticResult;
}
/** A branch created for a request ID: the child conversation and the entry it forked after. */
interface BranchRecord {
  childId: number;
  forkedAt: number;
  discarded?: boolean;
  /** Absent on records written before restores existed, which are inquiries. */
  kind?: "inquiry" | "restore" | "task";
}
interface RequestsState {
  requests: Record<string, RequestRecord>;
  branches?: Record<string, BranchRecord>;
  /** Set on a branch conversation's own document when it has been discarded. */
  discarded?: boolean;
}

/** A side conversation created from a task's context. */
export interface AdapterBranch {
  readonly conversation: AdapterConversation;
  /** The parent entry the branch forked after; the branch's context is the parent's as of this entry. */
  readonly forkedAt: number;
  /** True if the branch was discarded: it accepts no new work. */
  readonly discarded: boolean;
}

/** Thrown inside the fork's creating commit to roll it back when another call already created this branch. */
class BranchAlreadyExists extends Error {}

/** Thrown inside the fork's creating commit when the conversation already has its maximum of active branches. */
class BranchLimitReached extends Error {}

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
  readonly head?: unknown;
  readonly edits?: unknown;
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

function sourceData(source: UpdateSource | undefined): JsonValue {
  return source === undefined ? null : { conversationId: source.conversationId, entryId: source.entryId };
}

/** A place-only update: a passive write that adds the text to the model's context at the next boundary. */
function placedUpdateDraft(request: Extract<AdapterRequest, { kind: "update" }>): SubmissionDraft {
  return {
    type: "write",
    requestId: request.requestId,
    entry: {
      kind: "nimblenewt.update",
      model: [{ role: "user", content: request.content, timestamp: Date.now() }],
      data: { source: sourceData(request.source), run: false },
    },
  };
}

/** The same input with a marker in front, for the model's view of an aborted request. */
function framedContent(content: string | (TextContent | ImageContent)[]): string | (TextContent | ImageContent)[] {
  const marker = "[This request was aborted before it finished. Do not continue it unless asked again.]";
  return typeof content === "string" ? `${marker} ${content}` : [{ type: "text", text: marker }, ...content];
}

/** Shared by an adapter and its conversation handles: whether interrupted work is being held back. */
class Hold {
  held: boolean;
  constructor(held: boolean, private readonly harness: Harness) { this.held = held; }

  /** Throws unless progress is allowed. Called before anything that would start Pi's scheduler. */
  async assertRunnable(): Promise<void> {
    if (!this.held) return;
    throw new InterruptedWorkError(await this.conversationIds());
  }

  async conversationIds(): Promise<number[]> {
    const inspection = await this.harness.inspect(context);
    const ids = new Set<number>();
    for (const task of inspection.tasks) ids.add(task.record.conversationId as number);
    for (const submission of inspection.submissions) ids.add(submission.conversationId as number);
    return [...ids].sort((a, b) => a - b);
  }
}

/** What an adapter shares with every conversation handle it hands out. */
interface Shared {
  readonly storage: Storage;
  readonly hold: Hold;
  readonly abortedInputs: "frame" | "keep";
  readonly maxActiveBranches: number;
  readonly maxActiveTasks: number;
  /** Model every conversation of this adapter starts with. */
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly beforeAdmission: ((conversationId: number) => Promise<void>) | undefined;
  readonly audit: ((event: AuditEvent) => void | Promise<void>) | undefined;
  /** Conversations with an abort in progress: new submissions wait for the abort and its framing to finish. */
  readonly aborting: Map<number, Promise<unknown>>;
  /** Submissions in progress per conversation, so a discard can wait for ones that already passed its check. */
  readonly submitting: Map<number, Set<Promise<unknown>>>;
}

/** One Pi conversation: the root task conversation now, inquiry branches and task contexts from F06b. */
export class AdapterConversation implements ConversationPort {
  /** @internal Use `PiAdapter.root()` or `PiAdapter.conversation()`. */
  constructor(private readonly harness: Harness, private readonly conversation: Conversation, private readonly shared: Shared) {}

  get id(): number {
    return this.conversation.id;
  }

  private async emit(event: AuditEvent): Promise<void> {
    await this.shared.audit?.(event);
  }

  /**
   * Admit a request. Submitting the same request ID again returns the original submission and result; reusing it with
   * different content or busy policy throws RequestIdConflictError, including while the original is still queued or
   * after compaction.
   */
  async submit(request: AdapterRequest): Promise<SubmissionHandle> {
    if (request.kind === "command") throw new UnknownCommandError(request.name, SUPPORTED_COMMANDS);
    // Tracked so that discarding this conversation can wait for submissions that already passed its "discarded" check.
    const work = this.submitTracked(request);
    const inFlight = this.shared.submitting.get(this.id) ?? new Set<Promise<unknown>>();
    inFlight.add(work);
    this.shared.submitting.set(this.id, inFlight);
    try {
      return await work;
    } finally {
      inFlight.delete(work);
      if (inFlight.size === 0 && this.shared.submitting.get(this.id) === inFlight) this.shared.submitting.delete(this.id);
    }
  }

  private async submitTracked(request: Exclude<AdapterRequest, { kind: "command" }>): Promise<SubmissionHandle> {
    await this.shared.hold.assertRunnable();
    await this.assertActive();
    // A submission must not slip in between an abort and the framing of the aborted input, or its run would read it unframed.
    await this.shared.aborting.get(this.id)?.catch(() => undefined);
    // Record the payload fingerprint before admission: a crash in between leaves a record for the same payload to retry.
    const created = await this.claim(request, fingerprintOf(request));
    await this.shared.beforeAdmission?.(this.id);
    let submission: Submission;
    try {
      submission = await this.conversation.submit(
        request.kind === "update" && request.run === false ? placedUpdateDraft(request) : {
          type: "input",
          content: request.content,
          requestId: request.requestId,
          ...(request.whenBusy === undefined ? {} : { whenBusy: request.whenBusy }),
          // An update is placed as its own kind of entry, so provenance is in the transcript; the model still sees the text.
          ...(request.kind === "update" ? { entry: { kind: "nimblenewt.update", data: { source: sourceData(request.source), run: true } } } : {}),
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
    // Defence in depth, also across adapter instances: if the branch was discarded while this submission was being
    // admitted, withdraw it instead of letting it run in a closed branch.
    if ((await this.state()).discarded === true) {
      const admitted = await submission.status(context);
      if (admitted.status === "queued") await this.harness.abortSubmission(submission.id, context, this.conversation.id);
      else if (admitted.status === "placed") await this.abortQuietly();
      throw new BranchDiscardedError(this.id);
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
    return this.createBranch(request, "inquiry");
  }

  /** @internal Shared by `branch()` and checkpoint restore, which are limited separately. */
  async createBranch(request: BranchRequest, kind: "inquiry" | "restore"): Promise<AdapterBranch> {
    const id = request.requestId;
    const existing = await this.branchRecord(id);
    if (existing !== undefined) return this.reopenBranch(existing, request, kind);
    await this.assertActive();

    const boundaries = turnBoundaries(await this.scan(0, undefined));
    const at = request.at ?? boundaries.at(-1);
    if (at === undefined) throw new NoBranchPointError(`conversation ${this.id} has no completed turn to branch from`);
    if (!boundaries.includes(at)) throw new InvalidBranchPointError(`entry ${at} is not a completed-turn boundary of conversation ${this.id}`);
    try {
      const child = await this.conversation.fork(at as never, {
        ownership: { kind: "ownerless" },
        // Runs in the fork's creating commit, so the branch and its request record exist together or not at all.
        init: (tx, childId) => this.registerChild(tx, id, childId as number, at, kind),
      }, context);
      return { conversation: new AdapterConversation(this.harness, child, this.shared), forkedAt: at, discarded: false };
    } catch (error) {
      if (error instanceof BranchLimitReached) throw new TooManyBranchesError(this.limitFor(kind));
      if (!(error instanceof BranchAlreadyExists)) throw error;
      const winner = await this.branchRecord(id);
      if (winner === undefined) throw error;
      return this.reopenBranch(winner, request, kind);
    }
  }

  private limitFor(kind: "inquiry" | "restore" | "task"): number {
    return kind === "task" ? this.shared.maxActiveTasks : this.shared.maxActiveBranches;
  }

  /**
   * Records a child conversation in this conversation's document, inside the commit that creates it, so the child and its
   * record exist together or not at all. The active count of each kind is taken in the same commit, so concurrent creators
   * cannot exceed the limit between them. Inquiries, restored checkpoints and tasks are limited separately.
   */
  private async registerChild(tx: Tx, id: RequestId, childId: number, forkedAt: number, kind: "inquiry" | "restore" | "task"): Promise<void> {
    const state = (await tx.doc(Requests, this.conversation.id)) as unknown as RequestsState;
    state.branches ??= {};
    if (state.branches[id] !== undefined) throw new BranchAlreadyExists();
    const active = Object.values(state.branches).filter((b) => b.discarded !== true && (b.kind ?? "inquiry") === kind).length;
    if (active >= this.limitFor(kind)) throw new BranchLimitReached();
    state.branches[id] = { childId, forkedAt, kind };
  }

  /**
   * Start an independent task: a new conversation with an empty context (task A and task B never see each other). It is a
   * child record of this conversation, created atomically and idempotent by request ID like a branch, limited separately
   * (`maxActiveTasks`), listed by `listBranches()` with kind `task` and closed with `discardBranch()`. Only the root
   * conversation creates tasks. Creating one starts nothing, so it is allowed while interrupted work is held.
   * @internal Use `PiAdapter.createTask`.
   */
  async createTask(request: TaskRequest): Promise<{ conversation: AdapterConversation; created: boolean; discarded: boolean }> {
    const id = request.requestId;
    const reopen = async (record: BranchRecord) => {
      if ((record.kind ?? "inquiry") !== "task") throw new RequestIdConflictError(`request ID "${id}" already created a ${record.kind ?? "inquiry"}, not a task`);
      const child = await this.harness.conversation(record.childId as never, context);
      if (child === undefined) throw new InvalidBranchPointError(`task conversation ${record.childId} no longer exists`);
      return { conversation: new AdapterConversation(this.harness, child, this.shared), created: false, discarded: record.discarded === true };
    };
    const existing = await this.branchRecord(id);
    if (existing !== undefined) return reopen(existing);
    await this.assertActive();
    try {
      const child = await this.harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: { model: this.shared.model },
        init: (tx, childId) => this.registerChild(tx, id, childId as number, 0, "task"),
      }, context);
      const created = new AdapterConversation(this.harness, child, this.shared);
      await this.emit({ type: "create_task", at: Date.now(), requestId: id, conversationId: created.id });
      return { conversation: created, created: true, discarded: false };
    } catch (error) {
      if (error instanceof BranchLimitReached) throw new TooManyBranchesError(this.limitFor("task"));
      if (!(error instanceof BranchAlreadyExists)) throw error;
      const winner = await this.branchRecord(id);
      if (winner === undefined) throw error;
      return reopen(winner);
    }
  }

  /** This conversation's branches in creation order, discarded ones included. Read-only. */
  async listBranches(): Promise<BranchInfo[]> {
    const branches = (await this.state()).branches ?? {};
    return Object.entries(branches)
      .map(([requestId, record]) => ({ requestId: requestId as RequestId, kind: record.kind ?? "inquiry", conversationId: record.childId, forkedAt: record.forkedAt, discarded: record.discarded === true }))
      .sort((a, b) => a.conversationId - b.conversationId);
  }

  /**
   * Close a branch: abort whatever it is running and refuse any new work on it (`BranchDiscardedError`). Its transcript
   * stays readable, since branches are kept for review. Idempotent. The parent is untouched. Not allowed while interrupted
   * work is held, because aborting the branch would start Pi's scheduler.
   */
  async discardBranch(requestId: RequestId): Promise<AbortReport> {
    await this.shared.hold.assertRunnable();
    const record = await this.markBranch(requestId);
    // A submission that passed its "discarded" check before the mark may still be being admitted; let it finish so the
    // abort below sees it and stops it. (Submissions from other adapter instances are withdrawn by the re-check after
    // admission instead.)
    await Promise.allSettled([...(this.shared.submitting.get(record.childId) ?? [])]);
    const childConversation = await this.harness.conversation(record.childId as never, context);
    if (childConversation === undefined) return { aborted: [], retained: [] };
    const child = new AdapterConversation(this.harness, childConversation, this.shared);
    const report = await child.abortQuietly();
    // Discarding closes the whole subtree: the branch's own branches are discarded too.
    const aborted = [...report.aborted];
    const retained = [...report.retained];
    for (const nested of await child.listBranches()) {
      if (nested.discarded) continue;
      const nestedReport = await child.discardBranch(nested.requestId);
      aborted.push(...nestedReport.aborted);
      retained.push(...nestedReport.retained);
    }
    const merged = { aborted, retained };
    await this.emit({ type: "discard_branch", at: Date.now(), conversationId: this.id, branchRequestId: requestId, report: merged });
    return merged;
  }

  /** Test seam for the crash window between marking a branch discarded and aborting its work. @internal */
  async markBranchDiscardedForTests(requestId: RequestId): Promise<void> {
    await this.markBranch(requestId);
  }

  /** Marks a branch discarded in one commit (the parent's record and the branch's own document); nothing else changes. */
  private async markBranch(requestId: RequestId): Promise<BranchRecord> {
    const record = await this.branchRecord(requestId);
    if (record === undefined) throw new InvalidBranchPointError(`no branch was created under request ID "${requestId}"`);
    await this.conversation.commit(async (tx) => {
      const parent = (await tx.doc(Requests, this.conversation.id)) as unknown as RequestsState;
      const stored = parent.branches?.[requestId];
      if (stored !== undefined) stored.discarded = true;
      const child = (await tx.doc(Requests, record.childId as never)) as unknown as RequestsState;
      child.discarded = true;
    }, context);
    return record;
  }

  /** Refuses new work on a discarded branch. */
  private async assertActive(): Promise<void> {
    if ((await this.state()).discarded === true) throw new BranchDiscardedError(this.id);
  }

  private async branchRecord(id: RequestId): Promise<BranchRecord | undefined> {
    return (await this.state()).branches?.[id];
  }

  private async reopenBranch(record: BranchRecord, request: BranchRequest, kind: "inquiry" | "restore"): Promise<AdapterBranch> {
    if ((record.kind ?? "inquiry") !== kind) throw new RequestIdConflictError(`request ID "${request.requestId}" already created a ${record.kind ?? "inquiry"}, not a ${kind}`);
    if (request.at !== undefined && request.at !== record.forkedAt) {
      throw new RequestIdConflictError(`request ID "${request.requestId}" already created a branch at entry ${record.forkedAt}, not ${request.at}`);
    }
    const child = await this.harness.conversation(record.childId as never, context);
    if (child === undefined) throw new InvalidBranchPointError(`branch conversation ${record.childId} no longer exists`);
    return { conversation: new AdapterConversation(this.harness, child, this.shared), forkedAt: record.forkedAt, discarded: record.discarded === true };
  }

  /**
   * A checkpoint of this conversation at a completed-turn boundary (by default the latest, exactly as for `branch()`): a
   * portable record that lets a controller later confirm the history is intact and that this runtime can continue from it.
   * Read-only; allowed while interrupted work is held. A turn still in progress is not part of it.
   */
  async checkpoint(options: { readonly at?: number } = {}): Promise<Checkpoint> {
    const entries = await this.scan(0, options.at);
    const boundaries = turnBoundaries(entries);
    const at = options.at ?? boundaries.at(-1);
    if (at === undefined) throw new NoBranchPointError(`conversation ${this.id} has no completed turn to checkpoint`);
    if (!boundaries.includes(at)) throw new InvalidBranchPointError(`entry ${at} is not a completed-turn boundary of conversation ${this.id}`);
    return {
      format: CHECKPOINT_FORMAT,
      conversationId: this.id,
      at,
      digest: digestHistory(entries.filter((entry) => entry.id <= at)),
      runtime: { name: RUNTIME_NAME, version: PINNED_PI_DURABLE_VERSION },
      historyFormat: HISTORY_FORMAT,
      contractsVersion: CONTRACTS_VERSION,
    };
  }

  /**
   * Whether a checkpoint of this conversation still describes it: known format, a runtime that can continue from it, the
   * entry exists and is a completed-turn boundary, and the history up to it is byte-for-byte what was checkpointed.
   * Later turns and compaction do not invalidate it. Read-only.
   */
  async verifyCheckpoint(stored: Checkpoint | CheckpointV1): Promise<CheckpointVerdict> {
    const reject = (reason: Extract<CheckpointVerdict, { valid: false }>["reason"], detail: string): CheckpointVerdict => ({ valid: false, reason, detail });
    // Older formats are upgraded in memory; the stored record is never modified, whether or not it verifies.
    const upgraded = upgradeCheckpoint(stored);
    if (!upgraded.ok) return reject(upgraded.reason, upgraded.detail);
    const checkpoint = upgraded.checkpoint;
    if (!checkpoint.digest.startsWith(CHECKPOINT_DIGEST_PREFIX)) return reject("unsupported_format", `digest algorithm "${checkpoint.digest.split(":").slice(0, 2).join(":")}" is not understood`);
    if (checkpoint.runtime.name !== RUNTIME_NAME || checkpoint.runtime.version !== PINNED_PI_DURABLE_VERSION) {
      return reject("incompatible_runtime", `checkpoint is from ${checkpoint.runtime.name} ${checkpoint.runtime.version}; this adapter supports ${RUNTIME_NAME} ${PINNED_PI_DURABLE_VERSION} only (no history migration yet)`);
    }
    if (!SUPPORTED_HISTORY_FORMATS.includes(checkpoint.historyFormat)) {
      return reject("incompatible_runtime", `checkpoint history format "${checkpoint.historyFormat}" is not one this adapter reads (${SUPPORTED_HISTORY_FORMATS.join(", ")})`);
    }
    if (checkpoint.conversationId !== this.id) return reject("unknown_conversation", `checkpoint is for conversation ${checkpoint.conversationId}, not ${this.id}`);
    const prefix = await this.scan(0, checkpoint.at);
    if (prefix.at(-1)?.id !== checkpoint.at) return reject("unknown_entry", `entry ${checkpoint.at} does not exist in conversation ${this.id}`);
    if (!turnBoundaries(prefix).includes(checkpoint.at)) return reject("not_a_boundary", `entry ${checkpoint.at} is not a completed-turn boundary`);
    if (digestHistory(prefix) !== checkpoint.digest) return reject("history_changed", `the history of conversation ${this.id} up to entry ${checkpoint.at} is not what was checkpointed`);
    return { valid: true };
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
    const record = await this.shared.storage.submissionByRequest(this.conversation.id, id, context);
    if (record === undefined || (record.status !== "done" && record.status !== "unanswered")) return undefined;
    return this.settle(id, record);
  }

  /**
   * Abort the running request and withdraw queued ones. The running request settles `unanswered` (reason `aborted`);
   * queued requests settle the same way but are marked `retained`: they never started, nothing of theirs ran, and they
   * stay available through `retainedRequests()` and `readmit()`. Nothing is re-run automatically. A partially streamed
   * tool call is never executed, and Pi leaves it out of the context of later requests.
   */
  async abort(): Promise<AbortReport> {
    const report = await this.abortQuietly();
    await this.emit({ type: "abort", at: Date.now(), conversationId: this.id, report });
    return report;
  }

  /** `abort()` without its audit event, for aborts that are part of a larger audited action. */
  private async abortQuietly(): Promise<AbortReport> {
    await this.shared.hold.assertRunnable();
    const running = this.abortAndFrame();
    this.shared.aborting.set(this.id, running);
    try {
      return await running;
    } finally {
      if (this.shared.aborting.get(this.id) === running) this.shared.aborting.delete(this.id);
    }
  }

  private async abortAndFrame(): Promise<AbortReport> {
    const before = await this.abortedSubmissions();
    await this.conversation.abort(context);
    const aborted: RequestId[] = [];
    const retained: RequestId[] = [];
    for (const [id, record] of await this.abortedSubmissions()) {
      if (before.has(id) || record.requestId === undefined) continue;
      (record.entry === undefined ? retained : aborted).push(record.requestId as RequestId);
      if (record.entry !== undefined) await this.frameAborted(record.requestId as RequestId, record.entry as number);
    }
    return { aborted, retained };
  }

  /**
   * For the model only, replace the input of a request that started and was aborted with a marked copy (option
   * `abortedInputs`), once. The transcript keeps the original and records a `nimblenewt.aborted-input` entry. Without
   * this Pi keeps the aborted instruction in later context as if it were live.
   *
   * The entry is appended directly in a commit, not through a Pi submission, so it does not wait for a turn boundary. In
   * `abort()` and `abandonInterrupted()` the conversation is idle (or held), so that is safe. When an abort the adapter
   * did not start is first observed by reading a result while another run is mid-turn, the append interleaves with that
   * run's own entries; this worked in every probe but is not a case Pi documents.
   * @internal
   */
  async frameAborted(id: RequestId, entryId: number): Promise<void> {
    if (this.shared.abortedInputs === "keep") return;
    await this.conversation.commit(async (tx) => {
      const state = (await tx.doc(Requests, this.conversation.id)) as unknown as RequestsState;
      const stored = (state.requests[id] ??= {});
      if (stored.framed === true) return;
      stored.framed = true;
      const original = (await tx.entry(entryId as never))?.model?.[0];
      if (original?.role !== "user") return;
      await tx.appendEntry(this.conversation.id, {
        kind: "nimblenewt.aborted-input",
        data: { requestId: id, target: entryId },
        edits: [{ target: entryId as never, action: "replace", messages: [{ role: "user", content: framedContent(original.content), timestamp: original.timestamp }] }],
      });
    }, context);
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
    if (newId === id) throw new InvalidReadmissionError(`request "${id}" cannot be readmitted under its own ID: that would return the aborted submission`);
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
    try {
      const handle = await this.submit({ ...record.request, requestId: newId });
      await this.emit({ type: "readmit", at: Date.now(), conversationId: this.id, requestId: id, newRequestId: newId });
      return handle;
    } catch (error) {
      // A typed refusal means nothing was admitted under the new ID, so give the claim back and let the controller retry
      // with another ID. Other errors leave the claim: the outcome is unknown and a retry with this ID is idempotent.
      if (error instanceof RequestIdConflictError || error instanceof ConversationBusyError || error instanceof InterruptedWorkError) {
        await this.conversation.commit(async (tx) => {
          const state = (await tx.doc(Requests, this.conversation.id)) as unknown as RequestsState;
          const stored = state.requests[id];
          if (stored?.readmittedAs === newId) delete stored.readmittedAs;
        }, context);
      }
      throw error;
    }
  }

  private async abortedSubmissions(): Promise<Map<number, SettledSubmissionRecord>> {
    const found = new Map<number, SettledSubmissionRecord>();
    let cursor;
    for (;;) {
      const page = await this.shared.storage.scanSubmissions({ conversationId: this.conversation.id, status: "unanswered" }, 100, cursor, context);
      for (const record of page.items) {
        if (record.type === "input" && record.status === "unanswered" && record.reason === "aborted") found.set(record.id, record);
      }
      if (page.next === undefined) return found;
      cursor = page.next;
    }
  }

  /**
   * Moves this conversation to another model, for example another provider, from its next request on (card G09: continuity across a provider change). Nothing in the history changes and nothing is
   * summarised: the next request carries the same context, answered by the new model. The model must be known to the `Models` the adapter was opened with, or requests end `unanswered` with reason
   * `no_model`. Applies to this conversation only; its branches and tasks keep the model they were created with, so move each one that should change. Refused while interrupted work is held.
   */
  async useModel(model: { readonly provider: string; readonly modelId: string }): Promise<void> {
    await this.shared.hold.assertRunnable();
    await this.assertActive();
    await this.conversation.configure({ model }, context);
  }

  /** Compact the conversation's model-visible context now. Older entries stay in storage and results stay readable. */
  async compact(instructions?: string): Promise<void> {
    await this.shared.hold.assertRunnable();
    await this.assertActive();
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
    let discarded = false;
    await this.conversation.commit(async (tx) => {
      const state = (await tx.doc(Requests, this.conversation.id)) as unknown as RequestsState;
      // Commits are serialized, so a discard that lands first is seen here and nothing is recorded or admitted.
      if (state.discarded === true) { discarded = true; return; }
      const existing = state.requests[id];
      if (existing === undefined) { state.requests[id] = { fingerprint, request: JSON.parse(JSON.stringify(request)) as RetainedRequest["request"] }; created = true; }
      else if (!fingerprintsMatch(existing.fingerprint, fingerprint)) conflict = true;
    }, context);
    if (discarded) throw new BranchDiscardedError(this.id);
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
    // A settled submission is read from its record, so reading it never starts Pi's scheduler; waiting for an
    // unsettled one does, and is refused while interrupted work is held.
    const current = await submission.status(context);
    if (current.status === "done" || current.status === "unanswered") return this.settle(id, current);
    await this.shared.hold.assertRunnable();
    return this.settle(id, await submission.wait(context));
  }

  /**
   * Builds the semantic result of a settled submission and records it (first writer wins).
   * Tool calls belong to the request whose input most recently precedes them: a steered-in input starts a new segment,
   * so each call is counted once. The final answer text is shared by requests that were merged into one run.
   */
  private async settle(id: RequestId, settled: SettledSubmissionRecord): Promise<SemanticResult> {
    if (settled.type === "write") return this.settleWrite(id, settled);
    const ownCalls = async (): Promise<ToolCallOutcome[]> => {
      if (settled.entry === undefined) return [];
      const last = settled.status === "done" ? (settled.answer as number) - 1 : undefined;
      const entries = await this.scan((settled.entry as number) + 1, last, (e) => startsRequestSegment(e));
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
      // The abort is now observed; make sure the model no longer sees this request's input as a live instruction.
      if (settled.reason === "aborted" && settled.entry !== undefined) await this.frameAborted(id, settled.entry as number);
    }

    return this.recordResult(id, result);
  }

  /** A place-only update (a passive write) has settled: it was added to the transcript, or could not be. */
  private async settleWrite(id: RequestId, settled: SettledSubmissionRecord): Promise<SemanticResult> {
    const result: SemanticResult = settled.status === "done"
      ? { status: "placed", requestId: id, entryId: settled.entry as number, toolCalls: [] }
      : { status: "unanswered", requestId: id, reason: mapReason(String(settled.reason)), detail: String(settled.reason), toolCalls: [] };
    return this.recordResult(id, result);
  }

  /** Records a built result; the first writer wins, so concurrent callers and later calls all see one recorded result. */
  private async recordResult(id: RequestId, result: SemanticResult): Promise<SemanticResult> {
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
export class PiAdapter implements RuntimePort {
  private constructor(private readonly harness: Harness, private readonly rootConversation: Conversation, private readonly shared: Shared) {}

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
    const policy = applyContextPolicy(options.contextPolicy, options.settings);
    const limited = policy.toolLimits.maxBytes !== undefined || policy.toolLimits.maxLines !== undefined;
    registry.install(defineExtension({
      name: "nimblenewt",
      ...(policy.hooks.length === 0 ? {} : { hooks: policy.hooks }),
      tools: tools.map((tool) => defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.replay === undefined ? {} : { replay: tool.replay }),
        ...(limited ? { outputLimits: { ...policy.toolLimits, retain: tool.outputRetain ?? "head" } } : {}),
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
        ...(policy.settings === undefined ? {} : { settings: policy.settings }),
        ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
      },
      context,
    );
    try {
      await ensureStorageCompatible(harness, options.storage, { adoptUnmarkedStorage: options.adoptUnmarkedStorage === true });
    } catch (error) {
      await harness.close(context).catch(() => undefined);
      throw error;
    }
    const root = await harness.root(context, { agent: { model: options.model } });
    // Read-only: finds work a previous process left unfinished without starting the scheduler.
    const inspection = await harness.inspect(context);
    const interrupted = inspection.tasks.length > 0 || inspection.submissions.length > 0;
    return new PiAdapter(harness, root, {
      storage: options.storage,
      hold: new Hold(interrupted && options.holdInterrupted !== false, harness),
      abortedInputs: options.abortedInputs ?? "frame",
      maxActiveBranches: options.maxActiveBranches ?? 8,
      maxActiveTasks: options.maxActiveTasks ?? 16,
      model: options.model,
      beforeAdmission: options.testHooks?.beforeAdmission,
      audit: options.audit,
      aborting: new Map(),
      submitting: new Map(),
    });
  }

  /** The root conversation, created on first use and the same on every reopen of the same storage. */
  root(): AdapterConversation {
    return new AdapterConversation(this.harness, this.rootConversation, this.shared);
  }

  /**
   * Start another task with an empty context, independent of every other task (see `AdapterConversation.createTask`).
   * Idempotent by request ID.
   */
  async createTask(request: TaskRequest): Promise<TaskPort> {
    return this.root().createTask(request);
  }

  /** Re-acquire an existing conversation by ID, for example after a restart; `undefined` if there is none. */
  async conversation(id: number): Promise<AdapterConversation | undefined> {
    const found = await this.harness.conversation(id as never, context);
    return found === undefined ? undefined : new AdapterConversation(this.harness, found, this.shared);
  }

  /**
   * Whether a checkpoint still describes its conversation (see `AdapterConversation.verifyCheckpoint`). A conversation
   * that does not exist is `unknown_conversation`. Read-only; allowed while interrupted work is held.
   */
  async verifyCheckpoint(stored: Checkpoint | CheckpointV1): Promise<CheckpointVerdict> {
    const upgraded = upgradeCheckpoint(stored);
    if (!upgraded.ok) return { valid: false, reason: upgraded.reason, detail: upgraded.detail };
    const conversation = await this.conversation(upgraded.checkpoint.conversationId);
    if (conversation === undefined) return { valid: false, reason: "unknown_conversation", detail: `conversation ${upgraded.checkpoint.conversationId} does not exist` };
    return conversation.verifyCheckpoint(upgraded.checkpoint);
  }

  /**
   * Restore the task context a checkpoint refers to as a new conversation: verify it, then branch its conversation at the
   * checkpoint's entry. Later turns of the original are not part of the result. Idempotent by request ID, like any branch.
   * Throws `CheckpointRejectedError` if the checkpoint does not verify.
   */
  async restoreCheckpoint(stored: Checkpoint | CheckpointV1, requestId: RequestId): Promise<AdapterBranch> {
    const verdict = await this.verifyCheckpoint(stored);
    if (!verdict.valid) throw new CheckpointRejectedError(verdict.reason, verdict.detail);
    const upgraded = upgradeCheckpoint(stored);
    if (!upgraded.ok) throw new CheckpointRejectedError(upgraded.reason, upgraded.detail); // unreachable after a valid verdict
    const checkpoint = upgraded.checkpoint;
    const conversation = await this.conversation(checkpoint.conversationId);
    const restored = await conversation!.createBranch({ requestId, at: checkpoint.at }, "restore");
    await this.shared.audit?.({ type: "restore_checkpoint", at: Date.now(), checkpoint, branchRequestId: requestId, newConversationId: restored.conversation.id });
    return restored;
  }

  /**
   * The one reviewed recovery step: abandon the listed conversations' interrupted work, then release the hold so the rest
   * resumes, recorded as a single `recover` audit event that includes exactly what was found. Prefer it to calling
   * `abandonInterrupted` and `releaseHold` separately. Only valid while interrupted work is held (`NotHeldError`);
   * `InvalidRecoveryError` for a conversation with no interrupted work or a missing reason or decider.
   */
  async recover(decision: RecoveryDecision): Promise<void> {
    if (!this.shared.hold.held) throw new NotHeldError("nothing to recover: no interrupted work is being held");
    if (decision.reason.trim() === "" || decision.decidedBy.trim() === "") throw new InvalidRecoveryError("a recovery decision needs a reason and who decided");
    const found = await this.interrupted();
    const known = new Set(found.conversations.map((c) => c.conversationId));
    for (const id of decision.abandon) {
      if (!known.has(id)) throw new InvalidRecoveryError(`conversation ${id} has no interrupted work to abandon`);
    }
    if (decision.abandon.length > 0) await this.abandonInterrupted(decision.abandon);
    await this.releaseHold();
    await this.shared.audit?.({ type: "recover", at: Date.now(), decision, found });
  }

  /**
   * What the storage records about who wrote it and how this adapter came to accept it (see `adoptUnmarkedStorage`).
   * Read-only.
   */
  async storageInfo(): Promise<StorageInfo> {
    const info = await readStorageInfo(this.harness);
    if (info === undefined) throw new IncompatibleStorageError("the storage has no compatibility marker");
    return info;
  }

  /**
   * Interrupted work found in the storage, per conversation. Read-only: it never starts the scheduler, so it is safe to
   * call while the hold is on and the way to decide what to do with that work.
   */
  async interrupted(): Promise<InterruptedWork> {
    const inspection = await this.harness.inspect(context);
    const byConversation = new Map<number, { tasks: number; requestIds: string[]; allMarked: boolean }>();
    const entry = (id: number) => {
      let found = byConversation.get(id);
      if (found === undefined) { found = { tasks: 0, requestIds: [], allMarked: true }; byConversation.set(id, found); }
      return found;
    };
    for (const task of inspection.tasks) {
      const item = entry(task.record.conversationId as number);
      item.tasks += 1;
      if (!task.record.abortRequested) item.allMarked = false;
    }
    for (const submission of inspection.submissions) {
      const item = entry(submission.conversationId as number);
      if (submission.requestId !== undefined) item.requestIds.push(submission.requestId);
      if (submission.status === "queued" && submission.type === "input") item.allMarked = false; // nothing to mark: it would be placed and run on release
    }
    const conversations = [];
    for (const [conversationId, item] of [...byConversation.entries()].sort(([a], [b]) => a - b)) {
      const state = (await this.harness.snapshot(Requests, conversationId as never, context)) as unknown as RequestsState | undefined;
      conversations.push({ conversationId, tasks: item.tasks, requestIds: item.requestIds, abandoned: item.tasks > 0 && item.allMarked, discarded: state?.discarded === true });
    }
    return { held: this.shared.hold.held, conversations };
  }

  /**
   * Mark every live task of the given conversations for abandonment, without starting anything: their interrupted tool
   * calls and generations will not run again. The abort is carried out (and their requests settle `unanswered`) once the
   * hold is released. Queued requests that never started are withdrawn and stay retained. Conversations not listed are
   * untouched.
   */
  async abandonInterrupted(conversationIds: readonly number[]): Promise<void> {
    if (!this.shared.hold.held) throw new NotHeldError("work can only be abandoned while the hold is in force: once the scheduler runs, an abort is only a late request");
    const wanted = new Set(conversationIds);
    const inspection = await this.harness.inspect(context);
    for (const task of inspection.tasks) {
      if (wanted.has(task.record.conversationId as number) && !task.record.abortRequested) await this.harness.abortTask(task.record.id, context);
    }
    // The requests that had started will be aborted on release; frame their inputs now so no run can see them as live.
    for (const submission of inspection.submissions) {
      if (!wanted.has(submission.conversationId as number) || submission.status !== "placed" || submission.requestId === undefined) continue;
      const conversation = await this.harness.conversation(submission.conversationId, context);
      if (conversation !== undefined && submission.entry !== undefined) {
        await new AdapterConversation(this.harness, conversation, this.shared).frameAborted(submission.requestId as RequestId, submission.entry as number);
      }
    }
    // Queued submissions have no task to mark; withdraw them so they cannot start on release. Like any request withdrawn
    // before starting, they stay available through retainedRequests() and readmit().
    for (const submission of inspection.submissions) {
      // Queued place-only updates (writes) are left alone: they ask the model nothing, and placing them on release is
      // the controller's earlier decision, not a hazard.
      if (wanted.has(submission.conversationId as number) && submission.status === "queued" && submission.type === "input") {
        await this.harness.abortSubmission(submission.id, context, submission.conversationId);
      }
    }
  }

  /**
   * End the hold and start the scheduler: interrupted work that was not abandoned runs again (tools declared replay-safe
   * re-run; others are reported to the model as interrupted). Interrupted work of discarded branches is abandoned first,
   * automatically. Also the way to start the scheduler when nothing is held. Async: callers must await it, because the
   * hold only ends once the abandonment is done; a call made before that fails safely with `InterruptedWorkError`.
   * Pi's scheduler is harness-wide, so this resumes every conversation that was not abandoned.
   */
  async releaseHold(): Promise<void> {
    if (this.shared.hold.held) {
      // Work of a discarded branch must never resume, even if the process died between marking and aborting it.
      const discarded = (await this.interrupted()).conversations.filter((c) => c.discarded && !c.abandoned).map((c) => c.conversationId);
      if (discarded.length > 0) await this.abandonInterrupted(discarded);
    }
    this.shared.hold.held = false;
    this.harness.resume();
  }

  async close(): Promise<void> {
    await this.harness.close(context);
  }
}


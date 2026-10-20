/** Version of the contracts shared between NimbleNewt packages. Bump on breaking changes. */
export const CONTRACTS_VERSION = 1;

/** Caller-chosen identifier that makes a submission idempotent: the same ID yields the original result. */
export type RequestId = string & { readonly __brand: "RequestId" };

export function requestId(value: string): RequestId {
  if (value.length === 0) throw new Error("request ID must not be empty");
  return value as RequestId;
}

/** JSON-serializable value; request arguments and stored results must round-trip through durable storage. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** What happened to one tool call the model made while answering a request. */
export type ToolCallOutcome =
  | { readonly callId: string; readonly name: string; readonly status: "ok"; readonly output: string }
  | { readonly callId: string; readonly name: string; readonly status: "error"; readonly output: string }
  /**
   * The runtime reported the requested tool as unavailable: it is not registered, or exists but is not offered to the
   * model. The call did not run. This does not stop the run.
   */
  | { readonly callId: string; readonly name: string; readonly status: "unknown_tool" };

/** Why the runtime ended a request without an answer. `other` keeps the runtime's own wording in `detail`. */
export type UnansweredReason = "aborted" | "model_error" | "no_model" | "stale" | "reset" | "faulted" | "other";

/** Semantic outcome of one submitted request, independent of the underlying agent runtime. Immutable once recorded. */
export type SemanticResult =
  /** A place-only update was added to the transcript; the model was not asked anything. */
  | { readonly status: "placed"; readonly requestId: RequestId; readonly entryId: number; readonly toolCalls: readonly ToolCallOutcome[] }
  | {
      readonly status: "completed";
      readonly requestId: RequestId;
      /** The final answer text. */
      readonly text: string;
      readonly toolCalls: readonly ToolCallOutcome[];
    }
  /** The runtime ended the request without an answer (for example it was aborted). */
  | {
      readonly status: "unanswered";
      readonly requestId: RequestId;
      readonly reason: UnansweredReason;
      /** The runtime's own reason string and detail, kept verbatim for diagnosis. */
      readonly detail: string;
      /**
       * Present when the request was withdrawn before it ever started (for example it was queued when the conversation
       * was aborted). It did nothing and is kept so the controller can readmit it deliberately; it never runs by itself.
       */
      readonly retained?: true;
      readonly toolCalls: readonly ToolCallOutcome[];
    }
  /** The request ran but violated the adapter's contract. It is never reported as `completed`. */
  | {
      readonly status: "failed";
      readonly requestId: RequestId;
      readonly code: "unknown_tool";
      readonly detail: string;
      /** The answer the model eventually gave, if any; informational only. */
      readonly text: string;
      readonly toolCalls: readonly ToolCallOutcome[];
    };

/** What to do with an input that arrives while the conversation is already working. */
export type WhenBusy = "followUp" | "steer" | "reject";

/** Where a selected update came from, kept as provenance on the entry it creates. */
export interface UpdateSource {
  readonly conversationId: number;
  readonly entryId: number;
}

/** Requests an adapter accepts. */
export type AdapterRequest =
  | { readonly kind: "input"; readonly requestId: RequestId; readonly content: string; readonly whenBusy?: WhenBusy }
  /**
   * A deliberately selected update to a task's context (for example a decision made in an inquiry). It is placed in the
   * transcript as its own kind of entry, so provenance is visible, and is applied once per request ID.
   */
  | {
      readonly kind: "update";
      readonly requestId: RequestId;
      readonly content: string;
      readonly source?: UpdateSource;
      readonly whenBusy?: WhenBusy;
      /**
       * Whether applying the update also resumes the task (default true). With `false` the update is only placed in the
       * transcript, at the next turn boundary, and the model is not asked anything; the controller resumes the task later.
       */
      readonly run?: boolean;
    }
  | { readonly kind: "command"; readonly requestId: RequestId; readonly name: string; readonly args?: { readonly [key: string]: JsonValue } };

/** Create a side conversation (an inquiry branch) from a task's context. Idempotent by request ID. */
export interface BranchRequest {
  readonly requestId: RequestId;
  /**
   * Entry to branch after. Must be a completed-turn boundary. Defaults to the latest one, resolved when the branch is
   * first created and then fixed for that request ID.
   */
  readonly at?: number;
}

/** Outcome of aborting a conversation: which requests were stopped mid-run and which were withdrawn before starting. */
export interface AbortReport {
  /** Requests that had started and were aborted. */
  readonly aborted: readonly RequestId[];
  /** Queued requests withdrawn before they started; each stays available for readmission. */
  readonly retained: readonly RequestId[];
}

/** A request withdrawn before it started, with the payload needed to readmit it. */
export interface RetainedRequest {
  readonly requestId: RequestId;
  readonly request: Extract<AdapterRequest, { kind: "input" | "update" }>;
}

/** Work a previous process left unfinished in the storage, found when an adapter opens it. */
export interface InterruptedWork {
  /** While held, anything that would make progress (submit, abort, compact, waiting) is refused. */
  readonly held: boolean;
  readonly conversations: readonly {
    readonly conversationId: number;
    /** Live tasks (generations, tool calls) the conversation still has. */
    readonly tasks: number;
    /** Requests admitted to the conversation but not yet settled. */
    readonly requestIds: readonly string[];
    /** True once every task of the conversation has been marked for abandonment. */
    readonly abandoned: boolean;
    /** True for a discarded branch: its work is abandoned automatically when the hold is released. */
    readonly discarded: boolean;
  }[];
}

/** One branch of a conversation, as listed by the adapter. */
export interface BranchInfo {
  /** The request ID the branch was created under. */
  readonly requestId: RequestId;
  /** Why it exists: a side inquiry, a restored checkpoint, or an independent task. Each kind is limited separately. */
  readonly kind: "inquiry" | "restore" | "task";
  readonly conversationId: number;
  /** The parent entry the branch forked after; 0 for a task, which starts with an empty context. */
  readonly forkedAt: number;
  /** A discarded branch is closed to new work; its transcript stays readable. */
  readonly discarded: boolean;
}

/**
 * A portable, verifiable reference to a conversation at a completed-turn boundary. It holds no conversation content: the
 * history lives in the runtime's storage, and the checkpoint lets a controller confirm later (after a restart, on another
 * worker, after an upgrade) that the history it refers to is intact and that this runtime can continue from it.
 */
export interface Checkpoint {
  /** Layout of this record; a runtime rejects formats it does not know. */
  readonly format: 1;
  readonly conversationId: number;
  /** The entry the checkpoint is taken after: a completed-turn boundary. */
  readonly at: number;
  /** Digest of the conversation's history up to and including `at` (see the adapter for the exact form). */
  readonly digest: string;
  /** Exact version of the agent runtime the history was written by. */
  readonly runtimeVersion: string;
  /**
   * Version of these shared contracts when the checkpoint was taken. Informational: validity depends on the record layout
   * (`format`), the digest algorithm and the runtime's history compatibility, not on unrelated contract changes.
   */
  readonly contractsVersion: number;
}

export type CheckpointRejection =
  | "unsupported_format"
  | "incompatible_runtime"
  | "unknown_conversation"
  | "unknown_entry"
  | "not_a_boundary"
  | "history_changed";

export type CheckpointVerdict =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: CheckpointRejection; readonly detail: string };

/** One entry of a conversation's history, as exposed for inspection. */
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

/** The controller's decision after reviewing interrupted work: one reviewed step, recorded in the audit trail. */
export interface RecoveryDecision {
  /** Conversations whose interrupted work is abandoned; everything else resumes. */
  readonly abandon: readonly number[];
  /** Why, in the decider's words. Required. */
  readonly reason: string;
  /** Who decided (a user, a supervisor agent, a policy name). Required. */
  readonly decidedBy: string;
}

/** What happened, for the controller's audit trail. Emitted after the action has taken effect. */
export type AuditEvent =
  | { readonly type: "abort"; readonly at: number; readonly conversationId: number; readonly report: AbortReport }
  | { readonly type: "readmit"; readonly at: number; readonly conversationId: number; readonly requestId: RequestId; readonly newRequestId: RequestId }
  | { readonly type: "discard_branch"; readonly at: number; readonly conversationId: number; readonly branchRequestId: RequestId; readonly report: AbortReport }
  | { readonly type: "restore_checkpoint"; readonly at: number; readonly checkpoint: Checkpoint; readonly branchRequestId: RequestId; readonly newConversationId: number }
  | { readonly type: "create_task"; readonly at: number; readonly requestId: RequestId; readonly conversationId: number }
  | { readonly type: "recover"; readonly at: number; readonly decision: RecoveryDecision; readonly found: InterruptedWork };

/** An admitted request, as the controller sees it. */
export interface SubmissionPort {
  readonly requestId: RequestId;
  readonly submissionId: number;
  /** Waits for the request to settle and returns its recorded result. Refused while interrupted work is held. */
  result(): Promise<SemanticResult>;
}

/** Start an independent task: a new conversation with an empty context. Idempotent by request ID. */
export interface TaskRequest {
  readonly requestId: RequestId;
}

/** An independent task conversation. */
export interface TaskPort {
  readonly conversation: ConversationPort;
  /** False when the request ID had already created this task. */
  readonly created: boolean;
  readonly discarded: boolean;
}

/** A side conversation created from a task's context. */
export interface BranchPort {
  readonly conversation: ConversationPort;
  readonly forkedAt: number;
  readonly discarded: boolean;
}

/**
 * Everything a controller may do with one conversation. Harness-agnostic: it names only contract types, so a controller
 * written against it does not depend on Pi Durable, and a different runtime can implement it.
 */
export interface ConversationPort {
  readonly id: number;
  submit(request: AdapterRequest): Promise<SubmissionPort>;
  /** The recorded result of a request that has settled and been read; never waits. */
  recorded(requestId: RequestId): Promise<SemanticResult | undefined>;
  /** Read-only status: the result if the request has settled, `undefined` otherwise; never waits, never resumes work. */
  lookup(requestId: RequestId): Promise<SemanticResult | undefined>;
  abort(): Promise<AbortReport>;
  retainedRequests(): Promise<RetainedRequest[]>;
  readmit(requestId: RequestId, newRequestId: RequestId): Promise<SubmissionPort>;
  branch(request: BranchRequest): Promise<BranchPort>;
  listBranches(): Promise<BranchInfo[]>;
  discardBranch(requestId: RequestId): Promise<AbortReport>;
  checkpoint(options?: { readonly at?: number }): Promise<Checkpoint>;
  verifyCheckpoint(checkpoint: Checkpoint): Promise<CheckpointVerdict>;
  transcript(): Promise<TranscriptEntry[]>;
}

/** What a controller may do with a runtime as a whole, including recovery after a crash. */
export interface RuntimePort {
  root(): ConversationPort;
  conversation(id: number): Promise<ConversationPort | undefined>;
  /**
   * Start another task with an empty context, separate from every other task's. Tasks are children of the root
   * conversation's record: list them with `root().listBranches()` (kind `task`) and close one with
   * `root().discardBranch(requestId)`.
   */
  createTask(request: TaskRequest): Promise<TaskPort>;
  /** Interrupted work found when the runtime opened its storage, per conversation. Read-only. */
  interrupted(): Promise<InterruptedWork>;
  /**
   * The one reviewed recovery step: abandon the listed conversations' interrupted work and resume the rest, recorded as a
   * single audit event with what was found. Only valid while interrupted work is held.
   */
  recover(decision: RecoveryDecision): Promise<void>;
  verifyCheckpoint(checkpoint: Checkpoint): Promise<CheckpointVerdict>;
  restoreCheckpoint(checkpoint: Checkpoint, requestId: RequestId): Promise<BranchPort>;
  close(): Promise<void>;
}

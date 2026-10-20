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
  | { readonly kind: "update"; readonly requestId: RequestId; readonly content: string; readonly source?: UpdateSource; readonly whenBusy?: WhenBusy }
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

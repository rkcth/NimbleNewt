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
export type UnansweredReason = "aborted" | "model_error" | "stale" | "restart" | "other";

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

/** Requests an adapter accepts. */
export type AdapterRequest =
  | { readonly kind: "input"; readonly requestId: RequestId; readonly content: string }
  | { readonly kind: "command"; readonly requestId: RequestId; readonly name: string; readonly args?: { readonly [key: string]: JsonValue } };

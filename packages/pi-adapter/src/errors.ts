/** Base class so callers can tell adapter contract failures from unexpected errors. */
export class PiAdapterError extends Error {
  override readonly name: string = "PiAdapterError";
}

/** The installed Pi Durable or Node version is not the one this adapter is qualified against. */
export class UnsupportedRuntimeError extends PiAdapterError {
  override readonly name = "UnsupportedRuntimeError";
}

/** A command request named a command this adapter does not support. */
export class UnknownCommandError extends PiAdapterError {
  override readonly name = "UnknownCommandError";
  constructor(readonly command: string, readonly supported: readonly string[]) {
    super(`unknown command "${command}"; supported commands: ${supported.length > 0 ? supported.join(", ") : "(none)"}`);
  }
}

/** A tool has an empty name, or two tools were registered under one name. */
export class InvalidToolError extends PiAdapterError {
  override readonly name = "InvalidToolError";
}

/** A request ID was reused with different content. */
export class RequestIdConflictError extends PiAdapterError {
  override readonly name = "RequestIdConflictError";
}

/** The conversation was busy and the request asked to be rejected (`whenBusy: "reject"`); it was not admitted. */
export class ConversationBusyError extends PiAdapterError {
  override readonly name = "ConversationBusyError";
  constructor(readonly conversationId: number) {
    super(`conversation ${conversationId} is busy; the request was not admitted`);
  }
}

/** The conversation has no completed turn to branch from yet. */
export class NoBranchPointError extends PiAdapterError {
  override readonly name = "NoBranchPointError";
}

/** The requested branch point is not a completed-turn boundary of this conversation. */
export class InvalidBranchPointError extends PiAdapterError {
  override readonly name = "InvalidBranchPointError";
}

/** Readmission was requested for a request that was not withdrawn before starting, or whose payload is unavailable. */
export class NotRetainedError extends PiAdapterError {
  override readonly name = "NotRetainedError";
}

/** A retained request was already readmitted under a different request ID. */
export class AlreadyReadmittedError extends PiAdapterError {
  override readonly name = "AlreadyReadmittedError";
}

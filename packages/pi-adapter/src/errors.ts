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

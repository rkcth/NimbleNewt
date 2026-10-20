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

/**
 * The storage holds interrupted work and the adapter is on hold: nothing may make progress until the controller has
 * looked at it (`interrupted()`), optionally abandoned some of it, and released the hold.
 */
export class InterruptedWorkError extends PiAdapterError {
  override readonly name = "InterruptedWorkError";
  constructor(readonly conversationIds: readonly number[]) {
    super(`interrupted work in conversation(s) ${conversationIds.join(", ")} must be reviewed and the hold released before anything can make progress`);
  }
}

/** Readmission was requested in a way that cannot work, for example under the request's own ID. */
export class InvalidReadmissionError extends PiAdapterError {
  override readonly name = "InvalidReadmissionError";
}

/** `abandonInterrupted` was called when no hold is in force: the scheduler may already be running, so it cannot be done safely. */
export class NotHeldError extends PiAdapterError {
  override readonly name = "NotHeldError";
}

/** The branch was discarded: it accepts no new work. Its transcript can still be read. */
export class BranchDiscardedError extends PiAdapterError {
  override readonly name = "BranchDiscardedError";
  constructor(readonly conversationId: number) {
    super(`conversation ${conversationId} is a discarded branch and accepts no new work`);
  }
}

/** Creating another branch would exceed the number of active (not discarded) branches allowed per conversation. */
export class TooManyBranchesError extends PiAdapterError {
  override readonly name = "TooManyBranchesError";
  constructor(readonly limit: number) {
    super(`this conversation already has ${limit} active branches; discard one first`);
  }
}

/** A checkpoint cannot be used: it is damaged, from an incompatible runtime, or the history it refers to has changed. */
export class CheckpointRejectedError extends PiAdapterError {
  override readonly name = "CheckpointRejectedError";
  constructor(readonly reason: string, readonly detail: string) {
    super(`checkpoint rejected (${reason}): ${detail}`);
  }
}

/** A recovery decision cannot be carried out as given (unknown conversation, missing reason or decider). */
export class InvalidRecoveryError extends PiAdapterError {
  override readonly name = "InvalidRecoveryError";
}

/**
 * The storage has data but no NimbleNewt compatibility marker, so who wrote it is unknown. It was left untouched. If the
 * controller knows it is compatible (for example it was written by an earlier build of this adapter, or by Pi Durable
 * directly), reopen with `adoptUnmarkedStorage: true`: the adapter then scans it read-only and only writes its marker if
 * the scan finds nothing wrong.
 */
export class UnmarkedStorageError extends PiAdapterError {
  override readonly name = "UnmarkedStorageError";
  constructor(readonly conversations: number) {
    super(`the storage holds ${conversations} conversation(s) but no compatibility marker; it was not modified (pass adoptUnmarkedStorage to adopt it after a scan)`);
  }
}

/** The storage cannot be used by this adapter and was left exactly as it was. */
export class IncompatibleStorageError extends PiAdapterError {
  override readonly name = "IncompatibleStorageError";
  constructor(readonly reason: string, readonly findings: readonly string[] = []) {
    super(`incompatible storage: ${reason}${findings.length > 0 ? ` (${findings.slice(0, 5).join("; ")}${findings.length > 5 ? `; and ${findings.length - 5} more` : ""})` : ""}; it was not modified`);
  }
}

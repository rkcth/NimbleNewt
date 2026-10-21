/**
 * What a domain command can be refused for. Callers decide what to do from `code` alone; the message is for people.
 *
 * - `invalid_command`: the command itself is malformed or asks for something the records forbid (a bad field, an unknown repository,
 *   a task in an archived project). Nothing was written.
 * - `command_conflict`: the command ID was used before with a different command. Nothing was written.
 * - `stale_revision`: the record is not at the revision the command expected; `currentRevision` says where it is. Re-read and decide.
 * - `not_found`: the project or task does not exist.
 * - `invalid_transition`: the task cannot move from its current state to the requested one.
 * - `stale_epoch`: this controller is no longer the primary. Stop writing.
 * - `fenced`: the caller acted under an ownership generation or attempt that is no longer current (card S02). Nothing was written; re-read the assignment.
 * - `payload_changed`: a delivery ID already received arrived again with a different payload (card S04). Nothing was changed; the sender is faulty.
 * - `effect_uncertain`: an external effect may or may not have happened and the target cannot be asked, so it is not retried blindly (card S05); a person resolves it.
 * - `effect_busy`: another executor holds the effect right now; try again after its lease.
 * - `wait_closed`: the wait an answer was meant for has already closed (timed out, cancelled, or its task is no longer waiting), so the answer was not applied and revived nothing (card S08).
 * - `unauthenticated`: no valid credential was presented (unknown principal, wrong secret and a disabled principal are not told apart) (card A01).
 * - `forbidden`: the caller is who it says it is, but may not do this, or not in this project, or named another actor (card A01).
 * - `integrity`: stored content is missing or does not match its recorded hash (artifacts, card S06). It must not be used.
 * - `unavailable`: storage could not complete the command (busy beyond the retry budget, unreachable). The command may be retried
 *   with the same command ID: it applies once.
 */
export type DomainErrorCode = "invalid_command" | "command_conflict" | "stale_revision" | "not_found" | "invalid_transition" | "stale_epoch" | "integrity" | "fenced" | "payload_changed" | "effect_uncertain" | "effect_busy" | "wait_closed" | "unauthenticated" | "forbidden" | "unavailable";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  /** For `stale_revision`: the revision the record has now. */
  readonly currentRevision: number | undefined;
  /** For `invalid_command`: the field at fault. */
  readonly field: string | undefined;

  constructor(code: DomainErrorCode, message: string, options: { currentRevision?: number; field?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DomainError";
    this.code = code;
    this.currentRevision = options.currentRevision;
    this.field = options.field;
  }
}

export const isDomainError = (error: unknown, code?: DomainErrorCode): error is DomainError => error instanceof DomainError && (code === undefined || error.code === code);

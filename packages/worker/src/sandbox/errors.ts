export type SandboxErrorCode =
  /** The recipe asks for something the launcher never allows (or names a path that does not exist). */
  | "invalid_recipe"
  /** No confined launch is possible right now (no backend for this OS, or the health check failed). Nothing runs unconfined instead. */
  | "unavailable"
  /** The launch could not be recorded in the audit sink, so it did not happen. */
  | "audit_failed"
  /** Trusted-host mode was asked for without the explicit authority configured. */
  | "not_authorized";

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  /** For a launch refused because limits could not be enforced in full: which limits, and how far each was enforced (so a record can name them without parsing the message). */
  readonly limitFailures: readonly { readonly limit: string; readonly enforced: "partial" | "none"; readonly detail: string }[] | undefined;
  constructor(code: SandboxErrorCode, message: string, options?: { cause?: unknown; limitFailures?: readonly { readonly limit: string; readonly enforced: "partial" | "none"; readonly detail: string }[] }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SandboxError";
    this.code = code;
    this.limitFailures = options?.limitFailures;
  }
}

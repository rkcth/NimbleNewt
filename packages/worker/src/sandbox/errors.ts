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
  constructor(code: SandboxErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxError";
    this.code = code;
  }
}

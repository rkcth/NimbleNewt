export type WorkspaceErrorCode =
  /** The path is not a plain relative path inside the workspace (absolute, drive, parent, odd characters, reserved names, too long). */
  | "invalid_path"
  /** The path is or lies inside Git's own data (`.git`, whatever its spelling). Nothing writes, deletes, renames or changes it through the bridge. */
  | "protected_path"
  /** A link, junction or file with another name elsewhere is in the way. */
  | "link_refused"
  /** Another name in the directory is the same name on a case-insensitive or normalising filesystem. */
  | "collision"
  /** The file is not at the version the writer expected. Its change was kept for review. */
  | "stale"
  | "not_found"
  | "unavailable"
  /** A set of files was being written, a step failed and putting back what was already changed also failed in part: the tree is in a mixed state, named in `detail`. */
  | "partial";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  /** For `partial`: the paths put back as they were and the paths that could not be put back. */
  readonly detail?: { readonly restored: readonly string[]; readonly notRestored: readonly string[]; readonly written: readonly string[] };
  constructor(code: WorkspaceErrorCode, message: string, options?: { cause?: unknown; detail?: { restored: readonly string[]; notRestored: readonly string[]; written: readonly string[] } }) {
    super(message, options);
    this.name = "WorkspaceError";
    this.code = code;
    if (options?.detail !== undefined) this.detail = options.detail;
  }
}

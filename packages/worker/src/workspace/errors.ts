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
  | "unavailable";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

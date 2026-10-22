import { WorkspaceError } from "./errors.js";

/** Characters that Unicode treats as invisible and that Git's own checks for `.git` look through (zero-width and bidirectional controls, soft hyphen, joiners, BOM, variation selectors). */
const IGNORABLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC00-\uDFFF]/gu;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const WINDOWS_BAD = /[<>:"|?*\\\u0000-\u001F]/;
export const LIMITS = { component: 255, depth: 64, total: 1024, windowsTotal: 240 } as const;

/**
 * A name as a filesystem that ignores case, normalises Unicode and drops trailing dots and spaces would see it: composed (NFC) form, invisible characters removed, lower case, trailing dots and
 * spaces removed, and anything after a `:` cut off (an NTFS stream name). Two names with the same fold may be the same file.
 */
export function fold(component: string): string {
  const cut = component.split(":")[0] ?? "";
  return cut.normalize("NFKC").replace(IGNORABLE, "").normalize("NFC").toLowerCase().replace(/[. ]+$/u, "");
}

/** Whether a name can be Git's own directory or file: `.git` in any spelling that folds to it, and its short NTFS name `git~1`. */
export function isGitName(component: string): boolean {
  const f = fold(component);
  return f === ".git" || /^git~\d+$/.test(f) || /^gi[0-9a-f]{1,6}~\d+$/.test(f);
}

/** Whether any part of a relative path is Git's own data (the directory, or a worktree's `.git` file, or anything under them). */
export const touchesGit = (parts: readonly string[]): boolean => parts.some(isGitName);

/** The problem with a single name on any of the systems NimbleNewt runs on, or undefined. */
export function nameProblem(component: string, forWindows = process.platform === "win32"): string | undefined {
  if (component.length === 0) return "is empty";
  if (component === "." || component === "..") return "is a relative reference";
  if (Buffer.byteLength(component, "utf8") > LIMITS.component) return `is longer than ${LIMITS.component} bytes`;
  if (WINDOWS_BAD.test(component)) return "holds a character that is not allowed on every system (control characters and < > : \" | ? * \\)";
  if (/[. ]$/u.test(component)) return "ends in a dot or a space, which Windows drops";
  if (forWindows && /~\d+(?:\.[^.]*)?$/u.test(component)) return "looks like a Windows short (8.3) name, which stands for another file";
  const stem = component.split(".")[0] ?? "";
  if (WINDOWS_DEVICE.test(stem.replace(/[. ]+$/u, ""))) return "is a reserved Windows device name";
  return undefined;
}

/**
 * Splits and checks a path the agent or the bridge was given: a plain relative path of `/`-separated names, nothing absolute (a leading `/` or `\`, a drive such as `C:`, a UNC or `\\?\` prefix), no
 * `.` or `..`, no empty parts, no NUL, no name problems, and not longer than the limits (Windows' shorter total applies when `forWindows` is set). Returns the parts.
 */
export function splitRelative(path: unknown, options: { forWindows?: boolean; rootLength?: number } = {}): string[] {
  if (typeof path !== "string" || path.length === 0) throw new WorkspaceError("invalid_path", "a path is a non-empty string");
  if (path.includes("\0")) throw new WorkspaceError("invalid_path", "a path cannot hold a NUL character");
  if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path) || path.startsWith("//") || path.includes("\\")) throw new WorkspaceError("invalid_path", "a path is relative and written with '/' (no drive, root, UNC or backslash)");
  const parts = path.split("/");
  if (parts.length > LIMITS.depth) throw new WorkspaceError("invalid_path", `a path is at most ${LIMITS.depth} names deep`);
  for (const part of parts) {
    const problem = nameProblem(part, options.forWindows ?? process.platform === "win32");
    if (problem !== undefined) throw new WorkspaceError("invalid_path", `the name ${JSON.stringify(part.slice(0, 40))} ${problem}`);
  }
  const limit = options.forWindows === true ? LIMITS.windowsTotal : LIMITS.total;
  if (path.length + (options.rootLength ?? 0) + 1 > limit) throw new WorkspaceError("invalid_path", `the path is longer than ${limit} characters in total`);
  return parts;
}

/** The key under which two paths that may be the same file on a case-insensitive or normalising filesystem collide. */
export const collisionKey = (parts: readonly string[]): string => parts.map(fold).join("/");

/** The groups of paths that collide with each other (more than one distinct spelling per key). */
export function collisions(paths: readonly string[]): string[][] {
  const byKey = new Map<string, Set<string>>();
  for (const p of paths) {
    const key = collisionKey(p.split("/"));
    const set = byKey.get(key) ?? new Set<string>();
    set.add(p);
    byKey.set(key, set);
  }
  return [...byKey.values()].filter((s) => s.size > 1).map((s) => [...s].sort());
}

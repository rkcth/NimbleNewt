import { PLAN_FILE } from "@nimblenewt/contracts";
import { WorkspaceError } from "./errors.js";
import { fold, splitRelative, touchesGit } from "./names.js";

/**
 * Card P05, first slice: the rules of an outside contribution that need no host or network. Which files of a repository are its own contribution guidance and instructions (found and read as they are, never
 * required, never added), and what the diff of a contribution must not carry: files outside what the task intends, NimbleNewt's own state, edits to ignore rules, links or submodules, and secrets.
 * The git side (reading the tree and the blobs) is `GitBridge.instructions` and `GitBridge.contributionCheck`; this module only names and classifies paths.
 */

/** Bounds of the instruction discovery and the contribution check. */
export const CONTRIBUTION_LIMITS = {
  /** Instruction files read per discovery (the rest are counted, not read). */
  instructionFiles: 20,
  /** Characters kept of one instruction file, and of all of them together. */
  instructionChars: 16_000, instructionTotalChars: 64_000,
  /** Bytes of one instruction file read at most (a larger one is cut). */
  instructionBytes: 256 * 1024,
  /** Intended paths or folders one check takes. */
  intended: 200,
  /** Changed files and blocked files a check answer lists (all of them are counted). */
  listed: 500, blockedListed: 100,
  /** Reasons kept per blocked file and characters per reason. */
  reasonChars: 200,
} as const;

export type InstructionKind = "contributing" | "agent-instructions" | "pull-request-template";

/** Names of contribution guidance, compared folded (case, Unicode form). At the repository's top, in `.github/` or in `docs/`. */
const CONTRIBUTING = new Set(["contributing", "contributing.md", "contributing.rst", "contributing.txt", "contributing.adoc", "dco", "dco.md", "dco.txt"]);
/** Instruction files written for coding agents. They apply in any folder (to that folder's part of the tree). */
const AGENT_ANYWHERE = new Set(["agents.md", "agent.md", "claude.md", "gemini.md"]);
/** Agent instruction files that count only at the repository's top (or the one place named). */
const AGENT_TOP = new Set([".cursorrules", ".windsurfrules"]);
const PR_TEMPLATE = new Set(["pull_request_template.md", "pull_request_template.txt", "merge_request_template.md"]);
const GUIDANCE_DIRS = new Set([".github", "docs", ".gitlab"]);

/** Which kind of instruction file a path of the repository is, or undefined (the path is the tree's own spelling; compared folded). */
export function instructionKind(path: string): InstructionKind | undefined {
  const parts = path.split("/");
  if (parts.some((p) => p.length === 0) || touchesGit(parts)) return undefined;
  const folded = parts.map(fold);
  const name = folded[folded.length - 1]!;
  const dirs = folded.slice(0, -1);
  const atTopOrGuidance = dirs.length === 0 || (dirs.length === 1 && GUIDANCE_DIRS.has(dirs[0]!));
  if (CONTRIBUTING.has(name) && atTopOrGuidance) return "contributing";
  if (AGENT_ANYWHERE.has(name)) return "agent-instructions";
  if (AGENT_TOP.has(name) && dirs.length === 0) return "agent-instructions";
  if (name === "copilot-instructions.md" && dirs.length === 1 && dirs[0] === ".github") return "agent-instructions";
  if (PR_TEMPLATE.has(name) && atTopOrGuidance) return "pull-request-template";
  // A folder of templates: `.github/PULL_REQUEST_TEMPLATE/*.md`, `.gitlab/merge_request_templates/*.md`.
  if (dirs.length === 2 && ((dirs[0] === ".github" && dirs[1] === "pull_request_template") || (dirs[0] === ".gitlab" && dirs[1] === "merge_request_templates")) && name.endsWith(".md")) return "pull-request-template";
  return undefined;
}

/** The order instruction files are given in: the top first, then shallower paths, then by kind and path, so the same tree always gives the same list. */
export function instructionOrder(a: { path: string; kind: InstructionKind }, b: { path: string; kind: InstructionKind }): number {
  const depth = (p: string): number => p.split("/").length;
  const rank: Record<InstructionKind, number> = { contributing: 0, "agent-instructions": 1, "pull-request-template": 2 };
  return depth(a.path) - depth(b.path) || rank[a.kind] - rank[b.kind] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * Characters that show nothing, removed from instruction text before anyone reads it: C0/C1 controls other than tab and line breaks, every format character (`\p{Cf}`: zero-width, bidirectional, the soft hyphen, the BOM,
 * and the U+E0000 tag characters, which spell out text no reader sees), the variation selectors (both blocks; a run of them can carry hidden bytes), the combining grapheme joiner and the Hangul fillers (first review).
 */
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

/** Instruction text as it may be shown: valid UTF-8 only (`undefined` for anything else), hidden characters removed, line endings made `\n`, and cut at `max` characters. */
export function instructionText(bytes: Buffer, max: number): { text: string; cut: boolean } | undefined {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
  // The line and paragraph separators (and NEL, a C1 control) end a line for some readers: they become plain line breaks rather than vanish and join two lines into one.
  text = text.replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n").replace(HIDDEN, "");
  if (text.length <= max) return { text, cut: false };
  // Never cut inside a surrogate pair.
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

/** Whether a repository's guidance asks for a sign-off on each commit (a Developer Certificate of Origin): a later contribution commit then carries `Signed-off-by` for its human author. */
export const asksSignOff = (text: string): boolean => /\bsigned-off-by\b|\bDeveloper Certificate of Origin\b|\bDCO\b|\bgit commit -s\b|--signoff\b/i.test(text);

/** Names of NimbleNewt's own state, in any folder (compared folded). A contribution never carries a file under one of them. */
const STATE_DIRS = new Set([".nimblenewt", "nimblenewt-state", ".nn"]);

/**
 * Whether a changed path is NimbleNewt's own state rather than the project's work: anything under a NimbleNewt state folder, Git's own data in any spelling, and the agent's plan file at the top of the checkout when the base did not
 * already hold one (a project's own `PLAN.md` that the base has is the project's file, judged like any other).
 */
export function isNimbleNewtState(path: string, inBase: boolean): boolean {
  const parts = path.split("/");
  if (touchesGit(parts)) return true;
  if (parts.slice(0, -1).some((p) => STATE_DIRS.has(fold(p))) || STATE_DIRS.has(fold(parts[parts.length - 1]!))) return true;
  return parts.length === 1 && fold(parts[0]!) === fold(PLAN_FILE) && !inBase;
}

/**
 * Files that hold ignore rules (for git and the common tools that read their own): an edit to one changes which files a later commit or package carries, so it is made only when the task names that exact file.
 * Git's own settings carried in the tree count the same way (first review): `.gitattributes` (a `filter`, `diff` or `merge` attribute makes git run the driver a reader's configuration names, `export-ignore` and `eol` change what a
 * checkout or archive holds), `.gitmodules` (where a submodule is fetched from, and an `ignore` that hides its changes) and `.lfsconfig` (where large files are fetched from).
 */
const IGNORE_FILES = new Set([".gitignore", ".ignore", ".dockerignore", ".npmignore", ".hgignore", ".prettierignore", ".eslintignore", ".gcloudignore", ".vercelignore", ".slugignore", ".gitattributes", ".gitmodules", ".lfsconfig"]);
export const isIgnoreRuleFile = (path: string): boolean => IGNORE_FILES.has(fold(path.split("/").pop() ?? ""));

/** What a task intends to change: exact paths, and folders written with a trailing `/` (everything under them). Checked and kept in their own spelling. */
export interface IntendedPaths { readonly files: ReadonlySet<string>; readonly folders: readonly string[] }

/**
 * Reads the intended list: at most `CONTRIBUTION_LIMITS.intended` entries, each a plain relative path (the workspace's own path rules) or such a path with one trailing `/`. An empty list intends nothing (every change is unrelated).
 * Anything else (not a list, a pattern, `..`, an absolute path, Git's data) is refused as a whole: a check never runs on a list it could not read.
 */
export function readIntended(value: unknown): IntendedPaths {
  if (!Array.isArray(value)) throw new WorkspaceError("invalid_path", "the intended files are a list of paths and folders (a folder ends in '/')");
  if (value.length > CONTRIBUTION_LIMITS.intended) throw new WorkspaceError("invalid_path", `a contribution names at most ${CONTRIBUTION_LIMITS.intended} intended paths or folders`);
  const files = new Set<string>(); const folders: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new WorkspaceError("invalid_path", "each intended path is a string");
    const folder = entry.endsWith("/");
    const path = folder ? entry.slice(0, -1) : entry;
    const parts = splitRelative(path, { forWindows: false });
    if (touchesGit(parts)) throw new WorkspaceError("protected_path", "an intended path cannot be Git's own data");
    if (folder) folders.push(`${path}/`); else files.add(path);
  }
  return { files, folders };
}

export const isIntended = (path: string, intended: IntendedPaths): boolean => intended.files.has(path) || intended.folders.some((f) => path.startsWith(f));

/** Why a changed file is kept out of a contribution. */
export type ContributionBlock = "unrelated" | "nimblenewt-state" | "ignore-rule" | "link" | "secret" | "unreadable";

/** The plain reason of each kind, said to the agent and the owner. */
export const BLOCK_REASON: Record<Exclude<ContributionBlock, "secret" | "unreadable">, string> = {
  unrelated: "not among the files the task intends to change",
  "nimblenewt-state": "NimbleNewt's own state (a plan, a state folder or Git's data), which never goes into a contribution",
  "ignore-rule": "an edit to ignore rules or to git's attributes or submodule settings, made only when the task names this exact file",
  link: "a link or a submodule entry, which a contribution does not carry",
};

/**
 * Whether a changed path's name could not be checked out or was not read whole (first review): an empty, `.` or `..` part (git's own plumbing can write them into a tree; no checkout takes them), a control character
 * (a line break among them), or U+FFFD, which is what bytes that are not UTF-8 read as here, so the name judged would not be the name in the tree. Only these: a name one system refuses but git checks out (`aux.c`, a `:`) is the project's.
 */
export const unfitName = (path: string): boolean => path.split("/").some((p) => p === "" || p === "." || p === ".." || /[\u0000-\u001F\u007F\uFFFD]/u.test(p));

/** A reason as it is kept: one line, cut. */
export const shortReason = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, CONTRIBUTION_LIMITS.reasonChars);

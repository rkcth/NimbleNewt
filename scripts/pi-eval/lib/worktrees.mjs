// Which sibling worktrees of the repository the agent must not see by default (W01 contamination in batches 6 and 7:
// a run read other cards' work in the shared worktree folders). Pure functions over the text of `git worktree list
// --porcelain -z`, so they are tested with fake lists.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** The common folders this team's worktrees live in (for `roots`; the default hides other worktrees wherever they are). */
export const COMMON_WORKTREE_ROOTS = ["/srv/code/worktrees-pi", "/srv/code/worktrees"];

/**
 * Paths of the `worktree <path>` entries of `git worktree list --porcelain` output, the main checkout first. With `-z`
 * (fields end in NUL) a path may hold any character, a newline too; the newline form is read too (a trailing CR goes,
 * nothing else is trimmed, so a path ending in a space is kept as it is).
 */
export function parseWorktreeList(porcelain) {
  const text = String(porcelain ?? "");
  const fields = text.includes("\0") ? text.split("\0") : text.split("\n").map((l) => l.replace(/\r$/, ""));
  const out = [];
  for (const f of fields) if (f.startsWith("worktree ")) out.push(f.slice("worktree ".length));
  return out.filter((p) => p.length > 0);
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const inside = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

/**
 * The worktrees to hide: every listed worktree except the main checkout (the first entry: a reference folder the run
 * still reads; worktrees nested inside it, such as `.claude/worktrees/*`, are hidden) and any worktree holding it, the
 * bench's own checkouts and any worktree holding one (`keep`: the repository the bench runs from, where its dependencies
 * come from, the bench's own folder, ...; a worktree nested inside a kept one is still hidden), and anything that holds
 * or lies in the work root (the run's own checkout is there; the work root has its own rule). `roots`, when given,
 * limits the result to worktrees lying under one of them; one inside a folder hidden anyway (`alreadyHidden`: /srv/ai,
 * where /srv/code/worktrees leads) is left out, as hiding the whole folder covers it. Paths are compared where they really are (links resolved),
 * whole segment by whole segment (`c07` never matches `c07m`).
 */
export function siblingWorktrees({ porcelain, roots = null, keep = [], workRoot, alreadyHidden = [], resolvePath = real }) {
  const rootsR = roots === null || roots === undefined ? null : roots.map((r) => resolvePath(r));
  const keepR = keep.filter(Boolean).map((k) => resolvePath(k));
  const wr = workRoot ? resolvePath(workRoot) : null;
  const covered = alreadyHidden.filter(Boolean).map((h) => resolvePath(h)).filter((h) => h !== "/");
  const listed = parseWorktreeList(porcelain);
  const main = listed.length > 0 ? resolvePath(listed[0]) : null;
  const out = [];
  for (const w of listed.slice(1)) {
    const p = resolvePath(w);
    if (p === "/" || (main && inside(main, p))) continue;
    if (rootsR !== null && !rootsR.some((r) => p !== r && inside(p, r))) continue;
    if (keepR.some((k) => inside(k, p))) continue;
    if (wr && (inside(p, wr) || inside(wr, p))) continue;
    if (covered.some((h) => p !== h && inside(p, h))) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** `git worktree list --porcelain -z` of the repository, or null when it cannot be listed. */
export function listWorktrees(repo) {
  try { return execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch { return null; }
}

/**
 * The folders to hide from the agent besides the defaults: `--hide a,b` as given (a folder that does not exist is
 * reported through `warn`: there is nothing there to read, but it may be a misspelt name); `--hide none` nothing at all;
 * no `--hide` the repository's other worktrees (see siblingWorktrees; `warn` when there are none). Throws when the
 * default cannot be worked out (the worktrees cannot be listed), for an empty `--hide` and for `none` mixed with
 * folders, so a run never starts less hidden than asked by mistake.
 */
export function hideFolders({ hideOption, list, keep, workRoot, roots, alreadyHidden, resolvePath, warn = () => {}, exists = existsSync }) {
  if (hideOption === undefined) {
    const porcelain = list();
    if (typeof porcelain !== "string") throw new Error("the repository's git worktrees could not be listed, so other cards' worktrees cannot be hidden; no agent was started (name the folders with --hide a,b, or pass --hide none)");
    const out = siblingWorktrees({ porcelain, roots, keep, workRoot, alreadyHidden, resolvePath });
    if (out.length === 0) warn("no other git worktrees of the repository to hide (git worktree list shows none besides the bench's own and the main checkout)");
    return out;
  }
  const parts = String(hideOption).split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("--hide needs folders (comma-separated) or none");
  if (parts.includes("none")) {
    if (parts.length > 1) throw new Error("--hide none cannot be combined with folders");
    return [];
  }
  const out = parts.map((p) => resolve(p));
  for (const p of out) if (!exists(p)) warn(`--hide ${p}: no such folder (nothing there to hide; check the name)`);
  return out;
}

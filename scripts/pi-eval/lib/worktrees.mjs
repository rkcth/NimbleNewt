// Which sibling worktrees of the repository the agent must not see by default (W01 contamination in batches 6 and 7:
// a run read other cards' work in the shared worktree folders). Pure functions over the text of `git worktree list
// --porcelain`, so they are tested with fake lists.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** The common folders worktrees of this team's repositories live in. */
export const COMMON_WORKTREE_ROOTS = ["/srv/code/worktrees-pi", "/srv/code/worktrees"];

/** Paths of the `worktree <path>` lines of `git worktree list --porcelain` output (the main checkout comes first). */
export function parseWorktreeList(porcelain) {
  const out = [];
  for (const line of String(porcelain ?? "").split("\n")) if (line.startsWith("worktree ")) out.push(line.slice("worktree ".length).trim());
  return out.filter(Boolean);
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const inside = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

/**
 * The worktrees to hide: every listed worktree that lies under one of `roots`, except the bench's own checkouts
 * (`keep`: the repository the bench runs from, where its dependencies come from, ...) and anything that holds or lies in
 * the work root (the run's own checkout is there; the work root has its own rule).
 */
export function siblingWorktrees({ porcelain, roots = COMMON_WORKTREE_ROOTS, keep = [], workRoot, resolvePath = real }) {
  const rootsR = roots.map((r) => resolvePath(r));
  const keepR = keep.filter(Boolean).map((k) => resolvePath(k));
  const wr = workRoot ? resolvePath(workRoot) : null;
  const out = [];
  for (const w of parseWorktreeList(porcelain)) {
    const p = resolvePath(w);
    if (!rootsR.some((r) => p !== r && inside(p, r))) continue;
    if (keepR.some((k) => inside(p, k) || inside(k, p))) continue;
    if (wr && (inside(p, wr) || inside(wr, p))) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** `git worktree list --porcelain` of the repository, or "" when it cannot be listed. */
export function listWorktrees(repo) {
  try { return execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }); } catch { return ""; }
}

/**
 * The folders to hide from the agent besides the defaults: `--hide a,b` as given; `--hide none` nothing at all; no
 * `--hide` the repository's other worktrees (see siblingWorktrees).
 */
export function hideFolders({ hideOption, list, keep, workRoot, roots, resolvePath }) {
  if (hideOption === undefined) return siblingWorktrees({ porcelain: list(), roots, keep, workRoot, resolvePath });
  if (hideOption.trim() === "none") return [];
  return hideOption.split(",").filter(Boolean).map((p) => resolve(p));
}

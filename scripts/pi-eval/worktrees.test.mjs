// Offline: fake `git worktree list --porcelain` texts, no git, no Radiance, no model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hideFolders, parseWorktreeList, siblingWorktrees } from "./lib/worktrees.mjs";

const id = (p) => p;
const porcelain = [
  "worktree /srv/code/repos/app", "HEAD aaa", "branch refs/heads/main", "",
  "worktree /srv/code/worktrees-pi/bench-own", "HEAD bbb", "branch refs/heads/own", "",
  "worktree /srv/code/worktrees-pi/card-x", "HEAD ccc", "detached", "",
  "worktree /srv/code/worktrees/card-y", "HEAD ddd", "branch refs/heads/y", "",
  "worktree /srv/code/worktrees-pi/eval-work/eval-1", "HEAD eee", "detached", "",
  "worktree /elsewhere/card-z", "HEAD fff", "branch refs/heads/z", "", "",
].join("\n");

test("worktree list text is parsed to paths", () => {
  assert.equal(parseWorktreeList(porcelain).length, 6);
  assert.deepEqual(parseWorktreeList(""), []);
  assert.deepEqual(parseWorktreeList(undefined), []);
});

test("siblings: the other worktrees under the common folders, not the main checkout, the bench's own, the work root's or outside ones", () => {
  const got = siblingWorktrees({ porcelain, keep: ["/srv/code/worktrees-pi/bench-own"], workRoot: "/srv/code/worktrees-pi/eval-work", resolvePath: id });
  assert.deepEqual(got, ["/srv/code/worktrees-pi/card-x", "/srv/code/worktrees/card-y"]);
});

test("siblings: a worktree named like the kept one's prefix is still hidden; a kept parent keeps its children; roots are overridable; duplicates once", () => {
  const p = porcelain + "worktree /srv/code/worktrees-pi/bench-own-2\nHEAD 1\n\nworktree /srv/code/worktrees-pi/card-x\nHEAD 2\n\n";
  const got = siblingWorktrees({ porcelain: p, keep: ["/srv/code/worktrees-pi/bench-own"], workRoot: "/srv/code/worktrees-pi/eval-work", resolvePath: id });
  assert.deepEqual(got, ["/srv/code/worktrees-pi/card-x", "/srv/code/worktrees/card-y", "/srv/code/worktrees-pi/bench-own-2"]);
  assert.deepEqual(siblingWorktrees({ porcelain, roots: ["/elsewhere"], resolvePath: id }), ["/elsewhere/card-z"]);
  assert.deepEqual(siblingWorktrees({ porcelain, keep: ["/srv/code/worktrees-pi"], roots: ["/srv/code/worktrees-pi"], resolvePath: id }), []);
  assert.deepEqual(siblingWorktrees({ porcelain: "", resolvePath: id }), []);
});

test("hide option: none given means the sibling worktrees, an explicit list replaces them, none turns it off", () => {
  const base = { list: () => porcelain, keep: ["/srv/code/worktrees-pi/bench-own"], workRoot: "/srv/code/worktrees-pi/eval-work", resolvePath: id };
  assert.deepEqual(hideFolders({ ...base, hideOption: undefined }), ["/srv/code/worktrees-pi/card-x", "/srv/code/worktrees/card-y"]);
  assert.deepEqual(hideFolders({ ...base, hideOption: "/a/b,,/c" }), ["/a/b", "/c"]);
  assert.deepEqual(hideFolders({ ...base, hideOption: "none" }), []);
  let called = false;
  hideFolders({ ...base, list: () => { called = true; return ""; }, hideOption: "none" });
  assert.equal(called, false, "no listing when hiding is off");
});

// Offline: fake `git worktree list --porcelain` texts (git runs once, on a folder that does not exist), no Radiance, no model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMON_WORKTREE_ROOTS, hideFolders, listWorktrees, parseWorktreeList, siblingWorktrees } from "./lib/worktrees.mjs";

const id = (p) => p;
const entries = [
  ["/srv/code/repos/app", "HEAD aaa", "branch refs/heads/main"],
  ["/srv/code/worktrees-pi/bench-own", "HEAD bbb", "branch refs/heads/own"],
  ["/srv/code/worktrees-pi/card-x", "HEAD ccc", "detached"],
  ["/srv/code/worktrees/card-y", "HEAD ddd", "branch refs/heads/y", "locked"],
  ["/srv/code/worktrees-pi/eval-work/eval-1", "HEAD eee", "detached"],
  ["/elsewhere/card-z", "HEAD fff", "branch refs/heads/z", "prunable gitdir file points to non-existent location"],
  ["/srv/code/repos/app/.claude/worktrees/agent-1", "HEAD ggg", "branch refs/heads/agent-1"],
];
const nl = entries.map(([p, ...rest]) => [`worktree ${p}`, ...rest, ""].join("\n")).join("\n");
const z = entries.map(([p, ...rest]) => [`worktree ${p}`, ...rest, ""].join("\0")).join("\0");
const base = { keep: ["/srv/code/repos/app", "/srv/code/worktrees-pi/bench-own"], workRoot: "/srv/code/worktrees-pi/eval-work", resolvePath: id };
const expected = ["/srv/code/worktrees-pi/card-x", "/srv/code/worktrees/card-y", "/elsewhere/card-z", "/srv/code/repos/app/.claude/worktrees/agent-1"];

test("worktree list text is parsed to paths, NUL-separated (-z) or by lines", () => {
  assert.deepEqual(parseWorktreeList(nl), entries.map((e) => e[0]));
  assert.deepEqual(parseWorktreeList(z), entries.map((e) => e[0]));
  assert.deepEqual(parseWorktreeList(""), []);
  assert.deepEqual(parseWorktreeList(undefined), []);
  // -z keeps a path with a newline, spaces (also trailing) whole; a CR of a CRLF line goes.
  assert.deepEqual(parseWorktreeList("worktree /a/b c\nworktree d \0HEAD 1\0\0worktree /e\0\0"), ["/a/b c\nworktree d ", "/e"]);
  assert.deepEqual(parseWorktreeList("worktree /a b \r\nHEAD 1\r\n\r\n"), ["/a b "]);
});

test("siblings: every other worktree (nested ones in the main checkout too), not the main checkout, the bench's own or the work root's", () => {
  assert.deepEqual(siblingWorktrees({ porcelain: z, ...base }), expected);
  assert.deepEqual(siblingWorktrees({ porcelain: nl, ...base }), expected);
});

test("siblings: whole segments only; a worktree nested in a kept one is hidden, one holding a kept folder is not", () => {
  const p = z + "worktree /srv/code/worktrees-pi/bench-own-2\0HEAD 1\0\0worktree /srv/code/worktrees-pi/card-x\0HEAD 2\0\0"
    + "worktree /srv/code/worktrees-pi/bench-own/.claude/worktrees/agent-2\0HEAD 3\0\0worktree /srv/code/worktrees-pi/c07\0HEAD 4\0\0"
    + "worktree /srv/code/worktrees-pi/c07m\0HEAD 5\0\0";
  const got = siblingWorktrees({ porcelain: p, ...base, keep: [...base.keep, "/srv/code/worktrees-pi/c07m/scripts/pi-eval"] });
  assert.deepEqual(got, [...expected, "/srv/code/worktrees-pi/bench-own-2", "/srv/code/worktrees-pi/bench-own/.claude/worktrees/agent-2", "/srv/code/worktrees-pi/c07"]);
  // A trailing slash in a kept folder or the work root changes nothing.
  assert.deepEqual(siblingWorktrees({ porcelain: z, ...base, keep: ["/srv/code/repos/app/", "/srv/code/worktrees-pi/bench-own/"], workRoot: "/srv/code/worktrees-pi/eval-work/" }), expected);
});

test("siblings: the work root is never hidden, nor a worktree holding it", () => {
  const p = z + "worktree /srv/code/worktrees-pi/holder\0HEAD 1\0\0";
  const got = siblingWorktrees({ porcelain: p, ...base, workRoot: "/srv/code/worktrees-pi/holder/eval-work" });
  assert.equal(got.includes("/srv/code/worktrees-pi/holder"), false);
  assert.equal(got.includes("/srv/code/worktrees-pi/eval-work/eval-1"), true, "not in this work root");
});

test("siblings: roots limit, folders hidden anyway cover theirs, links compared where they lead, empty input", () => {
  assert.deepEqual(siblingWorktrees({ porcelain: z, ...base, roots: COMMON_WORKTREE_ROOTS }), expected.slice(0, 2));
  assert.deepEqual(siblingWorktrees({ porcelain: z, ...base, alreadyHidden: ["/srv/code/worktrees", "/"] }), [expected[0], expected[2], expected[3]]);
  // /srv/code/worktrees is a link to /srv/ai/code-worktrees: a worktree listed by either spelling is the same one.
  const link = (p) => p.replace(/^\/srv\/code\/worktrees(?=\/|$)/, "/srv/ai/code-worktrees");
  const p = "worktree /srv/code/repos/app\0\0worktree /srv/ai/code-worktrees/w\0\0worktree /srv/code/worktrees/w\0\0worktree /srv/code/worktrees/bench\0\0";
  assert.deepEqual(siblingWorktrees({ porcelain: p, keep: ["/srv/ai/code-worktrees/bench"], resolvePath: link }), ["/srv/ai/code-worktrees/w"]);
  assert.deepEqual(siblingWorktrees({ porcelain: p, keep: ["/srv/code/worktrees/w/x"], resolvePath: link }), ["/srv/ai/code-worktrees/bench"]);
  assert.deepEqual(siblingWorktrees({ porcelain: "", resolvePath: id }), []);
  assert.deepEqual(siblingWorktrees({ porcelain: "worktree /srv/code/repos/app\0\0worktree /srv/code\0\0worktree /\0\0", resolvePath: id }), [], "a worktree holding the main checkout stays");
});

test("hide option: none given means the sibling worktrees, an explicit list replaces them, none turns it off", () => {
  const warned = [];
  const opts = { ...base, list: () => z, warn: (m) => warned.push(m), exists: (p) => p === "/a/b" };
  assert.deepEqual(hideFolders({ ...opts, hideOption: undefined }), expected);
  assert.deepEqual(warned, []);
  assert.deepEqual(hideFolders({ ...opts, hideOption: "/a/b,,/c/" }), ["/a/b", "/c"]);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /\/c: no such folder/);
  assert.deepEqual(hideFolders({ ...opts, hideOption: "none" }), []);
  assert.deepEqual(hideFolders({ ...opts, hideOption: " none " }), []);
  let called = false;
  hideFolders({ ...opts, list: () => { called = true; return ""; }, hideOption: "none" });
  assert.equal(called, false, "no listing when hiding is off");
});

test("hide option: nothing starts less hidden than asked by mistake", () => {
  const warned = [];
  const opts = { ...base, warn: (m) => warned.push(m), exists: () => true };
  assert.throws(() => hideFolders({ ...opts, list: () => null, hideOption: undefined }), /could not be listed/);
  assert.throws(() => hideFolders({ ...opts, list: () => z, hideOption: "" }), /needs folders/);
  assert.throws(() => hideFolders({ ...opts, list: () => z, hideOption: " , " }), /needs folders/);
  assert.throws(() => hideFolders({ ...opts, list: () => z, hideOption: "none,/a" }), /cannot be combined/);
  // Nothing to hide is said, not silent.
  assert.deepEqual(hideFolders({ ...opts, list: () => "worktree /srv/code/repos/app\0\0", hideOption: undefined }), []);
  assert.match(warned[0], /no other git worktrees/);
});

test("listing: a folder git cannot list gives null and git's reason", () => {
  const reasons = [];
  assert.equal(listWorktrees("/nonexistent/pi-eval-worktrees-test", { onError: (m) => reasons.push(m) }), null);
  assert.equal(reasons.length, 1);
  assert.ok(reasons[0].length > 0);
});

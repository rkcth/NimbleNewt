import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, HOST_LIMITS, WorkspaceHost, type CheckoutLocation, type HostWorkspaceCall } from "./index.js";

// Card H12p: the author's own refresh as a host operation (`reapply`), against a real checkout with real git: changed and new files survive, conflicts are listed and never resolved,
// no quiesce is asked for, the shared repository is only read, and the detail stays small enough for the controller to keep.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const detailOf = (r: { ok: boolean }): Record<string, any> => ((r as unknown as { detail?: Record<string, any> }).detail ?? {});
const reasonOf = (r: { ok: boolean }): string => (r as unknown as { reason: string }).reason;
const summaryOf = (r: { ok: boolean }): string => (r as unknown as { summary: string }).summary;
const lines = (n: number, edit?: [number, string]): string => Array.from({ length: n }, (_, i) => (edit !== undefined && edit[0] === i ? edit[1] : `line ${i}`)).join("\n") + "\n";

let counter = 0;
const rid = (): string => { const n = (++counter).toString(32).padStart(4, "a").replace(/[018-9]/g, (c) => ({ "0": "a", "1": "b", "8": "c", "9": "d" } as Record<string, string>)[c]!); return `wsr-${"abcdefgh".repeat(3).slice(0, 16)}${n.slice(-4)}`; };
const call = (operation: HostWorkspaceCall["operation"], more: Partial<HostWorkspaceCall> = {}): HostWorkspaceCall => ({ requestId: rid(), operation, taskId: "tsk-one", projectId: "prj-one", reason: "test", quietAttempts: [], ...more });

async function world(extra: Partial<ConstructorParameters<typeof WorkspaceHost>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nn-rah-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "README.md"), "hello\n"); await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n"); await writeFile(join(shared, "src", "b.ts"), "export const b = 1;\n");
  await writeFile(join(shared, "doc.txt"), lines(20));
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const where: CheckoutLocation = { shared, checkout: join(dir, "checkout"), gitDir: join(dir, "task.git"), bridgeState: join(dir, "state"), quarantineRoot: join(dir, "quarantine") };
  const first = await git.head(shared);
  await git.createCheckout({ shared, commit: first, gitDir: where.gitDir, checkout: where.checkout });
  const host = new WorkspaceHost({ git, journal: join(dir, "journal"), locate: ({ taskId }) => (taskId === "tsk-one" ? where : undefined), clock: () => "2026-11-13T10:00:00.000Z", landing: () => ({ branch: "main", requirePermit: false }), ...extra });
  const advance = async (files: Record<string, string | null>): Promise<string> => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) await rm(join(shared, path)); else { await mkdir(join(shared, path, ".."), { recursive: true }); await writeFile(join(shared, path), content); }
    }
    sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "next");
    return sh(shared, "rev-parse", "HEAD");
  };
  const sharedState = (): string => [sh(shared, "rev-parse", "HEAD"), sh(shared, "status", "--porcelain=v1", "--ignored"), sh(shared, "for-each-ref")].join("|");
  return { dir, shared, git, where, host, first, advance, sharedState, done: async () => { await rm(dir, { recursive: true, force: true }); } };
}

test("reapply keeps the agent's changed and new files over a branch that moved in unrelated files, takes the landing files, and leaves the shared repository alone", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(w.where.checkout, "mine.ts"), "export const m = 1;\n");
    const head = await w.advance({ "README.md": "hello again\n", "other.ts": "export const o = 1;\n" });
    const before = w.sharedState();
    const r = await w.host.run(call("reapply"));
    assert.equal(r.ok, true, JSON.stringify(r));
    const d = detailOf(r);
    assert.deepEqual([d["changed"], d["base"], d["before"], d["kept"], d["taken"], d["merged"], d["conflictCount"], d["conflicts"]], [true, head, w.first, 2, 2, 0, 0, []]);
    assert.match(summaryOf(r), /no conflicts/);
    assert.equal(await readFile(join(w.where.checkout, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(await readFile(join(w.where.checkout, "mine.ts"), "utf8"), "export const m = 1;\n");
    assert.equal(await readFile(join(w.where.checkout, "README.md"), "utf8"), "hello again\n");
    assert.equal(await readFile(join(w.where.checkout, "other.ts"), "utf8"), "export const o = 1;\n");
    assert.equal(await w.git.baseOf(w.where.gitDir), head);
    assert.equal(w.sharedState(), before, "the shared repository is only read");
    // The same head again: nothing is done and it says so.
    const again = await w.host.run(call("reapply"));
    assert.deepEqual([again.ok, detailOf(again)["changed"]], [true, false]);
    assert.match(summaryOf(again), /nothing to refresh/);
  } finally { await w.done(); }
});

test("reapply over a branch that moved in the same file merges edits that do not overlap, and lists overlapping edits with markers without resolving them", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "doc.txt"), lines(20, [2, "mine two"]));
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 'mine';\n");
    await w.advance({ "doc.txt": lines(20, [15, "landing fifteen"]), "src/a.ts": "export const a = 'landing';\n" });
    const r = await w.host.run(call("reapply"));
    assert.equal(r.ok, true, JSON.stringify(r));
    const d = detailOf(r);
    assert.equal(d["merged"], 1, "doc.txt merged line by line");
    assert.deepEqual(d["conflicts"], [{ path: "src/a.ts", kind: "overlap" }]);
    assert.equal(d["conflictCount"], 1);
    assert.match(summaryOf(r), /NOT resolved/);
    const doc = await readFile(join(w.where.checkout, "doc.txt"), "utf8");
    assert.ok(doc.includes("mine two") && doc.includes("landing fifteen") && !doc.includes("<<<<<<<"));
    const a = await readFile(join(w.where.checkout, "src", "a.ts"), "utf8");
    assert.ok(a.includes("<<<<<<< mine") && a.includes("'mine'") && a.includes("'landing'") && a.includes(">>>>>>> landing"), "the file keeps both sides and the markers");
    // A file one side deleted and the other changed is listed too, and the agent's side stays.
    const w2 = await world();
    try {
      await writeFile(join(w2.where.checkout, "src", "b.ts"), "export const b = 2;\n");
      await w2.advance({ "src/b.ts": null });
      const r2 = await w2.host.run(call("reapply"));
      assert.deepEqual(detailOf(r2)["conflicts"], [{ path: "src/b.ts", kind: "deleted-there" }]);
      assert.equal(await readFile(join(w2.where.checkout, "src", "b.ts"), "utf8"), "export const b = 2;\n");
    } finally { await w2.done(); }
  } finally { await w.done(); }
});

test("reapply is not held back by a running attempt (no quiesce), where every other operation on the checkout still is", { skip }, async () => {
  let quiet = false;
  const w = await world({ attemptsQuiet: () => quiet });
  try {
    await w.advance({ "other.ts": "export const o = 1;\n" });
    // The attempt is running (not quiet): a refresh and an integration are refused, the author's own refresh is made.
    const refused = await w.host.run(call("refresh", { quietAttempts: ["att-1"] }));
    assert.equal(refused.ok, false); assert.match(reasonOf(refused), /attempt of the task is running/);
    const r = await w.host.run(call("reapply", { quietAttempts: [] }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(detailOf(r)["changed"], true);
  } finally { await w.done(); }
});

test("a repeated reapply request ID is carried out once (the recorded answer comes back), and one on another task or an unknown checkout is refused as typed values", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "mine.ts"), "export const m = 1;\n");
    await w.advance({ "other.ts": "export const o = 1;\n" });
    const c = call("reapply");
    const first = await w.host.run(c);
    await w.advance({ "third.ts": "export const t = 1;\n" });
    const repeat = await w.host.run(c);
    assert.deepEqual(repeat, first, "the recorded answer, not a second refresh");
    assert.equal(await w.git.baseOf(w.where.gitDir) === sh(w.shared, "rev-parse", "HEAD"), false, "the repeat did not move the base again");
    const other = await w.host.run({ ...c, taskId: "tsk-unknown" });
    assert.equal(other.ok, false);
    const reused = await w.host.run({ ...c, operation: "refresh" });
    assert.equal(reused.ok, false); assert.match(reasonOf(reused), /another operation or task/);
  } finally { await w.done(); }
});

test("the detail of a reapply with many conflicts is bounded: at most the listed count, each path cut, the whole under the byte limit, and the rest counted", { skip }, async () => {
  const w = await world();
  try {
    // Han characters (three bytes each in UTF-8) under four folders: long names that need no Hangul (which a Mac would decompose) and stay under the folder name limit.
    const han = (k: number): string => Array.from({ length: 25 }, (_, i) => String.fromCodePoint(0x4e00 + ((k * 31 + i * 7) % 500))).join("");
    const names = Array.from({ length: 30 }, (_, k) => `${han(k)}/${han(k + 100)}/${han(k + 200)}/${han(k + 300)}/f.txt`);
    for (const n of names) { await mkdir(join(w.shared, n, ".."), { recursive: true }); await writeFile(join(w.shared, n), "base\n"); }
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "many");
    const start = await w.git.head(w.shared);
    await w.git.refresh({ shared: w.shared, commit: start, gitDir: w.where.gitDir, checkout: w.where.checkout });
    for (const n of names) await writeFile(join(w.where.checkout, n), "mine\n");
    await w.advance(Object.fromEntries(names.map((n) => [n, "landing\n"])));
    const r = await w.host.run(call("reapply"));
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    const d = detailOf(r);
    assert.equal(d["conflictCount"], 30);
    assert.ok(d["conflicts"].length <= HOST_LIMITS.conflictsListed && d["conflicts"].length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(d), "utf8") <= HOST_LIMITS.detailBytes, "small enough for the controller to keep");
    assert.equal(d["conflicts"].length + (d["conflictsNotListed"] as number), 30, "what is not listed is counted");
    for (const c of d["conflicts"]) assert.ok(c.path.length <= HOST_LIMITS.conflictPath);
    assert.ok(summaryOf(r).length <= HOST_LIMITS.summary);
  } finally { await w.done(); }
});

test("reapply refuses a landing branch change that is a link, as a value, and changes nothing", { skip: skip || (process.platform === "win32" ? "symbolic links need a privilege on Windows" : false) }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "mine.ts"), "export const m = 1;\n");
    const { symlink } = await import("node:fs/promises");
    await symlink("README.md", join(w.shared, "lnk"));
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "link");
    const base = await w.git.baseOf(w.where.gitDir);
    const r = await w.host.run(call("reapply"));
    assert.equal(r.ok, false); assert.match(reasonOf(r), /link/);
    assert.equal(await w.git.baseOf(w.where.gitDir), base);
    assert.equal(await readFile(join(w.where.checkout, "mine.ts"), "utf8"), "export const m = 1;\n");
  } finally { await w.done(); }
});

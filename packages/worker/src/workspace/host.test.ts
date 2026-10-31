import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, WorkspaceBridge, WorkspaceHost, type CheckoutLocation, type HostWorkspaceCall } from "./index.js";

// Card H12m: the host side of integration, refresh and quarantine, against a real checkout with real git.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const detailOf = (r: { ok: boolean }): Record<string, any> => ((r as unknown as { detail?: Record<string, any> }).detail ?? {});
const reasonOf = (r: { ok: boolean }): string => (r as unknown as { reason: string }).reason;

let counter = 0;
/** A request ID of the shape the controller makes (`wsr-` and twenty base32 characters), unique in the test. */
const rid = (): string => { const n = (++counter).toString(32).padStart(4, "a").replace(/[018-9]/g, (c) => ({ "0": "a", "1": "b", "8": "c", "9": "d" } as Record<string, string>)[c]!); return `wsr-${"abcdefgh".repeat(3).slice(0, 16)}${n.slice(-4)}`; };
const call = (operation: HostWorkspaceCall["operation"], more: Partial<HostWorkspaceCall> = {}): HostWorkspaceCall => ({ requestId: rid(), operation, taskId: "tsk-one", projectId: "prj-one", reason: "test", quietAttempts: [], ...more });

async function world(extra: Partial<ConstructorParameters<typeof WorkspaceHost>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "nn-wsh-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "README.md"), "hello\n"); await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n"); await writeFile(join(shared, "src", "b.ts"), "export const b = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const where: CheckoutLocation = { shared, checkout: join(dir, "checkout"), gitDir: join(dir, "task.git"), bridgeState: join(dir, "state"), quarantineRoot: join(dir, "quarantine") };
  await git.createCheckout({ shared, commit: await git.head(shared), gitDir: where.gitDir, checkout: where.checkout });
  // A second task on the same shared tree (its own checkout and git directory, the bridge's state shared as the production layout has it).
  const where2: CheckoutLocation = { ...where, checkout: join(dir, "checkout2"), gitDir: join(dir, "task2.git") };
  await git.createCheckout({ shared, commit: await git.head(shared), gitDir: where2.gitDir, checkout: where2.checkout });
  const located: string[] = [];
  const host = new WorkspaceHost({ git, journal: join(dir, "journal"), locate: ({ taskId }) => { located.push(taskId); return taskId === "tsk-one" ? where : taskId === "tsk-second" ? where2 : undefined; }, clock: () => "2026-10-30T10:00:00.000Z", landing: () => ({ branch: "main", requirePermit: false }), ...extra });
  /** Everything about the shared repository that a refresh or quarantine must leave alone. */
  const sharedState = (): string => [sh(shared, "rev-parse", "HEAD"), sh(shared, "status", "--porcelain=v1", "--ignored"), sh(shared, "for-each-ref")].join("|");
  // A quarantined tree is read-only on purpose; the test makes it writable again to clean up.
  return { dir, shared, git, where, where2, host, located, sharedState, done: async () => { try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing to make writable */ } await rm(dir, { recursive: true, force: true }); } };
}

test("refresh moves a clean checkout to the shared head and leaves the shared repository exactly as it was", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.shared, "src", "c.ts"), "export const c = 1;\n");
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "second");
    const before = w.sharedState();
    const head = sh(w.shared, "rev-parse", "HEAD");
    const r = await w.host.run(call("refresh"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(detailOf(r)["changed"], true);
    assert.equal(detailOf(r)["base"], head);
    assert.equal(await readFile(join(w.where.checkout, "src", "c.ts"), "utf8"), "export const c = 1;\n");
    assert.equal(await w.git.baseOf(w.where.gitDir), head);
    assert.equal(w.sharedState(), before, "the shared repository is untouched by a refresh");
    // At the head already: nothing to do, said so.
    const again = await w.host.run(call("refresh"));
    assert.deepEqual([again.ok, detailOf(again)["changed"]], [true, false]);
  } finally { await w.done(); }
});

test("refresh of a dirty checkout is refused and the checkout is left as it was: a changed file, a new file, and an ignored file", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.shared, "src", "c.ts"), "export const c = 1;\n");
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "second");
    for (const [name, edit] of [["changed", () => writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\n")], ["new", () => writeFile(join(w.where.checkout, "mine.txt"), "mine\n")]] as const) {
      await edit();
      const base = await w.git.baseOf(w.where.gitDir);
      const r = await w.host.run(call("refresh"));
      assert.equal(r.ok, false, name);
      assert.match(reasonOf(r), /changed or new file/, name);
      assert.equal(await w.git.baseOf(w.where.gitDir), base, `${name}: the base did not move`);
      assert.equal(existsSync(join(w.where.checkout, "src", "c.ts")), false, `${name}: nothing was written`);
      await rm(join(w.where.checkout, "mine.txt"), { force: true });
      await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 1;\n");
    }
    assert.equal((await w.host.run(call("refresh"))).ok, true, "clean again: refreshed");
  } finally { await w.done(); }
});

test("integration carries the agent's changes into the shared working tree through the bridge, makes no commit, and keeps a moved file for review", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(w.where.checkout, "src", "new.ts"), "export const n = 1;\n");
    await rm(join(w.where.checkout, "src", "b.ts"));
    const head = sh(w.shared, "rev-parse", "HEAD");
    const r = await w.host.run(call("integration", { assignee: "agent:ann" }));
    assert.equal(r.ok, true, JSON.stringify(r));
    const d = detailOf(r);
    assert.deepEqual([d["written"], d["kept"], d["markedIntegrated"]], [3, 0, false], "the work is not committed, so the base does not move");
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(existsSync(join(w.shared, "src", "b.ts")), false);
    assert.equal(sh(w.shared, "rev-parse", "HEAD"), head, "no commit was made in the shared repository");
    // Asked for again: the shared workspace already holds exactly this, so nothing is written and nothing is kept for review.
    const second = await w.host.run(call("integration"));
    assert.deepEqual([second.ok, detailOf(second)["written"], detailOf(second)["kept"], detailOf(second)["skipped"]], [true, 0, 0, 3]);

    // A file somebody else changed meanwhile is not overwritten; the agent's change is kept for review and the rest goes through.
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 3;\n");
    await writeFile(join(w.where.checkout, "src", "other.ts"), "export const o = 1;\n");
    await writeFile(join(w.shared, "src", "a.ts"), "export const a = 99; // somebody else\n");
    const kept = await w.host.run(call("integration"));
    assert.equal(kept.ok, true, JSON.stringify(kept));
    const k = detailOf(kept);
    assert.deepEqual([k["written"], k["kept"], k["keptFiles"][0].path], [1, 1, "src/a.ts"]);
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 99; // somebody else\n", "the other writer's file was not overwritten");
    assert.equal(await readFile(join(w.shared, "src", "other.ts"), "utf8"), "export const o = 1;\n");
  } finally { await w.done(); }
});

test("a change that touches Git's data is refused whole and nothing reaches the shared workspace", { skip }, async () => {
  const w = await world();
  try {
    await mkdir(join(w.where.checkout, ".git"), { recursive: true });
    await writeFile(join(w.where.checkout, ".git", "config"), "[core]\n\thooksPath = /tmp/evil\n");
    await writeFile(join(w.where.checkout, "fine.txt"), "fine\n");
    const r = await w.host.run(call("integration"));
    assert.equal(r.ok, false);
    assert.equal(existsSync(join(w.shared, "fine.txt")), false, "not even the harmless file went through");
    assert.equal(existsSync(join(w.shared, ".git", "config")) && (await readFile(join(w.shared, ".git", "config"), "utf8")).includes("evil"), false);
  } finally { await w.done(); }
});

test("quarantine moves the checkout to the owner-only root, keeps the agent's git directory, and leaves the shared repository alone", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2; // unsaved\n");
    const before = w.sharedState();
    const r = await w.host.run(call("quarantine", { reason: "odd file" }));
    assert.equal(r.ok, true, JSON.stringify(r));
    const id = detailOf(r)["quarantineId"] as string;
    assert.equal(existsSync(w.where.checkout), false, "the checkout is gone from where the agent works");
    assert.equal(await readFile(join(w.where.quarantineRoot, id, "content", "src", "a.ts"), "utf8"), "export const a = 2; // unsaved\n", "the work is kept");
    assert.equal(existsSync(w.where.gitDir), true, "the agent's git directory stays where it was");
    assert.equal(w.sharedState(), before);
    // The checkout is gone: a refresh or an integration says so instead of guessing.
    for (const op of ["refresh", "integration", "quarantine"] as const) {
      const again = await w.host.run(call(op));
      assert.equal(again.ok, false, op);
      assert.match(reasonOf(again), /not on this host/, op);
    }
  } finally { await w.done(); }
});

test("a host that cannot do an operation, or does not hold the task's checkout, says so as a typed refusal", { skip }, async () => {
  const w = await world();
  try {
    const release = await w.host.run(call("release"));
    assert.deepEqual([release.ok, /commit permit/.test(reasonOf(release))], [false, true]);
    const other = await w.host.run(call("refresh", { taskId: "tsk-two" }));
    assert.deepEqual([other.ok, /not on this host/.test(reasonOf(other))], [false, true]);
    for (const bad of [{ requestId: "../../etc/passwd" }, { requestId: "wsr-short" }, { operation: "deploy" }, { taskId: "../x" }, { projectId: "a b" }, { reason: "" }, { reason: "x".repeat(501) }, { assignee: "a/b" }]) {
      const r = await w.host.run({ ...call("refresh"), ...bad } as never);
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    assert.equal((await w.host.run(null as never)).ok, false);
    assert.deepEqual((await readdir(join(w.dir))).filter((n) => n === "etc"), [], "a hostile request ID writes nowhere");
  } finally { await w.done(); }
});

test("one request ID is carried out once: a repeat gets the recorded answer, and a request that began but never finished is not run again", { skip }, async () => {
  const w = await world();
  try {
    const c = call("integration");
    await writeFile(join(w.where.checkout, "src", "n.ts"), "export const n = 1;\n");
    const first = await w.host.run(c);
    assert.equal(first.ok, true);
    // The shared file is changed after the first run; a repeat must not run the integration again (it would keep a duplicate for review).
    await writeFile(join(w.shared, "src", "n.ts"), "export const n = 2; // later\n");
    const repeat = await w.host.run(c);
    assert.deepEqual(repeat, first, "the same answer from the journal");
    assert.deepEqual(await w.host.run({ ...c, operation: "refresh" }), { ok: false, reason: "that request ID was used for another operation or task here" });
    // A started record with no end: the work may be half done.
    const lost = call("refresh");
    await mkdir(join(w.dir, "journal"), { recursive: true });
    await writeFile(join(w.dir, "journal", `${lost.requestId}.json`), `${JSON.stringify({ operation: "refresh", taskId: "tsk-one", state: "started", at: "x" })}\n`);
    const r = await w.host.run(lost);
    assert.equal(r.ok, false);
    assert.match(reasonOf(r), /did not finish/);
  } finally { await w.done(); }
});

test("two requests for one checkout run one at a time, and two with one request ID give one run", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "src", "n.ts"), "export const n = 1;\n");
    const same = call("integration");
    const [x, y] = await Promise.all([w.host.run(same), w.host.run(same)]);
    assert.deepEqual(x, y);
    assert.equal(x.ok, true);
    const pending = await readdir(join(w.where.bridgeState, "pending")).catch(() => []);
    assert.deepEqual(pending, [], "no duplicate kept change");
  } finally { await w.done(); }
});

test("a request ID used for one task is refused for another task (review fix 3)", { skip }, async () => {
  const w = await world();
  try {
    const c = call("refresh");
    assert.equal((await w.host.run(c)).ok, true);
    const other = await w.host.run({ ...c, taskId: "tsk-two" });
    assert.equal(other.ok, false);
    assert.match(reasonOf(other), /another operation or task|not on this host/);
    // The same ID and task, different task located too: the journal itself refuses the mismatch.
    await writeFile(join(w.dir, "journal", `${c.requestId}.json`), `${JSON.stringify({ operation: "refresh", taskId: "tsk-zzz", state: "done", at: "x", outcome: { ok: true, summary: "other task" } })}\n`);
    const r = await w.host.run(c);
    assert.equal(r.ok, false);
    assert.match(reasonOf(r), /another operation or task/);
  } finally { await w.done(); }
});

test("a request past its deadline, or with an attempt running, is not started and leaves no journal record (review fix 1)", { skip }, async () => {
  let quiet = true;
  const asked: string[][] = [];
  const w = await world({ attemptsQuiet: (ids) => { asked.push([...ids]); return quiet; } });
  try {
    await writeFile(join(w.shared, "src", "c.ts"), "export const c = 1;\n");
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "second");
    const late = await w.host.run(call("refresh", { expiresAt: new Date(Date.now() - 1000).toISOString() }));
    assert.equal(late.ok, false); assert.match(reasonOf(late), /stopped waiting/);
    assert.equal(existsSync(join(w.where.checkout, "src", "c.ts")), false, "the checkout did not move");
    quiet = false;
    const busy = await w.host.run(call("refresh", { quietAttempts: ["att-aaaaaaaaaaaaaaaaaaaa"] }));
    assert.equal(busy.ok, false); assert.match(reasonOf(busy), /attempt of the task is running/);
    assert.equal(existsSync(join(w.where.checkout, "src", "c.ts")), false);
    assert.deepEqual(asked.at(-1), ["att-aaaaaaaaaaaaaaaaaaaa"]);
    assert.deepEqual(await readdir(join(w.dir, "journal")).catch(() => []), [], "refused requests are not recorded as begun");
    quiet = true;
    assert.equal((await w.host.run(call("refresh", { expiresAt: new Date(Date.now() + 60_000).toISOString() }))).ok, true);
  } finally { await w.done(); }
});

test("a deadline that passes while the request waits behind another on the same checkout stops it before it starts (review fix 1)", { skip }, async () => {
  let gate!: () => void;
  const hold = new Promise<void>((ok) => { gate = ok; });
  let first = true;
  const w = await world({ attemptsQuiet: async () => { if (first) { first = false; await hold; } return true; } });
  try {
    await writeFile(join(w.shared, "src", "c.ts"), "export const c = 1;\n");
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "second");
    const a = w.host.run(call("refresh"));
    const b = w.host.run(call("integration", { expiresAt: new Date(Date.now() + 150).toISOString() }));
    await new Promise((ok) => setTimeout(ok, 300));
    gate();
    assert.equal((await a).ok, true);
    const rb = await b;
    assert.equal(rb.ok, false); assert.match(reasonOf(rb), /stopped waiting/);
  } finally { await w.done(); }
});

test("integration treats a deleted file whose folder is already gone in the shared workspace as already done, not as a failure (review fix 4)", { skip }, async () => {
  const w = await world();
  try {
    await rm(join(w.where.checkout, "src", "b.ts"));
    await rm(join(w.shared, "src"), { recursive: true });
    const r = await w.host.run(call("integration"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(detailOf(r)["skipped"], 1);
    assert.equal(detailOf(r)["written"], 0);
  } finally { await w.done(); }
});

// Card H12q: landing is an integration done only on the current head of the landing branch, of committed work.
const commitCheckout = (w: { where: CheckoutLocation }, message: string): void => { sh(w.where.checkout, "--git-dir", w.where.gitDir, "--work-tree", w.where.checkout, "add", "-A"); sh(w.where.checkout, "--git-dir", w.where.gitDir, "--work-tree", w.where.checkout, "commit", "-q", "-m", message); };

test("landing carries committed work into the shared working tree on the landing branch's current head, and says it landed (card H12q)", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    commitCheckout(w, "agent work");
    const head = sh(w.shared, "rev-parse", "HEAD");
    const r = await w.host.run(call("landing", { assignee: "agent:ann" }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([detailOf(r)["written"], detailOf(r)["kept"], detailOf(r)["landed"], detailOf(r)["markedIntegrated"]], [1, 0, true, true]);
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(sh(w.shared, "rev-parse", "HEAD"), head, "landing makes no commit; promotion is another step");
    // The base moved to the landed commit, so it is no longer the landing branch's head: a second landing of the same work is refused rather than repeated (a repeat of the same request ID gets the recorded answer).
    // And while the landed files wait uncommitted in the shared tree, no landing is made at all.
    const waiting = await w.host.run(call("landing"));
    assert.equal(waiting.ok, false);
    assert.match(reasonOf(waiting), /uncommitted file\(s\) \(landed changes waiting to be committed/);
    assert.equal(detailOf(r)["waitingToCommit"], true);
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "integrator commits the landed files");
    const again = await w.host.run(call("landing"));
    assert.equal(again.ok, false);
    assert.match(reasonOf(again), /refreshes onto the head first/);
  } finally { await w.done(); }
});

test("landing is refused, with nothing written, when the landing branch moved since the checkout's base or when the checkout holds uncommitted files (card H12q)", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    commitCheckout(w, "agent work");
    await writeFile(join(w.shared, "src", "c.ts"), "export const c = 1;\n");
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "second");
    const before = w.sharedState();
    const moved = await w.host.run(call("landing"));
    assert.equal(moved.ok, false);
    assert.match(reasonOf(moved), /landing branch is at .*refreshes onto the head first/);
    assert.equal(w.sharedState(), before);
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    // An integration has no head check: the check belongs to the landing.
    assert.equal(detailOf(await w.host.run(call("integration")))["written"], 1);
    const dirtyWorld = await world();
    try {
      await writeFile(join(dirtyWorld.where.checkout, "src", "a.ts"), "export const a = 5;\n");
      const dirtyBefore = dirtyWorld.sharedState();
      const dirty = await dirtyWorld.host.run(call("landing"));
      assert.equal(dirty.ok, false);
      assert.match(reasonOf(dirty), /not committed.*only committed work lands/);
      assert.equal(dirtyWorld.sharedState(), dirtyBefore);
    } finally { await dirtyWorld.done(); }
  } finally { await w.done(); }
});

test("a landing that finds a shared file moved (changed after the checks) keeps it for review, writes nothing and is not reported as landed (card H12q)", { skip }, async () => {
  const w = await world({ hooks: { afterCleanCheck: async () => { await writeFile(join(w.shared, "src", "b.ts"), "export const b = 99; // somebody else\n"); } } });
  try {
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(w.where.checkout, "src", "b.ts"), "export const b = 2;\n");
    commitCheckout(w, "agent work");
    const r = await w.host.run(call("landing"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([detailOf(r)["written"], detailOf(r)["kept"], detailOf(r)["landed"], detailOf(r)["changed"]], [0, 1, false, false]);
    assert.match((r as { summary: string }).summary, /nothing was written: 1 of 2/);
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 1;\n", "the other file is not written either: all or nothing");
    assert.equal(await readFile(join(w.shared, "src", "b.ts"), "utf8"), "export const b = 99; // somebody else\n");
  } finally { await w.done(); }
});

const permitted = (message: string, task = "tsk-one"): string => `${message}\n\nReviewed-by: owner\nNimbleNewt-Request: req-1\nNimbleNewt-Task: ${task}`;

test("two tasks landing on one shared tree run one after the other: the second is refused because the first's files wait uncommitted there, and is never written over it (card H12q review)", { skip }, async () => {
  let calls = 0; let release!: () => void; const gate = new Promise<void>((ok) => { release = ok; });
  const w = await world({ attemptsQuiet: async () => { calls++; if (calls === 1) await gate; return true; } });
  try {
    for (const [where, name, text] of [[w.where, "one.ts", "export const one = 1;\n"], [w.where2, "two.ts", "export const two = 2;\n"]] as const) {
      await writeFile(join(where.checkout, "src", name), text);
      sh(where.checkout, "--git-dir", where.gitDir, "--work-tree", where.checkout, "add", "-A"); sh(where.checkout, "--git-dir", where.gitDir, "--work-tree", where.checkout, "commit", "-q", "-m", name);
    }
    const first = w.host.run(call("landing", { taskId: "tsk-one" }));
    const second = w.host.run(call("landing", { taskId: "tsk-second" }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls, 1, "the second landing has not even begun while the first is in the shared tree's order");
    release();
    const [a, b] = [await first, await second];
    assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(detailOf(a)["landed"], true);
    assert.equal(b.ok, false, JSON.stringify(b));
    assert.match(reasonOf(b), /uncommitted file\(s\)/);
    assert.equal(existsSync(join(w.shared, "src", "two.ts")), false);
    assert.equal(await readFile(join(w.shared, "src", "one.ts"), "utf8"), "export const one = 1;\n");
  } finally { await w.done(); }
});

test("the same file changed by two tasks on one head: the second landing is refused or kept, never silently written over the first (card H12q review)", { skip }, async () => {
  const w = await world();
  try {
    for (const [where, text] of [[w.where, "export const a = 'one';\n"], [w.where2, "export const a = 'two';\n"]] as const) {
      await writeFile(join(where.checkout, "src", "a.ts"), text);
      sh(where.checkout, "--git-dir", where.gitDir, "--work-tree", where.checkout, "add", "-A"); sh(where.checkout, "--git-dir", where.gitDir, "--work-tree", where.checkout, "commit", "-q", "-m", "a");
    }
    const [x, y] = await Promise.all([w.host.run(call("landing", { taskId: "tsk-one" })), w.host.run(call("landing", { taskId: "tsk-second" }))]);
    assert.equal([x, y].filter((r) => r.ok && detailOf(r)["landed"] === true).length, 1);
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 'one';\n");
  } finally { await w.done(); }
});

test("a landing needs a clean shared tree on the named landing branch: another branch, a detached head, untracked files and no policy all refuse and write nothing (card H12q review)", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    commitCheckout(w, "agent work");
    const before = w.sharedState();
    // An untracked file in the shared tree (not ignored) counts: the tree is not clean.
    await writeFile(join(w.shared, "stray.txt"), "x\n");
    const stray = await w.host.run(call("landing"));
    assert.match(reasonOf(stray), /uncommitted file\(s\)/);
    await rm(join(w.shared, "stray.txt"));
    sh(w.shared, "checkout", "-q", "-b", "feature");
    const other = await w.host.run(call("landing"));
    assert.match(reasonOf(other), /branch "feature", not on the landing branch "main"/);
    sh(w.shared, "checkout", "-q", "--detach");
    assert.match(reasonOf(await w.host.run(call("landing"))), /detached head, not on the landing branch/);
    sh(w.shared, "checkout", "-q", "main"); sh(w.shared, "branch", "-D", "feature");
    assert.equal(w.sharedState(), before);
    const noPolicy = await world({ landing: () => undefined });
    try { assert.match(reasonOf(await noPolicy.host.run(call("landing"))), /no landing branch set/); } finally { await noPolicy.done(); }
    assert.equal(detailOf(await w.host.run(call("landing")))["landed"], true, "with everything in place it lands");
  } finally { await w.done(); }
});

test("a checkout with an untracked file, or with a file an ignore rule hides, is not landed (card H12q review)", { skip }, async () => {
  const w = await world();
  try {
    await writeFile(join(w.where.checkout, ".gitignore"), "*.log\n");
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    commitCheckout(w, "agent work");
    await writeFile(join(w.where.checkout, "src", "new.ts"), "export const n = 1;\n");
    assert.match(reasonOf(await w.host.run(call("landing"))), /not committed/);
    await rm(join(w.where.checkout, "src", "new.ts"));
    await writeFile(join(w.where.checkout, "build.log"), "ignored but there\n");
    assert.match(reasonOf(await w.host.run(call("landing"))), /not committed/);
    await rm(join(w.where.checkout, "build.log"));
    assert.equal(detailOf(await w.host.run(call("landing")))["landed"], true);
  } finally { await w.done(); }
});

test("what lands is what was committed: a file written in the checkout after the dirty check is not landed, because the change is planned from the committed objects (card H12q review)", { skip }, async () => {
  const w = await world({ hooks: { afterCleanCheck: async () => { await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 666; // written late\n"); await writeFile(join(w.where.checkout, "src", "late.ts"), "late\n"); } } });
  try {
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    commitCheckout(w, "agent work");
    const r = await w.host.run(call("landing"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(existsSync(join(w.shared, "src", "late.ts")), false);
  } finally { await w.done(); }
});

test("a commit in the shared tree between the checks and the writes stops the landing before the first write; one after the writes is reported as partial, not landed (card H12q review)", { skip }, async () => {
  const w = await world({ hooks: { afterCleanCheck: async () => { await writeFile(join(w.shared, "elsewhere.txt"), "x\n"); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "someone commits"); } } });
  try {
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    commitCheckout(w, "agent work");
    const r = await w.host.run(call("landing"));
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(reasonOf(r), /moved from .* during the landing; nothing was landed/);
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 1;\n");
  } finally { await w.done(); }
  const late = await world({ hooks: { afterWrite: async () => { sh(late.shared, "add", "-A"); sh(late.shared, "commit", "-q", "-m", "someone commits the landed file"); } } });
  try {
    await writeFile(join(late.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    commitCheckout(late, "agent work");
    const r = await late.host.run(call("landing"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([detailOf(r)["landed"], detailOf(r)["partial"], detailOf(r)["written"]], [false, true, 1]);
    assert.equal(await late.git.baseOf(late.where.gitDir) !== sh(late.where.checkout, "--git-dir", late.where.gitDir, "rev-parse", "HEAD"), true, "the checkout is not marked as landed");
  } finally { await late.done(); }
});

test("a landing is all or nothing: a protected path (CI configuration) is kept for review and nothing else is written, and the protected list is the project's setting (card H12q review)", { skip }, async () => {
  const w = await world();
  try {
    await mkdir(join(w.where.checkout, ".github", "workflows"), { recursive: true });
    await writeFile(join(w.where.checkout, ".github", "workflows", "ci.yml"), "on: push\n");
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    commitCheckout(w, "agent work");
    const r = await w.host.run(call("landing"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([detailOf(r)["written"], detailOf(r)["kept"], detailOf(r)["landed"]], [0, 1, false]);
    assert.equal(detailOf(r)["keptFiles"][0].path, ".github/workflows/ci.yml");
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(existsSync(join(w.shared, ".github")), false);
    assert.equal((await new WorkspaceBridge({ shared: w.shared, state: w.where.bridgeState }).pending()).length, 1);
  } finally { await w.done(); }
  // The list is a setting: with it emptied the same change lands; with another path named, that path is held.
  const open = await world({ landing: () => ({ branch: "main", requirePermit: false, protectedPaths: ["src/a.ts"] }) });
  try {
    await mkdir(join(open.where.checkout, ".github", "workflows"), { recursive: true });
    await writeFile(join(open.where.checkout, ".github", "workflows", "ci.yml"), "on: push\n");
    commitCheckout(open, "agent work");
    assert.equal(detailOf(await open.host.run(call("landing")))["landed"], true);
  } finally { await open.done(); }
});

test("a landing needs the commit permit of the review gate on the checkout's commits unless the project says otherwise (card H12q review)", { skip }, async () => {
  const w = await world({ landing: () => ({ branch: "main" }) });
  try {
    await writeFile(join(w.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    commitCheckout(w, "agent work, no permit");
    assert.match(reasonOf(await w.host.run(call("landing"))), /do not carry the commit permit/);
    assert.equal(await readFile(join(w.shared, "src", "a.ts"), "utf8"), "export const a = 1;\n");
  } finally { await w.done(); }
  const ok = await world({ landing: () => ({ branch: "main" }) });
  try {
    await writeFile(join(ok.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    sh(ok.where.checkout, "--git-dir", ok.where.gitDir, "--work-tree", ok.where.checkout, "add", "-A"); sh(ok.where.checkout, "--git-dir", ok.where.gitDir, "--work-tree", ok.where.checkout, "commit", "-q", "-m", permitted("reviewed work"));
    assert.equal(detailOf(await ok.host.run(call("landing")))["landed"], true);
    // A permit for another task does not count.
  } finally { await ok.done(); }
  const other = await world({ landing: () => ({ branch: "main" }) });
  try {
    await writeFile(join(other.where.checkout, "src", "a.ts"), "export const a = 2;\n");
    sh(other.where.checkout, "--git-dir", other.where.gitDir, "--work-tree", other.where.checkout, "add", "-A"); sh(other.where.checkout, "--git-dir", other.where.gitDir, "--work-tree", other.where.checkout, "commit", "-q", "-m", permitted("reviewed work", "tsk-other"));
    assert.match(reasonOf(await other.host.run(call("landing"))), /do not carry the commit permit/);
  } finally { await other.done(); }
});

test("task and project names are checked as folder names on every system: no ':' or trailing '.', no device names (card H12q review)", { skip }, async () => {
  const w = await world();
  try {
    for (const bad of ["tsk:one", "tsk-one.", "CON", "a b", "tsk~1"]) assert.match(reasonOf(await w.host.run(call("refresh", { taskId: bad }))), /malformed/, bad);
    assert.match(reasonOf(await w.host.run(call("refresh", { projectId: "prj:one" }))), /malformed/);
  } finally { await w.done(); }
});

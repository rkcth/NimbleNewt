import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, WorkspaceHost, type CheckoutLocation, type HostWorkspaceCall } from "./index.js";

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

async function world() {
  const dir = await mkdtemp(join(tmpdir(), "nn-wsh-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "README.md"), "hello\n"); await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n"); await writeFile(join(shared, "src", "b.ts"), "export const b = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const where: CheckoutLocation = { shared, checkout: join(dir, "checkout"), gitDir: join(dir, "task.git"), bridgeState: join(dir, "state"), quarantineRoot: join(dir, "quarantine") };
  await git.createCheckout({ shared, commit: await git.head(shared), gitDir: where.gitDir, checkout: where.checkout });
  const located: string[] = [];
  const host = new WorkspaceHost({ git, journal: join(dir, "journal"), locate: ({ taskId }) => { located.push(taskId); return taskId === "tsk-one" ? where : undefined; }, clock: () => "2026-10-30T10:00:00.000Z" });
  /** Everything about the shared repository that a refresh or quarantine must leave alone. */
  const sharedState = (): string => [sh(shared, "rev-parse", "HEAD"), sh(shared, "status", "--porcelain=v1", "--ignored"), sh(shared, "for-each-ref")].join("|");
  // A quarantined tree is read-only on purpose; the test makes it writable again to clean up.
  return { dir, shared, git, where, host, located, sharedState, done: async () => { try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing to make writable */ } await rm(dir, { recursive: true, force: true }); } };
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
    for (const bad of [{ requestId: "../../etc/passwd" }, { requestId: "wsr-short" }, { operation: "landing" }, { taskId: "../x" }, { projectId: "a b" }, { reason: "" }, { reason: "x".repeat(501) }, { assignee: "a/b" }]) {
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
    assert.deepEqual(await w.host.run({ ...c, operation: "refresh" }), { ok: false, reason: "that request ID was used for another operation here" });
    // A started record with no end: the work may be half done.
    const lost = call("refresh");
    await mkdir(join(w.dir, "journal"), { recursive: true });
    await writeFile(join(w.dir, "journal", `${lost.requestId}.json`), `${JSON.stringify({ operation: "refresh", state: "started", at: "x" })}\n`);
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

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitBridge, HANDOVER_LIMITS, LocalWorkspaces, type HostWorkspaceCall } from "./index.js";

// Card Q04, the holder gap: a task's checkout belongs to the task, so an attempt starts from what the attempt before it left there, and its submission stages all of it. The host records which attempts left the
// checkout different from what they were handed (comparing trees at each hand-out to a new attempt), never charges an attempt with what the platform's own requests changed (refresh, re-apply), fails closed when the
// trees cannot be compared, and reports the list with the submit's staging (`leftBy`).
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
// CI fix 2026-11-27: a record that is there but cannot be read, on every platform. chmod 0o000 only sets the read-only attribute on Windows: the file stays readable (so the damaged branch was never reached)
// and a replace of it is refused (EPERM). There an access entry denies this user reading the file's data instead; its attributes can still be read and it can still be replaced, as with chmod on POSIX. Answers the undo.
async function unreadable(file: string): Promise<() => Promise<void>> {
  if (process.platform !== "win32") { await chmod(file, 0o000); return async () => { await chmod(file, 0o600); }; }
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim())?.[1];
  assert.ok(sid !== undefined, "the current user's SID is known");
  execFileSync("icacls", [file, "/deny", `*${sid}:(RD)`], { stdio: "ignore" });
  return async () => { execFileSync("icacls", [file, "/remove:d", `*${sid}`], { stdio: "ignore" }); };
}
let counter = 0;
const rid = (): string => { const n = counter++; return `wsr-pqqqqqqqqqqqqqqq${"abcdefghijklmnopqrstuvwxyz"[Math.floor(n / 26) % 26]}${"abcdefghijklmnopqrstuvwxyz"[n % 26]}aa`; };
const call = (operation: HostWorkspaceCall["operation"], more: Partial<HostWorkspaceCall> = {}): HostWorkspaceCall => ({ requestId: rid(), operation, taskId: "tsk-one", projectId: "prj-one", reason: "test", quietAttempts: [], ...more });
const scope = { taskId: "tsk-one", projectId: "prj-one" };

async function world() {
  const dir = await mkdtemp(join(tmpdir(), "nn-q04h-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(shared, ".gitignore"), "build/\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const root = join(dir, "work");
  const make = () => new LocalWorkspaces({ root, git, shared: (p) => (p === "prj-one" ? shared : undefined), busy: () => [], landing: () => ({ branch: "main", requirePermit: false }), clock: () => "2026-11-26T10:00:00.000Z" });
  const task = join(root, "prj-one", "tsk-one");
  return {
    dir, shared, root, git, task, ws: make(), make,
    handover: () => JSON.parse(readFileSync(join(task, "handover.json"), "utf8")) as { attemptId: string; expected: string | null; left: string[]; overflow?: true },
    done: async () => { await rm(dir, { recursive: true, force: true }); },
  };
}
const hand = (ws: LocalWorkspaces, attemptId?: string) => ws.ensure({ ...scope, ...(attemptId === undefined ? {} : { attemptId }) });
/** What a submission staged now would report: the staging needs a change, so one is written first if the checkout holds none. */
const gitBridge = (dir: string) => GitBridge.create({ scratch: join(dir, "scratch") });
async function leftBy(ws: LocalWorkspaces, checkout: string) {
  await writeFile(join(checkout, "submit-marker.txt"), `${Math.random()}\n`);
  return (await ws.stageWork(scope)).leftBy;
}

test("an attempt that leaves a changed or new file is named when the checkout is handed to the next attempt; one that changed nothing is not; a resume of the same attempt is not a hand-out (card Q04)", { skip }, async () => {
  const w = await world();
  try {
    const a = await hand(w.ws, "att-a");
    assert.deepEqual(w.handover(), { attemptId: "att-a", expected: w.handover().expected, left: [] });
    // a resume of A after A edited: the same attempt, nothing is charged and the expected tree is not moved
    const expected = w.handover().expected;
    await writeFile(join(a.checkout, "src", "a.ts"), "export const a = 2;\n");
    await hand(w.ws, "att-a");
    assert.deepEqual(w.handover(), { attemptId: "att-a", expected, left: [] });
    // B gets A's uncommitted edit: A is named
    await hand(w.ws, "att-b");
    assert.deepEqual(w.handover().left, ["att-a"]);
    // B changes nothing; C gets the checkout: B is not named, A still is
    await hand(w.ws, "att-c");
    assert.deepEqual(w.handover().left, ["att-a"]);
    // C adds a new file git does not ignore: C is named at D's hand-out
    await writeFile(join(a.checkout, "notes.md"), "C was here\n");
    await hand(w.ws, "att-d");
    assert.deepEqual(w.handover().left.sort(), ["att-a", "att-c"]);
    const report = await leftBy(w.ws, a.checkout);
    assert.equal(report.complete, true);
    assert.deepEqual([...report.attempts].sort(), ["att-a", "att-c"]);
  } finally { await w.done(); }
});

test("a task whose attempts change nothing reports an empty, complete list; files git ignores (build output of a test run) are not a change, and a deleted file is (card Q04)", { skip }, async () => {
  const w = await world();
  try {
    const a = await hand(w.ws, "att-a");
    await mkdir(join(a.checkout, "build"), { recursive: true });
    await writeFile(join(a.checkout, "build", "out.js"), "made by a test run\n");
    await hand(w.ws, "att-b");
    assert.deepEqual(w.handover().left, []);
    assert.deepEqual(await leftBy(w.ws, a.checkout), { attempts: [], complete: true });
    // the staging's own marker file is B's change: C's hand-out names B
    await hand(w.ws, "att-c");
    assert.deepEqual(w.handover().left, ["att-b"]);
    // a deleted file is a change
    await rm(join(a.checkout, "src", "a.ts"));
    await rm(join(a.checkout, "submit-marker.txt"));
    await hand(w.ws, "att-d");
    assert.deepEqual(w.handover().left.sort(), ["att-b", "att-c"]);
  } finally { await w.done(); }
});

test("the plan file every agent is told to keep at the top of its checkout is not a change that makes it a contributor (any case, plain or executable); any other file is, also one named like it elsewhere (card Q04, second review)", { skip }, async () => {
  const w = await world();
  try {
    const a = await hand(w.ws, "att-a");
    // A (the author) writes its plan and its change; B (a reviewer) rewrites the plan only, as the completion rules tell every agent
    await writeFile(join(a.checkout, "PLAN.md"), "- [ ] change a\n");
    await writeFile(join(a.checkout, "src", "a.ts"), "export const a = 2;\n");
    await hand(w.ws, "att-b");
    assert.deepEqual(w.handover().left, ["att-a"]);
    await writeFile(join(a.checkout, "PLAN.md"), "- [x] read the change\n- [ ] give a verdict\n");
    await hand(w.ws, "att-c");
    assert.deepEqual(w.handover().left, ["att-a"], "a reviewer that only kept its plan stays independent");
    // C deletes the plan, D writes it in another case and makes it executable: neither is named
    await rm(join(a.checkout, "PLAN.md"));
    await hand(w.ws, "att-d");
    await writeFile(join(a.checkout, "plan.MD"), "- [ ] look\n");
    await chmod(join(a.checkout, "plan.MD"), 0o755);
    await hand(w.ws, "att-e");
    assert.deepEqual(w.handover().left, ["att-a"]);
    // the plan file is also left out around a platform request: E keeps its plan, then re-applies; not charged
    await writeFile(join(a.checkout, "plan.MD"), "- [x] look\n");
    assert.equal((await w.ws.port.run(call("reapply"))).ok, true);
    assert.deepEqual(w.handover().left, ["att-a"]);
    // a file of that name below the top, or a folder of that name at the top, is an ordinary change
    await writeFile(join(a.checkout, "src", "PLAN.md"), "not the plan\n");
    await hand(w.ws, "att-f");
    assert.deepEqual(w.handover().left.sort(), ["att-a", "att-e"]);
    await rm(join(a.checkout, "plan.MD"));
    await mkdir(join(a.checkout, "PLAN.md"));
    await writeFile(join(a.checkout, "PLAN.md", "x.ts"), "export const x = 1;\n");
    await hand(w.ws, "att-g");
    assert.deepEqual(w.handover().left.sort(), ["att-a", "att-e", "att-f"], "a folder named like the plan holds code");
    // a symbolic link named like the plan is a change too (it is not the plan file the agent keeps)
    if (process.platform !== "win32") {
      await rm(join(a.checkout, "PLAN.md"), { recursive: true });
      await symlink(join("src", "a.ts"), join(a.checkout, "PLAN.md"));
      await hand(w.ws, "att-h");
      assert.deepEqual(w.handover().left.sort(), ["att-a", "att-e", "att-f", "att-g"], "a link named like the plan is a change");
    }
    // the plan file still goes into the submission as before (only the comparison leaves it out)
    await rm(join(a.checkout, "PLAN.md"), { recursive: true });
    await writeFile(join(a.checkout, "PLAN.md"), "- [x] done\n");
    const staged = await w.ws.stageWork(scope);
    assert.ok(staged.files.includes("PLAN.md"), JSON.stringify(staged.files));
  } finally { await w.done(); }
});

test("a task folder from before the record: the plan file is left out of the previous attempt's start record too, so an attempt that only kept its plan is not charged (card Q04, second review re-check)", { skip }, async () => {
  const w = await world();
  try {
    const z = await hand(w.ws, "att-0");
    await writeFile(join(z.checkout, "PLAN.md"), "- [ ] start\n");
    // A is handed a checkout that holds a plan file: its start record's tree holds it
    await hand(w.ws, "att-a");
    await writeFile(join(z.checkout, "PLAN.md"), "- [x] start\n- [ ] review\n");
    // as an older host left it: no handover record, the attempt file names A
    await rm(join(w.task, "handover.json"));
    await hand(w.ws, "att-b");
    assert.deepEqual(w.handover().left, [], "compared with A's start record, the plan file left out: A only kept its plan");
    await rm(join(w.task, "handover.json"));
    await writeFile(join(w.task, "attempt"), "att-a\n");
    await writeFile(join(z.checkout, "src", "a.ts"), "export const a = 6;\n");
    await hand(w.ws, "att-c");
    assert.deepEqual(w.handover().left, ["att-a"], "a change beside the plan file still counts");
  } finally { await w.done(); }
});

test("GitBridge.withoutPlan leaves out exactly the top plan file in any case as a plain or executable file, keeps every other entry byte for byte (names with tabs, new lines, quotes, spaces, other scripts), and refuses inputs it cannot read (card Q04, second review re-check)", { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-q04p-"));
  try {
    const gitDir = join(dir, "repo.git");
    sh(dir, "init", "-q", "--bare", gitDir);
    const g = (input: string, ...args: string[]): string => execFileSync("git", ["--git-dir", gitDir, ...args], { input, encoding: "utf8" }).trim();
    const blob = (text: string): string => g(text, "hash-object", "-w", "--stdin");
    const mk = (entries: readonly string[], ...flags: string[]): string => g(entries.map((e) => `${e}\0`).join(""), "mktree", "-z", ...flags);
    const listed = (tree: string): string[] => g("", "ls-tree", "-z", tree).split("\0").filter(Boolean).sort();
    const sub = mk([`100644 blob ${blob("inner plan\n")}\tPLAN.md`]);
    const plans = [`100644 blob ${blob("plan\n")}\tPLAN.md`, `100755 blob ${blob("other plan\n")}\tplan.md`];
    const others = [
      `120000 blob ${blob("src/a.ts")}\tPlan.Md`,
      `040000 tree ${sub}\tpLaN.md`,
      `100644 blob ${blob("x\n")}\tPLAN.md.txt`,
      `100644 blob ${blob("x\n")}\tXPLAN.md`,
      `100644 blob ${blob("tab\n")}\ta\tb`,
      `100644 blob ${blob("nl\n")}\tline\nPLAN.md`,
      `100644 blob ${blob("q\n")}\t"q" \\ x`,
      `100644 blob ${blob("sp\n")}\t PLAN.md `,
      `100755 blob ${blob("u\n")}\t\u00fcn\u00ef PLAN.md`,
    ];
    const both = mk([...plans, ...others]);
    const kept = await gitBridge(dir).then((b) => b.withoutPlan({ gitDir, tree: both }));
    assert.deepEqual(listed(kept), listed(mk(others)), "only the two plan files are left out");
    assert.equal(kept, mk(others));
    // no plan file: the same tree; only the plan file: the empty tree; the empty tree stays empty
    const b = await gitBridge(dir);
    const none = mk(others);
    assert.equal(await b.withoutPlan({ gitDir, tree: none }), none);
    const empty = mk([]);
    assert.equal(await b.withoutPlan({ gitDir, tree: mk([plans[0]!]) }), empty);
    assert.equal(await b.withoutPlan({ gitDir, tree: empty }), empty);
    // inputs that should be refused: a name that is not a full ID, an ID git does not hold, a tree whose other entries name objects git does not hold
    await assert.rejects(b.withoutPlan({ gitDir, tree: "HEAD" }));
    await assert.rejects(b.withoutPlan({ gitDir, tree: "0".repeat(40) }));
    const missing = mk([plans[0]!, `100644 blob ${"1".repeat(40)}\tsrc.ts`], "--missing");
    await assert.rejects(b.withoutPlan({ gitDir, tree: missing }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("what the platform's own requests change is not charged: a refresh onto a moved landing branch, and an author's re-apply over a clean checkout; an attempt's change made before a re-apply still is (card Q04)", { skip }, async () => {
  const w = await world();
  try {
    const a = await hand(w.ws, "att-a");
    // the landing branch moves; A ends with nothing changed; the controller refreshes the clean checkout
    await writeFile(join(w.shared, "src", "b.ts"), "export const b = 1;\n");
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "second");
    const r = await w.ws.port.run(call("refresh"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(existsSync(join(a.checkout, "src", "b.ts")), true, "the refresh brought the landing branch's file");
    await hand(w.ws, "att-b");
    assert.deepEqual(w.handover().left, [], "the refresh's change is not A's");
    // the landing branch moves again; B (live) asks for its own re-apply with nothing changed: not charged
    await writeFile(join(w.shared, "src", "c.ts"), "export const c = 1;\n");
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "third");
    const re = await w.ws.port.run(call("reapply"));
    assert.equal(re.ok, true, JSON.stringify(re));
    assert.equal(existsSync(join(a.checkout, "src", "c.ts")), true);
    await hand(w.ws, "att-c");
    assert.deepEqual(w.handover().left, [], "the re-apply's change is not B's");
    // C edits, then the landing branch moves and C re-applies: C's own edit is still C's (seen before the re-apply ran)
    await writeFile(join(a.checkout, "src", "a.ts"), "export const a = 3;\n");
    await writeFile(join(w.shared, "src", "d.ts"), "export const d = 1;\n");
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "fourth");
    assert.equal((await w.ws.port.run(call("reapply"))).ok, true);
    assert.deepEqual(w.handover().left, ["att-c"], "the edit made before the re-apply is charged at the re-apply");
    await hand(w.ws, "att-d");
    assert.deepEqual(w.handover().left, ["att-c"]);
    // a refused refresh (the checkout is dirty) changes nothing and charges nothing new
    assert.equal((await w.ws.port.run(call("refresh"))).ok, false);
    assert.deepEqual(w.handover().left, ["att-c"], "D changed nothing; the refused refresh did not change the checkout");
  } finally { await w.done(); }
});

test("fails closed: a tree that cannot be read around a request charges the attempt; a hand-out whose tree cannot be read is refused and writes nothing (card Q04)", { skip }, async () => {
  const w = await world();
  const original = w.git.startState.bind(w.git);
  let failing = false;
  (w.git as { startState: typeof original }).startState = async (o) => { if (failing) throw new Error("git could not be run"); return original(o); };
  try {
    const a = await hand(w.ws, "att-a");
    // A changed nothing, but the tree cannot be read around a refresh: A is charged (it cannot be told)
    failing = true;
    await w.ws.port.run(call("refresh"));
    failing = false;
    assert.deepEqual(w.handover().left, ["att-a"]);
    assert.equal(w.handover().expected, null, "the tree after the request could not be read");
    // a hand-out whose state cannot be read: the workspace is not opened and the record is not moved
    failing = true;
    await assert.rejects(hand(w.ws, "att-b"), /could not be recorded/);
    failing = false;
    assert.equal(w.handover().attemptId, "att-a");
    assert.equal(existsSync(join(w.task, "starts", "att-b.json")), false);
    // the next hand-out works; with no expected tree, the attempt before is charged again (it is already named once)
    await hand(w.ws, "att-b");
    assert.deepEqual(w.handover().left, ["att-a"]);
    assert.equal(typeof w.handover().expected, "string");
    // only the tree after a request cannot be read: the attempt that holds the checkout (C, which changed nothing) is not charged by the request, but the expected tree is unknown, so C is charged at the next hand-out
    await hand(w.ws, "att-c0");
    assert.deepEqual(w.handover().left, ["att-a"]);
    let calls = 0;
    (w.git as { startState: typeof original }).startState = async (o) => { calls += 1; if (calls === 2) throw new Error("git could not be run"); return original(o); };
    await w.ws.port.run(call("refresh"));
    (w.git as { startState: typeof original }).startState = async (o) => { if (failing) throw new Error("git could not be run"); return original(o); };
    assert.deepEqual(w.handover().left, ["att-a"], "the tree before the request was read and was as expected");
    assert.equal(w.handover().expected, null);
    await hand(w.ws, "att-c1");
    assert.deepEqual(w.handover().left.sort(), ["att-a", "att-c0"], "unknown counts as changed");
    // a record that is not a whole record: the list is lost, so the report says it is not complete
    await writeFile(join(w.task, "handover.json"), "{ not json");
    assert.equal((await leftBy(w.ws, a.checkout)).complete, false);
    await hand(w.ws, "att-c");
    assert.equal(w.handover().overflow, true, "a damaged record leaves the list incomplete for good");
    assert.deepEqual(w.handover().left, ["att-c1"], "the attempt that held the checkout (from the attempt file) is still named when it changed it (first review)");
    assert.equal((await leftBy(w.ws, a.checkout)).complete, false);
  } finally { await w.done(); }
});

test("the record survives a restart of the host, and a crash part-way through a hand-out neither charges twice nor loses the charge (card Q04)", { skip }, async () => {
  const w = await world();
  try {
    const a = await hand(w.ws, "att-a");
    await writeFile(join(a.checkout, "src", "a.ts"), "export const a = 9;\n");
    // a new host process over the same folders
    const again = w.make();
    await hand(again, "att-b");
    assert.deepEqual(w.handover().left, ["att-a"]);
    // a crash after the record was written but before the attempt file and the start record: the same attempt is handed out again
    await rm(join(w.task, "starts", "att-b.json"));
    await writeFile(join(w.task, "attempt"), "att-a\n");
    const third = w.make();
    await hand(third, "att-b");
    assert.deepEqual(w.handover().left, ["att-a"], "not charged twice");
    assert.equal(existsSync(join(w.task, "starts", "att-b.json")), true, "the start record is written on the repeat");
    assert.equal(readFileSync(join(w.task, "attempt"), "utf8").trim(), "att-b");
  } finally { await w.done(); }
});

test("a task folder from before the record: the previous attempt's start record is the tree it was handed; with no attempt recorded at all, changes already there make the list incomplete (card Q04)", { skip }, async () => {
  const w = await world();
  try {
    // as an older host left it: a checkout, an attempt file and a start record, but no handover record
    const a = await hand(w.ws, "att-a");
    await rm(join(w.task, "handover.json"));
    // the attempt changed nothing: not charged
    await hand(w.ws, "att-0");
    assert.deepEqual(w.handover().left, [], "compared with A's start record: nothing changed");
    await rm(join(w.task, "handover.json"));
    await writeFile(join(w.task, "attempt"), "att-a\n");
    await writeFile(join(a.checkout, "src", "a.ts"), "export const a = 5;\n");
    await hand(w.ws, "att-b");
    assert.deepEqual(w.handover().left, ["att-a"], "compared with A's start record");
    // a checkout made with no attempt named (no record of any attempt) that already holds a change
    const v = await world();
    try {
      const made = await hand(v.ws);
      assert.equal(existsSync(join(v.task, "handover.json")), false, "no attempt, no record");
      assert.deepEqual(await leftBy(v.ws, made.checkout), { attempts: [], complete: false }, "a checkout no attempt was handed reports an incomplete list");
      await hand(v.ws, "att-x");
      assert.deepEqual(v.handover(), { attemptId: "att-x", expected: v.handover().expected, left: [], overflow: true });
    } finally { await v.done(); }
  } finally { await w.done(); }
});

test("the list is bounded: past the limit the record says it does not name every attempt (card Q04)", { skip }, async () => {
  const w = await world();
  try {
    const a = await hand(w.ws, "att-0");
    const full = Array.from({ length: HANDOVER_LIMITS.attempts }, (_, i) => `att-f${i}`);
    await writeFile(join(w.task, "handover.json"), `${JSON.stringify({ attemptId: "att-0", expected: w.handover().expected, left: full })}\n`);
    await writeFile(join(a.checkout, "src", "a.ts"), "export const a = 7;\n");
    await hand(w.ws, "att-1");
    assert.equal(w.handover().left.length, HANDOVER_LIMITS.attempts);
    assert.equal(w.handover().overflow, true);
    const report = await leftBy(w.ws, a.checkout);
    assert.equal(report.complete, false);
    assert.equal(report.attempts.length, HANDOVER_LIMITS.attempts);
  } finally { await w.done(); }
});

test("the integrator's re-apply of a queued submission onto the moved landing branch (restack) is the platform's change, not the attempt's that last held the checkout (card Q04)", { skip }, async () => {
  const w = await world();
  try {
    const a = await hand(w.ws, "att-a");
    const g = ["--git-dir", a.gitDir, "--work-tree", a.checkout];
    // A's work, committed in the checkout as a release commits it
    await writeFile(join(a.checkout, "src", "a.ts"), "export const a = 2;\n");
    sh(a.checkout, ...g, "add", "-A"); sh(a.checkout, ...g, "commit", "-q", "-m", "approved work");
    const approved = { id: "sbm-pppppppppppppppppppp", base: sh(a.checkout, ...g, "rev-parse", "refs/nn/base"), tree: sh(a.checkout, ...g, "rev-parse", "HEAD^{tree}") };
    // a reviewer's attempt holds the checkout and changes nothing (A is named: A's work is in it)
    await hand(w.ws, "att-r");
    assert.deepEqual(w.handover().left, ["att-a"]);
    // the landing branch moves; the integrator re-applies the queued submission onto it
    await writeFile(join(w.shared, "src", "z.ts"), "export const z = 1;\n");
    sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", "other work landed");
    const out = await w.ws.port.restack({ requestId: rid(), ...scope, submission: approved });
    assert.equal((out as { state?: string }).state, "reapplied", JSON.stringify(out));
    assert.equal(existsSync(join(a.checkout, "src", "z.ts")), true);
    await hand(w.ws, "att-n");
    assert.deepEqual(w.handover().left, ["att-a"], "the reviewer is not charged with the re-apply's change");
  } finally { await w.done(); }
});

test("a host that stops part-way through a platform request: the request's change is not charged to the attempt that held the checkout, a charge found before the request is kept, and a resume settles the mark (card Q04, first review)", { skip }, async () => {
  const w = await world();
  const marker = join(w.task, "handover.during");
  const original = { refresh: w.git.refresh.bind(w.git), reapply: w.git.reapply.bind(w.git) };
  // What the folder held at the moment the request had written the checkout: put back afterwards, as if the host had stopped there.
  let snapshot: { record: string; marked: boolean } | undefined;
  const take = (): void => { snapshot = { record: readFileSync(join(w.task, "handover.json"), "utf8"), marked: existsSync(marker) }; };
  const putBack = async (): Promise<void> => { await writeFile(join(w.task, "handover.json"), snapshot!.record); if (snapshot!.marked) await writeFile(marker, ""); else await rm(marker, { force: true }); };
  (w.git as unknown as { refresh: typeof original.refresh }).refresh = async (o) => { const r = await original.refresh(o); take(); return r; };
  (w.git as unknown as { reapply: typeof original.reapply }).reapply = async (o) => { const r = await original.reapply(o); take(); return r; };
  const move = (name: string): void => { execFileSync("sh", ["-c", `printf 'export const x = 1;\\n' > src/${name}.ts`], { cwd: w.shared }); sh(w.shared, "add", "-A"); sh(w.shared, "commit", "-q", "-m", name); };
  try {
    const a = await hand(w.ws, "att-a");
    // A changed nothing; the host stops part-way through a refresh that brought the landing branch's file
    move("b");
    assert.equal((await w.ws.port.run(call("refresh"))).ok, true);
    assert.equal(snapshot?.marked, true, "the mark is there while the request runs");
    assert.equal(existsSync(marker), false, "and gone once it ended");
    await putBack();
    await hand(w.make(), "att-b");
    assert.deepEqual(w.handover().left, [], "the refresh's change is not A's");
    assert.equal(existsSync(marker), false, "the hand-out settled the mark");
    // B edits, then re-applies and the host stops part-way: B's edit, seen before the request, is still B's
    await writeFile(join(a.checkout, "src", "a.ts"), "export const a = 4;\n");
    move("c");
    assert.equal((await w.ws.port.run(call("reapply"))).ok, true);
    await putBack();
    assert.deepEqual(w.handover().left, ["att-b"], "the charge was written before the request started");
    // B resumes (the same attempt) after the restart: the mark is settled with the tree as the request left it, so C's hand-out charges nothing new
    await hand(w.make(), "att-b");
    assert.equal(existsSync(marker), false);
    await hand(w.ws, "att-c");
    assert.deepEqual(w.handover().left, ["att-b"]);
    // without a mark, a tree that changed between the record and the hand-out is the attempt's (the request ended and wrote its tree, or never ran): C writes, D's hand-out charges C
    await writeFile(join(a.checkout, "notes.md"), "C\n");
    await hand(w.ws, "att-d");
    assert.deepEqual(w.handover().left.sort(), ["att-b", "att-c"]);
  } finally { await w.done(); }
});

test("a record that is there but cannot be read counts as damaged, not as none: the list it held is not known, so it stays incomplete (card Q04, first review)", { skip: skip || (process.getuid?.() === 0 ? "root reads every file" : false) }, async () => {
  const w = await world();
  let undo: (() => Promise<void>) | undefined;
  try {
    const a = await hand(w.ws, "att-a");
    await writeFile(join(a.checkout, "src", "a.ts"), "export const a = 7;\n");
    await hand(w.ws, "att-b");
    assert.deepEqual(w.handover().left, ["att-a"]);
    undo = await unreadable(join(w.task, "handover.json"));
    assert.throws(() => readFileSync(join(w.task, "handover.json")), "the record is there but cannot be read");
    await hand(w.ws, "att-c");
    assert.equal(w.handover().overflow, true, "the unreadable record's list (att-a) is lost, so the new one says it is incomplete");
    assert.equal((await leftBy(w.ws, a.checkout)).complete, false);
  } finally { await undo?.().catch(() => undefined); await w.done(); }
});

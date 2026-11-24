import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LaunchRequest, RunResult } from "../sandbox/launcher.js";
import { CHECK_OUTPUT_CHARS, doneVerifier, localWorkerParts, type HostOrder } from "./local.js";

// Card W05: the host runs a contract's check commands itself, in a sandbox made from the attempt's (the checkout as working directory, the same inputs, environment and limits), with an empty home and scratch of its own, each
// cut off at its time and output cap. The agent has no part in it. Nothing here starts a real process: the launcher is a fake that records what it was asked and answers as a run would.
const root = realpathSync(mkdtempSync(join(tmpdir(), "nn done check ")));
const dir = (name: string): string => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d; };
const node = dir("node"); writeFileSync(join(node, "marker"), "x");
const app = { node: { root: node, executable: "bin/node" }, mounts: [] as { host: string; guest: string }[], entry: "/opt/app/main.js" };
const work = { checkout: dir("work/checkout"), gitDir: dir("work/git"), home: dir("work/home"), scratch: dir("work/scratch"), env: { LANGUAGE_MODE: "plain" } };
const order: HostOrder = { attemptId: "att-1", taskId: "task-1", projectId: "proj-1", agentId: "agent:ann", route: "r", credential: "c", recipe: { revision: "r1", reach: [] } };
const run = (r: Partial<RunResult>): RunResult => ({ exitCode: 0, signal: null, timedOut: false, killed: false, stdout: "", stderr: "", truncated: false, stdoutTruncated: false, durationMs: 42, ...r });

function make(answer: (request: LaunchRequest) => RunResult | Promise<RunResult>, owner: { limits?: Record<string, number>; bestEffort?: boolean } = {}) {
  const asked: LaunchRequest[] = [];
  const seenDirs: string[] = [];
  const launcher = { launch: async (request: LaunchRequest) => { asked.push(request); seenDirs.push(request.recipe.home, request.recipe.scratch); const result = await answer(request); return { result: Promise.resolve(result) } as never; } };
  const parts = localWorkerParts<unknown>({
    launcher: launcher as never, app, protectedPaths: [], workspace: () => ({ ...work, limits: { memoryMb: 1024, cpus: 2 } }), model: () => { throw new Error("unused"); }, namespaceId: () => "abcdef0123456789",
    bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); }, checkBase: dir("checks"),
    ...(owner.limits === undefined ? {} : { limits: () => owner.limits }), ...(owner.bestEffort === undefined ? {} : { bestEffort: () => owner.bestEffort! }),
  });
  return { parts, asked, seenDirs };
}

test("a check runs in a sandbox made from the attempt's, with its own empty home and scratch, the attempt's limits and the smaller of its time and the owner's wall time (W05)", async () => {
  const m = make(() => run({ stdout: "ok\n" }), { limits: { memoryMb: 512, wallTimeMs: 5_000 }, bestEffort: false });
  assert.deepEqual(await m.parts.checks.run("att-1", { run: ["npm", "test"], timeoutMs: 60_000, maxOutputBytes: 1024 }), { state: "not-run", reason: "the attempt has no sandbox open on this host" }, "no sandbox open: nothing runs");
  assert.equal(m.asked.length, 0);
  const session = await m.parts.sandbox.open(order.recipe, order);
  try {
    const got = await m.parts.checks.run("att-1", { run: ["npm", "test"], timeoutMs: 60_000, maxOutputBytes: 1024 });
    assert.deepEqual(got, { state: "passed", exitCode: 0, signal: null, ms: 42, output: "ok\n" });
    const r = m.asked[0]!;
    assert.deepEqual(r.command, ["npm", "test"]);
    assert.equal(r.recipe.workdir, work.checkout, "the checkout is the working directory");
    assert.notEqual(r.recipe.home, work.home, "never the agent's home (its conversation store)");
    assert.notEqual(r.recipe.scratch, work.scratch);
    assert.equal(r.recipe.network, "none");
    assert.deepEqual(r.recipe.env, work.env);
    assert.ok(r.recipe.readOnly.some((x) => x.guest === "/opt/node"), "the same read-only inputs");
    assert.deepEqual(r.limits, { memoryMb: 512, cpus: 2 }, "the smaller of the attempt's and the owner's limits");
    assert.equal(r.timeoutMs, 5_000, "the owner's wall time when it is smaller");
    assert.equal(r.maxOutputBytes, 1024);
    assert.equal(r.requireEnforced, true);
    assert.ok(m.seenDirs.every((d) => !existsSync(d)), "the check's own home and scratch are removed after it");
  } finally { await session.close(); }
});

test("how a check ended: a failure keeps the end of its output, a time-out is a failure, a program that does not start or a launch the sandbox refuses is not-run (W05)", async () => {
  let next: RunResult | Error = run({});
  const m = make(() => { if (next instanceof Error) throw next; return next; });
  const session = await m.parts.sandbox.open(order.recipe, order);
  try {
    const check = { run: ["npm", "test"], timeoutMs: 1000, maxOutputBytes: 64 * 1024 };
    next = run({ exitCode: 1, stdout: `${"a".repeat(CHECK_OUTPUT_CHARS)}FAIL`, stderr: "stack trace\n" });
    const failed = await m.parts.checks.run("att-1", check);
    assert.equal(failed.state, "failed");
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.output?.length, CHECK_OUTPUT_CHARS);
    assert.ok(failed.output?.endsWith("FAIL\nstack trace\n"), "the end of what it wrote, both streams");
    next = run({ exitCode: null, signal: "SIGKILL", timedOut: true, stdout: "slow" });
    assert.deepEqual(await m.parts.checks.run("att-1", check), { state: "failed", timedOut: true, exitCode: null, signal: "SIGKILL", ms: 42, output: "slow" });
    next = run({ exitCode: null, signal: "SIGTERM", killed: true });
    assert.equal((await m.parts.checks.run("att-1", check)).state, "failed");
    next = run({ exitCode: null, signal: null, stderr: "could not start: npm: not found" });
    assert.deepEqual(await m.parts.checks.run("att-1", check), { state: "not-run", reason: "the check could not be started: npm: not found", ms: 42 });
    next = new Error("limits cannot be enforced");
    assert.deepEqual(await m.parts.checks.run("att-1", check), { state: "not-run", reason: "the sandbox refused the check: limits cannot be enforced" });
    assert.equal((await m.parts.checks.run("att-1", { ...check, run: [] })).state, "not-run");
  } finally { await session.close(); }
});

test("doneVerifier reports the checkout and runs each check in turn; a check that throws is not-run, never passed; no checkout is said so (W05)", async () => {
  const order_: string[] = [];
  const verify = doneVerifier({
    workspaces: { doneState: async (scope, paths) => (scope.taskId === "none" ? undefined : { uncommitted: ["a"], uncommittedCount: 1, ahead: 2, changed: 3, agentCommits: false, evidence: paths.map((p) => ({ path: p, present: p !== "x" })) }) },
    checks: { run: async (_id, c) => { order_.push(c.run[0]!); if (c.run[0] === "boom") throw new Error("host broke"); return { state: c.run[0] === "ok" ? "passed" : "failed", exitCode: c.run[0] === "ok" ? 0 : 2 }; } },
  });
  const request = { checks: [{ name: "one", run: ["ok"], timeoutMs: 10 }, { name: "two", run: ["boom"], timeoutMs: 10 }, { name: "three", run: ["bad"], timeoutMs: 10 }], evidence: ["x", "y"], maxOutputBytes: 100 };
  const got = await verify("att-1", { taskId: "t", projectId: "p" }, request);
  assert.deepEqual(order_, ["ok", "boom", "bad"], "one after another, in the contract's order");
  assert.deepEqual(got, { checkout: true, tree: { uncommitted: ["a"], uncommittedCount: 1, ahead: 2, changed: 3, agentCommits: false }, evidence: [{ path: "x", present: false }, { path: "y", present: true }], checks: [{ name: "one", state: "passed", exitCode: 0 }, { name: "two", state: "not-run", reason: "host broke" }, { name: "three", state: "failed", exitCode: 2 }] });
  assert.deepEqual((await verify("att-1", { taskId: "none", projectId: "p" }, { ...request, checks: [] })), { checkout: false, checks: [] });
});

test("a check still running when the attempt's sandbox is closed is ended with it (W05)", async () => {
  let killed = 0;
  let finish!: (r: RunResult) => void;
  const launcher = { launch: async () => ({ kill: () => { killed++; finish(run({ exitCode: null, signal: "SIGKILL", killed: true })); }, result: new Promise<RunResult>((r) => { finish = r; }) }) };
  const parts = localWorkerParts<unknown>({ launcher: launcher as never, app, protectedPaths: [], workspace: () => work, model: () => { throw new Error("unused"); }, namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); }, requireEnforced: false });
  const session = await parts.sandbox.open(order.recipe, order);
  const running = parts.checks.run("att-1", { run: ["sleep", "1000"], timeoutMs: 1_000_000, maxOutputBytes: 100 });
  await new Promise((r) => setTimeout(r, 20));
  await session.close();
  assert.equal(killed, 1);
  assert.equal((await running).state, "failed", "a check that was ended did not pass");
});

test("doneVerifier looks at the checkout again after the checks: a check or parallel call that removes evidence or the change does not pass, an unreadable second look is not verified, build output does not fail it (W05 follow-up)", async () => {
  const state = (over: { changed?: number; ahead?: number; xPresent?: boolean; uncommittedCount?: number }) => ({ uncommitted: [] as string[], uncommittedCount: over.uncommittedCount ?? 0, ahead: over.ahead ?? 1, changed: over.changed ?? 2, agentCommits: true, evidence: [{ path: "x", present: over.xPresent ?? true }] as { path: string; present: boolean; why?: string }[] });
  const looks: (ReturnType<typeof state> | "throw")[] = [];
  const verify = doneVerifier({
    workspaces: { doneState: async () => { const l = looks.shift(); if (l === "throw" || l === undefined) throw new Error("no look"); return l; } },
    checks: { run: async () => ({ state: "passed", exitCode: 0 }) },
  });
  const scope = { taskId: "t", projectId: "p" };
  const one = { checks: [{ name: "c", run: ["ok"], timeoutMs: 10 }], evidence: ["x"], maxOutputBytes: 100 };
  // Nothing changed: as before.
  looks.push(state({}), state({}));
  const same = await verify("a", scope, one);
  assert.equal(same.evidence?.[0]?.present, true); assert.equal(same.tree?.changed, 2); assert.equal(same.checks[0]?.state, "passed");
  // The check deleted the evidence and the work: the done gets the smaller counts and no evidence.
  looks.push(state({}), state({ changed: 0, ahead: 0, xPresent: false }));
  const gone = await verify("a", scope, one);
  assert.equal(gone.evidence?.[0]?.present, false); assert.equal(gone.tree?.changed, 0); assert.equal(gone.tree?.ahead, 0);
  // Files only added by the check (more changed paths, a dirty tree) are not read as a failure.
  looks.push(state({}), state({ changed: 9, uncommittedCount: 7 }));
  const added = await verify("a", scope, one);
  assert.equal(added.evidence?.[0]?.present, true); assert.equal(added.tree?.changed, 2); assert.equal(added.tree?.uncommittedCount, 0);
  // The second look fails: a passed check is not-run; evidence found by the first look is left out (the controller says it could not be looked at), evidence the first look did not find stays not present.
  looks.push(state({}), "throw");
  const blind = await verify("a", scope, one);
  assert.equal(blind.checks[0]?.state, "not-run"); assert.deepEqual(blind.evidence, []);
  // Second review: the reason says the check ran (the controller prints it after "could not be run by the host:"), and a failed check stays failed.
  assert.match(String(blind.checks[0]?.reason), /^it ran and passed, but the checkout could not be looked at again/);
  const mixed = doneVerifier({
    workspaces: { doneState: async () => { const l = looks.shift(); if (l === "throw" || l === undefined) throw new Error("no look"); return l; } },
    checks: { run: async (_a, c) => (c.run[0] === "ok" ? { state: "passed", exitCode: 0 } : { state: "failed", exitCode: 1 }) },
  });
  looks.push(state({}), "throw");
  assert.deepEqual((await mixed("a", scope, { ...one, checks: [{ name: "c", run: ["ok"], timeoutMs: 10 }, { name: "d", run: ["bad"], timeoutMs: 10 }] })).checks.map((c) => [c.name, c.state]), [["c", "not-run"], ["d", "failed"]]);
  looks.push(state({ xPresent: false }), "throw");
  assert.deepEqual((await verify("a", scope, one)).evidence, [{ path: "x", present: false }]);
  // The second look does not name a path the first found: not known to be there, so left out; a path it names elsewhere in its list is still matched.
  looks.push(state({}), { ...state({}), evidence: [{ path: "y", present: true }] });
  assert.deepEqual((await verify("a", scope, one)).evidence, []);
  const two = { ...one, evidence: ["x", "z"] };
  looks.push({ ...state({}), evidence: [{ path: "x", present: true }, { path: "z", present: true }] }, { ...state({}), evidence: [{ path: "z", present: true }, { path: "x", present: false, why: "empty" }] });
  assert.deepEqual((await verify("a", scope, two)).evidence, [{ path: "x", present: false, why: "empty" }, { path: "z", present: true }]);
  // Second review: checks and no required evidence (the common contract) still get the second look, so a check that removed the change is seen.
  looks.push({ ...state({}), evidence: [] }, { ...state({ changed: 0, ahead: 0 }), evidence: [] });
  const bare = await verify("a", scope, { ...one, evidence: [] });
  assert.equal(bare.tree?.changed, 0); assert.equal(bare.tree?.ahead, 0); assert.equal(looks.length, 0, "both looks were taken");
  // No checks: one look only (nothing ran in between).
  looks.push(state({}));
  assert.equal((await verify("a", scope, { ...one, checks: [] })).checkout, true);
});

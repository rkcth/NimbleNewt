import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ReleaseHostRunner, RemoteWorkerClient, WorkerRequestError, type ReleaseSuiteJob, type ReleaseSuiteResult } from "../remote/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };
const h = (c: string): string => c.repeat(64);
const manifest = (commit: string) => ({ sourceCommit: commit.repeat(40), suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, matrix: [{ os: "linux", arch: "x64" }, { os: "win32", arch: "x64" }] });
const linux = { os: "linux", arch: "x64" } as const;
const win = { os: "win32", arch: "x64" };
const good = (job: ReleaseSuiteJob, extra: Partial<ReleaseSuiteResult> = {}): ReleaseSuiteResult => ({
  tested: { sourceCommit: job.sourceCommit, suiteRevision: job.suiteRevision, artifactHashes: job.artifacts, dependencyLockHashes: job.dependencyLocks },
  counts: { passed: 120, failed: 0, skipped: 2 }, log: "line one\nline two\n", summary: "all green", ...extra,
});

async function rig() {
  const d = mkdtempSync(join(tmpdir(), "nn-x09b-run-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter(() => []) },
    dispatch: { timer: new ManualTimer(), manual: true, route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }), remote: { blobDirectory: join(d, "blobs"), hosts: [] } },
  } as never);
  assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
  await c.services.principals.enroll(rob, { commandId: "e-rig", kind: "host", name: "rig", grants: [] });
  const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: (await c.services.principals.issueCredential(rob, "host:rig")).token, workerVersion: "worker-9.1.0" });
  await client.connect({ ...CAPS } as never);
  let n = 0;
  const id = (l: string): string => `${l}-${n++}`;
  const submit = async (commit: string): Promise<string> => (await call("release.submit", { manifest: manifest(commit) }, id("s"))).result.candidateId;
  const start = async (candidateId: string, cell: object = linux, extra: Record<string, unknown> = {}): Promise<string> => { const r = await call("release.start", { candidateId, cell, hostId: "host:rig", ...extra }, id("st")); assert.ok(r.ok, JSON.stringify(r)); return r.result.attemptId; };
  const state = async (candidateId: string, os = "linux"): Promise<any> => (await call("release.attempts", { candidateId })).result.attempts.filter((a: any) => a.cell.os === os);
  assert.ok((await call("release.host", { hostId: "host:rig", os: "linux", arch: "x64" }, id("rh"))).ok);
  return { c, client, call, id, submit, start, state };
}
const trouble = (): { list: string[]; fn: (a: string | undefined, w: string) => void } => { const list: string[] = []; return { list, fn: (a, w) => { list.push(`${a ?? "-"}: ${w}`); } }; };

test("a host runner takes a job, runs the operator's suite, reports the measured result once, and the gate sees only that (card X09b remainder)", async () => {
  const { c, client, call, submit, start, state } = await rig();
  try {
    const t = trouble();
    const ran: ReleaseSuiteJob[] = [];
    const runner = new ReleaseHostRunner({ client, platform: linux, onTrouble: t.fn, suite: async (job) => { ran.push(job); return good(job, { osVersion: "6.8.0" }); } });
    const cand = await submit("a");
    const attemptId = await start(cand, linux, { timeoutSeconds: 600, memoryMb: 2048 });
    await runner.tick(); await runner.settled();
    assert.equal(ran.length, 1);
    assert.deepEqual([ran[0]!.attemptId, ran[0]!.sourceCommit, ran[0]!.timeoutSeconds, ran[0]!.memoryMb], [attemptId, "a".repeat(40), 600, 2048]);
    const a = (await state(cand))[0];
    assert.equal(a.state, "passed");
    assert.equal(a.result.logDigest, createHash("sha256").update("line one\nline two\n").digest("hex"), "only the digest of the log leaves the host");
    assert.deepEqual(a.result.counts, { passed: 120, failed: 0, skipped: 2 });
    assert.equal(a.result.environment.osVersion, "6.8.0");
    await runner.tick(); await runner.settled();
    assert.equal(ran.length, 1, "a finished attempt is never run again");
    assert.deepEqual(t.list, []);
    assert.equal((await call("release.gate", { candidateId: cand })).result.gate.cells.find((x: any) => x.cell.os === "linux").state, "passed");
  } finally { await c.close(); }
});

test("a suite that throws, counts nothing, or fails is a failed attempt, never a pass; the sentence it sends is one clean bounded line", async () => {
  const { c, client, submit, start, state } = await rig();
  try {
    let mode = "throw";
    const runner = new ReleaseHostRunner({ client, platform: linux, suite: async (job) => {
      if (mode === "throw") throw new Error("boom\u2028forged: pass\u0007");
      if (mode === "none") return good(job, { counts: { passed: 0, failed: 0, skipped: 5 } });
      return good(job, { counts: { passed: 9, failed: 1, skipped: 0 }, summary: "x".repeat(900) });
    } });
    for (const m of ["throw", "none", "failing"]) {
      mode = m;
      const cand = await submit({ throw: "7", none: "8", failing: "9" }[m]!);
      await start(cand);
      await runner.tick(); await runner.settled();
      const a = (await state(cand))[0];
      assert.equal(a.state, "failed", m);
      assert.ok(a.result.summary.length <= 500 && !/[\u2028\u0007\n]/.test(a.result.summary), m);
      if (m === "throw") assert.match(a.result.summary, /^the suite stopped: boomforged: pass$/);
    }
  } finally { await c.close(); }
});

test("a suite that measured another build than the candidate reports nothing; the attempt stays open for the controller's own ending", async () => {
  const { c, client, submit, start, state } = await rig();
  try {
    const t = trouble();
    const wrong: ((j: ReleaseSuiteJob) => ReleaseSuiteResult)[] = [
      (j) => good(j, { tested: { ...good(j).tested, sourceCommit: "b".repeat(40) } }),
      (j) => good(j, { tested: { ...good(j).tested, suiteRevision: "suite-8" } }),
      (j) => good(j, { tested: { ...good(j).tested, artifactHashes: { "nimblenewt.tgz": h("f") } } }),
      (j) => good(j, { tested: { ...good(j).tested, artifactHashes: { ...j.artifacts, extra: h("e") } } }),
      (j) => good(j, { tested: { ...good(j).tested, dependencyLockHashes: {} } }),
      (j) => good(j, { log: { sha256: "NOT-A-DIGEST" } }),
      (j) => good(j, { counts: { passed: 1.5, failed: 0, skipped: 0 } }),
    ];
    let i = 0;
    const runner = new ReleaseHostRunner({ client, platform: linux, onTrouble: t.fn, suite: async (job) => wrong[i]!(job) });
    for (; i < wrong.length; i++) {
      const cand = await submit(String(i));
      await start(cand);
      await runner.tick(); await runner.settled();
      const a = (await state(cand))[0];
      assert.equal(a.state, "issued", `variant ${i} is not finished`);
      assert.equal(a.result, undefined, `variant ${i} left no result`);
      assert.deepEqual(runner.running, []);
      const before = t.list.length;
      await runner.tick(); await runner.settled();
      assert.equal(t.list.length, before, `variant ${i} is not looked at again by this process`);
      assert.equal((await state(cand))[0].state, "issued", `variant ${i} was not turned into a failure by the second look`);
    }
    assert.equal(t.list.filter((x) => !x.includes("left alone")).length, wrong.length);
  } finally { await c.close(); }
});

test("a cancel stops the suite and nothing is reported; the time limit stops it and reports a failure; a stop leaves the attempt to the controller", async () => {
  const { c, client, call, id, submit, start, state } = await rig();
  try {
    const t = trouble();
    let seen: AbortSignal | undefined;
    const suite = (job: ReleaseSuiteJob, signal: AbortSignal): Promise<ReleaseSuiteResult> => { seen = signal; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); };
    const runner = new ReleaseHostRunner({ client, platform: linux, onTrouble: t.fn, suite });
    const cand = await submit("c");
    const attemptId = await start(cand);
    await runner.tick();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(runner.running, [attemptId]);
    assert.equal(seen!.aborted, false);
    assert.ok((await call("release.cancel", { attemptId, reason: "no longer needed" }, id("cx"))).ok);
    await runner.tick(); await runner.settled();
    assert.equal(seen!.aborted, true, "the work the controller ended is stopped");
    assert.equal((await state(cand))[0].state, "interrupted", "never a pass, and nothing was reported over the cancel");
    assert.ok(t.list.some((x) => x.includes("ended without a report")));

    const cand2 = await submit("d");
    await start(cand2, linux, { timeoutSeconds: 1 });
    const r2 = new ReleaseHostRunner({ client, platform: linux, onTrouble: t.fn, suite });
    await r2.tick(); await r2.settled();
    const a2 = (await state(cand2))[0];
    assert.equal(a2.state, "failed");
    assert.match(a2.result.summary, /time limit passed on the host/);

    const cand3 = await submit("e");
    const att3 = await start(cand3);
    const r3 = new ReleaseHostRunner({ client, platform: linux, onTrouble: t.fn, suite });
    await r3.tick(); await new Promise((r) => setTimeout(r, 30));
    r3.stop(); await r3.settled();
    assert.equal((await state(cand3))[0].state, "issued");
    assert.equal(att3, (await state(cand3))[0].id);
    await r3.tick();
    assert.deepEqual(r3.running, [], "a stopped runner takes nothing more");
  } finally { await c.close(); }
});

test("a job for another platform, a malformed one, or one over the concurrency limit is not picked up; a job a restarted host had picked up is reported failed, not run again", async () => {
  const { c, client, call, id, submit, start, state } = await rig();
  try {
    const t = trouble();
    assert.ok((await call("release.host", { hostId: "host:rig", os: "win32", arch: "x64" }, id("rh"))).ok);
    const cand = await submit("f");
    await start(cand, win);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ran: string[] = [];
    const runner = new ReleaseHostRunner({ client, platform: linux, onTrouble: t.fn, suite: async (job) => { ran.push(job.attemptId); await gate; return good(job); } });
    await runner.tick(); await runner.settled();
    assert.deepEqual(ran, []);
    assert.equal((await state(cand, "win32"))[0].pickedUpAt, undefined, "not even picked up");
    assert.ok(t.list.some((x) => x.includes("left alone")));
    // concurrency: two jobs, one runs
    assert.ok((await call("release.host", { hostId: "host:rig", os: "linux", arch: "x64" }, id("rh"))).ok);
    const [c1, c2] = [await submit("1"), await submit("2")];
    const [a1, a2] = [await start(c1), await start(c2)];
    await runner.tick();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(runner.running.length, 1);
    assert.equal((await state(c2))[0].pickedUpAt === undefined || (await state(c1))[0].pickedUpAt === undefined, true, "only one was picked up");
    release(); await runner.settled();
    await runner.tick(); await runner.settled();
    assert.deepEqual(ran.sort(), [a1, a2].sort());
    // restart: picked up by someone else's run, not in this process's memory
    const c3 = await submit("3");
    const a3 = await start(c3);
    await client.releasePickUp(a3);
    const fresh = new ReleaseHostRunner({ client, platform: linux, onTrouble: t.fn, suite: async () => { throw new Error("must not run"); } });
    await fresh.tick(); await fresh.settled();
    const e = (await state(c3))[0];
    assert.equal(e.state, "failed");
    assert.deepEqual(e.result.counts, { passed: 0, failed: 0, skipped: 0 });
    assert.match(e.result.summary, /restarted/);
  } finally { await c.close(); }
});

test("a report that fails for a while is retried with the same key and lands once; a refusal is not retried; a list that cannot be fetched is told, not thrown", async () => {
  const { c, client, submit, start, state } = await rig();
  try {
    const t = trouble();
    let tries = 0, keys = new Set<string>();
    const flaky = {
      releaseWork: () => client.releaseWork(), releasePickUp: (a: string, k?: string) => client.releasePickUp(a, k),
      releaseReport: async (a: string, r: { [k: string]: any }, k?: string) => { tries++; keys.add(k!); if (tries < 3) throw new WorkerRequestError(503, "unavailable", "busy"); return client.releaseReport(a, r, k); },
    };
    const runner = new ReleaseHostRunner({ client: flaky as never, platform: linux, onTrouble: t.fn, sleep: async () => undefined, suite: async (job) => good(job) });
    const cand = await submit("5");
    await start(cand);
    await runner.tick(); await runner.settled();
    assert.equal(tries, 3);
    assert.equal(keys.size, 1, "every try carries the same key");
    assert.match([...keys][0]!, /^release-report-rat-/);
    assert.equal((await state(cand))[0].state, "passed");

    let refusedTries = 0;
    const refusing = { ...flaky, releaseReport: async () => { refusedTries++; throw new WorkerRequestError(400, "invalid_command", "no"); } };
    const r2 = new ReleaseHostRunner({ client: refusing as never, platform: linux, onTrouble: t.fn, sleep: async () => undefined, suite: async (job) => good(job) });
    const cand2 = await submit("6");
    await start(cand2);
    await r2.tick(); await r2.settled();
    assert.equal(refusedTries, 1);
    assert.ok(t.list.some((x) => x.includes("the report was not accepted")));

    const down = new ReleaseHostRunner({ client: { ...flaky, releaseWork: async () => { throw new Error("offline"); } } as never, platform: linux, onTrouble: t.fn, suite: async (job) => good(job) });
    await down.tick();
    assert.ok(t.list.some((x) => x.includes("could not be fetched")));
  } finally { await c.close(); }
});

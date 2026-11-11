import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { getEventListeners } from "node:events";
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
/** Fails fast with a message instead of hanging until the runner's timeout when a guard is broken (a suite that is never aborted, a job that should not have started). */
const within = async <T>(p: Promise<T>, what: string, ms = 5000): Promise<T> => {
  let t: NodeJS.Timeout | undefined;
  try { return await Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new assert.AssertionError({ message: `${what} did not settle within ${ms} ms` })), ms); })]); } finally { clearTimeout(t); }
};
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
    await runner.tick(); await within(runner.settled(), "the cancelled suite");
    assert.equal(seen!.aborted, true, "the work the controller ended is stopped");
    assert.equal((await state(cand))[0].state, "interrupted", "never a pass, and nothing was reported over the cancel");
    assert.ok(t.list.some((x) => x.includes("ended without a report")));

    const cand2 = await submit("d");
    await start(cand2, linux, { timeoutSeconds: 1 });
    const r2 = new ReleaseHostRunner({ client, platform: linux, onTrouble: t.fn, suite });
    await r2.tick(); await within(r2.settled(), "the suite past its time limit");
    const a2 = (await state(cand2))[0];
    assert.equal(a2.state, "failed");
    assert.match(a2.result.summary, /time limit passed on the host/);

    const cand3 = await submit("e");
    const att3 = await start(cand3);
    const r3 = new ReleaseHostRunner({ client, platform: linux, onTrouble: t.fn, suite });
    await r3.tick(); await new Promise((r) => setTimeout(r, 30));
    r3.stop(); await within(r3.settled(), "the stopped suite");
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
    await runner.tick(); await within(runner.settled(), "a job for another platform (it must not start)");
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
    release(); await within(runner.settled(), "the one running job");
    await runner.tick(); await within(runner.settled(), "the second job");
    assert.deepEqual(ran.sort(), [a1, a2].sort());
    // restart: picked up by someone else's run, not in this process's memory
    const c3 = await submit("3");
    const a3 = await start(c3);
    await client.releasePickUp(a3);
    const fresh = new ReleaseHostRunner({ client, platform: linux, onTrouble: t.fn, suite: async () => { throw new Error("must not run"); } });
    await fresh.tick(); await within(fresh.settled(), "the restarted host");
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

test("a lost pick-up answer is not a restart; a report the controller asks to repeat (stale_revision) or cannot take for a while is sent again with its key until it lands (review fixes)", async () => {
  const { c, client, submit, start, state } = await rig();
  try {
    const t = trouble();
    // The pick-up commits on the controller but its answer is lost: the next look sees it picked up, and must run it, not report "host restarted".
    let dropPickUp = true;
    const ran: string[] = [];
    const lossy = {
      releaseWork: () => client.releaseWork(), releaseReport: (a: string, r: { [k: string]: any }, k?: string) => client.releaseReport(a, r, k),
      releasePickUp: async (a: string, k?: string) => { const r = await client.releasePickUp(a, k); if (dropPickUp) { dropPickUp = false; throw new Error("socket hang up"); } return r; },
    };
    const r1 = new ReleaseHostRunner({ client: lossy as never, platform: linux, onTrouble: t.fn, suite: async (job) => { ran.push(job.attemptId); return good(job); } });
    const cand = await submit("a");
    const att = await start(cand);
    await r1.tick(); await within(r1.settled(), "first look");
    assert.deepEqual(ran, []);
    assert.ok((await state(cand))[0].pickedUpAt !== undefined, "the controller did record the pick-up");
    await r1.tick(); await within(r1.settled(), "second look");
    assert.deepEqual(ran, [att], "the job is run, not reported as a restart");
    assert.equal((await state(cand))[0].state, "passed");

    // stale_revision is a request to report again, not a refusal.
    let staleOnce = true;
    const stale = { ...lossy, releasePickUp: (a: string, k?: string) => client.releasePickUp(a, k), releaseReport: async (a: string, r: { [k: string]: any }, k?: string) => { if (staleOnce) { staleOnce = false; throw new WorkerRequestError(409, "stale_revision", "the attempt changed at the same moment; report again"); } return client.releaseReport(a, r, k); } };
    const r2 = new ReleaseHostRunner({ client: stale as never, platform: linux, onTrouble: t.fn, sleep: async () => undefined, suite: async (job) => good(job, { counts: { passed: 3, failed: 1, skipped: 0 } }) });
    const cand2 = await submit("b");
    await start(cand2);
    await r2.tick(); await within(r2.settled(), "stale report");
    assert.equal((await state(cand2))[0].state, "failed", "the real failure landed");

    // The controller is down for longer than the tries: the failure is kept and sent on a later look (same key), so it is not lost to a timeout.
    let down = true, sent = 0;
    const keys = new Set<string>();
    const outage = { ...stale, releaseReport: async (a: string, r: { [k: string]: any }, k?: string) => { sent++; keys.add(k!); if (down) throw new WorkerRequestError(503, "unavailable", "restarting"); return client.releaseReport(a, r, k); } };
    let suiteRuns = 0;
    const r3 = new ReleaseHostRunner({ client: outage as never, platform: linux, onTrouble: t.fn, sleep: async () => undefined, suite: async (job) => { suiteRuns++; return good(job, { counts: { passed: 3, failed: 2, skipped: 0 } }); } });
    const cand3 = await submit("c");
    await start(cand3);
    await r3.tick(); await within(r3.settled(), "report during the outage");
    assert.equal(sent, 3);
    assert.equal((await state(cand3))[0].state, "issued");
    down = false;
    await r3.tick(); await within(r3.settled(), "report after the outage");
    assert.equal((await state(cand3))[0].state, "failed", "the kept failure landed");
    assert.equal(suiteRuns, 1, "the suite is not run again");
    assert.equal(keys.size, 1, "one key for every try");
    await r3.tick(); await within(r3.settled(), "a further look");
    assert.equal(sent, 4, "nothing more is sent once it landed");
  } finally { await c.close(); }
});

test("a blank or long summary and an odd OS version never get a real result refused; a bad setting never lifts the limits; a job ended during its pick-up never starts (review fixes)", async () => {
  const { c, client, submit, start, state } = await rig();
  try {
    const t = trouble();
    const variants: Partial<ReleaseSuiteResult>[] = [
      { summary: "" }, { summary: "\u0007\u2028  " }, { summary: "x".repeat(499) + "\u{1F600}" + "y" }, { osVersion: "Ubuntu 22.04 LTS" },
    ];
    for (const [i, v] of variants.entries()) {
      const runner = new ReleaseHostRunner({ client, platform: linux, onTrouble: t.fn, suite: async (job) => good(job, v) });
      const cand = await submit(String(i));
      await start(cand);
      await runner.tick(); await within(runner.settled(), `variant ${i}`);
      const a = (await state(cand))[0];
      assert.equal(a.state, "passed", `variant ${i}: ${JSON.stringify(t.list.slice(-2))}`);
      assert.ok(a.result.summary.trim().length > 0 && a.result.summary.length <= 500 && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(a.result.summary), `variant ${i}`);
    }

    // concurrency: NaN must not mean "no limit"
    let open = 0, most = 0, letGo!: () => void;
    const held = new Promise<void>((r) => { letGo = r; });
    const busy = new ReleaseHostRunner({ client, platform: linux, concurrency: Number.NaN, suite: async (job) => { open++; most = Math.max(most, open); await held; open--; return good(job); } });
    for (const x of ["4", "5", "6"]) await start(await submit(x));
    await Promise.all([busy.tick(), busy.tick(), busy.tick()]);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(busy.running.length, 1, "overlapping looks with a NaN setting still run one");
    letGo();
    for (let k = 0; k < 3; k++) { await within(busy.settled(), "the held jobs"); await busy.tick(); }
    await within(busy.settled(), "the held jobs");
    assert.equal(most, 1);

    // NaN tries: bounded, not endless
    let tries = 0;
    const r2 = new ReleaseHostRunner({ client: { ...client, releaseWork: () => client.releaseWork(), releasePickUp: (a: string, k?: string) => client.releasePickUp(a, k), releaseReport: async () => { tries++; throw new WorkerRequestError(503, "unavailable", "x"); } } as never, platform: linux, reportTries: Number.NaN, sleep: async () => undefined, suite: async (job) => good(job) });
    await start(await submit("7"));
    await r2.tick(); await within(r2.settled(), "NaN tries");
    assert.equal(tries, 3);

    // ended while the pick-up was answered: the suite never starts
    let started = 0;
    let r3!: ReleaseHostRunner;
    r3 = new ReleaseHostRunner({ client: { releaseWork: () => client.releaseWork(), releaseReport: (a: string, r: any, k?: string) => client.releaseReport(a, r, k), releasePickUp: async (a: string, k?: string) => { const x = await client.releasePickUp(a, k); r3.stop(); return x; } } as never, platform: linux, suite: async (job) => { started++; return good(job); } });
    await start(await submit("8"));
    await r3.tick(); await within(r3.settled(), "stopped during pick-up");
    assert.equal(started, 0);
  } finally { await c.close(); }
});

test("serve keeps looking after a look throws, does not pile listeners on its signal, and ends when the signal aborts", async () => {
  let looks = 0;
  const ac = new AbortController();
  const told: string[] = [];
  const runner = new ReleaseHostRunner({ client: { releaseWork: async () => { looks++; if (looks === 2) return null as never; if (looks >= 30) ac.abort(); return { jobs: [], cancel: [] }; }, releasePickUp: async () => ({ pickedUpAt: "" }), releaseReport: async () => undefined } as never, platform: linux, onTrouble: (_a, w) => { told.push(w); }, suite: async () => { throw new Error("no"); } });
  let most = 0;
  const wait = (ms: number, s: AbortSignal): Promise<void> => { most = Math.max(most, getEventListeners(s, "abort").length); return new Promise((r) => setImmediate(r)); };
  await within(runner.serve(ac.signal, 1000, wait), "serve");
  assert.ok(looks >= 30, `looked ${looks} times`);
  // The default wait: many short waits leave no listener behind.
  const ac2 = new AbortController();
  let n = 0;
  const r2 = new ReleaseHostRunner({ client: { releaseWork: async () => { if (++n >= 3) ac2.abort(); return { jobs: [], cancel: [] }; }, releasePickUp: async () => ({ pickedUpAt: "" }), releaseReport: async () => undefined } as never, platform: linux, suite: async () => { throw new Error("no"); } });
  const t0 = Date.now();
  await within(r2.serve(ac2.signal, 1000), "default serve", 10_000);
  assert.ok(Date.now() - t0 >= 1900, "waited between looks");
  assert.equal(getEventListeners(ac2.signal, "abort").length, 0, "no listener left on the signal");
});

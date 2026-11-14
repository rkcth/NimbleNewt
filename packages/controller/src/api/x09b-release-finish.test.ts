import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteWorkerClient, WorkerRequestError, commandReleaseSuite, readReleaseHostConfig, readSuiteAnswer, runReleaseHost, type ReleaseSuiteJob } from "../remote/index.js";
import { NotificationService } from "../notifications/index.js";
import { ReleaseService } from "../release/index.js";
import { startController } from "./index.js";

/**
 * Finishing release testing (card X09b finish): the operator's suite as a program, the host program's configuration and session upkeep, the owner driving a whole release by chat against a real host program
 * (real worker transport, a real child process as the suite), and the owner being told when a test ended because nothing came back. No model, no network beyond loopback.
 */
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const linux = { os: "linux", arch: "x64" } as const;
const h = (c: string): string => c.repeat(64);
const COMMIT = "a".repeat(40);

/** The operator's suite for these tests: a small Node program that reads the job on standard input and writes its answer where it was told. `SUITE_MODE` says what it does. */
const SUITE = `
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const job = JSON.parse(readFileSync(0, "utf8"));
const mode = process.env.SUITE_MODE ?? "pass";
const answer = (counts, summary, extra = {}) => writeFileSync(process.env.NIMBLENEWT_RELEASE_RESULT, JSON.stringify({ tested: { sourceCommit: job.sourceCommit, suiteRevision: job.suiteRevision, artifactHashes: job.artifacts, dependencyLockHashes: job.dependencyLocks }, counts, summary, ...extra }));
if (process.env.SUITE_MARK) appendFileSync(process.env.SUITE_MARK, process.pid + "\\n");
if (mode === "pass") { console.log("suite output line"); answer({ passed: 12, failed: 0, skipped: 1 }, "all green", { osVersion: "6.8.0" }); }
else if (mode === "fail") { console.log("one failed"); answer({ passed: 11, failed: 1, skipped: 0 }, "one test failed"); }
else if (mode === "exit3") { console.error("boom at the end"); process.exit(3); }
else if (mode === "noresult") { console.log("done but silent"); }
else if (mode === "badjson") { writeFileSync(process.env.NIMBLENEWT_RELEASE_RESULT, "{ not json"); }
else if (mode === "badshape") { writeFileSync(process.env.NIMBLENEWT_RELEASE_RESULT, JSON.stringify({ tested: {}, counts: { passed: -1 } })); }
else if (mode === "noisy") { for (let i = 0; i < 2000; i++) console.log("x".repeat(100)); answer({ passed: 1, failed: 0, skipped: 0 }, "noisy"); }
else if (mode === "env") { answer({ passed: 1, failed: 0, skipped: 0 }, JSON.stringify({ secret: process.env.NN_TEST_SECRET ?? null, token: process.env.NIMBLENEWT_HOST_TOKEN ?? null, commit: process.env.NIMBLENEWT_RELEASE_COMMIT, attempt: process.env.NIMBLENEWT_RELEASE_ATTEMPT, memory: process.env.NIMBLENEWT_RELEASE_MEMORY_MB, timeout: process.env.NIMBLENEWT_RELEASE_TIMEOUT_SECONDS, operator: process.env.OPERATOR_SETTING ?? null, rev: job.suiteRevision })); }
else if (mode === "hang") { setInterval(() => {}, 1000); }
`;

const within = async <T>(p: Promise<T>, what: string, ms = 20_000): Promise<T> => {
  let t: NodeJS.Timeout | undefined;
  try { return await Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new assert.AssertionError({ message: `${what} did not settle within ${ms} ms` })), ms); })]); } finally { clearTimeout(t); }
};
/** Waits for a condition, polling, and fails with a message instead of hanging. */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new assert.AssertionError({ message: `${what} did not happen within ${ms} ms` }); await new Promise((r) => setTimeout(r, 25)); }
}
const folder = (): { dir: string; script: string; done: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "nn-x09b-fin-"));
  const script = join(dir, "suite.mjs");
  writeFileSync(script, SUITE);
  return { dir, script, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
};
const job = (extra: Partial<ReleaseSuiteJob> = {}): ReleaseSuiteJob => ({ attemptId: "rat-1", candidateId: "rcn-1", sourceCommit: COMMIT, suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, timeoutSeconds: 600, memoryMb: 2048, ...extra });
const live = new AbortController().signal;
const suiteWith = (script: string, mode: string, env: Record<string, string> = {}, more: { maxOutputBytes?: number } = {}) => commandReleaseSuite({ command: process.execPath, args: [script], env: { SUITE_MODE: mode, ...env }, ...more });

test("the command suite hands the job to the operator's program and reads only its written answer; the log is digested, nothing else of the host's environment is passed (card X09b finish)", async () => {
  const f = folder();
  process.env["NN_TEST_SECRET"] = "must-not-reach-the-suite";
  process.env["NIMBLENEWT_HOST_TOKEN"] = "host-credential-must-not-reach-the-suite";
  try {
    const ok = await suiteWith(f.script, "pass")(job(), live);
    assert.deepEqual(ok.counts, { passed: 12, failed: 0, skipped: 1 });
    assert.equal(ok.summary, "all green");
    assert.equal(ok.osVersion, "6.8.0");
    assert.deepEqual(ok.tested, { sourceCommit: COMMIT, suiteRevision: "suite-7", artifactHashes: { "nimblenewt.tgz": h("1") }, dependencyLockHashes: { "package-lock.json": h("2") } });
    assert.deepEqual(ok.log, { sha256: createHash("sha256").update("suite output line\n").digest("hex") }, "the digest is of what the program printed, and only the digest is returned");

    const env = JSON.parse((await suiteWith(f.script, "env", { OPERATOR_SETTING: "kept", NIMBLENEWT_RELEASE_COMMIT: "operator-cannot-override", NIMBLENEWT_RELEASE_RESULT: "operator-cannot-redirect" })(job(), live)).summary) as Record<string, unknown>;
    assert.deepEqual(env, { secret: null, token: null, commit: COMMIT, attempt: "rat-1", memory: "2048", timeout: "600", operator: "kept", rev: "suite-7" }, "the job's own limits and values are passed; the host's other environment is not; the adapter's own variables win");
  } finally { delete process.env["NN_TEST_SECRET"]; delete process.env["NIMBLENEWT_HOST_TOKEN"]; f.done(); }
});

test("the command suite is a failed test, never a pass, when the program exits badly, writes nothing usable, prints too much or cannot start (card X09b finish)", async () => {
  const f = folder();
  try {
    await assert.rejects(suiteWith(f.script, "exit3")(job(), live), /exited with code 3: boom at the end/);
    await assert.rejects(suiteWith(f.script, "noresult")(job(), live), /wrote no result file/);
    await assert.rejects(suiteWith(f.script, "badjson")(job(), live), /not JSON/);
    await assert.rejects(suiteWith(f.script, "badshape")(job(), live), /does not say what it tested/);
    await assert.rejects(suiteWith(f.script, "noisy", {}, { maxOutputBytes: 5000 })(job(), live), /printed more than 5000 bytes/);
    await assert.rejects(commandReleaseSuite({ command: join(f.dir, "no-such-program") })(job(), live), /could not be started/);
    const gone = new AbortController();
    gone.abort();
    await assert.rejects(suiteWith(f.script, "pass")(job(), gone.signal), /ended before the suite started/);
    // The answer reader itself: counts must be whole numbers, a summary is required, a missing field is named.
    assert.throws(() => readSuiteAnswer(JSON.stringify({ tested: { sourceCommit: "a", suiteRevision: "b", artifactHashes: {}, dependencyLockHashes: {} }, counts: { passed: 1.5, failed: 0, skipped: 0 }, summary: "x" })), /whole-number counts/);
    assert.throws(() => readSuiteAnswer(JSON.stringify({ tested: { sourceCommit: "a", suiteRevision: "b", artifactHashes: {}, dependencyLockHashes: {} }, counts: { passed: 1, failed: 0, skipped: 0 } })), /no summary/);
  } finally { f.done(); }
});

test("an abort (cancel, time limit, host stopping) ends the running program and the suite fails (card X09b finish)", async () => {
  const f = folder();
  const mark = join(f.dir, "pids.txt");
  try {
    const ac = new AbortController();
    const run = suiteWith(f.script, "hang", { SUITE_MARK: mark })(job(), ac.signal);
    const settled = run.then(() => "resolved", (e: Error) => e.message);
    await until(() => existsSync(mark) && readFileSync(mark, "utf8").trim().length > 0, "the program started");
    const pid = Number(readFileSync(mark, "utf8").trim().split("\n")[0]);
    ac.abort();
    assert.match(await within(settled, "the aborted suite"), /ended while the suite ran/);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "the program was ended");
  } finally { f.done(); }
});

test("the host's configuration is read strictly: a credential never sits in the file, unknown settings and bad values are refused, paths are relative to the file (card X09b finish)", async () => {
  const f = folder();
  const file = join(f.dir, "host.json");
  const ok = { controllerUrl: "https://nn.example:8443", suite: { command: "./suite.sh", args: ["--all"], env: { A: "b" } }, concurrency: 2, intervalSeconds: 30 };
  try {
    const read = (c: unknown, env: Record<string, string | undefined> = { NIMBLENEWT_HOST_TOKEN: "tok" }) => readReleaseHostConfig(JSON.stringify(c), file, env);
    const good = await read(ok);
    assert.equal(good.token, "tok");
    assert.equal(good.suite.command, join(f.dir, "suite.sh"), "a command with a folder is relative to the configuration file");
    assert.deepEqual([good.concurrency, good.intervalSeconds, good.suite.args], [2, 30, ["--all"]]);
    assert.equal((await read({ ...ok, suite: { ...ok.suite, command: "node" } })).suite.command, "node", "a bare name is looked up on the PATH");
    writeFileSync(join(f.dir, "tok.txt"), " from-file \n");
    assert.equal((await read({ ...ok, tokenFile: "tok.txt" }, {})).token, "from-file");
    assert.equal((await read({ ...ok, tokenEnv: "MY_TOKEN" }, { MY_TOKEN: "t2" })).token, "t2");
    await assert.rejects(read({ ...ok, token: "written-in-the-file" }), /must not be written in the configuration/);
    await assert.rejects(read(ok, {}), /no credential/);
    await assert.rejects(read({ ...ok, surprise: 1 }), /unknown setting "surprise"/);
    await assert.rejects(read({ ...ok, concurrency: 9 }), /concurrency must be a whole number from 1 to 4/);
    await assert.rejects(read({ ...ok, intervalSeconds: 0 }), /intervalSeconds/);
    await assert.rejects(read({ ...ok, suite: undefined }), /suite must be an object/);
    await assert.rejects(read({ ...ok, suite: { command: "x", args: [1] } }), /suite.args/);
    await assert.rejects(read({ ...ok, suite: { command: "x", shell: true } }), /unknown setting "shell"/);
    await assert.rejects(read({ ...ok, suite: { command: "x", env: { A: 1 } } }), /suite.env/);
    await assert.rejects(read({ ...ok, controllerUrl: "" }), /controllerUrl/);
    await assert.rejects(readReleaseHostConfig("{ nope", file, {}), /not JSON/);
  } finally { f.done(); }
});

/** A client that behaves as the real one for the session rules: calls need a connection, and the controller may forget the session. */
function fakeClient(opts: { jobs?: () => unknown } = {}) {
  const log: string[] = [];
  let session: { sessionId: string } | undefined;
  let forget = 0;
  const client = {
    get session() { return session as never; },
    forgetSession: () => { session = undefined; },
    connect: async () => { log.push("connect"); if (log.filter((l) => l === "connect").length === 1 && failFirstConnect) throw new WorkerRequestError(503, "unavailable", "starting up"); session = { sessionId: `s${log.length}` }; return session as never; },
    heartbeat: async () => { log.push("heartbeat"); },
    releaseWork: async () => { log.push("work"); if (forget > 0) { forget--; throw new WorkerRequestError(409, "fenced", "the session is not known"); } return (opts.jobs?.() ?? { jobs: [], cancel: [] }) as never; },
    releasePickUp: async () => { log.push("pickup"); return { pickedUpAt: "now" }; },
    releaseReport: async () => { log.push("report"); },
  };
  let failFirstConnect = false;
  return { client, log, forgetNext: (n = 1) => { forget = n; }, failFirstConnect: () => { failFirstConnect = true; } };
}

test("the host program connects, keeps the session alive with heartbeats, reconnects when the controller forgot the session and tells (not dies of) a controller that is down (card X09b finish)", async () => {
  const fake = fakeClient();
  const ac = new AbortController();
  let clock = 0;
  let looks = 0;
  const told: string[] = [];
  fake.failFirstConnect();
  const run = runReleaseHost({
    client: fake.client as never, suite: async () => { throw new Error("no job expected"); }, signal: ac.signal, platform: linux, everyMs: 10, heartbeatMs: 1000, now: () => clock,
    onTrouble: (_id, what) => told.push(what),
    wait: async () => {
      looks++;
      clock += 400;
      // Look 1 failed to connect, 2 connected; at look 5 the controller forgets the session once; stop after enough looks.
      if (looks === 5) fake.forgetNext();
      if (looks >= 9) ac.abort();
    },
  });
  await within(run, "the host loop");
  assert.deepEqual(told.slice(0, 1), ["could not connect to the controller"], "a controller that is not ready is told, and the loop goes on");
  const connects = fake.log.filter((l) => l === "connect").length;
  assert.ok(connects >= 3, `connected again after the session was forgotten (${fake.log.join(",")})`);
  assert.ok(fake.log.includes("heartbeat"), "the session is kept alive");
  assert.ok(told.includes("the job list could not be fetched"), "a forgotten session is told once and not fatal");
  assert.equal(fake.log.filter((l) => l === "work").length >= 3, true, "the host kept looking for work");
});

test("stopping the host program ends a running suite and waits for it (card X09b finish)", async () => {
  const jobPayload = { capability: "release-test", attemptId: "rat-9", candidateId: "rcn-9", sourceCommit: COMMIT, suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, cell: linux, limits: { timeoutSeconds: 600, memoryMb: 1024 } };
  const fake = fakeClient({ jobs: () => ({ jobs: [{ attemptId: "rat-9", payload: jobPayload }], cancel: [] }) });
  const ac = new AbortController();
  let suiteAborted = false;
  let started = false;
  const run = runReleaseHost({
    client: fake.client as never, signal: ac.signal, platform: linux, everyMs: 10, wait: async () => { await until(() => started, "the suite started"); ac.abort(); },
    suite: (_job, signal) => new Promise((_, reject) => { started = true; signal.addEventListener("abort", () => { suiteAborted = true; reject(new Error("stopped")); }, { once: true }); }),
  });
  await within(run, "stopping the host");
  assert.equal(suiteAborted, true);
  assert.equal(fake.log.includes("report"), false, "nothing is reported for a test that was cut short (the controller ends it by its own time limit)");
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

async function rig(clock: () => string) {
  const d = mkdtempSync(join(tmpdir(), "nn-x09b-fin-c-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: { timer: new ManualTimer(), intervalMs: 1000, clock, route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }), remote: { blobDirectory: join(d, "blobs"), hosts: [] } },
  } as never);
  assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  await c.services.principals.enroll(rob, { commandId: "e-rig", kind: "host", name: "rig", grants: [] });
  const token = (await c.services.principals.issueCredential(rob, "host:rig")).token;
  const client = () => new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token, workerVersion: "release-host-test" });
  const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
  const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes as unknown as { status: string; message?: string; proposalId?: string; summary?: string }[]; };
  const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
  const confirm = async (id: string, proposalId: string | undefined, what: string) => turn(id, `yes, ${what}`, [{ kind: "apply_proposal", proposalId, evidence: what, basis: "owner" }]);
  return { c, d, boot, rob, client, call, turn, cmd, confirm, close: async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}

test("the owner drives a whole release by chat: submit, authorize the host, start, the real host program runs a real child process, the result reaches the gate, approve (card X09b finish)", async () => {
  const f = folder();
  const w = await rig(() => new Date().toISOString());
  const stop = new AbortController();
  let host: Promise<void> | undefined;
  try {
    const told: string[] = [];
    // 1. Submit by chat: shown first, recorded on the owner's word.
    const said = `Please get build ${COMMIT} tested: suite revision suite-7, artifact nimblenewt.tgz ${h("1")}, lock file package-lock.json ${h("2")}, on linux x64.`;
    const shown = await w.turn("m1", said, [w.cmd("release.submit", { manifest: { sourceCommit: COMMIT, suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, matrix: [linux] } }, said)]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown[0]));
    assert.equal((await w.confirm("m2", shown[0]!.proposalId, "go ahead and submit it"))[0]!.status, "applied");
    const candidateId = (await ReleaseService.withEpoch(w.c.storage, w.c.epoch).candidates(w.rob, { limit: 5 })).candidates[0]!.candidateId;

    // 2. Authorize the host and start the test, by chat.
    const hostWords = "let host:rig run release tests on linux x64";
    const hostShown = await w.turn("m3", hostWords, [w.cmd("release.host", { hostId: "host:rig", os: "linux", arch: "x64" }, hostWords)]);
    assert.equal((await w.confirm("m4", hostShown[0]!.proposalId, "authorize that host"))[0]!.status, "applied");
    const startWords = `start the release test for ${candidateId} on linux x64 on host:rig`;
    const startShown = await w.turn("m5", startWords, [w.cmd("release.start", { candidateId, cell: linux, hostId: "host:rig" }, startWords)]);
    assert.equal(startShown[0]!.status, "proposed", JSON.stringify(startShown[0]));
    assert.equal((await w.confirm("m6", startShown[0]!.proposalId, "start the test"))[0]!.status, "applied");
    const attempts = async () => (await w.call("release.attempts", { candidateId })).result.attempts as any[];
    assert.equal((await attempts())[0].state, "issued", "queued for the host");

    // 3. The host program picks it up, runs the operator's program as a child process, and reports what it measured.
    host = runReleaseHost({
      client: w.client(), suite: commandReleaseSuite({ command: process.execPath, args: [f.script], env: { SUITE_MODE: "pass" } }), signal: stop.signal, platform: linux, everyMs: 20, heartbeatMs: 200,
      wait: (ms, s) => new Promise((r) => { const t = setTimeout(r, Math.min(ms, 50)); s.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); }), onTrouble: (id, what) => told.push(`${id ?? "-"}: ${what}`),
    });
    await until(async () => (await attempts())[0].state === "passed", "the test passed");
    const a = (await attempts())[0];
    assert.deepEqual([a.result.counts, a.result.summary, a.result.environment.os], [{ passed: 12, failed: 0, skipped: 1 }, "all green", "linux"]);
    assert.equal(a.result.logDigest, createHash("sha256").update("suite output line\n").digest("hex"));
    assert.deepEqual(told, [], "the host had no trouble");

    // 4. The owner asks how it is going, then approves, by chat. The gate agrees.
    const askWords = "how is the release testing going?";
    const view = await w.turn("m7", askWords, [{ kind: "status", request: { kind: "release", candidateId }, evidence: askWords, basis: "owner" }]);
    assert.match(JSON.stringify(view[0]), /pass/i);
    const approveWords = `approve ${candidateId}, it passed everywhere`;
    const approveShown = await w.turn("m8", approveWords, [w.cmd("release.approve", { candidateId }, approveWords)]);
    assert.equal(approveShown[0]!.status, "proposed", JSON.stringify(approveShown[0]));
    assert.equal((await w.confirm("m9", approveShown[0]!.proposalId, "approve that candidate"))[0]!.status, "applied");
    assert.equal((await w.call("release.gate", { candidateId })).result.gate.approved, true);
  } finally {
    stop.abort();
    if (host !== undefined) await within(host, "the host program stopping").catch(() => undefined);
    await w.close();
    f.done();
  }
});

test("a release test whose host never answers is ended as timed out by the controller's own clock and the owner is told once; it is never a pass and the platform can be tried again (card X09b finish)", async () => {
  let now = Date.parse("2026-11-14T10:00:00.000Z");
  const w = await rig(() => new Date(now).toISOString());
  try {
    const manifest = { sourceCommit: COMMIT, suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, matrix: [linux] };
    const candidateId = (await w.call("release.submit", { manifest }, "sub1")).result.candidateId as string;
    assert.ok((await w.call("release.host", { hostId: "host:rig", os: "linux", arch: "x64" }, "hst1")).ok);
    const client = w.client();
    await client.connect({ ...CAPS } as never);
    const started = await w.call("release.start", { candidateId, cell: linux, hostId: "host:rig", timeoutSeconds: 60 }, "go1");
    assert.ok(started.ok, JSON.stringify(started));
    const attemptId = started.result.attemptId as string;
    await client.releasePickUp(attemptId); // the host took it and then went silent
    await w.c.dispatch!.dispatcher.tick();
    assert.equal((await w.call("release.attempts", { candidateId })).result.attempts[0].state, "issued", "inside its time it is left alone");
    const inbox = async () => (await NotificationService.withEpoch(w.c.storage, w.c.epoch).inbox(w.rob)).items.filter((i) => JSON.stringify(i).includes(attemptId));
    assert.equal((await inbox()).length, 0);

    now += (60 + 600 + 5) * 1000; // its time plus the grace
    await w.c.dispatch!.dispatcher.tick();
    const a = (await w.call("release.attempts", { candidateId })).result.attempts[0];
    assert.equal(a.state, "timed_out");
    assert.equal((await w.call("release.gate", { candidateId })).result.gate.cells[0].state, "timed_out", "never a pass");
    assert.equal((await inbox()).length, 1, "the owner is told");
    assert.match(JSON.stringify((await inbox())[0]), /ran out of time|timed out/);
    await w.c.dispatch!.dispatcher.tick();
    await w.c.dispatch!.dispatcher.tick();
    assert.equal((await inbox()).length, 1, "told once, however many sweeps follow");
    // The platform is free for a retry.
    const retry = await w.call("release.start", { candidateId, cell: linux, hostId: "host:rig" }, "go2");
    assert.ok(retry.ok, JSON.stringify(retry));
    assert.notEqual(retry.result.attemptId, attemptId);
  } finally { await w.close(); }
});

const MAIN = fileURLToPath(new URL("../remote/release-host-main.js", import.meta.url));

test("the release host program as a real process: it starts from a configuration file, runs a job and stops; a bad configuration is told without the credential (card X09b finish)", async () => {
  const f = folder();
  const w = await rig(() => new Date().toISOString());
  const SECRET = "secret-host-credential-value";
  const run = (args: string[], env: Record<string, string>) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
    const exited = new Promise<number | null>((r) => child.once("close", r));
    return { child, exited, err: () => err };
  };
  try {
    // A bad configuration: a refusal that names the problem, never the credential, and a failing exit code.
    const bad = join(f.dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ controllerUrl: "http://127.0.0.1:1", token: SECRET, suite: { command: "x" } }));
    const refused = run([bad], { NIMBLENEWT_HOST_TOKEN: SECRET });
    assert.equal(await within(refused.exited, "the refusal"), 2);
    assert.match(refused.err(), /must not be written in the configuration/);
    assert.equal(refused.err().includes(SECRET), false, "the credential is never printed");

    // A good one: the owner queues a test, the process takes it, and a stop ends it.
    const manifest = { sourceCommit: COMMIT, suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, matrix: [{ os: process.platform, arch: process.arch }] };
    const platform = { os: process.platform, arch: process.arch };
    const candidateId = (await w.call("release.submit", { manifest }, "sub1")).result.candidateId as string;
    assert.ok((await w.call("release.host", { hostId: "host:rig", ...platform }, "hst1")).ok);
    const started = await w.call("release.start", { candidateId, cell: platform, hostId: "host:rig" }, "go1");
    assert.ok(started.ok, JSON.stringify(started));
    const cfg = join(f.dir, "host.json");
    writeFileSync(cfg, JSON.stringify({ controllerUrl: w.c.dispatch!.workerUrl, intervalSeconds: 1, suite: { command: process.execPath, args: [f.script], env: { SUITE_MODE: "pass" } } }));
    const token = (await w.c.services.principals.issueCredential(w.rob, "host:rig")).token;
    const proc = run([cfg], { NIMBLENEWT_HOST_TOKEN: token });
    try {
      await until(async () => (await w.call("release.attempts", { candidateId })).result.attempts[0].state === "passed", `the test passed (${proc.err()})`, 60_000);
    } finally {
      proc.child.kill();
      await within(proc.exited, "the process stopping");
    }
    assert.equal(proc.err().includes(token), false, "the credential is never printed");
  } finally { await w.close(); f.done(); }
});

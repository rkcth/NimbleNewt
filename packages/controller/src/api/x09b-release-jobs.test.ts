import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteWorkerClient, WorkerRequestError } from "../remote/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };
const h = (c: string): string => c.repeat(64);
const manifest = (commit: string) => ({ sourceCommit: commit.repeat(40), suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, matrix: [{ os: "linux", arch: "x64" }, { os: "win32", arch: "x64" }] });
const linux = { os: "linux", arch: "x64" };
const result = (job: any, extra: Record<string, unknown> = {}) => ({
  sourceCommit: job.payload.sourceCommit, suiteRevision: "suite-7", artifactHashes: job.payload.artifacts, dependencyLockHashes: job.payload.dependencyLocks, environment: linux,
  outcome: "pass", counts: { passed: 120, failed: 0, skipped: 2 }, logDigest: h("9"), summary: "all green", ...extra,
});
const refused = async (code: string, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof WorkerRequestError, String(e)); assert.equal((e as WorkerRequestError).code, code, (e as Error).message); return true; });
};

test("a release test is delivered to the host, picked up and reported over the worker protocol through startController; QA agents and their bosses start and cancel only as the owner's setting allows; chat words start, cancel and the setting (card X09b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-x09b-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: [] },
    },
  } as never);
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const host = async (name: string): Promise<RemoteWorkerClient> => {
      await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "host", name, grants: [] });
      const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: (await c.services.principals.issueCredential(rob, `host:${name}`)).token, workerVersion: "worker-9.1.0" });
      await client.connect({ ...CAPS } as never);
      return client;
    };
    const rig = await host("rig"), prod = await host("prod");
    let n = 0;
    const cid = (l: string): string => `${l}-${n++}`;
    const submit = async (commit: string): Promise<string> => (await call(boot.token, "release.submit", { manifest: manifest(commit) }, cid("s"))).result.candidateId;
    const fakeHost = async (client: RemoteWorkerClient, then: (job: any) => Promise<void>): Promise<void> => { for (const job of await client.releaseJobs()) await then(job); };

    // ---- the owner's host authorization is the base: no authorization, no job.
    const cand1 = await submit("a");
    assert.equal((await call(boot.token, "release.start", { candidateId: cand1, cell: linux, hostId: "host:rig" }, cid("st"))).error?.code, "forbidden", "the host is not authorized yet");
    assert.ok((await call(boot.token, "release.host", { hostId: "host:rig", os: "linux", arch: "x64" }, cid("rh"))).ok);

    // ---- start by the owner, delivery, pick-up, report
    const startCmd = cid("st");
    const started = await call(boot.token, "release.start", { candidateId: cand1, cell: linux, hostId: "host:rig" }, startCmd);
    assert.ok(started.ok, JSON.stringify(started));
    assert.equal((await call(boot.token, "release.start", { candidateId: cand1, cell: linux, hostId: "host:rig" }, startCmd)).result.attemptId, started.result.attemptId, "a replay is the same attempt");
    assert.equal((await call(boot.token, "release.start", { candidateId: cand1, cell: linux, hostId: "host:rig" }, cid("st"))).error?.code, "invalid_command", "one open attempt per platform");
    const attemptId = started.result.attemptId as string;
    assert.deepEqual((await prod.releaseJobs()), [], "another host is given nothing");
    const jobs = await rig.releaseJobs();
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0]!.payload, started.result.payload, "the host gets exactly the payload the controller built");
    assert.equal(jobs[0]!.payload["capability"], "release-test");
    await refused("not_found", () => prod.releasePickUp(attemptId));
    await refused("not_found", () => prod.releaseReport(attemptId, result(jobs[0]) as never));
    await refused("invalid_command", () => rig.releaseReport(attemptId, result(jobs[0]) as never), );
    const picked = await rig.releasePickUp(attemptId, "k-pick");
    assert.deepEqual(await rig.releasePickUp(attemptId, "k-pick"), picked, "a retry applies once");
    assert.deepEqual(await rig.releasePickUp(attemptId, "k-pick-2"), picked, "a second pick-up keeps the first time");
    assert.equal((await rig.releaseJobs())[0]!.pickedUpAt, picked.pickedUpAt);
    // What differs from the candidate is refused and the attempt stays open; bounded fields are checked.
    await refused("invalid_command", () => rig.releaseReport(attemptId, result(jobs[0], { sourceCommit: "b".repeat(40) }) as never));
    await refused("invalid_command", () => rig.releaseReport(attemptId, result(jobs[0], { summary: "x".repeat(501) }) as never));
    await refused("invalid_command", () => rig.releaseReport(attemptId, { ...result(jobs[0]), extra: 1 } as never));
    assert.equal((await call(boot.token, "release.gate", { candidateId: cand1 })).result.gate.cells.find((x: any) => x.cell.os === "linux").state, "running");
    await rig.releaseReport(attemptId, result(jobs[0]) as never, "k-rep");
    await rig.releaseReport(attemptId, result(jobs[0]) as never, "k-rep");
    await refused("invalid_command", () => rig.releaseReport(attemptId, result(jobs[0]) as never, "k-rep-2"));
    assert.deepEqual(await rig.releaseJobs(), [], "a finished attempt is no longer offered");
    const gate = (await call(boot.token, "release.gate", { candidateId: cand1 })).result.gate;
    assert.equal(gate.cells.find((x: any) => x.cell.os === "linux").state, "passed");
    assert.equal(gate.ready, false, "windows is missing");
    const evidence = (await call(boot.token, "release.attempts", { candidateId: cand1 })).result.attempts[0];
    assert.equal(evidence.issuedBy, rob.id);
    assert.equal(evidence.result.logDigest, h("9"));

    // ---- a host's authorization withdrawn: nothing is offered, picked up or reported
    const cand2 = await submit("c");
    const second = await call(boot.token, "release.start", { candidateId: cand2, cell: linux, hostId: "host:rig", timeoutSeconds: 600, memoryMb: 1024 }, cid("st"));
    assert.ok(second.ok);
    const job2 = (await rig.releaseJobs())[0]!;
    assert.deepEqual((job2.payload as any).limits, { timeoutSeconds: 600, memoryMb: 1024 });
    await rig.releasePickUp(second.result.attemptId);
    assert.ok((await call(boot.token, "release.host", { hostId: "host:rig", os: "linux", arch: "x64", active: false }, cid("rh"))).ok);
    assert.deepEqual(await rig.releaseJobs(), []);
    await refused("forbidden", () => rig.releasePickUp(second.result.attemptId));
    await refused("forbidden", () => rig.releaseReport(second.result.attemptId, result(job2) as never));
    assert.ok((await call(boot.token, "release.interrupt", { attemptId: second.result.attemptId, reason: "withdrawn" }, cid("in"))).ok);
    assert.ok((await call(boot.token, "release.host", { hostId: "host:rig", os: "linux", arch: "x64" }, cid("rh"))).ok);

    // ---- agents: the setting decides, the default is the installation profile (strict here: owner only)
    const qa = (await c.services.agents.create(rob, { commandId: cid("ag"), friendlyName: "Quinn", roles: ["qa"] })).id;
    const boss = (await c.services.agents.create(rob, { commandId: cid("ag"), friendlyName: "Bea", roles: ["director"] })).id;
    await c.services.agents.update(rob, { commandId: cid("ag"), agentId: qa, expectedRevision: 1, supervisorId: boss } as never);
    const other = (await c.services.agents.create(rob, { commandId: cid("ag"), friendlyName: "Otto", roles: ["author"] })).id;
    const token = async (id: string): Promise<string> => (await c.services.principals.issueCredential(rob, `agent:${id}`)).token;
    const [qaT, bossT, otherT] = [await token(qa), await token(boss), await token(other)];
    const cand3 = await submit("d");
    const asAgent = (t: string, extra: Record<string, unknown> = {}, id = cid("st")) => call(t, "release.start", { candidateId: cand3, cell: linux, hostId: "host:rig", ...extra }, id);
    const s0 = (await call(boot.token, "release.settings.get", {})).result.item;
    assert.deepEqual([s0.revision, s0.profile, s0.effective], [0, "strict", { qaAgents: false, bosses: false, qaRole: "qa" }]);
    for (const t of [qaT, bossT, otherT]) assert.equal((await asAgent(t)).error?.code, "forbidden", "strict: owner only");
    for (const [op, args] of [["release.settings.get", {}], ["release.settings.set", { qaAgents: true }], ["release.issuers.enable", { who: "all" }]] as const) assert.equal((await call(qaT, op, args, op.endsWith("get") ? undefined : cid("x"))).error?.code, "forbidden", `${op} is the owner's`);

    assert.equal((await call(boot.token, "release.issuers.enable", { who: "qa-agents", expectedRevision: 5 }, cid("is"))).error?.code, "stale_revision");
    assert.equal((await call(boot.token, "release.issuers.enable", { who: "everyone" }, cid("is"))).error?.code, "invalid_command");
    const enabled = await call(boot.token, "release.issuers.enable", { who: "qa-agents", expectedRevision: 0 }, cid("is"));
    assert.ok(enabled.ok, JSON.stringify(enabled));
    assert.equal((await asAgent(otherT)).error?.code, "forbidden", "an agent without the role is never an issuer");
    assert.equal((await asAgent(bossT)).error?.code, "forbidden", "bosses are still off");
    assert.equal((await asAgent(qaT, { workerId: qaT })).error?.code, "forbidden");
    assert.equal((await asAgent(qaT, { workerId: `agent:${qa}` })).error?.code, "forbidden", "an agent cannot name itself as the reporter");
    const byQa = await asAgent(qaT);
    assert.ok(byQa.ok, JSON.stringify(byQa));
    assert.equal(((await call(boot.token, "release.attempts", { candidateId: cand3 })).result.attempts[0]).issuedBy, `agent:${qa}`);
    assert.equal((await call(qaT, "release.approve", { candidateId: cand3 }, cid("ap"))).error?.code, "forbidden", "an issuer cannot approve");
    assert.equal((await call(qaT, "release.host", { hostId: "host:prod", os: "linux", arch: "x64" }, cid("rh"))).error?.code, "forbidden", "nor authorize hosts");
    assert.equal((await call(qaT, "release.interrupt", { attemptId: byQa.result.attemptId, reason: "x" }, cid("in"))).error?.code, "forbidden");
    assert.equal((await call(otherT, "release.cancel", { attemptId: byQa.result.attemptId, reason: "x" }, cid("cx"))).error?.code, "forbidden");
    // Boss: off, then on.
    assert.equal((await call(bossT, "release.cancel", { attemptId: byQa.result.attemptId, reason: "no longer needed" }, cid("cx"))).error?.code, "forbidden");
    assert.ok((await call(boot.token, "release.issuers.enable", { who: "bosses" }, cid("is"))).ok);
    const cancelled = await call(bossT, "release.cancel", { attemptId: byQa.result.attemptId, reason: "no longer needed" }, cid("cx"));
    assert.ok(cancelled.ok, JSON.stringify(cancelled));
    const ended = (await call(boot.token, "release.attempts", { candidateId: cand3 })).result.attempts[0];
    assert.deepEqual([ended.state, ended.endedBy], ["interrupted", `agent:${boss}`]);
    assert.equal((await call(boot.token, "release.gate", { candidateId: cand3 })).result.gate.cells.find((x: any) => x.cell.os === "linux").state, "interrupted", "a cancelled test is never a pass");
    assert.ok((await asAgent(bossT)).ok, "the boss of a QA agent starts too");
    // A boss who no longer supervises the QA agent loses the right at once.
    await c.services.agents.update(rob, { commandId: cid("ag"), agentId: qa, expectedRevision: 2, supervisorId: other } as never);
    assert.equal((await call(bossT, "release.cancel", { attemptId: (await call(boot.token, "release.attempts", { candidateId: cand3 })).result.attempts[1].id, reason: "late" }, cid("cx"))).error?.code, "forbidden");
    // Off again: narrowing applies at once; a retired QA agent has nothing.
    assert.ok((await call(boot.token, "release.issuers.disable", { who: "all" }, cid("is"))).ok);
    assert.equal((await asAgent(qaT)).error?.code, "forbidden");
    assert.deepEqual((await call(boot.token, "release.settings.get", {})).result.item.effective, { qaAgents: false, bosses: false, qaRole: "qa" });
    const stale = (await call(boot.token, "release.settings.set", { qaRole: "tester", expectedRevision: 0 }, cid("ss")));
    assert.equal(stale.error?.code, "stale_revision");
    assert.ok((await call(boot.token, "release.settings.set", { qaAgents: true, qaRole: "author" }, cid("ss"))).ok);
    const viaRole = await call(otherT, "release.start", { candidateId: cand3, cell: linux, hostId: "host:rig" }, cid("st"));
    assert.equal(viaRole.error?.code, "invalid_command", `the role name is the owner's to choose; this agent now passes the role check (and meets the open attempt): ${JSON.stringify(viaRole)}`);
    assert.ok((await call(boot.token, "release.settings.set", { qaAgents: null, qaRole: null }, cid("ss"))).ok);
    assert.deepEqual((await call(boot.token, "release.settings.get", {})).result.item.effective, { qaAgents: false, bosses: false, qaRole: "qa" }, "null returns a field to the profile's default");

    // ---- chat: starting is shown first, cancelling applies at once, narrowing applies at once, widening is shown first
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const cand4 = await submit("e");
    const startWords = "start the release test on host:rig for linux x64";
    const shown = await turn("m1", startWords, [{ kind: "command", op: "release.start", args: { candidateId: cand4, cell: linux, hostId: "host:rig" }, evidence: startWords, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.deepEqual((await call(boot.token, "release.attempts", { candidateId: cand4 })).result.attempts, [], "nothing started yet");
    const go = await turn("m2", "yes, go ahead", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "go ahead", basis: "owner" }]);
    assert.equal(go[0]!.status, "applied", JSON.stringify(go));
    const chatAttempt = (await call(boot.token, "release.attempts", { candidateId: cand4 })).result.attempts[0];
    assert.equal(chatAttempt.state, "issued");
    assert.ok((await rig.releaseJobs()).some((j) => j.attemptId === chatAttempt.id), "the chat's start reached the host");
    const cancelWords = "cancel that release test, the machine is needed";
    const cancel = await turn("m3", cancelWords, [{ kind: "command", op: "release.cancel", args: { attemptId: chatAttempt.id, reason: "the machine is needed" }, evidence: cancelWords, basis: "owner" }]);
    assert.equal(cancel[0]!.status, "applied", JSON.stringify(cancel));
    assert.equal((await call(boot.token, "release.attempts", { candidateId: cand4 })).result.attempts[0].state, "interrupted");
    assert.ok(!(await rig.releaseJobs()).some((j) => j.attemptId === chatAttempt.id), "a cancelled job is not offered");
    const enableWords = "let QA agents start release tests";
    const enableShown = await turn("m4", enableWords, [{ kind: "command", op: "release.issuers.enable", args: { who: "qa-agents" }, evidence: enableWords, basis: "owner" }]);
    assert.equal(enableShown[0]!.status, "proposed", "widening is shown first");
    assert.equal((await call(boot.token, "release.settings.get", {})).result.item.effective.qaAgents, false);
    const enOut = await turn("m5", "yes, do that", [{ kind: "apply_proposal", proposalId: enableShown[0]!.proposalId, evidence: "do that", basis: "owner" }]); assert.equal(enOut[0]!.status, "applied", JSON.stringify(enOut));
    assert.equal((await call(boot.token, "release.settings.get", {})).result.item.effective.qaAgents, true);
    const disableWords = "stop QA agents starting release tests";
    const off = await turn("m6", disableWords, [{ kind: "command", op: "release.issuers.disable", args: { who: "qa-agents" }, evidence: disableWords, basis: "owner" }]);
    assert.equal(off[0]!.status, "applied", JSON.stringify(off));
    assert.equal((await call(boot.token, "release.settings.get", {})).result.item.effective.qaAgents, false);
    assert.equal((await call(qaT, "release.settings.get", {})).error?.code, "forbidden");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

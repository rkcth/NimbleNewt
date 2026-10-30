import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const h = (c: string) => c.repeat(64);

test("release tests run through the state API: the owner submits and issues, the restricted worker reports, a worker cannot approve, and the gate survives a restart (card X09)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-release-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const first = await open();
    const boot = await first.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await first.services.principals.authenticate(boot.token);
    await first.services.principals.enroll(rob, { commandId: "e1", kind: "agent", name: "tester", grants: [{ action: "release.report", project: "*" }] });
    const tester = await first.services.principals.authenticate((await first.services.principals.issueCredential(rob, "agent:tester")).token);
    const testerToken = (await first.services.principals.issueCredential(rob, "agent:tester")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => first.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const manifest = { sourceCommit: "c".repeat(40), suiteRevision: "s1", artifacts: { "a.tgz": h("1") }, dependencyLocks: { "lock": h("2") }, matrix: [{ os: "linux", arch: "x64" }] };
    const sub = await call(boot.token, "release.submit", { manifest }, "r1");
    assert.equal(sub.ok, true, JSON.stringify(sub));
    const candidateId = sub.result.candidateId as string;
    assert.equal((await call(testerToken, "release.submit", { manifest }, "r1x")).ok, false, "a worker cannot submit");
    assert.equal((await call(boot.token, "release.host", { hostId: "lx", os: "linux", arch: "x64" }, "r2")).ok, true);
    const issued = await call(boot.token, "release.issue", { candidateId, cell: { os: "linux", arch: "x64" }, hostId: "lx", workerId: tester.id, timeoutSeconds: 600, memoryMb: 2048 }, "r3");
    assert.equal(issued.ok, true, JSON.stringify(issued));
    const attemptId = issued.result.attemptId as string;
    const report = { attemptId, sourceCommit: "c".repeat(40), suiteRevision: "s1", artifactHashes: { "a.tgz": h("1") }, dependencyLockHashes: { "lock": h("2") }, environment: { os: "linux", arch: "x64" }, outcome: "pass", counts: { passed: 10, failed: 0, skipped: 0 }, logDigest: h("5"), summary: "ok" };
    assert.equal((await call(testerToken, "release.report", { ...report, suiteRevision: "s0" }, "r4")).error.code, "invalid_command");
    assert.equal((await call(testerToken, "release.approve", { candidateId }, "r5")).ok, false, "a worker cannot approve");
    assert.equal((await call(testerToken, "release.report", report, "r6")).ok, true);
    await first.close();
    const second = await open();
    const gate = ((await second.api.handle(boot.token, { v: 1, op: "release.gate", args: { candidateId } } as never)) as any).result.gate;
    assert.deepEqual([gate.ready, gate.approved], [true, false], "the gate survived the restart");
    assert.equal(((await second.api.handle(boot.token, { v: 1, op: "release.approve", commandId: "r7", args: { candidateId } } as never)) as any).ok, true);
    await second.close();
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

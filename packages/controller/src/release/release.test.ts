import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { ReleaseService, jobPayload, type Cell } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-30T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const h = (c: string): string => c.repeat(64);
const manifest = (extra: Record<string, unknown> = {}) => ({
  sourceCommit: "a".repeat(40), suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") },
  matrix: [{ os: "linux", arch: "x64" }, { os: "win32", arch: "x64" }], ...extra,
});
const linux: Cell = { os: "linux", arch: "x64" };
const win: Cell = { os: "win32", arch: "x64" };

for (const backend of backends) {
  const suite = (name: string, body: (c: { rel: ReleaseService; owner: Principal; w1: Principal; w2: Principal; candidate: string }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const worker = async (nm: string, grants: { action: string; project: string }[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const w1 = await worker("rt1", [{ action: "release.report", project: "*" }]);
        const w2 = await worker("rt2", [{ action: "release.report", project: "*" }]);
        const rel = ReleaseService.withEpoch(world.storage, projects.epoch, options);
        const { candidateId } = await rel.submit(owner, { commandId: cid("s"), manifest: manifest() });
        await body({ rel, owner, w1, w2, candidate: candidateId });
      } finally { await world.close(); }
    });

  const issue = (rel: ReleaseService, owner: Principal, candidate: string, cell: Cell, host: string, worker: Principal) =>
    rel.issue(owner, { commandId: cid("i"), candidateId: candidate, cell, hostId: host, workerId: worker.id, timeoutSeconds: 3600, memoryMb: 4096 });
  const result = (attemptId: string, extra: Record<string, unknown> = {}) => ({
    commandId: cid("r"), attemptId, sourceCommit: "a".repeat(40), suiteRevision: "suite-7", artifactHashes: { "nimblenewt.tgz": h("1") }, dependencyLockHashes: { "package-lock.json": h("2") }, environment: { os: "linux", arch: "x64" },
    outcome: "pass" as const, counts: { passed: 120, failed: 0, skipped: 2 }, logDigest: h("9"), summary: "all green", ...extra,
  });

  suite("a candidate is immutable: the same manifest is the same candidate, a changed one is another, and a bad manifest is refused (card X09)", async (c) => {
    const again = await c.rel.submit(c.owner, { commandId: cid("s"), manifest: manifest({ matrix: [{ arch: "x64", os: "win32" }, { os: "linux", arch: "x64" }] }) });
    assert.equal(again.candidateId, c.candidate, "the order of the matrix does not make a new candidate");
    const other = await c.rel.submit(c.owner, { commandId: cid("s"), manifest: manifest({ sourceCommit: "b".repeat(40) }) });
    assert.notEqual(other.candidateId, c.candidate);
    await refuses("invalid_command", () => c.rel.submit(c.owner, { commandId: cid("s"), manifest: manifest({ sourceCommit: "abc" }) }), /40-character/);
    await refuses("invalid_command", () => c.rel.submit(c.owner, { commandId: cid("s"), manifest: manifest({ artifacts: { x: "nothex" } }) }), /sha256/);
    await refuses("invalid_command", () => c.rel.submit(c.owner, { commandId: cid("s"), manifest: manifest({ matrix: [linux, linux] }) }), /twice/);
    await refuses("forbidden", () => c.rel.submit(c.w1, { commandId: cid("s"), manifest: manifest() }));
  });

  suite("the same candidate, platform and attempt give the same job payload, and a host is used only if the owner authorized it for that platform", async (c) => {
    const m = manifest() as never;
    assert.deepEqual(jobPayload(c.candidate, m, linux, "rat-x", { timeoutSeconds: 1, memoryMb: 1 }), jobPayload(c.candidate, m, linux, "rat-x", { timeoutSeconds: 1, memoryMb: 1 }));
    await refuses("forbidden", () => issue(c.rel, c.owner, c.candidate, linux, "pc-prod", c.w1), /not authorized/);
    await c.rel.authorizeHost(c.owner, { commandId: cid("a"), hostId: "pc-prod", os: "win32", arch: "x64" });
    await refuses("forbidden", () => issue(c.rel, c.owner, c.candidate, linux, "pc-prod", c.w1), /win32\/x64, not linux\/x64/);
    await refuses("forbidden", () => c.rel.authorizeHost(c.w1, { commandId: cid("a"), hostId: "pc-prod", os: "linux", arch: "x64" }));
    await c.rel.authorizeHost(c.owner, { commandId: cid("a"), hostId: "pc-prod", os: "win32", arch: "x64", active: false });
    await refuses("forbidden", () => issue(c.rel, c.owner, c.candidate, win, "pc-prod", c.w1), /not authorized/);
    await refuses("invalid_command", () => issue(c.rel, c.owner, c.candidate, { os: "darwin", arch: "arm64" }, "mac", c.w1), /not in this candidate's matrix|not authorized/);
  });

  suite("a result is taken only from the issued worker for an open attempt and only if it matches the candidate exactly; mismatches count for nothing", async (c) => {
    await c.rel.authorizeHost(c.owner, { commandId: cid("a"), hostId: "lx1", os: "linux", arch: "x64" });
    const { attemptId, payload } = await issue(c.rel, c.owner, c.candidate, linux, "lx1", c.w1);
    assert.equal(payload.capability, "release-test");
    assert.equal(payload.sourceCommit, "a".repeat(40));
    await refuses("invalid_command", () => issue(c.rel, c.owner, c.candidate, linux, "lx1", c.w1), /still open/);
    await refuses("not_found", () => c.rel.report(c.w2, result(attemptId)), undefined);
    await refuses("forbidden", () => c.rel.report(c.owner, result(attemptId)));
    await refuses("invalid_command", () => c.rel.report(c.w1, result(attemptId, { sourceCommit: "b".repeat(40) })), /source commit/);
    await refuses("invalid_command", () => c.rel.report(c.w1, result(attemptId, { suiteRevision: "suite-6" })), /suite revision/);
    await refuses("invalid_command", () => c.rel.report(c.w1, result(attemptId, { artifactHashes: { "nimblenewt.tgz": h("3") } })), /artifact hashes/);
    await refuses("invalid_command", () => c.rel.report(c.w1, result(attemptId, { environment: { os: "darwin", arch: "arm64" } })), /not linux\/x64/);
    await refuses("invalid_command", () => c.rel.report(c.w1, result(attemptId, { counts: { passed: 5, failed: 1, skipped: 0 } })), /none failing/);
    await refuses("invalid_command", () => c.rel.report(c.w1, result(attemptId, { dependencyLockHashes: { "package-lock.json": h("4") } })), /dependency locks/);
    assert.equal((await c.rel.gate(c.owner, c.candidate)).cells.find((x) => x.cell.os === "linux")!.state, "running", "nothing counted");
    await c.rel.report(c.w1, result(attemptId));
    await refuses("invalid_command", () => c.rel.report(c.w1, result(attemptId)), /already passed/);
  });

  suite("a repeated issue returns the attempt it made, with its limits, even after a later attempt; a platform version the candidate names must match (card X09)", async (c) => {
    const pinned = (await c.rel.submit(c.owner, { commandId: cid("s"), manifest: manifest({ matrix: [{ os: "linux", arch: "x64", osVersion: "22.04" }] }) })).candidateId;
    await c.rel.authorizeHost(c.owner, { commandId: cid("a"), hostId: "lx1", os: "linux", arch: "x64" });
    const cell = { os: "linux", arch: "x64", osVersion: "22.04" } as const;
    await refuses("invalid_command", () => c.rel.issue(c.owner, { commandId: cid("i"), candidateId: pinned, cell: { os: "linux", arch: "x64", osVersion: "20.04" }, hostId: "lx1", workerId: c.w1.id, timeoutSeconds: 60, memoryMb: 64 }), /not 20.04/);
    const cmd = { commandId: "issue-fixed", candidateId: pinned, cell, hostId: "lx1", workerId: c.w1.id, timeoutSeconds: 600, memoryMb: 1024 };
    const first = await c.rel.issue(c.owner, cmd);
    await c.rel.interrupt(c.owner, { commandId: cid("x"), attemptId: first.attemptId, reason: "lost" });
    const second = await c.rel.issue(c.owner, { ...cmd, commandId: "issue-second" });
    assert.notEqual(second.attemptId, first.attemptId);
    const replay = await c.rel.issue(c.owner, cmd);
    assert.equal(replay.attemptId, first.attemptId, "the repeat of the first command is the first attempt");
    assert.deepEqual(replay.payload.limits, { timeoutSeconds: 600, memoryMb: 1024 });
    await refuses("command_conflict", () => c.rel.issue(c.owner, { ...cmd, memoryMb: 2048 }));
    const env = (osVersion: string) => ({ environment: { os: "linux", arch: "x64", osVersion } });
    await refuses("invalid_command", () => c.rel.report(c.w1, result(second.attemptId, env("20.04"))), /OS version 20.04, not 22.04/);
    await c.rel.report(c.w1, result(second.attemptId, env("22.04")));
  });

  suite("a lost worker is never a pass; a retry is a new attempt that keeps the earlier evidence; a missing platform blocks the gate and only the owner approves (card X09)", async (c) => {
    await c.rel.authorizeHost(c.owner, { commandId: cid("a"), hostId: "lx1", os: "linux", arch: "x64" });
    await c.rel.authorizeHost(c.owner, { commandId: cid("a"), hostId: "wn1", os: "win32", arch: "x64" });
    const first = await issue(c.rel, c.owner, c.candidate, linux, "lx1", c.w1);
    await c.rel.interrupt(c.owner, { commandId: cid("x"), attemptId: first.attemptId, reason: "worker lost contact" });
    await refuses("invalid_command", () => c.rel.report(c.w1, result(first.attemptId)), /already interrupted/);
    let gate = await c.rel.gate(c.owner, c.candidate);
    assert.deepEqual(gate.cells.map((x) => [x.cell.os, x.state]), [["linux", "interrupted"], ["win32", "missing"]]);
    assert.equal(gate.ready, false);
    const second = await issue(c.rel, c.owner, c.candidate, linux, "lx1", c.w1);
    assert.notEqual(second.attemptId, first.attemptId);
    await c.rel.report(c.w1, result(second.attemptId, { outcome: "fail", counts: { passed: 100, failed: 3, skipped: 0 }, summary: "3 failed; token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }));
    const third = await issue(c.rel, c.owner, c.candidate, linux, "lx1", c.w1);
    await c.rel.report(c.w1, result(third.attemptId));
    const all = await c.rel.attempts(c.owner, c.candidate);
    assert.deepEqual(all.map((a) => [a.n, a.state]), [[1, "interrupted"], [2, "failed"], [3, "passed"]], "earlier failures stay");
    assert.ok(!JSON.stringify(all[1]).includes("sk-ant-api03"));
    await refuses("invalid_command", () => issue(c.rel, c.owner, c.candidate, linux, "lx1", c.w1), /already passed/);
    // Windows has no attempt yet: the gate is blocked and approval is refused, whoever asks.
    await refuses("invalid_command", () => c.rel.approve(c.owner, { commandId: cid("p"), candidateId: c.candidate }), /win32\/x64 missing/);
    const wattempt = await issue(c.rel, c.owner, c.candidate, win, "wn1", c.w2);
    await c.rel.report(c.w2, result(wattempt.attemptId, { environment: { os: "win32", arch: "x64" } }));
    gate = await c.rel.gate(c.owner, c.candidate);
    assert.equal(gate.ready, true);
    await refuses("forbidden", () => c.rel.approve(c.w1, { commandId: cid("p"), candidateId: c.candidate }));
    await c.rel.approve(c.owner, { commandId: cid("p"), candidateId: c.candidate });
    assert.equal((await c.rel.gate(c.owner, c.candidate)).approved, true);
    await refuses("invalid_command", () => c.rel.approve(c.owner, { commandId: cid("p"), candidateId: c.candidate }), /already approved/);
  });
}

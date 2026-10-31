import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { CommandRunner, type Built } from "../domain/runner.js";
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
  const suite = (name: string, body: (c: { rel: ReleaseService; principals: PrincipalService; owner: Principal; w1: Principal; w2: Principal; candidate: string; at: (iso: string) => ReleaseService; seed: (kind: string, count: number) => Promise<void> }) => Promise<void>) =>
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
        const at = (iso: string): ReleaseService => ReleaseService.withEpoch(world.storage, projects.epoch, { ...options, clock: () => iso });
        const seed = async (kind: string, count: number): Promise<void> => {
          const runner = new CommandRunner(world.storage, projects.epoch, options);
          for (let from = 0; from < count; from += 100) {
            await runner.command("test.seed", { commandId: `seed-${kind}-${from}`, actor: owner.id }, async () => ({ payload: { kind, from }, build: async (): Promise<Built> => { const ref = { kind, id: `seed-${from}-0` }; return { ref, creates: true, changes: Array.from({ length: Math.min(100, count - from) }, (_, i) => ({ type: "create" as const, ref: { kind, id: `seed-${from}-${i}` }, body: { candidateId: "x", state: "issued", hostId: "x" } })), detail: {} }; } }));
          }
        };
        await body({ rel, principals, owner, w1, w2, candidate: candidateId, at, seed });
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
    // Linux passed only on its third attempt, after a failure: the failure stays beside the pass and the owner must say they saw it.
    const flaky = gate.cells.find((x) => x.cell.os === "linux")!;
    assert.deepEqual([flaky.flaky, flaky.earlierFailures.map((f) => f.id), gate.needsAcknowledgement], [true, [second.attemptId], true]);
    assert.equal(gate.cells.find((x) => x.cell.os === "win32")!.flaky, false);
    await refuses("invalid_command", () => c.rel.approve(c.owner, { commandId: cid("p"), candidateId: c.candidate }), /passed only after failing/);
    await c.rel.approve(c.owner, { commandId: cid("p"), candidateId: c.candidate, acknowledgeFlaky: true });
    assert.equal((await c.rel.gate(c.owner, c.candidate)).approved, true);
    await refuses("invalid_command", () => c.rel.approve(c.owner, { commandId: cid("p"), candidateId: c.candidate, acknowledgeFlaky: true }), /already approved/);
  });

  suite("X09b: two settings writes from the same revision cannot both win, a host's two pick-ups at once are one, and a platform has a bounded number of attempts", async (c) => {
    const [a, b] = await Promise.allSettled([
      c.rel.setSettings(c.owner, { commandId: cid("ss"), qaAgents: true, expectedRevision: 0 }),
      c.rel.setSettings(c.owner, { commandId: cid("ss"), bosses: true, expectedRevision: 0 }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), ["fulfilled", "rejected"], "one wins; the other is told the setting moved");
    const lost = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal((lost.reason as DomainError).code, "stale_revision");
    await refuses("invalid_command", () => c.rel.setSettings(c.owner, { commandId: cid("ss") }), /at least one/);
    await refuses("invalid_command", () => c.rel.setSettings(c.owner, { commandId: cid("ss"), qaRole: "Bad Role" }));
    await refuses("forbidden", () => c.rel.setSettings(c.w1, { commandId: cid("ss"), qaAgents: true }));

    const principals = c.principals;
    await principals.enroll(c.owner, { commandId: cid("e"), kind: "host", name: "lx1", grants: [] });
    const host = await principals.authenticate((await principals.issueCredential(c.owner, "host:lx1")).token);
    await c.rel.authorizeHost(c.owner, { commandId: cid("h"), hostId: host.id, os: "linux", arch: "x64" });
    const attempt = await c.rel.start(c.owner, { commandId: cid("st"), candidateId: c.candidate, cell: linux, hostId: host.id });
    const both = await Promise.all([c.rel.pickUp(host, { commandId: cid("pu"), attemptId: attempt.attemptId }), c.rel.pickUp(host, { commandId: cid("pu"), attemptId: attempt.attemptId })]);
    assert.equal(both[0].pickedUpAt, both[1].pickedUpAt);
    await refuses("forbidden", () => c.rel.jobsFor(c.owner));
    await refuses("forbidden", () => c.rel.pickUp(c.w1, { commandId: cid("pu"), attemptId: attempt.attemptId }));
    // The host is the worker: the job is returned by the host path only, and a different principal's report is refused.
    await refuses("not_found", () => c.rel.report(c.w1, result(attempt.attemptId)));
    // The owner is not held to the agents' cap of 20 attempts per platform (that cap is per issuer; see the agent tests).
    for (let i = 1; i < 22; i++) {
      await c.rel.cancel(c.owner, { commandId: cid("cx"), attemptId: (await c.rel.attempts(c.owner, c.candidate)).at(-1)!.id, reason: "again" });
      await c.rel.start(c.owner, { commandId: cid("st"), candidateId: c.candidate, cell: linux, hostId: host.id });
    }
    assert.equal((await c.rel.attempts(c.owner, c.candidate)).length, 22);
  });

  const hostOf = async (c: { principals: PrincipalService; rel: ReleaseService; owner: Principal }, name: string, cell: Cell = linux): Promise<Principal> => {
    await c.principals.enroll(c.owner, { commandId: cid("e"), kind: "host", name, grants: [] });
    const host = await c.principals.authenticate((await c.principals.issueCredential(c.owner, `host:${name}`)).token);
    await c.rel.authorizeHost(c.owner, { commandId: cid("h"), hostId: host.id, os: cell.os, arch: cell.arch });
    return host;
  };

  suite("X09b review: the controller enforces the timeout (plus grace): the attempt becomes timed_out, never a pass, the platform is freed and the host is told to stop the job", async (c) => {
    const host = await hostOf(c, "lx1");
    const a = await c.rel.start(c.owner, { commandId: cid("st"), candidateId: c.candidate, cell: linux, hostId: host.id, timeoutSeconds: 60 });
    await c.rel.pickUp(host, { commandId: cid("pu"), attemptId: a.attemptId });
    // Inside timeout + grace: untouched.
    assert.equal((await c.at("2026-10-30T12:10:00.000Z").expire()).expired, 0);
    assert.equal((await c.rel.jobsFor(host)).jobs.length, 1);
    // Past it: ended by the controller's own clock, and the sweep is safe to run twice.
    const late = c.at("2026-10-30T12:12:00.000Z");
    assert.equal((await late.expire()).expired, 1);
    assert.equal((await late.expire()).expired, 0);
    const state = (await c.rel.attempts(c.owner, c.candidate))[0]!;
    assert.deepEqual([state.state, state.endedBy], ["timed_out", undefined]);
    assert.equal((await c.rel.gate(c.owner, c.candidate)).cells.find((x) => x.cell.os === "linux")!.state, "timed_out");
    assert.deepEqual(await late.jobsFor(host), { jobs: [], cancel: [a.attemptId] }, "no job, and the picked-up one is told to stop");
    await refuses("invalid_command", () => c.rel.reportFromHost(host, { ...result(a.attemptId), commandId: cid("r") }), /already timed_out/);
    const retry = await c.rel.start(c.owner, { commandId: cid("st"), candidateId: c.candidate, cell: linux, hostId: host.id });
    assert.notEqual(retry.attemptId, a.attemptId, "the platform is free again");
    // A job nobody picked up expires from its issue time, and a host's own fetch ends it too.
    await c.at("2026-10-30T12:20:00.000Z").expire();
    assert.deepEqual((await c.at("2026-10-30T14:30:00.000Z").jobsFor(host)).jobs, [], "an overdue job is not offered");
    assert.equal((await c.rel.attempts(c.owner, c.candidate)).at(-1)!.state, "timed_out");
  });

  suite("X09b review: withdrawing the host's authorization ends its open attempts and tells it to stop the picked-up ones", async (c) => {
    const host = await hostOf(c, "lx1");
    const a = await c.rel.start(c.owner, { commandId: cid("st"), candidateId: c.candidate, cell: linux, hostId: host.id });
    await c.rel.pickUp(host, { commandId: cid("pu"), attemptId: a.attemptId });
    await c.rel.authorizeHost(c.owner, { commandId: cid("h"), hostId: host.id, os: "linux", arch: "x64", active: false });
    const ended = (await c.rel.attempts(c.owner, c.candidate))[0]!;
    assert.deepEqual([ended.state, ended.endedBy, ended.reason], ["interrupted", c.owner.id, "the host's authorization was withdrawn"]);
    assert.deepEqual(await c.rel.jobsFor(host), { jobs: [], cancel: [a.attemptId] });
    await c.rel.authorizeHost(c.owner, { commandId: cid("h"), hostId: host.id, os: "linux", arch: "x64" });
    assert.ok((await c.rel.start(c.owner, { commandId: cid("st"), candidateId: c.candidate, cell: linux, hostId: host.id })).attemptId);
  });

  suite("X09b review: a large installation is never 'unavailable': attempts are found through their platform's and host's index, not by scanning all of them", async (c) => {
    await c.seed("release-attempt", 5200);
    await c.seed("agent", 5200);
    const host = await hostOf(c, "lx1");
    const a = await c.rel.start(c.owner, { commandId: cid("st"), candidateId: c.candidate, cell: linux, hostId: host.id });
    assert.equal((await c.rel.jobsFor(host)).jobs.length, 1);
    await c.rel.pickUp(host, { commandId: cid("pu"), attemptId: a.attemptId });
    await c.rel.reportFromHost(host, { ...result(a.attemptId), commandId: cid("r") });
    assert.equal((await c.rel.gate(c.owner, c.candidate)).cells.find((x) => x.cell.os === "linux")!.state, "passed");
    assert.deepEqual((await c.rel.jobsFor(host)).jobs, []);
    assert.equal((await c.rel.attempts(c.owner, c.candidate)).length, 1);
  });

  suite("X09b review: a retry until green keeps the failure beside the pass and the owner must acknowledge it", async (c) => {
    const host = await hostOf(c, "lx1");
    await c.rel.authorizeHost(c.owner, { commandId: cid("h"), hostId: "wn1", os: "win32", arch: "x64" });
    const first = await c.rel.start(c.owner, { commandId: cid("st"), candidateId: c.candidate, cell: linux, hostId: host.id });
    await c.rel.pickUp(host, { commandId: cid("pu"), attemptId: first.attemptId });
    await c.rel.reportFromHost(host, { ...result(first.attemptId, { outcome: "fail", counts: { passed: 100, failed: 2, skipped: 0 }, summary: "2 failed" }), commandId: cid("r") } as never);
    const second = await c.rel.start(c.owner, { commandId: cid("st"), candidateId: c.candidate, cell: linux, hostId: host.id });
    await c.rel.pickUp(host, { commandId: cid("pu"), attemptId: second.attemptId });
    await c.rel.reportFromHost(host, { ...result(second.attemptId), commandId: cid("r") });
    const gate = await c.rel.gate(c.owner, c.candidate);
    const cell = gate.cells.find((x) => x.cell.os === "linux")!;
    assert.deepEqual([cell.state, cell.flaky, cell.earlierFailures.map((f) => [f.id, f.summary])], ["passed", true, [[first.attemptId, "2 failed"]]]);
    assert.equal(gate.needsAcknowledgement, true);
  });
}

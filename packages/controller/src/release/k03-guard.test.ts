import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner, type Built } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage, OperationInput } from "../storage/types.js";
import { MigrationGuardService, type GuardOptions } from "../migration/index.js";
import type { Migration } from "../storage/migrations.js";
import { ReleaseActivationService, ReleaseService, signedText, type ActivationOptions } from "./index.js";

after(stopServer);
const options = { clock: () => "2026-11-12T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (l: string): string => `${l}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const unlockAll = (dir: string): void => { try { chmodSync(dir, 0o700); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlockAll(join(dir, e.name)); } catch { /* gone */ } };
const linux = { os: "linux" as const, arch: "x64" as const };
const digests = new Map<string, string>();
const compat = (schema?: { min: number; max: number }): string => JSON.stringify({ protocol: { min: 1, max: 1 }, ...(schema === undefined ? {} : { schema }) });

interface W {
  make: (o?: Partial<ActivationOptions>) => ReleaseActivationService; storage: ControllerStorage; epoch: number; owner: Principal; manager: Principal; plain: Principal; root: string; runner: CommandRunner; principals: PrincipalService; rel: ReleaseService;
  candidate: (files: Record<string, string>, extra?: { migrationPlan?: string; targets?: string[]; compatText?: string }) => Promise<string>;
  approve: (id: string) => Promise<void>;
  go: (act: ReleaseActivationService, by: Principal, id: string, extra?: { migrationPlan?: string }) => Promise<{ digest: string }>;
}
for (const backend of backends) {
  const suite = (name: string, body: (c: W) => Promise<void>): void => {
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const root = mkdtempSync(join(tmpdir(), "nn-k02f-"));
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "manager", grants: [{ action: "release.manage", project: "*" }] });
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "plain", grants: [{ action: "*", project: "*" }] });
        const manager = await principals.authenticate((await principals.issueCredential(owner, "agent:manager")).token);
        const plain = await principals.authenticate((await principals.issueCredential(owner, "agent:plain")).token);
        const rel = ReleaseService.withEpoch(world.storage, projects.epoch, options);
        const runner = new CommandRunner(world.storage, projects.epoch, options);
        const make = (extra: Partial<ActivationOptions> = {}): ReleaseActivationService => ReleaseActivationService.withEpoch(world.storage, projects.epoch, { root, switcher: "pointer", platform: linux, runner: options, ...extra });
        const candidate: W["candidate"] = async (files, extra = {}) => {
          const all = { "compat.json": extra.compatText ?? compat(), ...files };
          const artifacts = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, sha(v)]));
          const { candidateId, manifestDigest } = await rel.submit(owner, { commandId: cid("s"), manifest: { sourceCommit: "a".repeat(40), suiteRevision: "s1", artifacts, dependencyLocks: { lock: sha("lock") }, matrix: [linux], ...(extra.migrationPlan === undefined ? {} : { migrationPlan: extra.migrationPlan }), ...(extra.targets === undefined ? {} : { targets: extra.targets }) } });
          digests.set(candidateId, manifestDigest);
          for (const [k, v] of Object.entries(all)) { const p = join(root, "incoming", candidateId, ...k.split("/")); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, v); }
          return candidateId;
        };
        const approve: W["approve"] = async (id) => {
          await runner.command("test.approve", { commandId: cid("ap"), actor: owner.id }, async () => ({ payload: { id }, build: async (): Promise<Built> => { const ref = { kind: "release-approval", id }; return { ref, creates: true, changes: [{ type: "create", ref, body: { candidateId: id, by: owner.id, at: "x" } }], detail: {} }; } }));
        };
        const go: W["go"] = async (act, by, id, extra = {}) => {
          const s = await act.stage(by, { commandId: cid("st"), candidateId: id });
          await act.activate(by, { commandId: cid("a"), candidateId: id, digest: s.digest, ...extra });
          return { digest: s.digest };
        };
        await body({ make, storage: world.storage, epoch: projects.epoch, owner, manager, plain, root, runner, principals, rel, candidate, approve, go });
      } finally { await world.close(); unlockAll(join(root, "releases")); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    });
  };
  const pointerOf = (root: string): string | undefined => (existsSync(join(root, "current.json")) ? (JSON.parse(readFileSync(join(root, "current.json"), "utf8")) as { release: string }).release : undefined);
  const go0 = async (c: W, act: ReleaseActivationService, id: string): Promise<void> => { const s = await act.stage(c.owner, { commandId: cid("st"), candidateId: id }); await c.approve(id); await act.activate(c.owner, { commandId: cid("a"), candidateId: id, digest: s.digest }); };
  const LIST: Migration[] = [{ version: 1, name: "initial", statements: ["x"] }, { version: 2, name: "add_a", statements: ["x"] }, { version: 3, name: "drop_b", statements: ["x"], kind: "destructive" }];
  const guardFor = (c: W, schema: { v: number }, clock: { t: string }, extra: Partial<GuardOptions> = {}): MigrationGuardService => MigrationGuardService.withEpoch(c.storage, c.epoch, { migrations: LIST, schemaVersion: async () => schema.v, now: () => clock.t, runner: options, ...extra });

  suite("a rollback goes only to a tested pair: a release that never started healthy here is refused, one that did comes back over additive migrations inside the period, and not after a destructive one or after the period (K03)", async (c) => {
    const schema = { v: 1 };
    const clock = { t: "2026-11-12T12:00:00.000Z" };
    const guard = guardFor(c, schema, clock);
    const act = c.make({ compat: { workers: { min: 1, max: 1 }, required: true }, schemaVersion: async () => schema.v, rollbackGuard: (id) => guard.rollbackVerdict(id), safeBack: () => guard.safeBack() });
    const a = await c.candidate({ "nn.js": "a" }, { compatText: compat({ min: 1, max: 1 }) });
    const b = await c.candidate({ "nn.js": "b" }, { compatText: compat({ min: 1, max: 2 }) });
    await guard.noteStart();
    await go0(c, act, a);
    // A is current but never started healthy here: no tested pair. Going to B and back is refused until A has been a tested pair.
    await go0(c, act, b);
    await refuses("invalid_transition", () => act.rollback(c.owner, { commandId: cid("rb"), releaseId: a }), /not a tested pair.*never started healthy/);
    assert.equal((await act.rollbackCheck(c.owner, a)).ok, false);
    assert.equal((await act.rollbackCheck(c.manager, a)).guarded, true, "a release.manage holder may check");
    await refuses("forbidden", () => act.rollbackCheck(c.plain, a));
    // A really ran healthy on schema 1: that is a tested pair. B then migrated the data to 2 (additive) inside the period: A may come back although it only understands 1.
    await guard.notePair(a);
    schema.v = 2; clock.t = "2026-11-13T12:00:00.000Z";
    await guard.noteStart();
    await act.noteDatabase();
    assert.equal((await act.launcher.read()).db?.safeBackTo, 1, "the launcher's file carries the safe-back line");
    const check = await act.rollbackCheck(c.owner, a);
    assert.equal(check.ok, true, check.reasons.join());
    const st = await act.status(c.owner);
    assert.equal(st.databaseSchema, 2);
    await act.rollback(c.owner, { commandId: cid("rb"), releaseId: a });
    assert.equal(pointerOf(c.root), a);
  });

  suite("a rollback is refused after the rollback period, and after a destructive migration even inside it; the reason says which (K03)", async (c) => {
    const schema = { v: 1 };
    const clock = { t: "2026-11-12T12:00:00.000Z" };
    const guard = guardFor(c, schema, clock);
    const act = c.make({ compat: { workers: { min: 1, max: 1 }, required: true }, schemaVersion: async () => schema.v, rollbackGuard: (id) => guard.rollbackVerdict(id), safeBack: () => guard.safeBack() });
    const a = await c.candidate({ "nn.js": "a" }, { compatText: compat({ min: 1, max: 1 }) });
    const b = await c.candidate({ "nn.js": "b" }, { compatText: compat({ min: 1, max: 3 }) });
    await guard.noteStart();
    await go0(c, act, a); await guard.notePair(a);
    await go0(c, act, b);
    schema.v = 2; clock.t = "2026-11-13T12:00:00.000Z"; await guard.noteStart();
    clock.t = "2026-12-30T12:00:00.000Z";
    await refuses("invalid_transition", () => act.rollback(c.owner, { commandId: cid("rb"), releaseId: a }), /rollback period.*ended/);
    clock.t = "2026-11-14T12:00:00.000Z";
    schema.v = 3; await guard.noteStart();
    await refuses("invalid_transition", () => act.rollback(c.owner, { commandId: cid("rb"), releaseId: a }), /migration 3 reshaped the data destructively/);
    assert.equal(pointerOf(c.root), b, "nothing moved");
    assert.equal(await guard.safeBack(), undefined);
  });

  suite("without a guard nothing changes: the old rule (the declared schema range) decides alone, and the guard's summary and the rollout status are readable (K03)", async (c) => {
    const act = c.make({ compat: { workers: { min: 1, max: 1 }, required: true } });
    const a = await c.candidate({ "nn.js": "a" });
    await go0(c, act, a);
    const none = await act.rollbackCheck(c.owner, a);
    assert.deepEqual([none.ok, none.guarded], [true, false]);
    const rollout = await act.rolloutStatus(c.owner);
    assert.deepEqual([rollout.probation, rollout.external, rollout.current], [null, null, a]);
    assert.deepEqual(await act.stopRollout(c.owner, { commandId: cid("rs") }), { stopped: false, releaseId: null });
    await refuses("forbidden", () => act.stopRollout(c.manager, { commandId: cid("rs") }));
    await refuses("invalid_command", () => act.stopRollout(c.owner, { commandId: cid("rs"), reason: "" }));
    await refuses("invalid_command", () => act.stopRollout(c.owner, { commandId: cid("rs"), reason: "x".repeat(201) }));
  });

  suite("stopping a rollout ends the watch, records it in the history and is a repeat when sent again; the policy reaches the launcher's file (K03)", async (c) => {
    const act = c.make({ compat: { workers: { min: 1, max: 1 }, required: true } });
    const a = await c.candidate({ "nn.js": "a" });
    const b = await c.candidate({ "nn.js": "b" });
    await act.syncLauncherPolicy({ probationMinutes: 30, maxReleaseFailures: 2, hostRetries: 4 });
    await go0(c, act, a);
    const L = act.launcher;
    await L.prepare(); await L.confirm(a);
    await go0(c, act, b);
    await L.prepare(); await L.confirm(b);
    const status = await act.status(c.owner);
    assert.equal(status.rollout?.probation?.state, "watching");
    assert.equal(status.rollout?.policy?.maxReleaseFailures, 2);
    const stopped = await act.stopRollout(c.owner, { commandId: "stop-1", reason: "I am testing it myself" });
    assert.deepEqual(stopped, { stopped: true, releaseId: b });
    const after = await act.status(c.owner);
    assert.equal(after.rollout?.probation?.state, "stopped");
    assert.deepEqual(after.history.at(-1)?.kind, "rollout_stopped");
    assert.equal(after.history.at(-1)?.reason, "I am testing it myself");
    assert.deepEqual(await act.stopRollout(c.owner, { commandId: "stop-2" }), { stopped: false, releaseId: b }, "nothing left to stop");
  });
}

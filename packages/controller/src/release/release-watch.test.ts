import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { HostService, type Capabilities } from "../hosts/index.js";
import { PrincipalService } from "../security/index.js";
import { RELEASE_LIMITS, ReleaseService, releaseDeadline, type Cell } from "./index.js";

/**
 * The outer watch over release hosts (card X09b): `ReleaseService.silent()` finds every release test a host picked up whose host has sent no heartbeat for a while, and changes nothing; `releaseDeadline` is the
 * one place the timed-out moment is computed, for the controller's expiry and the owner's view alike. Every storage backend; the heartbeats are the real `HostService` ones.
 */
after(stopServer);

let now = Date.parse("2026-11-17T10:00:00.000Z");
const at = (): string => new Date(now).toISOString();
const options = { clock: at, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const h = (c: string): string => c.repeat(64);
const linux: Cell = { os: "linux", arch: "x64" };
const win: Cell = { os: "win32", arch: "x64" };
const caps = (os: string): Capabilities => ({ os, arch: "x64", harnesses: [], isolation: ["none"], tools: [], workspaces: [] } as unknown as Capabilities);
const MIN = 60_000;

test("releaseDeadline: the time limit plus the grace, from the pick-up, or from the issue when nobody picked it up", () => {
  const limits = { timeoutSeconds: 60, memoryMb: 1 };
  assert.equal(releaseDeadline({ issuedAt: "2026-11-17T10:00:00.000Z", limits }), new Date(Date.parse("2026-11-17T10:00:00.000Z") + (60 + RELEASE_LIMITS.graceSeconds) * 1000).toISOString());
  assert.equal(releaseDeadline({ issuedAt: "2026-11-17T10:00:00.000Z", pickedUpAt: "2026-11-17T10:30:00.000Z", limits }), "2026-11-17T10:41:00.000Z");
});

for (const backend of backends) {
  test(`${backend.name}: the outer watch names a picked-up release test whose host went quiet, once per silence, and changes nothing (card X09b)`, async () => {
    now = Date.parse("2026-11-17T10:00:00.000Z");
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const hosts = HostService.withEpoch(world.storage, projects.epoch, assignments, options);
      const rel = ReleaseService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const host = async (name: string, cell: Cell) => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "host", name, grants: [] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `host:${name}`)).token);
        await rel.authorizeHost(owner, { commandId: cid("h"), hostId: p.id, os: cell.os, arch: cell.arch });
        return p;
      };
      const { candidateId } = await rel.submit(owner, { commandId: cid("s"), manifest: { sourceCommit: "a".repeat(40), suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, matrix: [linux, win] } });
      const lx = await host("lx1", linux);
      const wn = await host("wn1", win);
      let seq = 0;
      const beat = async (p: typeof lx) => { await hosts.heartbeat(p, { commandId: cid("hb"), sequence: ++seq }); };
      await hosts.announce(lx, { commandId: cid("an"), capabilities: caps("linux") });
      await hosts.announce(wn, { commandId: cid("an"), capabilities: caps("win32") });
      await beat(lx); await beat(wn);

      const a = await rel.start(owner, { commandId: cid("st"), candidateId, cell: linux, hostId: lx.id, timeoutSeconds: 3600 });
      const b = await rel.start(owner, { commandId: cid("st"), candidateId, cell: win, hostId: wn.id, timeoutSeconds: 3600 });
      assert.deepEqual(await rel.silent(), [], "nothing is picked up yet");
      now += 10 * MIN;
      assert.deepEqual(await rel.silent(), [], "a job nobody picked up is not watched: nothing destructive has started (its deadline still ends it)");

      now += MIN;
      await rel.pickUp(lx, { commandId: cid("pu"), attemptId: a.attemptId });
      const pickedAt = at();
      await rel.pickUp(wn, { commandId: cid("pu"), attemptId: b.attemptId });
      // The pick-up itself counts as hearing from the host: the heartbeat record is older than it.
      now += 4 * MIN;
      assert.deepEqual(await rel.silent(), [], "inside the five minutes nothing is said");
      await beat(wn); // the windows host keeps talking
      now += 2 * MIN;
      await beat(wn);
      const quiet = await rel.silent();
      assert.equal(quiet.length, 1, "only the host that stopped talking");
      const q = quiet[0]!;
      assert.equal(q.attemptId, a.attemptId);
      assert.equal(q.hostId, lx.id);
      assert.equal(q.candidateId, candidateId);
      assert.deepEqual(q.cell, linux);
      assert.equal(q.pickedUpAt, pickedAt);
      assert.equal(q.silentSince, pickedAt, "the later of the last heartbeat and the pick-up");
      assert.ok(q.lastHeardAt !== undefined && Date.parse(q.lastHeardAt) < Date.parse(pickedAt), "the last heartbeat is reported as it is");
      assert.equal(q.endsAt, releaseDeadline({ issuedAt: "", pickedUpAt: pickedAt, limits: { timeoutSeconds: 3600, memoryMb: 1 } }));
      assert.deepEqual(await rel.silent(), quiet, "the same silence reads the same (the owner's notice key is built from it)");
      assert.equal((await rel.attempts(owner, candidateId)).every((x) => x.state === "issued"), true, "the watch changes nothing: a reboot test silences its host on purpose");

      // The host comes back: no silence; it goes quiet again: a NEW silence, named by its last heartbeat.
      await beat(lx);
      const back = at();
      assert.deepEqual(await rel.silent(), []);
      now += 6 * MIN;
      await beat(wn);
      const again = await rel.silent();
      assert.equal(again.length, 1);
      assert.equal(again[0]!.silentSince, back, "a new silence is named by the heartbeat it followed");
      assert.notEqual(again[0]!.silentSince, q.silentSince);

      // A shorter threshold can be asked for; a nonsense one is refused.
      assert.equal((await rel.silent(60)).length, 1);
      await assert.rejects(() => rel.silent(0), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");

      // Ended attempts are never named: a result, a cancel or the deadline ends the watch over them.
      await rel.cancel(owner, { commandId: cid("c"), attemptId: a.attemptId, reason: "not needed" });
      assert.deepEqual(await rel.silent(), []);
      // A host whose open attempts all ended has nothing to watch even when it never speaks again.
      now += 120 * MIN;
      assert.deepEqual((await rel.silent()).map((x) => x.attemptId), [b.attemptId], "the windows test, picked up and now unheard for long, is named until its deadline");
      now = Date.parse(releaseDeadline({ issuedAt: "", pickedUpAt: pickedAt, limits: { timeoutSeconds: 3600, memoryMb: 1 } })) + 60_000;
      await rel.expire();
      assert.deepEqual(await rel.silent(), [], "past the deadline the attempt is timed out and no longer watched");
    } finally { await world.close(); }
  });
}

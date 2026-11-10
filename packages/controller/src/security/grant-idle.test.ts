import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, allows, type LapsedGrant, type Principal } from "./index.js";

after(stopServer);

// Card A07h: a standing grant with an idle window lapses only after it goes unused for that window, and each use renews it (recorded at most once a day per grant).
const T0 = "2026-11-10T10:00:00.000Z";
const DAY = 86_400_000;
const at = (days: number, hours = 0): string => new Date(Date.parse(T0) + days * DAY + hours * 3_600_000).toISOString();
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  const suite = (name: string, body: (c: { grantsAt(clock: string): GrantService; owner: Principal; a: string; ta: string; ann: Principal; revision(id: string): Promise<number> }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const options = { clock: () => T0, pause: async () => undefined };
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: cid("enroll"), kind: "agent", name: "ann", grants: [] });
        const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "Garden" })).id;
        const ta = (await projects.createTask({ commandId: cid("ta"), actor: "owner:rob", projectId: a, title: "one" })).id;
        const grantsAt = (clock: string) => GrantService.withEpoch(world.storage, projects.epoch, { clock: () => clock, pause: async () => undefined });
        const revision = async (id: string) => (await grantsAt(T0).getGrant(id))!.revision;
        await body({ grantsAt, owner, a, ta, ann, revision });
      } finally { await world.close(); }
    });
  const idle = (g: GrantService, owner: Principal, project: string, extra: Record<string, unknown> = {}) =>
    g.grant(owner, { commandId: cid("g"), grantee: "agent:ann", action: "attempt.work", project, source: "standing", basis: "keep working", idleDays: 30, ...extra } as never);
  const holds = async (g: GrantService, p: Principal, project: string, when: string) => allows(await g.effective(p, when), "attempt.work", project, { now: when });

  suite("a grant used every few days is still live after 100 days; one left unused past its window is not applied", async ({ grantsAt, owner, a, ann }) => {
    const used = await idle(grantsAt(T0), owner, a);
    const unused = await grantsAt(T0).grant(owner, { commandId: cid("g"), grantee: "agent:ann", action: "task.read", project: a, source: "standing", basis: "read", idleDays: 30 });
    for (let d = 0; d <= 100; d += 4) await grantsAt(at(d)).recordUse("service:dispatcher", [used.id]);
    assert.equal(await holds(grantsAt(at(100)), ann, a, at(100)), true, "renewed by use");
    const held = (await grantsAt(at(100)).held("agent:ann", at(100))).map((g) => g.id);
    assert.ok(held.includes(used.id));
    assert.ok(!held.includes(unused.id), "the unused one lapsed");
    // The unused one holds until its window passes, and not a moment after.
    assert.ok((await grantsAt(at(29)).held("agent:ann", at(29))).some((g) => g.id === unused.id));
    assert.ok(!(await grantsAt(at(30)).held("agent:ann", at(30))).some((g) => g.id === unused.id));
    // A use after it lapsed does not bring it back.
    assert.equal(await grantsAt(at(31)).recordUse("service:dispatcher", [unused.id]), 0);
    assert.ok(!(await grantsAt(at(31)).held("agent:ann", at(31))).some((g) => g.id === unused.id));
  });

  suite("use is written at most once a day per grant", async ({ grantsAt, owner, a, revision }) => {
    const g = await idle(grantsAt(T0), owner, a);
    const start = await revision(g.id);
    let writes = 0;
    for (let i = 0; i < 40; i++) writes += await grantsAt(at(1, i % 12)).recordUse("service:dispatcher", [g.id, g.id]);
    assert.equal(writes, 1);
    assert.equal(await revision(g.id), start + 1);
    // The day it was made counts as a use: a second use that day writes nothing.
    assert.equal(await grantsAt(at(0, 5)).recordUse("service:dispatcher", [g.id]), 0);
    for (let i = 0; i < 10; i++) writes += await grantsAt(at(2, i)).recordUse("service:dispatcher", [g.id]);
    assert.equal(writes, 2);
    assert.equal(await revision(g.id), start + 2);
    assert.equal((await grantsAt(T0).getGrant(g.id))!.lastUsedAt, at(2, 0));
  });

  suite("a grant with an explicit end date still ends on it; one with neither keeps its meaning", async ({ grantsAt, owner, a, ann, revision }) => {
    const dated = await grantsAt(T0).grant(owner, { commandId: cid("g"), grantee: "agent:ann", action: "attempt.work", project: a, source: "standing", basis: "until then", expiresAt: at(10) });
    const plain = await grantsAt(T0).grant(owner, { commandId: cid("g"), grantee: "agent:ann", action: "task.read", project: a, source: "direct", basis: "no end" });
    for (let d = 0; d < 12; d++) assert.equal(await grantsAt(at(d)).recordUse("service:dispatcher", [dated.id, plain.id]), 0, "nothing to renew");
    assert.equal(await revision(dated.id), 1);
    assert.equal(await revision(plain.id), 1);
    assert.equal(await holds(grantsAt(at(9)), ann, a, at(9)), true);
    assert.equal(await holds(grantsAt(at(10)), ann, a, at(10)), false);
    assert.ok((await grantsAt(at(1000)).held("agent:ann", at(1000))).some((g) => g.id === plain.id));
    const body = (await grantsAt(T0).getGrant(plain.id))!;
    assert.equal(body.idleDays, undefined);
    assert.equal(body.lastUsedAt, undefined);
  });

  suite("a derived grant renews the grant it rests on and falls with it when that lapses", async ({ grantsAt, owner, a, ta, ann }) => {
    const parent = await idle(grantsAt(T0), owner, a);
    const child = await grantsAt(T0).derive(ann, { commandId: cid("d"), parentId: parent.id, action: "attempt.work", project: a, resource: { kind: "task", id: ta }, basis: "this task" });
    await grantsAt(at(20)).recordUse("service:dispatcher", [child.id]);
    assert.equal((await grantsAt(T0).getGrant(parent.id))!.lastUsedAt, at(20));
    assert.ok((await grantsAt(at(45)).held("agent:ann", at(45))).some((g) => g.id === child.id));
    assert.ok(!(await grantsAt(at(50)).held("agent:ann", at(50))).some((g) => g.id === child.id), "falls with its lapsed parent");
    await assert.rejects(() => grantsAt(at(50)).derive(ann, { commandId: cid("d"), parentId: parent.id, action: "attempt.work", project: a, basis: "again" }), /holds no such grant/);
  });

  suite("the owner is told once, in plain words, when a grant lapses from non-use; a revoked or still-live grant is not reported", async ({ grantsAt, owner, a }) => {
    const lapsing = await idle(grantsAt(T0), owner, a);
    const live = await idle(grantsAt(T0), owner, a, { action: "task.read" });
    const revoked = await idle(grantsAt(T0), owner, a, { action: "task.create" });
    await grantsAt(T0).revoke(owner, { commandId: cid("rv"), grantId: revoked.id, expectedRevision: 1, reason: "not needed" });
    await grantsAt(at(5)).recordUse("service:dispatcher", [lapsing.id]);
    await grantsAt(at(25)).recordUse("service:dispatcher", [live.id]);
    const told: LapsedGrant[] = [];
    const tell = async (l: LapsedGrant) => { told.push(l); };
    assert.equal(await grantsAt(at(34)).noticeLapsed("service:dispatcher", tell), 0, "nothing has lapsed yet");
    assert.equal(await grantsAt(at(36)).noticeLapsed("service:dispatcher", tell), 1);
    assert.equal(await grantsAt(at(37)).noticeLapsed("service:dispatcher", tell), 0, "told once");
    assert.equal(told.length, 1);
    assert.deepEqual({ ...told[0] }, { grantId: lapsing.id, grantee: "agent:ann", granteeName: "ann", action: "attempt.work", project: a, projectName: "Garden", idleDays: 30, lastUsedAt: at(5), lapsedAt: at(35) });
    // A tell that fails leaves the grant to be told on the next pass.
    assert.equal(await grantsAt(at(60)).noticeLapsed("service:dispatcher", async () => { throw new Error("channel down"); }).catch(() => -1), -1);
    assert.equal(await grantsAt(at(61)).noticeLapsed("service:dispatcher", tell), 1);
    assert.equal(told.at(-1)!.grantId, live.id);
  });

  suite("a stalled check names the grant that lapsed and when it was last used", async ({ grantsAt, owner, a, ta }) => {
    const g = await idle(grantsAt(T0), owner, a);
    await grantsAt(at(3)).recordUse("service:dispatcher", [g.id]);
    const found = await grantsAt(at(40)).lapsedCovering("agent:ann", "attempt.work", a, at(40), { kind: "task", id: ta });
    assert.deepEqual(found.map((f) => [f.id, f.body.lastUsedAt]), [[g.id, at(3)]]);
    assert.deepEqual(await grantsAt(at(20)).lapsedCovering("agent:ann", "attempt.work", a, at(20)), [], "not lapsed yet");
  });

  suite("an idle window is checked; a retry of a grant made before A07h under the same command returns that grant", async ({ grantsAt, owner, a }) => {
    for (const bad of [0, -1, 1.5, 36_501, "30"]) await assert.rejects(() => idle(grantsAt(T0), owner, a, { idleDays: bad }), /idleDays/);
    const commandId = cid("old");
    const first = await grantsAt(T0).grant(owner, { commandId, grantee: "agent:ann", action: "attempt.work", project: a, source: "standing", basis: "made before", expiresAt: at(30) });
    const again = await grantsAt(at(1)).grant(owner, { commandId, grantee: "agent:ann", action: "attempt.work", project: a, source: "standing", basis: "made before", idleDays: 30 });
    assert.equal(again.id, first.id);
    assert.equal(again.replayed, true);
    await assert.rejects(() => grantsAt(at(1)).grant(owner, { commandId, grantee: "agent:ann", action: "task.read", project: a, source: "standing", basis: "made before", idleDays: 30 }), /different command/);
  });
}

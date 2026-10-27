import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { InvitationInbox } from "../meetings/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a schedule made through the state API is held once per slot by the composed dispatcher, a restart and catch-up add no second occurrence (card M01)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-meet-"));
  const file = join(d, "c.sqlite");
  // The API's own services read the real clock (the schedule's start is real now); the dispatcher's clock is moved from there.
  const day = 86_400_000;
  const at = (offsetDays: number, hhmm: string): number => Date.parse(`${new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10)}T${hhmm}:00.000Z`);
  let now = Date.now();
  const clock = (): string => new Date(now).toISOString();
  const open = () => startController({ storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000, clock } });
  let c = await open();
  let token = "";
  let project = "";
  let scheduleId = "";
  let first = "";
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    token = boot.token;
    const rob = await c.services.principals.authenticate(token);
    project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    for (const n of ["ann", "bob"]) await c.services.principals.enroll(rob, { commandId: `e-${n}`, kind: "agent", name: n, grants: [{ action: "task.read", project }] });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const made = await call("meeting.schedule", { projectId: project, title: "Stand-up", roster: ["agent:ann", "agent:bob"], time: "08:00", timeZone: "UTC", startDate: new Date(at(1, "00:00")).toISOString().slice(0, 10), recurrence: { kind: "daily" } }, "ms1");
    assert.ok(made.ok, JSON.stringify(made));
    scheduleId = made.result.id;
    assert.equal((await call("meeting.schedule", { projectId: project, title: "Stand-up", roster: ["agent:ann", "agent:bob"], time: "08:00", timeZone: "UTC", startDate: new Date(at(1, "00:00")).toISOString().slice(0, 10), recurrence: { kind: "daily" } }, "ms1")).result.replayed, true);
    assert.ok((await call("meeting.schedule-get", { scheduleId })).ok);
    // An agent without meeting.manage cannot schedule.
    const annToken = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    assert.equal(((await c.api.handle(annToken, { v: 1, op: "meeting.schedule", commandId: "ms2", args: { projectId: project, title: "X", roster: ["agent:bob"], time: "08:00", timeZone: "UTC" } } as never)) as { ok: boolean; error?: { code: string } }).error?.code, "forbidden");
    // An urgent call is accepted from the manager and recorded with its roster (absent and paused participants are withheld, which meetings.test.ts proves with real agent records).
    const urgent = await call("meeting.call-urgent", { projectId: project, title: "Hotfix", reason: "prod is down", roster: ["agent:ann", "agent:bob"] }, "mu1");
    assert.ok(urgent.ok, JSON.stringify(urgent));
    assert.ok((await call("meeting.occurrence", { occurrenceId: urgent.result.id })).ok);
    // Before the slot nothing is planned.
    await c.dispatch!.dispatcher.tick();
    assert.equal((await call("meeting.schedule-get", { scheduleId })).result.item.occurrences, 0, "nothing before the slot");
    now = at(1, "08:00");
    const rep = await c.dispatch!.dispatcher.tick();
    assert.ok(rep.loops.every((l) => l.ok), JSON.stringify(rep.loops));
    await c.dispatch!.dispatcher.tick();
    const count = async (): Promise<number> => (await call("meeting.schedule-get", { scheduleId })).result.item.occurrences;
    assert.equal(await count(), 1, "one occurrence for the slot, however often the clock ticked");
    first = (await call("meeting.schedule-get", { scheduleId })).result.item.lastOccurrenceId;
    const firstOcc = (await call("meeting.occurrence", { occurrenceId: first })).result.item.occurrence;
    assert.notEqual(firstOcc.mode, "catch-up", "the slot was met on time, not caught up");
    assert.ok((await call("meeting.planned", { projectId: project })).ok);
  } finally { await c.close(); }
  try {
    // A restart two days on: catch-up creates one occurrence that names the skipped slots, not one per missed slot; ticking again adds none.
    now = at(3, "09:00");
    c = await open();
    const call = (op: string, args: Record<string, unknown>) => c.api.handle(token, { v: 1, op, args } as never) as Promise<{ ok: boolean; result?: any }>;
    const count = async (): Promise<number> => (await call("meeting.schedule-get", { scheduleId })).result.item.occurrences;
    await c.dispatch!.dispatcher.tick();
    await c.dispatch!.dispatcher.tick();
    assert.equal(await count(), 2, "one catch-up occurrence for the days missed, not one per missed slot");
    const last = (await call("meeting.schedule-get", { scheduleId })).result.item.lastOccurrenceId;
    const lastOcc = (await call("meeting.occurrence", { occurrenceId: last })).result.item.occurrence;
    assert.equal(lastOcc.mode, "catch-up");
    assert.ok(lastOcc.skippedCount >= 1, JSON.stringify(lastOcc));
    assert.notEqual(last, first, "a new occurrence, not the first one again");
    await c.close();
    c = await open();
    await c.dispatch!.dispatcher.tick();
    assert.equal(await count(), 2, "a second restart creates nothing more");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a schedule that names no zone uses the owner's meeting.timeZone setting, and an urgent meeting's invitations reach the agent through the composed inbox, once, and only to the one it is for (card M01c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-meet-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const ann = (await s.agents.create(rob, { commandId: "ag-ann", friendlyName: "Ann" })).id;
    const bob = (await s.agents.create(rob, { commandId: "ag-bob", friendlyName: "Bob" })).id;
    for (const id of [ann, bob]) await s.grants.grant(rob, { commandId: `g-${id}`, grantee: `agent:${id}`, action: "task.read", project, source: "direct", basis: "test" });
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    // No zone and no setting: refused with the reason. Then the owner sets it and the same request works, with the zone recorded as the owner's.
    const sched = { projectId: project, title: "Stand-up", roster: [`agent:${ann}`], time: "09:00" };
    const refused = await call(boot.token, "meeting.schedule", sched, "ms0");
    assert.equal(refused.ok, false);
    assert.match(refused.error!.message, /meeting.timeZone/);
    const staged = await s.configuration.stage(rob, { commandId: "cfg1", layer: "installation", set: { "meeting.timeZone": "Asia/Kolkata" } });
    await s.configuration.apply(rob, { commandId: "cfg2", layer: "installation", expectedRevision: staged.revision });
    const made = await call(boot.token, "meeting.schedule", sched, "ms1");
    assert.ok(made.ok, JSON.stringify(made));
    const got = (await call(boot.token, "meeting.schedule-get", { scheduleId: made.result.id })).result.item;
    assert.deepEqual([got.timeZone, got.timeZoneFromOwnerSetting], ["Asia/Kolkata", true]);
    // An urgent meeting for Ann and Bob: both are invited by the dispatcher's tick; each reads only its own, the owner reads either, a task credential none.
    const urgent = await call(boot.token, "meeting.call-urgent", { projectId: project, title: "Hotfix", reason: "prod is down", roster: [`agent:${ann}`, `agent:${bob}`] }, "mu1");
    assert.ok(urgent.ok, JSON.stringify(urgent));
    for (let i = 0; i < 3; i++) await c.dispatch!.dispatcher.tick();
    const annToken = (await s.principals.issueCredential(rob, `agent:${ann}`)).token;
    const mine = await call(annToken, "meeting.invitations", { agent: `agent:${ann}` });
    assert.ok(mine.ok, JSON.stringify(mine));
    assert.deepEqual(mine.result.items.map((i: { agent: string; occurrenceId: string; urgent: boolean }) => [i.agent, i.occurrenceId, i.urgent]), [[`agent:${ann}`, urgent.result.id, true]], "one invitation, however often the dispatcher ticked");
    assert.deepEqual((await call(annToken, "meeting.invitations", { agent: `agent:${bob}` })).result.items, [], "not Bob's");
    assert.equal((await call(boot.token, "meeting.invitations", { agent: `agent:${bob}` })).result.items.length, 1, "the owner reads Bob's");
    // The same key delivered again (a retry after a sink fault) adds nothing, even with a changed body; a different key adds one, newest first; only the newest 50 are kept.
    const inbox = InvitationInbox.withEpoch(c.storage, c.epoch);
    const one = mine.result.items[0];
    await inbox.invite({ ...one, urgent: false });
    assert.equal((await call(annToken, "meeting.invitations", { agent: `agent:${ann}` })).result.items.length, 1);
    for (let i = 0; i < 55; i++) await inbox.invite({ ...one, key: `${one.key}:${i}`, startsAt: new Date(Date.UTC(2030, 0, 1 + i)).toISOString() });
    const kept = (await call(annToken, "meeting.invitations", { agent: `agent:${ann}` })).result.items;
    assert.equal(kept.length, 50);
    assert.equal(kept[0].key, `${one.key}:54`, "latest sent first");
    // A task credential of that agent reads its own list (its project's invitations only); another agent's task credential reads nothing of Ann's.
    const taskFor = (agentId: string) => {
      return { kind: "agent" as const, id: `agent:${agentId}`, name: agentId, grants: [], taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: project } };
    };
    const annTask = taskFor(ann);
    assert.equal((await inbox.forAgent(annTask as never, `agent:${ann}`)).length, 50, "a task credential of Ann reads Ann's list");
    assert.deepEqual(await inbox.forAgent(taskFor(bob) as never, `agent:${ann}`), [], "and Bob's reads none of it");
    const elsewhere = { ...annTask, taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" } };
    assert.deepEqual(await inbox.forAgent(elsewhere as never, `agent:${ann}`), [], "a task credential of another project sees none of this project's");
    // Invitations delivered at the same moment are all kept.
    await Promise.all([1, 2, 3, 4].map((n) => inbox.invite({ ...one, agent: `agent:${bob}`, key: `${one.key}:c${n}` })));
    assert.equal((await call(boot.token, "meeting.invitations", { agent: `agent:${bob}` })).result.items.length, 5);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

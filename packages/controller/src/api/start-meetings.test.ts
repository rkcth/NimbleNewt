import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
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

test("through the composed controller a paused agent and an agent the host reports stopped are withheld from a scheduled meeting and not woken, and an agenda item taken by the occurrence is still open after it is settled (card M01b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-meet-"));
  const day = 86_400_000;
  const slot = Date.parse(`${new Date(Date.now() + day).toISOString().slice(0, 10)}T08:00:00.000Z`);
  let now = Date.now();
  const stopped = new Set<string>();
  const sent: string[] = [];
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], availability: async (id) => (stopped.has(id) ? "stopped" : "available"), dispatch: { timer: new ManualTimer(), intervalMs: 1000, clock: () => new Date(now).toISOString(), invitations: { invite: async (i) => { sent.push(i.agent); } } } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const ids: Record<string, string> = {};
    for (const n of ["ann", "bob", "cat"]) {
      ids[n] = (await s.agents.create(rob, { commandId: `ag-${n}`, friendlyName: n })).id;
      await s.grants.grant(rob, { commandId: `g-${n}`, grantee: `agent:${ids[n]}`, action: "task.read", project, source: "direct", basis: "test" });
    }
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { message: string } }>;
    const topic = await call("agenda.capture", { projectId: project, topic: "Fence repairs", question: "who pays?" }, "ag1");
    assert.ok(topic.ok, JSON.stringify(topic));
    const made = await call("meeting.schedule", { projectId: project, title: "Stand-up", roster: ["ann", "bob", "cat"].map((n) => `agent:${ids[n]}`), time: "08:00", timeZone: "UTC", startDate: new Date(slot).toISOString().slice(0, 10), recurrence: { kind: "daily" } }, "ms1");
    assert.ok(made.ok, JSON.stringify(made));
    // Bob is paused by the owner; the host reports Cat stopped. Ann is available.
    await s.pauses.pause(rob, { commandId: "pz", scope: { kind: "agent", id: ids.bob! }, reason: "the owner asked" });
    stopped.add(`agent:${ids.cat}`);
    now = slot;
    for (let i = 0; i < 2; i++) await c.dispatch!.dispatcher.tick();
    const sched = (await call("meeting.schedule-get", { scheduleId: made.result.id })).result.item;
    assert.equal(sched.occurrences, 1);
    const occ = (await call("meeting.occurrence", { occurrenceId: sched.lastOccurrenceId })).result.item.occurrence;
    const status = (n: string): string => occ.participants.find((p: { id: string }) => p.id === `agent:${ids[n]}`).status;
    assert.deepEqual([status("ann"), status("bob"), status("cat")], ["eligible", "withheld-paused", "withheld-unavailable"]);
    assert.equal(await s.pauses.availability(`agent:${ids.bob}`), "paused", "being withheld did not lift the pause");
    assert.deepEqual(sent, [`agent:${ids.ann}`], "only the available agent was invited; the paused and the stopped one were not");
    assert.deepEqual(occ.agenda, [topic.result.id], "the occurrence took the agenda item");
    assert.deepEqual((await call("agenda.list", { projectId: project })).result.items, [], "and it is off the open agenda while the occurrence holds it");
    // Settled without reaching it: the item is still open for the next meeting.
    assert.ok((await call("meeting.settle", { occurrenceId: sched.lastOccurrenceId, outcome: "cancelled", reason: "nobody came" }, "st1")).ok);
    const open = await call("agenda.list", { projectId: project });
    assert.deepEqual(open.result.items.map((i: { id: string }) => i.id), [topic.result.id]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

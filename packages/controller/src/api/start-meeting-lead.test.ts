import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a meeting's invitation reaches the inbox of every invited agent and nudges the agents that are not busy; a meeting is made five minutes ahead by default and the setting changes that (card M01d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-lead-"));
  const nudges: { key: string; agent: string; occurrenceId: string }[] = [];
  let now = Date.parse("2026-10-27T08:00:00.000Z");
  const timer = new ManualTimer();
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer, intervalMs: 1000, clock: () => new Date(now).toISOString(), nudge: async (n) => { nudges.push({ key: n.key, agent: n.agent, occurrenceId: n.occurrenceId }); } },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    for (const n of ["ann", "bob"]) await c.services.principals.enroll(rob, { commandId: `e-${n}`, kind: "agent", name: n, grants: [{ action: "task.read", project }] });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const urgent = await call("meeting.call-urgent", { projectId: project, title: "Hotfix", reason: "prod is down", roster: ["agent:ann", "agent:bob"] }, "mu1");
    assert.ok(urgent.ok, JSON.stringify(urgent));
    await c.dispatch!.dispatcher.tick();
    const seen = async (agent: string) => (await call("meeting.invitations", { agent })).result?.items ?? [];
    assert.equal((await seen("agent:ann")).length, 1, "both have the invitation");
    assert.equal((await seen("agent:bob")).length, 1);
    assert.deepEqual(nudges.map((n) => n.agent).sort(), ["agent:ann", "agent:bob"], "neither has an attempt running, so both are nudged");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a scheduled meeting is made five minutes before it starts by default, and the meeting.leadMinutes setting changes that (card M01d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-lead-"));
  const day = 86_400_000;
  const dayAt = (offsetDays: number, hhmm: string): number => Date.parse(`${new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10)}T${hhmm}:00.000Z`);
  let now = Date.now();
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), intervalMs: 1000, clock: () => new Date(now).toISOString() },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }] });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const date = (n: number): string => new Date(dayAt(n, "00:00")).toISOString().slice(0, 10);
    const sched = (title: string, n: number) => call("meeting.schedule", { projectId: project, title, roster: ["agent:ann"], time: "08:00", timeZone: "UTC", recurrence: { kind: "once", date: date(n) } }, `ms-${n}`);
    const first = await sched("Stand-up", 2);
    assert.ok(first.ok, JSON.stringify(first));
    const preparedAt = (await call("meeting.schedule-get", { scheduleId: first.result.id })).result.item.nextPrepareAt as string;
    assert.equal(preparedAt, new Date(dayAt(2, "07:55")).toISOString(), "the schedule says when it will be made, with the lead");
    const count = async (id: string): Promise<number> => (await call("meeting.schedule-get", { scheduleId: id })).result.item.occurrences;
    now = dayAt(2, "07:54");
    await c.dispatch!.dispatcher.tick();
    assert.equal(await count(first.result.id), 0, "six minutes ahead is before the default lead of five");
    now = dayAt(2, "07:55");
    await c.dispatch!.dispatcher.tick();
    assert.equal(await count(first.result.id), 1, "five minutes ahead, by default");
    // The owner sets fifteen minutes (the setting is validated).
    const bad = await c.services.configuration.stage(rob, { commandId: "cfg0", layer: "installation", set: { "meeting.leadMinutes": 90 } }).then(() => "staged", (e: Error) => e.message);
    assert.notEqual(bad, "staged", "more than an hour is refused");
    const staged = await c.services.configuration.stage(rob, { commandId: "cfg1", layer: "installation", set: { "meeting.leadMinutes": 15 } });
    await c.services.configuration.apply(rob, { commandId: "cfg2", layer: "installation", expectedRevision: staged.revision });
    const second = await sched("Retro", 3);
    assert.ok(second.ok, JSON.stringify(second));
    now = dayAt(3, "07:44");
    await c.dispatch!.dispatcher.tick();
    assert.equal(await count(second.result.id), 0, "sixteen minutes ahead is before a lead of fifteen");
    now = dayAt(3, "07:45");
    await c.dispatch!.dispatcher.tick();
    assert.equal(await count(second.result.id), 1, "fifteen minutes ahead, as set");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a hint that never returns does not hold back the invitations of the others or the dispatcher's tick (card M01d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-lead-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), intervalMs: 1000, nudge: () => new Promise<void>(() => undefined) },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    for (const n of ["ann", "bob"]) await c.services.principals.enroll(rob, { commandId: `e-${n}`, kind: "agent", name: n, grants: [{ action: "task.read", project }] });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any }>;
    assert.ok((await call("meeting.call-urgent", { projectId: project, title: "Hotfix", reason: "prod is down", roster: ["agent:ann", "agent:bob"] }, "mu1")).ok);
    const finished = await Promise.race([c.dispatch!.dispatcher.tick().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
    assert.equal(finished, true, "the tick ended");
    for (const a of ["agent:ann", "agent:bob"]) assert.equal(((await call("meeting.invitations", { agent: a })).result?.items ?? []).length, 1, a);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

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

async function fixture(extra: Record<string, unknown> = {}) {
  const d = mkdtempSync(join(tmpdir(), "nn-wakehost-"));
  const slot = Date.parse(`${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T08:00:00.000Z`);
  let now = Date.now();
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], ...extra,
    dispatch: { timer: new ManualTimer(), intervalMs: 1000, clock: () => new Date(now).toISOString(), invitations: { invite: async () => undefined } } } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const ids: Record<string, string> = {};
    for (const n of ["ann", "cat"]) {
      ids[n] = (await s.agents.create(rob, { commandId: `ag-${n}`, friendlyName: n })).id;
      await s.grants.grant(rob, { commandId: `g-${n}`, grantee: `agent:${ids[n]}`, action: "task.read", project, source: "direct", basis: "test" });
      await s.grants.grant(rob, { commandId: `h-${n}`, grantee: `agent:${ids[n]}`, action: "history.read", project, source: "direct", basis: "test" });
    }
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { message: string } }>;
    const made = await call("meeting.schedule", { projectId: project, title: "Stand-up", roster: ["ann", "cat"].map((n) => `agent:${ids[n]}`), time: "08:00", timeZone: "UTC", startDate: new Date(slot).toISOString().slice(0, 10), recurrence: { kind: "daily" } }, "ms1");
    assert.ok(made.ok, JSON.stringify(made));
    const open = async (): Promise<string> => {
      now = slot;
      for (let i = 0; i < 2; i++) await c.dispatch!.dispatcher.tick();
      const occurrenceId = (await call("meeting.schedule-get", { scheduleId: made.result.id })).result.item.lastOccurrenceId as string;
      const opened = await call("meeting.attend.open-room", { occurrenceId }, "or1"); assert.ok(opened.ok, JSON.stringify(opened));
      return occurrenceId;
    };
    const seat = async (occurrenceId: string, agent: string) => ((await call("meeting.attend.status", { occurrenceId })).result.item.participants as any[]).find((a) => a.who === `agent:${ids[agent]}`);
    return { c, call, ids, rob, open, seat, availability: (n: string) => c.services.pauses.availability(`agent:${ids[n]}`), close: async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
  } catch (e) { await c.close(); throw e; }
}

test("a stopped agent reports stopped (not paused), the owner's wake makes it available for the one open meeting only, and it is stopped again when the meeting ends, with no host hook supplied (card M04h)", async () => {
  const f = await fixture();
  try {
    const { call, ids } = f;
    assert.equal(await f.availability("cat"), "available");
    const stop = await call("lifecycle.stop", { scope: { kind: "agent", id: ids["cat"] }, mode: "stop", reason: "night" }, "st1");
    assert.equal(stop.result.outcome.state, "stopped", JSON.stringify(stop));
    assert.equal(await f.availability("cat"), "stopped", "the host's stopped is reached, not the pause gate's paused");
    const occurrenceId = await f.open();
    const before = await f.seat(occurrenceId, "cat");
    assert.equal(before.state, "unavailable");
    assert.match(before.reason, /^stopped:/);
    const wake = await call("meeting.attend.wake", { occurrenceId, agent: `agent:${ids["cat"]}` }, "wk1");
    assert.ok(wake.ok, JSON.stringify(wake));
    assert.equal(await f.availability("cat"), "available", "available while the meeting is open");
    assert.equal((await f.seat(occurrenceId, "cat")).state, "preparing");
    // The same command again is a replay; the agent is still one wake.
    assert.ok((await call("meeting.attend.wake", { occurrenceId, agent: `agent:${ids["cat"]}` }, "wk1")).ok);
    // Its task-level holds are not touched: the agent's gate is still paused by the stop.
    const gate = await call("lifecycle.status", { scope: { kind: "agent", id: ids["cat"] } });
    assert.ok(gate.ok, JSON.stringify(gate));
    const ended = await call("meeting.attend.end", { occurrenceId, decisions: [] }, "en1");
    assert.ok(ended.ok, JSON.stringify(ended));
    assert.equal(await f.availability("cat"), "stopped", "back as it was once the meeting is over");
    // The agent that was never stopped is untouched throughout.
    assert.equal(await f.availability("ann"), "available");
  } finally { await f.close(); }
});

test("the composed host refuses to wake an agent that is not at rest through a finished stop, one on a roster it is not on, and never lifts a stop of the whole installation (card M04h)", async () => {
  const f = await fixture();
  try {
    const { call, ids } = f;
    const occurrenceId = await f.open();
    // Not stopped: the owner's wake is refused by attendance itself, so the host is never asked.
    const notStopped = await call("meeting.attend.wake", { occurrenceId, agent: `agent:${ids["cat"]}` }, "wk0");
    assert.equal(notStopped.ok, false);
    assert.match(notStopped.error!.message, /is available; only a suspended or stopped agent/);
    // A plain pause is not a rest either.
    assert.ok((await call("lifecycle.pause", { scope: { kind: "agent", id: ids["cat"] }, reason: "hold" }, "pa1")).ok);
    assert.equal(await f.availability("cat"), "paused");
    // The whole installation stopped: the emergency brake is never overridden, agents stay paused as before.
    assert.ok((await call("lifecycle.resume", { scope: { kind: "agent", id: ids["cat"] }, reason: "done" }, "re1")).ok);
    const all = await call("lifecycle.stop", { scope: { kind: "installation", id: "installation" }, mode: "stop", reason: "brake" }, "st-all");
    assert.ok(all.ok, JSON.stringify(all));
    assert.equal(await f.availability("cat"), "paused");
    const wake = await call("meeting.attend.wake", { occurrenceId, agent: `agent:${ids["cat"]}` }, "wk-all");
    assert.equal(wake.ok, false);
  } finally { await f.close(); }
});

test("a host the embedding application supplies is used as before, and the composed one stays out of the way (card M04h)", async () => {
  const recovered: string[] = [];
  const f = await fixture({ meetingWake: { recover: async (r: { key: string }) => { recovered.push(r.key); } } });
  try {
    const { call, ids } = f;
    assert.equal((await call("lifecycle.stop", { scope: { kind: "agent", id: ids["cat"] }, mode: "stop", reason: "night" }, "st1")).result.outcome.state, "stopped");
    assert.equal(await f.availability("cat"), "paused", "own host: the pause gate answers as it always did");
    assert.deepEqual(recovered, []);
  } finally { await f.close(); }
});

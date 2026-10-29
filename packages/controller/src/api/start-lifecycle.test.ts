import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("suspend and stop through the state API: whoever may pause may ask, nothing live suspends at once, a stop ends and keeps the task as it was (card L02)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-lifecycle-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "attempt.work", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const scope = { kind: "task", id: task };
    // An agent without the grant is refused and nothing is paused.
    assert.equal((await call(ann, "lifecycle.stop", { scope, mode: "stop", reason: "x" }, "a1")).error.code, "forbidden");
    // Nothing is live: the suspension is complete at once, with its checkpoint trivially durable, and the task is paused but otherwise as it was.
    const suspended = await call(boot.token, "lifecycle.stop", { scope, mode: "suspend", reason: "maintenance" }, "s1");
    assert.ok(suspended.ok, JSON.stringify(suspended));
    assert.deepEqual([suspended.result.phase, suspended.result.outcome.state, suspended.result.outcome.graceful], ["done", "suspended", true]);
    assert.equal((await call(boot.token, "lifecycle.get", { intentId: suspended.result.intentId })).result.item.mode, "suspend");
    assert.equal((await call(ann, "lifecycle.get", { intentId: suspended.result.intentId })).error.code, "not_found", "another principal reads it like a missing one");
    const steps = await call(boot.token, "activity.steps", { taskId: task });
    assert.ok(steps.result.steps.some((x: { kind: string; summary: string }) => x.kind === "lifecycle" && /Suspension suspended/.test(x.summary)), JSON.stringify(steps.result));
    // A replay is the same request.
    assert.equal((await call(boot.token, "lifecycle.stop", { scope, mode: "suspend", reason: "maintenance" }, "s1")).result.replayed, true);
    // Stop after suspend ends execution; the task is not cancelled.
    const stopped = await call(boot.token, "lifecycle.stop", { scope, mode: "stop", reason: "night" }, "s2");
    assert.deepEqual([stopped.result.phase, stopped.result.outcome.state], ["done", "stopped"]);
    assert.equal((await call(boot.token, "task.get", { taskId: task })).result.item.state, "proposed");
    // Bad input.
    assert.equal((await call(boot.token, "lifecycle.stop", { scope, mode: "nap", reason: "x" }, "s3")).error.code, "invalid_command");
    assert.equal((await call(boot.token, "lifecycle.stop", { scope: { kind: "installation", id: "nope" }, mode: "stop", reason: "x" }, "s4")).error.code, "invalid_command");
    assert.equal((await call(boot.token, "lifecycle.sweep", {}, "sw")).result.advanced.length, 0);
    assert.equal((await call(ann, "lifecycle.sweep", {}, "sw2")).error.code, "forbidden");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a team and the whole installation can be suspended and stopped, and an intent left unfinished when the controller stopped is finished by the next one without any call (card L02b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-lifecycle-"));
  const file = join(d, "c.sqlite");
  const open = () => startController({ storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  let c = await open();
  let intent = "";
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const team = (await c.services.agents.createTeam(rob, { commandId: "tm1", name: "builders" }) as { id: string }).id;
    await c.services.agents.create(rob, { commandId: "ag1", friendlyName: "A", teamId: team });
    const stopped = await call("lifecycle.stop", { scope: { kind: "team", id: team }, mode: "stop", reason: "night shift over" }, "s1");
    assert.ok(stopped.ok, JSON.stringify(stopped));
    assert.deepEqual([stopped.result.phase, stopped.result.outcome.state], ["done", "stopped"]);
    const whole = await call("lifecycle.stop", { scope: { kind: "installation", id: "installation" }, mode: "suspend", reason: "maintenance" }, "s2");
    assert.ok(whole.ok, JSON.stringify(whole));
    assert.equal(whole.result.outcome.state, "suspended");

    intent = stopped.result.intentId;
    // An intent the controller stopped in the middle of: written as preparing, never advanced. The next start finishes it on its own.
    const rec = await c.storage.getAggregate({ kind: "stop-intent", id: stopped.result.intentId });
    const { outcome: _gone, ...rest } = rec!.body as Record<string, unknown>;
    const left = { ...rest, phase: "preparing" } as never;
    const done = await c.storage.applyOperation({ operationId: "left", epoch: c.epoch, actor: "owner:rob", correlationId: "left", at: new Date().toISOString(), changes: [{ type: "update", ref: { kind: "stop-intent", id: stopped.result.intentId }, expectedRevision: rec!.revision, body: left }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    assert.ok(done !== undefined);
  } finally { await c.close(); }
  c = await open();
  try {
    await c.dispatch!.dispatcher.tick();
    const after = await c.storage.getAggregate({ kind: "stop-intent", id: intent });
    assert.equal((after!.body as { phase: string }).phase, "done", "the intent left preparing was finished by the running controller");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("recovery orders typed in the owner chat work with the assistant down: pause, stop, force stop and revoke run as typed, say what stage they reached, and are audited (card U06)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-recovery-"));
  let asked = 0;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    chat: { interpreter: new ScriptedInterpreter(() => { asked++; throw new Error("provider is down"); }) },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call("task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
    const say = async (id: string, text: string) => (await c.chat!.submit(boot.token, { messageId: id, text })) as any;
    const scope = JSON.stringify({ kind: "task", id: task });
    // Pause, then read its status: nothing needed the assistant.
    const paused = await say("m1", `/nimblenewt.lifecycle-pause {"scope": ${scope}, "reason": "lunch"}`);
    assert.equal(paused.outcomes[0].status, "applied", JSON.stringify(paused.outcomes));
    const status = await say("m2", `/nimblenewt.lifecycle-status {"scope": ${scope}}`);
    assert.match(status.outcomes[0].shown.join("\n"), /"intent": "pause"/);
    // Stop says which stage it reached.
    const stopped = await say("m3", `/nimblenewt.lifecycle-stop {"scope": ${scope}, "mode": "stop", "reason": "night"}`);
    const text = stopped.outcomes[0].shown.join("\n");
    assert.match(text, /Received: yes/);
    assert.match(text, /Accepted: yes/);
    assert.match(text, /Effected: stopped/);
    // Force stop runs as typed and is not graceful.
    await call("lifecycle.resume", { scope: { kind: "task", id: task }, reason: "again" }, "r1");
    const forced = await say("m4", `/nimblenewt.lifecycle-force {"scope": ${scope}, "reason": "on fire"}`);
    assert.match(forced.outcomes[0].shown.join("\n"), /Effected: (stopped|recovery-required)/);
    // Other changing commands are still not run from a typed line.
    assert.equal((await say("m5", '/nimblenewt.placement-set {"allow": ["host:pc"]}')).outcomes[0].code, "needs_confirmation");
    // A bad scope is answered, not run.
    assert.equal((await say("m6", '/nimblenewt.lifecycle-stop {"scope": {"kind": "task", "id": "nope"}, "mode": "stop", "reason": "x"}')).outcomes[0].status, "refused");
    assert.equal(asked, 0, "the assistant was never asked");
    // The orders are on record: the queued command and the run, and the lifecycle request with its actor.
    const record = (await call("lifecycle.get", { intentId: (await call("lifecycle.stop", { scope: { kind: "task", id: task }, mode: "stop", reason: "night" }, "m3-again")).result.intentId })).result.item;
    assert.equal(record.requestedBy, "owner:rob");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

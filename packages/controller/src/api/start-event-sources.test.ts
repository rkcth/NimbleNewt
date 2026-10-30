import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { sourceLoops } from "../dispatch/loops.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { EventSource } from "../events/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner chooses which event sources are watched: a source turned off is not polled from the next tick, turned on it is again, the choice is the owner's, validated, race-safe and shown first in chat (card H13f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-srcset-"));
  const polls: string[] = [];
  const src = (id: string, type: EventSource["type"]): EventSource => ({ id, type, poll: async ({ state }) => { polls.push(id); return { signals: [], state: state ?? {}, more: false }; } });
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    eventSources: [src("repo", "repository"), src("health", "service-failure" as never)],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: { timer: new ManualTimer(), intervalMs: 1000 },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:agt-abcdefghijklmnopqrst")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    const tick = async (): Promise<string[]> => { polls.length = 0; await c.dispatch!.dispatcher.tick(); return [...polls].sort(); };

    // Nothing set: every configured source is watched.
    assert.deepEqual(await tick(), ["health", "repo"]);
    const first = (await call(boot.token, "events.sources.get", {})).result.item;
    assert.deepEqual([first.revision, first.disabled, first.sources.map((s: any) => [s.id, s.enabled])], [0, [], [["repo", true], ["health", true]]]);

    // Owner only; unknown, malformed and stale are refused and change nothing.
    assert.equal((await call(ann, "events.sources.get", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "events.sources.set", { disabled: ["repo"] }, "s0")).error?.code, "forbidden");
    assert.equal((await call(ann, "events.sources.change", { disable: ["repo"] }, "s0b")).error?.code, "forbidden");
    assert.equal((await call(boot.token, "events.sources.set", { disabled: ["reop"] }, "s1")).error?.code, "invalid_command", "a typo would turn nothing off");
    assert.equal((await call(boot.token, "events.sources.set", { disabled: ["bad id"] }, "s2")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "events.sources.set", {}, "s3")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "events.sources.set", { disabled: ["repo"], expectedRevision: 4 }, "s4")).error?.code, "stale_revision");
    assert.equal((await call(boot.token, "events.sources.change", {}, "s5")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "events.sources.change", { disable: ["repo"], enable: ["repo"] }, "s6")).error?.code, "invalid_command");
    assert.deepEqual(await tick(), ["health", "repo"], "nothing changed");

    // Turned off: not polled from the next tick.
    assert.ok((await call(boot.token, "events.sources.set", { disabled: ["repo"], expectedRevision: 0 }, "s7")).ok);
    assert.deepEqual(await tick(), ["health"]);
    // The same command ID again does not apply twice.
    assert.ok((await call(boot.token, "events.sources.set", { disabled: ["repo"], expectedRevision: 0 }, "s7")).ok);

    // In chat the change is shown first, and while it waits another change must survive it.
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const text = "stop watching health";
    const shown = await turn("m1", text, [{ kind: "command", op: "events.sources.change", args: { disable: ["health"] }, evidence: text, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.deepEqual(await tick(), ["health"], "nothing changed yet");
    assert.ok((await call(boot.token, "events.sources.change", { enable: ["repo"] }, "s8")).ok);
    assert.deepEqual(await tick(), ["health", "repo"]);
    const applied = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.deepEqual(await tick(), ["repo"], "the source turned on meanwhile stays on");
    assert.deepEqual((await call(boot.token, "events.sources.get", {})).result.item.sources.map((s: any) => [s.id, s.enabled]), [["repo", true], ["health", false]]);

    // All off: nothing is polled and the loop does not fail.
    assert.ok((await call(boot.token, "events.sources.set", { disabled: ["repo", "health"] }, "s9")).ok);
    assert.deepEqual(await tick(), []);
    assert.ok((await call(boot.token, "events.sources.set", { disabled: [] }, "s10")).ok);
    assert.deepEqual(await tick(), ["health", "repo"]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("when the owner's choice cannot be read no source is polled, and the failure shows (card H13f)", async () => {
  const polled: string[] = [];
  const [loop] = sourceLoops({ run: async (_by, list) => { polled.push(...list.map((s) => s.id as string)); return []; } }, [{ id: "a", type: "file" } as never, { id: "b", type: "file" } as never], async () => { throw new Error("storage unavailable"); });
  await assert.rejects(() => loop!.run({ id: "service:dispatcher", kind: "service" } as never), /storage unavailable/);
  assert.deepEqual(polled as string[], []);
  const [some] = sourceLoops({ run: async (_by, list) => { polled.push(...list.map((s) => s.id as string)); return []; } }, [{ id: "a", type: "file" } as never, { id: "b", type: "file" } as never], async () => new Set(["a"]));
  await some!.run({ id: "service:dispatcher", kind: "service" } as never);
  assert.deepEqual(polled, ["b"]);
});

test("turning off a source that forgets old events warns, and a critical source cannot be turned off (card H13f review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-srcset-"));
  const src = (id: string, extra: Partial<EventSource>): EventSource => ({ id, type: "repository", poll: async ({ state }) => ({ signals: [], state: state ?? {}, more: false }), ...extra });
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    eventSources: [src("tasks", { retentionMs: 7 * 86_400_000 }), src("core", { critical: true }), src("plain", {})],
    dispatch: { timer: new ManualTimer(), intervalMs: 1000 },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    const refused = await call("events.sources.set", { disabled: ["core"] }, "k1");
    assert.equal(refused.error?.code, "invalid_command");
    assert.match(refused.error!.message, /core cannot be switched off/);
    assert.equal((await call("events.sources.change", { disable: ["plain", "core"] }, "k2")).error?.code, "invalid_command");
    assert.deepEqual((await call("events.sources.get", {})).result.item.disabled ?? [], [], "a refused change changed nothing");
    const plain = await call("events.sources.set", { disabled: ["plain"] }, "k4");
    assert.ok(plain.ok); assert.equal(plain.result.warning, undefined);
    const warned = await call("events.sources.change", { disable: ["tasks"] }, "k5");
    assert.ok(warned.ok);
    assert.match(warned.result.warning, /tasks: events that happen while it is off and are older than 7 days/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("when the setting cannot be read the last known choice is used, and after five failures in a row the owner is told once (card H13f review)", async () => {
  const polled: string[][] = [];
  const told: Array<{ id: string; text: string }> = [];
  const logged: string[] = [];
  let broken = false;
  const list = [{ id: "a", type: "file" } as never, { id: "b", type: "file" } as never];
  const runner = { run: async (_by: never, l: readonly EventSource[]) => { polled.push(l.map((s) => s.id)); return []; } };
  const [loop] = sourceLoops(runner, list, async () => { if (broken) throw new Error("storage unavailable"); return new Set(["a"]); }, { tell: async (n) => { told.push(n); }, log: (m) => { logged.push(m); } });
  const by = { id: "service:dispatcher", kind: "service" } as never;
  await loop!.run(by);
  broken = true;
  for (let i = 0; i < 7; i++) await loop!.run(by);
  assert.deepEqual(polled, Array(8).fill(["b"]), "the source the owner turned off stays off while the setting is unreadable");
  assert.equal(logged.length, 7);
  assert.equal(told.length, 1, "told once, not on every tick");
  assert.match(told[0]!.text, /event watching is not running: the source setting cannot be read/i);
  broken = false; await loop!.run(by);
  broken = true; for (let i = 0; i < 5; i++) await loop!.run(by);
  assert.equal(told.length, 2, "a new episode is told again, with a different id");
  assert.notEqual(told[0]!.id, told[1]!.id);
  // Never read successfully: nothing is cached, so nothing is polled and the tick fails.
  polled.length = 0; told.length = 0;
  const [cold] = sourceLoops(runner, list, async () => { throw new Error("storage unavailable"); }, { tell: async (n) => { told.push(n); } });
  for (let i = 0; i < 5; i++) await assert.rejects(() => cold!.run(by), /storage unavailable/);
  assert.deepEqual(polled, []);
  assert.equal(told.length, 1, "told even when nothing could be cached");
});

test("the loop tells the owner once about a source's gap (card H13f review)", async () => {
  const told: Array<{ id: string; text: string }> = [];
  const gap = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z" };
  const [loop] = sourceLoops({ run: async () => [{ source: "tasks", polled: 0, published: 0, duplicates: 0, suppressed: 0, rejected: [], more: false, gap }] }, [{ id: "tasks", type: "task-completion" } as never], undefined, { tell: async (n) => { told.push(n); } });
  await loop!.run({ id: "service:dispatcher", kind: "service" } as never);
  await loop!.run({ id: "service:dispatcher", kind: "service" } as never);
  assert.match(told[0]!.text, /Events from tasks between 2026-10-01T00:00:00.000Z and 2026-10-20T00:00:00.000Z were not watched/);
  assert.equal(told[0]!.id, told[1]!.id, "the same id each time, so the notification is not repeated");
});

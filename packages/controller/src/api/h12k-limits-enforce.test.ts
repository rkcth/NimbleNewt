import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT_OPS, ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { Principal } from "../security/principals.js";
import { MemoryStorage } from "../storage/memory.js";
import { startController } from "./index.js";
import { WorkerLimitsSettingsService } from "./worker-limits-settings.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const owner = { id: "owner:rob", kind: "owner", name: "rob", grants: [] } as unknown as Principal;

type Call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => Promise<{ ok: boolean; result?: any; error?: { code: string } }>;

async function boot(extra: { limits?: unknown } = {}) {
  const d = mkdtempSync(join(tmpdir(), "nn-wlimenf-"));
  let services: Record<string, unknown> = {};
  const launches: Array<{ outcome: string; limits?: unknown }> = [];
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    dispatch: { timer: new ManualTimer(), manual: true, local: { acceptUnenforcedLimits: true, window: () => 8192, ...extra, close: async () => undefined, build: (s: Record<string, unknown>) => { services = s; return { hostId: "host:w1" } as never; } } },
  } as never);
  /** What a host's workspace builder does at each launch: read the figures now, and refuse the launch when they cannot be read. */
  const launch = async () => {
    try { const limits = await (services.currentLimits as () => Promise<unknown>)(); launches.push({ outcome: "started", limits }); return limits; } catch (e) { launches.push({ outcome: "refused" }); throw e; }
  };
  const owner = await c.services.principals.bootstrapOwner({ name: "rob" });
  const call: Call = (token, op, args, commandId) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
  return { c, d, call, token: owner.token, launch, launches, services: () => services, done: async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}

test("the host builder has no static limits to read: only currentLimits, which sees a change at the next launch and refuses the launch when the setting is unreadable (card H12k fix)", async () => {
  const t = await boot({ limits: { cpus: 2, memoryMb: 2048 } });
  try {
    assert.equal("limits" in t.services(), false, "no stale start-up figures are handed to the host");
    assert.deepEqual(await t.launch(), { cpus: 2, memoryMb: 2048 });
    assert.ok((await t.call(t.token, "workers.limits.set", { limits: { memoryMb: 512 } }, "a1")).ok);
    assert.deepEqual(await t.launch(), { cpus: 2, memoryMb: 512 }, "the next launch sees the change");
    // The storage becomes unreadable for this setting: the launch is refused, not run unlimited.
    const storage = t.c.storage as unknown as { getAggregate: (ref: { kind: string; id: string }) => Promise<unknown> };
    const real = storage.getAggregate.bind(storage);
    storage.getAggregate = async (ref) => { if (ref.kind === "worker-limits-settings") throw new Error("disk gone"); return real(ref); };
    await assert.rejects(t.launch(), /./);
    assert.deepEqual(t.launches.map((l) => l.outcome), ["started", "started", "refused"]);
    storage.getAggregate = real;
    assert.deepEqual(await t.launch(), { cpus: 2, memoryMb: 512 }, "readable again: launches resume");
  } finally { await t.done(); }
});

test("a damaged setting record or a storage fault makes effective() throw instead of returning no limits (card H12k fix)", async () => {
  const storage = new MemoryStorage();
  const { epoch } = await storage.acquireEpoch({ holder: "t", at: "2026-01-01T00:00:00.000Z" });
  const svc = WorkerLimitsSettingsService.withEpoch(storage, epoch, { cpus: 2 });
  await svc.set(owner, { commandId: "c1", limits: { memoryMb: 1024 } });
  assert.deepEqual(await svc.effective(), { cpus: 2, memoryMb: 1024 });
  const real = storage.getAggregate.bind(storage);
  const damaged = async (body: unknown) => { storage.getAggregate = async (ref) => { const a = await real(ref); return ref.kind === "worker-limits-settings" && a !== undefined ? { ...a, body } as never : a; }; };
  for (const body of [{ limits: { memoryMb: 0 }, updatedBy: "x", updatedAt: "x" }, { limits: { gpus: 3 }, updatedBy: "x", updatedAt: "x" }, { limits: "lots" }, { limits: [1] }]) {
    await damaged(body);
    await assert.rejects(svc.effective(), /./, JSON.stringify(body));
  }
  storage.getAggregate = async () => { throw new Error("disk gone"); };
  await assert.rejects(svc.effective(), /./, "a storage fault throws");
  await assert.rejects(svc.get(owner), /./);
});

test("workers.limits.change merges: sets the named figures, clears the unset ones, optional expectedRevision, validated and owner only (card H12k fix)", async () => {
  const t = await boot({ limits: { cpus: 2 } });
  try {
    assert.ok((await t.call(t.token, "workers.limits.set", { limits: { memoryMb: 1024, processes: 64 } }, "m1")).ok);
    const ch = await t.call(t.token, "workers.limits.change", { set: { diskMb: 500 }, unset: ["processes"] }, "m2");
    assert.ok(ch.ok, JSON.stringify(ch));
    const item = (await t.call(t.token, "workers.limits.get", {})).result.item;
    assert.deepEqual(item.limits, { memoryMb: 1024, diskMb: 500 });
    assert.equal((await t.call(t.token, "workers.limits.change", { set: { cpus: 4 }, expectedRevision: 0 }, "m3")).error?.code, "stale_revision");
    for (const [i, bad] of ([{}, { set: {} }, { set: { cpus: 0 } }, { unset: ["gpus"] }, { unset: "cpus" }, { set: { cpus: 2 }, unset: ["cpus"] }, { set: { cpus: 2 }, extra: 1 }] as Record<string, unknown>[]).entries()) {
      assert.equal((await t.call(t.token, "workers.limits.change", bad, `mb${i}`)).error?.code, "invalid_command", JSON.stringify(bad));
    }
    assert.deepEqual((await t.call(t.token, "workers.limits.get", {})).result.item.limits, { memoryMb: 1024, diskMb: 500 }, "refused changes changed nothing");
    const withRev = await t.call(t.token, "workers.limits.change", { unset: ["memoryMb", "diskMb"], expectedRevision: ch.result.revision }, "m4");
    assert.ok(withRev.ok);
    assert.deepEqual(await t.launch(), { cpus: 2 }, "all cleared: start-up applies");
    await t.c.services.principals.enroll(await t.c.services.principals.authenticate(t.token), { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [] });
    const ann = (await t.c.services.principals.issueCredential(await t.c.services.principals.authenticate(t.token), "agent:agt-abcdefghijklmnopqrst")).token;
    assert.equal((await t.call(ann, "workers.limits.change", { set: { cpus: 1 } }, "m5")).error?.code, "forbidden");
  } finally { await t.done(); }
});

test("a chat proposal for the limits made at revision 1, then an API change, then accepted: the API change is kept (card H12k fix)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-wlimchat-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: { timer: new ManualTimer(), manual: true, local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined, build: () => ({ hostId: "host:w1" }) as never } },
  } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call: Call = (token, op, args, commandId) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    assert.ok((await call(boot.token, "workers.limits.set", { limits: { memoryMb: 1024 } }, "p0")).ok);
    const text = "give agents 3 cpus";
    const shown = await turn("m1", text, [{ kind: "command", op: "workers.limits.change", args: { set: { cpus: 3 } }, evidence: text, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.ok((await call(boot.token, "workers.limits.change", { set: { processes: 99 } }, "p1")).ok);
    const applied = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.deepEqual((await call(boot.token, "workers.limits.get", {})).result.item.limits, { memoryMb: 1024, processes: 99, cpus: 3 }, "the figure the API changed meanwhile is kept");
    assert.equal(CHAT_OPS["workers.limits.set"], undefined, "chat no longer replaces the whole setting");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("replaying a limits command ID with different limits is command_conflict, the same limits replays (card H12k fix)", async () => {
  const t = await boot();
  try {
    const first = await t.call(t.token, "workers.limits.set", { limits: { cpus: 2 } }, "r1");
    assert.ok(first.ok);
    assert.equal((await t.call(t.token, "workers.limits.set", { limits: { cpus: 3 } }, "r1")).error?.code, "command_conflict");
    assert.equal((await t.call(t.token, "workers.limits.set", { limits: { cpus: 2 } }, "r1")).result.revision, first.result.revision);
    const ch = await t.call(t.token, "workers.limits.change", { set: { memoryMb: 100 } }, "r2");
    assert.ok(ch.ok);
    assert.equal((await t.call(t.token, "workers.limits.change", { set: { memoryMb: 200 } }, "r2")).error?.code, "command_conflict");
    assert.equal((await t.call(t.token, "workers.limits.change", { set: { memoryMb: 100 } }, "r2")).result.revision, ch.result.revision);
  } finally { await t.done(); }
});

test("startController refuses a local host builder whose host ignores the owner's limits (it would run every agent unlimited), and accepts one that says it applies them or an explicit opt-out (card H12k review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-wlimpol-"));
  const make = async (name: string, local: Record<string, unknown>) => startController({
    storage: { kind: "sqlite", path: join(d, `${name}.sqlite`) }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 8192, close: async () => undefined, ...local } },
  } as never);
  try {
    let closed = 0;
    const ignoring = await make("a", { close: async () => { closed++; }, build: () => ({ hostId: "host:w1" }) as never });
    assert.equal(ignoring.dispatch, undefined, "no dispatcher is running");
    assert.match(String(ignoring.dispatchProblem), /does not apply the owner's limits, best-effort setting or launch record/);
    assert.equal(closed, 1, "what the builder made is closed again");
    await ignoring.close();
    const applying = await make("b", { build: () => ({ hostId: "host:w1", ownerPolicy: true }) as never });
    assert.equal(applying.dispatchProblem, undefined);
    assert.ok(applying.dispatch !== undefined);
    await applying.close();
    const optedOut = await make("c", { acceptUnenforcedLimits: true, build: () => ({ hostId: "host:w1" }) as never });
    assert.equal(optedOut.dispatchProblem, undefined);
    await optedOut.close();
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("chat: forbidding best effort applies at once (the safer direction), allowing it is shown first", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-wlimbe-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: { timer: new ManualTimer(), manual: true, local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined, build: () => ({ hostId: "host:w1" }) as never } },
  } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call: Call = (token, op, args, commandId) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const allow = "allow best effort for local agents";
    const shown = await turn("m1", allow, [{ kind: "command", op: "workers.limits.besteffort", args: { enabled: true }, evidence: allow, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.equal((await call(boot.token, "workers.limits.get", {})).result.item.bestEffort, false, "nothing changed yet");
    const yes = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(yes[0]!.status, "applied", JSON.stringify(yes));
    assert.equal((await call(boot.token, "workers.limits.get", {})).result.item.bestEffort, true);
    const forbid = "forbid best effort for local agents";
    const off = await turn("m3", forbid, [{ kind: "command", op: "workers.limits.besteffort", args: { enabled: false }, evidence: forbid, basis: "owner" }]);
    assert.equal(off[0]!.status, "applied", JSON.stringify(off));
    assert.equal((await call(boot.token, "workers.limits.get", {})).result.item.bestEffort, false, "narrowing took effect in the same turn");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("recording a launch: two records of one attempt at the same moment both land (it retries), and only the newest 20 attempts of an agent keep a record", async () => {
  const storage = new MemoryStorage();
  const { epoch } = await storage.acquireEpoch({ holder: "t", at: "2026-01-01T00:00:00.000Z" });
  const svc = WorkerLimitsSettingsService.withEpoch(storage, epoch, undefined);
  const rec = (attemptId: string, n: number) => ({ attemptId, agentId: "agent:ann", outcome: "started" as const, requested: {}, bestEffort: false, enforcement: [], wallTimeMs: n });
  await Promise.all(Array.from({ length: 6 }, (_, i) => svc.recordLaunch(rec("att-same", i + 1))));
  const same = await svc.enforced(owner, "att-same");
  assert.equal(same.count, 6, "no launch record was lost to contention");
  for (let i = 0; i < 24; i++) await svc.recordLaunch(rec(`att-${i}`, 1));
  await assert.rejects(svc.enforced(owner, "att-same"), /no launch of this attempt/, "the oldest attempts' records are removed");
  await assert.rejects(svc.enforced(owner, "att-3"), /no launch of this attempt/);
  assert.equal((await svc.enforced(owner, "att-4")).count, 1, "the newest 20 stay");
  assert.equal((await svc.enforced(owner, "att-23")).count, 1);
  // A record of another agent is not pruned by this agent's launches.
  await svc.recordLaunch({ ...rec("att-bob", 1), agentId: "agent:bob" });
  assert.equal((await svc.enforced(owner, "att-bob")).count, 1);
  // The structured fields are kept, bounded.
  await svc.recordLaunch({ ...rec("att-ref", 1), outcome: "refused", failed: [{ limit: "processes", enforced: "none", detail: "x".repeat(500) }], stricter: [{ limit: "memoryMb", owner: 4096, applied: 100, why: "stricter" }] });
  const refused = (await svc.enforced(owner, "att-ref")).launches[0] as any;
  assert.deepEqual([refused.failed[0].limit, refused.failed[0].detail.length, refused.stricter[0].applied], ["processes", 300, 100]);
});

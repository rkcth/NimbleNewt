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
    dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 8192, ...extra, close: async () => undefined, build: (s: Record<string, unknown>) => { services = s; return { hostId: "host:w1" } as never; } } },
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
    dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 8192, close: async () => undefined, build: () => ({ hostId: "host:w1" }) as never } },
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

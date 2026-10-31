import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

type Reply = { ok: boolean; result?: any; error?: { code: string } };

test("coverage: settings are owner only, off by default and chat-settable; the report pages; a lapse beyond the period tells the owner once, across ticks and a restart (card P04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-cov-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  let c = await open();
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "responsibility.read", project: "*" }] });
    const ann = (await c.services.principals.issueCredential(owner, "agent:ann")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const project = (await call(boot.token, "project.create", { name: "Ops" }, "p1")).result.id as string;

    // Off by default; owner only; validated.
    const g0 = (await call(boot.token, "coverage.settings.get", {})).result.item;
    assert.deepEqual([g0.revision, g0.enabled, g0.afterMinutes, g0.default], [0, false, null, 1440]);
    assert.equal((await call(ann, "coverage.settings.get", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "coverage.settings.set", { enabled: true }, "s0")).error?.code, "forbidden");
    assert.equal((await call(boot.token, "coverage.settings.set", { afterMinutes: 0 }, "sb")).error?.code, "invalid_command");

    // A responsibility with no holder, started long ago (the stored time is moved back, as the clock cannot be).
    const duty = (await call(boot.token, "responsibility.create", { projectId: project, title: "Keep web up", objective: "Up", everyMinutes: 60 }, "r1")).result.id as string;
    const long = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const realGet = c.storage.getAggregate.bind(c.storage);
    const realList = c.storage.listAggregates.bind(c.storage);
    const back = (a: any) => (a?.kind === "responsibility" ? { ...a, createdAt: long, updatedAt: long } : a);
    c.storage.getAggregate = async (ref) => back(await realGet(ref));
    c.storage.listAggregates = (async (kind: string, o: any) => (await realList(kind, o)).map(back)) as never;

    const rep = (await call(boot.token, "responsibility.coverage", { projectId: project })).result;
    assert.equal(rep.items.length, 1);
    assert.deepEqual(rep.items[0].reasons.sort(), ["no-holder", "no-recent-check"]);
    assert.equal(rep.alert.enabled, false);
    assert.equal(rep.items[0].beyondPeriod, false, "no period applies while the alert is off");
    assert.equal((await call(ann, "responsibility.coverage", { projectId: project })).ok, true, "readable with responsibility.read");
    assert.equal((await call(ann, "responsibility.coverage", { projectId: project, limit: 101 })).error?.code, "invalid_command");
    const notices = async () => (await c.storage.listAggregates("notification-item", { limit: 100 })).filter((n) => JSON.stringify(n.body).includes(duty)).length;
    for (let i = 0; i < 3; i++) await c.dispatch.dispatcher.tick();
    assert.equal(await notices(), 0, "off: nobody is told");

    // Turned on through chat's operation (the form the chat command uses), the owner is told, once.
    const set = await call(boot.token, "coverage.settings.set", { enabled: true, afterMinutes: 120, expectedRevision: 0 }, "s1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.equal((await call(boot.token, "coverage.settings.set", { enabled: false, expectedRevision: 0 }, "s2")).error?.code, "stale_revision");
    for (let i = 0; i < 4; i++) await c.dispatch.dispatcher.tick();
    assert.equal(await notices(), 1, "told once across several ticks");

    // A restart does not tell again.
    await c.close();
    c = await open();
    const back2 = (a: any) => (a?.kind === "responsibility" ? { ...a, createdAt: long, updatedAt: long } : a);
    const g2 = c.storage.getAggregate.bind(c.storage); const l2 = c.storage.listAggregates.bind(c.storage);
    c.storage.getAggregate = async (ref) => back2(await g2(ref));
    c.storage.listAggregates = (async (kind: string, o: any) => (await l2(kind, o)).map(back2)) as never;
    for (let i = 0; i < 3; i++) await c.dispatch!.dispatcher.tick();
    assert.equal(await notices(), 1, "still once after a restart");

    // The setting survived the restart.
    const rev = (await c.api.handle(boot.token, { v: 1, op: "coverage.settings.get", args: {} } as never) as Reply).result.item.revision;
    assert.equal(rev, set.result.revision);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a damaged coverage setting is an error on the setting, does not stop other loops, and the owner repairs it by setting it again (card P04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-cov-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    assert.ok((await call("coverage.settings.set", { enabled: true }, "s1")).ok);
    const real = c.storage.getAggregate.bind(c.storage);
    let damaged = true;
    c.storage.getAggregate = async (ref) => { const a = await real(ref); return damaged && ref.kind === "coverage-settings" && a !== undefined ? { ...a, body: { enabled: "maybe" } } as never : a; };
    assert.equal((await call("coverage.settings.get", {})).error?.code, "unavailable");
    const ok = (await call("coverage.settings.set", { enabled: true, afterMinutes: 90 }, "s2"));
    assert.ok(ok.ok, JSON.stringify(ok));
    damaged = false;
    const item = (await call("coverage.settings.get", {})).result.item;
    assert.deepEqual([item.enabled, item.afterMinutes], [true, 90]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { readRecoveryManifest } from "../recovery/index.js";
import { SqliteStorage } from "../storage/index.js";
import { startController } from "./index.js";

// Card K04, recovery watermarks through the composed controller: the start option turns the scheduled manifest on, the dispatcher's sweep writes it while this controller holds the epoch, the owner
// reads it in free words through the existing `database_transfer` view (no new interpreter text), and after another controller takes the epoch this one never writes a manifest again.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the controller writes the recovery manifest on its schedule, the owner reads the watermark by chat, an agent cannot, and a controller that lost the epoch stops writing (card K04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k04s-"));
  const say: Record<string, unknown[]> = {};
  const dbPath = join(d, "c.sqlite"), manifests = join(d, "recovery");
  let now = Date.parse("2026-11-27T10:00:00.000Z");
  const c = await startController({ storage: { kind: "sqlite", path: dbPath }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), manual: true },
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) }, recovery: { manifestDirectory: manifests, everyMs: 60_000, now: () => new Date(now) } } as never);
  const ask = async (token: string, id: string, text: string) => {
    say[text] = [{ kind: "status", request: { kind: "database_transfer" }, evidence: text, basis: "owner" }];
    return (await c.chat!.submit(token, { messageId: id, text })).outcomes as any[];
  };
  const tick = async (): Promise<void> => { await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle(); };
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const before = JSON.stringify((await ask(boot.token, "q0", "is my standby recovery manifest up to date?"))[0]);
    assert.match(before, /No recovery manifest has been written yet/, before);

    await tick();
    assert.ok(existsSync(join(manifests, "manifest.json")), "the sweep wrote the manifest");
    const first = readRecoveryManifest(manifests).manifest;
    assert.ok(first.watermark.epoch >= 1);
    await c.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p1", args: { name: "Orchard" } } as never);
    await tick();
    assert.equal(readRecoveryManifest(manifests).manifest.sha256, first.sha256, "not due again within everyMs");
    const behind = JSON.stringify((await ask(boot.token, "q1", "how far does the recovery watermark reach?"))[0].lines);
    assert.match(behind, /The latest recovery manifest was written 2026-11-27T10:00:00.000Z at epoch \d+/);
    assert.match(behind, /more audit entr(y|ies)/);
    now += 60_000;
    await tick();
    const second = readRecoveryManifest(manifests).manifest;
    assert.notEqual(second.sha256, first.sha256);
    assert.ok(second.watermark.auditSeq > first.watermark.auditSeq);
    // the answer names the new watermark (asking writes audit entries of its own, so the store is a little ahead again)
    assert.match(JSON.stringify((await ask(boot.token, "q2", "and now?"))[0].lines), new RegExp(`written 2026-11-27T10:01:00.000Z at epoch ${second.watermark.epoch}, audit entry ${second.watermark.auditSeq} and delivery ${second.watermark.deliverySeq}`));

    // an agent gets no answer from this view
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [] });
    const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;
    const asAgent = JSON.stringify(await c.api.handle(zed, { v: 1, op: "status.ask", args: { request: { kind: "database_transfer" } } } as never));
    assert.doesNotMatch(asAgent, /recovery manifest/, asAgent);
    const asOwner = JSON.stringify(await c.api.handle(boot.token, { v: 1, op: "status.ask", args: { request: { kind: "database_transfer" } } } as never));
    assert.match(asOwner, /The latest recovery manifest was written/, "the same view through the API for the owner");

    // another controller takes the epoch on the same database: this one is an old primary from now on
    const other = await SqliteStorage.open({ path: dbPath });
    try { await other.acquireEpoch({ holder: "controller-2", at: "2026-11-27T10:05:00.000Z" }); } finally { await other.close(); }
    const kept = readFileSync(join(manifests, "manifest.json"), "utf8");
    // the dispatcher itself stops at the fence (another sweep meets stale_epoch first); whatever the order, no manifest is written
    now += 120_000;
    await tick().catch((e: unknown) => assert.match(String((e as Error)?.message ?? e), /no longer the primary/));
    now += 86_400_000;
    await tick().catch(() => undefined);
    assert.equal(readFileSync(join(manifests, "manifest.json"), "utf8"), kept, "the old primary wrote no manifest");
    assert.match(JSON.stringify(await ask(boot.token, "q3", "is the manifest still being written?").catch((e: unknown) => String(e))), /no longer the primary|stale_epoch|unavailable/);
  } finally { await c.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a recovery option out of range stops the start, and without the option the view says nothing about a manifest (card K04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k04t-"));
  try {
    await assert.rejects(startController({ storage: { kind: "sqlite", path: join(d, "a.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], recovery: { manifestDirectory: join(d, "r"), everyMs: 1000 } } as never), /recovery\.everyMs/);
    const say: Record<string, unknown[]> = {};
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "b.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } } as never);
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const text = "where is my recovery manifest?";
      say[text] = [{ kind: "status", request: { kind: "database_transfer" }, evidence: text, basis: "owner" }];
      assert.doesNotMatch(JSON.stringify((await c.chat!.submit(boot.token, { messageId: "m1", text })).outcomes), /recovery manifest \(what/);
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

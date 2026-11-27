import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileBlobStore } from "../artifacts/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { promoteController } from "../recovery/index.js";
import { SqliteStorage } from "../storage/index.js";
import { startController } from "./index.js";

// Card K05, first slice, through the composed controller: two controllers on one SQLite file. The running one is fenced by a promotion made on another handle: its dispatcher stops at its next
// round, its writes are refused, a restart of it is refused, and only the successor the promotion named starts; the owner reads what happened by chat (no new interpreter text).
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a promotion fences the running controller before naming the successor; the old one stops dispatching and cannot start again, the successor can (card K05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k05s-"));
  const dbPath = join(d, "c.sqlite"), manifests = join(d, "recovery");
  const say: Record<string, unknown[]> = {};
  const base = { storage: { kind: "sqlite", path: dbPath }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) }, recovery: { manifestDirectory: manifests, everyMs: 60_000, now: () => new Date("2026-11-27T12:00:00.000Z") } };
  const a = await startController({ ...base, dispatch: { timer: new ManualTimer(), manual: true } } as never);
  let b: Awaited<ReturnType<typeof startController>> | undefined;
  try {
    const boot = await a.services.principals.bootstrapOwner({ name: "rob" });
    assert.equal((await a.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p1", args: { name: "Orchard" } } as never) as { ok?: boolean }).ok, true);
    await a.dispatch!.driver.runOnce();
    assert.equal(a.dispatch!.driver.status().state, "idle", "the dispatcher ran a round as the primary");

    // the promotion, from another handle on the same file
    const other = await SqliteStorage.open({ path: dbPath });
    try {
      const r = await promoteController({ storage: other, manifestDirectory: manifests, blobs: await FileBlobStore.open({ directory: join(d, "blobs-b") }), successor: "controller-b", promotionId: "k05s", now: () => new Date("2026-11-27T12:05:00.000Z") });
      assert.equal(r.fencedHolder, "controller");
    } finally { await other.close(); }

    // the old controller: its next round meets the fence and it stops for good; its writes are refused
    assert.equal(await a.dispatch!.driver.runOnce(), undefined);
    assert.equal(a.dispatch!.driver.status().state, "fenced");
    assert.equal(await a.dispatch!.driver.runOnce(), undefined, "a fenced dispatcher does not run again");
    const late = JSON.stringify(await a.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p2", args: { name: "Late" } } as never));
    assert.match(late, /stale_epoch|no longer the primary/, late);
    await a.close();

    // a returning old controller is refused at start, and so is any other name
    await assert.rejects(startController({ ...base } as never), /NimbleNewt will not start: the controller promotion k05s named controller-b .*this controller starts as controller/);
    await assert.rejects(startController({ ...base, holder: "controller-c" } as never), /may not use this store/);

    // the successor starts, writes, and the owner reads the promotion by chat
    b = await startController({ ...base, holder: "controller-b" } as never);
    assert.equal((await b.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p3", args: { name: "After" } } as never) as { ok?: boolean }).ok, true);
    const text = "was the old controller fenced?";
    say[text] = [{ kind: "status", request: { kind: "database_transfer" }, evidence: text, basis: "owner" }];
    const answer = JSON.stringify((await b.chat!.submit(boot.token, { messageId: "q1", text })).outcomes);
    assert.match(answer, /Controller promotion k05s .* fenced the controller of epoch \d+ \(controller\) at epoch \d+ and then named controller-b/, answer);
    assert.doesNotMatch(answer, new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no path in the answer");
    await b.close(); b = undefined;
    // the successor restarts as itself
    b = await startController({ ...base, holder: "controller-b" } as never);
  } finally { await a.close().catch(() => undefined); await b?.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("without a promotion every start is as before, and the owner's view says nothing of one (card K05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k05t-"));
  try {
    const say: Record<string, unknown[]> = {};
    const opts = { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } };
    const c1 = await startController({ ...opts, holder: "one" } as never);
    await c1.close();
    const c2 = await startController({ ...opts, holder: "two" } as never);
    try {
      const boot = await c2.services.principals.bootstrapOwner({ name: "rob" });
      const text = "was any controller fenced?";
      say[text] = [{ kind: "status", request: { kind: "database_transfer" }, evidence: text, basis: "owner" }];
      assert.doesNotMatch(JSON.stringify((await c2.chat!.submit(boot.token, { messageId: "m1", text })).outcomes), /Controller promotion/);
    } finally { await c2.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

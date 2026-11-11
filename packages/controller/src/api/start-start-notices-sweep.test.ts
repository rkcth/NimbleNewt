import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { NotificationService } from "../notifications/index.js";
import { DEFAULT_STARTUP_WINDOW_SECONDS, LAUNCHER_FILE, Launcher, notificationSink, type LauncherNotice, type StartFailureLevel } from "../release/index.js";
import { Clock, makeRelease, pointerSwitcher } from "../release/start-fixture.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type Controller, type StartOptions } from "./index.js";

/**
 * Card K02f: the controller's dispatcher sweep (`release.start-notices`) is the retry for a launcher notice that could not be told at the controller's start: while the controller keeps running, the next sweep that
 * can tell it does, once, through the real notification service, on SQLite and on PostgreSQL. The owner's acknowledgement while it runs settles the inbox item.
 */
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-k02f-sweep-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `k02f_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

for (const store of stores) {
  test(`${store.name}: a launcher notice the controller could not tell at its start is told by a later dispatcher sweep, once, and the owner's acknowledgement settles it (K02f)`, async () => {
    const db = await store.open();
    const d = mkdtempSync(join(tmpdir(), "nn-k02f-sweep-rel-"));
    const root = join(d, "rel"); mkdirSync(root, { recursive: true });
    const file = (): { notices?: LauncherNotice[] } => JSON.parse(readFileSync(join(root, LAUNCHER_FILE), "utf8"));
    let down = true;
    let c: Controller | undefined;
    const raised: string[] = [];
    const open = () => startController({ storage: db.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
      dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000 },
      releases: { root, switcher: "pointer", platform: { os: "linux", arch: "x64" }, notices: {
        // The real sink over the real notification service of this controller; refused while `down` (the notification service cannot take it now).
        raise: async (n: LauncherNotice, level: StartFailureLevel) => { if (down) throw new Error("the notification service is down"); raised.push(n.kind); await notificationSink(NotificationService.withEpoch(c!.storage, c!.epoch, {})).raise(n, level); },
        settle: async (n: LauncherNotice) => { await notificationSink(NotificationService.withEpoch(c!.storage, c!.epoch, {})).settle(n); },
      } } } as never);
    try {
      c = await open();
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const owner = (await c.services.principals.authenticate(boot.token))!;
      await c.close(); c = undefined;

      // The controller is down: the launcher's watchdog judges a start and the next decision falls back.
      const clock = new Clock();
      const sw = pointerSwitcher(root);
      const l = new Launcher({ root, switcher: sw, now: clock.now, monotonic: clock.mono, workers: { min: 1, max: 1 } });
      const announce = async (tag: string) => { const r = makeRelease(root, tag); await l.expect({ ...r, protocol: { min: 1, max: 1 } }); return r; };
      const good = await announce("good"); await sw.write(good.id); await l.prepare(); await l.confirm(good.id);
      const bad = await announce("bad"); await sw.write(bad.id); await l.prepare();
      clock.advance(DEFAULT_STARTUP_WINDOW_SECONDS);
      assert.equal((await l.watchdog()).action, "failed");
      assert.equal(((await l.prepare()) as { releaseId: string }).releaseId, good.id);

      c = await open();
      const inbox = async () => (await NotificationService.withEpoch(c!.storage, c!.epoch, {}).inbox(owner)).items.filter((i) => i.ref.kind === "release-start" && i.state !== "answered" && i.state !== "settled");
      const sweep = async () => { const t = await c!.dispatch!.dispatcher.tick(); const loop = t.loops.find((x) => x.name === "release.start-notices"); assert.ok(loop?.ok === true, JSON.stringify(t.loops.filter((x) => !x.ok))); };
      assert.ok(file().notices!.every((n) => n.sentAt === undefined), "the start could not tell it: pending");
      assert.equal((await inbox()).length, 0);
      await sweep();
      assert.ok(file().notices!.every((n) => n.sentAt === undefined), "still refused: still pending, nothing lost");

      down = false;
      await sweep();
      assert.ok(file().notices!.every((n) => n.sentAt !== undefined), "told by the sweep");
      let items = await inbox();
      assert.equal(items.length, 1, JSON.stringify(items));
      assert.equal(items[0]!.ref.id, bad.id);
      assert.equal(items[0]!.level, "needs-you");
      await sweep(); await sweep();
      items = await inbox();
      assert.equal(items.length, 1);
      assert.equal(items[0]!.count, 1, "the sweeps after it tell nothing again");
      assert.deepEqual(raised, ["fell_back"]);

      // The owner acknowledges while the controller runs: the item leaves the inbox and the launcher's notice is settled.
      const ack = (await c.api.handle(boot.token, { v: 1, op: "release.start.acknowledge", commandId: "ack", args: {} } as never)) as Reply;
      assert.equal(ack.result?.acknowledged, 1, JSON.stringify(ack));
      assert.equal((await inbox()).length, 0);
      assert.ok(file().notices!.every((n) => n.settledAt !== undefined));
      await sweep();
      assert.deepEqual(raised, ["fell_back"], "nothing is raised again after it was settled");
    } finally { await c?.close(); await db.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
}

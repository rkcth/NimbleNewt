import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startController, type EnvironmentFacts, type FilesystemDetector } from "@nimblenewt/controller";
import * as harness from "@nimblenewt/controller/testing";
import { LocalConversationStores } from "@nimblenewt/worker";

// Card K01i: a controller composed with a local worker host whose agents' homes come from one folder (`LocalConversationStores`) backs up every conversation store found there and a restore puts each one back,
// on SQLite and on PostgreSQL (a disposable embedded test server). The worker host itself is a stand-in: no agent runs, only the composition of its conversation folders is under test.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

let pgServer: Promise<harness.TestServer> | undefined;
const pg = (): Promise<harness.TestServer> => (pgServer ??= harness.startTestServer());
after(async () => { if (pgServer !== undefined) await (await pgServer).stop(); });

type Controller = Awaited<ReturnType<typeof startController>>;
const call = async (c: Controller, token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;

for (const kind of ["sqlite", "postgres"] as const) {
  test(`${kind}: the local host's conversation stores are in every backup and come back with a restore, each to its own home (card K01i)`, async () => {
    const d = mkdtempSync(join(tmpdir(), "nn-k01i-homes-"));
    const homes = new LocalConversationStores({ root: join(d, "homes") });
    const storage = kind === "sqlite" ? { kind: "sqlite", path: join(d, "c.sqlite") } : { kind: "postgres", url: (await pg()).url(), schema: `k01i_homes_${process.pid}` };
    const open = () => startController({ storage, dataDirectory: join(d, "data"), argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
      dispatch: { timer: { schedule: () => () => undefined }, manual: true, local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined, piState: { source: homes.source, final: homes.final }, build: () => ({ hostId: "host:local" }) as never } },
      backup: { directory: join(d, "backups") } } as never);
    mkdirSync(join(d, "data"));
    for (const [key, text] of [["task-1", '{"turn":1}\n'], ["task-2", '{"turn":7}\n']] as const) { mkdirSync(join(homes.home(key), "pi"), { recursive: true }); writeFileSync(join(homes.home(key), "pi", "log.jsonl"), text); }
    let c = await open();
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const made = await call(c, boot.token, "backup.now", {}, "b1");
      assert.ok(made.ok, JSON.stringify(made));
      const name = made.result.item.name as string;
      assert.equal((await call(c, boot.token, "backup.list", {})).result.items[0].piState, "included");
      // After the backup both conversations go on.
      writeFileSync(join(homes.home("task-1"), "pi", "log.jsonl"), '{"turn":1}\n{"turn":2}\n');
      writeFileSync(join(homes.home("task-2"), "pi", "log.jsonl"), '{"turn":7}\n{"turn":8}\n');
      const preview = await call(c, boot.token, "backup.restore.preview", { name });
      assert.equal(preview.result.item.piStores, 2);
      assert.equal(preview.result.item.piFiles, 2);
      assert.ok((await call(c, boot.token, "backup.restore.apply", { name, confirm: preview.result.item.token }, "r1")).ok);
      await c.close();
      c = await open();
      assert.equal(readFileSync(join(homes.home("task-1"), "pi", "log.jsonl"), "utf8"), '{"turn":1}\n');
      assert.equal(readFileSync(join(homes.home("task-2"), "pi", "log.jsonl"), "utf8"), '{"turn":7}\n');
      assert.equal((await call(c, boot.token, "backup.restore.status", {})).result.item.pending, undefined);
    } finally { await c.close().catch(() => undefined); rmSync(d, { recursive: true, force: true }); }
  });
}

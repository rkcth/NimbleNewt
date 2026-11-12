import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PiStateHost, RemoteWorkerClient, WorkspaceResponder, startController, type EnvironmentFacts, type FilesystemDetector } from "@nimblenewt/controller";
import * as harness from "@nimblenewt/controller/testing";
import { LocalConversationStores } from "@nimblenewt/worker";

// Card K01i, the end-to-end acceptance on a multi-host installation: the controller's own host (conversation folders under <base>/attempts/<attempt>/home/pi, as the product host keeps them) and a remote worker host connected over the
// authenticated transport. A backup holds BOTH hosts' conversation stores; a restore through the owner's API puts the local one back at the next start and delivers the remote one to its host once the host is connected again.
// SQLite and PostgreSQL (a disposable embedded server) are the storages startController runs on; the four-backend coverage of the transfer itself is in controller/src/remote/pi-state.test.ts.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const LOCAL = "att-llllllllllllllllllll", REMOTE = "att-rrrrrrrrrrrrrrrrrrrr";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let pgServer: Promise<harness.TestServer> | undefined;
const pg = (): Promise<harness.TestServer> => (pgServer ??= harness.startTestServer());
after(async () => { if (pgServer !== undefined) await (await pgServer).stop(); });

type Controller = Awaited<ReturnType<typeof startController>>;
const call = async (c: Controller, token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
const freePort = (): Promise<number> => new Promise((ok, no) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); s.on("error", no); });
const until = async (ok: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(`timed out: ${what}`); await sleep(50); } };

for (const kind of ["sqlite", "postgres"] as const) {
  test(`${kind}: a backup holds the conversation stores of this host and of a remote host; a restore puts the local one back at the start and delivers the remote one to its host once it is connected and its agent is idle (card K01i)`, async () => {
    const d = mkdtempSync(join(tmpdir(), "nn-k01i-multi-"));
    const port = await freePort();
    const local = new LocalConversationStores({ root: join(d, "local", "attempts"), homeFolder: "home" });
    const remoteRoot = join(d, "remote", "attempts");
    const remoteStores = new LocalConversationStores({ root: remoteRoot, homeFolder: "home" });
    const storage = kind === "sqlite" ? { kind: "sqlite", path: join(d, "c.sqlite") } : { kind: "postgres", url: (await pg()).url(), schema: `k01i_multi_${process.pid}` };
    const lines: string[] = [];
    const open = () => startController({ storage, dataDirectory: join(d, "data"), argv: [], env: {}, print: (l: string) => { lines.push(l); }, facts: supported, filesystem: ext4, features: [], harnesses: [],
      dispatch: { timer: { schedule: () => () => undefined }, manual: true,
        local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined, piState: { source: local.source, final: local.final }, build: () => ({ hostId: "host:local" }) as never },
        remote: { blobDirectory: join(d, "blobs"), hosts: [], transport: { port } } },
      backup: { directory: join(d, "backups"), restore: { remotePiEveryMs: 100 } } } as never);
    mkdirSync(join(d, "data"));
    const write = (stores: LocalConversationStores, key: string, text: string): void => { mkdirSync(join(stores.home(key), "pi"), { recursive: true }); writeFileSync(join(stores.home(key), "pi", "log.jsonl"), text); };
    const read = (stores: LocalConversationStores, key: string): string => readFileSync(join(stores.home(key), "pi", "log.jsonl"), "utf8");
    write(local, LOCAL, '{"local":1}\n'); write(remoteStores, REMOTE, '{"remote":1}\n');
    let c = await open();
    let stopHost: (() => Promise<void>) | undefined;
    try {
      assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const owner = await c.services.principals.authenticate(boot.token);
      await c.services.principals.enroll(owner, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
      const hostToken = (await c.services.principals.issueCredential(owner, "host:r1")).token;
      // The remote machine: a client over the real transport, the handler that answers the controller's requests, and a loop that reads them like the real poller does.
      const client = new RemoteWorkerClient({ url: `http://127.0.0.1:${port}`, token: hostToken, workerVersion: "remote-1" });
      const busy = { ids: [] as string[] };
      const responder = new WorkspaceResponder({ client, busy: () => [], port: { run: async () => ({ ok: false, reason: "no" }) }, piState: new PiStateHost({ client, source: remoteStores.source, final: remoteStores.final, busy: () => busy.ids, scratch: join(d, "remote", "copies") }) });
      let running = true; let seq = 0;
      const connect = async (): Promise<void> => { await client.connect(CAPS as never); await client.heartbeat(++seq); };
      await connect();
      const loop = (async () => { while (running) { try { const l = await client.workspaceList(); responder.handle(l.requests, l.withdrawn); await client.heartbeat(++seq); } catch { /* the controller is restarting */ } await sleep(40); } })();
      stopHost = async () => { running = false; await loop; await responder.idle(); };

      const made = await call(c, boot.token, "backup.now", {}, "b1");
      assert.ok(made.ok, JSON.stringify(made));
      const name = made.result.item.name as string;
      const preview = await call(c, boot.token, "backup.restore.preview", { name });
      assert.equal(preview.result.item.piStores, 2, "this host's store and the remote host's");
      assert.equal(preview.result.item.piFiles, 2);
      assert.equal(preview.result.item.piStateProblems, undefined, JSON.stringify(preview.result.item.piStateProblems));
      // Both conversations go on after the backup.
      write(local, LOCAL, '{"local":1}\n{"local":2}\n'); write(remoteStores, REMOTE, '{"remote":1}\n{"remote":2}\n');
      // The remote agent is working on its store when the restart comes: it is not replaced under it.
      busy.ids = [REMOTE];
      const applied = await call(c, boot.token, "backup.restore.apply", { name, confirm: preview.result.item.token }, "r1");
      assert.ok(applied.ok, JSON.stringify(applied));
      await c.close();
      c = await open();
      assert.equal(read(local, LOCAL), '{"local":1}\n', `this host's store is back at the start (${lines.join(" | ")})`);
      assert.equal(read(remoteStores, REMOTE), '{"remote":1}\n{"remote":2}\n', "the remote store is untouched until its host can take it");
      await connect();
      await until(async () => ((await call(c, boot.token, "backup.restore.status", {})).result.item.remotePiState?.waiting[0]?.reason ?? "").includes("is running on this host"), 20_000, "the host refuses while its agent runs");
      const waiting = (await call(c, boot.token, "backup.restore.status", {})).result.item.remotePiState;
      assert.deepEqual(waiting.waiting.map((w: { hostId: string; stores: number }) => [w.hostId, w.stores]), [["host:r1", 1]]);
      assert.equal(read(remoteStores, REMOTE), '{"remote":1}\n{"remote":2}\n');
      // The agent finishes: the store is delivered, what was there is kept beside, and the controller's copy is kept as delivered.
      busy.ids = [];
      await until(async () => (await call(c, boot.token, "backup.restore.status", {})).result.item.remotePiState?.delivered === 1, 20_000, "the store is delivered");
      assert.equal(read(remoteStores, REMOTE), '{"remote":1}\n', "the remote host's store is the backup's");
      assert.ok(readdirSync(join(remoteRoot, REMOTE, "home")).some((n) => n.startsWith("pi.before-restore-")), "what was there is kept beside");
      assert.deepEqual(existsSync(join(d, "data", "restored-pi-state")) ? readdirSync(join(d, "data", "restored-pi-state")) : [], []);
      assert.equal(readdirSync(join(d, "data", "restored-pi-state-delivered")).length, 1);
      // The next backup holds both again (the remote one under its host's name).
      const again = await call(c, boot.token, "backup.now", {}, "b2");
      assert.ok(again.ok, JSON.stringify(again));
      const second = (await call(c, boot.token, "backup.restore.preview", { name: again.result.item.name })).result.item;
      assert.equal(second.piStores, 2);
    } finally { await stopHost?.(); await c.close().catch(() => undefined); rmSync(d, { recursive: true, force: true }); }
  });
}

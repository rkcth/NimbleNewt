import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HEARTBEAT_ENV, readHeartbeat } from "../release/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const TOKEN = "tok-start-hb-0001";

test("a controller started under the launcher (heartbeat variables in its environment) beats into the launcher's file before it is ready and stops when closed; without them nothing is written; an unsafe path only turns it off (K02 heartbeat)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-starthb-"));
  chmodSync(d, 0o700);
  const lines: string[] = [];
  try {
    const file = join(d, "hb.json");
    let closed = false;
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: { [HEARTBEAT_ENV.file]: file, [HEARTBEAT_ENV.token]: TOKEN, [HEARTBEAT_ENV.intervalMs]: "1000" }, print: (l) => lines.push(l), facts: supported, filesystem: ext4, features: [], harnesses: [] });
    try {
      let r = await readHeartbeat(file);
      for (let i = 0; i < 100 && r.kind !== "beat"; i++) { await new Promise((x) => setTimeout(x, 30)); r = await readHeartbeat(file); }
      assert.equal(r.kind, "beat");
      assert.equal((r as { record: { token: string } }).record.token, TOKEN);
      // A clean stop that takes a while (here the database closing for 2.5 s) keeps beating until it is done: the launcher must not take a slow, orderly stop for a hang.
      const store = c.storage as unknown as { close: () => Promise<void> };
      const realClose = store.close.bind(store);
      store.close = async () => { await new Promise((x) => setTimeout(x, 2500)); await realClose(); };
      const seqAt = async (): Promise<number> => { const b = await readHeartbeat(file); return b.kind === "beat" ? b.record.seq : -1; };
      closed = true;
      const closing = c.close();
      await new Promise((x) => setTimeout(x, 300));
      const early = await seqAt();
      await new Promise((x) => setTimeout(x, 1800));
      const late = await seqAt();
      await closing;
      assert.ok(late > early, `the beat continues while the stop is in progress (${early} -> ${late})`);
    } finally { if (!closed) await c.close(); }
    const after = await readHeartbeat(file);
    await new Promise((x) => setTimeout(x, 1300));
    assert.deepEqual(await readHeartbeat(file), after, "closed: no more beats");

    const d2 = mkdtempSync(join(tmpdir(), "nn-starthb2-"));
    chmodSync(d2, 0o700);
    try {
      const none = await startController({ storage: { kind: "sqlite", path: join(d2, "c.sqlite") }, argv: [], env: {}, print: (l) => lines.push(l), facts: supported, filesystem: ext4, features: [], harnesses: [] });
      await none.close();
      const off = await startController({ storage: { kind: "sqlite", path: join(d2, "c.sqlite") }, argv: [], env: { [HEARTBEAT_ENV.file]: "relative.json", [HEARTBEAT_ENV.token]: TOKEN }, print: (l) => lines.push(l), facts: supported, filesystem: ext4, features: [], harnesses: [] });
      await off.close();
      assert.ok(lines.some((l) => /liveness heartbeat is off: .*absolute/.test(l)));
      const disabled = await startController({ storage: { kind: "sqlite", path: join(d2, "c.sqlite") }, argv: [], env: { [HEARTBEAT_ENV.file]: join(d2, "x.json"), [HEARTBEAT_ENV.token]: TOKEN }, heartbeat: false, print: (l) => lines.push(l), facts: supported, filesystem: ext4, features: [], harnesses: [] });
      await disabled.close();
      assert.equal((await readHeartbeat(join(d2, "x.json"))).kind, "missing");
    } finally { rmSync(d2, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

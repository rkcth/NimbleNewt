import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { after, test } from "node:test";
import { OVERRIDE_ENV, OVERRIDE_FLAG, UnsupportedEnvironmentError, type EnvironmentFacts, type FilesystemDetector } from "../environment/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { API_VERSION, startController } from "./index.js";

/** The sandbox's temporary directory may be tmpfs, which is not on the list; these tests are about start-up, so the file system is simulated (the F04i tests below simulate the others). */
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const unsupported: EnvironmentFacts = { platform: "freebsd", arch: "x64", osRelease: "14.0", nodeVersion: "22.19.0" };
let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });

const dir = () => mkdtempSync(join(tmpdir(), "nn-start-"));
const lines = () => { const out: string[] = []; return { out, print: (l: string) => { out.push(l); } }; };
const overrides = async (c: { storage: { listAudit(q: { afterSeq: number; limit: number }): Promise<{ type: string; detail: Record<string, unknown> }[]> } }) =>
  (await c.storage.listAudit({ afterSeq: 0, limit: 100 })).filter((a) => a.type === "environment.override");

test("a supported environment starts silently, records no override, and serves the API", async () => {
  const d = dir();
  const { out, print } = lines();
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print, facts: supported, filesystem: ext4 });
  try {
    assert.deepEqual(out, []);
    assert.equal(c.check.overridden, false);
    assert.deepEqual(await overrides(c), []);
    const issued = await c.services.principals.bootstrapOwner({ name: "rob" });
    const r = await c.api.handle(issued.token, { v: API_VERSION, op: "project.list" });
    assert.ok(r.ok);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the conversation listener is off unless asked for, local when asked, serves the owner, and is closed with the controller", async () => {
  const d = dir();
  const get = (url: string, token: string): Promise<number> => new Promise((resolve, reject) => {
    const r = httpRequest(new URL("/v1/unread", url), { headers: { authorization: `Bearer ${token}` } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    r.on("error", reject); r.end();
  });
  const plain = await startController({ storage: { kind: "sqlite", path: join(d, "a.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try { assert.equal(plain.conversationUrl, undefined); } finally { await plain.close(); }
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "b.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, conversationTransport: {} });
  let url: string;
  try {
    url = c.conversationUrl!;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const owner = (await c.services.principals.bootstrapOwner({ name: "rob" })).token;
    assert.equal(await get(url, owner), 200);
    assert.equal(await get(url, "x".repeat(40)), 401);
  } finally { await c.close(); }
  await assert.rejects(get(url, "x".repeat(40)), /ECONNREFUSED|socket hang up|ECONNRESET/);
  await assert.rejects(startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, conversationTransport: { host: "0.0.0.0" } }), /remote exposure is off/);
  rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("an unsupported environment refuses to start, says how to test and how to override, and creates nothing", async () => {
  const d = dir();
  const file = join(d, "c.sqlite");
  try {
    const shown = lines();
    await assert.rejects(startController({ storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: shown.print, facts: unsupported, filesystem: ext4 }), (e: unknown) => {
      assert.equal(shown.out.join("\n"), (e as Error).message, "the refusal is shown to the operator by start-up itself");
      assert.ok(e instanceof UnsupportedEnvironmentError);
      assert.match(e.message, /will not start/);
      assert.ok(e.message.includes(OVERRIDE_FLAG) && e.message.includes(OVERRIDE_ENV));
      assert.match(e.message, /node scripts\/qa\.mjs --runs=5/);
      return true;
    });
    assert.equal(existsSync(file), false, "no database was created by a refused start");
    // A value of the variable other than 1 or true is not the override.
    await assert.rejects(startController({ storage: { kind: "sqlite", path: file }, argv: [], env: { [OVERRIDE_ENV]: "0" }, print: () => undefined, facts: unsupported, filesystem: ext4 }), UnsupportedEnvironmentError);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the override, by flag or by environment variable, starts loudly and is audited once per epoch", async () => {
  for (const how of [{ argv: [OVERRIDE_FLAG], env: {} }, { argv: [], env: { [OVERRIDE_ENV]: "1" } }]) {
    const d = dir();
    const file = join(d, "c.sqlite");
    try {
      const first = lines();
      const c = await startController({ storage: { kind: "sqlite", path: file }, ...how, print: first.print, facts: unsupported, filesystem: ext4 });
      let epoch: number;
      try {
        assert.equal(c.check.overridden, true);
        assert.match(first.out[0] ?? "", /^WARNING: starting in an unsupported environment/);
        assert.ok(first.out.some((l) => /operating system: found freebsd x64/.test(l)));
        const records = await overrides(c);
        assert.equal(records.length, 1);
        assert.equal((records[0]!.detail["problems"] as { item: string }[])[0]!.item, "operating system");
        assert.equal((await c.api.handle("nonsense", { v: 1, op: "project.list" })).ok, false, "otherwise behaves as normal: authentication still applies");
        epoch = c.epoch;
      } finally { await c.close(); }
      // A restart is a new epoch: the notice is printed again and a new record is written.
      const second = lines();
      const again = await startController({ storage: { kind: "sqlite", path: file }, ...how, print: second.print, facts: unsupported, filesystem: ext4 });
      try {
        assert.ok(second.out.length > 0, "printed at every start");
        assert.ok(again.epoch > epoch, "a new epoch");
        assert.equal((await overrides(again)).length, 2);
      } finally { await again.close(); }
    } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }
});

test("an unsupported PostgreSQL server is refused, or with the override started, printed and audited together with the rest", async () => {
  server ??= startTestServer();
  const s = await server;
  const schema = `start_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const pg = { kind: "postgres" as const, url: s.url(), schema, minimumServerVersionNum: 990000 };
  try {
    const refused = lines();
    await assert.rejects(startController({ storage: pg, argv: [], env: {}, print: refused.print, facts: supported, filesystem: ext4 }), (e: unknown) => {
      assert.equal(refused.out.join("\n"), (e as Error).message);
      assert.match((e as Error).message, /will not start/);
      assert.match((e as Error).message, /PostgreSQL/);
      assert.ok((e as Error).message.includes(OVERRIDE_FLAG));
      return true;
    });
    const { out, print } = lines();
    const c = await startController({ storage: pg, argv: [OVERRIDE_FLAG], env: {}, print, facts: supported, filesystem: ext4 });
    try {
      assert.ok(out.some((l) => /PostgreSQL: found 1\d/.test(l)), out.join("\n"));
      const records = await overrides(c);
      assert.equal(records.length, 1);
      assert.deepEqual((records[0]!.detail["problems"] as { item: string }[]).map((p) => p.item), ["PostgreSQL"]);
      const issued = await c.services.principals.bootstrapOwner({ name: "rob" });
      assert.ok((await c.api.handle(issued.token, { v: 1, op: "project.list" })).ok);
    } finally { await c.close(); }
  } finally { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); }
});

const nfs: FilesystemDetector = async () => ({ type: "nfs4", network: true, where: "/mnt/share" });
const tmpfs: FilesystemDetector = async () => ({ type: "tmpfs", network: false });
const okProbes = { git: async () => ({ status: "present" as const, version: "2.53.0" }) };
const sqliteAt = (file: string) => ({ kind: "sqlite" as const, path: file });

test("a network or unsupported file system under the data directory refuses to start, names the F04h switch, and creates nothing", async () => {
  const d = dir();
  const file = join(d, "data", "c.sqlite");
  try {
    for (const detector of [nfs, tmpfs]) {
      const shown = lines();
      await assert.rejects(startController({ storage: sqliteAt(file), argv: [], env: {}, print: shown.print, facts: supported, filesystem: detector }), (e: unknown) => {
        assert.ok(e instanceof UnsupportedEnvironmentError);
        assert.equal(shown.out.join("\n"), e.message, "shown to the operator by start-up itself");
        assert.match(e.message, /filesystem \(data directory\): found (nfs4|tmpfs)/);
        assert.match(e.message, /ext4, xfs, btrfs/);
        assert.ok(e.message.includes(OVERRIDE_FLAG) && e.message.includes(OVERRIDE_ENV));
        return true;
      });
    }
    assert.equal(existsSync(join(d, "data")), false, "a refused start creates nothing");
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the data directory's file system is asked about for the directory of the SQLite file, and a workspace root is asked about too", async () => {
  const d = dir();
  const asked: string[] = [];
  try {
    const c = await startController({ storage: sqliteAt(join(d, "c.sqlite")), argv: [], env: {}, print: () => undefined, facts: supported, workspaceRoots: [join(d, "ws")], filesystem: async (p) => { asked.push(p); return { type: "ext4", network: false, caseInsensitive: false }; } });
    try {
      assert.deepEqual(asked, [d, join(d, "ws")]);
      assert.deepEqual(c.filesystems.map((f) => [f.role, f.supported]), [["data directory", true], ["workspace", true]]);
    } finally { await c.close(); }
    await assert.rejects(startController({ storage: sqliteAt(join(d, "c.sqlite")), argv: [], env: {}, print: () => undefined, facts: supported, workspaceRoots: [join(d, "ws")], filesystem: async (p) => (p.endsWith("ws") ? { type: "exfat", network: false } : { type: "ext4", network: false }) }), /filesystem \(workspace\): found exfat/);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the override starts on an unsupported file system, prints it, audits it, and changes nothing else", async () => {
  const d = dir();
  try {
    for (const how of [{ argv: [OVERRIDE_FLAG], env: {} }, { argv: [], env: { [OVERRIDE_ENV]: "1" } }]) {
      const file = join(d, `${how.argv.length}.sqlite`);
      const shown = lines();
      const c = await startController({ storage: sqliteAt(file), ...how, print: shown.print, facts: supported, filesystem: nfs, distribution: "Example OS 1" });
      try {
        assert.match(shown.out[0] ?? "", /^WARNING: starting in an unsupported environment/);
        assert.ok(shown.out.some((l) => l.includes("filesystem (data directory): found nfs4")) && shown.out.some((l) => l.includes("distribution Example OS 1")));
        const records = await overrides(c);
        assert.equal(records.length, 1);
        assert.deepEqual((records[0]!.detail["problems"] as { item: string }[]).map((p) => p.item), ["filesystem (data directory)"]);
        assert.match(String(records[0]!.detail["host"]), /distribution Example OS 1/);
        const issued = await c.services.principals.bootstrapOwner({ name: "rob" });
        assert.ok((await c.api.handle(issued.token, { v: API_VERSION, op: "project.list" })).ok, "serves the API as usual");
      } finally { await c.close(); }
    }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a file system problem and an operating system problem are one refusal and one override", async () => {
  const d = dir();
  try {
    const shown = lines();
    await assert.rejects(startController({ storage: sqliteAt(join(d, "c.sqlite")), argv: [], env: {}, print: shown.print, facts: unsupported, filesystem: nfs }), (e: unknown) => {
      const m = (e as Error).message;
      assert.ok(m.includes("operating system: found freebsd") && m.includes("filesystem (data directory)"));
      assert.equal(m.split(OVERRIDE_FLAG).length - 1, 1);
      return true;
    });
    const c = await startController({ storage: sqliteAt(join(d, "c.sqlite")), argv: [OVERRIDE_FLAG], env: {}, print: shown.print, facts: unsupported, filesystem: nfs });
    try { assert.deepEqual((await overrides(c)).map((r) => (r.detail["problems"] as { item: string }[]).map((p) => p.item)), [["operating system", "filesystem (data directory)"]]); } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a missing hard prerequisite refuses to start whatever the switch says; a too-old one needs the switch; features ask for their tools", async () => {
  const d = dir();
  const file = join(d, "c.sqlite");
  try {
    const base = { storage: sqliteAt(file), print: () => undefined, facts: supported, filesystem: ext4 };
    for (const argv of [[], [OVERRIDE_FLAG]]) {
      await assert.rejects(startController({ ...base, argv, env: {}, probes: { git: async () => ({ status: "missing", detail: "git was not found" }) } }), (e: unknown) => {
        assert.match((e as Error).message, /git: found nothing usable \(git was not found\)/);
        assert.match((e as Error).message, /cannot be overridden/);
        if (argv.length === 0) assert.ok(!(e as Error).message.includes(OVERRIDE_FLAG));
        else assert.match((e as Error).message, /was given, but it does not cover/);
        return true;
      });
    }
    assert.equal(existsSync(file), false);
    const old = { git: async () => ({ status: "present" as const, version: "2.30.0" }) };
    await assert.rejects(startController({ ...base, argv: [], env: {}, probes: old }), /git: found 2\.30\.0; supported: 2\.38\.1 or newer[\s\S]*--allow-unsupported-environment/);
    const c = await startController({ ...base, argv: [OVERRIDE_FLAG], env: {}, probes: old });
    try { assert.deepEqual((await overrides(c)).map((r) => (r.detail["problems"] as { item: string }[]).map((p) => p.item)), [["git"]]); } finally { await c.close(); }
    // The sandbox's tools are asked for only when this controller runs a sandbox here.
    const sandbox = { "sandbox-exec": async () => ({ status: "missing" as const, detail: "no sandbox-exec" }), bubblewrap: async () => ({ status: "missing" as const, detail: "no bwrap" }) };
    const plain = await startController({ ...base, argv: [], env: {}, probes: { ...okProbes, ...sandbox } });
    assert.deepEqual(plain.prerequisites.map((p) => p.id).sort(), ["git", "sqlite-library"]);
    await plain.close();
    await assert.rejects(startController({ ...base, argv: [OVERRIDE_FLAG], env: {}, features: ["sandbox"], probes: { ...okProbes, ...sandbox } }), /cannot be overridden/);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a PostgreSQL controller checks the file system only for a data directory it is given, and needs the pg library", async () => {
  server ??= startTestServer();
  const s = await server;
  const schema = `start_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const pg = { kind: "postgres" as const, url: s.url(), schema };
  try {
    await assert.rejects(startController({ storage: pg, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: nfs, dataDirectory: "/mnt/share/nn" }), /filesystem \(data directory\): found nfs4/);
    await assert.rejects(startController({ storage: pg, argv: [OVERRIDE_FLAG], env: {}, print: () => undefined, facts: supported, filesystem: ext4, probes: { "postgres-library": async () => ({ status: "missing", detail: "no pg" }) } }), /cannot be overridden/);
    const c = await startController({ storage: pg, argv: [OVERRIDE_FLAG], env: {}, print: () => undefined, facts: supported, filesystem: nfs, dataDirectory: "/mnt/share/nn" });
    try {
      assert.deepEqual((await overrides(c)).map((r) => (r.detail["problems"] as { item: string }[]).map((p) => p.item)), [["filesystem (data directory)"]]);
      assert.deepEqual(c.prerequisites.map((p) => p.id).sort(), ["git", "postgres-library"]);
    } finally { await c.close(); }
    const none = await startController({ storage: pg, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: nfs });
    assert.deepEqual(none.filesystems, [], "no data directory, nothing to check");
    await none.close();
  } finally { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); }
});

test("the override works end to end for SQLite on a network file system: refused without it, started and audited with it", async () => {
  const d = dir();
  try {
    // A UNC path is recognised as a network path by the adapter itself, whatever the detector says; the detector says nfs4 too.
    const unc = "\\\\fileserver\\share\\nn.sqlite";
    const refused = lines();
    await assert.rejects(startController({ storage: sqliteAt(unc), argv: [], env: {}, print: refused.print, facts: supported, filesystem: nfs }), (e: unknown) => e instanceof UnsupportedEnvironmentError && e.message.includes(OVERRIDE_FLAG));
    // With the switch the adapter accepts the UNC path too. On Linux and macOS it is only a file name, created in the current directory (moved to the temporary one with process.chdir, which relies on
    // node:test running the tests of a file one after another); on Windows it is a real share, so this half is skipped there and the portable test below covers the flag.
    const before = process.cwd();
    if (process.platform !== "win32") process.chdir(d);
    try {
      if (process.platform === "win32") throw new Error("skip");
      const c = await startController({ storage: sqliteAt(unc), argv: [OVERRIDE_FLAG], env: {}, print: () => undefined, facts: supported, filesystem: nfs });
      try { assert.equal((await overrides(c)).length, 1); } finally { await c.close(); }
    } catch (error) { if (!(error instanceof Error && error.message === "skip")) throw error; } finally { process.chdir(before); }
    const { SqliteStorage } = await import("../storage/sqlite/index.js");
    await assert.rejects(SqliteStorage.open({ path: unc }), /network file system/);
    await assert.rejects(SqliteStorage.open({ path: unc, allowNetworkFilesystem: false }), /network file system/);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("every start records the host once per epoch as an environment.host audit record and prints nothing", async () => {
  const d = dir();
  try {
    const shown = lines();
    const c = await startController({ storage: sqliteAt(join(d, "c.sqlite")), argv: [], env: {}, print: shown.print, facts: supported, filesystem: ext4, distribution: "Example OS 1" });
    try {
      assert.deepEqual(shown.out, []);
      const hosts = (await c.storage.listAudit({ afterSeq: 0, limit: 100 })).filter((a) => a.type === "environment.host");
      assert.equal(hosts.length, 1);
      assert.match(String(hosts[0]!.detail["host"]), /distribution Example OS 1/);
      assert.deepEqual(await overrides(c), []);
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("SqliteStorage.open skips the network check only with allowNetworkFilesystem, on a local temporary path", async () => {
  const { SqliteStorage } = await import("../storage/sqlite/index.js");
  const d = dir();
  try {
    const flagged = (path: string) => `${path} is on a simulated network share`;
    await assert.rejects(SqliteStorage.open({ path: join(d, "a.sqlite"), networkCheck: flagged }), /network file system/);
    await assert.rejects(SqliteStorage.open({ path: join(d, "a.sqlite"), networkCheck: flagged, allowNetworkFilesystem: false }), /network file system/);
    const store = await SqliteStorage.open({ path: join(d, "a.sqlite"), networkCheck: flagged, allowNetworkFilesystem: true });
    await store.close();
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the checkouts of registered projects are checked at every start: an unsupported file system refuses, names the switch, and the override starts and audits it (card F04k)", async () => {
  const d = dir();
  const file = join(d, "c.sqlite");
  const where = (p: string) => (p.includes("shared") ? { type: "nfs4", network: true, where: "/mnt/shared" } : { type: "ext4", network: false });
  try {
    // First start: nothing registered, nothing extra asked.
    const first = await startController({ storage: sqliteAt(file), argv: [], env: {}, print: () => undefined, facts: supported, filesystem: async (p) => where(p) });
    try {
      const owner = await first.services.principals.bootstrapOwner({ name: "rob" });
      const principal = await first.services.principals.authenticate(owner.token);
      await first.services.projects.createProject({ commandId: "p-1", actor: principal.id, name: "Shop", repositories: [{ id: "main", location: join(d, "shared", "shop") }, { id: "web", location: "https://example.invalid/x.git" }] });
    } finally { await first.close(); }
    // A later start on the same data finds the checkout on a network file system.
    const asked: string[] = [];
    const shown = lines();
    await assert.rejects(startController({ storage: sqliteAt(file), argv: [], env: {}, print: shown.print, facts: supported, filesystem: async (p) => { asked.push(p); return where(p); } }), (e: unknown) => {
      assert.ok(e instanceof UnsupportedEnvironmentError);
      assert.match(e.message, /filesystem \(workspace\): found nfs4/);
      assert.ok(e.message.includes(OVERRIDE_FLAG));
      assert.equal(shown.out.join("\n"), e.message);
      return true;
    });
    assert.ok(asked.includes(join(d, "shared", "shop")) && !asked.some((p) => p.includes("example.invalid")), "the checkout is asked about; a remote location is not a workspace");
    const c = await startController({ storage: sqliteAt(file), argv: [OVERRIDE_FLAG], env: {}, print: shown.print, facts: supported, filesystem: async (p) => where(p) });
    try {
      const records = await overrides(c);
      assert.equal(records.length, 1);
      assert.deepEqual((records[0]!.detail["problems"] as { item: string }[]).map((p) => p.item), ["filesystem (workspace)"]);
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

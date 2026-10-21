import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { after, test } from "node:test";
import { OVERRIDE_ENV, OVERRIDE_FLAG, UnsupportedEnvironmentError, type EnvironmentFacts } from "../environment/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { API_VERSION, startController } from "./index.js";

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
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print, facts: supported });
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
  const plain = await startController({ storage: { kind: "sqlite", path: join(d, "a.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported });
  try { assert.equal(plain.conversationUrl, undefined); } finally { await plain.close(); }
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "b.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, conversationTransport: {} });
  let url: string;
  try {
    url = c.conversationUrl!;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const owner = (await c.services.principals.bootstrapOwner({ name: "rob" })).token;
    assert.equal(await get(url, owner), 200);
    assert.equal(await get(url, "x".repeat(40)), 401);
  } finally { await c.close(); }
  await assert.rejects(get(url, "x".repeat(40)), /ECONNREFUSED|socket hang up|ECONNRESET/);
  await assert.rejects(startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, conversationTransport: { host: "0.0.0.0" } }), /remote exposure is off/);
  rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("an unsupported environment refuses to start, says how to test and how to override, and creates nothing", async () => {
  const d = dir();
  const file = join(d, "c.sqlite");
  try {
    const shown = lines();
    await assert.rejects(startController({ storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: shown.print, facts: unsupported }), (e: unknown) => {
      assert.equal(shown.out.join("\n"), (e as Error).message, "the refusal is shown to the operator by start-up itself");
      assert.ok(e instanceof UnsupportedEnvironmentError);
      assert.match(e.message, /will not start/);
      assert.ok(e.message.includes(OVERRIDE_FLAG) && e.message.includes(OVERRIDE_ENV));
      assert.match(e.message, /node scripts\/qa\.mjs --runs=5/);
      return true;
    });
    assert.equal(existsSync(file), false, "no database was created by a refused start");
    // A value of the variable other than 1 or true is not the override.
    await assert.rejects(startController({ storage: { kind: "sqlite", path: file }, argv: [], env: { [OVERRIDE_ENV]: "0" }, print: () => undefined, facts: unsupported }), UnsupportedEnvironmentError);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the override, by flag or by environment variable, starts loudly and is audited once per epoch", async () => {
  for (const how of [{ argv: [OVERRIDE_FLAG], env: {} }, { argv: [], env: { [OVERRIDE_ENV]: "1" } }]) {
    const d = dir();
    const file = join(d, "c.sqlite");
    try {
      const first = lines();
      const c = await startController({ storage: { kind: "sqlite", path: file }, ...how, print: first.print, facts: unsupported });
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
      const again = await startController({ storage: { kind: "sqlite", path: file }, ...how, print: second.print, facts: unsupported });
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
    await assert.rejects(startController({ storage: pg, argv: [], env: {}, print: refused.print, facts: supported }), (e: unknown) => {
      assert.equal(refused.out.join("\n"), (e as Error).message);
      assert.match((e as Error).message, /will not start/);
      assert.match((e as Error).message, /PostgreSQL/);
      assert.ok((e as Error).message.includes(OVERRIDE_FLAG));
      return true;
    });
    const { out, print } = lines();
    const c = await startController({ storage: pg, argv: [OVERRIDE_FLAG], env: {}, print, facts: supported });
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

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets, type LocalHostBuilder, type LocalHostContext } from "@nimblenewt/controller";
import * as harness from "@nimblenewt/controller/testing";

// Task T4, the launcher's side: a provider's key is read from the secret store by NAME and sent to the model server. The launcher refuses to read a name the installation keeps for something else (the owner's
// credential, the database address, a transfer target's address, the backup signing key) even when a provider record already names it (a record from before this rule), and never asks the store for it.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const start = { facts, filesystem: ext4, features: [] } as const;
let pgServer: Promise<harness.TestServer> | undefined;
const pg = (): Promise<harness.TestServer> => (pgServer ??= harness.startTestServer());
after(async () => { if (pgServer !== undefined) await (await pgServer).stop(); });
const dirOf = (): string => mkdtempSync(join(tmpdir(), "nn-t4-launch-"));
const clean = (dir: string): void => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const memorySecrets = (seed: Record<string, string>): LauncherSecrets & { values: Map<string, string>; asked: string[] } => {
  const values = new Map(Object.entries(seed)); const asked: string[] = [];
  return { values, asked, resolve: async (n: string) => { asked.push(n); return values.get(n); }, set: async (n: string, v: string) => { values.set(n, v); }, remove: async (n: string) => { values.delete(n); } } as never;
};
const providers: LauncherConfig["models"]["providers"] = {
  primary: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:8002/v1", enabled: true, paid: false, models: ["local-x"] },
  backup: { adapter: "openai-compatible", endpoint: "https://free.example.invalid/v1", credential: { secret: "backup-key" }, enabled: true, paid: false, models: ["free-y"] },
};
const transferTarget = { name: "big-pg", kind: "postgres", url: { secret: "xfer-url" }, schema: "xfer_unused", maxBytes: 900_000_000 };

/** Writes a provider record the way an older version would have let it be written: straight into the records. */
async function recordProvider(l: Awaited<ReturnType<typeof launch>>, provider: string, credentialName: string): Promise<void> {
  const at = "2026-11-15T10:00:00.000Z";
  await l.controller.storage.applyOperation({ operationId: `t4-${provider}`, epoch: l.controller.epoch, actor: "owner:test", correlationId: `t4-${provider}`, at, audit: [{ type: "provider.recorded", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
    changes: [{ type: "create", ref: { kind: "provider-endpoint", id: provider }, body: { provider, endpoint: "https://old.example.invalid/v1", credentialName, setBy: "owner:test" } }] } as never);
}

async function withContext(config: LauncherConfig, secrets: ReturnType<typeof memorySecrets>, body: (ctx: LocalHostContext, l: Awaited<ReturnType<typeof launch>>) => Promise<void>): Promise<void> {
  let context: LocalHostContext | undefined;
  const builder: LocalHostBuilder = async (ctx) => { context = ctx; return { problem: "only looking at the context" }; };
  const first = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, localHost: builder });
  await first.controller.api.handle(first.ownerToken, { v: 1, op: "host.local.set", commandId: "on", args: { enabled: true } } as never);
  await first.close();
  const l = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, localHost: builder });
  try { await body(context!, l); } finally { await l.close(); }
}

test("sqlite: a provider record naming the owner's credential, the backup signing key or a transfer target's address is refused where the launcher reads its key, in any letter case, without asking the secret store (task T4)", async () => {
  const dir = dirOf();
  try {
    const config: LauncherConfig = { installation: { name: "t4", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") }, databaseTransfer: { targets: [transferTarget] } }, models: { providers } };
    const secrets = memorySecrets({ "backup-key": "sk-backup-one", "backup-signing-key": "sk-signing", "xfer-url": "postgres://u:sk-xfer@h/db" });
    await withContext(config, secrets, async (ctx, l) => {
      // The ordinary key still works through the same path.
      const ok = (await ctx.endpoint("backup/free-y"))!;
      assert.deepEqual(await ok.headers!(), { authorization: "Bearer sk-backup-one" });
      const ownerName = [...secrets.values.keys()].find((k) => k.startsWith("nimblenewt-owner-token"))!;
      assert.ok(ownerName, "the owner's credential is in the store");
      let n = 0;
      for (const name of ["backup-signing-key", "BACKUP-SIGNING-KEY", "xfer-url", "Xfer-URL", ownerName, ownerName.toUpperCase(), "nimblenewt-owner-token"]) {
        const id = `old${n++}`;
        await recordProvider(l, id, name);
        const e = (await ctx.endpoint(`${id}/m`))!;
        secrets.asked.length = 0;
        await assert.rejects(Promise.resolve().then(() => e.headers!()), (error: Error) => /cannot be a model provider's credential/.test(error.message) && !error.message.includes("sk-"), name);
        assert.deepEqual(secrets.asked, [], `${name}: the secret store was never asked for it`);
      }
    });
  } finally { clean(dir); }
});

test("sqlite: a provider named in the configuration with a reserved credential is not registered, and the note says why (task T4)", async () => {
  const dir = dirOf();
  try {
    for (const name of ["Backup-Signing-Key", "nimblenewt-owner-token-0123456789abcdef"]) {
      const config: LauncherConfig = { installation: { name: "t4", dataDir: join(dir, name) }, controller: { storage: { kind: "sqlite", path: join(dir, name, "controller.sqlite") } }, models: { providers: { ...providers, backup: { ...providers["backup"]!, credential: { secret: name } } } } };
      const l = await launch({ config, secrets: memorySecrets({ [name]: "sk-x" }), argv: [], env: {}, print: () => undefined, start });
      try {
        assert.match(l.notes.join("\n"), /were not registered yet: .*credentialName.*never sent to a model server/, name);
        assert.equal(await l.controller.storage.getAggregate({ kind: "routing-table", id: "routing" }), undefined, name);
        assert.deepEqual(await l.controller.services.setupProviders.endpoints(), []);
      } finally { await l.close(); }
    }
  } finally { clean(dir); }
});

test("PostgreSQL: a provider record naming the database address's secret is refused where the launcher reads its key, in any letter case; the address is never read for it (task T4)", async () => {
  const server = await pg();
  const dir = dirOf();
  const schema = `t4_${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const config: LauncherConfig = { installation: { name: "t4", dataDir: dir }, controller: { storage: { kind: "postgres", url: { secret: "controller-db-url" }, maxConnections: 4, schema } }, models: { providers } };
    const secrets = memorySecrets({ "backup-key": "sk-backup-one", "controller-db-url": server.url() });
    await withContext(config, secrets, async (ctx, l) => {
      assert.deepEqual(await (await ctx.endpoint("backup/free-y"))!.headers!(), { authorization: "Bearer sk-backup-one" });
      let n = 0;
      for (const name of ["controller-db-url", "Controller-DB-URL"]) {
        const id = `old${n++}`;
        await recordProvider(l, id, name);
        const e = (await ctx.endpoint(`${id}/m`))!;
        secrets.asked.length = 0;
        await assert.rejects(Promise.resolve().then(() => e.headers!()), (error: Error) => /cannot be a model provider's credential/.test(error.message) && !error.message.includes(server.url()), name);
        assert.deepEqual(secrets.asked, [], name);
      }
    });
  } finally {
    clean(dir);
    await harness.withClient(server.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }).catch(() => undefined);
  }
});

test("sqlite: the chat's own model client refuses a provider record that was changed to name the backup signing key: no request carries it and the secret store is never asked for it (task T4 review)", async () => {
  const dir = dirOf();
  const seen: (string | null)[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ kind: "none", reason: "nothing asked" }]) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const keyed: LauncherConfig["models"]["providers"] = { primary: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:8002/v1", credential: { secret: "primary-key" }, enabled: true, paid: false, models: ["local-x"] }, backup: providers["backup"]! };
    const config: LauncherConfig = { installation: { name: "t4", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: keyed } };
    const secrets = memorySecrets({ "primary-key": "sk-primary-one", "backup-key": "sk-backup-one", "backup-signing-key": "sk-signing-value" });
    const l = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch });
    try {
      const say = (text: string) => l.controller.chat!.submit(l.ownerToken, { messageId: `m-${Math.random().toString(36).slice(2)}`, text });
      // The ordinary key reaches the chat's model server through this client.
      const first = await say("What is the status of my projects?");
      assert.match(JSON.stringify(first.reply), /nothing asked/, JSON.stringify(first));
      assert.deepEqual(seen, ["Bearer sk-primary-one"]);
      // The record is changed by hand (or by an older version) to name the signing key.
      const ref = { kind: "provider-endpoint", id: "primary" };
      const have = (await l.controller.storage.getAggregate(ref))!;
      await l.controller.storage.applyOperation({ operationId: "t4-edit", epoch: l.controller.epoch, actor: "owner:test", correlationId: "t4-edit", at: "2026-11-15T10:00:00.000Z", audit: [{ type: "provider.recorded", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
        changes: [{ type: "update", ref, expectedRevision: have.revision, body: { ...(have.body as Record<string, unknown>), credentialName: "Backup-Signing-Key" } }] } as never);
      secrets.asked.length = 0; seen.length = 0;
      await say("And what is the status now?").catch(() => undefined); // the chat may answer that the model failed or use the other route; what matters is what was sent
      assert.equal(seen.some((a) => a?.includes("sk-signing-value") === true), false, "no request carried the signing key");
      assert.equal(seen.includes("Bearer sk-primary-one"), false, "the edited provider's call was not made with a key");
      assert.equal(secrets.asked.some((n) => n.toLowerCase() === "backup-signing-key"), false, "the secret store was never asked for the signing key");
    } finally { await l.close(); }
  } finally { clean(dir); }
});

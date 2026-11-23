import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startController } from "../api/index.js";
import { OWNER_SECRET_PREFIX } from "../admin/admin.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { cid, openWorld } from "../chat/testing/harness.js";
import { adminIntent } from "../web/door.js";
import { INSTALLATION_SECRET_NAMES, providerSecretRefusal } from "./reserved-secrets.js";
import { SetupProviderService } from "./providers.js";

after(stopServer);

// Task T4: a provider's credentialName is read from the secret store and sent to that provider's model server as a bearer token. It must never name a secret the installation keeps for something else: the database
// address, a transfer target's address, the backup signing key, or an owner credential (any name starting with OWNER_SECRET_PREFIX). Letter case is ignored.
const KEPT = ["controller-db-url", "transfer.pg-url", "my-signing-key"];
const mine = { name: "mine", location: "local", endpoint: "http://127.0.0.1:8002/v1", models: ["big-local"], contextTokens: 65536 };
const spare = (credentialName?: string) => ({ name: "spare", location: "cloud", paid: false, endpoint: "https://free.example.invalid/v1", ...(credentialName === undefined ? {} : { credentialName }), models: ["free-model"], contextTokens: 32000 });
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
type R = { ok: boolean; result?: unknown; error?: { code: string; message: string } };

const RESERVED = [
  ...KEPT,
  ...INSTALLATION_SECRET_NAMES,
  `${OWNER_SECRET_PREFIX}-0123456789abcdef`, OWNER_SECRET_PREFIX, `${OWNER_SECRET_PREFIX}x`,
  // letter case is ignored
  "CONTROLLER-DB-URL", "Transfer.PG-Url", "BACKUP-SIGNING-KEY", "My-Signing-Key", `${OWNER_SECRET_PREFIX.toUpperCase()}-ABCDEF0123456789`, "NimbleNewt-Owner-Token",
];

test("the shared check names each reserved secret, ignores letter case, and lets an ordinary name through", () => {
  for (const n of RESERVED) assert.notEqual(providerSecretRefusal(n, KEPT), undefined, n);
  for (const n of ["spare-key", "nimblenewt-owner", "backup-signing-keys", "my-signing-key-2", "openrouter", "controller-db"]) assert.equal(providerSecretRefusal(n, KEPT), undefined, n);
  assert.deepEqual(INSTALLATION_SECRET_NAMES, ["backup-signing-key"]);
  // The names the configuration keeps are an input: with none given, only the fixed names and the owner's prefix are refused.
  assert.equal(providerSecretRefusal("controller-db-url"), undefined);
  assert.notEqual(providerSecretRefusal("backup-signing-key"), undefined);
});

for (const backend of backends) {
  test(`${backend.name}: adding a provider through the API refuses every reserved credential name, in any letter case, and stores nothing; an ordinary name is accepted (task T4)`, async () => {
    let setup: SetupProviderService | undefined;
    const w = await openWorld(backend, {}, undefined, (storage, epoch) => { setup = SetupProviderService.withEpoch(storage, epoch, { clock: () => "2026-11-15T10:00:00.000Z", pause: async () => undefined }, {}, () => KEPT); return { setupProviders: setup }; });
    try {
      const add = async (name: string | undefined, id: string): Promise<R> => w.api.handle(w.ownerToken, { v: 1, op: "routing.provider.add", commandId: id, args: { providers: [mine, spare(name)] } } as never) as unknown as Promise<R>;
      for (const name of RESERVED) {
        const r = await add(name, cid("res"));
        assert.equal(r.ok, false, name);
        assert.equal(r.error!.code, "invalid_command", name);
        assert.match(r.error!.message, /providers\[1\]\.credentialName: .*never sent to a model server; name another secret/, name);
      }
      assert.deepEqual(await setup!.endpoints(), [], "nothing was stored by any refused add");
      assert.equal(await w.world.storage.getAggregate({ kind: "routing-table", id: "routing" }), undefined, "the routing table was not touched");
      // A refusal on the first of two providers is as good as on the second.
      const first = await w.api.handle(w.ownerToken, { v: 1, op: "routing.provider.add", commandId: cid("res"), args: { providers: [{ ...mine, credentialName: "backup-signing-key" }, spare("spare-key")] } } as never) as unknown as R;
      assert.equal(first.ok, false);
      assert.match(first.error!.message, /providers\[0\]\.credentialName/);
      // A name that only resembles a reserved one is fine.
      const ok = await add("controller-db-url-2", cid("ok"));
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.deepEqual((await setup!.endpoints()).map((e) => [e.provider, e.credentialName]), [["mine", undefined], ["spare", "controller-db-url-2"]]);
    } finally { await w.close(); }
  });

  test(`${backend.name}: in chat a reserved credential name is shown first but cannot be applied, and nothing is stored (task T4)`, async () => {
    const script: Record<string, unknown> = {};
    let setup: SetupProviderService | undefined;
    const w = await openWorld(backend, script, undefined, (storage, epoch) => { setup = SetupProviderService.withEpoch(storage, epoch, { clock: () => "2026-11-15T10:00:00.000Z", pause: async () => undefined }, {}, () => KEPT); return { setupProviders: setup }; });
    try {
      const chat = w.chat();
      w.profile.value = "autonomous";
      const say = async (text: string, plan: unknown[]) => { script[text] = plan; const o = (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes; assert.equal(o.length, 1); return o[0]!; };
      for (const name of ["Controller-DB-URL", "backup-signing-key", "nimblenewt-owner-token-aaaaaaaaaaaaaaaa"]) {
        const text = `Add my local server mine at http://127.0.0.1:8002/v1 with the model big-local (65536 tokens), and a free cloud one spare at https://free.example.invalid/v1 with the model free-model (32000 tokens), whose key is the secret ${name}.`;
        const o = await say(text, [cmd("routing.provider.add", { providers: [mine, spare(name)] }, text)]);
        if (o.status === "proposed") {
          // Earlier names' proposals stay open, so the owner says which one is meant.
          const yes = `Yes, do that (${name}) ${o.proposalId}.`;
          const r = await say(yes, [{ kind: "apply_proposal", proposalId: o.proposalId, evidence: yes, basis: "owner" }]);
          assert.notEqual(r.status, "applied", name);
          assert.match(JSON.stringify(r), /credentialName/, name);
        } else assert.notEqual(o.status, "applied", name);
      }
      assert.deepEqual(await setup!.endpoints(), []);
    } finally { await w.close(); }
  });
}

test("the web page refuses a reserved credential name before it makes the chat sentence, in any letter case; an ordinary name and no name still make one (task T4)", () => {
  const page = (credentialName?: string) => adminIntent("provider", { name: "cloud-b", location: "cloud", endpoint: "https://api.example.test/v1", models: ["big"], contextTokens: 65536, ...(credentialName === undefined ? {} : { credentialName }) });
  for (const n of ["backup-signing-key", "BACKUP-Signing-Key", "nimblenewt-owner-token-0123456789abcdef", "NimbleNewt-Owner-Token"]) assert.throws(() => page(n), (e: { status?: number; message?: string }) => e.status === 400 && /never sent to a model server/.test(e.message ?? ""), n);
  assert.match(page("cloud-b-key").text, /its secret is named cloud-b-key/);
  assert.doesNotMatch(page().text, /its secret/);
});

test("a started controller refuses the names its secrets option reserves when a provider is added through the API (the wiring of the Secrets form's reserved list into provider editing, task T4)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-t4-start-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), adminSecrets: { store: { resolve: async () => undefined, set: async () => undefined }, reserved: ["nimblenewt-owner-token-1234", "Database-Address"] } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const add = (credentialName: string, commandId: string) => c.api.handle(boot.token, { v: 1, op: "routing.provider.add", commandId, args: { providers: [mine, spare(credentialName)] } } as never) as Promise<R>;
    for (const name of ["database-address", "DATABASE-ADDRESS", "backup-signing-key", "nimblenewt-owner-token-1234"]) { const r = await add(name, `r-${name}`); assert.equal(r.ok, false, name); assert.match(r.error!.message, /never sent to a model server/, name); }
    assert.equal((await add("spare-key", "r-ok")).ok, true);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a controller started without the launcher and without a secrets option still refuses its transfer targets' address secrets as a provider's credential (task T4 review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-t4-xfer-"));
  const entries = [{ name: "big-pg", kind: "postgres", url: { secret: "Xfer-Url" }, schema: "xfer_unused", maxBytes: 900_000_000 }];
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), transfer: { stateDirectory: join(d, "transfer"), targets: [], targetEntries: entries, secrets: async (n: string) => (n === "Xfer-Url" ? "postgres://u:pw-not-real@127.0.0.1:1/db" : undefined) } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const add = (credentialName: string, commandId: string) => c.api.handle(boot.token, { v: 1, op: "routing.provider.add", commandId, args: { providers: [mine, spare(credentialName)] } } as never) as Promise<R>;
    for (const name of ["xfer-url", "XFER-URL", "backup-signing-key"]) { const r = await add(name, `x-${name}`); assert.equal(r.ok, false, name); assert.match(r.error!.message, /never sent to a model server/, name); }
    assert.deepEqual(await c.services.setupProviders.endpoints(), []);
    assert.equal((await add("xfer-url-2", "x-ok")).ok, true);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

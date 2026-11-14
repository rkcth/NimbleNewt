import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { protectedFileStore } from "@nimblenewt/config";
import { BACKUP_KEYRING_FILE, SIGNING_SECRET_NAME, createKeyring, launch, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig } from "@nimblenewt/controller";

// Card K01b: what the launcher wires when the host turns the built-in backup on: the real file-backed secret store holds the signing key, the secret values in use go into the encrypted backup (secrets only by default),
// and the owner's keyring beside the data is used. Test secrets are made at run time. The protected-file store needs POSIX permissions; on Windows (where the product uses the DPAPI store, which
// needs PowerShell) an in-memory store with the same calls stands in, so the launcher's wiring is still covered there.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const start = { facts, filesystem: ext4, features: [] } as const;
const fake = (label: string): string => `${label}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
const FAST = { N: 2 ** 16, r: 8, p: 1 } as const;
const allBytes = (dir: string): Buffer => Buffer.concat(readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name))));
const configFor = (dir: string): LauncherConfig => ({ installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {
  primary: { adapter: "openai-compatible", endpoint: "https://cloud.example.invalid/v1", credential: { secret: "provider-key" }, enabled: true, paid: false, models: ["m"] },
} } });

const memoryStore = (): { resolve(n: string): Promise<string | undefined>; set(n: string, v: string): Promise<void> } => { const m = new Map<string, string>(); return { resolve: async (n) => m.get(n), set: async (n, v) => { m.set(n, v); } }; };
const secretStore = (dir: string) => (process.platform === "win32" ? memoryStore() : protectedFileStore(dir));

test("the launcher signs every backup with a key in the real secret store, seals the secret values (secrets only by default) with the keyring beside the data, and never lets the key or a value into the folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-k01b-launch-")); const vault = mkdtempSync(join(tmpdir(), "nn-k01b-vault-"));
  try {
    const store = secretStore(join(vault, "secrets"));
    const providerKey = fake("provider");
    await store.set("provider-key", providerKey);
    const { keyring } = await createKeyring({ passcode: fake("pw"), scrypt: FAST });
    writeFileSync(join(dir, BACKUP_KEYRING_FILE), JSON.stringify(keyring), { mode: 0o600 });
    const l = await launch({ config: configFor(dir), secrets: store, argv: [], env: {}, print: () => undefined, start: { ...start, backup: { directory: join(dir, "backups") } } });
    try {
      const done = await l.controller.api.handle(l.ownerToken, { v: 1, op: "backup.now", commandId: "b1", args: {} } as never);
      assert.equal(done.ok, true, JSON.stringify(done));
      const name = readdirSync(join(dir, "backups")).filter((n) => n.startsWith("backup-")).sort().at(-1)!;
      const folder = join(dir, "backups", name);
      const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
      assert.equal(manifest.encryption.scope, "secrets", "secrets only is the default");
      assert.equal(manifest.secrets.count >= 1, true, "the provider key is carried, sealed");
      assert.equal(existsSync(join(folder, "signature.json")), true, "every backup is signed");
      const signingKey = await store.resolve(SIGNING_SECRET_NAME);
      assert.ok(signingKey !== undefined, "the signing key is in the secret store");
      const bytes = allBytes(folder);
      assert.equal(bytes.includes(providerKey), false);
      assert.equal(bytes.includes(signingKey!), false, "the private signing key is never in a backup");
      // The owner chooses everything in their own words (the chat sends this call).
      const wide = await l.controller.api.handle(l.ownerToken, { v: 1, op: "backup.encryption.set", commandId: "e1", args: { scope: "everything" } } as never);
      assert.equal(wide.ok, true, JSON.stringify(wide));
    } finally { await l.close(); }
    // Restarting changes nothing the owner chose.
    const again = await launch({ config: configFor(dir), secrets: store, argv: [], env: {}, print: () => undefined, start: { ...start, backup: { directory: join(dir, "backups") } } });
    try {
      const status = await again.controller.api.handle(again.ownerToken, { v: 1, op: "backup.encryption.status", args: {} } as never) as unknown as { result: { item: { setting: { scope: string } } } };
      assert.equal(status.result.item.setting.scope, "everything");
    } finally { await again.close(); }
  } finally { for (const d of [dir, vault]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("with no keyring beside the data the launcher's backups are plain but still signed, and the owner is told how to set encryption up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-k01b-launch2-")); const vault = mkdtempSync(join(tmpdir(), "nn-k01b-vault2-"));
  try {
    const store = secretStore(join(vault, "secrets"));
    await store.set("provider-key", fake("provider"));
    const lines: string[] = [];
    const l = await launch({ config: configFor(dir), secrets: store, argv: [], env: {}, print: (x) => lines.push(x), start: { ...start, backup: { directory: join(dir, "backups") } } });
    try {
      assert.ok(lines.some((x) => /written in plain.*encryption-setup/.test(x)), lines.join("\n"));
      assert.equal((await l.controller.api.handle(l.ownerToken, { v: 1, op: "backup.now", commandId: "b1", args: {} } as never)).ok, true);
      const name = readdirSync(join(dir, "backups")).filter((n) => n.startsWith("backup-")).sort().at(-1)!;
      const folder = join(dir, "backups", name);
      assert.equal(JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")).encryption, undefined);
      assert.equal(existsSync(join(folder, "signature.json")), true);
    } finally { await l.close(); }
  } finally { for (const d of [dir, vault]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

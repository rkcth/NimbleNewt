import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveSecrets, secretReferences } from "../secrets.js";
import { validateConfig } from "../config.js";
import { MAX_SECRET_BYTES, SecretStoreError, chooseSecretStore, linuxSecretServiceStore, macosKeychainStore, protectedFileStore, windowsDpapiStore, type SecretStore } from "./index.js";

const VALUE = "p@ss \"quoted\" 'single' $HOME `tick` \\back ünïcode ✓\nsecond line";

const exists = (program: string, args: string[]): boolean => { try { execFileSync(program, args, { stdio: "ignore", timeout: 10_000 }); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ENOENT" && program !== "never"; } };

/** What every store must do, whatever it keeps secrets in. */
function contract(label: string, make: () => Promise<{ store: SecretStore; done(): Promise<void> }>, skip: string | false): void {
  const t = (name: string, body: (store: SecretStore) => Promise<void>) => test(`${label}: ${name}`, { skip }, async () => { const { store, done } = await make(); try { await body(store); } finally { await done(); } });

  t("a secret is written and read back exactly, whatever characters it holds; set returns nothing", async (store) => {
    assert.equal(await store.set("api.key-1", VALUE), undefined);
    assert.equal(await store.resolve("api.key-1"), VALUE);
    assert.equal(await store.resolve("api.key-2"), undefined, "an absent secret is absent, not an error");
  });

  t("names that differ only in case, dots or dashes stay separate", async (store) => {
    await store.set("Abc.def", "one"); await store.set("abc.def", "two"); await store.set("abc-def", "three");
    assert.deepEqual([await store.resolve("Abc.def"), await store.resolve("abc.def"), await store.resolve("abc-def")], ["one", "two", "three"]);
  });

  t("a rotated secret is used from the next resolution, and a removed one is gone", async (store) => {
    await store.set("rot", "old"); assert.equal(await store.resolve("rot"), "old");
    await store.set("rot", "new"); assert.equal(await store.resolve("rot"), "new");
    assert.equal(await store.remove("rot"), true);
    assert.equal(await store.resolve("rot"), undefined);
    assert.equal(await store.remove("rot"), false);
  });

  t("configuration references resolve through it, and a missing one is named, never a value", async (store) => {
    const document = JSON.parse(await readFile(new URL("../../examples/private.example.json", import.meta.url), "utf8")) as unknown;
    const parsed = validateConfig(document);
    assert.equal(parsed.ok, true, JSON.stringify(parsed.ok ? [] : parsed.errors));
    if (!parsed.ok) return;
    const names = secretReferences(parsed.config).map((r) => r.name);
    assert.ok(names.length > 0, "the example refers to at least one secret");
    const missing = await resolveSecrets(parsed.config, store);
    assert.deepEqual(missing.ok ? [] : missing.missing.map((m) => m.name), names);
    for (const name of names) await store.set(name, "sk-test-value-1234567890");
    const found = await resolveSecrets(parsed.config, store);
    assert.equal(found.ok, true);
    assert.equal(found.ok ? found.secrets.get(names[0]!)!.reveal() : "", "sk-test-value-1234567890");
    for (const name of names) await store.remove(name);
  });

  t("the largest secret round-trips exactly", async (store) => {
    const biggest = "é".repeat(MAX_SECRET_BYTES / 2 - 1) + "ab";
    assert.equal(Buffer.byteLength(biggest, "utf8"), MAX_SECRET_BYTES);
    await store.set("big.one", biggest);
    assert.equal(await store.resolve("big.one"), biggest);
  });

  t("invalid names and values are refused without echoing the value", async (store) => {
    for (const name of ["", "a/b", "../x", "x__y", "1abc", "a".repeat(65), "con "]) await assert.rejects(() => store.set(name, "v"), (e) => e instanceof SecretStoreError && e.code === "invalid");
    await assert.rejects(() => store.set("ok", ""), (e) => e instanceof SecretStoreError && e.code === "invalid");
    await assert.rejects(() => store.set("ok", "x".repeat(20_000)), (e) => e instanceof SecretStoreError && !e.message.includes("xxxxxxxx"));
    await assert.rejects(() => store.resolve("../etc/passwd"), (e) => e instanceof SecretStoreError && e.code === "invalid");
  });

  t("check says whether the store can be used", async (store) => { const c = await store.check(); assert.equal(c.ok, true, c.detail); });
}

// ---- the permission-checked file store: runs wherever there are POSIX permissions --------------------------------------------------
const posix = process.platform !== "win32" && (typeof process.getuid !== "function" || process.getuid() !== 0) ? false : "needs POSIX permissions and a non-root user";
contract("protected files", async () => { const dir = await mkdtemp(join(tmpdir(), "nn-secrets-")); return { store: protectedFileStore(join(dir, "secrets")), done: () => rm(dir, { recursive: true, force: true }) }; }, posix);

test("protected files: owner-only on disk, widened permissions are refused by name, and no value is in any error", { skip: posix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-secrets-"));
  try {
    const store = protectedFileStore(join(dir, "secrets"));
    await store.set("tok.one", "supersecret-value-123");
    const files = await readdir(join(dir, "secrets"));
    assert.equal(files.length, 1);
    assert.ok(!files[0]!.includes("tok") && files[0]!.endsWith(".secret"), "names on disk are encoded");
    const { statSync } = await import("node:fs");
    assert.equal(statSync(join(dir, "secrets")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "secrets", files[0]!)).mode & 0o777, 0o600);
    await chmod(join(dir, "secrets", files[0]!), 0o644);
    await assert.rejects(() => store.resolve("tok.one"), (e) => e instanceof SecretStoreError && e.code === "unsafe" && e.reference === "tok.one" && /readable by other users|can be read by other users/.test(e.message) && !e.message.includes("supersecret"));
    await chmod(join(dir, "secrets", files[0]!), 0o600);
    assert.equal(await store.resolve("tok.one"), "supersecret-value-123");
    await chmod(join(dir, "secrets"), 0o755);
    await assert.rejects(() => store.resolve("tok.one"), (e) => e instanceof SecretStoreError && e.code === "unsafe");
    assert.deepEqual(await store.check(), { ok: false, detail: (await store.check()).detail });
    await chmod(join(dir, "secrets"), 0o700);
    // A file that is really a link is not trusted.
    await writeFile(join(dir, "elsewhere"), "decoy", { mode: 0o600 });
    const name = files[0]!;
    await rm(join(dir, "secrets", name)); await symlink(join(dir, "elsewhere"), join(dir, "secrets", name));
    await assert.rejects(() => store.resolve("tok.one"), (e) => e instanceof SecretStoreError && e.code === "unsafe" && /link/.test(e.message), "a link is never read through, even to a file the user owns");
    await rm(join(dir, "secrets", name));
    assert.equal(await store.resolve("tok.one"), undefined);
    assert.ok(!(await readFile(join(dir, "elsewhere"), "utf8")).includes("supersecret"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("protected files: a failed write leaves no partial file and the old value stays", { skip: posix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-secrets-"));
  try {
    const store = protectedFileStore(join(dir, "secrets"));
    await store.set("keep", "first");
    await assert.rejects(() => store.set("keep", ""), SecretStoreError);
    assert.equal(await store.resolve("keep"), "first");
    assert.deepEqual((await readdir(join(dir, "secrets"))).filter((f) => f.endsWith(".tmp")), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- macOS Keychain: a temporary keychain, so the tester's own is never touched --------------------------------------------------
const mac = process.platform === "darwin" ? false : "macOS only";
contract("macOS Keychain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-kc-"));
  const keychain = join(dir, "test.keychain-db");
  execFileSync("security", ["create-keychain", "-p", "pw", keychain]);
  execFileSync("security", ["set-keychain-settings", keychain]);
  execFileSync("security", ["unlock-keychain", "-p", "pw", keychain]);
  return { store: macosKeychainStore({ keychain, service: "nimblenewt-test" }), done: async () => { try { execFileSync("security", ["delete-keychain", keychain]); } catch { /* already gone */ } await rm(dir, { recursive: true, force: true }); } };
}, mac);

test("macOS Keychain: a locked keychain is reported as locked, by name, with no value", { skip: mac }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-kc-"));
  const keychain = join(dir, "locked.keychain-db");
  try {
    execFileSync("security", ["create-keychain", "-p", "pw", keychain]);
    const store = macosKeychainStore({ keychain, service: "nimblenewt-test" });
    execFileSync("security", ["unlock-keychain", "-p", "pw", keychain]);
    await store.set("locked.one", "hidden-value-987");
    execFileSync("security", ["lock-keychain", keychain]);
    await assert.rejects(() => store.resolve("locked.one"), (e) => e instanceof SecretStoreError && (e.code === "locked" || e.code === "unavailable") /* hosted runners differ in how a locked keychain answers */ && e.reference === "locked.one" && !e.message.includes("hidden-value"));
  } finally { try { execFileSync("security", ["delete-keychain", keychain]); } catch { /* gone */ } await rm(dir, { recursive: true, force: true }); }
});

// ---- Windows DPAPI --------------------------------------------------------------------------------------------------------------------
const win = process.platform === "win32" ? false : "Windows only";
contract("Windows DPAPI", async () => { const dir = await mkdtemp(join(tmpdir(), "nn-dpapi-")); return { store: windowsDpapiStore(join(dir, "secrets")), done: () => rm(dir, { recursive: true, force: true }) }; }, win);

test("Windows DPAPI: what is on disk is encrypted, and a damaged file is reported by name", { skip: win }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-dpapi-"));
  try {
    const store = windowsDpapiStore(join(dir, "secrets"));
    await store.set("tok.one", "plain-text-needle-4455");
    const [file] = await readdir(join(dir, "secrets"));
    assert.ok(!(await readFile(join(dir, "secrets", file!), "utf8")).includes("needle"));
    await writeFile(join(dir, "secrets", file!), "AAAA");
    await assert.rejects(() => store.resolve("tok.one"), (e) => e instanceof SecretStoreError && e.reference === "tok.one" && !e.message.includes("needle"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- Linux Secret Service: only where a session bus and secret-tool exist -------------------------------------------------------------
const lin = process.platform === "linux" && exists("secret-tool", ["--version"]) && process.env["DBUS_SESSION_BUS_ADDRESS"] !== undefined ? false : "needs secret-tool and a session bus";
contract("Linux Secret Service", async () => { const store = linuxSecretServiceStore({ service: "nimblenewt-test" }); return { store, done: async () => { for (const n of ["api.key-1", "Abc.def", "abc.def", "abc-def", "rot", "provider.main"]) await store.remove(n).catch(() => false); } }; }, lin);

// ---- store choice and honest failure -----------------------------------------------------------------------------------------------
test("the store for a host: Keychain on macOS, DPAPI on Windows, otherwise the Secret Service when it answers or the owner-only files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-choose-"));
  try {
    assert.equal((await chooseSecretStore({ dataDir: join(dir, "mac"), platform: "darwin" })).store.kind, "macos-keychain");
    assert.equal((await chooseSecretStore({ dataDir: join(dir, "win"), platform: "win32" })).store.kind, "windows-dpapi");
    const linux = await chooseSecretStore({ dataDir: dir, platform: "linux" });
    assert.ok(linux.store.kind === "linux-secret-service" || linux.store.kind === "protected-file");
    assert.ok(linux.reason.startsWith("Linux:"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the first choice of store is kept: a later start uses it, or fails naming it, and never quietly switches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-keep-"));
  try {
    const first = await chooseSecretStore({ dataDir: dir, platform: "linux" });
    const again = await chooseSecretStore({ dataDir: dir, platform: "linux" });
    assert.equal(again.store.kind, first.store.kind);
    assert.match(again.reason, /chose earlier/);
    assert.match(await readFile(join(dir, "secret-store.json"), "utf8"), new RegExp(first.store.kind));
    await writeFile(join(dir, "secret-store.json"), "{not json");
    await assert.rejects(() => chooseSecretStore({ dataDir: dir, platform: "linux" }), (e) => e instanceof SecretStoreError && /cannot be read/.test(e.message));
    // The record says a store this host cannot use: the start fails and names it.
    await writeFile(join(dir, "secret-store.json"), JSON.stringify({ kind: "windows-dpapi" }));
    await assert.rejects(() => chooseSecretStore({ dataDir: dir, platform: "linux" }), (e) => e instanceof SecretStoreError && /windows-dpapi/.test(e.message));
    // The Secret Service was chosen but is not there now: it is not replaced by the files.
    await writeFile(join(dir, "secret-store.json"), JSON.stringify({ kind: "linux-secret-service" }));
    if (!(await linuxSecretServiceStore().check()).ok) await assert.rejects(() => chooseSecretStore({ dataDir: dir, platform: "linux" }), (e) => e instanceof SecretStoreError && /linux-secret-service/.test(e.message) && /not replaced/.test(e.message));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a store whose tool is missing fails with a clear error naming the reference", async () => {
  const store = linuxSecretServiceStore({ service: "x" });
  const broken = { ...store, resolve: async (name: string) => { throw new SecretStoreError("unavailable", name, "`secret-tool` (libsecret) is not installed on this host"); } };
  await assert.rejects(() => broken.resolve("provider.main"), /secret "provider\.main": `secret-tool`/);
  const windowsBroken = windowsDpapiStore(join(tmpdir(), "nn-none"), { powershell: "definitely-not-a-program-xyz" });
  await assert.rejects(() => windowsBroken.set("provider.main", "v"), (e) => e instanceof SecretStoreError && e.reference === "provider.main" && e.code === "unavailable" && !e.message.includes("v\""));
  assert.equal((await windowsBroken.check()).ok, false);
});

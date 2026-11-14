import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startController } from "../api/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { NotificationService } from "../notifications/index.js";
import type { Principal } from "../security/principals.js";
import { PostgresStorage } from "../storage/postgres/index.js";
import { startTestServer, type TestServer } from "../storage/postgres/testing/server.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import type { ControllerStorage } from "../storage/index.js";
import { BackupEncryptionSettingService, BackupKeyPinService, SIGNING_SECRET_NAME, createKeyring, keyringFingerprint, type PinChange } from "./index.js";

// Card K01b, last slice: the default scope is "secrets only", signing is not optional where backups are encrypted, and replacing the backup key is announced. Test secrets are made at run time.

after(stopServer);
const owner = { kind: "owner", id: "owner:rob", grants: [] } as unknown as Principal;
const FAST = { N: 2 ** 16, r: 8, p: 1 } as const;
const AT = "2026-11-14T10:00:00.000Z";
const fake = (label: string): string => `${label}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const memory = () => { const m = new Map<string, string>(); return { m, resolve: async (n: string) => m.get(n), set: async (n: string, v: string) => { m.set(n, v); } }; };

async function epochOf(storage: ControllerStorage): Promise<number> { return (await storage.acquireEpoch({ holder: "t", at: AT })).epoch; }

for (const backend of backends) {
  test(`${backend.name}: the default scope is secrets only when the host gives the secret store, everything otherwise, and an installation that already sealed everything is never narrowed (card K01b)`, async () => {
    const a = await backend.open(); const b = await backend.open(); const c = await backend.open(); const d = await backend.open();
    try {
      const withSecrets = BackupEncryptionSettingService.withEpoch(a.storage, await epochOf(a.storage), { carriesSecrets: true });
      assert.deepEqual(await withSecrets.effective(), { enabled: true, scope: "secrets" }, "no record: secrets only");
      assert.match(withSecrets.text(await withSecrets.effective()), /secrets only/);
      assert.deepEqual(await withSecrets.initialize(false), { created: true, scope: "secrets" });
      assert.deepEqual(await withSecrets.initialize(false), { created: false, scope: "secrets" }, "recorded once");
      assert.equal((await withSecrets.get(owner)).revision, 1);
      // The owner chooses everything (the chat sends the same call): widening is not weaker, and a later start never moves it.
      const wide = await withSecrets.set(owner, { commandId: "w1", scope: "everything" });
      assert.deepEqual([wide.scope, wide.weaker, wide.changed], ["everything", false, true]);
      assert.deepEqual(await withSecrets.initialize(false), { created: false, scope: "everything" });
      // Without the secret store "secrets only" would seal nothing: the default is everything.
      const plainHost = BackupEncryptionSettingService.withEpoch(b.storage, await epochOf(b.storage), { carriesSecrets: false });
      assert.deepEqual(await plainHost.initialize(false), { created: true, scope: "everything" });
      // An installation that sealed everything before any setting was recorded keeps everything, even now that the host gives the secret store.
      const legacy = BackupEncryptionSettingService.withEpoch(c.storage, await epochOf(c.storage), { carriesSecrets: true });
      assert.deepEqual(await legacy.initialize(true), { created: true, scope: "everything" });
      assert.deepEqual(await legacy.effective(), { enabled: true, scope: "everything" });
      await assert.rejects(legacy.set(owner, { commandId: "l1", scope: "everything" }), /already/);
      const narrowed = await legacy.set(owner, { commandId: "l2", scope: "secrets" });
      assert.equal(narrowed.weaker, true, "only the owner's own word narrows it, and that is announced as weaker");
      // A record the owner made (off) is left alone by the start.
      const off = BackupEncryptionSettingService.withEpoch(d.storage, await epochOf(d.storage), { carriesSecrets: true });
      await off.set(owner, { commandId: "o1", enabled: false });
      assert.deepEqual(await off.initialize(false), { created: false, scope: "secrets" });
      assert.equal((await off.effective()).enabled, false);
    } finally { await a.close(); await b.close(); await c.close(); await d.close(); }
  });

  test(`${backend.name}: approving, withdrawing and replaying a new backup key tells the hooks once each and never carries key material (card K01b)`, async () => {
    const w = await backend.open();
    try {
      const first = (await createKeyring({ passcode: fake("pw"), scrypt: FAST })).keyring;
      const second = (await createKeyring({ passcode: fake("pw"), scrypt: FAST })).keyring;
      const pin = BackupKeyPinService.withEpoch(w.storage, await epochOf(w.storage));
      const told: PinChange[] = [];
      pin.onApproval(async (c) => { told.push(c); });
      await pin.check(first);
      const fp = keyringFingerprint(second);
      await pin.rekey(owner, { commandId: "r1", fingerprint: fp });
      await pin.rekey(owner, { commandId: "r1", fingerprint: fp });
      assert.equal(told.length, 1, "the same command again announces nothing");
      assert.deepEqual([told[0]!.approved, told[0]!.pinned, told[0]!.by], [fp, keyringFingerprint(first), "owner:rob"]);
      await pin.rekey(owner, { commandId: "r2", fingerprint: null });
      assert.equal(told.length, 2);
      assert.equal(told[1]!.approved, null);
      await pin.rekey(owner, { commandId: "r3", fingerprint: null });
      assert.equal(told.length, 2, "withdrawing what was never approved says nothing");
      const text = JSON.stringify(told);
      assert.ok(!/passcode|recovery|private/i.test(text.replace(/"approved"|"pinned"/g, "")), "no key material is in what the hooks get");
    } finally { await w.close(); }
  });

  test(`${backend.name}: a key switch stays marked until the owner was told, so a start cut off before its notice tells at the next one (card K01b review)`, async () => {
    const w = await backend.open();
    try {
      const first = (await createKeyring({ passcode: fake("pw"), scrypt: FAST })).keyring;
      const second = (await createKeyring({ passcode: fake("pw"), scrypt: FAST })).keyring;
      const pin = BackupKeyPinService.withEpoch(w.storage, await epochOf(w.storage));
      await pin.check(first);
      assert.equal(await pin.announceReplacement(async () => { throw new Error("must not be called"); }), false, "nothing to tell before a switch");
      await pin.rekey(owner, { commandId: "r1", fingerprint: keyringFingerprint(second) });
      assert.equal((await pin.check(second)).approved, true);
      await assert.rejects(pin.announceReplacement(async () => { throw new Error("inbox unavailable"); }), /inbox unavailable/);
      const told: { fingerprint: string; from: string; revision: number }[] = [];
      assert.equal(await pin.announceReplacement(async (r) => { told.push(r); }), true, "the failed notice is tried again");
      assert.deepEqual([told[0]!.fingerprint, told[0]!.from], [keyringFingerprint(second), keyringFingerprint(first)]);
      assert.equal(await pin.announceReplacement(async (r) => { told.push(r); }), false, "told once");
      assert.equal(told.length, 1);
      // Switching back to the first key and then to the second again is a new switch each time, with its own revision.
      await pin.rekey(owner, { commandId: "r2", fingerprint: keyringFingerprint(first) });
      await pin.check(first);
      await pin.announceReplacement(async (r) => { told.push(r); });
      await pin.rekey(owner, { commandId: "r3", fingerprint: keyringFingerprint(second) });
      await pin.check(second);
      await pin.announceReplacement(async (r) => { told.push(r); });
      assert.equal(told.length, 3);
      assert.equal(new Set(told.map((t) => t.revision)).size, 3, "each switch is its own notice");
      assert.equal(told[2]!.fingerprint, keyringFingerprint(second));
    } finally { await w.close(); }
  });
}

const PASS = fake("pass");
let server: Promise<TestServer> | undefined;
const pg = (): Promise<TestServer> => (server ??= startTestServer());
after(async () => { if (server !== undefined) await (await server).stop(); });

type Kind = "sqlite" | "postgres";
let n = 0;
async function rig(kind: Kind) {
  const d = mkdtempSync(join(tmpdir(), "nn-k01b-f3-"));
  const url = kind === "postgres" ? (await pg()).url() : "";
  const schema = `k01bf3_${process.pid}_${++n}`;
  const choice = () => (kind === "sqlite" ? { kind: "sqlite" as const, path: join(d, "c.sqlite") } : { kind: "postgres" as const, url, schema });
  const keyringFile = join(d, "keyring.json");
  const useKeyring = (k: unknown) => writeFileSync(keyringFile, JSON.stringify(k), { mode: 0o600 });
  const start = (backup: Record<string, unknown>) => startController({ storage: choice(), argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 }, backup: { directory: join(d, "backups"), ...backup } } as never);
  /** Pins a key before the controller ever ran with a setting record: an installation from before the setting existed. */
  const prePin = async (k: Parameters<typeof keyringFingerprint>[0]) => {
    const s = kind === "sqlite" ? await SqliteStorage.open({ path: join(d, "c.sqlite") }) : await PostgresStorage.open({ connectionString: url, schema });
    try { await BackupKeyPinService.withEpoch(s, await epochOf(s)).check(k); } finally { await s.close(); }
  };
  return { d, start, keyringFile, useKeyring, prePin };
}

const inboxOf = async (c: Awaited<ReturnType<typeof startController>>, token: string) => (await NotificationService.withEpoch(c.storage, c.epoch).inbox((await c.services.principals.authenticate(token))!)).items.filter((i) => i.ref.kind === "backup-encryption");

for (const kind of ["sqlite", "postgres"] as const) {
  test(`${kind}: a started controller refuses encrypted backups with no signing key store, and signs every backup when it has one (card K01b)`, async () => {
    const r = await rig(kind);
    try {
      r.useKeyring((await createKeyring({ passcode: PASS, scrypt: FAST })).keyring);
      await assert.rejects(r.start({ encryption: { keyringFile: r.keyringFile } }), /no secret store is given for the backup-signing key/);
      const store = memory();
      const c = await r.start({ encryption: { keyringFile: r.keyringFile }, signing: { store } });
      try {
        assert.ok(store.m.get(SIGNING_SECRET_NAME) !== undefined, "the key is made in the secret store");
        const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
        const done = await c.api.handle(boot.token, { v: 1, op: "backup.now", commandId: "b1", args: {} } as never) as { ok: boolean };
        assert.ok(done.ok);
        const status = await c.api.handle(boot.token, { v: 1, op: "backup.signing.status", args: {} } as never) as unknown as { result: { item: unknown } };
        assert.match(JSON.stringify(status.result.item), /keyId|generation/);
      } finally { await c.close(); }
    } finally { rmSync(r.d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });

  test(`${kind}: the first start records secrets only when the host gives the secret store, and a pinned installation with no recorded setting keeps everything (card K01b)`, async () => {
    const fresh = await rig(kind); const old = await rig(kind);
    try {
      const k1 = (await createKeyring({ passcode: PASS, scrypt: FAST })).keyring;
      fresh.useKeyring(k1);
      const store = memory(); store.m.set("models.providers.x.credential", fake("sk"));
      const c1 = await fresh.start({ encryption: { keyringFile: fresh.keyringFile }, signing: { store }, secrets: { store, names: () => ["models.providers.x.credential"] } });
      try {
        const boot = await c1.services.principals.bootstrapOwner({ name: "rob" });
        const st = (await c1.api.handle(boot.token, { v: 1, op: "backup.encryption.status", args: {} } as never)) as unknown as { result: { item: { setting: { scope: string } } } };
        assert.equal(st.result.item.setting.scope, "secrets");
      } finally { await c1.close(); }
      // A second start with the secret store missing does not move the scope (the record, not the host, decides).
      const c2 = await fresh.start({ encryption: { keyringFile: fresh.keyringFile }, signing: { store } });
      try {
        const set = BackupEncryptionSettingService.withEpoch(c2.storage, c2.epoch);
        assert.equal((await set.effective()).scope, "secrets");
      } finally { await c2.close(); }

      old.useKeyring(k1);
      await old.prePin(k1);
      const sealed = memory();
      const c3 = await old.start({ encryption: { keyringFile: old.keyringFile }, signing: { store: sealed }, secrets: { store: sealed, names: () => [] } });
      try {
        const set = BackupEncryptionSettingService.withEpoch(c3.storage, c3.epoch, { carriesSecrets: true });
        assert.equal((await set.effective()).scope, "everything", "an installation that already made encrypted backups is not narrowed");
        assert.equal((await set.get(owner)).changedBy, "controller");
      } finally { await c3.close(); }
    } finally { for (const r of [fresh, old]) rmSync(r.d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });

  test(`${kind}: approving a new backup key and the switch to it at the next start both reach the owner's inbox, with no key material (card K01b)`, async () => {
    const r = await rig(kind);
    try {
      const k1 = (await createKeyring({ passcode: PASS, scrypt: FAST })).keyring;
      const k2 = (await createKeyring({ passcode: fake("pw2"), scrypt: FAST })).keyring;
      r.useKeyring(k1);
      const store = memory();
      const c1 = await r.start({ encryption: { keyringFile: r.keyringFile }, signing: { store } });
      let token: string;
      try {
        token = (await c1.services.principals.bootstrapOwner({ name: "rob" })).token;
        assert.deepEqual((await inboxOf(c1, token)).filter((i) => /key/i.test(i.label)), [], "nothing before a change");
        const ok = await c1.api.handle(token, { v: 1, op: "backup.encryption.rekey", commandId: "rk1", args: { fingerprint: keyringFingerprint(k2) } } as never) as { ok: boolean };
        assert.ok(ok.ok);
        const approved = (await inboxOf(c1, token)).filter((i) => i.label === "A new backup key was approved");
        assert.equal(approved.length, 1);
        assert.match(JSON.stringify(approved), new RegExp(keyringFingerprint(k2).slice(0, 16)));
      } finally { await c1.close(); }
      r.useKeyring(k2);
      const c2 = await r.start({ encryption: { keyringFile: r.keyringFile }, signing: { store } });
      try {
        const items = await inboxOf(c2, token!);
        assert.equal(items.filter((i) => i.label === "The backup key was replaced").length, 1, JSON.stringify(items.map((i) => i.label)));
        const all = JSON.stringify(items);
        assert.ok(!all.includes(PASS) && !/recovery code|"privateKey"|wrapped/i.test(all), "no passcode or key material in the inbox");
      } finally { await c2.close(); }
      // A third start with the same key says nothing more.
      const c3 = await r.start({ encryption: { keyringFile: r.keyringFile }, signing: { store } });
      try {
        assert.equal((await inboxOf(c3, token!)).filter((i) => i.label === "The backup key was replaced").length, 1);
        // Back to the first key: that switch is announced too (its own notice, not a replay of the first switch's).
        assert.ok((await c3.api.handle(token!, { v: 1, op: "backup.encryption.rekey", commandId: "rk2", args: { fingerprint: keyringFingerprint(k1) } } as never) as { ok: boolean }).ok);
      } finally { await c3.close(); }
      r.useKeyring(k1);
      const c4 = await r.start({ encryption: { keyringFile: r.keyringFile }, signing: { store } });
      try { assert.ok((await c4.api.handle(token!, { v: 1, op: "backup.encryption.rekey", commandId: "rk3", args: { fingerprint: keyringFingerprint(k2) } } as never) as { ok: boolean }).ok); } finally { await c4.close(); }
      r.useKeyring(k2);
      const c5 = await r.start({ encryption: { keyringFile: r.keyringFile }, signing: { store } });
      try {
        const switched = (await inboxOf(c5, token!)).filter((i) => i.label === "The backup key was replaced");
        assert.ok(switched.length >= 1);
        assert.match(JSON.stringify(switched.at(-1)), new RegExp(keyringFingerprint(k2).slice(0, 16)), "the latest notice names the key now in use, not the one before");
      } finally { await c5.close(); }
    } finally { rmSync(r.d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
}

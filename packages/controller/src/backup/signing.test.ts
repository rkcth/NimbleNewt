import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStorage } from "../storage/index.js";
import type { Principal } from "../security/principals.js";
import { BackupSigningService, SIGNATURE_FILE, checkSignature, createBackup, createKeyring, generateSigningKey, signManifest, trustedKeyOf, unlockWithPasscode, verifyBackup, restoreBackup, manifestDigestOf, type SigningSecretStore, type SignatureTrust } from "./index.js";
import { runBackupCli } from "./cli.js";

const AT = "2026-10-29T10:00:00.000Z";
const FAST = { N: 2 ** 16, r: 8, p: 1 } as const;
const PASS = "correct horse battery staple";
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-sign-"));
const owner = { kind: "owner", id: "owner:rob", grants: [] } as unknown as Principal;
const agent = { kind: "agent", id: "agent:zed", grants: [] } as unknown as Principal;

async function populated(): Promise<{ storage: MemoryStorage; epoch: number }> {
  const s = new MemoryStorage();
  const { epoch } = await s.acquireEpoch({ holder: "c1", at: AT });
  await s.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "t" } }], audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
  return { storage: s, epoch };
}

function memoryStore(): SigningSecretStore & { values: Map<string, string>; failResolve: boolean; failSet: boolean } {
  const values = new Map<string, string>();
  const store = { values, failResolve: false, failSet: false, async resolve(name: string) { if (store.failResolve) throw new Error("locked"); return values.get(name); }, async set(name: string, value: string) { if (store.failSet) throw new Error("locked"); values.set(name, value); } };
  return store;
}
const trustOf = (publicKey: string, since?: string): SignatureTrust => ({ keys: [trustedKeyOf(publicKey)], ...(since === undefined ? {} : { since }) });

test("a signed backup verifies against a trusted key; a changed manifest, a missing, foreign or forged signature and a swapped signature file are all refused (card K01b3)", async () => {
  const d = tmp();
  try {
    const { storage } = await populated();
    const key = generateSigningKey();
    const other = generateSigningKey();
    const signer = { sign: async (m: Parameters<typeof signManifest>[0]) => signManifest(m, key.privateKey) };
    const a = await createBackup(storage, { root: d, kind: "manual", version: "1.0.0", now: () => new Date(AT), signer });
    assert.ok(existsSync(join(a.path, SIGNATURE_FILE)));
    // Valid: the plain statement says what that shows and does not.
    const ok = await verifyBackup(a.path, { signatureTrust: trustOf(key.publicKey) });
    assert.equal(ok.ok, true, JSON.stringify(ok.problems));
    assert.equal(ok.signature?.status, "valid");
    assert.match(ok.signature!.text, /only as strong as the running server/);
    // No trusted key given: still verifies, and says the signature was NOT checked.
    const unchecked = await verifyBackup(a.path);
    assert.equal(unchecked.ok, true);
    assert.equal(unchecked.signature?.status, "unchecked");
    assert.match(unchecked.signature!.text, /not checked/);
    // A key the restore does not trust.
    const foreign = await verifyBackup(a.path, { signatureTrust: trustOf(other.publicKey) });
    assert.equal(foreign.ok, false);
    assert.match(foreign.problems.join(), /do not trust/);
    // The manifest changed after signing (a note edited): the signature no longer matches.
    const manifestPath = join(a.path, "manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, original.replace('"kind": "manual"', '"kind": "scheduled"'));
    const changed = await verifyBackup(a.path, { signatureTrust: trustOf(key.publicKey) });
    assert.equal(changed.ok, false);
    assert.match(changed.problems.join(), /changed or forged/);
    writeFileSync(manifestPath, original);
    // A forger who signs with their own key and names the real key's ID still fails: the ID selects the trusted key, the math decides.
    const forged = { ...JSON.parse(readFileSync(join(a.path, SIGNATURE_FILE), "utf8")), signature: signManifest(a.manifest, other.privateKey).signature };
    writeFileSync(join(a.path, SIGNATURE_FILE), JSON.stringify(forged));
    assert.match((await verifyBackup(a.path, { signatureTrust: trustOf(key.publicKey) })).problems.join(), /changed or forged/);
    // A signature file that is not a signature, and one that is far too large.
    writeFileSync(join(a.path, SIGNATURE_FILE), "{not json");
    assert.match((await verifyBackup(a.path, { signatureTrust: trustOf(key.publicKey) })).problems.join(), /not valid/);
    writeFileSync(join(a.path, SIGNATURE_FILE), " ".repeat(10_000));
    assert.match((await verifyBackup(a.path, { signatureTrust: trustOf(key.publicKey) })).problems.join(), /not valid/);
    // Missing: refused on an installation that signs, unless the backup is older than the switch-on (then a warning).
    rmSync(join(a.path, SIGNATURE_FILE));
    assert.match((await verifyBackup(a.path, { signatureTrust: trustOf(key.publicKey, "2026-01-01T00:00:00.000Z") })).problems.join(), /not signed/);
    const older = await verifyBackup(a.path, { signatureTrust: trustOf(key.publicKey, "2026-12-01T00:00:00.000Z") });
    assert.equal(older.ok, true);
    assert.equal(older.signature?.status, "unsigned-before-signing");
    assert.match(older.signature!.text, /before backup signing was switched on/);
    assert.equal((await verifyBackup(a.path, { signatureTrust: trustOf(key.publicKey) })).ok, false, "with no switch-on time every backup must be signed");
    // A restore refuses what verification refuses, before it writes anything.
    const target = new MemoryStorage();
    await assert.rejects(restoreBackup(a.path, target, { signatureTrust: trustOf(key.publicKey) }), /not signed/);
    assert.equal(await target.currentEpoch(), 0, "nothing was written");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a signature binds the whole manifest, sealed or plain: a sealed backup's MAC and every file digest are under it (card K01b3)", async () => {
  const d = tmp();
  try {
    const { storage } = await populated();
    const key = generateSigningKey();
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const sealed = await createBackup(storage, { root: d, kind: "manual", version: "1.0.0", now: () => new Date(AT), encryption: keyring, signer: { sign: async (m) => signManifest(m, key.privateKey) } });
    const unlock = await unlockWithPasscode(keyring, PASS);
    const check = await verifyBackup(sealed.path, { unlock, signatureTrust: trustOf(key.publicKey) });
    assert.equal(check.ok, true, JSON.stringify(check.problems));
    // The signature needs no passcode: it is checked even by someone who cannot open the backup.
    assert.equal((await checkSignature(sealed.path, sealed.manifest, trustOf(key.publicKey))).status, "valid");
    // A different digest of the same backup is a different manifest digest (the owner's off-server check).
    assert.match(manifestDigestOf(sealed.manifest), /^[0-9a-f]{64}$/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the signing service keeps the private key only in the secret store, records the public key, rotates by the owner alone and keeps old keys trusted (card K01b3)", async () => {
  const { storage, epoch } = await populated();
  const store = memoryStore();
  const svc = BackupSigningService.withEpoch(storage, epoch, store);
  const rotated: string[] = [];
  svc.onRotated(async (e, by) => { rotated.push(`${e.generation}:${by}`); });
  const first = await svc.ensure();
  assert.equal(first.first, true);
  const privateKey = store.values.get("backup-signing-key")!;
  assert.ok(privateKey);
  // Restarting changes nothing and the private key is never in the record or the status.
  assert.deepEqual(await svc.ensure(), { keyId: first.keyId, first: false, changed: false });
  const status = await svc.status(owner);
  assert.equal(status.keys.length, 1);
  assert.equal(status.keys[0]!.keyId, first.keyId);
  assert.ok(!JSON.stringify(status).includes(privateKey));
  await assert.rejects(svc.status(agent), /forbidden|may not/);
  await assert.rejects(svc.rotate(agent, { commandId: "r0" }), /may not rotate/);
  assert.equal(store.values.get("backup-signing-key"), privateKey, "a refused rotation changes nothing");
  // A signature is made with the stored key; the record's trust opens it.
  const made = await createBackup(storage, { root: tmp(), kind: "manual", version: "1", now: () => new Date(AT), signer: svc });
  assert.equal((await checkSignature(made.path, made.manifest, await svc.trust())).status, "valid");
  // Rotation: stale revision refused; then a new key signs, the old one stays trusted for its backups.
  await assert.rejects(svc.rotate(owner, { commandId: "r1", expectedRevision: 99 }), /revision/);
  const r = await svc.rotate(owner, { commandId: "r2", expectedRevision: status.revision });
  assert.equal(r.generation, 2);
  assert.deepEqual(rotated, ["2:owner:rob"]);
  assert.notEqual(store.values.get("backup-signing-key"), privateKey);
  const trust = (await svc.trust())!;
  assert.equal(trust.keys.length, 2);
  assert.equal((await checkSignature(made.path, made.manifest, trust)).status, "valid", "the old backup still verifies");
  const later = await createBackup(storage, { root: tmp(), kind: "manual", version: "1", now: () => new Date("2026-10-30T10:00:00.000Z"), signer: svc });
  const s = JSON.parse(readFileSync(join(later.path, SIGNATURE_FILE), "utf8"));
  assert.equal(s.keyId, r.keyId);
  assert.equal((await svc.status(owner)).keys.filter((k) => k.retiredAt === undefined).length, 1);
});

test("the signer fails closed: a locked or empty secret store, or a key that is not the recorded current one, writes no backup at all (card K01b3)", async () => {
  const { storage, epoch } = await populated();
  const store = memoryStore();
  const svc = BackupSigningService.withEpoch(storage, epoch, store);
  await svc.ensure();
  const root = tmp();
  try {
    store.failResolve = true;
    await assert.rejects(createBackup(storage, { root, kind: "manual", version: "1", now: () => new Date(AT), signer: svc }), /cannot be read/);
    assert.deepEqual(existsSync(root) ? readdirSync(root) : [], [], "no backup and no partial folder is left");
    store.failResolve = false;
    // The store holds some other valid key than the one recorded: refused (a swapped secret signs nothing).
    const real = store.values.get("backup-signing-key")!;
    store.values.set("backup-signing-key", generateSigningKey().privateKey);
    await assert.rejects(createBackup(storage, { root, kind: "manual", version: "1", now: () => new Date(AT), signer: svc }), /not the current one/);
    store.values.delete("backup-signing-key");
    await assert.rejects(createBackup(storage, { root, kind: "manual", version: "1", now: () => new Date(AT), signer: svc }), /missing/);
    // A start with a locked store stops; with a foreign key it records a new generation and says so; with a retired key it refuses.
    store.values.set("backup-signing-key", real);
    store.failResolve = true;
    await assert.rejects(svc.ensure(), /cannot be read/);
    store.failResolve = false;
    const foreign = generateSigningKey();
    store.values.set("backup-signing-key", foreign.privateKey);
    const swapped = await svc.ensure();
    assert.deepEqual([swapped.keyId === foreign.keyId, swapped.changed], [true, true]);
    assert.equal((await svc.status(owner)).keys.length, 2);
    store.values.set("backup-signing-key", real);
    await assert.rejects(svc.ensure(), /retired/);
    store.values.set("backup-signing-key", "not a key");
    await assert.rejects(svc.ensure(), /not a valid Ed25519 key/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the command line checks a signature against a public key file the owner kept, and a manifest digest kept off the server; without them it says the signature was not checked (card K01b3)", async () => {
  const d = tmp();
  try {
    const { storage } = await populated();
    const key = generateSigningKey();
    const other = generateSigningKey();
    const a = await createBackup(storage, { root: d, kind: "manual", version: "1.0.0", now: () => new Date(AT), signer: { sign: async (m) => signManifest(m, key.privateKey) } });
    const say = async (...argv: string[]) => { const out: string[] = []; const code = await runBackupCli(argv, (l) => out.push(l)); return { code, out: out.join("\n") }; };
    const good = join(d, "trusted.txt"); writeFileSync(good, `# the server's signing key\n${key.publicKey}\n`);
    const wrong = join(d, "wrong.txt"); writeFileSync(wrong, `${other.publicKey}\n`);
    const empty = join(d, "empty.txt"); writeFileSync(empty, "# nothing\n");
    const junk = join(d, "junk.txt"); writeFileSync(junk, "AAAA\n");
    const plain = await say("verify", a.path);
    assert.equal(plain.code, 0);
    assert.match(plain.out, /signature was not checked/);
    assert.ok(plain.out.includes(manifestDigestOf(a.manifest)), "the digest is printed so the owner can keep it off the server");
    const yes = await say("verify", a.path, "--trusted-signing-key-file", good);
    assert.equal(yes.code, 0, yes.out);
    assert.match(yes.out, /Signature valid/);
    const no = await say("verify", a.path, "--trusted-signing-key-file", wrong);
    assert.equal(no.code, 1);
    assert.match(no.out, /do not trust/);
    assert.equal((await say("verify", a.path, "--trusted-signing-key-file", empty)).code, 1);
    assert.match((await say("verify", a.path, "--trusted-signing-key-file", junk)).out, /not an Ed25519 public key/);
    assert.match((await say("verify", a.path, "--trusted-signing-key-file", join(d, "absent"))).out, /cannot be read/);
    // The kept digest: the right one passes, another is refused.
    assert.equal((await say("verify", a.path, "--manifest-digest", manifestDigestOf(a.manifest))).code, 0);
    assert.match((await say("verify", a.path, "--manifest-digest", "0".repeat(64))).out, /not the one you gave/);
    // A restore with a trusted key restores and says what the signature shows; with a wrong key it writes nothing.
    const db = join(d, "restored.sqlite");
    const bad = await say("restore", a.path, "--sqlite", join(d, "no.sqlite"), "--trusted-signing-key-file", wrong);
    assert.equal(bad.code, 1);
    const restored = await say("restore", a.path, "--sqlite", db, "--trusted-signing-key-file", good, "--manifest-digest", manifestDigestOf(a.manifest));
    assert.equal(restored.code, 0, restored.out);
    assert.match(restored.out, /Signature valid/);
    assert.equal((await say("restore", a.path, "--sqlite", join(d, "r2.sqlite"), "--manifest-digest", "f".repeat(64))).code, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

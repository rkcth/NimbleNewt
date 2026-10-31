import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileBlobStore } from "../artifacts/index.js";
import { MemoryStorage } from "../storage/index.js";
import { BackupEncryption, ProofRefused, UnlockFailed, parseKeyring, PasscodeRefused, createBackup, createKeyring, restoreBackup, unlockWithPasscode, unlockWithRecovery, verifyBackup, type Keyring } from "./index.js";
import { CHUNK_BYTES, SealedFileBad, beginSeal, openSink, readPlain, type BackupCipher } from "./crypto.js";
import { runBackupCli } from "./cli.js";

const AT = "2026-10-29T10:00:00.000Z";
const PASS = "correct horse battery staple";
const FAST = { N: 2 ** 16, r: 8, p: 1 } as const; // the floor, to keep the tests quick
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-enc-"));
const SECRET_TITLE = "the-secret-title-café-7731";

async function populated(): Promise<MemoryStorage> {
  const s = new MemoryStorage();
  const { epoch } = await s.acquireEpoch({ holder: "c1", at: AT });
  await s.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: SECRET_TITLE } }], audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
  return s;
}
const allBytes = (dir: string): Buffer => Buffer.concat(readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name))));
const names = (dir: string): string => readdirSync(dir, { recursive: true }).join("\n");

test("a wrong passcode or the wrong recovery file never opens the key, with one plain message; a weak passcode is refused (card K01b)", async () => {
  const { keyring, recoveryFile } = await createKeyring({ passcode: PASS, scrypt: FAST });
  await unlockWithPasscode(keyring, PASS);
  await assert.rejects(unlockWithPasscode(keyring, "correct horse battery stapl3"), (e: unknown) => e instanceof UnlockFailed && !/stapl3|scrypt|tag|auth/i.test(e.message));
  const other = await createKeyring({ passcode: PASS, scrypt: FAST });
  assert.throws(() => unlockWithRecovery(keyring, other.recoveryFile), UnlockFailed);
  assert.throws(() => unlockWithRecovery(keyring, { ...recoveryFile, recoveryKey: other.recoveryFile.recoveryKey }), UnlockFailed);
  unlockWithRecovery(keyring, recoveryFile);
  await assert.rejects(createKeyring({ passcode: "short", scrypt: FAST }), PasscodeRefused);
  await assert.rejects(createKeyring({ passcode: "aaaaaaaaaaaaaaaa", scrypt: FAST }), PasscodeRefused);
  await assert.rejects(createKeyring({ passcode: PASS, scrypt: { N: 2 ** 10, r: 8, p: 1 } }));
  // A keyring asking for tiny or enormous work is refused before any derivation (no downgrade, no memory bomb).
  // It is refused as a bad key record (not as a failed unlock): the check happens before any derivation, so nothing was spent.
  for (const N of [2 ** 10, 2 ** 15, 2 ** 19, 2 ** 20, 2 ** 24]) await assert.rejects(unlockWithPasscode({ ...keyring, wrappers: keyring.wrappers.map((w) => w.kind === "passcode" ? { ...w, kdf: { ...w.kdf, N } } : w) } as Keyring, PASS), (e: unknown) => e instanceof SealedFileBad && /key derivation settings/.test(e.message), `N=${N}`);
  // The ceiling is 2^18: a keyring at the ceiling is read, one above is not.
  parseKeyring({ ...keyring, wrappers: keyring.wrappers.map((w) => w.kind === "passcode" ? { ...w, kdf: { ...w.kdf, N: 2 ** 18 } } : w) });
});

test("an encrypted backup holds nothing readable, restores with the passcode or the recovery file alone, and is not verified without one (card K01b)", async () => {
  const root = tmp(); const live = tmp(); const fresh = [tmp(), tmp(), tmp()];
  try {
    const { keyring, recoveryFile } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const blobs = await FileBlobStore.open({ directory: live });
    const put = await blobs.put(new TextEncoder().encode("blob-plan-text-5521"));
    const { path, manifest } = await createBackup(await populated(), { root, kind: "manual", version: "t", now: () => new Date(AT), blobs, encryption: keyring });
    assert.equal(manifest.encryption?.keyId, keyring.keyId);
    const bytes = allBytes(path).toString("latin1");
    for (const secret of [SECRET_TITLE, "cafÃ©", "blob-plan-text-5521", PASS, recoveryFile.recoveryKey, put.digest]) assert.ok(!bytes.includes(secret), `${secret} is on disk`);
    assert.ok(!names(path).includes(put.digest), "a blob is not named by its content digest");
    assert.ok(!/privateKey|pkcs8/i.test(bytes));

    const locked = await verifyBackup(path);
    assert.equal(locked.ok, false);
    assert.match(locked.problems.join(), /encrypted/);
    await assert.rejects(restoreBackup(path, new MemoryStorage()), /encrypted/);

    const byPass = await unlockWithPasscode(manifest.encryption!.keyring, PASS);
    assert.equal((await verifyBackup(path, { unlock: byPass })).ok, true);
    const t1 = new MemoryStorage(); const b1 = await FileBlobStore.open({ directory: fresh[0]! });
    const r1 = await restoreBackup(path, t1, { unlock: byPass, blobs: b1 });
    assert.equal(r1.blobsRestored, 1);
    assert.equal((await t1.getAggregate({ kind: "task", id: "task-a" }))?.body["title"], SECRET_TITLE);
    assert.equal(readFileSync(b1.pathOf(put.digest), "utf8"), "blob-plan-text-5521", "the blob came back with the same bytes");
    // The recovery file alone does the same on a new machine from the backup alone.
    const t2 = new MemoryStorage(); const b2 = await FileBlobStore.open({ directory: fresh[1]! });
    await restoreBackup(path, t2, { unlock: unlockWithRecovery(manifest.encryption!.keyring, recoveryFile), blobs: b2 });
    assert.equal((await t2.getAggregate({ kind: "task", id: "task-a" }))?.body["title"], SECRET_TITLE);
    // A key for another backup key is refused.
    const other = await createKeyring({ passcode: PASS, scrypt: FAST });
    const wrongKey = await unlockWithPasscode(other.keyring, PASS);
    assert.equal((await verifyBackup(path, { unlock: wrongKey })).ok, false);
    // A plain backup is refused when encryption is required (a plain copy swapped in for an encrypted one).
    const plain = await createBackup(await populated(), { root: tmp(), kind: "manual", version: "t", now: () => new Date(AT) });
    assert.equal((await verifyBackup(plain.path, { requireEncrypted: true })).ok, false);
    assert.equal((await verifyBackup(plain.path)).ok, true);
  } finally { for (const d of [root, live, ...fresh]) rmSync(d, { recursive: true, force: true }); }
});

test("a changed byte, a swapped or removed file, a cut-short file and a changed key record are all caught (card K01b)", async () => {
  const root = tmp();
  try {
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const { path, manifest } = await createBackup(await populated(), { root, kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring });
    const key = await unlockWithPasscode(manifest.encryption!.keyring, PASS);
    assert.equal((await verifyBackup(path, { unlock: key })).ok, true);
    const file = join(path, "aggregates.jsonl.enc"); const audit = join(path, "audit.jsonl.enc");
    const original = readFileSync(file); const otherOriginal = readFileSync(audit);
    const flipped = Buffer.from(original); flipped[flipped.length - 20]! ^= 1;
    writeFileSync(file, flipped);
    assert.equal((await verifyBackup(path, { unlock: key })).ok, false, "a flipped byte");
    writeFileSync(file, otherOriginal); writeFileSync(audit, original);
    assert.equal((await verifyBackup(path, { unlock: key })).ok, false, "two files swapped");
    writeFileSync(file, original); writeFileSync(audit, otherOriginal);
    writeFileSync(file, original.subarray(0, original.length - 3));
    assert.equal((await verifyBackup(path, { unlock: key })).ok, false, "cut short");
    writeFileSync(file, original);
    // A manifest that names another key, or has its ephemeral key replaced, does not open.
    const mf = join(path, "manifest.json"); const m = JSON.parse(readFileSync(mf, "utf8"));
    writeFileSync(mf, JSON.stringify({ ...m, encryption: { ...m.encryption, ephemeral: beginSeal(keyring).seal.ephemeral } }));
    assert.equal((await verifyBackup(path, { unlock: key })).ok, false, "ephemeral key replaced");
    writeFileSync(mf, JSON.stringify({ ...m, encryption: { ...m.encryption, keyId: "other" } }));
    assert.equal((await verifyBackup(path, { unlock: key })).ok, false, "key id changed");
    // The tampering did not need the key to be refused for a changed wrapper: a changed wrapped key never unlocks.
    const w = m.encryption.keyring.wrappers.map((x: { wrapped: string }) => ({ ...x, wrapped: x.wrapped.replace(/^./, (c) => c === "A" ? "B" : "A") }));
    await assert.rejects(unlockWithPasscode({ ...m.encryption.keyring, wrappers: w }, PASS), UnlockFailed);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sealed files are checked chunk by chunk: cutting a whole chunk or reordering chunks is detected (card K01b)", async () => {
  const d = tmp();
  try {
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const { cipher } = beginSeal(keyring);
    const sink = await openSink(join(d, "f.enc"), cipher, "f.enc");
    const data = Buffer.alloc(CHUNK_BYTES * 3, 7);
    await sink.write(data); await sink.finish();
    const read = async (label = "f.enc", c: BackupCipher = cipher): Promise<number> => { let n = 0; for await (const b of readPlain(join(d, "f.enc"), c, label)) n += b.length; return n; };
    assert.equal(await read(), data.length);
    await assert.rejects(read("g.enc"), "a file moved under another name");
    const whole = readFileSync(join(d, "f.enc")); const head = 22; const step = CHUNK_BYTES + 16;
    writeFileSync(join(d, "f.enc"), whole.subarray(0, head + 2 * step)); // the last chunk removed at a chunk boundary
    await assert.rejects(read(), /changed or is not complete/);
    writeFileSync(join(d, "f.enc"), Buffer.concat([whole.subarray(0, head), whole.subarray(head + step, head + 2 * step), whole.subarray(head, head + step), whole.subarray(head + 2 * step)]));
    await assert.rejects(read(), /changed or is not complete/);
    // An empty file is a sealed empty file, not an absent one.
    const e = await openSink(join(d, "e.enc"), cipher, "e.enc"); await e.finish();
    let n = 0; for await (const b of readPlain(join(d, "e.enc"), cipher, "e.enc")) n += b.length;
    assert.equal(n, 0); truncateSync(join(d, "e.enc"), statSync(join(d, "e.enc")).size - 1);
    await assert.rejects((async () => { for await (const _ of readPlain(join(d, "e.enc"), cipher, "e.enc")); })());
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the proof reads the secret from a host file, is rate limited, one at a time, and puts no secret in its answers (card K01b)", async () => {
  const d = tmp();
  try {
    const { keyring, recoveryFile } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const pf = join(d, "pass"); const rf = join(d, "rec");
    writeFileSync(pf, `${PASS}\n`, { mode: 0o600 }); writeFileSync(rf, JSON.stringify(recoveryFile), { mode: 0o600 });
    let t = Date.parse(AT);
    const enc = new BackupEncryption({ keyring, passcodeFile: pf, recoveryFile: rf, now: () => new Date(t), minIntervalMs: 10_000 });
    assert.equal((await enc.verify("passcode")).ok, true);
    await assert.rejects(enc.verify("recovery"), (e: unknown) => e instanceof ProofRefused && e.code === "rate_limited");
    t += 11_000;
    assert.equal((await enc.verify("recovery")).ok, true);
    t += 11_000;
    writeFileSync(pf, "wrong wrong wrong wrong\n");
    await assert.rejects(enc.verify("passcode"), (e: unknown) => e instanceof ProofRefused && e.code === "failed" && !e.message.includes("wrong"));
    assert.equal(enc.status().lastProof?.ok, false);
    t += 11_000; chmodSync(pf, 0o644);
    await assert.rejects(enc.verify("passcode"), (e: unknown) => e instanceof ProofRefused && /mode to 600/.test(e.message));
    t += 11_000; chmodSync(pf, 0o600); writeFileSync(pf, `${PASS}\n`);
    const concurrent = await Promise.allSettled([enc.verify("passcode"), enc.verify("passcode")]);
    assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1, "two at once: one runs");
    const shown = JSON.stringify(enc.status());
    for (const secret of [PASS, recoveryFile.recoveryKey]) assert.ok(!shown.includes(secret));
    assert.ok(!shown.includes(keyring.wrappers[0]!.kind === "passcode" ? (keyring.wrappers[0] as { wrapped: string }).wrapped : "x"), "no wrapped key material in the status");
    const noFile = new BackupEncryption({ keyring, now: () => new Date(t += 20_000) });
    await assert.rejects(noFile.verify("passcode"), (e: unknown) => e instanceof ProofRefused && e.code === "not_supplied");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the command line sets encryption up from files, proves both ways in, and restores from the passcode or the recovery file alone (card K01b)", async () => {
  const d = tmp();
  try {
    const out: string[] = [];
    const run = async (...argv: string[]): Promise<number> => { out.length = 0; return runBackupCli(argv, (l) => { out.push(l); }); };
    const pf = join(d, "pass"); writeFileSync(pf, `${PASS}\n`, { mode: 0o600 });
    const keyringFile = join(d, "keyring.json"); const recoveryOut = join(d, "recovery.json");
    assert.equal(await run("encryption-setup", keyringFile, "--passcode-file", pf, "--recovery-out", recoveryOut), 0, out.join("\n"));
    assert.ok(!out.join("\n").includes(PASS) && !out.join("\n").includes(JSON.parse(readFileSync(recoveryOut, "utf8")).recoveryKey));
    assert.equal(statSync(recoveryOut).mode & 0o077, 0);
    assert.equal(await run("encryption-setup", keyringFile, "--passcode-file", pf, "--recovery-out", recoveryOut), 1, "does not overwrite");
    const weak = join(d, "weak"); writeFileSync(weak, "short\n", { mode: 0o600 });
    assert.equal(await run("encryption-setup", join(d, "k2.json"), "--passcode-file", weak, "--recovery-out", join(d, "r2.json")), 1);
    const loose = join(d, "loose"); writeFileSync(loose, `${PASS}\n`, { mode: 0o644 });
    assert.equal(await run("encryption-setup", join(d, "k3.json"), "--passcode-file", loose, "--recovery-out", join(d, "r3.json")), 1, "a passcode file others can read");
    const keyring = JSON.parse(readFileSync(keyringFile, "utf8")) as Keyring;
    assert.equal((keyring.wrappers.length), 2);
    const root = join(d, "backups");
    const { path } = await createBackup(await populated(), { root, kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring });
    assert.equal(await run("verify", path), 1);
    assert.match(out.join("\n"), /encrypted/);
    assert.equal(await run("verify", path, "--passcode-file", pf), 0, out.join("\n"));
    assert.equal(await run("verify", path, "--recovery-file", recoveryOut), 0, out.join("\n"));
    const bad = join(d, "bad"); writeFileSync(bad, "not the passcode at all\n", { mode: 0o600 });
    assert.equal(await run("verify", path, "--passcode-file", bad), 1);
    assert.ok(!out.join("\n").includes("not the passcode"));
    assert.equal(await run("restore", path, "--passcode-file", pf, "--sqlite", join(d, "new.sqlite")), 0, out.join("\n"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

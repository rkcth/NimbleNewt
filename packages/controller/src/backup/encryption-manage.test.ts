import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStorage } from "../storage/index.js";
import { BackupEncryption, BackupProofStore, PasscodeRefused, RecoveryCodeInvalid, SealedFileBad, UnlockFailed, addPasscode, createBackup, createKeyring, keyringFingerprint, parseKeyring, recoveryCodeOf, recoveryKeyFromCode, rotateKeyring, unlockWithPasscode, unlockWithRecovery, unlockWithRecoveryCode, verifyBackup, type Keyring } from "./index.js";
import { runBackupCli } from "./cli.js";

const AT = "2026-10-29T10:00:00.000Z";
const PASS = "correct horse battery staple";
const PASS2 = "second passcode for the household";
const PASS3 = "third passcode that one is too many";
const FAST = { N: 2 ** 16, r: 8, p: 1 } as const;
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-mgmt-"));
async function populated(): Promise<MemoryStorage> {
  const s = new MemoryStorage();
  const { epoch } = await s.acquireEpoch({ holder: "c1", at: AT });
  await s.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "t" } }], audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
  return s;
}

test("a printable recovery code carries the whole 256-bit key, has a checksum, reads I L O as digits and opens the key (card K01b)", async () => {
  const { keyring, recoveryFile } = await createKeyring({ passcode: PASS, scrypt: FAST });
  const code = recoveryCodeOf(recoveryFile);
  assert.match(code, /^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
  assert.equal(recoveryKeyFromCode(code), recoveryFile.recoveryKey);
  assert.equal(recoveryKeyFromCode(code.toLowerCase().replaceAll("-", " ")), recoveryFile.recoveryKey);
  unlockWithRecoveryCode(keyring, code);
  // Crockford has no I, L, O or U: a typed I or L is read as 1 and an O as 0, so a code with those characters swapped for lookalikes still opens.
  const looks = code.replaceAll("1", "l").replaceAll("0", "o");
  unlockWithRecoveryCode(keyring, looks);
  // Any single changed character fails the checksum (never reaches an unlock attempt) with fixed text that does not repeat the code.
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === "-") continue;
    const other = code[i] === "2" ? "3" : "2";
    assert.throws(() => recoveryKeyFromCode(code.slice(0, i) + other + code.slice(i + 1)), (e: unknown) => e instanceof RecoveryCodeInvalid && !e.message.includes(code.slice(0, 8)), `position ${i}`);
  }
  for (const bad of ["", "ABCD", `${code}-AAAA`, code.slice(0, -5), "x".repeat(500)]) assert.throws(() => recoveryKeyFromCode(bad), RecoveryCodeInvalid);
  // A code of another key does not open this one.
  const other = await createKeyring({ passcode: PASS, scrypt: FAST });
  assert.throws(() => unlockWithRecoveryCode(keyring, recoveryCodeOf(other.recoveryFile)), UnlockFailed);
  unlockWithRecovery(keyring, recoveryFile);
});

test("an extra passcode is another wrapper of the same key; a third, a duplicate and a weak one are refused (card K01b)", async () => {
  const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
  const key = await unlockWithPasscode(keyring, PASS);
  await assert.rejects(addPasscode(key, PASS), PasscodeRefused);
  await assert.rejects(addPasscode(key, "short"), PasscodeRefused);
  const two = await addPasscode(key, PASS2, { scrypt: FAST });
  assert.equal(two.keyId, keyring.keyId);
  assert.equal(keyringFingerprint(two), keyringFingerprint(keyring));
  assert.equal(two.wrappers.filter((w) => w.kind === "passcode").length, 2);
  await unlockWithPasscode(two, PASS); await unlockWithPasscode(two, PASS2);
  await assert.rejects(addPasscode(await unlockWithPasscode(two, PASS2), PASS3), PasscodeRefused);
  // The parameters are stored with the wrapper (here the floor), and the record is still a valid key record.
  assert.equal(parseKeyring(two).wrappers.length, 3);
});

test("rotation makes a new key for later backups: a removed passcode opens only the older ones, which carry their own key record (card K01b)", async () => {
  const root = tmp();
  try {
    const first = await createKeyring({ passcode: PASS, morePasscodes: [PASS2], scrypt: FAST });
    const old = await createBackup(await populated(), { root, kind: "manual", version: "t", now: () => new Date("2026-10-29T10:00:00.000Z"), encryption: first.keyring });
    // PASS2 is exposed: rotate with PASS alone (the owner opens the old key with the old recovery file, to show they hold it).
    const key = unlockWithRecovery(first.keyring, first.recoveryFile);
    const second = await rotateKeyring({ current: key, passcodes: [PASS], scrypt: FAST });
    assert.equal(second.keyring.generation, 2);
    assert.equal(second.keyring.previousKeyId, first.keyring.keyId);
    assert.notEqual(second.keyring.keyId, first.keyring.keyId);
    assert.notEqual(keyringFingerprint(second.keyring), keyringFingerprint(first.keyring));
    const fresh = await createBackup(await populated(), { root, kind: "manual", version: "t", now: () => new Date("2026-10-30T10:00:00.000Z"), encryption: second.keyring });
    // The removed passcode and the old recovery file open nothing new, and the new passcode and recovery file open nothing old.
    await assert.rejects(unlockWithPasscode(second.keyring, PASS2), UnlockFailed);
    assert.throws(() => unlockWithRecovery(second.keyring, first.recoveryFile), UnlockFailed);
    const sealNew = (await import("./verify.js")).readManifest(fresh.path);
    const sealOld = (await import("./verify.js")).readManifest(old.path);
    assert.equal((await sealNew).manifest?.encryption?.keyId, second.keyring.keyId);
    assert.equal((await sealOld).manifest?.encryption?.keyId, first.keyring.keyId);
    assert.equal((await verifyBackup(fresh.path, { unlock: await unlockWithPasscode(second.keyring, PASS) })).ok, true);
    assert.equal((await verifyBackup(fresh.path, { unlock: unlockWithRecovery(second.keyring, second.recoveryFile) })).ok, true);
    // The older backup is still opened by what existed then, from its own key record: both passcodes, the old recovery file.
    for (const open of [await unlockWithPasscode((await sealOld).manifest!.encryption!.keyring, PASS2), unlockWithRecovery((await sealOld).manifest!.encryption!.keyring, first.recoveryFile)]) assert.equal((await verifyBackup(old.path, { unlock: open })).ok, true);
    // …and a key of the new generation does not open the old backup.
    assert.equal((await verifyBackup(old.path, { unlock: await unlockWithPasscode(second.keyring, PASS) })).ok, false);
    // Rotation needs at least one passcode and no more than the key may carry.
    await assert.rejects(rotateKeyring({ current: key, passcodes: [] }), PasscodeRefused);
    await assert.rejects(rotateKeyring({ current: key, passcodes: [PASS, PASS2, PASS3], scrypt: FAST }), PasscodeRefused);
    await assert.rejects(rotateKeyring({ current: key, passcodes: [PASS, PASS], scrypt: FAST }), PasscodeRefused);
    // A forged generation number is refused by the reader.
    assert.throws(() => parseKeyring({ ...second.keyring, generation: -4 } as Keyring), SealedFileBad);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the command line adds a passcode and rotates the key, proves the new methods, keeps the old generation and prints no secret (card K01b)", { timeout: 120_000 }, async () => {
  const d = tmp();
  try {
    const out: string[] = [];
    const run = async (...argv: string[]): Promise<number> => { out.length = 0; return runBackupCli(argv, (l) => { out.push(l); }); };
    const put = (name: string, text: string): string => { const f = join(d, name); writeFileSync(f, `${text}\n`, { mode: 0o600 }); return f; };
    const pf = put("pass", PASS); const keyringFile = join(d, "keyring.json"); const rec1 = join(d, "rec1.json"); const code1 = join(d, "code1.txt");
    assert.equal(await run("encryption-setup", keyringFile, "--passcode-file", pf, "--recovery-out", rec1, "--recovery-code-out", code1), 0, out.join("\n"));
    const code = readFileSync(code1, "utf8").trim();
    const k1 = JSON.parse(readFileSync(keyringFile, "utf8")) as Keyring;
    // Add a passcode, authorised by the printed recovery code.
    assert.equal(await run("encryption-add-passcode", keyringFile, "--recovery-code-file", code1, "--new-passcode-file", put("p2", PASS2)), 0, out.join("\n"));
    const k2 = JSON.parse(readFileSync(keyringFile, "utf8")) as Keyring;
    assert.equal(k2.keyId, k1.keyId); assert.equal(k2.wrappers.length, 3);
    assert.ok(!out.join("\n").includes(PASS2));
    // Without showing a way to open the key nothing changes; a wrong passcode changes nothing either.
    assert.equal(await run("encryption-add-passcode", keyringFile, "--new-passcode-file", put("p3", PASS3)), 1);
    assert.equal(await run("encryption-add-passcode", keyringFile, "--passcode-file", put("wrong", "not the passcode at all"), "--new-passcode-file", put("p3b", PASS3)), 1);
    assert.equal(readFileSync(keyringFile, "utf8"), `${JSON.stringify(k2, null, 2)}\n`);
    // Rotate, keeping only the first passcode (the second was exposed).
    const rec2 = join(d, "rec2.json"); const code2 = join(d, "code2.txt");
    assert.equal(await run("encryption-rotate", keyringFile, "--passcode-file", pf, "--new-passcode-file", pf, "--recovery-out", rec2, "--recovery-code-out", code2), 0, out.join("\n"));
    const text = out.join("\n");
    assert.match(text, /generation 2/); assert.match(text, /still opens every backup made before/); assert.match(text, /backup\.encryption\.rekey/);
    for (const secret of [PASS, PASS2, code, readFileSync(code2, "utf8").trim(), JSON.parse(readFileSync(rec2, "utf8")).recoveryKey]) assert.ok(!text.includes(secret));
    const k3 = JSON.parse(readFileSync(keyringFile, "utf8")) as Keyring;
    assert.equal(k3.generation, 2); assert.equal(k3.previousKeyId, k1.keyId);
    assert.deepEqual(JSON.parse(readFileSync(`${keyringFile}.generation-1`, "utf8")), k2, "the old generation is kept beside it");
    unlockWithRecoveryCode(k3, readFileSync(code2, "utf8"));
    await assert.rejects(unlockWithPasscode(k3, PASS2), UnlockFailed);
    // A second rotation does not overwrite the files of the first (outputs are new files), and the old generation file is never replaced.
    assert.equal(await run("encryption-rotate", keyringFile, "--passcode-file", pf, "--new-passcode-file", pf, "--recovery-out", rec2), 1);
    assert.ok(existsSync(rec2));
    assert.deepEqual(JSON.parse(readFileSync(keyringFile, "utf8")), k3);
    // A backup made under the old generation restores with the recovery CODE of the old generation.
    const root = join(d, "backups");
    const { path } = await createBackup(await populated(), { root, kind: "manual", version: "t", now: () => new Date(AT), encryption: k1 });
    assert.equal(await run("verify", path, "--recovery-code-file", code1), 0, out.join("\n"));
    assert.equal(await run("verify", path, "--recovery-code-file", code2), 1);
    assert.equal(await run("restore", path, "--recovery-code-file", code1, "--sqlite", join(d, "new.sqlite")), 0, out.join("\n"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a successful proof is kept across restarts and the quarterly proof falls due and is cleared by a new proof (card K01b)", async () => {
  const d = tmp();
  try {
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const pf = join(d, "pass"); writeFileSync(pf, `${PASS}\n`, { mode: 0o600 });
    let now = new Date(keyring.createdAt);
    const storage = new MemoryStorage();
    const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
    const make = async (): Promise<BackupEncryption> => { const e = new BackupEncryption({ keyring, passcodeFile: pf, now: () => now, minIntervalMs: 0 }); await e.attachProofStore(BackupProofStore.withEpoch(storage, epoch, { clock: () => now.toISOString() })); return e; };
    const first = await make();
    assert.equal(first.status().proofDue, false);
    now = new Date(now.getTime() + 91 * 86_400_000);
    assert.equal(first.status().proofDue, false);
    now = new Date(now.getTime() + 2 * 86_400_000);
    assert.equal(first.status().proofDue, true);
    assert.ok(first.status().warnings.some((w) => /backup\.encryption\.verify/.test(w)));
    await first.verify("passcode");
    assert.equal(first.status().proofDue, false);
    assert.equal(first.status().lastSuccessfulProof?.method, "passcode");
    // A restart: the proof is read back from the database; a proof for another key is not.
    const second = await make();
    assert.equal(second.status().proofDue, false);
    assert.equal(second.status().lastSuccessfulProof?.at, now.toISOString());
    now = new Date(now.getTime() + 93 * 86_400_000);
    assert.equal(second.status().proofDue, true);
    const rotated = await createKeyring({ passcode: PASS, scrypt: FAST });
    const third = new BackupEncryption({ keyring: rotated.keyring, now: () => now });
    await third.attachProofStore(BackupProofStore.withEpoch(storage, epoch));
    assert.equal(third.status().lastSuccessfulProof, undefined);
    // A failed proof is not a proof.
    writeFileSync(pf, "not the passcode at all\n", { mode: 0o600 });
    await assert.rejects(second.verify("passcode"));
    assert.equal(second.status().proofDue, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("only the canonical recovery code is accepted: every other character at every position is refused (review: the 4 padding bits were not checked)", async () => {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  for (let round = 0; round < 8; round += 1) {
    const { recoveryFile } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const code = recoveryCodeOf(recoveryFile);
    for (let i = 0; i < code.length; i += 1) {
      if (code[i] === "-") continue;
      for (const other of ALPHABET) {
        if (other === code[i]) continue;
        assert.throws(() => recoveryKeyFromCode(code.slice(0, i) + other + code.slice(i + 1)), RecoveryCodeInvalid, `round ${round} position ${i} ${other}`);
      }
    }
  }
});

test("setup leaves a file that was already at the recovery path as it was, and keeps nothing of its own (review: the existing recovery file was deleted)", async () => {
  const d = tmp();
  try {
    const pf = join(d, "pass"); writeFileSync(pf, `${PASS}\n`, { mode: 0o600 });
    const old = join(d, "old-recovery.json"); writeFileSync(old, "the owner's earlier recovery file\n", { mode: 0o600 });
    const codeOld = join(d, "old-code.txt"); writeFileSync(codeOld, "the owner's earlier code\n", { mode: 0o600 });
    const out: string[] = [];
    assert.equal(await runBackupCli(["encryption-setup", join(d, "k1.json"), "--passcode-file", pf, "--recovery-out", old], (l) => { out.push(l); }), 1);
    assert.equal(readFileSync(old, "utf8"), "the owner's earlier recovery file\n");
    assert.ok(!existsSync(join(d, "k1.json")));
    // The code path already taken: the new recovery file and keyring are taken away again, the old code file stays.
    assert.equal(await runBackupCli(["encryption-setup", join(d, "k2.json"), "--passcode-file", pf, "--recovery-out", join(d, "new-rec.json"), "--recovery-code-out", codeOld], (l) => { out.push(l); }), 1);
    assert.equal(readFileSync(codeOld, "utf8"), "the owner's earlier code\n");
    assert.ok(!existsSync(join(d, "k2.json")) && !existsSync(join(d, "new-rec.json")));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a rotation that stopped after keeping the old generation can be run again; a different file at the archive path is never replaced (review)", { timeout: 120_000 }, async () => {
  const d = tmp();
  try {
    const run = async (...argv: string[]): Promise<number> => runBackupCli(argv, () => undefined);
    const pf = join(d, "pass"); writeFileSync(pf, `${PASS}\n`, { mode: 0o600 });
    const keyringFile = join(d, "keyring.json");
    assert.equal(await run("encryption-setup", keyringFile, "--passcode-file", pf, "--recovery-out", join(d, "rec1.json")), 0);
    const before = readFileSync(keyringFile, "utf8");
    // As if an earlier rotation had copied the old generation and then stopped.
    writeFileSync(`${keyringFile}.generation-1`, before, { mode: 0o600 });
    assert.equal(await run("encryption-rotate", keyringFile, "--passcode-file", pf, "--new-passcode-file", pf, "--recovery-out", join(d, "rec2.json")), 0);
    assert.equal(readFileSync(`${keyringFile}.generation-1`, "utf8"), before);
    assert.equal((JSON.parse(readFileSync(keyringFile, "utf8")) as Keyring).generation, 2);
    // A different file already at the next archive path: refused, nothing changed, nothing of the run left behind.
    const gen2 = readFileSync(keyringFile, "utf8");
    writeFileSync(`${keyringFile}.generation-2`, "something else\n", { mode: 0o600 });
    assert.equal(await run("encryption-rotate", keyringFile, "--passcode-file", pf, "--new-passcode-file", pf, "--recovery-out", join(d, "rec3.json")), 1);
    assert.equal(readFileSync(keyringFile, "utf8"), gen2);
    assert.equal(readFileSync(`${keyringFile}.generation-2`, "utf8"), "something else\n");
    assert.ok(!existsSync(join(d, "rec3.json")));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a proof record or key creation time that cannot be read makes a proof due rather than never due (review)", async () => {
  const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
  const now = new Date(keyring.createdAt);
  const bad = new BackupEncryption({ keyring: { ...keyring, createdAt: "not a time" }, now: () => now });
  assert.equal(bad.status().proofDue, true);
  const e = new BackupEncryption({ keyring, now: () => new Date(now.getTime() + 100 * 86_400_000) });
  await e.attachProofStore({ load: async () => ({ method: "passcode", at: "garbage", keyId: keyring.keyId }), save: async () => undefined });
  assert.equal(e.status().proofDue, true);
  assert.equal(e.status().lastSuccessfulProof, undefined);
  await e.attachProofStore({ load: async () => ({ method: "telepathy" as never, at: now.toISOString(), keyId: keyring.keyId }), save: async () => undefined });
  assert.equal(e.status().proofDue, true);
});

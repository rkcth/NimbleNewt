import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStorage } from "../storage/index.js";
import { BackupEncryption, BackupKeyPinService, KeyPinMismatch, ProofRefused, SealedFileBad, SecretFileRefused, createBackup, createKeyring, keyringFingerprint, listBackups, parseKeyring, pruneBackups, readKeyringFile, readSecretFile, unlockWithPasscode, verifyBackup, restoreBackup, type Keyring } from "./index.js";
import { CHUNK_BYTES, MAX_JSON_BYTES, beginSeal, openSink, readPlain } from "./crypto.js";
import { runBackupCli } from "./cli.js";
import { ENCRYPTION_MARKER } from "./format.js";

const AT = "2026-10-29T10:00:00.000Z";
const PASS = "correct horse battery staple";
const FAST = { N: 2 ** 16, r: 8, p: 1 } as const;
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-encr-"));

async function populated(): Promise<MemoryStorage> {
  const s = new MemoryStorage();
  const { epoch } = await s.acquireEpoch({ holder: "c1", at: AT });
  await s.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "t" } }], audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
  return s;
}

test("a sealed file with a chunk appended after its last chunk is refused (card K01b review)", async () => {
  const d = tmp();
  try {
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const { cipher } = beginSeal(keyring);
    const sink = await openSink(join(d, "f.enc"), cipher, "f.enc");
    await sink.write(Buffer.alloc(CHUNK_BYTES * 2 + 5, 3)); await sink.finish();
    const read = async (): Promise<number> => { let n = 0; for await (const b of readPlain(join(d, "f.enc"), cipher, "f.enc")) n += b.length; return n; };
    assert.equal(await read(), CHUNK_BYTES * 2 + 5);
    // A whole forged chunk's worth of bytes, then a few: the old last chunk is no longer last, so it fails; so does a short tail.
    appendFileSync(join(d, "f.enc"), Buffer.alloc(CHUNK_BYTES + 16, 9));
    await assert.rejects(read(), (e: unknown) => e instanceof SealedFileBad);
    appendFileSync(join(d, "f.enc"), Buffer.from("x"));
    await assert.rejects(read(), (e: unknown) => e instanceof SealedFileBad);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a key record outside the accepted bounds is refused as a bad key record: too many passcode wrappers, a long wrapper ID, a huge record (card K01b review)", async () => {
  const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
  const pass = keyring.wrappers.find((w) => w.kind === "passcode")!;
  const bad = (k: unknown, why: RegExp, label: string): void => assert.throws(() => parseKeyring(k), (e: unknown) => e instanceof SealedFileBad && why.test(e.message), label);
  parseKeyring({ ...keyring, wrappers: [pass, { ...pass, id: "second" }, ...keyring.wrappers.filter((w) => w.kind === "recovery")] });
  bad({ ...keyring, wrappers: [pass, { ...pass, id: "b" }, { ...pass, id: "c" }] }, /more passcode wrappers/, "three passcode wrappers");
  bad({ ...keyring, wrappers: keyring.wrappers.map((w) => ({ ...w, id: "x".repeat(33) })) }, /wrapper is not valid/, "a long wrapper id");
  bad({ ...keyring, createdAt: "x".repeat(MAX_JSON_BYTES) }, /too large/, "a huge record");
});

test("a manifest or keyring file larger than the bound is not read (card K01b review)", async () => {
  const d = tmp();
  try {
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const file = join(d, "keyring.json");
    writeFileSync(file, JSON.stringify(keyring), { mode: 0o600 });
    assert.equal((await readKeyringFile(file)).keyId, keyring.keyId);
    writeFileSync(file, JSON.stringify({ ...keyring, createdAt: "x".repeat(MAX_JSON_BYTES) }), { mode: 0o600 });
    await assert.rejects(readKeyringFile(file), /keyring file cannot be read or is not valid/);
    writeFileSync(file, '{"version": nope', { mode: 0o600 });
    await assert.rejects(readKeyringFile(file), (e: unknown) => e instanceof Error && !/nope|JSON|position/i.test(e.message));
    const root = tmp();
    try {
      const { path } = await createBackup(await populated(), { root, kind: "manual", version: "t", now: () => new Date(AT) });
      writeFileSync(join(path, "manifest.json"), `{"x":"${"y".repeat(MAX_JSON_BYTES * 4)}"}`);
      const read = await verifyBackup(path);
      assert.equal(read.ok, false);
      assert.match(read.problems.join(), /too large/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("an encrypted backup's manifest is authenticated: its name, time, kind, epoch, notes, skipped list, file list and key record cannot be changed (card K01b review)", async () => {
  const root = tmp();
  try {
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const { path, manifest } = await createBackup(await populated(), { root, kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring });
    assert.match(manifest.mac ?? "", /^[0-9a-f]{64}$/);
    const key = await unlockWithPasscode(manifest.encryption!.keyring, PASS);
    assert.equal((await verifyBackup(path, { unlock: key })).ok, true);
    const mf = join(path, "manifest.json");
    const m = JSON.parse(readFileSync(mf, "utf8"));
    const changes: Record<string, unknown> = {
      name: "backup-20990101T000000Z-manual", createdAt: "2099-01-01T00:00:00.000Z", kind: "pre-upgrade", epoch: 99, schemaVersion: m.schemaVersion + 1, version: "9.9.9",
      notes: ["Nothing to see here."], complete: true,
      files: m.files.map((f: { rows: number }, i: number) => i === 0 ? { ...f, rows: f.rows + 1 } : f),
    };
    for (const [field, value] of Object.entries(changes)) {
      if (JSON.stringify(m[field]) === JSON.stringify(value)) continue;
      writeFileSync(mf, JSON.stringify({ ...m, [field]: value }));
      const check = await verifyBackup(path, { unlock: key });
      assert.equal(check.ok, false, `${field} changed`);
      assert.match(check.problems.join(), /manifest was changed/, field);
    }
    writeFileSync(mf, JSON.stringify({ ...m, artifacts: { index: { file: "artifacts.jsonl.enc", rows: 0, bytes: 0, sha256: "0".repeat(64) }, blobs: 0, bytes: 0, skipped: [{ digest: "a".repeat(64), why: "corrupt" }] } }));
    assert.match((await verifyBackup(path, { unlock: key })).problems.join(), /manifest was changed/, "the skipped list");
    const { mac: _mac, ...noMac } = m; void _mac;
    writeFileSync(mf, JSON.stringify(noMac));
    assert.match((await verifyBackup(path, { unlock: key })).problems.join(), /manifest was changed/, "the MAC removed");
    await assert.rejects(restoreBackup(path, new MemoryStorage(), { unlock: key }), /cannot be restored/);
    writeFileSync(mf, JSON.stringify(m));
    assert.equal((await verifyBackup(path, { unlock: key })).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retention does not trust a manifest time that disagrees with the backup's folder name: it is never deleted and never takes a good backup's place (card K01b review)", async () => {
  const root = tmp();
  try {
    const made: string[] = [];
    for (let i = 0; i < 9; i++) made.push((await createBackup(await populated(), { root, kind: "scheduled", version: "t", now: () => new Date(Date.parse(AT) - i * 86_400_000) })).path);
    // The newest backup's manifest is rewritten to claim a time far ahead, and an old one to claim today.
    const forged = made[0]!; const old = made[8]!;
    const touch = (path: string, createdAt: string): void => { const f = join(path, "manifest.json"); const m = JSON.parse(readFileSync(f, "utf8")); writeFileSync(f, JSON.stringify({ ...m, createdAt })); };
    touch(forged, "2099-01-01T00:00:00.000Z"); touch(old, AT);
    const all = await listBackups(root);
    assert.equal(all.find((b) => b.path === forged)!.trusted, false);
    assert.equal(all.find((b) => b.path === old)!.trusted, false);
    assert.equal(all.filter((b) => b.trusted).length, 7);
    assert.deepEqual(all.map((b) => b.at).slice(0, 2), [new Date(Date.parse(AT)).toISOString().replace(/\.\d+Z$/, ".000Z"), new Date(Date.parse(AT) - 86_400_000).toISOString().replace(/\.\d+Z$/, ".000Z")], "ordered by the folder name's time, not the manifest's");
    const pruned = await pruneBackups(root, { now: () => new Date(AT) });
    assert.ok(existsSync(forged) && existsSync(old), "an untrusted backup is not deleted");
    assert.equal(pruned.deleted.length, 0, "7 trusted days are kept, the untrusted ones are not counted and not removed");
    // A backup folder renamed to another time is untrusted for the same reason.
    const renamed = join(root, "backup-20300101T000000Z-scheduled");
    execFileSync("mv", [made[3]!, renamed]);
    assert.equal((await listBackups(root)).find((b) => b.path === renamed)!.trusted, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the command line: a passcode or recovery flag requires an encrypted backup; a folder that held encrypted backups refuses a plain one without --allow-plain (card K01b review)", async () => {
  const d = tmp();
  try {
    const out: string[] = [];
    const run = async (...argv: string[]): Promise<number> => { out.length = 0; return runBackupCli(argv, (l) => { out.push(l); }); };
    const pf = join(d, "pass"); writeFileSync(pf, `${PASS}\n`, { mode: 0o600 });
    const { keyring, recoveryFile } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const rf = join(d, "rec"); writeFileSync(rf, JSON.stringify(recoveryFile), { mode: 0o600 });
    // A plain backup with an unlock flag: refused, both in verify and in restore.
    const plain = await createBackup(await populated(), { root: join(d, "plainroot"), kind: "manual", version: "t", now: () => new Date(AT) });
    assert.equal(await run("verify", plain.path), 0, out.join("\n"));
    assert.equal(await run("verify", plain.path, "--passcode-file", pf), 1);
    assert.match(out.join("\n"), /not encrypted, and encryption is required/);
    assert.equal(await run("verify", plain.path, "--recovery-file", rf), 1);
    assert.equal(await run("restore", plain.path, "--passcode-file", pf, "--sqlite", join(d, "p.sqlite")), 1);
    assert.match(out.join("\n"), /not encrypted, and encryption is required/);
    assert.equal(existsSync(join(d, "p.sqlite")), false, "nothing was restored");
    // A folder that has held encrypted backups: a plain one needs --allow-plain yes.
    const root = join(d, "backups");
    await createBackup(await populated(), { root, kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring });
    assert.ok(existsSync(join(root, ENCRYPTION_MARKER)));
    const swapped = await createBackup(await populated(), { root, kind: "scheduled", version: "t", now: () => new Date(Date.parse(AT) + 86_400_000) });
    assert.equal(await run("verify", swapped.path), 1);
    assert.match(out.join("\n"), /allow-plain/);
    assert.equal(await run("restore", swapped.path, "--sqlite", join(d, "q.sqlite")), 1);
    assert.equal(existsSync(join(d, "q.sqlite")), false);
    assert.equal(await run("verify", swapped.path, "--allow-plain", "yes"), 0, out.join("\n"));
    assert.equal(await run("restore", swapped.path, "--allow-plain", "yes", "--sqlite", join(d, "r.sqlite")), 0, out.join("\n"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the command line never prints a parser's words about a secret file: a damaged recovery file gets fixed text (card K01b review)", async () => {
  const d = tmp();
  try {
    const out: string[] = [];
    const run = async (...argv: string[]): Promise<number> => { out.length = 0; return runBackupCli(argv, (l) => { out.push(l); }); };
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const { path } = await createBackup(await populated(), { root: join(d, "b"), kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring });
    const rf = join(d, "rec"); const marker = "SECRET-LOOKING-TEXT-8841";
    writeFileSync(rf, `{"recoveryKey": "${marker}", oops`, { mode: 0o600 });
    assert.equal(await run("verify", path, "--recovery-file", rf), 1);
    const shown = out.join("\n");
    assert.ok(!shown.includes(marker) && !/JSON|position|token|Unexpected/i.test(shown), shown);
    assert.match(shown, /not a recovery file/);
    // A damaged manifest is not echoed either.
    writeFileSync(join(path, "manifest.json"), `{"secret": "${marker}"  broken`);
    assert.equal(await run("verify", path), 1);
    assert.ok(!out.join("\n").includes(marker) && !/JSON|position|Unexpected/i.test(out.join("\n")));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("setup writes the keyring first and leaves no orphan recovery file when the second write fails (card K01b review)", async () => {
  const d = tmp();
  try {
    const out: string[] = [];
    const run = async (...argv: string[]): Promise<number> => { out.length = 0; return runBackupCli(argv, (l) => { out.push(l); }); };
    const pf = join(d, "pass"); writeFileSync(pf, `${PASS}\n`, { mode: 0o600 });
    const keyringFile = join(d, "keyring.json");
    // The recovery file cannot be written (its folder is missing): the keyring that was written first is taken away again.
    assert.equal(await run("encryption-setup", keyringFile, "--passcode-file", pf, "--recovery-out", join(d, "nope", "rec.json")), 1);
    assert.equal(existsSync(keyringFile), false, "no keyring without its recovery file");
    // A keyring that already exists: nothing else is written (no recovery file for a keyring that was not made).
    writeFileSync(keyringFile, "{}", { mode: 0o600 });
    const rec = join(d, "rec.json");
    assert.equal(await run("encryption-setup", keyringFile, "--passcode-file", pf, "--recovery-out", rec), 1);
    assert.equal(existsSync(rec), false, "no orphan recovery file");
    assert.equal(readFileSync(keyringFile, "utf8"), "{}", "the existing keyring was not touched");
    rmSync(keyringFile);
    assert.equal(await run("encryption-setup", keyringFile, "--passcode-file", pf, "--recovery-out", rec), 0, out.join("\n"));
    assert.match(out.join("\n"), new RegExp(`fingerprint ${keyringFingerprint(JSON.parse(readFileSync(keyringFile, "utf8")) as Keyring)}`));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a secret file is looked at before it is opened: a link, a named pipe, a directory and an oversized file are refused without being read (card K01b review)", async () => {
  const d = tmp();
  try {
    const real = join(d, "real"); writeFileSync(real, "hello secret words", { mode: 0o600 });
    assert.equal(await readSecretFile(real), "hello secret words");
    const link = join(d, "link"); symlinkSync(real, link);
    await assert.rejects(readSecretFile(link), (e: unknown) => e instanceof SecretFileRefused && /not a regular file/.test(e.message));
    await assert.rejects(readSecretFile(d), /not a regular file/);
    const fifo = join(d, "fifo"); execFileSync("mkfifo", [fifo]);
    await assert.rejects(readSecretFile(fifo), /not a regular file/); // returns at once: it never blocks on the pipe
    const big = join(d, "big"); writeFileSync(big, "x".repeat(5000), { mode: 0o600 });
    await assert.rejects(readSecretFile(big), /too large/);
    await assert.rejects(readSecretFile(join(d, "missing")), (e: unknown) => e instanceof SecretFileRefused && !e.message.includes(d));
    // The proof maps those to its own refusal, and a failed proof leaves it ready for the next (nothing stays "running").
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    let t = Date.parse(AT);
    const enc = new BackupEncryption({ keyring, passcodeFile: fifo, now: () => new Date(t += 20_000) });
    await assert.rejects(enc.verify("passcode"), (e: unknown) => e instanceof ProofRefused && e.code === "unreadable");
    await assert.rejects(enc.verify("passcode"), (e: unknown) => e instanceof ProofRefused && e.code === "unreadable", "not stuck as running");
    const good = new BackupEncryption({ keyring, passcodeFile: real, now: () => new Date(t += 20_000) });
    writeFileSync(real, `${PASS}\n`);
    assert.equal((await good.verify("passcode")).ok, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the status shows the key's fingerprint and warns about a recovery file kept beside the keyring (card K01b review)", async () => {
  const d = tmp();
  try {
    const { keyring, recoveryFile } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const keyringFile = join(d, "keyring.json"); writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
    const rf = join(d, "recovery.json"); writeFileSync(rf, JSON.stringify(recoveryFile), { mode: 0o600 });
    const beside = new BackupEncryption({ keyring, keyringFile, recoveryFile: rf });
    assert.equal(beside.status().fingerprint, keyringFingerprint(keyring));
    assert.match(beside.status().warnings.join(), /same folder as the keyring/);
    mkdirSync(join(d, "elsewhere"));
    const away = join(d, "elsewhere", "recovery.json"); writeFileSync(away, JSON.stringify(recoveryFile), { mode: 0o600 });
    assert.match(new BackupEncryption({ keyring, keyringFile, recoveryFile: away }).status().warnings.join(), /on this host right now/);
    rmSync(away);
    assert.deepEqual(new BackupEncryption({ keyring, keyringFile, recoveryFile: away }).status().warnings, [], "a recovery file that is not there warns of nothing");
    assert.ok(!JSON.stringify(beside.status()).includes(recoveryFile.recoveryKey));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the backup key is pinned at the first load; a different key is refused until the owner approves its fingerprint, once (card K01b review)", async () => {
  const s = new MemoryStorage();
  const { epoch } = await s.acquireEpoch({ holder: "c1", at: AT });
  const pin = BackupKeyPinService.withEpoch(s, epoch, { clock: () => AT });
  const a = (await createKeyring({ passcode: PASS, scrypt: FAST })).keyring;
  const b = (await createKeyring({ passcode: PASS, scrypt: FAST })).keyring;
  assert.deepEqual(await pin.check(a), { fingerprint: keyringFingerprint(a), first: true, approved: false });
  assert.deepEqual(await pin.check(a), { fingerprint: keyringFingerprint(a), first: false, approved: false });
  await assert.rejects(pin.check(b), (e: unknown) => e instanceof KeyPinMismatch && e.message.includes(keyringFingerprint(a)) && e.message.includes("backup.encryption.rekey"));
  const owner = { id: "owner:rob", kind: "owner", name: "rob", grants: [] } as never;
  const agent = { id: "agent:zed", kind: "agent", name: "zed", grants: [] } as never;
  await assert.rejects(pin.rekey(agent, { commandId: "k0", fingerprint: keyringFingerprint(b) }), /may not/);
  await assert.rejects(pin.rekey(owner, { commandId: "k1", fingerprint: "nope" }), /fingerprint/);
  await assert.rejects(pin.rekey(owner, { commandId: "k2", fingerprint: keyringFingerprint(a) }), /already in use/);
  // The approval alone changes nothing; the old key still loads, the new one is refused until approved, and the approval is withdrawn by null.
  await pin.rekey(owner, { commandId: "k3", fingerprint: keyringFingerprint(b) });
  assert.equal((await pin.get(owner)).approved?.fingerprint, keyringFingerprint(b));
  assert.equal((await pin.check(a)).first, false);
  await pin.rekey(owner, { commandId: "k4", fingerprint: null });
  await assert.rejects(pin.check(b), KeyPinMismatch);
  await pin.rekey(owner, { commandId: "k5", fingerprint: keyringFingerprint(b) });
  assert.deepEqual(await pin.check(b), { fingerprint: keyringFingerprint(b), first: false, approved: true });
  assert.equal((await pin.get(owner)).pinned?.fingerprint, keyringFingerprint(b));
  assert.equal((await pin.get(owner)).approved, undefined, "the approval was used once");
  await assert.rejects(pin.check(a), KeyPinMismatch);
});

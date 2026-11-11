import { FileBlobStore } from "../artifacts/index.js";
import { PostgresStorage } from "../storage/postgres/index.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DeletionLedger, LEDGER_FILE } from "../retention/ledger.js";
import { PasscodeRefused, RecoveryCodeInvalid, UnlockFailed, addPasscode, createKeyring, keyringFingerprint, parseKeyring, recoveryCodeOf, rotateKeyring, unlockWithPasscode, unlockWithRecovery, unlockWithRecoveryCode, type BackupKey, type Keyring } from "./crypto.js";
import { readKeyringFile } from "./encryption.js";
import { readSecretFile, SecretFileRefused } from "./secret-file.js";
import { ENCRYPTION_MARKER } from "./format.js";
import { access } from "node:fs/promises";
import { readManifest } from "./verify.js";
import { listBackups } from "./retention.js";
import { RestoreRefused, restoreBackup } from "./restore.js";
import { manifestDigestOf, verifyBackup } from "./verify.js";
import { trustedKeyOf, type SignatureTrust } from "./signing.js";
import { acquireDataLocks, type DataLock, type LockEnv } from "./data-lock.js";

const USAGE = [
  "usage:",
  "  backup list <backups folder>",
  "  backup verify <backup folder> [--passcode-file <file> | --recovery-file <file> | --recovery-code-file <file>] [--require-encrypted yes] [--allow-plain yes] [--trusted-signing-key-file <file>] [--manifest-digest <hex>]",
  "  backup encryption-setup <new keyring file> --passcode-file <file holding the passcode> --recovery-out <new recovery file> [--recovery-code-out <new file for the printable recovery code>]",
  "  backup encryption-add-passcode <keyring file> (--passcode-file <file> | --recovery-file <file> | --recovery-code-file <file>) --new-passcode-file <file holding the extra passcode>",
  "  backup encryption-rotate <keyring file> (--passcode-file <file> | --recovery-file <file> | --recovery-code-file <file>) --new-passcode-file <file> [--new-passcode-file-2 <file>] --recovery-out <new recovery file> [--recovery-code-out <new file>]   (removes or replaces a passcode: a new key for later backups)",
  "  backup restore <backup folder> [--passcode-file <file> | --recovery-file <file> | --recovery-code-file <file>] [--require-encrypted yes] [--allow-plain yes] (--sqlite <new database file> | --postgres <connection url> [--schema <name>]) [--pi-state <new folder for the agents' conversation stores>] [--artifacts <new artifact folder>]",
  "--trusted-signing-key-file names a file of signing public keys you saved from backup.signing.status (one base64 key per line; not secret): the backup must then carry a valid signature of one of them. Without it the signature is not checked, and the output says so. --manifest-digest checks the backup against a digest you kept off the server.",
  "Secrets are only ever read from files (mode 600) and written to new files; none is taken on the command line or printed.",
  "Giving a passcode or recovery file means the backup must be encrypted. A folder that has held encrypted backups refuses a plain one unless you give --allow-plain yes.",
  "The passcode and recovery files are for the moment of the command: put them there, run it, and remove them; keep the recovery file off this machine.",
  "A restore always goes into a new, empty database; it never overwrites one that a controller has used.",
].join("\n");

/** Reads `--name value` pairs after the positional argument; anything else is an error. */
function options(rest: readonly string[], known: readonly string[]): Map<string, string> | string {
  const out = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]!;
    const value = rest[i + 1];
    if (!name.startsWith("--") || !known.includes(name.slice(2)) || value === undefined || value.startsWith("--")) return `unexpected argument ${JSON.stringify(name)}`;
    if (out.has(name.slice(2))) return `${name} was given twice`;
    out.set(name.slice(2), value);
  }
  return out;
}

/**
 * The owner's command-line entry for backups (card K01f): list what is in a backups folder, verify one, and restore one into a new, empty database on a new machine from the backup alone. Prints with `print` and returns the exit code:
 * 0 done, 1 refused or failed, 2 not understood. It opens only what it is told to, and never the database a controller is running on.
 */
export async function runBackupCli(argv: readonly string[], print: (line: string) => void, lockEnv?: LockEnv): Promise<number> {
  const [command, folder, ...rest] = argv;
  if (command === undefined || folder === undefined || !["list", "verify", "restore", "encryption-setup", "encryption-add-passcode", "encryption-rotate"].includes(command)) { print(USAGE); return 2; }
  try {
    if (command === "list") {
      if (rest.length > 0) { print(USAGE); return 2; }
      const all = await listBackups(folder);
      if (all.length === 0) print("no complete backups in that folder");
      for (const b of all) print(`${b.manifest.name}  ${b.manifest.kind}  schema ${b.manifest.schemaVersion}  ${b.manifest.files.reduce((n, f) => n + f.rows, 0)} rows`);
      return 0;
    }
    if (command === "encryption-setup") {
      const o = options(rest, ["passcode-file", "recovery-out", "recovery-code-out"]);
      if (typeof o === "string" || o.get("passcode-file") === undefined || o.get("recovery-out") === undefined) { print(typeof o === "string" ? o : "give --passcode-file and --recovery-out"); print(USAGE); return 2; }
      const passcode = await readSecretFile(o.get("passcode-file")!);
      const { keyring, recoveryFile } = await createKeyring({ passcode });
      // Prove both methods open the key before anything is kept (setup is not finished until the recovery file is shown to work).
      await unlockWithPasscode(keyring, passcode); unlockWithRecovery(keyring, recoveryFile);
      const codeOut = o.get("recovery-code-out");
      if (codeOut !== undefined) unlockWithRecoveryCode(keyring, recoveryCodeOf(recoveryFile));
      await mkdir(dirname(folder), { recursive: true });
      // The keyring is written first and the recovery file second; if the second cannot be written the first is taken away again, so no recovery file is left for a keyring that was never kept (and none is left without its keyring).
      await writeNew(folder, `${JSON.stringify(keyring, null, 2)}\n`);
      // Only files this command made are taken away again: a path that already held a file (say, the owner's earlier recovery file) refuses the write and is left as it was.
      const made = [folder];
      try { await writeNew(o.get("recovery-out")!, `${JSON.stringify(recoveryFile)}\n`); made.push(o.get("recovery-out")!); if (codeOut !== undefined) { await writeNew(codeOut, `${recoveryCodeOf(recoveryFile)}\n`); made.push(codeOut); } } catch (error) { for (const f of made) await rm(f, { force: true }).catch(() => undefined); throw error; }
      print(`encryption set up: key ${keyring.keyId}, fingerprint ${keyringFingerprint(keyring)}; the recovery file is in ${o.get("recovery-out")!}. Keep it OFF this machine (and the passcode in your own safe place): with neither, the encrypted backups cannot be read by anyone. Remove the passcode file now; put a file back only for the moment of a proof.`);
      return 0;
    }
    if (command === "encryption-add-passcode" || command === "encryption-rotate") return await manageKey(command, folder, rest, print);
    if (command === "verify") {
      const o = options(rest, ["passcode-file", "recovery-file", "recovery-code-file", "require-encrypted", "allow-plain", "trusted-signing-key-file", "manifest-digest"]);
      if (typeof o === "string") { print(o); print(USAGE); return 2; }
      const check = await verifyBackup(folder, { ...(await unlockFrom(folder, o)), ...(await signatureFrom(o)) });
      if (check.ok && o.get("manifest-digest") !== undefined && manifestDigestOf(check.manifest!) !== o.get("manifest-digest")!.toLowerCase()) { print("problem: the manifest digest is not the one you gave: this is not the backup you kept the digest of"); return 1; }
      if (check.ok) { print(`ok: ${check.manifest!.name} (schema ${check.manifest!.schemaVersion}) matches its manifest; manifest digest ${manifestDigestOf(check.manifest!)}`); if (check.signature !== undefined) print(check.signature.text); return 0; }
      for (const p of check.problems) print(`problem: ${p}`);
      return 1;
    }
    const opts = options(rest, ["sqlite", "postgres", "schema", "artifacts", "pi-state", "passcode-file", "recovery-file", "recovery-code-file", "require-encrypted", "allow-plain", "deletions", "trusted-signing-key-file", "manifest-digest"]);
    if (typeof opts === "string") { print(opts); print(USAGE); return 2; }
    if ((opts.get("sqlite") === undefined) === (opts.get("postgres") === undefined)) { print("give exactly one of --sqlite and --postgres"); return 2; }
    if (opts.get("schema") !== undefined && opts.get("postgres") === undefined) { print("--schema goes with --postgres"); return 2; }
    // What the backup needs to be opened is settled before the new database is touched: a refusal leaves nothing behind.
    const unlocked = await unlockFrom(folder, opts);
    if (unlocked.requireEncrypted === true && (await readManifest(folder)).manifest?.encryption === undefined) throw new RestoreRefused("the backup cannot be restored: the backup is not encrypted, and encryption is required");
    // A restore to files writes into folders a controller may own: the folders' data directory locks are taken (a live holder refuses it), and let go of at the end.
    let held: DataLock | undefined;
    const lockDirs = [...(opts.get("sqlite") === undefined ? [] : [dirname(resolve(opts.get("sqlite")!))]), ...(opts.get("pi-state") === undefined ? [] : [dirname(resolve(opts.get("pi-state")!))])];
    if (lockDirs.length > 0) {
      try { held = await acquireDataLocks(lockDirs, lockEnv); } catch (error) { throw new RestoreRefused(`the restore was not started: ${error instanceof Error ? error.message : "the folder is in use by a controller"}`); }
    }
    let storage: ControllerStorage & { close(): Promise<void> };
    try {
    if (opts.get("sqlite") !== undefined) storage = await SqliteStorage.open({ path: opts.get("sqlite")! });
    else storage = await PostgresStorage.open({ connectionString: opts.get("postgres")!, ...(opts.get("schema") === undefined ? {} : { schema: opts.get("schema")! }) });
    try {
      const blobs = opts.get("artifacts") === undefined ? undefined : await FileBlobStore.open({ directory: opts.get("artifacts")! });
      // Deletions the owner asked for after this backup was made are re-applied, so restoring an old backup does not bring a deleted record's text back.
      const ledgerPath = opts.get("deletions") ?? join(dirname(resolve(folder)), LEDGER_FILE);
      const done = await restoreBackup(folder, storage, { ...(await signatureFrom(opts)), ...(opts.get("manifest-digest") === undefined ? {} : { expectedManifestDigest: opts.get("manifest-digest")!.toLowerCase() }), ...(blobs === undefined ? {} : { blobs }), ...(opts.get("pi-state") === undefined ? {} : { piTarget: (id: string) => join(opts.get("pi-state")!, id) }), ...unlocked, deletions: await new DeletionLedger(ledgerPath).read() });
      if (done.signature !== undefined) print(done.signature.text);
      print(`restored ${done.rows} rows${done.blobsRestored > 0 ? ` and ${done.blobsRestored} artifact files` : ""} from ${done.manifest.name}`);
      if (done.piFilesRestored > 0) print(`${done.piFilesRestored} conversation files of ${done.piStoresRestored} agent stores were put back`);
      if (done.deletionsReapplied > 0) print(`${done.deletionsReapplied} records deleted at your request after this backup was made were blanked or removed again`);
      if (done.effectsMarkedUncertain > 0) print(`${done.effectsMarkedUncertain} actions on the outside were only intended when the backup was taken; they are marked uncertain and are never run again, so check what really happened`);
      if (done.deliveriesToResend > 0) print(`${done.deliveriesToResend} messages had not been delivered when the backup was taken; they will be sent again`);
      return 0;
    } finally { await storage.close(); }
    } finally { await held?.release(); }
  } catch (error) {
    // Only messages written for the operator are shown; a parser's or the system's own words may quote a secret file's content or a path, so any other failure gets fixed text.
    print(error instanceof RestoreRefused || error instanceof UnlockFailed || error instanceof PasscodeRefused || error instanceof RecoveryCodeInvalid || error instanceof SecretFileRefused ? error.message : error instanceof SyntaxError ? "failed: a file is not in the expected format" : `failed: ${error instanceof Error && /^(ENOENT|EEXIST|EACCES|EISDIR|ENOTDIR|EPERM)/.test(String((error as NodeJS.ErrnoException).code ?? "")) ? `the file system said ${(error as NodeJS.ErrnoException).code}` : "the command could not be completed"}`);
    return 1;
  }
}

/** The signing public keys the owner kept (card K01b3): a file of base64 keys, one per line (`#` lines and blanks are skipped). Public, so no mode is required; the key IDs are derived, never read. */
async function signatureFrom(o: Map<string, string>): Promise<{ signatureTrust?: SignatureTrust }> {
  const file = o.get("trusted-signing-key-file");
  if (file === undefined) return {};
  let text: string;
  try { const info = await stat(file); if (!info.isFile() || info.size > 65_536) throw new Error("size"); text = await readFile(file, "utf8"); } catch { throw new RestoreRefused("the trusted signing key file cannot be read"); }
  const keys = text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#")).map((l) => { try { return trustedKeyOf(l); } catch { throw new RestoreRefused("the trusted signing key file holds a line that is not an Ed25519 public key"); } });
  if (keys.length === 0) throw new RestoreRefused("the trusted signing key file holds no key");
  return { signatureTrust: { keys } };
}

/** Writes a new file (refuses to overwrite one) readable by the owner alone. */
async function writeNew(path: string, text: string): Promise<void> { await writeFile(path, text, { flag: "wx", mode: 0o600 }); }

/**
 * What verification and restore need from the options. Giving a passcode or a recovery file means the backup must be encrypted (a plain backup swapped in would otherwise be taken without a word). A folder that has held
 * encrypted backups (the marker `createBackup` leaves) refuses a plain one unless `--allow-plain yes`. The keyring used is the backup's own (the wrapped copies it carries); it is checked against the passcode or recovery file, not trusted.
 */
async function unlockFrom(folder: string, o: Map<string, string>): Promise<{ unlock?: BackupKey; requireEncrypted?: true }> {
  const pass = o.get("passcode-file"); const rec = o.get("recovery-file"); const code = o.get("recovery-code-file");
  if ([pass, rec, code].filter((x) => x !== undefined).length > 1) throw new RestoreRefused("give one of --passcode-file, --recovery-file and --recovery-code-file");
  const required = o.get("require-encrypted") === "yes" || pass !== undefined || rec !== undefined || code !== undefined;
  const m = await readManifest(folder);
  const seal = m.manifest?.encryption;
  if (seal === undefined) {
    if (m.manifest !== undefined && !required && o.get("allow-plain") !== "yes" && await access(resolve(dirname(resolve(folder)), ENCRYPTION_MARKER)).then(() => true, () => false)) {
      throw new RestoreRefused("this backups folder has held encrypted backups and this backup is not encrypted: it may have been put there in place of one. Give --allow-plain yes if you mean to use it.");
    }
    return required ? { requireEncrypted: true } : {};
  }
  const keyring = parseKeyring(seal.keyring);
  if (pass !== undefined) return { unlock: await unlockWithPasscode(keyring, await readSecretFile(pass)), ...(required ? { requireEncrypted: true as const } : {}) };
  if (code !== undefined) return { unlock: unlockWithRecoveryCode(keyring, await readSecretFile(code)), ...(required ? { requireEncrypted: true as const } : {}) };
  if (rec !== undefined) {
    let file: unknown;
    try { file = JSON.parse(await readSecretFile(rec)); } catch (error) { throw error instanceof SecretFileRefused ? error : new UnlockFailed("could not unlock: that file is not a recovery file"); }
    return { unlock: unlockWithRecovery(keyring, file), ...(required ? { requireEncrypted: true as const } : {}) };
  }
  return required ? { requireEncrypted: true } : {};
}

/** Opens a keyring with whichever unlock file was given (a passcode file, a recovery file or a recovery code file): the owner proving they hold the key before anything about it is changed. */
async function unlockKeyring(keyring: Keyring, o: Map<string, string>): Promise<BackupKey> {
  const pass = o.get("passcode-file"); const rec = o.get("recovery-file"); const code = o.get("recovery-code-file");
  if ([pass, rec, code].filter((x) => x !== undefined).length !== 1) throw new RestoreRefused("give exactly one of --passcode-file, --recovery-file and --recovery-code-file to show that you hold the key");
  if (pass !== undefined) return unlockWithPasscode(keyring, await readSecretFile(pass));
  if (code !== undefined) return unlockWithRecoveryCode(keyring, await readSecretFile(code));
  let file: unknown;
  try { file = JSON.parse(await readSecretFile(rec!)); } catch (error) { throw error instanceof SecretFileRefused ? error : new UnlockFailed("could not unlock: that file is not a recovery file"); }
  return unlockWithRecovery(keyring, file);
}

/** Replaces the keyring file in one step (a new file beside it, then a rename), so a crash leaves the old or the new one, never half of one. */
async function replaceKeyringFile(path: string, keyring: Keyring): Promise<void> {
  const temp = `${path}.new-${process.pid}`;
  await writeNew(temp, `${JSON.stringify(keyring, null, 2)}\n`);
  // The new file's bytes reach the disk before the rename, and the rename before the command reports success: a power cut never leaves an empty keyring in place of the old one.
  try { await syncFile(temp); await rename(temp, path); } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
  await syncDir(dirname(resolve(path)));
}
/**
 * Flushes a file this command wrote to the disk. On Windows a flush (FlushFileBuffers) needs a handle with write access, and one opened read-only fails with EPERM, so there the file is opened for
 * reading and writing (nothing is written through it); elsewhere read-only is enough and is kept.
 */
async function syncFile(path: string): Promise<void> { const h = await open(path, process.platform === "win32" ? "r+" : "r"); try { await h.sync(); } finally { await h.close(); } }
async function syncDir(path: string): Promise<void> { const h = await open(path, "r").catch(() => undefined); if (h === undefined) return; try { await h.sync().catch(() => undefined); } finally { await h.close(); } }
/** Keeps the old generation's keyring beside the new one, never overwriting a file there. The same content left by an earlier run that stopped part way is taken as already kept, so the rotation can be run again. */
async function archiveKeyring(from: string, to: string): Promise<boolean> {
  try { await copyFile(from, to, 1); } catch (error) { // COPYFILE_EXCL
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const [a, b] = await Promise.all([readFile(from), readFile(to)]);
    if (!a.equals(b)) throw error;
    return false;
  }
  await syncFile(to);
  return true;
}

/**
 * Adding a passcode, or removing/replacing one by rotation (card K01b). Both need the owner to open the current key first. Adding keeps the key (same fingerprint, a running controller picks the file up at its next start).
 * Rotation makes a NEW key: the old keyring is kept beside the new one as `<keyring>.generation-N`, the new passcodes and a new recovery file (and code) are proven to open the new key before anything is written, and the owner
 * is told the new fingerprint to approve (`backup.encryption.rekey`) and that a passcode left out still opens the backups made before.
 */
async function manageKey(command: "encryption-add-passcode" | "encryption-rotate", keyringPath: string, rest: readonly string[], print: (line: string) => void): Promise<number> {
  const rotate = command === "encryption-rotate";
  const o = options(rest, ["passcode-file", "recovery-file", "recovery-code-file", "new-passcode-file", ...(rotate ? ["new-passcode-file-2", "recovery-out", "recovery-code-out"] : [])]);
  if (typeof o === "string" || o.get("new-passcode-file") === undefined || (rotate && o.get("recovery-out") === undefined)) { print(typeof o === "string" ? o : rotate ? "give --new-passcode-file and --recovery-out" : "give --new-passcode-file"); print(USAGE); return 2; }
  const keyring = await readKeyringFile(keyringPath);
  const key = await unlockKeyring(keyring, o);
  const first = await readSecretFile(o.get("new-passcode-file")!);
  if (!rotate) {
    const next = await addPasscode(key, first);
    await unlockWithPasscode(next, first); // proof: the new passcode opens the same key
    await replaceKeyringFile(keyringPath, next);
    print(`a passcode was added to key ${next.keyId} (fingerprint ${keyringFingerprint(next)}, unchanged). Restart the controller to use the new keyring file. Remove the passcode files now.`);
    return 0;
  }
  const more = o.get("new-passcode-file-2") === undefined ? [] : [await readSecretFile(o.get("new-passcode-file-2")!)];
  const { keyring: next, recoveryFile } = await rotateKeyring({ current: key, passcodes: [first, ...more] });
  // Proof as at setup, before anything is kept: each new passcode and the new recovery file (and code) open the new key, and it is a different key.
  for (const p of [first, ...more]) await unlockWithPasscode(next, p);
  unlockWithRecovery(next, recoveryFile); unlockWithRecoveryCode(next, recoveryCodeOf(recoveryFile));
  if (keyringFingerprint(next) === keyringFingerprint(keyring)) throw new Error("same key");
  const archive = `${keyringPath}.generation-${keyring.generation ?? 1}`;
  const made: string[] = [];
  try {
    if (await archiveKeyring(keyringPath, archive)) made.push(archive);
    await writeNew(o.get("recovery-out")!, `${JSON.stringify(recoveryFile)}\n`); made.push(o.get("recovery-out")!);
    if (o.get("recovery-code-out") !== undefined) { await writeNew(o.get("recovery-code-out")!, `${recoveryCodeOf(recoveryFile)}\n`); made.push(o.get("recovery-code-out")!); }
    await replaceKeyringFile(keyringPath, next);
  } catch (error) { for (const f of made) await rm(f, { force: true }).catch(() => undefined); throw error; }
  print(`the key was rotated to generation ${next.generation}: new key ${next.keyId}, fingerprint ${keyringFingerprint(next)}. The new recovery file is in ${o.get("recovery-out")!}; keep it off this machine. The old recovery file no longer opens new backups.`);
  print(`Next: approve the new fingerprint (backup.encryption.rekey), then restart the controller with the new keyring. The old keyring is kept as ${archive}; until the new fingerprint is approved the controller refuses to start with the new keyring, so if it must restart before then, put the old keyring back from that file first.`);
  print("Be aware: a passcode you left out no longer opens backups made from now on, but it still opens every backup made before this rotation (and so does the old recovery file). If a passcode was exposed, treat those older backups as readable by whoever has it; they cannot be re-sealed without the old key.");
  return 0;
}

import { FileBlobStore } from "../artifacts/index.js";
import { PostgresStorage } from "../storage/postgres/index.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { UnlockFailed, createKeyring, keyringFingerprint, parseKeyring, unlockWithPasscode, unlockWithRecovery, type BackupKey } from "./crypto.js";
import { readSecretFile, SecretFileRefused } from "./secret-file.js";
import { ENCRYPTION_MARKER } from "./format.js";
import { access } from "node:fs/promises";
import { readManifest } from "./verify.js";
import { listBackups } from "./retention.js";
import { RestoreRefused, restoreBackup } from "./restore.js";
import { verifyBackup } from "./verify.js";

const USAGE = [
  "usage:",
  "  backup list <backups folder>",
  "  backup verify <backup folder> [--passcode-file <file> | --recovery-file <file>] [--require-encrypted yes] [--allow-plain yes]",
  "  backup encryption-setup <new keyring file> --passcode-file <file holding the passcode> --recovery-out <new recovery file>",
  "  backup restore <backup folder> [--passcode-file <file> | --recovery-file <file>] [--require-encrypted yes] [--allow-plain yes] (--sqlite <new database file> | --postgres <connection url> [--schema <name>]) [--artifacts <new artifact folder>]",
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
export async function runBackupCli(argv: readonly string[], print: (line: string) => void): Promise<number> {
  const [command, folder, ...rest] = argv;
  if (command === undefined || folder === undefined || !["list", "verify", "restore", "encryption-setup"].includes(command)) { print(USAGE); return 2; }
  try {
    if (command === "list") {
      if (rest.length > 0) { print(USAGE); return 2; }
      const all = await listBackups(folder);
      if (all.length === 0) print("no complete backups in that folder");
      for (const b of all) print(`${b.manifest.name}  ${b.manifest.kind}  schema ${b.manifest.schemaVersion}  ${b.manifest.files.reduce((n, f) => n + f.rows, 0)} rows`);
      return 0;
    }
    if (command === "encryption-setup") {
      const o = options(rest, ["passcode-file", "recovery-out"]);
      if (typeof o === "string" || o.get("passcode-file") === undefined || o.get("recovery-out") === undefined) { print(typeof o === "string" ? o : "give --passcode-file and --recovery-out"); print(USAGE); return 2; }
      const passcode = await readSecretFile(o.get("passcode-file")!);
      const { keyring, recoveryFile } = await createKeyring({ passcode });
      // Prove both methods open the key before anything is kept (setup is not finished until the recovery file is shown to work).
      await unlockWithPasscode(keyring, passcode); unlockWithRecovery(keyring, recoveryFile);
      await mkdir(dirname(folder), { recursive: true });
      // The keyring is written first and the recovery file second; if the second cannot be written the first is taken away again, so no recovery file is left for a keyring that was never kept (and none is left without its keyring).
      await writeNew(folder, `${JSON.stringify(keyring, null, 2)}\n`);
      try { await writeNew(o.get("recovery-out")!, `${JSON.stringify(recoveryFile)}\n`); } catch (error) { await rm(folder, { force: true }).catch(() => undefined); throw error; }
      print(`encryption set up: key ${keyring.keyId}, fingerprint ${keyringFingerprint(keyring)}; the recovery file is in ${o.get("recovery-out")!}. Keep it OFF this machine (and the passcode in your own safe place): with neither, the encrypted backups cannot be read by anyone. Remove the passcode file now; put a file back only for the moment of a proof.`);
      return 0;
    }
    if (command === "verify") {
      const o = options(rest, ["passcode-file", "recovery-file", "require-encrypted", "allow-plain"]);
      if (typeof o === "string") { print(o); print(USAGE); return 2; }
      const check = await verifyBackup(folder, await unlockFrom(folder, o));
      if (check.ok) { print(`ok: ${check.manifest!.name} (schema ${check.manifest!.schemaVersion}) matches its manifest`); return 0; }
      for (const p of check.problems) print(`problem: ${p}`);
      return 1;
    }
    const opts = options(rest, ["sqlite", "postgres", "schema", "artifacts", "passcode-file", "recovery-file", "require-encrypted", "allow-plain"]);
    if (typeof opts === "string") { print(opts); print(USAGE); return 2; }
    if ((opts.get("sqlite") === undefined) === (opts.get("postgres") === undefined)) { print("give exactly one of --sqlite and --postgres"); return 2; }
    if (opts.get("schema") !== undefined && opts.get("postgres") === undefined) { print("--schema goes with --postgres"); return 2; }
    // What the backup needs to be opened is settled before the new database is touched: a refusal leaves nothing behind.
    const unlocked = await unlockFrom(folder, opts);
    if (unlocked.requireEncrypted === true && (await readManifest(folder)).manifest?.encryption === undefined) throw new RestoreRefused("the backup cannot be restored: the backup is not encrypted, and encryption is required");
    let storage: ControllerStorage & { close(): Promise<void> };
    if (opts.get("sqlite") !== undefined) storage = await SqliteStorage.open({ path: opts.get("sqlite")! });
    else storage = await PostgresStorage.open({ connectionString: opts.get("postgres")!, ...(opts.get("schema") === undefined ? {} : { schema: opts.get("schema")! }) });
    try {
      const blobs = opts.get("artifacts") === undefined ? undefined : await FileBlobStore.open({ directory: opts.get("artifacts")! });
      const done = await restoreBackup(folder, storage, { ...(blobs === undefined ? {} : { blobs }), ...unlocked });
      print(`restored ${done.rows} rows${done.blobsRestored > 0 ? ` and ${done.blobsRestored} artifact files` : ""} from ${done.manifest.name}`);
      if (done.effectsMarkedUncertain > 0) print(`${done.effectsMarkedUncertain} actions on the outside were only intended when the backup was taken; they are marked uncertain and are never run again, so check what really happened`);
      if (done.deliveriesToResend > 0) print(`${done.deliveriesToResend} messages had not been delivered when the backup was taken; they will be sent again`);
      return 0;
    } finally { await storage.close(); }
  } catch (error) {
    // Only messages written for the operator are shown; a parser's or the system's own words may quote a secret file's content or a path, so any other failure gets fixed text.
    print(error instanceof RestoreRefused || error instanceof UnlockFailed || error instanceof SecretFileRefused ? error.message : error instanceof SyntaxError ? "failed: a file is not in the expected format" : `failed: ${error instanceof Error && /^(ENOENT|EEXIST|EACCES|EISDIR|ENOTDIR|EPERM)/.test(String((error as NodeJS.ErrnoException).code ?? "")) ? `the file system said ${(error as NodeJS.ErrnoException).code}` : "the command could not be completed"}`);
    return 1;
  }
}

/** Writes a new file (refuses to overwrite one) readable by the owner alone. */
async function writeNew(path: string, text: string): Promise<void> { await writeFile(path, text, { flag: "wx", mode: 0o600 }); }

/**
 * What verification and restore need from the options. Giving a passcode or a recovery file means the backup must be encrypted (a plain backup swapped in would otherwise be taken without a word). A folder that has held
 * encrypted backups (the marker `createBackup` leaves) refuses a plain one unless `--allow-plain yes`. The keyring used is the backup's own (the wrapped copies it carries); it is checked against the passcode or recovery file, not trusted.
 */
async function unlockFrom(folder: string, o: Map<string, string>): Promise<{ unlock?: BackupKey; requireEncrypted?: true }> {
  const pass = o.get("passcode-file"); const rec = o.get("recovery-file");
  if (pass !== undefined && rec !== undefined) throw new RestoreRefused("give one of --passcode-file and --recovery-file");
  const required = o.get("require-encrypted") === "yes" || pass !== undefined || rec !== undefined;
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
  if (rec !== undefined) {
    let file: unknown;
    try { file = JSON.parse(await readSecretFile(rec)); } catch (error) { throw error instanceof SecretFileRefused ? error : new UnlockFailed("could not unlock: that file is not a recovery file"); }
    return { unlock: unlockWithRecovery(keyring, file), ...(required ? { requireEncrypted: true as const } : {}) };
  }
  return required ? { requireEncrypted: true } : {};
}

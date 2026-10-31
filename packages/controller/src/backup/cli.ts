import { FileBlobStore } from "../artifacts/index.js";
import { PostgresStorage } from "../storage/postgres/index.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { mkdir, open as openFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { UnlockFailed, createKeyring, parseKeyring, unlockWithPasscode, unlockWithRecovery, type BackupKey } from "./crypto.js";
import { readManifest } from "./verify.js";
import { listBackups } from "./retention.js";
import { RestoreRefused, restoreBackup } from "./restore.js";
import { verifyBackup } from "./verify.js";

const USAGE = [
  "usage:",
  "  backup list <backups folder>",
  "  backup verify <backup folder> [--passcode-file <file> | --recovery-file <file>] [--require-encrypted yes]",
  "  backup encryption-setup <new keyring file> --passcode-file <file holding the passcode> --recovery-out <new recovery file>",
  "  backup restore <backup folder> [--passcode-file <file> | --recovery-file <file>] [--require-encrypted yes] (--sqlite <new database file> | --postgres <connection url> [--schema <name>]) [--artifacts <new artifact folder>]",
  "Secrets are only ever read from files (mode 600) and written to new files; none is taken on the command line or printed.",
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
      const passcode = await readSecret(o.get("passcode-file")!);
      const { keyring, recoveryFile } = await createKeyring({ passcode });
      // Prove both methods open the key before anything is kept (setup is not finished until the recovery file is shown to work).
      await unlockWithPasscode(keyring, passcode); unlockWithRecovery(keyring, recoveryFile);
      await mkdir(dirname(folder), { recursive: true });
      await writeNew(o.get("recovery-out")!, `${JSON.stringify(recoveryFile)}\n`);
      await writeNew(folder, `${JSON.stringify(keyring, null, 2)}\n`);
      print(`encryption set up: key ${keyring.keyId}; the recovery file is in ${o.get("recovery-out")!}. Keep it OFF this machine (and the passcode in your own safe place): with neither, the encrypted backups cannot be read by anyone.`);
      return 0;
    }
    if (command === "verify") {
      const o = options(rest, ["passcode-file", "recovery-file", "require-encrypted"]);
      if (typeof o === "string") { print(o); print(USAGE); return 2; }
      const check = await verifyBackup(folder, { ...(await unlockFrom(folder, o) ?? {}), ...(o.get("require-encrypted") === "yes" ? { requireEncrypted: true } : {}) });
      if (check.ok) { print(`ok: ${check.manifest!.name} (schema ${check.manifest!.schemaVersion}) matches its manifest`); return 0; }
      for (const p of check.problems) print(`problem: ${p}`);
      return 1;
    }
    const opts = options(rest, ["sqlite", "postgres", "schema", "artifacts", "passcode-file", "recovery-file", "require-encrypted"]);
    if (typeof opts === "string") { print(opts); print(USAGE); return 2; }
    if ((opts.get("sqlite") === undefined) === (opts.get("postgres") === undefined)) { print("give exactly one of --sqlite and --postgres"); return 2; }
    if (opts.get("schema") !== undefined && opts.get("postgres") === undefined) { print("--schema goes with --postgres"); return 2; }
    let storage: ControllerStorage & { close(): Promise<void> };
    if (opts.get("sqlite") !== undefined) storage = await SqliteStorage.open({ path: opts.get("sqlite")! });
    else storage = await PostgresStorage.open({ connectionString: opts.get("postgres")!, ...(opts.get("schema") === undefined ? {} : { schema: opts.get("schema")! }) });
    try {
      const blobs = opts.get("artifacts") === undefined ? undefined : await FileBlobStore.open({ directory: opts.get("artifacts")! });
      const done = await restoreBackup(folder, storage, { ...(blobs === undefined ? {} : { blobs }), ...(await unlockFrom(folder, opts) ?? {}), ...(opts.get("require-encrypted") === "yes" ? { requireEncrypted: true } : {}) });
      print(`restored ${done.rows} rows${done.blobsRestored > 0 ? ` and ${done.blobsRestored} artifact files` : ""} from ${done.manifest.name}`);
      if (done.effectsMarkedUncertain > 0) print(`${done.effectsMarkedUncertain} actions on the outside were only intended when the backup was taken; they are marked uncertain and are never run again, so check what really happened`);
      if (done.deliveriesToResend > 0) print(`${done.deliveriesToResend} messages had not been delivered when the backup was taken; they will be sent again`);
      return 0;
    } finally { await storage.close(); }
  } catch (error) {
    print(error instanceof RestoreRefused || error instanceof UnlockFailed ? error.message : `failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Reads a secret from a file (never from the command line, so it is not in the process list or shell history). */
async function readSecret(path: string): Promise<string> {
  const h = await openFile(path, "r");
  try {
    const st = await h.stat();
    if (!st.isFile() || st.size > 4096) throw new Error("the secret file must be a small regular file");
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new Error("the secret file can be read by others: set its mode to 600");
    return (await h.readFile("utf8")).replace(/\r?\n$/, "");
  } finally { await h.close(); }
}

/** Writes a new file (refuses to overwrite one) readable by the owner alone. */
async function writeNew(path: string, text: string): Promise<void> { await writeFile(path, text, { flag: "wx", mode: 0o600 }); }

/** The unlocked key for a backup that is encrypted, from the passcode or recovery file named in the options; nothing for a plain backup. The keyring used is the backup's own (the wrapped copies it carries). */
async function unlockFrom(folder: string, o: Map<string, string>): Promise<{ unlock: BackupKey } | undefined> {
  const pass = o.get("passcode-file"); const rec = o.get("recovery-file");
  if (pass !== undefined && rec !== undefined) throw new Error("give one of --passcode-file and --recovery-file");
  const m = await readManifest(folder);
  const seal = m.manifest?.encryption;
  if (seal === undefined) return undefined;
  const keyring = parseKeyring(seal.keyring);
  if (pass !== undefined) return { unlock: await unlockWithPasscode(keyring, await readSecret(pass)) };
  if (rec !== undefined) return { unlock: unlockWithRecovery(keyring, JSON.parse(await readSecret(rec))) };
  return undefined;
}

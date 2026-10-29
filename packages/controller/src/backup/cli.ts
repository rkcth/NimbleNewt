import { FileBlobStore } from "../artifacts/index.js";
import { PostgresStorage } from "../storage/postgres/index.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { listBackups } from "./retention.js";
import { RestoreRefused, restoreBackup } from "./restore.js";
import { verifyBackup } from "./verify.js";

const USAGE = [
  "usage:",
  "  backup list <backups folder>",
  "  backup verify <backup folder>",
  "  backup restore <backup folder> (--sqlite <new database file> | --postgres <connection url> [--schema <name>]) [--artifacts <new artifact folder>]",
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
  if (command === undefined || folder === undefined || !["list", "verify", "restore"].includes(command)) { print(USAGE); return 2; }
  try {
    if (command === "list") {
      if (rest.length > 0) { print(USAGE); return 2; }
      const all = await listBackups(folder);
      if (all.length === 0) print("no complete backups in that folder");
      for (const b of all) print(`${b.manifest.name}  ${b.manifest.kind}  schema ${b.manifest.schemaVersion}  ${b.manifest.files.reduce((n, f) => n + f.rows, 0)} rows`);
      return 0;
    }
    if (command === "verify") {
      if (rest.length > 0) { print(USAGE); return 2; }
      const check = await verifyBackup(folder);
      if (check.ok) { print(`ok: ${check.manifest!.name} (schema ${check.manifest!.schemaVersion}) matches its manifest`); return 0; }
      for (const p of check.problems) print(`problem: ${p}`);
      return 1;
    }
    const opts = options(rest, ["sqlite", "postgres", "schema", "artifacts"]);
    if (typeof opts === "string") { print(opts); print(USAGE); return 2; }
    if ((opts.get("sqlite") === undefined) === (opts.get("postgres") === undefined)) { print("give exactly one of --sqlite and --postgres"); return 2; }
    if (opts.get("schema") !== undefined && opts.get("postgres") === undefined) { print("--schema goes with --postgres"); return 2; }
    let storage: ControllerStorage & { close(): Promise<void> };
    if (opts.get("sqlite") !== undefined) storage = await SqliteStorage.open({ path: opts.get("sqlite")! });
    else storage = await PostgresStorage.open({ connectionString: opts.get("postgres")!, ...(opts.get("schema") === undefined ? {} : { schema: opts.get("schema")! }) });
    try {
      const blobs = opts.get("artifacts") === undefined ? undefined : await FileBlobStore.open({ directory: opts.get("artifacts")! });
      const done = await restoreBackup(folder, storage, { ...(blobs === undefined ? {} : { blobs }) });
      print(`restored ${done.rows} rows${done.blobsRestored > 0 ? ` and ${done.blobsRestored} artifact files` : ""} from ${done.manifest.name}`);
      if (done.effectsMarkedUncertain > 0) print(`${done.effectsMarkedUncertain} actions on the outside were only intended when the backup was taken; they are marked uncertain and are never run again, so check what really happened`);
      if (done.deliveriesToResend > 0) print(`${done.deliveriesToResend} messages had not been delivered when the backup was taken; they will be sent again`);
      return 0;
    } finally { await storage.close(); }
  } catch (error) {
    print(error instanceof RestoreRefused ? error.message : `failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

import { dirname, isAbsolute } from "node:path";
import { canon } from "../backup/canon.js";
import type { StatsFs } from "node:fs";
import type { ControllerStorage } from "../storage/types.js";
import { PostgresStorage, dropPostgresSchema, postgresDatabaseBytes } from "../storage/postgres/index.js";
import { postgresFingerprint, sqliteFingerprint, type TransferTarget } from "./transfer.js";

/**
 * Transfer targets built from the host's configuration (card F04l). The entries may come from untrusted JSON, so every field is checked before a target exists.
 * The name is what chat and the plan show. A SQLite entry has the path where the new database file goes; a PostgreSQL entry has a REFERENCE to the secret that holds its address (the address has a password,
 * so it is resolved here, used only to open, size and empty the destination, and hidden from every error text that leaves this file).
 */

/** One SQLite destination in the configuration. */
export interface SqliteTargetEntry {
  /** What the owner and chat call this destination: 1 to 64 characters of [a-z0-9-], unique in the list. */
  readonly name: string;
  readonly kind: "sqlite";
  /** The database file, absolute (a relative path would name a different file per working directory). */
  readonly path: string;
}

/** One PostgreSQL destination in the configuration. */
export interface PostgresTargetEntry {
  readonly name: string;
  readonly kind: "postgres";
  /** Where the address (with its password) is held: `{ secret: "name" }`. Never the address itself. */
  readonly url: { readonly secret: string };
  /** The schema the controller tables go in; default `nimblenewt`. */
  readonly schema?: string;
  /** The most bytes the destination database may hold. Free room is this minus the size the server reports for the database; without it the room is not known and the preview only warns. */
  readonly maxBytes?: number;
}

/** What building PostgreSQL targets needs from outside. The address is passed in, resolved; none of these may log it. */
export interface PostgresTargetDeps {
  resolveSecret(name: string): Promise<string | undefined>;
  /** Opens (creating if absent) the schema's store. `createdSchema` is whether this open's own transaction created the schema, as PostgresStorage reports it. */
  openStorage(url: string, schema: string): Promise<ControllerStorage & { readonly createdSchema: boolean }>;
  /** The size in bytes the server reports for the whole database. */
  databaseBytes(url: string): Promise<number>;
  /** Drops the schema and everything in it. */
  dropSchema(url: string, schema: string): Promise<void>;
}

/** The real PostgreSQL side of configured targets: the storage's own open (no unsupported-server override) and the server reads and clean-up of the storage folder. The start and the tests use this one wiring. */
export function postgresTargetDeps(resolveSecret: (name: string) => Promise<string | undefined>): PostgresTargetDeps {
  return { resolveSecret, openStorage: (url, schema) => PostgresStorage.open({ connectionString: url, schema }), databaseBytes: postgresDatabaseBytes, dropSchema: dropPostgresSchema };
}

/** What building targets needs from outside: opening a store at a path, reading a file system's room, and (for PostgreSQL entries) the secret store and the server. */
export interface SqliteTargetDeps {
  openStorage(path: string): Promise<ControllerStorage>;
  statfs(path: string): Promise<StatsFs>;
  /** Absent: a PostgreSQL entry is refused. */
  readonly postgres?: PostgresTargetDeps;
}

/** A target name is shown and compared: short, plain, one spelling. */
const NAME = /^[a-z0-9-]{1,64}$/;
/** The secret names the configuration accepts (as in @nimblenewt/config). */
const SECRET_NAME = /^(?!.*__)[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,40}$/;
/** A host configures a handful of destinations; the list is untrusted input, so it gets a bound. */
export const TARGET_ENTRIES_MAX = 16;
/** Longest path accepted; longer is refused before the file system sees it. */
export const TARGET_PATH_MAX = 4096;
/** Absolute on this machine: on Windows a drive or UNC root (a path rooted on the current drive names a different file per working directory). */
const absolute = (p: string): boolean => isAbsolute(p) && p.length <= TARGET_PATH_MAX && !p.includes("\0") && (process.platform !== "win32" || /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/.test(p));

/** Query parameters that would carry a password in an address. */
const QUERY_PASSWORD = /^(?:ssl)?password$/i;

/** Hides a PostgreSQL address from a text: the address itself, its password in any spelling, and anything shaped like a connection URL. */
export function hideAddress(text: string, address: string): string {
  const secrets = new Set<string>([address]);
  try {
    const u = new URL(address);
    // The user name is not hidden as a bare word (a short one would mangle ordinary text); it goes with the address and with "user:password@".
    if (u.password !== "") {
      secrets.add(u.password); secrets.add(encodeURIComponent(u.password));
      try { secrets.add(decodeURIComponent(u.password)); } catch { /* the raw spelling is hidden anyway */ }
      if (u.username !== "") secrets.add(`${u.username}:${u.password}@`);
    }
    // A password given as a query parameter (the driver honours ?password=; a target entry refuses both spellings, but this function hides them whatever text it is given).
    for (const [key, value] of u.searchParams) {
      if (!QUERY_PASSWORD.test(key) || value === "") continue;
      secrets.add(value); secrets.add(encodeURIComponent(value)); secrets.add(new URLSearchParams([["x", value]]).toString().slice(2));
    }
  } catch { /* an address that does not parse is hidden whole */ }
  let out = text;
  for (const secret of [...secrets].filter((x) => x.length > 0).sort((a, b) => b.length - a.length)) out = out.split(secret).join("[address hidden]");
  return out.replace(/postgres(?:ql)?:\/\/\S*/gi, "[address hidden]");
}

/** Runs `work`; a failure is rethrown with the address hidden from its message (the stack and any other property are dropped, as they could carry the address too). */
async function hiding<T>(address: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw new Error(hideAddress(error instanceof Error ? error.message : "failed", address).slice(0, 300)); }
}

/**
 * The transfer targets the configuration names. Every refusal is an Error naming the entry's index and the problem; one bad entry returns no targets.
 * The fingerprint is taken at build time (links resolved), so a second spelling of the same existing path is refused. A file that does not exist yet keeps the spelling of its missing part, so on a case-insensitive file system two spellings of a new file can still pass; the transfer service refuses a destination that already holds data.
 * A refusal about a PostgreSQL entry names the secret (a name, not a value) and never the address.
 */
export async function transferTargetsFromConfig(entries: readonly unknown[], deps: SqliteTargetDeps): Promise<TransferTarget[]> {
  if (!Array.isArray(entries)) throw new Error("transfer targets: must be a list of { name, kind, path } or { name, kind, url } entries");
  if (entries.length > TARGET_ENTRIES_MAX) throw new Error(`transfer targets: at most ${TARGET_ENTRIES_MAX} entries (got ${entries.length})`);
  const refuse = (i: number, problem: string): never => { throw new Error(`transfer targets[${i}]: ${problem}`); };
  const names = new Set<string>();
  const places = new Map<string, number>();
  const out: TransferTarget[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) refuse(i, "must be an object { name, kind, path } or { name, kind, url }");
    const o = entry as Record<string, unknown>;
    const kind = o["kind"];
    if (kind !== "sqlite" && kind !== "postgres") refuse(i, 'kind: must be "sqlite" or "postgres"');
    if (kind === "postgres" && deps.postgres === undefined) refuse(i, 'kind: "postgres" targets cannot be built here (no PostgreSQL support was given)');
    const allowed = kind === "sqlite" ? ["name", "kind", "path"] : ["name", "kind", "url", "schema", "maxBytes"];
    for (const key of Object.keys(o)) if (!allowed.includes(key)) refuse(i, `${key.slice(0, 30).replace(/[^\x20-\x7e]/g, "?")}: is not a field of a ${String(kind)} target entry`);
    const name = typeof o["name"] === "string" && NAME.test(o["name"]) ? o["name"] : refuse(i, "name: must be 1 to 64 characters of [a-z0-9-]");
    if (names.has(name)) refuse(i, `name: ${name} is used by another entry`);
    if (kind === "postgres") {
      const pg = deps.postgres!;
      const ref = o["url"];
      const secretName = ref !== null && typeof ref === "object" && !Array.isArray(ref) && Object.keys(ref).length === 1 && typeof (ref as Record<string, unknown>)["secret"] === "string" && SECRET_NAME.test((ref as { secret: string }).secret) ? (ref as { secret: string }).secret : refuse(i, 'url: must be a secret reference { "secret": "name" } (the address holds a password and is never written in configuration)');
      const schema = o["schema"] === undefined ? "nimblenewt" : typeof o["schema"] === "string" && SCHEMA_NAME.test(o["schema"]) ? o["schema"] : refuse(i, "schema: must be lower-case letters, digits and underscores, starting with a letter (at most 41 characters)");
      const maxBytes = o["maxBytes"] === undefined ? undefined : typeof o["maxBytes"] === "number" && Number.isSafeInteger(o["maxBytes"]) && o["maxBytes"] > 0 ? o["maxBytes"] : refuse(i, "maxBytes: must be a positive whole number of bytes");
      let address: string | undefined;
      try { address = await pg.resolveSecret(secretName); } catch { refuse(i, `url: the secret ${secretName} could not be read`); }
      if (address === undefined || address === "") refuse(i, `url: the secret ${secretName} is not available`);
      const url = address as string;
      if (!/^postgres(?:ql)?:\/\//i.test(url)) refuse(i, `url: the secret ${secretName} does not hold a postgres:// address`);
      // One rule for where the password goes: the user:password@ part. A query-string password (honoured by the driver) or an SSL key passphrase is refused, without echoing it.
      let queryPassword = false;
      try { queryPassword = [...new URL(url).searchParams.keys()].some((key) => QUERY_PASSWORD.test(key)); } catch { /* an unreadable address is refused just below */ }
      if (queryPassword) refuse(i, `url: the secret ${secretName} holds a password as a query parameter (password= or sslpassword=); put the password in the user:password@ part of the address`);
      let fingerprint: string;
      try { fingerprint = postgresFingerprint(url, schema); } catch { refuse(i, `url: the secret ${secretName} does not hold a readable PostgreSQL address`); throw new Error("unreachable"); }
      const earlier = places.get(fingerprint);
      if (earlier !== undefined) refuse(i, `url: is the same place as entry ${earlier}`);
      names.add(name); places.set(fingerprint, i);
      // Set when an open of this target reports that its own transaction created the schema (learned from the open itself, so a schema someone else creates
      // before or during the open is never counted), and forgotten after the drop. Only such a schema is dropped after a failed copy: a schema that was there
      // before (the database's `public`, one the owner prepared with grants, or one holding other objects) is never dropped; the owner is told the destination
      // is not clean instead. A failed open claims nothing.
      let created = false;
      out.push({
        name, kind: "postgres", fingerprint,
        open: () => hiding(url, async () => { const store = await pg.openStorage(url, schema); if (store.createdSchema) created = true; return store; }),
        // The server's own figure for the database, against the cap the configuration gives: PostgreSQL cannot tell a client how much disk is left, so without a cap nothing is claimed.
        freeBytes: maxBytes === undefined ? async () => undefined : () => hiding(url, async () => Math.max(0, maxBytes - (await pg.databaseBytes(url)))),
        discard: () => hiding(url, async () => {
          if (!created) throw new Error(`the schema ${schema} was not created by this controller's own open, so it is not dropped; empty it by hand`);
          await pg.dropSchema(url, schema);
          created = false; // a schema of this name made later is someone else's until an open of this target creates it again
        }),
        redact: (text) => hideAddress(text, url),
      });
      continue;
    }
    const path = typeof o["path"] === "string" && absolute(o["path"]) ? o["path"] : refuse(i, "path: must be an absolute path");
    let fingerprint: string;
    try { fingerprint = await sqliteFingerprint(path); } catch { refuse(i, "path: cannot be resolved on this machine"); throw new Error("unreachable"); }
    const earlier = places.get(fingerprint);
    if (earlier !== undefined) refuse(i, `path: is the same place as entry ${earlier}`);
    names.add(name); places.set(fingerprint, i);
    out.push({
      name, kind: "sqlite", fingerprint, open: () => deps.openStorage(path),
      // The room of the file system the file will be on: the folder may not exist yet, so probe the nearest existing directory at or above the path's folder.
      freeBytes: async () => {
        let probe: string;
        try { probe = await canon(dirname(path)); } catch { return undefined; }
        for (;;) {
          try { const s = await deps.statfs(probe); return Number(s.bavail) * Number(s.bsize); } catch (error) {
            const parent = dirname(probe);
            if (parent === probe || (error as NodeJS.ErrnoException | null)?.code !== "ENOENT") return undefined;
            probe = parent;
          }
        }
      },
    });
  }
  return out;
}

/** The first slice's name for the same function (a list with only SQLite entries behaves as before). */
export const sqliteTargetsFromConfig = transferTargetsFromConfig;

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canon } from "../backup/canon.js";
import type { MaintenanceBarrier } from "../backup/barrier.js";
import { DomainError } from "../domain/errors.js";
import { canonicalJson } from "../storage/json.js";
import { ID_PATTERN, KIND_PATTERN, TIMESTAMP_PATTERN, type ControllerStorage } from "../storage/types.js";
import { SNAPSHOT_PAGE_MAX, SNAPSHOT_TABLES, type SnapshotRow, type SnapshotTable, type StorageSnapshot } from "../storage/snapshot.js";

/**
 * Chat-controlled controller database transfer (card F04e): the logical move of the whole controller store from SQLite to PostgreSQL or back, through the same table rows a backup uses (so a body round-trips byte for byte).
 *
 * Order of an apply: the maintenance barrier is raised (new admissions are refused, running attempts must have ended, in-flight work settles); the destination must be empty (a store no controller has owned, same schema version) and have room;
 * the source is read from one consistent snapshot and checked (IDs, sequences, policy records, receipts, effects, timers, artifact and checkpoint references); the rows are copied table by table (claims taken by the drained controller
 * are released: a claimed delivery or timer is pending again); the destination is read back and each table's count and digest must equal what was written; the source is unchanged since the start; the source is FENCED (its epoch is
 * taken, so a deposed controller cannot write); and only then does the authority file name the destination. Everything up to the fence leaves the source exactly as it was (a failure puts the barrier down, empties the destination if the target can, and records why);
 * a failure between the fence and the authority file is finished or abandoned at the next start (`resolveAtStart`). The authority file is what makes the destination the only database a controller will start on: a start whose configured
 * database is not the authoritative one is refused (`assertStorageAuthority`). After the switch the barrier stays up until the controller is restarted on the new database (the host's configuration must point at it).
 * Rollback to the source is allowed only while the destination has recorded nothing since the switch; after that the way back is a reverse transfer, which is the same operation in the other direction.
 */
export const TRANSFER_JOURNAL = "database-transfer-journal.json";
export const AUTHORITY_FILE = "storage-authority.json";

export type StorageKind = "sqlite" | "postgres";

/** A database a transfer can write to. It is named by the host's configuration (a PostgreSQL URL holds a password, so it never comes from chat). */
export interface TransferTarget {
  readonly name: string;
  readonly kind: StorageKind;
  /** A stable spelling of the place, without credentials: what the authority file compares. */
  readonly fingerprint: string;
  /** Opens the (new, empty) destination. The caller closes it. */
  open(): Promise<ControllerStorage>;
  /** Bytes free where the database will be written; undefined when that cannot be known (a SQLite destination must know). */
  freeBytes?(): Promise<number | undefined>;
  /** Empties the destination after a failed copy (the store is closed first). Absent: the owner is told the destination is dirty. */
  discard?(): Promise<void>;
}

export interface TransferSource { readonly kind: StorageKind; readonly fingerprint: string; readonly name: string }
type Place = { readonly kind: StorageKind; readonly fingerprint: string; readonly name: string };

export type TransferPhase = "copying" | "fencing" | "switched" | "failed" | "rolled-back" | "abandoned";
const TERMINAL: readonly TransferPhase[] = ["switched", "failed", "rolled-back", "abandoned"];
type Mark = { readonly epoch: number; readonly auditSeq: number; readonly deliverySeq: number };

export interface TransferJournal {
  readonly format: 1;
  readonly id: string;
  readonly direction: string;
  readonly from: Place;
  readonly to: Place;
  readonly phase: TransferPhase;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly sourceMark?: Mark;
  /** The destination's counters right after the copy: a rollback is safe only while they are unchanged. */
  readonly destinationMark?: Mark;
  readonly counts?: Readonly<Record<string, number>>;
  readonly failure?: { readonly at: string; readonly phase: string; readonly reason: string; readonly destinationClean: boolean };
  readonly note?: string;
}

export interface StorageAuthority {
  readonly format: 1;
  readonly generation: number;
  readonly active: Place;
  readonly previous?: Place;
  readonly transferId?: string;
  readonly since: string;
}

export interface TransferFinding { readonly severity: "error" | "warning"; readonly text: string }

export interface TransferPlan {
  /** Apply needs exactly this. It is bound to the direction, both places, the schema version and the authority generation. */
  readonly token: string;
  readonly direction: string;
  readonly from: TransferSource;
  readonly to: { readonly name: string; readonly kind: StorageKind };
  readonly schemaVersion: number;
  readonly rows: Readonly<Record<string, number>>;
  readonly totalRows: number;
  readonly bytes: number;
  readonly bytesNeeded: number;
  readonly freeBytes?: number;
  readonly uncertainEffects: number;
  readonly intendedEffects: number;
  readonly claimsReleased: number;
  readonly ok: boolean;
  readonly findings: readonly TransferFinding[];
  readonly steps: readonly string[];
}

/** Checks outside the database: each answers the ones that are MISSING. */
export interface TransferReferences {
  artifacts?(digests: readonly string[]): Promise<readonly string[]>;
  checkpoints?(points: readonly { readonly id: string; readonly attemptId: string; readonly checkpoint: string }[]): Promise<readonly string[]>;
}

export type TransferPoint = "drained" | "validated" | `copy:${SnapshotTable}` | "copied" | "verified" | "before-fence" | "fenced" | "authority-written";

export interface TransferOptions {
  readonly storage: Pick<ControllerStorage, "snapshot" | "acquireEpoch">;
  readonly source: TransferSource;
  readonly targets: () => readonly TransferTarget[];
  readonly dataDirectory: string;
  readonly barrier: MaintenanceBarrier;
  readonly references?: TransferReferences;
  readonly now?: () => Date;
  /** Test hook: runs at each stage and may throw, to prove a failure there leaves the source whole. */
  readonly inject?: (point: TransferPoint) => void | Promise<void>;
  /** Told when a switch is done and the controller must be restarted on the new database. */
  readonly onSwitched?: (authority: StorageAuthority) => void;
  readonly pageSize?: number;
}

/** Room needed relative to the rows' text: indexes, the write-ahead log and slack. Provisional. */
export const CAPACITY_FACTOR = 2;

const bad = (message: string): never => { throw new DomainError("invalid_command", message); };
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Writes a small JSON file whole or not at all (temp file in the same folder, flushed, renamed). */
async function writeJson(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await open(temp, "w");
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, path); } catch (error) { await rm(temp, { force: true }); throw error; }
}
async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try { return JSON.parse(text) as T; } catch { throw new DomainError("unavailable", `${path} cannot be read (it is not valid JSON); a database transfer is not started until it is looked at`); }
}

export const readAuthority = (dataDirectory: string): Promise<StorageAuthority | undefined> => readJson<StorageAuthority>(join(dataDirectory, AUTHORITY_FILE));
export const readJournal = (dataDirectory: string): Promise<TransferJournal | undefined> => readJson<TransferJournal>(join(dataDirectory, TRANSFER_JOURNAL));

/** The place of a SQLite file, spelled the one way (links resolved) so the same file never looks like two databases. */
export async function sqliteFingerprint(path: string): Promise<string> { return `sqlite:${await canon(path)}`; }
/** PostgreSQL: server, port, database and schema; never the user or password. */
export function postgresFingerprint(url: string, schema = "nimblenewt"): string {
  let u: URL;
  try { u = new URL(url); } catch { return `postgres:invalid#${schema}`; }
  return `postgres:${u.hostname.toLowerCase()}:${u.port === "" ? "5432" : u.port}${u.pathname}#${schema}`;
}

/**
 * The start-time guard: once a transfer has switched, only the database the authority file names may be started on. A start on another one (the old configuration after a transfer, a copy restored from a backup) is refused with
 * where the data is now. No file: nothing was ever transferred, any configuration is fine.
 */
export async function assertStorageAuthority(dataDirectory: string, configured: { readonly fingerprint: string }): Promise<void> {
  const authority = await readAuthority(dataDirectory);
  if (authority === undefined || authority.active.fingerprint === configured.fingerprint) return;
  throw new Error(`NimbleNewt will not start: the controller database was moved to ${authority.active.name} (${authority.active.kind}) by a database transfer on ${authority.since}, and this start is configured for another database. Point controller.storage at ${authority.active.name}, or ask in chat to roll the transfer back.`);
}

/**
 * Settles an interrupted transfer before the database is opened. A journal left in `fencing` (the source was fenced, the authority file not yet written): a start on the destination finishes the switch (it was verified), a start on the source
 * abandons the transfer (the source is whole and a start takes a new epoch). A journal left in `copying` is a copy that never reached the fence: the source stays authoritative; the note says the destination may hold a partial copy.
 */
export async function resolveAtStart(dataDirectory: string, configured: { readonly fingerprint: string }, now: () => Date = () => new Date()): Promise<{ resolved?: "finished" | "abandoned"; note?: string }> {
  const journal = await readJournal(dataDirectory);
  if (journal === undefined || TERMINAL.includes(journal.phase)) return {};
  const at = now().toISOString();
  const previous = await readAuthority(dataDirectory);
  const journalFile = join(dataDirectory, TRANSFER_JOURNAL);
  if (previous?.transferId === journal.id && previous.active.fingerprint === journal.to.fingerprint) {
    await writeJson(journalFile, { ...journal, phase: "switched", updatedAt: at, note: "the authority file was written; the journal was settled at the start" } satisfies TransferJournal);
    return { resolved: "finished", note: `database transfer ${journal.id}: settled at start; the controller database is ${journal.to.name}` };
  }
  if (journal.phase === "fencing" && journal.to.fingerprint === configured.fingerprint) {
    await writeJson(join(dataDirectory, AUTHORITY_FILE), { format: 1, generation: (previous?.generation ?? 0) + 1, active: journal.to, previous: journal.from, transferId: journal.id, since: at } satisfies StorageAuthority);
    await writeJson(journalFile, { ...journal, phase: "switched", updatedAt: at, note: "finished at the start: the copy had been verified and the source fenced" } satisfies TransferJournal);
    return { resolved: "finished", note: `database transfer ${journal.id}: finished at start; the controller database is now ${journal.to.name}` };
  }
  if (journal.from.fingerprint !== configured.fingerprint) return {};
  const note = journal.phase === "copying" ? "the copy never reached the fence; the destination may hold a partial copy and must be emptied before another transfer" : "stopped after the source was fenced and before the switch; the source is authoritative again";
  await writeJson(journalFile, { ...journal, phase: "abandoned", updatedAt: at, note } satisfies TransferJournal);
  return { resolved: "abandoned", note: `database transfer ${journal.id}: abandoned at start (${note})` };
}

/** A SQLite target for a file: free space from the file system the file will be on. */
export async function sqliteTarget(input: { name: string; path: string; open: () => Promise<ControllerStorage>; discard?: () => Promise<void> }): Promise<TransferTarget> {
  const fingerprint = await sqliteFingerprint(input.path);
  return {
    name: input.name, kind: "sqlite", fingerprint, open: input.open, ...(input.discard === undefined ? {} : { discard: input.discard }),
    freeBytes: async () => {
      let probe = await canon(dirname(input.path));
      for (;;) {
        try { const s = await statfs(probe); return Number(s.bavail) * Number(s.bsize); } catch (error) {
          const parent = dirname(probe);
          if (parent === probe || (error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
          probe = parent;
        }
      }
    },
  };
}

interface CopyStats { rows: Record<string, number>; digests: Record<string, string> }
interface ScanReport { rows: Record<string, number>; bytes: number; findings: TransferFinding[]; uncertain: number; intended: number; claims: number }

export class DatabaseTransferService {
  readonly #o: TransferOptions;
  #running = false;
  #release: (() => Promise<void>) | undefined;
  constructor(options: TransferOptions) { this.#o = options; }

  #now(): string { return (this.#o.now ?? (() => new Date()))().toISOString(); }
  #journalPath(): string { return join(this.#o.dataDirectory, TRANSFER_JOURNAL); }
  #size(): number { return this.#o.pageSize ?? SNAPSHOT_PAGE_MAX; }

  /** The databases a transfer may go to (never the one in use). */
  targets(): readonly { name: string; kind: StorageKind; direction: string }[] {
    return this.#o.targets().filter((t) => t.fingerprint !== this.#o.source.fingerprint).map((t) => ({ name: t.name, kind: t.kind, direction: `${this.#o.source.kind} to ${t.kind}` }));
  }
  #target(name: unknown): TransferTarget {
    if (typeof name !== "string" || name.length === 0) return bad("say which database to move to, by the name database.transfer.status lists");
    const found = this.#o.targets().find((t) => t.name === name);
    if (found === undefined) return bad(`no database called ${name.slice(0, 60)} is configured as a transfer target`);
    if (found.fingerprint === this.#o.source.fingerprint) return bad("that is the database in use now");
    return found;
  }

  async status(): Promise<{ authority?: StorageAuthority; journal?: TransferJournal; source: TransferSource; barrier: boolean; targets: ReturnType<DatabaseTransferService["targets"]> }> {
    const authority = await readAuthority(this.#o.dataDirectory), journal = await readJournal(this.#o.dataDirectory);
    return { ...(authority === undefined ? {} : { authority }), ...(journal === undefined ? {} : { journal }), source: this.#o.source, barrier: this.#o.barrier.held, targets: this.targets() };
  }

  #token(target: TransferTarget, schemaVersion: number, generation: number): string {
    return sha(canonicalJson({ direction: `${this.#o.source.kind}>${target.kind}`, from: this.#o.source.fingerprint, to: target.fingerprint, schemaVersion, generation })).slice(0, 32);
  }

  /** Reads the source and the destination and says what an apply would do, with every finding. Changes nothing (the destination is opened and closed). */
  async preview(targetName: unknown): Promise<TransferPlan> {
    const target = this.#target(targetName);
    const authority = await readAuthority(this.#o.dataDirectory);
    if (authority !== undefined && authority.active.fingerprint !== this.#o.source.fingerprint) bad(`the authoritative database is ${authority.active.name}, not the one in use; a transfer starts from the authoritative database`);
    const findings: TransferFinding[] = [];
    const journal = await readJournal(this.#o.dataDirectory);
    if (journal !== undefined && !TERMINAL.includes(journal.phase)) findings.push({ severity: "error", text: `transfer ${journal.id} is not finished (${journal.phase}); it is settled at the next start` });
    const snap = await this.#o.storage.snapshot();
    let report: ScanReport, schemaVersion: number;
    try { schemaVersion = snap.schemaVersion; report = await this.scan(snap); } finally { await snap.close(); }
    findings.push(...report.findings);
    const bytesNeeded = Math.ceil(report.bytes * CAPACITY_FACTOR);
    const destination = await target.open();
    try {
      const probe = await destination.snapshot();
      try {
        if (probe.schemaVersion !== schemaVersion) findings.push({ severity: "error", text: `the destination has schema version ${probe.schemaVersion} and the source ${schemaVersion}` });
        const state = (await probe.read("state", { limit: 1 }))[0];
        if (state === undefined || Number(state["epoch"]) !== 0) findings.push({ severity: "error", text: "the destination is not empty: a controller has already owned it. A transfer goes into a new, empty database." });
        else for (const table of SNAPSHOT_TABLES) if (table !== "state" && (await probe.read(table, { limit: 1 })).length > 0) { findings.push({ severity: "error", text: `the destination already holds ${table} records (a partial copy?); empty it first` }); break; }
      } finally { await probe.close(); }
    } finally { await destination.close(); }
    let freeBytes: number | undefined;
    try { freeBytes = await target.freeBytes?.(); } catch { freeBytes = undefined; }
    if (freeBytes === undefined) findings.push(target.kind === "sqlite" ? { severity: "error", text: "the free room where the SQLite file will be written cannot be read, so a transfer back to SQLite is not started (capacity must be checked)" } : { severity: "warning", text: `the free room on the PostgreSQL server is not checked from here; make sure it has about ${bytesNeeded} bytes free` });
    else if (freeBytes < bytesNeeded) findings.push({ severity: "error", text: `not enough room at the destination: about ${bytesNeeded} bytes are needed (the rows are ${report.bytes} bytes; indexes and the log are counted) and ${freeBytes} are free` });
    const direction = `${this.#o.source.kind} to ${target.kind}`;
    return {
      token: this.#token(target, schemaVersion, authority?.generation ?? 0), direction, from: this.#o.source, to: { name: target.name, kind: target.kind }, schemaVersion, rows: report.rows,
      totalRows: Object.values(report.rows).reduce((a, b) => a + b, 0), bytes: report.bytes, bytesNeeded, ...(freeBytes === undefined ? {} : { freeBytes }),
      uncertainEffects: report.uncertain, intendedEffects: report.intended, claimsReleased: report.claims, ok: !findings.some((f) => f.severity === "error"), findings,
      steps: [
        "New work is refused and the controller waits for running work to settle (agent attempts must have ended).",
        `Every record is copied from ${this.#o.source.name} to ${target.name} and read back; counts and digests must match.`,
        "Delivery and timer claims held by this controller are released (they are pending again); uncertain actions stay uncertain and are never run again.",
        "The current database is fenced (no controller can write to it) and the destination becomes the only database a controller will start on.",
        "The controller then stops serving until it is restarted with controller.storage pointing at the new database. Until the new database records anything, the transfer can be rolled back.",
      ],
    };
  }

  /** The checks over one snapshot, and the sizes. Reads everything once; nothing is kept. */
  async scan(snap: StorageSnapshot): Promise<ScanReport> {
    const findings: TransferFinding[] = [];
    const rows: Record<string, number> = {};
    let bytes = 0, uncertain = 0, intended = 0, claims = 0;
    const err = (text: string): void => { if (findings.filter((f) => f.severity === "error").length < 20) findings.push({ severity: "error", text }); };
    const state = (await snap.read("state", { limit: 1 }))[0];
    if (state === undefined) { err("the source has no state record"); return { rows, bytes, findings, uncertain, intended, claims }; }
    const artifactIds = new Set<string>(), digests = new Set<string>(), points: { id: string; attemptId: string; checkpoint: string; artifactId: string; taskId: string }[] = [];
    const taskIds = new Set<string>(), attemptIds = new Set<string>();
    let maxAudit = 0, maxDelivery = 0, auditPrev = 0, policyRecords = 0;
    const ids = (table: string, row: SnapshotRow, columns: readonly string[]): void => { for (const c of columns) { const v = row[c]; if (typeof v !== "string" || !ID_PATTERN.test(v)) err(`${table}: ${c} ${JSON.stringify(String(v).slice(0, 40))} is not a valid ID`); } };
    const stamp = (table: string, row: SnapshotRow, columns: readonly string[]): void => { for (const c of columns) { const v = row[c]; if (v !== null && v !== undefined && (typeof v !== "string" || !TIMESTAMP_PATTERN.test(v))) err(`${table}: ${c} ${JSON.stringify(String(v).slice(0, 40))} is not a timestamp`); } };
    const json = (table: string, row: SnapshotRow, column: string): Record<string, unknown> | undefined => {
      try { const v = JSON.parse(String(row[column])) as unknown; if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object"); return v as Record<string, unknown>; } catch { err(`${table}: ${column} of ${String(row["id"] ?? row["operation_id"] ?? row["delivery_id"] ?? row["timer_id"] ?? row["seq"]).slice(0, 80)} is not a JSON object`); return undefined; }
    };
    for (const table of SNAPSHOT_TABLES) {
      let after: SnapshotRow | undefined, count = 0;
      for (;;) {
        const page = await snap.read(table, { ...(after === undefined ? {} : { after }), limit: this.#size() });
        for (const row of page) {
          count += 1;
          for (const v of Object.values(row)) bytes += typeof v === "string" ? Buffer.byteLength(v) : v === null ? 0 : 8;
          if (table === "operations") { ids(table, row, ["operation_id", "correlation_id"]); json(table, row, "result"); }
          else if (table === "aggregates") {
            const kind = String(row["kind"]), id = String(row["id"]);
            if (!KIND_PATTERN.test(kind)) err(`aggregates: kind ${JSON.stringify(kind.slice(0, 40))} is not valid`);
            ids(table, row, ["id"]);
            if (typeof row["revision"] !== "number" || row["revision"] < 1) err(`aggregates: ${kind}/${id} has no revision`);
            const body = json(table, row, "body");
            if (kind === "policy" || kind.endsWith("-policy")) policyRecords += 1;
            if (body === undefined) continue;
            if (kind === "artifact") { artifactIds.add(id); for (const e of (Array.isArray(body["entries"]) ? body["entries"] : []) as { digest?: unknown }[]) if (typeof e?.digest === "string") digests.add(e.digest); }
            else if (kind === "task") taskIds.add(id);
            else if (kind === "attempt") attemptIds.add(id);
            else if (kind === "recovery-point") points.push({ id, attemptId: String(body["attemptId"]), taskId: String(body["taskId"]), artifactId: String(body["artifactId"]), checkpoint: canonicalJson((body["checkpoint"] ?? null) as never) });
          } else if (table === "audit") {
            ids(table, row, ["operation_id"]); stamp(table, row, ["at"]); json(table, row, "detail");
            const seq = Number(row["seq"]);
            if (seq <= auditPrev) err(`audit: sequence ${seq} is not above the one before it`);
            auditPrev = seq; maxAudit = Math.max(maxAudit, seq);
          } else if (table === "deliveries") {
            ids(table, row, ["delivery_id"]); stamp(table, row, ["next_attempt_at", "claimed_until", "delivered_at"]); json(table, row, "payload");
            maxDelivery = Math.max(maxDelivery, Number(row["seq"]));
            const name = String(row["delivery_id"]).slice(0, 60);
            if (row["state"] === "delivered") { if (row["receipt"] === null || row["receipt"] === undefined) err(`deliveries: ${name} is delivered and has no receipt`); else json(table, row, "receipt"); }
            else if (row["receipt"] !== null && row["receipt"] !== undefined) err(`deliveries: ${name} has a receipt but is not delivered`);
            if (row["state"] === "claimed") claims += 1;
          } else if (table === "effects") {
            ids(table, row, ["effect_id", "operation_id"]);
            if (row["status"] === "uncertain") uncertain += 1; else if (row["status"] === "intended") intended += 1;
            if (typeof row["input_digest"] !== "string" || !/^[0-9a-f]{64}$/.test(row["input_digest"])) err(`effects: ${String(row["effect_id"]).slice(0, 60)} has no valid input digest`);
          } else if (table === "timers") {
            ids(table, row, ["timer_id"]); stamp(table, row, ["due_at", "claimed_until"]); json(table, row, "payload");
            if (row["state"] === "claimed") claims += 1;
          }
        }
        if (page.length < this.#size() || table === "state") break;
        after = page[page.length - 1];
      }
      rows[table] = count;
    }
    if (maxAudit !== Number(state["audit_seq"])) err(`the audit counter is ${String(state["audit_seq"])} and the last audit record is ${maxAudit}`);
    if (maxDelivery > Number(state["delivery_seq"])) err(`a delivery has sequence ${maxDelivery}, above the counter ${String(state["delivery_seq"])}`);
    if (policyRecords === 0) findings.push({ severity: "warning", text: "the source holds no policy record: the destination will start from the built-in policy, as the source does" });
    if (uncertain + intended > 0) findings.push({ severity: "warning", text: `${uncertain} uncertain and ${intended} intended actions are carried over as they are; they are reconciled with the outside world and never run again by the transfer` });
    for (const p of points) {
      if (!artifactIds.has(p.artifactId)) err(`recovery point ${p.id} names artifact ${p.artifactId}, which is not in the source`);
      if (!taskIds.has(p.taskId)) err(`recovery point ${p.id} names task ${p.taskId}, which is not in the source`);
      if (!attemptIds.has(p.attemptId)) err(`recovery point ${p.id} names attempt ${p.attemptId}, which is not in the source`);
    }
    if (this.#o.references?.artifacts !== undefined && digests.size > 0) {
      let missing: readonly string[] = [];
      try { missing = await this.#o.references.artifacts([...digests]); } catch (error) { err(`artifact files could not be checked: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); }
      for (const d of missing.slice(0, 10)) err(`artifact file ${d.slice(0, 16)} is not in the artifact store`);
      if (missing.length > 10) err(`${missing.length - 10} more artifact files are missing`);
    } else if (digests.size > 0) findings.push({ severity: "warning", text: `${digests.size} artifact files are referenced; the artifact store is not checked here (it is not moved by a database transfer)` });
    if (this.#o.references?.checkpoints !== undefined && points.length > 0) {
      let missing: readonly string[] = [];
      try { missing = await this.#o.references.checkpoints(points.map((p) => ({ id: p.id, attemptId: p.attemptId, checkpoint: p.checkpoint }))); } catch (error) { err(`conversation checkpoints could not be checked: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); }
      for (const id of missing.slice(0, 10)) err(`checkpoint of recovery point ${id} is not in the conversation store`);
    }
    return { rows, bytes, findings, uncertain, intended, claims };
  }

  async #at(point: TransferPoint): Promise<void> { await this.#o.inject?.(point); }

  async #journal(journal: TransferJournal, patch: Partial<TransferJournal>): Promise<TransferJournal> {
    const next = { ...journal, ...patch, updatedAt: this.#now() } as TransferJournal;
    await writeJson(this.#journalPath(), next);
    return next;
  }

  /** Streams every table of `snap` into `dest` (claims released) and returns what was written, per table. */
  async #copy(snap: StorageSnapshot, dest: ControllerStorage): Promise<CopyStats> {
    const stats: CopyStats = { rows: {}, digests: {} };
    for (const table of SNAPSHOT_TABLES) {
      await this.#at(`copy:${table}`);
      let after: SnapshotRow | undefined, count = 0;
      const hash = createHash("sha256");
      for (;;) {
        const page = await snap.read(table, { ...(after === undefined ? {} : { after }), limit: this.#size() });
        const out = page.map((row) => releaseClaim(table, row));
        if (out.length > 0) { await dest.restoreRows(table, out); for (const row of out) hash.update(`${canonicalJson(row)}\n`); }
        count += out.length;
        if (page.length < this.#size() || table === "state") break;
        after = page[page.length - 1];
      }
      stats.rows[table] = count; stats.digests[table] = hash.digest("hex");
    }
    return stats;
  }

  async #readBack(dest: ControllerStorage, stats: CopyStats): Promise<void> {
    const snap = await dest.snapshot();
    try {
      for (const table of SNAPSHOT_TABLES) {
        let after: SnapshotRow | undefined, count = 0;
        const hash = createHash("sha256");
        for (;;) {
          const page = await snap.read(table, { ...(after === undefined ? {} : { after }), limit: this.#size() });
          for (const row of page) hash.update(`${canonicalJson(row)}\n`);
          count += page.length;
          if (page.length < this.#size() || table === "state") break;
          after = page[page.length - 1];
        }
        if (count !== stats.rows[table]) throw new Error(`${table}: ${count} records read back and ${String(stats.rows[table])} written`);
        if (hash.digest("hex") !== stats.digests[table]) throw new Error(`${table}: the records read back differ from the ones written`);
      }
    } finally { await snap.close(); }
  }

  async #mark(storage: Pick<ControllerStorage, "snapshot">): Promise<Mark> {
    const snap = await storage.snapshot();
    try { const s = (await snap.read("state", { limit: 1 }))[0]; return { epoch: Number(s?.["epoch"] ?? 0), auditSeq: Number(s?.["audit_seq"] ?? 0), deliverySeq: Number(s?.["delivery_seq"] ?? 0) }; } finally { await snap.close(); }
  }

  /** Moves the whole store to `targetName`. `confirm` is the token of the preview the owner approved. */
  async apply(targetName: unknown, confirm: unknown): Promise<{ id: string; direction: string; to: string; rows: number; claimsReleased: number; uncertainEffects: number; restartRequired: true; findings: readonly TransferFinding[] }> {
    const target = this.#target(targetName);
    if (this.#running || this.#o.barrier.held) throw new DomainError("unavailable", "a transfer or another maintenance operation is already running");
    this.#running = true;
    try {
      const plan = await this.preview(targetName);
      if (typeof confirm !== "string" || confirm !== plan.token) bad("the confirmation does not match the plan; ask for the preview again and approve that");
      if (!plan.ok) throw new DomainError("invalid_transition", `the transfer is not started: ${plan.findings.filter((f) => f.severity === "error").map((f) => f.text).join("; ")}`);
      const id = `xfer-${this.#now().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 6)}`;
      let journal: TransferJournal = { format: 1, id, direction: plan.direction, from: { ...this.#o.source }, to: { kind: target.kind, fingerprint: target.fingerprint, name: target.name }, phase: "copying", startedAt: this.#now(), updatedAt: this.#now() };
      await writeJson(this.#journalPath(), journal);
      let stage = "draining";
      let release: (() => Promise<void>) | undefined;
      let dest: ControllerStorage | undefined;
      let snap: StorageSnapshot | undefined;
      let fenced = false;
      try {
        release = await this.#o.barrier.raise("a database transfer is running");
        await this.#at("drained");
        stage = "validating";
        const before = await this.#mark(this.#o.storage);
        snap = await this.#o.storage.snapshot();
        const report = await this.scan(snap);
        const errors = report.findings.filter((f) => f.severity === "error");
        if (errors.length > 0) throw new Error(`the source did not pass the checks: ${errors.map((f) => f.text).join("; ")}`);
        await this.#at("validated");
        journal = await this.#journal(journal, { sourceMark: before, counts: report.rows });
        stage = "copying";
        dest = await target.open();
        const stats = await this.#copy(snap, dest);
        await this.#at("copied");
        stage = "verifying";
        await this.#readBack(dest, stats);
        await this.#at("verified");
        const destinationMark = await this.#mark(dest);
        const now = await this.#mark(this.#o.storage);
        if (now.epoch !== before.epoch || now.auditSeq !== before.auditSeq || now.deliverySeq !== before.deliverySeq) throw new Error("the source recorded something while it was being copied; nothing was switched");
        await dest.close(); dest = undefined;
        await snap.close(); snap = undefined;
        stage = "fencing";
        await this.#at("before-fence");
        journal = await this.#journal(journal, { phase: "fencing", destinationMark });
        await this.#o.storage.acquireEpoch({ holder: `transferred-out:${id}`, at: this.#now(), expectedEpoch: before.epoch });
        fenced = true;
        await this.#at("fenced");
        stage = "switching";
        const previous = await readAuthority(this.#o.dataDirectory);
        const authority: StorageAuthority = { format: 1, generation: (previous?.generation ?? 0) + 1, active: journal.to, previous: journal.from, transferId: id, since: this.#now() };
        await writeJson(join(this.#o.dataDirectory, AUTHORITY_FILE), authority);
        await this.#at("authority-written");
        journal = await this.#journal(journal, { phase: "switched" });
        this.#release = release;
        try { this.#o.onSwitched?.(authority); } catch { /* the host's notice must not undo a switch */ }
        return { id, direction: plan.direction, to: target.name, rows: plan.totalRows, claimsReleased: plan.claimsReleased, uncertainEffects: plan.uncertainEffects, restartRequired: true, findings: plan.findings };
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 500) : "the transfer failed";
        if (snap !== undefined) await snap.close().catch(() => undefined);
        if (dest !== undefined) await dest.close().catch(() => undefined);
        if (!fenced) {
          // The source was never touched: the barrier comes down and the controller goes on.
          let clean = false;
          if (target.discard !== undefined) { try { await target.discard(); clean = true; } catch { clean = false; } }
          await this.#journal(journal, { phase: "failed", failure: { at: this.#now(), phase: stage, reason, destinationClean: clean } }).catch(() => undefined);
          if (release !== undefined) await release().catch(() => undefined);
        } else this.#release = release; // fenced and not switched: the barrier stays up; the next start settles it from the journal
        if (error instanceof DomainError) throw error;
        throw new DomainError("unavailable", `the database transfer failed while ${stage}: ${reason}. ${fenced ? "The current database was fenced; restart the controller to settle the transfer." : "The current database is as it was and work goes on."}`);
      }
    } finally { this.#running = false; }
  }

  /**
   * Puts the source back as the authoritative database. Refused once the destination has recorded anything since the switch (its audit or delivery counters moved, or a controller took its epoch): then
   * records exist only there, and the way back is a reverse transfer.
   */
  async rollback(): Promise<{ id: string; to: string; restartRequired: true }> {
    if (this.#running) throw new DomainError("unavailable", "a transfer is running");
    const journal = await readJournal(this.#o.dataDirectory), authority = await readAuthority(this.#o.dataDirectory);
    if (journal === undefined || journal.phase !== "switched" || authority === undefined || authority.transferId !== journal.id) throw new DomainError("invalid_transition", "there is no switched transfer to roll back");
    if (authority.active.fingerprint !== journal.to.fingerprint) throw new DomainError("invalid_transition", "the authoritative database is not the destination of the last transfer; only the most recent switch can be rolled back");
    const target = this.#o.targets().find((t) => t.fingerprint === journal.to.fingerprint);
    if (target === undefined || journal.destinationMark === undefined) throw new DomainError("invalid_transition", "the new database is not configured as a transfer target here, so it cannot be checked for new work; configure it to roll back");
    const dest = await target.open();
    try {
      const now = await this.#mark(dest), mark = journal.destinationMark;
      if (now.auditSeq !== mark.auditSeq || now.deliverySeq !== mark.deliverySeq || now.epoch !== mark.epoch) throw new DomainError("invalid_transition", `the new database has recorded work since the switch (${now.auditSeq - mark.auditSeq} audit records, epoch ${mark.epoch} to ${now.epoch}), so going back would lose it. Use a reverse transfer to move it back with its records.`);
      await dest.acquireEpoch({ holder: `rolled-back:${journal.id}`, at: this.#now(), expectedEpoch: now.epoch });
    } finally { await dest.close(); }
    await writeJson(join(this.#o.dataDirectory, AUTHORITY_FILE), { format: 1, generation: authority.generation + 1, active: journal.from, previous: journal.to, transferId: journal.id, since: this.#now() } satisfies StorageAuthority);
    await this.#journal(journal, { phase: "rolled-back", note: "rolled back by the owner before the new database recorded anything" });
    return { id: journal.id, to: journal.from.name, restartRequired: true };
  }

  /** Lets the maintenance barrier go (a switched transfer keeps it up until the process ends). For tests and hosts that stay up. */
  async releaseBarrier(): Promise<void> { const r = this.#release; this.#release = undefined; if (r !== undefined) await r(); }
}

/** A claim belongs to the controller that took it; the drained controller holds none the new one could honour, so they are pending again. */
function releaseClaim(table: SnapshotTable, row: SnapshotRow): SnapshotRow {
  if ((table === "deliveries" || table === "timers") && row["state"] === "claimed") return { ...row, state: "pending", claimed_until: null, token: null };
  return row;
}

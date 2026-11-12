import { createHash, randomBytes } from "node:crypto";
import { constants as fsc, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, sep } from "node:path";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allowsExactly } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { canonicalJson } from "../storage/json.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { negotiateProtocol, type VersionRange } from "../remote/protocol.js";
import { Launcher, LauncherStateError, DEFAULT_STARTUP_WINDOW_SECONDS, STARTUP_WINDOW_BOUNDS, parseCompat, type LauncherNotice } from "./launcher.js";
import { DEFAULT_START_FAILURE_LEVEL, type StartFailureLevel, type StartNoticeSink } from "./start-notices.js";
import { ReleaseTrust, type TrustedKey } from "./trust.js";
import { RELEASE_KINDS, candidateIdOf, type ApprovalBody, type CandidateBody, type Cell } from "./release.js";

/**
 * Release staging and activation (card K02).
 *
 * Layout under the release root: `incoming/<candidate>/<artifact>` (where the build leaves the artifacts; the owner names no path), `releases/<candidate>/` (the staged, read-only release with `MANIFEST.json`) and
 * the activation pointer (`current`, a relative symlink, or `current.json` where symlinks are not dependable). Staging copies each artifact the candidate's manifest names, refuses anything whose digest differs, and moves the finished
 * directory into place with one rename. Activation is a journal in the database (intent, then the switch, then the commit), so an interruption at any point resolves to the old or the new release on the next start, never to a mixture.
 * Nothing here ever writes into a release directory that exists, and the launcher and updater are not part of a release (a routine release cannot replace them).
 *
 * Trust model (stated plainly, not hidden):
 * - The candidate's manifest is NOT signed. Its ID is a digest of its own content, so an ID cannot be re-pointed at other content, but anyone who can write the controller's database can submit another manifest. What stands between a
 *   submitted manifest and a running release is the owner's word: staging shows the digest, activation needs that digest (bound to the staged directory), the candidate's approval (which is for that candidate ID, itself the digest of the manifest; activation re-derives the ID from the manifest and refuses a record that does not match), and a passing test on this platform.
 * - The uid boundary: whoever can write to the release root's `releases/` folder as the controller's uid, or as root, can change a release after staging. Directories are made read-only (0555, files 0444) on POSIX, which stops accidents and other uids but not the owner of the files. The folder
 *   the build writes into (`incoming`, configurable and best placed outside the release root, owned by the build's uid) is never trusted: every file is copied and re-hashed. Defence against the same uid is the digest check at activation and the launcher's own check at launch
 *   (`verifyReleaseDirectory`, or the `release.verify` query), against the manifest digest the activation record keeps as the current release's `digest`.
 * - An approval is not withdrawn; to stop a release being activated, remove the staged copy (`release.stage.remove`) or turn the approval requirement on and do not approve. A withdrawn state is not built.
 */
export const ACTIVATION_LIMITS = { fileBytes: 4 * 1024 ** 3, files: 100, staged: 200, history: 20, listed: 50, entries: 2_000, chunk: 1024 * 1024 } as const;
const CANDIDATE_ID = /^rcn-[0-9a-f]{24}$/;
const SHA = /^[0-9a-f]{64}$/;
const STAGED = "release-staged";
/** Names this process among others that may share the folder (another host on a shared disk, an earlier run with the same pid): host, pid and the moment the process started. */
export const PROCESS_TOKEN = createHash("sha256").update(`${hostname()}|${process.pid}|${Math.round(Date.now() - process.uptime() * 1000)}`).digest("hex").slice(0, 12);
const STATE: AggregateRef = { kind: "release-activation", id: "main" };
const SETTINGS: AggregateRef = { kind: "release-activation-settings", id: "main" };
const MANIFEST_FILE = "MANIFEST.json";
const COMPAT_FILE = "compat.json";
const RESERVED_ROOTS: ReadonlySet<string> = new Set(["launcher", "updater"]);

const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const wholeRev = (v: unknown): void => { if (v !== undefined && (!Number.isSafeInteger(v) || (v as number) < 0)) bad("expectedRevision", "must be a whole number"); };
const strictOwner = (by: Principal, what: string): void => { if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not ${what}; only the owner does`); };
/**
 * Release management (K02c) is the owner's, or an agent's to whom the owner granted `release.manage` (a grantable action distinct from the toolbox's `agent.manage`/`catalog.*`; only the owner makes grants). The grant must be that exact action:
 * `*` and a `release.*` prefix do not count, so a broad "run everything" or supervisor grant does not reach the installation's own releases. A task credential never does. The holder may stage, remove, verify, read, activate and roll back, and attach
 * signatures; it cannot approve, change settings, change the trust root, confirm a start, resolve a switch or acknowledge notices (all the owner's). Its activation is further limited (see `activate`).
 */
const mayManage = (by: Principal, what: string): void => {
  if (by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not ${what}; only the owner or a holder of release.manage does`);
  if (by.kind === "owner") return;
  if (by.kind === "agent" && allowsExactly(by, "release.manage", "*")) return;
  throw new DomainError("forbidden", `${by.id} may not ${what}; only the owner or a holder of release.manage does`);
};
const isOwner = (by: Principal): boolean => by.kind === "owner" && by.taskScope === undefined;
const known = (command: object, fields: readonly string[]): void => { const u = Object.keys(command).filter((k) => !fields.includes(k)); if (u.length > 0) bad(u[0]!, "is not a field of this command"); };
const idOf = (v: unknown): string => { if (typeof v !== "string" || !CANDIDATE_ID.test(v)) return bad("candidateId", "is not a release candidate ID"); return v; };

/** What the staged directory holds, fixed at staging: the file digests of the candidate's manifest, with sizes. Its digest is what the owner's word is bound to. */
export interface StagedManifest { readonly candidateId: string; readonly sourceCommit: string; readonly files: Readonly<Record<string, { readonly sha256: string; readonly size: number }>> }
export interface StagedBody { readonly candidateId: string; readonly digest: string; readonly bytes: number; readonly files: number; readonly stagedBy: string; readonly stagedAt: string; /** The worker protocol range the release's controller speaks, from its `compat.json` artifact (a digest-bound file of the release). */ readonly protocol?: VersionRange; /** The database schema range from `compat.json` (K02d), when it names one. */ readonly schema?: VersionRange; /** The key ID of the trusted signature the release had when staged (K02b); activation checks again. */ readonly signedBy?: string }
/** `digest` is the digest of the staged MANIFEST.json (the manifest digest) that the launcher verifies at launch. */
export interface ReleaseRef { readonly id: string; readonly digest: string }
export interface JournalBody { readonly kind: "activate" | "rollback"; readonly from?: ReleaseRef; readonly to: ReleaseRef; readonly by: string; readonly startedAt: string }
export interface HistoryEntry { readonly at: string; readonly kind: "activated" | "rolled_back" | "aborted" | "recovered" | "resolved" | "confirmed" | "fell_back"; readonly by: string; readonly to?: string; readonly from?: string; readonly reason?: string }
/** The release that last started and reported itself healthy (or that the owner confirmed). Rollback after a failed start goes here, never to an unproven release. */
export interface KnownGoodRef extends ReleaseRef { readonly confirmedAt: string; readonly via: "startup" | "owner" }
export interface ActivationBody { readonly current?: ReleaseRef & { readonly at: string; readonly by: string; /** When this release reported a healthy start; absent until then. */ readonly confirmedAt?: string }; readonly lastKnownGood?: KnownGoodRef; readonly previous?: ReleaseRef; readonly journal?: JournalBody; readonly history: readonly HistoryEntry[]; readonly updatedAt: string }
export interface ActivationSettingsBody { readonly requireApproval?: boolean; readonly maxStagedBytes?: number; readonly keepStaged?: number; /** The hard caps, when the owner moved them from the built-in ones (`ACTIVATION_LIMITS`). */ readonly maxStaged?: number; readonly maxFiles?: number; readonly maxFileBytes?: number; /** Seconds a started release may stay unconfirmed before the launcher's watchdog counts the start as failed (K02e). */ readonly startupWindowSeconds?: number; /** The level of the owner's notice when the launcher fell back (K02f). */ readonly startFailureLevel?: StartFailureLevel; readonly updatedBy: string; readonly updatedAt: string }

/** The place the launcher reads the active release from. */
export interface Switcher { read(): Promise<string | undefined | "invalid">; write(id: string): Promise<void>; clear(): Promise<void> }

async function syncDir(dir: string): Promise<void> {
  let fh;
  try { fh = await open(dir, "r"); await fh.sync(); } catch { /* a directory cannot be synced on every platform */ } finally { await fh?.close().catch(() => undefined); }
}
/** One relative symlink, replaced by renaming a fresh one over it (atomic on POSIX). */
export class SymlinkSwitcher implements Switcher {
  constructor(private readonly root: string) {}
  async read(): Promise<string | undefined | "invalid"> {
    const path = join(this.root, "current");
    let st;
    try { st = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!st.isSymbolicLink()) return "invalid";
    const m = /^releases\/(rcn-[0-9a-f]{24})$/.exec((await readlink(path)).replaceAll("\\", "/"));
    return m === null ? "invalid" : m[1]!;
  }
  async write(id: string): Promise<void> {
    const tmp = join(this.root, `current.tmp-${randomBytes(6).toString("hex")}`);
    await symlink(`releases/${id}`, tmp);
    try { await rename(tmp, join(this.root, "current")); } catch (error) { await rm(tmp, { force: true }); throw error; }
    await syncDir(this.root);
  }
  async clear(): Promise<void> { await rm(join(this.root, "current"), { force: true }); await syncDir(this.root); }
}
/** A pointer file replaced by rename: for systems where creating a symlink needs a privilege. */
export class PointerSwitcher implements Switcher {
  constructor(private readonly root: string) {}
  async read(): Promise<string | undefined | "invalid"> {
    let raw: string;
    try { raw = await readFile(join(this.root, "current.json"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try { const v = JSON.parse(raw) as { release?: unknown }; return typeof v.release === "string" && CANDIDATE_ID.test(v.release) ? v.release : "invalid"; } catch { return "invalid"; }
  }
  async write(id: string): Promise<void> {
    const tmp = join(this.root, `current.json.tmp-${randomBytes(6).toString("hex")}`);
    const fh = await open(tmp, "wx", 0o644);
    try { await fh.writeFile(JSON.stringify({ release: id })); await fh.sync(); } finally { await fh.close(); }
    try { await rename(tmp, join(this.root, "current.json")); } catch (error) { await rm(tmp, { force: true }); throw error; }
    await syncDir(this.root);
  }
  async clear(): Promise<void> { await rm(join(this.root, "current.json"), { force: true }); await syncDir(this.root); }
}

const inflight = new Set<string>();
const POSIX = process.platform !== "win32";
/** Makes a staged release's folders read-only (POSIX; elsewhere modes do not mean this, and the file digests are the defence). */
async function lockTree(dir: string): Promise<void> {
  if (!POSIX) return;
  for (const e of await readdir(dir, { withFileTypes: true })) if (e.isDirectory()) await lockTree(join(dir, e.name));
  await chmod(dir, 0o555);
}
/** Makes the folders writable again so that the tree can be removed. */
async function unlockTree(dir: string): Promise<void> {
  if (!POSIX) return;
  try { await chmod(dir, 0o700); } catch { return; }
  let entries: Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory()) await unlockTree(join(dir, e.name));
}
async function removeTree(dir: string): Promise<void> { await unlockTree(dir); await rm(dir, { recursive: true, force: true }); }


/** The problems found between a staged release directory and its recorded manifest digest; empty when it is exactly what was staged. Bounded by the number of files recorded. Exported so that the launcher can run the same check at launch. */
export async function verifyReleaseDirectory(dir: string, digest: string): Promise<string[]> {
  const problems: string[] = [];
  let text: string;
  try { text = await readFile(join(dir, MANIFEST_FILE), "utf8"); } catch { return [`${MANIFEST_FILE} is missing`]; }
  if (sha256(text) !== digest) return [`${MANIFEST_FILE} is not the one that was staged`];
  let manifest: StagedManifest;
  try { manifest = JSON.parse(text) as StagedManifest; } catch { return [`${MANIFEST_FILE} is damaged`]; }
  const expected = new Set(Object.keys(manifest.files));
  // Anything in the directory that the manifest does not name is a problem (an added file could be run by the launcher).
  const found = new Set<string>();
  const walk = async (rel: string): Promise<void> => {
    if (found.size > ACTIVATION_LIMITS.entries) { problems.push("too many entries"); return; }
    let entries: Dirent[];
    try { entries = await readdir(join(dir, rel), { withFileTypes: true }); } catch { problems.push(`${rel || "."} cannot be read`); return; }
    for (const e of entries) {
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(r); else found.add(r);
    }
  };
  await walk("");
  for (const f of found) if (f !== MANIFEST_FILE && !expected.has(f)) problems.push(`${f} was added`);
  for (const [name, want] of Object.entries(manifest.files)) {
    try {
      const path = join(dir, ...name.split("/"));
      const st = await lstat(path);
      if (!st.isFile()) { problems.push(`${name} is not a plain file`); continue; }
      if (st.size !== want.size) { problems.push(`${name} has a different size`); continue; }
      const hash = createHash("sha256");
      const fh = await open(path, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
      try { const buf = Buffer.allocUnsafe(ACTIVATION_LIMITS.chunk); for (;;) { const { bytesRead } = await fh.read(buf, 0, buf.length, null); if (bytesRead === 0) break; hash.update(buf.subarray(0, bytesRead)); } } finally { await fh.close(); }
      if (hash.digest("hex") !== want.sha256) problems.push(`${name} has a different digest`);
    } catch { problems.push(`${name} is missing or unreadable`); }
  }
  return problems.slice(0, 10);
}

/** Thrown by a test hook to stand for the process dying at that point: nothing after it runs, the journal stays as it is. */
export class SimulatedCrash extends Error { constructor(readonly point: string) { super(`simulated crash at ${point}`); } }
export interface ActivationOptions {
  /** The release root (staging, releases and the activation pointer live under it). */
  readonly root: string;
  /** `symlink` (default except on Windows) or `pointer`. */
  readonly switcher?: "symlink" | "pointer";
  /** The platform this installation runs on, instead of reading the process (tests). */
  readonly platform?: Pick<Cell, "os" | "arch">;
  /** Tests only: called at named points; throwing `SimulatedCrash` stops the operation there as a dying process would. */
  readonly hook?: (point: "afterBegin" | "afterVerify" | "afterAnnounce" | "afterSwitch") => void | Promise<void>;
  readonly runner?: RunnerOptions;
  /** Where the build leaves artifacts (`<incoming>/<candidate>/<artifact>`). Default: `incoming` under the root; better a folder outside it, owned by the build's uid. Never trusted: files are copied and re-hashed. */
  readonly incoming?: string;
  /** A `.tmp-*` staging folder this process does not own is only removed when older than this (default one hour). */
  readonly tmpStaleMs?: number;
  /**
   * Controller-worker protocol compatibility (checked before an activation or a rollback): `workers` is the protocol range the installation's workers speak. A release declares the range its controller speaks in a
   * `compat.json` artifact (`{"protocol":{"min":1,"max":1}}`); with `required` (the wiring in `startController` sets it) a release without one cannot be staged, activated or rolled back to. Unset: not checked.
   */
  readonly compat?: { readonly workers: VersionRange; readonly required?: boolean };
  /** The release this process was started from (given by the launcher). When the activation record names it as current, `confirmStartup` records it as the last known good. */
  readonly runningRelease?: string;
  /** Where the owner is told of a fall-back or a failed start (K02f); without it the notices stay in the launcher's file and `release.status`. */
  readonly notices?: StartNoticeSink;
  /** This installation's name for release targets (K02): a candidate whose manifest lists `targets` is staged and activated only where this is one of them; with targets and no name here, it is refused. */
  readonly installationId?: string;
  /** The database's current schema version (the number of the last applied migration), for the launcher's fall-back check (K02d). Without it nothing is recorded and that check never refuses. */
  readonly schemaVersion?: () => Promise<number>;
}
export interface ActivationStatus {
  readonly revision: number;
  readonly current?: ReleaseRef & { readonly at: string; readonly by: string };
  readonly previous?: ReleaseRef;
  /** The last release that reported a healthy start, and whether the current one has yet. */
  readonly lastKnownGood?: KnownGoodRef;
  readonly confirmed: boolean;
  /** Releases the launcher found failing to start (never run or activated again), newest last. */
  readonly failedStarts: readonly { readonly id: string; readonly at: string; readonly reason: string }[];
  readonly journal?: JournalBody;
  /** What the launcher's pointer says now; `diverged` when it is not the release the record says is current (reported, never silently changed). */
  readonly pointer: string | null;
  readonly diverged: boolean;
  readonly history: readonly HistoryEntry[];
  readonly staged: readonly { readonly candidateId: string; readonly digest: string; readonly stagedAt: string; readonly bytes: number; readonly schema?: VersionRange }[];
  /** The trust root: whether a signature is needed now and which keys are trusted (K02b). */
  readonly trust: { readonly required: boolean; readonly keys: readonly Pick<TrustedKey, "keyId" | "label">[] };
  /** The highest database schema version any controller opened here (the launcher's record, K02d). */
  readonly databaseSchema?: number;
  readonly settings: { readonly requireApproval: boolean; readonly maxStagedBytes: number | null; readonly keepStaged: number | null; readonly startupWindowSeconds: number; readonly startFailureLevel: StartFailureLevel; readonly revision: number };
  /** What the launcher wrote for the owner (a fall-back, a failed start), newest last, with whether it was told and whether it is still open. */
  readonly startNotices: readonly { readonly kind: LauncherNotice["kind"]; readonly release: string; readonly to?: string; readonly reason: string; readonly at: string; readonly told: boolean; readonly state: "open" | "acknowledged" | "confirmed" }[];
}

/** Settings and the staging/activation service in one place, because the settings are read inside the same checks. */
export class ReleaseActivationService {
  readonly #runner: CommandRunner;
  readonly #o: ActivationOptions;
  readonly #sw: Switcher;
  readonly #launcher: Launcher;
  readonly #trust: ReleaseTrust;
  readonly #locks = new Map<string, Promise<unknown>>();
  private constructor(runner: CommandRunner, o: ActivationOptions) {
    this.#runner = runner; this.#o = o; this.#trust = new ReleaseTrust(runner);
    this.#sw = (o.switcher ?? (process.platform === "win32" ? "pointer" : "symlink")) === "pointer" ? new PointerSwitcher(o.root) : new SymlinkSwitcher(o.root);
    this.#launcher = new Launcher({ root: o.root, switcher: this.#sw, ...(o.compat === undefined ? {} : { workers: o.compat.workers }) });
  }
  /** The launcher's own record (last known good, failed starts), for tests and the status view. */
  get launcher(): Launcher { return this.#launcher; }
  static withEpoch(storage: ControllerStorage, epoch: number, o: ActivationOptions): ReleaseActivationService { return new ReleaseActivationService(new CommandRunner(storage, epoch, o.runner ?? {}), o); }

  /** One thing at a time per key in this process; across processes the revision guards decide. */
  async #serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(key) ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(run);
    this.#locks.set(key, mine);
    try { return await mine; } finally { if (this.#locks.get(key) === mine) this.#locks.delete(key); }
  }
  /** The release the launcher's pointer names. A pointer that cannot be read is not "no release": the caller refuses (fails closed) instead of going on without knowing what the launcher runs from. */
  async #pointer(): Promise<string | undefined> {
    try { return await this.#sw.read(); } catch { throw new DomainError("unavailable", "the launcher's pointer could not be read, so what it runs from is not known; nothing is staged, removed or pruned until it can be"); }
  }
  /** The hard caps as they count now: the owner's setting, else the built-in one. */
  async #caps(): Promise<{ staged: number; files: number; fileBytes: number }> {
    const b = (await this.#runner.get(SETTINGS.kind, SETTINGS.id))?.body as unknown as ActivationSettingsBody | undefined;
    return { staged: b?.maxStaged ?? ACTIVATION_LIMITS.staged, files: b?.maxFiles ?? ACTIVATION_LIMITS.files, fileBytes: b?.maxFileBytes ?? ACTIVATION_LIMITS.fileBytes };
  }
  #dir(id: string): string { return join(this.#o.root, "releases", id); }
  #incomingRoot(): string { return this.#o.incoming ?? join(this.#o.root, "incoming"); }
  #platform(): Pick<Cell, "os" | "arch"> { return this.#o.platform ?? { os: process.platform as Cell["os"], arch: process.arch as Cell["arch"] }; }

  // ---- settings ----------------------------------------------------------------------------------------------------------------------------------------------------------

  async settings(owner: Principal): Promise<{ revision: number; requireApproval: boolean; maxStagedBytes: number | null; keepStaged: number | null; maxStaged: number; maxFiles: number; maxFileBytes: number; startupWindowSeconds: number; startFailureLevel: StartFailureLevel; set: { startupWindowSeconds?: number; startFailureLevel?: StartFailureLevel; requireApproval?: boolean; maxStagedBytes?: number; keepStaged?: number; maxStaged?: number; maxFiles?: number; maxFileBytes?: number } }> {
    strictOwner(owner, "read the release activation settings");
    return this.#settings();
  }
  async #settings() {
    const found = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
    const b = found?.body as unknown as ActivationSettingsBody | undefined;
    return { revision: found?.revision ?? 0, requireApproval: b?.requireApproval ?? true, maxStagedBytes: b?.maxStagedBytes ?? null, keepStaged: b?.keepStaged ?? null, maxStaged: b?.maxStaged ?? ACTIVATION_LIMITS.staged, maxFiles: b?.maxFiles ?? ACTIVATION_LIMITS.files, maxFileBytes: b?.maxFileBytes ?? ACTIVATION_LIMITS.fileBytes, startupWindowSeconds: b?.startupWindowSeconds ?? DEFAULT_STARTUP_WINDOW_SECONDS, startFailureLevel: b?.startFailureLevel ?? DEFAULT_START_FAILURE_LEVEL, set: { ...(b?.startupWindowSeconds === undefined ? {} : { startupWindowSeconds: b.startupWindowSeconds }), ...(b?.startFailureLevel === undefined ? {} : { startFailureLevel: b.startFailureLevel }), ...(b?.requireApproval === undefined ? {} : { requireApproval: b.requireApproval }), ...(b?.maxStagedBytes === undefined ? {} : { maxStagedBytes: b.maxStagedBytes }), ...(b?.keepStaged === undefined ? {} : { keepStaged: b.keepStaged }), ...(b?.maxStaged === undefined ? {} : { maxStaged: b.maxStaged }), ...(b?.maxFiles === undefined ? {} : { maxFiles: b.maxFiles }), ...(b?.maxFileBytes === undefined ? {} : { maxFileBytes: b.maxFileBytes }) } };
  }
  /** `requireApproval`: activation needs the candidate approved through `release.approve` (default on). `maxStagedBytes`: an optional cap on all staged releases together (off by default; null turns it off). `keepStaged`: keep only the newest N staged releases (never the current, the previous or one being switched to); off by default, null turns it off. */
  async setSettings(owner: Principal, command: NoActor & { requireApproval?: unknown; maxStagedBytes?: unknown; keepStaged?: unknown; maxStaged?: unknown; maxFiles?: unknown; maxFileBytes?: unknown; startupWindowSeconds?: unknown; startFailureLevel?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    strictOwner(owner, "change the release activation settings");
    known(command, ["commandId", "requireApproval", "maxStagedBytes", "keepStaged", "maxStaged", "maxFiles", "maxFileBytes", "startupWindowSeconds", "startFailureLevel", "expectedRevision"]);
    if (command.requireApproval === undefined && command.maxStagedBytes === undefined && command.keepStaged === undefined && command.maxStaged === undefined && command.maxFiles === undefined && command.maxFileBytes === undefined && command.startupWindowSeconds === undefined && command.startFailureLevel === undefined) bad("requireApproval", "give requireApproval, maxStagedBytes, keepStaged, startupWindowSeconds, startFailureLevel or several");
    const win = command.startupWindowSeconds;
    if (win !== undefined && win !== null && !(typeof win === "number" && Number.isSafeInteger(win) && win >= STARTUP_WINDOW_BOUNDS.min && win <= STARTUP_WINDOW_BOUNDS.max)) bad("startupWindowSeconds", `must be a whole number of seconds from ${STARTUP_WINDOW_BOUNDS.min} to ${STARTUP_WINDOW_BOUNDS.max}, or null for the default (${DEFAULT_STARTUP_WINDOW_SECONDS})`);
    const lvl = command.startFailureLevel;
    if (lvl !== undefined && lvl !== null && lvl !== "needs-you" && lvl !== "urgent") bad("startFailureLevel", "must be needs-you or urgent, or null for the default (needs-you)");
    if (command.requireApproval !== undefined && typeof command.requireApproval !== "boolean") bad("requireApproval", "must be true or false");
    const m = command.maxStagedBytes;
    if (m !== undefined && m !== null && !(typeof m === "number" && Number.isSafeInteger(m) && m >= 1)) bad("maxStagedBytes", "must be a whole number of bytes, or null for no cap");
    const kp = command.keepStaged;
    if (kp !== undefined && kp !== null && !(typeof kp === "number" && Number.isSafeInteger(kp) && kp >= 1 && kp <= ACTIVATION_LIMITS.staged)) bad("keepStaged", `must be a whole number from 1 to ${ACTIVATION_LIMITS.staged}, or null to keep them all`);
    const cap = (v: unknown, f: string, hi: number): number | null | undefined => (v === undefined || v === null ? (v as null | undefined) : typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= hi ? v : bad(f, `must be a whole number from 1 to ${hi}, or null for the built-in value`));
    const mS = cap(command.maxStaged, "maxStaged", 10_000), mF = cap(command.maxFiles, "maxFiles", 100_000), mB = cap(command.maxFileBytes, "maxFileBytes", Number.MAX_SAFE_INTEGER);
    wholeRev(command.expectedRevision);
    const r = await this.#runner.command("release.staging.settings.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { requireApproval: (command.requireApproval as boolean | undefined) ?? null, maxStagedBytes: m === undefined ? "keep" : (m as number | null), keepStaged: kp === undefined ? "keep" : (kp as number | null), maxStaged: mS === undefined ? "keep" : mS, maxFiles: mF === undefined ? "keep" : mF, maxFileBytes: mB === undefined ? "keep" : mB, startupWindowSeconds: win === undefined ? "keep" : (win as number | null), startFailureLevel: lvl === undefined ? "keep" : (lvl as string | null), expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the release settings are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const before = current?.body as unknown as ActivationSettingsBody | undefined;
        const requireApproval = (command.requireApproval as boolean | undefined) ?? before?.requireApproval;
        const cap = m === undefined ? before?.maxStagedBytes : m === null ? undefined : (m as number);
        const keep = kp === undefined ? before?.keepStaged : kp === null ? undefined : (kp as number);
        const pick = (v: number | null | undefined, was: number | undefined): number | undefined => (v === undefined ? was : v === null ? undefined : v);
        const nS = pick(mS, before?.maxStaged), nF = pick(mF, before?.maxFiles), nB = pick(mB, before?.maxFileBytes);
        const nW = win === undefined ? before?.startupWindowSeconds : win === null ? undefined : (win as number);
        const nL = lvl === undefined ? before?.startFailureLevel : lvl === null ? undefined : (lvl as StartFailureLevel);
        const body: ActivationSettingsBody = { ...(nW === undefined ? {} : { startupWindowSeconds: nW }), ...(nL === undefined ? {} : { startFailureLevel: nL }), ...(nS === undefined ? {} : { maxStaged: nS }), ...(nF === undefined ? {} : { maxFiles: nF }), ...(nB === undefined ? {} : { maxFileBytes: nB }), ...(requireApproval === undefined ? {} : { requireApproval }), ...(cap === undefined ? {} : { maxStagedBytes: cap }), ...(keep === undefined ? {} : { keepStaged: keep }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: SETTINGS, body: body as unknown as JsonObject } : { type: "update" as const, ref: SETTINGS, expectedRevision: current.revision, body: body as unknown as JsonObject };
        return { ref: SETTINGS, creates: current === undefined, changes: [change], detail: { requireApproval: requireApproval ?? null, maxStagedBytes: cap ?? null, keepStaged: keep ?? null, maxStaged: nS ?? null, maxFiles: nF ?? null, maxFileBytes: nB ?? null, startupWindowSeconds: nW ?? null, startFailureLevel: nL ?? null } };
      },
    }));
    // The launcher cannot read the database, so it keeps its own copy of the window. A launcher file that cannot be written now is synced again at the next start.
    await this.syncLauncherWindow().catch(() => undefined);
    return { revision: r.revision };
  }

  // ---- staging -----------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Copies the artifacts of a candidate from `incoming/<candidate>/` into a new versioned directory, refusing any file whose digest is not the manifest's. The same candidate staged twice is the same release. */
  async stage(owner: Principal, command: NoActor & { candidateId: string }): Promise<{ candidateId: string; digest: string; bytes: number; files: number; replayed: boolean }> {
    mayManage(owner, "stage a release");
    known(command, ["commandId", "candidateId"]);
    const id = idOf(command.candidateId);
    return this.#serial(`stage:${id}`, async () => {
      const candidate = (await this.#runner.get(RELEASE_KINDS.candidate, id))?.body as unknown as CandidateBody | undefined;
      if (candidate === undefined) throw new DomainError("not_found", "no such release candidate");
      this.#target(candidate.manifest);
      const signedBy = await this.#signed(id);
      const existing = await this.#runner.get(STAGED, id);
      if (existing !== undefined) {
        const b = existing.body as unknown as StagedBody;
        const check = await this.#verify(id, b.digest);
        if (check.length > 0) throw new DomainError("invalid_transition", `the staged release no longer matches its digests: ${check[0]}`);
        return { candidateId: id, digest: b.digest, bytes: b.bytes, files: b.files, replayed: true };
      }
      // A release the launcher follows (or that the record names) is never staged again: that would replace the files it is running from (for example after the database was restored from an older copy).
      const live = await this.#liveIds();
      if (live.has(id) || (await this.#pointer()) === id) throw new DomainError("invalid_transition", "the launcher's pointer or the activation record already names this release; it cannot be staged again over the files it runs from");
      const caps = await this.#caps();
      const all = await this.#runner.list(STAGED, { limit: caps.staged + 1 });
      if (all.length >= caps.staged) throw new DomainError("invalid_transition", `${caps.staged} releases are already staged; the oldest must be removed first (or the owner raises maxStaged)`);
      const settings = await this.#settings();
      const used = all.reduce((n, a) => n + (a.body as unknown as StagedBody).bytes, 0);
      const names = Object.keys(candidate.manifest.artifacts).sort();
      if (names.length > caps.files) bad("candidateId", "has too many artifacts");
      this.#names(names);
      const releases = join(this.#o.root, "releases");
      await mkdir(releases, { recursive: true, mode: 0o700 });
      await mkdir(this.#incomingRoot(), { recursive: true, mode: 0o700 });
      const incoming = join(this.#incomingRoot(), id);
      let incomingReal: string;
      try { incomingReal = await realpath(incoming); } catch { throw new DomainError("not_found", `the artifacts are not in place: nothing at incoming/${id}`); }
      if (incomingReal !== join(await realpath(this.#incomingRoot()), id)) throw new DomainError("invalid_command", "incoming/<candidate> is not a plain directory (a link is refused)");
      const tmpName = `.tmp-${id}-${PROCESS_TOKEN}-${randomBytes(6).toString("hex")}`;
      const tmp = join(releases, tmpName);
      inflight.add(tmpName);
      await mkdir(tmp, { mode: 0o700 });
      const files: Record<string, { sha256: string; size: number }> = {};
      let bytes = 0;
      try {
        for (const name of names) {
          const want = candidate.manifest.artifacts[name]!;
          const got = await this.#copyIn(incomingReal, name, join(tmp, ...name.split("/")), caps.fileBytes);
          if (got.sha256 !== want) throw new DomainError("invalid_command", `${name}: its digest is not the one the candidate's manifest names (staged nothing)`, { field: "candidateId" });
          files[name] = got; bytes += got.size;
          if (settings.maxStagedBytes !== null && used + bytes > settings.maxStagedBytes) throw new DomainError("invalid_transition", `staging would use more than the ${settings.maxStagedBytes} bytes the owner allowed for staged releases`);
        }
        let protocol: VersionRange | undefined;
        let schema: VersionRange | undefined;
        if (files[COMPAT_FILE] !== undefined) {
          try { const c = parseCompat(await readFile(join(tmp, COMPAT_FILE), "utf8")); protocol = c.protocol; schema = c.schema; } catch (error) { throw new DomainError("invalid_command", `${(error as Error).message} (staged nothing)`, { field: "candidateId" }); }
        } else if (this.#o.compat?.required === true) throw new DomainError("invalid_command", `the release has no ${COMPAT_FILE} naming the worker protocol range its controller speaks, so it cannot be checked for compatibility (staged nothing)`, { field: "candidateId" });
        const manifest: StagedManifest = { candidateId: id, sourceCommit: candidate.manifest.sourceCommit, files };
        const text = canonicalJson(manifest as unknown as JsonObject);
        const fh = await open(join(tmp, MANIFEST_FILE), "wx", 0o444);
        try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
        const digest = sha256(text);
        // A directory left by a run that died after the rename and before the record is not a staged release: it is replaced, never trusted.
        await removeTree(this.#dir(id));
        await rename(tmp, this.#dir(id));
        await lockTree(this.#dir(id));
        await syncDir(releases);
        const ref: AggregateRef = { kind: STAGED, id };
        const body: StagedBody = { candidateId: id, digest, bytes, files: names.length, stagedBy: owner.id, stagedAt: this.#runner.now(), ...(protocol === undefined ? {} : { protocol }), ...(schema === undefined ? {} : { schema }), ...(signedBy === undefined ? {} : { signedBy }) };
        await this.#runner.command("release.stage", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
          payload: { candidateId: id },
          build: async () => ({ ref, creates: true, changes: [{ type: "create" as const, ref, body: body as unknown as JsonObject }], detail: { candidateId: id, digest, bytes, files: names.length } }),
        }));
        if (settings.keepStaged !== null) await this.#prune(settings.keepStaged, id).catch(() => undefined);
        return { candidateId: id, digest, bytes, files: names.length, replayed: false };
      } catch (error) {
        await removeTree(tmp).catch(() => undefined);
        throw error;
      } finally { inflight.delete(tmpName); }
    });
  }

  /** Artifact names are validated again here, though the manifest checked them: they become path parts, and a name must never leave the release directory. */
  #names(names: readonly string[]): void {
    const seen = new Set<string>();
    for (const n of names) {
      const parts = n.split("/");
      if (n.length > 128 || n.includes("\\") || parts.some((p) => p === "" || p === "." || p === "..")) bad("candidateId", `${n.slice(0, 40)} is not a safe artifact name`);
      if (n.toLowerCase() === MANIFEST_FILE.toLowerCase()) bad("candidateId", `${MANIFEST_FILE} is reserved`);
      // The launcher and the updater are not part of a release: a routine release cannot replace them, so no artifact may be placed under their names.
      // Everything from the first dot on is ignored, so `launcher.tar.gz` or `launcher..` (Windows drops trailing dots) is refused as well as `launcher.exe`.
      if (RESERVED_ROOTS.has(parts[0]!.toLowerCase().split(".")[0]!)) bad("candidateId", `${n.slice(0, 40)}: the launcher and the updater are not part of a release`);
      const low = n.toLowerCase();
      if (seen.has(low)) bad("candidateId", `${n.slice(0, 40)} collides with another artifact on a case-insensitive file system`);
      seen.add(low);
    }
    for (const a of seen) for (const b of seen) if (a !== b && b.startsWith(`${a}/`)) bad("candidateId", `${a.slice(0, 40)} is both a file and a folder`);
  }

  /** Reads one source file without following links, bounded in size, hashing as it copies to a new read-only file. */
  async #copyIn(sourceRoot: string, name: string, dest: string, maxBytes: number = ACTIVATION_LIMITS.fileBytes): Promise<{ sha256: string; size: number }> {
    const src = join(sourceRoot, ...name.split("/"));
    let real: string;
    try { real = await realpath(src); } catch { throw new DomainError("not_found", `${name}: not in the incoming folder`); }
    if (!real.startsWith(sourceRoot + sep)) throw new DomainError("invalid_command", `${name}: leaves the incoming folder (a link is refused)`);
    const NOFOLLOW = fsc.O_NOFOLLOW ?? 0;
    const input = await open(src, fsc.O_RDONLY | NOFOLLOW);
    try {
      const st = await input.stat();
      if (!st.isFile()) throw new DomainError("invalid_command", `${name}: is not a plain file`);
      if (st.size > maxBytes) throw new DomainError("invalid_command", `${name}: is larger than ${maxBytes} bytes`);
      await mkdir(join(dest, ".."), { recursive: true, mode: 0o700 });
      const out = await open(dest, "wx", 0o444);
      const hash = createHash("sha256");
      let size = 0;
      try {
        const buf = Buffer.allocUnsafe(ACTIVATION_LIMITS.chunk);
        for (;;) {
          const { bytesRead } = await input.read(buf, 0, buf.length, null);
          if (bytesRead === 0) break;
          size += bytesRead;
          if (size > st.size) throw new DomainError("invalid_command", `${name}: changed while it was copied`);
          hash.update(buf.subarray(0, bytesRead));
          await out.write(buf, 0, bytesRead);
        }
        if (size !== st.size) throw new DomainError("invalid_command", `${name}: changed while it was copied`);
        await out.sync();
      } finally { await out.close(); }
      await chmod(dest, 0o444);
      return { sha256: hash.digest("hex"), size };
    } finally { await input.close(); }
  }

  async #verify(id: string, digest: string): Promise<string[]> { return verifyReleaseDirectory(this.#dir(id), digest); }

  // ---- activation ---------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Owner only. The word is bound to the candidate, to the digest of what was staged and to this platform, and needs the candidate approved (unless the owner turned that requirement off). */
  async activate(owner: Principal, command: NoActor & { candidateId: string; digest: string; migrationPlan?: string; expectedRevision?: number }): Promise<{ revision: number; replayed: boolean }> {
    mayManage(owner, "activate a release");
    known(command, ["commandId", "candidateId", "digest", "migrationPlan", "expectedRevision"]);
    if (command.migrationPlan !== undefined && (typeof command.migrationPlan !== "string" || !SHA.test(command.migrationPlan))) bad("migrationPlan", "must be the 64 hexadecimal characters of the migration plan's digest");
    const id = idOf(command.candidateId);
    if (typeof command.digest !== "string" || !SHA.test(command.digest)) bad("digest", "must be the 64 hexadecimal characters of the staged release's digest");
    wholeRev(command.expectedRevision);
    return this.#serial("switch", async () => {
      const staged = await this.#runner.get(STAGED, id);
      if (staged === undefined) throw new DomainError("not_found", "that release is not staged");
      const sb = staged.body as unknown as StagedBody;
      if (sb.digest !== command.digest) throw new DomainError("invalid_command", "digest: is not the digest of the staged release; read it again before activating", { field: "digest" });
      const candidate = (await this.#runner.get(RELEASE_KINDS.candidate, id))?.body as unknown as CandidateBody | undefined;
      if (candidate === undefined) throw new DomainError("not_found", "no such release candidate (its record is gone); it cannot be activated");
      // The approval and the staged files are both bound to this candidate; its ID is the digest of its manifest, so a record that no longer hashes to its ID is refused.
      if (candidateIdOf(candidate.manifest) !== id) throw new DomainError("invalid_transition", "the candidate's record does not match its ID; it is not activated");
      await this.#startable(id);
      await this.#compatible(id, "the release");
      // The word covers the data too: a candidate that carries a migration plan is activated only by someone who quotes that plan's digest, and one that carries none is not activated with a plan quoted for it.
      if (candidate.manifest.migrationPlan !== command.migrationPlan) throw new DomainError("invalid_command", candidate.manifest.migrationPlan === undefined ? "migrationPlan: the release carries no migration plan; do not name one" : "migrationPlan: the release carries a migration plan; quote its digest (release.status or the candidate shows it) to activate", { field: "migrationPlan" });
      this.#target(candidate.manifest);
      await this.#signed(id);
      const p = this.#platform();
      if (!candidate.manifest.matrix.some((c) => c.os === p.os && c.arch === p.arch)) throw new DomainError("invalid_transition", `the release was not tested for this installation's platform (${p.os}/${p.arch})`);
      // A holder of release.manage never activates what the owner has not approved, whatever the owner's setting says about their own activations: switching the requirement off is the owner's convenience for the owner.
      if (((await this.#settings()).requireApproval || !isOwner(owner)) && ((await this.#runner.get(RELEASE_KINDS.approval, id))?.body as unknown as ApprovalBody | undefined)?.candidateId !== id) throw new DomainError("invalid_transition", "the release is not approved (release.approve)" + (isOwner(owner) ? "; the owner may switch that requirement off" : "; a holder of release.manage needs the owner's approval"));
      return this.#transition(owner, "activate", command.commandId, { id, digest: sb.digest }, command.expectedRevision, () => this.#trust.guard(id));
    });
  }

  /** Owner only. Goes back to the release that was current before the last activation, named by its ID so that a moved record cannot send it elsewhere. */
  async rollback(owner: Principal, command: NoActor & { releaseId: string; expectedRevision?: number }): Promise<{ revision: number; replayed: boolean }> {
    mayManage(owner, "roll a release back");
    known(command, ["commandId", "releaseId", "expectedRevision"]);
    const id = idOf(command.releaseId);
    wholeRev(command.expectedRevision);
    return this.#serial("switch", async () => {
      const state = await this.#runner.get(STATE.kind, STATE.id);
      const body = state?.body as unknown as ActivationBody | undefined;
      if (body?.previous === undefined || body.previous.id !== id) throw new DomainError("invalid_transition", "that is not the release before the current one");
      await this.#startable(id);
      await this.#compatible(id, "the release to go back to");
      const cand = (await this.#runner.get(RELEASE_KINDS.candidate, id))?.body as unknown as CandidateBody | undefined;
      if (cand !== undefined) this.#target(cand.manifest);
      await this.#signed(id);
      return this.#transition(owner, "rollback", command.commandId, body.previous, command.expectedRevision, () => this.#trust.guard(id));
    });
  }

  /** A candidate that names target installations is used only on one of them (K02). The installation's name is the owner's option; with targets and no name the release is refused (fail closed). */
  #target(manifest: CandidateBody["manifest"]): void {
    if (manifest.targets === undefined) return;
    const me = this.#o.installationId;
    if (me === undefined) throw new DomainError("invalid_transition", "the release names the installations it is for, but this installation has no name configured (the releases installationId option), so it is not used here");
    if (!manifest.targets.includes(me)) throw new DomainError("invalid_transition", `the release is for ${manifest.targets.join(", ")}, not for this installation (${me})`);
  }
  /** Staging, activation and rollback need a valid signature from a trusted key when the trust root requires one (K02b). Returns the signing key's ID when there is one, else undefined. */
  async #signed(id: string): Promise<string | undefined> {
    const need = await this.#trust.required();
    const c = await this.#trust.check(id);
    if (need && !c.ok) throw new DomainError("invalid_transition", `the release is not signed as this installation requires: ${c.reason}`);
    return c.ok ? c.keyId : undefined;
  }
  /** A release the launcher found failing to start is not activated again (a rebuilt candidate has another ID). */
  async #startable(id: string): Promise<void> {
    const st = await this.#launcher.read().catch(() => undefined);
    const f = st?.failed.find((x) => x.id === id);
    if (f !== undefined) throw new DomainError("invalid_transition", `that release failed to start on this installation (${f.reason.slice(0, 120)}); a rebuilt candidate is a new release`);
  }
  /** Controller-worker protocol compatibility, checked before the pointer moves: the release's controller must share a protocol version with the workers (a rollback target too, so mixed versions are never switched into). */
  async #compatible(id: string, what: string): Promise<void> {
    // K02d: a release that states the database schemas it can run on is not switched to (or rolled back to) when the data has already been taken past them: code goes back only to a release that understands the data.
    const staged = (await this.#runner.get(STAGED, id))?.body as unknown as StagedBody | undefined;
    const db = (await this.#launcher.read().catch(() => undefined))?.db;
    if (staged?.schema !== undefined && db !== undefined && db.version > staged.schema.max) throw new DomainError("invalid_transition", `${what} understands database schema versions up to ${staged.schema.max}, but this database is at ${db.version}; it would not start (a snapshot taken before the upgrade has to be restored first)`);
    const c = this.#o.compat;
    if (c === undefined) return;
    const range = staged?.protocol;
    if (range === undefined) { if (c.required === true) throw new DomainError("invalid_transition", `${what} declares no worker protocol range (${COMPAT_FILE}), so it is not switched to`); return; }
    const n = negotiateProtocol(range, c.workers);
    if (!n.ok) throw new DomainError("invalid_transition", `${what} cannot work with this installation's workers: ${n.reason}`);
  }
  /** Tells the launcher which release the pointer may name next, before the pointer moves. */
  async #announce(ref: ReleaseRef): Promise<void> {
    const protocol = ((await this.#runner.get(STAGED, ref.id))?.body as unknown as StagedBody | undefined)?.protocol;
    await this.#launcher.expect({ id: ref.id, digest: ref.digest, ...(protocol === undefined ? {} : { protocol }) });
  }

  /**
   * `guard` (K02b) runs inside the operation that opens the journal and returns revision checks committed with it: the signature decision is made again at the commit point and pinned there, so a trusted key
   * withdrawn (or the signing setting changed) between the checks above and this commit refuses the switch instead of letting it through. Trust-root changes do not take the switch lock.
   */
  async #transition(owner: Principal, kind: "activate" | "rollback", commandId: string | undefined, to: ReleaseRef, expectedRevision: number | undefined, guard: () => Promise<Change[]> = async () => []): Promise<{ revision: number; replayed: boolean }> {
    const op = kind === "activate" ? "release.activate" : "release.rollback";
    let began = false;
    const begun = await this.#runner.command(op, { commandId: scopedCommandId(owner.id, commandId), actor: owner.id }, async () => ({
      payload: { to: to.id, digest: to.digest, expectedRevision: expectedRevision ?? null },
      build: async () => {
        began = true;
        const state = await this.#runner.get(STATE.kind, STATE.id);
        if (expectedRevision !== undefined && (state?.revision ?? 0) !== expectedRevision) throw new DomainError("stale_revision", `the activation record is at revision ${state?.revision ?? 0}, not ${expectedRevision}`, { currentRevision: state?.revision ?? 0 });
        const b = state?.body as unknown as ActivationBody | undefined;
        if (b?.journal !== undefined) throw new DomainError("invalid_transition", "a switch is already in progress or was interrupted; it resolves on the next start (release.status shows it)");
        if (b?.current?.id === to.id) throw new DomainError("invalid_transition", "that release is already the current one");
        if (kind === "rollback" && b?.current === undefined) throw new DomainError("invalid_transition", "there is nothing current to roll back from");
        const journal: JournalBody = { kind, ...(b?.current === undefined ? {} : { from: { id: b.current.id, digest: b.current.digest } }), to, by: owner.id, startedAt: this.#runner.now() };
        const next: ActivationBody = { ...(b?.current === undefined ? {} : { current: b.current }), ...(b?.previous === undefined ? {} : { previous: b.previous }), ...(b?.lastKnownGood === undefined ? {} : { lastKnownGood: b.lastKnownGood }), journal, history: b?.history ?? [], updatedAt: this.#runner.now() };
        const change = state === undefined ? { type: "create" as const, ref: STATE, body: next as unknown as JsonObject } : { type: "update" as const, ref: STATE, expectedRevision: state.revision, body: next as unknown as JsonObject };
        const pinned = await guard();
        return {
          ref: STATE, creates: state === undefined, changes: [change, ...pinned], detail: { kind, from: journal.from?.id ?? null, to: to.id },
          // Lost to a concurrent writer: when the trust root or the signature changed, say what the decision is now; otherwise the activation record moved.
          contention: async () => { try { await guard(); } catch (error) { if (error instanceof DomainError) return error; } const now = await this.#runner.get(STATE.kind, STATE.id); return new DomainError("stale_revision", `the activation record or the trust root changed at the same moment; read release.status and try again`, { currentRevision: now?.revision ?? 0 }); },
        };
      },
    }));
    if (!began) {
      // The same command again: answered from its record. If the switch it began is still open, finish it; otherwise say how it ended.
      const found = await this.#runner.get(STATE.kind, STATE.id);
      const state = found?.body as unknown as ActivationBody | undefined;
      if (state?.journal?.to.id === to.id) return this.#finish(owner.id, begun.revision, true);
      if (state?.current?.id === to.id) return { revision: found!.revision, replayed: true };
      throw new DomainError("invalid_transition", "an earlier attempt of this command did not complete; it was not applied");
    }
    await this.#o.hook?.("afterBegin");
    return this.#finish(owner.id, begun.revision, false);
  }

  /** Verification, the switch and the commit of an open journal. A crash anywhere leaves the journal for `recover`. */
  async #finish(by: string, revision: number, replayed: boolean): Promise<{ revision: number; replayed: boolean }> {
    const state = await this.#runner.get(STATE.kind, STATE.id);
    const body = state!.body as unknown as ActivationBody;
    const journal = body.journal!;
    const problems = await this.#verify(journal.to.id, journal.to.digest);
    if (problems.length > 0) { await this.#abort(by, state!.revision, body, `verification failed: ${problems[0]}`).catch(() => undefined); throw new DomainError("invalid_transition", `the release was not switched to: ${problems[0]}`); }
    await this.#o.hook?.("afterVerify");
    try { await this.#announce(journal.to); } catch (error) {
      await this.#abort(by, state!.revision, body, "the switch failed").catch(() => undefined);
      throw new DomainError("unavailable", `the release could not be switched: ${(error as Error).message.slice(0, 120)}`);
    }
    await this.#o.hook?.("afterAnnounce");
    try { await this.#sw.write(journal.to.id); } catch (error) {
      await this.#abort(by, state!.revision, body, "the switch failed").catch(() => undefined);
      throw new DomainError("unavailable", `the release could not be switched: ${(error as Error).message.slice(0, 120)}`);
    }
    await this.#o.hook?.("afterSwitch");
    const r = await this.#commit(by, state!.revision, body);
    return { revision: r, replayed };
  }

  async #commit(by: string, rev: number, body: ActivationBody, recovered = false, via?: { commandId: string; reason: string }): Promise<number> {
    const j = body.journal!;
    const entry: HistoryEntry = { at: this.#runner.now(), kind: via !== undefined ? "resolved" : recovered ? "recovered" : j.kind === "activate" ? "activated" : "rolled_back", by: via !== undefined ? by : j.by, to: j.to.id, ...(j.from === undefined ? {} : { from: j.from.id }), ...(via === undefined ? {} : { reason: via.reason }) };
    const next: ActivationBody = {
      current: { ...j.to, at: this.#runner.now(), by: j.by },
      ...(j.kind === "activate" && j.from !== undefined ? { previous: j.from } : {}),
      ...(body.lastKnownGood === undefined ? {} : { lastKnownGood: body.lastKnownGood }),
      history: [...body.history, entry].slice(-ACTIVATION_LIMITS.history),
      updatedAt: this.#runner.now(),
    };
    const r = await this.#runner.command("release.switch.commit", { commandId: via?.commandId ?? `release-switch-commit-${rev}`, actor: by }, async () => ({
      payload: { to: j.to.id, rev },
      build: async () => ({ ref: STATE, creates: false, changes: [{ type: "update" as const, ref: STATE, expectedRevision: rev, body: next as unknown as JsonObject }], detail: { to: j.to.id, kind: j.kind } }),
    }));
    return r.revision;
  }

  async #abort(by: string, rev: number, body: ActivationBody, reason: string, via?: { commandId: string }): Promise<void> {
    const j = body.journal!;
    const { journal: _j, ...rest } = body; void _j;
    const next: ActivationBody = { ...rest, history: [...body.history, { at: this.#runner.now(), kind: via === undefined ? "aborted" as const : "resolved" as const, by: via === undefined ? j.by : by, to: j.to.id, reason }].slice(-ACTIVATION_LIMITS.history), updatedAt: this.#runner.now() };
    await this.#runner.command("release.switch.abort", { commandId: via?.commandId ?? `release-switch-abort-${rev}`, actor: by }, async () => ({
      payload: { to: j.to.id, rev },
      build: async () => ({ ref: STATE, creates: false, changes: [{ type: "update" as const, ref: STATE, expectedRevision: rev, body: next as unknown as JsonObject }], detail: { to: j.to.id, reason } }),
    }));
  }

  /**
   * At start: an open journal is resolved by what the launcher's pointer says. At the new release: the switch happened, so it is committed. At the old one (or none, for a first activation): it did not, so the journal is closed.
   * Anything else is left open and shown by `status` (a person decides); nothing is guessed. Leftover temporary staging folders are removed.
   */
  async recover(): Promise<{ resolved: "none" | "committed" | "aborted" | "unresolved" | "fell_back" }> {
    return this.#serial("switch", async () => {
      await this.#sweep();
      const state = await this.#runner.get(STATE.kind, STATE.id);
      const body = state?.body as unknown as ActivationBody | undefined;
      if (state === undefined) return { resolved: "none" };
      if (body?.journal === undefined) return { resolved: (await this.#reconcileLauncher(state.revision, body!)) ? "fell_back" : "none" };
      const at = await this.#sw.read();
      const j = body.journal;
      if (at === j.to.id) { await this.#commit(j.by, state.revision, body, true); return { resolved: "committed" }; }
      if (at === (j.from?.id) || (at === undefined && j.from === undefined)) { await this.#abort(j.by, state.revision, body, "interrupted before the switch"); return { resolved: "aborted" }; }
      return { resolved: "unresolved" };
    });
  }

  /**
   * The launcher fell back while the controller was down: the pointer names the last known good, the launcher's record lists the record's current release as failed to start. The activation record catches up (the failed release
   * is no longer current, nothing is "previous" any more) and says so in its history. Anything else (a pointer moved by hand) stays `diverged`, reported and not rewritten.
   */
  async #reconcileLauncher(rev: number, body: ActivationBody): Promise<boolean> {
    const cur = body.current;
    if (cur === undefined) return false;
    let st; let pointer;
    try { st = await this.#launcher.read(); pointer = await this.#sw.read(); } catch { return false; }
    const known = st.known;
    const fail = st.failed.find((f) => f.id === cur.id);
    if (known === undefined || fail === undefined || pointer !== known.id || known.id === cur.id) return false;
    const at = this.#runner.now();
    const next: ActivationBody = { current: { id: known.id, digest: known.digest, at, by: "launcher", confirmedAt: known.confirmedAt }, lastKnownGood: { id: known.id, digest: known.digest, confirmedAt: known.confirmedAt, via: body.lastKnownGood?.id === known.id ? body.lastKnownGood.via : "startup" },
      history: [...body.history, { at, kind: "fell_back" as const, by: "launcher", from: cur.id, to: known.id, reason: fail.reason.slice(0, 200) }].slice(-ACTIVATION_LIMITS.history), updatedAt: at };
    await this.#runner.command("release.fell_back", { commandId: `release-fell-back-${rev}-${cur.id}`, actor: "launcher" }, async () => ({
      payload: { from: cur.id, to: known.id, rev },
      build: async () => ({ ref: STATE, creates: false, changes: [{ type: "update" as const, ref: STATE, expectedRevision: rev, body: next as unknown as JsonObject }], detail: { from: cur.id, to: known.id, reason: fail.reason.slice(0, 200) } }),
    }));
    return true;
  }

  /** Copies the owner's startup window into the launcher's file (no-op when it already holds it). */
  async syncLauncherWindow(): Promise<void> {
    const b = (await this.#runner.get(SETTINGS.kind, SETTINGS.id))?.body as unknown as ActivationSettingsBody | undefined;
    await this.#launcher.setWindow(b?.startupWindowSeconds ?? null);
  }

  /**
   * Tells the owner what the launcher wrote for them (a fall-back, a failed start) and closes the inbox items of what was acknowledged or confirmed since. Reads the launcher's file, so a fall-back made while the
   * database was down is told at the first start that can; a notice that cannot be sent now stays pending and is tried again by the next call (the controller's sweep runs it). Never throws for a send that failed.
   */
  async deliverStartNotices(): Promise<{ raised: number; settled: number; failed: number }> {
    const sink = this.#o.notices;
    if (sink === undefined) return { raised: 0, settled: 0, failed: 0 };
    const level = (await this.settingsFor()).startFailureLevel;
    try { return await this.#launcher.deliver({ raise: (n) => sink.raise(n, level), settle: (n) => sink.settle(n) }); } catch (error) { if (error instanceof LauncherStateError) return { raised: 0, settled: 0, failed: 1 }; throw error; }
  }
  /** The settings as the service itself reads them (no principal): used by the controller's own paths. */
  private async settingsFor(): Promise<{ startFailureLevel: StartFailureLevel }> {
    const b = (await this.#runner.get(SETTINGS.kind, SETTINGS.id))?.body as unknown as ActivationSettingsBody | undefined;
    return { startFailureLevel: b?.startFailureLevel ?? DEFAULT_START_FAILURE_LEVEL };
  }

  /** Owner only: the owner has seen the failed start or fall-back. The open notices (all, or those of one release) are closed and their inbox items leave the inbox. */
  async acknowledgeStart(owner: Principal, command: NoActor & { releaseId?: string }): Promise<{ acknowledged: number }> {
    strictOwner(owner, "acknowledge a failed start");
    known(command, ["commandId", "releaseId"]);
    const only = command.releaseId === undefined ? undefined : idOf(command.releaseId);
    const acknowledged = await this.#launcher.closeNotices((n) => only === undefined || n.release === only, "acknowledged");
    await this.deliverStartNotices().catch(() => undefined);
    return { acknowledged };
  }

  /**
   * The controller started from the current release reports that it is healthy (called by `startController` when everything is up). The launcher's record makes the release the last known good, and the activation record says
   * so. Only the release this process was started from (`runningRelease`), only when the record names it as current with no switch open. Safe to call again.
   */
  async confirmStartup(): Promise<{ confirmed: boolean; reason?: string }> {
    const running = this.#o.runningRelease;
    if (running === undefined) return { confirmed: false, reason: "this process was not started by the launcher" };
    return this.#serial("switch", async () => {
      const state = await this.#runner.get(STATE.kind, STATE.id);
      const body = state?.body as unknown as ActivationBody | undefined;
      if (state === undefined || body?.current?.id !== running) return { confirmed: false, reason: "the activation record does not name the release this process runs as current" };
      if (body.journal !== undefined) return { confirmed: false, reason: "a switch is open" };
      await this.#launcher.confirm(running);
      const known = (await this.#launcher.read()).known;
      if (known?.id !== running) return { confirmed: false, reason: "the launcher has no open start of this release" };
      await this.#markGood(state.revision, body, "startup", known.confirmedAt);
      return { confirmed: true };
    });
  }

  /** Owner only: vouches for the current release when nothing else confirmed it (a release not started by the launcher, or one that reports no health). Its files are verified first. */
  async confirm(owner: Principal, command: NoActor & { releaseId: string; expectedRevision?: number }): Promise<{ revision: number; releaseId: string }> {
    strictOwner(owner, "confirm a release as good");
    known(command, ["commandId", "releaseId", "expectedRevision"]);
    const id = idOf(command.releaseId);
    wholeRev(command.expectedRevision);
    return this.#serial("switch", async () => {
      const state = await this.#runner.get(STATE.kind, STATE.id);
      const body = state?.body as unknown as ActivationBody | undefined;
      if (state === undefined || body?.current?.id !== id) throw new DomainError("invalid_transition", "only the current release can be confirmed as good");
      if (command.expectedRevision !== undefined && state.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the activation record is at revision ${state.revision}, not ${command.expectedRevision}`, { currentRevision: state.revision });
      if (body.journal !== undefined) throw new DomainError("invalid_transition", "a switch is open; it resolves first");
      const problems = await this.#verify(id, body.current.digest);
      if (problems.length > 0) throw new DomainError("invalid_transition", `the release does not verify, so it is not marked good: ${problems[0]}`);
      const at = this.#runner.now();
      const protocol = ((await this.#runner.get(STAGED, id))?.body as unknown as StagedBody | undefined)?.protocol;
      await this.#launcher.vouch({ id, digest: body.current.digest, ...(protocol === undefined ? {} : { protocol }) });
      const revision = await this.#markGood(state.revision, body, "owner", at, scopedCommandId(owner.id, command.commandId), owner.id);
      return { revision, releaseId: id };
    });
  }

  async #markGood(rev: number, body: ActivationBody, via: "startup" | "owner", at: string, commandId?: string, actor = "launcher"): Promise<number> {
    const cur = body.current!;
    if (cur.confirmedAt !== undefined && body.lastKnownGood?.id === cur.id) return rev;
    const next: ActivationBody = { ...body, current: { ...cur, confirmedAt: at }, lastKnownGood: { id: cur.id, digest: cur.digest, confirmedAt: at, via }, history: [...body.history, { at, kind: "confirmed" as const, by: actor, to: cur.id, reason: via === "startup" ? "started and reported healthy" : "confirmed by the owner" }].slice(-ACTIVATION_LIMITS.history), updatedAt: at };
    const r = await this.#runner.command("release.confirm", { commandId: commandId ?? `release-confirm-${cur.id}-${rev}`, actor }, async () => ({
      payload: { releaseId: cur.id, rev, via },
      build: async () => ({ ref: STATE, creates: false, changes: [{ type: "update" as const, ref: STATE, expectedRevision: rev, body: next as unknown as JsonObject }], detail: { releaseId: cur.id, via } }),
    }));
    return r.revision;
  }

  /** The releases that must stay: current, previous (the rollback target) and both ends of an open switch. */
  async #liveIds(): Promise<Set<string>> {
    const body = (await this.#runner.get(STATE.kind, STATE.id))?.body as unknown as ActivationBody | undefined;
    return new Set([body?.current?.id, body?.previous?.id, body?.journal?.to.id, body?.journal?.from?.id, body?.lastKnownGood?.id].filter((v): v is string => v !== undefined));
  }

  /** Removes the oldest staged releases beyond `keep`, never a live one and never `spare`. */
  async #prune(keep: number, spare: string): Promise<void> {
    await this.#serial("switch", async () => {
      // What the launcher's pointer names is spared like a live release; if the pointer cannot be read nothing is pruned.
      const pointed = await this.#pointer();
      const all = (await this.#runner.list(STAGED, { limit: (await this.#caps()).staged + 1 })).map((a) => a.body as unknown as StagedBody).sort((a, b) => (a.stagedAt < b.stagedAt ? -1 : a.stagedAt > b.stagedAt ? 1 : a.candidateId < b.candidateId ? -1 : 1));
      const live = await this.#liveIds();
      let extra = all.length - keep;
      for (const b of all) {
        if (extra <= 0) break;
        if (live.has(b.candidateId) || b.candidateId === spare || b.candidateId === pointed) continue;
        await this.#removeStaged(b.candidateId, `prune-${b.candidateId}-${randomBytes(4).toString("hex")}`, "system");
        extra--;
      }
    });
  }

  async #removeStaged(id: string, commandId: string, actor: string): Promise<void> {
    const ref: AggregateRef = { kind: STAGED, id };
    await this.#runner.command("release.stage.remove", { commandId, actor }, async () => ({
      payload: { candidateId: id },
      build: async () => {
        const found = await this.#runner.get(STAGED, id);
        if (found === undefined) throw new DomainError("not_found", "that release is not staged");
        return { ref, creates: false, changes: [{ type: "delete" as const, ref, expectedRevision: found.revision }], detail: { candidateId: id } };
      },
    }));
    await removeTree(this.#dir(id));
  }

  /** Owner only. Removes a staged release (record and files) so the staging cap does not fill for good. Refused for the current release, the previous one (the rollback target) and either end of an open switch. */
  async remove(owner: Principal, command: NoActor & { candidateId: string }): Promise<{ candidateId: string; removed: true }> {
    mayManage(owner, "remove a staged release");
    known(command, ["commandId", "candidateId"]);
    const id = idOf(command.candidateId);
    return this.#serial("switch", async () => {
      if ((await this.#runner.get(STAGED, id)) === undefined) throw new DomainError("not_found", "that release is not staged");
      const live = await this.#liveIds();
      if (live.has(id) || (await this.#pointer()) === id) throw new DomainError("invalid_transition", "that release is the current one, the one before it (the rollback target), part of an open switch, or what the launcher follows; it cannot be removed");
      await this.#removeStaged(id, scopedCommandId(owner.id, command.commandId), owner.id);
      return { candidateId: id, removed: true };
    });
  }

  /** Owner only. Checks the current release's files (or the named staged release's) against the manifest digest the record keeps, as the launcher does at launch. */
  async verify(owner: Principal, command: { releaseId?: string } = {}): Promise<{ releaseId: string | null; digest: string | null; ok: boolean; problems: string[]; manifestDigest?: string; migrationPlan?: string; targets?: readonly string[]; signedBy?: string | null }> {
    mayManage(owner, "verify a release");
    const body = (await this.#runner.get(STATE.kind, STATE.id))?.body as unknown as ActivationBody | undefined;
    const id = command.releaseId === undefined ? body?.current?.id : idOf(command.releaseId);
    if (id === undefined) return { releaseId: null, digest: null, ok: false, problems: ["no release is current"] };
    const digest = body?.current?.id === id ? body.current.digest : ((await this.#runner.get(STAGED, id))?.body as unknown as StagedBody | undefined)?.digest;
    if (digest === undefined) throw new DomainError("not_found", "that release is neither current nor staged");
    const problems = await this.#verify(id, digest);
    // What the owner's word on an activation also covers (K02): the migration plan and the installations the release is for, from the candidate record, and whether a trusted key's signature is on it now.
    const manifest = ((await this.#runner.get(RELEASE_KINDS.candidate, id))?.body as unknown as CandidateBody | undefined)?.manifest;
    const sig = await this.#trust.check(id);
    const manifestDigest = await this.#trust.manifestDigest(id);
    return { releaseId: id, digest, ok: problems.length === 0, problems, ...(manifestDigest === undefined ? {} : { manifestDigest }), ...(manifest?.migrationPlan === undefined ? {} : { migrationPlan: manifest.migrationPlan }), ...(manifest?.targets === undefined ? {} : { targets: manifest.targets }), signedBy: sig.ok ? sig.keyId : null };
  }

  /**
   * Owner only: closes an open or interrupted switch that `recover` could not (the pointer names neither release). `commit` makes the new release current (verified first, pointer set to it); `abort` keeps the old one (pointer set back to it, or
   * removed when there was none); `set-pointer` sets the pointer to `releaseId` (one end of the switch) and closes the switch the way that pointer says. Needs the record revision quoted; leaves a history entry and an audit record.
   */
  async resolve(owner: Principal, command: NoActor & { action: string; releaseId?: string; expectedRevision: number }): Promise<{ revision: number; action: string }> {
    strictOwner(owner, "resolve a release switch");
    known(command, ["commandId", "action", "releaseId", "expectedRevision"]);
    if (command.action !== "commit" && command.action !== "abort" && command.action !== "set-pointer") bad("action", "must be commit, abort or set-pointer");
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) bad("expectedRevision", "is required: the activation record's revision from release.status");
    if (command.action === "set-pointer") idOf(command.releaseId); else if (command.releaseId !== undefined) bad("releaseId", "is only for set-pointer");
    return this.#serial("switch", async () => {
      const state = await this.#runner.get(STATE.kind, STATE.id);
      const body = state?.body as unknown as ActivationBody | undefined;
      if (state === undefined || body?.journal === undefined) throw new DomainError("invalid_transition", "there is no open switch to resolve");
      if (state.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the activation record is at revision ${state.revision}, not ${command.expectedRevision}`, { currentRevision: state.revision });
      const j = body.journal;
      let outcome: "commit" | "abort" = command.action === "commit" ? "commit" : "abort";
      if (command.action === "set-pointer") {
        if (command.releaseId === j.to.id) outcome = "commit";
        else if (command.releaseId === j.from?.id) outcome = "abort";
        else throw new DomainError("invalid_command", "releaseId: must be one end of the open switch", { field: "releaseId" });
      }
      const via = { commandId: scopedCommandId(owner.id, command.commandId) };
      if (outcome === "commit") {
        const problems = await this.#verify(j.to.id, j.to.digest);
        if (problems.length > 0) throw new DomainError("invalid_transition", `the new release cannot be made current: ${problems[0]}`);
        await this.#announce(j.to);
        await this.#sw.write(j.to.id);
        const revision = await this.#commit(owner.id, state.revision, body, false, { ...via, reason: `owner resolved: ${command.action}` });
        return { revision, action: command.action };
      }
      if (j.from !== undefined) {
        const problems = await this.#verify(j.from.id, j.from.digest);
        if (problems.length > 0) throw new DomainError("invalid_transition", `the old release cannot be kept: ${problems[0]}`);
        await this.#announce(j.from);
        await this.#sw.write(j.from.id);
      } else await this.#sw.clear();
      await this.#abort(owner.id, state.revision, body, `owner resolved: ${command.action}`, via);
      return { revision: state.revision + 1, action: command.action };
    });
  }

  /** Only leftovers are removed: a `.tmp-*` folder this process is filling now is never touched, and one owned by another process (or an older run) only once it has not been touched for the staleness window (default one hour). */
  async #sweep(): Promise<void> {
    const releases = join(this.#o.root, "releases");
    const stale = this.#o.tmpStaleMs ?? 3_600_000;
    let names: string[];
    try { names = await readdir(releases); } catch { return; /* nothing staged yet */ }
    for (const e of names) {
      if (!e.startsWith(".tmp-") || inflight.has(e)) continue;
      try {
        const age = Date.now() - (await stat(join(releases, e))).mtimeMs;
        if (e.includes(`-${PROCESS_TOKEN}-`) || age >= stale) await removeTree(join(releases, e));
      } catch { /* gone already, or not ours to judge now */ }
    }
  }

  async status(owner: Principal): Promise<ActivationStatus> {
    mayManage(owner, "read the release activation status");
    const state = await this.#runner.get(STATE.kind, STATE.id);
    const body = state?.body as unknown as ActivationBody | undefined;
    const pointer = await this.#sw.read().catch(() => "invalid" as const);
    const listed = await this.#runner.list(STAGED, { limit: ACTIVATION_LIMITS.listed });
    const s = await this.#settings();
    const trust = await this.#trust.list();
    const dbSchema = (await this.#launcher.read().catch(() => undefined))?.db?.version;
    return {
      revision: state?.revision ?? 0,
      ...(body?.current === undefined ? {} : { current: body.current }),
      ...(body?.previous === undefined ? {} : { previous: body.previous }),
      ...(body?.lastKnownGood === undefined ? {} : { lastKnownGood: body.lastKnownGood }),
      confirmed: body?.current?.confirmedAt !== undefined,
      failedStarts: (await this.#launcher.read().catch(() => undefined))?.failed.slice(-10) ?? [],
      ...(body?.journal === undefined ? {} : { journal: body.journal }),
      pointer: pointer ?? null,
      diverged: body?.journal === undefined && (pointer ?? null) !== (body?.current?.id ?? null),
      history: body?.history ?? [],
      staged: listed.map((a) => { const b = a.body as unknown as StagedBody; return { candidateId: b.candidateId, digest: b.digest, stagedAt: b.stagedAt, bytes: b.bytes, ...(b.schema === undefined ? {} : { schema: b.schema }) }; }),
      trust: { required: trust.required, keys: trust.keys.map((k) => ({ keyId: k.keyId, label: k.label })) },
      ...(dbSchema === undefined ? {} : { databaseSchema: dbSchema }),
      settings: { requireApproval: s.requireApproval, maxStagedBytes: s.maxStagedBytes, keepStaged: s.keepStaged, startupWindowSeconds: s.startupWindowSeconds, startFailureLevel: s.startFailureLevel, revision: s.revision },
      startNotices: ((await this.#launcher.read().catch(() => undefined))?.notices ?? []).map((n) => ({ kind: n.kind, release: n.release, ...(n.to === undefined ? {} : { to: n.to }), reason: n.reason, at: n.at, told: n.sentAt !== undefined, state: n.closedBy ?? "open" })),
    };
  }

  // ---- signed artifact sets: the trust root (K02b) -------------------------------------------------------------------------------------------------------------------------

  /** The trusted signing keys and whether a signature is needed now. Owner or a holder of release.manage. */
  async trust(by: Principal): Promise<{ revision: number; keys: readonly TrustedKey[]; require: boolean | null; required: boolean }> {
    mayManage(by, "read the release trust root");
    return this.#trust.list();
  }
  /** Owner only: trusts a key (an Ed25519 public key). Widens what may be activated, so chat shows it first. */
  async addTrustedKey(owner: Principal, command: NoActor & { publicKey?: unknown; keyFile?: unknown; label?: unknown; expectedRevision?: number }): Promise<{ revision: number; keyId: string }> {
    strictOwner(owner, "trust a release signing key");
    wholeRev(command.expectedRevision);
    const { keyFile, ...rest } = command;
    if ((command.publicKey === undefined) === (keyFile === undefined)) bad("publicKey", "give exactly one of publicKey and keyFile");
    return this.#trust.add(owner, (keyFile === undefined ? rest : { ...rest, publicKey: await this.#trustFile(keyFile, "keyFile") }) as never, this.#runner.now());
  }
  /** Owner only: withdraws a key; everything only it signed stops counting at once. */
  async removeTrustedKey(owner: Principal, command: NoActor & { keyId: unknown; expectedRevision?: number }): Promise<{ revision: number; keyId: string }> {
    strictOwner(owner, "stop trusting a release signing key");
    wholeRev(command.expectedRevision);
    return this.#trust.remove(owner, command, this.#runner.now());
  }
  /** Owner only: `true` always needs a signature, `false` never (digests only), `null` follows the trust root (needed once any key is trusted). */
  async requireSignature(owner: Principal, command: NoActor & { required: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    strictOwner(owner, "change whether releases must be signed");
    wholeRev(command.expectedRevision);
    return this.#trust.setRequired(owner, command, this.#runner.now());
  }
  /** Owner or a holder of release.manage: keeps a signature after checking it against the trust root. Changes nothing that runs; a signature by an untrusted key is refused. */
  async attachSignature(by: Principal, command: NoActor & { candidateId: string; signature?: unknown; signatureFile?: unknown }): Promise<{ keyId: string; replayed: boolean }> {
    mayManage(by, "attach a release signature");
    known(command, ["commandId", "candidateId", "signature", "signatureFile"]);
    const id = idOf(command.candidateId);
    if ((command.signature === undefined) === (command.signatureFile === undefined)) bad("signature", "give exactly one of signature and signatureFile");
    if ((await this.#runner.get(RELEASE_KINDS.candidate, id)) === undefined) throw new DomainError("not_found", "no such release candidate");
    const signature = command.signatureFile === undefined ? command.signature : await this.#trustFile(command.signatureFile, "signatureFile");
    return this.#trust.attach(by, { ...(command.commandId === undefined ? {} : { commandId: command.commandId }), candidateId: id, signature } as never, this.#runner.now());
  }
  /**
   * A key or a signature may be given as the name of a plain file in `trust/` under the release root, because the chat refuses anything that looks like a key (so none can be pasted into it) and the owner names no path:
   * the name is one path part, the file is a regular file (not a link) of at most 512 bytes, read as text. The content is validated exactly like a value given directly.
   */
  async #trustFile(name: unknown, field: string): Promise<string> {
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name.includes("..")) return bad(field, "must be the name of a file in the trust folder under the release root (letters, digits, dots, dashes and underscores)");
    const path = join(this.#o.root, "trust", name);
    let fh;
    try {
      const l = await lstat(path);
      if (!l.isFile()) return bad(field, "is not a plain file in the trust folder");
      fh = await open(path, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
    } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError("not_found", `${field}: no such file in the trust folder`); }
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > 512) return bad(field, "must be a plain file of at most 512 bytes");
      return (await fh.readFile("utf8")).trim();
    } finally { await fh.close(); }
  }

  /**
   * Records how far the database schema has gone (K02d), for the launcher's fall-back check. Called by `startController` once the database is open (so a migration this process ran is on record before anything else can fail).
   * Without a `schemaVersion` option nothing is recorded. Never throws: an unreadable launcher file leaves the old record and the next start tries again.
   */
  async noteDatabase(): Promise<number | undefined> {
    if (this.#o.schemaVersion === undefined) return undefined;
    try { const v = await this.#o.schemaVersion(); await this.#launcher.noteDatabase(v, this.#o.runningRelease ?? "controller"); return v; } catch { return undefined; }
  }
}

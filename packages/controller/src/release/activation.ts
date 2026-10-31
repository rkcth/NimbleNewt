import { createHash, randomBytes } from "node:crypto";
import { constants as fsc, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { canonicalJson } from "../storage/json.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { RELEASE_KINDS, type CandidateBody, type Cell } from "./release.js";

/**
 * Release staging and activation (card K02).
 *
 * Layout under the release root: `incoming/<candidate>/<artifact>` (where the build leaves the artifacts; the owner names no path), `releases/<candidate>/` (the staged, read-only release with `MANIFEST.json`) and
 * the activation pointer (`current`, a relative symlink, or `current.json` where symlinks are not dependable). Staging copies each artifact the candidate's manifest names, refuses anything whose digest differs, and moves the finished
 * directory into place with one rename. Activation is a journal in the database (intent, then the switch, then the commit), so an interruption at any point resolves to the old or the new release on the next start, never to a mixture.
 * Nothing here ever writes into a release directory that exists, and the launcher and updater are not part of a release (a routine release cannot replace them).
 */
export const ACTIVATION_LIMITS = { fileBytes: 4 * 1024 ** 3, files: 100, staged: 200, history: 20, listed: 50, entries: 2_000, chunk: 1024 * 1024 } as const;
const CANDIDATE_ID = /^rcn-[0-9a-f]{24}$/;
const SHA = /^[0-9a-f]{64}$/;
const STAGED = "release-staged";
const STATE: AggregateRef = { kind: "release-activation", id: "main" };
const SETTINGS: AggregateRef = { kind: "release-activation-settings", id: "main" };
const MANIFEST_FILE = "MANIFEST.json";

const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const wholeRev = (v: unknown): void => { if (v !== undefined && (!Number.isSafeInteger(v) || (v as number) < 0)) bad("expectedRevision", "must be a whole number"); };
const strictOwner = (by: Principal, what: string): void => { if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not ${what}; only the owner does`); };
const known = (command: object, fields: readonly string[]): void => { const u = Object.keys(command).filter((k) => !fields.includes(k)); if (u.length > 0) bad(u[0]!, "is not a field of this command"); };
const idOf = (v: unknown): string => { if (typeof v !== "string" || !CANDIDATE_ID.test(v)) return bad("candidateId", "is not a release candidate ID"); return v; };

/** What the staged directory holds, fixed at staging: the file digests of the candidate's manifest, with sizes. Its digest is what the owner's word is bound to. */
export interface StagedManifest { readonly candidateId: string; readonly sourceCommit: string; readonly files: Readonly<Record<string, { readonly sha256: string; readonly size: number }>> }
export interface StagedBody { readonly candidateId: string; readonly digest: string; readonly bytes: number; readonly files: number; readonly stagedBy: string; readonly stagedAt: string }
export interface ReleaseRef { readonly id: string; readonly digest: string }
export interface JournalBody { readonly kind: "activate" | "rollback"; readonly from?: ReleaseRef; readonly to: ReleaseRef; readonly by: string; readonly startedAt: string }
export interface HistoryEntry { readonly at: string; readonly kind: "activated" | "rolled_back" | "aborted" | "recovered"; readonly by: string; readonly to?: string; readonly from?: string; readonly reason?: string }
export interface ActivationBody { readonly current?: ReleaseRef & { readonly at: string; readonly by: string }; readonly previous?: ReleaseRef; readonly journal?: JournalBody; readonly history: readonly HistoryEntry[]; readonly updatedAt: string }
export interface ActivationSettingsBody { readonly requireApproval?: boolean; readonly maxStagedBytes?: number; readonly updatedBy: string; readonly updatedAt: string }

/** The place the launcher reads the active release from. */
export interface Switcher { read(): Promise<string | undefined | "invalid">; write(id: string): Promise<void> }

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
    const m = /^releases\/(rcn-[0-9a-f]{24})$/.exec(await readlink(path));
    return m === null ? "invalid" : m[1]!;
  }
  async write(id: string): Promise<void> {
    const tmp = join(this.root, `current.tmp-${randomBytes(6).toString("hex")}`);
    await symlink(`releases/${id}`, tmp);
    try { await rename(tmp, join(this.root, "current")); } catch (error) { await rm(tmp, { force: true }); throw error; }
    await syncDir(this.root);
  }
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
  readonly hook?: (point: "afterBegin" | "afterVerify" | "afterSwitch") => void | Promise<void>;
  readonly runner?: RunnerOptions;
}
export interface ActivationStatus {
  readonly revision: number;
  readonly current?: ReleaseRef & { readonly at: string; readonly by: string };
  readonly previous?: ReleaseRef;
  readonly journal?: JournalBody;
  /** What the launcher's pointer says now; `diverged` when it is not the release the record says is current (reported, never silently changed). */
  readonly pointer: string | null;
  readonly diverged: boolean;
  readonly history: readonly HistoryEntry[];
  readonly staged: readonly { readonly candidateId: string; readonly digest: string; readonly stagedAt: string; readonly bytes: number }[];
  readonly settings: { readonly requireApproval: boolean; readonly maxStagedBytes: number | null; readonly revision: number };
}

/** Settings and the staging/activation service in one place, because the settings are read inside the same checks. */
export class ReleaseActivationService {
  readonly #runner: CommandRunner;
  readonly #o: ActivationOptions;
  readonly #sw: Switcher;
  readonly #locks = new Map<string, Promise<unknown>>();
  private constructor(runner: CommandRunner, o: ActivationOptions) {
    this.#runner = runner; this.#o = o;
    this.#sw = (o.switcher ?? (process.platform === "win32" ? "pointer" : "symlink")) === "pointer" ? new PointerSwitcher(o.root) : new SymlinkSwitcher(o.root);
  }
  static withEpoch(storage: ControllerStorage, epoch: number, o: ActivationOptions): ReleaseActivationService { return new ReleaseActivationService(new CommandRunner(storage, epoch, o.runner ?? {}), o); }

  /** One thing at a time per key in this process; across processes the revision guards decide. */
  async #serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(key) ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(run);
    this.#locks.set(key, mine);
    try { return await mine; } finally { if (this.#locks.get(key) === mine) this.#locks.delete(key); }
  }
  #dir(id: string): string { return join(this.#o.root, "releases", id); }
  #platform(): Pick<Cell, "os" | "arch"> { return this.#o.platform ?? { os: process.platform as Cell["os"], arch: process.arch as Cell["arch"] }; }

  // ---- settings ----------------------------------------------------------------------------------------------------------------------------------------------------------

  async settings(owner: Principal): Promise<{ revision: number; requireApproval: boolean; maxStagedBytes: number | null; set: { requireApproval?: boolean; maxStagedBytes?: number } }> {
    strictOwner(owner, "read the release activation settings");
    const found = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
    const b = found?.body as unknown as ActivationSettingsBody | undefined;
    return { revision: found?.revision ?? 0, requireApproval: b?.requireApproval ?? true, maxStagedBytes: b?.maxStagedBytes ?? null, set: { ...(b?.requireApproval === undefined ? {} : { requireApproval: b.requireApproval }), ...(b?.maxStagedBytes === undefined ? {} : { maxStagedBytes: b.maxStagedBytes }) } };
  }
  /** `requireApproval`: activation needs the candidate approved through `release.approve` (default on). `maxStagedBytes`: an optional cap on all staged releases together (off by default; null turns it off). */
  async setSettings(owner: Principal, command: NoActor & { requireApproval?: unknown; maxStagedBytes?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    strictOwner(owner, "change the release activation settings");
    known(command, ["commandId", "requireApproval", "maxStagedBytes", "expectedRevision"]);
    if (command.requireApproval === undefined && command.maxStagedBytes === undefined) bad("requireApproval", "give requireApproval, maxStagedBytes or both");
    if (command.requireApproval !== undefined && typeof command.requireApproval !== "boolean") bad("requireApproval", "must be true or false");
    const m = command.maxStagedBytes;
    if (m !== undefined && m !== null && !(typeof m === "number" && Number.isSafeInteger(m) && m >= 1)) bad("maxStagedBytes", "must be a whole number of bytes, or null for no cap");
    wholeRev(command.expectedRevision);
    const r = await this.#runner.command("release.staging.settings.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { requireApproval: (command.requireApproval as boolean | undefined) ?? null, maxStagedBytes: m === undefined ? "keep" : (m as number | null), expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the release settings are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const before = current?.body as unknown as ActivationSettingsBody | undefined;
        const requireApproval = (command.requireApproval as boolean | undefined) ?? before?.requireApproval;
        const cap = m === undefined ? before?.maxStagedBytes : m === null ? undefined : (m as number);
        const body: ActivationSettingsBody = { ...(requireApproval === undefined ? {} : { requireApproval }), ...(cap === undefined ? {} : { maxStagedBytes: cap }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: SETTINGS, body: body as unknown as JsonObject } : { type: "update" as const, ref: SETTINGS, expectedRevision: current.revision, body: body as unknown as JsonObject };
        return { ref: SETTINGS, creates: current === undefined, changes: [change], detail: { requireApproval: requireApproval ?? null, maxStagedBytes: cap ?? null } };
      },
    }));
    return { revision: r.revision };
  }

  // ---- staging -----------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Copies the artifacts of a candidate from `incoming/<candidate>/` into a new versioned directory, refusing any file whose digest is not the manifest's. The same candidate staged twice is the same release. */
  async stage(owner: Principal, command: NoActor & { candidateId: string }): Promise<{ candidateId: string; digest: string; bytes: number; files: number; replayed: boolean }> {
    strictOwner(owner, "stage a release");
    known(command, ["commandId", "candidateId"]);
    const id = idOf(command.candidateId);
    return this.#serial(`stage:${id}`, async () => {
      const candidate = (await this.#runner.get(RELEASE_KINDS.candidate, id))?.body as unknown as CandidateBody | undefined;
      if (candidate === undefined) throw new DomainError("not_found", "no such release candidate");
      const existing = await this.#runner.get(STAGED, id);
      if (existing !== undefined) {
        const b = existing.body as unknown as StagedBody;
        const check = await this.#verify(id, b.digest);
        if (check.length > 0) throw new DomainError("invalid_transition", `the staged release no longer matches its digests: ${check[0]}`);
        return { candidateId: id, digest: b.digest, bytes: b.bytes, files: b.files, replayed: true };
      }
      const all = await this.#runner.list(STAGED, { limit: ACTIVATION_LIMITS.staged + 1 });
      if (all.length > ACTIVATION_LIMITS.staged) throw new DomainError("invalid_transition", `${ACTIVATION_LIMITS.staged} releases are already staged; the oldest must be removed first`);
      const settings = await this.settings(owner);
      const used = all.reduce((n, a) => n + (a.body as unknown as StagedBody).bytes, 0);
      const names = Object.keys(candidate.manifest.artifacts).sort();
      if (names.length > ACTIVATION_LIMITS.files) bad("candidateId", "has too many artifacts");
      this.#names(names);
      const releases = join(this.#o.root, "releases");
      await mkdir(releases, { recursive: true, mode: 0o700 });
      await mkdir(join(this.#o.root, "incoming"), { recursive: true, mode: 0o700 });
      const incoming = join(this.#o.root, "incoming", id);
      let incomingReal: string;
      try { incomingReal = await realpath(incoming); } catch { throw new DomainError("not_found", `the artifacts are not in place: nothing at incoming/${id}`); }
      if (incomingReal !== join(await realpath(join(this.#o.root, "incoming")), id)) throw new DomainError("invalid_command", "incoming/<candidate> is not a plain directory (a link is refused)");
      const tmp = join(releases, `.tmp-${id}-${randomBytes(6).toString("hex")}`);
      await mkdir(tmp, { mode: 0o700 });
      const files: Record<string, { sha256: string; size: number }> = {};
      let bytes = 0;
      try {
        for (const name of names) {
          const want = candidate.manifest.artifacts[name]!;
          const got = await this.#copyIn(incomingReal, name, join(tmp, ...name.split("/")));
          if (got.sha256 !== want) throw new DomainError("invalid_command", `${name}: its digest is not the one the candidate's manifest names (staged nothing)`, { field: "candidateId" });
          files[name] = got; bytes += got.size;
          if (settings.maxStagedBytes !== null && used + bytes > settings.maxStagedBytes) throw new DomainError("invalid_transition", `staging would use more than the ${settings.maxStagedBytes} bytes the owner allowed for staged releases`);
        }
        const manifest: StagedManifest = { candidateId: id, sourceCommit: candidate.manifest.sourceCommit, files };
        const text = canonicalJson(manifest as unknown as JsonObject);
        const fh = await open(join(tmp, MANIFEST_FILE), "wx", 0o444);
        try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
        const digest = sha256(text);
        // A directory left by a run that died after the rename and before the record is not a staged release: it is replaced, never trusted.
        await rm(this.#dir(id), { recursive: true, force: true });
        await rename(tmp, this.#dir(id));
        await syncDir(releases);
        const ref: AggregateRef = { kind: STAGED, id };
        const body: StagedBody = { candidateId: id, digest, bytes, files: names.length, stagedBy: owner.id, stagedAt: this.#runner.now() };
        await this.#runner.command("release.stage", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
          payload: { candidateId: id },
          build: async () => ({ ref, creates: true, changes: [{ type: "create" as const, ref, body: body as unknown as JsonObject }], detail: { candidateId: id, digest, bytes, files: names.length } }),
        }));
        return { candidateId: id, digest, bytes, files: names.length, replayed: false };
      } catch (error) {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Artifact names are validated again here, though the manifest checked them: they become path parts, and a name must never leave the release directory. */
  #names(names: readonly string[]): void {
    const seen = new Set<string>();
    for (const n of names) {
      const parts = n.split("/");
      if (n.length > 128 || n.includes("\\") || parts.some((p) => p === "" || p === "." || p === "..")) bad("candidateId", `${n.slice(0, 40)} is not a safe artifact name`);
      if (n.toLowerCase() === MANIFEST_FILE.toLowerCase()) bad("candidateId", `${MANIFEST_FILE} is reserved`);
      const low = n.toLowerCase();
      if (seen.has(low)) bad("candidateId", `${n.slice(0, 40)} collides with another artifact on a case-insensitive file system`);
      seen.add(low);
    }
    for (const a of seen) for (const b of seen) if (a !== b && b.startsWith(`${a}/`)) bad("candidateId", `${a.slice(0, 40)} is both a file and a folder`);
  }

  /** Reads one source file without following links, bounded in size, hashing as it copies to a new read-only file. */
  async #copyIn(sourceRoot: string, name: string, dest: string): Promise<{ sha256: string; size: number }> {
    const src = join(sourceRoot, ...name.split("/"));
    let real: string;
    try { real = await realpath(src); } catch { throw new DomainError("not_found", `${name}: not in the incoming folder`); }
    if (!real.startsWith(sourceRoot + sep)) throw new DomainError("invalid_command", `${name}: leaves the incoming folder (a link is refused)`);
    const NOFOLLOW = fsc.O_NOFOLLOW ?? 0;
    const input = await open(src, fsc.O_RDONLY | NOFOLLOW);
    try {
      const st = await input.stat();
      if (!st.isFile()) throw new DomainError("invalid_command", `${name}: is not a plain file`);
      if (st.size > ACTIVATION_LIMITS.fileBytes) throw new DomainError("invalid_command", `${name}: is larger than ${ACTIVATION_LIMITS.fileBytes} bytes`);
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

  /** The problems found between the staged directory and its recorded digests; empty when it is exactly what was staged. Bounded by the number of files recorded. */
  async #verify(id: string, digest: string): Promise<string[]> {
    const dir = this.#dir(id);
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

  // ---- activation ---------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Owner only. The word is bound to the candidate, to the digest of what was staged and to this platform, and needs the candidate approved (unless the owner turned that requirement off). */
  async activate(owner: Principal, command: NoActor & { candidateId: string; digest: string; expectedRevision?: number }): Promise<{ revision: number; replayed: boolean }> {
    strictOwner(owner, "activate a release");
    known(command, ["commandId", "candidateId", "digest", "expectedRevision"]);
    const id = idOf(command.candidateId);
    if (typeof command.digest !== "string" || !SHA.test(command.digest)) bad("digest", "must be the 64 hexadecimal characters of the staged release's digest");
    wholeRev(command.expectedRevision);
    return this.#serial("switch", async () => {
      const staged = await this.#runner.get(STAGED, id);
      if (staged === undefined) throw new DomainError("not_found", "that release is not staged");
      const sb = staged.body as unknown as StagedBody;
      if (sb.digest !== command.digest) throw new DomainError("invalid_command", "digest: is not the digest of the staged release; read it again before activating", { field: "digest" });
      const candidate = (await this.#runner.get(RELEASE_KINDS.candidate, id))?.body as unknown as CandidateBody;
      const p = this.#platform();
      if (!candidate.manifest.matrix.some((c) => c.os === p.os && c.arch === p.arch)) throw new DomainError("invalid_transition", `the release was not tested for this installation's platform (${p.os}/${p.arch})`);
      if ((await this.settings(owner)).requireApproval && (await this.#runner.get(RELEASE_KINDS.approval, id)) === undefined) throw new DomainError("invalid_transition", "the release is not approved (release.approve); the owner may switch that requirement off");
      return this.#transition(owner, "activate", command.commandId, { id, digest: sb.digest }, command.expectedRevision);
    });
  }

  /** Owner only. Goes back to the release that was current before the last activation, named by its ID so that a moved record cannot send it elsewhere. */
  async rollback(owner: Principal, command: NoActor & { releaseId: string; expectedRevision?: number }): Promise<{ revision: number; replayed: boolean }> {
    strictOwner(owner, "roll a release back");
    known(command, ["commandId", "releaseId", "expectedRevision"]);
    const id = idOf(command.releaseId);
    wholeRev(command.expectedRevision);
    return this.#serial("switch", async () => {
      const state = await this.#runner.get(STATE.kind, STATE.id);
      const body = state?.body as unknown as ActivationBody | undefined;
      if (body?.previous === undefined || body.previous.id !== id) throw new DomainError("invalid_transition", "that is not the release before the current one");
      return this.#transition(owner, "rollback", command.commandId, body.previous, command.expectedRevision);
    });
  }

  async #transition(owner: Principal, kind: "activate" | "rollback", commandId: string | undefined, to: ReleaseRef, expectedRevision: number | undefined): Promise<{ revision: number; replayed: boolean }> {
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
        const next: ActivationBody = { ...(b?.current === undefined ? {} : { current: b.current }), ...(b?.previous === undefined ? {} : { previous: b.previous }), journal, history: b?.history ?? [], updatedAt: this.#runner.now() };
        const change = state === undefined ? { type: "create" as const, ref: STATE, body: next as unknown as JsonObject } : { type: "update" as const, ref: STATE, expectedRevision: state.revision, body: next as unknown as JsonObject };
        return { ref: STATE, creates: state === undefined, changes: [change], detail: { kind, from: journal.from?.id ?? null, to: to.id } };
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
    if (problems.length > 0) { await this.#abort(by, state!.revision, body, `verification failed: ${problems[0]}`); throw new DomainError("invalid_transition", `the release was not switched to: ${problems[0]}`); }
    await this.#o.hook?.("afterVerify");
    try { await this.#sw.write(journal.to.id); } catch (error) {
      await this.#abort(by, state!.revision, body, "the switch failed").catch(() => undefined);
      throw new DomainError("unavailable", `the release could not be switched: ${(error as Error).message.slice(0, 120)}`);
    }
    await this.#o.hook?.("afterSwitch");
    const r = await this.#commit(by, state!.revision, body);
    return { revision: r, replayed };
  }

  async #commit(by: string, rev: number, body: ActivationBody, recovered = false): Promise<number> {
    const j = body.journal!;
    const entry: HistoryEntry = { at: this.#runner.now(), kind: recovered ? "recovered" : j.kind === "activate" ? "activated" : "rolled_back", by: j.by, to: j.to.id, ...(j.from === undefined ? {} : { from: j.from.id }) };
    const next: ActivationBody = {
      current: { ...j.to, at: this.#runner.now(), by: j.by },
      ...(j.kind === "activate" && j.from !== undefined ? { previous: j.from } : {}),
      history: [...body.history, entry].slice(-ACTIVATION_LIMITS.history),
      updatedAt: this.#runner.now(),
    };
    const r = await this.#runner.command("release.switch.commit", { commandId: `release-switch-commit-${rev}`, actor: by }, async () => ({
      payload: { to: j.to.id, rev },
      build: async () => ({ ref: STATE, creates: false, changes: [{ type: "update" as const, ref: STATE, expectedRevision: rev, body: next as unknown as JsonObject }], detail: { to: j.to.id, kind: j.kind } }),
    }));
    return r.revision;
  }

  async #abort(by: string, rev: number, body: ActivationBody, reason: string): Promise<void> {
    const j = body.journal!;
    const { journal: _j, ...rest } = body; void _j;
    const next: ActivationBody = { ...rest, history: [...body.history, { at: this.#runner.now(), kind: "aborted" as const, by: j.by, to: j.to.id, reason }].slice(-ACTIVATION_LIMITS.history), updatedAt: this.#runner.now() };
    await this.#runner.command("release.switch.abort", { commandId: `release-switch-abort-${rev}`, actor: by }, async () => ({
      payload: { to: j.to.id, rev },
      build: async () => ({ ref: STATE, creates: false, changes: [{ type: "update" as const, ref: STATE, expectedRevision: rev, body: next as unknown as JsonObject }], detail: { to: j.to.id, reason } }),
    }));
  }

  /**
   * At start: an open journal is resolved by what the launcher's pointer says. At the new release: the switch happened, so it is committed. At the old one (or none, for a first activation): it did not, so the journal is closed.
   * Anything else is left open and shown by `status` (a person decides); nothing is guessed. Leftover temporary staging folders are removed.
   */
  async recover(): Promise<{ resolved: "none" | "committed" | "aborted" | "unresolved" }> {
    return this.#serial("switch", async () => {
      await this.#sweep();
      const state = await this.#runner.get(STATE.kind, STATE.id);
      const body = state?.body as unknown as ActivationBody | undefined;
      if (state === undefined || body?.journal === undefined) return { resolved: "none" };
      const at = await this.#sw.read();
      const j = body.journal;
      if (at === j.to.id) { await this.#commit(j.by, state.revision, body, true); return { resolved: "committed" }; }
      if (at === (j.from?.id) || (at === undefined && j.from === undefined)) { await this.#abort(j.by, state.revision, body, "interrupted before the switch"); return { resolved: "aborted" }; }
      return { resolved: "unresolved" };
    });
  }

  async #sweep(): Promise<void> {
    try { for (const e of await readdir(join(this.#o.root, "releases"))) if (e.startsWith(".tmp-")) await rm(join(this.#o.root, "releases", e), { recursive: true, force: true }); } catch { /* nothing staged yet */ }
  }

  async status(owner: Principal): Promise<ActivationStatus> {
    strictOwner(owner, "read the release activation status");
    const state = await this.#runner.get(STATE.kind, STATE.id);
    const body = state?.body as unknown as ActivationBody | undefined;
    const pointer = await this.#sw.read().catch(() => "invalid" as const);
    const listed = await this.#runner.list(STAGED, { limit: ACTIVATION_LIMITS.listed });
    const s = await this.settings(owner);
    return {
      revision: state?.revision ?? 0,
      ...(body?.current === undefined ? {} : { current: body.current }),
      ...(body?.previous === undefined ? {} : { previous: body.previous }),
      ...(body?.journal === undefined ? {} : { journal: body.journal }),
      pointer: pointer ?? null,
      diverged: body?.journal === undefined && (pointer ?? null) !== (body?.current?.id ?? null),
      history: body?.history ?? [],
      staged: listed.map((a) => { const b = a.body as unknown as StagedBody; return { candidateId: b.candidateId, digest: b.digest, stagedAt: b.stagedAt, bytes: b.bytes }; }),
      settings: { requireApproval: s.requireApproval, maxStagedBytes: s.maxStagedBytes, revision: s.revision },
    };
  }
}

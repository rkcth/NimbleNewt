import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBlobStore } from "../artifacts/index.js";
import { DomainError } from "../domain/errors.js";
import type { NotificationService } from "../notifications/index.js";
import type { Principal } from "../security/principals.js";
import { SqliteStorage } from "../storage/index.js";
import { BackupConfigService, buildTarget, describeSchedule, type ConfigBody, type PurgeRecord, type PurgeResult, type StateBody, type TargetRecord } from "./config.js";
import type { BackupKey } from "./crypto.js";
import { filesSealed } from "./format.js";
import { pruneGenerations, type ExtraKeyUse } from "./generations.js";
import { RestoreRefused, restoreBackup } from "./restore.js";
import { chooseKept, describeRules, listBackups, staysUpToDays, type BackupInfo, type Retention } from "./retention.js";
import type { BackupService } from "./service.js";
import { FolderDriver, HttpDriver, checkedName, safeMessage, type TargetDriver } from "./targets.js";
import { readManifest, verifyBackup } from "./verify.js";

type Notify = Pick<NotificationService, "emitFromController" | "settleFromController" | "openRefIds">;
export const PRIMARY = "primary";
const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface BackupSystemOptions {
  readonly service: BackupService;
  readonly config: BackupConfigService;
  /** The main backups folder. */
  readonly root: string;
  readonly notifications?: Notify;
  /** The counts and the age limit in force (the owner's retention settings). */
  readonly retention: () => Promise<Retention>;
  /** The stored credential of an off-machine target, by name (the secret store). Without it, an off-machine target with a credential cannot be reached. */
  readonly resolveSecret?: (name: string) => Promise<string | undefined>;
  /** Tests: another driver for a target. */
  readonly driverFor?: (target: TargetRecord) => TargetDriver | undefined;
  /** Tests: the test restore itself. Default: the checksums, then a restore into a scratch store that is thrown away. */
  readonly testRestore?: (path: string) => Promise<TestRestoreResult>;
  /** The unlocked backup key for a test restore of an encrypted backup (never asked of the owner: undefined when the host has no passcode or recovery file in place). */
  readonly unlock?: () => Promise<BackupKey | undefined>;
  /** Where the archived key generations are (card K01b): one with no backup left on any target is deleted and the owner told. */
  readonly keyringFile?: string;
  readonly now?: () => Date;
  /** Least time between two looks of the sweep (default 5 minutes). */
  readonly everyMs?: number;
  /** Where the scratch store of a test restore is made (default: the system's temporary folder). */
  readonly scratchDirectory?: string;
}

export interface TestRestoreResult { readonly ok: boolean; readonly method: "restore" | "checksums" | "presence"; readonly detail: string }

export interface PurgeAnswer {
  readonly status: "needs-confirmation" | "preview" | "purged" | "pending";
  readonly purgeId?: string;
  readonly names: readonly string[];
  readonly plan: readonly { readonly target: string; readonly name: string; readonly action: string }[];
  readonly warning?: string;
  /** Per target: what happened to each name (`removed`, `absent`, `pending` while the target cannot be reached). */
  readonly results?: Readonly<Record<string, Readonly<Record<string, PurgeResult>>>>;
  readonly text: string;
}

const goodKind = (b: BackupInfo): boolean => b.trusted && b.manifest.kind !== "pre-upgrade" && b.manifest.kind !== "pre-restore";
const msg = (error: unknown): string => safeMessage(error);
/** Text without the host's paths: the backups folder itself, and any quoted absolute path a system error put in it. */
const withoutPaths = (text: string, root: string): string => text.split(root).join("the backups folder").replace(/'(?:\/|[A-Za-z]:\\|\\\\)[^']*'/g, "(a path)");

/**
 * The configurable backup system (card K01c) around `BackupService`: copies of every backup to the owner's targets, each target's own retention, the owner's purge of named backups on every target (an unreachable one stays
 * listed as not yet purged and is retried), a periodic test restore, deletion of key generations nothing uses any more, and the notices the owner gets when a backup fails, is missed, is older than the limit, a target
 * cannot be reached or a test restore fails. Nothing here ever deletes the newest good backup by age, and nothing deletes a backup on a target it cannot reach.
 */
export class BackupSystem {
  readonly #o: BackupSystemOptions;
  #next = 0;
  #seq = 0;
  #busy: Promise<unknown> = Promise.resolve();
  #tasks = new Set<Promise<unknown>>();
  constructor(options: BackupSystemOptions) { this.#o = options; }

  #now(): Date { return (this.#o.now ?? (() => new Date()))(); }
  #primary(): TargetDriver { return new FolderDriver(this.#o.root); }
  #driver(t: TargetRecord): TargetDriver {
    const given = this.#o.driverFor?.(t);
    if (given !== undefined) return given;
    if (t.kind === "offsite") return new HttpDriver(t.location, t.credential === undefined ? {} : { token: async () => { const v = await this.#o.resolveSecret?.(t.credential!); if (v === undefined) throw new Error(`the stored credential ${t.credential} is not available`); return v; } });
    return new FolderDriver(t.location, { primaryRoot: this.#o.root });
  }

  /** Waits for the copies and checks started in the background (tests, shutdown). */
  async idle(): Promise<void> { while (this.#tasks.size > 0) await Promise.allSettled([...this.#tasks]); await this.#busy.catch(() => undefined); }
  #background(work: Promise<unknown>): void { const t = work.catch(() => undefined); this.#tasks.add(t); void t.finally(() => this.#tasks.delete(t)); }

  /** The folder names of the backups verified complete, for the age limit. */
  async verifiedNames(): Promise<ReadonlySet<string>> {
    const s = await this.#o.config.state();
    return new Set(s.verified.filter((v) => v.target === PRIMARY && v.ok).map((v) => v.name));
  }

  #rulesFor(t: TargetRecord | undefined, base: Retention, state: StateBody, listed: readonly BackupInfo[]): Retention {
    const mine = state.verified.filter((v) => v.target === (t?.id ?? PRIMARY) && v.ok).map((v) => v.name);
    const newest = listed.filter((b) => b.trusted && mine.includes(b.manifest.name)).sort((a, b) => b.at.localeCompare(a.at))[0];
    return { ...base, ...(t?.daily == null ? {} : { daily: t.daily }), ...(t?.weekly == null ? {} : { weekly: t.weekly }), ...(t?.keepDays == null ? {} : { maxAgeDays: t.keepDays }), ...(newest === undefined ? {} : { protect: new Set([newest.manifest.name]) }) };
  }

  async #mark(target: string, name: string, method: "restore" | "checksums", ok: boolean, detail?: string): Promise<void> {
    await this.#o.config.updateState("verified", (s) => ({ ...s, verified: [...s.verified.filter((v) => !(v.target === target && v.name === name)), { target, name, at: this.#now().toISOString(), method, ok, ...(detail === undefined ? {} : { detail: detail.slice(0, 200) }) }] }));
  }

  async #targetResult(t: TargetRecord, ok: boolean, message?: string): Promise<void> {
    const at = this.#now().toISOString();
    await this.#o.config.updateState("target", (s) => {
      const { lastError: _e, ...before } = s.targets[t.id] ?? {}; void _e;
      return { ...s, targets: { ...s.targets, [t.id]: ok ? { ...before, lastOkAt: at } : { ...before, ...(s.targets[t.id]?.lastOkAt === undefined ? {} : { lastOkAt: s.targets[t.id]!.lastOkAt }), lastError: { at, message: (message ?? "failed").slice(0, 300) } } } };
    });
  }

  // ---- after a backup --------------------------------------------------------------------------------------------------------

  /** Called by the service after each backup: checks the new copy, copies it to every target, applies each target's own retention and removes key generations nothing uses. Never throws for one target's trouble. */
  async afterBackup(made: { path: string; manifest: { name: string; kind: string } }): Promise<void> {
    const next = this.#busy.then(async () => {
      if (made.manifest.kind === "pre-upgrade" || made.manifest.kind === "pre-restore") return;
      // Never the owner's passcode or recovery file here: reading it is rate limited like a proof and belongs to the owner's own ask.
      const check = await verifyBackup(made.path).catch(() => undefined);
      if (check?.ok === true) await this.#mark(PRIMARY, made.manifest.name, "checksums", true).catch(() => undefined);
      for (const t of (await this.#o.config.effective()).targets) await this.#copyTo(t, made.path, made.manifest.name);
      await this.#pruneAll();
      await this.#keys();
      await this.#notify();
    });
    this.#busy = next.catch(() => undefined);
    await next;
  }

  /** Whether the owner asked for this backup to be purged (any purge, finished or not): such a backup is never copied anywhere again. */
  async #purged(name: string): Promise<boolean> { return (await this.#o.config.state()).purges.some((p) => p.names.includes(name)); }

  async #copyTo(t: TargetRecord, path: string, name: string): Promise<boolean> {
    const driver = this.#driver(t);
    try {
      if (await this.#purged(name)) return false;
      await driver.put(path, name);
      // A purge recorded while the copy was being made (here or by another controller) may have found nothing to delete on this target yet: the copy is taken away again, so a purged backup is never copied back.
      if (await this.#purged(name)) { await driver.remove(name); return false; }
      await this.#targetResult(t, true);
      if (t.kind !== "offsite") { const there = await driver.list().then((l) => l.find((b) => b.manifest.name === name)); if (there !== undefined && (await verifyBackup(there.path).catch(() => ({ ok: false }))).ok) await this.#mark(t.id, name, "checksums", true); }
      return true;
    } catch (error) { await this.#targetResult(t, false, `copying ${name}: ${msg(error)}`).catch(() => undefined); return false; }
  }

  /** Each target's own retention, and the main folder's age limit when nothing new was made. A target that cannot be reached keeps everything and shows as failing. */
  async #pruneAll(): Promise<void> {
    const base = await this.#o.retention();
    const state = await this.#o.config.state();
    for (const t of (await this.#o.config.effective()).targets) {
      try {
        const driver = this.#driver(t);
        const listed = await driver.list();
        const kept = chooseKept(listed, this.#rulesFor(t, base, state, listed), this.#now());
        for (const b of listed) if (!kept.has(b.path)) await driver.remove(b.manifest.name);
        await this.#targetResult(t, true);
      } catch (error) { await this.#targetResult(t, false, `its backups could not be listed or trimmed: ${msg(error)}`).catch(() => undefined); }
    }
  }

  /** Copies the backups a target lacks (a target added later, or one that was down) that its own rules would keep: the newest first, a few at a time. */
  async #catchUp(t: TargetRecord, limit: number): Promise<void> {
    const driver = this.#driver(t);
    try {
      const remote = await driver.list();
      const local = (await listBackups(this.#o.root)).filter((b) => goodKind(b) && (b.manifest.kind === "manual" || b.manifest.kind === "scheduled"));
      const have = new Set(remote.map((b) => b.manifest.name));
      const purged = new Set((await this.#o.config.state()).purges.flatMap((p) => p.names));
      const missing = local.filter((b) => !have.has(b.manifest.name) && !purged.has(b.manifest.name));
      if (missing.length === 0) return;
      const base = await this.#o.retention();
      const kept = chooseKept([...remote, ...missing], this.#rulesFor(t, base, await this.#o.config.state(), remote), this.#now());
      let n = 0;
      for (const b of missing) { if (n >= limit) break; if (!kept.has(b.path)) continue; if (await this.#copyTo(t, b.path, b.manifest.name)) n += 1; else break; }
    } catch (error) { await this.#targetResult(t, false, `it could not be reached: ${msg(error)}`).catch(() => undefined); }
  }

  // ---- key generations -------------------------------------------------------------------------------------------------------

  async #keyUse(): Promise<ExtraKeyUse> {
    const ids: string[] = []; let unreadable = 0;
    for (const t of (await this.#o.config.effective()).targets) {
      try { for (const b of await this.#driver(t).list()) { const id = b.manifest.encryption?.keyId; if (typeof id === "string") ids.push(id); } } catch { unreadable += 1; }
    }
    // A purge still waiting on a target means a copy that cannot be seen: nothing is removable then either.
    for (const p of (await this.#o.config.state()).purges) if (!p.done) unreadable += 1;
    return { keyIds: ids, unreadable };
  }

  /** Deletes the archived key of a generation no backup on any target uses, and tells the owner its recovery file opens nothing any more. */
  async #keys(): Promise<void> {
    if (this.#o.keyringFile === undefined) return;
    const result = await pruneGenerations(this.#o.keyringFile, this.#o.root, await this.#keyUse()).catch(() => undefined);
    for (const g of result?.removed ?? []) await this.#say(`backup-keys`, `g${g.generation}`, `Old backup key ${g.generation} deleted`, `No backup on any target is left under key generation ${g.generation} (key ${g.keyId.slice(0, 12)}): its archived key was deleted, so the recovery file and passcodes made for it open nothing any more. You can destroy that recovery file.`, "notice");
  }

  // ---- the owner's commands --------------------------------------------------------------------------------------------------

  #owner(by: Principal, what: string): void { if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not ${what}`); }

  /** Adds a target after testing it: nothing is added when the test fails. Existing backups are then copied to it in the background. */
  async addTarget(owner: Principal, command: { commandId: string; [k: string]: unknown }): Promise<{ revision: number; target: TargetRecord; text: string; test?: { ok: boolean; detail: string; warning?: string } }> {
    this.#owner(owner, "add a backup target");
    const cfg = await this.#o.config.effective();
    const { commandId: _c, expectedRevision: _r, ...fields } = command; void _c; void _r;
    const probe = buildTarget(fields, this.#now().toISOString(), owner.id, `${owner.id}:${command.commandId}`, this.#o.config.keptSecrets());
    // The ID is made from the scoped command, so the same command again finds the target it made and does not test again.
    const again = cfg.targets.find((t) => t.name.toLowerCase() === probe.name.toLowerCase() && t.location === probe.location);
    let test: { ok: boolean; detail: string; warning?: string } | undefined;
    if (again === undefined) {
      test = await this.#driver(probe).test().catch((error) => ({ ok: false, detail: msg(error) }));
      if (!test.ok) throw new DomainError("invalid_command", `the target did not pass its test, so it was not added: ${test.detail}`);
    }
    const added = await this.#o.config.addTarget(owner, command as never);
    if (test !== undefined) {
      await this.#o.config.updateState("target-tested", (s) => ({ ...s, targets: { ...s.targets, [added.target.id]: { ...(s.targets[added.target.id] ?? {}), lastTest: { at: this.#now().toISOString(), ok: true, detail: test!.detail } } } })).catch(() => undefined);
      this.#background(this.#catchUp(added.target, 5).then(() => this.#notify()));
    }
    return { ...added, ...(test === undefined ? {} : { test }), text: `${added.text}${test?.warning === undefined ? "" : ` Warning: ${test.warning}.`} The backups that exist are being copied there now.` };
  }

  /** Tests a target now (reachable, writable) and records the answer. Owner only. */
  async testTarget(owner: Principal, id: string): Promise<{ target: string; ok: boolean; detail: string; warning?: string }> {
    this.#owner(owner, "test a backup target");
    const t = this.#find(await this.#o.config.effective(), id);
    const r = await this.#driver(t).test().catch((error) => ({ ok: false, detail: msg(error) } as { ok: boolean; detail: string; warning?: string }));
    await this.#o.config.updateState("target-tested", (s) => ({ ...s, targets: { ...s.targets, [t.id]: { ...(s.targets[t.id] ?? {}), lastTest: { at: this.#now().toISOString(), ok: r.ok, detail: r.detail.slice(0, 300) } } } }));
    return { target: t.name, ok: r.ok, detail: r.detail, ...(r.warning === undefined ? {} : { warning: r.warning }) };
  }

  #find(cfg: ConfigBody, id: string): TargetRecord {
    const key = String(id).toLowerCase();
    const t = cfg.targets.find((x) => x.id === id || x.name.toLowerCase() === key);
    if (t === undefined) throw new DomainError("not_found", "no such backup target");
    return t;
  }

  /** Runs a test restore now of the newest backup of a target (default: the main folder), or of a named backup. Owner only. */
  async verifyNow(owner: Principal, args: { name?: string; target?: string } = {}): Promise<{ ok: boolean; name: string; target: string; method: string; detail: string }> {
    this.#owner(owner, "run a test restore");
    return this.#verify(args.target, args.name, true);
  }

  async #verify(targetId: string | undefined, name: string | undefined, withUnlock: boolean): Promise<{ ok: boolean; name: string; target: string; method: string; detail: string }> {
    const cfg = await this.#o.config.effective();
    const t = targetId === undefined || targetId === PRIMARY ? undefined : this.#find(cfg, targetId);
    const driver = t === undefined ? this.#primary() : this.#driver(t);
    const label = t?.name ?? "the main backups folder";
    let listed: BackupInfo[];
    try { listed = await driver.list(); } catch (error) { throw new DomainError("unavailable", `${label} cannot be reached: ${msg(error)}`); }
    const wanted = name === undefined ? listed.find(goodKind) : listed.find((b) => b.manifest.name === name);
    if (wanted === undefined) throw new DomainError("not_found", name === undefined ? `${label} holds no backup to test` : `${label} holds no backup named ${name}`);
    const scratch = await mkdtemp(join(this.#o.scratchDirectory ?? tmpdir(), "nn-backup-verify-"));
    let result: TestRestoreResult;
    try {
      let path = wanted.path;
      if (t !== undefined) { path = join(scratch, "copy"); await driver.fetch(wanted.manifest.name, path); }
      result = await (this.#o.testRestore ?? ((p) => this.#restoreTest(p, scratch, withUnlock)))(path).catch((error) => ({ ok: false, method: "restore" as const, detail: msg(error) }));
    } catch (error) { result = { ok: false, method: "restore", detail: `the copy could not be fetched: ${msg(error)}` }; }
    finally { await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined); }
    const at = this.#now().toISOString();
    if (result.method !== "presence") await this.#mark(t?.id ?? PRIMARY, wanted.manifest.name, result.method === "restore" ? "restore" : "checksums", result.ok, result.detail).catch(() => undefined);
    await this.#o.config.updateState("test-restore", (s) => ({ ...s, lastTestRestore: { at, ok: result.ok, name: wanted.manifest.name, target: label, method: result.method, detail: result.detail.slice(0, 300) } }));
    await this.#notify().catch(() => undefined);
    return { ok: result.ok, name: wanted.manifest.name, target: label, method: result.method, detail: result.detail };
  }

  /** The checksums, then a restore into a scratch store that is thrown away. A backup sealed for everything cannot be opened without the passcode or recovery file in place: it is then checked for presence only, and that proves little (said so). */
  async #restoreTest(path: string, scratch: string, withUnlock: boolean): Promise<TestRestoreResult> {
    const read = await readManifest(path);
    if (read.manifest === undefined) return { ok: false, method: "checksums", detail: read.problems.join("; ").slice(0, 300) };
    const manifest = read.manifest;
    const unlock = withUnlock && manifest.encryption !== undefined ? await this.#o.unlock?.().catch(() => undefined) : undefined;
    if (manifest.encryption !== undefined && filesSealed(manifest) && unlock === undefined) return { ok: true, method: "presence", detail: "this backup is sealed for everything and the passcode or recovery file is not in place on this machine, so it could not be opened: only its manifest was read. Put the passcode or recovery file where the host expects it and ask for a test restore (backup.verify.run) for a real test." };
    const check = await verifyBackup(path, unlock === undefined ? {} : { unlock });
    if (!check.ok) return { ok: false, method: "checksums", detail: `the backup does not check out: ${check.problems.join("; ")}`.slice(0, 300) };
    try {
      const blobs = await FileBlobStore.open({ directory: join(scratch, "blobs") });
      // A file in the scratch folder, not memory: a large installation's backup must not be held in memory by a check.
      const target = await SqliteStorage.open({ path: join(scratch, "restore-test.sqlite") });
      const r = await restoreBackup(path, target, { blobs, piTarget: (id) => join(scratch, "pi", id.replace(/[^A-Za-z0-9._-]/g, "_")), skipSecrets: true, ...(unlock === undefined ? {} : { unlock }) }).finally(() => target.close());
      return { ok: true, method: "restore", detail: `restored into a scratch store and thrown away: ${r.rows} rows, ${r.blobsRestored} artifact files, ${r.piStoresRestored} conversation stores` };
    } catch (error) {
      if (error instanceof RestoreRefused && /schema version/.test(error.message)) return { ok: true, method: "checksums", detail: `the files check out against the manifest; it was made under another schema version, which a restore handles with the version that made it: ${error.message}`.slice(0, 300) };
      return { ok: false, method: "restore", detail: `the restore into a scratch store failed: ${msg(error)}` };
    }
  }

  // ---- purge -----------------------------------------------------------------------------------------------------------------

  /** Every target with what it holds right now (or why it cannot be read). */
  async #copies(): Promise<{ id: string; name: string; driver: TargetDriver; listed?: BackupInfo[]; error?: string }[]> {
    const out: { id: string; name: string; driver: TargetDriver; listed?: BackupInfo[]; error?: string }[] = [];
    const add = async (id: string, name: string, driver: TargetDriver): Promise<void> => { try { out.push({ id, name, driver, listed: await driver.list() }); } catch (error) { out.push({ id, name, driver, error: msg(error) }); } };
    await add(PRIMARY, "the main backups folder", this.#primary());
    for (const t of (await this.#o.config.effective()).targets) await add(t.id, t.name, this.#driver(t));
    return out;
  }

  /**
   * The owner's purge of named backups from every target (card K01c). Without `confirm` it refuses to delete the last good backup anywhere and says what it would do; a target that cannot be reached is listed as not yet purged
   * and retried until it is. Recorded in the audit log with the owner's ID.
   */
  async purge(owner: Principal, command: { commandId: string; names?: unknown; confirm?: unknown; dryRun?: unknown }): Promise<PurgeAnswer> {
    this.#owner(owner, "purge backups");
    if (!Array.isArray(command.names) || command.names.length === 0 || command.names.length > 50) throw new DomainError("invalid_command", "names: give 1 to 50 backup names", { field: "names" });
    const names = [...new Set(command.names.map((n) => { if (typeof n !== "string") throw new DomainError("invalid_command", "names: each must be a backup's name", { field: "names" }); try { return checkedName(n); } catch (error) { throw new DomainError("invalid_command", `names: ${msg(error)}`, { field: "names" }); } }))];
    if (command.confirm !== undefined && typeof command.confirm !== "boolean") throw new DomainError("invalid_command", "confirm: must be true or false", { field: "confirm" });
    if (command.dryRun !== undefined && typeof command.dryRun !== "boolean") throw new DomainError("invalid_command", "dryRun: must be true or false", { field: "dryRun" });
    const copies = await this.#copies();
    const plan: { target: string; name: string; action: string }[] = [];
    const results: Record<string, Record<string, PurgeResult>> = {};
    let foundAnywhere = new Set<string>();
    for (const c of copies) {
      results[c.id] = {};
      for (const n of names) {
        if (c.listed === undefined) { plan.push({ target: c.name, name: n, action: `cannot be reached now (${c.error}): it will be removed there as soon as the target answers` }); results[c.id]![n] = "pending"; continue; }
        if (c.listed.some((b) => b.manifest.name === n)) { foundAnywhere.add(n); plan.push({ target: c.name, name: n, action: "will be deleted" }); results[c.id]![n] = "pending"; }
        else plan.push({ target: c.name, name: n, action: "is not there" });
      }
      if (Object.keys(results[c.id]!).length === 0) delete results[c.id];
    }
    const unreachable = copies.some((c) => c.listed === undefined);
    const missing = names.filter((n) => !foundAnywhere.has(n));
    if (missing.length > 0 && !unreachable) throw new DomainError("not_found", `no backup named ${missing.join(", ")} is on any target`);
    // The last good backup: what would be left after this on the targets that can be read.
    const remaining = copies.flatMap((c) => c.listed ?? []).filter((b) => goodKind(b) && !names.includes(b.manifest.name));
    const warning = remaining.length === 0 && [...copies.flatMap((c) => c.listed ?? [])].some((b) => goodKind(b) && names.includes(b.manifest.name))
      ? `this would delete the last good backup there is${unreachable ? " on every target that can be reached" : ""}: afterwards nothing could be restored from backups (a new backup can be made with "back up now")` : undefined;
    const text = (head: string): string => `${head} ${plan.map((p) => `${p.name} on ${p.target} ${p.action}`).join("; ")}.`.slice(0, 1500);
    const known = Object.keys(results).length === 0 ? undefined : results;
    if (command.dryRun === true) return { status: "preview", names, plan, ...(warning === undefined ? {} : { warning }), text: text(`Purge preview${warning === undefined ? "" : ` (${warning})`}:`) };
    if (warning !== undefined && command.confirm !== true) return { status: "needs-confirmation", names, plan, warning, text: text(`Not done: ${warning}. Say yes again with confirm to delete it anyway.`) };
    if (known === undefined) throw new DomainError("not_found", `no backup named ${names.join(", ")} is on any target`);
    const begun = await this.#o.config.beginPurge(owner, { commandId: command.commandId, names }, known);
    const done = begun.replayed ? begun.record : await this.#runPurge(begun.record.id);
    const answer = this.#purgeAnswer(done, names, plan, warning);
    return answer;
  }

  #purgeAnswer(p: PurgeRecord, names: readonly string[], plan: PurgeAnswer["plan"], warning: string | undefined): PurgeAnswer {
    const lines: string[] = [];
    for (const [target, per] of Object.entries(p.results)) lines.push(`${target}: ${Object.entries(per).map(([n, r]) => `${n} ${r === "pending" ? "NOT yet purged (the target could not be reached; it is retried)" : r === "absent" ? "was not there" : "deleted"}`).join(", ")}`);
    const pending = !p.done;
    return { status: pending ? "pending" : "purged", purgeId: p.id, names, plan, results: p.results, ...(warning === undefined ? {} : { warning }), text: `${pending ? "Purge started, not finished" : "Purged"}: ${lines.join("; ")}.`.slice(0, 1500) };
  }

  /** Does the removals of one purge that are still pending (the first attempt, and every retry). */
  async #runPurge(id: string): Promise<PurgeRecord> {
    let record = (await this.#o.config.state()).purges.find((p) => p.id === id);
    if (record === undefined || record.done) return record as PurgeRecord;
    const cfg = await this.#o.config.effective();
    const results: Record<string, Record<string, PurgeResult>> = JSON.parse(JSON.stringify(record.results));
    const errors: Record<string, string> = {};
    for (const [tid, per] of Object.entries(results)) {
      const t = tid === PRIMARY ? undefined : cfg.targets.find((x) => x.id === tid);
      if (tid !== PRIMARY && t === undefined) { for (const n of Object.keys(per)) per[n] = "absent"; continue; } // the target was removed: there is nothing to retry
      const driver = t === undefined ? this.#primary() : this.#driver(t);
      for (const n of Object.keys(per)) {
        if (per[n] !== "pending") continue;
        try { per[n] = (await driver.remove(n)) ? "removed" : "absent"; } catch (error) { errors[tid] = msg(error); }
      }
    }
    const done = Object.values(results).every((per) => Object.values(per).every((r) => r !== "pending"));
    const names = record.names;
    const after = await this.#o.config.updateState("purge", (s) => ({ ...s, purges: s.purges.map((p) => (p.id === id ? { ...p, results, ...(Object.keys(errors).length === 0 ? {} : { errors }), lastTried: this.#now().toISOString(), done } : p)), verified: s.verified.filter((v) => !(names.includes(v.name) && results[v.target]?.[v.name] !== undefined && results[v.target]![v.name] !== "pending")) }));
    record = after.purges.find((p) => p.id === id)!;
    await this.#keys().catch(() => undefined);
    await this.#notify().catch(() => undefined);
    return record;
  }

  // ---- the sweep -------------------------------------------------------------------------------------------------------------

  /** One look: retries purges that wait on a target, copies backups a target lacks, applies each target's retention, runs the periodic test restore when it is due and keeps the owner's notices true. */
  async sweep(options: { readonly throttled?: boolean } = {}): Promise<void> {
    const now = this.#now().getTime();
    if (options.throttled === true && now < this.#next && this.#next - now <= (this.#o.everyMs ?? 300_000)) return;
    this.#next = now + (this.#o.everyMs ?? 300_000);
    const next = this.#busy.then(async () => {
      for (const p of (await this.#o.config.state()).purges) if (!p.done) await this.#runPurge(p.id).catch(() => undefined);
      const cfg = await this.#o.config.effective();
      for (const t of cfg.targets) await this.#catchUp(t, 2);
      await this.#pruneAll();
      await this.#keys();
      if (cfg.verifyEveryDays !== null) {
        const last = (await this.#o.config.state()).lastTestRestore;
        if (last === undefined || now - Date.parse(last.at) >= cfg.verifyEveryDays * DAY) await this.#verify(undefined, undefined, false).catch(() => undefined);
      }
      await this.#notify();
    });
    this.#busy = next.catch(() => undefined);
    await next;
  }

  // ---- notices ---------------------------------------------------------------------------------------------------------------

  async #say(kind: string, id: string, label: string, detail: string, level?: "notice", interrupt = false): Promise<void> {
    const n = this.#o.notifications;
    if (n === undefined) return;
    await n.emitFromController({ commandId: `bsys:${kind}:${id}:${this.#now().toISOString()}:${this.#seq++}`, kind: "maintenance", ref: { kind, id }, label: label.slice(0, 120), detail: detail.slice(0, 190), ...(interrupt ? { interrupt: true } : {}), ...(level === undefined ? {} : { level }) } as never);
  }

  /** Makes the open notices match what is true now: a failed or missed backup, a backup older than the age limit, a target that cannot be reached, a failed test restore and a purge that is not finished. */
  async #notify(): Promise<void> {
    const n = this.#o.notifications;
    if (n === undefined) return;
    const want = new Map<string, { kind: string; id: string; label: string; detail: string; urgent?: boolean; notice?: boolean }>();
    const put = (kind: string, id: string, label: string, detail: string, extra: { urgent?: boolean; notice?: boolean } = {}): void => { want.set(`${kind}\u0000${id}`, { kind, id, label, detail, ...extra }); };
    const cfg = await this.#o.config.effective();
    const state = await this.#o.config.state();
    const good = await this.#o.service.lastGood();
    const status = await this.#o.service.status();
    const now = this.#now().getTime();
    const base = await this.#o.retention();
    if (good.unreadable !== true) {
      // The service's own words can carry a system error's path (the backups folder, a file in it): the notice says what failed without it.
      if (status.lastError !== undefined) put("backup-run", "failed", "A backup failed", withoutPaths(status.lastError.message, this.#o.root));
      else if (good.at !== undefined && now - Date.parse(good.at) > cfg.everyHours * HOUR * 1.5 + HOUR) put("backup-run", "missed", "A scheduled backup was missed", `No new backup for ${Math.floor((now - Date.parse(good.at)) / HOUR)} hours although one is due every ${cfg.everyHours} hours.`);
      if (base.maxAgeDays !== undefined && base.maxAgeDays !== null && good.at !== undefined && now - Date.parse(good.at) > base.maxAgeDays * DAY) put("backup-stale", "age", `Urgent: the newest good backup is older than ${base.maxAgeDays} days`, `Backups are failing: the last good one is ${Math.floor((now - Date.parse(good.at)) / DAY)} days old, past your limit of ${base.maxAgeDays} days. It was kept (the newest good backup is never deleted by age).`, { urgent: true });
    }
    for (const t of cfg.targets) { const s = state.targets[t.id]; if (s?.lastError !== undefined) put("backup-target", t.id, `Backup target ${t.name} is failing`, `${s.lastError.message} (since ${s.lastError.at.slice(0, 16).replace("T", " ")} UTC)`); }
    if (state.lastTestRestore?.ok === false) put("backup-verify", "restore", "A test restore of a backup failed", `${state.lastTestRestore.name} on ${state.lastTestRestore.target}: ${state.lastTestRestore.detail}`, { urgent: true });
    for (const p of state.purges) if (!p.done) put("backup-purge", p.id, "A backup purge is not finished", `Some targets could not be reached: ${Object.entries(p.results).filter(([, per]) => Object.values(per).includes("pending")).map(([t]) => t).join(", ")}. It is retried until they answer.`, { notice: true });
    for (const kind of ["backup-run", "backup-stale", "backup-target", "backup-verify", "backup-purge"]) {
      const open = await n.openRefIds(kind);
      for (const w of want.values()) if (w.kind === kind && !open.includes(w.id)) await this.#say(kind, w.id, w.label, w.detail, w.notice === true ? "notice" : undefined, w.urgent === true);
      for (const id of open) if (!want.has(`${kind}\u0000${id}`)) await n.settleFromController({ commandId: `bsys-ok:${kind}:${id}:${this.#now().toISOString()}:${this.#seq++}`, kind: "maintenance", ref: { kind, id } });
    }
  }

  /** How long a backup stays on each extra target under its own rules (no network): for the confirmation of a deletion. */
  async stays(): Promise<{ name: string; staysUpToDays: number }[]> {
    const base = await this.#o.retention();
    return (await this.#o.config.effective()).targets.map((t) => ({ name: t.name, staysUpToDays: staysUpToDays({ daily: t.daily ?? base.daily, weekly: t.weekly ?? base.weekly, maxAgeDays: t.keepDays ?? base.maxAgeDays ?? null }) }));
  }

  // ---- reading ---------------------------------------------------------------------------------------------------------------

  /** Everything the owner asks about: schedule, rules in plain words, each target with what it holds and how it is doing, the test restore and the purges still waiting. */
  async status(): Promise<Record<string, unknown>> {
    const cfg = await this.#o.config.effective();
    const state = await this.#o.config.state();
    const base = await this.#o.retention();
    const copies = await this.#copies();
    const rules = describeRules({ ...base, preUpgradeDays: base.preUpgrade?.periodDays ?? null });
    const row = (id: string, name: string, kind: string, extra: Record<string, unknown>, c: { listed?: BackupInfo[]; error?: string } | undefined, t: TargetRecord | undefined) => ({
      id, name, kind, ...extra,
      ...(c?.listed === undefined ? { reachable: false, ...(c?.error === undefined ? {} : { problem: c.error }) } : { reachable: true, count: c.listed.length, ...(c.listed[0] === undefined ? {} : { newest: c.listed[0].manifest.name }) }),
      staysUpToDays: staysUpToDays({ daily: t?.daily ?? base.daily, weekly: t?.weekly ?? base.weekly, maxAgeDays: t?.keepDays ?? base.maxAgeDays ?? null }),
      ...(state.targets[id]?.lastOkAt === undefined ? {} : { lastCopyAt: state.targets[id]!.lastOkAt }), ...(state.targets[id]?.lastError === undefined ? {} : { lastError: state.targets[id]!.lastError }), ...(state.targets[id]?.lastTest === undefined ? {} : { lastTest: state.targets[id]!.lastTest }),
    });
    return {
      schedule: { everyHours: cfg.everyHours, hourUtc: cfg.hourUtc, verifyEveryDays: cfg.verifyEveryDays, text: describeSchedule(cfg) },
      rules: { daily: base.daily, weekly: base.weekly, maxAgeDays: base.maxAgeDays ?? null, overrides: rules.overrides, text: rules.text },
      main: row(PRIMARY, "main backups folder", "folder", {}, copies.find((c) => c.id === PRIMARY), undefined),
      targets: cfg.targets.map((t) => row(t.id, t.name, t.kind, { location: t.location, ...(t.credential === undefined ? {} : { credential: t.credential }), ...(t.keepDays == null ? {} : { keepDays: t.keepDays }) }, copies.find((c) => c.id === t.id), t)),
      ...(state.lastTestRestore === undefined ? {} : { lastTestRestore: state.lastTestRestore }),
      pendingPurges: state.purges.filter((p) => !p.done).map((p) => ({ id: p.id, names: p.names, since: p.at, results: p.results })),
      recentPurges: state.purges.filter((p) => p.done).slice(-5).map((p) => ({ id: p.id, by: p.by, at: p.at, names: p.names, results: p.results })),
    };
  }
}

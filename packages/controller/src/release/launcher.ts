import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { checkRange, negotiateProtocol, type VersionRange } from "../remote/protocol.js";
import { verifyReleaseDirectory, type Switcher } from "./activation.js";

/**
 * The launcher's own record and decision (card K02, second slice): which release to start, what counts as a confirmed start, and the last-known-good release.
 *
 * It is deliberately separate from the controller and its database. A release that cannot start cannot read the database, so everything the launcher needs to choose between "the pointer's release" and
 * "the last release that is known to have started" lives in one small file under the release root (`launcher-state.json`), replaced atomically. The controller writes it at three moments only: when it is
 * about to switch the pointer (`expect`: the release and manifest digest the launcher may run, so a pointer moved by hand to something nobody announced is not run), when a started release reports that it is
 * healthy (`confirm`: this release becomes the last known good) and, on the way back, when the launcher falls back. The launcher alone decides, deterministically, with no model and no network:
 *
 * 1. The pointer must name the release the controller announced (or the last known good). Anything else is refused ("blocked"), never run.
 * 2. That release's files must match its manifest digest (`verifyReleaseDirectory`, the same check as at activation).
 * 3. A release whose previous start was never confirmed has failed: it is quarantined (never run again, never activated again) and the launcher falls back to the last known good, if there is one, its files
 *    still verify and its controller-worker protocol range still overlaps the workers' (a release that cannot talk to the installation's workers is not a safe fallback). With none, the launcher blocks and leaves
 *    the pointer where it is: nothing is guessed.
 * 4. Otherwise it records the start attempt and says to run that release. A start that is never confirmed is found by the next launch.
 *
 * The launcher is one process at a time per release root (a service manager starts it); the file is not a lock. The same uid trust boundary as in `activation.ts` applies: whoever can write the release root can
 * write this file. The launcher and updater are not part of a release: a routine release cannot name `launcher` or `updater` as an artifact (staging refuses it).
 */
export const LAUNCHER_FILE = "launcher-state.json";
export const LAUNCHER_LIMITS = { failed: 50, log: 30 } as const;
const CANDIDATE_ID = /^rcn-[0-9a-f]{24}$/;
const SHA = /^[0-9a-f]{64}$/;

export interface KnownGood { readonly id: string; readonly digest: string; readonly confirmedAt: string; /** The worker protocol range the release's controller speaks. */ readonly protocol?: VersionRange }
export interface LaunchAttempt { readonly id: string; readonly digest: string; readonly startedAt: string; readonly confirmedAt?: string; readonly protocol?: VersionRange }
export interface FailedRelease { readonly id: string; readonly at: string; readonly reason: string }
export interface LauncherLogEntry { readonly at: string; readonly kind: "expected" | "started" | "confirmed" | "failed" | "fell_back" | "blocked"; readonly release?: string; readonly to?: string; readonly reason?: string }
export interface LauncherState {
  readonly v: 1;
  /** The release the controller said may be run next, with the digest of its manifest. */
  readonly expected?: { readonly id: string; readonly digest: string; readonly protocol?: VersionRange };
  readonly known?: KnownGood;
  readonly attempt?: LaunchAttempt;
  readonly failed: readonly FailedRelease[];
  readonly log: readonly LauncherLogEntry[];
}
const EMPTY: LauncherState = { v: 1, failed: [], log: [] };

export type LaunchDecision =
  | { readonly action: "none"; readonly reason: string }
  | { readonly action: "run"; readonly releaseId: string; readonly digest: string; readonly dir: string; readonly fellBack?: { readonly from: string; readonly reason: string } }
  | { readonly action: "blocked"; readonly reason: string };

export class LauncherStateError extends Error { constructor(message: string) { super(message); this.name = "LauncherStateError"; } }

function checkState(value: unknown): LauncherState {
  const bad = (why: string): never => { throw new LauncherStateError(`${LAUNCHER_FILE} is not a launcher record (${why}); the launcher will not guess`); };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return bad("not an object");
  const s = value as Record<string, unknown>;
  if (s["v"] !== 1) bad("unknown version");
  const rel = (o: unknown, what: string, needs: readonly string[]): void => {
    if (o === null || typeof o !== "object") return bad(what);
    const r = o as Record<string, unknown>;
    if (typeof r["id"] !== "string" || !CANDIDATE_ID.test(r["id"])) bad(`${what}.id`);
    if (needs.includes("digest") && (typeof r["digest"] !== "string" || !SHA.test(r["digest"]))) bad(`${what}.digest`);
    if (r["protocol"] !== undefined) { try { checkRange(r["protocol"], "protocol"); } catch { bad(`${what}.protocol`); } }
  };
  if (s["expected"] !== undefined) rel(s["expected"], "expected", ["digest"]);
  if (s["known"] !== undefined) rel(s["known"], "known", ["digest"]);
  if (s["attempt"] !== undefined) rel(s["attempt"], "attempt", ["digest"]);
  if (!Array.isArray(s["failed"]) || !Array.isArray(s["log"])) bad("failed and log must be lists");
  for (const f of s["failed"] as unknown[]) rel(f, "failed", []);
  return value as LauncherState;
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  const fh = await open(tmp, "wx", 0o644);
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  try { await rename(tmp, path); } catch (error) { await rm(tmp, { force: true }); throw error; }
  let dir;
  try { dir = await open(join(path, ".."), "r"); await dir.sync(); } catch { /* not every platform syncs a directory */ } finally { await dir?.close().catch(() => undefined); }
}

export interface LauncherOptions {
  readonly root: string;
  readonly switcher: Switcher;
  /** The worker protocol range the installation's workers speak: the last known good is only a fallback when its controller can still talk to them. Unset: not checked. */
  readonly workers?: VersionRange;
  readonly now?: () => string;
}

export class Launcher {
  readonly #o: LauncherOptions;
  #chain: Promise<unknown> = Promise.resolve();
  constructor(o: LauncherOptions) { this.#o = o; }
  #now(): string { return (this.#o.now ?? (() => new Date().toISOString()))(); }
  #dir(id: string): string { return join(this.#o.root, "releases", id); }
  /** One change at a time in this process; the launcher itself is one process per root. */
  #serial<T>(run: () => Promise<T>): Promise<T> { const mine = this.#chain.catch(() => undefined).then(run); this.#chain = mine; return mine; }

  async read(): Promise<LauncherState> {
    let raw: string;
    try { raw = await readFile(join(this.#o.root, LAUNCHER_FILE), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY; throw error; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new LauncherStateError(`${LAUNCHER_FILE} is damaged; the launcher will not guess`); }
    return checkState(parsed);
  }
  async #write(next: LauncherState, entry?: LauncherLogEntry): Promise<LauncherState> {
    const full: LauncherState = { ...next, failed: next.failed.slice(-LAUNCHER_LIMITS.failed), log: (entry === undefined ? next.log : [...next.log, entry]).slice(-LAUNCHER_LIMITS.log) };
    await writeAtomic(join(this.#o.root, LAUNCHER_FILE), JSON.stringify(full));
    return full;
  }

  /** The controller announces the release the pointer is about to name. Called before the pointer is written, so the launcher never sees a pointer nobody announced. */
  expect(release: { id: string; digest: string; protocol?: VersionRange }): Promise<void> {
    return this.#serial(async () => {
      const s = await this.read();
      await this.#write({ ...s, expected: { id: release.id, digest: release.digest, ...(release.protocol === undefined ? {} : { protocol: release.protocol }) } }, { at: this.#now(), kind: "expected", release: release.id });
    });
  }

  /** The owner vouches for a release that nothing confirmed: it becomes the last known good and the open start attempt, if any, is closed as confirmed. */
  vouch(release: { id: string; digest: string; protocol?: VersionRange }): Promise<void> {
    return this.#serial(async () => {
      const s = await this.read();
      const at = this.#now();
      const known: KnownGood = { id: release.id, digest: release.digest, confirmedAt: at, ...(release.protocol === undefined ? {} : { protocol: release.protocol }) };
      await this.#write({ ...s, known, failed: s.failed.filter((f) => f.id !== release.id), ...(s.attempt?.id === release.id ? { attempt: { ...s.attempt, confirmedAt: at } } : {}) }, { at, kind: "confirmed", release: release.id, reason: "owner" });
    });
  }

  /** A started release says it is healthy. Only the release of the open start attempt can be confirmed; it then becomes the last known good. Returns whether anything changed. */
  confirm(releaseId: string): Promise<boolean> {
    return this.#serial(async () => {
      const s = await this.read();
      const a = s.attempt;
      if (a === undefined || a.id !== releaseId) return false;
      if (a.confirmedAt !== undefined && s.known?.id === releaseId) return false;
      const at = this.#now();
      const known: KnownGood = { id: a.id, digest: a.digest, confirmedAt: at, ...(a.protocol === undefined ? {} : { protocol: a.protocol }) };
      await this.#write({ ...s, attempt: { ...a, confirmedAt: at }, known, failed: s.failed.filter((f) => f.id !== releaseId) }, { at, kind: "confirmed", release: releaseId });
      return true;
    });
  }

  /** What to start now, following the rules in the module comment. A fall-back moves the pointer back to the last known good and is recorded; a block moves nothing. */
  prepare(): Promise<LaunchDecision> {
    return this.#serial(async () => {
      let pointer: string | undefined | "invalid";
      try { pointer = await this.#o.switcher.read(); } catch { return { action: "blocked", reason: "the pointer cannot be read, so what to run is not known" } as const; }
      if (pointer === undefined) return { action: "none", reason: "no release is active" } as const;
      if (pointer === "invalid") return { action: "blocked", reason: "the pointer is not a release pointer" } as const;
      let s: LauncherState;
      try { s = await this.read(); } catch (error) { return { action: "blocked", reason: error instanceof LauncherStateError ? error.message : `${LAUNCHER_FILE} cannot be read` } as const; }

      const announced = s.expected?.id === pointer ? s.expected : s.known?.id === pointer ? s.known : undefined;
      let trouble: string | undefined;
      if (announced === undefined) trouble = "the pointer names a release the controller never announced";
      else if (s.failed.some((f) => f.id === pointer)) trouble = "that release failed to start before and is not run again";
      else if (s.attempt?.id === pointer && s.attempt.confirmedAt === undefined && s.known?.id !== pointer) trouble = "its previous start was never confirmed";
      else {
        const problems = await verifyReleaseDirectory(this.#dir(pointer), announced.digest);
        if (problems.length > 0) trouble = `its files do not match its digest: ${problems[0]}`;
      }
      if (trouble === undefined) {
        const at = this.#now();
        const protocol = (s.expected?.id === pointer ? s.expected.protocol : s.known?.protocol);
        // A start of the very release that is already the last known good keeps its standing; any other release must be confirmed afresh.
        await this.#write({ ...s, attempt: { id: pointer, digest: announced!.digest, startedAt: at, ...(s.known?.id === pointer ? { confirmedAt: s.known.confirmedAt } : {}), ...(protocol === undefined ? {} : { protocol }) } }, { at, kind: "started", release: pointer });
        return { action: "run", releaseId: pointer, digest: announced!.digest, dir: this.#dir(pointer) } as const;
      }

      // Trouble. An announced release that failed is quarantined; an unannounced pointer is not blamed on any release (it is simply not run).
      const at = this.#now();
      const failed = announced === undefined ? s.failed : [...s.failed.filter((f) => f.id !== pointer), { id: pointer, at, reason: trouble }];
      const k = s.known;
      let why: string | undefined;
      if (k === undefined) why = "there is no last known good release to fall back to";
      else if (k.id === pointer) why = "the release that failed is the last known good itself";
      else {
        const kp = await verifyReleaseDirectory(this.#dir(k.id), k.digest);
        if (kp.length > 0) why = `the last known good no longer verifies: ${kp[0]}`;
        else if (this.#o.workers !== undefined && k.protocol === undefined) why = "the last known good declared no protocol range, so it cannot be shown to speak to the workers";
        else if (this.#o.workers !== undefined && k.protocol !== undefined) { const n = negotiateProtocol(k.protocol, this.#o.workers); if (!n.ok) why = `the last known good is not compatible with the workers: ${n.reason}`; }
      }
      if (why !== undefined || k === undefined) {
        await this.#write({ ...s, failed }, { at, kind: "blocked", release: pointer, reason: `${trouble}; ${why ?? ""}`.slice(0, 300) });
        return { action: "blocked", reason: `${trouble}; ${why}` } as const;
      }
      try { await this.#o.switcher.write(k.id); } catch { await this.#write({ ...s, failed }, { at, kind: "blocked", release: pointer, reason: "the pointer could not be moved back" }); return { action: "blocked", reason: `${trouble}; the pointer could not be moved back to the last known good` } as const; }
      await this.#write({ ...s, failed, expected: { id: k.id, digest: k.digest, ...(k.protocol === undefined ? {} : { protocol: k.protocol }) }, attempt: { id: k.id, digest: k.digest, startedAt: at, confirmedAt: k.confirmedAt, ...(k.protocol === undefined ? {} : { protocol: k.protocol }) } },
        { at, kind: "fell_back", release: pointer, to: k.id, reason: trouble.slice(0, 200) });
      return { action: "run", releaseId: k.id, digest: k.digest, dir: this.#dir(k.id), fellBack: { from: pointer, reason: trouble } } as const;
    });
  }
}

/** Reads the protocol range of a staged release's `compat.json` text; throws a plain Error naming what is wrong. */
export function parseCompat(text: string): { protocol: VersionRange } {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error("compat.json is not JSON"); }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("compat.json must be an object");
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "protocol") throw new Error("compat.json must hold exactly one field, protocol: { min, max }");
  try { return { protocol: checkRange((v as { protocol: unknown }).protocol, "protocol") }; } catch (error) { throw new Error(`compat.json: ${(error as Error).message}`); }
}

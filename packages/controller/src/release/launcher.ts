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
export const LAUNCHER_LIMITS = { failed: 50, log: 30, notices: 20 } as const;
/** How long a started release may stay unconfirmed before the watchdog counts the start as failed (the owner's `startupWindowSeconds`, mirrored here); bounds for the owner's value. */
export const DEFAULT_STARTUP_WINDOW_SECONDS = 300;
export const STARTUP_WINDOW_BOUNDS = { min: 10, max: 86_400 } as const;
const CANDIDATE_ID = /^rcn-[0-9a-f]{24}$/;
const SHA = /^[0-9a-f]{64}$/;

export interface KnownGood { readonly id: string; readonly digest: string; readonly confirmedAt: string; /** The worker protocol range the release's controller speaks. */ readonly protocol?: VersionRange }
export interface LaunchAttempt { readonly id: string; readonly digest: string; readonly startedAt: string; readonly confirmedAt?: string; /** When the watchdog judged this start (a late start of the last known good is judged once). */ readonly watchdogAt?: string; readonly protocol?: VersionRange }
export interface FailedRelease { readonly id: string; readonly at: string; readonly reason: string }
/**
 * Something the owner must be told about a start (card K02, K02e/K02f): the launcher fell back to the last known good, or a release failed to start. It is written to this file in the same write as the decision,
 * because the launcher can run when the database cannot, so there may be nobody to tell yet; the controller reads it at its next start (and on its sweeps) and raises it as a notification.
 * One notice per kind and release (`${kind}|${release}`), bounded; `sentAt` is set only once a sender took it, `closedAt` when the owner acknowledged it or a later start confirmed, `settledAt` once the inbox item was closed.
 */
export interface LauncherNotice {
  readonly kind: "fell_back" | "failed_start";
  readonly release: string;
  /** The release the launcher fell back to. */
  readonly to?: string;
  /** Whether a last known good other than the failed release existed (a failed start with none left nothing running: always Urgent). */
  readonly fallback: boolean;
  readonly reason: string;
  readonly at: string;
  readonly sentAt?: string;
  readonly closedAt?: string;
  readonly closedBy?: "acknowledged" | "confirmed";
  readonly settledAt?: string;
}
export interface LauncherLogEntry { readonly at: string; readonly kind: "expected" | "started" | "confirmed" | "failed" | "fell_back" | "blocked"; readonly release?: string; readonly to?: string; readonly reason?: string }
export interface LauncherState {
  readonly v: 1;
  /** The release the controller said may be run next, with the digest of its manifest. */
  readonly expected?: { readonly id: string; readonly digest: string; readonly protocol?: VersionRange };
  /**
   * The announced release the pointer named when `expected` was announced. It stays runnable: the announcement is written just before the pointer moves, so a crash or a failed pointer write in between leaves
   * the pointer on this release, which must not then count as unannounced (with no last known good that would leave nothing to start).
   */
  readonly prior?: { readonly id: string; readonly digest: string; readonly protocol?: VersionRange };
  readonly known?: KnownGood;
  readonly attempt?: LaunchAttempt;
  /** The startup window in seconds the owner set (the controller writes it here, since the launcher cannot read the database); absent: the default. */
  readonly window?: number;
  /** Things the owner is to be told; see `LauncherNotice`. */
  readonly notices?: readonly LauncherNotice[];
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
  if (s["prior"] !== undefined) rel(s["prior"], "prior", ["digest"]);
  if (s["known"] !== undefined) rel(s["known"], "known", ["digest"]);
  if (s["attempt"] !== undefined) rel(s["attempt"], "attempt", ["digest"]);
  if (s["window"] !== undefined && !(typeof s["window"] === "number" && Number.isSafeInteger(s["window"]) && s["window"] >= STARTUP_WINDOW_BOUNDS.min && s["window"] <= STARTUP_WINDOW_BOUNDS.max)) bad("window");
  if (s["notices"] !== undefined) {
    if (!Array.isArray(s["notices"]) || s["notices"].length > LAUNCHER_LIMITS.notices) bad("notices");
    for (const n of s["notices"] as unknown[]) {
      const r = (n ?? {}) as Record<string, unknown>;
      if (n === null || typeof n !== "object" || (r["kind"] !== "fell_back" && r["kind"] !== "failed_start") || typeof r["release"] !== "string" || !CANDIDATE_ID.test(r["release"]) || typeof r["fallback"] !== "boolean" || typeof r["reason"] !== "string" || typeof r["at"] !== "string") bad("notices");
      if (r["to"] !== undefined && (typeof r["to"] !== "string" || !CANDIDATE_ID.test(r["to"]))) bad("notices.to");
    }
  }
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
      // The release the pointer names now (if it was announced) stays runnable until the pointer has moved: see `prior`.
      let now: string | undefined | "invalid";
      try { now = await this.#o.switcher.read(); } catch { now = undefined; }
      const held = now === undefined || now === "invalid" || now === release.id ? undefined : announcedIn(s, now);
      const { prior: _p, ...rest } = s; void _p;
      await this.#write({ ...rest, ...(held === undefined ? {} : { prior: { id: held.id, digest: held.digest, ...(held.protocol === undefined ? {} : { protocol: held.protocol }) } }), expected: { id: release.id, digest: release.digest, ...(release.protocol === undefined ? {} : { protocol: release.protocol }) } }, { at: this.#now(), kind: "expected", release: release.id });
    });
  }

  /** The owner vouches for a release that nothing confirmed: it becomes the last known good and the open start attempt, if any, is closed as confirmed. */
  vouch(release: { id: string; digest: string; protocol?: VersionRange }): Promise<void> {
    return this.#serial(async () => {
      const s = await this.read();
      const at = this.#now();
      const known: KnownGood = { id: release.id, digest: release.digest, confirmedAt: at, ...(release.protocol === undefined ? {} : { protocol: release.protocol }) };
      await this.#write({ ...s, known, failed: s.failed.filter((f) => f.id !== release.id), notices: closing(s, () => true, "confirmed", at), ...(s.attempt?.id === release.id ? { attempt: { ...s.attempt, confirmedAt: at } } : {}) }, { at, kind: "confirmed", release: release.id, reason: "owner" });
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
      await this.#write({ ...s, attempt: { ...a, confirmedAt: at }, known, failed: s.failed.filter((f) => f.id !== releaseId), notices: closing(s, (n) => n.at <= a.startedAt, "confirmed", at) }, { at, kind: "confirmed", release: releaseId });
      return true;
    });
  }

  /** The owner's startup window, mirrored into this file by the controller (it is the launcher's to read when the database is not). `null` puts the default back. Writes nothing when it is already so. */
  async setWindow(seconds: number | null): Promise<void> {
    if (seconds !== null && !(Number.isSafeInteger(seconds) && seconds >= STARTUP_WINDOW_BOUNDS.min && seconds <= STARTUP_WINDOW_BOUNDS.max)) throw new LauncherStateError(`the startup window must be ${STARTUP_WINDOW_BOUNDS.min} to ${STARTUP_WINDOW_BOUNDS.max} seconds`);
    await this.#serial(async () => {
      const s = await this.read();
      if (s.window === (seconds ?? undefined)) return;
      const { window: _w, ...rest } = s; void _w;
      await this.#write({ ...rest, ...(seconds === null ? {} : { window: seconds }) });
    });
  }

  /**
   * The startup watchdog (card K02e). A release that was started and is neither confirmed nor stopped within the startup window counts as failed: it is quarantined the way a start found unconfirmed at the next launch is
   * (never run or activated again), the owner's notice is written, and the caller (the launcher program, which also stops the hung process) then calls `prepare()`, which falls back. The last known good is never quarantined:
   * a late start of it is only recorded (and told) once, since only a running controller can vouch for a release and a quarantine would leave nothing to start for good. A start already confirmed, already judged, or still
   * inside the window changes nothing. No model, no network, no database.
   */
  watchdog(): Promise<WatchdogResult> {
    return this.#serial(async () => {
      let s: LauncherState;
      try { s = await this.read(); } catch (error) { return { action: "none", reason: error instanceof LauncherStateError ? error.message : `${LAUNCHER_FILE} cannot be read` } as const; }
      const a = s.attempt;
      if (a === undefined) return { action: "none", reason: "no start is open" } as const;
      if (a.confirmedAt !== undefined) return { action: "none", reason: "the start is confirmed" } as const;
      if (a.watchdogAt !== undefined || s.failed.some((f) => f.id === a.id)) return { action: "none", reason: "the start was already judged" } as const;
      const windowSeconds = s.window ?? DEFAULT_STARTUP_WINDOW_SECONDS;
      const startedMs = Date.parse(a.startedAt);
      const nowIso = this.#now();
      if (!Number.isFinite(startedMs) || !Number.isFinite(Date.parse(nowIso))) return { action: "none", reason: "the start time cannot be read" } as const;
      const waited = Date.parse(nowIso) - startedMs;
      if (waited < windowSeconds * 1000) return { action: "waiting", releaseId: a.id, remainingMs: windowSeconds * 1000 - waited } as const;
      const reason = `not confirmed within the ${windowSeconds}-second startup window`;
      if (s.known?.id === a.id) {
        await this.#write({ ...s, attempt: { ...a, watchdogAt: nowIso }, notices: withNotice(s, { kind: "failed_start", release: a.id, fallback: false, reason: `the last known good ${reason}`.slice(0, 200), at: nowIso }) }, { at: nowIso, kind: "failed", release: a.id, reason: `the last known good ${reason}; not quarantined`.slice(0, 200) });
        return { action: "late", releaseId: a.id, reason } as const;
      }
      const fallback = s.known !== undefined && s.known.id !== a.id;
      await this.#write({ ...s, failed: [...s.failed.filter((f) => f.id !== a.id), { id: a.id, at: nowIso, reason }], attempt: { ...a, watchdogAt: nowIso }, notices: withNotice(s, { kind: "failed_start", release: a.id, fallback, reason, at: nowIso }) }, { at: nowIso, kind: "failed", release: a.id, reason });
      return { action: "failed", releaseId: a.id, reason, fallback } as const;
    });
  }

  /**
   * Polls the watchdog every `pollMs` until it judges the open start, there is no open start to judge, or `signal` aborts; returns that last answer. The launcher program runs this beside the controller it started and
   * stops the controller and calls `prepare()` on `failed`.
   */
  async watch(options: { readonly pollMs?: number; readonly signal?: AbortSignal } = {}): Promise<WatchdogResult> {
    const pollMs = Math.max(5, options.pollMs ?? 1000);
    for (;;) {
      const r = await this.watchdog();
      if (r.action !== "waiting" || options.signal?.aborted === true) return r;
      await new Promise<void>((resolve) => {
        const done = (): void => { clearTimeout(timer); options.signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, Math.min(pollMs, r.remainingMs + 1));
        options.signal?.addEventListener("abort", done, { once: true });
      });
      if (stopped(options.signal)) return { action: "none", reason: "stopped" };
    }
  }

  /** The owner acknowledges (or a later confirmation closes) the notices that match; nothing else changes. Returns how many were closed. */
  closeNotices(match: (n: LauncherNotice) => boolean, by: "acknowledged" | "confirmed"): Promise<number> {
    return this.#serial(async () => {
      const s = await this.read();
      const at = this.#now();
      const next = closing(s, match, by, at);
      const closed = (next ?? []).filter((n, i) => n.closedAt !== (s.notices ?? [])[i]?.closedAt).length;
      if (closed > 0) await this.#write({ ...s, notices: next });
      return closed;
    });
  }

  /**
   * Hands what has not been told to `sink` (once each: `sentAt` is set only after `raise` returned), and tells it to close what the owner acknowledged or a confirmation closed (`settledAt` after `settle` returned).
   * A sink that throws leaves the notice pending for the next call, so a send that cannot happen now (no database, no channel) is not lost. Called by the controller at its start and on its sweeps; a launcher program with
   * a channel of its own may call it with that. Notices closed before they were ever told are simply marked done.
   */
  async deliver(sink: { raise(notice: LauncherNotice): Promise<void>; settle(notice: LauncherNotice): Promise<void> }): Promise<{ raised: number; settled: number; failed: number }> {
    const out = { raised: 0, settled: 0, failed: 0 };
    const todo = (await this.read()).notices ?? [];
    for (const n of todo) {
      const key = noticeKey(n);
      try {
        if (n.closedAt === undefined && n.sentAt === undefined) { await sink.raise(n); await this.#markNotice(key, n.at, { sentAt: this.#now() }); out.raised++; }
        else if (n.closedAt !== undefined && n.settledAt === undefined) {
          if (n.sentAt !== undefined) { await sink.settle(n); out.settled++; }
          await this.#markNotice(key, n.at, { settledAt: this.#now() });
        }
      } catch { out.failed++; }
    }
    return out;
  }
  #markNotice(key: string, at: string, patch: Partial<LauncherNotice>): Promise<void> {
    return this.#serial(async () => {
      const s = await this.read();
      const list = s.notices ?? [];
      if (!list.some((n) => noticeKey(n) === key && n.at === at)) return;
      await this.#write({ ...s, notices: list.map((n) => (noticeKey(n) === key && n.at === at ? { ...n, ...patch } : n)) });
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

      const announced = announcedIn(s, pointer);
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
        const protocol = announced!.protocol;
        // A start of the very release that is already the last known good keeps its standing; any other release must be confirmed afresh.
        // Once the pointer names the announced release, the one before it no longer needs to stay runnable.
        const { prior: _p, ...kept } = s; void _p;
        await this.#write({ ...(s.expected?.id === pointer ? kept : s), attempt: { id: pointer, digest: announced!.digest, startedAt: at, ...(s.known?.id === pointer ? { confirmedAt: s.known.confirmedAt } : {}), ...(protocol === undefined ? {} : { protocol }) } }, { at, kind: "started", release: pointer });
        return { action: "run", releaseId: pointer, digest: announced!.digest, dir: this.#dir(pointer) } as const;
      }

      // Trouble. An announced release that failed is quarantined; an unannounced pointer is not blamed on any release (it is simply not run). The last known good itself is never quarantined: its only trouble
      // can be files that do not verify now (perhaps a passing read error), it is then not run (blocked), and once its files are right again it runs; a quarantine would leave nothing to start for good, since only
      // a running controller can vouch for a release.
      const at = this.#now();
      // A release the watchdog already judged keeps its own, more exact reason.
      const earlier = s.failed.find((f) => f.id === pointer);
      const failed = announced === undefined || s.known?.id === pointer || earlier !== undefined ? s.failed : [...s.failed.filter((f) => f.id !== pointer), { id: pointer, at, reason: trouble }];
      const told = earlier?.reason ?? trouble;
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
        await this.#write({ ...s, failed, notices: withNotice(s, { kind: "failed_start", release: pointer, fallback: false, reason: `${told}; ${why ?? ""}`.slice(0, 200), at }) }, { at, kind: "blocked", release: pointer, reason: `${trouble}; ${why ?? ""}`.slice(0, 300) });
        return { action: "blocked", reason: `${trouble}; ${why}` } as const;
      }
      // The quarantine is written before the pointer moves: a crash in between then repeats this fall-back at the next launch, instead of leaving the failed release unrecorded with the pointer already back (the
      // controller's record could not catch up and the failed release could be activated again).
      if (failed !== s.failed) await this.#write({ ...s, failed });
      try { await this.#o.switcher.write(k.id); } catch { await this.#write({ ...s, failed }, { at, kind: "blocked", release: pointer, reason: "the pointer could not be moved back" }); return { action: "blocked", reason: `${trouble}; the pointer could not be moved back to the last known good` } as const; }
      const { prior: _p, ...kept } = s; void _p;
      await this.#write({ ...kept, failed, notices: withNotice(s, { kind: "fell_back", release: pointer, to: k.id, fallback: true, reason: told.slice(0, 200), at }), expected: { id: k.id, digest: k.digest, ...(k.protocol === undefined ? {} : { protocol: k.protocol }) }, attempt: { id: k.id, digest: k.digest, startedAt: at, confirmedAt: k.confirmedAt, ...(k.protocol === undefined ? {} : { protocol: k.protocol }) } },
        { at, kind: "fell_back", release: pointer, to: k.id, reason: trouble.slice(0, 200) });
      return { action: "run", releaseId: k.id, digest: k.digest, dir: this.#dir(k.id), fellBack: { from: pointer, reason: trouble } } as const;
    });
  }
}

/** The announcement that lets the launcher run `id`: the release the controller announced, the one the pointer named before that announcement, or the last known good. */
function announcedIn(s: LauncherState, id: string): { readonly id: string; readonly digest: string; readonly protocol?: VersionRange } | undefined {
  return s.expected?.id === id ? s.expected : s.known?.id === id ? s.known : s.prior?.id === id ? s.prior : undefined;
}

export type WatchdogResult =
  | { readonly action: "none"; readonly reason: string }
  | { readonly action: "waiting"; readonly releaseId: string; readonly remainingMs: number }
  | { readonly action: "failed"; readonly releaseId: string; readonly reason: string; readonly fallback: boolean }
  | { readonly action: "late"; readonly releaseId: string; readonly reason: string };

const stopped = (signal?: AbortSignal): boolean => signal?.aborted === true;
export const noticeKey = (n: Pick<LauncherNotice, "kind" | "release">): string => `${n.kind}|${n.release}`;

/**
 * The notices with one more. One notice per kind and release: a repeat (the same block found again at every launch) adds nothing, also after the owner acknowledged it; only a notice a later confirmation closed
 * is replaced (that failure is over, a new one is new). At the cap the oldest finished notice goes first, then the oldest.
 */
function withNotice(s: LauncherState, n: Omit<LauncherNotice, "sentAt" | "closedAt" | "closedBy" | "settledAt">): readonly LauncherNotice[] {
  const list = s.notices ?? [];
  const key = noticeKey(n);
  if (list.some((x) => noticeKey(x) === key && x.closedBy !== "confirmed")) return list;
  // A fall-back says more than the failed start the watchdog noted a moment before it, so a failed-start notice nobody has been told yet is folded into it.
  const folded = (x: LauncherNotice): boolean => n.kind === "fell_back" && x.kind === "failed_start" && x.release === n.release && x.sentAt === undefined && x.closedAt === undefined;
  const next: LauncherNotice[] = [...list.filter((x) => noticeKey(x) !== key && !folded(x)), n];
  while (next.length > LAUNCHER_LIMITS.notices) {
    const i = next.findIndex((x) => x.settledAt !== undefined);
    next.splice(i >= 0 ? i : 0, 1);
  }
  return next;
}

function closing(s: LauncherState, match: (n: LauncherNotice) => boolean, by: "acknowledged" | "confirmed", at: string): readonly LauncherNotice[] {
  return (s.notices ?? []).map((n) => (n.closedAt === undefined && match(n) ? { ...n, closedAt: at, closedBy: by } : n));
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

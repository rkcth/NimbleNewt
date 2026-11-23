import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allowsExactly } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { instantOf, isLocalDate, isLocalTime, knownZone } from "../meetings/zones.js";
import type { PauseService, PauseScope } from "../lifecycle/pause.js";
import { redactText } from "../security/redact.js";
import type { ReleaseActivationService } from "./activation.js";

/**
 * Maintenance windows for release updates (card K07, first slice).
 *
 * The owner names one exact staged release (its candidate ID and the staged digest), a local date and time in a named time zone, and how long the window lasts. The controller's dispatcher
 * sweep (`release.windows`) then walks the window through these states, each written to the database before the next step is taken:
 *
 * - `scheduled` -> **Prepare** (from `prepareLeadMinutes` before the opening, never after the close): the staged files are verified again against the digest the owner named, the release
 *   must not be quarantined, and the free space under the release root must be at least `minFreeBytes`. A digest or file mismatch quarantines the candidate; too little space fails the window
 *   without quarantine. Success is `prepared`.
 * - `prepared` -> **Quiesce** (only while the window is open; card K07 second slice). With a quiesce port the window records the installation's lifecycle state as it stood (paused by someone, or active),
 *   pauses the installation itself when it was active (so no waiting or parked attempt starts or resumes), and makes every `running` attempt quiet with the dispatcher's Suspend (new calls refused, calls in
 *   flight settled, a checkpoint taken) without releasing it. Only `running` attempts can hold the window up, and only when they cannot be made quiet; `waiting` and `parked` attempts have no worker, are
 *   counted and left where they are. Nothing is ever Force Stopped. Without the port (older embedders) the window waits while any attempt is running, as in the first slice.
 *   Whatever the window set is put back when it ends in any way (cancelled, committed, reverted, missed, deferred, failed): the attempts it froze are released and its own pause is lifted, and nothing else
 *   is touched: a pause that was already there (the owner's) stays, and so does a pause the owner set again after the window's was lifted.
 * - **Checkpoint** (with a checkpoint port): once quiet, a verified snapshot of the state, configuration and artifacts (the installation's own backup, nothing new copied) is taken and its name and manifest
 *   digest are recorded. A snapshot that cannot be taken or does not verify fails the window before anything switches.
 * - then **Activate**: the existing journalled activation (`release.activate`, card K02) as the owner's standing word for exactly this release; every activation check (approval, signature,
 *   platform, targets, migration plan, compatibility) applies as it would to the owner. A refusal fails the window.
 * - `activated` -> `committed` once the launcher confirmed the release's start (it is the last known good), or `reverted` when the launcher recorded a failed start of it (it fell back): the
 *   candidate is then quarantined, so no later window can bring it back (no update/rollback loop).
 * - A window that closes before the update started (the controller was down, preparation came too late) is `missed`; one whose work never went quiet is `deferred`. Neither ever deploys
 *   later: a delayed window does not deploy at an unrelated time.
 * - `cancelled` by the owner, at any point before activation.
 *
 * The owner is told once for each outcome (a needs-you notice for missed, deferred, failed and reverted; a notice for committed).
 *
 * Not in this slice (see the implementation notes): a migration test on an isolated copy, the quarantined start with dispatch and effects
 * disabled, the verification run (registration, admin request, fake task), commit-or-revert of the state, the independent inbox during downtime, bounded recovery mode, recurring windows,
 * a restart after activation (the launcher runs the new release at the controller's next start), the UI, and the macOS/Linux/Windows fault matrix.
 */

const WINDOW = "release-window";
const QUARANTINE = "release-quarantine";
const CANDIDATE_ID = /^rcn-[0-9a-f]{24}$/;
const WINDOW_ID = /^rwin-[0-9a-f]{20}$/;
const SHA = /^[0-9a-f]{64}$/;
const MINUTE = 60_000;
export const WINDOW_LIMITS = { durationMinutes: { min: 15, max: 24 * 60 }, prepareLeadMinutes: { min: 0, max: 7 * 24 * 60 }, healthDeadlineSeconds: { min: 30, max: 3600 }, history: 20, listed: 50, scanned: 500, channel: 60, horizonDays: 366 } as const;
/** Provisional defaults (the owner has not chosen any): prepare up to an hour before the opening, and keep at least 1 GiB free beyond what is already staged. */
export const WINDOW_DEFAULTS = { prepareLeadMinutes: 60, minFreeBytes: 1024 ** 3, healthDeadlineSeconds: 300 } as const;

export type WindowStatus = "scheduled" | "prepared" | "activated" | "committed" | "reverted" | "missed" | "deferred" | "failed" | "cancelled";
const OPEN_STATES: ReadonlySet<WindowStatus> = new Set(["scheduled", "prepared", "activated"]);
export interface WindowEvent { readonly at: string; readonly event: string; readonly reason?: string }
export interface WindowBody {
  readonly windowId: string;
  readonly candidateId: string;
  readonly digest: string;
  readonly migrationPlan?: string;
  /** The owner's words for when: a local date and time in a named zone, and the instants they come to. */
  readonly date: string;
  readonly time: string;
  readonly timeZone: string;
  readonly durationMinutes: number;
  readonly opensAt: string;
  readonly closesAt: string;
  /** What the window may change. Only the whole installation (`installation`) exists in this slice. */
  readonly scope: "installation";
  /** The trusted source the owner names (a label: no address is fetched). */
  readonly channel?: string;
  readonly prepareLeadMinutes: number;
  readonly minFreeBytes: number;
  /** How long a started release may take to confirm. Recorded; the launcher's own startup window (release.staging.settings) is what is enforced in this slice. */
  readonly healthDeadlineSeconds: number;
  readonly quiesce?: WindowQuiesce;
  readonly checkpoint?: WindowCheckpoint;
  readonly authorizedBy: string;
  readonly authorizedAt: string;
  readonly status: WindowStatus;
  /** The release current when the window activated (the way back), when there was one. */
  readonly from?: string;
  /** Written before the activation is called (controller clock): a window that crashed after this point is settled from the activation record, never assumed not to have switched. */
  readonly activatingAt?: string;
  readonly waiting?: string;
  readonly reason?: string;
  /** When the owner was told the window's outcome (set once the notice was filed). */
  readonly toldAt?: string;
  readonly history: readonly WindowEvent[];
}
/**
 * What the window did to quiet the installation, written before each step so a crash is settled from it. `prior` is the installation pause gate as the window first found it: `active` (the window pauses it
 * and lifts only its own pause later) or `paused` (someone else's pause: never lifted, never set again).
 */
export interface WindowQuiesce {
  readonly prior: "active" | "paused";
  /** The window's own pause call returned (or was found made). */
  readonly paused?: boolean;
  /** Running attempts the window froze (it releases these and no other freeze). */
  readonly frozen: readonly string[];
  /** Of those, the ones already made quiet (settled and checkpointed): a sweep that waits on another attempt does not suspend these again. */
  readonly settled?: readonly string[];
  readonly running: number;
  readonly waiting: number;
  readonly parked: number;
  readonly quietAt?: string;
  readonly restoredAt?: string;
  /** One plain line: what is quiet now, or what was put back. */
  readonly summary: string;
  /** A restore step that failed and is tried again at each sweep. */
  readonly problem?: string;
}
export interface WindowCheckpoint { readonly name: string; readonly digest: string; readonly at: string; /** What was not checked (a backup sealed for everything is checked by its manifest only). */ readonly note?: string }
export interface QuarantineBody { readonly candidateId: string; readonly reason: string; readonly at: string; readonly windowId: string }
export interface WindowView extends WindowBody { readonly revision: number; readonly rollback?: { readonly to: string; readonly ok: boolean; readonly reasons: readonly string[] } }

export interface WindowNotice { readonly commandId: string; readonly windowId: string; readonly level: "needs-you" | "notice"; readonly label: string; readonly detail: string }
/** How the window quiets the installation (the dispatcher and the pause gate, composed by the embedder). */
export interface WindowQuiescePort {
  readonly pauses: Pick<PauseService, "pause" | "resumeOwnHold" | "gateState" | "ownPause">;
  /** Every attempt not finished, with whether a freeze is on it now and that freeze's reason (an attempt has one freeze: the reason tells whose it is). */
  attempts(): Promise<readonly { readonly attemptId: string; readonly state: string; readonly frozen: boolean; readonly frozenReason?: string }[]>;
  /** Suspend without release: new calls refused, calls in flight settled, a checkpoint taken. Throws when the attempt cannot be made quiet. */
  freeze(attemptId: string, reason: string): Promise<void>;
  /** Lifts a freeze. A `not_found` (the attempt ended) is fine. */
  release(attemptId: string): Promise<void>;
  /** How many running attempts at most one window freezes (default 200). */
  readonly limit?: number;
}
export interface WindowOptions {
  readonly activation: Pick<ReleaseActivationService, "verify" | "activate" | "status" | "rollbackCheck">;
  /** The release root, for the free-space check. */
  readonly root: string;
  /** Free bytes at the root; default `statfs`. */
  readonly freeBytes?: (root: string) => Promise<number>;
  /** How many agent attempts are running now; without it the quiesce check passes (no dispatcher). */
  readonly liveAttempts?: () => Promise<number>;
  /** Quiet the installation for the window (suspend running work, hold new work) and put it back at the end. Without it the window only waits for `liveAttempts`. */
  readonly quiesce?: WindowQuiescePort;
  /** Takes the checkpoint: a snapshot of state, configuration and artifacts that was verified. Without it no checkpoint is taken. */
  readonly checkpoint?: () => Promise<{ readonly name: string; readonly digest: string; readonly verified: boolean; readonly problems?: readonly string[]; readonly note?: string }>;
  /** Files one owner notice; a `command_conflict` counts as already filed. */
  readonly notify?: (notice: WindowNotice) => Promise<void>;
  /** The clock windows are judged on (milliseconds); default `Date.now`. */
  readonly now?: () => number;
  readonly runner?: RunnerOptions;
  /** How many window records one page of the scan reads (default `WINDOW_LIMITS.scanned`); tests make it small. */
  readonly scanPage?: number;
}

const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const known = (command: object, fields: readonly string[]): void => { const u = Object.keys(command).filter((k) => !fields.includes(k)); if (u.length > 0) bad(u[0]!, "is not a field of this command"); };
const strictOwner = (by: Principal, what: string): void => { if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not ${what}; only the owner does`); };
const mayRead = (by: Principal): void => {
  if (by.taskScope === undefined && (by.kind === "owner" || (by.kind === "agent" && allowsExactly(by, "release.manage", "*")))) return;
  throw new DomainError("forbidden", `${by.id} may not read maintenance windows; only the owner or a holder of release.manage does`);
};
const whole = (v: unknown, field: string, min: number, max: number): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : bad(field, `must be a whole number from ${min} to ${max}`));
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, 160);
/** The controller acting on the owner's standing word for one window: owner-level, never a task, and named so the audit shows where it came from. */
const WINDOW_ACTOR: Principal = { id: "service:release-window", kind: "owner", name: "release-window", grants: [] };
const INSTALLATION: PauseScope = { kind: "installation", id: "installation" };
/** The start of every freeze reason a window writes: an attempt holds one freeze, so a window lifts a freeze only while it still carries this (a landing or a recipe change may have lifted it and set its own). */
const freezeTag = (windowId: string): string => `maintenance window ${windowId}:`;
/** Error text for records the owner (and a release.manage holder) reads: control characters out, secrets marked, and host paths hidden (a backup's failure names its folder). */
const recordText = (e: unknown, max = 160): string => redactText(errorText(e)).replace(/(?<![\w.])(?:[A-Za-z]:)?[\\/](?:[^\s'"`,;:()<>\\/]+[\\/])+[^\s'"`,;:()<>]*/g, "<path>").slice(0, max);

export class ReleaseWindowService {
  readonly #runner: CommandRunner;
  readonly #o: WindowOptions;
  private constructor(runner: CommandRunner, o: WindowOptions) { this.#runner = runner; this.#o = o; }
  static withEpoch(storage: ControllerStorage, epoch: number, o: WindowOptions): ReleaseWindowService { return new ReleaseWindowService(new CommandRunner(storage, epoch, o.runner ?? {}), o); }
  #now(): number { return (this.#o.now ?? Date.now)(); }

  /**
   * Owner only: a window for one exact staged release. The digest must be the staged one (the owner's word binds it), the release must not be quarantined, the window must close in the
   * future and open within a year, and no other window may be open (one update at a time).
   */
  async set(owner: Principal, command: NoActor & { candidateId?: unknown; digest?: unknown; date?: unknown; time?: unknown; timeZone?: unknown; durationMinutes?: unknown; channel?: unknown; scope?: unknown; prepareLeadMinutes?: unknown; minFreeBytes?: unknown; healthDeadlineSeconds?: unknown }): Promise<{ windowId: string; opensAt: string; closesAt: string; replayed: boolean }> {
    strictOwner(owner, "set a maintenance window");
    known(command, ["commandId", "candidateId", "digest", "date", "time", "timeZone", "durationMinutes", "channel", "scope", "prepareLeadMinutes", "minFreeBytes", "healthDeadlineSeconds"]);
    const candidateId = typeof command.candidateId === "string" && CANDIDATE_ID.test(command.candidateId) ? command.candidateId : bad("candidateId", "is not a release candidate ID");
    const digest = typeof command.digest === "string" && SHA.test(command.digest) ? command.digest : bad("digest", "must be the 64 hexadecimal characters of the staged release's digest");
    if (!isLocalDate(command.date)) bad("date", "must be a calendar date written YYYY-MM-DD");
    if (!isLocalTime(command.time)) bad("time", "must be a time of day written HH:MM (24-hour)");
    const zone = knownZone(command.timeZone) ?? bad("timeZone", "must be a time zone name such as Europe/London or America/New_York");
    const durationMinutes = whole(command.durationMinutes, "durationMinutes", WINDOW_LIMITS.durationMinutes.min, WINDOW_LIMITS.durationMinutes.max);
    const prepareLeadMinutes = command.prepareLeadMinutes === undefined ? WINDOW_DEFAULTS.prepareLeadMinutes : whole(command.prepareLeadMinutes, "prepareLeadMinutes", WINDOW_LIMITS.prepareLeadMinutes.min, WINDOW_LIMITS.prepareLeadMinutes.max);
    const minFreeBytes = command.minFreeBytes === undefined ? WINDOW_DEFAULTS.minFreeBytes : whole(command.minFreeBytes, "minFreeBytes", 0, Number.MAX_SAFE_INTEGER);
    const healthDeadlineSeconds = command.healthDeadlineSeconds === undefined ? WINDOW_DEFAULTS.healthDeadlineSeconds : whole(command.healthDeadlineSeconds, "healthDeadlineSeconds", WINDOW_LIMITS.healthDeadlineSeconds.min, WINDOW_LIMITS.healthDeadlineSeconds.max);
    if (command.scope !== undefined && command.scope !== "installation") bad("scope", "only installation (the whole installation) can be updated in a window for now");
    const channel = command.channel === undefined ? undefined : typeof command.channel === "string" && command.channel.trim() !== "" && command.channel.length <= WINDOW_LIMITS.channel && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(command.channel) ? command.channel.trim() : bad("channel", `must be a short name (up to ${WINDOW_LIMITS.channel} characters)`);
    const opens = instantOf(command.date as string, command.time as string, zone);
    const closes = opens + durationMinutes * MINUTE;
    const now = this.#now();
    const windowId = `rwin-${createHash("sha256").update(scopedCommandId(owner.id, command.commandId)).digest("hex").slice(0, 20)}`;
    return this.#serial(async () => {
      // Read inside the serial section, so two copies of the same command sent at once are one window and a replay, not a refusal of the second as "another window is open".
      const existing = await this.#runner.get(WINDOW, windowId);
      if (existing === undefined) {
        if (closes <= now) bad("date", "the window would already be over; name a time in the future");
        if (opens - now > WINDOW_LIMITS.horizonDays * 86_400_000) bad("date", "the window must open within a year");
        if (await this.#runner.get(QUARANTINE, candidateId) !== undefined) throw new DomainError("invalid_transition", "that release is quarantined (it failed before); submit a new candidate instead");
        const open = (await this.#all()).filter((w) => OPEN_STATES.has(w.body.status));
        if (open.length > 0) throw new DomainError("invalid_transition", `window ${open[0]!.body.windowId} is still open (${open[0]!.body.status}); cancel it or wait for it to end first`);
      }
      const payload = { candidateId, digest, date: command.date as string, time: command.time as string, timeZone: zone, durationMinutes, scope: "installation", ...(channel === undefined ? {} : { channel }), prepareLeadMinutes, minFreeBytes, healthDeadlineSeconds };
      const commandId = scopedCommandId(owner.id, command.commandId);
      // A repeat is answered from the record (or refused as a different command under the same ID) without looking at the release again.
      if (existing !== undefined) {
        const r = await this.#runner.command("release.window.set", { commandId, actor: owner.id }, async () => ({ payload, build: async () => { throw new DomainError("command_conflict", "this command ID was already used for another window"); } }));
        const saved = existing.body as unknown as WindowBody;
        return { windowId, opensAt: saved.opensAt, closesAt: saved.closesAt, replayed: r.replayed };
      }
      // The release must be staged now and the owner's digest must be what was staged (read again at preparation).
      const staged = await this.#o.activation.verify(owner, { releaseId: candidateId });
      if (staged.digest !== digest) throw new DomainError("invalid_command", "digest: is not the digest of the staged release; read it again (release.verify)", { field: "digest" });
      const at = this.#runner.now();
      const body: WindowBody = {
        windowId, candidateId, digest, ...(staged.migrationPlan === undefined ? {} : { migrationPlan: staged.migrationPlan }), date: command.date as string, time: command.time as string, timeZone: zone, durationMinutes,
        opensAt: new Date(opens).toISOString(), closesAt: new Date(closes).toISOString(), scope: "installation", ...(channel === undefined ? {} : { channel }), prepareLeadMinutes, minFreeBytes, healthDeadlineSeconds,
        authorizedBy: owner.id, authorizedAt: at, status: "scheduled", history: [{ at, event: "scheduled" }],
      };
      const ref: AggregateRef = { kind: WINDOW, id: windowId };
      const r = await this.#runner.command("release.window.set", { commandId, actor: owner.id }, async () => ({
        payload,
        build: async () => ({ ref, creates: true, changes: [{ type: "create" as const, ref, body: body as unknown as JsonObject }], detail: { candidateId, opensAt: body.opensAt, closesAt: body.closesAt } }),
      }));
      const saved = (await this.#runner.get(WINDOW, windowId))!.body as unknown as WindowBody;
      return { windowId, opensAt: saved.opensAt, closesAt: saved.closesAt, replayed: r.replayed };
    });
  }

  /** Owner only: ends a window that has not activated anything, and puts back only what this window set (its own pause and its own suspensions; a pause that was already there stays). */
  async cancel(owner: Principal, command: NoActor & { windowId?: unknown; reason?: unknown }): Promise<{ windowId: string; status: WindowStatus }> {
    strictOwner(owner, "cancel a maintenance window");
    known(command, ["commandId", "windowId", "reason"]);
    const windowId = typeof command.windowId === "string" && WINDOW_ID.test(command.windowId) ? command.windowId : bad("windowId", "is not a maintenance window ID");
    const reason = command.reason === undefined ? "cancelled by the owner" : typeof command.reason === "string" && command.reason.trim() !== "" && command.reason.length <= 200 ? command.reason.trim() : bad("reason", "must be a short text (up to 200 characters)");
    return this.#serial(async () => {
      const found = await this.#runner.get(WINDOW, windowId);
      if (found === undefined) throw new DomainError("not_found", "no such maintenance window");
      const w = found.body as unknown as WindowBody;
      const commandId = scopedCommandId(owner.id, command.commandId);
      // Already cancelled (a repeat, or a second word to the same effect): nothing more to record.
      if (w.status === "cancelled") return { windowId, status: w.status };
      if (w.status !== "scheduled" && w.status !== "prepared") throw new DomainError("invalid_transition", w.status === "activated" ? "the release was already activated by this window; roll it back with release.rollback instead" : `the window has already ended (${w.status})`);
      // The switch was called (the controller stopped before recording how it went): a cancel must not claim nothing happened when the release did switch.
      if (w.activatingAt !== undefined && (await this.#took(w)) !== undefined) throw new DomainError("invalid_transition", "this window already switched to the release (or is switching); roll it back with release.rollback instead");
      await this.#write(found.revision, w, this.#next(w, "cancelled", reason), "release.window.cancel", commandId, owner.id, { reason });
      // Only what this window set is put back; a failed step is tried again at each sweep.
      await this.#restore(windowId).catch(() => undefined);
      return { windowId, status: "cancelled" };
    });
  }

  async get(by: Principal, windowId: unknown): Promise<WindowView> {
    mayRead(by);
    const id = typeof windowId === "string" && WINDOW_ID.test(windowId) ? windowId : bad("windowId", "is not a maintenance window ID");
    const found = await this.#runner.get(WINDOW, id);
    if (found === undefined) throw new DomainError("not_found", "no such maintenance window");
    return this.#view(by, found.revision, found.body as unknown as WindowBody);
  }

  /**
   * The open windows first (scheduled, prepared or activated: at most one, as `set` allows), then the rest newest opening first, with the quarantined releases. The open window always leads the page,
   * so a reader of the first 50 (the chat's "cancel the maintenance window", the status answer's first ten lines) cannot miss it behind ended windows that open later (a cancelled window set for
   * next month, say).
   */
  async list(by: Principal): Promise<{ windows: readonly WindowView[]; quarantined: readonly QuarantineBody[]; truncated: boolean }> {
    mayRead(by);
    const open = (w: { body: WindowBody }): number => (OPEN_STATES.has(w.body.status) ? 0 : 1);
    const all = (await this.#all()).sort((a, b) => open(a) - open(b) || (a.body.opensAt < b.body.opensAt ? 1 : a.body.opensAt > b.body.opensAt ? -1 : 0));
    const windows: WindowView[] = [];
    for (const w of all.slice(0, WINDOW_LIMITS.listed)) windows.push(await this.#view(by, w.revision, w.body));
    const quarantined = (await this.#runner.list(QUARANTINE, { limit: WINDOW_LIMITS.listed })).map((a) => a.body as unknown as QuarantineBody);
    return { windows, quarantined, truncated: all.length > WINDOW_LIMITS.listed };
  }

  /** The dispatcher's sweep: moves every open window one step on, and tells the owner of each outcome once. One window's failure does not stop the others. */
  async tick(): Promise<{ moved: number }> {
    return this.#serial(() => this.#tick());
  }

  async #tick(): Promise<{ moved: number }> {
    let moved = 0;
    let failure: unknown;
    for (const w of await this.#all()) {
      try {
        if (OPEN_STATES.has(w.body.status)) {
          if (await this.#step(w.revision, w.body)) moved++;
          // A window that just ended gives back what it held in the same sweep (the owner's notice, if any, is already filed).
          await this.#restore(w.body.windowId);
        } else {
          // Ended without giving back (a crash, a failed step): put back first, then tell.
          if (w.body.quiesce !== undefined && w.body.quiesce.restoredAt === undefined) await this.#restore(w.body.windowId);
          if (w.body.toldAt === undefined && w.body.status !== "cancelled") { const cur = await this.#runner.get(WINDOW, w.body.windowId); if (cur !== undefined) await this.#tell(cur.revision, cur.body as unknown as WindowBody); }
        }
      } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
    return { moved };
  }

  async #step(rev: number, w: WindowBody): Promise<boolean> {
    const now = this.#now();
    const opens = Date.parse(w.opensAt);
    const closes = Date.parse(w.closesAt);
    const cid = (what: string): string => `rwin:${w.windowId}:${what}`;
    if (w.status === "activated") return this.#outcome(rev, w);
    // The activation was called before a crash or a failed write: what it did is read from the activation record, not assumed (it may have switched, and the launcher may even have
    // started and fallen back since). Only a switch that never happened lets the window go on (or close as missed).
    if (w.activatingAt !== undefined) {
      const took = await this.#took(w);
      if (took === "pending") return false;
      if (took !== undefined) { await this.#write(rev, w, this.#activated(w, took.from), "release.window.activate", cid("activated")); return true; }
    }
    // A window that closed before the update started never deploys afterwards.
    if (now >= closes) {
      const next = w.waiting !== undefined && w.status === "prepared"
        ? this.#next(w, "deferred", `the window closed while work was still running (${w.waiting}); nothing was stopped and the release was not activated`)
        : this.#next(w, "missed", w.status === "scheduled" ? "the window closed before the release could be prepared (the controller was not running, or preparation came too late); it was not activated and will not be activated later" : "the window closed before the release could be activated; it will not be activated later");
      const saved = await this.#write(rev, w, next, "release.window.close", cid("close"));
      await this.#tell(saved, next);
      return true;
    }
    if (w.status === "scheduled") {
      if (now < opens - w.prepareLeadMinutes * MINUTE) return false;
      const problem = await this.#prepare(w);
      if (problem !== undefined) {
        const next = this.#next(w, "failed", `preparation failed: ${problem.reason}`);
        const saved = await this.#write(rev, w, next, "release.window.prepare", cid("prepare"), undefined, {}, problem.quarantine ? problem.reason : undefined);
        await this.#tell(saved, next);
        return true;
      }
      const prepared = this.#next(w, "prepared");
      const saved = await this.#write(rev, w, prepared, "release.window.prepare", cid("prepare"));
      // Already open: go on to the activation in the same sweep.
      if (now >= opens) await this.#step(saved, prepared);
      return true;
    }
    // prepared: wait for the opening, then for running work to end (never stopped here), then activate.
    if (now < opens) return false;
    if (this.#o.quiesce !== undefined) {
      const q = await this.#quiet(rev, w);
      if (!q.quiet) return q.moved;
      rev = q.rev; w = q.w;
    } else {
      const live = this.#o.liveAttempts === undefined ? 0 : await this.#o.liveAttempts();
      if (live > 0) {
        const waiting = `${live} agent attempt(s) running`;
        if (w.waiting === waiting) return false;
        // Named by the revision it moves from (the history is capped, so its length repeats).
        await this.#write(rev, w, { ...w, waiting, history: [...w.history, { at: this.#runner.now(), event: "waiting", reason: waiting }].slice(-WINDOW_LIMITS.history) }, "release.window.wait", cid(`wait-${rev}`));
        return true;
      }
    }
    // The checkpoint: a verified snapshot taken once the installation is quiet and before anything switches.
    if (this.#o.checkpoint !== undefined && w.checkpoint === undefined) {
      let made: Awaited<ReturnType<NonNullable<WindowOptions["checkpoint"]>>> | undefined;
      let why = "";
      try { made = await this.#o.checkpoint(); } catch (error) { why = recordText(error); }
      if (made !== undefined && (!made.verified || made.problems?.length)) { why = `the snapshot did not verify (${recordText((made.problems ?? []).slice(0, 3).join("; "))})`; made = undefined; }
      if (made === undefined) {
        const next = this.#next(w, "failed", `the checkpoint could not be taken, so nothing was switched: ${why || "no snapshot"}`);
        const saved = await this.#write(rev, w, next, "release.window.checkpoint", cid("checkpoint-failed"));
        await this.#tell(saved, next);
        return true;
      }
      const marked: WindowBody = { ...w, checkpoint: { name: made.name.slice(0, 200), digest: made.digest, at: this.#runner.now(), ...(made.note === undefined ? {} : { note: made.note.slice(0, 200) }) }, history: [...w.history, { at: this.#runner.now(), event: "checkpoint", reason: made.name.slice(0, 120) }].slice(-WINDOW_LIMITS.history) };
      rev = await this.#write(rev, w, marked, "release.window.checkpoint", cid("checkpoint"));
      w = marked;
    }
    // The checks of preparation are made again just before the switch (a file changed since is caught here, not after).
    const problem = await this.#prepare(w);
    if (problem !== undefined) {
      const next = this.#next(w, "failed", `the release failed its check at the opening: ${problem.reason}`);
      const saved = await this.#write(rev, w, next, "release.window.activate", cid("activate-check"), undefined, {}, problem.quarantine ? problem.reason : undefined);
      await this.#tell(saved, next);
      return true;
    }
    // The intent is saved before the switch, so a crash between the switch and its record is settled from the activation record (above) rather than read as "never activated".
    if (w.activatingAt === undefined) {
      const marked: WindowBody = { ...w, activatingAt: this.#runner.now() };
      rev = await this.#write(rev, w, marked, "release.window.activating", cid("activating"));
      w = marked;
    }
    try {
      await this.#o.activation.activate(WINDOW_ACTOR, { commandId: cid("activate"), candidateId: w.candidateId, digest: w.digest, ...(w.migrationPlan === undefined ? {} : { migrationPlan: w.migrationPlan }) });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      // An error after the journal opened (the commit could not be written, the switch's undo failed) can leave the switch open, or even done: K02's restart recovery may then finish it. Such a
      // window is settled from the activation record like one that stopped mid-switch, never reported failed when the release did (or may yet) switch.
      const took = await this.#took(w, true);
      if (took === "pending") return false;
      if (took !== undefined) { await this.#write(rev, w, this.#activated(w, took.from), "release.window.activate", cid("activated")); return true; }
      const next = this.#next(w, "failed", `activation was refused: ${errorText(error)}`);
      const saved = await this.#write(rev, w, next, "release.window.activate", cid("activate-refused"));
      await this.#tell(saved, next);
      return true;
    }
    // The way back is the release the activation recorded as the one it switched from.
    const took = await this.#took(w);
    await this.#write(rev, w, this.#activated(w, took === undefined || took === "pending" ? (await this.#o.activation.status(WINDOW_ACTOR)).previous?.id : took.from), "release.window.activate", cid("activated"));
    return true;
  }

  /**
   * Quiesce: records the installation's pause state as the window found it, pauses it when it was active, and suspends every running attempt (never released, never Force Stopped). Only a running attempt that cannot
   * be made quiet holds the window up. Every step is written before the next, so a crash is settled from the record.
   */
  async #quiet(rev: number, w: WindowBody): Promise<{ quiet: false; moved: boolean } | { quiet: true; rev: number; w: WindowBody }> {
    const port = this.#o.quiesce!;
    const cid = (what: string): string => `rwin:${w.windowId}:${what}`;
    const hold = async (waiting: string): Promise<{ quiet: false; moved: boolean }> => {
      if (w.waiting === waiting) return { quiet: false, moved: false };
      await this.#write(rev, w, { ...w, waiting, history: [...w.history, { at: this.#runner.now(), event: "waiting", reason: waiting }].slice(-WINDOW_LIMITS.history) }, "release.window.wait", cid(`wait-${rev}`));
      return { quiet: false, moved: true };
    };
    let q = w.quiesce;
    if (q === undefined) {
      const gate = await port.pauses.gateState(INSTALLATION);
      q = { prior: gate?.intent === "pause" ? "paused" : "active", frozen: [], running: 0, waiting: 0, parked: 0, summary: gate?.intent === "pause" ? "the installation was already paused before the window; the window leaves that pause as it is" : "the window is about to pause the installation" };
      const next = { ...w, quiesce: q };
      rev = await this.#write(rev, w, next, "release.window.quiesce", cid("quiesce-start"));
      w = next;
    }
    if (q.prior === "active" && q.paused !== true) {
      try { await port.pauses.pause(WINDOW_ACTOR, { commandId: cid("pause"), scope: INSTALLATION, reason: `maintenance window ${w.windowId}: no new work starts while the installation is updated` }); }
      catch (error) {
        // Paused by someone between the look and the call: theirs, and left alone.
        if (!(error instanceof DomainError && error.code === "invalid_command")) throw error;
        q = { ...q, prior: "paused", summary: "the installation was paused by someone else just as the window opened; the window leaves that pause as it is" };
      }
      q = { ...q, paused: true };
      const next = { ...w, quiesce: q };
      rev = await this.#write(rev, w, next, "release.window.quiesce", cid("quiesce-paused"));
      w = next;
    }
    // The pause must still hold: new work would otherwise start while the release switches. The window does not set it again against the owner's word; it waits (and ends deferred) instead.
    if ((await port.pauses.gateState(INSTALLATION))?.intent !== "pause") return hold("the pause holding new work was lifted during the window; cancel the window, or pause the installation again");
    const tag = freezeTag(w.windowId);
    const ours = (a: { frozen: boolean; frozenReason?: string }): boolean => a.frozen && (a.frozenReason ?? "").startsWith(tag);
    let all = await port.attempts();
    const limit = port.limit ?? 200;
    if (q.quietAt === undefined) {
      // Listed again after each round: an attempt whose start was already under way when the pause closed the gate becomes running meanwhile, and must be made quiet too (as the H12q coordinator does).
      for (let round = 0; ; round++) {
        const running = all.filter((a) => a.state === "running");
        if (running.length > limit) return hold(`${running.length} agent attempts are running; the window can suspend at most ${limit}`);
        // Recorded before the freeze, so a crash still knows which freezes are the window's. A freeze somebody else set stays theirs (an attempt holds one freeze: its reason says whose).
        const mine: Set<string> = new Set<string>(q.frozen);
        for (const a of running) if (!a.frozen || ours(a)) mine.add(a.attemptId);
        if (mine.size !== q.frozen.length) {
          q = { ...q, frozen: [...mine] };
          const next = { ...w, quiesce: q };
          rev = await this.#write(rev, w, next, "release.window.quiesce", cid(`quiesce-freezing-${rev}`));
          w = next;
        }
        const settled: Set<string> = new Set<string>(q.settled ?? []);
        const failed: string[] = [];
        let work = 0;
        for (const a of running) {
          if (!mine.has(a.attemptId) || (settled.has(a.attemptId) && ours(a))) continue;
          // Someone else's freeze took the place of the window's since it was recorded (a landing lifted it and froze again): theirs, not touched.
          if (a.frozen && !ours(a)) continue;
          work++;
          try { await port.freeze(a.attemptId, `${tag} suspended while the installation is updated`); settled.add(a.attemptId); }
          catch (error) { if (error instanceof DomainError && error.code === "not_found") settled.add(a.attemptId); else failed.push(`${a.attemptId}: ${recordText(error, 80)}`); }
        }
        if (settled.size !== (q.settled ?? []).length) {
          q = { ...q, settled: [...settled] };
          const next = { ...w, quiesce: q };
          rev = await this.#write(rev, w, next, "release.window.quiesce", cid(`quiesce-settled-${rev}`));
          w = next;
        }
        if (failed.length > 0) return hold(`${failed.length} running attempt(s) could not be made quiet (${failed[0]}); nothing was stopped`.slice(0, 200));
        if (work === 0 || round >= 3) break;
        all = await port.attempts();
      }
    }
    const running = all.filter((a) => a.state === "running").length;
    const waiting = all.filter((a) => a.state === "waiting").length;
    const parked = all.filter((a) => a.state === "parked").length;
    const held = q.prior === "active" && (await port.pauses.ownPause(INSTALLATION, [{ operationId: cid("pause"), actor: WINDOW_ACTOR.id }])) !== undefined ? "new work held by the window's pause" : "new work held by a pause the window did not make (it stays after the window)";
    const summary = `${running} running attempt(s) suspended with a checkpoint and not released; ${waiting} waiting and ${parked} parked left where they are; ${held}`;
    const { waiting: _w, ...rest } = w;
    const quiet: WindowBody = { ...(rest as WindowBody), quiesce: { ...q, running, waiting, parked, summary, quietAt: q.quietAt ?? this.#runner.now() } };
    if (q.quietAt === undefined || w.waiting !== undefined) rev = await this.#write(rev, w, quiet, "release.window.quiesce", cid("quiet"));
    return { quiet: true, rev, w: q.quietAt === undefined || w.waiting !== undefined ? quiet : w };
  }

  /**
   * Puts back what the window set: the freezes it made are lifted (only while they are still the window's: a freeze someone set since stays) and its own pause is lifted (only that very pause, and not
   * once a Stop or a Suspend took it over: an owner's pause already there, or set again later, is left). Safe to repeat; a step that fails is kept in the record and tried again at the next sweep.
   */
  async #restore(windowId: string): Promise<void> {
    const port = this.#o.quiesce;
    const found = await this.#runner.get(WINDOW, windowId);
    if (port === undefined || found === undefined) return;
    const w = found.body as unknown as WindowBody;
    const q = w.quiesce;
    if (q === undefined || q.restoredAt !== undefined || OPEN_STATES.has(w.status)) return;
    const problems: string[] = [];
    let released = 0;
    let kept = 0;
    if (q.frozen.length > 0) {
      const tag = freezeTag(windowId);
      let now: Map<string, { frozen: boolean; frozenReason?: string }> | undefined;
      try { now = new Map((await port.attempts()).map((a) => [a.attemptId, a])); } catch (error) { problems.push(`attempts: ${recordText(error, 80)}`); }
      for (const id of now === undefined ? [] : q.frozen) {
        const a = now!.get(id);
        // Ended, or no longer frozen: nothing of the window's is left on it.
        if (a === undefined || !a.frozen) continue;
        if (!(a.frozenReason ?? "").startsWith(tag)) { kept++; continue; }
        try { await port.release(id); released++; } catch (error) { if (!(error instanceof DomainError && error.code === "not_found")) problems.push(`${id}: ${recordText(error, 80)}`); }
      }
    }
    let gate = "no pause was made by the window";
    if (q.prior === "paused") gate = "the pause that was there before the window was left as it was";
    else if (q.paused === true || q.prior === "active") {
      const own = await port.pauses.ownPause(INSTALLATION, [{ operationId: `rwin:${windowId}:pause`, actor: WINDOW_ACTOR.id }]);
      const state = await port.pauses.gateState(INSTALLATION);
      if (own === undefined) gate = state?.intent === "pause" ? "the installation is paused by someone else now, and that pause was left as it is" : "the installation was already active again";
      // A Stop or a Suspend the owner asked for during the window took the window's pause over and relies on it: it stays until the owner resumes.
      else if (state?.takenOver === true) gate = "a stop or suspension took the window's pause over, so it was left for the owner to lift";
      else {
        try { await port.pauses.resumeOwnHold(WINDOW_ACTOR, { commandId: `rwin:${windowId}:resume`, scope: INSTALLATION, reason: `maintenance window ${windowId} ended (${w.status})`, requestId: own }); gate = "the window's own pause was lifted"; }
        catch (error) {
          if (error instanceof DomainError && error.code === "invalid_command") gate = "the window's pause was no longer in force (someone changed it), so nothing was lifted";
          else problems.push(`pause: ${recordText(error, 100)}`);
        }
      }
    }
    const rev = (await this.#runner.get(WINDOW, windowId))!.revision;
    if (problems.length > 0) {
      const problem = problems.join("; ").slice(0, 300);
      if (q.problem === problem) return;
      await this.#write(rev, w, { ...w, quiesce: { ...q, problem } }, "release.window.restore", `rwin:${windowId}:restore-problem-${rev}`);
      return;
    }
    const { problem: _p, ...clean } = q;
    const others = kept === 0 ? "" : `; ${kept} attempt(s) now held by someone else's freeze were left as they are`;
    await this.#write(rev, w, { ...w, quiesce: { ...clean, restoredAt: this.#runner.now(), summary: `put back: ${released} suspended attempt(s) released${others}; ${gate}` } }, "release.window.restore", `rwin:${windowId}:restored`);
  }

  #activated(w: WindowBody, from: string | undefined): WindowBody {
    const { waiting: _w, ...rest } = w;
    return { ...this.#next(rest as WindowBody, "activated", "activated; the launcher runs it at the controller's next start"), ...(from === undefined || from === w.candidateId ? {} : { from }) };
  }

  /**
   * Whether this window's activation took effect: "pending" while its switch is still open in the journal; the release it switched from when it did; undefined when it did not. `own` counts only
   * the window's own recorded switch (after a refusal, a release someone else made current is not this window's doing).
   */
  async #took(w: WindowBody, own = false): Promise<{ from?: string } | "pending" | undefined> {
    const s = await this.#o.activation.status(WINDOW_ACTOR);
    if (s.journal !== undefined && s.journal.kind === "activate" && s.journal.to.id === w.candidateId) return "pending";
    const since = w.activatingAt ?? "";
    const e = [...s.history].reverse().find((h) => (h.kind === "activated" || h.kind === "recovered") && h.to === w.candidateId && h.by === WINDOW_ACTOR.id && h.at >= since);
    if (e !== undefined) return e.from === undefined ? {} : { from: e.from };
    if (!own && s.current?.id === w.candidateId) return s.previous === undefined ? {} : { from: s.previous.id };
    return undefined;
  }

  /** After activation: committed once the launcher confirmed the release's start, reverted when it recorded the start as failed (and fell back). */
  async #outcome(rev: number, w: WindowBody): Promise<boolean> {
    const s = await this.#o.activation.status(WINDOW_ACTOR);
    const failed = s.failedStarts.find((f) => f.id === w.candidateId);
    let next: WindowBody | undefined;
    let quarantine: string | undefined;
    if (failed !== undefined) { next = this.#next(w, "reverted", `the release failed to start (${failed.reason.slice(0, 120)}) and the launcher went back to the last known good`); quarantine = "it failed to start after a window activated it"; }
    else if (s.current?.id === w.candidateId && s.lastKnownGood?.id === w.candidateId) next = this.#next(w, "committed", "the release started and confirmed its start");
    else if (s.current?.id !== w.candidateId && s.journal === undefined) next = this.#next(w, "reverted", `another release (${s.current?.id ?? "none"}) became current before this one confirmed its start`);
    if (next === undefined) return false;
    const saved = await this.#write(rev, w, next, "release.window.outcome", `rwin:${w.windowId}:outcome`, undefined, {}, quarantine);
    await this.#tell(saved, next);
    return true;
  }

  /** Prepare: the release is not quarantined, its staged files still match the digest the owner named, and there is room. Says whether a failure quarantines the release. */
  async #prepare(w: WindowBody): Promise<{ reason: string; quarantine: boolean } | undefined> {
    const q = await this.#runner.get(QUARANTINE, w.candidateId);
    if (q !== undefined) return { reason: `the release is quarantined (${(q.body as unknown as QuarantineBody).reason})`, quarantine: false };
    let v: Awaited<ReturnType<WindowOptions["activation"]["verify"]>>;
    try { v = await this.#o.activation.verify(WINDOW_ACTOR, { releaseId: w.candidateId }); } catch (error) {
      if (error instanceof DomainError && error.code === "not_found") return { reason: "the release is no longer staged", quarantine: false };
      throw error;
    }
    if (v.digest !== w.digest) return { reason: "the staged release's digest is not the one the window names", quarantine: true };
    if (!v.ok) return { reason: `its files do not match its manifest (${v.problems.slice(0, 3).join("; ").slice(0, 160)})`, quarantine: true };
    if (v.migrationPlan !== w.migrationPlan) return { reason: "the release's migration plan is not the one the window was set with", quarantine: true };
    const free = await (this.#o.freeBytes ?? defaultFreeBytes)(this.#o.root).catch(() => undefined);
    if (free === undefined) return { reason: "the free space under the release root could not be read", quarantine: false };
    if (free < w.minFreeBytes) return { reason: `only ${free} bytes are free under the release root; the window needs ${w.minFreeBytes}`, quarantine: false };
    return undefined;
  }

  #next(w: WindowBody, status: WindowStatus, reason?: string): WindowBody {
    const at = this.#runner.now();
    return { ...w, status, ...(reason === undefined ? {} : { reason }), history: [...w.history, { at, event: status, ...(reason === undefined ? {} : { reason }) }].slice(-WINDOW_LIMITS.history) };
  }

  /** Writes the window (revision guarded) and, in the same operation, the candidate's quarantine record when `quarantine` names a reason. Returns the new revision. */
  async #write(rev: number, w: WindowBody, next: WindowBody, type: string, commandId: string, actor = "service:release-window", detail: JsonObject = {}, quarantine?: string): Promise<number> {
    const ref: AggregateRef = { kind: WINDOW, id: w.windowId };
    const qref: AggregateRef = { kind: QUARANTINE, id: w.candidateId };
    const qBody: QuarantineBody | undefined = quarantine === undefined ? undefined : { candidateId: w.candidateId, reason: quarantine, at: this.#runner.now(), windowId: w.windowId };
    const qExists = quarantine === undefined ? true : (await this.#runner.get(QUARANTINE, w.candidateId)) !== undefined;
    const r = await this.#runner.command(type, { commandId, actor }, async () => ({
      payload: { windowId: w.windowId, from: w.status, to: next.status, rev },
      build: async () => ({ ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: rev, body: next as unknown as JsonObject }, ...(qBody === undefined || qExists ? [] : [{ type: "create" as const, ref: qref, body: qBody as unknown as JsonObject }])], detail: { status: next.status, ...(next.reason === undefined ? {} : { reason: next.reason }), ...detail } }),
    }));
    return r.revision;
  }

  /** Files the owner's notice for an ended window once, then records that it was filed. A notice that cannot be filed now is tried again at the next sweep. */
  async #tell(rev: number, w: WindowBody): Promise<void> {
    if (this.#o.notify === undefined || w.status === "cancelled" || w.toldAt !== undefined) return;
    const level = w.status === "committed" ? "notice" : "needs-you";
    const label = w.status === "committed" ? "A maintenance window updated the installation" : `A maintenance window ${w.status === "reverted" ? "was reverted" : `ended ${w.status}`}`;
    const detail = `Window ${w.windowId} for release ${w.candidateId}: ${w.reason ?? w.status}`.slice(0, 200);
    try { await this.#o.notify({ commandId: `rwin-told-${w.windowId.slice(5)}-${w.status}`, windowId: w.windowId, level, label, detail }); } catch (error) {
      if (!(error instanceof DomainError && error.code === "command_conflict")) throw error;
    }
    await this.#write(rev, w, { ...w, toldAt: this.#runner.now() }, "release.window.told", `rwin:${w.windowId}:told`);
  }

  async #view(by: Principal, revision: number, w: WindowBody): Promise<WindowView> {
    // Rollback eligibility is shown for a window that changed the current release and has a way back (card K03's check: a tested pair, additive migrations, the period open).
    if ((w.status === "activated" || w.status === "committed") && w.from !== undefined) {
      const c = await this.#o.activation.rollbackCheck(by, w.from).catch((e: unknown) => ({ ok: false, reasons: [errorText(e)] }));
      return { ...w, revision, rollback: { to: w.from, ok: c.ok, reasons: c.reasons } };
    }
    return { ...w, revision };
  }

  /** Every window, read page by page: the records are listed by ID (a hash), not by age, so a single bounded page could leave out the one open window once many have ended. */
  async #all(): Promise<{ revision: number; body: WindowBody }[]> {
    const out: { revision: number; body: WindowBody }[] = [];
    for (let afterId: string | undefined; ;) {
      const size = this.#o.scanPage ?? WINDOW_LIMITS.scanned;
      const page = await this.#runner.list(WINDOW, { limit: size, ...(afterId === undefined ? {} : { afterId }) });
      for (const a of page) out.push({ revision: a.revision, body: a.body as unknown as WindowBody });
      if (page.length < size) return out;
      afterId = page[page.length - 1]!.id;
    }
  }

  #lock: Promise<unknown> = Promise.resolve();
  async #serial<T>(run: () => Promise<T>): Promise<T> {
    const mine = this.#lock.catch(() => undefined).then(run);
    this.#lock = mine;
    return mine;
  }
}

async function defaultFreeBytes(root: string): Promise<number> {
  const s = await statfs(root);
  return Number(s.bavail) * Number(s.bsize);
}

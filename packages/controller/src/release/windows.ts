import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allowsExactly } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { instantOf, isLocalDate, isLocalTime, knownZone } from "../meetings/zones.js";
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
 * - `prepared` -> **Quiesce check** (only while the window is open): while any agent attempt is running, nothing is stopped; the window waits and says so. Running work is never Force Stopped.
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
 * Not in this slice (see the implementation notes): suspending workers without release, the checkpoint, a migration test on an isolated copy, the quarantined start with dispatch and effects
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
export interface QuarantineBody { readonly candidateId: string; readonly reason: string; readonly at: string; readonly windowId: string }
export interface WindowView extends WindowBody { readonly revision: number; readonly rollback?: { readonly to: string; readonly ok: boolean; readonly reasons: readonly string[] } }

export interface WindowNotice { readonly commandId: string; readonly windowId: string; readonly level: "needs-you" | "notice"; readonly label: string; readonly detail: string }
export interface WindowOptions {
  readonly activation: Pick<ReleaseActivationService, "verify" | "activate" | "status" | "rollbackCheck">;
  /** The release root, for the free-space check. */
  readonly root: string;
  /** Free bytes at the root; default `statfs`. */
  readonly freeBytes?: (root: string) => Promise<number>;
  /** How many agent attempts are running now; without it the quiesce check passes (no dispatcher). */
  readonly liveAttempts?: () => Promise<number>;
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

  /** Owner only: ends a window that has not activated anything. Nothing else is touched (this slice applies no gates). */
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

  /** The newest windows first (by opening time), with the quarantined releases. */
  async list(by: Principal): Promise<{ windows: readonly WindowView[]; quarantined: readonly QuarantineBody[]; truncated: boolean }> {
    mayRead(by);
    const all = (await this.#all()).sort((a, b) => (a.body.opensAt < b.body.opensAt ? 1 : a.body.opensAt > b.body.opensAt ? -1 : 0));
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
        if (OPEN_STATES.has(w.body.status)) { if (await this.#step(w.revision, w.body)) moved++; }
        else if (w.body.toldAt === undefined && w.body.status !== "cancelled") await this.#tell(w.revision, w.body);
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
    const live = this.#o.liveAttempts === undefined ? 0 : await this.#o.liveAttempts();
    if (live > 0) {
      const waiting = `${live} agent attempt(s) running`;
      if (w.waiting === waiting) return false;
      // Named by the revision it moves from (the history is capped, so its length repeats).
      await this.#write(rev, w, { ...w, waiting, history: [...w.history, { at: this.#runner.now(), event: "waiting", reason: waiting }].slice(-WINDOW_LIMITS.history) }, "release.window.wait", cid(`wait-${rev}`));
      return true;
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

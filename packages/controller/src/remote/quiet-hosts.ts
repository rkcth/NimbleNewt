import { createHash, randomUUID } from "node:crypto";
import { DomainError, isDomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { HostService } from "../hosts/index.js";
import { scopedCommandId } from "../security/credentials.js";
import { DISPATCHER_PRINCIPAL } from "../security/task-credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { QuietHostSettingsService } from "./quiet-host-settings.js";
import type { PlacementBody, RemoteWorkerService } from "./service.js";

export const QUIET_HOST_KIND = "quiet-host";
const CURSOR_KIND = "quiet-host-cursor";
const HOST = /^host:[a-z0-9][a-z0-9-]{0,39}$/;
const LIVE_STATES: ReadonlySet<string> = new Set(["offered", "accepted", "relocating"]);
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Work done in one pass or one call, so a large backlog is worked off over several passes and no pass runs for ever. */
export const QUIET_HOST_LIMITS = { liveAttempts: 2000, hosts: 100, records: 1000, movesPerPass: 10, ownerMoves: 25, pending: 100, pendingAgeMs: 24 * HOUR_MS, targets: 5, deletesPerPass: 20, attemptsPerPass: 60, cursorEvery: 20 } as const;
/** A record of a host that recovered is kept this long (and at least a day past the notice interval, which it carries) and then deleted, so the records stay as many as the hosts that are or were recently quiet. Provisional: 7 days. */
export const QUIET_HOST_RETENTION_MS = 7 * 24 * HOUR_MS;
/** A host not heard from for this long while it holds work is quiet. Provisional: well past the 90 s freshness window, so a restart or a network blip is not an episode. */
export const DEFAULT_QUIET_AFTER_MS = 5 * MIN_MS;
/** Between two passes of the dispatcher's tick, longer than this is not normal running (the tick is every few seconds): the clock jumped or the controller stalled. Provisional: 10 minutes. */
export const DEFAULT_MAX_GAP_MS = 10 * MIN_MS;

interface Pending { readonly attemptId: string; readonly to: string; readonly commandId: string; readonly at: string }
export interface QuietHostBody {
  readonly hostId: string;
  /** The time the host was first judged quiet: it names the episode. A host that drops out and reports again in between is the same episode; only sustained recovery ends it. `owner` for a record only the owner's move wrote. */
  readonly episode: string;
  readonly quietSince: string;
  /** `quiet`: the host is quiet and its work may be moved. `recovered`: it reported without a gap for the recovery period; nothing moves any more for this episode. */
  readonly state: "quiet" | "recovered";
  readonly warnedAt?: string;
  /** What the warning said about automatic moves: false means "off", and turning them on later starts the grace period again, with a new notice. */
  readonly warnedAutoMove?: boolean;
  readonly blockedAt?: string;
  /** The last time the owner was told anything about this host, in any episode: at most one notice per host in the notice interval. */
  readonly lastNoticeAt?: string;
  /** The grace period (hours) the last timer notice named, and whether the episode before this one lasted past it: a new episode inside the notice interval repeats the timer notice only when the figure changed or the last episode outlasted it. */
  readonly lastTimerHours?: number;
  readonly priorLong?: boolean;
  /** While the episode is open and the host reports again: when the unbroken run of fresh sightings began and how many were seen (counted to 2). A sighting of the host not fresh clears both. */
  readonly freshSince?: string;
  readonly freshSightings?: number;
  /** Moves started and not yet known to be finished (a restart in the middle finishes them). */
  readonly pending: readonly Pending[];
  readonly updatedAt: string;
}

export interface QuietHostNotice { readonly commandId: string; readonly hostId: string; readonly detail: string }
export interface QuietHostDeps {
  /** The dispatcher's own service principal: it reads host status and moves attempts. */
  readonly principal: Principal;
  readonly settings: Pick<QuietHostSettingsService, "effective">;
  readonly hosts: Pick<HostService, "status">;
  readonly remote: Pick<RemoteWorkerService, "placement" | "candidates" | "relocate">;
  /** The attempts the dispatcher holds (not finished), any host, with the dispatcher's state for each (`parked` ones wait with an ended placement and are moved from the checkpoint they parked with). Read once per pass. */
  readonly liveAttempts: () => Promise<readonly { readonly attemptId: string; readonly state: string }[]>;
  /** The dispatcher's state of one attempt; `finished` or undefined means it is over and is left alone. */
  readonly attemptState: (attemptId: string) => Promise<string | undefined>;
  /** A needs-you notification to the owner. The command ID is stable per episode, so a repeat is not a second notice. */
  readonly notify: (notice: QuietHostNotice) => Promise<void>;
}
export interface QuietHostOptions extends RunnerOptions {
  readonly quietAfterMs?: number;
  /** The longest gap between two passes that counts as normal running; a longer one (or a clock that went back) is read as a clock jump or a stall, and judgement waits `quietAfterMs` for the hosts to report. Default 10 minutes. */
  readonly maxGapMs?: number;
}
export interface QuietHostPass { readonly warned: number; readonly moved: number; readonly recovered: number; readonly blocked: number }
export interface MoveWorkResult {
  readonly hostId: string;
  readonly moved: readonly { readonly attemptId: string; readonly to: string }[];
  readonly skipped: readonly { readonly attemptId: string; readonly reason: string }[];
  /** More attempts than one call moves: ask again. */
  readonly more: boolean;
}
/** Why an attempt did not move: `no-host` (nothing allowed can take it: the owner is told), `changed` (it finished, moved or was fenced meanwhile: nothing to do), `transient` (an error: the next pass repeats it). */
type MoveOutcome = { readonly ok: true; readonly to: string } | { readonly ok: false; readonly kind: "no-host" | "changed" | "transient"; readonly reason: string };

const digest = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
const hostName = (hostId: string): string => hostId.slice("host:".length);
const without = <T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };

/**
 * What the controller does when a host stops reporting while it holds work (owner decision 2026-10-30), in this order:
 *
 * 1. **Warn.** A host that holds live or parked attempts and has not been heard from for `quietAfterMs` gets a quiet episode and one needs-you notification (the identity is the host and the episode). An episode
 *    is the host's first quiet time: a host that reports now and then and drops out again in between stays in the same episode, and only an unbroken run of fresh sightings for the recovery period (at least two
 *    sightings; the owner's setting, default 10 minutes) ends it. The owner is told at most once per host in the notice interval (setting, default 6 hours), however often the host drops out.
 * 2. **Owner says move.** `moveWork` (owner only) re-places every live attempt of the host at once, with the placement and exclusion rules that apply to any placement; the relocation path (`RemoteWorkerService.relocate`)
 *    fences the old host, takes the last stored checkpoint when the host does not answer (bounded: a dead host cannot hold the pass), and restarts the attempt on the new host from it.
 * 3. **Owner says nothing.** When the grace period has passed since the warning, and automatic moves are on, the pass moves the host's attempts the same way. Off (or a damaged setting) means never by itself; when
 *    the warning said they were off and the owner turns them on, the grace period starts again from then, with a new notice that says so.
 * 4. **The host comes back** (fresh without a gap for the recovery period) before that: the episode is closed and nothing moves.
 *
 * Two guards keep a restart or a clock jump from warning about every host: no host is judged until this controller has been running for the quiet threshold, and a gap between two passes that is not plausible
 * (a clock that jumped forward or back, or a stalled controller) starts that wait again.
 *
 * The state is a record per host, so the pass is restart-safe (the warning time, the episode and the moves under way survive), replay-safe (every notice and every move has an ID derived from the episode and
 * the attempt) and bounded (`QUIET_HOST_LIMITS`): moves started before are finished within the pass's move budget, hosts are examined from a persisted cursor so none starves, and a record of a host that recovered
 * long ago is deleted. Only the dispatcher's own pass and the owner's call reach it; no worker or agent does.
 */
export class QuietHostService {
  readonly #runner: CommandRunner;
  readonly #deps: QuietHostDeps;
  readonly #quietAfterMs: number;
  readonly #maxGapMs: number;
  /** When this process began to judge hosts (re-set by a clock jump), and when the last pass ran. */
  #upSince: number;
  #lastPass: number | undefined;
  /** Rotating start positions (in memory) for the move stage and the pending-finish stage, so a host whose attempts cannot move does not hold the others up pass after pass. */
  #moveRound = 0;
  #pendingRound = 0;
  /** The cursor is kept in memory and written only now and then (every `cursorEvery` passes) or when it is reset, so a long host list does not write every tick. */
  #cursor: string | undefined;
  #cursorWritten: string | undefined;
  #cursorPasses = 0;

  private constructor(runner: CommandRunner, deps: QuietHostDeps, quietAfterMs: number, maxGapMs: number) {
    this.#runner = runner; this.#deps = deps; this.#quietAfterMs = quietAfterMs; this.#maxGapMs = maxGapMs;
    this.#upSince = Date.parse(runner.now());
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: QuietHostDeps, options: QuietHostOptions = {}): QuietHostService {
    if (deps.principal.kind !== "service" || deps.principal.id !== DISPATCHER_PRINCIPAL || deps.principal.taskScope !== undefined) throw new DomainError("invalid_command", "principal: the quiet-host service acts as the dispatcher's service principal", { field: "principal" });
    const quietAfterMs = options.quietAfterMs ?? DEFAULT_QUIET_AFTER_MS;
    if (!Number.isSafeInteger(quietAfterMs) || quietAfterMs < 1000) throw new DomainError("invalid_command", "quietAfterMs: must be a whole number of at least 1000", { field: "quietAfterMs" });
    const maxGapMs = options.maxGapMs ?? DEFAULT_MAX_GAP_MS;
    if (!Number.isSafeInteger(maxGapMs) || maxGapMs < 1000) throw new DomainError("invalid_command", "maxGapMs: must be a whole number of at least 1000", { field: "maxGapMs" });
    return new QuietHostService(new CommandRunner(storage, epoch, options), deps, quietAfterMs, maxGapMs);
  }

  /** The records of hosts that are or were quiet, for the owner. */
  async episodes(by: Principal): Promise<QuietHostBody[]> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the quiet hosts`);
    return (await this.#records()).map((r) => r.body);
  }

  /** One pass, the dispatcher's only (never exposed through the API). */
  async sweep(by: Principal): Promise<QuietHostPass> {
    if (by.id !== DISPATCHER_PRINCIPAL || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not run the quiet-host pass`);
    const out = { warned: 0, moved: 0, recovered: 0, blocked: 0 };
    const figures = await this.#deps.settings.effective();
    const now = this.#runner.now();
    const nowMs = Date.parse(now);
    // A gap between passes that is not plausible (the clock jumped, went back, or the controller stalled) is read like a restart: the hosts are given the quiet threshold to report before any is judged.
    if (this.#lastPass !== undefined && (nowMs < this.#lastPass || nowMs - this.#lastPass > this.#maxGapMs)) this.#upSince = nowMs;
    this.#lastPass = nowMs;
    const bodies = new Map((await this.#records()).map((r) => [r.body.hostId, r.body] as const));
    // The budget counts moves made; a separate bound counts tries, so attempts that cannot move (no host, changed, transient) neither use up the moves nor run the pass for ever.
    let budget: number = QUIET_HOST_LIMITS.movesPerPass;
    let tries: number = QUIET_HOST_LIMITS.attemptsPerPass;
    // Moves that were started and not finished (a restart or an error in the middle) come first (an entry that is done or never happened is dropped without using any of it). The start rotates.
    const withPending = [...bodies.keys()].sort().filter((h) => bodies.get(h)!.pending.length > 0);
    const pendingOffset = withPending.length === 0 ? 0 : this.#pendingRound++ % withPending.length;
    for (const hostId of [...withPending.slice(pendingOffset), ...withPending.slice(0, pendingOffset)]) {
      if (budget <= 0 || tries <= 0) break;
      const r = await this.#finishPending(hostId, Math.min(budget, tries));
      budget -= r.done; tries -= r.worked;
      const fresh = await this.#record(hostId);
      if (fresh !== undefined) bodies.set(hostId, fresh.body); else bodies.delete(hostId);
    }
    // After a restart or a clock jump the hosts get the quiet threshold to report before any is judged.
    if (nowMs - this.#upSince < this.#quietAfterMs) return out;
    const live = await this.#liveByHost();
    // Records of hosts that recovered long ago go (a record carries the notice interval, so it is kept a day longer than that).
    const keep = Math.max(QUIET_HOST_RETENTION_MS, figures.noticeHours * HOUR_MS + 24 * HOUR_MS);
    let deleted = 0;
    for (const [hostId, body] of bodies) {
      if (deleted >= QUIET_HOST_LIMITS.deletesPerPass) break;
      if (body.state !== "recovered" || body.pending.length > 0 || live.has(hostId) || !(nowMs - Date.parse(body.updatedAt) > keep)) continue;
      if (await this.#delete(hostId)) { bodies.delete(hostId); deleted++; }
    }
    // The hosts to look at: those that hold work and those with an open episode, from where the last pass stopped (so a long list is worked through, not cut at the same place every time).
    const all = [...new Set<string>([...live.keys(), ...[...bodies.values()].filter((b) => b.state === "quiet").map((b) => b.hostId)])].sort();
    if (this.#cursor === undefined) { this.#cursor = ((await this.#runner.get(CURSOR_KIND, "main"))?.body as { after?: string } | undefined)?.after ?? ""; this.#cursorWritten = this.#cursor; }
    const start = all.findIndex((h) => h > this.#cursor!);
    const rotated = start <= 0 ? all : [...all.slice(start), ...all.slice(0, start)];
    const batch = rotated.slice(0, QUIET_HOST_LIMITS.hosts);
    const nextCursor = rotated.length > batch.length ? batch[batch.length - 1]! : "";
    // The move stage starts at a rotating position in the batch.
    const offset = batch.length === 0 ? 0 : this.#moveRound++ % batch.length;
    const order = [...batch.slice(offset), ...batch.slice(0, offset)];
    let failure: unknown;
    for (const hostId of order) {
     try {
      const status = await this.#deps.hosts.status(this.#deps.principal, hostId);
      let current = bodies.get(hostId);
      const keepBody = (b: QuietHostBody | undefined): QuietHostBody | undefined => { if (b !== undefined) bodies.set(hostId, b); return b; };
      if (status === undefined) {
        // A host that is no longer enrolled has no episode.
        if (current?.state === "quiet") keepBody(await this.#write(hostId, (cur) => (cur !== undefined && cur.state === "quiet" ? { ...without(cur, "freshSince", "freshSightings"), state: "recovered", updatedAt: this.#runner.now() } : undefined), "gone"));
        continue;
      }
      if (status.freshness === "fresh") {
        // Reporting again is not the end of the episode: a host that drops out and reports every few minutes is one quiet host. The run of fresh sightings has to last the recovery period (and be two or more).
        if (current?.state !== "quiet") continue;
        if (current.freshSince === undefined) current = keepBody(await this.#write(hostId, (cur) => (cur !== undefined && cur.state === "quiet" && cur.freshSince === undefined ? { ...cur, freshSince: now, freshSightings: 1, updatedAt: now } : undefined), "fresh")) ?? current;
        else if ((current.freshSightings ?? 0) < 2) current = keepBody(await this.#write(hostId, (cur) => (cur !== undefined && cur.state === "quiet" && cur.freshSince !== undefined && (cur.freshSightings ?? 0) < 2 ? { ...cur, freshSightings: (cur.freshSightings ?? 0) + 1, updatedAt: now } : undefined), "fresh")) ?? current;
        else if (nowMs - Date.parse(current.freshSince) >= figures.recoverMinutes * MIN_MS) {
          // The episode is over and a move that was waiting does not happen.
          keepBody(await this.#write(hostId, (cur) => (cur !== undefined && cur.state === "quiet" ? { ...without(cur, "freshSince", "freshSightings"), state: "recovered", updatedAt: this.#runner.now() } : undefined), "recovered"));
          out.recovered++;
        }
        continue;
      }
      // Not fresh. A host heard from within the quiet threshold is only blipping (a late heartbeat): neither a run of fresh sightings is broken nor anything moved or opened by one stale sample.
      const lastHeard = status.lastSeenAt === undefined ? undefined : Date.parse(status.lastSeenAt);
      const unheard = lastHeard === undefined || nowMs - lastHeard >= this.#quietAfterMs;
      if (!unheard) continue;
      // Genuinely unheard: a run of fresh sightings is broken.
      if (current?.state === "quiet" && current.freshSince !== undefined) current = keepBody(await this.#write(hostId, (cur) => (cur !== undefined && cur.state === "quiet" && cur.freshSince !== undefined ? { ...without(cur, "freshSince", "freshSightings"), updatedAt: this.#runner.now() } : undefined), "relapsed")) ?? current;
      const attempts = live.get(hostId) ?? [];
      if (current?.state === "quiet") {
        // Nothing left on the host and no move under way: there is nothing to warn about or move, and the episode does not stay open for ever.
        if (attempts.length === 0 && current.pending.length === 0) { keepBody(await this.#write(hostId, (cur) => (cur !== undefined && cur.state === "quiet" && cur.pending.length === 0 ? { ...without(cur, "freshSince", "freshSightings"), state: "recovered", updatedAt: this.#runner.now() } : undefined), "idle")); continue; }
      } else {
        const heard = status.lastSeenAt === undefined ? undefined : Date.parse(status.lastSeenAt);
        const quiet = heard === undefined || nowMs - heard >= this.#quietAfterMs;
        if (!quiet || attempts.length === 0) continue;
        // The episode is named by the time the host was first judged quiet, not by when it was last heard: dropping out again later does not make a new one.
        current = keepBody(await this.#write(hostId, (cur) => (cur !== undefined && cur.state === "quiet" ? undefined : { hostId, episode: now, quietSince: status.lastSeenAt ?? now, state: "quiet", pending: cur?.pending ?? [], ...(cur?.lastNoticeAt === undefined ? {} : { lastNoticeAt: cur.lastNoticeAt }), ...(cur?.lastTimerHours === undefined ? {} : { lastTimerHours: cur.lastTimerHours }), ...(cur !== undefined && Date.parse(cur.updatedAt) - Date.parse(cur.quietSince) > figures.graceHours * HOUR_MS ? { priorLong: true } : {}), updatedAt: now }), "open")) ?? current;
      }
      if (current === undefined || current.state !== "quiet") continue;
      const episode = current.episode;
      const noticeLimited = current.lastNoticeAt !== undefined && nowMs - Date.parse(current.lastNoticeAt) < figures.noticeHours * HOUR_MS;
      const timerText = `${hostId} stopped reporting and holds ${attempts.length} attempt(s). Say "move the work off ${hostId}" to move it now; otherwise it moves after ${figures.graceHours}h unless the host reports again.`;
      if (current.warnedAt === undefined && attempts.length > 0) {
        // The notification text is at most 200 characters.
        const detail = (figures.autoMove ? timerText : `${hostId} stopped reporting and holds ${attempts.length} attempt(s). Automatic moves are off. Say "move the work off ${hostId}" to move it.`).slice(0, 200);
        if (noticeLimited && (!figures.autoMove || (current.lastTimerHours === figures.graceHours && current.priorLong !== true))) {
          // The owner was told about this host a short while ago and there is nothing new to tell: no timer (moves are off), or the same timer as the last notice after an episode that did not outlast it. The warning is recorded, no second notice. A new timer figure, or an earlier episode that lasted past the grace period (so work may have moved), is told even inside the notice interval; a host that flaps is not announced at every episode.
          keepBody(await this.#write(hostId, (cur) => (cur !== undefined && cur.episode === episode && cur.warnedAt === undefined ? { ...cur, warnedAt: now, warnedAutoMove: figures.autoMove, updatedAt: now } : undefined), "warned-quiet"));
          continue;
        }
        // A notice that cannot be sent leaves the record as it was: the next pass sends it again under the same identity, and the other hosts are not held up.
        try { await this.#deps.notify({ commandId: `quiet-host:${hostName(hostId)}:${digest(hostId, episode)}`.slice(0, 120), hostId, detail }); } catch { continue; }
        keepBody(await this.#write(hostId, (cur) => (cur !== undefined && cur.episode === episode && cur.warnedAt === undefined ? { ...cur, warnedAt: this.#runner.now(), warnedAutoMove: figures.autoMove, lastNoticeAt: this.#runner.now(), ...(figures.autoMove ? { lastTimerHours: figures.graceHours } : {}), updatedAt: this.#runner.now() } : undefined), "warned"));
        out.warned++;
        continue;
      }
      if (current.warnedAt !== undefined && current.warnedAutoMove === false && figures.autoMove && attempts.length > 0) {
        // The warning said automatic moves were off and the owner has turned them on since: the grace period counts from now, and the owner is told the timer (this answers the owner's own change, so it is not held back by the notice interval).
        try { await this.#deps.notify({ commandId: `quiet-host-auto:${hostName(hostId)}:${digest(hostId, episode, current.warnedAt)}`.slice(0, 120), hostId, detail: timerText.slice(0, 200) }); } catch { continue; }
        keepBody(await this.#write(hostId, (cur) => (cur !== undefined && cur.episode === episode && cur.warnedAutoMove === false ? { ...without(cur, "blockedAt"), warnedAt: this.#runner.now(), warnedAutoMove: true, lastNoticeAt: this.#runner.now(), lastTimerHours: figures.graceHours, updatedAt: this.#runner.now() } : undefined), "rewarned"));
        out.warned++;
        continue;
      }
      if (!figures.autoMove || current.warnedAt === undefined || attempts.length === 0) continue;
      if (current.freshSince !== undefined) continue;
      if (nowMs < Date.parse(current.warnedAt) + figures.graceHours * HOUR_MS) continue;
      // The last look before moving: a host that reported in the meantime keeps its work (it must be genuinely unheard, not just not fresh at this instant).
      const again = await this.#deps.hosts.status(this.#deps.principal, hostId);
      if (again === undefined || again.freshness === "fresh") continue;
      if (again.lastSeenAt !== undefined && nowMs - Date.parse(again.lastSeenAt) < this.#quietAfterMs) continue;
      let blocked = 0;
      for (const p of attempts) {
        if (budget <= 0 || tries <= 0) break;
        tries--;
        const r = await this.#moveOne(p, digest(hostId, episode), `${hostId} has been quiet since ${current.quietSince} and the owner did not answer the warning within ${figures.graceHours} hour(s)`);
        if (r.ok) { out.moved++; budget--; } else if (r.kind === "no-host") blocked++;
      }
      if (blocked > 0 && current.blockedAt === undefined) {
        // Held back like any other notice (but never for longer than the grace period, whatever the notice interval): tried again on a later pass.
        if (current.lastNoticeAt !== undefined && nowMs - Date.parse(current.lastNoticeAt) < Math.min(figures.noticeHours, figures.graceHours) * HOUR_MS) continue;
        try { await this.#deps.notify({ commandId: `quiet-host-blocked:${hostName(hostId)}:${digest(hostId, episode)}`.slice(0, 120), hostId, detail: `${hostId} is still quiet past the grace period; ${blocked} attempt(s) cannot move: no other allowed host can take them now.`.slice(0, 200) }); } catch { continue; }
        keepBody(await this.#write(hostId, (cur) => (cur !== undefined && cur.episode === episode && cur.blockedAt === undefined ? { ...cur, blockedAt: this.#runner.now(), lastNoticeAt: this.#runner.now(), updatedAt: this.#runner.now() } : undefined), "blocked"));
        out.blocked++;
      }
     } catch (error) { failure ??= error; }
    }
    this.#cursor = nextCursor;
    this.#cursorPasses++;
    if (nextCursor !== this.#cursorWritten && (nextCursor === "" || this.#cursorPasses % QUIET_HOST_LIMITS.cursorEvery === 1)) {
      try { await this.#setCursor(nextCursor, this.#cursorWritten ?? ""); this.#cursorWritten = nextCursor; } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
    return out;
  }

  /**
   * The owner asks to move the work off a host: done right away, whether or not the host is quiet and whatever the setting says. Owner only. Replay-safe: the command ID names the request, a repeat moves what is
   * left and the moves already made are answered, not made again.
   */
  async moveWork(owner: Principal, command: NoActor & { hostId: string }): Promise<MoveWorkResult> {
    if (owner.kind !== "owner" || owner.taskScope !== undefined) throw new DomainError("forbidden", `${owner.id} may not move work off a host`);
    const unknown = Object.keys(command).filter((k) => k !== "commandId" && k !== "hostId");
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (typeof command.hostId !== "string" || !HOST.test(command.hostId)) throw new DomainError("invalid_command", "hostId: must be a host principal ID (host:name)", { field: "hostId" });
    if (typeof command.commandId !== "string" || command.commandId.length === 0 || command.commandId.length > 120) throw new DomainError("invalid_command", "commandId: is required", { field: "commandId" });
    const hostId = command.hostId;
    if (await this.#deps.hosts.status(this.#deps.principal, hostId) === undefined) throw new DomainError("not_found", `${hostId} is not an enrolled host`);
    const scoped = scopedCommandId(owner.id, command.commandId);
    // The request is recorded first (one command, so a repeat with another host is a conflict and a repeat of the same is the same request).
    await this.#runner.command("host.move-work", { commandId: scoped, actor: owner.id }, async () => ({
      payload: { hostId },
      build: async () => {
        const current = await this.#runner.get(QUIET_HOST_KIND, hostId);
        const at = this.#runner.now();
        const ref = { kind: QUIET_HOST_KIND, id: hostId };
        // Nothing but the time changes in a record that exists: the request is in the audit trail under the owner's name.
        if (current !== undefined) return { ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: current.revision, body: { ...(current.body as unknown as QuietHostBody), updatedAt: at } as unknown as JsonObject }], detail: { hostId } };
        const body: QuietHostBody = { hostId, episode: "owner", quietSince: at, state: "recovered", pending: [], updatedAt: at };
        return { ref, creates: true, changes: [{ type: "create" as const, ref, body: body as unknown as JsonObject }], detail: { hostId } };
      },
    }));
    const attempts = (await this.#liveByHost()).get(hostId) ?? [];
    const moved: { attemptId: string; to: string }[] = [];
    const skipped: { attemptId: string; reason: string }[] = [];
    for (const p of attempts.slice(0, QUIET_HOST_LIMITS.ownerMoves)) {
      const r = await this.#moveOne(p, digest("owner", scoped, hostId), `the owner asked to move the work off ${hostId}`);
      if (r.ok) moved.push({ attemptId: p.attemptId, to: r.to }); else skipped.push({ attemptId: p.attemptId, reason: r.reason });
    }
    await this.#finishPending(hostId, QUIET_HOST_LIMITS.ownerMoves);
    return { hostId, moved, skipped, more: attempts.length > QUIET_HOST_LIMITS.ownerMoves };
  }

  // ---- internals ---------------------------------------------------------------------------------------------------------------

  /** The placements of the work each host holds, by host (bounded). Each attempt is read once from the dispatcher and once for its placement. */
  async #liveByHost(): Promise<Map<string, PlacementBody[]>> {
    const out = new Map<string, PlacementBody[]>();
    for (const { attemptId, state } of (await this.#deps.liveAttempts()).slice(0, QUIET_HOST_LIMITS.liveAttempts)) {
      const p = await this.#deps.remote.placement(this.#deps.principal, attemptId).catch(() => undefined);
      // The work of a host: attempts with a live placement on it, and attempts parked on it (their placement ended with the run, and the dispatcher keeps them for the host).
      if (p === undefined || !(LIVE_STATES.has(p.state) || state === "parked")) continue;
      const list = out.get(p.hostId) ?? [];
      list.push(p);
      out.set(p.hostId, list);
    }
    return out;
  }

  /** Moves one attempt to the first host that may take it (the placement rules decide who may; the host itself is never a target). Records the move before making it. */
  async #moveOne(p: PlacementBody, seed: string, reason: string): Promise<MoveOutcome> {
    const by = this.#deps.principal;
    // An attempt that finished, or that is no longer on this host, since the pass looked is left alone: that is not a host that cannot take it.
    const state = await this.#deps.attemptState(p.attemptId).catch(() => "unknown");
    if (state === undefined || state === "finished") return { ok: false, kind: "changed", reason: "the attempt has already finished" };
    const here = await this.#deps.remote.placement(by, p.attemptId).catch(() => undefined);
    if (here === undefined) return { ok: false, kind: "changed", reason: "the attempt has no remote placement any more" };
    if (here.hostId !== p.hostId) return { ok: false, kind: "changed", reason: `the attempt is already on ${here.hostId}` };
    const found = await this.#deps.remote.candidates(by, { attemptId: p.attemptId, taskId: p.taskId, projectId: p.projectId, agentId: p.agentId, requirements: p.requirements });
    const targets = found.eligible.filter((h) => h !== p.hostId).slice(0, QUIET_HOST_LIMITS.targets);
    if (targets.length === 0) return { ok: false, kind: "no-host", reason: found.waiting ?? "no other allowed host can take it" };
    const commandId = `qhm:${digest(seed, p.attemptId)}`;
    let why = "no other allowed host can take it";
    for (const to of targets) {
      await this.#write(p.hostId, (cur) => {
        const base = cur ?? { hostId: p.hostId, episode: "owner", quietSince: this.#runner.now(), state: "recovered" as const, pending: [], updatedAt: this.#runner.now() };
        const pending = [...base.pending.filter((x) => x.attemptId !== p.attemptId), { attemptId: p.attemptId, to, commandId, at: this.#runner.now() }].slice(-QUIET_HOST_LIMITS.pending);
        return { ...base, pending, updatedAt: this.#runner.now() };
      }, "pending");
      try {
        await this.#deps.remote.relocate(by, { commandId, attemptId: p.attemptId, toHostId: to, reason: reason.slice(0, 300) });
        await this.#drop(p.hostId, p.attemptId);
        return { ok: true, to };
      } catch (error) {
        if (isDomainError(error, "invalid_transition") || isDomainError(error, "fenced") || isDomainError(error, "not_found")) {
          // Nothing moved: the entry goes. A target that was refused is followed by the next one; a placement that changed or an attempt that is over is not a host that cannot take it.
          await this.#drop(p.hostId, p.attemptId);
          const refused: DomainError = error;
          const message = refused.message.slice(0, 300);
          if (refused.code === "fenced") return { ok: false, kind: "changed", reason: `the placement changed while the move was prepared; nothing moved (${message})` };
          if (refused.code === "not_found") return { ok: false, kind: "changed", reason: `the attempt is not there any more (${message})` };
          if (refused.field === "attemptId") return { ok: false, kind: "changed", reason: message };
          why = message;
          continue;
        }
        // Anything else (the store was down, the dispatcher failed after the commit): the entry stays, the next pass repeats the move under the same ID, and this pass goes on with the others.
        return { ok: false, kind: "transient", reason: error instanceof Error ? error.message.slice(0, 300) : "the move failed" };
      }
    }
    return { ok: false, kind: "no-host", reason: why };
  }

  /** Finishes the moves a record still lists, at most `budget` of them: one that stopped half way is finished by repeating it; one that is done, or never happened, is dropped (that costs nothing). Returns how many it worked on. */
  async #finishPending(hostId: string, budget: number): Promise<{ worked: number; done: number }> {
    const rec = await this.#record(hostId);
    if (rec === undefined) return { worked: 0, done: 0 };
    let worked = 0; let done = 0;
    for (const entry of rec.body.pending) {
      const p = await this.#deps.remote.placement(this.#deps.principal, entry.attemptId).catch(() => undefined);
      const stale = Date.parse(this.#runner.now()) - Date.parse(entry.at) > QUIET_HOST_LIMITS.pendingAgeMs;
      const halfway = p !== undefined && LIVE_STATES.has(p.state) && p.hostId === entry.to && p.state === "relocating";
      if (!halfway || stale) { await this.#drop(hostId, entry.attemptId); continue; }
      if (worked >= budget) break;
      worked++;
      try {
        await this.#deps.remote.relocate(this.#deps.principal, { commandId: entry.commandId, attemptId: entry.attemptId, toHostId: entry.to, reason: "finishing a move that was started" });
        await this.#drop(hostId, entry.attemptId);
        done++;
      } catch { /* kept: the next pass tries again, until it is stale */ }
    }
    return { worked, done };
  }

  async #drop(hostId: string, attemptId: string): Promise<void> {
    await this.#write(hostId, (cur) => (cur === undefined || !cur.pending.some((x) => x.attemptId === attemptId) ? undefined : { ...cur, pending: cur.pending.filter((x) => x.attemptId !== attemptId), updatedAt: this.#runner.now() }), "drop");
  }

  /** Deletes the record of a host (a lost race or a record that changed meanwhile leaves it for the next pass). */
  async #delete(hostId: string): Promise<boolean> {
    const found = await this.#record(hostId);
    if (found === undefined) return true;
    if (found.body.state !== "recovered" || found.body.pending.length > 0) return false;
    const ref = { kind: QUIET_HOST_KIND, id: hostId };
    try {
      await this.#runner.command("quiet-host.retire", { commandId: `qh:retire:${hostId}:${randomUUID().slice(0, 16)}`, actor: DISPATCHER_PRINCIPAL }, async () => ({
        payload: { hostId, revision: found.revision },
        build: async () => ({ ref, creates: false, changes: [{ type: "delete" as const, ref, expectedRevision: found.revision }], detail: { hostId } }),
      }));
      return true;
    } catch (error) {
      if (isDomainError(error, "stale_revision") || isDomainError(error, "command_conflict") || isDomainError(error, "not_found")) return false;
      throw error;
    }
  }

  /** Remembers which host the pass reached, so the next one goes on from there (empty: it reached the end). Written only when it changes. */
  async #setCursor(after: string, stored: string): Promise<void> {
    if (after === stored) return;
    const ref = { kind: CURSOR_KIND, id: "main" };
    const found = await this.#runner.get(CURSOR_KIND, "main");
    const body = { after, updatedAt: this.#runner.now() };
    const change = found === undefined ? { type: "create" as const, ref, body: body as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: found.revision, body: body as unknown as JsonObject };
    try {
      await this.#runner.command("quiet-host.cursor", { commandId: `qh:cursor:${randomUUID().slice(0, 16)}`, actor: DISPATCHER_PRINCIPAL }, async () => ({ payload: { after }, build: async () => ({ ref, creates: found === undefined, changes: [change], detail: { after } }) }));
    } catch (error) {
      if (!(isDomainError(error, "stale_revision") || isDomainError(error, "command_conflict"))) throw error;
    }
  }

  async #record(hostId: string): Promise<{ body: QuietHostBody; revision: number } | undefined> {
    const found = await this.#runner.get(QUIET_HOST_KIND, hostId);
    return found === undefined ? undefined : { body: normal(found.body), revision: found.revision };
  }

  async #records(): Promise<{ body: QuietHostBody; revision: number }[]> {
    const out: { body: QuietHostBody; revision: number }[] = [];
    for (let after: string | undefined; out.length < QUIET_HOST_LIMITS.records;) {
      const page = await this.#runner.list(QUIET_HOST_KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const f of page) { after = f.id; out.push({ body: normal(f.body), revision: f.revision }); }
      if (page.length < 100) break;
    }
    return out.slice(0, QUIET_HOST_LIMITS.records);
  }

  /** Rewrites a host's record from what is there now (a lost race reads again). `decide` returns the new body, or undefined for "nothing to do". Returns the body that stands afterwards. */
  async #write(hostId: string, decide: (current: QuietHostBody | undefined) => QuietHostBody | undefined, label: string): Promise<QuietHostBody | undefined> {
    for (let tries = 0; tries < 6; tries++) {
      const found = await this.#record(hostId);
      const next = decide(found?.body);
      if (next === undefined) return found?.body;
      const ref = { kind: QUIET_HOST_KIND, id: hostId };
      const change = found === undefined ? { type: "create" as const, ref, body: next as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: found.revision, body: next as unknown as JsonObject };
      try {
        await this.#runner.command(`quiet-host.${label}`, { commandId: `qh:${label}:${hostId}:${randomUUID().slice(0, 16)}`, actor: DISPATCHER_PRINCIPAL }, async () => ({
          payload: { hostId, revision: found?.revision ?? 0 },
          build: async () => ({ ref, creates: found === undefined, changes: [change], detail: { hostId, state: next.state, pending: next.pending.length } }),
        }));
        return next;
      } catch (error) {
        if (!(isDomainError(error, "stale_revision") || isDomainError(error, "command_conflict"))) throw error;
      }
    }
    return (await this.#record(hostId))?.body;
  }
}

/** A stored record as the pass reads it: the list of moves under way is always a list. */
function normal(body: unknown): QuietHostBody {
  const b = body as QuietHostBody;
  return Array.isArray(b.pending) ? b : { ...b, pending: [] };
}

import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import type { HoldsUp } from "../critical/critical-path.js";
import type { Principal } from "../security/index.js";
import {
  DEFAULT_BACKUP_MAX_AGE_HOURS, DEFAULT_CRITICAL_BLOCKED_AFTER_MINUTES, DEFAULT_DENIED_ALERTS_PER_HOUR, DEFAULT_DENIED_WINDOW_MINUTES, DEFAULT_HOST_DOWN_AFTER_MINUTES, DEFAULT_SECURITY_REPORTS_PER_HOUR, DEFAULT_STOPPED_WORK_AFTER_MINUTES, DEFAULT_SWEEP_SECONDS, type NotificationService,
} from "./notifications.js";

/** What the watch needs from the backup service (card K01): the newest good backup by the scheduler's own rule, the folder being unreadable, and the last failed run. */
export interface BackupSource { lastGood(): Promise<{ readonly at?: string; readonly unreadable?: boolean; readonly lastError?: { readonly at: string; readonly message: string } }> }
/** What the watch needs from the host service (card H01): one page of host statuses, read as the dispatcher. */
export interface HostSource {
  list(by: Principal, page: { afterId?: string; limit?: number }): Promise<{ readonly items: readonly { readonly hostId: string; readonly identity: "active" | "revoked"; readonly freshness: "fresh" | "stale" | "unknown"; readonly lastSeenAt?: string }[]; readonly next?: string }>;
}

/**
 * What the stopped-work trigger needs to know about a project (card U11d, H12's view of available work): whether it has nothing else to do. `true`: no task of the project can go on; `false`: some can;
 * `undefined`: not known (too much to read, a failing read), which decides nothing. Reads only; never throws on purpose.
 */
export interface WorkSource { idle(projectId: string): Promise<boolean | undefined> }

/** What the critical-path trigger needs (card U11d, "U11f"): the owner's marks turned into "does this task hold up the path" for one pass (`CriticalPathService.holdsUp`); `undefined`: nothing is marked. A throw means "not known" and decides nothing. */
export interface CriticalSource { holdsUp(): Promise<HoldsUp | undefined> }

export interface UrgentWatchOptions {
  readonly notifications: NotificationService;
  readonly work?: WorkSource;
  readonly critical?: CriticalSource;
  readonly backups?: BackupSource;
  readonly hosts?: HostSource;
  /** Test clock; the production clock is the system's. */
  readonly clock?: () => string;
  /** The longest one read from the backup folder or the host list may take before that check is given up for this sweep (default 20 seconds). */
  readonly stepTimeoutMs?: number;
}

/** Bounds: hosts examined per sweep (the rest on the next sweeps, from a cursor), hosts remembered in one pass, agents whose denials are counted at once. */
export const URGENT_LIMITS = { hostsPerSweep: 100, hostsPerCycle: 20_000, agentsCounted: 1000, securityKinds: 8, reportersCounted: 1000, securityKeyChars: 200, waitingPerSweep: 100, raisesPerSweep: 20, projectsCounted: 1000 } as const;

export type SecurityEvent = "sandbox-escape-attempt" | "credential-misused" | "protected-path-touched" | "integrity-check-failed";
const SECURITY_TEXT: Readonly<Record<SecurityEvent, string>> = {
  "sandbox-escape-attempt": "A sandbox escape was attempted", "credential-misused": "A credential was used from the wrong task or host",
  "protected-path-touched": "A protected path (.git or the loader configuration) was touched", "integrity-check-failed": "An integrity check failed",
};
const SAFE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const hash = (v: string): string => createHash("sha256").update(v).digest("hex").slice(0, 24);
const code = (v: string): string => (SAFE.test(v) ? v : hash(v));
const HOUR = 3_600_000;
const PROJECT_ID = /^proj-[a-z2-7]{20}$/;

/** Gives up on a read that hangs (a folder on a network share): the check is skipped this sweep and tried again on the next. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms); });
  work.catch(() => undefined);
  try { return await Promise.race([work, late]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * The controller's own Urgent triggers (card U11c). Each raises one Urgent item through `emitFromController` with `interrupt`, which is sent at once on the configured channel, also in quiet hours
 * (unless the owner turned that off), and only the controller can do it. The notification service keeps these to the owner's hourly Urgent limit (with one "N more" summary) and a minimum gap per
 * record, so a flapping host or a burst of failures does not flood the owner; an item that is held back stays in the inbox, Urgent.
 *
 * Triggers built here: no good backup within the owner's limit (default 48 hours, `backupMaxAgeHours`), an enrolled host silent for longer than `hostDownAfterMinutes` (default 10), repeated policy
 * denials of one agent over `deniedThreshold` within `deniedWindowMinutes` (off until the owner sets a number; at most `deniedAlertsPerHour` agents page in an hour), and the security events a caller
 * reports through `reportSecurity`. A condition that has cleared (a backup made, a host heard from again, the host gone) closes its item (de-escalation); turning a trigger off with `null` closes its
 * open item too. What is open is read from the notification state, so a restart forgets nothing; when "no backup" was first seen is kept there as well. Denial counts are in memory: a restart starts
 * them again. The text sent outside is built here and holds no payload: names and counts only.
 */
export class UrgentWatch {
  readonly #n: NotificationService;
  readonly #o: UrgentWatchOptions;
  readonly #denials = new Map<string, { times: number[]; total: number; raised: boolean; capped: boolean }>();
  readonly #alerts: number[] = [];
  readonly #reports = new Map<string, number[]>();
  #nextSweepAt = 0;
  #seq = 0;
  #hostCursor: string | undefined;
  #hostsSeen = new Set<string>();
  #hostsSeenFull = false;
  #stopCursor: string | undefined;
  #critCursor: string | undefined;
  /** When each waiting item was first seen holding up the critical path, and when an item the watch raised was first seen not doing so (hysteresis). Memory only: a restart delays a page or a put-back, it never fires early. */
  readonly #critSince = new Map<string, number>();
  readonly #critClear = new Map<string, number>();
  /** When each project was first seen with nothing to do (this episode); a project that is seen with work is forgotten. Memory only: a restart starts the count again, which only delays a page. */
  readonly #idleSince = new Map<string, number>();

  constructor(options: UrgentWatchOptions) {
    this.#n = options.notifications; this.#o = options;
  }

  /** A command ID that is new for every raise or close (an episode of the same condition must not replay the earlier one). */
  #id(prefix: string): string { return `${prefix}:${this.#now()}:${this.#seq++}`; }

  #now(): string { return this.#o?.clock?.() ?? new Date().toISOString(); }
  get #stepMs(): number { return this.#o.stepTimeoutMs ?? 20_000; }

  /**
   * One pass over the backup and host conditions. Each check stands alone: one failing does not stop the other, and one host failing does not hide the hosts after it; the first failure is raised after
   * all ran. With `throttled` (the dispatcher's call) the pass runs at most every `sweepEverySeconds` (the owner's setting, default 60).
   */
  async sweep(by: Principal, options: { readonly throttled?: boolean } = {}): Promise<{ raised: string[]; cleared: string[] }> {
    const settings = await this.#n.controllerSettings();
    const raised: string[] = []; const cleared: string[] = [];
    const nowMs = Date.parse(this.#now());
    if (options.throttled === true && nowMs < this.#nextSweepAt) return { raised, cleared };
    this.#nextSweepAt = nowMs + (settings.sweepEverySeconds ?? DEFAULT_SWEEP_SECONDS) * 1000;
    let failure: unknown;
    try { if (this.#o.backups !== undefined) await this.#backupCheck(settings, raised, cleared); } catch (error) { failure ??= error; }
    try { if (this.#o.hosts !== undefined) failure ??= await this.#hostCheck(by, settings, raised, cleared); } catch (error) { failure ??= error; }
    try { if (this.#o.critical !== undefined) await this.#criticalCheck(settings, raised, cleared); } catch (error) { failure ??= error; }
    try { if (this.#o.work !== undefined) await this.#stoppedCheck(settings, raised, cleared); } catch (error) { failure ??= error; }
    if (failure !== undefined) { this.#nextSweepAt = 0; throw failure; }
    return { raised, cleared };
  }

  /**
   * Stopped work (card U11d): a decision that waits on the owner (a blocker, a review, a question) while its project has nothing else to do is raised to Urgent with its reason, once per episode, after the
   * owner's `stoppedWorkAfterMinutes` (default 30, `null` off). The wait is measured from the later of the item's creation and the first sweep that saw the project idle, so a project that has only just run dry
   * is not paged. When work has resumed (or the trigger was turned off) the item is put back to Needs you and nothing is sent. The messages are an Urgent trigger like the U11c ones: inside the hourly
   * Urgent limit and the gap per record, and only the item's label (IDs), the kind and the project's ID leave. Bounded: `waitingPerSweep` items from a cursor, `raisesPerSweep` raises, one read of work per
   * project per sweep. A project whose work cannot be read decides nothing. One item failing does not stop the rest; the first failure is raised after the others were tried.
   */
  async #stoppedCheck(settings: Awaited<ReturnType<NotificationService["controllerSettings"]>>, raised: string[], cleared: string[]): Promise<void> {
    const limitM = settings.stoppedWorkAfterMinutes === undefined ? DEFAULT_STOPPED_WORK_AFTER_MINUTES : settings.stoppedWorkAfterMinutes;
    const nowMs = Date.parse(this.#now());
    const page = await this.#n.waitingOnOwner({ ...(this.#stopCursor === undefined ? {} : { after: this.#stopCursor }), limit: URGENT_LIMITS.waitingPerSweep });
    this.#stopCursor = page.next;
    const idle = new Map<string, boolean | undefined>();
    let failure: unknown; let made = 0;
    for (const item of page.items) {
      try {
        // An item the critical-path watch raised is that watch's to put back.
        if (item.critical) continue;
        if (limitM === null) {
          // Turned off: what it raised is put back.
          if (item.stopped && (await this.#n.lowerStopped(item.id))) cleared.push(`work:${item.id}`);
          continue;
        }
        if (!idle.has(item.projectId)) {
          let v: boolean | undefined;
          try { v = await within(this.#o.work!.idle(item.projectId), this.#stepMs, "reading the project's work"); } catch { v = undefined; }
          idle.set(item.projectId, v);
          if (v === false) this.#idleSince.delete(item.projectId);
          else if (v === true && !this.#idleSince.has(item.projectId)) {
            this.#idleSince.set(item.projectId, nowMs);
            while (this.#idleSince.size > URGENT_LIMITS.projectsCounted) this.#idleSince.delete(this.#idleSince.keys().next().value as string);
          }
        }
        const v = idle.get(item.projectId);
        if (v === undefined) continue;
        if (!v) { if (item.stopped && (await this.#n.lowerStopped(item.id))) cleared.push(`work:${item.id}`); continue; }
        if (item.stopped || made >= URGENT_LIMITS.raisesPerSweep) continue;
        const since = Math.max(Date.parse(item.firstAt), this.#idleSince.get(item.projectId) ?? nowMs);
        if (!Number.isFinite(since) || nowMs - since < limitM * 60_000) continue;
        if (await this.#n.raiseStopped(item.id, { minutes: Math.floor((nowMs - since) / 60_000), limit: limitM })) { made++; raised.push(`work:${item.id}`); }
      } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }

  /**
   * The critical path (card U11d, "U11f"): a decision that waits on the owner (a blocker, a review, a question) and holds up a task on the critical path the owner marked is raised to Urgent with its reason, after the
   * owner's `criticalBlockedAfterMinutes` (default 5, `null` off), and put back to Needs you, silently, once it has stopped doing so for the same number of minutes (hysteresis: a mark taken off and put back, or a
   * blocker that flickers, does not page twice). What is critical comes from the owner's marks and the dependency records alone; the item's text is never read. The message is an Urgent trigger like the U11c ones: inside
   * the hourly Urgent limit, and counted per PROJECT (`critical|<project>`) for the gap, so many decisions in one project are one page per gap. Bounded like the stopped-work check: `waitingPerSweep` items from a cursor,
   * `raisesPerSweep` raises, the marks and each task read once per pass. A pass that cannot read the marks decides nothing.
   */
  async #criticalCheck(settings: Awaited<ReturnType<NotificationService["controllerSettings"]>>, raised: string[], cleared: string[]): Promise<void> {
    const limitM = settings.criticalBlockedAfterMinutes === undefined ? DEFAULT_CRITICAL_BLOCKED_AFTER_MINUTES : settings.criticalBlockedAfterMinutes;
    const nowMs = Date.parse(this.#now());
    const page = await this.#n.waitingOnOwner({ ...(this.#critCursor === undefined ? {} : { after: this.#critCursor }), limit: URGENT_LIMITS.waitingPerSweep, withTask: true });
    this.#critCursor = page.next;
    let holds: HoldsUp | undefined;
    if (limitM !== null && page.items.length > 0) {
      try { holds = await within(this.#o.critical!.holdsUp(), this.#stepMs, "reading the critical path"); } catch { return; }
    }
    let failure: unknown; let made = 0;
    for (const item of page.items) {
      try {
        if (item.stopped) continue;
        if (limitM === null) {
          // Turned off: what it raised is put back.
          if (item.critical && (await this.#n.lowerCritical(item.id))) cleared.push(`critical:${item.id}`);
          this.#critSince.delete(item.id); this.#critClear.delete(item.id);
          continue;
        }
        let blocks = false;
        if (holds !== undefined && item.taskId !== undefined) { try { blocks = await within(holds(item.taskId), this.#stepMs, "reading the critical path"); } catch { continue; } }
        if (blocks) {
          this.#critClear.delete(item.id);
          if (item.critical) continue;
          if (!this.#critSince.has(item.id)) { this.#critSince.set(item.id, nowMs); this.#trim(this.#critSince); }
          if (made >= URGENT_LIMITS.raisesPerSweep) continue;
          const since = Math.max(Date.parse(item.firstAt), this.#critSince.get(item.id)!);
          if (!Number.isFinite(since) || nowMs - since < limitM * 60_000) continue;
          if (await this.#n.raiseCritical(item.id, { minutes: Math.floor((nowMs - since) / 60_000), limit: limitM })) { made++; raised.push(`critical:${item.id}`); this.#critSince.delete(item.id); }
        } else {
          this.#critSince.delete(item.id);
          if (!item.critical) continue;
          if (!this.#critClear.has(item.id)) { this.#critClear.set(item.id, nowMs); this.#trim(this.#critClear); }
          if (nowMs - this.#critClear.get(item.id)! < limitM * 60_000) continue;
          if (await this.#n.lowerCritical(item.id)) cleared.push(`critical:${item.id}`);
          this.#critClear.delete(item.id);
        }
      } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }

  #trim(map: Map<string, number>): void { while (map.size > URGENT_LIMITS.projectsCounted) map.delete(map.keys().next().value as string); }

  async #backupCheck(settings: Awaited<ReturnType<NotificationService["controllerSettings"]>>, raised: string[], cleared: string[]): Promise<void> {
    const limitH = settings.backupMaxAgeHours === undefined ? DEFAULT_BACKUP_MAX_AGE_HOURS : settings.backupMaxAgeHours;
    const ref = { kind: "backup", id: "installation" };
    const now = this.#now(); const nowMs = Date.parse(now);
    const good = await within(this.#o.backups!.lastGood(), this.#stepMs, "reading the backups");
    // A folder that cannot be read says nothing about the backups: nothing is raised or closed on it.
    if (good.unreadable === true) return;
    const at = good.at === undefined ? Number.NaN : Date.parse(good.at);
    const usable = Number.isFinite(at) && at <= nowMs; // a missing, unreadable or future time is not a backup
    const remembered = (await this.#n.watchMemory()).noBackupSince;
    let since: string;
    if (usable) { since = good.at!; if (remembered !== undefined) await this.#n.remember("noBackupSince", null); }
    else {
      // With no good backup the clock starts when it was first seen, and that is kept, so restarts do not give the controller a fresh 48 hours each time.
      since = remembered !== undefined && Number.isFinite(Date.parse(remembered)) && Date.parse(remembered) <= nowMs ? remembered : now;
      if (since !== remembered) await this.#n.remember("noBackupSince", since);
    }
    const age = nowMs - Date.parse(since);
    const open = (await this.#n.openRefIds(ref.kind)).includes(ref.id);
    if (limitH !== null && age > limitH * HOUR) {
      if (open) return;
      const hours = Math.floor(age / HOUR);
      const failed = good.lastError === undefined ? "" : " (the last backup run failed)";
      const why = usable ? `The last good backup is ${hours} hours old (limit ${limitH}).` : `No good backup has been seen for ${hours} hours (limit ${limitH}).`;
      const error = good.lastError === undefined ? "" : ` The last run failed: ${good.lastError.message.slice(0, 60)}`;
      await this.#n.emitFromController({ commandId: this.#id(`urg-backup:${since}`), kind: "maintenance", interrupt: true, ref, label: `Urgent: no good backup for ${hours} hours${failed}`, detail: `${why}${error}`.slice(0, 190) });
      raised.push("backup");
    } else if (open) {
      // Within the limit, or the owner turned the trigger off: the condition is over.
      const r = await this.#n.settleFromController({ commandId: this.#id("urg-backup-ok"), kind: "maintenance", ref });
      if (r.closed) cleared.push("backup");
    }
  }

  async #hostCheck(by: Principal, settings: Awaited<ReturnType<NotificationService["controllerSettings"]>>, raised: string[], cleared: string[]): Promise<unknown> {
    const limitM = settings.hostDownAfterMinutes === undefined ? DEFAULT_HOST_DOWN_AFTER_MINUTES : settings.hostDownAfterMinutes;
    const now = this.#now(); const nowMs = Date.parse(now);
    const open = new Set(await this.#n.openRefIds("host-record"));
    const page = await within(this.#o.hosts!.list(by, { ...(this.#hostCursor === undefined ? {} : { afterId: this.#hostCursor }), limit: URGENT_LIMITS.hostsPerSweep }), this.#stepMs, "listing the hosts");
    let failure: unknown;
    for (const h of page.items) {
      try {
        const id = code(h.hostId.replace(/^host:/, ""));
        if (this.#hostsSeen.size < URGENT_LIMITS.hostsPerCycle) this.#hostsSeen.add(id); else this.#hostsSeenFull = true;
        const ref = { kind: "host-record", id };
        const silent = h.lastSeenAt === undefined ? 0 : nowMs - Date.parse(h.lastSeenAt);
        const down = limitM !== null && h.identity === "active" && h.freshness === "stale" && Number.isFinite(silent) && silent >= limitM * 60_000;
        if (down) {
          if (open.has(id)) continue;
          await this.#n.emitFromController({ commandId: this.#id(`urg-host:${h.hostId}`), kind: "maintenance", interrupt: true, ref, label: `Urgent: host ${id} has been silent for ${Math.floor(silent / 60_000)} minutes`, detail: `Host ${id} has not been heard from for ${Math.floor(silent / 60_000)} minutes (limit ${limitM}).` });
          raised.push(`host:${h.hostId}`);
        } else if (open.has(id)) {
          const r = await this.#n.settleFromController({ commandId: this.#id(`urg-host-ok:${h.hostId}`), kind: "maintenance", ref });
          if (r.closed) cleared.push(`host:${h.hostId}`);
        }
      } catch (error) { failure ??= error; }
    }
    if (page.next !== undefined) { this.#hostCursor = page.next; return failure; }
    // A whole pass is done: an item for a host the pass did not meet is for a host that is gone, and is closed.
    this.#hostCursor = undefined;
    const seen = this.#hostsSeen; const complete = !this.#hostsSeenFull;
    this.#hostsSeen = new Set(); this.#hostsSeenFull = false;
    if (complete) {
      for (const id of open) {
        if (seen.has(id)) continue;
        try {
          const r = await this.#n.settleFromController({ commandId: this.#id(`urg-host-gone:${id}`), kind: "maintenance", ref: { kind: "host-record", id } });
          if (r.closed) cleared.push(`host:${id}`);
        } catch (error) { failure ??= error; }
      }
    }
    return failure;
  }

  /**
   * One policy denial of an agent. Counted per agent over the owner's window; the denial that reaches the owner's threshold raises one Urgent item for that agent, later ones in the same run of denials
   * only add to its count (no second page). When the denials stop for a whole window and a new run reaches the threshold while the earlier item is still open, that item is closed and a new one raised,
   * so the second burst is seen. At most `deniedAlertsPerHour` agents page in an hour (the owner's setting, default 5, `null` off): beyond it the item is raised in the inbox without a page.
   * One denial is routine and never Urgent. With no threshold set nothing is counted. Never throws on a notification failure: a refused tool call must not fail because the owner could not be told.
   */
  async reportDenial(agentId: string, projectId?: string): Promise<{ raised: boolean }> {
    try {
      const settings = await this.#n.controllerSettings();
      const threshold = settings.deniedThreshold;
      if (threshold === undefined || threshold === null) return { raised: false };
      const window = (settings.deniedWindowMinutes ?? DEFAULT_DENIED_WINDOW_MINUTES) * 60_000;
      const nowMs = Date.parse(this.#now());
      const prior = this.#denials.get(agentId);
      const kept = (prior?.times ?? []).filter((t) => nowMs - t < window);
      const state = kept.length === 0 || prior === undefined ? { times: kept, total: 0, raised: false, capped: false } : prior;
      kept.push(nowMs);
      if (kept.length > threshold + 1) kept.splice(0, kept.length - (threshold + 1));
      state.times = kept; state.total += 1;
      this.#denials.delete(agentId); this.#denials.set(agentId, state);
      // Bounded memory: the agent that was quiet longest is forgotten first.
      while (this.#denials.size > URGENT_LIMITS.agentsCounted) this.#denials.delete(this.#denials.keys().next().value as string);
      if (state.total < threshold) return { raised: false };
      const name = code(agentId.replace(/^agent:/, ""));
      const ref = { kind: "agent", id: name };
      const project = projectId === undefined ? {} : { projectId };
      const label = (n: number): string => `Urgent: agent ${name} was refused ${n} times`;
      const detail = `Agent ${name} was refused ${state.total} times within ${Math.round(window / 60_000)} minutes (threshold ${threshold}).`;
      if (state.raised) {
        // The same run of denials: the item's count and text move on, nobody is paged again.
        await this.#n.emitFromController({ commandId: `urg-deny:${agentId}:${kept[0]}:${state.total}`, kind: "maintenance", ...(state.capped ? {} : { interrupt: true }), label: label(state.total), ref, ...project, detail });
        return { raised: false };
      }
      // A new run of denials. An item still open from the earlier run is closed first, so this one is a new item that is told.
      await this.#n.settleFromController({ commandId: this.#id(`urg-deny-reopen:${agentId}`), kind: "maintenance", ref, ...project });
      const hourAgo = nowMs - HOUR;
      while (this.#alerts.length > 0 && this.#alerts[0]! < hourAgo) this.#alerts.shift();
      const cap = settings.deniedAlertsPerHour === undefined ? DEFAULT_DENIED_ALERTS_PER_HOUR : settings.deniedAlertsPerHour;
      state.capped = cap !== null && this.#alerts.length >= cap;
      await this.#n.emitFromController({ commandId: this.#id(`urg-deny:${agentId}`), kind: "maintenance", ...(state.capped ? {} : { interrupt: true }), label: label(state.total), ref, ...project, detail });
      state.raised = true;
      if (!state.capped) this.#alerts.push(nowMs);
      return { raised: true };
    } catch { return { raised: false }; }
  }

  /** A security event another service detected (a sandbox escape attempt, a credential used from the wrong task or host, a protected path touched, a failed integrity check): always Urgent, once per `key`, an item of its own per key. */
  async reportSecurity(event: { readonly kind: SecurityEvent; readonly key: string; readonly projectId?: string }): Promise<{ itemId: string }> {
    if (!Object.hasOwn(SECURITY_TEXT, event.kind)) throw new Error(`unknown security event ${String(event.kind)}`);
    // The controller's own events are hashed apart from a reporter's (whose hash holds a principal ID); the command ID is that hash, so a long key fits.
    const id = hash(`controller|${event.kind}|${event.key}`);
    const r = await this.#n.emitFromController({ commandId: `urg-sec:${id}`, kind: "maintenance", interrupt: true, label: `Urgent: ${SECURITY_TEXT[event.kind]}`.slice(0, 200), ref: { kind: "security", id }, ...(event.projectId === undefined ? {} : { projectId: event.projectId }), detail: `${SECURITY_TEXT[event.kind]}.` });
    return { itemId: r.itemId };
  }
  /**
   * A security event reported by another service over the API (card U11c): only a host or a service (not an agent, not a task credential) may report. The event is the reporter's own: its
   * key is taken together with the reporter's ID, so one reporter can neither mute nor fake another's event, and the same key from the same reporter is the same event (told once). Each reporter
   * may raise `securityReportsPerHour` separate items an hour (the owner's setting, default 20, `null` off); the rest of its burst goes into ONE collected item for that reporter (Needs you, not
   * paged, its count rising), so a reporter that is wrong or compromised cannot fill the inbox. The kind is checked and the key is bounded; only the kind, a hash of the key and the reporter's name leave.
   */
  async reportSecurityFrom(by: Principal, event: { readonly kind: string; readonly key: string; readonly projectId?: string }): Promise<{ itemId: string; held: boolean }> {
    if (by.kind !== "host" && by.kind !== "service") throw new DomainError("forbidden", "only a host or a service reports security events");
    // An own key of the table only: `toString` or `constructor` is not a kind.
    if (typeof event.kind !== "string" || !Object.hasOwn(SECURITY_TEXT, event.kind)) throw new DomainError("invalid_command", `kind: must be one of ${Object.keys(SECURITY_TEXT).join(", ")}`);
    if (typeof event.key !== "string" || event.key.length === 0 || event.key.length > URGENT_LIMITS.securityKeyChars) throw new DomainError("invalid_command", `key: must be 1 to ${URGENT_LIMITS.securityKeyChars} characters`);
    if (event.projectId !== undefined && (typeof event.projectId !== "string" || !PROJECT_ID.test(event.projectId))) throw new DomainError("invalid_command", "projectId: must be a project ID");
    const kind = event.kind as SecurityEvent;
    const settings = await this.#n.controllerSettings();
    const cap = settings.securityReportsPerHour === undefined ? DEFAULT_SECURITY_REPORTS_PER_HOUR : settings.securityReportsPerHour;
    const nowMs = Date.parse(this.#now());
    const times = (this.#reports.get(by.id) ?? []).filter((t) => nowMs - t < HOUR);
    const project = event.projectId === undefined ? {} : { projectId: event.projectId };
    const name = code(by.id.replace(/^(host|service):/, ""));
    // The event is the reporter's own (its ID is in the hash; principal IDs and project IDs hold no "|", the key comes last). The command ID is the hash too: a fixed length, and the key is not kept.
    const ref = hash(`${kind}|${by.id}|${event.projectId ?? "-"}|${event.key}`);
    // The same event again is not a new report: it replays its own item and costs no allowance.
    const known = (await this.#n.openRefIds("security")).includes(ref);
    if (cap !== null && times.length >= cap && !known) {
      const bucket = hash(`over|${by.id}`);
      const r = await this.#n.emitFromController({ commandId: this.#id(`urg-secover:${bucket}`), kind: "maintenance", level: "needs-you", ref: { kind: "security", id: bucket }, label: `Security reports from ${name} are held: more than ${cap} in an hour`, detail: `Host or service ${name} sent more than ${cap} security reports in an hour; the rest are not raised one by one. Look at the reporter.` });
      return { itemId: r.itemId, held: true };
    }
    let itemId: string;
    try {
      itemId = (await this.#n.emitFromController({ commandId: `urg-sec:${ref}`, kind: "maintenance", interrupt: true, label: `Urgent: ${SECURITY_TEXT[kind]} (reported by ${name})`.slice(0, 200), ref: { kind: "security", id: ref }, ...project, detail: `${SECURITY_TEXT[kind]}; reported by ${name}.` })).itemId;
    } catch (error) {
      // Reported before and already closed by the owner: told once, so it is answered with its first item and not raised again.
      if (error instanceof DomainError && error.code === "command_conflict") return { itemId: derivedId("ntf", `maintenance|${event.projectId ?? "-"}|security:${ref}|0`), held: false };
      throw error;
    }
    if (!known) times.push(nowMs);
    this.#reports.delete(by.id); this.#reports.set(by.id, times);
    while (this.#reports.size > URGENT_LIMITS.reportersCounted) this.#reports.delete(this.#reports.keys().next().value as string);
    return { itemId, held: false };
  }
}

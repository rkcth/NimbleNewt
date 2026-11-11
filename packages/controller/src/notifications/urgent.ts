import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/index.js";
import {
  DEFAULT_BACKUP_MAX_AGE_HOURS, DEFAULT_DENIED_ALERTS_PER_HOUR, DEFAULT_DENIED_WINDOW_MINUTES, DEFAULT_HOST_DOWN_AFTER_MINUTES, DEFAULT_SECURITY_REPORTS_PER_HOUR, DEFAULT_SWEEP_SECONDS, type NotificationService,
} from "./notifications.js";

/** What the watch needs from the backup service (card K01): the newest good backup by the scheduler's own rule, the folder being unreadable, and the last failed run. */
export interface BackupSource { lastGood(): Promise<{ readonly at?: string; readonly unreadable?: boolean; readonly lastError?: { readonly at: string; readonly message: string } }> }
/** What the watch needs from the host service (card H01): one page of host statuses, read as the dispatcher. */
export interface HostSource {
  list(by: Principal, page: { afterId?: string; limit?: number }): Promise<{ readonly items: readonly { readonly hostId: string; readonly identity: "active" | "revoked"; readonly freshness: "fresh" | "stale" | "unknown"; readonly lastSeenAt?: string }[]; readonly next?: string }>;
}

export interface UrgentWatchOptions {
  readonly notifications: NotificationService;
  readonly backups?: BackupSource;
  readonly hosts?: HostSource;
  /** Test clock; the production clock is the system's. */
  readonly clock?: () => string;
  /** The longest one read from the backup folder or the host list may take before that check is given up for this sweep (default 20 seconds). */
  readonly stepTimeoutMs?: number;
}

/** Bounds: hosts examined per sweep (the rest on the next sweeps, from a cursor), hosts remembered in one pass, agents whose denials are counted at once. */
export const URGENT_LIMITS = { hostsPerSweep: 100, hostsPerCycle: 20_000, agentsCounted: 1000, securityKinds: 8, reportersCounted: 1000, securityKeyChars: 200 } as const;

export type SecurityEvent = "sandbox-escape-attempt" | "credential-misused" | "protected-path-touched" | "integrity-check-failed";
const SECURITY_TEXT: Readonly<Record<SecurityEvent, string>> = {
  "sandbox-escape-attempt": "A sandbox escape was attempted", "credential-misused": "A credential was used from the wrong task or host",
  "protected-path-touched": "A protected path (.git or the loader configuration) was touched", "integrity-check-failed": "An integrity check failed",
};
const SAFE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const hash = (v: string): string => createHash("sha256").update(v).digest("hex").slice(0, 24);
const code = (v: string): string => (SAFE.test(v) ? v : hash(v));
const HOUR = 3_600_000;

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
    if (failure !== undefined) { this.#nextSweepAt = 0; throw failure; }
    return { raised, cleared };
  }

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
    if (!(event.kind in SECURITY_TEXT)) throw new Error(`unknown security event ${String(event.kind)}`);
    const r = await this.#n.emitFromController({ commandId: `urg-sec:${event.kind}:${event.key}`, kind: "maintenance", interrupt: true, label: `Urgent: ${SECURITY_TEXT[event.kind]}`.slice(0, 200), ref: { kind: "security", id: hash(`${event.kind}|${event.key}`) }, ...(event.projectId === undefined ? {} : { projectId: event.projectId }), detail: `${SECURITY_TEXT[event.kind]}.` });
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
    if (!(event.kind in SECURITY_TEXT)) throw new DomainError("invalid_command", `kind: must be one of ${Object.keys(SECURITY_TEXT).join(", ")}`);
    if (typeof event.key !== "string" || event.key.length === 0 || event.key.length > URGENT_LIMITS.securityKeyChars) throw new DomainError("invalid_command", `key: must be 1 to ${URGENT_LIMITS.securityKeyChars} characters`);
    if (event.projectId !== undefined && (typeof event.projectId !== "string" || event.projectId.length === 0 || event.projectId.length > 100)) throw new DomainError("invalid_command", "projectId: must be a project ID");
    const settings = await this.#n.controllerSettings();
    const cap = settings.securityReportsPerHour === undefined ? DEFAULT_SECURITY_REPORTS_PER_HOUR : settings.securityReportsPerHour;
    const nowMs = Date.parse(this.#now());
    const times = (this.#reports.get(by.id) ?? []).filter((t) => nowMs - t < HOUR);
    const key = `${by.id}|${event.key}`;
    const project = event.projectId === undefined ? {} : { projectId: event.projectId };
    const name = code(by.id.replace(/^(host|service):/, ""));
    // The same event again is not a new report: it replays its own item and costs no allowance.
    const known = await this.#n.openRefIds("security");
    const ref = hash(`${event.kind}|${key}`);
    if (cap !== null && times.length >= cap && !known.includes(ref)) {
      const bucket = hash(`over|${by.id}`);
      const r = await this.#n.emitFromController({ commandId: this.#id(`urg-secover:${bucket}`), kind: "maintenance", level: "needs-you", ref: { kind: "security", id: bucket }, label: `Security reports from ${name} are held: more than ${cap} in an hour`, detail: `Host or service ${name} sent more than ${cap} security reports in an hour; the rest are not raised one by one. Look at the reporter.` });
      return { itemId: r.itemId, held: true };
    }
    if (!known.includes(ref)) times.push(nowMs);
    this.#reports.delete(by.id); this.#reports.set(by.id, times);
    while (this.#reports.size > URGENT_LIMITS.reportersCounted) this.#reports.delete(this.#reports.keys().next().value as string);
    const r = await this.#n.emitFromController({ commandId: `urg-sec:${event.kind}:${key}`, kind: "maintenance", interrupt: true, label: `Urgent: ${SECURITY_TEXT[event.kind as SecurityEvent]} (reported by ${name})`.slice(0, 200), ref: { kind: "security", id: ref }, ...project, detail: `${SECURITY_TEXT[event.kind as SecurityEvent]}; reported by ${name}.` });
    return { itemId: r.itemId, held: false };
  }
}

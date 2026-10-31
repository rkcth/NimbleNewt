import { createHash } from "node:crypto";
import type { Principal } from "../security/index.js";
import {
  DEFAULT_BACKUP_MAX_AGE_HOURS, DEFAULT_DENIED_WINDOW_MINUTES, DEFAULT_HOST_DOWN_AFTER_MINUTES, type NotificationService,
} from "./notifications.js";

/** What the watch needs from the backup service (card K01): the newest backup it can list. */
export interface BackupSource { status(): Promise<{ readonly newest?: { readonly createdAt: string } }> }
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
}

/** Bounds: hosts examined per sweep, agents whose denials are counted at once. */
export const URGENT_LIMITS = { hostsPerSweep: 100, agentsCounted: 1000, securityKinds: 8 } as const;

export type SecurityEvent = "sandbox-escape-attempt" | "credential-misused" | "protected-path-touched" | "integrity-check-failed";
const SECURITY_TEXT: Readonly<Record<SecurityEvent, string>> = {
  "sandbox-escape-attempt": "A sandbox escape was attempted", "credential-misused": "A credential was used from the wrong task or host",
  "protected-path-touched": "A protected path (.git or the loader configuration) was touched", "integrity-check-failed": "An integrity check failed",
};
const SAFE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const code = (v: string): string => (SAFE.test(v) ? v : createHash("sha256").update(v).digest("hex").slice(0, 24));

/**
 * The controller's own Urgent triggers (card U11c). Each raises one Urgent item through `emitFromController` with `interrupt`, which is sent at once on the configured channel, also in quiet hours
 * (unless the owner turned that off), and only the controller can do it. Triggers built here: no good backup within the owner's limit (default 48 hours, `backupMaxAgeHours`), an enrolled host silent
 * for longer than `hostDownAfterMinutes` (default 10), repeated policy denials of one agent over `deniedThreshold` within `deniedWindowMinutes` (off until the owner sets a number), and the security
 * events a caller reports through `reportSecurity`. A condition that has cleared (a backup made, a host heard from again) closes its item (de-escalation). The text sent outside is built here and holds
 * no payload: names and counts only. Memory is in-process: after a restart the denial counts start again and a backup that never existed is measured from the restart.
 */
export class UrgentWatch {
  readonly #n: NotificationService;
  readonly #o: UrgentWatchOptions;
  readonly #startedAt: string;
  readonly #denials = new Map<string, number[]>();
  readonly #raisedHosts = new Set<string>();
  #backupRaised = false;
  #first = true;

  constructor(options: UrgentWatchOptions) {
    this.#n = options.notifications; this.#o = options;
    this.#startedAt = this.#now();
  }

  #now(): string { return this.#o?.clock?.() ?? new Date().toISOString(); }

  /** One pass over the backup and host conditions. Each check stands alone: one failing does not stop the other, the first failure is raised after both ran. */
  async sweep(by: Principal): Promise<{ raised: string[]; cleared: string[] }> {
    const settings = await this.#n.controllerSettings();
    const raised: string[] = []; const cleared: string[] = [];
    let failure: unknown;
    try {
      if (this.#o.backups !== undefined) {
        const limitH = settings.backupMaxAgeHours === undefined ? DEFAULT_BACKUP_MAX_AGE_HOURS : settings.backupMaxAgeHours;
        const ref = { kind: "backup", id: "installation" };
        const newest = (await this.#o.backups.status()).newest?.createdAt;
        const since = newest ?? this.#startedAt;
        const age = Date.parse(this.#now()) - Date.parse(since);
        if (limitH !== null && age > limitH * 3_600_000) {
          const hours = Math.floor(age / 3_600_000);
          await this.#n.emitFromController({ commandId: `urg-backup:${since}`, kind: "maintenance", interrupt: true, ref, label: `Urgent: no good backup for ${hours} hours`, detail: (newest === undefined ? `No backup has been made in the ${hours} hours this controller has been running (limit ${limitH}).` : `The last good backup is ${hours} hours old (limit ${limitH}).`) });
          this.#backupRaised = true; raised.push("backup");
        } else if (this.#backupRaised || this.#first) {
          const r = await this.#n.settleFromController({ commandId: `urg-backup-ok:${this.#now()}`, kind: "maintenance", ref });
          this.#backupRaised = false; if (r.closed) cleared.push("backup");
        }
      }
    } catch (error) { failure ??= error; }
    try {
      if (this.#o.hosts !== undefined) {
        const limitM = settings.hostDownAfterMinutes === undefined ? DEFAULT_HOST_DOWN_AFTER_MINUTES : settings.hostDownAfterMinutes;
        const page = await this.#o.hosts.list(by, { limit: URGENT_LIMITS.hostsPerSweep });
        const now = Date.parse(this.#now());
        for (const h of page.items) {
          const ref = { kind: "host-record", id: code(h.hostId.replace(/^host:/, "")) };
          const silent = h.lastSeenAt === undefined ? 0 : now - Date.parse(h.lastSeenAt);
          const down = limitM !== null && h.identity === "active" && h.freshness === "stale" && silent >= limitM * 60_000;
          if (down) {
            await this.#n.emitFromController({ commandId: `urg-host:${h.hostId}:${h.lastSeenAt ?? ""}`, kind: "maintenance", interrupt: true, ref, label: `Urgent: host ${code(h.hostId.replace(/^host:/, ""))} has been silent for ${Math.floor(silent / 60_000)} minutes`, detail: `Host ${code(h.hostId.replace(/^host:/, ""))} has not been heard from for ${Math.floor(silent / 60_000)} minutes (limit ${limitM}).` });
            this.#raisedHosts.add(h.hostId); raised.push(`host:${h.hostId}`);
          } else if (this.#raisedHosts.has(h.hostId) || this.#first) {
            const r = await this.#n.settleFromController({ commandId: `urg-host-ok:${h.hostId}:${this.#now()}`, kind: "maintenance", ref });
            this.#raisedHosts.delete(h.hostId); if (r.closed) cleared.push(`host:${h.hostId}`);
          }
        }
      }
    } catch (error) { failure ??= error; }
    this.#first = false;
    if (failure !== undefined) throw failure;
    return { raised, cleared };
  }

  /**
   * One policy denial of an agent. Counted per agent over the owner's window; the denial that reaches the owner's threshold raises one Urgent item for that agent, later ones only add to its count.
   * One denial is routine and never Urgent. With no threshold set nothing is counted. Never throws on a notification failure: a refused tool call must not fail because the owner could not be told.
   */
  async reportDenial(agentId: string, projectId?: string): Promise<{ raised: boolean }> {
    try {
      const settings = await this.#n.controllerSettings();
      const threshold = settings.deniedThreshold;
      if (threshold === undefined || threshold === null) return { raised: false };
      const window = (settings.deniedWindowMinutes ?? DEFAULT_DENIED_WINDOW_MINUTES) * 60_000;
      const now = Date.parse(this.#now());
      const kept = (this.#denials.get(agentId) ?? []).filter((t) => now - t < window);
      kept.push(now);
      if (kept.length > threshold + 1) kept.splice(0, kept.length - (threshold + 1));
      this.#denials.delete(agentId); this.#denials.set(agentId, kept);
      // Bounded memory: the agent that was quiet longest is forgotten first.
      while (this.#denials.size > URGENT_LIMITS.agentsCounted) this.#denials.delete(this.#denials.keys().next().value as string);
      if (kept.length < threshold) return { raised: false };
      await this.#n.emitFromController({ commandId: `urg-deny:${agentId}:${Math.floor(now / window)}:${kept.length}`, kind: "maintenance", interrupt: true, label: `Urgent: agent ${code(agentId.replace(/^agent:/, ""))} was refused ${kept.length} times`, ref: { kind: "agent", id: code(agentId.replace(/^agent:/, "")) }, ...(projectId === undefined ? {} : { projectId }), detail: `Agent ${code(agentId.replace(/^agent:/, ""))} was refused ${kept.length} times within ${Math.round(window / 60_000)} minutes (threshold ${threshold}).` });
      return { raised: true };
    } catch { return { raised: false }; }
  }

  /** A security event another service detected (a sandbox escape attempt, a credential used from the wrong task or host, a protected path touched, a failed integrity check): always Urgent, once per `key`. */
  async reportSecurity(event: { readonly kind: SecurityEvent; readonly key: string; readonly projectId?: string }): Promise<{ itemId: string }> {
    if (!(event.kind in SECURITY_TEXT)) throw new Error(`unknown security event ${String(event.kind)}`);
    const r = await this.#n.emitFromController({ commandId: `urg-sec:${event.kind}:${event.key}`, kind: "maintenance", interrupt: true, label: `Urgent: ${SECURITY_TEXT[event.kind]}`.slice(0, 200), ref: { kind: "security", id: code(event.kind) }, ...(event.projectId === undefined ? {} : { projectId: event.projectId }), detail: `${SECURITY_TEXT[event.kind]}.` });
    return { itemId: r.itemId };
  }
}

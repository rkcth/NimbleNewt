import { createHash } from "node:crypto";
import type { Principal } from "../security/principals.js";
import type { SecurityEvent } from "./urgent.js";

/**
 * The controller's security detectors (card U11d). A place in the controller that sees a sign of a security event (a task credential used on another task, a host that names an attempt it never held,
 * a hook of a local worker) calls `signal`; it never throws, never waits and never blocks the refusal that is being made. The signal then goes, in the background, to `UrgentWatch.reportSecurityFrom`
 * as a report by a reporter of its own per detector (`service:detect-<source>`), so the owner's hourly allowance (`securityReportsPerHour`), the collected "held" item and the once-per-key rule of
 * card U11c apply, and one noisy detector cannot use up another's allowance.
 *
 * Bounds, so that an attacker who can make a detector fire cannot make the controller work without end: a signal already seen (same source, kind, project and key) is dropped before any work; at most
 * `recentKeys` keys are remembered (oldest forgotten first; the watch still tells one event once, from the notification state); at most `queued` signals wait, at most `perSource` of them from one source
 * (so a flood from one detector cannot crowd out another's sign), and at most `parallel` are reported at once; the rest is counted and, when the queue has drained, ONE overflow event per source and hour
 * is reported in their place (its key is the hour only, so the watch tells it once); a report that failed is forgotten, so the same sign can be tried again.
 * A signal may name its `subject` (the task credential, the host): one subject raises at most `perSubjectPerHour` distinct events of a source in an hour, and the rest of its burst ONE more, so a single
 * hostile agent that names task after task cannot use up the detector's hourly allowance and push another agent's real sign out of the Urgent channel.
 * The owner turns all of it off with `securityDetectors: false` (read at each report, through chat: `notifications.configure`); signals are then dropped, the refusals themselves are not affected.
 */
export interface DetectedSecurity {
  readonly kind: SecurityEvent;
  /** Up to 200 characters, the same for the same event; never a secret and never a path's content. */
  readonly key: string;
  readonly projectId?: string;
  /** Who the sign is about (a task credential's task, a host): used only to bound one subject's burst, never reported. */
  readonly subject?: string;
}

export const DETECT_LIMITS = { recentKeys: 5000, queued: 200, perSource: 50, parallel: 4, keyChars: 200, perSubjectPerHour: 3, subjects: 5000 } as const;

export interface SecurityDetectorsOptions {
  /** `UrgentWatch.reportSecurityFrom`. */
  readonly report: (by: Principal, event: { readonly kind: string; readonly key: string; readonly projectId?: string }) => Promise<unknown>;
  /** The owner's switch (`securityDetectors`, default on). A throw counts as on: a failing settings read must not silence a security sign. */
  readonly enabled: () => Promise<boolean>;
  readonly now?: () => number;
  /** Told of a failure to report (the report is forgotten and may be tried again). */
  readonly onError?: (error: unknown) => void;
}

const hash = (v: string): string => createHash("sha256").update(v).digest("hex").slice(0, 24);
const SOURCE = /^[a-z][a-z0-9-]{0,30}$/;
const HOUR = 3_600_000;

export class SecurityDetectors {
  readonly #o: SecurityDetectorsOptions;
  readonly #recent = new Set<string>();
  readonly #queue: { source: string; event: DetectedSecurity; id: string; at?: string }[] = [];
  readonly #overflow = new Map<string, { kind: SecurityEvent; count: number }>();
  /** Signals waiting per source. */
  readonly #waiting = new Map<string, number>();
  /** Distinct events per source and subject in the current hour. */
  readonly #subjects = new Map<string, { hour: number; count: number }>();
  #running = 0;
  #idle: (() => void)[] = [];

  constructor(options: SecurityDetectorsOptions) { this.#o = options; }

  /** The reporter a source reports as. A service principal of its own, with no grants: it can only report. */
  static reporter(source: string): Principal {
    return { id: `service:detect-${source}`, kind: "service", name: `detect-${source}`, grants: [] };
  }

  /** Never throws, never waits. `source` names the detector (lowercase letters, digits and dashes). */
  signal(source: string, event: DetectedSecurity): void {
    try {
      if (!SOURCE.test(source) || typeof event.key !== "string" || event.key.length === 0) return;
      let key = event.key.length > DETECT_LIMITS.keyChars ? `h:${hash(event.key)}` : event.key;
      let id = hash(`${source}|${event.kind}|${event.projectId ?? "-"}|${key}`);
      if (this.#recent.has(id)) return;
      let counted: string | undefined;
      if (typeof event.subject === "string" && event.subject.length > 0) {
        // One subject's burst: past its share of the hour, the rest is ONE event of that subject (the key holds a digest of the subject, never the subject's text).
        const hour = this.#hour();
        const at = `${source}|${event.subject}`;
        const seen = this.#subjects.get(at);
        const count = seen === undefined || seen.hour !== hour ? 0 : seen.count;
        if (count < DETECT_LIMITS.perSubjectPerHour) counted = at;
        if (count >= DETECT_LIMITS.perSubjectPerHour) {
          key = `many:${hash(at)}:${hour}`;
          id = hash(`${source}|${event.kind}|${event.projectId ?? "-"}|${key}`);
          if (this.#recent.has(id)) return;
        } else {
          this.#subjects.delete(at); this.#subjects.set(at, { hour, count: count + 1 });
          while (this.#subjects.size > DETECT_LIMITS.subjects) this.#subjects.delete(this.#subjects.keys().next().value as string);
        }
      }
      const waiting = this.#waiting.get(source) ?? 0;
      if (this.#queue.length >= DETECT_LIMITS.queued || waiting >= DETECT_LIMITS.perSource) {
        const o = this.#overflow.get(source);
        if (o === undefined) this.#overflow.set(source, { kind: event.kind, count: 1 }); else o.count += 1;
        if (counted !== undefined) this.#uncount(counted);
        return;
      }
      this.#remember(id);
      this.#enqueue({ source, event: { kind: event.kind, key, ...(event.projectId === undefined ? {} : { projectId: event.projectId }) }, id, ...(counted === undefined ? {} : { at: counted }) });
      this.#pump();
    } catch { /* a detector never breaks the code that called it */ }
  }

  /** Resolves when nothing is queued or being reported (tests, and an orderly stop). */
  async settled(): Promise<void> {
    while (this.#running > 0 || this.#queue.length > 0 || this.#overflow.size > 0) await new Promise<void>((resolve) => { this.#idle.push(resolve); this.#pump(); });
  }

  #hour(): number { return Math.floor((this.#o.now?.() ?? Date.now()) / HOUR); }

  /** A subject's event that was not told (switched off, failed, overflowed) gives its share back. */
  #uncount(at: string): void {
    const seen = this.#subjects.get(at);
    if (seen !== undefined && seen.hour === this.#hour() && seen.count > 0) seen.count -= 1;
  }

  #enqueue(item: { source: string; event: DetectedSecurity; id: string; at?: string }): void {
    this.#queue.push(item);
    this.#waiting.set(item.source, (this.#waiting.get(item.source) ?? 0) + 1);
  }

  #remember(id: string): void {
    this.#recent.delete(id); this.#recent.add(id);
    while (this.#recent.size > DETECT_LIMITS.recentKeys) this.#recent.delete(this.#recent.values().next().value as string);
  }

  #pump(): void {
    while (this.#running < DETECT_LIMITS.parallel && this.#queue.length > 0) {
      const item = this.#queue.shift()!;
      const left = (this.#waiting.get(item.source) ?? 1) - 1;
      if (left <= 0) this.#waiting.delete(item.source); else this.#waiting.set(item.source, left);
      this.#running += 1;
      void this.#send(item).finally(() => { this.#running -= 1; this.#pump(); });
    }
    if (this.#queue.length === 0 && this.#running === 0) {
      // The queue has drained: what was dropped while it was full is reported as ONE event per source and hour.
      // The key is the hour only (not the count), and it is remembered: a second burst in the same hour is not a second event.
      for (const [source, o] of [...this.#overflow]) {
        this.#overflow.delete(source);
        const hour = this.#hour();
        const id = hash(`overflow|${source}|${hour}`);
        if (this.#recent.has(id)) continue;
        this.#remember(id);
        this.#enqueue({ source, event: { kind: o.kind, key: `overflow:${hour}` }, id });
      }
      if (this.#queue.length > 0) { this.#pump(); return; }
      const idle = this.#idle; this.#idle = [];
      for (const resolve of idle) resolve();
    }
  }

  async #send(item: { source: string; event: DetectedSecurity; id: string; at?: string }): Promise<void> {
    try {
      let on = true;
      try { on = await this.#o.enabled(); } catch { on = true; }
      if (!on) { this.#recent.delete(item.id); if (item.at !== undefined) this.#uncount(item.at); return; }
      await this.#o.report(SecurityDetectors.reporter(item.source), item.event);
    } catch (error) {
      this.#recent.delete(item.id);
      if (item.at !== undefined) this.#uncount(item.at);
      try { this.#o.onError?.(error); } catch { /* ignored */ }
    }
  }
}

/** The key of a task credential used on another task: the two task IDs only (the same pair is one event; the credential and its token are never part of it). */
export const wrongTaskKey = (credentialTask: string, targetTask: unknown): string => `task:${credentialTask.slice(0, 80)}>${String(targetTask).slice(0, 80)}`;

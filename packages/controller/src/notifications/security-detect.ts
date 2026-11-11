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
 * `recentKeys` keys are remembered (oldest forgotten first; the watch still tells one event once, from the notification state); at most `queued` signals wait and at most `parallel` are reported at once, the
 * rest is counted and, when the queue has drained, ONE overflow event per source and hour is reported in their place; a report that failed is forgotten, so the same sign can be tried again.
 * The owner turns all of it off with `securityDetectors: false` (read at each report, through chat: `notifications.configure`); signals are then dropped, the refusals themselves are not affected.
 */
export interface DetectedSecurity {
  readonly kind: SecurityEvent;
  /** Up to 200 characters, the same for the same event; never a secret and never a path's content. */
  readonly key: string;
  readonly projectId?: string;
}

export const DETECT_LIMITS = { recentKeys: 5000, queued: 200, parallel: 4, keyChars: 200 } as const;

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
  readonly #queue: { source: string; event: DetectedSecurity; id: string }[] = [];
  readonly #overflow = new Map<string, { kind: SecurityEvent; count: number }>();
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
      const key = event.key.length > DETECT_LIMITS.keyChars ? `h:${hash(event.key)}` : event.key;
      const id = hash(`${source}|${event.kind}|${event.projectId ?? "-"}|${key}`);
      if (this.#recent.has(id)) return;
      if (this.#queue.length >= DETECT_LIMITS.queued) {
        const o = this.#overflow.get(source);
        if (o === undefined) this.#overflow.set(source, { kind: event.kind, count: 1 }); else o.count += 1;
        return;
      }
      this.#remember(id);
      this.#queue.push({ source, event: { ...event, key }, id });
      this.#pump();
    } catch { /* a detector never breaks the code that called it */ }
  }

  /** Resolves when nothing is queued or being reported (tests, and an orderly stop). */
  async settled(): Promise<void> {
    while (this.#running > 0 || this.#queue.length > 0 || this.#overflow.size > 0) await new Promise<void>((resolve) => { this.#idle.push(resolve); this.#pump(); });
  }

  #remember(id: string): void {
    this.#recent.delete(id); this.#recent.add(id);
    while (this.#recent.size > DETECT_LIMITS.recentKeys) this.#recent.delete(this.#recent.values().next().value as string);
  }

  #pump(): void {
    while (this.#running < DETECT_LIMITS.parallel && this.#queue.length > 0) {
      const item = this.#queue.shift()!;
      this.#running += 1;
      void this.#send(item).finally(() => { this.#running -= 1; this.#pump(); });
    }
    if (this.#queue.length === 0 && this.#running === 0) {
      // The queue has drained: what was dropped while it was full is reported as ONE event per source and hour.
      for (const [source, o] of [...this.#overflow]) {
        this.#overflow.delete(source);
        const hour = Math.floor((this.#o.now?.() ?? Date.now()) / HOUR);
        this.#queue.push({ source, event: { kind: o.kind, key: `overflow:${hour}:${o.count}` }, id: hash(`overflow|${source}|${hour}`) });
      }
      if (this.#queue.length > 0) { this.#pump(); return; }
      const idle = this.#idle; this.#idle = [];
      for (const resolve of idle) resolve();
    }
  }

  async #send(item: { source: string; event: DetectedSecurity; id: string }): Promise<void> {
    try {
      let on = true;
      try { on = await this.#o.enabled(); } catch { on = true; }
      if (!on) { this.#recent.delete(item.id); return; }
      await this.#o.report(SecurityDetectors.reporter(item.source), item.event);
    } catch (error) {
      this.#recent.delete(item.id);
      try { this.#o.onError?.(error); } catch { /* ignored */ }
    }
  }
}

/** The key of a task credential used on another task: the two task IDs only (the same pair is one event; the credential and its token are never part of it). */
export const wrongTaskKey = (credentialTask: string, targetTask: unknown): string => `task:${credentialTask.slice(0, 80)}>${String(targetTask).slice(0, 80)}`;

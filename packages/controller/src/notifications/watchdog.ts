import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import { readHeartbeat } from "../release/heartbeat.js";

/**
 * The controller-down watchdog (card U11d). It runs OUTSIDE the controller (`scripts/nimblenewt-watchdog.mjs`, a process of its own that needs no database, no credential of the controller and no model), because a
 * controller that is down cannot tell the owner it is down. Two halves share one small record file and nothing else:
 *
 * - `DownWatchdog` (the outside process): probes the controller (the heartbeat file the controller already writes, or an address that answers while it is up), and after `failuresBeforeDown` bad probes in a row records
 *   `downSince`, tells the owner straight on its own external channel (`tell`; a webhook is built in), and reminds at most every `remindEveryMs` and at most `maxTells` times for one outage. It tells nothing when the
 *   controller is back: that is the controller's job, below. A watchdog that was stopped and started again goes on with the record it finds, so a restart is not a second outage and not a second message.
 * - `WatchdogReturn` (inside the controller): when the controller is running it reads the record; an outage it has not raised yet is raised ONCE as an Urgent item through the ordinary notification service (so it goes out on
 *   every configured channel, in quiet hours too unless the owner chose otherwise, with retries) and remembered in a second file the controller alone writes (`<record>.raised`), so the watchdog's own file is never written by two
 *   processes.
 *
 * What leaves holds times and counts only. The record carries no path, name, credential or message. A record that is missing, garbled, too large, a link or from the future is "no outage" (it never raises on a guess).
 */

export const WATCHDOG_LIMITS = { recordBytes: 512, failuresBeforeDown: { min: 1, max: 100, default: 3 }, remindEveryMs: { min: 60_000, max: 86_400_000, default: 3_600_000 }, maxTells: { min: 1, max: 100, default: 12 }, tellTimeoutMs: 10_000 } as const;

export interface WatchdogRecord {
  readonly v: 1;
  /** When the first bad probe of this outage was made (UTC time). */
  readonly downSince: string;
  /** How many times the owner was told of this outage, and when last. */
  readonly tells: number;
  readonly lastToldAt?: string;
  /** When the probe first answered again (set by the watchdog; the controller does not need it to raise). */
  readonly returnedAt?: string;
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isTime = (v: unknown): v is string => typeof v === "string" && TIME.test(v) && Number.isFinite(Date.parse(v));

/** Reads a record file strictly; anything unexpected is `undefined` ("no outage"), never a throw. */
export async function readWatchdogRecord(file: string, now: () => number = Date.now): Promise<WatchdogRecord | undefined> {
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > WATCHDOG_LIMITS.recordBytes) return undefined;
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || raw["v"] !== 1 || !isTime(raw["downSince"])) return undefined;
    const tells = raw["tells"];
    if (typeof tells !== "number" || !Number.isSafeInteger(tells) || tells < 0 || tells > 10_000) return undefined;
    if (Date.parse(raw["downSince"]) > now() + 60_000) return undefined;
    if (raw["lastToldAt"] !== undefined && !isTime(raw["lastToldAt"])) return undefined;
    if (raw["returnedAt"] !== undefined && !isTime(raw["returnedAt"])) return undefined;
    return { v: 1, downSince: raw["downSince"], tells, ...(raw["lastToldAt"] === undefined ? {} : { lastToldAt: raw["lastToldAt"] as string }), ...(raw["returnedAt"] === undefined ? {} : { returnedAt: raw["returnedAt"] as string }) };
  } catch { return undefined; }
}

/** Writes a file by a temporary sibling and a rename, so a reader sees the old or the new text, never half of one. */
async function writeAtomic(file: string, text: string): Promise<void> {
  if (!isAbsolute(file)) throw new Error("the watchdog's files need absolute paths");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const h = await open(tmp, "wx", 0o600);
  try { await h.writeFile(text); await h.sync().catch(() => undefined); } finally { await h.close(); }
  try { await rename(tmp, file); } catch (error) { await unlink(tmp).catch(() => undefined); throw error; }
}
export const writeWatchdogRecord = (file: string, record: WatchdogRecord): Promise<void> => writeAtomic(file, JSON.stringify(record));

export type Probe = () => Promise<"alive" | "down" | "unknown">;

/**
 * A probe from the heartbeat file the controller writes while its event loop turns (`release/heartbeat.ts`): alive while the counter (or the start it belongs to) moves, down once it has stood still for `staleMs`
 * (a controller that exited or hung; the file stays behind). Judged by a monotonic clock only; a gap between two probes of more than half the limit (this process was paused, the machine slept) counts again from
 * there instead of judging. A file that cannot be read is `unknown` and the quiet time is not counted while it is.
 */
export function heartbeatProbe(file: string, o: { readonly staleMs?: number; readonly monotonic?: () => number } = {}): Probe {
  const staleMs = Math.max(1_000, o.staleMs ?? 120_000);
  const mono = o.monotonic ?? (() => performance.now());
  let last: string | undefined; let movedAt = 0; let checkedAt: number | undefined;
  return async () => {
    const now = mono();
    const gap = checkedAt === undefined ? 0 : now - checkedAt;
    checkedAt = now;
    const r = await readHeartbeat(file).catch(() => ({ kind: "unusable" as const, why: "unreadable" }));
    if (r.kind !== "beat") { movedAt = now; return "unknown"; }
    const stamp = `${r.record.token}:${r.record.seq}`;
    if (stamp !== last) { last = stamp; movedAt = now; return "alive"; }
    if (gap < 0 || gap > staleMs / 2) { movedAt = now; return "unknown"; }
    return now - movedAt >= Math.max(staleMs, 6 * r.record.intervalMs) ? "down" : "alive";
  };
}

/** One HTTP request with a hard time limit; resolves with the status, rejects when nothing answers. Uses the platform's http module (no redirects followed, the body is not read). */
function status(method: "GET" | "POST", url: string, timeoutMs: number, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch (error) { reject(error as Error); return; }
    if (u.protocol !== "http:" && u.protocol !== "https:") { reject(new Error("only http and https addresses are used")); return; }
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, { method, timeout: timeoutMs, headers: body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("timeout", () => req.destroy(new Error("no answer in time")));
    req.on("error", reject);
    req.end(body);
  });
}

/** A probe from an address that answers while the controller is up (any HTTP answer below 500 counts as up; no answer within the timeout, or a 5xx, is down). */
export function httpProbe(url: string, o: { readonly timeoutMs?: number } = {}): Probe {
  return async () => { try { return (await status("GET", url, o.timeoutMs ?? 5_000)) < 500 ? "alive" : "down"; } catch { return "down"; } };
}

/** A way to tell the owner that does not go through the controller: POSTs `{ "text": ... }` as JSON to an address the owner gave (their chat bridge's own incoming address). A non-2xx answer or no answer is a failure. */
export function webhookTell(url: string, o: { readonly timeoutMs?: number } = {}): (text: string) => Promise<void> {
  return async (text) => {
    const code = await status("POST", url, o.timeoutMs ?? WATCHDOG_LIMITS.tellTimeoutMs, JSON.stringify({ text }));
    if (code < 200 || code >= 300) throw new Error(`the channel answered ${code}`);
  };
}

export interface DownWatchdogOptions {
  readonly file: string;
  readonly probe: Probe;
  readonly tell: (text: string) => Promise<void>;
  /** UTC wall time for the record (default: the system clock). */
  readonly now?: () => number;
  readonly failuresBeforeDown?: number;
  /** Minutes between two reminders of one outage as milliseconds; `null` for no reminders. */
  readonly remindEveryMs?: number | null;
  readonly maxTells?: number;
  readonly onError?: (error: unknown) => void;
}

const clamp = (v: number | undefined, b: { readonly min: number; readonly max: number; readonly default: number }): number => (v === undefined || !Number.isFinite(v) ? b.default : Math.min(b.max, Math.max(b.min, Math.floor(v))));

export class DownWatchdog {
  readonly #o: DownWatchdogOptions;
  #bad = 0;
  constructor(options: DownWatchdogOptions) { this.#o = options; }
  #now(): number { return (this.#o.now ?? Date.now)(); }
  #iso(): string { return new Date(this.#now()).toISOString(); }

  /** One look. Never throws: what failed goes to `onError` and the next look tries again. */
  async tick(): Promise<{ state: "alive" | "down" | "unknown"; told: boolean }> {
    let told = false;
    try {
      const seen = await this.#o.probe();
      const record = await readWatchdogRecord(this.#o.file, () => this.#now());
      if (seen === "alive") {
        this.#bad = 0;
        // The controller answers again: the outage is closed in the record (the controller raises it by itself, from the same record).
        if (record !== undefined && record.returnedAt === undefined) await writeWatchdogRecord(this.#o.file, { ...record, returnedAt: this.#iso() });
        return { state: "alive", told };
      }
      if (seen === "unknown") return { state: "unknown", told };
      this.#bad += 1;
      if (this.#bad < clamp(this.#o.failuresBeforeDown, WATCHDOG_LIMITS.failuresBeforeDown)) return { state: "down", told };
      // A new outage starts a new record; a closed one that is down again is a second outage.
      let current: WatchdogRecord = record !== undefined && record.returnedAt === undefined ? record : { v: 1, downSince: this.#iso(), tells: 0 };
      const remind = this.#o.remindEveryMs === null ? null : clamp(this.#o.remindEveryMs, WATCHDOG_LIMITS.remindEveryMs);
      const maxTells = clamp(this.#o.maxTells, WATCHDOG_LIMITS.maxTells);
      const due = current.tells === 0 || (remind !== null && current.tells < maxTells && current.lastToldAt !== undefined && this.#now() - Date.parse(current.lastToldAt) >= remind);
      if (record === undefined || record.returnedAt !== undefined) await writeWatchdogRecord(this.#o.file, current);
      if (due) {
        const minutes = Math.max(0, Math.round((this.#now() - Date.parse(current.downSince)) / 60_000));
        const text = current.tells === 0
          ? `URGENT, the NimbleNewt controller is not answering (since ${current.downSince}). Nothing is being dispatched or watched until it is started again.`
          : `URGENT, the NimbleNewt controller is still not answering (${minutes} minutes since ${current.downSince}; this is reminder ${current.tells}).`;
        try {
          await this.#o.tell(text);
          current = { ...current, tells: current.tells + 1, lastToldAt: this.#iso() };
          told = true;
        } catch (error) { this.#o.onError?.(error); }
        await writeWatchdogRecord(this.#o.file, current);
      }
      return { state: "down", told };
    } catch (error) { this.#o.onError?.(error); return { state: "unknown", told }; }
  }
}

/** What the controller reads of the watchdog (card U11d). */
export interface WatchdogSource {
  /** The outage the watchdog recorded that this controller has not raised yet, if any. */
  pending(): Promise<WatchdogRecord | undefined>;
  /** Remembers that the outage was raised, so a restart does not raise it again. */
  raised(downSince: string): Promise<void>;
}

/** The controller's side: the record the outside watchdog wrote, and the controller's own note of what it already raised (`<file>.raised`). */
export function watchdogSource(file: string, now: () => number = Date.now): WatchdogSource {
  const mine = `${file}.raised`;
  return {
    async pending() {
      const record = await readWatchdogRecord(file, now);
      if (record === undefined) return undefined;
      const done = await readFile(mine, "utf8").then((t) => t.trim(), () => undefined);
      return done === record.downSince ? undefined : record;
    },
    async raised(downSince) { await writeAtomic(mine, downSince); },
  };
}

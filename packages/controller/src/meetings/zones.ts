/**
 * Calendar arithmetic for meeting schedules (card M01), done with the platform's time zone rules (`Intl`, the IANA database the runtime ships) and no extra dependency.
 * A schedule is a wall-clock time in a named zone ("09:30 in Europe/Berlin"), never a fixed number of hours, so a daylight-saving change moves the instant, not the wall-clock time:
 * - a wall-clock time that does not exist that day (the spring-forward gap) happens at the same moment as the first instant after the gap, shifted forward by the gap's length;
 * - a wall-clock time that happens twice (the fall-back hour) is the first of the two.
 * Everything here is pure; the current time always comes from the caller.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone name if the runtime knows it as an IANA zone (for example `Europe/Berlin`), else undefined. The name is kept as given: the runtime's own preferred spelling of an alias differs between platforms. Fixed offsets such as `+02:00` are not zones with rules and are refused. */
export function knownZone(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return undefined;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return value; } catch { return undefined; }
}

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(zone, f);
  }
  return f;
}

export interface WallClock { readonly date: string; readonly hour: number; readonly minute: number; readonly weekday: number }

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** The wall-clock reading in the zone at an instant (milliseconds since the epoch). `weekday`: 0 Sunday to 6 Saturday. */
export function wallClock(ms: number, zone: string): WallClock {
  const parts: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const date = `${pad(Number(parts["year"]), 4)}-${parts["month"]}-${parts["day"]}`;
  return { date, hour: Number(parts["hour"]), minute: Number(parts["minute"]), weekday: weekdayOf(date) };
}

/** The zone's offset from UTC at an instant, in milliseconds (positive east of Greenwich). */
export function offsetAt(ms: number, zone: string): number {
  const parts: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const asUtc = Date.UTC(Number(parts["year"]), Number(parts["month"]) - 1, Number(parts["day"]), Number(parts["hour"]), Number(parts["minute"]), Number(parts["second"]));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1970 && y <= 9999 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
export const isLocalTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** The weekday (0 Sunday to 6 Saturday) of a calendar date. */
export function weekdayOf(date: string): number { return new Date(`${date}T00:00:00Z`).getUTCDay(); }

/** The calendar date `days` after (or before, when negative) `date`. */
export function addDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`).getTime() + days * DAY;
  return new Date(t).toISOString().slice(0, 10);
}

/** Days from `a` to `b` (both calendar dates). */
export const daysBetween = (a: string, b: string): number => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / DAY);

/** The instant at which the wall clock in the zone reads `time` on `date`, by the rules in the file comment. */
export function instantOf(date: string, time: string, zone: string): number {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const wall = new Date(`${date}T00:00:00Z`).getTime() + h * 60 * MINUTE + m * MINUTE;
  const before = offsetAt(wall - 36 * 60 * MINUTE, zone);
  const after = offsetAt(wall + 36 * 60 * MINUTE, zone);
  const candidates = [...new Set([before, after])].map((o) => wall - o).filter((t) => t + offsetAt(t, zone) === wall);
  if (candidates.length > 0) return Math.min(...candidates);
  // The wall-clock time was skipped by a forward change: use the offset in force before it, which lands after the gap.
  return wall - before;
}

export type Recurrence =
  | { readonly kind: "once"; readonly date: string }
  | { readonly kind: "daily" }
  | { readonly kind: "weekly"; readonly days: readonly number[] };

export interface SlotRule {
  readonly recurrence: Recurrence;
  readonly time: string;
  readonly zone: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

export interface Slot {
  /** The local calendar date, which names the slot: one slot per schedule per local date, so a repeated hour in a fall-back night cannot make two. */
  readonly key: string;
  readonly at: number;
}

/** Whether the rule has a slot on this local date. */
export function occursOn(rule: SlotRule, date: string): boolean {
  if (rule.startDate !== undefined && date < rule.startDate) return false;
  if (rule.endDate !== undefined && date > rule.endDate) return false;
  switch (rule.recurrence.kind) {
    case "once": return date === rule.recurrence.date;
    case "daily": return true;
    case "weekly": return rule.recurrence.days.includes(weekdayOf(date));
  }
}

/**
 * The slots that start after `afterMs` and whose preparation window has opened by `nowMs` (the start minus `leadMs`), oldest first. At most `maxDays` local dates are looked at, counting back from
 * the date of `nowMs` plus a day; `truncated` says that older dates after `afterMs` were not looked at (so a very long downtime is reported, not silently shortened).
 */
export function dueSlots(rule: SlotRule, afterMs: number, nowMs: number, leadMs: number, maxDays: number): { slots: Slot[]; truncated: boolean } {
  const last = addDays(wallClock(nowMs, rule.zone).date, 1);
  let first = addDays(wallClock(afterMs, rule.zone).date, -1);
  let truncated = false;
  if (daysBetween(first, last) > maxDays) { first = addDays(last, -maxDays); truncated = true; }
  const slots: Slot[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    if (!occursOn(rule, date)) continue;
    const at = instantOf(date, rule.time, rule.zone);
    if (at > afterMs && at - leadMs <= nowMs) slots.push({ key: date, at });
  }
  return { slots, truncated };
}

/** The first slot that starts after `afterMs` and is not yet due, or undefined when the rule has no more (a finished `once` or a passed end date). Looks at most `maxDays` ahead. */
export function nextSlot(rule: SlotRule, afterMs: number, maxDays: number): Slot | undefined {
  let start = addDays(wallClock(afterMs, rule.zone).date, -1);
  // A first slot far ahead (a start date or a one-off date in the distance) is found by starting there, not by looking that far.
  const first = rule.recurrence.kind === "once" ? rule.recurrence.date : rule.startDate;
  if (first !== undefined && first > start) start = first;
  for (let i = 0; i <= maxDays + 1; i++) {
    const date = addDays(start, i);
    if (rule.endDate !== undefined && date > rule.endDate) return undefined;
    if (!occursOn(rule, date)) continue;
    const at = instantOf(date, rule.time, rule.zone);
    if (at > afterMs) return { key: date, at };
  }
  return undefined;
}

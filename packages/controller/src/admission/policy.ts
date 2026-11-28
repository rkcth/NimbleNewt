import { DomainError } from "../domain/errors.js";

/**
 * `productive` attempts do the work; `inquiry` and `review` are the small, quick calls that must stay possible while the work is saturated. `landing` is an integrator's attempt to land a project's approved work
 * (card P10b): it is mechanical (the integrator writes no content) and takes a place of the same reserved `control` lane, so a full lane or queue of author attempts can never keep approved work from landing.
 */
export type Lane = "productive" | "control";
export type RequestClass = "productive" | "inquiry" | "review" | "landing";

export interface Limits {
  /** Productive attempts running at once, in total. */
  readonly productive: number;
  /** Productive attempts running at once on one host. */
  readonly perHost: number;
  /** Reserved capacity for inquiries, reviews and landing together: productive work can never take it. */
  readonly control: number;
  /** Most requests waiting in each lane. A further request is refused rather than queued without bound. */
  readonly queue: number;
  /** How deep a chain of attempts starting attempts may go (an attempt started by the controller is depth 0). */
  readonly depth: number;
  /** How many live requests (running or waiting) one attempt may have started. */
  readonly children: number;
  /** A waiting request passed over this many times is served before anything else in its lane. */
  readonly patience: number;
}

/** Initial operating limits accepted by the owner (decision D6), plus provisional bounds on the queue and on spawning. */
export const DEFAULT_LIMITS: Limits = { productive: 4, perHost: 2, control: 2, queue: 100, depth: 3, children: 4, patience: 5 };
export const LIMIT_BOUNDS: Readonly<Record<keyof Limits, readonly [number, number]>> = {
  productive: [1, 64], perHost: [1, 16], control: [1, 16], queue: [1, 500], depth: [0, 8], children: [0, 16], patience: [1, 50],
};

/**
 * Optional capacity caps beyond the admission limits (card H10b). Each is OFF (absent) unless the owner turned it on: productive attempts running at once for one project, for one agent, and
 * the fan-in: how many running attempts report to one supervising agent at once (the agent of the task that spawned them; reviewers are not counted). A request over a cap waits (it is not refused); nothing is stopped by a lower cap.
 */
export interface Caps {
  readonly perProject?: number;
  readonly perAgent?: number;
  readonly fanIn?: number;
}
export const CAP_NAMES = ["perProject", "perAgent", "fanIn"] as const;
export type CapName = (typeof CAP_NAMES)[number];
export const CAP_BOUNDS = { min: 1, max: 1000 } as const;

/**
 * The P/PC work balance (card B01). Productive work is production (P) or improvement (PC): reflection, experiments, monitoring and other capacity work. The class comes from the task's contract
 * (`workClass`) and is fixed on the request when it is made, so relabeling a task later moves nothing already admitted or spent. Inquiries and reviews are never counted here (a production review stays P).
 */
export type WorkClass = "P" | "PC";
export const workClassOf = (e: Pick<Entry, "workClass">): WorkClass => e.workClass ?? "P";

/**
 * The owner's P/PC allocation in percent of the productive places, read for each decision from the installation settings `workClass.pcFloor` and `workClass.pcCeiling` and never stored in the
 * admission record (the settings are the one source). Absent when the owner set neither: admission is then exactly as before.
 */
export interface Balance { readonly floor: number; readonly ceiling: number }

/** The allocation as places: `reserved` are kept for improvement work, `ceiling` is the most improvement attempts at once, `protectedP` the places production always keeps. */
export interface BalancePlaces { readonly reserved: number; readonly ceiling: number; readonly protectedP: number }

/**
 * Turns the percentages into places of `productive`. The ceiling is rounded down, but a ceiling above 0% is never less than one place (rounding a share the owner allows down to none would make it
 * "never", which the owner says with 0%), and with two places or more it always leaves production at least one place, so a continuous improvement backlog cannot starve production. A floor above 0
 * keeps at least one place (rounded up) so approved improvement work is never left without one, and never more than the ceiling. With a single place the two kinds take turns by the usual patience
 * rule (see `blockers`).
 */
export function balancePlaces(productive: number, b: Balance): BalancePlaces {
  const raw = Math.floor((productive * b.ceiling) / 100);
  const least = b.ceiling > 0 ? Math.max(raw, 1) : 0;
  const ceiling = productive >= 2 ? Math.min(least, productive - 1) : least;
  const reserved = b.floor <= 0 ? 0 : Math.min(Math.ceil((productive * b.floor) / 100), ceiling);
  return { reserved, ceiling, protectedP: productive - ceiling };
}

/**
 * An emergency borrow of the improvement reserve (card B01, second slice): the owner's explicit direction that production work (of one project when `project` is set) may take up to `places` of the
 * places the floor keeps for improvement work, from `from` until `until`, with the owner's reason and the date by which the owner reviews it. Stored in the admission record (bounded), so it survives
 * a restart and expires by the clock. `endedAt` is set when the owner ended it early. It never touches the ceiling, never stops anything running and never changes who owns any work.
 */
export interface Borrow {
  readonly id: string;
  readonly reason: string;
  readonly places: number;
  readonly project?: string;
  readonly from: string;
  readonly until: string;
  readonly reviewBy: string;
  readonly by: string;
  readonly endedAt?: string;
  /** The command that ended it early (that command's derived `brw-` ID), so a repeat of that command answers with this borrow even after later ones ended. */
  readonly endedBy?: string;
  /** How many production attempts it let in that would otherwise have been held for waiting improvement work (for the owner's review). */
  readonly taken?: number;
}
/** The borrow in force for one decision, resolved from the stored `borrows` by the clock; never stored as such. */
export interface ActiveBorrow { readonly id: string; readonly places: number; readonly project?: string; readonly until: string }
/** When a borrow stopped counting: the owner's early end, else its expiry. */
export const borrowEnd = (b: Pick<Borrow, "until" | "endedAt">): string => (b.endedAt !== undefined && b.endedAt < b.until ? b.endedAt : b.until);
/** The borrow in force at `now`: the newest one that has begun and not ended. */
export function borrowAt(borrows: readonly Borrow[], now: string): Borrow | undefined {
  const last = borrows[borrows.length - 1];
  return last !== undefined && last.from <= now && now < borrowEnd(last) ? last : undefined;
}
/**
 * The earliest time the floor may be lent again after the newest borrow: it must stand again for at least as long as it was lent, so repeated urgency can never keep the floor away for more than half
 * of any stretch of time. Undefined when there was no borrow.
 */
export function borrowRestUntil(borrows: readonly Borrow[]): string | undefined {
  const last = borrows[borrows.length - 1];
  if (last === undefined) return undefined;
  const end = Date.parse(borrowEnd(last));
  return new Date(end + Math.max(0, end - Date.parse(last.from))).toISOString();
}
export const borrowReason = (b: ActiveBorrow): string => `borrowed from the improvement (PC) reserve under your emergency direction ${b.id} until ${b.until}; the place comes back when this attempt ends`;

export const LENT_REASON = "lent from the improvement (PC) reserve: no waiting improvement work could use the place; it comes back when this attempt ends";
export const TURN_REASON = "took the single place kept for improvement (PC) work in turn, after waiting the patience number of times; improvement work gets it back when this attempt ends";

export interface Capacity {
  readonly cpus: number;
  readonly memoryMb: number;
}

export interface Entry {
  readonly id: string;
  readonly class: RequestClass;
  /** 0 (lowest) to 9. Within a lane, higher goes first; equal priorities go in arrival order. */
  readonly priority: number;
  /** The host the work will run on. Required for productive work. */
  readonly host?: string;
  readonly cpus: number;
  readonly memoryMb: number;
  /** The running request that started this one. */
  readonly parent?: string;
  readonly depth: number;
  /** The project the work belongs to (counted against `perProject`). */
  readonly project?: string;
  /** The agent that does the work (counted against `perAgent`). */
  readonly agent?: string;
  /** The supervising agent that receives its report: the agent of the task that spawned it (counted against `fanIn`; reviewers are not counted). */
  readonly reportsTo?: string;
  /** P (production) or PC (improvement), as the task's contract said when the request was made. Absent: production. */
  readonly workClass?: WorkClass;
  /** Set when production work was admitted into a place reserved for improvement work because none could use it (card B01): why, in words. The place comes back when this attempt ends. */
  readonly lent?: string;
  /** The emergency borrow (`Borrow.id`) that let this production work in: without it the work would have been held for waiting improvement work at the decision that admitted it. */
  readonly borrowed?: string;
  readonly seq: number;
  /** How many times a later or lower-priority request was served ahead of this one. */
  readonly skipped: number;
  readonly at: string;
}

export interface AdmissionState {
  readonly limits: Limits;
  /** What each host can run, as the owner declared it. A productive request for a host without a declared capacity is refused. */
  readonly capacity: Readonly<Record<string, Capacity>>;
  readonly running: readonly Entry[];
  readonly queue: readonly Entry[];
  readonly nextSeq: number;
  /** The owner's optional caps as read for this decision. Never stored in this record (the settings record is the one source), so a change of the setting counts from the next decision. */
  readonly caps?: Caps;
  /** The owner's P/PC allocation as read for this decision (card B01). Never stored in this record, like `caps`. */
  readonly balance?: Balance;
  /** The owner's emergency borrows of the improvement reserve, oldest first (at most `BORROWS_KEPT`; absent until the first one). Stored here so a decision and a borrow meet in one guarded step. */
  readonly borrows?: readonly Borrow[];
  /** The borrow in force for this decision (from `borrows` and the clock). Never stored, like `caps`. */
  readonly borrow?: ActiveBorrow;
  /** The most recent requests that were taken out of the queue because they could no longer run (their host was lowered or disabled), with why. Bounded. */
  readonly withdrawn: readonly { readonly id: string; readonly reason: string; readonly at: string }[];
}

export const WITHDRAWN_KEPT = 50;
/** How many emergency borrows the admission record keeps (the newest decides the rest rule; the others are for the owner's review). */
export const BORROWS_KEPT = 20;
export const EMPTY_STATE: AdmissionState = { limits: DEFAULT_LIMITS, capacity: {}, running: [], queue: [], nextSeq: 1, withdrawn: [] };

export const laneOf = (c: RequestClass): Lane => (c === "productive" ? "productive" : "control");
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

export type Blocker = "lane" | "host" | "never" | "project" | "agent" | "fanin" | "improvement" | "reserved" | null;

/**
 * Whether some waiting improvement request could take a productive place if one were free (nothing but the lane holds it, and no request that has waited the patience number of times holds back what it
 * needs, as `promote` does). Such a request is what a reserved place is kept for; one that `promote` would pass by cannot use the place, so production is lent it instead of the place standing empty.
 */
function improvementCouldUse(state: AdmissionState): boolean {
  // Asked for every waiting production request of one decision, so it is worked out once per picture (the pictures are never changed, only replaced).
  const known = couldUse.get(state);
  if (known !== undefined) return known;
  const { balance: _b, ...plain } = state; void _b;
  const productive = state.queue.filter((e) => laneOf(e.class) === "productive");
  const starved = productive.filter((e) => e.skipped >= state.limits.patience).map((e) => ({ e, held: blockers(plain, e) })).filter((s) => s.held.length > 0);
  const found = productive.some((e) => {
    if (workClassOf(e) !== "PC" || !blockers(plain, e).every((b) => b === "lane")) return false;
    const keys = keysOf(e);
    // Only the starved requests considered before this one bar it: all of them for a request that is not starved itself, the older ones for one that is.
    return !starved.some((s) => s.e.id !== e.id && (e.skipped < state.limits.patience || s.e.seq < e.seq) && s.held.some((b) => { const k = keyOf(b, s.e); return k !== undefined && (k === "lane" || keys.includes(k)); }));
  });
  couldUse.set(state, found);
  return found;
}
const couldUse = new WeakMap<AdmissionState, boolean>();

/** How many reserved improvement places are not in use, and how many productive places are free now. */
function reserveOf(state: AdmissionState, places: BalancePlaces): { unmet: number; free: number } {
  const productive = state.running.filter((r) => laneOf(r.class) === "productive");
  return { unmet: Math.max(0, places.reserved - productive.filter((r) => workClassOf(r) === "PC").length), free: state.limits.productive - productive.length };
}

/** Whether the borrow in force lets this production request into the reserve: it is production and the borrow names no project or names the request's own. */
const borrowCovers = (state: AdmissionState, entry: Entry): ActiveBorrow | undefined => {
  const b = state.borrow;
  return b !== undefined && laneOf(entry.class) === "productive" && workClassOf(entry) === "P" && (b.project === undefined || b.project === entry.project) ? b : undefined;
};

/**
 * What the reserve still owes improvement work as this production request sees it: the unmet reserve, less the places the owner's emergency borrow lends when it covers the request. A place a borrowed
 * attempt takes is no longer free, so the reserve held back (`free <= owed`) shrinks with it and the borrow never lends more than it names.
 */
function owedTo(state: AdmissionState, places: BalancePlaces, entry: Entry): { owed: number; unmet: number; free: number } {
  const { unmet, free } = reserveOf(state, places);
  const b = borrowCovers(state, entry);
  return { owed: b === undefined ? unmet : Math.max(0, unmet - Math.min(b.places, places.reserved)), unmet, free };
}

/**
 * Everything that stands between a request and a place right now, in a fixed order. `lane`: its lane is full. `host`: its host has no room (count, CPUs or memory) at the moment. `never`: its host has no
 * declared capacity. `project`, `agent`, `fanin`: one of the owner's optional caps is full. Inquiries and reviews are not counted against a host's CPUs and memory (they are small, and must stay possible
 * on a host that productive work has filled), so for them only the lane matters. A request can be held by several things at once (a full host and a full project cap); all of them are listed.
 */
export function blockers(state: AdmissionState, entry: Entry): Exclude<Blocker, null>[] {
  const out: Exclude<Blocker, null>[] = [];
  const lane = laneOf(entry.class);
  const inLane = state.running.filter((r) => laneOf(r.class) === lane);
  if (inLane.length >= (lane === "productive" ? state.limits.productive : state.limits.control)) out.push("lane");
  if (lane === "control") return out;
  const capacity = entry.host === undefined ? undefined : own(state.capacity, entry.host);
  if (capacity === undefined) { out.push("never"); return out; }
  const onHost = state.running.filter((r) => r.host === entry.host && laneOf(r.class) === "productive");
  const cpus = onHost.reduce((sum, r) => sum + r.cpus, 0) + entry.cpus;
  const memory = onHost.reduce((sum, r) => sum + r.memoryMb, 0) + entry.memoryMb;
  if (onHost.length >= state.limits.perHost || !(cpus <= capacity.cpus && memory <= capacity.memoryMb)) out.push("host");
  const caps = state.caps;
  const productive = state.running.filter((r) => laneOf(r.class) === "productive");
  if (caps?.perProject !== undefined && entry.project !== undefined && productive.filter((r) => r.project === entry.project).length >= caps.perProject) out.push("project");
  if (caps?.perAgent !== undefined && entry.agent !== undefined && productive.filter((r) => r.agent === entry.agent).length >= caps.perAgent) out.push("agent");
  if (caps?.fanIn !== undefined && entry.reportsTo !== undefined && productive.filter((r) => r.reportsTo === entry.reportsTo).length >= caps.fanIn) out.push("fanin");
  if (state.balance !== undefined) {
    const places = balancePlaces(state.limits.productive, state.balance);
    if (workClassOf(entry) === "PC") {
      if (productive.filter((r) => workClassOf(r) === "PC").length >= places.ceiling) out.push("improvement");
    } else {
      // Production may not take a place the reserve still owes to improvement work that is waiting and could run. When no improvement work could use it, the place is lent (see `promote`).
      // With a single place production has no protected share, so a production request passed over the patience number of times is served anyway: the two kinds take turns.
      // The owner's emergency borrow, when it covers this request, lends some of the reserve to it (see `owedTo`).
      const { owed, free } = owedTo(state, places, entry);
      // Only a free place can be kept: when none is free the lane is what holds production, and its reason says so.
      const yields = places.protectedP === 0 && entry.skipped >= state.limits.patience;
      if (owed > 0 && free > 0 && free <= owed && !yields && improvementCouldUse(state)) out.push("reserved");
    }
  }
  return out;
}

/** The first thing that holds a request back (see `blockers`), or null when nothing does. */
export const blocker = (state: AdmissionState, entry: Entry): Blocker => blockers(state, entry)[0] ?? null;

/** What a blocked request competes for: requests with the same key hold each other back. */
const keyOf = (b: Blocker, e: Entry): string | undefined => (b === "lane" ? "lane" : b === "host" ? `host:${e.host}` : b === "project" ? `project:${e.project}` : b === "agent" ? `agent:${e.agent}` : b === "fanin" ? `fanin:${e.reportsTo}` : b === "improvement" || b === "reserved" ? `class:${workClassOf(e)}` : undefined);
const keysOf = (e: Entry): string[] => [e.host === undefined ? "" : `host:${e.host}`, e.project === undefined ? "" : `project:${e.project}`, e.agent === undefined ? "" : `agent:${e.agent}`, e.reportsTo === undefined ? "" : `fanin:${e.reportsTo}`, laneOf(e.class) === "productive" ? `class:${workClassOf(e)}` : ""].filter((k) => k !== "");

/** Why a waiting request waits, in words for the owner ("waiting for capacity", never a failure). Null when nothing but order holds it back. */
export function waitReason(state: AdmissionState, entry: Entry): string | null {
  const b = blocker(state, entry);
  switch (b) {
    case "lane": return `waiting for capacity: ${laneOf(entry.class) === "productive" ? state.limits.productive : state.limits.control} ${laneOf(entry.class)} attempts are already running`;
    case "host": return `waiting for capacity: ${entry.host} is full`;
    case "never": return `${entry.host} has no declared capacity`;
    case "project": case "agent": case "fanin": return capWaitReason(state, entry);
    case "improvement": case "reserved": return balanceWaitReason(state, entry);
    default: return null;
  }
}

/** Why a waiting request waits on one of the owner's capacity caps (per project, per agent, fan-in), whatever else also holds it. Null when no cap holds it. */
export function capWaitReason(state: AdmissionState, entry: Entry): string | null {
  const caps = state.caps;
  const b = blockers(state, entry).find((x) => x === "project" || x === "agent" || x === "fanin");
  switch (b) {
    case "project": return `waiting for capacity: project ${entry.project} already has ${caps?.perProject} attempts running (the owner's per-project cap)`;
    case "agent": return `waiting for capacity: agent ${entry.agent} already has ${caps?.perAgent} attempts running (the owner's per-agent cap)`;
    case "fanin": return `waiting for capacity: ${entry.reportsTo} already receives reports from ${caps?.fanIn} running attempts (the owner's fan-in cap)`;
    default: return null;
  }
}

/** Why a waiting request waits on the owner's P/PC allocation (card B01), whatever else also holds it. Null when the allocation does not hold it. */
export function balanceWaitReason(state: AdmissionState, entry: Entry): string | null {
  const b = state.balance;
  if (b === undefined) return null;
  const places = balancePlaces(state.limits.productive, b);
  const held = blockers(state, entry);
  if (held.includes("improvement")) {
    const raw = Math.floor((state.limits.productive * b.ceiling) / 100);
    const note = places.ceiling < raw ? ", less one place always kept for production" : places.ceiling > raw ? ", rounded up to one place so a ceiling above 0% lets improvement work run" : "";
    return `waiting for capacity: ${places.ceiling} improvement (PC) attempt${places.ceiling === 1 ? " is" : "s are"} already running, the most the owner's P/PC allocation allows (workClass.pcCeiling ${b.ceiling}% of ${state.limits.productive} places${note})`;
  }
  if (held.includes("reserved")) {
    const borrow = state.borrow;
    const note = borrow === undefined ? "" : borrowCovers(state, entry) === undefined ? `; your emergency borrow ${borrow.id} lends places only to project ${borrow.project}` : `; the ${borrow.places} place(s) your emergency borrow ${borrow.id} lends are taken`;
    return `waiting for capacity: the free place is kept for improvement (PC) work that is waiting (workClass.pcFloor ${b.floor}% keeps ${places.reserved} of ${state.limits.productive} places for it${note})`;
  }
  return null;
}

/** Whether the request fits right now: its lane has room and (for productive work) its host has room. Nothing about order. */
export const fits = (state: AdmissionState, entry: Entry): boolean => blocker(state, entry) === null;

/** Waiting requests of a lane, in the order they should be considered: those passed over too often first (oldest first), then by priority, then by arrival. */
export function order(state: AdmissionState, lane: Lane): Entry[] {
  const waiting = state.queue.filter((e) => laneOf(e.class) === lane);
  const starved = waiting.filter((e) => e.skipped >= state.limits.patience).sort((a, b) => a.seq - b.seq);
  const rest = waiting.filter((e) => e.skipped < state.limits.patience).sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  return [...starved, ...rest];
}

/**
 * Admits waiting requests while capacity allows, lane by lane, in order. A request that has been passed over the patience number of times is "starved": it is served first, and if it
 * does not fit yet it holds back only what it is waiting for (its host, or the whole lane if the lane itself is full), so work for other hosts carries on. A request that can never fit
 * is skipped, never waited on (the service withdraws those). A waiting request counts as passed over when a later one is admitted ahead of it and they compete for the same thing: the
 * same host, the lane, or the request could have been admitted but was outranked.
 */
export function promote(state: AdmissionState): { state: AdmissionState; admitted: Entry[] } {
  let current = state;
  const admitted: Entry[] = [];
  for (const lane of ["control", "productive"] as const) {
    for (;;) {
      const candidates = order(current, lane);
      const barred = new Set<string>();
      let chosen: Entry | undefined;
      for (const entry of candidates) {
        if (barred.has("lane") || keysOf(entry).some((k) => barred.has(k))) continue;
        const bs = blockers(current, entry);
        if (bs.length === 0) { chosen = entry; break; }
        // A starved request holds back everything it is waiting for (the lane, its host, its project, its agent and its supervisor, each that is full), so a request that
        // shares any one of them cannot slip past it; work that shares none of them carries on.
        if (entry.skipped >= current.limits.patience) for (const b of bs) { const k = keyOf(b, entry); if (k !== undefined) barred.add(k); }
      }
      if (chosen === undefined) break;
      const picked = lentIfReserved(current, chosen);
      const jumped = new Set(candidates.filter((e) => {
        if (e.id === picked.id || e.seq >= picked.seq) return false;
        const bs = blockers(current, e);
        // Production held back for waiting improvement work is passed over when that work is admitted (with a single place this is how the two take turns).
        return bs.length === 0 || bs.includes("lane") || (bs.includes("reserved") && workClassOf(picked) === "PC") || bs.some((b) => { const k = keyOf(b, e); return k !== undefined && keysOf(picked).includes(k); });
      }).map((e) => e.id));
      current = {
        ...current,
        running: [...current.running, picked],
        queue: current.queue.filter((e) => e.id !== picked.id).map((e) => (jumped.has(e.id) ? { ...e, skipped: e.skipped + 1 } : e)),
      };
      admitted.push(picked);
    }
  }
  return { state: current, admitted };
}

/** Marks production work that takes a place the reserve owes to improvement work (none could use it): the place is lent, with the reason, and comes back when the attempt ends. */
function lentIfReserved(state: AdmissionState, entry: Entry): Entry {
  if (state.balance === undefined || laneOf(entry.class) !== "productive" || workClassOf(entry) !== "P") return entry;
  const places = balancePlaces(state.limits.productive, state.balance);
  const { owed, unmet, free } = owedTo(state, places, entry);
  if (!(unmet > 0 && free <= unmet)) return entry;
  const could = improvementCouldUse(state);
  // Taken only because the owner's borrow lent it while improvement work could have used it: marked with the borrow, so the owner's review sees what the borrow did.
  const borrow = borrowCovers(state, entry);
  // The mark means "let in by the borrow": without it this request would have been held for the waiting improvement work at this decision. Which running attempt sits in which place is not
  // tracked (places are counts), so the borrow's bound is the admission rule itself: production never runs in more reserved places than the borrow lends (`owedTo`).
  if (borrow !== undefined && could && free > owed && !(places.protectedP === 0 && entry.skipped >= state.limits.patience)) return { ...entry, lent: borrowReason(borrow), borrowed: borrow.id };
  return { ...entry, lent: could ? TURN_REASON : LENT_REASON };
}

/** A request and everything it started that is still waiting, to be dropped when it goes (a running child is left to finish or be stopped on its own). */
export function descendants(queue: readonly Entry[], rootId: string): Set<string> {
  const gone = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const e of queue) if (e.parent !== undefined && (e.parent === rootId || gone.has(e.parent)) && !gone.has(e.id)) { gone.add(e.id); grew = true; }
  }
  return gone;
}

export function checkLimits(value: unknown): Limits {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DomainError("invalid_command", "limits: must be an object", { field: "limits" });
  const e = value as Record<string, unknown>;
  for (const key of Object.keys(e)) if (!Object.hasOwn(LIMIT_BOUNDS, key)) throw new DomainError("invalid_command", `limits.${key}: is not a limit`, { field: `limits.${key}` });
  const out: Record<string, number> = {};
  for (const [key, [lo, hi]] of Object.entries(LIMIT_BOUNDS)) {
    const v = e[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < lo || v > hi) throw new DomainError("invalid_command", `limits.${key}: must be a whole number from ${lo} to ${hi}`, { field: `limits.${key}` });
    out[key] = v;
  }
  const limits = out as unknown as Limits;
  if (limits.perHost > limits.productive) throw new DomainError("invalid_command", "limits.perHost: cannot exceed the total of productive attempts", { field: "limits.perHost" });
  return limits;
}

import { DomainError } from "../domain/errors.js";

/** `productive` attempts do the work; `inquiry` and `review` are the small, quick calls that must stay possible while the work is saturated. */
export type Lane = "productive" | "control";
export type RequestClass = "productive" | "inquiry" | "review";

export interface Limits {
  /** Productive attempts running at once, in total. */
  readonly productive: number;
  /** Productive attempts running at once on one host. */
  readonly perHost: number;
  /** Reserved capacity for inquiries and reviews together: productive work can never take it. */
  readonly control: number;
  /** Most requests waiting. A further request is refused rather than queued without bound. */
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
  /** The most recent requests that were taken out of the queue because they could no longer run (their host was lowered or disabled), with why. Bounded. */
  readonly withdrawn: readonly { readonly id: string; readonly reason: string; readonly at: string }[];
}

export const WITHDRAWN_KEPT = 50;
export const EMPTY_STATE: AdmissionState = { limits: DEFAULT_LIMITS, capacity: {}, running: [], queue: [], nextSeq: 1, withdrawn: [] };

export const laneOf = (c: RequestClass): Lane => (c === "productive" ? "productive" : "control");
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

export type Blocker = "lane" | "host" | "never" | "project" | "agent" | "fanin" | null;

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
  return out;
}

/** The first thing that holds a request back (see `blockers`), or null when nothing does. */
export const blocker = (state: AdmissionState, entry: Entry): Blocker => blockers(state, entry)[0] ?? null;

/** What a blocked request competes for: requests with the same key hold each other back. */
const keyOf = (b: Blocker, e: Entry): string | undefined => (b === "lane" ? "lane" : b === "host" ? `host:${e.host}` : b === "project" ? `project:${e.project}` : b === "agent" ? `agent:${e.agent}` : b === "fanin" ? `fanin:${e.reportsTo}` : undefined);
const keysOf = (e: Entry): string[] => [e.host === undefined ? "" : `host:${e.host}`, e.project === undefined ? "" : `project:${e.project}`, e.agent === undefined ? "" : `agent:${e.agent}`, e.reportsTo === undefined ? "" : `fanin:${e.reportsTo}`].filter((k) => k !== "");

/** Why a waiting request waits, in words for the owner ("waiting for capacity", never a failure). Null when nothing but order holds it back. */
export function waitReason(state: AdmissionState, entry: Entry): string | null {
  const b = blocker(state, entry);
  switch (b) {
    case "lane": return `waiting for capacity: ${laneOf(entry.class) === "productive" ? state.limits.productive : state.limits.control} ${laneOf(entry.class)} attempts are already running`;
    case "host": return `waiting for capacity: ${entry.host} is full`;
    case "never": return `${entry.host} has no declared capacity`;
    case "project": case "agent": case "fanin": return capWaitReason(state, entry);
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
      const picked = chosen;
      const jumped = new Set(candidates.filter((e) => {
        if (e.id === picked.id || e.seq >= picked.seq) return false;
        const bs = blockers(current, e);
        return bs.length === 0 || bs.includes("lane") || bs.some((b) => { const k = keyOf(b, e); return k !== undefined && keysOf(picked).includes(k); });
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

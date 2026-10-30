import { createHash } from "node:crypto";
import { classifyProviderFailure } from "../routing/fallback.js";
import type { JsonObject } from "../storage/types.js";

/**
 * Event source adapters (card H13). An adapter turns what one kind of source can observe (a timer coming due, a task finishing, a file or repository changing, a service failing, a model
 * becoming unavailable) into **signals**: plain facts with a stable dedup identity. Adapters hold no storage and no clock of their own: the time is the `now` they are given, what they
 * observe comes from an injected probe (tests use scripted ones, the real probes are the worker's), and the little state they need between polls (what was seen) is handed in and returned,
 * so the runner (`SourceService`) decides when it is saved. The same observation polled twice yields the same dedup identity, so a duplicated or replayed poll cannot make a second event.
 */
export type SourceType = "timer" | "task-completion" | "file" | "repository" | "service-failure" | "model-availability";

export interface Signal {
  /** Identifies this observation within its source: the same thing seen again has the same one. */
  readonly dedup: string;
  /** The event kind published (`file.changed`, `timer.fired`, ...). */
  readonly kind: string;
  /** `project:<id>` or `task:<id>`. */
  readonly stream: string;
  readonly ref: { readonly kind: string; readonly id: string };
  /** Signals of the same thing share a key, so a burst is delivered once with a count. */
  readonly key?: string;
  /** Free text about the observation (a path, a message). It is data for people and agents to read; it is bounded, redacted and never interpreted. */
  readonly text?: string;
  /** The earlier signal (of this or another source) this one follows from, for the causation chain. */
  readonly causedBy?: { readonly dedup: string; readonly source?: string };
  /** The task whose work probably caused it (a file it wrote). While that task is handling an event, this signal is linked to it as its cause, which is how a self-triggering loop is seen. */
  readonly originTask?: string;
  /** The source's own numbering, when it has one (gaps are then reported by the stream). */
  readonly seq?: number;
}

export interface PollInput { readonly state: JsonObject | undefined; readonly now: string; readonly limit: number }
export interface PollResult {
  readonly signals: readonly Signal[];
  /** The state to keep once these signals are published. */
  readonly state: JsonObject;
  /** True when more would have been returned beyond `limit` (a flood is taken in bounded pieces). */
  readonly more: boolean;
}
export interface EventSource {
  readonly id: string;
  readonly type: SourceType;
  /** How far back this source can still see what happened (a source that forgets older things, like the built-in tasks source, sets it). A saved position older than this has lost events: the runner reports a gap and starts again from the present. */
  readonly retentionMs?: number;
  /** The controller relies on this source: the owner may not switch it off. Default false. */
  readonly critical?: boolean;
  poll(input: PollInput): Promise<PollResult>;
}

export const ADAPTER_LIMITS = { entries: 5000, remembered: 1000, text: 300 } as const;
const REF_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);
/** A name that is safe as a record ID in an event: as it is when it already is one, otherwise a digest of it (the readable name goes in `text`). */
export const safeId = (value: string, prefix: string): string => (REF_ID.test(value) ? value : `${prefix}-${digest(value)}`);
/** The causation fields of a signal from what an observation says about itself. */
const links = (o: { causedByDedup?: string | undefined; originTask?: string | undefined }): Pick<Signal, "causedBy" | "originTask"> => ({ ...(o.causedByDedup === undefined ? {} : { causedBy: { dedup: o.causedByDedup } }), ...(o.originTask === undefined ? {} : { originTask: o.originTask }) });
const cut = (value: string | undefined): string | undefined => (value === undefined ? undefined : value.slice(0, ADAPTER_LIMITS.text));
const obj = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
/** A step of a poll: a signal to hand out (with the state change that records it as seen), or a bare state change (a baseline) that always applies. Signals beyond `limit` are neither handed out nor recorded, so the next poll finds them again. */
interface Step { readonly signal?: Signal; readonly apply: () => void }
function run(steps: readonly Step[], limit: number): { signals: Signal[]; more: boolean } {
  const signals: Signal[] = []; let more = false;
  for (const step of steps) {
    if (step.signal === undefined) step.apply();
    else if (signals.length < limit) { signals.push(step.signal); step.apply(); } else more = true;
  }
  return { signals, more };
}

export interface TimerSpec { readonly id: string; readonly dueAt: string; readonly stream: string; readonly ref?: { kind: string; id: string }; readonly text?: string; readonly causedByDedup?: string; readonly originTask?: string }

/** Timers: each fires once when its due time has passed on the given clock. A repeating timer is a new spec with a later `dueAt` (the dedup identity is the id and the due time). */
export function timerSource(options: { id: string; timers: () => Promise<readonly TimerSpec[]> | readonly TimerSpec[] }): EventSource {
  return {
    id: options.id, type: "timer",
    async poll({ state, now, limit }) {
      const fired = new Set<string>(Array.isArray(obj(state)["fired"]) ? (obj(state)["fired"] as string[]) : []);
      const due = [...(await options.timers())].filter((t) => Date.parse(t.dueAt) <= Date.parse(now) && !fired.has(`${t.id}@${t.dueAt}`)).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
      const out = run(due.map((t) => ({ signal: { dedup: `${t.id}@${t.dueAt}`, kind: "timer.fired", stream: t.stream, ref: t.ref ?? { kind: "timer", id: safeId(t.id, "timer") }, key: `timer:${safeId(t.id, "timer")}`, ...(t.text === undefined ? {} : { text: cut(t.text)! }), ...links(t) }, apply: () => { fired.add(`${t.id}@${t.dueAt}`); } })), limit);
      return { ...out, state: { fired: [...fired].slice(-ADAPTER_LIMITS.remembered) } };
    },
  };
}

export interface TaskObservation { readonly taskId: string; readonly state: string; readonly stream: string; readonly causedByDedup?: string; readonly originTask?: string }

/** Task completion: a task seen `done` or `cancelled` for the first time (or in a new closed state) yields one event. */
export function taskCompletionSource(options: { id: string; tasks: () => Promise<readonly TaskObservation[]> | readonly TaskObservation[] }): EventSource {
  return {
    id: options.id, type: "task-completion",
    async poll({ state, limit }) {
      const seen = { ...(obj(obj(state)["seen"]) as Record<string, string>) };
      const closed = [...(await options.tasks())].filter((t) => (t.state === "done" || t.state === "cancelled") && seen[t.taskId] !== t.state).sort((a, b) => a.taskId.localeCompare(b.taskId));
      const out = run(closed.map((t) => ({ signal: { dedup: `${t.taskId}:${t.state}`, kind: t.state === "done" ? "task.completed" : "task.cancelled", stream: t.stream, ref: { kind: "task", id: t.taskId }, key: `task:${t.taskId}`, ...links(t) }, apply: () => { seen[t.taskId] = t.state; } })), limit);
      return { ...out, state: { seen } };
    },
  };
}

export interface SnapshotEntry { readonly name: string; readonly version: string; readonly originTask?: string; readonly causedByDedup?: string }

/**
 * Files and repositories: a watcher is a **hint**. This adapter does not rely on delivery of change notices at all: each poll takes a snapshot (name and version, a content hash or a
 * revision) and reports what differs from the last one it saved, so a notice that was dropped is found by the next snapshot and one that was repeated changes nothing. The first snapshot
 * only sets the baseline unless `emitInitial` is set. What decides whether a task's inputs changed is still the direct version check at resume (`verifyAtResume`).
 */
export function snapshotSource(options: { id: string; type: "file" | "repository"; stream: string; snapshot: () => Promise<readonly SnapshotEntry[]> | readonly SnapshotEntry[]; emitInitial?: boolean }): EventSource {
  const prefix = options.type === "file" ? "file" : "repo";
  return {
    id: options.id, type: options.type,
    async poll({ state, limit }) {
      const baseline = state === undefined && options.emitInitial !== true;
      const seen = { ...(obj(obj(state)["seen"]) as Record<string, string>) };
      const now = [...(await options.snapshot())];
      if (now.length > ADAPTER_LIMITS.entries) throw new Error(`a snapshot of more than ${ADAPTER_LIMITS.entries} entries is not supported`);
      const steps: Step[] = []; const present = new Set<string>();
      for (const e of now.sort((a, b) => a.name.localeCompare(b.name))) {
        present.add(e.name);
        if (seen[e.name] === e.version) continue;
        const apply = (): void => { seen[e.name] = e.version; };
        if (baseline) { steps.push({ apply }); continue; }
        const id = safeId(e.name, prefix);
        steps.push({ apply, signal: { dedup: `${e.name}@${e.version}`, kind: `${options.type}.changed`, stream: options.stream, ref: { kind: options.type, id }, key: `${prefix}:${id}`, text: cut(`${e.name} is now at ${e.version}`)!, ...(e.originTask === undefined ? {} : { originTask: e.originTask }), ...(e.causedByDedup === undefined ? {} : { causedBy: { dedup: e.causedByDedup } }) } });
      }
      if (options.type === "file") {
        for (const name of Object.keys(seen).sort()) {
          if (present.has(name)) continue;
          const id = safeId(name, prefix); const last = seen[name]!;
          steps.push({ apply: () => { delete seen[name]; }, signal: { dedup: `${name}@removed:${last}`, kind: "file.removed", stream: options.stream, ref: { kind: "file", id }, key: `${prefix}:${id}`, text: cut(`${name} was removed`)! } });
        }
      }
      return { ...run(steps, limit), state: { seen } };
    },
  };
}

export interface ServiceObservation { readonly service: string; readonly healthy: boolean; readonly stream: string; readonly detail?: string; readonly causedByDedup?: string; readonly originTask?: string }

/** Service failures: a healthy service seen unhealthy yields `service.failed` (once per failure), and its return `service.recovered`. */
export function serviceFailureSource(options: { id: string; services: () => Promise<readonly ServiceObservation[]> | readonly ServiceObservation[] }): EventSource {
  return {
    id: options.id, type: "service-failure",
    async poll({ state, limit }) {
      const status = { ...(obj(obj(state)["status"]) as Record<string, { healthy: boolean; n: number }>) };
      const steps: Step[] = [];
      for (const s of [...(await options.services())].sort((a, b) => a.service.localeCompare(b.service))) {
        const before = status[s.service]; const sid = safeId(s.service, "svc");
        const text = { ...(s.detail === undefined ? {} : { text: cut(s.detail)! }), ...links(s) };
        if (s.healthy && before !== undefined && !before.healthy) steps.push({ apply: () => { status[s.service] = { healthy: true, n: before.n }; }, signal: { dedup: `${s.service}:up:${before.n}`, kind: "service.recovered", stream: s.stream, ref: { kind: "service", id: sid }, key: `service:${sid}`, ...text } });
        else if (!s.healthy && (before === undefined || before.healthy)) { const n = (before?.n ?? 0) + 1; steps.push({ apply: () => { status[s.service] = { healthy: false, n }; }, signal: { dedup: `${s.service}:down:${n}`, kind: "service.failed", stream: s.stream, ref: { kind: "service", id: sid }, key: `service:${sid}`, ...text } }); }
        else if (before === undefined) steps.push({ apply: () => { status[s.service] = { healthy: true, n: 0 }; } });
      }
      return { ...run(steps, limit), state: { status } };
    },
  };
}

export interface ModelObservation { readonly provider: string; readonly model: string; readonly available: boolean; readonly stream: string; readonly reason?: string; readonly causedByDedup?: string; readonly originTask?: string }

/** Model availability: a route seen unavailable yields `model.unavailable` (once per outage), and its return `model.available`. */
export function modelAvailabilitySource(options: { id: string; models: () => Promise<readonly ModelObservation[]> | readonly ModelObservation[] }): EventSource {
  return {
    id: options.id, type: "model-availability",
    async poll({ state, limit }) {
      const status = { ...(obj(obj(state)["status"]) as Record<string, { available: boolean; n: number }>) };
      const steps: Step[] = [];
      for (const m of [...(await options.models())].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`))) {
        const name = `${m.provider}/${m.model}`; const before = status[name]; const sid = safeId(name, "model");
        if (before !== undefined && before.available === m.available) continue;
        if (before === undefined && m.available) { steps.push({ apply: () => { status[name] = { available: true, n: 0 }; } }); continue; }
        const n = (before?.n ?? 0) + 1;
        steps.push({ apply: () => { status[name] = { available: m.available, n }; }, signal: { dedup: `${name}:${m.available ? "up" : "down"}:${n}`, kind: m.available ? "model.available" : "model.unavailable", stream: m.stream, ref: { kind: "model", id: sid }, key: `model:${sid}`, ...(m.reason === undefined ? {} : { text: cut(m.reason)! }), ...links(m) } });
      }
      return { ...run(steps, limit), state: { status } };
    },
  };
}

/** What a provider failure means for availability (R02's classification): credit, rate-limit, outage and authentication failures make a route unavailable; anything else says nothing about availability. */
export function availabilityFromFailure(route: { provider: string; model: string; stream: string }, failure: { message: string; status?: number }): ModelObservation | undefined {
  const kind = classifyProviderFailure(failure);
  return kind === "credit" || kind === "rate-limit" || kind === "outage" || kind === "auth" ? { ...route, available: false, reason: `provider failure: ${kind}` } : undefined;
}

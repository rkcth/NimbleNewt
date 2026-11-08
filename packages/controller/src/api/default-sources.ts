import type { ProjectService } from "../domain/index.js";
import { modelAvailabilitySource, type EventSource, type Signal } from "../events/index.js";
import type { JsonObject } from "../storage/types.js";

/** How far back a closed task is still reported by the built-in source, and how much one poll reads. */
export const DEFAULT_SOURCE_LIMITS = { recentDays: 7, scan: 5000, page: 200, remembered: 2000 } as const;

/**
 * The event sources a controller polls when the host gives none (card H13e): tasks seen done or cancelled in the last week, each reported once on its project's stream, so a watcher of a task's completion is woken by the real record
 * and not only by a producer that remembered to publish.
 *
 * - **Baseline.** The first full pass over the tasks only records what is already closed; it reports nothing, so turning this on does not wake anyone for work finished long ago.
 * - **Bounded reading.** One poll reads at most `scan` tasks and keeps a cursor in the source's state, so a store with more tasks than that is read in turns instead of the same first part every time (task IDs are random).
 * - **Bounded memory.** What it remembers is only the closed tasks of the last week (each with the time it was closed), at most `remembered` of them (the most recently closed; the state record has a size limit); older entries are dropped at every poll. What the cap forgets is remembered as a floor (the latest closing time dropped): nothing closed at or before it is reported afterwards, so a busy store does not report the same tasks again on every pass. A task closed again later has a new closing time and so a new key.
 */
export function defaultEventSources(projects: Pick<ProjectService, "listTasks">, clock: () => number = Date.now, models?: ModelHealthPort): EventSource[] {
  return [{
    id: "tasks",
    type: "task-completion",
    retentionMs: DEFAULT_SOURCE_LIMITS.recentDays * 86_400_000,
    critical: true,
    async poll({ state, limit }) {
      const since = clock() - DEFAULT_SOURCE_LIMITS.recentDays * 86_400_000;
      const prev = (typeof state === "object" && state !== null ? state : {}) as { seen?: Record<string, string>; cursor?: string; baselining?: boolean; floor?: number };
      let floor = typeof prev.floor === "number" ? prev.floor : 0;
      const baselining = state === undefined ? true : prev.baselining === true;
      const seen: Record<string, string> = {};
      for (const [id, mark] of Object.entries(prev.seen ?? {})) if (Number(mark.slice(mark.lastIndexOf("@") + 1)) >= since) seen[id] = mark;
      const signals: Signal[] = [];
      let more = false;
      let read = 0;
      let after = prev.cursor;
      let cursor: string | undefined;
      let finished = false;
      while (read < DEFAULT_SOURCE_LIMITS.scan) {
        const pageStart = after;
        const page = await projects.listTasks({ ...(after === undefined ? {} : { afterId: after }), limit: DEFAULT_SOURCE_LIMITS.page });
        for (const t of page.items) {
          read++;
          cursor = t.id;
          const closedAt = Date.parse(t.updatedAt);
          // At or before the floor: forgotten by the cap, so it counts as seen (otherwise the same old tasks would be reported again on every pass).
          if ((t.state !== "done" && t.state !== "cancelled") || closedAt < since || closedAt <= floor) continue;
          const mark = `${t.state}@${closedAt}`;
          if (seen[t.id] === mark) continue;
          if (baselining) { seen[t.id] = mark; continue; }
          // Beyond the limit nothing is handed out or remembered, so the next poll finds it again.
          if (signals.length >= limit) { more = true; continue; }
          signals.push({ dedup: `${t.id}:${t.state}@${closedAt}`, kind: t.state === "done" ? "task.completed" : "task.cancelled", stream: `project:${t.projectId}`, ref: { kind: "task", id: t.id }, key: `task:${t.id}` });
          seen[t.id] = mark;
        }
        // Some of this page was left for the next poll: it starts again from the top of this page (what was reported is remembered, so only the rest is found).
        if (more) { cursor = pageStart; break; }
        if (page.next === undefined || page.items.length === 0) { finished = true; break; }
        after = page.next;
      }
      // A pass that reached the end of the list starts again from the top; one cut short carries on from where it stopped.
      const marks = Object.entries(seen);
      if (marks.length > DEFAULT_SOURCE_LIMITS.remembered) {
        marks.sort((a, b) => Number(b[1].slice(b[1].lastIndexOf("@") + 1)) - Number(a[1].slice(a[1].lastIndexOf("@") + 1)) || (a[0] < b[0] ? -1 : 1));
        const dropped = marks.slice(DEFAULT_SOURCE_LIMITS.remembered);
        for (const [id, mark] of dropped) { delete seen[id]; floor = Math.max(floor, Number(mark.slice(mark.lastIndexOf("@") + 1))); }
      }
      const next: Record<string, unknown> = { seen, baselining: baselining && !finished, ...(floor > 0 ? { floor } : {}) };
      if (!finished && cursor !== undefined) next["cursor"] = cursor;
      return { signals, state: next as JsonObject, more };
    },
  }, ...(models === undefined ? [] : [modelAvailabilityEvents(models)])];
}

/** What the model-availability source reads: the recorded health of model routes (accounts, endpoints, models) and the projects to tell. */
export interface ModelHealthPort {
  health(): Promise<{ readonly items: readonly { readonly scope: string; readonly name: string; readonly state: "down" | "healthy"; readonly lastClass?: string }[]; readonly truncated: boolean }>;
  projects(): Promise<readonly string[]>;
}
/** The IDs of the projects that are not archived, a page at a time. */
export async function activeProjectIds(projects: Pick<ProjectService, "listProjects">): Promise<string[]> {
  const out: string[] = [];
  for (let after: string | undefined; ;) {
    const page = await projects.listProjects({ ...(after === undefined ? {} : { afterId: after }), limit: 100 });
    for (const p of page) { after = p.id; if (p.state !== "archived") out.push(p.id); }
    if (page.length < 100) return out;
  }
}
/** At most this many project-and-route pairs are followed (the saved state is one record of limited size). */
export const MODEL_SOURCE_LIMITS = { pairs: 1500 } as const;

/**
 * The built-in model-availability source (card H13f): a model route (an account, an endpoint or a model) that the router records as down is reported as `model.unavailable` on every active project's
 * stream, once per outage, and its return as `model.available`. A route that has never failed is not reported. What it reads is the router's own health record (R02/R04), so a watcher of
 * `model.unavailable` is woken by what the dispatcher actually saw, not by a separate probe. It is not critical: the owner may turn it off.
 */
export function modelAvailabilityEvents(port: ModelHealthPort): EventSource {
  return {
    id: "models",
    type: "model-availability",
    async poll({ state, now, limit }) {
      const prev = ((typeof state === "object" && state !== null ? (state as Record<string, unknown>)["byProject"] : undefined) ?? {}) as Record<string, JsonObject>;
      const targets = (await port.health()).items;
      const projects = await port.projects();
      if (projects.length * targets.length > MODEL_SOURCE_LIMITS.pairs) throw new Error(`more than ${MODEL_SOURCE_LIMITS.pairs} project and model-route pairs to follow; model availability is not watched`);
      const byProject: Record<string, JsonObject> = {};
      const signals: Signal[] = [];
      let more = false;
      for (const projectId of projects) {
        const left = limit - signals.length;
        // Past the limit a project keeps its saved state (what it has not been told is found again by the next poll).
        if (left <= 0) { if (prev[projectId] !== undefined) byProject[projectId] = prev[projectId]!; more = true; continue; }
        const stream = `project:${projectId}`;
        const source = modelAvailabilitySource({ id: "models", models: () => targets.map((t) => ({ provider: t.scope, model: t.name, available: t.state === "healthy", stream, ...(t.state === "down" ? { reason: `${t.scope} ${t.name} is down${t.lastClass === undefined ? "" : ` (${t.lastClass})`}` } : {}) })) });
        const r = await source.poll({ state: prev[projectId], now, limit: left });
        signals.push(...r.signals);
        if (r.more) more = true;
        byProject[projectId] = r.state;
      }
      return { signals, state: { byProject } as unknown as JsonObject, more };
    },
  };
}

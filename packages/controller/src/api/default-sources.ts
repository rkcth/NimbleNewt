import type { ProjectService } from "../domain/index.js";
import type { EventSource, Signal } from "../events/index.js";
import type { JsonObject } from "../storage/types.js";

/** How far back a closed task is still reported by the built-in source, and how much one poll reads. */
export const DEFAULT_SOURCE_LIMITS = { recentDays: 7, scan: 5000, page: 200 } as const;

/**
 * The event sources a controller polls when the host gives none (card H13e): tasks seen done or cancelled in the last week, each reported once on its project's stream, so a watcher of a task's completion is woken by the real record
 * and not only by a producer that remembered to publish.
 *
 * - **Baseline.** The first full pass over the tasks only records what is already closed; it reports nothing, so turning this on does not wake anyone for work finished long ago.
 * - **Bounded reading.** One poll reads at most `scan` tasks and keeps a cursor in the source's state, so a store with more tasks than that is read in turns instead of the same first part every time (task IDs are random).
 * - **Bounded memory.** What it remembers is only the closed tasks of the last week (each with the time it was closed); older entries are dropped at every poll.
 */
export function defaultEventSources(projects: Pick<ProjectService, "listTasks">, clock: () => number = Date.now): EventSource[] {
  return [{
    id: "tasks",
    type: "task-completion",
    async poll({ state, limit }) {
      const since = clock() - DEFAULT_SOURCE_LIMITS.recentDays * 86_400_000;
      const prev = (typeof state === "object" && state !== null ? state : {}) as { seen?: Record<string, string>; cursor?: string; baselining?: boolean };
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
          if ((t.state !== "done" && t.state !== "cancelled") || closedAt < since) continue;
          const mark = `${t.state}@${closedAt}`;
          if (seen[t.id] === mark) continue;
          if (baselining) { seen[t.id] = mark; continue; }
          // Beyond the limit nothing is handed out or remembered, so the next poll finds it again.
          if (signals.length >= limit) { more = true; continue; }
          signals.push({ dedup: `${t.id}:${t.state}`, kind: t.state === "done" ? "task.completed" : "task.cancelled", stream: `project:${t.projectId}`, ref: { kind: "task", id: t.id }, key: `task:${t.id}` });
          seen[t.id] = mark;
        }
        // Some of this page was left for the next poll: it starts again from the top of this page (what was reported is remembered, so only the rest is found).
        if (more) { cursor = pageStart; break; }
        if (page.next === undefined || page.items.length === 0) { finished = true; break; }
        after = page.next;
      }
      // A pass that reached the end of the list starts again from the top; one cut short carries on from where it stopped.
      const next: Record<string, unknown> = { seen, baselining: baselining && !finished };
      if (!finished && cursor !== undefined) next["cursor"] = cursor;
      return { signals, state: next as JsonObject, more };
    },
  }];
}

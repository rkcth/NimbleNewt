import type { ProjectService } from "../domain/index.js";
import { taskCompletionSource, type EventSource, type TaskObservation } from "../events/index.js";

/** How far back a closed task is still reported by the built-in source: the source remembers what it has reported, so this also bounds what it remembers. */
export const DEFAULT_SOURCE_LIMITS = { recentDays: 7, scan: 5000, page: 200 } as const;

/**
 * The event sources a controller polls when the host gives none (card H13e): tasks seen done or cancelled in the last week, each reported once on its project's stream, so a watcher of a task's completion is woken by the
 * real record and not only by a producer that remembered to publish. Reads the task list page by page, at most `scan` tasks; a scan cut short reports what it saw and the next poll carries on from the start.
 */
export function defaultEventSources(projects: Pick<ProjectService, "listTasks">, clock: () => number = Date.now): EventSource[] {
  return [taskCompletionSource({
    id: "tasks",
    tasks: async () => {
      const since = clock() - DEFAULT_SOURCE_LIMITS.recentDays * 86_400_000;
      const out: TaskObservation[] = [];
      let seen = 0;
      for (let after: string | undefined; seen < DEFAULT_SOURCE_LIMITS.scan;) {
        const page = await projects.listTasks({ ...(after === undefined ? {} : { afterId: after }), limit: DEFAULT_SOURCE_LIMITS.page });
        for (const t of page.items) {
          seen++;
          if ((t.state === "done" || t.state === "cancelled") && Date.parse(t.updatedAt) >= since) out.push({ taskId: t.id, state: t.state, stream: `project:${t.projectId}` });
        }
        if (page.next === undefined || page.items.length === 0) break;
        after = page.next;
      }
      return out;
    },
  })];
}

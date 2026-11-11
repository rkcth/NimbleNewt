import type { BlockerService } from "../domain/blockers.js";
import type { ProjectService } from "../domain/service.js";
import type { WorkSource } from "./urgent.js";

/** Bounds of the work view: tasks of one project read, and open blockers read. Beyond them the answer is "not known", which decides nothing. */
export const WORK_LIMITS = { tasks: 1000, taskPage: 200, blockers: 2000, blockerPage: 500, pages: 50 } as const;

/**
 * The view of available work the stopped-work trigger uses (card U11d, H12): a project has "nothing else to do" when it has no task that is ready or in progress and not held by an open blocker. Tasks that are
 * proposed, blocked, done or cancelled cannot go on; a ready or running task with an open blocker (a hold, a missing grant, a dispatch problem) cannot either. It reads tasks and blockers only, with the bounds above;
 * a project with more tasks or more open blockers than the bounds is "not known" (`undefined`) rather than guessed, and so is a read that fails.
 */
export function workSource(deps: { readonly tasks: Pick<ProjectService, "listTasks">; readonly blockers: Pick<BlockerService, "list"> }): WorkSource {
  return {
    async idle(projectId: string): Promise<boolean | undefined> {
      try {
        const live: string[] = [];
        let read = 0; let pages = 0;
        for (let after: string | undefined; ;) {
          const page = await deps.tasks.listTasks({ projectId, ...(after === undefined ? {} : { afterId: after }), limit: WORK_LIMITS.taskPage });
          for (const t of page.items) if (t.state === "ready" || t.state === "in_progress") live.push(t.id);
          read += page.items.length;
          if (page.next === undefined) break;
          if (read >= WORK_LIMITS.tasks || ++pages > WORK_LIMITS.pages) return undefined;
          after = page.next;
        }
        if (live.length === 0) return true;
        const held = new Set<string>();
        let seen = 0; let turns = 0;
        for (let after: string | undefined; ;) {
          const page = await deps.blockers.list({ openOnly: true, limit: WORK_LIMITS.blockerPage, ...(after === undefined ? {} : { afterId: after }) });
          for (const b of page.items) if (b.subject.kind === "task") held.add(b.subject.id);
          seen += page.items.length;
          if (page.next === undefined) break;
          if (seen >= WORK_LIMITS.blockers || ++turns > WORK_LIMITS.pages) return live.every((id) => held.has(id)) ? true : undefined; // more blockers could only hold more tasks
          after = page.next;
        }
        return live.every((id) => held.has(id));
      } catch { return undefined; }
    },
  };
}

import type { BlockerService } from "../domain/blockers.js";
import type { AssignmentService } from "../domain/assignments.js";
import type { ProjectService } from "../domain/service.js";
import type { WorkSource } from "./urgent.js";

/** Bounds of the work view: tasks of one project read, and open blockers read. Beyond them the answer is "not known", which decides nothing. */
export const WORK_LIMITS = { tasks: 1000, taskPage: 200, blockers: 2000, blockerPage: 500, pages: 50, projects: 200, agentTasks: 5000, agentLive: 300 } as const;

/**
 * The view of available work the stopped-work trigger uses (card U11d, H12): a project has "nothing else to do" when it has no task that is ready or in progress and not held by an open blocker. Tasks that are
 * proposed, blocked, done or cancelled cannot go on; a ready or running task with an open blocker (a hold, a missing grant, a dispatch problem) cannot either. It reads tasks and blockers only, with the bounds above;
 * a project with more tasks or more open blockers than the bounds is "not known" (`undefined`) rather than guessed, and so is a read that fails.
 */
export function workSource(deps: { readonly tasks: Pick<ProjectService, "listTasks"> & Partial<Pick<ProjectService, "listProjects">>; readonly blockers: Pick<BlockerService, "list">; readonly assignments?: Pick<AssignmentService, "getAssignment"> }): Required<WorkSource> {
  /** The task ids held by an open blocker (a ready or running task with one cannot go on), or `undefined` past the bounds when that matters. */
  const heldTasks = async (): Promise<{ held: Set<string>; complete: boolean }> => {
    const held = new Set<string>();
    let seen = 0; let turns = 0;
    for (let after: string | undefined; ;) {
      const page = await deps.blockers.list({ openOnly: true, limit: WORK_LIMITS.blockerPage, ...(after === undefined ? {} : { afterId: after }) });
      for (const b of page.items) if (b.subject.kind === "task") held.add(b.subject.id);
      seen += page.items.length;
      if (page.next === undefined) return { held, complete: true };
      if (seen >= WORK_LIMITS.blockers || ++turns > WORK_LIMITS.pages) return { held, complete: false };
      after = page.next;
    }
  };
  return {
    // The agent a task is assigned to (the assignment record's owner, an agent, while it is assigned); anything else reads as nobody.
    async agentOf(taskId: string): Promise<string | undefined> {
      try {
        const a = await deps.assignments?.getAssignment(taskId);
        return a !== undefined && a.state === "assigned" && a.owner?.kind === "agent" ? a.owner.id : undefined;
      } catch { return undefined; }
    },
    // Whether the agent has nothing else to do: no other task assigned to it, in any project, ready or in progress and not held by an open blocker. Everything is read within bounds; a project list, a task list or a
    // blocker list past them, or a failing read, is "not known" (never a guess), except that more open blockers could only hold more tasks.
    async agentIdle(agentId: string, except: string): Promise<boolean | undefined> {
      try {
        if (deps.assignments === undefined || deps.tasks.listProjects === undefined) return undefined;
        const live: string[] = [];
        let read = 0;
        const projects = await deps.tasks.listProjects({ limit: WORK_LIMITS.projects + 1 });
        if (projects.length > WORK_LIMITS.projects) return undefined;
        for (const project of projects) {
          for (let after: string | undefined, pages = 0; ; ) {
            const page = await deps.tasks.listTasks({ projectId: project.id, ...(after === undefined ? {} : { afterId: after }), limit: WORK_LIMITS.taskPage });
            for (const t of page.items) if ((t.state === "ready" || t.state === "in_progress") && t.id !== except) live.push(t.id);
            read += page.items.length;
            if (page.next === undefined) break;
            if (read >= WORK_LIMITS.agentTasks || ++pages > WORK_LIMITS.pages) return undefined;
            after = page.next;
          }
          if (read >= WORK_LIMITS.agentTasks) return undefined;
        }
        const mine: string[] = [];
        if (live.length > WORK_LIMITS.agentLive * 10) return undefined;
        for (const id of live) {
          const a = await deps.assignments.getAssignment(id);
          if (a !== undefined && a.state === "assigned" && a.owner?.kind === "agent" && a.owner.id === agentId) mine.push(id);
          if (mine.length > WORK_LIMITS.agentLive) return undefined;
        }
        if (mine.length === 0) return true;
        const { held, complete } = await heldTasks();
        if (mine.every((id) => held.has(id))) return true;
        return complete ? false : undefined;
      } catch { return undefined; }
    },
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

import { DomainError } from "../domain/errors.js";
import { onlyKnown, projectId as checkProjectId, taskId as checkTaskId, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { DependencyBody } from "../planning/contracts.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

/**
 * The critical path the owner marked (card U11d, "U11f"). What is on the path is decided by the owner alone: this record is written only by `mark`, which only the owner can call, and nothing an agent supplies
 * (a task title, a blocker's summary, a description) is ever read to rank or to decide criticality. Three things can be marked, all by ID:
 *  - a `task`: that task is on the path;
 *  - a `goal`: a task the owner wants delivered; the goal and every task it waits for (through the active dependency records, the goal-based path) are on the path;
 *  - a `project`: every task of the project is on the path.
 * An item that waits for the owner "holds up the critical path" when the task it is about is on the path. A task mark covers that task only; a goal also covers what it waits for, so a decision about a prerequisite of a
 * goal holds the path up and one about a prerequisite of a plain marked task does not. The dependency records are written by agents, so they decide only for a goal the owner named, and only within its project.
 */
export type MarkKind = "task" | "goal" | "project";
export interface Mark { readonly kind: MarkKind; readonly id: string; readonly markedAt: string }
interface PathBody { readonly marks: readonly Mark[]; readonly updatedBy: string; readonly updatedAt: string }

/** Bounds: marks kept (the owner's own list is short), and tasks visited while following dependency records from one task. */
export const CRITICAL_LIMITS = { marks: 100, walk: 2000, retries: 4 } as const;

const REF = { kind: "critical-path", id: "installation" } as const;
const KINDS: readonly MarkKind[] = ["task", "goal", "project"];
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const isOpen = (state: string): boolean => state !== "done" && state !== "cancelled";

/** Whether the task with this ID is on the critical path the owner marked (an open task that is marked, in a marked project, or the goal or one of the tasks a marked goal waits for). Never throws: what cannot be read is not on the path. */
export type HoldsUp = (taskId: string) => Promise<boolean>;

export interface CriticalPathOptions extends RunnerOptions {
  /** The active dependency records of a project (`ContractService.activeEdges`). Absent or failing: only the tasks and projects the owner marked count, and a goal counts for itself. */
  readonly edges?: (projectId: string) => Promise<readonly DependencyBody[]>;
}

export class CriticalPathService {
  readonly #runner: CommandRunner;
  readonly #edges: CriticalPathOptions["edges"];

  private constructor(runner: CommandRunner, edges: CriticalPathOptions["edges"]) { this.#runner = runner; this.#edges = edges; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: CriticalPathOptions = {}): CriticalPathService {
    return new CriticalPathService(new CommandRunner(storage, epoch, options), options.edges);
  }

  /** The marks, as stored (an unreadable or damaged record is read as no marks: nothing is critical until the owner marks again). */
  async #read(): Promise<{ revision: number; marks: Mark[] }> {
    const found = await this.#runner.get(REF.kind, REF.id);
    const body = found?.body as unknown as Partial<PathBody> | undefined;
    const list = Array.isArray(body?.marks) ? body!.marks : [];
    const marks = list.filter((m): m is Mark => m !== null && typeof m === "object" && KINDS.includes((m as Mark).kind) && typeof (m as Mark).id === "string" && typeof (m as Mark).markedAt === "string").slice(0, CRITICAL_LIMITS.marks);
    return { revision: found?.revision ?? 0, marks };
  }

  /** What the owner marked (owner only). */
  async list(owner: Principal): Promise<{ revision: number; marks: Mark[] }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner reads or marks the critical path`);
    return this.#read();
  }

  /** Whether anything is marked (internal; lets callers skip every other read when nothing is). */
  async anyMarked(): Promise<boolean> { return (await this.#read()).marks.length > 0; }

  /**
   * The owner marks, or with `marked: false` unmarks, a task, a goal or a project. Owner only: no agent, host, service or task credential. Marking is by ID and never reads a title. A task or goal must exist, a project must
   * exist; unmarking needs nothing to exist (a mark can always be removed). Marking what is already marked in the same way changes nothing; a task marked again with the other kind (task or goal) takes the new one.
   * At most `CRITICAL_LIMITS.marks` marks. Replay-safe: the command ID is scoped to the caller and a repeat returns the first answer.
   */
  async mark(owner: Principal, command: NoActor & { kind?: unknown; taskId?: unknown; projectId?: unknown; marked?: unknown }): Promise<{ revision: number; changed: boolean; marks: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner marks the critical path`);
    onlyKnown(command, ["commandId", "kind", "taskId", "projectId", "marked"]);
    if (typeof command.kind !== "string" || !KINDS.includes(command.kind as MarkKind)) invalid("kind", "must be task, goal or project");
    const kind = command.kind as MarkKind;
    if (command.marked !== undefined && typeof command.marked !== "boolean") invalid("marked", "must be true or false");
    const marked = command.marked !== false;
    let id: string;
    if (kind === "project") {
      if (command.taskId !== undefined) invalid("taskId", "a project mark names a project, not a task");
      id = checkProjectId(command.projectId);
    } else {
      id = checkTaskId(command.taskId);
      // A project named beside the task (the chat adds the project the owner spoke of) must be the task's own.
      if (command.projectId !== undefined) checkProjectId(command.projectId);
    }
    const target = await this.#runner.get(kind === "project" ? "project" : "task", id);
    if (marked && target === undefined) throw new DomainError("not_found", `no such ${kind === "project" ? "project" : "task"} ${id}`);
    if (marked && kind !== "project" && command.projectId !== undefined && (target!.body as unknown as TaskBody).projectId !== command.projectId) invalid("projectId", "that task is not in that project");
    for (let attempt = 1; ; attempt++) {
      try {
        const before = await this.#read();
        const result = await this.#runner.command("critical.mark", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
          payload: { kind, id, marked },
          build: async () => {
            const current = await this.#runner.get(REF.kind, REF.id);
            const now = await this.#read();
            const kept = now.marks.filter((m) => m.id !== id);
            const had = now.marks.find((m) => m.id === id);
            if (marked && had === undefined && kept.length >= CRITICAL_LIMITS.marks) throw new DomainError("invalid_command", `at most ${CRITICAL_LIMITS.marks} things can be marked; unmark one first`, { field: "marks" });
            const next: Mark[] = marked ? [...kept, { kind, id, markedAt: had !== undefined && had.kind === kind ? had.markedAt : this.#runner.now() }] : kept;
            const body: PathBody = { marks: next, updatedBy: owner.id, updatedAt: this.#runner.now() };
            const change = current === undefined ? { type: "create" as const, ref: REF, body: body as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: body as unknown as JsonObject };
            return { ref: REF, creates: current === undefined, changes: [change], detail: { kind, id, marked, marks: next.length } };
          },
        }));
        const after = await this.#read();
        const changed = JSON.stringify(before.marks.map((m) => [m.kind, m.id])) !== JSON.stringify(after.marks.map((m) => [m.kind, m.id]));
        return { revision: result.revision, changed, marks: after.marks.length };
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || attempt >= CRITICAL_LIMITS.retries) throw error;
      }
    }
  }

  /**
   * A function that answers, for one pass (a sweep, a digest, a view), whether a task is on the critical path. It reads the marks once, each task once and each project's dependency records once. With nothing
   * marked it answers `undefined` without reading anything else. The walk over the dependency records of a marked goal is bounded (`CRITICAL_LIMITS.walk` tasks); a record that cannot be read counts as no dependencies.
   */
  async holdsUp(): Promise<HoldsUp | undefined> {
    const { marks } = await this.#read();
    if (marks.length === 0) return undefined;
    const tasks = new Set(marks.filter((m) => m.kind !== "project").map((m) => m.id));
    const goals = marks.filter((m) => m.kind === "goal").map((m) => m.id);
    const projects = new Set(marks.filter((m) => m.kind === "project").map((m) => m.id));
    const info = new Map<string, Promise<{ projectId: string; open: boolean } | undefined>>();
    const taskOf = (id: string): Promise<{ projectId: string; open: boolean } | undefined> => {
      let p = info.get(id);
      if (p === undefined) {
        p = this.#runner.get("task", id).then((a) => { const b = a?.body as unknown as TaskBody | undefined; return b === undefined ? undefined : { projectId: b.projectId, open: isOpen(b.state) }; }, () => undefined);
        info.set(id, p);
      }
      return p;
    };
    const graphs = new Map<string, Promise<Map<string, string[]>>>();
    const prerequisitesOf = (projectId: string): Promise<Map<string, string[]>> => {
      let g = graphs.get(projectId);
      if (g === undefined) {
        g = (this.#edges === undefined ? Promise.resolve([] as readonly DependencyBody[]) : this.#edges(projectId).catch(() => [] as readonly DependencyBody[])).then((edges) => {
          const prerequisites = new Map<string, string[]>();
          for (const e of edges) if (e.state === "active") prerequisites.set(e.taskId, [...(prerequisites.get(e.taskId) ?? []), e.prerequisiteId]);
          return prerequisites;
        });
        graphs.set(projectId, g);
      }
      return g;
    };
    // The tasks a marked goal waits for, per project: the goal-based path.
    const closures = new Map<string, Promise<Set<string>>>();
    const closureOf = (projectId: string): Promise<Set<string>> => {
      let c = closures.get(projectId);
      if (c === undefined) {
        c = (async () => {
          const out = new Set<string>();
          const prerequisites = await prerequisitesOf(projectId);
          const queue: string[] = [];
          for (const g of goals) { const t = await taskOf(g); if (t !== undefined && t.open && t.projectId === projectId) queue.push(g); }
          while (queue.length > 0 && out.size < CRITICAL_LIMITS.walk) {
            for (const p of prerequisites.get(queue.shift()!) ?? []) {
              if (out.has(p)) continue;
              const t = await taskOf(p);
              if (t === undefined || !t.open) continue;
              out.add(p); queue.push(p);
            }
          }
          return out;
        })();
        closures.set(projectId, c);
      }
      return c;
    };
    const answers = new Map<string, Promise<boolean>>();
    return (taskId: string): Promise<boolean> => {
      let a = answers.get(taskId);
      if (a === undefined) {
        a = (async () => {
          const t = await taskOf(taskId);
          if (t === undefined || !t.open) return false;
          return tasks.has(taskId) || projects.has(t.projectId) || (goals.length > 0 && (await closureOf(t.projectId)).has(taskId));
        })().catch(() => false);
        answers.set(taskId, a);
      }
      return a;
    };
  }
}

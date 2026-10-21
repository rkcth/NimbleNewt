import { BlockerService } from "../domain/blockers.js";
import { sha256 } from "../storage/json.js";
import { DomainError } from "../domain/errors.js";
import { projectId as checkProjectId, type TaskBody } from "../domain/model.js";
import { assignmentIdOf, type AssignmentBody } from "../domain/assignment-model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { InquiryBody } from "../inquiries/inquiries.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage } from "../storage/types.js";
import type { ContractService } from "./contracts.js";

/** One task held up on another, and what it waits through. */
export interface WaitEdge {
  readonly fromTask: string;
  readonly toTask: string;
  readonly via: "dependency" | "inquiry" | "review";
  readonly detail: string;
}

export interface CircularWait {
  /** The tasks in the ring, sorted. */
  readonly tasks: readonly string[];
  /** The agents that own those tasks, sorted. */
  readonly agents: readonly string[];
  readonly edges: readonly WaitEdge[];
  readonly blockerId?: string;
}

export interface WaitGraphOptions extends RunnerOptions {
  /** More edges for the graph, such as reviews waiting for a designated reviewer (card H05 supplies them). */
  readonly extraEdges?: (projectId: string) => Promise<readonly WaitEdge[]>;
  readonly scanLimit?: number;
}

const FINISHED = new Set(["done", "cancelled"]);
const principalOf = (owner: { kind: string; id: string } | undefined): string | undefined => (owner === undefined ? undefined : owner.id.includes(":") ? owner.id : `${owner.kind}:${owner.id}`);

/**
 * The wait-for graph (card S10), made of tasks. A task waits for each unfinished task it depends on; a task that has an open inquiry waits for the unfinished tasks of the agent it asked
 * (they are what that agent is busy with); a review will make a task wait for its reviewer's tasks (edges supplied by card H05). A ring of tasks is a circular wait that none of them can
 * break on its own, so it is reported as a blocker. One agent working through its own dependent tasks in order is not a ring, and neither are two agents whose dependencies cross
 * but can each still finish. Detection reads; it opens blockers (idempotent per ring) and changes nothing else.
 */
export class WaitGraphService {
  readonly #runner: CommandRunner;
  readonly #contracts: ContractService;
  readonly #blockers: BlockerService;
  readonly #extra: WaitGraphOptions["extraEdges"];
  readonly #scanLimit: number;

  private constructor(runner: CommandRunner, contracts: ContractService, blockers: BlockerService, options: WaitGraphOptions) {
    this.#runner = runner; this.#contracts = contracts; this.#blockers = blockers; this.#extra = options.extraEdges; this.#scanLimit = options.scanLimit ?? 5000;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, contracts: ContractService, blockers: BlockerService, options: WaitGraphOptions = {}): WaitGraphService {
    return new WaitGraphService(new CommandRunner(storage, epoch, options), contracts, blockers, options);
  }

  async #tasksOf(projectId: string): Promise<Map<string, { state: string; owner?: string }>> {
    const out = new Map<string, { state: string; owner?: string }>();
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list("task", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const r of page) {
        const b = r.body as unknown as TaskBody;
        if (b.projectId !== projectId) continue;
        const owner = principalOf(((await this.#runner.get("assignment", assignmentIdOf(r.id)))?.body as unknown as AssignmentBody | undefined)?.owner);
        out.set(r.id, { state: b.state, ...(owner === undefined ? {} : { owner }) });
        if (out.size > this.#scanLimit) throw new DomainError("unavailable", `there are more than ${this.#scanLimit} tasks in the project, too many to check safely`);
      }
      if (page.length < 500) return out;
      after = page.at(-1)!.id;
    }
  }

  /** The edges of one project's graph now. */
  async edges(projectId: string): Promise<WaitEdge[]> {
    const tasks = await this.#tasksOf(projectId);
    const live = (id: string): boolean => { const t = tasks.get(id); return t !== undefined && !FINISHED.has(t.state); };
    const edges: WaitEdge[] = [];
    for (const dep of await this.#contracts.activeEdges(projectId)) {
      if (live(dep.taskId) && live(dep.prerequisiteId)) edges.push({ fromTask: dep.taskId, toTask: dep.prerequisiteId, via: "dependency", detail: `${dep.taskId} depends on ${dep.prerequisiteId}` });
    }
    // Open inquiries of this project: only they are counted against the limit, however many closed ones exist.
    let after: string | undefined;
    let open = 0;
    for (;;) {
      const page = await this.#runner.list("inquiry", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const r of page) {
        const b = r.body as unknown as InquiryBody;
        if (b.projectId !== projectId || b.state !== "open" || !live(b.taskId)) continue;
        open += 1;
        if (open > this.#scanLimit) throw new DomainError("unavailable", `there are more than ${this.#scanLimit} open inquiries in the project, too many to check safely`);
        for (const [id, t] of tasks) if (t.owner === b.to && live(id) && id !== b.taskId) edges.push({ fromTask: b.taskId, toTask: id, via: "inquiry", detail: `inquiry ${r.id}: ${b.asker} asked ${b.to}` });
      }
      if (page.length < 500) break;
      after = page.at(-1)!.id;
    }
    if (this.#extra !== undefined) edges.push(...(await this.#extra(projectId)).filter((e) => live(e.fromTask) && live(e.toTask) && e.fromTask !== e.toTask));
    return edges;
  }

  /** The circular waits in the project's graph now (reading only). */
  async cycles(projectId: string): Promise<CircularWait[]> {
    const id = checkProjectId(projectId);
    const [edges, tasks] = [await this.edges(id), await this.#tasksOf(id)];
    const next = new Map<string, string[]>();
    for (const e of edges) next.set(e.fromTask, [...(next.get(e.fromTask) ?? []), e.toTask]);
    return stronglyConnected(next).map((members) => {
      const set = new Set(members);
      const agents = [...new Set(members.map((t) => tasks.get(t)?.owner).filter((o): o is string => o !== undefined))].sort();
      return { tasks: [...members].sort(), agents, edges: edges.filter((e) => set.has(e.fromTask) && set.has(e.toTask)) };
    }).sort((a, b) => a.tasks.join().localeCompare(b.tasks.join()));
  }

  /**
   * Finds the circular waits and opens a blocker for each (needs `blocker.manage` in the project). The blocker belongs to the ring (named by its tasks), so two rings never share one and
   * the same ring has one open blocker; its resolver is the owner of the ring's lowest-numbered task. A ring that is resolved and later forms again gets a new blocker.
   */
  async detect(by: Principal, command: NoActor & { projectId: string }): Promise<{ cycles: CircularWait[] }> {
    const projectId = checkProjectId(command.projectId);
    if (!allows(by, "blocker.manage", projectId)) throw new DomainError("forbidden", `${by.id} may not open blockers in ${projectId}`);
    const found = await this.cycles(projectId);
    const tasks = await this.#tasksOf(projectId);
    const out: CircularWait[] = [];
    for (const cycle of found) {
      const ring = `wr-${sha256(cycle.tasks.join(","))}`.slice(0, 40);
      const lowest = cycle.tasks[0]!;
      const summary = `Circular wait among tasks ${cycle.tasks.join(", ")} (agents ${cycle.agents.join(", ") || "none assigned"}): ${cycle.edges.map((e) => `${e.via}: ${e.detail}`).join("; ")}`.slice(0, 1000);
      const opened = await this.#blockers.openBlocker({
        commandId: scopedCommandId(by.id, `${command.commandId}:${ring}`), actor: by.id, type: "circular_wait", subject: { kind: "wait-ring", id: ring }, summary,
        resolver: (tasks.get(lowest)?.owner ?? "owner").slice(0, 120),
      });
      out.push({ ...cycle, blockerId: opened.id });
    }
    return { cycles: out };
  }
}

/** Strongly connected components with more than one node, or one node that waits for itself (Tarjan, iterative). */
function stronglyConnected(next: ReadonlyMap<string, readonly string[]>): string[][] {
  const nodes = new Set<string>();
  for (const [k, vs] of next) { nodes.add(k); for (const v of vs) nodes.add(v); }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (const root of [...nodes].sort()) {
    if (index.has(root)) continue;
    const work: { node: string; i: number }[] = [{ node: root, i: 0 }];
    index.set(root, counter); low.set(root, counter); counter += 1; stack.push(root); onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const targets = next.get(frame.node) ?? [];
      if (frame.i < targets.length) {
        const w = targets[frame.i]!;
        frame.i += 1;
        if (!index.has(w)) { index.set(w, counter); low.set(w, counter); counter += 1; stack.push(w); onStack.add(w); work.push({ node: w, i: 0 }); }
        else if (onStack.has(w)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
      } else {
        work.pop();
        const parent = work[work.length - 1];
        if (parent !== undefined) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        if (low.get(frame.node) === index.get(frame.node)) {
          const component: string[] = [];
          for (;;) { const w = stack.pop()!; onStack.delete(w); component.push(w); if (w === frame.node) break; }
          if (component.length > 1 || (next.get(frame.node) ?? []).includes(frame.node)) out.push(component);
        }
      }
    }
  }
  return out;
}

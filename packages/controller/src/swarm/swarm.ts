import { DomainError } from "../domain/errors.js";
import { onlyKnown, projectId as checkProjectId, taskId as checkTaskId, text, type View } from "../domain/model.js";
import { CommandRunner, view, type Built, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import type { BudgetService } from "../budgets/budgets.js";
import type { StopService } from "../lifecycle/stop.js";
import type { ContractService } from "../planning/contracts.js";
import { DEFAULT_LIMITS } from "../admission/policy.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";

/** Which task a task was spawned by (kind `swarm-link`, ID = the child task). */
export interface SwarmLinkBody {
  readonly parentTaskId: string;
  readonly projectId: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface SwarmDeps {
  readonly projects: Pick<ProjectService, "createTask" | "getTask" | "transitionTask">;
  readonly contracts: Pick<ContractService, "setContract">;
  readonly budgets: Pick<BudgetService, "delegate" | "reclaim" | "canManage">;
  readonly stops: Pick<StopService, "request" | "advance">;
  /** Depth and live children of one parent (card H03 defaults unless given). */
  readonly limits?: { readonly depth: number; readonly children: number };
}

const LINK = "swarm-link";
/** The children a parent has claimed a place for (kind `swarm-gate`, ID = the parent task); its revision serialises concurrent spawns. */
const GATE = "swarm-gate";
const FINAL = new Set(["done", "cancelled"]);

/**
 * Spawning and cancelling child tasks (card H10).
 *
 * - **A child exists only with an allowance.** `spawn` creates the child task, writes its contract from what the parent asked for (outcome and acceptance criteria), and delegates part of the parent's budget to it
 *   in the same call; a parent with nothing to give, a task at the depth limit or one with its live children at the limit is refused, and nothing is left behind (a child created before a refusal is cancelled).
 *   The child spends only that allowance (R05); the link records who spawned it.
 * - **Cancelling a parent settles its swarm.** `cancel` stops every descendant, deepest first, takes back what each did not use, and cancels the task; it can be repeated, and reports what could not be settled yet.
 * - Who may spawn: the owner, or the holder of the parent's budget with `budget.manage` (the delegation says so); an agent's own authority is not widened.
 */
export class SwarmService {
  readonly #runner: CommandRunner;
  readonly #deps: SwarmDeps;

  private constructor(runner: CommandRunner, deps: SwarmDeps) { this.#runner = runner; this.#deps = deps; }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: SwarmDeps, options: RunnerOptions = {}): SwarmService {
    return new SwarmService(new CommandRunner(storage, epoch, options), deps);
  }

  async spawn(by: Principal, command: NoActor & { parentTaskId: string; title: string; expectedResult?: string; acceptanceCriteria?: string[]; costMicros?: number; computeMs?: number }): Promise<{ taskId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "parentTaskId", "title", "expectedResult", "acceptanceCriteria", "costMicros", "computeMs"]);
    const parentId = checkTaskId(command.parentTaskId);
    const title = text(command.title, "title", { min: 1, max: 200 });
    // Who may is settled before anything is made or any limit is reported (a foreign task answers like a missing one).
    const parent = await this.#deps.projects.getTask(parentId);
    if (parent === undefined || !(await this.#deps.budgets.canManage(by, parentId)) || !(by.kind === "owner" || allows(by, "task.create", parent.projectId))) throw new DomainError("forbidden", `${by.id} may not spawn from that task`);
    const limits = this.#deps.limits ?? { depth: DEFAULT_LIMITS.depth, children: DEFAULT_LIMITS.children };
    if ((await this.#depth(parentId)) + 1 > limits.depth) throw new DomainError("invalid_command", `a task may spawn at most ${limits.depth} levels deep`, { field: "parentTaskId" });
    const created = await this.#deps.projects.createTask({ commandId: scopedCommandId(by.id, `${command.commandId}:child`), actor: by.id, projectId: parent.projectId, title } as never);
    const childId = created.id;
    // A child an earlier, refused call made and cancelled is not given an allowance by a retry: a refused spawn is asked again with a new command ID.
    if (created.replayed && (await this.#runner.get(LINK, childId)) === undefined && (await this.#deps.projects.getTask(childId))?.state === "cancelled") throw new DomainError("invalid_command", "that spawn was refused earlier; ask again with a new command ID", { field: "commandId" });
    // A replay of a spawn that completed finds the child already linked and has nothing more to do.
    if (created.replayed && (await this.#runner.get(LINK, childId)) !== undefined) return { taskId: childId, replayed: true };
    // The count and the claim of a place commit together (a check on the parent's gate record), so spawns sent at the same moment cannot all pass.
    await this.#reserve(parentId, childId, limits.children).catch(async (error: unknown) => { await this.#abandon(by, childId, parentId); throw error; });
    try {
      if (command.expectedResult !== undefined || (command.acceptanceCriteria?.length ?? 0) > 0) {
        await this.#deps.contracts.setContract(by, { commandId: scopedCommandId(by.id, `${command.commandId}:contract`), taskId: childId, expectedVersion: 0, ...(command.expectedResult === undefined ? {} : { expectedResult: command.expectedResult }), ...(command.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: command.acceptanceCriteria }) } as never)
          .catch((error: unknown) => { if (!(error instanceof DomainError && error.code === "stale_revision")) throw error; });
      }
      await this.#deps.budgets.delegate(by, { commandId: `${command.commandId}:budget`, parentTaskId: parentId, childTaskId: childId, ...(command.costMicros === undefined ? {} : { costMicros: command.costMicros }), ...(command.computeMs === undefined ? {} : { computeMs: command.computeMs }) });
    } catch (error) {
      await this.#abandon(by, childId, parentId);
      throw error;
    }
    const ref: AggregateRef = { kind: LINK, id: childId };
    const body: SwarmLinkBody = { parentTaskId: parentId, projectId: parent.projectId, createdBy: by.id, createdAt: this.#runner.now() };
    await this.#runner.command("swarm.spawn", { commandId: `swl-${childId}`, actor: by.id }, async () => ({
      payload: { childId, parentId },
      build: async (): Promise<Built> => ({ ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { parentTaskId: parentId } }),
    }));
    return { taskId: childId, replayed: false };
  }

  /** The tasks spawned by a task (live and finished), oldest link first. */
  async children(parentTaskId: string, projectIdValue: string): Promise<View<SwarmLinkBody>[]> {
    const parent = checkTaskId(parentTaskId);
    const projectId = checkProjectId(projectIdValue);
    return (await this.#links(projectId)).filter((l) => l.parentTaskId === parent);
  }

  /**
   * Stops every descendant of a task, deepest first, takes back what each did not use and cancels it. Returns the tasks settled and the ones still being stopped (call again to carry on).
   * The caller must hold the parent's budget (the owner, or its holder with `budget.manage`); a child whose own parent they do not hold is left untouched and reported pending, for someone who does.
   */
  async cancel(by: Principal, command: NoActor & { parentTaskId: string; reason: string }): Promise<{ settled: string[]; pending: string[] }> {
    onlyKnown(command, ["commandId", "parentTaskId", "reason"]);
    const parentId = checkTaskId(command.parentTaskId);
    const reason = text(command.reason, "reason", { min: 1, max: 500 });
    const parent = await this.#deps.projects.getTask(parentId);
    if (parent === undefined || !(await this.#deps.budgets.canManage(by, parentId))) throw new DomainError("forbidden", `${by.id} may not cancel that swarm`);
    const links = await this.#links(parent.projectId);
    const order: string[] = [];
    const visit = (id: string): void => { for (const l of links) if (l.parentTaskId === id) { visit(l.id); order.push(l.id); } };
    visit(parentId);
    const settled: string[] = [];
    const pending: string[] = [];
    for (const childId of order) {
      const task = await this.#deps.projects.getTask(childId);
      if (task === undefined || task.state === "cancelled" || task.state === "done") { settled.push(childId); continue; }
      // Authority over the child's allowance is checked before anything is stopped, so a child is never left stopped but uncancelled.
      const parentOfChild = links.find((l) => l.id === childId)?.parentTaskId;
      if (parentOfChild === undefined || !(await this.#deps.budgets.canManage(by, parentOfChild))) { pending.push(childId); continue; }
      const stop = await this.#deps.stops.request(by, { commandId: `swc-${command.commandId}-${childId}`, scope: { kind: "task", id: childId }, mode: "stop", reason });
      const advanced = await this.#deps.stops.advance(by, { intentId: stop.intentId });
      if (advanced.outcome === undefined || advanced.outcome.state === "recovery-required") { pending.push(childId); continue; }
      // What a child did not use goes back before it is cancelled; a caller who cannot take it back leaves the child as it is, so a later call by someone who can still finds it.
      const reclaimed = await this.#deps.budgets.reclaim(by, { commandId: `swr-${command.commandId}-${childId}`, taskId: childId }).then(() => true, (error: unknown) => { if (error instanceof DomainError && ["forbidden", "not_found"].includes(error.code)) return false; throw error; });
      if (!reclaimed) { pending.push(childId); continue; }
      const fresh = (await this.#deps.projects.getTask(childId))!;
      if (!FINAL.has(fresh.state)) await this.#deps.projects.transitionTask({ commandId: `swt-${command.commandId}-${childId}`, actor: by.id, taskId: childId, expectedRevision: fresh.revision, to: "cancelled" } as never);
      settled.push(childId);
    }
    return { settled, pending };
  }

  async #links(projectId: string): Promise<View<SwarmLinkBody>[]> {
    const out: View<SwarmLinkBody>[] = [];
    for (let after: string | undefined, pages = 0; pages < 40; pages++) {
      const page = await this.#runner.list(LINK, { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const a of page) { after = a.id; if ((a.body as unknown as SwarmLinkBody).projectId === projectId) out.push(view<SwarmLinkBody>(a)); }
      if (page.length < 500) break;
    }
    return out;
  }

  async #depth(taskId: string): Promise<number> {
    let depth = 0;
    for (let id = taskId; depth < 50; depth++) {
      const link = await this.#runner.get(LINK, id);
      if (link === undefined) return depth;
      id = (link.body as unknown as SwarmLinkBody).parentTaskId;
    }
    return depth;
  }

  /** Claims one of the parent's places for the child, or refuses when its live children (linked or claimed) are at the limit; a spawn that meets another's claim at the same moment counts again. */
  async #reserve(parentId: string, childId: string, max: number): Promise<void> {
    const ref: AggregateRef = { kind: GATE, id: parentId };
    for (let attempt = 0; ; attempt++) {
      const gate = await this.#runner.get(GATE, parentId);
      const claimed = ((gate?.body as { children?: string[] } | undefined)?.children) ?? [];
      if (claimed.includes(childId)) return;
      const parent = await this.#deps.projects.getTask(parentId);
      const known = new Set(claimed);
      if (parent !== undefined) for (const l of await this.#links(parent.projectId)) if (l.parentTaskId === parentId) known.add(l.id);
      known.delete(childId);
      const live: string[] = [];
      for (const id of known) if (!FINAL.has((await this.#deps.projects.getTask(id))?.state ?? "cancelled")) live.push(id);
      if (live.length >= max) throw new DomainError("invalid_command", `a task may have at most ${max} live children`, { field: "parentTaskId" });
      const body = { children: [...live.filter((id) => claimed.includes(id)), childId] } as unknown as JsonObject;
      try {
        await this.#runner.command("swarm.reserve", { commandId: `swg-${childId}`, actor: "system" }, async () => ({
          payload: { childId, parentId },
          build: async (): Promise<Built> => ({
            ref, creates: gate === undefined,
            changes: [gate === undefined ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: gate.revision, body }],
            detail: { childId },
            contention: async () => new DomainError("stale_revision", "another spawn claimed a place at the same moment"),
          }),
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "stale_revision") || attempt >= 50) throw error;
      }
    }
  }

  /** A child made before a refusal does not stay behind as a task with no allowance. When it cannot be cancelled its claim is dropped from the parent's gate record instead, so an unlinked orphan never holds a place for good. */
  async #abandon(by: Principal, childId: string, parentId: string): Promise<void> {
    const task = await this.#deps.projects.getTask(childId);
    if (task === undefined || FINAL.has(task.state)) return;
    const cancelled = await this.#deps.projects.transitionTask({ commandId: scopedCommandId(by.id, `swarm-abandon:${childId}`), actor: by.id, taskId: childId, expectedRevision: task.revision, to: "cancelled" } as never).then(() => true, () => false);
    if (!cancelled) await this.#release(parentId, childId).catch(() => undefined);
  }

  /** Removes one child's claim from the parent's gate record. */
  async #release(parentId: string, childId: string): Promise<void> {
    const ref: AggregateRef = { kind: GATE, id: parentId };
    for (let attempt = 0; ; attempt++) {
      const gate = await this.#runner.get(GATE, parentId);
      const claimed = ((gate?.body as { children?: string[] } | undefined)?.children) ?? [];
      if (gate === undefined || !claimed.includes(childId)) return;
      try {
        await this.#runner.command("swarm.release", { commandId: `swr-${childId}`, actor: "system" }, async () => ({
          payload: { childId, parentId },
          build: async (): Promise<Built> => ({
            ref, creates: false,
            changes: [{ type: "update", ref, expectedRevision: gate.revision, body: { children: claimed.filter((id) => id !== childId) } as unknown as JsonObject }],
            detail: { childId },
            contention: async () => new DomainError("stale_revision", "another spawn changed the claims at the same moment"),
          }),
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "stale_revision") || attempt >= 50) throw error;
      }
    }
  }
}

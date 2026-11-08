import { DomainError } from "../domain/errors.js";
import { onlyKnown, projectId as checkProjectId, taskId as checkTaskId, text, type View } from "../domain/model.js";
import { CommandRunner, view, type Built, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import type { BudgetService } from "../budgets/budgets.js";
import type { StopService } from "../lifecycle/stop.js";
import type { ContractService } from "../planning/contracts.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { SWARM_LIMIT_DEFAULTS, type SwarmLimits, type SwarmLimitsService } from "./limits.js";

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
  readonly stops: Pick<StopService, "request" | "advance" | "holding">;
  /** The owner's limits, read at every spawn (card H10). Without it, `limits` or the defaults apply. */
  readonly settings?: Pick<SwarmLimitsService, "effective">;
  /** Fixed limits (tests and embedders): levels, live children of one parent and, optionally, children of one parent in all. */
  readonly limits?: { readonly depth: number; readonly children: number; readonly total?: number };
}

const LINK = "swarm-link";
/** The children a parent has claimed a place for (kind `swarm-gate`, ID = the parent task); its revision serialises concurrent spawns, and `sealed` (set while its swarm is cancelled) refuses new ones. */
const GATE = "swarm-gate";
/** The budget's own link (kind `budget-link`, ID = the task): a task that has one has an allowance node. */
const BUDGET_LINK = "budget-link";
const FINAL = new Set(["done", "cancelled"]);
interface GateBody { readonly children: readonly string[]; readonly sealed?: { readonly by: string; readonly at: string } }
const gateBody = (body: unknown): GateBody => {
  const b = (body ?? {}) as { children?: unknown; sealed?: unknown };
  return { children: Array.isArray(b.children) ? (b.children as string[]) : [], ...(b.sealed === undefined || b.sealed === null ? {} : { sealed: b.sealed as { by: string; at: string } }) };
};

/**
 * Spawning and cancelling child tasks (card H10).
 *
 * - **A child exists only with an outcome, acceptance criteria and an allowance.** `spawn` needs what the parent asks for (an expected result and at least one acceptance criterion), creates
 *   the child task, writes its contract from them, and delegates part of the parent's budget to it in the same call; a parent with nothing to give, a finished parent, a task at the depth
 *   limit, one with its live children at the limit or one that has had its fan-in total of children is refused, and nothing is left live behind (a child created before a refusal is cancelled).
 *   The child spends only that allowance (R05); the link records who spawned it. The limits are the owner's (`SwarmLimitsService`), read at every spawn.
 * - **Cancelling a parent settles its swarm.** `cancel` first seals every task of the swarm (a spawn under a sealed task is refused, and a spawn that claimed its place earlier is found
 *   through its claim), then stops every descendant, deepest first, takes back what each did not use, and cancels it; it can be repeated, reports what could not be settled yet, and lets the
 *   parent spawn again only once nothing is pending.
 * - Who may spawn: the owner, or the holder of the parent's budget with `budget.manage` (the delegation says so); an agent's own authority is not widened.
 */
export class SwarmService {
  readonly #runner: CommandRunner;
  readonly #deps: SwarmDeps;

  private constructor(runner: CommandRunner, deps: SwarmDeps) { this.#runner = runner; this.#deps = deps; }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: SwarmDeps, options: RunnerOptions = {}): SwarmService {
    return new SwarmService(new CommandRunner(storage, epoch, options), deps);
  }

  async spawn(by: Principal, command: NoActor & { parentTaskId: string; title: string; expectedResult: string; acceptanceCriteria: string[]; costMicros?: number; computeMs?: number }): Promise<{ taskId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "parentTaskId", "title", "expectedResult", "acceptanceCriteria", "costMicros", "computeMs"]);
    const parentId = checkTaskId(command.parentTaskId);
    const title = text(command.title, "title", { min: 1, max: 200 });
    // The parent assigns the outcome and how it is accepted; a child without them is not made.
    if (typeof command.expectedResult !== "string" || command.expectedResult.trim() === "") throw new DomainError("invalid_command", "expectedResult: say what the child must deliver", { field: "expectedResult" });
    if (!Array.isArray(command.acceptanceCriteria) || command.acceptanceCriteria.length === 0) throw new DomainError("invalid_command", "acceptanceCriteria: give at least one check the child's result must pass", { field: "acceptanceCriteria" });
    // Who may is settled before anything is made or any limit is reported (a foreign task answers like a missing one).
    const parent = await this.#deps.projects.getTask(parentId);
    if (parent === undefined || !(await this.#deps.budgets.canManage(by, parentId)) || !(by.kind === "owner" || allows(by, "task.create", parent.projectId))) throw new DomainError("forbidden", `${by.id} may not spawn from that task`);
    if (FINAL.has(parent.state)) throw new DomainError("invalid_command", `a ${parent.state} task spawns nothing`, { field: "parentTaskId" });
    const limits = await this.#limits();
    if ((await this.#depth(parentId)) + 1 > limits.depth) throw new DomainError("invalid_command", limits.depth === 0 ? "the owner allows no child tasks now (swarm depth 0)" : `a task may spawn at most ${limits.depth} levels deep`, { field: "parentTaskId" });
    const created = await this.#deps.projects.createTask({ commandId: scopedCommandId(by.id, `${command.commandId}:child`), actor: by.id, projectId: parent.projectId, title } as never);
    const childId = created.id;
    // A child an earlier, refused call made and cancelled is not given an allowance by a retry: a refused spawn is asked again with a new command ID.
    if (created.replayed && (await this.#runner.get(LINK, childId)) === undefined && (await this.#deps.projects.getTask(childId))?.state === "cancelled") throw new DomainError("invalid_command", "that spawn was refused earlier; ask again with a new command ID", { field: "commandId" });
    // A replay of a spawn that completed finds the child already linked and has nothing more to do.
    if (created.replayed && (await this.#runner.get(LINK, childId)) !== undefined) return { taskId: childId, replayed: true };
    // The count and the claim of a place commit together (a check on the parent's gate record), so spawns sent at the same moment cannot all pass, and none passes a sealed parent.
    await this.#reserve(parentId, childId, limits).catch(async (error: unknown) => { await this.#abandon(by, childId, parentId); throw error; });
    try {
      await this.#deps.contracts.setContract(by, { commandId: scopedCommandId(by.id, `${command.commandId}:contract`), taskId: childId, expectedVersion: 0, expectedResult: command.expectedResult, acceptanceCriteria: command.acceptanceCriteria } as never)
        .catch((error: unknown) => { if (!(error instanceof DomainError && error.code === "stale_revision")) throw error; });
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
    // A cancel of the swarm that met this child after its claim has cancelled it: what it was given goes back, and the spawn says so.
    if (FINAL.has((await this.#deps.projects.getTask(childId))?.state ?? "cancelled")) {
      await this.#deps.budgets.reclaim(by, { commandId: `${command.commandId}:returned`, taskId: childId }).catch(() => undefined);
      throw new DomainError("invalid_command", "the parent's swarm was cancelled while this child was being made; the child is cancelled and its allowance went back", { field: "parentTaskId" });
    }
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
   * Every task of the swarm is sealed first, so no child is added while it is cancelled; the parent itself may spawn again once a call ends with nothing pending.
   */
  async cancel(by: Principal, command: NoActor & { parentTaskId: string; reason: string }): Promise<{ settled: string[]; pending: string[] }> {
    onlyKnown(command, ["commandId", "parentTaskId", "reason"]);
    const parentId = checkTaskId(command.parentTaskId);
    const reason = text(command.reason, "reason", { min: 1, max: 500 });
    const parent = await this.#deps.projects.getTask(parentId);
    if (parent === undefined || !(await this.#deps.budgets.canManage(by, parentId))) throw new DomainError("forbidden", `${by.id} may not cancel that swarm`);
    // Seal, then look again: a child claimed before its parent was sealed is found on the next look and sealed too, until nothing new appears (a spawn under a sealed task is refused).
    const sealed = new Set<string>();
    let tree = new Map<string, { parent: string; linked: boolean }>();
    for (let round = 0; round < 20; round++) {
      tree = await this.#descendants(parentId, parent.projectId);
      const fresh = [parentId, ...tree.keys()].filter((id) => !sealed.has(id));
      if (fresh.length === 0) break;
      for (const id of fresh) { await this.#mark(id, true, by.id); sealed.add(id); }
    }
    const order: string[] = [];
    const visit = (id: string): void => { for (const [child, info] of tree) if (info.parent === id) { visit(child); order.push(child); } };
    visit(parentId);
    const settled: string[] = [];
    const pending: string[] = [];
    for (const childId of order) {
      const task = await this.#deps.projects.getTask(childId);
      if (task === undefined || task.state === "cancelled" || task.state === "done") { settled.push(childId); continue; }
      // Authority over the child's allowance is checked before anything is stopped, so a child is never left stopped but uncancelled.
      const parentOfChild = tree.get(childId)!.parent;
      if (!(await this.#deps.budgets.canManage(by, parentOfChild))) { pending.push(childId); continue; }
      // A Stop of the child already under way (an earlier cancel that could not finish it) is carried on rather than asked for again.
      const under = await this.#deps.stops.holding(childId);
      const intentId = under?.mode === "stop" ? under.intentId : (await this.#deps.stops.request(by, { commandId: `swc-${command.commandId}-${childId}`, scope: { kind: "task", id: childId }, mode: "stop", reason })).intentId;
      const advanced = await this.#deps.stops.advance(by, { intentId });
      if (advanced.outcome === undefined || advanced.outcome.state === "recovery-required") { pending.push(childId); continue; }
      // What a child did not use goes back before it is cancelled; a caller who cannot take it back leaves the child as it is, so a later call by someone who can still finds it.
      // A child still being made (claimed, not given its allowance yet) has nothing to take back: it is cancelled, and its spawn gives back what it hands over after that.
      const hasAllowance = (await this.#runner.get(BUDGET_LINK, childId)) !== undefined;
      const reclaimed = !hasAllowance || await this.#deps.budgets.reclaim(by, { commandId: `swr-${command.commandId}-${childId}`, taskId: childId }).then(() => true, (error: unknown) => { if (error instanceof DomainError && ["forbidden", "not_found"].includes(error.code)) return false; throw error; });
      if (!reclaimed) { pending.push(childId); continue; }
      const fresh = (await this.#deps.projects.getTask(childId))!;
      if (!FINAL.has(fresh.state)) await this.#deps.projects.transitionTask({ commandId: `swt-${command.commandId}-${childId}`, actor: by.id, taskId: childId, expectedRevision: fresh.revision, to: "cancelled" } as never);
      // A spawn may hand the allowance over after it was looked at above and see the child still live before it is cancelled here; then neither side would take it back. Looking again after
      // the cancel closes that gap: a hand-over before the cancel is seen here, one after it is seen by the spawn (taking back twice returns nothing the second time).
      if (!hasAllowance && (await this.#runner.get(BUDGET_LINK, childId)) !== undefined) {
        await this.#deps.budgets.reclaim(by, { commandId: `swr2-${command.commandId}-${childId}`, taskId: childId }).catch((error: unknown) => { if (!(error instanceof DomainError && ["forbidden", "not_found"].includes(error.code))) throw error; });
      }
      settled.push(childId);
    }
    if (pending.length === 0) await this.#mark(parentId, false, by.id);
    return { settled, pending };
  }

  async #limits(): Promise<SwarmLimits> {
    if (this.#deps.settings !== undefined) return this.#deps.settings.effective();
    const fixed = this.#deps.limits;
    if (fixed === undefined) return SWARM_LIMIT_DEFAULTS;
    return { depth: fixed.depth, liveChildren: fixed.children, ...(fixed.total === undefined ? {} : { totalChildren: fixed.total }) };
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

  /** Every descendant of a task with its parent: linked children and children claimed on a parent's gate but not linked yet (a spawn in progress, or one that crashed). */
  async #descendants(rootId: string, projectId: string): Promise<Map<string, { parent: string; linked: boolean }>> {
    const links = await this.#links(projectId);
    const out = new Map<string, { parent: string; linked: boolean }>();
    const queue = [rootId];
    while (queue.length > 0 && out.size < 5000) {
      const id = queue.shift()!;
      const linked = links.filter((l) => l.parentTaskId === id).map((l) => l.id);
      const claimed = gateBody((await this.#runner.get(GATE, id))?.body).children;
      for (const child of [...linked, ...claimed]) {
        if (child === rootId || out.has(child)) continue;
        out.set(child, { parent: id, linked: linked.includes(child) });
        queue.push(child);
      }
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

  /**
   * Claims one of the parent's places for the child, or refuses: the parent is sealed (its swarm is being cancelled), its live children (linked or claimed) are at the limit, or it has had
   * its fan-in total of children (linked, or claimed and not finished). A spawn that meets another's claim at the same moment counts again.
   */
  async #reserve(parentId: string, childId: string, limits: SwarmLimits): Promise<void> {
    const ref: AggregateRef = { kind: GATE, id: parentId };
    for (let attempt = 0; ; attempt++) {
      const gate = await this.#runner.get(GATE, parentId);
      const current = gateBody(gate?.body);
      const claimed = current.children;
      if (claimed.includes(childId)) return;
      if (current.sealed !== undefined) throw new DomainError("invalid_command", "the parent's swarm is being cancelled; no child is made until that finishes", { field: "parentTaskId" });
      const parent = await this.#deps.projects.getTask(parentId);
      const linked = new Set<string>();
      if (parent !== undefined) for (const l of await this.#links(parent.projectId)) if (l.parentTaskId === parentId) linked.add(l.id);
      const known = new Set([...claimed, ...linked]);
      known.delete(childId);
      const live: string[] = [];
      for (const id of known) if (!FINAL.has((await this.#deps.projects.getTask(id))?.state ?? "cancelled")) live.push(id);
      if (live.length >= limits.liveChildren) throw new DomainError("invalid_command", limits.liveChildren === 0 ? "the owner allows no new child tasks now (live children 0)" : `a task may have at most ${limits.liveChildren} live children`, { field: "parentTaskId" });
      // The fan-in: every linked child counts, finished or not; a claimed one counts while it is live (a refused spawn's cancelled child does not).
      const total = new Set([...linked, ...live]).size;
      if (limits.totalChildren !== undefined && total >= limits.totalChildren) throw new DomainError("invalid_command", `a task may have at most ${limits.totalChildren} children in all (the owner's fan-in limit)`, { field: "parentTaskId" });
      const body = { ...current, children: [...live.filter((id) => claimed.includes(id)), childId] } as unknown as JsonObject;
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

  /** Seals (no new child) or opens a task's gate. The command ID names the revision it was decided on, so a repeat is a no-op and a later change is a new command. */
  async #mark(taskId: string, seal: boolean, actor: string): Promise<void> {
    const ref: AggregateRef = { kind: GATE, id: taskId };
    for (let attempt = 0; ; attempt++) {
      const gate = await this.#runner.get(GATE, taskId);
      const current = gateBody(gate?.body);
      if ((current.sealed !== undefined) === seal) return;
      const { sealed: _s, ...rest } = current; void _s;
      const body = (seal ? { ...rest, sealed: { by: actor, at: this.#runner.now() } } : rest) as unknown as JsonObject;
      try {
        await this.#runner.command(seal ? "swarm.seal" : "swarm.open", { commandId: `sw${seal ? "s" : "o"}-${taskId}-r${gate?.revision ?? 0}`, actor }, async () => ({
          payload: { taskId },
          build: async (): Promise<Built> => ({
            ref, creates: gate === undefined,
            changes: [gate === undefined ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: gate.revision, body }],
            detail: { taskId },
            contention: async () => new DomainError("stale_revision", "a spawn changed the claims at the same moment"),
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

  /** Removes one child's claim from the parent's gate record (a seal on it stays). */
  async #release(parentId: string, childId: string): Promise<void> {
    const ref: AggregateRef = { kind: GATE, id: parentId };
    for (let attempt = 0; ; attempt++) {
      const gate = await this.#runner.get(GATE, parentId);
      const current = gateBody(gate?.body);
      if (gate === undefined || !current.children.includes(childId)) return;
      try {
        await this.#runner.command("swarm.release", { commandId: `swr-${childId}`, actor: "system" }, async () => ({
          payload: { childId, parentId },
          build: async (): Promise<Built> => ({
            ref, creates: false,
            changes: [{ type: "update", ref, expectedRevision: gate.revision, body: { ...current, children: current.children.filter((id) => id !== childId) } as unknown as JsonObject }],
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

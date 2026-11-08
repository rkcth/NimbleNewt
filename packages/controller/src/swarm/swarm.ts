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
/** How often a change to a gate record that met another at the same moment reads again and tries again: above the most live children a parent may have, so spawns at once never run out. */
const GATE_TRIES = 400;
/** `sealed.roots`: the tasks whose swarm cancels hold the seal (a gate stays sealed while any does, so an inner cancel that ends does not reopen a task an outer cancel still holds). */
interface Seal { readonly by: string; readonly at: string; readonly roots?: readonly string[] }
interface GateBody { readonly children: readonly string[]; readonly sealed?: Seal }
const gateBody = (body: unknown): GateBody => {
  const b = (body ?? {}) as { children?: unknown; sealed?: unknown };
  return { children: Array.isArray(b.children) ? (b.children as string[]) : [], ...(b.sealed === undefined || b.sealed === null ? {} : { sealed: b.sealed as Seal }) };
};

/**
 * Spawning and cancelling child tasks (card H10).
 *
 * - **A child exists only with an outcome, acceptance criteria and an allowance.** `spawn` needs what the parent asks for (an expected result and at least one acceptance criterion), creates
 *   the child task, writes its contract from them, and delegates part of the parent's budget to it in the same call; a parent with nothing to give, a finished parent, a task at the depth
 *   limit, one with its live children at the limit or one that has had its fan-in total of children is refused, and nothing is left live behind (a child created before a refusal is cancelled).
 *   The child spends only that allowance (R05); the link records who spawned it. The limits are the owner's (`SwarmLimitsService`), read at every spawn.
 * - **Cancelling a parent settles its swarm.** `cancel` first seals every task of the swarm (a spawn under a sealed task is refused, and a spawn that claimed its place earlier is found
 *   through its claim), then stops every descendant, deepest first, cancels it and takes back what it did not use (also from children already finished or cancelled); it can be repeated,
 *   reports what could not be settled yet, and lets the parent spawn again only once nothing is pending and no enclosing swarm's cancel still holds it. A cancelled task is given no allowance.
 * - Who may spawn: the owner, or the holder of the parent's budget with `budget.manage` (the delegation says so); an agent's own authority is not widened.
 */
export class SwarmService {
  readonly #runner: CommandRunner;
  readonly #deps: SwarmDeps;
  readonly #pause: (attempt: number) => Promise<void>;

  private constructor(runner: CommandRunner, deps: SwarmDeps, pause: (attempt: number) => Promise<void>) { this.#runner = runner; this.#deps = deps; this.#pause = pause; }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: SwarmDeps, options: RunnerOptions = {}): SwarmService {
    // A gate record is one row that every spawn under a parent and every cancel of its swarm changes, so a loser waits a short random time before it reads again (card H10 review: up to
    // 64 spawns at once under one parent otherwise ran out of tries and were refused for no reason but the race).
    return new SwarmService(new CommandRunner(storage, epoch, options), deps, options.pause ?? ((attempt) => new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(25, attempt * 2)))));
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
      // A cancel of the swarm that met this child before its allowance was handed over has cancelled it, and a cancelled task is given no allowance: the spawn says so plainly.
      if ((await this.#deps.projects.getTask(childId))?.state === "cancelled" && error instanceof DomainError && error.code === "invalid_command" && /is given no allowance/.test(error.message)) {
        throw new DomainError("invalid_command", "the parent's swarm was cancelled while this child was being made; the child is cancelled and was given no allowance", { field: "parentTaskId" });
      }
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
      for (const id of fresh) { await this.#mark(id, true, by.id, parentId); sealed.add(id); }
    }
    const order: string[] = [];
    const visit = (id: string): void => { for (const [child, info] of tree) if (info.parent === id) { visit(child); order.push(child); } };
    visit(parentId);
    const settled: string[] = [];
    const pending: string[] = [];
    for (const childId of order) {
      const task = await this.#deps.projects.getTask(childId);
      if (task === undefined) { settled.push(childId); continue; }
      // A child that finished or was cancelled earlier (by an earlier pass, its spawn's refusal or another path) may still hold allowance it did not use: a hold settled since, or what a
      // finished child left. It goes back now; taking back is repeat-safe (a second time returns only what has come free since).
      if (FINAL.has(task.state)) { await this.#takeBack(by, `swr-${command.commandId}-${childId}`, childId); settled.push(childId); continue; }
      // Authority over the child's allowance is checked before anything is stopped, so a child is never left stopped but uncancelled.
      const parentOfChild = tree.get(childId)!.parent;
      if (!(await this.#deps.budgets.canManage(by, parentOfChild))) { pending.push(childId); continue; }
      // A Stop of the child already under way (an earlier cancel that could not finish it) is carried on rather than asked for again.
      const intentId = await this.#stopOf(by, `swc-${command.commandId}-${childId}`, childId, reason);
      if (intentId === "final") { await this.#takeBack(by, `swr-${command.commandId}-${childId}`, childId); settled.push(childId); continue; }
      if (intentId === undefined) { pending.push(childId); continue; }
      const advanced = await this.#deps.stops.advance(by, { intentId });
      if (advanced.outcome === undefined || advanced.outcome.state === "recovery-required") { pending.push(childId); continue; }
      // The child is cancelled first and what it did not use is taken back after (card H10 review). Taking back lowers its limit to what it used, and a limit of 0 reads as none, so a child
      // that stayed live after a take-back (a cancel that then failed) could spend without limit. And a delegation is refused to a cancelled task, checked on the task's revision in
      // the same step, so once the child is cancelled every allowance it will ever have is already there: a child still being made (claimed, its spawn not yet past the hand-over) is
      // either given its allowance before the cancel, and it is taken back here, or refused it after.
      const fresh = (await this.#deps.projects.getTask(childId))!;
      // A cancel of the same swarm that cancelled the child between the read and the change has done what this one would.
      if (!FINAL.has(fresh.state)) await this.#deps.projects.transitionTask({ commandId: `swt-${command.commandId}-${childId}`, actor: by.id, taskId: childId, expectedRevision: fresh.revision, to: "cancelled" } as never)
        .catch(async (error: unknown) => { if (!FINAL.has((await this.#deps.projects.getTask(childId))?.state ?? "")) throw error; });
      await this.#takeBack(by, `swr-${command.commandId}-${childId}`, childId);
      settled.push(childId);
    }
    // Only this cancel's own seal is let go of: a cancel of an enclosing swarm still under way keeps the parent closed.
    if (pending.length === 0) await this.#mark(parentId, false, by.id, parentId);
    return { settled, pending };
  }

  /**
   * The Stop that ends a child: one already under way is carried on, else one is asked for. Another cancel of the same swarm sent at the same moment may be asking at the same time (its
   * pause or its Stop lands between this one's look and its request, which is then refused): this one looks again and carries that Stop on, settles the child when that
   * cancel has already finished it (`final`), or, when neither shows yet, leaves the child pending for the next call (`undefined`) rather than failing the whole cancel (card H10 review).
   */
  async #stopOf(by: Principal, commandId: string, childId: string, reason: string): Promise<string | undefined> {
    for (let attempt = 1; ; attempt++) {
      const under = await this.#deps.stops.holding(childId);
      if (under?.mode === "stop") return under.intentId;
      try { return (await this.#deps.stops.request(by, { commandId, scope: { kind: "task", id: childId }, mode: "stop", reason })).intentId; } catch (error) {
        // "Already paused" or "already has a stop" (invalid_command), or the Stop's own records made by the other at the same moment (stale_revision, or command_conflict on its pointer).
        if (!(error instanceof DomainError && ["invalid_command", "stale_revision", "command_conflict"].includes(error.code))) throw error;
        if (FINAL.has((await this.#deps.projects.getTask(childId))?.state ?? "cancelled")) return "final";
        if (attempt >= 3) return undefined;
        await this.#pause(attempt);
      }
    }
  }

  /** Takes back what a child holds and did not use, when it has an allowance at all; one the caller may not take back is left for someone who may. */
  async #takeBack(by: Principal, commandId: string, childId: string): Promise<void> {
    if ((await this.#runner.get(BUDGET_LINK, childId)) === undefined) return;
    await this.#deps.budgets.reclaim(by, { commandId, taskId: childId }).catch((error: unknown) => { if (!(error instanceof DomainError && ["forbidden", "not_found"].includes(error.code))) throw error; });
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
        if (!(error instanceof DomainError && error.code === "stale_revision") || attempt >= GATE_TRIES) throw error;
        await this.#pause(attempt + 1);
      }
    }
  }

  /**
   * Seals (no new child) or lets go of the seal a cancel of `root`'s swarm put on a task's gate. The gate opens when no cancel holds it any more: a nested cancel (of a swarm inside one
   * being cancelled) that ends lets go of its own seal only, so the outer cancel's stays. The command ID names the root and the revision it was decided on, so a repeat is a no-op.
   */
  async #mark(taskId: string, seal: boolean, actor: string, root: string): Promise<void> {
    const ref: AggregateRef = { kind: GATE, id: taskId };
    for (let attempt = 0; ; attempt++) {
      const gate = await this.#runner.get(GATE, taskId);
      const current = gateBody(gate?.body);
      const roots = current.sealed?.roots ?? [];
      if (seal ? current.sealed !== undefined && roots.includes(root) : current.sealed === undefined || (roots.length > 0 && !roots.includes(root))) return;
      const { sealed: _s, ...rest } = current; void _s;
      const left = seal ? [...roots, root].slice(-50) : roots.filter((r) => r !== root);
      const body = (left.length === 0 ? rest : { ...rest, sealed: { by: current.sealed?.by ?? actor, at: current.sealed?.at ?? this.#runner.now(), roots: left } }) as unknown as JsonObject;
      try {
        await this.#runner.command(seal ? "swarm.seal" : "swarm.open", { commandId: `sw${seal ? "s" : "o"}-${taskId}-${root}-r${gate?.revision ?? 0}`, actor }, async () => ({
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
        if (!(error instanceof DomainError && error.code === "stale_revision") || attempt >= GATE_TRIES) throw error;
        await this.#pause(attempt + 1);
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
        if (!(error instanceof DomainError && error.code === "stale_revision") || attempt >= GATE_TRIES) throw error;
        await this.#pause(attempt + 1);
      }
    }
  }
}

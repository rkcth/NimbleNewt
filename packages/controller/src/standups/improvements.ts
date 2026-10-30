import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, taskId as checkTaskId, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { MeetingService } from "../meetings/meetings.js";
import { canRead as deskCanRead, type DeskRecordBody } from "../context/desks.js";
import type { ArtifactBody } from "../artifacts/service.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { clean, cut, invalid, optionalPlain, plain, whole, type OutcomeSink } from "./shared.js";

/**
 * Where a proposal stands (card M03). `new` -> `investigating` or `accepted` (accepted for planning: it enters the P/PC process, which separately decides who implements and who publishes) or `deferred` or `rejected`;
 * `accepted` -> `adopted` (with its evaluation) or `stopped`; `deferred` comes back to `investigating`, `accepted` or `rejected`. Adopted, rejected and stopped are final. A proposal that was grouped under another is
 * not dispositioned separately: it shares its primary's.
 */
export type Disposition = "new" | "investigating" | "accepted" | "deferred" | "rejected" | "adopted" | "stopped";
const FINAL: readonly Disposition[] = ["rejected", "adopted", "stopped"];
const LEGAL: Readonly<Record<Disposition, readonly Disposition[]>> = {
  new: ["investigating", "accepted", "deferred", "rejected"], investigating: ["accepted", "deferred", "rejected"], accepted: ["adopted", "stopped", "deferred"], deferred: ["investigating", "accepted", "rejected"], rejected: [], adopted: [], stopped: [],
};

export interface EvidenceRef { readonly kind: "task" | "artifact" | "desk-record"; readonly id: string }

export interface ImprovementBody {
  readonly projectId: string;
  readonly title: string;
  /** What was seen: the recurring friction, in the proposer's words. No agent must invent one to fill a quota; nothing counts them. */
  readonly observation: string;
  readonly possibleImprovement?: string;
  /** Records the proposer could read when proposing; the group of duplicates keeps each proposer's own. */
  readonly evidence: readonly EvidenceRef[];
  readonly affectedTasks: readonly string[];
  readonly proposedBy: string;
  /** Who drives it (the proposer until a manager names someone else). */
  readonly owner: string;
  readonly disposition: Disposition;
  /** Required for deferred, rejected and stopped. */
  readonly reason?: string;
  readonly nextStep?: string;
  /** How long the stand-up spends on it (minutes). */
  readonly timeboxMinutes: number;
  /** The proposal this one repeats: it is discussed and decided there, and its own evidence stays here. */
  readonly groupedUnder?: string;
  /** On a primary: the proposals grouped under it (at most 50). */
  readonly duplicates?: readonly string[];
  /** The P/PC task accepted work became (set by whoever creates it; acceptance creates none and grants nothing). */
  readonly taskId?: string;
  /** What adoption was judged on: the baseline and after-change evidence, in words. Required for `adopted`. */
  readonly evaluation?: string;
  readonly agendaItemId?: string;
  readonly brought: number;
  /** A decision that the proposer (and the proposers of its duplicates) have not been told yet. */
  readonly returnPending: boolean;
  readonly returnedAt?: string;
  readonly history: readonly { readonly at: string; readonly by: string; readonly to: Disposition }[];
}

export const IMPROVEMENT_LIMITS = { title: 200, observation: 4000, proposal: 4000, reason: 500, evaluation: 4000, evidence: 10, affected: 20, timeboxDefault: 10, timeboxMax: 60, open: 200, duplicates: 50, history: 10, page: 100, retries: 8 } as const;
const IMPROVEMENT_ID = /^imp-[a-z2-7]{20}$/;
const AGENT = /^agent:[a-z0-9][a-z0-9-]{0,39}$/;
const indexId = (projectId: string): string => projectId;
interface IndexBody { readonly ids: readonly string[] }

export interface ImprovementOptions extends RunnerOptions {
  /** Where a decision goes back to the proposers. Without one, decisions stay `returnPending` and visible. */
  readonly outcomes?: OutcomeSink;
}

/**
 * The project-scoped improvement backlog (card M03): agents report recurring friction in their tools, skills, communication and workflow, with the evidence they may share, the work it affected, a possible improvement, an owner and a
 * disposition. Duplicates are grouped, never merged: each proposer's evidence stays on its own record. Discussion at the stand-up is timeboxed. A decision is handed back to every proposer of the group.
 *
 * - **Authority.** Anyone with `meeting.agenda` (or the owner) may propose; managers (and the owner) decide, group and bring a proposal to the stand-up. Evidence must be a task, artifact or desk record of this project that the proposer may read now.
 * - **Accepting grants nothing.** Acceptance is a record of "plan this"; implementation and publication authority come from the P/PC process and the toolbox rules, never from here. Nothing in this service creates a task or a grant.
 * - **Bounded.** At most 200 proposals are open (or waiting to be told of a decision) per project, kept in one index; a full index refuses with `unavailable` and the way out is to decide or deliver.
 */
export class ImprovementService {
  readonly #runner: CommandRunner;
  readonly #meetings: MeetingService;
  readonly #sink: OutcomeSink | undefined;

  private constructor(runner: CommandRunner, meetings: MeetingService, options: ImprovementOptions) {
    this.#runner = runner;
    this.#meetings = meetings;
    this.#sink = options.outcomes;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: { meetings: MeetingService }, options: ImprovementOptions = {}): ImprovementService {
    return new ImprovementService(new CommandRunner(storage, epoch, options), deps.meetings, options);
  }

  /** Records an observation as a proposal. Needs `meeting.agenda` (or `meeting.manage`) in the project, or the owner. */
  async propose(by: Principal, command: NoActor & { projectId: string; title: string; observation: string; possibleImprovement?: string; evidence?: readonly EvidenceRef[]; affectedTasks?: readonly string[]; timeboxMinutes?: number }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "projectId", "title", "observation", "possibleImprovement", "evidence", "affectedTasks", "timeboxMinutes"]);
    const projectId = checkProjectId(command.projectId);
    if (!inTaskScope(by, projectId) || !(allows(by, "meeting.agenda", projectId) || allows(by, "meeting.manage", projectId)) || (await this.#runner.get("project", projectId)) === undefined) throw new DomainError("forbidden", `${by.id} may not propose improvements in that project`);
    const title = plain(command.title, "title", IMPROVEMENT_LIMITS.title);
    const observation = plain(command.observation, "observation", IMPROVEMENT_LIMITS.observation);
    const possibleImprovement = optionalPlain(command.possibleImprovement, "possibleImprovement", IMPROVEMENT_LIMITS.proposal);
    const timeboxMinutes = command.timeboxMinutes === undefined ? IMPROVEMENT_LIMITS.timeboxDefault : whole(command.timeboxMinutes, "timeboxMinutes", 1, IMPROVEMENT_LIMITS.timeboxMax);
    const evidence = await this.#evidence(by, projectId, command.evidence);
    const affectedTasks = await this.#tasks(projectId, command.affectedTasks);
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("imp", scoped);
    const result = await this.#retrying(() => this.#runner.command("improvement.propose", { commandId: scoped, actor: by.id }, async () => ({
      payload: clean({ projectId, title, observation, possibleImprovement, evidence, affectedTasks, timeboxMinutes }),
      build: async () => {
        const index = await this.#index(projectId);
        if (index.ids.length >= IMPROVEMENT_LIMITS.open) throw new DomainError("unavailable", `${IMPROVEMENT_LIMITS.open} improvement proposals are already open in this project; decide some first`);
        const nowIso = this.#runner.now();
        const body: ImprovementBody = { projectId, title, observation, ...(possibleImprovement === undefined ? {} : { possibleImprovement }), evidence, affectedTasks, proposedBy: by.id, owner: by.id, disposition: "new", timeboxMinutes, brought: 0, returnPending: false, history: [{ at: nowIso, by: by.id, to: "new" }] };
        const ref: AggregateRef = { kind: "improvement-item", id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }, this.#indexChange(projectId, index, [...index.ids, id])], detail: { projectId } };
      },
    })));
    return { id: result.id, replayed: result.replayed };
  }

  /**
   * Groups a repeated proposal under the one that came first (or the clearer one). The duplicate keeps its own record and evidence and is no longer decided on its own; the primary lists it. Managers only. Both revisions are checked.
   */
  async group(by: Principal, command: NoActor & { itemId: string; expectedRevision: number; under: string; underRevision: number }): Promise<void> {
    onlyKnown(command, ["commandId", "itemId", "expectedRevision", "under", "underRevision"]);
    const id = this.#id(command.itemId, "itemId");
    const under = this.#id(command.under, "under");
    if (id === under) invalid("under", "a proposal cannot be grouped under itself");
    const expected = checkRevision(command.expectedRevision);
    const underRevision = checkRevision(command.underRevision);
    await this.#retrying(() => this.#runner.command("improvement.group", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { itemId: id, expectedRevision: expected, under, underRevision },
      build: async () => {
        const a = await this.#runner.get("improvement-item", id);
        const b = await this.#runner.get("improvement-item", under);
        const dup = a?.body as unknown as ImprovementBody | undefined;
        const primary = b?.body as unknown as ImprovementBody | undefined;
        if (a === undefined || b === undefined || dup === undefined || primary === undefined || !this.#mayManage(by, dup.projectId)) throw new DomainError("forbidden", `${by.id} may not group those proposals`);
        if (primary.projectId !== dup.projectId) throw new DomainError("forbidden", `${by.id} may not group those proposals`);
        if (a.revision !== expected) throw new DomainError("stale_revision", `proposal ${id} is at revision ${a.revision}, not ${expected}`, { currentRevision: a.revision });
        if (b.revision !== underRevision) throw new DomainError("stale_revision", `proposal ${under} is at revision ${b.revision}, not ${underRevision}`, { currentRevision: b.revision });
        if (dup.groupedUnder !== undefined || (dup.duplicates ?? []).length > 0) throw new DomainError("invalid_command", "a proposal that is already grouped, or has duplicates of its own, cannot be grouped again", { field: "itemId" });
        if (primary.groupedUnder !== undefined) throw new DomainError("invalid_command", "group under the primary proposal, not under a duplicate", { field: "under" });
        if (FINAL.includes(primary.disposition) || FINAL.includes(dup.disposition)) throw new DomainError("invalid_command", "a decided proposal cannot be grouped", { field: "under" });
        if ((primary.duplicates ?? []).length >= IMPROVEMENT_LIMITS.duplicates) throw new DomainError("unavailable", `${IMPROVEMENT_LIMITS.duplicates} proposals are already grouped under that one`);
        const nowIso = this.#runner.now();
        const index = await this.#index(dup.projectId);
        const refA: AggregateRef = { kind: "improvement-item", id };
        const refB: AggregateRef = { kind: "improvement-item", id: under };
        const changes: Change[] = [
          { type: "update", ref: refA, expectedRevision: a.revision, body: clean({ ...dup, groupedUnder: under, history: this.#history(dup, nowIso, by.id, dup.disposition) }) },
          { type: "update", ref: refB, expectedRevision: b.revision, body: clean({ ...primary, duplicates: [...(primary.duplicates ?? []), id] }) },
        ];
        // The duplicate is decided with its primary: it leaves the open list unless its own decision still has to be told.
        if (index.ids.includes(id) && !dup.returnPending) changes.push(this.#indexChange(dup.projectId, index, index.ids.filter((x) => x !== id)));
        return { ref: refA, creates: false, changes, detail: { projectId: dup.projectId, under } };
      },
    })));
  }

  /**
   * Records the decision on a proposal (managers and the owner): `investigating`, `accepted` (optionally with the task the P/PC process made of it), `deferred` (reason and next step), `rejected` (reason), `adopted` (the evaluation it was
   * judged on) or `stopped` (reason). Naming a new owner is allowed with it. A decision on a primary is a decision for its group. The proposers are told once (see `deliverOutcomes`).
   */
  async decide(by: Principal, command: NoActor & { itemId: string; expectedRevision: number; to: Exclude<Disposition, "new">; reason?: string; nextStep?: string; evaluation?: string; taskId?: string; owner?: string }): Promise<void> {
    onlyKnown(command, ["commandId", "itemId", "expectedRevision", "to", "reason", "nextStep", "evaluation", "taskId", "owner"]);
    const id = this.#id(command.itemId, "itemId");
    const expected = checkRevision(command.expectedRevision);
    const to = (typeof command.to === "string" && (["investigating", "accepted", "deferred", "rejected", "adopted", "stopped"] as string[]).includes(command.to) ? command.to : invalid("to", "must be investigating, accepted, deferred, rejected, adopted or stopped")) as Exclude<Disposition, "new">;
    const needsReason = to === "deferred" || to === "rejected" || to === "stopped";
    const reason = needsReason ? plain(command.reason, "reason", IMPROVEMENT_LIMITS.reason) : (command.reason === undefined ? undefined : invalid("reason", "only a deferral, a rejection or a stop carries a reason"));
    const nextStep = to === "deferred" ? plain(command.nextStep, "nextStep", IMPROVEMENT_LIMITS.reason) : (command.nextStep === undefined ? undefined : invalid("nextStep", "only a deferral carries a next step"));
    const evaluation = to === "adopted" ? plain(command.evaluation, "evaluation", IMPROVEMENT_LIMITS.evaluation) : (command.evaluation === undefined ? undefined : invalid("evaluation", "only an adoption is judged on an evaluation"));
    const owner = command.owner === undefined ? undefined : (typeof command.owner === "string" && (AGENT.test(command.owner) || command.owner === "owner") ? command.owner : invalid("owner", "must be an agent principal or owner"));
    const taskId = command.taskId === undefined ? undefined : (to === "accepted" || to === "adopted" ? checkTaskId(command.taskId) : invalid("taskId", "only an accepted or adopted proposal links its task"));
    await this.#retrying(() => this.#runner.command("improvement.decide", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: clean({ itemId: id, expectedRevision: expected, to, reason, nextStep, evaluation, taskId, owner }),
      build: async () => {
        const found = await this.#runner.get("improvement-item", id);
        const body = found?.body as unknown as ImprovementBody | undefined;
        if (found === undefined || body === undefined || !this.#mayManage(by, body.projectId)) throw new DomainError("forbidden", `${by.id} may not decide that proposal`);
        if (found.revision !== expected) throw new DomainError("stale_revision", `proposal ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
        if (body.groupedUnder !== undefined) throw new DomainError("invalid_command", `proposal ${id} is grouped under ${body.groupedUnder}; decide that one`, { field: "itemId" });
        if (!LEGAL[body.disposition].includes(to)) throw new DomainError("invalid_command", `proposal ${id} is ${body.disposition}; it cannot become ${to}`, { field: "to" });
        if (taskId !== undefined) {
          const task = await this.#runner.get("task", taskId);
          if ((task?.body as unknown as TaskBody | undefined)?.projectId !== body.projectId) invalid("taskId", "must be a task of this project");
        }
        const nowIso = this.#runner.now();
        const { reason: _r, nextStep: _n, evaluation: _e, returnedAt: _t, ...rest } = body;
        void _r; void _n; void _e; void _t;
        const next: ImprovementBody = {
          ...rest, disposition: to, owner: owner ?? body.owner, returnPending: true, history: this.#history(body, nowIso, by.id, to),
          ...(reason === undefined ? {} : { reason }), ...(nextStep === undefined ? {} : { nextStep }), ...(to === "adopted" ? { evaluation: evaluation as string } : {}),
          ...(taskId === undefined ? {} : { taskId }),
        };
        const index = await this.#index(body.projectId);
        const ref: AggregateRef = { kind: "improvement-item", id };
        // It stays on the list until the decision is told (also when final), so no decision is lost on the way.
        const changes: Change[] = [{ type: "update", ref, expectedRevision: found.revision, body: clean(next) }];
        if (!index.ids.includes(id)) {
          if (index.ids.length >= IMPROVEMENT_LIMITS.open) throw new DomainError("unavailable", `${IMPROVEMENT_LIMITS.open} improvement proposals are already open in this project; deliver decisions first`);
          changes.push(this.#indexChange(body.projectId, index, [...index.ids, id]));
        }
        return { ref, creates: false, changes, detail: { projectId: body.projectId, to } };
      },
    })));
  }

  /**
   * Puts a proposal on the stand-up agenda, timeboxed (managers and the owner). One open agenda item at a time per proposal; bringing it again after that item was dealt with makes a new one. The agenda item says which proposal it is about.
   */
  async bringToStandup(by: Principal, command: NoActor & { itemId: string; expectedRevision: number }): Promise<{ agendaItemId: string }> {
    onlyKnown(command, ["commandId", "itemId", "expectedRevision"]);
    const id = this.#id(command.itemId, "itemId");
    const expected = checkRevision(command.expectedRevision);
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get("improvement-item", id);
      const body = found?.body as unknown as ImprovementBody | undefined;
      if (found === undefined || body === undefined || !this.#mayManage(by, body.projectId)) throw new DomainError("forbidden", `${by.id} may not bring that proposal to the stand-up`);
      if (found.revision !== expected && !(attempt > 1)) throw new DomainError("stale_revision", `proposal ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
      if (body.groupedUnder !== undefined || FINAL.includes(body.disposition)) throw new DomainError("invalid_command", `proposal ${id} is ${body.groupedUnder !== undefined ? "grouped under another" : body.disposition}; it is not discussed on its own`, { field: "itemId" });
      if (body.agendaItemId !== undefined) {
        const item = await this.#meetings.agendaItem(by, body.agendaItemId);
        if (item !== undefined && (item.state === "queued" || item.state === "scheduled" || item.state === "deferred")) return { agendaItemId: body.agendaItemId };
      }
      const added = await this.#meetings.addAgendaItem(by, {
        commandId: `ib-${id}-${body.brought}`.slice(0, 120), projectId: body.projectId, topic: body.title, context: [body.observation, body.possibleImprovement === undefined ? "" : `Possible improvement: ${body.possibleImprovement}`].filter((x) => x !== "").join("\n\n").slice(0, 4000),
        requestedOutcome: "Adopt, revise, defer or stop within the timebox.", intent: "recommendation", category: "improvement", timeboxMinutes: body.timeboxMinutes, link: { kind: "improvement", id },
      });
      try {
        await this.#runner.command("improvement.bring", { commandId: `ibr:${id}:${body.brought}`, actor: by.id }, async () => ({
          payload: { itemId: id, agendaItemId: added.id, brought: body.brought },
          build: async () => {
            const ref: AggregateRef = { kind: "improvement-item", id };
            return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: clean({ ...body, agendaItemId: added.id, brought: body.brought + 1 }) }], detail: { projectId: body.projectId } };
          },
        }));
      } catch (error) {
        if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict") && attempt < IMPROVEMENT_LIMITS.retries) continue;
        throw error;
      }
      return { agendaItemId: added.id };
    }
  }

  /** Hands decisions to the proposers who have not been told (service principals only: owner, host or service). Each notice has a stable key, so a sink that sees it twice does it once; a proposal is marked told only after the sink returned. */
  async deliverOutcomes(by: Principal, projectId: string): Promise<{ delivered: string[]; waiting: string[] }> {
    if ((by.kind !== "owner" && by.kind !== "host" && by.kind !== "service") || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not deliver improvement outcomes`);
    const project = checkProjectId(projectId);
    const index = await this.#index(project);
    const delivered: string[] = [];
    const waiting: string[] = [];
    for (const id of index.ids) {
      const found = await this.#runner.get("improvement-item", id);
      const body = found?.body as unknown as ImprovementBody | undefined;
      if (found === undefined || body === undefined || !body.returnPending) continue;
      if (this.#sink === undefined) { waiting.push(id); continue; }
      const group = [body.proposedBy, ...(await Promise.all((body.duplicates ?? []).map(async (d) => ((await this.#runner.get("improvement-item", d))?.body as unknown as ImprovementBody | undefined)?.proposedBy)))].filter((x): x is string => x !== undefined);
      const text = outcomeText(body);
      let filed = true;
      for (const to of [...new Set(group)]) {
        const sent = await this.#sink.deliver({ key: `${id}:${found.revision}:${to}`, kind: "improvement-outcome", projectId: project, to: { kind: "agent", id: to }, text, refs: [{ kind: "improvement-item", id, revision: found.revision }], ...(body.taskId === undefined ? {} : { taskId: body.taskId }) });
        if (sent === false) filed = false;
      }
      if (!filed) { waiting.push(id); continue; } // not told yet: it stays pending, and is tried again
      await this.#retrying(async () => {
        const cur = await this.#runner.get("improvement-item", id);
        const b = cur?.body as unknown as ImprovementBody | undefined;
        if (cur === undefined || b === undefined || !b.returnPending) return;
        if (cur.revision !== found.revision) { waiting.push(id); return; }
        await this.#runner.command("improvement.returned", { commandId: `imr:${id}:${cur.revision}`, actor: by.id }, async () => ({
          payload: { itemId: id, revision: cur.revision },
          build: async () => {
            const idx = await this.#index(project);
            const ref: AggregateRef = { kind: "improvement-item", id };
            const { returnPending: _p, ...rest } = b;
            void _p;
            const changes: Change[] = [{ type: "update", ref, expectedRevision: cur.revision, body: clean({ ...rest, returnPending: false, returnedAt: this.#runner.now() }) }];
            if (FINAL.includes(b.disposition) && idx.ids.includes(id)) changes.push(this.#indexChange(project, idx, idx.ids.filter((x) => x !== id)));
            return { ref, creates: false, changes, detail: { projectId: project } };
          },
        }));
        delivered.push(id);
      });
    }
    return { delivered, waiting };
  }

  /** One proposal: the owner, a manager or reader of the project's meetings, or its proposer (and the proposers grouped under it). Anyone else gets `undefined`, as for one that does not exist. */
  async get(viewer: Principal, itemId: string): Promise<View<ImprovementBody> | undefined> {
    const found = typeof itemId === "string" && IMPROVEMENT_ID.test(itemId) ? await this.#runner.get("improvement-item", itemId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as ImprovementBody;
    return this.#mayRead(viewer, body.projectId) || (viewer.id === body.proposedBy && inTaskScope(viewer, body.projectId)) ? view<ImprovementBody>(found) : undefined;
  }

  /** The open proposals of a project (new, investigating, accepted, deferred, and decided ones not yet told), oldest first, paged. Needs `meeting.read` or `meeting.manage`. Grouped duplicates are not listed on their own. */
  async open(viewer: Principal, projectId: string, page: { afterId?: string; limit?: number } = {}): Promise<{ items: View<ImprovementBody>[]; next?: string } | undefined> {
    const project = checkProjectId(projectId);
    if (!this.#mayRead(viewer, project)) return undefined;
    const limit = page.limit === undefined ? 20 : whole(page.limit, "limit", 1, IMPROVEMENT_LIMITS.page);
    const index = await this.#index(project);
    const start = page.afterId === undefined ? 0 : index.ids.indexOf(page.afterId) + 1;
    if (page.afterId !== undefined && start === 0) invalid("afterId", "is not in the list");
    const items: View<ImprovementBody>[] = [];
    let pos = start;
    for (; pos < index.ids.length && items.length < limit; pos++) {
      const found = await this.#runner.get("improvement-item", index.ids[pos]!);
      if (found !== undefined && (found.body as unknown as ImprovementBody).groupedUnder === undefined) items.push(view<ImprovementBody>(found));
    }
    return { items, ...(pos < index.ids.length ? { next: index.ids[pos - 1]! } : {}) };
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  #mayRead(viewer: Principal, projectId: string): boolean { return inTaskScope(viewer, projectId) && (allows(viewer, "meeting.read", projectId) || allows(viewer, "meeting.manage", projectId)); }
  #mayManage(by: Principal, projectId: string): boolean { return inTaskScope(by, projectId) && allows(by, "meeting.manage", projectId); }
  #id(value: unknown, field: string): string { return typeof value === "string" && IMPROVEMENT_ID.test(value) ? value : invalid(field, "is not an improvement proposal ID"); }
  #history(body: ImprovementBody, at: string, by: string, to: Disposition): ImprovementBody["history"] { return [...body.history, { at, by, to }].slice(-IMPROVEMENT_LIMITS.history); }

  async #index(projectId: string): Promise<{ ids: readonly string[]; revision: number }> {
    const found = await this.#runner.get("improvement-index", indexId(projectId));
    return found === undefined ? { ids: [], revision: 0 } : { ids: (found.body as unknown as IndexBody).ids, revision: found.revision };
  }

  #indexChange(projectId: string, index: { revision: number }, ids: readonly string[]): Change {
    const ref: AggregateRef = { kind: "improvement-index", id: indexId(projectId) };
    const body = { ids: [...ids] } as unknown as JsonObject;
    return index.revision === 0 ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: index.revision, body };
  }

  /** Evidence is limited to what the proposer can read now, in this project: a task, an artifact or a desk record. Anything else, or anything unreadable, is refused the same way. */
  async #evidence(by: Principal, projectId: string, value: unknown): Promise<EvidenceRef[]> {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > IMPROVEMENT_LIMITS.evidence) return invalid("evidence", `must be a list of at most ${IMPROVEMENT_LIMITS.evidence} records`);
    const out: EvidenceRef[] = [];
    for (const [i, raw] of value.entries()) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid(`evidence[${i}]`, "must be an object with kind and id");
      onlyKnown(raw, ["kind", "id"]);
      const e = raw as { kind?: unknown; id?: unknown };
      if ((e.kind !== "task" && e.kind !== "artifact" && e.kind !== "desk-record") || typeof e.id !== "string" || e.id.length > 120) return invalid(`evidence[${i}]`, "must be a task, artifact or desk-record with an ID");
      const found = await this.#runner.get(e.kind, e.id);
      const b = found?.body as unknown as { projectId?: string } | undefined;
      let ok = found !== undefined && b?.projectId === projectId;
      if (ok && e.kind === "task") ok = by.kind === "owner" || allows(by, "task.read", projectId, { resource: { kind: "task", id: e.id } });
      if (ok && e.kind === "artifact") ok = by.kind === "owner" || allows(by, "artifact.read", projectId) || (b as unknown as ArtifactBody).taskId !== undefined && allows(by, "artifact.read", projectId, { resource: { kind: "task", id: (b as unknown as ArtifactBody).taskId as string } });
      if (ok && e.kind === "desk-record") ok = deskCanRead(by, found!.body as unknown as DeskRecordBody);
      if (!ok) return invalid(`evidence[${i}]`, "must be a record of this project that the proposer may read");
      if (!out.some((x) => x.kind === e.kind && x.id === e.id)) out.push({ kind: e.kind, id: e.id });
    }
    return out;
  }

  async #tasks(projectId: string, value: unknown): Promise<string[]> {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > IMPROVEMENT_LIMITS.affected) return invalid("affectedTasks", `must be a list of at most ${IMPROVEMENT_LIMITS.affected} tasks`);
    const out: string[] = [];
    for (const raw of value) {
      const id = checkTaskId(raw);
      // A task of another project, or none, reads the same.
      if (((await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined)?.projectId !== projectId) invalid("affectedTasks", "must be tasks of this project");
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= IMPROVEMENT_LIMITS.retries) throw error;
      }
    }
  }
}

/** What the proposers are told, from the typed record (never from model text). */
export function outcomeText(body: Pick<ImprovementBody, "title" | "disposition" | "reason" | "nextStep" | "evaluation" | "taskId">): string {
  const head = `Your improvement proposal "${cut(body.title, 120)}"`;
  switch (body.disposition) {
    case "investigating": return `${head} is being investigated.`;
    case "accepted": return `${head} was accepted for planning${body.taskId === undefined ? "" : ` (task ${body.taskId})`}. Acceptance gives no one authority to deploy or publish anything; that is decided separately.`;
    case "deferred": return `${head} was deferred: ${cut(body.reason ?? "", 300)} Next step: ${cut(body.nextStep ?? "", 300)}`;
    case "rejected": return `${head} was rejected: ${cut(body.reason ?? "", 300)}`;
    case "adopted": return `${head} was adopted. Evaluation: ${cut(body.evaluation ?? "", 600)}`;
    case "stopped": return `${head} was stopped: ${cut(body.reason ?? "", 300)}`;
    case "new": return `${head} was received.`;
  }
}

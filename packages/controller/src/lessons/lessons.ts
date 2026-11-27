import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { clean, cut, invalid, plain, whole, type OutcomeSink } from "../standups/shared.js";

/**
 * Versioned lessons (card B03, first slice): what a project's team learnt, stated once, with when it applies, the lessons it rests on, the evidence for it and where that evidence came from. A lesson is
 * proposed from observations (B02), improvement proposals (M03), submissions or reviews, evaluated by a manager of the project's meetings (or the owner), and the proposer is told the outcome.
 *
 * - **Versions.** A lesson that `revises` another is its next version (same `lineage`, `version` + 1); when it is accepted the one it revises is `superseded`. A lesson may also supersede lessons of other
 *   lineages (`supersedes`). Superseded, rejected and inconclusive lessons are final; nothing is deleted.
 * - **Links.** `dependsOn` names the lessons it rests on (its premises; they must be accepted when it is accepted); `contradicts` names lessons it disagrees with. Supersession and contradiction take effect
 *   when the lesson is accepted, not when it is only proposed.
 * - **Stale premises trigger review.** When a lesson stops holding (superseded, contradicted by an accepted lesson, or found rejected or inconclusive on review), every lesson that rests on it is marked with
 *   that stale premise in the same write, and an accepted one goes to `needs-review`. Only direct dependents are marked (bounded); a review is a manager's decision, never automatic.
 * - **Independent evidence is distinguishable.** Each piece of evidence is reduced by the controller to the events it rests on (a submission, a review, an observation's own events, or, with no event
 *   behind it, its author's own account); a piece that shares an event or an author's account with an earlier piece, or that cites another lesson's conclusion, is `derived` and names what it repeats. Only `independent` pieces are counted as independent; the proposer's own claim decides nothing.
 * - **Every candidate can finish.** A candidate, one under evaluation and one under review may be accepted, rejected or found inconclusive, each with the finding in words; rejected and inconclusive are final
 *   and leave the current list once the proposer has been told.
 * - **The proposer is told.** An evaluated outcome (accepted, rejected, inconclusive) of an agent's lesson waits (`outcomePending`) until `deliverOutcomes` has handed it to the sink, which files a notice on
 *   the lesson's task; one that cannot be filed stays pending and is tried again. A pending outcome is also carried in the proposer's next stand-up brief, and is marked told once that brief is stored
 *   (`markTold`, second slice); one still untold after some days is shown to the owner (`untold`). The proposer can always read its own lesson.
 * - **Scope.** Every link and every piece of evidence must be of the lesson's project; an agent may cite only records it can read now. Reads: the owner and holders of `meeting.read` or `meeting.manage`, and the
 *   proposer (its own lesson, without who else decided it or what rests on it). Anyone else gets what a missing record gives.
 */
export const LESSON_STATUSES = ["candidate", "evaluating", "accepted", "needs-review", "rejected", "inconclusive", "superseded"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];
const FINAL: readonly LessonStatus[] = ["rejected", "inconclusive", "superseded"];
/** What a decision may move a lesson to. `superseded` comes only from the acceptance of a lesson that supersedes it. */
const LEGAL: Readonly<Record<LessonStatus, readonly LessonStatus[]>> = {
  candidate: ["evaluating", "accepted", "rejected", "inconclusive"], evaluating: ["accepted", "rejected", "inconclusive"], accepted: ["needs-review"], "needs-review": ["accepted", "rejected", "inconclusive"],
  rejected: [], inconclusive: [], superseded: [],
};
const EVALUATED: readonly LessonStatus[] = ["accepted", "rejected", "inconclusive"];
/** Versions a later version's acceptance walks back through to the version still in force. */
const NOT_IN_FORCE: readonly LessonStatus[] = ["candidate", "evaluating", "rejected", "inconclusive"];

export const EVIDENCE_KINDS = ["observation", "submission", "review", "improvement-item", "lesson"] as const;
export type LessonEvidenceKind = (typeof EVIDENCE_KINDS)[number];
const EVIDENCE_PREFIX: Readonly<Record<LessonEvidenceKind, string>> = { observation: "obs", submission: "sbm", review: "rev", "improvement-item": "imp", lesson: "lsn" };

export interface LessonEvidence {
  readonly kind: LessonEvidenceKind;
  readonly id: string;
  readonly addedBy: string;
  readonly at: string;
  /** The events this piece rests on, as the controller worked them out (never the proposer's claim). */
  readonly events: readonly string[];
  readonly independence: "independent" | "derived";
  /** For a derived piece: the earlier piece (its position in the list) it shares an event with, or that it is another lesson's conclusion. */
  readonly repeats?: number;
  readonly why?: "same event as an earlier piece" | "same reporter's own account as an earlier piece" | "another lesson's conclusion";
}

export type StaleWhy = "superseded" | "contradicted" | "rejected" | "inconclusive";

export interface LessonBody {
  readonly projectId: string;
  readonly title: string;
  /** The lesson itself, in the proposer's words. */
  readonly statement: string;
  /** When it applies (the kind of work, tool, situation), in words. */
  readonly applicability: string;
  readonly lineage: string;
  readonly version: number;
  readonly revises?: string;
  readonly dependsOn: readonly string[];
  readonly supersedes: readonly string[];
  readonly contradicts: readonly string[];
  /** Lessons that rest on this one (written when they are proposed). */
  readonly dependents: readonly string[];
  readonly supersededBy?: string;
  readonly contradictedBy: readonly string[];
  readonly evidence: readonly LessonEvidence[];
  readonly independentEvidence: number;
  /** The task it is about (from the evidence), where the proposer's notice is filed. */
  readonly taskId?: string;
  readonly proposedBy: string;
  readonly status: LessonStatus;
  /** What the evaluation or review found, in the decider's words. */
  readonly finding?: string;
  /** Premises that stopped holding since this lesson was proposed or last accepted. */
  readonly stalePremises: readonly { readonly id: string; readonly why: StaleWhy; readonly at: string }[];
  readonly outcomePending: boolean;
  readonly outcomeToldAt?: string;
  readonly history: readonly { readonly at: string; readonly by: string; readonly to: LessonStatus; readonly cause?: string }[];
}

export const LESSON_LIMITS = {
  title: 200, statement: 2000, applicability: 1000, finding: 1000, evidence: 20, links: 5, dependents: 20, contradictedBy: 10, stale: 10, history: 10, page: 100, current: 500, retries: 8,
} as const;

const LESSON_ID = /^lsn-[a-z2-7]{20}$/;
const RECORD_ID = /^[a-z]{3}-[a-z2-7]{20}$/;
interface IndexBody { readonly ids: readonly string[] }

export interface LessonOptions extends RunnerOptions {
  /** Where an evaluated outcome goes back to the proposer. Without one, outcomes stay pending and visible. */
  readonly outcomes?: OutcomeSink;
}

export class LessonService {
  readonly #runner: CommandRunner;
  readonly #sink: OutcomeSink | undefined;

  private constructor(runner: CommandRunner, options: LessonOptions) {
    this.#runner = runner;
    this.#sink = options.outcomes;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: LessonOptions = {}): LessonService {
    return new LessonService(new CommandRunner(storage, epoch, options), options);
  }

  /**
   * Proposes a lesson (needs `meeting.agenda` or `meeting.manage` in the project, or the owner), with its evidence (1 to 20 records of this project the proposer may read), its premises, what it revises,
   * supersedes or contradicts (each at most five current lessons of this project). Nothing it supersedes or contradicts changes until it is accepted.
   */
  async propose(by: Principal, command: NoActor & { projectId: string; title: string; statement: string; applicability: string; evidence: readonly { kind: string; id: string }[]; dependsOn?: readonly string[]; revises?: string; supersedes?: readonly string[]; contradicts?: readonly string[] }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "projectId", "title", "statement", "applicability", "evidence", "dependsOn", "revises", "supersedes", "contradicts"]);
    const projectId = checkProjectId(command.projectId);
    if (!this.#mayPropose(by, projectId) || (await this.#runner.get("project", projectId)) === undefined) throw new DomainError("forbidden", `${by.id} may not propose lessons in that project`);
    const title = plain(command.title, "title", LESSON_LIMITS.title);
    const statement = plain(command.statement, "statement", LESSON_LIMITS.statement);
    const applicability = plain(command.applicability, "applicability", LESSON_LIMITS.applicability);
    const refs = this.#evidenceRefs(command.evidence, 1);
    const dependsOn = this.#ids(command.dependsOn, "dependsOn");
    const revises = command.revises === undefined ? undefined : this.#id(command.revises, "revises");
    const supersedes = [...new Set([...(revises === undefined ? [] : [revises]), ...this.#ids(command.supersedes, "supersedes")])];
    if (supersedes.length > LESSON_LIMITS.links) invalid("supersedes", `at most ${LESSON_LIMITS.links} lessons, the one it revises included`);
    const contradicts = this.#ids(command.contradicts, "contradicts");
    for (const [field, list] of [["dependsOn", dependsOn], ["contradicts", contradicts]] as const) {
      if (list.some((x) => supersedes.includes(x)) || (field === "contradicts" && list.some((x) => dependsOn.includes(x)))) invalid(field, "a lesson cannot rest on, supersede and contradict the same lesson");
    }
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("lsn", scoped);
    const result = await this.#retrying(() => this.#runner.command("lesson.propose", { commandId: scoped, actor: by.id }, async () => ({
      payload: clean({ projectId, title, statement, applicability, evidence: refs.map((r) => ({ kind: r.kind, id: r.id })), dependsOn, revises, supersedes, contradicts }),
      build: async () => {
        const nowIso = this.#runner.now();
        const evidence = await this.#evidence(by, projectId, refs, [], nowIso);
        const links = new Map<string, { found: { revision: number }; body: LessonBody }>();
        for (const [field, list] of [["dependsOn", dependsOn], ["supersedes", supersedes], ["contradicts", contradicts]] as const) {
          for (const x of list) {
            const got = await this.#lesson(x);
            if (got === undefined || got.body.projectId !== projectId || !(by.kind === "owner" || this.#mayReadLesson(by, got.body))) invalid(field, "must be lessons of this project that you may read");
            if (FINAL.includes(got!.body.status)) invalid(field, `lesson ${x} is ${got!.body.status}; name its successor or a current lesson`);
            if (field === "dependsOn" && got!.body.dependents.length >= LESSON_LIMITS.dependents && !got!.body.dependents.includes(id)) {
              // Finished lessons are never marked again, so they leave the list to make room: rejecting lessons that crowd a premise frees it, and a much-used premise is never locked by old ones.
              const live: string[] = [];
              for (const d of got!.body.dependents) { const dep = await this.#lesson(d); if (dep !== undefined && !FINAL.includes(dep.body.status)) live.push(d); }
              if (live.length >= LESSON_LIMITS.dependents) throw new DomainError("unavailable", `lesson ${x} already has ${LESSON_LIMITS.dependents} current lessons resting on it, the most kept; settle some first`);
              links.set(x, { found: got!.found, body: { ...got!.body, dependents: live } });
              continue;
            }
            links.set(x, got!);
          }
        }
        const prior = revises === undefined ? undefined : links.get(revises)!.body;
        const index = await this.#index(projectId);
        let listed = index.ids;
        if (index.ids.length >= LESSON_LIMITS.current) {
          // Finished lessons whose proposer cannot be told yet (no task, a retired proposer) stay listed, but only open lessons count against the limit, so they never lock the project. The list holds at most
          // twice the limit: when it is full, the oldest finished ones leave it (each stays readable, with its outcome still marked pending), rather than the project refusing new lessons for good.
          // The ones with no task leave first: their outcome has nowhere to be filed, whereas one with a task can still be told by the outcome loop (which reads only this list). One with a task leaves only
          // when every finished one has a task and none could be told yet (its proposer can still read it).
          const untold: string[] = [];
          const tasked: string[] = [];
          for (const x of index.ids) { const l = await this.#lesson(x); if (l !== undefined && FINAL.includes(l.body.status)) (l.body.taskId === undefined ? untold : tasked).push(x); }
          if (index.ids.length - untold.length - tasked.length >= LESSON_LIMITS.current) throw new DomainError("unavailable", `${LESSON_LIMITS.current} lessons are open in this project, the most kept; settle some first`);
          const over = index.ids.length + 1 - 2 * LESSON_LIMITS.current;
          if (over > 0) { const drop = new Set([...untold, ...tasked].slice(0, over)); listed = index.ids.filter((x) => !drop.has(x)); }
        }
        const taskId = await this.#taskOf(evidence);
        const body: LessonBody = {
          projectId, title, statement, applicability, lineage: prior?.lineage ?? id, version: prior === undefined ? 1 : prior.version + 1, ...(revises === undefined ? {} : { revises }),
          dependsOn, supersedes, contradicts, dependents: [], contradictedBy: [], evidence, independentEvidence: evidence.filter((e) => e.independence === "independent").length,
          ...(taskId === undefined ? {} : { taskId }), proposedBy: by.id, status: "candidate", stalePremises: [], outcomePending: false, history: [{ at: nowIso, by: by.id, to: "candidate" }],
        };
        const ref: AggregateRef = { kind: "lesson", id };
        const changes: Change[] = [{ type: "create", ref, body: clean(body) }, this.#indexChange(projectId, index, [...listed, id])];
        // A premise knows what rests on it, so a change to it reaches its dependents in the same write.
        for (const x of dependsOn) {
          const got = links.get(x)!;
          if (!got.body.dependents.includes(id)) changes.push({ type: "update", ref: { kind: "lesson", id: x }, expectedRevision: got.found.revision, body: clean({ ...got.body, dependents: [...got.body.dependents, id] }) });
        }
        return { ref, creates: true, changes, detail: { projectId } };
      },
    })));
    return { id: result.id, replayed: result.replayed };
  }

  /** Adds evidence to a current lesson (anyone who may propose in the project): up to 20 pieces in all; a piece already cited is skipped. Its independence is worked out against the pieces already there. */
  async addEvidence(by: Principal, command: NoActor & { lessonId: string; evidence: readonly { kind: string; id: string }[] }): Promise<{ revision: number; independentEvidence: number }> {
    onlyKnown(command, ["commandId", "lessonId", "evidence"]);
    const id = this.#id(command.lessonId, "lessonId");
    const refs = this.#evidenceRefs(command.evidence, 1);
    const result = await this.#retrying(() => this.#runner.command("lesson.evidence", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { lessonId: id, evidence: refs.map((r) => ({ kind: r.kind, id: r.id })) },
      build: async () => {
        const got = await this.#lesson(id);
        if (got === undefined || !this.#mayPropose(by, got.body.projectId) || !(by.kind === "owner" || this.#mayReadLesson(by, got.body))) throw new DomainError("not_found", "no such lesson, or none you may add evidence to");
        if (FINAL.includes(got.body.status)) throw new DomainError("invalid_command", `lesson ${id} is ${got.body.status}; evidence goes to a current lesson`, { field: "lessonId" });
        const fresh = refs.filter((r) => !got.body.evidence.some((e) => e.kind === r.kind && e.id === r.id));
        if (got.body.evidence.length + fresh.length > LESSON_LIMITS.evidence) invalid("evidence", `a lesson keeps at most ${LESSON_LIMITS.evidence} pieces of evidence`);
        const evidence = await this.#evidence(by, got.body.projectId, fresh, got.body.evidence, this.#runner.now());
        const taskId = got.body.taskId ?? (await this.#taskOf(evidence));
        const ref: AggregateRef = { kind: "lesson", id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: got.found.revision, body: clean({ ...got.body, evidence, independentEvidence: evidence.filter((e) => e.independence === "independent").length, ...(taskId === undefined ? {} : { taskId }) }) }], detail: { projectId: got.body.projectId } };
      },
    })));
    const after = await this.#lesson(id);
    return { revision: result.revision, independentEvidence: after?.body.independentEvidence ?? 0 };
  }

  /**
   * Evaluates or reviews a lesson (managers of the project's meetings, or the owner): `evaluating`, `accepted` (its premises must all be accepted; what it supersedes is superseded and what it contradicts goes
   * to review), `rejected` or `inconclusive` (final), or `needs-review` (an accepted lesson taken up again). Every outcome but `evaluating` carries the finding in words. A lesson that stops holding marks the
   * lessons resting on it in the same write.
   */
  async decide(by: Principal, command: NoActor & { lessonId: string; expectedRevision: number; to: LessonStatus; finding?: string }): Promise<{ revision: number; marked: string[] }> {
    onlyKnown(command, ["commandId", "lessonId", "expectedRevision", "to", "finding"]);
    const id = this.#id(command.lessonId, "lessonId");
    const expected = checkRevision(command.expectedRevision);
    const to = (typeof command.to === "string" && (LESSON_STATUSES as readonly string[]).includes(command.to) && command.to !== "candidate" && command.to !== "superseded" ? command.to : invalid("to", "must be evaluating, accepted, needs-review, rejected or inconclusive")) as LessonStatus;
    const finding = to === "evaluating" ? (command.finding === undefined ? undefined : plain(command.finding, "finding", LESSON_LIMITS.finding)) : plain(command.finding, "finding", LESSON_LIMITS.finding);
    let marked: string[] = [];
    const result = await this.#retrying(() => this.#runner.command("lesson.decide", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: clean({ lessonId: id, expectedRevision: expected, to, finding }),
      build: async () => {
        const got = await this.#lesson(id);
        if (got === undefined || !this.#mayManage(by, got.body.projectId)) throw new DomainError("forbidden", `${by.id} may not decide that lesson`);
        if (got.found.revision !== expected) throw new DomainError("stale_revision", `lesson ${id} is at revision ${got.found.revision}, not ${expected}`, { currentRevision: got.found.revision });
        if (!LEGAL[got.body.status].includes(to)) throw new DomainError("invalid_command", `lesson ${id} is ${got.body.status} and cannot become ${to}`, { field: "to" });
        const nowIso = this.#runner.now();
        const edits = new Edits(this.#runner);
        edits.seed(id, got);
        if (to === "accepted") {
          for (const p of got.body.dependsOn) {
            const premise = await edits.get(p);
            if (premise?.status !== "accepted") throw new DomainError("invalid_command", `premise ${p} is ${premise?.status ?? "missing"}; it must be accepted first, or this lesson revised to rest on its successor`, { field: "to" });
          }
          // A version accepted while the version it revises was never in force (a candidate) also replaces the version before that one still current: accepting version 3 over a candidate version 2 must not
          // leave version 1 accepted beside it. The walk follows `revises` through versions not in force (a candidate, one under evaluation, or one found rejected or inconclusive), at most ten steps. An
          // earlier version replaced by a version of this chain ends the walk (nothing before it is in force); one replaced by a version outside the chain (a rival) is refused, as below.
          const supersedes = [...got.body.supersedes];
          const chain = new Set<string>([id]);
          for (let step = 0, atId = got.body.revises, at = atId === undefined ? undefined : await edits.get(atId); atId !== undefined && at !== undefined && NOT_IN_FORCE.includes(at.status) && at.revises !== undefined; step++) {
            if (step >= 10) throw new DomainError("invalid_command", `lesson ${id} revises a chain of more than ten versions never accepted; settle the earlier versions first`, { field: "to" });
            chain.add(atId);
            const before = await edits.get(at.revises);
            if (before === undefined) break;
            if (before.status === "superseded") {
              if (before.supersededBy !== undefined && chain.has(before.supersededBy)) break;
              throw new DomainError("invalid_command", `an earlier version, lesson ${at.revises}, is already superseded${before.supersededBy === undefined ? "" : ` by ${before.supersededBy}`}; revise the current version instead`, { field: "to" });
            }
            if (!FINAL.includes(before.status) && !supersedes.includes(at.revises)) supersedes.push(at.revises);
            atId = at.revises;
            at = before;
          }
          for (const s of supersedes) {
            const old = await edits.get(s);
            if (old === undefined) continue;
            if (FINAL.includes(old.status)) throw new DomainError("invalid_command", `lesson ${s} is already ${old.status}${old.supersededBy === undefined ? "" : ` by ${old.supersededBy}`}; ${old.status === "superseded" ? "revise the current version instead" : "propose a new lesson instead"}`, { field: "to" });
            edits.put(s, { ...old, status: "superseded", supersededBy: id, history: [...old.history, { at: nowIso, by: by.id, to: "superseded" as const, cause: id }].slice(-LESSON_LIMITS.history) });
            await this.#stale(edits, s, "superseded", nowIso, by.id);
          }
          for (const x of got.body.contradicts) {
            const other = await edits.get(x);
            if (other === undefined || FINAL.includes(other.status)) continue;
            const contradictedBy = other.contradictedBy.includes(id) ? other.contradictedBy : [...other.contradictedBy, id].slice(-LESSON_LIMITS.contradictedBy);
            if (other.status === "accepted") {
              edits.put(x, { ...other, contradictedBy, status: "needs-review", history: [...other.history, { at: nowIso, by: by.id, to: "needs-review" as const, cause: id }].slice(-LESSON_LIMITS.history) });
              await this.#stale(edits, x, "contradicted", nowIso, by.id);
            } else edits.put(x, { ...other, contradictedBy });
          }
        }
        if (to === "accepted") {
          // The acceptance's own supersessions and contradictions can send one of its premises to review in this same write: then it cannot be accepted.
          for (const p of got.body.dependsOn) {
            const premise = await edits.get(p);
            if (premise?.status !== "accepted") throw new DomainError("invalid_command", `premise ${p} would become ${premise?.status ?? "missing"} through this acceptance; review it first, or revise this lesson`, { field: "to" });
          }
        }
        const cur = (await edits.get(id))!;
        const { finding: _f, ...rest } = cur;
        void _f;
        // Accepting again after a review clears the stale premises (the premises are all accepted now); an evaluated outcome of an agent's lesson waits to be told.
        const next: LessonBody = {
          ...rest, status: to, ...(finding === undefined ? {} : { finding }), ...(to === "accepted" ? { stalePremises: [] } : {}),
          outcomePending: EVALUATED.includes(to) ? cur.proposedBy.startsWith("agent:") : cur.outcomePending,
          history: [...cur.history, { at: nowIso, by: by.id, to }].slice(-LESSON_LIMITS.history),
        };
        edits.put(id, next);
        if (to === "rejected" || to === "inconclusive") await this.#stale(edits, id, to, nowIso, by.id);
        marked = edits.marked;
        const index = await this.#index(got.body.projectId);
        const leaving = edits.ids().filter((x) => { const b = edits.peek(x)!; return FINAL.includes(b.status) && !b.outcomePending; });
        const changes = edits.changes();
        if (leaving.some((x) => index.ids.includes(x))) changes.push(this.#indexChange(got.body.projectId, index, index.ids.filter((x) => !leaving.includes(x))));
        return { ref: { kind: "lesson", id }, creates: false, changes, detail: { projectId: got.body.projectId, to, marked: marked.length } };
      },
    })));
    return { revision: result.revision, marked };
  }

  /** One lesson: the owner, a reader or manager of the project's meetings, or its proposer (who sees its own lesson, not who else decided it or what rests on it). Anyone else gets `undefined`. */
  async get(viewer: Principal, lessonId: string): Promise<View<LessonBody> | undefined> {
    const found = typeof lessonId === "string" && LESSON_ID.test(lessonId) ? await this.#runner.get("lesson", lessonId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as LessonBody;
    if (this.#mayRead(viewer, body.projectId)) return view<LessonBody>(found);
    if (body.proposedBy === viewer.id && inTaskScope(viewer, body.projectId)) {
      const own = view<LessonBody>(found);
      return { ...own, dependents: [], history: own.history.map((h) => ({ ...h, by: h.by === viewer.id ? viewer.id : "someone else" })), evidence: own.evidence.map((e) => ({ ...e, addedBy: e.addedBy === viewer.id ? viewer.id : "someone else", events: e.events.map((x) => (x.startsWith("account:") && x !== `account:${viewer.id}` ? "account:someone else" : x)) })) };
    }
    return undefined;
  }

  /** The current lessons of a project (candidates, under evaluation, accepted, under review, and finished ones whose outcome the proposer has not been told yet), oldest first, paged. `status` keeps one status. */
  async current(viewer: Principal, projectId: string, page: { afterId?: string; limit?: number; status?: string } = {}): Promise<{ items: View<LessonBody>[]; next?: string } | undefined> {
    const project = checkProjectId(projectId);
    if (!this.#mayRead(viewer, project)) return undefined;
    const limit = page.limit === undefined ? 20 : whole(page.limit, "limit", 1, LESSON_LIMITS.page);
    const status = page.status === undefined ? undefined : ((LESSON_STATUSES as readonly string[]).includes(page.status) ? page.status : invalid("status", `must be one of ${LESSON_STATUSES.join(", ")}`));
    const index = await this.#index(project);
    const start = page.afterId === undefined ? 0 : index.ids.indexOf(page.afterId) + 1;
    if (page.afterId !== undefined && start === 0) invalid("afterId", "is not in the list");
    const items: View<LessonBody>[] = [];
    let pos = start;
    for (; pos < index.ids.length && items.length < limit; pos++) {
      const found = await this.#runner.get("lesson", index.ids[pos]!);
      if (found !== undefined && (status === undefined || (found.body as unknown as LessonBody).status === status)) items.push(view<LessonBody>(found));
    }
    return { items, ...(pos < index.ids.length ? { next: index.ids[pos - 1]! } : {}) };
  }

  /**
   * Hands evaluated outcomes to the proposers who have not been told (owner, host or service only). Each notice has a stable key (lesson, revision, proposer), so a sink that sees it twice files it once; a
   * lesson is marked told only after the sink filed it, at the revision that was told. One that cannot be filed stays pending.
   */
  async deliverOutcomes(by: Principal, projectId: string): Promise<{ delivered: string[]; waiting: string[] }> {
    if ((by.kind !== "owner" && by.kind !== "host" && by.kind !== "service") || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not deliver lesson outcomes`);
    const project = checkProjectId(projectId);
    const delivered: string[] = [];
    const waiting: string[] = [];
    for (const id of (await this.#index(project)).ids) {
      const found = await this.#runner.get("lesson", id);
      const body = found?.body as unknown as LessonBody | undefined;
      if (found === undefined || body === undefined || !body.outcomePending) continue;
      const sent = this.#sink === undefined ? false : await this.#sink.deliver({ key: `${id}:${found.revision}:${body.proposedBy}`, kind: "lesson-outcome", projectId: project, to: { kind: "agent", id: body.proposedBy }, text: lessonOutcomeText(body), refs: [{ kind: "lesson", id, revision: found.revision }], ...(body.taskId === undefined ? {} : { taskId: body.taskId }) });
      if (sent === false) { waiting.push(id); continue; }
      if (await this.#markTold(by, project, id, found.revision)) delivered.push(id); else waiting.push(id);
    }
    return { delivered, waiting };
  }

  /**
   * The proposer has been given the outcome another way (card B03, second slice: in its stand-up brief, for a lesson with no task to file a notice on): marks it told at the revision the brief carried. A lesson
   * changed since (a newer revision) stays pending, so a later decision is told again. Owner, host or service only.
   */
  async markTold(by: Principal, lessonId: string, revision: number): Promise<boolean> {
    if ((by.kind !== "owner" && by.kind !== "host" && by.kind !== "service") || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not mark lesson outcomes told`);
    const id = this.#id(lessonId, "lessonId");
    const rev = checkRevision(revision);
    const got = await this.#lesson(id);
    if (got === undefined) return false;
    return this.#markTold(by, got.body.projectId, id, rev);
  }

  /**
   * Outcomes that have waited longer than `olderThanMs` since they were decided without reaching their proposer (owner, host or service only), so the owner can be shown them and an outcome is never lost
   * quietly. Each carries the revision it waits at, so the owner is shown it once per revision. Reads the project's current list only (at most 1000), oldest first; at most `limit` (default 50, 1 to 100).
   */
  async untold(by: Principal, projectId: string, olderThanMs: number, limit = 50): Promise<{ id: string; revision: number; title: string; status: LessonStatus; proposedBy: string; decidedAt: string }[]> {
    if ((by.kind !== "owner" && by.kind !== "host" && by.kind !== "service") || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not list untold lesson outcomes`);
    if (typeof olderThanMs !== "number" || !Number.isFinite(olderThanMs) || olderThanMs < 0) invalid("olderThanMs", "must be zero or more");
    const most = whole(limit, "limit", 1, LESSON_LIMITS.page);
    const project = checkProjectId(projectId);
    const cutoff = Date.parse(this.#runner.now()) - olderThanMs;
    const out: { id: string; revision: number; title: string; status: LessonStatus; proposedBy: string; decidedAt: string }[] = [];
    for (const id of (await this.#index(project)).ids) {
      if (out.length >= most) break;
      const got = await this.#lesson(id);
      if (got === undefined || got.body.projectId !== project || !got.body.outcomePending) continue;
      // When it was decided: the latest evaluated outcome in its history (a later move to review keeps the outcome pending and is not a new decision); the history is bounded, so the last entry otherwise.
      const h = got.body.history;
      const decidedAt = [...h].reverse().find((x) => EVALUATED.includes(x.to))?.at ?? h[h.length - 1]?.at;
      const at = decidedAt === undefined ? Number.NaN : Date.parse(decidedAt);
      if (decidedAt !== undefined && Number.isFinite(at) && at <= cutoff) out.push({ id, revision: got.found.revision, title: got.body.title, status: got.body.status, proposedBy: got.body.proposedBy, decidedAt });
    }
    return out;
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  /** Marks the lessons resting on `premise` with a stale premise; an accepted one goes to review. Direct dependents only, each at most once per premise. */
  async #stale(edits: Edits, premise: string, why: StaleWhy, nowIso: string, by: string): Promise<void> {
    const p = await edits.get(premise);
    for (const d of p?.dependents ?? []) {
      const dep = await edits.get(d);
      if (dep === undefined || FINAL.includes(dep.status) || dep.stalePremises.some((s) => s.id === premise && s.why === why)) continue;
      // A premise already marked for another reason (contradicted, then rejected on review) keeps one entry, with the newer reason.
      const stalePremises = [...dep.stalePremises.filter((s) => s.id !== premise), { id: premise, why, at: nowIso }].slice(-LESSON_LIMITS.stale);
      edits.put(d, dep.status === "accepted"
        ? { ...dep, stalePremises, status: "needs-review", history: [...dep.history, { at: nowIso, by, to: "needs-review" as const, cause: `premise ${premise} ${why}` }].slice(-LESSON_LIMITS.history) }
        : { ...dep, stalePremises });
      edits.marked.push(d);
    }
  }

  async #markTold(by: Principal, project: string, id: string, revision: number): Promise<boolean> {
    let done = false;
    await this.#retrying(async () => {
      const cur = await this.#lesson(id);
      if (cur === undefined || !cur.body.outcomePending || cur.found.revision !== revision) return;
      await this.#runner.command("lesson.told", { commandId: `lst:${id}:${revision}`, actor: by.id }, async () => ({
        payload: { lessonId: id, revision },
        build: async () => {
          const index = await this.#index(project);
          const ref: AggregateRef = { kind: "lesson", id };
          const changes: Change[] = [{ type: "update", ref, expectedRevision: revision, body: clean({ ...cur.body, outcomePending: false, outcomeToldAt: this.#runner.now() }) }];
          if (FINAL.includes(cur.body.status) && index.ids.includes(id)) changes.push(this.#indexChange(project, index, index.ids.filter((x) => x !== id)));
          return { ref, creates: false, changes, detail: { projectId: project } };
        },
      }));
      done = true;
    });
    return done;
  }

  #evidenceRefs(value: unknown, min: number): { kind: LessonEvidenceKind; id: string }[] {
    if (!Array.isArray(value) || value.length < min || value.length > LESSON_LIMITS.evidence) return invalid("evidence", `must be a list of ${min} to ${LESSON_LIMITS.evidence} records`);
    const out: { kind: LessonEvidenceKind; id: string }[] = [];
    for (const [i, raw] of value.entries()) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid(`evidence[${i}]`, "must be an object with kind and id");
      onlyKnown(raw, ["kind", "id"]);
      const e = raw as { kind?: unknown; id?: unknown };
      if (typeof e.kind !== "string" || !(EVIDENCE_KINDS as readonly string[]).includes(e.kind) || typeof e.id !== "string" || !RECORD_ID.test(e.id) || !e.id.startsWith(`${EVIDENCE_PREFIX[e.kind as LessonEvidenceKind]}-`)) return invalid(`evidence[${i}]`, `must be one of ${EVIDENCE_KINDS.join(", ")} with its ID`);
      if (!out.some((x) => x.kind === e.kind && x.id === e.id)) out.push({ kind: e.kind as LessonEvidenceKind, id: e.id });
    }
    return out;
  }

  /**
   * Resolves each new piece of evidence (it must be of this project and readable by the proposer now; missing, foreign and unreadable are refused alike) to the events it rests on, and marks it independent or
   * derived against the pieces before it.
   */
  async #evidence(by: Principal, projectId: string, refs: readonly { kind: LessonEvidenceKind; id: string }[], before: readonly LessonEvidence[], nowIso: string): Promise<LessonEvidence[]> {
    const out: LessonEvidence[] = [...before];
    for (const [i, r] of refs.entries()) {
      const found = await this.#runner.get(r.kind, r.id);
      const b = found?.body as unknown as Record<string, unknown> | undefined;
      const binding = b?.["binding"] as { projectId?: unknown; taskId?: unknown; requester?: unknown } | undefined;
      const p = r.kind === "review" ? binding?.projectId : b?.["projectId"];
      if (found === undefined || p !== projectId || !(by.kind === "owner" || this.#readable(by, r.kind, projectId, b!))) return invalid(`evidence[${i}]`, "must be a record of this project that you may read");
      const events = eventsOf(r.kind, r.id, b!);
      const earlier = r.kind === "lesson" ? -1 : out.findIndex((e) => e.kind !== "lesson" && e.events.some((x) => events.includes(x)));
      const account = earlier >= 0 && out[earlier]!.events.some((x) => events.includes(x) && x.startsWith("account:"));
      const derived = r.kind === "lesson" ? { independence: "derived" as const, why: "another lesson's conclusion" as const } : earlier >= 0 ? { independence: "derived" as const, repeats: earlier, why: account ? "same reporter's own account as an earlier piece" as const : "same event as an earlier piece" as const } : { independence: "independent" as const };
      out.push({ kind: r.kind, id: r.id, addedBy: by.id, at: nowIso, events, ...derived });
    }
    return out;
  }

  #readable(by: Principal, kind: LessonEvidenceKind, projectId: string, body: Record<string, unknown>): boolean {
    if (!inTaskScope(by, projectId)) return false;
    const taskRead = (t: unknown): boolean => typeof t === "string" && allows(by, "task.read", projectId, { resource: { kind: "task", id: t } });
    switch (kind) {
      case "observation": return this.#mayRead(by, projectId) || ((body["reporters"] as readonly string[] | undefined) ?? []).includes(by.id);
      case "submission": return body["submittedBy"] === by.id || taskRead(body["taskId"]);
      case "review": { const binding = body["binding"] as { requester?: unknown; taskId?: unknown } | undefined; return binding?.requester === by.id || taskRead(binding?.taskId); }
      case "improvement-item": return this.#mayRead(by, projectId) || body["proposedBy"] === by.id;
      case "lesson": return this.#mayReadLesson(by, body as unknown as LessonBody);
    }
  }

  /** The task the lesson is about: the first piece of evidence that names one. */
  async #taskOf(evidence: readonly LessonEvidence[]): Promise<string | undefined> {
    for (const e of evidence) {
      const b = (await this.#runner.get(e.kind, e.id))?.body as unknown as Record<string, unknown> | undefined;
      const t = e.kind === "review" ? (b?.["binding"] as { taskId?: unknown } | undefined)?.taskId : b?.["taskId"];
      if (typeof t === "string") return t;
    }
    return undefined;
  }

  async #lesson(id: string): Promise<{ found: { revision: number }; body: LessonBody } | undefined> {
    const found = await this.#runner.get("lesson", id);
    return found === undefined ? undefined : { found, body: found.body as unknown as LessonBody };
  }

  #mayPropose(by: Principal, projectId: string): boolean { return inTaskScope(by, projectId) && (allows(by, "meeting.agenda", projectId) || allows(by, "meeting.manage", projectId)); }
  #mayRead(viewer: Principal, projectId: string): boolean { return inTaskScope(viewer, projectId) && (allows(viewer, "meeting.read", projectId) || allows(viewer, "meeting.manage", projectId)); }
  #mayReadLesson(viewer: Principal, body: LessonBody): boolean { return this.#mayRead(viewer, body.projectId) || (body.proposedBy === viewer.id && inTaskScope(viewer, body.projectId)); }
  #mayManage(by: Principal, projectId: string): boolean { return inTaskScope(by, projectId) && allows(by, "meeting.manage", projectId); }
  #id(value: unknown, field: string): string { return typeof value === "string" && LESSON_ID.test(value) ? value : invalid(field, "is not a lesson ID"); }
  #ids(value: unknown, field: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > LESSON_LIMITS.links) return invalid(field, `must be a list of at most ${LESSON_LIMITS.links} lesson IDs`);
    return [...new Set(value.map((v) => this.#id(v, field)))];
  }

  async #index(projectId: string): Promise<{ ids: readonly string[]; revision: number }> {
    const found = await this.#runner.get("lesson-index", projectId);
    return found === undefined ? { ids: [], revision: 0 } : { ids: (found.body as unknown as IndexBody).ids, revision: found.revision };
  }

  #indexChange(projectId: string, index: { revision: number }, ids: readonly string[]): Change {
    const ref: AggregateRef = { kind: "lesson-index", id: projectId };
    const body = { ids: [...ids] } as unknown as JsonObject;
    return index.revision === 0 ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: index.revision, body };
  }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= LESSON_LIMITS.retries) throw error;
      }
    }
  }
}

/** The lessons one decision changes, each read once and written once at the revision read. */
class Edits {
  readonly #runner: CommandRunner;
  readonly #read = new Map<string, { revision: number; body: LessonBody }>();
  readonly #next = new Map<string, LessonBody>();
  readonly marked: string[] = [];
  constructor(runner: CommandRunner) { this.#runner = runner; }
  seed(id: string, got: { found: { revision: number }; body: LessonBody }): void { this.#read.set(id, { revision: got.found.revision, body: got.body }); }
  async get(id: string): Promise<LessonBody | undefined> {
    const changed = this.#next.get(id);
    if (changed !== undefined) return changed;
    if (!this.#read.has(id)) {
      const found = await this.#runner.get("lesson", id);
      if (found === undefined) return undefined;
      this.#read.set(id, { revision: found.revision, body: found.body as unknown as LessonBody });
    }
    return this.#read.get(id)!.body;
  }
  peek(id: string): LessonBody | undefined { return this.#next.get(id); }
  put(id: string, body: LessonBody): void { this.#next.set(id, body); }
  ids(): string[] { return [...this.#next.keys()]; }
  changes(): Change[] { return [...this.#next.entries()].map(([id, body]) => ({ type: "update", ref: { kind: "lesson", id }, expectedRevision: this.#read.get(id)!.revision, body: clean(body) })); }
}

/**
 * The events a piece of evidence rests on: a submission or review is its own event; an observation rests on its event sources. What rests on no event is someone's own account: an observation the controller
 * made is its own event, but an agent's observation with no event behind it and an improvement proposal are their author's word (`account:<author>`), so the same author's accounts, however worded, count
 * once.
 */
function eventsOf(kind: LessonEvidenceKind, id: string, body: Record<string, unknown>): string[] {
  if (kind === "observation") {
    const sources = ((body["sources"] as readonly { kind?: unknown; id?: unknown }[] | undefined) ?? []).filter((s) => s.kind === "submission" || s.kind === "review").map((s) => `${String(s.kind)}:${String(s.id)}`);
    if (sources.length > 0) return [...new Set(sources)].sort();
    const author = body["origin"] === "agent" ? (body["owner"] ?? body["reportedBy"]) : undefined;
    return [typeof author === "string" ? `account:${author}` : `observation:${id}`];
  }
  if (kind === "improvement-item" && typeof body["proposedBy"] === "string") return [`account:${body["proposedBy"]}`];
  return [`${kind}:${id}`];
}

/** What the proposer is told, from the typed record (never from model text). */
export function lessonOutcomeText(body: Pick<LessonBody, "title" | "version" | "status" | "finding">): string {
  const head = `Your lesson "${cut(body.title, 120)}" (version ${body.version})`;
  const found = cut(body.finding ?? "", 600);
  switch (body.status) {
    case "accepted": return `${head} was accepted. Finding: ${found}`;
    case "rejected": return `${head} was rejected: ${found}`;
    case "inconclusive": return `${head} was found inconclusive: ${found}`;
    default: return `${head} is ${body.status}.`;
  }
}

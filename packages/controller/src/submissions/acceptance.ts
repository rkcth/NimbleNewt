import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { artifactId as checkArtifactId, commandId as checkCommandId, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ArtifactBody } from "../artifacts/service.js";
import type { Aggregate, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { RolesOf, SubmissionBody } from "./submissions.js";
import { REVIEW_DISABLED_SINGLE_AGENT } from "./submissions.js";

/** What a deliverable is (card Q01). `operational-outcome` is the verified effect of an operation on a system (reference, system version, observation time). */
export const DELIVERABLE_TYPES = ["code", "document", "report", "design", "operational-outcome"] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];
/** The six states of one version of a deliverable. Each change of state is its own immutable event; `invalidated` is a seventh kind of event: the review was voided and the version went back to `submitted`. */
export const DELIVERABLE_STATES = ["draft", "submitted", "under-review", "accepted", "rejected", "superseded"] as const;
export type DeliverableState = (typeof DELIVERABLE_STATES)[number];
/** Who the deliverable is for. Descriptive, except `external`: a deliverable for an external audience can be accepted by the owner only. */
export const AUDIENCES = ["owner", "director", "reviewers", "project", "external"] as const;
/** Who may read it: `owner` the owner and the responsible agent; `task` also agents that may read the task; `project` also any agent that holds a role in the project. */
export const ACCESS_SCOPES = ["owner", "task", "project"] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

export interface ArtifactRef { readonly artifactId: string; readonly role: "source" | "exported"; readonly manifestDigest: string; readonly exportedFrom?: string }
export interface SubmissionRef { readonly id: string; readonly kind: string; readonly submittedBy: string; readonly tree?: string; readonly artifactDigest?: string }
export interface Outcome { readonly reference: string; readonly systemVersion: string; readonly observedAt: string }
export interface Content { readonly artifacts: readonly ArtifactRef[]; readonly submissions: readonly SubmissionRef[]; readonly outcome?: Outcome; readonly note?: string }

export interface DeliverableBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly type: DeliverableType;
  readonly title: string;
  readonly responsibleAgent: string;
  readonly audience: readonly string[];
  readonly accessScope: AccessScope;
  readonly createdBy: string;
  readonly createdAt: string;
  /** The newest version and its state (kept here so the deliverable is read in one record). */
  readonly currentVersion: number;
  readonly state: DeliverableState;
  /** The number of events recorded; the next event is `eventSeq + 1`. */
  readonly eventSeq: number;
}

export interface VersionBody {
  readonly deliverableId: string;
  readonly version: number;
  readonly state: DeliverableState;
  readonly content: Content;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly submittedBy?: string;
  readonly submittedAt?: string;
  /** The task contract version in force when it was submitted (card S10). */
  readonly contractVersion?: number;
  readonly review?: { readonly required: boolean; readonly reason?: typeof REVIEW_DISABLED_SINGLE_AGENT };
  readonly reviewer?: string;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly reason?: string;
}

export interface EventBody {
  readonly deliverableId: string;
  readonly seq: number;
  readonly version: number;
  readonly kind: DeliverableState | "invalidated";
  readonly by: string;
  readonly at: string;
  readonly reason?: string;
}

/** What the acceptance service needs from the rest of the controller. */
export interface AcceptancePorts {
  readonly rolesOf: RolesOf;
  /** The task's current contract version (0 when it has none). */
  readonly contractVersion: (taskId: string) => Promise<number>;
  /** Checks an artifact against its bytes. Absent: a deliverable that names artifacts cannot be submitted or decided (fail closed). A thrown `not_found` or `integrity` error counts as damaged. */
  readonly verifyArtifact?: (artifactId: string) => Promise<{ readonly ok: boolean; readonly problems: number }>;
  /** The other agents of the project that the acceptance service itself would let decide (director with a grant naming the project, or reviewer); none means review is disabled and only the owner decides. */
  readonly reviewersAvailableIn?: (projectId: string, workerId: string) => Promise<readonly string[]>;
  /** The deliverable IDs and submission IDs this principal was asked to review in the task. A reviewer decides only what is named here (or holds `review.decide` in the project). Absent: nobody is assigned. */
  readonly reviewAssignments?: (principalId: string, taskId: string) => Promise<readonly string[]>;
  /** Tells the owner (and says who else is affected) that a version under review or accepted was replaced. Best effort: a failure never undoes the replacement. */
  readonly notify?: (notice: { readonly commandId: string; readonly deliverableId: string; readonly text: string }) => Promise<void>;
}

const ID = /^dlv-[a-z2-7]{20}$/;
const SBM = /^sbm-[a-z2-7]{20}$/;
const AGENT = /^agent:[A-Za-z0-9._-]{1,80}$/;
const MAX_ARTIFACTS = 20;
const MAX_SUBMISSIONS = 10;
const MAX_VERSIONS = 100;
const MAX_PER_TASK = 100;
const MAX_NOTE = 4000;
const MAX_REASON = 2000;
const SKEW_MS = 5 * 60 * 1000;
const WRITERS = ["author", "docs", "qa"] as const;

const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const hidden = (what = "deliverable"): never => { throw new DomainError("not_found", `no such ${what}`); };
/** Thrown inside a decision when the version's artifacts are missing or changed: the caller voids the review, then refuses. */
class Damaged extends DomainError { constructor(message: string, readonly problems: number) { super("integrity", message); } }

type Draft = { artifacts?: unknown; submissionIds?: unknown; outcome?: unknown; note?: unknown };
interface Shape { readonly artifacts: readonly { artifactId: string; role: "source" | "exported"; exportedFrom?: string }[]; readonly submissionIds: readonly string[]; readonly outcome?: Outcome; readonly note?: string }

function shapeOf(c: Draft): Shape {
  const artifacts = c.artifacts === undefined ? [] : c.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS) bad("artifacts", `must be a list of at most ${MAX_ARTIFACTS} artifacts`);
  const seen = new Set<string>();
  const list = (artifacts as unknown[]).map((raw) => {
    const o = raw as Record<string, unknown> | null;
    if (o === null || typeof o !== "object" || Array.isArray(o)) return bad("artifacts", "each item is an object");
    for (const k of Object.keys(o)) if (!["artifactId", "role", "exportedFrom"].includes(k)) bad(`artifacts.${k}`, "is not a field of an artifact reference");
    const artifactId = checkArtifactId(o["artifactId"]);
    if (seen.has(artifactId)) bad("artifacts", `${artifactId} is listed twice`);
    seen.add(artifactId);
    const role = o["role"] === undefined ? "source" : o["role"];
    if (role !== "source" && role !== "exported") bad("artifacts.role", "must be source or exported");
    if (o["exportedFrom"] !== undefined && role !== "exported") bad("artifacts.exportedFrom", "only an exported artifact says what it was exported from");
    return { artifactId, role: role as "source" | "exported", ...(o["exportedFrom"] === undefined ? {} : { exportedFrom: checkArtifactId(o["exportedFrom"]) }) };
  });
  for (const a of list) if (a.exportedFrom !== undefined && !list.some((s) => s.artifactId === a.exportedFrom && s.role === "source")) bad("artifacts.exportedFrom", "must name a source artifact of the same version");
  const ids = c.submissionIds === undefined ? [] : c.submissionIds;
  if (!Array.isArray(ids) || ids.length > MAX_SUBMISSIONS || ids.some((i) => typeof i !== "string" || !SBM.test(i)) || new Set(ids).size !== ids.length) bad("submissionIds", `must be a list of at most ${MAX_SUBMISSIONS} different submission IDs`);
  let outcome: Outcome | undefined;
  if (c.outcome !== undefined) {
    const o = c.outcome as Record<string, unknown> | null;
    if (o === null || typeof o !== "object" || Array.isArray(o)) bad("outcome", "must be an object");
    for (const k of Object.keys(o!)) if (!["reference", "systemVersion", "observedAt"].includes(k)) bad(`outcome.${k}`, "is not a field of an outcome");
    const observedAt = text(o!["observedAt"], "outcome.observedAt", { min: 20, max: 30 });
    const ms = Date.parse(observedAt);
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== observedAt) bad("outcome.observedAt", "must be a UTC time like 2026-10-30T12:00:00.000Z");
    outcome = { reference: text(o!["reference"], "outcome.reference", { min: 1, max: 300 }), systemVersion: text(o!["systemVersion"], "outcome.systemVersion", { min: 1, max: 120 }), observedAt };
  }
  const note = c.note === undefined ? undefined : text(c.note, "note", { min: 1, max: MAX_NOTE, multiline: true });
  return { artifacts: list, submissionIds: ids as string[], ...(outcome === undefined ? {} : { outcome }), ...(note === undefined ? {} : { note }) };
}

const sameShape = (s: Shape): JsonObject => JSON.parse(JSON.stringify(s)) as JsonObject;

/**
 * Versioned deliverables and their acceptance (card Q01). A deliverable belongs to one task and records its type, responsible agent, audience and access scope. Each VERSION of it moves through
 * draft, submitted, under-review, accepted or rejected, or is superseded by a newer version; every move is one immutable event (`deliverable-event`, numbered per deliverable) written in the same
 * transaction as the move, so history is never rewritten and a rejected version stays on the record.
 *
 * - Tool completion cannot accept: acceptance is a separate command that only the owner, a director or the reviewer who started the review can give, never the responsible agent, its creator
 *   or the submitter of the linked work (no self-review); an agent decides only where review is possible (a project whose only agent is the worker has review disabled, so the owner decides).
 *   A deliverable for an external audience is accepted by the owner only.
 * - A version is submitted only with its artifacts intact and against the task contract version in force (card S10); starting a review and deciding re-check the artifacts, and a missing or
 *   changed one voids the review (an `invalidated` event returns the version to `submitted`) instead of accepting.
 * - Artifacts and submissions named by a version must belong to the same task. Source and exported artifacts are grouped under one version.
 * Not done here: gating the task's own `done` on acceptance, checking an operational outcome's reference against the effect ledger or the target system (cards P03, S05), and checking the
 * linked code submission against the landed head (cards P02, P08..P10).
 */
export class AcceptanceService {
  readonly #runner: CommandRunner;
  readonly #ports: AcceptancePorts;
  private constructor(runner: CommandRunner, ports: AcceptancePorts) { this.#runner = runner; this.#ports = ports; }

  static withEpoch(storage: ControllerStorage, epoch: number, ports: AcceptancePorts, options: RunnerOptions = {}): AcceptanceService {
    return new AcceptanceService(new CommandRunner(storage, epoch, options), ports);
  }

  // ---- access ----------------------------------------------------------------------------------------------------------------

  async #task(taskId: string): Promise<TaskBody | undefined> { return (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined; }

  /** Whether the principal may read this deliverable at all (the task's read right, narrowed or widened by the access scope). */
  async #mayRead(by: Principal, d: DeliverableBody): Promise<boolean> {
    if (by.kind === "owner") return true;
    if (by.kind !== "agent") return false;
    if (by.taskScope !== undefined && (!inTaskScope(by, d.projectId) || by.taskScope.taskId !== d.taskId)) return false;
    const own = by.id === d.responsibleAgent || by.id === d.createdBy;
    const reads = allows(by, "task.read", d.projectId, { resource: { kind: "task", id: d.taskId } });
    if (d.accessScope === "owner") return own && reads;
    if (reads) return true;
    return d.accessScope === "project" && (await this.#ports.rolesOf(by.id, { projectId: d.projectId, taskId: d.taskId }, by)).length > 0;
  }

  async #load(by: Principal, id: unknown): Promise<{ agg: Aggregate; body: DeliverableBody }> {
    if (typeof id !== "string" || !ID.test(id)) bad("id", "is not a deliverable ID");
    const agg = await this.#runner.get("deliverable", id as string);
    if (agg === undefined) return hidden();
    const body = agg.body as unknown as DeliverableBody;
    if (!(await this.#mayRead(by, body))) return hidden();
    return { agg, body };
  }

  async #version(id: string, n: number): Promise<Aggregate> {
    const v = await this.#runner.get("deliverable-version", `${id}.${n}`);
    if (v === undefined) throw new DomainError("integrity", `the record of version ${n} of ${id} is missing`);
    return v;
  }

  /** The principals that did the work behind a version: they may not review or accept it. */
  #conflicted(d: DeliverableBody, v: VersionBody): Set<string> {
    return new Set([d.responsibleAgent, d.createdBy, v.createdBy, ...(v.submittedBy === undefined ? [] : [v.submittedBy]), ...v.content.submissions.map((s) => s.submittedBy)]);
  }

  /** Whether the grant is live now. */
  #live(g: Principal["grants"][number]): boolean { return (g.expiresAt === undefined || g.expiresAt > this.#runner.now()) && !g.action.startsWith("tool."); }

  /** The agents other than the ones that did the work that the acceptance service would let decide, as of now. */
  async #deciders(d: DeliverableBody, v: VersionBody, extra?: string): Promise<readonly string[]> {
    if (this.#ports.reviewersAvailableIn === undefined) return ["unknown"];
    const conflicted = this.#conflicted(d, v);
    if (extra !== undefined) conflicted.add(extra);
    return (await this.#ports.reviewersAvailableIn(d.projectId, d.responsibleAgent)).filter((r) => !conflicted.has(r));
  }

  /**
   * Who may take a review step on a version: the owner, or an agent that did none of the work, may read the deliverable and holds a real review right here: a director with a grant naming this project
   * (not only a project-wide one), or a reviewer that was asked to review this deliverable (or its submission) or holds `review.decide` in this project. Where no other agent could review (recorded at
   * submission, and looked at again now), review is disabled and the owner alone decides: an agent never decides a version recorded as review-disabled.
   */
  async #decider(by: Principal, id: string, d: DeliverableBody, v: VersionBody, step: "start" | "decide"): Promise<void> {
    if (by.kind === "owner") return;
    if (by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not review a deliverable`);
    if (d.audience.includes("external")) throw new DomainError("forbidden", "a deliverable for an external audience is accepted or rejected by the owner only");
    if (this.#conflicted(d, v).has(by.id)) throw new DomainError("forbidden", "a deliverable cannot be reviewed or accepted by an agent that did its work (no self-review)");
    if (v.review?.required === false || (await this.#deciders(d, v)).length === 0) throw new DomainError("forbidden", "review is disabled for this deliverable (no other agent can review it): the owner decides");
    const roles = await this.#ports.rolesOf(by.id, { projectId: d.projectId, taskId: d.taskId }, by);
    const director = roles.includes("director") && by.grants.some((g) => g.project === d.projectId && this.#live(g));
    let reviewer = false;
    if (!director && roles.includes("reviewer")) {
      const named = this.#ports.reviewAssignments === undefined ? [] : await this.#ports.reviewAssignments(by.id, d.taskId);
      reviewer = named.includes(id) || v.content.submissions.some((x) => named.includes(x.id)) || by.grants.some((g) => g.action === "review.decide" && g.project === d.projectId && this.#live(g));
    }
    if (!director && !reviewer) throw new DomainError("forbidden", "only the owner, a director of this project or a reviewer asked to review this deliverable may review it");
    if (step === "decide" && !director && v.reviewer !== by.id) throw new DomainError("forbidden", "a reviewer decides only on a review it started");
  }

  // ---- content ---------------------------------------------------------------------------------------------------------------

  async #content(taskId: string, projectId: string, s: Shape, responsible: string): Promise<Content> {
    const artifacts: ArtifactRef[] = [];
    for (const a of s.artifacts) {
      const found = await this.#runner.get("artifact", a.artifactId);
      const body = found?.body as unknown as ArtifactBody | undefined;
      // An artifact of another task or project reads as missing: a deliverable cannot pull in work it has no right to.
      if (body === undefined || body.taskId !== taskId || (body.projectId !== undefined && body.projectId !== projectId)) bad("artifacts", `${a.artifactId} is not an artifact of this task`);
      artifacts.push({ artifactId: a.artifactId, role: a.role, manifestDigest: body!.manifestDigest, ...(a.exportedFrom === undefined ? {} : { exportedFrom: a.exportedFrom }) });
    }
    const submissions: SubmissionRef[] = [];
    for (const id of s.submissionIds) {
      const found = await this.#runner.get("submission", id);
      const body = found?.body as unknown as SubmissionBody | undefined;
      // One message for a missing, another task's or another agent's submission: a deliverable claims only the responsible agent's own work, and the error tells nothing about the rest.
      if (body === undefined || body.taskId !== taskId || body.submittedBy !== responsible) bad("submissionIds", `${id} is not a submission of this task by the responsible agent`);
      if (body!.kind !== "code" && body!.kind !== "document") bad("submissionIds", `${id}: only a code or document submission can be part of a deliverable`);
      if (body!.artifactDigest !== undefined && !artifacts.some((a) => body!.artifactDigest === `sha256:${a.manifestDigest}` || body!.artifactDigest === a.manifestDigest)) bad("submissionIds", `${id}: its artifact digest is not one of this version's artifacts`);
      submissions.push({ id, kind: body!.kind, submittedBy: body!.submittedBy, ...(body!.tree === undefined ? {} : { tree: body!.tree }), ...(body!.artifactDigest === undefined ? {} : { artifactDigest: body!.artifactDigest }) });
    }
    return { artifacts, submissions, ...(s.outcome === undefined ? {} : { outcome: { reference: redactText(s.outcome.reference), systemVersion: redactText(s.outcome.systemVersion), observedAt: s.outcome.observedAt } }), ...(s.note === undefined ? {} : { note: redactText(s.note) }) };
  }

  /** What a version must hold before it can be submitted. */
  #complete(type: DeliverableType, c: Content): void {
    if (type === "code" && !c.submissions.some((s) => s.kind === "code")) bad("submissionIds", "a code deliverable names the code submission it is");
    if (type === "operational-outcome" && c.outcome === undefined) bad("outcome", "an operational outcome names its verified reference, system version and observation time");
    if ((type === "document" || type === "report" || type === "design") && c.artifacts.length === 0) bad("artifacts", `a ${type} deliverable names at least one artifact`);
  }

  /** Checks the artifacts against their records and bytes; `checks` pin the artifact records read, so a decision commits only if none changed meanwhile. */
  async #verify(c: Content): Promise<{ ok: boolean; problems: number; checks: Change[] }> {
    if (c.artifacts.length === 0) return { ok: true, problems: 0, checks: [] };
    if (this.#ports.verifyArtifact === undefined) throw new DomainError("unavailable", "artifacts cannot be checked on this controller, so a deliverable that names them cannot be submitted or decided");
    let problems = 0;
    const checks: Change[] = [];
    for (const a of c.artifacts) {
      const found = await this.#runner.get("artifact", a.artifactId);
      const current = found?.body as unknown as ArtifactBody | undefined;
      if (found === undefined || current === undefined || current.manifestDigest !== a.manifestDigest) { problems++; continue; }
      checks.push({ type: "check", ref: { kind: "artifact", id: a.artifactId }, expectedRevision: found.revision });
      try { const r = await this.#ports.verifyArtifact(a.artifactId); if (!r.ok) problems += Math.max(1, r.problems); } catch (error) {
        if (error instanceof DomainError && (error.code === "not_found" || error.code === "integrity")) problems++; else throw error;
      }
    }
    return { ok: problems === 0, problems, checks };
  }

  // ---- writing ---------------------------------------------------------------------------------------------------------------

  #events(id: string, d: DeliverableBody, list: readonly { version: number; kind: EventBody["kind"]; reason?: string }[], by: string): { body: DeliverableBody; changes: Change[] } {
    const at = this.#runner.now();
    let seq = d.eventSeq;
    const changes: Change[] = [];
    for (const e of list) {
      seq += 1;
      const body: EventBody = { deliverableId: id, seq, version: e.version, kind: e.kind, by, at, ...(e.reason === undefined ? {} : { reason: e.reason }) };
      changes.push({ type: "create", ref: { kind: "deliverable-event", id: `${id}.${seq}` }, body: body as unknown as JsonObject });
    }
    return { body: { ...d, eventSeq: seq }, changes };
  }

  /** Principal rights to write: the owner, or the responsible agent (still able to read the task). */
  #writer(by: Principal, d: DeliverableBody): void {
    if (by.kind === "owner") return;
    if (by.kind !== "agent" || by.id !== d.responsibleAgent) throw new DomainError("forbidden", "only the responsible agent or the owner may change this deliverable");
  }

  /** Creates a deliverable in `draft`. An agent holding the author, docs or qa role creates its own; the owner may name the responsible agent. */
  async draft(by: Principal, command: NoActor & { taskId: string; type: string; title: string; audience?: readonly string[]; accessScope?: string; responsibleAgent?: string } & Draft): Promise<{ id: string; revision: number; replayed: boolean }> {
    if (command === null || typeof command !== "object") throw new DomainError("invalid_command", "a command is an object");
    const known = ["commandId", "taskId", "type", "title", "audience", "accessScope", "responsibleAgent", "artifacts", "submissionIds", "outcome", "note"];
    for (const k of Object.keys(command)) if (!known.includes(k)) bad(k, "is not a field of this command");
    const commandId = checkCommandId(command.commandId);
    const taskId = checkTaskId(command.taskId);
    if (!(DELIVERABLE_TYPES as readonly string[]).includes(command.type)) bad("type", `must be one of ${DELIVERABLE_TYPES.join(", ")}`);
    const title = text(command.title, "title", { min: 1, max: 200 });
    const audience = command.audience === undefined ? ["project"] : command.audience;
    if (!Array.isArray(audience) || audience.length < 1 || audience.length > AUDIENCES.length || audience.some((a) => !(AUDIENCES as readonly string[]).includes(a)) || new Set(audience).size !== audience.length) bad("audience", `must be a list of different values from ${AUDIENCES.join(", ")}`);
    const accessScope = command.accessScope === undefined ? "task" : command.accessScope;
    if (!(ACCESS_SCOPES as readonly string[]).includes(accessScope)) bad("accessScope", `must be one of ${ACCESS_SCOPES.join(", ")}`);
    if (command.responsibleAgent !== undefined && (typeof command.responsibleAgent !== "string" || !AGENT.test(command.responsibleAgent))) bad("responsibleAgent", "must be an agent principal like agent:name");
    if (by.kind !== "owner" && by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not create a deliverable`);
    if (by.kind === "agent" && command.responsibleAgent !== undefined && command.responsibleAgent !== by.id) throw new DomainError("forbidden", "an agent creates deliverables for itself only");
    const shape = shapeOf(command);
    const id = derivedId("dlv", scopedCommandId(by.id, commandId));
    const result = await this.#runner.command("deliverable.draft", { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { taskId, type: command.type, title, audience: [...audience as string[]], accessScope: accessScope as string, responsibleAgent: command.responsibleAgent ?? null, shape: sameShape(shape) },
      build: async () => {
        const task = await this.#task(taskId);
        if (task === undefined) return hidden("task");
        if (by.kind === "agent") {
          if ((by.taskScope !== undefined && (!inTaskScope(by, task.projectId) || by.taskScope.taskId !== taskId)) || !allows(by, "task.read", task.projectId, { resource: { kind: "task", id: taskId } })) return hidden("task");
          const roles = await this.#ports.rolesOf(by.id, { projectId: task.projectId, taskId }, by);
          if (!WRITERS.some((r) => roles.includes(r))) throw new DomainError("forbidden", `${by.id} holds none of the roles ${WRITERS.join(", ")} that make deliverables`);
        }
        if (task.state === "cancelled") throw new DomainError("invalid_command", "the task is cancelled");
        const responsible = command.responsibleAgent ?? by.id;
        const who = (await this.#runner.get("principal", responsible))?.body as unknown as { kind?: string; state?: string } | undefined;
        if (who === undefined || who.kind !== "agent" || who.state !== "active") bad("responsibleAgent", `${responsible} is not an active agent`);
        const content = await this.#content(taskId, task.projectId, shape, responsible);
        const index = await this.#runner.get("deliverable-index", taskId);
        const ids = ((index?.body as unknown as { ids: string[] } | undefined)?.ids) ?? [];
        if (ids.length >= MAX_PER_TASK) throw new DomainError("invalid_command", `a task has at most ${MAX_PER_TASK} deliverables`);
        const now = this.#runner.now();
        const base: DeliverableBody = { taskId, projectId: task.projectId, type: command.type as DeliverableType, title: redactText(title), responsibleAgent: command.responsibleAgent ?? by.id, audience: audience as string[], accessScope: accessScope as AccessScope, createdBy: by.id, createdAt: now, currentVersion: 1, state: "draft", eventSeq: 0 };
        const ev = this.#events(id, base, [{ version: 1, kind: "draft" }], by.id);
        const version: VersionBody = { deliverableId: id, version: 1, state: "draft", content, createdBy: by.id, createdAt: now };
        const ref = { kind: "deliverable", id };
        const idxRef = { kind: "deliverable-index", id: taskId };
        const idxBody = { ids: [...ids, id] } as unknown as JsonObject;
        return { ref, creates: true, changes: [
          { type: "create", ref, body: ev.body as unknown as JsonObject },
          { type: "create", ref: { kind: "deliverable-version", id: `${id}.1` }, body: version as unknown as JsonObject },
          ...ev.changes,
          index === undefined ? { type: "create", ref: idxRef, body: idxBody } : { type: "update", ref: idxRef, expectedRevision: index.revision, body: idxBody },
        ], detail: { taskId, type: command.type } };
      },
    }));
    return { id: result.id, revision: result.revision, replayed: result.replayed };
  }

  /** Replaces the content of the version still in `draft` (the responsible agent or the owner). */
  async revise(by: Principal, command: NoActor & { id: string; expectedRevision: number } & Draft): Promise<{ id: string; revision: number; replayed: boolean }> {
    return this.#edit(by, "deliverable.revise", command, ["commandId", "id", "expectedRevision", "artifacts", "submissionIds", "outcome", "note"], false);
  }

  /** Starts a new version (n + 1, in `draft`); the older version is superseded unless it was rejected (kept as rejected). */
  async newVersion(by: Principal, command: NoActor & { id: string; expectedRevision: number } & Draft): Promise<{ id: string; revision: number; replayed: boolean }> {
    return this.#edit(by, "deliverable.version.new", command, ["commandId", "id", "expectedRevision", "artifacts", "submissionIds", "outcome", "note"], true);
  }

  async #edit(by: Principal, type: string, command: NoActor & { id: string; expectedRevision: number } & Draft, known: string[], fresh: boolean): Promise<{ id: string; revision: number; replayed: boolean }> {
    if (command === null || typeof command !== "object") throw new DomainError("invalid_command", "a command is an object");
    for (const k of Object.keys(command)) if (!known.includes(k)) bad(k, "is not a field of this command");
    const commandId = checkCommandId(command.commandId);
    if (typeof command.id !== "string" || !ID.test(command.id)) bad("id", "is not a deliverable ID");
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) bad("expectedRevision", "must be the revision you read");
    const shape = shapeOf(command);
    let notice: string | undefined;
    const result = await this.#runner.command(type, { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { id: command.id, expectedRevision: command.expectedRevision, shape: sameShape(shape) },
      build: async () => {
        const { agg, body: d } = await this.#load(by, command.id);
        this.#writer(by, d);
        if (agg.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the deliverable is at revision ${agg.revision}, not ${command.expectedRevision}`, { currentRevision: agg.revision });
        const vAgg = await this.#version(command.id, d.currentVersion);
        const v = vAgg.body as unknown as VersionBody;
        const content = await this.#content(d.taskId, d.projectId, shape, d.responsibleAgent);
        const ref = { kind: "deliverable", id: command.id };
        if (!fresh) {
          if (v.state !== "draft") throw new DomainError("invalid_transition", `version ${v.version} is ${v.state}, not draft: start a new version to change it`);
          return { ref, creates: false, changes: [
            { type: "update", ref, expectedRevision: agg.revision, body: d as unknown as JsonObject },
            { type: "update", ref: { kind: "deliverable-version", id: `${command.id}.${v.version}` }, expectedRevision: vAgg.revision, body: { ...v, content } as unknown as JsonObject },
          ], detail: { deliverable: command.id, version: v.version } };
        }
        const next = d.currentVersion + 1;
        if (next > MAX_VERSIONS) throw new DomainError("invalid_command", `a deliverable has at most ${MAX_VERSIONS} versions`);
        const now = this.#runner.now();
        const events: { version: number; kind: EventBody["kind"]; reason?: string }[] = [];
        const changes: Change[] = [];
        // A rejected version keeps its verdict; any other earlier version is superseded.
        const supersede = v.state !== "rejected" && v.state !== "superseded";
        const wasLive = v.state === "under-review" || v.state === "accepted";
        if (supersede) events.push({ version: v.version, kind: "superseded", reason: wasLive ? `replaced by version ${next} by ${by.id} while ${v.state}${v.state === "accepted" ? ` (accepted by ${v.decidedBy ?? "unknown"})` : v.reviewer === undefined ? "" : ` (under review by ${v.reviewer})`}` : `replaced by version ${next}` });
        events.push({ version: next, kind: "draft" });
        if (supersede && wasLive) notice = events[0]!.reason;
        const ev = this.#events(command.id, d, events, by.id);
        const nd: DeliverableBody = { ...ev.body, currentVersion: next, state: "draft" };
        changes.push({ type: "update", ref, expectedRevision: agg.revision, body: nd as unknown as JsonObject });
        if (supersede) changes.push({ type: "update", ref: { kind: "deliverable-version", id: `${command.id}.${v.version}` }, expectedRevision: vAgg.revision, body: { ...v, state: "superseded" } as unknown as JsonObject });
        else changes.push({ type: "check", ref: { kind: "deliverable-version", id: `${command.id}.${v.version}` }, expectedRevision: vAgg.revision });
        changes.push({ type: "create", ref: { kind: "deliverable-version", id: `${command.id}.${next}` }, body: { deliverableId: command.id, version: next, state: "draft", content, createdBy: by.id, createdAt: now } as unknown as JsonObject }, ...ev.changes);
        return { ref, creates: false, changes, detail: { deliverable: command.id, version: next } };
      },
    }));
    // The decider and the owner are told that a review or an acceptance was undone by a new version (the event is already on the record).
    if (notice !== undefined && !result.replayed && this.#ports.notify !== undefined) {
      await this.#ports.notify({ commandId: `dlv-superseded:${command.id}:${result.revision}`, deliverableId: command.id, text: `${command.id}: ${notice}` }).catch(() => undefined);
    }
    return { id: result.id, revision: result.revision, replayed: result.replayed };
  }

  /** draft -> submitted. Checks the artifacts and the task contract version in force. */
  async submit(by: Principal, command: NoActor & { id: string; expectedRevision: number; contractVersion: number }): Promise<{ id: string; revision: number; replayed: boolean }> {
    if (command === null || typeof command !== "object") throw new DomainError("invalid_command", "a command is an object");
    for (const k of Object.keys(command)) if (!["commandId", "id", "expectedRevision", "contractVersion"].includes(k)) bad(k, "is not a field of this command");
    const commandId = checkCommandId(command.commandId);
    if (typeof command.id !== "string" || !ID.test(command.id)) bad("id", "is not a deliverable ID");
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) bad("expectedRevision", "must be the revision you read");
    if (!Number.isSafeInteger(command.contractVersion) || command.contractVersion < 0) bad("contractVersion", "must be the task contract version you worked against (0 when it has none)");
    const result = await this.#runner.command("deliverable.submit", { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { id: command.id, expectedRevision: command.expectedRevision, contractVersion: command.contractVersion },
      build: async () => {
        const { agg, body: d } = await this.#load(by, command.id);
        this.#writer(by, d);
        if (agg.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the deliverable is at revision ${agg.revision}, not ${command.expectedRevision}`, { currentRevision: agg.revision });
        const vAgg = await this.#version(command.id, d.currentVersion);
        const v = vAgg.body as unknown as VersionBody;
        if (v.state !== "draft") throw new DomainError("invalid_transition", `version ${v.version} is ${v.state}, not draft`);
        const task = await this.#task(d.taskId);
        if (task === undefined || task.state === "cancelled") throw new DomainError("invalid_command", "the task is cancelled");
        const current = await this.#ports.contractVersion(d.taskId);
        if (current !== command.contractVersion) throw new DomainError("stale_revision", `the task contract is at version ${current}, not ${command.contractVersion}: read it and check the deliverable against it`, { currentRevision: current });
        // Content may have changed since the draft was made: it is looked at again.
        const content = await this.#content(d.taskId, d.projectId, { artifacts: v.content.artifacts, submissionIds: v.content.submissions.map((s) => s.id), ...(v.content.outcome === undefined ? {} : { outcome: v.content.outcome }), ...(v.content.note === undefined ? {} : { note: v.content.note }) }, d.responsibleAgent);
        this.#complete(d.type, content);
        const checked = await this.#verify(content);
        if (!checked.ok) throw new DomainError("integrity", `${checked.problems} problem(s) with the artifacts of version ${v.version}: they are missing or changed`);
        const review = (await this.#deciders(d, { ...v, content }, by.id)).length === 0 ? { required: false, reason: REVIEW_DISABLED_SINGLE_AGENT } : { required: true };
        return this.#move(command.id, agg, d, vAgg, v, "submitted", by.id, { content, contractVersion: current, submittedBy: by.id, submittedAt: this.#runner.now(), review: review as NonNullable<VersionBody["review"]> });
    },
    }));
    return { id: result.id, revision: result.revision, replayed: result.replayed };
  }

  /** One state change of the current version: the version record, the deliverable and the event, together. */
  #move(id: string, agg: Aggregate, d: DeliverableBody, vAgg: Aggregate, v: VersionBody, to: DeliverableState | "invalidated", by: string, patch: Partial<VersionBody>, reason?: string): { ref: { kind: string; id: string }; creates: false; changes: Change[]; detail: JsonObject } {
    const kind = to;
    const state: DeliverableState = to === "invalidated" ? "submitted" : to;
    const ev = this.#events(id, d, [{ version: v.version, kind, ...(reason === undefined ? {} : { reason }) }], by);
    const nd: DeliverableBody = { ...ev.body, state };
    const nv: VersionBody = { ...v, ...patch, state };
    const ref = { kind: "deliverable", id };
    return { ref, creates: false, changes: [
      { type: "update", ref, expectedRevision: agg.revision, body: nd as unknown as JsonObject },
      { type: "update", ref: { kind: "deliverable-version", id: `${id}.${v.version}` }, expectedRevision: vAgg.revision, body: nv as unknown as JsonObject },
      ...ev.changes,
    ], detail: { deliverable: id, version: v.version, from: v.state, to: kind } };
  }

  /** submitted -> under-review. The owner, or a director or reviewer that did none of the work; the artifacts are checked first. */
  async startReview(by: Principal, command: NoActor & { id: string; version: number; expectedRevision?: number }): Promise<{ id: string; revision: number; replayed: boolean }> {
    return this.#review(by, "deliverable.review.start", command, "under-review");
  }

  /** under-review -> accepted. The artifacts are checked again: a missing or changed one voids the review instead. */
  async accept(by: Principal, command: NoActor & { id: string; version: number; expectedRevision?: number; reason?: string }): Promise<{ id: string; revision: number; replayed: boolean }> {
    return this.#review(by, "deliverable.accept", command, "accepted");
  }

  /** under-review -> rejected, with the reason; the version and its verdict stay on the record. */
  async reject(by: Principal, command: NoActor & { id: string; version: number; expectedRevision?: number; reason: string }): Promise<{ id: string; revision: number; replayed: boolean }> {
    return this.#review(by, "deliverable.reject", command, "rejected");
  }

  async #review(by: Principal, type: string, command: NoActor & { id: string; version: number; expectedRevision?: number; reason?: string }, to: "under-review" | "accepted" | "rejected"): Promise<{ id: string; revision: number; replayed: boolean }> {
    if (command === null || typeof command !== "object") throw new DomainError("invalid_command", "a command is an object");
    for (const k of Object.keys(command)) if (!["commandId", "id", "version", "expectedRevision", ...(to === "under-review" ? [] : ["reason"])].includes(k)) bad(k, "is not a field of this command");
    const commandId = checkCommandId(command.commandId);
    if (typeof command.id !== "string" || !ID.test(command.id)) bad("id", "is not a deliverable ID");
    if (!Number.isSafeInteger(command.version) || command.version < 1) bad("version", "must be the version you decide on");
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1)) bad("expectedRevision", "must be the revision you read");
    const reason = command.reason === undefined ? undefined : text(command.reason, "reason", { min: to === "rejected" ? 1 : 0, max: MAX_REASON, multiline: true });
    if (to === "rejected" && reason === undefined) bad("reason", "say why the version is rejected");
    const scoped = scopedCommandId(by.id, commandId);
    const run = () => this.#runner.command(type, { commandId: scoped, actor: by.id }, async () => ({
      payload: { id: command.id, version: command.version, expectedRevision: command.expectedRevision ?? null, reason: reason ?? null },
      build: async () => {
        const { agg, body: d } = await this.#load(by, command.id);
        if (command.expectedRevision !== undefined && agg.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the deliverable is at revision ${agg.revision}, not ${command.expectedRevision}`, { currentRevision: agg.revision });
        if (d.currentVersion !== command.version) throw new DomainError("stale_revision", `the newest version is ${d.currentVersion}, not ${command.version}`, { currentRevision: d.currentVersion });
        const vAgg = await this.#version(command.id, command.version);
        const v = vAgg.body as unknown as VersionBody;
        const from = to === "under-review" ? "submitted" : "under-review";
        if (v.state !== from) throw new DomainError("invalid_transition", `version ${v.version} is ${v.state}, not ${from}`);
        await this.#decider(by, command.id, d, v, to === "under-review" ? "start" : "decide");
        let artifactChecks: Change[] = [];
        if (to !== "rejected") {
          const checked = await this.#verify(v.content);
          artifactChecks = checked.checks;
          if (!checked.ok) throw new Damaged(`${checked.problems} problem(s) with the artifacts of version ${v.version}: they are missing or changed, so the review cannot go on`, checked.problems);
        }
        const moved = this.#move(command.id, agg, d, vAgg, v, to, by.id, to === "under-review" ? { reviewer: by.id } : { decidedBy: by.id, decidedAt: this.#runner.now(), ...(reason === undefined ? {} : { reason: redactText(reason) }) }, to === "under-review" ? undefined : reason === undefined ? undefined : redactText(reason));
        if (to === "accepted") {
          // The artifact records and the contract read for this decision must be unchanged when it commits.
          const contract = await this.#runner.get("task-contract", d.taskId);
          moved.changes.push(...artifactChecks, ...(contract === undefined ? [] : [{ type: "check" as const, ref: { kind: "task-contract", id: d.taskId }, expectedRevision: contract.revision }]));
        }
        return moved;
      },
    }));
    try {
      const r = await run();
      return { id: r.id, revision: r.revision, replayed: r.replayed };
    } catch (error) {
      if (error instanceof Damaged && to === "accepted") await this.#invalidate(by, command.id, command.version, scoped, "artifact missing or changed");
      throw error;
    }
  }

  /** Voids a review whose artifacts are missing or changed: under-review or accepted -> submitted, as its own event. Idempotent by the command that found the damage. */
  async #invalidate(by: Principal, id: string, version: number, base: string, reason: string): Promise<boolean> {
    try {
      await this.#runner.command("deliverable.invalidate", { commandId: `${base}.invalidate`, actor: by.id }, async () => ({
        payload: { id, version, reason },
        build: async () => {
          const agg = await this.#runner.get("deliverable", id);
          if (agg === undefined) return hidden();
          const d = agg.body as unknown as DeliverableBody;
          if (d.currentVersion !== version) throw new DomainError("stale_revision", "a newer version exists");
          const vAgg = await this.#version(id, version);
          const v = vAgg.body as unknown as VersionBody;
          if (v.state !== "under-review" && v.state !== "accepted") throw new DomainError("invalid_transition", `version ${version} is ${v.state}`);
          const { reviewer: _r, decidedBy: _d, decidedAt: _t, ...kept } = v;
          void _r; void _d; void _t;
          return this.#move(id, agg, d, { ...vAgg, body: kept as unknown as JsonObject }, kept as VersionBody, "invalidated", by.id, {}, reason);
        },
      }));
      return true;
    } catch (error) {
      // Somebody else already moved the version: the review is no longer there to void.
      if (error instanceof DomainError && (error.code === "invalid_transition" || error.code === "stale_revision")) return false;
      throw error;
    }
  }

  /**
   * Checks the newest version's artifacts against their bytes. When the version is under review or accepted and something is missing or changed, the review (or acceptance) is voided in the same
   * step: an `invalidated` event returns it to `submitted`. Needs the right to read the deliverable and to look at it: the owner, the responsible agent, a director or a reviewer.
   */
  async check(by: Principal, command: NoActor & { id: string }): Promise<{ id: string; ok: boolean; problems: number; invalidated: boolean }> {
    if (command === null || typeof command !== "object") throw new DomainError("invalid_command", "a command is an object");
    for (const k of Object.keys(command)) if (!["commandId", "id"].includes(k)) bad(k, "is not a field of this command");
    const commandId = checkCommandId(command.commandId);
    const { body: d } = await this.#load(by, command.id);
    if (by.kind === "agent" && by.id !== d.responsibleAgent && by.id !== d.createdBy) {
      const roles = await this.#ports.rolesOf(by.id, { projectId: d.projectId, taskId: d.taskId }, by);
      if (!roles.includes("director") && !roles.includes("reviewer")) throw new DomainError("forbidden", "only the owner, the responsible agent, a director or a reviewer may check a deliverable");
    }
    const vAgg = await this.#version(command.id, d.currentVersion);
    const v = vAgg.body as unknown as VersionBody;
    const checked = await this.#verify(v.content);
    if (checked.ok) return { id: command.id, ok: true, problems: 0, invalidated: false };
    const voided = (v.state === "under-review" || v.state === "accepted") && (await this.#invalidate(by, command.id, v.version, scopedCommandId(by.id, commandId), "artifact missing or changed"));
    return { id: command.id, ok: false, problems: checked.problems, invalidated: voided };
  }

  // ---- reading ---------------------------------------------------------------------------------------------------------------

  #show(id: string, revision: number, d: DeliverableBody, v?: VersionBody): JsonObject {
    return JSON.parse(JSON.stringify({ ...d, id, revision, ...(v === undefined ? {} : { version: { ...v, ...(v.reason === undefined ? {} : { reason: redactText(v.reason) }) } }) })) as JsonObject;
  }

  /** One deliverable with its newest version, or the one named. Hidden as not found where the caller may not read it. */
  async get(by: Principal, id: string, version?: number): Promise<JsonObject | undefined> {
    let loaded: { agg: Aggregate; body: DeliverableBody };
    try { loaded = await this.#load(by, id); } catch (error) { if (error instanceof DomainError && error.code === "not_found") return undefined; throw error; }
    const n = version ?? loaded.body.currentVersion;
    if (!Number.isSafeInteger(n) || n < 1 || n > loaded.body.currentVersion) bad("version", `must be from 1 to ${loaded.body.currentVersion}`);
    const v = (await this.#version(id, n)).body as unknown as VersionBody;
    const states: { version: number; state: string }[] = [];
    for (let i = 1; i <= loaded.body.currentVersion; i++) states.push({ version: i, state: i === n ? v.state : ((await this.#version(id, i)).body as unknown as VersionBody).state });
    return { ...this.#show(id, loaded.agg.revision, loaded.body, v), versions: states } as JsonObject;
  }

  /** The deliverables of a task the caller may read, in creation order. */
  async list(by: Principal, taskIdValue: string): Promise<{ items: JsonObject[] }> {
    const taskId = checkTaskId(taskIdValue);
    const task = await this.#task(taskId);
    if (task === undefined || (by.kind !== "owner" && by.kind !== "agent")) return hidden("task");
    if (by.kind === "agent" && by.taskScope !== undefined && (!inTaskScope(by, task.projectId) || by.taskScope.taskId !== taskId)) return hidden("task");
    const ids = ((await this.#runner.get("deliverable-index", taskId))?.body as unknown as { ids: string[] } | undefined)?.ids ?? [];
    const items: JsonObject[] = [];
    for (const id of ids) {
      const agg = await this.#runner.get("deliverable", id);
      if (agg === undefined) continue;
      const d = agg.body as unknown as DeliverableBody;
      if (!(await this.#mayRead(by, d))) continue;
      items.push(this.#show(id, agg.revision, d));
    }
    if (items.length === 0 && by.kind === "agent" && !allows(by, "task.read", task.projectId, { resource: { kind: "task", id: taskId } })) return hidden("task");
    return { items };
  }

  /** The events of a deliverable in order, from after `after`; `next` when more follow. */
  async events(by: Principal, id: string, page: { after?: number; limit: number }): Promise<{ items: EventBody[]; next?: number }> {
    const { body: d } = await this.#load(by, id);
    const after = page.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) bad("after", "must be 0 or the `next` of an earlier page");
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) bad("limit", "must be a whole number from 1 to 100");
    const items: EventBody[] = [];
    for (let seq = after + 1; seq <= d.eventSeq && items.length < page.limit; seq++) {
      const e = await this.#runner.get("deliverable-event", `${id}.${seq}`);
      if (e === undefined) throw new DomainError("integrity", `event ${seq} of ${id} is missing`);
      const body = e.body as unknown as EventBody;
      items.push({ ...body, ...(body.reason === undefined ? {} : { reason: redactText(body.reason) }) });
    }
    const last = items.length === 0 ? after : items[items.length - 1]!.seq;
    return { items, ...(last < d.eventSeq ? { next: last } : {}) };
  }

  /** Whether the task has an accepted deliverable (for the cards that wait on acceptance). No principal: an internal question; it reveals nothing to a caller. */
  async acceptedFor(taskId: string): Promise<{ accepted: boolean; deliverables: readonly string[] }> {
    const ids = ((await this.#runner.get("deliverable-index", checkTaskId(taskId)))?.body as unknown as { ids: string[] } | undefined)?.ids ?? [];
    const accepted: string[] = [];
    for (const id of ids) if (((await this.#runner.get("deliverable", id))?.body as unknown as DeliverableBody | undefined)?.state === "accepted") accepted.push(id);
    return { accepted: accepted.length > 0, deliverables: accepted };
  }
}

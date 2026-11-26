import { DomainError } from "../domain/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import { assignmentIdOf } from "../domain/assignment-model.js";
import { derivedId, operationIdOf } from "../domain/ids.js";
import { commandId as checkCommandId, projectId as checkProjectId, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import { allows, inTaskScope } from "../security/access.js";
import { createHash } from "node:crypto";
import { scopedCommandId } from "../security/credentials.js";
import { effectiveOf } from "../security/grants.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { RolesOf, SubmissionBody } from "./submissions.js";
import { CAPABILITY_ID, CAPABILITY_MATURITIES, CLAIM_LIMITS, builtInCapabilities, checkDeclared, cleanText, effectiveRegister, fileWhere, maturityRank, scanText, type CapabilityEntry, type CapabilityMaturity, type CapabilityRegisterBody, type ClaimFlag } from "./doc-claims.js";

/** Who a document is for (card Q03): user and developer documentation, support guidance and promotional assets. A release change flags all four. */
export const DOC_AUDIENCES = ["user", "developer", "support", "promotional"] as const;
export type DocAudience = (typeof DOC_AUDIENCES)[number];
/** `unverified`: never checked against tested work. `verified`: a document change was bound to code that passed its QA gate. `stale`: verified once, but the behaviour or the release changed since. */
export const DOC_STATES = ["unverified", "verified", "stale"] as const;
export type DocState = (typeof DOC_STATES)[number];
/**
 * What is kept (card Q03): a `document` (user or developer documentation, or any other text), `support_guidance` (what support staff tell customers: help-desk answers, FAQ entries) or a `promotional_asset`
 * (marketing: a landing page, a store listing, an announcement, an image or video). Each has an owner, audience, version, implementing tasks and a state, and every check (impact, release, landing) treats
 * them alike; support guidance and promotional assets also name the channel they are published on, and a promotional asset its media type. A record written before kinds existed is a `document`.
 */
export const DOC_KINDS = ["document", "support_guidance", "promotional_asset"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOC_MEDIA = ["text", "image", "video", "audio", "other"] as const;
export type DocMedia = (typeof DOC_MEDIA)[number];

/** A capability a document claims, tied to the task that implements it. A claim is supported only while that task's code passes its QA gate (card Q02). */
export interface DocClaim {
  readonly text: string;
  readonly taskId: string;
  /** The capability of the project's capability register it claims (required for a claim recorded since the register exists; an older claim without one is flagged when the document is verified). */
  readonly capabilityId?: string;
}
/** The tested artifact a document was checked against for one implementing task: the code submission and the tree its QA gate passed on. */
export interface DocEvidence { readonly taskId: string; readonly submissionId: string; readonly tree: string }

/** Why a document needs an update. */
export type DocReason =
  | { readonly kind: "behavior_changed"; readonly taskId: string; readonly submissionId: string; readonly tree: string; readonly from?: string }
  | { readonly kind: "evidence_lost"; readonly taskId: string; readonly submissionId: string }
  | { readonly kind: "release_changed"; readonly from: string; readonly to: string }
  /** A capability the document claimed or named when it was verified is now rated lower in the capability register (for example supported, now experimental). */
  | { readonly kind: "capability_changed"; readonly capabilityId: string; readonly from: CapabilityMaturity; readonly to: CapabilityMaturity };

export interface DocUpdate {
  /** The assigned update task (created by the controller, owned by the document's owner). */
  readonly taskId: string;
  /** The document's running count of update tasks: the task's ID is derived from the document and this number, so a repeat finds it and a later update of the same kind is a new task. */
  readonly seq: number;
  readonly reason: DocReason;
  readonly requestedBy: string;
  readonly requestedAt: string;
  /** `settled` once a verification of the document came after it; `dropped` when the document was retired while it was open (its task is cancelled unless it had started). */
  readonly state: "open" | "settled" | "dropped";
  readonly settledAt?: string;
}

export interface DocObligationBody {
  readonly projectId: string;
  readonly title: string;
  /** Where the document lives (a path, an address or an artifact ID), as the recorder gave it. */
  readonly location: string;
  readonly audience: DocAudience;
  /** Absent on records written before kinds existed: a `document`. */
  readonly kind?: DocKind;
  /** Support guidance and promotional assets: where it is published (for example "help desk", "app store listing"). */
  readonly channel?: string;
  /** Promotional assets: what it is. Only `text` can be read by the controller; the claims of the others are what the record lists. */
  readonly mediaType?: DocMedia;
  /** The agent answerable for keeping it current (a principal ID `agent:<id>`): its update tasks are assigned to it. */
  readonly owner: string;
  /** The product version the document applies to, in the project's own words (for example `1.4`). */
  readonly applicableVersion: string;
  /** The tasks whose behaviour the document describes. */
  readonly implementationRefs: readonly string[];
  readonly claims: readonly DocClaim[];
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly changedAt: string;
  readonly state: DocState;
  readonly verification?: {
    /** The docs role's document submission (card Q01b) that carries the change, and the artifact digest it names. */
    readonly documentSubmissionId: string;
    readonly artifactDigest: string;
    readonly evidence: readonly DocEvidence[];
    readonly version: string;
    readonly verifiedBy: string;
    readonly verifiedAt: string;
    /** The claim check that passed (card Q03): whether the document's text was read, how many of its files, and the maturity each capability it claims or names had then (a later downgrade flags it). */
    readonly claims?: { readonly scanned: boolean; readonly files: number; readonly capabilities: Readonly<Record<string, CapabilityMaturity>> };
  };
  /** The last verification refused for its claims (card Q03): when, by whom, with which document change, whether the text was read, and the flags (at most 20; `total` counts all). Cleared by a verification. */
  readonly claimCheck?: { readonly at: string; readonly by: string; readonly documentSubmissionId: string; readonly scanned: boolean; readonly flags: readonly ClaimFlag[]; readonly total: number };
  /** Why it is flagged since it was last verified or recorded (newest last). An unverified document keeps them too: a verification must then be against the newest tested code named here. */
  readonly reasons?: readonly DocReason[];
  /** A release flagged it: a verification must name this version. */
  readonly releaseVersion?: string;
  /** When it was last flagged (a reason noted): a verification needs a document change submitted no earlier, not one made before the flag. */
  readonly flaggedAt?: string;
  readonly updates: readonly DocUpdate[];
  /** Taken away (card Q03, retiring a document): the document is no longer kept. It left the project's list, so no check flags it and it does not count toward the project's limit; it cannot be verified or replaced. */
  readonly retired?: { readonly by: string; readonly at: string; readonly reason?: string };
  /** How many update tasks the document was ever given (the settled ones beyond the limit are dropped from `updates`). */
  readonly updateCount?: number;
}

interface IndexBody { readonly ids: readonly string[] }

/** What the documentation obligation service needs from the rest of the controller. */
export interface DocObligationPorts {
  readonly rolesOf: RolesOf;
  /**
   * The QA gate of one code submission (card Q02), read as the caller. `reads` (when given) are the records the verdict was read from at the revisions read: `verify` checks each in its write, so a
   * verification is never written on a verdict that changed between the read and the write.
   */
  readonly gate: (by: Principal, submissionId: string) => Promise<{ readonly verdict: "passed" | "failed"; readonly tree: string; readonly taskId: string; readonly reads?: readonly { readonly kind: string; readonly id: string; readonly revision: number }[] }>;
  /** The newest code submission of a task that has independent QA evidence, when the caller names none. Absent: the caller names it. */
  readonly newestChecked?: (by: Principal, taskId: string) => Promise<string | undefined>;
  readonly projects: Pick<ProjectService, "createTask" | "transitionTask">;
  readonly assignments: Pick<AssignmentService, "assignTask">;
  /**
   * Tells the owner that documents went stale (card Q03): called once per check that moved verified documents to `stale`, when the check was not the owner's own (the automatic checks after QA evidence,
   * or a docs or director agent's check); the owner who asked reads the answer. `commandId` is derived from the check's command, so a notice sent twice is one notice. A failure is not the check's failure.
   */
  readonly notify?: (n: { readonly commandId: string; readonly projectId: string; readonly obligationId: string; readonly text: string }) => Promise<void>;
  /**
   * The text of a document change (card Q03): the files of the artifact a `document` submission names, read only when its manifest digest is the one the submission recorded and it belongs to the project; files
   * that are not text by name or not UTF-8 are listed as skipped. Absent (a controller with no artifact store): no text is read, and a promotional text asset cannot be verified.
   */
  readonly readDocument?: (d: { readonly artifactId: string; readonly artifactDigest: string; readonly projectId: string }) => Promise<{ readonly files: readonly { readonly path: string; readonly text: string }[]; readonly skipped: readonly string[]; readonly unread?: readonly { readonly path: string; readonly why: string }[] }>;
}

const DOB = /^dob-[a-z2-7]{20}$/;
const SBM = /^sbm-[a-z2-7]{20}$/;
const AGENT = /^agent:[A-Za-z0-9._:-]{1,110}$/;
/** Roles that keep documents: the docs role writes them, a director signs releases off. Holding the role is not enough: the agent must also read the project's tasks. */
const KEEPERS = ["docs", "director"] as const;
/**
 * The controller's own name for the checks it runs by itself (card Q03, automatic impact and release): owner-level, because a check flags documents of the whole project and opens update tasks for
 * their keepers, whoever recorded the QA evidence or submitted the release. It reads with the owner's view (QA gates included) and is the requester of the update tasks it opens.
 */
export const DOC_AUTO_PRINCIPAL: Principal = { id: "service:doc-checks", kind: "owner", name: "doc-checks", grants: [] } as unknown as Principal;
/** The command ID of the documentation release check a release candidate's submission runs: one per candidate, project and version, so a repeat (or the same candidate submitted again) finds it. */
export const releaseDocsCommandId = (candidateId: string, projectId: string, version: string): string => `release-docs:${candidateId}:${createHash("sha256").update(`${projectId}\u0000${version}`).digest("hex").slice(0, 24)}`;
export const DOC_LIMITS = { perProject: 500, title: 200, location: 500, version: 40, refs: 20, claims: 20, claim: 300, updates: 20, reason: 300, channel: 100 } as const;

const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const hidden = (what: string): never => { throw new DomainError("not_found", `no such ${what}`); };
const json = (v: object): JsonObject => JSON.parse(JSON.stringify(v)) as JsonObject;
const only = (command: object, fields: readonly string[]): void => {
  if (command === null || typeof command !== "object") throw new DomainError("invalid_command", "a command is an object");
  for (const k of Object.keys(command)) if (!fields.includes(k)) bad(k, "is not a field of this command");
};
const bare = (agent: string): string => (agent.startsWith("agent:") ? agent.slice("agent:".length) : agent);
const reasonKey = (r: DocReason): string => (r.kind === "release_changed" ? `release:${r.to}` : r.kind === "capability_changed" ? `capability:${r.capabilityId}:${r.to}` : `${r.kind}:${r.taskId}:${r.submissionId}`);
/** What an update task is about: one implementing task, or the release. A document gets one open update task per subject; a further reason on the same subject is noted on the record, not given another task. */
const subjectOf = (r: DocReason): string => (r.kind === "release_changed" ? "release" : r.kind === "capability_changed" ? `capability:${r.capabilityId}` : `task:${r.taskId}`);
/** The command that creates a document's update task number `seq`; the task's ID is derived from it by the project service, so it is known before the task exists and a repeat finds it. */
const createCommandOf = (obligationId: string, seq: number): string => `doc-update:${obligationId}:${seq}`;
/** A planned flag of one document: the reasons to note (new since it was last verified or recorded) and those that get an update task. */
interface Planned { readonly id: string; readonly revision: number; readonly body: DocObligationBody; readonly reasons: readonly DocReason[]; readonly tasks: readonly DocReason[] }

/**
 * Documentation obligations and their impact (card Q03, first slice). An obligation names a document (user, developer, support or promotional), its owner (an agent), the version it applies to,
 * the tasks whose behaviour it describes and, for any capability it claims, the task that implements it.
 *
 * - **Verified only against tested work.** `verify` binds a docs-role document submission (card Q01b) to, for every implementing task, a code submission whose QA gate passes (card Q02). A claim whose task
 *   has no such code is unsupported and the verification is refused; a claim must name one of the document's implementing tasks, so a claim with nothing behind it cannot be recorded.
 * - **Impact.** `impact` takes a task's new tested code (named, or the newest independently checked one): every document of the project that describes the task and was verified against another tree, or whose
 *   evidence no longer passes, becomes `stale`; it and every unverified document of the task get an update task assigned to the document's owner, linked to that code. Asked again, nothing is repeated.
 * - **Release.** `release` flags every document of the project whose version is not the release's (user and developer docs, support guidance and promotional assets alike), with an update task each;
 *   a verification must then name the release version.
 */
export class DocObligationService {
  readonly #runner: CommandRunner;
  readonly #ports: DocObligationPorts;
  private constructor(runner: CommandRunner, ports: DocObligationPorts) { this.#runner = runner; this.#ports = ports; }

  static withEpoch(storage: ControllerStorage, epoch: number, ports: DocObligationPorts, options: RunnerOptions = {}): DocObligationService {
    return new DocObligationService(new CommandRunner(storage, epoch, options), ports);
  }

  // ---- rights ---------------------------------------------------------------------------------------------------------------

  /** The owner, or an agent that may read the project's tasks (inside its task scope's project). */
  #reads(by: Principal, projectId: string): boolean {
    if (by.kind === "owner") return true;
    if (by.kind !== "agent") return false;
    if (by.taskScope !== undefined && !inTaskScope(by, projectId)) return false;
    return allows(by, "task.read", projectId);
  }

  async #project(by: Principal, value: unknown): Promise<string> {
    const projectId = checkProjectId(value);
    if ((await this.#runner.get("project", projectId)) === undefined || !this.#reads(by, projectId)) return hidden("project");
    return projectId;
  }

  /** May keep documents of the project: the owner, or a reader holding the docs or director role there. */
  async #keeps(by: Principal, projectId: string): Promise<void> {
    if (by.kind === "owner") return;
    const roles = await this.#ports.rolesOf(by.id, { projectId, taskId: "" }, by);
    if (!KEEPERS.some((r) => roles.includes(r))) throw new DomainError("forbidden", `${by.id} holds neither the docs nor the director role in this project`);
  }

  async #obligation(by: Principal, id: unknown): Promise<{ id: string; revision: number; body: DocObligationBody }> {
    if (typeof id !== "string" || !DOB.test(id)) bad("obligationId", "is not a documentation obligation ID");
    const found = await this.#runner.get("doc-obligation", id as string);
    const body = found?.body as unknown as DocObligationBody | undefined;
    if (found === undefined || body === undefined || !this.#reads(by, body.projectId)) return hidden("documentation obligation");
    return { id: id as string, revision: found!.revision, body: body! };
  }

  /** Refuses a change to a retired document: it is no longer kept, so it is neither verified nor replaced (record a new one instead). */
  #kept(id: string, b: DocObligationBody): void {
    if (b.retired !== undefined) throw new DomainError("invalid_command", `documentation obligation ${id} was retired at ${b.retired.at}: record the document again if it is kept again`, { field: "obligationId" });
  }

  async #index(projectId: string): Promise<{ revision?: number; body: IndexBody }> {
    const found = await this.#runner.get("doc-obligation-index", projectId);
    return { ...(found === undefined ? {} : { revision: found.revision }), body: (found?.body as unknown as IndexBody | undefined) ?? { ids: [] } };
  }

  async #task(id: string): Promise<TaskBody | undefined> { return (await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined; }

  async #register(projectId: string): Promise<CapabilityRegisterBody | undefined> { return (await this.#runner.get("doc-capabilities", projectId))?.body as unknown as CapabilityRegisterBody | undefined; }

  // ---- recording ------------------------------------------------------------------------------------------------------------

  /**
   * Records a documentation obligation, or replaces one (`obligationId` with `expectedRevision`). A change of the implementing tasks, the claims or the version makes it `unverified` again; a change of
   * the title, location or owner keeps its state. Every claim names one of the implementing tasks.
   */
  async record(by: Principal, command: NoActor & { projectId: string; obligationId?: string; expectedRevision?: number; title: string; location: string; audience: string; kind?: string; channel?: string; mediaType?: string; owner: string; applicableVersion: string; implementationRefs: readonly string[]; claims?: readonly { text: string; taskId: string; capabilityId?: string }[] }): Promise<{ id: string; revision: number; replayed: boolean; state: DocState }> {
    only(command, ["commandId", "projectId", "obligationId", "expectedRevision", "title", "location", "audience", "kind", "channel", "mediaType", "owner", "applicableVersion", "implementationRefs", "claims"]);
    const commandId = checkCommandId(command.commandId);
    // Kept redacted, like the claims: the title and the place reach the update tasks' text, the status view and every reader of the project.
    const title = redactText(text(command.title, "title", { min: 1, max: DOC_LIMITS.title }));
    const location = redactText(text(command.location, "location", { min: 1, max: DOC_LIMITS.location }));
    if (!(DOC_AUDIENCES as readonly unknown[]).includes(command.audience)) bad("audience", `must be one of ${DOC_AUDIENCES.join(", ")}`);
    const audience = command.audience as DocAudience;
    const kind = (command.kind ?? "document") as DocKind;
    if (!(DOC_KINDS as readonly unknown[]).includes(kind)) bad("kind", `must be one of ${DOC_KINDS.join(", ")}`);
    if (kind === "support_guidance" && audience !== "support") bad("kind", "support guidance is for the support audience");
    if (kind === "promotional_asset" && audience !== "promotional") bad("kind", "a promotional asset is for the promotional audience");
    // Support guidance and promotional assets say where they are published; a document does not (its location says where it lives).
    if (kind === "document" && command.channel !== undefined) bad("channel", "only support guidance and promotional assets name a channel");
    const channel = kind === "document" ? undefined : redactText(text(command.channel, "channel", { min: 1, max: DOC_LIMITS.channel }));
    if (kind !== "promotional_asset" && command.mediaType !== undefined) bad("mediaType", "only a promotional asset names a media type");
    const mediaType = kind === "promotional_asset" ? ((command.mediaType ?? "text") as DocMedia) : undefined;
    if (mediaType !== undefined && !(DOC_MEDIA as readonly unknown[]).includes(mediaType)) bad("mediaType", `must be one of ${DOC_MEDIA.join(", ")}`);
    const shape = { ...(command.kind === undefined ? {} : { kind }), ...(channel === undefined ? {} : { channel }), ...(mediaType === undefined ? {} : { mediaType }) };
    if (typeof command.owner !== "string" || !AGENT.test(command.owner)) bad("owner", "must be an agent's ID (agent:<id>)");
    const applicableVersion = text(command.applicableVersion, "applicableVersion", { min: 1, max: DOC_LIMITS.version });
    const refs = command.implementationRefs;
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > DOC_LIMITS.refs) bad("implementationRefs", `must list 1 to ${DOC_LIMITS.refs} task IDs`);
    for (const r of refs) checkTaskId(r);
    if (new Set(refs).size !== refs.length) bad("implementationRefs", "names a task twice");
    const rawClaims = command.claims ?? [];
    if (!Array.isArray(rawClaims) || rawClaims.length > DOC_LIMITS.claims) bad("claims", `must be a list of at most ${DOC_LIMITS.claims} claims`);
    const claims: DocClaim[] = rawClaims.map((raw, i) => {
      const o = raw as unknown as Record<string, unknown> | null;
      if (o === null || typeof o !== "object" || Array.isArray(o)) return bad(`claims[${i}]`, "must be an object");
      for (const k of Object.keys(o)) if (k !== "text" && k !== "taskId" && k !== "capabilityId") bad(`claims[${i}].${k}`, "is not a field of a claim");
      const t = text(o["text"], `claims[${i}].text`, { min: 1, max: DOC_LIMITS.claim });
      if (typeof o["taskId"] !== "string" || !refs.includes(o["taskId"])) bad(`claims[${i}].taskId`, "an unsupported claim: a claim must name one of the document's implementing tasks, whose tested code supports it");
      // A claim names the capability it claims (card Q03): the register says whether it is supported; a claim of no known capability is refused below, against the register.
      if (typeof o["capabilityId"] !== "string" || !CAPABILITY_ID.test(o["capabilityId"])) bad(`claims[${i}].capabilityId`, "a claim names the capability it claims, by its ID in the capability register (doc.capability.list)");
      return { text: redactText(t), taskId: o["taskId"] as string, capabilityId: o["capabilityId"] as string };
    });
    const replacing = command.obligationId !== undefined;
    if (replacing && (typeof command.obligationId !== "string" || !DOB.test(command.obligationId))) bad("obligationId", "is not a documentation obligation ID");
    if (replacing && (command.expectedRevision === undefined || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1)) bad("expectedRevision", "is needed to replace an obligation");
    if (!replacing && command.expectedRevision !== undefined) bad("expectedRevision", "is only for replacing an obligation");
    if (by.kind !== "owner" && by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not record documentation obligations`);
    const projectId = await this.#project(by, command.projectId);
    await this.#keeps(by, projectId);
    const scoped = scopedCommandId(by.id, commandId);
    const id = replacing ? command.obligationId! : derivedId("dob", scoped);
    let state: DocState = "unverified";
    const result = await this.#runner.command("doc.obligation.record", { commandId: scoped, actor: by.id }, async () => ({
      payload: { projectId, ...(replacing ? { obligationId: id, expectedRevision: command.expectedRevision! } : {}), title, location, audience, ...shape, owner: command.owner, applicableVersion, implementationRefs: [...refs], claims: json(claims) as unknown as JsonObject },
      build: async () => {
        const owner = (await this.#runner.get("principal", command.owner))?.body as unknown as PrincipalBody | undefined;
        if (owner === undefined || owner.kind !== "agent" || owner.state !== "active") bad("owner", `${command.owner} is not an active agent`);
        // The keeper gets this project's update tasks: it must be an agent that may read the project's tasks, not one of another project.
        const asOf = this.#runner.now();
        const keeper = await effectiveOf(this.#runner, { id: command.owner, kind: "agent", name: owner!.name, grants: owner!.grants, asOf } as Principal, asOf);
        if (!allows(keeper, "task.read", projectId, { now: asOf })) bad("owner", `${command.owner} may not read this project's tasks, so it cannot keep this document`);
        for (const r of refs) { const t = await this.#task(r); if (t === undefined || t.projectId !== projectId) bad("implementationRefs", `${r} is not a task of this project`); }
        const register = effectiveRegister(await this.#register(projectId));
        for (const [i, c] of claims.entries()) if (!register.some((e) => e.id === c.capabilityId)) bad(`claims[${i}].capabilityId`, `${c.capabilityId} is not in this project's capability register: the owner or a director adds it first (doc.capability.set)`);
        const now = this.#runner.now();
        const changes: Change[] = [];
        if (replacing) {
          const current = await this.#obligation(by, id);
          if (current.body.projectId !== projectId) hidden("documentation obligation");
          this.#kept(id, current.body);
          if (current.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the obligation is at revision ${current.revision}`, { currentRevision: current.revision });
          const b = current.body;
          // Compared field by field: a stored record may come back with its keys in another order.
          const claimKey = (c: readonly DocClaim[]): string => JSON.stringify(c.map((x) => [x.taskId, x.text, x.capabilityId ?? null]));
          // What is checked changes with the kind and the media type (a text asset is read, an image is not), so a change of either is a change like the claims; the channel is like the title.
          const same = JSON.stringify(b.implementationRefs) === JSON.stringify(refs) && claimKey(b.claims) === claimKey(claims) && b.applicableVersion === applicableVersion && (b.kind ?? "document") === kind && b.mediaType === mediaType;
          state = same ? b.state : "unverified";
          // A replacement keeps what flagged the document (the reasons on tasks it still describes, a release, when): re-recording it does not clear a flag, only a verification against the flagged work does.
          const reasons = (b.reasons ?? []).filter((r) => r.kind === "release_changed" || r.kind === "capability_changed" || refs.includes(r.taskId));
          const { kind: _k, channel: _c, mediaType: _m, ...unshaped } = b;
          void _k; void _c; void _m;
          const next: DocObligationBody = same ? { ...unshaped, ...shape, title, location, audience, owner: command.owner, changedAt: now }
            : { projectId, title, location, audience, ...shape, owner: command.owner, applicableVersion, implementationRefs: [...refs], claims, recordedBy: b.recordedBy, recordedAt: b.recordedAt, changedAt: now, state: "unverified", updates: b.updates, ...(b.updateCount === undefined ? {} : { updateCount: b.updateCount }),
              ...(reasons.length === 0 ? {} : { reasons }), ...(b.releaseVersion === undefined ? {} : { releaseVersion: b.releaseVersion }), ...(b.flaggedAt === undefined ? {} : { flaggedAt: b.flaggedAt }) };
          changes.push({ type: "update", ref: { kind: "doc-obligation", id }, expectedRevision: current.revision, body: json(next) });
          return { ref: { kind: "doc-obligation", id }, creates: false, changes, detail: { projectId, state } };
        }
        const index = await this.#index(projectId);
        if (index.body.ids.length >= DOC_LIMITS.perProject) throw new DomainError("unavailable", `a project holds at most ${DOC_LIMITS.perProject} documentation obligations`);
        const body: DocObligationBody = { projectId, title, location, audience, ...shape, owner: command.owner, applicableVersion, implementationRefs: [...refs], claims, recordedBy: by.id, recordedAt: now, changedAt: now, state: "unverified", updates: [] };
        const nextIndex = json({ ids: [...index.body.ids, id] });
        changes.push({ type: "create", ref: { kind: "doc-obligation", id }, body: json(body) });
        changes.push(index.revision === undefined ? { type: "create", ref: { kind: "doc-obligation-index", id: projectId }, body: nextIndex } : { type: "update", ref: { kind: "doc-obligation-index", id: projectId }, expectedRevision: index.revision, body: nextIndex });
        return { ref: { kind: "doc-obligation", id }, creates: true, changes, detail: { projectId, state } };
      },
    }));
    if (result.replayed) state = ((await this.#runner.get("doc-obligation", result.id))?.body as unknown as DocObligationBody | undefined)?.state ?? state;
    return { id: result.id, revision: result.revision, replayed: result.replayed, state };
  }

  // ---- verification ---------------------------------------------------------------------------------------------------------

  /**
   * Binds a document change to tested work. `documentSubmissionId` is a `document` submission (made in the docs role) of a task of the same project; `evidence` names, for every implementing task, a code
   * submission of that task whose QA gate passes now. The owner or the document's own owner may verify. A release flag must be answered with its version.
   */
  async verify(by: Principal, command: NoActor & { obligationId: string; expectedRevision: number; documentSubmissionId: string; evidence: readonly string[]; applicableVersion?: string }): Promise<{ id: string; revision: number; replayed: boolean; settled: readonly string[]; verified: boolean; flags: readonly ClaimFlag[]; total: number; scanned: boolean }> {
    only(command, ["commandId", "obligationId", "expectedRevision", "documentSubmissionId", "evidence", "applicableVersion"]);
    const commandId = checkCommandId(command.commandId);
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) bad("expectedRevision", "must be the obligation's revision");
    if (typeof command.documentSubmissionId !== "string" || !SBM.test(command.documentSubmissionId)) bad("documentSubmissionId", "is not a submission ID");
    const ev = command.evidence;
    if (!Array.isArray(ev) || ev.length < 1 || ev.length > DOC_LIMITS.refs || ev.some((e) => typeof e !== "string" || !SBM.test(e)) || new Set(ev).size !== ev.length) bad("evidence", `must list 1 to ${DOC_LIMITS.refs} different code submission IDs`);
    const version = command.applicableVersion === undefined ? undefined : text(command.applicableVersion, "applicableVersion", { min: 1, max: DOC_LIMITS.version });
    const { body: ob } = await this.#obligation(by, command.obligationId);
    // A retired document is refused inside the command (second review), not here: a verification made before the retirement and sent again with its command ID is answered with its result.
    if (by.kind !== "owner" && by.id !== ob.owner) throw new DomainError("forbidden", `only the owner or the document's owner ${ob.owner} verifies it`);
    let settled: string[] = [];
    let flags: ClaimFlag[] = [];
    let total = 0;
    let scanned = false;
    const scoped = scopedCommandId(by.id, commandId);
    const result = await this.#runner.command("doc.obligation.verify", { commandId: scoped, actor: by.id }, async () => ({
      payload: { obligationId: command.obligationId, expectedRevision: command.expectedRevision, documentSubmissionId: command.documentSubmissionId, evidence: [...ev], ...(version === undefined ? {} : { applicableVersion: version }) },
      build: async () => {
        const current = await this.#obligation(by, command.obligationId);
        if (current.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the obligation is at revision ${current.revision}`, { currentRevision: current.revision });
        const b = current.body;
        this.#kept(current.id, b);
        const docFound = await this.#runner.get("submission", command.documentSubmissionId);
        const doc = docFound?.body as unknown as SubmissionBody | undefined;
        if (doc === undefined || doc.projectId !== b.projectId) bad("documentSubmissionId", "is not a submission of this project");
        if (doc!.kind !== "document" || doc!.artifactDigest === undefined) bad("documentSubmissionId", `is a ${doc!.kind} submission: the docs role submits a document change (kind document)`);
        // A flagged document is answered by a document change made since the flag, not by one submitted before it (the document as it was when it went out of date).
        if (b.flaggedAt !== undefined && docFound!.createdAt < b.flaggedAt) bad("documentSubmissionId", `was submitted at ${docFound!.createdAt}, before the document was flagged at ${b.flaggedAt}: submit the updated document (kind document) and verify with that`);
        const target = version ?? b.applicableVersion;
        if (b.releaseVersion !== undefined && target !== b.releaseVersion) bad("applicableVersion", `a release flagged this document for version ${b.releaseVersion}: verify it for that version`);
        const evidence: DocEvidence[] = [];
        const unsupported: string[] = [];
        // The records each QA gate was read from are checked in the write below: new or invalidated QA evidence, a changed task contract or a superseded decision between the read and the write refuses it.
        const bound = new Map<string, { kind: string; id: string; revision: number }>();
        for (const s of ev) {
          const gate = await this.#ports.gate(by, s);
          for (const r of gate.reads ?? []) if (!bound.has(`${r.kind}\u0000${r.id}`)) bound.set(`${r.kind}\u0000${r.id}`, r);
          if (!b.implementationRefs.includes(gate.taskId)) bad("evidence", `${s} is code of task ${gate.taskId}, which this document does not describe`);
          if (evidence.some((e) => e.taskId === gate.taskId)) bad("evidence", `names two code submissions of task ${gate.taskId}`);
          if (gate.verdict !== "passed") unsupported.push(gate.taskId);
          evidence.push({ taskId: gate.taskId, submissionId: s, tree: gate.tree });
        }
        const missing = b.implementationRefs.filter((t) => !evidence.some((e) => e.taskId === t));
        if (missing.length > 0) bad("evidence", `names no tested code of ${missing.join(", ")}: a document is verified against every task it describes`);
        // Flagged for a task's new tested code: the verification is against that code's tree (the newest flag of the task), not the older code the document was checked against before.
        const newest = new Map<string, Extract<DocReason, { kind: "behavior_changed" }>>();
        for (const r of b.reasons ?? []) if (r.kind === "behavior_changed") newest.set(r.taskId, r);
        for (const e of evidence) {
          const want = newest.get(e.taskId);
          if (want !== undefined && want.tree !== e.tree) bad("evidence", `${e.submissionId} is tree ${e.tree.slice(0, 12)} of task ${e.taskId}, but the document was flagged for its new tested code (submission ${want.submissionId}, tree ${want.tree.slice(0, 12)}): verify it against that tree`);
        }
        if (unsupported.length > 0) {
          const claims = b.claims.filter((c) => unsupported.includes(c.taskId)).map((c) => JSON.stringify(c.text));
          throw new DomainError("invalid_command", `the QA gate of ${unsupported.join(", ")} does not pass${claims.length === 0 ? "" : `, so these claims would be unsupported: ${claims.join(", ")}`}`, { field: "evidence" });
        }
        const now = this.#runner.now();
        // The claims (card Q03): every claim against the capability register, and the document's own text scanned for experimental or unsupported capabilities named without a label.
        const claimed = await this.#claimCheck(b, doc!);
        flags = claimed.flags;
        total = flags.length;
        scanned = claimed.scanned;
        if (flags.length > 0) {
          // Refused for its claims, and kept so the owner sees why: the record notes the flags (its state is unchanged); nothing is settled. Fixing the text or the register and verifying again answers it.
          settled = [];
          const blocked: DocObligationBody = { ...b, claimCheck: { at: now, by: by.id, documentSubmissionId: command.documentSubmissionId, scanned, flags: flags.slice(0, CLAIM_LIMITS.flags), total: flags.length } };
          return {
            ref: { kind: "doc-obligation", id: current.id }, creates: false,
            changes: [{ type: "update", ref: { kind: "doc-obligation", id: current.id }, expectedRevision: current.revision, body: json(blocked) }, { type: "check", ref: { kind: "submission", id: command.documentSubmissionId }, expectedRevision: docFound!.revision }],
            detail: { verified: false, scanned, total: flags.length, flags: json(flags.slice(0, CLAIM_LIMITS.flags)) as unknown as JsonObject },
          };
        }
        settled = b.updates.filter((u) => u.state === "open").map((u) => u.taskId);
        const updates = b.updates.map((u) => (u.state === "open" ? { ...u, state: "settled" as const, settledAt: now } : u));
        const { reasons: _r, releaseVersion: _v, flaggedAt: _f, claimCheck: _c, ...rest } = b;
        void _r; void _v; void _f; void _c;
        const next: DocObligationBody = { ...rest, applicableVersion: target, state: "verified", verification: { documentSubmissionId: command.documentSubmissionId, artifactDigest: doc!.artifactDigest!, evidence, version: target, verifiedBy: by.id, verifiedAt: now, claims: { scanned, files: claimed.files, capabilities: claimed.capabilities } }, updates };
        const checks: Change[] = [...bound.values()].filter((r) => r.kind !== "doc-obligation" && !(r.kind === "submission" && r.id === command.documentSubmissionId)).map((r) => ({ type: "check", ref: { kind: r.kind, id: r.id }, expectedRevision: r.revision }));
        return {
          ref: { kind: "doc-obligation", id: current.id }, creates: false,
          changes: [{ type: "update", ref: { kind: "doc-obligation", id: current.id }, expectedRevision: current.revision, body: json(next) }, { type: "check", ref: { kind: "submission", id: command.documentSubmissionId }, expectedRevision: docFound!.revision }, ...checks],
          detail: { settled, verified: true, scanned },
          contention: async () => {
            const now = await this.#runner.get("doc-obligation", current.id);
            if (now !== undefined && now.revision !== current.revision) return new DomainError("stale_revision", `the obligation is at revision ${now.revision}`, { currentRevision: now.revision });
            return new DomainError("stale_revision", "the QA evidence of the code named changed while it was being verified (new or invalidated evidence, a changed task contract or owner decision), or the document submission did: verify again", { currentRevision: current.revision });
          },
        };
      },
    }));
    if (result.replayed) {
      settled = [];
      // The same command again: answered as it was (a refusal for claims is a write, so its flags come from its own audit entry).
      const detail = await this.#recordedDetail(scoped);
      flags = detail?.["verified"] === false && Array.isArray(detail["flags"]) ? (detail["flags"] as unknown as ClaimFlag[]) : [];
      scanned = detail?.["scanned"] === true;
      total = typeof detail?.["total"] === "number" ? detail["total"] : flags.length;
    }
    // At most 20 flags are returned, as the record keeps them; `total` counts all.
    return { id: result.id, revision: result.revision, replayed: result.replayed, settled, verified: total === 0, flags: flags.slice(0, CLAIM_LIMITS.flags), total, scanned };
  }

  /**
   * The claim check of one verification (card Q03). The record's claims against the capability register (each names a capability; unsupported, or experimental without the label, is flagged), the
   * claims' words and the document's text scanned for experimental or unsupported capabilities named bare. The text is the document change's artifact when it names one and the controller can read it; a
   * promotional asset of text (the marketing the card means) is verified only when it was read, since what it claims cannot otherwise be checked. An image, video or other medium is not read: its
   * declared claims are what is checked.
   */
  async #claimCheck(b: DocObligationBody, doc: SubmissionBody): Promise<{ flags: ClaimFlag[]; scanned: boolean; files: number; capabilities: Record<string, CapabilityMaturity> }> {
    const register = effectiveRegister(await this.#register(b.projectId));
    const declared = checkDeclared(b.claims, register);
    const flags = [...declared.flags];
    const capabilities: Record<string, CapabilityMaturity> = { ...declared.capabilities };
    const add = (r: { flags: ClaimFlag[]; capabilities: Record<string, CapabilityMaturity> }): void => { flags.push(...r.flags); Object.assign(capabilities, r.capabilities); };
    b.claims.forEach((c, i) => add(scanText(c.text, register.filter((e) => e.id !== c.capabilityId), `claim ${i + 1}`)));
    let scanned = false;
    let files = 0;
    if (doc.artifactId !== undefined && doc.artifactDigest !== undefined && this.#ports.readDocument !== undefined) {
      const read = await this.#ports.readDocument({ artifactId: doc.artifactId, artifactDigest: doc.artifactDigest, projectId: b.projectId });
      scanned = read.files.length > 0;
      files = read.files.length;
      for (const f of read.files) add(scanText(f.text, register, fileWhere(f.path)));
      // A file named as text that was not read (too many, too large, not UTF-8) is a flag: its claims would otherwise pass unchecked.
      for (const u of read.unread ?? []) flags.push({ rule: "text_unread", source: "text", where: fileWhere(u.path), quote: u.why });
    }
    if (b.audience === "promotional" && (b.mediaType ?? "text") === "text" && !scanned) {
      bad("documentSubmissionId", doc.artifactId === undefined ? "a promotional text is verified only once its text is read: submit the document change naming its artifact (artifactId)"
        : this.#ports.readDocument === undefined ? "a promotional text is verified only once its text is read, and this controller keeps no artifacts to read it from"
        : "a promotional text is verified only once its text is read, and its artifact has no file readable as text");
    }
    return { flags, scanned, files, capabilities };
  }

  /** The audit detail a command recorded (its first entry), or undefined when it cannot be read. */
  async #recordedDetail(scopedId: string): Promise<JsonObject | undefined> {
    try {
      const operationId = operationIdOf(scopedId);
      const stored = await this.#runner.storage.getOperation(operationId);
      const seq = stored?.result.auditSeqs[0];
      if (seq === undefined) return undefined;
      const entry = (await this.#runner.storage.listAudit({ afterSeq: seq - 1, limit: 1 }))[0];
      return entry?.seq === seq && entry.operationId === operationId ? entry.detail : undefined;
    } catch { return undefined; }
  }

  // ---- the capability register ------------------------------------------------------------------------------------------

  /**
   * Sets one capability of the project's register (card Q03): its maturity (`supported`, `experimental` or `unsupported`), its name and the names the text scan looks for, and a note. A built-in entry
   * (the controller's own labels) may be replaced, as a recorded decision. The owner, or an agent holding the director role in the project: not the docs role, so the agent writing a document cannot rate
   * what it claims. A capability rated lower than when a document was verified (supported to experimental, or either to unsupported) flags that document with an update task for its keeper, like a
   * release does; a document that names it but was never verified is checked when it is verified. Asked again with the same command ID, the flagging is finished, nothing repeats.
   */
  async setCapability(by: Principal, command: NoActor & { projectId: string; capabilityId: string; maturity: string; name?: string; names?: readonly string[]; note?: string }): Promise<{ projectId: string; capabilityId: string; maturity: CapabilityMaturity; from?: CapabilityMaturity; replayed: boolean; flagged: readonly string[]; tasks: readonly { obligationId: string; taskId: string; assigned: boolean }[] }> {
    only(command, ["commandId", "projectId", "capabilityId", "maturity", "name", "names", "note"]);
    const commandId = checkCommandId(command.commandId);
    if (typeof command.capabilityId !== "string" || !CAPABILITY_ID.test(command.capabilityId)) bad("capabilityId", "must be lower-case letters, digits and hyphens, starting with a letter (2 to 60)");
    const capabilityId = command.capabilityId;
    if (!(CAPABILITY_MATURITIES as readonly unknown[]).includes(command.maturity)) bad("maturity", `must be one of ${CAPABILITY_MATURITIES.join(", ")}`);
    const maturity = command.maturity as CapabilityMaturity;
    const nameOf = (v: unknown, field: string): string => {
      const t = cleanText(text(v, field, { min: CLAIM_LIMITS.nameMin, max: CLAIM_LIMITS.name }), true);
      if (t.length < CLAIM_LIMITS.nameMin) bad(field, `must have at least ${CLAIM_LIMITS.nameMin} characters that are not marks or spaces`);
      return t;
    };
    const name = command.name === undefined ? undefined : nameOf(command.name, "name");
    if (command.names !== undefined && (!Array.isArray(command.names) || command.names.length < 1 || command.names.length > CLAIM_LIMITS.names)) bad("names", `must list 1 to ${CLAIM_LIMITS.names} names`);
    const names = command.names?.map((x, i) => nameOf(x, `names[${i}]`));
    const note = command.note === undefined ? undefined : redactText(text(command.note, "note", { min: 1, max: CLAIM_LIMITS.note }));
    if (by.kind !== "owner" && by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not rate capabilities`);
    const projectId = await this.#project(by, command.projectId);
    if (by.kind !== "owner") {
      const roles = await this.#ports.rolesOf(by.id, { projectId, taskId: "" }, by);
      if (!roles.includes("director")) throw new DomainError("forbidden", `${by.id} does not hold the director role in this project: the owner or a director rates capabilities`);
    }
    const scoped = scopedCommandId(by.id, commandId);
    let from: CapabilityMaturity | undefined;
    const result = await this.#runner.command("doc.capability.set", { commandId: scoped, actor: by.id }, async () => ({
      payload: { projectId, capabilityId, maturity, ...(name === undefined ? {} : { name }), ...(names === undefined ? {} : { names }), ...(note === undefined ? {} : { note }) },
      build: async () => {
        const found = await this.#runner.get("doc-capabilities", projectId);
        const reg = (found?.body as unknown as CapabilityRegisterBody | undefined) ?? { projectId, entries: [], changedAt: "" };
        const before = effectiveRegister(reg).find((e) => e.id === capabilityId);
        from = before?.maturity;
        // The controller's own labels come from the code (a cache never measured, an owner decision): only the owner rates one higher, as a decision of their own. A director may rate one lower.
        const builtIn = builtInCapabilities().find((e) => e.id === capabilityId);
        if (builtIn !== undefined && by.kind !== "owner" && maturityRank(maturity) > maturityRank(builtIn.maturity)) throw new DomainError("forbidden", `${capabilityId} is ${builtIn.maturity} by the controller's own label: only the owner rates it higher`);
        const own = reg.entries.find((e) => e.id === capabilityId);
        if (own === undefined && reg.entries.length >= CLAIM_LIMITS.entries) throw new DomainError("unavailable", `a project's capability register holds at most ${CLAIM_LIMITS.entries} capabilities`);
        const finalName = name ?? before?.name ?? bad("name", "a new capability needs a name");
        const all = [...new Set([finalName, ...(names ?? before?.names ?? [])])].slice(0, CLAIM_LIMITS.names);
        const finalNote = note ?? before?.note;
        const now = this.#runner.now();
        const entry = { id: capabilityId, name: finalName, names: all, maturity, ...(finalNote === undefined ? {} : { note: finalNote }), setBy: by.id, setAt: now };
        const entries = [...reg.entries.filter((e) => e.id !== capabilityId), entry].sort((a, b) => (a.id < b.id ? -1 : 1));
        const body = json({ projectId, entries, changedAt: now });
        return {
          ref: { kind: "doc-capabilities", id: projectId }, creates: found === undefined,
          changes: [found === undefined ? { type: "create", ref: { kind: "doc-capabilities", id: projectId }, body } : { type: "update", ref: { kind: "doc-capabilities", id: projectId }, expectedRevision: found.revision, body }],
          detail: { projectId, capabilityId, to: maturity, ...(from === undefined ? {} : { from }) },
        };
      },
    }));
    if (result.replayed) { const d = await this.#recordedDetail(scoped); from = typeof d?.["from"] === "string" ? (d["from"] as CapabilityMaturity) : undefined; }
    // Documents verified while the capability was rated higher: flagged, also on a repeat (finishing what a stop after the write left). Read from the register as it is now, so a later change wins.
    const plan = async (): Promise<Planned[]> => {
      const now = effectiveRegister(await this.#register(projectId)).find((e) => e.id === capabilityId);
      if (now === undefined) return [];
      const out: Planned[] = [];
      for (const id of (await this.#index(projectId)).body.ids) {
        const found = await this.#runner.get("doc-obligation", id);
        const b = found?.body as unknown as DocObligationBody | undefined;
        if (found === undefined || b === undefined || b.retired !== undefined || b.state === "unverified") continue;
        const was = b.verification?.claims?.capabilities[capabilityId];
        if (was === undefined || maturityRank(was) <= maturityRank(now.maturity)) continue;
        const p = this.#planned(id, found.revision, b, [{ kind: "capability_changed", capabilityId, from: was, to: now.maturity }]);
        if (p !== undefined) out.push(p);
      }
      return out;
    };
    const flagged = await this.#flag(by, `doc-capability:${createHash("sha256").update(scoped).digest("hex").slice(0, 40)}`, "doc.capability.check", { projectId, capabilityId, maturity }, plan);
    return { projectId, capabilityId, maturity, ...(from === undefined ? {} : { from }), replayed: result.replayed, flagged: flagged.flagged, tasks: flagged.tasks };
  }

  /** The capability register claims are checked against (built-in entries, replaced by the project's own), each with how many kept documents claim or name it (a claim, a verification, or a refusal for it). Readers of the project. */
  async capabilities(by: Principal, projectIdValue: string): Promise<{ projectId: string; items: (CapabilityEntry & { documents: number })[] }> {
    const projectId = await this.#project(by, projectIdValue);
    const register = effectiveRegister(await this.#register(projectId));
    const count = new Map<string, number>();
    for (const id of (await this.#index(projectId)).body.ids) {
      const b = (await this.#runner.get("doc-obligation", id))?.body as unknown as DocObligationBody | undefined;
      if (b === undefined || b.retired !== undefined) continue;
      const named = new Set([...b.claims.map((c) => c.capabilityId), ...Object.keys(b.verification?.claims?.capabilities ?? {}), ...(b.claimCheck?.flags ?? []).map((f) => f.capabilityId)].filter((x): x is string => x !== undefined));
      for (const c of named) count.set(c, (count.get(c) ?? 0) + 1);
    }
    return { projectId, items: register.map((e) => ({ ...e, documents: count.get(e.id) ?? 0 })) };
  }

  // ---- retiring -------------------------------------------------------------------------------------------------------------

  /**
   * Takes a document away (card Q03): it is no longer kept (the page was removed, or merged into another). It leaves the project's list in the same write, so no impact or release check flags it again and
   * it no longer counts toward the project's limit; the record stays readable by its ID (`get`), marked retired, and can be neither verified nor replaced. Its open update tasks are dropped: each one
   * that has not started (proposed, ready or blocked) is cancelled; one already in progress is left to its agent, whose verification is then refused, and is reported as `running`. The owner, or a docs or
   * director agent of the project (the same people who record documents). Repeating the command finishes the cancellations a failure left.
   */
  async retire(by: Principal, command: NoActor & { obligationId: string; expectedRevision: number; reason?: string }): Promise<{ id: string; revision: number; replayed: boolean; cancelled: readonly string[]; running: readonly string[] }> {
    only(command, ["commandId", "obligationId", "expectedRevision", "reason"]);
    const commandId = checkCommandId(command.commandId);
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) bad("expectedRevision", "must be the obligation's revision");
    const reason = command.reason === undefined ? undefined : redactText(text(command.reason, "reason", { min: 1, max: DOC_LIMITS.reason }));
    if (by.kind !== "owner" && by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not retire documentation obligations`);
    const first = await this.#obligation(by, command.obligationId);
    await this.#keeps(by, first.body.projectId);
    const scoped = scopedCommandId(by.id, commandId);
    const result = await this.#runner.command("doc.obligation.retire", { commandId: scoped, actor: by.id }, async () => ({
      payload: { obligationId: first.id, expectedRevision: command.expectedRevision, ...(reason === undefined ? {} : { reason }) },
      build: async () => {
        const current = await this.#obligation(by, first.id);
        if (current.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the obligation is at revision ${current.revision}`, { currentRevision: current.revision });
        this.#kept(current.id, current.body);
        const b = current.body;
        const now = this.#runner.now();
        const index = await this.#index(b.projectId);
        const next: DocObligationBody = { ...b, updates: b.updates.map((u) => (u.state === "open" ? { ...u, state: "dropped" as const, settledAt: now } : u)), retired: { by: by.id, at: now, ...(reason === undefined ? {} : { reason }) } };
        const changes: Change[] = [{ type: "update", ref: { kind: "doc-obligation", id: current.id }, expectedRevision: current.revision, body: json(next) }];
        // Out of the project's list in the same write: a check that read the list before this write and the record after it skips the retired record (every plan does).
        if (index.revision !== undefined) changes.push({ type: "update", ref: { kind: "doc-obligation-index", id: b.projectId }, expectedRevision: index.revision, body: json({ ids: index.body.ids.filter((x) => x !== current.id) }) });
        return { ref: { kind: "doc-obligation", id: current.id }, creates: false, changes, detail: { projectId: b.projectId } };
      },
    }));
    // The dropped update tasks (on a repeat too: whatever a failure left not cancelled): cancelled unless already started or finished.
    const stored = (await this.#runner.get("doc-obligation", result.id))?.body as unknown as DocObligationBody | undefined;
    const cancelled: string[] = [];
    const running: string[] = [];
    for (const u of stored?.retired === undefined ? [] : stored.updates.filter((x) => x.state === "dropped")) {
      const found = await this.#runner.get("task", u.taskId);
      const t = found?.body as unknown as TaskBody | undefined;
      if (found === undefined || t === undefined || t.state === "done") continue;
      if (t.state === "cancelled") { cancelled.push(u.taskId); continue; }
      if (t.state === "in_progress") { running.push(u.taskId); continue; }
      try {
        await this.#ports.projects.transitionTask({ commandId: `doc-retire:${u.taskId}:cancel:${found.revision}`, actor: by.id, taskId: u.taskId, expectedRevision: found.revision, to: "cancelled" });
        cancelled.push(u.taskId);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        // Moved meanwhile: reported as running when it started, else left for a repeat of the command to cancel.
        const state = (await this.#task(u.taskId))?.state;
        if (state === "cancelled") cancelled.push(u.taskId); else if (state === "in_progress") running.push(u.taskId);
      }
    }
    return { id: result.id, revision: result.revision, replayed: result.replayed, cancelled, running };
  }

  // ---- impact and release ---------------------------------------------------------------------------------------------------

  /**
   * The documents a task's tested code affects. `submissionId` names the code (a code submission of the task); without it, the newest independently checked one is used. When that code's QA gate passes,
   * every document of the project describing the task that was verified against another tree of it, and every unverified one, is flagged for it; whatever the code, a document whose own evidence for the
   * task no longer passes is flagged as well. A flagged document gets an update task assigned to its owner and linked to that code, one open task per task described (a further change of the same task is
   * noted on the record, and the verification must then be against the newest tested code). Asked again, nothing is repeated. The owner or a docs or director agent asks.
   */
  async impact(by: Principal, command: NoActor & { taskId: string; submissionId?: string }): Promise<{ taskId: string; submissionId: string; tree: string; verdict: "passed" | "failed"; flagged: readonly string[]; tasks: readonly { obligationId: string; taskId: string; assigned: boolean }[]; replayed: boolean }> {
    return this.#impact(by, command, false);
  }

  /**
   * `impact`; `newestOnly` (the automatic check after QA evidence) leaves a document that is already verified against, or flagged for, code of the task submitted after the code named: QA evidence recorded
   * late on older code does not move the document back to that code (its keeper would have to verify against older code, and could not at all once that code's gate stopped passing). Going back to an
   * old tree is a new code submission, so it still flags. Lost evidence is still looked for.
   */
  async #impact(by: Principal, command: NoActor & { taskId: string; submissionId?: string }, newestOnly: boolean): Promise<{ taskId: string; submissionId: string; tree: string; verdict: "passed" | "failed"; flagged: readonly string[]; tasks: readonly { obligationId: string; taskId: string; assigned: boolean }[]; replayed: boolean }> {
    only(command, ["commandId", "taskId", "submissionId"]);
    const commandId = checkCommandId(command.commandId);
    const taskId = checkTaskId(command.taskId);
    const task = await this.#task(taskId);
    if (task === undefined || !this.#reads(by, task.projectId)) return hidden("task");
    await this.#keeps(by, task!.projectId);
    let submissionId = command.submissionId;
    if (submissionId === undefined) submissionId = this.#ports.newestChecked === undefined ? undefined : await this.#ports.newestChecked(by, taskId);
    if (submissionId === undefined) bad("submissionId", "the task has no independently checked code yet: name the code submission");
    if (typeof submissionId !== "string" || !SBM.test(submissionId)) bad("submissionId", "is not a submission ID");
    const gate = await this.#ports.gate(by, submissionId!);
    if (gate.taskId !== taskId) bad("submissionId", `is code of task ${gate.taskId}, not ${taskId}`);
    // Code whose QA gate does not pass is not tested behaviour: it flags nothing as changed (the update task would name untested code), but a document's own evidence is still checked.
    const tested = gate.verdict === "passed";
    const submittedAt = async (id: string): Promise<string | undefined> => ((await this.#runner.get("submission", id))?.body as unknown as SubmissionBody | undefined)?.submittedAt;
    const named = newestOnly && tested ? await submittedAt(submissionId!) : undefined;
    // Whether the document is already verified against, or flagged for, code of the task submitted after the code named (the automatic check only).
    const behind = async (b: DocObligationBody, was: DocEvidence | undefined): Promise<boolean> => {
      if (named === undefined) return false;
      const current = [...(b.reasons ?? [])].reverse().find((r): r is Extract<DocReason, { kind: "behavior_changed" }> => r.kind === "behavior_changed" && r.taskId === taskId)?.submissionId ?? was?.submissionId;
      if (current === undefined || current === submissionId) return false;
      const at = await submittedAt(current);
      return at !== undefined && at > named;
    };
    const plan = async (): Promise<Planned[]> => {
      const out: Planned[] = [];
      for (const id of (await this.#index(task!.projectId)).body.ids) {
        const found = await this.#runner.get("doc-obligation", id);
        const b = found?.body as unknown as DocObligationBody | undefined;
        if (found === undefined || b === undefined || b.retired !== undefined || !b.implementationRefs.includes(taskId)) continue;
        const reasons: DocReason[] = [];
        const was = b.state === "unverified" ? undefined : b.verification?.evidence.find((e) => e.taskId === taskId);
        const newer = tested && (await behind(b, was));
        if (was === undefined) { if (tested && !newer) reasons.push({ kind: "behavior_changed", taskId, submissionId: submissionId!, tree: gate.tree }); }
        else if (tested && !newer && was.tree !== gate.tree) reasons.push({ kind: "behavior_changed", taskId, submissionId: submissionId!, tree: gate.tree, from: was.tree });
        else if ((was.submissionId === submissionId ? gate : await this.#ports.gate(by, was.submissionId)).verdict !== "passed") reasons.push({ kind: "evidence_lost", taskId, submissionId: was.submissionId });
        const p = this.#planned(id, found.revision, b, reasons);
        if (p !== undefined) out.push(p);
      }
      return out;
    };
    const flagged = await this.#flag(by, commandId, "doc.impact.check", { taskId, submissionId: submissionId! }, plan);
    return { taskId, submissionId: submissionId!, tree: gate.tree, verdict: gate.verdict, ...flagged };
  }

  /**
   * The automatic impact check after QA evidence is recorded (card Q03): independent evidence may change a task's QA gate, so the task's documents are checked against the code it names exactly as
   * `impact` does when asked (as the controller, `DOC_AUTO_PRINCIPAL`), except that a document already verified against, or flagged for, newer code of the task is left as it is. A self-check never counts for a gate and checks nothing. The command ID comes from the evidence record, so the repeat of the same
   * record (a crash after the record) is a repeat of the same check: nothing is flagged twice, and update tasks not yet opened are opened.
   */
  async afterQaEvidence(e: { readonly evidenceId: string; readonly taskId: string; readonly submissionId: string; readonly source: "self" | "independent" }): Promise<Awaited<ReturnType<DocObligationService["impact"]>> | undefined> {
    if (e.source !== "independent") return undefined;
    return this.#impact(DOC_AUTO_PRINCIPAL, { commandId: `doc-impact:${e.evidenceId}`, taskId: e.taskId, submissionId: e.submissionId }, true);
  }

  /**
   * The automatic check after QA evidence was invalidated (card Q03): a document verified against code of the task whose QA gate no longer passes is flagged (`evidence_lost`) with an update task. Only lost
   * evidence is looked for: the invalidated code is not new behaviour, so nothing is flagged as changed. One command per invalidated record.
   */
  async afterQaInvalidation(e: { readonly taskId: string; readonly evidence: readonly { readonly evidenceId: string; readonly submissionId: string }[] }): Promise<{ flagged: readonly string[]; tasks: readonly { obligationId: string; taskId: string; assigned: boolean }[] }> {
    const by = DOC_AUTO_PRINCIPAL;
    const taskId = checkTaskId(e.taskId);
    const task = await this.#task(taskId);
    if (task === undefined) return hidden("task");
    const flagged = new Set<string>();
    const tasks: { obligationId: string; taskId: string; assigned: boolean }[] = [];
    for (const x of e.evidence) {
      const plan = async (): Promise<Planned[]> => {
        const out: Planned[] = [];
        for (const id of (await this.#index(task!.projectId)).body.ids) {
          const found = await this.#runner.get("doc-obligation", id);
          const b = found?.body as unknown as DocObligationBody | undefined;
          if (found === undefined || b === undefined || b.retired !== undefined || b.state === "unverified" || !b.implementationRefs.includes(taskId)) continue;
          const was = b.verification?.evidence.find((v) => v.taskId === taskId);
          if (was === undefined || (await this.#ports.gate(by, was.submissionId)).verdict === "passed") continue;
          const p = this.#planned(id, found.revision, b, [{ kind: "evidence_lost", taskId, submissionId: was.submissionId }]);
          if (p !== undefined) out.push(p);
        }
        return out;
      };
      const r = await this.#flag(by, `doc-evidence-lost:${x.evidenceId}`, "doc.impact.check", { taskId, invalidated: x.evidenceId, submissionId: x.submissionId }, plan);
      for (const f of r.flagged) flagged.add(f);
      for (const t of r.tasks) if (!tasks.some((y) => y.taskId === t.taskId)) tasks.push(t);
    }
    return { flagged: [...flagged], tasks };
  }

  /**
   * What the landing gate reads for the `docs` required check (card P09, fourth slice): READ ONLY, nothing is flagged or opened. Of the project's documents still kept that describe the task (`implementationRefs`), every one that
   * is not verified against this code (the submission named, or another submission of the task with the very same tree) whose QA gate still passes is pending, with the reason in plain words: never verified, flagged
   * stale, verified for a task but not for this one, or checked against other code or code that lost its QA gate. A task no document describes has nothing pending. The gate's tree is the submission's own, so the landing gate can bind it to the landed patch.
   */
  async landing(by: Principal, command: { taskId: string; submissionId: string }): Promise<{ taskId: string; submissionId: string; tree: string; checked: number; pending: readonly { obligationId: string; title: string; reason: string }[] }> {
    const taskId = checkTaskId(command.taskId);
    if (typeof command.submissionId !== "string" || !SBM.test(command.submissionId)) bad("submissionId", "is not a submission ID");
    const task = await this.#task(taskId);
    if (task === undefined || !this.#reads(by, task.projectId)) return hidden("task");
    const gate = await this.#ports.gate(by, command.submissionId);
    if (gate.taskId !== taskId) bad("submissionId", `is code of task ${gate.taskId}, not ${taskId}`);
    const pending: { obligationId: string; title: string; reason: string }[] = [];
    // Many documents can stand on the same code: each submission's QA gate is read once per landing (a project keeps up to DOC_LIMITS.perProject documents).
    const gates = new Map<string, Awaited<ReturnType<DocObligationPorts["gate"]>>>([[command.submissionId, gate]]);
    let checked = 0;
    for (const id of (await this.#index(task.projectId)).body.ids) {
      const found = await this.#runner.get("doc-obligation", id);
      const b = found?.body as unknown as DocObligationBody | undefined;
      if (found === undefined || b === undefined || b.retired !== undefined || !b.implementationRefs.includes(taskId)) continue;
      checked += 1;
      const why = async (): Promise<string | undefined> => {
        if (b.state === "unverified") return "it was never verified against tested code";
        if (b.state === "stale") return `it is stale and its update is still due${b.reasons === undefined || b.reasons.length === 0 ? "" : ` (${docReasonText(b.reasons[b.reasons.length - 1]!)})`}`;
        const was = b.verification?.evidence.find((e) => e.taskId === taskId);
        if (was === undefined) return `it was not verified against any tested code of task ${taskId}`;
        if (was.tree !== gate.tree) return `it was verified against tree ${was.tree.slice(0, 12)}, not this code (tree ${gate.tree.slice(0, 12)})`;
        let g = gates.get(was.submissionId);
        if (g === undefined) { g = await this.#ports.gate(by, was.submissionId); gates.set(was.submissionId, g); }
        return g.verdict === "passed" ? undefined : `the tested code it was verified against (${was.submissionId}) no longer passes its QA gate`;
      };
      const reason = await why();
      if (reason !== undefined) pending.push({ obligationId: id, title: b.title, reason });
    }
    return { taskId, submissionId: command.submissionId, tree: gate.tree, checked, pending };
  }

  /** A release of `version`: every document of the project that applies to another version (user, developer, support and promotional alike) is flagged stale with an update task for its owner. */
  async release(by: Principal, command: NoActor & { projectId: string; version: string }): Promise<{ projectId: string; version: string; flagged: readonly string[]; byAudience: Readonly<Record<DocAudience, number>>; byKind: Readonly<Record<DocKind, number>>; tasks: readonly { obligationId: string; taskId: string; assigned: boolean }[]; replayed: boolean }> {
    only(command, ["commandId", "projectId", "version"]);
    const commandId = checkCommandId(command.commandId);
    const version = text(command.version, "version", { min: 1, max: DOC_LIMITS.version });
    const projectId = await this.#project(by, command.projectId);
    await this.#keeps(by, projectId);
    const plan = async (): Promise<Planned[]> => {
      const out: Planned[] = [];
      for (const id of (await this.#index(projectId)).body.ids) {
        const found = await this.#runner.get("doc-obligation", id);
        const b = found?.body as unknown as DocObligationBody | undefined;
        if (found === undefined || b === undefined || b.retired !== undefined || b.applicableVersion === version) continue;
        const p = this.#planned(id, found.revision, b, [{ kind: "release_changed", from: b.applicableVersion, to: version }]);
        if (p !== undefined) out.push(p);
      }
      return out;
    };
    const flagged = await this.#flag(by, commandId, "doc.release.check", { projectId, version }, plan);
    const byAudience: Record<DocAudience, number> = { user: 0, developer: 0, support: 0, promotional: 0 };
    const byKind: Record<DocKind, number> = { document: 0, support_guidance: 0, promotional_asset: 0 };
    for (const id of flagged.flagged) { const b = (await this.#runner.get("doc-obligation", id))?.body as unknown as DocObligationBody | undefined; if (b !== undefined) { byAudience[b.audience]++; byKind[b.kind ?? "document"]++; } }
    return { projectId, version, flagged: flagged.flagged, byAudience, byKind, tasks: flagged.tasks, replayed: flagged.replayed };
  }

  /**
   * Which of a document's reasons are new, and which of those get an update task. A reason already noted since the document was last verified or recorded, or already behind an open update task, is not
   * new (asked again, nothing repeats; a reason seen in an earlier, settled cycle is new again, so going back to older code flags the document). A new reason gets a task unless an update task on the
   * same subject (the same implementing task, or the release) is still open, or the document already has the limit of open update tasks: then it is only noted.
   */
  #planned(id: string, revision: number, b: DocObligationBody, candidates: readonly DocReason[]): Planned | undefined {
    const open = b.updates.filter((u) => u.state === "open");
    const known = new Set([...open.map((u) => reasonKey(u.reason)), ...(b.reasons ?? []).map(reasonKey)]);
    const reasons = candidates.filter((r) => !known.has(reasonKey(r)));
    if (reasons.length === 0) return undefined;
    const subjects = new Set(open.map((u) => subjectOf(u.reason)));
    const tasks: DocReason[] = [];
    for (const r of reasons) if (!subjects.has(subjectOf(r)) && open.length + tasks.length < DOC_LIMITS.updates) { tasks.push(r); subjects.add(subjectOf(r)); }
    return { id, revision, body: b, reasons, tasks };
  }

  /**
   * Writes the flags (one command: every flagged document with its update task's ID planned), then opens each planned update task that does not exist yet: created, made ready and assigned to the
   * document's owner, each step skipped when already done, so a repeat finishes what a failure left. An assignment that cannot be made leaves the task open and unassigned (reported, and shown).
   */
  async #flag(by: Principal, commandId: string, type: string, payload: JsonObject, plan: () => Promise<Planned[]>): Promise<{ flagged: string[]; tasks: { obligationId: string; taskId: string; assigned: boolean }[]; replayed: boolean }> {
    const scoped = scopedCommandId(by.id, commandId);
    let made: { obligationId: string; taskId: string; create: string; projectId: string; title: string; description: string; owner: string }[] = [];
    let flagged: string[] = [];
    let staled: { id: string; projectId: string; title: string }[] = [];
    // How many verified documents went stale: the stored entry keeps at most 20 of them, so a repeat reads the count from it (and the notice it sends again says the same).
    let staledTotal = 0;
    let replayed = false;
    let wrote = false;
    // Documents that were verified went stale: the owner is told, unless the owner ran this check (they read the answer).
    const tells = this.#ports.notify !== undefined && (by.kind !== "owner" || by.id === DOC_AUTO_PRINCIPAL.id);
    // The command always goes through the runner, so a command ID used before is answered with its result, or refused as `command_conflict` when it was used with other arguments, even when there is
    // nothing new to write now. Nothing new (asked again, or a concurrent check wrote the same flags first) is not an error: the open update tasks are finished below.
    const nothing = new DomainError("not_found", "no document has anything new to flag");
    try {
      const result = await this.#runner.command(type, { commandId: scoped, actor: by.id }, async () => ({
        payload,
        build: async () => {
          const found = await plan();
          if (found.length === 0) throw nothing;
          const now = this.#runner.now();
          const changes: Change[] = [];
          made = [];
          staled = [];
          for (const f of found) {
            let count = f.body.updateCount ?? f.body.updates.length;
            const added: DocUpdate[] = [];
            for (const r of f.tasks) {
              const create = createCommandOf(f.id, count);
              const updateTask = derivedId("task", create);
              added.push({ taskId: updateTask, seq: count, reason: r, requestedBy: by.id, requestedAt: now, state: "open" });
              made.push({ obligationId: f.id, taskId: updateTask, create, projectId: f.body.projectId, owner: f.body.owner, ...this.#describe(f.id, f.body, r) });
              count++;
            }
            // Settled updates beyond the limit are dropped, oldest first (their tasks stay ordinary tasks); open ones are kept, and #planned never opens more than the limit.
            const kept = [...f.body.updates];
            for (let i = 0; kept.length + added.length > DOC_LIMITS.updates && i < kept.length;) { if (kept[i]!.state === "settled") kept.splice(i, 1); else i++; }
            const releaseTo = [...f.reasons].reverse().find((r): r is Extract<DocReason, { kind: "release_changed" }> => r.kind === "release_changed")?.to;
            const state: DocState = f.body.state === "unverified" ? "unverified" : "stale";
            if (f.body.state === "verified") staled.push({ id: f.id, projectId: f.body.projectId, title: f.body.title });
            const next: DocObligationBody = { ...f.body, state, reasons: [...(f.body.reasons ?? []), ...f.reasons].slice(-DOC_LIMITS.updates), ...(releaseTo === undefined ? {} : { releaseVersion: releaseTo }), flaggedAt: now, updates: [...kept, ...added], updateCount: count };
            changes.push({ type: "update", ref: { kind: "doc-obligation", id: f.id }, expectedRevision: f.revision, body: json(next) });
          }
          flagged = found.map((f) => f.id);
          // The stale documents are kept in the audit detail (at most 20, titles cut whole) so a repeat of this check can send the notice a stop after the write lost (card Q03).
          return { ref: { kind: "doc-obligation", id: found[0]!.id }, creates: false, changes, detail: { flagged, ...(staled.length === 0 ? {} : { staled: staled.slice(0, 20).map((d) => ({ id: d.id, projectId: d.projectId, title: wholeCut(d.title, 60) })) }), ...(staled.length > 20 ? { staledTotal: staled.length } : {}) } };
        },
      }));
      replayed = result.replayed;
      wrote = !result.replayed;
      staledTotal = staled.length;
      // A repeat sends the notice again under the same notice ID (the controller keeps one notice per ID), so a stop between the write and the notice, or a notice that could not be sent, is made up.
      // Only when a notice would be sent at all (not for the owner's own check).
      if (replayed) ({ docs: staled, total: staledTotal } = tells ? await this.#recordedStaled(scoped) : { docs: [], total: 0 });
    } catch (error) {
      if (error !== nothing) throw error;
    }
    if (!wrote) {
      // A replay, or nothing new: finish the update tasks the project's documents still have open and not fully opened (not created, still proposed, or ready with no assignment: a failure between steps).
      made = [];
      flagged = [];
      const ids = new Set<string>();
      const projectId = (payload["projectId"] as string | undefined) ?? (await this.#task(payload["taskId"] as string))?.projectId;
      for (const id of projectId === undefined ? [] : (await this.#index(projectId)).body.ids) {
        const b = (await this.#runner.get("doc-obligation", id))?.body as unknown as DocObligationBody | undefined;
        for (const u of b?.updates ?? []) if (u.state === "open" && !ids.has(u.taskId) && (await this.#unopened(u.taskId))) { ids.add(u.taskId); made.push({ obligationId: id, taskId: u.taskId, create: createCommandOf(id, u.seq), projectId: b!.projectId, owner: b!.owner, ...this.#describe(id, b!, u.reason) }); }
      }
    }
    const tasks: { obligationId: string; taskId: string; assigned: boolean }[] = [];
    for (const m of made) tasks.push({ obligationId: m.obligationId, taskId: m.taskId, assigned: await this.#open(by, m) });
    // The notice, after the update tasks, so it can say who has them.
    if (staled.length > 0 && tells && this.#ports.notify !== undefined) {
      // Cut on whole characters (first review): a cut through a character written as two UTF-16 units would leave half of it, which the notice's text check refuses, and the notice would be lost.
      const cut = wholeCut;
      // At most the 20 names the audit entry keeps, so the notice a repeat sends again reads the same.
      const names = staled.slice(0, 20).map((d) => `"${cut(d.title, 60)}"`).join(", ");
      const text = `${staledTotal === 1 ? "A verified document went" : `${staledTotal} verified documents went`} stale: ${names}. Update tasks went to their keepers; the docs view shows why.`;
      const noticeId = `doc-stale:${createHash("sha256").update(scoped).digest("hex").slice(0, 40)}`;
      await this.#ports.notify({ commandId: noticeId, projectId: staled[0]!.projectId, obligationId: staled[0]!.id, text: text.length <= 200 ? text : `${cut(text, 196)}...` }).catch(() => undefined);
    }
    return { flagged, tasks, replayed };
  }

  /**
   * The documents the check recorded as gone stale (from its own audit entry: the entry of this operation) that are not verified again nor retired since, and how many in all, for a repeat that must
   * send the notice again. Nothing when the entry cannot be read or was written before it kept them.
   */
  async #recordedStaled(scopedId: string): Promise<{ docs: { id: string; projectId: string; title: string }[]; total: number }> {
    const none = { docs: [], total: 0 };
    try {
      const operationId = operationIdOf(scopedId);
      const stored = await this.#runner.storage.getOperation(operationId);
      const seq = stored?.result.auditSeqs[0];
      if (seq === undefined) return none;
      const entry = (await this.#runner.storage.listAudit({ afterSeq: seq - 1, limit: 1 }))[0];
      const list = entry?.seq === seq && entry.operationId === operationId ? entry.detail["staled"] : undefined;
      if (entry === undefined || !Array.isArray(list)) return none;
      const docs: { id: string; projectId: string; title: string }[] = [];
      for (const d of list.slice(0, 20)) { const o = d as Record<string, unknown>; if (typeof o["id"] === "string" && typeof o["projectId"] === "string" && typeof o["title"] === "string") docs.push({ id: o["id"], projectId: o["projectId"], title: o["title"] }); }
      const recorded = entry.detail["staledTotal"];
      const total = typeof recorded === "number" && Number.isSafeInteger(recorded) && recorded > docs.length ? recorded : docs.length;
      // A document verified again, or retired, since the check is left out (a repeat long after must not call it stale), and the count drops by as many; those beyond the 20 kept are not re-read.
      const still: typeof docs = [];
      for (const d of docs) {
        const b = (await this.#runner.get("doc-obligation", d.id))?.body as unknown as DocObligationBody | undefined;
        if (b !== undefined && b.retired === undefined && b.state !== "verified") still.push(d);
      }
      return { docs: still, total: total - (docs.length - still.length) };
    } catch { return none; }
  }

  /** An update task some step of opening has not reached: not created, still proposed, or ready without an assignment. */
  async #unopened(taskId: string): Promise<boolean> {
    const t = await this.#task(taskId);
    if (t === undefined || t.state === "proposed") return true;
    return t.state === "ready" && (await this.#runner.get("assignment", assignmentIdOf(taskId))) === undefined;
  }

  #describe(id: string, b: DocObligationBody, r: DocReason): { title: string; description: string } {
    const why = r.kind === "release_changed" ? `Release ${r.to} is coming and this document applies to version ${r.from}.`
      : r.kind === "capability_changed" ? `Capability ${r.capabilityId}, which it claimed or named when verified, is now ${r.to} (it was ${r.from}): label it as such or take the claim out.`
      : r.kind === "evidence_lost" ? `The tested code it was checked against (submission ${r.submissionId} of task ${r.taskId}) no longer passes its QA gate.`
      : `The behaviour of task ${r.taskId} changed: its tested code is now submission ${r.submissionId} (tree ${r.tree})${r.from === undefined ? "" : `; the document was checked against tree ${r.from}`}.`;
    return {
      title: `Update ${b.audience} document: ${b.title}`.slice(0, 200),
      description: [
        `Bring the ${b.audience} document "${b.title}" (${b.location}) up to date. ${why}`,
        b.claims.length === 0 ? "" : `It claims: ${b.claims.map((c) => `"${c.text}" (task ${c.taskId})`).join("; ")}. Keep only claims the tested code supports.`,
        `Finish by submitting the document change in the docs role (submission.record, kind document) and verifying obligation ${id} (doc.obligation.verify) against code of ${b.implementationRefs.join(", ")} whose QA gate passes${r.kind === "release_changed" ? `, for version ${r.to}` : ""}.`,
      ].filter((x) => x !== "").join("\n").slice(0, 3000),
    };
  }

  async #open(by: Principal, m: { obligationId: string; taskId: string; create: string; projectId: string; title: string; description: string; owner: string }): Promise<boolean> {
    const step = async (finished: () => Promise<boolean>, run: () => Promise<unknown>): Promise<void> => {
      if (await finished()) return;
      try { await run(); } catch (error) { if (!(error instanceof DomainError) || !(await finished())) throw error; }
    };
    const commandBase = `doc-update:${m.taskId}`;
    // A document retired after the flag was written: its update task is not opened (one not yet created is never created).
    if ((await this.#task(m.taskId)) === undefined && ((await this.#runner.get("doc-obligation", m.obligationId))?.body as unknown as DocObligationBody | undefined)?.retired !== undefined) return false;
    await step(async () => (await this.#task(m.taskId)) !== undefined, () => this.#ports.projects.createTask({ commandId: m.create, actor: by.id, projectId: m.projectId, title: m.title, description: m.description }));
    // Read again after the task exists (first review): a retirement that committed after the read above found no task to cancel, so the task just created is cancelled here instead. The retirement
    // writes the record before it reads the tasks and this reads the record after writing the task, so one of the two always sees the other.
    if (((await this.#runner.get("doc-obligation", m.obligationId))?.body as unknown as DocObligationBody | undefined)?.retired !== undefined) {
      const found = await this.#runner.get("task", m.taskId);
      const state = (found?.body as unknown as TaskBody | undefined)?.state;
      if (found !== undefined && (state === "proposed" || state === "ready" || state === "blocked")) {
        try { await this.#ports.projects.transitionTask({ commandId: `doc-retire:${m.taskId}:cancel:${found.revision}`, actor: by.id, taskId: m.taskId, expectedRevision: found.revision, to: "cancelled" }); } catch (error) { if (!(error instanceof DomainError)) throw error; }
      }
      return false;
    }
    await step(async () => (await this.#task(m.taskId))?.state !== "proposed", async () => this.#ports.projects.transitionTask({ commandId: `${commandBase}:ready`, actor: by.id, taskId: m.taskId, expectedRevision: (await this.#runner.get("task", m.taskId))!.revision, to: "ready" }));
    try {
      await step(async () => (await this.#runner.get("assignment", assignmentIdOf(m.taskId))) !== undefined, () => this.#ports.assignments.assignTask({ commandId: `${commandBase}:assign`, actor: by.id, taskId: m.taskId, owner: { kind: "agent", id: bare(m.owner) }, reason: "document update" }));
      return true;
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  }

  // ---- reading --------------------------------------------------------------------------------------------------------------

  /** The documentation obligations of a project in the order recorded, each with whether its update tasks are assigned. Anyone who may read the project's tasks. */
  async list(by: Principal, projectIdValue: string): Promise<{ projectId: string; items: (DocObligationBody & { id: string; revision: number; flagged: boolean })[] }> {
    const projectId = await this.#project(by, projectIdValue);
    const items: (DocObligationBody & { id: string; revision: number; flagged: boolean })[] = [];
    for (const id of (await this.#index(projectId)).body.ids) {
      const found = await this.#runner.get("doc-obligation", id);
      const b = found?.body as unknown as DocObligationBody | undefined;
      if (found !== undefined && b !== undefined) items.push({ ...b, id, revision: found.revision, flagged: b.state !== "verified" });
    }
    return { projectId, items };
  }

  /** One documentation obligation. Hidden as not found where the caller may not read the project's tasks. */
  async get(by: Principal, id: string): Promise<JsonObject | undefined> {
    if (typeof id !== "string" || !DOB.test(id)) bad("id", "is not a documentation obligation ID");
    const found = await this.#runner.get("doc-obligation", id);
    const b = found?.body as unknown as DocObligationBody | undefined;
    if (found === undefined || b === undefined || !this.#reads(by, b.projectId)) return undefined;
    return json({ ...b, id, revision: found.revision, flagged: b.state !== "verified" });
  }
}

/** Why a document needs an update, in plain words (the owner reads it). */
export function docReasonText(r: DocReason): string {
  switch (r.kind) {
    case "behavior_changed": return `task ${r.taskId} has new tested code (submission ${r.submissionId}, tree ${r.tree.slice(0, 12)})${r.from === undefined ? "" : ` since the document was checked against tree ${r.from.slice(0, 12)}`}`;
    case "evidence_lost": return `the tested code it was checked against (${r.submissionId} of task ${r.taskId}) no longer passes its QA gate`;
    case "release_changed": return `release ${r.to} replaces version ${r.from}`;
    case "capability_changed": return `capability ${r.capabilityId} is now ${r.to} (it was ${r.from} when the document was verified)`;
  }
}

/**
 * The code a flagged document would be verified against (card Q03b), per task it describes: the newest code it was flagged for (a behaviour change), else the code it was last verified with unless that
 * code lost its QA gate since. A task with neither is left out: the code comes from the qa view. Only a suggestion for the views and the chat; `verify` checks the QA gate itself.
 */
export function docVerifyCode(b: Pick<DocObligationBody, "implementationRefs" | "reasons" | "verification">): Record<string, string> {
  const out: Record<string, string> = {};
  const lost = new Set<string>();
  for (const r of b.reasons ?? []) { if (r.kind === "behavior_changed") out[r.taskId] = r.submissionId; else if (r.kind === "evidence_lost") lost.add(r.submissionId); }
  for (const e of b.verification?.evidence ?? []) if (out[e.taskId] === undefined && !lost.has(e.submissionId)) out[e.taskId] = e.submissionId;
  for (const t of Object.keys(out)) if (!b.implementationRefs.includes(t)) delete out[t];
  return out;
}

/**
 * The documents gate as the landing gate reads it (card P09, the `docs` required check): read as the controller at the owner's level; the landing gate itself checks the task, the submission and the tree. One function,
 * used by `start.ts` and by the tests, so the controller's composition is the one tested.
 */
export function landingDocsGate(service: DocObligationService): (taskId: string, submissionId: string) => ReturnType<DocObligationService["landing"]> {
  return async (taskId, submissionId) => service.landing(DOC_AUTO_PRINCIPAL, { taskId, submissionId });
}

/** Cut to at most `n` units on whole characters: a cut through a character written as two UTF-16 units would leave half of it, which the notice's text check refuses. */
function wholeCut(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n).replace(/[\uD800-\uDBFF]$/, "");
}

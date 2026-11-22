import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { commandId as checkCommandId, taskId as checkTaskId, text } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Aggregate, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { DeliverableBody, EventBody, VersionBody } from "./acceptance.js";
import type { RolesOf } from "./submissions.js";

/** How bad a defect is (card Q04). Descriptive: nothing is gated on it here. */
export const DEFECT_SEVERITIES = ["critical", "major", "minor"] as const;
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];
/**
 * `open`: found, waiting for a repair. `repair-submitted`: the responsible agent named a newer version that repairs it, waiting for a check. `resolved`: a check found it fixed. `escalated`: the repair and review
 * cycles reached the configured limit, so the owner decides. `overridden`: the owner accepted the work with the finding remaining (the failed checks stay failed).
 */
export const DEFECT_STATES = ["open", "repair-submitted", "resolved", "escalated", "overridden"] as const;
export type DefectState = (typeof DEFECT_STATES)[number];
/** The owner's two answers to a defect: accept the work as it is with the finding remaining, or let the repair go on once more (the cycle count is kept, never reset). */
export const OVERRIDE_OUTCOMES = ["accept-as-is", "repair-again"] as const;
export type OverrideOutcome = (typeof OVERRIDE_OUTCOMES)[number];

/** Versions that were rejected or replaced: a repair in one of them cannot be found fixed. */
const DEAD_VERSION: ReadonlySet<string> = new Set(["rejected", "superseded"]);

/** The setting that bounds the repair and review cycles of one defect (card Q04): after this many failed checks of a repair, the defect escalates to the owner. */
export const DEFECT_CYCLE_SETTING = "review.repairCycles";
export const DEFECT_CYCLE_DEFAULT = 3;

export interface Finding {
  /** What was found, in the reporter's words (redacted). */
  readonly text: string;
  /** The deliverable event it came from (a rejection, say), when there is one: it names an event of the same deliverable and version. */
  readonly eventSeq?: number;
}

export interface DefectBody {
  readonly projectId: string;
  readonly taskId: string;
  readonly deliverableId: string;
  /** The version the defect was found in. */
  readonly version: number;
  readonly finding: Finding;
  readonly severity: DefectSeverity;
  readonly evidence: readonly string[];
  /** The deliverable's responsible agent when the defect was reported: the one who repairs it. */
  readonly responsibleAgent: string;
  readonly reportedBy: string;
  readonly reportedAt: string;
  readonly state: DefectState;
  /** Failed checks of a repair so far (one repair and review cycle each). Never reset, not even by an owner's `repair-again`. */
  readonly cycles: number;
  /** The version a repair was last submitted in (each repair names a newer version than the last). */
  readonly repairVersion?: number;
  readonly repairedBy?: string;
  /** Set when the waiting repair took the place of one whose version was rejected or replaced (the earlier repair version); cleared by the next check or repair from open. A `fixed` check must then name the version it judged. */
  readonly replacedRepair?: number;
  /** The number of checks recorded; check `n` is the record `<id>.<n>` of kind `defect-check`. */
  readonly checkSeq: number;
  /** The owner's decisions on it, oldest first (`defect-override` records). */
  readonly overrides: readonly string[];
  readonly resolution?: { readonly kind: "fixed" | "accepted-as-is"; readonly by: string; readonly at: string; readonly ref: string };
}

/** One check of a repair. Immutable: a failed check is never rewritten, whatever the owner decides later. */
export interface DefectCheckBody {
  readonly defectId: string;
  readonly seq: number;
  readonly version: number;
  readonly verdict: "fixed" | "not-fixed";
  readonly reason?: string;
  readonly by: string;
  readonly at: string;
  /** The cycle count after this check and the limit in force when it was made. */
  readonly cycles: number;
  readonly limit: number;
  readonly escalated: boolean;
  /** The defect's revision this check produced (a repeat of the command is answered from it). */
  readonly defectRevision: number;
}

/** One owner decision on a defect: what was decided, why, and every finding of the deliverable that was still unresolved at that moment. */
export interface DefectOverrideBody {
  readonly defectId: string;
  readonly deliverableId: string;
  readonly version: number;
  readonly outcome: OverrideOutcome;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
  /** The defect's state, cycle count and latest check verdict when the owner decided; recorded, never changed by the decision. */
  readonly before: { readonly state: DefectState; readonly cycles: number; readonly lastVerdict?: "fixed" | "not-fixed" };
  readonly remaining: readonly { readonly defectId: string; readonly severity: DefectSeverity; readonly state: DefectState; readonly cycles: number; readonly finding: string; readonly lastVerdict?: "fixed" | "not-fixed" }[];
}

export interface DefectPorts {
  readonly rolesOf: RolesOf;
  /** Whether the principal may read the deliverable (the acceptance service's own read rule). */
  readonly mayReadDeliverable: (by: Principal, deliverableId: string) => Promise<boolean>;
  /** The repair and review cycle limit in force for the project (the `review.repairCycles` setting). */
  readonly cycleLimit: (projectId: string) => Promise<number>;
  /** Tells the owner a defect escalated to them. Best effort: a failure never undoes the escalation, which is on the record. */
  readonly notify?: (notice: { readonly commandId: string; readonly defectId: string; readonly projectId: string; readonly text: string }) => Promise<void>;
}

const ID = /^dft-[a-z2-7]{20}$/;
const DLV = /^dlv-[a-z2-7]{20}$/;
const MAX_PER_DELIVERABLE = 100;
const MAX_EVIDENCE = 10;
const MAX_FINDING = 2000;
const MAX_REASON = 2000;
const UNRESOLVED_PAGE = 500;
const UNRESOLVED_PAGES = 20;
const CHECKERS = ["reviewer", "qa", "director"] as const;

const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const hidden = (what = "defect"): never => { throw new DomainError("not_found", `no such ${what}`); };
const object = (command: unknown, known: readonly string[]): void => {
  if (command === null || typeof command !== "object" || Array.isArray(command)) throw new DomainError("invalid_command", "a command is an object");
  for (const k of Object.keys(command)) if (!known.includes(k)) bad(k, "is not a field of this command");
};
const escalationText = (id: string, severity: DefectSeverity, deliverableId: string, cycles: number, limit: number): string =>
  `Defect ${id} (${severity}) in deliverable ${deliverableId} failed ${cycles} repair check(s), the limit of ${limit}: it waits for your decision (accept as is, or repair again).`;
const revisionOf = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) bad("expectedRevision", "must be the revision you read");
  return value as number;
};

/**
 * Defects, their repair and review cycles and the owner's overrides (card Q04). A defect is a finding against one version of a deliverable (card Q01), with its severity, evidence and the responsible agent who
 * repairs it. A repair names a newer submitted version; a check of the repair by someone who did none of its work either resolves the defect or counts one repair and review cycle. When the cycles reach the
 * configured limit (`review.repairCycles`, per project) the defect escalates to the owner, who decides: accept the work as it is, or let the repair go on once more. A decision is its own record that names the
 * findings still unresolved; it never changes a check, so a failed check stays failed, and the cycle count is never reset.
 *
 * Who checks: the owner, or an agent that may read the deliverable, holds the reviewer, qa or director role in the project and did none of the work of the version it judges (a QA agent that made the repair is
 * one of its contributors and cannot pass it). Who repairs: the responsible agent or the owner. Who overrides: the owner only.
 */
export class DefectService {
  readonly #runner: CommandRunner;
  readonly #ports: DefectPorts;
  private constructor(runner: CommandRunner, ports: DefectPorts) { this.#runner = runner; this.#ports = ports; }

  static withEpoch(storage: ControllerStorage, epoch: number, ports: DefectPorts, options: RunnerOptions = {}): DefectService {
    return new DefectService(new CommandRunner(storage, epoch, options), ports);
  }

  // ---- reading records -------------------------------------------------------------------------------------------------------

  async #deliverable(by: Principal, id: unknown): Promise<{ agg: Aggregate; body: DeliverableBody }> {
    if (typeof id !== "string" || !DLV.test(id)) bad("deliverableId", "is not a deliverable ID");
    const agg = await this.#runner.get("deliverable", id as string);
    if (agg === undefined || !(await this.#readable(by, agg.body as unknown as DeliverableBody, id as string))) return hidden("deliverable");
    return { agg: agg!, body: agg!.body as unknown as DeliverableBody };
  }

  async #readable(by: Principal, d: DeliverableBody, deliverableId: string): Promise<boolean> {
    if (by.kind === "owner") return true;
    if (by.kind !== "agent") return false;
    if (by.taskScope !== undefined && (!inTaskScope(by, d.projectId) || by.taskScope.taskId !== d.taskId)) return false;
    return this.#ports.mayReadDeliverable(by, deliverableId);
  }

  async #version(deliverableId: string, n: number): Promise<VersionBody> {
    const v = await this.#runner.get("deliverable-version", `${deliverableId}.${n}`);
    if (v === undefined) throw new DomainError("integrity", `the record of version ${n} of ${deliverableId} is missing`);
    return v.body as unknown as VersionBody;
  }

  async #load(by: Principal, id: unknown): Promise<{ agg: Aggregate; body: DefectBody }> {
    if (typeof id !== "string" || !ID.test(id)) bad("id", "is not a defect ID");
    const agg = await this.#runner.get("defect", id as string);
    if (agg === undefined) return hidden();
    const body = agg.body as unknown as DefectBody;
    const d = (await this.#runner.get("deliverable", body.deliverableId))?.body as unknown as DeliverableBody | undefined;
    if (d === undefined || !(await this.#readable(by, d, body.deliverableId))) return hidden();
    return { agg, body };
  }

  /** The principals that did the work of a version: they may not judge it. */
  #contributors(d: DeliverableBody, v: VersionBody): Set<string> {
    return new Set([d.responsibleAgent, d.createdBy, v.createdBy, ...(v.submittedBy === undefined ? [] : [v.submittedBy]), ...v.content.submissions.map((s) => s.submittedBy)]);
  }

  /** The owner, or an agent with a checking role in the project that did none of the work of `v`. */
  async #checker(by: Principal, d: DeliverableBody, v: VersionBody, what: string): Promise<void> {
    if (by.kind === "owner") return;
    if (by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not ${what}`);
    if (this.#contributors(d, v).has(by.id)) throw new DomainError("forbidden", `an agent that did the work of version ${v.version} may not ${what} (it is one of its contributors)`);
    const roles = await this.#ports.rolesOf(by.id, { projectId: d.projectId, taskId: d.taskId }, by);
    if (!CHECKERS.some((r) => roles.includes(r))) throw new DomainError("forbidden", `only the owner or an agent holding the ${CHECKERS.join(", ")} role may ${what}`);
  }

  async #limit(projectId: string): Promise<number> {
    const n = await this.#ports.cycleLimit(projectId);
    return Number.isSafeInteger(n) && n >= 1 ? n : DEFECT_CYCLE_DEFAULT;
  }

  // ---- commands --------------------------------------------------------------------------------------------------------------

  /** Records a defect found in a submitted version of a deliverable (not a draft). The owner, or a reviewer, qa or director agent that did none of that version's work. */
  async report(by: Principal, command: NoActor & { deliverableId: string; version: number; finding: string; findingEvent?: number; severity: string; evidence?: readonly string[] }): Promise<{ id: string; revision: number; replayed: boolean }> {
    object(command, ["commandId", "deliverableId", "version", "finding", "findingEvent", "severity", "evidence"]);
    const commandId = checkCommandId(command.commandId);
    if (typeof command.deliverableId !== "string" || !DLV.test(command.deliverableId)) bad("deliverableId", "is not a deliverable ID");
    if (!Number.isSafeInteger(command.version) || command.version < 1) bad("version", "must be the version the defect was found in");
    const finding = text(command.finding, "finding", { min: 1, max: MAX_FINDING, multiline: true });
    if (command.findingEvent !== undefined && (!Number.isSafeInteger(command.findingEvent) || command.findingEvent < 1)) bad("findingEvent", "must be the number of an event of the deliverable");
    if (!(DEFECT_SEVERITIES as readonly string[]).includes(command.severity)) bad("severity", `must be one of ${DEFECT_SEVERITIES.join(", ")}`);
    const evidence = command.evidence === undefined ? [] : command.evidence;
    if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) bad("evidence", `must be a list of at most ${MAX_EVIDENCE} references`);
    const refs = (evidence as unknown[]).map((e, i) => text(e, `evidence.${i}`, { min: 1, max: 300 }));
    const scoped = scopedCommandId(by.id, commandId);
    const id = derivedId("dft", scoped);
    const result = await this.#runner.command("defect.report", { commandId: scoped, actor: by.id }, async () => ({
      payload: { deliverableId: command.deliverableId, version: command.version, finding, findingEvent: command.findingEvent ?? null, severity: command.severity, evidence: refs },
      build: async () => {
        const { agg: dAgg, body: d } = await this.#deliverable(by, command.deliverableId);
        if (command.version > d.currentVersion) bad("version", `the deliverable has versions 1 to ${d.currentVersion}`);
        const v = await this.#version(command.deliverableId, command.version);
        if (v.state === "draft") throw new DomainError("invalid_transition", `version ${v.version} is a draft: a defect is found in submitted work`);
        await this.#checker(by, d, v, "report a defect in it");
        if (command.findingEvent !== undefined) {
          const e = (await this.#runner.get("deliverable-event", `${command.deliverableId}.${command.findingEvent}`))?.body as unknown as EventBody | undefined;
          if (e === undefined || e.version !== command.version) bad("findingEvent", `is not an event of version ${command.version} of this deliverable`);
        }
        const index = await this.#runner.get("defect-index", command.deliverableId);
        const ids = ((index?.body as unknown as { ids: string[] } | undefined)?.ids) ?? [];
        if (ids.length >= MAX_PER_DELIVERABLE) throw new DomainError("invalid_command", `a deliverable has at most ${MAX_PER_DELIVERABLE} defects`);
        const body: DefectBody = {
          projectId: d.projectId, taskId: d.taskId, deliverableId: command.deliverableId, version: command.version,
          finding: { text: redactText(finding), ...(command.findingEvent === undefined ? {} : { eventSeq: command.findingEvent }) },
          severity: command.severity as DefectSeverity, evidence: refs.map((r) => redactText(r)), responsibleAgent: d.responsibleAgent,
          reportedBy: by.id, reportedAt: this.#runner.now(), state: "open", cycles: 0, checkSeq: 0, overrides: [],
        };
        const ref = { kind: "defect", id };
        const idxRef = { kind: "defect-index", id: command.deliverableId };
        const idxBody = { ids: [...ids, id] } as unknown as JsonObject;
        return { ref, creates: true, changes: [
          { type: "create", ref, body: body as unknown as JsonObject },
          { type: "check", ref: { kind: "deliverable", id: command.deliverableId }, expectedRevision: dAgg.revision },
          index === undefined ? { type: "create", ref: idxRef, body: idxBody } : { type: "update", ref: idxRef, expectedRevision: index.revision, body: idxBody },
        ], detail: { deliverable: command.deliverableId, version: command.version, severity: command.severity } };
      },
    }));
    return { id: result.id, revision: result.revision, replayed: result.replayed };
  }

  /** The responsible agent (or the owner) names the newer version that repairs an open defect. The version must be submitted (or under review or accepted), newer than the defect's and than any earlier repair. */
  async repair(by: Principal, command: NoActor & { id: string; version: number; expectedRevision?: number }): Promise<{ id: string; revision: number; replayed: boolean }> {
    object(command, ["commandId", "id", "version", "expectedRevision"]);
    const commandId = checkCommandId(command.commandId);
    if (typeof command.id !== "string" || !ID.test(command.id)) bad("id", "is not a defect ID");
    if (!Number.isSafeInteger(command.version) || command.version < 1) bad("version", "must be the version that repairs the defect");
    const expected = revisionOf(command.expectedRevision);
    const result = await this.#runner.command("defect.repair", { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { id: command.id, version: command.version, expectedRevision: expected ?? null },
      build: async () => {
        const { agg, body } = await this.#load(by, command.id);
        if (by.kind !== "owner" && !(by.kind === "agent" && by.id === body.responsibleAgent)) throw new DomainError("forbidden", "only the responsible agent or the owner may submit a repair");
        if (expected !== undefined && agg.revision !== expected) throw new DomainError("stale_revision", `the defect is at revision ${agg.revision}, not ${expected}`, { currentRevision: agg.revision });
        // A repair whose version was rejected or replaced can no longer be checked as fixed: the responsible agent names a newer one in its place (no cycle is counted, nothing was checked).
        const stuck = body.state === "repair-submitted" && body.repairVersion !== undefined && DEAD_VERSION.has((await this.#version(body.deliverableId, body.repairVersion)).state);
        if (body.state !== "open" && !stuck) throw new DomainError("invalid_transition", body.state === "escalated" ? "the defect escalated to the owner, who decides whether the repair goes on" : `the defect is ${body.state}, not open`);
        const floor = Math.max(body.version, body.repairVersion ?? 0);
        if (command.version <= floor) bad("version", `a repair names a version newer than ${floor}`);
        const dAgg = await this.#runner.get("deliverable", body.deliverableId);
        const d = dAgg?.body as unknown as DeliverableBody | undefined;
        if (dAgg === undefined || d === undefined || command.version > d.currentVersion) bad("version", `the deliverable has no version ${command.version}`);
        const v = await this.#version(body.deliverableId, command.version);
        if (v.state !== "submitted" && v.state !== "under-review" && v.state !== "accepted") throw new DomainError("invalid_transition", `version ${command.version} is ${v.state}: a repair is a submitted version`);
        const { replacedRepair: _was, ...rest } = body;
        const next: DefectBody = { ...rest, state: "repair-submitted", repairVersion: command.version, repairedBy: by.id, ...(stuck ? { replacedRepair: body.repairVersion! } : {}) };
        const ref = { kind: "defect", id: command.id };
        return { ref, creates: false, changes: [
          { type: "update", ref, expectedRevision: agg.revision, body: next as unknown as JsonObject },
          { type: "check", ref: { kind: "deliverable-version", id: `${body.deliverableId}.${command.version}` }, expectedRevision: (await this.#runner.get("deliverable-version", `${body.deliverableId}.${command.version}`))!.revision },
        ], detail: { defect: command.id, version: command.version } };
      },
    }));
    return { id: result.id, revision: result.revision, replayed: result.replayed };
  }

  /**
   * Checks the submitted repair: `fixed` resolves the defect; `not-fixed` (with the reason) counts one repair and review cycle and sends the defect back to `open`, or, when the cycles reach the limit in force,
   * escalates it to the owner. The check is its own immutable record. The owner, or a reviewer, qa or director agent that did none of the repair version's work.
   */
  async review(by: Principal, command: NoActor & { id: string; verdict: string; reason?: string; version?: number; expectedRevision?: number }): Promise<{ id: string; revision: number; replayed: boolean; state: DefectState; cycles: number; limit: number }> {
    object(command, ["commandId", "id", "verdict", "reason", "version", "expectedRevision"]);
    const commandId = checkCommandId(command.commandId);
    if (typeof command.id !== "string" || !ID.test(command.id)) bad("id", "is not a defect ID");
    if (command.verdict !== "fixed" && command.verdict !== "not-fixed") bad("verdict", "must be fixed or not-fixed");
    const reason = command.reason === undefined ? undefined : text(command.reason, "reason", { min: 1, max: MAX_REASON, multiline: true });
    if (command.verdict === "not-fixed" && reason === undefined) bad("reason", "say what is still wrong");
    if (command.version !== undefined && (!Number.isSafeInteger(command.version) || command.version < 1)) bad("version", "must be the repair version that was checked");
    const judged = command.version;
    const expected = revisionOf(command.expectedRevision);
    const scoped = scopedCommandId(by.id, commandId);
    let escalation: { projectId: string; text: string } | undefined;
    let outcome: { state: DefectState; cycles: number; limit: number } | undefined;
    const result = await this.#runner.command("defect.review", { commandId: scoped, actor: by.id }, async () => ({
      payload: { id: command.id, verdict: command.verdict, reason: reason ?? null, expectedRevision: expected ?? null, ...(judged === undefined ? {} : { version: judged }) },
      build: async () => {
        escalation = undefined;
        outcome = undefined;
        const { agg, body } = await this.#load(by, command.id);
        if (expected !== undefined && agg.revision !== expected) throw new DomainError("stale_revision", `the defect is at revision ${agg.revision}, not ${expected}`, { currentRevision: agg.revision });
        if (body.state !== "repair-submitted" || body.repairVersion === undefined) throw new DomainError("invalid_transition", `the defect is ${body.state}: only a submitted repair is checked`);
        const d = (await this.#runner.get("deliverable", body.deliverableId))!.body as unknown as DeliverableBody;
        const vAgg = await this.#runner.get("deliverable-version", `${body.deliverableId}.${body.repairVersion}`);
        if (vAgg === undefined) throw new DomainError("integrity", `the record of version ${body.repairVersion} of ${body.deliverableId} is missing`);
        await this.#checker(by, d, vAgg.body as unknown as VersionBody, "check this repair");
        // The check applies to the repair it judged: a named version that is no longer the repair is refused, and (below) once a repair was replaced a `fixed` check must name what it judged.
        if (judged !== undefined && judged !== body.repairVersion) throw new DomainError("stale_revision", `the repair is now version ${body.repairVersion}, not ${judged}`, { currentRevision: agg.revision });
        // A version that was rejected or replaced by a newer one is not found fixed (the newer version is the repair to check); it may still be found not fixed.
        if (command.verdict === "fixed" && DEAD_VERSION.has((vAgg.body as unknown as VersionBody).state)) throw new DomainError("invalid_transition", `the repair, version ${body.repairVersion}, is ${(vAgg.body as unknown as VersionBody).state}: it cannot be found fixed; the responsible agent names a newer version as the repair`);
        if (command.verdict === "fixed" && judged === undefined && expected === undefined && body.replacedRepair !== undefined) bad("version", `the repair, version ${body.replacedRepair}, was replaced by version ${body.repairVersion}: name the version you checked (or expectedRevision)`);
        const limit = await this.#limit(body.projectId);
        const at = this.#runner.now();
        const fixed = command.verdict === "fixed";
        const cycles = fixed ? body.cycles : body.cycles + 1;
        const escalated = !fixed && cycles >= limit;
        const seq = body.checkSeq + 1;
        const check: DefectCheckBody = { defectId: command.id, seq, version: body.repairVersion, verdict: command.verdict as "fixed" | "not-fixed", ...(reason === undefined ? {} : { reason: redactText(reason) }), by: by.id, at, cycles, limit, escalated, defectRevision: agg.revision + 1 };
        const state: DefectState = fixed ? "resolved" : escalated ? "escalated" : "open";
        const { replacedRepair: _was, ...rest } = body;
        const next: DefectBody = { ...rest, state, cycles, checkSeq: seq, ...(fixed ? { resolution: { kind: "fixed" as const, by: by.id, at, ref: `${command.id}.${seq}` } } : {}) };
        outcome = { state, cycles, limit };
        if (escalated) escalation = { projectId: body.projectId, text: escalationText(command.id, body.severity, body.deliverableId, cycles, limit) };
        const ref = { kind: "defect", id: command.id };
        return { ref, creates: false, changes: [
          { type: "update", ref, expectedRevision: agg.revision, body: next as unknown as JsonObject },
          { type: "create", ref: { kind: "defect-check", id: `${command.id}.${seq}` }, body: check as unknown as JsonObject },
          { type: "check", ref: { kind: "deliverable-version", id: `${body.deliverableId}.${body.repairVersion}` }, expectedRevision: vAgg.revision },
        ], detail: { defect: command.id, verdict: command.verdict, cycles, limit, state } };
      },
    }));
    if (escalation !== undefined && !result.replayed && this.#ports.notify !== undefined) {
      await this.#ports.notify({ commandId: `defect-escalated:${command.id}:${result.revision}`, defectId: command.id, projectId: escalation.projectId, text: escalation.text }).catch(() => undefined);
    }
    if (!result.replayed && outcome !== undefined) return { id: result.id, revision: result.revision, replayed: false, ...outcome };
    // A repeat is answered from the check this command recorded (the one that produced the recorded revision).
    const now = (await this.#runner.get("defect", command.id))?.body as unknown as DefectBody | undefined;
    for (let seq = now?.checkSeq ?? 0; seq >= 1; seq--) {
      const c = (await this.#runner.get("defect-check", `${command.id}.${seq}`))?.body as unknown as DefectCheckBody | undefined;
      if (c !== undefined && c.defectRevision === result.revision) {
        // The notice of an escalation is sent again under the same command ID, which records it once: a controller stopped between the check and the notice still tells the owner when the command is repeated.
        // Only while that escalation still waits for the owner: once the owner decided (or anything came after this check), "it waits for your decision" would no longer be true.
        if (c.escalated && now !== undefined && now.state === "escalated" && now.checkSeq === c.seq && this.#ports.notify !== undefined) {
          await this.#ports.notify({ commandId: `defect-escalated:${command.id}:${result.revision}`, defectId: command.id, projectId: now.projectId, text: escalationText(command.id, now.severity, now.deliverableId, c.cycles, c.limit) }).catch(() => undefined);
        }
        return { id: result.id, revision: result.revision, replayed: true, state: c.verdict === "fixed" ? "resolved" : c.escalated ? "escalated" : "open", cycles: c.cycles, limit: c.limit };
      }
    }
    throw new DomainError("integrity", `the check recorded by this command on ${command.id} is missing`);
  }

  /**
   * The owner's decision on an unresolved defect (owner only): `accept-as-is` closes it as `overridden` with the finding remaining; `repair-again` sends it back to `open` with its cycle count kept, so the next
   * failed check escalates again. The decision is its own record naming the reason and every finding of the deliverable still unresolved; no check is changed, so a failed check is never shown as passed.
   */
  async override(by: Principal, command: NoActor & { id: string; outcome: string; reason: string; expectedRevision?: number }): Promise<{ id: string; overrideId: string; revision: number; replayed: boolean }> {
    object(command, ["commandId", "id", "outcome", "reason", "expectedRevision"]);
    const commandId = checkCommandId(command.commandId);
    if (typeof command.id !== "string" || !ID.test(command.id)) bad("id", "is not a defect ID");
    if (!(OVERRIDE_OUTCOMES as readonly string[]).includes(command.outcome)) bad("outcome", `must be one of ${OVERRIDE_OUTCOMES.join(", ")}`);
    const reason = text(command.reason, "reason", { min: 1, max: MAX_REASON, multiline: true });
    const expected = revisionOf(command.expectedRevision);
    if (by.kind !== "owner") throw new DomainError("forbidden", "only the owner overrides a defect");
    const scoped = scopedCommandId(by.id, commandId);
    const overrideId = derivedId("dfo", scoped);
    const result = await this.#runner.command("defect.override", { commandId: scoped, actor: by.id }, async () => ({
      payload: { id: command.id, outcome: command.outcome, reason, expectedRevision: expected ?? null },
      build: async () => {
        const { agg, body } = await this.#load(by, command.id);
        if (expected !== undefined && agg.revision !== expected) throw new DomainError("stale_revision", `the defect is at revision ${agg.revision}, not ${expected}`, { currentRevision: agg.revision });
        if (body.state === "resolved" || body.state === "overridden") throw new DomainError("invalid_transition", `the defect is already ${body.state}`);
        if (command.outcome === "repair-again" && body.state === "open") throw new DomainError("invalid_transition", "the defect is open already: its repair goes on");
        // A submitted repair waits for its check: sending the defect back to `open` would drop that repair unchecked (the next repair must name a newer version).
        if (command.outcome === "repair-again" && body.state === "repair-submitted") throw new DomainError("invalid_transition", "the defect has a repair waiting for its check: its repair goes on");
        const lastVerdict = async (id: string, seq: number): Promise<"fixed" | "not-fixed" | undefined> => (seq === 0 ? undefined : ((await this.#runner.get("defect-check", `${id}.${seq}`))?.body as unknown as DefectCheckBody | undefined)?.verdict);
        const index = await this.#runner.get("defect-index", body.deliverableId);
        const ids = ((index?.body as unknown as { ids: string[] } | undefined)?.ids) ?? [];
        const remaining: DefectOverrideBody["remaining"][number][] = [];
        const checks: Change[] = [];
        for (const other of ids) {
          const o = other === command.id ? agg : await this.#runner.get("defect", other);
          if (o === undefined) continue;
          const ob = o.body as unknown as DefectBody;
          if (ob.state === "resolved" || ob.state === "overridden") continue;
          const lv = await lastVerdict(other, ob.checkSeq);
          remaining.push({ defectId: other, severity: ob.severity, state: ob.state, cycles: ob.cycles, finding: ob.finding.text.slice(0, 300), ...(lv === undefined ? {} : { lastVerdict: lv }) });
          // The list is what stood when the owner decided: another defect changing meanwhile makes the decision retry on the new picture.
          if (other !== command.id) checks.push({ type: "check", ref: { kind: "defect", id: other }, expectedRevision: o.revision });
        }
        const lv = await lastVerdict(command.id, body.checkSeq);
        const at = this.#runner.now();
        const record: DefectOverrideBody = {
          defectId: command.id, deliverableId: body.deliverableId, version: body.version, outcome: command.outcome as OverrideOutcome, reason: redactText(reason), by: by.id, at,
          before: { state: body.state, cycles: body.cycles, ...(lv === undefined ? {} : { lastVerdict: lv }) }, remaining,
        };
        const next: DefectBody = command.outcome === "accept-as-is"
          ? { ...body, state: "overridden", overrides: [...body.overrides, overrideId], resolution: { kind: "accepted-as-is", by: by.id, at, ref: overrideId } }
          : { ...body, state: "open", overrides: [...body.overrides, overrideId] };
        const ref = { kind: "defect", id: command.id };
        return { ref, creates: false, changes: [
          { type: "update", ref, expectedRevision: agg.revision, body: next as unknown as JsonObject },
          { type: "create", ref: { kind: "defect-override", id: overrideId }, body: record as unknown as JsonObject },
          ...checks,
        ], detail: { defect: command.id, outcome: command.outcome, override: overrideId } };
      },
    }));
    return { id: result.id, overrideId, revision: result.revision, replayed: result.replayed };
  }

  // ---- queries ---------------------------------------------------------------------------------------------------------------

  /** One defect with its checks (oldest first) and the owner's decisions on it. Hidden as not found where the caller may not read the deliverable. */
  async get(by: Principal, id: string): Promise<JsonObject | undefined> {
    let loaded: { agg: Aggregate; body: DefectBody };
    try { loaded = await this.#load(by, id); } catch (error) { if (error instanceof DomainError && error.code === "not_found") return undefined; throw error; }
    const checks: DefectCheckBody[] = [];
    for (let seq = 1; seq <= loaded.body.checkSeq; seq++) {
      const c = await this.#runner.get("defect-check", `${id}.${seq}`);
      if (c === undefined) throw new DomainError("integrity", `check ${seq} of ${id} is missing`);
      checks.push(c.body as unknown as DefectCheckBody);
    }
    const overrides: (DefectOverrideBody & { id: string })[] = [];
    for (const o of loaded.body.overrides) {
      const r = await this.#runner.get("defect-override", o);
      if (r === undefined) throw new DomainError("integrity", `override ${o} of ${id} is missing`);
      overrides.push({ id: o, ...(r.body as unknown as DefectOverrideBody) });
    }
    const limit = await this.#limit(loaded.body.projectId);
    return JSON.parse(JSON.stringify({ id, revision: loaded.agg.revision, ...loaded.body, limit, checks, overrideRecords: overrides })) as JsonObject;
  }

  /** The defects of a deliverable the caller may read, in the order they were reported. */
  async list(by: Principal, deliverableId: string): Promise<{ items: JsonObject[] }> {
    const { body: d } = await this.#deliverable(by, deliverableId);
    const ids = ((await this.#runner.get("defect-index", deliverableId))?.body as unknown as { ids: string[] } | undefined)?.ids ?? [];
    const limit = await this.#limit(d.projectId);
    const items: JsonObject[] = [];
    for (const id of ids) {
      const agg = await this.#runner.get("defect", id);
      if (agg === undefined) continue;
      items.push(JSON.parse(JSON.stringify({ id, revision: agg.revision, ...(agg.body as unknown as DefectBody), limit })) as JsonObject);
    }
    return { items };
  }

  /**
   * For the chat's `defects` status: the task's deliverables the caller may read, each with its newest version and state, and their defects (state, severity, cycles against the limit, the finding, the latest check of a repair).
   * `undefined` when the task is missing or the caller may read none of it. At most 100 deliverables and 100 defects each (the per-task and per-deliverable caps).
   */
  async forTask(by: Principal, taskIdValue: string): Promise<{ readonly title: string; readonly limit: number; readonly deliverables: readonly { readonly id: string; readonly title: string; readonly version: number; readonly state: string; readonly defects: readonly (DefectBody & { readonly id: string; readonly lastCheck?: DefectCheckBody })[] }[] } | undefined> {
    const taskId = checkTaskId(taskIdValue);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as { projectId: string; title: string } | undefined;
    if (task === undefined || (by.kind !== "owner" && by.kind !== "agent")) return undefined;
    const ids = ((await this.#runner.get("deliverable-index", taskId))?.body as unknown as { ids: string[] } | undefined)?.ids ?? [];
    const deliverables = [];
    for (const id of ids) {
      const agg = await this.#runner.get("deliverable", id);
      if (agg === undefined) continue;
      const d = agg.body as unknown as DeliverableBody;
      if (!(await this.#readable(by, d, id))) continue;
      const dids = ((await this.#runner.get("defect-index", id))?.body as unknown as { ids: string[] } | undefined)?.ids ?? [];
      const defects: (DefectBody & { id: string; lastCheck?: DefectCheckBody })[] = [];
      for (const x of dids) {
        const f = await this.#runner.get("defect", x);
        if (f === undefined) continue;
        const b = f.body as unknown as DefectBody;
        const last = b.checkSeq === 0 ? undefined : (await this.#runner.get("defect-check", `${x}.${b.checkSeq}`))?.body as unknown as DefectCheckBody | undefined;
        defects.push({ id: x, ...b, ...(last === undefined ? {} : { lastCheck: last }) });
      }
      deliverables.push({ id, title: d.title, version: d.currentVersion, state: d.state, defects });
    }
    if (deliverables.length === 0 && by.kind !== "owner") return undefined;
    return { title: task.title, limit: await this.#limit(task.projectId), deliverables };
  }

  /**
   * The defects that are not finished (state `open`, `repair-submitted` or `escalated`), for the chat's `defect_risks` status and the Needs-you list (card Q04): across one project, or across every project for the
   * owner. Only defects whose deliverable the caller may read are counted; an agent must name a project it may read (`not_found` otherwise). Escalated first, then by severity, then the oldest. The scan reads the defect records a page at a time and is
   * bounded (`scanLimited` says it stopped early, so the answer may be missing defects); the items are cut at `cap` and the counts cover everything found.
   */
  async unresolved(by: Principal, query: { readonly projectId?: string; readonly cap?: number; readonly escalatedOnly?: boolean } = {}): Promise<{ readonly counts: { readonly escalated: number; readonly awaitingCheck: number; readonly open: number }; readonly items: readonly (DefectBody & { readonly id: string; readonly revision: number; readonly limit: number })[]; readonly scanLimited: boolean }> {
    if (by.kind !== "owner" && by.kind !== "agent") return { counts: { escalated: 0, awaitingCheck: 0, open: 0 }, items: [], scanLimited: false };
    if (by.kind === "agent" && query.projectId === undefined) bad("projectId", "is needed");
    // A project the agent may not read is not found, like in the other project views: the answer does not tell it the project exists. An agent that reads only some of its deliverables (a task.read grant for
    // one task, or a role for a deliverable shared with the project) still sees the defects it may read; it is told not_found only when it reads none there (as the deliverable list of a task does).
    const readsProject = by.kind !== "agent" || allows(by, "task.read", query.projectId);
    const cap = query.cap === undefined ? 50 : query.cap;
    const readable = new Map<string, boolean>();
    const limits = new Map<string, number>();
    const found: (DefectBody & { id: string; revision: number; limit: number })[] = [];
    let after: string | undefined;
    let scanLimited = true;
    for (let page = 0; page < UNRESOLVED_PAGES; page++) {
      const chunk = await this.#runner.list("defect", { ...(after === undefined ? {} : { afterId: after }), limit: UNRESOLVED_PAGE });
      for (const row of chunk) {
        after = row.id;
        const b = row.body as unknown as DefectBody;
        if (b.state === "resolved" || b.state === "overridden") continue;
        if (query.projectId !== undefined && b.projectId !== query.projectId) continue;
        if (query.escalatedOnly === true && b.state !== "escalated") continue;
        let ok = readable.get(b.deliverableId);
        if (ok === undefined) {
          const d = (await this.#runner.get("deliverable", b.deliverableId))?.body as unknown as DeliverableBody | undefined;
          ok = d !== undefined && (await this.#readable(by, d, b.deliverableId));
          readable.set(b.deliverableId, ok);
        }
        if (!ok) continue;
        let limit = limits.get(b.projectId);
        if (limit === undefined) { limit = await this.#limit(b.projectId); limits.set(b.projectId, limit); }
        found.push({ id: row.id, revision: row.revision, ...b, limit });
      }
      if (chunk.length < UNRESOLVED_PAGE) { scanLimited = false; break; }
    }
    if (!readsProject && found.length === 0) hidden("project");
    const rank =(x: DefectBody): number => (x.state === "escalated" ? 0 : 1);
    const sev = (x: DefectBody): number => DEFECT_SEVERITIES.indexOf(x.severity);
    found.sort((a, b) => rank(a) - rank(b) || sev(a) - sev(b) || (a.reportedAt < b.reportedAt ? -1 : a.reportedAt > b.reportedAt ? 1 : 0) || (a.id < b.id ? -1 : 1));
    const counts = { escalated: 0, awaitingCheck: 0, open: 0 };
    for (const x of found) { if (x.state === "escalated") counts.escalated++; else if (x.state === "repair-submitted") counts.awaitingCheck++; else counts.open++; }
    return { counts, items: found.slice(0, cap), scanLimited };
  }
}

import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { InspectionService } from "../context/inspection.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";

export type BoundaryKind = "turn-complete" | "timeout" | "manual" | "shutdown";
export interface ContinuationInput {
  readonly identity: string;
  /** The agent whose run this is (the one the scratch records belong to). An agent capturing for itself must name itself. */
  readonly agent: string;
  readonly boundary: { readonly kind: BoundaryKind; readonly turnInProgress?: boolean };
  /** The adapter's checkpoint record (a reference: it holds no conversation content) as the adapter returned it. */
  readonly checkpoint: { readonly conversationId: number; readonly at: number; readonly digest: string; readonly runtime: { readonly name: string; readonly version: string }; readonly format: number };
  /** The result of the durability check the host ran after writing the checkpoint. Anything but `verified: true` means the capture is not complete. */
  readonly durable: { readonly verified: boolean; readonly error?: string };
  readonly continuation: {
    readonly artifacts: readonly string[];
    readonly decisions: readonly string[];
    readonly pendingEffects: readonly { readonly effectId: string; readonly state: string }[];
    readonly budget: { readonly spent: number; readonly remaining: number; readonly unit: string };
    readonly nextStep: string;
  };
  readonly manifest: {
    readonly summaryLineage: readonly string[];
    readonly sourceRanges: readonly { readonly source: string; readonly from: number; readonly to: number }[];
    readonly compression: { readonly state: "none" | "compacted"; readonly compactions: number };
    readonly branches: readonly { readonly conversationId: number; readonly parent: number }[];
    readonly messageCursor: number;
    readonly routingRevision: number;
    readonly environmentRevision: number;
    readonly adapter: { readonly name: string; readonly version: string };
  };
  /** Tools that were exposed during the run and cannot be captured by a checkpoint (their effects are not reproduced on resume). */
  readonly nonCheckpointableTools: readonly { readonly name: string; readonly reason: string }[];
  readonly scratchRecords: readonly string[];
  /** Credentials the run uses, by name only. */
  readonly credentialRefs: readonly string[];
}
export interface ContinuationBody extends Omit<ContinuationInput, "durable"> {
  readonly taskId: string;
  readonly projectId: string;
  readonly seq: number;
  readonly status: "complete" | "incomplete";
  readonly problem?: string;
  readonly capturedBy: string;
  readonly capturedAt: string;
}
interface HeadBody { readonly identity: string; readonly next: number; readonly latestComplete: number; readonly latestCompleteId?: string; readonly projectId: string }
export interface ResumeBody { readonly taskId: string; readonly continuationId: string; readonly identity: string; readonly model: { readonly provider: string; readonly id: string }; readonly previousModel?: { readonly provider: string; readonly id: string }; readonly modelChanged: boolean; readonly after: "restart" | "model-change" | "continue"; readonly by: string; readonly at: string }

export const CONTINUATION_LIMITS = { items: 200, text: 2000, ranges: 200, tools: 50 } as const;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const NAME = /^(?!.*__)[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const REF = /^[a-z]{2,5}-[a-z2-7]{20}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/** Throws at the first string in the value that looks like a credential or key; the message names the place, not the text. */
function noSecrets(value: unknown, path: string, depth = 0): void {
  if (depth > 8) invalid(path, "is nested too deeply");
  if (typeof value === "string") { if (redactText(value) !== value) invalid(path, "looks like a credential or key; checkpoints hold credentials only as names"); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => noSecrets(v, `${path}[${i}]`, depth + 1)); return; }
  if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) { noSecrets(k, `${path}.${k}`, depth + 1); noSecrets(v, `${path}.${k}`, depth + 1); }
}
const count = (v: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : invalid(field, "must be a whole number from 0");
const text = (v: unknown, field: string, max: number = CONTINUATION_LIMITS.text): string => typeof v === "string" && v.length > 0 && v.length <= max ? v : invalid(field, `must be text of at most ${max} characters`);
const list = <T>(v: unknown, field: string, max: number, each: (x: unknown, f: string) => T): T[] => Array.isArray(v) && v.length <= max ? v.map((x, i) => each(x, `${field}[${i}]`)) : invalid(field, `must be a list of at most ${max}`);
const obj = (v: unknown, field: string): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : invalid(field, "must be an object");

/**
 * Safe-boundary continuation capture (card C04). When a run reaches a safe boundary, times out or is stopped, the host hands the controller what is needed to continue it: the adapter's checkpoint
 * reference, the artifacts and decisions made, pending effects, budget and the next step, a manifest (summary lineage, source ranges, compression state, branches, message cursor, routing and
 * environment revisions, adapter metadata), the tools that were exposed that a checkpoint cannot reproduce, and credentials by name only. A capture is *complete* only when the host's durability
 * check passed; a failed check (a full disk, a failed read-back) is kept as `incomplete` so the problem is on record, and it is never offered for resuming. A turn in progress is never a boundary.
 * Resuming (after a restart or a change of model) continues the same conversation identity.
 */
export class ContinuationService {
  readonly #runner: CommandRunner;
  readonly #inspection: InspectionService | undefined;

  private constructor(runner: CommandRunner, inspection: InspectionService | undefined) { this.#runner = runner; this.#inspection = inspection; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { inspection?: InspectionService } = {}): ContinuationService {
    return new ContinuationService(new CommandRunner(storage, epoch, options), options.inspection);
  }

  async capture(by: Principal, command: NoActor & { taskId: string } & ContinuationInput): Promise<{ id: string; seq: number; status: "complete" | "incomplete"; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "identity", "agent", "boundary", "checkpoint", "durable", "continuation", "manifest", "nonCheckpointableTools", "scratchRecords", "credentialRefs"]);
    const taskId = checkTaskId(command.taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined || !(by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } }))) throw new DomainError("forbidden", `${by.id} may not capture a continuation for that task`);
    const input = this.#check(command);
    if (by.kind === "agent" && input.agent !== by.id) invalid("agent", "an agent captures only its own run");
    // Scratch records must be the run's agent's own, in the task's project: a capture cannot name someone else's private records.
    for (const [i, recordId] of input.scratchRecords.entries()) {
      const rec = (await this.#runner.get("desk-record", recordId))?.body as unknown as { owner?: string; projectId?: string } | undefined;
      if (rec === undefined || rec.owner !== input.agent || rec.projectId !== task.projectId) invalid(`scratchRecords[${i}]`, "must be a record of the run's agent in the task's project");
    }
    // Only the host that ran the check can say it passed; an agent's own word is not durability.
    const trusted = by.kind === "owner" || by.kind === "host" || by.kind === "service";
    const durable = input.durable.verified && !trusted ? { verified: false, error: "durability was not verified by the host" } : input.durable;
    const headRef: AggregateRef = { kind: "continuation-head", id: taskId };
    const id = derivedId("cnt", scopedCommandId(by.id, command.commandId));
    const ref: AggregateRef = { kind: "continuation", id };
    const r = await this.#runner.command("continuation.capture", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, input: { ...input, durable } as unknown as JsonObject },
      build: async () => {
        const found = await this.#runner.get(headRef.kind, headRef.id);
        const head = found?.body as unknown as HeadBody | undefined;
        if (head !== undefined && head.identity !== input.identity) throw new DomainError("invalid_command", "this task's conversation has a different identity; a continuation keeps the same one", { field: "identity" });
        const seq = head?.next ?? 1;
        const complete = durable.verified;
        const { durable: _unused, ...rest } = input;
        void _unused;
        const body: ContinuationBody = { ...rest, taskId, projectId: task.projectId, seq, status: complete ? "complete" : "incomplete", ...(complete ? {} : { problem: durable.error ?? "the durability check did not pass" }), capturedBy: by.id, capturedAt: this.#runner.now() };
        const next: HeadBody = { identity: input.identity, next: seq + 1, latestComplete: complete ? seq : (head?.latestComplete ?? 0), ...(complete ? { latestCompleteId: id } : head?.latestCompleteId === undefined ? {} : { latestCompleteId: head.latestCompleteId }), projectId: task.projectId };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }, head === undefined ? { type: "create", ref: headRef, body: next as unknown as JsonObject } : { type: "update", ref: headRef, expectedRevision: found!.revision, body: next as unknown as JsonObject }], detail: { taskId, seq, status: body.status }, contention: async () => new DomainError("stale_revision", "another continuation was captured at the same moment") };
      },
    }));
    const stored = (await this.#runner.get("continuation", r.id))!.body as unknown as ContinuationBody;
    return { id: r.id, seq: stored.seq, status: stored.status, replayed: r.replayed };
  }

  /** The latest complete continuation of a task, for those who may work on it or read its history. */
  async latest(by: Principal, taskId: string): Promise<(ContinuationBody & { id: string }) | undefined> {
    const tid = checkTaskId(taskId);
    const head = (await this.#runner.get("continuation-head", tid))?.body as unknown as HeadBody | undefined;
    if (head === undefined || !this.#mayRead(by, head.projectId, tid)) return undefined;
    if (head.latestCompleteId === undefined) return undefined;
    const a = await this.#runner.get("continuation", head.latestCompleteId);
    return a === undefined ? undefined : { ...(a.body as unknown as ContinuationBody), id: a.id };
  }

  /** Continues a task from a complete continuation (the latest by default) in the same conversation identity, after a restart or with a different model. */
  async resume(by: Principal, command: NoActor & { taskId: string; continuationId?: string; model: { provider: string; id: string }; previousModel?: { provider: string; id: string }; after: "restart" | "model-change" | "continue" }): Promise<{ identity: string; continuation: ContinuationBody & { id: string }; modelChanged: boolean; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "continuationId", "model", "previousModel", "after"]);
    const taskId = checkTaskId(command.taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined || !(by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } }))) throw new DomainError("forbidden", `${by.id} may not resume that task`);
    if (!["restart", "model-change", "continue"].includes(command.after)) invalid("after", "must be restart, model-change or continue");
    const model = this.#model(command.model, "model");
    const previous = command.previousModel === undefined ? undefined : this.#model(command.previousModel, "previousModel");
    const rid = derivedId("cnr", scopedCommandId(by.id, command.commandId));
    const ref: AggregateRef = { kind: "continuation-resume", id: rid };
    let chosen: (ContinuationBody & { id: string }) | undefined;
    const r = await this.#runner.command("continuation.resume", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, continuationId: command.continuationId ?? null, model: model as unknown as JsonObject, previousModel: (previous ?? null) as unknown as JsonObject, after: command.after },
      build: async () => {
        const head = (await this.#runner.get("continuation-head", taskId))?.body as unknown as HeadBody | undefined;
        if (head === undefined) throw new DomainError("not_found", "no continuation was captured for that task");
        let c: (ContinuationBody & { id: string }) | undefined;
        if (command.continuationId !== undefined) {
          if (!REF.test(command.continuationId)) invalid("continuationId", "is not a continuation ID");
          const a = await this.#runner.get("continuation", command.continuationId);
          const b = a?.body as unknown as ContinuationBody | undefined;
          c = a === undefined || b === undefined || b.taskId !== taskId ? undefined : { ...b, id: a.id };
        } else c = await this.latest(by, taskId);
        if (c === undefined) throw new DomainError("not_found", "no such continuation for that task");
        // An incomplete capture is never offered for resuming.
        if (c.status !== "complete") throw new DomainError("invalid_transition", `that continuation is incomplete (${c.problem ?? "unverified"}) and cannot be resumed`);
        chosen = c;
        const modelChanged = previous !== undefined && (previous.provider !== model.provider || previous.id !== model.id);
        const body: ResumeBody = { taskId, continuationId: c.id, identity: head.identity, model, ...(previous === undefined ? {} : { previousModel: previous }), modelChanged, after: command.after, by: by.id, at: this.#runner.now() };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { taskId, continuationId: c.id, modelChanged } };
      },
    }));
    const done = (await this.#runner.get("continuation-resume", r.id))!.body as unknown as ResumeBody;
    if (chosen === undefined || chosen.id !== done.continuationId) {
      const a = (await this.#runner.get("continuation", done.continuationId))!;
      chosen = { ...(a.body as unknown as ContinuationBody), id: a.id };
    }
    return { identity: done.identity, continuation: chosen, modelChanged: done.modelChanged, replayed: r.replayed };
  }

  /** The recovery service reads the scratch records a continuation points to, only through the inspection service, which leaves a record the agent can see for each. */
  async recoveryScratch(service: Principal, command: NoActor & { continuationId: string; reason: string }): Promise<{ records: unknown[]; inspections: string[] }> {
    if (this.#inspection === undefined) throw new DomainError("unavailable", "no inspection service is configured");
    onlyKnown(command, ["commandId", "continuationId", "reason"]);
    const a = await this.#runner.get("continuation", REF.test(command.continuationId) ? command.continuationId : invalid("continuationId", "is not a continuation ID"));
    if (a === undefined) throw new DomainError("not_found", "no such continuation");
    const body = a.body as unknown as ContinuationBody;
    if (body.status !== "complete") throw new DomainError("invalid_transition", "that continuation is incomplete");
    const records: unknown[] = []; const inspections: string[] = [];
    for (const [i, recordId] of body.scratchRecords.entries()) {
      // Re-checked at the time of reading: only the run's agent's own records in the task's project.
      const rec = (await this.#runner.get("desk-record", recordId))?.body as unknown as { owner?: string; projectId?: string } | undefined;
      if (rec === undefined || rec.owner !== body.agent || rec.projectId !== body.projectId) continue;
      const r = await this.#inspection.recoveryRead(service, { commandId: `${command.commandId}-${i}`, recordId, reason: command.reason });
      inspections.push(r.inspectionId);
      if (r.record !== undefined) records.push(r.record);
    }
    return { records, inspections };
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  #mayRead(by: Principal, projectId: string, taskId: string): boolean { return by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "attempt.work", projectId, { resource: { kind: "task", id: taskId } }) || allows(by, "history.read", projectId); }

  #model(v: unknown, field: string): { provider: string; id: string } {
    const o = obj(v, field);
    const provider = typeof o["provider"] === "string" && MODEL.test(o["provider"]) ? o["provider"] : invalid(`${field}.provider`, "is not a provider name");
    const id = typeof o["id"] === "string" && MODEL.test(o["id"]) ? o["id"] : invalid(`${field}.id`, "is not a model name");
    return { provider, id };
  }

  /** Validates and normalises a capture. Secrets anywhere are refused. */
  #check(c: ContinuationInput): ContinuationInput {
    noSecrets(c, "capture");
    const identity = typeof c.identity === "string" && IDENTITY.test(c.identity) ? c.identity : invalid("identity", "is not an acceptable conversation identity");
    const b = obj(c.boundary, "boundary");
    if (!["turn-complete", "timeout", "manual", "shutdown"].includes(b["kind"] as string)) invalid("boundary.kind", "must be turn-complete, timeout, manual or shutdown");
    if (b["turnInProgress"] === true) invalid("boundary", "a turn in progress is not a safe boundary; capture at the last completed turn");
    const cp = obj(c.checkpoint, "checkpoint"); const rt = obj(cp["runtime"], "checkpoint.runtime");
    const checkpoint = { conversationId: count(cp["conversationId"], "checkpoint.conversationId"), at: count(cp["at"], "checkpoint.at"), digest: typeof cp["digest"] === "string" && /^v1:sha256:[0-9a-f]{64}$/.test(cp["digest"]) ? cp["digest"] : invalid("checkpoint.digest", "is not a checkpoint digest"), runtime: { name: text(rt["name"], "checkpoint.runtime.name", 40), version: text(rt["version"], "checkpoint.runtime.version", 40) }, format: count(cp["format"], "checkpoint.format") };
    const d = obj(c.durable, "durable");
    if (typeof d["verified"] !== "boolean") invalid("durable.verified", "must say whether the durability check passed");
    const durable = { verified: d["verified"] as boolean, ...(d["error"] === undefined ? {} : { error: text(d["error"], "durable.error", 300) }) };
    const k = obj(c.continuation, "continuation"); const bu = obj(k["budget"], "continuation.budget");
    const ref = (x: unknown, f: string): string => typeof x === "string" && REF.test(x) ? x : invalid(f, "must be a record ID");
    const continuation = {
      artifacts: list(k["artifacts"], "continuation.artifacts", CONTINUATION_LIMITS.items, ref), decisions: list(k["decisions"], "continuation.decisions", CONTINUATION_LIMITS.items, ref),
      pendingEffects: list(k["pendingEffects"], "continuation.pendingEffects", CONTINUATION_LIMITS.items, (x, f) => { const o = obj(x, f); return { effectId: ref(o["effectId"], `${f}.effectId`), state: text(o["state"], `${f}.state`, 40) }; }),
      budget: { spent: count(bu["spent"], "continuation.budget.spent"), remaining: count(bu["remaining"], "continuation.budget.remaining"), unit: text(bu["unit"], "continuation.budget.unit", 20) },
      nextStep: text(k["nextStep"], "continuation.nextStep"),
    };
    const m = obj(c.manifest, "manifest"); const comp = obj(m["compression"], "manifest.compression"); const ad = obj(m["adapter"], "manifest.adapter");
    const manifest = {
      summaryLineage: list(m["summaryLineage"], "manifest.summaryLineage", CONTINUATION_LIMITS.items, ref),
      sourceRanges: list(m["sourceRanges"], "manifest.sourceRanges", CONTINUATION_LIMITS.ranges, (x, f) => { const o = obj(x, f); const from = count(o["from"], `${f}.from`); const to = count(o["to"], `${f}.to`); if (to < from) invalid(f, "ends before it starts"); return { source: text(o["source"], `${f}.source`, 100), from, to }; }),
      compression: { state: comp["state"] === "compacted" ? "compacted" as const : comp["state"] === "none" ? "none" as const : invalid("manifest.compression.state", "must be none or compacted"), compactions: count(comp["compactions"], "manifest.compression.compactions") },
      branches: list(m["branches"], "manifest.branches", CONTINUATION_LIMITS.items, (x, f) => { const o = obj(x, f); return { conversationId: count(o["conversationId"], `${f}.conversationId`), parent: count(o["parent"], `${f}.parent`) }; }),
      messageCursor: count(m["messageCursor"], "manifest.messageCursor"), routingRevision: count(m["routingRevision"], "manifest.routingRevision"), environmentRevision: count(m["environmentRevision"], "manifest.environmentRevision"),
      adapter: { name: text(ad["name"], "manifest.adapter.name", 40), version: text(ad["version"], "manifest.adapter.version", 40) },
    };
    const tools = list(c.nonCheckpointableTools, "nonCheckpointableTools", CONTINUATION_LIMITS.tools, (x, f) => { const o = obj(x, f); return { name: text(o["name"], `${f}.name`, 80), reason: text(o["reason"], `${f}.reason`, 300) }; });
    const credentialRefs = list(c.credentialRefs, "credentialRefs", CONTINUATION_LIMITS.items, (x, f) => typeof x === "string" && NAME.test(x) ? x : invalid(f, "must be the name of a secret"));
    const agent = typeof c.agent === "string" && /^agent:[A-Za-z0-9._-]{1,64}$/.test(c.agent) ? c.agent : invalid("agent", "must be the run's agent, like agent:ann");
    return { identity, agent, boundary: { kind: b["kind"] as BoundaryKind }, checkpoint, durable, continuation, manifest, nonCheckpointableTools: tools, scratchRecords: list(c.scratchRecords, "scratchRecords", CONTINUATION_LIMITS.items, (x, f) => typeof x === "string" && /^dsk-[a-z2-7]{20}$/.test(x) ? x : invalid(f, "must be a desk record ID")), credentialRefs };
  }
}

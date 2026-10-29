import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, text, type View } from "../domain/model.js";
import type { Owner } from "../domain/assignment-model.js";
import type { AssignmentService } from "../domain/assignments.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { PauseScope, PauseService } from "./pause.js";
import type { StopService } from "./stop.js";

/**
 * What the hand-off package may hold (card L03). The names are fixed: a source cannot add a section, so private scratch or anything else outside the list never travels with the task. Every section is
 * within the sharing scope of the task and the recipient, which is the source's job to honour and is checked again by name here.
 */
export const HANDOFF_SECTIONS = [
  "brief", "acceptanceCriteria", "versions", "outstandingQuestions", "audience", "completedWork", "unfinishedWork", "drafts", "uncommittedChanges", "results",
  "backgroundOperations", "locks", "risks", "nextAction",
] as const;
export type HandoffSection = (typeof HANDOFF_SECTIONS)[number];
/** Without these a recipient cannot carry on; a package missing one is not ready (and can still be handed over, with the gap accepted and recorded). */
export const REQUIRED_SECTIONS: readonly HandoffSection[] = ["brief", "acceptanceCriteria", "unfinishedWork", "nextAction"];

export type HandoffPhase = "preparing" | "blocked" | "ready" | "transferring" | "transferred" | "failed" | "cancelled";
const TERMINAL: readonly HandoffPhase[] = ["transferred", "failed", "cancelled"];
const LIVE: readonly HandoffPhase[] = ["preparing", "blocked", "ready", "transferring"];

/** What the controller reads from the rest of the system to build the package. Reading must be repeatable and must return only what the recipient may see. */
export interface HandoffSources {
  collect(request: { taskId: string; from: Owner; to: Owner }): Promise<{ sections: Readonly<Record<string, string>> }>;
  /** Why this recipient cannot take the task (retired, paused, wrong kind), or undefined. */
  ineligible?(to: Owner, task: { readonly taskId: string }): Promise<string | undefined>;
}

export interface TaskHandoffBody {
  readonly taskId: string;
  readonly projectId?: string;
  readonly from: Owner;
  readonly to: Owner;
  /** The assignment as it was when the hand-off began: the transfer happens only if it is still so. */
  readonly generation: number;
  readonly phase: HandoffPhase;
  readonly mode: "prepared" | "forced";
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  /** The scope was already held when this began, so it stays held (a manual hold is never lifted by a hand-off). */
  readonly heldBefore: boolean;
  /** A takeover ends the prepared hand-off it replaces; recorded so a restart finishes that too. */
  readonly replaces?: string;
  readonly stopIntentId?: string;
  readonly package?: { readonly collectedAt: string; readonly sections: Readonly<Record<string, string>>; readonly missing: readonly string[]; readonly ready: boolean };
  readonly blocked?: { readonly reason: string; readonly choices: readonly ("wait" | "force-takeover" | "cancel")[] } | undefined;
  /** Set when the package was handed over with required sections missing. */
  readonly acceptedGaps?: { readonly by: string; readonly missing: readonly string[]; readonly at: string };
  /** A forced takeover is a visible exception: what was missing and what may be uncertain. */
  readonly exception?: { readonly by: string; readonly reason: string; readonly at: string; readonly missingCleanup: readonly string[]; readonly uncertainEffects: readonly string[] };
  readonly transferredAt?: string;
  readonly failure?: string;
  readonly history: readonly { readonly phase: HandoffPhase; readonly at: string; readonly by: string; readonly note: string }[];
}

export const HANDOFF_LIMITS = { reason: 500, section: 4000, history: 40, advances: 8 } as const;
const KIND = "handoff";
const ACTIVE = "handoff-active";
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const plain = (value: unknown, field: string): string => {
  const out = text(value, field, { min: 1, max: HANDOFF_LIMITS.reason, multiline: true });
  return redactText(out) !== out ? invalid(field, "looks like a credential or key; those are not recorded") : out;
};
const clean = (body: object): JsonObject => JSON.parse(JSON.stringify(body)) as JsonObject;
const sameOwner = (a: Owner | undefined, b: Owner): boolean => a !== undefined && a.kind === b.kind && a.id === b.id;
const checkOwner = (value: unknown, field: string): Owner => {
  if (value === null || typeof value !== "object") return invalid(field, "must be { kind, id }");
  const o = value as Record<string, unknown>;
  onlyKnown(o, ["kind", "id"]);
  return { kind: text(o["kind"], `${field}.kind`, { min: 1, max: 20 }), id: text(o["id"], `${field}.id`, { min: 1, max: 100 }) };
};

/**
 * Prepared release and reassignment of a task (card L03). A hand-off does not hurry the work it replaces: it asks the stop machinery (L02) for a Suspend, which pauses the scope and reaches a durable
 * checkpoint inside a deadline, then collects the hand-off package, then moves the assignment in one fenced transfer, and only then lets the new owner run. Every step is written before it is done and is
 * repeatable: a crash before the transfer leaves one owner (the old one, paused), a crash after leaves one (the new one), and `advance` on a restart finishes whatever was begun. The transfer is guarded
 * by the assignment's generation, so a task whose ownership changed since the hand-off began is not moved, and the old owner's fence stops working the moment the generation moves.
 *
 * Readiness is reported, not assumed: the package says which required sections are missing, and handing over an incomplete package needs the caller to accept the gaps, which is recorded. A **takeover** is
 * the explicit exception: it force-stops the scope, takes what exists, and records what was missing and what may be uncertain. A hand-off never drops the work: if the recipient cannot take it, or
 * preparation blocks, the old owner still owns the task and the choices are to wait, take over by force, or cancel.
 */
export class HandoffService {
  readonly #runner: CommandRunner;
  readonly #pauses: PauseService;
  readonly #stops: Pick<StopService, "request" | "advance" | "force" | "get">;
  readonly #assignments: Pick<AssignmentService, "getAssignment" | "transferTask">;
  readonly #sources: HandoffSources;
  readonly #onTransferred: ((by: Principal, event: { handoffId: string; taskId: string; from: Owner; to: Owner }) => Promise<void>) | undefined;

  private constructor(runner: CommandRunner, pauses: PauseService, stops: Pick<StopService, "request" | "advance" | "force" | "get">, assignments: Pick<AssignmentService, "getAssignment" | "transferTask">, sources: HandoffSources, onTransferred?: (by: Principal, event: { handoffId: string; taskId: string; from: Owner; to: Owner }) => Promise<void>) {
    this.#onTransferred = onTransferred;
    this.#runner = runner; this.#pauses = pauses; this.#stops = stops; this.#assignments = assignments; this.#sources = sources;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: { pauses: PauseService; stops: Pick<StopService, "request" | "advance" | "force" | "get">; assignments: Pick<AssignmentService, "getAssignment" | "transferTask">; sources: HandoffSources; /** Told once a task has moved, so the move can be put in the task's activity record (best effort: a failure here never undoes or holds back the hand-off). */ onTransferred?: (by: Principal, event: { handoffId: string; taskId: string; from: Owner; to: Owner }) => Promise<void> }, options: RunnerOptions = {}): HandoffService {
    return new HandoffService(new CommandRunner(storage, epoch, options), deps.pauses, deps.stops, deps.assignments, deps.sources, deps.onTransferred);
  }

  // ---- requests ------------------------------------------------------------------------------------------------------------

  /** Begins a prepared hand-off of a task to another owner. One hand-off at a time per task. Returns where it stands after one pass. */
  async prepare(by: Principal, command: NoActor & { taskId: string; to: unknown; reason: string; deadlineMs?: number }): Promise<View<TaskHandoffBody>> {
    onlyKnown(command, ["commandId", "taskId", "to", "reason", "deadlineMs"]);
    const reason = plain(command.reason, "reason");
    const to = checkOwner(command.to, "to");
    const scope: PauseScope = { kind: "task", id: String(command.taskId) };
    const target = await this.#pauses.authorizeControl(by, scope);
    const { assignment, from } = await this.#currentOwner(scope.id);
    if (sameOwner(from, to)) invalid("to", "is already the owner of the task");
    const why = await this.#sources.ineligible?.(to, { taskId: scope.id });
    if (why !== undefined) throw new DomainError("invalid_command", `${to.kind}:${to.id} cannot take the task: ${why}`, { field: "to" });
    const id = derivedId("hnd", scopedCommandId(by.id, command.commandId));
    const heldBefore = (await this.#pauses.gate(by, scope))?.intent === "pause";
    await this.#create(by, command.commandId, id, scope.id, target.projectId, from, to, assignment.generation, "prepared", reason, heldBefore);
    // The suspension that prepares the hand-off. Its command ID follows the hand-off's, so repeating the request repeats it.
    const stop = await this.#stops.request(by, { commandId: `${String(command.commandId)}-suspend`, scope, mode: "suspend", reason: `hand-off: ${reason}`.slice(0, 500), ...(command.deadlineMs === undefined ? {} : { deadlineMs: command.deadlineMs }) });
    await this.#update(id, (b) => ({ ...b, stopIntentId: b.stopIntentId ?? stop.intentId }), LIVE);
    return this.advance(by, { handoffId: id });
  }

  /** The caller accepts the package as it is and the task moves. Refused unless ready; an incomplete package needs `acceptGaps`, which is recorded. */
  async complete(by: Principal, command: NoActor & { handoffId: string; acceptGaps?: boolean }): Promise<View<TaskHandoffBody>> {
    onlyKnown(command, ["commandId", "handoffId", "acceptGaps"]);
    const found = await this.#get(command.handoffId);
    const b = found.body as unknown as TaskHandoffBody;
    await this.#mayControl(by, b.taskId);
    if (b.phase === "transferring" || b.phase === "transferred") return this.advance(by, { handoffId: command.handoffId });
    if (b.phase !== "ready") throw new DomainError("invalid_command", `the hand-off is ${b.phase}; it can be completed when it is ready`, { field: "handoffId" });
    const missing = b.package?.missing ?? [...REQUIRED_SECTIONS];
    if (missing.length > 0 && command.acceptGaps !== true) throw new DomainError("invalid_command", `the package is missing ${missing.join(", ")}; complete it with acceptGaps to hand it over anyway`, { field: "acceptGaps" });
    const at = this.#runner.now();
    await this.#update(command.handoffId, (x) => ({ ...x, phase: "transferring", ...(missing.length === 0 ? {} : { acceptedGaps: { by: by.id, missing, at } }), history: this.#push(x, "transferring", by.id, missing.length === 0 ? "package accepted" : `package accepted with gaps: ${missing.join(", ")}`) }), ["ready"]);
    return this.advance(by, { handoffId: command.handoffId });
  }

  /**
   * Forced takeover: for a task whose owner cannot or will not prepare. It force-stops the scope (L02), takes the package as it can be collected, moves the assignment, and records the exception with what
   * was missing and what may be uncertain. It needs the same authority as Force Stop; it never says the preparation was complete.
   */
  async takeover(by: Principal, command: NoActor & { taskId: string; to: unknown; reason: string }): Promise<View<TaskHandoffBody>> {
    onlyKnown(command, ["commandId", "taskId", "to", "reason"]);
    const reason = plain(command.reason, "reason");
    const to = checkOwner(command.to, "to");
    const scope: PauseScope = { kind: "task", id: String(command.taskId) };
    const target = await this.#pauses.authorizeControl(by, scope);
    const id = derivedId("hnd", scopedCommandId(by.id, command.commandId));
    const prior = await this.#runner.get(KIND, id);
    if (prior !== undefined) return this.advance(by, { handoffId: id }); // the same takeover sent again answers as recorded
    const { assignment, from } = await this.#currentOwner(scope.id);
    if (sameOwner(from, to)) invalid("to", "is already the owner of the task");
    const why = await this.#sources.ineligible?.(to, { taskId: scope.id });
    if (why !== undefined) throw new DomainError("invalid_command", `${to.kind}:${to.id} cannot take the task: ${why}`, { field: "to" });
    // A prepared hand-off already under way is taken over by this one: it ends as cancelled and the takeover stands alone.
    const active = await this.#activeId(scope.id);
    // A hold the replaced hand-off had added (its suspension) is still the hand-off's to lift; a hold that was there before it stays.
    const replaced = active === undefined ? undefined : ((await this.#runner.get(KIND, active))?.body as unknown as TaskHandoffBody | undefined);
    const heldBefore = replaced !== undefined ? replaced.heldBefore : (await this.#pauses.gate(by, scope))?.intent === "pause";
    // Written as preparing: the stop, the package and the exception come next, in `advance`, and the task moves only after them.
    await this.#create(by, command.commandId, id, scope.id, target.projectId, from, to, assignment.generation, "forced", reason, heldBefore, active);
    return this.advance(by, { handoffId: id });
  }

  /** The answer to a blocked hand-off: wait for more preparation, take over by force, or cancel (the old owner keeps the task). */
  async choose(by: Principal, command: NoActor & { handoffId: string; choice: "wait" | "force-takeover" | "cancel"; reason?: string }): Promise<View<TaskHandoffBody>> {
    onlyKnown(command, ["commandId", "handoffId", "choice", "reason"]);
    const found = await this.#get(command.handoffId);
    const b = found.body as unknown as TaskHandoffBody;
    await this.#mayControl(by, b.taskId);
    if (b.phase !== "blocked") throw new DomainError("invalid_command", `the hand-off is ${b.phase}; there is nothing to choose`, { field: "handoffId" });
    if (command.choice === "wait") {
      await this.#update(command.handoffId, (x) => ({ ...x, phase: "preparing", blocked: undefined, history: this.#push(x, "preparing", by.id, "waiting for more preparation") }), ["blocked"]);
      if (b.stopIntentId !== undefined) {
        const stop = await this.#stops.get(by, b.stopIntentId);
        if (stop?.phase === "blocked") throw new DomainError("invalid_command", "the suspension is blocked; choose it through the stop request or take over by force", { field: "choice" });
      }
      return this.advance(by, { handoffId: command.handoffId });
    }
    if (command.choice === "cancel") return this.cancel(by, { handoffId: command.handoffId });
    if (command.choice !== "force-takeover") return invalid("choice", "must be wait, force-takeover or cancel");
    const reason = plain(command.reason ?? "chosen after a blocked preparation", "reason");
    return this.takeover(by, { commandId: command.commandId, taskId: b.taskId, to: b.to, reason });
  }

  /** Ends a hand-off that has not moved the task. The old owner keeps it; a hold the hand-off added is lifted. */
  async cancel(by: Principal, command: { handoffId: string }): Promise<View<TaskHandoffBody>> {
    const found = await this.#get(command.handoffId);
    const b = found.body as unknown as TaskHandoffBody;
    await this.#mayControl(by, b.taskId);
    if (b.phase === "transferring" || b.phase === "transferred") throw new DomainError("invalid_command", `the hand-off is ${b.phase}; it can no longer be cancelled`, { field: "handoffId" });
    if (b.mode === "forced" && !TERMINAL.includes(b.phase)) throw new DomainError("invalid_command", "a takeover cannot be cancelled once begun", { field: "handoffId" });
    if (TERMINAL.includes(b.phase)) return view<TaskHandoffBody>(found);
    await this.#update(command.handoffId, (x) => ({ ...x, phase: "cancelled", blocked: undefined, history: this.#push(x, "cancelled", by.id, "cancelled; the old owner keeps the task") }), ["preparing", "blocked", "ready"]);
    await this.#letGo(by, command.handoffId);
    return view<TaskHandoffBody>((await this.#runner.get(KIND, command.handoffId))!);
  }

  // ---- progress ------------------------------------------------------------------------------------------------------------

  /** Takes the hand-off as far as it can go now. Safe to repeat at any time. */
  async advance(by: Principal, command: { handoffId: string }): Promise<View<TaskHandoffBody>> {
    const id = String(command.handoffId);
    const first = await this.#get(id);
    await this.#mayControl(by, (first.body as unknown as TaskHandoffBody).taskId);
    for (let step = 0; step < HANDOFF_LIMITS.advances; step++) {
      const found = await this.#get(id);
      const b = found.body as unknown as TaskHandoffBody;
      if (TERMINAL.includes(b.phase) || b.phase === "ready" || b.phase === "blocked") return view<TaskHandoffBody>(found);
      if (b.phase === "preparing" && b.mode === "forced") {
        if (b.replaces !== undefined) await this.#update(b.replaces, (x) => ({ ...x, phase: "cancelled", blocked: undefined, history: this.#push(x, "cancelled", by.id, "replaced by a forced takeover") }), LIVE);
        // Force Stop is repeatable under this hand-off's own command ID, so a crash anywhere here is finished by the next pass.
        const stopped = await this.#stops.force(by, { commandId: `${id}-force`, scope: { kind: "task", id: b.taskId }, reason: `takeover: ${b.reason}`.slice(0, 500) });
        const collected = await this.#collect(b.taskId, b.from, b.to);
        await this.#update(id, (x) => ({
          ...x, stopIntentId: stopped.intentId, package: collected, phase: "transferring",
          exception: { by: by.id, reason: x.reason, at: this.#runner.now(), missingCleanup: collected.missing, uncertainEffects: stopped.outcome.unresolved.slice(0, 50) },
          history: this.#push(x, "transferring", by.id, "forced takeover: stopped without preparation"),
        }), ["preparing"]);
        continue;
      }
      if (b.phase === "preparing") {
        const stop = b.stopIntentId === undefined ? undefined : await this.#stops.advance(by, { intentId: b.stopIntentId });
        if (stop === undefined) { await this.#block(id, by.id, "the suspension was never requested", ["preparing"]); continue; }
        if (stop.phase === "cancelled") { await this.#fail(by, id, "the scope was resumed before the suspension finished"); continue; }
        if (stop.phase === "blocked") { await this.#block(id, by.id, `the suspension is blocked: ${stop.blocked?.reason ?? "preparation did not finish"}`, ["preparing"]); continue; }
        if (stop.phase === "recovery-required") { await this.#block(id, by.id, "the suspension needs recovery; the task state is uncertain", ["preparing"]); continue; }
        if (stop.phase !== "done") return view<TaskHandoffBody>((await this.#get(id)));
        const collected = await this.#collect(b.taskId, b.from, b.to);
        await this.#update(id, (x) => ({ ...x, phase: "ready", package: collected, history: this.#push(x, "ready", by.id, collected.missing.length === 0 ? "package ready" : `package incomplete: missing ${collected.missing.join(", ")}`) }), ["preparing"]);
        continue;
      }
      if (b.phase === "transferring") {
        const { assignment } = await this.#currentOwner(b.taskId).catch(() => ({ assignment: undefined, from: undefined }));
        if (assignment !== undefined && assignment.state === "assigned" && sameOwner(assignment.owner, b.to) && assignment.generation > b.generation) {
          await this.#finish(by, id, b);
          continue;
        }
        if (assignment === undefined || assignment.state !== "assigned" || !sameOwner(assignment.owner, b.from) || assignment.generation !== b.generation) {
          await this.#fail(by, id, "the task's ownership changed after the hand-off began, so it was not moved");
          continue;
        }
        try {
          await this.#assignments.transferTask({ commandId: `${id}-transfer`, actor: by.id, taskId: b.taskId, expectedRevision: assignment.revision, to: b.to, reason: b.mode === "forced" ? `takeover: ${b.reason}`.slice(0, 500) : `hand-off: ${b.reason}`.slice(0, 500) });
        } catch (error) {
          if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "fenced")) throw error;
          continue; // someone else moved it: the next pass reads where it stands
        }
        continue;
      }
    }
    return view<TaskHandoffBody>(await this.#get(id));
  }

  /** Carries every unfinished hand-off on after a restart. A hand-off in transferring is finished; one waiting on preparation looks again. */
  async sweep(by: Principal): Promise<{ advanced: string[]; failed: string[] }> {
    if (by.kind !== "owner" && by.kind !== "service") throw new DomainError("forbidden", `${by.id} may not sweep hand-offs`);
    const advanced: string[] = []; const failed: string[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const rec of page) {
        after = rec.id;
        const b = rec.body as unknown as TaskHandoffBody;
        if (TERMINAL.includes(b.phase) || b.phase === "ready") continue;
        try { await this.advance(by, { handoffId: rec.id }); advanced.push(rec.id); } catch { failed.push(rec.id); }
      }
      if (page.length < 100) break;
    }
    return { advanced, failed };
  }

  async get(by: Principal, handoffId: string): Promise<View<TaskHandoffBody> | undefined> {
    const found = await this.#runner.get(KIND, String(handoffId));
    if (found === undefined) return undefined;
    try { await this.#mayControl(by, (found.body as unknown as TaskHandoffBody).taskId); } catch (error) { if (error instanceof DomainError && error.code === "not_found") return undefined; throw error; }
    return view<TaskHandoffBody>(found);
  }

  // ---- internals -----------------------------------------------------------------------------------------------------------

  async #mayControl(by: Principal, taskId: string): Promise<void> {
    try { await this.#pauses.authorizeControl(by, { kind: "task", id: taskId }); } catch (error) { if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) throw new DomainError("not_found", "no such hand-off"); throw error; }
  }

  async #get(id: string) {
    const found = await this.#runner.get(KIND, String(id));
    if (found === undefined) throw new DomainError("not_found", "no such hand-off");
    return found;
  }

  async #activeId(taskId: string): Promise<string | undefined> {
    const pointer = (await this.#runner.get(ACTIVE, derivedId("hnd", `active\0${taskId}`)))?.body as unknown as { handoffId?: string } | undefined;
    if (pointer?.handoffId === undefined) return undefined;
    const found = await this.#runner.get(KIND, pointer.handoffId);
    return found !== undefined && LIVE.includes((found.body as unknown as TaskHandoffBody).phase) ? pointer.handoffId : undefined;
  }

  async #currentOwner(taskId: string) {
    const assignment = await this.#assignments.getAssignment(taskId);
    if (assignment === undefined || assignment.state !== "assigned" || assignment.owner === undefined) throw new DomainError("invalid_command", `task ${taskId} is not assigned, so there is nothing to hand off`, { field: "taskId" });
    return { assignment, from: assignment.owner };
  }

  async #collect(taskId: string, from: Owner, to: Owner): Promise<NonNullable<TaskHandoffBody["package"]>> {
    let got: Awaited<ReturnType<HandoffSources["collect"]>>;
    try { got = await this.#sources.collect({ taskId, from, to }); } catch { got = { sections: {} }; }
    // Only the named sections travel, cut to size and with credentials removed; anything else a source returned is dropped.
    const sections: Record<string, string> = {};
    for (const name of HANDOFF_SECTIONS) {
      const value = got.sections[name];
      if (typeof value === "string" && value.trim().length > 0) sections[name] = redactText(value).slice(0, HANDOFF_LIMITS.section);
    }
    const missing = REQUIRED_SECTIONS.filter((s) => sections[s] === undefined);
    return { collectedAt: this.#runner.now(), sections, missing, ready: missing.length === 0 };
  }

  async #create(by: Principal, commandId: unknown, id: string, taskId: string, projectId: string | undefined, from: Owner, to: Owner, generation: number, mode: "prepared" | "forced", reason: string, heldBefore: boolean, replaces?: string): Promise<void> {
    const activeRef: AggregateRef = { kind: ACTIVE, id: derivedId("hnd", `active\0${taskId}`) };
    await this.#runner.command("handoff.create", { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { taskId, to: to as unknown as JsonObject, mode, reason },
      build: async () => {
        const at = this.#runner.now();
        const active = await this.#runner.get(ACTIVE, activeRef.id);
        const current = (active?.body as unknown as { handoffId?: string } | undefined)?.handoffId;
        if (current !== undefined && current !== id) {
          const cur = await this.#runner.get(KIND, current);
          if (cur !== undefined && LIVE.includes((cur.body as unknown as TaskHandoffBody).phase) && mode === "prepared") throw new DomainError("invalid_command", `task ${taskId} already has a hand-off in progress`, { field: "taskId" });
        }
        const ref: AggregateRef = { kind: KIND, id };
        const body: TaskHandoffBody = {
          taskId, ...(projectId === undefined ? {} : { projectId }), from, to, generation, phase: "preparing", mode, reason, requestedBy: by.id, requestedAt: at, heldBefore, ...(replaces === undefined ? {} : { replaces }),
          history: [{ phase: "preparing", at, by: by.id, note: mode === "forced" ? "takeover requested" : "hand-off requested" }],
        };
        const pointer = clean({ handoffId: id });
        return {
          ref, creates: true,
          changes: [{ type: "create", ref, body: clean(body) }, active === undefined ? { type: "create", ref: activeRef, body: pointer } : { type: "update", ref: activeRef, expectedRevision: active.revision, body: pointer }],
          detail: { taskId, mode },
        };
      },
    }));
  }

  /** Writes a change only if the record is still in one of the phases the decision was made in; false when someone else got there first. */
  async #update(id: string, change: (b: TaskHandoffBody) => TaskHandoffBody, from: readonly HandoffPhase[]): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get(KIND, id);
      if (found === undefined) throw new DomainError("not_found", "no such hand-off");
      if (!from.includes((found.body as unknown as TaskHandoffBody).phase)) return false;
      const next = change(found.body as unknown as TaskHandoffBody);
      const digest = sha(JSON.stringify(clean(next)));
      try {
        await this.#runner.command("handoff.advance", { commandId: `hnd-adv-${id.slice(4)}-${found.revision}-${digest}`, actor: "system" }, async () => ({
          payload: { phase: next.phase, revision: found.revision },
          build: async () => ({ ref: { kind: KIND, id }, creates: false, changes: [{ type: "update", ref: { kind: KIND, id }, expectedRevision: found.revision, body: clean(next) }], detail: { phase: next.phase } }),
        }));
        return true;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 6) throw error;
      }
    }
  }

  #push(b: TaskHandoffBody, phase: HandoffPhase, by: string, note: string): TaskHandoffBody["history"] {
    return [...b.history, { phase, at: this.#runner.now(), by, note: redactText(note).slice(0, 300) }].slice(-HANDOFF_LIMITS.history);
  }

  async #block(id: string, by: string, reason: string, from: readonly HandoffPhase[]): Promise<void> {
    await this.#update(id, (x) => ({ ...x, phase: "blocked", blocked: { reason, choices: ["wait", "force-takeover", "cancel"] }, history: this.#push(x, "blocked", by, reason) }), from);
  }

  /** The hand-off could not move the task: it ends failed, the old owner (if still the owner) keeps the task, and a hold it added is lifted. */
  async #fail(by: Principal, id: string, why: string): Promise<void> {
    await this.#update(id, (x) => ({ ...x, phase: "failed", blocked: undefined, failure: why, history: this.#push(x, "failed", by.id, why) }), LIVE);
    await this.#letGo(by, id);
  }

  /** The task moved: the new owner may run, so a hold this hand-off added is lifted. */
  async #finish(by: Principal, id: string, b: TaskHandoffBody): Promise<void> {
    await this.#update(id, (x) => ({ ...x, phase: "transferred", transferredAt: this.#runner.now(), history: this.#push(x, "transferred", by.id, `now owned by ${b.to.kind}:${b.to.id}`) }), ["transferring"]);
    try { await this.#onTransferred?.(by, { handoffId: id, taskId: b.taskId, from: b.from, to: b.to }); } catch { /* the record of the move is best effort */ }
    await this.#letGo(by, id);
  }

  async #letGo(by: Principal, id: string): Promise<void> {
    const b = (await this.#runner.get(KIND, id))?.body as unknown as TaskHandoffBody | undefined;
    if (b === undefined || b.heldBefore) return;
    const scope: PauseScope = { kind: "task", id: b.taskId };
    if ((await this.#pauses.gate(by, scope))?.intent !== "pause") return;
    try { await this.#pauses.resume(by, { commandId: `${id}-resume`, scope, reason: b.phase === "transferred" ? "hand-off complete" : "hand-off ended" }); } catch (error) { if (!(error instanceof DomainError)) throw error; }
  }
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

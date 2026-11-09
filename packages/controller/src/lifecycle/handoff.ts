import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, text, type View } from "../domain/model.js";
import type { Owner } from "../domain/assignment-model.js";
import type { AssignmentService } from "../domain/assignments.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { cutSection, neutralise, safeSlice, wellFormed } from "./handoff-cut.js";
import type { PauseScope, PauseService } from "./pause.js";
import type { StopService } from "./stop.js";

/**
 * What the hand-off package may hold (card L03). The names are fixed: a source cannot add a section, so private scratch or anything else outside the list never travels with the task. Every section is
 * within the sharing scope of the task and the recipient, which is the source's job to honour and is checked again by name here.
 */
export const HANDOFF_SECTIONS = [
  "brief", "acceptanceCriteria", "versions", "outstandingQuestions", "audience", "completedWork", "unfinishedWork", "drafts", "uncommittedChanges", "results",
  "backgroundOperations", "locks", "responsibilities", "risks", "nextAction",
] as const;
export type HandoffSection = (typeof HANDOFF_SECTIONS)[number];
/** Without these a recipient cannot carry on; a package missing one is not ready (and can still be handed over, with the gap accepted and recorded). */
export const REQUIRED_SECTIONS: readonly HandoffSection[] = ["brief", "acceptanceCriteria", "unfinishedWork", "nextAction"];

export type HandoffPhase = "preparing" | "blocked" | "ready" | "transferring" | "transferred" | "failed" | "cancelled";
const TERMINAL: readonly HandoffPhase[] = ["transferred", "failed", "cancelled"];
const LIVE: readonly HandoffPhase[] = ["preparing", "blocked", "ready", "transferring"];
/** Whether the hand-off names its own hold (`holdOps` or `holdRequestId`, card L04c review); an older record does not. */
const named = (b: { readonly holdOps?: unknown; readonly holdRequestId?: string | undefined }): boolean => b.holdOps !== undefined || b.holdRequestId !== undefined;

/**
 * Moving the sender's responsibilities along with the task (card L03i). Both steps run as the one who asked, so the right to assign responsibilities is theirs and is checked again when it is carried out.
 * `check` throws a typed refusal when an entry cannot be moved (not the sender's, unknown, retired, the recipient cannot answer for it); `apply` moves each entry independently and reports what happened.
 */
export interface ResponsibilityHandover {
  check(by: Principal, request: { taskId: string; ids: readonly string[]; from: Owner; to: Owner }): Promise<void>;
  /** Repeatable: an entry already answered for by the recipient counts as moved. `by` is undefined when the asker is gone or no longer active. */
  apply(by: Principal | undefined, request: { handoffId: string; ids: readonly string[]; from: Owner; to: Owner }): Promise<{ moved: readonly string[]; failed: readonly { id: string; reason: string }[] }>;
}

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
  /** The pause request the hand-off's own suspension or force stop holds the task with (when it was not held before): only that very pause is lifted when the hand-off ends, never one set after it (card L04c review). */
  readonly holdRequestId?: string;
  /**
   * The pause commands that would be the hand-off's own hold (card L04c review 4): its suspension's pause (made by the asker) or its force stop's (made by whoever advanced it), and those of a prepared hand-off a takeover
   * replaced. Written when the hand-off is created, before any of them is sent, so a crash between the suspension and `holdRequestId` still leaves the hand-off able to tell its own pause from anyone else's.
   * A record that has neither this nor `holdRequestId` is from before the hold was named and lifts any pause when it ends (unless held before), as it always did.
   */
  readonly holdOps?: readonly { readonly operationId: string; readonly actor?: string }[];
  /** When the hand-off's end let go of its hold (lifted it, or found it already gone or replaced by a later pause). A sweep lifts the hold of an ended hand-off that has none (a crash after the end). */
  readonly released?: string;
  readonly package?: {
    readonly collectedAt: string; readonly sections: Readonly<Record<string, string>>; readonly missing: readonly string[]; readonly ready: boolean;
    /** The sections cut to fit (card C07j): each shows a marker naming `archiveId`, where the whole section is kept, readable through `archive`. */
    readonly cuts?: readonly HandoffCut[];
  };
  readonly blocked?: { readonly reason: string; readonly choices: readonly ("wait" | "force-takeover" | "cancel")[] } | undefined;
  /** Set when the package was handed over with required sections missing. */
  readonly acceptedGaps?: { readonly by: string; readonly missing: readonly string[]; readonly at: string };
  /** A forced takeover is a visible exception: what was missing and what may be uncertain. */
  readonly exception?: { readonly by: string; readonly reason: string; readonly at: string; readonly missingCleanup: readonly string[]; readonly uncertainEffects: readonly string[] };
  readonly transferredAt?: string;
  /** The responsibilities the one who completed the hand-off chose to move to the recipient with the task (card L03i); carried out right after the move of the task, once. */
  readonly reassign?: { readonly ids: readonly string[]; readonly by: string; readonly at: string };
  /** What came of it: each entry moved or failed with a reason. A failure leaves that responsibility with the sender; it never undoes the move of the task. */
  readonly reassigned?: { readonly at: string; readonly moved: readonly string[]; readonly failed: readonly { readonly id: string; readonly reason: string }[] };
  /** A temporary reassignment: when the task goes back to `from` (card L03e). The return is a hand-off of its own, made on this time, as the one who asked, if they still hold the right. */
  readonly returnAt?: string;
  /** This hand-off is a return: when it is ready the controller completes it (accepting gaps, which are recorded) for the one who asked, if they still hold the right. */
  readonly autoComplete?: boolean;
  /** Set once the return was made (`handoffId`) or given up (`skipped`, with the reason). */
  readonly returned?: { readonly handoffId?: string; readonly at: string; readonly skipped?: string };
  /** The host was told that this return is stuck (blocked), at the time of its last history entry (the block); told again only if it is blocked again later. */
  readonly stuckTold?: string;
  /** On a return: the temporary reassignment it undoes (its command ID is `ret-<this>`), so a return left half-made by a crash can be finished from its own record. */
  readonly returnOf?: string;
  readonly failure?: string;
  readonly history: readonly { readonly phase: HandoffPhase; readonly at: string; readonly by: string; readonly note: string }[];
}

/** A section cut to fit: `left` of its `total` entries were left out or shortened; the whole section (`chars` characters) is in the archive `archiveId`. */
export interface HandoffCut { readonly section: string; readonly archiveId: string; readonly left: number; readonly total: number; readonly chars: number; readonly archiveTruncated?: boolean }

/** A section's original as archived when it was cut (card C07j), one part of it per read. */
export interface HandoffArchive {
  readonly archiveId: string; readonly handoffId: string; readonly taskId: string; readonly section: string;
  /** Entries (lines) and characters of the whole section; `parts` reads cover it, `text` is part `part`. */
  readonly entries: number; readonly chars: number; readonly part: number; readonly parts: number; readonly text: string;
  /** Set only when the section was longer than the archive keeps (`HANDOFF_LIMITS.archiveChars`): the parts then hold its first `archiveChars` characters. */
  readonly truncated?: boolean;
}

export const HANDOFF_LIMITS = { reason: 500, section: 4000, history: 40, advances: 8, returnDays: 30, reassign: 50, marks: 20, mark: 200, archivePart: 40_000, archiveChars: 1_000_000 } as const;
const KIND = "handoff";
const ACTIVE = "handoff-active";
/** The original of a cut section: the first part (with what it is) and, for a long one, further parts. */
const ARCHIVE = "handoff-archive";
/** The owner's marks for a task: entries holding one of them are kept when a section of its hand-off is cut. */
const MARKS = "handoff-marks";
const ARCHIVE_ID = /^hnd-[a-z2-7]{20}$/;
/** The sender's own sections, which `screen` withholds from those who merely control the task; their archives are withheld the same way. */
const PRIVATE_SECTIONS: readonly string[] = ["drafts", "responsibilities"];
/** Sections whose first line is a heading rather than the oldest entry: a cut keeps it (card C07j review). */
const HEADED_SECTIONS: readonly string[] = ["brief", "responsibilities", "unfinishedWork"];
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
  readonly #responsibilities: ResponsibilityHandover | undefined;
  readonly #asker: ((principalId: string) => Promise<Principal | undefined>) | undefined;
  readonly #onTransferred: ((by: Principal, event: { handoffId: string; taskId: string; from: Owner; to: Owner; reassigned?: TaskHandoffBody["reassigned"] }) => Promise<void>) | undefined;
  readonly #onReturnGivenUp: ((by: Principal, event: { handoffId: string; taskId: string; reason: string }) => Promise<void>) | undefined;

  private constructor(runner: CommandRunner, pauses: PauseService, stops: Pick<StopService, "request" | "advance" | "force" | "get">, assignments: Pick<AssignmentService, "getAssignment" | "transferTask">, sources: HandoffSources, onTransferred?: (by: Principal, event: { handoffId: string; taskId: string; from: Owner; to: Owner; reassigned?: TaskHandoffBody["reassigned"] }) => Promise<void>, asker?: (principalId: string) => Promise<Principal | undefined>, onReturnGivenUp?: (by: Principal, event: { handoffId: string; taskId: string; reason: string }) => Promise<void>, responsibilities?: ResponsibilityHandover) {
    this.#responsibilities = responsibilities;
    this.#onReturnGivenUp = onReturnGivenUp;
    this.#onTransferred = onTransferred;
    this.#asker = asker;
    this.#runner = runner; this.#pauses = pauses; this.#stops = stops; this.#assignments = assignments; this.#sources = sources;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: { pauses: PauseService; stops: Pick<StopService, "request" | "advance" | "force" | "get">; assignments: Pick<AssignmentService, "getAssignment" | "transferTask">; sources: HandoffSources; /** Told once a task has moved, so the move can be put in the task's activity record (best effort: a failure here never undoes or holds back the hand-off). */ onTransferred?: (by: Principal, event: { handoffId: string; taskId: string; from: Owner; to: Owner; reassigned?: TaskHandoffBody["reassigned"] }) => Promise<void>; /** The principal that asked for a hand-off, with the rights it holds now (undefined when it is gone or not active): a hand-off carried on after a restart is dropped when the asker no longer holds the right to control the task. */ asker?: (principalId: string) => Promise<Principal | undefined>; /** Told once when a temporary reassignment could not be returned (the asker lost the right, the task moved on, the hand-off back failed): best effort, so the task's activity can say why it stayed. */ onReturnGivenUp?: (by: Principal, event: { handoffId: string; taskId: string; reason: string }) => Promise<void>; /** Moves the sender's chosen responsibilities to the recipient with the task (card L03i); without it a hand-off that asks for this is refused. */ responsibilities?: ResponsibilityHandover }, options: RunnerOptions = {}): HandoffService {
    return new HandoffService(new CommandRunner(storage, epoch, options), deps.pauses, deps.stops, deps.assignments, deps.sources, deps.onTransferred, deps.asker, deps.onReturnGivenUp, deps.responsibilities);
  }

  // ---- requests ------------------------------------------------------------------------------------------------------------

  /** Begins a prepared hand-off of a task to another owner. One hand-off at a time per task. Returns where it stands after one pass. */
  async prepare(by: Principal, command: NoActor & { taskId: string; to: unknown; reason: string; deadlineMs?: number; returnAt?: string }): Promise<View<TaskHandoffBody>> {
    onlyKnown(command, ["commandId", "taskId", "to", "reason", "deadlineMs", "returnAt"]);
    const returnAt = command.returnAt === undefined ? undefined : this.#returnTime(command.returnAt);
    // The return is made later on the asker's behalf and needs their right checked then; a service that cannot look the asker up must not promise one.
    if (returnAt !== undefined && this.#asker === undefined) invalid("returnAt", "cannot be used here: this service cannot check later who asked");
    return this.#prepare(by, command, returnAt === undefined ? {} : { returnAt });
  }

  /** `returnAt` must be a time ahead, at most `HANDOFF_LIMITS.returnDays` days away; it is kept as the exact instant. */
  #returnTime(value: unknown): string {
    const when = typeof value === "string" ? Date.parse(value) : Number.NaN;
    const now = Date.parse(this.#runner.now());
    if (!Number.isFinite(when)) return invalid("returnAt", "must be a date and time");
    if (when <= now) return invalid("returnAt", "must be in the future");
    if (when > now + HANDOFF_LIMITS.returnDays * 86_400_000) return invalid("returnAt", `must be within ${HANDOFF_LIMITS.returnDays} days`);
    return new Date(when).toISOString();
  }

  async #prepare(by: Principal, command: NoActor & { taskId: string; to: unknown; reason: string; deadlineMs?: number }, extra: { returnAt?: string; autoComplete?: boolean; returnOf?: string }): Promise<View<TaskHandoffBody>> {
    const reason = plain(command.reason, "reason");
    const to = checkOwner(command.to, "to");
    const scope: PauseScope = { kind: "task", id: String(command.taskId) };
    const target = await this.#pauses.authorizeControl(by, scope);
    const { assignment, from } = await this.#currentOwner(scope.id);
    if (sameOwner(from, to)) invalid("to", "is already the owner of the task");
    const why = await this.#sources.ineligible?.(to, { taskId: scope.id });
    if (why !== undefined) throw new DomainError("invalid_command", `${to.kind}:${to.id} cannot take the task: ${why}`, { field: "to" });
    const id = derivedId("hnd", scopedCommandId(by.id, command.commandId));
    await this.#letGoEnded(by, scope.id);
    const heldBefore = (await this.#pauses.gate(by, scope))?.intent === "pause";
    // The suspension's own pause, if it makes one (the stop pauses under its command ID + "-pause", as the asker), is the hand-off's hold; any other pause is not (card L04c review 4).
    await this.#create(by, command.commandId, id, scope.id, target.projectId, from, to, assignment.generation, "prepared", reason, heldBefore, undefined, extra, { ops: [{ operationId: `${String(command.commandId)}-suspend-pause`, actor: by.id }] });
    // The same request sent again for a hand-off that already recorded its suspension, or that has ended, answers as recorded (card L04c review 5): asking for the suspension again would pause a task the hand-off
    // no longer holds (a hold nobody lifts) or take over a pause the owner set since (dropping the owner's recorded time to lift it).
    const existing = (await this.#runner.get(KIND, id))?.body as unknown as TaskHandoffBody | undefined;
    if (existing !== undefined && (existing.stopIntentId !== undefined || TERMINAL.includes(existing.phase))) return this.advance(by, { handoffId: id });
    // The suspension that prepares the hand-off. Its command ID follows the hand-off's, so repeating the request repeats it (a crash before the suspension was recorded).
    const stop = await this.#stops.request(by, { commandId: `${String(command.commandId)}-suspend`, scope, mode: "suspend", reason: `hand-off: ${reason}`.slice(0, 500), ...(command.deadlineMs === undefined ? {} : { deadlineMs: command.deadlineMs }) });
    const rec = (await this.#runner.get(KIND, id))?.body as unknown as TaskHandoffBody | undefined;
    const hold = rec === undefined || rec.holdRequestId !== undefined || rec.holdOps === undefined ? undefined : await this.#pauses.ownPause(scope, rec.holdOps);
    await this.#update(id, (b) => ({ ...b, stopIntentId: b.stopIntentId ?? stop.intentId, ...(b.holdRequestId !== undefined || hold === undefined ? {} : { holdRequestId: hold }) }), LIVE);
    return this.advance(by, { handoffId: id });
  }

  /** The caller accepts the package as it is and the task moves. Refused unless ready; an incomplete package needs `acceptGaps`, which is recorded. */
  async complete(by: Principal, command: NoActor & { handoffId: string; acceptGaps?: boolean; reassignResponsibilities?: unknown }): Promise<View<TaskHandoffBody>> {
    onlyKnown(command, ["commandId", "handoffId", "acceptGaps", "reassignResponsibilities"]);
    const ids = command.reassignResponsibilities === undefined ? [] : this.#responsibilityIds(command.reassignResponsibilities);
    const found = await this.#get(command.handoffId);
    const b = found.body as unknown as TaskHandoffBody;
    await this.#mayControl(by, b.taskId);
    // A repeat that names other responsibilities than the ones recorded would silently drop them: refused, not ignored.
    if (ids.length > 0 && (b.phase === "transferring" || b.phase === "transferred") && (b.reassign === undefined ? true : b.reassign.ids.length !== ids.length || !ids.every((x) => b.reassign!.ids.includes(x)))) invalid("reassignResponsibilities", "this hand-off was already completed with another list of responsibilities (or none); the recorded one stands");
    if (b.phase === "transferring" || b.phase === "transferred") return this.advance(by, { handoffId: command.handoffId });
    if (b.phase !== "ready") throw new DomainError("invalid_command", `the hand-off is ${b.phase}; it can be completed when it is ready`, { field: "handoffId" });
    if (ids.length > 0) {
      if (this.#responsibilities === undefined) invalid("reassignResponsibilities", "cannot be used here: this service cannot move responsibilities");
      if (b.returnAt !== undefined || b.autoComplete === true) invalid("reassignResponsibilities", "cannot be used with a temporary reassignment or its return: responsibilities are not handed back with the task");
      // Refused now, before anything moves, when an entry is not the sender's or the asker may not assign it; the right is checked again when the move is made.
      await this.#responsibilities!.check(by, { taskId: b.taskId, ids, from: b.from, to: b.to });
    }
    const missing = b.package?.missing ?? [...REQUIRED_SECTIONS];
    if (missing.length > 0 && command.acceptGaps !== true) throw new DomainError("invalid_command", `the package is missing ${missing.join(", ")}; complete it with acceptGaps to hand it over anyway`, { field: "acceptGaps" });
    const at = this.#runner.now();
    await this.#update(command.handoffId, (x) => ({ ...x, phase: "transferring", ...(ids.length === 0 ? {} : { reassign: { ids, by: by.id, at } }), ...(missing.length === 0 ? {} : { acceptedGaps: { by: by.id, missing, at } }), history: this.#push(x, "transferring", by.id, missing.length === 0 ? "package accepted" : `package accepted with gaps: ${missing.join(", ")}`) }), ["ready"]);
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
    await this.#letGoEnded(by, scope.id);
    // A prepared hand-off already under way is taken over by this one: it ends as cancelled and the takeover stands alone.
    const active = await this.#activeId(scope.id);
    // A hold the replaced hand-off had added (its suspension) is still the hand-off's to lift; a hold that was there before it stays.
    const replaced = active === undefined ? undefined : ((await this.#runner.get(KIND, active))?.body as unknown as TaskHandoffBody | undefined);
    const heldBefore = replaced !== undefined ? replaced.heldBefore : (await this.#pauses.gate(by, scope))?.intent === "pause";
    // Written as preparing: the stop, the package and the exception come next, in `advance`, and the task moves only after them.
    // The takeover's hold is its force stop's pause (whoever advances it), or the replaced hand-off's own hold, which is the takeover's to lift now. A replaced record from before holds were named passes that on.
    const legacy = replaced !== undefined && !named(replaced);
    const hold = legacy ? undefined : { ops: [{ operationId: `${id}-force-pause` }, ...(replaced?.holdOps ?? [])], ...(replaced?.holdRequestId === undefined ? {} : { requestId: replaced.holdRequestId }) };
    await this.#create(by, command.commandId, id, scope.id, target.projectId, from, to, assignment.generation, "forced", reason, heldBefore, active, {}, hold);
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
    // Only the caller whose write ended the hand-off lifts its hold (see `#letGo`).
    if (await this.#update(command.handoffId, (x) => ({ ...x, phase: "cancelled", blocked: undefined, history: this.#push(x, "cancelled", by.id, "cancelled; the old owner keeps the task") }), ["preparing", "blocked", "ready"])) await this.#letGo(by, command.handoffId);
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
        if (b.replaces !== undefined) await this.#update(b.replaces, (x) => ({ ...x, phase: "cancelled", blocked: undefined, released: this.#runner.now(), history: this.#push(x, "cancelled", by.id, "replaced by a forced takeover") }), LIVE); // its hold is the takeover's now: a sweep never lifts it for the replaced one
        // Force Stop is repeatable under this hand-off's own command ID, so a crash anywhere here is finished by the next pass.
        const stopped = await this.#stops.force(by, { commandId: `${id}-force`, scope: { kind: "task", id: b.taskId }, reason: `takeover: ${b.reason}`.slice(0, 500) });
        const collected = await this.#collect(id, b);
        const hold = b.holdRequestId !== undefined || b.holdOps === undefined ? undefined : await this.#pauses.ownPause({ kind: "task", id: b.taskId }, b.holdOps);
        await this.#update(id, (x) => ({
          ...x, stopIntentId: stopped.intentId, package: collected, phase: "transferring", ...(hold === undefined ? {} : { holdRequestId: hold }),
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
        const collected = await this.#collect(id, b);
        await this.#update(id, (x) => ({ ...x, phase: "ready", package: collected, history: this.#push(x, "ready", by.id, collected.missing.length === 0 ? "package ready" : `package incomplete: missing ${collected.missing.join(", ")}`) }), ["preparing"]);
        continue;
      }
      if (b.phase === "transferring") {
        const { assignment } = await this.#currentOwner(b.taskId).catch(() => ({ assignment: undefined, from: undefined }));
        if (assignment !== undefined && assignment.state === "assigned" && sameOwner(assignment.owner, b.to) && assignment.generation > b.generation) {
          await this.#moveResponsibilities(by, id, b);
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
        // A hand-off that ended but whose hold was never let go (the process died between the end and the lift) lets go now; only its own pause is lifted, never a later one (card L04c review).
        if (TERMINAL.includes(b.phase) && named(b) && b.released === undefined) {
          try { await this.#letGo(by, rec.id); advanced.push(rec.id); } catch { failed.push(rec.id); }
        }
        // A temporary reassignment that has run its time goes back, and a return that is ready is completed (card L03e).
        if (b.phase === "transferred" && b.returnAt !== undefined && b.returned === undefined) {
          try { if (await this.#returnDue(by, rec.id, b)) advanced.push(rec.id); } catch { failed.push(rec.id); }
          continue;
        }
        if (b.phase === "preparing" && b.autoComplete === true && b.returnOf !== undefined && b.stopIntentId === undefined) {
          try { if (await this.#finishReturn(by, rec.id, b)) advanced.push(rec.id); } catch { failed.push(rec.id); }
          continue;
        }
        if (b.phase === "blocked" && b.autoComplete === true) {
          if (b.stuckTold !== b.history[b.history.length - 1]?.at) {
            try {
              await this.#update(rec.id, (x) => ({ ...x, stuckTold: x.history[x.history.length - 1]?.at ?? "" }), ["blocked"]);
              try { await this.#onReturnGivenUp?.(by, { handoffId: rec.id, taskId: b.taskId, reason: `the hand-off back is blocked (${b.blocked?.reason ?? "preparation did not finish"}); the task stays with the temporary owner until someone decides` }); } catch { /* best effort */ }
            } catch { failed.push(rec.id); }
          }
          continue;
        }
        if (b.phase === "ready" && b.autoComplete === true) {
          try { if (await this.#completeReturn(by, rec.id, b)) advanced.push(rec.id); } catch { failed.push(rec.id); }
          continue;
        }
        if (TERMINAL.includes(b.phase) || b.phase === "ready") continue;
        try {
          // A hand-off finished after a restart is finished for whoever asked, but only while they still hold the right to control the task (owner decision 2026-10-29); otherwise it is dropped and says why.
          // Only while the task has not moved: a hand-off whose transfer already happened is finished, not judged again.
          const moved = b.phase === "transferring" && await this.#currentOwner(b.taskId).then(({ assignment }) => assignment.state === "assigned" && sameOwner(assignment.owner, b.to) && assignment.generation > b.generation, () => false);
          if (this.#asker !== undefined && !moved && !b.requestedBy.startsWith("owner")) {
            const asker = await this.#asker(b.requestedBy);
            const still = asker !== undefined && await this.#pauses.authorizeControl(asker, { kind: "task", id: b.taskId }).then(() => true, (e: unknown) => { if (e instanceof DomainError && (e.code === "forbidden" || e.code === "not_found")) return false; throw e; }); // any other failure (storage down) leaves the hand-off for the next sweep
            if (!still) { await this.#fail(by, rec.id, `${b.requestedBy} no longer holds the right to hand this task over, so the hand-off was not finished after the restart`); failed.push(rec.id); continue; }
          }
          await this.advance(by, { handoffId: rec.id }); advanced.push(rec.id);
        } catch { failed.push(rec.id); }
      }
      if (page.length < 100) break;
    }
    return { advanced, failed };
  }

  /**
   * What the caller may see of a hand-off. The sender's drafts and responsibilities are the sender's own (a draft is unreadable to anyone but its author and the owner): they are shown to the owner and the
   * sender, to the recipient once the task has been transferred, and to no one else who merely controls the task. The package then says they are withheld.
   */
  screen(by: Principal, item: View<TaskHandoffBody>): View<TaskHandoffBody> {
    const pkg = item.package;
    if (pkg === undefined || (pkg.sections["drafts"] === undefined && pkg.sections["responsibilities"] === undefined)) return item;
    if (by.kind === "owner" || by.id === `agent:${item.from.id}` || (item.phase === "transferred" && by.id === `agent:${item.to.id}`)) return item;
    const { drafts: _d, responsibilities: _r, ...rest } = pkg.sections;
    // A cut of one of them names its archive, which this caller may not read either: it is left out with them.
    const cuts = pkg.cuts?.filter((c) => !PRIVATE_SECTIONS.includes(c.section));
    const { cuts: _c, ...others } = pkg;
    return { ...item, package: { ...others, ...(cuts === undefined || cuts.length === 0 ? {} : { cuts }), sections: { ...rest, withheld: "The sender's drafts and responsibilities are shown to the sender, the owner and, after the transfer, the recipient." } } };
  }

  /** The hand-off of a task that is still going (not finished, failed or cancelled), for a caller who may control the task; undefined otherwise. */
  async forTask(by: Principal, taskId: string): Promise<View<TaskHandoffBody> | undefined> {
    const tid = checkTaskId(taskId);
    // The right to control the task is checked first, so a caller who may not learns nothing, not even that no hand-off is going.
    try { await this.#mayControl(by, tid); } catch (error) { if (error instanceof DomainError && error.code === "not_found") return undefined; throw error; }
    const id = await this.#activeId(tid);
    return id === undefined ? undefined : this.get(by, id);
  }

  async get(by: Principal, handoffId: string): Promise<View<TaskHandoffBody> | undefined> {
    const found = await this.#runner.get(KIND, String(handoffId));
    if (found === undefined) return undefined;
    // The package is for the next agent (card C07j review, round 4): the sender, and the recipient once the task is its own, read the hand-off as they read its archives, without the right to control the task.
    if (await this.#mayReadArchive(by, found.body as unknown as TaskHandoffBody, "brief")) return view<TaskHandoffBody>(found);
    return undefined;
  }

  /**
   * The hand-off a task was last handed over with, going on or finished, as the controller's own dispatcher reads it (card C07m): its ID, its phase and who it went between — nothing of the package. The
   * dispatcher names that ID in the new owner's first prompt, so the agent knows where the brief, the decisions and the next action are kept; reading them is still `get`, which asks the caller about the task.
   */
  async latestForTask(taskId: string): Promise<{ id: string; phase: HandoffPhase; from: Owner; to: Owner } | undefined> {
    const tid = checkTaskId(taskId);
    const pointer = (await this.#runner.get(ACTIVE, derivedId("hnd", `active\0${tid}`)))?.body as unknown as { handoffId?: string } | undefined;
    if (pointer?.handoffId === undefined) return undefined;
    const h = (await this.#runner.get(KIND, pointer.handoffId))?.body as unknown as TaskHandoffBody | undefined;
    return h === undefined ? undefined : { id: pointer.handoffId, phase: h.phase, from: h.from, to: h.to };
  }

  /**
   * The sections cut to fit in the latest hand-off of a task, going on or finished (card C07j review, round 4): how the owner, asking by chat about a task, finds the archive that holds what was cut once the
   * hand-off is over and the `handoff` status no longer shows it. Only the cuts whose archive the caller may read are listed; undefined when the task has had no hand-off the caller may see.
   */
  async cutsForTask(by: Principal, taskId: string): Promise<{ handoffId: string; phase: HandoffPhase; cuts: readonly HandoffCut[] } | undefined> {
    const tid = checkTaskId(taskId);
    const pointer = (await this.#runner.get(ACTIVE, derivedId("hnd", `active\0${tid}`)))?.body as unknown as { handoffId?: string } | undefined;
    if (pointer?.handoffId === undefined) return undefined;
    const h = (await this.#runner.get(KIND, pointer.handoffId))?.body as unknown as TaskHandoffBody | undefined;
    if (h === undefined) return undefined;
    // The task's own sections are the widest readable: a caller who may not read those may not see the hand-off at all. The sender's own (drafts, responsibilities) are asked for apart.
    if (!(await this.#mayReadArchive(by, h, "brief"))) return undefined;
    const privateOk = await this.#mayReadArchive(by, h, PRIVATE_SECTIONS[0]!);
    const cuts = (h.package?.cuts ?? []).filter((c) => privateOk || !PRIVATE_SECTIONS.includes(c.section));
    return { handoffId: pointer.handoffId, phase: h.phase, cuts };
  }

  /**
   * The whole of a section that was cut to fit (card C07j), by the archive its marker names, one part at a time (`part`, from 0; the answer says how many there are). Readable by the owner, by whoever may
   * control the task, and by the hand-off's sender and recipient (a credential scoped to another task cannot). Anyone else, or an archive that does not exist, reads as undefined.
   */
  async archive(by: Principal, query: { archiveId: string; part?: number }): Promise<HandoffArchive | undefined> {
    onlyKnown(query, ["archiveId", "part"]);
    const archiveId = typeof query.archiveId === "string" && ARCHIVE_ID.test(query.archiveId) ? query.archiveId : invalid("archiveId", "is not an archive ID (the cut marker names it: hnd- and 20 letters or digits)");
    const part = query.part ?? 0;
    if (!Number.isInteger(part) || part < 0) invalid("part", "must be a whole number from 0");
    const head = (await this.#runner.get(ARCHIVE, archiveId))?.body as unknown as { taskId: string; handoffId: string; section: string; digest: string; entries: number; chars: number; part: number; parts: number; text: string; truncated?: boolean } | undefined;
    if (head === undefined || head.part !== 0) return undefined;
    const h = (await this.#runner.get(KIND, head.handoffId))?.body as unknown as TaskHandoffBody | undefined;
    if (h === undefined || !(await this.#mayReadArchive(by, h, head.section))) return undefined;
    if (part >= head.parts) invalid("part", `this archive has ${head.parts} part${head.parts === 1 ? "" : "s"} (0 to ${head.parts - 1})`);
    const text = part === 0 ? head.text : ((await this.#runner.get(ARCHIVE, derivedId("hnd", `archive\0${head.handoffId}\0${head.section}\0${head.digest}\0${part}`)))?.body as unknown as { text?: string } | undefined)?.text;
    if (typeof text !== "string") throw new DomainError("unavailable", `part ${part} of archive ${archiveId} cannot be read`);
    return { archiveId, handoffId: head.handoffId, taskId: head.taskId, section: head.section, entries: head.entries, chars: head.chars, part, parts: head.parts, text, ...(head.truncated === true ? { truncated: true } : {}) };
  }

  /** The same rule as `screen`: the sender, and the recipient once the task is theirs; whoever may control the task, except for the sender's drafts and responsibilities, which only the owner and those two see. */
  async #mayReadArchive(by: Principal, h: TaskHandoffBody, section: string): Promise<boolean> {
    if (by.kind === "owner") return true;
    // A credential scoped to a task reads only that task's.
    const scoped = by.taskScope === undefined || by.taskScope.taskId === h.taskId;
    if (scoped && (by.id === `agent:${h.from.id}` || (h.phase === "transferred" && by.id === `agent:${h.to.id}`))) return true;
    if (PRIVATE_SECTIONS.includes(section)) return false;
    try { await this.#mayControl(by, h.taskId); return true; } catch (error) { if (error instanceof DomainError && error.code === "not_found") return false; throw error; }
  }

  /** The owner's marks for a task's hand-offs: an entry holding one of them is kept when a section is cut (card C07j). Readable by whoever may control the task. */
  async marks(by: Principal, query: { taskId: string }): Promise<{ taskId: string; marks: readonly string[]; revision: number }> {
    onlyKnown(query, ["taskId"]);
    const taskId = checkTaskId(query.taskId);
    await this.#mayControl(by, taskId);
    const ref = HandoffService.#marksRef(taskId);
    const found = await this.#runner.get(ref.kind, ref.id);
    return { taskId, marks: await this.#marks(taskId), revision: found?.revision ?? 0 };
  }

  /**
   * The owner marks what a task's hand-offs must keep when a section is cut (card C07j): `add` names words or record IDs (an entry holding one, in any case, is kept before the most recent ones), `remove`
   * takes marks off by their words. Owner only; at most `HANDOFF_LIMITS.marks` marks of 3 to `HANDOFF_LIMITS.mark` characters each, one line each, no credentials. It applies from the next package collected.
   */
  async mark(by: Principal, command: NoActor & { taskId: string; add?: unknown; remove?: unknown }): Promise<{ taskId: string; marks: readonly string[]; revision: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "add", "remove"]);
    if (by.kind !== "owner") throw new DomainError("forbidden", "only the owner marks what a task's hand-offs keep");
    const taskId = checkTaskId(command.taskId);
    await this.#pauses.authorizeControl(by, { kind: "task", id: taskId });
    const list = (value: unknown, field: string): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > HANDOFF_LIMITS.marks) return invalid(field, `must be a list of at most ${HANDOFF_LIMITS.marks} marks`);
      return value.map((v, i) => {
        const t = text(v, `${field}[${i}]`, { min: 3, max: HANDOFF_LIMITS.mark }).trim();
        if (t.length < 3) invalid(`${field}[${i}]`, "must be at least 3 characters besides spaces");
        return redactText(t) !== t ? invalid(`${field}[${i}]`, "looks like a credential or key; those are not recorded") : t;
      });
    };
    const add = list(command.add, "add"); const remove = list(command.remove, "remove");
    if (add.length === 0 && remove.length === 0) invalid("add", "name at least one mark to add or remove");
    const lower = (x: string): string => x.toLowerCase();
    const ref = HandoffService.#marksRef(taskId);
    // Two changes at once meet a revision check; the loser reads the marks again and applies its change to them.
    const apply = () => this.#runner.command("handoff.mark", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, add, remove },
      build: async () => {
        const old = await this.#runner.get(ref.kind, ref.id);
        const current = Array.isArray((old?.body as { marks?: unknown } | undefined)?.marks) ? ((old!.body as { marks: string[] }).marks) : [];
        const unknown = remove.filter((r) => !current.some((m) => lower(m) === lower(r)));
        if (unknown.length > 0) invalid("remove", `${unknown.map((u) => JSON.stringify(u)).join(", ")} ${unknown.length === 1 ? "is not a mark" : "are not marks"} of this task; its marks are ${current.length === 0 ? "none" : current.map((m) => JSON.stringify(m)).join(", ")}`);
        const next = current.filter((m) => !remove.some((r) => lower(r) === lower(m)));
        for (const a of add) if (!next.some((m) => lower(m) === lower(a))) next.push(a);
        if (next.length > HANDOFF_LIMITS.marks) invalid("add", `a task keeps at most ${HANDOFF_LIMITS.marks} marks; remove some first`);
        const body = clean({ taskId, marks: next, by: by.id, at: this.#runner.now() });
        return { ref, creates: old === undefined, changes: [old === undefined ? { type: "create" as const, ref, body } : { type: "update" as const, ref, expectedRevision: old.revision, body }], detail: { taskId, marks: next.length } };
      },
    }));
    let run: Awaited<ReturnType<typeof apply>>;
    for (let attempt = 1; ; attempt++) {
      try { run = await apply(); break; } catch (error) { if (!(error instanceof DomainError) || error.code !== "stale_revision" || attempt >= 6) throw error; }
    }
    const now = await this.marks(by, { taskId });
    return { ...now, revision: run.revision, replayed: run.replayed };
  }

  // ---- internals -----------------------------------------------------------------------------------------------------------

  async #mayControl(by: Principal, taskId: string): Promise<void> {
    try { await this.#pauses.authorizeControl(by, { kind: "task", id: taskId }); } catch (error) { if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) throw new DomainError("not_found", "no such hand-off"); throw error; }
  }

  /** The principal to act as for a hand-off back: the one who asked for the first, if it is still active and still holds the right to control the task; otherwise the reason it cannot be. Without an asker lookup, the caller. */
  async #actingFor(by: Principal, requestedBy: string, taskId: string): Promise<Principal | string> {
    if (this.#asker === undefined) return by;
    const asker = await this.#asker(requestedBy);
    if (asker === undefined) return `${requestedBy} is gone or no longer active`;
    const still = await this.#pauses.authorizeControl(asker, { kind: "task", id: taskId }).then(() => true, (e: unknown) => { if (e instanceof DomainError && (e.code === "forbidden" || e.code === "not_found")) return false; throw e; });
    return still ? asker : `${requestedBy} no longer holds the right to control the task`;
  }

  async #giveUpReturn(by: Principal, id: string, taskId: string, reason: string): Promise<void> {
    await this.#update(id, (x) => ({ ...x, returned: { at: this.#runner.now(), skipped: reason.slice(0, 300) } }), ["transferred"]);
    try { await this.#onReturnGivenUp?.(by, { handoffId: id, taskId, reason }); } catch { /* telling the task's record is best effort */ }
  }

  /** Makes the hand-off back once the time is up, if the temporary owner still has the task and the one who asked still may. Repeating it finds the same hand-off back (its command ID follows this one's). */
  async #returnDue(by: Principal, id: string, b: TaskHandoffBody): Promise<boolean> {
    if (Date.parse(b.returnAt as string) > Date.parse(this.#runner.now())) return false;
    // A crash after the hand-off back was made but before it was written here: find it by its command ID instead of judging the task again. One made but never given its suspension (the crash fell between the two) is finished first.
    for (const who of new Set([b.requestedBy, by.id])) {
      const back = derivedId("hnd", scopedCommandId(who, `ret-${id}`));
      const found = (await this.#runner.get(KIND, back))?.body as unknown as TaskHandoffBody | undefined;
      if (found === undefined) continue;
      if (found.phase === "preparing" && found.stopIntentId === undefined) await this.#finishReturn(by, back, found);
      await this.#update(id, (x) => ({ ...x, returned: { handoffId: back, at: this.#runner.now() } }), ["transferred"]);
      return true;
    }
    const { assignment } = await this.#currentOwner(b.taskId).catch(() => ({ assignment: undefined, from: undefined }));
    if (assignment === undefined || assignment.state !== "assigned" || !sameOwner(assignment.owner, b.to) || assignment.generation !== b.generation + 1) { await this.#giveUpReturn(by, id, b.taskId, "the task has changed hands since the temporary reassignment, so nothing was returned"); return true; }
    const acting = await this.#actingFor(by, b.requestedBy, b.taskId);
    if (typeof acting === "string") { await this.#giveUpReturn(by, id, b.taskId, `${acting}, so the task stays with the temporary owner`); return true; }
    try {
      await this.#prepare(acting, { commandId: `ret-${id}`, taskId: b.taskId, to: b.from, reason: "temporary reassignment ended" }, { autoComplete: true, returnOf: id });
    } catch (error) {
      // The first owner cannot take the task back (retired, ineligible): that will not change by trying again, so it is given up with the reason. Anything else (another hand-off in progress, storage) is tried again on the next sweep.
      if (error instanceof DomainError && error.field === "to") { await this.#giveUpReturn(by, id, b.taskId, `the first owner cannot take the task back (${error.message}), so it stays with the temporary owner`); return true; }
      throw error;
    }
    await this.#update(id, (x) => ({ ...x, returned: { handoffId: derivedId("hnd", scopedCommandId(acting.id, `ret-${id}`)), at: this.#runner.now() } }), ["transferred"]);
    return true;
  }

  /** A hand-off back that a crash left without its suspension is finished (or ended, if it can no longer be made) from its own record, whichever of the sweep's paths reaches it first. */
  async #finishReturn(by: Principal, id: string, b: TaskHandoffBody): Promise<boolean> {
    const acting = await this.#actingFor(by, b.requestedBy, b.taskId);
    if (typeof acting === "string") { await this.#fail(by, id, `${acting}, so the task was not returned`); return true; }
    try {
      await this.#prepare(acting, { commandId: `ret-${b.returnOf}`, taskId: b.taskId, to: b.to, reason: "temporary reassignment ended" }, { autoComplete: true, returnOf: b.returnOf! });
    } catch (error) {
      if (error instanceof DomainError && error.field === "to") { await this.#fail(by, id, `the first owner cannot take the task back (${error.message}), so it stays with the temporary owner`); return true; }
      throw error;
    }
    return true;
  }

  /** A return that is ready is completed for the one who asked, accepting gaps in the package (recorded). If they no longer hold the right, it ends failed and says why. */
  async #completeReturn(by: Principal, id: string, b: TaskHandoffBody): Promise<boolean> {
    const acting = await this.#actingFor(by, b.requestedBy, b.taskId);
    if (typeof acting === "string") { await this.#fail(by, id, `${acting}, so the task was not returned`); return true; }
    await this.complete(acting, { commandId: `rc-${id}`, handoffId: id, acceptGaps: true });
    return true;
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

  /**
   * The package. Only the named sections travel, with credentials removed; anything else a source returned is dropped. A section over the limit is never cut silently (card C07j): its original is archived
   * first, then it keeps the entries the owner marked and the most recent ones, under a marker naming the archive. A line that reads like a marker is quoted, so the only marker is the controller's.
   */
  async #collect(handoffId: string, b: Pick<TaskHandoffBody, "taskId" | "projectId" | "from" | "to">): Promise<NonNullable<TaskHandoffBody["package"]>> {
    let got: Awaited<ReturnType<HandoffSources["collect"]>>;
    try { got = await this.#sources.collect({ taskId: b.taskId, from: b.from, to: b.to }); } catch { got = { sections: {} }; }
    const sections: Record<string, string> = {};
    const cuts: HandoffCut[] = [];
    let marks: readonly string[] | undefined;
    for (const name of HANDOFF_SECTIONS) {
      const value = got.sections[name];
      if (typeof value !== "string" || value.trim().length === 0) continue;
      // Redacted whole, before any cut, so a credential is never split into pieces the redaction would not know.
      const original = wellFormed(redactText(value));
      const shown = original.split("\n").map(neutralise).join("\n");
      if (shown.length <= HANDOFF_LIMITS.section) { sections[name] = shown; continue; }
      marks ??= await this.#marks(b.taskId);
      const archived = await this.#archive(handoffId, b, name, original);
      // A brief's title and the line saying what the responsibilities are and how to move them head their sections and stay with them; marks are looked for in the lines as the source wrote them.
      const cut = cutSection(shown, HANDOFF_LIMITS.section, marks, archived.archiveId, archived.truncated ? archived.chars : undefined, { heading: HEADED_SECTIONS.includes(name), matchOn: original.split("\n") });
      sections[name] = cut.text;
      cuts.push({ section: name, archiveId: archived.archiveId, left: cut.cut?.left ?? 0, total: cut.cut?.total ?? 0, chars: original.length, ...(archived.truncated ? { archiveTruncated: true } : {}) });
    }
    const missing = REQUIRED_SECTIONS.filter((s) => sections[s] === undefined);
    return { collectedAt: this.#runner.now(), sections, missing, ready: missing.length === 0, ...(cuts.length === 0 ? {} : { cuts }) };
  }

  /**
   * Keeps the whole of a section before it is cut, in parts that each fit a record, named by the hand-off, the section and its content: collecting the same package again (after a crash) finds the same
   * archive. Written before the cut package is, so a package never names an archive that does not exist.
   */
  async #archive(handoffId: string, b: Pick<TaskHandoffBody, "taskId" | "projectId">, section: string, original: string): Promise<{ archiveId: string; truncated: boolean; chars: number }> {
    const digest = createHash("sha256").update(original).digest("hex");
    const base = `archive\0${handoffId}\0${section}\0${digest}`;
    const head: AggregateRef = { kind: ARCHIVE, id: derivedId("hnd", base) };
    const kept = safeSlice(original, HANDOFF_LIMITS.archiveChars);
    const truncated = kept.length < original.length;
    if ((await this.#runner.get(head.kind, head.id)) !== undefined) return { archiveId: head.id, truncated, chars: kept.length };
    // Each part ends on a whole character (never between the halves of a surrogate pair), so every part is valid text in every store and the parts joined are the original.
    const parts: string[] = [];
    for (let at = 0; at < kept.length || parts.length === 0;) { const piece = safeSlice(kept.slice(at, at + HANDOFF_LIMITS.archivePart + 1), HANDOFF_LIMITS.archivePart); parts.push(piece); at += piece.length; }
    const entries = original.split("\n").length;
    const changes = parts.map((text, i) => ({
      type: "create" as const, ref: i === 0 ? head : { kind: ARCHIVE, id: derivedId("hnd", `${base}\0${i}`) },
      body: clean(i === 0 ? { taskId: b.taskId, ...(b.projectId === undefined ? {} : { projectId: b.projectId }), handoffId, section, digest, entries, chars: original.length, part: 0, parts: parts.length, text, ...(truncated ? { truncated: true } : {}) } : { head: head.id, taskId: b.taskId, part: i, text }),
    }));
    await this.#runner.command("handoff.archive", { commandId: `hnd-arc-${head.id.slice(4)}`, actor: "system" }, async () => ({
      payload: { handoffId, section, digest },
      build: async () => ({ ref: head, creates: true, changes, detail: { section, parts: parts.length } }),
    }));
    return { archiveId: head.id, truncated, chars: kept.length };
  }

  static #marksRef = (taskId: string): AggregateRef => ({ kind: MARKS, id: derivedId("hnd", `marks\0${taskId}`) });

  async #marks(taskId: string): Promise<readonly string[]> {
    const ref = HandoffService.#marksRef(taskId);
    const found = (await this.#runner.get(ref.kind, ref.id))?.body as unknown as { marks?: unknown } | undefined;
    return Array.isArray(found?.marks) ? found.marks.filter((m): m is string => typeof m === "string") : [];
  }

  async #create(by: Principal, commandId: unknown, id: string, taskId: string, projectId: string | undefined, from: Owner, to: Owner, generation: number, mode: "prepared" | "forced", reason: string, heldBefore: boolean, replaces?: string, extra: { returnAt?: string; autoComplete?: boolean; returnOf?: string } = {}, hold?: { ops: NonNullable<TaskHandoffBody["holdOps"]>; requestId?: string }): Promise<void> {
    const activeRef: AggregateRef = { kind: ACTIVE, id: derivedId("hnd", `active\0${taskId}`) };
    await this.#runner.command("handoff.create", { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { taskId, to: to as unknown as JsonObject, mode, reason, ...(extra.returnAt === undefined ? {} : { returnAt: extra.returnAt }), ...(extra.autoComplete === true ? { autoComplete: true } : {}) },
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
          taskId, ...(projectId === undefined ? {} : { projectId }), from, to, generation, phase: "preparing", mode, reason, requestedBy: by.id, requestedAt: at, heldBefore, ...(replaces === undefined ? {} : { replaces }), ...(extra.returnAt === undefined ? {} : { returnAt: extra.returnAt }), ...(extra.autoComplete === true ? { autoComplete: true } : {}), ...(extra.returnOf === undefined ? {} : { returnOf: extra.returnOf }),
          ...(hold === undefined ? {} : { holdOps: hold.ops, ...(hold.requestId === undefined ? {} : { holdRequestId: hold.requestId }) }),
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
    const before = (await this.#runner.get(KIND, id))?.body as unknown as TaskHandoffBody | undefined;
    const changed = await this.#update(id, (x) => ({ ...x, phase: "failed", blocked: undefined, failure: why, history: this.#push(x, "failed", by.id, why) }), LIVE);
    // Told even when the lift fails (the sweep lifts it later): only this caller ended the hand-off, so nobody else would tell it.
    try { if (changed) await this.#letGo(by, id); } finally {
      if (changed && before?.autoComplete === true) { try { await this.#onReturnGivenUp?.(by, { handoffId: id, taskId: before.taskId, reason: `the hand-off back failed: ${why}` }); } catch { /* best effort */ } }
    }
  }

  #responsibilityIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > HANDOFF_LIMITS.reassign) return invalid("reassignResponsibilities", `must be a list of at most ${HANDOFF_LIMITS.reassign} responsibility IDs`);
    return [...new Set(value.map((v, i) => text(v, `reassignResponsibilities[${i}]`, { min: 1, max: 100 })))];
  }

  /** Carried out once the task has moved and before the hand-off is marked done, so a restart in between repeats it (it is repeatable) and the result is recorded in the hand-off. */
  async #moveResponsibilities(by: Principal, id: string, b: TaskHandoffBody): Promise<void> {
    if (b.reassign === undefined || b.reassigned !== undefined || this.#responsibilities === undefined) return;
    const asker = this.#asker === undefined ? by : await this.#asker(b.reassign.by);
    let result: { moved: readonly string[]; failed: readonly { id: string; reason: string }[] };
    try { result = await this.#responsibilities.apply(asker, { handoffId: id, ids: b.reassign.ids, from: b.from, to: b.to }); }
    // A refusal of the whole step is a final answer for every entry; anything else (storage busy, I/O) is thrown, so the hand-off stays in transferring and the next pass or sweep repeats the step.
    catch (error) { if (!(error instanceof DomainError)) throw error; result = { moved: [], failed: b.reassign.ids.map((rid) => ({ id: rid, reason: error.message.slice(0, 200) })) }; }
    const at = this.#runner.now();
    await this.#update(id, (x) => ({ ...x, reassigned: { at, moved: [...result.moved], failed: result.failed.map((f) => ({ id: f.id, reason: redactText(f.reason).slice(0, 200) })) }, history: this.#push(x, "transferring", by.id, `responsibilities moved with the task: ${result.moved.length} moved, ${result.failed.length} left with ${b.from.id}`) }), ["transferring"]);
  }

  /** The task moved: the new owner may run, so a hold this hand-off added is lifted. */
  async #finish(by: Principal, id: string, b: TaskHandoffBody): Promise<void> {
    // Another caller finished it first (a sweep or an advance that raced this one): that caller told the move and lifted the hold; this one does neither (see `#letGo`).
    if (!(await this.#update(id, (x) => ({ ...x, phase: "transferred", transferredAt: this.#runner.now(), history: this.#push(x, "transferred", by.id, `now owned by ${b.to.kind}:${b.to.id}`) }), ["transferring"]))) return;
    const reassigned = ((await this.#runner.get(KIND, id))?.body as unknown as TaskHandoffBody | undefined)?.reassigned;
    try { await this.#onTransferred?.(by, { handoffId: id, taskId: b.taskId, from: b.from, to: b.to, ...(reassigned === undefined ? {} : { reassigned }) }); } catch { /* the record of the move is best effort */ }
    await this.#letGo(by, id);
  }

  /**
   * Lifts the hold the hand-off added. Called only by the caller whose write ended the hand-off (card L04c review): the lift's command ID is scoped by its caller, so a second caller that also got here (one that
   * lost the race to end it) would record a second lift under its own ID, and when the owner had paused the task again in between, that lift would take the owner's own pause away.
   */
  async #letGo(by: Principal, id: string): Promise<void> {
    const b = (await this.#runner.get(KIND, id))?.body as unknown as TaskHandoffBody | undefined;
    if (b === undefined || (!named(b) && b.heldBefore)) return;
    const scope: PauseScope = { kind: "task", id: b.taskId };
    const reason = b.phase === "transferred" ? "hand-off complete" : "hand-off ended";
    const gate = await this.#pauses.gateState(scope);
    if (gate?.intent === "pause") {
      try {
        // A hand-off recorded before the hold was named lifts any pause, as before.
        if (!named(b)) await this.#pauses.resume(by, { commandId: `${id}-resume`, scope, reason });
        else {
          // Only the pause this hand-off holds the task with is lifted, checked in the same write as the lift: a pause set before or after it (the owner's) stands.
          const own = gate.requestId !== undefined && gate.requestId === b.holdRequestId ? gate.requestId : await this.#pauses.ownPause(scope, b.holdOps ?? []);
          if (own !== undefined) await this.#pauses.resumeOwnHold(by, { commandId: `${id}-resume`, scope, reason, requestId: own });
        }
      } catch (error) {
        // A refusal (not paused, or held by a later pause) means the hold is gone or not this hand-off's to lift. Any other failure of a hand-off that names its hold (storage unavailable, the caller's right) is thrown
        // before `released` is written, so the sweep or the next hand-off lifts it later (card L04c review 5); writing `released` here would leave the task paused for good.
        if (!(error instanceof DomainError) || (named(b) && error.code !== "invalid_command")) throw error;
      }
    }
    if (named(b) && b.released === undefined) await this.#update(id, (x) => ({ ...x, released: this.#runner.now() }), TERMINAL);
  }

  /**
   * The task's last hand-off ended but has not let go of its hold yet (the process died between the end and the lift): it lets go before another hand-off of the task begins, so the next one's suspension takes a
   * hold of its own instead of finding the old one there (as "held before") and losing it to a later sweep while it relies on it (card L04c review 4).
   */
  async #letGoEnded(by: Principal, taskId: string): Promise<void> {
    const pointer = (await this.#runner.get(ACTIVE, derivedId("hnd", `active\0${taskId}`)))?.body as unknown as { handoffId?: string } | undefined;
    if (pointer?.handoffId === undefined) return;
    const b = (await this.#runner.get(KIND, pointer.handoffId))?.body as unknown as TaskHandoffBody | undefined;
    if (b !== undefined && TERMINAL.includes(b.phase) && named(b) && b.released === undefined) await this.#letGo(by, pointer.handoffId);
  }
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

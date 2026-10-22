import type { AssignmentService } from "../domain/assignments.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { WaitBody, WaitService } from "../domain/waits.js";
import type { HistoryService } from "../context/histories.js";
import type { RetrievalService, SourceRef } from "../context/retrieval.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

export type InquiryState = "open" | "answered" | "closed" | "cancelled";

export interface InquiryBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly asker: string;
  readonly to: string;
  readonly question: string;
  /** The side chat that carries the conversation. It is not the task's history. */
  readonly scopeId: string;
  /** Names this inquiry in every message about it (the inquiry's own ID). */
  readonly correlationId: string;
  /** The asker's assignment generation when it asked, so a later reader can tell whether the asking attempt is still the current one. */
  readonly generation?: number;
  readonly contextRefs: readonly SourceRef[];
  /** A typed wait (S08) the main attempt is blocked in, answered together with the inquiry. */
  readonly waitId?: string;
  readonly state: InquiryState;
  readonly askedAt: string;
  readonly answer?: string;
  readonly answeredBy?: string;
  readonly answeredAt?: string;
  readonly closedAt?: string;
  readonly cancelledBy?: string;
  readonly cancelReason?: string;
}

export interface Ask extends NoActor {
  readonly taskId: string;
  readonly to: string;
  readonly question: string;
  /** Things the responder may want to read. The asker must be able to read each; the responder sees only those it can read itself. */
  readonly contextRefs?: readonly SourceRef[];
  /** An open `inquiry` wait on this task, whose resolver is `to`: it is answered when the inquiry is. */
  readonly waitId?: string;
}

export interface ContextItem {
  readonly source: SourceRef;
  /** `unavailable`: gone, or not readable by this viewer (the two are not told apart). */
  readonly state: "available" | "unavailable";
  readonly text?: string;
}

export interface InquiryView {
  readonly inquiry: View<InquiryBody>;
  /** Whether the task's assignment is still at the generation it had when the question was asked (it has not been released, transferred or reassigned since). It does not say the asker owned it. */
  readonly generationUnchanged: boolean;
  /** The context resolved for this viewer only. */
  readonly context: readonly ContextItem[];
}

export const INQUIRY_LIMITS = { question: 4000, answer: 4000, refs: 10, openPerTask: 10, reason: 500, page: 100 } as const;
const counterIdOf = (taskId: string, asker: string): string => `ic:${taskId}:${asker}`;
const INQUIRY_ID = /^inq-[a-z2-7]{20}$/;
const PRINCIPAL = /^(?:owner|agent|host):[a-z0-9][a-z0-9-]{0,39}$/;
const WAIT_ID = /^wait-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const plain = (value: unknown, field: string, max: number): string => {
  const out = text(value, field, { min: 1, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded");
  return out;
};

/**
 * Durable inquiries (card H04): a question from one principal working on a task to another, carried in a **side chat** (card C01) so it never enters the task's history, answered by the
 * addressee only, and acknowledged by the asker. The inquiry has its own ID, which is the correlation in every message about it, and it is a durable record, so an answer arriving after a
 * restart finds its question. It never touches the task's assignment: asking, waiting and answering move no ownership, and the asking attempt stays the owner throughout.
 *
 * When the main attempt is blocked waiting for the answer (a typed wait of reason `inquiry`, S08), the inquiry is linked to that wait and answering the inquiry answers the wait. The steps
 * of an answer (record, chat entry, wait) each use a command ID derived from the inquiry, so repeating `answer` after a crash completes whatever is missing and nothing is done twice.
 *
 * Context is not copied into the question: the inquiry carries links, and each viewer sees only what that viewer may read.
 */
export class InquiryService {
  readonly #runner: CommandRunner;
  readonly #histories: HistoryService;
  readonly #retrieval: RetrievalService;
  readonly #waits: WaitService;
  readonly #assignments: AssignmentService;

  private constructor(runner: CommandRunner, deps: { histories: HistoryService; retrieval: RetrievalService; waits: WaitService; assignments: AssignmentService }) {
    this.#runner = runner;
    this.#histories = deps.histories;
    this.#retrieval = deps.retrieval;
    this.#waits = deps.waits;
    this.#assignments = deps.assignments;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: { histories: HistoryService; retrieval: RetrievalService; waits: WaitService; assignments: AssignmentService }, options: RunnerOptions = {}): InquiryService {
    return new InquiryService(new CommandRunner(storage, epoch, options), deps);
  }

  /** Asks `to` a question about a task. The asker must be working on the task (`attempt.work` for it). */
  async ask(asker: Principal, command: Ask): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "to", "question", "contextRefs", "waitId"]);
    const taskId = checkTaskId(command.taskId);
    const to = typeof command.to === "string" && PRINCIPAL.test(command.to) ? command.to : invalid("to", "is not a principal ID");
    const question = plain(command.question, "question", INQUIRY_LIMITS.question);
    const refs = command.contextRefs ?? [];
    if (!Array.isArray(refs) || refs.length > INQUIRY_LIMITS.refs) invalid("contextRefs", `must be a list of at most ${INQUIRY_LIMITS.refs} links`);
    const waitId = command.waitId === undefined ? undefined : (typeof command.waitId === "string" && WAIT_ID.test(command.waitId) ? command.waitId : invalid("waitId", "is not a wait ID"));
    const task = await this.#runner.get("task", taskId);
    const projectId = (task?.body as unknown as TaskBody | undefined)?.projectId;
    // A task the asker may not work on reads exactly like one that does not exist.
    if (projectId === undefined || !allows(asker, "attempt.work", projectId, { resource: { kind: "task", id: taskId } })) throw new DomainError("forbidden", `${asker.id} may not ask about that task`);
    if (to === asker.id) invalid("to", "cannot be the asker");
    const id = derivedId("inq", scopedCommandId(asker.id, command.commandId));
    const contextRefs: SourceRef[] = [];
    for (const [i, ref] of refs.entries()) {
      // The asker may attach only what the asker can read.
      const original = await this.#retrieval.fetch(asker, ref);
      if (original === undefined || original.projectId !== projectId) invalid(`contextRefs[${i}]`, "must be readable by the asker and belong to the task's project");
      contextRefs.push(ref);
    }
    if (waitId !== undefined) await this.#checkWait(waitId, taskId, to);

    // Checked before anything is created, so a refused inquiry normally leaves no chat behind. The count itself is kept in a record that the asking step updates under a revision check,
    // so two asks at once cannot both take the last place; in that rare race the loser's empty chat is left behind.
    if (((await this.#counter(taskId, asker.id)).open) >= INQUIRY_LIMITS.openPerTask) throw new DomainError("unavailable", `${asker.id} already has ${INQUIRY_LIMITS.openPerTask} open inquiries about this task; wait for answers or cancel some`);
    // 1. The side chat (idempotent by the inquiry's own ID), 2. the record, 3. the question as the chat's first entry (idempotent too).
    const chat = await this.#histories.openScope(asker, { commandId: `${id}-chat`, type: "chat", projectId, taskId, participants: [to] });
    const result = await this.#retrying(() => this.#runner.command("inquiry.ask", { commandId: scopedCommandId(asker.id, command.commandId), actor: asker.id }, async () => ({
      payload: { taskId, to, question, scopeId: chat.id, contextRefs: contextRefs as unknown as JsonObject[], ...(waitId === undefined ? {} : { waitId }) },
      build: async () => {
        const counter = await this.#counter(taskId, asker.id);
        if (counter.open >= INQUIRY_LIMITS.openPerTask) throw new DomainError("unavailable", `${asker.id} already has ${INQUIRY_LIMITS.openPerTask} open inquiries about this task; wait for answers or cancel some`);
        const assignment = await this.#assignments.getAssignment(taskId);
        const ref: AggregateRef = { kind: "inquiry", id };
        const body: InquiryBody = {
          taskId, projectId, asker: asker.id, to, question, scopeId: chat.id, correlationId: id,
          ...(assignment === undefined || assignment.state !== "assigned" ? {} : { generation: assignment.generation }),
          contextRefs, ...(waitId === undefined ? {} : { waitId }), state: "open", askedAt: this.#runner.now(),
        };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }, this.#bump(counter, taskId, asker.id, +1)], detail: { taskId, to, correlationId: id } };
      },
    })));
    await this.#histories.append(asker, chat.id, { commandId: `${id}-q`, text: question });
    return { id: result.id, replayed: result.replayed };
  }

  /**
   * The addressee answers. The answer is recorded, added to the side chat, and, if the main attempt waits on it, answers that wait. If the call dies part-way, repeating it finishes whatever
   * step is missing: with the same command ID the record step replays, and with any other command ID the same responder giving the same answer to an inquiry already answered by it is taken as
   * the repeat. Only the addressee can answer; an inquiry that is no longer open (and was not answered by this responder with this answer) cannot be answered.
   */
  async answer(responder: Principal, command: NoActor & { inquiryId: string; answer: string }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "inquiryId", "answer"]);
    const id = this.#id(command.inquiryId);
    const answer = plain(command.answer, "answer", INQUIRY_LIMITS.answer);
    const first = await this.#runner.get("inquiry", id);
    const found = (first?.body as unknown as InquiryBody | undefined);
    // Not yours, not there, or not open: one refusal for the first two.
    if (found === undefined || found.to !== responder.id || !allows(responder, "history.append", found.projectId)) throw new DomainError("forbidden", `${responder.id} may not answer that inquiry`);
    // Already answered by this responder with this very answer (an earlier call died after the record step, and this retry may carry a different command ID; the asker may even have closed it meanwhile): finish the missing steps.
    const finishing = (found.state === "answered" || found.state === "closed") && found.answeredBy === responder.id && found.answer === answer;
    const result = finishing ? { id, replayed: true } : await this.#retrying(() => this.#runner.command("inquiry.answer", { commandId: scopedCommandId(responder.id, command.commandId), actor: responder.id }, async () => ({
      payload: { inquiryId: id, answer },
      build: async () => {
        const current = await this.#runner.get("inquiry", id);
        const body = current?.body as unknown as InquiryBody | undefined;
        if (current === undefined || body === undefined) throw new DomainError("not_found", `inquiry ${id} does not exist`);
        if (body.state !== "open") throw new DomainError("invalid_command", `inquiry ${id} is ${body.state}; it can be answered only while open`, { field: "inquiryId" });
        const ref: AggregateRef = { kind: "inquiry", id };
        const next: InquiryBody = { ...body, state: "answered", answer, answeredBy: responder.id, answeredAt: this.#runner.now() };
        const change: Change = { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref, creates: false, changes: [change, this.#bump(await this.#counter(body.taskId, body.asker), body.taskId, body.asker, -1)], detail: { correlationId: id, answeredBy: responder.id } };
      },
    })));
    // The remaining steps use command IDs derived from the inquiry, so a repeat of this call (or of any of them) does each only once.
    await this.#histories.append(responder, found.scopeId, { commandId: `${id}-a`, text: answer });
    if (found.waitId !== undefined) await this.#answerWait(found.waitId, responder, answer, id);
    return { id, replayed: result.replayed };
  }

  /** The asker acknowledges the answer: the inquiry is complete. */
  close(asker: Principal, command: NoActor & { inquiryId: string; expectedRevision: number }): Promise<void> {
    return this.#finish(asker, "inquiry.close", command, "closed", undefined);
  }

  /** The asker (or the owner) withdraws an open inquiry. Any wait the main attempt has on it is the caller's to cancel or resume (the task's disposition is not decided here). */
  cancel(principal: Principal, command: NoActor & { inquiryId: string; expectedRevision: number; reason: string }): Promise<void> {
    return this.#finish(principal, "inquiry.cancel", command, "cancelled", command.reason);
  }

  /** The inquiry as this viewer may see it. Only the asker, the addressee and the owner can see it; anyone else gets `undefined`, as for an inquiry that does not exist. */
  async view(viewer: Principal, inquiryId: string): Promise<InquiryView | undefined> {
    const found = typeof inquiryId === "string" && INQUIRY_ID.test(inquiryId) ? await this.#runner.get("inquiry", inquiryId) : undefined;
    if (found === undefined) return undefined;
    const inquiry = view<InquiryBody>(found);
    if (viewer.kind !== "owner" && viewer.id !== inquiry.asker && viewer.id !== inquiry.to) return undefined;
    const context: ContextItem[] = [];
    for (const source of inquiry.contextRefs) {
      const original = await this.#retrieval.fetch(viewer, source);
      context.push(original === undefined ? { source, state: "unavailable" } : { source, state: "available", text: original.text });
    }
    const assignment = await this.#assignments.getAssignment(inquiry.taskId);
    return { inquiry, generationUnchanged: assignment !== undefined && assignment.state === "assigned" && inquiry.generation !== undefined && assignment.generation === inquiry.generation, context };
  }

  /** Inquiries waiting for this principal to answer, oldest ID first, paged. */
  async pendingFor(principal: Principal, page: { afterId?: string; limit?: number } = {}): Promise<{ items: View<InquiryBody>[]; next?: string }> {
    const limit = page.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > INQUIRY_LIMITS.page) invalid("limit", `must be a whole number from 1 to ${INQUIRY_LIMITS.page}`);
    const items: View<InquiryBody>[] = [];
    let after = page.afterId;
    for (let reads = 0; reads < 20; reads++) {
      const chunk = await this.#runner.list("inquiry", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of chunk) {
        after = a.id;
        const b = a.body as unknown as InquiryBody;
        if (b.state !== "open" || (principal.kind !== "owner" && (b.to !== principal.id || !inTaskScope(principal, b.projectId)))) continue;
        items.push(view<InquiryBody>(a));
        if (items.length >= limit) return { items, next: a.id };
      }
      if (chunk.length < 200) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  #id(value: unknown): string {
    return typeof value === "string" && INQUIRY_ID.test(value) ? value : invalid("inquiryId", "is not an inquiry ID");
  }

  async #finish(principal: Principal, type: string, command: NoActor & { inquiryId: string; expectedRevision: number; reason?: string }, to: "closed" | "cancelled", reasonValue: string | undefined): Promise<void> {
    onlyKnown(command, ["commandId", "inquiryId", "expectedRevision", "reason"]);
    const id = this.#id(command.inquiryId);
    const expected = checkRevision(command.expectedRevision);
    const reason = to === "cancelled" ? plain(reasonValue, "reason", INQUIRY_LIMITS.reason) : undefined;
    await this.#runner.command(type, { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => ({
      payload: { inquiryId: id, expectedRevision: expected, ...(reason === undefined ? {} : { reason }) },
      build: async () => {
        const current = await this.#runner.get("inquiry", id);
        const body = current?.body as unknown as InquiryBody | undefined;
        // Only the asker (or, to withdraw, the owner) may; anyone else, and a missing inquiry, get the same refusal.
        const allowed = body !== undefined && ((principal.id === body.asker && inTaskScope(principal, body.projectId)) || (to === "cancelled" && principal.kind === "owner"));
        if (current === undefined || body === undefined || !allowed) throw new DomainError("forbidden", `${principal.id} may not ${to === "closed" ? "close" : "cancel"} that inquiry`);
        if (current.revision !== expected) throw new DomainError("stale_revision", `inquiry ${id} is at revision ${current.revision}, not ${expected}`, { currentRevision: current.revision });
        if (to === "closed" ? body.state !== "answered" : body.state !== "open") throw new DomainError("invalid_command", `inquiry ${id} is ${body.state}; it cannot be ${to}`, { field: "inquiryId" });
        const ref: AggregateRef = { kind: "inquiry", id };
        const next: InquiryBody = to === "closed"
          ? { ...body, state: "closed", closedAt: this.#runner.now() }
          : { ...body, state: "cancelled", closedAt: this.#runner.now(), cancelledBy: principal.id, cancelReason: reason as string };
        const changes: Change[] = [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }];
        // A withdrawn inquiry frees its place under the per-task limit (an answered one already did).
        if (to === "cancelled") changes.push(this.#bump(await this.#counter(body.taskId, body.asker), body.taskId, body.asker, -1));
        return { ref, creates: false, changes, detail: { correlationId: id } };
      },
    }));
  }

  /** The count of open inquiries of one asker about one task, with the revision to guard it by (revision 0: none yet). */
  async #counter(taskId: string, asker: string): Promise<{ open: number; revision: number }> {
    const found = await this.#runner.get("inquiry-counter", counterIdOf(taskId, asker));
    return found === undefined ? { open: 0, revision: 0 } : { open: (found.body as unknown as { open: number }).open, revision: found.revision };
  }

  #bump(counter: { open: number; revision: number }, taskId: string, asker: string, by: 1 | -1): Change {
    const ref: AggregateRef = { kind: "inquiry-counter", id: counterIdOf(taskId, asker) };
    const body = { open: Math.max(0, counter.open + by) } as unknown as JsonObject;
    return counter.revision === 0 ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: counter.revision, body };
  }

  /** Two decisions about the same asker's count at once meet a revision check; the loser reads again and decides again. */
  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 8) throw error;
      }
    }
  }

  async #checkWait(waitId: string, taskId: string, to: string): Promise<void> {
    const wait = await this.#waits.getWait(waitId);
    if (wait === undefined || wait.taskId !== taskId || wait.reason !== "inquiry" || wait.state !== "open" || wait.resolver !== to) invalid("waitId", "must be an open inquiry wait on this task whose resolver is the addressee");
  }

  async #answerWait(waitId: string, responder: Principal, answer: string, inquiryId: string): Promise<void> {
    const wait: View<WaitBody> | undefined = await this.#waits.getWait(waitId);
    if (wait === undefined) return;
    // Already answered by an earlier attempt of this same call: nothing to do.
    if (wait.state !== "open") return;
    await this.#waits.answerWait({ commandId: scopedCommandId(responder.id, `${inquiryId}-w`), actor: responder.id, waitId, expectedRevision: wait.revision, resolverId: responder.id, answer });
  }
}

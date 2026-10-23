import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { HistoryService, type EntryBody } from "../context/histories.js";
import type { RetrievalService, SourceRef } from "../context/retrieval.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Aggregate, AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { ContinuationBody } from "../continuation/continuation.js";
import type { InquiryBody } from "../inquiries/inquiries.js";

export type BranchState = "active" | "suspended" | "returned";

/** Where the work goes back to. It is a record of intent: it moves nothing and is changed only by `redirect` or consumed by `resume`. */
export interface ReturnDestination {
  readonly taskId: string;
  readonly note?: string;
}

/** The parent context as it was when the branch began: the task's own history up to an entry, and the conversation capture (C04) if one was named. Never rewritten. */
interface ParentContext {
  readonly scopeId: string;
  /** Entries 1..throughSeq of the parent's history are the branch's inherited history. Later entries are not part of it unless selected as updates. */
  readonly throughSeq: number;
  readonly continuationId?: string;
  readonly identity?: string;
}

interface AppliedUpdate { readonly source: SourceRef; readonly digest: string; /** The update revision this application produced. */ readonly revision: number; readonly at: string }

/** What suspending froze: restoring checks the branch's history against it. */
interface Snapshot { readonly branchCount: number; readonly updateRevision: number; readonly appliedCount: number; readonly at: string; readonly reason: string; readonly by: string }

export interface BranchBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly owner: string;
  readonly purpose: string;
  readonly parent: ParentContext;
  /** The branch's own history (a side chat, C01). Everything the branch says and decides goes here and nowhere in the parent. */
  readonly scopeId: string;
  readonly inquiryId?: string;
  readonly state: BranchState;
  readonly returnTo: ReturnDestination;
  /** How many times the destination was changed on purpose (0: as set when the branch began). */
  readonly returnRevision: number;
  readonly returnChangedBy?: string;
  readonly applied: readonly AppliedUpdate[];
  /** Counts selective update applications; each `applyUpdates` that changes anything adds one. */
  readonly updateRevision: number;
  readonly suspended?: Snapshot;
  /** The latest restore: how many entries (beyond the frozen count) other writers added to the branch's history while it was suspended. */
  readonly restored?: { readonly at: string; readonly extraEntries: number; readonly exact: boolean };
  readonly openedAt: string;
  readonly returnedAt?: string;
  readonly returnedTo?: ReturnDestination;
}

export interface OpenBranch extends NoActor {
  readonly taskId: string;
  readonly purpose: string;
  /** Default: back to the task the branch began from. */
  readonly returnTo?: ReturnDestination;
  /** A complete continuation capture (C04) of this task that the branch inherits, so the parent's conversation position is recorded with it. */
  readonly continuationId?: string;
  /** The H04 inquiry this branch answers, if any. */
  readonly inquiryId?: string;
}

export interface ContextItem { readonly source: SourceRef; readonly revision: number; /** `changed`: the original is no longer as it was when applied. `unavailable`: gone or not readable by this viewer (not told apart). */ readonly state: "current" | "changed" | "unavailable"; readonly text?: string }

export interface BranchView {
  readonly branch: View<BranchBody>;
  /** Applied updates, resolved for this viewer only. */
  readonly updates: readonly ContextItem[];
  /** The parent's frozen length and the branch's own length now, so a reader can tell what "exactly the available history" is. */
  readonly counts: { readonly parent: number; readonly branch: number };
}

export interface BranchHistory {
  readonly part: "parent" | "branch";
  readonly entries: readonly View<EntryBody>[];
  /** Where to continue, if more remain within the available range. */
  readonly next?: number;
}

export interface DelegationBody {
  readonly branchId: string;
  readonly parentTaskId: string;
  readonly childTaskId: string;
  readonly projectId: string;
  /** Only these links, each with the digest it had when selected. No scope, no history range, no branch content is handed over. */
  readonly refs: readonly { readonly source: SourceRef; readonly digest: string }[];
  readonly by: string;
  readonly at: string;
}

export interface DelegatedItem { readonly source: SourceRef; readonly state: "current" | "changed" | "unavailable"; readonly text?: string; readonly delegationId: string }

export const BRANCH_LIMITS = { purpose: 1000, reason: 500, note: 500, updatesPerCall: 10, applied: 100, refsPerDelegation: 10, delegationsPerChild: 200, page: 200 } as const;
const BRANCH_ID = /^cbr-[a-z2-7]{20}$/;
const CONTINUATION_ID = /^cnt-[a-z2-7]{20}$/;
const INQUIRY_ID = /^inq-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const plain = (value: unknown, field: string, max: number): string => {
  const out = text(value, field, { min: 1, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded");
  return out;
};
const keyOf = (s: SourceRef): string => (s.kind === "desk-record" ? `d:${s.id}` : `h:${s.scopeId}:${s.seq}`);
const normal = (s: SourceRef): SourceRef => (s.kind === "desk-record" ? { kind: "desk-record", id: s.id } : { kind: "history-entry", scopeId: s.scopeId, seq: s.seq });

/**
 * Retained context branches (card C05). A branch is the controller's record of a side line of work begun from a task: an inquiry about its status, an assessment, a detour.
 * - **Immutable parent.** The branch records the task's history up to a fixed entry (and, if named, the C04 capture), and has its own history (a side chat). Nothing the branch does writes the
 *   parent: its history, its assignment and its desk records are untouched (tested). Entries the parent gains later are not part of the branch unless they are selected.
 * - **Selective updates.** `applyUpdates` brings chosen originals (desk records or history entries the branch's owner can read) into the branch under a revision check: each application is one
 *   update revision, an original already applied with the same content is never applied again (a changed original may be applied again as a new revision), and a repeated command is the recorded result.
 * - **Return destination.** Every branch records where the work returns to. It stays as recorded until `resume` consumes it or `redirect` changes it on purpose; opening another branch or task
 *   for the same agent (an urgent one) never touches it, and `pendingReturns` lists what is still owed.
 * - **Suspend, switch, restore.** Suspending freezes the branch's history length and update revision; restoring checks them and reports anything written meanwhile, so what was available before is
 *   available after, exactly. `switch` suspends one branch and restores another in one step.
 * - **Delegation.** A child task receives `delegate`d links only (with digests), resolved with the child's own rights; it never receives the parent's history range, the branch's scope or a copy.
 */
export class ContextBranchService {
  readonly #runner: CommandRunner;
  readonly #histories: HistoryService;
  readonly #retrieval: RetrievalService;

  private constructor(runner: CommandRunner, deps: { histories: HistoryService; retrieval: RetrievalService }) {
    this.#runner = runner;
    this.#histories = deps.histories;
    this.#retrieval = deps.retrieval;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: { histories: HistoryService; retrieval: RetrievalService }, options: RunnerOptions = {}): ContextBranchService {
    return new ContextBranchService(new CommandRunner(storage, epoch, options), deps);
  }

  /** Begins a branch from a task. The opener must be working on the task (`attempt.work`) and becomes the branch's owner. Idempotent by command ID. */
  async open(principal: Principal, command: OpenBranch): Promise<{ id: string; scopeId: string; throughSeq: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "purpose", "returnTo", "continuationId", "inquiryId"]);
    const taskId = checkTaskId(command.taskId);
    const purpose = plain(command.purpose, "purpose", BRANCH_LIMITS.purpose);
    const continuationId = command.continuationId === undefined ? undefined : (typeof command.continuationId === "string" && CONTINUATION_ID.test(command.continuationId) ? command.continuationId : invalid("continuationId", "is not a continuation ID"));
    const inquiryId = command.inquiryId === undefined ? undefined : (typeof command.inquiryId === "string" && INQUIRY_ID.test(command.inquiryId) ? command.inquiryId : invalid("inquiryId", "is not an inquiry ID"));
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    // A task the opener may not work on reads exactly like one that does not exist.
    if (task === undefined || !allows(principal, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } }) || !inTaskScope(principal, task.projectId)) throw new DomainError("forbidden", `${principal.id} may not branch from that task`);
    const returnTo = await this.#destination(command.returnTo ?? { taskId }, task.projectId, "returnTo");
    let identity: string | undefined;
    if (continuationId !== undefined) {
      const c = (await this.#runner.get("continuation", continuationId))?.body as unknown as ContinuationBody | undefined;
      if (c === undefined || c.taskId !== taskId || c.status !== "complete") invalid("continuationId", "must be a complete continuation of this task");
      identity = (c as ContinuationBody).identity;
    }
    if (inquiryId !== undefined) {
      const q = (await this.#runner.get("inquiry", inquiryId))?.body as unknown as InquiryBody | undefined;
      if (q === undefined || q.taskId !== taskId || (principal.kind !== "owner" && q.asker !== principal.id && q.to !== principal.id)) invalid("inquiryId", "must be an inquiry of this task that the opener asked or was asked");
    }
    const id = derivedId("cbr", scopedCommandId(principal.id, command.commandId));
    // The branch's own history first (idempotent by the branch's own ID), then the record.
    const chat = await this.#histories.openScope(principal, { commandId: `${id}-chat`, type: "chat", projectId: task.projectId, taskId, participants: [] });
    const parentScopeId = HistoryService.taskScopeId(taskId);
    const result = await this.#runner.command("branch.open", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => ({
      payload: { taskId, purpose, returnTo: returnTo as unknown as JsonObject, ...(continuationId === undefined ? {} : { continuationId }), ...(inquiryId === undefined ? {} : { inquiryId }) },
      build: async () => {
        const scope = (await this.#runner.get("history-scope", parentScopeId))?.body as unknown as { count: number } | undefined;
        const ref: AggregateRef = { kind: "context-branch", id };
        const body: BranchBody = {
          taskId, projectId: task.projectId, owner: principal.id, purpose,
          parent: { scopeId: parentScopeId, throughSeq: scope?.count ?? 0, ...(continuationId === undefined ? {} : { continuationId, identity: identity as string }) },
          scopeId: chat.id, ...(inquiryId === undefined ? {} : { inquiryId }), state: "active", returnTo, returnRevision: 0, applied: [], updateRevision: 0, openedAt: this.#runner.now(),
        };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { taskId, throughSeq: body.parent.throughSeq } };
      },
    }));
    const stored = (await this.#runner.get("context-branch", result.id))!.body as unknown as BranchBody;
    return { id: result.id, scopeId: stored.scopeId, throughSeq: stored.parent.throughSeq, replayed: result.replayed };
  }

  /** The branch as this viewer may see it: its owner and the installation owner only; anyone else gets `undefined`, as for a missing branch. */
  async view(viewer: Principal, branchId: string): Promise<BranchView | undefined> {
    const found = await this.#visible(viewer, branchId);
    if (found === undefined) return undefined;
    const branch = view<BranchBody>(found);
    const updates: ContextItem[] = [];
    for (const u of branch.applied) {
      const original = await this.#retrieval.fetch(viewer, u.source);
      updates.push(original === undefined ? { source: u.source, revision: u.revision, state: "unavailable" } : { source: u.source, revision: u.revision, state: original.digest === u.digest ? "current" : "changed", text: original.text });
    }
    const own = (await this.#runner.get("history-scope", branch.scopeId))?.body as unknown as { count: number } | undefined;
    return { branch, updates, counts: { parent: branch.parent.throughSeq, branch: own?.count ?? 0 } };
  }

  /**
   * Reads the history the branch has available: `parent` is the task's history up to the recorded entry and no further, `branch` is its own. Each is read as the viewer, so a
   * viewer who may not read a history sees none of it (an empty page, as for an empty history).
   */
  async history(viewer: Principal, branchId: string, query: { part: "parent" | "branch"; afterSeq?: number; limit: number }): Promise<BranchHistory | undefined> {
    const found = await this.#visible(viewer, branchId);
    if (found === undefined) return undefined;
    const b = found.body as unknown as BranchBody;
    const after = query.afterSeq ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) invalid("afterSeq", "must be a whole number from 0");
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > BRANCH_LIMITS.page) invalid("limit", `must be a whole number from 1 to ${BRANCH_LIMITS.page}`);
    const scopeId = query.part === "parent" ? b.parent.scopeId : b.scopeId;
    const cap = query.part === "parent" ? b.parent.throughSeq : Number.MAX_SAFE_INTEGER;
    if (query.part !== "parent" && query.part !== "branch") invalid("part", "must be parent or branch");
    if (after >= cap) return { part: query.part, entries: [] };
    let read: { entries: View<EntryBody>[] };
    try { read = await this.#histories.read(viewer, scopeId, { afterSeq: after, limit: Math.min(query.limit, cap - after), ...(query.part === "parent" ? { taskId: b.taskId } : {}) }); } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) return { part: query.part, entries: [] };
      throw error;
    }
    const entries = read.entries.filter((e) => e.seq <= cap);
    const last = entries.at(-1)?.seq;
    return { part: query.part, entries, ...(last !== undefined && last < cap && entries.length === Math.min(query.limit, cap - after) ? { next: last } : {}) };
  }

  /** The branch's own say: an entry in its own history. Only while the branch is active. */
  async append(principal: Principal, command: NoActor & { branchId: string; text: string }): Promise<{ seq: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "branchId", "text"]);
    const found = await this.#mine(principal, command.branchId);
    const b = found.body as unknown as BranchBody;
    if (b.state !== "active") throw new DomainError("invalid_command", `branch ${found.id} is ${b.state}; it takes entries only while active`, { field: "branchId" });
    return this.#histories.append(principal, b.scopeId, { commandId: command.commandId, text: command.text });
  }

  /**
   * Brings chosen originals into the branch. Each must be readable by the caller and in the branch's project; a history entry of the parent's frozen range, or of the branch's own history, is
   * already part of the branch and is refused. The branch's revision guards it, so two applications at once cannot both take effect on the same revision. An original already applied with
   * unchanged content is skipped, and a call with nothing new is refused.
   */
  async applyUpdates(principal: Principal, command: NoActor & { branchId: string; expectedRevision: number; updates: readonly SourceRef[] }): Promise<{ revision: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "branchId", "expectedRevision", "updates"]);
    const expected = checkRevision(command.expectedRevision);
    if (!Array.isArray(command.updates) || command.updates.length < 1 || command.updates.length > BRANCH_LIMITS.updatesPerCall) invalid("updates", `must be a list of 1 to ${BRANCH_LIMITS.updatesPerCall} links`);
    const found = await this.#mine(principal, command.branchId);
    const b0 = found.body as unknown as BranchBody;
    const sources: SourceRef[] = [];
    for (const raw of command.updates) {
      const source = normal(raw);
      if (!sources.some((p) => keyOf(p) === keyOf(source))) sources.push(source);
    }
    const id = found.id;
    // The payload holds only the links: the digests are taken inside the command, so a retry after an original changed is still the recorded result.
    const r = await this.#runner.command("branch.update", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => ({
      payload: { branchId: id, expectedRevision: expected, updates: sources as unknown as JsonObject[] },
      build: async () => {
        const picked: { source: SourceRef; digest: string }[] = [];
        for (const [i, source] of sources.entries()) {
          const original = await this.#retrieval.fetch(principal, source);
          if (original === undefined || original.projectId !== b0.projectId) invalid(`updates[${i}]`, "must be readable by the caller and belong to the branch's project");
          if (source.kind === "history-entry" && ((source.scopeId === b0.parent.scopeId && source.seq <= b0.parent.throughSeq) || source.scopeId === b0.scopeId)) invalid(`updates[${i}]`, "is already part of the branch's context");
          picked.push({ source, digest: original!.digest });
        }
        const { current, body } = await this.#load(id, expected);
        if (body.state !== "active") throw new DomainError("invalid_command", `branch ${id} is ${body.state}; updates apply only while active`, { field: "branchId" });
        const fresh = picked.filter((p) => !body.applied.some((a) => keyOf(a.source) === keyOf(p.source) && a.digest === p.digest));
        if (fresh.length === 0) throw new DomainError("invalid_command", "every selected update is already applied", { field: "updates" });
        if (body.applied.length + fresh.length > BRANCH_LIMITS.applied) throw new DomainError("unavailable", `a branch holds at most ${BRANCH_LIMITS.applied} applied updates`);
        const updateRevision = body.updateRevision + 1;
        const at = this.#runner.now();
        const next: BranchBody = { ...body, updateRevision, applied: [...body.applied, ...fresh.map((p) => ({ source: p.source, digest: p.digest, revision: updateRevision, at }))] };
        return this.#change(id, current.revision, next, { updateRevision, count: fresh.length });
      },
    }));
    return { revision: r.revision, replayed: r.replayed };
  }

  /** Freezes the branch (its history length and update revision) and sets it aside. */
  suspend(principal: Principal, command: NoActor & { branchId: string; expectedRevision: number; reason: string }): Promise<void> {
    onlyKnown(command, ["commandId", "branchId", "expectedRevision", "reason"]);
    const reason = plain(command.reason, "reason", BRANCH_LIMITS.reason);
    return this.#transition(principal, "branch.suspend", command, { reason }, async (body, owner) => this.#suspended(body, owner, reason)).then(() => undefined);
  }

  /** Brings a suspended branch back, with exactly the history it had; anything written to its history meanwhile by others is reported, not hidden. */
  restore(principal: Principal, command: NoActor & { branchId: string; expectedRevision: number }): Promise<void> {
    onlyKnown(command, ["commandId", "branchId", "expectedRevision"]);
    return this.#transition(principal, "branch.restore", command, {}, async (body) => this.#restored(body)).then(() => undefined);
  }

  /** Suspends one branch and restores another in one step: either both happen or neither. Both must be the caller's. */
  async switch(principal: Principal, command: NoActor & { suspend: { branchId: string; expectedRevision: number; reason: string }; restore: { branchId: string; expectedRevision: number } }): Promise<void> {
    onlyKnown(command, ["commandId", "suspend", "restore"]);
    if (typeof command.suspend !== "object" || command.suspend === null || typeof command.restore !== "object" || command.restore === null) invalid("switch", "needs both a source and a target branch");
    onlyKnown(command.suspend, ["branchId", "expectedRevision", "reason"]);
    onlyKnown(command.restore, ["branchId", "expectedRevision"]);
    const reason = plain(command.suspend.reason, "suspend.reason", BRANCH_LIMITS.reason);
    const fromRev = checkRevision(command.suspend.expectedRevision, "suspend.expectedRevision");
    const toRev = checkRevision(command.restore.expectedRevision, "restore.expectedRevision");
    const from = await this.#mine(principal, command.suspend.branchId);
    const to = await this.#mine(principal, command.restore.branchId);
    if (from.id === to.id) invalid("restore", "must be a different branch");
    await this.#runner.command("branch.switch", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => ({
      payload: { suspend: { branchId: from.id, expectedRevision: fromRev, reason }, restore: { branchId: to.id, expectedRevision: toRev } },
      build: async () => {
        const a = await this.#load(from.id, fromRev);
        const b = await this.#load(to.id, toRev);
        const changes = [
          ...this.#change(from.id, a.current.revision, await this.#suspended(a.body, principal.id, reason), {}).changes,
          ...this.#change(to.id, b.current.revision, await this.#restored(b.body), {}).changes,
        ];
        return { ref: { kind: "context-branch", id: from.id }, creates: false, changes, detail: { suspended: from.id, restored: to.id } };
      },
    }));
  }

  /** Changes where the work returns to, on purpose. Nothing else changes it. */
  async redirect(principal: Principal, command: NoActor & { branchId: string; expectedRevision: number; returnTo: ReturnDestination }): Promise<void> {
    onlyKnown(command, ["commandId", "branchId", "expectedRevision", "returnTo"]);
    const found = await this.#mine(principal, command.branchId);
    const b = found.body as unknown as BranchBody;
    const returnTo = await this.#destination(command.returnTo, b.projectId, "returnTo");
    await this.#transition(principal, "branch.redirect", command, { returnTo: returnTo as unknown as JsonObject }, async (body) => {
      if (body.state === "returned") throw new DomainError("invalid_command", `branch ${found.id} has already returned`, { field: "branchId" });
      return { ...body, returnTo, returnRevision: body.returnRevision + 1, returnChangedBy: principal.id };
    });
  }

  /** The work goes back to the recorded destination: the branch is finished and the destination is consumed (kept as `returnedTo`). */
  async resume(principal: Principal, command: NoActor & { branchId: string; expectedRevision: number }): Promise<{ returnedTo: ReturnDestination }> {
    onlyKnown(command, ["commandId", "branchId", "expectedRevision"]);
    await this.#transition(principal, "branch.resume", command, {}, async (body) => {
      if (body.state === "returned") throw new DomainError("invalid_command", `branch ${command.branchId} has already returned`, { field: "branchId" });
      return { ...body, state: "returned", returnedAt: this.#runner.now(), returnedTo: body.returnTo, suspended: undefined } as unknown as BranchBody;
    });
    const stored = (await this.#runner.get("context-branch", command.branchId))!.body as unknown as BranchBody;
    return { returnedTo: stored.returnedTo as ReturnDestination };
  }

  /** The caller's branches that have not returned (active or suspended), each with its return destination, in ID order, paged. A newer task or branch does not remove an entry. */
  async pendingReturns(principal: Principal, page: { afterId?: string; limit?: number } = {}): Promise<{ items: View<BranchBody>[]; next?: string }> {
    const limit = page.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > BRANCH_LIMITS.page) invalid("limit", `must be a whole number from 1 to ${BRANCH_LIMITS.page}`);
    const items: View<BranchBody>[] = [];
    let after = page.afterId;
    for (let reads = 0; reads < 20; reads++) {
      const chunk = await this.#runner.list("context-branch", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of chunk) {
        after = a.id;
        const b = a.body as unknown as BranchBody;
        if (b.state === "returned" || (principal.kind !== "owner" && (b.owner !== principal.id || !inTaskScope(principal, b.projectId) || !allows(principal, "attempt.work", b.projectId, { resource: { kind: "task", id: b.taskId } })))) continue;
        items.push(view<BranchBody>(a));
        if (items.length >= limit) return { items, next: a.id };
      }
      if (chunk.length < 200) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }

  /**
   * Hands a child task chosen links. Only the links (and their digests) are recorded: the child gets no copy and no fork of the parent's or the branch's
   * history. Any link readable by the branch's owner in the task's project may be chosen (it need not be part of the branch). The child task must be another task of the same project.
   */
  async delegate(principal: Principal, command: NoActor & { branchId: string; childTaskId: string; refs: readonly SourceRef[] }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "branchId", "childTaskId", "refs"]);
    const childTaskId = checkTaskId(command.childTaskId);
    if (!Array.isArray(command.refs) || command.refs.length < 1 || command.refs.length > BRANCH_LIMITS.refsPerDelegation) invalid("refs", `must be a list of 1 to ${BRANCH_LIMITS.refsPerDelegation} links`);
    const found = await this.#mine(principal, command.branchId);
    const b = found.body as unknown as BranchBody;
    if (b.state === "returned") throw new DomainError("invalid_command", `branch ${found.id} has returned`, { field: "branchId" });
    const child = (await this.#runner.get("task", childTaskId))?.body as unknown as TaskBody | undefined;
    if (child === undefined || child.projectId !== b.projectId || childTaskId === b.taskId) invalid("childTaskId", "must be another task of the branch's project");
    const sources: SourceRef[] = [];
    for (const raw of command.refs) {
      const source = normal(raw);
      if (!sources.some((r) => keyOf(r) === keyOf(source))) sources.push(source);
    }
    const id = derivedId("cdl", scopedCommandId(principal.id, command.commandId));
    const indexRef: AggregateRef = { kind: "context-delegation-index", id: childTaskId };
    // The payload holds only the links (digests are taken inside the command). The per-child index is guarded by its revision, so two delegations at once retry.
    const result = await this.#retrying(() => this.#runner.command("branch.delegate", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => ({
      payload: { branchId: found.id, childTaskId, refs: sources as unknown as JsonObject[] },
      build: async () => {
        const refs: { source: SourceRef; digest: string }[] = [];
        for (const [i, source] of sources.entries()) {
          const original = await this.#retrieval.fetch(principal, source);
          if (original === undefined || original.projectId !== b.projectId) invalid(`refs[${i}]`, "must be readable by the caller and belong to the branch's project");
          refs.push({ source, digest: original!.digest });
        }
        const index = await this.#runner.get(indexRef.kind, indexRef.id);
        const ids = (index?.body as unknown as { ids: string[] } | undefined)?.ids ?? [];
        if (ids.length >= BRANCH_LIMITS.delegationsPerChild) throw new DomainError("unavailable", `a task takes at most ${BRANCH_LIMITS.delegationsPerChild} delegations`);
        const ref: AggregateRef = { kind: "context-delegation", id };
        const body: DelegationBody = { branchId: found.id, parentTaskId: b.taskId, childTaskId, projectId: b.projectId, refs, by: principal.id, at: this.#runner.now() };
        const next = { ids: [...ids, id] } as unknown as JsonObject;
        const indexChange: Change = index === undefined ? { type: "create", ref: indexRef, body: next } : { type: "update", ref: indexRef, expectedRevision: index.revision, body: next };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }, indexChange], detail: { branchId: found.id, childTaskId } };
      },
    })));
    return { id: result.id, replayed: result.replayed };
  }

  /**
   * What a child task has been handed, resolved with the viewer's own rights (the child's worker, or the owner). Nothing from the parent or the branch comes with it but the selected links:
   * a link the viewer cannot read, or that is gone, shows as `unavailable` with no text.
   */
  async delegatedContext(viewer: Principal, childTaskId: string): Promise<DelegatedItem[]> {
    const tid = checkTaskId(childTaskId);
    const task = (await this.#runner.get("task", tid))?.body as unknown as TaskBody | undefined;
    if (task === undefined || !allows(viewer, "attempt.work", task.projectId, { resource: { kind: "task", id: tid } }) || !inTaskScope(viewer, task.projectId)) return [];
    const items: DelegatedItem[] = [];
    const ids = ((await this.#runner.get("context-delegation-index", tid))?.body as unknown as { ids: string[] } | undefined)?.ids ?? [];
    for (const delegationId of ids) {
      const a = await this.#runner.get("context-delegation", delegationId);
      if (a === undefined) continue;
      for (const r of (a.body as unknown as DelegationBody).refs) {
        const original = await this.#retrieval.fetch(viewer, r.source);
        items.push(original === undefined ? { source: r.source, state: "unavailable", delegationId } : { source: r.source, state: original.digest === r.digest ? "current" : "changed", text: original.text, delegationId });
      }
    }
    return items;
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  async #visible(viewer: Principal, branchId: string): Promise<Aggregate | undefined> {
    const found = typeof branchId === "string" && BRANCH_ID.test(branchId) ? await this.#runner.get("context-branch", branchId) : undefined;
    if (found === undefined) return undefined;
    const b = found.body as unknown as BranchBody;
    if (viewer.kind !== "owner" && (viewer.id !== b.owner || !inTaskScope(viewer, b.projectId) || !allows(viewer, "attempt.work", b.projectId, { resource: { kind: "task", id: b.taskId } }))) return undefined;
    return found;
  }

  /** The branch for a command by its owner (or the installation owner, who may do everything); anyone else, and a missing branch, get the same refusal. */
  async #mine(principal: Principal, branchId: unknown): Promise<Aggregate> {
    const found = typeof branchId === "string" && BRANCH_ID.test(branchId) ? await this.#runner.get("context-branch", branchId) : undefined;
    const b = found?.body as unknown as BranchBody | undefined;
    // The owner must still be allowed to work on the task: revoking the grant ends the right.
    const ok = b !== undefined && (principal.kind === "owner" || (principal.id === b.owner && allows(principal, "attempt.work", b.projectId, { resource: { kind: "task", id: b.taskId } }) && inTaskScope(principal, b.projectId)));
    if (found === undefined || !ok) throw new DomainError("forbidden", `${principal.id} may not use that branch`);
    return found;
  }

  async #load(id: string, expected: number): Promise<{ current: { revision: number }; body: BranchBody }> {
    const current = await this.#runner.get("context-branch", id);
    if (current === undefined) throw new DomainError("not_found", `branch ${id} does not exist`);
    if (current.revision !== expected) throw new DomainError("stale_revision", `branch ${id} is at revision ${current.revision}, not ${expected}`, { currentRevision: current.revision });
    return { current, body: current.body as unknown as BranchBody };
  }

  #change(id: string, revision: number, next: BranchBody, detail: JsonObject): { ref: AggregateRef; creates: false; changes: Change[]; detail: JsonObject } {
    const ref: AggregateRef = { kind: "context-branch", id };
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as unknown as JsonObject;
    return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: revision, body: clean }], detail: { branchId: id, ...detail } };
  }

  async #transition(principal: Principal, type: string, command: NoActor & { branchId: string; expectedRevision: number }, extra: JsonObject, step: (body: BranchBody, by: string) => Promise<BranchBody>): Promise<void> {
    const expected = checkRevision(command.expectedRevision);
    const found = await this.#mine(principal, command.branchId);
    await this.#runner.command(type, { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => ({
      payload: { branchId: found.id, expectedRevision: expected, ...extra },
      build: async () => {
        const { current, body } = await this.#load(found.id, expected);
        return this.#change(found.id, current.revision, await step(body, principal.id), {});
      },
    }));
  }

  async #suspended(body: BranchBody, by: string, reason: string): Promise<BranchBody> {
    if (body.state !== "active") throw new DomainError("invalid_command", `branch is ${body.state}; only an active branch can be suspended`, { field: "branchId" });
    const own = (await this.#runner.get("history-scope", body.scopeId))?.body as unknown as { count: number } | undefined;
    return { ...body, state: "suspended", suspended: { branchCount: own?.count ?? 0, updateRevision: body.updateRevision, appliedCount: body.applied.length, at: this.#runner.now(), reason, by } };
  }

  async #restored(body: BranchBody): Promise<BranchBody> {
    if (body.state !== "suspended" || body.suspended === undefined) throw new DomainError("invalid_command", `branch is ${body.state}; only a suspended branch can be restored`, { field: "branchId" });
    const own = (await this.#runner.get("history-scope", body.scopeId))?.body as unknown as { count: number } | undefined;
    const extraEntries = (own?.count ?? 0) - body.suspended.branchCount;
    const exact = extraEntries === 0 && body.updateRevision === body.suspended.updateRevision && body.applied.length === body.suspended.appliedCount;
    return { ...body, state: "active", suspended: undefined, restored: { at: this.#runner.now(), extraEntries, exact } } as unknown as BranchBody;
  }

  async #destination(value: unknown, projectId: string, field: string): Promise<ReturnDestination> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(field, "must be an object");
    onlyKnown(value, ["taskId", "note"]);
    const v = value as { taskId?: unknown; note?: unknown };
    const taskId = checkTaskId(v.taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined || task.projectId !== projectId) invalid(`${field}.taskId`, "must be a task of the branch's project");
    return { taskId, ...(v.note === undefined ? {} : { note: plain(v.note, `${field}.note`, BRANCH_LIMITS.note) }) };
  }

  /** Two delegations to one child at once meet a revision check on its index; the loser reads again and decides again. */
  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 8) throw error;
      }
    }
  }
}

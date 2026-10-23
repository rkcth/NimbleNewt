import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { InspectionService } from "./inspection.js";

/**
 * Stored model thinking (card C06b, owner decision 2026-10-22). When a conversation is resumed or switched, the thinking and reasoning items the provider returned are kept in the stored conversation and replayed to the model in
 * order, so the model keeps its own reasoning and the provider accepts the history. Pi Durable stores and replays them; this service is the controller's side of the rules around them:
 *
 * - **Owner only.** Stored thinking is read by the owner and by nobody else. Not a peer, not another conversation, not an agent, not a service: to all of them it looks like there is none (an unreadable record reads like a missing one).
 * - **A10 policy and redaction.** The owner's read follows the installation's inspection policy (`denied` refuses it), is recorded as a look (who, which task, why, how many blocks, when), and shows the text with the same secret redaction
 *   as private scratch.
 * - **Not exported by default.** An export carries stored thinking only when the owner has turned that on.
 * - **Fourteen days.** Thinking is kept for 14 days after the task ends and then deleted (card K06 does the deleting; `deleteAfter` is the date it works to). Chats keep only the words said.
 * - **Dropped, not lost.** When a request goes to another model than the one that produced some thinking, only the blocks that model cannot accept are left out of that request; the drop is recorded here, the thinking stays.
 */

/** Days a task's thinking is kept after the task ends. */
export const THINKING_RETENTION_DAYS = 14;

/** One block of stored thinking, as the Pi adapter reads it (the signature or encrypted payload the provider needs is never part of it). */
export interface ThinkingBlock {
  readonly entryId: number;
  readonly provider: string;
  readonly model: string;
  readonly text: string;
  readonly opaque: boolean;
}

/** Where the blocks come from: the runtime of the task. Given to the service when it is built by the code that wires the runtime in, never taken from a caller. */
export interface ThinkingSource {
  /** `undefined` when the task has no conversation (or the project does not have it). `agent` is the principal ID of the agent whose thinking it is. */
  read(task: { readonly projectId: string; readonly taskId: string }): Promise<{ readonly agent: string; readonly blocks: readonly ThinkingBlock[] } | undefined>;
}

export interface ThinkingExportPolicyBody { readonly includeThinking: boolean; readonly updatedBy: string; readonly updatedAt: string }

/** One look at a task's stored thinking. The text itself is never kept here. */
export interface ThinkingLookBody {
  readonly inspector: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly reason: string;
  /** The agent whose thinking it was; it can see that the owner looked (as with A10's inspections of scratch). */
  readonly agent: string;
  readonly policy: "allowed";
  readonly returned: number;
  readonly at: string;
}

/** A request that went to a model which cannot take some of the stored thinking: how many blocks it left out and how many it kept. */
export interface ThinkingDropBody {
  readonly projectId: string;
  readonly taskId: string;
  readonly model: string;
  readonly dropped: number;
  readonly kept: number;
  readonly at: string;
  readonly by: string;
}

/** Where a page ended: the entry and the position of the block within it (an entry can hold several blocks). */
export interface ThinkingCursor { readonly entryId: number; readonly block: number }

export interface ReadBlock extends ThinkingBlock { /** Position of this block within its entry. */ readonly block: number; /** Some of the text matched a credential shape and was replaced. */ readonly redacted: boolean }

export const THINKING_LIMITS = { page: 100, maxPage: 200, reason: 500, model: 200 } as const;

const POLICY: AggregateRef = { kind: "thinking-export-policy", id: "installation" };
const PROJECT = /^proj-[a-z2-7]{20}$/;
const TASK = /^task-[a-z2-7]{20}$/;
const LOOK = /^tlk-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const missing = (): never => { throw new DomainError("not_found", "no stored thinking for that task"); };

/** The moment a task's thinking is due for deletion: 14 days after the task ended (UTC; the end time comes from the injected clock of whoever ended the task). */
export function deleteAfter(endedAt: string): string {
  const t = Date.parse(endedAt);
  if (!Number.isFinite(t)) return invalid("endedAt", "is not a time");
  return new Date(t + THINKING_RETENTION_DAYS * 86_400_000).toISOString();
}

export class ThinkingService {
  readonly #runner: CommandRunner;
  readonly #inspection: InspectionService;
  readonly #source: ThinkingSource;

  private constructor(runner: CommandRunner, inspection: InspectionService, source: ThinkingSource) { this.#runner = runner; this.#inspection = inspection; this.#source = source; }

  static withEpoch(storage: ControllerStorage, epoch: number, source: ThinkingSource, inspection: InspectionService, options: RunnerOptions = {}): ThinkingService {
    return new ThinkingService(new CommandRunner(storage, epoch, options), inspection, source);
  }

  /** The owner decides whether exports carry stored thinking. Without `expectedRevision` it creates the setting; with it, it replaces it. Default off. */
  async setExportPolicy(owner: Principal, command: NoActor & { includeThinking: boolean; expectedRevision?: number }): Promise<{ revision: number; replayed: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner decides whether exports carry stored thinking`);
    onlyKnown(command, ["commandId", "includeThinking", "expectedRevision"]);
    if (typeof command.includeThinking !== "boolean") invalid("includeThinking", "must be true or false");
    const expected = command.expectedRevision === undefined ? undefined : checkRevision(command.expectedRevision);
    const r = await this.#runner.command("thinking.export-policy", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { includeThinking: command.includeThinking, expectedRevision: expected ?? null },
      build: async () => {
        const body: ThinkingExportPolicyBody = { includeThinking: command.includeThinking, updatedBy: owner.id, updatedAt: this.#runner.now() };
        const current = await this.#runner.get(POLICY.kind, POLICY.id);
        if (expected === undefined) {
          if (current !== undefined) throw new DomainError("stale_revision", "the export setting already exists; give expectedRevision to replace it");
          return { ref: POLICY, creates: true, changes: [{ type: "create", ref: POLICY, body: body as unknown as JsonObject }], detail: { includeThinking: body.includeThinking } };
        }
        if (current === undefined || current.revision !== expected) throw new DomainError("stale_revision", `the export setting is at revision ${current?.revision ?? 0}, not ${expected}`, ...(current === undefined ? [] : [{ currentRevision: current.revision }]));
        return { ref: POLICY, creates: false, changes: [{ type: "update", ref: POLICY, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { includeThinking: body.includeThinking } };
      },
    }));
    return { revision: r.revision, replayed: r.replayed };
  }

  /** Whether exports carry stored thinking (off unless the owner turned it on). */
  async exportPolicy(): Promise<{ includeThinking: boolean; revision: number }> {
    const found = await this.#runner.get(POLICY.kind, POLICY.id);
    return found === undefined ? { includeThinking: false, revision: 0 } : { includeThinking: (found.body as unknown as ThinkingExportPolicyBody).includeThinking, revision: found.revision };
  }

  /**
   * The owner reads a task's stored thinking, a page at a time, with a reason. Everyone else is told there is none. The inspection policy can forbid it. The look is recorded before the text is returned, in the same step (the policy is checked in that step too),
   * and a repeat of the same command returns the record of the look and no text (a second reading is a second look and needs its own command). A page that is not the last returns `next`.
   */
  async read(by: Principal, command: NoActor & { projectId: string; taskId: string; reason: string; after?: ThinkingCursor; limit?: number }): Promise<{ blocks?: ReadBlock[]; next?: ThinkingCursor; lookId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "projectId", "taskId", "reason", "after", "limit"]);
    // Not the owner: nothing to tell, and nothing recorded that would reveal there is anything.
    if (by.kind !== "owner") return missing();
    const projectId = PROJECT.test(String(command.projectId)) ? command.projectId : invalid("projectId", "is not a project ID");
    const taskId = TASK.test(String(command.taskId)) ? command.taskId : invalid("taskId", "is not a task ID");
    const reason = text(command.reason, "reason", { min: 1, max: THINKING_LIMITS.reason });
    if (redactText(reason) !== reason) invalid("reason", "looks like a credential or key; those are not recorded");
    const limit = command.limit ?? THINKING_LIMITS.page;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > THINKING_LIMITS.maxPage) invalid("limit", `must be a whole number from 1 to ${THINKING_LIMITS.maxPage}`);
    if (command.after !== undefined) onlyKnown(command.after, ["entryId", "block"]);
    const after = command.after ?? { entryId: -1, block: -1 };
    if (!Number.isSafeInteger(after.entryId) || after.entryId < -1 || !Number.isSafeInteger(after.block) || after.block < -1) invalid("after", "must be a cursor from an earlier page");
    const id = derivedId("tlk", scopedCommandId(by.id, command.commandId));
    let page: ReadBlock[] = []; let next: ThinkingCursor | undefined;
    const r = await this.#runner.command("thinking.read", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { projectId, taskId, reason, after: { ...after }, limit },
      build: async () => {
        // Inside the command, so a repeat of a read that was allowed still replays after the policy has changed.
        if ((await this.#inspection.policy()).scratch === "denied") throw new DomainError("forbidden", "the installation's inspection policy does not allow the owner to read agents' private records");
        const found = await this.#source.read({ projectId, taskId });
        if (found === undefined) return missing();
        const position = new Map<number, number>();
        const all: ReadBlock[] = found.blocks.map((b) => { const block = position.get(b.entryId) ?? 0; position.set(b.entryId, block + 1); const shown = redactText(b.text); return { ...b, block, text: shown, redacted: shown !== b.text }; });
        const rest = all.filter((b) => b.entryId > after.entryId || (b.entryId === after.entryId && b.block > after.block));
        page = rest.slice(0, limit);
        const last = page[page.length - 1];
        next = rest.length > limit && last !== undefined ? { entryId: last.entryId, block: last.block } : undefined;
        const ref: AggregateRef = { kind: "thinking-look", id };
        const body: ThinkingLookBody = { inspector: by.id, projectId, taskId, reason, agent: found.agent, policy: "allowed", returned: page.length, at: this.#runner.now() };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { taskId, returned: page.length } };
      },
    }));
    return r.replayed ? { lookId: id, replayed: true } : { blocks: page, ...(next === undefined ? {} : { next }), lookId: id, replayed: false };
  }

  /** The looks at stored thinking, oldest ID first, paged: the owner sees all; an agent sees the looks at its own thinking and nobody else's. */
  async looks(by: Principal, query: { afterId?: string; limit?: number } = {}): Promise<{ items: View<ThinkingLookBody>[]; next?: string }> {
    if (by.kind !== "owner" && by.kind !== "agent") return { items: [] };
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid("limit", "must be a whole number from 1 to 200");
    if (query.afterId !== undefined && !LOOK.test(query.afterId)) invalid("afterId", "is not a look ID");
    const items: View<ThinkingLookBody>[] = [];
    let after = query.afterId;
    for (let reads = 0; reads < 20; reads++) {
      const page = await this.#runner.list("thinking-look", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id;
        const b = a.body as unknown as ThinkingLookBody;
        // The agent whose thinking it was sees that the owner looked (not what was read); no other agent sees it.
        if (by.kind !== "owner" && (b.agent !== by.id || !inTaskScope(by, b.projectId))) continue;
        items.push(view<ThinkingLookBody>(a));
        if (items.length >= limit) return { items, next: a.id };
      }
      if (page.length < 200) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }

  /**
   * What an export may carry of a task's stored thinking: nothing, unless the owner turned that on, and then the redacted text. Only the owner, the host or a service builds exports; anyone else is told there is none.
   * Opaque blocks (redacted or encrypted by the provider) carry no text and are listed only as a count.
   */
  async forExport(by: Principal, blocks: readonly ThinkingBlock[]): Promise<{ blocks: ReadBlock[]; omitted: number }> {
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service")) return missing();
    if (!(await this.exportPolicy()).includeThinking) return { blocks: [], omitted: blocks.length };
    const position = new Map<number, number>();
    const shown = blocks.map((b) => { const block = position.get(b.entryId) ?? 0; position.set(b.entryId, block + 1); return { b, block }; }).filter(({ b }) => !b.opaque).map(({ b, block }) => { const t = redactText(b.text); return { ...b, block, text: t, redacted: t !== b.text }; });
    return { blocks: shown, omitted: blocks.length - shown.length };
  }

  /** The dispatcher (owner, host or service) records that a request left some stored thinking out because the model changed. Idempotent by command ID. */
  async recordDrop(by: Principal, command: NoActor & { projectId: string; taskId: string; model: string; dropped: number; kept: number }): Promise<{ id: string; replayed: boolean }> {
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} is not the dispatcher; dropped thinking is recorded by the controller and its hosts`);
    onlyKnown(command, ["commandId", "projectId", "taskId", "model", "dropped", "kept"]);
    const projectId = PROJECT.test(String(command.projectId)) ? command.projectId : invalid("projectId", "is not a project ID");
    const taskId = TASK.test(String(command.taskId)) ? command.taskId : invalid("taskId", "is not a task ID");
    const model = text(command.model, "model", { min: 1, max: THINKING_LIMITS.model });
    const count = (v: unknown, field: string): number => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000 ? (v as number) : invalid(field, "must be a whole number from 0 to 1000000"));
    const dropped = count(command.dropped, "dropped"); const kept = count(command.kept, "kept");
    if (dropped === 0) invalid("dropped", "nothing was dropped; there is nothing to record");
    const id = derivedId("tdp", scopedCommandId(by.id, command.commandId));
    const r = await this.#runner.command("thinking.drop", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { projectId, taskId, model, dropped, kept },
      build: async () => {
        const ref: AggregateRef = { kind: "thinking-drop", id };
        const body: ThinkingDropBody = { projectId, taskId, model, dropped, kept, at: this.#runner.now(), by: by.id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { taskId, model, dropped, kept } };
      },
    }));
    return { id, replayed: r.replayed };
  }

  /** The recorded drops of one task, oldest first, for the owner. */
  async drops(by: Principal, taskId: string): Promise<View<ThinkingDropBody>[]> {
    if (by.kind !== "owner") return [];
    if (!TASK.test(taskId)) invalid("taskId", "is not a task ID");
    const out: View<ThinkingDropBody>[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list("thinking-drop", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) { after = a.id; if ((a.body as unknown as ThinkingDropBody).taskId === taskId) out.push(view<ThinkingDropBody>(a)); }
      if (page.length < 200) return out;
    }
  }
}

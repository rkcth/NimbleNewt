import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { ThinkingBlock, ThinkingSource } from "./thinking.js";

/**
 * Collected model thinking (card U09b). The worker process reports the thinking blocks its model returned (`thinking` on the worker channel); this store keeps them, bounded, so the owner can see what the model was working on
 * through `ThinkingService` (owner only, inspection policy, redaction, a recorded look) and the replay of a task (U09). It is the `ThinkingSource` of that service.
 *
 * - **Untrusted text.** A block is the model's own output. Before it is stored, control characters (and invisible formatting such as bidirectional overrides) are removed, the text goes through the secret redaction used for private
 *   scratch, and it is cut to `THINKING_COLLECT.blockChars`. It is shown labelled as model output and is never given back to any model, agent or tool as an instruction: no code path reads it except the owner's look.
 * - **Bounded.** One record per task holds at most `blocksKept` blocks (the newest; older ones are counted in `dropped`), a message holds at most `blocksPerMessage`, a block at most `blockChars` characters.
 * - **Retention.** The record is removed by the retention rule `thinkingDays` (14 days after the task is finished) and leaves a small marker (`removedAt`); nothing is collected for a task after that.
 * - **Owner switch.** The owner turns collection off or on (`setCollection`, default on). Off stops new blocks being kept; blocks kept earlier stay until retention removes them.
 * - **Replay safe.** Each block is kept once: a message sent again (same command) is answered as before, and a block at or below the highest (entry, block) seen from the same attempt is skipped.
 * - **Who writes, who reads.** Only the controller side (a host or a service principal) records, and only for the task's current attempt (the caller checks that, as for compaction notes). Nobody but `ThinkingService` reads, and it reads only for the owner.
 */
export const THINKING_COLLECT = { blockChars: 4000, blocksPerMessage: 50, blocksKept: 200, inputChars: 64_000, marks: 20, modelChars: 200, providerChars: 80, idChars: 200 } as const;

export const THINKING_RECORD = "thinking-record";
const COLLECTION: AggregateRef = { kind: "thinking-collection", id: "installation" };
const PROJECT = /^proj-[a-z2-7]{20}$/;
const TASK = /^task-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/** One block as the worker process reported it. */
export interface ReportedThinking { readonly entryId: number; readonly block: number; readonly provider: string; readonly model: string; readonly text: string; readonly opaque: boolean }

/** One stored block. `seq` is the order in which the task's blocks were kept (it never repeats, even after older blocks were dropped) and is what the owner's cursor counts. */
export interface StoredThinkingBlock {
  readonly seq: number; readonly attemptId: string; readonly entryId: number; readonly block: number; readonly provider: string; readonly model: string;
  readonly text: string; readonly opaque: boolean; readonly truncated: boolean; readonly redacted: boolean; readonly at: string;
}
export interface ThinkingRecordBody {
  readonly projectId: string; readonly taskId: string; readonly agent: string;
  /** The `seq` of the next block. */
  readonly next: number;
  readonly blocks: readonly StoredThinkingBlock[];
  /** Blocks pushed out by the bound (or removed by retention) and no longer readable. */
  readonly dropped: number;
  /** The highest (entry, block) kept from each of the latest attempts. */
  readonly marks: readonly { readonly attemptId: string; readonly entryId: number; readonly block: number }[];
  readonly removedAt?: string;
  readonly updatedAt: string;
}
export interface ThinkingCollectionBody { readonly enabled: boolean; readonly updatedBy: string; readonly updatedAt: string }

/** Code point ranges removed from model text: C0 controls except tab and newline, DEL and C1, soft hyphen, bidirectional and invisible formatting, line and paragraph separators, annotation marks. */
const HIDDEN: readonly (readonly [number, number])[] = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff], [0xfff9, 0xfffb]];
const withoutHidden = (text: string): string => { let out = ""; for (const ch of text) { const cp = ch.codePointAt(0)!; if (!HIDDEN.some(([a, b]) => cp >= a && cp <= b)) out += ch; } return out; };

/** What untrusted thinking text becomes before it is kept: bounded input, control and invisible characters gone, credential shapes replaced, cut to size at a character boundary. */
export function cleanThinking(raw: string): { text: string; truncated: boolean; redacted: boolean } {
  const capped = raw.length > THINKING_COLLECT.inputChars ? raw.slice(0, THINKING_COLLECT.inputChars) : raw;
  const stripped = withoutHidden(capped.replace(/\r\n?/g, "\n")).normalize("NFC");
  const hidden = redactText(stripped);
  let text = hidden;
  let truncated = raw.length > capped.length;
  if (text.length > THINKING_COLLECT.blockChars) {
    let end = THINKING_COLLECT.blockChars;
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1;
    text = text.slice(0, end);
    truncated = true;
  }
  return { text, truncated, redacted: hidden !== stripped };
}

const recordIdOf = (taskId: string): string => derivedId("tkr", `record\0${taskId}`);
const before = (a: { entryId: number; block: number }, b: { entryId: number; block: number }): boolean => a.entryId < b.entryId || (a.entryId === b.entryId && a.block < b.block);

export class ThinkingStore {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): ThinkingStore { return new ThinkingStore(new CommandRunner(storage, epoch, options)); }

  /** The owner turns collection on or off (default on). Without `expectedRevision` it creates the setting; with it, it replaces it. */
  async setCollection(owner: Principal, command: NoActor & { enabled: boolean; expectedRevision?: number }): Promise<{ revision: number; replayed: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner decides whether the model's thinking is collected`);
    onlyKnown(command, ["commandId", "enabled", "expectedRevision"]);
    if (typeof command.enabled !== "boolean") invalid("enabled", "must be true or false");
    const expected = command.expectedRevision === undefined ? undefined : checkRevision(command.expectedRevision);
    const r = await this.#runner.command("thinking.collection", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { enabled: command.enabled, expectedRevision: expected ?? null },
      build: async () => {
        const body: ThinkingCollectionBody = { enabled: command.enabled, updatedBy: owner.id, updatedAt: this.#runner.now() };
        const current = await this.#runner.get(COLLECTION.kind, COLLECTION.id);
        if (expected === undefined) {
          if (current !== undefined) throw new DomainError("stale_revision", "the collection setting already exists; give expectedRevision to replace it", { currentRevision: current.revision });
          return { ref: COLLECTION, creates: true, changes: [{ type: "create", ref: COLLECTION, body: body as unknown as JsonObject }], detail: { enabled: body.enabled } };
        }
        if (current === undefined || current.revision !== expected) throw new DomainError("stale_revision", `the collection setting is at revision ${current?.revision ?? 0}, not ${expected}`, ...(current === undefined ? [] : [{ currentRevision: current.revision }]));
        return { ref: COLLECTION, creates: false, changes: [{ type: "update", ref: COLLECTION, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { enabled: body.enabled } };
      },
    }));
    return { revision: r.revision, replayed: r.replayed };
  }

  /** Whether thinking is collected (on unless the owner turned it off). Owner, host and service may ask; anyone else is refused. */
  async collection(by: Principal): Promise<{ enabled: boolean; revision: number }> {
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} may not read the thinking collection setting`);
    return this.#collection();
  }
  async #collection(): Promise<{ enabled: boolean; revision: number }> {
    const found = await this.#runner.get(COLLECTION.kind, COLLECTION.id);
    // A damaged record reads as on: the bounds and the redaction hold either way, and the owner's wish to switch it off is not guessed.
    return found === undefined ? { enabled: true, revision: 0 } : { enabled: (found.body as unknown as ThinkingCollectionBody).enabled !== false, revision: found.revision };
  }

  /**
   * The controller keeps the thinking an attempt's process reported. Only a host or a service records (the caller has checked the attempt is the task's current one). Blocks are cleaned, bounded and kept once; nothing is kept while the owner's
   * switch is off or after retention removed the task's thinking. Returns how many blocks were kept. A repeat of the same message keeps nothing more.
   */
  async record(by: Principal, input: { projectId: string; taskId: string; agent: string; attemptId: string; blocks: readonly ReportedThinking[] }): Promise<{ kept: number; reason?: "off" | "removed" | "nothing-new" }> {
    if (!(by.kind === "host" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} is not the controller; thinking is recorded by the controller and its hosts`);
    const projectId = PROJECT.test(String(input.projectId)) ? input.projectId : invalid("projectId", "is not a project ID");
    const taskId = TASK.test(String(input.taskId)) ? input.taskId : invalid("taskId", "is not a task ID");
    const text = (v: unknown, field: string, max: number): string => (typeof v === "string" && v.length >= 1 && v.length <= max ? v : invalid(field, `must be text of 1 to ${max} characters`));
    const agent = text(input.agent, "agent", THINKING_COLLECT.idChars);
    const attemptId = text(input.attemptId, "attemptId", THINKING_COLLECT.idChars);
    if (!Array.isArray(input.blocks) || input.blocks.length === 0 || input.blocks.length > THINKING_COLLECT.blocksPerMessage) invalid("blocks", `must be 1 to ${THINKING_COLLECT.blocksPerMessage} blocks`);
    const whole = (v: unknown, field: string): number => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000_000 ? (v as number) : invalid(field, "must be a whole number"));
    const given = input.blocks.map((b) => {
      if (b === null || typeof b !== "object") return invalid("blocks", "each block is an object");
      onlyKnown(b as unknown as Record<string, unknown>, ["entryId", "block", "provider", "model", "text", "opaque"]);
      if (typeof b.opaque !== "boolean") invalid("opaque", "must be true or false");
      if (typeof b.text !== "string") invalid("text", "must be text");
      return { entryId: whole(b.entryId, "entryId"), block: whole(b.block, "block"), provider: text(b.provider, "provider", THINKING_COLLECT.providerChars), model: text(b.model, "model", THINKING_COLLECT.modelChars), text: b.text, opaque: b.opaque };
    });
    if ((await this.#collection()).enabled === false) return { kept: 0, reason: "off" };
    // The command ID names the message (the attempt and the blocks it carries), so the same message sent again is the same command.
    const digest = createHash("sha256").update(JSON.stringify([taskId, attemptId, given.map((b) => [b.entryId, b.block, b.provider, b.model, b.opaque, createHash("sha256").update(b.text).digest("hex")])])).digest("hex");
    const ref: AggregateRef = { kind: THINKING_RECORD, id: recordIdOf(taskId) };
    let outcome: { kept: number; reason?: "removed" | "nothing-new" } = { kept: 0 };
    for (let tries = 0; ; tries++) {
      outcome = { kept: 0 };
      try {
        const r = await this.#runner.command("thinking.record", { commandId: `tkr-${digest.slice(0, 40)}`, actor: by.id }, async () => ({
          payload: { projectId, taskId, agent, attemptId, digest },
          build: async () => {
            const current = await this.#runner.get(ref.kind, ref.id);
            const was = current?.body as unknown as ThinkingRecordBody | undefined;
            if (was?.removedAt !== undefined) { outcome = { kept: 0, reason: "removed" }; throw new DomainError("invalid_transition", "removed"); }
            const marks = new Map((was?.marks ?? []).map((m) => [m.attemptId, m] as const));
            const seen = marks.get(attemptId);
            const fresh = [...given].sort((a, b) => a.entryId - b.entryId || a.block - b.block).filter((b, i, all) => (seen === undefined || before(seen, b)) && (i === 0 || all[i - 1]!.entryId !== b.entryId || all[i - 1]!.block !== b.block));
            if (fresh.length === 0) { outcome = { kept: 0, reason: "nothing-new" }; throw new DomainError("invalid_transition", "nothing new"); }
            const at = this.#runner.now();
            let next = was?.next ?? 0;
            const added: StoredThinkingBlock[] = fresh.map((b) => {
              const clean = b.opaque ? { text: "", truncated: false, redacted: false } : cleanThinking(b.text);
              return { seq: next++, attemptId, entryId: b.entryId, block: b.block, provider: b.provider, model: b.model, text: clean.text, opaque: b.opaque, truncated: clean.truncated, redacted: clean.redacted, at };
            });
            const all = [...(was?.blocks ?? []), ...added];
            const cut = Math.max(0, all.length - THINKING_COLLECT.blocksKept);
            const top = fresh[fresh.length - 1]!;
            marks.delete(attemptId);
            marks.set(attemptId, { attemptId, entryId: top.entryId, block: top.block });
            const body: ThinkingRecordBody = {
              projectId, taskId, agent, next, blocks: all.slice(cut), dropped: (was?.dropped ?? 0) + cut,
              marks: [...marks.values()].slice(-THINKING_COLLECT.marks), updatedAt: at,
            };
            outcome = { kept: added.length };
            const change = current === undefined ? { type: "create" as const, ref, body: body as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: current.revision, body: body as unknown as JsonObject };
            return { ref, creates: current === undefined, changes: [change], detail: { taskId, kept: added.length, dropped: cut } };
          },
        }));
        // A message the controller already applied (the same command) keeps nothing now.
        return r.replayed ? { kept: 0, reason: "nothing-new" } : outcome;
      } catch (error) {
        if (error instanceof DomainError && error.code === "invalid_transition" && outcome.reason !== undefined) return outcome;
        // A writer of the same record won the race (the other attempt's message): the message is built again from what is there now.
        if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict") && tries < 5) continue;
        throw error;
      }
    }
  }

  /** The `ThinkingSource` of `ThinkingService`: the task's kept blocks, oldest first, numbered by `seq`. A task with no record, or whose thinking retention removed, has none. */
  source(): ThinkingSource {
    return {
      read: async ({ projectId, taskId }) => {
        if (!TASK.test(taskId)) return undefined;
        const found = await this.#runner.get(THINKING_RECORD, recordIdOf(taskId));
        const body = found?.body as unknown as ThinkingRecordBody | undefined;
        if (body === undefined || body.removedAt !== undefined || body.projectId !== projectId) return undefined;
        const blocks: ThinkingBlock[] = body.blocks.map((b) => ({ entryId: b.seq, provider: b.provider, model: b.model, text: b.text, opaque: b.opaque }));
        return { agent: body.agent, blocks };
      },
    };
  }

  /** When retention removed a task's kept thinking, if it did (for the replay's marker). */
  async removedAt(task: { readonly projectId: string; readonly taskId: string }): Promise<string | undefined> {
    if (!TASK.test(task.taskId)) return undefined;
    const body = (await this.#runner.get(THINKING_RECORD, recordIdOf(task.taskId)))?.body as unknown as ThinkingRecordBody | undefined;
    return body === undefined || body.projectId !== task.projectId ? undefined : body.removedAt;
  }

  /** How much is kept for a task, for the owner's view: the blocks, the ones pushed out, the time of the last. Nothing of the text. */
  async summary(by: Principal, taskId: string): Promise<{ kept: number; dropped: number; updatedAt?: string; removedAt?: string } | undefined> {
    if (by.kind !== "owner") return undefined;
    if (!TASK.test(taskId)) invalid("taskId", "is not a task ID");
    const body = (await this.#runner.get(THINKING_RECORD, recordIdOf(taskId)))?.body as unknown as ThinkingRecordBody | undefined;
    return body === undefined ? undefined : { kept: body.blocks.length, dropped: body.dropped, updatedAt: body.updatedAt, ...(body.removedAt === undefined ? {} : { removedAt: body.removedAt }) };
  }
}

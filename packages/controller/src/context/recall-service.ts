import type { Principal } from "../security/principals.js";
import { RECALL_CALLS_BOUNDS } from "./route-settings.js";
import { RecallArgumentError, composeRecall, parseRecallArgs, type RecallAnswer, type RecallSource } from "./recall.js";

/**
 * Card W13: the service behind `task.recall`. It answers one call for one attempt: the arguments are read (an unknown name, such as a task, is refused), the owner's switch and the attempt's call cap are applied, the records are
 * read for the attempt's own task and the answer is composed. It writes nothing; the only state is the count of calls per attempt, in memory and bounded, so a looping agent cannot flood (a repeat of a call it already made is
 * answered again and costs nothing, as a replayed bridge call is; a restart of the controller starts the count again).
 */
export interface RecallSettings { readonly recall: boolean; readonly recallCalls: number }
export interface RecallServiceDeps {
  readonly read: (attemptId: string, by: Principal) => Promise<RecallSource | undefined>;
  /** The owner's switch and cap, read at every call. A read that fails leaves the defaults (on, 20 calls). */
  readonly settings?: () => Promise<{ readonly recall?: boolean; readonly recallCalls?: number }>;
}
export type RecallReply =
  | { readonly ok: true; readonly result: RecallAnswer }
  | { readonly ok: false; readonly code: string; readonly message: string };

const KEEP_ATTEMPTS = 512;

export class RecallService {
  readonly #deps: RecallServiceDeps;
  readonly #calls = new Map<string, Set<string>>();
  constructor(deps: RecallServiceDeps) { this.#deps = deps; }

  /** The owner's settings now. */
  async settings(): Promise<RecallSettings> {
    let s: { recall?: boolean; recallCalls?: number } = {};
    try { s = (await this.#deps.settings?.()) ?? {}; } catch { /* the defaults stand */ }
    const n = s.recallCalls;
    return { recall: s.recall !== false, recallCalls: typeof n === "number" && Number.isSafeInteger(n) && n >= RECALL_CALLS_BOUNDS.min && n <= RECALL_CALLS_BOUNDS.max ? n : RECALL_CALLS_BOUNDS.default };
  }

  /** How many distinct calls the attempt has made (tests and the owner's view). */
  used(attemptId: string): number { return this.#calls.get(attemptId)?.size ?? 0; }

  async recall(ctx: { readonly attemptId: string; readonly callId: string; readonly by: Principal }, args: Readonly<Record<string, unknown>>): Promise<RecallReply> {
    let query;
    try { query = parseRecallArgs(args); } catch (error) { if (error instanceof RecallArgumentError) return { ok: false, code: "invalid_command", message: error.message }; throw error; }
    const settings = await this.settings();
    if (!settings.recall) return { ok: false, code: "recall_off", message: "task.recall is switched off by the owner; work from your notes and the task's own text" };
    let seen = this.#calls.get(ctx.attemptId);
    if (seen === undefined || !seen.has(ctx.callId)) {
      if ((seen?.size ?? 0) >= settings.recallCalls) return { ok: false, code: "recall_limit", message: `this attempt has used its ${settings.recallCalls} calls of task.recall (the owner's limit); work from what you have already read, and keep notes with work.note` };
      if (seen === undefined) {
        seen = new Set();
        this.#calls.set(ctx.attemptId, seen);
        while (this.#calls.size > KEEP_ATTEMPTS) this.#calls.delete(this.#calls.keys().next().value as string);
      }
      seen.add(ctx.callId);
    }
    const source = await this.#deps.read(ctx.attemptId, ctx.by);
    if (source === undefined) return { ok: false, code: "unavailable", message: "the task's records could not be read just now; ask again" };
    return { ok: true, result: await composeRecall(source, query) };
  }
}

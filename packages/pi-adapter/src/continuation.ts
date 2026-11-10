import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { GenerationTask, defineDoc, hook, type Conversation, type Harness, type HookRegistration } from "@earendil-works/pi-durable";

/**
 * Continuing a turn that yields early (card W04). Pi Durable's generation task asks its `onYield` hooks about every final answer; the first `continue` appends a user message and hands the run to a successor generation, so the SAME turn (the same
 * submission, the same request ID) goes on. The adapter installs that hook for its root conversation only, counts the continuations of each turn in a Pi Durable document of the conversation (so a worker or controller restart resumes the count instead
 * of starting it again), and asks the embedder's policy whether to continue at all. The count is bounded: at most `max` continuations per turn, then the answer stands and the turn ends as it ended.
 */

/** Every continuation's text starts with this, so the adapter can tell its own nudges from an input the controller sent (a nudge does not start a new request's segment of the transcript). */
export const CONTINUATION_MARK = "[NimbleNewt: the turn goes on]";
/** The default and the highest number of continuations per turn. */
export const DEFAULT_MAX_CONTINUATIONS = 3;
export const MAX_CONTINUATIONS_LIMIT = 10;

/** What the hook saw of the final answer it is asked about. */
export interface YieldedAnswer {
  /** Pi's stop reason (`stop`, `length`, or `toolUse` with no call). */
  readonly stopReason: string;
  /** The answer's visible text (thinking is not visible text). */
  readonly visibleText: string;
  /** Whether the answer holds a tool call that was not run (a cut-off or stop-ended reply). */
  readonly hasToolCall: boolean;
}

export interface ContinuationPolicy {
  /** Continuations per turn (default 3, at most 10; 0 switches them off). */
  readonly max?: number;
  /**
   * Asked once for a final answer of the root conversation's current turn while continuations remain: the text to continue with (the adapter puts `CONTINUATION_MARK` in front), or undefined to let the answer end the turn. `n` is the number this
   * continuation would have (1-based). A throw is undefined. The decision is stored with the answer's generation, so a restart that asks again about the same answer gets the same decision without asking.
   */
  decide(answer: YieldedAnswer, ask: { readonly n: number; readonly max: number; readonly turn: string }): Promise<string | undefined>;
  /** Told when the hook itself failed (the answer then ends the turn). */
  readonly onError?: (error: unknown) => void;
}

/** The count, per turn: which turn is current, how many continuations it was given (and how many of those followed a `length` stop), and whether the agent already ended its work (then nothing more is continued). */
export interface ContinuationState {
  readonly turn: string | null;
  readonly used: number;
  readonly length: number;
  readonly ended: boolean;
}
type StateDoc = { turn: string | null; used: number; length: number; ended: boolean } & Record<string, never>;

export const Continuations = defineDoc<StateDoc>({
  kind: "nimblenewt.continuations",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ turn: null, used: 0, length: 0, ended: false }) as unknown as StateDoc,
});

const MEMO = "nn.continuation";

/** The text of a user message (a string, or its text parts). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p !== null && typeof p === "object" && (p as { type?: unknown }).type === "text" ? String((p as { text?: unknown }).text ?? "") : "")).join("");
}

/** Whether a stored entry is one of the adapter's continuations. */
export function isContinuation(entry: { readonly kind: string; readonly model?: readonly unknown[] }): boolean {
  return entry.kind === "pi.user" && textOf((entry.model?.[0] as { content?: unknown } | undefined)?.content).startsWith(CONTINUATION_MARK);
}

/** The bound the policy asks for, checked. */
export function continuationMax(policy: ContinuationPolicy | undefined): number {
  const max = policy?.max ?? DEFAULT_MAX_CONTINUATIONS;
  if (!Number.isSafeInteger(max) || max < 0 || max > MAX_CONTINUATIONS_LIMIT) throw new RangeError(`continuation max must be a whole number from 0 to ${MAX_CONTINUATIONS_LIMIT}`);
  return max;
}

/** Reads the state of a conversation. */
export async function readContinuations(harness: Harness, conversation: Conversation): Promise<ContinuationState> {
  const doc = await harness.snapshot(Continuations, conversation.id, context) as unknown as ContinuationState | undefined;
  return { turn: doc?.turn ?? null, used: doc?.used ?? 0, length: doc?.length ?? 0, ended: doc?.ended === true };
}

/** Makes `turn` the current turn: a new turn starts at 0; the same turn (a restarted process running the same request again) keeps its count. */
export async function beginTurn(conversation: Conversation, turn: string): Promise<ContinuationState> {
  return await conversation.commit(async (tx) => {
    const doc = await tx.doc(Continuations, conversation.id) as unknown as { turn: string | null; used: number; length: number; ended: boolean };
    if (doc.turn !== turn) { doc.turn = turn; doc.used = 0; doc.length = 0; doc.ended = false; }
    return { turn: doc.turn, used: doc.used, length: doc.length, ended: doc.ended };
  }, context);
}

/** The agent ended its work in this turn (its work.end was accepted): no further continuation for it. */
export async function markEnded(conversation: Conversation): Promise<void> {
  await conversation.commit(async (tx) => { (await tx.doc(Continuations, conversation.id) as unknown as { ended: boolean }).ended = true; }, context);
}

/** Records continuation `n` of `turn`; idempotent (a repeat of the same `n` changes nothing), and nothing is written for a turn that is no longer current. */
async function record(conversation: Conversation, turn: string, n: number, length: boolean): Promise<void> {
  await conversation.commit(async (tx) => {
    const doc = await tx.doc(Continuations, conversation.id) as unknown as { turn: string | null; used: number; length: number };
    if (doc.turn !== turn || doc.used >= n) return;
    doc.used = n;
    if (length) doc.length += 1;
  }, context);
}

interface Decision { readonly go: boolean; readonly n?: number; readonly turn?: string; readonly text?: string; readonly length?: boolean }

/**
 * The `onYield` hook. Order of a decision: the generation's stored decision, if any (a restart asking again about the same answer); otherwise the turn's state (no current turn, an ended turn, or the bound reached: no continuation); otherwise the
 * policy. The decision is stored in the generation's memo before the count is written, and the count is written before the continuation is returned, so a crash anywhere repeats the same decision or loses a continuation, never adds one.
 */
export function continuationHooks(policy: ContinuationPolicy | undefined, root: () => Conversation | undefined): readonly HookRegistration[] {
  if (policy === undefined) return [];
  const max = continuationMax(policy);
  if (max === 0) return [];
  return [hook(GenerationTask, {
    onYield: async (answer, api) => {
      const conversation = root();
      if (conversation === undefined || api.conversationId !== conversation.id) return undefined;
      try {
        const go = (d: Decision): Promise<{ readonly continue: string } | undefined> | undefined => {
          if (!d.go || d.n === undefined || d.turn === undefined || d.text === undefined) return undefined;
          return record(conversation, d.turn, d.n, d.length === true).then(() => ({ continue: d.text! }));
        };
        const stored = await api.memo<JsonValue>(MEMO, context) as Decision | undefined;
        if (stored !== undefined) return await go(stored);
        const state = await api.snapshot(Continuations, api.conversationId, context) as unknown as Partial<ContinuationState> | undefined;
        const turn = state?.turn ?? null;
        const used = state?.used ?? 0;
        let decision: Decision = { go: false };
        if (turn !== null && state?.ended !== true && used < max) {
          const content = answer.content ?? [];
          const yielded: YieldedAnswer = {
            stopReason: String(answer.stopReason),
            visibleText: content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(""),
            hasToolCall: content.some((c) => c.type === "toolCall"),
          };
          let text: string | undefined;
          try { text = await policy.decide(yielded, { n: used + 1, max, turn }); } catch (error) { text = undefined; policy.onError?.(error); }
          if (text !== undefined) decision = { go: true, n: used + 1, turn, text: `${CONTINUATION_MARK} ${text}`, length: yielded.stopReason === "length" };
        }
        // The first stored decision wins: a second run of this hook for the same answer (after a restart) reads it back.
        const winner = await api.memo<JsonValue>(MEMO, decision as unknown as JsonValue, context) as unknown as Decision;
        return await go(winner);
      } catch (error) {
        try { policy.onError?.(error); } catch { /* the answer ends the turn */ }
        return undefined;
      }
    },
  })];
}

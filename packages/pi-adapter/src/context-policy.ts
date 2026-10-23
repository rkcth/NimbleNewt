import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { CompactionTask, hook, type HookRegistration, type Harness } from "@earendil-works/pi-durable";

type Settings = NonNullable<Parameters<typeof Harness.open>[1]["settings"]>;

/** What Pi asks the controller's summariser. `key` is the same after a restart (the conversation and the first entry kept), so the controller can recognise a compaction it has already done. */
export interface CompactionRequest {
  readonly key: string;
  readonly reason: "manual" | "threshold" | "overflow";
  /** The conversation being replaced by the summary, as plain text. */
  readonly text: string;
  readonly messageCount: number;
  readonly instructions?: string;
  /** Aborts when the adapter stops waiting (its ceiling passed, or the callback failed): the callback must stop and must not publish anything that the conversation will not have. */
  readonly signal: AbortSignal;
}
export type CompactionDecision = { readonly decline: true } | { readonly summary: string };

/**
 * Context limits the controller sets explicitly instead of inheriting the provider SDK's defaults (card C07b). All optional; an absent field leaves Pi's default.
 */
export interface AdapterContextPolicy {
  /** The model stream's timeout in ms (Pi's default is the provider SDK's, ten minutes). */
  readonly streamTimeoutMs?: number;
  /** Provider SDK retries inside one request attempt (the SDK default is 2). */
  readonly streamMaxRetries?: number;
  /** Per-tool result limit applied to every adapter tool (Pi's `outputLimits`; its default is 50 KB or 2,000 lines). */
  readonly toolOutputBytes?: number;
  readonly toolOutputLines?: number;
  /**
   * Called by Pi's `beforeCompact` hook: return a summary, decline the compaction, or return nothing to leave it to Pi. The first answer for a compaction is stored in the conversation (a Pi memo), so a
   * restart in the middle of the hook asks again only if no answer had been stored, and never stores two.
   */
  readonly beforeCompact?: (request: CompactionRequest) => Promise<CompactionDecision | undefined>;
  /**
   * The adapter's own ceiling on that call, whatever the callback does (default 150,000 ms). If it passes, or the callback throws, the compaction is declined (and the decline is remembered): Pi's own
   * summariser is not tried, because it is the model that is out of room. The conversation then overflows on its next request, which ends the attempt as `context_overflow` instead of hanging.
   */
  readonly beforeCompactTimeoutMs?: number;
  /** Told when the callback timed out or threw (a `CompactionHookTimeout` for the ceiling), so the controller can record the overflow. */
  readonly onHookFailure?: (error: unknown, request: CompactionRequest) => void;
}

const positive = (v: unknown, name: string): void => { if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) throw new RangeError(`contextPolicy.${name} must be a positive number`); };

/** The error thrown when the hook's ceiling passes. The wording is the one `classifyFailure` recognises as a context failure. */
export class CompactionHookTimeout extends Error {
  constructor(ms: number) { super(`Context compression timed out after ${ms} ms in the beforeCompact hook`); this.name = "CompactionHookTimeout"; }
}

function textOf(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    const body = typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content) ? msg.content.map((c: { type?: string; text?: string; name?: string }) => (c.type === "text" && typeof c.text === "string" ? c.text : c.type === "toolCall" ? `[tool call ${c.name ?? ""}]` : `[${c.type ?? "content"}]`)).join("\n") : "";
    parts.push(`${msg.role ?? "message"}: ${body}`);
  }
  return parts.join("\n\n");
}

/** Pi settings and hooks for a context policy. Explicit settings the caller passed stay unless the policy names the same field. */
export function applyContextPolicy(policy: AdapterContextPolicy | undefined, settings: Settings | undefined): { settings: Settings | undefined; hooks: readonly HookRegistration[]; toolLimits: { maxBytes?: number; maxLines?: number } } {
  if (policy === undefined) return { settings, hooks: [], toolLimits: {} };
  for (const name of ["streamTimeoutMs", "streamMaxRetries", "toolOutputBytes", "toolOutputLines", "beforeCompactTimeoutMs"] as const) positive(policy[name], name);
  const stream = { ...(settings?.stream ?? {}), ...(policy.streamTimeoutMs === undefined ? {} : { timeoutMs: policy.streamTimeoutMs }), ...(policy.streamMaxRetries === undefined ? {} : { maxRetries: policy.streamMaxRetries }) };
  const merged: Settings = { ...(settings ?? {}), ...(Object.keys(stream).length === 0 ? {} : { stream }) };
  const ceiling = policy.beforeCompactTimeoutMs ?? 150_000;
  const hooks: HookRegistration[] = [];
  const decide = policy.beforeCompact;
  if (decide !== undefined) {
    hooks.push(hook(CompactionTask, {
      beforeCompact: async (c, api) => {
        const memoKey = `nn.compaction.${String(c.firstKept)}`;
        const stored = await api.memo<JsonValue>(memoKey, context);
        const decode = (v: JsonValue | undefined): { decline: true } | { summary: string } | undefined => {
          const o = v as { decline?: boolean; summary?: string } | null | undefined;
          return o?.decline === true ? { decline: true } : typeof o?.summary === "string" ? { summary: o.summary } : undefined;
        };
        if (stored !== undefined) return decode(stored);
        let timer: NodeJS.Timeout | undefined;
        const stop = new AbortController();
        const request: CompactionRequest = { signal: stop.signal, key: `${String(api.conversationId)}:${String(c.firstKept)}`, reason: c.reason, text: textOf(c.messages), messageCount: c.messages.length, ...(c.instructions === undefined ? {} : { instructions: c.instructions }) };
        let decision: CompactionDecision | undefined;
        try {
          decision = await Promise.race([
            decide(request),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CompactionHookTimeout(ceiling)), ceiling); }),
          ]);
        } catch (error) {
          // Pi would otherwise fall back to its own summariser (the same model); declining is remembered like any answer.
          decision = { decline: true };
          stop.abort();
          try { policy.onHookFailure?.(error, request); } catch { /* the report must not change the outcome */ }
        } finally { clearTimeout(timer); }
        // The first stored answer wins: a second run (after a restart, or a racing run) reads it back instead of writing another.
        const winner = await api.memo<JsonValue>(memoKey, (decision === undefined ? { none: true } : decision) as JsonValue, context);
        return decode(winner);
      },
    }));
  }
  return { settings: merged, hooks, toolLimits: { ...(policy.toolOutputBytes === undefined ? {} : { maxBytes: policy.toolOutputBytes }), ...(policy.toolOutputLines === undefined ? {} : { maxLines: policy.toolOutputLines }) } };
}

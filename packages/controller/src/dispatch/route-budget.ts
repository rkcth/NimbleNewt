import type { RouteBudget } from "../routing/policy.js";

/**
 * A route's length and reasoning budget in the request a provider receives (card W07). The relay applies it to every model call of the route, after the agent's runtime built the request, so the owner's figures are what the provider sees
 * whatever the runtime asked for. Each provider names the fields differently; the names come from the endpoint's configured kind (the same kinds as the inference-cache profiles, C06) and the wire format of the call:
 *
 * | wire              | kind                                   | reply limit             | reasoning cap                                     |
 * |-------------------|----------------------------------------|-------------------------|---------------------------------------------------|
 * | messages          | any                                    | `max_tokens`            | `thinking.budget_tokens` (only a fixed `enabled` budget; adaptive thinking: not sent) |
 * | chat/completions  | `openai`                               | `max_completion_tokens` | not sent: OpenAI takes an effort level, not tokens |
 * | chat/completions  | `vllm`, `radiance` (vLLM)              | `max_tokens`            | `thinking_token_budget` (see below)               |
 * | chat/completions  | `llama-cpp`                            | `max_tokens`            | `thinking_budget_tokens`                          |
 * | chat/completions  | `strata`, `openai-compatible`          | `max_tokens`            | not sent: no known field                          |
 * | chat/completions  | `claude`, `generic`, none or unknown   | not sent                | not sent                                          |
 *
 * A figure that is not sent is said in `notSent` with the reason, so it is recorded and never silently dropped. A reply limit replaces what the runtime asked for; a reasoning cap only lowers a budget the request already has, or sets one
 * where the request reasons, and never makes a call reason that did not (it is a cap). The reasoning field names are those Pi itself uses for these servers (`@earendil-works/pi-ai` compat `thinkingTokenBudgetField`).
 *
 * vLLM refuses `thinking_token_budget` with a 400 when the server has no reasoning parser ("thinking_token_budget is set but reasoning_config is not configured", `vllm/v1/engine/input_processor.py`), so a field the relay adds (the
 * runtime did not send one) is reported in `added`; the relay sends the call again without it when the server refuses it, and from then on the attempt passes `addReasoning: false`, so the cap is recorded as not sent instead of making
 * every call of the route fail. A budget field the runtime sent itself is only lowered.
 */
export interface BudgetApplied {
  /** The fields set in the request, by their name in the wire format. */
  readonly sent: Readonly<Record<string, number>>;
  /** What was not sent, and why (plain words). */
  readonly notSent: readonly string[];
  /** The reasoning field the relay added to a request that had none (a server may refuse it; see above). */
  readonly added?: string;
}

/** Anthropic's smallest reasoning budget. A cap below it turns reasoning off for the call, which stays within the cap. */
export const ANTHROPIC_MIN_THINKING = 1024;
const CHAT_REASONING: Readonly<Record<string, string | undefined>> = { vllm: "thinking_token_budget", radiance: "thinking_token_budget", "llama-cpp": "thinking_budget_tokens", strata: undefined, "openai-compatible": undefined };
const CHAT_KINDS = new Set(["openai", ...Object.keys(CHAT_REASONING)]);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Applies `budget` to a request body (a JSON object, changed in place) of `wire` for an endpoint of `kind`. */
export function applyRouteBudget(body: Record<string, unknown>, wire: "chat/completions" | "messages", kind: string | undefined, budget: RouteBudget, options: { /** false: a reasoning field the request does not carry is not added (the server refused one). */ readonly addReasoning?: boolean } = {}): BudgetApplied {
  const sent: Record<string, number> = {};
  let added: string | undefined;
  const notSent: string[] = [];
  const { maxTokens, reasoningTokens } = budget;
  if (maxTokens === undefined && reasoningTokens === undefined) return { sent, notSent };
  if (wire === "messages") {
    if (maxTokens !== undefined) { body["max_tokens"] = maxTokens; sent["max_tokens"] = maxTokens; }
    const thinking = body["thinking"];
    const type = thinking !== null && typeof thinking === "object" && !Array.isArray(thinking) ? (thinking as { type?: unknown }).type : undefined;
    if (type === "enabled") {
      // A fixed budget (the models that take one). Lowered to the cap, and always kept below max_tokens: Anthropic refuses `budget_tokens >= max_tokens`, so a lower reply limit alone would otherwise make every call of the route fail.
      const ceiling = num(body["max_tokens"]);
      const asked = num((thinking as { budget_tokens?: unknown }).budget_tokens);
      const cap = Math.min(reasoningTokens ?? Infinity, asked ?? Infinity, ceiling === undefined ? Infinity : ceiling - 1);
      if (Number.isFinite(cap) && cap !== asked) {
        if (cap < ANTHROPIC_MIN_THINKING) {
          body["thinking"] = { type: "disabled" };
          notSent.push(reasoningTokens !== undefined && cap === reasoningTokens
            ? `the reasoning cap (${reasoningTokens} tokens) is below the provider's smallest reasoning budget (${ANTHROPIC_MIN_THINKING}), so reasoning was turned off for the call`
            : `the reply limit (${ceiling} tokens) leaves no room for the provider's smallest reasoning budget (${ANTHROPIC_MIN_THINKING}), so reasoning was turned off for the call`);
        } else {
          body["thinking"] = { ...(thinking as Record<string, unknown>), budget_tokens: cap };
          sent["thinking.budget_tokens"] = cap;
        }
      } else if (reasoningTokens !== undefined && asked !== undefined) sent["thinking.budget_tokens"] = asked;
    } else if (reasoningTokens !== undefined && type !== undefined && type !== "disabled") {
      // Adaptive (or any other) thinking takes an effort level, not tokens; current Claude models refuse a fixed budget (and some refuse thinking turned off), so the request is left as it is and that is said.
      notSent.push(`the reasoning cap (${reasoningTokens} tokens) was not sent: this call uses ${String(type).slice(0, 40)} thinking, which takes an effort level, not a number of tokens`);
    } else if (reasoningTokens !== undefined && type === undefined) {
      // No thinking setting: current Claude models then think as they decide (adaptive), older ones do not think. Either way no budget is set, and a fixed one would be refused by the current models.
      notSent.push(`the reasoning cap (${reasoningTokens} tokens) was not sent: this call sets no reasoning budget (the model decides how much it reasons)`);
    }
    return { sent, notSent };
  }
  if (kind === undefined || !CHAT_KINDS.has(kind)) {
    const why = kind === undefined ? "the endpoint's kind is not set" : `the endpoint's kind (${kind.slice(0, 40)}) has no known field for it`;
    if (maxTokens !== undefined) notSent.push(`the reply limit (${maxTokens} tokens) was not sent: ${why}`);
    if (reasoningTokens !== undefined) notSent.push(`the reasoning cap (${reasoningTokens} tokens) was not sent: ${why}`);
    return { sent, notSent };
  }
  if (maxTokens !== undefined) {
    const field = kind === "openai" ? "max_completion_tokens" : "max_tokens";
    // The other name is removed, so the provider is not given two limits that disagree.
    delete body[field === "max_tokens" ? "max_completion_tokens" : "max_tokens"];
    body[field] = maxTokens;
    sent[field] = maxTokens;
  }
  if (reasoningTokens !== undefined) {
    const field = kind === "openai" ? undefined : CHAT_REASONING[kind];
    if (field === undefined) notSent.push(`the reasoning cap (${reasoningTokens} tokens) was not sent: ${kind === "openai" ? "this provider takes a reasoning effort level, not a number of tokens" : `the endpoint's kind (${kind}) has no known field for it`}`);
    else {
      const ceiling = num(body["max_tokens"]) ?? num(body["max_completion_tokens"]);
      const asked = num(body[field]);
      if (asked === undefined && options.addReasoning === false) notSent.push(`the reasoning cap (${reasoningTokens} tokens) was not sent: the server refused the ${field} field (a vLLM server needs its reasoning parser set to take it)`);
      else {
        const cap = Math.max(0, Math.min(reasoningTokens, asked ?? Infinity, ceiling === undefined ? Infinity : ceiling - 1));
        body[field] = cap;
        sent[field] = cap;
        if (asked === undefined) added = field;
      }
    }
  }
  return { sent, notSent, ...(added === undefined ? {} : { added }) };
}

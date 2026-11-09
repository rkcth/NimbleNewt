import type { TurnEndKind } from "@nimblenewt/contracts";
import { BRIDGE_REFUSED_PREFIX, WORK_END_TOOL } from "../bridge.js";

/**
 * How a completed turn ended (card W02), read from the turn's last reply. Pi Durable answers a reply that stopped on the output limit as it answers a natural stop (generation.js, `stopReason === "length"`), so the result alone says
 * "completed" for a turn cut off mid-sentence, one that ended on thinking only and one that ended with a full report alike. The ideas are the W01 bench's (scripts/pi-eval/lib/classify.mjs), read here from the stored conversation.
 */

/** A last line that announces a next step ("Now let me run the tests:") instead of reporting. "Let me know ..." is a sign-off, not a step. The same rule as the W01 bench's. */
const ANNOUNCES_STEP = /(?:^|[\n.!]\s*)(?:(?:now|next|then|first|ok(?:ay)?|good)[,:]?\s+)?(?:I'll|I will|I'm going to|let me(?!\s+know)|let's|I need to)\b[^\n]*$|:\s*$/i;
/** How much of the end of the reply is read for an announcement. */
const TAIL_CHARS = 600;

export interface TurnEnding {
  /** Pi's stop reason of the last assistant reply (`stop`, `length`, `toolUse`, ...); undefined when the turn has none. */
  readonly stopReason: string | undefined;
  /** The visible text of that reply (thinking and tool calls are not visible text). */
  readonly visibleText: string;
  /** The tool calls the turn made, with their outcome as Pi recorded it. */
  readonly toolCalls: readonly { readonly name: string; readonly status: string; readonly output?: string }[];
}

/** Whether the turn ended its attempt with `work.end`: a call of the bridge's work.end tool that the controller did not refuse. */
export function calledWorkEnd(toolCalls: TurnEnding["toolCalls"]): boolean {
  return toolCalls.some((c) => c.name === WORK_END_TOOL && c.status === "ok" && !(c.output ?? "").startsWith(BRIDGE_REFUSED_PREFIX));
}

/**
 * The end kind. The order matters: a reply cut off by the output limit is `length` whatever came before it; a turn that called `work.end` ended as the agent meant it to (`normal`), even if nothing visible follows the call; otherwise a
 * reply with no visible text is `empty-visible-text`, one whose last line announces a step is `announced-step-without-tool-call` (a final reply has no tool call after it, or Pi would have run it), and any other natural stop is `no-work-end`.
 */
export function classifyTurnEnd(ending: TurnEnding): { readonly endKind: TurnEndKind; readonly visibleChars: number } {
  const visible = ending.visibleText.trim();
  const visibleChars = visible.length;
  if (ending.stopReason === "length") return { endKind: "length", visibleChars };
  if (calledWorkEnd(ending.toolCalls)) return { endKind: "normal", visibleChars };
  if (visibleChars === 0) return { endKind: "empty-visible-text", visibleChars };
  if (ANNOUNCES_STEP.test(visible.slice(-TAIL_CHARS))) return { endKind: "announced-step-without-tool-call", visibleChars };
  return { endKind: "no-work-end", visibleChars };
}

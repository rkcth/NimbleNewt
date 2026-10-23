import { DomainError } from "../domain/errors.js";
import { text } from "../domain/model.js";
import { redactText } from "../security/redact.js";
import type { JsonObject } from "../storage/types.js";

import type { Cite } from "../status/explain.js";
export type { Cite };

/**
 * What goes back to the conversation a topic or a proposal came from (card M03): the owner's chat turn, an inquiry, or the agent that proposed an improvement. The sink is the thing that would post it (a chat message,
 * a notice, an agent message); it must be idempotent by `key`. It is injected; no sink is built here.
 */
export interface OutcomeNotice {
  readonly key: string;
  readonly kind: "agenda-outcome" | "improvement-outcome";
  readonly projectId: string;
  readonly to: { readonly kind: "chat-turn" | "inquiry" | "agent"; readonly id: string };
  readonly text: string;
  readonly refs: readonly Cite[];
}
export interface OutcomeSink { deliver(notice: OutcomeNotice): Promise<void> }

export const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
/** Bounded text that is not credential-shaped. */
export const plain = (value: unknown, field: string, max: number): string => {
  const out = text(value, field, { min: 1, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded");
  return out;
};
export const optionalPlain = (value: unknown, field: string, max: number): string | undefined => (value === undefined ? undefined : plain(value, field, max));
export const whole = (value: unknown, field: string, min: number, max: number): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(field, `must be a whole number from ${min} to ${max}`));
export const clean = <T extends object>(body: T): JsonObject => Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as unknown as JsonObject;
/** Cuts at a character boundary (never inside a surrogate pair) and says so. */
export const cut = (value: string, max: number): string => {
  const chars = [...redactText(value).replace(/\s+/g, " ").trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}...`;
};

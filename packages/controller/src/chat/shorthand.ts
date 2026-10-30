import type { ControlLevel } from "../routing/cutover.js";

/** Short forms of the typed routing orders (card U06b): `/exclude provider openai why`, `/restore …`, `/cutover …`. */
const FORMS: Readonly<Record<string, string>> = { exclude: "routing-disable", restore: "routing-reenable", cutover: "routing-cutover" };
const LEVELS: readonly ControlLevel[] = ["model", "endpoint", "account", "provider", "service"];

/**
 * A short form is never run as typed: it is expanded into the exact typed order and shown, and the owner sends that line to run it. Returns undefined for text that is not a short form, and an `error` for one
 * that is but is incomplete.
 */
export function expandShorthand(text: string): { readonly typed: string } | { readonly error: string } | undefined {
  const m = /^\/([a-z]+)(?:\s+(.*))?$/s.exec(text.trim());
  const command = m?.[1] === undefined ? undefined : FORMS[m[1]];
  if (m === null || command === undefined) return undefined;
  const parts = (m[2] ?? "").trim().split(/\s+/).filter((p) => p.length > 0);
  const [level, name, ...why] = parts;
  if (level === undefined || !LEVELS.includes(level as ControlLevel)) return { error: `/${m[1]} needs what to act on: one of ${LEVELS.join(", ")}, then its name and a reason (for example /${m[1]} provider example-provider the account is out of credit).` };
  if (name === undefined) return { error: `/${m[1]} ${level} needs the name of the ${level}.` };
  const reason = why.join(" ") || "typed order";
  return { typed: `/nimblenewt.${command} ${JSON.stringify({ level, name, reason })}` };
}

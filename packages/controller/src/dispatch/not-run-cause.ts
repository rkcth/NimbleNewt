/**
 * Why the second agent's questioning of a done did not run, as one named cause (W09 fixes, 2026-11-27). The questioning's `why` is the plain, redacted text; the cause is read from it so a run result and the owner's views can say
 * which of a fixed set of things happened without parsing the words. The texts are the controller's own: the dispatcher's, the owner's route setting (`reviewerRoute`), the interrogator's, the routed client's and the HTTP client's
 * (whose failures start with their class, `outage: ...`). Anything not recognised is `error`, never a cause it is not.
 */
export const NOT_RUN_CAUSES = ["not-set-up", "no-route", "route-not-usable", "cap", "route-blocked", "busy", "timeout", "reply-cut", "no-text", "provider-refused", "rate-limit", "provider-unavailable", "request-refused", "error"] as const;
export type NotRunCause = (typeof NOT_RUN_CAUSES)[number];

/** Checked in order: the setup and route causes before what a route answered, and a time-out before the outage class the HTTP client gives it. */
const RULES: readonly (readonly [RegExp, NotRunCause])[] = [
  [/no second agent is set up/i, "not-set-up"],
  [/no reviewer route is set|has no model route/i, "no-route"],
  [/the reviewer route .{0,100} (?:cannot be used|could not be checked)/i, "route-not-usable"],
  [/\bbudget: |daily cap on the controller's own model calls/i, "cap"],
  [/\bblocked: /i, "route-blocked"],
  [/no reviewer slot came free|too many questions to the reviewer are waiting/i, "busy"],
  [/\btimeout: |timed out|did not answer within/i, "timeout"],
  [/\breply-cut: /i, "reply-cut"],
  [/held no text|returned no text/i, "no-text"],
  [/\b(?:credit|auth): /i, "provider-refused"],
  [/\brate-limit: /i, "rate-limit"],
  [/\boutage: /i, "provider-unavailable"],
  [/\b(?:context-overflow|invalid-request): /i, "request-refused"],
];

export function notRunCause(why: string | undefined): NotRunCause {
  const text = String(why ?? "");
  for (const [rule, cause] of RULES) if (rule.test(text)) return cause;
  return "error";
}

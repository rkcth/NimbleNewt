import { redactText } from "../security/redact.js";
import { REMOTE_LIMITS } from "./protocol.js";

// Built from a string: the escapes must stay escapes (a line separator written into a regular expression literal ends the line).
const UNSHOWN = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\ud800-\\udfff]|\\p{Cf}", "gu");

/**
 * A process reference of a worker's report as it is sent and kept (card L02e, review): redacted while whole (a cut first could leave part of a credential that no pattern then recognises), every control or
 * format character (C0, C1, the marks that turn text around, line and paragraph separators, a lone half of a pair) made a space, then cut to `REMOTE_LIMITS.processRef` UTF-16 units without splitting a character.
 * The worker does it before sending (so a report stays inside the body limit and the credential never goes over the wire) and the controller again on what it is sent. Never empty: a reference with nothing
 * left reads `?`.
 */
export function cleanProcessRef(raw: string): string {
  const clean = redactText(raw.slice(0, 64 * 1024)).replace(UNSHOWN, " ");
  let out = "";
  for (const ch of clean) { if (out.length + ch.length > REMOTE_LIMITS.processRef) break; out += ch; }
  return out.length === 0 ? "?" : out;
}

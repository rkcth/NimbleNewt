/**
 * Keeps secrets out of anything that is logged, audited, returned in an error or shown (card A01). Two rules together: values stored under a name that
 * says "secret" are replaced whole, and anything shaped like a NimbleNewt token or a common bearer or API key is replaced wherever it appears in text.
 */
import { CREDENTIAL_PATTERNS } from "./credential-patterns.js";
import { replaceSpans, scanSecrets } from "./secret-scan.js";

export const REDACTED = "[redacted]";

/** A field is sensitive by its last word (`apiKey`, `client_secret`, `accessToken`, `password`); a plural such as `inputTokens` is a count, not a secret. */
const SENSITIVE_LAST_WORD = new Set(["secret", "secrets", "token", "password", "passwords", "passwd", "credential", "credentials", "apikey", "authorization", "cookie", "cookies", "passcode", "pin", "key"]);
const SENSITIVE_PAIRS = /(?:api|private|access|secret|auth|signing)[-_ ]?key$/i;
function sensitiveName(name: string): boolean {
  if (SENSITIVE_PAIRS.test(name)) return true;
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const last = words[words.length - 1];
  return last !== undefined && last !== "key" && SENSITIVE_LAST_WORD.has(last);
}
/**
 * Text with every credential shape replaced by `[redacted]`: a whole private key block as written becomes one mark, then every shape found by `scanSecrets` in its folded views (fullwidth or mixed-case
 * prefixes, invisible characters inside a token, a token split over lines, an orphan key END, long high-entropy hex or base64 runs), replaced in the original text line by line so no two lines are joined.
 * Idempotent: the result redacts to itself.
 */
const PRIVATE_KEY_BLOCK = new RegExp(CREDENTIAL_PATTERNS.find((p) => p.name === "private key block")!.pattern.source, "g");
export function redactText(text: string): string {
  // A whole private key block written as such is one mark (as before); every other shape is found by the scan, which matches all of CREDENTIAL_PATTERNS through its folded views (a URL keeps its scheme, user and host).
  const out = text.replace(PRIVATE_KEY_BLOCK, REDACTED);
  return replaceSpans(out, scanSecrets(out), REDACTED);
}

/** A copy of a JSON value with sensitive fields and secret-shaped strings replaced. Depth-limited so a hostile value cannot exhaust the stack. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 32) return REDACTED as unknown as T;
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sensitiveName(k) && v !== null && v !== undefined ? REDACTED : redact(v, depth + 1)])) as T;
  }
  return value;
}

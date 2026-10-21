/**
 * Keeps secrets out of anything that is logged, audited, returned in an error or shown (card A01). Two rules together: values stored under a name that
 * says "secret" are replaced whole, and anything shaped like a NimbleNewt token or a common bearer or API key is replaced wherever it appears in text.
 */
export const REDACTED = "[redacted]";

/** A field is sensitive by its last word (`apiKey`, `client_secret`, `accessToken`, `password`); a plural such as `inputTokens` is a count, not a secret. */
const SENSITIVE_LAST_WORD = new Set(["secret", "secrets", "token", "password", "passwords", "passwd", "credential", "credentials", "apikey", "authorization", "cookie", "cookies", "key"]);
const SENSITIVE_PAIRS = /(?:api|private|access|secret|auth|signing)[-_ ]?key$/i;
function sensitiveName(name: string): boolean {
  if (SENSITIVE_PAIRS.test(name)) return true;
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const last = words[words.length - 1];
  return last !== undefined && last !== "key" && SENSITIVE_LAST_WORD.has(last);
}
// <principal id>.<43-character base64url secret>, bearer tokens, and common provider key shapes.
const SHAPES: readonly RegExp[] = [
  /\b(?:owner|agent|host|client|service):[a-z0-9][a-z0-9-]{0,39}\.[A-Za-z0-9_-]{43}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]+:[^\s@/]+@/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:password|passwd|secret|api[-_]?key|token)\s*[=:]\s*\S{4,}/gi,
];

export function redactText(text: string): string {
  let out = text;
  for (const shape of SHAPES) out = out.replace(shape, (m) => (/^[a-z][a-z0-9+.-]{0,30}:\/\//i.test(m) ? m.replace(/:[^:@/]*@$/, `:${REDACTED}@`) : REDACTED));
  return out;
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

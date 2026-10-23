/**
 * The credential-pattern list (card C01b): what a secret looks like in text. One list serves two jobs: redaction of anything logged or shown (`redactText`) and refusal at write time
 * (shared working notes; later cards may reuse `findCredentialShapes`). The patterns are shapes, not a promise: text that hides a secret from them (split, encoded, paraphrased) is not caught,
 * and an ordinary sentence that happens to look like a key is refused, so a refusal names the kind of shape and never the text.
 */
export interface CredentialPattern {
  /** What the shape is called in a refusal message. */
  readonly name: string;
  readonly pattern: RegExp;
}

export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  { name: "NimbleNewt token", pattern: /\b(?:owner|agent|host|client|service):[a-z0-9][a-z0-9-]{0,39}\.[A-Za-z0-9_-]{43}\b/g },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: "API key (sk-)", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: "URL with embedded password", pattern: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]+:[^\s@/]+@/gi },
  { name: "JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "Stripe key", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "named secret assignment", pattern: /\b(?:password|passwd|secret|api[-_]?key|token)\s*[=:]\s*\S{4,}/gi },
];

/** The names of the credential shapes found in the text (each at most once), empty when none. */
export function findCredentialShapes(text: string): string[] {
  const found: string[] = [];
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) found.push(name);
    pattern.lastIndex = 0;
  }
  return found;
}

import { cacheMaturityOf, CLAUDE_EXPERIMENTAL_NOTICE, STRATA_EXPERIMENTAL_NOTICE } from "../inference-cache/profile.js";
import { DomainError } from "../domain/errors.js";
import { redactText } from "../security/redact.js";

/**
 * Capability claims in documents (card Q03, "no unsupported marketing capability claims"). Two checks, both deterministic and explainable, neither pretending to understand prose:
 *
 * - **Declared claims.** Every claim a document's record lists names a capability ID of the project's capability register. A claim on an `unsupported` capability, or on an `experimental` one whose
 *   words carry no experimental label, is flagged; so is a claim naming no capability or one the register does not know.
 * - **A scan of the document's text.** The submitted document's text (the files of its artifact the controller can read as text) is cut into sentences and searched for the names of capabilities the
 *   register marks `experimental` or `unsupported`. A sentence that names one without a label in the same sentence (an experimental label, or a plain negation such as "not supported") is flagged.
 *   Supported capabilities are not searched for: the scan only looks for what must not be claimed bare.
 *
 * Every flag names its rule and quotes the sentence, cleaned (control, line-separator, direction and zero-width characters removed or made spaces, then redacted and cut), so a hostile document cannot
 * reorder or hide text in the owner's view. Same text, same register: same flags, in the same order.
 */

export const CAPABILITY_MATURITIES = ["supported", "experimental", "unsupported"] as const;
export type CapabilityMaturity = (typeof CAPABILITY_MATURITIES)[number];
export const CAPABILITY_ID = /^[a-z][a-z0-9-]{1,59}$/;
export const CLAIM_LIMITS = { entries: 100, names: 10, name: 80, nameMin: 3, note: 300, flags: 20, quote: 200, files: 50, fileBytes: 256 * 1024, totalBytes: 1024 * 1024 } as const;

/** One capability as the register states it. `source`: `built-in` (the controller's own maturity labels, from the code) or `project` (set by the owner or a director; may override a built-in). */
export interface CapabilityEntry {
  readonly id: string;
  readonly name: string;
  /** The names the text scan looks for (the name included), case-insensitive, whole words; at least 3 characters each. */
  readonly names: readonly string[];
  readonly maturity: CapabilityMaturity;
  readonly note?: string;
  readonly source: "built-in" | "project";
  readonly setBy?: string;
  readonly setAt?: string;
}

/** The project's own entries, as stored (record `doc-capabilities`, ID the project's). */
export interface CapabilityRegisterBody {
  readonly projectId: string;
  readonly entries: readonly Omit<CapabilityEntry, "source">[];
  readonly changedAt: string;
}

const fromCache = (kind: string): CapabilityMaturity => (cacheMaturityOf(kind) === "measured" ? "supported" : "experimental");

/**
 * The controller's own capability labels, taken from the code that states them: the cache maturity of a provider kind (`cacheMaturityOf`: Claude and Strata are experimental, never measured), and the
 * owner's decision of 2026-11-26 that NimbleNewt on Windows requires a signed-in user (no unattended service). A project entry with the same ID replaces one, as a recorded decision.
 */
export function builtInCapabilities(): CapabilityEntry[] {
  return [
    { id: "claude-prompt-caching", name: "Claude prompt caching", names: ["Claude prompt caching", "Claude caching", "Claude cache", "Anthropic prompt caching"], maturity: fromCache("claude"), note: CLAUDE_EXPERIMENTAL_NOTICE, source: "built-in" },
    { id: "strata-caching", name: "Strata caching", names: ["Strata caching", "Strata cache", "Strata prompt caching"], maturity: fromCache("strata"), note: STRATA_EXPERIMENTAL_NOTICE, source: "built-in" },
    { id: "windows-unattended-worker", name: "unattended Windows worker", names: ["unattended Windows", "Windows service", "Session 0", "nobody signed in", "no one signed in", "without a signed-in user"], maturity: "unsupported", note: "Owner decision 2026-11-26: on Windows a worker runs only while a user is signed in; there is no unattended service.", source: "built-in" },
  ];
}

/** The register claims are checked against: the built-in entries, each replaced by a project entry with its ID, then the project's other entries, in ID order. */
export function effectiveRegister(project: CapabilityRegisterBody | undefined): CapabilityEntry[] {
  const own = new Map((project?.entries ?? []).map((e) => [e.id, { ...e, source: "project" as const }]));
  const all = new Map<string, CapabilityEntry>();
  for (const b of builtInCapabilities()) all.set(b.id, own.get(b.id) ?? b);
  for (const [id, e] of own) all.set(id, e);
  return [...all.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const CLAIM_RULES = {
  claim_without_capability: "a claim must name the capability it claims (capabilityId), so it can be checked against the capability register",
  unknown_capability: "a claim names a capability the register does not know",
  unsupported_capability_claimed: "a claim names a capability the register marks unsupported",
  experimental_claim_unlabelled: "a claim names an experimental capability without saying it is experimental",
  unsupported_mention: "the text names an unsupported capability without saying it is not supported, in the same sentence",
  experimental_mention_unlabelled: "the text names an experimental capability without an experimental label or a negation, in the same sentence",
} as const;
export type ClaimRule = keyof typeof CLAIM_RULES;

export interface ClaimFlag {
  readonly rule: ClaimRule;
  readonly capabilityId?: string;
  /** `claim` (one of the record's claims, by its number) or `text` (a file of the document). */
  readonly source: "claim" | "text";
  readonly where: string;
  /** The sentence (or the claim's words), cleaned and cut. */
  readonly quote: string;
}

/** Labels that make a mention of an experimental capability acceptable. */
const EXPERIMENTAL_LABEL = /(?<![\p{L}\p{N}])(experimental|not measured|unmeasured|untested|preview|beta)(?![\p{L}\p{N}])/iu;
/** Plain negations: a sentence that says the capability is not there is not a claim of it. "no" alone is not one (too loose: "no setup needed: X does it"). */
const NEGATION = /(?<![\p{L}\p{N}])(not|never|cannot|can't|can\u2019t|isn't|isn\u2019t|doesn't|doesn\u2019t|don't|don\u2019t|won't|won\u2019t|unsupported|unavailable)(?![\p{L}\p{N}])/iu;

/**
 * Text as the checks read it and the owner sees it quoted: NFKC (so look-alike forms of letters fold), zero-width characters and soft hyphens removed (so a name cannot be hidden by splitting it),
 * direction marks and overrides removed (so a quote cannot be shown reordered), other control characters made spaces, HTML tags and Markdown marks made spaces, spaces run together. Line breaks are kept
 * as `\n` (a sentence boundary) unless `oneLine`.
 */
export function cleanText(raw: string, oneLine = false): string {
  let s = String(raw).normalize("NFKC");
  s = s.replace(/[\u200B-\u200D\u2060\uFEFF\u00AD\u180E]/g, "");
  s = s.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  s = s.replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n");
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, " ");
  s = s.replace(/<[^<>\n]{0,500}>/g, " ").replace(/[*_`~#>|[\]]/g, " ");
  s = s.replace(/[ \t\f\v\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, " ");
  if (oneLine) s = s.replace(/\s*\n\s*/g, " ");
  return s.replace(/ *\n */g, "\n").trim();
}

/** Sentences: split at `.`, `!` or `?` followed by a space, and at line breaks. */
export function sentencesOf(cleaned: string): string[] {
  return cleaned.split(/\n+|(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x !== "");
}

/** On whole characters (a cut through a pair of UTF-16 units leaves none of it). */
const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 3).replace(/[\uD800-\uDBFF]$/, "")}...`);
/** What a flag quotes: cleaned to one line, redacted, cut. */
export const quoteOf = (s: string): string => cut(redactText(cleanText(s, true)), CLAIM_LIMITS.quote);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A name as a pattern: case-insensitive, whole words, its words joined by any run of spaces or hyphens or by nothing (a name split by a removed zero-width character still matches). */
const patternOf = (name: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${cleanText(name, true).split(/[\s-]+/).filter((w) => w !== "").map(escape).join("[\\s-]*")}(?![\\p{L}\\p{N}])`, "giu");
/** "no" or "without" right before a name (at most two words between): "there is no unattended Windows service", "works without Claude caching". */
const DENIED_BEFORE = /(?<![\p{L}\p{N}])(no|without)(\s+[\p{L}\p{N}'-]+){0,2}\s*$/iu;

/** Whether `sentence`, with every name of the capability blanked out (a name such as "nobody signed in" must not count as its own negation), carries the label the maturity needs. */
function labelled(sentence: string, entry: CapabilityEntry): boolean {
  for (const n of entry.names) for (const m of sentence.matchAll(patternOf(n))) if (DENIED_BEFORE.test(sentence.slice(0, m.index))) return true;
  let rest = sentence;
  for (const n of entry.names) rest = rest.replace(patternOf(n), " ");
  return entry.maturity === "unsupported" ? NEGATION.test(rest) : EXPERIMENTAL_LABEL.test(rest) || NEGATION.test(rest);
}

export interface DeclaredClaim { readonly text: string; readonly taskId: string; readonly capabilityId?: string }

/** The record's claims against the register. */
export function checkDeclared(claims: readonly DeclaredClaim[], register: readonly CapabilityEntry[]): { flags: ClaimFlag[]; capabilities: Record<string, CapabilityMaturity> } {
  const flags: ClaimFlag[] = [];
  const capabilities: Record<string, CapabilityMaturity> = {};
  claims.forEach((c, i) => {
    const where = `claim ${i + 1}`;
    const quote = quoteOf(c.text);
    if (c.capabilityId === undefined) { flags.push({ rule: "claim_without_capability", source: "claim", where, quote }); return; }
    const entry = register.find((e) => e.id === c.capabilityId);
    if (entry === undefined) { flags.push({ rule: "unknown_capability", capabilityId: c.capabilityId, source: "claim", where, quote }); return; }
    capabilities[entry.id] = entry.maturity;
    if (entry.maturity === "unsupported") flags.push({ rule: "unsupported_capability_claimed", capabilityId: entry.id, source: "claim", where, quote });
    else if (entry.maturity === "experimental" && !EXPERIMENTAL_LABEL.test(cleanText(c.text, true))) flags.push({ rule: "experimental_claim_unlabelled", capabilityId: entry.id, source: "claim", where, quote });
  });
  return { flags, capabilities };
}

/** One text (a file of the document, or anything else to scan) against the register's experimental and unsupported capabilities. `capabilities` lists every one named, labelled or not. */
export function scanText(raw: string, register: readonly CapabilityEntry[], where: string): { flags: ClaimFlag[]; capabilities: Record<string, CapabilityMaturity> } {
  const flags: ClaimFlag[] = [];
  const capabilities: Record<string, CapabilityMaturity> = {};
  const watched = register.filter((e) => e.maturity !== "supported");
  if (watched.length === 0) return { flags, capabilities };
  for (const sentence of sentencesOf(cleanText(raw))) {
    for (const entry of watched) {
      if (!entry.names.some((n) => patternOf(n).test(sentence))) continue;
      capabilities[entry.id] = entry.maturity;
      if (labelled(sentence, entry)) continue;
      flags.push({ rule: entry.maturity === "unsupported" ? "unsupported_mention" : "experimental_mention_unlabelled", capabilityId: entry.id, source: "text", where, quote: quoteOf(sentence) });
    }
  }
  return { flags, capabilities };
}

/** Which files of a document artifact are read as text (by name). Others (images, archives) are listed as not read. */
export const TEXT_FILE = /\.(md|markdown|mdx|txt|text|rst|adoc|asciidoc|html?|xhtml|csv|json|ya?ml|po)$/i;

/** A flag in plain words, for the owner: the rule, the capability and the quoted sentence. */
export function claimFlagText(f: ClaimFlag): string {
  return `${f.where}${f.capabilityId === undefined ? "" : ` (${f.capabilityId})`}: ${CLAIM_RULES[f.rule]}: ${JSON.stringify(f.quote)}`;
}

/** Order of maturities, for "was it rated higher when the document was verified?". */
export const maturityRank = (m: CapabilityMaturity): number => (m === "supported" ? 2 : m === "experimental" ? 1 : 0);

/** What the reader needs of the artifact service (card S06): the manifest and one file's verified bytes. */
export interface DocumentArtifacts {
  get(id: string): Promise<{ readonly projectId?: string; readonly manifestDigest: string; readonly entries: readonly { readonly path: string; readonly size: number }[] } | undefined>;
  readFile(id: string, path: string, options?: { maxBytes?: number }): Promise<Uint8Array>;
}

/**
 * The `readDocument` port of the documentation obligations (card Q03): the text of the artifact a document change names. Refused (an `invalid_command` naming the reason) when the artifact is missing, of
 * another project, or not the one the submission's digest names (the digest is `sha256:` and the artifact's manifest digest, as the tool bridge records it); a damaged file is the artifact service's
 * `integrity` error. Files are read in path order: those named as text, up to 50 files, 256 KiB each and 1 MiB in all, decoded as UTF-8 (a file that is not is skipped, never guessed at).
 */
export function artifactDocumentReader(artifacts: DocumentArtifacts): (d: { readonly artifactId: string; readonly artifactDigest: string; readonly projectId: string }) => Promise<{ files: { path: string; text: string }[]; skipped: string[] }> {
  const refuse = (why: string): never => { throw new DomainError("invalid_command", `documentSubmissionId: ${why}`, { field: "documentSubmissionId" }); };
  return async (d) => {
    const a = await artifacts.get(d.artifactId);
    if (a === undefined) return refuse(`its artifact ${d.artifactId} is not stored on this controller`);
    if (a.projectId !== undefined && a.projectId !== d.projectId) return refuse("its artifact belongs to another project");
    if (d.artifactDigest !== `sha256:${a.manifestDigest}` && d.artifactDigest !== a.manifestDigest) return refuse("its artifact's files are not the ones the document change recorded (the digests differ)");
    const files: { path: string; text: string }[] = [];
    const skipped: string[] = [];
    let total = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const e of [...a.entries].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))) {
      if (!TEXT_FILE.test(e.path) || files.length >= CLAIM_LIMITS.files || e.size > CLAIM_LIMITS.fileBytes || total + e.size > CLAIM_LIMITS.totalBytes) { skipped.push(e.path); continue; }
      const bytes = await artifacts.readFile(d.artifactId, e.path, { maxBytes: CLAIM_LIMITS.fileBytes });
      try { files.push({ path: e.path, text: decoder.decode(bytes) }); total += e.size; } catch { skipped.push(e.path); }
    }
    return { files, skipped };
  };
}

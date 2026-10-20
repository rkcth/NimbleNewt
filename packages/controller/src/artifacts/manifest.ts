import { canonicalJson, sha256 } from "../storage/json.js";
import { DomainError } from "../domain/errors.js";

export interface ManifestEntry {
  /** Relative, `/`-separated, in the portable grammar of `checkPath`. */
  readonly path: string;
  /** SHA-256 of the content, 64 lower-case hex characters. */
  readonly digest: string;
  readonly size: number;
}

export const MANIFEST_LIMITS = { entries: 1000, pathBytes: 512, segmentChars: 255, totalBytes: Number.MAX_SAFE_INTEGER } as const;

const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/**
 * A path inside an artifact. The grammar is the portable intersection of Linux, macOS and Windows file names, so an artifact published on
 * one machine can be unpacked on another: relative, `/`-separated, NFC-normalised Unicode (never normalised for the caller: input that is
 * not NFC is refused, so two spellings cannot become two files on one platform and one on another), no `.` or `..` segments, no empty
 * segments, no control characters, no backslash, colon or any of `< > " | ? *`, no segment ending in a space or a dot, no Windows device names.
 */
export function checkPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) return bad(field, "must be a non-empty path");
  if (Buffer.byteLength(value, "utf8") > MANIFEST_LIMITS.pathBytes) return bad(field, `must be at most ${MANIFEST_LIMITS.pathBytes} bytes`);
  if (LONE_SURROGATE.test(value)) return bad(field, "must be well-formed Unicode");
  if (value !== value.normalize("NFC")) return bad(field, "must be NFC-normalised Unicode");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:<>"|?*]/.test(value)) return bad(field, "must not contain control characters, backslash, colon or any of < > \" | ? *");
  for (const segment of value.split("/")) {
    if (segment.length === 0) return bad(field, "must not have an empty segment (no leading, trailing or double slash)");
    if (segment === "." || segment === "..") return bad(field, "must not contain a . or .. segment");
    if (segment.length > MANIFEST_LIMITS.segmentChars) return bad(field, `a segment must be at most ${MANIFEST_LIMITS.segmentChars} characters`);
    if (/[ .]$/.test(segment)) return bad(field, "a segment must not end in a space or a dot");
    if (RESERVED_DEVICE.test(segment)) return bad(field, `${segment} is a reserved device name on Windows`);
  }
  return value;
}

/**
 * The entries in path order, checked as a set: no two paths equal ignoring case (they would be one file on macOS and Windows), and no
 * path that is also a directory of another. The case comparison is lower-casing plus a few common folds (ß, long s, dotless i), not the
 * full Unicode folding, so exotic pairs can still clash on a case-insensitive file system. Nor is there a limit on the total path length
 * (Windows classic 260 characters): where an artifact is unpacked decides that.
 */
/** Case folding for the clash check: lower case, plus the folds that differ from it in common scripts. Not full Unicode folding. */
const fold = (path: string): string => path.toLowerCase().replace(/ß/g, "ss").replace(/ſ/g, "s").replace(/ı/g, "i");

export function checkEntries(entries: readonly ManifestEntry[], field = "files"): ManifestEntry[] {
  if (entries.length === 0) return bad(field, "must contain at least one file");
  if (entries.length > MANIFEST_LIMITS.entries) return bad(field, `must contain at most ${MANIFEST_LIMITS.entries} files (publish larger sets as an archive)`);
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Map<string, string>();
  for (const entry of sorted) {
    const folded = fold(entry.path);
    const other = seen.get(folded);
    if (other !== undefined) return bad(field, `${entry.path} and ${other} are the same path on a case-insensitive file system`);
    seen.set(folded, entry.path);
  }
  for (const entry of sorted) {
    const parts = fold(entry.path).split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = seen.get(parts.slice(0, i).join("/"));
      if (parent !== undefined) return bad(field, `${parent} is a file, so ${entry.path} cannot be inside it`);
    }
  }
  return sorted;
}

/** The identity of a set of files: a SHA-256 over the paths, content digests and sizes in path order. Independent of the order given. */
export function manifestDigest(entries: readonly ManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(canonicalJson({ v: 1, entries: sorted.map((e) => ({ path: e.path, digest: e.digest, size: e.size })) }));
}

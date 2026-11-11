import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

/**
 * The reader of a package archive (card A09 follow-up). A package is a tar file (optionally gzip-compressed) whose first rule is: nothing in it is trusted. It is read in memory, entry by entry, and refused as a whole at the first thing that
 * could reach outside the package's own directory or carry privilege: a path that is absolute, has `..`, a backslash or a control character, a link of any kind, a device or any entry that is not a plain file or directory, a set-user-ID,
 * set-group-ID or sticky bit, an entry that does not fit in the archive, more files, more bytes or a deeper tree than the limits allow, a name that exists twice (also when only the letter case differs).
 * Nothing is written to disk here; `ContentStore` writes what this returns.
 */
export class ArchiveError extends Error {
  constructor(readonly code: "too_large" | "malformed" | "unsafe_path" | "unsafe_entry" | "unsafe_mode" | "unsupported" | "metadata", message: string) { super(message); this.name = "ArchiveError"; }
}

export interface ArchiveLimits {
  /** The most bytes of the archive itself (compressed, as fetched). */
  readonly maxArchiveBytes: number;
  /** The most bytes of file content once unpacked. */
  readonly maxUnpackedBytes: number;
  readonly maxFiles: number;
  readonly maxDepth: number;
  /** The longest path (in bytes). */
  readonly maxPathBytes: number;
}
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = { maxArchiveBytes: 32 * 1024 * 1024, maxUnpackedBytes: 128 * 1024 * 1024, maxFiles: 10_000, maxDepth: 24, maxPathBytes: 240 };

export interface PackageFile { readonly path: string; /** 0o644 or 0o755: nothing else is ever kept. */ readonly mode: 0o644 | 0o755; readonly data: Buffer }
export interface PackageMetadata {
  readonly name: string; readonly version: string;
  /** The install and lifecycle scripts the package declares, in the order they run: each is a JavaScript file inside the package. */
  readonly scripts: readonly { readonly phase: "preinstall" | "install" | "postinstall"; readonly entry: string }[];
}
export interface UnpackedPackage { readonly files: readonly PackageFile[]; readonly directories: readonly string[]; readonly bytes: number; readonly metadata: PackageMetadata }

/** The file at the root of every package that says what it is. */
export const METADATA_FILE = "nimblenewt-package.json";
const SCRIPT_PHASES = ["preinstall", "install", "postinstall"] as const;
const BLOCK = 512;

/** The sha256 of the bytes as the digest form the controller uses. */
export const digestOf = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A path inside a package: relative, written with "/", normalised, no `.`/`..`/empty part, no backslash, NUL or control character, within the length and depth limits. */
export function checkPackagePath(path: string, limits: Pick<ArchiveLimits, "maxPathBytes" | "maxDepth"> = DEFAULT_ARCHIVE_LIMITS): string {
  if (typeof path !== "string" || path.length === 0) throw new ArchiveError("unsafe_path", "an entry has no name");
  if (Buffer.byteLength(path) > limits.maxPathBytes) throw new ArchiveError("unsafe_path", `a path is longer than ${limits.maxPathBytes} bytes`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\�]/.test(path)) throw new ArchiveError("unsafe_path", "a path has a control character, a backslash or bytes that are not text");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw new ArchiveError("unsafe_path", "a path is absolute");
  const parts = path.split("/");
  if (parts.length > limits.maxDepth) throw new ArchiveError("unsafe_path", `a path is deeper than ${limits.maxDepth} levels`);
  for (const part of parts) if (part === "" || part === "." || part === "..") throw new ArchiveError("unsafe_path", "a path has an empty, '.' or '..' part");
  return path;
}

const field = (block: Buffer, from: number, to: number): string => {
  const raw = block.subarray(from, to);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
};
function octal(block: Buffer, from: number, to: number, what: string): number {
  const raw = block.subarray(from, to);
  // A binary (base-256) number is how an archiver writes a size past 8 GiB or a negative time; none of that is a package.
  if ((raw[0]! & 0x80) !== 0) throw new ArchiveError("unsupported", `the ${what} is written in a form this reader does not accept`);
  const text = raw.toString("latin1").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError("malformed", `the ${what} of an entry is not a number`);
  return Number.parseInt(text, 8);
}

/** Opens the (optionally gzip) wrapper under the limits and returns the tar bytes. A compressed stream that would grow past what the limits allow is cut off while it is read, never held whole. */
export function tarBytes(archive: Uint8Array, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): Buffer {
  if (archive.length > limits.maxArchiveBytes) throw new ArchiveError("too_large", `the archive is ${archive.length} bytes; the most accepted is ${limits.maxArchiveBytes}`);
  const buffer = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    const ceiling = limits.maxUnpackedBytes + limits.maxFiles * 1024 + 2 * BLOCK;
    try { return gunzipSync(buffer, { maxOutputLength: ceiling }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) throw new ArchiveError("too_large", "the archive unpacks to more than the limits allow");
      throw new ArchiveError("malformed", "the archive is not a readable gzip stream");
    }
  }
  return buffer;
}

/** Reads a package archive. Throws `ArchiveError` for anything unsafe, malformed or over a limit; returns the files, their directories and the package's metadata otherwise. */
export function unpack(archive: Uint8Array, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): UnpackedPackage {
  const tar = tarBytes(archive, limits);
  const files: PackageFile[] = [];
  const dirs = new Set<string>();
  const seen = new Set<string>();
  const implicit = new Set<string>();
  const fileNames = new Set<string>();
  let total = 0;
  let at = 0;
  let ended = false;
  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((b) => b === 0)) { ended = true; at += BLOCK; break; }
    // Checksum first: a header that does not add up is not an entry (and a hand-edited name or size would not).
    const stored = octal(header, 148, 156, "checksum");
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    if (sum !== stored) throw new ArchiveError("malformed", "an entry header has a wrong checksum");
    const magic = header.subarray(257, 263).toString("latin1");
    const name = field(header, 0, 100);
    const prefix = magic === "ustar\0" ? field(header, 345, 500) : "";
    const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156]!);
    const mode = octal(header, 100, 108, "mode");
    const size = octal(header, 124, 136, "size");
    at += BLOCK;
    if (type === "1" || type === "2") throw new ArchiveError("unsafe_entry", `an entry is a ${type === "2" ? "symbolic" : "hard"} link; links are not accepted in a package`);
    if (type !== "0" && type !== "5") throw new ArchiveError(type === "x" || type === "g" || type === "L" || type === "K" ? "unsupported" : "unsafe_entry", type === "x" || type === "g" || type === "L" || type === "K" ? "extended headers (long names, pax records) are not accepted: the entry names must fit the plain format" : `an entry of type '${type}' is not a plain file or directory`);
    if ((mode & 0o7000) !== 0) throw new ArchiveError("unsafe_mode", "an entry has a set-user-ID, set-group-ID or sticky bit");
    let path = prefix === "" ? name : `${prefix}/${name}`;
    if (path.startsWith("./")) path = path.slice(2);
    if (type === "5") path = path.replace(/\/+$/, "");
    // The archive's own root directory entry ("./" or ".") names nothing.
    if (type === "5" && (path === "" || path === ".")) { if (size !== 0) throw new ArchiveError("malformed", "a directory entry has content"); continue; }
    checkPackagePath(path, limits);
    const folded = path.toLowerCase();
    if (type === "0" ? seen.has(folded) || implicit.has(folded) : fileNames.has(folded)) throw new ArchiveError("unsafe_path", "a name occurs twice, or is both a file and a directory (letter case ignored)");
    if (type === "0") { seen.add(folded); fileNames.add(folded); }
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (fileNames.has(parent.toLowerCase())) throw new ArchiveError("unsafe_path", "an entry lies inside a file");
      dirs.add(parent); implicit.add(parent.toLowerCase());
    }
    if (type === "5") {
      if (size !== 0) throw new ArchiveError("malformed", "a directory entry has content");
      dirs.add(path); implicit.add(folded);
      if (dirs.size + files.length > limits.maxFiles) throw new ArchiveError("too_large", `the archive has more than ${limits.maxFiles} entries`);
      continue;
    }
    if (files.length + 1 > limits.maxFiles) throw new ArchiveError("too_large", `the archive has more than ${limits.maxFiles} files`);
    total += size;
    if (total > limits.maxUnpackedBytes) throw new ArchiveError("too_large", `the files add up to more than ${limits.maxUnpackedBytes} bytes`);
    if (at + size > tar.length) throw new ArchiveError("malformed", "an entry is longer than the archive");
    const data = Buffer.from(tar.subarray(at, at + size));
    at += Math.ceil(size / BLOCK) * BLOCK;
    files.push({ path, mode: (mode & 0o111) !== 0 ? 0o755 : 0o644, data });
  }
  if (!ended && at < tar.length) throw new ArchiveError("malformed", "the archive stops in the middle of an entry");
  if (!ended) throw new ArchiveError("malformed", "the archive has no end marker");
  // After the end marker only zero blocks may follow (anything else is data a different reader might take for entries).
  for (let i = at; i < tar.length; i++) if (tar[i] !== 0) throw new ArchiveError("malformed", "the archive has data after its end marker");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, directories: [...dirs].sort(), bytes: total, metadata: metadataOf(files) };
}

const NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-z0-9][a-z0-9._-]{0,99}$/;
const VERSION = /^(?:0|[1-9]\d{0,9})\.(?:0|[1-9]\d{0,9})\.(?:0|[1-9]\d{0,9})(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,30})?(?:\+[0-9A-Za-z.-]{1,30})?$/;
export const validPackageName = (name: unknown): name is string => typeof name === "string" && NAME.test(name) && !name.includes("..");
export const validPackageVersion = (version: unknown): version is string => typeof version === "string" && VERSION.test(version);

function metadataOf(files: readonly PackageFile[]): PackageMetadata {
  const file = files.find((f) => f.path === METADATA_FILE);
  if (file === undefined) throw new ArchiveError("metadata", `the package has no ${METADATA_FILE} at its root`);
  if (file.data.length > 64 * 1024) throw new ArchiveError("metadata", `${METADATA_FILE} is larger than 64 KiB`);
  let parsed: unknown;
  try { parsed = JSON.parse(file.data.toString("utf8")); } catch { throw new ArchiveError("metadata", `${METADATA_FILE} is not JSON`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ArchiveError("metadata", `${METADATA_FILE} is not an object`);
  const m = parsed as Record<string, unknown>;
  if (!validPackageName(m["name"])) throw new ArchiveError("metadata", "the package's name is not a valid package name");
  if (!validPackageVersion(m["version"])) throw new ArchiveError("metadata", "the package's version is not an exact version");
  const scripts: { phase: (typeof SCRIPT_PHASES)[number]; entry: string }[] = [];
  const declared = m["scripts"];
  if (declared !== undefined) {
    if (declared === null || typeof declared !== "object" || Array.isArray(declared)) throw new ArchiveError("metadata", "scripts must be an object");
    for (const key of Object.keys(declared)) if (!(SCRIPT_PHASES as readonly string[]).includes(key)) throw new ArchiveError("metadata", `the script "${key.slice(0, 40)}" is not one of preinstall, install, postinstall`);
    for (const phase of SCRIPT_PHASES) {
      const entry = (declared as Record<string, unknown>)[phase];
      if (entry === undefined) continue;
      if (typeof entry !== "string") throw new ArchiveError("metadata", `the ${phase} script must name a file of the package`);
      checkPackagePath(entry);
      if (!/\.(?:js|mjs|cjs)$/.test(entry) || entry.startsWith("-")) throw new ArchiveError("metadata", `the ${phase} script must be a JavaScript file of the package`);
      if (!files.some((f) => f.path === entry)) throw new ArchiveError("metadata", `the ${phase} script ${entry} is not in the package`);
      scripts.push({ phase, entry });
    }
  }
  return { name: m["name"], version: m["version"], scripts };
}

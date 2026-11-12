import { createHash, randomBytes } from "node:crypto";
import { constants as fsc } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ACTIVATION_LIMITS, PROCESS_TOKEN, PointerSwitcher, SimulatedCrash, SymlinkSwitcher, verifyReleaseDirectory, type StagedManifest } from "./activation.js";
import { Launcher, parseCompat } from "./launcher.js";
import type { VersionRange } from "../remote/protocol.js";
import { checkDigestSignature } from "./trust.js";

/**
 * The updater (card K02, follow-up): installs a release that is already built and verified, from a SOURCE DIRECTORY on this machine, into the release root, and tells the launcher about it. It is a library plus the
 * small program `scripts/nimblenewt-updater.mjs`; like the launcher it is not part of any release (a release cannot name `updater` as an artifact) and it never opens the database, a network or a model.
 *
 * The source directory is exactly what `release.stage` leaves in `releases/<id>`: the release's files and a `MANIFEST.json` (`{candidateId, sourceCommit, files: {name: {sha256, size}}}`). The caller names the
 * manifest's digest (SHA-256 of the MANIFEST.json text) out of band, from the channel that authorised the release; a source that does not match it is refused, so a swapped directory is not installed.
 *
 * `stageRelease`:
 * 1. Checks the source before copying anything: the directory and `MANIFEST.json` are plain (no links), the manifest is the digest, its names are safe (the same rules `release.stage` applies), and
 *    `verifyReleaseDirectory` finds every listed file with the right size and digest and NOTHING else (an unmanifested file or a link is refused).
 * 2. Copies the listed files (opened without following links, hashed while copied, mode 0444) into a temporary folder `releases/.tmp-<id>-...`, writes the manifest bytes it read, verifies the copy again, makes the
 *    folders read-only and moves the folder into place with ONE rename. Until that rename there is no `releases/<id>`, so a crash at any point leaves nothing the launcher could run; the next run sweeps the
 *    leftover temporary folder once it is old enough (`tmpStaleMs`, default one hour, so a running updater's folder is not taken).
 * 3. Never overwrites: if `releases/<id>` exists it is left alone. When it verifies against the same digest it counts as already installed (`reused`; a repeat after a crash between the rename and the
 *    announcement); otherwise the run is refused.
 *
 * `announceRelease` re-verifies the installed directory, then calls `Launcher.expect` (the existing announce API) so the launcher will run it. Moving the pointer is a separate, explicit choice (`switchPointer`):
 * a running launcher does not change its release until its controller exits or restarts, and a pointer moved without the controller's activation record leaves that record `diverged`, which `release.status` reports.
 * The updater never starts or stops anything.
 */
export type UpdaterErrorCode = "invalid_input" | "signature" | "source_invalid" | "digest_mismatch" | "exists" | "unsafe" | "failed";
export class UpdaterError extends Error {
  constructor(readonly code: UpdaterErrorCode, message: string) { super(message); this.name = "UpdaterError"; }
}

export const UPDATER_LIMITS = { manifestBytes: 1024 * 1024, tmpStaleMs: 3_600_000 } as const;
const CANDIDATE_ID = /^rcn-[0-9a-f]{24}$/;
const SHA = /^[0-9a-f]{64}$/;
const MANIFEST_FILE = "MANIFEST.json";
const COMPAT_FILE = "compat.json";
const RESERVED_ROOTS: ReadonlySet<string> = new Set(["launcher", "updater"]);
const sha256 = (v: string | Uint8Array): string => createHash("sha256").update(v).digest("hex");
const fail = (code: UpdaterErrorCode, message: string): never => { throw new UpdaterError(code, message); };

export type UpdaterPoint = "afterCheck" | "afterCopy" | "afterVerify" | "afterRename";
export interface StageReleaseOptions {
  /** Absolute path of the release root (it must exist; `releases/` is created under it). */
  readonly root: string;
  /** Absolute path of the source directory (a release as `release.stage` leaves it). */
  readonly source: string;
  /** The MANIFEST.json digest (64 hex characters) the release was authorised with. */
  readonly digest: string;
  /** A leftover temporary folder older than this is removed (default one hour). */
  readonly tmpStaleMs?: number;
  /** Tests only: called at named points; a throw stands for the process dying there. */
  readonly hook?: (point: UpdaterPoint) => void | Promise<void>;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  /**
   * Signed artifact sets (K02b): when given, the release is installed only if `signature` (base64 Ed25519) is a trusted key's signature over `signedDigestText(digest)`, checked before anything is copied. `keys` are base64 DER
   * public keys the installer trusts, supplied by the caller (the updater has no database; the CLI reads them from a file). An empty list refuses everything.
   */
  readonly trust?: { readonly keys: readonly string[]; readonly signature: string };
}
export interface InstalledRelease {
  readonly id: string;
  readonly digest: string;
  readonly dir: string;
  readonly files: number;
  readonly bytes: number;
  /** The worker protocol range from the release's `compat.json`, when it has one. */
  readonly protocol?: VersionRange;
  /** True when the release was already in place with this digest, so nothing was written. */
  readonly reused: boolean;
}

function absolute(field: string, v: unknown): string {
  // eslint-disable-next-line no-control-regex
  if (typeof v !== "string" || v === "" || !isAbsolute(v) || /[\u0000-\u001f]/.test(v)) return fail("invalid_input", `${field} must be an absolute path`);
  return v;
}

/** The same rules `release.stage` puts on an artifact name: it becomes path parts, so it must never leave the release directory. */
function checkNames(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const n of names) {
    const parts = n.split("/");
    if (n.length > 128 || n.includes("\\") || /[\u0000-\u001f]/.test(n) || parts.some((p) => p === "" || p === "." || p === "..")) fail("source_invalid", `${n.slice(0, 40)} is not a safe file name`);
    if (n.toLowerCase() === MANIFEST_FILE.toLowerCase()) fail("source_invalid", `${MANIFEST_FILE} is reserved`);
    if (RESERVED_ROOTS.has(parts[0]!.toLowerCase().split(".")[0]!)) fail("source_invalid", `${n.slice(0, 40)}: the launcher and the updater are not part of a release`);
    const low = n.toLowerCase();
    if (seen.has(low)) fail("source_invalid", `${n.slice(0, 40)} collides with another file on a case-insensitive file system`);
    seen.add(low);
  }
  for (const a of seen) for (const b of seen) if (a !== b && b.startsWith(`${a}/`)) fail("source_invalid", `${a.slice(0, 40)} is both a file and a folder`);
}

function parseManifest(raw: string, maxFiles: number, maxFileBytes: number): StagedManifest {
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return fail("source_invalid", `${MANIFEST_FILE} is damaged`); }
  if (typeof m !== "object" || m === null || Array.isArray(m)) return fail("source_invalid", `${MANIFEST_FILE} is not an object`);
  const o = m as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => k !== "candidateId" && k !== "sourceCommit" && k !== "files");
  if (unknown.length > 0) fail("source_invalid", `${MANIFEST_FILE} has an unknown field ${unknown[0]!.slice(0, 40)}`);
  if (typeof o.candidateId !== "string" || !CANDIDATE_ID.test(o.candidateId)) fail("source_invalid", `${MANIFEST_FILE} has no valid candidateId (rcn- and 24 hex characters)`);
  if (typeof o.sourceCommit !== "string" || o.sourceCommit === "" || o.sourceCommit.length > 128) fail("source_invalid", `${MANIFEST_FILE} has no sourceCommit`);
  const files = o.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) return fail("source_invalid", `${MANIFEST_FILE} has no files`);
  const names = Object.keys(files);
  if (names.length === 0) fail("source_invalid", "the release lists no files");
  if (names.length > maxFiles) fail("source_invalid", `the release lists more than ${maxFiles} files`);
  checkNames(names);
  for (const n of names) {
    const f = (files as Record<string, unknown>)[n];
    if (typeof f !== "object" || f === null) return fail("source_invalid", `${n.slice(0, 40)}: damaged entry`);
    const { sha256: h, size, ...extra } = f as Record<string, unknown>;
    if (typeof h !== "string" || !SHA.test(h) || !Number.isSafeInteger(size) || (size as number) < 0 || Object.keys(extra).length > 0) fail("source_invalid", `${n.slice(0, 40)}: damaged entry`);
    if ((size as number) > maxFileBytes) fail("source_invalid", `${n.slice(0, 40)} is larger than ${maxFileBytes} bytes`);
  }
  return m as StagedManifest;
}

async function isPlainDir(path: string): Promise<boolean> { try { const s = await lstat(path); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } }
async function unlockTree(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try { await chmod(dir, 0o700); } catch { return; }
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) await unlockTree(join(dir, e.name));
}
async function removeTree(dir: string): Promise<void> { await unlockTree(dir); await rm(dir, { recursive: true, force: true }); }
async function lockTree(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  for (const e of await readdir(dir, { withFileTypes: true })) if (e.isDirectory()) await lockTree(join(dir, e.name));
  await chmod(dir, 0o555);
}
async function syncDir(dir: string): Promise<void> {
  let fh;
  try { fh = await open(dir, "r"); await fh.sync(); } catch { /* not every platform syncs a directory */ } finally { await fh?.close().catch(() => undefined); }
}

/** Copies one file without following links, bounded, hashed while copied, to a new read-only file. */
async function copyFile(sourceRoot: string, name: string, dest: string, want: { sha256: string; size: number }): Promise<void> {
  const src = join(sourceRoot, ...name.split("/"));
  const input = await open(src, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0)).catch(() => fail("source_invalid", `${name} is missing or is a link`));
  try {
    const st = await input.stat();
    if (!st.isFile()) fail("source_invalid", `${name} is not a plain file`);
    if (st.size !== want.size) fail("source_invalid", `${name} has a different size`);
    await mkdir(join(dest, ".."), { recursive: true, mode: 0o700 });
    const out = await open(dest, "wx", 0o444);
    const hash = createHash("sha256");
    let size = 0;
    try {
      const buf = Buffer.allocUnsafe(ACTIVATION_LIMITS.chunk);
      for (;;) {
        const { bytesRead } = await input.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > want.size) fail("source_invalid", `${name} changed while it was copied`);
        hash.update(buf.subarray(0, bytesRead));
        await out.write(buf, 0, bytesRead);
      }
      await out.sync();
    } finally { await out.close(); }
    if (size !== want.size || hash.digest("hex") !== want.sha256) fail("source_invalid", `${name} changed while it was copied or has a different digest`);
    await chmod(dest, 0o444);
  } finally { await input.close(); }
}

async function sweepLeftovers(releases: string, staleMs: number): Promise<void> {
  let entries;
  try { entries = await readdir(releases, { withFileTypes: true }); } catch { return; }
  const now = Date.now();
  for (const e of entries) {
    // Only the folders this updater (or `release.stage`) makes: `.tmp-rcn-<24 hex>-...`.
    if (!e.isDirectory() || !/^\.tmp-rcn-[0-9a-f]{24}-/.test(e.name)) continue;
    const dir = join(releases, e.name);
    try { const s = await lstat(dir); if (s.isSymbolicLink() || now - s.mtimeMs < staleMs) continue; await removeTree(dir); } catch { /* another process removed it */ }
  }
}

/** Installs the verified source directory as `releases/<id>` under the root. See the module comment. */
export async function stageRelease(o: StageReleaseOptions): Promise<InstalledRelease> {
  const root = absolute("root", o.root);
  const source = absolute("source", o.source);
  if (typeof o.digest !== "string" || !SHA.test(o.digest)) fail("invalid_input", "digest must be 64 lowercase hex characters (the MANIFEST.json digest)");
  const maxFiles = o.maxFiles ?? ACTIVATION_LIMITS.files;
  const maxFileBytes = o.maxFileBytes ?? ACTIVATION_LIMITS.fileBytes;
  if (!(await isPlainDir(root))) fail("invalid_input", "the release root must be an existing directory (not a link)");

  // 1. The source, before anything is written.
  if (!(await isPlainDir(source))) fail("source_invalid", "the source must be a plain directory (a link is refused)");
  const manifestPath = join(source, MANIFEST_FILE);
  let mst;
  try { mst = await lstat(manifestPath); } catch { return fail("source_invalid", `${MANIFEST_FILE} is missing from the source`); }
  if (!mst.isFile() || mst.isSymbolicLink()) fail("source_invalid", `${MANIFEST_FILE} is not a plain file`);
  if (mst.size > UPDATER_LIMITS.manifestBytes) fail("source_invalid", `${MANIFEST_FILE} is larger than ${UPDATER_LIMITS.manifestBytes} bytes`);
  const manifestBytes = await readFile(manifestPath);
  const manifestText = manifestBytes.toString("utf8");
  if (sha256(manifestBytes) !== o.digest) fail("digest_mismatch", `${MANIFEST_FILE} is not the one the release was authorised with`);
  if (o.trust !== undefined && checkDigestSignature(o.trust.keys, o.digest, o.trust.signature) === undefined) fail("signature", "the release has no valid signature over its digest from a trusted key");
  const manifest = parseManifest(manifestText, maxFiles, maxFileBytes);
  const id = manifest.candidateId;
  const problems = await verifyReleaseDirectory(source, o.digest);
  if (problems.length > 0) fail("source_invalid", `the source does not match its manifest: ${problems[0]}`);
  let protocol: VersionRange | undefined;
  if (manifest.files[COMPAT_FILE] !== undefined) {
    try { protocol = parseCompat(await readFile(join(source, COMPAT_FILE), "utf8")).protocol; } catch (error) { fail("source_invalid", (error as Error).message); }
  }
  const names = Object.keys(manifest.files).sort();
  const bytes = names.reduce((n, k) => n + manifest.files[k]!.size, 0);
  await o.hook?.("afterCheck");

  // 2. The destination.
  const releases = join(root, "releases");
  try { const s = await lstat(releases); if (!s.isDirectory() || s.isSymbolicLink()) fail("unsafe", "releases under the root is not a plain directory"); } catch (error) {
    if (error instanceof UpdaterError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(releases, { mode: 0o700 });
  }
  const dest = join(releases, id);
  const existing = await lstat(dest).then((s) => s, () => undefined);
  if (existing !== undefined) {
    if (existing.isDirectory() && !existing.isSymbolicLink() && (await verifyReleaseDirectory(dest, o.digest)).length === 0) return { id, digest: o.digest, dir: dest, files: names.length, bytes, ...(protocol === undefined ? {} : { protocol }), reused: true };
    return fail("exists", `releases/${id} already exists and is not this release; it is never overwritten`);
  }
  await sweepLeftovers(releases, o.tmpStaleMs ?? UPDATER_LIMITS.tmpStaleMs);

  const tmp = join(releases, `.tmp-${id}-${PROCESS_TOKEN}-${randomBytes(6).toString("hex")}`);
  await mkdir(tmp, { mode: 0o700 });
  try {
    const sourceReal = await realpath(source);
    for (const name of names) await copyFile(sourceReal, name, join(tmp, ...name.split("/")), manifest.files[name]!);
    // The manifest as it was read and hashed, byte for byte (not re-serialised), so the digest stays the one authorised.
    const fh = await open(join(tmp, MANIFEST_FILE), "wx", 0o444);
    try { await fh.writeFile(manifestBytes); await fh.sync(); } finally { await fh.close(); }
    await o.hook?.("afterCopy");
    const check = await verifyReleaseDirectory(tmp, o.digest);
    if (check.length > 0) fail("failed", `the copy does not match its manifest: ${check[0]}`);
    await o.hook?.("afterVerify");
    await lockTree(tmp);
    // A rename onto an existing non-empty directory fails, so a release put there since the check above is not replaced.
    try { await rename(tmp, dest); } catch (error) { if (await lstat(dest).then(() => true, () => false)) fail("exists", `releases/${id} appeared while it was being installed; it is never overwritten`); throw error; }
    await syncDir(releases);
  } catch (error) {
    // A simulated or real kill cannot run this; the leftover is swept by the next run. Any other failure leaves nothing behind.
    if (!(error instanceof SimulatedCrash)) await removeTree(tmp).catch(() => undefined);
    throw error;
  }
  await o.hook?.("afterRename");
  return { id, digest: o.digest, dir: dest, files: names.length, bytes, ...(protocol === undefined ? {} : { protocol }), reused: false };
}

export interface AnnounceReleaseOptions {
  readonly root: string;
  readonly release: Pick<InstalledRelease, "id" | "digest" | "protocol">;
  readonly switcher?: "pointer" | "symlink";
  /** Also move the pointer to the release (after announcing it). Default false: announce only. */
  readonly switchPointer?: boolean;
}
export interface AnnounceResult { readonly announced: true; readonly switched: boolean }

/** Verifies the installed release again, announces it to the launcher (`Launcher.expect`) and, only when asked, moves the pointer. Starts and stops nothing. */
export async function announceRelease(o: AnnounceReleaseOptions): Promise<AnnounceResult> {
  const root = absolute("root", o.root);
  const { id, digest } = o.release;
  if (!CANDIDATE_ID.test(id) || !SHA.test(digest)) fail("invalid_input", "the release is not a release ID with a manifest digest");
  const dir = join(root, "releases", id);
  if (!(await isPlainDir(dir))) fail("source_invalid", `releases/${id} is not an installed release`);
  const problems = await verifyReleaseDirectory(dir, digest);
  if (problems.length > 0) fail("source_invalid", `releases/${id} does not match its manifest: ${problems[0]}`);
  const kind = o.switcher ?? "pointer";
  const switcher = kind === "symlink" ? new SymlinkSwitcher(root) : new PointerSwitcher(root);
  const launcher = new Launcher({ root, switcher });
  await launcher.expect({ id, digest, ...(o.release.protocol === undefined ? {} : { protocol: o.release.protocol }) });
  if (o.switchPointer === true) { await switcher.write(id); return { announced: true, switched: true }; }
  return { announced: true, switched: false };
}

/** Stage, then announce (and optionally switch). */
export async function installRelease(o: StageReleaseOptions & { readonly switcher?: "pointer" | "symlink"; readonly switchPointer?: boolean }): Promise<InstalledRelease & AnnounceResult> {
  const staged = await stageRelease(o);
  const announced = await announceRelease({ root: o.root, release: staged, ...(o.switcher === undefined ? {} : { switcher: o.switcher }), ...(o.switchPointer === undefined ? {} : { switchPointer: o.switchPointer }) });
  return { ...staged, ...announced };
}

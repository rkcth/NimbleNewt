import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { MANIFEST_FILE, PARTIAL_SUFFIX, parseBackupName, type BackupManifest } from "./format.js";
import { infoOf, listBackups, type BackupInfo } from "./retention.js";

/**
 * Where a copy of each backup goes besides the backups folder (card K01c). A folder on this machine, a folder on another disk, or an off-machine store that speaks the small protocol below over http(s). A target is
 * only ever asked to list its complete backups, take one in, give one back (for a test restore) and delete one; nothing else about it is known here.
 */
export type TargetKind = "folder" | "disk" | "offsite";
export const TARGET_KINDS: readonly TargetKind[] = ["folder", "disk", "offsite"];

export interface TargetTest { readonly ok: boolean; readonly detail: string; readonly warning?: string; readonly freeBytes?: number }

export interface TargetDriver {
  /** Whether it answers and takes a copy: reachable, writable. Never changes a backup. */
  test(): Promise<TargetTest>;
  /** The complete backups it holds, newest first (`path` identifies one to the driver's own `remove`, `manifest.name` is the name). Throws when the target cannot be reached: an unreachable target is not an empty one. */
  list(): Promise<BackupInfo[]>;
  /** Puts a finished backup folder in. A backup already there under that name is left (the same name is the same backup). The copy appears complete only once every file is in. */
  put(localDir: string, name: string): Promise<void>;
  /** Deletes the copy. True when it was there, false when it was not (already gone). Throws when the target cannot be reached. */
  remove(name: string): Promise<boolean>;
  /** Gives a copy back into a new local folder (the test restore reads it there). */
  fetch(name: string, intoDir: string): Promise<void>;
}

/** The name must be a backup's folder name: a target never takes or deletes any other name (no path, no dot segments). */
export function checkedName(name: string): string {
  if (parseBackupName(name) === undefined) throw new Error(`${JSON.stringify(name).slice(0, 80)} is not the name of a backup`);
  return name;
}

/** A folder on this machine or another disk: each backup is a folder inside it, put in place with a rename so a copy is complete or absent. */
export class FolderDriver implements TargetDriver {
  readonly #root: string;
  readonly #primary: string | undefined;
  constructor(root: string, options: { readonly primaryRoot?: string } = {}) { this.#root = resolve(root); this.#primary = options.primaryRoot === undefined ? undefined : resolve(options.primaryRoot); }

  async test(): Promise<TargetTest> {
    if (!isAbsolute(this.#root)) return { ok: false, detail: "the folder is not an absolute path" };
    try { await mkdir(this.#root, { recursive: true }); } catch (error) { return { ok: false, detail: `the folder cannot be made or reached: ${message(error)}` }; }
    const probe = join(this.#root, `.nn-target-test-${process.pid}-${Date.now().toString(36)}`);
    try { await mkdir(probe); await rm(probe, { recursive: true }); } catch (error) { return { ok: false, detail: `the folder cannot be written to: ${message(error)}` }; }
    let freeBytes: number | undefined;
    try { const s = await statfs(this.#root); freeBytes = Number(s.bavail) * Number(s.bsize); } catch { /* not every system can say */ }
    let warning: string | undefined;
    if (this.#primary !== undefined) {
      const same = await Promise.all([stat(this.#root), existingDev(this.#primary)]).then(([a, dev]) => dev !== undefined && a.dev === dev, () => false);
      if (same) warning = "this folder is on the same disk as the main backups folder: it does not protect the backups if that disk fails";
      if (this.#root === this.#primary || this.#root.startsWith(this.#primary + sep) || this.#primary.startsWith(this.#root + sep)) return { ok: false, detail: "this folder is the main backups folder or inside it (or holds it): a copy there is not a second copy" };
    }
    return { ok: true, detail: "the folder can be written to", ...(warning === undefined ? {} : { warning }), ...(freeBytes === undefined ? {} : { freeBytes }) };
  }

  async list(): Promise<BackupInfo[]> {
    try { await readdir(this.#root); } catch (error) { throw new Error(`the folder cannot be read: ${message(error)}`); }
    return listBackups(this.#root);
  }

  async put(localDir: string, name: string): Promise<void> {
    checkedName(name);
    const final = join(this.#root, name);
    if (await stat(final).then(() => true, () => false)) return;
    await mkdir(this.#root, { recursive: true });
    // Copies interrupted earlier (a crash) are cleared once they are an hour old; one being written now (by another controller, say) is left alone.
    for (const e of await readdir(this.#root).catch(() => [] as string[])) {
      const mine = e === `${name}${PARTIAL_SUFFIX}` || (e.startsWith(`${name}.`) && e.endsWith(PARTIAL_SUFFIX));
      if (!mine) continue;
      const old = await stat(join(this.#root, e)).then((st) => Date.now() - st.mtimeMs > 3_600_000, () => false);
      if (old) await rm(join(this.#root, e), { recursive: true, force: true }).catch(() => undefined);
    }
    // Each copy is written under a name of its own, so two copies of one backup at once never write into the same folder; the first rename wins.
    const partial = `${final}.${process.pid}-${randomBytes(4).toString("hex")}${PARTIAL_SUFFIX}`;
    try {
      await cp(localDir, partial, { recursive: true, errorOnExist: false, force: true });
      try { await rename(partial, final); } catch (error) { if (!await stat(join(final, MANIFEST_FILE)).then(() => true, () => false)) throw error; await rm(partial, { recursive: true, force: true }).catch(() => undefined); }
    } catch (error) { await rm(partial, { recursive: true, force: true }).catch(() => undefined); throw error; }
  }

  async remove(name: string): Promise<boolean> {
    checkedName(name);
    const final = join(this.#root, name);
    if (!await stat(final).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT")) return false;
    await rm(final, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return true;
  }

  async fetch(name: string, intoDir: string): Promise<void> {
    checkedName(name);
    await cp(join(this.#root, name), intoDir, { recursive: true });
  }
}

export interface HttpTargetOptions {
  /** The bearer token, read when needed from the secret store; never kept in the configuration. */
  readonly token?: () => Promise<string | undefined>;
  readonly timeoutMs?: number;
}

/** Why a location is refused as an off-machine address, or undefined when it can be used. Plain http is for this machine only (loopback): anything else must be https, and a password or token in the address is refused (use a credential name instead). */
export function offsiteLocationProblem(location: string): string | undefined {
  let url: URL;
  try { url = new URL(location); } catch { return "that is not an address (expected https://host/path)"; }
  if (url.username !== "" || url.password !== "") return "the address holds a user name or password: name a stored credential instead, never put it in the address";
  if (url.search !== "" || url.hash !== "") return "the address has a query or fragment: give the plain address and name a stored credential";
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && loopback) return undefined;
  return url.protocol === "http:" ? "plain http would send the backups unprotected over the network: use https (plain http is allowed only for this machine)" : "only https addresses are supported";
}

/** An off-machine store reached over http(s). Protocol: GET /status; GET /backups (complete names); GET /backups/<name> (its files); GET and PUT /backups/<name>/<file>; POST /backups/<name>/commit; DELETE /backups/<name>. */
export class HttpDriver implements TargetDriver {
  readonly #base: URL;
  readonly #o: HttpTargetOptions;
  constructor(location: string, options: HttpTargetOptions = {}) {
    const problem = offsiteLocationProblem(location);
    if (problem !== undefined) throw new Error(problem);
    this.#base = new URL(location.endsWith("/") ? location : `${location}/`);
    this.#o = options;
  }

  async #send(method: string, path: string, body?: { readonly stream?: NodeJS.ReadableStream; readonly size?: number }): Promise<{ status: number; body: Buffer }> {
    const url = new URL(path, this.#base);
    const token = await this.#o.token?.();
    const client = url.protocol === "https:" ? https : http;
    return new Promise((resolveDone, reject) => {
      const req = client.request(url, { method, timeout: this.#o.timeoutMs ?? 30_000, headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(body?.size === undefined ? {} : { "content-length": String(body.size) }), ...(body === undefined ? {} : { "content-type": "application/octet-stream" }) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolveDone({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("the target did not answer in time")));
      req.on("error", (error) => reject(new Error(`the target could not be reached: ${message(error)}`)));
      if (body?.stream !== undefined) pipeline(body.stream, req).catch(reject); else req.end();
    });
  }

  async #ok(method: string, path: string, body?: { readonly stream?: NodeJS.ReadableStream; readonly size?: number }): Promise<Buffer> {
    const r = await this.#send(method, path, body);
    if (r.status === 401 || r.status === 403) throw new Error("the target refused the credential");
    if (r.status < 200 || r.status >= 300) throw new Error(`the target answered ${r.status}`);
    return r.body;
  }

  async test(): Promise<TargetTest> {
    try {
      const status = JSON.parse((await this.#ok("GET", "status")).toString("utf8")) as { ok?: unknown; freeBytes?: unknown };
      if (status.ok !== true) return { ok: false, detail: "the target says it is not ready" };
      return { ok: true, detail: "the target answered and accepted the credential", ...(typeof status.freeBytes === "number" ? { freeBytes: status.freeBytes } : {}) };
    } catch (error) { return { ok: false, detail: message(error) }; }
  }

  async list(): Promise<BackupInfo[]> {
    const names = (JSON.parse((await this.#ok("GET", "backups")).toString("utf8")) as { backups?: unknown }).backups;
    if (!Array.isArray(names)) throw new Error("the target's list is not in the expected form");
    const out: BackupInfo[] = [];
    for (const name of names) {
      if (typeof name !== "string" || parseBackupName(name) === undefined) continue;
      // A backup the target lists but whose manifest cannot be read makes the whole list unreadable: what it holds (its key, its age) is unknown, so nothing may be decided from a list without it.
      const r = await this.#send("GET", `backups/${encodeURIComponent(name)}/${MANIFEST_FILE}`);
      if (r.status === 401 || r.status === 403) throw new Error("the target refused the credential");
      if (r.status !== 200) throw new Error(`the target lists ${name} but its manifest could not be read (it answered ${r.status})`);
      let manifest: BackupManifest;
      try { manifest = JSON.parse(r.body.toString("utf8")) as BackupManifest; } catch { throw new Error(`the target lists ${name} but its manifest is not readable`); }
      if (manifest === null || typeof manifest !== "object" || typeof manifest.name !== "string") throw new Error(`the target lists ${name} but its manifest is not readable`);
      out.push(infoOf(name, name, manifest));
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  async put(localDir: string, name: string): Promise<void> {
    checkedName(name);
    const known = await this.#send("GET", `backups/${encodeURIComponent(name)}`);
    if (known.status === 200) return;
    for (const rel of await filesUnder(localDir)) {
      const size = (await stat(join(localDir, ...rel.split("/")))).size;
      await this.#ok("PUT", `backups/${encodeURIComponent(name)}/${rel.split("/").map(encodeURIComponent).join("/")}`, { stream: createReadStream(join(localDir, ...rel.split("/"))), size });
    }
    await this.#ok("POST", `backups/${encodeURIComponent(name)}/commit`);
  }

  async remove(name: string): Promise<boolean> {
    checkedName(name);
    const r = await this.#send("DELETE", `backups/${encodeURIComponent(name)}`);
    if (r.status === 404) return false;
    if (r.status === 401 || r.status === 403) throw new Error("the target refused the credential");
    if (r.status < 200 || r.status >= 300) throw new Error(`the target answered ${r.status}`);
    return true;
  }

  async fetch(name: string, intoDir: string): Promise<void> {
    checkedName(name);
    const files = (JSON.parse((await this.#ok("GET", `backups/${encodeURIComponent(name)}`)).toString("utf8")) as { files?: unknown }).files;
    if (!Array.isArray(files)) throw new Error("the target's file list is not in the expected form");
    for (const rel of files) {
      if (typeof rel !== "string" || rel === "" || rel.split("/").some((p) => p === "" || p === "." || p === "..") || isAbsolute(rel) || rel.includes("\\")) throw new Error("the target listed a file name that is not allowed");
      const dest = join(intoDir, ...rel.split("/"));
      if (relative(intoDir, dest).startsWith("..")) throw new Error("the target listed a file name that is not allowed");
      await mkdir(dirname(dest), { recursive: true });
      const bytes = await this.#ok("GET", `backups/${encodeURIComponent(name)}/${rel.split("/").map(encodeURIComponent).join("/")}`);
      await new Promise<void>((done, fail) => { const out = createWriteStream(dest); out.on("error", fail); out.on("finish", done); out.end(bytes); });
    }
  }
}

/** The device of a folder, or of the nearest folder above it that exists (the main folder may not have been made yet). */
async function existingDev(path: string): Promise<number | undefined> {
  for (let p = path; ; p = dirname(p)) {
    const s = await stat(p).catch(() => undefined);
    if (s !== undefined) return s.dev;
    if (dirname(p) === p) return undefined;
  }
}

/** The files under a folder, as relative paths with forward slashes (links are not followed or sent). */
export async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...await filesUnder(dir, rel)); else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * An error in words that can go into a record or a notice: a system error is said by its code and the call that failed, never with the path or address it carries (those are the host's, and a record or notice
 * is no place for them); any other error by its message.
 */
export function safeMessage(error: unknown): string {
  const e = error as NodeJS.ErrnoException | undefined;
  if (e instanceof Error && typeof e.code === "string" && /^E[A-Z0-9_]+$/.test(e.code)) return `${SYSTEM_ERRORS[e.code] ?? "a system error"} (${e.code}${typeof e.syscall === "string" ? `, ${e.syscall}` : ""})`;
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
const SYSTEM_ERRORS: Readonly<Record<string, string>> = { ENOENT: "not found", EACCES: "permission denied", EPERM: "not permitted", ENOSPC: "no space left", EROFS: "read-only", ENOTDIR: "not a folder", EEXIST: "already exists", ENOTEMPTY: "not empty", EBUSY: "in use", EIO: "input/output error", ECONNREFUSED: "connection refused", ECONNRESET: "connection reset", ETIMEDOUT: "timed out", ENOTFOUND: "host not found", EHOSTUNREACH: "host unreachable", ENETUNREACH: "network unreachable", EMFILE: "too many open files", EDQUOT: "quota exceeded" };
const message = safeMessage;

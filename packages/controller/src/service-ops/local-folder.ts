import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { EffectRejected } from "../domain/effects.js";
import { sha256 } from "../storage/json.js";
import type { JsonObject } from "../storage/types.js";
import type { Observation, ServiceAction, ServiceRef, ServiceTarget } from "./target.js";

/**
 * Limits of the local-folder connector. `fileBytes`: the largest file an action may change (its whole text is kept in the ledger's record of the state before, which is bounded). `neighbours`: the most
 * files a service folder may hold besides the one changed; with more, the collateral check could not cover them all, so the action is refused. `readBytes`: the largest file read to give a version; a
 * larger neighbour is versioned by its size, change time and inode instead of its content.
 */
export const LOCAL_FOLDER_LIMITS = { fileBytes: 8 * 1024, neighbours: 50, readBytes: 1024 * 1024 } as const;
/** The folder inside the bound folder where the connector keeps the keys it applied (never a service: a service name starts with a letter). */
export const LOCAL_FOLDER_KEYS = ".nimblenewt-applied";
const NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const refKey = (r: ServiceRef): string => `${r.service}/${r.resource}`;
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const code = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * A real service target (card P03b): the files of a folder on this computer, bound to one folder when the controller starts. A service is a folder directly inside the bound folder; a resource is
 * a file directly inside a service folder (a configuration file, a status file, a small data file). Nothing outside the bound folder is ever read or written: names are plain names (no `/`, no
 * leading dot, so no `..`), every folder and file is checked to be what it says (a symbolic link, a hard-linked file, a device or a nested folder is refused, not followed), and a write never
 * opens the existing file: the new text goes to a new file in the same folder that then replaces it, so even a file linked from elsewhere is not changed through the link.
 *
 * Actions: `write` with `params.text` (the file's whole new text, UTF-8, at most `fileBytes`), and `set` with `params.fields` (the file holds a JSON object; the fields are merged into it). Both change the
 * named file only. Its version is its content's digest, so any change to it, by the connector or by anyone else, is a new version.
 *
 * Effects are confirmed only by reading the file back from the disk. Fail closed: a file or neighbour that cannot be read, or a service folder with more files than the neighbour check covers, refuses
 * the action before anything is written; a file that cannot be read back afterwards is not confirmed (the operation ends uncertain for a person to check). A key is applied at most once: the connector
 * records the key BEFORE it puts the new file in place, so a crash in between can only make it say "applied" for a change that did not happen (the read-back then does not match: uncertain), never
 * "not applied" for one that did (which would apply it twice).
 */
export class LocalFolderServices implements ServiceTarget {
  readonly root: string;
  readonly #clock: () => string;
  private constructor(root: string, clock: () => string) { this.root = root; this.#clock = clock; }

  /** Binds the connector to `folder`, which must exist and be a folder (not a link to one). The folder's real path is kept, so a later change of a link above it does not move the binding. */
  static async open(folder: string, options: { clock?: () => string } = {}): Promise<LocalFolderServices> {
    const seen = await lstat(folder).catch(() => undefined);
    if (seen === undefined || !seen.isDirectory() || seen.isSymbolicLink()) throw new Error(`the service folder ${folder} is not a folder (a link to one is not accepted)`);
    return new LocalFolderServices(await realpath(folder), options.clock ?? (() => new Date().toISOString()));
  }

  #names(ref: ServiceRef): { dir: string; file: string } {
    if (!NAME.test(ref.service) || !NAME.test(ref.resource)) throw new EffectRejected(`${refKey(ref)} is not a plain service and resource name`);
    const dir = join(this.root, ref.service);
    return { dir, file: join(dir, ref.resource) };
  }

  /** The service folder, checked: a real folder directly inside the bound folder. `undefined` when it does not exist; throws a plain reason when it is something else. */
  async #folder(dir: string): Promise<"absent" | "ok"> {
    let s;
    try { s = await lstat(dir); } catch (e) { if (code(e) === "ENOENT") return "absent"; throw new Error(`the service folder cannot be read (${code(e) ?? "error"})`); }
    if (s.isSymbolicLink()) throw new Error("the service folder is a link, which is not followed");
    if (!s.isDirectory()) throw new Error("the service is not a folder");
    if ((await realpath(dir)) !== dir) throw new Error("the service folder resolves outside the bound folder");
    return "ok";
  }

  /** Reads a resource without following links. `absent`, or the facts, or the reason it cannot be read. */
  async #read(ref: ServiceRef): Promise<{ kind: "absent" } | { kind: "unreadable"; reason: string } | { kind: "file"; bytes: number; digest: string; text?: string; stamp: string; mode: number }> {
    const { dir, file } = this.#names(ref);
    try {
      if ((await this.#folder(dir)) === "absent") return { kind: "absent" };
    } catch (e) { return { kind: "unreadable", reason: (e as Error).message }; }
    let s;
    try { s = await lstat(file); } catch (e) { return code(e) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: `the file cannot be looked at (${code(e) ?? "error"})` }; }
    if (s.isSymbolicLink()) return { kind: "unreadable", reason: "the file is a link, which is not followed" };
    if (!s.isFile()) return { kind: "unreadable", reason: "it is not a plain file" };
    if (s.nlink > 1) return { kind: "unreadable", reason: "the file has another name elsewhere (a hard link), so it may belong to something outside the folder" };
    const stamp = `${s.size}:${s.ino}:${s.ctimeMs}`;
    if (s.size > LOCAL_FOLDER_LIMITS.readBytes) return { kind: "file", bytes: s.size, digest: `large:${sha256(stamp).slice(0, 24)}`, stamp, mode: s.mode & 0o777 };
    let h: FileHandle | undefined;
    try {
      h = await open(file, constants.O_RDONLY | NOFOLLOW);
      const st = await h.stat();
      if (st.ino !== s.ino || !st.isFile()) return { kind: "unreadable", reason: "the file changed while it was being read" };
      const buf = await h.readFile();
      const digest = createHash("sha256").update(buf).digest("hex").slice(0, 32);
      const text = buf.length <= LOCAL_FOLDER_LIMITS.fileBytes ? new TextDecoder("utf-8", { fatal: true }).decode(buf) : undefined;
      return { kind: "file", bytes: buf.length, digest, ...(text === undefined ? {} : { text }), stamp, mode: s.mode & 0o777 };
    } catch (e) {
      if (e instanceof TypeError) return { kind: "unreadable", reason: "the file is not UTF-8 text" };
      return { kind: "unreadable", reason: `the file cannot be read (${code(e) ?? "error"})` };
    } finally { await h?.close().catch(() => undefined); }
  }

  /**
   * The resource as the disk holds it now. A file that cannot be read is reported (not hidden as absent) with a version that never matches another reading, so neither a read-back nor a neighbour
   * comparison can pass on it.
   */
  async observe(ref: ServiceRef): Promise<Observation | undefined> {
    const got = await this.#read(ref);
    if (got.kind === "absent") return undefined;
    const observedAt = this.#clock();
    if (got.kind === "unreadable") return { systemVersion: `unreadable-${randomBytes(6).toString("hex")}`, state: { unreadable: got.reason }, observedAt };
    const state: Record<string, JsonObject[string]> = { bytes: got.bytes, digest: got.digest };
    if (got.text === undefined) state["tooLarge"] = true;
    else {
      state["text"] = got.text;
      try { const parsed = JSON.parse(got.text) as unknown; if (isObject(parsed)) state["fields"] = parsed; } catch { /* not JSON: text only */ }
    }
    return { systemVersion: `sha256:${got.digest.slice(0, 16)}`, state, observedAt };
  }

  /** A write or a set changes the named file only. */
  async affects(ref: ServiceRef): Promise<readonly ServiceRef[]> { return [ref]; }

  /** The other entries of the same service folder, by name, at most `neighbours` of them (the action refuses a folder that holds more, so the list it was judged against is complete). */
  async neighbours(ref: ServiceRef): Promise<readonly ServiceRef[]> {
    const { dir } = this.#names(ref);
    let names: string[];
    try { if ((await this.#folder(dir)) === "absent") return []; names = await readdir(dir); } catch { return []; }
    return names.filter((n) => NAME.test(n) && n !== ref.resource).sort().slice(0, LOCAL_FOLDER_LIMITS.neighbours).map((resource) => ({ service: ref.service, resource }));
  }

  #keyFile(key: string): string { return join(this.root, LOCAL_FOLDER_KEYS, `${sha256(key).slice(0, 48)}.json`); }

  /** The keys folder, made when missing; refused when it is anything but a real folder. */
  async #keysFolder(): Promise<string> {
    const dir = join(this.root, LOCAL_FOLDER_KEYS);
    await mkdir(dir, { mode: 0o700 }).catch((e: unknown) => { if (code(e) !== "EEXIST") throw e; });
    const s = await lstat(dir);
    if (s.isSymbolicLink() || !s.isDirectory()) throw new Error("the connector's keys folder is not a real folder");
    return dir;
  }

  /** Writes `content` to a new file beside `target` and returns its path (nothing replaced yet). */
  async #stage(folder: string, content: string, mode: number): Promise<string> {
    const tmp = join(folder, `.nn-${randomBytes(8).toString("hex")}.tmp`);
    const h = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
    try { await h.writeFile(content, "utf8"); await h.sync(); } finally { await h.close(); }
    return tmp;
  }

  async apply(key: string, ref: ServiceRef, action: ServiceAction, context?: JsonObject): Promise<void> {
    const keyFile = this.#keyFile(key);
    if ((await this.applied(key)) !== false) return;
    const { dir, file } = this.#names(ref);
    // Nothing is written before every check has passed; each refusal says why and that nothing changed.
    const refuse = (why: string): never => { throw new EffectRejected(`${why}; nothing was changed`); };
    const current = await this.#read(ref);
    if (current.kind === "absent") refuse(`${refKey(ref)} does not exist`);
    if (current.kind === "unreadable") refuse(`${refKey(ref)} cannot be read: ${current.reason}`);
    const cur = current as Extract<typeof current, { kind: "file" }>;
    if (cur.text === undefined) refuse(`${refKey(ref)} is larger than ${LOCAL_FOLDER_LIMITS.fileBytes} bytes, which this connector does not change`);
    let entries: string[];
    try { entries = (await readdir(dir)).filter((n) => NAME.test(n) && n !== ref.resource); } catch (e) { return refuse(`the folder of ${ref.service} cannot be listed (${code(e) ?? "error"})`); }
    if (entries.length > LOCAL_FOLDER_LIMITS.neighbours) refuse(`${ref.service} holds ${entries.length} other files, more than the ${LOCAL_FOLDER_LIMITS.neighbours} the neighbour check covers`);
    const baseline = isObject(context?.["baseline"]) ? context["baseline"] : {};
    const blind = Object.entries(baseline).filter(([, v]) => typeof v === "string" && v.startsWith("unreadable-")).map(([k]) => k);
    if (blind.length > 0) refuse(`the neighbour${blind.length === 1 ? "" : "s"} ${blind.join(", ")} cannot be read, so a change to ${blind.length === 1 ? "it" : "them"} could not be noticed`);
    let content: string;
    if (action.type === "write") {
      const text = action.params?.["text"];
      if (typeof text !== "string") return refuse("write needs params.text, the file's whole new text");
      content = text;
    } else if (action.type === "set") {
      const fields = action.params?.["fields"];
      if (!isObject(fields)) return refuse("set needs params.fields");
      let was: unknown;
      try { was = JSON.parse(cur.text!); } catch { return refuse(`${refKey(ref)} does not hold a JSON object, so set cannot merge fields into it`); }
      if (!isObject(was)) return refuse(`${refKey(ref)} does not hold a JSON object, so set cannot merge fields into it`);
      content = `${JSON.stringify({ ...was, ...fields }, null, 2)}\n`;
    } else return refuse(`the action ${action.type} is not known to a folder service (write or set)`);
    if (Buffer.byteLength(content, "utf8") > LOCAL_FOLDER_LIMITS.fileBytes) refuse(`the new text is larger than ${LOCAL_FOLDER_LIMITS.fileBytes} bytes`);
    // 1. The new file is written beside the old one. 2. The key is recorded. 3. The new file replaces the old one. A failure before 3 changes nothing (the staged files are removed).
    let staged: string | undefined, stagedKey: string | undefined;
    try {
      staged = await this.#stage(dir, content, cur.mode);
      const keys = await this.#keysFolder();
      stagedKey = await this.#stage(keys, JSON.stringify({ ref: refKey(ref), action: action.type, ...(context === undefined ? {} : { context }) }), 0o600);
      const again = await lstat(file);
      if (again.isSymbolicLink() || !again.isFile() || `${again.size}:${again.ino}:${again.ctimeMs}` !== cur.stamp) throw new Error(`${refKey(ref)} changed while the change was being prepared`);
      await rename(stagedKey, keyFile);
      stagedKey = undefined;
    } catch (e) {
      if (staged !== undefined) await rm(staged, { force: true }).catch(() => undefined);
      if (stagedKey !== undefined) await rm(stagedKey, { force: true }).catch(() => undefined);
      if (e instanceof EffectRejected) throw e;
      return refuse(`the change could not be prepared: ${(e as Error).message}`);
    }
    // From here the key says applied: a failure is a lost answer, settled by reading the file back (never by writing again).
    await rename(staged, file);
    const d = await open(dir, constants.O_RDONLY).catch(() => undefined);
    if (d !== undefined) { await d.sync().catch(() => undefined); await d.close().catch(() => undefined); }
  }

  async applied(key: string): Promise<boolean | { readonly applied: boolean; readonly context?: JsonObject }> {
    let text: string;
    const file = this.#keyFile(key);
    try {
      const folder = await lstat(join(this.root, LOCAL_FOLDER_KEYS));
      if (folder.isSymbolicLink() || !folder.isDirectory()) throw new Error("the connector's keys folder is not a real folder");
      const s = await lstat(file);
      if (!s.isFile() || s.isSymbolicLink()) throw new Error("the record of an applied key is not a plain file");
      const h = await open(file, constants.O_RDONLY | NOFOLLOW);
      try { text = await h.readFile("utf8"); } finally { await h.close(); }
    } catch (e) {
      if (code(e) === "ENOENT") return false;
      // Unknown is not "not applied": the ledger keeps the effect pending and asks again.
      throw new Error(`whether the change was applied cannot be read (${code(e) ?? (e as Error).message})`);
    }
    const parsed = JSON.parse(text) as { context?: unknown };
    return { applied: true, ...(isObject(parsed.context) ? { context: parsed.context } : {}) };
  }

  verify(ref: ServiceRef, action: ServiceAction, _before: Observation, after: Observation): string | undefined {
    if (typeof after.state["unreadable"] === "string") return `${refKey(ref)} cannot be read back: ${after.state["unreadable"]}`;
    if (typeof after.state["text"] !== "string") return `${refKey(ref)} cannot be read back in full`;
    if (action.type === "write") {
      const want = action.params?.["text"];
      return after.state["text"] === want ? undefined : `${refKey(ref)} reads ${after.state["bytes"] as number} bytes that are not the text written`;
    }
    const fields = (action.params?.["fields"] ?? {}) as JsonObject;
    const got = after.state["fields"];
    if (!isObject(got)) return `${refKey(ref)} no longer holds a JSON object after the change`;
    for (const [k, v] of Object.entries(fields)) if (JSON.stringify(got[k]) !== JSON.stringify(v)) return `${refKey(ref)}.${k} reads ${JSON.stringify(got[k]) ?? "nothing"} after the change, not ${JSON.stringify(v)}`;
    return undefined;
  }
}

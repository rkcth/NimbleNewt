import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

/**
 * Removing the model's stored thinking from a conversation store for good (card K06c, owner decision 2026-10-22: stored thinking goes 14 days after its task is done).
 *
 * Pi Durable's conversation is append-only through its own API: an entry, once written, is never changed. The folder it keeps (`createJsonlStorage`: `main.jsonl` and the `doc-*` and `task-*` sidecars) is plain JSON lines, so this
 * rewrites those files with the thinking blocks of assistant messages left out, and nothing else changed. It works on a store NOTHING has open: the caller must know that the attempt that wrote it has ended (the task is done or
 * cancelled, which is final) and that no other process holds it; a file that changes while it is being rewritten stops the work (the original is left as it was).
 *
 * What is removed is the whole block: its text, its provider signature and the encrypted or redacted payloads (an Anthropic `thinking` or `redacted_thinking` block and an OpenAI reasoning item both travel as a block of type
 * `thinking` in Pi's model messages). A block without its signature is one the provider would refuse, so the block goes entirely instead of being blanked: no later request can send half of it. An assistant message that had
 * nothing else keeps one empty text block, so the message stays valid for a provider that refuses an empty one.
 *
 * The files are handled as bytes (review fix): a line with no thinking is copied exactly as it was (its line ending, its bytes), and so is a last line with no line end, which Pi itself cuts off when it opens the store (it is
 * a write that never finished; writing it back WITH a line end would turn it into a "complete" line Pi cannot read, and the store would no longer open). Such an unfinished last line that mentions thinking is left out, which is
 * what Pi's own opening does with it. A line that mentions thinking and is not valid UTF-8 JSON stops the work.
 *
 * One removal at a time per store (a lock file in the folder, taken over only when it is older than `STALE_LOCK_MS`): two at once (a manual run and the automatic pass, or a host asked again) would otherwise share the
 * temporary file names. The file that was read must still be the same file, unchanged, when it is replaced (same device, inode, size, modification and change time); its mode is kept; the new file and the folder are
 * flushed to disk around the rename. On Windows a rename the system refuses for a moment (another program has the file open) is tried again a few times.
 *
 * Not done here: this does not wipe the freed disk blocks (the file system may still hold the old bytes until they are reused), and it does not touch copies elsewhere (backups, which the retention rule names).
 */
export interface ThinkingPurgeResult {
  /** Files of the store that held thinking and were rewritten. */
  readonly files: number;
  /** Thinking blocks removed. */
  readonly blocks: number;
  /** Assistant messages that held nothing but thinking and now hold one empty text block. */
  readonly emptied: number;
}

const FILE = /^(?:main|doc-(?:0|[1-9]\d*)|task-(?:0|[1-9]\d*))\.jsonl$/;
/** Pi's own temporary copies of a sidecar it is shortening (Pi removes them itself whenever it opens the store); one left behind may hold thinking. */
const RECLAIM = /^(?:doc|task)-(?:0|[1-9]\d*)\.jsonl\.reclaim$/;
const MARK = /"type"\s*:\s*"thinking"/;
/** The lock file one removal keeps in the store's folder while it works. */
export const PURGE_LOCK = ".thinking-purge.lock";
const STALE_LOCK_MS = 15 * 60_000;
const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const utf8 = new TextDecoder("utf-8", { fatal: true });
const NL = 0x0a;

interface Counts { blocks: number; emptied: number }

/** Leaves out the thinking blocks of every assistant message inside `value` (any depth, so a message nested in a task record or a document is reached too). Returns whether anything changed. */
function strip(value: unknown, counts: Counts): boolean {
  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) if (strip(item, counts)) changed = true;
    return changed;
  }
  if (!isObject(value)) return false;
  if (value["role"] === "assistant" && Array.isArray(value["content"])) {
    const content = value["content"] as unknown[];
    const kept = content.filter((b) => !(isObject(b) && b["type"] === "thinking"));
    if (kept.length !== content.length) {
      counts.blocks += content.length - kept.length;
      if (kept.length === 0) { kept.push({ type: "text", text: "" }); counts.emptied += 1; }
      value["content"] = kept;
      changed = true;
    }
  }
  // The kept content of an assistant message still has nothing to strip inside the blocks that stay.
  for (const key of Object.keys(value)) if (key !== "content" || value["role"] !== "assistant") { if (strip(value[key], counts)) changed = true; }
  return changed;
}

type Stamp = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
const same = (a: Stamp, b: Stamp): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const changedError = (name: string): Error => new Error(`${name} changed while its thinking was being removed; nothing was changed`);

/** A rename over an existing file; Windows can refuse it for a moment while another program (a virus scanner, an indexer) has the file open. */
async function replace(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try { await rename(from, to); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || i >= 8 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await pause(25 * 2 ** i);
    }
  }
}

/** Flushes a folder's entries (the rename) to disk. Not possible on Windows, where a folder cannot be opened for this; best effort elsewhere. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  let h: FileHandle | undefined;
  try { h = await open(dir, constants.O_RDONLY); await h.sync(); } catch { /* best effort */ } finally { await h?.close().catch(() => undefined); }
}

/** Test seams. `afterRead`: runs once a file was read and its new version written, before the check that it is unchanged and the rename. */
export interface ThinkingPurgeHooks { readonly afterRead?: (name: string) => Promise<void> }

async function rewrite(dir: string, name: string, hooks: ThinkingPurgeHooks): Promise<{ blocks: number; emptied: number } | undefined> {
  const path = join(dir, name);
  const before = await lstat(path);
  if (!before.isFile()) return undefined;
  let input: FileHandle;
  try { input = await open(path, constants.O_RDONLY | O_NOFOLLOW); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return undefined;
    throw error;
  }
  const tmp = join(dir, `${name}.purge`);
  const counts: Counts = { blocks: 0, emptied: 0 };
  let touched = false;
  let out: FileHandle | undefined;
  try {
    // The file opened must be the one looked at (a link or another file put in its place between the two is not read).
    const opened = await input.stat();
    if (!opened.isFile() || !same(opened, before)) throw changedError(name);
    out = await open(tmp, "wx", 0o600);
    const chunks: Buffer[] = []; let queued = 0;
    const emit = async (b: Buffer): Promise<void> => { chunks.push(Buffer.from(b)); queued += b.length; if (queued > 1 << 20) { await out!.write(Buffer.concat(chunks)); chunks.length = 0; queued = 0; } };
    /** One line of the file without its `\n` (a `\r` before it stays part of the line). `ended`: a `\n` followed it. */
    const line = async (bytes: Buffer, ended: boolean): Promise<void> => {
      // Only a line that may hold a thinking block is decoded at all; every other line is copied byte for byte.
      if (!MARK.test(bytes.toString("latin1"))) { await emit(bytes); if (ended) await emit(Buffer.of(NL)); return; }
      if (!ended) { touched = true; return; } // an unfinished last write that mentions thinking: Pi cuts it off when it opens the store
      let parsed: unknown;
      try { parsed = JSON.parse(utf8.decode(bytes)); } catch { throw new Error(`${name} has a line that is not JSON; nothing was changed`); }
      if (!strip(parsed, counts)) { await emit(bytes); await emit(Buffer.of(NL)); return; }
      touched = true;
      const cr = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d;
      await emit(Buffer.from(`${JSON.stringify(parsed)}${cr ? "\r" : ""}\n`, "utf8"));
    };
    let carry: Buffer = Buffer.alloc(0);
    const buf = Buffer.alloc(64 * 1024);
    let at = 0;
    for (;;) {
      const { bytesRead } = await input.read(buf, 0, buf.length, at);
      if (bytesRead === 0) break;
      at += bytesRead;
      const data = carry.length === 0 ? buf.subarray(0, bytesRead) : Buffer.concat([carry, buf.subarray(0, bytesRead)]);
      let start = 0;
      for (let nl = data.indexOf(NL, start); nl >= 0; nl = data.indexOf(NL, start)) { await line(data.subarray(start, nl), true); start = nl + 1; }
      carry = Buffer.from(data.subarray(start));
    }
    if (carry.length > 0) await line(carry, false);
    if (chunks.length > 0) await out.write(Buffer.concat(chunks));
    if (!touched) { await out.close(); out = undefined; await rm(tmp, { force: true }); return { blocks: 0, emptied: 0 }; }
    // The new file has the mode the old one had (the owner and group are this process's: a rename cannot keep another owner's).
    if (process.platform !== "win32") await out.chmod(before.mode & 0o7777).catch(() => undefined);
    await out.sync();
    await out.close(); out = undefined;
    await hooks.afterRead?.(name);
    // The file must be the one that was read and as it was when it was read: a writer that appended or replaced it meanwhile means the store was not idle, and the rewrite is dropped.
    const now = await input.stat();
    const after = await lstat(path);
    if (!after.isFile() || !same(after, before) || !same(now, before)) throw changedError(name);
    // Windows refuses to replace a file this process still has open.
    await input.close();
    await replace(tmp, path);
    await syncDir(dir);
    return counts;
  } catch (error) {
    await out?.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await input.close().catch(() => undefined);
  }
}

/** Takes the store's lock (one removal at a time). A lock left by a removal that stopped half way (a crash) is taken over once it is old. */
async function lock(dir: string): Promise<() => Promise<void>> {
  const path = join(dir, PURGE_LOCK);
  for (let i = 0; i < 2; i++) {
    try {
      const h = await open(path, "wx", 0o600);
      await h.close();
      return async () => { await rm(path, { force: true }).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(path).catch(() => undefined);
      if (info !== undefined && info.isFile() && Date.now() - info.mtimeMs < STALE_LOCK_MS) break;
      await rm(path, { force: true });
    }
  }
  throw new Error("another removal of stored thinking is working on this store; nothing was changed");
}

/**
 * Removes the thinking from the conversation store in `dir`. Throws, with the original files untouched, when a file is not valid JSON lines, changed while it was read, or another removal holds the store. Safe to run again:
 * a store with no thinking left is read and left byte for byte as it was.
 */
export async function removeStoredThinking(dir: string, hooks: ThinkingPurgeHooks = {}): Promise<ThinkingPurgeResult> {
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new Error("the conversation store is not a plain folder");
  const unlock = await lock(dir);
  try {
    const all = await readdir(dir);
    const names = all.filter((n) => FILE.test(n)).sort();
    // A leftover of an earlier try that stopped half way is not a store file; it is removed so it cannot be taken for one. Pi's own leftovers (`.reclaim`) are removed by Pi whenever it opens the store, and may hold thinking.
    for (const n of all) if (n.endsWith(".jsonl.purge") || RECLAIM.test(n)) await rm(join(dir, n), { force: true });
    let files = 0; let blocks = 0; let emptied = 0;
    for (const name of names) {
      const done = await rewrite(dir, name, hooks);
      if (done === undefined) continue;
      if (done.blocks > 0) files += 1;
      blocks += done.blocks; emptied += done.emptied;
    }
    return { files, blocks, emptied };
  } finally { await unlock(); }
}

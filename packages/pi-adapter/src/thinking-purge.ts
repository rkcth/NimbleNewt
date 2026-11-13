import { createReadStream } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

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
const MARK = /"type"\s*:\s*"thinking"/;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

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
  for (const key of Object.keys(value)) if (key !== "content" || value["role"] !== "assistant") { if (strip(value[key], counts)) changed = true; }
  // The kept content of an assistant message still has nothing to strip inside the blocks that stay.
  return changed;
}

async function rewrite(dir: string, name: string): Promise<{ blocks: number; emptied: number } | undefined> {
  const path = join(dir, name);
  const before = await lstat(path);
  if (!before.isFile()) return undefined;
  const tmp = join(dir, `${name}.purge`);
  const counts: Counts = { blocks: 0, emptied: 0 };
  let touched = false;
  const out = await open(tmp, "wx", 0o600);
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    let pending = "";
    const flush = async (): Promise<void> => { if (pending !== "") { await out.write(pending); pending = ""; } };
    for await (const line of lines) {
      let text = line;
      if (MARK.test(line)) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { throw new Error(`${name} has a line that is not JSON; nothing was changed`); }
        if (strip(parsed, counts)) { text = JSON.stringify(parsed); touched = true; }
      }
      pending += `${text}\n`;
      if (pending.length > 1 << 20) await flush();
    }
    await flush();
    await out.sync();
  } catch (error) {
    await out.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw error;
  }
  await out.close();
  if (!touched) { await rm(tmp, { force: true }); return { blocks: 0, emptied: 0 }; }
  // The file must be as it was when it was read: a writer that appended meanwhile means the store was not idle, and the rewrite is dropped.
  const after = await lstat(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) { await rm(tmp, { force: true }); throw new Error(`${name} changed while its thinking was being removed; nothing was changed`); }
  await rename(tmp, path);
  return counts;
}

/**
 * Removes the thinking from the conversation store in `dir`. Throws, with the original files untouched, when a file is not valid JSON lines or changed while it was read. Safe to run again: a store with no thinking left is read and left byte for byte as it was.
 */
export async function removeStoredThinking(dir: string): Promise<ThinkingPurgeResult> {
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new Error("the conversation store is not a plain folder");
  const names = (await readdir(dir)).filter((n) => FILE.test(n)).sort();
  // A leftover of an earlier try that stopped half way is not a store file; it is removed so it cannot be taken for one.
  for (const n of await readdir(dir)) if (n.endsWith(".jsonl.purge")) await rm(join(dir, n), { force: true });
  let files = 0; let blocks = 0; let emptied = 0;
  for (const name of names) {
    const done = await rewrite(dir, name);
    if (done === undefined) continue;
    if (done.blocks > 0) files += 1;
    blocks += done.blocks; emptied += done.emptied;
  }
  return { files, blocks, emptied };
}

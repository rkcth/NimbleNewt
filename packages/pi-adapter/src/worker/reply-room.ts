import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReplyCut } from "@nimblenewt/contracts";

/**
 * A reply cut at the reply limit with no visible text (W09 fixes, item 3). On a reasoning model a reply can spend the whole limit thinking and say nothing; W04 then nudges it ("stop deliberating, act"), but with the same limit the next
 * reply is often cut the same way (W09 first reading, run 2: 13 generations in a row, none with text). Such a cut is now retryable: each one doubles the process's reply limit, up to the ceiling the host gives (`replyCeiling`: the
 * route's own reply limit when the owner set one, so it never grows past it). The limit and the count are kept in the attempt's store folder, so a readmit of the same attempt (W03) starts from the raised limit. The count goes with
 * every turn result (`replyCut`), so the attempt's record says how often replies were cut and at what limit, instead of only that the turn ended `length`.
 */
export const REPLY_ROOM_FILE = "reply-limit.json";

export class ReplyRoom {
  #limit: number;
  #cuts: number;
  constructor(readonly base: number, readonly ceiling: number, saved?: { readonly limit: number; readonly cuts: number }) {
    this.#limit = saved === undefined ? base : Math.min(ceiling, Math.max(base, saved.limit));
    this.#cuts = saved?.cuts ?? 0;
  }
  get limit(): number { return this.#limit; }
  get cuts(): number { return this.#cuts; }
  /** Whether the limit is above what the host gave (the relay must raise requests to it). */
  get raised(): boolean { return this.#limit > this.base; }
  /** One reply cut with no visible text: counted, and the limit doubled up to the ceiling. Returns whether it grew. */
  cut(): boolean {
    this.#cuts = Math.min(this.#cuts + 1, 1000);
    const next = Math.min(this.ceiling, this.#limit * 2);
    if (next <= this.#limit) return false;
    this.#limit = next;
    return true;
  }
  /** What a turn result carries: absent while no reply was cut. */
  record(): ReplyCut | undefined { return this.#cuts === 0 ? undefined : { cuts: this.#cuts, limit: this.#limit, ceiling: this.ceiling }; }
}

/** Whether a reply is a cut with nothing visible: stopped on the reply limit (`length`) and no visible text. */
export const cutWithoutText = (stopReason: string | undefined, visibleText: string): boolean => stopReason === "length" && visibleText.trim() === "";

/** The room kept in `dir` from an earlier process of this attempt, or undefined (none, unreadable or not well formed: the host's limit is used). */
export async function loadReplyRoom(dir: string, base: number, ceiling: number): Promise<ReplyRoom> {
  try {
    const v = JSON.parse(await readFile(join(dir, REPLY_ROOM_FILE), "utf8")) as { v?: unknown; limit?: unknown; cuts?: unknown };
    const ok = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 1_000_000;
    if (v?.v === 1 && ok(v.limit) && ok(v.cuts)) return new ReplyRoom(base, ceiling, { limit: v.limit, cuts: Math.min(v.cuts, 1000) });
  } catch { /* none kept */ }
  return new ReplyRoom(base, ceiling);
}

/** Keeps the room for the next process of this attempt (written whole, then renamed). A failure loses only the raise. */
export async function saveReplyRoom(dir: string, room: ReplyRoom): Promise<void> {
  const file = join(dir, REPLY_ROOM_FILE);
  await writeFile(`${file}.tmp`, `${JSON.stringify({ v: 1, limit: room.limit, cuts: room.cuts })}\n`, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

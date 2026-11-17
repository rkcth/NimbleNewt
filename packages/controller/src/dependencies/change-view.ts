import type { DependencyEntry, ManifestBody } from "./dependencies.js";

/**
 * The resume reviewer's view of what changed (card L04g): before this, the reviewer agent was told only the controller's note of a change ("the content differs"), never the change itself. For a file, an external resource or an MCP
 * resource whose text the controller read both when it was recorded and when the check looked again, the reviewer is given a bounded line diff of the two texts. Both texts were redacted when they were read, so a secret never reaches the
 * reviewer's model through a diff.
 * - `chars`: the longest diff given for one change; the rest is said to be left out, never silently cut.
 * - `lines`: past this many changed lines on either side the diff is not aligned line by line (that is quadratic), it lists what was removed and what was added.
 * - `recent`: how many texts read by checks this process keeps (the oldest go first); `ms`: how long one is kept.
 */
export const CHANGE_VIEW_LIMITS = { chars: 3_000, lines: 400, context: 2, recent: 500, ms: 30 * 60_000 } as const;

/**
 * A bounded line diff of `before` and `after` in the unified style: `@@ line N @@`, then the changed lines (`-` removed, `+` added) with up to two unchanged lines (` `) around them. At most `max` characters; what does not fit is counted in
 * a last line. Two equal texts give an empty string.
 */
export function boundedDiff(before: string, after: string, max: number = CHANGE_VIEW_LIMITS.chars): string {
  if (before === after) return "";
  const a = before.split("\n"); const b = after.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const oldMid = a.slice(p, a.length - q); const newMid = b.slice(p, b.length - q);
  const lines: string[] = [`@@ line ${p + 1} @@`];
  for (const l of a.slice(Math.max(0, p - CHANGE_VIEW_LIMITS.context), p)) lines.push(` ${l}`);
  if (oldMid.length <= CHANGE_VIEW_LIMITS.lines && newMid.length <= CHANGE_VIEW_LIMITS.lines) lines.push(...aligned(oldMid, newMid));
  else { for (const l of oldMid) lines.push(`-${l}`); for (const l of newMid) lines.push(`+${l}`); }
  for (const l of a.slice(a.length - q, Math.min(a.length, a.length - q + CHANGE_VIEW_LIMITS.context))) lines.push(` ${l}`);
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    // One very long line (a minified file) is cut, said so, rather than filling the whole view.
    const line = lines[i]!.length > 400 ? `${lines[i]!.slice(0, 400)}… (line cut)` : lines[i]!;
    const next = `${out}${i === 0 ? "" : "\n"}${line}`;
    if (next.length > max - 60) {
      const left = lines.slice(i).reduce((n, l) => n + l.length + 1, 0);
      return `${out}\n… (${lines.length - i} more lines, ${left} characters, not shown)`;
    }
    out = next;
  }
  return out;
}

/** The changed middle of two texts aligned by their longest common run of lines: unchanged lines with a space, removed with `-`, added with `+`. */
function aligned(a: readonly string[], b: readonly string[]): string[] {
  const n = a.length, m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(` ${a[i]}`); i++; j++; } else if (table[i + 1]![j]! >= table[i]![j + 1]!) { out.push(`-${a[i]}`); i++; } else { out.push(`+${b[j]}`); j++; }
  }
  while (i < n) out.push(`-${a[i++]}`);
  while (j < m) out.push(`+${b[j++]}`);
  return out;
}

/** The texts the resume checks of this process read most recently, per task and entry, with the hash they were read at (bounded in number and age). */
export class RecentTexts {
  readonly #items = new Map<string, { readonly hash?: string; readonly text: string; readonly at: number }>();
  readonly #now: () => number;
  constructor(now: () => number = Date.now) { this.#now = now; }
  set(taskId: string, entryId: string, text: string | undefined, hash?: string): void {
    const k = `${taskId}\0${entryId}`;
    this.#items.delete(k);
    if (text === undefined) return;
    this.#items.set(k, { text, at: this.#now(), ...(hash === undefined ? {} : { hash }) });
    while (this.#items.size > CHANGE_VIEW_LIMITS.recent) this.#items.delete(this.#items.keys().next().value as string);
  }
  /** The text kept for this entry only when it was read at this hash. */
  at(taskId: string, entryId: string, hash: string): string | undefined {
    const got = this.#items.get(`${taskId}\0${entryId}`);
    return got !== undefined && got.hash === hash.replace(/^sha256:/, "") ? this.get(taskId, entryId) : undefined;
  }
  get(taskId: string, entryId: string): string | undefined {
    const k = `${taskId}\0${entryId}`;
    const got = this.#items.get(k);
    if (got === undefined) return undefined;
    if (this.#now() - got.at > CHANGE_VIEW_LIMITS.ms) { this.#items.delete(k); return undefined; }
    return got.text;
  }
}

/** The kinds whose change can be shown as text. */
const TEXT_KINDS: ReadonlySet<string> = new Set(["file", "external", "mcp-resource"]);

/**
 * The view of one change for the reviewer: a diff of the text kept when the entry was recorded (`textOf`) and the text the latest check read (`recent`), or why there is none. `deleted` shows the whole earlier text as removed. Never throws.
 */
export function changeViews(deps: { manifest(taskId: string): Promise<ManifestBody | undefined>; textOf(taskId: string, entry: DependencyEntry): Promise<string | undefined>; readonly recent: RecentTexts }): (taskId: string, change: { readonly id: string; readonly kind: string; readonly status: string }) => Promise<{ readonly diff: string } | { readonly none: string }> {
  return async (taskId, change) => {
    try {
      if (!TEXT_KINDS.has(change.kind)) return { none: "a change of this kind has no text; the note says what changed" };
      const entry = (await deps.manifest(taskId))?.entries.find((e) => e.id === change.id);
      if (entry === undefined) return { none: "the dependency is no longer recorded" };
      const before = await deps.textOf(taskId, entry);
      if (before === undefined) return { none: "the text seen when it was recorded was not kept (it was recorded by its hash only, or is not text, or is larger than the controller keeps)" };
      const after = change.status === "deleted" ? "" : deps.recent.get(taskId, entry.id);
      if (after === undefined) return { none: "the text now could not be read here (it is on a remote host, is not text, or is larger than the controller reads)" };
      const diff = boundedDiff(before, after);
      return diff === "" ? { none: "the visible text is the same; what differs was redacted or is outside the text" } : { diff };
    } catch {
      return { none: "the change could not be put together" };
    }
  };
}

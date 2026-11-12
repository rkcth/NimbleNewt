import { cleanUntrusted } from "./credential-scan.js";

/**
 * Text that reaches the controller or a log from something the host does not control (a child process's stderr, an error that quotes a command line or a header, a check's output) with every credential
 * shape replaced, by the shared scanner (`credential-scan.ts`: fullwidth letters, invisible characters and keys split over lines or quotes are seen through). It is cleaned BEFORE it is cut to
 * `max`, so a cut never leaves half of a key that the scanner would no longer recognise. Controls other than a line break and tab are dropped (terminal escapes) and a lone surrogate goes with them.
 *
 * Only a bounded window is cleaned: the part that can be kept plus `SAFE_MARGIN` characters, cut at white space (a one-line key has none, so the cut does not split it). Cleaning a whole check output of
 * many megabytes to keep its last 8000 characters stalled the host for seconds per megabyte and took gigabytes of memory.
 */
export const SAFE_MARGIN = 16 * 1024;

export function safeText(value: unknown, max: number): string {
  const raw = typeof value === "string" ? value : String((value as Error | undefined)?.message ?? value);
  const text = cleanUntrusted(head(raw, max), { lines: "keep" }).text;
  return text.length > max ? text.slice(0, max) : text;
}

/** The same for the tail of a long output: the last `max` characters of the cleaned text. */
export function safeTail(value: string, max: number): string {
  const window = tail(value, max);
  // A window that starts inside the output may hold the END of a private key whose BEGIN was cut off: everything up to such an END is that key.
  const text = cleanUntrusted(window, { lines: "keep", continues: window.length < value.length }).text;
  return text.length > max ? text.slice(text.length - max) : text;
}

function head(raw: string, max: number): string {
  const limit = Math.max(0, max) + SAFE_MARGIN;
  if (raw.length <= limit) return raw;
  const window = raw.slice(0, limit);
  const cut = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"), window.lastIndexOf("\t"));
  return cut > max ? window.slice(0, cut) : window;
}

function tail(raw: string, max: number): string {
  const limit = Math.max(0, max) + SAFE_MARGIN;
  if (raw.length <= limit) return raw;
  const window = raw.slice(raw.length - limit);
  const found = window.slice(0, SAFE_MARGIN).search(/[ \t\n]/);
  return found < 0 ? window : window.slice(found + 1);
}

// Error text for the launcher and host scripts, with every credential shape replaced by the shared scanner (the built contracts package: `safeText`, the same code as the worker host and the
// controller use: fullwidth letters, look-alike letters, invisible characters and keys split over lines or quotes are seen through). Before this, two scripts removed only `Bearer ...` and the others printed
// `error.message` raw. The scripts run from the built tree, so the helper loads `packages/contracts/dist` once; when that is not built (a failure BEFORE the first build is the likeliest time to print an
// error), a conservative fallback is used instead: it removes `Bearer` text, named assignments and every run of 20 or more key characters, so it may remove more than the scanner would, never less than the old rule.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// fileURLToPath, not the URL's pathname: a pathname keeps percent escapes (`John%20Smith`), so a checkout under a folder with a space or a non-ASCII letter would never find the build and always fall back.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let contracts;
try {
  const file = join(root, "packages", "contracts", "dist", "index.js");
  if (existsSync(file)) contracts = await import(pathToFileURL(file).href);
} catch { contracts = undefined; }

/**
 * Used when the contracts package is not built: removes `Bearer` text, addresses with a password, key prefixes, web tokens, named assignments and long key-character runs. Invisible characters and
 * combining marks go BEFORE NFKC (NFKC would join an accent to its letter and break a key's run). It does not read look-alike letters (`ghр_` with a Cyrillic letter) as Latin: a long key is still
 * removed by the run rule, a short look-alike key name is not.
 */
export function fallbackClean(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufe00-\ufe0f\ufeff\u{e0000}-\u{e01ef}]|\p{M}|\p{Cf}/gu, "")
    .normalize("NFKC")
    .replace(/Bearer\s+\S+/gi, "Bearer [removed]")
    // A password in an address (`postgres://user:password@host`), the likeliest credential in an error that names a connection.
    .replace(/\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]+):[^\s@/]+@/gi, "$1:[removed]@")
    // Key prefixes whose shortest key is under the run length below (`sk-` and 16 characters, `xoxb-` and 10), and a web token's dotted parts.
    .replace(/(?<![A-Za-z0-9])(?:sk-|[rs]k_|gh[pousr]_|github_pat_|xox[abprs]-|xapp-|npm_|hf_|glpat-|dckr_pat_|do[opr]_v1_|shp(?:at|ca|pa|ss)_|AKIA|ASIA|AIza)[A-Za-z0-9_-]{6,}/gi, "[removed]")
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_.-]+/g, "[removed]")
    .replace(/\b(?:password|passwd|secret|api[-_]?key|token|auth[-_]?token|access[-_]?key|private[-_]?key|authorization)["']?\s*[=:]\s*\S+/gi, "[removed]")
    .replace(/[A-Za-z0-9+/_~=-]{20,}/g, "[removed]");
}

const BEARER_LEFT = /Bearer\s+(?!\[redacted\])\S+/gi;

/** What an error says, safe to print: the message (or the value itself) cleaned, then cut to `max` characters (default 400). Never throws. */
export function safeMessage(error, max = 400) {
  try {
    const raw = typeof error === "string" ? error : String(error?.message ?? error);
    // The scanner needs 16 or more characters after `Bearer`; the old rule removed any word after it, and a short one is still removed (never less than before).
    if (typeof contracts?.safeText === "function") return contracts.safeText(raw, max).replace(BEARER_LEFT, "Bearer [removed]");
    return fallbackClean(raw).slice(0, max);
  } catch {
    return "[the error text could not be cleaned and is left out]";
  }
}

export const usesSharedScanner = () => typeof contracts?.safeText === "function";

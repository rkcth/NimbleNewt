// Error text for the launcher and host scripts, with every credential shape replaced by the shared scanner (the built contracts package: `safeText`, the same code as the worker host and the
// controller use: fullwidth letters, look-alike letters, invisible characters and keys split over lines or quotes are seen through). Before this, two scripts removed only `Bearer ...` and the others printed
// `error.message` raw. The scripts run from the built tree, so the helper loads `packages/contracts/dist` once; when that is not built (a failure BEFORE the first build is the likeliest time to print an
// error), a conservative fallback is used instead: it removes `Bearer` text, named assignments and every run of 20 or more key characters, so it may remove more than the scanner would, never less than the old rule.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
let contracts;
try {
  const file = join(root, "packages", "contracts", "dist", "index.js");
  if (existsSync(file)) contracts = await import(pathToFileURL(file).href);
} catch { contracts = undefined; }

/** Used when the contracts package is not built: removes more than the shared scanner would, never less than the old `Bearer` rule. */
export function fallbackClean(text) {
  return String(text)
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/Bearer\s+\S+/gi, "Bearer [removed]")
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

/**
 * The one cleaning pipeline for words another party wrote (an agent's text, a model's thinking, a hand-off) before they reach an agent, a store or an owner view. Same ordered steps everywhere:
 * 1. redact (`redactText`, which already matches through an NFKC-folded view without invisible characters, so a key hidden by them or written in fullwidth letters is found, and a key split over lines
 *    is found while the lines are still there);
 * 2. normalise: the MATCHING is always NFKC (step 1 and 4 match through a folded view); the text itself keeps its characters by default (`form: "none"`, so counts and cuts made over it, and a
 *    decomposed accent, stay as written), or is put in `NFC` (the thinking store) or `NFKC` (fullwidth and compatibility forms become the plain characters);
 * 3. strip controls, bidirectional and zero-width characters, tags, fillers and half surrogate pairs (`isHidden`); line breaks and tabs are kept (`lines: "keep"`) or every whitespace run, C0 and C1
 *    control becomes one space (`lines: "fold"`);
 * 4. redact AGAIN: stripping can join the pieces of a token into a credential's shape (card W13 review).
 */
import { REDACTED, redactText } from "./redact.js";
import { isHidden } from "./secret-scan.js";

export interface CleanOptions {
  /** `keep`: line breaks (CR LF and CR become LF) and tabs stay. `fold`: whitespace, C0 and C1 controls become single spaces (one line). */
  readonly lines: "keep" | "fold";
  /** Unicode normal form of the result. Default `none` (unchanged); matching is NFKC-folded whatever this is. */
  readonly form?: "NFKC" | "NFC" | "none";
}

export interface Cleaned { readonly text: string; readonly redacted: boolean }

function strip(text: string, lines: "keep" | "fold"): string {
  // eslint-disable-next-line no-control-regex
  const flat = lines === "fold" ? text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ") : text.replace(/\r\n?/g, "\n");
  let out = "";
  for (const ch of flat) if (ch === "\n" || ch === "\t" || !isHidden(ch)) out += ch;
  return out;
}

export function cleanUntrusted(value: string, options: CleanOptions): Cleaned {
  const first = redactText(value);
  const form = options.form ?? "none";
  const stripped = strip(form === "none" ? first : first.normalize(form), options.lines);
  const text = redactText(stripped);
  return { text, redacted: first !== value || text !== stripped };
}

export { REDACTED };

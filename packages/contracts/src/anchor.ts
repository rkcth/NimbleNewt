import { createHash } from "node:crypto";

/**
 * The goal anchor's block (card W12), as the worker process finds and replaces it. The controller writes the block (`packages/controller/src/context/anchor.ts`; it does not depend on this package, so the finding and
 * stripping code is restated here and a test keeps the two equal): `[NN-ANCHOR v1 sha256:<digest>]`, a body, `[/NN-ANCHOR sha256:<digest>]`, the digest being the SHA-256 of the body. Only a block whose digest checks out
 * is a block: text that merely looks like one is left as it is.
 */

/** The longest block the channel carries (the owner's largest cap is 6,000 characters). */
export const ANCHOR_CHANNEL_MAX = 8000;
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The spans of `[NN-ANCHOR v1 sha256:<d>]\n<body>\n[/NN-ANCHOR sha256:<d>]` in a text, in order and without overlap, exactly the matches of the pattern
 * `/\[NN-ANCHOR v1 sha256:([0-9a-f]{64})\]\n([\s\S]*?)\n\[\/NN-ANCHOR sha256:\1\]/g` (whether or not the digest checks out), found in linear time (W12 second review: the pattern looked to the end of the text for every
 * begin line, so a text full of begin lines took time growing with the square of its length, inside the summary step).
 */
function blockSpans(text: string): { readonly start: number; readonly end: number; readonly digest: string; readonly body: string }[] {
  const ends = new Map<string, number[]>();
  for (const m of text.matchAll(/\n\[\/NN-ANCHOR sha256:([0-9a-f]{64})\]/g)) { const list = ends.get(m[1]!); if (list === undefined) ends.set(m[1]!, [m.index]); else list.push(m.index); }
  const next = new Map<string, number>();
  const out: { start: number; end: number; digest: string; body: string }[] = [];
  const open = /\[NN-ANCHOR v1 sha256:([0-9a-f]{64})\]\n/g;
  for (let m = open.exec(text); m !== null; m = open.exec(text)) {
    const digest = m[1]!, bodyStart = m.index + m[0].length;
    const list = ends.get(digest);
    if (list === undefined) continue;
    let i = next.get(digest) ?? 0;
    while (i < list.length && list[i]! < bodyStart) i += 1;
    next.set(digest, i);
    if (i === list.length) continue;
    const q = list[i]!, end = q + 1 + `[/NN-ANCHOR sha256:${digest}]`.length;
    out.push({ start: m.index, end, digest, body: text.slice(bodyStart, q) });
    open.lastIndex = end;
  }
  return out;
}

/** The blocks in a text that check out, in order. */
export function findAnchors(text: string): { readonly text: string; readonly digest: string; readonly at: number }[] {
  return blockSpans(text).filter((b) => sha(b.body) === b.digest).map((b) => ({ text: text.slice(b.start, b.end), digest: b.digest, at: b.start }));
}

/** The text with every block that checks out taken away (and the blank lines it leaves folded). */
export function stripAnchors(text: string): string {
  let out = "", from = 0;
  for (const b of blockSpans(text)) if (sha(b.body) === b.digest) { out += text.slice(from, b.start); from = b.end; }
  return (out + text.slice(from)).replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "");
}

/** The block's digest when the text is exactly one block that checks out, else `undefined`. */
export function verifyAnchor(text: string): string | undefined {
  const found = findAnchors(text);
  return found.length === 1 && found[0]!.text === text ? found[0]!.digest : undefined;
}

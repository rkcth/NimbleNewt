import { createHash } from "node:crypto";

/**
 * The goal anchor's block (card W12), as the worker process finds and replaces it. The controller writes the block (`packages/controller/src/context/anchor.ts`; it does not depend on this package, so the finding and
 * stripping code is restated here and a test keeps the two equal): `[NN-ANCHOR v1 sha256:<digest>]`, a body, `[/NN-ANCHOR sha256:<digest>]`, the digest being the SHA-256 of the body. Only a block whose digest checks out
 * is a block: text that merely looks like one is left as it is.
 */

/** The longest block the channel carries (the owner's largest cap is 6,000 characters). */
export const ANCHOR_CHANNEL_MAX = 8000;
const BLOCK = /\[NN-ANCHOR v1 sha256:([0-9a-f]{64})\]\n([\s\S]*?)\n\[\/NN-ANCHOR sha256:\1\]/g;
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The blocks in a text that check out, in order. */
export function findAnchors(text: string): { readonly text: string; readonly digest: string; readonly at: number }[] {
  const out: { text: string; digest: string; at: number }[] = [];
  for (const m of text.matchAll(BLOCK)) if (sha(m[2]!) === m[1]) out.push({ text: m[0], digest: m[1]!, at: m.index ?? 0 });
  return out;
}

/** The text with every block that checks out taken away (and the blank lines it leaves folded). */
export function stripAnchors(text: string): string {
  return text.replace(BLOCK, (whole, digest: string, body: string) => (sha(body) === digest ? "" : whole)).replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "");
}

/** The block's digest when the text is exactly one block that checks out, else `undefined`. */
export function verifyAnchor(text: string): string | undefined {
  const found = findAnchors(text);
  return found.length === 1 && found[0]!.text === text ? found[0]!.digest : undefined;
}

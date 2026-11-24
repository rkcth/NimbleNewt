import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ANCHOR_MAX_CHARS, ANCHOR_WINDOW_SHARE, anchorBudget, composeAnchor, findAnchors, stripAnchors, verifyAnchor } from "@nimblenewt/controller";
import { findAnchors as workerFind, stripAnchors as workerStrip, verifyAnchor as workerVerify } from "@nimblenewt/contracts";
import { compactionThresholds } from "@nimblenewt/pi-adapter";

// Card W12: two packages find and replace the block (the controller writes it; the worker process must find it in a conversation it summarises and put the current one at the top, and the controller does not depend on the contracts
// package), so the restated code is checked against the original on blocks that check out and on text that only looks like one. And the room the block may take is checked against the compaction thresholds the worker hands Pi (card CMP).

const one = composeAnchor({ taskId: "tsk-aaaaaaaaaaaaaaaaaaaa", projectId: "prj-bbbbbbbbbbbbbbbbbbbb", attemptId: "att-cccccccccccccccccccc", title: "Water the plants", acceptanceCriteria: ["every pot is wet"] }, 2400)!;
const two = composeAnchor({ taskId: "tsk-aaaaaaaaaaaaaaaaaaaa", projectId: "prj-bbbbbbbbbbbbbbbbbbbb", attemptId: "att-cccccccccccccccccccc", title: "Feed the cat" }, 2400)!;
const z = "a".repeat(64);
const corpus = [
  "", "plain text", one.text, `${one.text}\n`, `x${one.text}`, `${one.text}${two.text}`, `first\n\n${one.text}\n\nmiddle\n\n${two.text}\n\nlast`,
  `[NN-ANCHOR v1 sha256:${z}]\nGoal: "x"\n[/NN-ANCHOR sha256:${z}]`, `[NN-ANCHOR v1 sha256:${one.digest}]\nanything\n[/NN-ANCHOR sha256:${two.digest}]`,
  `[NN-ANCHOR v1 sha256:${one.digest}]\nkeep me`, one.text.replace("Water", "Burn"), one.text.replaceAll("\n", "\r\n"), `${one.text}\n\n\n\n\n${two.text}\n\n\n\ntail`,
  `[NN-ANCHOR v2 sha256:${one.digest}]${one.text.slice(one.text.indexOf("\n"))}`, `nested ${one.text.replace("Goal", two.text)}`, "\n\n\n  \n" + one.text + "\n\n\n",
];

test("the controller's and the worker's readers agree on blocks that check out, copies, forgeries, edits and fragments", () => {
  for (const text of corpus) {
    assert.deepEqual(workerFind(text), findAnchors(text), JSON.stringify(text.slice(0, 80)));
    assert.equal(workerStrip(text), stripAnchors(text), JSON.stringify(text.slice(0, 80)));
    assert.equal(workerVerify(text), verifyAnchor(text)?.digest, JSON.stringify(text.slice(0, 80)));
  }
  assert.equal(findAnchors(corpus[6]!).length, 2);
});

test("the room the block may take stays under the reply reserve of the compaction thresholds on every window the worker accepts, at the owner's largest cap", () => {
  for (const window of [8192, 9000, 12_288, 16_384, 24_576, 32_768, 49_152, 65_536, 100_000, 131_072, 200_000, 1_000_000]) {
    for (const maxTokens of [undefined, 256, 1024, 8192, 100_000]) {
      const { reserveTokens, backgroundTokens } = compactionThresholds(window, maxTokens);
      const chars = anchorBudget(window, ANCHOR_MAX_CHARS);
      assert.ok(chars !== undefined, `${window} has room for a block`);
      const tokens = Math.ceil(chars / 3);
      assert.ok(tokens <= window * ANCHOR_WINDOW_SHARE + 1, `${window}: ${tokens} tokens is ${(tokens / window).toFixed(3)} of the window`);
      assert.ok(tokens < reserveTokens, `${window}/${String(maxTokens)}: the anchor (${tokens} tokens) is under the reserve (${reserveTokens})`);
      assert.ok(tokens < backgroundTokens, `${window}: and under the background band (${backgroundTokens})`);
    }
  }
});

// W12 second review: both readers now scan in linear time instead of with one pattern that looked to the end of the text for every begin line. The pattern, kept here as the reference, must give the very same blocks and the same
// stripped text on fragments mixed at random: begin and end lines of the same and of other digests, blocks that check out, empty bodies, missing line breaks and carriage returns.
const REFERENCE = /\[NN-ANCHOR v1 sha256:([0-9a-f]{64})\]\n([\s\S]*?)\n\[\/NN-ANCHOR sha256:\1\]/g;
const sha = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");
const refFind = (text: string): { text: string; digest: string; at: number }[] => [...text.matchAll(REFERENCE)].filter((m) => sha(m[2]!) === m[1]).map((m) => ({ text: m[0], digest: m[1]!, at: m.index }));
const refStrip = (text: string): string => text.replace(REFERENCE, (whole, d: string, body: string) => (sha(body) === d ? "" : whole)).replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "");

test("both readers find and strip exactly what the reference pattern does, on random mixes of block parts (W12 second review)", () => {
  const empty = sha("");
  const parts = [
    one.text, two.text, `[NN-ANCHOR v1 sha256:${one.digest}]\n`, `\n[/NN-ANCHOR sha256:${one.digest}]`, `[NN-ANCHOR v1 sha256:${two.digest}]\n`, `\n[/NN-ANCHOR sha256:${two.digest}]`,
    `[NN-ANCHOR v1 sha256:${empty}]\n`, `\n[/NN-ANCHOR sha256:${empty}]`, `[NN-ANCHOR v1 sha256:${empty}]\n\n[/NN-ANCHOR sha256:${empty}]`, `[NN-ANCHOR v1 sha256:${empty}]\n[/NN-ANCHOR sha256:${empty}]`,
    `[NN-ANCHOR v1 sha256:${z}]`, `[/NN-ANCHOR sha256:${z}]`, "\n", "\r\n", "  ", "text", one.text.slice(0, 40), one.text.slice(-40), one.text.slice(one.text.indexOf("\n") + 1, one.text.lastIndexOf("\n")),
  ];
  let seed = 12345;
  const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 3000; round++) {
    const text = Array.from({ length: 1 + rand(9) }, () => parts[rand(parts.length)]!).join("");
    const expected = refFind(text);
    assert.deepEqual(findAnchors(text), expected, JSON.stringify(text));
    assert.deepEqual(workerFind(text), expected, JSON.stringify(text));
    assert.equal(stripAnchors(text), refStrip(text), JSON.stringify(text));
    assert.equal(workerStrip(text), refStrip(text), JSON.stringify(text));
  }
  for (const text of corpus) { assert.deepEqual(findAnchors(text), refFind(text)); assert.equal(stripAnchors(text), refStrip(text)); }
  // A text of nothing but begin lines (a tool output, say) is read in one pass: the result is checked, not the time (no clock in this test).
  const begins = `[NN-ANCHOR v1 sha256:${z}]\n`.repeat(50_000);
  assert.deepEqual(findAnchors(begins + one.text), [{ text: one.text, digest: one.digest, at: begins.length }]);
  assert.equal(workerStrip(begins + one.text), begins);
});

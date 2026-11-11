import assert from "node:assert/strict";
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { THINKING_REPORT } from "@nimblenewt/contracts";
import { THINKING_PER_TURN, pendingThinking, type StoredBlockLike } from "./thinking-report.js";

const b = (entryId: number, text: string, extra: Partial<StoredBlockLike> = {}): StoredBlockLike => ({ entryId, provider: "p", model: "m", text, opaque: false, ...extra });
const start = { entryId: -1, block: -1 };

test("U09b: only blocks after the last one reported go out, each once, with their position in the entry", () => {
  const all = [b(2, "a"), b(2, "b"), b(5, "c")];
  const first = pendingThinking(all, start);
  assert.deepEqual(first.messages.flat().map((x) => [x.entryId, x.block, x.text]), [[2, 0, "a"], [2, 1, "b"], [5, 0, "c"]]);
  assert.deepEqual(first.sent, { entryId: 5, block: 0 });
  assert.deepEqual(pendingThinking(all, first.sent).messages, [], "reported again: nothing");
  const more = pendingThinking([...all, b(5, "d"), b(9, "e")], first.sent);
  assert.deepEqual(more.messages.flat().map((x) => [x.entryId, x.block, x.text]), [[5, 1, "d"], [9, 0, "e"]]);
});

test("U09b: text is cut at the channel bound without splitting a pair, opaque blocks carry no text, a block without a model is skipped, and a turn reports at most its bound in bounded messages", () => {
  const wide = "😀".repeat(THINKING_REPORT.chars);
  const [cutOne] = pendingThinking([b(1, wide)], start).messages.flat();
  assert.ok(cutOne!.text.length <= THINKING_REPORT.chars);
  assert.doesNotMatch(cutOne!.text, /[\ud800-\udbff]$/, "no lone half of a pair at the end");
  const opaque = pendingThinking([b(1, "secret words", { opaque: true })], start).messages.flat();
  assert.equal(opaque[0]!.text, "");
  assert.deepEqual(pendingThinking([b(1, "x", { model: "" })], start).messages, []);
  const flood = pendingThinking(Array.from({ length: THINKING_PER_TURN * 3 }, (_, i) => b(i, `t${i}`)), start);
  const flat = flood.messages.flat();
  assert.equal(flat.length, THINKING_PER_TURN);
  assert.equal(flat[flat.length - 1]!.text, `t${THINKING_PER_TURN * 3 - 1}`, "the newest are kept");
  for (const m of flood.messages) assert.ok(m.length <= THINKING_REPORT.blocks);
  assert.equal(flood.sent.entryId, THINKING_PER_TURN * 3 - 1, "what was left out is not reported later either");
});

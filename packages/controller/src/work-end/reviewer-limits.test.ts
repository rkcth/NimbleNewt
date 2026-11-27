import assert from "node:assert/strict";
import { test } from "node:test";
import { REASONING_KINDS, REVIEWER_CALL_LIMITS, reviewerCallLimits } from "./reviewer-limits.js";
import { DEFAULT_REPLY_TOKENS, REPLY_CUT_MAX_TOKENS, replyCeilingFor } from "../context/fixed-part.js";

// W09 fixes, item 2: the second agent's reply limit and time limit per route.

test("a kind that is not a reasoning kind, or none, keeps the old 1,500 tokens and 60 s, with a modest ceiling for a cut reply", () => {
  for (const kind of [undefined, "openai", "generic", "strata", ""]) {
    const l = reviewerCallLimits(kind === undefined ? {} : { kind });
    assert.deepEqual([l.replyTokens, l.timeoutMs, l.ceilingTokens], [1500, 60_000, REVIEWER_CALL_LIMITS.cutCeilingTokens], String(kind));
    assert.equal(l.reasoningTokens, undefined);
  }
});

test("a reasoning kind gets a larger reply, the hard ceiling for a cut reply, and a time limit that follows the ceiling within the hard maximum", () => {
  assert.deepEqual([...REASONING_KINDS].sort(), ["llama-cpp", "radiance", "vllm"]);
  for (const kind of REASONING_KINDS) {
    const l = reviewerCallLimits({ kind });
    assert.equal(l.replyTokens, 8192, kind);
    assert.equal(l.ceilingTokens, REVIEWER_CALL_LIMITS.hardReplyTokens, kind);
    assert.equal(l.timeoutMs, REVIEWER_CALL_LIMITS.hardTimeoutMs, kind);
    assert.ok(l.replyTokens > 1500 && l.timeoutMs > 60_000);
    assert.equal(l.kind, kind);
  }
});

test("a route's declared reply limit is used and is also the ceiling (never grown past the owner's limit); its reasoning cap stays below the reply", () => {
  const l = reviewerCallLimits({ kind: "radiance", maxTokens: 16_384, reasoningTokens: 4096 });
  assert.deepEqual([l.replyTokens, l.ceilingTokens, l.reasoningTokens], [16_384, 16_384, 4096]);
  assert.equal(l.timeoutMs, Math.min(REVIEWER_CALL_LIMITS.hardTimeoutMs, 16_384 * REVIEWER_CALL_LIMITS.msPerToken));
  // A cap at or above the reply is lowered below it.
  assert.equal(reviewerCallLimits({ kind: "vllm", maxTokens: 2000, reasoningTokens: 5000 }).reasoningTokens, 1999);
  // A small declared limit keeps the old 60 s floor; a non-reasoning kind's time follows its reply.
  assert.deepEqual([reviewerCallLimits({ kind: "openai", maxTokens: 800 }).timeoutMs, reviewerCallLimits({ kind: "openai", maxTokens: 800 }).ceilingTokens], [60_000, 800]);
  assert.equal(reviewerCallLimits({ kind: "openai", maxTokens: 4000 }).timeoutMs, 160_000);
});

test("every figure is bounded by the hard maximum, and figures that are not whole numbers above 0 are ignored", () => {
  const huge = reviewerCallLimits({ kind: "radiance", maxTokens: 1_000_000, reasoningTokens: 900_000 });
  assert.deepEqual([huge.replyTokens, huge.ceilingTokens, huge.timeoutMs], [REVIEWER_CALL_LIMITS.hardReplyTokens, REVIEWER_CALL_LIMITS.hardReplyTokens, REVIEWER_CALL_LIMITS.hardTimeoutMs]);
  assert.ok(huge.reasoningTokens! < huge.replyTokens);
  for (const bad of [0, -5, 1.5, Number.NaN, "100" as unknown as number]) {
    const l = reviewerCallLimits({ kind: "radiance", maxTokens: bad, reasoningTokens: bad });
    assert.deepEqual([l.replyTokens, l.reasoningTokens], [8192, undefined], String(bad));
  }
});

test("the worker's reply ceiling: the owner's declared limit when the route has one, otherwise an eighth of the window, between the default and the maximum", () => {
  assert.equal(replyCeilingFor({ contextTokens: 200_000, maxTokens: 16_384 }), 16_384);
  assert.equal(replyCeilingFor({ contextTokens: 200_000, maxTokens: 2000 }), 2000, "never grown past the owner's limit, even below the default");
  assert.equal(replyCeilingFor({ contextTokens: 200_000 }), 25_000);
  assert.equal(replyCeilingFor({ contextTokens: 1_000_000 }), REPLY_CUT_MAX_TOKENS);
  assert.equal(replyCeilingFor({ contextTokens: 16_384 }), DEFAULT_REPLY_TOKENS);
  assert.equal(replyCeilingFor({ contextTokens: 65_536 }), 8192);
  assert.equal(replyCeilingFor({ contextTokens: Number.NaN }), DEFAULT_REPLY_TOKENS);
});

// First review of the W09 fixes: the defaults fit the route's window with the largest request (a reviewer route may be as small as 12,000 tokens).
test("the default reply limit and ceiling fit the route's window with the largest prompt, never below the old 1,500; a declared limit is the owner's", () => {
  const L = REVIEWER_CALL_LIMITS;
  const room = (w: number) => w - L.promptTokens - L.windowMarginTokens;
  // A large window changes nothing.
  assert.deepEqual([reviewerCallLimits({ kind: "radiance", contextTokens: 200_000 }).replyTokens, reviewerCallLimits({ kind: "radiance", contextTokens: 200_000 }).ceilingTokens], [8192, 32_768]);
  // The launcher's default window (36,864): the retry is lowered to what fits.
  const d = reviewerCallLimits({ kind: "vllm", contextTokens: 36_864 });
  assert.deepEqual([d.replyTokens, d.ceilingTokens], [8192, room(36_864)]);
  assert.ok(d.ceilingTokens + L.promptTokens <= 36_864);
  assert.equal(d.timeoutMs, Math.min(L.hardTimeoutMs, room(36_864) * L.msPerToken));
  // The smallest reviewer window: reply and ceiling are what fits (no retry); below the old default, the old default.
  const s = reviewerCallLimits({ kind: "radiance", contextTokens: 12_000 });
  assert.deepEqual([s.replyTokens, s.ceilingTokens], [room(12_000), room(12_000)]);
  assert.deepEqual([reviewerCallLimits({ kind: "radiance", contextTokens: 9000 }).replyTokens, reviewerCallLimits({ kind: "radiance", contextTokens: 9000 }).ceilingTokens], [1500, 1500]);
  // A non-reasoning kind: 1,500 stays, its ceiling fits.
  assert.deepEqual([reviewerCallLimits({ kind: "openai", contextTokens: 12_000 }).replyTokens, reviewerCallLimits({ kind: "openai", contextTokens: 12_000 }).ceilingTokens], [1500, room(12_000)]);
  // The owner's declared limit is used as declared.
  assert.equal(reviewerCallLimits({ kind: "radiance", maxTokens: 16_384, contextTokens: 12_000 }).replyTokens, 16_384);
  // A window that is not a whole number above 0 is ignored.
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.equal(reviewerCallLimits({ kind: "radiance", contextTokens: bad }).ceilingTokens, 32_768, String(bad));
});

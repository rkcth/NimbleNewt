import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_BACKGROUND_TOKENS, DEFAULT_RESERVE_TOKENS, MIN_WORKABLE_WINDOW, PI_CONTEXT_SAFETY_TOKENS, WindowTooSmallError, assertWorkableWindow, compactionThresholds } from "./compaction-thresholds.js";

const WINDOWS = [8192, 16_384, 32_768, 49_152, 131_072, 1_000_000];

test("the background threshold is above zero and below the blocking threshold on every workable window (card CMP)", () => {
  for (const w of WINDOWS) {
    const t = compactionThresholds(w);
    const blocking = w - t.reserveTokens, background = blocking - t.backgroundTokens;
    assert.ok(t.reserveTokens >= 1024 && t.backgroundTokens >= 1024, `${w}: floors`);
    assert.ok(background > 0, `${w}: background threshold ${background} is above zero`);
    assert.ok(background < blocking, `${w}: background below blocking`);
    // Pi's own defaults are never exceeded.
    assert.ok(t.reserveTokens <= DEFAULT_RESERVE_TOKENS && t.backgroundTokens <= DEFAULT_BACKGROUND_TOKENS, `${w}: not above the defaults`);
  }
});

test("a normal first turn does not reach the background threshold on a small window (card CMP)", () => {
  // The fixed part of a first call is about 3,400 tokens (system rules and tool schemas), a first turn a few hundred more.
  for (const w of [16_384, 32_768, 49_152]) {
    const t = compactionThresholds(w);
    assert.ok(w - t.reserveTokens - t.backgroundTokens > 4000 + 0.1 * w, `${w}: a first turn stays under the background threshold`);
  }
  // The old figures, for the record: zero or below under 49,152.
  assert.ok(32_768 - DEFAULT_RESERVE_TOKENS - DEFAULT_BACKGROUND_TOKENS <= 0);
});

test("exact figures: scaled for small windows, Pi's defaults for large ones (card CMP)", () => {
  // No reply limit given: the reply is taken as the whole eighth, so the reserve is Pi's margin plus an eighth (capped at Pi's 16,384).
  assert.deepEqual(compactionThresholds(8192), { reserveTokens: 5120, backgroundTokens: 2048 });
  assert.deepEqual(compactionThresholds(16_384), { reserveTokens: 6144, backgroundTokens: 4096 });
  assert.deepEqual(compactionThresholds(32_768), { reserveTokens: 8192, backgroundTokens: 8192 });
  assert.deepEqual(compactionThresholds(49_152), { reserveTokens: 10_240, backgroundTokens: 12_288 });
  assert.deepEqual(compactionThresholds(131_072), { reserveTokens: 16_384, backgroundTokens: 32_768 });
  assert.deepEqual(compactionThresholds(200_000), { reserveTokens: 16_384, backgroundTokens: 32_768 });
  assert.deepEqual(compactionThresholds(1_000_000), { reserveTokens: 16_384, backgroundTokens: 32_768 });
  // With the model's reply limit: Pi's margin plus that limit, never under the eighth.
  assert.deepEqual(compactionThresholds(32_768, 1024), { reserveTokens: 5120, backgroundTokens: 8192 });
  assert.deepEqual(compactionThresholds(65_536, 1024), { reserveTokens: 8192, backgroundTokens: 16_384 });
  assert.deepEqual(compactionThresholds(65_536, 16_384), { reserveTokens: 12_288, backgroundTokens: 16_384 });
  assert.deepEqual(compactionThresholds(200_000, 64_000), { reserveTokens: 16_384, backgroundTokens: 32_768 });
  // A limit that is no limit (0, fractional, NaN) counts as the whole eighth.
  for (const m of [0, -1, 1.5, Number.NaN]) assert.deepEqual(compactionThresholds(32_768, m), compactionThresholds(32_768));
});

test("just under the blocking threshold Pi still grants the model's reply limit, by Pi's own reply clamp (card CMP review)", async () => {
  // pi-ai sizes each reply as min(maxTokens, window - estimate - CONTEXT_SAFETY_TOKENS). Its module is not exported, so it is loaded by its file next to the package's entry.
  const url = new URL("./api/simple-options.js", import.meta.resolve("@earendil-works/pi-ai"));
  assert.match(readFileSync(fileURLToPath(url), "utf8"), new RegExp(`const CONTEXT_SAFETY_TOKENS = ${PI_CONTEXT_SAFETY_TOKENS};`), "the margin is Pi's");
  const { clampMaxTokensToContext } = (await import(url.href)) as { clampMaxTokensToContext: (model: { contextWindow: number }, context: { messages: unknown[] }, maxTokens: number) => number };
  for (const w of [8192, 16_384, 32_768, 49_152, 65_536, 131_072, 200_000]) {
    for (const maxTokens of [1024, 4096, 16_384, 32_000]) {
      const t = compactionThresholds(w, maxTokens);
      // A request estimated one token under the blocking threshold (3.5 characters to a token in pi-ai's estimate): no compaction is started for it, so it is sent as it is.
      const input = w - t.reserveTokens - 1;
      const context = { messages: [{ role: "user", content: "x".repeat(Math.floor(input * 3.5)), timestamp: 0 }] };
      const granted = clampMaxTokensToContext({ contextWindow: w }, context, maxTokens);
      const wanted = Math.min(maxTokens, Math.floor(w / 8), DEFAULT_RESERVE_TOKENS - PI_CONTEXT_SAFETY_TOKENS);
      assert.ok(granted >= wanted, `${w} tokens, reply limit ${maxTokens}: Pi grants ${granted}, at least ${wanted} wanted`);
    }
  }
});

test("a window under 8,192 tokens, or not a whole number, is refused with a clear reason (card CMP)", () => {
  for (const w of [8191, 4096, 1024, 1]) {
    assert.throws(() => compactionThresholds(w), WindowTooSmallError);
    assert.throws(() => assertWorkableWindow(w), /at least 8192 tokens/);
  }
  for (const w of [0, -5, 8192.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => compactionThresholds(w), RangeError);
  assert.doesNotThrow(() => assertWorkableWindow(MIN_WORKABLE_WINDOW));
});

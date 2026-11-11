import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BACKGROUND_TOKENS, DEFAULT_RESERVE_TOKENS, MIN_WORKABLE_WINDOW, WindowTooSmallError, assertWorkableWindow, compactionThresholds } from "./compaction-thresholds.js";

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
  assert.deepEqual(compactionThresholds(8192), { reserveTokens: 1024, backgroundTokens: 2048 });
  assert.deepEqual(compactionThresholds(16_384), { reserveTokens: 2048, backgroundTokens: 4096 });
  assert.deepEqual(compactionThresholds(32_768), { reserveTokens: 4096, backgroundTokens: 8192 });
  assert.deepEqual(compactionThresholds(49_152), { reserveTokens: 6144, backgroundTokens: 12_288 });
  assert.deepEqual(compactionThresholds(131_072), { reserveTokens: 16_384, backgroundTokens: 32_768 });
  assert.deepEqual(compactionThresholds(200_000), { reserveTokens: 16_384, backgroundTokens: 32_768 });
  assert.deepEqual(compactionThresholds(1_000_000), { reserveTokens: 16_384, backgroundTokens: 32_768 });
});

test("a window under 8,192 tokens, or not a whole number, is refused with a clear reason (card CMP)", () => {
  for (const w of [8191, 4096, 1024, 1]) {
    assert.throws(() => compactionThresholds(w), WindowTooSmallError);
    assert.throws(() => assertWorkableWindow(w), /at least 8192 tokens/);
  }
  for (const w of [0, -5, 8192.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => compactionThresholds(w), RangeError);
  assert.doesNotThrow(() => assertWorkableWindow(MIN_WORKABLE_WINDOW));
});

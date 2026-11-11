/**
 * Pi Durable's compaction thresholds for a model window (card CMP). Pi's own defaults (`reserveTokens` 16,384, `backgroundTokens` 32,768) put the background threshold at
 * `window - reserve - background`, which is zero or below for every window under 49,152 tokens: such a route would start a background compaction (a summary call) before nearly every request.
 * The two figures therefore scale with the window and are the defaults only where the window is large. This is the one place that computes them; the worker hands the result to Pi.
 */

/** Pi's own defaults, kept for large windows. */
export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_BACKGROUND_TOKENS = 32_768;
/** The reserve (room kept free for the answer) is at most this share of the window, and the background band at most this share. */
export const RESERVE_SHARE = 1 / 8;
export const BACKGROUND_SHARE = 1 / 4;
/** Below this many tokens a model cannot hold the fixed system text, the tool schemas and a working turn: refused, not squeezed. */
export const MIN_WORKABLE_WINDOW = 8192;
/** Floors, so a small window never gets a zero or tiny figure. */
const MIN_RESERVE_TOKENS = 1024;
const MIN_BACKGROUND_TOKENS = 1024;

export interface CompactionThresholds { readonly reserveTokens: number; readonly backgroundTokens: number }

export class WindowTooSmallError extends RangeError {
  constructor(readonly window: number) {
    super(`the model's context window (${String(window)} tokens) is too small to work in: at least ${MIN_WORKABLE_WINDOW} tokens are needed (the fixed instructions and tool descriptions alone take several thousand); use a model with a larger window or correct the route's contextTokens`);
    this.name = "WindowTooSmallError";
  }
}

/** The window is a whole number of tokens of at least `MIN_WORKABLE_WINDOW`, else `WindowTooSmallError` (or a RangeError for a non-integer). */
export function assertWorkableWindow(window: number): void {
  if (!Number.isSafeInteger(window) || window < 1) throw new RangeError(`the model's context window must be a whole number of tokens (got ${String(window)})`);
  if (window < MIN_WORKABLE_WINDOW) throw new WindowTooSmallError(window);
}

/**
 * `reserve = min(16,384, window/8)` and `background = min(32,768, window/4)`, each floored at 1,024. At 131,072 tokens and above these are Pi's defaults. The background threshold is then
 * `window * 5/8` for a small window (62.5%), never zero or negative, and the blocking threshold is `window * 7/8`.
 */
export function compactionThresholds(window: number): CompactionThresholds {
  assertWorkableWindow(window);
  return {
    reserveTokens: Math.max(MIN_RESERVE_TOKENS, Math.min(DEFAULT_RESERVE_TOKENS, Math.floor(window * RESERVE_SHARE))),
    backgroundTokens: Math.max(MIN_BACKGROUND_TOKENS, Math.min(DEFAULT_BACKGROUND_TOKENS, Math.floor(window * BACKGROUND_SHARE))),
  };
}

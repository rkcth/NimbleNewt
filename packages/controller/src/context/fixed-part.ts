import { anchorBudget } from "./anchor.js";
import { BUDGET_DEFAULTS } from "./budget.js";

/**
 * The fixed part of the real worker's first call (card "Fixed-part sizing after T08"): the shared system text (`sharedSystemText(PI_AGENT_LAYOUT)` in pi-adapter) and the schemas of every bridge tool
 * (`composeTools` in pi-adapter, measured as `toolSchemaCharsOf`), which every task's first call carries before a word of the task itself. The controller does not depend on pi-adapter, so the figures
 * are written here and the integration test `fixed-part-budget.test.ts` measures the real ones: it fails when they drift from `WORKER_FIXED_PART` by more than 5% (so the words the owner reads stay
 * true) and when they grow past `WORKER_FIXED_PART_BUDGET` (so the next tool or rule that is added is a deliberate step that raises the budget, the floor and the smallest startable window with it).
 *
 * RAISING THE FIXED PART (a new bridge tool, a longer description, a new system rule), all in one change:
 * 1. Set `WORKER_FIXED_PART` to the measured figures the budget test prints, and `WORKER_FIXED_PART_BUDGET` a little above them (it is also the unmeasured-route floor, which `api/start-route-change.test.ts` pins).
 * 2. Update the figures the tests pin on purpose to the new `WORKER_FIXED_PART_ABOUT_TOKENS` / `MIN_STARTABLE_WINDOW` / `PRACTICAL_STARTABLE_WINDOW` (the budget test prints them): `fixed-part-budget.test.ts`
 *    (integration) and `setup/small-window.test.ts` ("about N tokens", "N or more is needed in practice").
 * 3. If the real fixed part no longer starts a task on 32,768 tokens, the windows that assume it does must be raised too: the launcher's `DEFAULT_CONTEXT_TOKENS` (a provider from the configuration
 *    document), the real-process tests w12-anchor and w13-recall (integration, 32,768) and `context/enforcement.test.ts`'s view suite; the owner is then told the larger window.
 * 4. Regenerate the API reference (`node scripts/api-docs.mjs --write`; the summaries quote these figures) and say so in the implementation notes.
 */
export const WORKER_FIXED_PART = { systemPromptChars: 2_537, toolSchemaChars: 15_024 } as const;
/** The most the real fixed part may grow to before the budget test fails: a little room over the measured figures, no more. It is also the floor counted for a route nobody has measured (`ROUTE_FLOOR_DEFAULTS`). */
export const WORKER_FIXED_PART_BUDGET = { systemPromptChars: 3_000, toolSchemaChars: 16_000 } as const;
export const WORKER_FIXED_PART_CHARS = WORKER_FIXED_PART.systemPromptChars + WORKER_FIXED_PART.toolSchemaChars;
/** The measured fixed part in tokens at the budgets' estimate (three characters to a token), and the figure the owner is told, rounded to hundreds ("about 5,900 tokens"). */
export const WORKER_FIXED_PART_TOKENS = Math.ceil(WORKER_FIXED_PART_CHARS / BUDGET_DEFAULTS.charsPerToken);
export const WORKER_FIXED_PART_ABOUT_TOKENS = Math.round(WORKER_FIXED_PART_TOKENS / 100) * 100;
/** The smallest task the first call can carry besides the fixed part and the anchor: the task's own words, the rules note and the view's frame. An estimate (about 1,000 tokens). */
export const MIN_TASK_CHARS = 3_000;
/** Windows are tried in steps of this many tokens when the smallest one that can start a task is worked out. */
const WINDOW_STEP = 1_024;

/** Whether the startup share (a quarter) of a window holds the fixed part, the goal anchor at its default size for that window, and the smallest task. */
export function windowCanStartTask(window: number, fixedChars: number = WORKER_FIXED_PART_CHARS): boolean {
  if (!Number.isSafeInteger(window) || window < 1) return false;
  const cpt = BUDGET_DEFAULTS.charsPerToken;
  const need = Math.ceil(fixedChars / cpt) + Math.ceil((anchorBudget(window) ?? 0) / cpt) + Math.ceil(MIN_TASK_CHARS / cpt);
  return Math.floor(window * BUDGET_DEFAULTS.startupShare) >= need;
}

/** The smallest window (a multiple of 1,024 tokens) whose first call holds the fixed part, the anchor and the smallest task; at the measured figures 30,720 tokens, so 32,768 in practice. */
export function startableWindow(fixedChars: number = WORKER_FIXED_PART_CHARS): number {
  for (let w = WINDOW_STEP; w <= 100_000_000; w += WINDOW_STEP) if (windowCanStartTask(w, fixedChars)) return w;
  return 100_000_000;
}
export const MIN_STARTABLE_WINDOW = startableWindow();
/** Windows the owner is told about are rounded up to a multiple of this many tokens (32,768, 36,864, 40,960, ...): a round figure, but never far above what is needed. */
const PRACTICAL_STEP = 4_096;
/**
 * The window the owner is told is needed in practice for a smallest startable window `min`: `min` rounded up to a multiple of 4,096 tokens. Not the next power of two: a fixed part a little over the 32,768 line
 * (35,840 tokens with card P03b's four tools) would then be told "65,536 or more" although 36,864 works.
 */
export function practicalWindow(min: number): number { return Math.ceil(min / PRACTICAL_STEP) * PRACTICAL_STEP; }
/** What the owner is told is needed in practice: `MIN_STARTABLE_WINDOW` rounded up to a multiple of 4,096 tokens (32,768 at the measured figures). */
export const PRACTICAL_STARTABLE_WINDOW = practicalWindow(MIN_STARTABLE_WINDOW);

/** A whole number with thousands separated by commas (no locale data needed). */
export const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The plain words the owner reads about the fixed part and the smallest workable window, from the figures above (setup's guide, the interpreter's prompt, the warning of `routing.provider.add`). */
export const FIXED_PART_WORDS = `the team's fixed instructions and tools take about ${grouped(WORKER_FIXED_PART_ABOUT_TOKENS)} tokens and a task's first call must fit in a quarter of the window, so ${grouped(PRACTICAL_STARTABLE_WINDOW)} or more is needed in practice`;

/**
 * What `routing.provider.add` tells the owner about a route whose window is accepted (at least `MIN_WORKABLE_CONTEXT_TOKENS`) but too small to start any task; undefined when the window can start one. Judged on the
 * window itself, not on `MIN_STARTABLE_WINDOW` (a multiple of 1,024): a window a few tokens under that figure may still start a task, and is then not told that none can.
 */
export function smallWindowWarning(window: number): string | undefined {
  if (!Number.isSafeInteger(window) || window >= MIN_STARTABLE_WINDOW || windowCanStartTask(window)) return undefined;
  return `a context window of ${grouped(window)} tokens is accepted, but no task can start on it: ${FIXED_PART_WORDS}; with the goal anchor and the smallest task the first call needs a window of at least ${grouped(MIN_STARTABLE_WINDOW)} tokens. Give the model's real context window, or add a model with a larger one`;
}

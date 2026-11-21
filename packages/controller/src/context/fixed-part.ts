import { anchorBudget } from "./anchor.js";
import { BUDGET_DEFAULTS, contextBudget } from "./budget.js";
import { admitFirstCall, type FirstCall } from "./dispatch.js";

/**
 * The fixed part of the real worker's first call (card "Fixed-part sizing after T08"): the shared system text (`sharedSystemText(PI_AGENT_LAYOUT)` in pi-adapter) and the schemas of every bridge tool
 * (`composeTools` in pi-adapter, measured as `toolSchemaCharsOf`), which every task's first call carries before a word of the task itself. The controller does not depend on pi-adapter, so the figures
 * are written here and the integration test `fixed-part-budget.test.ts` measures the real ones: it fails when they drift from `WORKER_FIXED_PART` by more than 5% (so the words the owner reads stay
 * true) and when they grow past `WORKER_FIXED_PART_BUDGET` (so the next tool or rule that is added is a deliberate step that raises the budget, the floor and the smallest startable window with it).
 *
 * RAISING THE FIXED PART (a new bridge tool, a longer description, a new system rule), all in one change:
 * 1. Set `WORKER_FIXED_PART` to the measured figures the budget test prints, and `WORKER_FIXED_PART_BUDGET` a little above them (it is also the unmeasured-route floor, which `api/start-route-change.test.ts` pins;
 *    the floor itself must still start a task on `PRACTICAL_STARTABLE_WINDOW`, which the budget test checks).
 * 2. Update the figures the tests pin on purpose to the new `WORKER_FIXED_PART_ABOUT_TOKENS` / `MIN_STARTABLE_WINDOW` / `PRACTICAL_STARTABLE_WINDOW` (the budget test prints them): `fixed-part-budget.test.ts`
 *    (integration) and `setup/small-window.test.ts` ("about N tokens", "N or more is needed in practice").
 *    The C07g real-process test (`integration/c07g-route-view.test.ts`, `FLOOR_CHARS`) sets a floor that must stay above the real fixed part: raise it with the budget.
 *    The real-process tests whose windows come from `integration/src/window-support.ts` (`windowHolding`: the fixed part at this budget beside each test's own measured first call) follow the budget by
 *    themselves: `w03-rig-support.ts` (W03, W04, W05, W10, G09's retained context, L04e, L04g and the other tests on that rig), h12k-composed-host, w11-job-wake, c07g-route-view, c09h-local-artifact, h12e-composed-accounting, l05b-model-stream and t07b-jobs (card "Prompt growth tests").
 * 3. If the real fixed part no longer starts a task on the window these assume (36,864 tokens since card P03b's first slice, 32,768 before), they must be raised to the new `PRACTICAL_STARTABLE_WINDOW` (or more):
 *    the launcher's `DEFAULT_CONTEXT_TOKENS` (a provider from the configuration document) and the launcher note `u14-launcher.test.ts` pins ("context window assumed 36864 tokens ... under about 36,864"),
 *    the placeholder the interpreter prompt names (`chat/model-interpreter.ts`, "36864 is only the launcher's placeholder"), and the integration tests that run the real worker process on that window: w12-anchor and w13-recall (`WINDOW`), g09-remote-updates
 *    (`WINDOW`) and h12bf-composed (`window`); then the budget test's list of those windows and the windows
 *    `setup/small-window.test.ts` expects to start a task. h12bf's compaction case (98,304 tokens, a stored conversation sized against the fixed part; its comment explains the sizing) must be sized again by hand. Check that
 *    `context/enforcement.test.ts`'s view suite (40,960) still cuts. The owner is then told the larger window.
 *    The scripts' hosts (`scripts/local-host.mjs`, `scripts/remote-host.mjs`) take their fallback window and reply room from `DEFAULT_CONTEXT_TOKENS` and `DEFAULT_REPLY_TOKENS`, so they follow.
 * 4. Regenerate the API reference (`node scripts/api-docs.mjs --write`; the summaries quote these figures) and say so in the implementation notes.
 * Done once, at the merge of card P03b's first slice (2,537 + 17,714 characters, about 6,800 tokens, 34,816 startable, 36,864 in practice): budget 3,000 + 18,750 (about 1,000 characters of room, as before;
 *    3,000 + 19,500 would put the floor at 37,888 startable, over the window told), C07g floor 22,750, the windows above at 36,864, h12bf's compaction case from 65,536 to 98,304.
 * Done again at card T08's fourth slice (2,537 + 19,087 characters, about 7,200 tokens, 36,864 startable and in practice; T08's third slice had already brought the tools to 18,887): the toolbox proposal operations are one
 *    bridge tool with an action, and the toolbox descriptions were shortened, so the window told stays 36,864. Budget 2,800 + 19,400 (22,200: the most the floor may be is 22,248, the largest fixed part that starts a task on
 *    36,864); C07g floor 22,750 stays above it; h12bf's compaction case keeps about 1,600 tokens to spare at 98,304. The next tool or rule over the budget raises the window told to 40,960 (step 3).
 * Card Q01b's bridge slice added `submission.record` (577 characters) within the budget by shortening other descriptions: 2,537 + 19,210 characters, still about 7,200 tokens (21,747, 7,249 tokens, is the most that rounds to it: no room is left at that figure).
 */
export const WORKER_FIXED_PART = { systemPromptChars: 2_537, toolSchemaChars: 19_210 } as const;
/** The most the real fixed part may grow to before the budget test fails: a little room over the measured figures, no more. It is also the floor counted for a route nobody has measured (`ROUTE_FLOOR_DEFAULTS`). */
export const WORKER_FIXED_PART_BUDGET = { systemPromptChars: 2_800, toolSchemaChars: 19_400 } as const;
export const WORKER_FIXED_PART_CHARS = WORKER_FIXED_PART.systemPromptChars + WORKER_FIXED_PART.toolSchemaChars;
/** The measured fixed part in tokens at the budgets' estimate (three characters to a token), and the figure the owner is told, rounded to hundreds ("about N tokens"; the budget test pins it). */
export const WORKER_FIXED_PART_TOKENS = Math.ceil(WORKER_FIXED_PART_CHARS / BUDGET_DEFAULTS.charsPerToken);
export const WORKER_FIXED_PART_ABOUT_TOKENS = Math.round(WORKER_FIXED_PART_TOKENS / 100) * 100;
/** The smallest task the first call can carry besides the fixed part and the anchor: the task's own words, the rules note and the view's frame. An estimate (about 1,000 tokens). */
export const MIN_TASK_CHARS = 3_000;
/** Windows are tried in steps of this many tokens when the smallest one that can start a task is worked out. */
const WINDOW_STEP = 1_024;

/**
 * The room the hosts keep for a model's reply when the route has no reply limit of its own (`maxTokens`, set with `routing.budget.set`): the launcher's local and remote hosts give the worker this
 * figure as the model's `maxTokens`, and its first call reserves it (`replyReserveTokens`). A route with a reply limit reserves that limit instead.
 */
export const DEFAULT_REPLY_TOKENS = 4_096;
/** The window figures are worked out for: from the smallest `contextBudget` accepts up to the largest. */
const WINDOW_RANGE = { min: 1_024, max: 100_000_000 } as const;

/**
 * The first call of the smallest task on a window, as the dispatcher admits it (card C07b): the fixed part, and as the call's own content the goal anchor at its default size for that window plus
 * the smallest task; the route's reply limit is the reply reserve, and the likely tool output is admission's own default (one result at the per-tool limit), as for the real worker's first call.
 */
export function smallestFirstCall(window: number, fixedChars: number = WORKER_FIXED_PART_CHARS, replyTokens: number = DEFAULT_REPLY_TOKENS): FirstCall {
  const cpt = BUDGET_DEFAULTS.charsPerToken;
  return { systemPromptChars: fixedChars, toolSchemaChars: 0, startupTokens: Math.ceil((anchorBudget(window) ?? 0) / cpt) + Math.ceil(MIN_TASK_CHARS / cpt), replyReserveTokens: replyTokens };
}

/**
 * Whether the smallest task can start on a window: the first-call admission itself (`admitFirstCall`, both its limits) admits `smallestFirstCall`. So the startup share (a quarter) must hold the fixed
 * part, the anchor and the smallest task, and the working share (60%) that call plus the likely tool output plus the route's reply limit: a route with a large reply limit needs a larger window.
 */
export function windowCanStartTask(window: number, fixedChars: number = WORKER_FIXED_PART_CHARS, replyTokens: number = DEFAULT_REPLY_TOKENS): boolean {
  if (!Number.isSafeInteger(window) || window < WINDOW_RANGE.min || window > WINDOW_RANGE.max) return false;
  return admitFirstCall(smallestFirstCall(window, fixedChars, replyTokens), contextBudget(window)).admit;
}

/** The smallest window (a multiple of 1,024 tokens) on which `windowCanStartTask` holds for that fixed part and reply limit (`MIN_STARTABLE_WINDOW` at the measured figures and the default reply room). */
export function startableWindow(fixedChars: number = WORKER_FIXED_PART_CHARS, replyTokens: number = DEFAULT_REPLY_TOKENS): number {
  for (let w = WINDOW_STEP; w <= WINDOW_RANGE.max; w += WINDOW_STEP) if (windowCanStartTask(w, fixedChars, replyTokens)) return w;
  return WINDOW_RANGE.max;
}
export const MIN_STARTABLE_WINDOW = startableWindow();
/** Windows the owner is told about are rounded up to a multiple of this many tokens (32,768, 36,864, 40,960, ...): a round figure, but never far above what is needed. */
const PRACTICAL_STEP = 4_096;
/**
 * The window the owner is told is needed in practice for a smallest startable window `min`: `min` rounded up to a multiple of 4,096 tokens. Not the next power of two: a fixed part a little over a power of
 * two would then be told twice the window it needs (`setup/small-window.test.ts` checks the rounding and its examples).
 */
export function practicalWindow(min: number): number { return Math.ceil(min / PRACTICAL_STEP) * PRACTICAL_STEP; }
/** What the owner is told is needed in practice: `MIN_STARTABLE_WINDOW` rounded up to a multiple of 4,096 tokens (the budget test pins it). */
export const PRACTICAL_STARTABLE_WINDOW = practicalWindow(MIN_STARTABLE_WINDOW);

/** A whole number with thousands separated by commas (no locale data needed). */
export const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The plain words the owner reads about the fixed part and the smallest workable window, from the figures above (setup's guide, the interpreter's prompt, the warning of `routing.provider.add`). */
export const FIXED_PART_WORDS = `the team's fixed instructions and tools take about ${grouped(WORKER_FIXED_PART_ABOUT_TOKENS)} tokens and a task's first call must fit in a quarter of the window, so ${grouped(PRACTICAL_STARTABLE_WINDOW)} or more is needed in practice`;

/**
 * The window a route needs for the smallest task to start (`startableWindow` with the route's reply limit) when its own window cannot start one; undefined when it can. Judged on the window itself, not on
 * `MIN_STARTABLE_WINDOW` (a multiple of 1,024): a window a few tokens under that figure may still start a task.
 */
export function windowNeeded(window: number, replyTokens: number = DEFAULT_REPLY_TOKENS): number | undefined {
  if (!Number.isSafeInteger(window) || windowCanStartTask(window, WORKER_FIXED_PART_CHARS, replyTokens)) return undefined;
  return startableWindow(WORKER_FIXED_PART_CHARS, replyTokens);
}
const percent = (share: number): string => `${Math.round(share * 100)}%`;

/**
 * What the owner is told about a route whose window cannot start any task (undefined when it can), with the route's reply limit (`replyTokens`, the hosts' `DEFAULT_REPLY_TOKENS` when the route has none):
 * by `routing.provider.add` after it and in its proposal, and in the proposal of a `routing.budget.set` that would leave the route unable to start a task. The window is accepted all the same (at least
 * `MIN_WORKABLE_CONTEXT_TOKENS`). When the reply limit is what decides it, the words name the limit and the window it needs; otherwise the fixed part and `MIN_STARTABLE_WINDOW`.
 */
export function smallWindowWarning(window: number, replyTokens: number = DEFAULT_REPLY_TOKENS): string | undefined {
  const need = windowNeeded(window, replyTokens);
  if (need === undefined) return undefined;
  if (need <= MIN_STARTABLE_WINDOW) return `a context window of ${grouped(window)} tokens is accepted, but no task can start on it: ${FIXED_PART_WORDS}; with the goal anchor and the smallest task the first call needs a window of at least ${grouped(MIN_STARTABLE_WINDOW)} tokens. Give the model's real context window, or add a model with a larger one`;
  return `no task can start on a context window of ${grouped(window)} tokens with a reply limit of ${grouped(replyTokens)} tokens: a task's first call must fit in ${percent(BUDGET_DEFAULTS.startupShare)} of the window, and that call with the likely tool output and room for the whole reply in ${percent(BUDGET_DEFAULTS.workingShare)}, so with this reply limit at least ${grouped(need)} tokens are needed (${grouped(MIN_STARTABLE_WINDOW)} with the usual reply room of ${grouped(DEFAULT_REPLY_TOKENS)}). Lower the route's reply limit, give the model's real context window, or use a model with a larger one`;
}

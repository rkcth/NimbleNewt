import { BUDGET_DEFAULTS, WORKER_FIXED_PART_BUDGET, contextBudget } from "@nimblenewt/controller";

/**
 * The window of a test that runs the real worker process (card "Prompt growth tests"): the smallest multiple of 1,024 tokens whose startup share (a quarter) holds the worker's fixed part at its budget
 * (`WORKER_FIXED_PART_BUDGET`, the most the real system text and bridge tool schemas may grow to before `fixed-part-budget.test.ts` fails) beside `ownTokens`, the rest of the test's own first call (its task, the
 * goal anchor, the owner's context, a continuation record), as measured for that test with a margin. A tool or rule added within the budget therefore no longer leaves a test with a hand-written window a few
 * tokens short (T08's third and fourth slices did that to six tests); one over the budget fails the budget test first, and raising the budget raises these windows with it.
 */
export function windowHolding(ownTokens: number): number {
  const fixed = Math.ceil((WORKER_FIXED_PART_BUDGET.systemPromptChars + WORKER_FIXED_PART_BUDGET.toolSchemaChars) / BUDGET_DEFAULTS.charsPerToken);
  for (let w = 1_024; ; w += 1_024) if (contextBudget(w).startupTokens >= fixed + ownTokens) return w;
}

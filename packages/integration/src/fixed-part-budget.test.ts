import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_ROUTE_FLOOR_CHARS, MIN_STARTABLE_WINDOW, MIN_WORKABLE_CONTEXT_TOKENS, PRACTICAL_STARTABLE_WINDOW, ROUTE_FLOOR_DEFAULTS, WORKER_FIXED_PART, WORKER_FIXED_PART_ABOUT_TOKENS, WORKER_FIXED_PART_BUDGET, WORKER_FIXED_PART_TOKENS, practicalWindow, smallWindowWarning, startableWindow, windowCanStartTask } from "@nimblenewt/controller";
import { MIN_WORKABLE_WINDOW, PI_AGENT_LAYOUT, composeTools, createBridge, sharedSystemText, toolSchemaCharsOf } from "@nimblenewt/pi-adapter";

// Card "Fixed-part sizing after T08": the real worker's fixed part (its system text and the schemas of every bridge tool), measured as the worker measures it at start (process.ts reports
// `systemPromptChars: sharedSystemText(PI_AGENT_LAYOUT).length` and `toolSchemaChars: toolSchemaCharsOf(composeTools(bridge, [], namespace))`; the agent's namespace does not change a bridge tool's name).
const real = (): { systemPromptChars: number; toolSchemaChars: number } => {
  const bridge = createBridge({ send: async () => ({ ok: true, result: {} }) as never });
  return { systemPromptChars: sharedSystemText(PI_AGENT_LAYOUT).length, toolSchemaChars: toolSchemaCharsOf(composeTools(bridge, [], "abcdefghijklmnopqrst")) };
};

// What a failure tells the author who raised the fixed part: the measured figures, what they come to, and where the steps are written.
const RAISE = "see RAISING THE FIXED PART in packages/controller/src/context/fixed-part.ts";
const derived = (r: { systemPromptChars: number; toolSchemaChars: number }): string => {
  const chars = r.systemPromptChars + r.toolSchemaChars, tokens = Math.ceil(chars / 3), min = startableWindow(chars);
  return `measured: system text ${r.systemPromptChars}, bridge tool schemas ${r.toolSchemaChars} characters (${chars}, about ${Math.round(tokens / 100) * 100} tokens); smallest startable window ${min}, ${practicalWindow(min)} in practice, 32,768 ${windowCanStartTask(32_768, chars) ? "still starts" : "NO LONGER starts"} a task; ${RAISE}`;
};

test("the real worker's fixed part stays within its budget, so a new tool or rule is a deliberate step", () => {
  const r = real();
  assert.ok(r.systemPromptChars <= WORKER_FIXED_PART_BUDGET.systemPromptChars, `the system text is over its budget of ${WORKER_FIXED_PART_BUDGET.systemPromptChars} (WORKER_FIXED_PART_BUDGET); ${derived(r)}`);
  assert.ok(r.toolSchemaChars <= WORKER_FIXED_PART_BUDGET.toolSchemaChars, `the bridge tool schemas are over their budget of ${WORKER_FIXED_PART_BUDGET.toolSchemaChars} (WORKER_FIXED_PART_BUDGET); ${derived(r)}`);
});

test("the figures the owner is told match the measured fixed part (within 5%)", () => {
  const r = real();
  const near = (recorded: number, measured: number, what: string): void => assert.ok(Math.abs(recorded - measured) <= measured * 0.05, `${what}: WORKER_FIXED_PART records ${recorded}, more than 5% from the real figure; ${derived(r)}`);
  near(WORKER_FIXED_PART.systemPromptChars, r.systemPromptChars, "system text");
  near(WORKER_FIXED_PART.toolSchemaChars, r.toolSchemaChars, "bridge tool schemas");
  assert.equal(WORKER_FIXED_PART_ABOUT_TOKENS, Math.round(WORKER_FIXED_PART_TOKENS / 100) * 100);
  assert.equal(WORKER_FIXED_PART_ABOUT_TOKENS, 5_900, `the words say about 5,900 tokens, pinned here on purpose; ${RAISE}`);
});

test("a route nobody has measured counts at least the real fixed part", () => {
  const r = real();
  assert.deepEqual(ROUTE_FLOOR_DEFAULTS, WORKER_FIXED_PART_BUDGET);
  assert.ok(ROUTE_FLOOR_DEFAULTS.systemPromptChars >= r.systemPromptChars);
  assert.ok(ROUTE_FLOOR_DEFAULTS.toolSchemaChars >= r.toolSchemaChars, `the floor's tools (${ROUTE_FLOOR_DEFAULTS.toolSchemaChars}) are below the real bridge tools (${r.toolSchemaChars})`);
  assert.ok(DEFAULT_ROUTE_FLOOR_CHARS >= r.systemPromptChars + r.toolSchemaChars);
});

test("the smallest window that can start a task, and the warning for an accepted window under it", () => {
  const r = real();
  // The window the owner is told is needed in practice holds the real fixed part beside the anchor and the smallest task; the recorded figure gives the startable window, the step below it cannot start one.
  assert.ok(startableWindow(r.systemPromptChars + r.toolSchemaChars) <= PRACTICAL_STARTABLE_WINDOW, `the real fixed part starts a task on the window the owner is told; ${derived(r)}`);
  assert.ok(windowCanStartTask(MIN_STARTABLE_WINDOW) && !windowCanStartTask(MIN_STARTABLE_WINDOW - 1024));
  assert.equal(PRACTICAL_STARTABLE_WINDOW, 32_768, `pinned here on purpose; ${RAISE}`);
  assert.equal(MIN_STARTABLE_WINDOW, 30_720, `the warning names it ("at least 30,720 tokens"), pinned here on purpose; ${RAISE}`);
  // The window the tests that run the real process use (w12, w13 since the CI fix) and the one the launcher assumes for a provider of the configuration document can start a task on the REAL fixed part;
  // 24,576, which the tests used before, cannot.
  for (const [w, who] of [[32_768, "the real-process tests w12-anchor and w13-recall"], [DEFAULT_CONTEXT_TOKENS, "the launcher's DEFAULT_CONTEXT_TOKENS"]] as const) {
    assert.equal(windowCanStartTask(w, r.systemPromptChars + r.toolSchemaChars), true, `${who} assume ${w} tokens start a task; ${derived(r)}`);
  }
  assert.equal(windowCanStartTask(24_576), false);
  // The accepted minimum is still the worker's; everything from there up to the startable window carries a warning naming both figures.
  assert.equal(MIN_WORKABLE_CONTEXT_TOKENS, MIN_WORKABLE_WINDOW);
  assert.ok(MIN_STARTABLE_WINDOW > MIN_WORKABLE_CONTEXT_TOKENS);
  const w = smallWindowWarning(16_384);
  assert.ok(w !== undefined && w.includes("16,384 tokens") && w.includes("about 5,900 tokens") && w.includes(`at least ${MIN_STARTABLE_WINDOW.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} tokens`), w);
  assert.equal(smallWindowWarning(MIN_STARTABLE_WINDOW), undefined);
  assert.equal(smallWindowWarning(65_536), undefined);
});

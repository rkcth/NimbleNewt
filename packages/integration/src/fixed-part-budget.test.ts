import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ROUTE_FLOOR_CHARS, MIN_STARTABLE_WINDOW, MIN_WORKABLE_CONTEXT_TOKENS, PRACTICAL_STARTABLE_WINDOW, ROUTE_FLOOR_DEFAULTS, WORKER_FIXED_PART, WORKER_FIXED_PART_ABOUT_TOKENS, WORKER_FIXED_PART_BUDGET, WORKER_FIXED_PART_TOKENS, smallWindowWarning, startableWindow, windowCanStartTask } from "@nimblenewt/controller";
import { MIN_WORKABLE_WINDOW, PI_AGENT_LAYOUT, composeTools, createBridge, sharedSystemText, toolSchemaCharsOf } from "@nimblenewt/pi-adapter";

// Card "Fixed-part sizing after T08": the real worker's fixed part (its system text and the schemas of every bridge tool), measured as the worker measures it at start (process.ts reports
// `systemPromptChars: sharedSystemText(PI_AGENT_LAYOUT).length` and `toolSchemaChars: toolSchemaCharsOf(composeTools(bridge, [], namespace))`; the agent's namespace does not change a bridge tool's name).
const real = (): { systemPromptChars: number; toolSchemaChars: number } => {
  const bridge = createBridge({ send: async () => ({ ok: true, result: {} }) as never });
  return { systemPromptChars: sharedSystemText(PI_AGENT_LAYOUT).length, toolSchemaChars: toolSchemaCharsOf(composeTools(bridge, [], "abcdefghijklmnopqrst")) };
};

test("the real worker's fixed part stays within its budget, so a new tool or rule is a deliberate step", () => {
  const r = real();
  // Over budget: raise WORKER_FIXED_PART_BUDGET (and with it the unmeasured-route floor) and WORKER_FIXED_PART in packages/controller/src/context/fixed-part.ts, check that the smallest startable window the owner is
  // told about still holds, and say so in the implementation notes.
  assert.ok(r.systemPromptChars <= WORKER_FIXED_PART_BUDGET.systemPromptChars, `the system text is ${r.systemPromptChars} characters, over its budget of ${WORKER_FIXED_PART_BUDGET.systemPromptChars}`);
  assert.ok(r.toolSchemaChars <= WORKER_FIXED_PART_BUDGET.toolSchemaChars, `the bridge tool schemas are ${r.toolSchemaChars} characters, over their budget of ${WORKER_FIXED_PART_BUDGET.toolSchemaChars}`);
});

test("the figures the owner is told match the measured fixed part (within 5%)", () => {
  const r = real();
  const near = (recorded: number, measured: number, what: string): void => assert.ok(Math.abs(recorded - measured) <= measured * 0.05, `${what}: recorded ${recorded}, measured ${measured}; update WORKER_FIXED_PART`);
  near(WORKER_FIXED_PART.systemPromptChars, r.systemPromptChars, "system text");
  near(WORKER_FIXED_PART.toolSchemaChars, r.toolSchemaChars, "bridge tool schemas");
  assert.equal(WORKER_FIXED_PART_ABOUT_TOKENS, Math.round(WORKER_FIXED_PART_TOKENS / 100) * 100);
  assert.equal(WORKER_FIXED_PART_ABOUT_TOKENS, 5_900, "the words say about 5,900 tokens");
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
  assert.ok(startableWindow(r.systemPromptChars + r.toolSchemaChars) <= PRACTICAL_STARTABLE_WINDOW, "the real fixed part starts a task on the window the owner is told");
  assert.ok(windowCanStartTask(MIN_STARTABLE_WINDOW) && !windowCanStartTask(MIN_STARTABLE_WINDOW - 1024));
  assert.equal(PRACTICAL_STARTABLE_WINDOW, 32_768);
  // The window the tests that run the real process use (c07g, w12, w13 since the CI fix) can start a task; 24,576, which they used before, cannot.
  assert.equal(windowCanStartTask(32_768), true);
  assert.equal(windowCanStartTask(24_576), false);
  // The accepted minimum is still the worker's; everything from there up to the startable window carries a warning naming both figures.
  assert.equal(MIN_WORKABLE_CONTEXT_TOKENS, MIN_WORKABLE_WINDOW);
  assert.ok(MIN_STARTABLE_WINDOW > MIN_WORKABLE_CONTEXT_TOKENS);
  const w = smallWindowWarning(16_384);
  assert.ok(w !== undefined && w.includes("16,384 tokens") && w.includes("about 5,900 tokens") && w.includes(`at least ${MIN_STARTABLE_WINDOW.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} tokens`), w);
  assert.equal(smallWindowWarning(MIN_STARTABLE_WINDOW), undefined);
  assert.equal(smallWindowWarning(65_536), undefined);
});

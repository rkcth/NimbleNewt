import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_REPLY_TOKENS, DEFAULT_CONTEXT_TOKENS, contextBudget, DEFAULT_ROUTE_FLOOR_CHARS, MIN_STARTABLE_WINDOW, MIN_WORKABLE_CONTEXT_TOKENS, PRACTICAL_STARTABLE_WINDOW, ROUTE_FLOOR_DEFAULTS, WORKER_FIXED_PART, WORKER_FIXED_PART_ABOUT_TOKENS, WORKER_FIXED_PART_BUDGET, WORKER_FIXED_PART_TOKENS, practicalWindow, smallWindowWarning, startableWindow, windowCanStartTask } from "@nimblenewt/controller";
import { MIN_WORKABLE_WINDOW, PI_AGENT_LAYOUT, composeTools, createBridge, sharedSystemText, toolSchemaCharsOf } from "@nimblenewt/pi-adapter";
import { windowHolding } from "./window-support.js";

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
  return `measured: system text ${r.systemPromptChars}, bridge tool schemas ${r.toolSchemaChars} characters (${chars}, about ${Math.round(tokens / 100) * 100} tokens); smallest startable window ${min}, ${practicalWindow(min)} in practice, ${PRACTICAL_STARTABLE_WINDOW} (the window the tests and the launcher assume) ${windowCanStartTask(PRACTICAL_STARTABLE_WINDOW, chars) ? "still starts" : "NO LONGER starts"} a task; ${RAISE}`;
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
  assert.equal(WORKER_FIXED_PART_ABOUT_TOKENS, 7_400, `the words say about 7,400 tokens, pinned here on purpose; ${RAISE}`);
});

test("a route nobody has measured counts at least the real fixed part", () => {
  const r = real();
  assert.deepEqual(ROUTE_FLOOR_DEFAULTS, WORKER_FIXED_PART_BUDGET);
  assert.ok(ROUTE_FLOOR_DEFAULTS.systemPromptChars >= r.systemPromptChars);
  assert.ok(ROUTE_FLOOR_DEFAULTS.toolSchemaChars >= r.toolSchemaChars, `the floor's tools (${ROUTE_FLOOR_DEFAULTS.toolSchemaChars}) are below the real bridge tools (${r.toolSchemaChars})`);
  assert.ok(DEFAULT_ROUTE_FLOOR_CHARS >= r.systemPromptChars + r.toolSchemaChars);
  // The room over the real part is small enough that a route counted at the floor still starts a task on the window the owner is told.
  assert.equal(windowCanStartTask(PRACTICAL_STARTABLE_WINDOW, DEFAULT_ROUTE_FLOOR_CHARS), true, `the floor (${DEFAULT_ROUTE_FLOOR_CHARS}) needs a window of ${startableWindow(DEFAULT_ROUTE_FLOOR_CHARS)}; ${RAISE}`);
});

test("the smallest window that can start a task, and the warning for an accepted window under it", () => {
  const r = real();
  // The window the owner is told is needed in practice holds the real fixed part beside the anchor and the smallest task; the recorded figure gives the startable window, the step below it cannot start one.
  assert.ok(startableWindow(r.systemPromptChars + r.toolSchemaChars) <= PRACTICAL_STARTABLE_WINDOW, `the real fixed part starts a task on the window the owner is told; ${derived(r)}`);
  assert.ok(windowCanStartTask(MIN_STARTABLE_WINDOW) && !windowCanStartTask(MIN_STARTABLE_WINDOW - 1024));
  assert.equal(PRACTICAL_STARTABLE_WINDOW, 36_864, `pinned here on purpose; ${RAISE}`);
  assert.equal(MIN_STARTABLE_WINDOW, 36_864, `the warning names it ("at least 36,864 tokens"), pinned here on purpose; ${RAISE}`);
  // The window the tests that run the real process use (36,864 since card P03b's first slice; 32,768 before it, 24,576 before the CI fix) and the one the launcher assumes for a provider of the configuration document
  // can start a task on the REAL fixed part; 24,576 cannot.
  for (const [w, who] of [[36_864, "the real-process tests w12-anchor, w13-recall, g09-remote-updates, h12bf-composed"], [DEFAULT_CONTEXT_TOKENS, "the launcher's DEFAULT_CONTEXT_TOKENS"]] as const) {
    assert.equal(windowCanStartTask(w, r.systemPromptChars + r.toolSchemaChars), true, `${who} assume ${w} tokens start a task; ${derived(r)}`);
  }
  // The real-process tests whose windows come from window-support.ts (the W03 rig, h12k-composed-host, w11-job-wake, c07g-route-view, c09h-local-artifact, h12e-composed-accounting, l05b-model-stream, t07b-jobs) hold the real fixed part beside their own measured first call: the
  // window is worked out on the budget, which the real part is under (the first test here), so it holds the real part too.
  for (const own of [1_500, 1_700, 2_600, 3_300]) assert.ok(contextBudget(windowHolding(own)).startupTokens >= Math.ceil((r.systemPromptChars + r.toolSchemaChars) / 3) + own, `windowHolding(${own}); ${derived(r)}`);
  assert.equal(windowCanStartTask(24_576), false);
  // The accepted minimum is still the worker's; everything from there up to the startable window carries a warning naming both figures.
  assert.equal(MIN_WORKABLE_CONTEXT_TOKENS, MIN_WORKABLE_WINDOW);
  assert.ok(MIN_STARTABLE_WINDOW > MIN_WORKABLE_CONTEXT_TOKENS);
  const w = smallWindowWarning(16_384);
  assert.ok(w !== undefined && w.includes("16,384 tokens") && w.includes("about 7,400 tokens") && w.includes(`at least ${MIN_STARTABLE_WINDOW.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} tokens`), w);
  assert.equal(smallWindowWarning(MIN_STARTABLE_WINDOW), undefined);
  assert.equal(smallWindowWarning(65_536), undefined);
});

// Follow-up of the card's reviews: the hosts the scripts start (the launcher's local host and the remote host) give the worker the controller's figures for a route without its own window or reply limit, not
// literals of their own that a raise of the fixed part would leave behind (they said 32,768 tokens, which no longer starts a task, and 4,096).
test("the scripts' hosts take the fallback window and the reply room from the controller, and that window starts a task with that room", () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  // The remote host gives both figures inline. The local host (since the W09 fixes, f5427f9b) names them first and gives those two names as the window and the reply limit, with the reply ceiling worked out from
  // them by the controller (never below the reply limit; the owner's own reply limit, when the route has one, is the ceiling).
  const remote = readFileSync(join(repository, "scripts", "remote-host.mjs"), "utf8");
  assert.match(remote, /contextWindow: entry\?\.contextTokens \?\? controller\.DEFAULT_CONTEXT_TOKENS, maxTokens: entry\?\.maxTokens \?\? controller\.DEFAULT_REPLY_TOKENS,/, "remote-host.mjs");
  const local = readFileSync(join(repository, "scripts", "local-host.mjs"), "utf8");
  assert.match(local, /const contextWindow = entry\?\.contextTokens \?\? controller\.DEFAULT_CONTEXT_TOKENS;\r?\n\s*const maxTokens = entry\?\.maxTokens \?\? controller\.DEFAULT_REPLY_TOKENS;\r?\n/, "local-host.mjs: the window and the reply limit");
  assert.match(local, /modelId: route\.slice\(slash \+ 1\), contextWindow, maxTokens, replyCeiling: Math\.max\(maxTokens, controller\.replyCeilingFor\(\{ contextTokens: contextWindow, \.\.\.\(entry\?\.maxTokens === undefined \? \{\} : \{ maxTokens: entry\.maxTokens \}\) \}\)\),/, "local-host.mjs: the model entry");
  assert.equal(local.match(/\b(contextWindow|maxTokens) =(?!=)/g)?.length, 2, "local-host.mjs: the window and the reply limit are set once each, nowhere else");
  for (const [file, source] of [["local-host.mjs", local], ["remote-host.mjs", remote]] as const) assert.doesNotMatch(source, /FALLBACK_WINDOW|32_768|\?\? 4096/, `${file} keeps a literal window or reply room; ${RAISE}`);
  const r = real();
  assert.equal(windowCanStartTask(DEFAULT_CONTEXT_TOKENS, r.systemPromptChars + r.toolSchemaChars, DEFAULT_REPLY_TOKENS), true, derived(r));
});

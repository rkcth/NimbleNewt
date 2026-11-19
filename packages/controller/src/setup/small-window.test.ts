import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startController } from "../api/index.js";
import { replyOf } from "../chat/chat.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { cid, openWorld } from "../chat/testing/harness.js";
import { DEFAULT_ROUTE_FLOOR_CHARS, ROUTE_FLOOR_DEFAULTS } from "../context/route-settings.js";
import { anchorBudget } from "../context/anchor.js";
import { contextBudget } from "../context/budget.js";
import { admitFirstCall } from "../context/dispatch.js";
import { MIN_STARTABLE_WINDOW, PRACTICAL_STARTABLE_WINDOW, WORKER_FIXED_PART, WORKER_FIXED_PART_CHARS, practicalWindow, smallWindowWarning, startableWindow, windowCanStartTask } from "../context/fixed-part.js";
import { SETUP_GUIDE } from "./readiness.js";
import { MIN_WORKABLE_CONTEXT_TOKENS, SetupProviderService } from "./providers.js";

after(stopServer);

// Card "Fixed-part sizing after T08": a window from the worker's accepted minimum up to the smallest one that can start a task is still accepted, and routing.provider.add says, with the figures, that no task can start on it.
type R = { ok: boolean; result?: { routes?: string[]; warnings?: string[]; shown?: string[]; replayed?: boolean }; error?: { code: string; message: string } };
const provider = (name: string, port: number, contextTokens: number) => ({ name, location: "local", endpoint: `http://127.0.0.1:${port}/v1`, models: ["m"], contextTokens });

test("routing.provider.add accepts a window too small to start a task, warns with the window that is needed, and repeats the warning on a replay", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-fixedpart-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }) } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const add = (providers: unknown[], commandId: string) => c.api.handle(boot.token, { v: 1, op: "routing.provider.add", commandId, args: { providers } } as never) as Promise<R>;
    const small = await add([provider("tiny", 8002, 16_384), provider("big", 8003, 65_536)], "p1");
    assert.equal(small.ok, true, JSON.stringify(small));
    assert.deepEqual(small.result!.routes, ["tiny/m", "big/m"], "the providers are added all the same");
    assert.equal(small.result!.warnings!.length, 1, "only the small window is warned about");
    const w = small.result!.warnings![0]!;
    assert.ok(w.startsWith("Provider tiny: a context window of 16,384 tokens is accepted, but no task can start on it"), w);
    assert.ok(w.includes("about 6,800 tokens") && w.includes(`at least ${MIN_STARTABLE_WINDOW.toLocaleString("en-US")} tokens`), w);
    assert.deepEqual(small.result!.shown, small.result!.warnings, "the chat shows the warning");
    // The chat's reply of an applied command shows the lines.
    assert.ok(replyOf([{ i: 0, status: "applied", op: "routing.provider.add", shown: small.result!.shown } as never]).includes(w));
    const again = await add([provider("tiny", 8002, 16_384), provider("big", 8003, 65_536)], "p1");
    assert.equal(again.result!.replayed, true);
    assert.deepEqual(again.result!.warnings, small.result!.warnings, "a replay says the same");
    // Large enough: no warning, no field.
    const fine = await add([provider("tiny", 8002, MIN_STARTABLE_WINDOW), provider("big", 8003, 65_536)], "p2");
    assert.equal(fine.ok, true, JSON.stringify(fine));
    assert.equal(fine.result!.warnings, undefined);
    assert.equal(fine.result!.shown, undefined);
    // Under the worker's minimum: refused as before.
    const refused = await add([provider("tiny", 8002, MIN_WORKABLE_CONTEXT_TOKENS - 1), provider("big", 8003, 65_536)], "p3");
    assert.equal(refused.ok, false);
    assert.match(refused.error!.message, /too small for the team to work in/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the figures: the floor covers the measured fixed part, every accepted window under the startable one warns, the guide's words come from the constants", () => {
  assert.ok(DEFAULT_ROUTE_FLOOR_CHARS >= WORKER_FIXED_PART_CHARS, "an unmeasured route counts at least the real fixed part");
  assert.equal(DEFAULT_ROUTE_FLOOR_CHARS, ROUTE_FLOOR_DEFAULTS.systemPromptChars + ROUTE_FLOOR_DEFAULTS.toolSchemaChars);
  // Every window from the accepted minimum up: warned exactly when it cannot start a task (a window a few tokens under the 1,024-multiple MIN_STARTABLE_WINDOW may start one, and is not warned).
  for (let w = MIN_WORKABLE_CONTEXT_TOKENS; w <= MIN_STARTABLE_WINDOW + 1_024; w++) assert.equal(smallWindowWarning(w) === undefined, windowCanStartTask(w), String(w));
  for (let w = MIN_WORKABLE_CONTEXT_TOKENS; w < MIN_STARTABLE_WINDOW; w += 1_024) assert.equal(windowCanStartTask(w), false, String(w));
  const exact = Array.from({ length: 1_024 }, (_, i) => MIN_STARTABLE_WINDOW - 1_023 + i).find((w) => windowCanStartTask(w))!;
  assert.ok(exact > MIN_STARTABLE_WINDOW - 1_024 && smallWindowWarning(exact) === undefined && smallWindowWarning(exact - 1) !== undefined, String(exact));
  for (const w of [MIN_STARTABLE_WINDOW, 36_864, 40_960, 131_072]) { assert.equal(windowCanStartTask(w), true, String(w)); assert.equal(smallWindowWarning(w), undefined, String(w)); }
  const q = SETUP_GUIDE["model-route"].question;
  assert.ok(q.includes("about 6,800 tokens") && q.includes("36,864 or more is needed in practice") && !q.includes("4,200"), q);
});

test("in the chat, the owner gives a window too small to start a task: the proposal is shown first, and once applied the reply carries the warning with the window that is needed", async () => {
  const script: Record<string, unknown> = {};
  const w = await openWorld(backends[0]!, script, undefined, (storage, epoch) => ({ setupProviders: SetupProviderService.withEpoch(storage, epoch, { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined }, {}) }));
  try {
    const chat = w.chat();
    const say = async (text: string, plan: unknown[]) => { script[text] = plan; return chat.submit(w.ownerToken, { messageId: cid("m"), text }); };
    const text = "Register my local server called tiny at http://127.0.0.1:8002/v1 with the model m (16384 tokens), and another local one called big at http://127.0.0.1:8003/v1 with the model m (65536 tokens).";
    const proposed = await say(text, [{ kind: "command", op: "routing.provider.add", args: { providers: [provider("tiny", 8002, 16_384), provider("big", 8003, 65_536)] }, evidence: text, basis: "owner" }]);
    assert.equal(proposed.outcomes[0]!.status, "proposed", JSON.stringify(proposed.outcomes));
    const done = await say("Yes, do that.", [{ kind: "apply_proposal", proposalId: (proposed.outcomes[0] as { proposalId: string }).proposalId, evidence: "Yes, do that.", basis: "owner" }]);
    assert.equal(done.outcomes[0]!.status, "applied", JSON.stringify(done.outcomes));
    const line = done.reply.find((l) => l.startsWith("Provider tiny: a context window of 16,384 tokens is accepted, but no task can start on it"));
    assert.ok(line !== undefined && line.includes(`at least ${MIN_STARTABLE_WINDOW.toLocaleString("en-US")} tokens`), done.reply.join("\n"));
    assert.ok(!done.reply.some((l) => l.startsWith("Provider big:")), "the large window is not warned about");
  } finally { await w.close(); }
});

test("the smallest startable window is what the first-call admission itself decides: the fixed part, the anchor at its default size and the smallest task pass its startup limit exactly from that window", () => {
  // The same first call the dispatcher admits (card C07b): the measured fixed part, and as the call's own content the goal anchor at its default size for the window plus the smallest task.
  const startupRefused = (w: number): boolean => {
    const call = { ...WORKER_FIXED_PART, startupTokens: Math.ceil((anchorBudget(w) ?? 0) / 3) + Math.ceil(3_000 / 3), replyReserveTokens: 0 };
    return admitFirstCall(call, contextBudget(w)).reasons.some((r) => r.includes("over the startup limit"));
  };
  for (let w = MIN_WORKABLE_CONTEXT_TOKENS; w <= 2 * MIN_STARTABLE_WINDOW; w += 256) assert.equal(windowCanStartTask(w), !startupRefused(w), String(w));
  assert.equal(startupRefused(MIN_STARTABLE_WINDOW), false);
  assert.equal(startupRefused(MIN_STARTABLE_WINDOW - 1_024), true);
});

test("the window the owner is told is needed in practice is the startable one rounded up to a multiple of 4,096, not the next power of two", () => {
  assert.equal(PRACTICAL_STARTABLE_WINDOW, practicalWindow(MIN_STARTABLE_WINDOW));
  for (const [min, told] of [[30_720, 32_768], [32_768, 32_768], [33_792, 36_864], [35_840, 36_864], [36_864, 36_864], [37_888, 40_960]] as const) assert.equal(practicalWindow(min), told, String(min));
  // A fixed part a little over the 32,768 line (card P03b's first slice: 2,537 + 18,242 characters): the startable window is 35,840, and the owner is told 36,864, which starts a task, not 65,536.
  const p03b = 2_537 + 18_242;
  assert.equal(windowCanStartTask(32_768, p03b), false);
  assert.equal(startableWindow(p03b), 35_840);
  assert.equal(practicalWindow(startableWindow(p03b)), 36_864);
  assert.equal(windowCanStartTask(36_864, p03b), true);
  // Whatever the fixed part, the figure told is a window that starts a task and is less than 4,096 tokens above the smallest one.
  for (let chars = 1_000; chars <= 60_000; chars += 777) {
    const min = startableWindow(chars), told = practicalWindow(min);
    assert.ok(windowCanStartTask(told, chars) && told >= min && told - min < 4_096 && told % 4_096 === 0, `${chars}: ${min} -> ${told}`);
  }
});

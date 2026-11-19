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
import { DEFAULT_REPLY_TOKENS, MIN_STARTABLE_WINDOW, PRACTICAL_STARTABLE_WINDOW, WORKER_FIXED_PART, WORKER_FIXED_PART_CHARS, grouped, practicalWindow, smallWindowWarning, startableWindow, windowCanStartTask, windowNeeded } from "../context/fixed-part.js";
import { SETUP_GUIDE } from "./readiness.js";
import { MIN_WORKABLE_CONTEXT_TOKENS, SetupProviderService } from "./providers.js";
import { SetupReadinessService } from "./readiness.js";
import { ModelInterpreter } from "../chat/model-interpreter.js";
import { DEFAULT_CONTEXT_TOKENS } from "../launcher/launcher.js";
import { RoutingService } from "../routing/service.js";

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
    // Follow-up: the warning is in the proposal itself, before the owner says yes, and only for the small window.
    const before = proposed.reply.find((l) => l.includes("Provider tiny: a context window of 16,384 tokens is accepted, but no task can start on it"));
    assert.ok(before !== undefined && before.includes(`at least ${grouped(MIN_STARTABLE_WINDOW)} tokens`), proposed.reply.join("\n"));
    assert.ok(!proposed.reply.some((l) => l.includes("Provider big:")), "the large window is not warned about in the proposal");
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

// The chat world with the provider, route budget and setup readiness services (the same storage).
const routed = (storage: Parameters<typeof SetupProviderService.withEpoch>[0], epoch: number) => {
  const options = { clock: () => "2026-11-19T10:00:00.000Z", pause: async () => undefined };
  return { setupProviders: SetupProviderService.withEpoch(storage, epoch, options, {}), routeBudgets: RoutingService.withEpoch(storage, epoch, options, {}), setup: SetupReadinessService.withEpoch(storage, epoch) };
};

// Follow-up of the fixed-part card's reviews: the warning and the setup readiness use the first-call admission itself, its working limit too (the first call, the likely tool output and the route's reply limit
// within 60% of the window), so a route with a large reply limit is told it cannot start a task where admission would refuse it.
test("whether a window can start a task is the admission's own decision, both limits, for any reply limit", () => {
  const admitted = (w: number, reply: number): boolean => admitFirstCall({ ...WORKER_FIXED_PART, startupTokens: Math.ceil((anchorBudget(w) ?? 0) / 3) + Math.ceil(3_000 / 3), replyReserveTokens: reply }, contextBudget(w)).admit;
  for (const reply of [0, 1_000, DEFAULT_REPLY_TOKENS, 8_192, 16_384, 32_768]) {
    for (let w = MIN_WORKABLE_CONTEXT_TOKENS; w <= 3 * MIN_STARTABLE_WINDOW; w += 256) assert.equal(windowCanStartTask(w, WORKER_FIXED_PART_CHARS, reply), admitted(w, reply), `${w} with ${reply}`);
    const need = startableWindow(WORKER_FIXED_PART_CHARS, reply);
    assert.ok(admitted(need, reply) && !admitted(need - 1_024, reply), `${reply}: ${need}`);
  }
  // The usual reply room does not raise the smallest window; a reply limit of 16,384 does, past the window the owner is told in practice, and the working limit is what refuses it there.
  assert.equal(startableWindow(WORKER_FIXED_PART_CHARS, DEFAULT_REPLY_TOKENS), MIN_STARTABLE_WINDOW);
  assert.equal(startableWindow(WORKER_FIXED_PART_CHARS, 0), MIN_STARTABLE_WINDOW);
  const big = startableWindow(WORKER_FIXED_PART_CHARS, 16_384);
  assert.ok(big > PRACTICAL_STARTABLE_WINDOW, String(big));
  assert.equal(windowCanStartTask(PRACTICAL_STARTABLE_WINDOW, WORKER_FIXED_PART_CHARS, 16_384), false);
  const refused = admitFirstCall({ ...WORKER_FIXED_PART, startupTokens: Math.ceil((anchorBudget(PRACTICAL_STARTABLE_WINDOW) ?? 0) / 3) + 1_000, replyReserveTokens: 16_384 }, contextBudget(PRACTICAL_STARTABLE_WINDOW)).reasons;
  assert.ok(refused.length === 1 && refused[0]!.includes("over the working limit"), refused.join("; "));
  // The words: the reply limit and the window it needs; with the usual room the words are the add warning's.
  const w = smallWindowWarning(PRACTICAL_STARTABLE_WINDOW, 16_384)!;
  assert.ok(w.includes(`a context window of ${grouped(PRACTICAL_STARTABLE_WINDOW)} tokens with a reply limit of 16,384 tokens`) && w.includes(`at least ${grouped(big)} tokens are needed`) && w.includes("25%") && w.includes("60%") && w.includes("Lower the route's reply limit"), w);
  assert.equal(smallWindowWarning(PRACTICAL_STARTABLE_WINDOW), undefined);
  assert.equal(smallWindowWarning(big, 16_384), undefined);
  assert.equal(smallWindowWarning(16_384, 0), smallWindowWarning(16_384), "a small reply limit keeps the usual words");
  assert.equal(windowNeeded(PRACTICAL_STARTABLE_WINDOW, 16_384), big);
  assert.equal(windowNeeded(PRACTICAL_STARTABLE_WINDOW), undefined);
});

test("in the chat, a reply limit that would leave a route unable to start a task is warned about in its proposal, with the window it needs", async () => {
  const script: Record<string, unknown> = {};
  const w = await openWorld(backends[0]!, script, undefined, routed);
  try {
    const chat = w.chat();
    const say = async (text: string, plan: unknown[]) => { script[text] = plan; return chat.submit(w.ownerToken, { messageId: cid("m"), text }); };
    const add = "Register my local server called tiny at http://127.0.0.1:8002/v1 with the model m (36864 tokens), and another local one called big at http://127.0.0.1:8003/v1 with the model m (65536 tokens).";
    const proposed = await say(add, [{ kind: "command", op: "routing.provider.add", args: { providers: [provider("tiny", 8002, 36_864), provider("big", 8003, 65_536)] }, evidence: add, basis: "owner" }]);
    assert.ok(!proposed.reply.some((l) => l.includes("no task can start")), proposed.reply.join("\n"));
    const applied = await say("Yes, do that.", [{ kind: "apply_proposal", proposalId: (proposed.outcomes[0] as { proposalId: string }).proposalId, evidence: "Yes, do that.", basis: "owner" }]);
    assert.equal(applied.outcomes[0]!.status, "applied", JSON.stringify(applied.outcomes));
    const need = grouped(startableWindow(WORKER_FIXED_PART_CHARS, 16_384));
    const limit = async (text: string, maxTokens: number | null, route = "tiny/m") => say(text, [{ kind: "command", op: "routing.budget.set", args: { route, maxTokens }, evidence: text, basis: "owner" }]);
    const large = await limit("Let tiny/m replies be up to 16384 tokens.", 16_384);
    assert.equal(large.outcomes[0]!.status, "proposed", JSON.stringify(large.outcomes));
    const line = large.reply.find((l) => l.includes("; Route tiny/m: no task can start on a context window of 36,864 tokens with a reply limit of 16,384 tokens"));
    assert.ok(line !== undefined && line.includes(`at least ${need} tokens are needed`) && !line.includes("larger one.."), large.reply.join("\n"));
    // The same limit on the larger window, a small limit, and taking the limit off: no warning.
    for (const [text, max, route] of [["Let big/m replies be up to 16384 tokens.", 16_384, "big/m"], ["Let tiny/m replies be up to 2000 tokens.", 2_000, "tiny/m"], ["Take the reply limit off tiny/m.", null, "tiny/m"]] as const) {
      const r = await limit(text, max, route);
      assert.equal(r.outcomes[0]!.status, "proposed", JSON.stringify(r.outcomes));
      assert.ok(!r.reply.some((l) => l.includes("no task can start")), `${text}\n${r.reply.join("\n")}`);
    }
  } finally { await w.close(); }
});

test("setup readiness names a stored route whose window cannot start a task, with its reply limit, and is not done when no route can (4 backends)", async () => {
  for (const backend of backends) {
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script, undefined, routed);
    try {
      const call = async (op: string, args: Record<string, unknown>, commandId?: string): Promise<R & { result?: Record<string, unknown> }> => (await w.api.handle(w.ownerToken, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as never;
      const route = async (): Promise<{ state: string; detail: string }> => { const r = await call("setup.readiness", {}); assert.ok(r.ok, JSON.stringify(r)); return ((r.result!["item"] as { items: { id: string; state: string; detail: string }[] }).items.find((i) => i.id === "model-route"))!; };
      assert.ok((await call("routing.provider.add", { providers: [provider("tiny", 8002, 16_384), provider("big", 8003, 65_536)] }, "rd1")).ok);
      let r = await route();
      assert.equal(r.state, "done", backend.name);
      assert.ok(r.detail.includes(`no task can start on 1 of them: tiny/m (16,384 tokens; needs ${grouped(MIN_STARTABLE_WINDOW)})`) && !r.detail.includes("big/m"), r.detail);
      // A reply limit that leaves the large route unable to start a task too: named with its limit, and the step is no longer done.
      assert.ok((await call("routing.budget.set", { route: "big/m", maxTokens: 40_000 }, "rd2")).ok);
      r = await route();
      assert.equal(r.state, "missing", r.detail);
      assert.ok(r.detail.includes("no task can start on any of them") && r.detail.includes(`big/m (65,536 tokens with a reply limit of 40,000; needs ${grouped(startableWindow(WORKER_FIXED_PART_CHARS, 40_000))})`), r.detail);
      // Each route's window needed is worked out with its own reply limit (the other route keeps the usual room).
      assert.ok(r.detail.includes(`tiny/m (16,384 tokens; needs ${grouped(MIN_STARTABLE_WINDOW)})`), r.detail);
      // The detail stays within what the setup view shows of it.
      assert.ok(r.detail.length <= 240, String(r.detail.length));
      assert.ok((await call("routing.budget.set", { route: "big/m", maxTokens: 8_000 }, "rd3")).ok);
      r = await route();
      assert.equal(r.state, "done");
      assert.ok(!r.detail.includes("big/m"), r.detail);
    } finally { await w.close(); }
  }
});

test("the interpreter is told where the small-window warning appears, that a large reply limit raises the window a task needs, and the launcher's placeholder window", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "help me get started", quoted: [], focus: {}, proposals: [] });
  assert.ok(system.includes("accepted with a warning, shown in the proposal before the owner agrees and in the setup list"), "the warning before yes");
  assert.ok(system.includes("a large reply limit set with routing.budget.set raises the window a task needs, and its proposal says so"), "the reply limit");
  assert.ok(system.includes(`${DEFAULT_CONTEXT_TOKENS} is only the launcher's placeholder`), "the placeholder named is the launcher's own window");
});

// First review of the follow-up: route names may be long (a provider name of 64 characters, a model name of 128) and many routes may be too small; the detail still fits what the setup view shows,
// names at most three routes (fewer when they do not fit), cuts a long name, and counts the rest.
test("setup readiness keeps the too-small routes within what the setup view shows: long names cut, at most three named, the rest counted", async () => {
  const long = "m".repeat(120);
  for (const scenario of ["short", "long"] as const) {
    const w = await openWorld(backends[0]!, {}, undefined, routed);
    try {
      const call = async (op: string, args: Record<string, unknown>, commandId?: string): Promise<R & { result?: Record<string, unknown> }> => (await w.api.handle(w.ownerToken, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as never;
      const route = async (): Promise<{ state: string; detail: string }> => { const r = await call("setup.readiness", {}); assert.ok(r.ok, JSON.stringify(r)); return ((r.result!["item"] as { items: { id: string; state: string; detail: string }[] }).items.find((i) => i.id === "model-route"))!; };
      if (scenario === "short") {
        // Short names: three named, the other two counted.
        assert.ok((await call("routing.provider.add", { providers: [1, 2, 3, 4, 5].map((n) => provider(`p${n}`, 8100 + n, 16_384)) }, "ln1")).ok);
        const r = await route();
        assert.equal(r.state, "missing", r.detail);
        assert.ok(r.detail.includes("no task can start on any of them: p1/m (16,384 tokens; needs") && r.detail.includes("p3/m") && !r.detail.includes("p4/m") && r.detail.endsWith(" and 2 more"), r.detail);
        assert.ok(r.detail.length <= 240, `${r.detail.length}: ${r.detail}`);
      } else {
        // Long names with reply limits: fewer named, each cut, still within 240 characters, and the count says how many are left out.
        const name = (n: number) => `${"q".repeat(60)}${n}`;
        assert.ok((await call("routing.provider.add", { providers: [1, 2, 3, 4, 5].map((n) => ({ ...provider(name(n), 8200 + n, 65_536), models: [long] })) }, "ln2")).ok);
        for (const n of [1, 2, 3, 4, 5]) assert.ok((await call("routing.budget.set", { route: `${name(n)}/${long}`, maxTokens: 40_000 }, `ln-b${n}`)).ok);
        const r = await route();
        assert.equal(r.state, "missing", r.detail);
        assert.ok(r.detail.length <= 240, `${r.detail.length}: ${r.detail}`);
        assert.ok(r.detail.includes(`no task can start on any of them: ${name(1).slice(0, 57)}... (65,536 tokens with a reply limit of 40,000; needs ${grouped(startableWindow(WORKER_FIXED_PART_CHARS, 40_000))})`) && / and [234] more$/.test(r.detail), r.detail);
      }
    } finally { await w.close(); }
  }
});

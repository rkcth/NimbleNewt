import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contextBudget, type StartupItem } from "./budget.js";
import { SUMMARY_DEFAULTS, admitFirstCall, boundedSummarise, calibratedCharsPerToken, extractiveSummary, EXTRACTIVE_ROUTE, piOutputLimits, reviewRouteChange, type Summariser } from "./dispatch.js";

const small = contextBudget(131_072);
const never = (route: string): Summariser => ({ route, summarise: () => new Promise<string>(() => undefined) });
const says = (route: string, out: string): Summariser => ({ route, summarise: async () => out });

describe("dispatch enforcement, pure parts (C07b)", () => {
  test("the first call counts Pi's system prompt and tool schemas, and the provider's reported size wins when larger", () => {
    // 30,000 characters of system prompt + 80,000 of tool schemas = 36,667 tokens fixed: over the 32,768 startup limit before the builder adds a word.
    const call = { systemPromptChars: 30_000, toolSchemaChars: 80_000, startupTokens: 1_000, replyReserveTokens: 8_000 };
    const refused = admitFirstCall(call, small);
    assert.equal(refused.admit, false);
    assert.equal(refused.startupTokens, 37_667);
    assert.match(refused.reasons[0]!, /Pi's system prompt and tool schemas are 36667/);
    assert.equal(admitFirstCall({ ...call, toolSchemaChars: 60_000, startupTokens: 500 }, small).admit, true, "a smaller fixed part fits");
    // The estimate fits but the provider says otherwise.
    const ok = { systemPromptChars: 9_000, toolSchemaChars: 9_000, startupTokens: 2_000, replyReserveTokens: 8_000 };
    assert.equal(admitFirstCall(ok, small).admit, true);
    const reported = admitFirstCall({ ...ok, reportedInputTokens: 40_000 }, small);
    assert.deepEqual([reported.admit, reported.basis, reported.startupTokens], [false, "reported", 40_000]);
    assert.equal(admitFirstCall({ ...ok, reportedInputTokens: 100 }, small).basis, "estimated", "a lower report never lowers the estimate");
  });

  test("the working limit is separate: startup plus likely tool output plus the reply reserve at most 60%", () => {
    // Startup alone is fine (25,000 of 32,768) but with a 16,000-char result and a 60,000 reserve the sum passes 78,643.
    const d = admitFirstCall({ systemPromptChars: 0, toolSchemaChars: 0, startupTokens: 25_000, replyReserveTokens: 60_000 }, small);
    assert.equal(d.admit, false);
    assert.equal(d.reasons.length, 1);
    assert.match(d.reasons[0]!, /working limit of 78643/);
    for (const bad of [-1, 1.5]) assert.throws(() => admitFirstCall({ systemPromptChars: bad, toolSchemaChars: 0, startupTokens: 0, replyReserveTokens: 0 }, small), RangeError);
  });

  test("characters per token are calibrated from the provider's count", () => {
    assert.equal(calibratedCharsPerToken(90_000, 30_000), 3);
    assert.equal(calibratedCharsPerToken(90_000, 45_000), 2);
    assert.throws(() => calibratedCharsPerToken(0, 5), RangeError);
  });

  test("a smaller-window route rebuilds the view, or blocks with the numbers", () => {
    const at = (n: number): string => new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();
    const items: StartupItem[] = [{ id: "g", kind: "goal", text: "Goal: ship.", at: at(0) }, { id: "h", kind: "human", text: "Merge it.", at: at(1) }];
    for (let i = 0; i < 20; i++) items.push({ id: `r${i}`, kind: "report", text: "x".repeat(1500), at: at(i + 2) });
    const r = reviewRouteChange(items, contextBudget(32_768), 3_000);
    assert.equal(r.kind, "rebuilt");
    assert.ok(r.startup.tokens + 3_000 <= contextBudget(32_768).startupTokens);
    const tiny = reviewRouteChange(items, contextBudget(8_192), 2_000);
    assert.equal(tiny.kind, "blocked");
    assert.match((tiny as { reason: string }).reason, /essential constraints do not fit the 8192-token route/);
    assert.equal(tiny.startup.pieces.length, 0, "nothing is returned to send");
  });

  test("Pi's tool limits are the window's limits; bash keeps the tail", () => {
    assert.deepEqual(piOutputLimits(small), { maxBytes: small.toolOutputChars, maxLines: Math.floor(small.toolOutputChars / 20), retain: "head" });
    assert.equal(piOutputLimits(small, "tail").retain, "tail");
  });

  test("a summariser that hangs hits its own timeout; the next route is tried, then the fallback; nothing hangs", async () => {
    const text = "word ".repeat(4000);
    const t0 = Date.now();
    const a = await boundedSummarise(text, [never("local"), says("cloud", "short summary")], { timeoutMs: 40, totalMs: 1000 });
    assert.deepEqual([a.kind, (a as { route: string }).route, (a as { degraded: boolean }).degraded], ["summary", "cloud", true]);
    assert.deepEqual(a.attempts.map((x) => [x.route, x.outcome]), [["local", "timeout"], ["cloud", "ok"]]);
    const b = await boundedSummarise(text, [never("local")], { timeoutMs: 40 });
    assert.equal(b.kind, "summary");
    assert.equal((b as { route: string }).route, EXTRACTIVE_ROUTE);
    assert.ok((b as { summary: string }).summary.length <= 2000 && (b as { summary: string }).summary.length < text.length);
    const c = await boundedSummarise(text, [never("local")], { timeoutMs: 40 }, { extractive: false });
    assert.equal(c.kind, "overflow");
    assert.match((c as { reason: string }).reason, /context_overflow/);
    assert.ok(Date.now() - t0 < 2000, "three hangs never took more than their own timeouts");
  });

  test("a summary that is empty, too long, or does not reduce the text is not accepted", async () => {
    const text = "y".repeat(3000);
    const r = await boundedSummarise(text, [says("empty", "  "), says("long", "z".repeat(1900)), says("fine", "ok")], { maxChars: 2000, maxShare: 0.5, timeoutMs: 100 });
    assert.deepEqual(r.attempts.map((x) => x.outcome), ["unusable", "unusable", "ok"]);
    const tiny = await boundedSummarise("a", [says("a", "b")]);
    assert.equal(tiny.kind, "overflow", "nothing to reduce");
    const thrower: Summariser = { route: "bad", summarise: async () => { throw new Error("boom sk-abcdefghijklmnopqrstuvwxyz"); } };
    const e = await boundedSummarise(text, [thrower], { timeoutMs: 100 }, { extractive: false });
    assert.equal(e.attempts[0]!.outcome, "error");
    assert.ok(!JSON.stringify(e).includes("sk-abcdef"), "credentials are removed from failure notes");
  });

  test("the extractive summary keeps pinned lines and the start and end, without credentials", () => {
    const s = extractiveSummary("START " + "m".repeat(5000) + " api_key=supersecretvalue END", 600, ["dec1: use PostgreSQL"]);
    assert.ok(s.length <= 600);
    assert.match(s, /Kept: dec1: use PostgreSQL/);
    assert.match(s, /START/);
    assert.ok(!s.includes("supersecretvalue"));
  });

  test("the caller giving up stops every summariser and produces nothing", async () => {
    const stop = new AbortController();
    let told = false;
    const waits: Summariser = { route: "w", summarise: ({ signal }) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => { told = true; reject(new Error("stopped")); })) };
    setTimeout(() => stop.abort(), 30);
    const r = await boundedSummarise("word ".repeat(2000), [waits, says("next", "never reached")], { timeoutMs: 5000 }, { signal: stop.signal });
    assert.deepEqual([r.kind, told], ["aborted", true]);
    assert.equal(r.attempts.length, 0);
    const already = new AbortController(); already.abort();
    assert.equal((await boundedSummarise("word ".repeat(2000), [says("a", "s")], {}, { signal: already.signal })).kind, "aborted");
  });

  test("the controller's whole chain ends well before the adapter's 150 s ceiling on the hook", () => {
    assert.ok(SUMMARY_DEFAULTS.totalMs + 30_000 <= 150_000, "the extractive fallback must be reached before the adapter declines");
    assert.ok(SUMMARY_DEFAULTS.timeoutMs * 2 <= SUMMARY_DEFAULTS.totalMs, "two routes fit in the total");
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BUDGET_DEFAULTS, buildStartup, classifyFailure, contextBudget, handoffFromFacts, inquiryBranchPlan, limitToolOutput, page, resumeDecision, tokensOf, type StartupItem } from "./budget.js";

const small = contextBudget(131_072);
const at = (n: number): string => new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();

describe("context budgets (C07)", () => {
  test("a model's window gives the startup, working and resume limits and a per-tool output limit", () => {
    assert.deepEqual([small.startupTokens, small.workingTokens, small.resumeTokens], [32768, 78643, 78643]);
    assert.ok(small.toolOutputChars > 15_000 && small.toolOutputChars < 17_000, String(small.toolOutputChars));
    assert.equal(contextBudget(1_000_000, { startupShare: 0.1 }).startupTokens, 100_000);
    for (const bad of [100, 1.5, -1, 1e12]) assert.throws(() => contextBudget(bad), RangeError);
    assert.throws(() => contextBudget(131_072, { startupShare: 0.7 }), RangeError, "startup must be below working");
    assert.throws(() => contextBudget(131_072, { workingShare: 1.5 }), RangeError);
    assert.throws(() => contextBudget(131_072, { charsPerToken: 0 }), RangeError);
  });

  test("the first prompt is cut to fit: protected and newest items whole, older machine text head and tail, the cut archived in full", () => {
    // The Lead's start: 45 long machine reports, then a human message, permissions and the goal.
    const items: StartupItem[] = [];
    for (let i = 0; i < 45; i++) items.push({ id: `c${i}`, kind: "report", text: `report ${i} ` + "x".repeat(5000), at: at(i) });
    items.push({ id: "human", kind: "human", text: "Please merge the branch and send me the hand-off.", at: at(10) });
    items.push({ id: "perm", kind: "permission", text: "You may push to origin/main.", at: at(0) });
    items.push({ id: "goal", kind: "goal", text: "Goal: ship v1.", at: at(0) });
    const before = items.reduce((n, i) => n + tokensOf(i.text.length, small), 0);
    assert.ok(before > small.startupTokens * 2, "over budget unbuilt");
    const r = buildStartup(items, small, 9000);
    assert.equal(r.blocked, undefined);
    assert.ok(r.tokens + 9000 <= small.startupTokens, `${r.tokens}`);
    const text = new Map(r.pieces.map((p) => [p.id, p.text]));
    for (const id of ["human", "perm", "goal", "c44", "c43", "c42", "c41", "c40"]) assert.ok(items.find((i) => i.id === id)!.text === text.get(id) || id.startsWith("c4") && text.get(id)!.length >= 500, id);
    assert.equal(text.get("human"), items.find((i) => i.id === "human")!.text);
    assert.ok(r.cuts.length > 0 && r.cuts.every((c) => c.keptChars < c.originalChars));
    // Oldest are cut first, and everything cut is archived whole with a matching digest.
    assert.ok(r.cuts.some((c) => c.id === "c0"));
    assert.ok(!r.cuts.some((c) => c.id === "c44"));
    for (const c of r.cuts) { const a = r.archive.find((x) => x.id === c.id)!; assert.equal(a.digest, c.digest); assert.equal(a.text, items.find((i) => i.id === c.id)!.text); }
    assert.match(text.get("c0")!, /archived as sha256:/);
    // Order is kept.
    assert.deepEqual(r.pieces.map((p) => p.id), items.map((i) => i.id));
  });

  test("what is kept whole but does not fit is refused with a blocker, never sent", () => {
    const items: StartupItem[] = [{ id: "human", kind: "human", text: "w".repeat(200_000), at: at(1) }, { id: "goal", kind: "goal", text: "ship", at: at(2) }];
    const r = buildStartup(items, small, 5000);
    assert.deepEqual([r.pieces.length, r.blocked !== undefined], [0, true]);
    assert.match(r.blocked!.reason, /does not fit/);
    assert.ok(r.blocked!.needTokens > r.blocked!.haveTokens);
    // The fixed part of the first call counts: the same items fit with room, not when the fixed part takes it all.
    const fits = [{ id: "g", kind: "goal" as const, text: "g".repeat(30_000), at: at(1) }];
    assert.equal(buildStartup(fits, small, 1000).blocked, undefined);
    assert.ok(buildStartup(fits, small, 30_000).blocked !== undefined);
    assert.throws(() => buildStartup(fits, small, -1), RangeError);
  });

  test("items that still do not fit after cutting are dropped to a reference, oldest first", () => {
    const items: StartupItem[] = [];
    for (let i = 0; i < 400; i++) items.push({ id: `m${i}`, kind: "machine", text: "y".repeat(3000), at: at(i) });
    const r = buildStartup(items, small, 2000);
    assert.equal(r.blocked, undefined);
    const dropped = r.cuts.filter((c) => c.dropped).map((c) => c.id);
    assert.ok(dropped.length > 0 && dropped.includes("m0") && !dropped.includes("m399"));
    assert.ok(r.tokens + 2000 <= small.startupTokens);
  });

  test("an attempt over 60% of the window is not resumed", () => {
    assert.equal(resumeDecision(78_643, small).resume, true);
    const no = resumeDecision(78_644, small);
    assert.equal(no.resume, false);
    assert.match(no.reason, /starting fresh from the continuation record/);
    assert.throws(() => resumeDecision(-1, small), RangeError);
    assert.match(resumeDecision(70_000, contextBudget(131_072, { resumeShare: 0.5 })).reason, /50%/);
    // A cut never makes an item longer.
    const edge = buildStartup([{ id: "a", kind: "machine", text: "z".repeat(760), at: at(1) }, { id: "b", kind: "human", text: "q".repeat(60_000), at: at(2) }], contextBudget(131_072), 0, { keepNewest: 0 });
    assert.ok(edge.pieces.find((p) => p.id === "a")!.text.length <= 760);
    assert.throws(() => buildStartup([], small, 0, { head: -1 }), RangeError);
    assert.throws(() => buildStartup([], small, 0, { keepNewest: 1.5 }), RangeError);
  });

  test("a tool result over the limit is cut with the rest kept and paged; command output keeps its end; images count", () => {
    const big = "line\n".repeat(20_000);
    const r = limitToolOutput({ text: big }, small);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length <= small.toolOutputChars, String(r.text.length));
    assert.equal(r.text.slice(0, 10), big.slice(0, 10));
    assert.ok(r.text.includes("characters not shown"));
    assert.equal(r.remainder.length, r.remainderChars);
    assert.ok(r.text.length + r.remainderChars >= big.length, "nothing is lost between what is shown and what is kept");
    const fresh = limitToolOutput({ text: "short" }, small);
    assert.deepEqual([fresh.truncated, fresh.text, fresh.remainder], [false, "short", ""]);
    const log = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n");
    const tail = limitToolOutput({ text: log, keep: "tail" }, small);
    assert.ok(tail.text.endsWith("row 4999") && !tail.text.includes("row 0\n"));
    // Pages give the kept part back in order.
    const first = page(r.remainder, 0, 5000); assert.equal(first.text.length, 5000); assert.equal(first.next, 1);
    assert.equal(page("abc", 0, 5).next, undefined);
    assert.throws(() => page("x", -1, 5), RangeError);
    // Non-text results count: they do not fit alongside a full text limit, and the ones that do not fit are dropped with a note.
    const withImages = limitToolOutput({ text: "ok", nonText: [{ kind: "image", bytes: 900_000 }, { kind: "image", bytes: 900_000 }, { kind: "image", bytes: 900_000 }, { kind: "image", bytes: 900_000 }] }, small);
    assert.ok(withImages.nonTextKept < 4 && withImages.nonTextDropped === 4 - withImages.nonTextKept && /left out/.test(withImages.text));
    const onlyOne = limitToolOutput({ text: "ok", nonText: [{ kind: "image", bytes: 10 }] }, small);
    assert.deepEqual([onlyOne.nonTextKept, onlyOne.nonTextDropped, onlyOne.text], [1, 0, "ok"]);
  });

  test("an inquiry branch starts from the latest boundary, else the latest compaction plus retrieval, else fresh with retrieval", () => {
    const inquiry = contextBudget(32_768);
    assert.equal(inquiryBranchPlan(10_000, undefined, inquiry).from, "latest-boundary");
    const compacted = inquiryBranchPlan(100_000, 12_000, inquiry);
    assert.deepEqual([compacted.from, compacted.retrieval], ["compaction-boundary", true]);
    assert.match(compacted.reason, /latest compaction/);
    assert.equal(inquiryBranchPlan(100_000, 90_000, inquiry).from, "retrieval-only");
    assert.equal(inquiryBranchPlan(100_000, undefined, inquiry).from, "retrieval-only");
  });

  test("context failures are their own class", () => {
    for (const m of ["Context compression timed out without reducing this conversation", "Compaction failed: timeout", "prompt is too long: 210000 tokens", "This model's maximum context length is 131072 tokens", "context_compression_timeout", "request too large"]) assert.equal(classifyFailure(m), "context_overflow", m);
    for (const m of ["Rate limit reached: too many tokens per minute", "invalid contextWindow setting", "ECONNRESET", "401 unauthorized", "model_error: overloaded", ""]) assert.equal(classifyFailure(m), "other", m);
  });

  test("a hand-off is written from durable facts, bounded and with credentials removed", () => {
    const text = handoffFromFacts({ task: "tsk-aaaaaaaaaaaaaaaaaaaa merge release", endedBecause: "the attempt died after the merge", effects: [{ id: "eff-bbbbbbbbbbbbbbbbbbbb", state: "confirmed", summary: "merged main (token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH)" }], artifacts: [{ id: "art-cccccccccccccccccccc", title: "release notes" }], checkpoint: { at: 41, digest: "v1:sha256:aa" }, lastKnownState: "merge pushed", nextStep: "send the hand-off" });
    for (const part of ["the attempt died after the merge", "eff-bbbbbbbbbbbbbbbbbbbb [confirmed]", "art-cccccccccccccccccccc release notes", "position 41", "Next step recorded: send the hand-off"]) assert.ok(text.includes(part), part);
    assert.ok(!text.includes("sk-ant-api03"), "no credential");
    const long = handoffFromFacts({ task: "t", endedBecause: "x", effects: Array.from({ length: 500 }, (_, i) => ({ id: `eff-${i}`, state: "confirmed", summary: "s".repeat(50) })), artifacts: [], lastKnownState: "y" }, 1000);
    assert.ok(long.length <= 1000 && /cut at 1000/.test(long));
  });

  test("defaults are the Paperclip rule of thumb", () => {
    assert.deepEqual([BUDGET_DEFAULTS.startupShare, BUDGET_DEFAULTS.workingShare, BUDGET_DEFAULTS.resumeShare, BUDGET_DEFAULTS.charsPerToken], [0.25, 0.6, 0.6, 3]);
  });
});

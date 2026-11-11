import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTEMPT_ENDINGS_LIMITS, END_KIND_WORDS, attemptEndingLines, endKindWords, endingBlocker } from "./endings.js";
import type { DispatchBody } from "./model.js";

// Card W08: how each attempt ended, in the owner's words, from the dispatch record alone.

/** A finished record with `over` laid on it; a key given as undefined is left out. */
const base = (over: { readonly [K in keyof DispatchBody]?: DispatchBody[K] | undefined } = {}): DispatchBody => JSON.parse(JSON.stringify({
  attemptId: "att-aaaaaaaaaaaaaaaaaaaa", taskId: "task-bbbbbbbbbbbbbbbbbbbb", projectId: "prj-cccccccccccccccccccc", agentId: "agent:ann", generation: 1, state: "finished",
  route: "localp/small", role: "coder", request: { contextTokens: 1, needs: [], data: "local-only", paidAuthorized: false }, revisions: {} as never, hostId: "host:w1",
  claimedAt: "2026-11-10T10:00:00.000Z", startedAt: "2026-11-10T10:00:01.000Z", heartbeats: 0, inFlight: [], parked: [], calls: 0, ...over,
})) as DispatchBody;

test("each end kind is said in plain words, and a kind this controller does not know reads as unknown", () => {
  assert.match(endKindWords("length"), /ran out of length/);
  assert.match(endKindWords("no-work-end"), /ended with prose and no work\.end/);
  assert.match(endKindWords("announced-step-without-tool-call"), /announced a step but made no call/);
  assert.match(endKindWords("empty-visible-text"), /no visible text/);
  assert.match(endKindWords("normal"), /ended normally/);
  assert.match(endKindWords("unknown"), /^unknown/);
  for (const strange of ["from-a-newer-worker", "__proto__", "constructor", undefined]) assert.match(endKindWords(strange), /^unknown \(the worker did not say/, String(strange));
  assert.deepEqual(Object.keys(END_KIND_WORDS).sort(), ["announced-step-without-tool-call", "empty-visible-text", "length", "no-work-end", "normal", "unknown"]);
});

test("an attempt that stopped early: its last turn, nudges, plan progress, its stops and the blocker it left, with its ending summary quoted once and redacted", () => {
  const d = base({
    outcome: { status: "stopped-early", summary: "the turn completed; it stopped early (no-work-end) token sk-abcdefghijklmnopqrstuvwxyz0123456789 and ‮\"quote\"", at: "2026-11-10T10:05:00.000Z" },
    turnEnd: { endKind: "no-work-end", visibleChars: 42, at: "2026-11-10T10:04:59.000Z", nudges: 2, plan: { done: 1, total: 3 } },
    nudgesUsed: 6,
    stoppedEarly: [
      { endKind: "length", at: "2026-11-10T10:01:00.000Z", readmitted: true, nudges: 2, plan: { done: 0, total: 3 } },
      { endKind: "announced-step-without-tool-call", at: "2026-11-10T10:03:00.000Z", readmitted: true, nudges: 2, plan: { done: 1, total: 3 } },
      { endKind: "no-work-end", at: "2026-11-10T10:04:59.000Z", readmitted: false, nudges: 2, plan: { done: 1, total: 3 } },
    ],
  });
  const [head, detail] = attemptEndingLines(d, 3);
  assert.match(head, /^Attempt 3 \(att-aaaaaaaaaaaaaaaaaaaa\), agent ann on route localp\/small as coder: started 2026-11-10T10:00:01\.000Z; it ended stopped early: the agent kept stopping before it said its work was done at 2026-11-10T10:05:00\.000Z/);
  assert.match(head, /its ending says \(quoted\): "the turn completed; .*\\u202e\\"quote\\""/, "the summary quoted once, its controls escaped");
  assert.ok(!head.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), "a credential in the summary is redacted");
  assert.match(detail, /Its last turn: it ended with prose and no work\.end \(42 visible characters\)/);
  assert.match(detail, /Nudges to go on: 6 \(2 in its last turn\)\./);
  assert.match(detail, /Plan: 1 of 3 step\(s\) checked\./);
  assert.match(detail, /stopped before saying its work was done 3 time\(s\) \(the model ran out of length; it announced a step but made no call; it ended with prose and no work\.end\); it went on from its checkpoint 2 time\(s\) of the 2 allowed/);
  assert.match(detail, /It left a blocker, agent_stopped_early: the agent kept stopping/);
  assert.equal(endingBlocker(d), "agent_stopped_early");
});

test("a done: the checks' verdict, whether a second agent questioned the report (its text is not repeated), the blockers of W05 and W10, and the waits for jobs", () => {
  const verified = base({
    outcome: { status: "succeeded", summary: "the turn completed", at: "2026-11-10T10:05:00.000Z" },
    turnEnd: { endKind: "normal", at: "2026-11-10T10:05:00.000Z" },
    verifications: [{ key: "k1", at: "x", state: "failed", failures: ["a", "b"], checks: [], contract: 1, counted: true, exhausted: false }, { key: "k2", at: "x", state: "passed", failures: [], checks: [], contract: 1, counted: false, exhausted: false }],
    report: { key: "k2", result: "done", text: "SECRET REPORT TEXT", at: "x", questioning: "supported" },
  });
  const [, detail] = attemptEndingLines(verified, 1);
  assert.match(detail, /Its done was checked against the task contract 2 time\(s\); the last check passed\./);
  assert.match(detail, /It ended with a report \(done\); a second agent questioned it and found it supported\. The report's text is in the task's work report\./);
  assert.match(detail, /Plan: not known/);
  assert.match(detail, /Nudges to go on: 0\./);
  assert.match(detail, /It left no blocker\./);
  assert.ok(!detail.includes("SECRET REPORT TEXT"), "the report's text is the work report's, not repeated here");

  const unverified = base({ outcome: { status: "abandoned", summary: "x", at: "y" }, verifications: [{ key: "k", at: "x", state: "unknown", failures: ["host down"], checks: [], contract: 1, counted: true, exhausted: true }] });
  assert.equal(endingBlocker(unverified), "done_unverified");
  assert.match(attemptEndingLines(unverified, 1)[1], /the last check could not be made \(1 thing\(s\) not looked at\).*It left a blocker, done_unverified/);
  const unsupported = base({ outcome: { status: "abandoned", summary: "x", at: "y" }, interrogation: { state: "unsupported", rounds: [], at: "x", exhausted: true }, report: { key: "k", result: "done", text: "t", at: "x", questioning: "unsupported" } });
  assert.equal(endingBlocker(unsupported), "report_unsupported");
  assert.match(attemptEndingLines(unsupported, 1)[1], /found it not supported.*It left a blocker, report_unsupported/);
  const notRun = base({ report: { key: "k", result: "done", text: "t", at: "x", questioning: "not-run" } });
  assert.match(attemptEndingLines(notRun, 1)[1], /no second agent questioned it/);
  const partial = base({ report: { key: "k", result: "partial", text: "t", at: "x", questioning: "not-asked" } });
  assert.match(attemptEndingLines(partial, 1)[1], /\(partial\); it was not questioned \(only a done is\)/);

  const waiting = base({ state: "parked", waitsOnJobs: ["job-1", "job-2"], wakeRound: 1, outcome: undefined });
  const [wh, wd] = attemptEndingLines(waiting, 2);
  assert.match(wh, /it is waiting for 2 job\(s\) of the task to end \(it is woken when one does\)\./);
  assert.match(wd, /A job's end woke it 1 time\(s\)\./);
  assert.match(attemptEndingLines(base({ state: "running", outcome: undefined }), 1)[0], /it is running now\./);
  assert.match(attemptEndingLines(base({ state: "waiting", outcome: undefined, stoppedEarly: [{ endKind: "length", at: "x", readmitted: true }] }), 1)[0], /waiting to go on from its checkpoint after its last turn stopped early/);
});

test("the lines are bounded however long the record's text is", () => {
  const long = base({ agentId: `agent:${"a".repeat(5000)}`, route: "r".repeat(5000), outcome: { status: "failed", summary: "s".repeat(5000), at: "x" }, stoppedEarly: Array.from({ length: 50 }, () => ({ endKind: "length" as const, at: "x", readmitted: true })) });
  const [head, detail] = attemptEndingLines(long, 1);
  assert.ok(head.length <= ATTEMPT_ENDINGS_LIMITS.head, String(head.length));
  assert.ok(detail.length <= ATTEMPT_ENDINGS_LIMITS.detail, String(detail.length));
  // The longest names and an ending summary full of escaped characters: the quotation is cut inside its own room and always closed, never cut with the line.
  const wide = base({ attemptId: "a".repeat(5000), agentId: `agent:${"g".repeat(5000)}`, route: "r".repeat(5000), role: "o".repeat(5000), outcome: { status: "abandoned", summary: "\u202e".repeat(500), at: "2026-11-10T10:05:00.000Z" } });
  const [wideHead] = attemptEndingLines(wide, 1);
  assert.ok(wideHead.length <= ATTEMPT_ENDINGS_LIMITS.head, String(wideHead.length));
  assert.match(wideHead, /its ending says \(quoted\): "(\\u202e)+\.\.\."\.$/, wideHead);
});

test("names full of characters that are shown escaped never push the line's cut into the quoted ending summary: the quotation stays whole and closed (card W08, second review)", () => {
  const odd = ["\"", "\\", "\n", "\u202e", "\u200b", "\u{1f600}", "\ud800", "\udc00", "\u0085", "\u001b", "a"];
  let seed = 7;
  const pick = (n: number): string => Array.from({ length: n }, () => { seed = (seed * 1103515245 + 12345) % 2147483648; return odd[seed % odd.length]!; }).join("");
  for (let i = 0; i < 300; i++) {
    const d = base({ attemptId: `att-${pick(80)}`, agentId: `agent:${pick(100)}`, route: pick(120), role: pick(60), outcome: { status: (["succeeded", "failed", "stopped-early", "abandoned"] as const)[i % 4]!, summary: pick(600), at: "2026-11-10T10:05:00.000Z" } });
    const [head, detail] = attemptEndingLines(d, 21);
    assert.ok(head.length <= ATTEMPT_ENDINGS_LIMITS.head && detail.length <= ATTEMPT_ENDINGS_LIMITS.detail);
    const m = /; its ending says \(quoted\): (".*")\.$/.exec(head);
    assert.ok(m, head);
    assert.equal(typeof JSON.parse(m[1]!), "string", "the quotation is closed and well formed");
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202e\u200b]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(head + detail), head);
  }
});

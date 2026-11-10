// How a Pi run ended (card W01). Reads the JSON event log `pi -p --mode json` writes (one event per line) and,
// with what the runner measured afterwards (hidden tests, PLAN.md, the diff), names the run's ending.
// Plain Node ESM, no dependencies; paths are never built here, so it is the same on every platform.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Every ending a run can have. `unclassified` exists only so a gap in this file is counted instead of hidden; the gates require none. */
export const OUTCOMES = Object.freeze(["verified-finish", "stopped-early", "length", "empty", "wrong", "interface-mismatch", "timeout", "error", "unclassified"]);

/** Words a final report uses when it says the work is done. Read only to tell a false done (`wrong`) from a stop mid-work; it never makes a run a finish. */
const DONE_CLAIM = /\b(?:done|complete(?:d|s)?|finished|all (?:\d+ )?(?:of the )?(?:tests?|checks?|steps?) (?:now )?pass(?:ed|es)?|implemented|summary of (?:the )?(?:work|changes)|work is complete)\b/i;
/**
 * A report that says the work is NOT done ("I could not complete step 4", "two tests still fail", "remaining work: ...").
 * An honest partial report is a stop, not a false done, even though it uses the words DONE_CLAIM looks for.
 */
const NOT_DONE = /\b(?:not|never)\s+(?:yet\s+|been\s+|fully\s+)*(?:done|complete[ds]?|finish(?:ed)?|implemented|pass(?:ing|ed)?)\b|n't\s+(?:yet\s+|been\s+|fully\s+)*(?:done|complete[ds]?|finish(?:ed)?|implemented|pass(?:ing|ed)?)\b|\b(?:unable to|could ?not|couldn't|cannot|can't|did not|didn't|failed to)\s+(?:yet\s+)?(?:complete|finish|get|make|implement|fix)\b|(?<!\b(?:no|nothing|zero)\s+(?:\w+\s+)?)\bremaining (?:work|steps?|tasks?|items?|failures?)\b|(?<!\b(?:no|none|nothing|zero)\s+(?:\w+\s+)?)\bstill (?:fail(?:s|ing)?|to do|open|unchecked)\b|\b(?:incomplete|work in progress)\b|(?<!\bnothing\s+(?:is\s+)?)\bleft to do\b|\b(?:mostly|almost|nearly|largely|partly|partially)\s+(?:done|complete[d]?|finished|implemented|working|fixed)\b|\b(?:I'm|I am|I was|I've been|I have been)\s+(?:still\s+)?blocked\b|\b(?:the\s+)?(?:task|work|step\s+\d+)\s+(?:is|was|remains)\s+(?:still\s+)?blocked\b/i;
// The lookbehinds keep a done report's "no remaining failures", "none still failing", "no tests still fail" and
// "nothing left to do" from reading as a partial report.
/**
 * The result a report states (card W06: variant B asks for a final report that starts with the result, done, partial or
 * blocked), read from the first place it is stated: the report's opening word used as a result ("Partial. Implemented
 * the parser; ...", "**Blocked** by ...", "## Blocked\n", "⚠️ Partial:", "All done."), or a result label at the start of a
 * line ("**Result: blocked**", "Result - partial", "Status: partial", "## Result\n\nBlocked", "The result is partial",
 * "Result (done, partial or blocked): partial", "| Status | blocked |"). Only the first statement counts, so a report that
 * opens "Done." keeps its done claim whatever a later line says ("Result: blocked requests now get 403"), and a word that
 * is not used as a result ("Blocked users are refused", "Partial matches rank first", "Status: blocked requests get 403")
 * states nothing: the word must be followed by punctuation, the line's end or a word that goes with a result ("by",
 * "on", "because", "with", "but", ...). The opening of the report (its first 600 characters) is read first; a long report
 * that states nothing there is read for a result label in its last 600 characters (third review: "... Result: partial"
 * at the end of a long report).
 */
const RESULT_AFTER = String.raw`(?=[*_\x60'"]*(?:\s*(?:[.:;!,(|\u2013\u2014-]|\p{Extended_Pictographic}|\n|$)|\s+(?:by|on|because|due|until|pending|with|but|except|result|work|implementation|progress|completion|finish|solution|success|complete[d]?|done|finished|implemented|overall)\b))`;
const RESULT_OPENING = String.raw`^[^\p{L}\p{N}]{0,12}(?<open>(?:all\s+)?done|complete[d]?|finished|partial|blocked)` + RESULT_AFTER;
const RESULT_LABEL = (start) => String.raw`${start}[^\p{L}\p{N}\n]{0,8}(?:(?:the|my|overall|final)\s+){0,2}(?:result|status|outcome)(?:\s*\([^)\n]{0,60}\))?[*_\x60]*[ \t]*(?:is\s+|[:=|\u2013\u2014-]\s*|\n[^\p{L}\p{N}]{0,12})[*_\x60"'\s]*(?:\p{Extended_Pictographic}\ufe0f?\s*)?(?<label>done|partial(?:ly)?|blocked|incomplete|not\s+done)` + RESULT_AFTER;
const RESULT_STATED_HEAD = new RegExp(`${RESULT_OPENING}|${RESULT_LABEL("(?:^|\\n)")}`, "iu");
const RESULT_STATED_TAIL = new RegExp(RESULT_LABEL("\\n"), "iu");
/**
 * The first result the report states: "not-done" (partial, blocked, incomplete), "done" (said as a result: "Done.",
 * "Result: done", "Done, but ..."), "done-label" (an opening "Done:" or "Completed:", which may only head a list of what
 * was done, so the report's not-done words still count), or null when it states none.
 */
function statedResult(head, tail, long) {
  const m = RESULT_STATED_HEAD.exec(head) ?? (long ? RESULT_STATED_TAIL.exec(tail) : null);
  if (m === null) return null;
  const word = (m.groups.open ?? m.groups.label).toLowerCase().replace(/\s+/g, " ");
  if (/^(?:partial|partially|blocked|incomplete|not done)$/.test(word)) return "not-done";
  if (m.groups.open !== undefined && /^[*_`'"]*\s*:/.test(head.slice(m.index + m[0].length))) return "done-label";
  return "done";
}
/**
 * A report whose plan is all done, said without the word "done": "All boxes ticked; tree clean.", "All ten steps are
 * committed and the working tree is clean.", "All PLAN.md boxes are ticked".
 */
const ALL_TICKED = /\ball\s+(?:(?:the|of the|my|[\w.]+)\s+){0,3}(?:boxes|steps|items|checkboxes|tasks)\s+(?:are\s+|were\s+)?(?:now\s+)?(?:ticked|checked|done|complete[d]?|committed|finished)\b|\b(?:working\s+)?tree\s+(?:is\s+)?clean\b/i;
/**
 * The start of a scoped caveat note at the end of a report ("Remaining risk / not done: ...", "**Not done:** ...",
 * "Out of scope and left alone: ...", or such a label alone on its line as a heading). What follows it names what the agent chose to leave, not a refusal of the task.
 */
const CAVEAT_LABEL = /(?:^|\n)[ \t]*[#>*_\- \t]*(?:remaining risks?|risks?|not done|left (?:out|undone|alone)|out of scope|follow[- ]?ups?|known (?:limitations?|gaps?|issues?)|caveats?|limitations?|open (?:points|questions)|not (?:changed|touched|covered|in this change))\b[^\n:]{0,40}(?::|(?=\n))/i;
/** A tool call that runs tests: its result is read for the agent's own last test counts. */
const TEST_COMMAND = /(?:--test\b|\bnpm\s+(?:run\s+)?test\b|\bnode\s+--test\b)/;
/** A last line that announces a next step ("Now let me run the tests:") instead of reporting. "Let me know ..." is a sign-off, not a step. */
const ANNOUNCES_STEP = /(?:^|[\n.!]\s*)(?:(?:now|next|then|first|ok(?:ay)?|good)[,:]?\s+)?(?:I'll|I will|I'm going to|let me(?!\s+know)|let's|I need to)\b[^\n]*$|:\s*$/i;
/** What a model writes when it answers nothing (seen as the whole thinking of a thinking-only reply). */
const NO_RESPONSE = /^\s*no response requested\.?\s*$/i;

const textOf = (content, type, field) => (Array.isArray(content) ? content.filter((c) => c && c.type === type).map((c) => String(c[field] ?? "")).join("") : "");

/** A fresh summary, filled event by event by `addEvent`. */
export function newSummary() {
  return {
    sawSession: false, sessionId: null, agentStart: false, agentEnd: false, settled: false, aborted: false,
    turns: 0, assistantMessages: 0, toolCalls: 0, toolErrors: 0, toolCommands: [],
    tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
    last: null, parseErrors: 0, events: 0,
    // The agent's own test runs: the counts of the last one that printed any, and how many ran.
    selfTestRuns: 0, lastSelfTest: null, pendingTests: new Set(),
  };
}

/** Folds one parsed event into the summary. Only assistant `message_end` events count as model replies (a `turn_end` repeats the same message). */
export function addEvent(s, e) {
  s.events++;
  if (e === null || typeof e !== "object") { s.parseErrors++; return; }
  switch (e.type) {
    case "session": s.sawSession = true; s.sessionId = typeof e.id === "string" ? e.id : null; break;
    case "agent_start": s.agentStart = true; break;
    case "agent_end": s.agentEnd = true; break;
    case "agent_settled": s.settled = true; s.aborted = e.aborted === true; break;
    case "turn_end": s.turns++; break;
    case "tool_execution_start":
      s.toolCalls++;
      // Kept bounded: only used to look for a run that read the hidden solution from elsewhere.
      if (s.toolCommands.length < 5000) s.toolCommands.push(JSON.stringify(e.args ?? {}).slice(0, 2000));
      if (typeof e.args?.command === "string" && TEST_COMMAND.test(e.args.command)) s.pendingTests.add(e.toolCallId);
      break;
    case "tool_execution_end": {
      if (e.isError === true) s.toolErrors++;
      if (!s.pendingTests.delete(e.toolCallId)) break;
      s.selfTestRuns++;
      const out = textOf(e.result?.content, "text", "text") || String(e.result?.structuredContent?.output ?? "");
      const c = testCounts(out);
      if (c.pass !== null || c.fail !== null) s.lastSelfTest = { tests: c.tests, pass: c.pass, fail: c.fail };
      break;
    }
    case "message_end": {
      const m = e.message;
      if (!m || m.role !== "assistant") break;
      s.assistantMessages++;
      const u = m.usage ?? {};
      for (const k of ["input", "output", "cacheRead", "reasoning"]) if (Number.isFinite(u[k])) s.tokens[k] += u[k];
      const visible = textOf(m.content, "text", "text");
      const thinking = textOf(m.content, "thinking", "thinking");
      const calls = Array.isArray(m.content) ? m.content.filter((c) => c && c.type === "toolCall").length : 0;
      s.last = {
        stopReason: typeof m.stopReason === "string" ? m.stopReason : null,
        visibleChars: visible.trim().length,
        thinkingChars: thinking.trim().length,
        toolCallsInMessage: calls,
        // Bounded copies, enough to read the ending and to quote it in a report.
        // A report often says "Done." first and lists tests last, so both ends are kept and read for a done claim.
        visibleHead: visible.trim().slice(0, 600),
        visibleTail: visible.trim().slice(-600),
        // The whole report (bounded), to tell a scoped caveat note at its end from a refusal.
        visibleText: visible.trim().slice(0, 20_000),
        thinkingTail: thinking.trim().slice(-300),
        errorMessage: typeof m.errorMessage === "string" ? m.errorMessage.slice(0, 300) : null,
      };
      break;
    }
    default: break;
  }
}

/** Summarises a whole log given as text. A line that is not JSON is counted, not fatal (a crash can leave a half line). */
export function summarizeLogText(text) {
  const s = newSummary();
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let e;
    try { e = JSON.parse(line); } catch { s.parseErrors++; continue; }
    addEvent(s, e);
  }
  return s;
}

/** Summarises a log file line by line, so a 25 MB log is never held whole. A missing file is an empty summary. */
export async function summarizeLogFile(path) {
  const s = newSummary();
  let stream;
  try { stream = createReadStream(path, { encoding: "utf8" }); } catch { return s; }
  const done = new Promise((resolve) => { stream.on("error", () => resolve()); stream.on("close", () => resolve()); });
  try {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim() === "") continue;
      let e;
      try { e = JSON.parse(line); } catch { s.parseErrors++; continue; }
      addEvent(s, e);
    }
  } catch { /* an unreadable file reads as what was summarised so far */ }
  await done;
  return s;
}

/** What kind of ending the last reply was, independent of the tests: the W02 end kinds, as far as the CLI log shows them. */
export function endKindOf(summary) {
  const last = summary.last;
  if (last === null) return "no-reply";
  if (last.stopReason === "length") return "length";
  if (last.stopReason === "error" || last.stopReason === "aborted") return last.stopReason;
  if (last.visibleChars === 0) return last.toolCallsInMessage > 0 ? "tool-call-then-exit" : "thinking-only";
  if (ANNOUNCES_STEP.test(last.visibleTail)) return "announced-step";
  return "report";
}

/** Whether the agent's last own test run that printed counts was green (some passed, none failed). */
export const selfTestsGreen = (summary) => summary.lastSelfTest !== null && summary.lastSelfTest !== undefined && (summary.lastSelfTest.pass ?? 0) > 0 && summary.lastSelfTest.fail === 0;

/**
 * What the last reply says about the work:
 *   "done"              it says the work is done: done words ("Done.", "complete", "all tests pass"), a plan said to be
 *                       all done ("All boxes ticked; tree clean."), or, whatever its words, a report given with every
 *                       PLAN.md box ticked, a clean tree and the agent's own last test run green;
 *   "done-with-caveats" the same, with a scoped note of what was left ("Remaining risk / not done: ..."): still a done claim;
 *   "not-done"          it says the work is not done (outside such a note): an honest partial report, not a false done
 *                       (a result stated as done first, "Done." or "Result: done", is a done claim whatever follows it);
 *   "none"              no visible report, a report that announces a next step, or one that claims nothing.
 * Only the first and last 600 characters of the report's body (before any caveat note) are read for the words, since
 * the middle of a long report quotes old states ("the tests were not passing before").
 *   ctx: { plan, dirty } as the runner measured them (both optional).
 */
export function doneClaim(summary, { plan = null, dirty = null } = {}) {
  const last = summary.last;
  if (last === null || last.visibleChars === 0) return "none";
  if (ANNOUNCES_STEP.test(last.visibleTail)) return "none";
  const text = last.visibleText ?? `${last.visibleHead ?? ""}\n${last.visibleTail ?? ""}`;
  const cut = CAVEAT_LABEL.exec(text);
  const body = cut === null ? text : text.slice(0, cut.index);
  const head = body.slice(0, 600), tail = body.slice(-600);
  const stated = statedResult(head, tail, body.length > 600);
  if (stated === "not-done") return "not-done";
  const notDoneWords = NOT_DONE.test(head) || NOT_DONE.test(tail);
  // A result said as done is a done claim whatever the report admits after it ("Done. ... I could not get the lint step
  // to run"): it is the claim the false-done gate counts, so it is never hidden as a stop (third review).
  if (stated === "done") return cut !== null || notDoneWords ? "done-with-caveats" : "done";
  if (notDoneWords) return "not-done";
  const structural = plan !== null && plan.unchecked === 0 && plan.checked > 0 && dirty === false && selfTestsGreen(summary);
  const said = DONE_CLAIM.test(head) || DONE_CLAIM.test(tail) || ALL_TICKED.test(head) || ALL_TICKED.test(tail);
  if (!said && !structural) return "none";
  return cut !== null ? "done-with-caveats" : "done";
}

/** Whether the last visible text claims the work is done (with or without a caveat note). */
export const claimsDone = (summary, ctx) => { const d = doneClaim(summary, ctx); return d === "done" || d === "done-with-caveats"; };

/**
 * Names a run's ending. Input:
 *   summary   — from summarizeLog*;
 *   hidden    — { ran, passed } for the held-back tests (passed only when they ran, exited 0 and counted no failure);
 *   plan      — { checked, unchecked } from PLAN.md, or null when there is none;
 *   changed   — whether the agent left any commit or edit in its worktree;
 *   timedOut  — the runner killed the agent at its wall-clock limit;
 *   exitCode  — the agent process's exit code (null when killed by a signal).
 * The order matters: a timeout or a broken run is never a finish, a finish needs the hidden tests to pass on a changed
 * worktree, and every other ending is named from the log. `unclassified` is returned only for a case not foreseen here.
 */
export function classify({ summary, hidden, plan = null, changed, dirty = null, timedOut = false, exitCode = 0 }) {
  const endKind = endKindOf(summary);
  const claim = doneClaim(summary, { plan, dirty });
  const done = claim === "done" || claim === "done-with-caveats";
  const out = (outcome, reason) => ({ outcome, reason, endKind, claimsDone: done, doneClaim: claim });
  if (timedOut) return out("timeout", "the agent was stopped at its wall-clock limit");
  if (!summary.sawSession && summary.assistantMessages === 0) return out("error", `the agent wrote no Pi session (exit ${exitCode})`);
  if (summary.last !== null && (summary.last.stopReason === "error" || summary.last.stopReason === "aborted")) return out("error", `the last reply ended with ${summary.last.stopReason}${summary.last.errorMessage ? `: ${summary.last.errorMessage}` : ""}`);
  if (!summary.agentEnd && exitCode !== 0) return out("error", `the agent process exited ${exitCode} before its run ended`);
  if (hidden?.passed === true) {
    if (changed) return out("verified-finish", "the held-back tests pass on the agent's work");
    // A task whose hidden tests pass with nothing done is a broken task, not a finish; calibration should have caught it.
    return out("error", "the held-back tests pass on an unchanged worktree: the task is not calibrated");
  }
  if (summary.last === null) return out("empty", "the agent wrote no reply at all");
  if (summary.last.stopReason === "length") return out("length", "the last reply hit the output limit");
  if (summary.last.visibleChars === 0 && (summary.toolCalls === 0 || NO_RESPONSE.test(summary.last.thinkingTail))) return out("empty", "the run ended on a reply with no visible text before doing any work");
  const unfinishedPlan = plan !== null && plan.unchecked > 0;
  if (!summary.agentEnd) return out("stopped-early", "the agent process ended without finishing its run");
  if (summary.last.stopReason === "stop" || summary.last.stopReason === "toolUse") {
    if (unfinishedPlan) return out("stopped-early", `the agent stopped with ${plan.unchecked} unchecked PLAN.md step(s) and the held-back tests fail`);
    if (summary.last.visibleChars === 0) return out("stopped-early", "the agent stopped on a thinking-only reply mid-work");
    if (done && hidden?.interfaceMismatch === true) return out("interface-mismatch", `the agent said it was done and the held-back tests do not type-check against its code (${(hidden.typeErrorFiles ?? []).slice(0, 3).join(", ") || "a name, field or signature differs"}): not scored as a false done`);
    if (done) return out("wrong", `the agent said it was done${claim === "done-with-caveats" ? " (with a note of what it left)" : ""} and the held-back tests fail`);
    return out("stopped-early", endKind === "announced-step" ? "the agent announced a next step and stopped" : "the agent stopped without saying the work was done");
  }
  return out("unclassified", `no rule for stopReason ${JSON.stringify(summary.last.stopReason)}`);
}

/** Counts PLAN.md checkboxes (`- [ ]`, `- [x]`, `* [X]`, numbered too). */
export function planProgress(text) {
  if (typeof text !== "string") return null;
  let checked = 0, unchecked = 0;
  for (const m of text.matchAll(/^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]/gm)) { if (m[1] === " ") unchecked++; else checked++; }
  return { checked, unchecked };
}

/** Reads `node --test` summary counts from its output (TAP or spec reporter). */
export function testCounts(output) {
  const text = String(output);
  const num = (re) => { let v = null; for (const m of text.matchAll(re)) v = Number(m[1]); return v; };
  return {
    tests: num(/^#\s*tests\s+(\d+)/gm) ?? num(/^ℹ tests (\d+)/gm),
    pass: num(/^#\s*pass\s+(\d+)/gm) ?? num(/^ℹ pass (\d+)/gm),
    fail: num(/^#\s*fail\s+(\d+)/gm) ?? num(/^ℹ fail (\d+)/gm),
  };
}

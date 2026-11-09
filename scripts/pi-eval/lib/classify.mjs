// How a Pi run ended (card W01). Reads the JSON event log `pi -p --mode json` writes (one event per line) and,
// with what the runner measured afterwards (hidden tests, PLAN.md, the diff), names the run's ending.
// Plain Node ESM, no dependencies; paths are never built here, so it is the same on every platform.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Every ending a run can have. `unclassified` exists only so a gap in this file is counted instead of hidden; the gates require none. */
export const OUTCOMES = Object.freeze(["verified-finish", "stopped-early", "length", "empty", "wrong", "timeout", "error", "unclassified"]);

/** Words a final report uses when it says the work is done. Read only to tell a false done (`wrong`) from a stop mid-work; it never makes a run a finish. */
const DONE_CLAIM = /\b(?:done|complete(?:d|s)?|finished|all (?:\d+ )?(?:of the )?(?:tests?|checks?|steps?) (?:now )?pass(?:ed|es)?|implemented|summary of (?:the )?(?:work|changes)|work is complete)\b/i;
/** A last line that announces a next step ("Now let me run the tests:") instead of reporting. */
const ANNOUNCES_STEP = /(?:^|[\n.!]\s*)(?:(?:now|next|then|first|ok(?:ay)?|good)[,:]?\s+)?(?:I'll|I will|I'm going to|let me|let's|I need to)\b[^\n]*$|:\s*$/i;
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
      break;
    case "tool_execution_end": if (e.isError === true) s.toolErrors++; break;
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
        visibleTail: visible.trim().slice(-600),
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

/** Whether the last visible text claims the work is done. */
export const claimsDone = (summary) => summary.last !== null && summary.last.visibleChars > 0 && DONE_CLAIM.test(summary.last.visibleTail) && !ANNOUNCES_STEP.test(summary.last.visibleTail);

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
export function classify({ summary, hidden, plan = null, changed, timedOut = false, exitCode = 0 }) {
  const endKind = endKindOf(summary);
  const out = (outcome, reason) => ({ outcome, reason, endKind, claimsDone: claimsDone(summary) });
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
    if (claimsDone(summary)) return out("wrong", "the agent said it was done and the held-back tests fail");
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

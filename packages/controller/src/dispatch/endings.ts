import { quoted, shown } from "../status/explain.js";
import { STOPPED_EARLY_READMITS, type DispatchBody, type PlanCount } from "./model.js";

/**
 * Card W08: how each attempt of a task ended, in the owner's words, from the dispatch record alone. Two lines per attempt: what it was and how it ended, then what the controller knows of its last turn (how it ended, the nudges
 * to go on, the plan's progress), its stops before the work was done, the checks of its done (W05), its report's questioning (W10, the text itself is in the work report), its waits for jobs (W11) and the blocker it left.
 * Whatever an agent or a worker wrote (an attempt's ending summary) is quoted once; everything else is the controller's own wording.
 */

/** Each turn end kind (card W02) in plain words; a kind this controller does not know reads as unknown. */
export const END_KIND_WORDS: Readonly<Record<string, string>> = {
  normal: "it ended normally, with a work.end that was taken",
  length: "the model ran out of length (its reply was cut off at the reply limit)",
  "empty-visible-text": "its last reply had no visible text",
  "no-work-end": "it ended with prose and no work.end",
  "announced-step-without-tool-call": "it announced a step but made no call",
  unknown: "unknown (the worker did not say how it ended)",
};
export const endKindWords = (kind: string | undefined): string => (kind !== undefined && Object.hasOwn(END_KIND_WORDS, kind) ? END_KIND_WORDS[kind]! : END_KIND_WORDS["unknown"]!);

/** The blockers an attempt can leave (cards W03, W05, W10), in plain words. */
export const ENDING_BLOCKER_WORDS = {
  agent_stopped_early: "the agent kept stopping before it said its work was done, and its go-ons were used up (from its checkpoint, or its wake-ups when its jobs ended)",
  done_unverified: "the agent kept saying its work was done, and the controller's checks of the task contract kept failing or could not be made, until its go-ons were used up",
  report_unsupported: "the agent kept saying its work was done, and a second agent kept finding its report not supported by the work, until its go-ons were used up",
} as const;
export type EndingBlocker = keyof typeof ENDING_BLOCKER_WORDS;

/** The bounds of the view: the attempts shown (newest first) and one attempt's two lines. */
export const ATTEMPT_ENDINGS_LIMITS = { attempts: 6, head: 500, detail: 900 } as const;

const planWords = (p: PlanCount | undefined): string => (p === undefined ? "not known (no checkbox plan was reported when a turn ended)" : `${p.done} of ${p.total} step(s) checked`);
/** Cut to `max` with `...`; never inside a surrogate pair (a name shown as it is may hold one). */
const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let end = max - 3;
  if (/[\ud800-\udbff]/.test(text.charAt(end - 1))) end--;
  return `${text.slice(0, end)}...`;
};
/** The least room the ending summary's quotation is given in the head line: its quotes, a few characters and the cut mark. */
const QUOTE_MIN = 20;

/** The blocker this attempt left, read from its record: an early stop with its go-ons used up, a done whose checks were used up, or a report a second agent kept finding unsupported. */
export function endingBlocker(d: DispatchBody): EndingBlocker | undefined {
  if (d.outcome?.status === "stopped-early") return "agent_stopped_early";
  if (d.interrogation?.state === "unsupported" && d.interrogation.exhausted === true) return "report_unsupported";
  const v = d.verifications?.at(-1);
  if (v !== undefined && v.state !== "passed" && v.exhausted) return "done_unverified";
  return undefined;
}

/** How the attempt stands or ended, in plain words. */
function howItEnded(d: DispatchBody): string {
  if (d.state === "running") return "is running now";
  if (d.state === "waiting") return d.stoppedEarly?.at(-1)?.readmitted === true && d.outcome === undefined ? "is waiting to go on from its checkpoint after its last turn stopped early" : "is waiting to start or to go on";
  if (d.state === "parked") {
    const jobs = d.waitsOnJobs ?? [];
    return jobs.length > 0 ? `is waiting for ${jobs.length} job(s) of the task to end (it is woken when one does)` : "is waiting for an approval of a call it made";
  }
  const o = d.outcome;
  if (o === undefined) return "ended, with no outcome on record";
  const words = o.status === "succeeded" ? "ended as succeeded"
    : o.status === "failed" ? "failed"
    : o.status === "stopped-early" ? "ended stopped early: the agent kept stopping before it said its work was done"
    : "was ended without finishing (abandoned: stopped, or its own ending said so)";
  return `${words} at ${o.at}`;
}

/** The two lines of one attempt. `n` numbers it among the task's attempts on record, oldest first. */
export function attemptEndingLines(d: DispatchBody, n: number): [string, string] {
  const started = d.startedAt === undefined ? `claimed ${d.claimedAt}, not started` : `started ${d.startedAt}`;
  const says = "; its ending says (quoted): ";
  // The ending summary is quoted in the room the line has left, so the quotation is always closed (a cut of the whole line could end it inside an escape or the quote). The rest of the line is cut first when it would leave
  // the quotation less than its least room (second review: names full of escaped characters filled the line, and the line's own cut then fell inside the quotation).
  const bare = clip(`Attempt ${n} (${shown(d.attemptId, 60)}), agent ${shown(d.agentId.replace(/^agent:/, ""), 60)} on route ${shown(d.route, 80)} as ${shown(d.role, 40)}: ${started}; it ${howItEnded(d)}`, ATTEMPT_ENDINGS_LIMITS.head - says.length - QUOTE_MIN - 3);
  const head = d.state !== "finished" || d.outcome === undefined ? `${bare}.` : `${bare}${says}${quoted(d.outcome.summary, Math.min(200, ATTEMPT_ENDINGS_LIMITS.head - bare.length - says.length - 3))}.`;
  const parts: string[] = [];
  const last = d.turnEnd;
  const lastPlan = last?.plan ?? d.stoppedEarly?.at(-1)?.plan;
  parts.push(last === undefined ? "No turn of it has ended yet that the controller recorded." : `Its last turn: ${endKindWords(last.endKind)}${last.visibleChars === undefined ? "" : ` (${last.visibleChars} visible characters)`}, at ${last.at}.`);
  parts.push(`Nudges to go on: ${d.nudgesUsed ?? 0}${last?.nudges === undefined ? "" : ` (${last.nudges} in its last turn)`}.`);
  parts.push(`Plan: ${planWords(lastPlan)}.`);
  const early = d.stoppedEarly ?? [];
  if (early.length > 0) {
    const went = early.filter((r) => r.readmitted).length;
    parts.push(`It stopped before saying its work was done ${early.length} time(s) (${early.map((r) => endKindWords(r.endKind).replace(/ \(.*\)$/, "")).join("; ")}); it went on from its checkpoint ${went} time(s) of the ${STOPPED_EARLY_READMITS} allowed.`);
  }
  const v = d.verifications?.at(-1);
  if (v !== undefined) {
    const verdict = v.state === "passed" ? "passed" : v.state === "failed" ? `did not pass (${v.failures.length} thing(s) failed)` : `could not be made (${v.failures.length} thing(s) not looked at)`;
    parts.push(`Its done was checked against the task contract ${d.verifications!.length} time(s); the last check ${verdict}.`);
  }
  const r = d.report;
  const q = d.interrogation;
  if (r !== undefined) {
    const asked = r.questioning === "supported" ? "a second agent questioned it and found it supported"
      : r.questioning === "unsupported" ? "a second agent questioned it and found it not supported"
      : r.questioning === "not-run" ? "no second agent questioned it (none could be asked)"
      : "it was not questioned (only a done is)";
    parts.push(`It ended with a report (${shown(r.result, 20)}); ${asked}. The report's text is in the task's work report.`);
  } else if (q !== undefined) {
    parts.push(q.state === "asking" ? "A second agent is questioning its done." : q.state === "unsupported" ? `A second agent found its done not supported${q.exhausted === true ? " and its go-ons are used up" : ""}.` : q.state === "supported" ? "A second agent found its done supported." : "No second agent could question its done.");
  } else parts.push("It has no report yet.");
  if ((d.wakeRound ?? 0) > 0) parts.push(`A job's end woke it ${d.wakeRound} time(s).`);
  const blocker = endingBlocker(d);
  parts.push(blocker === undefined ? "It left no blocker." : `It left a blocker, ${blocker}: ${ENDING_BLOCKER_WORDS[blocker]}.`);
  return [clip(head, ATTEMPT_ENDINGS_LIMITS.head), clip(parts.join(" "), ATTEMPT_ENDINGS_LIMITS.detail)];
}

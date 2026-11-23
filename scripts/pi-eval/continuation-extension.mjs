// Card W04, bench variant C: the bounded continuation of NimbleNewt's worker, as a Pi command-line extension (loaded by
// pi-agent.mjs with `-e` when the run has a continuation config). The worker installs Pi Durable's `onYield` hook
// (packages/pi-adapter/src/continuation.ts: at most 3 continuations per turn, then the answer stands); the Pi command line has
// no such hook, so this is the same decision at Pi's own last boundary, `agent_before_settle`: when the run is about to end,
// it appends the nudge as a user-role message and asks for one more provider request (`continue: true`), at most `max` times.
//
// No nudge (the answer stands) when: the bound is used up; the last reply was cut by an error or an abort (Pi's hard exits);
// or the last reply is a report that states its result as done, partial or blocked (variant B's ending, the stand-in of an
// accepted work.end, after which the worker gives none either). Everything else is a stop before the work ended: no reply,
// thinking only, an announced next step, a reply cut at the output limit, or prose that states no result.
//
// The words come from the runner (PI_EVAL_CONTINUATION_CONFIG, a JSON file the runner wrote from the built pi-adapter:
// { max, mark, nudge, lengthNudge }), so they are the worker's own. Counts only, never content: PI_EVAL_CONTINUATION_FILE
// (beside the log) holds { max, nudges, lengthNudges, endedByReport, errors }, written at load and after every decision;
// the runner copies it into the run record. It never throws.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { addEvent, newSummary, reportEndsWork } from "./lib/classify.mjs";

export const CONTINUATION_CUSTOM_TYPE = "nimblenewt-continuation";

/** Reads and checks the config file; a bad one is an error the caller reports (the extension then continues nothing). */
export function readConfig(file) { return checkConfig(JSON.parse(readFileSync(file, "utf8"))); }

export function checkConfig(c) {
  if (c === null || typeof c !== "object") throw new TypeError("continuation config must be an object");
  if (!Number.isSafeInteger(c.max) || c.max < 0 || c.max > 10) throw new RangeError("continuation max must be a whole number from 0 to 10");
  for (const k of ["mark", "nudge", "lengthNudge"]) if (typeof c[k] !== "string" || c[k].trim() === "") throw new TypeError(`continuation config: ${k} is required`);
  return c;
}

/** The extension's state and handlers, apart from Pi (tests drive them with a fake runner). */
export function createContinuation({ config = process.env.PI_EVAL_CONTINUATION_CONFIG, file = process.env.PI_EVAL_CONTINUATION_FILE } = {}) {
  const counts = { max: 0, nudges: 0, lengthNudges: 0, endedByReport: false, errors: 0 };
  const summary = newSummary();
  let cfg = null;
  try {
    cfg = typeof config === "object" && config !== null ? checkConfig(config) : readConfig(config);
    counts.max = cfg.max;
  } catch { counts.errors++; }
  const save = () => {
    if (!file) return;
    try {
      writeFileSync(`${file}.tmp`, `${JSON.stringify(counts)}\n`);
      renameSync(`${file}.tmp`, file);
    } catch { /* a record that cannot be written must not stop the run */ }
  };
  const onMessageEnd = (event) => {
    try { if (event?.message?.role === "assistant") addEvent(summary, { type: "message_end", message: event.message }); } catch { counts.errors++; save(); }
  };
  const onBeforeSettle = (event) => {
    try {
      if (cfg === null || counts.nudges >= cfg.max) return undefined;
      const last = summary.last;
      if (last === null || last.stopReason === "error" || last.stopReason === "aborted") return undefined;
      if (reportEndsWork(summary)) { counts.endedByReport = true; save(); return undefined; }
      const length = last.stopReason === "length";
      counts.nudges++;
      if (length) counts.lengthNudges++;
      save();
      return { entries: [...(event?.entries ?? []), { type: "custom_message", customType: CONTINUATION_CUSTOM_TYPE, content: `${cfg.mark} ${length ? cfg.lengthNudge : cfg.nudge}`, display: false }], continue: true };
    } catch {
      try { counts.errors++; save(); } catch { /* nothing more to do */ }
      return undefined;
    }
  };
  save();
  return { counts, onMessageEnd, onBeforeSettle };
}

export default function continuationExtension(pi) {
  const { onMessageEnd, onBeforeSettle } = createContinuation();
  pi.on("message_end", onMessageEnd);
  pi.on("agent_before_settle", onBeforeSettle);
}

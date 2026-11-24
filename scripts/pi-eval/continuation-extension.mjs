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
// (beside the log) holds { configured, max, nudges, lengthNudges, endedByReport, errors }, written at load and after every
// decision (configured: the config was read and checked; without it nothing is continued);
// the runner copies it into the run record. It never throws.
import { closeSync, fstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { CONTINUATION_CUSTOM_TYPE, addEvent, newSummary, reportEndsWork } from "./lib/classify.mjs";

export { CONTINUATION_CUSTOM_TYPE };

/**
 * The bench's wording for the Pi command line (card W04, nudge fix). The Pi command line has no nimblenewt__work-end tool (variant
 * B's prompt says so and asks for a final report instead), and the worker's nudge says to end with that tool as the last call: a
 * bench agent that read this hunted for the tool (its environment, the results folder, ~/.pi/agent/mcp.json). So where this
 * extension is loaded the nudge names the ending the agent does have: a final report whose first line states the result
 * (done, partial or blocked), the wording the bench's prompt and the classifier's result check (lib/classify.mjs) use.
 * Everything else of the worker's text is kept, and the worker's own text (packages/pi-adapter/src/worker/nudge.ts) is not
 * touched: the two phrases are replaced in the text the runner read from the built pi-adapter, and a worker text that no
 * longer has them is an error here (never a silent pass-through), as is a result that still names the tool.
 */
export const COMMAND_LINE_WORDING = "command-line";
const WORK_END = "nimblenewt__work-end";
const COMMAND_LINE_REPLACEMENTS = [
  [`end with ${WORK_END} as your last call`, "end with a final report whose first line states the result (done, partial or blocked)"],
  [`end with ${WORK_END} with result blocked or partial and say why in the report`, "end with a final report whose first line states the result blocked or partial and says why"],
  ["A reply without a tool call does not end the work.", "A reply that is not a final report does not end the work."],
];
export function commandLineText(text) {
  let out = text;
  for (const [from, to] of COMMAND_LINE_REPLACEMENTS) {
    if (!out.includes(from)) throw new Error(`the worker's nudge no longer has the phrase the command-line wording replaces: ${JSON.stringify(from)}`);
    out = out.split(from).join(to);
  }
  if (/work[-._]end/i.test(out)) throw new Error("the command-line nudge still names the work.end tool");
  return out;
}
/** The config with the command-line wording (both nudge texts), and which wording it is. */
export function commandLineConfig(config) {
  return { ...checkConfig(config), nudge: commandLineText(config.nudge), lengthNudge: commandLineText(config.lengthNudge), wording: COMMAND_LINE_WORDING };
}

/**
 * The run's settings, handed over by pi-agent.mjs on a descriptor instead of the environment (an agent that lists its
 * environment finds nothing of the bench's folders): a file, already unlinked, opened for reading as descriptor 3 of this
 * process. Taken only if that descriptor is a regular file holding the bench's JSON { kind, config, file }, so nothing else
 * that happens to be open there (a Node-internal descriptor) is read or closed. Returns null otherwise; never throws.
 */
export const CHANNEL_KIND = "pi-eval-continuation-channel";
export function readChannel(fd = 3) {
  try {
    if (!fstatSync(fd).isFile()) return null;
    const c = JSON.parse(readFileSync(fd, "utf8"));
    if (c === null || typeof c !== "object" || c.kind !== CHANNEL_KIND) return null;
    try { closeSync(fd); } catch { /* the descriptor stays open */ }
    return c;
  } catch { return null; }
}

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
  const counts = { configured: false, max: 0, nudges: 0, lengthNudges: 0, endedByReport: false, errors: 0 };
  const summary = newSummary();
  let cfg = null;
  try {
    cfg = typeof config === "object" && config !== null ? checkConfig(config) : readConfig(config);
    counts.max = cfg.max;
    counts.configured = true;
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
      // Pi's own reading of the run (completed, aborted, error): an abort or an error is a hard exit, whatever the last reply was.
      if (event?.outcome === "error" || event?.outcome === "aborted") return undefined;
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
  const channel = readChannel();
  const { onMessageEnd, onBeforeSettle } = createContinuation(channel ? { config: channel.config, file: channel.file } : undefined);
  pi.on("message_end", onMessageEnd);
  pi.on("agent_before_settle", onBeforeSettle);
}

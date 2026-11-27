// Card W09: the W01 bench run through NimbleNewt's real worker and controller (lib/worker-embedder.mjs) instead of the Pi command line, on the Radiance route, with the model calls through the controller's relay.
//
// A run: a fresh repository at the task's base commit with the held-back tests out of it (as the command-line bench makes it) becomes the project's repository; the product host makes the task's checkout from it
// (tracked files only; the bench copies the installed dependencies in before the attempt starts); the agent works in the worker's sandbox; the controller checks its done (the contract's check: the build) and the
// second agent questions its report; when the attempt has finished, the acceptance suite is copied into the agent's checkout and run there, and the run is classified from the CONTROLLER'S records plus that suite.
//
// What differs from the command line, on purpose:
//   - A verified finish needs the whole chain the card names: a work.end done the controller verified (its check passed), a report the second agent found supported, and the acceptance suite passing on the work. A done
//     recorded without a supported questioning (none was asked, the route failed, the cap) is NOT a finish: the run is `unclassified`, which fails the "no silent non-finish" gate (fail closed).
//   - The completion rules (card W06) are always the worker's system prompt, so no worker variant's task text carries {{COMPLETION_RULES}} (a template that does is refused). W03's readmit on the stored conversation is always
//     on. The continuation (W04) is the only part a variant turns off: for A and B the host's bridge refuses `turn.continue`, which the worker reads as no nudge.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planProgress } from "./classify.mjs";
import { copyAcceptance, copyHidden, expandCopy, git, prepareCheckout, runHiddenTests, runSuite } from "./runner.mjs";
import { withSlot } from "./slot.mjs";
import { aggregate, gatesFor, renderReport } from "./stats.mjs";
import { COMPLETION_RULES_PLACEHOLDER } from "./taskset.mjs";
import { attemptSummary, dailySpendOf, MEASURE_LIMITS, msStats, openW09Installation, radianceOnlyFetch, runW09Task, RADIANCE_KIND } from "./worker-embedder.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const promptOf = (name) => join(here, "..", "prompts", name);

/** The controller's bound on a task's description (packages/controller/src/domain/model.ts LIMITS.description). A rendered task text over it is refused before anything starts. */
export const DESCRIPTION_MAX = 8000;
/** Where the agent's checkout is inside the worker's sandbox. */
export const SANDBOX_CHECKOUT = "/work";
/** The Node.js the sandbox mounts (scripts/local-host.mjs: the host's Node install at /opt/node). */
export const SANDBOX_NODE = "/opt/node/bin/node";

/**
 * The bench's variants on the real worker. `nudges: false` is the host's bridge refusing `turn.continue`. D's "relaunch on the stored session" is W03's readmit, which the worker always does (in every variant), so C and D
 * are one configuration: D is run under its own name as the shipped worker, and the release gate is judged on it.
 */
export const WORKER_VARIANTS = Object.freeze({
  A: Object.freeze({ prompt: promptOf("worker-a.md"), nudges: false, about: "the plain task text; no continuation (the bench refuses turn.continue); the worker's completion rules and W03 readmits as always" }),
  B: Object.freeze({ prompt: promptOf("worker-b.md"), nudges: false, about: "the task text that points at the completion rules of the system prompt; no continuation" }),
  C: Object.freeze({ prompt: promptOf("worker-b.md"), nudges: true, about: "B plus W04's continuation (at most 3 nudges a turn), as the worker ships it" }),
  D: Object.freeze({ prompt: promptOf("worker-b.md"), nudges: true, sameAs: "C", about: "C plus W03's readmit on the stored conversation: the shipped worker (the readmit is on in every worker variant, so D is C's configuration)" }),
});
export const SHIPPED_VARIANT = "D";

/** The task text the controller is given as the task's description. Refuses a template with the completion rules in it (the worker sends them as the system prompt) and a text over the controller's bound. */
export function renderWorkerPrompt(template, { task, taskText }) {
  if (template.includes(COMPLETION_RULES_PLACEHOLDER)) throw new Error("a worker variant's task text must not carry {{COMPLETION_RULES}}: the worker sends the completion rules as the agent's system prompt");
  const text = template.replaceAll("{{TASK_ID}}", task.id).replaceAll("{{WORKTREE_URL}}", `file://${SANDBOX_CHECKOUT}`).replaceAll("{{WORKTREE}}", SANDBOX_CHECKOUT).replace("{{TASK}}", () => taskText.trim()).trim();
  if (text.length > DESCRIPTION_MAX) throw new Error(`the task text of ${task.id} is ${text.length} characters, over the controller's ${DESCRIPTION_MAX}-character task description`);
  return text;
}

/** The task's title as the controller gets it (at most 200 characters). */
export const workerTitle = (task) => `${task.id}: ${String(task.title ?? task.id)}`.slice(0, 200);

/** The contract's check of a done: the task's own setup build, run by the host in the attempt's sandbox with the sandbox's Node.js. None when the task has no build. */
export function buildCheck(task, timeoutSeconds = 1800) {
  const argv = task.setup?.argv;
  if (!Array.isArray(argv) || argv.length === 0) return [];
  return [{ name: "the build", run: argv.map((a, i) => (i === 0 && a === "node" ? SANDBOX_NODE : String(a))), timeoutSeconds }];
}

/**
 * W09 fixes: the done's checks of a task, the build first and then the task's own package tests when it declares them (`doneTests` in the task set: test files visible in the task's checkout, relative to its root, run with the
 * sandbox's Node.js after the build). The held-out tests are never among them: the task set refuses a `doneTests` entry that names one (lib/taskset.mjs), and they are only copied into the checkout after the attempt has ended.
 */
export function doneChecks(task, timeoutSeconds = 1800) {
  const checks = buildCheck(task, timeoutSeconds);
  const tests = Array.isArray(task.doneTests) ? task.doneTests : [];
  if (tests.length === 0) return checks;
  return [...checks, { name: "the task's package tests", run: [SANDBOX_NODE, "--test", ...tests.map(String)], timeoutSeconds }];
}

/**
 * Whether the tools offered to the agent include one that reads or changes files or runs a command in its checkout: Pi's own (read, write, edit, bash) or a catalogue tool by the names the approval policy classifies
 * (packages/controller/src/policy/catalog.ts), or the bridge's own checkout tool (card W09b, `nimblenewt__work-checkout`: read, write, edit and run in the checkout's sandbox). Before W09b the worker offered only the other bridge tools,
 * so this was false and a coding task could not be done there (see the W09 notes).
 */
export function offersFileTools(names) {
  const FILE = /^(?:read|write|edit|bash|multi-?edit|read-file|write-file|edit-file|list-files|search-files|grep|run-script|shell|exec|work-checkout)$/i;
  return names.some((n) => FILE.test(String(n).replace(/^.*__/, "")));
}

/** A line for a batch's report when some runs' agents were offered no file tool (or the count was not seen). */
export function fileToolsLine(records) {
  const seen = records.filter((x) => x.worker?.agentTools !== null && x.worker?.agentTools !== undefined);
  const none = seen.filter((x) => x.worker.fileTools !== true);
  if (none.length === 0) return null;
  return `WARNING: in ${none.length} of ${seen.length} run(s) the agent was offered no tool that reads or changes files or runs a command (offered: ${[...new Set(none.flatMap((x) => x.worker.agentTools))].sort().join(", ").slice(0, 600) || "none"}); a coding task cannot be finished that way`;
}

/** The bridge filter of a variant: undefined when the continuation is on; otherwise one that refuses `turn.continue` only. */
export function bridgeFilterFor(variant) {
  if (variant.nudges !== false) return undefined;
  return (_order, request) => (request?.op === "turn.continue" ? { ok: false, code: "unavailable", message: "this bench variant runs without the continuation" } : undefined);
}

/**
 * A worker run's outcome, from the controller's records (`attemptSummary`) and the acceptance suite. The outcome names are the W01 bench's (lib/classify.mjs OUTCOMES), so the gates and the report read them unchanged.
 * Fail closed: only a done the controller verified, with a report the second agent found supported, whose work passes the acceptance suite, is a verified finish.
 * W09 fixes: every outcome also names its cause (`cause`, one of WORKER_CAUSES, with the second agent's own cause after `second-agent-`), so no run ends without one. The causes change no outcome and no gate: an `unclassified`
 * run still fails the "no silent non-finish" gate; it now says why.
 */
export const WORKER_CAUSES = Object.freeze(["verified", "wall-limit", "no-attempt", "not-finished", "false-done", "interface-mismatch", "uncalibrated", "check-not-passed", "second-agent", "reply-cut-not-raised", "reply-cut-below-ceiling", "reply-cut-at-ceiling", "empty-reply", "early-stops-used-up", "ended-partial", "ended-blocked", "ended-abandoned", "done-refused", "ended-otherwise", "bench-error", "server-unavailable"]);

/** The second agent's part of a cause: `second-agent-<the controller's cause>`, or its questioning state when no cause was recorded. */
const secondAgentCause = (attempt) => `second-agent-${String(attempt.questioningCause ?? attempt.questioning ?? "none").replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`;

/** The reply-cut cause and words of a run whose last reply was cut off at the output limit. */
function replyCutOutcome(attempt) {
  const r = attempt.replyCut ?? null;
  if (r === null) return { cause: "reply-cut-not-raised", words: "the worker did not say it raised its reply limit" };
  return { cause: r.limit >= r.ceiling ? "reply-cut-at-ceiling" : "reply-cut-below-ceiling", words: `${r.cuts} reply(ies) cut with no visible text; the reply limit was ${r.limit} tokens of a ceiling of ${r.ceiling}` };
}

export function classifyWorkerRun({ attempt, hidden, changed, timedOut = false }) {
  const out = (outcome, reason, cause) => ({ outcome, reason, cause, claimsDone: attempt?.reportResult === "done" && attempt?.status === "succeeded" });
  if (timedOut) return out("timeout", "the attempt had not finished at the run's wall-clock limit", "wall-limit");
  if (attempt === null || attempt === undefined) return out("error", "the controller started no attempt for the task", "no-attempt");
  if (attempt.state !== "finished") return out("error", `the attempt is ${attempt.state ?? "unknown"}, not finished`, "not-finished");
  const done = attempt.status === "succeeded" && attempt.reportResult === "done";
  const notRun = attempt.questioningWhy ? `; why: ${attempt.questioningWhy}` : "";
  if (done) {
    const verified = attempt.verifications.at(-1) === "passed";
    if (hidden?.passed !== true) {
      if (hidden?.interfaceMismatch === true) return out("interface-mismatch", "a done was recorded and the acceptance tests do not type-check against the work", "interface-mismatch");
      return out("wrong", `a done was recorded${verified ? "" : " without a passed check"}${attempt.questioning === "supported" ? "" : ` and no second agent accepted its report (${attempt.questioning ?? "none"}${notRun})`} and the acceptance tests fail`, "false-done");
    }
    if (!changed) return out("error", "the acceptance tests pass on an unchanged checkout: the task is not calibrated", "uncalibrated");
    if (!verified) return out("unclassified", `a done was recorded and the acceptance tests pass, but the controller's check of the done did not pass (${attempt.verifications.join(", ") || "never checked"}): not a verified finish`, "check-not-passed");
    if (attempt.questioning !== "supported") return out("unclassified", `a done was recorded and the acceptance tests pass, but no second agent accepted its report (questioning ${attempt.questioning ?? "none"}${attempt.questioningCause ? `, cause ${attempt.questioningCause}` : ""}${notRun}): not a verified finish (fail closed)`, secondAgentCause(attempt));
    return out("verified-finish", "a verified work.end done, a report the second agent found supported, and the acceptance tests pass on the work", "verified");
  }
  if (attempt.endKind === "length") { const c = replyCutOutcome(attempt); return out("length", `the attempt ended ${attempt.status}, its last reply cut off at the output limit (${c.words})`, c.cause); }
  if (attempt.endKind === "empty-visible-text") return out("empty", `the attempt ended ${attempt.status} on a reply with no visible text`, "empty-reply");
  if (attempt.status === "stopped-early") return out("stopped-early", `the agent kept stopping before it said its work was done; its ${attempt.readmitted} readmit(s) were used up`, "early-stops-used-up");
  if (attempt.reportResult === "partial" || attempt.reportResult === "blocked" || attempt.reportResult === "abandoned") return out("stopped-early", `the agent ended ${attempt.reportResult} with a report: ${attempt.summary.slice(0, 200)}`, `ended-${attempt.reportResult}`);
  if (attempt.reportResult === "done") return out("stopped-early", `the agent's done was refused (the check or the second agent) until its go-ons were used up: ${attempt.summary.slice(0, 200)}`, "done-refused");
  return out("error", `the attempt ended ${attempt.status ?? "without an outcome"}: ${attempt.summary.slice(0, 200)}`, "ended-otherwise");
}

/**
 * W09 bench measurement: the model calls of one run, as the run's one fetch saw them, per role (`agent`: the streamed calls through the relay; `second`: the second agent's). `add` takes what the fetch tells (a call not sent is
 * ignored); `result` gives per role the calls sent, their durations (median, 95th percentile, largest, total, and the figures themselves up to `MEASURE_LIMITS.samples`), the provider's token counts summed, the calls with a 2xx
 * reply that stated none (`uncounted`), the outages, and whether the run's last sent call was an outage.
 */
export function callLog() {
  const roles = { agent: { ms: [], tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 }, counted: 0, uncounted: 0, outages: 0 }, second: { ms: [], tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 }, counted: 0, uncounted: 0, outages: 0 } };
  let last = null;
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  return {
    add(c) {
      if (c === null || typeof c !== "object" || c.sent !== true) return;
      const r = roles[c.streamed === true ? "agent" : "second"];
      r.ms.push(c.ms);
      if (c.outage === true) r.outages++;
      if (c.usage !== null && typeof c.usage === "object") { r.counted++; for (const k of Object.keys(r.tokens)) r.tokens[k] = Math.min(Number.MAX_SAFE_INTEGER, r.tokens[k] + count(c.usage[k])); } else if (c.ok === true) r.uncounted++;
      last = { role: c.streamed === true ? "agent" : "second", outage: c.outage === true };
    },
    result() {
      const one = (r) => ({ sent: r.ms.length, ...msStats(r.ms), ms: r.ms.slice(0, MEASURE_LIMITS.samples).map((x) => (Number.isFinite(x) ? Math.round(x) : null)), ...(r.ms.length > MEASURE_LIMITS.samples ? { msTruncated: true } : {}), tokens: { ...r.tokens }, counted: r.counted, uncounted: r.uncounted, outages: r.outages });
      return { agent: one(roles.agent), second: one(roles.second), lastCall: last };
    },
  };
}

/** The run's token use (input, output, cache read, reasoning: the provider's own counts over every sent call) and whether it is unknown: no call was sent, or a 2xx reply stated no counts (the batch budget's rule, lib/batch.mjs). */
export function tokensOfCalls(calls) {
  const t = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };
  for (const r of [calls.agent, calls.second]) for (const k of Object.keys(t)) t[k] = Math.min(Number.MAX_SAFE_INTEGER, t[k] + r.tokens[k]);
  return { tokens: t, unknown: calls.agent.sent + calls.second.sent === 0 || calls.agent.uncounted + calls.second.uncounted > 0 };
}

/**
 * W09 bench measurement: a run whose last sent model call was a server outage (`lib/worker-embedder.mjs` OUTAGE_STATUSES, or no connection) and that is a non-finish without a recorded done gets the cause `server-unavailable`, with
 * the cause it would have had kept as `causeOtherwise`. The OUTCOME is never changed, so the run counts in every gate exactly as before (a non-finish stays one, an unclassified run still fails the "no silent non-finish" gate). A verified
 * finish, a false done and an interface mismatch keep their cause: the outage did not make them.
 */
export function withOutageCause(classified, calls) {
  const keep = ["verified-finish", "wrong", "interface-mismatch"];
  if (calls?.lastCall?.outage !== true || keep.includes(classified.outcome)) return classified;
  return { ...classified, cause: "server-unavailable", causeOtherwise: classified.cause ?? null, reason: `${classified.reason}; the run's last model call found the server unavailable` };
}

/**
 * Informational lines (never a gate): per variant with runs whose cause is `server-unavailable`, its gate figures again over the runs without them, labelled as such. The gates above them, and the release blocker's verdict, still count
 * every run. Null when no run has that cause.
 */
export function outagesLines(records) {
  const out = records.filter((x) => x.cause === "server-unavailable");
  if (out.length === 0) return null;
  const lines = [];
  for (const v of [...new Set(out.map((x) => String(x.variant ?? "?")))].sort()) {
    const n = out.filter((x) => String(x.variant ?? "?") === v).length;
    const rest = records.filter((x) => String(x.variant ?? "?") === v && x.cause !== "server-unavailable");
    const g = gatesFor(v, aggregate(rest));
    lines.push(`informational, NOT the gate: variant ${v} without its ${n} server-unavailable run(s) (the gate counts them as non-finishes): ${g.lines.join("; ")}`);
  }
  return lines;
}

/** A line per run (at most 50) with its model calls' times and tokens and its checkout tool time (W09 bench measurement); null when no run has them. */
export function callsLines(records) {
  const f = (s) => (s === null || s === undefined ? "-" : `${s} ms`);
  const rows = records.filter((x) => x.calls !== undefined && x.calls !== null).slice(0, 50).map((x) => {
    const c = x.calls; const tt = x.worker?.toolTime ?? null;
    const tool = tt === null ? "tool time not read" : Object.entries(tt).map(([k, v]) => `${k} ${v.calls} call(s) ${v.totalMs} ms`).join(", ") || "no tool calls";
    const spend = x.dailySpend?.tokens === undefined || x.dailySpend?.tokens === null ? "daily-cap record not read" : `daily-cap record ${x.dailySpend.tokens} tokens in ${x.dailySpend.calls} call(s) on ${x.dailySpend.day}`;
    return `- ${x.runId}: agent ${c.agent.sent} call(s), median ${f(c.agent.medianMs)}, p95 ${f(c.agent.p95Ms)}; second agent ${c.second.sent} call(s), median ${f(c.second.medianMs)}, p95 ${f(c.second.p95Ms)}; tokens in ${x.tokens?.input ?? "-"} out ${x.tokens?.output ?? "-"}${x.tokensUnknown ? " (some unknown)" : ""}; ${spend}; ${tool}${c.agent.outages + c.second.outages > 0 ? `; ${c.agent.outages + c.second.outages} outage call(s)` : ""}`;
  });
  return rows.length === 0 ? null : ["model calls and tool time per run (informational):", ...rows];
}

/** A line naming how many runs ended with each cause (W09 fixes), for a batch's report; null when no run has one. */
export function causesLine(records) {
  const counts = new Map();
  for (const x of records) if (typeof x.cause === "string") counts.set(x.cause, (counts.get(x.cause) ?? 0) + 1);
  if (counts.size === 0) return null;
  return `causes: ${[...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([c, n]) => `${c} ${n}`).join(", ")}`;
}

/** What the agent changed in its checkout, read through the task's own git directory (the agent's PLAN.md not counted). */
export async function workerChanges({ checkout, gitDir }) {
  const g = (args) => git(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", `--git-dir=${gitDir}`, `--work-tree=${checkout}`, ...args], { cwd: checkout });
  const status = await g(["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude)PLAN.md"]);
  const stat = await g(["diff", "--stat", "HEAD"]);
  if (status.code !== 0) return { changed: false, dirty: false, diffStat: "", fullStat: "", error: status.stderr.trim().slice(0, 300) };
  return { changed: status.stdout.trim() !== "", dirty: status.stdout.trim() !== "", diffStat: stat.stdout.trim().split("\n").slice(-1)[0] ?? "", fullStat: stat.stdout.trim() };
}

/** Copies the task's installed dependencies (its `copy` patterns) from `from` into a fresh checkout, once (a readmit's start finds them there). */
export function dependencyCopier(from, patterns) {
  return async ({ checkout }) => {
    for (const rel of await expandCopy(from, patterns)) {
      const target = join(checkout, ...rel);
      if (existsSync(target)) continue;
      await mkdir(dirname(target), { recursive: true });
      await cp(join(from, ...rel), target, { recursive: true, verbatimSymlinks: true, force: true });
    }
  };
}

/**
 * One run of one task in one variant through the real worker. Returns the result record (the caller appends it to the worker results file).
 * ctx: { set, repo, depsFrom, workRoot, resultsDir, root, batchId, benchCommit, radiance: { baseUrl, apiKey?, model, contextTokens, maxTokens?, reasoningTokens? }, fetch?, keep, log, testSlot?, timeoutMinutes?, start?, load? }.
 */
export async function runWorkerOne(ctx, task, variantName, repeat, { beforeAgent } = {}) {
  const variant = WORKER_VARIANTS[variantName];
  if (variant === undefined) throw new Error(`no worker variant ${variantName}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const runId = `${task.id}-W${variantName}-r${repeat}-${stamp}`;
  const dir = join(ctx.workRoot, `eval-${runId}`);
  const nnDir = join(ctx.workRoot, `eval-${runId}-nn`);
  const artifacts = join(ctx.resultsDir, "runs", runId);
  await mkdir(artifacts, { recursive: true });
  const r = ctx.radiance;
  const record = {
    runId, batchId: ctx.batchId, card: "W09", agent: "nimblenewt-worker", taskId: task.id, size: task.size, variant: variantName, repeat, base: task.base, solution: task.solution, benchCommit: ctx.benchCommit,
    route: { provider: "radiance", model: r.model, kind: RADIANCE_KIND, via: "controller model relay", contextTokens: r.contextTokens, ...(r.maxTokens === undefined ? {} : { maxTokens: r.maxTokens }), ...(r.reasoningTokens === undefined ? {} : { reasoningTokens: r.reasoningTokens }) },
    workerVariant: { nudges: variant.nudges, readmits: true, completionRules: "system prompt", ...(variant.sameAs === undefined ? {} : { sameAs: variant.sameAs }) },
    startedAt: null, endedAt: null, wallMs: null, timedOut: false, nudges: 0, artifacts, contaminated: false, isolation: "the worker's own sandbox (bubblewrap, no network, the checkout at /work)",
  };
  const log = (m) => ctx.log?.(`[${runId}] ${m}`);
  let inst;
  const requests = { agent: 0, second: 0, refused: 0 };
  let agentTools = null;
  const calls = callLog();
  let spendRead = false;
  try {
    const template = await readFile(variant.prompt, "utf8");
    const description = renderWorkerPrompt(template, { task, taskText: await readFile(task.promptPath, "utf8") });
    await writeFile(join(artifacts, "prompt.md"), `${description}\n`);
    record.prompt = { sha256: createHash("sha256").update(description).digest("hex").slice(0, 16), chars: description.length };
    log(`preparing ${dir} at ${task.base.slice(0, 8)}`);
    await prepareCheckout({ repo: ctx.repo, commit: task.base, dir, copy: task.copy, depsFrom: ctx.depsFrom, forbidden: [task.solution] });
    if (beforeAgent) {
      const g = await beforeAgent();
      if (!g.ok) { record.gateRefused = String(g.why ?? "refused"); throw new Error(`the Radiance gate refused the start: ${record.gateRefused}`); }
    }
    const fetch = radianceOnlyFetch({ baseUrl: r.baseUrl, fetch: ctx.fetch ?? globalThis.fetch, onCall: (c) => { calls.add(c); if (c.sent === false) return; if (c.streamed) { requests.agent++; if (agentTools === null) agentTools = [...c.tools].sort(); } else requests.second++; }, onRefused: () => { requests.refused++; } });
    inst = await openW09Installation({
      root: ctx.root, dataDir: join(nnDir, "data"), baseUrl: r.baseUrl, model: r.model, contextTokens: r.contextTokens, ...(r.maxTokens === undefined ? {} : { maxTokens: r.maxTokens }), ...(r.reasoningTokens === undefined ? {} : { reasoningTokens: r.reasoningTokens }),
      ...(r.apiKey === undefined ? {} : { apiKey: r.apiKey }), fetch, prepareCheckout: dependencyCopier(dir, task.copy ?? []), ...(bridgeFilterFor(variant) === undefined ? {} : { bridgeFilter: bridgeFilterFor(variant) }),
      ...(ctx.start === undefined ? {} : { start: ctx.start }), ...(ctx.load === undefined ? {} : { load: ctx.load }),
    });
    log(`agent started on the worker (limit ${ctx.timeoutMinutes ?? task.timeoutMinutes} min, variant ${variantName}: ${variant.about})`);
    record.startedAt = new Date().toISOString();
    const ran = await runW09Task(inst, { repository: dir, title: workerTitle(task), description, checks: doneChecks(task), timeoutMs: (ctx.timeoutMinutes ?? task.timeoutMinutes) * 60_000, tag: runId.slice(-24), ...(ctx.pollMs === undefined ? {} : { pollMs: ctx.pollMs }) });
    record.endedAt = new Date().toISOString();
    record.wallMs = ran.wallMs;
    record.timedOut = ran.timedOut;
    const summary = attemptSummary(ran.attempt);
    // Closed before grading: nothing of the agent runs while the acceptance tests do.
    await inst.close(); inst = undefined;
    record.dailySpend = ran.dailySpend ?? null; spendRead = true;
    record.worker = { attemptId: ran.attemptId ?? null, ...(summary ?? {}), requests, agentTools, fileTools: offersFileTools(agentTools ?? []), checkoutCalls: ran.checkoutCalls ?? null, toolTime: ran.toolTime ?? null };
    record.nudges = summary?.nudges ?? 0;
    log(`attempt ended after ${(ran.wallMs / 60000).toFixed(1)} min: ${summary?.status ?? "none"} (${summary?.reportResult ?? "-"}, questioning ${summary?.questioning ?? "-"})`);
    const plan = existsSync(join(ran.checkout, "PLAN.md")) ? planProgress(readFileSync(join(ran.checkout, "PLAN.md"), "utf8")) : null;
    const ch = existsSync(ran.checkout) ? await workerChanges(ran) : { changed: false, dirty: false, diffStat: "", fullStat: "" };
    await writeFile(join(artifacts, "diffstat.txt"), `${ch.fullStat}\n`);
    let hidden = null, shipped = null;
    if (existsSync(ran.checkout)) {
      await withSlot(ctx.testSlot ?? null, async () => {
        if (task.acceptance) {
          await copyAcceptance({ repo: ctx.repo, task, dir: ran.checkout });
          hidden = await runHiddenTests({ task, dir: ran.checkout, artifacts });
          await copyHidden({ repo: ctx.repo, solution: task.solution, files: task.hiddenFiles, dir: ran.checkout });
          const s = await runSuite({ task, suite: { hiddenFiles: task.hiddenFiles, testFiles: task.testFiles }, dir: ran.checkout, artifacts, prefix: "shipped" });
          shipped = { passed: s.passed, built: s.built, interfaceMismatch: s.interfaceMismatch, tests: s.tests, pass: s.pass, fail: s.fail };
        } else {
          await copyHidden({ repo: ctx.repo, solution: task.solution, files: task.hiddenFiles, dir: ran.checkout });
          hidden = await runHiddenTests({ task, dir: ran.checkout, artifacts });
        }
      }, { log });
    }
    Object.assign(record, withOutageCause(classifyWorkerRun({ attempt: summary, hidden, changed: ch.changed, timedOut: ran.timedOut }), calls.result()), { plan, changed: ch.changed, dirty: ch.dirty, diffStat: ch.diffStat, hidden, shipped });
  } catch (e) {
    Object.assign(record, { outcome: "error", reason: `bench error: ${String(e?.message ?? e).slice(0, 500)}`, cause: "bench-error", benchError: true });
  } finally {
    // W09 bench measurement: the calls and their tokens in every record, a bench error's too; the day's spend record read before the installation closes when the run did not read it.
    record.calls = calls.result();
    const used = tokensOfCalls(record.calls);
    record.tokens = used.tokens;
    if (used.unknown) record.tokensUnknown = true; else delete record.tokensUnknown;
    if (!spendRead) record.dailySpend = inst === undefined ? null : await dailySpendOf(inst);
    if (inst !== undefined) await inst.close().catch(() => undefined);
    if (!ctx.keep) {
      for (const d of [dir, nnDir]) {
        try { execFileSync("chmod", ["-R", "u+rwX", d], { stdio: "ignore" }); } catch { /* nothing to open */ }
        await rm(d, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
      }
    }
  }
  log(`=> ${record.outcome}: ${record.reason}`);
  return record;
}

/**
 * Card W09's release blocker: when the shipped variant's W01 gates do not hold over `records` (a size not measured fails too), a record of it with its results attached, written to `<resultsDir>/release-blockers/`
 * as JSON and as a short Markdown page. Returns the paths and the verdict, or `{ pass: true }` when the gates hold (nothing written).
 */
export async function releaseBlocker({ records, resultsDir, batchId, benchCommit, route, shipped = SHIPPED_VARIANT, now = () => new Date().toISOString() }) {
  const mine = records.filter((x) => String(x.variant) === shipped);
  const verdict = gatesFor(shipped, aggregate(mine));
  if (verdict.pass) return { pass: true, verdict };
  const report = renderReport(mine, { title: `W09 release gate: variant ${shipped} on the real worker` });
  const blocker = {
    card: "W09", kind: "release-blocker", createdAt: now(), batchId, benchCommit, route, variant: shipped,
    why: `the W01 release gates do not hold for the shipped variant ${shipped} on the real worker`,
    failures: verdict.failures, gates: verdict.lines, ...(fileToolsLine(mine) === null ? {} : { fileTools: fileToolsLine(mine) }), ...(outagesLines(mine) === null ? {} : { informationalWithoutOutages: outagesLines(mine) }),
    results: mine.map((x) => ({ runId: x.runId, taskId: x.taskId, size: x.size, outcome: x.outcome, cause: x.cause ?? null, ...(x.causeOtherwise === undefined ? {} : { causeOtherwise: x.causeOtherwise }), reason: x.reason, attemptId: x.worker?.attemptId ?? null, questioning: x.worker?.questioning ?? null, questioningCause: x.worker?.questioningCause ?? null, questioningWhy: x.worker?.questioningWhy ?? null, replyCut: x.worker?.replyCut ?? null, verifications: x.worker?.verifications ?? [], nudges: x.nudges ?? 0, wallMs: x.wallMs, artifacts: x.artifacts })),
  };
  const dir = join(resultsDir, "release-blockers");
  await mkdir(dir, { recursive: true });
  const base = join(dir, `w09-${batchId}`);
  await writeFile(`${base}.json`, `${JSON.stringify(blocker, null, 2)}\n`);
  await writeFile(`${base}.md`, [`# Release blocker (card W09): ${blocker.why}`, "", `Batch ${batchId}, bench commit ${benchCommit}, route ${route.provider}/${route.model} (kind ${route.kind}).`, "", "Failures:", ...verdict.failures.map((f) => `- ${f}`), ...(causesLine(mine) === null ? [] : ["", causesLine(mine)]), ...(outagesLines(mine) === null ? [] : ["", ...outagesLines(mine)]), ...(blocker.fileTools === undefined ? [] : ["", blocker.fileTools]), "", report.text, "", `Results: ${base}.json`, ""].join("\n"));
  return { pass: false, verdict, json: `${base}.json`, md: `${base}.md` };
}

/** This checkout's commit (with +dirty when the bench's files differ from it), as the command-line bench records it. */
export function benchCommitOf(dir) {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() + (execFileSync("git", ["-C", dir, "status", "--porcelain", "--", "."], { encoding: "utf8" }).trim() ? "+dirty" : ""); } catch { return "unknown"; }
}

export const repoRootOf = (dir) => realpathSync(join(dir, "..", "..", ".."));

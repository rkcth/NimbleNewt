#!/usr/bin/env node
// Re-scores recorded runs with the current classifier, from each run's saved Pi log and what the run measured
// (hidden tests, PLAN.md, changes, timeout, exit). Use it after a rule in lib/classify.mjs changes.
//   node scripts/pi-eval/rescore.mjs [--results DIR] [--taskset FILE] [--write]
// Without --write it is a dry run: it prints each run whose outcome would change and a before/after table of outcomes.
// With --write it rewrites results.jsonl (the old file is kept as results.jsonl.bak, or results.jsonl.bak-<time> when that exists) with the new outcome, and the old
// one recorded as `rescoredFrom`. Nothing else is touched: logs and artifacts are only read.
// A run's artifacts are found at the recorded path, or under <results>/runs/<runId> when the results were moved.
// Runs recorded before the acceptance suites have no `interfaceMismatch` reading: it is taken from their saved
// hidden-setup.log (tsc errors, all in the task's hidden files).
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, OUTCOMES, summarizeLogFile } from "./lib/classify.mjs";
import { tscErrorFiles } from "./lib/runner.mjs";
import { loadTaskset } from "./lib/taskset.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The run's artifacts directory: as recorded, else beside the results it was read from. */
export function artifactsOf(r, resultsDir) {
  if (r.artifacts && existsSync(r.artifacts)) return r.artifacts;
  const moved = r.runId ? join(resultsDir, "runs", r.runId) : r.artifacts ? join(resultsDir, "runs", basename(r.artifacts)) : null;
  return moved && existsSync(moved) ? moved : null;
}

/** The hidden-test reading with `interfaceMismatch` filled in from the saved setup log when the record predates it. */
export function withInterfaceReading(hidden, artifacts, hiddenFiles) {
  if (hidden === undefined || hidden === null || hidden.interfaceMismatch !== undefined) return hidden;
  if (hidden.setupExitCode === null || hidden.setupExitCode === 0 || !artifacts || !hiddenFiles) return { ...hidden, interfaceMismatch: false };
  const log = join(artifacts, "hidden-setup.log");
  if (!existsSync(log)) return hidden;
  const files = tscErrorFiles(readFileSync(log, "utf8"));
  const own = new Set(hiddenFiles);
  return { ...hidden, typeErrorFiles: files.slice(0, 20), interfaceMismatch: files.length > 0 && files.every((f) => own.has(f)) };
}

export async function rescore(records, { resultsDir, tasks = new Map() } = {}) {
  const out = [];
  for (const r of records) {
    const artifacts = artifactsOf(r, resultsDir ?? "");
    const log = artifacts ? join(artifacts, "agent.jsonl") : null;
    // A bench error or a run with no saved log is left as recorded: there is nothing to read again.
    if (r.benchError || log === null || !existsSync(log) || r.hidden === undefined) { out.push(r); continue; }
    const hidden = withInterfaceReading(r.hidden, artifacts, tasks.get(r.taskId)?.hiddenFiles);
    const v = classify({ summary: await summarizeLogFile(log), hidden, plan: r.plan ?? null, changed: r.changed === true, dirty: typeof r.dirty === "boolean" ? r.dirty : null, timedOut: r.timedOut === true, exitCode: r.exitCode });
    out.push(v.outcome === r.outcome && v.reason === r.reason ? r : { ...r, ...v, hidden, rescoredFrom: { outcome: r.outcome, reason: r.reason, at: new Date().toISOString() } });
  }
  return out;
}

/** Outcome counts before and after, as a Markdown table (one row per outcome that occurs). */
export function beforeAfterTable(before, after) {
  const count = (rs) => Object.fromEntries(OUTCOMES.map((o) => [o, rs.filter((r) => r.outcome === o).length]));
  const b = count(before), a = count(after);
  const rows = OUTCOMES.filter((o) => b[o] > 0 || a[o] > 0).map((o) => `| ${o} | ${b[o]} | ${a[o]} |`);
  return ["| outcome | before | after |", "|---|---|---|", ...rows, `| total | ${before.length} | ${after.length} |`].join("\n");
}

async function main(argv) {
  const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const dir = resolve(arg("--results") ?? process.env.PI_EVAL_RESULTS ?? "/srv/code/worktrees-pi/eval-results");
  const file = join(dir, "results.jsonl");
  const records = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l)) : [];
  let tasks = new Map();
  try { tasks = new Map(loadTaskset(resolve(arg("--taskset") ?? join(here, "taskset.json"))).tasks.map((t) => [t.id, t])); } catch (e) { process.stderr.write(`taskset not read (${e.message.split("\n")[0]}): interface readings of old runs are skipped\n`); }
  const next = await rescore(records, { resultsDir: dir, tasks });
  let changed = 0;
  next.forEach((r, i) => { if (r !== records[i]) { changed++; process.stdout.write(`${r.runId}: ${records[i].outcome} -> ${r.outcome} (${r.reason})\n`); } });
  process.stdout.write(`${changed} of ${records.length} run(s) change\n\n${beforeAfterTable(records, next)}\n`);
  if (argv.includes("--write") && changed > 0) {
    // An earlier backup is never overwritten: a second one gets a time stamp.
    const bak = existsSync(`${file}.bak`) ? `${file}.bak-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}` : `${file}.bak`;
    copyFileSync(file, bak);
    // Written beside and renamed over, so an interrupted rewrite never leaves a half file.
    writeFileSync(`${file}.tmp`, next.map((r) => JSON.stringify(r)).join("\n") + "\n");
    renameSync(`${file}.tmp`, file);
    process.stdout.write(`rewrote ${file} (old copy ${bak})\n`);
  } else if (changed > 0) process.stdout.write("dry run: nothing written (--write rewrites results.jsonl)\n");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });

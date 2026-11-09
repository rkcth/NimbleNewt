#!/usr/bin/env node
// Re-scores recorded runs with the current classifier, from each run's saved Pi log and what the run measured
// (hidden tests, PLAN.md, changes, timeout, exit). Use it after a rule in lib/classify.mjs changes.
//   node scripts/pi-eval/rescore.mjs [--results DIR] [--write]
// Without --write it prints the runs whose outcome would change. With --write it rewrites results.jsonl (the old file is
// kept as results.jsonl.bak) with the new outcome, and the old one recorded as `rescoredFrom`.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, summarizeLogFile } from "./lib/classify.mjs";

export async function rescore(records) {
  const out = [];
  for (const r of records) {
    const log = r.artifacts ? join(r.artifacts, "agent.jsonl") : null;
    // A bench error or a run with no saved log is left as recorded: there is nothing to read again.
    if (r.benchError || log === null || !existsSync(log) || r.hidden === undefined) { out.push(r); continue; }
    const v = classify({ summary: await summarizeLogFile(log), hidden: r.hidden, plan: r.plan ?? null, changed: r.changed === true, timedOut: r.timedOut === true, exitCode: r.exitCode });
    out.push(v.outcome === r.outcome && v.reason === r.reason ? r : { ...r, ...v, rescoredFrom: { outcome: r.outcome, reason: r.reason, at: new Date().toISOString() } });
  }
  return out;
}

async function main(argv) {
  const dir = resolve(argv.includes("--results") ? argv[argv.indexOf("--results") + 1] : process.env.PI_EVAL_RESULTS ?? "/srv/code/worktrees-pi/eval-results");
  const file = join(dir, "results.jsonl");
  const records = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l)) : [];
  const next = await rescore(records);
  let changed = 0;
  next.forEach((r, i) => { if (r !== records[i]) { changed++; process.stdout.write(`${r.runId}: ${records[i].outcome} -> ${r.outcome} (${r.reason})\n`); } });
  process.stdout.write(`${changed} of ${records.length} run(s) change\n`);
  if (argv.includes("--write") && changed > 0) {
    copyFileSync(file, `${file}.bak`);
    // Written beside and renamed over, so an interrupted rewrite never leaves a half file.
    writeFileSync(`${file}.tmp`, next.map((r) => JSON.stringify(r)).join("\n") + "\n");
    renameSync(`${file}.tmp`, file);
    process.stdout.write(`rewrote ${file} (old copy ${file}.bak)\n`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });

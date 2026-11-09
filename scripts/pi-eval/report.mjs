#!/usr/bin/env node
// Report for the Pi completion bench (card W01): reads results.jsonl and prints the outcome table per variant and size,
// Wilson 95% intervals, the release gates and a PASS/FAIL line.
//   node scripts/pi-eval/report.mjs [--results DIR | --file results.jsonl] [--batch ID[,ID]] [--variants A,B] [--strict]
// --strict exits 1 when the gates fail. run.mjs prints the same report for the batch it ran.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReport } from "./lib/stats.mjs";

export function readResults(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try { out.push(JSON.parse(line)); } catch { /* a half-written last line is skipped */ }
  }
  return out;
}

function main(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (k === "strict") { o.strict = true; continue; }
    o[k] = argv[++i];
  }
  const dir = resolve(o.results ?? process.env.PI_EVAL_RESULTS ?? "/srv/code/worktrees-pi/eval-results");
  const file = resolve(o.file ?? join(dir, "results.jsonl"));
  let records = readResults(file);
  if (o.batch) { const b = new Set(o.batch.split(",")); records = records.filter((r) => b.has(r.batchId)); }
  if (o.variants) { const v = new Set(o.variants.split(",")); records = records.filter((r) => v.has(r.variant)); }
  const bench = records.filter((r) => r.benchError);
  const rep = renderReport(records, { title: `Pi completion bench (${file})` });
  process.stdout.write(`${rep.text}\n`);
  if (bench.length > 0) process.stdout.write(`\nnote: ${bench.length} run(s) ended in a bench error (counted as error): ${[...new Set(bench.map((r) => r.reason))].slice(0, 3).join(" | ")}\n`);
  const contaminated = records.filter((r) => r.contaminated);
  if (contaminated.length > 0) process.stdout.write(`note: ${contaminated.length} run(s) named another checkout of the repository in a tool call (contaminated): ${contaminated.map((r) => r.runId).join(", ")}\n`);
  return o.strict && !rep.pass ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

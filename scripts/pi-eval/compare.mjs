#!/usr/bin/env node
// Compares agents on the same task set (card W01): e.g. a Pi batch against a control run by another agent.
//   node scripts/pi-eval/compare.mjs --results DIR [--results DIR2 ...] [--file results.jsonl ...] [--batch ID,ID]
// Every record is grouped by its agent label (run.mjs --label, else the agent's path), then a table shows, per task and
// variant, each agent's outcomes (verified finishes first), and a totals line per agent: verified finishes, false done,
// interface mismatches, other non-finishes, and the shipped-wording score (informational). It reads results only.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readResults } from "./report.mjs";

const ABBR = { "verified-finish": "F", wrong: "W", "interface-mismatch": "I", "stopped-early": "S", length: "L", empty: "E", timeout: "T", error: "X", unclassified: "?" };

export function compare(records) {
  const agents = [...new Set(records.map((r) => String(r.agent ?? "?")))];
  const cells = new Map();
  for (const r of records) {
    const k = `${r.taskId}\u0000${r.variant}`;
    if (!cells.has(k)) cells.set(k, { taskId: r.taskId, size: r.size, variant: r.variant, by: new Map() });
    const by = cells.get(k).by;
    const a = String(r.agent ?? "?");
    if (!by.has(a)) by.set(a, []);
    by.get(a).push(r);
  }
  const rows = [...cells.values()].sort((x, y) => String(x.taskId).localeCompare(String(y.taskId)) || String(x.variant).localeCompare(String(y.variant)));
  const head = ["task", "size", "variant", ...agents];
  const table = rows.map((c) => [c.taskId, c.size ?? "?", c.variant, ...agents.map((a) => {
    const rs = c.by.get(a) ?? [];
    if (rs.length === 0) return "-";
    const f = rs.filter((r) => r.outcome === "verified-finish").length;
    return `${f}/${rs.length} ${rs.map((r) => ABBR[r.outcome] ?? "?").join("")}`;
  })]);
  const totals = agents.map((a) => {
    const rs = records.filter((r) => String(r.agent ?? "?") === a);
    const n = (o) => rs.filter((r) => r.outcome === o).length;
    const shipped = rs.filter((r) => r.shipped);
    return { agent: a, runs: rs.length, finish: n("verified-finish"), wrong: n("wrong"), mismatch: n("interface-mismatch"), other: rs.length - n("verified-finish") - n("wrong") - n("interface-mismatch"), shippedPassed: shipped.filter((r) => r.shipped.passed).length, shippedRuns: shipped.length };
  });
  return { agents, head, table, totals };
}

export function renderCompare(records) {
  const { head, table, totals } = compare(records);
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((r) => String(r[i]).length)));
  const fmt = (r) => `| ${r.map((x, i) => String(x).padEnd(widths[i])).join(" | ")} |`;
  const lines = [fmt(head), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...table.map(fmt), "",
    "Cells: verified finishes / runs, then each run's outcome: F finish, W false done, I interface mismatch, S stopped early, L length, E empty, T timeout, X error, ? unclassified.", ""];
  for (const t of totals) lines.push(`${t.agent}: ${t.finish}/${t.runs} verified finish, ${t.wrong} false done, ${t.mismatch} interface mismatch, ${t.other} other; shipped wording (informational) ${t.shippedRuns ? `${t.shippedPassed}/${t.shippedRuns}` : "-"}`);
  return lines.join("\n");
}

function main(argv) {
  const files = [];
  let batches = null;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--results") files.push(join(resolve(argv[++i]), "results.jsonl"));
    else if (k === "--file") files.push(resolve(argv[++i]));
    else if (k === "--batch") batches = new Set(argv[++i].split(","));
    else throw new Error(`unexpected argument ${k}`);
  }
  if (files.length === 0) files.push(join(resolve(process.env.PI_EVAL_RESULTS ?? "/srv/code/worktrees-pi/eval-results"), "results.jsonl"));
  let records = files.flatMap((f) => readResults(f));
  if (batches) records = records.filter((r) => batches.has(r.batchId));
  process.stdout.write(`${renderCompare(records)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

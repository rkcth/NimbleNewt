#!/usr/bin/env node
// Per-run figures for Radiance meeting runs (card M00, third local batch): tokens, cache reuse and its 2,048-token steps,
// hidden reasoning against visible text per statement, call endings, time, and what the run did to the shared server.
//   node prototypes/meeting/radiance-report.mjs <run-dir-substring ...>   (JSON=1 prints the rows as JSON)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STATEMENT_PHASES = new Set(["round1", "round1-blind", "round2", "chair-answer", "owner-answer", "direct-answer"]);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function reportRun(dir) {
  const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  const calls = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const server = existsSync(join(dir, "server.json")) ? JSON.parse(readFileSync(join(dir, "server.json"), "utf8")) : undefined;
  const sum = (f) => calls.reduce((a, c) => a + f(c), 0);
  const input = sum((c) => c.usage.input), cached = sum((c) => c.usage.cached), output = sum((c) => c.usage.output), reasoning = sum((c) => c.usage.reasoning ?? 0);
  const stm = calls.filter((c) => STATEMENT_PHASES.has(c.phase));
  const visible = stm.map((c) => c.usage.output - (c.usage.reasoning ?? 0));
  const hidden = stm.map((c) => c.usage.reasoning ?? 0);
  const limit = s.variant.tokenLimit ?? 220;
  const finishes = {};
  for (const c of calls) finishes[c.finish ?? "unknown"] = (finishes[c.finish ?? "unknown"] ?? 0) + 1;
  const hits = calls.filter((c) => c.usage.cached > 0);
  return {
    run: dir.split("/").pop().slice(0, 19), scenario: s.scenario, variant: s.variant.name, members: s.roster.length,
    outcome: s.result.outcome === "tabled" ? "tabled" : `${s.result.outcome} ${s.result.yes}-${s.result.no}${s.result.abstain ? `-${s.result.abstain}` : ""}`,
    calls: calls.length, input, cached, cachedPct: +(100 * cached / Math.max(1, input)).toFixed(1), output, reasoning,
    reasoningPctOfOutput: +(100 * reasoning / Math.max(1, output)).toFixed(1),
    callsWithReuse: hits.length, reuseAllMultiplesOf2048: hits.every((c) => c.usage.cached % 2048 === 0),
    promptsUnder2048: calls.filter((c) => c.usage.input < 2048).length,
    statements: stm.length, visibleMedian: median(visible), visibleMax: Math.max(0, ...visible), visibleOverLimit: visible.filter((v) => v > limit).length,
    hiddenMedian: median(hidden), hiddenMax: Math.max(0, ...hidden), outputOverLimit: stm.filter((c) => c.usage.output > limit).length,
    finishes, wallS: Math.round(sum((c) => c.ms ?? 0) / 1000),
    chairQuestions: s.stats.chairQuestions?.length ?? 0, refusedChairQuestions: s.stats.rejectedChairQuestions?.length ?? 0,
    deskFilesRead: s.stats.deskRead?.inspections?.length ?? 0, deskExcerpts: s.stats.deskRead?.excerpts?.length ?? 0, deskExcerptsRefused: s.stats.deskRead?.rejectedExcerpts?.length ?? 0, deskCorrections: (s.stats.deskRead?.corrections ?? []).filter((c) => c?.correction).length, objectionRounds: s.stats.objections?.length ?? 0, skippedAbsent: s.stats.skippedAbsent?.length ?? 0,
    tabledResearch: s.result.outcome === "tabled" ? (s.result.research ?? []).length : undefined,
    round2Changed: s.metrics.membersWhoChangedStanceInRound2,
    server: server?.delta,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "runs");
  const filters = process.argv.slice(2);
  const rows = readdirSync(root).sort().filter((d) => d.endsWith("-radiance") && existsSync(join(root, d, "summary.json")) && (!filters.length || filters.some((f) => d.includes(f)))).map((d) => reportRun(join(root, d)));
  if (process.env.JSON) console.log(JSON.stringify(rows, null, 1));
  else console.table(rows.map(({ finishes, server, ...r }) => ({ ...r, finishes: JSON.stringify(finishes), evictions: server?.evictionsRetention, ckpts: server?.checkpointsWritten })));
}

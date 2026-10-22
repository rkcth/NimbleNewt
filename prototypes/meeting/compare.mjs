#!/usr/bin/env node
// Compare finished runs: node prototypes/meeting/compare.mjs [filter]
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const dir = join(dirname(fileURLToPath(import.meta.url)), "runs");
const filter = process.argv[2] ?? "-pi";
const rows = [];
for (const d of readdirSync(dir).sort()) {
  if (!d.includes(filter) || !existsSync(join(dir, d, "summary.json"))) continue;
  const s = JSON.parse(readFileSync(join(dir, d, "summary.json"), "utf8"));
  const m = s.metrics;
  rows.push({
    run: d.slice(11, 19) + " " + s.variant.name + (s.scenario.includes("twenty") ? " (20)" : ""),
    result: s.result.outcome === "tabled" ? "TABLED" : `${s.result.yes}-${s.result.no}${s.result.abstain ? `-${s.result.abstain}` : ""} ${s.result.outcome.split(" ")[0]}`,
    calls: m.calls,
    tokens: Object.values(m.byPhase).reduce((a, p) => a + p.input + p.output, 0),
    agree: m.round1StanceAgreementWithPrevious === null ? "-" : m.round1StanceAgreementWithPrevious.toFixed(2),
    changed: m.membersWhoChangedStanceInRound2,
    objectors: (s.stats.objections ?? []).map((o) => o.objectors.length).join("/"),
    motionV: s.motion.version,
    extra: [s.stats.tabled ? "tabled" : "", s.stats.reminders ? `reminders ${s.stats.reminders.length}` : "", s.stats.rejectedReminders ? `rej ${s.stats.rejectedReminders.length}` : "", s.stats.summaryPoints ? `sumpts ${s.stats.summaryPoints.length}` : "", s.stats.rejectedSummaryPoints ? `rejpts ${s.stats.rejectedSummaryPoints.length}` : ""].filter(Boolean).join(" "),
  });
}
console.table(rows);

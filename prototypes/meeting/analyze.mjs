#!/usr/bin/env node
// Per-run evidence for the M00 record: turn length, truncation, repetition, wall time, chair-step acceptance.
//   node prototypes/meeting/analyze.mjs [dir-substring ...]   (skips fake runs)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const dir = join(dirname(fileURLToPath(import.meta.url)), "runs");
const filters = process.argv.slice(2);
const grams = (t, n = 4) => { const w = t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean); const s = new Set(); for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(" ")); return s; };
const overlap = (a, b) => { if (!a.size || !b.size) return 0; let k = 0; for (const x of a) if (b.has(x)) k++; return k / Math.min(a.size, b.size); };
const rows = [];
for (const d of readdirSync(dir).sort()) {
  if (d.endsWith("-fake") || !existsSync(join(dir, d, "summary.json"))) continue;
  if (filters.length && !filters.some((f) => d.includes(f))) continue;
  const s = JSON.parse(readFileSync(join(dir, d, "summary.json"), "utf8"));
  const calls = readFileSync(join(dir, d, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const stm = calls.filter((c) => ["round1", "round1-blind", "round2", "chair-answer", "owner-answer", "direct-answer"].includes(c.phase));
  const out = stm.map((c) => c.usage.output);
  const trunc = calls.filter((c) => c.finish === "length" || c.finish === "max_tokens").length;
  const tx = readFileSync(join(dir, d, "transcript.md"), "utf8");
  const blocks = [...tx.matchAll(/\*\*#\d+ ([^*]+)\*\* _\(([^)]*)\)_[^\n]*\n([^\n]+)/g)].map((m) => ({ who: m[1], label: m[2], text: m[3] }));
  const r1 = blocks.filter((b) => b.label.startsWith("round 1")), r2 = blocks.filter((b) => b.label === "round 2");
  const self = r2.map((b) => overlap(grams(b.text), grams(r1.find((x) => x.who === b.who)?.text ?? ""))).filter((x) => x >= 0);
  let pair = [], n = 0;
  for (let i = 0; i < r2.length; i++) for (let j = i + 1; j < r2.length; j++) { pair.push(overlap(grams(r2[i].text), grams(r2[j].text))); n++; }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  rows.push({
    run: d.slice(11, 19) + " " + s.variant.name + ((s.roster?.length ?? 8) > 10 ? " (20)" : "") + " " + d.split("-").slice(-2)[0].slice(0, 7),
    model: (s.roster?.[0]?.model ?? s.model).replace("openai-codex/", ""),
    calls: calls.length, tokens: calls.reduce((a, c) => a + c.usage.input + c.usage.output, 0),
    stmtOutMean: Math.round(mean(out)), stmtOutMax: Math.max(...out, 0), truncated: trunc,
    selfRepeat: mean(self).toFixed(2), crossRepeat: mean(pair).toFixed(2),
    wallMin: (calls.reduce((a, c) => a + (c.ms ?? 0), 0) / 60000).toFixed(1),
    result: s.result.outcome === "tabled" ? "tabled" : `${s.result.yes}-${s.result.no}`,
  });
}
console.table(rows);
if (process.env.JSON) console.log(JSON.stringify(rows));

// Aggregation and release gates for the Pi completion bench (card W01).
import { OUTCOMES } from "./classify.mjs";

/** The release gates W01 writes down. Verified finish is judged on the point estimate; the Wilson interval is shown beside it. */
export const GATES = Object.freeze({
  verifiedFinish: Object.freeze({ S: 0.9, M: 0.85, L: 0.7 }),
  falseDoneMax: 0.05,
  unclassifiedMax: 0,
});

export const SIZES = Object.freeze(["S", "M", "L"]);

/** Wilson score interval (95 % by default) for k successes in n trials. n = 0 gives [0, 1]. */
export function wilson(k, n, z = 1.959963984540054) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n < 0 || k < 0 || k > n) throw new RangeError(`wilson(${k}, ${n})`);
  if (n === 0) return { low: 0, high: 1, p: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half), p };
}

const emptyCounts = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0]));

/** Groups result records (results.jsonl rows) by variant and size, counting each outcome. Unknown outcomes count as unclassified. */
export function aggregate(records) {
  const groups = new Map();
  for (const r of records) {
    const variant = String(r.variant ?? "?");
    const size = SIZES.includes(r.size) ? r.size : "?";
    const key = `${variant}\u0000${size}`;
    if (!groups.has(key)) groups.set(key, { variant, size, n: 0, tasks: new Set(), counts: emptyCounts(), wallMs: [] });
    const g = groups.get(key);
    g.n++;
    g.tasks.add(String(r.taskId ?? "?"));
    g.counts[OUTCOMES.includes(r.outcome) ? r.outcome : "unclassified"]++;
    if (Number.isFinite(r.wallMs)) g.wallMs.push(r.wallMs);
  }
  return [...groups.values()].sort((a, b) => a.variant.localeCompare(b.variant) || SIZES.indexOf(a.size) - SIZES.indexOf(b.size));
}

/** Evaluates the gates for one variant's groups. Every size the gates name must have runs; a size with none fails ("not measured"). */
export function gatesFor(variant, groups) {
  const mine = groups.filter((g) => g.variant === variant);
  const failures = [];
  const lines = [];
  for (const size of SIZES) {
    const g = mine.find((x) => x.size === size);
    const need = GATES.verifiedFinish[size];
    if (g === undefined || g.n === 0) { failures.push(`${size}: not measured`); lines.push(`${size} verified finish: not measured (gate >= ${pct(need)})`); continue; }
    const k = g.counts["verified-finish"];
    const w = wilson(k, g.n);
    const ok = k / g.n >= need;
    if (!ok) failures.push(`${size}: verified finish ${pct(k / g.n)} < ${pct(need)}`);
    lines.push(`${size} verified finish ${k}/${g.n} = ${pct(k / g.n)} [95% ${pct(w.low)}-${pct(w.high)}] gate >= ${pct(need)}: ${ok ? "ok" : "FAIL"}${ok && w.low < need ? " (interval still reaches below the gate)" : ""}`);
  }
  const n = mine.reduce((a, g) => a + g.n, 0);
  const wrong = mine.reduce((a, g) => a + g.counts.wrong, 0);
  const unclassified = mine.reduce((a, g) => a + g.counts.unclassified, 0) + mine.filter((g) => g.size === "?").reduce((a, g) => a + g.n, 0);
  if (n > 0) {
    const w = wilson(wrong, n);
    const ok = wrong / n <= GATES.falseDoneMax;
    if (!ok) failures.push(`false done ${pct(wrong / n)} > ${pct(GATES.falseDoneMax)}`);
    lines.push(`false done ${wrong}/${n} = ${pct(wrong / n)} [95% ${pct(w.low)}-${pct(w.high)}] gate <= ${pct(GATES.falseDoneMax)}: ${ok ? "ok" : "FAIL"}`);
  }
  if (unclassified > GATES.unclassifiedMax) failures.push(`${unclassified} unclassified non-finish(es)`);
  lines.push(`unclassified non-finishes ${unclassified} gate = 0: ${unclassified === 0 ? "ok" : "FAIL"}`);
  return { variant, pass: failures.length === 0, failures, lines };
}

export const pct = (x) => (x === null || !Number.isFinite(x) ? "-" : `${(x * 100).toFixed(1)}%`);

/** The whole report as text: one table of outcomes per variant and size, then each variant's gates and a pass/fail line. */
export function renderReport(records, { title = "Pi completion bench" } = {}) {
  const groups = aggregate(records);
  const cols = ["variant", "size", "tasks", "runs", "verified", "95% CI", ...OUTCOMES.filter((o) => o !== "verified-finish"), "median wall"];
  const rows = groups.map((g) => {
    const k = g.counts["verified-finish"];
    const w = wilson(k, g.n);
    return [g.variant, g.size, String(g.tasks.size), String(g.n), `${k} (${pct(k / g.n)})`, `${pct(w.low)}-${pct(w.high)}`, ...OUTCOMES.filter((o) => o !== "verified-finish").map((o) => String(g.counts[o])), minutes(median(g.wallMs))];
  });
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => `| ${r.map((x, i) => x.padEnd(widths[i])).join(" | ")} |`;
  const out = [`# ${title}`, "", `${records.length} run(s)`, "", fmt(cols), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...rows.map(fmt), "",
    "Repeats of one task are not independent samples: each interval treats every run as independent, so with few tasks per size it is narrower than the truth. A gate met on a handful of tasks is a first reading, not a proof.", ""];
  const variants = [...new Set(groups.map((g) => g.variant))];
  let allPass = variants.length > 0;
  for (const v of variants) {
    const r = gatesFor(v, groups);
    allPass &&= r.pass;
    out.push(`## Variant ${v}`, ...r.lines.map((l) => `- ${l}`), `- ${r.pass ? "PASS" : `FAIL: ${r.failures.join("; ")}`}`, "");
  }
  out.push(variants.length === 0 ? "RESULT: no runs" : `RESULT: ${allPass ? "PASS" : "FAIL"} (${variants.map((v) => `${v} ${gatesFor(v, groups).pass ? "pass" : "fail"}`).join(", ")})`);
  return { text: out.join("\n"), pass: allPass, groups };
}

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const minutes = (ms) => (ms === null ? "-" : `${(ms / 60000).toFixed(1)} min`);

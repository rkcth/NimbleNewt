#!/usr/bin/env node
// Fact-retention score: how many numbers (and the words next to them) in each statement survive into its tl;dr.
import { readFileSync } from "node:fs";
const t = readFileSync(process.argv[2] + "/transcript.md", "utf8");
const blocks = t.split(/\n(?=\*\*#)/).filter((b) => b.includes("tl;dr"));
let total = 0, kept = 0, rows = [];
for (const b of blocks) {
  const [head, ...rest] = b.split("\n");
  const body = rest.filter((l) => !l.startsWith("> tl;dr")).join(" ");
  const tl = (rest.find((l) => l.startsWith("> tl;dr")) ?? "").toLowerCase();
  const nums = [...new Set(body.match(/\b\d+(?:\.\d+)?\b(?:\s*(?:percent|%|minutes?|bugs?))?/gi) ?? [])];
  const k = nums.filter((n) => tl.includes(n.toLowerCase().split(/\s+/)[0])).length;
  total += nums.length; kept += k;
  rows.push(`${head.replace(/\*/g, "")}  numbers ${k}/${nums.length}`);
}
console.log(rows.join("\n"));
console.log(`\nnumbers retained in summaries: ${kept}/${total}${total ? ` (${Math.round((100 * kept) / total)}%)` : ""}`);

#!/usr/bin/env node
// Question to a non-present subordinate, answered from its checkpoint (card M00). The checkpoint is a stored short state summary;
// a tool-less call answers from it only, marks the answer as taken from the checkpoint (possibly stale), and must not invent or act.
//   node prototypes/meeting/checkpoint.mjs --spec pi:gpt-6.1-sol --budget <file> --cap-tokens N
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fromSpec } from "./lib/specs.mjs";
import { makeProvider } from "./lib/provider.mjs";
import { Ledger } from "./lib/ledger.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]] : acc), []));
const sc = JSON.parse(readFileSync(join(here, "scenarios", "checkpoint.json"), "utf8"));
const provider = args.spec ? await fromSpec(args.spec, args) : makeProvider({ kind: "fake" });
const ledger = new Ledger({ capTokens: Number(args["cap-tokens"] ?? 100000), capUsd: Number(args["cap-usd"] ?? Infinity), prices: { in: Number(args["price-in"] ?? 0), cachedIn: Number(args["price-cached"] ?? 0), out: Number(args["price-out"] ?? 0) } });
const prior = args.budget && existsSync(args.budget) ? JSON.parse(readFileSync(args.budget, "utf8")) : { tokens: 0, usd: 0, runs: 0 };
ledger.tokens = prior.tokens; ledger.spent = prior.usd;
process.on("exit", () => { if (args.budget) writeFileSync(args.budget, JSON.stringify({ tokens: ledger.tokens, usd: ledger.spent, runs: prior.runs + 1, capTokens: ledger.capTokens, capUsd: ledger.capUsd }, null, 1)); });
const byId = new Map(sc.agents.map((a) => [a.id, a]));
const out = join(here, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-checkpoint-${(args.spec ?? "fake").replace(/[^a-z0-9]+/gi, "-")}`);
mkdirSync(out, { recursive: true });
const results = [];
for (const q of sc.questions) {
  const a = byId.get(q.to);
  ledger.assertRoom(0.002);
  const system = `You are ${a.name}, ${a.role}. You are NOT in the meeting and you are not running now: someone is asking you a question and you answer from your stored checkpoint only, with no tools and no access to your desk or to anything newer. Answer in at most 70 words. Start with "From my checkpoint of ${a.checkpointAt}:". Say plainly what the checkpoint does not cover or what may have changed since. Never invent facts, never promise or perform actions, and say you cannot act from a checkpoint if asked to.`;
  const user = `YOUR CHECKPOINT (the only thing you know):\n${a.checkpoint}\n\nQUESTION from a participant: ${q.text}`;
  const r = await provider.chat({ system, user, maxTokens: 250 + (args.spec?.startsWith("pi") ? 800 : 0), hint: { task: "checkpoint" } });
  const row = ledger.record({ phase: "checkpoint", agent: a.id, task: "checkpoint", model: provider.name, usage: r.usage, ms: r.ms });
  const text = r.text.trim();
  const hits = (q.expect ?? []).map((p) => new RegExp(p, "i").test(text));
  const marked = /from my checkpoint/i.test(text);
  const staleNote = /(may have changed|since then|since the checkpoint|as of|at the time|not covered|does not cover|can't say|cannot say|may be out of date|no newer)/i.test(text);
  const bad = q.mustNotClaim ? new RegExp(q.mustNotClaim, "i").test(text) && !/not|n't|unsure|no answer/i.test(text) : false;
  results.push({ to: a.id, kind: q.kind, question: q.text, answer: text, marked, staleNote, expectHits: hits, falseClaim: bad, tokens: r.usage.input + r.usage.output });
}
writeFileSync(join(out, "results.json"), JSON.stringify({ model: provider.name, results, tokens: ledger.calls.reduce((s, c) => s + c.usage.input + c.usage.output, 0), costUsd: ledger.calls.reduce((s, c) => s + c.costUsd, 0) }, null, 2));
for (const r of results) console.log(`[${r.kind}] marked=${r.marked} stale=${r.staleNote} expect=${r.expectHits.join("/")} false=${r.falseClaim}\n  ${r.answer.replace(/\n/g, " ")}`);
console.log(`Output: ${out}`);
process.exit(0);

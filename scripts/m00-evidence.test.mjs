// Offline checks of the committed M00 batch-4 evidence: the figures in evidence/m00-radiance-batch4.json are recomputed from the raw run folders
// kept in git (evidence/m00-raw/), the budget file agrees with them and stayed under its cap, and the copied folders are safe to check out on Windows.
// No model, no network: these only read files.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const evidence = fileURLToPath(new URL("../docs/nimblenewt/implementation-plan/evidence/", import.meta.url));
const raw = join(evidence, "m00-raw");
const batch4 = join(raw, "batch4");
const figures = JSON.parse(readFileSync(join(evidence, "m00-radiance-batch4.json"), "utf8"));
const lines = (file) => readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
const callsOf = (folder) => lines(join(evidence, folder.replace(/^evidence\//, ""), "calls.jsonl"));
const sum = (calls, k) => calls.reduce((s, c) => s + c.usage[k], 0);

test("each batch-4 meeting's figures equal the sums of its raw calls and server readings", () => {
  assert.equal(figures.meetings.length, 8);
  for (const m of figures.meetings) {
    const calls = callsOf(m.folder);
    assert.equal(calls.length, m.calls, m.run);
    assert.equal(sum(calls, "input"), m.input, m.run);
    assert.equal(sum(calls, "output"), m.output, m.run);
    assert.equal(sum(calls, "cached"), m.cached, m.run);
    assert.equal(Math.round((1000 * m.cached) / m.input) / 10, m.cachedPct, m.run);
    const summary = JSON.parse(readFileSync(join(evidence, m.folder.replace(/^evidence\//, ""), "summary.json"), "utf8"));
    const r = summary.result;
    assert.equal(r.outcome === "tabled" ? "tabled" : `${r.outcome} ${r.yes}-${r.no}`, m.outcome, m.run);
    const server = JSON.parse(readFileSync(join(evidence, m.folder.replace(/^evidence\//, ""), "server.json"), "utf8"));
    const ev = (s) => s.stats.ckpt_evictions.retention + s.stats.ckpt_evictions.store_full;
    assert.equal(ev(server.after) - ev(server.before), m.evictionsCausedByMeeting, m.run);
    assert.equal(server.after.stats.total_requests - server.before.stats.total_requests === m.calls, m.serverRequestsEqualCalls, m.run);
    assert.ok(calls.every((c) => c.costUsd === 0), m.run);
  }
});

test("the batch-4 total is the meetings, the checkpoint set and both interrupted runs, and equals the budget file, under its cap", () => {
  const meetings = figures.meetings.reduce((s, m) => s + m.input + m.output, 0);
  assert.equal(meetings, figures.summedMeetingTokens);
  const ck = JSON.parse(readFileSync(join(evidence, figures.checkpoint.folder.replace(/^evidence\//, ""), "results.json"), "utf8"));
  assert.equal(ck.results.reduce((s, r) => s + r.tokens, 0), figures.checkpoint.tokens);
  assert.equal(ck.results.length, 6);
  let interrupted = 0;
  for (const run of figures.interrupted) {
    const calls = callsOf(run.folder);
    assert.equal(calls.length, run.calls);
    assert.equal(sum(calls, "input"), run.input);
    assert.equal(sum(calls, "output"), run.output);
    assert.ok(!existsSync(join(evidence, run.folder.replace(/^evidence\//, ""), "summary.json")), "an interrupted run has no summary");
    interrupted += run.input + run.output;
  }
  const total = meetings + figures.checkpoint.tokens + interrupted;
  const budget = JSON.parse(readFileSync(join(batch4, "budget.json"), "utf8"));
  assert.equal(total, figures.budget.tokensUsedAtEnd);
  assert.equal(budget.tokens, total);
  assert.equal(budget.capTokens, figures.budget.capTokens);
  assert.ok(budget.tokens <= budget.capTokens);
  assert.equal(budget.usd, 0);
  assert.equal(budget.runs, figures.budget.runnerInvocationsCounted);
});

test("the raw evidence folders check out on Windows and hold no address, URL or key pattern", () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? [n, ...walk(join(dir, n)).map((c) => `${n}/${c}`)] : [n]));
  const files = walk(raw);
  assert.deepEqual(files.filter((p) => /[:<>"|?*\\]/.test(p)), []);
  assert.equal(readdirSync(join(raw, "2026-10-22")).length, 44);
  const patterns = [/\bBearer\s/, /\bsk-[A-Za-z0-9_-]{16,}/, /api[_-]?key/i, /https?:\/\//, /\blocalhost\b/, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, /\b8002\b/, /\/(?:home|Users)\//];
  const hits = [];
  for (const p of files) {
    const full = join(raw, p);
    if (statSync(full).isDirectory()) continue;
    const text = readFileSync(full, "utf8");
    for (const re of patterns) if (re.test(text)) hits.push(`${p} ${re.source}`);
  }
  assert.deepEqual(hits, []);
});

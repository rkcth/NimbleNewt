import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CacheAdapter, deriveKey, ledgerCache, profileFor, type CacheContext } from "@nimblenewt/controller";
import { HermesTransport, hermesResponse, readHermesUsage, syntheticHead, type HermesRunner } from "./g10-hermes-route.js";

/**
 * Card G10, hosted OpenAI route. Not a test (the offline guard blocks processes that reach the network, and CI never runs it): a person or agent runs it by hand, one command at a time, a handful of calls.
 *
 *   node packages/integration/dist/g10-hermes-bench.js --out /path/outside/the/repo/results.json --fixtures /path/to/fixture-dir [--repeats 2] [--idle 330] [--lines 150] [--model gpt-6.1-sol]
 *
 * It starts the owner's `hermes` command (one-shot mode, provider openai-codex, an explicit model, an empty working folder, no rules or memory loaded) and reads Hermes's own usage report. It never reads
 * Hermes's credential or configuration files, never prints a token, and does not change Hermes's configuration. The adapter and profile are the production ones; only the transport is new (g10-hermes-route.ts).
 * The raw results (--out) hold the prompts' answers and the usage figures; keep them out of the repository. --fixtures gets one small JSON per step with usage figures and the answer only.
 */
const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback; };
const OUT = arg("out", ""); const FIXTURES = arg("fixtures", "");
const REPEATS = Number(arg("repeats", "2")); const IDLE_S = Number(arg("idle", "330")); const LINES = Number(arg("lines", "150")); const MODEL = arg("model", "gpt-6.1-sol");
const HERMES = arg("hermes", "hermes");
if (OUT === "" || FIXTURES === "") { process.stderr.write("--out <file> and --fixtures <dir> are required\n"); process.exit(2); }

const work = mkdtempSync(join(tmpdir(), "g10h-"));
const cwd = join(work, "cwd"); mkdirSync(cwd);
let n = 0;
const runner: HermesRunner = (prompt) => new Promise((resolve) => {
  // The prompt is one argument (no shell); one that starts with "-" could still be read as an option, so it is refused rather than sent.
  if (prompt.startsWith("-")) throw new Error("a prompt may not start with \"-\"");
  const usageFile = join(work, `usage-${++n}.json`);
  const started = performance.now();
  execFile(HERMES, ["--provider", "openai-codex", "-m", MODEL, "--reasoning", "low", "--ignore-rules", "--usage-file", usageFile, "-z", prompt], { cwd, timeout: 300_000, maxBuffer: 1 << 20 }, (error, stdout) => {
    let usage: unknown;
    try { usage = JSON.parse(readFileSync(usageFile, "utf8")); } catch { usage = undefined; }
    resolve({ text: stdout.trim(), usage, wallMs: Math.round(performance.now() - started), exitCode: error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1 });
  });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const transport = new HermesTransport(runner);
const profile = profileFor({ kind: "openai", model: MODEL, options: {} });
const adapter = new CacheAdapter(profile, transport);
const secret = randomBytes(24).toString("hex");
const steps: unknown[] = []; const fixtures: Record<string, unknown> = {};
let calls = 0;

async function step(repeat: number, name: string, head: string, question: string, expected: string, ctx: CacheContext, expectCached: number): Promise<{ cached: number; prompt: number }> {
  const res = await adapter.call({ messages: [{ role: "system", content: head }, { role: "user", content: question }], temperature: 0 }, ctx, expectCached);
  calls += 1;
  const last = transport.calls[transport.calls.length - 1]!;
  const answer = last.text.trim();
  const ledger = ledgerCache(res.hit, "openai", "hermes-openai-codex");
  const record = { repeat, step: name, outcome: res.outcome, status: res.status, promptTokens: res.hit.promptTokens, cachedTokens: res.hit.cachedTokens, computedTokens: res.hit.computedTokens, wallMs: last.wallMs, correct: answer.toLowerCase().includes(expected.toLowerCase()), droppedCacheFields: last.dropped, ledger, providerCalls: (last.usage?.api_calls ?? 0) + (last.usage?.auxiliary?.api_calls ?? 0) };
  steps.push({ ...record, answer: answer.slice(0, 80), expected });
  if (last.usage !== undefined) fixtures[`r${repeat}-${name}`] = { step: name, repeat, usage: last.usage, answer: answer.slice(0, 80), expected };
  process.stdout.write(`${JSON.stringify(record)}\n`);
  return { cached: res.hit.cachedTokens, prompt: res.hit.promptTokens };
}

for (let r = 1; r <= REPEATS; r++) {
  const nonce = randomBytes(6).toString("hex");
  const h = syntheticHead(nonce, LINES);
  const ctx: CacheContext = { scopeKey: deriveKey(secret, "scope", `g10h-${nonce}`), shareKey: deriveKey(secret, "share", `g10h-${nonce}`) };
  const qa = "What is the vault code for this run?"; const qb = "Which team is on call for this run?";
  const cold = await step(r, "cold", h.text, qa, h.code, ctx, 0);
  const rep = await step(r, "repeat", h.text, qa, h.code, ctx, cold.cached + 1);
  await step(r, "fork", h.text, qb, h.team, ctx, cold.cached + 1);
  await step(r, "changed-head", `Changed. ${h.text}`, qa, h.code, ctx, rep.cached);
  if (r === 1 && IDLE_S > 0) { await sleep(IDLE_S * 1000); await step(r, `after-idle-${IDLE_S}s`, h.text, qa, h.code, ctx, rep.cached); }
}

// A usage report must read back through the pure converters the tests use (this guards the bench's own plumbing).
for (const f of Object.values(fixtures)) { const u = readHermesUsage((f as { usage: unknown }).usage); if (u === undefined) throw new Error("a recorded usage report did not read back"); hermesResponse(u, ""); }
mkdirSync(dirname(OUT), { recursive: true }); mkdirSync(FIXTURES, { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ route: "hermes -z, provider openai-codex", model: MODEL, repeats: REPEATS, idleSeconds: IDLE_S, headLines: LINES, hermesInvocations: calls, steps }, null, 1)}\n`);
for (const [name, f] of Object.entries(fixtures)) writeFileSync(join(FIXTURES, `${name}.json`), `${JSON.stringify(f, null, 1)}\n`);
rmSync(work, { recursive: true, force: true });
process.stdout.write(`hermes invocations: ${calls}\nresults: ${OUT}\n`);

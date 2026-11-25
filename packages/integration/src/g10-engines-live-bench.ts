import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { concurrencyRun, evictionRun, extrasRun, idleRun, readEngineInfo, readMetrics, realEngineEnv, sharedRun, type EngineKind, type Fixture } from "./g10-engines-live.js";

/**
 * Card G10, the live run against llama.cpp's llama-server or vLLM (see g10-engines-live.ts). Not a test and never run by CI: run by hand against a server the operator started.
 *
 *   node packages/integration/dist/g10-engines-live-bench.js --engine llamacpp|vllm --root http://127.0.0.1:8000 --model NAME --out evidence/g10-llamacpp-run1.json
 *        [--parts SIECX] [--lines 200] [--gaps 0,15,30,60,120] [--levels 1,2,4,8] [--evict-levels 1,2,4,8,16,32] [--fixtures DIR] [--meta meta.json]
 *
 * S: shared head across conversations, I: idle gaps, E: eviction ladder (the cliff), C: concurrency, X: engine extras (cache-setting refusal, slots and save/restore, cache_salt).
 * `--meta` is a JSON file the operator writes by hand (engine version and image, GPU, data centre, price per hour); it is copied into the evidence as given and is checked to hold no key-like text.
 * No credential is read, needed or sent. The evidence holds usage, timing and counter fields only.
 */
const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback; };
const OUT = arg("out", ""); const ENGINE = arg("engine", ""); const ROOT = arg("root", ""); const MODEL = arg("model", "");
if (OUT === "" || (ENGINE !== "llamacpp" && ENGINE !== "vllm") || ROOT === "" || MODEL === "") { process.stderr.write("--engine llamacpp|vllm, --root URL, --model NAME and --out FILE are required\n"); process.exit(2); }
const PARTS = arg("parts", "SIECX"); const LINES = Number(arg("lines", "200"));
const nums = (name: string, fallback: string): number[] => arg(name, fallback).split(",").map(Number);
const GAPS = nums("gaps", "0,15,30,60,120"); const LEVELS = nums("levels", "1,2,4,8"); const EVICT = nums("evict-levels", "1,2,4,8,16,32");
if (GAPS.some((g) => !(g >= 0 && g <= 3600)) || !(LINES >= 20 && LINES <= 450) || LEVELS.some((l) => !(l >= 1 && l <= 16)) || EVICT.some((l) => !(l >= 1 && l <= 200))) { process.stderr.write("--gaps 0..3600 s, --lines 20..450, --levels 1..16, --evict-levels 1..200\n"); process.exit(2); }
const metaText = arg("meta", "") === "" ? "{}" : readFileSync(arg("meta", ""), "utf8");
if (/(sk-|bearer |api[_-]?key|token|password|secret)/i.test(metaText)) { process.stderr.write("the meta file looks like it holds a credential; refused\n"); process.exit(2); }

const env = realEngineEnv(ENGINE as EngineKind, globalThis.fetch, ROOT, MODEL, (l) => process.stdout.write(`${l}\n`));
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), engine: ENGINE, model: MODEL, parts: PARTS, lines: LINES, gapsS: GAPS, levels: LEVELS, evictLevels: EVICT, meta: JSON.parse(metaText) as unknown, engineInfo: await readEngineInfo(env), metricsAtStart: await readMetrics(env) };
const fixtures: Fixture[] = [];
const put = (key: string, r: { fixtures: Fixture[] }): void => { evidence[key] = { ...r, fixtures: undefined }; fixtures.push(...r.fixtures); };
try {
  if (PARTS.includes("S")) put("shared", await sharedRun(env, { lines: LINES }));
  if (PARTS.includes("X")) put("extras", await extrasRun(env, { lines: LINES }));
  if (PARTS.includes("C")) put("concurrency", await concurrencyRun(env, { levels: LEVELS, lines: LINES }));
  if (PARTS.includes("E")) put("eviction", await evictionRun(env, { lines: LINES, levels: EVICT }));
  if (PARTS.includes("I")) put("idle", await idleRun(env, { gapsS: GAPS, lines: LINES }));
} finally {
  evidence["metricsAtEnd"] = await readMetrics(env);
  evidence["finishedAt"] = new Date().toISOString();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`evidence: ${OUT}\n`);
}
if (arg("fixtures", "") !== "") for (const f of fixtures) { const file = join(arg("fixtures", ""), `${f.name}.json`); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify({ status: f.status, body: f.body })}\n`); }

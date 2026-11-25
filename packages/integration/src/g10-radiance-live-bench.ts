import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PINNED_MODEL, assertNoKey, pinnedServed, radianceKey, serverRoot, writeEvidence } from "./g09-radiance-gate.js";
import { concurrencyRun, readStats, realEnv, refusalRun, retainedRun, type Fixture } from "./g10-radiance-live.js";

/**
 * Card G10, the live run of the clauses the first run left open (see g10-radiance-live.ts). Not a test and never run by CI: run by hand against the server that is already running, one probe after another.
 *
 *   node packages/integration/dist/g10-radiance-live-bench.js --out evidence/g10-radiance-run2.json [--fixtures DIR] [--parts RFC] [--gaps 0,60,300] [--lines 300] [--levels 1,2,4,8]
 *
 * R: retained-marker run, F: refusal fallback, C: concurrency. It never loads, unloads, switches or restarts anything, never calls a cache reset, and refuses to start only when the pinned model is not already
 * resident. A server that is busy with other clients is recorded (the stats before and after every phase), not waited for: the evidence says what load the numbers were taken under. The key is read from Pi's
 * configuration and only put in the Authorization header; the evidence and every fixture are checked for it before they are written.
 */
const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback; };
const OUT = arg("out", "");
if (OUT === "") { process.stderr.write("--out <file> is required\n"); process.exit(2); }
const FIXTURES = arg("fixtures", "");
const PARTS = arg("parts", "RFC");
const GAPS = arg("gaps", "0,60,300").split(",").map(Number);
const LINES = Number(arg("lines", "300"));
const LEVELS = arg("levels", "1,2,4,8").split(",").map(Number);
if (GAPS.some((g) => !(g >= 0 && g <= 3600)) || !(LINES >= 20 && LINES <= 450) || LEVELS.some((l) => !(l >= 1 && l <= 8))) { process.stderr.write("--gaps 0..3600 seconds, --lines 20..450, --levels 1..8\n"); process.exit(2); }

const key = radianceKey();
const root = serverRoot(key.baseUrl);
const env = realEnv(globalThis.fetch, root, key, PINNED_MODEL, (l) => process.stdout.write(`${l}\n`));
const models = await (await fetch(`${root}/v1/models`, { headers: key.header() })).json() as unknown;
const served = pinnedServed(models, PINNED_MODEL);
if (!served.ok) { process.stderr.write(`${key.scrub(served.why)}\n`); process.exit(3); }

const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), model: PINNED_MODEL, parts: PARTS, gapsS: GAPS, lines: LINES, levels: LEVELS, statsAtStart: await readStats(env) };
const fixtures: Fixture[] = [];
if (PARTS.includes("R")) { const r = await retainedRun(env, { gapsS: GAPS, lines: LINES }); evidence["retained"] = { ...r, fixtures: undefined }; fixtures.push(...r.fixtures); }
if (PARTS.includes("F")) { const r = await refusalRun(env, { lines: LINES }); evidence["refusal"] = { ...r, fixtures: undefined }; fixtures.push(...r.fixtures); }
if (PARTS.includes("C")) { const r = await concurrencyRun(env, { levels: LEVELS, lines: Math.min(LINES, 200) }); evidence["concurrency"] = { ...r, fixtures: undefined }; fixtures.push(...r.fixtures); }
evidence["statsAtEnd"] = await readStats(env);
evidence["finishedAt"] = new Date().toISOString();
writeEvidence(OUT, evidence, key);
if (FIXTURES !== "") {
  for (const f of fixtures) {
    const text = `${JSON.stringify({ status: f.status, body: f.body })}\n`;
    assertNoKey(text, key, `fixture ${f.name}`);
    const file = join(FIXTURES, `${f.name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}
process.stdout.write(`evidence: ${OUT}\n`);

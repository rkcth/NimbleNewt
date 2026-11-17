import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { assertNoKey, Budget, PINNED_MODEL, radianceKey, RadianceRefused, serverRoot, ServerGate } from "./g09-radiance-gate.js";
import { runG09Proof } from "./g09-radiance-run.js";

/**
 * Card G09: the measured run against the owner's Radiance server. Not a test (the offline guard blocks the network in tests) and never run by CI: run by hand, once, against a server that is already running.
 *
 *   node packages/integration/dist/g09-radiance-bench.js --out docs/nimblenewt/implementation-plan/evidence/g09-radiance-run1.json [--max-calls 14] [--max-reply 1024] [--scratch DIR]
 *
 * Budget (stated before the run): at most `--max-calls` model calls (default 14; the scenario needs about 10), each with a reply limit of 256 tokens, 1,024 for the two calls that are cut while they write (both
 * cut after a few hundred characters). The brief is about 7,000 tokens, so the run reads at most about 14 x 9,000 = 126,000 prompt tokens, most of them from the server's cache, and writes at most about 6,000.
 *
 * Exit codes: 0 the run finished (the evidence says which checks held), 3 the server was busy or the pinned model not served at the start (nothing was sent), 2 a usage error, 1 anything else.
 * The key is read from Pi's configuration and only put in Authorization headers; the evidence is checked for it before it is written.
 */

const arg = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback; };
const OUT = arg("out", "");
if (OUT === "") { process.stderr.write("--out <file> is required\n"); process.exit(2); }
const MAX_CALLS = Number(arg("max-calls", "14"));
const MAX_REPLY = Number(arg("max-reply", "1024"));
if (!(MAX_CALLS >= 1 && MAX_CALLS <= 20) || !(MAX_REPLY >= 16 && MAX_REPLY <= 1024)) { process.stderr.write("--max-calls must be 1..20 and --max-reply 16..1024\n"); process.exit(2); }

const key = radianceKey();
const scratchParent = arg("scratch", tmpdir());
mkdirSync(scratchParent, { recursive: true });
const dir = mkdtempSync(join(scratchParent, "g09-run-"));
const say = (line: string): void => { process.stdout.write(`${key.scrub(line)}\n`); };

// The first gate reading, before anything else: a busy server or a model that is not served ends the run here, with nothing sent.
try { await new ServerGate({ root: serverRoot(key.baseUrl), key, fetch: globalThis.fetch, model: PINNED_MODEL }).check(0); } catch (error) {
  say(error instanceof RadianceRefused ? error.message : `the server could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(3);
}
say(`budget: at most ${MAX_CALLS} model calls, reply limits 256 / ${Math.min(1024, MAX_REPLY)} tokens; one call at a time; idle gate before every call`);
const TRACE = process.argv.includes("--trace");
// If the run ever leaves nothing to wait on (a promise nobody settles), what was recorded so far is still written, marked as such.
let partial: unknown;
process.once("exit", () => {
  if (partial === undefined || (partial as { finishedAt?: string }).finishedAt !== undefined) return;
  (partial as { stopped?: string }).stopped ??= "the run left nothing to wait on before it finished (a pending step never settled); this is what was recorded";
  const text = `${JSON.stringify(partial, null, 1)}\n`;
  assertNoKey(text, key, "the partial evidence");
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  say(`partial evidence: ${OUT}`);
});
const evidence = await runG09Proof({ fetch: globalThis.fetch, key, baseUrl: key.baseUrl, model: PINNED_MODEL, dir, budget: new Budget(MAX_CALLS, MAX_REPLY), replyTokens: { short: Math.min(256, MAX_REPLY), long: MAX_REPLY }, log: say, onEvidence: (e) => { partial = e; }, ...(TRACE ? { trace: (l: string) => say(`  . ${l}`) } : {}) });
const text = `${JSON.stringify(evidence, null, 1)}\n`;
assertNoKey(text, key, "the evidence");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text);
rmSync(dir, { recursive: true, force: true });
say(`checks ${evidence.summary?.passed}/${evidence.summary?.checks} held; ${evidence.summary?.calls} model calls${evidence.stopped === undefined ? "" : `; stopped: ${evidence.stopped}`}`);
say(`evidence: ${OUT}`);

#!/usr/bin/env node
// Card W09: the W01 bench through NimbleNewt's REAL worker and controller on the Radiance route (the owner's local AI server), the model calls through the controller's model relay. One run at a time, one model request at a
// time, only to the Radiance server's own address (lib/worker-embedder.mjs radianceOnlyFetch); nothing loads, unloads, switches or restarts a model.
//   node scripts/pi-eval/worker-run.mjs --tasks quote-lines --variants D --repeats 1 --context-tokens <the model's real window>
// Options:
//   --tasks id,id          only these tasks (default: every task)        --variants A,B,C,D   default D (the shipped worker; see lib/worker-run.mjs WORKER_VARIANTS)
//   --repeats N            runs per task and variant (default 1)
//   --context-tokens N     the route's context window (default: the model's contextWindow in Pi's ~/.pi/agent/models.json radiance provider; required when that has none)
//   --max-tokens N         the route's reply limit (card W07), --reasoning-tokens N  its reasoning cap (thinking_token_budget on a Radiance kind)
//   --results DIR          default <PI_EVAL_RESULTS or /srv/code/worktrees-pi/eval-results>/worker ; results go to worker-results.jsonl there
//   --work-root DIR        throwaway checkouts and installations (default eval-work-worker beside the results)
//   --repo DIR / --deps-from DIR   as the command-line bench
//   --timeout-minutes N    override every task's wall-clock limit      --idle-wait-minutes N  wait for an idle Radiance before a run (default 30)
//   --test-slot CMD        a slot command (e.g. /tmp/nn-slot.sh) held for grading only
//   --keep                 keep checkouts and installation folders      --dry-run  print what would run
// Writes per run: a record (commit, route, model, size, variant, the controller's attempt summary, the acceptance result, the outcome); per batch: a report with the W01 gates per variant; and, when the shipped variant's
// gates do not hold over the batch, a release-blocker record with its results attached (<results>/release-blockers/w09-<batch>.{json,md}).
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBatch } from "./lib/batch.mjs";
import { radianceConfig, radianceGate } from "./lib/radiance-gate.mjs";
import { appendJsonl } from "./lib/runner.mjs";
import { renderReport } from "./lib/stats.mjs";
import { loadTaskset } from "./lib/taskset.mjs";
import { SHIPPED_VARIANT, WORKER_VARIANTS, benchCommitOf, fileToolsLine, releaseBlocker, repoRootOf, runWorkerOne } from "./lib/worker-run.mjs";
import { parseArgs } from "./run.mjs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));

const positive = (v, name) => { if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive whole number`); return n; };

/** The model's context window from Pi's own configuration (the radiance provider's models list), or undefined. Never reads or returns the key. */
export function piContextWindow(model, home = homedir()) {
  try {
    const m = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8"))?.providers?.radiance?.models;
    const found = Array.isArray(m) ? m.find((x) => x?.id === model) : undefined;
    return Number.isInteger(found?.contextWindow) && found.contextWindow > 0 ? found.contextWindow : undefined;
  } catch { return undefined; }
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.flags.has("help")) { process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n") + "\n"); return 0; }
  const set = loadTaskset(resolve(o.taskset ?? join(here, "taskset.json")));
  if (set.agent.provider !== "radiance") throw new Error("the W09 run is on the Radiance route only (the task set's agent.provider must be radiance)");
  const root = repoRootOf(join(here, "lib"));
  const repo = resolve(o.repo ?? root);
  const only = o.tasks ? new Set(o.tasks.split(",")) : null;
  if (only !== null) for (const id of only) if (!set.tasks.some((t) => t.id === id)) throw new Error(`no task ${id} in the task set`);
  const tasks = set.tasks.filter((t) => only === null || only.has(t.id));
  const variants = (o.variants ?? SHIPPED_VARIANT).split(",");
  for (const v of variants) if (WORKER_VARIANTS[v] === undefined) throw new Error(`no worker variant ${v} (A, B, C or D)`);
  const repeats = positive(o.repeats ?? "1", "repeats");
  const base = process.env.PI_EVAL_RESULTS || (existsSync("/srv/code/worktrees-pi") ? "/srv/code/worktrees-pi/eval-results" : join(root, "..", "pi-eval", "eval-results"));
  const resultsDir = resolve(o.results ?? join(base, "worker"));
  const workRoot = resolve(o["work-root"] ?? process.env.PI_EVAL_WORK_ROOT ?? join(dirname(resolve(base)), "eval-work-worker"));
  const model = set.agent.model;
  const contextTokens = positive(o["context-tokens"], "context-tokens") ?? piContextWindow(model);
  if (contextTokens === undefined) throw new Error(`give --context-tokens: Pi's models.json states no context window for ${model}`);
  const jobs = [];
  for (const t of tasks) for (const v of variants) for (let r = 1; r <= repeats; r++) jobs.push([t, v, r]);
  if (o.flags.has("dry-run")) {
    for (const [t, v, r] of jobs) process.stdout.write(`${t.id} (${t.size}) worker variant ${v} repeat ${r}: ${WORKER_VARIANTS[v].about}; limit ${o["timeout-minutes"] ?? t.timeoutMinutes} min\n`);
    process.stdout.write(`${jobs.length} run(s), one at a time, route radiance/${model} (kind radiance, window ${contextTokens}), results ${resultsDir}, work ${workRoot}\n`);
    return 0;
  }
  const cfg = radianceConfig();
  const batchId = `w09-batch-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}`;
  const benchCommit = benchCommitOf(here);
  await mkdir(resultsDir, { recursive: true });
  await mkdir(workRoot, { recursive: true });
  const log = (m) => process.stderr.write(`${new Date().toISOString()} ${m}\n`);
  const ctx = {
    set, repo, depsFrom: resolve(o["deps-from"] ?? repo), workRoot, resultsDir, root, batchId, benchCommit, log, keep: o.flags.has("keep"),
    timeoutMinutes: positive(o["timeout-minutes"], "timeout-minutes"),
    testSlot: (o["test-slot"] ?? process.env.PI_EVAL_TEST_SLOT ?? "") ? [o["test-slot"] ?? process.env.PI_EVAL_TEST_SLOT] : null,
    radiance: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model, contextTokens, maxTokens: positive(o["max-tokens"], "max-tokens"), reasoningTokens: positive(o["reasoning-tokens"], "reasoning-tokens") },
  };
  const gate = radianceGate({ model, maxWaitMs: Number(o["idle-wait-minutes"] ?? 30) * 60_000, log });
  const resultsFile = join(resultsDir, "worker-results.jsonl");
  log(`${batchId}: ${jobs.length} run(s) through the real worker, results ${resultsFile}`);
  const { records, stopped } = await runBatch({ jobs, concurrency: 1, gate, tokenBudget: Infinity, log, runJob: (t, v, r, opts) => runWorkerOne(ctx, t, v, r, opts), onRecord: (rec) => appendJsonl(resultsFile, rec) });
  const rep = renderReport(records, { title: `W09: the bench through the real worker, ${batchId}` });
  const route = { provider: "radiance", model, kind: "radiance" };
  const blocker = records.some((x) => x.variant === SHIPPED_VARIANT) ? await releaseBlocker({ records, resultsDir, batchId, benchCommit, route }) : null;
  const tail = [`\nbatch: ${records.length} of ${jobs.length} run(s); bench commit ${benchCommit}; route radiance/${model}`];
  const noFileTools = fileToolsLine(records);
  if (noFileTools !== null) tail.push(noFileTools);
  if (stopped !== null) tail.push(`batch stopped early: ${stopped.reason}; ${stopped.remaining} run(s) not started`);
  if (blocker !== null) tail.push(blocker.pass ? `release gate (variant ${SHIPPED_VARIANT}): PASS` : `release gate (variant ${SHIPPED_VARIANT}): FAIL, release blocker written to ${blocker.json}`);
  rep.text += tail.join("\n");
  await writeFile(join(resultsDir, `${batchId}-report.md`), `${rep.text}\n`);
  process.stdout.write(`${rep.text}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
}

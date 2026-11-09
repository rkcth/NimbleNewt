#!/usr/bin/env node
// The Pi completion bench (card W01). One command runs it:
//   node scripts/pi-eval/run.mjs                      every task, variants A and B, the task set's repeats, then the report
// Options:
//   --tasks id,id        only these tasks            --variants A,B   which variants (C and D need W04 and are refused)
//   --repeats N          runs per task and variant   --concurrency N  parallel runs (default 1, at most 3: Pi's limit on Radiance)
//   --results DIR        where results go (default /srv/code/worktrees-pi/eval-results, or PI_EVAL_RESULTS)
//   --work-root DIR      where throwaway checkouts go (default eval-work beside the results, or PI_EVAL_WORK_ROOT)
//   --repo DIR           the repository that holds the base and solution commits (default: this checkout)
//   --deps-from DIR      where node_modules are copied from (default: --repo)
//   --agent CMD          the agent: a .mjs/.js file run with this Node, or an executable (default pi-agent.mjs)
//   --timeout-minutes N  override every task's wall-clock limit
//   --taskset FILE       default taskset.json beside this file
//   --calibrate          no agent: check each task's hidden tests fail at its base and pass at its solution
//   --keep               keep the throwaway checkouts      --dry-run  print what would run
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendJsonl, calibrateOne, runOne } from "./lib/runner.mjs";
import { renderReport } from "./lib/stats.mjs";
import { loadTaskset } from "./lib/taskset.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MAX_CONCURRENCY = 3;

export function parseArgs(argv) {
  const o = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (["calibrate", "keep", "dry-run", "no-report", "help"].includes(k)) { o.flags.add(k); continue; }
    const v = inline ?? argv[++i];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    o[k] = v;
  }
  return o;
}

const defaultRoot = (envName, sub) => process.env[envName] || (existsSync("/srv/code/worktrees-pi") ? join("/srv/code/worktrees-pi", sub) : join(here, "..", "..", "..", "pi-eval", sub));

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.flags.has("help")) { process.stdout.write((await readFile(fileURLToPath(import.meta.url), "utf8")).split("\n").filter((l) => l.startsWith("//")).join("\n") + "\n"); return 0; }
  const set = loadTaskset(resolve(o.taskset ?? join(here, "taskset.json")));
  const repo = resolve(o.repo ?? execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  // Other checkouts of this repository hold the solution: a run whose tool calls name one is flagged contaminated.
  const referenceDirs = [repo];
  try { referenceDirs.push(dirname(resolve(repo, execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim()))); } catch { /* no git */ }
  const resultsDir = resolve(o.results ?? defaultRoot("PI_EVAL_RESULTS", "eval-results"));
  // A directory of its own, so an agent that lists its parent sees other eval runs, not the worktrees holding merged solutions.
  const workRoot = resolve(o["work-root"] ?? (process.env.PI_EVAL_WORK_ROOT || join(dirname(resultsDir), "eval-work")));
  const concurrency = Number(o.concurrency ?? 1);
  if (!(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= MAX_CONCURRENCY)) throw new Error(`--concurrency must be 1..${MAX_CONCURRENCY} (Radiance is shared; Pi's limit is ${MAX_CONCURRENCY})`);
  const only = o.tasks ? new Set(o.tasks.split(",")) : null;
  const tasks = set.tasks.filter((t) => only === null || only.has(t.id));
  if (only !== null) for (const id of only) if (!set.tasks.some((t) => t.id === id)) throw new Error(`no task ${id} in the task set`);
  const variants = (o.variants ?? "A,B").split(",");
  for (const v of variants) {
    const spec = set.variants[v];
    if (spec === undefined) throw new Error(`no variant ${v}`);
    if (spec.needs) { process.stderr.write(`variant ${v} needs ${spec.needs}: not runnable yet (${spec.about})\n`); return 2; }
  }
  const repeats = Number(o.repeats ?? set.repeats);
  let benchCommit = "unknown";
  try { benchCommit = execFileSync("git", ["-C", here, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() + (execFileSync("git", ["-C", here, "status", "--porcelain", "--", "."], { encoding: "utf8" }).trim() ? "+dirty" : ""); } catch { /* not a checkout */ }
  const agentPath = o.agent ? (isAbsolute(o.agent) ? o.agent : resolve(o.agent)) : join(here, "pi-agent.mjs");
  const agent = /\.(m?js)$/.test(agentPath) ? ["node", agentPath] : [agentPath];
  const batchId = `batch-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}`;
  await mkdir(resultsDir, { recursive: true });
  await mkdir(workRoot, { recursive: true });
  const children = new Set();
  const activeDirs = new Set();
  const ctx = {
    set, repo, referenceDirs: [...new Set(referenceDirs)], depsFrom: resolve(o["deps-from"] ?? repo), workRoot, resultsDir, agent, agentLabel: agentPath, batchId, benchCommit, children, activeDirs,
    keep: o.flags.has("keep"), timeoutMinutes: o["timeout-minutes"] ? Number(o["timeout-minutes"]) : undefined,
    log: (m) => process.stderr.write(`${new Date().toISOString()} ${m}\n`),
  };
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
    for (const c of children) { if (c.exitCode !== null || c.signalCode !== null) continue; try { process.kill(-c.pid, "SIGTERM"); } catch { try { c.kill(); } catch { /* gone */ } } }
    // An interrupted batch leaves no checkout behind (each holds a copy of node_modules), unless --keep.
    if (!ctx.keep) for (const d of activeDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } }
    process.exit(130);
  });

  if (o.flags.has("calibrate")) {
    let ok = true;
    for (const t of tasks) {
      ctx.log(`calibrating ${t.id}`);
      const r = await calibrateOne(ctx, t);
      await appendJsonl(join(resultsDir, "calibration.jsonl"), r);
      ok &&= r.ok;
      process.stdout.write(`${t.id}: ${r.ok ? "ok" : "NOT OK"} (base ${r.base ? `${r.base.pass}/${r.base.tests} pass` : "-"}, solution ${r.solution ? `${r.solution.pass}/${r.solution.tests} pass` : "-"})${r.error ? ` ${r.error}` : ""}\n`);
    }
    return ok ? 0 : 1;
  }

  const jobs = [];
  for (const t of tasks) for (const v of variants) for (let r = 1; r <= repeats; r++) jobs.push([t, v, r]);
  if (o.flags.has("dry-run")) {
    for (const [t, v, r] of jobs) process.stdout.write(`${t.id} (${t.size}) variant ${v} repeat ${r}: base ${t.base.slice(0, 8)}, ${t.testFiles.length} hidden test file(s), limit ${ctx.timeoutMinutes ?? t.timeoutMinutes} min\n`);
    process.stdout.write(`${jobs.length} run(s), concurrency ${concurrency}, results ${resultsDir}, checkouts ${workRoot}, agent ${agentPath}\n`);
    return 0;
  }
  const resultsFile = join(resultsDir, "results.jsonl");
  ctx.log(`${batchId}: ${jobs.length} run(s), concurrency ${concurrency}, results ${resultsFile}`);
  const records = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const [t, v, r] = jobs[next++];
      const rec = await runOne(ctx, t, v, r);
      records.push(rec);
      await appendJsonl(resultsFile, rec);
    }
  }));
  if (!o.flags.has("no-report")) {
    const rep = renderReport(records, { title: `Pi completion bench ${batchId}` });
    await writeFile(join(resultsDir, `${batchId}-report.md`), `${rep.text}\n`);
    process.stdout.write(`${rep.text}\n`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
}

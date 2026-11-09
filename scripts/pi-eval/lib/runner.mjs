// One bench run (card W01): a throwaway repository at the task's base commit with the hidden tests out of it, the agent
// under a wall-clock limit, then the hidden tests copied in and run, and the ending classified.
// Windows-safe: commands are spawned without a shell, paths are built with node:path, and the agent is stopped with
// child.kill() where process groups do not exist.
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { classify, planProgress, summarizeLogFile, testCounts } from "./classify.mjs";
import { expandArgv, renderPrompt } from "./taskset.mjs";

const IS_WIN = process.platform === "win32";

/** git with arguments, no shell. Resolves { code, stdout, stderr }; never throws for a non-zero exit. */
export function git(args, { cwd, input, encoding = "utf8" } = {}) {
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd, encoding, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr: String(stderr ?? "") }));
    if (input !== undefined) child.stdin.end(input);
  });
}

async function mustGit(args, opts) {
  const r = await git(args, opts);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim().slice(0, 500)}`);
  return r.stdout;
}

/**
 * Runs a command (argv, no shell) with an optional wall-clock limit, writing its output to `outFile`.
 * "node" as argv[0] means this Node. On a timeout the whole process group is stopped (POSIX), or the child (Windows).
 */
export function runCommand(argv, { cwd, env, timeoutMs, outFile, onSpawn } = {}) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const exe = cmd === "node" ? process.execPath : cmd;
    const out = outFile ? createWriteStream(outFile) : null;
    let tail = "";
    const keep = (b) => { tail = (tail + b.toString("utf8")).slice(-200_000); out?.write(b); };
    let child;
    try {
      // A bench started from inside `node --test` must not hand its test-runner context to the commands it runs.
      const childEnv = { ...process.env, ...env };
      delete childEnv.NODE_TEST_CONTEXT;
      child = spawn(exe, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: !IS_WIN });
    } catch (e) {
      out?.end();
      resolve({ code: null, signal: null, timedOut: false, output: String(e), error: String(e) });
      return;
    }
    onSpawn?.(child);
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    let timer = null, killer = null;
    const stop = (sig) => {
      try { if (IS_WIN) child.kill(sig); else process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; stop("SIGTERM"); killer = setTimeout(() => stop("SIGKILL"), 10_000); }, timeoutMs);
    child.on("error", (e) => { keep(Buffer.from(`\n[spawn error] ${e.message}\n`)); });
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(killer);
      const done = () => resolve({ code, signal, timedOut, output: tail });
      if (out) out.end(done); else done();
    });
  });
}

/** Expands copy patterns with at most one `*` path segment (e.g. packages/star/node_modules) against `from`. */
export async function expandCopy(from, patterns) {
  const out = [];
  for (const p of patterns) {
    const parts = p.split("/");
    const star = parts.indexOf("*");
    if (star < 0) { if (existsSync(join(from, ...parts))) out.push(parts); continue; }
    let names = [];
    try { names = await readdir(join(from, ...parts.slice(0, star))); } catch { continue; }
    for (const n of names.sort()) {
      const rel = [...parts.slice(0, star), n, ...parts.slice(star + 1)];
      if (existsSync(join(from, ...rel))) out.push(rel);
    }
  }
  return out;
}

/**
 * Makes a fresh repository at `commit` that holds only that commit's history: the solution and every later commit are not
 * in it, so neither `git log --all` nor `git show` can reach the hidden tests. Dependencies are copied from `depsFrom`.
 */
export async function prepareCheckout({ repo, commit, dir, copy = [], depsFrom, forbidden = [] }) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await mustGit(["init", "-q", dir]);
  await mustGit(["-C", dir, "fetch", "-q", "--no-tags", repo, commit]);
  await mustGit(["-C", dir, "checkout", "-q", "-B", "eval", commit]);
  await mustGit(["-C", dir, "config", "user.name", "Pi eval agent"]);
  await mustGit(["-C", dir, "config", "user.email", "pi-eval@localhost"]);
  for (const sha of forbidden) {
    const r = await git(["-C", dir, "cat-file", "-e", `${sha}^{commit}`]);
    if (r.code === 0) throw new Error(`the checkout for ${commit} can reach ${sha}: the hidden tests would be visible`);
  }
  for (const rel of await expandCopy(depsFrom, copy)) await cp(join(depsFrom, ...rel), join(dir, ...rel), { recursive: true, verbatimSymlinks: true, force: true });
}

/** Writes the solution's version of each hidden file into the checkout. */
export async function copyHidden({ repo, solution, files, dir }) {
  for (const f of files) {
    const body = await mustGit(["-C", repo, "show", `${solution}:${f}`], { encoding: "buffer" });
    const target = join(dir, ...f.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
}

/** True when a hidden file in the checkout already holds the solution's content (a leak). */
async function leakedHidden({ repo, solution, files, dir }) {
  const leaked = [];
  for (const f of files) {
    const p = join(dir, ...f.split("/"));
    if (!existsSync(p)) continue;
    const sol = await mustGit(["-C", repo, "show", `${solution}:${f}`], { encoding: "buffer" });
    if (Buffer.compare(readFileSync(p), sol) === 0) leaked.push(f);
  }
  return leaked;
}

/** Builds, then runs the task's tests on the checkout. passed only on exit 0 with tests counted and none failing. */
export async function runHiddenTests({ task, dir, artifacts }) {
  const worktreeUrl = pathToFileURL(dir).href;
  const started = Date.now();
  let setupCode = null;
  if (task.setup) {
    const s = await runCommand(expandArgv(task.setup.argv, { worktree: dir, worktreeUrl }), { cwd: join(dir, ...(task.setup.cwd ?? ".").split("/")), env: task.setup.env, timeoutMs: 20 * 60_000, outFile: join(artifacts, "hidden-setup.log") });
    setupCode = s.code;
  }
  const t = task.test;
  const r = await runCommand(expandArgv(t.argv, { worktree: dir, worktreeUrl, testFiles: task.testFiles }), { cwd: join(dir, ...(t.cwd ?? ".").split("/")), env: t.env, timeoutMs: (t.timeoutMinutes ?? 30) * 60_000, outFile: join(artifacts, "hidden-tests.log") });
  const counts = testCounts(r.output);
  return { ran: true, passed: r.code === 0 && !r.timedOut && (counts.tests ?? 0) > 0 && counts.fail === 0, exitCode: r.code, timedOut: r.timedOut, setupExitCode: setupCode, ...counts, durationMs: Date.now() - started };
}

/** Whether the agent left anything: a commit past the base, or an uncommitted change. */
async function changesOf(dir, base) {
  const ahead = Number((await git(["-C", dir, "rev-list", "--count", `${base}..HEAD`])).stdout.trim()) || 0;
  const status = (await git(["-C", dir, "status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude)PLAN.md"])).stdout.trim();
  const stat = (await git(["-C", dir, "diff", "--stat", base])).stdout.trim();
  return { commitsAhead: ahead, dirty: status !== "", changed: ahead > 0 || status !== "", diffStat: stat.split("\n").slice(-1)[0] ?? "", fullStat: stat };
}

/**
 * One run of one task in one variant. Returns the result record (also appended to results.jsonl by the caller).
 * ctx: { set, repo, depsFrom, workRoot, resultsDir, agent, batchId, benchCommit, keep, log }
 */
export async function runOne(ctx, task, variantName, repeat) {
  const variant = ctx.set.variants[variantName];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const runId = `${task.id}-${variantName}-r${repeat}-${stamp}`;
  const dir = join(ctx.workRoot, `eval-${runId}`);
  const artifacts = join(ctx.resultsDir, "runs", runId);
  await mkdir(artifacts, { recursive: true });
  const record = {
    runId, batchId: ctx.batchId, taskId: task.id, size: task.size, variant: variantName, repeat,
    base: task.base, solution: task.solution, benchCommit: ctx.benchCommit,
    route: { provider: ctx.set.agent.provider, model: ctx.set.agent.model, thinking: ctx.set.agent.thinking ?? null },
    agent: ctx.agentLabel, startedAt: null, endedAt: null, wallMs: null, exitCode: null, timedOut: false,
    nudges: 0, artifacts,
  };
  const log = (m) => ctx.log?.(`[${runId}] ${m}`);
  try {
    log(`preparing ${dir} at ${task.base.slice(0, 8)}`);
    await prepareCheckout({ repo: ctx.repo, commit: task.base, dir, copy: task.copy, depsFrom: ctx.depsFrom, forbidden: [task.solution] });
    const leaked = await leakedHidden({ repo: ctx.repo, solution: task.solution, files: task.hiddenFiles, dir });
    if (leaked.length > 0) throw new Error(`hidden files already present at the base: ${leaked.join(", ")}`);
    if (task.setup) {
      const s = await runCommand(expandArgv(task.setup.argv, { worktree: dir, worktreeUrl: pathToFileURL(dir).href }), { cwd: join(dir, ...(task.setup.cwd ?? ".").split("/")), env: task.setup.env, timeoutMs: 20 * 60_000, outFile: join(artifacts, "setup.log") });
      record.setupExitCode = s.code;
    }
    const template = await readFile(variant.promptPath, "utf8");
    const prompt = renderPrompt(template, { task, taskText: await readFile(task.promptPath, "utf8"), worktreeUrl: pathToFileURL(dir).href });
    const promptFile = join(artifacts, "prompt.md");
    await writeFile(promptFile, prompt);
    const logFile = join(artifacts, "agent.jsonl");
    log(`agent started (limit ${task.timeoutMinutes} min)`);
    record.startedAt = new Date().toISOString();
    const t0 = Date.now();
    const a = await runCommand([...ctx.agent, dir, promptFile, logFile], {
      cwd: dir, timeoutMs: (ctx.timeoutMinutes ?? task.timeoutMinutes) * 60_000, outFile: join(artifacts, "agent-stderr.log"),
      env: { PI_EVAL_PROVIDER: ctx.set.agent.provider, PI_EVAL_MODEL: ctx.set.agent.model, PI_EVAL_THINKING: ctx.set.agent.thinking ?? "medium", ...(ctx.agentEnv ?? {}) },
      onSpawn: (child) => ctx.children?.add(child),
    });
    record.wallMs = Date.now() - t0;
    record.endedAt = new Date().toISOString();
    record.exitCode = a.code;
    record.timedOut = a.timedOut;
    log(`agent ended after ${(record.wallMs / 60000).toFixed(1)} min (exit ${a.code}${a.timedOut ? ", timed out" : ""})`);
    const summary = await summarizeLogFile(logFile);
    const plan = existsSync(join(dir, "PLAN.md")) ? planProgress(readFileSync(join(dir, "PLAN.md"), "utf8")) : null;
    const ch = await changesOf(dir, task.base);
    await writeFile(join(artifacts, "diffstat.txt"), `${ch.fullStat}\n`);
    log("copying the hidden tests in and running them");
    await copyHidden({ repo: ctx.repo, solution: task.solution, files: task.hiddenFiles, dir });
    const hidden = await runHiddenTests({ task, dir, artifacts });
    const marks = [...(ctx.referenceDirs ?? [ctx.repo]), task.solution.slice(0, 8), ctx.resultsDir].filter(Boolean);
    const contaminated = summary.toolCommands.some((c) => marks.some((m) => c.includes(m)));
    const verdict = classify({ summary, hidden, plan, changed: ch.changed, timedOut: a.timedOut, exitCode: a.code });
    Object.assign(record, verdict, {
      stopReason: summary.last?.stopReason ?? null, visibleChars: summary.last?.visibleChars ?? 0, lastText: summary.last?.visibleTail.slice(-300) ?? "",
      turns: summary.turns, toolCalls: summary.toolCalls, tokens: summary.tokens, sessionId: summary.sessionId,
      plan, commitsAhead: ch.commitsAhead, dirty: ch.dirty, changed: ch.changed, diffStat: ch.diffStat, hidden, contaminated,
    });
  } catch (e) {
    Object.assign(record, { outcome: "error", reason: `bench error: ${String(e?.message ?? e).slice(0, 500)}`, benchError: true });
  } finally {
    if (!ctx.keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  log(`=> ${record.outcome}: ${record.reason}`);
  return record;
}

/** Checks a task without an agent: the hidden tests must fail at the base and pass at the solution. */
export async function calibrateOne(ctx, task) {
  const dir = join(ctx.workRoot, `eval-calibrate-${task.id}`);
  const artifacts = join(ctx.resultsDir, "calibration", task.id);
  await mkdir(join(artifacts, "base"), { recursive: true });
  await mkdir(join(artifacts, "solution"), { recursive: true });
  const out = { taskId: task.id, at: new Date().toISOString(), benchCommit: ctx.benchCommit };
  try {
    await prepareCheckout({ repo: ctx.repo, commit: task.base, dir, copy: task.copy, depsFrom: ctx.depsFrom, forbidden: [task.solution] });
    await copyHidden({ repo: ctx.repo, solution: task.solution, files: task.hiddenFiles, dir });
    out.base = await runHiddenTests({ task, dir, artifacts: join(artifacts, "base") });
    await mustGit(["-C", dir, "fetch", "-q", "--no-tags", ctx.repo, task.solution]);
    await mustGit(["-C", dir, "checkout", "-q", "-f", task.solution]);
    out.solution = await runHiddenTests({ task, dir, artifacts: join(artifacts, "solution") });
    out.ok = out.base.passed === false && out.solution.passed === true;
  } catch (e) {
    out.ok = false; out.error = String(e?.message ?? e).slice(0, 500);
  } finally {
    if (!ctx.keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return out;
}

export const appendJsonl = (file, obj) => appendFile(file, `${JSON.stringify(obj)}\n`);

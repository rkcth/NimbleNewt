// One bench run (card W01): a throwaway repository at the task's base commit with the hidden tests out of it, the agent
// under a wall-clock limit, then the hidden tests copied in and run, and the ending classified.
// Windows-safe: commands are spawned without a shell, paths are built with node:path, and the agent is stopped with
// child.kill() where process groups do not exist.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classify, planProgress, summarizeLogFile, testCounts } from "./classify.mjs";
import { guardLogCounts } from "./git-guard.mjs";
import { PRIVATE_DIRS, SYSTEM_ROOTS, bwrapPrefix, credentialAttempts, credentialPaths, defaultHidden, findRealGit, installRoot, prepareIsolation, sandboxUsable, workRootHidden } from "./isolation.mjs";
import { withSlot } from "./slot.mjs";
import { toolCallTexts } from "./tool-args.mjs";
import { readCorpus, specFit } from "./specfit.mjs";
import { COMPLETION_RULES_PLACEHOLDER, expandArgv, loadCompletionRules, loadContinuationConfig, renderPrompt } from "./taskset.mjs";

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
 * `inheritEnv: false` gives the command `env` alone (an agent's isolated environment), not this process's plus `env`.
 */
export function runCommand(argv, { cwd, env, timeoutMs, outFile, onSpawn, inheritEnv = true } = {}) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const exe = cmd === "node" ? process.execPath : cmd;
    const out = outFile ? createWriteStream(outFile) : null;
    let tail = "";
    const keep = (b) => { tail = (tail + b.toString("utf8")).slice(-200_000); out?.write(b); };
    let child;
    try {
      // A bench started from inside `node --test` must not hand its test-runner context to the commands it runs.
      const childEnv = inheritEnv ? { ...process.env, ...env } : { ...env };
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

/** The files `tsc` reported errors in (`path(line,col): error TS...`), repository-relative with forward slashes. */
export function tscErrorFiles(output) {
  const files = new Set();
  for (const m of String(output).matchAll(/^([^\s(][^(\n]*?)\(\d+,\d+\): error TS\d+/gm)) files.add(m[1].replace(/\\/g, "/").replace(/^\.\//, ""));
  return [...files].sort();
}

/**
 * The suite a run is scored on. With an acceptance suite: its bench-owned files (written at fresh paths) plus support
 * files from the solution. Without one (older task sets): the shipped hidden files, as before.
 */
export const scoredSuite = (task) => task.acceptance
  ? { label: "acceptance", hiddenFiles: [...task.acceptance.files.map((f) => f.dest), ...task.acceptance.support], testFiles: task.acceptance.testFiles, testNamePatterns: task.acceptance.testNamePatterns ?? [] }
  : { label: "hidden", hiddenFiles: task.hiddenFiles, testFiles: task.testFiles, testNamePatterns: [] };

/** Writes the acceptance suite into the checkout: the bench's own files, and the support files from the solution. */
export async function copyAcceptance({ repo, task, dir }) {
  for (const f of task.acceptance.files) {
    const target = join(dir, ...f.dest.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(f.src));
  }
  if (task.acceptance.support.length > 0) await copyHidden({ repo, solution: task.solution, files: task.acceptance.support, dir });
}

/**
 * Builds, then runs one suite's tests on the checkout. passed only on a clean build and exit 0 with tests counted and
 * none failing. `interfaceMismatch`: the build failed and every type error is in the suite's own files, i.e. the tests
 * do not type-check against the agent's code (a name, field or signature differs), as opposed to the agent's own code
 * not building. Logs go to `<prefix>-setup.log` and `<prefix>-tests.log`.
 */
export async function runSuite({ task, suite, dir, artifacts, prefix = "hidden", onSpawn, env = {} }) {
  const worktreeUrl = pathToFileURL(dir).href;
  const started = Date.now();
  let setupCode = null, errorFiles = [];
  if (task.setup) {
    const s = await runCommand(expandArgv(task.setup.argv, { worktree: dir, worktreeUrl }), { cwd: join(dir, ...(task.setup.cwd ?? ".").split("/")), env: { ...task.setup.env, ...env }, timeoutMs: 20 * 60_000, outFile: join(artifacts, `${prefix}-setup.log`), onSpawn });
    setupCode = s.code;
    errorFiles = tscErrorFiles(s.output);
  }
  const t = task.test;
  const testFiles = [...(suite.testNamePatterns ?? []).map((p) => `--test-name-pattern=${p}`), ...suite.testFiles];
  const r = await runCommand(expandArgv(t.argv, { worktree: dir, worktreeUrl, testFiles }), { cwd: join(dir, ...(t.cwd ?? ".").split("/")), env: { ...t.env, ...env }, timeoutMs: (t.timeoutMinutes ?? 30) * 60_000, outFile: join(artifacts, `${prefix}-tests.log`), onSpawn });
  const counts = testCounts(r.output);
  // The build must succeed too: tsc emits despite type errors, and a hidden test file the agent's code does not typecheck
  // against (or a stale dist file left by an agent-written test of the same name) must never count as a pass.
  const built = setupCode === null || setupCode === 0;
  const own = new Set(suite.hiddenFiles);
  const interfaceMismatch = !built && errorFiles.length > 0 && errorFiles.every((f) => own.has(f));
  return { ran: true, passed: built && r.code === 0 && !r.timedOut && (counts.tests ?? 0) > 0 && counts.fail === 0, built, interfaceMismatch, typeErrorFiles: errorFiles.slice(0, 20), exitCode: r.code, timedOut: r.timedOut, setupExitCode: setupCode, ...counts, durationMs: Date.now() - started };
}

/** The scored suite of a task (see scoredSuite), its logs named hidden-*.log as before. */
export const runHiddenTests = ({ task, dir, artifacts, onSpawn, env }) => runSuite({ task, suite: scoredSuite(task), dir, artifacts, prefix: "hidden", onSpawn, env });

/** The environment variable every command the runner starts for a run carries, set to the run's checkout. */
export const RUN_MARK = "PI_EVAL_RUN_DIR";

/**
 * Stops every process left over from a run (Linux: read from /proc). Pi starts its bash tools in their own process
 * groups, so stopping the agent's group can leave a hung test run or a background server behind; it must not keep writing
 * into the checkout while the hidden tests run, nor outlive the run. A process is the run's when
 *   - its working directory is `dir` itself or below it (a sibling `dir`-prefixed directory does not), compared on the
 *     real path, since /proc reports resolved paths; or
 *   - its environment carries `PI_EVAL_RUN_DIR=<dir>` (every command the runner starts gets it, and children inherit it:
 *     an embedded PostgreSQL a test started works in its own data directory under /tmp, not in the checkout); or
 *   - it descends from such a process (PostgreSQL's helper processes rewrite their environment area for `ps`).
 * This process and its ancestors are never signalled. Synchronous, so an exit handler can use it. Returns the PIDs
 * signalled. Elsewhere (no /proc) a no-op that returns [].
 */
export function killProcessesInSync(dir) {
  if (process.platform !== "linux") return [];
  const given = resolve(dir);
  let root = given;
  try { root = realpathSync(root); } catch { /* gone: match the path as given */ }
  if (root === sep) return []; // never "every process"
  const marks = [...new Set([given, root])].map((d) => Buffer.from(`\0${RUN_MARK}=${d}\0`));
  let pids = [];
  try { pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number); } catch { return []; }
  const parent = new Map();
  const matched = new Set();
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      parent.set(pid, Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch { continue; } // gone
    let cwd = null;
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* another user's process */ }
    if (cwd !== null && (cwd === root || cwd.startsWith(root + sep))) { matched.add(pid); continue; }
    try {
      const env = Buffer.concat([Buffer.from([0]), readFileSync(`/proc/${pid}/environ`), Buffer.from([0])]);
      if (marks.some((m) => env.includes(m))) matched.add(pid);
    } catch { /* not readable */ }
  }
  // Never this process or the ones that started it (a bench started from inside a marked shell must not stop itself).
  const protectedPids = new Set();
  for (let p = process.pid; p > 1 && !protectedPids.has(p); p = parent.get(p) ?? 0) protectedPids.add(p);
  const victims = new Set();
  for (const pid of parent.keys()) {
    for (let p = pid, hops = 0; p > 1 && hops < 64; p = parent.get(p) ?? 0, hops++) if (matched.has(p)) { victims.add(pid); break; }
  }
  const killed = [];
  for (const pid of [...victims].sort((a, b) => a - b)) {
    if (protectedPids.has(pid)) continue;
    try { process.kill(pid, "SIGKILL"); killed.push(pid); } catch { /* gone or not ours */ }
  }
  return killed;
}

export const killProcessesIn = async (dir) => killProcessesInSync(dir);

const ABS_PATH = /(?:~\/|\/)[A-Za-z0-9._@+~-][^\s"'`;|&<>(){}\\,]*/g;

/**
 * Whether a call's command or path fields name one of the marks (a reference checkout, the solution commit's prefix, the
 * results folder). File content and edit text are not read; a cut text only up to where it was cut.
 */
export function namesMark(commands, marks) {
  return commands.some((entry) => { const t = toolCallTexts(entry); return [...t.commands, ...t.paths, ...(t.patterns ?? [])].some(({ text }) => marks.some((m) => text.includes(m))); });
}

/**
 * Absolute paths named in the agent's tool calls that lie where a solution can be: anywhere under the reference
 * repository, its checkouts' parent directories, the results, or the user's home (transcripts, other tools' runs), other
 * than the run's own checkout. Detection only: a path built at run time, a relative `../` walk or a search from `/`
 * is not seen here.
 *   commands: one entry per call, summary.toolTexts (read from the full parsed arguments) or an argument JSON string
 *   (older records); see lib/tool-args.mjs. Only commands and path fields are searched, never file content or edit text.
 *   A path that runs to the end of a text cut at a size limit is only partly known: it is flagged only when what is
 *   visible already lies outside the run's own checkout (a cut `/srv/.../eval-wor` could still be the checkout).
 */
export function foreignPaths(commands, { ownDir, watched = [] }) {
  // The agent may name its checkout by its real path (pwd through a symlinked work root): both spellings are its own.
  const owns = [resolve(ownDir)];
  try { owns.push(realpathSync(owns[0])); } catch { /* removed already */ }
  const home = homedir();
  const piInstall = join(home, ".local", "pi-cli", "node_modules");
  const roots = [...new Set([...watched, home].filter(Boolean).map((w) => resolve(w)))];
  const found = new Set();
  for (const entry of commands) {
    const t = toolCallTexts(entry);
    for (const { text, cut } of [...t.commands, ...t.paths, ...(t.patterns ?? [])]) {
      for (const m of text.matchAll(ABS_PATH)) {
        const partial = cut && m.index + m[0].length === text.length;
        const raw = partial ? m[0] : m[0].replace(/[.:]+$/, "");
        const p = raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
        if (owns.some((own) => p === own || p.startsWith(own + "/"))) continue;
        if (p.startsWith(piInstall)) continue; // Pi's own install
        // A cut path that may still go on to be the run's checkout or Pi's install is not known to be foreign.
        if (partial && (owns.some((own) => own.startsWith(p)) || piInstall.startsWith(p))) continue;
        if (roots.some((r) => p === r || p.startsWith(r + "/")) || /^\/(?:srv|home|root)\/?$/.test(p)) found.add(p);
      }
    }
  }
  return [...found].slice(0, 20);
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
 * ctx: { set, repo, depsFrom, workRoot, resultsDir, agent, batchId, benchCommit, keep, log }; beforeAgent (the batch's
 * Radiance gate) is awaited right before the agent starts, and a refusal leaves record.gateRefused set, the agent unstarted.
 */
export async function runOne(ctx, task, variantName, repeat, { beforeAgent } = {}) {
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
    agent: ctx.agentLabel, agentPath: ctx.agentPath ?? ctx.agentLabel, startedAt: null, endedAt: null, wallMs: null, exitCode: null, timedOut: false,
    nudges: 0, artifacts,
  };
  const log = (m) => ctx.log?.(`[${runId}] ${m}`);
  const mark = { [RUN_MARK]: dir };
  ctx.activeDirs?.add(dir);
  let iso = null;
  try {
    log(`preparing ${dir} at ${task.base.slice(0, 8)}`);
    await prepareCheckout({ repo: ctx.repo, commit: task.base, dir, copy: task.copy, depsFrom: ctx.depsFrom, forbidden: [task.solution] });
    const leaked = await leakedHidden({ repo: ctx.repo, solution: task.solution, files: [...task.hiddenFiles, ...(task.acceptance?.support ?? [])], dir });
    if (leaked.length > 0) throw new Error(`hidden files already present at the base: ${leaked.join(", ")}`);
    if (task.setup) {
      // The bench's own build holds a test slot when one is given (ctx.testSlot); the agent's work never does.
      const s = await withSlot(ctx.testSlot, () => runCommand(expandArgv(task.setup.argv, { worktree: dir, worktreeUrl: pathToFileURL(dir).href }), { cwd: join(dir, ...(task.setup.cwd ?? ".").split("/")), env: { ...task.setup.env, ...mark }, timeoutMs: 20 * 60_000, outFile: join(artifacts, "setup.log"), onSpawn: (child) => ctx.children?.add(child) }), { log });
      record.setupExitCode = s.code;
    }
    const template = await readFile(variant.promptPath, "utf8");
    // Card W06: a variant whose prompt carries the agents' completion rules gets the words the worker sends, and the run records which text it was (digest and size).
    let completionRules;
    if (template.includes(COMPLETION_RULES_PLACEHOLDER)) {
      completionRules = ctx.completionRules ?? await loadCompletionRules();
      record.completionRules = { sha256: createHash("sha256").update(completionRules).digest("hex").slice(0, 16), chars: completionRules.length };
    }
    const prompt = renderPrompt(template, { task, taskText: await readFile(task.promptPath, "utf8"), worktreeUrl: pathToFileURL(dir).href, completionRules });
    const promptFile = join(artifacts, "prompt.md");
    await writeFile(promptFile, prompt);
    const logFile = join(artifacts, "agent.jsonl");
    // Card W04 (variant C): the continuation's words and bound go to the agent in a file of the run's artifacts; the agent's
    // extension writes its counts beside the log (continuation.json) and they come back into the record.
    const continuationEnv = {};
    if (variant.continuation === true) {
      const config = ctx.continuation ?? await loadContinuationConfig();
      const configFile = join(artifacts, "continuation-config.json");
      await writeFile(configFile, `${JSON.stringify(config)}\n`);
      continuationEnv.PI_EVAL_CONTINUATION_CONFIG = configFile;
      continuationEnv.PI_EVAL_CONTINUATION_FILE = join(artifacts, "continuation.json");
      record.continuation = { max: config.max, installed: false };
    }
    // The shared-server gate, asked again right here: preparing, the setup build and a test-slot wait can take minutes,
    // so the reading taken before them is not the one the agent starts on. A refusal starts nothing (runBatch stops).
    if (beforeAgent) {
      const g = await beforeAgent();
      if (!g.ok) { record.gateRefused = String(g.why ?? "refused"); throw new Error(`the Radiance gate refused the agent start: ${record.gateRefused}`); }
    }
    // The agent's isolation (README "The agent's isolation"): a fresh home and environment, git that cannot push out, the
    // model key kept in the bench, and on Linux the owner's folders hidden. Without the hiding no agent starts, unless the
    // operator said so (ctx.allowVisibleHome, --allow-visible-home).
    iso = await isolateAgent(ctx, { dir, artifacts });
    record.isolation = iso.summary;
    log(`agent started (limit ${task.timeoutMinutes} min)`);
    record.startedAt = new Date().toISOString();
    const t0 = Date.now();
    const a = await runCommand([...iso.prefix, ...ctx.agent.map((x, i) => (i === 0 && x === "node" ? process.execPath : x)), dir, promptFile, logFile], {
      cwd: dir, timeoutMs: (ctx.timeoutMinutes ?? task.timeoutMinutes) * 60_000, outFile: join(artifacts, "agent-stderr.log"),
      env: { ...iso.env, PI_EVAL_PROVIDER: ctx.set.agent.provider, PI_EVAL_MODEL: ctx.set.agent.model, PI_EVAL_THINKING: ctx.set.agent.thinking ?? "medium", ...continuationEnv, ...(ctx.agentEnv ?? {}), ...mark },
      inheritEnv: false,
      onSpawn: (child) => ctx.children?.add(child),
    });
    record.wallMs = Date.now() - t0;
    record.endedAt = new Date().toISOString();
    record.exitCode = a.code;
    record.timedOut = a.timedOut;
    const stragglers = await killProcessesIn(dir);
    if (stragglers.length > 0) record.stragglersKilled = stragglers.length;
    log(`agent ended after ${(record.wallMs / 60000).toFixed(1)} min (exit ${a.code}${a.timedOut ? ", timed out" : ""})`);
    const summary = await summarizeLogFile(logFile);
    const argClean = readArgClean(join(artifacts, "arg-clean.json"));
    if (argClean) record.argClean = argClean;
    // A variant with the continuation but an agent that never wrote its counts (another agent, or the extension not loaded)
    // keeps installed: false and 0 nudges: the run is not a variant C measurement and says so.
    if (variant.continuation === true) {
      const c = readContinuation(join(artifacts, "continuation.json"));
      if (c) { record.continuation = { ...record.continuation, ...c, installed: true }; record.nudges = c.nudges; }
    }
    const plan = existsSync(join(dir, "PLAN.md")) ? planProgress(readFileSync(join(dir, "PLAN.md"), "utf8")) : null;
    const ch = await changesOf(dir, task.base);
    await writeFile(join(artifacts, "diffstat.txt"), `${ch.fullStat}\n`);
    const onSpawn = (child) => ctx.children?.add(child);
    let hidden, shipped = null;
    await withSlot(ctx.testSlot, async () => {
      if (task.acceptance) {
        // Scored: the acceptance suite alone (only what the prompt pins). Then, for information only, the card's shipped
        // test files, which also carry wording later review rounds settled on.
        log("copying the acceptance tests in and running them");
        await copyAcceptance({ repo: ctx.repo, task, dir });
        hidden = await runHiddenTests({ task, dir, artifacts, onSpawn, env: mark });
        killProcessesInSync(dir);
        log("copying the shipped tests in and running them (informational)");
        await copyHidden({ repo: ctx.repo, solution: task.solution, files: task.hiddenFiles, dir });
        const s = await runSuite({ task, suite: { hiddenFiles: task.hiddenFiles, testFiles: task.testFiles }, dir, artifacts, prefix: "shipped", onSpawn, env: mark });
        shipped = { passed: s.passed, built: s.built, interfaceMismatch: s.interfaceMismatch, tests: s.tests, pass: s.pass, fail: s.fail };
      } else {
        log("copying the hidden tests in and running them");
        await copyHidden({ repo: ctx.repo, solution: task.solution, files: task.hiddenFiles, dir });
        hidden = await runHiddenTests({ task, dir, artifacts, onSpawn, env: mark });
      }
    }, { log });
    const marks = [...(ctx.referenceDirs ?? [ctx.repo]), task.solution.slice(0, 8), ctx.resultsDir].filter(Boolean);
    // Watched roots: the reference checkouts, the directory that holds them (sibling worktrees carry merged solutions),
    // the results, and the work root's siblings. The run's own checkout is never counted.
    const watched = [...(ctx.referenceDirs ?? [ctx.repo]).flatMap((d) => [d, dirname(d)]), ctx.resultsDir, dirname(ctx.workRoot)].filter(Boolean);
    // Read from each call's full parsed arguments (summary.toolTexts, card W01e), not the stored copy cut for size.
    const calls = summary.toolTexts;
    const foreign = foreignPaths(calls, { ownDir: dir, watched });
    // Also a run whose agent tried to push, add a remote or reach the owner's keys and logins, seen in its tool calls or
    // in the git wrapper's refusals: blocked or not, it is not a run to score.
    const attempts = credentialAttempts(calls);
    // A refusal the guard tagged as a project test's own (an askpass or proxy program given by the project's code to a
    // repository its tests made in the temporary folder, card W01d) is still refused but reported apart, not counted.
    let guardRefusals = 0, guardRefusalsInTests = 0;
    try { ({ counted: guardRefusals, inProjectTests: guardRefusalsInTests } = guardLogCounts(readFileSync(join(artifacts, "git-guard.log"), "utf8"))); } catch { /* nothing refused */ }
    const contaminated = foreign.length > 0 || namesMark(calls, marks) || attempts.length > 0 || guardRefusals > 0;
    const verdict = classify({ summary, hidden, plan, changed: ch.changed, dirty: ch.dirty, timedOut: a.timedOut, exitCode: a.code });
    Object.assign(record, verdict, {
      stopReason: summary.last?.stopReason ?? null, visibleChars: summary.last?.visibleChars ?? 0, lastText: summary.last?.visibleTail.slice(-300) ?? "",
      turns: summary.turns, toolCalls: summary.toolCalls, tokens: summary.tokens, sessionId: summary.sessionId, selfTest: summary.lastSelfTest,
      // The log shows no model reply, or a reply without token counts: the run's token use is not known (0 is not a reading).
      ...(summary.assistantMessages === 0 || summary.usageMissing > 0 ? { tokensUnknown: true } : {}),
      plan, commitsAhead: ch.commitsAhead, dirty: ch.dirty, changed: ch.changed, diffStat: ch.diffStat, hidden, shipped, contaminated, foreignPaths: foreign,
      credentialAttempts: attempts, guardRefusals, ...(summary.toolCommandsCut > 0 ? { toolArgsCut: summary.toolCommandsCut } : {}), ...(summary.toolTextsCut > 0 ? { toolTextsCut: summary.toolTextsCut } : {}), ...(guardRefusalsInTests > 0 ? { guardRefusalsInTests } : {}),
    });
  } catch (e) {
    Object.assign(record, { outcome: "error", reason: `bench error: ${String(e?.message ?? e).slice(0, 500)}`, benchError: true });
  } finally {
    await killProcessesIn(dir).catch(() => {});
    // The agent's home and temporary folder go whatever --keep says (they held the agent's Pi configuration).
    if (iso) { await iso.close(); ctx.isoDirs?.delete(iso.base); }
    if (!ctx.keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
    ctx.activeDirs?.delete(dir);
  }
  log(`=> ${record.outcome}: ${record.reason}`);
  return record;
}

/**
 * Card W04: the counts the bench's continuation extension left beside the log (continuation-extension.mjs), or null when it
 * wrote none. Only these fields are taken from the file, as numbers and one flag.
 */
export function readContinuation(file) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  if (raw === null || typeof raw !== "object") return null;
  const n = (k) => (Number.isSafeInteger(raw[k]) && raw[k] >= 0 ? raw[k] : 0);
  return { max: n("max"), nudges: n("nudges"), lengthNudges: n("lengthNudges"), endedByReport: raw.endedByReport === true, errors: n("errors") };
}

/**
 * Card W01b: the counts the bench's Pi extension (arg-clean-extension.mjs) left beside the log, or null when it wrote none
 * (another agent, or Pi without the extension). Only these numeric counts are taken from the file; `applied` says whether
 * any request was repaired.
 */
export function readArgClean(file) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  if (raw === null || typeof raw !== "object") return null;
  const out = {};
  for (const k of ["requests", "requestsChanged", "stringsChanged", "argumentsChanged", "errors"]) out[k] = Number.isSafeInteger(raw[k]) && raw[k] >= 0 ? raw[k] : 0;
  return { applied: out.requestsChanged > 0, ...out };
}

/** Pi's command-line program: PI_EVAL_PI_BIN, else the owner's ~/.local/pi-cli install (resolved by the bench, whose home is real). */
export function piBinOf(ownerHome, env = process.env) {
  const p = env.PI_EVAL_PI_BIN || join(ownerHome, ".local", "pi-cli", "node_modules", ".bin", "pi");
  try { return realpathSync(p); } catch { return null; }
}

/**
 * Prepares one agent's isolation (lib/isolation.mjs): its folder, environment and the command prefix that starts it.
 * ctx: ownerHome (default this user's home), bwrap (path, or false for none; default "bwrap" on Linux), hide (more folders
 * to hide), readOnlyTrees (more folders made read-only), allowVisibleHome, piBin, realGit, sourceEnv, isoDirs. Throws, starting nothing, when the owner's folders
 * cannot be hidden and allowVisibleHome is not set.
 */
export async function isolateAgent(ctx, { dir, artifacts }) {
  const ownerHome = ctx.ownerHome ?? homedir();
  const bwrap = process.platform === "linux" && ctx.bwrap !== false ? (ctx.bwrap ?? "bwrap") : null;
  const hideable = bwrap !== null && sandboxUsable(bwrap);
  if (!hideable && !ctx.allowVisibleHome) throw new Error("the owner's home folder cannot be hidden from the agent here (bubblewrap is not usable); no agent was started (--allow-visible-home runs it with a fresh home folder only)");
  const piBin = ctx.piBin ?? piBinOf(ownerHome);
  const iso = await prepareIsolation({ checkoutDir: dir, artifactsDir: artifacts, ownerHome, provider: ctx.set?.agent?.provider, model: ctx.set?.agent?.model, realGit: ctx.realGit ?? findRealGit(), piBin, sourceEnv: ctx.sourceEnv ?? process.env, netns: hideable });
  ctx.isoDirs?.add(iso.base);
  try {
    // Read-only to the agent: the whole file system (in the sandbox), named here as the trees the agent may read: the
    // shared code folder (other worktrees, the reference checkouts, the bench's own scripts), the reference repositories
    // and the work root's parent. Its own checkout, temporary folder and artifacts are bound back writable.
    const readOnlyTrees = ["/srv/code", ctx.repo, ...(ctx.referenceDirs ?? []), BENCH_ROOT, ctx.workRoot ? dirname(ctx.workRoot) : null, ...(ctx.readOnlyTrees ?? [])].filter((p) => typeof p === "string");
    // The shared work root (every run's checkout) is hidden: the run sees its own checkout only (card W01c).
    const workHidden = hideable ? workRootHidden({ workRoot: ctx.workRoot, ownDir: dir, keep: readOnlyTrees }) : [];
    const listed = hideable ? defaultHidden({ ownerHome, extra: [...(ctx.hide ?? []), ...workHidden] }) : [];
    const own = [dir, iso.base, artifacts];
    // Credential-like files and owner-only folders in what stays readable (lib/isolation.mjs credentialPaths) are hidden too.
    const scan = hideable ? credentialPaths(readOnlyTrees.filter((p) => !listed.some((h) => p === h || p.startsWith(h + "/"))), { exclude: [...own, ...listed] }) : { paths: [], truncated: false };
    // Sockets and what only a supplementary group opens in the system's folders (a snap's service socket, adm's files).
    const sys = hideable ? credentialPaths(SYSTEM_ROOTS, { exclude: [...own, ...listed, ...readOnlyTrees, ...PRIVATE_DIRS], byName: false, maxDepth: 6 }) : { paths: [], truncated: false };
    const hidden = [...listed, ...scan.paths, ...sys.paths];
    const agentFiles = ctx.agent.filter((x) => typeof x === "string" && x !== "node" && existsSync(x)).map((x) => dirname(realpathSync(x)));
    const prefix = hideable ? [...bwrapPrefix({
      bwrap, hidden, readOnlyTrees,
      writable: own,
      readable: [dirname(dirname(process.execPath)), dirname(dirname(fileURLToPath(import.meta.url))), ...agentFiles, ...(piBin ? [installRoot(piBin)] : [])],
      readOnly: iso.readOnly,
    // The agent's only network: the bridge to the key proxy (none when the owner's Pi configuration has no such provider).
    }), ...(iso.bridge ? [process.execPath, NET_BRIDGE, iso.bridge.socketPath, String(iso.bridge.port), "--"] : [])] : [];
    return {
      ...iso, prefix,
      summary: {
        home: "fresh", ownerHomeHidden: hideable, hidden: listed, hiddenByName: scan.paths.length, ...(scan.truncated ? { hiddenByNameTruncated: true } : {}),
        hiddenSystem: sys.paths, ...(sys.truncated ? { hiddenSystemTruncated: true } : {}),
        privateDirs: hideable ? PRIVATE_DIRS : [], readOnly: hideable ? ["/"] : [], ownProcessList: hideable,
        network: hideable ? "none (the model route only)" : "not cut off", modelKey: iso.providerProxied ? "proxied" : "none", gitGuard: true,
      },
    };
  } catch (e) {
    // Nothing is left behind when the sandbox could not be described: the proxy stops and the per-run folder goes.
    await iso.close();
    ctx.isoDirs?.delete(iso.base);
    throw e;
  }
}

/** The bridge from the agent's network namespace to the key proxy. */
const NET_BRIDGE = fileURLToPath(new URL("./net-bridge.mjs", import.meta.url));

/** The repository the bench itself runs from (scripts/pi-eval/lib -> the repository root). */
const BENCH_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Checks a task without an agent: the hidden tests must fail at the base and pass at the solution. */
export async function calibrateOne(ctx, task) {
  // The PID keeps two calibrations of the same task (two benches sharing a work root) out of each other's checkout.
  const dir = join(ctx.workRoot, `eval-calibrate-${task.id}-${process.pid}`);
  const onSpawn = (child) => ctx.children?.add(child);
  const artifacts = join(ctx.resultsDir, "calibration", task.id);
  await mkdir(join(artifacts, "base"), { recursive: true });
  await mkdir(join(artifacts, "solution"), { recursive: true });
  const out = { taskId: task.id, at: new Date().toISOString(), benchCommit: ctx.benchCommit, suite: scoredSuite(task).label };
  const env = { [RUN_MARK]: dir };
  ctx.activeDirs?.add(dir);
  try {
    await prepareCheckout({ repo: ctx.repo, commit: task.base, dir, copy: task.copy, depsFrom: ctx.depsFrom, forbidden: [task.solution] });
    if (task.acceptance) {
      // Fresh paths: an acceptance file must exist neither at the base nor at the solution, so it can never be (or
      // overwrite) a file of the card or of an agent working from the base.
      const taken = [];
      for (const f of task.acceptance.files) for (const c of [task.base, task.solution]) if ((await git(["-C", ctx.repo, "cat-file", "-e", `${c}:${f.dest}`])).code === 0) taken.push(`${f.dest}@${c.slice(0, 8)}`);
      if (taken.length > 0) throw new Error(`acceptance paths are not fresh: ${taken.join(", ")}`);
      // Spec fit, read against the base checkout before anything is copied in.
      const files = await Promise.all(task.acceptance.files.map(async (f) => ({ name: f.dest, text: await readFile(f.src, "utf8") })));
      const fit = specFit({ files, prompt: await readFile(task.promptPath, "utf8"), corpus: readCorpus(dir), allow: task.acceptance.allow });
      out.specFit = { ok: fit.ok, demands: fit.demands, flagged: fit.flagged.length, unjustified: fit.unjustified.map((f) => ({ key: f.key, kind: f.kind, file: f.file, line: f.line })), stale: fit.stale };
      await copyAcceptance({ repo: ctx.repo, task, dir });
    } else {
      await copyHidden({ repo: ctx.repo, solution: task.solution, files: task.hiddenFiles, dir });
    }
    out.base = await runHiddenTests({ task, dir, artifacts: join(artifacts, "base"), onSpawn, env });
    killProcessesInSync(dir);
    await mustGit(["-C", dir, "fetch", "-q", "--no-tags", ctx.repo, task.solution]);
    await mustGit(["-C", dir, "checkout", "-q", "-f", task.solution]);
    out.solution = await runHiddenTests({ task, dir, artifacts: join(artifacts, "solution"), onSpawn, env });
    killProcessesInSync(dir);
    if (task.acceptance && !ctx.skipShipped) {
      // The shipped suites at the solution: the informational "matches shipped wording" score's ceiling.
      const s = await runSuite({ task, suite: { hiddenFiles: task.hiddenFiles, testFiles: task.testFiles }, dir, artifacts: join(artifacts, "solution"), prefix: "shipped", onSpawn, env });
      out.shipped = { passed: s.passed, tests: s.tests, pass: s.pass, fail: s.fail };
    }
    out.ok = out.base.passed === false && out.solution.passed === true && (out.specFit?.ok ?? true);
  } catch (e) {
    out.ok = false; out.error = String(e?.message ?? e).slice(0, 500);
  } finally {
    killProcessesInSync(dir);
    if (!ctx.keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
    ctx.activeDirs?.delete(dir);
  }
  return out;
}

export const appendJsonl = (file, obj) => appendFile(file, `${JSON.stringify(obj)}\n`);

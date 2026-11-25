// NimbleNewt experiment (not product code): the probe that runs INSIDE the AppContainer.
//   node probe.mjs <config.json>
// It attempts the ten containment cases of packages/worker/src/sandbox/containment.ts plus tool and network checks, against paths the harness
// wrote into the config, and prints ONE line: `NN-PROBE-REPORT:` followed by a JSON report. It uses Node's own modules only (the container cannot
// read the repository, so the harness copies this single file next to the config). Every created file is removed again where possible.
// The report holds outcomes and error codes, never file contents or environment values.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export const PROBE_SCHEMA = "nn-appc-probe-1";
export const REPORT_PREFIX = "NN-PROBE-REPORT:";
export const DENIED_CODES = ["EACCES", "EPERM"];
const BLOCKED_OTHER = ["ECONNREFUSED", "ETIMEDOUT", "TIMEOUT", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "EADDRNOTAVAIL", "EAI_AGAIN", "ENOTFOUND"];
const STARTUP_DENIAL_PATTERN = /access is denied|access denied|EACCES|EPERM|permission denied|operation not permitted/i;

/** One attempt's outcome from the error it got: allowed (no error), denied (an access-denied code), blocked-other, missing (ENOENT) or error. */
export function classifyError(error) {
  if (error === undefined || error === null) return "allowed";
  const code = error.code ?? "";
  if (DENIED_CODES.includes(code)) return "denied";
  if (BLOCKED_OTHER.includes(code)) return "blocked-other";
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  return "error";
}

/**
 * The summary of one probe: what was expected ("allowed" or "denied") and what the attempts show.
 *   expect allowed: actual "allowed" when every attempt was allowed, "denied" when any was refused, else "error".
 *   expect denied:  actual "allowed" when ANY attempt got through (a leak), "denied" when every attempt got an access-denied code,
 *                   "denied-weak" when nothing got through but some failed for another reason (missing, refused, timed out), "inconclusive" with no attempt.
 */
export function summarize(expect, attempts) {
  const outcomes = attempts.map((a) => a.outcome);
  if (outcomes.length === 0) return "inconclusive";
  if (expect === "allowed") {
    if (outcomes.every((o) => o === "allowed")) return "allowed";
    return outcomes.includes("denied") ? "denied" : "error";
  }
  if (outcomes.includes("allowed")) return "allowed";
  if (outcomes.every((o) => o === "denied")) return "denied";
  if (outcomes.every((o) => o === "skipped")) return "inconclusive";
  return "denied-weak";
}

const attemptSync = (name, fn) => {
  try { const value = fn(); return { name, outcome: "allowed", ...(value === undefined ? {} : { note: value }) }; }
  catch (error) { return { name, outcome: classifyError(error), code: error?.code ?? null }; }
};

/**
 * One connection attempt that ALWAYS ends: the socket's own idle timeout, a hard timer that does not depend on the socket (it also covers a connect that
 * never reports), and destroy on every path. `timeoutMs` is short (3 s by default); nothing here waits without a limit.
 */
export const connectOnce = (name, host, port, timeoutMs = 3000) => new Promise((resolve) => {
  let settled = false;
  let hard;
  let socket;
  const done = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(hard);
    try { socket?.destroy(); } catch { /* ignored */ }
    resolve({ name, ...value });
  };
  hard = setTimeout(() => done({ outcome: classifyError({ code: "TIMEOUT" }), code: "TIMEOUT" }), timeoutMs + 500);
  try {
    socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => done({ outcome: classifyError({ code: "TIMEOUT" }), code: "TIMEOUT" }));
    socket.once("connect", () => done({ outcome: "allowed" }));
    socket.once("error", (error) => done({ outcome: classifyError(error), code: error?.code ?? null }));
  } catch (error) { done({ outcome: classifyError(error), code: error?.code ?? "THROWN" }); }
});

const readsSecret = (file, secret) => {
  const text = readFileSync(file, "utf8");
  return text.includes(secret) ? "content-visible" : "readable-but-no-secret";
};

/**
 * One child program through the ASYNC spawn with a kill timer (never spawnSync: round 3's cases mode hung inside a synchronous spawn from the container, which stops every
 * timer of the probe). Resolves with {status, signal, error, stdout, stderr}; a child that runs past `timeoutMs` is killed and the result says ETIMEDOUT. It always resolves.
 * `stdio` is passed as given (file descriptors, "ignore" or "pipe"); piped output is collected as text.
 */
export function spawnLimited(file, args, { stdio = "ignore", timeoutMs = 5000, cwd, env, shell = false } = {}) {
  return new Promise((resolveSpawn) => {
    let settled = false;
    let timer;
    let child;
    let stdout = "";
    let stderr = "";
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSpawn({ status: null, signal: null, stdout, stderr, ...value });
    };
    try {
      child = spawn(file, args, { stdio, windowsHide: true, cwd, env, shell });
    } catch (error) { done({ error: { code: error?.code ?? "SPAWN" } }); return; }
    timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } done({ error: { code: "ETIMEDOUT" } }); }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.once("error", (error) => done({ error: { code: error?.code ?? "SPAWN" } }));
    child.once("close", (status, signal) => done({ status, signal }));
  });
}

let toolCounter = 0;
/**
 * Runs a tool and returns {outcome, code, startupDenials}. `allowed` = it started and exited 0. Output goes to FILES in the scratch folder (not pipes: whether the probe's own
 * spawn with pipes works inside a container is measured separately by diag-spawn-modes), every run has its own limit that never exceeds what is left of the probe's budget,
 * and the spawn is asynchronous with a kill timer.
 */
async function runTool(name, file, args, options, denials) {
  const left = options.budget?.remaining?.() ?? Infinity;
  const limit = Math.min(options.timeoutMs ?? 20_000, left - 1500);
  if (limit < 1000) return { name, outcome: "skipped", code: "budget" };
  const dir = options.outDir;
  const base = dir ? join(dir, `tool-${process.pid}-${++toolCounter}`) : undefined;
  let fdOut, fdErr;
  try {
    if (base) { fdOut = openSync(`${base}.out`, "w"); fdErr = openSync(`${base}.err`, "w"); }
  } catch { fdOut = undefined; fdErr = undefined; }
  const result = await spawnLimited(file, args, { timeoutMs: limit, cwd: options.cwd, env: options.env ?? process.env, shell: options.shell === true, stdio: fdOut === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", fdOut, fdErr] });
  let stdout = result.stdout ?? "";
  let stderr = result.stderr ?? "";
  if (fdOut !== undefined) {
    try { closeSync(fdOut); closeSync(fdErr); } catch { /* ignored */ }
    try { stdout = readFileSync(`${base}.out`, "utf8"); stderr = readFileSync(`${base}.err`, "utf8"); } catch { /* ignored */ }
    try { rmSync(`${base}.out`, { force: true }); rmSync(`${base}.err`, { force: true }); } catch { /* ignored */ }
  }
  const text = `${stdout}\n${stderr}`;
  for (const line of text.split(/\r?\n/)) if (STARTUP_DENIAL_PATTERN.test(line)) denials.push({ tool: name, line: line.trim().slice(0, 240) });
  if (result.error) {
    if (result.error.code) denials.push({ tool: name, line: `spawn error ${result.error.code}` });
    return { name, outcome: classifyError(result.error), code: result.error.code === "ETIMEDOUT" ? "TIMEOUT" : (result.error.code ?? "SPAWN") };
  }
  if (result.status === 0) return { name, outcome: "allowed", note: `exit 0, ${stdout.trim().split(/\r?\n/)[0]?.slice(0, 60) ?? ""}` };
  const firstErr = stderr.trim().split(/\r?\n/)[0]?.slice(0, 100) ?? "";
  return { name, outcome: STARTUP_DENIAL_PATTERN.test(text) ? "denied" : "error", code: `exit ${result.status}${result.signal ? ` ${result.signal}` : ""}`, ...(firstErr ? { note: firstErr } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------- results that survive a hang

/**
 * Rebuilds a (partial) report from the progress file's text. The probe writes, one line each and the moment it is known:
 *   `<ms> ms start <id>` / `<ms> ms end <id>`   the step's boundaries,
 *   `<ms> ms ATTEMPT {"id","group","expect","attempt"}`   one attempt of a step that is still running (the diagnostics that start programs write each mode here),
 *   `<ms> ms RESULT {...}`   the step's whole result (the same object the final report carries; `denials` are its start-up denial lines),
 *   `<ms> ms WATCHDOG <step>`   the watchdog fired.
 * The step that has a start line but no end line (and no RESULT) is returned with the attempts it did write plus one `{name: "step did not finish", outcome: "error", code: "HUNG"}`.
 * Self-contained (no outer names): the watchdog worker receives this function as text. Never throws.
 */
export function rebuildFromProgress(text, schema = "nn-appc-probe-1") {
  const results = new Map();
  const attempts = new Map();
  const meta = new Map();
  const order = [];
  const denials = [];
  let current;
  let lastMs = 0;
  let watchdogStep;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^(\d+) ms (start|end|RESULT|ATTEMPT|WATCHDOG)(?: (.*))?$/.exec(line);
    if (!m) continue;
    lastMs = Math.max(lastMs, Number(m[1]));
    const kind = m[2];
    const rest = m[3] ?? "";
    try {
      if (kind === "start") { if (rest !== "") current = rest; }
      else if (kind === "end") current = undefined;
      else if (kind === "WATCHDOG") watchdogStep = rest;
      else if (kind === "RESULT") {
        const rec = JSON.parse(rest);
        if (!order.includes(rec.id)) order.push(rec.id);
        results.set(rec.id, rec);
        for (const d of rec.denials ?? []) denials.push(d);
      } else {
        const rec = JSON.parse(rest);
        if (!attempts.has(rec.id)) attempts.set(rec.id, []);
        attempts.get(rec.id).push(rec.attempt);
        meta.set(rec.id, { group: rec.group, expect: rec.expect });
      }
    } catch { /* a damaged line (the process died mid-write) is skipped */ }
  }
  const probes = [];
  for (const id of order) { const { denials: _d, ...rest } = results.get(id); probes.push(rest); }
  // The step that was running (a start line with no end line and no result) comes last.
  if (current !== undefined && !results.has(current)) probes.push({ id: current, ...(meta.get(current) ?? {}), attempts: [...(attempts.get(current) ?? []), { name: "step did not finish", outcome: "error", code: "HUNG" }], actual: "inconclusive", unfinished: true });
  return { schema, partial: true, rebuilt: true, watchdog: { step: watchdogStep ?? current ?? "(none)", elapsedMs: lastMs }, probes, startupDenials: denials.slice(0, 40) };
}

/**
 * The watchdog that works while the main thread is blocked: a worker thread with its own event loop. After `deadlineMs` it appends `WATCHDOG` to the progress file, writes the rebuilt
 * partial report to standard output with a direct write (the main thread's stream would be stuck with it), and ends the WHOLE process with a kill signal on itself
 * (process.exit in a worker would only end the worker). The caller terminates it when the probe finishes. `kill` and `source` exist for the tests.
 */
export function startWorkerWatchdog({ progressFile, deadlineMs, startedAt = Date.now(), kill = "SIGKILL", prefix = REPORT_PREFIX, schema = PROBE_SCHEMA }) {
  const code = `
    const { workerData } = require("node:worker_threads");
    const fs = require("node:fs");
    const rebuild = ${rebuildFromProgress.toString()};
    setTimeout(() => {
      let text = "";
      try { text = fs.readFileSync(workerData.progressFile, "utf8"); } catch {}
      const report = rebuild(text, workerData.schema);
      try { fs.appendFileSync(workerData.progressFile, (Date.now() - workerData.startedAt) + " ms WATCHDOG " + report.watchdog.step + "\\n"); } catch {}
      report.watchdog.step = report.watchdog.step === "(none)" ? "(unknown)" : report.watchdog.step;
      try { fs.writeSync(1, workerData.prefix + JSON.stringify(report) + "\\n"); } catch {}
      try { process.kill(process.pid, workerData.kill); } catch {}
      process.exit(3);
    }, workerData.deadlineMs);
  `;
  const worker = new Worker(code, { eval: true, workerData: { progressFile, deadlineMs, startedAt, kill, prefix, schema } });
  worker.unref();
  worker.on("error", () => { /* a worker that could not run leaves the harness's own limit as the backstop */ });
  return { stop: () => { try { worker.terminate(); } catch { /* ignored */ } } };
}

export const DEFAULT_BUDGET_MS = 52_000;
export const DEFAULT_WATCHDOG_MS = 60_000;

/**
 * Attempts everything the config lists and returns the report object.
 * Every step is announced in the progress file BEFORE it starts and again when it ends (so a hang names its step), network attempts end by themselves,
 * tools have a limit each that is cut down to what is left of the budget, and a watchdog timer prints the partial report and ends the process when the whole probe
 * runs over (`cfg.watchdogMs`, 60 s by default; `onWatchdog` exists for the tests).
 */
export async function runProbes(cfg, hooks = {}) {
  const started = Date.now();
  const budget = { remaining: () => (cfg.budgetMs ?? DEFAULT_BUDGET_MS) - (Date.now() - started) };
  const probes = [];
  const startupDenials = [];
  const state = { step: "start" };
  const progress = (text) => {
    if (text.startsWith("start ")) state.step = text.slice(6);
    else if (text.startsWith("end ")) state.step = `(between steps, after ${text.slice(4)})`;
    if (!cfg.progressFile) return;
    try { appendFileSync(cfg.progressFile, `${Date.now() - started} ms ${text}\n`); } catch { /* the probe goes on without it */ }
  };
  const partial = () => ({ schema: PROBE_SCHEMA, partial: true, watchdog: { step: state.step, elapsedMs: Date.now() - started }, node: process.version, platform: process.platform, pid: process.pid, probes, startupDenials: startupDenials.slice(0, 40) });
  const watchdogMs = cfg.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  // The backstop for a blocked main thread (a timer cannot fire then): a worker thread ends the process shortly after the timer's deadline; the harness rebuilds the report from the progress file.
  const worker = cfg.progressFile && !hooks.onWatchdog && cfg.workerWatchdog !== false
    ? (() => { try { return startWorkerWatchdog({ progressFile: cfg.progressFile, deadlineMs: watchdogMs + (cfg.workerGraceMs ?? 2000), startedAt: started }); } catch { return undefined; } })()
    : undefined;
  const watchdog = setTimeout(() => {
    progress(`WATCHDOG ${state.step}`);
    (hooks.onWatchdog ?? ((rep) => { process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(rep)}\n`); process.exit(3); }))(partial());
  }, watchdogMs);
  const skip = (name, why) => ({ name, outcome: "skipped", code: why });
  /** One probe: announced, run, timed, summarized. `fn` returns the attempts (or a promise of them). */
  const add = async (id, group, expect, fn, extra = {}) => {
    progress(`start ${id}`);
    const t = Date.now();
    const denialsBefore = startupDenials.length;
    let attempts;
    // `emit(attempt)`: a step that starts programs writes each attempt's line the moment it is known (a later hang then loses nothing).
    const emit = (attempt) => progress(`ATTEMPT ${JSON.stringify({ id, group, expect, attempt })}`);
    try { attempts = await fn(emit); } catch (error) { attempts = [{ name: "probe-step", outcome: "error", code: error?.code ?? error?.name ?? "THROWN" }]; }
    const record = { id, group, expect, attempts, actual: summarize(expect, attempts), ms: Date.now() - t, ...extra };
    probes.push(record);
    // The result goes to the progress file at once, before the step's end line (the denial lines of this step travel with it).
    progress(`RESULT ${JSON.stringify({ ...record, denials: startupDenials.slice(denialsBefore, denialsBefore + 10) })}`);
    progress(`end ${id}`);
  };
  const netMs = cfg.network?.timeoutMs ?? 3000;
  try {
    // 1. control: write the agent's own directories
    await add("control-write-own-directories", "case", "allowed", () => [
      attemptSync("workspace", () => writeFileSync(join(cfg.workspace, "c-work"), "w")),
      attemptSync("home", () => writeFileSync(join(cfg.home, "c-home"), "h")),
      attemptSync("scratch", () => writeFileSync(join(cfg.scratch, "c-scratch"), "s")),
    ]);
    // 2. control: read the agent's own decoy
    await add("control-read-own-decoy", "case", "allowed", () => [attemptSync("decoy", () => readsSecret(cfg.decoy.path, cfg.decoy.content))]);
    // 3. system directories (every file that did get created is removed again)
    await add("deny-write-system", "case", "denied", () => cfg.systemPaths.map((p, i) => {
      const a = attemptSync(`system${i}`, () => writeFileSync(p, "x"));
      if (a.outcome === "allowed") { try { rmSync(p, { force: true }); } catch { /* the harness checks and removes too */ } }
      return a;
    }));
    // 4. host paths outside the workspace
    await add("deny-write-host-path", "case", "denied", () => [
      attemptSync("outside-file", () => writeFileSync(cfg.hostWrite.file, "overwritten")),
      ...cfg.hostWrite.dirs.map((d, i) => attemptSync(`outside-dir${i}`, () => writeFileSync(join(d, "nn-created"), "x"))),
    ]);
    // 5. read through links in the workspace (planted by the harness; a link it could not plant is skipped, never a pass)
    await add("deny-symlink-read", "case", "denied", () => cfg.links.read.map((l) => (l.planted
      ? attemptSync(l.name, () => (l.kind === "file" ? readsSecret(l.path, cfg.controller.secret) : `entries:${readdirSync(l.path).length}`))
      : skip(l.name, "link not planted"))));
    // 6. write through links
    await add("deny-symlink-write", "case", "denied", () => cfg.links.write.map((l) => (l.planted
      ? attemptSync(l.name, () => writeFileSync(l.kind === "file" ? l.path : join(l.path, "nn-via-link"), "x"))
      : skip(l.name, "link not planted"))));
    // 7. credentials
    await add("deny-credential-read", "case", "denied", () => [
      attemptSync("file", () => readsSecret(cfg.credential.file, cfg.credential.secret)),
      attemptSync("list", () => `entries:${readdirSync(cfg.credential.dir).length}`),
    ]);
    // 8. the controller's own data
    await add("deny-controller-data-read", "case", "denied", () => [
      attemptSync("file", () => readsSecret(cfg.controller.file, cfg.controller.secret)),
      attemptSync("list", () => `entries:${readdirSync(cfg.controller.dir).length}`),
    ]);
    // 9. loopback network
    await add("deny-network-loopback", "case", "denied", async () => [await connectOnce("loopback", cfg.network.loopback.host, cfg.network.loopback.port, netMs)]);
    // 10. protected names under the workspace
    await add("deny-write-protected-name", "case", "denied", () => [
      attemptSync("edit", () => writeFileSync(cfg.protectedName.config, "changed")),
      attemptSync("create", () => writeFileSync(join(cfg.protectedName.dir, "nn-hook"), "x")),
      attemptSync("delete", () => rmSync(cfg.protectedName.config)),
    ]);

    // Extra probes
    await add("extra-outbound-connect", "extra", "denied", async () => [await connectOnce("outbound", cfg.network.outbound.host, cfg.network.outbound.port, netMs)]);
    await add("extra-read-owner-profile", "extra", "denied", () => [attemptSync("list", () => `entries:${readdirSync(cfg.ownerProfile).length}`)]);
    await add("extra-write-system-folder", "extra", "denied", () => [(() => {
      const p = join(cfg.systemFolder, "nn-appc-extra");
      const a = attemptSync("write", () => writeFileSync(p, "x"));
      if (a.outcome === "allowed") { try { rmSync(p, { force: true }); } catch { /* checked by the harness */ } }
      return a;
    })()]);
    // A link the container makes itself: a junction in the workspace that points at the controller's folder and at an outside folder, then read and write through it.
    await add("extra-junction-self-made", "extra", "denied", () => {
      const made = (name, target) => {
        const link = join(cfg.workspace, name);
        const a = attemptSync(`create-${name}`, () => symlinkSync(target, link, "junction"));
        return { link, created: a.outcome === "allowed", create: a };
      };
      const c = made("own-junction-controller", cfg.controller.dir);
      const o = made("own-junction-outside", cfg.hostWrite.dirs[0]);
      const g = made("own-junction-protected", cfg.protectedName.dir);
      const out = [
        g.created ? attemptSync("write-protected-folder-via-own-junction", () => writeFileSync(join(g.link, "nn-hook-via-junction"), "x")) : skip("write-protected-folder-via-own-junction", `junction not created (${g.create.code ?? g.create.outcome})`),
        c.created ? attemptSync("read-controller-via-own-junction", () => `entries:${readdirSync(c.link).length}`) : skip("read-controller-via-own-junction", `junction not created (${c.create.code ?? c.create.outcome})`),
        o.created ? attemptSync("write-outside-via-own-junction", () => writeFileSync(join(o.link, "nn-via-own-junction"), "x")) : skip("write-outside-via-own-junction", `junction not created (${o.create.code ?? o.create.outcome})`),
      ];
      for (const x of [c, o, g]) if (x.created) { try { rmSync(x.link, { force: true }); } catch { /* the fixture folder is removed by the harness */ } }
      return out;
    });
    // A hard link to the controller's file: creating one needs rights on the file itself.
    await add("extra-hardlink-read", "extra", "denied", () => {
      const link = join(cfg.workspace, "own-hardlink");
      const made = attemptSync("create-hardlink", () => linkSync(cfg.controller.file, link));
      const out = [made.outcome === "allowed" ? attemptSync("read-via-hardlink", () => readsSecret(link, cfg.controller.secret)) : { name: "read-via-hardlink", outcome: made.outcome === "denied" ? "denied" : "skipped", code: made.code ?? "hardlink not created" }];
      try { rmSync(link, { force: true }); } catch { /* the fixture folder is removed by the harness */ }
      return out;
    });

    // Diagnostics (information, not a verdict): the NUL device and how this process may start children.
    await add("diag-nul-open", "diag", "allowed", () => {
      if (process.platform !== "win32") return [skip("NUL device", "not Windows")];
      return ["NUL", "\\\\.\\NUL"].flatMap((p) => ["r", "w", "r+"].map((m) => attemptSync(`open ${p} ${m}`, () => { closeSync(openSync(p, m)); })));
    });
    // The protected-name operations: they change the workspace's own structure, each success is undone at once. Round 3b moved them BEFORE the tools: the tools start programs from
    // inside the container, which is what hung in round 3, and these four verdicts are the ones the product needs most.
    const prot = cfg.protectedName.dir;
    const undoRename = (from, to) => { try { renameSync(from, to); } catch { /* the harness's witness reports a folder that is gone */ } };
    await add("extra-protect-rename-dir", "extra", "denied", () => {
      const moved = `${prot}-renamed`;
      const a = attemptSync("rename-the-folder", () => renameSync(prot, moved));
      if (a.outcome === "allowed") undoRename(moved, prot);
      return [a];
    });
    await add("extra-protect-delete-dir", "extra", "denied", () => {
      const a = attemptSync("delete-the-folder", () => rmSync(prot, { recursive: true }));
      if (a.outcome === "allowed" || !existsSync(prot)) { try { mkdirSync(prot, { recursive: true }); } catch { /* reported by the witness */ } }
      return [a];
    });
    await add("extra-protect-replace-junction", "extra", "denied", () => {
      // Replace the folder with a junction to a folder of the container's own: remove (or move) it first, then plant the junction under the same name.
      const moved = `${prot}-away`;
      const step1 = attemptSync("move-the-folder-away", () => renameSync(prot, moved));
      if (step1.outcome !== "allowed") return [step1];
      const step2 = attemptSync("plant-a-junction-under-the-name", () => symlinkSync(cfg.scratch, prot, "junction"));
      try { rmSync(prot, { force: true, recursive: true }); } catch { /* ignored */ }
      undoRename(moved, prot);
      return [step1, step2];
    });
    await add("extra-protect-rename-parent", "extra", "denied", () => {
      // The parent entries: the workspace folder itself (a rename needs the right to delete it or to delete a child of ITS parent, which the container was never given).
      const ws = cfg.workspace;
      const moved = `${ws}-renamed`;
      const a = attemptSync("rename-the-workspace", () => renameSync(ws, moved));
      if (a.outcome === "allowed") undoRename(moved, ws);
      return [a];
    });

    // Tools (all expected to work with the minimal grants). Each has a limit of its own and none runs past the probe's budget.
    const toolEnv = process.env;
    const t = cfg.tools;
    const base = { env: toolEnv, outDir: cfg.scratch, budget };
    await add("tool-node-version", "tool", "allowed", async () => [await runTool("node", process.execPath, ["--version"], { ...base, timeoutMs: 15_000 }, startupDenials)]);
    await add("tool-git-version", "tool", "allowed", async () => [await runTool("git", t.git, ["--version"], { ...base, timeoutMs: 15_000 }, startupDenials)]);
    await add("tool-git-init-commit", "tool", "allowed", async () => {
      const gw = t.gitWork;
      mkdirSync(gw, { recursive: true });
      const git = (label, args) => runTool(`git ${label}`, t.git, ["-c", "user.name=NN Experiment", "-c", "user.email=nn@example.invalid", "-c", "core.autocrlf=false", ...args], { ...base, cwd: gw, timeoutMs: 20_000 }, startupDenials);
      const gitSteps = [await git("init", ["init", "-q"])];
      if (gitSteps[0].outcome === "allowed") {
        writeFileSync(join(gw, "a.txt"), "hello\n");
        gitSteps.push(await git("add", ["add", "a.txt"]), await git("commit", ["commit", "-q", "-m", "experiment"]));
      }
      return gitSteps;
    });
    const npmArgs = (args) => [t.npmCli, ...args];
    await add("tool-npm-version", "tool", "allowed", async () => [t.npmCli ? await runTool("npm", process.execPath, npmArgs(["--version"]), { ...base, timeoutMs: 25_000 }, startupDenials) : skip("npm", "npm-cli.js not found")]);
    await add("tool-npm-ci-offline", "tool", "allowed", async () => (t.npmCli
      ? [await runTool("npm ci", process.execPath, npmArgs(["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"]), { ...base, cwd: t.npmProject, timeoutMs: 40_000 }, startupDenials),
        attemptSync("installed-file", () => { if (!existsSync(join(t.npmProject, "node_modules", "nn-tiny", "index.js"))) throw Object.assign(new Error("missing"), { code: "ENOENT" }); })]
      : [skip("npm ci", "npm-cli.js not found")]));

    // LAST (round 3b): the diagnostic that starts `node -e 0` from inside the container. In round 3 it hung in a synchronous spawn, after every other step had finished and before the
    // report was printed. Each mode is an asynchronous spawn with a 5 s kill timer, and its result line is written before the next mode starts.
    await add("diag-spawn-modes", "diag", "allowed", async (emit) => {
      const out = join(cfg.scratch, `spawn-modes-${process.pid}`);
      const limit = () => Math.min(5000, Math.max(1000, budget.remaining() - 1500));
      const modes = [
        ["files", async () => { const a = openSync(`${out}.o`, "w"); const b = openSync(`${out}.e`, "w"); try { return await spawnLimited(process.execPath, ["-e", "0"], { stdio: ["ignore", a, b], timeoutMs: limit() }); } finally { closeSync(a); closeSync(b); } }],
        ["pipes", () => spawnLimited(process.execPath, ["-e", "0"], { stdio: ["pipe", "pipe", "pipe"], timeoutMs: limit() })],
        ["ignore", () => spawnLimited(process.execPath, ["-e", "0"], { stdio: "ignore", timeoutMs: limit() })],
      ];
      const res = [];
      for (const [name, run] of modes) {
        let attempt;
        try {
          const r = await run();
          if (r.error) throw Object.assign(new Error("spawn"), { code: r.error.code === "ETIMEDOUT" ? "TIMEOUT" : r.error.code });
          if (r.status !== 0) throw Object.assign(new Error("exit"), { code: `exit ${r.status}` });
          attempt = { name: `spawn node with stdio ${name}`, outcome: "allowed" };
        } catch (error) { attempt = { name: `spawn node with stdio ${name}`, outcome: classifyError(error), code: error?.code ?? null }; }
        res.push(attempt);
        emit(attempt);
      }
      for (const x of [".o", ".e"]) { try { rmSync(`${out}${x}`, { force: true }); } catch { /* ignored */ } }
      return res;
    });
  } finally { clearTimeout(watchdog); worker?.stop(); }

  return {
    schema: PROBE_SCHEMA,
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    elapsedMs: Date.now() - started,
    probes,
    startupDenials: startupDenials.slice(0, 40),
  };
}

/** Whether this file is the entry point. Compared as paths, and without case on Windows (a drive letter or an 8.3 name in another case must not silence the probe). */
export function isEntryPoint(argv1, moduleUrl, platform = process.platform) {
  if (argv1 === undefined) return false;
  const a = resolve(argv1);
  const b = fileURLToPath(moduleUrl);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
const isMain = isEntryPoint(process.argv[1], import.meta.url);
if (isMain) {
  try {
    const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const report = await runProbes(cfg);
    process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stdout.write(`${REPORT_PREFIX}${JSON.stringify({ schema: PROBE_SCHEMA, fatal: String(error?.code ?? error?.name ?? "error"), probes: [], startupDenials: [] })}\n`);
    process.exitCode = 2;
  }
}

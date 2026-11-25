// NimbleNewt experiment (not product code), round 4: why a program inside the container cannot start child programs, and which configuration lets it.
// Rounds 3 and 3b (hosted Windows runs 45510001368 and 45517848440) showed every `tool-*` probe failing with `spawn error EPERM`, and `diag-spawn-modes` ending in EPERM for the mode
// that gave node three files and in a HANG (the thread never came back) for pipes and for "ignore". The launcher itself starts node, cmd and hostname in the same container without trouble.
// The suspects, one dimension each (the ladder below varies them independently, every step is its own launcher run with a 15 s limit):
//   1. the stdio mode: libuv opens the NUL device for "ignore" (and for a missing standard input), and the container cannot open NUL (error 5 for every flag combination, git.md);
//      "pipe" makes libuv create named pipes; "inherit" and "files" hand over existing handles and open nothing.
//   2. the job's limits: libuv puts every non-detached child into a job of its own, which is a nested job inside the launcher's job; the active-process limit, the memory limit and the
//      UI limits are each switched on and off.
//   3. the program: node.exe copied into the workspace, node.exe in the granted install folder, cmd.exe and hostname.exe (system programs).
//   4. libuv's own start options: `detached` (no job of its own) and `windowsHide`.
//   5. the container: a plain AppContainer and an LPAC.
// Plus two steps that need no libuv at all (cmd.exe starting node and hostname: the operating system's own CreateProcess from inside the container) and one that creates a named pipe.
// Each step's script (`spawn-step.js`, run by node inside the container) writes a line to a progress file BEFORE the call, right after it returns, and at the end, so that a hang says
// whether the call itself never returned (blocked inside process creation) or the child never ended; a marker file written by the grandchild says whether it ever ran.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { aclReadBack, buildChildEnv, buildCommandLine, buildFixturePlan, parseLauncherLine, removeTree, stderrHead } from "./lib.mjs";
import { ladderVariants } from "./ladder.mjs";

export const SPAWN_SCHEMA = "nn-appc-spawn-1";
/** The limit of one step: the launcher's timeout (a hung process creation costs this long). The step's own kill timer for the grandchild is shorter. */
export const SPAWN_STEP_TIMEOUT_MS = 15_000;
export const SPAWN_CHILD_TIMEOUT_MS = 5_000;

const safe = (fn) => { try { return fn(); } catch { return undefined; } };

// ---------------------------------------------------------------------------------------------------------------- the script that runs inside the container

/**
 * The step script (CommonJS; its one argument is a JSON object: target, args, stdio, detached, windowsHide, base, timeoutMs, marker). It starts ONE grandchild with the asked options
 * through the ASYNC child_process.spawn, writes progress lines to `<base>.progress`, and prints one JSON line. It never throws.
 */
export const SPAWN_STEP_SCRIPT = `"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const cfg = JSON.parse(process.argv[2]);
const t0 = Date.now();
const log = (m) => { try { fs.appendFileSync(cfg.base + ".progress", (Date.now() - t0) + " ms " + m + "\\n"); } catch (e) {} };
const result = { stdio: cfg.stdio, detached: cfg.detached === true, windowsHide: cfg.windowsHide !== false };
let out = "";
const fds = [];
let settled = false;
let child;
let timer;
const finish = (v) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  Object.assign(result, v, { ms: Date.now() - t0 });
  for (const f of fds) { try { fs.closeSync(f); } catch (e) {} }
  log("done " + JSON.stringify(v));
  try { fs.writeSync(1, "NN-SPAWN-RESULT:" + JSON.stringify(result) + "\\n"); } catch (e) {}
  process.exit(0);
};
log("start");
let stdio;
try {
  if (cfg.stdio === "pipe") stdio = ["pipe", "pipe", "pipe"];
  else if (cfg.stdio === "inherit") stdio = "inherit";
  else if (cfg.stdio === "ignore") stdio = "ignore";
  else if (cfg.stdio === "files") {
    fs.writeFileSync(cfg.base + ".in", "");
    const a = fs.openSync(cfg.base + ".in", "r");
    const b = fs.openSync(cfg.base + ".out", "w");
    const c = fs.openSync(cfg.base + ".err", "w");
    fds.push(a, b, c);
    stdio = [a, b, c];
  } else stdio = "ignore";
} catch (e) { finish({ outcome: "error", code: "STDIO-" + (e && e.code) }); }
if (!settled) {
  log("before-spawn");
  try {
    child = spawn(cfg.target, cfg.args, { stdio, detached: cfg.detached === true, windowsHide: cfg.windowsHide !== false });
    log("spawn-returned pid=" + child.pid);
  } catch (e) { finish({ outcome: "error", code: (e && e.code) || "SPAWN", phase: "spawn-call" }); }
}
if (!settled) {
  timer = setTimeout(() => { try { child.kill(); } catch (e) {} finish({ outcome: "timeout", phase: "child-did-not-end" }); }, cfg.timeoutMs);
  if (child.stdout) child.stdout.on("data", (d) => { out += d; });
  child.once("error", (e) => finish({ outcome: "error", code: (e && e.code) || "SPAWN", phase: "child-error-event" }));
  child.once("close", (status, signal) => finish({ outcome: "exit", status, signal, stdout: out.slice(0, 40) }));
}
`;

/** The named-pipe diagnostic: can the container create a named pipe and connect to it? (libuv makes named pipes for every "pipe" standard handle.) */
export const PIPE_DIAG_SCRIPT = `"use strict";
const net = require("node:net");
const path = "\\\\\\\\.\\\\pipe\\\\nn-diag-" + process.pid;
const r = { path: "pipe-name" };
const end = () => { process.stdout.write("NN-PIPE-RESULT:" + JSON.stringify(r) + "\\n"); process.exit(0); };
setTimeout(() => { r.timeout = true; end(); }, 5000);
const server = net.createServer((c) => { c.end("ok"); });
server.on("error", (e) => { r.server = e.code; end(); });
server.listen(path, () => {
  r.server = "listening";
  const c = net.connect(path);
  let d = "";
  c.on("data", (x) => { d += x; });
  c.on("end", () => { r.client = d; end(); });
  c.on("error", (e) => { r.client = e.code; end(); });
});
`;

// ---------------------------------------------------------------------------------------------------------------- the variants

/** What each `jobs` value switches on in the launcher's job. */
export const JOB_MODES = {
  all: { memory: true, active: true, ui: true },
  none: { memory: false, active: false, ui: false },
  "ui-only": { memory: false, active: false, ui: true },
  "no-ui": { memory: true, active: true, ui: false },
  "active-only": { memory: false, active: true, ui: false },
  "memory-only": { memory: true, active: false, ui: false },
};
export const TARGETS = ["node-copy", "node-installed", "cmd", "hostname"];
export const STDIO_MODES = ["pipe", "inherit", "files", "ignore"];

/**
 * The ladder. `container`: a ladder container id (ac-nocap or the LPAC with registryRead and lpacCom); `jobs`: a JOB_MODES key; `target`, `stdio`, `detached`, `windowsHide` as above;
 * `kind`: "spawn" (the step script) or "native" (a system program starts another program, no libuv).
 */
export function spawnVariants() {
  const out = [];
  const add = (o) => out.push({ kind: "spawn", container: "ac-nocap", jobs: "all", detached: false, windowsHide: true, ...o });
  // Native steps first: cmd.exe starts node and hostname with the operating system's own process creation (no libuv, no stdio handles opened by a script).
  for (const jobs of ["all", "none"]) {
    out.push({ kind: "native", id: `native-cmd-node-${jobs}`, container: "ac-nocap", jobs, target: "cmd-runs-node", stdio: "launcher", detached: false, windowsHide: true });
    out.push({ kind: "native", id: `native-cmd-hostname-${jobs}`, container: "ac-nocap", jobs, target: "cmd-runs-hostname", stdio: "launcher", detached: false, windowsHide: true });
  }
  out.push({ kind: "native", id: "diag-named-pipe", container: "ac-nocap", jobs: "all", target: "named-pipe", stdio: "launcher", detached: false, windowsHide: true });
  // The main matrix: every job setting that matters is on or off together, then each alone (below); stdio and target vary freely.
  for (const jobs of ["all", "none"]) for (const stdio of STDIO_MODES) for (const target of TARGETS) add({ id: `${jobs}-${stdio}-${target}`, jobs, stdio, target });
  // libuv's own start options (the likeliest configuration of a real agent tool).
  for (const stdio of ["pipe", "files"]) {
    add({ id: `all-${stdio}-node-installed-detached`, stdio, target: "node-installed", detached: true });
    add({ id: `all-${stdio}-node-installed-nohide`, stdio, target: "node-installed", windowsHide: false });
  }
  // The job's limits one at a time (with the standard handles that are most likely to work and the one a tool framework uses).
  for (const jobs of ["ui-only", "no-ui", "active-only", "memory-only"]) for (const stdio of ["pipe", "files"]) add({ id: `${jobs}-${stdio}-node-installed`, jobs, stdio, target: "node-installed" });
  // The LPAC container.
  for (const stdio of ["pipe", "files", "inherit"]) add({ id: `lpac-all-${stdio}-node-installed`, container: "lpac-optout-reg-com", stdio, target: "node-installed" });
  return out;
}

export function selectSpawnVariants(spec, all = spawnVariants()) {
  if (spec === undefined || spec === "all") return all;
  const wanted = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !all.some((v) => v.id === w));
  if (unknown.length > 0) throw new Error(`unknown spawn variant: ${unknown.join(", ")}`);
  return all.filter((v) => wanted.includes(v.id));
}

/** The program and arguments of the grandchild for a target (a marker file is written by node targets so a hang can be told from a child that never ran). */
export function targetCommand(target, plan, ctx, marker) {
  const sys = ctx.systemRoot ?? "C:\\Windows";
  const markerScript = `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`;
  switch (target) {
    case "node-copy": return { file: win32.join(plan.binDir, "node.exe"), args: ["-e", markerScript], marker: true };
    case "node-installed": return { file: ctx.nodeExe, args: ["-e", markerScript], marker: true };
    case "cmd": return { file: win32.join(sys, "System32", "cmd.exe"), args: ["/c", "exit", "0"], marker: false };
    case "hostname": return { file: win32.join(sys, "System32", "hostname.exe"), args: [], marker: false };
    default: return undefined;
  }
}

/** The launcher's job flags for a `jobs` value. */
export function jobArgs(jobs) {
  const m = JOB_MODES[jobs] ?? JOB_MODES.all;
  return [...(m.memory ? ["--memory-mb", "4096"] : []), ...(m.active ? ["--active-processes", "64"] : []), ...(m.ui ? ["--ui-limits"] : [])];
}

/** The step's files: the script, the progress/marker base name, the output files. */
export function stepFiles(variant, plan) {
  const base = join(plan.scratch, `step-${variant.id}`);
  return { base, marker: `${base}.marker`, progress: `${base}.progress`, stdout: join(plan.outDir, `${variant.id}.out.txt`), stderr: join(plan.outDir, `${variant.id}.err.txt`) };
}

/** The program the container runs for a variant, and its command line (node running the step script, or cmd.exe for a native step). Pure. */
export function stepProgram(variant, plan, ctx, files, pathApi = win32) {
  const sys = ctx.systemRoot ?? "C:\\Windows";
  const nodeFlags = ["--preserve-symlinks", "--preserve-symlinks-main"];
  if (variant.kind === "native") {
    if (variant.target === "named-pipe") return { exe: ctx.nodeExe, cmdline: buildCommandLine(ctx.nodeExe, [...nodeFlags, pathApi.join(plan.probeDir, "pipe-diag.js")]) };
    const cmd = pathApi.join(sys, "System32", "cmd.exe");
    const inner = variant.target === "cmd-runs-node" ? [ctx.nodeExe, "-e", "0"] : [pathApi.join(sys, "System32", "hostname.exe")];
    return { exe: cmd, cmdline: buildCommandLine(cmd, ["/c", ...inner]) };
  }
  const t = targetCommand(variant.target, plan, ctx, files.marker);
  const cfg = { target: t.file, args: t.args, stdio: variant.stdio, detached: variant.detached, windowsHide: variant.windowsHide, base: files.base, timeoutMs: SPAWN_CHILD_TIMEOUT_MS };
  return { exe: ctx.nodeExe, cmdline: buildCommandLine(ctx.nodeExe, [...nodeFlags, pathApi.join(plan.probeDir, "spawn-step.js"), JSON.stringify(cfg)]), marker: t.marker };
}

/** The launcher's argument list for one step. Pure. */
export function buildSpawnArgs(variant, plan, ctx, files, timeoutMs = SPAWN_STEP_TIMEOUT_MS) {
  const container = ladderVariants().find((c) => c.id === variant.container) ?? ladderVariants()[0];
  const args = ["run", "--name", ctx.profileName];
  for (const [mode, path] of [["modify", plan.workspace], ["modify", plan.home], ["modify", plan.scratch], ["ro", plan.probeDir]]) args.push("--grant", `${mode}:${path}`);
  for (const d of ctx.programDirs ?? []) args.push("--grant-soft", `rx:${d}`);
  args.push("--aap-policy", container.aapPolicy);
  for (const c of container.capabilities) args.push("--capability", c);
  args.push(...jobArgs(variant.jobs), "--timeout-ms", String(timeoutMs));
  args.push("--stdout", files.stdout, "--stderr", files.stderr, "--cwd", plan.workspace);
  for (const [k, v] of Object.entries(buildChildEnv(plan, ctx))) args.push("--env", `${k}=${v}`);
  const prog = stepProgram(variant, plan, ctx, files);
  args.push("--exe", prog.exe, "--cmdline", prog.cmdline);
  return args;
}

// ---------------------------------------------------------------------------------------------------------------- judging

/** The step script's JSON line, or undefined. */
export function parseStepResult(text, prefix = "NN-SPAWN-RESULT:") {
  for (const line of String(text ?? "").split(/\r?\n/).reverse()) {
    const i = line.indexOf(prefix);
    if (i < 0) continue;
    try { const o = JSON.parse(line.slice(i + prefix.length)); if (o && typeof o === "object") return o; } catch { /* damaged line */ }
  }
  return undefined;
}

/** The progress file's lines (`<ms> ms <text>`), as text without the numbers. */
export const progressSteps = (text) => String(text ?? "").split(/\r?\n/).filter((l) => l !== "").map((l) => l.replace(/^\d+ ms /, ""));

/**
 * One step's outcome in words:
 *   works                 the grandchild ended with exit 0 (and a node grandchild left its marker);
 *   exit-N                it ran and ended with a non-zero exit code;
 *   EPERM / <code>        the spawn call or the child reported that error (EPERM is libuv's name for access denied);
 *   hang-in-spawn         the call never returned (last progress line `before-spawn`): process creation blocked the thread;
 *   hang-child            the call returned but the child never ended in 5 s (`marker` says whether it ever ran);
 *   no-result             the step script printed nothing and left no progress (it did not start, or died);
 *   launcher-refused      the launcher did not start the step.
 */
export function judgeSpawn(variant, line, stdout, progressText, markerExists) {
  const steps = progressSteps(progressText);
  const rec = { id: variant.id, kind: variant.kind, container: variant.container, jobs: variant.jobs, target: variant.target, stdio: variant.stdio, detached: variant.detached, windowsHide: variant.windowsHide };
  if (line === undefined) return { ...rec, outcome: "launcher-refused", detail: "the launcher printed no JSON line" };
  if (line.childStarted !== true) return { ...rec, outcome: "launcher-refused", detail: `${line.stage ?? "?"}: ${line.error ?? "no message"}` };
  const base = { ...rec, elapsedMs: line.elapsedMs, launcherTimedOut: line.timedOut === true, exitCode: line.childExitCode, lastProgress: steps.at(-1), marker: markerExists };
  if (variant.kind === "native") {
    if (variant.target === "named-pipe") {
      const r = parseStepResult(stdout, "NN-PIPE-RESULT:");
      return { ...base, outcome: line.timedOut === true ? "hang-in-spawn" : (r?.server === "listening" && r?.client === "ok" ? "works" : "no-result"), detail: r ? JSON.stringify(r) : "no result line" };
    }
    return { ...base, outcome: line.timedOut === true ? "hang-in-spawn" : (line.childExitCode === 0 ? "works" : `exit-${line.childExitCode}`) };
  }
  const r = parseStepResult(stdout);
  if (r !== undefined) {
    if (r.outcome === "exit") return { ...base, outcome: r.status === 0 && (markerExists || variant.target === "cmd" || variant.target === "hostname") ? "works" : (r.status === 0 ? "ran-no-marker" : `exit-${r.status}`), detail: r.phase };
    if (r.outcome === "timeout") return { ...base, outcome: "hang-child", detail: `the call returned; the child did not end in ${SPAWN_CHILD_TIMEOUT_MS / 1000} s; marker ${markerExists ? "written (it ran)" : "absent"}` };
    return { ...base, outcome: r.code ?? "error", detail: r.phase };
  }
  if (line.timedOut === true) {
    const returned = steps.some((x) => x.startsWith("spawn-returned"));
    const called = steps.some((x) => x === "before-spawn");
    return { ...base, outcome: returned ? "hang-child" : (called ? "hang-in-spawn" : "no-result"), detail: `the step did not finish; ${markerExists ? "the grandchild ran (marker written)" : "the grandchild did not run"}` };
  }
  return { ...base, outcome: "no-result", detail: "the step script printed no result line" };
}

const WORKS = (r) => r.outcome === "works";

/** Which dimension values worked at least once: the summary that names the configuration to use. */
export function summarizeSpawn(results) {
  const works = results.filter(WORKS);
  const by = (key) => Object.fromEntries([...new Set(results.map((r) => r[key]))].map((v) => [String(v), { works: works.filter((r) => r[key] === v).length, total: results.filter((r) => r[key] === v).length }]));
  const outcomes = {};
  for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  return { working: works.map((r) => r.id), outcomes, byStdio: by("stdio"), byJobs: by("jobs"), byTarget: by("target"), byContainer: by("container") };
}

// ---------------------------------------------------------------------------------------------------------------- the runner

export async function runSpawnLadder(opts) {
  const platform = opts.platform ?? process.platform;
  const profileName = opts.profileName ?? "NimbleNewtExperiment";
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const timeoutMs = opts.timeoutMs ?? SPAWN_STEP_TIMEOUT_MS;
  const tmpBase = opts.tmpBase ?? os.tmpdir();
  const log = opts.log ?? (() => {});
  const names = { root: undefined, home: os.homedir(), tmp: tmpBase, user: safe(() => os.userInfo().username), host: os.hostname() };
  const info = parseLauncherLine(safe(() => opts.exec(opts.launcherPath, ["info", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "");
  const host = { platform, release: os.release(), arch: os.arch(), node: process.version, elevated: info?.elevated === true, sessionId: typeof info?.sessionId === "number" ? info.sessionId : -1 };
  if (info === undefined || info.ok !== true) return { report: { schema: SPAWN_SCHEMA, generatedAt: now, host, variants: [], notes: [`the launcher could not create or find the container (${info?.stage ?? "no answer"}); nothing was started`] }, markdown: "", ranAtAll: false, names };
  const profile = { name: profileName, createdNow: info.profile === "created" };
  const tools = opts.tools;
  const pathApi = platform === "win32" ? win32 : { join, dirname, basename };
  const sysRoot = opts.systemRoot ?? (platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : undefined);
  const notes = [];
  const results = [];
  let foldersRemoved = 0;
  let grantsLeft = 0;
  let aclFirst = [];
  const root = mkdtempSync(join(tmpBase, "nn-appc-"));
  names.root = root;
  const plan = { ...buildFixturePlan(root, pathApi), binDir: pathApi.join(root, "ws", "bin") };
  const ctx = { profileName, nodeExe: tools.nodeExe, programDirs: tools.programDirs, systemRoot: sysRoot, pathDirs: [...(tools.nodeExe ? [pathApi.dirname(tools.nodeExe)] : []), ...(sysRoot ? [win32.join(sysRoot, "System32"), sysRoot] : [])] };
  const granted = new Set([plan.workspace, plan.home, plan.scratch, plan.probeDir, ...(ctx.programDirs ?? [])]);
  try {
    for (const d of [plan.workspace, plan.home, plan.scratch, plan.outDir, plan.probeDir, plan.binDir, plan.npmCache]) mkdirSync(d, { recursive: true });
    writeFileSync(join(plan.probeDir, "spawn-step.js"), SPAWN_STEP_SCRIPT);
    writeFileSync(join(plan.probeDir, "pipe-diag.js"), PIPE_DIAG_SCRIPT);
    if (!opts.dryRun && tools.nodeExe) { try { (opts.copyFile ?? copyFileSync)(tools.nodeExe, join(plan.binDir, "node.exe")); } catch { notes.push("node.exe could not be copied into the workspace: the node-copy steps run a missing program"); } }
    for (const variant of selectSpawnVariants(opts.variantSpec)) {
      const files = stepFiles(variant, plan);
      const prog = stepProgram(variant, plan, ctx, files, pathApi);
      let rec;
      if (opts.dryRun) rec = { id: variant.id, kind: variant.kind, container: variant.container, jobs: variant.jobs, target: variant.target, stdio: variant.stdio, detached: variant.detached, windowsHide: variant.windowsHide, outcome: "not-started", detail: "dry run: the launcher was not started" };
      else {
        log(`spawn ladder: ${variant.id}`);
        const wall = Date.now();
        const r = safe(() => opts.exec(opts.launcherPath, buildSpawnArgs(variant, plan, ctx, files, timeoutMs), { timeoutMs: timeoutMs + 60_000 }));
        const line = parseLauncherLine(r?.stdout ?? "");
        const stdout = safe(() => readFileSync(files.stdout, "utf8")) ?? "";
        const stderr = safe(() => readFileSync(files.stderr, "utf8")) ?? "";
        const progress = safe(() => readFileSync(files.progress, "utf8")) ?? "";
        rec = { ...judgeSpawn(variant, line, stdout, progress, prog.marker === true ? existsSync(files.marker) : undefined), wallMs: Date.now() - wall };
        if (rec.outcome !== "works") { rec.stderrHead = stderrHead(stderr, 3, 160); rec.progress = progressSteps(progress).slice(-6); }
        const left = (line?.grants ?? []).filter((g) => g.applied && (g.revoked !== true || (typeof g.entriesLeft === "number" && g.entriesLeft > 0)));
        if (left.length > 0) rec.aclLeftAfterRun = left.map((g) => ({ path: g.path, mode: g.mode, entriesLeft: g.entriesLeft ?? null }));
      }
      results.push(rec);
    }
  } finally {
    let finalLeft = [];
    if (!opts.dryRun) { const rb = aclReadBack(opts.exec, opts.launcherPath, profileName, [...granted]); aclFirst = rb.first; finalLeft = rb.final; }
    grantsLeft += finalLeft.length;
    try { removeTree(root); foldersRemoved++; } catch { notes.push("a fixture folder could not be removed"); }
  }
  let profileDeleted = false;
  if (!opts.dryRun && profile.createdNow) profileDeleted = parseLauncherLine(safe(() => opts.exec(opts.launcherPath, ["delete-profile", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "")?.ok === true;
  else if (!profile.createdNow) notes.push("the container profile existed before this run, so it was left in place");
  const report = { schema: SPAWN_SCHEMA, generatedAt: now, host, profile, stepTimeoutMs: timeoutMs, variants: results, summary: summarizeSpawn(results.filter((r) => r.kind === "spawn")), cleanup: { profileDeleted, foldersRemoved, grantsLeft, aclFirstReadBack: aclFirst }, notes };
  return { report, markdown: renderSpawnMarkdown(report), ranAtAll: true, names };
}

const code = (t) => `\`${String(t).replaceAll("`", "'").replaceAll("|", "/")}\``;

export function renderSpawnMarkdown(report) {
  const L = ["# Windows AppContainer experiment, round 4: starting child programs from inside the container", ""];
  L.push(`Generated ${report.generatedAt}. Host: ${report.host.platform} ${report.host.release ?? ""}; elevated: ${report.host.elevated}.`, "");
  L.push("Each row is one launcher run of its own (limit " + `${(report.stepTimeoutMs ?? SPAWN_STEP_TIMEOUT_MS) / 1000} s). A node script inside the container starts ONE grandchild with the asked stdio mode, job limits and options and records how far it got; native rows let cmd.exe start the program with the operating system's own process creation. Outcomes: works; EPERM (or another code) = the call or the child reported that error; hang-in-spawn = the call never returned; hang-child = the call returned but the child did not end in 5 s; ran-no-marker; exit-N; no-result.`, "");
  L.push("| step | container | job limits | target | stdio | detached | window hidden | outcome | last progress | grandchild ran | ms |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const v of report.variants) L.push(`| ${v.id} | ${v.container} | ${v.jobs} | ${v.target} | ${v.stdio} | ${v.detached} | ${v.windowsHide} | ${v.outcome} | ${v.lastProgress ?? "-"} | ${v.marker === undefined ? "-" : v.marker} | ${v.wallMs ?? "-"} |`);
  L.push("");
  const s = report.summary ?? {};
  if (s.working) {
    L.push("## What worked", "", s.working.length > 0 ? `Configurations of the script's grandchild that worked: ${s.working.join(", ")}.` : "No configuration of the script's grandchild worked.", "");
    for (const [label, key] of [["stdio mode", "byStdio"], ["job limits", "byJobs"], ["program", "byTarget"], ["container", "byContainer"]]) L.push(`- By ${label}: ${Object.entries(s[key] ?? {}).map(([k, x]) => `${k} ${x.works}/${x.total}`).join(", ")}.`);
    L.push(`- Outcomes: ${Object.entries(s.outcomes ?? {}).map(([k, n]) => `${k} ${n}`).join(", ")}.`, "");
  }
  const odd = report.variants.filter((v) => v.outcome !== "works");
  if (odd.length > 0) {
    L.push("## What did not work", "");
    for (const v of odd) L.push(`- ${v.id}: ${v.outcome}${v.detail ? ` (${v.detail})` : ""}${(v.progress ?? []).length > 0 ? `; progress ${v.progress.map(code).join(" | ")}` : ""}${(v.stderrHead ?? []).length > 0 ? `; stderr ${v.stderrHead.map(code).join(" | ")}` : ""}`);
    L.push("");
  }
  L.push("## Clean-up", "", `- Profile deleted: ${report.cleanup?.profileDeleted}; folders removed: ${report.cleanup?.foldersRemoved}; granted paths with an entry left at the end: ${report.cleanup?.grantsLeft}.`);
  for (const n of report.notes ?? []) L.push(`- ${n}`);
  return `${L.join("\n")}\n`;
}

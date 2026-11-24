// NimbleNewt experiment (not product code): the probe that runs INSIDE the AppContainer.
//   node probe.mjs <config.json>
// It attempts the ten containment cases of packages/worker/src/sandbox/containment.ts plus tool and network checks, against paths the harness
// wrote into the config, and prints ONE line: `NN-PROBE-REPORT:` followed by a JSON report. It uses Node's own modules only (the container cannot
// read the repository, so the harness copies this single file next to the config). Every created file is removed again where possible.
// The report holds outcomes and error codes, never file contents or environment values.
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

let toolCounter = 0;
/**
 * Runs a tool and returns {outcome, code, startupDenials}. `allowed` = it started and exited 0. Output goes to FILES in the scratch folder (not pipes: whether the probe's own
 * spawn with pipes works inside a container is measured separately by diag-spawn-modes), every run has its own limit that never exceeds what is left of the probe's budget.
 */
function runTool(name, file, args, options, denials) {
  const left = options.budget?.remaining?.() ?? Infinity;
  const limit = Math.min(options.timeoutMs ?? 20_000, left - 1500);
  if (limit < 1000) return { name, outcome: "skipped", code: "budget" };
  const dir = options.outDir;
  const base = dir ? join(dir, `tool-${process.pid}-${++toolCounter}`) : undefined;
  let fdOut, fdErr;
  try {
    if (base) { fdOut = openSync(`${base}.out`, "w"); fdErr = openSync(`${base}.err`, "w"); }
  } catch { fdOut = undefined; fdErr = undefined; }
  const result = spawnSync(file, args, { encoding: "utf8", timeout: limit, windowsHide: true, cwd: options.cwd, env: options.env ?? process.env, shell: options.shell === true, stdio: fdOut === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", fdOut, fdErr] });
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
  const watchdog = setTimeout(() => {
    progress(`WATCHDOG ${state.step}`);
    (hooks.onWatchdog ?? ((rep) => { process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(rep)}\n`); process.exit(3); }))(partial());
  }, watchdogMs);
  const skip = (name, why) => ({ name, outcome: "skipped", code: why });
  /** One probe: announced, run, timed, summarized. `fn` returns the attempts (or a promise of them). */
  const add = async (id, group, expect, fn, extra = {}) => {
    progress(`start ${id}`);
    const t = Date.now();
    let attempts;
    try { attempts = await fn(); } catch (error) { attempts = [{ name: "probe-step", outcome: "error", code: error?.code ?? error?.name ?? "THROWN" }]; }
    probes.push({ id, group, expect, attempts, actual: summarize(expect, attempts), ms: Date.now() - t, ...extra });
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
    await add("diag-spawn-modes", "diag", "allowed", () => {
      const out = join(cfg.scratch, `spawn-modes-${process.pid}`);
      const modes = [
        ["files", () => { const a = openSync(`${out}.o`, "w"); const b = openSync(`${out}.e`, "w"); try { return spawnSync(process.execPath, ["-e", "0"], { stdio: ["ignore", a, b], timeout: Math.min(8000, Math.max(1000, budget.remaining() - 1500)), windowsHide: true }); } finally { closeSync(a); closeSync(b); } }],
        ["pipes", () => spawnSync(process.execPath, ["-e", "0"], { stdio: ["pipe", "pipe", "pipe"], timeout: Math.min(8000, Math.max(1000, budget.remaining() - 1500)), windowsHide: true })],
        ["ignore", () => spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore", timeout: Math.min(8000, Math.max(1000, budget.remaining() - 1500)), windowsHide: true })],
      ];
      const res = modes.map(([name, run]) => attemptSync(`spawn node with stdio ${name}`, () => {
        const r = run();
        if (r.error) throw Object.assign(new Error("spawn"), { code: r.error.code === "ETIMEDOUT" ? "TIMEOUT" : r.error.code });
        if (r.status !== 0) throw Object.assign(new Error("exit"), { code: `exit ${r.status}` });
      }));
      for (const x of [".o", ".e"]) { try { rmSync(`${out}${x}`, { force: true }); } catch { /* ignored */ } }
      return res;
    });

    // Tools (all expected to work with the minimal grants). Each has a limit of its own and none runs past the probe's budget.
    const toolEnv = process.env;
    const t = cfg.tools;
    const base = { env: toolEnv, outDir: cfg.scratch, budget };
    await add("tool-node-version", "tool", "allowed", () => [runTool("node", process.execPath, ["--version"], { ...base, timeoutMs: 15_000 }, startupDenials)]);
    await add("tool-git-version", "tool", "allowed", () => [runTool("git", t.git, ["--version"], { ...base, timeoutMs: 15_000 }, startupDenials)]);
    await add("tool-git-init-commit", "tool", "allowed", () => {
      const gw = t.gitWork;
      mkdirSync(gw, { recursive: true });
      const git = (label, args) => runTool(`git ${label}`, t.git, ["-c", "user.name=NN Experiment", "-c", "user.email=nn@example.invalid", "-c", "core.autocrlf=false", ...args], { ...base, cwd: gw, timeoutMs: 20_000 }, startupDenials);
      const gitSteps = [git("init", ["init", "-q"])];
      if (gitSteps[0].outcome === "allowed") {
        writeFileSync(join(gw, "a.txt"), "hello\n");
        gitSteps.push(git("add", ["add", "a.txt"]), git("commit", ["commit", "-q", "-m", "experiment"]));
      }
      return gitSteps;
    });
    const npmArgs = (args) => [t.npmCli, ...args];
    await add("tool-npm-version", "tool", "allowed", () => [t.npmCli ? runTool("npm", process.execPath, npmArgs(["--version"]), { ...base, timeoutMs: 25_000 }, startupDenials) : skip("npm", "npm-cli.js not found")]);
    await add("tool-npm-ci-offline", "tool", "allowed", () => (t.npmCli
      ? [runTool("npm ci", process.execPath, npmArgs(["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"]), { ...base, cwd: t.npmProject, timeoutMs: 40_000 }, startupDenials),
        attemptSync("installed-file", () => { if (!existsSync(join(t.npmProject, "node_modules", "nn-tiny", "index.js"))) throw Object.assign(new Error("missing"), { code: "ENOENT" }); })]
      : [skip("npm ci", "npm-cli.js not found")]));

    // The protected-name operations come LAST: they change the workspace's own structure. Each success is undone at once.
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
  } finally { clearTimeout(watchdog); }

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

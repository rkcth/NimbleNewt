// NimbleNewt experiment (not product code): the harness. It builds fresh fixtures for each cell of the matrix, starts the launcher (which runs probe.mjs inside
// a low-privilege AppContainer), judges what came back with the host's own witnesses, and writes results.json and results.md.
//   node run-experiment.mjs [--mode matrix|ladder|firewall|cases|git|npm|links|timing] [--out DIR] [--launcher PATH] [--cells all|id,id] [--variants all|id,id] [--profile NAME] [--timeout-ms N] [--dry-run]
//   --mode matrix (default): round 1's containment matrix. --mode ladder: round 2's smoke ladder (which programs start in which container variant). --mode firewall: round 2's
//   "network cut by firewall" mini-experiment (needs administrator rights for the firewall rule). --timeout-ms is the per-cell (matrix) or per-step (ladder, firewall) limit.
//   Round 4: --mode spawn is the child-program ladder (which stdio mode, job limits and program let a program inside the container start another one); --mode cases now also runs
//   the protected-name layouts (deny-write, deny-strong, seal), the workspace folder entry modify-root and a no-limits cell, and keeps each cell under 90 s.
//   Round 3: --mode cases runs the ten cases, the extra probes (junctions, protected-name operations), the diagnostics and the tools in seven container configurations (ac-nocap,
//   ac-inet-private with and without an outbound block rule and a loopback exemption, two LPAC variants); --mode git is the git ladder; --mode links reads what a grant on the workspace
//   did to the targets of junctions inside it; --mode timing measures start-up, a 100-file git commit and an offline npm ci. Every cell has a 90 s hard limit and the probe ends itself after 60 s.
// Needs no prompt, no window and no UAC: it can be started from a Windows service or a scheduled task. It never asks for administrator rights; what needed them is recorded.
// Everything it creates (fixture folders, ACL entries, the container profile) is removed in a finally path. Verdicts are results, not failures: the exit code is 0 when the
// experiment ran to its end, 2 when it could not run at all (no launcher, no container).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LIMITS, PROFILE_NAME, aclReadBack, grantedPaths, buildChildEnv, buildFixturePlan, buildLauncherArgs, buildProbeConfig, buildReport, collectWitness, createFixtures, extractProbeReport,
  chooseProbeReport, configCells, judgeCell, matrixCells, parseLauncherLine, pickOutboundHost, removeTree, renderMarkdown, scrubText, selectCells, stderrHead, validateReport,
} from "./lib.mjs";
import { STEP_TIMEOUT_MS, netSetup, netTeardown, runFirewall, runLadder } from "./ladder.mjs";
import { runNpmLadder } from "./npm.mjs";
import { SPAWN_STEP_TIMEOUT_MS, runSpawnLadder } from "./round4.mjs";
import { runGitLadder, runLinks, runTiming } from "./round3.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The real launcher call: no stdin, output captured, a hard limit. */
export function execLauncher(launcherPath, args, { timeoutMs }) {
  const r = spawnSync(launcherPath, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.code };
}

/** The real PowerShell call of the firewall mini-experiment (a fixed script text; the package SID and rule name are validated by the caller). */
export function execPowerShell(script, { timeoutMs = 120_000 } = {}) {
  // A one-line script goes as -Command text; a multi-line one (the NUL-device reader) as -EncodedCommand (UTF-16LE base64), which survives any quoting.
  const tail = script.includes("\n") ? ["-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] : ["-Command", script];
  const r = spawnSync(process.platform === "win32" ? "powershell.exe" : "pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...tail], { encoding: "utf8", timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function listener(host) {
  let count = 0;
  const server = net.createServer((socket) => { count++; socket.destroy(); });
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolveListen({ port: server.address().port, count: () => count, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

const which = (name, platform) => {
  const r = spawnSync(platform === "win32" ? "where" : "which", [name], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== "") : undefined;
};

/** Where the tools live and which folders the container must be allowed to read and execute from. */
export function discoverTools({ platform = process.platform, nodeExe = process.execPath, exists = existsSync, find = which } = {}) {
  const p = platform === "win32" ? win32 : { dirname, basename, join };
  const gitExe = find("git", platform);
  const gitDir = gitExe ? p.dirname(gitExe) : undefined;
  const gitRoot = gitDir && ["cmd", "bin"].includes(p.basename(gitDir).toLowerCase()) ? p.dirname(gitDir) : gitDir;
  const npmCandidates = [p.join(p.dirname(nodeExe), "node_modules", "npm", "bin", "npm-cli.js"), p.join(p.dirname(p.dirname(nodeExe)), "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const npmCli = npmCandidates.find((c) => exists(c));
  const npmCmdCandidate = p.join(p.dirname(nodeExe), platform === "win32" ? "npm.cmd" : "npm");
  const npmCmd = exists(npmCmdCandidate) ? npmCmdCandidate : undefined;
  const programDirs = [...new Set([p.dirname(nodeExe), gitRoot].filter(Boolean))];
  return { nodeExe, gitExe, gitDir, gitRoot, npmCli, npmCmd, programDirs };
}

export async function runExperiment(opts) {
  const platform = opts.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : { join, dirname, basename };
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const exec = opts.exec ?? execLauncher;
  const profileName = opts.profileName ?? PROFILE_NAME;
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const tmpBase = opts.tmpBase ?? os.tmpdir();
  const log = opts.log ?? (() => {});
  const notes = [];
  const names = { root: undefined, home: os.homedir(), tmp: tmpBase, user: safe(() => os.userInfo().username), host: os.hostname() };
  const tools = opts.tools ?? discoverTools({ platform });
  const cells = opts.cells ?? selectCells(opts.cellSpec);

  // The launcher must answer `info` first: it creates (or finds) the container and says whether the run is elevated and in which session.
  const info = parseLauncherLine(safe(() => exec(opts.launcherPath, ["info", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "");
  const host = { platform, release: os.release(), arch: os.arch(), node: process.version, elevated: info?.elevated === true, sessionId: typeof info?.sessionId === "number" ? info.sessionId : -1 };
  if (info === undefined || info.ok !== true) {
    notes.push(`the launcher could not create or find the container (${info?.stage ?? "no answer"}: ${info?.error ?? "no JSON line"}); nothing was started`);
    const report = buildReport({ now, host, cells: [], profile: { name: profileName, created: false }, cleanup: { profileDeleted: false, foldersRemoved: 0, grantsLeft: 0 }, notes });
    return { report, markdown: "", ranAtAll: false };
  }
  const profile = { name: profileName, createdNow: info.profile === "created" };
  const packageSid = info.containerSid;

  const loop = await listener("127.0.0.1");
  const outbound = opts.outbound ?? pickOutboundHost(os.networkInterfaces());
  // The non-loopback witness listens on that one address only (not on all interfaces); with no such address nothing listens and the outbound probe is weak evidence.
  const wide = outbound.local ? await listener(outbound.host) : { port: 9, count: () => 0, close: async () => {} };
  if (!outbound.local) notes.push("no non-loopback IPv4 address: the outbound probe aimed at a documentation address, so its refusals are weak evidence");
  const resultsCells = [];
  let foldersRemoved = 0;
  let grantsLeft = 0;
  try {
    for (const cell of cells) {
      const root = mkdtempSync(join(tmpBase, "nn-appc-"));
      names.root = root;
      const plan = buildFixturePlan(root, pathApi);
      let launch = { ok: false, childStarted: false, stage: "not-run", error: "not run" };
      let plantNotes = [];
      let results;
      let probeReport = "missing";
      let startupDenials = [];
      let errHead = [];
      let args = [];
      let aclFirstReadBack = [];
      let aclLeft;
      let netState = { ok: true, summary: "none needed", wanted: {} };
      let netCleanup;
      let progressTail = [];
      try {
        const sysRoot = platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : undefined;
        const systemPaths = opts.systemPaths ?? (platform === "win32" ? [win32.join(sysRoot, "nn-appc-x"), win32.join(sysRoot, "System32", "nn-appc-x"), "C:\\nn-appc-x", win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "nn-appc-x")] : []);
        const systemFolder = opts.systemFolder ?? (platform === "win32" ? win32.join(sysRoot, "Temp") : os.tmpdir());
        const { planted, notes: pn } = createFixtures(plan, { platform, probeSource: join(here, "probe.mjs") });
        plantNotes = pn;
        const pathDirs = [dirname(tools.nodeExe), tools.gitDir, ...(sysRoot ? [win32.join(sysRoot, "System32"), sysRoot] : [])].filter(Boolean);
        const ctx = {
          profileName, nodeExe: tools.nodeExe, programDirs: tools.programDirs, pathDirs, systemRoot: sysRoot, planted, systemPaths, systemFolder, gitExe: tools.gitExe ?? "git", npmCli: tools.npmCli,
          loopbackPort: loop.port, outboundPort: wide.port, outbound, ownerProfile: os.homedir(), loopbackConnections: loop.count, outboundConnections: wide.count,
        };
        ctx.childEnv = buildChildEnv(plan, ctx, platform === "win32" ? ";" : ":");
        writeFileSync(plan.configFile, JSON.stringify(buildProbeConfig(plan, ctx)));
        args = buildLauncherArgs(cell, plan, ctx, limits);
        log(`cell ${cell.id}: starting`);
        if (!opts.dryRun && (cell.firewallBlock || cell.loopbackExempt)) {
          netState = netSetup(cell, { ps: opts.ps, packageSid, profileName, ruleName: `nn-appc-block-${(opts.randomHex ?? (() => Math.random().toString(16).slice(2, 10).padEnd(8, "0")))()}` });
          log(`cell ${cell.id}: network set-up ${netState.summary}`);
        }
        if (opts.dryRun) { launch = { ok: false, childStarted: false, stage: "dry-run", error: "dry run: the launcher was not started" }; }
        else if (!netState.ok) { launch = { ok: false, childStarted: false, stage: "network-setup", error: netState.summary }; }
        else {
          const r = exec(opts.launcherPath, args, { timeoutMs: limits.timeoutMs + 60_000 });
          const line = parseLauncherLine(r.stdout);
          launch = line === undefined ? { ok: false, childStarted: false, stage: "no-launcher-answer", error: `the launcher printed no JSON line (exit ${r.status ?? r.error ?? "?"})` }
            : { ok: line.ok === true, childStarted: line.childStarted === true, stage: line.stage, error: line.error, exitCode: line.childExitCode, timedOut: line.timedOut === true, leftoverProcesses: line.leftoverProcesses,
              elapsedMs: line.elapsedMs, allGrantsRevoked: line.allGrantsRevoked === true, grants: line.grants ?? [], stderrBytes: line.stderrBytes, stdoutBytes: line.stdoutBytes, hang: line.hang,
              daclsBefore: namedDacls(line.daclsBefore, packageSid), daclsAfter: namedDacls(line.daclsAfter, packageSid), capabilities: Array.isArray(line.capabilities) ? line.capabilities.map((c) => c.name) : undefined };
        }
        const stdoutText = safe(() => readFileSync(join(plan.outDir, "stdout.txt"), "utf8")) ?? "";
        // The probe wrote each step's result to the progress file the moment it had it: a report that never got printed (a hang, a kill) is rebuilt from those lines.
        const progressText = safe(() => readFileSync(plan.progressFile, "utf8")) ?? "";
        const chosen = chooseProbeReport(extractProbeReport(stdoutText), progressText);
        const rep = chosen.report;
        probeReport = chosen.label;
        progressTail = progressText.split(/\r?\n/).filter((l) => l !== "" && !/ ms (RESULT|ATTEMPT) /.test(l)).slice(-6);
        startupDenials = rep?.startupDenials ?? [];
        if (probeReport !== "ok") errHead = stderrHead(safe(() => readFileSync(join(plan.outDir, "stderr.txt"), "utf8")) ?? "");
        results = judgeCell(rep, collectWitness(plan, ctx));
      } catch (error) {
        launch = { ...launch, error: `${launch.error}; harness error: ${error?.code ?? error?.name ?? "error"}` };
        results = judgeCell(undefined, undefined);
      } finally {
        if (netState.wanted?.rule || netState.wanted?.exempt) netCleanup = netTeardown(netState, { ps: opts.ps });
        // A launcher that died may have left entries: whatever it reports, read the container's entries back from every granted path; remove what is left and read again.
        if (!opts.dryRun && args.length > 0) {
          const rb = aclReadBack(exec, opts.launcherPath, profileName, grantedPaths(args));
          aclFirstReadBack = rb.first;
          aclLeft = rb.final;
          grantsLeft += aclLeft.length;
        }
        try { removeTree(root); foldersRemoved++; } catch { notes.push("a fixture folder could not be removed"); }
      }
      resultsCells.push({
        id: cell.id, sameAs: cell.sameAs, dims: { lpac: cell.lpac, win32kDisabled: cell.win32kDisabled, aapOptOut: cell.aapOptOut, aapPolicy: cell.aapPolicy, protect: cell.protect, protectMode: cell.protect ? (cell.protectMode ?? "deny-write") : "none", rootMode: cell.rootMode ?? "modify", limits: cell.limits ?? "all", capabilities: cell.capabilities ?? [], firewallBlock: cell.firewallBlock === true, loopbackExempt: Boolean(cell.loopbackExempt), loopbackExemptBy: cell.loopbackExempt === "name" ? "name" : "sid" },
        launch, softGrantFailures: (launch.grants ?? []).filter((g) => g.soft && !g.applied).map((g) => ({ path: g.path, mode: g.mode, errorCode: g.errorCode })),
        plantNotes, probeReport, probeProgress: probeReport === "ok" ? [] : progressTail, results, startupDenials, stderrHead: errHead, aclFirstReadBack, aclLeft,
        net: { ...netState, ...(netCleanup ? { cleanup: netCleanup } : {}), summary: `${netState.summary}${netCleanup ? `; removed afterwards: rule ${netCleanup.ruleGone ? "gone" : "STILL THERE"}, exemption ${netCleanup.exemptGone ? "gone" : "STILL THERE"}` : ""}` },
      });
    }
  } finally {
    await loop.close();
    await wide.close();
  }
  // The profile goes last, and only if this run created it (a profile that was already there is left as it was found).
  let profileDeleted = false;
  if (!opts.dryRun && profile.createdNow) profileDeleted = parseLauncherLine(safe(() => exec(opts.launcherPath, ["delete-profile", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "")?.ok === true;
  else if (!profile.createdNow) notes.push("the container profile existed before this run, so it was left in place");
  const report = buildReport({ now, host, cells: resultsCells, profile, cleanup: { profileDeleted, foldersRemoved, grantsLeft }, notes });
  const problems = validateReport(report);
  if (problems.length > 0) report.notes.push(`report schema problems: ${problems.join(", ")}`);
  return { report, markdown: renderMarkdown(report), ranAtAll: true, names };
}

/** The DACLs the launcher dumped, with the container's own SID named (the scrubber would otherwise turn every SID into the same word). */
export function namedDacls(list, packageSid) {
  if (!Array.isArray(list)) return undefined;
  return list.map((d) => ({ path: String(d?.path ?? ""), sddl: typeof packageSid === "string" && packageSid !== "" ? String(d?.sddl ?? "").replaceAll(packageSid, "<container>") : String(d?.sddl ?? "") }));
}

function safe(fn) { try { return fn(); } catch { return undefined; } }

export const MODES = ["matrix", "cases", "ladder", "git", "npm", "links", "timing", "firewall", "spawn"];

export function parseCli(argv) {
  const o = { mode: "matrix", variantSpec: undefined, out: resolve("nn-appc-results"), launcherPath: join(here, "launcher", "target", "release", `nn-appc-launcher${process.platform === "win32" ? ".exe" : ""}`), cellSpec: "all", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--out") o.out = resolve(v());
    else if (a === "--launcher") o.launcherPath = resolve(v());
    else if (a === "--cells") o.cellSpec = v();
    else if (a === "--mode") { o.mode = v(); if (!MODES.includes(o.mode)) throw new Error(`--mode: ${MODES.join(", ")}`); }
    else if (a === "--variants") o.variantSpec = v();
    else if (a === "--profile") o.profileName = v();
    else if (a === "--timeout-ms") o.limits = { ...(o.limits ?? {}), timeoutMs: Number(v()) };
    else if (a === "--dry-run") o.dryRun = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

async function main() {
  const o = parseCli(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  if (!existsSync(o.launcherPath) && !o.dryRun) { console.error("the launcher binary was not found; build it first (see README.md)"); process.exitCode = 2; return; }
  const common = { ...o, log: (m) => console.log(m), tools: discoverTools(), timeoutMs: o.limits?.timeoutMs };
  let result;
  let stem = "results";
  if (o.mode === "git") { stem = "git"; result = await runGitLadder({ ...common, timeoutMs: o.limits?.timeoutMs ?? STEP_TIMEOUT_MS, exec: execLauncher, ps: execPowerShell }); }
  else if (o.mode === "npm") { stem = "npm"; result = await runNpmLadder({ ...common, timeoutMs: o.limits?.timeoutMs ?? STEP_TIMEOUT_MS, exec: execLauncher }); }
  else if (o.mode === "spawn") { stem = "spawn"; result = await runSpawnLadder({ ...common, timeoutMs: o.limits?.timeoutMs ?? SPAWN_STEP_TIMEOUT_MS, exec: execLauncher }); }
  else if (o.mode === "links") { stem = "links"; result = await runLinks({ ...common, exec: execLauncher, ps: execPowerShell }); }
  else if (o.mode === "timing") { stem = "timing"; result = await runTiming({ ...common, exec: execLauncher, spawn: spawnSync }); }
  else if (o.mode === "cases") { stem = "cases"; result = await runExperiment({ ...common, cells: selectCells(o.cellSpec, configCells()), ps: execPowerShell, exec: execLauncher }); }
  else if (o.mode === "ladder") { stem = "ladder"; result = await runLadder({ ...common, timeoutMs: o.limits?.timeoutMs ?? STEP_TIMEOUT_MS, exec: execLauncher }); }
  else if (o.mode === "firewall") {
    stem = "firewall";
    result = await runFirewall({ ...common, timeoutMs: o.limits?.timeoutMs ?? STEP_TIMEOUT_MS, exec: execLauncher, ps: execPowerShell, outbound: pickOutboundHost(os.networkInterfaces()), exemptByName: true });
  } else result = await runExperiment(common);
  const { report, markdown, ranAtAll, names } = result;
  const clean = (text) => scrubText(text, { ...names, root: undefined });
  writeFileSync(join(o.out, `${stem}.json`), clean(`${JSON.stringify(report, null, 2)}\n`));
  writeFileSync(join(o.out, `${stem}.md`), clean(markdown === "" ? `# Windows AppContainer experiment: ${stem}\n\nThe experiment could not start: ${(report.notes ?? []).join("; ") || report.why}\n` : markdown));
  console.log(`wrote ${join(o.out, `${stem}.md`)}`);
  if (!ranAtAll) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

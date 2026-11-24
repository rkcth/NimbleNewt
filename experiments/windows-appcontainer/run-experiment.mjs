// NimbleNewt experiment (not product code): the harness. It builds fresh fixtures for each cell of the matrix, starts the launcher (which runs probe.mjs inside
// a low-privilege AppContainer), judges what came back with the host's own witnesses, and writes results.json and results.md.
//   node run-experiment.mjs [--out DIR] [--launcher PATH] [--cells all|id,id] [--profile NAME] [--timeout-ms N] [--dry-run]
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
  DEFAULT_LIMITS, PROFILE_NAME, buildChildEnv, buildFixturePlan, buildLauncherArgs, buildProbeConfig, buildReport, collectWitness, createFixtures, extractProbeReport,
  judgeCell, matrixCells, parseLauncherLine, pickOutboundHost, removeTree, renderMarkdown, scrubText, selectCells, validateReport,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The real launcher call: no stdin, output captured, a hard limit. */
export function execLauncher(launcherPath, args, { timeoutMs }) {
  const r = spawnSync(launcherPath, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.code };
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
  const programDirs = [...new Set([p.dirname(nodeExe), gitRoot].filter(Boolean))];
  return { nodeExe, gitExe, gitDir, npmCli, programDirs };
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
  const cells = selectCells(opts.cellSpec);

  // The launcher must answer `info` first: it creates (or finds) the container and says whether the run is elevated and in which session.
  const info = parseLauncherLine(safe(() => exec(opts.launcherPath, ["info", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "");
  const host = { platform, release: os.release(), arch: os.arch(), node: process.version, elevated: info?.elevated === true, sessionId: typeof info?.sessionId === "number" ? info.sessionId : -1 };
  if (info === undefined || info.ok !== true) {
    notes.push(`the launcher could not create or find the container (${info?.stage ?? "no answer"}: ${info?.error ?? "no JSON line"}); nothing was started`);
    const report = buildReport({ now, host, cells: [], profile: { name: profileName, created: false }, cleanup: { profileDeleted: false, foldersRemoved: 0, grantsLeft: 0 }, notes });
    return { report, markdown: "", ranAtAll: false };
  }
  const profile = { name: profileName, createdNow: info.profile === "created" };

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
      let args = [];
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
        if (opts.dryRun) { launch = { ok: false, childStarted: false, stage: "dry-run", error: "dry run: the launcher was not started" }; }
        else {
          const r = exec(opts.launcherPath, args, { timeoutMs: limits.timeoutMs + 60_000 });
          const line = parseLauncherLine(r.stdout);
          launch = line === undefined ? { ok: false, childStarted: false, stage: "no-launcher-answer", error: `the launcher printed no JSON line (exit ${r.status ?? r.error ?? "?"})` }
            : { ok: line.ok === true, childStarted: line.childStarted === true, stage: line.stage, error: line.error, exitCode: line.childExitCode, timedOut: line.timedOut === true, leftoverProcesses: line.leftoverProcesses,
              elapsedMs: line.elapsedMs, allGrantsRevoked: line.allGrantsRevoked === true, grants: line.grants ?? [], stderrBytes: line.stderrBytes, stdoutBytes: line.stdoutBytes };
        }
        const stdoutText = safe(() => readFileSync(join(plan.outDir, "stdout.txt"), "utf8")) ?? "";
        const rep = extractProbeReport(stdoutText);
        probeReport = rep === undefined ? "missing" : rep.fatal ? `fatal: ${rep.fatal}` : "ok";
        startupDenials = rep?.startupDenials ?? [];
        results = judgeCell(rep, collectWitness(plan, ctx));
      } catch (error) {
        launch = { ...launch, error: `${launch.error}; harness error: ${error?.code ?? error?.name ?? "error"}` };
        results = judgeCell(undefined, undefined);
      } finally {
        // A launcher that died may have left entries: ask it to remove them from every path it granted (idempotent), then delete the fixtures.
        if (!opts.dryRun && launch.allGrantsRevoked !== true && args.length > 0) {
          const grants = args.flatMap((a, i) => (a === "--grant" || a === "--grant-soft" ? [a, args[i + 1]] : []));
          const rv = parseLauncherLine(safe(() => exec(opts.launcherPath, ["revoke", "--name", profileName, ...grants], { timeoutMs: 120_000 }).stdout) ?? "");
          if (rv?.ok !== true) grantsLeft++;
        }
        try { removeTree(root); foldersRemoved++; } catch { notes.push("a fixture folder could not be removed"); }
      }
      resultsCells.push({
        id: cell.id, sameAs: cell.sameAs, dims: { lpac: cell.lpac, win32kDisabled: cell.win32kDisabled, aapOptOut: cell.aapOptOut, aapPolicy: cell.aapPolicy, protect: cell.protect },
        launch, softGrantFailures: (launch.grants ?? []).filter((g) => g.soft && !g.applied).map((g) => ({ path: g.path, mode: g.mode, errorCode: g.errorCode })),
        plantNotes, probeReport, results, startupDenials,
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

function safe(fn) { try { return fn(); } catch { return undefined; } }

export function parseCli(argv) {
  const o = { out: resolve("nn-appc-results"), launcherPath: join(here, "launcher", "target", "release", `nn-appc-launcher${process.platform === "win32" ? ".exe" : ""}`), cellSpec: "all", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--out") o.out = resolve(v());
    else if (a === "--launcher") o.launcherPath = resolve(v());
    else if (a === "--cells") o.cellSpec = v();
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
  const { report, markdown, ranAtAll, names } = await runExperiment({ ...o, log: (m) => console.log(m) });
  const clean = (text) => scrubText(text, { ...names, root: undefined });
  writeFileSync(join(o.out, "results.json"), clean(`${JSON.stringify(report, null, 2)}\n`));
  writeFileSync(join(o.out, "results.md"), clean(markdown === "" ? `# Windows AppContainer experiment: results\n\nThe experiment could not start: ${report.notes.join("; ")}\n` : markdown));
  console.log(`wrote ${join(o.out, "results.md")}`);
  if (!ranAtAll) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

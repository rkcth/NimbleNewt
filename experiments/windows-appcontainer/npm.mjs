// NimbleNewt experiment (not product code), round 3b: why `npm ci --offline` fails inside the container, and which change makes it pass.
// Round 3 (hosted Windows run 45510001368, timing mode): `node npm-cli.js ci --offline` ends at once (about 55 ms) in both the plain container and the LPAC one with
//     node:fs:2744  const out = binding.lstat(base, false, undefined, true /* throwIfNoEntry */);   Error: EPERM: operation not permitted, lstat 'C:\'
// Line 2744 of node:fs is the JavaScript `realpathSync` (the non-native one): it walks a path from the drive root and calls lstat on every prefix, `C:\` first. A container with no
// right on the drive root's own entry gets EPERM there. (The native realpath, a single CreateFile + GetFinalPathNameByHandle, does not do that.) Where npm reaches it from is not
// in the first stderr lines, so this mode asks three things in the container itself:
//   1. `lstat-repro`: the failing call alone. Every prefix of the npm script's path, of the working directory and of node.exe is lstat'ed and the code printed, then realpathSync
//      (JavaScript), realpathSync.native, and `stat`, `access` and `readdir` of the drive root.
//   2. each variant below runs the same `npm ci --offline --ignore-scripts` of 40 local packages with ONE change from the base (a node flag, NODE_OPTIONS, npm.cmd instead of
//      npm-cli.js, more npm and home settings, the project inside the granted workspace, a preload that swaps realpathSync for the native one, and combinations), and the harness
//      (outside the container) checks that the installed packages are on disk. A variant passes only when the exit code is 0 AND every package is there.
//   3. the two that matter most are repeated in the LPAC container.
// Pure logic and one runner that starts only the launcher through an injectable function.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { aclReadBack, buildCommandLine, parseLauncherLine, removeTree, stderrHead, writeNpmProject } from "./lib.mjs";
import { STEP_TIMEOUT_MS, buildStepArgs, judgeStep, ladderGrants, ladderPlan, ladderVariants, launcherLeft } from "./ladder.mjs";

export const NPM_SCHEMA = "nn-appc-npm-1";
export const NPM_PACKAGES = 40;
const NPM_ARGS = ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
const PRESERVE = "--preserve-symlinks --preserve-symlinks-main";

const safe = (fn) => { try { return fn(); } catch { return undefined; } };

/** The failing call alone, as a node script printing one JSON line. `process.argv[1]` is the path of npm's script, passed by the caller. */
export const LSTAT_REPRO_SCRIPT = [
  "const fs=require('fs'),path=require('path');",
  "const code=(f)=>{try{f();return 'ok'}catch(e){return String(e.code)+(e.syscall?' '+e.syscall:'')}};",
  "const chain=(p)=>{const out=[];let c=path.resolve(p);for(;;){out.push(c);const d=path.dirname(c);if(d===c)break;c=d}return out.reverse()};",
  "const r={prefixes:{}};",
  "for(const [k,p] of Object.entries({npmScript:process.argv[1],cwd:process.cwd(),nodeExe:process.execPath}))r.prefixes[k]=chain(p).map((c)=>[c,code(()=>fs.lstatSync(c))]);",
  "const root=path.parse(process.cwd()).root;",
  "r.realpathJs=code(()=>fs.realpathSync(process.argv[1]));",
  "r.realpathNative=code(()=>fs.realpathSync.native(process.argv[1]));",
  "r.realpathJsCwd=code(()=>fs.realpathSync(process.cwd()));",
  "r.rootLstat=code(()=>fs.lstatSync(root));r.rootStat=code(()=>fs.statSync(root));r.rootAccess=code(()=>fs.accessSync(root));r.rootReaddir=code(()=>fs.readdirSync(root));",
  "console.log(JSON.stringify(r))",
].join("");

/** The preload that makes node's JavaScript realpath use the native one (no lstat of the drive root). Written into the scratch folder by the runner. */
export const REALPATH_SHIM = "const fs=require('fs');const native=fs.realpathSync.native;fs.realpathSync=Object.assign((p,o)=>native(p,o),{native});\n";

/**
 * The variants. Each is one change from `base`. Fields: `container` (a ladder variant id), `via` ("node": node.exe npm-cli.js; "cmd": cmd.exe /c npm.cmd), `nodeFlags`, `inWorkspace`
 * (the project lives in the granted workspace instead of the scratch folder), `env(plan)` (extra environment; a null value removes a name).
 */
export function npmVariants() {
  const v = (id, desc, o = {}) => ({ id, desc, container: "ac-nocap", via: "node", nodeFlags: [], inWorkspace: false, shim: false, env: () => ({}), ...o });
  const moreEnv = (plan) => ({
    npm_config_prefix: join(plan.home, "npm-prefix"), npm_config_logs_dir: join(plan.home, "npm-logs"), npm_config_cache: join(plan.home, "npm-cache"),
    npm_config_userconfig: join(plan.home, ".npmrc"), npm_config_globalconfig: join(plan.home, ".npmglobalrc"), HOME: plan.home, USERPROFILE: plan.home, APPDATA: join(plan.home, "appdata"), LOCALAPPDATA: join(plan.home, "localappdata"),
  });
  const lpac = "lpac-optout-reg-com";
  return [
    v("base", "node.exe npm-cli.js ci --offline (round 3's call), cwd in the scratch folder"),
    v("nodeopts-preserve", "NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main", { env: () => ({ NODE_OPTIONS: PRESERVE }) }),
    v("flags-preserve", "node.exe --preserve-symlinks --preserve-symlinks-main npm-cli.js (as command-line flags, not NODE_OPTIONS)", { nodeFlags: ["--preserve-symlinks", "--preserve-symlinks-main"] }),
    v("npm-cmd", "cmd.exe /c npm.cmd ci --offline (the way a user starts npm)", { via: "cmd" }),
    v("npm-cmd-preserve", "cmd.exe /c npm.cmd with NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main", { via: "cmd", env: () => ({ NODE_OPTIONS: PRESERVE }) }),
    v("env-more", "npm cache, prefix, logs, user and global configuration, HOME, USERPROFILE, APPDATA and LOCALAPPDATA all inside the granted home folder", { env: moreEnv }),
    v("cwd-workspace", "the project folder inside the granted workspace (cwd in the workspace)", { inWorkspace: true }),
    v("preload-realpath-native", "NODE_OPTIONS=--require <preload> that replaces fs.realpathSync by the native one", { shim: true }),
    v("preserve-env-workspace", "combination: preserve-symlinks options + the extra settings + the project inside the workspace", { inWorkspace: true, env: (plan) => ({ ...moreEnv(plan), NODE_OPTIONS: PRESERVE }) }),
    v("preload-env-workspace", "combination: the realpath preload + the extra settings + the project inside the workspace", { inWorkspace: true, shim: true, env: moreEnv }),
    v("lpac-base", "LPAC + registryRead + lpacCom, otherwise as base", { container: lpac }),
    v("lpac-preserve-env-workspace", "LPAC, the combination of preserve-symlinks, extra settings and workspace project", { container: lpac, inWorkspace: true, env: (plan) => ({ ...moreEnv(plan), NODE_OPTIONS: PRESERVE }) }),
    v("lpac-preload-env-workspace", "LPAC, the combination of the realpath preload, extra settings and workspace project", { container: lpac, inWorkspace: true, shim: true, env: moreEnv }),
  ];
}

export function selectNpmVariants(spec, all = npmVariants()) {
  if (spec === undefined || spec === "all") return all;
  const wanted = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !all.some((x) => x.id === w));
  if (unknown.length > 0) throw new Error(`unknown npm variant: ${unknown.join(", ")}`);
  return all.filter((x) => wanted.includes(x.id));
}

/** Where the project lives for a variant. */
export const npmProjectDir = (variant, plan, pathApi = win32) => (variant.inWorkspace ? pathApi.join(plan.workspace, "npmproj") : pathApi.join(plan.scratch, "npmproj"));

/** The launcher step (the shape `buildStepArgs` takes) of one variant's `npm ci`. `ctx.npmCli` and `ctx.npmCmd` name npm's script and its cmd wrapper. */
export function npmStepFor(variant, plan, ctx, pathApi = win32) {
  const project = npmProjectDir(variant, plan, pathApi);
  const env = { ...variant.env(plan) };
  if (variant.shim) env.NODE_OPTIONS = `--require ${join(plan.scratch, "nn-realpath-shim.js").replaceAll("\\", "/")}`;
  const sys = ctx.systemRoot ?? "C:\\Windows";
  if (variant.via === "cmd") {
    const exe = win32.join(sys, "System32", "cmd.exe");
    return { id: "npm-ci", label: "npm ci --offline", program: "cmd", exe, args: () => ["/c", ctx.npmCmd, ...NPM_ARGS], expect: () => true, cwd: project, env };
  }
  return { id: "npm-ci", label: "npm ci --offline", program: "node", args: () => [...variant.nodeFlags, ctx.npmCli, ...NPM_ARGS], expect: () => true, cwd: project, env };
}

/** The diagnostic step: the failing call alone. */
export function lstatReproStep(plan, ctx) {
  return { id: "lstat-repro", label: "the failing lstat/realpath calls", program: "node", args: () => ["-e", LSTAT_REPRO_SCRIPT, ctx.npmCli], expect: (out) => out.trim().startsWith("{"), cwd: plan.workspace };
}

/** The repro's JSON line, or undefined. */
export function parseRepro(stdout) {
  try { const o = JSON.parse(String(stdout ?? "").trim().split(/\r?\n/).pop() ?? ""); return o && typeof o === "object" ? o : undefined; } catch { return undefined; }
}

/** The first path component (from the drive root up) an lstat was refused on, or undefined. */
export function firstRefusedPrefix(repro) {
  for (const [kind, list] of Object.entries(repro?.prefixes ?? {})) for (const [path, code] of list) if (code !== "ok") return { kind, path, code };
  return undefined;
}

/** One variant's verdict: pass needs exit 0 AND the packages on disk (seen by the harness); a non-zero exit keeps the first lines of the error output. */
export function judgeNpm(step, line, stdout, stderr, installed) {
  const base = judgeStep(step, line, stdout, stderr);
  const rec = { ...base, stderrHead: stderrHead(stderr, 14, 240), installed };
  if (base.status === "pass" && installed !== true) return { ...rec, status: "odd", detail: "exit 0, but the packages are not all on disk" };
  if (base.status === "fail" && installed === true) return { ...rec, detail: "non-zero exit although the packages are on disk" };
  return rec;
}

export function packagesInstalled(project, count = NPM_PACKAGES, exists = existsSync) {
  for (let i = 0; i < count; i++) if (!exists(join(project, "node_modules", `nn-tiny-${i}`, "index.js"))) return false;
  return true;
}

export async function runNpmLadder(opts) {
  const platform = opts.platform ?? process.platform;
  const profileName = opts.profileName ?? "NimbleNewtExperiment";
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const timeoutMs = opts.timeoutMs ?? STEP_TIMEOUT_MS;
  const tmpBase = opts.tmpBase ?? os.tmpdir();
  const log = opts.log ?? (() => {});
  const names = { root: undefined, home: os.homedir(), tmp: tmpBase, user: safe(() => os.userInfo().username), host: os.hostname() };
  const info = parseLauncherLine(safe(() => opts.exec(opts.launcherPath, ["info", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "");
  const host = { platform, release: os.release(), arch: os.arch(), node: process.version, elevated: info?.elevated === true, sessionId: typeof info?.sessionId === "number" ? info.sessionId : -1 };
  if (info === undefined || info.ok !== true) return { report: { schema: NPM_SCHEMA, generatedAt: now, host, variants: [], notes: [`the launcher could not create or find the container (${info?.stage ?? "no answer"}); nothing was started`] }, markdown: "", ranAtAll: false, names };
  const profile = { name: profileName, createdNow: info.profile === "created" };
  const tools = opts.tools;
  const pathApi = platform === "win32" ? win32 : { join, dirname, basename };
  const sysRoot = opts.systemRoot ?? (platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : undefined);
  const containers = ladderVariants();
  const notes = [];
  const out = [];
  let foldersRemoved = 0;
  let grantsLeft = 0;
  if (!tools.npmCli) notes.push("npm-cli.js was not found: nothing to try");
  const npmCmd = tools.npmCmd ?? (tools.nodeExe ? join(pathApi.dirname(tools.nodeExe), "npm.cmd") : "npm.cmd");
  const reproByContainer = {};
  for (const variant of tools.npmCli ? selectNpmVariants(opts.variantSpec) : []) {
    const container = containers.find((c) => c.id === variant.container);
    const root = mkdtempSync(join(tmpBase, "nn-appc-"));
    names.root = root;
    const plan = ladderPlan(root, pathApi);
    const granted = new Set();
    let step;
    let rec;
    try {
      for (const d of [plan.workspace, plan.home, plan.scratch, plan.outDir, plan.binDir, plan.npmCache]) mkdirSync(d, { recursive: true });
      const project = npmProjectDir(variant, plan, pathApi);
      writeNpmProject(project, NPM_PACKAGES);
      if (variant.shim) writeFileSync(join(plan.scratch, "nn-realpath-shim.js"), REALPATH_SHIM);
      const ctx = { profileName, nodeExe: tools.nodeExe, gitExe: tools.gitExe, programDirs: tools.programDirs, systemRoot: sysRoot, npmCli: tools.npmCli, npmCmd, pathDirs: [...(tools.nodeExe ? [pathApi.dirname(tools.nodeExe)] : []), ...(sysRoot ? [win32.join(sysRoot, "System32"), sysRoot] : [])] };
      for (const [, path] of ladderGrants(container, plan, ctx)) granted.add(path);
      const run = (s, id) => {
        const outFiles = { stdout: join(plan.outDir, `${id}.out.txt`), stderr: join(plan.outDir, `${id}.err.txt`) };
        if (opts.dryRun) return { status: "not-started", detail: "dry run: the launcher was not started", stdout: "", stderr: "" };
        const args = buildStepArgs(container, s, plan, ctx, timeoutMs, outFiles);
        log(`npm variant ${variant.id}: ${s.id}`);
        const wall = Date.now();
        const r = safe(() => opts.exec(opts.launcherPath, args, { timeoutMs: timeoutMs + 60_000 }));
        const line = parseLauncherLine(r?.stdout ?? "");
        const stdout = safe(() => readFileSync(outFiles.stdout, "utf8")) ?? "";
        const stderr = safe(() => readFileSync(outFiles.stderr, "utf8")) ?? "";
        return { line, stdout, stderr, wallMs: Date.now() - wall, left: launcherLeft(line) };
      };
      // The repro runs once per container, in the first variant that uses it.
      if (reproByContainer[container.id] === undefined) {
        const rs = lstatReproStep(plan, ctx);
        const r = run(rs, "repro");
        reproByContainer[container.id] = r.line === undefined ? { status: r.status ?? "not-started" } : { ...judgeStep(rs, r.line, r.stdout, r.stderr), repro: parseRepro(r.stdout) };
        if (reproByContainer[container.id].repro) reproByContainer[container.id].firstRefused = firstRefusedPrefix(reproByContainer[container.id].repro);
      }
      step = npmStepFor(variant, plan, ctx, pathApi);
      const r = run(step, "npm-ci");
      const installed = opts.dryRun ? false : packagesInstalled(project);
      rec = r.line === undefined && opts.dryRun ? { id: step.id, label: step.label, status: "not-started", detail: r.detail, installed } : { ...judgeNpm(step, r.line, r.stdout, r.stderr, installed), wallMs: r.wallMs };
      if ((r.left ?? []).length > 0) rec.aclLeftAfterRun = r.left;
    } finally {
      let finalLeft = [];
      let firstReadBack = [];
      if (!opts.dryRun && granted.size > 0) { const rb = aclReadBack(opts.exec, opts.launcherPath, profileName, [...granted]); firstReadBack = rb.first; finalLeft = rb.final; }
      grantsLeft += finalLeft.length;
      try { removeTree(root); foldersRemoved++; } catch { notes.push("a fixture folder could not be removed"); }
      out.push({ id: variant.id, desc: variant.desc, container: variant.container, via: variant.via, step: rec ?? { id: "npm-ci", status: "not-started", detail: "the variant did not run" }, aclFirstReadBack: firstReadBack, aclLeftFinal: finalLeft });
    }
  }
  let profileDeleted = false;
  if (!opts.dryRun && profile.createdNow) profileDeleted = parseLauncherLine(safe(() => opts.exec(opts.launcherPath, ["delete-profile", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "")?.ok === true;
  else if (!profile.createdNow) notes.push("the container profile existed before this run, so it was left in place");
  const passing = out.filter((v) => v.step.status === "pass").map((v) => v.id);
  const report = { schema: NPM_SCHEMA, generatedAt: now, host, profile, packages: NPM_PACKAGES, repro: reproByContainer, variants: out, passing, cleanup: { profileDeleted, foldersRemoved, grantsLeft }, notes };
  return { report, markdown: renderNpmMarkdown(report), ranAtAll: true, names };
}

const code = (t) => `\`${String(t).replaceAll("`", "'").replaceAll("|", "/")}\``;

export function renderNpmMarkdown(report) {
  const L = ["# Windows AppContainer experiment, round 3b: why npm ci fails in the container", ""];
  L.push(`Generated ${report.generatedAt}. Host: ${report.host.platform} ${report.host.release ?? ""}; elevated: ${report.host.elevated}.`, "");
  L.push("Round 3 saw `EPERM: operation not permitted, lstat 'C:\\'` from node's JavaScript `realpathSync` (node:fs line 2744). The `lstat-repro` step runs that call alone in the container; each variant then changes one thing and runs `npm ci --offline` of 40 local packages. A variant passes only when the exit code is 0 and every package is on disk (checked by the harness outside the container).", "");
  for (const [id, r] of Object.entries(report.repro ?? {})) {
    L.push(`## lstat-repro in ${id}`, "");
    if (!r.repro) { L.push(`- Not obtained: ${r.status}${r.detail ? ` (${r.detail})` : ""}.`, ""); continue; }
    const p = r.repro;
    L.push(`- Drive root: lstat ${p.rootLstat}, stat ${p.rootStat}, access ${p.rootAccess}, readdir ${p.rootReaddir}.`);
    L.push(`- realpathSync (JavaScript) of npm's script: ${p.realpathJs}; realpathSync.native: ${p.realpathNative}; realpathSync of the working directory: ${p.realpathJsCwd}.`);
    L.push(`- First prefix refused: ${r.firstRefused ? `${r.firstRefused.kind}: ${code(r.firstRefused.path)} ${r.firstRefused.code}` : "none (every prefix could be lstat'ed)"}.`);
    for (const [kind, list] of Object.entries(p.prefixes ?? {})) L.push(`- ${kind}: ${list.map(([path, c]) => `${code(path)}=${c}`).join(", ")}`);
    L.push("");
  }
  L.push("## Variants", "", "| variant | container | npm ci | packages on disk | ms |", "| --- | --- | --- | --- | --- |");
  for (const v of report.variants) L.push(`| ${v.id} | ${v.container} | ${v.step.status === "fail" ? `fail ${v.step.exitHex}` : v.step.status} | ${v.step.installed} | ${v.step.wallMs ?? "-"} |`);
  L.push("", report.passing.length > 0 ? `Variants where npm ci --offline passed: ${report.passing.join(", ")}.` : "No variant made npm ci --offline pass.", "");
  for (const v of report.variants) {
    L.push(`### ${v.id}`, "", `- ${v.desc}.`);
    if (v.step.status !== "pass") {
      if (v.step.detail) L.push(`- ${v.step.detail}`);
      if ((v.step.stderrHead ?? []).length > 0) L.push(`- stderr: ${v.step.stderrHead.map(code).join(" | ")}`);
    }
    L.push(v.aclFirstReadBack.length > 0 ? `- Read-back found ACL entries left on: ${v.aclFirstReadBack.map((x) => `${x.path} (${x.entriesLeft})`).join("; ")}; after a second revoke: ${v.aclLeftFinal.length === 0 ? "none left" : v.aclLeftFinal.map((x) => `${x.path} (${x.entriesLeft})`).join("; ")}.` : "- Read-back of every granted path after the variant: no ACL entry left.", "");
  }
  L.push("## Clean-up", "", `- Profile deleted: ${report.cleanup?.profileDeleted}; folders removed: ${report.cleanup?.foldersRemoved}; granted paths with an entry left at the end: ${report.cleanup?.grantsLeft}.`);
  for (const n of report.notes) L.push(`- ${n}`);
  return `${L.join("\n")}\n`;
}

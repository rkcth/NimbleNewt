// NimbleNewt experiment (not product code): the harness's pure logic. Nothing here starts the launcher or needs Windows, so the unit tests
// (scripts/windows-appcontainer-experiment.test.mjs) run on Linux with fakes. run-experiment.mjs is the part that does the real work.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { gzipSync } from "node:zlib";
import { REPORT_PREFIX, summarize } from "./probe.mjs";

export const REPORT_SCHEMA = "nn-appc-experiment-1";
export const PROFILE_NAME = "NimbleNewtExperiment";

/** The ten containment cases of packages/worker/src/sandbox/containment.ts (kept in that file's order). */
export const CASE_IDS = [
  "control-write-own-directories", "control-read-own-decoy", "deny-write-system", "deny-write-host-path", "deny-symlink-read",
  "deny-symlink-write", "deny-credential-read", "deny-controller-data-read", "deny-network-loopback", "deny-write-protected-name",
];
export const EXTRA_IDS = ["extra-outbound-connect", "extra-read-owner-profile", "extra-write-system-folder"];
export const TOOL_IDS = ["tool-node-version", "tool-git-version", "tool-git-init-commit", "tool-npm-version", "tool-npm-ci-offline"];
export const ALL_PROBE_IDS = [...CASE_IDS, ...EXTRA_IDS, ...TOOL_IDS];
export const CONTROL_IDS = ["control-write-own-directories", "control-read-own-decoy"];

export const SECRETS = { controller: "NN-FIXED-TEXT-CONTROLLER-DATA", credential: "NN-FIXED-TEXT-CREDENTIAL", decoy: "NN-FIXED-TEXT-OWN-DECOY", original: "NN-FIXED-TEXT-ORIGINAL", git: "[core]\n\tbare = false\n" };

// ---------------------------------------------------------------------------------------------------------------- command lines

/** Quotes one argument the way CommandLineToArgvW / the C runtime parse it back (backslashes before a quote are doubled). */
export function quoteWindowsArg(arg) {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") { backslashes++; continue; }
    if (ch === '"') { out += "\\".repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    out += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

export const buildCommandLine = (exe, args) => [exe, ...args].map(quoteWindowsArg).join(" ");

// ---------------------------------------------------------------------------------------------------------------- the matrix

/**
 * The 2 x 2 x 2 matrix: LPAC on/off, Win32k system calls disabled on/off, ALL APPLICATION PACKAGES opt-out on/off.
 *   LPAC off:                    no policy attribute (a plain AppContainer). The opt-out flag then has nothing to act on: the two cells are the same
 *                                configuration and say so (`sameAs`); they are run anyway, which also shows run-to-run noise.
 *   LPAC on, opt-out on:         policy attribute with PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT (the real LPAC).
 *   LPAC on, opt-out off:        the attribute present with the default OPT_IN value (which should behave like a plain container).
 * One more cell, `baseline-no-protect`, is the real LPAC without the deny entry on `.git`: it shows what the protected-name case does without it.
 */
export function matrixCells() {
  const cells = [];
  for (const lpac of [true, false]) for (const win32kDisabled of [false, true]) for (const aapOptOut of [true, false]) {
    const aapPolicy = !lpac ? "none" : aapOptOut ? "optout" : "optin";
    const id = `lpac-${lpac ? "on" : "off"}_win32k-${win32kDisabled ? "disabled" : "enabled"}_aapoptout-${aapOptOut ? "on" : "off"}`;
    cells.push({ id, lpac, win32kDisabled, aapOptOut, aapPolicy, protect: true, sameAs: undefined });
  }
  for (const c of cells) if (!c.lpac && !c.aapOptOut) c.sameAs = `lpac-off_win32k-${c.win32kDisabled ? "disabled" : "enabled"}_aapoptout-on`;
  cells.push({ id: "baseline-no-protect", lpac: true, win32kDisabled: false, aapOptOut: true, aapPolicy: "optout", protect: false, sameAs: undefined });
  return cells;
}

export function selectCells(spec, cells = matrixCells()) {
  if (spec === undefined || spec === "all") return cells;
  const wanted = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !cells.some((c) => c.id === w));
  if (unknown.length > 0) throw new Error(`unknown cell: ${unknown.join(", ")}`);
  return cells.filter((c) => wanted.includes(c.id));
}

// ---------------------------------------------------------------------------------------------------------------- fixtures

/** Where everything lives under one fresh root. Pure: it only computes paths (`pathApi` is win32 on Windows, posix elsewhere). */
export function buildFixturePlan(root, pathApi = win32) {
  const j = (...p) => pathApi.join(root, ...p);
  const ws = j("ws");
  return {
    root, workspace: ws, home: j("home"), scratch: j("scratch"), probeDir: j("probe"), outDir: j("out"),
    decoy: pathApi.join(ws, "decoy.txt"),
    protectedDir: pathApi.join(ws, ".git"), protectedConfig: pathApi.join(ws, ".git", "config"),
    outsideDir: j("outside"), outsideFile: j("outside", "host-file.txt"), linkTargetFile: j("outside", "link-target.txt"), linkTargetDir: j("outside", "linkdir"),
    controllerDir: j("controller"), controllerFile: j("controller", "controller.db"),
    ownerHome: j("ownerhome"), credentialDir: j("ownerhome", ".ssh"), credentialFile: j("ownerhome", ".ssh", "id_fixture"),
    gitWork: pathApi.join(j("scratch"), "gitwork"), npmProject: pathApi.join(j("scratch"), "npmproj"), npmCache: pathApi.join(j("scratch"), "npmcache"),
    links: {
      readFile: pathApi.join(ws, "link-read-file"), readDir: pathApi.join(ws, "link-read-dir"),
      writeFile: pathApi.join(ws, "link-write-file"), writeDir: pathApi.join(ws, "link-write-dir"),
    },
    probeFile: j("probe", "probe.mjs"), configFile: j("probe", "probe-config.json"),
  };
}

/** A minimal ustar tar archive in memory (regular files only), gzipped: enough for `npm ci` to unpack a local package. */
export function makeTarball(files) {
  const blocks = [];
  const octal = (n, len) => `${n.toString(8).padStart(len - 1, "0")}\0`;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(octal(0o644, 8), 100, "ascii");
    header.write(octal(0, 8), 108, "ascii");
    header.write(octal(0, 8), 116, "ascii");
    header.write(octal(data.length, 12), 124, "ascii");
    header.write(octal(0, 12), 136, "ascii");
    header.fill(0x20, 148, 156);
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** The files of the tiny offline npm project: package.json, a lockfile naming the local tarball with its integrity, and the tarball. */
export function npmFixtureFiles() {
  const tgz = makeTarball({
    "package/package.json": JSON.stringify({ name: "nn-tiny", version: "1.0.0", main: "index.js" }),
    "package/index.js": "module.exports = 'nn-tiny';\n",
  });
  const integrity = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
  const dep = "file:vendor/nn-tiny-1.0.0.tgz";
  return {
    tgz,
    "package.json": JSON.stringify({ name: "nn-appc-fixture", version: "1.0.0", private: true, dependencies: { "nn-tiny": dep } }, null, 2),
    "package-lock.json": JSON.stringify({
      name: "nn-appc-fixture", version: "1.0.0", lockfileVersion: 3, requires: true,
      packages: { "": { name: "nn-appc-fixture", version: "1.0.0", dependencies: { "nn-tiny": dep } }, "node_modules/nn-tiny": { version: "1.0.0", resolved: dep, integrity } },
    }, null, 2),
  };
}

const tryLink = (target, path, type, notes, label) => {
  try { symlinkSync(target, path, type); return true; }
  catch (error) { notes.push(`${label}: not planted (${error?.code ?? "error"})`); return false; }
};

/**
 * Creates the fixtures (idempotent per fresh root). Directory links are junctions on Windows (no privilege); file links need the right to create
 * symbolic links, and when that is missing the link is recorded as not planted, so its attempt is skipped and the case is inconclusive, never a pass.
 */
export function createFixtures(plan, { platform = process.platform, probeSource } = {}) {
  const notes = [];
  for (const d of [plan.workspace, plan.home, plan.scratch, plan.probeDir, plan.outDir, plan.outsideDir, plan.linkTargetDir, plan.controllerDir, plan.credentialDir, plan.protectedDir, plan.gitWork, plan.npmCache, join(plan.npmProject, "vendor")]) mkdirSync(d, { recursive: true });
  writeFileSync(plan.decoy, SECRETS.decoy);
  writeFileSync(plan.protectedConfig, SECRETS.git);
  writeFileSync(plan.outsideFile, SECRETS.original);
  writeFileSync(plan.linkTargetFile, SECRETS.original);
  writeFileSync(plan.controllerFile, SECRETS.controller);
  writeFileSync(plan.credentialFile, SECRETS.credential);
  const npm = npmFixtureFiles();
  writeFileSync(join(plan.npmProject, "package.json"), npm["package.json"]);
  writeFileSync(join(plan.npmProject, "package-lock.json"), npm["package-lock.json"]);
  writeFileSync(join(plan.npmProject, "vendor", "nn-tiny-1.0.0.tgz"), npm.tgz);
  if (probeSource !== undefined) writeFileSync(plan.probeFile, readFileSync(probeSource));
  const dirType = platform === "win32" ? "junction" : "dir";
  const planted = {
    readFile: tryLink(plan.controllerFile, plan.links.readFile, "file", notes, "file link to controller data"),
    readDir: tryLink(plan.controllerDir, plan.links.readDir, dirType, notes, "directory link to controller data"),
    writeFile: tryLink(plan.linkTargetFile, plan.links.writeFile, "file", notes, "file link to an outside file"),
    writeDir: tryLink(plan.linkTargetDir, plan.links.writeDir, dirType, notes, "directory link to an outside folder"),
  };
  return { planted, notes };
}

export function removeTree(path) {
  // Remove links first: rmSync on a junction removes the link itself, not the target's contents, but be explicit about it.
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ---------------------------------------------------------------------------------------------------------------- configuration for the probe, the child's environment and the launcher

/** The first non-loopback IPv4 address of the machine (for a connect that leaves loopback), else a documentation address that nothing answers. */
export function pickOutboundHost(interfaces) {
  for (const list of Object.values(interfaces ?? {})) for (const i of list ?? []) if (i && i.family === "IPv4" && !i.internal) return { host: i.address, local: true };
  return { host: "192.0.2.1", local: false };
}

export function buildProbeConfig(plan, ctx) {
  return {
    workspace: plan.workspace, home: plan.home, scratch: plan.scratch,
    decoy: { path: plan.decoy, content: SECRETS.decoy },
    systemPaths: ctx.systemPaths,
    hostWrite: { file: plan.outsideFile, dirs: [plan.outsideDir, plan.controllerDir, plan.credentialDir] },
    links: {
      read: [{ name: "file-link", kind: "file", path: plan.links.readFile, planted: ctx.planted.readFile }, { name: "dir-link", kind: "dir", path: plan.links.readDir, planted: ctx.planted.readDir }],
      write: [{ name: "file-link", kind: "file", path: plan.links.writeFile, planted: ctx.planted.writeFile }, { name: "dir-link", kind: "dir", path: plan.links.writeDir, planted: ctx.planted.writeDir }],
    },
    credential: { file: plan.credentialFile, dir: plan.credentialDir, secret: SECRETS.credential },
    controller: { file: plan.controllerFile, dir: plan.controllerDir, secret: SECRETS.controller },
    network: { loopback: { host: "127.0.0.1", port: ctx.loopbackPort }, outbound: { host: ctx.outbound.host, port: ctx.outboundPort }, timeoutMs: ctx.networkTimeoutMs ?? 3000 },
    protectedName: { dir: plan.protectedDir, config: plan.protectedConfig },
    ownerProfile: ctx.ownerProfile,
    systemFolder: ctx.systemFolder,
    tools: { git: ctx.gitExe, gitWork: plan.gitWork, npmCli: ctx.npmCli, npmProject: plan.npmProject },
  };
}

/** The child's whole environment (nothing is inherited from the harness): names and fixed fixture paths only. */
export function buildChildEnv(plan, ctx, delimiter = ";") {
  const env = {
    HOME: plan.home, USERPROFILE: plan.home, APPDATA: plan.home, LOCALAPPDATA: plan.home, TEMP: plan.scratch, TMP: plan.scratch, TMPDIR: plan.scratch,
    PATH: ctx.pathDirs.join(delimiter),
    npm_config_cache: plan.npmCache, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    npm_config_userconfig: join(plan.home, ".npmrc"), npm_config_globalconfig: join(plan.home, ".npmglobalrc"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(plan.home, ".gitconfig"), GIT_TERMINAL_PROMPT: "0",
  };
  if (ctx.systemRoot) { env.SystemRoot = ctx.systemRoot; env.windir = ctx.systemRoot; env.ComSpec = win32.join(ctx.systemRoot, "System32", "cmd.exe"); env.PATHEXT = ".COM;.EXE;.BAT;.CMD"; }
  return env;
}

export const DEFAULT_LIMITS = { memoryMb: 4096, activeProcesses: 64, timeoutMs: 300_000 };

/**
 * Node options for the probe's own start. Without them Node canonicalizes the entry file's path at start-up by calling lstat on every ancestor
 * folder (fs.realpathSync), and a container granted only its fixture folders is refused on those ancestors (EPERM on the account's profile folder;
 * community report: https://github.com/openai/codex/issues/34872, unverified for AppContainer), so the probe would die before testing anything.
 * The probe imports only `node:` modules, so keeping the given path changes nothing else. Tools the probe starts (npm) do not get them on purpose:
 * whether they start is part of what the experiment measures.
 */
export const PROBE_NODE_OPTIONS = ["--preserve-symlinks", "--preserve-symlinks-main"];

/** The launcher's argument list for one cell. Pure; the tests compare it with fixed expectations. */
export function buildLauncherArgs(cell, plan, ctx, limits = DEFAULT_LIMITS) {
  const args = ["run", "--name", ctx.profileName ?? PROFILE_NAME];
  const grant = (mode, path, soft = false) => args.push(soft ? "--grant-soft" : "--grant", `${mode}:${path}`);
  // Required grants: the container's own folders. Soft grants: the program folders it must execute from (they may belong to the system and need rights the account lacks).
  grant("modify", plan.workspace); grant("modify", plan.home); grant("modify", plan.scratch); grant("ro", plan.probeDir);
  if (cell.protect) grant("deny-write", plan.protectedDir);
  for (const dir of ctx.programDirs) grant("rx", dir, true);
  args.push("--aap-policy", cell.aapPolicy);
  if (cell.win32kDisabled) args.push("--win32k-off");
  args.push("--memory-mb", String(limits.memoryMb), "--active-processes", String(limits.activeProcesses), "--ui-limits", "--timeout-ms", String(limits.timeoutMs));
  args.push("--stdout", join(plan.outDir, "stdout.txt"), "--stderr", join(plan.outDir, "stderr.txt"), "--cwd", plan.workspace);
  for (const [k, v] of Object.entries(ctx.childEnv)) args.push("--env", `${k}=${v}`);
  args.push("--exe", ctx.nodeExe, "--cmdline", buildCommandLine(ctx.nodeExe, [...PROBE_NODE_OPTIONS, plan.probeFile, plan.configFile]));
  return args;
}

// ---------------------------------------------------------------------------------------------------------------- reading what came back

/** The launcher's one JSON line: the last line of its output that parses as an object with tool = nn-appc-launcher. */
export function parseLauncherLine(text) {
  for (const line of String(text ?? "").split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { const o = JSON.parse(t); if (o && o.tool === "nn-appc-launcher") return o; } catch { /* not this line */ }
  }
  return undefined;
}

/** The probe's report from the child's captured output; undefined when the line is missing or damaged. */
export function extractProbeReport(text) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const i = line.indexOf(REPORT_PREFIX);
    if (i < 0) continue;
    try { return JSON.parse(line.slice(i + REPORT_PREFIX.length)); } catch { return undefined; }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------- the host's witnesses and the verdicts

const readText = (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };

/** What the host sees after a run: files that must not have changed, files that must not exist, connections the listeners counted. */
export function collectWitness(plan, ctx) {
  const created = (dir, name) => existsSync(join(dir, name));
  return {
    systemCreated: ctx.systemPaths.filter((p) => existsSync(p)).concat(existsSync(join(ctx.systemFolder, "nn-appc-extra")) ? [join(ctx.systemFolder, "nn-appc-extra")] : []).length,
    outsideFileChanged: readText(plan.outsideFile) !== SECRETS.original,
    hostDirsCreated: [plan.outsideDir, plan.controllerDir, plan.credentialDir].filter((d) => created(d, "nn-created")).length,
    linkFileChanged: readText(plan.linkTargetFile) !== SECRETS.original,
    linkDirCreated: created(plan.linkTargetDir, "nn-via-link") ? 1 : 0,
    protectedChanged: readText(plan.protectedConfig) !== SECRETS.git || created(plan.protectedDir, "nn-hook"),
    loopbackConnections: ctx.loopbackConnections(),
    outboundConnections: ctx.outboundConnections(),
  };
}

/** The host-side proof problem for one probe id, or undefined. */
export function witnessProblem(id, w) {
  switch (id) {
    case "deny-write-system": case "extra-write-system-folder": return w.systemCreated > 0 ? "a file was created in a system folder" : undefined;
    case "deny-write-host-path": return w.outsideFileChanged || w.hostDirsCreated > 0 ? "a host file outside the workspace was changed or created" : undefined;
    case "deny-symlink-write": return w.linkFileChanged || w.linkDirCreated > 0 ? "a write through a link changed a host path" : undefined;
    case "deny-network-loopback": return w.loopbackConnections > 0 ? "the host's loopback listener received a connection" : undefined;
    case "extra-outbound-connect": return w.outboundConnections > 0 ? "the host's non-loopback listener received a connection" : undefined;
    case "deny-write-protected-name": return w.protectedChanged ? "a protected name under the workspace was changed" : undefined;
    default: return undefined;
  }
}

const detailOf = (probe) => probe.attempts.map((a) => `${a.name}=${a.outcome}${a.code ? `(${a.code})` : ""}${a.note ? `[${a.note}]` : ""}`).join(" ");

/** One probe's verdict: pass | weak | fail | inconclusive (weak: nothing got through, but not every refusal was an access-denied code). */
export function judgeProbe(probe, witness, controlsOk) {
  const actual = summarize(probe.expect, probe.attempts);
  const detail = detailOf(probe);
  const problem = witness === undefined ? undefined : witnessProblem(probe.id, witness);
  let verdict;
  if (problem !== undefined) verdict = "fail";
  else if (probe.expect === "allowed") verdict = actual === "allowed" ? "pass" : "fail";
  else if (actual === "allowed") verdict = "fail";
  else if (actual === "denied") verdict = "pass";
  else if (actual === "denied-weak") verdict = "weak";
  else verdict = "inconclusive";
  if (verdict === "pass" && probe.expect === "denied" && !controlsOk) verdict = "weak";
  if (probe.expect === "denied" && probe.attempts.some((a) => a.note === "content-visible") && verdict !== "fail") verdict = "fail";
  return { id: probe.id, group: probe.group, expect: probe.expect, actual, verdict, detail: problem ? `${detail}; ${problem}` : detail, attempts: probe.attempts.map(({ name, outcome, code }) => ({ name, outcome, ...(code ? { code } : {}) })) };
}

/** All verdicts of a cell. A probe the child never reported is inconclusive; controls that failed make every denial only "weak". */
export function judgeCell(probeReport, witness) {
  const byId = new Map((probeReport?.probes ?? []).map((p) => [p.id, p]));
  const controlsOk = CONTROL_IDS.every((id) => { const p = byId.get(id); return p !== undefined && summarize(p.expect, p.attempts) === "allowed"; });
  return ALL_PROBE_IDS.map((id) => {
    const p = byId.get(id);
    if (p === undefined) return { id, group: groupOf(id), expect: id.startsWith("tool-") || id.startsWith("control-") ? "allowed" : "denied", actual: "no-report", verdict: "inconclusive", detail: "the probe did not report this item", attempts: [] };
    return judgeProbe(p, witness, controlsOk);
  });
}

export const groupOf = (id) => (CASE_IDS.includes(id) ? "case" : TOOL_IDS.includes(id) ? "tool" : "extra");

export function tally(results) {
  const t = { pass: 0, weak: 0, fail: 0, inconclusive: 0 };
  for (const r of results) t[r.verdict]++;
  return t;
}

// ---------------------------------------------------------------------------------------------------------------- the report

/** Soft grants that failed with access denied (5) or a privilege error: what needed more rights than the account had. */
export function adminNeeded(launch) {
  return (launch?.grants ?? []).filter((g) => g.soft && !g.applied && [5, 1314, 1346].includes(g.errorCode)).map((g) => ({ path: g.path, mode: g.mode, errorCode: g.errorCode }));
}

export function buildReport({ now, host, cells, profile, cleanup, notes = [] }) {
  const needs = cells.flatMap((c) => adminNeeded(c.launch));
  const unique = [...new Map(needs.map((n) => [`${n.path}|${n.mode}`, n])).values()];
  return {
    schema: REPORT_SCHEMA, generatedAt: now, host, profile, notes,
    needsAdmin: { observed: unique.length > 0 || host.elevated === true, runIsElevated: host.elevated === true, softGrantsRefused: unique },
    cells, cleanup,
  };
}

/** The report's schema check: a list of problems (empty when it is well formed). */
export function validateReport(r) {
  const p = [];
  const need = (cond, msg) => { if (!cond) p.push(msg); };
  need(r && r.schema === REPORT_SCHEMA, "schema");
  need(typeof r?.generatedAt === "string", "generatedAt");
  need(r?.host && typeof r.host.platform === "string" && typeof r.host.elevated === "boolean" && typeof r.host.sessionId === "number", "host");
  need(Array.isArray(r?.cells) && r.cells.length > 0, "cells");
  need(r?.needsAdmin && typeof r.needsAdmin.observed === "boolean" && Array.isArray(r.needsAdmin.softGrantsRefused), "needsAdmin");
  need(r?.cleanup && typeof r.cleanup.profileDeleted === "boolean", "cleanup");
  for (const c of r?.cells ?? []) {
    need(typeof c.id === "string" && c.dims && typeof c.dims.lpac === "boolean", `cell ${c.id}: id/dims`);
    need(c.launch && typeof c.launch.ok === "boolean", `cell ${c.id}: launch`);
    need(Array.isArray(c.results) && c.results.length === ALL_PROBE_IDS.length, `cell ${c.id}: results`);
    for (const x of c.results ?? []) {
      need(ALL_PROBE_IDS.includes(x.id), `cell ${c.id}: unknown probe ${x.id}`);
      need(["allowed", "denied"].includes(x.expect), `cell ${c.id}/${x.id}: expect`);
      need(["pass", "weak", "fail", "inconclusive"].includes(x.verdict), `cell ${c.id}/${x.id}: verdict`);
      need(typeof x.actual === "string" && Array.isArray(x.attempts), `cell ${c.id}/${x.id}: actual/attempts`);
    }
  }
  return p;
}

const MARK = { pass: "pass", weak: "weak", fail: "FAIL", inconclusive: "inc" };

/** The results table (markdown). One row per cell, one column per probe; a legend and per-cell notes follow. */
export function renderMarkdown(report) {
  const L = [];
  L.push("# Windows AppContainer experiment: results", "");
  L.push(`Generated ${report.generatedAt}. Host: ${report.host.platform} ${report.host.release ?? ""} (node ${report.host.node ?? "?"}); session id ${report.host.sessionId}; elevated: ${report.host.elevated}.`, "");
  L.push(`Anything that needed administrator rights: ${report.needsAdmin.observed ? "YES" : "no"} (run elevated: ${report.needsAdmin.runIsElevated}; soft grants refused: ${report.needsAdmin.softGrantsRefused.length}).`, "");
  L.push("Legend: pass = held (or worked) as expected; weak = nothing got through, but a refusal was not an access-denied code (or the controls failed); FAIL = the opposite of expected; inc = no verdict (not reported, skipped, launcher refused).", "");
  const ids = ALL_PROBE_IDS;
  L.push(`| cell | started | ${ids.map((i) => i.replace(/^(control|deny|extra|tool)-/, "$1:")).join(" | ")} | tally |`);
  L.push(`|${" --- |".repeat(ids.length + 3)}`);
  for (const c of report.cells) {
    const started = c.launch.childStarted ? (c.launch.timedOut ? "timed out" : `exit ${c.launch.exitCode}`) : `REFUSED (${c.launch.stage ?? "?"})`;
    const t = tally(c.results);
    L.push(`| ${c.id}${c.sameAs ? ` (same as ${c.sameAs})` : ""} | ${started} | ${c.results.map((r) => MARK[r.verdict]).join(" | ")} | ${t.pass}/${t.weak}/${t.fail}/${t.inconclusive} |`);
  }
  L.push("", "Tally = pass/weak/FAIL/inc.", "");
  for (const c of report.cells) {
    L.push(`## ${c.id}`, "");
    L.push(`- Settings: LPAC ${c.dims.lpac ? "on" : "off"}, Win32k ${c.dims.win32kDisabled ? "disabled" : "enabled"}, AAP opt-out flag ${c.dims.aapOptOut ? "on" : "off"} (policy attribute: ${c.dims.aapPolicy}), protected-name deny ${c.dims.protect ? "on" : "off"}.`);
    if (c.sameAs) L.push(`- Same configuration as ${c.sameAs} (no policy attribute); kept as a repeat.`);
    const l = c.launch;
    if (!l.childStarted) L.push(`- The launcher refused to start the program: stage ${l.stage ?? "?"}, ${l.error ?? "no message"}.`);
    else L.push(`- Program ${l.timedOut ? "timed out" : `ended with ${l.exitCode}`} after ${l.elapsedMs ?? "?"} ms; leftover processes: ${l.leftoverProcesses ?? "?"}; all grants revoked: ${l.allGrantsRevoked}.`);
    if (c.softGrantFailures.length > 0) L.push(`- Soft grants refused: ${c.softGrantFailures.map((g) => `${g.mode} ${g.path} (error ${g.errorCode})`).join("; ")}.`);
    if (c.plantNotes.length > 0) L.push(`- Fixture notes: ${c.plantNotes.join("; ")}.`);
    if (c.probeReport !== "ok") L.push(`- Probe report: ${c.probeReport}.`);
    if ((c.stderrHead ?? []).length > 0) L.push(`- First lines the program wrote to its error output: ${c.stderrHead.map((s) => `\`${s.replaceAll("`", "'")}\``).join(" | ")}`);
    for (const r of c.results.filter((x) => x.verdict === "fail" || x.verdict === "weak")) L.push(`- ${r.verdict.toUpperCase()} ${r.id}: ${r.detail}`);
    if (c.startupDenials.length > 0) L.push(`- Access-denied lines seen at tool start-up (${c.startupDenials.length}): ${c.startupDenials.slice(0, 6).map((d) => `${d.tool}: ${d.line}`).join(" | ")}`);
    L.push("");
  }
  L.push("## Clean-up", "", `- Profile deleted: ${report.cleanup.profileDeleted}; folders removed: ${report.cleanup.foldersRemoved}; grants left: ${report.cleanup.grantsLeft}.`);
  for (const n of report.notes) L.push(`- ${n}`);
  return `${L.join("\n")}\n`;
}

/** The first few non-empty lines of the child's error output, each cut short (kept only when the probe's report is missing, to say why). */
export function stderrHead(text, lines = 6, width = 200) {
  return String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").slice(0, lines).map((l) => l.slice(0, width));
}

/** Replaces names a public log must not carry (fixture root, home, temp, account, machine) with fixed words. */
export function scrubText(text, names = {}) {
  let out = String(text);
  const pairs = [[names.root, "<fixture-root>"], [names.home, "<home>"], [names.tmp, "<temp>"], [names.user, "<account>"], [names.host, "<machine>"]];
  for (const [value, word] of pairs) {
    if (typeof value !== "string" || value.length < 3) continue;
    for (const v of new Set([value, value.replaceAll("\\", "/"), value.replaceAll("\\", "\\\\")])) out = out.split(v).join(word);
  }
  return out.replace(/S-1-\d+(?:-\d+){2,}/g, "<sid>");
}

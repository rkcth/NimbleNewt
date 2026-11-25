// NimbleNewt experiment (not product code): the harness's pure logic. Nothing here starts the launcher or needs Windows, so the unit tests
// (scripts/windows-appcontainer-experiment.test.mjs) run on Linux with fakes. run-experiment.mjs is the part that does the real work.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { gzipSync } from "node:zlib";
import { REPORT_PREFIX, rebuildFromProgress, summarize } from "./probe.mjs";

export const REPORT_SCHEMA = "nn-appc-experiment-1";
export const PROFILE_NAME = "NimbleNewtExperiment";

/** The ten containment cases of packages/worker/src/sandbox/containment.ts (kept in that file's order). */
export const CASE_IDS = [
  "control-write-own-directories", "control-read-own-decoy", "deny-write-system", "deny-write-host-path", "deny-symlink-read",
  "deny-symlink-write", "deny-credential-read", "deny-controller-data-read", "deny-network-loopback", "deny-write-protected-name",
];
export const EXTRA_IDS = [
  "extra-outbound-connect", "extra-read-owner-profile", "extra-write-system-folder", "extra-junction-self-made", "extra-hardlink-read",
  "extra-protect-rename-dir", "extra-protect-delete-dir", "extra-protect-replace-junction", "extra-protect-rename-parent",
];
/** Information only (no verdict): the NUL device and how the probe may start children. */
export const DIAG_IDS = ["diag-nul-open", "diag-spawn-modes"];
export const TOOL_IDS = ["tool-node-version", "tool-git-version", "tool-git-init-commit", "tool-npm-version", "tool-npm-ci-offline"];
export const ALL_PROBE_IDS = [...CASE_IDS, ...EXTRA_IDS, ...DIAG_IDS, ...TOOL_IDS];
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
    cells.push({ id, lpac, win32kDisabled, aapOptOut, aapPolicy, protect: true, sameAs: undefined, capabilities: [], firewallBlock: false, loopbackExempt: false });
  }
  for (const c of cells) if (!c.lpac && !c.aapOptOut) c.sameAs = `lpac-off_win32k-${c.win32kDisabled ? "disabled" : "enabled"}_aapoptout-on`;
  cells.push({ id: "baseline-no-protect", lpac: true, win32kDisabled: false, aapOptOut: true, aapPolicy: "optout", protect: false, sameAs: undefined, capabilities: [], firewallBlock: false, loopbackExempt: false });
  return cells;
}

/**
 * Round 3: the configurations the ten cases (and the tools and the protected-name operations) are run in. Win32k stays enabled (round 2: disabling it stops Node).
 *   ac-nocap                  a plain AppContainer, no capability.
 *   ac-nocap-noprotect        the same without the deny entry on `.git`: the contrast that shows what the protection (not the container) stops.
 *   ac-inet-private           + internetClient + privateNetworkClientServer: the container may use the network, so the network cases show what a capability alone allows.
 *   ac-inet-private-fwblock   the same, with an outbound BLOCK firewall rule scoped to the container's package SID (needs administrator rights).
 *   ac-inet-private-loopback  the same, plus a loopback exemption for the package (CheckNetIsolation): the container may reach the host's loopback listener.
 *   ac-inet-private-loopback-fwblock  the loopback exemption AND the block rule: does the rule stop what the capabilities and the exemption allow?
 *   ac-inet-private-loopback-byname   the exemption added by the package's NAME (`CheckNetIsolation LoopbackExempt -a -n=<name>`) instead of its SID (round 3b), read back by SID
 *   lpac-optout-reg           LPAC (policy optout) + registryRead (the smallest LPAC that runs Node).
 *   lpac-optout-reg-com       LPAC + registryRead + lpacCom.
 */
export function configCells() {
  const c = (id, o) => ({ id, lpac: false, win32kDisabled: false, aapOptOut: false, aapPolicy: "none", protect: true, protectMode: "deny-write", rootMode: "modify", limits: "all", sameAs: undefined, capabilities: [], firewallBlock: false, loopbackExempt: false, ...o });
  const net = ["internetClient", "privateNetworkClientServer"];
  const sealed = { protectMode: "seal", rootMode: "modify-root" };
  return [
    c("ac-nocap", {}),
    c("ac-nocap-noprotect", { protect: false }),
    c("ac-inet-private", { capabilities: net }),
    c("ac-inet-private-fwblock", { capabilities: net, firewallBlock: true }),
    c("ac-inet-private-loopback", { capabilities: net, loopbackExempt: true }),
    c("ac-inet-private-loopback-fwblock", { capabilities: net, loopbackExempt: true, firewallBlock: true }),
    c("ac-inet-private-loopback-byname", { capabilities: net, loopbackExempt: "name" }),
    c("lpac-optout-reg", { lpac: true, aapOptOut: true, aapPolicy: "optout", capabilities: ["registryRead"] }),
    c("lpac-optout-reg-com", { lpac: true, aapOptOut: true, aapPolicy: "optout", capabilities: ["registryRead", "lpacCom"] }),
    // Round 4: the protected-name layouts and the job limits. Each differs from `ac-nocap` in one way (except the last three, which combine the layout that worked).
    c("ac-nocap-deny-strong", { protectMode: "deny-strong" }),
    c("ac-nocap-sealed", { protectMode: "seal" }),
    c("ac-nocap-sealed-root", sealed),
    c("ac-nocap-sealed-root-nolimits", { ...sealed, limits: "none" }),
    c("ac-inet-private-sealed-root", { ...sealed, capabilities: net }),
    c("lpac-optout-reg-com-sealed-root", { ...sealed, lpac: true, aapOptOut: true, aapPolicy: "optout", capabilities: ["registryRead", "lpacCom"] }),
  ];
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
    probeFile: j("probe", "probe.mjs"), configFile: j("probe", "probe-config.json"), progressFile: j("scratch", "probe-progress.txt"),
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

/**
 * The files of the tiny offline npm project: package.json, a lockfile naming the local tarballs with their integrity, and the tarballs.
 * `count` 1 (the default) is the one-package project of rounds 1 and 2 (`nn-tiny`); a larger count makes `nn-tiny-0` ... (round 3's timing of a bigger install).
 */
export function npmFixtureFiles(count = 1) {
  const names = count === 1 ? ["nn-tiny"] : Array.from({ length: count }, (_, i) => `nn-tiny-${i}`);
  const entries = names.map((name) => {
    const tgz = makeTarball({
      "package/package.json": JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
      "package/index.js": `module.exports = '${name}';\n`,
    });
    return { name, tgz, dep: `file:vendor/${name}-1.0.0.tgz`, integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}` };
  });
  const dependencies = Object.fromEntries(entries.map((e) => [e.name, e.dep]));
  return {
    tgz: entries[0].tgz,
    tarballs: entries.map((e) => ({ file: `${e.name}-1.0.0.tgz`, data: e.tgz })),
    "package.json": JSON.stringify({ name: "nn-appc-fixture", version: "1.0.0", private: true, dependencies }, null, 2),
    "package-lock.json": JSON.stringify({
      name: "nn-appc-fixture", version: "1.0.0", lockfileVersion: 3, requires: true,
      packages: { "": { name: "nn-appc-fixture", version: "1.0.0", dependencies }, ...Object.fromEntries(entries.map((e) => [`node_modules/${e.name}`, { version: "1.0.0", resolved: e.dep, integrity: e.integrity }])) },
    }, null, 2),
  };
}

/** Writes an offline npm project of `count` local packages into `dir` (package.json, lockfile, vendor/*.tgz). */
export function writeNpmProject(dir, count = 1) {
  const npm = npmFixtureFiles(count);
  mkdirSync(join(dir, "vendor"), { recursive: true });
  writeFileSync(join(dir, "package.json"), npm["package.json"]);
  writeFileSync(join(dir, "package-lock.json"), npm["package-lock.json"]);
  for (const t of npm.tarballs) writeFileSync(join(dir, "vendor", t.file), t.data);
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
  writeNpmProject(plan.npmProject, 1);
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
    // The probe ends itself: its budget for the tool steps, a watchdog for the whole run, and a progress file that names the step it was in.
    progressFile: plan.progressFile, budgetMs: ctx.probeBudgetMs ?? 52_000, watchdogMs: ctx.probeWatchdogMs ?? 60_000,
  };
}

/** The child's whole environment (nothing is inherited from the harness): names and fixed fixture paths only. */
export function buildChildEnv(plan, ctx, delimiter = ";") {
  const env = {
    HOME: plan.home, USERPROFILE: plan.home, APPDATA: plan.home, LOCALAPPDATA: plan.home, TEMP: plan.scratch, TMP: plan.scratch, TMPDIR: plan.scratch,
    PATH: ctx.pathDirs.join(delimiter),
    npm_config_cache: plan.npmCache, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    npm_config_userconfig: join(plan.home, ".npmrc"), npm_config_globalconfig: join(plan.home, ".npmglobalrc"),
    // As the product's launcher would set them: the programs the probe starts (npm) need the same Node options as the probe itself (lstat of C:\\ is refused to the container).
    NODE_OPTIONS: PROBE_NODE_OPTIONS.join(" "),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(plan.home, ".gitconfig"), GIT_TERMINAL_PROMPT: "0",
  };
  if (ctx.systemRoot) { env.SystemRoot = ctx.systemRoot; env.windir = ctx.systemRoot; env.ComSpec = win32.join(ctx.systemRoot, "System32", "cmd.exe"); env.PATHEXT = ".COM;.EXE;.BAT;.CMD"; }
  return env;
}

/** The hard limit per cell: the probe ends itself after 60 s at most, so 90 s means something is wrong (round 1 spent 300 s per cell on hangs). */
export const DEFAULT_LIMITS = { memoryMb: 4096, activeProcesses: 64, timeoutMs: 90_000 };

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
  // `modify-root` (round 4): the workspace folder itself may not be deleted or moved, everything inside may be modified.
  grant(cell.rootMode ?? "modify", plan.workspace); grant("modify", plan.home); grant("modify", plan.scratch); grant("ro", plan.probeDir);
  if (cell.protect) grant(cell.protectMode ?? "deny-write", plan.protectedDir);
  for (const dir of ctx.programDirs) grant("rx", dir, true);
  args.push("--aap-policy", cell.aapPolicy);
  for (const c of cell.capabilities ?? []) args.push("--capability", c);
  if (cell.win32kDisabled) args.push("--win32k-off");
  // `limits: "none"` (round 4): no job memory, process-count or UI limit (the job still kills everything when it closes).
  if (cell.limits !== "none") args.push("--memory-mb", String(limits.memoryMb), "--active-processes", String(limits.activeProcesses), "--ui-limits");
  args.push("--timeout-ms", String(limits.timeoutMs));
  // What the grants really wrote, read from the DACLs after they were applied and again after the program ended (round 4: the protected-name diagnosis).
  for (const d of [plan.workspace, plan.protectedDir, plan.protectedConfig]) args.push("--dump", d);
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

/** The label of a cell whose report was rebuilt from the progress file (printed in the table and the cell's notes). */
export const REBUILT_LABEL = "partial: rebuilt from progress";

/**
 * Which report a cell is judged by. The probe's own final report when it is whole. Otherwise (no report, a watchdog's partial report, a fatal one) the report rebuilt from the progress
 * file's RESULT and ATTEMPT lines when that holds more steps than the report the probe printed; the label then says so. `label` is "ok" for a whole report.
 */
export function chooseProbeReport(rep, progressText) {
  if (rep !== undefined && !rep.partial && !rep.fatal) return { report: rep, label: "ok" };
  const rebuilt = rebuildFromProgress(progressText);
  const printed = rep?.probes?.length ?? 0;
  if (rep?.rebuilt === true) return { report: rep, label: REBUILT_LABEL };
  const usable = rebuilt.probes.filter((p) => p.unfinished !== true || p.attempts.length > 1).length;
  if (usable > printed) {
    return { report: { ...rebuilt, watchdog: rep?.watchdog ?? rebuilt.watchdog, startupDenials: [...(rep?.startupDenials ?? []), ...rebuilt.startupDenials].slice(0, 40) }, label: REBUILT_LABEL };
  }
  if (rep === undefined) return { report: undefined, label: "missing" };
  if (rep.fatal) return { report: rep, label: `fatal: ${rep.fatal}` };
  return { report: rep, label: `partial: the probe's watchdog ended it in step ${rep.watchdog?.step ?? "?"} after ${rep.watchdog?.elapsedMs ?? "?"} ms` };
}

// ---------------------------------------------------------------------------------------------------------------- ACL read-back

/** The granted paths named in a launcher argument list (--grant and --grant-soft), without their modes, each once. */
export function grantedPaths(args) {
  const out = [];
  args.forEach((a, i) => { if (a === "--grant" || a === "--grant-soft") { const spec = args[i + 1] ?? ""; const path = spec.slice(spec.indexOf(":") + 1); if (!out.includes(path)) out.push(path); } });
  return out;
}

/**
 * Reads the container's explicit entries back from every granted path with the launcher's `check` command. When any is left, asks the launcher to revoke on those paths
 * and reads again. Returns `first` (what the first read-back found: [{path, entriesLeft}], entriesLeft null when unreadable) and `final` (after the second revoke);
 * a launcher that says nothing counts as every path unknown. Never throws.
 */
export function aclReadBack(exec, launcherPath, profileName, paths) {
  if (paths.length === 0) return { first: [], final: [] };
  const grantArgs = paths.flatMap((p) => ["--grant", `ro:${p}`]);
  const run = (cmd) => { try { return parseLauncherLine(exec(launcherPath, [cmd, "--name", profileName, ...grantArgs], { timeoutMs: 120_000 }).stdout); } catch { return undefined; } };
  const left = (line) => (line === undefined ? [{ path: "(all)", entriesLeft: null }] : (line.grants ?? []).filter((g) => g.entriesLeft !== 0).map((g) => ({ path: g.path, entriesLeft: g.entriesLeft ?? null })));
  const first = left(run("check"));
  if (first.length === 0) return { first, final: [] };
  run("revoke");
  return { first, final: left(run("check")) };
}

// ---------------------------------------------------------------------------------------------------------------- the host's witnesses and the verdicts

const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
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
    protectedChanged: readText(plan.protectedConfig) !== SECRETS.git || created(plan.protectedDir, "nn-hook") || created(plan.protectedDir, "nn-hook-via-junction"),
    protectedDirGone: !existsSync(plan.protectedDir) || existsSync(`${plan.protectedDir}-renamed`) || existsSync(`${plan.protectedDir}-away`),
    protectedDirLink: isLink(plan.protectedDir),
    workspaceMoved: !existsSync(plan.workspace) || existsSync(`${plan.workspace}-renamed`),
    ownJunctionWrite: created(plan.outsideDir, "nn-via-own-junction") ? 1 : 0,
    hardlinkMade: existsSync(join(plan.workspace, "own-hardlink")) ? 1 : 0,
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
    case "extra-protect-rename-dir": case "extra-protect-delete-dir": case "extra-protect-replace-junction": return w.protectedDirGone || w.protectedDirLink ? "the protected folder was moved, deleted or replaced by a link" : undefined;
    case "extra-protect-rename-parent": return w.workspaceMoved ? "the workspace folder itself was moved" : undefined;
    case "extra-junction-self-made": return w.ownJunctionWrite > 0 ? "a write through a junction the container made reached a host folder" : undefined;
    case "extra-hardlink-read": return w.hardlinkMade > 0 ? "a hard link to the controller's file exists in the workspace" : undefined;
    default: return undefined;
  }
}

const detailOf = (probe) => probe.attempts.map((a) => `${a.name}=${a.outcome}${a.code ? `(${a.code})` : ""}${a.note ? `[${a.note}]` : ""}`).join(" ");

/** One probe's verdict: pass | weak | fail | inconclusive (weak: nothing got through, but not every refusal was an access-denied code). */
export function judgeProbe(probe, witness, controlsOk) {
  const actual = summarize(probe.expect, probe.attempts);
  const detail = detailOf(probe);
  // A step that was running when the probe stopped (rebuilt from the progress file) has no verdict, whatever its attempts so far show.
  if (probe.unfinished === true && probe.group !== "diag") return { id: probe.id, group: probe.group, expect: probe.expect, actual: "no-report", verdict: "inconclusive", detail: `the probe stopped while this step was running; ${detail}`, attempts: probe.attempts.map(({ name, outcome, code }) => ({ name, outcome, ...(code ? { code } : {}) })) };
  // A diagnostic has no verdict: what happened is the result.
  if (probe.group === "diag") return { id: probe.id, group: probe.group, expect: probe.expect, actual: probe.attempts.every((a) => a.outcome === "allowed") ? "allowed" : "mixed", verdict: "info", detail, attempts: probe.attempts.map(({ name, outcome, code, note }) => ({ name, outcome, ...(code ? { code } : {}), ...(note ? { note } : {}) })), ms: probe.ms };
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
  return { id: probe.id, group: probe.group, expect: probe.expect, actual, verdict, detail: problem ? `${detail}; ${problem}` : detail, attempts: probe.attempts.map(({ name, outcome, code, note }) => ({ name, outcome, ...(code ? { code } : {}), ...(typeof note === "string" && probe.group === "tool" ? { note } : {}) })), ...(typeof probe.ms === "number" ? { ms: probe.ms } : {}) };
}

/** All verdicts of a cell. A probe the child never reported is inconclusive; controls that failed make every denial only "weak". */
export function judgeCell(probeReport, witness) {
  // A probe rebuilt from the progress file may lack its group and expectation (a step that hung before its first attempt line): they follow from the id.
  const byId = new Map((probeReport?.probes ?? []).map((p) => [p.id, { ...p, group: p.group ?? groupOf(p.id), expect: p.expect ?? expectOf(p.id) }]));
  const controlsOk = CONTROL_IDS.every((id) => { const p = byId.get(id); return p !== undefined && summarize(p.expect, p.attempts) === "allowed"; });
  return ALL_PROBE_IDS.map((id) => {
    const p = byId.get(id);
    if (p === undefined) return { id, group: groupOf(id), expect: id.startsWith("tool-") || id.startsWith("control-") || id.startsWith("diag-") ? "allowed" : "denied", actual: "no-report", verdict: "inconclusive", detail: "the probe did not report this item", attempts: [] };
    return judgeProbe(p, witness, controlsOk);
  });
}

export const expectOf = (id) => (id.startsWith("tool-") || id.startsWith("control-") || id.startsWith("diag-") ? "allowed" : "denied");
export const groupOf = (id) => (CASE_IDS.includes(id) ? "case" : TOOL_IDS.includes(id) ? "tool" : DIAG_IDS.includes(id) ? "diag" : "extra");

export function tally(results) {
  const t = { pass: 0, weak: 0, fail: 0, inconclusive: 0, info: 0 };
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
      need(["pass", "weak", "fail", "inconclusive", "info"].includes(x.verdict), `cell ${c.id}/${x.id}: verdict`);
      need(typeof x.actual === "string" && Array.isArray(x.attempts), `cell ${c.id}/${x.id}: actual/attempts`);
    }
  }
  return p;
}

const MARK = { pass: "pass", weak: "weak", fail: "FAIL", inconclusive: "inc", info: "info" };

/** The results table (markdown). One row per cell, one column per probe; a legend and per-cell notes follow. */
export function renderMarkdown(report) {
  const L = [];
  L.push("# Windows AppContainer experiment: results", "");
  L.push(`Generated ${report.generatedAt}. Host: ${report.host.platform} ${report.host.release ?? ""} (node ${report.host.node ?? "?"}); session id ${report.host.sessionId}; elevated: ${report.host.elevated}.`, "");
  L.push(`Anything that needed administrator rights: ${report.needsAdmin.observed ? "YES" : "no"} (run elevated: ${report.needsAdmin.runIsElevated}; soft grants refused: ${report.needsAdmin.softGrantsRefused.length}).`, "");
  L.push("Legend: pass = held (or worked) as expected; weak = nothing got through, but a refusal was not an access-denied code (or the controls failed); FAIL = the opposite of expected; inc = no verdict (not reported, skipped, launcher refused); info = a diagnostic, no verdict.", "");
  const ids = ALL_PROBE_IDS;
  L.push(`| cell | started | ${ids.map((i) => i.replace(/^(control|deny|extra|tool)-/, "$1:")).join(" | ")} | tally |`);
  L.push(`|${" --- |".repeat(ids.length + 3)}`);
  for (const c of report.cells) {
    const started = (c.launch.childStarted ? (c.launch.timedOut ? "timed out" : `exit ${c.launch.exitCode}`) : `REFUSED (${c.launch.stage ?? "?"})`) + (c.probeReport === REBUILT_LABEL ? ", partial: rebuilt from progress" : "");
    const t = tally(c.results);
    L.push(`| ${c.id}${c.sameAs ? ` (same as ${c.sameAs})` : ""} | ${started} | ${c.results.map((r) => MARK[r.verdict]).join(" | ")} | ${t.pass}/${t.weak}/${t.fail}/${t.inconclusive} |`);
  }
  L.push("", "Tally = pass/weak/FAIL/inc.", "");
  // The same data turned around: one row per case, one column per configuration (the verdict table of round 3).
  L.push("### Verdict per case and configuration", "");
  L.push(`| case | ${report.cells.map((c) => c.id).join(" | ")} |`, `|${" --- |".repeat(report.cells.length + 1)}`);
  for (const id of ids) L.push(`| ${id} | ${report.cells.map((c) => { const r = c.results.find((x) => x.id === id); return r ? MARK[r.verdict] : "-"; }).join(" | ")} |`);
  L.push("");
  const timed = report.cells.filter((c) => c.results.some((r) => typeof r.ms === "number"));
  if (timed.length > 0) {
    L.push("### Time per probe step (ms)", "", `| step | ${timed.map((c) => c.id).join(" | ")} |`, `|${" --- |".repeat(timed.length + 1)}`);
    for (const id of ids) L.push(`| ${id} | ${timed.map((c) => c.results.find((x) => x.id === id)?.ms ?? "-").join(" | ")} |`);
    L.push("");
  }
  for (const c of report.cells) {
    L.push(`## ${c.id}`, "");
    L.push(`- Settings: LPAC ${c.dims.lpac ? "on" : "off"}, Win32k ${c.dims.win32kDisabled ? "disabled" : "enabled"}, AAP opt-out flag ${c.dims.aapOptOut ? "on" : "off"} (policy attribute: ${c.dims.aapPolicy}), protected-name layout ${c.dims.protectMode ?? (c.dims.protect ? "deny-write" : "none")}; workspace folder entry ${c.dims.rootMode ?? "modify"}; job limits ${c.dims.limits ?? "all"}; capabilities ${(c.dims.capabilities ?? []).join(", ") || "none"}; outbound block rule ${c.dims.firewallBlock ? "yes" : "no"}; loopback exemption ${c.dims.loopbackExempt ? "yes" : "no"}.`);
    if (c.net) L.push(`- Network set-up: ${c.net.summary}`);
    if (c.sameAs) L.push(`- Same configuration as ${c.sameAs} (no policy attribute); kept as a repeat.`);
    const l = c.launch;
    if (!l.childStarted) L.push(`- The launcher refused to start the program: stage ${l.stage ?? "?"}, ${l.error ?? "no message"}.`);
    else L.push(`- Program ${l.timedOut ? "timed out" : `ended with ${l.exitCode}`} after ${l.elapsedMs ?? "?"} ms; leftover processes: ${l.leftoverProcesses ?? "?"}; all grants revoked: ${l.allGrantsRevoked}.`);
    if ((c.aclFirstReadBack ?? []).length > 0) L.push(`- ACL read-back after the run found entries left on: ${c.aclFirstReadBack.map((x) => `${x.path} (${x.entriesLeft})`).join("; ")}; after a second revoke: ${(c.aclLeft ?? []).length === 0 ? "none left" : c.aclLeft.map((x) => `${x.path} (${x.entriesLeft})`).join("; ")}.`);
    else if (c.aclLeft !== undefined) L.push("- ACL read-back of every granted path after the run: no entry left.");
    for (const [label, list] of [["after the grants", l.daclsBefore], ["after the program ended", l.daclsAfter]]) {
      if (Array.isArray(list)) for (const d of list) L.push(`- DACL ${label}, \`${d.path.replace(/^.*[\\/]ws/, "ws")}\`: \`${d.sddl.replaceAll("`", "'")}\``);
    }
    if (c.softGrantFailures.length > 0) L.push(`- Soft grants refused: ${c.softGrantFailures.map((g) => `${g.mode} ${g.path} (error ${g.errorCode})`).join("; ")}.`);
    if (c.plantNotes.length > 0) L.push(`- Fixture notes: ${c.plantNotes.join("; ")}.`);
    if (c.probeReport !== "ok") L.push(`- Probe report: ${c.probeReport}.`);
    if (c.probeReport !== "ok" && (c.probeProgress ?? []).length > 0) L.push(`- Last probe steps before it stopped (progress file): ${c.probeProgress.map((x) => `\`${x}\``).join(" | ")}`);
    if ((c.stderrHead ?? []).length > 0) L.push(`- First lines the program wrote to its error output: ${c.stderrHead.map((s) => `\`${s.replaceAll("`", "'")}\``).join(" | ")}`);
    for (const r of c.results.filter((x) => x.verdict === "fail" || x.verdict === "weak" || x.verdict === "info")) L.push(`- ${r.verdict.toUpperCase()} ${r.id}: ${r.detail}`);
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
  // Capability SIDs (S-1-15-3-...) are fixed public values and stay readable; every other SID (accounts, the container) is replaced.
  return out.replace(/S-1-\d+(?:-\d+){2,}/g, (sid) => (sid.startsWith("S-1-15-3-") ? sid : "<sid>"));
}

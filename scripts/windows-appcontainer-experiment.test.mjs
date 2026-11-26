// Tests for experiments/windows-appcontainer: the harness's pure logic and its flow with a FAKE launcher. They run on Linux (and everywhere else); the real
// launcher and the real AppContainer only exist on Windows, so what they do is judged by the Windows run, not here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyError, isEntryPoint, isolatedStuck, runProbes, spawnIsolated, summarize, REPORT_PREFIX } from "../experiments/windows-appcontainer/probe.mjs";
import {
  ALL_PROBE_IDS, CASE_IDS, aclReadBack, grantedPaths, PROBE_NODE_OPTIONS, SECRETS, stderrHead, adminNeeded, buildChildEnv, buildCommandLine, buildFixturePlan, buildLauncherArgs, buildProbeConfig, buildReport, collectWitness,
  REBUILT_LABEL, chooseProbeReport, createFixtures, extractProbeReport, judgeCell, judgeProbe, makeTarball, matrixCells, parseLauncherLine, pickOutboundHost, quoteWindowsArg, removeTree, renderMarkdown,
  scrubText, selectCells, tally, validateReport, witnessProblem,
} from "../experiments/windows-appcontainer/lib.mjs";
import { OPTIONS as HOME_OPTIONS, childReport, groupVerdict, judgeHome, parseHomeLines, renderHomeMarkdown } from "../experiments/windows-appcontainer/home.mjs";
import { discoverTools, parseCli, runExperiment } from "../experiments/windows-appcontainer/run-experiment.mjs";
import {
  LADDER_STEPS, LPAC_COM, MAX_TIMEOUTS_PER_VARIANT, STEP_TIMEOUT_MS, WELL_KNOWN_CAPABILITY_SIDS, buildStepArgs, firewallCommands, judgeFirewall, judgeStep, ladderEnv, ladderPlan, ladderVariants,
  launcherLeft, clientCommand, renderFirewallMarkdown, renderLadderMarkdown, runFirewall, runLadder, selectVariants, stepExecutable, summarizeVariant, validateLadder,
} from "../experiments/windows-appcontainer/ladder.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The launcher's source (native/nn-launcher): the Windows part and the platform-neutral command line (src/args.rs, since A03b slice 3 review). */
const launcherSource = () => readFileSync(join(root, "native", "nn-launcher", "src", "win.rs"), "utf8") + "\n" + readFileSync(join(root, "native", "nn-launcher", "src", "args.rs"), "utf8") + "\n" + readFileSync(join(root, "native", "nn-launcher", "src", "desk.rs"), "utf8");
const exp = join(root, "experiments", "windows-appcontainer");
const tmp = () => mkdtempSync(join(os.tmpdir(), "nnac-"));

/** The second listening address of the firewall tests: 127.0.0.2 where the machine has it (Linux, Windows), else the machine's own non-loopback IPv4 address (macOS has no 127.0.0.2 on its loopback, so a listen there fails with EADDRNOTAVAIL). */
async function bindableOutboundHost() {
  const candidates = ["127.0.0.2", ...Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address)];
  for (const host of candidates) {
    const ok = await new Promise((res) => { const sv = net.createServer(); sv.once("error", () => res(false)); sv.listen(0, host, () => sv.close(() => res(true))); });
    if (ok) return host;
  }
  return "127.0.0.2";
}
const OUTBOUND_HOST = await bindableOutboundHost();

// ------------------------------------------------------------------------------------------------ command lines

test("argument quoting follows the Windows rules (spaces, quotes, trailing backslashes)", () => {
  assert.equal(quoteWindowsArg("plain"), "plain");
  assert.equal(quoteWindowsArg(""), '""');
  assert.equal(quoteWindowsArg("a b"), '"a b"');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg("C:\\Program Files\\x\\"), '"C:\\Program Files\\x\\\\"');
  assert.equal(quoteWindowsArg('a\\"b'), '"a\\\\\\"b"');
  assert.equal(buildCommandLine("C:\\n d\\node.exe", ["p.mjs", "c o.json"]), '"C:\\n d\\node.exe" p.mjs "c o.json"');
});

// ------------------------------------------------------------------------------------------------ the matrix and the launcher arguments

test("the matrix has eight cells plus the baseline, unique ids, and names the redundant cells", () => {
  const cells = matrixCells();
  assert.equal(cells.length, 9);
  assert.equal(new Set(cells.map((c) => c.id)).size, 9);
  assert.deepEqual(cells.filter((c) => c.sameAs).map((c) => c.id), ["lpac-off_win32k-enabled_aapoptout-off", "lpac-off_win32k-disabled_aapoptout-off"]);
  assert.equal(cells.find((c) => c.id === "lpac-on_win32k-enabled_aapoptout-on").aapPolicy, "optout");
  assert.equal(cells.find((c) => c.id === "lpac-on_win32k-enabled_aapoptout-off").aapPolicy, "optin");
  assert.equal(cells.find((c) => c.id === "lpac-off_win32k-disabled_aapoptout-on").aapPolicy, "none");
  assert.equal(cells.find((c) => c.id === "baseline-no-protect").protect, false);
  assert.deepEqual(selectCells("baseline-no-protect").map((c) => c.id), ["baseline-no-protect"]);
  assert.throws(() => selectCells("nope"), /unknown cell/);
});

const sampleCtx = (plan) => ({ profileName: "P", nodeExe: "C:\\node\\node.exe", programDirs: ["C:\\node", "C:\\Git"], pathDirs: ["C:\\node", "C:\\Windows\\System32"], systemRoot: "C:\\Windows", childEnv: { A: "1", B: "two words" }, gitExe: "C:\\Git\\cmd\\git.exe", npmCli: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js", plan });
test("launcher arguments: grants in order, deny entry only when protecting, soft program grants, policy and Win32k flags, limits, no inherited environment", () => {
  const plan = buildFixturePlan("C:\\fx");
  const cell = matrixCells().find((c) => c.id === "lpac-on_win32k-disabled_aapoptout-on");
  const a = buildLauncherArgs(cell, plan, sampleCtx(plan));
  const pairs = (flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []));
  assert.equal(a[0], "run");
  assert.deepEqual(pairs("--grant"), ["modify:C:\\fx\\ws", "modify:C:\\fx\\home", "modify:C:\\fx\\scratch", "ro:C:\\fx\\probe", "deny-write:C:\\fx\\ws\\.git"]);
  assert.deepEqual(pairs("--grant-soft"), ["rx:C:\\node", "rx:C:\\Git"]);
  assert.deepEqual(pairs("--aap-policy"), ["optout"]);
  assert.ok(a.includes("--win32k-off"));
  assert.deepEqual(pairs("--memory-mb"), ["4096"]);
  assert.deepEqual(pairs("--active-processes"), ["64"]);
  assert.ok(a.includes("--ui-limits"));
  assert.deepEqual(pairs("--env"), ["A=1", "B=two words"]);
  // Node keeps the given path for its entry file (no lstat of every ancestor folder at start-up, which a container is refused on).
  assert.equal(pairs("--cmdline")[0], 'C:\\node\\node.exe --preserve-symlinks --preserve-symlinks-main C:\\fx\\probe\\probe.mjs C:\\fx\\probe\\probe-config.json');
  const plain = buildLauncherArgs(matrixCells().find((c) => c.id === "lpac-off_win32k-enabled_aapoptout-on"), plan, sampleCtx(plan));
  assert.deepEqual(plain.flatMap((x, i) => (x === "--aap-policy" ? [plain[i + 1]] : [])), ["none"]);
  assert.ok(!plain.includes("--win32k-off"));
  const base = buildLauncherArgs(matrixCells().find((c) => c.id === "baseline-no-protect"), plan, sampleCtx(plan));
  assert.ok(!base.some((x) => String(x).startsWith("deny-write:")));
});

test("the child environment is built only from named values and fixture folders", () => {
  const plan = buildFixturePlan("C:\\fx");
  const env = buildChildEnv(plan, sampleCtx(plan));
  assert.equal(env.PATH, "C:\\node;C:\\Windows\\System32");
  assert.equal(env.npm_config_offline, "true");
  assert.equal(env.HOME, "C:\\fx\\home");
  assert.equal(env.SystemRoot, "C:\\Windows");
  // round 4: the programs the probe starts get the same Node options as the probe itself (as the product's launcher would set them)
  assert.equal(env.NODE_OPTIONS, "--preserve-symlinks --preserve-symlinks-main");
  // The profile variables are set on purpose, and only to the fixture's own folders; the machine's own values never reach the child.
  for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]) assert.ok(String(env[key]).startsWith(plan.home), `${key} points outside the fixture: ${env[key]}`);
  for (const key of Object.keys(process.env)) if (!["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].includes(key.toUpperCase())) assert.ok(!(key in env) || ["SystemRoot", "windir", "ComSpec", "PATHEXT", "NODE_OPTIONS"].includes(key) || key.startsWith("npm_config_") || key.startsWith("GIT_"), `leaked ${key}`);
});

// ------------------------------------------------------------------------------------------------ fixtures

test("fixtures: every case's files exist, links are planted (junction on Windows, directory link elsewhere), the tiny npm project installs offline", () => {
  const dir = tmp();
  try {
    const plan = buildFixturePlan(join(dir, "fx"), { join, dirname, basename: (p) => p });
    const { planted, notes } = createFixtures(plan, { probeSource: join(exp, "probe.mjs") });
    for (const f of [plan.decoy, plan.protectedConfig, plan.outsideFile, plan.linkTargetFile, plan.controllerFile, plan.credentialFile, plan.probeFile]) assert.ok(existsSync(f), f);
    assert.equal(readFileSync(plan.controllerFile, "utf8"), SECRETS.controller);
    assert.deepEqual(Object.values(planted), [true, true, true, true], notes.join(";"));
    assert.equal(readFileSync(plan.links.readFile, "utf8"), SECRETS.controller);
    assert.ok(readdirSync(plan.links.readDir).includes("controller.db"));
    const npm = join(process.execPath, "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(npm)) {
      const r = spawnSync(process.execPath, [npm, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", plan.npmCache], { cwd: plan.npmProject, encoding: "utf8" });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      assert.equal(readFileSync(join(plan.npmProject, "node_modules", "nn-tiny", "index.js"), "utf8"), "module.exports = 'nn-tiny';\n");
    }
    removeTree(dir);
    assert.ok(!existsSync(dir));
  } finally { removeTree(dir); }
});

test("a link that cannot be planted is recorded, and its attempt is skipped (never a pass)", () => {
  const dir = tmp();
  try {
    const plan = buildFixturePlan(join(dir, "fx"), { join, dirname, basename: (p) => p });
    // Pre-create a file where a link goes: symlinkSync fails with EEXIST, standing in for "no right to create links".
    mkdirSync(plan.workspace, { recursive: true });
    writeFileSync(plan.links.readFile, "x");
    const { planted, notes } = createFixtures(plan, {});
    assert.equal(planted.readFile, false);
    assert.ok(notes.some((n) => n.includes("file link to controller data: not planted")));
    const ctx = { systemPaths: [], planted, loopbackPort: 1, outbound: { host: "h" }, outboundPort: 2, ownerProfile: "o", systemFolder: "s", gitExe: "git", npmCli: undefined };
    const cfg = buildProbeConfig(plan, ctx);
    assert.equal(cfg.links.read[0].planted, false);
  } finally { removeTree(dir); }
});

test("the tarball is a valid gzip tar with both package files", () => {
  const dir = tmp();
  try {
    const tgz = makeTarball({ "package/a.txt": "hello", "package/b.txt": "x".repeat(700) });
    const f = join(dir, "t.tgz");
    writeFileSync(f, tgz);
    const r = spawnSync("tar", ["-tzf", "t.tgz"], { encoding: "utf8", cwd: dir }); // a relative name: GNU tar on Windows reads "C:" in an absolute one as a host name
    if (r.error) return; // no tar program here
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n"), ["package/a.txt", "package/b.txt"]);
  } finally { removeTree(dir); }
});

test("outbound host choice prefers a non-loopback IPv4 address and falls back to a documentation address", () => {
  assert.deepEqual(pickOutboundHost({ lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }], eth0: [{ family: "IPv6", address: "::2", internal: false }, { family: "IPv4", address: "10.1.2.3", internal: false }] }), { host: "10.1.2.3", local: true });
  assert.deepEqual(pickOutboundHost({}), { host: "192.0.2.1", local: false });
});

// ------------------------------------------------------------------------------------------------ reading output

test("the launcher line and the probe report are found among noise and damage is not trusted", () => {
  const line = JSON.stringify({ tool: "nn-appc-launcher", ok: true });
  assert.deepEqual(parseLauncherLine(`noise\n{"x":1}\n${line}\n`), { tool: "nn-appc-launcher", ok: true });
  assert.equal(parseLauncherLine("{broken\nnothing"), undefined);
  assert.equal(parseLauncherLine(undefined), undefined);
  assert.deepEqual(extractProbeReport(`x\n${REPORT_PREFIX}{"a":1}\n`), { a: 1 });
  assert.equal(extractProbeReport(`${REPORT_PREFIX}{"a":`), undefined);
  assert.equal(extractProbeReport("none"), undefined);
});

// ------------------------------------------------------------------------------------------------ classification

test("error codes map to outcomes, and attempts summarize by what was expected", () => {
  assert.equal(classifyError(undefined), "allowed");
  assert.equal(classifyError({ code: "EACCES" }), "denied");
  assert.equal(classifyError({ code: "EPERM" }), "denied");
  assert.equal(classifyError({ code: "ENOENT" }), "missing");
  assert.equal(classifyError({ code: "ECONNREFUSED" }), "blocked-other");
  assert.equal(classifyError({ code: "EWHATEVER" }), "error");
  const a = (...o) => o.map((outcome, i) => ({ name: `n${i}`, outcome }));
  assert.equal(summarize("allowed", a("allowed", "allowed")), "allowed");
  assert.equal(summarize("allowed", a("allowed", "denied")), "denied");
  assert.equal(summarize("allowed", a("error")), "error");
  assert.equal(summarize("denied", a("denied", "allowed")), "allowed");
  assert.equal(summarize("denied", a("denied", "denied")), "denied");
  assert.equal(summarize("denied", a("denied", "missing")), "denied-weak");
  assert.equal(summarize("denied", a("skipped", "skipped")), "inconclusive");
  assert.equal(summarize("denied", []), "inconclusive");
});

const probeOf = (id, expect, ...outcomes) => ({ id, group: "case", expect, attempts: outcomes.map((o, i) => (typeof o === "string" ? { name: `a${i}`, outcome: o } : { name: `a${i}`, ...o })) });
const calm = { systemCreated: 0, outsideFileChanged: false, hostDirsCreated: 0, linkFileChanged: false, linkDirCreated: 0, protectedChanged: false, loopbackConnections: 0, outboundConnections: 0 };

test("verdicts: a leak fails, an access-denied passes, another refusal is weak, failing controls weaken every denial, host witnesses override", () => {
  assert.equal(judgeProbe(probeOf("deny-credential-read", "denied", "denied", "denied"), calm, true).verdict, "pass");
  assert.equal(judgeProbe(probeOf("deny-credential-read", "denied", "denied", "allowed"), calm, true).verdict, "fail");
  assert.equal(judgeProbe(probeOf("deny-credential-read", "denied", "denied", "missing"), calm, true).verdict, "weak");
  assert.equal(judgeProbe(probeOf("deny-credential-read", "denied", "denied", "denied"), calm, false).verdict, "weak");
  assert.equal(judgeProbe(probeOf("deny-credential-read", "denied", { outcome: "allowed", note: "content-visible" }), calm, true).verdict, "fail");
  assert.equal(judgeProbe(probeOf("control-read-own-decoy", "allowed", "denied"), calm, true).verdict, "fail");
  assert.equal(judgeProbe(probeOf("control-read-own-decoy", "allowed", "allowed"), calm, true).verdict, "pass");
  assert.equal(judgeProbe(probeOf("deny-network-loopback", "denied", "blocked-other"), { ...calm, loopbackConnections: 1 }, true).verdict, "fail");
  assert.equal(judgeProbe(probeOf("deny-network-loopback", "denied", "blocked-other"), calm, true).verdict, "weak");
  assert.equal(judgeProbe(probeOf("deny-write-protected-name", "denied", "denied"), { ...calm, protectedChanged: true }, true).verdict, "fail");
  assert.equal(judgeProbe(probeOf("deny-symlink-read", "denied", "skipped"), calm, true).verdict, "inconclusive");
});

test("each host witness names the right problem and nothing else", () => {
  assert.equal(witnessProblem("deny-write-system", { ...calm, systemCreated: 1 }) !== undefined, true);
  assert.equal(witnessProblem("deny-write-host-path", { ...calm, outsideFileChanged: true }) !== undefined, true);
  assert.equal(witnessProblem("deny-write-host-path", { ...calm, hostDirsCreated: 1 }) !== undefined, true);
  assert.equal(witnessProblem("deny-symlink-write", { ...calm, linkDirCreated: 1 }) !== undefined, true);
  assert.equal(witnessProblem("extra-outbound-connect", { ...calm, outboundConnections: 2 }) !== undefined, true);
  assert.equal(witnessProblem("deny-credential-read", { ...calm, outsideFileChanged: true, protectedChanged: true, loopbackConnections: 5 }), undefined);
  for (const id of ALL_PROBE_IDS) assert.equal(witnessProblem(id, calm), undefined);
});

test("a cell without a report is inconclusive everywhere; the report schema accepts good data and names bad", () => {
  const results = judgeCell(undefined, undefined);
  assert.equal(results.length, ALL_PROBE_IDS.length);
  assert.ok(results.every((r) => r.verdict === "inconclusive"));
  assert.deepEqual(tally(results), { pass: 0, weak: 0, fail: 0, inconclusive: ALL_PROBE_IDS.length, info: 0 });
  const cell = { id: "c", sameAs: undefined, dims: { lpac: true, win32kDisabled: false, aapOptOut: true, aapPolicy: "optout", protect: true }, launch: { ok: false, childStarted: false, stage: "container", error: "e", grants: [] }, softGrantFailures: [], plantNotes: [], probeReport: "missing", results, startupDenials: [] };
  const report = buildReport({ now: "2026-11-24T00:00:00.000Z", host: { platform: "win32", elevated: false, sessionId: 0 }, cells: [cell], profile: { name: "P" }, cleanup: { profileDeleted: true, foldersRemoved: 1, grantsLeft: 0 } });
  assert.deepEqual(validateReport(report), []);
  assert.ok(validateReport({ ...report, schema: "x" }).includes("schema"));
  assert.ok(validateReport({ ...report, cells: [{ ...cell, results: results.slice(1) }] }).some((p) => p.includes("results")));
  assert.ok(validateReport({ ...report, host: { platform: "win32" } }).includes("host"));
  const md = renderMarkdown(report);
  assert.match(md, /\| cell \| started \|/);
  assert.match(md, /REFUSED \(container\)/);
  assert.match(md, /Anything that needed administrator rights: no/);
});

test("administrator need: only refused soft grants with an access or privilege error count", () => {
  const launch = { grants: [{ soft: true, applied: false, errorCode: 5, path: "p", mode: "rx" }, { soft: true, applied: true, path: "q", mode: "rx" }, { soft: false, applied: false, errorCode: 5, path: "r", mode: "modify" }, { soft: true, applied: false, errorCode: 2, path: "s", mode: "rx" }] };
  assert.deepEqual(adminNeeded(launch), [{ path: "p", mode: "rx", errorCode: 5 }]);
});

test("log scrubbing replaces the fixture root, home, account and SIDs", () => {
  const out = scrubText("a C:\\Users\\zed\\x and /tmp/zed/y by zedacct S-1-15-2-123-456-789 on box1", { home: "C:\\Users\\zed", tmp: "/tmp/zed", user: "zedacct", host: "box1" });
  assert.equal(out, "a <home>\\x and <temp>/y by <account> <sid> on <machine>");
});

// ------------------------------------------------------------------------------------------------ the real probe, unconfined (fixtures prove reachable)

test("the real probe run WITHOUT any confinement reaches every fixture: controls work, denial cases leak (so a Windows 'denied' means something)", async () => {
  const dir = tmp();
  const loop = net.createServer((s) => s.destroy());
  await new Promise((r) => loop.listen(0, "127.0.0.1", r));
  try {
    const plan = buildFixturePlan(join(dir, "fx"), { join, dirname, basename: (p) => p });
    const { planted } = createFixtures(plan, {});
    const sysFile = join(dir, "sysarea", "x");
    mkdirSync(join(dir, "sysarea"));
    const ctx = { systemPaths: [sysFile], planted, loopbackPort: loop.address().port, outbound: { host: "127.0.0.1" }, outboundPort: loop.address().port, ownerProfile: dir, systemFolder: join(dir, "sysarea"), gitExe: "git-not-installed-here", npmCli: undefined, networkTimeoutMs: 2000 };
    const cfg = buildProbeConfig(plan, ctx);
    const report = await runProbes(cfg);
    const by = Object.fromEntries(report.probes.map((p) => [p.id, p]));
    assert.equal(by["control-write-own-directories"].actual, "allowed");
    assert.equal(by["control-read-own-decoy"].actual, "allowed");
    for (const id of ["deny-write-host-path", "deny-credential-read", "deny-controller-data-read", "deny-network-loopback", "deny-write-protected-name", "extra-read-owner-profile"]) assert.equal(by[id].actual, "allowed", id);
    assert.equal(by["deny-symlink-read"].actual, "allowed");
    assert.equal(by["deny-symlink-write"].actual, "allowed");
    assert.equal(by["tool-node-version"].actual, "allowed");
    assert.equal(by["tool-git-version"].actual, "error");
    assert.ok(report.startupDenials.length >= 0);
    // the probe removes what it created in system areas
    assert.ok(!existsSync(sysFile));
    const cell = judgeCell(report, collectWitness(plan, { systemPaths: [sysFile], systemFolder: join(dir, "sysarea"), loopbackConnections: () => 1, outboundConnections: () => 1 }));
    assert.equal(cell.find((r) => r.id === "deny-write-host-path").verdict, "fail");
    assert.equal(cell.find((r) => r.id === "control-read-own-decoy").verdict, "pass");
  } finally { loop.close(); removeTree(dir); }
});

// ------------------------------------------------------------------------------------------------ the harness with a fake launcher

/** A fake launcher. `mode` decides what the "container" did: held everything, leaked, refused to start, or printed nothing. */
function fakeLauncher(mode, calls) {
  const goodProbes = () => ALL_PROBE_IDS.map((id) => {
    const control = id.startsWith("control-") || id.startsWith("tool-");
    return { id, group: id.startsWith("tool-") ? "tool" : id.startsWith("control-") || id.startsWith("deny-") ? "case" : "extra", expect: control ? "allowed" : "denied", attempts: [{ name: "a", outcome: control ? "allowed" : "denied", code: control ? undefined : "EACCES" }] };
  });
  return (_path, args) => {
    calls.push(args[0]);
    const flag = (f) => args[args.indexOf(f) + 1];
    if (args[0] === "info") return { status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true, command: "info", elevated: false, sessionId: 0, profile: "created" })}\n`, stderr: "" };
    if (args[0] === "delete-profile") return { status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true })}\n`, stderr: "" };
    if (args[0] === "revoke") return { status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true })}\n`, stderr: "" };
    if (mode === "silent") return { status: 1, stdout: "", stderr: "" };
    if (args[0] === "check") {
      const paths = grantedPaths(args);
      // "stubborn": the entries stay after a revoke; "leftbehind": the first read-back finds one, the revoke removes it.
      const entries = (n) => paths.map((p, i) => ({ path: p, mode: "ro", applied: false, revoked: false, entriesLeft: i === 0 ? n : 0 }));
      const n = mode === "stubborn" ? 1 : mode === "leftbehind" && !calls.includes("revoke") ? 1 : 0;
      return { status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true, clean: n === 0, grants: entries(n) })}\n`, stderr: "" };
    }
    if (mode === "refused") return { status: 125, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: false, childStarted: false, stage: "create-process", error: "CreateProcessW failed: 5", allGrantsRevoked: true, grants: [] })}\n`, stderr: "" };
    const probes = goodProbes();
    if (mode === "leaky") {
      const cfg = JSON.parse(readFileSync(join(dirname(flag("--stdout")), "..", "probe", "probe-config.json"), "utf8"));
      writeFileSync(cfg.hostWrite.file, "overwritten");
      probes.find((p) => p.id === "deny-write-host-path").attempts = [{ name: "outside-file", outcome: "allowed" }];
    }
    writeFileSync(flag("--stdout"), `${REPORT_PREFIX}${JSON.stringify({ schema: "nn-appc-probe-1", probes, startupDenials: [{ tool: "git", line: "Access is denied." }] })}\n`);
    const grants = args.flatMap((a, i) => (a === "--grant" || a === "--grant-soft" ? [{ path: args[i + 1].slice(args[i + 1].indexOf(":") + 1), mode: args[i + 1].split(":")[0], soft: a === "--grant-soft", applied: a === "--grant" || mode !== "softfail", revoked: true, ...(a === "--grant-soft" && mode === "softfail" ? { errorCode: 5 } : {}) }] : []));
    return { status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true, childStarted: true, childExitCode: 0, timedOut: false, leftoverProcesses: 0, elapsedMs: 5, allGrantsRevoked: mode !== "norevoke", grants })}\n`, stderr: "" };
  };
}

const tools = { nodeExe: process.execPath, gitExe: "git", gitDir: "/usr/bin", npmCli: undefined, programDirs: ["/usr"] };
const fakeRun = async (mode, extra = {}) => {
  const base = tmp();
  const calls = [];
  const r = await runExperiment({ launcherPath: "fake", exec: fakeLauncher(mode, calls), tmpBase: base, tools, now: () => "2026-11-24T00:00:00.000Z", cellSpec: "lpac-on_win32k-enabled_aapoptout-on,baseline-no-protect", systemPaths: [], systemFolder: base, outbound: { host: "192.0.2.1", local: false }, ...extra });
  return { r, calls, base };
};

test("harness with a launcher that held everything: controls pass, denials pass, report valid, cleanup done", async () => {
  const { r, calls, base } = await fakeRun("good");
  try {
    assert.equal(r.ranAtAll, true);
    assert.deepEqual(validateReport(r.report), []);
    assert.equal(r.report.cells.length, 2);
    const t = tally(r.report.cells[0].results);
    assert.equal(t.fail, 0);
    assert.equal(t.pass, ALL_PROBE_IDS.length);
    assert.ok(r.report.cleanup.profileDeleted);
    assert.equal(r.report.cleanup.foldersRemoved, 2);
    assert.deepEqual(readdirSync(base), []);
    assert.deepEqual(calls, ["info", "run", "check", "run", "check", "delete-profile"]);
    assert.deepEqual(r.report.cells[0].aclLeft, []);
    assert.equal(r.report.cleanup.grantsLeft, 0);
    assert.match(r.markdown, /ACL read-back of every granted path after the run: no entry left/);
    assert.equal(r.report.cells[0].startupDenials.length, 1);
    assert.match(r.markdown, /lpac-on_win32k-enabled_aapoptout-on/);
  } finally { removeTree(base); }
});

test("harness with a leaking launcher: the host witness turns the case into a failure", async () => {
  const { r, base } = await fakeRun("leaky");
  try {
    const row = r.report.cells[0].results.find((x) => x.id === "deny-write-host-path");
    assert.equal(row.verdict, "fail");
    assert.match(row.detail, /outside/);
  } finally { removeTree(base); }
});

test("harness when the launcher refuses to start the program: every item is inconclusive and the reason is kept; nothing falls back", async () => {
  const { r, calls, base } = await fakeRun("refused");
  try {
    const c = r.report.cells[0];
    assert.equal(c.launch.childStarted, false);
    assert.equal(c.launch.stage, "create-process");
    assert.ok(c.results.every((x) => x.verdict === "inconclusive"));
    assert.match(r.markdown, /REFUSED \(create-process\)/);
    assert.ok(!calls.includes("revoke")); // the launcher said every grant was revoked
  } finally { removeTree(base); }
});

test("harness: an ACL entry found by the read-back is revoked and read again; one that stays is counted and shown", async () => {
  const a = await fakeRun("leftbehind");
  try {
    assert.equal(a.r.report.cells[0].aclFirstReadBack.length, 1);
    assert.deepEqual(a.r.report.cells[0].aclLeft, []);
    assert.equal(a.r.report.cleanup.grantsLeft, 0);
    assert.ok(a.calls.includes("revoke"));
    assert.match(a.r.markdown, /ACL read-back after the run found entries left on: .*after a second revoke: none left/);
  } finally { removeTree(a.base); }
  const b = await fakeRun("stubborn");
  try {
    assert.equal(b.r.report.cells[0].aclLeft.length, 1);
    assert.equal(b.r.report.cleanup.grantsLeft, 2);
    assert.match(b.r.markdown, /after a second revoke: .*\(1\)/);
  } finally { removeTree(b.base); }
});

test("read-back helper: paths come from both grant flags once each; a silent launcher means every path unknown", () => {
  assert.deepEqual(grantedPaths(["run", "--grant", "modify:C:\\a", "--grant-soft", "rx:C:\\b", "--grant", "ro:C:\\a"]), ["C:\\a", "C:\\b"]);
  assert.deepEqual(aclReadBack(() => ({ stdout: "" }), "x", "P", []), { first: [], final: [] });
  const rb = aclReadBack(() => { throw new Error("boom"); }, "x", "P", ["C:\\a"]);
  assert.deepEqual(rb.first, [{ path: "(all)", entriesLeft: null }]);
  assert.deepEqual(rb.final, [{ path: "(all)", entriesLeft: null }]);
});

test("harness when the launcher says nothing: inconclusive, and it asks the launcher to revoke every grant it named", async () => {
  const { r, calls, base } = await fakeRun("silent");
  try {
    assert.equal(r.report.cells[0].launch.stage, "no-launcher-answer");
    assert.equal(calls.filter((c) => c === "revoke").length, 2);
    assert.ok(r.report.cleanup.profileDeleted);
  } finally { removeTree(base); }
});

test("harness records refused soft grants as a need for more rights", async () => {
  const { r, base } = await fakeRun("softfail");
  try {
    assert.equal(r.report.needsAdmin.observed, true);
    assert.deepEqual(r.report.needsAdmin.softGrantsRefused.map((g) => g.mode), ["rx"]);
    assert.ok(r.report.cells[0].softGrantFailures.length >= 1);
  } finally { removeTree(base); }
});

test("harness fails closed when the container cannot be made: nothing is started", async () => {
  const base = tmp();
  const calls = [];
  try {
    const r = await runExperiment({ launcherPath: "fake", tmpBase: base, tools, cellSpec: "baseline-no-protect", outbound: { host: "192.0.2.1", local: false }, exec: (_p, a) => { calls.push(a[0]); return { status: 125, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: false, stage: "container", error: "CreateAppContainerProfile failed" })}\n`, stderr: "" }; } });
    assert.equal(r.ranAtAll, false);
    assert.deepEqual(calls, ["info"]);
    assert.match(r.report.notes[0], /could not create or find the container/);
    assert.deepEqual(readdirSync(base), []);
  } finally { removeTree(base); }
});

test("a profile that existed before the run is left in place", async () => {
  const base = tmp();
  const calls = [];
  try {
    const inner = fakeLauncher("good", calls);
    const r = await runExperiment({ launcherPath: "fake", tmpBase: base, tools, cellSpec: "baseline-no-protect", systemPaths: [], systemFolder: base, outbound: { host: "192.0.2.1", local: false }, exec: (p, a) => (a[0] === "info" ? { status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true, elevated: true, sessionId: 1, profile: "reused" })}\n`, stderr: "" } : inner(p, a)) });
    assert.ok(!calls.includes("delete-profile"));
    assert.equal(r.report.cleanup.profileDeleted, false);
    assert.equal(r.report.needsAdmin.runIsElevated, true);
  } finally { removeTree(base); }
});

test("command line and tool discovery", () => {
  assert.equal(parseCli(["--cells", "a", "--dry-run", "--timeout-ms", "5"]).cellSpec, "a");
  assert.throws(() => parseCli(["--bogus"]), /unknown option/);
  assert.throws(() => parseCli(["--out"]), /needs a value/);
  const t = discoverTools({ platform: "win32", nodeExe: "C:\\hostedtoolcache\\node\\22\\x64\\node.exe", exists: (p) => p.endsWith("npm-cli.js") && p.includes("x64\\node_modules"), find: () => "C:\\Program Files\\Git\\cmd\\git.exe" });
  assert.deepEqual(t.programDirs, ["C:\\hostedtoolcache\\node\\22\\x64", "C:\\Program Files\\Git"]);
  assert.equal(t.npmCli, "C:\\hostedtoolcache\\node\\22\\x64\\node_modules\\npm\\bin\\npm-cli.js");
  assert.equal(t.gitDir, "C:\\Program Files\\Git\\cmd");
});

// ------------------------------------------------------------------------------------------------ guards on the launcher source and the workflow

test("the launcher source: every Win32 call it makes is documented in the README, and it has no fallback path to an unconfined child", () => {
  const src = launcherSource();
  const readme = readFileSync(join(exp, "README.md"), "utf8");
  const calls = ["CreateAppContainerProfile", "DeriveAppContainerSidFromAppContainerName", "DeleteAppContainerProfile", "ConvertSidToStringSidW", "GetNamedSecurityInfoW", "SetEntriesInAclW", "SetNamedSecurityInfoW",
    "CreateJobObjectW", "SetInformationJobObject", "QueryInformationJobObject", "TerminateJobObject", "InitializeProcThreadAttributeList", "UpdateProcThreadAttribute", "DeleteProcThreadAttributeList",
    "CreateProcessW", "WaitForSingleObject", "GetExitCodeProcess", "CreateFileW", "OpenProcessToken", "GetTokenInformation", "ProcessIdToSessionId", "CloseHandle", "FreeSid", "LocalFree", "GetAce", "EqualSid",
    "DeleteAce", "ConvertStringSidToSidW", "DeriveCapabilitySidsFromName", "CreateToolhelp32Snapshot", "Thread32First", "Thread32Next", "OpenThread", "GetThreadTimes", "GetProcessTimes"];
  for (const c of calls) { assert.ok(src.includes(`${c}(`), `${c} not used in win.rs`); assert.ok(readme.includes(c), `${c} missing in README`); }
  for (const banned of ["CreateProcessAsUser", "CreateProcessWithLogon", "CreateProcessWithToken", "LogonUser", "ShellExecute", "ImpersonateLoggedOnUser", "WinExec"]) assert.ok(!src.includes(banned), banned);
  // the process is created in one place only, with the container attributes
  assert.equal(src.match(/CreateProcessW\(/g).length, 1);
  assert.ok(src.includes("ATTR_SECURITY_CAPABILITIES") && src.includes("ATTR_JOB_LIST"));
  assert.ok(src.includes('"container"') && src.includes('Err(e) => return fail(j, "container"'));
  // A revoke removes every explicit entry of the container by hand (DeleteAce on a copy of the DACL: REVOKE_ACCESS left the deny entry on `.git` in round 1), is read back
  // (an entry still there is an error, never "revoked"), and a revoke with nothing to remove writes nothing.
  assert.ok(!/ea\.grfAccessMode = if revoke/.test(src) && !/=\s*REVOKE_ACCESS/.test(src) && !/REVOKE_ACCESS\s*\}/.test(src));
  assert.match(src, /unsafe fn remove_explicit\(/);
  assert.match(src, /for i in \(0\.\.\(\*copy\)\.AceCount as u32\)\.rev\(\)/);
  assert.match(src, /let none = old\.is_null\(\) \|\| explicit_aces\(old, sid\) == 0;/);
  assert.match(src, /match explicit_count\(path, sid\) \{ Ok\(0\) => Ok\(\(\)\), Ok\(_\) => Err\(ERR_STILL_PRESENT\)/);
  // capabilities, the per-grant read-back, the read-only `check` command and the hang diagnosis
  assert.match(src, /"--capability" =>/);
  assert.match(src, /"internetclient" => Some\("S-1-15-3-1"\)/);
  assert.match(src, /"internetclientserver" => Some\("S-1-15-3-2"\)/);
  assert.match(src, /"privatenetworkclientserver" => Some\("S-1-15-3-3"\)/);
  assert.match(src, /CapabilityCount: cap_list\.len\(\) as u32/);
  assert.match(src, /j\.n\("entriesLeft"/);
  assert.match(src, /"check" => \{/);
  assert.match(src, /j\.raw\("hang", hang_report\(/);
  assert.ok(readFileSync(join(root, "native", "nn-launcher", "Cargo.toml"), "utf8").includes('"Win32_System_Diagnostics_ToolHelp"'));
  // The attribute list's buffer is pointer-aligned, and a failed step after the start keeps childStarted.
  assert.ok(!/vec!\[0u8; size\]/.test(src));
  assert.match(src, /vec!\[0usize; size\.div_ceil\(size_of::<usize>\(\)\)\]/);
  assert.match(src, /if !j\.0\.iter\(\)\.any\(\|\(k, _\)\| k == "childStarted"\)/);
});

test("the probe's entry check compares paths, without case on Windows", () => {
  const here = join(exp, "probe.mjs");
  const url = new URL(`file://${here}`).href;
  assert.equal(isEntryPoint(here, url, "linux"), true);
  assert.equal(isEntryPoint(undefined, url, "linux"), false);
  assert.equal(isEntryPoint(join(exp, "other.mjs"), url, "linux"), false);
  assert.equal(isEntryPoint(here.toUpperCase(), url, "linux"), false);
  assert.equal(isEntryPoint(here.toUpperCase(), url, "win32"), true);
});

test("the real probe starts as an entry point with the container's Node options and prints its one report line", async () => {
  const dir = tmp();
  const loop = net.createServer((s) => s.destroy());
  await new Promise((r) => loop.listen(0, "127.0.0.1", r));
  try {
    const plan = buildFixturePlan(join(dir, "fx"), { join, dirname, basename: (p) => p });
    const { planted } = createFixtures(plan, { probeSource: join(exp, "probe.mjs") });
    const ctx = { systemPaths: [], planted, loopbackPort: loop.address().port, outbound: { host: "127.0.0.1" }, outboundPort: loop.address().port, ownerProfile: dir, systemFolder: dir, gitExe: "git-not-installed-here", npmCli: undefined, networkTimeoutMs: 2000 };
    writeFileSync(plan.configFile, JSON.stringify(buildProbeConfig(plan, ctx)));
    const r = spawnSync(process.execPath, [...PROBE_NODE_OPTIONS, plan.probeFile, plan.configFile], { encoding: "utf8", timeout: 120_000, cwd: plan.workspace });
    assert.equal(r.status, 0, r.stderr);
    const rep = extractProbeReport(r.stdout);
    assert.equal(rep?.schema, "nn-appc-probe-1");
    assert.equal(rep.probes.length, ALL_PROBE_IDS.length);
  } finally { loop.close(); removeTree(dir); }
});

test("when the probe says nothing, the first lines of its error output are kept, cut short, and shown", async () => {
  assert.deepEqual(stderrHead("\n  a  \r\n\nb\n" + "x".repeat(500), 6, 10), ["a", "b", "xxxxxxxxxx"]);
  assert.equal(stderrHead(undefined).length, 0);
  assert.equal(stderrHead(Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n")).length, 6);
  const base = tmp();
  const calls = [];
  try {
    const inner = fakeLauncher("good", calls);
    const exec = (p, a) => {
      if (a[0] !== "run") return inner(p, a);
      const flag = (f) => a[a.indexOf(f) + 1];
      writeFileSync(flag("--stdout"), "");
      writeFileSync(flag("--stderr"), "Error: EPERM: operation not permitted, lstat 'C:\\Users\\someone'\n    at Object.realpathSync\n");
      return { status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true, childStarted: true, childExitCode: 1, timedOut: false, leftoverProcesses: 0, elapsedMs: 5, allGrantsRevoked: true, grants: [] })}\n`, stderr: "" };
    };
    const r = await runExperiment({ launcherPath: "fake", exec, tmpBase: base, tools, cellSpec: "baseline-no-protect", systemPaths: [], systemFolder: base, outbound: { host: "192.0.2.1", local: false } });
    const c = r.report.cells[0];
    assert.equal(c.probeReport, "missing");
    assert.match(c.stderrHead[0], /EPERM: operation not permitted, lstat/);
    assert.match(r.markdown, /First lines the program wrote to its error output: `Error: EPERM/);
    assert.ok(c.results.every((x) => x.verdict === "inconclusive"));
  } finally { removeTree(base); }
});

test("the workflow runs only by hand, pins its actions, gates the own-runner job on an input defaulting to false with a 45 minute limit, and redacts logs", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  assert.match(wf, /^on:\n {2}workflow_dispatch:/m);
  assert.ok(!/^\s+(push|pull_request|schedule):/m.test(wf));
  for (const m of wf.matchAll(/uses: ([^\s@]+)@(\S+)/g)) assert.match(m[2], /^[0-9a-f]{40}$/, `${m[1]} is not pinned to a commit`);
  assert.match(wf, /own_runner:\n\s+description:[^\n]*\n\s+type: boolean\n\s+default: false/);
  assert.match(wf, /if: \$\{\{ !cancelled\(\) && needs\.hosted\.outputs\.launchers == 'ok' && inputs\.own_runner == true && github\.repository == 'rkcth\/NimbleNewt' && github\.ref == 'refs\/heads\/main' \}\}/);
  assert.match(wf, /runs-on: \[self-hosted, nimblenewt-windows\]/);
  assert.equal([...wf.matchAll(/timeout-minutes: 45/g)].length >= 1, true);
  assert.ok(wf.includes("scripts/redact-log.mjs"));
  // Both run steps keep the harness's exit code through the redaction pipe and still write the summary.
  // seven hosted steps (round 4: spawn first; round 5: session0; cases, npm, links, timing, firewall) and three own-runner steps (cases, session0, spawn); each keeps the harness's exit code and writes its summary
  assert.equal([...wf.matchAll(/run-experiment\.mjs --out "\$RUNNER_TEMP\/appc-out"[^|\n]*2>&1 \| node scripts\/redact-log\.mjs \|\| rc=\$\?\n.*GITHUB_STEP_SUMMARY.*\n\s+exit "\$rc"/g)].length, 10);
  for (const mode of ["spawn", "session0", "npm", "cases", "links", "timing", "firewall"]) assert.match(wf, new RegExp(`--mode ${mode} --timeout-ms (15000|45000|90000|120000)`));
  assert.match(wf, /own_runner:\n\s+description:[^\n]*\n\s+type: boolean\n\s+default: false/);
  assert.ok(!/secrets\./.test(wf));
  assert.ok(wf.includes("actions/upload-artifact@"));
  assert.ok(CASE_IDS.length === 10);
});

// ------------------------------------------------------------------------------------------------ round 2: the smoke ladder

test("capability SIDs: the three network capabilities are the documented well-known SIDs", () => {
  assert.deepEqual(WELL_KNOWN_CAPABILITY_SIDS, { internetClient: "S-1-15-3-1", internetClientServer: "S-1-15-3-2", privateNetworkClientServer: "S-1-15-3-3" });
  assert.equal(scrubText("cap S-1-15-3-1 container S-1-15-2-1-2-3 account S-1-5-21-1-2-3", {}), "cap S-1-15-3-1 container <sid> account <sid>");
});

test("ladder variants: unique ids, each asked-for variant exists with the capabilities and policy it names", () => {
  const vs = ladderVariants();
  assert.equal(new Set(vs.map((v) => v.id)).size, vs.length);
  const by = Object.fromEntries(vs.map((v) => [v.id, v]));
  assert.deepEqual(by["ac-nocap"].capabilities, []);
  assert.equal(by["ac-nocap"].aapPolicy, "none");
  assert.deepEqual(by["ac-inet"].capabilities, ["internetClient"]);
  assert.deepEqual(by["ac-inet-private"].capabilities, ["internetClient", "privateNetworkClientServer"]);
  assert.deepEqual(by["lpac-optout-reg"].capabilities, ["registryRead"]);
  assert.deepEqual(by["lpac-optout-reg-com"].capabilities, LPAC_COM);
  assert.ok(by["lpac-optout-wide"].capabilities.includes("lpacIdentityServices") && by["lpac-optout-wide"].capabilities.includes("lpacPnpNotifications"));
  assert.equal(by["lpac-optin-reg"].aapPolicy, "optin");
  assert.equal(by["lpac-optout-nocap"].aapPolicy, "optout");
  assert.equal(by["ac-nocap-bare"].programGrants, false);
  assert.equal(by["ac-nocap-wsenv"].wsEnv, true);
  assert.equal(by["ac-nocap-nolimits"].limits, false);
  assert.equal(by["ac-nocap-copy"].copyTools, true);
  assert.ok(vs.every((v) => v.nodeOptions === undefined || v.id === "ac-nocap-nodeopts"));
  assert.equal(selectVariants("ac-inet,ac-nocap").length, 2);
  assert.throws(() => selectVariants("nope"), /unknown variant/);
  assert.deepEqual(LADDER_STEPS.map((s) => s.id), ["cmd-echo", "hostname", "node-e0", "node-version", "node-require-net", "node-stdout", "node-write-file", "git-version"]);
});

const ladderCtx = { profileName: "P", nodeExe: "C:\\node\\node.exe", gitExe: "C:\\Git\\cmd\\git.exe", gitDir: "C:\\Git\\cmd", programDirs: ["C:\\node", "C:\\Git"], systemRoot: "C:\\Windows", pathDirs: ["C:\\node"] };
const stepArgs = (variantId, stepId) => {
  const plan = ladderPlan("C:\\fx");
  const v = ladderVariants().find((x) => x.id === variantId);
  const step = LADDER_STEPS.find((x) => x.id === stepId);
  const a = buildStepArgs(v, step, plan, ladderCtx, STEP_TIMEOUT_MS, { stdout: "C:\\fx\\out\\o", stderr: "C:\\fx\\out\\e" });
  return { a, all: (flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : [])), plan };
};

test("ladder step arguments: capabilities repeat in order, policy, limits only when asked, 45 s timeout, grants of the three folders plus soft program folders", () => {
  const { a, all } = stepArgs("ac-inet-private", "node-version");
  assert.deepEqual(all("--capability"), ["internetClient", "privateNetworkClientServer"]);
  assert.deepEqual(all("--aap-policy"), ["none"]);
  assert.deepEqual(all("--timeout-ms"), ["45000"]);
  assert.deepEqual(all("--grant"), ["modify:C:\\fx\\ws", "modify:C:\\fx\\home", "modify:C:\\fx\\scratch"]);
  assert.deepEqual(all("--grant-soft"), ["rx:C:\\node", "rx:C:\\Git"]);
  assert.ok(a.includes("--memory-mb") && a.includes("--ui-limits"));
  assert.deepEqual(all("--cwd"), ["C:\\fx\\ws"]);
  assert.deepEqual(all("--exe"), ["C:\\node\\node.exe"]);
  assert.deepEqual(all("--cmdline"), ["C:\\node\\node.exe --version"]);
  const lp = stepArgs("lpac-optout-reg-com", "cmd-echo");
  assert.deepEqual(lp.all("--aap-policy"), ["optout"]);
  assert.deepEqual(lp.all("--capability"), ["registryRead", "lpacCom"]);
  assert.deepEqual(lp.all("--exe"), ["C:\\Windows\\System32\\cmd.exe"]);
  assert.deepEqual(lp.all("--cmdline"), ["C:\\Windows\\System32\\cmd.exe /c echo hi"]);
  const nol = stepArgs("ac-nocap-nolimits", "node-e0");
  assert.ok(!nol.a.includes("--memory-mb") && !nol.a.includes("--ui-limits") && !nol.a.includes("--active-processes"));
  const bare = stepArgs("ac-nocap-bare", "node-e0");
  assert.deepEqual(bare.all("--grant-soft"), []);
});

test("ladder environment: NODE_OPTIONS is never inherited and only the named variant sets it; the workspace-env variant moves TEMP; flags go to node only; copies run from the workspace", () => {
  const env = (id) => { const plan = ladderPlan("C:\\fx"); return ladderEnv(ladderVariants().find((v) => v.id === id), plan, ladderCtx); };
  for (const v of ladderVariants()) assert.equal("NODE_OPTIONS" in env(v.id), v.id === "ac-nocap-nodeopts");
  assert.equal(env("ac-nocap-nodeopts").NODE_OPTIONS, "--preserve-symlinks --preserve-symlinks-main");
  assert.equal(env("ac-nocap").TEMP, "C:\\fx\\scratch");
  assert.equal(env("ac-nocap-wsenv").TEMP, "C:\\fx\\ws");
  assert.equal(env("ac-nocap-wsenv").TMP, "C:\\fx\\ws");
  assert.deepEqual(stepArgs("ac-nocap-jitless", "node-e0").all("--cmdline"), ["C:\\node\\node.exe --jitless -e 0"]);
  assert.deepEqual(stepArgs("ac-nocap-jitless", "cmd-echo").all("--cmdline"), ["C:\\Windows\\System32\\cmd.exe /c echo hi"]);
  const copy = stepArgs("ac-nocap-copy", "git-version");
  assert.ok(copy.all("--exe")[0].endsWith("git.exe") && copy.all("--exe")[0].includes("bin"));
  assert.ok(stepExecutable(LADDER_STEPS[2], ladderVariants().find((v) => v.id === "ac-nocap-copy"), copy.plan, ladderCtx).includes("bin"));
});

test("step verdicts: pass, odd output, fail with the hex exit code, timeout with the hang diagnosis, not started", () => {
  const step = LADDER_STEPS.find((s) => s.id === "node-version");
  const line = (o) => ({ childStarted: true, childExitCode: 0, timedOut: false, elapsedMs: 40, leftoverProcesses: 0, ...o });
  assert.equal(judgeStep(step, line({}), "v22.19.0\n", "").status, "pass");
  assert.equal(judgeStep(step, line({}), "nonsense", "").status, "odd");
  const f = judgeStep(step, line({ childExitCode: -2147483645 }), "", "WSAStartup: (10107) A system call has failed.\n");
  assert.equal(f.status, "fail");
  assert.equal(f.exitHex, "0x80000003");
  assert.match(f.stderrHead[0], /WSAStartup/);
  const t = judgeStep(step, line({ timedOut: true, childExitCode: 1, hang: { stillActive: true, threads: 3, threadsBusyInOneSecond: 0 } }), "", "");
  assert.equal(t.status, "timeout");
  assert.equal(t.hang.threadsBusyInOneSecond, 0);
  assert.equal(judgeStep(step, { childStarted: false, stage: "capability", error: "capability x: failed" }, "", "").status, "not-started");
  assert.equal(judgeStep(step, undefined, "", "").status, "not-started");
  assert.equal(judgeStep(LADDER_STEPS[0], line({}), "hi\r\n", "").status, "pass");
  assert.equal(judgeStep(LADDER_STEPS.find((s) => s.id === "node-stdout"), line({}), "x", "").status, "pass");
  assert.equal(judgeStep(LADDER_STEPS.find((s) => s.id === "node-stdout"), line({}), "xx", "").status, "odd");
  assert.equal(summarizeVariant([{ id: "cmd-echo", status: "pass" }, { id: "node-e0", status: "timeout" }]).nodeRuns, false);
  assert.equal(launcherLeft({ grants: [{ path: "p", mode: "deny-write", applied: true, revoked: false, entriesLeft: 1 }, { path: "q", mode: "ro", applied: true, revoked: true, entriesLeft: 0 }] }).length, 1);
});

/** A fake launcher for the ladder: `behavior(variantArgs, stepId)` returns { exit, timedOut, out, err }. */
function ladderFake(behavior, calls = []) {
  return (_p, args) => {
    calls.push(args[0]);
    const line = (o) => ({ status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ...o })}\n`, stderr: "" });
    if (args[0] === "info") return line({ ok: true, elevated: true, sessionId: 2, profile: "created", containerSid: "S-1-15-2-1-2-3-4-5-6-7" });
    if (args[0] === "delete-profile") return line({ ok: true });
    if (args[0] === "revoke") return line({ ok: true });
    if (args[0] === "check") return line({ ok: true, clean: true, grants: grantedPaths(args).map((path) => ({ path, entriesLeft: 0 })) });
    const flag = (f) => args[args.indexOf(f) + 1];
    const cmdline = flag("--cmdline");
    const b = behavior(args, cmdline);
    writeFileSync(flag("--stdout"), b.out ?? "");
    writeFileSync(flag("--stderr"), b.err ?? "");
    const grants = args.flatMap((a, i) => (a === "--grant" || a === "--grant-soft" ? [{ path: args[i + 1].slice(args[i + 1].indexOf(":") + 1), mode: args[i + 1].split(":")[0], soft: a === "--grant-soft", applied: true, revoked: true, entriesLeft: 0 }] : []));
    return line({ ok: true, childStarted: true, childExitCode: b.exit ?? 0, timedOut: b.timedOut === true, leftoverProcesses: 0, elapsedMs: 7, allGrantsRevoked: true, grants, ...(b.hang ? { hang: b.hang } : {}) });
  };
}
const happy = (_a, cmdline) => ({ out: /--version/.test(cmdline) ? (/git/.test(cmdline) ? "git version 2.50.0\n" : "v22.19.0\n") : /echo hi/.test(cmdline) ? "hi\r\n" : /hostname/.test(cmdline) ? "box1\n" : /stdout\.write/.test(cmdline) ? "x" : "" });
const ladderRun = async (behavior, extra = {}) => {
  const base = tmp();
  const calls = [];
  const copies = [];
  const r = await runLadder({ launcherPath: "fake", exec: ladderFake(behavior, calls), tmpBase: base, tools, now: () => "2026-11-25T00:00:00.000Z", systemRoot: "C:\\Windows", copyFile: (from, to) => { copies.push(to); writeFileSync(to, "stub"); }, ...extra });
  return { r, calls, base, copies };
};

test("ladder run with a launcher where everything works: every variant reaches git, the report is valid, read-back and clean-up happen", async () => {
  const { r, calls, base, copies } = await ladderRun(happy);
  try {
    assert.equal(r.ranAtAll, true);
    assert.deepEqual(validateLadder(r.report), []);
    assert.equal(r.report.variants.length, ladderVariants().length);
    for (const v of r.report.variants) { assert.equal(v.summary.nodeRuns, true, v.id); assert.equal(v.summary.gitRuns, true, v.id); assert.deepEqual(v.aclLeftFinal, []); }
    assert.equal(calls.filter((c) => c === "check").length, ladderVariants().length);
    assert.equal(calls.filter((c) => c === "run").length, ladderVariants().length * LADDER_STEPS.length);
    assert.equal(r.report.cleanup.foldersRemoved, ladderVariants().length);
    assert.equal(r.report.cleanup.grantsLeft, 0);
    assert.ok(r.report.cleanup.profileDeleted);
    assert.deepEqual(readdirSync(base), []);
    assert.equal(copies.length, 2 * ladderVariants().filter((v) => v.copyTools).length);
    assert.match(r.markdown, /\| ac-nocap \| ok \| ok \| ok/);
    assert.match(r.markdown, /Read-back of every granted path after the variant: no ACL entry left/);
    assert.match(r.markdown, /Variants where every node step passed:/);
  } finally { removeTree(base); }
});

test("ladder run: a failing step keeps its exit code and error text; two timeouts skip the rest of that variant (a hang costs two timeouts, not eight) and keep the diagnosis", async () => {
  const hang = { stillActive: true, jobProcesses: 1, processKernelMs: 15, processUserMs: 30, threads: 4, threadsBusyInOneSecond: 0, threadCpu: "1:3ms" };
  const behavior = (a, cmdline) => {
    if (/hostname/.test(cmdline)) return { exit: -1073741502 };
    if (a.includes("lpac-never") || !/node/.test(cmdline)) return happy(a, cmdline);
    if (a.includes("optout")) return { exit: -2147483645, err: "WSAStartup: (10107) A system call has failed.\n" };
    return { timedOut: true, exit: 1, hang };
  };
  const { r, base } = await ladderRun(behavior, { variantSpec: "ac-nocap,lpac-optout-nocap" });
  try {
    const ac = r.report.variants[0];
    assert.equal(ac.steps.filter((s) => s.status === "timeout").length, MAX_TIMEOUTS_PER_VARIANT);
    assert.equal(ac.steps.filter((s) => s.status === "skipped").length, 4);
    const node = ac.steps.find((s) => s.id === "node-e0");
    assert.equal(node.status, "timeout");
    assert.equal(node.hang.threadsBusyInOneSecond, 0);
    assert.equal(ac.steps.find((s) => s.id === "hostname").exitHex, "0xC0000142");
    assert.ok(ac.steps.slice(ac.steps.findIndex((s) => s.status === "skipped")).every((s) => s.status === "skipped"));
    const lp = r.report.variants[1];
    assert.equal(lp.steps.find((s) => s.id === "node-e0").exitHex, "0x80000003");
    assert.match(lp.steps.find((s) => s.id === "node-e0").stderrHead[0], /WSAStartup: \(10107\)/);
    assert.equal(lp.steps.filter((s) => s.status === "skipped").length, 0);
    assert.match(r.markdown, /hang diagnosis at the timeout: process still alive; processes in the job 1; CPU kernel\/user 15\/30 ms; 4 threads, 0 used CPU during one second/);
    assert.match(r.markdown, /WSAStartup: \(10107\)/);
  } finally { removeTree(base); }
});

test("ladder run: ACL entries left behind are read back, revoked and read again, and an entry that stays is counted", async () => {
  const base = tmp();
  try {
    const calls = [];
    const inner = ladderFake(happy, calls);
    let revoked = false;
    const exec = (p, a) => {
      if (a[0] === "revoke") { revoked = true; return inner(p, a); }
      if (a[0] === "check") return { status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true, grants: grantedPaths(a).map((path, i) => ({ path, entriesLeft: i === 0 && !revoked ? 1 : 0 })) })}\n`, stderr: "" };
      return inner(p, a);
    };
    const r = await runLadder({ launcherPath: "fake", exec, tmpBase: base, tools, variantSpec: "ac-nocap", systemRoot: "C:\\Windows" });
    assert.equal(r.report.variants[0].aclFirstReadBack.length, 1);
    assert.deepEqual(r.report.variants[0].aclLeftFinal, []);
    assert.equal(r.report.cleanup.grantsLeft, 0);
    assert.match(r.markdown, /Read-back after the variant found entries left on: .*after a second revoke: none left/);
    const stubborn = await runLadder({ launcherPath: "fake", exec: (p, a) => (a[0] === "check" ? { status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true, grants: grantedPaths(a).map((path) => ({ path, entriesLeft: 1 })) })}\n`, stderr: "" } : inner(p, a)), tmpBase: base, tools, variantSpec: "ac-nocap", systemRoot: "C:\\Windows" });
    assert.equal(stubborn.report.cleanup.grantsLeft, 3 + tools.programDirs.length);
    assert.deepEqual(readdirSync(base), []);
  } finally { removeTree(base); }
});

test("ladder run: the launcher refusing a capability is recorded per step; a container that cannot be made starts nothing", async () => {
  const base = tmp();
  try {
    const inner = ladderFake(happy);
    const refuse = (p, a) => (a[0] === "run" ? { status: 125, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: false, childStarted: false, stage: "capability", error: "capability lpacCom: DeriveCapabilitySidsFromName failed: 87", allGrantsRevoked: true, grants: [] })}\n`, stderr: "" } : inner(p, a));
    const r = await runLadder({ launcherPath: "fake", exec: refuse, tmpBase: base, tools, variantSpec: "lpac-optout-reg-com", systemRoot: "C:\\Windows" });
    assert.ok(r.report.variants[0].steps.every((s) => s.status === "not-started" && /capability/.test(s.detail)));
    const calls = [];
    const none = await runLadder({ launcherPath: "fake", tmpBase: base, tools, exec: (_p, a) => { calls.push(a[0]); return { status: 125, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: false, stage: "container", error: "x" })}\n`, stderr: "" }; } });
    assert.equal(none.ranAtAll, false);
    assert.deepEqual(calls, ["info"]);
    assert.deepEqual(readdirSync(base), []);
  } finally { removeTree(base); }
});

// ------------------------------------------------------------------------------------------------ round 2: the firewall mini-experiment

test("firewall commands: the package SID and the rule name are checked before they are used; the exact text is documented", () => {
  const c = firewallCommands("nn-appc-block-0123abcd", "S-1-15-2-11-22-33-44-55-66-77");
  assert.equal(c.add, "New-NetFirewallRule -DisplayName 'nn-appc-block-0123abcd' -Direction Outbound -Action Block -Package 'S-1-15-2-11-22-33-44-55-66-77' -Protocol Any -Profile Any -Enabled True | Out-Null; 'added'");
  assert.match(c.remove, /^Remove-NetFirewallRule -DisplayName 'nn-appc-block-0123abcd'/);
  assert.throws(() => firewallCommands("x'; calc; '", "S-1-15-2-1-2"), /rule name/);
  assert.throws(() => firewallCommands("nn-appc-block-0123abcd", "S-1-5-21-1-2-3"), /package SID/);
  assert.throws(() => firewallCommands("nn-appc-block-0123abcd", "S-1-15-2-1'; calc; '"), /package SID/);
  const readme = readFileSync(join(exp, "README.md"), "utf8");
  assert.ok(readme.includes("New-NetFirewallRule -DisplayName 'nn-appc-block-xxxxxxxx' -Direction Outbound -Action Block -Package"));
  assert.ok(readme.includes("Remove-NetFirewallRule"));
});

test("firewall verdicts follow the host listeners: pass, a leak, no capability effect, no client, no rule, an affected control", () => {
  const ph = (phase, loop, out, started = true) => ({ phase, client: "c", started, loopbackConnections: loop, outboundConnections: out });
  const rule = { added: true };
  const good = [ph("control-before-rule", 1, 1), ph("inside-without-rule", 0, 1), ph("inside-with-rule", 0, 0), ph("control-with-rule", 1, 1)];
  assert.equal(judgeFirewall(good, rule).verdict, "pass");
  assert.match(judgeFirewall(good, rule).why, /loopback was already refused/);
  assert.equal(judgeFirewall([good[0], ph("inside-without-rule", 1, 1), ph("inside-with-rule", 0, 0), good[3]], rule).verdict, "pass");
  assert.equal(judgeFirewall(good.map((p) => (p.phase === "inside-with-rule" ? ph(p.phase, 0, 1) : p)), rule).verdict, "fail");
  assert.equal(judgeFirewall(good.map((p) => (p.phase === "inside-with-rule" ? ph(p.phase, 1, 0) : p)), rule).verdict, "fail");
  assert.match(judgeFirewall(good.map((p) => (p.phase === "inside-without-rule" ? ph(p.phase, 0, 0) : p)), rule).why, /even without the rule/);
  assert.equal(judgeFirewall(good.map((p) => (p.phase === "control-with-rule" ? ph(p.phase, 1, 0) : p)), rule).verdict, "inconclusive");
  assert.match(judgeFirewall(good.map((p) => (p.phase === "inside-with-rule" ? ph(p.phase, 0, 0, false) : p)), rule).why, /no connect client started/);
  assert.match(judgeFirewall([], { added: false, addError: "Access is denied" }).why, /administrator rights.*|Access is denied/);
  assert.equal(judgeFirewall([], { added: false }).verdict, "inconclusive");
});

/** The fake machine for the firewall test: PowerShell keeps a rule table; the launcher's "container" connects to the host's listeners (through a node child, since the harness calls it synchronously) unless the rule exists. */
function firewallFake({ addFails = false, containerOnly = true } = {}) {
  const state = { rule: false, removeCalls: 0, addCalls: 0, sid: "S-1-15-2-9-8-7-6-5-4-3" };
  const ps = (script) => {
    if (/^New-NetFirewallRule/.test(script)) { state.addCalls++; if (addFails) return { status: 1, stdout: "", stderr: "Access is denied\n" }; state.rule = true; return { status: 0, stdout: "added\n", stderr: "" }; }
    if (/^Remove-NetFirewallRule/.test(script)) { state.removeCalls++; state.rule = false; return { status: 0, stdout: "removed\n", stderr: "" }; }
    if (/^@\(Get-NetFirewallRule/.test(script)) return { status: 0, stdout: `${state.rule ? 1 : 0}\n`, stderr: "" };
    return { status: 0, stdout: "Domain=True Private=True Public=True\n", stderr: "" };
  };
  const exec = (_p, args) => {
    const line = (o) => ({ status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ...o })}\n`, stderr: "" });
    if (args[0] === "info") return line({ ok: true, elevated: true, sessionId: 2, profile: "created", containerSid: state.sid });
    if (args[0] === "delete-profile") return line({ ok: true });
    if (args[0] === "check") return line({ ok: true, grants: grantedPaths(args).map((path) => ({ path, entriesLeft: 0 })) });
    if (args[0] !== "run") return line({ ok: true });
    const cmdline = args[args.indexOf("--cmdline") + 1];
    const urls = [...cmdline.matchAll(/http:\/\/([\d.]+):(\d+)\//g)].map((m) => ({ host: m[1], port: Number(m[2]) }));
    const nodeTargets = cmdline.includes("net.connect") || cmdline.includes("require('net')") ? [...cmdline.matchAll(/"host":"([\d.]+)","port":(\d+)/g)].map((m) => ({ host: m[1], port: Number(m[2]) })) : [];
    for (const t of [...urls, ...nodeTargets]) {
      const loopback = t.host === "127.0.0.1";
      if (loopback && containerOnly) continue; // a container's loopback is refused by default
      if (state.rule) continue;
      spawnSync(process.execPath, ["-e", `const s=require('net').connect(${t.port},${JSON.stringify(t.host)});s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(2),3000)`], { timeout: 10_000 });
    }
    const flag = (f) => args[args.indexOf(f) + 1];
    writeFileSync(flag("--stdout"), ""); writeFileSync(flag("--stderr"), "");
    // The launcher names the capabilities it applied (round 3: the firewall verdict needs them).
    const capabilities = args.flatMap((a, i) => (a === "--capability" ? [{ name: args[i + 1], sid: "S-1-15-3-1" }] : []));
    return line({ ok: true, childStarted: true, childExitCode: 0, timedOut: false, leftoverProcesses: 0, elapsedMs: 9, allGrantsRevoked: true, grants: [], capabilities });
  };
  return { ps, exec, state };
}

test("firewall run: the container reaches the outbound listener only while no rule exists, the control outside is never affected, the rule is added, read back and removed", async () => {
  const base = tmp();
  const fake = firewallFake();
  try {
    const r = await runFirewall({ launcherPath: "fake", exec: fake.exec, ps: fake.ps, tmpBase: base, tools, outbound: { host: OUTBOUND_HOST, local: true }, systemRoot: "C:\\Windows", randomHex: () => "0a1b2c3d", settleMs: 20, clients: ["curl"] });
    assert.equal(r.report.verdict, "pass", r.report.why);
    assert.equal(r.report.rule.name, "nn-appc-block-0a1b2c3d");
    assert.equal(r.report.rule.added, true);
    assert.equal(r.report.rule.removed, true);
    assert.equal(r.report.rule.existsAfterRemoval, 0);
    assert.equal(fake.state.rule, false);
    assert.deepEqual(r.report.phases.map((p) => p.phase), ["control-before-rule", "inside-without-rule", "inside-with-rule", "control-with-rule", "inside-after-removal"]);
    assert.deepEqual(r.report.phases.map((p) => p.outboundConnections), [1, 1, 0, 1, 1]);
    assert.match(r.markdown, /Verdict: \*\*pass\*\*/);
    assert.match(r.markdown, /New-NetFirewallRule -DisplayName 'nn-appc-block-0a1b2c3d'/);
    assert.deepEqual(readdirSync(base), []);
  } finally { removeTree(base); }
});

test("firewall run: without administrator rights the rule is not added, the verdict is inconclusive, and removal is still attempted", async () => {
  const base = tmp();
  const fake = firewallFake({ addFails: true });
  try {
    const r = await runFirewall({ launcherPath: "fake", exec: fake.exec, ps: fake.ps, tmpBase: base, tools, outbound: { host: OUTBOUND_HOST, local: true }, systemRoot: "C:\\Windows", randomHex: () => "0a1b2c3d", settleMs: 20, clients: ["curl"] });
    assert.equal(r.report.verdict, "inconclusive");
    assert.match(r.report.why, /could not be added.*Access is denied/);
    assert.ok(fake.state.removeCalls >= 1);
    assert.equal(r.report.phases.some((p) => p.phase === "inside-with-rule"), false);
  } finally { removeTree(base); }
});

test("firewall run: if anything throws while the rule exists, the rule is removed in the finally path", async () => {
  const base = tmp();
  const fake = firewallFake();
  try {
    await assert.rejects(runFirewall({ launcherPath: "fake", exec: fake.exec, ps: fake.ps, tmpBase: base, tools, outbound: { host: OUTBOUND_HOST, local: true }, systemRoot: "C:\\Windows", randomHex: () => "0a1b2c3d", settleMs: 20, clients: ["curl"],
      log: (m) => { if (/inside-with-rule/.test(m) && fake.state.rule) throw new Error("boom"); } }), /boom/);
    assert.equal(fake.state.rule, false);
    assert.ok(fake.state.removeCalls >= 1);
    assert.deepEqual(readdirSync(base), []);
  } finally { removeTree(base); }
});

test("a second listener that cannot be made (no such address on this machine, as 127.0.0.2 on macOS) leaves no listener open, so the process can end (the macOS shard hang)", () => {
  const dir = tmp();
  try {
    const script = `import { runFirewall } from ${JSON.stringify(pathToFileURL(join(exp, "ladder.mjs")).href)};
import { runExperiment } from ${JSON.stringify(pathToFileURL(join(exp, "run-experiment.mjs")).href)};
const unbindable = { host: "203.0.113.9", local: true }; // a documentation address no machine has
const line = (o) => ({ status: 0, stdout: JSON.stringify({ tool: "nn-appc-launcher", ...o }) + "\\n", stderr: "" });
const exec = (_p, args) => line(args[0] === "info" ? { ok: true, elevated: true, sessionId: 2, profile: "created", containerSid: "S-1-15-2-9-8-7-6-5-4-3" } : { ok: true });
const tools = { nodeExe: process.execPath, gitExe: "git", gitDir: "/usr/bin", programDirs: ["/usr"] };
const outcomes = [];
for (const run of [
  () => runFirewall({ launcherPath: "fake", exec, ps: () => ({ status: 0, stdout: "", stderr: "" }), tmpBase: ${JSON.stringify(dir)}, tools, outbound: unbindable, systemRoot: "C:\\\\Windows", settleMs: 20, clients: ["curl"] }),
  () => runExperiment({ launcherPath: "fake", exec, tmpBase: ${JSON.stringify(dir)}, tools, cellSpec: "baseline-no-protect", systemPaths: [], systemFolder: ${JSON.stringify(dir)}, outbound: unbindable }),
]) { try { await run(); outcomes.push("returned"); } catch (e) { outcomes.push(e.code ?? e.message); } }
console.log(JSON.stringify(outcomes));
`;
    writeFileSync(join(dir, "listen.mjs"), script);
    const r = spawnSync(process.execPath, [join(dir, "listen.mjs")], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.error, undefined, "the process ended by itself (a listener left open keeps it alive until the limit)");
    assert.equal(r.status, 0, r.stderr);
    const outcomes = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every((o) => o !== "returned"), `both runs refuse (EADDRNOTAVAIL, or the offline guard's own refusal): ${outcomes}`);
  } finally { removeTree(dir); }
});

test("firewall run: a rule that leaks (the container still connects) is a failure, and a container that cannot be made starts nothing", async () => {
  const base = tmp();
  try {
    const fake = firewallFake();
    const leaky = (p, a) => { const keep = fake.state.rule; if (a[0] === "run") fake.state.rule = false; try { return fake.exec(p, a); } finally { fake.state.rule = keep; } };
    const r = await runFirewall({ launcherPath: "fake", exec: leaky, ps: fake.ps, tmpBase: base, tools, outbound: { host: OUTBOUND_HOST, local: true }, systemRoot: "C:\\Windows", randomHex: () => "0a1b2c3d", settleMs: 20, clients: ["curl"] });
    assert.equal(r.report.verdict, "fail");
    assert.equal(fake.state.rule, false);
    const calls = [];
    const none = await runFirewall({ launcherPath: "fake", tmpBase: base, tools, ps: () => { calls.push("ps"); return { status: 0, stdout: "", stderr: "" }; }, exec: () => ({ status: 125, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: false, stage: "container" })}\n`, stderr: "" }) });
    assert.equal(none.ranAtAll, false);
    assert.deepEqual(calls, []);
  } finally { removeTree(base); }
});

test("command line: modes and variants", () => {
  assert.equal(parseCli([]).mode, "matrix");
  const o = parseCli(["--mode", "ladder", "--variants", "ac-inet", "--timeout-ms", "45000"]);
  assert.equal(o.mode, "ladder");
  assert.equal(o.variantSpec, "ac-inet");
  assert.equal(o.limits.timeoutMs, 45000);
  assert.throws(() => parseCli(["--mode", "other"]), /--mode/);
  assert.match(readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8"), /own_runner:\n\s+description:[^\n]*\n\s+type: boolean\n\s+default: false/);
});

test("the markdown renderers carry every variant and phase", () => {
  assert.match(renderLadderMarkdown({ generatedAt: "t", host: { platform: "win32", sessionId: 2, elevated: true }, stepTimeoutMs: 45000, variants: [], cleanup: { profileDeleted: true, foldersRemoved: 0, grantsLeft: 0 }, notes: ["n"] }), /No variant ran every node step/);
  assert.match(renderFirewallMarkdown({ generatedAt: "t", host: { platform: "win32", sessionId: 2, elevated: true }, variant: "v", capabilities: [], firewallProfiles: "x", verdict: "inconclusive", why: "w", rule: { commandAdd: "a", commandRemove: "r", added: false, removed: true, existsAfterRemoval: 0 }, phases: [], cleanup: { profileDeleted: true, ruleRemoved: true }, notes: [] }), /Verdict: \*\*inconclusive\*\*/);
});

test("the firewall's node client really connects to the listeners it is given (and ends), so a count of zero means a refusal", async () => {
  const hits = [];
  const servers = await Promise.all([0, 1].map(() => new Promise((res) => { const sv = net.createServer((sock) => { hits.push(1); sock.destroy(); }); sv.listen(0, "127.0.0.1", () => res(sv)); })));
  try {
    const targets = servers.map((sv) => ({ host: "127.0.0.1", port: sv.address().port }));
    const c = clientCommand("node", targets, { nodeExe: process.execPath, systemRoot: "C:\\Windows" }, { copyTools: false }, {});
    const r = spawnSync(c.exe, c.args, { encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(hits.length, 2);
    const curl = clientCommand("curl", targets, { systemRoot: "C:\\Windows" }, {}, {});
    assert.ok(curl.exe.endsWith("curl.exe"));
    assert.equal(curl.args.filter((x) => x.startsWith("http://127.0.0.1:")).length, 2);
  } finally { await Promise.all(servers.map((sv) => new Promise((res) => sv.close(res)))); }
});

// ------------------------------------------------------------------------------------------------ round 3

import {
  DEFAULT_LIMITS, DIAG_IDS, configCells, npmFixtureFiles, writeNpmProject,
} from "../experiments/windows-appcontainer/lib.mjs";
import { DEFAULT_BUDGET_MS, DEFAULT_WATCHDOG_MS, connectOnce, rebuildFromProgress, spawnLimited } from "../experiments/windows-appcontainer/probe.mjs";
import { LSTAT_REPRO_SCRIPT, REALPATH_SHIM, firstRefusedPrefix, judgeNpm, lstatReproStep, npmStepFor, npmVariants, packagesInstalled, parseRepro, renderNpmMarkdown, runNpmLadder, selectNpmVariants } from "../experiments/windows-appcontainer/npm.mjs";
import { PACKAGE_NAME_PATTERN, loopbackCommands, netSetup, netTeardown } from "../experiments/windows-appcontainer/ladder.mjs";
import {
  NUL_ACL_SCRIPT, analyzeSddl, gitProgram, gitStepFor, gitVariants, parseNulOpen, parseOpenTest, summarizeOpenTest, renderGitMarkdown, renderLinksMarkdown, renderTimingMarkdown, runGitLadder, runLinks, runTiming, selectGitVariants,
} from "../experiments/windows-appcontainer/round3.mjs";
import { MODES } from "../experiments/windows-appcontainer/run-experiment.mjs";

const posix = { join, dirname, basename: (p) => p };
const probeWorld = (extra = {}) => {
  const dir = tmp();
  const plan = buildFixturePlan(join(dir, "fx"), posix);
  const { planted } = createFixtures(plan, { probeSource: join(exp, "probe.mjs") });
  const ctx = { systemPaths: [], planted, loopbackPort: 9, outbound: { host: "127.0.0.1" }, outboundPort: 9, ownerProfile: dir, systemFolder: dir, gitExe: "git-not-installed-here", npmCli: undefined, networkTimeoutMs: 400, ...extra };
  return { dir, plan, cfg: buildProbeConfig(plan, ctx) };
};

test("the hard limits: 90 s per cell for the harness, a 60 s watchdog and a shorter budget inside the probe, 3 s per network attempt", () => {
  assert.equal(DEFAULT_LIMITS.timeoutMs, 90_000);
  assert.ok(DEFAULT_WATCHDOG_MS === 60_000 && DEFAULT_BUDGET_MS < DEFAULT_WATCHDOG_MS && DEFAULT_WATCHDOG_MS < DEFAULT_LIMITS.timeoutMs);
  const { cfg, dir } = probeWorld();
  try {
    assert.equal(cfg.watchdogMs, 60_000);
    assert.equal(cfg.budgetMs, DEFAULT_BUDGET_MS);
    assert.match(cfg.progressFile, /probe-progress\.txt$/);
    const a = buildLauncherArgs(matrixCells()[0], buildFixturePlan("C:\\fx"), { ...sampleCtx(buildFixturePlan("C:\\fx")) });
    assert.equal(a[a.indexOf("--timeout-ms") + 1], "90000");
  } finally { removeTree(dir); }
  const src = readFileSync(join(exp, "probe.mjs"), "utf8");
  assert.match(src, /timeoutMs = 3000\) => new Promise/);
  assert.ok(!/120_000|180_000/.test(src), "no tool limit of two or three minutes is left in the probe");
});

test("a network attempt always ends: the socket's own timeout and a hard timer both end it, the socket is destroyed, and a throw is an outcome", async () => {
  const original = net.connect;
  let destroyed = 0;
  try {
    // a connect that never says anything: neither connect nor error nor its own idle timeout
    net.connect = () => ({ setTimeout() {}, once() {}, destroy() { destroyed++; } });
    const t = Date.now();
    const r = await connectOnce("silent", "192.0.2.1", 9, 120);
    assert.equal(r.outcome, "blocked-other");
    assert.equal(r.code, "TIMEOUT");
    assert.ok(Date.now() - t < 3000);
    assert.equal(destroyed, 1);
    // the socket's own timeout fires
    net.connect = () => { const s = { setTimeout(_ms, cb) { setTimeout(cb, 10); }, once() {}, destroy() { destroyed++; } }; return s; };
    assert.equal((await connectOnce("idle", "h", 1, 5000)).code, "TIMEOUT");
    assert.equal(destroyed, 2);
    net.connect = () => { throw Object.assign(new Error("x"), { code: "EACCES" }); };
    assert.equal((await connectOnce("throws", "h", 1, 100)).outcome, "denied");
  } finally { net.connect = original; }
});

test("the probe announces every step in a progress file before and after it, and a watchdog hands over a partial report naming the step it was in", async () => {
  const { cfg, dir, plan } = probeWorld({ networkTimeoutMs: 800 });
  const original = net.connect;
  try {
    // the loopback attempt hangs for 600 ms; the watchdog (150 ms) fires first and sees the step name
    net.connect = () => { const handlers = {}; const s = { setTimeout() {}, once(e, f) { handlers[e] = f; }, destroy() {} }; setTimeout(() => handlers.error?.(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), 600); return s; };
    cfg.watchdogMs = 150;
    let partial;
    const report = await runProbes(cfg, { onWatchdog: (rep) => { partial ??= rep; } });
    assert.ok(partial, "the watchdog fired");
    assert.equal(partial.partial, true);
    assert.equal(partial.watchdog.step, "deny-network-loopback");
    assert.ok(partial.probes.length >= 8 && partial.probes.every((p) => typeof p.ms === "number"));
    const lines = readFileSync(plan.progressFile, "utf8").trim().split(/\r?\n/);
    assert.ok(lines.some((l) => / start deny-network-loopback$/.test(l)));
    assert.ok(lines.some((l) => / WATCHDOG deny-network-loopback$/.test(l)));
    // the run that finished kept going and wrote its end lines
    for (const id of ALL_PROBE_IDS) { assert.ok(lines.some((l) => l.endsWith(` start ${id}`)), `start ${id}`); assert.ok(lines.some((l) => l.endsWith(` end ${id}`)), `end ${id}`); }
    assert.equal(report.probes.length, ALL_PROBE_IDS.length);
  } finally { net.connect = original; removeTree(dir); }
});

test("a tool never runs past the probe's budget, and a step that throws is an error outcome, not a hang", async () => {
  const { cfg, dir } = probeWorld();
  try {
    cfg.budgetMs = 1; // nothing is left for tools
    const report = await runProbes(cfg);
    const by = Object.fromEntries(report.probes.map((p) => [p.id, p]));
    assert.equal(by["tool-node-version"].attempts[0].outcome, "skipped");
    assert.equal(by["tool-node-version"].attempts[0].code, "budget");
    assert.equal(report.probes.length, ALL_PROBE_IDS.length);
  } finally { removeTree(dir); }
});

test("the real probe leaves the fixtures as it found them after the protected-name operations, and tools use files, not pipes", async () => {
  const { cfg, dir, plan } = probeWorld();
  try {
    const report = await runProbes(cfg);
    // unconfined, every operation succeeds (that is the control) and each is undone at once
    const by = Object.fromEntries(report.probes.map((p) => [p.id, p]));
    for (const id of ["extra-protect-rename-dir", "extra-protect-delete-dir", "extra-protect-replace-junction", "extra-protect-rename-parent", "extra-junction-self-made", "extra-hardlink-read"]) assert.ok(by[id], id);
    assert.equal(by["extra-protect-rename-dir"].actual, "allowed");
    assert.ok(existsSync(plan.workspace) && existsSync(plan.protectedDir));
    assert.ok(!existsSync(`${plan.protectedDir}-renamed`) && !existsSync(`${plan.workspace}-renamed`) && !existsSync(`${plan.protectedDir}-away`));
    // four modes (files with a stdin file, inherit, pipes, ignore): unconfined, every one works
    assert.ok(by["diag-spawn-modes"].attempts.length === 4 && by["diag-spawn-modes"].attempts.every((a) => a.outcome === "allowed"));
    if (process.platform !== "win32") assert.equal(by["diag-nul-open"].attempts[0].outcome, "skipped"); // not Windows
    else assert.notEqual(by["diag-nul-open"].attempts[0].outcome, "skipped"); // on Windows the NUL device is really opened
    // the tool outputs went to files that were removed again
    assert.deepEqual(readdirSync(plan.scratch).filter((f) => f.startsWith("tool-")), []);
    // the tools take their standard input from an empty FILE and write to files, and are started from a worker thread (round 4: "ignore" makes libuv open the NUL device, which the container cannot)
    const probeSrc = readFileSync(join(exp, "probe.mjs"), "utf8");
    assert.ok(probeSrc.includes('stdin: base ? "file" : "pipe", out: base ? "files" : "pipe"'));
    assert.ok(!/stdio: \[?"ignore"/.test(probeSrc.slice(probeSrc.indexOf("async function runTool("), probeSrc.indexOf("results that survive a hang"))));
  } finally { removeTree(dir); }
});

test("diagnostics have no verdict; the protected-name operations, the own junctions and the hard link are judged by the host's own view", () => {
  const p = { id: "diag-nul-open", group: "diag", expect: "allowed", attempts: [{ name: "open NUL r+", outcome: "denied", code: "EACCES" }, { name: "open NUL r", outcome: "allowed" }] };
  const j = judgeProbe(p, calm, true);
  assert.equal(j.verdict, "info");
  assert.equal(j.actual, "mixed");
  assert.match(j.detail, /open NUL r\+=denied\(EACCES\)/);
  assert.deepEqual(DIAG_IDS, ["diag-nul-open", "diag-spawn-modes"]);
  for (const id of ["extra-protect-rename-dir", "extra-protect-delete-dir", "extra-protect-replace-junction"]) {
    assert.equal(witnessProblem(id, { ...calm, protectedDirGone: true }) !== undefined, true, id);
    assert.equal(witnessProblem(id, { ...calm, protectedDirLink: true }) !== undefined, true, id);
    assert.equal(witnessProblem(id, calm), undefined, id);
  }
  assert.ok(witnessProblem("extra-protect-rename-parent", { ...calm, workspaceMoved: true }));
  assert.ok(witnessProblem("extra-junction-self-made", { ...calm, ownJunctionWrite: 1 }));
  assert.ok(witnessProblem("extra-hardlink-read", { ...calm, hardlinkMade: 1 }));
  const leaked = judgeProbe({ id: "extra-protect-delete-dir", group: "extra", expect: "denied", attempts: [{ name: "delete-the-folder", outcome: "denied", code: "EPERM" }] }, { ...calm, protectedDirGone: true }, true);
  assert.equal(leaked.verdict, "fail");
  assert.equal(tally([j]).info, 1);
});

test("configurations: eight network/LPAC cells plus the no-protection contrast, capabilities and conditions named, arguments carry them in order", () => {
  const cells = configCells();
  assert.deepEqual(cells.map((c) => c.id), ["ac-nocap", "ac-nocap-noprotect", "ac-inet-private", "ac-inet-private-fwblock", "ac-inet-private-loopback", "ac-inet-private-loopback-fwblock", "ac-inet-private-loopback-byname", "lpac-optout-reg", "lpac-optout-reg-com",
    "ac-nocap-deny-strong", "ac-nocap-sealed", "ac-nocap-sealed-root", "ac-nocap-sealed-root-nolimits", "ac-inet-private-sealed-root", "lpac-optout-reg-com-sealed-root"]);
  const by = Object.fromEntries(cells.map((c) => [c.id, c]));
  assert.equal(by["ac-inet-private-loopback-byname"].loopbackExempt, "name");
  assert.deepEqual(by["ac-inet-private"].capabilities, ["internetClient", "privateNetworkClientServer"]);
  assert.equal(by["ac-inet-private-fwblock"].firewallBlock, true);
  assert.equal(by["ac-inet-private-loopback"].loopbackExempt, true);
  assert.equal(by["ac-inet-private-loopback-fwblock"].firewallBlock && by["ac-inet-private-loopback-fwblock"].loopbackExempt, true);
  assert.equal(by["ac-nocap-noprotect"].protect, false);
  assert.deepEqual(by["lpac-optout-reg-com"].capabilities, ["registryRead", "lpacCom"]);
  assert.equal(by["lpac-optout-reg"].aapPolicy, "optout");
  assert.ok(cells.every((c) => c.win32kDisabled === false));
  assert.equal(selectCells("ac-nocap,lpac-optout-reg", configCells()).length, 2);
  assert.throws(() => selectCells("nope", configCells()), /unknown cell/);
  const plan = buildFixturePlan("C:\\fx");
  const a = buildLauncherArgs(by["ac-inet-private"], plan, sampleCtx(plan));
  assert.deepEqual(a.flatMap((x, i) => (x === "--capability" ? [a[i + 1]] : [])), ["internetClient", "privateNetworkClientServer"]);
  assert.equal(a.includes("--capability"), true);
  assert.equal(buildLauncherArgs(matrixCells()[0], plan, sampleCtx(plan)).includes("--capability"), false);
});

test("loopback exemption and block rule commands are validated and read back; a set-up that is not confirmed says so and the teardown removes what was added", () => {
  const sid = "S-1-15-2-9-8-7-6-5-4-3";
  assert.throws(() => loopbackCommands("S-1-5-21-1"), /unexpected form/);
  assert.match(loopbackCommands(sid).add, /LoopbackExempt -a -p=S-1-15-2-9-8-7-6-5-4-3/);
  const state = { rule: false, exempt: false, scripts: [] };
  const ps = (script) => {
    state.scripts.push(script);
    if (/^New-NetFirewallRule/.test(script)) { state.rule = true; return { status: 0, stdout: "", stderr: "" }; }
    if (/^& CheckNetIsolation.exe LoopbackExempt -a/.test(script)) { state.exempt = true; return { status: 0, stdout: "", stderr: "" }; }
    if (/^@\(Get-NetFirewallRule/.test(script)) return { status: 0, stdout: `${state.rule ? 1 : 0}\n`, stderr: "" };
    if (/LoopbackExempt -s/.test(script)) return { status: 0, stdout: `${state.exempt ? 1 : 0}\n`, stderr: "" };
    if (/^Remove-NetFirewallRule/.test(script)) { state.rule = false; return { status: 0, stdout: "", stderr: "" }; }
    if (/LoopbackExempt -d/.test(script)) { state.exempt = false; return { status: 0, stdout: "", stderr: "" }; }
    return { status: 0, stdout: "", stderr: "" };
  };
  const cell = { firewallBlock: true, loopbackExempt: true };
  const st = netSetup(cell, { ps, packageSid: sid, ruleName: "nn-appc-block-0123abcd" });
  assert.equal(st.ok, true);
  assert.ok(state.rule && state.exempt);
  assert.match(st.summary, /in place and read back/);
  assert.deepEqual(netTeardown(st, { ps }), { ruleGone: true, exemptGone: true });
  assert.ok(!state.rule && !state.exempt);
  // nothing wanted: nothing is run
  const none = netSetup({ firewallBlock: false, loopbackExempt: false }, { ps: () => { throw new Error("no call expected"); }, packageSid: sid, ruleName: "nn-appc-block-0123abcd" });
  assert.equal(none.ok, true);
  // a rule that cannot be added (no administrator): not ok, and the summary names it
  const denied = (script) => (/^New-NetFirewallRule/.test(script) ? { status: 1, stdout: "", stderr: "Access is denied\n" } : /^@\(/.test(script) ? { status: 0, stdout: "0\n", stderr: "" } : { status: 0, stdout: "", stderr: "" });
  const bad = netSetup({ firewallBlock: true }, { ps: denied, packageSid: sid, ruleName: "nn-appc-block-0123abcd" });
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /NOT confirmed .*Access is denied/);
  assert.equal(netSetup({ firewallBlock: true }, { ps: undefined, packageSid: sid, ruleName: "nn-appc-block-0123abcd" }).ok, false);
});

test("cases run: the block rule and the exemption are in place before a cell starts and removed after it; an unconfirmed set-up means the cell is NOT run", async () => {
  const base = tmp();
  const log = [];
  const sid = "S-1-15-2-9-8-7-6-5-4-3";
  const state = { rule: false, exempt: false };
  const ps = (script) => {
    log.push(script.split(" ")[0]);
    if (/^New-NetFirewallRule/.test(script)) { state.rule = true; return { status: 0, stdout: "", stderr: "" }; }
    if (/LoopbackExempt -a/.test(script)) { state.exempt = true; return { status: 0, stdout: "", stderr: "" }; }
    if (/^@\(Get-NetFirewallRule/.test(script)) return { status: 0, stdout: `${state.rule ? 1 : 0}\n`, stderr: "" };
    if (/LoopbackExempt -s/.test(script)) return { status: 0, stdout: `${state.exempt ? 1 : 0}\n`, stderr: "" };
    if (/^Remove-NetFirewallRule/.test(script)) { state.rule = false; return { status: 0, stdout: "", stderr: "" }; }
    if (/LoopbackExempt -d/.test(script)) { state.exempt = false; return { status: 0, stdout: "", stderr: "" }; }
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    const calls = [];
    const inner = fakeLauncher("good", calls);
    const seen = [];
    const exec = (p, a) => {
      if (a[0] === "info") return { status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true, elevated: true, sessionId: 2, profile: "created", containerSid: sid })}\n`, stderr: "" };
      if (a[0] === "run") seen.push({ rule: state.rule, exempt: state.exempt, caps: a.flatMap((x, i) => (x === "--capability" ? [a[i + 1]] : [])) });
      return inner(p, a);
    };
    const r = await runExperiment({ launcherPath: "fake", exec, ps, tmpBase: base, tools, cells: selectCells("ac-nocap,ac-inet-private-loopback-fwblock", configCells()), systemPaths: [], systemFolder: base, outbound: { host: "192.0.2.1", local: false }, randomHex: () => "0123abcd" });
    assert.deepEqual(seen.map((s) => [s.rule, s.exempt]), [[false, false], [true, true]]);
    assert.deepEqual(seen[1].caps, ["internetClient", "privateNetworkClientServer"]);
    assert.ok(!state.rule && !state.exempt, "everything removed afterwards");
    const c = r.report.cells[1];
    assert.match(c.net.summary, /in place and read back.*removed afterwards: rule gone, exemption gone/);
    assert.deepEqual(c.dims.capabilities, ["internetClient", "privateNetworkClientServer"]);
    assert.equal(c.dims.firewallBlock, true);
    assert.match(r.markdown, /### Verdict per case and configuration/);
    assert.match(r.markdown, /\| extra-protect-rename-dir \|/);
    assert.match(r.markdown, /Network set-up: in place and read back/);
    // the rule cannot be added: the cell is not run and says why; the profile and the rest still go on
    const log2 = [];
    const exec2 = (p, a) => { if (a[0] === "run") log2.push(a); return exec(p, a); };
    const psBad = (script) => (/^New-NetFirewallRule/.test(script) ? { status: 1, stdout: "", stderr: "Access is denied\n" } : /^@\(/.test(script) ? { status: 0, stdout: "0\n", stderr: "" } : { status: 0, stdout: "", stderr: "" });
    const r2 = await runExperiment({ launcherPath: "fake", exec: exec2, ps: psBad, tmpBase: base, tools, cells: selectCells("ac-inet-private-fwblock", configCells()), systemPaths: [], systemFolder: base, outbound: { host: "192.0.2.1", local: false } });
    assert.equal(log2.length, 0, "the launcher was never asked to run the cell");
    assert.equal(r2.report.cells[0].launch.stage, "network-setup");
    assert.ok(r2.report.cells[0].results.every((x) => x.verdict === "inconclusive"));
  } finally { removeTree(base); }
});

test("a probe that stopped early shows where: the partial report names the step and the last progress lines are kept", async () => {
  const base = tmp();
  try {
    const inner = fakeLauncher("good", []);
    const exec = (p, a) => {
      if (a[0] !== "run") return inner(p, a);
      const flag = (f) => a[a.indexOf(f) + 1];
      const cfg = JSON.parse(readFileSync(join(dirname(flag("--stdout")), "..", "probe", "probe-config.json"), "utf8"));
      writeFileSync(cfg.progressFile, "10 ms start control-write-own-directories\n12 ms end control-write-own-directories\n15 ms start deny-network-loopback\n60001 ms WATCHDOG deny-network-loopback\n");
      writeFileSync(flag("--stdout"), `${REPORT_PREFIX}${JSON.stringify({ schema: "nn-appc-probe-1", partial: true, watchdog: { step: "deny-network-loopback", elapsedMs: 60001 }, probes: [], startupDenials: [] })}\n`);
      writeFileSync(flag("--stderr"), "");
      return { status: 3, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true, childStarted: true, childExitCode: 3, timedOut: false, leftoverProcesses: 0, elapsedMs: 60100, allGrantsRevoked: true, grants: [], hang: { stillActive: true, jobProcesses: 1, threads: 4, threadsBusyInOneSecond: 0 } })}\n`, stderr: "" };
    };
    const r = await runExperiment({ launcherPath: "fake", exec, tmpBase: base, tools, cells: selectCells("ac-nocap", configCells()), systemPaths: [], systemFolder: base, outbound: { host: "192.0.2.1", local: false } });
    const c = r.report.cells[0];
    assert.match(c.probeReport, /^partial: the probe's watchdog ended it in step deny-network-loopback after 60001 ms/);
    assert.equal(c.probeProgress.length, 4);
    assert.match(r.markdown, /Last probe steps before it stopped \(progress file\): .*`15 ms start deny-network-loopback` \| `60001 ms WATCHDOG deny-network-loopback`/);
    assert.ok(c.results.every((x) => x.verdict === "inconclusive"));
  } finally { removeTree(base); }
});

test("command line: the new modes, no default variant list for the firewall, and the firewall's default variant carries the capabilities its name says", async () => {
  assert.deepEqual(MODES, ["matrix", "cases", "ladder", "git", "npm", "links", "timing", "firewall", "spawn", "session0"]);
  for (const m of ["cases", "git", "npm", "links", "timing", "spawn"]) assert.equal(parseCli(["--mode", m]).mode, m);
  assert.equal(parseCli([]).variantSpec, undefined);
  // round 2 ran this experiment WITHOUT the capabilities because "all" was passed on and the first variant (no capability) was taken
  for (const spec of [undefined, "all"]) {
    const base = tmp();
    const fake = firewallFake();
    const runs = [];
    try {
      const exec = (p, a) => { if (a[0] === "run") runs.push(a); return fake.exec(p, a); };
      const r = await runFirewall({ launcherPath: "fake", exec, ps: fake.ps, tmpBase: base, tools, variantSpec: spec, outbound: { host: OUTBOUND_HOST, local: true }, settleMs: 20, systemRoot: "C:\\Windows", clients: ["node"] });
      assert.equal(r.report.variant, "ac-inet-private");
      assert.deepEqual(r.report.capabilitiesSeen, ["internetClient", "privateNetworkClientServer"]);
      assert.ok(runs.length > 0 && runs.every((a) => a.includes("--capability")));
    } finally { removeTree(base); }
  }
  // a launcher that does not apply the capabilities makes the verdict inconclusive, whatever the listeners say
  const base = tmp();
  const fake = firewallFake();
  try {
    const exec = (p, a) => { const out = fake.exec(p, a); if (a[0] !== "run") return out; return { ...out, stdout: out.stdout.replace(/"capabilities":\[[^\]]*\],?/, "") }; };
    const r = await runFirewall({ launcherPath: "fake", exec, ps: fake.ps, tmpBase: base, tools, outbound: { host: OUTBOUND_HOST, local: true }, settleMs: 20, systemRoot: "C:\\Windows", clients: ["node"] });
    assert.equal(r.report.verdict, "inconclusive");
    assert.match(r.report.why, /did not apply the capabilities/);
  } finally { removeTree(base); }
});

test("the workflow has one step per mode, each after the first with if: always(), 90 s cells, a 75 minute hosted limit and no secrets", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  assert.match(hosted, /timeout-minutes: 75/);
  const steps = hosted.split(/\n {6}- /).filter((x) => /run-experiment\.mjs/.test(x));
  assert.deepEqual(steps.map((x) => x.match(/--mode (\w+)/)[1]), ["spawn", "session0", "cases", "npm", "links", "timing", "firewall"]);
  steps.forEach((st, i) => assert.equal(/\n\s+if: always\(\)/.test(st), i > 0, `step ${i}`));
  assert.match(steps[2], /--mode cases --timeout-ms 90000/);
  assert.match(steps[1], /--mode session0 --timeout-ms 15000/);
  assert.match(steps[0], /--mode spawn --timeout-ms 15000/);
  assert.ok(steps.every((st) => /timeout-minutes: \d+/.test(st)));
  const own = wf.slice(wf.indexOf("  own-runner:"));
  assert.match(own, /default: false|inputs\.own_runner == true/);
  assert.match(wf, /own_runner:\n\s+description:[^\n]*\n\s+type: boolean\n\s+default: false/);
  assert.ok(!/secrets\./.test(wf));
});

test("NUL device security descriptor: entries are read, ALL APPLICATION PACKAGES and the LPAC group are told apart, errors are kept", () => {
  assert.match(NUL_ACL_SCRIPT, /CreateFileW\(path, 0x20000/);
  assert.match(NUL_ACL_SCRIPT, /GetSecurityInfo\(h, 1, 0x14/);
  assert.ok(!/\$\{/.test(NUL_ACL_SCRIPT), "no input is put into the script");
  const a = analyzeSddl("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;WD)(A;;GRGW;;;AC)S:(ML;;NW;;;LW)");
  assert.equal(a.ok, true);
  assert.equal(a.allAppPackagesAllowed, true);
  assert.equal(a.restrictedAppPackagesAllowed, false);
  assert.equal(a.everyoneAllowed, true);
  assert.deepEqual(a.allAppPackagesRights, ["GRGW"]);
  assert.deepEqual(a.mandatoryLabel, { rights: "NW", level: "Low integrity" });
  const b = analyzeSddl("D:(A;;GA;;;SY)(A;;GR;;;S-1-15-2-2)");
  assert.equal(b.allAppPackagesAllowed, false);
  assert.equal(b.restrictedAppPackagesAllowed, true);
  assert.equal(analyzeSddl("ERROR open 5").ok, false);
  assert.equal(analyzeSddl("").ok, false);
  assert.deepEqual(parseNulOpen('noise\n{"NUL r":"ok","NUL w":"EACCES"}\n'), { "NUL r": "ok", "NUL w": "EACCES" });
  assert.equal(parseNulOpen("not json"), undefined);
});

test("git variants: every one the brief names exists, ids are unique, and each builds the arguments it describes", () => {
  const all = gitVariants();
  assert.equal(new Set(all.map((v) => v.id)).size, all.length);
  for (const id of ["base", "stdin-nul-rw", "stdin-file", "stdin-pipe", "stdin-pipe-open", "out-pipes", "all-pipes", "mingw64-direct", "env-msys", "env-no-git-vars", "env-home-workspace", "cmd-c", "fsmonitor-off", "copy-cmd-exe", "copy-mingw64-exe", "lpac-base", "lpac-stdin-nul-rw"]) assert.ok(all.some((v) => v.id === id), id);
  assert.throws(() => selectGitVariants("nope"), /unknown git variant/);
  const plan = ladderPlan("C:\\fx");
  const ctx = { ...ladderCtx, gitRoot: "C:\\Git" };
  const step = (id, stepId = "git-version") => gitStepFor(all.find((v) => v.id === id), stepId, plan, ctx);
  assert.equal(step("base").exe, "C:\\Git\\cmd\\git.exe");
  assert.deepEqual(step("base").launcherArgs, []);
  assert.deepEqual(step("stdin-nul-rw").launcherArgs, ["--stdin", "nul-rw"]);
  assert.deepEqual(step("stdin-file").launcherArgs, ["--stdin", `file:${join(plan.workspace, "stdin.txt")}`]);
  assert.deepEqual(step("all-pipes").launcherArgs, ["--stdin", "pipe", "--stdout-pipe", "--stderr-pipe"]);
  assert.equal(step("mingw64-direct").exe, "C:\\Git\\mingw64\\bin\\git.exe");
  assert.deepEqual(step("env-msys").env, { MSYS: "winsymlinks:nativestrict", MSYS2_ARG_CONV_EXCL: "*" });
  assert.deepEqual(Object.values(step("env-no-git-vars").env), [null, null, null]);
  assert.equal(step("env-home-workspace").env.HOME, plan.workspace);
  assert.equal(step("cmd-c").exe, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(step("cmd-c").args().slice(0, 2), ["/c", "C:\\Git\\cmd\\git.exe"]);
  assert.deepEqual(step("fsmonitor-off").args(), ["-c", "core.fsmonitor=false", "--version"]);
  assert.equal(gitProgram(all.find((v) => v.id === "copy-mingw64-exe"), plan, ctx).source, "C:\\Git\\mingw64\\bin\\git.exe");
  assert.equal(gitProgram(all.find((v) => v.id === "copy-mingw64-exe"), plan, ctx).run, join(plan.binDir, "git.exe"));
  assert.equal(all.find((v) => v.id === "lpac-base").container, "lpac-optout-reg-com");
  assert.deepEqual(step("base", "git-commit").args().slice(-4), ["commit", "-q", "-m", "experiment"]);
  // the launcher arguments carry the step's own program, directory, environment changes and flags
  const v = ladderVariants().find((x) => x.id === "ac-nocap");
  const outFiles = { stdout: "o", stderr: "e" };
  const a = buildStepArgs(v, step("stdin-nul-rw"), plan, ctx, 45_000, outFiles);
  assert.equal(a[a.indexOf("--exe") + 1], "C:\\Git\\cmd\\git.exe");
  assert.equal(a[a.indexOf("--stdin") + 1], "nul-rw");
  const b = buildStepArgs(v, step("env-no-git-vars"), plan, ctx, 45_000, outFiles);
  assert.ok(!b.some((x) => /^GIT_CONFIG_NOSYSTEM=/.test(x)) && b.includes(`HOME=${plan.home}`));
  const c = buildStepArgs(v, step("env-msys", "git-init"), plan, ctx, 45_000, outFiles);
  assert.equal(c[c.indexOf("--cwd") + 1], plan.gitWork);
  assert.ok(c.includes("MSYS=winsymlinks:nativestrict"));
});

const gitFake = (behavior, calls = []) => ladderFake((args, cmdline) => behavior(args, cmdline), calls);
const sddlPs = (stdout = "D:P(A;;GA;;;SY)(A;;GRGW;;;AC)") => () => ({ status: 0, stdout: `${stdout}\n`, stderr: "" });
const gitTools = { nodeExe: process.execPath, gitExe: "C:\\Git\\cmd\\git.exe", gitRoot: "C:\\Git", gitDir: "C:\\Git\\cmd", npmCli: undefined, programDirs: [process.execPath, "C:\\Git"] };

test("git ladder run: --version first, init/add/commit only after it passes, the NUL device's descriptor and the in-container opens are kept, ACL read-back and clean-up happen", async () => {
  const base = tmp();
  const calls = [];
  const onlyWithNulRw = (args, cmdline) => {
    if (/open-test/.test(cmdline)) return { out: `${JSON.stringify({ tool: "nn-appc-launcher", command: "open-test", ok: true, opens: [{ name: "NUL GENERIC_READ|GENERIC_WRITE share R|W NORMAL", via: "CreateFileW", ok: false, code: 5 }, { name: "NUL GENERIC_READ only", via: "CreateFileW", ok: true, code: 0 }, { name: "_wopen(nul, O_RDWR)", via: "C runtime errno", ok: false, code: 13 }] })}\n` };
    if (/NUL/.test(cmdline) && /fs\.openSync|openSync/.test(cmdline)) return { out: `${JSON.stringify({ "NUL r": "ok", "NUL w": "EACCES", "NUL r+": "EACCES", "\\\\.\\NUL r": "ok", "\\\\.\\NUL w": "EACCES", "\\\\.\\NUL r+": "EACCES" })}\n` };
    if (/git\.exe/.test(cmdline) && /--version/.test(cmdline)) return args.includes("nul-rw") ? { out: "git version 2.50.0\n" } : { exit: 128, err: "fatal: could not open '/dev/null' for reading and writing: Permission denied\n" };
    return {};
  };
  try {
    const r = await runGitLadder({ launcherPath: "fake", exec: gitFake(onlyWithNulRw, calls), ps: sddlPs(), tmpBase: base, tools: gitTools, platform: "linux", now: () => "2026-11-25T00:00:00.000Z", systemRoot: "C:\\Windows", copyFile: (_f, to) => writeFileSync(to, "stub"), variantSpec: "base,stdin-nul-rw,copy-cmd-exe" });
    assert.equal(r.ranAtAll, true);
    const by = Object.fromEntries(r.report.variants.map((v) => [v.id, v]));
    assert.equal(by.base.gitRuns, false);
    assert.deepEqual(by.base.steps.map((s) => s.id), ["node-open-nul", "open-test", "git-version", "git-init", "git-add", "git-commit"]);
    assert.deepEqual(by.base.steps.slice(3).map((s) => s.status), ["skipped", "skipped", "skipped"]);
    assert.equal(by.base.steps[2].exitHex, "0x80");
    assert.match(by.base.steps[2].stderrHead[0], /could not open '\/dev\/null' for reading and writing/);
    assert.equal(by.base.nulOpen["NUL r+"], "EACCES");
    // the launcher's open-test ran as the child (a copy in the workspace) and its refusals are named in plain words
    assert.equal(by.base.steps[1].status, "pass");
    assert.equal(by.base.openTest.length, 3);
    assert.match(summarizeOpenTest(by.base.openTest).text, /^refused: NUL GENERIC_READ\|GENERIC_WRITE share R\|W NORMAL \(error 5\); _wopen\(nul, O_RDWR\) \(errno 13\); accepted: NUL GENERIC_READ only$/);
    assert.equal(by["stdin-nul-rw"].openTest, undefined);
    assert.match(r.markdown, /NUL device: which open flags the container refuses/);
    assert.match(r.markdown, /ac-nocap: refused: NUL GENERIC_READ\|GENERIC_WRITE share R\|W NORMAL \(error 5\)/);
    assert.equal(by["stdin-nul-rw"].gitRuns, true);
    assert.equal(by["stdin-nul-rw"].commitRuns, true);
    assert.deepEqual(by["stdin-nul-rw"].steps.map((s) => s.status), ["pass", "pass", "pass", "pass", "pass"]);
    assert.deepEqual(by["stdin-nul-rw"].steps.map((s) => s.id), ["node-open-nul", "git-version", "git-init", "git-add", "git-commit"]);
    assert.equal(by["copy-cmd-exe"].gitRuns, false);
    assert.equal(r.report.nulAcl.allAppPackagesAllowed, true);
    assert.deepEqual(r.report.cleanup, { profileDeleted: true, foldersRemoved: 3, grantsLeft: 0 });
    assert.ok(calls.includes("check") && calls.includes("delete-profile"));
    assert.match(r.markdown, /sanitize_stdfds/);
    assert.match(r.markdown, /ALL APPLICATION PACKAGES allowed: true \(rights GRGW\)/);
    assert.match(r.markdown, /\| base \| ac-nocap \| nul \| false \| .* \| ok \| EACCES \| EACCES \| fail 0x80 \| skipped \|/);
    assert.match(r.markdown, /Variants where git --version passed: stdin-nul-rw/);
    assert.equal(readdirSync(base).length, 0, "every fixture folder was removed");
  } finally { removeTree(base); }
});

test("git ladder run: an unreadable device descriptor is reported, not guessed; a container that cannot be made starts nothing", async () => {
  const base = tmp();
  try {
    const r = await runGitLadder({ launcherPath: "fake", exec: gitFake(() => ({ exit: 1 })), ps: () => ({ status: 1, stdout: "", stderr: "Add-Type : denied\n" }), tmpBase: base, tools: gitTools, platform: "linux", variantSpec: "base", systemRoot: "C:\\Windows" });
    assert.equal(r.report.nulAcl.ok, false);
    assert.match(r.markdown, /Not read: ERROR Add-Type/);
    const none = await runGitLadder({ launcherPath: "fake", exec: () => ({ status: 1, stdout: "", stderr: "" }), ps: sddlPs(), tmpBase: base, tools: gitTools, platform: "linux" });
    assert.equal(none.ranAtAll, false);
    assert.equal(readdirSync(base).length, 0);
  } finally { removeTree(base); }
  assert.match(renderGitMarkdown({ generatedAt: "t", host: { platform: "win32", sessionId: 2, elevated: true }, nulAcl: { ok: false, error: "x" }, variants: [], cleanup: { profileDeleted: true, foldersRemoved: 0, grantsLeft: 0 }, notes: ["n"] }), /No variant ran git/);
});

test("links run: grant, read what the targets inherited, revoke, read back; the controls show the propagation really happened", async () => {
  const base = tmp();
  const calls = [];
  try {
    const exec = (_p, args) => {
      calls.push(args[0]);
      const line = (o) => ({ status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ...o })}\n`, stderr: "" });
      if (args[0] === "info") return line({ ok: true, elevated: false, sessionId: 0, profile: "reused", containerSid: "S-1-15-2-1-2-3-4-5-6-7" });
      if (args[0] === "grant") return line({ ok: true, grants: grantedPaths(args).map((path) => ({ path, applied: true, entriesLeft: 1, inheritedEntries: 0 })) });
      if (args[0] === "check") {
        const granted = calls.includes("grant") && !calls.includes("revoke");
        return line({ ok: true, grants: grantedPaths(args).map((path) => ({ path, entriesLeft: granted && /[\\/]ws$/.test(path) ? 1 : 0, inheritedEntries: granted && /[\\/]ws[\\/]/.test(path) ? 1 : 0 })) });
      }
      return line({ ok: true });
    };
    const r = await runLinks({ launcherPath: "fake", exec, tmpBase: base, platform: "linux", now: () => "2026-11-25T00:00:00.000Z" });
    assert.deepEqual(calls.filter((c) => ["grant", "check", "revoke"].includes(c)).slice(0, 3), ["grant", "check", "revoke"]);
    const t = Object.fromEntries(r.report.targets.map((x) => [x.label.split(" ")[0] + x.label.length, x]));
    const find = (re) => r.report.targets.find((x) => re.test(x.label));
    assert.equal(find(/^control: the workspace folder/).reached, "yes");
    assert.equal(find(/^control: a file inside/).reached, "yes");
    assert.equal(find(/^target of the directory junction used for the read case/).reached, "no");
    assert.equal(find(/^the fixture root/).reached, "no");
    assert.equal(r.report.revokedClean, true);
    assert.ok(t);
    assert.match(r.markdown, /\| target of the directory junction used for the write case.* \| 0 \| 0 \| no \|/);
    assert.equal(readdirSync(base).length, 0);
    assert.match(renderLinksMarkdown({ ...r.report, targets: [] }), /After the revoke/);
  } finally { removeTree(base); }
});

test("links run: the grants are revoked and the folders removed even when the read fails", async () => {
  const base = tmp();
  const calls = [];
  try {
    const exec = (_p, args) => {
      calls.push(args[0]);
      if (args[0] === "check" && !calls.includes("revoke")) throw new Error("check blew up");
      const line = (o) => ({ status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ...o })}\n`, stderr: "" });
      if (args[0] === "info") return line({ ok: true, elevated: false, sessionId: 0, profile: "created" });
      if (args[0] === "check") return line({ ok: true, grants: grantedPaths(args).map((path) => ({ path, entriesLeft: 0, inheritedEntries: 0 })) });
      return line({ ok: true, grants: [] });
    };
    const r = await runLinks({ launcherPath: "fake", exec, tmpBase: base, platform: "linux" });
    assert.ok(calls.includes("revoke"));
    assert.ok(r.report.targets.every((x) => x.reached === "unknown"));
    assert.equal(readdirSync(base).length, 0);
  } finally { removeTree(base); }
});

test("timing run: launcher overhead against the same program outside, git only where it starts, npm ci of forty local packages, clean-up", async () => {
  const base = tmp();
  try {
    const calls = [];
    const exec = ladderFake((args, cmdline) => (/git\.exe/.test(cmdline) ? { exit: 128, err: "fatal: could not open '/dev/null' for reading and writing\n" } : {}), calls);
    const spawned = [];
    const spawn = (exe, args) => { spawned.push([exe, args]); return { status: 0 }; };
    const r = await runTiming({ launcherPath: "fake", exec, spawn, tmpBase: base, tools: { ...gitTools, npmCli: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js" }, platform: "linux", now: () => "2026-11-25T00:00:00.000Z", systemRoot: "C:\\Windows" });
    assert.equal(r.report.configurations.length, 2);
    const rows = r.report.configurations[0].rows;
    assert.deepEqual(rows.map((x) => x.id), ["start-cmd", "start-node", "write-100-files", "git-version", "git-100-files", "npm-ci-40"]);
    assert.equal(rows[0].samples.length, 5);
    assert.equal(rows[1].samples.length, 3);
    assert.ok(typeof rows[0].insideWallMedianMs === "number" && rows[0].insideChildMedianMs === 7);
    assert.equal(rows[4].status, "skipped");
    assert.match(rows[4].detail, /git --version does not pass/);
    assert.equal(rows[5].status, "pass");
    assert.ok(spawned.some(([, a]) => a.includes("ci")), "the same install ran outside as the baseline");
    assert.ok(spawned.filter(([, a]) => a.includes("-e")).length >= 4);
    assert.deepEqual(r.report.cleanup, { profileDeleted: true, grantsLeft: 0 });
    assert.match(r.markdown, /npm ci --offline, 40 local packages/);
    assert.match(r.markdown, /git init \+ add \+ commit of 100 files \| skipped/);
    assert.equal(readdirSync(base).length, 0);
    // where git does start, the three timed steps run in the container
    const exec2 = ladderFake((_a, cmdline) => (/git\.exe/.test(cmdline) && /--version/.test(cmdline) ? { out: "git version 2.50.0\n" } : {}), []);
    const r2 = await runTiming({ launcherPath: "fake", exec: exec2, spawn, tmpBase: base, tools: gitTools, platform: "linux", systemRoot: "C:\\Windows" });
    assert.deepEqual(r2.report.configurations[0].rows.map((x) => x.id).slice(3), ["git-version", "git-init", "git-add-100", "git-commit-100", "npm-ci-40"]);
    assert.equal(r2.report.configurations[0].rows[7].status, "skipped"); // no npm-cli in these tools
    assert.match(renderTimingMarkdown(r2.report), /git commit \(100 files\)/);
  } finally { removeTree(base); }
});

test("the offline npm project can hold many local packages (the lockfile names each tarball with its integrity)", () => {
  const one = npmFixtureFiles();
  assert.deepEqual(Object.keys(JSON.parse(one["package.json"]).dependencies), ["nn-tiny"]);
  assert.equal(one.tarballs.length, 1);
  const many = npmFixtureFiles(40);
  assert.equal(many.tarballs.length, 40);
  const lock = JSON.parse(many["package-lock.json"]);
  assert.equal(Object.keys(lock.packages).length, 41);
  assert.ok(Object.values(lock.packages).slice(1).every((p) => /^sha512-/.test(p.integrity)));
  const dir = tmp();
  try { writeNpmProject(dir, 3); assert.equal(readdirSync(join(dir, "vendor")).length, 3); } finally { removeTree(dir); }
});

test("the launcher's round 3 additions: standard handles as NUL read-write, a file or pipes, output pipes drained to files, a grant command that leaves entries, inherited entries read back", () => {
  const src = launcherSource();
  const readme = readFileSync(join(exp, "README.md"), "utf8");
  for (const c of ["CreatePipe", "SetHandleInformation", "ReadFile"]) { assert.ok(src.includes(`${c}(`), c); assert.ok(readme.includes(c), `${c} missing in README`); }
  assert.match(src, /"--stdin" =>/);
  assert.match(src, /"--stdout-pipe" =>/);
  assert.match(src, /"--stderr-pipe" =>/);
  assert.match(src, /"nul-rw" => open_nul_rw\(\)/);
  assert.match(src, /FILE_GENERIC_READ \| FILE_GENERIC_WRITE, FILE_SHARE_READ \| FILE_SHARE_WRITE/);
  assert.match(src, /"grant" => \{/);
  assert.match(src, /std::mem::forget\(set\)/);
  assert.match(src, /j\.n\("inheritedEntries"/);
  assert.match(src, /if a\.stdout_pipe \{ drop\(out\); \}/, "the launcher's copy of the write end is closed, or the copy thread never sees the end");
  assert.equal(src.match(/CreateProcessW\(/g).length, 1);
  const cargo = readFileSync(join(root, "native", "nn-launcher", "Cargo.toml"), "utf8");
  assert.ok(cargo.includes('"Win32_System_Pipes"') && cargo.includes('"Win32_System_IO"'));
  assert.match(readme, /Round 3/);
});


// ------------------------------------------------------------------------------------------------ round 3b: results that survive a hang

test("the progress file carries each step's result, and the report is rebuilt from it: finished steps, the step that was running, damaged lines skipped", () => {
  const rec = (id, extra = {}) => ({ id, group: "case", expect: "denied", attempts: [{ name: "a", outcome: "denied", code: "EACCES" }], actual: "denied", ms: 3, ...extra });
  const text = [
    `1 ms start deny-write-system`, `5 ms RESULT ${JSON.stringify({ ...rec("deny-write-system"), denials: [{ tool: "git", line: "Access is denied." }] })}`, `5 ms end deny-write-system`,
    `6 ms start deny-credential-read`, `9 ms RESULT {"id":"deny-credential-read", damaged`, `9 ms RESULT ${JSON.stringify(rec("deny-credential-read"))}`, `9 ms end deny-credential-read`,
    `10 ms start diag-spawn-modes`, `20 ms ATTEMPT ${JSON.stringify({ id: "diag-spawn-modes", group: "diag", expect: "allowed", attempt: { name: "spawn node with stdio files", outcome: "allowed" } })}`,
  ].join("\n");
  const r = rebuildFromProgress(text);
  assert.equal(r.partial, true);
  assert.equal(r.rebuilt, true);
  assert.deepEqual(r.probes.map((p) => p.id), ["deny-write-system", "deny-credential-read", "diag-spawn-modes"]);
  assert.equal(r.probes[0].denials, undefined, "the denial lines move to the report's own list");
  assert.deepEqual(r.startupDenials, [{ tool: "git", line: "Access is denied." }]);
  const last = r.probes[2];
  assert.equal(last.unfinished, true);
  assert.equal(last.group, "diag");
  assert.deepEqual(last.attempts.map((a) => a.name), ["spawn node with stdio files", "step did not finish"]);
  assert.equal(last.attempts[1].code, "HUNG");
  assert.equal(r.watchdog.step, "diag-spawn-modes");
  // nothing written: an empty, partial report; no exception on garbage
  assert.deepEqual(rebuildFromProgress("").probes, []);
  assert.deepEqual(rebuildFromProgress(undefined).probes, []);
  assert.deepEqual(rebuildFromProgress("garbage\n12 ms start\n").probes, []);
});

test("the real probe writes one RESULT line per step before its end line, each diagnostic mode its own line, and diag-spawn-modes runs last", async () => {
  const { cfg, dir, plan } = probeWorld();
  try {
    const report = await runProbes(cfg);
    const lines = readFileSync(plan.progressFile, "utf8").trim().split(/\r?\n/);
    for (const id of ALL_PROBE_IDS) {
      const iRes = lines.findIndex((l) => new RegExp(`^\\d+ ms RESULT \\{"id":"${id}"`).test(l));
      const iEnd = lines.findIndex((l) => l.endsWith(` end ${id}`));
      assert.ok(iRes >= 0, `RESULT ${id}`);
      assert.ok(iRes < iEnd, `RESULT before end for ${id}`);
    }
    const attempts = lines.filter((l) => / ms ATTEMPT /.test(l));
    assert.equal(attempts.length, 4);
    assert.ok(attempts.every((l) => l.includes('"id":"diag-spawn-modes"')));
    const order = lines.filter((l) => / start /.test(l)).map((l) => l.split(" start ")[1]);
    // round 4: the spawn diagnostic runs after the protected-name operations and BEFORE the tools (each of its starts is made from a worker thread with a limit of its own)
    assert.ok(order.indexOf("extra-protect-rename-parent") < order.indexOf("diag-spawn-modes"));
    assert.ok(order.indexOf("diag-spawn-modes") < order.indexOf("tool-node-version"));
    assert.ok(order.indexOf("extra-protect-rename-parent") < order.indexOf("tool-node-version"), "the protected-name operations run before the tools that start programs");
    // rebuilding from the complete file gives the same steps as the final report
    const rebuilt = rebuildFromProgress(readFileSync(plan.progressFile, "utf8"));
    assert.deepEqual(rebuilt.probes.map((p) => p.id), report.probes.map((p) => p.id));
    assert.deepEqual(rebuilt.probes.map((p) => p.actual), report.probes.map((p) => p.actual));
  } finally { removeTree(dir); }
});

test("a spawned child always ends: a program that never exits is killed at the timer and the result says so; the probe has no synchronous spawn", async () => {
  const t = Date.now();
  const hung = await spawnLimited(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", timeoutMs: 400 });
  assert.equal(hung.error?.code, "ETIMEDOUT");
  assert.ok(Date.now() - t < 8000);
  const ok = await spawnLimited(process.execPath, ["-e", "process.stdout.write('hi')"], { stdio: ["ignore", "pipe", "pipe"], timeoutMs: 20_000 });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "hi");
  const missing = await spawnLimited("nn-no-such-program-here", [], { stdio: "ignore", timeoutMs: 2000 });
  assert.ok(missing.error);
  const src = readFileSync(join(exp, "probe.mjs"), "utf8").split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/spawnSync|execSync|execFileSync/.test(src), "no synchronous child process call in the probe's code");
  assert.match(src, /for \(const \[name, mode\] of modes\) \{[\s\S]*emit\(attempt\);/, "each mode's result line is written before the next mode starts");
});

test("the watchdog worker ends a process whose main thread is blocked, after writing the partial progress and the rebuilt report", () => {
  const dir = tmp();
  try {
    const progress = join(dir, "progress.txt");
    writeFileSync(progress, `1 ms start control-write-own-directories\n3 ms RESULT ${JSON.stringify({ id: "control-write-own-directories", group: "case", expect: "allowed", attempts: [{ name: "a", outcome: "allowed" }], actual: "allowed", ms: 2 })}\n3 ms end control-write-own-directories\n4 ms start diag-spawn-modes\n`);
    const script = `import { startWorkerWatchdog } from ${JSON.stringify(pathToFileURL(join(exp, "probe.mjs")).href)};
startWorkerWatchdog({ progressFile: ${JSON.stringify(progress)}, deadlineMs: 300 });
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); // the main thread is blocked: no timer of its own could fire
`;
    writeFileSync(join(dir, "blocked.mjs"), script);
    const t = Date.now();
    const r = spawnSync(process.execPath, [join(dir, "blocked.mjs")], { encoding: "utf8", timeout: 30_000 });
    assert.ok(Date.now() - t < 25_000, "ended by the worker, not by the test's own limit");
    assert.ok(r.signal !== null || r.status !== 0, "the process was ended");
    const rep = extractProbeReport(r.stdout);
    assert.ok(rep, "the partial report was printed");
    assert.equal(rep.rebuilt, true);
    assert.deepEqual(rep.probes.map((p) => p.id), ["control-write-own-directories", "diag-spawn-modes"]);
    assert.equal(rep.probes[1].unfinished, true);
    assert.match(readFileSync(progress, "utf8"), / ms WATCHDOG diag-spawn-modes\n$/);
    // a probe that finishes stops the worker: nothing is printed and the process ends by itself
    const quick = `import { startWorkerWatchdog } from ${JSON.stringify(pathToFileURL(join(exp, "probe.mjs")).href)};
const w = startWorkerWatchdog({ progressFile: ${JSON.stringify(progress)}, deadlineMs: 400 });
w.stop();
`;
    writeFileSync(join(dir, "quick.mjs"), quick);
    const q = spawnSync(process.execPath, [join(dir, "quick.mjs")], { encoding: "utf8", timeout: 30_000 });
    assert.equal(q.status, 0);
    assert.equal(q.stdout, "");
  } finally { removeTree(dir); }
});

test("which report a cell is judged by: the whole one, else the one rebuilt from the progress file when it holds more, and the label says which", () => {
  const rec = (id) => ({ id, group: "case", expect: "denied", attempts: [{ name: "a", outcome: "denied" }], actual: "denied", ms: 1 });
  const progress = [`1 ms start deny-write-system`, `2 ms RESULT ${JSON.stringify(rec("deny-write-system"))}`, `2 ms end deny-write-system`, `3 ms start deny-credential-read`, `4 ms RESULT ${JSON.stringify(rec("deny-credential-read"))}`, `4 ms end deny-credential-read`].join("\n");
  const whole = { schema: "nn-appc-probe-1", probes: [rec("deny-write-system")], startupDenials: [] };
  assert.deepEqual(chooseProbeReport(whole, progress), { report: whole, label: "ok" });
  const none = chooseProbeReport(undefined, progress);
  assert.equal(none.label, REBUILT_LABEL);
  assert.equal(REBUILT_LABEL, "partial: rebuilt from progress");
  assert.equal(none.report.probes.length, 2);
  assert.deepEqual(chooseProbeReport(undefined, ""), { report: undefined, label: "missing" });
  const printedPartial = { schema: "nn-appc-probe-1", partial: true, watchdog: { step: "x", elapsedMs: 5 }, probes: [rec("deny-write-system"), rec("deny-credential-read")], startupDenials: [] };
  assert.match(chooseProbeReport(printedPartial, progress).label, /^partial: the probe's watchdog ended it in step x after 5 ms/);
  assert.equal(chooseProbeReport({ ...printedPartial, probes: [] }, progress).label, REBUILT_LABEL);
  assert.equal(chooseProbeReport({ ...printedPartial, rebuilt: true }, "").label, REBUILT_LABEL);
  assert.equal(chooseProbeReport({ schema: "x", fatal: "EACCES", probes: [], startupDenials: [] }, "").label, "fatal: EACCES");
  // a step that was still running counts only when it wrote an attempt line
  assert.equal(chooseProbeReport(undefined, "1 ms start deny-write-system\n").label, "missing");
});

test("a rebuilt cell is judged step by step: finished steps keep their verdict, the unfinished one and the unreached ones are inconclusive, a diagnostic is info", () => {
  const rebuilt = rebuildFromProgress([
    `1 ms start control-write-own-directories`, `2 ms RESULT ${JSON.stringify({ id: "control-write-own-directories", group: "case", expect: "allowed", attempts: [{ name: "w", outcome: "allowed" }], actual: "allowed", ms: 1 })}`, `2 ms end control-write-own-directories`,
    `3 ms start control-read-own-decoy`, `4 ms RESULT ${JSON.stringify({ id: "control-read-own-decoy", group: "case", expect: "allowed", attempts: [{ name: "d", outcome: "allowed" }], actual: "allowed", ms: 1 })}`, `4 ms end control-read-own-decoy`,
    `5 ms start deny-write-system`, `6 ms RESULT ${JSON.stringify({ id: "deny-write-system", group: "case", expect: "denied", attempts: [{ name: "s", outcome: "denied", code: "EACCES" }], actual: "denied", ms: 1 })}`, `6 ms end deny-write-system`,
    `7 ms start deny-credential-read`,
    `8 ms start diag-spawn-modes`,
  ].join("\n").replace("7 ms start deny-credential-read\n8 ms start diag-spawn-modes", "7 ms start deny-credential-read\n7 ms end deny-credential-read\n8 ms start diag-spawn-modes"));
  const results = judgeCell(rebuilt, undefined);
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by["control-write-own-directories"].verdict, "pass");
  assert.equal(by["deny-write-system"].verdict, "pass");
  assert.equal(by["deny-credential-read"].verdict, "inconclusive", "ended without a result: not reported");
  assert.equal(by["diag-spawn-modes"].verdict, "info", "a diagnostic has no verdict, and shows that it did not finish");
  assert.match(by["diag-spawn-modes"].detail, /step did not finish=error\(HUNG\)/);
  assert.equal(by["tool-git-version"].verdict, "inconclusive");
  assert.equal(results.length, ALL_PROBE_IDS.length);
  const hungDeny = rebuildFromProgress("1 ms start deny-network-loopback\n");
  const hung = judgeCell(hungDeny, undefined).find((r) => r.id === "deny-network-loopback");
  assert.equal(hung.verdict, "inconclusive");
});

test("harness: a probe that hung and printed nothing is rebuilt from the progress file, the cell says so, and nothing it did get done is lost", async () => {
  const base = tmp();
  try {
    const inner = fakeLauncher("good", []);
    const rec = (id, group, expect, outcome) => ({ id, group, expect, attempts: [{ name: "a", outcome }], actual: outcome, ms: 4 });
    const exec = (p, a) => {
      if (a[0] !== "run") return inner(p, a);
      const flag = (f) => a[a.indexOf(f) + 1];
      const cfg = JSON.parse(readFileSync(join(dirname(flag("--stdout")), "..", "probe", "probe-config.json"), "utf8"));
      const lines = [];
      for (const id of ALL_PROBE_IDS.filter((x) => x !== "diag-spawn-modes" && !x.startsWith("tool-"))) {
        const control = id.startsWith("control-");
        lines.push(`1 ms start ${id}`, `2 ms RESULT ${JSON.stringify(rec(id, id.startsWith("extra-") ? "extra" : id.startsWith("diag-") ? "diag" : "case", control || id.startsWith("diag-") ? "allowed" : "denied", control || id.startsWith("diag-") ? "allowed" : "denied"))}`, `2 ms end ${id}`);
      }
      lines.push("3 ms start tool-node-version");
      writeFileSync(cfg.progressFile, `${lines.join("\n")}\n`);
      writeFileSync(flag("--stdout"), ""); // the report was never printed
      writeFileSync(flag("--stderr"), "");
      return { status: 1, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true, childStarted: true, childExitCode: 1, timedOut: true, leftoverProcesses: 0, elapsedMs: 90000, allGrantsRevoked: true, grants: [] })}\n`, stderr: "" };
    };
    const r = await runExperiment({ launcherPath: "fake", exec, tmpBase: base, tools, cells: selectCells("ac-nocap", configCells()), systemPaths: [], systemFolder: base, outbound: { host: "192.0.2.1", local: false } });
    const c = r.report.cells[0];
    assert.equal(c.probeReport, "partial: rebuilt from progress");
    const by = Object.fromEntries(c.results.map((x) => [x.id, x]));
    assert.equal(by["deny-write-system"].verdict, "pass");
    assert.equal(by["control-read-own-decoy"].verdict, "pass");
    assert.equal(by["tool-node-version"].verdict, "inconclusive");
    assert.equal(by["tool-git-version"].verdict, "inconclusive");
    assert.ok(c.results.filter((x) => x.verdict === "pass").length >= 10);
    assert.equal(c.probeProgress.some((l) => /RESULT|ATTEMPT/.test(l)), false, "the progress tail shows boundaries, not result lines");
    assert.match(r.markdown, /\| ac-nocap \| timed out, partial: rebuilt from progress \|/);
    assert.match(r.markdown, /Probe report: partial: rebuilt from progress\./);
  } finally { removeTree(base); }
});

// ------------------------------------------------------------------------------------------------ round 3b: npm

test("npm variants: unique ids, each is one change from the base, the arguments carry the flags, the shell, the project folder and the environment", () => {
  const all = npmVariants();
  assert.equal(new Set(all.map((v) => v.id)).size, all.length);
  for (const id of ["base", "nodeopts-preserve", "flags-preserve", "npm-cmd", "npm-cmd-preserve", "env-more", "cwd-workspace", "preload-realpath-native", "preserve-env-workspace", "lpac-base"]) assert.ok(all.some((v) => v.id === id), id);
  assert.throws(() => selectNpmVariants("nope"), /unknown npm variant/);
  assert.equal(selectNpmVariants("base,npm-cmd").length, 2);
  const plan = ladderPlan("C:\\fx");
  const ctx = { ...ladderCtx, npmCli: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js", npmCmd: "C:\\node\\npm.cmd" };
  const step = (id) => npmStepFor(all.find((v) => v.id === id), plan, ctx);
  const base = step("base");
  assert.equal(base.cwd, `${plan.scratch}\\npmproj`);
  assert.deepEqual(base.args().slice(0, 2), [ctx.npmCli, "ci"]);
  assert.ok(base.args().includes("--offline"));
  assert.deepEqual(base.env, {});
  assert.deepEqual(step("nodeopts-preserve").env, { NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main" });
  assert.deepEqual(step("flags-preserve").args().slice(0, 3), ["--preserve-symlinks", "--preserve-symlinks-main", ctx.npmCli]);
  const cmd = step("npm-cmd");
  assert.equal(cmd.exe, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(cmd.args().slice(0, 2), ["/c", "C:\\node\\npm.cmd"]);
  assert.equal(step("cwd-workspace").cwd, `${plan.workspace}\\npmproj`);
  const more = step("env-more").env;
  for (const k of ["npm_config_prefix", "npm_config_logs_dir", "npm_config_cache", "npm_config_userconfig", "npm_config_globalconfig", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) assert.ok(more[k].startsWith(plan.home), k);
  assert.match(step("preload-realpath-native").env.NODE_OPTIONS, /^--require .*nn-realpath-shim\.js$/);
  assert.equal(step("lpac-base").cwd, base.cwd);
  assert.equal(all.find((v) => v.id === "lpac-base").container, "lpac-optout-reg-com");
  // the launcher arguments: the step's program, working directory and environment reach the launcher
  const a = buildStepArgs(ladderVariants().find((v) => v.id === "ac-nocap"), step("env-more"), plan, ctx, 45_000, { stdout: "o", stderr: "e" });
  assert.equal(a[a.indexOf("--cwd") + 1], base.cwd);
  assert.ok(a.some((x) => x === `npm_config_prefix=${more.npm_config_prefix}`));
  assert.ok(REALPATH_SHIM.includes("realpathSync.native"));
});

test("the failing call is reproduced alone: the repro script prints every prefix, the realpath outcomes and the drive root's access; the first refusal is named", () => {
  const r = spawnSync(process.execPath, ["-e", LSTAT_REPRO_SCRIPT, process.execPath], { encoding: "utf8", timeout: 20_000, cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  const p = parseRepro(r.stdout);
  assert.ok(p);
  assert.equal(p.realpathJs, "ok");
  assert.equal(p.realpathNative, "ok");
  assert.equal(p.rootLstat, "ok");
  for (const k of ["npmScript", "cwd", "nodeExe"]) assert.ok(p.prefixes[k].length >= 2 && p.prefixes[k].every(([, c]) => c === "ok"), k);
  assert.equal(firstRefusedPrefix(p), undefined);
  const refused = { prefixes: { npmScript: [["C:\\", "EPERM lstat"], ["C:\\x", "ok"]], cwd: [] } };
  assert.deepEqual(firstRefusedPrefix(refused), { kind: "npmScript", path: "C:\\", code: "EPERM lstat" });
  assert.equal(parseRepro("no json"), undefined);
  const step = lstatReproStep(ladderPlan("C:\\fx"), { npmCli: "C:\\n\\npm-cli.js" });
  assert.deepEqual(step.args().slice(0, 1), ["-e"]);
  assert.equal(step.args()[2], "C:\\n\\npm-cli.js");
});

test("npm run: a variant passes only with exit 0 AND every package on disk; the failing one keeps its error lines; the repro runs once per container; clean-up and read-back happen", async () => {
  const base = tmp();
  const calls = [];
  const reproLine = JSON.stringify({ prefixes: { npmScript: [["C:\\", "EPERM lstat"]], cwd: [], nodeExe: [] }, realpathJs: "EPERM lstat", realpathNative: "ok", realpathJsCwd: "EPERM lstat", rootLstat: "EPERM lstat", rootStat: "ok", rootAccess: "ok", rootReaddir: "EPERM scandir" });
  const behavior = (args, cmdline) => {
    if (cmdline.includes("lstatSync")) return { out: `${reproLine}\n` };
    const cwd = args[args.indexOf("--cwd") + 1];
    const env = args.filter((a) => a.startsWith("NODE_OPTIONS="));
    const passes = env.length === 1 && /preserve/.test(env[0]);
    if (!passes) return { exit: 1, err: "node:fs:2744\nconst out = binding.lstat(base, false, undefined, true /* throwIfNoEntry */);\n^\nError: EPERM: operation not permitted, lstat 'C:\\'\n" };
    for (let i = 0; i < 40; i++) { mkdirSync(join(cwd, "node_modules", `nn-tiny-${i}`), { recursive: true }); writeFileSync(join(cwd, "node_modules", `nn-tiny-${i}`, "index.js"), "x"); }
    return {};
  };
  try {
    const r = await runNpmLadder({ launcherPath: "fake", exec: ladderFake(behavior, calls), tmpBase: base, tools: { ...gitTools, npmCli: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js" }, platform: "linux", systemRoot: "C:\\Windows", now: () => "2026-11-25T00:00:00.000Z", variantSpec: "base,nodeopts-preserve,lpac-base" });
    assert.equal(r.ranAtAll, true);
    const by = Object.fromEntries(r.report.variants.map((v) => [v.id, v]));
    assert.equal(by.base.step.status, "fail");
    assert.equal(by.base.step.exitHex, "0x1");
    assert.equal(by.base.step.installed, false);
    assert.match(by.base.step.stderrHead.join("\n"), /EPERM: operation not permitted, lstat 'C:\\'/);
    assert.equal(by["nodeopts-preserve"].step.status, "pass");
    assert.equal(by["nodeopts-preserve"].step.installed, true);
    assert.deepEqual(r.report.passing, ["nodeopts-preserve"]);
    assert.deepEqual(Object.keys(r.report.repro).sort(), ["ac-nocap", "lpac-optout-reg-com"], "once per container");
    assert.equal(r.report.repro["ac-nocap"].firstRefused.path, "C:\\");
    assert.deepEqual(r.report.cleanup, { profileDeleted: true, foldersRemoved: 3, grantsLeft: 0 });
    assert.ok(calls.includes("check") && calls.includes("delete-profile"));
    assert.match(r.markdown, /First prefix refused: npmScript: `C:\\` EPERM lstat/);
    assert.match(r.markdown, /\| base \| ac-nocap \| fail 0x1 \| false \|/);
    assert.match(r.markdown, /Variants where npm ci --offline passed: nodeopts-preserve\./);
    assert.equal(readdirSync(base).length, 0);
    // exit 0 without the packages is not a pass
    const odd = judgeNpm({ id: "npm-ci", label: "x", expect: () => true }, { childStarted: true, childExitCode: 0 }, "", "", false);
    assert.equal(odd.status, "odd");
    assert.equal(packagesInstalled(join(base, "none"), 2, () => false), false);
    assert.equal(packagesInstalled("p", 2, () => true), true);
    assert.match(renderNpmMarkdown({ ...r.report, passing: [] }), /No variant made npm ci --offline pass/);
  } finally { removeTree(base); }
});

test("npm run: a container that cannot be made starts nothing, and without npm-cli.js nothing is tried", async () => {
  const base = tmp();
  try {
    const none = await runNpmLadder({ launcherPath: "fake", tmpBase: base, tools: gitTools, exec: () => ({ status: 125, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: false, stage: "container" })}\n`, stderr: "" }) });
    assert.equal(none.ranAtAll, false);
    const calls = [];
    const r = await runNpmLadder({ launcherPath: "fake", exec: ladderFake(() => ({}), calls), tmpBase: base, tools: gitTools, platform: "linux", now: () => "2026-11-25T00:00:00.000Z" });
    assert.equal(r.report.variants.length, 0);
    assert.ok(r.report.notes.some((n) => /npm-cli\.js was not found/.test(n)));
    assert.ok(!calls.includes("run"));
  } finally { removeTree(base); }
});

// ------------------------------------------------------------------------------------------------ round 3b: git and the NUL device

test("git: the all-NUL variants pass the launcher's flags and judge by exit code only; the open-test results are summarized in plain words", () => {
  const all = gitVariants();
  const plan = ladderPlan("C:\\fx");
  const ctx = { ...ladderCtx, gitRoot: "C:\\Git" };
  const step = (id) => gitStepFor(all.find((v) => v.id === id), "git-version", plan, ctx);
  assert.deepEqual(step("all-nul-rw").launcherArgs, ["--stdin", "nul-rw", "--stdout-nul-rw", "--stderr-nul-rw"]);
  assert.equal(step("all-nul-rw").expect(""), true, "nothing is captured, so the exit code alone counts");
  assert.equal(step("base").expect(""), false);
  assert.deepEqual(step("lpac-all-nul-rw").launcherArgs, ["--stdin", "nul-rw", "--stdout-nul-rw", "--stderr-nul-rw"]);
  assert.equal(all.find((v) => v.id === "lpac-all-nul-rw").container, "lpac-optout-reg-com");
  assert.deepEqual(all.filter((v) => v.openTest).map((v) => v.id), ["base", "lpac-base"]);
  assert.equal(parseOpenTest("noise\nnot json\n"), undefined);
  assert.equal(summarizeOpenTest(undefined).text, "the open-test did not run in this container");
  const ok = [{ name: "a", via: "CreateFileW", ok: true, code: 0 }];
  assert.equal(summarizeOpenTest(ok).text, "the container accepted every combination");
  assert.equal(summarizeOpenTest([{ name: "a", via: "CreateFileW", ok: false, code: 5 }]).text, "the container refused every combination");
  assert.deepEqual(parseOpenTest(`${JSON.stringify({ command: "open-test", opens: [{ name: "n", via: "CreateFileW", ok: false, code: 5 }] })}\n`), [{ name: "n", via: "CreateFileW", ok: false, code: 5 }]);
});

test("the launcher source: an open-test command (CreateFileW flag combinations and the C runtime's _wopen, no new crate), and the standard output and error can be the NUL device", () => {
  const src = launcherSource();
  const readme = readFileSync(join(exp, "README.md"), "utf8");
  assert.match(src, /fn open_test\(\) -> String/);
  assert.match(src, /raw\.get\(1\)\.map\(String::as_str\) == Some\("open-test"\)/);
  for (const needle of ["FILE_SHARE_DELETE", "_wopen(", "_close(", "_errno()", "\\\\\\\\.\\\\NUL", "O_RDWR"]) assert.ok(src.includes(needle), needle);
  assert.match(src, /"--stdout-nul-rw" => a\.stdout_nul = true/);
  assert.match(src, /"--stderr-nul-rw" => a\.stderr_nul = true/);
  for (const doc of ["open-test", "_wopen", "--stdout-nul-rw", "FILE_SHARE_DELETE"]) assert.ok(readme.includes(doc), `README: ${doc}`);
  assert.ok(!/^\s*\[dependencies\][\s\S]*(libc|winapi)\s*=/m.test(readFileSync(join(root, "native", "nn-launcher", "Cargo.toml"), "utf8")), "no new crate");
});

// ------------------------------------------------------------------------------------------------ round 3b: firewall assumptions and the loopback exemption by name

test("firewall: each of the three assumptions is judged alone and the report names the one that fails", () => {
  const ph = (phase, loop, out, started = true) => ({ phase, client: "c", started, loopbackConnections: loop, outboundConnections: out });
  const rule = { added: true };
  const status = (r) => r.assumptions.map((a) => a.status);
  const good = [ph("control-before-rule", 1, 1), ph("inside-without-rule", 0, 1), ph("inside-with-rule", 0, 0), ph("control-with-rule", 1, 1)];
  assert.deepEqual(status(judgeFirewall(good, rule)), ["holds", "holds", "holds"]);
  // round 3 on the hosted runner: the capabilities did not open the network
  const closed = good.map((p) => (p.phase === "inside-without-rule" ? ph(p.phase, 0, 0) : p));
  assert.deepEqual(status(judgeFirewall(closed, rule)), ["FAILS", "not shown", "holds"]);
  assert.deepEqual(status(judgeFirewall(good.map((p) => (p.phase === "inside-with-rule" ? ph(p.phase, 0, 1) : p)), rule)), ["holds", "FAILS", "holds"]);
  assert.deepEqual(status(judgeFirewall(good.map((p) => (p.phase === "control-with-rule" ? ph(p.phase, 1, 0) : p)), rule)), ["holds", "holds", "FAILS"]);
  assert.deepEqual(status(judgeFirewall([], { added: false })), ["not shown", "not shown", "not shown"]);
  const md = (phases, rl = rule) => renderFirewallMarkdown({ generatedAt: "t", host: { platform: "win32", elevated: true, sessionId: 1 }, variant: "v", capabilities: [], firewallProfiles: "x", rule: { ...rl, commandAdd: "add", commandRemove: "rm" }, phases, ...judgeFirewall(phases, rl), cleanup: { profileDeleted: true, ruleRemoved: true }, notes: [] });
  assert.match(md(closed), /Assumption 1 \*\*FAILS\*\*: the capabilities internetClient and privateNetworkClientServer open the network for the container/);
  assert.match(md(closed), /The assumption that fails: number 1 \(/);
  assert.match(md(good), /No assumption failed\./);
  assert.match(md([], { added: false }), /No assumption was shown to fail; not shown: number 1, number 2, number 3\./);
});

test("loopback exemption by name: the command is validated, the cell adds it by name and reads it back by the package SID, and the teardown removes it", () => {
  assert.throws(() => loopbackCommands("S-1-15-2-1-2-3-4-5-6-7", "bad name; x"), /package name/);
  assert.ok(PACKAGE_NAME_PATTERN.test("NimbleNewtExperiment"));
  const c = loopbackCommands("S-1-15-2-1-2-3-4-5-6-7", "NimbleNewtExperiment");
  assert.match(c.addByName, /CheckNetIsolation\.exe LoopbackExempt -a -n=NimbleNewtExperiment/);
  assert.equal(loopbackCommands("S-1-15-2-1-2-3-4-5-6-7").addByName, undefined);
  const table = { exempt: false, calls: [] };
  const ps = (script) => {
    table.calls.push(script);
    if (/-a -n=/.test(script)) { table.exempt = true; return { status: 0, stdout: "added\n", stderr: "" }; }
    if (/-a -p=/.test(script)) { table.exempt = true; return { status: 0, stdout: "added\n", stderr: "" }; }
    if (/-d -p=/.test(script)) { table.exempt = false; return { status: 0, stdout: "removed\n", stderr: "" }; }
    if (/LoopbackExempt -s/.test(script)) return { status: 0, stdout: `${table.exempt ? 1 : 0}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const cell = configCells().find((x) => x.id === "ac-inet-private-loopback-byname");
  const st = netSetup(cell, { ps, packageSid: "S-1-15-2-1-2-3-4-5-6-7", ruleName: "nn-appc-block-0a1b2c3d", profileName: "NimbleNewtExperiment" });
  assert.equal(st.ok, true);
  assert.equal(st.wanted.exemptBy, "name");
  assert.ok(table.calls.some((x) => /-a -n=NimbleNewtExperiment/.test(x)) && !table.calls.some((x) => /-a -p=/.test(x)));
  assert.match(st.summary, /loopback exemption yes, by name/);
  assert.equal(table.exempt, true);
  assert.deepEqual(netTeardown(st, { ps }), { ruleGone: true, exemptGone: true });
  assert.equal(table.exempt, false);
  // one that is not confirmed in the list is a failed set-up
  const refusing = netSetup(cell, { ps: (x) => (/-a -n=/.test(x) ? { status: 0, stdout: "", stderr: "" } : { status: 0, stdout: "0\n", stderr: "" }), packageSid: "S-1-15-2-1-2-3-4-5-6-7", ruleName: "nn-appc-block-0a1b2c3d", profileName: "NimbleNewtExperiment" });
  assert.equal(refusing.ok, false);
});

test("firewall run with the exemption by name: it is added and read back, the same clients run, it is removed, and a throw still removes it", async () => {
  const base = tmp();
  const fake = firewallFake();
  const ex = { on: false, adds: 0 };
  const ps = (script) => {
    if (/-a -n=/.test(script)) { ex.on = true; ex.adds++; return { status: 0, stdout: "added\n", stderr: "" }; }
    if (/-d -p=/.test(script)) { ex.on = false; return { status: 0, stdout: "removed\n", stderr: "" }; }
    if (/LoopbackExempt -s/.test(script)) return { status: 0, stdout: `${ex.on ? 1 : 0}\n`, stderr: "" };
    return fake.ps(script);
  };
  try {
    const r = await runFirewall({ launcherPath: "fake", exec: fake.exec, ps, tmpBase: base, tools, outbound: { host: OUTBOUND_HOST, local: true }, systemRoot: "C:\\Windows", randomHex: () => "0a1b2c3d", settleMs: 20, clients: ["curl"], exemptByName: true, profileName: "NimbleNewtExperiment" });
    assert.deepEqual(r.report.phases.map((p) => p.phase), ["control-before-rule", "inside-without-rule", "inside-with-name-exemption", "inside-with-rule", "control-with-rule", "inside-after-removal"]);
    assert.equal(r.report.exemption.confirmed, true);
    assert.equal(r.report.exemption.removed, true);
    assert.equal(r.report.exemption.loopbackReached, false, "the fake container's loopback stays closed");
    assert.equal(r.report.cleanup.exemptionRemoved, true);
    assert.match(r.markdown, /Loopback exemption added by name/);
    assert.equal(ex.on, false);
    assert.equal(r.report.assumptions.length, 3);
    // a throw while the exemption exists: removed in the finally path
    await assert.rejects(runFirewall({ launcherPath: "fake", exec: fake.exec, ps, tmpBase: base, tools, outbound: { host: OUTBOUND_HOST, local: true }, systemRoot: "C:\\Windows", randomHex: () => "0a1b2c3d", settleMs: 20, clients: ["curl"], exemptByName: true, profileName: "NimbleNewtExperiment",
      log: (m) => { if (/inside-with-name-exemption/.test(m) && ex.on) throw new Error("boom"); } }), /boom/);
    assert.equal(ex.on, false);
    assert.deepEqual(readdirSync(base), []);
  } finally { removeTree(base); }
});

test("round 3b: the workflow runs the npm step and every step keeps its own limit; the README tells what the round answers", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  assert.match(wf, /--mode npm --timeout-ms 45000/);
  assert.ok((wf.match(/if: always\(\)/g) ?? []).length >= 6);
  const readme = readFileSync(join(exp, "README.md"), "utf8");
  for (const needle of ["Round 3b", "rebuilt from progress", "worker", "--mode npm", "open-test"]) assert.ok(readme.includes(needle), needle);
});

// ------------------------------------------------------------------------------------------------ round 4: protected-name layouts, spawn ladder

import {
  JOB_MODES, PIPE_DIAG_SCRIPT, SPAWN_STEP_SCRIPT, buildSpawnArgs, jobArgs, judgeSpawn, parseStepResult, renderSpawnMarkdown, runSpawnLadder, selectSpawnVariants, spawnVariants, stepFiles, stepProgram, summarizeSpawn, targetCommand,
} from "../experiments/windows-appcontainer/round4.mjs";
import { namedDacls } from "../experiments/windows-appcontainer/run-experiment.mjs";


/** Splits a Windows command line into its arguments (the CommandLineToArgvW rules for quotes and backslashes), to read back what buildCommandLine wrote. */
function splitCommandLine(text) {
  const args = [];
  let cur = "";
  let inQuote = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      let n = 0;
      while (text[i] === "\\") { n++; i++; }
      if (text[i] === '"') { cur += "\\".repeat(Math.floor(n / 2)); if (n % 2 === 1) cur += '"'; else inQuote = !inQuote; } else { cur += "\\".repeat(n); i--; }
      started = true;
    } else if (ch === '"') { inQuote = !inQuote; started = true; }
    else if (/\s/.test(ch) && !inQuote) { if (started) { args.push(cur); cur = ""; started = false; } }
    else { cur += ch; started = true; }
  }
  if (started) args.push(cur);
  return args;
}

test("round 4 cells: the layouts are named, the arguments carry the layout, the workspace entry, the DACL dumps and the job limits", () => {
  const cells = configCells();
  const by = Object.fromEntries(cells.map((c) => [c.id, c]));
  assert.equal(by["ac-nocap"].protectMode, "deny-write");
  assert.equal(by["ac-nocap"].rootMode, "modify");
  assert.equal(by["ac-nocap-deny-strong"].protectMode, "deny-strong");
  assert.equal(by["ac-nocap-sealed"].protectMode, "seal");
  assert.equal(by["ac-nocap-sealed-root"].rootMode, "modify-root");
  assert.equal(by["ac-nocap-sealed-root-nolimits"].limits, "none");
  assert.equal(by["lpac-optout-reg-com-sealed-root"].aapPolicy, "optout");
  assert.deepEqual(by["ac-inet-private-sealed-root"].capabilities, ["internetClient", "privateNetworkClientServer"]);
  const plan = buildFixturePlan("C:\\fx");
  const pairs = (a, flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []));
  const a = buildLauncherArgs(by["ac-nocap-sealed-root"], plan, sampleCtx(plan));
  assert.deepEqual(pairs(a, "--grant"), ["modify-root:C:\\fx\\ws", "modify:C:\\fx\\home", "modify:C:\\fx\\scratch", "ro:C:\\fx\\probe", "seal:C:\\fx\\ws\\.git"]);
  assert.deepEqual(pairs(a, "--dump"), ["C:\\fx\\ws", "C:\\fx\\ws\\.git", "C:\\fx\\ws\\.git\\config"]);
  assert.ok(a.includes("--ui-limits") && a.includes("--memory-mb"));
  const none = buildLauncherArgs(by["ac-nocap-sealed-root-nolimits"], plan, sampleCtx(plan));
  assert.ok(!none.includes("--ui-limits") && !none.includes("--memory-mb") && !none.includes("--active-processes"));
  assert.deepEqual(pairs(none, "--timeout-ms"), ["90000"]);
  // the older cells are unchanged: the deny entry, the plain modify on the workspace
  const old = buildLauncherArgs(by["ac-nocap"], plan, sampleCtx(plan));
  assert.deepEqual(pairs(old, "--grant"), ["modify:C:\\fx\\ws", "modify:C:\\fx\\home", "modify:C:\\fx\\scratch", "ro:C:\\fx\\probe", "deny-write:C:\\fx\\ws\\.git"]);
  const noprot = buildLauncherArgs(by["ac-nocap-noprotect"], plan, sampleCtx(plan));
  assert.ok(!noprot.some((x) => /^(deny-write|deny-strong|seal):/.test(String(x))));
});

test("round 4 DACL dumps: the container's own SID is named before the scrubber turns every SID into one word", () => {
  const sid = "S-1-15-2-1-2-3-4-5-6-7";
  const d = namedDacls([{ path: "C:\\x\\ws\\.git", sddl: `D:PAI(D;OICI;0x1;;;${sid})(A;;FA;;;S-1-5-21-1-2-3-1001)` }], sid);
  assert.equal(d[0].sddl, "D:PAI(D;OICI;0x1;;;<container>)(A;;FA;;;S-1-5-21-1-2-3-1001)");
  assert.equal(namedDacls(undefined, sid), undefined);
  assert.equal(scrubText(d[0].sddl, {}), "D:PAI(D;OICI;0x1;;;<container>)(A;;FA;;;<sid>)");
  const md = renderMarkdown(buildReport({ now: "t", host: { platform: "win32", elevated: false, sessionId: 0 }, cells: [{ id: "c", dims: { lpac: false, protect: true, protectMode: "seal" }, launch: { ok: true, childStarted: true, exitCode: 0, daclsBefore: d, daclsAfter: d }, softGrantFailures: [], plantNotes: [], probeReport: "ok", results: ALL_PROBE_IDS.map((id) => ({ id, group: "case", expect: "denied", verdict: "pass", actual: "denied", detail: "", attempts: [] })), startupDenials: [] }], profile: {}, cleanup: { profileDeleted: true } }));
  assert.match(md, /DACL after the grants, `ws\\.git`: `D:PAI\(D;OICI;0x1;;;<container>\)/);
  assert.match(md, /protected-name layout seal; workspace folder entry modify; job limits all/);
});

test("the launcher source (round 4): the layered layouts are built by hand in a fixed order, a sealed folder inherits nothing, the DACLs can be dumped, every new call is documented", () => {
  const src = launcherSource();
  const readme = readFileSync(join(exp, "README.md"), "utf8");
  for (const c of ["InitializeAcl", "AddAce", "AddAccessAllowedAceEx", "AddAccessDeniedAceEx", "GetLengthSid", "ConvertSecurityDescriptorToStringSecurityDescriptorW"]) { assert.ok(src.includes(`${c}(`), `${c} not used`); assert.ok(readme.includes(c), `${c} missing in README`); }
  assert.match(src, /"deny-strong" => Some\(Mode::DenyStrong\), "seal" => Some\(Mode::Seal\), "modify-root" => Some\(Mode::ModifyRoot\)/);
  assert.match(src, /unsafe fn build_layered\(/);
  // seal: one deny (everything but read and execute) first, the allow (read and execute) after the old explicit entries, the DACL protected, inherited entries of the container dropped
  assert.match(src, /Mode::Seal => \(build_layered\(old, sid, &\[\(true, Mode::DenyStrong\.mask\(\), INHERIT_CI_OI\)\], &\[\(false, Mode::Seal\.mask\(\), INHERIT_CI_OI\)\], true, true\)\?, true\)/);
  assert.match(src, /DACL_SECURITY_INFORMATION \| PROTECTED_DACL_SECURITY_INFORMATION/);
  // modify-root: the folder itself without DELETE, everything inside with it (an inherit-only entry)
  assert.match(src, /\(false, modify & !DELETE, 0\), \(false, modify, INHERIT_CI_OI \| INHERIT_ONLY\)/);
  // a revoke of a seal lets the folder inherit again
  assert.match(src, /remove_explicit\(&wpath, old, sid, mode == Mode::Seal\)/);
  assert.match(src, /UNPROTECTED_DACL_SECURITY_INFORMATION/);
  // the DACL dumps: after the grants and again after the program ended; a read-only `dump` command
  assert.match(src, /j\.raw\("daclsBefore", dump_json\(&a\.dump\)\)/);
  assert.match(src, /j\.raw\("daclsAfter", dump_json\(&a\.dump\)\)/);
  assert.match(src, /"dump" => \{/);
  assert.match(src, /"--dump" => a\.dump\.push/);
  // the one process-creation call is still the only one
  assert.equal(src.match(/CreateProcessW\(/g).length, 1);
  for (const banned of ["CreateProcessAsUser", "CreateProcessWithToken", "BREAKAWAY"]) assert.ok(!src.includes(banned), banned);
});

test("the launcher source (A03b slice 2): the revoke takes the sealed names LAST, in a second pass after every other entry and only when every other entry is gone, and still revokes every applied entry once", () => {
  const src = launcherSource();
  const body = /fn revoke_all\(&mut self\) \{([\s\S]*?)\n    \}\n    fn json/.exec(src);
  assert.ok(body, "revoke_all not found");
  // two passes (the non-seals first, then the seals), each newest first
  assert.match(body[1], /for seals in \[false, true\] \{\s*(?:if seals [^\n]*\{ break; \}\s*)?for g in self\.items\.iter_mut\(\)\.rev\(\) \{\s*if \(g\.spec\.mode == Mode::Seal\) != seals \{ continue; \}/);
  // each applied entry is still revoked exactly once and a failure is recorded, not dropped
  assert.equal(body[1].match(/change_ace\(/g).length, 1);
  assert.match(body[1], /if g\.applied && !g\.revoked/);
  assert.match(body[1], /Ok\(\(\)\) => g\.revoked = true, Err\(e\) => g\.error = Some\(e\)/);
  // the seals pass does not run while any other applied entry is still in place (a failed revoke keeps the seal, as the product's revokeAndReadBack does)
  assert.match(body[1], /if seals && self\.items\.iter\(\)\.any\(\|g\| g\.spec\.mode != Mode::Seal && g\.applied && !g\.revoked\) \{ break; \}/);
  // the order is the same for the `revoke` command, the end of `run` and the Drop (all go through revoke_all)
  assert.equal(src.match(/\.revoke_all\(\)/g).length, 3);
  assert.ok(!/items\.iter_mut\(\)\.rev\(\)[^\n]*\n\s*if g\.applied/.test(src), "a single reverse pass is back");
});

test("the experiment workflow (A03b slice 2): the product containment cases run in the hosted job after the launcher build, through the built launcher, redacted, never on a push", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  assert.match(wf, /^on:\n  workflow_dispatch:/m);
  assert.ok(!/^\s+(push|pull_request|schedule):/m.test(wf), "only started by hand");
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  const step = hosted.slice(hosted.indexOf("- name: G05 containment cases through the native backend"));
  assert.ok(step.length > 0 && hosted.indexOf("Product launcher (native/nn-launcher)") < hosted.indexOf("G05 containment cases through the native backend"));
  assert.match(step, /NIMBLENEWT_WIN_LAUNCHER: [^\n]*native\\nn-launcher\\target\\release\\nn-launcher\.exe/);
  assert.match(step, /NIMBLENEWT_WIN_CONTROL_DIR: \$\{\{ runner\.temp \}\}/);
  assert.match(step, /node --import \.\/scripts\/offline-guard\.mjs scripts\/containment-evidence\.mjs run --out [^\n]*--redact [^\n]*redact-log\.mjs/);
  assert.match(step, /if: always\(\)/);
  assert.ok(!step.slice(0, step.indexOf("run: |")).includes("secrets."), "no secret");
  // its report is inside the folder the job uploads
  assert.match(step, /--out "\$RUNNER_TEMP\/appc-out\/g05-native"/);
});

test("spawn ladder variants: unique ids, the dimensions the brief names are all there, the native steps use no libuv", () => {
  const all = spawnVariants();
  assert.equal(new Set(all.map((v) => v.id)).size, all.length);
  const spawn = all.filter((v) => v.kind === "spawn");
  // the full matrix: job limits on and off x four stdio modes x four programs
  for (const jobs of ["all", "none"]) for (const stdio of ["pipe", "inherit", "files", "ignore"]) for (const target of ["node-copy", "node-installed", "cmd", "hostname"]) assert.ok(spawn.some((v) => v.id === `${jobs}-${stdio}-${target}` && v.jobs === jobs && v.stdio === stdio && v.target === target), `${jobs}-${stdio}-${target}`);
  assert.ok(spawn.some((v) => v.detached === true) && spawn.some((v) => v.windowsHide === false));
  assert.deepEqual([...new Set(spawn.map((v) => v.jobs))].sort(), Object.keys(JOB_MODES).sort());
  assert.ok(spawn.some((v) => v.container === "lpac-optout-reg-com"));
  const native = all.filter((v) => v.kind === "native").map((v) => v.id);
  assert.deepEqual(native, ["native-cmd-node-all", "native-cmd-hostname-all", "native-cmd-node-none", "native-cmd-hostname-none", "diag-named-pipe"]);
  assert.equal(selectSpawnVariants("all-pipe-hostname,none-files-cmd").length, 2);
  assert.throws(() => selectSpawnVariants("nope"), /unknown spawn variant/);
  assert.deepEqual(jobArgs("all"), ["--memory-mb", "4096", "--active-processes", "64", "--ui-limits"]);
  assert.deepEqual(jobArgs("none"), []);
  assert.deepEqual(jobArgs("ui-only"), ["--ui-limits"]);
  assert.deepEqual(jobArgs("no-ui"), ["--memory-mb", "4096", "--active-processes", "64"]);
  assert.deepEqual(jobArgs("active-only"), ["--active-processes", "64"]);
  assert.deepEqual(jobArgs("memory-only"), ["--memory-mb", "4096"]);
  // every container named exists in the ladder's list
  for (const v of all) assert.ok(ladderVariants().some((c) => c.id === v.container), v.container);
});

test("spawn ladder arguments: grants, the container, the job flags, the node options, the step's own JSON, a 15 s limit", () => {
  const plan = { ...buildFixturePlan("C:\\fx"), binDir: "C:\\fx\\ws\\bin" };
  const ctx = { profileName: "P", nodeExe: "C:\\node\\node.exe", programDirs: ["C:\\node"], systemRoot: "C:\\Windows", pathDirs: ["C:\\node"] };
  const v = spawnVariants().find((x) => x.id === "none-files-node-copy");
  const files = stepFiles(v, plan);
  const a = buildSpawnArgs(v, plan, ctx, files);
  const pairs = (flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []));
  assert.deepEqual(pairs("--grant"), ["modify:C:\\fx\\ws", "modify:C:\\fx\\home", "modify:C:\\fx\\scratch", "ro:C:\\fx\\probe"]);
  assert.deepEqual(pairs("--grant-soft"), ["rx:C:\\node"]);
  assert.deepEqual(pairs("--timeout-ms"), ["15000"]);
  assert.ok(!a.includes("--memory-mb") && !a.includes("--ui-limits") && !a.includes("--active-processes"));
  assert.ok(pairs("--env").includes("NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main"));
  const cmdline = pairs("--cmdline")[0];
  assert.match(cmdline, /^C:\\node\\node\.exe --preserve-symlinks --preserve-symlinks-main C:\\fx\\probe\\spawn-step\.js /);
  const cfg = JSON.parse(splitCommandLine(cmdline).at(-1));
  assert.equal(cfg.stdio, "files");
  assert.equal(cfg.target, "C:\\fx\\ws\\bin\\node.exe");
  assert.equal(cfg.timeoutMs, 5000);
  const lpac = buildSpawnArgs(spawnVariants().find((x) => x.id === "lpac-all-pipe-node-installed"), plan, ctx, files);
  assert.deepEqual(lpac.flatMap((x, i) => (x === "--aap-policy" ? [lpac[i + 1]] : [])), ["optout"]);
  assert.deepEqual(lpac.flatMap((x, i) => (x === "--capability" ? [lpac[i + 1]] : [])), ["registryRead", "lpacCom"]);
  // native steps run cmd.exe, which starts the program itself
  const nat = stepProgram(spawnVariants().find((x) => x.id === "native-cmd-node-all"), plan, ctx, files);
  assert.equal(nat.exe, "C:\\Windows\\System32\\cmd.exe");
  assert.match(nat.cmdline, /\/c C:\\node\\node\.exe -e 0$/);
  assert.equal(targetCommand("hostname", plan, ctx, "m").file, "C:\\Windows\\System32\\hostname.exe");
  assert.equal(targetCommand("node-installed", plan, ctx, "C:\\m").marker, true);
});

test("the step script really starts one grandchild in every stdio mode and tells how far it got; the named-pipe script is valid", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "spawn-step.js"), SPAWN_STEP_SCRIPT);
    writeFileSync(join(dir, "pipe-diag.js"), PIPE_DIAG_SCRIPT);
    assert.equal(spawnSync(process.execPath, ["--check", join(dir, "pipe-diag.js")]).status, 0);
    for (const stdio of ["pipe", "inherit", "files", "ignore"]) {
      const base = join(dir, `s-${stdio}`);
      const cfg = { target: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(`${base}.marker`)},'ran')`], stdio, detached: false, windowsHide: true, base, timeoutMs: 15_000 };
      const r = spawnSync(process.execPath, [join(dir, "spawn-step.js"), JSON.stringify(cfg)], { encoding: "utf8", timeout: 30_000 });
      const res = parseStepResult(r.stdout);
      assert.equal(res?.outcome, "exit", stdio);
      assert.equal(res.status, 0, stdio);
      assert.ok(existsSync(`${base}.marker`), `${stdio}: the grandchild ran`);
      const steps = readFileSync(`${base}.progress`, "utf8").trim().split(/\r?\n/).map((l) => l.replace(/^\d+ ms /, ""));
      assert.deepEqual(steps.slice(0, 3).map((x) => x.split(" ")[0]), ["start", "before-spawn", "spawn-returned"]);
      assert.ok(steps.at(-1).startsWith("done"));
    }
    // a program that does not exist is an error code, not a hang; a child that never ends is killed at the step's timer and says so
    const missing = spawnSync(process.execPath, [join(dir, "spawn-step.js"), JSON.stringify({ target: join(dir, "no-such-program"), args: [], stdio: "pipe", base: join(dir, "m"), timeoutMs: 5000 })], { encoding: "utf8", timeout: 30_000 });
    assert.equal(parseStepResult(missing.stdout).outcome, "error");
    assert.equal(parseStepResult(missing.stdout).code, "ENOENT");
    const never = spawnSync(process.execPath, [join(dir, "spawn-step.js"), JSON.stringify({ target: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], stdio: "pipe", base: join(dir, "n"), timeoutMs: 500 })], { encoding: "utf8", timeout: 30_000 });
    assert.equal(parseStepResult(never.stdout).outcome, "timeout");
    assert.equal(parseStepResult("noise\nNN-SPAWN-RESULT:{bad"), undefined);
  } finally { removeTree(dir); }
});

test("spawn outcomes: works, EPERM, a hang inside the call, a hang after it, a refused launcher, native steps", () => {
  const v = spawnVariants().find((x) => x.id === "all-pipe-node-installed");
  const line = { childStarted: true, childExitCode: 0, timedOut: false, elapsedMs: 40 };
  const out = (o) => `NN-SPAWN-RESULT:${JSON.stringify(o)}\n`;
  assert.equal(judgeSpawn(v, line, out({ outcome: "exit", status: 0 }), "0 ms start\n1 ms before-spawn\n", true).outcome, "works");
  assert.equal(judgeSpawn(v, line, out({ outcome: "exit", status: 0 }), "", false).outcome, "ran-no-marker");
  assert.equal(judgeSpawn(v, line, out({ outcome: "exit", status: 3 }), "", true).outcome, "exit-3");
  const eperm = judgeSpawn(v, line, out({ outcome: "error", code: "EPERM", phase: "spawn-call" }), "", false);
  assert.equal(eperm.outcome, "EPERM");
  assert.equal(judgeSpawn(v, line, out({ outcome: "timeout", phase: "child-did-not-end" }), "", true).outcome, "hang-child");
  const hung = { childStarted: true, childExitCode: 124, timedOut: true };
  assert.equal(judgeSpawn(v, hung, "", "0 ms start\n2 ms before-spawn\n", false).outcome, "hang-in-spawn");
  assert.equal(judgeSpawn(v, hung, "", "0 ms start\n2 ms before-spawn\n3 ms spawn-returned pid=4\n", true).outcome, "hang-child");
  assert.equal(judgeSpawn(v, hung, "", "", false).outcome, "no-result");
  assert.equal(judgeSpawn(v, line, "", "", false).outcome, "no-result");
  assert.equal(judgeSpawn(v, { childStarted: false, stage: "create-process", error: "CreateProcessW failed: 5" }, "", "", false).outcome, "launcher-refused");
  assert.equal(judgeSpawn(v, undefined, "", "", false).outcome, "launcher-refused");
  const nat = spawnVariants().find((x) => x.id === "native-cmd-node-all");
  assert.equal(judgeSpawn(nat, line, "", "", undefined).outcome, "works");
  assert.equal(judgeSpawn(nat, { ...line, childExitCode: 1 }, "", "", undefined).outcome, "exit-1");
  assert.equal(judgeSpawn(nat, hung, "", "", undefined).outcome, "hang-in-spawn");
  const pipe = spawnVariants().find((x) => x.id === "diag-named-pipe");
  assert.equal(judgeSpawn(pipe, line, 'NN-PIPE-RESULT:{"server":"listening","client":"ok"}\n', "", undefined).outcome, "works");
  assert.equal(judgeSpawn(pipe, line, 'NN-PIPE-RESULT:{"server":"EACCES"}\n', "", undefined).outcome, "no-result");
  const sum = summarizeSpawn([{ outcome: "works", stdio: "pipe", jobs: "all", target: "cmd", container: "ac-nocap", id: "a" }, { outcome: "EPERM", stdio: "ignore", jobs: "all", target: "cmd", container: "ac-nocap", id: "b" }]);
  assert.deepEqual(sum.working, ["a"]);
  assert.deepEqual(sum.byStdio, { pipe: { works: 1, total: 1 }, ignore: { works: 0, total: 1 } });
});

test("spawn run: every step is a launcher run of its own, the outcomes follow the step's files, the grants are read back and the folders removed", async () => {
  const base = tmp();
  const calls = [];
  const copies = [];
  // a fake container: stdio "ignore" is refused (EPERM), "pipe" with every job limit hangs inside the call, everything else works; the native steps work
  const behavior = (args, cmdline) => {
    const m = cmdline.match(/spawn-step\.js (.*)$/);
    if (!m) return /pipe-diag/.test(cmdline) ? { out: 'NN-PIPE-RESULT:{"server":"listening","client":"ok"}\n' } : {};
    const cfg = JSON.parse(splitCommandLine(cmdline).at(-1));
    const progress = (txt) => writeFileSync(`${cfg.base}.progress`, txt);
    if (cfg.stdio === "ignore") { progress("0 ms start\n1 ms before-spawn\n"); return { out: `NN-SPAWN-RESULT:${JSON.stringify({ outcome: "error", code: "EPERM", phase: "spawn-call" })}\n` }; }
    if (cfg.stdio === "pipe" && args.includes("--ui-limits")) { progress("0 ms start\n1 ms before-spawn\n"); return { timedOut: true, exit: 124 }; }
    progress("0 ms start\n1 ms before-spawn\n2 ms spawn-returned pid=1\n");
    writeFileSync(`${cfg.base}.marker`, "ran");
    return { out: `NN-SPAWN-RESULT:${JSON.stringify({ outcome: "exit", status: 0 })}\n` };
  };
  try {
    const r = await runSpawnLadder({ launcherPath: "fake", exec: ladderFake(behavior, calls), tmpBase: base, tools: { ...gitTools, programDirs: ["C:\\node"] }, platform: "linux", systemRoot: "C:\\Windows", now: () => "2026-11-26T00:00:00.000Z", copyFile: (from, to) => { copies.push(to); writeFileSync(to, "stub"); }, variantSpec: "all-ignore-cmd,all-pipe-node-installed,none-pipe-node-installed,none-files-node-copy,native-cmd-node-all,diag-named-pipe" });
    assert.equal(r.ranAtAll, true);
    const by = Object.fromEntries(r.report.variants.map((v) => [v.id, v]));
    assert.equal(by["all-ignore-cmd"].outcome, "EPERM");
    assert.equal(by["all-pipe-node-installed"].outcome, "hang-in-spawn");
    assert.equal(by["none-pipe-node-installed"].outcome, "works");
    assert.equal(by["none-files-node-copy"].outcome, "works");
    assert.equal(by["native-cmd-node-all"].outcome, "works");
    assert.equal(by["diag-named-pipe"].outcome, "works");
    assert.deepEqual(r.report.summary.working, ["none-pipe-node-installed", "none-files-node-copy"]);
    assert.equal(calls.filter((c) => c === "run").length, 6, "one launcher run per step");
    assert.equal(copies.length, 1, "node.exe is copied into the workspace once");
    assert.deepEqual(r.report.cleanup, { profileDeleted: true, foldersRemoved: 1, grantsLeft: 0, aclFirstReadBack: [] });
    assert.ok(calls.includes("check") && calls.includes("delete-profile"));
    assert.match(r.markdown, /\| all-pipe-node-installed \| ac-nocap \| all \| node-installed \| pipe \| false \| true \| hang-in-spawn \| before-spawn \|/);
    assert.match(r.markdown, /Configurations of the script's grandchild that worked: none-pipe-node-installed, none-files-node-copy\./);
    assert.match(r.markdown, /- all-ignore-cmd: EPERM \(spawn-call\)/);
    assert.equal(readdirSync(base).length, 0);
    const refused = await runSpawnLadder({ launcherPath: "fake", exec: () => ({ status: 125, stdout: JSON.stringify({ tool: "nn-appc-launcher", ok: false, stage: "container" }), stderr: "" }), tmpBase: base, tools: gitTools, platform: "linux" });
    assert.equal(refused.ranAtAll, false);
    assert.equal(readdirSync(base).length, 0);
  } finally { removeTree(base); }
});

test("an isolated spawn runs in a worker: it works, it is killed at its timer, a thread that never answers is reported as HUNG and counted, and the main thread is never blocked", async () => {
  const ok = await spawnIsolated({ file: process.execPath, args: ["-e", "process.stdout.write('hi')"], stdin: "pipe", out: "pipe", timeoutMs: 20_000 });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "hi");
  assert.equal(ok.phase, "spawn-returned");
  const dir = tmp();
  try {
    const files = await spawnIsolated({ file: process.execPath, args: ["-e", "process.stdout.write('f')"], stdin: "file", out: "files", base: join(dir, "t"), timeoutMs: 20_000 });
    assert.equal(files.status, 0);
    assert.equal(readFileSync(join(dir, "t.out"), "utf8"), "f");
    const never = await spawnIsolated({ file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], stdin: "pipe", out: "pipe", timeoutMs: 300 });
    assert.equal(never.error?.code, "ETIMEDOUT");
    const missing = await spawnIsolated({ file: join(dir, "no-such"), args: [], stdin: "pipe", out: "pipe", timeoutMs: 5000 });
    assert.equal(missing.error?.code, "ENOENT");
  } finally { removeTree(dir); }
  // a worker whose thread is stuck (here: a blocking wait, standing for a process creation that never returns): the main thread's timer answers HUNG, and keeps going
  const before = isolatedStuck.count;
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 50);
  const t = Date.now();
  const hung = await spawnIsolated({ file: process.execPath, args: [], stdin: "pipe", out: "pipe", timeoutMs: 200, workerSource: `const { parentPort } = require("node:worker_threads"); parentPort.postMessage({ t: "phase", v: "before-spawn" }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);` });
  clearInterval(ticker);
  assert.equal(hung.error?.code, "HUNG");
  assert.equal(hung.phase, "before-spawn");
  assert.equal(isolatedStuck.count, before + 1);
  assert.ok(Date.now() - t < 4000, "answered by the main thread's timer, not by the stuck thread");
  assert.ok(ticks >= 5, "the main thread's event loop kept running");
  isolatedStuck.count = before;
});

test("round 4 probe: tools are skipped once a start has hung, and the spawn diagnostic has four modes that each write their own line", () => {
  const src = readFileSync(join(exp, "probe.mjs"), "utf8");
  assert.match(src, /options\.state\?\.spawnHung === true\) return \{ name, outcome: "skipped", code: "spawn-hung" \}/);
  assert.match(src, /\["files, stdin from a file"[\s\S]*\["inherit"[\s\S]*\["pipes"[\s\S]*\["ignore"/);
  assert.match(src, /isolatedStuck\.count > 0[\s\S]*process\.kill\(process\.pid, "SIGKILL"\)/);
  // a probe step that hung or EPERM'd must not stop the cell: the diagnostic runs before the tools and never longer than 4 s + 1.5 s per mode
  assert.match(src, /Math\.min\(4000, Math\.max\(1000, budget\.remaining\(\) - 4000\)\)/);
});

test("the own-runner job builds nothing (no cargo, no rustup), downloads the hosted job's launchers, and checks their hashes before any step starts them", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  const own = wf.slice(wf.indexOf("  own-runner:"));
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  assert.ok(!/cargo|rustup|rustc/.test(own.replace(/^\s*#.*$/gm, "")), "the own runner has no Rust toolchain and must not build");
  // it needs the hosted job, runs unless cancelled, and only when the hosted job staged verified launchers
  assert.match(own, /\n {4}needs: hosted\n/);
  assert.match(own, /if: \$\{\{ !cancelled\(\) && needs\.hosted\.outputs\.launchers == 'ok' && inputs\.own_runner == true && github\.repository == 'rkcth\/NimbleNewt' && github\.ref == 'refs\/heads\/main' \}\}/);
  assert.ok(!/if: \$\{\{ always\(\)/.test(own.slice(0, own.indexOf("steps:"))), "always() would run the job on a cancelled run");
  assert.match(wf, /^permissions:\n {2}contents: read/m);
  assert.ok(!/^ {4}permissions:/m.test(wf), "no job widens the permissions");
  // the artifact is short-lived, pinned, produced after the builds, and its hashes leave as job outputs
  assert.match(hosted, /name: windows-appcontainer-launchers\n\s+path: \$\{\{ runner\.temp \}\}\/launchers\n\s+if-no-files-found: error\n\s+retention-days: 7/);
  for (const o of ["launchers", "experiment_sha256", "product_sha256"]) assert.ok(hosted.includes(`${o}: \${{ steps.stage.outputs.${o} }}`), o);
  assert.ok(hosted.indexOf("Product launcher (native/nn-launcher)") < hosted.indexOf("id: stage"), "staged after the product build and its release record");
  const stage = hosted.slice(hosted.indexOf("id: stage"), hosted.indexOf("name: windows-appcontainer-launchers"));
  for (const part of ["nn-appc-launcher.exe", "nn-launcher.exe", "native-launcher.mjs verify", "sha256sum", "launchers=ok", "if: always()"]) assert.ok(stage.includes(part), part);
  // the download is pinned (full commit), and the check comes before the first step that starts a launcher
  assert.match(own, /uses: actions\/download-artifact@[0-9a-f]{40} # v8\.0\.2\n\s+with:\n\s+name: windows-appcontainer-launchers/);
  const at = (needle) => { const i = own.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const verify = at("Verify the downloaded launchers");
  assert.ok(at("actions/download-artifact@") < verify);
  const verifyStep = own.slice(verify, at("Containment cases as the runner service"));
  for (const part of ["EXPECT_EXPERIMENT: ${{ needs.hosted.outputs.experiment_sha256 }}", "EXPECT_PRODUCT: ${{ needs.hosted.outputs.product_sha256 }}", "sha256sum", "set -eu", "native-launcher.mjs verify", "nothing was run"]) assert.ok(verifyStep.includes(part), part);
  const firstCopy = verifyStep.indexOf("cp \"$src/");
  for (const f of ["nn-appc-launcher.exe\" \"$EXPECT_EXPERIMENT", "nn-launcher.exe\" \"$EXPECT_PRODUCT"]) {
    const i = verifyStep.indexOf(`check "$src/${f}"`);
    assert.ok(i >= 0 && i < firstCopy, `${f}: hash checked before anything is copied into place`);
    assert.ok(verifyStep.lastIndexOf("check ", verifyStep.length) > firstCopy, "the placed copies are hashed again");
  }
  // every step that runs a launcher comes after the check, and the product one uses the verified copy
  for (const needle of ["run-experiment.mjs", "nn-launcher.exe\" info", "containment-evidence.mjs"]) assert.ok(at(needle) > verify, needle);
  assert.match(own, /NIMBLENEWT_WIN_LAUNCHER: \$\{\{ runner\.temp \}\}\\verified-launchers\\nn-launcher\.exe/);
  // the service-account answer for the product path: info and the ten cases, and no install step
  assert.match(own, /nn-launcher\.exe" info --name "\$info_name" --profile-record "\$info_record"/);
  assert.match(own, /info_name="NimbleNewtRun-\$\(node -e "process\.stdout\.write\(require\('crypto'\)\.randomBytes\(8\)\.toString\('hex'\)\)"\)"/);
  assert.match(own, /containment-evidence\.mjs run --out "\$RUNNER_TEMP\/appc-out\/g05-native" --redact [^\n]*redact-log\.mjs/);
  assert.ok(!/Install-NimbleNewtLauncher|-Action (Install|Uninstall)/.test(own.replace(/^\s*#.*$/gm, "")), "no installer step on the own runner");
  assert.ok(!/secrets\./.test(wf));
});

test("own-runner hand-off review: hashes read from standard input, no empty or partial hash accepted, launcher steps gated on the verify step, build-time hashes bound, profiles removed", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  const code = wf.replace(/^\s*#.*$/gm, "");
  const own = code.slice(code.indexOf("  own-runner:"));
  const hosted = code.slice(code.indexOf("  hosted:"), code.indexOf("  own-runner:"));
  // GNU sha256sum writes "\<hash>" for a file name with a backslash (every Windows $RUNNER_TEMP path): every hash in the workflow is read from standard input
  const sums = [...code.matchAll(/sha256sum[^\n|]*/g)].map((m) => m[0]);
  assert.equal(sums.length, 6, sums.join(" / ")); // two build steps, the staging helper, the verify helper, the clean-up step (experiment launcher, and the product launcher before its delete-profile)
  for (const s of sums) assert.match(s, /^sha256sum -b < "?[^"\s]+"? $/, s);
  // the expected values: non-empty, lower-case hex only, exactly 64 digits, compared whole (never a substring or pattern match)
  const verify = own.slice(own.indexOf("id: verify"), own.indexOf("Containment cases as the runner service"));
  for (const v of ["EXPECT_EXPERIMENT", "EXPECT_PRODUCT"]) assert.ok(verify.includes(`case "$${v}" in *[!0-9a-f]*|"") echo`), `${v}: empty or non-hex refused`);
  assert.ok(verify.includes('[ "${#EXPECT_EXPERIMENT}" -eq 64 ] && [ "${#EXPECT_PRODUCT}" -eq 64 ] || {'), "length 64 required");
  assert.ok(verify.includes('if [ "$got" != "$2" ]; then'), "whole-string comparison");
  assert.ok(!/\[\[|==\s*\*|grep[^\n]*EXPECT/.test(verify), "no pattern or substring comparison");
  // every step after the verify step either has no `if:` (runs only when all before succeeded), is gated on the verify outcome, or is the results upload
  const after = own.slice(own.indexOf("id: verify"));
  const steps = after.split(/\n {6}- /).slice(1);
  assert.ok(steps.length >= 6, String(steps.length));
  for (const s of steps) {
    const m = /\n {8}if: ([^\n]*)/.exec(`\n  ${s}`);
    if (m === null) continue;
    if (s.startsWith("uses: actions/upload-artifact@")) { assert.equal(m[1], "always()"); continue; }
    assert.match(m[1], /^\$\{\{ (!cancelled\(\)|always\(\)) && steps\.verify\.outcome == 'success' \}\}$/, s.split("\n")[0]);
  }
  // the hosted job binds each file to the hash its build step reported before any experiment step ran
  assert.match(hosted, /id: build_experiment\n[^]*?cargo build --release --locked[^\n]*\n\s+echo "sha256=\$\(sha256sum -b < target\/release\/nn-appc-launcher\.exe \| cut -d' ' -f1\)" >> "\$GITHUB_OUTPUT"/);
  assert.match(hosted, /id: build_product\n[^]*?native-launcher\.mjs verify[^\n]*\n\s+echo "sha256=\$\(sha256sum -b < target\/release\/nn-launcher\.exe \| cut -d' ' -f1\)" >> "\$GITHUB_OUTPUT"/);
  assert.ok(hosted.indexOf("id: build_experiment") < hosted.indexOf("--mode spawn"), "the experiment hash is taken before the first experiment step");
  const stage = hosted.slice(hosted.indexOf("id: stage"), hosted.indexOf("name: windows-appcontainer-launchers"));
  for (const part of ["BUILT_EXPERIMENT: ${{ steps.build_experiment.outputs.sha256 }}", "BUILT_PRODUCT: ${{ steps.build_product.outputs.sha256 }}", 'hex64 "$BUILT_EXPERIMENT" && hex64 "$BUILT_PRODUCT"', 'if [ "$e" = "$BUILT_EXPERIMENT" ] && [ "$p" = "$BUILT_PRODUCT" ]; then']) assert.ok(stage.includes(part), part);
  assert.ok(stage.indexOf('if [ "$e" = "$BUILT_EXPERIMENT" ]') < stage.indexOf("launchers=ok"), "launchers=ok only after the build-time hashes match");
  // the container profiles this job makes have CI-only names and are removed again with the re-hashed verified experiment launcher
  assert.ok(!/NIMBLENEWT_WIN_PROFILE/.test(own), "the retired shared-profile setting is not set (the backend makes a per-run profile and ignores it)");
  const clean = own.slice(own.indexOf("Remove the container profiles this job made"));
  assert.match(clean, /^Remove[^\n]*\n\s+shell: bash\n\s+if: \$\{\{ always\(\) && steps\.verify\.outcome == 'success' \}\}/);
  assert.ok(clean.indexOf('if [ "$got" != "$EXPECT_EXPERIMENT" ]; then') < clean.indexOf("delete-profile"), "hashed again before it is run");
  assert.ok(clean.indexOf('if [ "$got" != "$EXPECT_PRODUCT" ]; then') > 0 && clean.indexOf('if [ "$got" != "$EXPECT_PRODUCT" ]; then') < clean.indexOf('"$prod" delete-profile'), "the product launcher is hashed again before its delete-profile");
  assert.ok(!/for n in /.test(clean), "no profile is deleted by a fixed name");
  assert.match(clean, /"\$prod" delete-profile --name "\$pname" --sid "\$psid" --profile-record "\$prec"/);
  assert.ok(!/NimbleNewtAgent/.test(own), "the product's default profile name is never used (or deleted) on the owner's machine");
  // the job's own steps install nothing, make no account, change no firewall rule or machine setting (the experiment harness's reverted ACL grants are its own, tested above)
  assert.ok(!/New-LocalUser|net user|New-NetFirewallRule|Set-ExecutionPolicy|reg add|sc(\.exe)? create|icacls|setx|msiexec|choco|winget|Install-NimbleNewtLauncher/i.test(own), "no persistent machine change in the own-runner job's own steps");
  // the download takes only this run's one named artifact: no run id, token, other repository, pattern or merge
  const dl = own.slice(own.indexOf("actions/download-artifact@"), own.indexOf("id: verify"));
  assert.ok(!/run-id|github-token|repository:|pattern:|merge-multiple/.test(dl), dl);
});

// ------------------------------------------------------------------------------------------------ round 5: the session 0 diagnostic

import {
  CREATION_MODES, DESKTOP_MODES, DLL_INIT_FAILED, FACTS_SCRIPT, OUTCOME_MEANINGS, PROGRAMS, SESSION0_SCHEMA, buildSession0Args, collectContext, eventsScript, fileProgress, hex32, interpretSession0,
  judgeSession0, peImports, programCommand, renderSession0Markdown, runSession0, selectSession0Steps, session0Steps, stepFiles as s0StepFiles, summarizeSession0,
  SESSION0_BUDGET_MS, SESSION0_CLEANUP_WORST_MS, WRITING_DESKTOP_MODES, boundEvents, boundFacts, collectEvents, scrubUserPaths,
} from "../experiments/windows-appcontainer/round5.mjs";

const s0Plan = { workspace: "C:\\r\\ws", home: "C:\\r\\home", scratch: "C:\\r\\scratch", probeDir: "C:\\r\\probe", outDir: "C:\\r\\out", binDir: "C:\\r\\ws\\bin", npmCache: "C:\\r\\scratch\\npmcache" };
const s0Ctx = { profileName: "P", nodeExe: "C:\\Program Files\\nodejs\\node.exe", programDirs: ["C:\\Program Files\\nodejs"], systemRoot: "C:\\Windows", pathDirs: ["C:\\Windows\\System32"] };
const stepById = (id) => session0Steps().find((s) => s.id === id);

test("round 5 steps: unique ids, a baseline, every desktop mode and creation flag appears, and each non-baseline step differs from the baseline in the dimensions its group allows", () => {
  const all = session0Steps();
  assert.equal(new Set(all.map((s) => s.id)).size, all.length);
  assert.ok(stepById("A-node-installed-inherit-no-window"), "the baseline");
  for (const d of DESKTOP_MODES) assert.ok(all.some((s) => s.desktop === d), d);
  for (const c of CREATION_MODES) assert.ok(all.some((s) => s.creation === c), c);
  for (const p of PROGRAMS) assert.ok(all.some((s) => s.program === p), p);
  // A: the program varies alone; B: only the desktop (and the program); C: the creation flag, with the baseline desktop or the full entry; D: the folder grant, with the baseline desktop or the full entry
  for (const s of all.filter((x) => x.group === "A")) assert.ok(s.desktop === "inherit" && s.creation === "no-window", s.id);
  for (const s of all.filter((x) => x.group === "B")) assert.ok(s.desktop !== "inherit" && s.creation === "no-window", s.id);
  for (const s of all.filter((x) => x.group === "C")) assert.ok(s.creation !== "no-window" && ["inherit", "grant-full"].includes(s.desktop), s.id);
  for (const s of all.filter((x) => x.group === "D")) assert.ok(s.program === "node-nogrant" && s.creation === "no-window", s.id);
  // each desktop mode is tried with a console program, a GUI program and the program that failed in the field
  for (const d of DESKTOP_MODES.filter((x) => x !== "inherit")) for (const p of ["node-installed", "gui-wscript", "hostname"]) assert.ok(all.some((s) => s.group === "B" && s.desktop === d && s.program === p), `${d} ${p}`);
  assert.equal(selectSession0Steps("all").length, all.length);
  assert.equal(selectSession0Steps("A-node-installed-inherit-no-window,A-cmd-exit-inherit-no-window").length, 2);
  assert.throws(() => selectSession0Steps("nope"), /unknown session0 step/);
});

test("round 5 launcher arguments: the desktop mode and creation flag are passed as asked, the product's job limits stay, and only the nogrant step leaves the program folder out", () => {
  const step = stepById("B-node-installed-grant-full-no-window");
  const files = s0StepFiles(step, s0Plan);
  const args = buildSession0Args(step, s0Plan, s0Ctx, files);
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], "run");
  assert.equal(at("--desktop"), "grant-full");
  assert.equal(at("--creation"), "no-window");
  assert.equal(at("--memory-mb"), "4096");
  assert.equal(at("--active-processes"), "64");
  assert.ok(args.includes("--ui-limits"));
  assert.equal(at("--aap-policy"), "none");
  assert.equal(at("--timeout-ms"), "15000");
  assert.ok(args.includes("rx:C:\\Program Files\\nodejs"));
  assert.equal(at("--exe"), s0Ctx.nodeExe);
  const none = buildSession0Args(stepById("D-node-nogrant-inherit-no-window"), s0Plan, s0Ctx, s0StepFiles(stepById("D-node-nogrant-inherit-no-window"), s0Plan));
  assert.ok(!none.includes("--grant-soft"), "no grant on the program folder");
  assert.equal(none[none.indexOf("--exe") + 1], s0Ctx.nodeExe);
  const detached = buildSession0Args(stepById("C-hostname-grant-full-detached"), s0Plan, s0Ctx, s0StepFiles(stepById("C-hostname-grant-full-detached"), s0Plan));
  assert.equal(detached[detached.indexOf("--creation") + 1], "detached");
  assert.equal(detached[detached.indexOf("--exe") + 1], "C:\\Windows\\System32\\hostname.exe");
  // the programs
  const f = (p) => programCommand(p, s0Plan, s0Ctx, { marker: "C:\\m" });
  assert.deepEqual(f("cmd-exit"), { exe: "C:\\Windows\\System32\\cmd.exe", args: ["/c", "exit", "0"] });
  assert.equal(f("node-copy").exe, "C:\\r\\ws\\bin\\node.exe");
  assert.equal(f("cmd-copy").exe, "C:\\r\\ws\\bin\\cmd.exe");
  assert.equal(f("gui-wscript").exe, "C:\\Windows\\System32\\wscript.exe");
  assert.ok(f("gui-wscript").args.includes("C:\\r\\probe\\quit.js"));
  assert.deepEqual(f("cmd-runs-node").args, ["/c", s0Ctx.nodeExe, "-e", "0"]);
  assert.equal(f("node-installed").marker, true);
  assert.equal(f("hostname").marker, undefined);
  assert.equal(f("nope"), undefined);
});

test("round 5 judging: works, a missing marker, 0xC0000142, other exit codes in hex, a hang, a desktop set-up failure and no answer", () => {
  const step = stepById("A-node-installed-inherit-no-window");
  const line = (o) => ({ ok: true, childStarted: true, elapsedMs: 40, ...o });
  assert.equal(judgeSession0(step, line({ childExitCode: 0 }), true).outcome, "works");
  assert.equal(judgeSession0(step, line({ childExitCode: 0 }), false).outcome, "ran-no-marker");
  assert.equal(judgeSession0(step, line({ childExitCode: 0 }), undefined).outcome, "works");
  const init = judgeSession0(step, line({ childExitCode: DLL_INIT_FAILED }), false);
  assert.equal(init.outcome, "dll-init-failed");
  assert.equal(init.exitHex, "0xC0000142");
  assert.equal(hex32(1), "0x00000001");
  assert.equal(hex32(-1073741502), "0xC0000142");
  assert.equal(judgeSession0(step, line({ childExitCode: 1 }), undefined).outcome, "exit-1 (0x00000001)");
  assert.equal(judgeSession0(step, line({ childExitCode: 124, timedOut: true }), undefined).outcome, "hang");
  const d = judgeSession0(stepById("B-node-installed-new-station-no-window"), { ok: false, childStarted: false, stage: "grant", error: "window objects: the window station could not be made", desktop: { mode: "new-station" } }, undefined);
  assert.equal(d.outcome, "desktop-setup-failed");
  assert.match(d.detail, /grant: window objects: the window station could not be made/);
  assert.equal(judgeSession0(step, { ok: false, childStarted: false, stage: "grant", error: "x" }, undefined).outcome, "launcher-refused");
  assert.equal(judgeSession0(step, undefined, undefined).outcome, "launcher-refused");
  assert.equal(judgeSession0(step, line({ childExitCode: 0, desktop: { lpDesktop: "Service-0x0-3e7$\\Default" } }), true).lpDesktop, "Service-0x0-3e7$\\Default");
});

/** A results list for the interpretation tests: every step fails with 0xC0000142 unless `fixes` says which (program, desktop, creation) works. */
function s0Results(fixes = () => false) {
  return session0Steps().map((s) => ({ id: s.id, group: s.group, program: s.program, desktop: s.desktop, creation: s.creation, outcome: fixes(s) ? "works" : s.program === "cmd-exit" ? "works" : "dll-init-failed" }));
}

test("round 5 interpretation: each outcome pattern points to the ranked explanation it belongs to, and says when it did not reproduce", () => {
  const text = (r) => interpretSession0(r).join(" | ");
  // H1: the entries (and the made objects) fix node; read level is not enough, both objects are needed
  const h1 = text(s0Results((s) => s.group === "B" && ["grant-full", "new-station", "new-desktop"].includes(s.desktop)));
  assert.match(h1, /H1 supported: node\.exe starts once the container is given access[^|]*grant-full, new-desktop, new-station/);
  assert.match(h1, /both objects are needed/);
  assert.match(h1, /the read level[^|]*is not enough/);
  assert.match(h1, /objects made for the run work/);
  assert.match(text(s0Results((s) => s.group === "B" && s.desktop === "grant-station")), /window station entry alone is enough/);
  assert.match(text(s0Results((s) => s.group === "B" && s.desktop === "grant-desktop")), /desktop entry alone is enough/);
  assert.match(text(s0Results((s) => s.group === "B" && ["grant-read", "grant-full"].includes(s.desktop))), /read level is enough \(the smallest/);
  // only another program starting with the entry (node still failing) is not H1
  const onlyHostname = text(s0Results((s) => s.group === "B" && s.desktop === "grant-full" && s.program === "hostname"));
  assert.ok(!/H1 supported/.test(onlyHostname), onlyHostname);
  assert.match(onlyHostname, /no window station or desktop variant made node\.exe start/);
  // H2 and H3
  assert.match(text(s0Results((s) => s.group === "B" && s.desktop === "empty")), /H2: node\.exe starts with lpDesktop empty/);
  assert.match(text(s0Results((s) => s.group === "C" && s.creation === "detached" && s.desktop === "inherit")), /H3: node\.exe starts with the creation flag detached/);
  // H4 and its weakening
  assert.match(text(s0Results((s) => s.program === "node-copy" && s.group === "A")), /H4 pointer/);
  assert.match(text(s0Results()), /H4 weakened/);
  // nothing changes anything: H5/H6 stay, and the user32 split is named
  const none = text(s0Results());
  assert.match(none, /H5\/H6 remain/);
  assert.match(none, /no window station or desktop variant made node\.exe start/);
  assert.match(none, /the split matches the user32 explanation/);
  assert.match(none, /no grant on node's folder gives the same outcome/);
  // not reproduced
  assert.match(text(s0Results(() => true)), /NOT reproduced/);
  assert.match(interpretSession0([]).join(" "), /baseline step .* did not run/);
  const sum = summarizeSession0(s0Results((s) => s.desktop === "grant-full"));
  assert.ok(sum.byDesktop["grant-full"].works > 0 && sum.byDesktop.inherit.works >= 1);
  assert.ok(Array.isArray(sum.interpretation) && sum.interpretation.length > 0);
});

/** A tiny 64-bit PE image in memory: one .idata section holding the named imports (and delay imports), laid out as the loader expects. */
function fakePe({ imports = [], delay = [], pe32 = false } = {}) {
  const sectionRva = 0x1000;
  const names = [...imports, ...delay];
  const idesc = (imports.length + 1) * 20;
  const ddesc = delay.length > 0 ? (delay.length + 1) * 32 : 0;
  let cursor = idesc + ddesc;
  const nameOff = new Map();
  for (const n of names) { nameOff.set(n, cursor); cursor += n.length + 1; }
  const data = Buffer.alloc(cursor);
  imports.forEach((n, i) => data.writeUInt32LE(sectionRva + nameOff.get(n), i * 20 + 12));
  delay.forEach((n, i) => data.writeUInt32LE(sectionRva + nameOff.get(n), idesc + i * 32 + 4));
  for (const n of names) data.write(n, nameOff.get(n), "latin1");
  const optSize = pe32 ? 224 : 240;
  const headers = Buffer.alloc(0x200);
  headers.writeUInt16LE(0x5a4d, 0);
  headers.writeUInt32LE(0x80, 0x3c);
  headers.writeUInt32LE(0x4550, 0x80);
  headers.writeUInt16LE(1, 0x80 + 6); // one section
  headers.writeUInt16LE(optSize, 0x80 + 20);
  const opt = 0x80 + 24;
  headers.writeUInt16LE(pe32 ? 0x10b : 0x20b, opt);
  const dirs = opt + (pe32 ? 96 : 112);
  headers.writeUInt32LE(sectionRva, dirs + 1 * 8);
  headers.writeUInt32LE(idesc, dirs + 1 * 8 + 4);
  if (delay.length > 0) headers.writeUInt32LE(sectionRva + idesc, dirs + 13 * 8);
  const sec = opt + optSize;
  headers.write(".idata", sec, "latin1");
  headers.writeUInt32LE(data.length, sec + 8);
  headers.writeUInt32LE(sectionRva, sec + 12);
  headers.writeUInt32LE(data.length, sec + 16);
  headers.writeUInt32LE(0x200, sec + 20);
  return Buffer.concat([headers, data]);
}

test("round 5 PE import reader: normal and delay-load DLL names, both PE formats, and nothing for a file that is not a PE image", () => {
  const a = peImports(fakePe({ imports: ["KERNEL32.dll", "USER32.dll"], delay: ["ole32.dll"] }));
  assert.deepEqual(a, { normal: ["kernel32.dll", "user32.dll"], delay: ["ole32.dll"] });
  assert.deepEqual(peImports(fakePe({ imports: ["ntdll.dll"], pe32: true })), { normal: ["ntdll.dll"], delay: [] });
  assert.deepEqual(peImports(fakePe({})), { normal: [], delay: [] });
  assert.equal(peImports(Buffer.from("not a program")), undefined);
  assert.equal(peImports(undefined), undefined);
  const bad = fakePe({ imports: ["a.dll"] });
  bad.writeUInt32LE(0xffffff, 0x3c);
  assert.equal(peImports(bad), undefined);
  const trunc = fakePe({ imports: ["a.dll"] }).subarray(0, 0x90);
  assert.equal(peImports(trunc), undefined);
});

test("round 5 context: the launcher's own line (window station, desktop, DACLs, session, build) and the import tables are recorded, with a service station and a visible station told apart", () => {
  const ctxLine = (o) => JSON.stringify({ tool: "nn-appc-launcher", ok: true, elevated: true, sessionId: 0, windowStation: "Service-0x0-3e7$", windowStationFlags: 0, desktop: "Default", windowStationSddl: "D:(A;;GA;;;SY)", desktopSddl: "D:(A;;GA;;;SY)", integrityRid: 12288, osMajor: 10, osMinor: 0, osBuild: 26200, ...o });
  const calls = [];
  const exec = (p, a) => { calls.push(a); return { stdout: ctxLine({}) }; };
  const readFile = (p) => (/node\.exe$/i.test(p) ? fakePe({ imports: ["KERNEL32.dll", "USER32.dll"] }) : /cmd\.exe$/i.test(p) ? fakePe({ imports: ["KERNEL32.dll"] }) : Buffer.from("x"));
  const ps = (script) => ({ stdout: JSON.stringify({ antivirus: ["Example AV"], smartAppControlState: 0 }) });
  const c = collectContext({ exec, launcherPath: "x", ps, tools: { nodeExe: "C:\\n\\node.exe" }, sysRoot: "C:\\Windows", readFile, since: "2026-11-25T00:00:00Z" });
  assert.deepEqual(calls, [["context"]], "context needs no container and no other option");
  assert.equal(c.launcher.serviceStation, true);
  assert.equal(c.launcher.interactiveStation, false);
  assert.equal(c.launcher.osBuild, 26200);
  assert.equal(c.launcher.sessionId, 0);
  assert.equal(c.imports["node.exe"].user32, true);
  assert.equal(c.imports["cmd.exe"].user32, false);
  assert.match(c.imports["hostname.exe"].error, /not readable/);
  assert.deepEqual(c.facts.antivirus, ["Example AV"]);
  const vis = collectContext({ exec: () => ({ stdout: ctxLine({ windowStation: "WinSta0", windowStationFlags: 1, sessionId: 2 }) }), launcherPath: "x", tools: {}, sysRoot: undefined, readFile, since: "x" });
  assert.equal(vis.launcher.serviceStation, false);
  assert.equal(vis.launcher.interactiveStation, true);
  assert.match(vis.facts.note, /not read/);
  const none = collectContext({ exec: () => ({ stdout: "" }), launcherPath: "x", tools: {}, readFile, since: "x" });
  assert.equal(none.launcher.ok, false);
});

test("round 5 scripts: fixed read-only PowerShell; the events script takes only an ISO time and has no write verb", () => {
  assert.ok(!/\$\{/.test(FACTS_SCRIPT));
  for (const script of [FACTS_SCRIPT, eventsScript("2026-11-25T14:50:27Z")]) {
    assert.ok(!/\b(Set|New|Remove|Add|Clear|Stop|Start|Invoke|Out-File|Disable|Enable|Restart)-[A-Z]/.test(script.replace("New-Object", "")), "no changing verb");
    assert.match(script, /Get-/);
  }
  assert.match(eventsScript("2026-11-25T14:50:27.123Z"), /\[DateTime\]::Parse\('2026-11-25T14:50:27\.123Z'\)/);
  for (const bad of ["", "now", "2026-11-25", "2026-11-25T14:50:27Z'; Remove-Item x; '", "2026-11-25T14:50:27+01:00"]) assert.throws(() => eventsScript(bad), /not an ISO time/, bad);
  assert.match(eventsScript("2026-11-25T14:50:27Z"), /CodeIntegrity\/Operational/);
});

/** A fake launcher for the whole round 5 flow. `behave(step)` returns { exit, timedOut, stage, error }; calls are recorded. */
function session0Fake(behave, { calls = [], context = {} } = {}) {
  const arg = (a, k) => a[a.indexOf(k) + 1];
  const exec = (p, a) => {
    calls.push(a);
    const say = (o) => ({ status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ...o })}\n`, stderr: "" });
    const cmd = a[0];
    if (cmd === "info") return say({ ok: true, profile: "created", elevated: true, sessionId: 0, containerSid: "S-1-15-2-1-2-3" });
    if (cmd === "context") return say({ ok: true, elevated: true, sessionId: 0, windowStation: "Service-0x0-3e7$", windowStationFlags: 0, desktop: "Default", windowStationSddl: "D:", desktopSddl: "D:", integrityRid: 12288, osMajor: 10, osMinor: 0, osBuild: 26200, ...context });
    if (cmd === "desktop-revoke") return say({ ok: true, windowStation: { removed: true, entriesLeft: 0 }, desktop: { removed: true, entriesLeft: 0 } });
    if (cmd === "check") return say({ ok: true, clean: true, grants: a.filter((x) => x.startsWith("ro:")).map((x) => ({ path: x.slice(3), mode: "ro", entriesLeft: 0 })) });
    if (cmd === "revoke") return say({ ok: true, grants: [] });
    if (cmd === "delete-profile") return say({ ok: true });
    if (cmd === "run") {
      const id = basename(arg(a, "--stdout")).replace(/\.out\.txt$/, "");
      const step = session0Steps().find((s) => s.id === id);
      const b = behave(step, a);
      if (b.stage) return say({ ok: false, childStarted: false, stage: b.stage, error: b.error ?? "window objects: x", desktop: { mode: arg(a, "--desktop") } });
      if (b.exit === 0 && programCommand(step.program, { ...s0Plan, binDir: "x" }, s0Ctx, { marker: "m" })?.marker) writeFileSync(join(dirname(arg(a, "--cwd")), "scratch", `s0-${id}.marker`), "ran");
      if (b.stderr) writeFileSync(arg(a, "--stderr"), b.stderr);
      return { status: b.exit, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true, childStarted: true, childExitCode: b.exit, timedOut: b.timedOut === true, elapsedMs: 30, desktop: { mode: arg(a, "--desktop"), lpDesktop: "(null)", allReverted: true }, grants: [] })}\n`, stderr: step.desktop === "inherit" ? "" : "nn-desktop: before grant window station X mask 0x2037f\nnn-desktop: after grant window station X: applied true error None\n" };
    }
    return say({ ok: false, stage: "arguments", error: `unknown ${cmd}` });
  };
  return { exec, calls };
}

test("round 5 flow: an ATTEMPT line before and a RESULT line after every step, partial results after every step, the revoke at the start and the end, everything removed afterwards", async () => {
  const base = tmp();
  const lines = [];
  const partials = [];
  const calls = [];
  const fake = session0Fake((step) => (step.desktop === "grant-full" || step.program === "cmd-exit" ? { exit: 0 } : step.program === "hostname" ? { exit: 1, stderr: "Access is denied.\n" } : step.id === "B-node-installed-new-desktop-no-window" ? { timedOut: true, exit: 124 } : step.id === "B-node-installed-new-station-no-window" ? { stage: "grant", error: "window objects: no access" } : { exit: DLL_INIT_FAILED }), { calls });
  const stepOrder = session0Steps().map((x) => x.id);
  const ids = ["A-node-installed-inherit-no-window", "A-cmd-exit-inherit-no-window", "A-hostname-inherit-no-window", "B-node-installed-grant-full-no-window", "B-node-installed-new-desktop-no-window", "B-node-installed-new-station-no-window", "D-node-nogrant-inherit-no-window"].sort((a, b) => stepOrder.indexOf(a) - stepOrder.indexOf(b));
  const r = await runSession0({ launcherPath: "fake", exec: fake.exec, tmpBase: base, tools: { nodeExe: "C:\\n\\node.exe", programDirs: ["C:\\n"] }, platform: "linux", systemRoot: "C:\\Windows", now: () => "2026-11-26T00:00:00.000Z", stepSpec: ids.join(","), progress: (l) => lines.push(l), writePartial: (p) => partials.push(JSON.parse(JSON.stringify(p))), copyFile: () => {}, ps: () => ({ stdout: "{}" }), readFile: () => Buffer.from("x") });
  assert.equal(r.ranAtAll, true);
  assert.equal(r.report.schema, SESSION0_SCHEMA);
  const text = lines.map((l) => l.replace(/^\d+ ms /, ""));
  // context first, then for each step exactly ATTEMPT then RESULT, in order
  assert.ok(text[0].startsWith("ATTEMPT context") && text[1].startsWith("RESULT context station=Service-0x0-3e7$"));
  const stepLines = text.slice(2);
  assert.equal(stepLines.length, ids.length * 2);
  ids.forEach((id, i) => { assert.equal(stepLines[2 * i], `ATTEMPT step ${id}`); assert.ok(stepLines[2 * i + 1].startsWith(`RESULT step ${id} `), stepLines[2 * i + 1]); });
  assert.ok(lines.every((l) => /^\d+ ms (ATTEMPT|RESULT) /.test(l)));
  // the outcomes
  const by = Object.fromEntries(r.report.steps.map((s) => [s.id, s]));
  assert.equal(by["A-node-installed-inherit-no-window"].outcome, "dll-init-failed");
  assert.equal(by["A-node-installed-inherit-no-window"].exitHex, "0xC0000142");
  assert.equal(by["A-cmd-exit-inherit-no-window"].outcome, "works");
  assert.equal(by["A-hostname-inherit-no-window"].outcome, "exit-1 (0x00000001)");
  assert.deepEqual(by["A-hostname-inherit-no-window"].stderrHead, ["Access is denied."]);
  assert.equal(by["B-node-installed-grant-full-no-window"].outcome, "works");
  assert.equal(by["B-node-installed-grant-full-no-window"].marker, true);
  assert.ok(by["B-node-installed-grant-full-no-window"].desktopLog.length === 2, "the launcher's before/after lines are kept");
  assert.equal(by["B-node-installed-new-desktop-no-window"].outcome, "hang");
  assert.equal(by["B-node-installed-new-station-no-window"].outcome, "desktop-setup-failed");
  assert.equal(by["A-node-installed-inherit-no-window"].desktopLog, undefined, "the inherit mode touches no window object");
  // partial results after every step (growing), the last one marked done
  assert.equal(partials.length, ids.length + 1);
  assert.deepEqual(partials.slice(0, ids.length).map((p) => p.steps.length), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(partials.at(-1).done, true);
  assert.equal(partials[0].done, false);
  // the revoke runs at the start (before the first step) and at the end (after the last), then the profile is deleted
  const order = calls.map((a) => a[0]);
  const firstRun = order.indexOf("run");
  assert.ok(order.indexOf("desktop-revoke") < firstRun);
  assert.ok(order.lastIndexOf("desktop-revoke") > order.lastIndexOf("run"));
  assert.equal(order.at(-1), "delete-profile");
  assert.ok(order.indexOf("context") < order.indexOf("desktop-revoke"));
  assert.deepEqual(r.report.cleanup.desktopEntriesLeftAfter, { windowStation: 0, desktop: 0 });
  assert.equal(r.report.cleanup.profileDeleted, true);
  assert.equal(r.report.cleanup.grantsLeft, 0);
  assert.equal(existsSync(r.names.root), false, "the fixture folder is gone");
  // the summary and report text
  assert.ok(r.report.summary.byDesktop["grant-full"]);
  assert.match(r.markdown, /^# Windows AppContainer experiment, round 5/);
  for (const part of ["## Context", "## Steps", "## What worked", "## What the outcomes point to", "## What each outcome would mean", "## Steps that did not work", "## Clean-up", "0xC0000142"]) assert.ok(r.markdown.includes(part), part);
  for (const m of OUTCOME_MEANINGS) assert.ok(r.markdown.includes(m), m.slice(0, 20));
});

test("round 5 flow: a launcher that cannot make the container starts nothing; a dry run starts nothing; a step that throws is recorded, not fatal", async () => {
  const base = tmp();
  const refused = await runSession0({ launcherPath: "fake", exec: () => ({ stdout: JSON.stringify({ tool: "nn-appc-launcher", ok: false, stage: "container" }) }), tmpBase: base, tools, platform: "linux" });
  assert.equal(refused.ranAtAll, false);
  assert.equal(refused.markdown, "");
  assert.match(refused.report.notes[0], /could not create or find the container/);
  const calls = [];
  const dry = await runSession0({ launcherPath: "fake", exec: session0Fake(() => ({ exit: 0 }), { calls }).exec, tmpBase: base, tools: { nodeExe: "n", programDirs: [] }, platform: "linux", systemRoot: "C:\\Windows", dryRun: true, stepSpec: "A-node-installed-inherit-no-window" });
  assert.equal(dry.report.steps[0].outcome, "not-started");
  assert.ok(!calls.some((a) => a[0] === "run" || a[0] === "desktop-revoke" || a[0] === "delete-profile"));
  const inner = session0Fake(() => ({ exit: 0 }));
  const exec = (p, a) => { if (a[0] === "run") throw new Error("spawn failed"); return inner.exec(p, a); };
  const thrown = await runSession0({ launcherPath: "fake", exec, tmpBase: base, tools: { nodeExe: "n", programDirs: [] }, platform: "linux", systemRoot: "C:\\Windows", stepSpec: "A-node-installed-inherit-no-window", copyFile: () => {}, ps: () => ({ stdout: "{}" }), readFile: () => Buffer.alloc(1) });
  assert.equal(thrown.report.steps[0].outcome, "launcher-refused");
  assert.equal(thrown.report.cleanup.profileDeleted, true);
});

test("round 5 command line and progress sink: --mode session0 with --steps, a sink that prints and appends, and the report text names every dimension", () => {
  const o = parseCli(["--mode", "session0", "--steps", "A-node-installed-inherit-no-window", "--timeout-ms", "15000"]);
  assert.equal(o.mode, "session0");
  assert.equal(o.stepSpec, "A-node-installed-inherit-no-window");
  assert.equal(o.limits.timeoutMs, 15000);
  assert.throws(() => parseCli(["--mode", "session9"]), /--mode/);
  const dir = tmp();
  const printed = [];
  const sink = fileProgress(join(dir, "p.txt"), (m) => printed.push(m));
  sink("1 ms ATTEMPT a");
  sink("2 ms RESULT a works");
  assert.deepEqual(readFileSync(join(dir, "p.txt"), "utf8").split("\n").filter(Boolean), ["1 ms ATTEMPT a", "2 ms RESULT a works"]);
  assert.deepEqual(printed, ["1 ms ATTEMPT a", "2 ms RESULT a works"]);
  const md = renderSession0Markdown({ generatedAt: "t", host: { platform: "win32", release: "10.0.26200", elevated: true, sessionId: 0 }, steps: [], context: {}, notes: ["a note"], cleanup: {} });
  assert.match(md, /session id: 0/);
  assert.match(md, /- a note/);
});

test("the launcher source (round 5): the window objects are touched only in the experiment build, every entry is removed and read back, the default is the product's behaviour, and every new call is documented", () => {
  const win = readFileSync(join(root, "native", "nn-launcher", "src", "win.rs"), "utf8");
  const desk = readFileSync(join(root, "native", "nn-launcher", "src", "desk.rs"), "utf8");
  const priv = readFileSync(join(root, "native", "nn-launcher", "src", "privdesk.rs"), "utf8");
  const args = readFileSync(join(root, "native", "nn-launcher", "src", "args.rs"), "utf8");
  const readme = readFileSync(join(exp, "README.md"), "utf8");
  // desk.rs is a module of the experiment build only; the product has neither the module nor the other creation flags. Its lpDesktop is the private window station's (privdesk.rs, A03b Session 0 fix),
  // and the experiment's own modes replace it only when there is no private one.
  assert.match(win, /#\[cfg\(feature = "experiment"\)\]\n#\[path = "desk\.rs"\]\nmod desk;/);
  assert.match(win, /#\[cfg\(feature = "experiment"\)\]\n\s*if lp_desktop\.is_empty\(\) \{ lp_desktop = desk\.lp_desktop\.clone\(\)\.unwrap_or_default\(\); \}\n\s*if !lp_desktop\.is_empty\(\) \{ si\.StartupInfo\.lpDesktop = lp_desktop\.as_mut_ptr\(\); \}/);
  assert.equal(win.match(/lpDesktop =/g).length, 1, "lpDesktop is assigned in one place");
  assert.ok(win.includes('#[cfg(not(feature = "experiment"))]\n    { let _ = a; base | CREATE_NO_WINDOW }'), "the product always uses CREATE_NO_WINDOW");
  assert.match(win, /Creation::NoWindow => CREATE_NO_WINDOW, Creation::Detached => DETACHED_PROCESS, Creation::NoFlag => 0, Creation::NewConsole => CREATE_NEW_CONSOLE/);
  assert.equal(win.match(/CreateProcessW\(/g).length, 1);
  assert.match(win, /creation_flags\(a\), env\.as_ptr\(\)/);
  // the experiment's defaults are the measured baseline (a Rust test pins it as well); the product does not read the desktop option (win.rs private_wanted)
  assert.match(args, /pub\(crate\) enum DesktopMode \{ #\[default\] Inherit,/);
  assert.match(args, /pub\(crate\) enum Creation \{ #\[default\] NoWindow,/);
  assert.match(args, /"--stderr-nul-rw" \| "--dump" \| "--desktop" \| "--creation" if !EXPERIMENT => return Err\(format!\("\{flag\} is an experiment option and is not in this build"\)\)/);
  // an entry is added with one SetSecurityInfo and removed by hand; Drop removes what is left; the read-back count is reported and a second finish does nothing
  assert.match(desk, /impl Drop for Desk \{ fn drop\(&mut self\) \{ self\.finish\(\); \} \}/);
  assert.match(desk, /remove_entries\(t\.handle, self\.sid\)/);
  assert.match(desk, /t\.left = object_entries\(t\.handle, self\.sid\)/);
  assert.match(desk, /if t\.original\.is_some\(\) && !t\.created && !t\.revoked \{/);
  assert.match(desk, /fn all_reverted\(&self\) -> bool/);
  assert.match(win, /desk\.finish\(\); j\.raw\("desktop", desk\.json\(a\.desktop\)\);/);
  assert.match(win, /"desktop-revoke" => \{/);
  assert.match(win, /"context" => \{/);
  // a set-up that failed stops the run before anything starts
  assert.match(win, /if let Some\(e\) = &desk\.failed \{ return Err\(\("grant", e\.clone\(\)\)\);/);
  assert.equal([...desk.matchAll(/self\.failed = Some\(format!\("window objects: /g)].length, 12, "every set-up failure message starts with the marker the harness looks for (7 of round 5, 5 of the home modes)");
  // before and after lines on standard error for each step of the set-up
  for (const phrase of ["before grant", "after grant", "before create desktop", "after create desktop", "before create window station", "after create window station", "before revoke", "after revoke"]) assert.ok(desk.includes(phrase), phrase);
  // no registry, no service, no persistent setting
  for (const banned of ["RegSetValue", "RegCreateKey", "CreateService", "SetNamedSecurityInfo", "Wow64", "SetSystem", "SetUserObjectInformation"]) assert.ok(!desk.includes(banned), banned);
  // the one handle-open in desk.rs asks for READ_CONTROL and WRITE_DAC only, never all access
  assert.ok(!/GENERIC_ALL|MAXIMUM_ALLOWED/.test(desk));
  for (const c of ["GetProcessWindowStation", "GetThreadDesktop", "GetUserObjectInformationW", "OpenWindowStationW", "OpenDesktopW", "CreateWindowStationW", "CreateDesktopW", "SetProcessWindowStation", "CloseWindowStation", "CloseDesktop", "GetSecurityInfo", "SetSecurityInfo", "RtlGetVersion", "GetSidSubAuthority", "TokenIntegrityLevel", "IsValidSid", "GetLengthSid", "IsValidAcl"]) {
    assert.ok(desk.includes(`${c}`) || priv.includes(`${c}`), `${c} not used in desk.rs or privdesk.rs`);
    assert.ok(readme.includes(c), `${c} missing in README`);
  }
});

test("the launcher crate (round 5): the extra windows-sys modules come only with the experiment feature, and the product's own dependency list is unchanged", () => {
  const toml = readFileSync(join(root, "native", "nn-launcher", "Cargo.toml"), "utf8");
  const feature = /^experiment = \[([^\]]*)\]/m.exec(toml);
  assert.ok(feature, "experiment feature");
  const extra = [...feature[1].matchAll(/"windows-sys\/([A-Za-z0-9_]+)"/g)].map((m) => m[1]).sort();
  // (Win32_Graphics_Gdi and Win32_System_StationsAndDesktops became the product's own with the private window station fix)
  // (the home-case round added the child-side window, clipboard, hook, atom and keyboard-state calls, still experiment only)
  assert.deepEqual(extra, ["Wdk_System_SystemServices", "Win32_System_DataExchange", "Win32_System_LibraryLoader", "Win32_System_SystemInformation", "Win32_UI_Input_KeyboardAndMouse", "Win32_UI_WindowsAndMessaging"]);
  const deps = /^windows-sys = \{ version = "0\.59", features = \[([^\]]*)\]/m.exec(toml)[1];
  const listed = [...deps.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(listed, ["Win32_Foundation", "Win32_Graphics_Gdi", "Win32_Security", "Win32_Security_Authorization", "Win32_Security_Isolation", "Win32_Storage_FileSystem", "Win32_System_Diagnostics_ToolHelp", "Win32_System_IO", "Win32_System_JobObjects", "Win32_System_Pipes", "Win32_System_RemoteDesktop", "Win32_System_StationsAndDesktops", "Win32_System_Threading"]);
  assert.ok(!/^default = /m.test(toml), "no default features");
  assert.ok(!/features = \["experiment"\]/.test(readFileSync(join(root, "native", "nn-launcher", "Cargo.toml"), "utf8")));
});

test("the experiment workflow (round 5): the session 0 step runs second in the hosted job and in the own-runner job after the hash check, gated like every launcher step", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  const code = wf.replace(/^\s*#.*$/gm, "");
  const hosted = code.slice(code.indexOf("  hosted:"), code.indexOf("  own-runner:"));
  const own = code.slice(code.indexOf("  own-runner:"));
  const h = hosted.slice(hosted.indexOf("- name: Session 0 diagnostic"));
  assert.match(h, /^- name: Session 0 diagnostic, round 5 \(15 s per step[^\n]*\n\s+shell: bash\n\s+if: always\(\)\n\s+timeout-minutes: 25\n/);
  assert.ok(hosted.indexOf("--mode spawn") < hosted.indexOf("--mode session0") && hosted.indexOf("--mode session0") < hosted.indexOf("--mode cases"));
  assert.ok(hosted.indexOf("id: build_experiment") < hosted.indexOf("--mode session0"), "built before it runs, so the new code ships through the staged artifact");
  const o = own.slice(own.indexOf("- name: Session 0 diagnostic"));
  assert.match(o, /^- name: Session 0 diagnostic, round 5, as the runner service\n\s+shell: bash\n\s+if: \$\{\{ !cancelled\(\) && steps\.verify\.outcome == 'success' \}\}\n\s+timeout-minutes: 25\n/);
  assert.ok(own.indexOf("id: verify") < own.indexOf("--mode session0"));
  for (const part of [h, o]) {
    assert.match(part, /--mode session0 --timeout-ms 15000 2>&1 \| node scripts\/redact-log\.mjs \|\| rc=\$\?/);
    assert.match(part, /session0\.md/);
    assert.match(part, /session0\.progress/);
  }
  // the own runner still builds nothing and still checks hashes from standard input
  assert.ok(!/cargo|rustup/.test(own));
  assert.ok(own.includes("check \"$src/nn-appc-launcher.exe\" \"$EXPECT_EXPERIMENT\""));
});

test("round 5 review: a step that wrote a window-object DACL and did not report it reverted (killed, crashed, not reverted) is followed at once by desktop-revoke; others are not", async () => {
  const base = tmp();
  const calls = [];
  const inner = session0Fake(() => ({ exit: DLL_INIT_FAILED }), { calls });
  const killed = "B-node-installed-grant-full-no-window";
  const notReverted = "B-node-installed-grant-station-no-window";
  const reverted = "B-node-installed-grant-read-no-window";
  const noWrite = "B-node-installed-empty-no-window";
  const exec = (p, a) => {
    if (a[0] === "run") {
      const id = basename(a[a.indexOf("--stdout") + 1]).replace(/\.out\.txt$/, "");
      if (id === killed) { calls.push(a); return { status: null, stdout: "", stderr: "" }; } // the launcher was killed: no line
      if (id === notReverted) { calls.push(a); return { status: 0, stdout: `${JSON.stringify({ tool: "nn-appc-launcher", ok: true, childStarted: true, childExitCode: DLL_INIT_FAILED, desktop: { allReverted: false }, grants: [] })}\n`, stderr: "" }; }
    }
    return inner.exec(p, a);
  };
  const ids = ["A-node-installed-inherit-no-window", killed, notReverted, reverted, noWrite];
  const order = session0Steps().map((x) => x.id);
  ids.sort((x, y) => order.indexOf(x) - order.indexOf(y));
  const r = await runSession0({ launcherPath: "fake", exec, tmpBase: base, tools: { nodeExe: "C:\\n\\node.exe", programDirs: [] }, platform: "linux", systemRoot: "C:\\Windows", stepSpec: ids.join(","), copyFile: () => {}, ps: () => ({ stdout: "{}" }), readFile: () => Buffer.alloc(1) });
  const seq = calls.map((a) => (a[0] === "run" ? basename(a[a.indexOf("--stdout") + 1]).replace(/\.out\.txt$/, "") : a[0]));
  const after = (id) => seq[seq.indexOf(id) + 1];
  assert.equal(after(killed), "desktop-revoke", "after a killed grant step");
  assert.equal(after(notReverted), "desktop-revoke", "after a step that reported allReverted false");
  assert.notEqual(after(reverted), "desktop-revoke", "not after a grant step that reverted everything");
  assert.notEqual(after(noWrite), "desktop-revoke", "not after a mode that writes nothing");
  assert.notEqual(after("A-node-installed-inherit-no-window"), "desktop-revoke");
  const by = Object.fromEntries(r.report.steps.map((x) => [x.id, x]));
  assert.deepEqual(by[killed].revokeAfterStep, { ok: true, windowStation: 0, desktop: 0 });
  assert.equal(by[reverted].revokeAfterStep, undefined);
  assert.deepEqual(WRITING_DESKTOP_MODES, ["grant-read", "grant-full", "grant-station", "grant-desktop", "new-desktop"], "new-station writes no DACL of the launcher's own objects");
  // a revoke that fails is a note in the report
  const bad = await runSession0({ launcherPath: "fake", exec: (p, a) => (a[0] === "desktop-revoke" ? { stdout: "" } : exec(p, a)), tmpBase: base, tools: { nodeExe: "n", programDirs: [] }, platform: "linux", systemRoot: "C:\\Windows", stepSpec: killed, copyFile: () => {}, ps: () => ({ stdout: "{}" }), readFile: () => Buffer.alloc(1) });
  assert.ok(bad.report.notes.some((n) => n.includes(`desktop-revoke after step ${killed} did not report success`)));
});

test("round 5 review: the time budget stops starting steps so the clean-up still runs before the workflow step's limit", async () => {
  // second review: the clean-up's own limits are 60 s (desktop-revoke) + 3 x 120 s (folder read-back) + 120 s (events) + 60 s (profile): 10 min; budget plus that fits the 25-minute step
  assert.equal(SESSION0_CLEANUP_WORST_MS, 10 * 60_000);
  assert.ok(SESSION0_BUDGET_MS + SESSION0_CLEANUP_WORST_MS <= 25 * 60_000, "budget plus the clean-up's own limits fit in the 25-minute workflow step");
  assert.equal(SESSION0_BUDGET_MS, 15 * 60_000);
  const wfText = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  const s0Steps = [...wfText.matchAll(/--mode session0/g)];
  assert.equal(s0Steps.length, 2);
  for (const m of s0Steps) assert.match(wfText.slice(wfText.lastIndexOf("- name:", m.index), m.index), /timeout-minutes: 25\n/, "each session 0 step keeps its 25-minute limit");
  // a step that writes a DACL also reserves the desktop-revoke after it (60 s): with a 16 min budget at 14 min elapsed an inherit step starts (14 + 1.25 <= 16), a grant step does not (14 + 2.25 > 16)
  {
    let t = 0;
    const fake = session0Fake(() => ({ exit: DLL_INIT_FAILED }));
    const ids2 = ["A-node-installed-inherit-no-window", "B-node-installed-grant-full-no-window"];
    const r2 = await runSession0({ launcherPath: "fake", exec: (p, a) => { if (a[0] === "info") t = 14 * 60_000; return fake.exec(p, a); }, clock: () => t, budgetMs: 16 * 60_000, timeoutMs: 15_000, tmpBase: tmp(), tools: { nodeExe: "n", programDirs: [] }, platform: "linux", systemRoot: "C:\\Windows", stepSpec: ids2.join(","), copyFile: () => {}, ps: () => ({ stdout: "{}" }), readFile: () => Buffer.alloc(1) });
    assert.deepEqual(r2.report.steps.map((x) => x.outcome), ["dll-init-failed", "not-started"]);
  }
  const base = tmp();
  const calls = [];
  let now = 1_000_000;
  const inner = session0Fake(() => ({ exit: DLL_INIT_FAILED }), { calls });
  const exec = (p, a) => { if (a[0] === "run") now += 5 * 60_000; return inner.exec(p, a); }; // every step "takes" five minutes
  const ids = session0Steps().slice(0, 6).map((x) => x.id);
  const lines = [];
  const r = await runSession0({ launcherPath: "fake", exec, clock: () => now, budgetMs: 16 * 60_000, timeoutMs: 15_000, progress: (l) => lines.push(l), tmpBase: base, tools: { nodeExe: "n", programDirs: [] }, platform: "linux", systemRoot: "C:\\Windows", stepSpec: ids.join(","), copyFile: () => {}, ps: () => ({ stdout: "{}" }), readFile: () => Buffer.alloc(1) });
  // 0 + 75 s <= 16 min: run (now 5 min); 5 + 1.25 <= 16: run (10); 10 + 1.25 <= 16: run (15); 15 + 1.25 > 16: the rest are not started
  assert.equal(calls.filter((a) => a[0] === "run").length, 3);
  assert.deepEqual(r.report.steps.map((x) => x.outcome), ["dll-init-failed", "dll-init-failed", "dll-init-failed", "not-started", "not-started", "not-started"]);
  assert.match(r.report.steps[3].detail, /^time budget: 16 min/);
  assert.ok(r.report.notes.some((n) => /3 steps were not started: the time budget \(16 min\)/.test(n)));
  assert.ok(lines.some((l) => /RESULT budget 3 steps not started/.test(l)));
  const order = calls.map((a) => a[0]);
  assert.ok(order.lastIndexOf("desktop-revoke") > order.lastIndexOf("run"), "the clean-up still runs");
  assert.equal(order.at(-1), "delete-profile");
});

test("round 5 review: event texts and product names are bounded and lose the folder names under any user profile", () => {
  assert.equal(scrubUserPaths("blocked \\Device\\HarddiskVolume3\\Users\\Jane Doe\\AppData\\x.dll"), "blocked \\Device\\HarddiskVolume3\\Users\\<account>\\AppData\\x.dll");
  assert.equal(scrubUserPaths("C:/Users/jdoe/a and /home/jdoe/b"), "C:/Users/<account>/a and /home/<account>/b");
  assert.equal(scrubUserPaths("c:\\users\\Ann"), "c:\\users\\<account>");
  assert.equal(scrubUserPaths("C:\\Users\\Rob attempted to load"), "C:\\Users\\<account>", "a name with spaces: more is removed, never less");
  const long = "C:\\Users\\Someone\\" + "y".repeat(400);
  const ev = boundEvents({ "Microsoft-Windows-CodeIntegrity/Operational": Array.from({ length: 60 }, (_, i) => ({ id: 3033, level: "Warning", text: i === 0 ? long : "x", extra: "dropped" })), "Microsoft-Windows-AppLocker/EXE and DLL": { error: "EventLogNotFoundException" } });
  const ci = ev["Microsoft-Windows-CodeIntegrity/Operational"];
  assert.equal(ci.length, 40);
  assert.ok(ci[0].text.length <= 180 && !ci[0].text.includes("Someone"));
  assert.deepEqual(Object.keys(ci[1]), ["id", "level", "text"]);
  assert.deepEqual(ev["Microsoft-Windows-AppLocker/EXE and DLL"], { error: "EventLogNotFoundException" });
  assert.deepEqual(boundEvents(null), { note: "events were not read" });
  assert.deepEqual(collectEvents({ ps: () => ({ stdout: JSON.stringify({ L: [{ id: 1, level: "Error", text: "C:\\Users\\Owner\\z" }] }) }), since: "2026-11-25T00:00:00Z" }), { L: [{ id: 1, level: "Error", text: "C:\\Users\\<account>\\z" }] });
  const f = boundFacts({ antivirus: Array.from({ length: 12 }, (_, i) => `Product ${i} ${"z".repeat(100)}`), edition: "Microsoft Windows 11 Pro" });
  assert.equal(f.antivirus.length, 8);
  assert.ok(f.antivirus.every((n) => n.length <= 80));
  assert.deepEqual(boundFacts({ antivirus: "One" }).antivirus, ["One"]);
  assert.equal(boundFacts(undefined), undefined);
  const c = collectContext({ exec: () => ({ stdout: "" }), launcherPath: "x", ps: () => ({ stdout: JSON.stringify({ antivirus: ["A".repeat(200)] }) }), tools: {}, readFile: () => Buffer.alloc(1), since: "x" });
  assert.equal(c.facts.antivirus[0].length, 80, "the context uses the bounded facts");
});

test("round 5 review: desk.rs refuses the interactive station, a SID that is not one profile's and a NULL DACL, compares the DACL with its copy before writing anything back, and desktop-revoke makes no profile", () => {
  const desk = readFileSync(join(root, "native", "nn-launcher", "src", "desk.rs"), "utf8");
  const win = readFileSync(join(root, "native", "nn-launcher", "src", "win.rs"), "utf8");
  const rules = readFileSync(join(root, "native", "nn-launcher", "src", "deskrules.rs"), "utf8");
  const priv = readFileSync(join(root, "native", "nn-launcher", "src", "privdesk.rs"), "utf8");
  const winobj = readFileSync(join(root, "native", "nn-launcher", "src", "winobj.rs"), "utf8");
  const prepare = desk.slice(desk.indexOf("pub(crate) fn prepare"), desk.indexOf("pub(crate) fn finish"));
  // the guards come before the first grant, and a failed grant stops before anything is created
  const guard = prepare.indexOf("deskrules::may_change_launcher_objects(&station, flags)");
  const sidCheck = prepare.indexOf("crate::winobj::is_profile_sid(&sid_string(self.sid))");
  const firstGrant = prepare.indexOf("self.grant(");
  assert.ok(sidCheck > 0 && guard > sidCheck && firstGrant > guard, "SID check, then the station check, then the grants");
  assert.ok(prepare.indexOf("if self.failed.is_some() { return; }") > firstGrant && prepare.indexOf("if self.failed.is_some() { return; }") < prepare.indexOf("CreateDesktopW"));
  // a NULL DACL is never merged into, and the copy is taken before the entry is added
  // (add_entry, write_dacl and acl_copy moved to privdesk.rs, which both builds compile, with the same text)
  const add = priv.slice(priv.indexOf("pub(crate) fn add_entry"), priv.indexOf("/// 64 random bits"));
  assert.match(add, /let old = acl_copy\(h\)\?\.ok_or\(ERR_NULL_DACL\)\?;\n\s+let new = winobj::with_allow_entry\(old\.bytes\(\), &sid, mask\)\.ok_or\(ERR_BAD_ACL\)\?;\n\s+write_dacl\(h, &new\)/);
  const grant = desk.slice(desk.indexOf("fn grant("), desk.indexOf("pub(crate) fn prepare"));
  assert.ok(grant.indexOf("acl_copy(h)") > 0 && grant.indexOf("acl_copy(h)") < grant.indexOf("add_entry(h"));
  assert.match(grant, /Ok\(None\) => t\.error = Some\(ERR_NULL_DACL\)/);
  // second review: the window objects' DACLs are rebuilt by the tested rules only (every other entry kept byte for byte and in order), never by SetEntriesInAclW, and written in ONE
  // place (write_dacl: an aligned copy, IsValidAcl first, DACL_SECURITY_INFORMATION alone)
  assert.ok(!/SetEntriesInAclW\s*\(|EXPLICIT_ACCESS_W|GRANT_ACCESS/.test(desk), "no SetEntriesInAclW on window objects");
  assert.equal((desk.match(/SetSecurityInfo\(/g) ?? []).length + (priv.match(/SetSecurityInfo\(/g) ?? []).length, 1, "one write of a window object's DACL, in privdesk.rs");
  assert.ok(!/SetEntriesInAclW\s*\(|EXPLICIT_ACCESS_W|GRANT_ACCESS/.test(priv), "no SetEntriesInAclW in privdesk.rs");
  const write = priv.slice(priv.indexOf("pub(crate) fn write_dacl"), priv.indexOf("pub(crate) fn add_entry"));
  assert.ok(write.indexOf("IsValidAcl(p) == 0") > 0 && write.indexOf("IsValidAcl(p) == 0") < write.indexOf("SetSecurityInfo("));
  assert.match(write, /SetSecurityInfo\(h, SE_WINDOW_OBJECT, DACL_SECURITY_INFORMATION, null_mut\(\), null_mut\(\), p, null_mut\(\)\)/);
  const remove = desk.slice(desk.indexOf("fn remove_entries"), desk.indexOf("struct AclCopy"));
  assert.ok(remove.indexOf("if removed == 0 { return Ok(()); }") > 0 && remove.indexOf("if removed == 0 { return Ok(()); }") < remove.indexOf("write_dacl("), "nothing to remove, nothing written");
  assert.match(remove, /let Some\(old\) = acl_copy\(h\)\? else \{ return Ok\(\(\)\) \};/);
  // after the revoke: compared with the copy and reported, never written back
  const finish = desk.slice(desk.indexOf("pub(crate) fn finish"), desk.indexOf("pub(crate) fn all_reverted"));
  assert.ok(!/SetSecurityInfo|write_dacl|add_entry/.test(finish), "the copy taken before the grant is never written back");
  assert.match(finish, /t\.matches = Some\(cmp == AclCompare::Same\);/);
  assert.match(desk, /t\.created \|\| t\.original\.is_none\(\) \|\| \(t\.revoked && t\.left == 0 && t\.matches == Some\(true\)\)/);
  // the station switch for a made desktop is undone at once and checked; a failure stops the run
  const create = prepare.slice(prepare.indexOf("Create::Station =>"));
  assert.ok(create.indexOf("SetProcessWindowStation(hs as HWINSTA)") < create.indexOf("SetProcessWindowStation(original)") && create.indexOf("SetProcessWindowStation(original)") < create.indexOf("add_entry(hd"));
  assert.match(create, /let back = !switched \|\| unsafe \{ SetProcessWindowStation\(original\) \} != 0;/);
  assert.match(create, /window objects: the launcher could not switch back/);
  // desktop-revoke: derived SID (no CreateAppContainerProfile), only a profile SID
  const revokeCmd = win.slice(win.indexOf('"desktop-revoke" => {'), win.indexOf('"revoke" => {'));
  assert.match(revokeCmd, /desk::derived_sid\(&a\.name\)/);
  assert.ok(!revokeCmd.includes("container_sid("));
  assert.match(desk, /fn derived_sid[^]*?DeriveAppContainerSidFromAppContainerName/);
  assert.ok(!desk.includes("CreateAppContainerProfile"));
  const revoke = desk.slice(desk.indexOf("pub(crate) fn revoke_current"));
  assert.ok(revoke.indexOf("crate::winobj::is_profile_sid") < revoke.indexOf("open_station"));
  // second review: desktop-revoke applies the grant's station rule too: on an interactive or unreadable station it only counts (READ_CONTROL) and writes nothing
  const guardAt = revoke.indexOf("deskrules::may_change_launcher_objects(&sname,");
  assert.ok(guardAt > 0 && guardAt < revoke.indexOf("READ_CONTROL_BIT | WRITE_DAC_BIT") && guardAt < revoke.indexOf("remove_entries("));
  const skipped = revoke.slice(guardAt, revoke.indexOf("return ok;\n    }"));
  assert.ok(!/WRITE_DAC|remove_entries|write_dacl/.test(skipped), "the refused branch opens for reading only and writes nothing");
  for (const t of ["fn the_entry_is_added_without_changing_any_other_entry_and_removing_it_gives_back_the_same_entries", "fn nothing_is_added_to_a_malformed_list_or_next_to_an_entry_already_there", "fn the_removal_takes_out_only_explicit_entries_for_exactly_this_sid"]) assert.ok(rules.includes(t), t);
  // the rules themselves have Rust unit tests that run on every platform
  for (const t of ["fn only_a_non_interactive_station_whose_flags_were_read_may_be_changed", "fn only_the_sid_of_one_profile_is_accepted", "fn the_dacl_after_the_revoke_is_compared_entry_by_entry_with_the_one_before"]) assert.ok(rules.includes(t), t);
  assert.match(rules, /if station\.eq_ignore_ascii_case\("winsta0"\)/);
  assert.match(rules, /if flags & WSF_VISIBLE != 0/);
  assert.match(winobj, /parts\.len\(\) == 7/);
});

test("round 5 review: the own-runner clean-up runs desktop-revoke for the experiment's container with the re-hashed launcher, before the profiles are removed", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  const code = wf.replace(/^\s*#.*$/gm, "");
  const own = code.slice(code.indexOf("  own-runner:"));
  const clean = own.slice(own.indexOf("Remove the container profiles this job made"), own.indexOf("actions/upload-artifact@"));
  const hash = clean.indexOf('if [ "$got" != "$EXPECT_EXPERIMENT" ]; then');
  const revoke = clean.indexOf('"$exe" desktop-revoke --name NimbleNewtExperiment');
  assert.ok(hash > 0 && revoke > hash && revoke < clean.indexOf("delete-profile"));
  assert.equal((clean.match(/"\$exe" desktop-revoke/g) ?? []).length, 1);
  assert.match(clean, /^Remove[^\n]*\n\s+shell: bash\n\s+if: \$\{\{ always\(\) && steps\.verify\.outcome == 'success' \}\}/);
});

test("the reproducibility step builds the product launcher a second time from another folder with the same flags, reports through pe-diff and never fails the job", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  const at = hosted.indexOf("id: repro_product");
  assert.ok(at > 0 && at > hosted.indexOf("id: build_product") && at < hosted.indexOf("id: stage"), "after the product build, before staging");
  const step = hosted.slice(hosted.lastIndexOf("\n      - name:", at) + 1, hosted.indexOf("\n      # Card A03b slice 3: the administrator installer", at));
  // a report, not a gate: always runs, ends 0, has the second guard, is bounded in time, uses no secret
  assert.match(step, /\n\s+if: always\(\)\n/);
  assert.match(step, /\n\s+continue-on-error: true\n/);
  assert.match(step, /\n\s+timeout-minutes: \d+\n/);
  assert.match(step, /\n\s+set \+e\n/);
  assert.ok(step.trimEnd().endsWith("exit 0"), "the last command ends the step with 0");
  assert.ok(!/\bexit [1-9]/.test(step.replace(/^\s*#.*$/gm, "")), "no path ends the step with a failure");
  assert.ok(step.includes("::warning::reproducibility result: DIFFERENT") && step.includes("reproducibility result: identical"));
  // the second build: another folder with another name outside the checkout, its own target folder, the same toolchain pin, `--locked`, the same flags with the remap naming the second folder
  assert.match(step, /second_root="\$RUNNER_TEMP\/repro-second"; second_dir="\$second_root\/a-different-folder-name-for-the-second-build"/);
  assert.ok(step.includes("tar -c --exclude=./target ."), "the first build's target folder is not copied");
  assert.match(step, /RUSTFLAGS="--remap-path-prefix=\$crate2_w=\/nn-launcher --remap-path-prefix=\$cargo_w=\/cargo -C link-arg=\/Brepro" cargo build --release --locked/);
  const first = hosted.slice(hosted.indexOf("id: build_product"), at);
  assert.match(first, /RUSTFLAGS="--remap-path-prefix=\$crate_w=\/nn-launcher --remap-path-prefix=\$cargo_w=\/cargo -C link-arg=\/Brepro" cargo build --release --locked/);
  assert.ok(!/CARGO_TARGET_DIR|--target-dir/.test(step), "the second build's target folder is the default one inside its own copy");
  assert.ok(!/cargo build[^\n]*--features/.test(step), "no feature in the second build either");
  assert.match(step, /crate2_w="\$\(cygpath -w "\$second_dir"\)"/);
  // the comparison and its artifacts: machine-readable report, both files, commit and the three build folder names looked for
  assert.match(step, /node scripts\/pe-diff\.mjs "\$out\/nn-launcher\.first\.exe" "\$out\/nn-launcher\.second\.exe" --json "\$out\/nn-launcher\.repro\.json" --commit "\$GITHUB_SHA"/);
  for (const n of ["firstCrateFolder=", "secondCrateFolder=", "cargoHome="]) assert.ok(step.includes(`--needle "${n}`), n);
  assert.ok(step.includes('out="$RUNNER_TEMP/appc-out/repro"'), "under appc-out, which the hosted artifact uploads");
  assert.ok(hosted.includes("path: ${{ runner.temp }}/appc-out"));
  // nothing else moved: pins, permissions and the first build's own steps stay
  assert.match(wf, /^permissions:\n {2}contents: read/m);
  assert.ok(!/^ {4}permissions:/m.test(wf));
  assert.ok(!/secrets\./.test(step));
  assert.ok(!/uses: [^\n@]+@(?![0-9a-f]{40}\b)/.test(wf), "every action is pinned to a commit");
  assert.ok(step.indexOf("cargo build") < step.indexOf("pe-diff.mjs"));
  const rel = readFileSync(join(root, "native", "nn-launcher", "RELEASE.md"), "utf8");
  assert.ok(rel.includes("Is the build reproducible?") && /Reproducibility is NOT claimed beyond the one measurement/.test(rel), "RELEASE.md states what is measured and that nothing more is claimed");
  assert.ok(rel.includes("nn-launcher.signed.record.json") && rel.includes("unsigned"), "RELEASE.md says how the signed file and the unsigned hash relate");
});

test("A03b what-if repair: the hosted installer step runs both shells with the real launcher path and the installer has no Get-FileHash", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  const at = hosted.indexOf("id: installer_whatif");
  assert.ok(at > hosted.indexOf("id: build_product") && at < hosted.indexOf("id: stage"), "after the product build, before staging");
  const step = hosted.slice(at, hosted.indexOf("G05 containment cases through the native backend"));
  for (const part of ["'powershell.exe'", "'pwsh'", "-File $f @scriptArgs", "'-LauncherPath'", "'-ExpectedSha256', $h", "'-AllowUnsigned', '-WhatIf'", "PropertyNotFound", "Assert-Untouched"]) assert.ok(step.includes(part), part);
  assert.ok(!/continue-on-error/.test(step), "the check is a gate");
  const ps = readFileSync(join(root, "native", "install", "Install-NimbleNewtLauncher.ps1"), "utf8");
  assert.ok(!ps.includes("Get-FileHash") && ps.includes("function Get-Sha256Hex") && ps.includes("function Invoke-Read"));
  assert.ok(!/(^|\n)\s+permissions:/.test(step) && !/uses:/.test(step), "pins and permissions are not touched by this step");
});

test("A03b Verify-with-a-real-account: the hosted job makes a throw-away marked user, runs Verify against it, refuses anywhere but a GitHub-hosted runner, and always removes the user", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  const own = wf.slice(wf.indexOf("  own-runner:"));
  const from = hosted.indexOf("id: installer_verify_account");
  assert.ok(from > hosted.indexOf("id: installer_whatif") && from < hosted.indexOf("id: stage"), "after the dry-run step, before staging");
  const next = hosted.indexOf("\n      # The programs the own-runner job runs", from);
  const step = hosted.slice(hosted.lastIndexOf("\n      - name:", from) + 1, next);
  const text = step.replace(/^\s*#.*$/gm, "");
  assert.match(step, /shell: powershell\n/, "Windows PowerShell 5.1");
  assert.match(step, /\n\s+if: always\(\)\n/);
  assert.ok(!/continue-on-error/.test(step) && !/uses:/.test(step) && !/permissions:/.test(step), "a gate; pins and permissions untouched");
  // the hosted-only guard comes before anything is made
  const guard = text.indexOf("$env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'");
  assert.ok(guard >= 0 && guard < text.indexOf("New-LocalUser") && text.slice(guard, guard + 300).includes("exit 1"), "refuses unless GITHUB_ACTIONS is 'true' and the runner is github-hosted");
  // a random name, a random password that is never printed, the installer's own marker, the owner's real flags
  assert.ok(text.includes("'nnprobe' +") && text.includes("RandomNumberGenerator]::Create()") && text.includes("GetBytes($pick)"));
  assert.ok(text.includes("-Description $marker") && text.includes("$AccountMarker = '"), "the marker is read from the installer itself");
  assert.ok(text.includes("-PasswordNeverExpires"));
  assert.ok(!/Write-(Output|Host)[^\n]*(\$secure|\$pw\b|Password)/i.test(text) && !/\$pw\b[^\n]*\|\s*Out-|ConvertFrom-SecureString|-AsPlainText/.test(text), "the password is never printed or converted to text");
  // runs Verify under 5.1 against that account, and checks what a crash would have hidden
  assert.ok(text.includes("-Action Verify -AccountName $name"));
  for (const part of ["PropertyNotFound", "cannot be found on this object", "PASS  the account exists", "PASS  it is the account this script made", "password expires: never", "RESULT:"]) assert.ok(text.includes(part), part);
  // cleanup in finally, by the exact name, and a check that it is gone; Uninstall is not run
  const fin = text.slice(text.indexOf("} finally {"));
  assert.ok(fin.includes("Remove-LocalUser -Name $name") && fin.includes("is still there") && /Get-LocalUser -Name \$name/.test(fin), "removal by exact name, then a check it is gone");
  assert.ok(!/Remove-LocalUser[^\n]*[*?]/.test(text) && !/'Uninstall'|Action Uninstall|-Action Install/.test(text));
  assert.ok(text.indexOf("New-LocalUser") < text.indexOf("} finally {") && text.indexOf("try {") < text.indexOf("New-LocalUser"), "the user is made inside the try whose finally removes it");
  // never on the own runner
  assert.ok(!/installer_verify_account|New-LocalUser|nnprobe/.test(own), "the own-runner job never makes a user");
});

test("A03b real Install/Verify/Uninstall step: hosted only, after the staging, never in the own-runner job, removal only by the generated exact name", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  const own = wf.slice(wf.indexOf("  own-runner:"));
  const at = hosted.indexOf("id: installer_real\n");
  assert.ok(at > hosted.indexOf("id: stage") && at > hosted.indexOf("name: windows-appcontainer-launchers"), "after the staging and the launchers upload: a failure cannot stop them");
  assert.ok(hosted.indexOf("id: installer_real_cleanup") > at && hosted.indexOf("name: windows-appcontainer-hosted") > hosted.indexOf("id: installer_real_cleanup"));
  const step = hosted.slice(hosted.lastIndexOf("\n      - name:", at), hosted.indexOf("id: installer_real_cleanup")).replace(/^\s*#.*$/gm, "");
  const guard = step.indexOf("$env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'");
  assert.ok(guard > 0 && guard < step.indexOf("Run-Installer '") && guard < step.indexOf("New-Item"), "the guard comes before any change");
  assert.ok(/\n\s+if: always\(\)\n/.test(step) && !/continue-on-error/.test(step), "a gate that always runs");
  assert.ok(step.includes("'nnprobe' + $tag") && step.includes("-Confirm:`$false") && step.includes("Uninstall left") && step.includes("} finally {"));
  assert.deepEqual([...step.matchAll(/Remove-LocalUser[^\n]*/g)].map((m) => m[0].replace(/[\s}]+$/, "")), ["Remove-LocalUser -Name $name"], "the user is removed only by its exact generated name");
  assert.ok(!/installer_real|nn-real-|nnprobe/.test(own), "never in the own-runner job");
  assert.ok(wf.includes("permissions:\n  contents: read\n"), "permissions unchanged");
});

// ------------------------------------------------------------------------------------------------ the home case (one account, not elevated)

const homeLine = (o) => JSON.stringify({ tool: "nn-appc-launcher", probe: "home", ...o });
const uiReport = { tool: "nn-appc-launcher", probe: "ui-test", user32Loaded: true, windowStation: "WinSta0", desktop: "nn-home-1-2", windowsSeen: 0, windowsSeenVisible: 0, openClipboardOk: false, lowLevelKeyboardHookInstalled: false, globalAtomAdded: false, screenPixelReadable: false, ok: true };
const runLine = (step, group, works, extra = {}) => homeLine({ step, group, program: step.split("-").slice(1).join("-"), ok: true, works, childExitCode: works ? 0 : -1073741502, childStdout: step.endsWith("ui-test") ? JSON.stringify(uiReport) : "", ...extra });
const fixture = (verdicts) => [
  homeLine({ step: "context", ok: true, elevated: false, elevationType: "limited", adminGroup: "deny-only", integrity: "medium", sessionId: 1, osBuild: 26200, windowStation: "WinSta0", interactiveStation: true, desktop: "Default" }),
  homeLine({ step: "station-access", ok: true, station: { name: "WinSta0", openWithWriteDac: false, openWithCreateDesktop: true, owner: "S-1-5-18", allApplicationPackagesAllow: ["0x20002"] } }),
  homeLine({ step: "profile", ok: true, profileDeleted: true, profileGone: true }),
  ...Object.entries(verdicts).flatMap(([group, works]) => works === null ? [homeLine({ step: `${group}-ui-test`, group, skipped: true, reason: "skipped: x", ok: true })] : [runLine(`${group}-ui-test`, group, works), runLine(`${group}-node`, group, works), runLine(`${group}-cmd`, group, true)]),
  homeLine({ step: "summary", ok: true, stationEntryLeftBehind: false }),
].join("\nstray line\n");

test("home.mjs: the strongest working option is chosen in the documented order, and a skipped or missing group is not a pass", () => {
  assert.deepEqual(HOME_OPTIONS.map((o) => o.group), ["desktop", "station-read", "station-full", "inherit"]);
  const lines = parseHomeLines(fixture({ inherit: true, desktop: true, "station-read": null }));
  assert.equal(lines.length, 11, "3 single steps, 3 + 3 lines for the two groups, 1 skipped line, the summary; the stray text is ignored");
  const j = judgeHome(lines);
  assert.deepEqual(j.verdicts, { desktop: "works", "station-read": "skipped", "station-full": "not-run", inherit: "works" });
  assert.equal(j.strongestWorking, "desktop");
  assert.equal(judgeHome(parseHomeLines(fixture({ inherit: true, desktop: false }))).strongestWorking, "inherit");
  assert.equal(judgeHome(parseHomeLines(fixture({ inherit: false, desktop: false }))).strongestWorking, null);
  assert.equal(judgeHome(parseHomeLines(fixture({ desktop: false, "station-read": true }))).strongestWorking, "station-read");
  // cmd alone does not decide: a group whose cmd works and whose user32 program fails FAILS
  assert.equal(groupVerdict(parseHomeLines(fixture({ desktop: false })), "desktop"), "fails");
  assert.equal(groupVerdict([], "desktop"), "not-run");
});

test("home.mjs: the report states the facts, the options and the limits of one run, and shows what the confined program saw", () => {
  const md = renderHomeMarkdown(parseHomeLines(fixture({ inherit: true, desktop: true })), "lpac");
  assert.match(md, /### Home case: lpac/);
  assert.match(md, /Administrators group deny-only, integrity medium/);
  assert.match(md, /CANNOT open it with WRITE_DAC \(an open only; nothing was written\)/);
  assert.match(md, /ALL APPLICATION PACKAGES holds allow entries on the station: 0x20002/);
  assert.match(md, /\| a private desktop on the user's own window station, no entry written to the station \| no \| works \|/);
  assert.match(md, /Strongest option that worked here: \*\*desktop\*\*\. This is one machine, one build and one run; it is not a general finding\./);
  assert.match(md, /What the confined `ui-test` program saw/);
  assert.match(renderHomeMarkdown([], ""), /No probe line was found/);
  assert.match(renderHomeMarkdown(parseHomeLines(fixture({ desktop: false, inherit: false }))), /No option worked here: the launcher would fail closed/);
  const left = renderHomeMarkdown(parseHomeLines(fixture({ desktop: true }).replace('"stationEntryLeftBehind":false', '"stationEntryLeftBehind":true')));
  assert.match(left, /An entry for a throw-away container was left on the window station/);
  assert.equal(childReport({ childStdout: "not json" }), null);
  assert.equal(childReport({ childStdout: JSON.stringify({ probe: "other" }) }), null);
});

test("home.mjs: the command line summarizes a file and refuses anything else", () => {
  const dir = tmp();
  writeFileSync(join(dir, "h.jsonl"), fixture({ desktop: true, inherit: true }));
  const ok = spawnSync(process.execPath, [join(exp, "home.mjs"), "summarize", join(dir, "h.jsonl"), "--label", "x"], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /### Home case: x/);
  assert.equal(spawnSync(process.execPath, [join(exp, "home.mjs"), "nope"], { encoding: "utf8" }).status, 2);
});

test("the home case (source): experiment only, one temporary station entry and only to the interactive station, no input sent, no window made, every call documented", () => {
  const read = (f) => readFileSync(join(root, "native", "nn-launcher", "src", f), "utf8");
  const win = read("win.rs"), home = read("home.rs"), rules = read("homerules.rs"), desk = read("desk.rs"), lib = read("lib.rs"), args = read("args.rs"), priv = read("privdesk.rs");
  const readme = readFileSync(join(exp, "README.md"), "utf8");
  // not in the product: the module is gated, the rules module is gated, the commands are refused by the product's command list
  assert.match(win, /#\[cfg\(feature = "experiment"\)\]\n#\[path = "home\.rs"\]\nmod home;/);
  assert.match(lib, /#\[cfg\(any\(test, feature = "experiment"\)\)\]\nmod homerules;/);
  assert.ok(args.includes('"--steps" | "--force-station-entry" if !EXPERIMENT => return Err('));
  for (const c of ["ui-test", "deelevate"]) assert.match(win, new RegExp(`Some\\("${c}"\\)`));
  assert.match(win, /"home-revoke" => \{/);
  assert.match(win, /if a\.command == "home-probe" \{ std::process::exit\(home::home_probe\(&a\)\); \}/);
  // the only write to a shared object is the entry on the station, guarded by the interactive-station rule, removed by Drop and read back
  assert.match(desk, /crate::homerules::may_write_interactive_station\(station, flags\)/);
  assert.match(desk, /if let Some\(mask\) = crate::homerules::home_station_mask\(mode\)/);
  assert.match(desk, /impl Drop for Desk \{ fn drop\(&mut self\) \{ self\.finish\(\); \} \}/);
  assert.match(home, /desk::remove_entries\(h, sid\)/);
  assert.match(rules, /name == "WinSta0"|eq_ignore_ascii_case\("winsta0"\)/);
  assert.ok(rules.includes("flags & 1 == 0"), "the visible flag is required");
  assert.ok(home.includes("ATTEMPT {id}: a temporary entry") && home.includes("home-revoke --name {name}"), "the name and the clean-up command are printed before the entry is written");
  // the desktop is created with its final access list (no write afterwards) and read back with the product's own allow-list check
  assert.match(desk, /creation_sd\(&own\[0\], &sid_b, crate::winobj::DESKTOP_RIGHTS, crate::winobj::DESKTOP_FULL, "desktop"\)/);
  assert.match(desk, /crate::winobj::private_acl_ok\(c\.bytes\(\), &sid_b, crate::winobj::DESKTOP_RIGHTS, &own\)/);
  // nothing is sent, nothing is shown, nothing persistent is touched
  for (const banned of ["SendInput", "SendMessage", "PostMessage", "keybd_event", "mouse_event", "CreateWindow", "MessageBox", "GetClipboardData", "SetClipboardData", "EmptyClipboard", "GetWindowText", "SwitchDesktop", "SetThreadDesktop", "ChangeDisplaySettings", "SystemParametersInfo", "ExitWindows", "RegSetValue", "RegCreateKey", "CreateService", "LogonUser", "NetUserAdd", "NetUserSetInfo", "password"]) {
    assert.ok(!new RegExp(banned, "i").test(home.replace(/^\s*\/\/.*$/gm, "")), `${banned} in home.rs`);
  }
  // the product build gains no behaviour: the four items of privdesk.rs that became pub(crate), nothing else
  const diffTokens = [...priv.matchAll(/pub\(crate\) (fn own_principals|struct CreationSd|fn attributes|fn creation_sd)/g)].length;
  assert.equal(diffTokens, 4);
  // every Win32 call of this round is documented in the README
  for (const c of ["CreateRestrictedToken", "SetTokenInformation", "CreateProcessAsUserW", "EnumWindows", "IsWindowVisible", "GetForegroundWindow", "GetCursorPos", "OpenClipboard", "CloseClipboard", "GetClipboardSequenceNumber", "GetDC", "GetPixel", "ReleaseDC", "GetAsyncKeyState", "SetWindowsHookExW", "UnhookWindowsHookEx", "CallNextHookEx", "GetModuleHandleW", "GlobalAddAtomW", "GlobalDeleteAtom", "CreateDesktopW"]) {
    assert.ok(home.includes(c) || desk.includes(c), `${c} not used`);
    assert.ok(readme.includes(c), `${c} missing in the README`);
  }
  // one process-creation call per family, as before: the product's CreateProcessW is the only one in win.rs; the de-elevated child is the only CreateProcessAsUserW
  assert.equal(win.match(/CreateProcessW\(/g).length, 1);
  assert.equal(home.match(/CreateProcessAsUserW\(/g).length, 1);
  // the restricted token: privileges removed, groups deny-only, integrity medium, no restricting SIDs, no password
  assert.ok(home.includes("CreateRestrictedToken(tok.0, DISABLE_MAX_PRIVILEGE, disable.len() as u32,") && home.includes("MEDIUM_INTEGRITY_RID") && home.includes("hr::is_admin_like"));
});

test("the home case (documents): the measurement is recorded as measured, the constraints are written down, the card is not flipped, and the commands are exact", () => {
  const plan = readFileSync(join(root, "docs", "nimblenewt", "windows-isolation-plan.md"), "utf8");
  const s = plan.slice(plan.indexOf("### 12.5 The common home case"), plan.indexOf("## 13. What we would tell users"));
  assert.ok(s.length > 5000);
  for (const fact of ["Windows 11 Pro build 26200", "PowerShell 5.1", "`elevated:false`", "`sessionId:1`", "`windowStationOk:false`", "error 5", "`profileDeleted:true`", "`profileGone:true`", "`profileDeleteHr:0`", "Access is denied"]) assert.ok(s.includes(fact), fact);
  assert.ok(s.includes("**What is NOT measured.**") && s.includes("The standard-account question"));
  assert.ok(/NO route may set, store or pass a password/.test(s) && s.includes("nobody does that on windows"));
  assert.ok(s.includes("The A03b card is NOT flipped") && s.includes("fail closed") || s.includes("Fail closed stays"));
  assert.ok(s.includes("**Recommended default for the non-elevated user: option 1"));
  assert.ok(s.includes("Never fall back silently to option 3"));
  for (const part of ["private DESKTOP", "WINSTA_CREATEDESKTOP", "JOB_OBJECT_UILIMIT_READCLIPBOARD", "Documented versus measured", "What must be measured", "ALL APPLICATION PACKAGES"]) assert.ok(s.includes(part), part);
  // the one-account fact and the password veto are in the design constraints of section 2 too
  assert.match(plan, /\*\*Design constraints \(the owner's, 2026-11-25; details in 12\.5\)\.\*\* The normal Windows PC has ONE account/);
  // no password route is built or proposed anywhere in this slice's text or code
  const exp = join(root, "experiments", "windows-appcontainer");
  const readme = readFileSync(join(exp, "README.md"), "utf8").split("## The home case")[1];
  assert.ok(readme.includes(".\\nn-appc-launcher.exe home-probe --steps context,station-access,profile | Out-File -Encoding utf8 home-readonly.jsonl"));
  assert.ok(readme.includes(".\\nn-appc-launcher.exe home-probe --aap-policy optout --timeout-ms 20000 | Out-File -Encoding utf8 home-lpac.jsonl"));
  assert.ok(readme.includes(".\\nn-appc-launcher.exe home-probe --aap-policy none   --timeout-ms 20000 | Out-File -Encoding utf8 home-plain.jsonl"));
  assert.ok(readme.includes(".\\nn-appc-launcher.exe home-revoke --name NimbleNewtRun-<16 hex from the ATTEMPT line>"));
  assert.ok(readme.includes('NOT "Run as administrator"') || readme.includes('a NORMAL PowerShell, not "Run as administrator"'));
  assert.ok(!/(set|store|pass) a password|temporary password|Set-LocalUser|net user/i.test(readme.replace(/It does not write a password anywhere and creates no account\./, "")));
  const notes = readFileSync(join(root, "docs", "nimblenewt", "implementation-plan", "implementation-notes.md"), "utf8");
  const n = notes.slice(notes.indexOf("### A03b: the common home case, one account and not elevated"));
  assert.ok(n.includes("card NOT flipped") && n.includes("`profileGone:true`") && n.includes("NOT done / unknown until Windows runs it") && n.includes("ASSUMPTION:"));
  const nl = readFileSync(join(root, "native", "nn-launcher", "README.md"), "utf8");
  assert.ok(nl.includes("## The common home case: one account, not elevated") && nl.includes("This product build contains none of that code and refuses those commands."));
  const contributing = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
  for (const f of ["native/nn-launcher/src/home.rs", "native/nn-launcher/src/homerules.rs"]) assert.ok(contributing.includes(f), f);
  const planText = JSON.parse(readFileSync(join(root, "docs", "nimblenewt", "implementation-plan", "task-plan.json"), "utf8"));
  const card = (planText.cards ?? planText.tasks ?? []).find?.((c) => c.id === "A03b");
  if (card) assert.notEqual(card.status, "done", "A03b is not flipped by this slice");
});

test("the home case (workflow): a report step in the hosted job, never in the own-runner job, with the cross-check and no gate", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  const own = wf.slice(wf.indexOf("  own-runner:"));
  const from = hosted.indexOf('- name: "Home case: one account, not elevated');
  assert.ok(from > hosted.indexOf("id: build_product") && from < hosted.indexOf("id: installer_whatif"), "after the product build (it needs the product launcher), before the installer steps");
  const step = hosted.slice(from, hosted.indexOf("\n      # Card A03b", from + 10) > 0 ? hosted.indexOf("\n      # ", from + 10) : undefined);
  assert.match(step, /shell: bash\n\s+if: always\(\)\n\s+continue-on-error: true\n\s+timeout-minutes: 20\n/);
  for (const piece of ["home-probe --timeout-ms 20000", "run_home elevated-lpac", "run_home deelevated-lpac deelevate --aap-policy optout", "run_home deelevated-plain deelevate --aap-policy none", 'deelevate --exe "$(cygpath -w "$prod")" info --name "$home_name"', "home.mjs summarize", "scripts/redact-log.mjs"]) assert.ok(step.includes(piece), piece);
  assert.ok(!/uses:|permissions:|secrets\./.test(step));
  assert.ok(!own.includes("home-probe") && !own.includes("deelevate"), "the owner's runner is never given the de-elevation helper");
  assert.equal(hosted.split("run_home elevated-lpac").length, 2, "one home-case step");
});

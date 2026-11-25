// Tests for experiments/windows-appcontainer: the harness's pure logic and its flow with a FAKE launcher. They run on Linux (and everywhere else); the real
// launcher and the real AppContainer only exist on Windows, so what they do is judged by the Windows run, not here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyError, isEntryPoint, isolatedStuck, runProbes, spawnIsolated, summarize, REPORT_PREFIX } from "../experiments/windows-appcontainer/probe.mjs";
import {
  ALL_PROBE_IDS, CASE_IDS, aclReadBack, grantedPaths, PROBE_NODE_OPTIONS, SECRETS, stderrHead, adminNeeded, buildChildEnv, buildCommandLine, buildFixturePlan, buildLauncherArgs, buildProbeConfig, buildReport, collectWitness,
  REBUILT_LABEL, chooseProbeReport, createFixtures, extractProbeReport, judgeCell, judgeProbe, makeTarball, matrixCells, parseLauncherLine, pickOutboundHost, quoteWindowsArg, removeTree, renderMarkdown,
  scrubText, selectCells, tally, validateReport, witnessProblem,
} from "../experiments/windows-appcontainer/lib.mjs";
import { discoverTools, parseCli, runExperiment } from "../experiments/windows-appcontainer/run-experiment.mjs";
import {
  LADDER_STEPS, LPAC_COM, MAX_TIMEOUTS_PER_VARIANT, STEP_TIMEOUT_MS, WELL_KNOWN_CAPABILITY_SIDS, buildStepArgs, firewallCommands, judgeFirewall, judgeStep, ladderEnv, ladderPlan, ladderVariants,
  launcherLeft, clientCommand, renderFirewallMarkdown, renderLadderMarkdown, runFirewall, runLadder, selectVariants, stepExecutable, summarizeVariant, validateLadder,
} from "../experiments/windows-appcontainer/ladder.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exp = join(root, "experiments", "windows-appcontainer");
const tmp = () => mkdtempSync(join(os.tmpdir(), "nnac-"));

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
  const src = readFileSync(join(exp, "launcher", "src", "win.rs"), "utf8");
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
  assert.ok(readFileSync(join(exp, "launcher", "Cargo.toml"), "utf8").includes('"Win32_System_Diagnostics_ToolHelp"'));
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
  assert.match(wf, /if: \$\{\{ inputs\.own_runner == true/);
  assert.match(wf, /runs-on: \[self-hosted, nimblenewt-windows\]/);
  assert.equal([...wf.matchAll(/timeout-minutes: 45/g)].length >= 1, true);
  assert.ok(wf.includes("scripts/redact-log.mjs"));
  // Both run steps keep the harness's exit code through the redaction pipe and still write the summary.
  // six hosted steps (round 4: spawn first; cases, npm, links, timing, firewall) and two own-runner steps (cases, spawn); each keeps the harness's exit code and writes its summary
  assert.equal([...wf.matchAll(/run-experiment\.mjs --out "\$RUNNER_TEMP\/appc-out"[^|\n]*2>&1 \| node scripts\/redact-log\.mjs \|\| rc=\$\?\n.*GITHUB_STEP_SUMMARY.*\n\s+exit "\$rc"/g)].length, 8);
  for (const mode of ["spawn", "npm", "cases", "links", "timing", "firewall"]) assert.match(wf, new RegExp(`--mode ${mode} --timeout-ms (15000|45000|90000|120000)`));
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
    const r = await runFirewall({ launcherPath: "fake", exec: fake.exec, ps: fake.ps, tmpBase: base, tools, outbound: { host: "127.0.0.2", local: true }, systemRoot: "C:\\Windows", randomHex: () => "0a1b2c3d", settleMs: 20, clients: ["curl"] });
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
    const r = await runFirewall({ launcherPath: "fake", exec: fake.exec, ps: fake.ps, tmpBase: base, tools, outbound: { host: "127.0.0.2", local: true }, systemRoot: "C:\\Windows", randomHex: () => "0a1b2c3d", settleMs: 20, clients: ["curl"] });
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
    await assert.rejects(runFirewall({ launcherPath: "fake", exec: fake.exec, ps: fake.ps, tmpBase: base, tools, outbound: { host: "127.0.0.2", local: true }, systemRoot: "C:\\Windows", randomHex: () => "0a1b2c3d", settleMs: 20, clients: ["curl"],
      log: (m) => { if (/inside-with-rule/.test(m) && fake.state.rule) throw new Error("boom"); } }), /boom/);
    assert.equal(fake.state.rule, false);
    assert.ok(fake.state.removeCalls >= 1);
    assert.deepEqual(readdirSync(base), []);
  } finally { removeTree(base); }
});

test("firewall run: a rule that leaks (the container still connects) is a failure, and a container that cannot be made starts nothing", async () => {
  const base = tmp();
  try {
    const fake = firewallFake();
    const leaky = (p, a) => { const keep = fake.state.rule; if (a[0] === "run") fake.state.rule = false; try { return fake.exec(p, a); } finally { fake.state.rule = keep; } };
    const r = await runFirewall({ launcherPath: "fake", exec: leaky, ps: fake.ps, tmpBase: base, tools, outbound: { host: "127.0.0.2", local: true }, systemRoot: "C:\\Windows", randomHex: () => "0a1b2c3d", settleMs: 20, clients: ["curl"] });
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
  assert.deepEqual(MODES, ["matrix", "cases", "ladder", "git", "npm", "links", "timing", "firewall", "spawn"]);
  for (const m of ["cases", "git", "npm", "links", "timing", "spawn"]) assert.equal(parseCli(["--mode", m]).mode, m);
  assert.equal(parseCli([]).variantSpec, undefined);
  // round 2 ran this experiment WITHOUT the capabilities because "all" was passed on and the first variant (no capability) was taken
  for (const spec of [undefined, "all"]) {
    const base = tmp();
    const fake = firewallFake();
    const runs = [];
    try {
      const exec = (p, a) => { if (a[0] === "run") runs.push(a); return fake.exec(p, a); };
      const r = await runFirewall({ launcherPath: "fake", exec, ps: fake.ps, tmpBase: base, tools, variantSpec: spec, outbound: { host: "127.0.0.2", local: true }, settleMs: 20, systemRoot: "C:\\Windows", clients: ["node"] });
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
    const r = await runFirewall({ launcherPath: "fake", exec, ps: fake.ps, tmpBase: base, tools, outbound: { host: "127.0.0.2", local: true }, settleMs: 20, systemRoot: "C:\\Windows", clients: ["node"] });
    assert.equal(r.report.verdict, "inconclusive");
    assert.match(r.report.why, /did not apply the capabilities/);
  } finally { removeTree(base); }
});

test("the workflow has one step per mode, each after the first with if: always(), 90 s cells, a 75 minute hosted limit and no secrets", () => {
  const wf = readFileSync(join(root, ".github", "workflows", "windows-appcontainer-experiment.yml"), "utf8");
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  assert.match(hosted, /timeout-minutes: 75/);
  const steps = hosted.split(/\n {6}- /).filter((x) => /run-experiment\.mjs/.test(x));
  assert.deepEqual(steps.map((x) => x.match(/--mode (\w+)/)[1]), ["spawn", "cases", "npm", "links", "timing", "firewall"]);
  steps.forEach((st, i) => assert.equal(/\n\s+if: always\(\)/.test(st), i > 0, `step ${i}`));
  assert.match(steps[1], /--mode cases --timeout-ms 90000/);
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
  const src = readFileSync(join(exp, "launcher", "src", "win.rs"), "utf8");
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
  const cargo = readFileSync(join(exp, "launcher", "Cargo.toml"), "utf8");
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
  const src = readFileSync(join(exp, "launcher", "src", "win.rs"), "utf8");
  const readme = readFileSync(join(exp, "README.md"), "utf8");
  assert.match(src, /fn open_test\(\) -> String/);
  assert.match(src, /raw\.get\(1\)\.map\(String::as_str\) == Some\("open-test"\)/);
  for (const needle of ["FILE_SHARE_DELETE", "_wopen(", "_close(", "_errno()", "\\\\\\\\.\\\\NUL", "O_RDWR"]) assert.ok(src.includes(needle), needle);
  assert.match(src, /"--stdout-nul-rw" => a\.stdout_nul = true/);
  assert.match(src, /"--stderr-nul-rw" => a\.stderr_nul = true/);
  for (const doc of ["open-test", "_wopen", "--stdout-nul-rw", "FILE_SHARE_DELETE"]) assert.ok(readme.includes(doc), `README: ${doc}`);
  assert.ok(!/^\s*\[dependencies\][\s\S]*(libc|winapi)\s*=/m.test(readFileSync(join(exp, "launcher", "Cargo.toml"), "utf8")), "no new crate");
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
    const r = await runFirewall({ launcherPath: "fake", exec: fake.exec, ps, tmpBase: base, tools, outbound: { host: "127.0.0.2", local: true }, systemRoot: "C:\\Windows", randomHex: () => "0a1b2c3d", settleMs: 20, clients: ["curl"], exemptByName: true, profileName: "NimbleNewtExperiment" });
    assert.deepEqual(r.report.phases.map((p) => p.phase), ["control-before-rule", "inside-without-rule", "inside-with-name-exemption", "inside-with-rule", "control-with-rule", "inside-after-removal"]);
    assert.equal(r.report.exemption.confirmed, true);
    assert.equal(r.report.exemption.removed, true);
    assert.equal(r.report.exemption.loopbackReached, false, "the fake container's loopback stays closed");
    assert.equal(r.report.cleanup.exemptionRemoved, true);
    assert.match(r.markdown, /Loopback exemption added by name/);
    assert.equal(ex.on, false);
    assert.equal(r.report.assumptions.length, 3);
    // a throw while the exemption exists: removed in the finally path
    await assert.rejects(runFirewall({ launcherPath: "fake", exec: fake.exec, ps, tmpBase: base, tools, outbound: { host: "127.0.0.2", local: true }, systemRoot: "C:\\Windows", randomHex: () => "0a1b2c3d", settleMs: 20, clients: ["curl"], exemptByName: true, profileName: "NimbleNewtExperiment",
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
  const src = readFileSync(join(exp, "launcher", "src", "win.rs"), "utf8");
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

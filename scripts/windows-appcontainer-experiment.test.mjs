// Tests for experiments/windows-appcontainer: the harness's pure logic and its flow with a FAKE launcher. They run on Linux (and everywhere else); the real
// launcher and the real AppContainer only exist on Windows, so what they do is judged by the Windows run, not here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyError, isEntryPoint, runProbes, summarize, REPORT_PREFIX } from "../experiments/windows-appcontainer/probe.mjs";
import {
  ALL_PROBE_IDS, CASE_IDS, aclReadBack, grantedPaths, PROBE_NODE_OPTIONS, SECRETS, stderrHead, adminNeeded, buildChildEnv, buildCommandLine, buildFixturePlan, buildLauncherArgs, buildProbeConfig, buildReport, collectWitness,
  createFixtures, extractProbeReport, judgeCell, judgeProbe, makeTarball, matrixCells, parseLauncherLine, pickOutboundHost, quoteWindowsArg, removeTree, renderMarkdown,
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
  for (const key of Object.keys(process.env)) if (!["PATH", "HOME", "TMPDIR", "TEMP", "TMP"].includes(key.toUpperCase())) assert.ok(!(key in env) || ["SystemRoot", "windir", "ComSpec", "PATHEXT"].includes(key) || key.startsWith("npm_config_") || key.startsWith("GIT_"), `leaked ${key}`);
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
    const r = spawnSync("tar", ["-tzf", f], { encoding: "utf8" });
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
  assert.deepEqual(tally(results), { pass: 0, weak: 0, fail: 0, inconclusive: ALL_PROBE_IDS.length });
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
  // three hosted steps (ladder, firewall, matrix) and the own-runner step; each keeps the harness's exit code and writes its summary
  assert.equal([...wf.matchAll(/run-experiment\.mjs --out "\$RUNNER_TEMP\/appc-out"[^|\n]*2>&1 \| node scripts\/redact-log\.mjs \|\| rc=\$\?\n.*GITHUB_STEP_SUMMARY.*\n\s+exit "\$rc"/g)].length, 4);
  for (const mode of ["ladder", "firewall", "matrix"]) assert.match(wf, new RegExp(`--mode ${mode} --timeout-ms (45000|60000)`));
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
    return line({ ok: true, childStarted: true, childExitCode: 0, timedOut: false, leftoverProcesses: 0, elapsedMs: 9, allGrantsRevoked: true, grants: [] });
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

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
  ALL_PROBE_IDS, CASE_IDS, PROBE_NODE_OPTIONS, SECRETS, stderrHead, adminNeeded, buildChildEnv, buildCommandLine, buildFixturePlan, buildLauncherArgs, buildProbeConfig, buildReport, collectWitness,
  createFixtures, extractProbeReport, judgeCell, judgeProbe, makeTarball, matrixCells, parseLauncherLine, pickOutboundHost, quoteWindowsArg, removeTree, renderMarkdown,
  scrubText, selectCells, tally, validateReport, witnessProblem,
} from "../experiments/windows-appcontainer/lib.mjs";
import { discoverTools, parseCli, runExperiment } from "../experiments/windows-appcontainer/run-experiment.mjs";

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
    assert.deepEqual(calls, ["info", "run", "run", "delete-profile"]);
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
    "CreateProcessW", "WaitForSingleObject", "GetExitCodeProcess", "CreateFileW", "OpenProcessToken", "GetTokenInformation", "ProcessIdToSessionId", "CloseHandle", "FreeSid", "LocalFree", "GetAce", "EqualSid"];
  for (const c of calls) { assert.ok(src.includes(`${c}(`), `${c} not used in win.rs`); assert.ok(readme.includes(c), `${c} missing in README`); }
  for (const banned of ["CreateProcessAsUser", "CreateProcessWithLogon", "CreateProcessWithToken", "LogonUser", "ShellExecute", "ImpersonateLoggedOnUser", "WinExec"]) assert.ok(!src.includes(banned), banned);
  // the process is created in one place only, with the container attributes
  assert.equal(src.match(/CreateProcessW\(/g).length, 1);
  assert.ok(src.includes("ATTR_SECURITY_CAPABILITIES") && src.includes("ATTR_JOB_LIST"));
  assert.ok(src.includes('"container"') && src.includes('Err(e) => return fail(j, "container"'));
  // A revoke is read back (an entry still there is an error, never "revoked"); a revoke with nothing to remove writes nothing.
  assert.match(src, /if revoke \{ match explicit_count\(path, sid\) \{ Ok\(0\) => \{\} Ok\(_\) => return Err\(ERR_STILL_PRESENT\)/);
  assert.match(src, /if revoke && explicit_aces\(old, sid\) == 0 \{ LocalFree\(sd as \*mut c_void\); return Ok\(\(\)\); \}/);
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
  assert.equal([...wf.matchAll(/run-experiment\.mjs --out "\$RUNNER_TEMP\/appc-out" 2>&1 \| node scripts\/redact-log\.mjs \|\| rc=\$\?\n.*GITHUB_STEP_SUMMARY.*\n\s+exit "\$rc"/g)].length, 2);
  assert.ok(!/secrets\./.test(wf));
  assert.ok(wf.includes("actions/upload-artifact@"));
  assert.ok(CASE_IDS.length === 10);
});

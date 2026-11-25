import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "node:test";
import { REQUIRED_CASE_IDS, runContainmentSuite } from "./containment.js";
import {
  CONFIG_FILE, RUNNER_FILE, WINDOWS_CASES, WINDOWS_CASE_RUNNER, confinedWitness, freeProof, judgeWindowsCase, parseRunnerResults, runWindowsNodeCases,
  type FreeRun, type HostProbe, type LaunchOutcome, type NodeSuiteContext, type NodeSuiteFixture, type RunnerAttempt, type RunnerCaseResult, type WindowsCaseConfig,
} from "./containment-windows-cases.js";
import type { LaunchRequest, SandboxLauncher } from "./launcher.js";

const onWindows = process.platform === "win32";
const kind = (id: string) => WINDOWS_CASES.find((c) => c.id === id)!;
const att = (name: string, outcome: RunnerAttempt["outcome"], extra: Partial<RunnerAttempt> = {}): RunnerAttempt => ({ name, outcome, ...extra });
const res = (id: string, ...attempts: RunnerAttempt[]): RunnerCaseResult => ({ id, attempts });
const freeOk = (id: string, ...names: string[]): FreeRun => ({ result: res(id, ...names.map((n) => att(n, "allowed"))), proofMissing: undefined });

describe("A03b slice 2: the verdict of one Windows case (pure)", () => {
  test("the list is the ten required cases, each once", () => {
    assert.deepEqual(WINDOWS_CASES.map((c) => c.id).sort(), [...REQUIRED_CASE_IDS].sort());
  });

  test("a control passes only when every attempt was allowed and the host agrees; anything else fails or is inconclusive", () => {
    const k = kind("control-write-own-directories");
    const none: FreeRun = { result: "unavailable", proofMissing: undefined };
    assert.equal(judgeWindowsCase(k, res(k.id, att("a", "allowed"), att("b", "allowed")), none, undefined).verdict, "pass");
    assert.equal(judgeWindowsCase(k, res(k.id, att("a", "allowed"), att("b", "denied", { code: "EACCES" })), none, undefined).verdict, "fail");
    assert.equal(judgeWindowsCase(k, res(k.id, att("a", "allowed")), none, "the agent could not write its own directories").verdict, "fail");
    assert.equal(judgeWindowsCase(k, undefined, none, undefined).verdict, "inconclusive");
    assert.equal(judgeWindowsCase(k, res(k.id), none, undefined).verdict, "inconclusive");
  });

  test("a denial passes only when nothing got through, the host agrees, every attempt was refused for an access reason and the same attempt worked unconfined", () => {
    const k = kind("deny-credential-read");
    const free = freeOk(k.id, "file", "list");
    const held = judgeWindowsCase(k, res(k.id, att("file", "denied"), att("list", "denied")), free, undefined);
    assert.equal(held.verdict, "pass");
    assert.match(held.detail, /got through without the sandbox/);
    assert.equal(judgeWindowsCase(k, res(k.id, att("file", "denied"), att("list", "allowed")), free, undefined).verdict, "fail");
    assert.equal(judgeWindowsCase(k, res(k.id, att("file", "denied"), att("list", "denied")), free, "a host file was changed").verdict, "fail");
    // a refusal for a reason that is not access (the file is missing, a typo, the wrong error) shows nothing
    for (const o of ["missing", "error", "blocked", "skipped"] as const) assert.equal(judgeWindowsCase(k, res(k.id, att("file", "denied"), att("list", o)), free, undefined).verdict, "inconclusive", o);
    assert.equal(judgeWindowsCase(k, undefined, free, undefined).verdict, "inconclusive");
    assert.equal(judgeWindowsCase(k, res(k.id), free, undefined).verdict, "inconclusive");
  });

  test("the pairing: with no unconfined run, an unfinished one, an attempt that did not get through there, or a missing host effect, a refusal proves nothing (inconclusive, never a pass)", () => {
    const k = kind("deny-write-host-path");
    const confined = res(k.id, att("outside-file", "denied"), att("outside-dir0", "denied"));
    assert.equal(judgeWindowsCase(k, confined, { result: "unavailable", proofMissing: undefined }, undefined).verdict, "inconclusive");
    assert.equal(judgeWindowsCase(k, confined, { result: undefined, proofMissing: undefined }, undefined).verdict, "inconclusive");
    assert.equal(judgeWindowsCase(k, confined, { result: res(k.id), proofMissing: undefined }, undefined).verdict, "inconclusive");
    for (const o of ["denied", "missing", "error", "skipped"] as const) assert.equal(judgeWindowsCase(k, confined, { result: res(k.id, att("outside-file", "allowed"), att("outside-dir0", o)), proofMissing: undefined }, undefined).verdict, "inconclusive", o);
    assert.equal(judgeWindowsCase(k, confined, { ...freeOk(k.id, "outside-file", "outside-dir0"), proofMissing: "the outside file was not changed" }, undefined).verdict, "inconclusive");
    assert.equal(judgeWindowsCase(k, confined, freeOk(k.id, "outside-file", "outside-dir0"), undefined).verdict, "pass");
  });

  test("the system folders are not paired; a skippable step is ignored only when it was skipped", () => {
    const sys = kind("deny-write-system");
    assert.equal(judgeWindowsCase(sys, res(sys.id, att("system0", "denied"), att("system1", "denied")), { result: "unavailable", proofMissing: undefined }, undefined).verdict, "pass");
    const p = kind("deny-write-protected-name");
    const free = freeOk(p.id, "edit", "create", "delete");
    const confined = (junction: RunnerAttempt) => res(p.id, att("edit", "denied"), att("create", "denied"), att("delete", "denied"), att("replace-move-away", "denied"), junction);
    assert.equal(judgeWindowsCase(p, confined(att("replace-with-junction", "skipped", { code: "previous-step-refused", skippable: true })), free, undefined).verdict, "pass");
    // the same step skipped but not marked skippable is a probe that did not run
    assert.equal(judgeWindowsCase(p, confined(att("replace-with-junction", "skipped", { code: "x" })), free, undefined).verdict, "inconclusive");
    // a skippable step that got through is a leak
    assert.equal(judgeWindowsCase(p, confined(att("replace-with-junction", "allowed", { skippable: true })), free, undefined).verdict, "fail");
    // unconfined, the skippable step may have been skipped or allowed
    assert.equal(judgeWindowsCase(p, confined(att("replace-with-junction", "skipped", { skippable: true })), { result: res(p.id, att("edit", "allowed"), att("replace-with-junction", "skipped", { skippable: true })), proofMissing: undefined }, undefined).verdict, "pass");
  });

  test("the network case: a failed connection of any kind counts as a refusal, but a connection that was made fails and an unexpected error is inconclusive; other cases do not accept `blocked`", () => {
    const k = kind("deny-network-loopback");
    const free = freeOk(k.id, "loopback");
    for (const code of ["TIMEOUT", "ECONNREFUSED", "ENETUNREACH"]) assert.equal(judgeWindowsCase(k, res(k.id, att("loopback", "blocked", { code })), free, undefined).verdict, "pass", code);
    assert.equal(judgeWindowsCase(k, res(k.id, att("loopback", "denied", { code: "EACCES" })), free, undefined).verdict, "pass");
    assert.equal(judgeWindowsCase(k, res(k.id, att("loopback", "allowed")), free, undefined).verdict, "fail");
    assert.equal(judgeWindowsCase(k, res(k.id, att("loopback", "blocked", { code: "TIMEOUT" })), free, "the host service received a connection from the confined program").verdict, "fail");
    assert.equal(judgeWindowsCase(k, res(k.id, att("loopback", "error", { code: "ERR_SOCKET_BAD_PORT" })), free, undefined).verdict, "inconclusive");
    const other = kind("deny-credential-read");
    assert.equal(judgeWindowsCase(other, res(other.id, att("file", "blocked")), freeOk(other.id, "file"), undefined).verdict, "inconclusive");
  });
});

describe("A03b slice 2: the result file is read as data", () => {
  const ids = REQUIRED_CASE_IDS;
  test("bounded, shape-checked, damaged and unknown lines skipped, text made printable, the last line for a case wins", () => {
    const good = JSON.stringify({ id: "deny-credential-read", attempts: [{ name: "file", outcome: "denied", code: "EACCES" }] });
    const parsed = parseRunnerResults([good, "{broken", JSON.stringify({ id: "unknown-case", attempts: [] }), JSON.stringify({ id: "deny-credential-read", attempts: [{ name: "x", outcome: "maybe" }] }), "", JSON.stringify({ id: "control-read-own-decoy", attempts: [{ name: "d‮", outcome: "allowed", code: "A B\n" }] })].join("\n"), ids);
    assert.deepEqual([...parsed.keys()].sort(), ["control-read-own-decoy", "deny-credential-read"]);
    assert.equal(parsed.get("deny-credential-read")!.attempts[0]!.outcome, "denied");
    const printable = parsed.get("control-read-own-decoy")!.attempts[0]!;
    assert.doesNotMatch(`${printable.name}${printable.code}`, /[‮\n ]/);
    const twice = parseRunnerResults([JSON.stringify({ id: "deny-credential-read", attempts: [{ name: "a", outcome: "allowed" }] }), good].join("\n"), ids);
    assert.equal(twice.get("deny-credential-read")!.attempts[0]!.outcome, "denied");
    assert.equal(parseRunnerResults(`${good}\n${" ".repeat(300 * 1024)}`, ids).size, 0, "a file over the bound is not read");
    assert.equal(parseRunnerResults(JSON.stringify({ id: "deny-credential-read", attempts: new Array(40).fill({ name: "a", outcome: "denied" }) }), ids).size, 0);
  });
});

/** A host that answers from a table, so the witnesses can be tested without files. */
function fakeProbe(files: Record<string, string | undefined>, folders: string[], connections = 0): HostProbe {
  return { exists: (p) => p in files && files[p] !== undefined, readText: (p) => files[p], isRealFolder: (p) => folders.includes(p), connections: () => connections };
}
const CFG: WindowsCaseConfig = {
  resultFile: "/r", workspace: "/w", home: "/h", scratch: "/s", decoy: { path: "/w/decoy", content: "d" }, systemPaths: ["/sys/a", "/sys/b"],
  hostWrite: { file: "/o/victim", dirs: ["/o", "/c", "/k"], created: "made" }, links: { read: [], write: [{ name: "link-dir", kind: "dir", path: "/w/link-dir", planted: true }] },
  credential: { file: "/k/key", secret: "s", dir: "/k", entry: "key" }, controller: { file: "/c/db", secret: "s", dir: "/c", entry: "db" },
  network: { host: "127.0.0.1", port: 1, timeoutMs: 100 }, protectedName: { dir: "/w/.git", config: "/w/.git/config", hook: "/w/.git/hook", scratchTarget: "/s" },
};
const ORIG = { outside: "OUT", git: "GIT" };

describe("A03b slice 2: the host's witnesses (fake host)", () => {
  test("confined: each thing that must not happen is named when the host shows it", () => {
    const clean = { "/o/victim": "OUT", "/w/.git/config": "GIT", "/w/c-work": "x", "/h/c-home": "x", "/s/c-scratch": "x" };
    const folders = ["/w/.git"];
    const w = (id: string, files: Record<string, string | undefined>, f = folders, now = 0) => confinedWitness(id, CFG, ORIG, fakeProbe(files, f, now), 0);
    assert.equal(w("control-write-own-directories", clean), undefined);
    assert.match(w("control-write-own-directories", { ...clean, "/h/c-home": undefined })!, /could not write its own/);
    assert.equal(w("deny-write-system", clean), undefined);
    assert.match(w("deny-write-system", { ...clean, "/sys/b": "x" })!, /system directory/);
    assert.equal(w("deny-write-host-path", clean), undefined);
    assert.match(w("deny-write-host-path", { ...clean, "/o/victim": "overwritten" })!, /changed/);
    assert.match(w("deny-write-host-path", { ...clean, "/k/made": "x" })!, /created/);
    assert.equal(w("deny-symlink-write", clean), undefined);
    assert.match(w("deny-symlink-write", { ...clean, "/w/link-dir/g05-via-link": "x" })!, /through a link/);
    assert.match(w("deny-symlink-write", { ...clean, "/o/victim": undefined })!, /through a link/);
    assert.equal(w("deny-network-loopback", clean), undefined);
    assert.match(w("deny-network-loopback", clean, folders, 1)!, /received a connection/);
    assert.equal(w("deny-write-protected-name", clean), undefined);
    assert.match(w("deny-write-protected-name", { ...clean, "/w/.git/config": "changed" })!, /protected name/);
    assert.match(w("deny-write-protected-name", { ...clean, "/w/.git/hook": "x" })!, /protected name/);
    assert.match(w("deny-write-protected-name", clean, [])!, /protected folder itself/);
    assert.match(w("deny-write-protected-name", { ...clean, "/w/.git-renamed": "x" })!, /protected folder itself/);
    assert.match(w("deny-write-protected-name", { ...clean, "/w/.git-away": "x" })!, /protected folder itself/);
    assert.equal(w("deny-credential-read", clean), undefined);
  });

  test("unconfined: the host must show the effect of what got through, else the pairing proves nothing", () => {
    const p = (id: string, files: Record<string, string | undefined>, now = 0) => freeProof(id, CFG, ORIG, fakeProbe(files, [], now), 0);
    const done = { "/o/victim": "overwritten", "/o/made": "x", "/c/made": "x", "/k/made": "x", "/w/link-dir/g05-via-link": "x" };
    for (const id of ["deny-write-host-path", "deny-symlink-write", "deny-write-protected-name"]) assert.equal(p(id, done), undefined, id);
    assert.match(p("deny-write-host-path", { ...done, "/o/victim": "OUT" })!, /not changed/);
    assert.ok(p("deny-write-host-path", { ...done, "/c/made": undefined }) !== undefined);
    assert.match(p("deny-symlink-write", { ...done, "/w/link-dir/g05-via-link": undefined })!, /directory link/);
    assert.match(p("deny-write-protected-name", { ...done, "/w/.git": "still here" })!, /not deleted/);
    assert.equal(p("deny-network-loopback", done, 1), undefined);
    assert.match(p("deny-network-loopback", done, 0)!, /saw no connection/);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the real runner, with a simulated container

/**
 * A stand-in container for the tests on any OS: a preload that makes the runner's file and network calls fail the way the container's do (EACCES outside the task's own folders, the protected folder read-only, the
 * loopback refused). It is only the denial; the runner and the verdict logic are the real ones. The real container is the hosted Windows run.
 */
const CONTAINER_SIM = String.raw`import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { EventEmitter } from "node:events";
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const real = (p) => { try { return fs.realpathSync(p); } catch { try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return path.resolve(p); } } };
const inside = (p, d) => p === d || p.startsWith(d + path.sep);
const roots = [cfg.workspace, cfg.home, cfg.scratch].map(real);
const git = real(cfg.protectedName.dir);
const tools = real(path.dirname(process.argv[2]));
const allowed = (p, write) => { const r = real(String(p)); if (inside(r, git)) return !write; if (roots.some((d) => inside(r, d))) return true; if (inside(r, tools)) return !write; return false; };
const deny = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
const guard = (name, writes, pick) => { const f = fs[name]; fs[name] = (...a) => { for (const p of pick(a)) if (!allowed(p, writes)) throw deny(); return f(...a); }; };
guard("writeFileSync", true, (a) => [a[0]]);
guard("appendFileSync", true, (a) => [a[0]]);
guard("readFileSync", false, (a) => [a[0]]);
guard("readdirSync", false, (a) => [a[0]]);
guard("renameSync", true, (a) => [a[0], a[1]]);
guard("rmSync", true, (a) => [a[0]]);
guard("symlinkSync", true, (a) => [a[1]]);
net.connect = () => { const e = new EventEmitter(); e.destroy = () => {}; setImmediate(() => e.emit("error", Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }))); return e; };
`;

interface Rig {
  readonly root: string;
  readonly ctx: (options?: { confine?: boolean; free?: boolean; mutate?: (cfg: WindowsCaseConfig) => WindowsCaseConfig }) => NodeSuiteContext;
  readonly fixture: NodeSuiteFixture & { close(): Promise<void> };
  readonly systemDir: string;
  readonly launches: { mode: string; command: string[]; readOnly: { host: string; guest: string }[]; env: Readonly<Record<string, string>>; protectedSubpaths: readonly string[] }[];
}

function run(file: string, args: string[], timeoutMs = 60_000): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = ""; let stderr = ""; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { stderr += String(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ timedOut, exitCode: code, stdout, stderr }); });
  });
}

async function rig(): Promise<Rig> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-a03b2-")));
  const dir = (name: string): string => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };
  const controllerDir = dir("controller-data"); const controllerFile = join(controllerDir, "controller.db");
  const home = dir("service-home"); mkdirSync(join(home, ".ssh")); const credentialFile = join(home, ".ssh", "id_g05_fixture");
  const outsideDir = dir("outside"); const outsideFile = join(outsideDir, "victim.txt");
  const systemDir = dir("system");
  const planted: [string, string, string][] = [[outsideDir, outsideFile, "OUTSIDE"], [controllerDir, controllerFile, "CONTROLLER-SECRET"], [join(home, ".ssh"), credentialFile, "KEY-SECRET"]];
  const reset = (): void => {
    for (const [d, keep, content] of planted) {
      for (const name of readdirSync(d)) if (join(d, name) !== keep) rmSync(join(d, name), { recursive: true, force: true });
      rmSync(keep, { force: true }); writeFileSync(keep, content);
    }
  };
  reset();
  let count = 0;
  const server: Server = createServer((s) => { count += 1; s.on("error", () => undefined); s.end("x"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const fixture = { root, controllerDir, controllerFile, home, credentialFile, outsideDir, outsideFile, port, connections: () => count, reset, close: async () => { await new Promise<void>((r) => server.close(() => r())); rmSync(root, { recursive: true, force: true }); } };
  const sim = join(root, "container-sim.mjs");
  writeFileSync(sim, CONTAINER_SIM);
  const launches: Rig["launches"] = [];
  const ctx: Rig["ctx"] = (options = {}) => ({
    fixture, secrets: { controller: "CONTROLLER-SECRET", key: "KEY-SECRET", outside: "OUTSIDE", git: "GIT-ORIGINAL", decoy: "OWN-DECOY" },
    nodeGuestPath: `/opt/node/${basename(process.execPath)}`, nodeHostFolder: dirname(process.execPath), hostNode: process.execPath,
    systemPaths: [join(systemDir, "g05-x")], canRunFree: options.free !== false, windows: onWindows, settle: () => new Promise((r) => setTimeout(r, 20)),
    launch: async (mode, recipe, command) => {
      launches.push({ mode, command: [...command], readOnly: recipe.readOnly.map((m) => ({ ...m })), env: { ...recipe.env }, protectedSubpaths: [...recipe.protectedSubpaths] });
      const [, runner, cfgFile] = command as [string, string, string];
      if (options.mutate !== undefined) writeFileSync(cfgFile, JSON.stringify(options.mutate(JSON.parse(readFileSync(cfgFile, "utf8")) as WindowsCaseConfig)));
      const preload = mode === "sandboxed" && options.confine !== false ? ["--import", pathToFileURL(sim).href] : [];
      return run(process.execPath, [...preload, runner, cfgFile]);
    },
  });
  return { root, ctx, fixture, systemDir, launches };
}

const verdicts = (r: { id: string; verdict: string }[]): Record<string, string> => Object.fromEntries(r.map((c) => [c.id, c.verdict]));
const allPass = Object.fromEntries(REQUIRED_CASE_IDS.map((id) => [id, "pass"]));

describe("A03b slice 2: the node runner and the host's verdicts, with a simulated container (any POSIX OS)", () => {
  test("every case holds: the ten cases pass, each denial was paired with an unconfined run, one confined launch carries them all", async (t) => {
    if (onWindows) return t.skip("the simulated container is POSIX-shaped; the real Windows run is the hosted job");
    const r = await rig();
    try {
      const out = await runWindowsNodeCases(r.ctx());
      assert.deepEqual(verdicts(out), allPass, JSON.stringify(out));
      for (const c of out) if (c.id.startsWith("deny-") && c.id !== "deny-write-system") assert.match(c.detail, /got through without the sandbox/, c.id);
      assert.equal(r.launches.length, 2);
      const [free, confined] = r.launches as [Rig["launches"][number], Rig["launches"][number]];
      assert.equal(free.mode, "trusted-host");
      assert.equal(confined.mode, "sandboxed");
      // the confined command: the node program as the sandbox sees it, then the runner and its config by host path (the native container sees host paths), from a read-only input
      assert.equal(confined.command[0], `/opt/node/${basename(process.execPath)}`);
      assert.equal(basename(confined.command[1]!), RUNNER_FILE);
      assert.equal(basename(confined.command[2]!), CONFIG_FILE);
      assert.deepEqual(confined.readOnly, [{ host: dirname(confined.command[1]!), guest: "/inputs/g05" }, { host: dirname(process.execPath), guest: "/opt/node" }]);
      assert.deepEqual(confined.env, {}, "no environment the launcher sets itself is passed");
      assert.deepEqual(confined.protectedSubpaths, [".git"]);
      assert.deepEqual(free.readOnly, []);
      // the runner is plain JavaScript that starts nothing: no child program, no cmd.exe, no pipe
      assert.doesNotMatch(WINDOWS_CASE_RUNNER, /child_process|spawn|exec\(|cmd\.exe|createReadStream|process\.stdin/);
    } finally { await r.fixture.close(); }
  });

  test("with no confinement at all every denial fails and the controls still pass: the cases can fail", async (t) => {
    if (onWindows) return t.skip("the simulated container is POSIX-shaped");
    const r = await rig();
    try {
      const v = verdicts(await runWindowsNodeCases(r.ctx({ confine: false })));
      assert.equal(v["control-write-own-directories"], "pass");
      assert.equal(v["control-read-own-decoy"], "pass");
      for (const id of REQUIRED_CASE_IDS.filter((x) => x.startsWith("deny-"))) assert.equal(v[id], "fail", id);
    } finally { await r.fixture.close(); }
  });

  test("a broken probe is inconclusive, never a pass: a wrong path, a wrong port, a secret that is not there", async (t) => {
    if (onWindows) return t.skip("the simulated container is POSIX-shaped");
    const r = await rig();
    try {
      const v = verdicts(await runWindowsNodeCases(r.ctx({ mutate: (c) => ({
        ...c,
        credential: { ...c.credential, file: `${c.credential.file}-typo` },
        controller: { ...c.controller, dir: `${c.controller.dir}-typo` },
        hostWrite: { ...c.hostWrite, file: `${c.hostWrite.file}-typo/x` },
        network: { ...c.network, port: 0 },
        links: { ...c.links, read: c.links.read.map((l) => (l.name === "link-rel-key" ? { ...l, planted: false } : l)) },
        protectedName: { ...c.protectedName, dir: `${c.protectedName.dir}-typo` },
      }) })));
      for (const id of ["deny-credential-read", "deny-controller-data-read", "deny-write-host-path", "deny-network-loopback", "deny-symlink-read", "deny-write-protected-name"]) assert.equal(v[id], "inconclusive", id);
      assert.equal(v["deny-symlink-write"], "pass");
      assert.equal(v["control-write-own-directories"], "pass");
    } finally { await r.fixture.close(); }
  });

  test("no way to run without the sandbox: every paired denial is inconclusive, the controls and the system case still decide", async (t) => {
    if (onWindows) return t.skip("the simulated container is POSIX-shaped");
    const r = await rig();
    try {
      const v = verdicts(await runWindowsNodeCases(r.ctx({ free: false })));
      assert.equal(r.launches.length, 1);
      for (const c of WINDOWS_CASES) assert.equal(v[c.id], c.paired ? "inconclusive" : "pass", c.id);
    } finally { await r.fixture.close(); }
  });

  test("a launch that fails, a run that times out and a run that makes no result are inconclusive with the reason", async (t) => {
    const r = await rig();
    try {
      const base = r.ctx({ free: false });
      const failing = await runWindowsNodeCases({ ...base, launch: async () => { throw new Error("the launcher could not start"); } });
      for (const c of failing) { assert.equal(c.verdict, "inconclusive", c.id); assert.match(c.detail, /could not be launched: the launcher could not start|could not be run without the sandbox/); }
      const timedOut = await runWindowsNodeCases({ ...base, launch: async (): Promise<LaunchOutcome> => ({ timedOut: true, exitCode: null, stdout: "", stderr: "" }) });
      for (const c of timedOut) { assert.equal(c.verdict, "inconclusive", c.id); }
      assert.match(timedOut.find((c) => c.id === "control-write-own-directories")!.detail, /timed out/);
      const silent = await runWindowsNodeCases({ ...base, launch: async (): Promise<LaunchOutcome> => ({ timedOut: false, exitCode: 2, stdout: "", stderr: "Access is denied" }) });
      assert.match(silent.find((c) => c.id === "control-write-own-directories")!.detail, /no result \(exit 2: Access is denied\)/);
      for (const c of silent) assert.equal(c.verdict, "inconclusive", c.id);
    } finally { await r.fixture.close(); }
  });

  test("a runner that ends part-way (the network case never answers) still gives the cases it finished", async (t) => {
    if (onWindows) return t.skip("the simulated container is POSIX-shaped");
    const r = await rig();
    try {
      const base = r.ctx();
      const out = await runWindowsNodeCases({ ...base, launch: async (mode, recipe, command) => {
        const got = await base.launch(mode, recipe, command);
        if (mode === "sandboxed") { // cut the result file after the symlink-write case, as a hang at the network case would
          const file = (JSON.parse(readFileSync(command[2]!, "utf8")) as WindowsCaseConfig).resultFile;
          const kept = readFileSync(file, "utf8").split("\n").filter((l) => l !== "" && !/deny-(network|write-protected)/.test(l));
          writeFileSync(file, `${kept.join("\n")}\n`);
        }
        return got;
      } });
      const v = verdicts(out);
      assert.equal(v["deny-credential-read"], "pass");
      assert.equal(v["deny-network-loopback"], "inconclusive");
      assert.equal(v["deny-write-protected-name"], "inconclusive");
    } finally { await r.fixture.close(); }
  });

  test("the runner itself: a link that was not planted is skipped, a read counts only when the secret was seen, and it ends with the marker", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-a03b2r-")));
    try {
      const w = join(root, "work"); const h = join(root, "home"); const s = join(root, "scratch"); const secret = join(root, "secret.txt"); const sys = join(root, "sys");
      for (const d of [w, h, s, sys, join(w, ".git")]) mkdirSync(d, { recursive: true });
      writeFileSync(join(w, "decoy.txt"), "WRONG"); writeFileSync(secret, "not-the-secret"); writeFileSync(join(w, ".git", "config"), "g");
      const cfg: WindowsCaseConfig = {
        resultFile: join(s, "out.jsonl"), workspace: w, home: h, scratch: s, decoy: { path: join(w, "decoy.txt"), content: "RIGHT" }, systemPaths: [],
        hostWrite: { file: join(root, "victim"), dirs: [], created: "m" }, links: { read: [{ name: "l", kind: "file", path: join(w, "l"), planted: false }], write: [] },
        credential: { file: secret, secret: "SECRET", dir: root, entry: "nope" }, controller: { file: secret, secret: "not-the-secret", dir: root, entry: "secret.txt" },
        network: { host: "127.0.0.1", port: 9, timeoutMs: 200 }, protectedName: { dir: join(w, ".git"), config: join(w, ".git", "config"), hook: join(w, ".git", "h"), scratchTarget: s },
      };
      writeFileSync(join(root, "c.json"), JSON.stringify(cfg)); writeFileSync(join(root, "r.mjs"), WINDOWS_CASE_RUNNER);
      const out = await run(process.execPath, [join(root, "r.mjs"), join(root, "c.json")]);
      assert.equal(out.exitCode, 0, out.stderr);
      assert.match(out.stdout, /g05-end/);
      const parsed = parseRunnerResults(readFileSync(cfg.resultFile, "utf8"), REQUIRED_CASE_IDS);
      assert.equal(parsed.size, 10);
      assert.equal(parsed.get("control-read-own-decoy")!.attempts[0]!.outcome, "error");
      assert.equal(parsed.get("control-read-own-decoy")!.attempts[0]!.code, "NOSECRET");
      assert.equal(parsed.get("deny-symlink-read")!.attempts[0]!.outcome, "skipped");
      assert.equal(parsed.get("deny-credential-read")!.attempts[0]!.outcome, "error");
      assert.equal(parsed.get("deny-controller-data-read")!.attempts.every((a) => a.outcome === "allowed"), true);
      // nothing listens on port 9: refused or timed out, never `allowed`
      assert.ok(["blocked", "denied"].includes(parsed.get("deny-network-loopback")!.attempts[0]!.outcome));
      assert.ok(existsSync(join(w, "c-work")));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("A03b slice 2: the suite entry point with the windows-node dialect (recorded launchers, any POSIX OS)", () => {
  test("runContainmentSuite reports the ten required cases through the node runner and never starts cmd.exe", async (t) => {
    if (onWindows) return t.skip("the simulated container is POSIX-shaped");
    const seen: LaunchRequest[] = [];
    const sim = mkdtempSync(join(tmpdir(), "nn-a03b2s-"));
    const simFile = join(sim, "container-sim.mjs");
    writeFileSync(simFile, CONTAINER_SIM);
    const fake = (confine: boolean): SandboxLauncher => ({
      capacity: { available: true, backend: "windows-native", checkedAt: new Date().toISOString() },
      launch: async (req: LaunchRequest) => {
        seen.push(req);
        const [, runner, cfg] = req.command as [string, string, string];
        const o = await run(process.execPath, [...(confine && req.recipe.mode === "sandboxed" ? ["--import", pathToFileURL(simFile).href] : []), runner, cfg]);
        return { result: Promise.resolve({ exitCode: o.exitCode, signal: null, timedOut: o.timedOut, killed: false, stdout: o.stdout, stderr: o.stderr, truncated: false, stdoutTruncated: false, durationMs: 1 }) };
      },
    }) as unknown as SandboxLauncher;
    const sysDir = join(sim, "sys"); mkdirSync(sysDir);
    try {
      const suite = await runContainmentSuite({ dialect: "windows-node", launcher: fake(true), unconfinedLauncher: fake(false), systemPaths: [join(sysDir, "g05-x")] });
      assert.deepEqual(Object.fromEntries(suite.cases.map((c) => [c.id, c.verdict])), allPass, JSON.stringify(suite.cases));
      const categories = Object.fromEntries(suite.cases.map((c) => [c.id, c.category]));
      assert.equal(categories["deny-network-loopback"], "network-route");
      assert.equal(categories["control-read-own-decoy"], "control");
      const caseLaunches = seen.filter((q) => basename(q.command[1] ?? "") === RUNNER_FILE);
      assert.equal(caseLaunches.length, 2);
      for (const q of seen) assert.doesNotMatch(q.command.join(" "), /cmd\.exe|case\.cmd/);
    } finally { rmSync(sim, { recursive: true, force: true }); }
  });

  test("no capacity: every case is not_run with the reason (the dialect does not change that)", async () => {
    const launcher = { capacity: { available: false, backend: "windows-native", reason: "the launcher was not found", checkedAt: new Date().toISOString() }, launch: async () => assert.fail("nothing may start") } as unknown as SandboxLauncher;
    const suite = await runContainmentSuite({ dialect: "windows-node", launcher });
    assert.deepEqual(suite.cases.map((c) => c.verdict), REQUIRED_CASE_IDS.map(() => "not_run"));
  });
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import type { BackendHealth, SandboxBackend, SpawnPlan } from "./backend.js";
import { SandboxError } from "./errors.js";
import { SandboxLauncher, type LaunchRecord } from "./launcher.js";
import type { NormalizedRecipe } from "./recipe.js";
import type { ProcessResult } from "./windows-host.js";
import { jobFile, readRecord, recordsDir, revokeAndReadBack, runNativeJob, sweepLeftovers, type NativeHost, type NativeJob, type RunRecord } from "./windows-native-job.js";
import {
  DEFAULT_JOB_LIMITS, EXIT_BUSY, EXIT_FAILED, FAILURE_PREFIX, LPAC_CAPABILITIES, NATIVE_MODE, NODE_PRESERVE_OPTIONS, REFUSED_ROUTE, checkNativeRecipe, failureKindOf, grantsFor, grantsLeft, launcherArgs, nativeEnv,
  parseLauncherLine, programPath, quoteWindowsArg, softRefusals, type NativeGrant, type NativeSettings,
} from "./windows-native-plan.js";
import { main as runnerMain, readAllStdin } from "./windows-native-runner.js";
import { isLinkOrJunctionWith, nativeRealHost, parseProcessLines } from "./windows-native-real.js";
import { PROBE_SCRIPT, unavailableNative, windowsDefaultBackend, windowsNativeBackend, type WindowsNativeOptions } from "./windows-native.js";

// These tests run on every OS with a simulated Windows host and a simulated launcher: they prove the rules (the command line, what is refused, what is recorded, what is revoked and read back on every path out)
// but NOT that an AppContainer confines anything. That is the hosted Windows run and the owner's own hardware (see the A03b notes).

const CONTROL = "C:\\ProgramData\\NimbleNewt\\native";
const LAUNCHER = "C:\\Program Files\\NimbleNewt\\nn-launcher.exe";
const RUNNER = "C:\\Program Files\\NimbleNewt\\worker\\dist\\sandbox\\windows-native-runner.js";
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const NODE_DIR = "C:\\Program Files\\nodejs";
const TASK = "C:\\Tasks\\t1";
const key = (p: string): string => p.toLowerCase();
const LOCKS = `${CONTROL}\\locks`;
/** Writes a lock holder as the next number, as a run would. */
const holdLock = (host: { files: Map<string, string>; listDir(p: string): string[] }, holder: Record<string, unknown>): void => {
  const n = Math.max(0, ...host.listDir(LOCKS).filter((x) => /^\d+$/.test(x)).map(Number)) + 1;
  host.files.set(key(`${LOCKS}\\${n}`), JSON.stringify(holder));
};
/** No run holds the slot: no number at all, or the highest one is marked released. */
const lockFree = (host: { listDir(p: string): string[]; readText(p: string): string | undefined }): boolean => {
  const ns = host.listDir(LOCKS).filter((x) => /^\d+$/.test(x)).map(Number);
  if (ns.length === 0) return true;
  return host.readText(`${LOCKS}\\${Math.max(...ns)}.released`) !== undefined;
};
const ok = (stdout = "", code = 0): ProcessResult => ({ code, stdout, stderr: "", timedOut: false });

interface Script {
  /** The run answers with a failed stage before the program starts. */
  stage?: string;
  refuse?: (path: string) => boolean;
  /** The revoke does not remove these (the launcher's own report says revoked, the read-back finds entries). */
  stubborn?: (path: string) => boolean;
  /** `check` reports this after the launcher's own revoke, though the entry was removed; a later `revoke` command removes it. */
  lingering?: (path: string) => boolean;
  noAnswer?: boolean;
  throws?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  out?: string;
  err?: string;
  /** What the "program" does with the paths it was given (the probe program). */
  onProgram?: (args: readonly string[], host: SimHost) => void | Promise<void>;
}

/** A Windows machine in memory with a launcher that behaves as the experiment's measured one does (one JSON line, grants applied and revoked, files for the standard handles). */
class SimHost implements NativeHost {
  readonly platform = "win32";
  pid = 100;
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly links = new Set<string>();
  readonly alive = new Set<number>([100]);
  readonly volumes = new Map<string, string>([["c:", "NTFS"]]);
  readonly calls: { file: string; args: string[] }[] = [];
  readonly entries = new Map<string, number>();
  readonly seenStdin: string[] = [];
  script: Script = {};
  procs: { pid: number; parent: number; started: string }[] | undefined = [];
  envVars: Record<string, string> = { SystemRoot: "C:\\Windows", windir: "C:\\Windows" };
  env(n: string): string | undefined { return this.envVars[n]; }
  pidAlive(pid: number): boolean { return this.alive.has(pid); }
  exists(p: string): boolean { return this.files.has(key(p)) || this.dirs.has(key(p)); }
  isDirectory(p: string): boolean { return this.dirs.has(key(p)); }
  isLinkOrJunction(p: string): boolean { return this.links.has(key(p)); }
  mkdirp(p: string): void { this.dirs.add(key(p)); }
  readText(p: string, max = 1024 * 1024): string | undefined { const t = this.files.get(key(p)); return t === undefined ? undefined : t.slice(0, max); }
  writeText(p: string, t: string): void { this.files.set(key(p), t); }
  createExclusive(p: string, t: string): boolean { if (this.files.has(key(p))) return false; this.files.set(key(p), t); return true; }
  listDir(p: string): string[] {
    const prefix = key(p) + "\\";
    const names = new Set<string>();
    for (const f of [...this.files.keys(), ...this.dirs]) if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split("\\")[0]!);
    return [...names];
  }
  remove(p: string): void { const k = key(p); for (const f of [...this.files.keys()]) if (f === k || f.startsWith(k + "\\")) this.files.delete(f); for (const d of [...this.dirs]) if (d === k || d.startsWith(k + "\\")) this.dirs.delete(d); }
  async fileSystemOf(p: string): Promise<string | undefined> { return this.volumes.get(key(p).slice(0, 2)); }
  async processes(): Promise<readonly { pid: number; parent: number; started: string }[] | undefined> { return this.procs; }

  async run(file: string, args: readonly string[]): Promise<ProcessResult> {
    this.calls.push({ file, args: [...args] });
    if (key(file) !== key(LAUNCHER)) return ok();
    if (this.script.throws && args[0] === "run") throw new Error("spawn failed");
    const grants = (a: readonly string[]): { mode: string; path: string; soft: boolean }[] => a.flatMap((x, i) => (x === "--grant" || x === "--grant-soft" ? [{ mode: a[i + 1]!.slice(0, a[i + 1]!.indexOf(":")), path: a[i + 1]!.slice(a[i + 1]!.indexOf(":") + 1), soft: x === "--grant-soft" }] : []));
    const line = (o: Record<string, unknown>): ProcessResult => ok(`noise\n${JSON.stringify({ tool: "nn-appc-launcher", version: 1, ...o })}\n`);
    const gl = (g: { mode: string; path: string; soft: boolean }[], extra: (p: string) => Record<string, unknown>): unknown[] => g.map((x) => ({ path: x.path, mode: x.mode, soft: x.soft, ...extra(x.path), entriesLeft: this.entries.get(key(x.path)) ?? 0 }));
    if (args[0] === "info") return line({ command: "info", ok: true, containerSid: "S-1-15-2-1", profile: "reused" });
    if (args[0] === "check") return line({ command: "check", ok: true, clean: true, grants: gl(grants(args), () => ({ applied: false, revoked: false })) });
    if (args[0] === "revoke") { for (const g of grants(args)) this.entries.set(key(g.path), this.script.stubborn?.(g.path) ? 1 : 0); return line({ command: "revoke", ok: true, grants: gl(grants(args), () => ({ applied: true, revoked: true })) }); }
    // run
    if (this.script.noAnswer) return ok("nothing useful\n", 125);
    const g = grants(args);
    const applied: { path: string; mode: string; soft: boolean; applied: boolean; revoked: boolean; errorCode?: number }[] = [];
    let failedStage: string | undefined;
    for (const spec of g) {
      if (this.script.refuse?.(spec.path)) { applied.push({ ...spec, applied: false, revoked: false, errorCode: 5 }); if (!spec.soft) { failedStage = "grant"; break; } continue; }
      this.entries.set(key(spec.path), (this.entries.get(key(spec.path)) ?? 0) + 1);
      applied.push({ ...spec, applied: true, revoked: false });
    }
    const after = (): void => {
      for (const a of applied) if (a.applied) { if (this.script.stubborn?.(a.path) || this.script.lingering?.(a.path)) { a.revoked = !this.script.stubborn?.(a.path); if (a.revoked) this.entries.set(key(a.path), 1); } else { this.entries.set(key(a.path), 0); a.revoked = true; } }
    };
    const render = (o: Record<string, unknown>): ProcessResult => { after(); return line({ command: "run", allGrantsRevoked: applied.every((a) => !a.applied || a.revoked), grants: applied.map((a) => ({ ...a, entriesLeft: this.entries.get(key(a.path)) ?? 0 })), ...o }); };
    if (failedStage === undefined && this.script.stage !== undefined) failedStage = this.script.stage;
    if (failedStage !== undefined) return render({ ok: false, childStarted: false, stage: failedStage, error: `${failedStage} failed (simulated)` });
    const val = (flag: string): string => args[args.indexOf(flag) + 1]!;
    const stdinPath = val("--stdin").replace(/^file:/, "");
    this.seenStdin.push(this.readText(stdinPath) ?? "<missing>");
    this.writeText(val("--stdout"), this.script.out ?? "");
    this.writeText(val("--stderr"), this.script.err ?? "");
    await this.script.onProgram?.(args, this);
    return render({ ok: true, childStarted: true, childExitCode: this.script.exitCode ?? 0, timedOut: this.script.timedOut === true });
  }
}

const settings = (extra: Partial<NativeSettings> = {}): NativeSettings => ({
  launcher: LAUNCHER, controlDir: CONTROL, nodeExecutable: NODE, programFolders: [NODE_DIR], systemRoot: "C:\\Windows", container: "lpac", profileName: "NimbleNewtAgent",
  memoryMb: DEFAULT_JOB_LIMITS.memoryMb, activeProcesses: DEFAULT_JOB_LIMITS.activeProcesses, maxRunMs: 60_000, ...extra,
});
const SUP = { supervisor: [RUNNER.slice(0, RUNNER.lastIndexOf("\\")), "C:\\Program Files\\NimbleNewt"] };

function recipe(extra: Partial<NormalizedRecipe> = {}): NormalizedRecipe {
  return {
    mode: "sandboxed", workdir: `${TASK}\\work`, home: `${TASK}\\home`, scratch: `${TASK}\\scratch`, readOnly: [{ host: "C:\\Tools\\inputs", guest: "/inputs/tools" }], network: "none", env: { LANG: "en" },
    protectedSubpaths: [".git"], unprotectedSubpaths: [], revision: "r1", ...extra,
  };
}

function options(host: SimHost, extra: Partial<WindowsNativeOptions> = {}): WindowsNativeOptions {
  return { host, launcher: LAUNCHER, controlDir: CONTROL, nodeExecutable: NODE, runnerScript: RUNNER, ...extra };
}

function prepared(host: SimHost, r: NormalizedRecipe = recipe(), command: readonly string[] = ["/inputs/tools/tool.exe", "a b", "c"], extra: Partial<WindowsNativeOptions> = {}): { backend: SandboxBackend; plan: SpawnPlan; job: NativeJob; jobDir: string } {
  const backend = windowsNativeBackend(options(host, extra));
  const plan = backend.plan(r, command, "run-0001-aaaa");
  const jobDir = plan.env["NIMBLENEWT_NATIVE_JOB"]!;
  return { backend, plan, job: JSON.parse(host.readText(jobFile(jobDir))!) as NativeJob, jobDir };
}

describe("A03b native launcher: the command line (pure)", () => {
  test("arguments are quoted the way the C runtime reads them back", () => {
    assert.equal(quoteWindowsArg("plain"), "plain");
    assert.equal(quoteWindowsArg(""), '""');
    assert.equal(quoteWindowsArg("a b"), '"a b"');
    assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteWindowsArg("C:\\dir with space\\"), '"C:\\dir with space\\\\"');
    assert.equal(quoteWindowsArg("a\\\\\"b c"), '"a\\\\\\\\\\"b c"');
  });

  test("the program is found through the recipe's own mounts, or /windows; anything else is refused", () => {
    const r = recipe();
    assert.equal(programPath(r, "/inputs/tools/bin/tool.exe", "C:\\Windows"), "C:\\Tools\\inputs\\bin\\tool.exe");
    assert.equal(programPath(r, "/work/run.exe", "C:\\Windows"), `${TASK}\\work\\run.exe`);
    assert.equal(programPath(r, "/windows/System32/hostname.exe", "C:\\Windows"), "C:\\Windows\\System32\\hostname.exe");
    assert.equal(programPath(r, "/inputs/tools", "C:\\Windows"), "C:\\Tools\\inputs");
    for (const bad of ["/etc/passwd", "/inputs/other/x.exe", "/work/../x", "/work/a:b", "/work/x.", "/work/~1/x", "/workx/y", "C:\\Windows\\cmd.exe"]) assert.throws(() => programPath(r, bad, "C:\\Windows"), SandboxError, bad);
  });

  test("grants: the workspace is modify-root, home and scratch modify, inputs read-and-execute, each existing protected name sealed, program folders soft", () => {
    const grants = grantsFor(recipe({ protectedSubpaths: [".git", "hooks"], unprotectedSubpaths: ["hooks"] }), settings(), SUP);
    assert.deepEqual(grants.map((g) => `${g.mode}:${g.path}:${g.soft ? "soft" : "hard"}`), [
      `modify-root:${TASK}\\work:hard`, `modify:${TASK}\\home:hard`, `modify:${TASK}\\scratch:hard`, "rx:C:\\Tools\\inputs:hard", `seal:${TASK}\\work\\.git:hard`, `rx:${NODE_DIR}:soft`,
    ]);
  });

  test("only program folders are soft; a program folder already inside a grant is skipped; one that would reach the task or the supervisor is refused", () => {
    const withMount = grantsFor(recipe({ readOnly: [{ host: NODE_DIR, guest: "/opt/node" }] }), settings(), SUP);
    assert.equal(withMount.filter((g) => g.soft).length, 0);
    assert.ok(withMount.filter((g) => !g.soft).every((g) => g.why !== "program"));
    const inside = grantsFor(recipe(), settings({ programFolders: [NODE_DIR, `${NODE_DIR}\\node_modules`] }), SUP);
    assert.deepEqual(inside.filter((g) => g.soft).map((g) => g.path), [NODE_DIR]);
    assert.throws(() => grantsFor(recipe(), settings({ programFolders: ["C:\\Tasks"] }), SUP), /contains the task folder/);
    assert.throws(() => grantsFor(recipe(), settings({ programFolders: ["C:\\ProgramData"] }), SUP), /supervisor/);
    assert.throws(() => grantsFor(recipe(), settings({ programFolders: ["C:\\"] }), SUP), /drive root/);
    assert.throws(() => grantsFor(recipe(), settings({ programFolders: ["relative"] }), SUP), /local absolute/);
  });

  test("the environment is complete and nothing is inherited: HOME, TEMP and the npm cache inside granted folders, PATH of granted folders, the preserve-symlinks options", () => {
    const env = nativeEnv(recipe(), settings());
    assert.equal(env["HOME"], `${TASK}\\home`);
    assert.equal(env["USERPROFILE"], `${TASK}\\home`);
    assert.equal(env["TEMP"], `${TASK}\\scratch`);
    assert.equal(env["npm_config_cache"], `${TASK}\\scratch\\.npm-cache`);
    assert.equal(env["NODE_OPTIONS"], NODE_PRESERVE_OPTIONS);
    assert.equal(env["PATH"], `${NODE_DIR};C:\\Tools\\inputs;C:\\Windows\\System32`);
    assert.equal(env["LANG"], "en");
    assert.deepEqual(Object.keys(env).sort(), ["APPDATA", "HOME", "LANG", "LOCALAPPDATA", "NODE_OPTIONS", "PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "windir", "npm_config_cache"].sort());
    // A recipe's own NODE_OPTIONS follows the preserve flags; it never replaces them. An input that is not a folder stays off PATH.
    assert.equal(nativeEnv(recipe({ env: { NODE_OPTIONS: "--max-old-space-size=512" } }), settings())["NODE_OPTIONS"], `${NODE_PRESERVE_OPTIONS} --max-old-space-size=512`);
    assert.ok(!nativeEnv(recipe(), settings(), () => false)["PATH"]!.includes("C:\\Tools"));
  });

  test("a recipe that names a variable the launcher sets, in any letter case, or lists one twice, is refused", () => {
    const check = (r: NormalizedRecipe): void => checkNativeRecipe(r, settings(), SUP, () => undefined, () => false);
    check(recipe());
    for (const name of ["TEMP", "temp", "Path", "userprofile", "SystemRoot", "npm_config_cache", "HOME"]) assert.throws(() => check(recipe({ env: { [name]: "x" } })), /set by the launcher/, name);
    assert.throws(() => check(recipe({ env: { Foo: "1", FOO: "2" } })), /twice/);
  });

  test("the launcher's command line: container, no network capability anywhere, job limits, files for every standard handle, grants in order", () => {
    const r = recipe();
    const grants = grantsFor(r, settings(), SUP);
    const files = { input: `${CONTROL}\\jobs\\x\\in.txt`, out: `${CONTROL}\\jobs\\x\\out.txt`, err: `${CONTROL}\\jobs\\x\\err.txt` };
    const args = launcherArgs(r, "C:\\Tools\\inputs\\tool.exe", ["a b", "c"], settings(), grants, files, nativeEnv(r, settings()));
    assert.equal(args[0], "run");
    assert.deepEqual(args.slice(1, 3), ["--name", "NimbleNewtAgent"]);
    const at = (flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));
    assert.deepEqual(at("--capability"), [...LPAC_CAPABILITIES]);
    assert.deepEqual(at("--aap-policy"), ["optout"]);
    assert.deepEqual(at("--grant-soft"), [`rx:${NODE_DIR}`]);
    assert.equal(at("--grant").length, 5);
    assert.deepEqual(at("--memory-mb"), ["4096"]);
    assert.deepEqual(at("--active-processes"), ["64"]);
    assert.ok(args.includes("--ui-limits"));
    assert.deepEqual(at("--timeout-ms"), ["60000"]);
    assert.deepEqual(at("--stdin"), [`file:${files.input}`]);
    assert.deepEqual(at("--stdout"), [files.out]);
    assert.deepEqual(at("--stderr"), [files.err]);
    assert.deepEqual(at("--cwd"), [r.workdir]);
    assert.deepEqual(at("--exe"), ["C:\\Tools\\inputs\\tool.exe"]);
    assert.deepEqual(at("--cmdline"), ['C:\\Tools\\inputs\\tool.exe "a b" c']);
    // What must never appear: the NUL device, a pipe, a network capability, a loopback exemption, the Win32k switch, the "no kill on close" switch.
    const text = args.join(" ").toLowerCase();
    for (const forbidden of ["nul", "pipe", "internetclient", "privatenetwork", "loopback", "--win32k-off", "--no-kill-on-close", "nul-rw"]) assert.ok(!text.includes(forbidden), forbidden);
    // The plain AppContainer fallback: no policy value, no capability at all.
    const plain = launcherArgs(r, "x.exe", [], settings({ container: "appcontainer" }), grants, files, {});
    assert.deepEqual(plain.filter((a, i) => plain[i - 1] === "--aap-policy"), ["none"]);
    assert.ok(!plain.includes("--capability"));
  });

  test("the launcher's JSON line is read from noisy output; a damaged or foreign line is not an answer", () => {
    const good = '{"tool":"nn-appc-launcher","ok":true,"childExitCode":3,"timedOut":false,"grants":[{"path":"C:\\\\a","mode":"modify","soft":false,"applied":true,"revoked":true,"entriesLeft":0}]}';
    const line = parseLauncherLine(`warning\n${good}\n`)!;
    assert.equal(line.ok, true);
    assert.equal(line.childExitCode, 3);
    assert.deepEqual(grantsLeft(line), []);
    assert.equal(parseLauncherLine('{"tool":"someone-else","ok":true}'), undefined);
    assert.equal(parseLauncherLine("{not json"), undefined);
    assert.equal(parseLauncherLine(""), undefined);
    const left = parseLauncherLine('{"tool":"nn-appc-launcher","ok":true,"grants":[{"path":"P","mode":"rx","soft":true,"applied":false,"revoked":false,"errorCode":5,"entriesLeft":0},{"path":"Q","mode":"modify","soft":false,"applied":true,"revoked":true,"entriesLeft":1}]}')!;
    assert.deepEqual(grantsLeft(left), ["Q"]);
    assert.deepEqual(softRefusals(left), [{ path: "P", mode: "rx", errorCode: 5 }]);
  });

  test("a launcher stage that failed has a typed reason: container, job, grant, files, start; an unknown stage is a launcher failure", () => {
    assert.deepEqual(["container", "capability", "attributes", "job", "grant", "stdio", "create-process", "wait", undefined, "novel"].map((s) => failureKindOf(s)), ["container", "container", "container", "job", "grant", "files", "start", "launcher", "launcher", "launcher"]);
  });
});

describe("A03b native launcher: the backend's plan and its refusals", () => {
  test("plan: a runner process outside the container's folders reads a job file in the control folder", () => {
    const host = new SimHost();
    const { plan, job, jobDir } = prepared(host);
    assert.equal(plan.file, NODE);
    assert.deepEqual(plan.args, [RUNNER, jobFile(jobDir)]);
    assert.equal(plan.cwd, CONTROL);
    assert.ok(jobDir.toLowerCase().startsWith(`${CONTROL.toLowerCase()}\\jobs\\`));
    assert.ok(plan.env["TEMP"]!.toLowerCase().startsWith(CONTROL.toLowerCase()));
    assert.equal(job.version, 1);
    assert.equal(job.runId, "run-0001-aaaa");
    // The runner's environment holds no recipe variable (they go to the container through the launcher's --env).
    assert.ok(!("LANG" in plan.env));
    // The container never gets the supervisor's folders, and the supervisor's files are not under any granted path.
    for (const g of job.grants) for (const guarded of [CONTROL, "C:\\Program Files\\NimbleNewt"]) assert.ok(!key(g.path).startsWith(key(guarded) + "\\") && key(g.path) !== key(guarded), `${g.path} vs ${guarded}`);
    // Planned twice with the same id (the launcher plans twice for one launch): the same folder, no second one.
    const again = windowsNativeBackend(options(host)).plan(recipe(), ["/inputs/tools/tool.exe", "a b", "c"], "run-0001-aaaa");
    assert.equal(again.env["NIMBLENEWT_NATIVE_JOB"], jobDir);
  });

  test("a recipe with a network route is refused with a typed reason, before any job file exists", () => {
    const host = new SimHost();
    const backend = windowsNativeBackend(options(host));
    assert.throws(() => backend.plan(recipe({ route: { proxyPort: 4000 } }), ["/work/a.exe"], "run-0002-aaaa"), (e: unknown) => e instanceof SandboxError && e.code === "invalid_recipe" && e.message === REFUSED_ROUTE);
    assert.equal(host.listDir(`${CONTROL}\\jobs`).length, 0);
    assert.notEqual(backend.privateNetwork, true);
    // The recipe check refuses it too (a second line of defence that does not depend on the plan's own check), and a recipe with a non-"none" network or a trusted-host mode never reaches a container.
    const check = (r: NormalizedRecipe): void => checkNativeRecipe(r, settings(), SUP, () => undefined, () => false);
    assert.throws(() => check(recipe({ route: { proxyPort: 4000 } })), (e: unknown) => e instanceof SandboxError && e.message === REFUSED_ROUTE);
    assert.throws(() => check({ ...recipe(), network: "open" } as unknown as NormalizedRecipe), /only "none"/);
    assert.throws(() => check(recipe({ mode: "trusted-host" })), /sandboxed recipes only/);
  });

  test("refused before any job file exists: another platform, the supervisor's folder in a task folder, a link, a program outside the recipe, an unsupported environment name", () => {
    const host = new SimHost();
    const backend = windowsNativeBackend(options(host));
    const refuse = (r: NormalizedRecipe, c: readonly string[], pattern: RegExp): void => assert.throws(() => backend.plan(r, c, "run-0003-aaaa"), pattern);
    refuse(recipe({ workdir: `${CONTROL}\\jobs\\x` }), ["/work/a.exe"], /overlaps the supervisor/);
    refuse(recipe({ scratch: "C:\\Program Files\\NimbleNewt\\scratch" }), ["/work/a.exe"], /overlaps the supervisor|inside/);
    refuse(recipe(), ["/etc/sh"], /the program must be under/);
    refuse(recipe({ env: { TMP: "x" } }), ["/work/a.exe"], /set by the launcher/);
    host.links.add(key(`${TASK}\\work`));
    refuse(recipe(), ["/work/a.exe"], /link or junction/);
    assert.equal(host.listDir(`${CONTROL}\\jobs`).length, 0);
    const off = new SimHost();
    (off as { platform: string }).platform = "linux";
    assert.throws(() => windowsNativeBackend(options(off)).plan(recipe(), ["/work/a.exe"], "run-0004-aaaa"), /only on Windows/);
  });

  test("configuration: an invalid container, a supervisor folder inside the probe folder, out-of-range limits are refused when the backend is made", () => {
    const host = new SimHost();
    assert.throws(() => windowsNativeBackend(options(host, { container: "vm" as never })), /lpac/);
    assert.throws(() => windowsNativeBackend(options(host, { probeDir: `${CONTROL}\\probe` })), /overlap/);
    assert.throws(() => windowsNativeBackend(options(host, { memoryMb: 1 })), /memoryMb/);
    assert.throws(() => windowsNativeBackend(options(host, { launcher: "launcher.exe" })), /local absolute/);
    assert.throws(() => windowsNativeBackend(options(host, { profileName: "bad name" })), /profileName/);
    assert.throws(() => windowsNativeBackend(options(host, { programFolders: [CONTROL] })), /overlaps/);
  });

  test("audit details name the mode and that it is process-level and weaker than Linux, the container, no network and the unproven items", () => {
    const details = windowsNativeBackend(options(new SimHost())).auditDetails!();
    assert.equal(details["windowsMode"], "native");
    assert.equal(details["nativeMode"], NATIVE_MODE);
    assert.match(details["strength"]!, /weaker than Linux/);
    assert.match(details["container"]!, /lpac.*registryRead, lpacCom.*no network capability/);
    assert.match(details["network"]!, /no loopback exemption/);
    assert.match(details["standardHandles"]!, /never the NUL device/);
    assert.match(details["unproven"]!, /Session 0/);
    assert.equal(windowsNativeBackend(options(new SimHost(), { container: "appcontainer" })).auditDetails!()["container"], "appcontainer (no capability)");
    assert.equal(NATIVE_MODE, "native process-level, weaker than Linux");
  });

  test("the launcher names the mode in every launch record and refuses a streamed (pipe) request with a typed reason", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "nn-native-")));
    try {
      const d = (n: string): string => { const p = join(base, n); mkdirSync(p); return p; };
      const r = { mode: "sandboxed" as const, workdir: d("w"), home: d("h"), scratch: d("s"), readOnly: [], network: "none" as const, env: {}, protectedSubpaths: [] };
      const native = windowsNativeBackend(options(new SimHost()));
      // A stand-in with the native backend's declared behaviour (its audit details and its refusal of pipes) whose health passes and whose plan starts a harmless local program.
      const stand: SandboxBackend = { ...native, health: async (): Promise<BackendHealth> => ({ healthy: true, backend: native.name }), plan: () => ({ file: process.execPath, args: ["-e", "0"], env: {} }) };
      const records: LaunchRecord[] = [];
      const launcher = await SandboxLauncher.create({ backend: stand, protectedPaths: [], audit: (rec) => { records.push(rec); } });
      await assert.rejects(launcher.launch({ recipe: r, command: ["/x"], timeoutMs: 5000, maxOutputBytes: 100, stream: { onStdout: () => undefined } }), (e: unknown) => e instanceof SandboxError && e.code === "unavailable" && /pipe/.test(e.message));
      assert.equal(records.length, 0);
      const run = await launcher.launch({ recipe: r, command: ["/x"], timeoutMs: 5000, maxOutputBytes: 100 });
      await run.result;
      assert.equal(records.length, 1);
      assert.equal(records[0]!.backend, "windows-native");
      assert.equal(records[0]!.backendDetails?.["nativeMode"], NATIVE_MODE);
      assert.match(records[0]!.backendDetails?.["strength"] ?? "", /weaker than Linux/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

const jobFor = (host: SimHost, extra: Partial<NativeJob> = {}, grants?: NativeGrant[]): { job: NativeJob; jobDir: string; backend: SandboxBackend; plan: SpawnPlan } => {
  const p = prepared(host);
  return { ...p, job: { ...p.job, ...(grants === undefined ? {} : { grants }), ...extra } };
};
const record = (host: SimHost, job: NativeJob): RunRecord => readRecord(host, job.settings, job.runId)!;
const hasEntries = (host: SimHost): string[] => [...host.entries].filter(([, n]) => n > 0).map(([p]) => p);

describe("A03b native launcher: a run, its files, its record and the revoke read back on every path out", () => {
  test("a run: output and exit code come back from files, the program's stdin was a file, grants applied then removed and read back, a record is kept, the lock is released", async () => {
    const host = new SimHost();
    host.script = { out: "hello\n", err: "warn\n", exitCode: 3, onProgram: (_a, h) => assert.ok(hasEntries(h).length > 0, "the grants are in place while the program runs") };
    const { job, jobDir } = jobFor(host);
    const out = await runNativeJob(host, job, "input text", jobDir);
    assert.deepEqual([out.exitCode, out.stdout, out.stderr], [3, "hello\n", "warn\n"]);
    assert.deepEqual(host.seenStdin, ["input text"]);
    assert.deepEqual(hasEntries(host), []);
    const rec = record(host, job);
    assert.equal(rec.readBack, "clean");
    assert.equal(rec.childStarted, true);
    assert.equal(rec.failure, undefined);
    assert.ok(rec.grants.length >= 5 && rec.grants.every((g) => !g.applied || g.revoked));
    assert.ok(lockFree(host));
    const checks = host.calls.filter((c) => c.args[0] === "check").length;
    assert.ok(checks >= 1, "an independent read-back after the launcher's own revoke");
    assert.equal(host.exists(job.files.out), false);
    assert.doesNotMatch(JSON.stringify(rec), /NODE_OPTIONS|LANG/);
  });

  test("with no input the program's standard input is an empty FILE, never missing and never the NUL device", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    await runNativeJob(host, job, undefined, jobDir);
    assert.deepEqual(host.seenStdin, [""]);
    assert.ok(!job.args.join(" ").toLowerCase().includes("nul"));
  });

  test("a program that timed out reports 124 and still has its grants removed", async () => {
    const host = new SimHost();
    host.script = { exitCode: 124, timedOut: true };
    const { job, jobDir } = jobFor(host);
    const out = await runNativeJob(host, job, undefined, jobDir);
    assert.equal(out.exitCode, 124);
    assert.equal(record(host, job).timedOut, true);
    assert.deepEqual(hasEntries(host), []);
  });

  test("a task folder grant that cannot be made stops the launch (typed, nothing started) and what was made is removed and read back", async () => {
    const host = new SimHost();
    host.script = { refuse: (p) => key(p) === key(`${TASK}\\scratch`) };
    const { job, jobDir } = jobFor(host);
    const out = await runNativeJob(host, job, undefined, jobDir);
    assert.equal(out.exitCode, EXIT_FAILED);
    assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: grant: grant:`));
    assert.equal(out.stdout, "");
    const rec = record(host, job);
    assert.equal(rec.childStarted, false);
    assert.equal(rec.failure?.kind, "grant");
    assert.equal(rec.readBack, "clean");
    assert.deepEqual(hasEntries(host), []);
    assert.deepEqual(host.seenStdin, []);
  });

  test("a refused read grant on a program folder is soft: recorded, and the launch goes on", async () => {
    const host = new SimHost();
    host.script = { refuse: (p) => key(p) === key(NODE_DIR), out: "ran" };
    const { job, jobDir } = jobFor(host);
    const out = await runNativeJob(host, job, undefined, jobDir);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "ran");
    assert.deepEqual(record(host, job).softRefused, [{ path: NODE_DIR, mode: "rx", errorCode: 5 }]);
  });

  test("a failure to make the container or the job fails closed with its own reason; the program never ran", async () => {
    for (const [stage, kind] of [["container", "container"], ["job", "job"], ["capability", "container"], ["stdio", "files"], ["create-process", "start"]] as const) {
      const host = new SimHost();
      host.script = { stage };
      const { job, jobDir } = jobFor(host);
      const out = await runNativeJob(host, job, undefined, jobDir);
      assert.equal(out.exitCode, EXIT_FAILED, stage);
      assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: ${kind}: `), stage);
      assert.equal(out.stdout, "");
      assert.equal(record(host, job).childStarted, false);
      assert.deepEqual(hasEntries(host), [], stage);
    }
  });

  test("a launcher that gives no answer, or cannot be run, still gets the read-back; the failure is typed", async () => {
    for (const script of [{ noAnswer: true }, { throws: true }] as Script[]) {
      const host = new SimHost();
      host.script = script;
      const { job, jobDir } = jobFor(host);
      const out = await runNativeJob(host, job, undefined, jobDir);
      assert.equal(out.exitCode, EXIT_FAILED);
      assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: launcher: `));
      assert.ok(host.calls.some((c) => c.args[0] === "check"), "the read-back ran on this exit path");
      assert.ok(lockFree(host));
    }
  });

  test("an entry the launcher's own report missed is found by the independent read-back and removed by a second revoke", async () => {
    const host = new SimHost();
    host.script = { lingering: (p) => key(p) === key(`${TASK}\\home`) };
    const { job, jobDir } = jobFor(host);
    const out = await runNativeJob(host, job, undefined, jobDir);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.ok(host.calls.some((c) => c.args[0] === "revoke"));
    assert.deepEqual(hasEntries(host), []);
    assert.equal(record(host, job).readBack, "clean");
  });

  test("an entry that cannot be removed fails the launch with the revoke reason and keeps the job folder for the sweep", async () => {
    const host = new SimHost();
    host.script = { stubborn: (p) => key(p) === key(`${TASK}\\home`) };
    const { job, jobDir } = jobFor(host);
    const out = await runNativeJob(host, job, undefined, jobDir);
    assert.equal(out.exitCode, EXIT_FAILED);
    assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: revoke: .*home`));
    const rec = record(host, job);
    assert.equal(rec.readBack, "left");
    assert.deepEqual(rec.entriesLeft, [`${TASK}\\home`]);
    assert.ok(host.exists(jobFile(jobDir)) && host.exists(`${jobDir}\\status.json`));
    // The next sweep finds it (the runner is gone) and, the entry now removable, cleans it.
    host.script = {};
    const swept = await sweepLeftovers(host, job.settings);
    assert.deepEqual(swept, { released: 1, problems: [], live: [] });
    assert.equal(host.exists(jobDir + "\\job.json"), false);
  });

  test("workspaces must be on NTFS: another file system stops the launch before any grant is made", async () => {
    const host = new SimHost();
    host.volumes.set("c:", "FAT32");
    const { job, jobDir } = jobFor(host);
    const out = await runNativeJob(host, job, undefined, jobDir);
    assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: filesystem: .*not on NTFS`));
    assert.equal(host.calls.filter((c) => c.args[0] === "run").length, 0);
    host.volumes.delete("c:");
    assert.match((await runNativeJob(host, job, undefined, jobDir)).stderr, /unreadable/);
  });

  test("one run at a time: a live holder makes a second run busy, a dead holder's lock is taken over", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    holdLock(host, { pid: 555, runId: "other" });
    host.alive.add(555);
    const busy = await runNativeJob(host, job, undefined, jobDir);
    assert.equal(busy.exitCode, EXIT_BUSY);
    assert.equal(host.calls.length, 0);
    assert.ok(!lockFree(host) && host.exists(`${LOCKS}\\1`), "the other run's lock is left alone");
    host.alive.delete(555);
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, 0);
    assert.ok(lockFree(host));
  });

  test("a revoke of an empty grant list reads nothing; unreadable answers are reported as unreadable", async () => {
    const host = new SimHost();
    assert.deepEqual((await revokeAndReadBack(host, settings(), [])).state, "clean");
    host.script = {};
    const silent = { ...host, run: async () => ok("") } as unknown as NativeHost;
    assert.equal((await revokeAndReadBack(silent, settings(), [{ mode: "modify", path: TASK, soft: false, why: "home" }])).state, "unreadable");
  });
});

describe("A03b native launcher: the sweep after a restart, and the cleanup after a kill", () => {
  const leftover = (host: SimHost, runnerPid: number | undefined, id = "old-run-0001"): { dir: string; job: NativeJob } => {
    const { job } = jobFor(host);
    const dir = `${CONTROL}\\jobs\\${id}`;
    host.mkdirp(dir);
    host.writeText(jobFile(dir), JSON.stringify({ ...job, runId: id }));
    if (runnerPid !== undefined) host.writeText(`${dir}\\status.json`, JSON.stringify({ runnerPid }));
    for (const g of job.grants) host.entries.set(key(g.path), 1);
    return { dir, job };
  };

  test("a job whose runner is gone has its entries revoked and read back, then its folder removed; a live runner's folder is left alone", async () => {
    const host = new SimHost();
    const dead = leftover(host, 900, "dead-run-0001");
    const live = leftover(host, 901, "live-run-0001");
    host.alive.add(901);
    const planned = leftover(host, undefined, "planned-run-01");
    const swept = await sweepLeftovers(host, settings());
    assert.deepEqual(swept, { released: 1, problems: [], live: [live.dir] });
    assert.equal(host.exists(jobFile(dead.dir)), false);
    assert.ok(host.exists(jobFile(live.dir)));
    assert.ok(host.exists(jobFile(planned.dir)), "a planned job that never started is the backend's release to remove, not the sweep's");
  });

  test("a folder that cannot be cleaned is kept and named in the problems", async () => {
    const host = new SimHost();
    host.script = { stubborn: () => true };
    const { dir } = leftover(host, 900);
    const swept = await sweepLeftovers(host, settings());
    assert.equal(swept.released, 0);
    assert.match(swept.problems[0]!, /still has an entry/);
    assert.ok(host.exists(jobFile(dir)));
  });

  test("an unreadable job file is a problem, never a guess", async () => {
    const host = new SimHost();
    const dir = `${CONTROL}\\jobs\\broken-run-001`;
    host.writeText(`${dir}\\status.json`, JSON.stringify({ runnerPid: 900 }));
    host.writeText(jobFile(dir), "{broken");
    assert.match((await sweepLeftovers(host, settings())).problems[0]!, /job file is missing or cannot be read/);
  });

  test("release after a killed run: the runner is gone, so the entries are revoked and read back; incomplete cleanup is reported", async () => {
    const host = new SimHost();
    const { backend, plan, job, jobDir } = prepared(host);
    host.writeText(`${jobDir}\\status.json`, JSON.stringify({ runnerPid: 900 }));
    for (const g of job.grants) host.entries.set(key(g.path), 1);
    await backend.release!(plan);
    assert.deepEqual(hasEntries(host), []);
    assert.equal(host.exists(jobFile(jobDir)), false);
    // A planned job whose runner never started is removed too.
    const second = prepared(host, recipe(), ["/work/a.exe"]);
    await second.backend.release!(second.plan);
    assert.equal(host.exists(jobFile(second.jobDir)), false);
    // Entries that stay make release throw, which the launcher turns into `releaseProblem`.
    const third = prepared(host, recipe(), ["/work/b.exe"]);
    host.writeText(`${third.jobDir}\\status.json`, JSON.stringify({ runnerPid: 900 })); // its runner had started (only then can a grant exist) and was killed
    for (const g of third.job.grants) host.entries.set(key(g.path), 1);
    host.script = { stubborn: () => true };
    await assert.rejects(third.backend.release!(third.plan), /native Windows cleanup incomplete/);
    // A plan whose job folder is outside the control folder is never touched.
    await second.backend.release!({ ...third.plan, env: { NIMBLENEWT_NATIVE_JOB: "C:\\elsewhere" } });
    await second.backend.release!({ ...third.plan, env: {} });
  });

  test("the process tree under the runner is found and its start times are read, so a killed run's container processes are ended", async () => {
    const host = new SimHost();
    host.procs = [{ pid: 10, parent: 1, started: "a" }, { pid: 11, parent: 10, started: "b" }, { pid: 12, parent: 11, started: "c" }, { pid: 13, parent: 2, started: "d" }];
    const { backend } = prepared(host);
    assert.deepEqual((await backend.descendants!(10)).map((p) => p.pid), [11, 12]);
    assert.deepEqual([...(await backend.startTimes!([12, 13, 99]))], [[12, "c"], [13, "d"]]);
    host.procs = undefined;
    assert.deepEqual(await backend.descendants!(10), []);
    assert.equal((await backend.startTimes!([1])).size, 0);
  });
});

describe("A03b native launcher: health is a real confined start", () => {
  /** What a correct confinement does with the probe program: writes only its own folder; or a chosen failure. */
  const probeBehaviour = (fail: "outside" | "protected" | "network" | "none" = "none") => (args: readonly string[], host: SimHost): void => {
    const cmd = args[args.indexOf("--cmdline") + 1]!;
    if (!cmd.includes("probe.mjs")) return;
    const [work, outside, port] = cmd.split(" ").slice(-3).map((x) => x.replace(/^"|"$/g, "")) as [string, string, string];
    host.writeText(`${work}\\ok.txt`, "x");
    let said = "confined";
    if (fail === "outside") { host.writeText(outside, "x"); }
    if (fail === "protected") { host.writeText(`${work}\\.git\\denied.txt`, "x"); said = "FAIL protected-write"; }
    if (fail === "network") { const s = connect(Number(port), "127.0.0.1"); s.on("error", () => undefined); s.on("connect", () => s.destroy()); said = "FAIL network"; }
    host.script = { ...host.script, out: said };
    host.writeText(args[args.indexOf("--stdout") + 1]!, said);
  };
  const withNetworkWait = async <T>(f: () => Promise<T>): Promise<T> => { const r = await f(); await new Promise((resolve) => setTimeout(resolve, 50)); return r; };
  const healthy = (host: SimHost, extra: Partial<WindowsNativeOptions> = {}): SandboxBackend => { host.files.set(key(LAUNCHER), "exe"); host.files.set(key(RUNNER), "js"); return windowsNativeBackend(options(host, extra)); };

  test("healthy when the probe program, started in the container, can write its own folder and nothing else; the probe reads the host's listener and files", async () => {
    const host = new SimHost();
    host.script = { onProgram: probeBehaviour("none") };
    const h = await healthy(host).health();
    assert.equal(h.healthy, true, h.reason);
    assert.equal(h.backend, "windows-native");
    assert.ok((h.notes ?? []).some((n) => n.includes(NATIVE_MODE)));
    assert.ok((h.notes ?? []).some((n) => /not yet proven/.test(n)));
    assert.ok(host.calls.some((c) => c.args[0] === "info"));
    assert.equal(host.listDir(`${CONTROL}-probe`).length, 0, "the probe's folders are removed");
    assert.deepEqual(hasEntries(host), []);
    const probeRun = host.calls.find((c) => c.args[0] === "run")!;
    assert.match(probeRun.args.join(" "), /probe\.mjs/);
    assert.match(PROBE_SCRIPT, /renameSync/);
  });

  test("unhealthy, with the reason, when the program wrote outside, wrote in the protected folder, or reached the host's listener", async () => {
    for (const [fail, pattern] of [["outside", /does not show the expected files/], ["protected", /confinement probe failed|expected files/], ["network", /confinement probe failed|listener/]] as const) {
      const host = new SimHost();
      host.script = { onProgram: probeBehaviour(fail) };
      const h = await withNetworkWait(() => healthy(host).health());
      assert.equal(h.healthy, false, fail);
      assert.match(h.reason ?? "", pattern, fail);
      assert.deepEqual(hasEntries(host), []);
    }
  });

  test("the placement check comes before the missing-launcher check: a launcher inside the probe's folder is refused as a configuration error, and a launcher in a folder of its own that is missing is reported as missing (same answer on every OS, win32 paths and an injected host)", async () => {
    const host = new SimHost();
    // the probe folder is the control folder plus "-probe", so a launcher in the control folder's parent has the probe folder inside its own folder (the case the Windows hosted run hit)
    assert.throws(() => windowsNativeBackend(options(host, { launcher: "Z:\\nonexistent\\nn-launcher.exe", controlDir: "Z:\\nonexistent\\control" })), /the supervisor's code .* may not sit in the probe's container-writable folder/);
    const apart = windowsNativeBackend(options(host, { launcher: "Z:\\nonexistent\\bin\\nn-launcher.exe", controlDir: "Z:\\nonexistent\\control" }));
    const h = await apart.health();
    assert.equal(h.healthy, false);
    assert.match(h.reason ?? "", /launcher was not found/);
  });

  test("unhealthy and never unconfined when: not Windows, the launcher is not installed, a volume is not NTFS, the container cannot be made, a run left entries behind", async () => {
    const off = new SimHost();
    (off as { platform: string }).platform = "linux";
    assert.match((await healthy(off).health()).reason ?? "", /only on Windows/);
    const bare = new SimHost();
    assert.match((await windowsNativeBackend(options(bare)).health()).reason ?? "", /install step has not been done/);
    const fat = new SimHost(); fat.volumes.set("c:", "ReFS");
    assert.match((await healthy(fat).health()).reason ?? "", /not on NTFS/);
    const noContainer = new SimHost();
    noContainer.run = async () => ok("garbage");
    assert.match((await healthy(noContainer).health()).reason ?? "", /could not make the container profile/);
    const dirty = new SimHost();
    dirty.script = { stubborn: () => true };
    const { dir, job } = ((): { dir: string; job: NativeJob } => { const j = jobFor(dirty).job; const d = `${CONTROL}\\jobs\\old-run-0001`; dirty.writeText(jobFile(d), JSON.stringify(j)); dirty.writeText(`${d}\\status.json`, JSON.stringify({ runnerPid: 7 })); return { dir: d, job: j }; })();
    for (const g of job.grants) dirty.entries.set(key(g.path), 1);
    assert.match((await healthy(dirty).health()).reason ?? "", /left access-list entries behind/);
    assert.ok(dir.length > 0);
  });

  test("a run in progress does not make the backend unhealthy while the last probe still stands", async () => {
    const host = new SimHost();
    host.script = { onProgram: probeBehaviour("none") };
    const backend = healthy(host);
    assert.equal((await backend.health()).healthy, true);
    holdLock(host, { pid: 555, runId: "busy" });
    host.alive.add(555);
    const h = await backend.health();
    assert.equal(h.healthy, true);
    assert.ok((h.notes ?? []).some((n) => /probe still stands/.test(n)));
  });
});

describe("A03b native launcher: wiring, the runner and the real host", () => {
  test("Windows selects the native backend by default, never Windows Sandbox; with nothing installed it has no capacity and says why", async () => {
    const off = windowsDefaultBackend({}, "linux");
    assert.equal(off.name, "windows-native");
    assert.match((await off.health()).reason ?? "", /only on Windows/);
    assert.throws(() => off.plan(recipe(), ["/work/a.exe"]), (e: unknown) => e instanceof SandboxError && e.code === "unavailable");
    const badKind = windowsDefaultBackend({ NIMBLENEWT_WIN_CONTAINER: "vm" }, "win32");
    assert.match((await badKind.health()).reason ?? "", /lpac or appcontainer/);
    // Configured from the environment the install step sets (the runner script path on this machine is not a Windows path, so on Linux the configuration is refused with a reason, not thrown).
    const configured = windowsDefaultBackend({ NIMBLENEWT_WIN_LAUNCHER: LAUNCHER, NIMBLENEWT_WIN_CONTROL_DIR: CONTROL }, "win32");
    assert.equal(configured.name, "windows-native");
    assert.equal((await configured.health()).healthy, false);
    assert.equal((await unavailableNative("why").health()).reason, "why");
    const launcher = await SandboxLauncher.create({ platform: "win32", protectedPaths: [], audit: () => undefined });
    assert.equal(launcher.capacity.available, false);
    assert.equal(launcher.capacity.backend, "windows-native");
  });

  test("the runner: reads the job file, gives the program the controller's input as a file, copies its output and passes its exit code on", async () => {
    const host = new SimHost();
    host.script = { out: "OUT", err: "ERR", exitCode: 7 };
    const { job, jobDir } = jobFor(host);
    host.writeText(jobFile(jobDir), JSON.stringify(job));
    const writes: string[] = [];
    const io = { out: (t: string) => { writes.push(`o:${t}`); }, err: (t: string) => { writes.push(`e:${t}`); } };
    const code = await runnerMain(["node", "runner", jobFile(jobDir)], host, async () => "from the controller", io);
    assert.equal(code, 7);
    assert.deepEqual(writes, ["o:OUT", "e:ERR"]);
    assert.deepEqual(host.seenStdin, ["from the controller"]);
    // Missing and damaged job files are refused, not guessed.
    const quiet = (argv: string[]): Promise<number> => runnerMain(argv, host, async () => "", { out: () => undefined, err: () => undefined });
    assert.equal(await quiet(["node", "runner", "C:\\none.json"]), 70);
    host.writeText("C:\\bad.json", "{x");
    assert.equal(await quiet(["node", "runner", "C:\\bad.json"]), 70);
    host.writeText("C:\\v2.json", JSON.stringify({ version: 2 }));
    assert.equal(await quiet(["node", "runner", "C:\\v2.json"]), 70);
    assert.equal(await quiet(["node", "runner"]), EXIT_FAILED);
  });

  test("the controller's input is read to its end (at most 1 MiB, the rest dropped)", async () => {
    const stream = new PassThrough();
    const read = readAllStdin(stream);
    stream.write("abc"); stream.end("def");
    assert.equal(await read, "abcdef");
    const big = new PassThrough();
    const limited = readAllStdin(big, 4);
    big.end("123456789");
    assert.equal(await limited, "");
  });

  test("the real host: file calls, an exclusive create, a bounded read, a process list that parses and one that skips junk", async () => {
    // The canonical (long-name) form: a hosted Windows runner's temp folder is a short name (RUNNER~1), which the host rightly counts as a link.
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nn-native-host-")));
    try {
      const host = nativeRealHost();
      const file = join(dir, "a.txt");
      assert.equal(host.createExclusive(file, "one"), true);
      assert.equal(host.createExclusive(file, "two"), false);
      assert.equal(host.readText(file), "one");
      assert.equal(host.readText(file, 2), "on");
      assert.equal(host.readText(join(dir, "missing")), undefined);
      host.mkdirp(join(dir, "sub", "deep"));
      assert.equal(host.isDirectory(join(dir, "sub")), true);
      assert.equal(host.isDirectory(file), false);
      assert.deepEqual(host.listDir(dir).sort(), ["a.txt", "sub"]);
      assert.deepEqual(host.listDir(join(dir, "none")), []);
      writeFileSync(join(dir, "b.txt"), "x");
      host.remove(join(dir, "sub"));
      assert.equal(host.exists(join(dir, "sub")), false);
      assert.equal(host.isLinkOrJunction(file), false);
      assert.equal(host.isLinkOrJunction(join(dir, "missing")), false);
      // A dangling link (made off Windows only: a hosted Windows runner may not make symbolic links) counts as a link with the real probes, not as missing.
      if (process.platform !== "win32") { symlinkSync(join(dir, "gone"), join(dir, "dangling")); assert.equal(host.isLinkOrJunction(join(dir, "dangling")), true, "a dangling link"); }
      assert.equal(host.pidAlive(process.pid), true);
      assert.equal((await host.run(process.execPath, ["-e", "process.stdout.write('x')"], { timeoutMs: 20_000 })).stdout, "x");
      assert.equal((await host.run(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { timeoutMs: 200 })).timedOut, true);
      if (process.platform !== "win32") { assert.equal(await host.processes(), undefined); assert.equal(await host.fileSystemOf("C:\\x"), undefined); }
      assert.deepEqual(parseProcessLines("1 0 2026-01-01T00:00:00.0000000Z\nnoise\n 22  1 2026-01-02T00:00:00.0000000Z \r\n"), [{ pid: 1, parent: 0, started: "2026-01-01T00:00:00.0000000Z" }, { pid: 22, parent: 1, started: "2026-01-02T00:00:00.0000000Z" }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("link or junction rule on the Windows branch (run on every OS with injected probes): a short name or a junction higher up counts as a link, case alone does not, an unreadable real path fails closed", () => {
    const yes = (): boolean => true;
    const no = (): boolean => false;
    // The link probe stands for lstat: it does not follow a link, and it throws for a path that is not there (so a missing path passes `new Error("ENOENT")` for it).
    const rule = (path: string, real: string | Error, exists: boolean = true, symlink: boolean | Error = false): boolean =>
      isLinkOrJunctionWith(path, "win32", () => { if (symlink instanceof Error) throw symlink; return symlink; }, () => { if (real instanceof Error) throw real; return real; }, () => exists);
    assert.equal(rule("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\a.txt", "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\a.txt"), true, "short name");
    assert.equal(rule("D:\\work\\link\\a.txt", "D:\\elsewhere\\a.txt"), true, "junction higher up");
    assert.equal(rule("d:\\Work\\A.txt", "D:\\work\\a.txt"), false, "case only");
    assert.equal(rule("D:\\work\\a.txt", "D:\\work\\a.txt"), false);
    assert.equal(rule("D:\\work\\a.txt", "D:\\work\\a.txt", true, true), true, "a symbolic link");
    assert.equal(rule("D:\\work\\a.txt", new Error("EACCES")), true, "fails closed");
    assert.equal(rule("D:\\work\\none", new Error("ENOENT"), false, new Error("ENOENT")), false, "missing is not a link");
    // Review 2026-11-25: a dangling link or junction (its target gone, so an existence check that follows links says missing) still counts as a link.
    assert.equal(rule("D:\\work\\.git", new Error("ENOENT"), false, true), true, "a dangling link");
    // The link probe failing on a path that is there (access refused) fails closed.
    assert.equal(rule("D:\\work\\a.txt", "D:\\work\\a.txt", true, new Error("EPERM")), true, "an unreadable link probe fails closed");
    assert.equal(rule("D:/work/a.txt", "D:\\work\\a.txt"), false, "either separator");
    assert.equal(isLinkOrJunctionWith("/a/b", "linux", no, () => "/a/b", yes), false);
    assert.equal(isLinkOrJunctionWith("/a/b", "linux", no, () => "/private/a/b", yes), true);
  });

  test("review 2026-11-25: input folders whose text Windows would read as another folder (trailing dot or space, short name) are refused, so the overlap checks see the real folder", () => {
    const check = (r: NormalizedRecipe): void => checkNativeRecipe(r, settings(), SUP, () => undefined, () => false);
    for (const host of [`${CONTROL}.`, `${CONTROL} `, "C:\\PROGRA~1\\NimbleNewt", "C:\\ProgramData\\NIMBLE~1\\native", "C:\\Tools\\inputs."]) {
      assert.throws(() => check(recipe({ readOnly: [{ host, guest: "/inputs/tools" }] })), (e: unknown) => e instanceof SandboxError && e.code === "invalid_recipe", host);
    }
    assert.throws(() => grantsFor(recipe(), settings({ programFolders: ["C:\\PROGRA~1\\nodejs"] }), SUP), /short-name/);
  });

  test("review 2026-11-25: a protected name that is a link or junction is never sealed (the seal would land on the folder it points to)", () => {
    const host = new SimHost();
    host.links.add(key(`${TASK}\\work\\.git`));
    assert.throws(() => windowsNativeBackend(options(host)).plan(recipe(), ["/work/a.exe"], "run-0009-aaaa"), /cannot be sealed/);
    assert.equal(host.listDir(`${CONTROL}\\jobs`).length, 0);
    // A name the recipe found missing is not sealed, so it is not looked at either.
    windowsNativeBackend(options(host)).plan(recipe({ unprotectedSubpaths: [".git"] }), ["/work/a.exe"], "run-0010-aaaa");
  });

  test("review 2026-11-25: a reused process number does not keep a dead run's lock or its leftover entries alive", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    // The lock was written by process 555 at 10:00; process 555 now is a different program that started at 11:00.
    holdLock(host, { pid: 555, runId: "other", at: "2026-11-25T10:00:00.000Z" });
    host.alive.add(555);
    host.procs = [{ pid: 555, parent: 1, started: "2026-11-25T11:00:00.0000000Z" }];
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, 0);
    // The same holder, still the process that wrote it (started before the lock): busy.
    holdLock(host, { pid: 555, runId: "other", at: "2026-11-25T12:00:00.000Z" });
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, EXIT_BUSY);
    host.remove(LOCKS);
    // A leftover job folder whose runner number now belongs to a later process is swept; one whose runner is the same process is left alone.
    const sweepHost = new SimHost();
    const { job: j2 } = jobFor(sweepHost);
    const add = (id: string, pid: number, startedAt: string): string => {
      const dir = `${CONTROL}\\jobs\\${id}`;
      sweepHost.writeText(jobFile(dir), JSON.stringify({ ...j2, runId: id }));
      sweepHost.writeText(`${dir}\\status.json`, JSON.stringify({ runnerPid: pid, runId: id, startedAt }));
      return dir;
    };
    const reused = add("reused-run-01", 900, "2026-11-25T10:00:00.000Z");
    const live = add("live-run-0001", 901, "2026-11-25T10:00:00.000Z");
    sweepHost.alive.add(900); sweepHost.alive.add(901);
    sweepHost.procs = [{ pid: 900, parent: 1, started: "2026-11-25T11:00:00.0000000Z" }, { pid: 901, parent: 1, started: "2026-11-25T09:59:59.0000000Z" }];
    for (const g of j2.grants) sweepHost.entries.set(key(g.path), 1);
    assert.deepEqual(await sweepLeftovers(sweepHost, settings()), { released: 1, problems: [], live: [live] });
    assert.equal(sweepHost.exists(jobFile(reused)), false);
    assert.ok(sweepHost.exists(jobFile(live)));
    // Where start times cannot be read, a live number is still taken as the holder (nothing of a live run is touched on a guess).
    sweepHost.procs = undefined;
    assert.deepEqual(await sweepLeftovers(sweepHost, settings()), { released: 0, problems: [], live: [live] });
  });

  test("review 2026-11-25: the release of a run refused as busy revokes nothing (a live run on the same folders keeps its entries)", async () => {
    const host = new SimHost();
    const { backend, plan, job, jobDir } = prepared(host);
    holdLock(host, { pid: 555, runId: "live" });
    host.alive.add(555);
    for (const g of job.grants) host.entries.set(key(g.path), 1); // the live run's entries on the same task folders
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, EXIT_BUSY);
    await backend.release!(plan);
    assert.equal(host.calls.filter((c) => c.args[0] === "revoke" || c.args[0] === "check").length, 0);
    assert.equal(hasEntries(host).length, job.grants.length);
    assert.equal(host.exists(jobFile(jobDir)), false);
  });

  test("review 2026-11-25: the job file kept for the sweep no longer holds the recipe's environment values once the run has begun; the grants stay", async () => {
    const host = new SimHost();
    const r = recipe({ env: { LANG: "en", NN_MARKER_VALUE: `marker-${Date.now()}` } });
    const backend = windowsNativeBackend(options(host));
    const plan = backend.plan(r, ["/work/a.exe"], "run-0011-aaaa");
    const jobDir = plan.env["NIMBLENEWT_NATIVE_JOB"]!;
    const job = JSON.parse(host.readText(jobFile(jobDir))!) as NativeJob;
    assert.ok(host.readText(jobFile(jobDir))!.includes(r.env["NN_MARKER_VALUE"]!), "the planned job file carries the values for the runner");
    host.script = { stubborn: (p) => key(p) === key(`${TASK}\\home`) };
    await runNativeJob(host, job, undefined, jobDir);
    const kept = host.readText(jobFile(jobDir))!;
    assert.ok(!kept.includes(r.env["NN_MARKER_VALUE"]!));
    assert.deepEqual((JSON.parse(kept) as NativeJob).grants, job.grants);
  });

  test("review 2026-11-25: a launcher answer of success that does not say the program started is a launcher failure, not a pass", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    const real = host.run.bind(host);
    host.run = async (file: string, args: readonly string[]): Promise<ProcessResult> => (args[0] === "run" ? ok(`${JSON.stringify({ tool: "nn-appc-launcher", ok: true, grants: [] })}\n`) : real(file, args));
    const out = await runNativeJob(host, job, undefined, jobDir);
    assert.equal(out.exitCode, EXIT_FAILED);
    assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: launcher: .*not that the program started`));
  });

  test("records are bounded and hold no environment values", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    for (let i = 0; i < 205; i++) host.writeText(`${recordsDir(job.settings)}\\old-${String(i).padStart(4, "0")}.json`, "{}");
    await runNativeJob(host, job, undefined, jobDir);
    assert.ok(host.listDir(recordsDir(job.settings)).length <= 200);
    assert.ok(readRecord(host, job.settings, job.runId) !== undefined);
  });
});

describe("A03b second review: no second program with the container's SID, seals lifted last, Windows name quirks", () => {
  const second = (host: SimHost, id: string, r: NormalizedRecipe = recipe({ workdir: "C:\\Tasks\\t2\\work", home: "C:\\Tasks\\t2\\home", scratch: "C:\\Tasks\\t2\\scratch" })): { job: NativeJob; jobDir: string; plan: SpawnPlan; backend: SandboxBackend } => {
    const backend = windowsNativeBackend(options(host));
    const plan = backend.plan(r, ["/inputs/tools/tool.exe"], id);
    const jobDir = plan.env["NIMBLENEWT_NATIVE_JOB"]!;
    return { job: JSON.parse(host.readText(jobFile(jobDir))!) as NativeJob, jobDir, plan, backend };
  };

  test("a runner killed alone leaves its launcher running: the next run is busy and release revokes nothing until the launcher has ended", async () => {
    const host = new SimHost();
    const first = jobFor(host);
    // The first run took the slot and started; its runner (900) was then killed, but the launcher it started (901) still runs the program in the container.
    const at = new Date(Date.now() - 60_000).toISOString();
    holdLock(host, { pid: 900, runId: first.job.runId, at });
    host.writeText(`${first.jobDir}\\status.json`, JSON.stringify({ runnerPid: 900, runId: first.job.runId, startedAt: at }));
    for (const g of first.job.grants) host.entries.set(key(g.path), 1);
    host.procs = [{ pid: 901, parent: 900, started: new Date(Date.now() - 59_000).toISOString() }];
    const later = second(host, "run-0002-bbbb");
    assert.equal((await runNativeJob(host, later.job, undefined, later.jobDir)).exitCode, EXIT_BUSY);
    assert.equal(host.calls.filter((c) => c.args[0] === "run").length, 0, "no second program with the same SID");
    await assert.rejects(first.backend.release!(first.plan), /launcher may still be running/);
    assert.equal(host.calls.filter((c) => c.args[0] === "revoke").length, 0, "nothing revoked under a live program");
    assert.equal(hasEntries(host).length, first.job.grants.length);
    // Where the process list cannot be read, a gone runner may still have its launcher: still busy, nothing revoked.
    host.procs = undefined;
    assert.equal((await runNativeJob(host, later.job, undefined, later.jobDir)).exitCode, EXIT_BUSY);
    // The launcher has ended: the next run sweeps the old run's entries first, then runs.
    host.procs = [];
    const out = await runNativeJob(host, later.job, undefined, later.jobDir);
    assert.equal(out.exitCode, 0);
    assert.deepEqual(hasEntries(host), []);
    assert.equal(host.exists(jobFile(first.jobDir)), false, "the old run's folder was swept before the new run");
  });

  test("a launcher process started BEFORE the lock is not the run's, and a later process with the runner's number bounds the runner's children", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    holdLock(host, { pid: 900, runId: "old", at: "2026-11-25T10:00:00.000Z" });
    host.procs = [{ pid: 901, parent: 900, started: "2026-11-25T09:00:00.000Z" }];
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, 0);
    // 900 is now another program (started 11:00); its own child (11:30) is not the old run's launcher; a child from 10:30 is.
    holdLock(host, { pid: 900, runId: "old2", at: "2026-11-25T10:00:00.000Z" });
    host.alive.add(900);
    host.procs = [{ pid: 900, parent: 1, started: "2026-11-25T11:00:00.000Z" }, { pid: 950, parent: 900, started: "2026-11-25T11:30:00.000Z" }];
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, 0);
    holdLock(host, { pid: 900, runId: "old3", at: "2026-11-25T10:00:00.000Z" });
    host.procs = [{ pid: 900, parent: 1, started: "2026-11-25T11:00:00.000Z" }, { pid: 951, parent: 900, started: "2026-11-25T10:30:00.000Z" }];
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, EXIT_BUSY);
  });

  test("two runs that find the same stale lock at the same moment: exactly one runs", async () => {
    const host = new SimHost();
    holdLock(host, { pid: 555, runId: "dead", at: new Date(Date.now() - 60_000).toISOString() });
    const a = jobFor(host);
    const b = second(host, "run-0002-bbbb");
    let inside = 0, most = 0;
    host.script = { onProgram: async () => { inside++; most = Math.max(most, inside); await new Promise((r) => setTimeout(r, 20)); inside--; } };
    const codes = (await Promise.all([runNativeJob(host, a.job, undefined, a.jobDir), runNativeJob(host, b.job, undefined, b.jobDir)])).map((o) => o.exitCode).sort();
    assert.deepEqual(codes, [0, EXIT_BUSY]);
    assert.equal(most, 1);
    assert.ok(lockFree(host));
  });

  test("the slot is released by a separate mark, never by rewriting the holder's file; a lock file that cannot be read is never taken over", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, 0);
    assert.ok(host.exists(`${LOCKS}\\1`) && host.exists(`${LOCKS}\\1.released`));
    assert.equal(JSON.parse(host.readText(`${LOCKS}\\1`)!).runId, job.runId, "the holder's file is left as written");
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, 0);
    assert.deepEqual(host.listDir(LOCKS).sort(), ["2", "2.released"], "older numbers go once a newer one is held");
    // A holder whose process still runs (a runner copying its output back after the run) but that marked its number released does not hold the slot.
    holdLock(host, { pid: 555, runId: "finished", at: new Date().toISOString() });
    host.alive.add(555);
    host.procs = [{ pid: 555, parent: 1, started: new Date(Date.now() - 60_000).toISOString() }];
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, EXIT_BUSY);
    host.files.set(key(`${LOCKS}\\3.released`), "finished");
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, 0);
    host.files.set(key(`${LOCKS}\\5`), "{half");
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, EXIT_BUSY);
    assert.equal(host.readText(`${LOCKS}\\5`), "{half");
  });

  test("a run in progress in this same process (the health probe) holds the slot: another caller here is busy and a sweep here leaves its folder alone", async () => {
    const host = new SimHost();
    const a = jobFor(host);
    const b = second(host, "run-0002-bbbb");
    let during: { code: number; swept: Awaited<ReturnType<typeof sweepLeftovers>>; entries: number } | undefined;
    host.script = { onProgram: async () => {
      host.script = {};
      const code = (await runNativeJob(host, b.job, undefined, b.jobDir)).exitCode;
      const swept = await sweepLeftovers(host, a.job.settings);
      during = { code, swept, entries: hasEntries(host).length };
    } };
    assert.equal((await runNativeJob(host, a.job, undefined, a.jobDir)).exitCode, 0);
    assert.equal(during?.code, EXIT_BUSY);
    assert.deepEqual(during?.swept.live, [a.jobDir]);
    assert.equal(during?.entries, a.job.grants.length, "the live run's grants were not revoked by the sweep");
  });

  test("a seal is lifted only after every other grant reads back clean, never in the same revoke", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    const seal = job.grants.find((g) => g.mode === "seal")!;
    host.script = { stubborn: (p) => key(p) === key(job.workdir) };
    const out = await runNativeJob(host, job, undefined, jobDir);
    assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: revoke: `));
    const revokes = host.calls.filter((c) => c.args[0] === "revoke");
    assert.ok(revokes.length > 0);
    assert.ok(revokes.every((c) => !c.args.includes(`seal:${seal.path}`)), "the seal was never revoked while the workspace entry was still there");
    // Both left after the launcher's run: the other grants go first, then the seal alone.
    const h2 = new SimHost();
    const j2 = jobFor(h2);
    h2.script = { lingering: (p) => key(p) === key(j2.job.workdir) || key(p) === key(seal.path) };
    assert.equal((await runNativeJob(h2, j2.job, undefined, j2.jobDir)).exitCode, 0);
    const r2 = h2.calls.filter((c) => c.args[0] === "revoke").map((c) => c.args.filter((x) => x.includes(":")));
    assert.equal(r2.length, 2);
    assert.ok(!r2[0]!.includes(`seal:${seal.path}`) && r2[0]!.includes(`modify-root:${j2.job.workdir}`));
    assert.deepEqual(r2[1], [`seal:${seal.path}`]);
  });

  test("a run does not start while an earlier run's entries cannot be removed; a removable leftover is swept first", async () => {
    const host = new SimHost();
    const old = jobFor(host);
    host.writeText(`${old.jobDir}\\status.json`, JSON.stringify({ runnerPid: 900, runId: old.job.runId }));
    for (const g of old.job.grants) host.entries.set(key(g.path), 1);
    host.script = { stubborn: (p) => key(p) === key(`${TASK}\\home`) };
    const b = second(host, "run-0002-bbbb");
    const out = await runNativeJob(host, b.job, undefined, b.jobDir);
    assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: revoke: an earlier run's entries`));
    assert.equal(host.calls.filter((c) => c.args[0] === "run").length, 0);
    host.script = {};
    assert.equal((await runNativeJob(host, b.job, undefined, b.jobDir)).exitCode, 0);
    assert.equal(host.exists(jobFile(old.jobDir)), false);
  });

  test("a job folder whose runner had started but whose job file is gone is a problem, never 'nothing to revoke'", async () => {
    const host = new SimHost();
    const dir = `${CONTROL}\\jobs\\lost-run-0001`;
    host.writeText(`${dir}\\status.json`, JSON.stringify({ runnerPid: 900 }));
    const swept = await sweepLeftovers(host, settings());
    assert.match(swept.problems[0] ?? "", /job file is missing/);
    assert.ok(host.exists(`${dir}\\status.json`));
  });

  test("device names (CON, NUL, COM1, with an extension too) are refused in task folders, inputs, program folders and the program path", () => {
    const host = new SimHost();
    const backend = windowsNativeBackend(options(host));
    for (const r of [recipe({ workdir: `${TASK}\\CON` }), recipe({ home: `${TASK}\\nul.txt` }), recipe({ readOnly: [{ host: "C:\\Tools\\COM1", guest: "/inputs/tools" }] }), recipe({ readOnly: [{ host: "C:\\Tools\\lpt\u00b9", guest: "/inputs/tools" }] })]) {
      assert.throws(() => backend.plan(r, ["/inputs/tools/tool.exe"], "run-0003-cccc"), /device/);
    }
    assert.throws(() => backend.plan(recipe(), ["/work/aux.exe"], "run-0003-cccc"), /cannot take/);
    assert.throws(() => windowsNativeBackend(options(host, { programFolders: ["C:\\Program Files\\PRN"] })), /device/);
    assert.equal(backend.plan(recipe(), ["/work/console.exe"], "run-0003-cccc").file, NODE, "a name that only starts like a device is fine");
  });

  test("a spelling with a dotless i or a long s that the volume may read as the supervisor's folder is refused as an overlap", () => {
    const host = new SimHost();
    const backend = windowsNativeBackend(options(host));
    assert.throws(() => backend.plan(recipe({ readOnly: [{ host: "C:\\Program F\u0131les\\NimbleNewt\\worker", guest: "/inputs/tools" }] }), ["/inputs/tools/tool.exe"], "run-0004-dddd"), /overlaps the supervisor/);
    assert.throws(() => backend.plan(recipe({ readOnly: [{ host: "C:\\Program File\u017f\\NimbleNewt", guest: "/inputs/tools" }] }), ["/inputs/tools/tool.exe"], "run-0004-dddd"), /overlaps the supervisor/);
  });

  test("third review: release of an earlier run's folder while another run holds the slot revokes nothing (that run's grants on the same task folders stay whole)", async () => {
    const host = new SimHost();
    const old = jobFor(host);
    const live = second(host, "run-0009-live", recipe());
    let during: { error: string; revokes: number; left: number } | undefined;
    host.script = { onProgram: async () => {
      // The earlier run on the same task folders had started (status file) and its runner is gone: its job file still names the same paths the live run has just been granted.
      host.writeText(`${old.jobDir}\\status.json`, JSON.stringify({ runnerPid: 900, runId: old.job.runId, startedAt: new Date(Date.now() - 60_000).toISOString() }));
      const before = host.calls.filter((c) => c.args[0] === "revoke" || c.args[0] === "check").length;
      let error = "";
      try { await old.backend.release!(old.plan); } catch (e) { error = (e as Error).message; }
      during = { error, revokes: host.calls.filter((c) => c.args[0] === "revoke" || c.args[0] === "check").length - before, left: live.job.grants.filter((g) => (host.entries.get(key(g.path)) ?? 0) > 0).length };
    } };
    assert.equal((await runNativeJob(host, live.job, undefined, live.jobDir)).exitCode, 0);
    assert.match(during?.error ?? "", /holds the run slot/);
    assert.equal(during?.revokes, 0, "no check or revoke while another run holds the slot");
    assert.equal(during?.left, live.job.grants.length, "the live run's grants (its seal included) were all still there");
    assert.ok(host.exists(jobFile(old.jobDir)), "the folder stays for a later sweep");
    // The slot is free again: release now sweeps it.
    await old.backend.release!(old.plan);
    assert.equal(host.exists(jobFile(old.jobDir)), false);
  });

  test("third review: a contender that acts on an older listing creates a number below the live holder's and backs off without running", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    // 1 was released; 2 was taken and has gone (removed by the taker of 3); 3 is held by a live run. The contender's first listing is from before 3 existed.
    host.files.set(key(`${LOCKS}\\1`), JSON.stringify({ pid: 400, runId: "done", at: new Date(Date.now() - 120_000).toISOString() }));
    host.files.set(key(`${LOCKS}\\1.released`), "done");
    host.files.set(key(`${LOCKS}\\3`), JSON.stringify({ pid: 555, runId: "live", at: new Date(Date.now() - 10_000).toISOString() }));
    host.alive.add(555);
    host.procs = [{ pid: 555, parent: 1, started: new Date(Date.now() - 60_000).toISOString() }];
    const real = host.listDir.bind(host);
    let stale = true;
    host.listDir = (p: string): string[] => { if (stale && key(p) === key(LOCKS)) { stale = false; return ["1", "1.released"]; } return real(p); };
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, EXIT_BUSY);
    assert.equal(host.calls.filter((c) => c.args[0] === "run").length, 0, "no second program while 3 is held");
    assert.equal(host.exists(`${LOCKS}\\2`), false, "the contender removed the number it made");
    assert.ok(host.exists(`${LOCKS}\\3`));
  });

  test("third review: a lock that cannot be written is busy (no run, no grant), and the run id is not left marked as in progress", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    const real = host.createExclusive.bind(host);
    host.createExclusive = (): boolean => { throw new Error("disk full"); };
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, EXIT_BUSY);
    assert.equal(host.calls.filter((c) => c.args[0] === "run").length, 0);
    host.createExclusive = real;
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, 0, "the same run id runs once the lock can be written");
  });

  test("the real host's exclusive create is whole or nothing and leaves no temporary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nn-a03b-x-"));
    try {
      const host = nativeRealHost();
      const p = join(dir, "1");
      assert.equal(host.createExclusive(p, "first"), true);
      assert.equal(host.createExclusive(p, "second"), false);
      assert.equal(host.readText(p), "first");
      assert.deepEqual(host.listDir(dir), ["1"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

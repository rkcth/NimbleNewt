import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import type { BackendHealth, SandboxBackend, SpawnPlan } from "./backend.js";
import { SandboxError } from "./errors.js";
import { SandboxLauncher, type LaunchRecord } from "./launcher.js";
import type { NormalizedRecipe } from "./recipe.js";
import type { ChannelFs, ChannelJob, ChannelPorts } from "./windows-native-channel.js";
import { FILE_CHANNEL_ENV, encodeFrame, openWorkerFileChannel } from "@nimblenewt/contracts";
import { jobFile, launcherSid, probeProfile, profilesDir, readProfileRecord, readRecord, recordsDir, retireProfile, revokeAndReadBack, runNativeJob, runProfileFor, slotDir, sweepLeftovers, sweepLeftoversLocked, type JobOutcome, type NativeHost, type NativeJob, type ProcessResult, type RunRecord } from "./windows-native-job.js";
import {
  DEFAULT_JOB_LIMITS, EXIT_BUSY, EXIT_FAILED, FAILURE_PREFIX, LPAC_CAPABILITIES, NATIVE_MODE, NODE_PRESERVE_OPTIONS, REFUSED_ROUTE, checkNativeRecipe, failureKindOf, grantsFor, grantsLeft, isRunProfileName, launcherArgs, nativeEnv, newRunProfileName,
  parseLauncherLine, programPath, quoteWindowsArg, softRefusals, type NativeGrant, type NativeSettings,
} from "./windows-native-plan.js";
import { main as runnerMain, processPorts, readAllStdin } from "./windows-native-runner.js";
import { channelFileRefusal, isLinkOrJunctionWith, nodeChannelFs, nativeRealHost, parseProcessLines, removeChannelFolderWith, sameChannelFile, type ChannelStat, type FolderOps } from "./windows-native-real.js";
import { PROBE_SCRIPT, unavailableNative, windowsDefaultBackend, windowsNativeBackend, type WindowsNativeOptions } from "./windows-native.js";
import { HOLD_SCRIPT, afterSignIn, heldRunOutcome, holdFiles, parseHoldState, startHold, type HoldState } from "./windows-native-signout.js";
import { AFTER_SIGNOUT_SCHEMA, grantsReadBackOf } from "./containment-windows-native-evidence.js";
import { afterSignOutProblems } from "./containment.js";

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
  /** The window-object mode the launcher's run and info lines name (default: none for a run, `private` for info; "" leaves the key out of both). */
  windowStation?: string;
  throws?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  out?: string;
  err?: string;
  /** The delete of the per-run profile fails (the profile stays; `delete-profile` fails too). */
  profileStuck?: boolean;
  /** `delete-profile` answers ok and deleted but NOT gone (a self-contradicting answer: never taken as gone). */
  deleteNotGone?: boolean;
  /** The run's own line says it deleted the profile, but a later check finds it (the supervisor must ask again). */
  profileNotGoneInLine?: boolean;
  /** What the "program" does with the paths it was given (the probe program). */
  onProgram?: (args: readonly string[], host: SimHost, signal?: AbortSignal) => void | Promise<void>;
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
  /** The container profiles that exist on the simulated machine (by name). */
  readonly profiles = new Set<string>();
  readonly seenStdin: string[] = [];
  script: Script = {};
  channelFs?: ChannelFs;
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

  async run(file: string, args: readonly string[], options?: { readonly signal?: AbortSignal }): Promise<ProcessResult> {
    this.calls.push({ file, args: [...args] });
    if (key(file) !== key(LAUNCHER)) return ok();
    if (this.script.throws && args[0] === "run") throw new Error("spawn failed");
    const grants = (a: readonly string[]): { mode: string; path: string; soft: boolean }[] => a.flatMap((x, i) => (x === "--grant" || x === "--grant-soft" ? [{ mode: a[i + 1]!.slice(0, a[i + 1]!.indexOf(":")), path: a[i + 1]!.slice(a[i + 1]!.indexOf(":") + 1), soft: x === "--grant-soft" }] : []));
    const line = (o: Record<string, unknown>): ProcessResult => ok(`noise\n${JSON.stringify({ tool: "nn-appc-launcher", version: 1, ...o })}\n`);
    const opt = (flag: string): string | undefined => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
    const name = opt("--name") ?? "";
    const sid = simSid(name);
    const recordPath = opt("--profile-record");
    // The launcher refuses anything but a per-run name, and a --sid that is not the name's own.
    if (!/^NimbleNewtRun-[0-9a-f]{16}$/.test(name)) return line({ command: args[0], ok: false, stage: "arguments", error: "--name must be NimbleNewtRun-<16 lower-case hex digits> in this build" });
    if (opt("--sid") !== undefined && opt("--sid") !== sid) return line({ command: args[0], ok: false, stage: "container", error: "the SID given is not the SID of this profile name" });
    const deleteIt = (): { profileDeleted: boolean; profileGone: boolean } => { if (this.script.profileStuck) return { profileDeleted: false, profileGone: false }; this.profiles.delete(name); return { profileDeleted: true, profileGone: true }; };
    /** The launcher's own profile start: the record first (create-new), then the profile; never an existing one. */
    const beginProfile = (): ProcessResult | undefined => {
      if (recordPath === undefined) return line({ command: args[0], ok: false, stage: "arguments", error: "needs --profile-record" });
      if (!this.createExclusive(recordPath, `nn-run-profile v1\n${name} ${sid}\n`)) return line({ command: args[0], ok: false, stage: "container", error: "the profile record could not be created (create-new): it exists" });
      if (this.profiles.has(name)) { this.remove(recordPath); return line({ command: args[0], ok: false, stage: "container", error: "a profile with this name already exists: it is not adopted" }); }
      this.profiles.add(name);
      return undefined;
    };
    const gl = (g: { mode: string; path: string; soft: boolean }[], extra: (p: string) => Record<string, unknown>): unknown[] => g.map((x) => ({ path: x.path, mode: x.mode, soft: x.soft, ...extra(x.path), entriesLeft: this.entries.get(key(x.path)) ?? 0 }));
    if (args[0] === "info") { const early = beginProfile(); if (early !== undefined) return early; return line({ command: "info", ok: true, containerSid: sid, profile: "created", ...(this.script.windowStation === "" ? {} : { windowStation: this.script.windowStation ?? "private" }), windowStationOk: true, ...(this.script.windowStation === "home-desktop" ? { privateStationError: "window objects: the private window station could not be made (error 5)" } : {}), ...deleteIt() }); }
    if (args[0] === "check") return line({ command: "check", ok: true, clean: true, containerSid: sid, grants: gl(grants(args), () => ({ applied: false, revoked: false })) });
    if (args[0] === "revoke") { for (const g of grants(args)) this.entries.set(key(g.path), this.script.stubborn?.(g.path) ? 1 : 0); return line({ command: "revoke", ok: true, containerSid: sid, grants: gl(grants(args), () => ({ applied: true, revoked: true })) }); }
    if (args[0] === "delete-profile") {
      const rec = recordPath === undefined ? undefined : this.readText(recordPath);
      if (rec === undefined) return line({ command: "delete-profile", ok: false, stage: "profile", error: "there is no record of this profile in the control folder, so it is not proven to be this launcher's: nothing is deleted" });
      if (rec !== `nn-run-profile v1\n${name} ${sid}\n`) return line({ command: "delete-profile", ok: false, stage: "profile", error: "the profile record names another profile or SID: nothing is deleted" });
      if (this.script.deleteNotGone) return line({ command: "delete-profile", ok: true, containerSid: sid, profileDeleted: true, profileGone: false });
      const done = deleteIt();
      return line({ command: "delete-profile", ok: done.profileDeleted && done.profileGone, containerSid: sid, ...done });
    }
    // run
    if (this.script.noAnswer) return ok("nothing useful\n", 125);
    if (this.script.stage !== "container") { const early = beginProfile(); if (early !== undefined) return early; }
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
    const render = (o: Record<string, unknown>): ProcessResult => {
      after();
      const allGone = applied.every((a) => !a.applied || (a.revoked && (this.entries.get(key(a.path)) ?? 0) === 0));
      // Like the launcher: the profile is deleted (and checked) only when every grant is revoked; a launcher that made none has none to delete.
      const ended = this.profiles.has(name) ? (allGone ? deleteIt() : { profileDeleted: false, profileGone: false }) : {};
      return line({ command: "run", containerSid: sid, allGrantsRevoked: applied.every((a) => !a.applied || a.revoked), grants: applied.map((a) => ({ ...a, entriesLeft: this.entries.get(key(a.path)) ?? 0 })), ...ended, ...(this.script.profileNotGoneInLine === true ? { profileGone: false } : {}), ...o });
    };
    if (failedStage === undefined && this.script.stage !== undefined) failedStage = this.script.stage;
    if (failedStage !== undefined) return render({ ok: false, childStarted: false, stage: failedStage, error: `${failedStage} failed (simulated)` });
    const val = (flag: string): string => args[args.indexOf(flag) + 1]!;
    const stdinPath = val("--stdin").replace(/^file:/, "");
    this.seenStdin.push(this.readText(stdinPath) ?? "<missing>");
    this.writeText(val("--stdout"), this.script.out ?? "");
    this.writeText(val("--stderr"), this.script.err ?? "");
    await this.script.onProgram?.(args, this, options?.signal);
    return render({ ok: true, childStarted: true, childExitCode: this.script.exitCode ?? 0, timedOut: this.script.timedOut === true, ...(this.script.windowStation === undefined || this.script.windowStation === "" ? {} : { windowStation: this.script.windowStation }) });
  }
}

/** A stand-in for the SID a profile name derives to: seven numbers after S-1-15-2, the last taken from the name. */
const simSid = (name: string): string => `S-1-15-2-1-2-3-4-5-6-${parseInt(createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 8), 16)}`;
const RUN_NAME = /^NimbleNewtRun-[0-9a-f]{16}$/;
const settings = (extra: Partial<NativeSettings> = {}): NativeSettings => ({
  launcher: LAUNCHER, controlDir: CONTROL, nodeExecutable: NODE, programFolders: [NODE_DIR], systemRoot: "C:\\Windows", container: "lpac", maxConcurrentRuns: 1,
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
    const profile = runProfileFor(settings(), "NimbleNewtRun-0123456789abcdef");
    const args = launcherArgs(r, "C:\\Tools\\inputs\\tool.exe", ["a b", "c"], settings(), grants, files, nativeEnv(r, settings()), profile);
    assert.equal(args[0], "run");
    assert.deepEqual(args.slice(1, 5), ["--name", "NimbleNewtRun-0123456789abcdef", "--profile-record", `${CONTROL}\\profiles\\NimbleNewtRun-0123456789abcdef.sid`]);
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
    const plain = launcherArgs(r, "x.exe", [], settings({ container: "appcontainer" }), grants, files, {}, profile);
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

  test("the launcher names the mode in every launch record and refuses a streamed request on a backend that cannot carry one, with a typed reason", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "nn-native-")));
    try {
      const d = (n: string): string => { const p = join(base, n); mkdirSync(p); return p; };
      const r = { mode: "sandboxed" as const, workdir: d("w"), home: d("h"), scratch: d("s"), readOnly: [], network: "none" as const, env: {}, protectedSubpaths: [] };
      const native = windowsNativeBackend(options(new SimHost()));
      // A stand-in with the native backend's audit details and a backend that declares it cannot carry a streamed run (the launcher's generic refusal; the native backend itself now relays, see slice 4 below) whose health passes and whose plan starts a harmless local program.
      const stand: SandboxBackend = { ...native, interactiveInput: false, health: async (): Promise<BackendHealth> => ({ healthy: true, backend: native.name }), plan: () => ({ file: process.execPath, args: ["-e", "0"], env: {} }) };
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
/** A run that got as far as its launcher and was then killed: the status file, the backend's profile record, the launcher's record and the profile. */
const markStarted = (host: SimHost, job: NativeJob, jobDir: string, status: Record<string, unknown>): void => {
  host.writeText(`${jobDir}\\status.json`, JSON.stringify(status));
  const name = job.profile.name;
  host.mkdirp(profilesDir(job.settings));
  host.writeText(`${profilesDir(job.settings)}\\${name}.json`, JSON.stringify({ version: 1, name, runId: job.runId, jobDir, pid: status["runnerPid"] ?? 0, at: status["startedAt"] ?? new Date().toISOString(), grants: job.grants, folders: job.claim }));
  host.writeText(job.profile.record, `nn-run-profile v1\n${name} ${simSid(name)}\n`);
  host.profiles.add(name);
};
const record = (host: SimHost, job: NativeJob): RunRecord => readRecord(host, job.settings, job.runId)!;
const hasEntries = (host: SimHost): string[] => [...host.entries].filter(([, n]) => n > 0).map(([p]) => p);

describe("A03b native launcher: a run, its files, its record and the revoke read back on every path out", () => {
  test("the home desktop (plan 12.5): the backend knows the mode, records it for a run, and refuses a mode it does not know", async () => {
    const host = new SimHost();
    host.script = { out: "x", windowStation: "home-desktop" };
    const { job, jobDir } = jobFor(host);
    const out = await runNativeJob(host, job, "in", jobDir);
    assert.equal(out.exitCode, 0);
    const rec = record(host, job);
    assert.equal(rec.failure, undefined);
    assert.equal(rec.windowStation, "home-desktop");
    const priv = new SimHost();
    priv.script = { windowStation: "private" };
    const p = jobFor(priv);
    await runNativeJob(priv, p.job, "in", p.jobDir);
    assert.equal(record(priv, p.job).windowStation, "private");
    const none = new SimHost();
    const n = jobFor(none);
    await runNativeJob(none, n.job, "in", n.jobDir);
    assert.equal("windowStation" in record(none, n.job), false, "an older launcher that names no mode records none");
    for (const bad of ["inherit", "winsta0", "Private", "home-desktop2"]) {
      const h = new SimHost();
      h.script = { windowStation: bad };
      const j = jobFor(h);
      await runNativeJob(h, j.job, "in", j.jobDir).catch(() => undefined);
      assert.equal(record(h, j.job).failure?.kind, "launcher", bad);
      assert.match(record(h, j.job).failure?.message ?? "", /window-object mode this backend does not know/, bad);
      assert.equal("windowStation" in record(h, j.job), false, "an unknown word is never recorded as a mode");
    }
  });

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
    assert.deepEqual((await revokeAndReadBack(host, settings(), [], { name: "NimbleNewtRun-0123456789abcdef" })).state, "clean");
    host.script = {};
    const silent = { ...host, run: async () => ok("") } as unknown as NativeHost;
    assert.equal((await revokeAndReadBack(silent, settings(), [{ mode: "modify", path: TASK, soft: false, why: "home" }], { name: "NimbleNewtRun-0123456789abcdef" })).state, "unreadable");
  });
});

describe("A03b native launcher: the sweep after a restart, and the cleanup after a kill", () => {
  const leftover = (host: SimHost, runnerPid: number | undefined, id = "old-run-0001"): { dir: string; job: NativeJob } => {
    const { job: made } = jobFor(host);
    const dir = `${CONTROL}\\jobs\\${id}`;
    const name = `NimbleNewtRun-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
    const job: NativeJob = { ...made, runId: id, profile: runProfileFor(made.settings, name) };
    host.mkdirp(dir);
    host.writeText(jobFile(dir), JSON.stringify(job));
    if (runnerPid !== undefined) {
      host.writeText(`${dir}\\status.json`, JSON.stringify({ runnerPid }));
      // what a run that got as far as the launcher leaves: the backend's record, the launcher's record and the profile itself
      host.mkdirp(profilesDir(made.settings));
      host.writeText(`${profilesDir(made.settings)}\\${name}.json`, JSON.stringify({ version: 1, name, runId: id, jobDir: dir, pid: runnerPid, at: new Date().toISOString(), grants: job.grants, folders: job.claim }));
      host.writeText(job.profile.record, `nn-run-profile v1\n${name} ${simSid(name)}\n`);
      host.profiles.add(name);
    }
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
    markStarted(host, job, jobDir, { runnerPid: 900 });
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
    markStarted(host, third.job, third.jobDir, { runnerPid: 900 }); // its runner had started (only then can a grant exist) and was killed
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
    assert.ok((h.notes ?? []).some((n) => /private window station and desktop made for it/.test(n)), "the probe says each run gets its own window station");
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
    // a host that cannot make the private window station: the launcher's `info` says so and the reason is named (not "the container profile")
    const noStation = new SimHost();
    const realRun = noStation.run.bind(noStation);
    noStation.run = async (file: string, args: readonly string[], o?: { readonly signal?: AbortSignal }): Promise<ProcessResult> => (args[0] === "info"
      ? ok(`${JSON.stringify({ tool: "nn-appc-launcher", ok: false, stage: "grant", error: "window objects: the private window station could not be made (error 5)", windowStation: "private", windowStationOk: false, windowStationError: "window objects: the private window station could not be made (error 5)" })}\n`)
      : realRun(file, args, o));
    const refused = await healthy(noStation).health();
    assert.equal(refused.healthy, false);
    assert.match(refused.reason ?? "", /could not make a private window station and desktop for the container \(window objects: the private window station could not be made \(error 5\)\)/);
    // the home desktop was tried and failed too: the reason names the home desktop and carries both refusals (not the named station's wording alone)
    const noHome = new SimHost();
    const realRunHome = noHome.run.bind(noHome);
    const homeErr = "window objects: the home desktop refused: the launcher runs in session 0 (after: window objects: the private window station could not be made (error 5))";
    noHome.run = async (file: string, args: readonly string[], o?: { readonly signal?: AbortSignal }): Promise<ProcessResult> => (args[0] === "info"
      ? ok(`${JSON.stringify({ tool: "nn-appc-launcher", ok: false, stage: "grant", error: homeErr, windowStation: "home-desktop", privateStationError: "window objects: the private window station could not be made (error 5)", windowStationOk: false, windowStationError: homeErr })}\n`)
      : realRunHome(file, args, o));
    const homeRefused = await healthy(noHome).health();
    assert.equal(homeRefused.healthy, false);
    assert.match(homeRefused.reason ?? "", /could not make the home desktop \(a private desktop on the user's own window station WinSta0\)/);
    assert.match(homeRefused.reason ?? "", /session 0/);
    assert.match(homeRefused.reason ?? "", /the named private window station before it: window objects: the private window station could not be made \(error 5\)/);
    assert.doesNotMatch(homeRefused.reason ?? "", /could not make a private window station and desktop/);
    // the non-elevated user's case: the named station was refused, the launcher made a private desktop on WinSta0 and says so; the backend is healthy and the note states what stays shared
    const homeHost = new SimHost();
    homeHost.script = { onProgram: probeBehaviour("none"), windowStation: "home-desktop" };
    const homeHealth = await healthy(homeHost).health();
    assert.equal(homeHealth.healthy, true, homeHealth.reason);
    const homeNote = (homeHealth.notes ?? []).find((n) => /private DESKTOP on the user's own window station/.test(n)) ?? "";
    assert.match(homeNote, /error 5/);
    assert.match(homeNote, /clipboard and the atom table .* stay shared .* accepted exposure/);
    assert.ok(!(homeHealth.notes ?? []).some((n) => /private window station and desktop made for it/.test(n)), "the named-station note is not claimed for the home desktop");
    // a launcher that names no mode is not described as having the named private station (nothing is claimed that the line did not say)
    const silent = new SimHost();
    silent.script = { onProgram: probeBehaviour("none"), windowStation: "" };
    const silentHealth = await healthy(silent).health();
    assert.equal(silentHealth.healthy, true, silentHealth.reason);
    assert.ok(!(silentHealth.notes ?? []).some((n) => /private window station and desktop made for it|private DESKTOP on the user's own/.test(n)), "no mode is claimed");
    assert.ok((silentHealth.notes ?? []).some((n) => /did not name their mode/.test(n)));
    // a mode this backend does not know is unhealthy, never passed
    for (const bad of ["inherit", "winsta0", "Home-Desktop"]) {
      const odd = new SimHost();
      odd.script = { onProgram: probeBehaviour("none"), windowStation: bad };
      const r = await healthy(odd).health();
      assert.equal(r.healthy, false, bad);
      assert.match(r.reason ?? "", /window-object mode this backend does not know/);
    }
    const dirty = new SimHost();
    dirty.script = { stubborn: () => true };
    const { dir, job } = ((): { dir: string; job: NativeJob } => { const j = jobFor(dirty).job; const d = `${CONTROL}\\jobs\\old-run-0001`; dirty.writeText(jobFile(d), JSON.stringify(j)); markStarted(dirty, j, d, { runnerPid: 7 }); return { dir: d, job: j }; })();
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
      markStarted(sweepHost, { ...j2, runId: id } as NativeJob, dir, { runnerPid: pid, runId: id, startedAt });
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
    markStarted(host, first.job, first.jobDir, { runnerPid: 900, runId: first.job.runId, startedAt: at });
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
    markStarted(host, old.job, old.jobDir, { runnerPid: 900, runId: old.job.runId });
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
      markStarted(host, old.job, old.jobDir, { runnerPid: 900, runId: old.job.runId, startedAt: new Date(Date.now() - 60_000).toISOString() });
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

describe("A03b slice 4: the controller's channel across the container boundary (a file relay), end to end through runNativeJob", () => {
  // Real files on this machine stand in for the container's folder: each simulated Windows path maps to one file in a temporary folder. The "program" is the worker's own channel library (or a real node
  // process that uses it), so the two sides really run at the same time over real files. What a real container does with those files (its access, sharing, caching) is not measured here.
  const rig = (): { base: string; map: (p: string) => string; fsFor: (host: SimHost) => ChannelFs; done: () => void } => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "nn-chan-")));
    const map = (p: string): string => join(base, createHash("sha1").update(p.toLowerCase()).digest("hex"));
    // The folder itself lives in the simulated host; its two files are real (mapped) files.
    const fsFor = (host: SimHost): ChannelFs => ({ create: (p) => nodeChannelFs.create(map(p)), removeFolder: (dir, files) => { for (const f of files) rmSync(map(f), { force: true }); host.remove(dir); return true; } });
    return { base, map, fsFor, done: () => rmSync(base, { recursive: true, force: true }) };
  };
  const SMALL = { maxBytes: 64 * 1024, maxFrames: 1000, maxPayload: 4096, windowBytes: 16 * 1024, heartbeatMs: 1000, stallMs: 30_000 };
  const interactive = (host: SimHost, extra: Partial<WindowsNativeOptions> = {}, r: NormalizedRecipe = recipe()): { job: NativeJob; jobDir: string; backend: SandboxBackend; plan: SpawnPlan; channel: ChannelJob } => {
    const backend = windowsNativeBackend(options(host, { channelLimits: SMALL, ...extra }));
    const plan = backend.plan(r, ["/inputs/tools/tool.exe"], "run-0001-aaaa", { interactive: true });
    const jobDir = plan.env["NIMBLENEWT_NATIVE_JOB"]!;
    const job = JSON.parse(host.readText(jobFile(jobDir))!) as NativeJob;
    return { job, jobDir, backend, plan, channel: job.channel! };
  };
  const ports = (): { ports: ChannelPorts; input: PassThrough; lines: string[] } => {
    const input = new PassThrough(); const lines: string[] = [];
    return { input, lines, ports: { input, output: { write: async (t) => { lines.push(t); } } } };
  };
  const until = async (condition: () => boolean, what: string): Promise<void> => {
    const end = Date.now() + 10_000;
    while (!condition()) { if (Date.now() > end) assert.fail(`waited for: ${what}`); await new Promise((r) => setTimeout(r, 2)); }
  };
  /** The in-container worker: echoes each line it is sent as `{t:"echo", ...}` until its input ends, then closes. */
  const echoWorker = (map: (p: string) => string, channel: ChannelJob): (() => Promise<void>) => async () => {
    const ch = openWorkerFileChannel({ inbox: map(channel.inbox), outbox: map(channel.outbox), pollMinMs: 1, pollMaxMs: 4 });
    try { for await (const line of ch.input) ch.write(`${JSON.stringify({ t: "echo", got: JSON.parse(line.toString("utf8")) })}\n`); } finally { ch.close(); }
  };

  test("the plan: a streamed run gets a channel folder in the task's scratch and the two names in its environment (last, so a recipe cannot name others); a plain run gets none; the backend declares it can stream", () => {
    const host = new SimHost();
    const backend = windowsNativeBackend(options(host));
    assert.equal(backend.interactiveInput, true);
    const plain = prepared(host).job;
    assert.equal(plain.channel, undefined);
    assert.ok(!plain.args.join("\n").includes("NIMBLENEWT_CHANNEL"));
    const { job, channel } = interactive(host, {}, recipe({ env: { LANG: "en", [FILE_CHANNEL_ENV.inbox]: "C:\\Windows\\win.ini" } }));
    assert.ok(channel.dir.toLowerCase().startsWith(`${TASK}\\scratch\\`.toLowerCase()));
    assert.deepEqual([channel.inbox, channel.outbox], [`${channel.dir}\\to-worker.nnc`, `${channel.dir}\\from-worker.nnc`]);
    const envArgs = job.args.filter((a) => a.startsWith("NIMBLENEWT_CHANNEL_"));
    assert.ok(envArgs.includes(`${FILE_CHANNEL_ENV.inbox}=${channel.inbox}`));
    assert.ok(envArgs.includes(`${FILE_CHANNEL_ENV.outbox}=${channel.outbox}`));
    assert.equal(envArgs.filter((a) => a.startsWith(`${FILE_CHANNEL_ENV.inbox}=`)).length, 1, "the recipe's own value is gone");
    assert.ok(!job.args.join("\n").includes("win.ini"));
    // the controller's input is not copied into the standard-input file: it travels through the channel
    assert.throws(() => windowsNativeBackend(options(host, { channelLimits: { maxPayload: 100, windowBytes: 150 } })), /windowBytes/);
    assert.throws(() => windowsNativeBackend(options(host, { channelLimits: { heartbeatMs: 0 } })), /heartbeatMs/);
  });

  test("the launcher asks for a channel exactly when the request streams, and the native backend is no longer refused", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "nn-native-")));
    try {
      const d = (n: string): string => { const p = join(base, n); mkdirSync(p); return p; };
      const r = { mode: "sandboxed" as const, workdir: d("w"), home: d("h"), scratch: d("s"), readOnly: [], network: "none" as const, env: {}, protectedSubpaths: [] };
      const native = windowsNativeBackend(options(new SimHost()));
      const asked: (boolean | undefined)[] = [];
      const stand: SandboxBackend = { ...native, health: async (): Promise<BackendHealth> => ({ healthy: true, backend: native.name }), plan: (_r, _c, _id, o) => { asked.push(o?.interactive); return { file: process.execPath, args: ["-e", "0"], env: {} }; } };
      const launcher = await SandboxLauncher.create({ backend: stand, protectedPaths: [], audit: () => undefined });
      await (await launcher.launch({ recipe: r, command: ["/x"], timeoutMs: 5000, maxOutputBytes: 100, stream: { onStdout: () => undefined } })).result;
      await (await launcher.launch({ recipe: r, command: ["/x"], timeoutMs: 5000, maxOutputBytes: 100 })).result;
      assert.deepEqual(asked, [true, true, false, false], "planned twice per launch");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test("a conversation: lines go in and come back in order while the program runs; at the end the program's exit code, a clean revoke, a record with counts only and no leftovers", async () => {
    const t = rig();
    try {
      const host = new SimHost();
      host.channelFs = t.fsFor(host);
      const { job, jobDir, channel } = interactive(host);
      host.script = { exitCode: 0, out: "stray text the program printed\n", onProgram: echoWorker(t.map, channel) };
      const p = ports();
      const running = runNativeJob(host, job, undefined, jobDir, p.ports);
      p.input.write('{"t":"hello","n":1}\n');
      await until(() => p.lines.length === 1, "first reply");
      p.input.write('{"t":"hello","n":2}\n{"t":"hello","n":3}\n');
      await until(() => p.lines.length === 3, "all replies");
      assert.deepEqual(p.lines.map((l) => (JSON.parse(l) as { got: { n: number } }).got.n), [1, 2, 3]);
      p.input.end();
      const out = await running;
      assert.equal(out.exitCode, 0);
      assert.equal(out.stdout, "", "nothing but relayed lines may reach the controller's output");
      assert.match(out.stderr, /\[program standard output, not relayed\] stray text/);
      assert.deepEqual(hasEntries(host), []);
      assert.ok(lockFree(host));
      const rec = record(host, job);
      assert.equal(rec.failure, undefined);
      assert.equal(rec.readBack, "clean");
      assert.equal(rec.channel?.workerEnded, true);
      assert.ok((rec.channel?.framesFromWorker ?? 0) >= 5, "three replies, at least one acknowledgement, the end");
      assert.ok(!JSON.stringify(rec).includes("hello"), "the record holds counts, never content");
      assert.equal(host.exists(channel.dir), false, "the channel folder is removed");
      assert.deepEqual(host.seenStdin, [""], "standard input stays an empty file");
    } finally { t.done(); }
  });

  test("a real worker process on the other side of the files: round trips, then the end of input ends it", async () => {
    const t = rig();
    try {
      const host = new SimHost();
      host.channelFs = t.fsFor(host);
      const { job, jobDir, channel } = interactive(host);
      const lib = pathToFileURL(createRequire(import.meta.url).resolve("@nimblenewt/contracts")).href;
      const code = `import { openWorkerFileChannel } from ${JSON.stringify(lib)};
const ch = openWorkerFileChannel({ inbox: process.argv[1], outbox: process.argv[2], pollMinMs: 1, pollMaxMs: 4 });
try { for await (const l of ch.input) ch.write(JSON.stringify({ t: "echo", n: JSON.parse(l.toString("utf8")).n }) + "\\n"); } finally { ch.close(); }
`;
      host.script = {
        onProgram: () => new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", code, t.map(channel.inbox), t.map(channel.outbox)], { stdio: ["ignore", "ignore", "pipe"] });
          let err = "";
          child.stderr.on("data", (c: Buffer) => { err += c.toString(); });
          child.on("close", (c) => { if (c === 0) resolve(); else reject(new Error(`worker exit ${String(c)}: ${err}`)); });
        }),
      };
      const p = ports();
      const running = runNativeJob(host, job, undefined, jobDir, p.ports);
      for (let n = 1; n <= 20; n++) { p.input.write(`{"n":${n}}\n`); }
      await until(() => p.lines.length === 20, "twenty replies from the other process");
      assert.deepEqual(p.lines.map((l) => (JSON.parse(l) as { n: number }).n), Array.from({ length: 20 }, (_, i) => i + 1));
      p.input.end();
      const out = await running;
      assert.deepEqual([out.exitCode, out.stderr], [0, ""]);
      assert.equal(record(host, job).channel?.workerEnded, true);
    } finally { t.done(); }
  });

  test("a program that writes something that is not a frame ends the run as a typed channel failure; the program is stopped, the grants are still revoked and read back", async () => {
    const t = rig();
    try {
      const host = new SimHost();
      host.channelFs = t.fsFor(host);
      const { job, jobDir, channel } = interactive(host);
      let stopped = false;
      host.script = { exitCode: 0, onProgram: async (_a, _h, signal) => { appendFileSync(t.map(channel.outbox), "this is not a frame and is long enough\n"); await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); signal?.addEventListener("abort", () => resolve()); }); stopped = true; } };
      const p = ports();
      const out = await runNativeJob(host, job, undefined, jobDir, p.ports);
      assert.equal(stopped, true, "the launcher was asked to stop");
      assert.equal(out.exitCode, EXIT_FAILED);
      assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: channel: .*broke the channel`));
      assert.equal(record(host, job).failure?.kind, "channel");
      assert.deepEqual(hasEntries(host), []);
      assert.ok(lockFree(host));
      assert.deepEqual(p.lines, []);
    } finally { t.done(); }
  });

  test("a program that fills its outbox past the bound, and one whose file is swapped for another under the same name, are both ended", async () => {
    const t = rig();
    try {
      for (const kind of ["fills", "swapped"] as const) {
        const host = new SimHost();
        host.channelFs = t.fsFor(host);
        const { job, jobDir, channel } = interactive(host);
        host.script = {
          onProgram: async (_a, _h, signal) => {
            const file = t.map(channel.outbox);
            if (kind === "fills") appendFileSync(file, Buffer.concat(Array.from({ length: 400 }, (_, i) => encodeFrame(i + 1, "m", JSON.stringify({ t: "fill", pad: "x".repeat(300) })))));
            else if (process.platform !== "win32") { writeFileSync(`${file}.other`, ""); renameSync(`${file}.other`, file); }
            else { /* whether a name held open by node (which shares delete) can be replaced on Windows is not measured here: the name check is exercised off Windows */ appendFileSync(file, "x".repeat(10) + "\n" + "y".repeat(30)); }
            await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); signal?.addEventListener("abort", () => resolve()); });
          },
        };
        const out = await runNativeJob(host, job, undefined, jobDir, ports().ports);
        assert.equal(out.exitCode, EXIT_FAILED, kind);
        assert.match(out.stderr, kind === "fills" ? /larger than the channel allows/ : process.platform !== "win32" ? /replaced or removed/ : /broke the channel/, kind);
        assert.equal(record(host, job).failure?.kind, "channel", kind);
        rmSync(t.map(channel.outbox), { force: true });
        rmSync(t.map(channel.inbox), { force: true });
      }
    } finally { t.done(); }
  });

  test("names the container left behind are not followed: a taken name stops the run before the program starts and before any grant is made", async () => {
    const host = new SimHost();
    const { job, jobDir } = interactive(host);
    let made = 0;
    host.channelFs = { create: () => { made++; return made === 1 ? { size: () => 0, read: () => Buffer.alloc(0), append: () => undefined, stillNamed: () => true, close: () => undefined } : undefined; }, removeFolder: () => true };
    const out = await runNativeJob(host, job, undefined, jobDir, ports().ports);
    assert.equal(out.exitCode, EXIT_FAILED);
    assert.match(out.stderr, /channel: the channel could not be set up: the outbox name is taken/);
    assert.equal(host.calls.filter((c) => c.args[0] === "run").length, 0, "the launcher never ran");
    assert.deepEqual(hasEntries(host), []);
    // the host cannot make channel files, or the folder is a link: also refused
    const bare = new SimHost();
    const b = interactive(bare);
    const noFs = await runNativeJob(bare, b.job, undefined, b.jobDir, ports().ports);
    assert.match(noFs.stderr, /channel: the channel could not be set up: this host cannot make channel files/);
    const linked = new SimHost();
    linked.channelFs = { create: () => undefined, removeFolder: () => true };
    const l = interactive(linked);
    linked.links.add(key(l.channel.dir));
    assert.match((await runNativeJob(linked, l.job, undefined, l.jobDir, ports().ports)).stderr, /the channel folder is a link/);
    const noPorts = new SimHost();
    noPorts.channelFs = rig().fsFor(noPorts);
    const n = interactive(noPorts);
    assert.match((await runNativeJob(noPorts, n.job, undefined, n.jobDir)).stderr, /no pipes of the controller/);
  });

  test("second review: the channel folder is removed without following links, only after the revoke has been read back; a leftover that cannot be removed that way stops the run before anything starts", async () => {
    const t = rig();
    try {
      const host = new SimHost();
      const order: string[] = [];
      const base = t.fsFor(host);
      let leftAtStart = false;
      let leftAtEnd = false;
      host.channelFs = { create: (p) => base.create(p), removeFolder: (dir, files) => { order.push(`remove:${String(host.calls.filter((c) => c.args[0] === "revoke" || c.args[0] === "check").length)}`); if (order.length === 1 ? leftAtStart : leftAtEnd) return false; return base.removeFolder(dir, files); } };
      const { job, jobDir, channel } = interactive(host);
      host.script = { exitCode: 0, onProgram: echoWorker(t.map, channel) };
      const p = ports();
      const running = runNativeJob(host, job, undefined, jobDir, p.ports);
      p.input.end();
      assert.equal((await running).exitCode, 0);
      const revokes = host.calls.filter((c) => c.args[0] === "revoke" || c.args[0] === "check").length;
      assert.ok(revokes >= 1, "the revoke was read back");
      assert.deepEqual(order, ["remove:0", `remove:${String(revokes)}`], "once before the run, once after every revoke");
      // the end-of-run removal leaves the folder: noted, not a failure
      const again = new SimHost();
      order.length = 0; leftAtEnd = true;
      const b2 = t.fsFor(again);
      again.channelFs = { create: (q) => b2.create(q), removeFolder: (dir, files) => { order.push("x"); return order.length === 1 ? b2.removeFolder(dir, files) : false; } };
      const j2 = interactive(again);
      again.script = { exitCode: 0, onProgram: echoWorker(t.map, j2.channel) };
      const p2 = ports();
      const r2 = runNativeJob(again, j2.job, undefined, j2.jobDir, p2.ports);
      p2.input.end();
      const o2 = await r2;
      assert.equal(o2.exitCode, 0);
      assert.match(record(again, j2.job).channel?.note ?? "", /channel folder was left/);
      assert.match(o2.stderr, /\[channel\] .*channel folder was left/);
      // a leftover at the start: refused before the launcher or any grant
      const third = new SimHost();
      leftAtStart = true;
      third.channelFs = { create: () => assert.fail("nothing is made"), removeFolder: () => false };
      const j3 = interactive(third);
      const o3 = await runNativeJob(third, j3.job, undefined, j3.jobDir, ports().ports);
      assert.equal(o3.exitCode, EXIT_FAILED);
      assert.match(o3.stderr, /channel: the channel could not be set up: a leftover channel folder could not be removed/);
      assert.equal(third.calls.filter((c) => c.args[0] === "run").length, 0);
      assert.deepEqual(hasEntries(third), []);
    } finally { t.done(); }
  });

  test("the runner: for a streamed job it does not read the input to its end, relays through the pipes it is given, and writes only a failure line to standard error", async () => {
    const t = rig();
    try {
      const host = new SimHost();
      host.channelFs = t.fsFor(host);
      const { job, jobDir, channel } = interactive(host);
      host.writeText(jobFile(jobDir), JSON.stringify(job));
      host.script = { exitCode: 3, onProgram: echoWorker(t.map, channel) };
      const p = ports();
      const writes: string[] = [];
      const io = { out: (x: string) => { writes.push(`o:${x}`); }, err: (x: string) => { writes.push(`e:${x}`); } };
      const never = async (): Promise<string> => assert.fail("a streamed run does not read standard input to its end");
      const running = runnerMain(["node", "runner", jobFile(jobDir)], host, never, io, () => p.ports);
      p.input.write('{"q":1}\n');
      await until(() => p.lines.length === 1, "a reply");
      p.input.end();
      assert.equal(await running, 3);
      assert.deepEqual(writes.filter((w) => w.startsWith("o:")), []);
      // a streamed job file whose channel is damaged is refused, not guessed
      host.writeText("C:\\badchan.json", JSON.stringify({ ...job, channel: { ...channel, maxBytes: "x" } }));
      const refused = await runnerMain(["node", "runner", "C:\\badchan.json"], host, async () => "", { out: () => undefined, err: (x) => { writes.push(x); } }, () => p.ports);
      assert.equal(refused, 70);
      assert.match(writes.at(-1)!, /channel unreadable/);
    } finally { t.done(); }
  });
});

describe("A03b slice 4: the real channel files (node's own calls)", () => {
  test("the runner's ports: a line is written whole and the write is finished before it resolves; a closed pipe rejects the write", async () => {
    const out = new PassThrough();
    const seen: string[] = [];
    out.on("data", (c: Buffer) => { seen.push(c.toString()); });
    const ports = processPorts(out, new PassThrough());
    await ports.output.write('{"a":1}\n');
    assert.deepEqual(seen, ['{"a":1}\n']);
    out.destroy();
    await assert.rejects(ports.output.write("late\n"));
  });

  test("a file is made exclusively and kept open: a taken name is refused, reads and appends are by position, a name swapped for another file or a link is noticed, a hard link is never the file", () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nn-chfs-")));
    try {
      const name = join(dir, "box");
      const f = nodeChannelFs.create(name)!;
      assert.equal(nodeChannelFs.create(name), undefined, "an existing name is refused, never opened");
      f.append(Buffer.from("hello "));
      f.append(Buffer.from("world"));
      assert.equal(f.size(), 11);
      assert.equal(f.read(6, 100).toString(), "world");
      assert.equal(f.read(0, 5).toString(), "hello");
      assert.equal(f.read(11, 5).length, 0);
      assert.equal(f.stillNamed(), true);
      // another process (the container) appends through its own handle: seen through ours
      appendFileSync(name, "!");
      assert.equal(f.size(), 12);
      if (process.platform !== "win32") {
        writeFileSync(`${name}.x`, "other"); renameSync(`${name}.x`, name);
        assert.equal(f.stillNamed(), false, "another file under the name");
        assert.equal(readFileSync(name, "utf8"), "other", "and we never wrote to it");
        rmSync(name); symlinkSync(join(dir, "elsewhere"), name);
        assert.equal(f.stillNamed(), false, "a link under the name");
      }
      f.close();
      f.close();
      const g = nodeChannelFs.create(join(dir, "box2"))!;
      linkSync(join(dir, "box2"), join(dir, "box2-link"));
      assert.equal(g.stillNamed(), false, "a second name for the file");
      g.close();
      assert.equal(existsSync(join(dir, "box2")), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("second review: a file's identity is its exact BigInt number on its volume; a file system that gives the number 0 is refused, never trusted", () => {
    const st = (o: Partial<{ file: boolean; link: boolean; nlink: bigint; ino: bigint; dev: bigint }> = {}): ChannelStat => ({ isFile: () => o.file ?? true, isSymbolicLink: () => o.link ?? false, nlink: o.nlink ?? 1n, ino: o.ino ?? 2n ** 60n + 1n, dev: o.dev ?? 7n });
    assert.equal(channelFileRefusal(st()), undefined);
    assert.match(channelFileRefusal(st({ ino: 0n }))!, /no identity/);
    assert.match(channelFileRefusal(st({ nlink: 2n }))!, /one name/);
    assert.match(channelFileRefusal(st({ file: false }))!, /plain file/);
    assert.equal(sameChannelFile(st(), st()), true);
    // 2^60 and 2^60 + 1 are the same double: compared as numbers they would match
    assert.equal(Number(2n ** 60n), Number(2n ** 60n + 1n));
    assert.equal(sameChannelFile(st(), st({ ino: 2n ** 60n })), false, "a file number that differs only beyond 2^53");
    assert.equal(sameChannelFile(st({ ino: 0n }), st({ ino: 0n })), false, "no number, no match");
    assert.equal(sameChannelFile(st(), st({ dev: 8n })), false, "another volume");
    assert.equal(sameChannelFile(st(), st({ nlink: 2n })), false, "a second name");
    assert.equal(sameChannelFile(st(), st({ link: true })), false, "a link");
  });

  test("second review: the channel folder's removal never follows a link and never recurses (stand-in calls with Windows paths, so the rules hold on every OS)", () => {
    const D = "C:\\task\\scratch\\.nn-ch-run-0001-aaa";
    const files = [`${D}\\to-worker.nnc`, `${D}\\from-worker.nnc`];
    const sim = (entries: Record<string, "link" | "dir" | "file">, opts: { through?: string[]; unlinkDirLink?: "EPERM" | "ok" } = {}): { ops: FolderOps; calls: string[]; entries: Record<string, "link" | "dir" | "file"> } => {
      const calls: string[] = [];
      const e = { ...entries };
      const has = (p: string): boolean => Object.keys(e).some((k) => k.startsWith(`${p}\\`));
      const ops: FolderOps = {
        lstat: (p) => e[p],
        unlink: (p) => { calls.push(`unlink ${p}`); if (e[p] === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" }); if (e[p] === "dir" || (e[p] === "link" && opts.unlinkDirLink === "EPERM")) throw Object.assign(new Error("dir"), { code: "EPERM" }); delete e[p]; },
        rmdir: (p) => { calls.push(`rmdir ${p}`); if (e[p] === "dir" && has(p)) throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" }); delete e[p]; },
        throughLink: (p) => (opts.through ?? []).includes(p),
      };
      return { ops, calls, entries: e };
    };
    // nothing there
    assert.equal(removeChannelFolderWith(D, files, sim({}).ops), true);
    // a plain folder with the two files: they and then the folder go
    const plain = sim({ [D]: "dir", [files[0]!]: "file", [files[1]!]: "file" });
    assert.equal(removeChannelFolderWith(D, files, plain.ops), true);
    assert.deepEqual(plain.calls, [`unlink ${files[0]!}`, `unlink ${files[1]!}`, `rmdir ${D}`]);
    // a junction in the folder's place (unlink refuses a directory link on Windows): only the link itself is removed, nothing behind it is touched
    const junction = sim({ [D]: "link" }, { unlinkDirLink: "EPERM" });
    assert.equal(removeChannelFolderWith(D, files, junction.ops), true);
    assert.deepEqual(junction.calls, [`unlink ${D}`, `rmdir ${D}`]);
    // something else of the container's in the folder: never removed, and the folder is left (reported)
    const extra = sim({ [D]: "dir", [files[0]!]: "file", [`${D}\\other`]: "file", [`${D}\\sub`]: "dir", [`${D}\\sub\\x`]: "file" });
    assert.equal(removeChannelFolderWith(D, files, extra.ops), false);
    assert.deepEqual(extra.calls, [`unlink ${files[0]!}`, `rmdir ${D}`]);
    assert.deepEqual(Object.keys(extra.entries).sort(), [D, `${D}\\other`, `${D}\\sub`, `${D}\\sub\\x`].sort());
    // a folder made under a file's name is not entered
    const asDir = sim({ [D]: "dir", [files[1]!]: "dir", [`${files[1]!}\\inner`]: "file" });
    assert.equal(removeChannelFolderWith(D, files, asDir.ops), false);
    assert.deepEqual(asDir.calls, [`rmdir ${D}`]);
    // a link under a file's name: the link itself goes
    const fileLink = sim({ [D]: "dir", [files[0]!]: "link" });
    assert.equal(removeChannelFolderWith(D, files, fileLink.ops), true);
    assert.deepEqual(fileLink.calls, [`unlink ${files[0]!}`, `rmdir ${D}`]);
    // reached through a link higher up, or the folder's real path differs (a junction or short name on the way): nothing is touched
    const above = sim({ [D]: "dir", [files[0]!]: "file" }, { through: ["C:\\task\\scratch"] });
    assert.equal(removeChannelFolderWith(D, files, above.ops), false);
    assert.deepEqual(above.calls, []);
    const self = sim({ [D]: "dir", [files[0]!]: "file" }, { through: [D] });
    assert.equal(removeChannelFolderWith(D, files, self.ops), false);
    assert.deepEqual(self.calls, []);
    // a name outside the folder is never removed, whatever the caller passes
    const outside = sim({ [D]: "dir", ["C:\\Windows\\win.ini"]: "file" });
    assert.equal(removeChannelFolderWith(D, ["C:\\Windows\\win.ini"], outside.ops), true);
    assert.deepEqual(outside.calls, [`rmdir ${D}`]);
  });

  test("second review: on this machine's real files, a link to a folder put in the channel folder's place is removed itself and what it leads to is untouched (a junction on Windows)", () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "nn-chrm-")));
    try {
      const precious = join(base, "precious");
      mkdirSync(precious);
      writeFileSync(join(precious, "to-worker.nnc"), "keep");
      writeFileSync(join(precious, "data"), "keep");
      const dir = join(base, "ch");
      symlinkSync(precious, dir, process.platform === "win32" ? "junction" : "dir");
      assert.equal(nodeChannelFs.removeFolder(dir, [join(dir, "to-worker.nnc"), join(dir, "from-worker.nnc")]), true);
      assert.equal(existsSync(dir), false, "the link is gone");
      assert.deepEqual([readFileSync(join(precious, "to-worker.nnc"), "utf8"), readFileSync(join(precious, "data"), "utf8")], ["keep", "keep"], "nothing behind it was removed");
      // a plain folder with the two files and something else: the two go, the rest and the folder stay
      mkdirSync(dir);
      writeFileSync(join(dir, "to-worker.nnc"), "a"); writeFileSync(join(dir, "from-worker.nnc"), "b"); mkdirSync(join(dir, "sub")); writeFileSync(join(dir, "sub", "x"), "x");
      assert.equal(nodeChannelFs.removeFolder(dir, [join(dir, "to-worker.nnc"), join(dir, "from-worker.nnc")]), false);
      assert.deepEqual(readdirSync(dir).sort(), ["sub"]);
      rmSync(join(dir, "sub"), { recursive: true });
      assert.equal(nodeChannelFs.removeFolder(dir, [join(dir, "to-worker.nnc"), join(dir, "from-worker.nnc")]), true);
      assert.equal(existsSync(dir), false);
      assert.equal(nodeChannelFs.removeFolder(dir, []), true, "nothing there");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------------------------------------------- per-run container profiles (card A03b)

describe("A03b per-run container profile: names, the lifecycle order, a delete that fails, the sweep of a crash, a profile with no record", () => {
  const CLAIMS = `${CONTROL}\\claims`;
  const PROFILES = `${CONTROL}\\profiles`;
  const names = (host: SimHost): string[] => host.listDir(PROFILES).map((n) => n.toLowerCase()); // the simulated folder lists lower-case names
  const runName = (call: { args: string[] }): string => call.args[call.args.indexOf("--name") + 1]!;
  const cmds = (host: SimHost): string[] => host.calls.map((c) => c.args[0]!);
  /** A second job on the same task folders with an id (and so a job folder) of its own. */
  const another = (host: SimHost, id: string): { job: NativeJob; jobDir: string } => {
    const plan = windowsNativeBackend(options(host)).plan(recipe(), ["/inputs/tools/tool.exe"], id);
    const jobDir = plan.env["NIMBLENEWT_NATIVE_JOB"]!;
    return { job: JSON.parse(host.readText(jobFile(jobDir))!) as NativeJob, jobDir };
  };

  test("the name is 64 random bits as hex after NimbleNewtRun-, 30 characters, and only that form is a run name", () => {
    const a = newRunProfileName();
    const b = newRunProfileName();
    assert.match(a, /^NimbleNewtRun-[0-9a-f]{16}$/);
    assert.equal(a.length, 30);
    assert.notEqual(a, b);
    assert.equal(newRunProfileName(() => Buffer.from("0123456789abcdef", "hex")), "NimbleNewtRun-0123456789abcdef");
    assert.throws(() => newRunProfileName(() => Buffer.alloc(4)), /8 random bytes/);
    for (const bad of ["NimbleNewtAgent", "NimbleNewtRun-", "NimbleNewtRun-0123456789ABCDEF", "NimbleNewtRun-0123456789abcdef ", "nimblenewtrun-0123456789abcdef", "NimbleNewtRun-0123456789abcdeg"]) assert.equal(isRunProfileName(bad), false, bad);
  });

  test("the plan gives every run its own name and record path; the launcher's line carries both and the claim names the task's three folders", () => {
    const host = new SimHost();
    const one = prepared(host);
    const two = prepared(host, recipe(), ["/inputs/tools/tool.exe"], {});
    assert.match(one.job.profile.name, /^NimbleNewtRun-[0-9a-f]{16}$/);
    assert.notEqual(one.job.profile.name, two.job.profile.name);
    assert.equal(one.job.profile.record, `${PROFILES}\\${one.job.profile.name}.sid`);
    assert.deepEqual(one.job.claim, [`${TASK}\\work`, `${TASK}\\home`, `${TASK}\\scratch`]);
    assert.deepEqual(one.job.args.slice(1, 5), ["--name", one.job.profile.name, "--profile-record", one.job.profile.record]);
    assert.equal(one.job.settings.maxConcurrentRuns, 1, "one at a time unless asked");
    assert.equal("profileName" in one.job.settings, false, "no shared profile name any more");
  });

  test("a clean run: the records exist while the program runs, the order is run then read-back, the profile and every record are gone afterwards", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    let during: { json: boolean; sid: boolean; profile: boolean; claim: boolean; slot: boolean } | undefined;
    host.script = { onProgram: () => { during = { json: host.exists(`${PROFILES}\\${job.profile.name}.json`), sid: host.exists(job.profile.record), profile: host.profiles.has(job.profile.name), claim: host.exists(`${CLAIMS}\\${job.runId}.json`), slot: !lockFree(host) }; } };
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, 0);
    assert.deepEqual(during, { json: true, sid: true, profile: true, claim: true, slot: true });
    assert.deepEqual(cmds(host), ["run", "check"]);
    assert.equal(host.profiles.size, 0);
    assert.deepEqual(names(host), [], "the backend's record and the launcher's record are removed once the profile is shown gone");
    assert.deepEqual(host.listDir(CLAIMS), []);
    assert.ok(lockFree(host));
    const rec = record(host, job);
    assert.deepEqual(rec.profile, { name: job.profile.name, sid: simSid(job.profile.name), deleted: true, gone: true });
    assert.equal(rec.failure, undefined);
    // every call to the launcher used the run's own name; the read-back named the run's own SID
    for (const c of host.calls) assert.equal(runName(c), job.profile.name);
    assert.equal(host.calls[1]!.args[host.calls[1]!.args.indexOf("--sid") + 1], simSid(job.profile.name));
  });

  test("a launcher whose line does not show the profile gone: the backend reads back first, then asks for the delete itself, with the run's name, SID and record", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    host.script = { profileNotGoneInLine: true };
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, 0);
    assert.deepEqual(cmds(host), ["run", "check", "delete-profile"]);
    const del = host.calls[2]!.args;
    assert.deepEqual(del, ["delete-profile", "--name", job.profile.name, "--sid", simSid(job.profile.name), "--profile-record", job.profile.record]);
    assert.deepEqual(names(host), []);
  });

  test("a delete that fails is a typed failure, the records stay, the next run does not start, and a later sweep finishes the job", async () => {
    const host = new SimHost();
    const first = jobFor(host);
    host.script = { profileStuck: true };
    const out = await runNativeJob(host, first.job, undefined, first.jobDir);
    assert.equal(out.exitCode, EXIT_FAILED);
    assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: profile: .*${first.job.profile.name}`));
    assert.deepEqual(names(host).sort(), [`${first.job.profile.name}.json`, `${first.job.profile.name}.sid`].map((n) => n.toLowerCase()), "kept for the sweep");
    assert.ok(host.profiles.has(first.job.profile.name));
    const rec = record(host, first.job);
    assert.equal(rec.failure?.kind, "profile");
    assert.equal(rec.profile?.gone, false);
    assert.equal(rec.readBack, "clean", "the entries themselves were revoked");
    assert.ok(lockFree(host) && host.listDir(CLAIMS).length === 0, "the slot and the claim are released on this path too");
    assert.ok(host.exists(`${first.jobDir}\\status.json`), "the job folder stays too");
    // still stuck: nothing is removed, the problem is named, and a new run is refused before it makes a profile
    const swept = await sweepLeftoversLocked(host, first.job.settings);
    assert.equal(swept.released, 0);
    assert.match(swept.problems.join(" "), new RegExp(first.job.profile.name));
    const second = another(host, "run-0002-bbbb");
    const before = host.calls.length;
    const refused = await runNativeJob(host, second.job, undefined, second.jobDir);
    assert.match(refused.stderr, new RegExp(`^${FAILURE_PREFIX}: revoke: an earlier run's entries or container profile`));
    assert.equal(host.calls.slice(before).filter((c) => c.args[0] === "run").length, 0, "no new run, no new profile");
    // the delete works again: the next run sweeps the leftover first (delete-profile of the OLD name) and then runs
    host.script = {};
    const third = another(host, "run-0003-cccc");
    assert.equal((await runNativeJob(host, third.job, undefined, third.jobDir)).exitCode, 0);
    assert.equal(host.profiles.size, 0);
    assert.deepEqual(names(host), []);
    assert.ok(host.calls.some((c) => c.args[0] === "delete-profile" && runName(c) === first.job.profile.name));
    assert.equal(host.exists(`${first.jobDir}\\status.json`), false, "the earlier run's job folder is removed once its profile is shown gone");
  });

  test("a crashed run's leftovers are swept from the backend's own records: its entries are revoked by ITS SID and read back, then its profile is deleted", async () => {
    const host = new SimHost();
    const old = jobFor(host);
    markStarted(host, old.job, old.jobDir, { runnerPid: 900, runId: old.job.runId });
    for (const g of old.job.grants) host.entries.set(key(g.path), 1);
    const swept = await sweepLeftoversLocked(host, old.job.settings);
    assert.deepEqual(swept, { released: 1, problems: [], live: [] });
    assert.deepEqual(hasEntries(host), []);
    const order = cmds(host);
    assert.equal(order[order.length - 1], "delete-profile", "the profile goes last");
    assert.ok(order.indexOf("delete-profile") > order.lastIndexOf("revoke") && order.indexOf("delete-profile") > order.lastIndexOf("check"));
    for (const c of host.calls.filter((x) => x.args[0] !== "delete-profile")) assert.equal(c.args[c.args.indexOf("--sid") + 1], simSid(old.job.profile.name), `${c.args[0]} names the crashed run's SID`);
    assert.equal(host.profiles.size, 0);
    assert.deepEqual(names(host), []);
    assert.equal(host.exists(old.jobDir), false);
    // a record with no job folder (the folder was removed or never listed) is swept the same way
    const lone = jobFor(host);
    markStarted(host, lone.job, lone.jobDir, { runnerPid: 901, runId: lone.job.runId });
    host.remove(lone.jobDir);
    for (const g of lone.job.grants) host.entries.set(key(g.path), 1);
    assert.deepEqual((await sweepLeftoversLocked(host, lone.job.settings)).problems, []);
    assert.equal(host.profiles.size, 0);
    assert.deepEqual(names(host), []);
  });

  test("a live run's profile record is left alone by the sweep (the writer is running)", async () => {
    const host = new SimHost();
    const other = jobFor(host);
    host.alive.add(555);
    markStarted(host, other.job, other.jobDir, { runnerPid: 555, runId: other.job.runId, startedAt: new Date(Date.now() - 1000).toISOString() });
    host.procs = [{ pid: 555, parent: 1, started: new Date(Date.now() - 5000).toISOString() }];
    const swept = await sweepLeftoversLocked(host, other.job.settings);
    assert.equal(swept.released, 0);
    assert.deepEqual(swept.live, [other.jobDir]);
    assert.equal(cmds(host).length, 0, "nothing was revoked or deleted");
    assert.ok(host.profiles.has(other.job.profile.name));
  });

  test("nothing is deleted without a record: no launcher record, no backend record, a bad name, a mismatched name, a damaged record", async () => {
    const host = new SimHost();
    const s = settings();
    const mk = (n: string): string => `NimbleNewtRun-${n.repeat(16).slice(0, 16)}`;
    const dead = { pid: 900, at: new Date(Date.now() - 60_000).toISOString() };
    const recordOf = (name: string): string => JSON.stringify({ version: 1, name, runId: `r-${name}`, jobDir: "", ...dead, grants: [{ mode: "modify", path: `${TASK}\\home`, soft: false, why: "home" }], folders: [`${TASK}\\work`] });
    host.mkdirp(PROFILES);
    // (a) the backend's record but no record of the launcher: the launcher never made a profile, so nothing is revoked or deleted (a profile of that name on the machine is not touched)
    const a = mk("a");
    host.writeText(`${PROFILES}\\${a}.json`, recordOf(a));
    host.profiles.add(a);
    // (b) the launcher's record but no backend record: not ours to act on
    const b = mk("b");
    host.writeText(`${PROFILES}\\${b}.sid`, `nn-run-profile v1\n${b} ${simSid(b)}\n`);
    host.profiles.add(b);
    // (c) names that are not run names are never read as records
    host.writeText(`${PROFILES}\\NimbleNewtAgent.json`, recordOf("NimbleNewtAgent"));
    host.writeText(`${PROFILES}\\NimbleNewtRun-XYZ.json`, recordOf("NimbleNewtRun-XYZ"));
    // (d) a record whose own name is another's
    const d = mk("d");
    host.writeText(`${PROFILES}\\${d}.json`, recordOf(mk("e")));
    // (e) a launcher record that is not in the launcher's format
    const e = mk("f");
    host.writeText(`${PROFILES}\\${e}.json`, recordOf(e));
    host.writeText(`${PROFILES}\\${e}.sid`, "NimbleNewtRun-ffffffffffffffff S-1-5-18\n");
    host.profiles.add(e);
    const swept = await sweepLeftoversLocked(host, s);
    assert.equal(host.calls.length, 0, `the launcher was never called: no revoke, no delete: ${JSON.stringify(host.calls)}`);
    assert.ok([a, b, e].every((n) => host.profiles.has(n)), "no profile was deleted");
    assert.equal(host.exists(`${PROFILES}\\${a}.json`), false, "(a) the record of a profile that never existed is dropped");
    assert.ok(host.exists(`${PROFILES}\\${b}.sid`) && host.exists(`${PROFILES}\\NimbleNewtAgent.json`) && host.exists(`${PROFILES}\\NimbleNewtRun-XYZ.json`), "the rest is left as found");
    assert.equal(readProfileRecord(host, s, d), undefined);
    assert.equal(launcherSid(host, s, e), undefined);
    assert.match(swept.problems.join("\n"), new RegExp(`${d}: the profile record is unreadable`));
    assert.match(swept.problems.join("\n"), new RegExp(`${e}: the launcher's profile record is not in the launcher's format`));
    assert.equal(swept.released, 1, "only (a): a record whose profile the launcher never made is dropped");
  });

  test("the retired shared name: the option is refused, the environment's value is ignored with a note, and no launcher call ever carries a name that is not a per-run one", async () => {
    const host = new SimHost();
    assert.throws(() => windowsNativeBackend(options(host, { profileName: "NimbleNewtAgent" })), /profileName: retired/);
    host.script = { onProgram: probeBehaviour() };
    const backend = windowsNativeBackend(options(host, { ignoredProfileSetting: "NimbleNewtAgent" }));
    host.files.set(key(LAUNCHER), "exe"); host.files.set(key(RUNNER), "js");
    const h = await backend.health();
    assert.ok((h.notes ?? []).some((n) => /NIMBLENEWT_WIN_PROFILE is set but retired/.test(n)));
    assert.ok(host.calls.length > 0);
    for (const c of host.calls) assert.match(runName(c), RUN_NAME, c.args[0]);
    assert.ok(host.calls.every((c) => !c.args.includes("NimbleNewtAgent")));
  });

  /** What a correct confinement does with the probe program (as the health tests' own helper). */
  function probeBehaviour(): (args: readonly string[], h: SimHost) => void {
    return (args, h) => {
      const cmd = args[args.indexOf("--cmdline") + 1]!;
      if (!cmd.includes("probe.mjs")) return;
      const [work] = cmd.split(" ").slice(-3).map((x) => x.replace(/^"|"$/g, "")) as [string, string, string];
      h.writeText(`${work}\\ok.txt`, "x");
      h.writeText(args[args.indexOf("--stdout") + 1]!, "confined");
    };
  }

  test("health: the probe's own profile is made and deleted like a run's; one that cannot be deleted makes the backend unhealthy and is swept by the next check", async () => {
    const host = new SimHost();
    host.files.set(key(LAUNCHER), "exe"); host.files.set(key(RUNNER), "js");
    host.script = { onProgram: probeBehaviour() };
    const backend = windowsNativeBackend(options(host));
    assert.equal((await backend.health()).healthy, true);
    const info = host.calls.find((c) => c.args[0] === "info")!;
    assert.match(runName(info), RUN_NAME);
    assert.equal(info.args[info.args.indexOf("--profile-record") + 1], `${PROFILES}\\${runName(info)}.sid`);
    assert.equal(host.profiles.size, 0);
    assert.deepEqual(names(host), []);
    // stuck: unhealthy with the reason, the records stay
    host.script = { profileStuck: true, onProgram: probeBehaviour() };
    const bad = await backend.health();
    assert.equal(bad.healthy, false);
    assert.match(bad.reason ?? "", /container profile could not be deleted/);
    assert.ok(host.profiles.size > 0 && names(host).length > 0);
    // fixed: the next check sweeps what the probe left (its own record is the proof) and is healthy again
    host.script = { onProgram: probeBehaviour() };
    assert.equal((await backend.health()).healthy, true);
    assert.equal(host.profiles.size, 0);
    assert.deepEqual(names(host), []);
  });
});

describe("A03b per-run container profile: how many runs at once, never in one workspace, the slot and claim released on every path", () => {
  const CLAIMS = `${CONTROL}\\claims`;
  const ws = (n: string, extra: Partial<NormalizedRecipe> = {}): NormalizedRecipe => recipe({ workdir: `C:\\Tasks\\${n}\\work`, home: `C:\\Tasks\\${n}\\home`, scratch: `C:\\Tasks\\${n}\\scratch`, ...extra });
  const planned = (host: SimHost, r: NormalizedRecipe, id: string, extra: Partial<WindowsNativeOptions> = {}): { job: NativeJob; jobDir: string } => {
    const backend = windowsNativeBackend(options(host, extra));
    const plan = backend.plan(r, ["/inputs/tools/tool.exe"], id);
    const jobDir = plan.env["NIMBLENEWT_NATIVE_JOB"]!;
    return { job: JSON.parse(host.readText(jobFile(jobDir))!) as NativeJob, jobDir };
  };
  const slotsFree = (host: SimHost, n: number): boolean => { for (let i = 0; i < n; i++) { const ns = host.listDir(slotDir(settings(), i)).filter((x) => /^\d+$/.test(x)).map(Number); if (ns.length > 0 && host.readText(`${slotDir(settings(), i)}\\${Math.max(...ns)}.released`) === undefined) return false; } return true; };
  /** Holds every started program until `release()`; `entered()` counts programs inside. */
  const gate = (host: SimHost): { release: () => void; entered: () => number; whenEntered: (n: number) => Promise<void> } => {
    let open: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => { open = resolve; });
    let count = 0;
    host.script = { onProgram: async () => { count++; await closed; } };
    return { release: open, entered: () => count, whenEntered: async (n) => { for (let i = 0; i < 400 && count < n; i++) await new Promise((r) => setTimeout(r, 5)); if (count < n) { open(); throw new Error(`${count} programs entered, ${n} wanted`); } } };
  };

  test("the default is one at a time: a second run in ANOTHER workspace is busy while the first is in its program, and runs after it", async () => {
    const host = new SimHost();
    const a = planned(host, ws("a"), "run-0001-aaaa");
    const b = planned(host, ws("b"), "run-0002-bbbb");
    const g = gate(host);
    const first = runNativeJob(host, a.job, undefined, a.jobDir);
    await g.whenEntered(1);
    const busy = await runNativeJob(host, b.job, undefined, b.jobDir);
    assert.equal(busy.exitCode, EXIT_BUSY);
    assert.match(busy.stderr, /another native run is in progress.*one at a time/);
    assert.equal(host.calls.filter((c) => c.args[0] === "run").length, 1, "no second launcher");
    assert.deepEqual(host.listDir(CLAIMS), [`${a.job.runId}.json`], "the refused run holds no claim");
    g.release();
    assert.equal((await first).exitCode, 0);
    host.script = {};
    assert.equal((await runNativeJob(host, b.job, undefined, b.jobDir)).exitCode, 0);
    assert.ok(slotsFree(host, 1) && host.listDir(CLAIMS).length === 0 && host.profiles.size === 0);
  });

  test("with two runs allowed, two different workspaces run at once, each with its own profile and SID, and each revoke names its own SID", async () => {
    const host = new SimHost();
    const a = planned(host, ws("a"), "run-0001-aaaa", { maxConcurrentRuns: 2 });
    const b = planned(host, ws("b"), "run-0002-bbbb", { maxConcurrentRuns: 2 });
    assert.equal(a.job.settings.maxConcurrentRuns, 2);
    const g = gate(host);
    const pa = runNativeJob(host, a.job, undefined, a.jobDir);
    await g.whenEntered(1);
    const pb = runNativeJob(host, b.job, undefined, b.jobDir);
    await g.whenEntered(2);
    // both are inside their programs now: two slots, two claims, two profiles
    assert.equal(host.profiles.size, 2);
    assert.deepEqual(host.listDir(CLAIMS).sort(), [`${a.job.runId}.json`, `${b.job.runId}.json`]);
    assert.ok(!slotsFree(host, 2));
    g.release();
    assert.deepEqual([(await pa).exitCode, (await pb).exitCode], [0, 0]);
    const runs = host.calls.filter((c) => c.args[0] === "run");
    assert.equal(new Set(runs.map((c) => runName(c))).size, 2, "two different profiles");
    for (const job of [a.job, b.job]) {
      const mine = host.calls.filter((c) => c.args[c.args.indexOf("--name") + 1] === job.profile.name);
      assert.deepEqual(mine.map((c) => c.args[0]), ["run", "check"]);
      assert.equal(mine[1]!.args[mine[1]!.args.indexOf("--sid") + 1], simSid(job.profile.name), "the read-back is by the run's own SID");
    }
    assert.ok(slotsFree(host, 2) && host.listDir(CLAIMS).length === 0 && [...host.profiles].length === 0);
    assert.deepEqual(host.listDir(`${CONTROL}\\profiles`), []);
  });

  function runName(c: { args: string[] }): string { return c.args[c.args.indexOf("--name") + 1]!; }

  test("with two runs allowed, the SAME workspace and an OVERLAPPING one are refused as busy (the seal and workspace entries would meet), a third run finds no slot", async () => {
    const host = new SimHost();
    const opt = { maxConcurrentRuns: 2 };
    const a = planned(host, ws("a"), "run-0001-aaaa", opt);
    const same = planned(host, ws("a"), "run-0002-bbbb", opt);
    const inside = planned(host, ws("x", { workdir: "C:\\Tasks\\a\\work\\inner" }), "run-0003-cccc", opt);
    const around = planned(host, ws("y", { workdir: "C:\\Tasks\\a" }), "run-0004-dddd", opt);
    const other = planned(host, ws("b"), "run-0005-eeee", opt);
    const third = planned(host, ws("c"), "run-0006-ffff", opt);
    const g = gate(host);
    const pa = runNativeJob(host, a.job, undefined, a.jobDir);
    await g.whenEntered(1);
    for (const x of [same, inside, around]) {
      const out = await runNativeJob(host, x.job, undefined, x.jobDir);
      assert.equal(out.exitCode, EXIT_BUSY);
      assert.match(out.stderr, /one run at a time per workspace/);
    }
    assert.equal(host.calls.filter((c) => c.args[0] === "run").length, 1, "none of them reached the launcher");
    assert.deepEqual(host.listDir(CLAIMS), [`${a.job.runId}.json`], "a refused run leaves no claim");
    assert.ok(!host.exists(slotDir(settings(), 1) + "\\1") || host.exists(slotDir(settings(), 1) + "\\1.released"), "and gives its slot back");
    const pb = runNativeJob(host, other.job, undefined, other.jobDir);
    await g.whenEntered(2);
    const full = await runNativeJob(host, third.job, undefined, third.jobDir);
    assert.equal(full.exitCode, EXIT_BUSY);
    assert.match(full.stderr, /all 2 native run slots are in use.*2 at a time/);
    g.release();
    assert.deepEqual([(await pa).exitCode, (await pb).exitCode], [0, 0]);
    // once the first is over, the same workspace is free again
    host.script = {};
    assert.equal((await runNativeJob(host, same.job, undefined, same.jobDir)).exitCode, 0);
  });

  test("a claim whose writer is gone does not block a workspace (the sweep deals with what it left)", async () => {
    const host = new SimHost();
    const a = planned(host, ws("a"), "run-0001-aaaa", { maxConcurrentRuns: 2 });
    host.mkdirp(CLAIMS);
    host.writeText(`${CLAIMS}\\dead-run-0001.json`, JSON.stringify({ pid: 900, runId: "dead-run-0001", owner: "dead-run-0001", at: new Date(Date.now() - 60_000).toISOString(), folders: a.job.claim }));
    assert.equal((await runNativeJob(host, a.job, undefined, a.jobDir)).exitCode, 0);
    // an unreadable claim counts as held (never guessed away)
    host.writeText(`${CLAIMS}\\odd.json`, "{half");
    const b = planned(host, ws("b"), "run-0002-bbbb", { maxConcurrentRuns: 2 });
    const out = await runNativeJob(host, b.job, undefined, b.jobDir);
    assert.equal(out.exitCode, EXIT_BUSY);
    assert.match(out.stderr, /cannot be read, so it counts as held/);
  });

  test("the slot, the claim and the in-progress mark are released on every path out: refusal, failed grant, no answer, a throwing launcher, a stuck profile, an unwritable record, a volume that is not NTFS", async () => {
    const cases: [string, (host: SimHost) => void][] = [
      ["a grant that cannot be made", (h) => { h.script = { refuse: (p) => key(p) === key(`${TASK}\\work`) }; }],
      ["a launcher that gives no answer", (h) => { h.script = { noAnswer: true }; }],
      ["a launcher that cannot be run", (h) => { h.script = { throws: true }; }],
      ["a profile that cannot be deleted", (h) => { h.script = { profileStuck: true }; }],
      ["a container that cannot be made", (h) => { h.script = { stage: "container" }; }],
      ["a profile record that cannot be written", (h) => { const write = h.writeText.bind(h); h.writeText = (p: string, t: string): void => { if (p.includes("\\profiles\\")) throw new Error("disk full"); write(p, t); }; }],
      ["a volume that is not NTFS", (h) => { h.volumes.set("c:", "FAT32"); }],
    ];
    for (const [label, arrange] of cases) {
      const host = new SimHost();
      const { job, jobDir } = jobFor(host);
      arrange(host);
      const out = await runNativeJob(host, job, undefined, jobDir);
      assert.notEqual(out.exitCode, 0, label);
      assert.notEqual(out.exitCode, EXIT_BUSY, `${label}: a failure, not a busy answer`);
      assert.ok(slotsFree(host, 1), `${label}: slot`);
      assert.deepEqual(host.listDir(CLAIMS), [], `${label}: claim`);
      // the run id is not left marked as in progress: the same job runs again here (on a machine that works)
      const fresh = new SimHost();
      assert.equal((await runNativeJob(fresh, job, undefined, jobDir)).exitCode, 0, `${label}: the id is free`);
    }
    // the unwritable record stops the run before anything is granted
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    const write = host.writeText.bind(host);
    host.writeText = (p: string, t: string): void => { if (p.includes("\\profiles\\")) throw new Error("disk full"); write(p, t); };
    const out = await runNativeJob(host, job, undefined, jobDir);
    assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: profile: the profile record could not be written`));
    assert.equal(host.calls.length, 0, "no launcher call, no grant");
  });

  test("review: a claim is created whole, so a writer that stops mid-write leaves nothing that blocks later runs (the default limit included)", async () => {
    const host = new SimHost();
    // a writer that stops half way through a plain write leaves "{" on disk; the claim must not go through such a write at all
    const write = host.writeText.bind(host);
    host.writeText = (p: string, t: string): void => { if (key(p).startsWith(key(CLAIMS) + "\\")) { write(p, t.slice(0, 1)); throw new Error("the process stopped mid-write"); } write(p, t); };
    const a = jobFor(host);
    assert.equal((await runNativeJob(host, a.job, undefined, a.jobDir)).exitCode, 0, "the claim was made whole");
    const b = planned(host, ws("b"), "run-0002-bbbb");
    assert.equal((await runNativeJob(host, b.job, undefined, b.jobDir)).exitCode, 0, "and nothing half written blocks the next run");
    assert.deepEqual(host.listDir(CLAIMS), []);
    // an earlier claim file of the SAME id (an attempt that stopped) is this run's own: it is replaced, not counted against it
    host.writeText = write;
    const c = planned(host, ws("c"), "run-0003-cccc");
    host.mkdirp(CLAIMS);
    host.writeText(`${CLAIMS}\\${c.job.runId}.json`, "{");
    assert.equal((await runNativeJob(host, c.job, undefined, c.jobDir)).exitCode, 0);
  });

  test("review: a claim folder that cannot be listed or written is busy, never a thrown run that keeps its slot; a throw in the cleanup still gives the slot and the claim back", async () => {
    for (const [label, arrange] of [
      ["the claims folder cannot be listed", (h: SimHost) => { const list = h.listDir.bind(h); h.listDir = (p: string): string[] => { if (key(p) === key(CLAIMS)) throw new Error("EIO"); return list(p); }; }],
      ["the claims folder cannot be made", (h: SimHost) => { const mk = h.mkdirp.bind(h); h.mkdirp = (p: string): void => { if (key(p) === key(CLAIMS)) throw new Error("EACCES"); mk(p); }; }],
      ["the claim cannot be created", (h: SimHost) => { const ce = h.createExclusive.bind(h); h.createExclusive = (p: string, t: string): boolean => { if (key(p).startsWith(key(CLAIMS) + "\\")) throw new Error("ENOSPC"); return ce(p, t); }; }],
    ] as const) {
      const host = new SimHost();
      const { job, jobDir } = jobFor(host);
      arrange(host);
      const out = await runNativeJob(host, job, undefined, jobDir);
      assert.equal(out.exitCode, EXIT_BUSY, label);
      assert.match(out.stderr, /folder claim could not be/, label);
      assert.ok(slotsFree(host, 1), `${label}: the slot is given back`);
      assert.equal(host.calls.length, 0, `${label}: nothing granted`);
      assert.equal((await runNativeJob(new SimHost(), job, undefined, jobDir)).exitCode, 0, `${label}: the run id is free again`);
    }
    // a throw in the cleanup after the run (removing the input file fails)
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    const rm = host.remove.bind(host);
    host.remove = (p: string): void => { if (key(p) === key(job.files.input)) throw new Error("EBUSY"); rm(p); };
    await assert.rejects(runNativeJob(host, job, undefined, jobDir), /EBUSY/);
    assert.ok(slotsFree(host, 1), "the slot is given back");
    assert.deepEqual(host.listDir(CLAIMS), [], "the claim is given back");
    host.remove = rm;
    const next = planned(host, ws("n"), "run-0009-nnnn");
    assert.equal((await runNativeJob(host, next.job, undefined, next.jobDir)).exitCode, 0, "a later run is not kept busy");
  });

  test("review: a runner that stopped after its records were removed but before its status file was leaves a folder the sweep releases (no wedge); an old job file or a launcher record alone stays a problem", async () => {
    const dead = { runnerPid: 4242, startedAt: new Date(Date.now() - 60_000).toISOString(), runId: "x" };
    // retired: both records gone, the status file still there
    {
      const host = new SimHost();
      const { job, jobDir } = jobFor(host);
      host.writeText(`${jobDir}\\status.json`, JSON.stringify({ ...dead, runId: job.runId }));
      const swept = await sweepLeftovers(host, settings());
      assert.deepEqual(swept.problems, []);
      assert.equal(swept.released, 1);
      assert.ok(!host.exists(jobDir));
      assert.equal(host.calls.length, 0, "nothing is revoked or deleted for a run that was retired");
    }
    // an older backend's job file (no profile in it): reported, never guessed at
    {
      const host = new SimHost();
      const { job, jobDir } = jobFor(host);
      const { profile: _p, ...old } = JSON.parse(host.readText(jobFile(jobDir))!) as NativeJob;
      host.writeText(jobFile(jobDir), JSON.stringify(old));
      host.writeText(`${jobDir}\\status.json`, JSON.stringify({ ...dead, runId: job.runId }));
      const swept = await sweepLeftovers(host, settings());
      assert.match(swept.problems[0] ?? "", /no profile name in the job file/);
      assert.ok(host.exists(jobDir));
    }
    // the launcher's record without the backend's: kept and reported, the launcher not called
    {
      const host = new SimHost();
      const { job, jobDir } = jobFor(host);
      markStarted(host, job, jobDir, { ...dead, runId: job.runId });
      host.remove(`${profilesDir(job.settings)}\\${job.profile.name}.json`);
      const swept = await sweepLeftovers(host, settings());
      assert.match(swept.problems[0] ?? "", /missing or unreadable/);
      assert.equal(host.calls.length, 0);
      assert.ok(host.profiles.has(job.profile.name), "nothing deleted without the record");
    }
    // the records are removed launcher's first, so a stop between the two leaves the backend's record, which a sweep retires
    {
      const host = new SimHost();
      const { job, jobDir } = jobFor(host);
      const order: string[] = [];
      const rm = host.remove.bind(host);
      host.remove = (p: string): void => { if (key(p).startsWith(key(profilesDir(job.settings)) + "\\")) order.push(key(p).endsWith(".sid") ? "sid" : "json"); rm(p); };
      assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, 0);
      assert.deepEqual(order, ["sid", "json"]);
    }
  });

  test("configuration: the limit is a whole number from 1 to 4, one by default, and the audit and health say what is unmeasured", async () => {
    const host = new SimHost();
    for (const bad of [0, -1, 5, 1.5, Number.NaN, 100]) assert.throws(() => windowsNativeBackend(options(host, { maxConcurrentRuns: bad })), /maxConcurrentRuns: a whole number from 1 to 4/, String(bad));
    const one = windowsNativeBackend(options(host));
    assert.match(String(one.auditDetails!()["concurrency"]), /one confined run at a time/);
    const two = windowsNativeBackend(options(host, { maxConcurrentRuns: 2 }));
    assert.match(String(two.auditDetails!()["concurrency"]), /up to 2.*never in the same or an overlapping workspace; unmeasured on real Windows/);
    host.files.set(key(LAUNCHER), "exe"); host.files.set(key(RUNNER), "js");
    host.script = { onProgram: () => undefined };
    const notes = (await two.health()).notes ?? [];
    assert.ok(notes.some((n) => /up to 2 confined runs at once.*UNMEASURED on real Windows/.test(n)), notes.join(" | "));
    assert.ok((await one.health()).notes?.some((n) => /one confined run at a time/.test(n)));
    // the environment: absent or empty keeps one; anything else outside 1..4 is a reason, never a throw
    for (const bad of ["0", "5", "two", "1.5", "-1", " 2", "0x2", "00000002"]) assert.match((await windowsDefaultBackend({ NIMBLENEWT_WIN_MAX_RUNS: bad }, "win32").health()).reason ?? "", /NIMBLENEWT_WIN_MAX_RUNS must be a whole number from 1 to 4/, bad);
    for (const good of ["", "1", "2", "4"]) assert.doesNotMatch((await windowsDefaultBackend({ NIMBLENEWT_WIN_MAX_RUNS: good }, "win32").health()).reason ?? "", /MAX_RUNS/, good);
  });
});

describe("A03b per-run container profile, second clean-context review: nothing new blocks every run, inputs never inside another run's task folders, records made whole", () => {
  const CLAIMS = `${CONTROL}\\claims`;
  const PROFILES = `${CONTROL}\\profiles`;
  const ws = (n: string, extra: Partial<NormalizedRecipe> = {}): NormalizedRecipe => recipe({ workdir: `C:\\Tasks\\${n}\\work`, home: `C:\\Tasks\\${n}\\home`, scratch: `C:\\Tasks\\${n}\\scratch`, ...extra });
  const planned = (host: SimHost, r: NormalizedRecipe, id: string, extra: Partial<WindowsNativeOptions> = {}): { job: NativeJob; jobDir: string } => {
    const plan = windowsNativeBackend(options(host, extra)).plan(r, ["/inputs/tools/tool.exe"], id);
    const jobDir = plan.env["NIMBLENEWT_NATIVE_JOB"]!;
    return { job: JSON.parse(host.readText(jobFile(jobDir))!) as NativeJob, jobDir };
  };
  const probeRecord = (host: SimHost, name: string, pid: number, at: string): void => {
    host.mkdirp(PROFILES);
    host.writeText(`${PROFILES}\\${name}.json`, JSON.stringify({ version: 1, name, runId: `probe-${name}`, jobDir: "", pid, at, grants: [], folders: [] }));
    host.writeText(`${PROFILES}\\${name}.sid`, `nn-run-profile v1\n${name} ${simSid(name)}\n`);
    host.profiles.add(name);
  };

  test("the health check's probe profile, in progress in the controller's process, does not stop a run in a runner's process (default limit 1); once its writer is gone it is swept", async () => {
    const host = new SimHost();
    const controller = 700;
    host.alive.add(controller);
    host.procs = [{ pid: controller, parent: 1, started: new Date(Date.now() - 600_000).toISOString() }];
    const probe = "NimbleNewtRun-00000000000000aa";
    probeRecord(host, probe, controller, new Date(Date.now() - 1000).toISOString());
    const { job, jobDir } = jobFor(host);
    const out = await runNativeJob(host, job, undefined, jobDir);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.ok(host.profiles.has(probe) && host.exists(`${PROFILES}\\${probe}.json`), "the probe's own profile and record are left to the probe");
    assert.ok(host.calls.every((c) => c.args[c.args.indexOf("--name") + 1] !== probe), "nothing was revoked or deleted for it");
    // a live record WITH grants or folders is still a run in progress, and with one slot a run does not start next to it (as before)
    const other = jobFor(host);
    markStarted(host, other.job, other.jobDir, { runnerPid: controller, runId: other.job.runId, startedAt: new Date(Date.now() - 1000).toISOString() });
    host.remove(`${other.jobDir}\\status.json`);
    host.remove(other.jobDir);
    const third = planned(host, ws("c"), "run-0003-cccc");
    const refused = await runNativeJob(host, third.job, undefined, third.jobDir);
    assert.match(refused.stderr, /may still be running/);
    // the controller has gone: both are swept
    host.alive.delete(controller);
    host.procs = [];
    assert.equal((await runNativeJob(host, third.job, undefined, third.jobDir)).exitCode, 0);
    assert.equal(host.profiles.size, 0);
    assert.deepEqual(host.listDir(PROFILES), []);
  });

  test("with two runs allowed, a run whose input is inside or around another run's task folder is refused (its grant would rewrite access lists in that workspace); two runs reading the same input run at once", async () => {
    const host = new SimHost();
    const opt = { maxConcurrentRuns: 3 };
    const a = planned(host, ws("a"), "run-0001-aaaa", opt);
    const readsInside = planned(host, ws("b", { readOnly: [{ host: "C:\\Tasks\\a\\work\\.git", guest: "/inputs/tools" }] }), "run-0002-bbbb", opt);
    const readsAround = planned(host, ws("c", { readOnly: [{ host: "C:\\Tasks\\a", guest: "/inputs/tools" }] }), "run-0003-cccc", opt);
    const writesInsideInput = planned(host, ws("d", { workdir: "C:\\Tools\\inputs\\work", readOnly: [{ host: "C:\\Tools\\other", guest: "/inputs/tools" }] }), "run-0004-dddd", opt);
    const sameInput = planned(host, ws("e"), "run-0005-eeee", opt);
    const g = { count: 0, open: (): void => undefined };
    const closed = new Promise<void>((resolve) => { g.open = resolve; });
    host.script = { onProgram: async () => { g.count++; await closed; } };
    const safety = setTimeout(() => g.open(), 5000); // a run that is wrongly let through must fail the test below, not hang it
    const pa = runNativeJob(host, a.job, undefined, a.jobDir);
    for (let i = 0; i < 400 && g.count < 1; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(g.count, 1);
    for (const [label, x, why] of [["an input inside the other run's workspace", readsInside, /a run's inputs may not be another run's task folders/], ["an input around it", readsAround, /a run's inputs may not be another run's task folders/], ["a workspace inside the other run's input", writesInsideInput, /one run at a time per workspace/]] as const) {
      const out = await Promise.race([runNativeJob(host, x.job, undefined, x.jobDir), new Promise<JobOutcome>((r) => setTimeout(() => r({ exitCode: -1, stdout: "", stderr: "it was let through to its program" }), 2000))]);
      assert.equal(out.exitCode, EXIT_BUSY, `${label}: ${out.stderr}`);
      assert.match(out.stderr, why, label);
    }
    assert.equal(host.calls.filter((c) => c.args[0] === "run").length, 1, "none of them reached the launcher");
    // the same read-only input in two runs at once is fine (each adds and removes its own SID's entry, under the launcher's lock)
    const pe = runNativeJob(host, sameInput.job, undefined, sameInput.jobDir);
    for (let i = 0; i < 400 && g.count < 2; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(g.count, 2, "the second run on the same input is in its program");
    g.open();
    clearTimeout(safety);
    assert.deepEqual([(await pa).exitCode, (await pe).exitCode], [0, 0]);
    assert.deepEqual(host.listDir(CLAIMS), []);
  });

  test("an entry that cannot be removed keeps the profile AND both records (the backend never deletes before a clean read-back), and a later sweep revokes by that SID first, then deletes", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    let stuck = true;
    host.script = { stubborn: (p) => stuck && key(p) === key(`${TASK}\\home`) };
    const out = await runNativeJob(host, job, undefined, jobDir);
    assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: revoke: `));
    assert.equal(host.calls.filter((c) => c.args[0] === "delete-profile").length, 0, "no delete while an entry is left");
    assert.ok(host.profiles.has(job.profile.name));
    assert.ok(host.exists(`${PROFILES}\\${job.profile.name}.json`) && host.exists(job.profile.record), "both records stay: they are how the sweep finds the SID");
    assert.deepEqual(record(host, job).profile, { name: job.profile.name, sid: simSid(job.profile.name), deleted: false, gone: false });
    // the entry can be removed now: the sweep revokes by the run's SID, reads back, and only then deletes
    stuck = false;
    host.script = {};
    const before = host.calls.length;
    assert.deepEqual((await sweepLeftoversLocked(host, job.settings)).problems, []);
    const order = host.calls.slice(before).map((c) => c.args[0]);
    assert.ok(order.indexOf("revoke") >= 0 && order.indexOf("delete-profile") > order.lastIndexOf("check"), order.join(","));
    assert.deepEqual(hasEntries(host), []);
    assert.equal(host.profiles.size, 0);
    assert.deepEqual(host.listDir(PROFILES), []);
  });

  test("only deleted AND gone lets the records go, whatever 'ok' says; a sweep (locked, or a run's own) leaves no claim of its own behind", async () => {
    const host = new SimHost();
    const { job, jobDir } = jobFor(host);
    host.script = { profileNotGoneInLine: true, deleteNotGone: true };
    const out = await runNativeJob(host, job, undefined, jobDir);
    assert.match(out.stderr, new RegExp(`^${FAILURE_PREFIX}: profile: `));
    assert.ok(host.exists(`${PROFILES}\\${job.profile.name}.json`) && host.exists(job.profile.record), "the records stay");
    // the locked sweep retires it (under a claim of its own) and gives that claim back
    host.script = {};
    assert.deepEqual((await sweepLeftoversLocked(host, job.settings)).problems, []);
    assert.equal(host.profiles.size, 0);
    assert.deepEqual(host.listDir(CLAIMS), [], "the sweep's claim is given back");
    // and a run's own sweep of an earlier leftover too
    const old = jobFor(host);
    markStarted(host, old.job, old.jobDir, { runnerPid: 900, runId: old.job.runId });
    const next = planned(host, ws("n"), "run-0009-nnnn");
    const claimsDuring: string[][] = [];
    host.script = { onProgram: () => { claimsDuring.push(host.listDir(CLAIMS)); } };
    assert.equal((await runNativeJob(host, next.job, undefined, next.jobDir)).exitCode, 0);
    assert.deepEqual(claimsDuring, [[`${next.job.runId}.json`]], "while the program runs, only the run's own claim exists");
    assert.deepEqual(host.listDir(CLAIMS), []);
  });

  test("a claim whose writer is gone is removed by the next claim (no pile of dead claims, no process listing for each on every run); a live one and one rewritten meanwhile stay", async () => {
    const host = new SimHost();
    const old = new Date(Date.now() - 60_000).toISOString();
    host.mkdirp(CLAIMS);
    for (const n of ["dead-1", "dead-2"]) host.writeText(`${CLAIMS}\\${n}.json`, JSON.stringify({ pid: 901, runId: n, owner: n, at: old, folders: ["C:\\Tasks\\zz\\work"] }));
    host.alive.add(555);
    host.procs = [{ pid: 555, parent: 1, started: new Date(Date.now() - 120_000).toISOString() }];
    const live = JSON.stringify({ pid: 555, runId: "live-1", owner: "live-1", at: old, folders: ["C:\\Tasks\\yy\\work"] });
    host.writeText(`${CLAIMS}\\live-1.json`, live);
    const { job, jobDir } = jobFor(host);
    assert.equal((await runNativeJob(host, job, undefined, jobDir)).exitCode, 0);
    assert.deepEqual(host.listDir(CLAIMS), ["live-1.json"], "the dead claims are gone, the live one stays");
    // a dead claim that is rewritten between the reading and the removal (the same id claimed again) is not removed on the older reading
    host.writeText(`${CLAIMS}\\dead-3.json`, JSON.stringify({ pid: 902, runId: "dead-3", owner: "dead-3", at: old, folders: ["C:\\Tasks\\xx\\work"] }));
    const fresh = JSON.stringify({ pid: 555, runId: "dead-3", owner: "dead-3", at: new Date().toISOString(), folders: ["C:\\Tasks\\xx\\work"] });
    const list = host.processes.bind(host);
    const read = host.readText.bind(host);
    let judged = false;
    let rewritten = false;
    // dead-3 is read with its old text, then (while its writer is being looked up) the same id claims again: the old reading must not remove the new claim
    host.readText = (p: string, max?: number): string | undefined => { const t = read(p, max); if (key(p) === key(`${CLAIMS}\\dead-3.json`) && t !== undefined && t !== fresh) judged = true; return t; };
    host.processes = async () => { if (judged && !rewritten) { rewritten = true; host.writeText(`${CLAIMS}\\dead-3.json`, fresh); } return list(); };
    const next = planned(host, ws("n"), "run-0009-nnnn");
    assert.equal((await runNativeJob(host, next.job, undefined, next.jobDir)).exitCode, 0);
    assert.ok(rewritten, "the rewrite happened between the reading and the removal");
    assert.equal(host.readText(`${CLAIMS}\\dead-3.json`), fresh, "the claim written meanwhile is kept");
  });
});

describe("A03b sign-out / restart: the sweep records a run that never wrote its own record as interrupted", () => {
  /** A run that got as far as its launcher and was then ended from outside (sign-out, restart): the status file, both profile records, the profile and live entries; no run record. */
  const killedRun = (host: SimHost, id: string): { job: NativeJob; dir: string } => {
    const { job: made } = jobFor(host);
    const dir = `${CONTROL}\\jobs\\${id}`;
    const name = `NimbleNewtRun-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
    const job: NativeJob = { ...made, runId: id, profile: runProfileFor(made.settings, name) };
    host.mkdirp(dir);
    host.writeText(jobFile(dir), JSON.stringify(job));
    markStarted(host, job, dir, { runnerPid: 900, runId: id, startedAt: "2026-11-26T10:00:00.000Z" });
    for (const g of job.grants) host.entries.set(key(g.path), 1);
    return { job, dir };
  };
  test("after the sweep the run has a record: interrupted, failure kind interrupted, no exit code, the sweep's clean read-back, the profile deleted and gone; it reads clean for the gate's read-back", async () => {
    const host = new SimHost();
    const { job, dir } = killedRun(host, "signout-run-0001");
    const swept = await sweepLeftovers(host, settings());
    assert.deepEqual([swept.released, swept.problems], [1, []]);
    assert.equal(host.exists(jobFile(dir)), false);
    const rec = record(host, job);
    assert.equal(rec.interrupted, true);
    assert.equal(rec.failure?.kind, "interrupted");
    assert.match(rec.failure?.message ?? "", /signed out|restarted/);
    assert.deepEqual([rec.exitCode, rec.timedOut, rec.readBack, rec.entriesLeft, rec.startedAt], [null, false, "clean", [], "2026-11-26T10:00:00.000Z"]);
    assert.deepEqual(rec.profile, { name: job.profile.name, sid: simSid(job.profile.name), deleted: true, gone: true });
    assert.equal(heldRunOutcome(rec), "interrupted");
    assert.equal(grantsReadBackOf([JSON.stringify(rec)]).state, "clean", "an interrupted run whose leftovers the sweep removed is no grant left behind");
    assert.deepEqual(hasEntries(host), []);
  });
  test("a record the runner wrote itself is never replaced; a run the sweep could not clean gets no record yet (the next sweep tries again)", async () => {
    const host = new SimHost();
    const { job } = killedRun(host, "signout-run-0002");
    const own = JSON.stringify({ runId: job.runId, mode: "native", container: "lpac", startedAt: "x", childStarted: true, exitCode: null, timedOut: false, failure: { kind: "launcher", message: "the launcher gave no answer" }, grants: [], softRefused: [], entriesLeft: [], readBack: "clean" });
    host.writeText(`${recordsDir(job.settings)}\\${job.runId}.json`, own);
    await sweepLeftovers(host, settings());
    assert.equal(host.readText(`${recordsDir(job.settings)}\\${job.runId}.json`), own);
    assert.equal(heldRunOutcome(record(host, job)), "failed");
    const stuck = new SimHost();
    stuck.script = { stubborn: () => true };
    const k = killedRun(stuck, "signout-run-0003");
    const swept = await sweepLeftovers(stuck, settings());
    assert.equal(swept.released, 0);
    assert.equal(readRecord(stuck, k.job.settings, k.job.runId), undefined);
  });
  test("a runner stopped after its clean-up but before its own record (both profile records gone, the status file still there) is recorded as interrupted too", async () => {
    const host = new SimHost();
    const { job, dir } = killedRun(host, "signout-run-0004");
    host.remove(`${profilesDir(job.settings)}\\${job.profile.name}.json`); host.remove(job.profile.record); host.profiles.delete(job.profile.name);
    for (const g of job.grants) host.entries.set(key(g.path), 0);
    await sweepLeftovers(host, settings());
    assert.equal(host.exists(jobFile(dir)), false);
    const rec = record(host, job);
    assert.deepEqual([rec.interrupted, rec.failure?.kind, rec.profile], [true, "interrupted", { name: job.profile.name, deleted: false, gone: true }]);
  });
  test("how a held run's record reads: only interrupted and failed count as stopped; a time limit or a success never does", () => {
    const base = { runId: "r", mode: "native", container: "lpac", startedAt: "", childStarted: true, exitCode: 0, timedOut: false, grants: [], softRefused: [], entriesLeft: [], readBack: "clean" } as const;
    assert.equal(heldRunOutcome(undefined), "none");
    assert.equal(heldRunOutcome(base), "succeeded");
    assert.equal(heldRunOutcome({ ...base, timedOut: true }), "timed-out");
    assert.equal(heldRunOutcome({ ...base, timedOut: true, failure: { kind: "launcher", message: "m" } }), "timed-out");
    assert.equal(heldRunOutcome({ ...base, failure: { kind: "launcher", message: "m" } }), "failed");
    assert.equal(heldRunOutcome({ ...base, interrupted: true, failure: { kind: "interrupted", message: "m" } }), "interrupted");
    assert.equal(heldRunOutcome({ ...base, interrupted: true }), "succeeded", "the flag alone, without the failure, is not the sweep's record");
  });
});

describe("A03b sign-out / restart: run-g05.ps1 -Hold and -AfterSignIn (simulated Windows)", () => {
  const PACKAGES = "C:\\Users\\owner\\AppData\\Local\\Packages";
  const ROOT = "C:\\Users\\owner\\AppData\\Local\\Temp\\nn-g05hold-a1B2c3";
  /** The simulated machine with its per-run profile folders under %LOCALAPPDATA%\\Packages (lower case, as Windows keeps the moniker). */
  class PkgHost extends SimHost {
    override exists(p: string): boolean { const k = key(p); if (k.startsWith(`${key(PACKAGES)}\\`)) return [...this.profiles].some((n) => key(`${PACKAGES}\\${n}`) === k); return super.exists(p); }
    override listDir(p: string): string[] { return key(p) === key(PACKAGES) ? [...this.profiles].map((n) => n.toLowerCase()) : super.listDir(p); }
  }
  const T0 = "2026-11-26T18:00:00.0000000-05:00";
  /** The detached runner as Windows would show it after a moment: the backend's records, the launcher's record and profile, the grants applied, the program's marker, three processes. */
  const runnerStarts = (host: PkgHost, opts: { marker?: boolean } = {}) => (plan: SpawnPlan): number => {
    const jobDir = plan.env["NIMBLENEWT_NATIVE_JOB"]!;
    const job = JSON.parse(host.readText(jobFile(jobDir))!) as NativeJob;
    markStarted(host, job, jobDir, { runnerPid: 900, runId: job.runId, startedAt: new Date(Date.parse(T0) - 1000).toISOString() });
    for (const g of job.grants) host.entries.set(key(g.path), 1);
    if (opts.marker !== false) host.writeText(`${ROOT}\\work\\held.txt`, "held 902");
    host.alive.add(900);
    host.procs = [{ pid: 900, parent: 50, started: T0 }, { pid: 901, parent: 900, started: T0 }, { pid: 902, parent: 901, started: T0 }, { pid: 77, parent: 1, started: T0 }];
    return 900;
  };
  const hold = (host: PkgHost, extra: { marker?: boolean; minutes?: number } = {}) => startHold({
    host, launcher: LAUNCHER, controlDir: CONTROL, nodeExecutable: NODE, runnerScript: RUNNER, root: ROOT, spawnRunner: runnerStarts(host, extra), sleep: async () => undefined, waitMs: 5000,
    // A clock that moves one second per look, so the wait for the marker ends at once in the tests.
    now: (() => { let t = Date.now(); return () => new Date(t += 1000); })(),
    ...(extra.minutes === undefined ? {} : { minutes: extra.minutes }),
  });
  /** What Windows does at sign-out: every process of the session ends; nothing of the runner's clean-up runs. */
  const signOut = (host: PkgHost): void => { host.alive.delete(900); host.procs = [{ pid: 77, parent: 1, started: T0 }]; };
  const check = (host: PkgHost, newLogon: boolean | null = true) => afterSignIn({ host, launcher: LAUNCHER, controlDir: CONTROL, packagesDir: PACKAGES, newLogon });
  const heldState = (host: PkgHost): HoldState => JSON.parse(host.readText(holdFiles(CONTROL).state)!) as HoldState;

  test("hold, sign out, sign in: the task is gone, its profile was still there, the sweep removes it and its grants, the record says interrupted, and the check holds", async () => {
    const host = new PkgHost();
    const h = await hold(host);
    assert.ok(!("error" in h), JSON.stringify(h));
    assert.deepEqual(h.problems, []);
    const st = heldState(host);
    assert.deepEqual([st.childSeen, st.minutes, st.processes.map((p) => p.pid), st.sid === simSid(st.profileName), st.root], [true, 30, [900, 901, 902], true, ROOT]);
    assert.equal(st.until, new Date(Date.parse(st.startedAt) + 30 * 60_000).toISOString());
    // The same path as every run: the backend's own job, the launcher with the hold's time limit, the program run from the read-only node folder, the idle program in the tools folder.
    const job = JSON.parse(host.readText(jobFile(st.jobDir))!) as NativeJob;
    assert.equal(job.args[job.args.indexOf("--timeout-ms") + 1], String(30 * 60_000));
    assert.equal(job.settings.maxRunMs, 30 * 60_000);
    assert.ok(job.args.includes("--exe") && job.args[job.args.indexOf("--exe") + 1] === `${NODE_DIR}\\node.exe`);
    assert.equal(host.readText(`${ROOT}\\tools\\hold.mjs`), HOLD_SCRIPT);
    assert.ok(job.grants.some((g) => key(g.path) === key(`${ROOT}\\work`)) && !job.grants.some((g) => key(g.path).startsWith(key(CONTROL))), "the task's folders, never the control folder");
    signOut(host);
    const r = await check(host);
    assert.ok(!("error" in r), JSON.stringify(r));
    assert.deepEqual(r.afterSignOut, { held: true, newLogon: true, taskRunningAfter: false, profileLeftBeforeSweep: true, sweepProblems: 0, leftoverAfterSweep: 0, grantsAfter: "clean", interruptedRecorded: true });
    assert.equal(r.outcome, "interrupted");
    assert.deepEqual(afterSignOutProblems(r.afterSignOut), []);
    assert.deepEqual(hasEntries(host), []);
    assert.equal(host.profiles.size, 0);
    assert.equal(host.exists(st.jobDir), false);
    // The file the evidence run reads, and the state retired (the same hold is judged once).
    assert.deepEqual(JSON.parse(host.readText(holdFiles(CONTROL).result)!), { schema: AFTER_SIGNOUT_SCHEMA, afterSignOut: r.afterSignOut });
    assert.equal(host.exists(holdFiles(CONTROL).state), false);
    assert.ok(host.exists(holdFiles(CONTROL).checked));
    assert.match(JSON.stringify(await check(host)), /no hold is recorded/);
    // The launcher's check went by the held profile's SID, over every granted path.
    const checks = host.calls.filter((c) => c.args[0] === "check" && c.args.includes(st.profileName));
    assert.ok(checks.length > 0 && checks.at(-1)!.args.includes(st.sid!));
  });
  test("a restart that reuses the runner's process number is not the held task (a later start time)", async () => {
    const host = new PkgHost();
    await hold(host);
    host.procs = [{ pid: 900, parent: 4, started: new Date(Date.now() + 3_600_000).toISOString() }];
    const r = await check(host);
    assert.ok(!("error" in r) && r.afterSignOut.taskRunningAfter === false && r.afterSignOut.interruptedRecorded, JSON.stringify(r));
  });
  test("not signed out yet: the task still runs, nothing is swept or revoked, the state stays for the next try, and the check does not hold", async () => {
    const host = new PkgHost();
    await hold(host);
    const r = await check(host, false);
    assert.ok(!("error" in r));
    assert.deepEqual(r.afterSignOut, { held: true, newLogon: false, taskRunningAfter: true, profileLeftBeforeSweep: true, sweepProblems: null, leftoverAfterSweep: null, grantsAfter: "not-measured", interruptedRecorded: false });
    assert.ok(r.running);
    assert.ok(hasEntries(host).length > 0 && host.profiles.size === 1, "a live run's entries and profile are never touched");
    assert.ok(host.exists(holdFiles(CONTROL).state));
    assert.ok(afterSignOutProblems(r.afterSignOut).some((p) => /still running/.test(p)) && afterSignOutProblems(r.afterSignOut).some((p) => /did not change/.test(p)));
    // A process list that cannot be read counts as running (fail closed).
    signOut(host);
    host.procs = undefined;
    const blind = await check(host);
    assert.ok(!("error" in blind) && blind.running && blind.afterSignOut.taskRunningAfter);
  });
  test("the runner's number still alive while the process list does not show it counts as running (the backend's own rule), and the runner must be in the hold's list for the hold to count", async () => {
    const host = new PkgHost();
    await hold(host);
    host.procs = [{ pid: 77, parent: 1, started: T0 }]; // 900 is still alive (pidAlive) but not listed
    const r = await check(host);
    assert.ok(!("error" in r) && r.running && r.afterSignOut.taskRunningAfter, JSON.stringify(r));
    // The confined program outliving its runner AND its launcher (kill-on-close failed): only the exact match sees it (the backend's rule looks at the runner's children, not further).
    signOut(host);
    host.procs = [{ pid: 77, parent: 1, started: T0 }, { pid: 902, parent: 901, started: T0 }];
    const orphan = await check(host);
    assert.ok(!("error" in orphan) && orphan.running && orphan.afterSignOut.taskRunningAfter, JSON.stringify(orphan));
    assert.ok(hasEntries(host).length > 0, "nothing revoked under a program that may still run");
    // A hold whose runner was not in the process list (only its children were) is not counted as held.
    const other = new PkgHost();
    const h = await startHold({
      host: other, launcher: LAUNCHER, controlDir: CONTROL, nodeExecutable: NODE, runnerScript: RUNNER, root: ROOT, sleep: async () => undefined, waitMs: 5000,
      spawnRunner: (plan) => { const pid = runnerStarts(other)(plan); other.procs = other.procs!.filter((p) => p.pid !== 900); return pid; },
    });
    assert.ok(!("error" in h) && !h.state.childSeen && h.problems.some((p) => /runner is not running/.test(p)), JSON.stringify(h));
  });
  test("the hold ran to its time limit before the sign-out: the record says timed out, which is not interrupted", async () => {
    const host = new PkgHost();
    await hold(host);
    const st = heldState(host);
    // The run ended by itself: its runner cleaned up and wrote its own record (timed out).
    host.remove(`${st.jobDir}\\status.json`); host.remove(`${profilesDir(st.settings)}\\${st.profileName}.json`); host.remove(runProfileFor(st.settings, st.profileName).record); host.profiles.delete(st.profileName);
    for (const g of st.grants) host.entries.set(key(g.path), 0);
    host.writeText(`${recordsDir(st.settings)}\\${st.runId}.json`, JSON.stringify({ runId: st.runId, mode: "native", container: "lpac", startedAt: st.startedAt, childStarted: true, exitCode: null, timedOut: true, grants: [], softRefused: [], entriesLeft: [], readBack: "clean" }));
    signOut(host);
    const r = await check(host);
    assert.ok(!("error" in r));
    assert.deepEqual([r.outcome, r.afterSignOut.interruptedRecorded, r.afterSignOut.profileLeftBeforeSweep, r.afterSignOut.grantsAfter, r.afterSignOut.leftoverAfterSweep], ["timed-out", false, false, "clean", 0]);
    assert.ok(afterSignOutProblems(r.afterSignOut).some((p) => /not recorded as interrupted/.test(p)));
  });
  test("a runner that outlived its launcher at sign-out and recorded the run as failed counts as stopped (never a success)", async () => {
    const host = new PkgHost();
    await hold(host);
    const st = heldState(host);
    host.remove(`${st.jobDir}\\status.json`); host.remove(`${profilesDir(st.settings)}\\${st.profileName}.json`); host.remove(runProfileFor(st.settings, st.profileName).record); host.profiles.delete(st.profileName);
    for (const g of st.grants) host.entries.set(key(g.path), 0);
    host.writeText(`${recordsDir(st.settings)}\\${st.runId}.json`, JSON.stringify({ runId: st.runId, mode: "native", container: "lpac", startedAt: st.startedAt, childStarted: false, exitCode: null, timedOut: false, failure: { kind: "launcher", message: "the launcher gave no answer (exit null)" }, grants: [], softRefused: [], entriesLeft: [], readBack: "clean" }));
    signOut(host);
    const r = await check(host);
    assert.ok(!("error" in r) && r.outcome === "failed" && r.afterSignOut.interruptedRecorded && afterSignOutProblems(r.afterSignOut).length === 0, JSON.stringify(r));
  });
  test("a grant the sweep cannot remove: problems counted, the held paths read back left, the profile left, no interrupted record yet", async () => {
    const host = new PkgHost();
    await hold(host);
    signOut(host);
    host.script = { stubborn: () => true };
    const r = await check(host);
    assert.ok(!("error" in r));
    assert.ok((r.afterSignOut.sweepProblems ?? 0) > 0 && r.afterSignOut.grantsAfter === "left" && r.afterSignOut.leftoverAfterSweep === 1 && !r.afterSignOut.interruptedRecorded, JSON.stringify(r.afterSignOut));
    assert.equal(afterSignOutProblems(r.afterSignOut).length, 4);
  });
  test("no logon recorded, or the program never seen in its container: the check does not hold", async () => {
    const host = new PkgHost();
    const unseen = await hold(host, { marker: false });
    assert.ok(!("error" in unseen) && !unseen.state.childSeen && unseen.problems.some((p) => /marker/.test(p)));
    signOut(host);
    const r = await check(host, null);
    assert.ok(!("error" in r));
    assert.deepEqual([r.afterSignOut.held, r.afterSignOut.newLogon], [false, null]);
    const p = afterSignOutProblems(r.afterSignOut);
    assert.ok(p.some((x) => /no confined task was seen/.test(x)) && p.some((x) => /was not recorded/.test(x)));
  });
  test("-Hold refuses a time limit out of range and a second hold while the first still runs; nothing is started then", async () => {
    for (const minutes of [0, 31, 1.5, -1]) {
      const host = new PkgHost();
      const r = await hold(host, { minutes });
      assert.ok("error" in r && !r.started && /minutes/.test(r.error), String(minutes));
      assert.equal(host.exists(holdFiles(CONTROL).state), false);
    }
    const host = new PkgHost();
    await hold(host);
    const again = await hold(host);
    assert.ok("error" in again && !again.started && /still running/.test(again.error));
    // Once the first has ended (signed out), a new hold is allowed and replaces the state.
    signOut(host);
    const third = await hold(host);
    assert.ok(!("error" in third), JSON.stringify(third));
  });
  test("a state file that is not this bundle's is refused and nothing is swept: another job folder, another launcher, a malformed run id, a missing grant list, an unknown schema", async () => {
    const host = new PkgHost();
    await hold(host);
    signOut(host);
    const good = host.readText(holdFiles(CONTROL).state)!;
    const st = JSON.parse(good) as Record<string, unknown>;
    const bad: Record<string, unknown>[] = [
      { ...st, jobDir: "C:\\Elsewhere\\jobs\\x" }, { ...st, settings: { ...(st["settings"] as object), launcher: "C:\\Temp\\nn-launcher.exe" } }, { ...st, runId: "../x" }, { ...st, grants: [] },
      { ...st, schema: "other/1" }, { ...st, sid: "S-1-5-21-1-2-3-4" }, { ...st, profileName: "NimbleNewtAgent" }, { ...st, processes: "900" },
    ];
    for (const b of bad) {
      host.writeText(holdFiles(CONTROL).state, JSON.stringify(b));
      const r = await check(host);
      assert.ok("error" in r, JSON.stringify(b).slice(0, 120));
      assert.ok(hasEntries(host).length > 0, "nothing was revoked");
    }
    assert.ok("error" in parseHoldState("{", CONTROL, LAUNCHER));
    assert.ok("state" in parseHoldState(good, CONTROL, LAUNCHER));
    assert.ok("state" in parseHoldState(good, CONTROL.toUpperCase(), LAUNCHER.toLowerCase()), "Windows paths compare without case");
  });
});

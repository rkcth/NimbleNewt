import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { release as osRelease, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { SandboxLauncher, type LaunchRecord } from "./launcher.js";
import { AUTOLOGON_ACKNOWLEDGEMENT, windowsSandboxBackend, type WindowsSandboxOptions } from "./windows.js";
import { windowsRealHost } from "./windows-real.js";
import type { WindowsHost } from "./windows-host.js";
import { scrub, scrubDeep, type RedactionNames } from "./windows-redact.js";
import { verifyClient, type WindowsSettings } from "./windows-plan.js";

// Real Windows Sandbox tests (card A03b). They need a Windows machine with the Windows Sandbox feature, an owner signed in at the console, and NIMBLENEWT_REAL_WINDOWS_SANDBOX=1.
// Everywhere else they are skipped with the message below, and windows.test.ts (simulated host) covers the rules. They run from the `sandbox-windows` job of .github/workflows/own-hardware.yml.
//
// Caution: the share account defaults to the account running the tests, which is also the runner's own account, so a pass cannot show that the narrow grants are what make access work.
//
// Settings (all optional): NIMBLENEWT_WSB_OWNER and NIMBLENEWT_WSB_SHARE_IDENTITY (default: the user running the tests), NIMBLENEWT_WSB_SUPERVISOR_ACL=report-only (a checkout
// the owner can write cannot pass the strict rule; the test then records whether strict would pass), NIMBLENEWT_WSB_OUT (a folder for summary.json, uploaded by the workflow),
// NIMBLENEWT_WSB_LOCAL (where the detailed findings go; never uploaded), NIMBLENEWT_REAL_WINDOWS_AUTOLOGON=1 (also test the auto-login and lock mode; only on a machine the owner set up for it).
const real = process.platform === "win32" && process.env["NIMBLENEWT_REAL_WINDOWS_SANDBOX"] === "1";
const skip = real ? false : "real Windows Sandbox tests: run them on a Windows host with NIMBLENEWT_REAL_WINDOWS_SANDBOX=1 (process.platform must be win32); skipped here";
const autologonToo = process.env["NIMBLENEWT_REAL_WINDOWS_AUTOLOGON"] === "1";

// The repository is public and the workflow uploads NIMBLENEWT_WSB_OUT. Detailed findings (account names, local paths, session, auto-login and lock-task facts, guest output) are
// therefore written only to NIMBLENEWT_WSB_LOCAL, a folder on the machine that is never uploaded; the uploaded folder gets summary.json: pass/fail per test, counts, OS build, mode names.
const findings: Record<string, unknown> = {};
const localDir = process.env["NIMBLENEWT_WSB_LOCAL"] ?? join(tmpdir(), "nn-wsb-local");
const outDir = process.env["NIMBLENEWT_WSB_OUT"] ?? join(tmpdir(), "nn-wsb-summary");
const note = (name: string, value: unknown): void => { findings[name] = value; try { mkdirSync(localDir, { recursive: true }); writeFileSync(join(localDir, "findings.json"), JSON.stringify(findings, null, 2)); } catch { /* findings are best effort */ } };
const results: Record<string, "pass" | "fail"> = {};
const testNames: string[] = [];
const modes = new Set<string>(["owner-session"]);
/** Which sub-fact of the facts test held (names and booleans only). */
const factsSummary: Record<string, boolean> = {};

// A failing test also leaves a REDACTED detail (NIMBLENEWT_WSB_DETAIL, uploaded as its own artifact with a short retention): the error message, the failing step, and the last host calls
// with their output cut to 2 KiB each, with account, domain, machine and home names and SIDs replaced by placeholders (windows-redact.ts). Auto-login and lock-task results are never copied.
const detailDir = process.env["NIMBLENEWT_WSB_DETAIL"] ?? join(tmpdir(), "nn-wsb-detail");
const redactNames: { users: string[]; hosts: string[] } = { users: [], hosts: [] };
const calls: { step: string; ok: boolean; detail?: string }[] = [];
const details: Record<string, unknown> = {};
const clean = (text: string): string => scrub(text, redactNames as RedactionNames);
function recording(inner: WindowsHost): WindowsHost {
  const wrapped = { ...inner } as unknown as Record<string, unknown>;
  const quiet = new Set(["autologon", "lockTask"]);
  for (const m of ["findPackage", "signature", "session", "autologon", "lockTask", "writableBy"] as const) {
    wrapped[m] = async (...args: unknown[]) => {
      try { const v = await (inner[m] as (...a: unknown[]) => Promise<unknown>)(...args); calls.push({ step: m, ok: true }); return v; }
      catch (error) { calls.push({ step: m, ok: false, detail: quiet.has(m) ? "failed" : (error as Error).message }); throw error; }
    };
  }
  wrapped["run"] = async (file: string, args: readonly string[], options: { cwd?: string; timeoutMs: number }) => {
    const r = await inner.run(file, args, options);
    calls.push({ step: `run ${basename(file)} ${args.slice(0, 2).map((a) => (a.length > 40 ? "<long>" : a)).join(" ")}`, ok: r.code === 0, detail: `exit ${String(r.code)}${r.timedOut ? " (timed out)" : ""}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}` });
    return r;
  };
  return wrapped as unknown as WindowsHost;
}
function recordFailure(name: string, error: unknown, since: number): void {
  const mine = calls.slice(since);
  const failing = [...mine].reverse().find((c) => !c.ok);
  details[name] = { error: clean(error instanceof Error ? error.message : String(error)), failingStep: failing === undefined ? "(an assertion, no host call failed)" : clean(failing.step), calls: mine.slice(-12).map((c) => ({ step: clean(c.step), ok: c.ok, ...(c.detail === undefined ? {} : { detail: clean(c.detail) }) })) };
  try { mkdirSync(detailDir, { recursive: true }); writeFileSync(join(detailDir, "detail.json"), JSON.stringify(scrubDeep({ os: osRelease(), tests: details }, redactNames as RedactionNames), null, 2)); } catch { /* best effort */ }
}
function check(name: string, optionsOrFn: { skip?: string | false } | (() => Promise<void>), maybeFn?: () => Promise<void>): void {
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;
  testNames.push(name);
  test(name, options, async () => {
    const since = calls.length;
    try { await fn(); results[name] = "pass"; } catch (error) { results[name] = "fail"; recordFailure(name, error, since); throw error; }
  });
}
const writeSummary = (): void => {
  const tests = Object.fromEntries(testNames.map((n) => [n, results[n] ?? "not run or skipped"]));
  const values = Object.values(tests);
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "summary.json"), JSON.stringify(scrubDeep({ os: osRelease(), node: process.version, modes: [...modes], counts: { pass: values.filter((v) => v === "pass").length, fail: values.filter((v) => v === "fail").length, other: values.filter((v) => v !== "pass" && v !== "fail").length }, facts: factsSummary, tests }, redactNames as RedactionNames), null, 2));
  } catch { /* best effort */ }
};

const user = `${process.env["USERDOMAIN"] ?? ""}\\${process.env["USERNAME"] ?? ""}`;
// The owner and the share account default to the account signed in at the console (found in `before`): that is the account whose token the Sandbox service uses, and the one the
// research had to grant explicitly. The runner's own account (this process) is only the fallback when nobody is found.
let owner = process.env["NIMBLENEWT_WSB_OWNER"] ?? user;
let shareIdentity = process.env["NIMBLENEWT_WSB_SHARE_IDENTITY"] ?? user;
// Whatever the probes find, the environment's own names are always among the names to hide.
for (const v of [process.env["USERNAME"], process.env["USERDOMAIN"], process.env["COMPUTERNAME"]]) if (v !== undefined && v !== "") (v === process.env["USERNAME"] ? redactNames.users : redactNames.hosts).push(v);
redactNames.users.push(user, owner);
const runnerScript = fileURLToPath(new URL("./windows-runner.js", import.meta.url));
const host = recording(windowsRealHost());

describe("Windows Sandbox on a real Windows machine", { skip }, () => {
  let base = "";
  const dirs: string[] = [];
  const dir = (name: string): string => { const p = join(base, name); mkdirSync(p, { recursive: true }); dirs.push(p); return p; };
  let counter = 0;
  const records: LaunchRecord[] = [];
  const opts = (extra: Partial<WindowsSandboxOptions> = {}): WindowsSandboxOptions => ({
    host, controlDir: join(base, "control"), stagingDir: join(base, "staging"), runnerScript, nodeExecutable: process.execPath, shareIdentity, owner,
    supervisorAcl: process.env["NIMBLENEWT_WSB_SUPERVISOR_ACL"] === "report-only" ? "report-only" : "strict", ...extra,
  });
  const launcherFor = (extra: Partial<WindowsSandboxOptions> = {}): Promise<SandboxLauncher> => SandboxLauncher.create({ backend: windowsSandboxBackend(opts(extra)), protectedPaths: [], audit: (r) => { records.push(r); } });
  const recipe = (extra: Record<string, unknown> = {}) => {
    const n = ++counter;
    const workdir = dir(`job${n}\\work`); mkdirSync(join(workdir, ".git"));
    return { mode: "sandboxed" as const, workdir, home: dir(`job${n}\\home`), scratch: dir(`job${n}\\scratch`), readOnly: [] as { host: string; guest: string }[], network: "none" as const, env: {}, protectedSubpaths: [".git"], ...extra };
  };
  const acl = async (path: string): Promise<string> => (await host.run(`${process.env["SystemRoot"]}\\System32\\icacls.exe`, [path], { timeoutMs: 30_000 })).stdout;
  const wsbList = async (): Promise<string> => {
    const client = await verifyClient(host, { controlDir: "", shareIdentity, owner, minVersion: "0.0", packageName: "MicrosoftWindows.WindowsSandbox", publisherId: "8wekyb3d8bbwe", mode: "owner-session", lockTask: "x" } satisfies WindowsSettings);
    assert.ok(client.ok, client.ok ? "" : client.reason);
    const r = await host.run(client.value.wsb, ["list", "--raw"], { cwd: client.value.cwd, timeoutMs: 60_000 });
    note("wsb list --raw", { code: r.code, stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 500) });
    return r.stdout;
  };

  before(async () => {
    try {
    const found = await host.session().then((s) => s.consoleUser, () => undefined);
    if (found !== undefined) { redactNames.users.push(found); if (process.env["NIMBLENEWT_WSB_OWNER"] === undefined) owner = found; if (process.env["NIMBLENEWT_WSB_SHARE_IDENTITY"] === undefined) shareIdentity = found; }
    redactNames.users.push(owner, shareIdentity);
    // The console user's full name (the account's FullName) is used only to hide it; it is never written anywhere.
    const full = await new Promise<string>((resolve) => execFile(`${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_UserAccount -Filter \"Name='$($env:NN_U -replace \"'\",\"''\")'\").FullName"], { env: { ...process.env, NN_U: (found ?? owner).split("\\").pop()! }, timeout: 30_000, windowsHide: true }, (_e, out) => resolve(String(out ?? "").trim())));
    if (full !== "") redactNames.users.push(full);
    base = realpathSync(mkdtempSync(join(process.env["ProgramData"] ?? tmpdir(), "nn-wsb-real-")));
    note("machine", { platform: process.platform, release: process.version, owner, shareIdentity, user, base });
      } catch (error) { results["before hook"] = "fail"; recordFailure("before hook", error, 0); throw error; }
  });
  after(() => { rmSync(base, { recursive: true, force: true }); writeSummary(); });

  check("facts: the package, the signature, the working directory, the session, the auto-login flags (booleans only) and the supervisor ACLs", async () => {
    const settings: WindowsSettings = { controlDir: join(base, "control"), shareIdentity, owner, minVersion: "0.8.107.0", packageName: "MicrosoftWindows.WindowsSandbox", publisherId: "8wekyb3d8bbwe", mode: "owner-session", lockTask: "NimbleNewt-LockOnLogon" };
    const sub = factsSummary;
    const attempt = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => { try { const v = await fn(); sub[name] = true; return v; } catch { sub[name] = false; return undefined; } };
    const pkg = await attempt("package found", async () => { const p = await host.findPackage(); if (p === undefined) throw new Error("no package"); return p; });
    if (pkg !== undefined) {
      sub["publisher is Microsoft"] = pkg.publisherId === "8wekyb3d8bbwe";
      sub["version at least the qualified one"] = /^\d+(\.\d+){1,3}$/.test(pkg.version);
      sub["package folder under WindowsApps"] = pkg.installLocation.toLowerCase().includes("\\windowsapps\\");
      sub["wsb.exe visible to this account"] = host.exists(`${pkg.installLocation}\\wsb.exe`);
      sub["WindowsSandboxServer.exe visible to this account"] = host.exists(`${pkg.installLocation}\\WindowsSandboxServer.exe`);
      const sig = await attempt("wsb.exe signature readable", () => host.signature(`${pkg.installLocation}\\wsb.exe`));
      sub["wsb.exe signature valid"] = sig?.valid === true;
    }
    const client = await verifyClient(host, settings);
    sub["client verified as a whole"] = client.ok;
    const session = await attempt("session readable", () => host.session());
    sub["console user present"] = session?.consoleUser !== undefined;
    sub["owner was explicitly configured"] = process.env["NIMBLENEWT_WSB_OWNER"] !== undefined;
    sub["console user is the configured owner"] = session?.consoleUser !== undefined && session.consoleUser.toLowerCase() === owner.toLowerCase();
    sub["lock state known"] = session?.locked !== undefined;
    await attempt("auto-login flags readable", () => host.autologon());
    await attempt("lock task readable", () => host.lockTask("NimbleNewt-LockOnLogon"));
    await attempt("supervisor folder ACL readable", () => host.writableBy(join(runnerScript, "..")));
    await attempt("control folder ACL readable", async () => { mkdirSync(join(base, "control"), { recursive: true }); return host.writableBy(join(base, "control")); });
    note("facts", { sub, clientOk: client.ok });
    assert.ok(client.ok, client.ok ? "" : client.reason);
    assert.equal(sub["console user present"], true, "an owner must be signed in at the console for these tests");
    assert.equal(sub["console user is the configured owner"], true, "the console user must be the configured owner");
  });

  check("health: a real probe sandbox starts, the guest cannot write read-only inputs or .git or reach the network, and everything is torn down", async () => {
    const backend = windowsSandboxBackend(opts());
    const h = await backend.health();
    note("health", h);
    assert.equal(h.healthy, true, h.reason);
    assert.ok(h.notes!.some((n) => /session-dependent/.test(n)));
    assert.ok(!(await wsbList()).match(/[0-9a-f]{8}-[0-9a-f]{4}/i), "no sandbox is left running after the probe");
  });

  check("escape fixture: the guest tries to leave and is denied; the launch record shows the mode; the host is unchanged and the ACLs are back as they were", async () => {
    const launcher = await launcherFor();
    assert.equal(launcher.capacity.available, true, launcher.capacity.reason);
    const fixtures = dir("fixture");
    const canaryDir = dir("host-secret");
    writeFileSync(join(canaryDir, "canary.txt"), "HOST-CANARY");
    const script = [
      "@echo off",
      "echo x> C:\\nn\\inputs\\fixture\\w.txt 2>nul", "if errorlevel 1 (echo 1_write_readonly_input=denied) else (echo 1_write_readonly_input=ALLOWED)",
      "echo x> C:\\nn\\work\\.git\\h.txt 2>nul", "if errorlevel 1 (echo 2_write_git=denied) else (echo 2_write_git=ALLOWED)",
      "echo x> C:\\nn\\work\\ok.txt 2>nul", "if errorlevel 1 (echo 3_write_work=FAILED) else (echo 3_write_work=allowed)",
      'type "%HOST_CANARY%" >nul 2>nul', "if errorlevel 1 (echo 4_read_host_path=denied) else (echo 4_read_host_path=ALLOWED)",
      'if exist "C:\\Users\\%HOST_USER%\\" (echo 5_host_profile=VISIBLE) else (echo 5_host_profile=absent)',
      'powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect(\'1.1.1.1\',443); exit 0 } catch { exit 1 }"', "if errorlevel 1 (echo 6_network=denied) else (echo 6_network=ALLOWED)",
      "echo x>> C:\\nn\\job\\launch.cmd 2>nul", "if errorlevel 1 (echo 7_edit_launch_script=denied) else (echo 7_edit_launch_script=ALLOWED)",
      "mklink /J C:\\nn\\work\\link C:\\nn\\inputs\\fixture >nul 2>nul", "echo x> C:\\nn\\work\\link\\w2.txt 2>nul", "if errorlevel 1 (echo 8_write_through_junction=denied) else (echo 8_write_through_junction=ALLOWED)",
      "echo done", "",
    ].join("\r\n");
    writeFileSync(join(fixtures, "escape.cmd"), script);
    const r = recipe({ readOnly: [{ host: fixtures, guest: "/inputs/fixture" }], env: { HOST_CANARY: join(canaryDir, "canary.txt"), HOST_USER: process.env["USERNAME"] ?? "nobody" } });
    const aclBefore = await acl(r.workdir);
    const run = await launcher.launch({ recipe: r, command: ["/windows/system32/cmd.exe", "/d", "/c", "C:\\nn\\inputs\\fixture\\escape.cmd"], timeoutMs: 300_000, maxOutputBytes: 1_000_000 });
    const result = await run.result;
    note("escape fixture", { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, record: records.at(-1) });
    for (const line of ["1_write_readonly_input=denied", "2_write_git=denied", "3_write_work=allowed", "4_read_host_path=denied", "5_host_profile=absent", "6_network=denied", "7_edit_launch_script=denied", "8_write_through_junction=denied"]) {
      assert.ok(result.stdout.includes(line), `${line} is missing from the guest's report:\n${result.stdout}\n${result.stderr}`);
    }
    assert.ok(result.stdout.includes("done"));
    // The host: the guest's one allowed write is there; every denied one is not; the canary and the fixture folder are unchanged; the ACLs are as before.
    assert.ok(existsSync(join(r.workdir, "ok.txt")));
    assert.deepEqual(readdirSync(join(r.workdir, ".git")), []);
    assert.deepEqual(readdirSync(fixtures), ["escape.cmd"]);
    assert.deepEqual(readdirSync(canaryDir), ["canary.txt"]);
    assert.equal(await acl(r.workdir), aclBefore);
    const record = records.at(-1)!;
    assert.equal(record.mode, "sandboxed");
    assert.equal(record.backend, "windows-sandbox");
    assert.equal(record.backendDetails?.["windowsMode"], "owner-session");
    assert.equal(record.backendDetails?.["sessionDependent"], "true");
    assert.equal(record.recipeRevision.length, 64);
    assert.ok(!(await wsbList()).match(/[0-9a-f]{8}-[0-9a-f]{4}/i));
  });

  check("the command's exit code and output come back", async () => {
    const launcher = await launcherFor();
    const run = await launcher.launch({ recipe: recipe(), command: ["/windows/system32/cmd.exe", "/d", "/c", "echo hello-from-guest&& exit 7"], timeoutMs: 300_000, maxOutputBytes: 100_000 });
    const result = await run.result;
    note("exit code and output", { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
    assert.equal(result.exitCode, 7);
    assert.match(result.stdout, /hello-from-guest/);
  });

  check("a second job while one runs is refused as busy, and a hard kill of the first ends its sandbox and gives the ACLs back", async () => {
    const launcher = await launcherFor();
    const r = recipe();
    const aclBefore = await acl(r.workdir);
    const long = await launcher.launch({ recipe: r, command: ["/windows/system32/ping.exe", "-n", "600", "127.0.0.1"], timeoutMs: 600_000, maxOutputBytes: 100_000 });
    // Wait until the sandbox exists.
    let listed = "";
    for (let i = 0; i < 60 && !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(listed); i++) { await new Promise((resolve) => setTimeout(resolve, 2000)); listed = await wsbList(); }
    assert.match(listed, /[0-9a-f]{8}-[0-9a-f]{4}/i, "the first job's sandbox is running");
    const second = await (await launcher.launch({ recipe: recipe(), command: ["/windows/system32/cmd.exe", "/d", "/c", "exit 0"], timeoutMs: 60_000, maxOutputBytes: 1000 })).result;
    note("busy", { exitCode: second.exitCode, stderr: second.stderr });
    assert.equal(second.exitCode, 75);
    assert.match(second.stderr, /busy/);
    long.kill();
    const killed = await long.result;
    assert.equal(killed.killed, true);
    assert.ok(!(await wsbList()).match(/[0-9a-f]{8}-[0-9a-f]{4}/i), "the sandbox is gone after the kill");
    assert.equal(await acl(r.workdir), aclBefore);
  });

  check("fail closed: another account at the console, or a client older than asked for, gives no capacity and starts nothing", async () => {
    const wrongOwner = await launcherFor({ owner: "NOSUCHDOMAIN\\nobody" });
    assert.equal(wrongOwner.capacity.available, false);
    assert.match(wrongOwner.capacity.reason!, /not the configured owner/);
    await assert.rejects(wrongOwner.launch({ recipe: recipe(), command: ["/windows/system32/cmd.exe", "/d", "/c", "exit 0"], timeoutMs: 10_000, maxOutputBytes: 100 }), /no confined launch is possible/);
    const tooNew = await launcherFor({ minVersion: "99.0.0.0" });
    assert.equal(tooNew.capacity.available, false);
    assert.match(tooNew.capacity.reason!, /older than the qualified 99/);
    assert.ok(!(await wsbList()).match(/[0-9a-f]{8}-[0-9a-f]{4}/i));
  });

  check("the strict supervisor-ACL rule on this machine (recorded; asserted only when the strict rule is the one in use)", async () => {
    const strict = await windowsSandboxBackend(opts({ supervisorAcl: "strict" })).health();
    note("strict supervisor ACL", { healthy: strict.healthy, reason: strict.reason });
    if (process.env["NIMBLENEWT_WSB_SUPERVISOR_ACL"] !== "report-only") assert.equal(strict.healthy, true, strict.reason);
  });

  check("auto-login and lock mode is off by default and, only when this machine was set up for it, admits work only on a locked console", { skip: autologonToo ? false : "set NIMBLENEWT_REAL_WINDOWS_AUTOLOGON=1 on a machine the owner set up for auto-login and lock" }, async () => {
    assert.equal(windowsSandboxBackend(opts()).auditDetails!()["windowsMode"], "owner-session");
    modes.add("autologon-lock");
    const lockHelper = process.env["NIMBLENEWT_WSB_LOCK_HELPER"];
    assert.ok(lockHelper !== undefined, "NIMBLENEWT_WSB_LOCK_HELPER must name the lock helper the lock task runs");
    const backend = windowsSandboxBackend(opts({ autologonLock: { authority: "owner, local test", acknowledgement: AUTOLOGON_ACKNOWLEDGEMENT, lockHelper } }));
    const h = await backend.health();
    note("autologon-lock health", { healthy: h.healthy, reason: h.reason, session: await host.session(), autologon: await host.autologon() });
    const session = await host.session();
    if (session.locked === true) assert.equal(h.healthy, true, h.reason);
    else { assert.equal(h.healthy, false); assert.match(h.reason!, /not locked|could not be determined/); }
  });
});

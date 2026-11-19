import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";
import { SandboxLauncher, type LaunchRecord } from "./launcher.js";
import type { NormalizedRecipe } from "./recipe.js";
import { windowsSandboxBackend, type WindowsSandboxOptions } from "./windows.js";
import type { ProcessResult, WindowsHost } from "./windows-host.js";
import { EXIT_REFUSED, jobDirFor, lockFile, runWindowsJob, type WindowsJob } from "./windows-job.js";
import { checkWindowsHostPath, entryTokens, entryWrites, packageFamilyName, SANDBOX_PACKAGES, TRUSTED_OWNER_SIDS, VM_FALLBACK_DECISION, WINDOWS_PUBLISHER_ID, type WindowsSettings } from "./windows-plan.js";
import { windowsRealHost } from "./windows-real.js";

// Card A03b: the Windows launcher's own parts on a REAL Windows machine, without Windows Sandbox itself. They run on every Windows CI cell (GitHub's hosted Windows runners,
// which the owner counts as real operating-system runs, 2026-11-18) and skip everywhere else. A hosted runner is Windows Server: it has no Windows Sandbox client and cannot
// start one (no nested virtualisation), so what these tests prove is the part around the sandbox:
//  - the real PowerShell probes (package, signature, console session with its compiled WTS type, auto-login flags as booleans, scheduled task) run and answer in the shape the
//    rules expect, also inside the exact environment the launcher gives the runner process;
//  - fail closed: with no client, the backend reports no capacity, the launcher refuses, and the real runner process refuses on its own and leaves nothing behind;
//  - links, junctions and short names are refused on a real file system before any job exists;
//  - the narrow per-job access lists, applied and taken back by the real icacls on real NTFS around a stand-in `wsb` (the only stand-in): during the job one named account has
//    Modify on the checkout, Read on the inputs and a deny of writing inside .git, nothing on the supervisor's folders, and afterwards every list is exactly as before.
// What only a Windows machine WITH Windows Sandbox can prove (the guest escape fixture, the nested read-only .git share, the wsb command syntax, a hard kill ending the sandbox)
// stays in windows-real.test.ts, which needs NIMBLENEWT_REAL_WINDOWS_SANDBOX=1.
const onWindows = process.platform === "win32";
const skip = onWindows ? false : "Windows only: real Windows host checks (process.platform is not win32)";

/** A specific built-in account that has no entry of its own on a fresh folder, so every entry naming it is one the job added. Not a broad group, not one the ACL reader trusts. */
const SHARE = "NT AUTHORITY\\NETWORK SERVICE";
const OWNER = "CI\\owner";
const lower = (s: string): string => s.toLowerCase();
const sysRoot = (): string => process.env["SystemRoot"] ?? "C:\\Windows";
const icaclsText = (path: string): string => execFileSync(`${sysRoot()}\\System32\\icacls.exe`, [path], { encoding: "utf8", windowsHide: true });
/** The entries an access list holds for one account and did not inherit. */
const ownEntries = (text: string, account: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => lower(l).includes(lower(account)) && !l.includes("(I)"));
const runnerScript = fileURLToPath(new URL("./windows-runner.js", import.meta.url));
const runnerDir = dirname(runnerScript);
const PRESENT = "this machine has a Windows Sandbox client; the no-client case does not apply (windows-real.test.ts covers a machine with one)";
const realHostModule = fileURLToPath(new URL("./windows-real.js", import.meta.url));

describe("Windows launcher parts on a real Windows host (no Windows Sandbox needed)", { skip }, () => {
  let base = "";
  let packagePresent = false;
  const host = windowsRealHost();
  const dir = (...parts: string[]): string => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p; };
  const recipeIn = (name: string): NormalizedRecipe => {
    const work = dir(name, "work");
    mkdirSync(join(work, ".git"), { recursive: true });
    return { mode: "sandboxed", workdir: work, home: dir(name, "home"), scratch: dir(name, "scratch"), readOnly: [], network: "none", env: {}, protectedSubpaths: [".git"], revision: "ci", unprotectedSubpaths: [] };
  };
  const options = (extra: Partial<WindowsSandboxOptions> = {}): WindowsSandboxOptions => ({
    host, controlDir: join(base, "control"), stagingDir: join(base, "staging"), runnerScript, nodeExecutable: process.execPath, shareIdentity: SHARE, owner: OWNER, supervisorAcl: "report-only", ...extra,
  });

  before(async () => {
    // ProgramData, not the temporary folder: on the hosted runners the temporary folder is reached through a short (8.3) name, which the launcher rightly refuses.
    base = realpathSync.native(mkdtempSync(join(process.env["ProgramData"] ?? tmpdir(), "nn-wsb-host-")));
    packagePresent = (await host.findPackage().catch(() => undefined)) !== undefined;
  });
  after(() => { if (base !== "") rmSync(base, { recursive: true, force: true }); });

  test("the real probes answer in the shape the rules expect: package, console session, auto-login flags (booleans only), a missing scheduled task, the lock file", async () => {
    const pkg = await host.findPackage().catch((error: Error) => error);
    // Either the package is absent (undefined), or it is described in full; a lookup this account may not make throws, which the client check turns into a refusal.
    if (pkg !== undefined && !(pkg instanceof Error)) for (const k of ["name", "publisherId", "familyName", "version", "installLocation"] as const) assert.equal(typeof pkg[k], "string", k);
    const session = await host.session();
    if (session.consoleUser !== undefined) assert.match(session.consoleUser, /\S/);
    if (session.locked !== undefined) assert.equal(typeof session.locked, "boolean");
    for (const fact of [session.processInConsoleSession, session.processIsConsoleUser]) if (fact !== undefined) assert.equal(typeof fact, "boolean");
    if (session.consoleUser === undefined) assert.deepEqual(session, {}, "with nobody signed in nothing about this process is reported");
    const auto = await host.autologon();
    assert.equal(typeof auto.enabled, "boolean");
    assert.equal(typeof auto.plaintextPasswordStored, "boolean");
    assert.deepEqual(Object.keys(auto).filter((k) => !["enabled", "user", "plaintextPasswordStored"].includes(k)), [], "the auto-login probe yields flags and a user name, never a password");
    const task = await host.lockTask(`NimbleNewt-ci-${randomUUID()}`);
    assert.deepEqual(task, { present: false, enabled: false });
    // The sandbox lock is created exclusively, and a live process is told from a gone one.
    const lock = join(dir("lock"), "sandbox.lock");
    assert.equal(host.createExclusive(lock, "a"), true);
    assert.equal(host.createExclusive(lock, "b"), false);
    assert.equal(host.readText(lock), "a");
    assert.equal(host.pidAlive(process.pid), true);
    const gone = spawnSync(process.execPath, ["-e", "0"]).pid!;
    assert.equal(host.pidAlive(gone), false);
  });

  test("signatures: a Windows system program is validly signed by Microsoft; a plain file is not valid", async () => {
    const sig = await host.signature(`${sysRoot()}\\System32\\icacls.exe`);
    assert.equal(sig.valid, true);
    assert.equal(sig.status, "Valid");
    assert.match(sig.subject ?? "", /O=Microsoft Corporation/);
    // System programs are signed inside the file or through an installed catalog; where PowerShell does not report the kind it is absent.
    if (sig.signatureType !== undefined) assert.ok(["Authenticode", "Catalog"].includes(sig.signatureType), sig.signatureType);
    const plain = join(dir("sig"), "plain.exe");
    writeFileSync(plain, "not a program");
    const unsigned = await host.signature(plain);
    assert.equal(unsigned.valid, false);
    assert.ok(unsigned.status !== undefined && unsigned.status !== "Valid", `status ${String(unsigned.status)}`);
    // Windows' message is kept short and never carries the file's own path (which could hold an account name).
    assert.ok(!(unsigned.statusMessage ?? "").toLowerCase().includes(plain.toLowerCase()), unsigned.statusMessage);
    assert.ok((unsigned.statusMessage ?? "").length <= 200);
  });

  test("owners: a Windows system program is owned by one of the accounts the package proof trusts, read as a SID; a missing path is an error", async () => {
    const owner = await host.ownerSid(`${sysRoot()}\\System32\\icacls.exe`);
    assert.ok(TRUSTED_OWNER_SIDS.includes(owner), owner);
    const mine = join(dir("owner"), "mine.txt");
    writeFileSync(mine, "x");
    assert.match(await host.ownerSid(mine), /^S-1-\d+(?:-\d+)+$/);
    await assert.rejects(host.ownerSid(join(dir("owner"), "absent.txt")));
  });

  test("access lists by SID (recorded by the real-run findings): a Windows system program's list reads, both readers agree on whether anyone else can change it, and what it holds is recorded", async (t) => {
    const icacls = `${sysRoot()}\\System32\\icacls.exe`;
    const entries = await host.accessEntries!(icacls);
    assert.ok(entries.length > 0);
    for (const e of entries) assert.match(e.sid, /^S-1-\d+(?:-\d+)+$/);
    // The two readers must give the same answer. What the answer is depends on the runner image (hosted images could differ), so it is recorded, not required: on the
    // standard System32 list TrustedInstaller has full control and nobody else can change the file.
    const bySid = entries.filter(entryWrites), byName = await host.writableBy(icacls);
    assert.equal(bySid.length === 0, byName.length === 0, `by SID ${JSON.stringify(bySid)}, by name ${JSON.stringify(byName)}`);
    t.diagnostic(`icacls.exe: TrustedInstaller full control ${String(entries.some((e) => e.allow && e.sid === TRUSTED_OWNER_SIDS[2] && e.rights === 0x1f01ff))}; other writers by SID ${JSON.stringify(bySid.map((e) => `${e.sid} ${entryTokens(e)}`))}, by name ${JSON.stringify(byName)}`);
    // A fresh folder inherits its entries; one explicit grant to NETWORK SERVICE shows up by SID as a writer, as it does for the icacls reader.
    const folder = dir("bysid");
    execFileSync(`${sysRoot()}\\System32\\icacls.exe`, [folder, "/grant", "*S-1-5-20:(OI)(CI)(IO)(M)"], { windowsHide: true });
    const after = await host.accessEntries!(folder);
    const mine = after.filter((e) => e.sid === "S-1-5-20" && !e.inherited);
    assert.equal(mine.length, 1, JSON.stringify(after));
    assert.deepEqual([mine[0]!.inheritOnly, mine[0]!.objectInherit, mine[0]!.containerInherit, entryWrites(mine[0]!)], [true, true, true, true]);
    assert.equal(entryTokens(mine[0]!), "(OI)(CI)(IO)(M)");
    assert.ok((await host.writableBy(folder)).includes("NT AUTHORITY\\NETWORK SERVICE"));
    await assert.rejects(host.accessEntries!(join(folder, "absent.txt")));
  });

  // Each PowerShell probe has its own limit (PROBE_TIMEOUT_MS) and one retry on a timeout. The ceiling that governs here is not a per-test one: the package runner's
  // --test-timeout (300 s) also bounds this whole file (node --test runs each file as one timed test), and a per-test limit could not fire during spawnSync anyway. In run
  // 44242108811 the other tests of this file took about 30 s together, so the child gets 250 s: past that it is stopped and this test fails with its own message, and the job
  // is released whatever happens, so no later test sees it. (Seven probes that each time out twice would need 840 s; that is a failure, not a case to wait for.)
  const ENV_PROBES_CHILD_MS = 250_000;
  test("the probes also work inside the exact environment the launcher gives the runner process (its own temporary folder, nothing of the user's)", async () => {
    const backend = windowsSandboxBackend(options());
    const plan = backend.plan(recipeIn("envjob"), ["/windows/system32/cmd.exe", "/d", "/c", "exit 0"], `ci-${randomUUID()}`);
    try {
      assert.ok(existsSync(plan.env["TEMP"]!), "the runner's temporary folder exists");
      const script = [
        `const { windowsRealHost } = await import(${JSON.stringify(pathToFileURL(realHostModule).href)});`,
        "const h = windowsRealHost(); const out = {};",
        // The package lookup runs first in every job (admission); a failure here would make the runner refuse every job, so it must succeed, finding the client or not.
        "for (const [k, f] of Object.entries({ package: () => h.findPackage(), task: () => h.lockTask('NimbleNewt-ci-absent'), session: () => h.session(), autologon: () => h.autologon(), signature: () => h.signature(process.env.SystemRoot + '\\\\System32\\\\icacls.exe'), owner: () => h.ownerSid(process.env.NIMBLENEWT_WSB_JOB), writable: () => h.writableBy(process.env.NIMBLENEWT_WSB_JOB) })) {",
        "  try { const v = await f(); out[k] = k === 'signature' ? v.valid : k === 'writable' ? Array.isArray(v) : k === 'owner' ? /^S-1-/.test(v) : 'ok'; } catch (e) { out[k] = 'failed: ' + String(e.message).slice(0, 300); }",
        "}",
        "process.stdout.write(JSON.stringify(out));",
      ].join("\n");
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...plan.env }, cwd: plan.cwd, encoding: "utf8", timeout: ENV_PROBES_CHILD_MS, windowsHide: true });
      assert.equal(child.status, 0, child.error === undefined ? child.stderr : `the probes did not all answer within ${String(ENV_PROBES_CHILD_MS / 1000)} s (${child.error.message}): ${child.stderr}`);
      assert.deepEqual(JSON.parse(child.stdout), { package: "ok", task: "ok", session: "ok", autologon: "ok", signature: true, owner: true, writable: true });
    } finally {
      await backend.release!(plan);
    }
    assert.deepEqual(host.listDir(join(base, "control", "jobs")), [], "the job is released and its folder removed");
  });

  test("fail closed: with no Windows Sandbox client there is no capacity, the launcher refuses, and nothing is left behind", async (t) => {
    if (packagePresent) { t.skip(PRESENT); return; }
    const backend = windowsSandboxBackend(options());
    const health = await backend.health();
    assert.equal(health.healthy, false);
    assert.equal(health.backend, "windows-sandbox");
    assert.match(health.reason ?? "", /Windows Sandbox is not installed|could not be looked up/);
    assert.ok(health.notes?.some((n) => /^session-dependent/.test(n)), "the session dependence is said even when unhealthy");
    assert.ok(health.notes?.includes(VM_FALLBACK_DECISION));
    const records: LaunchRecord[] = [];
    const launcher = await SandboxLauncher.create({ backend, protectedPaths: [], audit: (r) => { records.push(r); } });
    assert.equal(launcher.capacity.available, false);
    assert.equal(launcher.capacity.backend, "windows-sandbox");
    await assert.rejects(launcher.launch({ recipe: recipeIn("refused"), command: ["/windows/system32/cmd.exe", "/d", "/c", "exit 0"], timeoutMs: 10_000, maxOutputBytes: 100 }), /no confined launch is possible/);
    assert.deepEqual(records, [], "nothing was recorded as launched");
    assert.deepEqual(host.listDir(join(base, "control", "jobs")), []);
    assert.equal(existsSync(join(base, "control", "sandbox.lock")), false);
  });

  test("fail closed in the runner process itself: started directly on a job, it refuses (exit 70), changes no access list and removes its lock and job folder", (t) => {
    if (packagePresent) { t.skip(PRESENT); return; }
    const backend = windowsSandboxBackend(options());
    const r = recipeIn("runner");
    const aclBefore = icaclsText(r.workdir);
    const plan = backend.plan(r, ["/windows/system32/cmd.exe", "/d", "/c", "exit 0"], `ci-${randomUUID()}`);
    const jobDir = plan.env["NIMBLENEWT_WSB_JOB"]!;
    assert.ok(existsSync(join(jobDir, "job.json")));
    const child = spawnSync(plan.file, [...plan.args], { env: { ...plan.env }, cwd: plan.cwd, encoding: "utf8", timeout: 240_000, windowsHide: true });
    assert.equal(child.status, EXIT_REFUSED, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stderr, /^refused: (?:Windows Sandbox is not installed|the Windows Sandbox client could not be looked up)/);
    assert.equal(existsSync(jobDir), false, "the job folder is gone");
    assert.equal(existsSync(join(base, "control", "sandbox.lock")), false, "the lock is gone");
    assert.equal(icaclsText(r.workdir), aclBefore);
  });

  test("links, junctions and short names are refused on the real file system before any job exists", async (t) => {
    const backend = windowsSandboxBackend(options());
    const real = recipeIn("links");
    const target = dir("links", "target");
    const junction = join(base, "links", "junction");
    symlinkSync(target, junction, "junction");
    assert.equal(host.isLinkOrJunction(real.workdir), false);
    assert.equal(host.isLinkOrJunction(junction), true);
    mkdirSync(join(target, "below"));
    assert.equal(host.isLinkOrJunction(join(junction, "below")), true, "a junction higher up counts");
    const jobsBefore = host.listDir(join(base, "control", "jobs")).length;
    assert.throws(() => backend.plan({ ...real, workdir: junction }, ["/windows/system32/cmd.exe"]), /link or junction/);
    assert.throws(() => backend.plan({ ...real, scratch: join(junction, "below") }, ["/windows/system32/cmd.exe"]), /link or junction/);
    assert.equal(host.listDir(join(base, "control", "jobs")).length, jobsBefore, "no job folder was made");
    // A short (8.3) alias of a long folder name: only when this volume makes short names (it may not).
    const long = dir("links", "a folder with a long name");
    const short = spawnSync(`${sysRoot()}\\System32\\cmd.exe`, ["/d", "/s", "/c", `"for %A in ("${long}") do @echo %~sA"`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true }).stdout.trim();
    if (lower(short) === lower(long) || !/~\d/.test(short)) { t.diagnostic("this volume made no short name; the short-name refusal is covered by windows.test.ts only"); return; }
    assert.equal(host.isLinkOrJunction(short), true, "a short name differs from the real path");
    assert.throws(() => checkWindowsHostPath("workdir", short, (n) => process.env[n]), /short-name/);
  });

  test("per-job access lists on real NTFS: one named account gets exactly the narrow grants during the job, the supervisor's folders get nothing, and every list is restored exactly", async () => {
    const controlDir = join(base, "control-acl");
    const settings: WindowsSettings = { controlDir, shareIdentity: SHARE, owner: OWNER, minVersion: "0.8.107.0", mode: "owner-session", lockTask: "NimbleNewt-LockOnLogon" };
    mkdirSync(controlDir, { recursive: true });
    const r = recipeIn("acl");
    const input = dir("acl", "input");
    writeFileSync(join(input, "tool.txt"), "x");
    mkdirSync(join(r.workdir, "src"));
    writeFileSync(join(r.workdir, "src", "a.txt"), "a");
    writeFileSync(join(r.workdir, ".git", "HEAD"), "ref: refs/heads/main\n");
    const recipe: NormalizedRecipe = { ...r, readOnly: [{ host: input, guest: "/inputs/tools" }] };
    const watched = [r.workdir, join(r.workdir, "src"), join(r.workdir, "src", "a.txt"), join(r.workdir, ".git"), join(r.workdir, ".git", "HEAD"), r.home, r.scratch, input, join(input, "tool.txt"), controlDir];
    const aclBefore = new Map(watched.map((p) => [p, icaclsText(p)]));
    for (const [p, text] of aclBefore) assert.deepEqual(ownEntries(text, SHARE), [], `${p} starts with no entry for the share account`);

    // The one stand-in: the Windows Sandbox client. Its package, signature and the console session are reported as verified; every other call (icacls, the file system) is real.
    const install = `${process.env["ProgramFiles"]}\\WindowsApps\\MicrosoftWindows.WindowsSandbox_0.8.107.0_x64__${WINDOWS_PUBLISHER_ID}`;
    const fakeFiles = new Set([`${install}\\wsb.exe`, `${install}\\WindowsSandboxServer.exe`].map(lower));
    const wsb: string[][] = [];
    const jobDir = jobDirFor(settings, `ci-${randomUUID()}`);
    const during: Record<string, string> = {};
    const writable: Record<string, readonly string[]> = {};
    let launchScriptSeen = false;
    const id = randomUUID();
    const stand: WindowsHost = {
      ...host,
      exists: (p) => fakeFiles.has(lower(p)) || host.exists(p),
      findPackage: async () => ({ name: SANDBOX_PACKAGES[0]!.name, publisherId: SANDBOX_PACKAGES[0]!.publisherId, familyName: packageFamilyName(SANDBOX_PACKAGES[0]!), version: "0.8.107.0", installLocation: install }),
      signature: async () => ({ valid: true, subject: "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" }),
      session: async () => ({ consoleUser: OWNER, locked: false, processInConsoleSession: true, processIsConsoleUser: true }),
      run: async (file, args, opts): Promise<ProcessResult> => {
        if (!lower(file).endsWith("\\wsb.exe")) return host.run(file, args, opts);
        wsb.push([...args]);
        if (args[0] === "start") return { code: 0, stdout: `{"Id":"${id}"}\r\n`, stderr: "", timedOut: false };
        if (args[0] === "exec") {
          for (const p of [...watched, join(jobDir, "guest")]) during[p] = icaclsText(p);
          for (const p of [r.workdir, input, controlDir, runnerDir]) writable[p] = await host.writableBy(p);
          launchScriptSeen = existsSync(join(jobDir, "guest", "launch.cmd"));
          return { code: 0, stdout: "guest-ok\r\n", stderr: "", timedOut: false };
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    };
    const job: WindowsJob = { version: 1, settings, recipe, command: ["/windows/system32/cmd.exe", "/d", "/c", "exit 0"] };
    const out = await runWindowsJob(stand, job, [runnerDir], jobDir);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stdout, "guest-ok\r\n");
    assert.deepEqual(wsb.map((a) => a[0]), ["start", "exec", "stop"]);
    const config = wsb[0]![2]!;
    assert.match(config, /<Networking>Disable<\/Networking>/);
    assert.ok(config.includes(`<HostFolder>${r.workdir}\\.git</HostFolder><SandboxFolder>C:\\nn\\work\\.git</SandboxFolder><ReadOnly>true</ReadOnly>`));
    assert.ok(launchScriptSeen, "the launch script was in the job's read-only guest folder while the command ran");

    // During the job: exactly the narrow grants, set on the shared folders themselves and inherited below them.
    const own = (p: string): string[] => ownEntries(during[p]!, SHARE);
    assert.equal(own(r.workdir).length, 1, during[r.workdir]);
    assert.match(own(r.workdir)[0]!, /\(OI\)\(CI\)\(M\)$/);
    for (const p of [r.home, r.scratch]) assert.match(own(p).join("\n"), /\(OI\)\(CI\)\(M\)$/, p);
    assert.equal(own(input).length, 1, during[input]);
    assert.match(own(input)[0]!, /\(OI\)\(CI\)\(RX\)$/);
    // icacls may print the flags of a deny entry in either order ("(OI)(CI)(DENY)(W,DC)" or "(DENY)(OI)(CI)(W,DC)"); only the set of flags is checked, and the rights as W or as their parts (WD,AD,...).
    const denies = own(join(r.workdir, ".git")).filter((e) => ["(OI)", "(CI)", "(DENY)"].every((f) => e.includes(f)) && /[(,](?:W|WD)[,)]/.test(e));
    assert.equal(denies.length, 1, during[join(r.workdir, ".git")]);
    assert.match(own(join(jobDir, "guest")).join("\n"), /\(OI\)\(CI\)\(RX\)$/);
    assert.deepEqual(own(controlDir), [], "the control folder itself gets nothing");
    assert.ok(lower(during[join(r.workdir, "src", "a.txt")]!).includes(lower(SHARE)), "a file already in the checkout inherits the grant");
    const named = (list: readonly string[]): boolean => list.some((w) => lower(w) === lower(SHARE));
    assert.equal(named(writable[r.workdir]!), true, "the ACL reader sees the share account can write the checkout");
    assert.equal(named(writable[input]!), false, "but not the inputs");
    assert.equal(named(writable[controlDir]!), false, "nor the control folder");
    assert.equal(named(writable[runnerDir]!), false, "nor the supervisor's code");

    // Afterwards: every access list exactly as before, the job folder and the lock gone.
    for (const [p, text] of aclBefore) assert.equal(icaclsText(p), text, `${p} is restored exactly`);
    assert.equal(existsSync(jobDir), false);
    assert.equal(existsSync(lockFile(settings)), false);
    assert.deepEqual(readdirSync(join(controlDir, "jobs")), []);
  });
});

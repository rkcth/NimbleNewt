import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { BackendHealth, SandboxBackend, SpawnPlan } from "./backend.js";
import { SandboxLauncher, stripTrailingSeparator, type LaunchRecord } from "./launcher.js";
import type { NormalizedRecipe } from "./recipe.js";
import { AUTOLOGON_ACKNOWLEDGEMENT, VM_FALLBACK_DECISION, windowsSandboxBackend, type WindowsSandboxOptions } from "./windows.js";
import type { ProcessResult, WindowsAutologon, WindowsHost, WindowsLockTask, WindowsPackageInfo, WindowsSession } from "./windows-host.js";
import { EXIT_BUSY, EXIT_REFUSED, jobDirFor, runWindowsJob, type WindowsJob } from "./windows-job.js";
import { aclSteps, checkIdentity, checkWindowsHostPath, compareVersions, guestPathFor, launchScript, parseIcaclsWritable, quoteArg, sharesFor, wsbConfigXml, type WindowsSettings } from "./windows-plan.js";

// These tests run on every OS with a simulated Windows host: they prove the rules (what is refused, what is recorded, in what order things happen) but NOT that
// Windows Sandbox itself confines anything. That is windows-real.test.ts, which runs only on a Windows machine with NIMBLENEWT_REAL_WINDOWS_SANDBOX=1.

const INSTALL = "C:\\Program Files\\WindowsApps\\MicrosoftWindows.WindowsSandbox_0.8.107.0_x64__8wekyb3d8bbwe";
const CONTROL = "C:\\ProgramData\\NimbleNewt\\control";
const STAGING = "C:\\ProgramData\\NimbleNewt\\staging";
const RUNNER = "C:\\Program Files\\NimbleNewt\\worker\\dist\\sandbox\\windows-runner.js";
const MS = "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";
const key = (p: string): string => p.toLowerCase();

type Guest = (config: string, args: readonly string[]) => ProcessResult;
const ok = (stdout = "", code = 0): ProcessResult => ({ code, stdout, stderr: "", timedOut: false });

/** A Windows machine in memory. It records every program started so the tests can check order, arguments and working directories. */
class SimHost implements WindowsHost {
  platform = "win32";
  pid = 4242;
  envMap: Record<string, string> = { SystemRoot: "C:\\Windows", SystemDrive: "C:", ProgramFiles: "C:\\Program Files", ProgramData: "C:\\ProgramData" };
  files = new Map<string, string>();
  dirs = new Set<string>();
  links = new Set<string>();
  runs: { file: string; args: readonly string[]; cwd?: string }[] = [];
  pkg: WindowsPackageInfo | undefined = { name: "MicrosoftWindows.WindowsSandbox", publisherId: "8wekyb3d8bbwe", version: "0.8.107.0", installLocation: INSTALL };
  sigs = new Map<string, { valid: boolean; subject?: string }>();
  sess: WindowsSession = { consoleUser: "PC\\robert", locked: false };
  auto: WindowsAutologon = { enabled: true, user: "PC\\robert", plaintextPasswordStored: false };
  task: WindowsLockTask = { present: true, enabled: true, executable: "C:\\Program Files\\NimbleNewt\\lock.exe" };
  writable = new Map<string, string[]>();
  /** Each path's access list as icacls prints it, one entry per line. */
  acl = new Map<string, string[]>();
  saved = new Map<string, string[]>();
  restoreFailure = false;
  saveFailure = false;
  alive = new Set<number>();
  sandboxes = new Set<string>();
  nextId = 1;
  stopFailure = false;
  guest: Guest = () => ok("hello\r\n");
  startFailure: ProcessResult | undefined;
  aclFailure = false;
  afterStart: (() => void) | undefined;
  lookups: string[] = [];

  constructor() {
    for (const f of [`${INSTALL}\\wsb.exe`, `${INSTALL}\\WindowsSandboxServer.exe`, "C:\\Program Files\\NimbleNewt\\lock.exe"]) this.files.set(key(f), "");
  }
  env(name: string): string | undefined { return this.envMap[name]; }
  pidAlive(pid: number): boolean { return this.alive.has(pid); }
  exists(p: string): boolean { return this.files.has(key(p)) || this.dirs.has(key(p)); }
  isLinkOrJunction(p: string): boolean { return this.links.has(key(p)); }
  mkdirp(p: string): void { let cur = p; while (cur.length > 3) { this.dirs.add(key(cur)); cur = cur.slice(0, cur.lastIndexOf("\\")); } }
  readText(p: string): string | undefined { return this.files.get(key(p)); }
  writeText(p: string, text: string): void { this.mkdirp(p.slice(0, p.lastIndexOf("\\"))); this.files.set(key(p), text); }
  createExclusive(p: string, text: string): boolean { if (this.files.has(key(p))) return false; this.writeText(p, text); return true; }
  rename(a: string, b: string): void { const v = this.files.get(key(a)); if (v === undefined) throw new Error("ENOENT"); this.files.delete(key(a)); this.files.set(key(b), v); }
  listDir(p: string): string[] { const k = key(p) + "\\"; const out = new Set<string>(); for (const x of [...this.files.keys(), ...this.dirs]) if (x.startsWith(k)) out.add(x.slice(k.length).split("\\")[0]!); return [...out]; }
  remove(p: string): void { const k = key(p); for (const f of [...this.files.keys()]) if (f === k || f.startsWith(k + "\\")) this.files.delete(f); for (const d of [...this.dirs]) if (d === k || d.startsWith(k + "\\")) this.dirs.delete(d); }
  async findPackage(): Promise<WindowsPackageInfo | undefined> { this.lookups.push("package"); return this.pkg; }
  async signature(path: string): Promise<{ valid: boolean; subject?: string }> { return this.sigs.get(key(path)) ?? { valid: true, subject: MS }; }
  async session(): Promise<WindowsSession> { return this.sess; }
  async autologon(): Promise<WindowsAutologon> { return this.auto; }
  async lockTask(): Promise<WindowsLockTask> { return this.task; }
  async writableBy(path: string): Promise<readonly string[]> { return this.writable.get(key(path)) ?? []; }
  async run(file: string, args: readonly string[], options: { cwd?: string }): Promise<ProcessResult> {
    this.runs.push({ file, args, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
    if (file.toLowerCase().endsWith("\\icacls.exe")) return this.icacls(args);
    assert.ok(file.toLowerCase().endsWith("\\wsb.exe"), `unexpected program ${file}`);
    // The research found the client fails unless started from its own folder.
    if (options.cwd?.toLowerCase() !== INSTALL.toLowerCase()) return { code: 1, stdout: "", stderr: "WindowsSandboxServer.exe not found", timedOut: false };
    if (args[0] === "start") {
      if (this.startFailure !== undefined) return this.startFailure;
      const id = `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`;
      this.sandboxes.add(id);
      this.afterStart?.();
      return ok(`Windows Sandbox environment started successfully\r\n Id: ${id}\r\n`);
    }
    if (args[0] === "exec") {
      if (!this.sandboxes.has(args[2]!)) return { code: 1, stdout: "", stderr: "no such environment", timedOut: false };
      return this.guest(this.lastConfig(), args);
    }
    if (args[0] === "stop") { if (this.stopFailure) return { code: 1, stdout: "", stderr: "cannot stop", timedOut: false }; this.sandboxes.delete(args[2]!); return ok(); }
    if (args[0] === "list") return ok([...this.sandboxes].join("\r\n"));
    return { code: 2, stdout: "", stderr: "bad command", timedOut: false };
  }
  lastConfig(): string { const start = [...this.runs].reverse().find((r) => r.args[0] === "start"); return start?.args[2] ?? ""; }
  icacls(args: readonly string[]): ProcessResult {
    const path = args[0]!;
    const entries = (p: string): string[] => this.acl.get(key(p)) ?? ["NT AUTHORITY\\SYSTEM:(OI)(CI)(F)"];
    if (args.length === 1) return ok(`${path} ${entries(path).map((n, i) => (i === 0 ? "" : "       ") + n).join("\r\n")}\r\n`);
    if (args[1] === "/save" && this.saveFailure) return { code: 5, stdout: "", stderr: "Access is denied.", timedOut: false };
    if (args[1] === "/save") { this.saved.set(key(args[2]!), [...entries(path)]); this.savedFor.set(key(args[2]!), path); this.writeText(args[2]!, "saved"); return ok(); }
    if (args[1] === "/restore") {
      if (this.restoreFailure || !this.saved.has(key(args[2]!))) return { code: 5, stdout: "", stderr: "Access is denied.", timedOut: false };
      // /restore is given the parent folder; the saved file knows the folder's own name.
      const name = [...this.saved.keys()].includes(key(args[2]!)) ? this.savedFor.get(key(args[2]!))! : "";
      this.acl.set(key(name), [...this.saved.get(key(args[2]!))!]);
      return ok();
    }
    if (this.aclFailure) return { code: 5, stdout: "", stderr: "Access is denied.", timedOut: false };
    const who = args[2]!.split(":")[0]!.replace(/^\*/, "");
    const list = [...entries(path)];
    if (args[1] === "/grant") list.push(`${who}:${args[2]!.slice(args[2]!.indexOf(":") + 1)}`);
    else if (args[1] === "/deny") list.push(`${who}:(DENY)${args[2]!.slice(args[2]!.indexOf(":") + 1)}`);
    this.acl.set(key(path), list);
    return ok("Successfully processed 1 files; Failed processing 0 files\r\n");
  }
  savedFor = new Map<string, string>();
  get wsbCommands(): string[] { return this.runs.filter((r) => r.file.toLowerCase().endsWith("wsb.exe")).map((r) => r.args[0]!); }
  get icaclsMutations(): readonly (readonly string[])[] { return this.runs.filter((r) => r.file.toLowerCase().endsWith("icacls.exe") && r.args.length > 1).map((r) => r.args); }
}

function options(host: SimHost, extra: Partial<WindowsSandboxOptions> = {}): WindowsSandboxOptions {
  return { host, controlDir: CONTROL, stagingDir: STAGING, runnerScript: RUNNER, shareIdentity: "PC\\robert", owner: "PC\\robert", ...extra };
}
const OPT_IN = { authority: "Rob, 2026-10-22", acknowledgement: AUTOLOGON_ACKNOWLEDGEMENT, lockHelper: "C:\\Program Files\\NimbleNewt\\lock.exe" };

/** The guest of a probe run: does what a confined guest does (or, for a test, what a broken one does), writing the files the host will look for. */
function probeGuest(host: SimHost, behave: { work?: boolean; readOnlyHolds?: boolean; gitHolds?: boolean; networkDenied?: boolean } = {}): Guest {
  return (config) => {
    const folder = (guest: string): string => new RegExp(`<HostFolder>([^<]*)</HostFolder><SandboxFolder>${guest.replace(/\\/g, "\\\\")}</SandboxFolder>`).exec(config)![1]!;
    if (behave.work !== false) host.writeText(`${folder("C:\\nn\\work")}\\ok.txt`, "x"); else return ok("", 11);
    if (behave.readOnlyHolds === false) { host.writeText(`${folder("C:\\nn\\inputs\\probe")}\\denied.txt`, "x"); return ok("", 12); }
    if (behave.gitHolds === false) { host.writeText(`${folder("C:\\nn\\work\\.git")}\\denied.txt`, "x"); return ok("", 13); }
    if (behave.networkDenied === false) return ok("", 14);
    return ok("confined\r\n");
  };
}

const recipe = (extra: Partial<NormalizedRecipe> = {}): NormalizedRecipe => ({
  mode: "sandboxed", workdir: "C:\\Jobs\\a\\work", home: "C:\\Jobs\\a\\home", scratch: "C:\\Jobs\\a\\scratch", readOnly: [{ host: "C:\\Tools\\node", guest: "/inputs/node" }],
  network: "none", env: { FOO: "bar" }, protectedSubpaths: [".git"], revision: "rev1", unprotectedSubpaths: [], ...extra,
});
const settings = (extra: Partial<WindowsSettings> = {}): WindowsSettings => ({ controlDir: CONTROL, shareIdentity: "PC\\robert", owner: "PC\\robert", minVersion: "0.8.107.0", packageName: "MicrosoftWindows.WindowsSandbox", publisherId: "8wekyb3d8bbwe", mode: "owner-session", lockTask: "NimbleNewt-LockOnLogon", ...extra });
const COMMAND = ["/inputs/node/node.exe", "-e", "1"];

function prepared(host: SimHost, extra: Partial<WindowsSandboxOptions> = {}, r: NormalizedRecipe = recipe()): { backend: SandboxBackend; plan: SpawnPlan; job: WindowsJob; jobDir: string } {
  const backend = windowsSandboxBackend(options(host, extra));
  const plan = backend.plan(r, COMMAND);
  const jobDir = plan.env["NIMBLENEWT_WSB_JOB"]!;
  return { backend, plan, job: JSON.parse(host.readText(`${jobDir}\\job.json`)!) as WindowsJob, jobDir };
}

describe("Windows launcher: pure rules", () => {
  test("versions compare numerically", () => {
    assert.equal(compareVersions("0.8.107.0", "0.8.107.0"), 0);
    assert.equal(compareVersions("0.10.0.0", "0.8.107.0"), 1);
    assert.equal(compareVersions("0.8.9", "0.8.107.0"), -1);
    assert.throws(() => compareVersions("latest", "0.1"), /not a version/);
  });

  test("a shared host path must be a local, normalised path that is not the system", () => {
    const env = (n: string): string | undefined => ({ SystemRoot: "C:\\Windows", SystemDrive: "C:", ProgramFiles: "C:\\Program Files", ProgramData: "C:\\ProgramData" })[n];
    for (const good of ["C:\\Jobs\\a", "D:\\x y\\z", "C:\\ProgramData\\NimbleNewt\\job1", "C:\\Users\\robert\\checkout"]) assert.equal(checkWindowsHostPath("p", good, env), good);
    for (const badPath of ["work", "\\\\server\\share", "\\\\?\\C:\\x", "C:\\x\\..\\y", "C:\\x\\", "C:\\x:stream", "C:\\x\\PROGRA~1", "C:\\x.", "C:", "C:\\a|b", "C:\\Windows", "C:\\windows\\system32", "C:\\Program Files\\x", "C:\\ProgramData", "C:\\Users", "C:\\x//y"]) {
      assert.throws(() => checkWindowsHostPath("p", badPath, env), /./, badPath);
    }
  });

  test("the share account is one named account, never a broad group or a system account", () => {
    for (const good of ["PC\\robert", "robert", "S-1-5-21-1-2-3-1001"]) assert.equal(checkIdentity("a", good), good);
    for (const badId of ["Everyone", "Users", "BUILTIN\\Users", "Authenticated Users", "NT AUTHORITY\\SYSTEM", "SYSTEM", "Administrators", "S-1-1-0", "S-1-5-32-545", "S-1-5-18", "", "a/b", "x:(F)"]) assert.throws(() => checkIdentity("a", badId), /./, badId);
  });

  test("guest paths and command arguments", () => {
    assert.equal(guestPathFor("/work/src/a.js"), "C:\\nn\\work\\src\\a.js");
    assert.equal(guestPathFor("/inputs/node/node.exe"), "C:\\nn\\inputs\\node\\node.exe");
    assert.equal(guestPathFor("/windows/system32/cmd.exe"), "C:\\Windows\\system32\\cmd.exe");
    assert.equal(guestPathFor("/etc/passwd"), undefined);
    assert.equal(guestPathFor("/work/../x"), undefined);
    assert.equal(guestPathFor("/work/a:b"), undefined);
    assert.equal(quoteArg("plain"), "plain");
    assert.equal(quoteArg("two words"), '"two words"');
    assert.equal(quoteArg("a&b"), '"a&b"');
    assert.equal(quoteArg("dir\\ "), '"dir\\ "');
    assert.equal(quoteArg("C:\\x y\\"), '"C:\\x y\\\\"');
    assert.equal(quoteArg(""), '""');
    for (const evil of ['a"b', "%PATH%", "a\nb", "a\0b"]) assert.throws(() => quoteArg(evil), /may not contain/);
  });

  test("the launch script is generated from the recipe, refuses unsafe values and carries no host path", () => {
    const script = launchScript(recipe(), COMMAND);
    assert.match(script, /^@echo off\r\n/);
    assert.ok(script.includes('set "FOO=bar"') && script.includes('cd /d "C:\\nn\\work"') && script.includes("C:\\nn\\inputs\\node\\node.exe -e 1"));
    assert.ok(!script.includes("C:\\Jobs") && !script.includes("C:\\Tools"));
    assert.throws(() => launchScript(recipe({ env: { X: "a%b" } }), COMMAND), /percent/);
    assert.throws(() => launchScript(recipe({ env: { X: 'a"b' } }), COMMAND), /quote/);
    assert.throws(() => launchScript(recipe(), ["/etc/evil"]), /program must be under/);
  });

  test("the sandbox configuration has no network or devices and shares only the listed folders", () => {
    const shares = sharesFor(recipe(), `${CONTROL}\\jobs\\x\\guest`);
    const xml = wsbConfigXml(shares);
    for (const off of ["VGpu", "Networking", "AudioInput", "VideoInput", "PrinterRedirection", "ClipboardRedirection"]) assert.ok(xml.includes(`<${off}>Disable</${off}>`), off);
    assert.ok(xml.includes("<ProtectedClient>Enable</ProtectedClient>"));
    assert.equal(xml.match(/<MappedFolder>/g)!.length, 6);
    assert.ok(xml.includes("<HostFolder>C:\\Jobs\\a\\work</HostFolder><SandboxFolder>C:\\nn\\work</SandboxFolder><ReadOnly>false</ReadOnly>"));
    assert.ok(xml.includes("<HostFolder>C:\\Tools\\node</HostFolder><SandboxFolder>C:\\nn\\inputs\\node</SandboxFolder><ReadOnly>true</ReadOnly>"));
    assert.ok(xml.includes("<HostFolder>C:\\Jobs\\a\\work\\.git</HostFolder><SandboxFolder>C:\\nn\\work\\.git</SandboxFolder><ReadOnly>true</ReadOnly>"));
    assert.ok(xml.includes("<SandboxFolder>C:\\nn\\job</SandboxFolder><ReadOnly>true</ReadOnly>"));
    assert.ok(!xml.includes(CONTROL + "\\job.json"));
    // A path cannot break out of the XML.
    const evil = wsbConfigXml([{ host: 'C:\\a"</HostFolder><X>&', guest: "C:\\nn\\work", readOnly: false, why: "work" }]);
    assert.ok(!evil.includes("<X>") && evil.includes("&amp;") && evil.includes("&quot;"));
    // A protected name that does not exist is not shared.
    assert.equal(sharesFor(recipe({ unprotectedSubpaths: [".git"] }), "J").some((s) => s.why === "protected"), false);
  });

  test("per-job ACLs name only the share account: modify on writable folders, read on inputs, no writing in .git, nothing for a group", () => {
    const steps = aclSteps("PC\\robert", sharesFor(recipe(), `${CONTROL}\\jobs\\x\\guest`));
    const by = (suffix: string) => steps.find((s) => s.path.endsWith(suffix))!;
    assert.deepEqual(by("\\work").apply, ["C:\\Jobs\\a\\work", "/grant", "PC\\robert:(OI)(CI)M"]);
    assert.deepEqual(by("\\node").apply, ["C:\\Tools\\node", "/grant", "PC\\robert:(OI)(CI)RX"]);
    assert.deepEqual(by(".git").apply, ["C:\\Jobs\\a\\work\\.git", "/deny", "PC\\robert:(OI)(CI)(W,DC)"]);
    assert.deepEqual(by("\\guest").apply[2], "PC\\robert:(OI)(CI)RX");
    for (const s of steps) { const joined = s.apply.join(" "); assert.ok(!/Everyone|Users|Authenticated|\/inheritance|\/reset|\/setowner|:F\b|\(F\)/i.test(joined), joined); }
    assert.equal(aclSteps("S-1-5-21-1-2-3-1001", [{ host: "C:\\x", guest: "C:\\nn\\work", readOnly: false, why: "work" }])[0]!.apply[2], "*S-1-5-21-1-2-3-1001:(OI)(CI)M");
    assert.throws(() => aclSteps("Everyone", []), /broad group/);
  });

  test("an access list is read for who else can write", () => {
    const text = [
      "C:\\x NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "      BUILTIN\\Administrators:(OI)(CI)(F)", "      PC\\robert:(OI)(CI)(M)", "      BUILTIN\\Users:(OI)(CI)(RX)", "      Everyone:(DENY)(W)",
      "      NT SERVICE\\TrustedInstaller:(CI)(F)", "      Authenticated Users:(I)(OI)(CI)(WD,AD)", "", "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");
    assert.deepEqual(parseIcaclsWritable(text, "C:\\x").sort(), ["Authenticated Users", "PC\\robert"]);
  });
});

describe("Windows launcher: configuration (nothing is on by default)", () => {
  test("the default mode is the owner session; auto-login and lock exists only with the owner's explicit, exact opt-in", () => {
    const host = new SimHost();
    assert.equal(windowsSandboxBackend(options(host)).auditDetails!()["windowsMode"], "owner-session");
    assert.equal(windowsSandboxBackend(options(host)).auditDetails!()["autologon"], "off (never a default)");
    assert.throws(() => windowsSandboxBackend(options(host, { autologonLock: { ...OPT_IN, acknowledgement: "yes" } })), /explicit opt-in/);
    assert.throws(() => windowsSandboxBackend(options(host, { autologonLock: { ...OPT_IN, authority: " " } })), /authority/);
    const on = windowsSandboxBackend(options(host, { autologonLock: OPT_IN })).auditDetails!();
    assert.equal(on["windowsMode"], "autologon-lock");
    assert.equal(on["autologonAuthority"], "Rob, 2026-10-22");
  });

  test("nothing in the host interface can enable auto-login or hold a credential", () => {
    const host = new SimHost();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(host)).concat(Object.keys(host));
    assert.equal(methods.filter((m) => /password|credential|secret|registry|setautologon|enableautologon/i.test(m)).length, 0);
  });

  test("supervisor code and control files cannot sit in guest-writable staging, and bad accounts are refused", () => {
    const host = new SimHost();
    assert.throws(() => windowsSandboxBackend(options(host, { runnerScript: `${STAGING}\\worker\\windows-runner.js` })), /supervisor's code/);
    assert.throws(() => windowsSandboxBackend(options(host, { controlDir: `${STAGING}\\control` })), /overlap/);
    assert.throws(() => windowsSandboxBackend(options(host, { stagingDir: "C:\\ProgramData\\NimbleNewt" })), /overlap/);
    assert.throws(() => windowsSandboxBackend(options(host, { shareIdentity: "Everyone" })), /broad group/);
    assert.throws(() => windowsSandboxBackend(options(host, { runnerScript: "worker\\runner.js" })), /absolute/);
    assert.throws(() => windowsSandboxBackend(options(host, { minVersion: "new" })), /version/);
  });
});

describe("Windows launcher: health (fail closed, mode and limits visible)", () => {
  const health = async (host: SimHost, extra: Partial<WindowsSandboxOptions> = {}, behave?: Parameters<typeof probeGuest>[1]): Promise<BackendHealth> => {
    host.guest = probeGuest(host, behave);
    return windowsSandboxBackend(options(host, extra)).health();
  };

  test("healthy: a real probe sandbox is started, the guest is checked, everything is torn down, and the notes say session-dependent and the VM decision", async () => {
    const host = new SimHost();
    const h = await health(host);
    assert.equal(h.healthy, true, h.reason);
    assert.equal(h.backend, "windows-sandbox");
    assert.equal(h.version, "0.8.107.0");
    assert.ok(h.notes!.some((n) => /session-dependent: Windows Sandbox runs only while PC\\robert is signed in/.test(n)));
    assert.ok(h.notes!.includes(VM_FALLBACK_DECISION));
    assert.match(VM_FALLBACK_DECISION, /not qualified/);
    assert.deepEqual(host.wsbCommands, ["list", "start", "exec", "stop"]);
    assert.equal(host.sandboxes.size, 0);
    for (const entries of host.acl.values()) assert.deepEqual(entries, ["NT AUTHORITY\\SYSTEM:(OI)(CI)(F)"], "the probe's ACL entries were removed");
    assert.deepEqual(host.listDir(STAGING), [], "the probe's folders are gone");
    assert.deepEqual(host.listDir(`${CONTROL}\\jobs`), [], "and so are its job files");
  });

  test("not Windows, or Windows Sandbox missing: no capacity and a reason", async () => {
    const other = new SimHost(); other.platform = "linux";
    assert.match((await health(other)).reason ?? "", /only on Windows/);
    const none = new SimHost(); none.pkg = undefined;
    const h = await health(none);
    assert.equal(h.healthy, false);
    assert.match(h.reason!, /not installed/);
    assert.ok(h.notes!.length >= 2, "the notes are reported when unhealthy too");
    assert.deepEqual(none.wsbCommands, [], "nothing was started");
  });

  test("package verification: publisher, version, location, files, signature and working directory", async () => {
    const wrongPublisher = new SimHost(); wrongPublisher.pkg = { ...wrongPublisher.pkg!, publisherId: "abcdefghjkmnp" };
    assert.match((await health(wrongPublisher)).reason!, /publisher/);
    const wrongName = new SimHost(); wrongName.pkg = { ...wrongName.pkg!, name: "Evil.WindowsSandbox" };
    assert.match((await health(wrongName)).reason!, /unexpected package/);
    const old = new SimHost(); old.pkg = { ...old.pkg!, version: "0.8.106.9" };
    assert.match((await health(old)).reason!, /older than the qualified 0\.8\.107\.0/);
    const newer = new SimHost(); newer.pkg = { ...newer.pkg!, version: "0.9.1.0" };
    const n = await health(newer);
    assert.equal(n.healthy, true); assert.equal(n.version, "0.9.1.0");
    const junk = new SimHost(); junk.pkg = { ...junk.pkg!, version: "banana" };
    assert.match((await health(junk)).reason!, /not a version/);
    const elsewhere = new SimHost(); elsewhere.pkg = { ...elsewhere.pkg!, installLocation: "C:\\Users\\robert\\evil" };
    elsewhere.files.set(key("C:\\Users\\robert\\evil\\wsb.exe"), ""); elsewhere.files.set(key("C:\\Users\\robert\\evil\\WindowsSandboxServer.exe"), "");
    assert.match((await health(elsewhere)).reason!, /protected packages folder/);
    const noServer = new SimHost(); noServer.files.delete(key(`${INSTALL}\\WindowsSandboxServer.exe`));
    assert.match((await health(noServer)).reason!, /WindowsSandboxServer\.exe was not found/);
    const unsigned = new SimHost(); unsigned.sigs.set(key(`${INSTALL}\\wsb.exe`), { valid: false });
    assert.match((await health(unsigned)).reason!, /valid Microsoft signature/);
    const otherSigner = new SimHost(); otherSigner.sigs.set(key(`${INSTALL}\\WindowsSandboxServer.exe`), { valid: true, subject: "CN=Evil Corp, O=Evil Corp" });
    assert.match((await health(otherSigner)).reason!, /valid Microsoft signature/);
    const throws = new SimHost(); throws.findPackage = async () => { throw new Error("service unavailable"); };
    assert.match((await health(throws)).reason!, /could not be looked up: service unavailable/);
    for (const h of [wrongPublisher, old, elsewhere, noServer, unsigned]) assert.deepEqual(h.wsbCommands, []);
  });

  test("the client is always started from its own folder (a start from anywhere else fails like the research showed)", async () => {
    const host = new SimHost();
    assert.equal((await health(host)).healthy, true);
    for (const r of host.runs.filter((x) => x.file.toLowerCase().endsWith("wsb.exe"))) { assert.equal(r.cwd, INSTALL); assert.equal(r.file, `${INSTALL}\\wsb.exe`); }
  });

  test("no usable session: nobody signed in, or someone else, or the session cannot be read", async () => {
    const nobody = new SimHost(); nobody.sess = {};
    const a = await health(nobody);
    assert.equal(a.healthy, false);
    assert.match(a.reason!, /nobody is signed in.*0x8000401A.*auto-login and lock mode/);
    const other = new SimHost(); other.sess = { consoleUser: "PC\\guest" };
    assert.match((await health(other)).reason!, /not the configured owner/);
    const broken = new SimHost(); broken.session = async () => { throw new Error("wtsapi32 failed"); };
    assert.match((await health(broken)).reason!, /could not be examined: wtsapi32 failed/);
    for (const h of [nobody, other, broken]) assert.deepEqual(h.wsbCommands, []);
  });

  test("the probe must show confinement: each way the guest could get out makes the host unhealthy", async () => {
    const cases: [Parameters<typeof probeGuest>[1], RegExp][] = [
      [{ work: false }, /could not write its own checkout/], [{ readOnlyHolds: false }, /write to a read-only input/], [{ gitHolds: false }, /inside the protected \.git/], [{ networkDenied: false }, /reached the network/],
    ];
    for (const [behave, why] of cases) {
      const host = new SimHost();
      const h = await health(host, {}, behave);
      assert.equal(h.healthy, false);
      assert.match(h.reason!, why);
      assert.equal(host.sandboxes.size, 0, "the failed probe's sandbox was stopped");
    }
    // The probe script itself asks for each denial and turns a success into a failing exit code.
    const seen = new SimHost();
    let script = "";
    seen.guest = (config, args) => { script = seen.readText([...seen.files.keys()].find((f) => f.endsWith("\\tools\\probe.cmd")) ?? "") ?? ""; return probeGuest(seen)(config, args); };
    await windowsSandboxBackend(options(seen)).health();
    for (const needle of ["C:\\nn\\work\\ok.txt", "if errorlevel 1 exit /b 11", "C:\\nn\\inputs\\probe\\denied.txt", "if not errorlevel 1 exit /b 12", "C:\\nn\\work\\.git\\denied.txt", "if not errorlevel 1 exit /b 13", "TcpClient", "if errorlevel 1 exit /b 14", "echo confined"]) assert.ok(script.includes(needle), needle);
    // The guest claims success but the host does not show the files it should: not trusted.
    const liar = new SimHost(); liar.guest = () => ok("confined\r\n");
    assert.match((await windowsSandboxBackend(options(liar)).health()).reason!, /does not show the expected files/);
  });

  test("a start that fails because nobody is signed in says why", async () => {
    const host = new SimHost(); host.guest = probeGuest(host);
    host.startFailure = { code: 1, stdout: "", stderr: "Error 0x8000401A: The server process could not be started because the configured identity is incorrect.", timedOut: false };
    const h = await windowsSandboxBackend(options(host)).health();
    assert.equal(h.healthy, false);
    assert.match(h.reason!, /probe failed.*0x8000401A/);
  });

  test("supervisor files writable by the guest's account or a broad group: refused (strict), reported only when relaxed", async () => {
    const host = new SimHost(); host.writable.set(key("C:\\Program Files\\NimbleNewt\\worker\\dist\\sandbox"), ["PC\\robert"]);
    const strict = await health(host);
    assert.equal(strict.healthy, false);
    assert.match(strict.reason!, /supervisor code must be outside anything the guest account can change/);
    const ctl = new SimHost(); ctl.writable.set(key(CONTROL), ["BUILTIN\\Users"]);
    assert.equal((await health(ctl)).healthy, false);
    const relaxed = new SimHost(); relaxed.writable.set(key(CONTROL), ["PC\\robert"]);
    assert.equal((await health(relaxed, { supervisorAcl: "report-only" })).healthy, true);
    assert.equal(windowsSandboxBackend(options(relaxed, { supervisorAcl: "report-only" })).auditDetails!()["supervisorAcl"], "report-only");
  });
});

describe("Windows launcher: explicit auto-login and lock mode", () => {
  const on = (host: SimHost, behave?: Parameters<typeof probeGuest>[1]) => { host.guest = probeGuest(host, behave); host.sess = { consoleUser: "PC\\robert", locked: true }; return windowsSandboxBackend(options(host, { autologonLock: OPT_IN })); };

  test("healthy only with a locked console, local auto-login for the owner, a protected lock task; the notes say what the exposure is", async () => {
    const host = new SimHost();
    const h = await on(host).health();
    assert.equal(h.healthy, true, h.reason);
    assert.ok(h.notes!.some((n) => /auto-login and lock mode \(explicit owner opt-in\).*admission only.*19 seconds/.test(n)));
  });

  test("an unlocked or unknown lock state admits nothing", async () => {
    const host = new SimHost(); const b = on(host);
    host.sess = { consoleUser: "PC\\robert", locked: false };
    assert.match((await b.health()).reason!, /not locked/);
    host.sess = { consoleUser: "PC\\robert" };
    assert.match((await b.health()).reason!, /cannot be determined|could not be determined/);
    assert.deepEqual(host.wsbCommands, []);
  });

  test("the auto-login set-up is checked: present, for the owner, and never a password in the clear", async () => {
    const off = new SimHost(); const a = on(off); off.auto = { enabled: false, plaintextPasswordStored: false };
    assert.match((await a.health()).reason!, /automatic sign-in is not set up locally/);
    const wrong = new SimHost(); const b = on(wrong); wrong.auto = { enabled: true, user: "PC\\other", plaintextPasswordStored: false };
    assert.match((await b.health()).reason!, /not set up locally for the configured owner/);
    const plain = new SimHost(); const c = on(plain); plain.auto = { enabled: true, user: "PC\\robert", plaintextPasswordStored: true };
    assert.match((await c.health()).reason!, /in the clear/);
  });

  test("the lock task must exist, be enabled, run the configured helper, and the helper must be administrator-only", async () => {
    const missing = new SimHost(); const a = on(missing); missing.task = { present: false, enabled: false };
    assert.match((await a.health()).reason!, /lock task NimbleNewt-LockOnLogon is missing/);
    const disabled = new SimHost(); const b = on(disabled); disabled.task = { present: true, enabled: false, executable: OPT_IN.lockHelper };
    assert.match((await b.health()).reason!, /missing, disabled/);
    const other = new SimHost(); const c = on(other); other.task = { present: true, enabled: true, executable: "C:\\Users\\robert\\lock.exe" };
    assert.match((await c.health()).reason!, /does not run the configured lock helper/);
    const writable = new SimHost(); const d = on(writable); writable.writable.set(key(OPT_IN.lockHelper), ["PC\\robert"]);
    assert.match((await d.health()).reason!, /writable only by administrators/);
    const dirWritable = new SimHost(); const e = on(dirWritable); dirWritable.writable.set(key("C:\\Program Files\\NimbleNewt"), ["BUILTIN\\Users"]);
    assert.match((await e.health()).reason!, /writable only by administrators/);
  });

  test("the lock is verified again after the sandbox starts and before the command: a desktop unlocked in between stops the job", async () => {
    const host = new SimHost(); const backend = on(host);
    const { job, jobDir } = prepared(host, { autologonLock: OPT_IN }, recipe());
    host.sess = { consoleUser: "PC\\robert", locked: true };
    host.afterStart = () => { host.sess = { consoleUser: "PC\\robert", locked: false }; };
    const out = await runWindowsJob(host, { ...job, settings: { ...job.settings, mode: "autologon-lock", lockHelper: OPT_IN.lockHelper } }, [], jobDir);
    assert.equal(out.exitCode, EXIT_REFUSED);
    assert.match(out.stderr, /not locked/);
    assert.ok(!host.wsbCommands.includes("exec"), "the command never started");
    assert.equal(host.sandboxes.size, 0);
    void backend;
  });
});

describe("Windows launcher: planning a job", () => {
  test("the plan runs the supervisor's runner with a job file in the control directory, and the guest is given nothing of the supervisor's", () => {
    const host = new SimHost();
    const { plan, job, jobDir } = prepared(host);
    assert.equal(plan.file, "C:\\Program Files\\nodejs\\node.exe");
    assert.deepEqual(plan.args, [RUNNER, `${jobDir}\\job.json`]);
    assert.ok(jobDir.toLowerCase().startsWith(`${CONTROL.toLowerCase()}\\jobs\\`));
    assert.equal(plan.cwd, CONTROL);
    assert.equal(plan.env["NIMBLENEWT_WSB_JOB"], jobDir);
    assert.equal(job.settings.mode, "owner-session");
    assert.deepEqual(job.command, COMMAND);
    // None of the folders the guest gets reaches the control directory, the runner or the staging of another job.
    for (const s of sharesFor(job.recipe, `${jobDir}\\guest`).filter((x) => x.why !== "job")) {
      assert.ok(!key(s.host).startsWith(key(CONTROL)) && !key(RUNNER).startsWith(key(s.host)), s.host);
    }
    // The directory is the launch's own: the same run id plans to the same directory (the launcher plans twice), another launch of the same recipe and command gets another.
    const backend = windowsSandboxBackend(options(host));
    const a = backend.plan(job.recipe, COMMAND, "11111111-2222-3333-4444-555555555555").env["NIMBLENEWT_WSB_JOB"];
    assert.equal(backend.plan(job.recipe, COMMAND, "11111111-2222-3333-4444-555555555555").env["NIMBLENEWT_WSB_JOB"], a);
    assert.notEqual(backend.plan(job.recipe, COMMAND, "66666666-2222-3333-4444-555555555555").env["NIMBLENEWT_WSB_JOB"], a);
    assert.notEqual(backend.plan(job.recipe, COMMAND).env["NIMBLENEWT_WSB_JOB"], backend.plan(job.recipe, COMMAND).env["NIMBLENEWT_WSB_JOB"]);
    assert.equal(jobDirFor(job.settings, "11111111-2222-3333-4444-555555555555"), a);
    for (const v of Object.values(plan.env)) assert.ok(!/password|secret/i.test(v));
  });

  test("a recipe that would give the guest the supervisor's files, a link, or an unmappable program is refused before any job exists", () => {
    const host = new SimHost();
    const backend = windowsSandboxBackend(options(host));
    assert.throws(() => backend.plan(recipe({ workdir: `${CONTROL}\\jobs` }), COMMAND), /overlaps the supervisor/);
    assert.throws(() => backend.plan(recipe({ scratch: "C:\\Program Files\\NimbleNewt\\worker" }), COMMAND), /./);
    assert.throws(() => backend.plan(recipe({ readOnly: [{ host: "C:\\Program Files\\NimbleNewt\\worker\\dist", guest: "/inputs/x" }] }), COMMAND), /./);
    assert.throws(() => backend.plan(recipe({ workdir: "C:\\Windows\\Temp" }), COMMAND), /inside C:\\Windows|is or contains/);
    host.links.add(key("C:\\Jobs\\a\\home"));
    assert.throws(() => backend.plan(recipe(), COMMAND), /link or junction/);
    host.links.clear();
    assert.throws(() => backend.plan(recipe({ home: "C:\\Jobs\\a\\work\\home" }), COMMAND), /overlap/);
    assert.throws(() => backend.plan(recipe(), ["/etc/passwd"]), /program must be under/);
    assert.throws(() => backend.plan(recipe(), ["/work/x.exe", 'a"b']), /may not contain/);
    assert.equal([...host.files.keys()].filter((f) => f.endsWith("job.json")).length, 0, "no job file was written by a refused plan");
    const linux = new SimHost(); linux.platform = "linux";
    assert.throws(() => windowsSandboxBackend(options(linux)).plan(recipe(), COMMAND), /only on Windows/);
  });

  test("the guest view names the Windows places the agent finds", () => {
    const view = windowsSandboxBackend(options(new SimHost())).guestView(recipe());
    assert.deepEqual(view, { workdir: "C:\\nn\\work", home: "C:\\nn\\home", scratch: "C:\\nn\\scratch", tmp: "C:\\nn\\scratch\\.tmp", inputs: [{ host: "C:\\Tools\\node", guest: "C:\\nn\\inputs\\node" }] });
  });
});

describe("Windows launcher: running a job", () => {
  test("order: lock, admission, ACLs, start, command, stop, ACLs reverted, lock and directory removed; the exit code and output are the command's", async () => {
    const host = new SimHost();
    host.guest = () => ({ code: 7, stdout: "out", stderr: "err", timedOut: false });
    const { job, jobDir } = prepared(host);
    const out = await runWindowsJob(host, job, [win32Dir(RUNNER)], jobDir);
    assert.deepEqual([out.exitCode, out.stdout, out.stderr], [7, "out", "err"]);
    const order = host.runs.map((r) => (r.file.toLowerCase().endsWith("icacls.exe") ? (r.args.length === 1 ? "query" : String(r.args[1])) : String(r.args[0])));
    const first = (name: string): number => order.indexOf(name);
    assert.ok(first("/save") < first("/grant") && first("/grant") < first("start") && first("start") < first("exec") && first("exec") < first("stop") && first("stop") < order.indexOf("/restore"), order.join(","));
    assert.equal(host.sandboxes.size, 0);
    assert.equal(host.exists(jobDir), false);
    assert.equal(host.exists(`${CONTROL}\\sandbox.lock`), false);
    for (const entries of host.acl.values()) assert.deepEqual(entries, ["NT AUTHORITY\\SYSTEM:(OI)(CI)(F)"]);
    const exec = host.runs.find((r) => r.args[0] === "exec")!;
    assert.deepEqual(exec.args.slice(3), ["-c", "C:\\Windows\\System32\\cmd.exe /d /c C:\\nn\\job\\launch.cmd", "-d", "C:\\nn\\work", "-r", "System"]);
  });

  test("every folder's access list is put back exactly, whatever the account already had: explicit, inherited, deny, or a longer name ending the same way", async () => {
    const host = new SimHost();
    const before: Record<string, string[]> = {
      "C:\\Tools\\node": ["NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "PC\\robert:(OI)(CI)(RX)"],
      "C:\\Jobs\\a\\work": ["NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "PC\\robert:(I)(OI)(CI)(M)"],
      "C:\\Jobs\\a\\home": ["NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "PC\\robert:(DENY)(OI)(CI)(WD)"],
      "C:\\Jobs\\a\\scratch": ["NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "PC\\jimrobert:(OI)(CI)(M)", "OTHER\\robert:(OI)(CI)(M)"],
    };
    for (const [p, e] of Object.entries(before)) host.acl.set(key(p), [...e]);
    const { job, jobDir } = prepared(host);
    await runWindowsJob(host, job, [], jobDir);
    const touched = new Set(host.icaclsMutations.filter((a) => a[1] !== "/save" && a[1] !== "/restore").map((a) => a[0]!));
    assert.deepEqual([...touched].sort(), ["C:\\Jobs\\a\\home", "C:\\Jobs\\a\\scratch", "C:\\Jobs\\a\\work", "C:\\Jobs\\a\\work\\.git", "C:\\Tools\\node", `${jobDir}\\guest`].sort());
    for (const [p, e] of Object.entries(before)) assert.deepEqual(host.acl.get(key(p)), e, p);
    assert.ok(!host.runs.some((r) => r.args.some((a) => /^\/remove/.test(a))), "no entry is ever removed by name");
    assert.equal(host.exists(jobDir), false);
  });

  test("a failed ACL change refuses the job, starts no sandbox and undoes what was done", async () => {
    const host = new SimHost(); host.aclFailure = true;
    const { job, jobDir } = prepared(host);
    const out = await runWindowsJob(host, job, [], jobDir);
    assert.equal(out.exitCode, EXIT_REFUSED);
    assert.match(out.stderr, /access list.*could not be changed/);
    assert.deepEqual(host.wsbCommands, []);
  });

  test("an access list that cannot be saved is not changed", async () => {
    const host = new SimHost(); host.saveFailure = true;
    const { job, jobDir } = prepared(host);
    const out = await runWindowsJob(host, job, [], jobDir);
    assert.equal(out.exitCode, EXIT_REFUSED);
    assert.match(out.stderr, /could not be saved.*not changed/);
    assert.equal(host.icaclsMutations.filter((a) => a[1] === "/grant" || a[1] === "/deny").length, 0);
    assert.deepEqual(host.wsbCommands, []);
  });

  test("refused at the moment of the start when the session or client is gone, even if health was good a minute ago", async () => {
    const host = new SimHost();
    const { job, jobDir } = prepared(host);
    host.sess = {};
    const a = await runWindowsJob(host, job, [], jobDir);
    assert.equal(a.exitCode, EXIT_REFUSED); assert.match(a.stderr, /nobody is signed in/);
    host.sess = { consoleUser: "PC\\robert" }; host.pkg = undefined;
    const b = await runWindowsJob(host, job, [], jobDir);
    assert.equal(b.exitCode, EXIT_REFUSED); assert.match(b.stderr, /not installed/);
    assert.deepEqual(host.wsbCommands, []);
    assert.equal(host.exists(`${CONTROL}\\sandbox.lock`), false, "the lock is released after a refusal");
  });

  test("a shared folder that reaches the supervisor is refused at the start too", async () => {
    const host = new SimHost();
    const { job, jobDir } = prepared(host);
    const out = await runWindowsJob(host, { ...job, recipe: { ...job.recipe, workdir: "C:\\Program Files\\NimbleNewt\\worker\\dist\\sandbox\\w" } }, [win32Dir(RUNNER)], jobDir);
    assert.equal(out.exitCode, EXIT_REFUSED);
    assert.match(out.stderr, /overlaps the supervisor/);
    assert.deepEqual(host.wsbCommands, []);
  });

  test("only one sandbox at a time: a second launch of the identical recipe and command is refused as busy, and its release leaves the first untouched", async () => {
    const host = new SimHost();
    const first = prepared(host);
    const second = prepared(host);
    assert.notEqual(first.jobDir, second.jobDir);
    host.alive.add(9999);
    // The first job is running: its lock, sandbox, status and saved access lists exist.
    host.writeText(`${CONTROL}\\sandbox.lock`, JSON.stringify({ pid: 9999, jobDir: first.jobDir }));
    host.writeText(`${first.jobDir}\\status.json`, JSON.stringify({ id: "00000000-0000-4000-8000-000000000099" }));
    host.sandboxes.add("00000000-0000-4000-8000-000000000099");
    host.writeText(`${first.jobDir}\\acl.json`, "[]");
    const out = await runWindowsJob(host, second.job, [], second.jobDir);
    assert.equal(out.exitCode, EXIT_BUSY);
    await first.backend.release!(second.plan);
    assert.deepEqual(host.wsbCommands, [], "nothing was started or stopped");
    assert.ok(host.sandboxes.has("00000000-0000-4000-8000-000000000099"));
    for (const f of ["sandbox.lock", `jobs\\${first.jobDir.split("\\").pop()}\\status.json`, `jobs\\${first.jobDir.split("\\").pop()}\\acl.json`]) assert.ok(host.exists(`${CONTROL}\\${f}`), f);
    assert.equal(host.exists(second.jobDir), false, "the refused launch removed only its own directory");
    host.alive.clear(); // the holder died: its lock is stale and is taken over
    const third = prepared(host);
    host.sandboxes.clear();
    assert.equal((await runWindowsJob(host, third.job, [], third.jobDir)).exitCode, 0);
  });

  test("a stale lock is moved aside before it is judged: a lock that changed meanwhile is given back and the job is busy", async () => {
    const host = new SimHost();
    const { job, jobDir } = prepared(host);
    host.writeText(`${CONTROL}\\sandbox.lock`, JSON.stringify({ pid: 777, jobDir: "x" }));
    const realRename = host.rename.bind(host);
    host.rename = (a, b) => { host.files.set(key(a), JSON.stringify({ pid: 888, jobDir: "y" })); realRename(a, b); };
    const out = await runWindowsJob(host, job, [], jobDir);
    assert.equal(out.exitCode, EXIT_BUSY);
    assert.equal(host.readText(`${CONTROL}\\sandbox.lock`), JSON.stringify({ pid: 888, jobDir: "y" }));
  });

  test("when a revert fails nothing is forgotten: the saved lists, the job directory and the lock stay, the failure is reported, and health refuses until it is fixed", async () => {
    const host = new SimHost();
    const { backend, plan, job, jobDir } = prepared(host);
    host.restoreFailure = true;
    const out = await runWindowsJob(host, job, [], jobDir);
    assert.notEqual(out.exitCode, 0);
    assert.match(out.stderr, /release failed:.*could not be restored/);
    assert.ok(host.exists(`${jobDir}\\acl.json`) && host.exists(`${jobDir}\\acl-0.txt`) && host.exists(`${CONTROL}\\sandbox.lock`));
    await assert.rejects(backend.release!(plan), /cleanup incomplete/);
    host.guest = probeGuest(host);
    const h = await backend.health();
    assert.equal(h.healthy, false);
    assert.match(h.reason!, /left changes behind/);
    host.restoreFailure = false; // fixed: the next health check restores, then proves itself
    const again = await backend.health();
    assert.equal(again.healthy, true, again.reason);
    assert.deepEqual(host.listDir(`${CONTROL}\\jobs`), []);
    assert.equal(host.exists(`${CONTROL}\\sandbox.lock`), false);
  });

  test("a corrupt change record is kept, not deleted with the directory", async () => {
    const host = new SimHost();
    const { backend, plan, jobDir } = prepared(host);
    host.writeText(`${jobDir}\\acl.json`, "{not json");
    await assert.rejects(backend.release!(plan), /cannot be read/);
    assert.ok(host.exists(`${jobDir}\\acl.json`));
  });

  test("a sandbox that cannot be stopped keeps its record; one already gone is not a problem", async () => {
    const host = new SimHost();
    const { backend, plan, jobDir } = prepared(host);
    host.writeText(`${jobDir}\\status.json`, JSON.stringify({ id: "00000000-0000-4000-8000-000000000042" }));
    host.sandboxes.add("00000000-0000-4000-8000-000000000042");
    host.stopFailure = true;
    await assert.rejects(backend.release!(plan), /could not be stopped/);
    assert.ok(host.exists(`${jobDir}\\status.json`));
    host.sandboxes.clear(); // gone by itself: the failing stop is then harmless
    await backend.release!(plan);
    assert.equal(host.exists(jobDir), false);
  });

  test("health refuses while a sandbox this program did not start is running, and two health checks at once do not disturb each other", async () => {
    const host = new SimHost(); host.guest = probeGuest(host);
    host.sandboxes.add("00000000-0000-4000-8000-0000000000aa");
    const backend = windowsSandboxBackend(options(host));
    assert.match((await backend.health()).reason!, /already running/);
    host.sandboxes.clear();
    const [x, y] = await Promise.all([backend.health(), backend.health()]);
    assert.equal(x.healthy, true, x.reason);
    assert.equal(y.healthy, true, y.reason);
    assert.equal(host.wsbCommands.filter((c) => c === "start").length, 2);
  });

  test("failures: start error (with the no-session identity error explained), command that does not return, exceptions", async () => {
    const a = new SimHost(); a.startFailure = { code: 1, stdout: "", stderr: "HRESULT 0x8000401A", timedOut: false };
    const pa = prepared(a);
    const oa = await runWindowsJob(a, pa.job, [], pa.jobDir);
    assert.match(oa.stderr, /no user session is available \(0x8000401A/);
    const b = new SimHost(); b.guest = () => ({ code: null, stdout: "partial", stderr: "", timedOut: true });
    const pb = prepared(b);
    const ob = await runWindowsJob(b, pb.job, [], pb.jobDir);
    assert.match(ob.stderr, /did not return/);
    assert.equal(b.sandboxes.size, 0);
    const c = new SimHost(); c.guest = () => { throw new Error("boom"); };
    const pc = prepared(c);
    assert.match((await runWindowsJob(c, pc.job, [], pc.jobDir)).stderr, /failed: boom/);
    assert.equal(c.sandboxes.size, 0, "the sandbox is stopped when the run throws");
  });

  test("after a hard kill of the runner, release stops the sandbox it started, restores the ACLs and removes the job", async () => {
    const host = new SimHost();
    const orig = ["NT AUTHORITY\\SYSTEM:(OI)(CI)(F)"];
    const { backend, plan, jobDir } = prepared(host);
    // Simulate a runner killed in the middle of the command: the list was saved and changed, the sandbox started.
    host.writeText(`${CONTROL}\\sandbox.lock`, JSON.stringify({ pid: 31337, jobDir }));
    host.writeText(`${jobDir}\\status.json`, JSON.stringify({ id: "00000000-0000-4000-8000-000000000099" }));
    host.sandboxes.add("00000000-0000-4000-8000-000000000099");
    host.writeText(`${jobDir}\\acl-0.txt`, "saved");
    host.saved.set(key(`${jobDir}\\acl-0.txt`), orig); host.savedFor.set(key(`${jobDir}\\acl-0.txt`), "C:\\Jobs\\a\\work");
    host.writeText(`${jobDir}\\acl.json`, JSON.stringify([{ path: "C:\\Jobs\\a\\work", parent: "C:\\Jobs\\a", file: `${jobDir}\\acl-0.txt` }]));
    host.acl.set(key("C:\\Jobs\\a\\work"), [...orig, "PC\\robert:(OI)(CI)M"]);
    await backend.release!(plan);
    assert.equal(host.sandboxes.size, 0);
    assert.deepEqual(host.acl.get(key("C:\\Jobs\\a\\work")), orig);
    assert.equal(host.exists(jobDir), false);
    assert.equal(host.exists(`${CONTROL}\\sandbox.lock`), false);
    await backend.release!(plan); // twice is fine
    host.writeText("C:\\Jobs\\a\\keep.txt", "x");
    await backend.release!({ ...plan, env: { NIMBLENEWT_WSB_JOB: "C:\\Jobs\\a" } });
    assert.ok(host.exists("C:\\Jobs\\a\\keep.txt"), "a directory outside the jobs directory is never touched");
  });
});

describe("the launcher with a backend that reports details", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-wsb-")));
  after(() => rmSync(root, { recursive: true, force: true }));
  const dir = (name: string): string => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };

  const planned: (string | undefined)[] = [];
  let failRelease = false;
  function stub(health: BackendHealth, released: SpawnPlan[], script = "process.exit(0)"): SandboxBackend {
    return {
      name: "windows-sandbox",
      health: async () => health,
      plan: (_r, _c, runId) => { planned.push(runId); return { file: process.execPath, args: ["-e", script], env: { NIMBLENEWT_WSB_JOB: "job-1" } }; },
      guestView: (r) => ({ workdir: "C:\\nn\\work", home: "C:\\nn\\home", scratch: "C:\\nn\\scratch", tmp: "C:\\nn\\scratch\\.tmp", inputs: r.readOnly.map((m) => ({ host: m.host, guest: m.guest })) }),
      auditDetails: () => ({ windowsMode: "owner-session", sessionDependent: "true" }),
      release: async (plan) => { released.push(plan); if (failRelease) throw new Error("sandbox left behind"); },
    };
  }
  const request = (extra = "") => ({ recipe: { mode: "sandboxed" as const, workdir: dir(`w${extra}`), home: dir(`h${extra}`), scratch: dir(`s${extra}`), readOnly: [], network: "none" as const, env: {}, protectedSubpaths: [] }, command: ["/work/x.exe"], timeoutMs: 20_000, maxOutputBytes: 10_000 });

  test("the launch record carries the backend's mode details, the capacity carries its notes, and release runs after the run", async () => {
    const records: LaunchRecord[] = []; const released: SpawnPlan[] = [];
    const launcher = await SandboxLauncher.create({ backend: stub({ healthy: true, backend: "windows-sandbox", version: "0.8.107.0", notes: ["session-dependent: x"] }, released), protectedPaths: [], audit: (r) => { records.push(r); } });
    assert.equal(launcher.capacity.available, true);
    assert.deepEqual(launcher.capacity.notes, ["session-dependent: x"]);
    const run = await launcher.launch(request("1"));
    await run.result;
    assert.deepEqual(records[0]!.backendDetails, { windowsMode: "owner-session", sessionDependent: "true" });
    assert.equal(records[0]!.backend, "windows-sandbox");
    assert.equal(records[0]!.mode, "sandboxed");
    assert.equal(released.length, 1);
    assert.equal(released[0]!.env["NIMBLENEWT_WSB_JOB"], "job-1");
  });

  test("both plans of one launch get the launch's run id, and a release that fails is reported in the result", async () => {
    const released: SpawnPlan[] = [];
    const launcher = await SandboxLauncher.create({ backend: stub({ healthy: true, backend: "windows-sandbox" }, released), protectedPaths: [], audit: () => undefined });
    planned.length = 0;
    const a = await launcher.launch(request("4"));
    const b = await launcher.launch(request("5"));
    assert.equal(planned.length, 4);
    assert.equal(planned[0], a.runId); assert.equal(planned[1], a.runId);
    assert.equal(planned[2], b.runId); assert.equal(planned[3], b.runId);
    assert.notEqual(a.runId, b.runId);
    await Promise.all([a.result, b.result]);
    failRelease = true;
    const c = await launcher.launch(request("6"));
    assert.equal((await c.result).releaseProblem, "sandbox left behind");
    failRelease = false;
  });

  test("the supervisor root loses a trailing separator of either kind", () => {
    assert.equal(stripTrailingSeparator("C:\\repo\\packages\\worker\\"), "C:\\repo\\packages\\worker");
    assert.equal(stripTrailingSeparator("/repo/packages/worker/"), "/repo/packages/worker");
    assert.equal(stripTrailingSeparator("/repo/packages/worker"), "/repo/packages/worker");
  });

  test("a killed run is released too, and an unhealthy backend gives no capacity, no launch and its notes", async () => {
    const released: SpawnPlan[] = [];
    const launcher = await SandboxLauncher.create({ backend: stub({ healthy: true, backend: "windows-sandbox" }, released, "setInterval(() => {}, 1000)"), protectedPaths: [], audit: () => undefined });
    const run = await launcher.launch(request("2"));
    run.kill();
    const result = await run.result;
    assert.equal(result.killed, true);
    assert.equal(released.length, 1);
    const down = await SandboxLauncher.create({ backend: stub({ healthy: false, backend: "windows-sandbox", reason: "nobody is signed in", notes: ["session-dependent: y"] }, released), protectedPaths: [], audit: () => undefined });
    assert.equal(down.capacity.available, false);
    assert.deepEqual(down.capacity.notes, ["session-dependent: y"]);
    await assert.rejects(down.launch(request("3")), /no confined launch is possible: nobody is signed in/);
    assert.equal(released.length, 1);
  });
});

const win32Dir = (p: string): string => p.slice(0, p.lastIndexOf("\\"));

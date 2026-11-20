import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { BackendHealth, SandboxBackend, SpawnPlan } from "./backend.js";
import { SandboxLauncher, stripTrailingSeparator, type LaunchRecord } from "./launcher.js";
import type { NormalizedRecipe } from "./recipe.js";
import { AUTOLOGON_ACKNOWLEDGEMENT, VM_FALLBACK_DECISION, windowsSandboxBackend, type WindowsSandboxOptions } from "./windows.js";
import type { ProcessResult, WindowsAutologon, WindowsHost, WindowsLockTask, WindowsPackageInfo, WindowsSession, WindowsSignature } from "./windows-host.js";
import { EXIT_BUSY, EXIT_REFUSED, jobDirFor, runWindowsJob, type WindowsJob } from "./windows-job.js";
import { evidenceControlDirs, releaseLeftovers, sandboxRunning } from "./windows-cleanup.js";
import { accessFromProbe, ownerFromProbe, packageFromProbe, sessionFromProbe, signatureFromProbe } from "./windows-real.js";
import { ACCEPTED_SIGNATURE_KINDS, INTERACTIVE_RUNNER_HINT, MICROSOFT_STORE_PUBLISHER_ID, describeWsbAccessDenied, SANDBOX_PACKAGES, entryTokens, entryWrites, icaclsWriterEntries, rightsTokens, WINDOWS_PUBLISHER_ID, aclSteps, checkIdentity, describeSignature, packageFamilyName, shortStatusMessage, verifyClient, checkWindowsHostPath, compareVersions, guestPathFor, isWsbAccessDenied, launchScript, parseIcaclsWritable, quoteArg, sharesFor, wsbConfigXml, type WindowsSettings } from "./windows-plan.js";

// These tests run on every OS with a simulated Windows host: they prove the rules (what is refused, what is recorded, in what order things happen) but NOT that
// Windows Sandbox itself confines anything. That is windows-real.test.ts, which runs only on a Windows machine with NIMBLENEWT_REAL_WINDOWS_SANDBOX=1.

const INSTALL = `C:\\Program Files\\WindowsApps\\MicrosoftWindows.WindowsSandbox_0.8.107.0_x64__${WINDOWS_PUBLISHER_ID}`;
const CONTROL = "C:\\ProgramData\\NimbleNewt\\control";
const STAGING = "C:\\ProgramData\\NimbleNewt\\staging";
const RUNNER = "C:\\Program Files\\NimbleNewt\\worker\\dist\\sandbox\\windows-runner.js";
const MS = "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";
const key = (p: string): string => p.toLowerCase();
/** The runner started interactively by the console user: it runs in the active console session, as that user. */
const ME = { processInConsoleSession: true, processIsConsoleUser: true } as const;

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
  /** As found on the owner's Windows 11 machine (build 10.0.26200): the Windows-provided package. */
  pkg: WindowsPackageInfo | undefined = { name: "MicrosoftWindows.WindowsSandbox", publisherId: WINDOWS_PUBLISHER_ID, familyName: `MicrosoftWindows.WindowsSandbox_${WINDOWS_PUBLISHER_ID}`, version: "0.8.107.0", installLocation: INSTALL, signatureKind: "System", status: "Ok" };
  sigs = new Map<string, WindowsSignature>();
  sess: WindowsSession = { ...ME, consoleUser: "PC\\robert", locked: false };
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
  /** Answers for the next `wsb list` calls, in order; once used up, the real list. */
  listScript: ProcessResult[] = [];
  listLimits: number[] = [];
  servers: { pid: number; started?: string }[] = [];
  envNames(): string[] { return Object.keys(this.envMap); }
  async serverProcesses(): Promise<readonly { pid: number; started?: string }[]> { return this.servers; }

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
  async signature(path: string): Promise<WindowsSignature> { return this.sigs.get(key(path)) ?? { valid: true, subject: MS, status: "Valid", signatureType: "Authenticode" }; }
  async session(): Promise<WindowsSession> { return this.sess; }
  async autologon(): Promise<WindowsAutologon> { return this.auto; }
  async lockTask(): Promise<WindowsLockTask> { return this.task; }
  async writableBy(path: string): Promise<readonly string[]> { return this.writable.get(key(path)) ?? []; }
  /** Each path's owner by SID; SYSTEM unless set. */
  owners = new Map<string, string>();
  async ownerSid(path: string): Promise<string> { return this.owners.get(key(path)) ?? "S-1-5-18"; }
  async run(file: string, args: readonly string[], options: { cwd?: string; timeoutMs?: number }): Promise<ProcessResult> {
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
    if (args[0] === "list") this.listLimits.push(options.timeoutMs ?? 0);
    if (args[0] === "list" && this.listScript.length > 0) return this.listScript.shift()!;
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
const settings = (extra: Partial<WindowsSettings> = {}): WindowsSettings => ({ controlDir: CONTROL, shareIdentity: "PC\\robert", owner: "PC\\robert", minVersion: "0.8.107.0", mode: "owner-session", lockTask: "NimbleNewt-LockOnLogon", ...extra });
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
 
    // Only SYSTEM, Administrators and TrustedInstaller (and CREATOR OWNER, which shapes later files only) are trusted; LOCAL SERVICE is not. Delete (D) counts as a change.
    // A name in another language is not trusted (a refusal where an empty list is required); a summary line in another language is not an entry; a line that looks like an
    // entry but is not in the expected form is reported, never skipped.
    const more = [
      "C:\\x NT AUTHORITY\\LOCAL SERVICE:(M)", "      CREATOR OWNER:(OI)(CI)(IO)(F)", "      PC\\erin:(D)", "      NT-AUTORITÄT\\SYSTEM:(OI)(CI)(F)", "      BUILTIN\\Users:(OI)(CI)(RX)",
      "      BUILTIN\\Guests:(OI)(CI)(F) (Exists WIN://SYSAPPID)", "      BUILTIN\\Administrators:(OI)(CI)(F)", "", "1 Dateien erfolgreich verarbeitet; bei 0 Dateien ist ein Verarbeitungsfehler aufgetreten.",
    ].join("\r\n");
    assert.deepEqual(parseIcaclsWritable(more, "C:\\x").sort(), ["NT AUTHORITY\\LOCAL SERVICE", "NT-AUTORITÄT\\SYSTEM", "PC\\erin", 'unrecognised entry "BUILTIN\\\\Guests:(OI)(CI)(F) (Exists WIN://SYSAPPID)"']);
    const clean = ["C:\\x NT SERVICE\\TrustedInstaller:(F)", "      NT AUTHORITY\\SYSTEM:(OI)(CI)(RX)", "      BUILTIN\\Administrators:(OI)(CI)(RX)", "      BUILTIN\\Users:(OI)(CI)(RX)", "      APPLICATION PACKAGE AUTHORITY\\ALL APPLICATION PACKAGES:(OI)(CI)(RX)", "Successfully processed 1 files; Failed processing 0 files"].join("\r\n");
    assert.deepEqual(parseIcaclsWritable(clean, "C:\\x"), []);

    // Fails closed on output it cannot read: no entry at all (empty output, only the path, only a summary), or any other text among the entries (before the blank line that
    // separates them from the summary) is reported, never read as "nobody else can write". Text after that blank line that is not entry-like is the summary and is ignored.
    for (const empty of ["", "\r\n", "C:\\x\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files", "Successfully processed 1 files; Failed processing 0 files"]) {
      assert.deepEqual(parseIcaclsWritable(empty, "C:\\x"), ["no access entry could be read"], JSON.stringify(empty));
    }
    assert.deepEqual(parseIcaclsWritable("C:\\x NULL DACL\r\n\r\nSuccessfully processed 1 files", "C:\\x").sort(), ["no access entry could be read", 'unrecognised entry "NULL DACL"']);
    const odd = ["C:\\x NT AUTHORITY\\SYSTEM:(F)", "      something icacls did not print before", "      BUILTIN\\Administrators:(F)", "", "Successfully processed 1 files"].join("\r\n");
    assert.deepEqual(parseIcaclsWritable(odd, "C:\\x"), ['unrecognised entry "something icacls did not print before"']);
    const afterSummary = ["C:\\x NT AUTHORITY\\SYSTEM:(F)", "", "Successfully processed 1 files", "PC\\erin:(F)"].join("\r\n");
    assert.deepEqual(parseIcaclsWritable(afterSummary, "C:\\x"), ["PC\\erin"], "an entry after the summary still counts");
  });

  test("inherit-only entries: one passed on to nothing is not a writer; one passed on to files or folders inside still is (a folder's list stands for what it holds)", () => {
    const head = "C:\\x NT AUTHORITY\\SYSTEM:(OI)(CI)(F)";
    const one = (entry: string): string[] => parseIcaclsWritable([head, `      ${entry}`, "", "Successfully processed 1 files"].join("\r\n"), "C:\\x");
    // INHERIT_ONLY_ACE gives nothing on the object itself; with neither (OI) nor (CI) it is passed on to nothing either.
    assert.deepEqual(one("PC\\erin:(IO)(M)"), []);
    assert.deepEqual(one("PC\\erin:(IO)(NP)(F)"), []);
    assert.deepEqual(one("S-1-15-3-1024-1:(IO)(W)"), []);
    // Passed on to files ((OI)) or folders ((CI)) inside: still reported, on a folder those become writable.
    for (const entry of ["PC\\erin:(OI)(IO)(M)", "PC\\erin:(CI)(IO)(W)", "PC\\erin:(OI)(CI)(IO)(F)", "PC\\erin:(OI)(CI)(NP)(IO)(WD)", "PC\\erin:(I)(OI)(CI)(IO)(GA)"]) assert.deepEqual(one(entry), ["PC\\erin"], entry);
    // Without (IO) nothing changes: an inherited or explicit write right is a writer.
    for (const entry of ["PC\\erin:(M)", "PC\\erin:(I)(F)", "PC\\erin:(NP)(W)"]) assert.deepEqual(one(entry), ["PC\\erin"], entry);
    // The rights stay with each writer for the findings; unreadable output is reported the same way.
    assert.deepEqual(icaclsWriterEntries([head, "      S-1-15-3-1024-1:(I)(OI)(CI)(RX,W)", "      CREATOR OWNER:(OI)(CI)(IO)(F)", "      PC\\erin:(IO)(M)", "", "Successfully processed 1 files"].join("\r\n"), "C:\\x"),
      [{ account: "S-1-15-3-1024-1", rights: "(I)(OI)(CI)(RX,W)" }]);
    assert.deepEqual(icaclsWriterEntries("", "C:\\x"), [{ problem: "no access entry could be read" }]);
  });

  test("a process trust label (S-1-19-<type>-<level>, kept in the SACL, only ever restricts) is not a writer; nothing else that looks like one is skipped", () => {
    // The shape icacls printed for the Store package of Windows Sandbox on a real machine (own-hardware run 44479324035): the folder, wsb.exe and WindowsSandboxServer.exe each
    // carried a trust label entry alongside their ordinary access entries.
    const real = (label: string): string => [
      "C:\\x NT SERVICE\\TrustedInstaller:(F)", "      NT AUTHORITY\\SYSTEM:(I)(F)", "      BUILTIN\\Administrators:(I)(RX)", "      BUILTIN\\Users:(I)(RX)",
      "      APPLICATION PACKAGE AUTHORITY\\ALL APPLICATION PACKAGES:(I)(RX)", `      ${label}`, "", "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");
    assert.deepEqual(parseIcaclsWritable(real("S-1-19-512-8192:(I)(RX,D,WDAC,WO,WA)"), "C:\\x"), []);
    assert.deepEqual(parseIcaclsWritable(real("S-1-19-512-8192:(OI)(CI)(RX,D,WDAC,WO,WA)"), "C:\\x"), []);
    assert.deepEqual(parseIcaclsWritable(real("S-1-19-1024-8192:(I)(F)"), "C:\\x"), []);
    assert.deepEqual(icaclsWriterEntries(real("S-1-19-512-8192:(I)(RX,D,WDAC,WO,WA)"), "C:\\x"), []);
    // A real extra writer next to the label is still reported.
    const both = real("S-1-19-512-8192:(I)(RX,D,WDAC,WO,WA)").replace("      BUILTIN\\Users:(I)(RX)", "      BUILTIN\\Users:(I)(RX)\r\n      S-1-5-21-1-2-3-1001:(I)(M)");
    assert.deepEqual(parseIcaclsWritable(both, "C:\\x"), ["S-1-5-21-1-2-3-1001"]);
    // Lookalikes are read like any other account: too few parts, too many, a different authority, letters, lower case, or text around the SID.
    for (const sid of ["S-1-19-1", "S-1-19-5-6-7", "S-1-190-1-2", "S-1-19-512-8192x", "S-1-19-x-8192", "S-1-19--8192", "s-1-19-512-8192", "S-1-19-512-8192 ", "PC\\S-1-19-512-8192", "S-1-19-512-"]) {
      assert.deepEqual(parseIcaclsWritable(real(`${sid}:(I)(RX,D,WDAC,WO,WA)`), "C:\\x"), [sid], sid);
    }
    // A label alone is not an access entry: a list with nothing else still cannot be read as "nobody else can write".
    assert.deepEqual(parseIcaclsWritable("C:\\x S-1-19-512-8192:(I)(RX,D,WDAC,WO,WA)\r\n\r\nSuccessfully processed 1 files", "C:\\x"), ["no access entry could be read"]);
  });

  test("access lists by SID: rights written as icacls writes them, and who can change the object read the same way as the icacls reader", () => {
    assert.deepEqual(rightsTokens(0x1f01ff), ["F"]);
    assert.deepEqual(rightsTokens(0x1301bf), ["M"]);
    assert.deepEqual(rightsTokens(0x1200a9), ["RX"]);
    assert.deepEqual(rightsTokens(0x120089), ["R"]);
    assert.deepEqual(rightsTokens(0x100116), ["W"]);
    assert.deepEqual(rightsTokens(0x10000000), ["GA"]);
    assert.deepEqual(rightsTokens(0x80000000), ["GR"]);
    assert.deepEqual(rightsTokens(-0x80000000), ["GR"], "PowerShell's signed form of the same mask");
    assert.deepEqual(rightsTokens(0x1200a9 | 0x2), ["RD", "WD", "REA", "X", "RA", "RC", "S"]);
    assert.deepEqual(rightsTokens(0x10000), ["DE"]);
    assert.deepEqual(rightsTokens(0x200), ["0x200"]);
    assert.deepEqual(rightsTokens(0), ["none"]);
    const base = { sid: "S-1-15-3-1024-1", allow: true, rights: 0x1200a9, inherited: false, objectInherit: false, containerInherit: false, noPropagate: false, inheritOnly: false };
    assert.equal(entryTokens({ ...base, inherited: true, objectInherit: true, containerInherit: true, rights: 0x1301bf }), "(I)(OI)(CI)(M)");
    assert.equal(entryTokens({ ...base, allow: false, rights: 0x100116 }), "(DENY)(W)");
    assert.equal(entryTokens({ ...base, objectInherit: true, containerInherit: true, noPropagate: true, inheritOnly: true, rights: 0x10000000 }), "(OI)(CI)(NP)(IO)(GA)");
    // Readers stay readers; each write, delete, permission or ownership right is a change; a bit with no name counts as one (unknown is never read as harmless).
    assert.equal(entryWrites(base), false);
    for (const rights of [0x2, 0x4, 0x40, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000, 0x1f01ff, 0x1301bf, 0x100116, 0x200, 0x4000000]) assert.equal(entryWrites({ ...base, rights }), true, rights.toString(16));
    for (const rights of [0x1, 0x8, 0x10, 0x20, 0x80, 0x100, 0x20000, 0x100000, 0x80000000, 0x20000000]) assert.equal(entryWrites({ ...base, rights }), false, rights.toString(16));
    // Deny entries, the trusted accounts by SID, and an inherit-only entry passed on to nothing are not writers; inherit-only passed on to files or folders still is.
    assert.equal(entryWrites({ ...base, allow: false, rights: 0x1f01ff }), false);
    for (const sid of ["S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", "S-1-3-0"]) assert.equal(entryWrites({ ...base, sid, rights: 0x1f01ff }), false, sid);
    for (const sid of ["S-1-5-19", "S-1-5-32-545", "S-1-5-80-1-2", "S-1-5-18-1", "S-1-5-21-1-2-3-1001", "S-1-15-2-1"]) assert.equal(entryWrites({ ...base, sid, rights: 0x1301bf }), true, sid);
    assert.equal(entryWrites({ ...base, rights: 0x1f01ff, inheritOnly: true }), false);
    assert.equal(entryWrites({ ...base, rights: 0x1f01ff, inheritOnly: true, noPropagate: true }), false);
    assert.equal(entryWrites({ ...base, rights: 0x1f01ff, inheritOnly: true, objectInherit: true }), true);
    assert.equal(entryWrites({ ...base, rights: 0x1f01ff, inheritOnly: true, containerInherit: true }), true);
  });

  test("the access-list probe's answer is read strictly: an exact count, a SID, a 32-bit mask, Allow or Deny and known flags, or an error", () => {
    const path = "C:\\x";
    const e = { sid: "S-1-15-3-1024-1", rights: 1179817, type: "Allow", inherited: true, inheritance: 3, propagation: 0 };
    assert.deepEqual(accessFromProbe({ count: 1, entries: [e] }, path), [{ sid: "S-1-15-3-1024-1", allow: true, rights: 0x1200a9, inherited: true, objectInherit: true, containerInherit: true, noPropagate: false, inheritOnly: false }]);
    // A list of one written as a single object, an empty list in its forms, a negative (signed) mask, a deny, inherit-only and no-propagate flags.
    assert.equal(accessFromProbe({ count: 1, entries: e }, path).length, 1);
    for (const empty of [{ count: 0, entries: [] }, { count: 0, entries: null }, { count: 0 }]) assert.deepEqual(accessFromProbe(empty, path), [], JSON.stringify(empty));
    const two = accessFromProbe({ count: 2, entries: [{ ...e, rights: -2147483648, type: "Deny", inheritance: 2, propagation: 2 }, { ...e, sid: "S-1-5-18", inheritance: 1, propagation: 1, inherited: false }] }, path);
    assert.deepEqual(two[0], { sid: "S-1-15-3-1024-1", allow: false, rights: 0x80000000, inherited: true, objectInherit: true, containerInherit: false, noPropagate: false, inheritOnly: true });
    assert.deepEqual(two[1], { sid: "S-1-5-18", allow: true, rights: 0x1200a9, inherited: false, objectInherit: false, containerInherit: true, noPropagate: true, inheritOnly: false });
    const bad: unknown[] = [null, [], "x", 5, {}, { count: "1", entries: [e] }, { count: 1.5, entries: [e] }, { count: -1, entries: [] }, { count: 2, entries: [e] }, { count: 1, entries: [e, e] }, { count: 0, entries: [e] }, { count: 2, entries: e },
      { count: 1, entries: [null] }, { count: 1, entries: [[e]] }, { count: 1, entries: "S-1-5-18" },
      ...[{ sid: "NT AUTHORITY\\SYSTEM" }, { sid: "S-1-5-18 " }, { sid: "" }, { sid: undefined }, { rights: "1179817" }, { rights: 1.5 }, { rights: 2 ** 32 }, { rights: -(2 ** 31) - 1 }, { rights: undefined },
        { type: "allow" }, { type: "AllowCallback" }, { type: 0 }, { type: undefined }, { inherited: "true" }, { inherited: 1 }, { inheritance: 4 }, { inheritance: -1 }, { inheritance: "3" }, { propagation: 1.5 }, { propagation: undefined }]
        .map((change) => ({ count: 1, entries: [{ ...e, ...change }] }))];
    for (const raw of bad) assert.throws(() => accessFromProbe(raw, path), /the access list of C:\\x was not reported in the expected form/, JSON.stringify(raw));
  });
});

describe("Windows launcher: configuration (nothing is on by default)", () => {
  test("H12i: the Windows backend does not claim a private network, so a recipe with a route is refused there until its own proof (card H12r)", () => {
    assert.notEqual(windowsSandboxBackend(options(new SimHost())).privateNetwork, true);
  });
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

  describe("wsb list: diagnostics and a bounded retry", () => {
    const fast = { timeoutsMs: [50, 50, 50], pauseMs: 0 };
    const hung: ProcessResult = { code: null, stdout: "", stderr: "", timedOut: true };

    test("a slow first call (a cold server start) is retried and then succeeds; the calls are recorded", async () => {
      const host = new SimHost();
      host.servers = [{ pid: 777, started: "2026-11-19T10:00:00.000Z" }];
      host.listScript = [hung];
      const backend = windowsSandboxBackend(options(host, { listOptions: fast }));
      host.guest = probeGuest(host);
      const h = await backend.health();
      assert.equal(h.healthy, true, h.reason);
      assert.deepEqual(host.wsbCommands, ["list", "list", "start", "exec", "stop"]);
      const d = backend.auditDetails!()["wsbListDiagnostics"]!;
      assert.match(d, /call 1: timed out after \d+ ms \(limit 50 ms\); call 2: ok after \d+ ms/);
      assert.match(d, /server before: pid 777 started 2026-11-19T10:00:00.000Z; server after: pid 777 started/);
    });

    test("the first call has a longer limit than the retries, and there are at most two retries", async () => {
      const host = new SimHost();
      host.listScript = [hung, hung, hung, hung];
      host.guest = probeGuest(host);
      await windowsSandboxBackend(options(host, { listOptions: { pauseMs: 0 } })).health();
      assert.deepEqual(host.listLimits, [120_000, 60_000, 60_000]);
    });

    test("every call failing is no capacity: nothing is started, and the reason carries the diagnostics", async () => {
      const host = new SimHost();
      host.listScript = [hung, { code: 2148734208, stdout: "", stderr: "Cancelled", timedOut: false }, hung, hung];
      host.guest = probeGuest(host);
      const h = await windowsSandboxBackend(options(host, { listOptions: fast })).health();
      assert.equal(h.healthy, false);
      assert.match(h.reason!, /could not be listed after 3 attempt\(s\)/);
      assert.match(h.reason!, /call 2: exit 2148734208/);
      assert.deepEqual(host.wsbCommands, ["list", "list", "list"], "no sandbox was started");
      assert.equal(host.sandboxes.size, 0);
    });

    test("environment variables are recorded by name, present or absent, never by value; personal values stay out", async () => {
      const host = new SimHost();
      Object.assign(host.envMap, { HTTP_PROXY: "http://proxyuser:hunter2@proxy.example:3128", GRPC_VERBOSITY: "debug-value", USERPROFILE: "C:\\Users\\robert", TEMP: "C:\\Temp" });
      host.listScript = [hung, hung, hung];
      const h = await windowsSandboxBackend(options(host, { listOptions: fast })).health();
      const text = h.reason!;
      for (const present of ["HTTP_PROXY=present", "GRPC_VERBOSITY=present", "USERPROFILE=present", "TEMP=present"]) assert.ok(text.includes(present), present);
      for (const absent of ["HTTPS_PROXY=absent", "NO_PROXY=absent", "ALL_PROXY=absent", "HOME=absent", "APPDATA=absent", "LOCALAPPDATA=absent", "TMP=absent", "SESSIONNAME=absent"]) assert.ok(text.includes(absent), absent);
      for (const value of ["hunter2", "proxyuser", "proxy.example", "debug-value", "robert", "C:\\Temp"]) assert.ok(!text.includes(value), `${value} must not appear`);
      const none = new SimHost(); none.listScript = [hung, hung, hung];
      assert.match((await windowsSandboxBackend(options(none, { listOptions: fast })).health()).reason!, /GRPC_\*=absent/);
    });
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
    const other = new SimHost(); other.sess = { ...ME, consoleUser: "PC\\guest" };
    assert.match((await health(other)).reason!, /not the configured owner/);
    const broken = new SimHost(); broken.session = async () => { throw new Error("wtsapi32 failed"); };
    assert.match((await health(broken)).reason!, /could not be examined: wtsapi32 failed/);
    for (const h of [nobody, other, broken]) assert.deepEqual(h.wsbCommands, []);
  });

  test("whether this process is in the console session as the console user is not a condition: the research started Windows Sandbox from SYSTEM in session 0 with the owner signed in", async () => {
    const cases: WindowsSession[] = [
      { ...ME, consoleUser: "PC\\robert", processInConsoleSession: false },
      { ...ME, consoleUser: "PC\\robert", processIsConsoleUser: false },
      { consoleUser: "PC\\robert" },
    ];
    for (const sess of cases) {
      const host = new SimHost(); host.sess = sess;
      const h = await health(host);
      assert.equal(h.healthy, true, `${JSON.stringify(sess)}: ${h.reason}`);
      assert.ok(host.wsbCommands.includes("start"));
      const j = new SimHost(); const { job, jobDir } = prepared(j); j.sess = sess;
      assert.equal((await runWindowsJob(j, job, [], jobDir)).exitCode, 0);
      const auto = new SimHost(); auto.sess = { ...sess, locked: true };
      const ah = await health(auto, { autologonLock: OPT_IN });
      assert.equal(ah.healthy, true, ah.reason);
    }
    // The existing session conditions are unchanged by the facts: someone else at the console, or an unlocked desktop in auto-login mode, still refuse.
    const other = new SimHost(); other.sess = { ...ME, consoleUser: "PC\\guest" };
    assert.match((await health(other)).reason!, /not the configured owner/);
    const unlocked = new SimHost(); unlocked.sess = { ...ME, consoleUser: "PC\\robert", locked: false };
    assert.match((await health(unlocked, { autologonLock: OPT_IN })).reason!, /not locked/);
    assert.equal(INTERACTIVE_RUNNER_HINT, "start the runner interactively with run.cmd as the console user (not as a service)");
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

describe("Windows launcher: the client package and its signatures (exact allowlist, exact reasons)", () => {
  const WSB = `${INSTALL}\\wsb.exe`;
  const SERVER = `${INSTALL}\\WindowsSandboxServer.exe`;
  const verify = (host: SimHost) => verifyClient(host, settings());
  const withPkg = (extra: Partial<WindowsPackageInfo>): SimHost => { const h = new SimHost(); h.pkg = { ...h.pkg!, ...extra }; return h; };
  const refused = async (host: SimHost, pattern: RegExp, label: string): Promise<void> => {
    const v = await verify(host);
    assert.equal(v.ok, false, `${label} must be refused`);
    if (!v.ok) assert.match(v.reason, pattern, label);
    assert.deepEqual(host.wsbCommands, [], `${label}: nothing was started`);
  };

  test("the allowlist is exactly the two Microsoft pairs and cannot be changed", () => {
    assert.equal(WINDOWS_PUBLISHER_ID, "cw5n1h2txyewy");
    assert.equal(MICROSOFT_STORE_PUBLISHER_ID, "8wekyb3d8bbwe");
    assert.deepEqual(SANDBOX_PACKAGES.map(packageFamilyName), ["MicrosoftWindows.WindowsSandbox_cw5n1h2txyewy", "Microsoft.WindowsSandbox_8wekyb3d8bbwe"]);
    assert.ok(Object.isFrozen(SANDBOX_PACKAGES) && SANDBOX_PACKAGES.every((p) => Object.isFrozen(p)));
  });

  test("each allowed pair is accepted, the Windows-provided one as found on the owner's machine", async () => {
    for (const p of SANDBOX_PACKAGES) {
      const v = await verify(withPkg({ name: p.name, publisherId: p.publisherId, familyName: packageFamilyName(p) }));
      assert.equal(v.ok, true, `${packageFamilyName(p)}: ${v.ok ? "" : v.reason}`);
      if (v.ok) assert.equal(v.value.proof, "wsb.exe: authenticode; WindowsSandboxServer.exe: authenticode");
    }
  });

  test("the right name with another publisher is refused, including the other Microsoft id (each id belongs to one name)", async () => {
    await refused(withPkg({ publisherId: MICROSOFT_STORE_PUBLISHER_ID, familyName: `MicrosoftWindows.WindowsSandbox_${MICROSOFT_STORE_PUBLISHER_ID}` }), /MicrosoftWindows\.WindowsSandbox is from publisher 8wekyb3d8bbwe; only MicrosoftWindows\.WindowsSandbox_cw5n1h2txyewy is accepted/, "MicrosoftWindows name, Store id");
    await refused(withPkg({ name: "Microsoft.WindowsSandbox", publisherId: WINDOWS_PUBLISHER_ID, familyName: `Microsoft.WindowsSandbox_${WINDOWS_PUBLISHER_ID}` }), /from publisher cw5n1h2txyewy; only Microsoft\.WindowsSandbox_8wekyb3d8bbwe/, "Microsoft name, Windows id");
    await refused(withPkg({ publisherId: "abcdefghjkmnp", familyName: "MicrosoftWindows.WindowsSandbox_abcdefghjkmnp" }), /from publisher abcdefghjkmnp/, "unknown publisher");
  });

  test("the right publisher with another name or another family is refused", async () => {
    await refused(withPkg({ name: "MicrosoftWindows.Client.CBS", familyName: `MicrosoftWindows.Client.CBS_${WINDOWS_PUBLISHER_ID}` }), /unexpected package MicrosoftWindows\.Client\.CBS/, "another Windows package");
    await refused(withPkg({ name: "Microsoft.WindowsCalculator", publisherId: MICROSOFT_STORE_PUBLISHER_ID, familyName: `Microsoft.WindowsCalculator_${MICROSOFT_STORE_PUBLISHER_ID}` }), /unexpected package Microsoft\.WindowsCalculator/, "another Store package");
    for (const familyName of ["MicrosoftWindows.Client.CBS_cw5n1h2txyewy", "MicrosoftWindows.WindowsSandbox_8wekyb3d8bbwe", "Microsoft.WindowsSandbox_cw5n1h2txyewy", "", "MicrosoftWindows.WindowsSandbox"]) {
      await refused(withPkg({ familyName }), /package family is .*, not MicrosoftWindows\.WindowsSandbox_cw5n1h2txyewy/, `family ${JSON.stringify(familyName)}`);
    }
  });

  test("lookalikes are refused: case, prefix, suffix, white space, wildcards and truncation of the name, the publisher id and the family", async () => {
    const names = ["microsoftwindows.windowssandbox", "MICROSOFTWINDOWS.WINDOWSSANDBOX", "MicrosoftWindows.WindowsSandbox ", " MicrosoftWindows.WindowsSandbox", "MicrosoftWindows.WindowsSandboxX", "XMicrosoftWindows.WindowsSandbox",
      "MicrosoftWindows.WindowsSandbox.Evil", "Evil.MicrosoftWindows.WindowsSandbox", "MicrosoftWindows.WindowsSandbo", "MicrosoftWindows.WindowsSandbox*", "MicrosoftWindows.*", "*", "", "Microsoft.windowsSandbox", "MicrosoftWindows.WindowsSandbox\u0000"];
    for (const name of names) await refused(withPkg({ name, familyName: `${name}_${WINDOWS_PUBLISHER_ID}` }), /unexpected package/, `name ${JSON.stringify(name)}`);
    const publishers = ["CW5N1H2TXYEWY", "Cw5n1h2txyewy", "cw5n1h2txyewy ", " cw5n1h2txyewy", "cw5n1h2txyew", "cw5n1h2txyewyx", "xcw5n1h2txyewy", "cw5n1h2txyewy8wekyb3d8bbwe", "cw5n*", "*", "", "8WEKYB3D8BBWE"];
    for (const publisherId of publishers) await refused(withPkg({ publisherId, familyName: `MicrosoftWindows.WindowsSandbox_${publisherId}` }), /from publisher/, `publisher ${JSON.stringify(publisherId)}`);
    const families = ["microsoftwindows.windowssandbox_cw5n1h2txyewy", "MicrosoftWindows.WindowsSandbox_CW5N1H2TXYEWY", "MicrosoftWindows.WindowsSandbox_cw5n1h2txyewy ", "XMicrosoftWindows.WindowsSandbox_cw5n1h2txyewy", "MicrosoftWindows.WindowsSandbox_cw5n1h2txyewyx", "MicrosoftWindows.WindowsSandbox__cw5n1h2txyewy", "MicrosoftWindows.WindowsSandbox_*"];
    for (const familyName of families) await refused(withPkg({ familyName }), /package family is/, `family ${JSON.stringify(familyName)}`);
  });

  test("a signature that is not valid is refused with Windows' own status, message, kind of signature and signer in the reason", async () => {
    const statuses: WindowsSignature[] = [
      { valid: false, status: "HashMismatch", statusMessage: "The contents of file <file> might have been changed by an unauthorized user or process", signatureType: "Authenticode", subject: MS },
      { valid: false, status: "NotTrusted", statusMessage: "A certificate chain processed, but terminated in a root certificate which is not trusted", signatureType: "Authenticode", subject: MS },
      { valid: false, status: "UnknownError", statusMessage: "The form specified for the subject is not one supported or known by the specified trust provider", signatureType: "None" },
      { valid: false },
    ];
    for (const sig of statuses) {
      const host = new SimHost(); host.sigs.set(key(WSB), sig);
      const v = await verify(host);
      assert.equal(v.ok, false);
      if (v.ok) continue;
      assert.ok(v.reason.startsWith(`${WSB} does not carry a valid Microsoft signature (`), v.reason);
      assert.ok(v.reason.includes(describeSignature(sig)), v.reason);
      assert.match(v.reason, new RegExp(`status ${sig.status ?? "not reported"}`));
      assert.match(v.reason, new RegExp(`type ${sig.signatureType ?? "not reported"}`));
      assert.match(v.reason, sig.subject === undefined ? /signer none/ : /signer CN=Microsoft Corporation/);
      if (sig.statusMessage !== undefined) assert.ok(v.reason.includes(sig.statusMessage));
      // A broken or untrusted signature is never explained away by the package: the package proof is asked for only when the file has no signature at all.
      assert.doesNotMatch(v.reason, /Microsoft's instead/);
    }
    const otherSigner = new SimHost(); otherSigner.sigs.set(key(SERVER), { valid: true, status: "Valid", subject: "CN=Evil Corp, O=Evil Corp", signatureType: "Authenticode" });
    await refused(otherSigner, /WindowsSandboxServer\.exe does not carry a valid Microsoft signature \(status Valid, type Authenticode, signer CN=Evil Corp, O=Evil Corp\)/, "valid but not Microsoft");
    const lookalikeSigner = new SimHost(); lookalikeSigner.sigs.set(key(WSB), { valid: true, status: "Valid", subject: "CN=Microsoft Corporation Ltd, O=Evil" });
    await refused(lookalikeSigner, /signer CN=Microsoft Corporation Ltd/, "lookalike signer");
  });

  test("a file with no signature at all is accepted only on the exact Microsoft-package proof: one of the two allowlisted packages, signature kind System or Store, state Ok, nothing but administrators can write the file or the folder", async () => {
    const unsigned: WindowsSignature = { valid: false, status: "NotSigned", statusMessage: "The file <file> is not digitally signed.", signatureType: "None" };
    const host = new SimHost(); host.sigs.set(key(WSB), unsigned);
    const v = await verify(host);
    assert.equal(v.ok, true, v.ok ? "" : v.reason);
    if (v.ok) assert.equal(v.value.proof, "wsb.exe: microsoft-package; WindowsSandboxServer.exe: authenticode");
    const both = new SimHost(); both.sigs.set(key(WSB), unsigned); both.sigs.set(key(SERVER), unsigned);
    const b = await verify(both);
    assert.equal(b.ok, true);
    if (b.ok) assert.equal(b.value.proof, "wsb.exe: microsoft-package; WindowsSandboxServer.exe: microsoft-package");

    const variant = (extra: Partial<WindowsPackageInfo>, sig: WindowsSignature = unsigned): SimHost => { const h = withPkg(extra); h.sigs.set(key(WSB), sig); return h; };
    // Store is accepted as well as System, for both allowlisted packages: the owner's machine (own-hardware run 44467707810) reports the Windows-provided package
    // MicrosoftWindows.WindowsSandbox_cw5n1h2txyewy 0.8.114.0 with SignatureKind Store, both programs NotSigned.
    for (const p of SANDBOX_PACKAGES) for (const signatureKind of ["System", "Store"]) {
      const h = variant({ name: p.name, publisherId: p.publisherId, familyName: packageFamilyName(p), signatureKind }); h.sigs.set(key(SERVER), unsigned);
      const r = await verify(h);
      assert.equal(r.ok, true, `${packageFamilyName(p)} ${signatureKind}: ${r.ok ? "" : r.reason}`);
      if (r.ok) assert.equal(r.value.proof, "wsb.exe: microsoft-package; WindowsSandboxServer.exe: microsoft-package");
    }
    for (const signatureKind of ["Developer", "Enterprise", "None", "system", "SYSTEM", "System ", "store", "STORE", "Store ", " Store", "Store\u0000", "StoreX", "System,Store", "Unknown", "0", "4", ""]) await refused(variant({ signatureKind }), new RegExp(`status NotSigned.*not proven to be Microsoft's instead: Windows reports the package's signature kind as ${signatureKind.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}.*, not System or Store`), `kind ${JSON.stringify(signatureKind)}`);
    const noKind = new SimHost(); noKind.pkg = { name: noKind.pkg!.name, publisherId: noKind.pkg!.publisherId, familyName: noKind.pkg!.familyName, version: noKind.pkg!.version, installLocation: INSTALL, status: "Ok" }; noKind.sigs.set(key(WSB), unsigned);
    await refused(noKind, /signature kind as not reported, not System or Store/, "kind not reported");
    assert.deepEqual([...ACCEPTED_SIGNATURE_KINDS], ["System", "Store"]);
    assert.ok(Object.isFrozen(ACCEPTED_SIGNATURE_KINDS));
    for (const signatureKind of ["System", "Store"]) for (const status of ["Tampered", "Modified", "LicenseIssue", "ok", "OK", "Ok ", "NeedsRemediation", "Servicing", ""]) await refused(variant({ status, signatureKind }), new RegExp(`package's state as ${status.trim() === "" ? "" : status.trim()}.*not Ok`), `state ${JSON.stringify(status)} with ${signatureKind}`);
    const noStatus = new SimHost(); noStatus.pkg = { name: noStatus.pkg!.name, publisherId: noStatus.pkg!.publisherId, familyName: noStatus.pkg!.familyName, version: noStatus.pkg!.version, installLocation: INSTALL, signatureKind: "System" }; noStatus.sigs.set(key(WSB), unsigned);
    await refused(noStatus, /state as not reported, not Ok/, "state not reported");
    const writableFile = variant({}); writableFile.writable.set(key(WSB), ["PC\\robert"]);
    await refused(writableFile, /wsb\.exe can be changed by PC\\robert/, "file writable by the owner");
    const writableFolder = variant({}); writableFolder.writable.set(key(INSTALL), ["BUILTIN\\Users"]);
    await refused(writableFolder, /WindowsSandbox_0\.8\.107\.0_x64__cw5n1h2txyewy can be changed by BUILTIN\\Users/, "folder writable by users");
    for (const p of [INSTALL, WSB]) { const linked = variant({}); linked.links.add(key(p)); await refused(linked, /is a link, a junction or a short name, not the package's own path/, `link at ${p}`); }
    const unreadable = variant({}); unreadable.writableBy = async () => { throw new Error("icacls: Access is denied."); };
    await refused(unreadable, /access list of .* could not be read: icacls: Access is denied\./, "access list unreadable");
    // The owner of the file and of the folder must be SYSTEM, Administrators or TrustedInstaller, compared by exact SID.
    for (const owner of ["S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"]) {
      const h = variant({}); h.owners.set(key(WSB), owner); h.owners.set(key(INSTALL), owner);
      const r = await verify(h); assert.equal(r.ok, true, r.ok ? "" : r.reason);
    }
    for (const [p, owner] of [[WSB, "S-1-5-21-1-2-3-1001"], [INSTALL, "S-1-5-21-1-2-3-1001"], [WSB, "S-1-5-32-545"], [INSTALL, "S-1-5-19"], [WSB, "S-1-5-18 "], [WSB, "S-1-5-180"], [INSTALL, "S-1-5-80-956008885-3418522649-1831038044-1853292631-227147846"], [WSB, "NT AUTHORITY\\SYSTEM"], [WSB, ""]] as const) {
      const h = variant({}); h.owners.set(key(p), owner);
      await refused(h, new RegExp(`is owned by ${owner.replace(/[\\.*+?^${}()|[\]]/g, "\\$&")}, not by SYSTEM, Administrators or TrustedInstaller`), `owner ${JSON.stringify(owner)} of ${p}`);
    }
    const ownerUnreadable = variant({}); ownerUnreadable.ownerSid = async (p) => { if (p === INSTALL) throw new Error("Attempted to perform an unauthorized operation."); return "S-1-5-18"; };
    await refused(ownerUnreadable, /the owner of .*cw5n1h2txyewy could not be read: Attempted to perform an unauthorized operation\./, "folder owner unreadable");
    // Only the exact status NotSigned opens the package proof.
    for (const status of ["notsigned", "NotSigned ", "Incompatible", "NotSupportedFileFormat"]) await refused(variant({}, { ...unsigned, status }), /does not carry a valid Microsoft signature/, `status ${status}`);
    for (const status of ["notsigned", "Incompatible"]) { const h = variant({ signatureKind: "Store" }, { ...unsigned, status }); const r = await verify(h); assert.ok(!r.ok && !/Microsoft's instead/.test(r.reason)); }
    // A Store-kind package still needs every other part of the proof: no foreign writer, a trusted owner, no link.
    const storeWritable = variant({ signatureKind: "Store" }); storeWritable.writable.set(key(INSTALL), ["S-1-15-3-1024-1"]);
    await refused(storeWritable, /can be changed by S-1-15-3-1024-1/, "Store kind, folder writable by another SID");
    const storeOwner = variant({ signatureKind: "Store" }); storeOwner.owners.set(key(WSB), "S-1-5-21-1-2-3-1001");
    await refused(storeOwner, /is owned by S-1-5-21-1-2-3-1001/, "Store kind, owned by a user");
    const storeLink = variant({ signatureKind: "Store" }); storeLink.links.add(key(WSB));
    await refused(storeLink, /is a link, a junction or a short name/, "Store kind, link");
    // A contradictory answer (valid, but NotSigned and no signer) is refused, not given the package proof (the real host never reports it, see the probe parsing test).
    await refused(variant({}, { ...unsigned, valid: true }), /does not carry a valid Microsoft signature \(status NotSigned/, "valid but NotSigned");
  });

  test("the audit names the verified package family and how each file was proven", async () => {
    const host = new SimHost(); host.sigs.set(key(WSB), { valid: false, status: "NotSigned", signatureType: "None" }); host.guest = probeGuest(host);
    const backend = windowsSandboxBackend(options(host));
    assert.equal(backend.auditDetails!()["clientProof"], "unverified");
    const h = await backend.health();
    assert.equal(h.healthy, true, h.reason);
    assert.equal(backend.auditDetails!()["clientProof"], "MicrosoftWindows.WindowsSandbox_cw5n1h2txyewy (wsb.exe: microsoft-package; WindowsSandboxServer.exe: authenticode)");
  });

  test("the real probes' answers are read exactly: package fields, signature status, Windows' message without the file's path", () => {
    // The session probe: nobody signed in, the two facts about this process only when determined, the account by SID first and otherwise only by the exact full name.
    assert.deepEqual(sessionFromProbe({ sessionId: null, user: null, domain: null, flags: null }), {});
    assert.deepEqual(sessionFromProbe({ sessionId: 1, user: "robert", domain: "PC", flags: 1, processSessionId: 1, processUser: "PC\\robert", sameSid: true }),
      { consoleUser: "PC\\robert", locked: false, processInConsoleSession: true, processIsConsoleUser: true });
    assert.deepEqual(sessionFromProbe({ sessionId: 1, user: "robert", domain: "PC", flags: 0, processSessionId: 0, processUser: "NT AUTHORITY\\SYSTEM", sameSid: false }),
      { consoleUser: "PC\\robert", locked: true, processInConsoleSession: false, processIsConsoleUser: false }, "a service: session 0, another account");
    assert.equal(sessionFromProbe({ sessionId: 1, user: "robert", domain: "PC", processSessionId: 1, processUser: "pc\\ROBERT", sameSid: null }).processIsConsoleUser, true, "by name when no SID could be compared");
    assert.equal(sessionFromProbe({ sessionId: 1, user: "robert", domain: "PC", processSessionId: 1, processUser: "OTHER\\robert", sameSid: null }).processIsConsoleUser, false, "the name must match whole");
    assert.equal(sessionFromProbe({ sessionId: 1, user: "robert", domain: "PC", processSessionId: 1, processUser: "PC\\robert", sameSid: false }).processIsConsoleUser, false, "the SID decides");
    const unknown = sessionFromProbe({ sessionId: 1, user: "robert", domain: "PC", processSessionId: "1", processUser: "", sameSid: "yes" });
    assert.deepEqual(unknown, { consoleUser: "PC\\robert" }, "nothing undetermined is reported as a fact");
    assert.equal(sessionFromProbe({ sessionId: -1, user: "robert", processSessionId: -1 }).processInConsoleSession, undefined);
    assert.equal(packageFromProbe(null), undefined);
    assert.deepEqual(packageFromProbe({ name: "MicrosoftWindows.WindowsSandbox", publisherId: "cw5n1h2txyewy", familyName: "MicrosoftWindows.WindowsSandbox_cw5n1h2txyewy", version: "0.8.107.0", installLocation: INSTALL, signatureKind: "System", status: "Ok" }),
      { name: "MicrosoftWindows.WindowsSandbox", publisherId: "cw5n1h2txyewy", familyName: "MicrosoftWindows.WindowsSandbox_cw5n1h2txyewy", version: "0.8.107.0", installLocation: INSTALL, signatureKind: "System", status: "Ok" });
    // Missing or odd fields: required ones become empty (and are refused), optional ones absent.
    assert.deepEqual(packageFromProbe({ name: 5, publisherId: null, version: "1.0", installLocation: INSTALL, signatureKind: "", status: 0 }), { name: "", publisherId: "", familyName: "", version: "1.0", installLocation: INSTALL });
    // NonRemovable and IsFramework are recorded only as true/false; anything else is absent.
    const flags = (nonRemovable: unknown, isFramework: unknown): WindowsPackageInfo | undefined => packageFromProbe({ name: "n", publisherId: "p", familyName: "n_p", version: "1.0", installLocation: INSTALL, nonRemovable, isFramework });
    assert.deepEqual([flags(true, false)?.nonRemovable, flags(true, false)?.isFramework], [true, false]);
    for (const v of ["true", 1, null, undefined, "False"]) { const f = flags(v, v)!; assert.ok(!("nonRemovable" in f) && !("isFramework" in f), JSON.stringify(v)); }
    const path = "C:\\Program Files\\WindowsApps\\MicrosoftWindows.WindowsSandbox_0.8.107.0_x64__cw5n1h2txyewy\\wsb.exe";
    assert.deepEqual(signatureFromProbe({ valid: true, status: "Valid", statusMessage: "Signature verified.", signatureType: "Catalog", subject: "CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" }, path),
      { valid: true, status: "Valid", statusMessage: "Signature verified.", signatureType: "Catalog", subject: "CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US" });
    assert.deepEqual(signatureFromProbe({ valid: false, status: "NotSigned", statusMessage: `The file ${path.toUpperCase()} is not digitally signed.\r\n  You cannot run this script.`, signatureType: "None", subject: null }, path),
      { valid: false, status: "NotSigned", statusMessage: "The file <file> is not digitally signed. You cannot run this script.", signatureType: "None" });
    // Valid only when the status says so too; a missing kind of signature (older PowerShell) is absent.
    assert.deepEqual(signatureFromProbe({ valid: true, status: "NotSigned", statusMessage: "" }, path), { valid: false, status: "NotSigned" });
    assert.deepEqual(signatureFromProbe({ valid: "true", status: "Valid" }, path), { valid: false, status: "Valid" });
    assert.deepEqual(signatureFromProbe({}, path), { valid: false });
    const long = shortStatusMessage("x".repeat(500), path);
    assert.equal(long.length, 200);
    assert.ok(long.endsWith("…"));
    assert.equal(shortStatusMessage(`${path} and ${path}`, path), "<file> and <file>");
    assert.equal(describeSignature({ valid: false, status: "NotSigned", statusMessage: "The file <file> is not digitally signed.", signatureType: "None" }), 'status NotSigned, "The file <file> is not digitally signed.", type None, signer none');
    assert.equal(describeSignature({ valid: false }), "status not reported, type not reported, signer none");
    // The owner probe: only a SID passes; a name, an empty or missing answer, or extra text is an error (a refusal on the package proof).
    assert.equal(ownerFromProbe({ owner: "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" }, path), "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
    assert.equal(ownerFromProbe({ owner: "S-1-5-18" }, path), "S-1-5-18");
    for (const raw of [null, {}, { owner: null }, { owner: "" }, { owner: "NT AUTHORITY\\SYSTEM" }, { owner: "S-1-5-18\r\n" }, { owner: " S-1-5-18" }, { owner: "S-1-5" + "-" }, { owner: "S-1" }, { owner: 18 }, { owner: ["S-1-5-18"] }]) {
      assert.throws(() => ownerFromProbe(raw as { owner?: unknown } | null, path), /was not reported as a SID/, JSON.stringify(raw));
    }
  });
});

describe("Windows launcher: explicit auto-login and lock mode", () => {
  const on = (host: SimHost, behave?: Parameters<typeof probeGuest>[1]) => { host.guest = probeGuest(host, behave); host.sess = { ...ME, consoleUser: "PC\\robert", locked: true }; return windowsSandboxBackend(options(host, { autologonLock: OPT_IN })); };

  test("healthy only with a locked console, local auto-login for the owner, a protected lock task; the notes say what the exposure is", async () => {
    const host = new SimHost();
    const h = await on(host).health();
    assert.equal(h.healthy, true, h.reason);
    assert.ok(h.notes!.some((n) => /auto-login and lock mode \(explicit owner opt-in\).*admission only.*19 seconds/.test(n)));
  });

  test("an unlocked or unknown lock state admits nothing", async () => {
    const host = new SimHost(); const b = on(host);
    host.sess = { ...ME, consoleUser: "PC\\robert", locked: false };
    assert.match((await b.health()).reason!, /not locked/);
    host.sess = { ...ME, consoleUser: "PC\\robert" };
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
    host.sess = { ...ME, consoleUser: "PC\\robert", locked: true };
    host.afterStart = () => { host.sess = { ...ME, consoleUser: "PC\\robert", locked: false }; };
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
    // The runner gets the system's own folders and a temporary folder of the supervisor's (its PowerShell probes compile a type there), and nothing of the user's.
    assert.deepEqual(Object.keys(plan.env).sort(), ["NIMBLENEWT_WSB_JOB", "ProgramData", "ProgramFiles", "SystemDrive", "SystemRoot", "TEMP", "TMP"]);
    assert.equal(plan.env["TEMP"], `${CONTROL}\\tmp`);
    assert.equal(plan.env["TMP"], `${CONTROL}\\tmp`);
    assert.ok(host.exists(`${CONTROL}\\tmp`), "the runner's temporary folder exists before it starts");
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
    host.sess = { ...ME, consoleUser: "PC\\robert" }; host.pkg = undefined;
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

  test("a failed stop with a list that never answers is not taken as 'already gone': the record stays, health refuses, and the cleanup reports unknown", async () => {
    const fast = { timeoutsMs: [50, 50, 50], pauseMs: 0 };
    const hung: ProcessResult = { code: null, stdout: "", stderr: "", timedOut: true };
    const host = new SimHost();
    const { backend, plan, jobDir } = prepared(host, { listOptions: fast });
    host.writeText(`${jobDir}\\status.json`, JSON.stringify({ id: "00000000-0000-4000-8000-000000000043" }));
    host.sandboxes.add("00000000-0000-4000-8000-000000000043");
    host.stopFailure = true;
    host.listScript = [hung, hung, hung];
    await assert.rejects(backend.release!(plan), /could not be stopped/);
    assert.ok(host.exists(`${jobDir}\\status.json`), "the sandbox record is kept");
    assert.equal(host.listScript.length, 0, "all three list calls were made");
    // The next health check meets the same leftover and the same silent list: it refuses and starts nothing.
    host.listScript = [hung, hung, hung];
    host.guest = probeGuest(host);
    const h = await backend.health();
    assert.equal(h.healthy, false);
    assert.match(h.reason!, /could not be undone/);
    assert.equal(host.wsbCommands.filter((c) => c === "start").length, 0, "no sandbox was started");
    // The leftover cleanup's final check: a list that fails is unknown, never none.
    host.listScript = [hung, { code: 2148734208, stdout: "", stderr: "Cancelled", timedOut: false }, hung];
    assert.equal(await sandboxRunning(host, { owner: "PC\\robert", shareIdentity: "PC\\robert" }, fast), "unknown");
    host.listScript = [hung, hung];
    assert.equal(await sandboxRunning(host, { owner: "PC\\robert", shareIdentity: "PC\\robert" }, fast), "running", "a retry that answers is used");
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
    // Access denied from wsb start is explained with the session facts of this process at that moment, whether the code or only the text says so.
    for (const failure of [{ code: 2147942405, stdout: "", stderr: "Access is denied.", timedOut: false }, { code: -2147024891, stdout: "", stderr: "", timedOut: false }, { code: 1, stdout: "", stderr: "Access is denied. (0x80070005 (E_ACCESSDENIED))", timedOut: false }]) {
      const d = new SimHost(); d.startFailure = failure;
      const pd = prepared(d); d.sess = { consoleUser: "PC\\robert", locked: false, processInConsoleSession: false, processIsConsoleUser: false };
      const od = await runWindowsJob(d, pd.job, [], pd.jobDir);
      const [first, ...rest] = od.stderr.trimEnd().split("\n");
      assert.equal(first, `failed: Windows Sandbox refused the start (access denied, 0x80070005; wsb start exit ${String(failure.code)}): ${describeWsbAccessDenied(d.sess)}`);
      // Then every mapped folder, with its access list read back while the job's grants are still in place (the share account's grant and the .git deny are visible).
      const shares = sharesFor(pd.job.recipe, `${pd.jobDir}\\guest`);
      const heads = rest.filter((l) => l.startsWith("shared "));
      assert.equal(heads.length, shares.length, od.stderr);
      for (const [i, s] of shares.entries()) assert.equal(heads[i], `shared ${s.guest} <- ${s.host} (${s.readOnly ? "read-only" : "writable"}, ${s.why}):`);
      // Each entry on its own indented line (a public record redacts access lists line by line), the folder's head line first.
      const entriesOf = (why: string): string[] => { const at = rest.findIndex((l) => l.includes(`, ${why}):`)); const next = rest.findIndex((l, i) => i > at && l.startsWith("shared ")); return rest.slice(at + 1, next === -1 ? undefined : next); };
      assert.ok(rest.every((l) => l.startsWith("shared ") || l.startsWith("    ")), od.stderr);
      assert.equal(entriesOf("work")[0], "    NT AUTHORITY\\SYSTEM:(OI)(CI)(F)");
      assert.ok(entriesOf("work").some((l) => /^ {4}\S*robert:\(OI\)\(CI\)M$/i.test(l)), od.stderr);
      assert.ok(entriesOf("protected").some((l) => /^ {4}\S*robert:\(DENY\)\(OI\)\(CI\)\(W,DC\)$/i.test(l)), od.stderr);
      assert.equal(d.runs.filter((r) => r.file.toLowerCase().endsWith("icacls.exe") && r.args.length === 1).length, shares.length, "one read-back per mapped folder");
      // The health probe's reason is the first line only, whole; the read-back stays out of it.
      const dh = new SimHost(); dh.startFailure = failure;
      const hr = (await windowsSandboxBackend(options(dh)).health()).reason!;
      assert.match(hr, /refused the start \(access denied.*check that Windows Sandbox may use the shared folders \(the research of 2026-10-16 saw this error from an output folder it could not use\)$/);
      assert.doesNotMatch(hr, /shared C:\\nn/);
      assert.match(od.stderr, /in the active console session: no; the console user: no\): start the runner interactively with run\.cmd as the console user \(not as a service\); otherwise check that Windows Sandbox may use the shared folders/);
    }
    {
      // A read-back that fails, throws or times out leaves the start's reason in place and only marks that folder; a long list is cut between entries, never inside a name.
      const f = new SimHost(); f.startFailure = { code: 2147942405, stdout: "", stderr: "", timedOut: false };
      const pf = prepared(f);
      const shares = sharesFor(pf.job.recipe, `${pf.jobDir}\\guest`);
      const long = Array.from({ length: 40 }, (_, i) => `CORP\\someone.withalongname${String(i)}:(OI)(CI)(RX)`);
      let n = 0;
      const plain = f.run.bind(f);
      f.run = async (file, args, options) => {
        if (!(file.toLowerCase().endsWith("icacls.exe") && args.length === 1 && f.startFailure !== undefined && f.runs.some((r) => r.args[0] === "start"))) return plain(file, args, options);
        n++;
        if (n === 1) throw new Error("spawn EPERM");
        if (n === 2) return { code: null, stdout: "", stderr: "", timedOut: true };
        return ok(`${args[0]!} ${long.join("\r\n       ")}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`);
      };
      const of = await runWindowsJob(f, pf.job, [], pf.jobDir);
      const lines = of.stderr.trimEnd().split("\n");
      assert.match(lines[0]!, /^failed: Windows Sandbox refused the start \(access denied/);
      assert.equal(lines[1], `shared ${shares[0]!.guest} <- ${shares[0]!.host} (${shares[0]!.readOnly ? "read-only" : "writable"}, ${shares[0]!.why}): access list not readable (icacls could not be run)`);
      assert.match(lines[2]!, /: access list not readable \(icacls exit null, timed out\)$/);
      const kept = lines.filter((l) => /^ {4}CORP\\someone/.test(l));
      assert.ok(kept.length > 0 && kept.every((l) => long.includes(l.trim())), of.stderr);
      assert.ok(kept.join("").replace(/ {4}/g, "").length <= 600 * (shares.length - 2));
      assert.ok(lines.some((l) => /^ {4}… \d+ more entries$/.test(l)), of.stderr);
    }
    // In the console session as the console user, the shared folders are named instead; a session that cannot be read leaves both facts undetermined.
    assert.equal(describeWsbAccessDenied({ consoleUser: "PC\\robert", ...ME }), "this process (in the active console session: yes; the console user: yes) is where Windows Sandbox expects it; check that Windows Sandbox may use the shared folders (the research of 2026-10-16 saw this error from an output folder it could not use)");
    assert.match(describeWsbAccessDenied(undefined), /^this process \(in the active console session: not determined; the console user: not determined\): start the runner interactively/);
    assert.match(describeWsbAccessDenied({ consoleUser: "PC\\robert", processInConsoleSession: true }), /session: yes; the console user: not determined\): start the runner/);
    const t = new SimHost(); t.startFailure = { code: 2147942405, stdout: "", stderr: "", timedOut: false };
    const pt = prepared(t); const plain = t.session.bind(t); let reads = 0;
    t.session = async () => { if (++reads > 1) throw new Error("wtsapi32 failed"); return plain(); };
    assert.match((await runWindowsJob(t, pt.job, [], pt.jobDir)).stderr, /refused the start .*session: not determined/);
    assert.equal(isWsbAccessDenied(1, "Error 0x8000401A"), false); assert.equal(isWsbAccessDenied(5, ""), false); assert.equal(isWsbAccessDenied(null, ""), false);
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

  test("own-hardware cleanup: jobs a killed evidence run left in its test folders are released (sandbox stopped, ACLs back) and the folder goes; a live or failing one is kept", async () => {
    const host = new SimHost();
    const orig = ["NT AUTHORITY\\SYSTEM:(OI)(CI)(F)"];
    const ident = { owner: "PC\\robert", shareIdentity: "PC\\robert" };
    const leave = (control: string, job: string, sandbox: string, folder: string): void => {
      const jobDir = `${control}\\jobs\\${job}`;
      host.writeText(`${jobDir}\\job.json`, "{}");
      host.writeText(`${jobDir}\\status.json`, JSON.stringify({ id: sandbox }));
      host.sandboxes.add(sandbox);
      host.writeText(`${jobDir}\\acl-0.txt`, "saved");
      host.saved.set(key(`${jobDir}\\acl-0.txt`), orig); host.savedFor.set(key(`${jobDir}\\acl-0.txt`), folder);
      host.writeText(`${jobDir}\\acl.json`, JSON.stringify([{ path: folder, parent: folder.slice(0, folder.lastIndexOf("\\")), file: `${jobDir}\\acl-0.txt` }]));
      host.acl.set(key(folder), [...orig, "PC\\robert:(OI)(CI)M"]);
    };
    const real = "C:\\ProgramData\\nn-wsb-real-ab12cd";
    const hostTest = "C:\\ProgramData\\nn-wsb-host-zz9yx8";
    host.envMap["RUNNER_TEMP"] = "D:\\a\\_temp";
    leave(`${real}\\control`, "job-1", "00000000-0000-4000-8000-0000000000b1", `${real}\\job1\\work`);
    leave("D:\\a\\_temp\\nn-g05-wsb\\control", "job-2", "00000000-0000-4000-8000-0000000000b2", "C:\\T\\nn-g05-x\\work");
    // The host test's base has two control folders; one job there cannot be undone, so that base stays whole.
    host.mkdirp(`${hostTest}\\control`);
    leave(`${hostTest}\\control-acl`, "job-3", "00000000-0000-4000-8000-0000000000b3", `${hostTest}\\x\\work`);
    host.saved.delete(key(`${hostTest}\\control-acl\\jobs\\job-3\\acl-0.txt`));
    // Unrelated folders are not looked at.
    host.mkdirp("C:\\ProgramData\\NimbleNewt\\control\\jobs\\other");
    host.mkdirp("C:\\ProgramData\\nn-wsb-real-toolong1\\control\\jobs\\other");
    const dirs = evidenceControlDirs(host);
    assert.deepEqual([...dirs].sort(), [`${hostTest}\\control`, `${hostTest}\\control-acl`, `${real}\\control`, "D:\\a\\_temp\\nn-g05-wsb\\control"].sort());
    assert.equal(await sandboxRunning(host, ident), "running");
    const r = await releaseLeftovers(host, dirs, ident);
    assert.equal(r.released, 2);
    assert.equal(r.kept.length, 1);
    assert.match(r.kept[0]!, /could not be restored/);
    assert.equal(r.removedBases, 1);
    assert.equal(host.exists(real), false, "the real test's folder is gone");
    assert.ok(host.exists(`${hostTest}\\control-acl\\jobs\\job-3\\acl.json`), "a job that could not be undone keeps its record");
    assert.deepEqual(host.acl.get(key("C:\\T\\nn-g05-x\\work")), orig);
    assert.equal(host.exists("D:\\a\\_temp\\nn-g05-wsb\\control\\jobs\\job-2"), false);
    assert.ok(host.exists("C:\\ProgramData\\NimbleNewt\\control\\jobs\\other"));
    assert.ok(host.exists("C:\\ProgramData\\nn-wsb-real-toolong1\\control\\jobs\\other"));
    assert.equal(host.sandboxes.has("00000000-0000-4000-8000-0000000000b1"), false);
    assert.equal(host.sandboxes.has("00000000-0000-4000-8000-0000000000b2"), false);
    // A folder whose lock is held by a live process is left alone, jobs and all.
    const live = "C:\\ProgramData\\nn-wsb-real-live01";
    host.writeText(`${live}\\control\\jobs\\job-4\\job.json`, "{}");
    host.writeText(`${live}\\control\\sandbox.lock`, JSON.stringify({ pid: 777, jobDir: `${live}\\control\\jobs\\job-4` }));
    host.alive.add(777);
    const again = await releaseLeftovers(host, [`${live}\\control`], ident);
    assert.equal(again.removedBases, 0);
    assert.equal(again.released, 0);
    assert.match(again.kept.join(), /in use/);
    assert.ok(host.exists(`${live}\\control\\jobs\\job-4\\job.json`));
    // A control folder reached through a junction (the real host reports the base's junction on the control path), or a job folder that is one, is not touched, and its base stays.
    const linked = "C:\\ProgramData\\nn-wsb-real-link01";
    leave(`${linked}\\control`, "job-5", "00000000-0000-4000-8000-0000000000b5", `${linked}\\w\\work`);
    host.links.add(key(`${linked}\\control`));
    const viaLink = await releaseLeftovers(host, [`${linked}\\control`], ident);
    assert.deepEqual([viaLink.released, viaLink.removedBases], [0, 0]);
    assert.match(viaLink.kept.join(), /link or junction/);
    assert.ok(host.exists(`${linked}\\control\\jobs\\job-5\\acl.json`) && host.sandboxes.has("00000000-0000-4000-8000-0000000000b5"));
    host.links.clear();
    host.links.add(key(`${linked}\\control\\jobs\\job-5`));
    const jobLink = await releaseLeftovers(host, [`${linked}\\control`], ident);
    assert.deepEqual([jobLink.released, jobLink.removedBases], [0, 0]);
    assert.match(jobLink.kept.join(), /job-5 is a link or junction/);
    assert.ok(host.exists(`${linked}\\control\\jobs\\job-5\\acl.json`) && host.exists(linked));
    host.links.clear();
    host.links.add(key(`${linked}\\control\\jobs`));
    const jobsLink = await releaseLeftovers(host, [`${linked}\\control`], ident);
    assert.deepEqual([jobsLink.released, jobsLink.removedBases], [0, 0]);
    assert.match(jobsLink.kept.join(), /link or junction/);
    assert.ok(host.exists(`${linked}\\control\\jobs\\job-5\\acl.json`) && host.exists(linked));
    host.links.clear();
    // Nothing else is reported as running once only the kept job's sandbox is stopped by hand.
    host.sandboxes.clear();
    assert.equal(await sandboxRunning(host, ident), "none");
    host.pkg = undefined;
    assert.equal(await sandboxRunning(host, ident), "unknown");
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

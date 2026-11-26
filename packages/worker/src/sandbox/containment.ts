import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { arch as osArch, release as osRelease, tmpdir } from "node:os";
import { basename, dirname, join, relative, win32 } from "node:path";
import type { SandboxBackend } from "./backend.js";
import { runWindowsNodeCases } from "./containment-windows-cases.js";
import { windowsEvidenceBackend } from "./containment-windows.js";
import { SandboxLauncher } from "./launcher.js";
import { GUEST, type SandboxRecipe } from "./recipe.js";
import { NATIVE_BACKEND_NAME as NATIVE_BACKEND, RUN_PROFILE_PREFIX } from "./windows-native-plan.js";
import { GUEST_PATHS, guestPathFor } from "./windows-plan.js";

/*
 * Card G05: proof of the selected isolation boundary on each OS. This file is two things.
 *
 * 1. A fixture and a case list (`runContainmentSuite`) that start REAL processes through the production `SandboxLauncher` (never a model of it) and try to write outside the workspace, escape
 *    through links, read credentials, reach the network and change protected names. Every verdict is decided from the host side (a file that must not change, a server that must not be reached),
 *    not from what the confined program prints. The suite also runs positive controls (the same attempts on the agent's own directories succeed) so a denial cannot be a broken probe.
 * 2. A release gate (`assessRelease`) that reads the reports of the platforms and says what still blocks a release: a missing platform, a failed or missing case, evidence about another commit,
 *    and the evidence only a real Windows PC can give. Since the owner's decision of 2026-11-26 (keep the AppContainer launcher, no Windows Sandbox) that is the native launcher's evidence
 *    (`NativeWindowsEvidence`): the launcher is the released one for this commit, the run was not elevated, in the signed-in user's interactive session with its window objects made, every
 *    per-run profile gone and every grant read back clean, plus the packaged controller working directory and the strict supervisor-ACL check. The Windows Sandbox era block (`windows`: the
 *    unattended service identity after logout and reboot, the mapped-output ACL controls) no longer satisfies it. A run refused cleanly after the owner signs out is NOT yet required (open item, A03b).
 */

export const CONTAINMENT_SCHEMA = "nimblenewt.containment/1";
export type PlatformName = "linux" | "darwin" | "win32";
export const REQUIRED_PLATFORMS: readonly PlatformName[] = ["linux", "darwin", "win32"];

export type CaseCategory = "workspace-write" | "symlink-escape" | "credential-read" | "controller-data" | "network-route" | "protected-name" | "control";
/** `pass`: the boundary held (or, for a control, the permitted action worked). `fail`: it did not. `inconclusive`: the attempt could not be made (no tool to try with), which never counts as a pass. `not_run`: not attempted here. */
export type Verdict = "pass" | "fail" | "inconclusive" | "not_run";

export interface CaseResult {
  readonly id: string;
  readonly category: CaseCategory;
  readonly verdict: Verdict;
  /** Why, in a sentence (bounded). Never contains fixture contents. */
  readonly detail: string;
}

export interface TrustedHostException {
  readonly mode: "trusted-host";
  readonly authority: string;
  /** What the exception was shown to allow: a trusted-host run reads host files the sandbox hides. */
  readonly reachesHostFiles: boolean;
  /** Whether a trusted-host launch with no configured authority is refused. */
  readonly refusedWithoutAuthority: boolean;
}

/** SUPERSEDED (Windows Sandbox era): still read so an old report parses, but the release gate refuses a Windows report that carries it (it is not AppContainer evidence). */
export interface WindowsEvidence {
  /** The account the launch/exec/results/teardown ran as, and how it was running. */
  readonly serviceIdentity: { readonly account: string; readonly session: "service" | "interactive" };
  /** The four lifecycle phases proven under that identity after logout and again after a reboot. */
  readonly afterLogout: Readonly<Record<"launch" | "exec" | "results" | "teardown", boolean>>;
  readonly afterReboot: Readonly<Record<"launch" | "exec" | "results" | "teardown", boolean>>;
  /** Mapped-output ACL controls: the granted account can write the mapped output (positive) and no other account can (negative). */
  readonly mappedOutputAcl: { readonly positive: boolean; readonly negative: boolean };
  /** The packaged controller started from its install directory, with the working directory it will have as a service, and the check passed. */
  readonly packagedControllerWorkingDirectory: { readonly packaged: boolean; readonly passed: boolean };
  /** `strict`: the supervisor-ACL check ran and refused a writable checkout. `report-only` is not release evidence (A03b). */
  readonly supervisorAclCheck: "strict" | "report-only";
  /** The Windows Sandbox feature being enabled, or one smoke run in a signed-in session, is recorded but never counts. */
  readonly featureEnabledOnly?: boolean;
}

/**
 * Card A03b: the Windows host evidence of the native AppContainer launcher (`backend` = `windows-native`), filled from what the run itself recorded (containment-windows-native-evidence.ts), never
 * typed in by hand. What a run did not record is `not-measured` / `null`, which the gate refuses.
 */
export interface NativeWindowsEvidence {
  /** The launcher that ran: its release record's commit and SHA-256, and the SHA-256 of the file itself. */
  readonly launcher: { readonly recordCommit: string; readonly recordSha256: string; readonly fileSha256: string };
  /** From the launcher's `info`: whether the token was elevated. */
  readonly elevated: boolean;
  /** The account the run was made as: a standard user, or an administrator running with its filtered (UAC) token. */
  readonly accountKind: "standard" | "administrator-filtered" | "not-measured";
  /** From the launcher's `info`: the Windows session. 0 is the services session (no signed-in user's desktop), which this release does not support. */
  readonly sessionId: number;
  /** From the launcher's `info`: the window-object mode (`private` or `home-desktop`) and whether it could be made. */
  readonly windowStation: string;
  readonly windowStationOk: boolean;
  /** The per-run container profiles: `info`'s throw-away profile created, deleted and found gone, and the count of `NimbleNewtRun-*` profiles left after the whole run (`null`: not counted). */
  readonly profiles: { readonly created: boolean; readonly deleted: boolean; readonly gone: boolean; readonly leftover: number | null };
  /** The independent read-back of every grant after every run (the backend's run records): `clean` only when every record says so. */
  readonly grantsReadBack: "clean" | "left" | "not-measured";
  /** Whether the account held SeCreateSymbolicLinkPrivilege (`null`: not recorded). Only `false` lets a file-link case be inconclusive for want of it. */
  readonly symlinkRight: boolean | null;
  /** As in the Windows Sandbox era: the packaged controller's working directory check and the strict supervisor-ACL check (the native backend's control folder is never granted to the container). */
  readonly packagedControllerWorkingDirectory: { readonly packaged: boolean; readonly passed: boolean };
  readonly supervisorAclCheck: "strict" | "report-only" | "not-run";
}

export interface ContainmentReport {
  readonly schema: typeof CONTAINMENT_SCHEMA;
  readonly generatedAt: string;
  /** The 40-hex commit of the implementation the evidence was produced from, and whether the working tree had changes. */
  readonly implementationCommit: string;
  readonly dirty: boolean;
  readonly platform: PlatformName;
  readonly arch: string;
  /** OS release as the OS reports it (macOS: the Darwin kernel release; `macosVersion` carries the product version). */
  readonly osVersion: string;
  readonly macosVersion?: string;
  readonly backend: string;
  readonly backendVersion?: string;
  /** Whether the launcher advertised capacity; without it no case ran. */
  readonly capacityAvailable: boolean;
  readonly capacityReason?: string;
  /** Stated, not measured: the macOS boundary and the native Windows launcher's are process-level and weaker than Linux's (denied paths stay visible, no private process list, no private view of the filesystem). */
  readonly weakerThanLinux: boolean;
  readonly cases: readonly CaseResult[];
  readonly trustedHost?: TrustedHostException;
  readonly windows?: WindowsEvidence;
  readonly nativeWindows?: NativeWindowsEvidence;
}

/** Every case a platform must pass. A report missing one of these cannot satisfy the gate. */
export const REQUIRED_CASE_IDS: readonly string[] = [
  "control-write-own-directories",
  "control-read-own-decoy",
  "deny-write-system",
  "deny-write-host-path",
  "deny-symlink-read",
  "deny-symlink-write",
  "deny-credential-read",
  "deny-controller-data-read",
  "deny-network-loopback",
  "deny-write-protected-name",
];

const CATEGORY: Readonly<Record<string, CaseCategory>> = {
  "control-write-own-directories": "control",
  "control-read-own-decoy": "control",
  "deny-write-system": "workspace-write",
  "deny-write-host-path": "workspace-write",
  "deny-symlink-read": "symlink-escape",
  "deny-symlink-write": "symlink-escape",
  "deny-credential-read": "credential-read",
  "deny-controller-data-read": "controller-data",
  "deny-network-loopback": "network-route",
  "deny-write-protected-name": "protected-name",
};

const SECRET_CONTROLLER = "G05-CONTROLLER-SECRET-7f3a";
const SECRET_KEY = "G05-CREDENTIAL-SECRET-91bc";
const OUTSIDE_ORIGINAL = "G05-OUTSIDE-ORIGINAL-2d40";
const GIT_ORIGINAL = "G05-GIT-ORIGINAL-5e17";
const OWN_DECOY = "G05-OWN-DECOY-c8a2";
const END = "g05-end";

/** The things the suite plants on the host and checks afterwards. Synthetic: nothing here is a real credential or the controller's data. */
interface Fixture {
  readonly root: string;
  readonly controllerDir: string;
  readonly controllerFile: string;
  readonly home: string;
  readonly credentialFile: string;
  readonly outsideDir: string;
  readonly outsideFile: string;
  readonly server: Server;
  readonly port: number;
  readonly connections: () => number;
  /** Puts the planted files back as they were and removes anything an attempt created next to them (the unconfined pairing changes them on purpose). */
  reset(): void;
  close(): Promise<void>;
}

async function buildFixture(): Promise<Fixture> {
  // On Windows the native call also expands short (8.3) names such as RUNNER~1, which the Windows Sandbox backend refuses in a shared path.
  const root = (process.platform === "win32" ? realpathSync.native : realpathSync)(mkdtempSync(join(tmpdir(), "nn-g05-")));
  const dir = (name: string): string => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };
  const controllerDir = dir("controller-data");
  const controllerFile = join(controllerDir, "controller.db");
  writeFileSync(controllerFile, SECRET_CONTROLLER);
  const home = dir("service-home");
  mkdirSync(join(home, ".ssh"));
  const credentialFile = join(home, ".ssh", "id_g05_fixture");
  writeFileSync(credentialFile, SECRET_KEY);
  const outsideDir = dir("outside");
  const outsideFile = join(outsideDir, "victim.txt");
  writeFileSync(outsideFile, OUTSIDE_ORIGINAL);
  let connections = 0;
  const server = createServer((socket) => { connections += 1; socket.on("error", () => undefined); socket.end("HOST-SERVICE"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const planted: readonly (readonly [string, string, string])[] = [[outsideDir, outsideFile, OUTSIDE_ORIGINAL], [controllerDir, controllerFile, SECRET_CONTROLLER], [join(home, ".ssh"), credentialFile, SECRET_KEY]];
  const reset = (): void => {
    for (const [d, keep, content] of planted) {
      for (const name of readdirSync(d)) if (join(d, name) !== keep) rmSync(join(d, name), { recursive: true, force: true });
      rmSync(keep, { force: true });
      writeFileSync(keep, content);
    }
  };
  return { root, controllerDir, controllerFile, home, credentialFile, outsideDir, outsideFile, server, port, connections: () => connections, reset, close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); } };
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** A path for a cmd batch file: double-quoted (Windows paths cannot contain a double quote), percent signs doubled so the batch file reads them literally. */
const wq = (s: string): string => `"${s.replace(/%/g, "%%")}"`;
/** The Windows directory of the host the suite runs on (the guest's is always C:\Windows). */
const WIN_ROOT = process.env["SystemRoot"] ?? "C:\\Windows";
/** Bounded, one line, and printable (program output may carry terminal controls; `parseReport` refuses them). */
const short = (s: string): string => (s.length > 300 ? `${s.slice(0, 300)}...` : s).replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?");

interface Attempt {
  readonly script: string;
  /** Judges what the program printed: a failure reason, `inconclusive:<why>`, or undefined when the case holds. */
  readonly judge: (out: string) => string | undefined;
  /** Judges the host after the attempt (a file that must not change, a server that must not be reached): a failure reason or undefined. */
  readonly host: (out: string) => string | undefined | Promise<string | undefined>;
  /**
   * For a denial: what of this attempt did NOT get through when it ran without the sandbox (undefined: every part got through). Decided on the host where the attempt changes the host, else from the output of
   * the unconfined run. A denial counts only when the very same attempt is shown to work unconfined, so a probe that fails for an unrelated reason (a typo, a missing tool or fixture) is inconclusive, never a pass.
   */
  readonly proof?: (out: string) => string | undefined | Promise<string | undefined>;
}

interface CaseDef {
  readonly id: string;
  /** Builds the attempt on a fresh agent directory set (links and protected names are planted there). Called once for the unconfined pairing and once for the confined run. */
  readonly make: (recipe: SandboxRecipe) => Attempt;
}

export interface SuiteOptions {
  /** The launcher under test. Default: a production launcher for this platform. */
  readonly launcher?: SandboxLauncher;
  /** The backend of the default launcher (ignored when `launcher` is given). Default: the launcher's own default for this OS; `produceReport` passes the native launcher (`windowsEvidenceBackend`) on Windows. */
  readonly backend?: SandboxBackend;
  /** Tests only: the launcher of the unconfined pairing. Default: a production launcher allowed trusted-host runs for the suite alone. */
  readonly unconfinedLauncher?: SandboxLauncher;
  /**
   * How the cases are written: POSIX `sh` (Linux, macOS), Windows `cmd` batch files (the superseded Windows Sandbox backend) or `windows-node` (card A03b: one plain-JavaScript runner run by node, since the native
   * container refuses cmd.exe starting programs). Default: `posix`, and `windows-node` on Windows. Tests set it to check the Windows cases on any OS.
   */
  readonly dialect?: "posix" | "windows" | "windows-node";
  /** `windows-node` only. The node program the confined runner uses (default: this one). */
  readonly nodeExecutable?: string;
  /** `windows-node` only, tests: the system paths the system-write case tries (default: the host's Windows folders). */
  readonly systemPaths?: readonly string[];
  readonly timeoutMs?: number;
  /** Tests only: changes a case's script before it runs (both the unconfined pairing and the confined run), to show that a broken probe is reported inconclusive. Never set by `produceReport`'s command line. */
  readonly rewriteScript?: (id: string, script: string) => string;
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs every case through the launcher and returns the verdicts. The launcher defaults to the production one for this OS (never a stand-in); a test may pass one built on another backend to show that the cases can fail.
 * Each denial is first run WITHOUT the sandbox (through a trusted-host launcher configured for the suite alone) and must get through there; only then does the confined run's refusal count.
 * The service user's HOME is pointed at the fixture for the duration (the launcher protects the credential places under it).
 */
export async function runContainmentSuite(options: SuiteOptions = {}): Promise<{ capacity: SandboxLauncher["capacity"]; cases: CaseResult[]; trustedHost: TrustedHostException | undefined }> {
  const fixture = await buildFixture();
  const originalHome = process.env["HOME"];
  process.env["HOME"] = fixture.home;
  const dialect = options.dialect ?? (process.platform === "win32" ? "windows-node" : "posix");
  const win = dialect === "windows";
  const nodeWin = dialect === "windows-node";
  // Every cmd-dialect case starts a fresh Windows Sandbox, which takes far longer than a bubblewrap or Seatbelt start; the node runner makes one confined start for all ten cases.
  const timeoutMs = options.timeoutMs ?? (win ? 300_000 : nodeWin ? 120_000 : 30_000);
  const rewrite = options.rewriteScript ?? ((_id: string, script: string) => script);
  try {
    const launcher = options.launcher ?? await SandboxLauncher.create({ protectedPaths: [fixture.controllerDir], audit: () => undefined, ...(options.backend === undefined ? {} : { backend: options.backend }) });
    const capacity = launcher.capacity;
    if (!capacity.available) return { capacity, cases: REQUIRED_CASE_IDS.map((id) => ({ id, category: CATEGORY[id]!, verdict: "not_run" as const, detail: short(`no capacity: ${capacity.reason ?? "unavailable"}`) })), trustedHost: undefined };
    const linuxView = capacity.backend === "bubblewrap";
    const authority = "G05 containment evidence (the suite's own test authority)";
    let unconfined: SandboxLauncher | undefined;
    if (options.unconfinedLauncher !== undefined) unconfined = options.unconfinedLauncher;
    else try { unconfined = await SandboxLauncher.create({ protectedPaths: [fixture.controllerDir], trustedHost: { authority }, audit: () => undefined }); } catch { unconfined = undefined; }
    let n = 0;
    const results: CaseResult[] = [];
    if (nodeWin) {
      const node = options.nodeExecutable ?? process.execPath;
      const nodeHostFolder = /^[A-Za-z]:\\/.test(node) ? win32.dirname(node) : dirname(node);
      const launch = async (mode: "sandboxed" | "trusted-host", recipe: SandboxRecipe, command: string[]): Promise<{ timedOut: boolean; exitCode: number | null; stdout: string; stderr: string }> => {
        const via = mode === "sandboxed" ? launcher : unconfined;
        if (via === undefined) throw new Error("no launcher for this mode");
        const r = await (await via.launch({ recipe, command, timeoutMs, maxOutputBytes: 200_000 })).result;
        return { timedOut: r.timedOut, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      };
      const found = await runWindowsNodeCases({
        fixture, secrets: { controller: SECRET_CONTROLLER, key: SECRET_KEY, outside: OUTSIDE_ORIGINAL, git: GIT_ORIGINAL, decoy: OWN_DECOY },
        nodeGuestPath: `/opt/node/${basename(node.replace(/\\/g, "/"))}`, nodeHostFolder, hostNode: node,
        systemPaths: options.systemPaths ?? [win32.join(WIN_ROOT, "g05-x"), win32.join(WIN_ROOT, "System32", "g05-x"), "C:\\g05-x", "C:\\Program Files\\g05-x"],
        launch, canRunFree: unconfined !== undefined, windows: process.platform === "win32", settle: () => settle(100),
      });
      for (const c of found) results.push({ id: c.id, category: CATEGORY[c.id]!, verdict: c.verdict, detail: short(c.detail) });
    }
    // On Windows a case is a batch file in a read-only input (`/inputs/g05`): cmd.exe arguments may not carry quotes or percent signs (A03b refuses them), and the guest cannot change the file before it runs.
    const recipeOf = (): SandboxRecipe => {
      n += 1;
      const base = join(fixture.root, `agent${n}`);
      const d = (name: string): string => { const p = join(base, name); mkdirSync(p, { recursive: true }); return p; };
      return { mode: "sandboxed", workdir: d("work"), home: d("home"), scratch: d("scratch"), readOnly: win ? [{ host: d("g05-case"), guest: "/inputs/g05" }] : [], network: "none", env: win ? { SystemRoot: WIN_ROOT } : {}, protectedSubpaths: [".git"] };
    };
    /** The program line of one attempt: `sh -c` on POSIX; on Windows cmd.exe running the case's batch file, by its guest path when confined and its host path when not. */
    const commandOf = (recipe: SandboxRecipe, script: string): string[] => {
      if (!win) return ["/bin/sh", "-c", script];
      const tools = recipe.readOnly[0]!.host;
      writeFileSync(join(tools, "case.cmd"), `@echo off\r\n${script.split(/\r?\n/).join("\r\n")}\r\n`);
      return recipe.mode === "trusted-host" ? [win32.join(WIN_ROOT, "System32", "cmd.exe"), "/d", "/c", join(tools, "case.cmd")] : ["/windows/system32/cmd.exe", "/d", "/c", guestPathFor("/inputs/g05/case.cmd")!];
    };

    /** Runs one attempt and says what the host and the output show: undefined (nothing got through), a failure reason, or `inconclusive:<why>`. */
    const execute = async (via: SandboxLauncher, recipe: SandboxRecipe, id: string, attempt: Attempt): Promise<{ problem: string | undefined; out: string }> => {
      fixture.reset();
      const run = await via.launch({ recipe, command: commandOf(recipe, rewrite(id, attempt.script)), timeoutMs, maxOutputBytes: 200_000 });
      const result = await run.result;
      // A connection the program made just before it ended may not have been accepted yet: give the host's event loop a moment before asking the witness.
      await settle(100);
      const out = `${result.stdout}\n${result.stderr}`;
      if (result.timedOut) return { problem: "inconclusive:the attempt timed out", out };
      if (!out.includes(END)) return { problem: `inconclusive:the attempt did not reach its end marker (${short(out)})`, out };
      return { problem: attempt.judge(out) ?? await attempt.host(out), out };
    };

    const record = async (def: CaseDef): Promise<void> => {
      if (nodeWin) return; // the node runner above made these verdicts
      const category = CATEGORY[def.id]!;
      const push = (verdict: Verdict, detail: string): void => { results.push({ id: def.id, category, verdict, detail: short(detail) }); };
      try {
        let paired = "";
        const first = recipeOf();
        const probe = def.make(first);
        if (probe.proof !== undefined) {
          // The pairing: without the sandbox the same attempt must get through, or a refusal below proves nothing.
          if (unconfined === undefined) return push("inconclusive", "the attempt could not be run without the sandbox to show that it works");
          const free = await execute(unconfined, { ...first, mode: "trusted-host" }, def.id, { ...probe, judge: () => undefined, host: () => undefined });
          if (free.problem !== undefined) return push("inconclusive", `the attempt did not run to its end without the sandbox: ${free.problem.replace(/^inconclusive:/, "")}`);
          const missing = await probe.proof(free.out);
          if (missing !== undefined) return push("inconclusive", `without the sandbox the same attempt did not get through (${missing}), so a refusal would prove nothing`);
          paired = "; the same attempt got through without the sandbox";
        }
        // A control runs once; a denial runs again on fresh directories (the unconfined run may have changed its own).
        const recipe = probe.proof === undefined ? first : recipeOf();
        const confined = probe.proof === undefined ? probe : def.make(recipe);
        const { problem } = await execute(launcher, recipe, def.id, confined);
        if (problem === undefined) push("pass", `held${paired}`);
        else if (problem.startsWith("inconclusive:")) push("inconclusive", problem.slice("inconclusive:".length));
        else push("fail", problem);
      } catch (error) {
        push("inconclusive", `the attempt could not be launched: ${(error as Error).message}`);
      }
    };
    const leaked = (out: string, ...secrets: string[]): string | undefined => (secrets.some((x) => out.includes(x)) ? "the confined program printed protected content" : undefined);
    const shown = (out: string, ...secrets: string[]): string | undefined => { const absent = secrets.filter((x) => !out.includes(x)); return absent.length === 0 ? undefined : `not read: ${absent.join(", ")}`; };
    const same = (file: string, expected: string): boolean => existsSync(file) && readFileSync(file, "utf8") === expected;
    const none = (): undefined => undefined;

    // Controls: what the agent is allowed to do works. Without these a denial could be a sandbox that refuses everything.
    await record({ id: "control-write-own-directories", make: (r) => {
      const scratchGuest = win ? GUEST_PATHS.scratch : linuxView ? GUEST.scratch : r.scratch;
      const script = win
        ? `echo w> "%CD%\\c-work"\necho h> "%HOME%\\c-home"\necho s> ${wq(scratchGuest + "\\c-scratch")}\necho ${END}`
        : `echo w > "$PWD/c-work"; echo h > "$HOME/c-home"; echo s > ${quote(scratchGuest)}/c-scratch; echo ${END}`;
      return { script, judge: none, host: () =>
        existsSync(join(r.workdir, "c-work")) && existsSync(join(r.home, "c-home")) && existsSync(join(r.scratch, "c-scratch")) ? undefined : "the agent could not write its own directories" };
    } });
    await record({ id: "control-read-own-decoy", make: (r) => {
      writeFileSync(join(r.workdir, "decoy.txt"), OWN_DECOY);
      return { script: win ? `type "%CD%\\decoy.txt"\necho.\necho ${END}` : `cat "$PWD/decoy.txt"; echo; echo ${END}`, judge: (out) => (out.includes(OWN_DECOY) ? undefined : "the agent could not read its own file"), host: none };
    } });

    // Writes outside the workspace. The system directories are not paired: an unprivileged process cannot write there without a sandbox either (a regression guard for a run as root or a writable bind).
    // On Windows the guest's own C: is a disposable disk, so a write there is harmless; what is checked is the host's C:.
    const sys = win ? [win32.join(WIN_ROOT, "g05-x"), win32.join(WIN_ROOT, "System32", "g05-x"), "C:\\g05-x", "C:\\Program Files\\g05-x"] : ["/usr/g05-x", "/etc/g05-x", "/bin/g05-x", "/g05-x"];
    await record({ id: "deny-write-system", make: () => ({
      script: win ? `${sys.map((p) => `(type nul > ${wq(p)}) 2>nul`).join("\n")}\necho ${END}` : `for p in ${sys.join(" ")}; do ( : > "$p" ) 2>/dev/null; done; echo ${END}`,
      judge: none, host: () => (sys.some((p) => existsSync(p)) ? "a file was created in a system directory of the host" : undefined),
    }) });
    const targets = [join(fixture.outsideDir, "g05-created"), join(fixture.controllerDir, "g05-created"), join(fixture.home, ".ssh", "g05-created")];
    await record({ id: "deny-write-host-path", make: () => ({
      script: win
        ? `(echo overwritten> ${wq(fixture.outsideFile)}) 2>nul\n${targets.map((t) => `(type nul > ${wq(t)}) 2>nul`).join("\n")}\necho ${END}`
        : `( echo overwritten > ${quote(fixture.outsideFile)} ) 2>/dev/null; ${targets.map((t) => `( : > ${quote(t)} ) 2>/dev/null;`).join(" ")} echo ${END}`,
      judge: none,
      host: () => {
        if (!same(fixture.outsideFile, OUTSIDE_ORIGINAL)) return "a host file outside the workspace was changed";
        if (targets.some((t) => existsSync(t))) return "a file was created in a host directory outside the workspace";
        return undefined;
      },
      proof: () => (same(fixture.outsideFile, OUTSIDE_ORIGINAL) ? "the outside file was not changed" : targets.find((t) => !existsSync(t))),
    }) });

    // Links in the checkout that lead out of it. On Windows the directory links are junctions (no privilege needed); file links need the right to create symbolic links, and a host
    // without it makes the case inconclusive (the planting throws), never a pass. /proc does not exist there.
    await record({ id: "deny-symlink-read", make: (r) => {
      symlinkSync(fixture.controllerFile, join(r.workdir, "link-abs-file"), "file");
      symlinkSync(fixture.controllerDir, join(r.workdir, "link-abs-dir"), win ? "junction" : "dir");
      if (win) symlinkSync(relative(r.workdir, fixture.credentialFile), join(r.workdir, "link-rel-key"), "file");
      else symlinkSync(`../../../../../../../../../../..${fixture.credentialFile}`, join(r.workdir, "link-rel-key"));
      if (!win) symlinkSync("/proc/1/root", join(r.workdir, "link-proc-root"));
      // Each read is tagged, so the pairing can tell that every one of them works without the sandbox. The /proc/1/root read is not required there (an unprivileged process may not follow it).
      return {
        script: win
          ? `<nul set /p =A:\ntype "%CD%\\link-abs-file" 2>nul\necho.\n<nul set /p =D:\ndir /b "%CD%\\link-abs-dir" 2>nul\necho.\n<nul set /p =R:\ntype "%CD%\\link-rel-key" 2>nul\necho.\necho ${END}`
          : `echo "A:$(cat "$PWD/link-abs-file" 2>/dev/null)"; echo "D:$(ls "$PWD/link-abs-dir" 2>/dev/null)"; echo "R:$(cat "$PWD/link-rel-key" 2>/dev/null)"; echo "P:$(cat "$PWD/link-proc-root"${quote(fixture.controllerFile)} 2>/dev/null)"; echo ${END}`,
        judge: (out) => leaked(out, SECRET_CONTROLLER, SECRET_KEY, "controller.db"), host: none,
        proof: (out) => shown(out, `A:${SECRET_CONTROLLER}`, "D:controller.db", `R:${SECRET_KEY}`),
      };
    } });
    await record({ id: "deny-symlink-write", make: (r) => {
      symlinkSync(fixture.outsideFile, join(r.workdir, "link-write"), "file");
      symlinkSync(fixture.outsideDir, join(r.workdir, "link-dir"), win ? "junction" : "dir");
      return {
        script: win
          ? `(echo overwritten> "%CD%\\link-write") 2>nul\n(type nul > "%CD%\\link-dir\\g05-via-link") 2>nul\necho ${END}`
          : `( echo overwritten > "$PWD/link-write" ) 2>/dev/null; ( : > "$PWD/link-dir/g05-via-link" ) 2>/dev/null; echo ${END}`,
        judge: none,
        host: () => (!same(fixture.outsideFile, OUTSIDE_ORIGINAL) || existsSync(join(fixture.outsideDir, "g05-via-link")) ? "a write through a link changed a host path outside the workspace" : undefined),
        proof: () => (same(fixture.outsideFile, OUTSIDE_ORIGINAL) ? "the write through the file link" : !existsSync(join(fixture.outsideDir, "g05-via-link")) ? "the write through the directory link" : undefined),
      };
    } });

    // Credentials and the controller's own data.
    const tagged = (tag: string, file: string, listTag: string, dir: string, extra = ""): string => (win
      ? `<nul set /p =${tag}:\ntype ${wq(file)} 2>nul\necho.\n<nul set /p =${listTag}:\ndir /b ${wq(dir)} 2>nul\necho.\n${extra === "" ? "" : `${extra}\n`}echo ${END}`
      : `echo "${tag}:$(cat ${quote(file)} 2>/dev/null)"; echo "${listTag}:$(ls ${quote(dir)} 2>/dev/null)"; ${extra === "" ? "" : `${extra}; `}echo ${END}`);
    await record({ id: "deny-credential-read", make: () => ({
      script: tagged("K", fixture.credentialFile, "L", join(fixture.home, ".ssh"), win ? "set" : "env"),
      judge: (out) => leaked(out, SECRET_KEY, "id_g05_fixture"), host: none, proof: (out) => shown(out, `K:${SECRET_KEY}`, "L:id_g05_fixture"),
    }) });
    await record({ id: "deny-controller-data-read", make: () => ({
      script: tagged("C", fixture.controllerFile, "L", fixture.controllerDir),
      judge: (out) => leaked(out, SECRET_CONTROLLER, "controller.db"), host: none, proof: (out) => shown(out, `C:${SECRET_CONTROLLER}`, "L:controller.db"),
    }) });

    // The network: nothing leaves the sandbox. The host's loopback server is the witness (it must see the unconfined attempt and not the confined one).
    // On Windows the guest is a virtual machine whose 127.0.0.1 is its own, so the loopback attempt cannot reach the host even when the sandbox has a network: there the guest also lists
    // its network adapters that are up (other than loopback and tunnels), and any adapter fails the case, as a non-loopback interface does on Linux. A missing list is inconclusive.
    await record({ id: "deny-network-loopback", make: () => {
      const before = fixture.connections();
      const script = win
        ? [
          "set tried=0",
          `set "PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"`,
          'if not exist "%PS%" goto g05nops',
          "set tried=1",
          `"%PS%" -NoProfile -NonInteractive -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', ${fixture.port}); 'CONNECTED-PS'; $c.Close() } catch { }"`,
          `"%PS%" -NoProfile -NonInteractive -Command "$a = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' -and $_.NetworkInterfaceType -ne 'Tunnel' } | ForEach-Object { $_.Name }); 'adapters=' + ($a -join ',')"`,
          ":g05nops",
          "echo tried=%tried%",
          `echo ${END}`,
        ].join("\n")
        : `tried=0; if command -v nc >/dev/null 2>&1; then tried=1; nc -z -w 2 127.0.0.1 ${fixture.port} && echo CONNECTED-NC; fi; if command -v bash >/dev/null 2>&1; then tried=1; bash -c 'exec 3<>/dev/tcp/127.0.0.1/${fixture.port}' 2>/dev/null && echo CONNECTED-BASH; fi; echo tried=$tried; if [ -r /proc/net/dev ]; then echo ifaces=$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\\n' ,); fi; echo ${END}`;
      return {
        script,
        judge: (out) => {
          if (!out.includes("tried=1")) return `inconclusive:no tool (${win ? "PowerShell" : "nc or bash"}) was available to attempt a connection`;
          if (/CONNECTED-/.test(out)) return "the confined program connected to a host service";
          if (win) {
            const adapters = /adapters=([^\r\n]*)/.exec(out)?.[1];
            if (adapters === undefined) return "inconclusive:the confined program could not list its network adapters";
            if (adapters.trim() !== "") return `the confined program has a network adapter that is up (${adapters.trim()})`;
            return undefined;
          }
          const ifaces = /ifaces=([^\n]*)/.exec(out)?.[1];
          if (ifaces !== undefined && ifaces !== "lo,") return `the confined program sees a network interface besides loopback (${ifaces})`;
          return undefined;
        },
        host: () => (fixture.connections() === before ? undefined : "the host service received a connection from the confined program"),
        proof: () => (fixture.connections() > before ? undefined : "the host service saw no connection"),
      };
    } });

    // Protected names under the checkout.
    await record({ id: "deny-write-protected-name", make: (r) => {
      const gitDir = join(r.workdir, ".git");
      mkdirSync(gitDir);
      writeFileSync(join(gitDir, "config"), GIT_ORIGINAL);
      return {
        script: win
          ? `(echo changed> "%CD%\\.git\\config") 2>nul\n(type nul > "%CD%\\.git\\g05-hook") 2>nul\n(del /f /q "%CD%\\.git\\config") 2>nul\necho ${END}`
          : `( echo changed > "$PWD/.git/config" ) 2>/dev/null; ( : > "$PWD/.git/g05-hook" ) 2>/dev/null; ( rm -rf "$PWD/.git/config" ) 2>/dev/null; echo ${END}`,
        judge: none,
        host: () => (same(join(gitDir, "config"), GIT_ORIGINAL) && !existsSync(join(gitDir, "g05-hook")) ? undefined : "a protected name under the checkout was changed"),
        proof: () => (same(join(gitDir, "config"), GIT_ORIGINAL) ? ".git/config was not changed" : existsSync(join(gitDir, "g05-hook")) ? undefined : ".git/g05-hook was not created"),
      };
    } });

    // The documented exception: a trusted-host run is not confined, and only an owner-configured authority permits it.
    let trustedHost: TrustedHostException | undefined;
    try {
      fixture.reset();
      const refusing = await SandboxLauncher.create({ protectedPaths: [fixture.controllerDir], audit: () => undefined });
      const refused = await refusing.launch({ recipe: { ...recipeOf(), mode: "trusted-host" }, command: nodeWin ? [options.nodeExecutable ?? process.execPath, "-e", "0"] : win ? [win32.join(WIN_ROOT, "System32", "cmd.exe"), "/d", "/c", "exit 0"] : ["/bin/true"], timeoutMs, maxOutputBytes: 100 }).then(async (run) => { await run.result; return false; }, (e: unknown) => (e as { code?: string }).code === "not_authorized");
      if (unconfined === undefined) throw new Error("no trusted-host launcher");
      const exceptionRecipe = { ...recipeOf(), mode: "trusted-host" as const };
      const run = await unconfined.launch({ recipe: exceptionRecipe, command: nodeWin ? [options.nodeExecutable ?? process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", fixture.outsideFile] : commandOf(exceptionRecipe, win ? `type ${wq(fixture.outsideFile)}` : `cat ${quote(fixture.outsideFile)}`), timeoutMs, maxOutputBytes: 1000 });
      const out = await run.result;
      trustedHost = { mode: "trusted-host", authority, reachesHostFiles: out.stdout.includes(OUTSIDE_ORIGINAL), refusedWithoutAuthority: refused };
    } catch { /* the exception is recorded only when it could be shown */ }
    return { capacity, cases: results, trustedHost };
  } finally {
    if (originalHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = originalHome;
    await fixture.close();
  }
}

/** The Windows Sandbox variant (superseded, a virtual machine) keeps the earlier statement; every other Windows backend is the native process-level launcher, weaker than Linux's. */
const WINDOWS_SANDBOX_BACKEND = "windows-sandbox";
/** Whether a report for this platform and backend must state that its boundary is weaker than Linux's: macOS and the native Windows launcher yes; Linux and the Windows Sandbox variant no. */
export function statesWeakerBoundary(platform: string, backend: string): boolean {
  return platform === "darwin" || (platform === "win32" && backend !== WINDOWS_SANDBOX_BACKEND);
}

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function macosProductVersion(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try { return execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 5000 }).trim(); } catch { return undefined; }
}

/**
 * Where the evidence's code came from, when it is not a git checkout: the prebuilt owner bundle (card A03b, `containment-evidence.mjs run --prebuilt`) carries the commit CI built it from in a COMMIT file
 * and has no git and no working tree, so it is never dirty in the git sense (its files are checked against the bundle's SHA256SUMS before anything runs).
 */
export interface ReportProvenance {
  readonly implementationCommit: string;
  readonly dirty: boolean;
}

/**
 * Runs the suite here and wraps it in a report bound to the checkout's commit. `repo` is a directory inside the checkout the evidence is about. With `provenance` the commit and the dirty flag are
 * taken from it and git is never run (a malformed commit is refused before any case runs).
 */
export async function produceReport(repo: string, options: SuiteOptions = {}, provenance?: ReportProvenance): Promise<ContainmentReport> {
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") throw new Error(`no containment evidence is defined for ${platform}`);
  if (provenance !== undefined && (typeof provenance.implementationCommit !== "string" || !COMMIT.test(provenance.implementationCommit) || typeof provenance.dirty !== "boolean")) {
    throw new Error("provenance: implementationCommit must be 40 lower-case hex digits and dirty true or false");
  }
  const commit = provenance === undefined ? git(repo, "rev-parse", "HEAD") : provenance.implementationCommit;
  const dirty = provenance === undefined ? git(repo, "status", "--porcelain").length > 0 : provenance.dirty;
  // Windows: the backend is the native launcher (windowsEvidenceBackend, card A03b), configured from the environment of the administrator's install step; the cases are the node runner's
  // (containment-windows-cases.ts). Where the launcher is not installed every case is reported not_run with that reason.
  const suite = await runContainmentSuite(platform === "win32" && options.launcher === undefined && options.backend === undefined ? { ...options, backend: windowsEvidenceBackend(process.env) } : options);
  const macos = macosProductVersion();
  return {
    schema: CONTAINMENT_SCHEMA, generatedAt: new Date().toISOString(), implementationCommit: commit, dirty, platform, arch: osArch(), osVersion: osRelease(),
    ...(macos === undefined ? {} : { macosVersion: macos }),
    backend: suite.capacity.backend ?? "none", ...(suite.capacity.version === undefined ? {} : { backendVersion: suite.capacity.version }),
    capacityAvailable: suite.capacity.available, ...(suite.capacity.reason === undefined ? {} : { capacityReason: short(suite.capacity.reason) }),
    weakerThanLinux: statesWeakerBoundary(platform, suite.capacity.backend ?? "none"), cases: suite.cases, ...(suite.trustedHost === undefined ? {} : { trustedHost: suite.trustedHost }),
  };
}

/**
 * The exit status of `containment-evidence.mjs run`: 0 only when there was capacity, every case passed and the trusted-host exception was shown. With `allowUnavailable` (a CI cell
 * that cannot run this OS's sandbox at all, such as a GitHub-hosted Windows runner without the native launcher installed), a Windows run with NO capacity exits 0 as an honest skip: the report
 * still says `not_run` for every case and the release gate still blocks on it. A Linux or macOS report never skips. A run that had capacity is judged in full either way.
 */
export function runOutcome(report: ContainmentReport, options: { readonly allowUnavailable?: boolean } = {}): { readonly exitCode: 0 | 1; readonly skipped: boolean } {
  // Only a Windows report may skip: Linux (bubblewrap) and macOS (Seatbelt) hosted runners can run their sandbox, so no capacity there is a failure even with the flag.
  if (!report.capacityAvailable) return { exitCode: options.allowUnavailable === true && report.platform === "win32" ? 0 : 1, skipped: true };
  const exception = report.trustedHost !== undefined && report.trustedHost.refusedWithoutAuthority && report.trustedHost.reachesHostFiles;
  const allHeld = report.cases.length > 0 && report.cases.every((c) => c.verdict === "pass");
  return { exitCode: allHeld && exception ? 0 : 1, skipped: false };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The release gate.

export const MAX_REPORT_BYTES = 256 * 1024;
export const MAX_REPORT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CASES = 64;
const COMMIT = /^[0-9a-f]{40}$/;
const VERDICTS: readonly Verdict[] = ["pass", "fail", "inconclusive", "not_run"];
const PHASES = ["launch", "exec", "results", "teardown"] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Control characters and bidirectional overrides are refused: report text is printed into release logs and terminals, where they could hide or rewrite a line. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const str = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max && !UNPRINTABLE.test(v);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const bool = (v: unknown): v is boolean => typeof v === "boolean";
const phases = (v: unknown): boolean => isObject(v) && PHASES.every((k) => bool(v[k]));

const SHA256 = /^[0-9a-f]{64}$/;
/** The shape of the native Windows block, every field required (a missing field is malformed, not "not measured": the producer writes `not-measured` or `null` itself). */
export function isNativeWindowsEvidence(n: unknown): n is NativeWindowsEvidence {
  if (!isObject(n)) return false;
  const l = n["launcher"], p = n["profiles"], wd = n["packagedControllerWorkingDirectory"];
  return isObject(l) && typeof l["recordCommit"] === "string" && COMMIT.test(l["recordCommit"]) && typeof l["recordSha256"] === "string" && SHA256.test(l["recordSha256"])
    && typeof l["fileSha256"] === "string" && SHA256.test(l["fileSha256"])
    && bool(n["elevated"]) && (n["accountKind"] === "standard" || n["accountKind"] === "administrator-filtered" || n["accountKind"] === "not-measured")
    && Number.isSafeInteger(n["sessionId"]) && (n["sessionId"] as number) >= 0 && (n["sessionId"] as number) <= 0xffff
    && str(n["windowStation"], 40) && bool(n["windowStationOk"])
    && isObject(p) && bool(p["created"]) && bool(p["deleted"]) && bool(p["gone"]) && (p["leftover"] === null || (Number.isSafeInteger(p["leftover"]) && (p["leftover"] as number) >= 0))
    && (n["grantsReadBack"] === "clean" || n["grantsReadBack"] === "left" || n["grantsReadBack"] === "not-measured")
    && (n["symlinkRight"] === null || bool(n["symlinkRight"]))
    && isObject(wd) && bool(wd["packaged"]) && bool(wd["passed"])
    && (n["supervisorAclCheck"] === "strict" || n["supervisorAclCheck"] === "report-only" || n["supervisorAclCheck"] === "not-run");
}

/** The two cases that plant FILE symbolic links (besides directory junctions), and the file links they plant (containment-windows-cases.ts). */
const FILE_LINK_CASES = new Set(["deny-symlink-read", "deny-symlink-write"]);
/**
 * The one inconclusive a native Windows report may carry: the host could not plant a FILE symbolic link (an account without SeCreateSymbolicLinkPrivilege), so the unconfined pairing was skipped and the
 * case could not be judged. Exactly the suite's own wording, naming a file link (a junction needs no privilege, so a junction not planted is never excused).
 */
const LINK_RIGHT_INCONCLUSIVE = /^without the sandbox the same attempt did not get through \((link-abs-file|link-rel-key|link-write): skipped not-planted\), so a refusal would prove nothing$/;
export const isLinkRightInconclusive = (c: CaseResult): boolean => FILE_LINK_CASES.has(c.id) && c.verdict === "inconclusive" && LINK_RIGHT_INCONCLUSIVE.test(c.detail);

/** Checks the shape of one report read from a file. Returns the report or the reason it is not one. Nothing in a report is trusted before this. */
export function parseReport(raw: string): { report: ContainmentReport } | { error: string } {
  if (Buffer.byteLength(raw, "utf8") > MAX_REPORT_BYTES) return { error: `a report is at most ${MAX_REPORT_BYTES} bytes` };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { error: "the report is not JSON" }; }
  if (!isObject(v) || v["schema"] !== CONTAINMENT_SCHEMA) return { error: "not a containment report (schema)" };
  if (!str(v["generatedAt"], 40) || !ISO_TIME.test(v["generatedAt"]) || !Number.isFinite(Date.parse(v["generatedAt"]))) return { error: "generatedAt: an ISO time" };
  if (typeof v["implementationCommit"] !== "string" || !COMMIT.test(v["implementationCommit"])) return { error: "implementationCommit: 40 hex digits" };
  if (!bool(v["dirty"])) return { error: "dirty: true or false" };
  if (v["platform"] !== "linux" && v["platform"] !== "darwin" && v["platform"] !== "win32") return { error: "platform: linux, darwin or win32" };
  if (!str(v["arch"], 40) || !str(v["osVersion"], 100) || !str(v["backend"], 100)) return { error: "arch, osVersion and backend: short text" };
  for (const k of ["macosVersion", "backendVersion", "capacityReason"]) if (v[k] !== undefined && !str(v[k])) return { error: `${k}: short text` };
  if (!bool(v["capacityAvailable"]) || !bool(v["weakerThanLinux"])) return { error: "capacityAvailable and weakerThanLinux: true or false" };
  if (!Array.isArray(v["cases"]) || v["cases"].length > MAX_CASES) return { error: `cases: a list of at most ${MAX_CASES}` };
  for (const c of v["cases"] as unknown[]) {
    if (!isObject(c) || !str(c["id"], 100) || !str(c["detail"], 400) || !VERDICTS.includes(c["verdict"] as Verdict) || !str(c["category"], 40)) return { error: "a case needs id, category, verdict and detail" };
  }
  const t = v["trustedHost"];
  if (t !== undefined && !(isObject(t) && t["mode"] === "trusted-host" && str(t["authority"]) && bool(t["reachesHostFiles"]) && bool(t["refusedWithoutAuthority"]))) return { error: "trustedHost: mode, authority, reachesHostFiles, refusedWithoutAuthority" };
  const w = v["windows"];
  if (w !== undefined) {
    const id = isObject(w) ? w["serviceIdentity"] : undefined;
    const acl = isObject(w) ? w["mappedOutputAcl"] : undefined;
    const wd = isObject(w) ? w["packagedControllerWorkingDirectory"] : undefined;
    if (!isObject(w) || !isObject(id) || !str(id["account"], 200) || (id["session"] !== "service" && id["session"] !== "interactive") || !phases(w["afterLogout"]) || !phases(w["afterReboot"])
      || !isObject(acl) || !bool(acl["positive"]) || !bool(acl["negative"]) || !isObject(wd) || !bool(wd["packaged"]) || !bool(wd["passed"])
      || (w["supervisorAclCheck"] !== "strict" && w["supervisorAclCheck"] !== "report-only") || (w["featureEnabledOnly"] !== undefined && !bool(w["featureEnabledOnly"]))) return { error: "windows: incomplete or malformed evidence" };
  }
  const n = v["nativeWindows"];
  if (n !== undefined && !isNativeWindowsEvidence(n)) return { error: "nativeWindows: incomplete or malformed evidence" };
  return { report: v as unknown as ContainmentReport };
}

export interface GateOptions {
  /** The commit the release is built from. Evidence about any other commit is refused (a replayed report of an earlier build proves nothing about this one). */
  readonly commit: string;
  readonly now?: Date;
  readonly platforms?: readonly PlatformName[];
}

export interface GateResult {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  /** Per required platform: whether its report satisfied every check. */
  readonly platforms: Readonly<Record<string, boolean>>;
  /** What was accepted although it is not a pass (card A03b: a file-link case inconclusive for want of the symbolic-link right), so a release log shows it. Never a blocker. */
  readonly accepted: readonly string[];
}

/**
 * The native Windows block's requirements (card A03b, owner decision 2026-11-26), each a separate problem. `commit` is the report's own commit, already compared with the release commit by the caller.
 * Not required in this slice: a run attempted after the owner signs out is refused cleanly and leaves nothing (the hold / sign-out step is still open).
 */
function nativeWindowsProblems(n: NativeWindowsEvidence, commit: string): string[] {
  const problems: string[] = [];
  if (n.launcher.recordCommit !== commit) problems.push(`the launcher's release record is for commit ${n.launcher.recordCommit.slice(0, 12)}, not the evidence's ${commit.slice(0, 12)}`);
  if (n.launcher.fileSha256 !== n.launcher.recordSha256) problems.push("the launcher that ran does not match its release record (SHA-256)");
  if (n.elevated) problems.push("the Windows run was elevated; the evidence must come from a token that is not elevated");
  if (n.accountKind === "not-measured") problems.push("the kind of account the run was made as (standard user or administrator with a filtered token) is not recorded");
  if (n.sessionId === 0) problems.push("the Windows run was in the services session (session 0), not a signed-in user's interactive session; unattended service mode is not supported in this release");
  if (n.windowStation !== "private" && n.windowStation !== "home-desktop") problems.push(`the window-object mode ${JSON.stringify(n.windowStation)} is not one this launcher knows (private or home-desktop)`);
  if (!n.windowStationOk) problems.push("the launcher could not make the container's window objects (windowStationOk is false)");
  if (!n.profiles.created) problems.push("the launcher's info did not create its throw-away container profile");
  if (!n.profiles.deleted || !n.profiles.gone) problems.push("the launcher's info did not delete its throw-away container profile and find it gone");
  if (n.profiles.leftover === null) problems.push(`the ${RUN_PROFILE_PREFIX}* container profiles left after the run were not counted`);
  else if (n.profiles.leftover !== 0) problems.push(`${n.profiles.leftover} ${RUN_PROFILE_PREFIX}* container profile(s) were left after the run`);
  if (n.grantsReadBack === "not-measured") problems.push("the grants' read-back after each run is not recorded");
  else if (n.grantsReadBack !== "clean") problems.push("a grant for the container was still present after a run (read-back not clean)");
  if (!n.packagedControllerWorkingDirectory.packaged) problems.push("the controller working-directory check was not run on the packaged controller");
  else if (!n.packagedControllerWorkingDirectory.passed) problems.push("the packaged controller working-directory check failed");
  if (n.supervisorAclCheck !== "strict") problems.push(`the supervisor-ACL check was ${n.supervisorAclCheck}; the strict check is required before release`);
  return problems;
}

/** Says what still blocks a release. Pure: it reads only the reports it is given. Exactly one report per platform counts (two for one platform is itself a blocker, since the better could hide the worse). */
export function assessRelease(reports: readonly ContainmentReport[], options: GateOptions): GateResult {
  const blockers: string[] = [];
  const now = (options.now ?? new Date()).getTime();
  const required = options.platforms ?? REQUIRED_PLATFORMS;
  if (typeof options.commit !== "string" || !COMMIT.test(options.commit)) return { ok: false, blockers: ["the release commit must be 40 hex digits"], platforms: {}, accepted: [] };
  if (!Number.isFinite(now)) return { ok: false, blockers: ["the gate's clock is not a valid time"], platforms: {}, accepted: [] };
  if (required.length === 0) return { ok: false, blockers: ["no platform is required: an empty platform list proves nothing"], platforms: {}, accepted: [] };
  const platforms: Record<string, boolean> = {};
  const accepted: string[] = [];
  for (const platform of required) {
    const mine = reports.filter((r) => r.platform === platform);
    const problems: string[] = [];
    if (mine.length === 0) problems.push("no report");
    else if (mine.length > 1) problems.push(`${mine.length} reports (exactly one is accepted)`);
    else {
      const r = mine[0]!;
      if (r.implementationCommit !== options.commit) problems.push(`the evidence is for commit ${r.implementationCommit.slice(0, 12)}, not ${options.commit.slice(0, 12)}`);
      if (r.dirty) problems.push("the evidence was produced from a working tree with uncommitted changes");
      const age = now - Date.parse(r.generatedAt);
      if (!Number.isFinite(age)) problems.push("the report's time is not a valid time");
      else if (age < -5 * 60 * 1000) problems.push("the report is dated in the future");
      else if (age > MAX_REPORT_AGE_MS) problems.push("the report is more than 30 days old");
      if (!r.capacityAvailable) problems.push(`the backend gave no capacity${r.capacityReason === undefined ? "" : ` (${r.capacityReason})`}`);
      const seen = new Set<string>();
      for (const c of r.cases) {
        if (seen.has(c.id)) problems.push(`case ${c.id} appears twice`);
        seen.add(c.id);
      }
      for (const id of REQUIRED_CASE_IDS) {
        const c = r.cases.find((x) => x.id === id);
        if (c === undefined) problems.push(`case ${id} is missing`);
        else if (c.verdict === "pass") continue;
        else if (platform === "win32" && isLinkRightInconclusive(c)) {
          // Card A03b (owner decision 2026-11-26): acceptable only when the run recorded that the account lacks the symbolic-link right. Recorded as accepted, never as a pass.
          if (r.nativeWindows?.symlinkRight === false) accepted.push(`${platform}: case ${id} inconclusive, accepted: the account lacks SeCreateSymbolicLinkPrivilege, so the file link was not planted and the case (its junction attempts included) was not judged`);
          else problems.push(`case ${id}: inconclusive (${c.detail}); a file link not planted is accepted only when the run recorded that the account lacks SeCreateSymbolicLinkPrivilege`);
        } else problems.push(`case ${id}: ${c.verdict}${c.detail === "" ? "" : ` (${c.detail})`}`);
      }
      if (r.trustedHost === undefined) problems.push("the trusted-host exception is not recorded");
      else {
        if (!r.trustedHost.refusedWithoutAuthority) problems.push("trusted-host mode was not refused without an owner-configured authority");
        if (!r.trustedHost.reachesHostFiles) problems.push("the trusted-host exception was not shown (it must be recorded as unconfined)");
      }
      if (platform === "darwin") {
        if (r.macosVersion === undefined || r.macosVersion.trim() === "") problems.push("the macOS version the boundary was proven on is not recorded");
        if (!r.weakerThanLinux) problems.push("the report does not state that the macOS boundary is weaker than Linux's");
      } else if (platform === "win32") {
        // Card A03b (owner decision 2026-11-26): only the native AppContainer launcher's evidence counts on Windows; Windows Sandbox is not used.
        if (r.backend !== NATIVE_BACKEND) problems.push(`the Windows evidence is from backend ${r.backend}; only the native AppContainer launcher (${NATIVE_BACKEND}) counts`);
        else if (!r.weakerThanLinux) problems.push("the report does not state that the native Windows boundary is process-level and weaker than Linux's");
      } else if (r.weakerThanLinux) problems.push("only a macOS or native Windows report may claim the weaker boundary");
      if (platform === "win32") {
        if (r.windows !== undefined) problems.push("the report carries the Windows Sandbox era evidence block (windows), which is not AppContainer evidence and is no longer accepted");
        const n = r.nativeWindows;
        if (n === undefined) problems.push("the native Windows host evidence is missing (launcher release record, elevation, account, session, window station, profiles, grant read-back)");
        else problems.push(...nativeWindowsProblems(n, r.implementationCommit));
      } else {
        if (r.windows !== undefined) problems.push("Windows evidence in a non-Windows report");
        if (r.nativeWindows !== undefined) problems.push("native Windows evidence in a non-Windows report");
      }
    }
    platforms[platform] = problems.length === 0;
    for (const p of problems) blockers.push(`${platform}: ${p}`);
  }
  return { ok: blockers.length === 0, blockers, platforms, accepted: blockers.length === 0 ? accepted : [] };
}

/** Digest of a report file, for the evidence index. */
export const reportDigest = (raw: string): string => createHash("sha256").update(raw).digest("hex");

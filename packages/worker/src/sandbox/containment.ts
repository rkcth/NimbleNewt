import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { arch as osArch, release as osRelease, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxLauncher } from "./launcher.js";
import { GUEST, type SandboxRecipe } from "./recipe.js";

/*
 * Card G05: proof of the selected isolation boundary on each OS. This file is two things.
 *
 * 1. A fixture and a case list (`runContainmentSuite`) that start REAL processes through the production `SandboxLauncher` (never a model of it) and try to write outside the workspace, escape
 *    through links, read credentials, reach the network and change protected names. Every verdict is decided from the host side (a file that must not change, a server that must not be reached),
 *    not from what the confined program prints. The suite also runs positive controls (the same attempts on the agent's own directories succeed) so a denial cannot be a broken probe.
 * 2. A release gate (`assessRelease`) that reads the reports of the platforms and says what still blocks a release: a missing platform, a failed or missing case, evidence about another commit,
 *    and the evidence only a real Windows host can give (the unattended service identity after logout and reboot, the mapped-output ACL controls, the packaged controller working directory,
 *    the strict supervisor-ACL check). Evidence from an interactive session or from "the feature is switched on" never satisfies it.
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
  /** Stated, not measured: the macOS boundary is process-level and weaker than Linux's (denied paths stay visible, no private process list, no private view of the filesystem). */
  readonly weakerThanLinux: boolean;
  readonly cases: readonly CaseResult[];
  readonly trustedHost?: TrustedHostException;
  readonly windows?: WindowsEvidence;
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
  close(): Promise<void>;
}

async function buildFixture(): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-g05-")));
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
  return { root, controllerDir, controllerFile, home, credentialFile, outsideDir, outsideFile, server, port, connections: () => connections, close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); } };
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const short = (s: string): string => (s.length > 300 ? `${s.slice(0, 300)}...` : s).replace(/[\r\n]+/g, " ");

interface Attempt {
  readonly recipe: SandboxRecipe;
  readonly script: string;
  /** Judges what the program printed: a failure reason, `inconclusive:<why>`, or undefined when the case holds. */
  readonly judge: (out: string) => string | undefined;
}

export interface SuiteOptions {
  /** The launcher under test. Default: a production launcher for this platform. */
  readonly launcher?: SandboxLauncher;
  readonly timeoutMs?: number;
}

/**
 * Runs every case through the launcher and returns the verdicts. The launcher defaults to the production one for this OS (never a stand-in); a test may pass one built on another backend to show that the cases can fail.
 * The service user's HOME is pointed at the fixture for the duration (the launcher protects the credential places under it).
 */
export async function runContainmentSuite(options: SuiteOptions = {}): Promise<{ capacity: SandboxLauncher["capacity"]; cases: CaseResult[]; trustedHost: TrustedHostException | undefined }> {
  const fixture = await buildFixture();
  const originalHome = process.env["HOME"];
  process.env["HOME"] = fixture.home;
  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    const launcher = options.launcher ?? await SandboxLauncher.create({ protectedPaths: [fixture.controllerDir], audit: () => undefined });
    const capacity = launcher.capacity;
    if (!capacity.available) return { capacity, cases: REQUIRED_CASE_IDS.map((id) => ({ id, category: CATEGORY[id]!, verdict: "not_run" as const, detail: `no capacity: ${capacity.reason ?? "unavailable"}` })), trustedHost: undefined };
    const linuxView = capacity.backend === "bubblewrap";
    let n = 0;
    const recipeOf = (): SandboxRecipe => {
      n += 1;
      const base = join(fixture.root, `agent${n}`);
      const d = (name: string): string => { const p = join(base, name); mkdirSync(p, { recursive: true }); return p; };
      return { mode: "sandboxed", workdir: d("work"), home: d("home"), scratch: d("scratch"), readOnly: [], network: "none", env: {}, protectedSubpaths: [".git"] };
    };
    const results: CaseResult[] = [];
    const record = async (id: string, attempt: Attempt, host: (out: string) => string | undefined): Promise<void> => {
      const category = CATEGORY[id]!;
      try {
        const run = await launcher.launch({ recipe: attempt.recipe, command: ["/bin/sh", "-c", attempt.script], timeoutMs, maxOutputBytes: 200_000 });
        const result = await run.result;
        const out = `${result.stdout}\n${result.stderr}`;
        let problem: string | undefined;
        if (result.timedOut) problem = "inconclusive:the attempt timed out";
        else if (!out.includes(END)) problem = `inconclusive:the attempt did not reach its end marker (${short(out)})`;
        else problem = attempt.judge(out) ?? host(out);
        if (problem === undefined) results.push({ id, category, verdict: "pass", detail: "held" });
        else if (problem.startsWith("inconclusive:")) results.push({ id, category, verdict: "inconclusive", detail: short(problem.slice("inconclusive:".length)) });
        else results.push({ id, category, verdict: "fail", detail: short(problem) });
      } catch (error) {
        results.push({ id, category, verdict: "inconclusive", detail: short(`the attempt could not be launched: ${(error as Error).message}`) });
      }
    };
    const leaked = (out: string, ...secrets: string[]): string | undefined => (secrets.some((x) => out.includes(x)) ? "the confined program printed protected content" : undefined);
    const same = (file: string, expected: string): boolean => existsSync(file) && readFileSync(file, "utf8") === expected;
    const none = (): undefined => undefined;

    // Controls: what the agent is allowed to do works. Without these a denial could be a probe that never ran.
    {
      const r = recipeOf();
      const scratchGuest = linuxView ? GUEST.scratch : r.scratch;
      await record("control-write-own-directories", { recipe: r, script: `echo w > "$PWD/c-work"; echo h > "$HOME/c-home"; echo s > ${quote(scratchGuest)}/c-scratch; echo ${END}`, judge: none }, () =>
        existsSync(join(r.workdir, "c-work")) && existsSync(join(r.home, "c-home")) && existsSync(join(r.scratch, "c-scratch")) ? undefined : "the agent could not write its own directories");
    }
    {
      const r = recipeOf();
      writeFileSync(join(r.workdir, "decoy.txt"), OWN_DECOY);
      await record("control-read-own-decoy", { recipe: r, script: `cat "$PWD/decoy.txt"; echo; echo ${END}`, judge: (out) => (out.includes(OWN_DECOY) ? undefined : "the agent could not read its own file") }, none);
    }

    // Writes outside the workspace.
    {
      const r = recipeOf();
      const sys = ["/usr/g05-x", "/etc/g05-x", "/bin/g05-x", "/g05-x"];
      await record("deny-write-system", { recipe: r, script: `for p in ${sys.join(" ")}; do ( : > "$p" ) 2>/dev/null; done; echo ${END}`, judge: none }, () => (sys.some((p) => existsSync(p)) ? "a file was created in a system directory of the host" : undefined));
    }
    {
      const r = recipeOf();
      const targets = [join(fixture.outsideDir, "g05-created"), join(fixture.controllerDir, "g05-created"), join(fixture.home, ".ssh", "g05-created")];
      await record("deny-write-host-path", { recipe: r, script: `( echo overwritten > ${quote(fixture.outsideFile)} ) 2>/dev/null; ${targets.map((t) => `( : > ${quote(t)} ) 2>/dev/null;`).join(" ")} echo ${END}`, judge: none }, () => {
        if (!same(fixture.outsideFile, OUTSIDE_ORIGINAL)) return "a host file outside the workspace was changed";
        if (targets.some((t) => existsSync(t))) return "a file was created in a host directory outside the workspace";
        return undefined;
      });
    }

    // Links in the checkout that lead out of it.
    {
      const r = recipeOf();
      symlinkSync(fixture.controllerFile, join(r.workdir, "link-abs-file"));
      symlinkSync(fixture.controllerDir, join(r.workdir, "link-abs-dir"));
      symlinkSync(`../../../../../../../../../../..${fixture.credentialFile}`, join(r.workdir, "link-rel-key"));
      symlinkSync("/proc/1/root", join(r.workdir, "link-proc-root"));
      await record("deny-symlink-read", { recipe: r, script: `cat "$PWD/link-abs-file" 2>/dev/null; ls "$PWD/link-abs-dir" 2>/dev/null; cat "$PWD/link-rel-key" 2>/dev/null; echo ${END}`, judge: (out) => leaked(out, SECRET_CONTROLLER, SECRET_KEY, "controller.db") }, none);
    }
    {
      const r = recipeOf();
      symlinkSync(fixture.outsideFile, join(r.workdir, "link-write"));
      symlinkSync(fixture.outsideDir, join(r.workdir, "link-dir"));
      await record("deny-symlink-write", { recipe: r, script: `( echo overwritten > "$PWD/link-write" ) 2>/dev/null; ( : > "$PWD/link-dir/g05-via-link" ) 2>/dev/null; echo ${END}`, judge: none }, () =>
        !same(fixture.outsideFile, OUTSIDE_ORIGINAL) || existsSync(join(fixture.outsideDir, "g05-via-link")) ? "a write through a link changed a host path outside the workspace" : undefined);
    }

    // Credentials and the controller's own data.
    {
      const r = recipeOf();
      await record("deny-credential-read", { recipe: r, script: `cat ${quote(fixture.credentialFile)} 2>/dev/null; ls ${quote(join(fixture.home, ".ssh"))} 2>/dev/null; env; echo ${END}`, judge: (out) => leaked(out, SECRET_KEY, "id_g05_fixture") }, none);
    }
    {
      const r = recipeOf();
      await record("deny-controller-data-read", { recipe: r, script: `cat ${quote(fixture.controllerFile)} 2>/dev/null; ls ${quote(fixture.controllerDir)} 2>/dev/null; echo ${END}`, judge: (out) => leaked(out, SECRET_CONTROLLER, "controller.db") }, none);
    }

    // The network: nothing leaves the sandbox. The host's loopback server is the witness.
    {
      const r = recipeOf();
      const before = fixture.connections();
      const probe = `tried=0; if command -v nc >/dev/null 2>&1; then tried=1; nc -z -w 2 127.0.0.1 ${fixture.port} && echo CONNECTED-NC; fi; if command -v bash >/dev/null 2>&1; then tried=1; bash -c 'exec 3<>/dev/tcp/127.0.0.1/${fixture.port}' 2>/dev/null && echo CONNECTED-BASH; fi; echo tried=$tried; if [ -r /proc/net/dev ]; then echo ifaces=$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\\n' ,); fi; echo ${END}`;
      await record("deny-network-loopback", { recipe: r, script: probe, judge: (out) => {
        if (!out.includes("tried=1")) return "inconclusive:no tool (nc or bash) was available to attempt a connection";
        if (/CONNECTED-/.test(out)) return "the confined program connected to a host service";
        const ifaces = /ifaces=([^\n]*)/.exec(out)?.[1];
        if (ifaces !== undefined && ifaces !== "lo,") return `the confined program sees a network interface besides loopback (${ifaces})`;
        return undefined;
      } }, () => (fixture.connections() === before ? undefined : "the host service received a connection from the confined program"));
    }

    // Protected names under the checkout.
    {
      const r = recipeOf();
      const gitDir = join(r.workdir, ".git");
      mkdirSync(gitDir);
      writeFileSync(join(gitDir, "config"), GIT_ORIGINAL);
      await record("deny-write-protected-name", { recipe: r, script: `( echo changed > "$PWD/.git/config" ) 2>/dev/null; ( : > "$PWD/.git/g05-hook" ) 2>/dev/null; ( rm -rf "$PWD/.git/config" ) 2>/dev/null; echo ${END}`, judge: none }, () =>
        same(join(gitDir, "config"), GIT_ORIGINAL) && !existsSync(join(gitDir, "g05-hook")) ? undefined : "a protected name under the checkout was changed");
    }

    // The documented exception: a trusted-host run is not confined, and only an owner-configured authority permits it.
    let trustedHost: TrustedHostException | undefined;
    try {
      const authority = "G05 containment evidence (the suite's own test authority)";
      const refusing = await SandboxLauncher.create({ protectedPaths: [fixture.controllerDir], audit: () => undefined });
      const refused = await refusing.launch({ recipe: { ...recipeOf(), mode: "trusted-host" }, command: ["/bin/true"], timeoutMs, maxOutputBytes: 100 }).then(() => false, (e: unknown) => (e as { code?: string }).code === "not_authorized");
      const host = await SandboxLauncher.create({ protectedPaths: [fixture.controllerDir], trustedHost: { authority }, audit: () => undefined });
      const run = await host.launch({ recipe: { ...recipeOf(), mode: "trusted-host" }, command: ["/bin/sh", "-c", `cat ${quote(fixture.outsideFile)}`], timeoutMs, maxOutputBytes: 1000 });
      const out = await run.result;
      trustedHost = { mode: "trusted-host", authority, reachesHostFiles: out.stdout.includes(OUTSIDE_ORIGINAL), refusedWithoutAuthority: refused };
    } catch { /* the exception is recorded only when it could be shown */ }
    return { capacity, cases: results, trustedHost };
  } finally {
    if (originalHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = originalHome;
    await fixture.close();
  }
}

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function macosProductVersion(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try { return execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 5000 }).trim(); } catch { return undefined; }
}

/** Runs the suite here and wraps it in a report bound to the checkout's commit. `repo` is a directory inside the checkout the evidence is about. */
export async function produceReport(repo: string, options: SuiteOptions = {}): Promise<ContainmentReport> {
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") throw new Error(`no containment evidence is defined for ${platform}`);
  const commit = git(repo, "rev-parse", "HEAD");
  const dirty = git(repo, "status", "--porcelain").length > 0;
  const suite = await runContainmentSuite(options);
  const macos = macosProductVersion();
  return {
    schema: CONTAINMENT_SCHEMA, generatedAt: new Date().toISOString(), implementationCommit: commit, dirty, platform, arch: osArch(), osVersion: osRelease(),
    ...(macos === undefined ? {} : { macosVersion: macos }),
    backend: suite.capacity.backend ?? "none", ...(suite.capacity.version === undefined ? {} : { backendVersion: suite.capacity.version }),
    capacityAvailable: suite.capacity.available, ...(suite.capacity.reason === undefined ? {} : { capacityReason: short(suite.capacity.reason) }),
    weakerThanLinux: platform === "darwin", cases: suite.cases, ...(suite.trustedHost === undefined ? {} : { trustedHost: suite.trustedHost }),
  };
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
const str = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max && !v.includes("\0");
const bool = (v: unknown): v is boolean => typeof v === "boolean";
const phases = (v: unknown): boolean => isObject(v) && PHASES.every((k) => bool(v[k]));

/** Checks the shape of one report read from a file. Returns the report or the reason it is not one. Nothing in a report is trusted before this. */
export function parseReport(raw: string): { report: ContainmentReport } | { error: string } {
  if (Buffer.byteLength(raw, "utf8") > MAX_REPORT_BYTES) return { error: `a report is at most ${MAX_REPORT_BYTES} bytes` };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { error: "the report is not JSON" }; }
  if (!isObject(v) || v["schema"] !== CONTAINMENT_SCHEMA) return { error: "not a containment report (schema)" };
  if (!str(v["generatedAt"], 40) || Number.isNaN(Date.parse(v["generatedAt"]))) return { error: "generatedAt: an ISO time" };
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
}

/** Says what still blocks a release. Pure: it reads only the reports it is given. Exactly one report per platform counts (two for one platform is itself a blocker, since the better could hide the worse). */
export function assessRelease(reports: readonly ContainmentReport[], options: GateOptions): GateResult {
  const blockers: string[] = [];
  const now = (options.now ?? new Date()).getTime();
  const required = options.platforms ?? REQUIRED_PLATFORMS;
  if (!COMMIT.test(options.commit)) return { ok: false, blockers: ["the release commit must be 40 hex digits"], platforms: {} };
  const platforms: Record<string, boolean> = {};
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
      if (age < -5 * 60 * 1000) problems.push("the report is dated in the future");
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
        else if (c.verdict !== "pass") problems.push(`case ${id}: ${c.verdict}${c.detail === "" ? "" : ` (${c.detail})`}`);
      }
      if (r.trustedHost === undefined) problems.push("the trusted-host exception is not recorded");
      else {
        if (!r.trustedHost.refusedWithoutAuthority) problems.push("trusted-host mode was not refused without an owner-configured authority");
        if (!r.trustedHost.reachesHostFiles) problems.push("the trusted-host exception was not shown (it must be recorded as unconfined)");
      }
      if (platform === "darwin") {
        if (r.macosVersion === undefined || r.macosVersion.trim() === "") problems.push("the macOS version the boundary was proven on is not recorded");
        if (!r.weakerThanLinux) problems.push("the report does not state that the macOS boundary is weaker than Linux's");
      } else if (r.weakerThanLinux) problems.push("only a macOS report may claim the weaker boundary");
      if (platform === "win32") {
        const w = r.windows;
        if (w === undefined) problems.push("the Windows host evidence is missing (unattended identity, mapped-output ACL, packaged working directory, strict supervisor ACL)");
        else {
          if (w.featureEnabledOnly === true) problems.push("the Windows evidence is the feature being enabled only");
          if (w.serviceIdentity.session !== "service") problems.push("the Windows run was in an interactive session, not under the unattended service identity");
          for (const [when, p] of [["after logout", w.afterLogout], ["after reboot", w.afterReboot]] as const) {
            for (const k of PHASES) if (!p[k]) problems.push(`Windows ${k} not proven ${when}`);
          }
          if (!w.mappedOutputAcl.positive) problems.push("the mapped-output ACL positive control did not pass");
          if (!w.mappedOutputAcl.negative) problems.push("the mapped-output ACL negative control did not pass");
          if (!w.packagedControllerWorkingDirectory.packaged) problems.push("the controller working-directory check was not run on the packaged controller");
          else if (!w.packagedControllerWorkingDirectory.passed) problems.push("the packaged controller working-directory check failed");
          if (w.supervisorAclCheck !== "strict") problems.push("the supervisor-ACL check was report-only; the strict check is required before release");
        }
      } else if (r.windows !== undefined) problems.push("Windows evidence in a non-Windows report");
    }
    platforms[platform] = problems.length === 0;
    for (const p of problems) blockers.push(`${platform}: ${p}`);
  }
  return { ok: blockers.length === 0, blockers, platforms };
}

/** Digest of a report file, for the evidence index. */
export const reportDigest = (raw: string): string => createHash("sha256").update(raw).digest("hex");

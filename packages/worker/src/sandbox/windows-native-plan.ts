import { win32 } from "node:path";
import { SandboxError } from "./errors.js";
import type { NormalizedRecipe } from "./recipe.js";
import { checkWindowsHostPath, foldWin, isWindowsDeviceName, overlapsWin } from "./windows-plan.js";

/*
 * Card A03b, the native Windows launcher: everything about how one launch becomes a launcher command line, with no operating-system call in it (so it runs, and is tested, on any OS).
 * The design rules come from the measured experiment (experiments/windows-appcontainer, rounds 3b and 4, hosted run 45525239392) and are listed in implementation-notes.md.
 * The launcher program itself (the Rust crate that makes the container) is still the experiment's `nn-appc-launcher`; this file speaks its measured command line.
 */

export const NATIVE_BACKEND_NAME = "windows-native";
/** What every audit and launch record says about the mode (the card's wording). */
export const NATIVE_MODE = "native process-level, weaker than Linux";
/** npm needs these (round 3b: without them node lstat()s `C:\` and the container is refused). */
export const NODE_PRESERVE_OPTIONS = "--preserve-symlinks --preserve-symlinks-main";
/** The less privileged kind of container (LPAC) with only these two capabilities passed every case in the round-4 hosted run; no network capability is ever listed. */
export const LPAC_CAPABILITIES: readonly string[] = Object.freeze(["registryRead", "lpacCom"]);
export const DEFAULT_PROFILE_NAME = "NimbleNewtAgent";
/** The measured job limits (round 4: with all limits set, files and inherited handles worked). */
export const DEFAULT_JOB_LIMITS = Object.freeze({ memoryMb: 4096, activeProcesses: 64 });
export const MAX_RUN_MS = 24 * 60 * 60 * 1000;

/** Exit codes of the runner when it, not the program, ended the launch (the program's own code is passed through otherwise). */
export const EXIT_REFUSED = 70;
export const EXIT_FAILED = 71;
export const EXIT_BUSY = 75;
/** The runner's first stderr line when it fails closed: `nn-native-failure: <kind>: <words>`. */
export const FAILURE_PREFIX = "nn-native-failure";

/** Why a launch was stopped before or after the program ran. Every kind is a typed reason, never a silent fallback. */
export type NativeFailure = "busy" | "filesystem" | "grant" | "container" | "job" | "files" | "start" | "launcher" | "revoke" | "refused" | "channel";

export type ContainerKind = "lpac" | "appcontainer";
export type GrantMode = "ro" | "rx" | "modify" | "modify-root" | "seal";

export interface NativeSettings {
  /** The launcher program the administrator's install step put in a protected folder. */
  readonly launcher: string;
  /** The supervisor's own folder: job files, records, the lock. Never granted to the container. */
  readonly controlDir: string;
  readonly nodeExecutable: string;
  /** Read-and-execute folders that are not the task's (the Node installation, the packages the worker loads). A refused one is recorded; the launch goes on. */
  readonly programFolders: readonly string[];
  readonly systemRoot: string;
  readonly container: ContainerKind;
  readonly profileName: string;
  readonly memoryMb: number;
  readonly activeProcesses: number;
  readonly maxRunMs: number;
}

export interface NativeGrant {
  readonly mode: GrantMode;
  readonly path: string;
  /** Only the read grants on program folders are soft. */
  readonly soft: boolean;
  readonly why: "workspace" | "home" | "scratch" | "input" | "protected" | "program";
}

const bad = (message: string): never => { throw new SandboxError("invalid_recipe", message); };

/** The variables the launcher sets itself, compared without regard to case (Windows names are case-insensitive). */
const OWN_ENV = new Set(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "PATH", "SYSTEMROOT", "WINDIR", "NPM_CONFIG_CACHE"]);

export const REFUSED_ROUTE = "route: the native Windows backend gives an agent no route out in this release (a proxy on the loopback would need a loopback exemption, which is never added); a task that needs the web or a local server waits for a Linux or macOS host";

/** A local absolute normalised path of a program or folder the supervisor reads (these may live in Program Files). */
export function checkProgramFolder(label: string, path: unknown): string {
  if (typeof path === "string" && /^[A-Za-z]:\\?$/.test(path)) return bad(`${label}: a drive root cannot be granted`);
  if (typeof path !== "string" || !/^[A-Za-z]:\\/.test(path) || win32.normalize(path) !== path || /[<>"|?*\u0000-\u001f]/.test(path) || path.endsWith("\\") || path.indexOf(":", 2) !== -1) return bad(`${label}: must be a local absolute normalised path such as C:\\dir\\sub: ${String(path)}`);
  // Windows drops a trailing dot or space and expands a short (8.3) name, so `C:\dir.` or `C:\PROGRA~1` names another folder than the text says, and the overlap checks (plain text comparisons) would miss it.
  if (path.split("\\").slice(1).some((s) => s === "" || s === "." || s === ".." || /~\d/.test(s) || /[. ]$/.test(s))) return bad(`${label}: no "..", trailing dot or space, or short-name (~1) part: ${path}`);
  if (path.split("\\").slice(1).some(isWindowsDeviceName)) return bad(`${label}: ${path} has a part Windows opens as a device (CON, NUL, COM1 and the like)`);
  return path;
}

export interface NativeFolders {
  /** Where the supervisor's own code and files live: nothing the container can write may contain or sit inside any of these. */
  readonly supervisor: readonly string[];
}

/**
 * Checks a recipe for the native backend and returns nothing: it throws a typed `invalid_recipe` refusal. A recipe with a route is refused here (the first release gives Windows agents no
 * route), every host folder is a local, normalised path and none overlaps another or the supervisor's own folders.
 */
export function checkNativeRecipe(recipe: NormalizedRecipe, settings: NativeSettings, supervisor: NativeFolders, env: (name: string) => string | undefined, isLink: (path: string) => boolean): void {
  if (recipe.mode !== "sandboxed") bad("the native backend runs sandboxed recipes only");
  if (recipe.route !== undefined) bad(REFUSED_ROUTE);
  if (recipe.network !== "none") bad(`network: only "none" is supported`);
  const writable: [string, string][] = [["workdir", checkWindowsHostPath("workdir", recipe.workdir, env)], ["home", checkWindowsHostPath("home", recipe.home, env)], ["scratch", checkWindowsHostPath("scratch", recipe.scratch, env)]];
  const inputs: [string, string][] = recipe.readOnly.map((m, i) => [`readOnly[${i}]`, checkProgramFolder(`readOnly[${i}].host`, m.host)]);
  const all = [...writable, ...inputs];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (overlapsWin(all[i]![1], all[j]![1])) bad(`${all[i]![0]} and ${all[j]![0]} overlap on the host (${all[i]![1]} and ${all[j]![1]})`);
  const guarded = [settings.controlDir, ...supervisor.supervisor];
  for (const [label, path] of all) {
    for (const g of guarded) if (overlapsWin(path, g)) bad(`${label} (${path}) overlaps the supervisor's own folder ${g}; the container may never reach it`);
    if (isLink(path)) bad(`${label}: ${path} is a link or junction; give the real path`);
  }
  // A sealed name gets a protected access list of its own, and the launcher sets it on the path as given, following a junction: one in the workspace would put the seal (and, at the revoke, the
  // inherited entries) on the folder it points to. The recipe check refused links when it was normalised; this is checked again at the plan.
  for (const name of recipe.protectedSubpaths) {
    if (recipe.unprotectedSubpaths.includes(name)) continue;
    if (isLink(`${recipe.workdir}\\${name}`)) bad(`protectedSubpaths: ${recipe.workdir}\\${name} is a link or junction; it cannot be sealed`);
  }
  for (const name of Object.keys(recipe.env)) {
    if (OWN_ENV.has(name.toUpperCase())) bad(`env: ${name} is set by the launcher`);
  }
  const lower = new Set<string>();
  for (const name of Object.keys(recipe.env)) { if (lower.has(name.toLowerCase())) bad(`env: ${name} is listed twice (Windows names ignore case)`); lower.add(name.toLowerCase()); }
}

/** Whether `path` is `dir` or lies inside it (case-insensitive, whole path segments). */
const insideOrSame = (path: string, dir: string): boolean => { const p = foldWin(path), d = foldWin(dir); return p === d || p.startsWith(d + "\\"); };

/**
 * Every folder the container is given, narrowest right first. The workspace is `modify-root` (modify without DELETE on the folder itself, so the agent cannot rename or delete the folder it runs in);
 * home and scratch are modify; read-only inputs are read-and-execute (hard); each protected name that exists under the workspace is sealed (a protected DACL with read-and-execute only, no reliance on a deny
 * entry); the program folders are soft read grants. Nothing else. A program folder that is, or lies inside, a grant already made is skipped (one entry is enough); one that contains a task folder or the
 * supervisor's folder is refused (a read grant would reach it).
 */
export function grantsFor(recipe: NormalizedRecipe, settings: NativeSettings, supervisor: NativeFolders): NativeGrant[] {
  const grants: NativeGrant[] = [
    { mode: "modify-root", path: recipe.workdir, soft: false, why: "workspace" },
    { mode: "modify", path: recipe.home, soft: false, why: "home" },
    { mode: "modify", path: recipe.scratch, soft: false, why: "scratch" },
    ...recipe.readOnly.map((m): NativeGrant => ({ mode: "rx", path: m.host, soft: false, why: "input" })),
  ];
  for (const name of recipe.protectedSubpaths) {
    if (recipe.unprotectedSubpaths.includes(name)) continue; // not there: the controller (A04) owns keeping it out; recorded in the launch record
    grants.push({ mode: "seal", path: `${recipe.workdir}\\${name}`, soft: false, why: "protected" });
  }
  const guarded = [settings.controlDir, ...supervisor.supervisor];
  const taskFolders = [recipe.workdir, recipe.home, recipe.scratch, ...recipe.readOnly.map((m) => m.host)];
  for (const folder of settings.programFolders) {
    checkProgramFolder("program folder", folder);
    for (const g of guarded) if (insideOrSame(g, folder)) bad(`program folder ${folder} contains the supervisor's own folder ${g}`);
    for (const t of taskFolders) if (insideOrSame(t, folder) && foldWin(t) !== foldWin(folder)) bad(`program folder ${folder} contains the task folder ${t}`);
    if (taskFolders.some((t) => insideOrSame(folder, t))) continue;
    if (grants.some((g) => g.why === "program" && insideOrSame(folder, g.path))) continue;
    grants.push({ mode: "rx", path: folder, soft: true, why: "program" });
  }
  return grants;
}

/**
 * The agent's program as a Windows path. A sandboxed command names its program as the sandbox sees it (the same POSIX names every backend takes): /work, /home/agent, /scratch, a read-only mount's guest
 * path (/inputs/..., /opt/...) or /windows (the system folder, which the container reads by the system's own rule). Anything else is refused.
 */
export function programPath(recipe: NormalizedRecipe, program: string, systemRoot: string): string {
  const segmentOk = (s: string): boolean => s.length > 0 && !/[<>:"|?*\\\u0000-\u001f]/.test(s) && !/[. ]$/.test(s) && s !== "." && s !== ".." && !/~\d/.test(s) && !isWindowsDeviceName(s);
  const roots: readonly (readonly [string, string])[] = [["/work", recipe.workdir], ["/home/agent", recipe.home], ["/scratch", recipe.scratch], ["/windows", systemRoot], ...recipe.readOnly.map((m) => [m.guest, m.host] as const)];
  let best: readonly [string, string] | undefined;
  for (const r of roots) if ((program === r[0] || program.startsWith(r[0] + "/")) && (best === undefined || r[0].length > best[0].length)) best = r;
  if (best === undefined) return bad(`command: the program must be under /work, /home/agent, /scratch, a read-only mount or /windows (as the sandbox sees paths): ${program}`);
  const rest = program === best[0] ? [] : program.slice(best[0].length + 1).split("/");
  if (!rest.every(segmentOk)) return bad(`command: the program path has a part Windows cannot take: ${program}`);
  return [best[1], ...rest].join("\\");
}

/** One argument the way CommandLineToArgvW and the C runtime read it back (backslashes before a quote are doubled). */
export function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") { backslashes++; continue; }
    if (ch === '"') { out += "\\".repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    out += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}
export const commandLine = (exe: string, args: readonly string[]): string => [exe, ...args].map(quoteWindowsArg).join(" ");

/**
 * The container's whole environment. Nothing is inherited: HOME, the profile folders, TEMP and the npm cache are inside the granted folders; PATH lists granted folders only (the program folders, the
 * read-only inputs that are folders, then the system's own folder, which the container reads by the system's rule); NODE_OPTIONS carries the preserve-symlinks flags for every node program the
 * agent starts (a recipe's own NODE_OPTIONS follows them). The recipe's own variables come last and never replace these.
 */
export function nativeEnv(recipe: NormalizedRecipe, settings: NativeSettings, inputIsFolder: (host: string) => boolean = () => true): Record<string, string> {
  const system32 = `${settings.systemRoot}\\System32`;
  const path = [...settings.programFolders, ...recipe.readOnly.map((m) => m.host).filter(inputIsFolder), system32].join(";");
  const recipeNodeOptions = Object.entries(recipe.env).find(([n]) => n.toUpperCase() === "NODE_OPTIONS")?.[1];
  const own: Record<string, string> = {
    HOME: recipe.home, USERPROFILE: recipe.home, APPDATA: recipe.home, LOCALAPPDATA: recipe.home,
    TEMP: recipe.scratch, TMP: recipe.scratch, TMPDIR: recipe.scratch,
    PATH: path, SystemRoot: settings.systemRoot, windir: settings.systemRoot,
    NODE_OPTIONS: recipeNodeOptions === undefined || recipeNodeOptions.trim() === "" ? NODE_PRESERVE_OPTIONS : `${NODE_PRESERVE_OPTIONS} ${recipeNodeOptions}`,
    npm_config_cache: `${recipe.scratch}\\.npm-cache`,
  };
  const env: Record<string, string> = { ...own };
  for (const [name, value] of Object.entries(recipe.env)) if (name.toUpperCase() !== "NODE_OPTIONS") env[name] = value;
  return env;
}

export interface RunFiles { readonly input: string; readonly out: string; readonly err: string }

/**
 * The launcher's argument list for one run (the experiment launcher's measured command line). Standard input is an empty (or the request's) FILE, standard output and error are FILES: never the NUL device
 * (the container cannot open it) and never a pipe made inside the container (every pipe start hung). The network has no entry at all: no capability and no loopback exemption.
 */
export function launcherArgs(recipe: NormalizedRecipe, exe: string, programArgs: readonly string[], settings: NativeSettings, grants: readonly NativeGrant[], files: RunFiles, env: Readonly<Record<string, string>>): string[] {
  const args = ["run", "--name", settings.profileName];
  for (const g of grants) args.push(g.soft ? "--grant-soft" : "--grant", `${g.mode}:${g.path}`);
  if (settings.container === "lpac") { args.push("--aap-policy", "optout"); for (const c of LPAC_CAPABILITIES) args.push("--capability", c); } else args.push("--aap-policy", "none");
  args.push("--memory-mb", String(settings.memoryMb), "--active-processes", String(settings.activeProcesses), "--ui-limits", "--timeout-ms", String(settings.maxRunMs));
  args.push("--stdin", `file:${files.input}`, "--stdout", files.out, "--stderr", files.err, "--cwd", recipe.workdir);
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  args.push("--exe", exe, "--cmdline", commandLine(exe, programArgs));
  return args;
}

/** The grants as the launcher's `revoke` and `check` commands take them (the modes matter: revoking a seal gives the folder its inheritance back). */
export function grantArgs(grants: readonly NativeGrant[]): string[] {
  const out: string[] = [];
  for (const g of grants) out.push("--grant", `${g.mode}:${g.path}`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- reading the launcher's answer

export interface LauncherGrantLine { readonly path: string; readonly mode: string; readonly soft: boolean; readonly applied: boolean; readonly revoked: boolean; readonly errorCode?: number; readonly entriesLeft?: number }
export interface LauncherLine {
  readonly ok: boolean;
  readonly stage?: string;
  readonly error?: string;
  readonly childStarted?: boolean;
  readonly childExitCode?: number;
  readonly timedOut?: boolean;
  readonly leftoverProcesses?: number;
  readonly allGrantsRevoked?: boolean;
  readonly clean?: boolean;
  /** The window station of the child: "private" in the product launcher (card A03b: one made for each run). */
  readonly windowStation?: string;
  /** `info` and `check`: whether the launcher could make (and close) a private window station for the container; with `windowStationError` when not. */
  readonly windowStationOk?: boolean;
  readonly windowStationError?: string;
  readonly grants: readonly LauncherGrantLine[];
}

/** The launcher's one JSON line: the last line of its output that parses as an object from `nn-appc-launcher`. Undefined when there is none. */
export function parseLauncherLine(text: string): LauncherLine | undefined {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (!t.startsWith("{")) continue;
    let o: unknown;
    try { o = JSON.parse(t); } catch { continue; }
    if (o === null || typeof o !== "object" || (o as { tool?: unknown }).tool !== "nn-appc-launcher") continue;
    const r = o as Record<string, unknown>;
    const grants = Array.isArray(r["grants"]) ? (r["grants"] as unknown[]).filter((g): g is Record<string, unknown> => g !== null && typeof g === "object").map((g): LauncherGrantLine => ({
      path: String(g["path"] ?? ""), mode: String(g["mode"] ?? ""), soft: g["soft"] === true, applied: g["applied"] === true, revoked: g["revoked"] === true,
      ...(typeof g["errorCode"] === "number" ? { errorCode: g["errorCode"] } : {}), ...(typeof g["entriesLeft"] === "number" ? { entriesLeft: g["entriesLeft"] } : {}),
    })) : [];
    const num = (k: string): number | undefined => (typeof r[k] === "number" ? (r[k] as number) : undefined);
    const bool = (k: string): boolean | undefined => (typeof r[k] === "boolean" ? (r[k] as boolean) : undefined);
    const str = (k: string): string | undefined => (typeof r[k] === "string" ? (r[k] as string) : undefined);
    return {
      ok: r["ok"] === true, grants,
      ...(str("stage") === undefined ? {} : { stage: str("stage")! }), ...(str("error") === undefined ? {} : { error: str("error")! }),
      ...(bool("childStarted") === undefined ? {} : { childStarted: bool("childStarted")! }), ...(num("childExitCode") === undefined ? {} : { childExitCode: num("childExitCode")! }),
      ...(bool("timedOut") === undefined ? {} : { timedOut: bool("timedOut")! }), ...(num("leftoverProcesses") === undefined ? {} : { leftoverProcesses: num("leftoverProcesses")! }),
      ...(bool("allGrantsRevoked") === undefined ? {} : { allGrantsRevoked: bool("allGrantsRevoked")! }), ...(bool("clean") === undefined ? {} : { clean: bool("clean")! }),
      ...(str("windowStation") === undefined ? {} : { windowStation: str("windowStation")! }), ...(bool("windowStationOk") === undefined ? {} : { windowStationOk: bool("windowStationOk")! }),
      ...(str("windowStationError") === undefined ? {} : { windowStationError: str("windowStationError")! }),
    };
  }
  return undefined;
}

const STAGE_KIND: Readonly<Record<string, NativeFailure>> = { container: "container", capability: "container", attributes: "container", job: "job", grant: "grant", stdio: "files", "create-process": "start" };
/** The typed reason for a launcher stage that failed; an unknown stage is a launcher failure, never ignored. */
export const failureKindOf = (stage: string | undefined): NativeFailure => (stage === undefined ? "launcher" : STAGE_KIND[stage] ?? "launcher");

/** The grants the launcher applied that still show an entry for the container after its own revoke (or whose read-back could not be made). */
export function grantsLeft(line: LauncherLine): string[] {
  return line.grants.filter((g) => g.applied && (!g.revoked || g.entriesLeft !== 0)).map((g) => g.path);
}
/** The soft grants the launcher could not make (each is recorded; the launch went on). */
export function softRefusals(line: LauncherLine): { path: string; mode: string; errorCode: number | null }[] {
  return line.grants.filter((g) => g.soft && !g.applied).map((g) => ({ path: g.path, mode: g.mode, errorCode: g.errorCode ?? null }));
}

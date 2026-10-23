import { win32 } from "node:path";
import { SandboxError } from "./errors.js";
import type { WindowsHost, WindowsPackageInfo } from "./windows-host.js";
import type { NormalizedRecipe } from "./recipe.js";

/** The Microsoft package that provides `wsb.exe` and the Sandbox service, and the hash of Microsoft's publisher certificate (the part after the underscore in the package family name). */
export const SANDBOX_PACKAGE = "MicrosoftWindows.WindowsSandbox";
export const MICROSOFT_PUBLISHER_ID = "8wekyb3d8bbwe";
/** The client version the research of 2026-10-16 was done with (Windows 11 Pro 10.0.26200). An older client is refused; a newer one is accepted and its version is recorded in the audit. */
export const DEFAULT_MIN_VERSION = "0.8.107.0";
export const LOCK_TASK_NAME = "NimbleNewt-LockOnLogon";
/** The owner types this exact sentence into the configuration to turn the auto-login and lock mode on. Nothing turns it on by default and nothing in this code can configure the auto-login itself. */
export const AUTOLOGON_ACKNOWLEDGEMENT = "I accept that this computer signs in automatically and is then locked, so the signed-in desktop is exposed until the lock takes effect";

/** Card A03b: whether a virtual machine fallback is qualified. It is not, and this is the recorded reason (shown in the capacity notes and in every launch record). */
export const VM_FALLBACK_DECISION =
  "VM fallback not qualified and not implemented: Windows Sandbox meets the service lifecycle in its session-dependent forms (owner session present, or the owner's explicit auto-login and lock mode), and a separate Windows VM would need its own licence and deployment review; the owner declined evaluation media on 2026-10-16. With nobody signed in and no opt-in, capacity stays unavailable.";

export type WindowsMode = "owner-session" | "autologon-lock";

/** What the backend needs at run time, as plain data (it travels to the runner process in the job file). */
export interface WindowsSettings {
  /** Supervisor-owned: job files, the lock. Never shared with the guest, never writable by the share identity. */
  readonly controlDir: string;
  /** The account the Sandbox service uses to reach mapped folders (the research showed it must be granted explicitly); one named account, never a broad group. */
  readonly shareIdentity: string;
  /** The account expected to be signed in at the console. */
  readonly owner: string;
  readonly minVersion: string;
  readonly packageName: string;
  readonly publisherId: string;
  readonly mode: WindowsMode;
  readonly lockTask: string;
  /** Auto-login and lock mode only: the protected helper the lock task must run. */
  readonly lockHelper?: string;
}

export const GUEST_ROOT = "C:\\nn";
export const GUEST_PATHS = { work: `${GUEST_ROOT}\\work`, home: `${GUEST_ROOT}\\home`, scratch: `${GUEST_ROOT}\\scratch`, tmp: `${GUEST_ROOT}\\scratch\\.tmp`, job: `${GUEST_ROOT}\\job` } as const;

const bad = (message: string): never => { throw new SandboxError("invalid_recipe", message); };

// ---------- small pure helpers ----------

/** Compares dotted version numbers (1.2.3.4). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    if (!/^\d+(\.\d+){1,3}$/.test(v)) return bad(`not a version number: ${v}`);
    return v.split(".").map(Number);
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d !== 0) return d < 0 ? -1 : 1; }
  return 0;
}

const lower = (p: string): string => p.toLowerCase();
/** Windows paths compare without regard to case. */
export const overlapsWin = (a: string, b: string): boolean => { const x = lower(a), y = lower(b); return x === y || x.startsWith(y + "\\") || y.startsWith(x + "\\"); };
const insideWin = (path: string, dir: string): boolean => lower(path).startsWith(lower(dir) + "\\");

const BROAD_IDENTITIES = new Set(["everyone", "users", "authenticated users", "builtin\\users", "domain users", "guests", "builtin\\guests", "anonymous logon", "nt authority\\authenticated users", "nt authority\\anonymous logon", "nt authority\\interactive", "nt authority\\system", "system", "administrators", "builtin\\administrators", "network", "nt authority\\network", "creator owner", "all application packages", "s-1-1-0", "s-1-5-11", "s-1-5-7", "s-1-5-4", "s-1-5-2", "s-1-5-18", "s-1-5-32-544", "s-1-5-32-545", "s-1-5-32-546"]);
const IDENTITY = /^(?:S-1-\d+(?:-\d+){1,14}|[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}(?:\\[A-Za-z0-9][A-Za-z0-9 ._$-]{0,62})?)$/;

/** The account the share ACLs name must be one specific account. Broad groups and the system accounts are refused: that would be the wide grant the per-job ACLs exist to avoid. */
export function checkIdentity(label: string, identity: unknown): string {
  if (typeof identity !== "string" || !IDENTITY.test(identity)) return bad(`${label}: must be one account name (DOMAIN\\user, user or a SID)`);
  if (BROAD_IDENTITIES.has(lower(identity)) || BROAD_IDENTITIES.has(lower(identity.split("\\").pop() ?? ""))) return bad(`${label}: ${identity} is a broad group or system account; name the one account that the Sandbox service uses`);
  return identity;
}
/** icacls takes a SID with a leading asterisk. */
export const icaclsName = (identity: string): string => (identity.startsWith("S-1-") ? `*${identity}` : identity);
export const sameAccount = (a: string, b: string): boolean => lower(a) === lower(b) || lower(a.split("\\").pop() ?? a) === lower(b) || lower(b.split("\\").pop() ?? b) === lower(a);

/** A path to the supervisor's own program (the runner, the lock helper): absolute, local and normalised. These may live in Program Files; they are never shared. */
export function checkWindowsProgramPath(label: string, path: unknown): string {
  if (typeof path !== "string" || !/^[A-Za-z]:\\/.test(path) || win32.normalize(path) !== path || /[<>"|?*\u0000-\u001f]/.test(path) || path.endsWith("\\")) return bad(`${label}: must be a local absolute normalised path such as C:\\dir\\file: ${String(path)}`);
  return path;
}

/** A host path the guest will be given. Absolute, local, normalised, not a drive root, not part of the system or program files, not a short (8.3) alias. */
export function checkWindowsHostPath(label: string, path: unknown, env: (name: string) => string | undefined): string {
  if (typeof path !== "string" || path.length === 0) return bad(`${label}: must be a path`);
  if (!/^[A-Za-z]:\\/.test(path)) return bad(`${label}: must be a local absolute path such as C:\\dir (not relative, not a network path, not \\\\?\\): ${path}`);
  if (/[<>"|?*\u0000-\u001f]/.test(path) || path.indexOf(":", 2) !== -1) return bad(`${label}: ${path} holds a character that is not allowed in a shared path (including alternate data streams)`);
  if (win32.normalize(path) !== path || path.endsWith("\\") || path.split("\\").some((s) => s === ".." || s === "." || s === "" || /~\d/.test(s) || /[. ]$/.test(s))) return bad(`${label}: must be normalised, with no "..", trailing dot or space, or short-name (~1) segment: ${path}`);
  const forbidden: string[] = [];
  const sysDrive = env("SystemDrive") ?? "C:";
  for (const name of ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"]) { const v = env(name); if (v !== undefined && v !== "") forbidden.push(v); }
  forbidden.push(`${sysDrive}\\Windows`, `${sysDrive}\\Program Files`, `${sysDrive}\\Program Files (x86)`, `${sysDrive}\\ProgramData`, `${sysDrive}\\Users`, `${sysDrive}\\Recovery`, `${sysDrive}\\System Volume Information`);
  for (const f of forbidden) {
    // The folder itself or anything that contains it is refused; a folder inside Windows or Program Files is refused too. (A folder inside ProgramData or Users is fine: those are where per-job folders live.)
    const isSystemTree = /\\(windows|program files|program files \(x86\)|recovery|system volume information)$/i.test(f) || ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"].some((n) => env(n) === f);
    if (lower(path) === lower(f) || lower(f).startsWith(lower(path) + "\\")) return bad(`${label}: ${path} is or contains ${f}`);
    if (isSystemTree && insideWin(path, f)) return bad(`${label}: ${path} is inside ${f}`);
  }
  return path;
}

// ---------- guest paths and the command line ----------

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._ -]*$/;
/** The recipe speaks of the sandbox's paths as POSIX paths (/work, /inputs/tools/x.exe); Windows Sandbox's guest has these places instead. `/windows/...` is the guest's own system directory (read-only programs such as cmd.exe). */
export function guestPathFor(path: string): string | undefined {
  const table: readonly [string, string][] = [["/work", GUEST_PATHS.work], ["/home/agent", GUEST_PATHS.home], ["/scratch", GUEST_PATHS.scratch], ["/inputs", `${GUEST_ROOT}\\inputs`], ["/opt", `${GUEST_ROOT}\\opt`], ["/windows", "C:\\Windows"]];
  for (const [prefix, target] of table) {
    if (path !== prefix && !path.startsWith(prefix + "/")) continue;
    const rest = path === prefix ? [] : path.slice(prefix.length + 1).split("/");
    if (rest.some((s) => !SEGMENT.test(s) || /[. ]$/.test(s) || s === "..")) return undefined;
    return [target, ...rest].join("\\");
  }
  return undefined;
}

const ARG_REFUSED = /[\u0000\r\n"%]/;
const ARG_NEEDS_QUOTES = /[\s&|<>^(),;=!]/;
/** One argument for cmd.exe. Characters that cannot be quoted safely (quotes, percent signs, line breaks) are refused instead of escaped. */
export function quoteArg(arg: string): string {
  if (ARG_REFUSED.test(arg)) return bad(`command: an argument may not contain a quote, a percent sign or a line break: ${JSON.stringify(arg.slice(0, 40))}`);
  if (arg === "") return '""';
  if (!ARG_NEEDS_QUOTES.test(arg)) return arg;
  return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
}

/** The guest-side command line, with a Windows program path in place of the sandbox's POSIX one. */
export function guestCommand(command: readonly string[]): string[] {
  const program = command[0];
  const mapped = program === undefined ? undefined : guestPathFor(program);
  if (mapped === undefined) return bad(`command: the program must be under /work, /home/agent, /scratch, /inputs, /opt or /windows (as the sandbox sees paths): ${String(program)}`);
  return [mapped, ...command.slice(1)];
}

const ENV_REFUSED = /[\u0000\r\n"%!]/;
/** The batch file the guest runs. It sits in a read-only share, so the agent cannot change it before it runs. */
export function launchScript(recipe: NormalizedRecipe, command: readonly string[]): string {
  const lines = ["@echo off", `set "HOME=${GUEST_PATHS.home}"`, `set "USERPROFILE=${GUEST_PATHS.home}"`, `set "TEMP=${GUEST_PATHS.tmp}"`, `set "TMP=${GUEST_PATHS.tmp}"`, 'set "SystemRoot=C:\\Windows"', 'set "PATH=C:\\Windows\\System32;C:\\Windows"'];
  for (const [name, value] of Object.entries(recipe.env)) {
    if (ENV_REFUSED.test(value)) return bad(`env: ${name} may not contain a quote, a percent sign, "!" or a line break on Windows`);
    lines.push(`set "${name}=${value}"`);
  }
  lines.push(`mkdir "${GUEST_PATHS.tmp}" 2>nul`, `cd /d "${GUEST_PATHS.work}"`, guestCommand(command).map(quoteArg).join(" "), "exit /b %ERRORLEVEL%");
  return lines.join("\r\n") + "\r\n";
}

// ---------- shares, configuration, ACLs ----------

export interface Share {
  readonly host: string;
  readonly guest: string;
  readonly readOnly: boolean;
  readonly why: "work" | "home" | "scratch" | "input" | "protected" | "job";
}

/** Every folder the guest is given, narrowest first. Nothing else is shared. */
export function sharesFor(recipe: NormalizedRecipe, jobGuestDir: string): Share[] {
  const shares: Share[] = [
    { host: recipe.workdir, guest: GUEST_PATHS.work, readOnly: false, why: "work" },
    { host: recipe.home, guest: GUEST_PATHS.home, readOnly: false, why: "home" },
    { host: recipe.scratch, guest: GUEST_PATHS.scratch, readOnly: false, why: "scratch" },
  ];
  for (const m of recipe.readOnly) {
    const guest = guestPathFor(m.guest);
    if (guest === undefined) return bad(`readOnly: ${m.guest} cannot be mapped into the Windows guest`);
    shares.push({ host: m.host, guest, readOnly: true, why: "input" });
  }
  // The protected names (.git) are shared again, read-only, on top of the writable checkout: the Windows version of the Linux bind and the macOS deny. Whether the guest honours a nested read-only share is proved by the health probe.
  for (const name of recipe.protectedSubpaths) {
    if (recipe.unprotectedSubpaths.includes(name)) continue;
    shares.push({ host: `${recipe.workdir}\\${name}`, guest: `${GUEST_PATHS.work}\\${name}`, readOnly: true, why: "protected" });
  }
  shares.push({ host: jobGuestDir, guest: GUEST_PATHS.job, readOnly: true, why: "job" });
  return shares;
}

const xml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
/** The .wsb configuration: no network, no clipboard, no devices, no GPU, only the listed folders. */
export function wsbConfigXml(shares: readonly Share[]): string {
  const folders = shares.map((s) => `<MappedFolder><HostFolder>${xml(s.host)}</HostFolder><SandboxFolder>${xml(s.guest)}</SandboxFolder><ReadOnly>${s.readOnly}</ReadOnly></MappedFolder>`);
  return `<Configuration><VGpu>Disable</VGpu><Networking>Disable</Networking><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ClipboardRedirection>Disable</ClipboardRedirection><ProtectedClient>Enable</ProtectedClient><MappedFolders>${folders.join("")}</MappedFolders></Configuration>`;
}

export interface AclStep {
  readonly path: string;
  readonly kind: "grant" | "deny";
  readonly apply: readonly string[];
}

/** The per-job ACL changes: the share identity gets Modify on the three writable folders and Read on each input, and is denied writing inside the protected names. Added, never replaced; the job's runner saves each folder's access list first and puts it back exactly when the job ends. */
export function aclSteps(identity: string, shares: readonly Share[]): AclStep[] {
  const id = icaclsName(checkIdentity("shareIdentity", identity));
  const steps: AclStep[] = [];
  for (const s of shares) {
    if (s.why === "job") { steps.push({ path: s.host, kind: "grant", apply: [s.host, "/grant", `${id}:(OI)(CI)RX`] }); continue; }
    if (s.why === "protected") { steps.push({ path: s.host, kind: "deny", apply: [s.host, "/deny", `${id}:(OI)(CI)(W,DC)`] }); continue; }
    steps.push({ path: s.host, kind: "grant", apply: [s.host, "/grant", `${id}:(OI)(CI)${s.readOnly ? "RX" : "M"}`] });
  }
  return steps;
}

const TRUSTED = /^(?:nt authority\\system|builtin\\administrators|nt service\\trustedinstaller|creator owner|nt authority\\local service)$/i;
const WRITE_RIGHTS = new Set(["F", "M", "W", "WD", "AD", "DC", "DE", "GA", "GW", "WDAC", "WO"]);
/** From the text `icacls <path>` prints, the accounts other than the trusted ones that are allowed to write. Deny entries are ignored. */
export function parseIcaclsWritable(output: string, path: string): string[] {
  const found = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "" || /^successfully processed/i.test(line)) continue;
    if (line.toLowerCase().startsWith(path.toLowerCase())) line = line.slice(path.length).trim();
    const m = /^(.+?):((?:\([^)]*\))+)$/.exec(line);
    if (m === null) continue;
    const tokens = [...m[2]!.matchAll(/\(([^)]*)\)/g)].flatMap((t) => t[1]!.split(","));
    if (tokens.includes("DENY")) continue;
    if (TRUSTED.test(m[1]!)) continue;
    if (tokens.some((t) => WRITE_RIGHTS.has(t))) found.add(m[1]!);
  }
  return [...found];
}

// ---------- package and session checks ----------

export type Verdict<T = undefined> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export interface VerifiedClient {
  readonly package: WindowsPackageInfo;
  /** The full path of wsb.exe; always started with `cwd` as its working directory. */
  readonly wsb: string;
  readonly cwd: string;
}

const MICROSOFT_SUBJECT = /(?:^|,\s*)(?:CN|O)=Microsoft Corporation(?:,|$)/;

/** The Windows Sandbox client must be the Microsoft package, at or above the qualified version, in the protected packages folder, with its files signed by Microsoft; it is started from its own folder (the research found it fails from any other). */
export async function verifyClient(host: WindowsHost, settings: WindowsSettings): Promise<Verdict<VerifiedClient>> {
  let pkg: WindowsPackageInfo | undefined;
  try { pkg = await host.findPackage(); } catch (error) { return { ok: false, reason: `the Windows Sandbox client could not be looked up: ${(error as Error).message}` }; }
  if (pkg === undefined) return { ok: false, reason: `Windows Sandbox is not installed (package ${settings.packageName} not found); enable the Windows Sandbox feature and its client update` };
  if (pkg.name !== settings.packageName) return { ok: false, reason: `unexpected package ${pkg.name}` };
  if (pkg.publisherId !== settings.publisherId) return { ok: false, reason: `the Windows Sandbox package is from publisher ${pkg.publisherId}, not ${settings.publisherId} (Microsoft); refusing it` };
  let versionOk: boolean;
  try { versionOk = compareVersions(pkg.version, settings.minVersion) >= 0; } catch { return { ok: false, reason: `the Windows Sandbox version ${pkg.version} is not a version number` }; }
  if (!versionOk) return { ok: false, reason: `the Windows Sandbox client ${pkg.version} is older than the qualified ${settings.minVersion}; update it` };
  const root = host.env("ProgramFiles");
  const location = pkg.installLocation;
  if (root === undefined || !/^[A-Za-z]:\\/.test(location) || win32.normalize(location) !== location || !insideWin(location, `${root}\\WindowsApps`)) return { ok: false, reason: `the Windows Sandbox package is not in the protected packages folder (${location})` };
  const wsb = `${location}\\wsb.exe`;
  const server = `${location}\\WindowsSandboxServer.exe`;
  for (const file of [wsb, server]) if (!host.exists(file)) return { ok: false, reason: `${file} was not found in the package folder; the client is started from there and cannot work without it` };
  for (const file of [wsb, server]) {
    let sig;
    try { sig = await host.signature(file); } catch (error) { return { ok: false, reason: `the signature of ${file} could not be checked: ${(error as Error).message}` }; }
    if (!sig.valid || sig.subject === undefined || !MICROSOFT_SUBJECT.test(sig.subject)) return { ok: false, reason: `${file} does not carry a valid Microsoft signature` };
  }
  return { ok: true, value: { package: pkg, wsb, cwd: location } };
}

/** Whether the session conditions of the configured mode hold right now. Fails closed: anything that cannot be determined is a refusal. */
export async function verifySession(host: WindowsHost, settings: WindowsSettings): Promise<Verdict> {
  let session;
  try { session = await host.session(); } catch (error) { return { ok: false, reason: `the Windows session could not be examined: ${(error as Error).message}` }; }
  if (session.consoleUser === undefined) return { ok: false, reason: "nobody is signed in at the console; Windows Sandbox cannot start without a user session (a start with nobody signed in failed with 0x8000401A in the research of 2026-10-16). The owner can choose the explicit auto-login and lock mode" };
  if (!sameAccount(session.consoleUser, settings.owner)) return { ok: false, reason: `the console session belongs to ${session.consoleUser}, not the configured owner ${settings.owner}` };
  if (settings.mode === "owner-session") return { ok: true, value: undefined };
  // Auto-login and lock mode: the session must be the automatic one, and it must be locked before any work is admitted.
  if (session.locked !== true) return { ok: false, reason: session.locked === undefined ? "the lock state of the console session could not be determined; no work is admitted while it is unknown" : "the console session is not locked; no work is admitted on an unlocked desktop in auto-login mode" };
  let auto, task;
  try { auto = await host.autologon(); task = await host.lockTask(settings.lockTask); } catch (error) { return { ok: false, reason: `the auto-login and lock set-up could not be examined: ${(error as Error).message}` }; }
  if (!auto.enabled || auto.user === undefined || !sameAccount(auto.user, settings.owner)) return { ok: false, reason: "automatic sign-in is not set up locally for the configured owner (the owner sets it up with Sysinternals Autologon; this program never does)" };
  if (auto.plaintextPasswordStored) return { ok: false, reason: "a password is stored in the clear in the registry for automatic sign-in; use a tool that keeps it as a protected secret" };
  const helper = settings.lockHelper;
  if (helper === undefined || !task.present || !task.enabled || task.executable === undefined || lower(task.executable) !== lower(helper) || !host.exists(helper)) return { ok: false, reason: `the lock task ${settings.lockTask} is missing, disabled or does not run the configured lock helper` };
  const writable = [...await host.writableBy(helper), ...await host.writableBy(win32.dirname(helper))];
  if (writable.length > 0) return { ok: false, reason: `the lock helper or its folder can be changed by ${writable.join(", ")}; it must be writable only by administrators` };
  return { ok: true, value: undefined };
}

/** What the owner is told about this capacity, in every health result. */
export function capabilityNotes(settings: WindowsSettings): string[] {
  const notes = [
    settings.mode === "owner-session"
      ? `session-dependent: Windows Sandbox runs only while ${settings.owner} is signed in at the console; after a restart there is no capacity until they sign in`
      : `session-dependent: auto-login and lock mode (explicit owner opt-in): ${settings.owner} is signed in automatically and the console must be confirmed locked before any work is admitted; the lock is checked at admission only, and the time between sign-in and lock is exposed (about 19 seconds measured once)`,
    VM_FALLBACK_DECISION,
  ];
  return notes;
}

import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, posix, sep } from "node:path";
import { SandboxError } from "./errors.js";

/** `sandboxed`: confined by the OS mechanism. `trusted-host`: runs on the host as the service user, only where the owner configured the authority for it. */
export type SandboxMode = "sandboxed" | "trusted-host";

export interface ReadOnlyMount {
  /** An existing host file or directory, given by its real path. */
  readonly host: string;
  /** Where the agent sees it; must be under /inputs or /opt. */
  readonly guest: string;
}

/**
 * What one launch lets an agent reach (card A03). It is fixed when the sandbox starts: changing it means starting a new sandbox, and every
 * recipe has a revision (the digest of its normalised form) that the audit record names.
 */
export interface SandboxRecipe {
  readonly mode: SandboxMode;
  /** The agent's own checkout (host side). Writable; the agent sees it as /work and starts there. */
  readonly workdir: string;
  /** The agent's persistent home (host side). Writable; /home/agent. */
  readonly home: string;
  /** The agent's private scratch (host side). Writable; /scratch. */
  readonly scratch: string;
  readonly readOnly: readonly ReadOnlyMount[];
  /** Only `none` exists: no network, so no uncontrolled route. Controlled routes arrive with the cards that own them. */
  readonly network: "none";
  /** The whole environment of the agent's process, besides HOME, PATH and TMPDIR. Nothing is inherited from the service. */
  readonly env: Readonly<Record<string, string>>;
  /** Names directly under the workdir that are bound read-only on top of it when they exist (default `.git`). */
  readonly protectedSubpaths: readonly string[];
}

/** A recipe whose paths have been checked against the host and whose defaults are filled in. */
export interface NormalizedRecipe extends SandboxRecipe {
  readonly revision: string;
  /** Protected names that did not exist in the workdir at launch, so could not be bound; the Git bridge (A04) owns keeping them out of the agent's reach. */
  readonly unprotectedSubpaths: readonly string[];
}

export const GUEST = { work: "/work", home: "/home/agent", scratch: "/scratch" } as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_ENV = new Set(["HOME", "PATH", "TMPDIR"]);
const MAX_ENV_VALUE = 4096;
const MAX_ENV_ENTRIES = 64;
const SUBPATH = /^[A-Za-z0-9._-]{1,100}$/;
/** Host directories no mount may be, or contain: the whole system, other users, or the places devices and runtime state live. */
const NEVER_BIND = ["/", "/proc", "/sys", "/dev", "/run", "/boot", "/etc", "/var", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/home", "/root", "/tmp", "/srv", "/opt", "/mnt", "/media", "/System", "/Library", "/Applications", "/Users", "/Volumes", "/private", "/private/etc", "/private/var", "/private/tmp"];
/** Trees nothing inside may be mounted from: kernel and runtime state (another process's environment lives under /proc) and the superuser's files. */
const NEVER_INSIDE = ["/proc", "/sys", "/dev", "/run", "/boot", "/root"];
/** Where users' homes live; only the service user's own may be reached into (and still not its credential places). */
const HOME_ROOTS = ["/home", "/Users"];
/** Credential places under the service user's home that are protected whatever the caller lists. */
const HOME_CREDENTIALS = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc", ".config/gh", ".config/gcloud", ".claude", ".local/share/keyrings", ".password-store", ".mozilla", ".config/google-chrome", ".config/chromium", "Library/Keychains"];

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const bad = (message: string): never => { throw new SandboxError("invalid_recipe", message); };

const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
const guestOverlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

/** The paths no mount may reach into or contain: the caller's list plus the service user's credential places. */
export function protectedPathsFor(listed: readonly string[]): string[] {
  const home = homedir();
  return [...listed, ...HOME_CREDENTIALS.map((name) => join(home, name))];
}

function checkHostPath(label: string, path: unknown, protectedPaths: readonly string[], kind: "directory" | "any"): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) return bad(`${label}: must be a path`);
  if (!isAbsolute(path) || normalize(path) !== path || (path.length > 1 && path.endsWith(sep))) return bad(`${label}: must be an absolute, normalised path (no "..", "//" or trailing slash): ${path}`);
  let real: string;
  try { real = realpathSync(path); } catch (error) { return bad(`${label}: ${path} does not exist (${(error as NodeJS.ErrnoException).code ?? "unreadable"})`); }
  if (real !== path) return bad(`${label}: ${path} passes through a symbolic link (its real path is ${real}); give the real path`);
  const stats = lstatSync(path);
  if (kind === "directory" && !stats.isDirectory()) return bad(`${label}: ${path} must be a directory`);
  if (!stats.isDirectory() && !stats.isFile()) return bad(`${label}: ${path} must be a file or directory`);
  if (NEVER_BIND.includes(path)) return bad(`${label}: ${path} is a system directory and cannot be mounted into a sandbox`);
  for (const tree of NEVER_INSIDE) if (path.startsWith(tree + sep)) return bad(`${label}: ${path} is inside ${tree}, which cannot be mounted into a sandbox`);
  const home = homedir();
  if (path === home || home.startsWith(path + sep)) return bad(`${label}: ${path} is or contains the service user's home directory`);
  for (const root of HOME_ROOTS) if (path.startsWith(root + sep) && !path.startsWith(home + sep)) return bad(`${label}: ${path} is in another user's home`);
  for (const guarded of protectedPaths) {
    if (overlaps(path, guarded)) return bad(`${label}: ${path} overlaps the protected path ${guarded}`);
  }
  return path;
}

function checkGuestPath(label: string, path: unknown): string {
  // Guest paths are always POSIX paths, whatever OS the host is.
  if (typeof path !== "string" || !posix.isAbsolute(path) || path.includes("\0") || path.split("/").some((s) => s === ".." || s === ".")) return bad(`${label}: must be an absolute path without "." or ".."`);
  if (posix.normalize(path) !== path || path.endsWith("/") || path.includes("//")) return bad(`${label}: must be normalised: ${path}`);
  if (!(path.startsWith("/inputs/") || path.startsWith("/opt/"))) return bad(`${label}: read-only mounts go under /inputs or /opt, not ${path}`);
  return path;
}

/**
 * Checks a recipe against the host and returns it with its revision. A recipe is refused when a path does not exist, is reached through a
 * symbolic link, is a system directory, contains the service user's home or any protected path (the supervisor's own files, the controller's
 * data, credentials), or when two mounts overlap. Nothing here relaxes with the mode: a trusted-host recipe is checked the same way.
 */
export function normalizeRecipe(recipe: SandboxRecipe, protectedPaths: readonly string[]): NormalizedRecipe {
  if (recipe === null || typeof recipe !== "object") return bad("a recipe is an object");
  if (recipe.mode !== "sandboxed" && recipe.mode !== "trusted-host") return bad(`mode: must be "sandboxed" or "trusted-host"`);
  if (recipe.network !== "none") return bad(`network: only "none" is supported`);
  const workdir = checkHostPath("workdir", recipe.workdir, protectedPaths, "directory");
  const home = checkHostPath("home", recipe.home, protectedPaths, "directory");
  const scratch = checkHostPath("scratch", recipe.scratch, protectedPaths, "directory");
  if (!Array.isArray(recipe.readOnly)) return bad("readOnly: must be a list");
  const readOnly = recipe.readOnly.map((m, i) => {
    if (m === null || typeof m !== "object") return bad(`readOnly[${i}]: must be { host, guest }`);
    return { host: checkHostPath(`readOnly[${i}].host`, m.host, protectedPaths, "any"), guest: checkGuestPath(`readOnly[${i}].guest`, m.guest) };
  });
  const hosts = [["workdir", workdir], ["home", home], ["scratch", scratch], ...readOnly.map((m, i) => [`readOnly[${i}]`, m.host] as const)] as const;
  for (let i = 0; i < hosts.length; i++) for (let j = i + 1; j < hosts.length; j++) {
    if (overlaps(hosts[i]![1], hosts[j]![1])) return bad(`${hosts[i]![0]} and ${hosts[j]![0]} overlap (${hosts[i]![1]} and ${hosts[j]![1]})`);
  }
  const guests = readOnly.map((m) => m.guest);
  for (let i = 0; i < guests.length; i++) for (let j = i + 1; j < guests.length; j++) {
    if (guestOverlaps(guests[i]!, guests[j]!)) return bad(`readOnly guest paths ${guests[i]} and ${guests[j]} overlap`);
  }
  if (recipe.env === null || typeof recipe.env !== "object" || Array.isArray(recipe.env)) return bad("env: must be an object of strings");
  const entries = Object.entries(recipe.env);
  if (entries.length > MAX_ENV_ENTRIES) return bad(`env: at most ${MAX_ENV_ENTRIES} entries`);
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) return bad(`env: ${JSON.stringify(name)} is not a valid variable name`);
    if (RESERVED_ENV.has(name)) return bad(`env: ${name} is set by the launcher`);
    if (typeof value !== "string" || value.length > MAX_ENV_VALUE || value.includes("\0")) return bad(`env: ${name} must be a string of at most ${MAX_ENV_VALUE} characters`);
  }
  const names = recipe.protectedSubpaths ?? [".git"];
  if (!Array.isArray(names)) return bad("protectedSubpaths: must be a list of names");
  for (const name of names) if (typeof name !== "string" || !SUBPATH.test(name) || name === "." || name === "..") return bad(`protectedSubpaths: ${JSON.stringify(name)} must be a plain file or directory name`);
  const protectedSubpaths = [...new Set(names)].sort();
  const unprotectedSubpaths: string[] = [];
  for (const name of protectedSubpaths) {
    let stats;
    try { stats = lstatSync(join(workdir, name)); } catch { unprotectedSubpaths.push(name); continue; }
    if (stats.isSymbolicLink()) return bad(`protectedSubpaths: ${join(workdir, name)} is a symbolic link`);
  }
  const body = { mode: recipe.mode, workdir, home, scratch, readOnly, network: "none" as const, env: Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1))), protectedSubpaths };
  return { ...body, revision: sha256(canonical(body)), unprotectedSubpaths };
}


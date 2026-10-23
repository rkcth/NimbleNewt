import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { compareVersions, type Problem } from "./check.js";
import { REQUIRED_PREREQUISITES, type PrerequisiteNeed, type PrerequisiteSpec } from "./supported.js";

const run = promisify(execFile);

/** What one probe found. `skipped`: not looked at because what it depends on is missing (that one is reported instead). */
export type ProbeResult =
  | { readonly status: "present"; readonly version?: string }
  | { readonly status: "missing"; readonly detail: string };
export type Probe = () => Promise<ProbeResult>;
/** A probe for every prerequisite id the host can answer; `real` supplies the rest. Tests pass their own to simulate present, missing and too-old. */
export type Probes = Readonly<Record<string, Probe>>;

export interface PrerequisiteReport { readonly id: string; readonly name: string; readonly needs: PrerequisiteNeed; readonly result: ProbeResult | { readonly status: "skipped" }; readonly problem?: Problem }

const VERSION = /(\d+(?:\.\d+)+)/;
async function tool(file: string, args: readonly string[], label: string, env?: NodeJS.ProcessEnv): Promise<ProbeResult & { stdout?: string }> {
  try {
    const out = await run(file, [...args], { timeout: 15_000, encoding: "utf8", windowsHide: true, ...(env === undefined ? {} : { env }) });
    const version = VERSION.exec(out.stdout)?.[1];
    return { status: "present", ...(version === undefined ? {} : { version }), stdout: out.stdout };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") return { status: "missing", detail: `${label} was not found` };
    return { status: "missing", detail: `${label} is present but did not work (${(e.stderr ?? e.message).trim().split("\n").slice(-2).join(" ").slice(0, 200)})` };
  }
}

/** The confinement flags the Linux launcher (packages/worker/src/sandbox/linux.ts) starts with, repeated here because the controller cannot import the worker. A test pins them to the launcher's source. */
export const BUBBLEWRAP_FLAGS: readonly string[] = ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "ALL"];

/**
 * The probes for this machine. Each one really tries the thing, never reads a distribution's name: the tool is run, the kernel feature is used (bubblewrap starts a confined `true`), the
 * systemd user session starts a scope. The two database libraries are probed by code that lives with each storage adapter (only those folders may touch a database), passed in `libraries`.
 */
export function realProbes(libraries: { sqlite?: Probe; postgres?: Probe } = {}): Probes {
  const passEnv: Record<string, string> = {};
  for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) { const v = process.env[name]; if (v !== undefined) passEnv[name] = v; }
  return {
    git: () => tool("git", ["--version"], "git"),
    bubblewrap: () => tool("bwrap", ["--version"], "bwrap"),
    // The flags the Linux launcher uses, so a bubblewrap that is too old for them, or a kernel that refuses user namespaces, is found here and not at the first launch.
    "user-namespaces": async () => {
      const r = await tool("bwrap", [...BUBBLEWRAP_FLAGS, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "/bin/sh", "-c", "exit 0"], "bwrap", { PATH: process.env["PATH"] ?? "/usr/bin:/bin" });
      return r.status === "present" ? { status: "present" } : { status: "missing", detail: `bubblewrap could not start a confined process (${r.detail.replace(/^bwrap is present but did not work /, "")})` };
    },
    "sandbox-exec": async () => { const r = await tool("/usr/bin/sandbox-exec", ["-n", "no-network", "/usr/bin/true"], "/usr/bin/sandbox-exec"); return r.status === "present" ? { status: "present" } : r; },
    "systemd-user-session": async () => {
      const r = await tool("systemd-run", ["--user", "--scope", "--quiet", "--collect", "-p", "TasksMax=100", "--", "/bin/true"], "systemd-run", { ...passEnv, PATH: "/usr/bin:/bin" });
      return r.status === "present" ? { status: "present" } : { status: "missing", detail: `no systemd user session could start a scope (${r.detail})` };
    },
    ...(libraries.sqlite === undefined ? {} : { "sqlite-library": libraries.sqlite }),
    ...(libraries.postgres === undefined ? {} : { "postgres-library": libraries.postgres }),
  };
}

export interface PrerequisiteOptions {
  readonly platform?: NodeJS.Platform;
  /** Which parts the controller will run: always `start`; plus `sqlite` or `postgres` for the storage in use, and `sandbox` and `limits` when this controller runs those locally. */
  readonly needs: readonly PrerequisiteNeed[];
  readonly probes: Probes;
  /** For tests: a different list. Default: the one list. */
  readonly list?: readonly PrerequisiteSpec[];
}

/** Probes what the chosen parts need on this operating system and returns a report row each, with a problem where it is missing or too old. A spec with no probe is reported missing (a probe nobody wrote must not pass silently). */
export async function checkPrerequisites(options: PrerequisiteOptions): Promise<PrerequisiteReport[]> {
  const platform = options.platform ?? process.platform;
  const wanted = new Set(options.needs);
  const specs = (options.list ?? REQUIRED_PREREQUISITES).filter((s) => wanted.has(s.needs) && s.platforms.includes(platform));
  const rows = new Map<string, PrerequisiteReport>();
  for (const spec of specs) {
    const dependency = spec.after === undefined ? undefined : rows.get(spec.after);
    if (dependency !== undefined && dependency.result.status !== "present") { rows.set(spec.id, { id: spec.id, name: spec.name, needs: spec.needs, result: { status: "skipped" } }); continue; }
    const probe = options.probes[spec.id];
    let result: ProbeResult;
    try { result = probe === undefined ? { status: "missing", detail: "no way to check it on this system" } : await probe(); } catch (error) { result = { status: "missing", detail: `the check failed (${error instanceof Error ? error.message.slice(0, 200) : "unknown"})` }; }
    const row = { id: spec.id, name: spec.name, needs: spec.needs, result };
    if (result.status === "missing") {
      const hard = spec.missing === "hard";
      rows.set(spec.id, { ...row, problem: { item: spec.name, found: `nothing usable (${result.detail})`, supported: `${spec.name}${spec.minimum === undefined ? "" : ` ${spec.minimum} or newer`}`, howToFix: spec.install, ...(hard ? { overridable: false } : { ...(spec.overrideMeans === undefined ? {} : { overrideMeans: spec.overrideMeans }) }) } });
    } else if (spec.minimum !== undefined && result.version !== undefined && compareVersions(result.version, spec.minimum) < 0) {
      // Too old can always be overridden: the tool exists, and the operator may have verified that it works.
      rows.set(spec.id, { ...row, problem: { item: spec.name, found: result.version, supported: `${spec.minimum} or newer`, howToFix: `${spec.install} (a newer version)`, overrideMeans: `${spec.name} ${result.version} is used as it is; anything that needs a feature it lacks fails when it is used` } });
    } else rows.set(spec.id, row);
  }
  return [...rows.values()];
}

export const prerequisiteProblems = (report: readonly PrerequisiteReport[]): Problem[] => report.flatMap((r) => (r.problem === undefined ? [] : [r.problem]));

/** The Linux distribution's own description, for the audit log and the start-up output only. Nothing reads it to decide anything. `undefined` when there is none (other systems, or no readable file). */
export function detectDistribution(read: (path: string) => string = (p) => readFileSync(p, "utf8")): string | undefined {
  for (const file of ["/etc/os-release", "/usr/lib/os-release"]) {
    let text: string;
    try { text = read(file); } catch { continue; }
    const field = (name: string): string | undefined => { const m = new RegExp(`^${name}=(.*)$`, "m").exec(text); return m?.[1]?.replace(/^["']|["']$/g, "").replace(/[^\x20-\x7e]/g, "").slice(0, 80); };
    const pretty = field("PRETTY_NAME") ?? field("NAME");
    if (pretty !== undefined && pretty !== "") return pretty;
  }
  return undefined;
}

/** The one line a refusal or notice carries about the host. Information only. */
export function hostLine(distribution: string | undefined, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `Host: ${platform} ${arch}${distribution === undefined ? "" : `, distribution ${distribution}`} (recorded for information; no check depends on it).`;
}

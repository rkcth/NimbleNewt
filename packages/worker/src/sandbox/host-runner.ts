import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { SandboxLauncher, type LaunchRecord } from "./launcher.js";
import { scriptRunner, type InterpreterInstall, type ScriptResult, type ScriptRun } from "./script.js";

/** An interpreter this host offers to the tools of the catalogue, by the exact name and version a manifest asks for. */
export interface HostInterpreter extends InterpreterInstall { readonly name: string; readonly version: string }

export interface HostScriptRunnerOptions {
  /** The launcher scripts run through. Absent: one is made here (`SandboxLauncher.create`) with `protectedPaths` and `audit`, and `stop()` stops it. A launcher given is the caller's to stop. */
  readonly launcher?: Pick<SandboxLauncher, "launch" | "capacity"> & Partial<Pick<SandboxLauncher, "stop">>;
  /** Paths no script mount may reach (the controller's data directory and anything holding secrets). Used when the launcher is made here. */
  readonly protectedPaths?: readonly string[];
  /** Records every launch before it happens (the launcher's audit sink). Used when the launcher is made here. */
  readonly audit?: (record: LaunchRecord) => void | Promise<void>;
  /**
   * The directory under which each run gets a private working directory. Created (mode 0700) when missing; it must be an absolute path outside the product's own files, and not a link.
   */
  readonly base: string;
  /** Further interpreters this host has. The Node.js that runs this process is offered without being listed, when it sits in an install directory of its own (not /usr, /bin or /lib: mounting those would show the whole system). */
  readonly interpreters?: readonly HostInterpreter[];
  /** Whether a limit the host cannot enforce refuses the run (the safe default). A function is asked at every run, so the owner's best-effort setting applies at once; one that throws refuses the run. */
  readonly requireEnforced?: boolean | (() => boolean | Promise<boolean>);
  readonly onLeftover?: (directory: string, reason: string) => void;
}

/** What `ToolExecutionDeps.facts` answers for this machine (the controller's `HostFacts`, restated: the worker package depends on no other package of the product). */
export interface HostScriptFacts {
  readonly os: "linux" | "darwin" | "win32";
  readonly arch: "x64" | "arm64";
  readonly interpreters: Readonly<Record<string, string>>;
  readonly packages: Readonly<Record<string, string>>;
  readonly cpus: number;
  readonly memoryMb: number;
}

export interface HostScriptRunner {
  /** Pass as `tools.runner` of `startController`. */
  readonly runner: { run(launch: ScriptRun, signal: AbortSignal): Promise<ScriptResult> };
  /** Pass as `tools.facts` of `startController` (the host this machine is, with the interpreters it can really run). */
  readonly facts: () => Promise<HostScriptFacts>;
  /** The interpreters offered (name, version). */
  readonly offered: readonly { readonly name: string; readonly version: string }[];
  /** Why the host can run no script at all, when it cannot (no confinement mechanism, or no interpreter). `undefined` when it can. Read it at start and say it: a controller must not claim tools it cannot run. */
  readonly problem: () => string | undefined;
  /** Stops the launcher when it was made here (kills runs still going). */
  stop(): Promise<void>;
}

const SYSTEM_ROOTS = new Set(["/usr", "/bin", "/lib", "/sbin", "/lib64", "/"]);

/** The directory that holds the running Node.js and everything it loads, or `undefined` when that is a system directory (it would put the whole system in the script's view). */
export function ownNodeInstall(execPath: string = process.execPath): InterpreterInstall | undefined {
  const root = dirname(dirname(realpathSync(execPath)));
  return SYSTEM_ROOTS.has(root) ? undefined : { root, executable: "bin/node" };
}

function privateBase(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("the script base directory must be an absolute path");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("the script base directory must be a real directory, not a link");
  if (process.platform !== "win32") chmodSync(path, 0o700);
  return realpathSync(path);
}

/**
 * The production composition of card T02d: the controller's tool bridge runs catalogue scripts through THIS (the sandbox launcher of the host, never a bare process). It makes the launcher (or takes one), makes sure the base directory is
 * private, offers the interpreters this host really has, and says what it can do. Nothing here starts a process until a script is run, and a script runs with an empty environment, no network, the manifest's limits and time.
 * Wire it with `startController({ tools: { runner: x.runner, facts: x.facts, isLocalHost } })`.
 */
export async function hostScriptRunner(options: HostScriptRunnerOptions): Promise<HostScriptRunner> {
  // A run's directories are mounted into its sandbox, and the launcher refuses any mount that overlaps a protected path: a base inside (or holding) one would make every script fail while `problem()` said all was well.
  // Checked before the directory is made (nothing is created inside a protected path) and again on its real path.
  const guardBase = (candidate: string): void => {
    for (const guarded of options.protectedPaths ?? []) {
      let real = guarded;
      try { real = realpathSync(guarded); } catch { /* compared as given */ }
      for (const p of [real, guarded]) if (candidate === p || candidate.startsWith(p + sep) || p.startsWith(candidate + sep)) throw new Error(`the script base directory ${candidate} overlaps the protected path ${guarded}; put it outside (hostScriptBase gives a directory beside the data directory)`);
    }
  };
  if (typeof options.base === "string" && isAbsolute(options.base)) guardBase(resolve(options.base));
  const base = privateBase(options.base);
  guardBase(base);
  const made = options.launcher === undefined;
  const launcher = options.launcher ?? await SandboxLauncher.create({ protectedPaths: options.protectedPaths ?? [], audit: options.audit ?? ((): void => undefined) });
  const list: HostInterpreter[] = [...(options.interpreters ?? [])];
  const own = ownNodeInstall();
  if (own !== undefined && !list.some((i) => i.name === "node" && i.version === process.versions.node)) list.push({ name: "node", version: process.versions.node, ...own });
  for (const i of list) if (!/^[a-z][a-z0-9._-]{0,63}$/.test(i.name) || !isAbsolute(i.root)) throw new Error(`interpreter ${String(i.name).slice(0, 40)}: needs a plain program name and an absolute install directory`);
  const find = (name: string, version: string): InterpreterInstall | undefined => { const i = list.find((x) => x.name === name && x.version === version); return i === undefined ? undefined : { root: i.root, executable: i.executable }; };
  const strict = async (): Promise<unknown> => typeof options.requireEnforced === "function" ? options.requireEnforced() : options.requireEnforced ?? true;
  return {
    runner: {
      async run(launch, signal) {
        // Asked at every run: a setting changed by the owner applies to the next script. An unreadable one refuses the run (the safe side).
        let requireEnforced: boolean;
        // Only a boolean is an answer: the launcher enforces only on exactly `true`, so a truthy non-boolean (1, "true") would otherwise run best-effort.
        let answer: unknown;
        try { answer = await strict(); } catch { answer = undefined; }
        if (typeof answer !== "boolean") throw new Error("the sandbox policy for scripts could not be read, so the script was not started");
        requireEnforced = answer;
        if (!launcher.capacity.available) throw new Error(`this host cannot confine scripts, so none is run: ${launcher.capacity.reason ?? "no sandbox"}`);
        return scriptRunner({ launcher, interpreters: find, base, requireEnforced, ...(options.onLeftover === undefined ? {} : { onLeftover: options.onLeftover }) }).run(launch, signal);
      },
    },
    facts: async () => ({
      os: (platform() === "darwin" || platform() === "win32" ? platform() : "linux") as HostScriptFacts["os"], arch: (arch() === "arm64" ? "arm64" : "x64"),
      interpreters: Object.fromEntries(list.map((i) => [i.name, i.version])), packages: {}, cpus: Math.max(1, cpus().length), memoryMb: Math.max(1, Math.floor(totalmem() / (1024 * 1024))),
    }),
    offered: list.map((i) => ({ name: i.name, version: i.version })),
    problem: () => (!launcher.capacity.available ? `no sandbox: ${launcher.capacity.reason ?? "unavailable"}` : list.length === 0 ? "no interpreter is offered (this host's Node.js sits in a system directory and none was listed)" : undefined),
    async stop() { if (made) await launcher.stop?.(); },
  };
}

/** Where a host's script runs go: a directory BESIDE the controller's data directory (`<data>.script-runs`), never inside it, since the data directory is a protected path no sandbox mount may reach. */
export const hostScriptBase = (dataDirectory: string): string => join(dirname(dataDirectory), `${basename(dataDirectory)}.script-runs`);

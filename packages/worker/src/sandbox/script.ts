import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, posix } from "node:path";
import { SandboxError } from "./errors.js";
import type { SandboxLauncher } from "./launcher.js";

/**
 * What the controller's tool execution service hands over to run an approved script (card T06's `ScriptLaunch`, restated here because the worker package depends on no other package of the product;
 * a value of that type is accepted as it is). Nothing in it is a command line: the model's input is `stdin`, and `argv` is the entry point and nothing else.
 */
export interface ScriptRun {
  /** The manifest's interpreter name, such as `node` or `python3`. */
  readonly program: string;
  readonly interpreterVersion: string;
  /** The entry point, relative to the script's own directory. */
  readonly argv: readonly string[];
  readonly stdin: string;
  /** The exact bytes of the executable of the pinned version. */
  readonly source: string;
  /** The most standard output the run may produce. */
  readonly maxOutputBytes: number;
  /** The limits the manifest declared (A08b). */
  readonly limits: { readonly cpus: number; readonly memoryMb: number; readonly seconds: number };
  /** Additions to an otherwise empty environment. */
  readonly env: Readonly<Record<string, string>>;
}

/** An interpreter installed on this host: a directory that holds it and everything it loads, mounted read-only, and the path of its executable inside that directory. */
export interface InterpreterInstall { readonly root: string; readonly executable: string }

export interface ScriptRunnerOptions {
  readonly launcher: Pick<SandboxLauncher, "launch" | "capacity">;
  /** The interpreter this host has for a manifest's `interpreter` (name and exact version); `undefined` when it has none. */
  readonly interpreters: (name: string, version: string) => InterpreterInstall | undefined;
  /** A directory (real path, writable, outside the product's own files) under which each run gets a private working directory that is removed when the run ends. */
  readonly base: string;
  /** Refuse a run unless the launcher can enforce every limit of the manifest in full (default). With `false` a limit the host cannot enforce is still named in the launch record, and the run goes ahead. */
  readonly requireEnforced?: boolean;
  /** Told when a run's directory could not be removed (the host path and the reason; it is never part of an error the model sees). */
  readonly onLeftover?: (directory: string, reason: string) => void;
}

export interface ScriptResult { readonly text: string }

const GUEST_INTERPRETER = "/opt/interpreter";
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/**
 * Removes a run's directory. The script owns what it created and can have taken away its own permissions (a directory with mode 0555 cannot be emptied), so a failed removal is retried after the
 * permissions of the directories in the tree are restored. A directory that still cannot be removed is reported, never thrown: a cleanup problem must not replace the run's real outcome.
 */
async function removeTree(directory: string, onLeftover: ScriptRunnerOptions["onLeftover"]): Promise<void> {
  const mend = (path: string): void => {
    let stats;
    try { stats = lstatSync(path); } catch { return; }
    if (!stats.isDirectory()) return;
    try { chmodSync(path, 0o700); } catch { /* reported below if it matters */ }
    let names: string[] = [];
    try { names = readdirSync(path); } catch { return; }
    for (const name of names) mend(join(path, name));
  };
  try { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); return; } catch { /* mend and retry */ }
  try { mend(directory); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (error) { onLeftover?.(directory, (error as Error).message); }
}

/** The entry point must stay inside the script's own directory: relative, normalised, no "..", written with "/". */
function entryPoint(argv: readonly string[]): string {
  const entry = argv.length === 1 ? argv[0] : undefined;
  // The manifest writes the entry point with "/" on every system (the same bytes mean the same file everywhere); a backslash or a drive letter is not a path of the manifest.
  if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0") || entry.includes("\\") || /^[A-Za-z]:/.test(entry) || posix.isAbsolute(entry) || isAbsolute(entry) || posix.normalize(entry) !== entry || entry === "." || entry.endsWith("/") || entry.split("/").includes("..") || entry.startsWith("-")) {
    throw new SandboxError("invalid_recipe", "argv: must be one entry point, a relative path inside the script's directory");
  }
  return entry;
}

/**
 * Runs approved scripts through the sandbox launcher (cards A03, A08b, T06b). Each run gets a fresh, private directory holding the pinned source and nothing else, an empty environment, no network, the
 * manifest's limits and time, and its output capped by the launcher. The model's input reaches the script on standard input only. A run that is cut off (time, output), is killed or exits with an error
 * is a failure, with the reason; the launch itself is recorded by the launcher's audit sink before it happens.
 */
export function scriptRunner(options: ScriptRunnerOptions): { run(launch: ScriptRun, signal: AbortSignal): Promise<ScriptResult> } {
  return {
    async run(launch, signal) {
      const entry = entryPoint(launch.argv);
      const install = options.interpreters(launch.program, launch.interpreterVersion);
      if (install === undefined) throw new Error(`this host has no ${launch.program} ${launch.interpreterVersion}`);
      if (signal.aborted) throw new Error("the call was cancelled before the script started");
      const linux = options.launcher.capacity.backend === "bubblewrap";
      const interpreter = linux ? `${GUEST_INTERPRETER}/${install.executable}` : join(install.root, install.executable);
      const directory = realpathSync(mkdtempSync(join(options.base, "script-")));
      try {
        const dirs = { work: join(directory, "work"), home: join(directory, "home"), scratch: join(directory, "scratch") };
        for (const d of Object.values(dirs)) mkdirSync(d);
        const file = join(dirs.work, entry);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, launch.source, { mode: 0o444 });
        const run = await options.launcher.launch({
          recipe: { mode: "sandboxed", workdir: dirs.work, home: dirs.home, scratch: dirs.scratch, readOnly: [{ host: install.root, guest: GUEST_INTERPRETER }], network: "none", env: launch.env, protectedSubpaths: [] },
          command: [interpreter, entry],
          stdin: launch.stdin,
          timeoutMs: Math.max(1, Math.round(launch.limits.seconds * 1000)),
          maxOutputBytes: launch.maxOutputBytes,
          limits: { cpus: launch.limits.cpus, memoryMb: launch.limits.memoryMb },
          requireEnforced: options.requireEnforced ?? true,
        });
        const stop = (): void => run.kill();
        signal.addEventListener("abort", stop, { once: true });
        try {
          // An abort that arrived while the launch was being recorded has no listener to wake: it is honoured now.
          if (signal.aborted) run.kill();
          const result = await run.result;
          if (result.releaseProblem !== undefined) throw new Error(`the sandbox could not be cleaned up after the script: ${clip(result.releaseProblem, 300)}`);
          if (result.exitCode === null && result.signal === null && !result.timedOut && !result.killed) throw new Error(`the script could not be started: ${clip(result.stderr.replace(/^could not start: /, "").trim(), 300)}`);
          if (result.timedOut) throw new Error(`the script ran longer than its limit of ${launch.limits.seconds} seconds and was stopped`);
          if (result.killed) throw new Error("the script was stopped before it finished");
          // The launcher cuts each stream at the cap; a script that filled standard output is cut off, which is a failure, not a short answer.
          if (result.stdoutTruncated) throw new Error(`the script wrote more than ${launch.maxOutputBytes} bytes and was cut off`);
          if (result.exitCode !== 0) throw new Error(`the script ${result.signal === null ? `exited with code ${String(result.exitCode)}` : `was ended by ${result.signal}`}${result.stderr.trim() === "" ? "" : `: ${clip(result.stderr.trim(), 500)}`}`);
          return { text: result.stdout };
        } finally { signal.removeEventListener("abort", stop); }
      } finally {
        await removeTree(directory, options.onLeftover);
      }
    },
  };
}

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SandboxLauncher } from "./launcher.js";
import { GUEST_INTERPRETER, entryPoint, removeTree, type ScriptRun, type ScriptRunnerOptions } from "./script.js";

/** One job's launch: the same as a catalogue script's (card T06's `ScriptLaunch`, accepted as it is). */
export type JobRun = ScriptRun;

/** How a job's process ended (the controller's `JobProcessEnd`, restated: the worker package depends on no other package of the product). */
export interface JobEnd {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stopped: boolean;
  /** Processes of the job still found after it ended and that could not be ended: `pid N (name)`, never a command line or an environment. */
  readonly orphans: readonly string[];
  readonly problem?: string;
}

export interface JobLauncherOptions extends Pick<ScriptRunnerOptions, "interpreters" | "base" | "requireEnforced" | "onLeftover"> {
  readonly launcher: Pick<SandboxLauncher, "launch" | "capacity">;
  /**
   * Finds what is left of a job after its process ended (the processes that still hold its private directory), ends them, and names those that could not be ended. Default on Linux: `linuxOrphans` over /proc; elsewhere none
   * are looked for (the launcher's own tree kill is all there is).
   */
  readonly orphans?: (directory: string) => Promise<readonly string[]>;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The processes still running whose command line holds `directory` (the job's private directory: the sandbox's own command line names it, and nothing else on the machine does), found through `proc` (default /proc). Each is sent
 * SIGKILL (`kill`, injectable for tests); one that is still there a moment later is reported as `pid N (name)`. Its command line is never reported (it may carry a secret).
 */
export async function linuxOrphans(directory: string, options: { readonly proc?: string; readonly kill?: (pid: number) => void; readonly settleMs?: number } = {}): Promise<string[]> {
  const proc = options.proc ?? "/proc";
  const kill = options.kill ?? ((pid: number) => { process.kill(pid, "SIGKILL"); });
  const holding = (): number[] => {
    let names: string[];
    try { names = readdirSync(proc); } catch { return []; }
    const found: number[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try { if (readFileSync(join(proc, name, "cmdline")).toString("utf8").split("\0").some((arg) => arg === directory || arg.startsWith(`${directory}/`))) found.push(Number(name)); } catch { /* gone, or not ours to read */ }
    }
    return found;
  };
  const first = holding();
  if (first.length === 0) return [];
  for (const pid of first) { try { kill(pid); } catch { /* reported below if it stays */ } }
  await sleep(options.settleMs ?? 200);
  const left = new Set(holding());
  return first.filter((pid) => left.has(pid)).map((pid) => {
    let comm = "unknown";
    try { comm = readFileSync(join(proc, String(pid), "comm"), "utf8").trim().slice(0, 40) || "unknown"; } catch { /* name unknown */ }
    return `pid ${pid} (${comm})`;
  });
}

/**
 * Starts long-running jobs through the sandbox launcher (card T07b), for the controller's `LocalJobRuns`. A job is a catalogue script started as its own process with the same confinement a script call has (a fresh private directory
 * with the pinned source and nothing else, the interpreter read-only, no network, an empty environment besides HOME, PATH and TMPDIR, the manifest's limits and time); its input is written to standard input and closed; its standard
 * output is handed over as it comes (decoded as UTF-8 on character boundaries), and its standard error, bounded, at the end.
 *
 * `stop` ends the whole process tree through the launcher, whether asked as a Stop or a Force Stop (the two are separate recorded steps of the job service; the launcher's kill is already the whole tree). When the process has ended,
 * whatever still holds its private directory is ended and, if it cannot be, reported as an orphan; the directory is then removed.
 */
export function jobLauncher(options: JobLauncherOptions): { start(launch: JobRun, onOutput: (text: string) => void): Promise<{ stop(force: boolean): void; readonly ended: Promise<JobEnd> }> } {
  const orphansOf = options.orphans ?? (process.platform === "linux" ? (d: string) => linuxOrphans(d) : async () => [] as string[]);
  return {
    async start(launch, onOutput) {
      const entry = entryPoint(launch.argv);
      const install = options.interpreters(launch.program, launch.interpreterVersion);
      if (install === undefined) throw new Error(`this host has no ${launch.program} ${launch.interpreterVersion}`);
      const linux = options.launcher.capacity.backend === "bubblewrap";
      const interpreter = linux ? `${GUEST_INTERPRETER}/${install.executable}` : join(install.root, install.executable);
      const directory = realpathSync(mkdtempSync(join(options.base, "job-")));
      let run;
      try {
        const dirs = { work: join(directory, "work"), home: join(directory, "home"), scratch: join(directory, "scratch") };
        for (const d of Object.values(dirs)) mkdirSync(d);
        const file = join(dirs.work, entry);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, launch.source, { mode: 0o444 });
        const decoder = new StringDecoder("utf8");
        run = await options.launcher.launch({
          recipe: { mode: "sandboxed", workdir: dirs.work, home: dirs.home, scratch: dirs.scratch, readOnly: [{ host: install.root, guest: GUEST_INTERPRETER }], network: "none", env: launch.env, protectedSubpaths: [] },
          command: [interpreter, entry],
          stream: { onStdout: (chunk) => { const text = decoder.write(chunk); if (text.length > 0) onOutput(text); } },
          timeoutMs: Math.max(1, Math.round(launch.limits.seconds * 1000)),
          maxOutputBytes: launch.maxOutputBytes,
          limits: { cpus: launch.limits.cpus, memoryMb: launch.limits.memoryMb },
          requireEnforced: options.requireEnforced ?? true,
        });
        const started = run;
        // The input is data on standard input, then closed; a program that exits without reading it closes the pipe, which is its answer.
        void started.write(launch.stdin).catch(() => undefined).finally(() => { started.endInput(); });
        const ended = started.result.then(async (result): Promise<JobEnd> => {
          const rest = decoder.end();
          if (rest.length > 0) onOutput(rest);
          if (result.stderr.trim() !== "") onOutput(`\n[stderr] ${clip(result.stderr.trim(), 4000)}\n`);
          let orphans: readonly string[] = [];
          try { orphans = await orphansOf(directory); } catch { orphans = []; }
          await removeTree(directory, options.onLeftover);
          const notStarted = result.exitCode === null && result.signal === null && !result.timedOut && !result.killed;
          const problem = result.releaseProblem !== undefined ? `the sandbox could not be cleaned up after the job: ${clip(result.releaseProblem, 300)}` : notStarted ? `the job could not be started: ${clip(result.stderr.replace(/^could not start: /, "").trim(), 300)}` : undefined;
          return { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, stopped: result.killed, orphans, ...(problem === undefined ? {} : { problem }) };
        });
        return { stop: () => { started.kill(); }, ended };
      } catch (error) {
        if (run === undefined) await removeTree(directory, options.onLeftover);
        throw error;
      }
    },
  };
}

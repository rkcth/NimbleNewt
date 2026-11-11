import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Per-agent limits for systems with no kernel group limit a worker may use (macOS, and the host side of Windows; card A08c). A sampler looks at the run's whole process tree a few times a second and at the
 * directories the agent may write now and then; a run past a memory, process-count or disk limit is ended, and one using more CPU than its share is paused and resumed (SIGSTOP/SIGCONT) so that its average
 * stays at the limit. This is sampling, never a kernel guarantee, so the launch record reports these limits as `partial` and says what they miss. Nothing here reads what the agent wrote: only numbers.
 */

export interface UsageSample {
  /** Every process of the run (the launched one and all below it), as a bounded list. */
  readonly pids: readonly number[];
  readonly processes: number;
  /** Resident memory of those processes together, in MiB. */
  readonly rssMb: number;
  /** CPU time the live processes of the run have used so far, in milliseconds. Time used by processes that have since exited is no longer visible. */
  readonly cpuMs: number;
}

/** Looks at a run's process tree. `undefined`: the launched process is not there (it ended) or the system could not say. */
export type UsageSampler = (rootPid: number) => Promise<UsageSample | undefined>;

/** The limits the watcher takes (memory and processes of the tree, CPU share, bytes written under the agent's directories). */
export interface WatchLimits {
  readonly memoryMb?: number;
  readonly processes?: number;
  readonly cpus?: number;
  readonly diskMb?: number;
}

export interface LimitExceeded {
  readonly limit: "memoryMb" | "processes" | "diskMb";
  readonly value: number;
  readonly observed: number;
}

const MAX_TREE = 4096;

/** CPU time as `ps` prints it: `[[dd-]hh:]mm:ss[.cc]` (Linux) or `[hh:]mm:ss.cc` / `m:ss.cc` (macOS). Anything else is `undefined`. */
export function parseCpuTime(text: string): number | undefined {
  const m = /^(?:(\d{1,4})-)?(?:(\d{1,3}):)?(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(text.trim());
  if (m === null) return undefined;
  const [, d, h, min, s, frac] = m;
  const fraction = frac === undefined ? 0 : Number(`0.${frac}`) * 1000;
  return Math.round((((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min)) * 60 + Number(s)) * 1000 + fraction);
}

/** The process tree below `rootPid` from `ps -A -o pid=,ppid=,rss=,time=` output. `undefined` when the root is not listed. Lines that do not parse are skipped, never guessed. */
export function parsePsUsage(output: string, rootPid: number): UsageSample | undefined {
  const rows = new Map<number, { ppid: number; rssKb: number; cpuMs: number }>();
  const children = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (m === null) continue;
    const cpuMs = parseCpuTime(m[4]!);
    if (cpuMs === undefined) continue;
    const pid = Number(m[1]);
    rows.set(pid, { ppid: Number(m[2]), rssKb: Number(m[3]), cpuMs });
    children.set(Number(m[2]), [...(children.get(Number(m[2])) ?? []), pid]);
  }
  if (!rows.has(rootPid)) return undefined;
  const pids: number[] = [];
  let rssKb = 0; let cpuMs = 0; let count = 0;
  const seen = new Set<number>();
  for (const queue = [rootPid]; queue.length > 0;) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const row = rows.get(next);
    if (row === undefined) continue;
    count++; rssKb += row.rssKb; cpuMs += row.cpuMs;
    if (pids.length < MAX_TREE) pids.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return { pids, processes: count, rssMb: rssKb / 1024, cpuMs };
}

/** The default sampler: one `ps` for the whole system, then the tree below the run's process. */
export function psSampler(psPath = "/bin/ps"): UsageSampler {
  return async (rootPid) => {
    try {
      const out = await run(psPath, ["-A", "-o", "pid=,ppid=,rss=,time="], { timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
      return parsePsUsage(out.stdout, rootPid);
    } catch { return undefined; }
  };
}

/** The bytes of every file under these directories (links are counted as themselves and never followed). `truncated`: the walk stopped at `maxEntries`, so the figure is a lower bound. */
export async function measureDirs(dirs: readonly string[], maxEntries = 500_000): Promise<{ readonly bytes: number; readonly truncated: boolean }> {
  let bytes = 0; let entries = 0; let truncated = false;
  const pending = [...dirs];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      if (++entries > maxEntries) { truncated = true; return { bytes, truncated }; }
      const path = join(dir, name);
      let st;
      try { st = await lstat(path); } catch { continue; }
      if (st.isDirectory()) pending.push(path);
      else bytes += st.size;
    }
  }
  return { bytes, truncated };
}

/** What `judge` remembers between looks (CPU credit in milliseconds of CPU time). */
export interface JudgeState { lastAt: number | undefined; lastCpuMs: number; credit: number }
export const newJudgeState = (): JudgeState => ({ lastAt: undefined, lastCpuMs: 0, credit: 0 });
/** How much unused CPU a quiet run may save up, in seconds of its limit: a short burst is allowed, a sustained one is not. */
export const CPU_BURST_SECONDS = 2;
export const MAX_PAUSE_MS = 2000;
export const MIN_PAUSE_MS = 50;

export type Verdict =
  | { readonly action: "ok" }
  | { readonly action: "kill"; readonly exceeded: LimitExceeded }
  | { readonly action: "pause"; readonly ms: number };

/** The decision for one look, free of any clock or process: memory and process count end the run past their limit; CPU is a token bucket refilled at `cpus` core-seconds per second, and an empty bucket pauses the run until it refills. */
export function judge(limits: WatchLimits, sample: UsageSample, disk: { readonly bytesWritten: number } | undefined, now: number, state: JudgeState): Verdict {
  if (limits.memoryMb !== undefined && sample.rssMb > limits.memoryMb) return { action: "kill", exceeded: { limit: "memoryMb", value: limits.memoryMb, observed: Math.ceil(sample.rssMb) } };
  if (limits.processes !== undefined && sample.processes > limits.processes) return { action: "kill", exceeded: { limit: "processes", value: limits.processes, observed: sample.processes } };
  if (limits.diskMb !== undefined && disk !== undefined && disk.bytesWritten > limits.diskMb * 1048576) return { action: "kill", exceeded: { limit: "diskMb", value: limits.diskMb, observed: Math.ceil(disk.bytesWritten / 1048576) } };
  if (limits.cpus === undefined) return { action: "ok" };
  const burst = CPU_BURST_SECONDS * 1000 * limits.cpus;
  if (state.lastAt === undefined) { state.lastAt = now; state.lastCpuMs = sample.cpuMs; state.credit = burst; return { action: "ok" }; }
  const wall = Math.max(0, now - state.lastAt);
  // CPU time of processes that exited since the last look disappears from the figure, so a drop counts as no use (never as a refund).
  const used = Math.max(0, sample.cpuMs - state.lastCpuMs);
  state.lastAt = now; state.lastCpuMs = sample.cpuMs;
  state.credit = Math.min(burst, state.credit + wall * limits.cpus) - used;
  if (state.credit >= 0) return { action: "ok" };
  return { action: "pause", ms: Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, Math.ceil(-state.credit / limits.cpus))) };
}

export interface ResourceWatchOptions {
  readonly limits: WatchLimits;
  readonly rootPid: number;
  readonly sample: UsageSampler;
  /** Directories whose growth counts as the agent's writing, with their size when the run began. Needed with `limits.diskMb`. */
  readonly disk?: { readonly dirs: readonly string[]; readonly baselineBytes: number; readonly measure?: typeof measureDirs };
  /** Ends the run. Called once, with what was passed. */
  readonly onExceeded: (exceeded: LimitExceeded) => void;
  /** Sends a signal to a process of the run; default `process.kill`. Injectable for tests. */
  readonly signal?: (pid: number, signal: "SIGSTOP" | "SIGCONT") => void;
  readonly intervalMs?: number;
  readonly diskEveryMs?: number;
  readonly now?: () => number;
}

/** Runs `judge` on a timer for one run. `stop` resumes anything it paused and ends the timers; it is safe to call more than once. */
export class ResourceWatch {
  readonly #o: ResourceWatchOptions;
  readonly #state = newJudgeState();
  #timer: NodeJS.Timeout | undefined;
  #resume: NodeJS.Timeout | undefined;
  #paused: readonly number[] = [];
  #busy = false;
  #done = false;
  #lastDiskAt = Number.NEGATIVE_INFINITY;
  #disk: { bytesWritten: number } | undefined;
  /** How many times the run was paused to hold its CPU share. */
  pauses = 0;

  constructor(options: ResourceWatchOptions) {
    if (options.limits.diskMb !== undefined && options.disk === undefined) throw new Error("a disk limit needs the directories to measure");
    this.#o = options;
  }

  start(): void {
    this.#timer = setInterval(() => { void this.tick(); }, this.#o.intervalMs ?? 250);
    this.#timer.unref();
  }

  /** One look and its consequence. Looks never overlap: one that is still running makes the next skip. */
  async tick(): Promise<void> {
    if (this.#done || this.#busy || this.#resume !== undefined) return;
    this.#busy = true;
    try {
      const now = (this.#o.now ?? Date.now)();
      const sample = await this.#o.sample(this.#o.rootPid);
      if (sample === undefined || this.#done) return;
      const d = this.#o.disk;
      if (this.#o.limits.diskMb !== undefined && d !== undefined && now - this.#lastDiskAt >= (this.#o.diskEveryMs ?? 5000)) {
        this.#lastDiskAt = now;
        const size = await (d.measure ?? measureDirs)(d.dirs);
        this.#disk = { bytesWritten: Math.max(0, size.bytes - d.baselineBytes) };
      }
      if (this.#done) return;
      const verdict = judge(this.#o.limits, sample, this.#disk, now, this.#state);
      if (verdict.action === "kill") { this.#done = true; this.#o.onExceeded(verdict.exceeded); return; }
      if (verdict.action === "pause") this.#pause(sample.pids, verdict.ms);
    } catch { /* a failed look is not a decision */ } finally { this.#busy = false; }
  }

  #send(pids: readonly number[], signal: "SIGSTOP" | "SIGCONT"): void {
    const send = this.#o.signal ?? ((pid: number, s: "SIGSTOP" | "SIGCONT") => { process.kill(pid, s); });
    for (const pid of pids) { try { send(pid, signal); } catch { /* already gone */ } }
  }

  #pause(pids: readonly number[], ms: number): void {
    this.pauses++;
    this.#paused = pids;
    this.#send(pids, "SIGSTOP");
    this.#resume = setTimeout(() => { this.#resume = undefined; this.#continue(); }, ms);
    this.#resume.unref();
  }

  #continue(): void {
    const paused = this.#paused;
    this.#paused = [];
    this.#send(paused, "SIGCONT");
  }

  stop(): void {
    this.#done = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    if (this.#resume !== undefined) { clearTimeout(this.#resume); this.#resume = undefined; }
    this.#continue();
  }
}

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One process of a run, as the host sees it (card L02d). `name` is printable ASCII only (a program can rename itself); a command line is never read for it (it may carry a secret). */
export interface RunProcess {
  readonly pid: number;
  /** Its parent's process ID (0 when not known). */
  readonly parent: number;
  readonly name: string;
  /** The process's start time as the OS counts it: with `pid` it names one process, since a process ID can be reused by another program. */
  readonly started: string;
}

/** At most this many processes of one run are listed; a run with more is reported cut (`truncated`). */
export const MAX_RUN_PROCESSES = 200;

const cleanName = (raw: string): string => raw.trim().replace(/[^\x20-\x7e]/g, "?").slice(0, 40) || "unknown";

/** Reads one /proc/<pid>/stat: the name sits between the first `(` and the last `)` (it may hold spaces or parentheses); after it come the state, the parent, ... and the start time (field 22). A zombie (state Z) has ended. */
function readStat(proc: string, pid: number): { parent: number; name: string; started: string; zombie: boolean } | undefined {
  let stat: string;
  try { stat = readFileSync(join(proc, String(pid), "stat"), "utf8"); } catch { return undefined; }
  const open = stat.indexOf("("), close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const rest = stat.slice(close + 2).split(" ");
  const parent = Number(rest[1]);
  const started = rest[19];
  if (started === undefined || !Number.isSafeInteger(parent)) return undefined;
  return { parent, name: cleanName(stat.slice(open + 1, close)), started, zombie: rest[0] === "Z" || rest[0] === "X" };
}

/**
 * The process `root` and every process below it that is alive now, read from Linux's /proc (`proc`, injectable for tests), root first and each parent before its children (card L02d). A zombie is not alive. Empty when `root` is gone.
 * At most `MAX_RUN_PROCESSES`; `truncated` says there were more.
 */
export function linuxProcessTree(root: number, proc = "/proc"): { readonly processes: readonly RunProcess[]; readonly truncated: boolean } {
  let names: string[];
  try { names = readdirSync(proc); } catch { throw new Error("the process list cannot be read"); }
  const children = new Map<number, number[]>();
  const stats = new Map<number, { parent: number; name: string; started: string }>();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const s = readStat(proc, pid);
    if (s === undefined || s.zombie) continue;
    stats.set(pid, s);
    children.set(s.parent, [...(children.get(s.parent) ?? []), pid]);
  }
  const top = stats.get(root);
  if (top === undefined) return { processes: [], truncated: false };
  const out: RunProcess[] = [{ pid: root, ...top }];
  let truncated = false;
  const seen = new Set<number>([root]);
  for (let i = 0; i < out.length; i++) {
    for (const pid of (children.get(out[i]!.pid) ?? []).sort((a, b) => a - b)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (out.length >= MAX_RUN_PROCESSES) { truncated = true; continue; }
      out.push({ pid, ...stats.get(pid)! });
    }
  }
  return { processes: out, truncated };
}

/** Which of these processes are still the same processes (same start time, not a zombie), from Linux's /proc. */
export function linuxStillRunning(processes: readonly RunProcess[], proc = "/proc"): RunProcess[] {
  return processes.filter((p) => { const s = readStat(proc, p.pid); return s !== undefined && !s.zombie && s.started === p.started; });
}

/** Programs that make the confinement itself (the sandbox's own processes above the launched program), not the agent's work. */
const CONFINEMENT = new Set(["bwrap", "sandbox-exec"]);
/** At most this many confinement processes stand above the program (bubblewrap's monitor and its process 1). Below them the process is the program whatever it calls itself: a name is the program's own choice, so a process named `bwrap` deeper down is never taken as the confinement (review of L02d). */
const MAX_CONFINEMENT = 2;

/**
 * Splits a run's process tree (root first, parents before children) into the run's own processes and the work the agent started (card L02d). The run's own processes are the confinement (bubblewrap's, Seatbelt's) down to the
 * launched program: the first process, oldest first, below the confinement that is not one of its programs. Everything else (what the program started, and anything the confinement adopted when its parent ended) is the agent's work.
 * `program` is undefined while the confinement has not started it yet.
 */
export function splitRunTree(tree: readonly RunProcess[]): { readonly own: readonly RunProcess[]; readonly program: RunProcess | undefined; readonly started: readonly RunProcess[] } {
  if (tree.length === 0) return { own: [], program: undefined, started: [] };
  const own: RunProcess[] = [];
  let at: RunProcess | undefined = tree[0];
  let program: RunProcess | undefined;
  while (at !== undefined) {
    own.push(at);
    if (!CONFINEMENT.has(at.name) || own.length > MAX_CONFINEMENT) { program = at; break; }
    const parent: RunProcess = at;
    // The oldest child goes on the chain (the confinement starts the program before anything else can exist below it).
    at = tree.filter((p) => p.parent === parent.pid).sort((a, b) => (a.started === b.started ? a.pid - b.pid : Number(a.started) - Number(b.started)))[0];
  }
  const ownSet = new Set(own.map((p) => p.pid));
  return { own, program, started: tree.filter((p) => !ownSet.has(p.pid)) };
}

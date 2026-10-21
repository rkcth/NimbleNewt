import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BackendHealth, GuestView, SandboxBackend, SpawnPlan } from "./backend.js";
import { SandboxError } from "./errors.js";
import { normalizeRecipe, type NormalizedRecipe } from "./recipe.js";

const run = promisify(execFile);
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface SeatbeltOptions {
  /** The program, as an absolute path. Default: `/usr/bin/sandbox-exec`. */
  readonly executable?: string;
}

/**
 * The deny-by-default profile. Paths are never written into it: they are passed as parameters (`-D`) and read with `(param ...)`, so no path can alter the profile. Reading the system
 * (programs, libraries, the dynamic linker's cache) is allowed; reading and writing the user's files is allowed only in the agent's own directories; network is denied; the agent's
 * protected names are read-only on top of its checkout. Looking at a file's existence and size (file-read-metadata) is allowed everywhere, because path lookup needs it: denied paths are
 * therefore visible but unreadable, one of the stated differences from Linux.
 */
export function profileFor(recipe: NormalizedRecipe): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    // Programs run from the system, the developer tools and the agent's own directories only, not from anywhere the user can read.
    '(allow process-exec* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library/Developer/CommandLineTools") (subpath (param "WORK")) (subpath (param "HOME")) (subpath (param "SCRATCH")))',
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    // Every program reads the root directory itself when it starts (found by running the profile on a Mac: without this even /usr/bin/true is killed at launch).
    '(allow file-read-data (literal "/"))',
    '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library/Frameworks") (subpath "/Library/Developer/CommandLineTools") (subpath "/Library/Preferences/Logging") (subpath "/private/etc") (subpath "/private/var/db/dyld") (subpath "/private/var/db/timezone") (subpath "/private/var/select"))',
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/tty") (regex #"^/dev/fd/"))',
    '(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-read* file-write* (subpath (param "WORK")) (subpath (param "HOME")) (subpath (param "SCRATCH")))',
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.logd") (global-name "com.apple.diagnosticd") (global-name "com.apple.trustd.agent"))',
    '(allow ipc-posix-shm-read-data ipc-posix-shm-read-metadata (ipc-posix-name "apple.shm.notification_center"))',
    "(allow file-ioctl)",
  ];
  recipe.readOnly.forEach((_m, i) => lines.push(`(allow file-read* process-exec* (subpath (param "RO${i}")))`));
  recipe.protectedSubpaths.forEach((_n, i) => lines.push(`(deny file-write* (subpath (param "PROT${i}")))`));
  lines.push("(deny network*)");
  return lines.join("\n");
}

/** Everything the launcher parameterises: names to host paths. */
function parameters(recipe: NormalizedRecipe, tmp: string): [string, string][] {
  return [
    ["WORK", recipe.workdir], ["HOME", recipe.home], ["SCRATCH", recipe.scratch], ["TMP", tmp],
    ...recipe.readOnly.map((m, i) => [`RO${i}`, m.host] as [string, string]),
    ...recipe.protectedSubpaths.map((name, i) => [`PROT${i}`, join(recipe.workdir, name)] as [string, string]),
  ];
}

/**
 * The macOS backend (card A03, decision of 2026-10-21): Seatbelt profiles through `sandbox-exec`. It confines the process by what the kernel allows it to do, not by building a different
 * filesystem view, so the agent sees host paths for its checkout, home and scratch (`guestView` says which), and it is weaker than the Linux sandbox in the ways the decision record lists:
 * process-level confinement, denied paths visible but unreadable, and no private process list (the launcher finds and ends a run's descendants itself).
 */
export function seatbeltBackend(options: SeatbeltOptions = {}): SandboxBackend {
  const executable = options.executable ?? "/usr/bin/sandbox-exec";
  const tmpOf = (recipe: NormalizedRecipe): string => join(recipe.scratch, ".tmp");

  const plan = (recipe: NormalizedRecipe, command: readonly string[]): SpawnPlan => {
    const tmp = tmpOf(recipe);
    // Created here, outside the sandbox, as the service user: it must be a plain directory, never a link someone left in the agent's scratch.
    let existing;
    try { existing = lstatSync(tmp); } catch { existing = undefined; }
    if (existing !== undefined && (existing.isSymbolicLink() || !existing.isDirectory())) throw new SandboxError("invalid_recipe", `${tmp} is not a plain directory; the agent's temporary directory must be`);
    if (existing === undefined) mkdirSync(tmp, { mode: 0o700 });
    const args: string[] = [];
    for (const [name, value] of parameters(recipe, tmp)) args.push("-D", `${name}=${value}`);
    args.push("-p", profileFor(recipe), ...command);
    return { file: executable, args, env: { ...recipe.env, HOME: recipe.home, PATH: SYSTEM_PATH, TMPDIR: tmp }, cwd: recipe.workdir };
  };

  return {
    name: "seatbelt",
    plan,
    guestView: (recipe): GuestView => ({ workdir: recipe.workdir, home: recipe.home, scratch: recipe.scratch, tmp: tmpOf(recipe), inputs: recipe.readOnly.map((m) => ({ host: m.host, guest: m.host })) }),
    async descendants(pid: number): Promise<readonly { pid: number; started: string }[]> {
      try {
        const out = await run("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart="], { timeout: 5000 });
        const children = new Map<number, { pid: number; started: string }[]>();
        for (const line of out.stdout.split("\n")) {
          const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
          if (m !== null) children.set(Number(m[2]), [...(children.get(Number(m[2])) ?? []), { pid: Number(m[1]), started: m[3]! }]);
        }
        const found: { pid: number; started: string }[] = [];
        for (let queue = [pid]; queue.length > 0;) { const next = queue.shift()!; for (const c of children.get(next) ?? []) { found.push(c); queue.push(c.pid); } }
        return found;
      } catch { return []; }
    },
    async startTimes(pids: readonly number[]): Promise<ReadonlyMap<number, string>> {
      const times = new Map<number, string>();
      if (pids.length === 0) return times;
      try {
        const out = await run("/bin/ps", ["-p", pids.join(","), "-o", "pid=,lstart="], { timeout: 5000 }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
        for (const line of out.stdout.split("\n")) { const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line); if (m !== null) times.set(Number(m[1]), m[2]!); }
      } catch { /* nothing known: nothing will be ended */ }
      return times;
    },
    async health(): Promise<BackendHealth> {
      if (!existsSync(executable)) return { healthy: false, backend: "seatbelt", reason: `${executable} was not found; this system does not provide sandbox-exec` };
      let probe: string | undefined;
      try {
        probe = realpathSync(mkdtempSync(join(tmpdir(), "nimblenewt-probe-")));
        for (const d of ["work", "home", "scratch", "outside"]) mkdirSync(join(probe, d));
        writeFileSync(join(probe, "secret.txt"), "secret");
        const recipe = normalizeRecipe({ mode: "sandboxed", workdir: join(probe, "work"), home: join(probe, "home"), scratch: join(probe, "scratch"), readOnly: [], network: "none", env: { PROBE_OUT: join(probe, "outside"), PROBE_SECRET: join(probe, "secret.txt") }, protectedSubpaths: [] }, []);
        // A loopback listener to try to reach: an unconfined connection must work (so the check means something) and the confined one must not.
        const listener = createServer((socket) => socket.end());
        await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
        const port = (listener.address() as { port: number }).port;
        let out: { stdout: string };
        try {
          const control = await run("/usr/bin/nc", ["-z", "-w", "2", "127.0.0.1", String(port)], { timeout: 10_000 }).then(() => true, () => false);
          if (!control) return { healthy: false, backend: "seatbelt", reason: "the network check could not be made: /usr/bin/nc could not reach a loopback listener even without the sandbox" };
          const script = `/usr/bin/touch "$PWD/ok" && ! /usr/bin/touch "$PROBE_OUT/denied" 2>/dev/null && ! /bin/cat "$PROBE_SECRET" >/dev/null 2>&1 && ! /usr/bin/nc -z -w 2 127.0.0.1 ${port} >/dev/null 2>&1 && echo confined`;
          const spawnPlan = plan(recipe, ["/bin/sh", "-c", script]);
          out = await run(spawnPlan.file, [...spawnPlan.args], { timeout: 20_000, env: { ...spawnPlan.env }, cwd: spawnPlan.cwd });
        } finally { await new Promise<void>((resolve) => listener.close(() => resolve())); }
        if (out.stdout.trim() !== "confined") return { healthy: false, backend: "seatbelt", reason: "the confinement probe ran but did not show that writes, reads and network connections outside the agent's own directories were denied" };
        return { healthy: true, backend: "seatbelt" };
      } catch (error) {
        const e = error as NodeJS.ErrnoException & { stderr?: string };
        if (e.code === "ENOENT") return { healthy: false, backend: "seatbelt", reason: `${executable} was not found; this macOS does not provide sandbox-exec` };
        const extra = e as unknown as { stdout?: string; code?: number | string; signal?: string };
        const detail = [`exit ${String(extra.code ?? "?")}`, extra.signal === undefined || extra.signal === null ? "" : `signal ${extra.signal}`, (e.stderr ?? "").trim().split("\n").slice(-2).join(" "), (extra.stdout ?? "").trim().slice(0, 100)].filter((x) => x !== "").join("; ");
        return { healthy: false, backend: "seatbelt", reason: `sandbox-exec could not run a confined probe (${detail}). The tool is deprecated by Apple; a macOS update may have changed it` };
      } finally {
        if (probe !== undefined) rmSync(probe, { recursive: true, force: true });
      }
    },
  };
}

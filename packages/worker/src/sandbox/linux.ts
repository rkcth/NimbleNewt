import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BackendHealth, SandboxBackend, SpawnPlan } from "./backend.js";
import { SandboxError } from "./errors.js";
import { GUEST, normalizeRecipe, type NormalizedRecipe } from "./recipe.js";

const run = promisify(execFile);
const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"] as const;
/** Read-only files the dynamic loader and command alternatives look for; a missing one is skipped. */
const SYSTEM_EXTRAS = ["/etc/ld.so.cache", "/etc/alternatives"] as const;
const GUEST_PATH = "/usr/bin:/bin";

export interface BubblewrapOptions {
  /** The bubblewrap program. Default: `bwrap`, found on PATH. */
  readonly executable?: string;
}

/**
 * The Linux backend (card A03, decision of 2026-10-21): bubblewrap. Every namespace is unshared (so no network, a private process list and
 * a private /tmp), only the recipe's directories are bound in, system directories are read-only, the environment is cleared, the session
 * is new, capabilities are dropped, and the whole tree dies with the launcher.
 */
export function bubblewrapBackend(options: BubblewrapOptions = {}): SandboxBackend {
  const executable = options.executable ?? "bwrap";

  const plan = (recipe: NormalizedRecipe, command: readonly string[]): SpawnPlan => {
    const args: string[] = ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--hostname", "sandbox", "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
    for (const dir of SYSTEM_DIRS) {
      let stats;
      try { stats = lstatSync(dir); } catch { continue; }
      if (stats.isSymbolicLink()) args.push("--symlink", readlinkSync(dir), dir);
      else if (stats.isDirectory()) args.push("--ro-bind", dir, dir);
    }
    for (const extra of SYSTEM_EXTRAS) args.push("--ro-bind-try", extra, extra);
    args.push("--bind", recipe.workdir, GUEST.work, "--bind", recipe.home, GUEST.home, "--bind", recipe.scratch, GUEST.scratch);
    for (const mount of recipe.readOnly) args.push("--ro-bind", mount.host, mount.guest);
    for (const name of recipe.protectedSubpaths) {
      if (recipe.unprotectedSubpaths.includes(name)) continue;
      // Checked again now, right before the start, so a name swapped for a link since the recipe was normalised is not bound.
      const source = join(recipe.workdir, name);
      let real: string;
      try { real = realpathSync(source); } catch { throw new SandboxError("invalid_recipe", `protectedSubpaths: ${source} disappeared before the launch`); }
      if (real !== source) throw new SandboxError("invalid_recipe", `protectedSubpaths: ${source} changed to point at ${real} before the launch`);
      args.push("--ro-bind", source, `${GUEST.work}/${name}`);
    }
    // The root is a memory-backed directory that bubblewrap builds; made read-only so that nothing can even be created outside the mounts.
    args.push("--remount-ro", "/", "--remount-ro", "/dev", "--chdir", GUEST.work, "--setenv", "HOME", GUEST.home, "--setenv", "PATH", GUEST_PATH, "--setenv", "TMPDIR", "/tmp");
    for (const [name, value] of Object.entries(recipe.env)) args.push("--setenv", name, value);
    args.push("--", ...command);
    return { file: executable, args, env: {} };
  };

  return {
    name: "bubblewrap",
    plan,
    async health(): Promise<BackendHealth> {
      let version: string;
      try {
        const out = await run(executable, ["--version"], { timeout: 10_000, env: {} });
        version = out.stdout.trim().replace(/^bubblewrap\s+/, "");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { healthy: false, backend: "bubblewrap", reason: code === "ENOENT" ? `bubblewrap (${executable}) is not installed; install the bubblewrap package` : `bubblewrap did not report a version: ${(error as Error).message}` };
      }
      const probe = mkdtempSync(join(tmpdir(), "nimblenewt-probe-"));
      try {
        const dirs = { work: join(probe, "work"), home: join(probe, "home"), scratch: join(probe, "scratch") };
        for (const d of Object.values(dirs)) mkdirSync(d);
        const recipe = normalizeRecipe({ mode: "sandboxed", workdir: dirs.work, home: dirs.home, scratch: dirs.scratch, readOnly: [], network: "none", env: {}, protectedSubpaths: [] }, []);
        // A real confined start: the program runs, its network holds only the loopback interface, and the probe's own directory is invisible.
        const spawnPlan = plan(recipe, ["/bin/sh", "-c", `[ "$(tail -n +3 /proc/net/dev | wc -l)" = 1 ] && [ ! -e ${JSON.stringify(probe)} ] && echo confined`]);
        const out = await run(spawnPlan.file, [...spawnPlan.args], { timeout: 15_000, env: { ...spawnPlan.env } });
        if (out.stdout.trim() !== "confined") return { healthy: false, backend: "bubblewrap", version, reason: "the confinement probe ran but did not show an isolated network and filesystem" };
        return { healthy: true, backend: "bubblewrap", version };
      } catch (error) {
        const detail = ((error as { stderr?: string }).stderr ?? (error as Error).message).trim().split("\n").slice(-2).join(" ");
        return { healthy: false, backend: "bubblewrap", version, reason: `bubblewrap is installed but cannot start a sandbox here (${detail}). Unprivileged user namespaces may be disabled or restricted by the system` };
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
    },
  };
}

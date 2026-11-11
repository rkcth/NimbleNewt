import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SandboxError } from "../sandbox/errors.js";
import type { SandboxLauncher } from "../sandbox/launcher.js";
import { removeTree, type InterpreterInstall } from "../sandbox/script.js";
import type { InstallScriptPort } from "./agent-environments.js";

export interface SandboxInstallScriptsOptions {
  readonly launcher: Pick<SandboxLauncher, "launch" | "capacity">;
  /** The Node.js the scripts run with (a directory that holds it and what it loads, mounted read-only, and the executable inside it). */
  readonly interpreter: InterpreterInstall;
  /** A real, private directory outside the controller's data directory where each run gets an empty home and scratch (removed afterwards). */
  readonly base: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly limits?: { readonly cpus: number; readonly memoryMb: number };
  /** Refuse a run unless the launcher enforces every limit in full (default true). */
  readonly requireEnforced?: boolean;
  readonly onLeftover?: (directory: string, reason: string) => void;
}

/**
 * Runs a package's install scripts through the sandbox launcher: the only way an install script runs. The package's own directory is the working directory (the one writable place besides an empty home and scratch), the interpreter
 * is read-only, the environment is empty, there is no network (the recipe has no other mode), and time, output and resources are bounded. Nothing of the host outside those is visible. A host without a usable sandbox runs none.
 */
export function sandboxInstallScripts(options: SandboxInstallScriptsOptions): InstallScriptPort {
  return {
    async run({ dir, entry, phase, packageName }) {
      if (!options.launcher.capacity.available) throw new Error(`this host cannot confine install scripts, so none is run: ${options.launcher.capacity.reason ?? "no sandbox"}`);
      const linux = options.launcher.capacity.backend === "bubblewrap";
      if (!linux) throw new Error("install scripts run only inside bubblewrap on this host");
      const scratch = realpathSync(mkdtempSync(join(options.base, "install-")));
      try {
        mkdirSync(join(scratch, "home")); mkdirSync(join(scratch, "scratch"));
        const run = await options.launcher.launch({
          recipe: { mode: "sandboxed", workdir: dir, home: join(scratch, "home"), scratch: join(scratch, "scratch"), readOnly: [{ host: options.interpreter.root, guest: "/opt/interpreter" }], network: "none", env: {}, protectedSubpaths: [] },
          command: [`/opt/interpreter/${options.interpreter.executable}`, entry],
          timeoutMs: options.timeoutMs ?? 60_000, maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
          limits: options.limits ?? { cpus: 1, memoryMb: 512 }, requireEnforced: options.requireEnforced ?? true,
        });
        const result = await run.result;
        const tail = result.stderr.trim().slice(-300);
        if (result.releaseProblem !== undefined) throw new Error(`the sandbox could not be cleaned up after the ${phase} script of ${packageName}`);
        if (result.timedOut) throw new Error("the script ran longer than its limit and was stopped");
        if (result.killed) throw new Error("the script was stopped before it finished");
        if (result.exitCode === null && result.signal === null) throw new Error(`the script could not be started${tail === "" ? "" : `: ${tail}`}`);
        if (result.exitCode !== 0) throw new Error(`the script exited with ${result.signal === null ? `code ${String(result.exitCode)}` : result.signal}${tail === "" ? "" : `: ${tail}`}`);
      } catch (error) {
        if (error instanceof SandboxError) throw new Error(`the sandbox refused the script: ${error.message}`);
        throw error;
      } finally { await removeTree(scratch, options.onLeftover); }
    },
  };
}

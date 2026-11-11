import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { LocalEnvironmentRuntime, type LocalEnvironmentRuntimeOptions } from "./runtime.js";

export interface LocalEnvironmentHostOptions extends LocalEnvironmentRuntimeOptions {
  /** Paths no environment may sit in or hold (the controller's data directory and anything with secrets): the sandbox refuses mounts that overlap them. */
  readonly protectedPaths?: readonly string[];
  /** For tests: the platform to judge (default this one). */
  readonly platform?: NodeJS.Platform;
}

export interface LocalEnvironmentHost {
  /** The runtime to pass as `maintenance.environmentRuntime` of `startController`; absent when `problem` says why this host cannot have one. */
  readonly runtime: LocalEnvironmentRuntime | undefined;
  /** Why this host does not change environments (and so approved changes wait), or `undefined`. Say it at start. */
  readonly problem: string | undefined;
  /**
   * What a named reach of the recipe stands for (`LocalHostOptions.reach`): `environment` mounts the agent's verified active packages read-only at /opt/environment and names it in `NN_ENVIRONMENT`; any other name is not this
   * function's to answer (`undefined`). An agent with no active revision gets an empty grant.
   */
  readonly reach: (name: string, order: { readonly agentId: string }) => Promise<{ readonly readOnly?: readonly { readonly host: string; readonly guest: string }[]; readonly env?: Readonly<Record<string, string>> } | undefined>;
}

/**
 * Builds the local environment runtime when this host can have one, and says why when it cannot (card A09 follow-up): Linux only (the sandbox that runs install scripts and mounts an environment is bubblewrap, and file semantics here are
 * Linux's), the directory must be private, a real directory and clear of every protected path. A host that fails any of this is given no runtime, so the controller leaves approved changes pending rather than claim an install it cannot make.
 */
export function localEnvironmentHost(options: LocalEnvironmentHostOptions): LocalEnvironmentHost {
  const none = (problem: string): LocalEnvironmentHost => ({ runtime: undefined, problem, reach: async () => undefined });
  if ((options.platform ?? process.platform) !== "linux") return none("changing an agent's environment is supported only on Linux so far; approved changes wait");
  const root = resolve(options.root);
  for (const guarded of options.protectedPaths ?? []) {
    let real = guarded;
    try { real = realpathSync(guarded); } catch { /* compared as given */ }
    for (const p of [real, resolve(guarded)]) if (root === p || root.startsWith(p + sep) || p.startsWith(root + sep)) return none(`the environments directory ${root} overlaps the protected path ${guarded}; put it beside the data directory`);
  }
  let runtime: LocalEnvironmentRuntime;
  try { runtime = new LocalEnvironmentRuntime(options); } catch (error) { return none(`the environments directory could not be prepared: ${String((error as Error).message).slice(0, 200)}`); }
  return {
    runtime, problem: undefined,
    async reach(name, order) {
      if (name !== "environment") return undefined;
      const packages = await runtime.activePackages(order.agentId);
      return packages === undefined ? {} : { readOnly: [{ host: packages, guest: "/opt/environment" }], env: { NN_ENVIRONMENT: "/opt/environment" } };
    },
  };
}

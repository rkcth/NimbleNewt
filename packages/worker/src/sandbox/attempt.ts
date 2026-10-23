import { isAbsolute, normalize, sep } from "node:path";
import { SandboxError } from "./errors.js";
import type { SandboxRecipe } from "./recipe.js";

/** What the dispatcher's order and the Git bridge (card A04) give the worker host for one attempt. */
export interface AttemptSandboxPlan {
  /** The agent's checkout (host side): the only part of its repository the agent sees, as `/work`. */
  readonly checkout: string;
  /** The agent's separate git directory (made by the Git bridge, outside the checkout): never mounted. */
  readonly gitDir: string;
  readonly home: string;
  readonly scratch: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly readOnly?: readonly { readonly host: string; readonly guest: string }[];
}

const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
const bad = (message: string): never => { throw new SandboxError("invalid_recipe", message); };

/**
 * The sandbox for one attempt (card H12): a recipe that mounts the checkout, the agent's home and scratch and the read-only inputs, and nothing of the agent's git directory, together with the protected
 * paths for the launcher, which now include that git directory: a recipe that mounts it, or any directory that contains it, is refused by the launcher's own checks. The checkout's `.git` entry (the
 * pointer file to the separate directory) stays a protected sub-path, bound read-only when it exists. A git directory inside the checkout, the home, the scratch or a read-only input would be reachable
 * and is refused here.
 */
export function attemptSandbox(plan: AttemptSandboxPlan, base: { readonly protectedPaths: readonly string[] }): { readonly recipe: SandboxRecipe; readonly protectedPaths: readonly string[] } {
  if (plan === null || typeof plan !== "object") return bad("an attempt sandbox plan is an object");
  for (const [label, path] of [["checkout", plan.checkout], ["gitDir", plan.gitDir], ["home", plan.home], ["scratch", plan.scratch]] as const) {
    if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path) return bad(`${label}: must be an absolute, normalised path`);
  }
  const reachable = [["checkout", plan.checkout], ["home", plan.home], ["scratch", plan.scratch], ...(plan.readOnly ?? []).map((m, i) => [`readOnly[${i}]`, m.host] as const)] as const;
  for (const [label, path] of reachable) if (overlaps(path, plan.gitDir)) return bad(`gitDir: ${plan.gitDir} overlaps the ${label} (${path}); the agent's git directory must be outside everything the sandbox mounts`);
  return {
    recipe: { mode: "sandboxed", workdir: plan.checkout, home: plan.home, scratch: plan.scratch, readOnly: plan.readOnly ?? [], network: "none", env: plan.env ?? {}, protectedSubpaths: [".git"] },
    protectedPaths: [...base.protectedPaths, plan.gitDir],
  };
}

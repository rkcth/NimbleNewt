import type { NormalizedRecipe } from "./recipe.js";

/** How to start one confined process: the program, its arguments, its whole environment and the directory to start in. */
export interface SpawnPlan {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface BackendHealth {
  readonly healthy: boolean;
  readonly backend: string;
  readonly version?: string;
  /** When unhealthy: why, in words the owner can act on. */
  readonly reason?: string;
}

/**
 * One OS mechanism for confinement (bubblewrap on Linux; Seatbelt and Windows Sandbox are separate backends). A backend only plans how a
 * confined process starts and proves itself with `health`; the launcher owns audit, capacity, time limits and killing.
 */
export interface SandboxBackend {
  readonly name: string;
  /** Proves, by really starting a confined probe, that this backend confines on this host right now. */
  health(): Promise<BackendHealth>;
  plan(recipe: NormalizedRecipe, command: readonly string[]): SpawnPlan;
}

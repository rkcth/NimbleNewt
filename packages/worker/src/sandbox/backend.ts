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
  /** Facts the owner should see with the capacity, healthy or not (for example that a backend only works while someone is signed in). */
  readonly notes?: readonly string[];
}

/** The paths the agent sees for the things in its recipe. On Linux they are fixed names inside the sandbox; where the OS has no private view of the filesystem (macOS) they are the host paths. */
export interface GuestView {
  readonly workdir: string;
  readonly home: string;
  readonly scratch: string;
  /** A temporary directory private to the agent (TMPDIR). */
  readonly tmp: string;
  /** Each read-only input at the path the agent finds it. */
  readonly inputs: readonly { readonly host: string; readonly guest: string }[];
}

/**
 * One OS mechanism for confinement (bubblewrap on Linux; Seatbelt and Windows Sandbox are separate backends). A backend only plans how a
 * confined process starts and proves itself with `health`; the launcher owns audit, capacity, time limits and killing.
 */
export interface SandboxBackend {
  readonly name: string;
  /**
   * Whether the sandbox has a network of its own (a private loopback no other process can reach), so that a recipe's route (card H12i: the proxy the worker process serves on its loopback) is reachable only by the sandboxed program. True for bubblewrap. A
   * backend without it (Seatbelt shares the host's loopback; the Windows guest's networking is not proven private) refuses a recipe that has a route: another process on the machine could otherwise use the proxy of this task's grants.
   */
  readonly privateNetwork?: boolean;
  /** Proves, by really starting a confined probe, that this backend confines on this host right now. */
  health(): Promise<BackendHealth>;
  /** `runId` is the launch's own id (the launcher plans twice for one launch and passes the same id both times), for a mechanism that keeps per-launch state. */
  plan(recipe: NormalizedRecipe, command: readonly string[], runId?: string): SpawnPlan;
  /** Where the agent finds what the recipe gives it. */
  guestView(recipe: NormalizedRecipe): GuestView;
  /** Every process the launched one started, found now, each with its start time (for a mechanism that has no private process list). Optional. */
  descendants?(pid: number): Promise<readonly { readonly pid: number; readonly started: string }[]>;
  /** The start time of each of these processes that is still running, in one look. A process id can be reused, so a process is ended only if its start time still matches the one seen. Needed with `descendants`. */
  startTimes?(pids: readonly number[]): Promise<ReadonlyMap<number, string>>;
  /** Backend facts written into every launch record (the Windows backend: its mode and that it depends on the signed-in session). Plain strings, never secrets. Optional. */
  auditDetails?(): Readonly<Record<string, string>>;
  /** Called once a run has ended, however it ended (also after a kill): ends what the mechanism itself may have left, such as a sandbox VM. It is given the plan the run started with. Optional. */
  release?(plan: SpawnPlan): Promise<void>;
}

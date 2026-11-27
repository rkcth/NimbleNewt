import type { BackendHealth, SandboxBackend } from "./backend.js";
import { SandboxError } from "./errors.js";
import { windowsDefaultBackend } from "./windows-native.js";

/*
 * Card G05 on Windows: the backend the containment suite runs against there. Since card A03b (2026-11-25) it is the native launcher (windows-native.ts, `windowsDefaultBackend`), configured from the
 * environment the administrator's install step sets (NIMBLENEWT_WIN_LAUNCHER, NIMBLENEWT_WIN_CONTROL_DIR, NIMBLENEWT_WIN_CONTAINER, NIMBLENEWT_WIN_PROFILE). Where it is not installed (a hosted runner
 * before the install step), its health check says so and the suite reports every case `not_run` with that reason. (The Windows Sandbox variant was removed: owner decision 2026-11-26.)
 *
 * Nothing here enables a Windows feature, signs anyone in or changes the registry.
 */

/** A backend that never has capacity, carrying the reason. Used when a backend could not even be configured, so the report says why instead of throwing. */
export function unavailableBackend(name: string, reason: string): SandboxBackend {
  const health = async (): Promise<BackendHealth> => ({ healthy: false, backend: name, reason });
  return {
    name,
    health,
    plan: () => { throw new SandboxError("unavailable", reason); },
    guestView: (recipe) => ({ workdir: recipe.workdir, home: recipe.home, scratch: recipe.scratch, tmp: recipe.scratch, inputs: [] }),
  };
}

/**
 * The backend the G05 suite uses on Windows (card A03b): the native launcher, configured from the environment the administrator's install step sets (see `windowsDefaultBackend`). Never throws: where it
 * cannot be configured, or the launcher is not installed, it has no capacity and says why, so every case is reported `not_run` with that reason. The cases themselves are one node program the container
 * runs (the `windows-node` dialect, containment-windows-cases.ts), because the container refuses cmd.exe starting programs.
 */
export function windowsEvidenceBackend(env: NodeJS.ProcessEnv = process.env): SandboxBackend {
  return windowsDefaultBackend(env, process.platform);
}

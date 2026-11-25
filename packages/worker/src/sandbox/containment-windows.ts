import { tmpdir } from "node:os";
import { win32 } from "node:path";
import type { BackendHealth, SandboxBackend } from "./backend.js";
import { SandboxError } from "./errors.js";
import { windowsRealHost } from "./windows-real.js";
import { windowsSandboxBackend } from "./windows.js";
import { windowsDefaultBackend } from "./windows-native.js";

/*
 * Card G05 on Windows: the backend the containment suite runs against there. Since card A03b (2026-11-25) it is the native launcher (windows-native.ts, `windowsDefaultBackend`), configured from the
 * environment the administrator's install step sets (NIMBLENEWT_WIN_LAUNCHER, NIMBLENEWT_WIN_CONTROL_DIR, NIMBLENEWT_WIN_CONTAINER, NIMBLENEWT_WIN_PROFILE). Where it is not installed (a hosted runner
 * before the install step), its health check says so and the suite reports every case `not_run` with that reason.
 *
 * The Windows Sandbox variant (`windowsSandboxEvidenceBackend`, below) is SUPERSEDED and kept only for the owner-hardware diagnostics. Its settings come from NIMBLENEWT_WSB_OWNER and
 * NIMBLENEWT_WSB_SHARE_IDENTITY (default: the account signed in at the console, found by `windowsConsoleUser`; `evidenceIdentity` says which default was taken), NIMBLENEWT_WSB_SUPERVISOR_ACL=report-only
 * (default strict) and NIMBLENEWT_G05_WSB_BASE for the supervisor's control and staging folders.
 *
 * Nothing here enables a Windows feature, signs anyone in or changes the registry.
 */

/** A backend that never has capacity, carrying the reason. Used when the Windows backend could not even be configured, so the report says why instead of throwing. */
export function unavailableBackend(name: string, reason: string): SandboxBackend {
  const health = async (): Promise<BackendHealth> => ({ healthy: false, backend: name, reason });
  return {
    name,
    health,
    plan: () => { throw new SandboxError("unavailable", reason); },
    guestView: (recipe) => ({ workdir: recipe.workdir, home: recipe.home, scratch: recipe.scratch, tmp: recipe.scratch, inputs: [] }),
  };
}

export type IdentitySource = "configured" | "console" | "runner";

/** The owner and share account of the evidence run, and where each came from: the environment, else the console user (when one was found), else the account running this. Pure. */
export function evidenceIdentity(env: NodeJS.ProcessEnv, consoleUser?: string): { owner: string; shareIdentity: string; ownerSource: IdentitySource; shareSource: IdentitySource } {
  const runner = `${env["USERDOMAIN"] ?? ""}\\${env["USERNAME"] ?? ""}`;
  const pick = (configured: string | undefined): [string, IdentitySource] => configured !== undefined && configured !== "" ? [configured, "configured"] : consoleUser !== undefined && consoleUser !== "" ? [consoleUser, "console"] : [runner, "runner"];
  const [owner, ownerSource] = pick(env["NIMBLENEWT_WSB_OWNER"]);
  const [shareIdentity, shareSource] = pick(env["NIMBLENEWT_WSB_SHARE_IDENTITY"]);
  return { owner, shareIdentity, ownerSource, shareSource };
}

/** The account signed in at the console of this Windows machine, or undefined (not Windows, nobody signed in, or the lookup failed). */
export async function windowsConsoleUser(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  try { return (await windowsRealHost().session()).consoleUser; } catch { return undefined; }
}

/**
 * The backend the G05 suite uses on Windows (card A03b): the native launcher, configured from the environment the administrator's install step sets (see `windowsDefaultBackend`). Never throws: where it
 * cannot be configured, or the launcher is not installed, it has no capacity and says why, so every case is reported `not_run` with that reason. The case scripts of the Windows dialect still start
 * programs through cmd.exe, which the container refuses; they must become node programs before the ten cases can give verdicts there (recorded in the A03b notes as not yet done).
 */
export function windowsEvidenceBackend(env: NodeJS.ProcessEnv = process.env, _consoleUser?: string): SandboxBackend {
  return windowsDefaultBackend(env, process.platform);
}

/** SUPERSEDED: the Windows Sandbox backend the G05 suite used on Windows. Kept for the owner-hardware diagnostics only. Never throws: a configuration problem becomes a backend without capacity that names it. */
export function windowsSandboxEvidenceBackend(env: NodeJS.ProcessEnv = process.env, consoleUser?: string): SandboxBackend {
  try {
    const { owner, shareIdentity } = evidenceIdentity(env, consoleUser);
    const base = env["NIMBLENEWT_G05_WSB_BASE"] ?? win32.join(env["RUNNER_TEMP"] ?? tmpdir(), "nn-g05-wsb");
    return windowsSandboxBackend({
      host: windowsRealHost(),
      controlDir: win32.join(base, "control"),
      stagingDir: win32.join(base, "staging"),
      owner,
      shareIdentity,
      nodeExecutable: process.execPath,
      supervisorAcl: env["NIMBLENEWT_WSB_SUPERVISOR_ACL"] === "report-only" ? "report-only" : "strict",
    });
  } catch (error) {
    return unavailableBackend("windows-sandbox", `the Windows Sandbox backend could not be configured: ${(error as Error).message}`);
  }
}

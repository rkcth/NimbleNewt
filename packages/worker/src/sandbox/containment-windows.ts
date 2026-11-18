import { tmpdir } from "node:os";
import { win32 } from "node:path";
import type { BackendHealth, SandboxBackend } from "./backend.js";
import { SandboxError } from "./errors.js";
import { windowsRealHost } from "./windows-real.js";
import { windowsSandboxBackend } from "./windows.js";

/*
 * Card G05 on Windows: the backend the containment suite runs against there. The launcher has no default backend on Windows (card A03b builds the Windows Sandbox backend and
 * its wiring), so the suite builds it here through the existing `windowsSandboxBackend` interface with the real host. JOIN POINT: when A03b gives `SandboxLauncher` a default Windows
 * backend (or a factory for one), this file should call that instead of repeating the settings.
 *
 * Settings come from the environment, with the same names the real Windows Sandbox tests use (windows-real.test.ts): NIMBLENEWT_WSB_OWNER and NIMBLENEWT_WSB_SHARE_IDENTITY
 * (default: the account running the suite), NIMBLENEWT_WSB_SUPERVISOR_ACL=report-only (default strict, which is what release evidence needs), and NIMBLENEWT_G05_WSB_BASE for the
 * supervisor's control and staging folders (default: a folder under the runner's or the system's temporary directory).
 *
 * Nothing here enables a Windows feature, signs anyone in or changes the registry. Where Windows Sandbox is not installed (a GitHub-hosted Windows runner, which cannot run it),
 * the backend's own health check says so and the suite reports every case `not_run` with that reason.
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

/** The Windows Sandbox backend the G05 suite uses on Windows. Never throws: a configuration problem becomes a backend without capacity that names it. */
export function windowsEvidenceBackend(env: NodeJS.ProcessEnv = process.env): SandboxBackend {
  try {
    const user = `${env["USERDOMAIN"] ?? ""}\\${env["USERNAME"] ?? ""}`;
    const base = env["NIMBLENEWT_G05_WSB_BASE"] ?? win32.join(env["RUNNER_TEMP"] ?? tmpdir(), "nn-g05-wsb");
    return windowsSandboxBackend({
      host: windowsRealHost(),
      controlDir: win32.join(base, "control"),
      stagingDir: win32.join(base, "staging"),
      owner: env["NIMBLENEWT_WSB_OWNER"] ?? user,
      shareIdentity: env["NIMBLENEWT_WSB_SHARE_IDENTITY"] ?? user,
      nodeExecutable: process.execPath,
      supervisorAcl: env["NIMBLENEWT_WSB_SUPERVISOR_ACL"] === "report-only" ? "report-only" : "strict",
    });
  } catch (error) {
    return unavailableBackend("windows-sandbox", `the Windows Sandbox backend could not be configured: ${(error as Error).message}`);
  }
}

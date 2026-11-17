import { rename } from "node:fs/promises";

/** The errors Windows gives a rename over a file that another process has open at that moment (until it closes it). */
const WINDOWS_SHARING = new Set(["EPERM", "EACCES", "EBUSY"]);

/** What a test may inject into `renameReplacing`: the rename, the platform it is judged by and the pause between tries. */
export interface RenameReplacingOptions { readonly platform?: NodeJS.Platform; readonly rename?: (from: string, to: string) => Promise<void>; readonly pause?: (ms: number) => Promise<void> }

/**
 * Renames `from` over `to`. On Windows a rename over a file another process has open at that moment fails (EPERM, EACCES or EBUSY) until that process closes it. For the launcher's file (where it was first
 * needed), the launcher's watchdog and the controller read it while both run: without a retry a confirmation, written once at the controller's start, could be lost to a read of the watchdog and the healthy start judged failed. So on
 * Windows those errors are retried a few times, about half a second in all; elsewhere a rename does not fail for that reason and is never retried. `rename` and `pause` are injectable for tests.
 * The same rule serves the trust mirror, the data directory lock's rewrite and the controller-down watchdog's records. It is a module of its own (no imports but `fs`), so the watchdog's small process
 * can use it without loading the launcher.
 */
export async function renameReplacing(from: string, to: string, o: RenameReplacingOptions = {}): Promise<void> {
  const tries = (o.platform ?? process.platform) === "win32" ? 10 : 1;
  const move = o.rename ?? rename;
  const wait = o.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try { await move(from, to); return; } catch (error) {
      if (attempt >= tries || !WINDOWS_SHARING.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await wait(10 * attempt);
    }
  }
}

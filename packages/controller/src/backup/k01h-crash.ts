import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOCK_FILE } from "./data-lock.js";

/** Where the child dies besides "after the nth rename": between the "done" record and the removal of the marker, or between the removal of the marker and that of the journal. */
export type CrashAt = number | "before-marker-removal" | "before-journal-removal";

/** What `import()` in the child is given for a module file: a file: URL (Node refuses a Windows path such as D:\\x\\y.js with ERR_UNSUPPORTED_ESM_URL_SCHEME). `windows` is for the unit test. */
export function importSpecifier(path: string, windows = false): string { return pathToFileURL(path, { windows }).href; }

/**
 * Test helper: runs `applyPendingRestore` in a CHILD process that really dies (process.exit) where asked, so the data directory is left as a crash leaves it. `at`: a number n dies right after the nth rename (journal written, some moves
 * made); "before-marker-removal" dies after the whole swap was made and recorded done, before anything of the clean-up; "before-journal-removal" after the marker was removed, before the journal was.
 * `piRoot`: the folder the conversation stores' live folders are in (`<piRoot>/<id>`). Returns the child's exit status (3 = it died where asked); anything else throws with what the child printed. The lock file the dead child left is removed
 * (no test should depend on its pid not being reused by another process).
 */
export function applyAndCrashAfter(dataDirectory: string, sqlite: string, piRoot: string, at: CrashAt): number | null {
  const module = importSpecifier(fileURLToPath(new URL("./staged-restore.js", import.meta.url)));
  const script = `
    import { renameSync } from "node:fs";
    import { rm } from "node:fs/promises";
    import { join } from "node:path";
    const { applyPendingRestore } = await import(${JSON.stringify(module)});
    const at = ${JSON.stringify(at)};
    let made = 0;
    // A rename another program briefly holds a file for (Windows: EBUSY, EPERM, EACCES) is tried again, as the real swap does.
    const rename = async (from, to) => {
      for (let attempt = 0; ; attempt++) {
        try { renameSync(from, to); break; } catch (error) {
          if (attempt >= 20 || !["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      made += 1; if (made === at) process.exit(3);
    };
    const remove = async (p) => {
      if (at === "before-marker-removal" && p.endsWith("pending-restore.json")) process.exit(3);
      await rm(p, { force: true });
      if (at === "before-journal-removal" && p.endsWith("pending-restore.json")) process.exit(3);
    };
    await applyPendingRestore(${JSON.stringify(dataDirectory)}, ${JSON.stringify(sqlite)}, undefined, { piFinal: (id) => join(${JSON.stringify(piRoot)}, id), rename, remove });
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  for (const dir of new Set([dataDirectory, dirname(sqlite)])) rmSync(join(dir, LOCK_FILE), { force: true });
  if (run.status !== 3) throw new Error(`the child did not die where asked (status ${String(run.status)}, signal ${String(run.signal)}, error ${String(run.error?.message)}): ${run.stderr.slice(0, 2000)}`);
  return run.status;
}

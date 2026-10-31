import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Test helper: runs `applyPendingRestore` in a CHILD process that really dies (process.exit) right after the `n`th rename, so the data directory is left as a crash leaves it (journal written, some moves made).
 * `piRoot`: the folder the conversation stores' live folders are in (`<piRoot>/<id>`). Returns the child's exit status (3 = it died where asked).
 */
export function applyAndCrashAfter(dataDirectory: string, sqlite: string, piRoot: string, n: number): number | null {
  const module = fileURLToPath(new URL("./staged-restore.js", import.meta.url));
  const script = `
    import { renameSync } from "node:fs";
    import { join } from "node:path";
    const { applyPendingRestore } = await import(${JSON.stringify(module)});
    let made = 0;
    const rename = async (from, to) => { renameSync(from, to); made += 1; if (made === ${n}) process.exit(3); };
    await applyPendingRestore(${JSON.stringify(dataDirectory)}, ${JSON.stringify(sqlite)}, undefined, { piFinal: (id) => join(${JSON.stringify(piRoot)}, id), rename });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true }).status;
}

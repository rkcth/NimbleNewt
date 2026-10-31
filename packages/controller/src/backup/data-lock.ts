import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { DomainError } from "../domain/errors.js";

/**
 * The data directory's exclusive lock (card K01h): one controller owns a data directory at a time, and the swap of a restored database into place (`applyPendingRestore`) needs it too, so two starts that overlap cannot
 * both swap, or swap under a running controller. The lock is a file made with `wx`; it names the process, the host and a nonce. A lock whose process is gone (same host) is stale and is taken over; a lock of a live process,
 * or of another host (which cannot be told), refuses with the holder named.
 */
export const LOCK_FILE = ".nn-data.lock";
export interface DataLock { readonly path: string; release(): Promise<void> }

/** The locks this process holds, by nonce: a lock file of this very process that is not in the set was leaked by a start that failed, and is taken over. */
const heldHere = new Set<string>();

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function acquireDataLock(dataDirectory: string, now: () => Date = () => new Date()): Promise<DataLock> {
  const path = join(dataDirectory, LOCK_FILE);
  const nonce = randomBytes(12).toString("hex");
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), nonce, at: now().toISOString() });
  await mkdir(dataDirectory, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(path, `${mine}\n`, { flag: "wx", mode: 0o600 });
      heldHere.add(nonce);
      let released = false;
      return { path, release: async () => { if (released) return; released = true; heldHere.delete(nonce); const now = await readFile(path, "utf8").catch(() => ""); if (now.includes(nonce)) await rm(path, { force: true }); } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder: { pid?: unknown; host?: unknown; nonce?: unknown; at?: unknown } | undefined;
    try { holder = JSON.parse(await readFile(path, "utf8")) as typeof holder; } catch { holder = undefined; }
    if (holder === undefined || typeof holder.pid !== "number") throw new DomainError("unavailable", `the data directory lock ${path} cannot be read; if no controller is running on this directory, remove the file`);
    const here = holder.host === hostname();
    const live = typeof holder.nonce === "string" && heldHere.has(holder.nonce) ? true : here && holder.pid !== process.pid ? alive(holder.pid) : !here;
    if (live) throw new DomainError("unavailable", `another controller holds this data directory (process ${holder.pid} on ${String(holder.host)}${typeof holder.at === "string" ? `, since ${holder.at}` : ""}); stop it first`);
    await rm(path, { force: true }); // stale: its process is gone
  }
  throw new DomainError("unavailable", "the data directory lock could not be taken");
}

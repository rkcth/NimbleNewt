export { LeaseLost, LeaseWatchdog, systemClock, type LossReason, type WatchdogClock, type WatchdogOptions } from "@nimblenewt/contracts";

/**
 * Ends a process and everything it started (contained termination): TERM to its process group, then KILL to the group if it is still there after `termMs`. Returns whether it is gone. The process must have been started
 * as its own group leader (`detached: true`); a pid that is not is refused, since its group would be ours.
 */
export async function killContained(pid: number, options: { termMs?: number; signal?: (pid: number, sig: NodeJS.Signals) => void; alive?: (pid: number) => boolean } = {}): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new RangeError("not a process this host may end");
  if (options.signal === undefined && options.alive === undefined) {
    // Its own group leader or nothing: `-pid` is a group only if the process leads one; otherwise the signal would miss it and the answer "gone" would be false.
    let exists = true; try { process.kill(pid, 0); } catch { exists = false; }
    if (exists) { try { process.kill(-pid, 0); } catch { throw new RangeError("the process is not its own group leader; it cannot be ended as a group"); } }
  }
  const termMs = options.termMs ?? 2000;
  const signal = options.signal ?? ((p, sig) => { try { process.kill(-p, sig); } catch { /* gone */ } });
  const alive = options.alive ?? ((p) => { try { process.kill(-p, 0); return true; } catch { return false; } });
  signal(pid, "SIGTERM");
  const until = Date.now() + termMs;
  while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  if (alive(pid)) { signal(pid, "SIGKILL"); const hard = Date.now() + 1000; while (alive(pid) && Date.now() < hard) await new Promise((r) => setTimeout(r, 25)); }
  return !alive(pid);
}

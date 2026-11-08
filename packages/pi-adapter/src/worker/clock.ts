import { uptime } from "node:os";
import { systemClock, type WatchdogClock } from "@nimblenewt/contracts";

/**
 * The clock the worker process's lease watchdog reads (card H08b). On Linux the time since boot (`os.uptime()`, which is `CLOCK_BOOTTIME`: it counts time asleep and is never set or stepped) is added as the watchdog's `boot` clock, so a wall
 * clock corrected after boot is not taken for a wake and a real suspend still is. Elsewhere the platform's uptime is either derived from the wall clock (macOS) or not known to count time asleep in the same way (Windows), so the watchdog keeps
 * reading the wall clock there.
 *
 * A boot clock that cannot be read later is read as "no time asleep" (the last reading moved on by the monotonic clock): the lease itself still ends on the monotonic clock, so failing to read it never extends authority.
 */
export function processClock(platform: string = process.platform, readUptime: () => number = uptime): WatchdogClock {
  if (platform !== "linux") return systemClock;
  const read = (): number | undefined => { try { const s = readUptime(); return Number.isFinite(s) && s > 0 ? s * 1000 : undefined; } catch { return undefined; } };
  const first = read();
  if (first === undefined) return systemClock;
  let last = { boot: first, mono: systemClock.mono() };
  return {
    mono: systemClock.mono,
    wall: systemClock.wall,
    boot: () => {
      const mono = systemClock.mono();
      const boot = read() ?? last.boot + (mono - last.mono);
      last = { boot, mono };
      return boot;
    },
  };
}

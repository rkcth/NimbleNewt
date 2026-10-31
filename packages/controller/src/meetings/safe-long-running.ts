import type { JobState } from "../jobs/index.js";

/** The installation setting that turns the safe-long-running rule on or off (card M04g). */
export const SAFE_LONG_RUNNING_SETTING = "meeting.safeLongRunning";

const RUNNING: readonly JobState[] = ["dispatched", "running"];

/** What the predicate needs of the job records (the T07 `JobService.unfinishedOf`). */
export interface SafeLongRunningJobs {
  unfinishedOf(taskId: string): Promise<readonly { readonly state: JobState; readonly background: boolean; readonly attemptId?: string }[]>;
}

export interface SafeLongRunningOptions {
  /** The owner's setting (default on). Off: nothing is ever safe. Read on each question; a read that fails counts as off. */
  readonly enabled?: () => Promise<boolean>;
}

/**
 * Card M04g: may an attempt that is ALREADY RUNNING carry on while its agent attends a meeting, because what it has left is only background jobs?
 * This never lets a NEW attempt start during a meeting (the dispatcher's admission does not ask it): a fresh conversation is the long task the owner's rule forbids; only a running attempt's detached jobs may carry on.
 * Only the unfinished jobs of THIS attempt count (jobs of other attempts or with no attempt are not its work). Safe means at least one such job and every one is a permitted background job already placed on a host (`dispatched` or `running`; one still `admitted` waits for a host and is not moving).
 * Not safe: no job of the attempt, any foreground job, any job being cancelled or of unknown outcome. Fails closed on an unreadable list, a malformed answer or the setting being off.
 * Not modelled: the attempt waiting on the jobs' results (handling a finished job's result needs the agent); recorded as a remainder on M04h.
 */
export function safeLongRunningOf(jobs: SafeLongRunningJobs, options: SafeLongRunningOptions = {}): (taskId: string, attemptId: string) => Promise<boolean> {
  return async (taskId, attemptId) => {
    try {
      if (options.enabled !== undefined && (await options.enabled()) !== true) return false;
      const unfinished = await jobs.unfinishedOf(taskId);
      if (!Array.isArray(unfinished)) return false;
      const mine = unfinished.filter((j) => j.attemptId === attemptId);
      if (mine.length === 0) return false;
      return mine.every((j) => j.background === true && RUNNING.includes(j.state));
    } catch { return false; }
  };
}

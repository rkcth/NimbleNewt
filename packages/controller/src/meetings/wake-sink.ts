import { DomainError } from "../domain/errors.js";
import type { WakeSink } from "./attendance.js";

/** What the host's own lifecycle is asked to do: bring a stopped or suspended agent up so it can attend one meeting. `key` is `<occurrence>:<agent>:<n>` where n counts the wakes of that agent in that meeting (a second crash is a second wake with a new key); the host must treat a repeated key as the same request. */
export interface HostWakeRequest { readonly key: string; readonly agent: string; readonly occurrenceId: string; readonly projectId: string }

export interface MeetingWakeOptions {
  /** Longest time the host may take to accept the request (default 30 s). A host that answers later is treated as failed; it may still act on the request, which is safe because the key repeats. */
  readonly timeoutMs?: number;
}

const KEY = /^[A-Za-z0-9:_.-]{1,200}$/;
const MAX_REASON = 200;

/**
 * Wake path for agents the host's availability hook reports stopped or suspended (card M04f). `AttendanceService.authorizeWake` calls it only after the owner authorized the wake, once per key; this adapter adds the checks a
 * host should not have to repeat: the request is well formed, the host gets only the four fields, the wait is bounded, and a failure is reported as a short fixed-shape message (the host's own error text, which may carry paths or
 * addresses, is not passed on to the owner). Nothing is retried here and nothing is remembered: replay safety rests on the key, which the host keys on.
 */
export function checkMeetingWakeTimeout(timeoutMs: number | undefined): number {
  const v = timeoutMs ?? 30_000;
  if (!Number.isInteger(v) || v < 1 || v > 600_000) throw new RangeError("meeting wake timeout must be 1 to 600000 ms");
  return v;
}

const TIMED_OUT = Symbol("meeting wake timed out");

export function meetingWakeSink(host: { recover(request: HostWakeRequest): Promise<void> }, options: MeetingWakeOptions = {}): WakeSink {
  const timeoutMs = checkMeetingWakeTimeout(options.timeoutMs);
  return {
    wake: async (r) => {
      if (!KEY.test(r.key) || !r.key.startsWith(`${r.occurrenceId}:${r.agent}:`) || !/^[1-9][0-9]{0,5}$/.test(r.key.slice(r.occurrenceId.length + r.agent.length + 2)) || !r.agent.startsWith("agent:") || r.projectId.length === 0) throw new DomainError("invalid_command", "the wake request is malformed");
      const request: HostWakeRequest = { key: r.key, agent: r.agent, occurrenceId: r.occurrenceId, projectId: r.projectId };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => host.recover(request)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(TIMED_OUT), timeoutMs); }),
        ]);
      } catch (e) {
        // The domain error is the one kind the state API passes on; a plain Error would be reported as a generic "unavailable".
        throw new DomainError("unavailable", `the host did not wake ${r.agent}${e === TIMED_OUT ? ": it did not answer in time" : ""}`.slice(0, MAX_REASON));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

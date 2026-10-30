import type { WakeSink } from "./attendance.js";

/** What the host's own lifecycle is asked to do: bring a stopped or suspended agent up so it can attend one meeting. `key` is `<occurrence>:<agent>`; the host must treat a repeated key as the same request. */
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
export function meetingWakeSink(host: { recover(request: HostWakeRequest): Promise<void> }, options: MeetingWakeOptions = {}): WakeSink {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new RangeError("meeting wake timeout must be 1 to 600000 ms");
  return {
    wake: async (r) => {
      if (!KEY.test(r.key) || r.key !== `${r.occurrenceId}:${r.agent}` || !r.agent.startsWith("agent:") || r.projectId.length === 0) throw new Error("the wake request is malformed");
      const request: HostWakeRequest = { key: r.key, agent: r.agent, occurrenceId: r.occurrenceId, projectId: r.projectId };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => host.recover(request)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), timeoutMs); }),
        ]);
      } catch (e) {
        const timedOut = e instanceof Error && e.message === "timed out" && timer !== undefined;
        throw new Error(`the host did not wake ${r.agent}${timedOut ? ": it did not answer in time" : ""}`.slice(0, MAX_REASON));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

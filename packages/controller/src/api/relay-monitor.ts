import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { RelayMonitor } from "../dispatch/relay.js";
import type { StallEvent, StallService } from "../health/index.js";

/** The characters of a prompt or reply counted as one token when the provider has not said (a rough count). */
export const RELAY_CHARS_PER_TOKEN = 3;

/** The attempt a monitor reports for. `hostId` and `route` name whose speed a finished request measures (a remote attempt has both; a local one has neither, the relay knows its route). */
export interface MonitoredAttempt { readonly attemptId: string; readonly taskId: string; readonly generation: number; readonly route: string; readonly hostId?: string }

/**
 * What the relay tells stall detection about every model call of an attempt (card V01b): reports are sent one after another so they arrive in order, and a failure of the report never reaches the call. Each call has its own request ID, and every
 * report names the attempt, so a leftover process of an earlier attempt is fenced.
 *
 * A remote attempt outlives a controller restart, and the monitor made for it afterwards numbered its reports from 1 again, so the first reports replayed the command IDs of the earlier ones and were ignored (card L05e). Every monitor therefore has its
 * own run mark in its command IDs (the request IDs stay `{attempt}:{n}`: a request is told apart by being the open one); the order of reports within one monitor is still its sequence, and a second monitor for the same attempt (a restarted controller, a placement made again) cannot collide with the first.
 */
export function relayMonitor(order: MonitoredAttempt, reporter: StallService["reportFromRelay"] extends infer F ? NonNullable<F> : never, onError?: (error: unknown) => void): RelayMonitor {
  let queue: Promise<unknown> = Promise.resolve(); let calls = 0; let seq = 0;
  const run = randomUUID().slice(0, 8);
  // The share of the prompt the cache served on the attempt's latest finished call: the next call, which repeats most of that prompt, is expected to be served about as much (card V01c).
  let expectedShare: number | undefined;
  const send = (event: StallEvent): void => {
    const commandId = `relay:${order.attemptId}:${run}:${++seq}`;
    queue = queue.then(() => reporter({ commandId, taskId: order.taskId, generation: order.generation, attemptId: order.attemptId, event })).catch((error) => { if (!(error instanceof DomainError && (error.code === "fenced" || error.code === "not_found" || (error.code === "invalid_command" && /is not the open request/.test(error.message))))) onError?.(error); });
  };
  const tokensOf = (chars: number): number => Math.ceil(chars / RELAY_CHARS_PER_TOKEN);
  return {
    started: ({ requestChars }) => {
      const requestId = `${order.attemptId}:${++calls}`;
      send({ type: "request_started", requestId, promptTokens: tokensOf(requestChars), ...(order.route === "" ? {} : { route: order.route }), ...(order.hostId === undefined ? {} : { hostId: order.hostId }), ...(expectedShare === undefined ? {} : { cachedShare: expectedShare }) });
      let seenOutput = false; let tokens = 0;
      return {
        firstOutput: () => { seenOutput = true; send({ type: "first_output", requestId }); },
        // A rough count: the bytes of the stream over the same characters per token. The provider's own count arrives with the end of the call.
        progress: (bytes) => { tokens = tokensOf(bytes); send({ type: "output_progress", requestId, tokens }); },
        // The relay is waiting on the controller's own store, not on the model: a repeat of the last count keeps the stall clock from blaming the model for that wait (it is bounded by the store timeout).
        waiting: (on) => { if (on && seenOutput) send({ type: "output_progress", requestId, tokens }); },
        finished: (call) => {
          if (call.ok && call.inputTokens !== undefined && call.inputTokens > 0 && call.cachedTokens !== undefined) expectedShare = Math.min(1, Math.max(0, call.cachedTokens / call.inputTokens));
          send({ type: "request_finished", requestId, outcome: call.ok ? "ok" : "error", ...(call.inputTokens === undefined ? {} : { inputTokens: call.inputTokens }), ...(call.cachedTokens === undefined ? {} : { cachedTokens: call.cachedTokens }), ...(call.outputTokens === undefined ? {} : { outputTokens: call.outputTokens }) });
        },
      };
    },
  };
}

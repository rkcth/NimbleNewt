import { isDomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import type { DispatcherService, ModelCalls } from "../dispatch/dispatcher.js";
import type { GenerationService } from "../generation/index.js";
import type { CutoverService, FallbackService, InFlight } from "../routing/index.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal } from "../security/principals.js";

/**
 * The dispatcher's model calls through the fallback service (card R04c). Every run of an attempt on a route is one call of the fallback service: it is begun just before the worker starts (the owner's routing controls, the
 * routes' health and the task's model budget are asked), marked sent once the worker is up, and reported when the attempt ends. That is what makes a drain report count running work and a cutover find it to cancel.
 *
 * How an end is reported: a completed turn is `succeeded` with what the attempt was charged for it (money; token counts are not known at this level and are reported as 0); a failed attempt is `failed` with a neutral message,
 * so a failure of the task, a tool or the worker is never taken for a provider outage (the gate learns availability only from what is reported as one); an attempt ended for another reason (a stop, a lost worker, a cutover) is
 * `abandoned`, which records a possible charge on a paid route; a call whose worker never started is withdrawn (no charge, not counted).
 */
export function routeCallsOf(fallback: FallbackService, cutover: Pick<CutoverService, "gate">, principal: Principal): ModelCalls {
  const gate = cutover.gate();
  const callIdOf = (key: string): string => derivedId("mcl", scopedCommandId(principal.id, key));
  // A report that comes after the call already moved on (a cutover took the attempt back, it was reported before) changes nothing.
  const once = async (report: () => Promise<unknown>): Promise<void> => { try { await report(); } catch (error) { if (!isDomainError(error, "invalid_transition")) throw error; } };
  return {
    blocked: (route, key) => gate.blocked(route, callIdOf(key)),
    begin: async (c) => {
      // The task's model budget is looked at first, so a task that waits for a raise does not leave a waiting call behind at every look.
      const spent = await fallback.budgetWait(c.taskId);
      if (spent !== undefined) return { wait: spent };
      const step = await fallback.begin(principal, { commandId: c.key, taskId: c.taskId, request: { role: c.role, ...c.request }, routes: [c.route] });
      if (step.kind === "route" && step.route === c.route) return { callId: step.callId, attempt: step.attempt };
      if (step.kind === "wait") return { wait: `${step.reason}${step.why.length === 0 ? "" : ` (${step.why.join("; ")})`}` };
      if (step.kind === "failed") return { wait: step.reason };
      // Not possible with a list of one route; if it ever is, that call is taken back unsent rather than left running.
      await once(() => fallback.withdraw(principal, { commandId: `rc-wd:${step.callId}:${step.attempt}`, callId: step.callId, attempt: step.attempt, reason: "the call was begun for another route" }));
      return { wait: `the call went to ${step.route}, not ${c.route}` };
    },
    current: async (c) => {
      const call = await fallback.call(principal, c.callId);
      return call !== undefined && call.state === "running" && call.attempts.length === c.attempt && call.attempts[c.attempt - 1]?.outcome === "started";
    },
    sent: async (c) => { await fallback.sent(principal, { commandId: `rc-sent:${c.callId}:${c.attempt}`, callId: c.callId, attempt: c.attempt }); },
    ended: async (c) => {
      const base = { callId: c.callId, attempt: c.attempt };
      if (!c.sent) {
        try { await fallback.withdraw(principal, { ...base, commandId: `rc-wd:${c.callId}:${c.attempt}`, reason: "the worker for it never started" }); return; } catch (error) { if (!isDomainError(error, "invalid_transition")) throw error; }
        // Refused: the fallback service was told it was sent, but the attempt's record never said so (a crash, or a failed write, between the two). It may have run, so it is abandoned (a possible charge on a paid
        // route) rather than left running for ever; a call that is already over refuses this as well, which changes nothing.
        return once(() => fallback.abandon(principal, { ...base, commandId: `rc-wdab:${c.callId}:${c.attempt}`, reason: "the attempt ended; it may have been sent before its worker was recorded as started" }));
      }
      const usage = { inputTokens: 0, outputTokens: 0, costMicros: c.costMicros };
      if (c.outcome === "succeeded") return once(() => fallback.succeeded(principal, { ...base, commandId: `rc-ok:${c.callId}:${c.attempt}`, usage }));
      if (c.outcome === "failed") return once(() => fallback.failed(principal, { ...base, commandId: `rc-fail:${c.callId}:${c.attempt}`, failure: { message: "the attempt ended as failed; its reason is in the attempt's record" }, usage }));
      return once(() => fallback.abandon(principal, { ...base, commandId: `rc-end:${c.callId}:${c.attempt}`, reason: "the attempt was ended before its turn completed" }));
    },
  };
}

/** The words of the generation hold a cutover puts on a task while it ends the attempt; only a hold with these words is lifted again. */
const holdReason = (f: InFlight): string => `route cut over (call ${f.callId}, attempt ${f.attempt})`;

/**
 * What a cutover does to the attempts it cancelled (card R04c, the listener `CutoverService.bind` takes): the running generation of each is cancelled (L05: a late reply is held back, effects not begun are withdrawn), its
 * worker is stopped and the attempt ends, and a replacement is admitted that goes to the next open route; then the generation hold is lifted so the replacement may run. It is called again with the same attempts after a
 * crash or a failure (every step is idempotent), and a hold this listener put on is lifted even when the attempt already ended. `elevated` acts on the generation for the owner who ordered the cutover.
 */
export function cutoverListener(deps: { readonly dispatcher: () => DispatcherService | undefined; readonly generation: Pick<GenerationService, "gate" | "interrupt" | "release">; readonly principal: Principal; readonly elevated: Principal }): (cancelled: readonly InFlight[]) => Promise<void> {
  return async (cancelled) => {
    const dispatcher = deps.dispatcher();
    let failure: unknown;
    for (const f of cancelled) {
      try {
        const reason = holdReason(f);
        let attemptId: string | undefined;
        for (const id of dispatcher === undefined ? [] : await dispatcher.liveAttemptsOf(deps.principal, { taskId: f.taskId })) {
          const mc = (await dispatcher!.get(deps.principal, id))?.modelCall;
          if (mc?.callId === f.callId && mc.attempt === f.attempt) { attemptId = id; break; }
        }
        if (attemptId !== undefined) {
          const hold = (await deps.generation.gate(deps.elevated, f.taskId))?.gate.hold;
          // Someone else's hold (the owner paused the task) is left as it is: the attempt still ends, and nothing here lifts that hold.
          if (hold === undefined || hold.reason === reason) {
            try { await deps.generation.interrupt(deps.elevated, { commandId: `rcut-gen:${f.callId}:${f.attempt}`, taskId: f.taskId, mode: "cancel", reason }); } catch (error) { if (!isDomainError(error, "invalid_command")) throw error; }
          }
          await dispatcher!.cutOver(deps.principal, attemptId, { callId: f.callId, attempt: f.attempt, reason: `route ${f.route}` });
        }
        if ((await deps.generation.gate(deps.elevated, f.taskId))?.gate.hold?.reason === reason) {
          try { await deps.generation.release(deps.elevated, { commandId: `rcut-rel:${f.callId}:${f.attempt}`, taskId: f.taskId, reason: "the cut-over attempt has ended" }); } catch (error) { if (!isDomainError(error, "invalid_command")) throw error; }
        }
      } catch (error) { failure ??= error; }
    }
    // Every attempt was tried; a failure leaves the cutover pending, so the next tick (or a repeat of the command) calls this again.
    if (failure !== undefined) throw failure;
  };
}

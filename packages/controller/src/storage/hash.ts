import { canonicalJson, sha256 } from "./json.js";
import type { OperationInput } from "./types.js";

/**
 * The request hash that decides whether a repeated operation ID is a retry or a conflict. It covers everything that defines
 * the command (actor, correlation, changes, audit, outbox, effects, timers, cancellations, receipts, timer completions, effect settlements) and not the things that
 * legitimately differ between attempts of the same command: the operation ID itself, the caller's epoch and the issue time.
 */
export function operationHash(input: OperationInput): string {
  return sha256(canonicalJson({
    v: 1,
    actor: input.actor,
    correlationId: input.correlationId,
    changes: input.changes,
    audit: input.audit,
    outbox: input.outbox,
    effects: input.effects,
    timers: input.timers,
    cancelTimers: input.cancelTimers,
    completeDeliveries: input.completeDeliveries,
    completeTimers: input.completeTimers,
    settleEffects: input.settleEffects,
  }, "operation"));
}

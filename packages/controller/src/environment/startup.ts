import { commitOperation } from "../storage/commit.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { StartupCheck } from "./check.js";

/**
 * Writes the audit record of an override, once per primary epoch (the operation ID names the epoch, so a repeated start-up call for the
 * same epoch is the same record). Nothing is written for a supported environment. Returns whether a record was written or already existed.
 */
export async function recordOverride(storage: ControllerStorage, epoch: number, check: StartupCheck, at: string = new Date().toISOString()): Promise<boolean> {
  if (!check.overridden) return false;
  await commitOperation(storage, {
    operationId: `environment:${epoch}`, epoch, actor: "startup", correlationId: `environment:${epoch}`, at,
    changes: [], audit: [{ type: "environment.override", detail: { problems: check.problems as unknown as JsonObject[] } }],
    outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
  }, { attempts: 5 });
  return true;
}

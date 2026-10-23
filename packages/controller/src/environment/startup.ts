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
    changes: [], audit: [{ type: "environment.override", detail: { problems: check.problems as unknown as JsonObject[], ...(check.host === undefined ? {} : { host: check.host }) } }],
    outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
  }, { attempts: 5 });
  return true;
}

/**
 * Writes the host line (operating system, architecture, distribution if there is one) as an `environment.host` audit record, once per primary epoch, on every start (card F04j: the
 * distribution is recorded in the audit log, for information only). Nothing is printed for it and nothing reads it back to decide anything.
 */
export async function recordHost(storage: ControllerStorage, epoch: number, host: string, at: string = new Date().toISOString()): Promise<void> {
  await commitOperation(storage, {
    operationId: `environment-host:${epoch}`, epoch, actor: "startup", correlationId: `environment-host:${epoch}`, at,
    changes: [], audit: [{ type: "environment.host", detail: { host } }],
    outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
  }, { attempts: 5 });
}

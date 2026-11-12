import { DomainError } from "../domain/errors.js";
import type { StopService } from "../lifecycle/stop.js";
import type { Principal } from "../security/principals.js";

/**
 * Stops all agent work for a restore (card K01i): a graceful Stop of the whole installation (every running attempt is checkpointed, then ended), driven to its end here. It is the owner's own lifecycle control used on the owner's
 * behalf (the owner asked for it with `stopAttempts`); the restore does not invent a way to stop work. Returns when the stop is done. When it does not finish (work that will not settle, a model that is missing) it throws
 * `unavailable` saying so; the pause it put in place stays, and the owner decides with the lifecycle controls (wait, restart from an earlier boundary, force stop) or resumes the work.
 */
export async function stopAllWork(deps: { readonly stops: Pick<StopService, "request" | "advance">; readonly by: Principal; readonly commandId: string; readonly reason: string; readonly deadlineMs?: number; /** After the stop is done the dispatcher still has to record that each stopped attempt ended its turn (its next tick does): `step` runs a tick, `settled` says no attempt is running any more. Up to `waitMs` (default 60 s). */ readonly settle?: { readonly settled: () => Promise<boolean>; readonly step: () => Promise<unknown>; readonly waitMs?: number } }): Promise<void> {
  const { intentId } = await deps.stops.request(deps.by, { commandId: deps.commandId, scope: { kind: "installation", id: "installation" }, mode: "stop", reason: deps.reason.slice(0, 480), ...(deps.deadlineMs === undefined ? {} : { deadlineMs: deps.deadlineMs }) });
  const done = await deps.stops.advance(deps.by, { intentId });
  const phase = done.phase;
  if (phase === "done") {
    if (deps.settle === undefined) return;
    const end = Date.now() + (deps.settle.waitMs ?? 60_000);
    while (!(await deps.settle.settled())) {
      if (Date.now() > end) throw new DomainError("unavailable", "the work was stopped but an attempt is still recorded as running after a minute. Agent work stays paused; wait a little and prepare the restore again. Nothing was changed.");
      await deps.settle.step().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    }
    return;
  }
  throw new DomainError("unavailable", `agent work did not settle for the restore (the stop is ${phase}${phase === "blocked" ? ": some work will not stop on its own" : ""}). Agent work stays paused; use the lifecycle controls to wait, force it to stop or resume it, then prepare the restore again. Nothing was changed.`);
}

import type { DispatcherService } from "../dispatch/dispatcher.js";
import { TERMINAL } from "../dispatch/model.js";
import type { Principal } from "../security/principals.js";
import type { PauseScope } from "./pause.js";
import type { InventoryItem, StopPorts } from "./stop.js";

type Dispatcher = Pick<DispatcherService, "liveAttemptsOf" | "quiesce" | "stop" | "operations" | "release">;

/**
 * The runtime side of Suspend and Stop for the attempt dispatcher (card L02). Task and agent scopes are the attempts the dispatcher has live for them; a team or installation scope would need the agents under it, which
 * this adapter does not resolve, so it says so and the request blocks with that reason instead of claiming a suspension. The dispatcher's own steps are the cleanup: new calls are refused, calls in flight settle (a
 * ledger call is never cut), and a checkpoint is taken; the checkpoint counts as durable when the checkpoint hook returned one. Whether the artifacts a checkpoint names are durable is not known here, so it is
 * taken from the hook's answer when it says (`artifactsDurable`), and otherwise assumed durable only when the checkpoint came back.
 */
export function dispatchStopPorts(dispatch: () => { dispatcher: Dispatcher; principal: Principal } | undefined, runtime: () => "none" | "pending" = () => "pending"): StopPorts {
  const attemptsOf = async (scope: PauseScope): Promise<string[]> => {
    const h = dispatch();
    // No dispatcher exists in this controller: nothing can be running. A dispatcher that should exist but is not up (a restart in progress, a failed start) is not the same, and nothing is claimed about it.
    if (h === undefined) { if (runtime() === "none") return []; throw new Error("the dispatcher is not running, so what is running cannot be known"); }
    if (scope.kind === "task") return h.dispatcher.liveAttemptsOf(h.principal, { taskId: scope.id });
    if (scope.kind === "agent") return h.dispatcher.liveAttemptsOf(h.principal, { agentId: scope.id });
    throw new Error(`a ${scope.kind} scope is not resolved to attempts by this runtime yet`);
  };
  const inFlight = async (attempts: readonly string[]): Promise<InventoryItem[]> => {
    const h = dispatch();
    const out: InventoryItem[] = [];
    for (const attemptId of attempts) {
      for (const op of (await h?.dispatcher.operations(h.principal, attemptId)) ?? []) if (!TERMINAL.has(op.state)) out.push({ kind: "foreground", ref: `${attemptId}/${op.callId}`.slice(0, 120), state: "running" });
    }
    return out;
  };
  return {
    inventory: async (scope) => inFlight(await attemptsOf(scope)),
    release: async (scope) => { const h = dispatch(); if (h === undefined) return; for (const id of await attemptsOf(scope)) await h.dispatcher.release(h.principal, id).catch(() => undefined); },
    cleanup: async (scope, options) => {
      const h = dispatch();
      const attempts = await attemptsOf(scope);
      for (const id of attempts) {
        const strictMs = Math.max(1, Math.min(60_000, Date.parse(options.deadlineAt) - Date.now()));
        await h!.dispatcher.quiesce(h!.principal, id, "suspend or stop preparation", { strictMs });
      }
      return { remaining: await inFlight(attempts) };
    },
    checkpoint: async (scope) => {
      const h = dispatch();
      const attempts = await attemptsOf(scope);
      if (h === undefined || attempts.length === 0) return { checkpointId: `${scope.kind}:${scope.id}`.slice(0, 120), durable: true, artifactsDurable: true }; // nothing runs here, so there is nothing to save
      let checkpointed = true;
      let artifacts = true;
      for (const id of attempts) {
        const { checkpoint } = await h!.dispatcher.quiesce(h!.principal, id, "checkpoint before suspension");
        if (checkpoint === undefined) checkpointed = false;
        else if (checkpoint["artifactsDurable"] === false) artifacts = false;
      }
      return { checkpointId: `${scope.kind}:${scope.id}`.slice(0, 120), durable: checkpointed, artifactsDurable: artifacts };
    },
    terminate: async (scope, options) => {
      const h = dispatch();
      const attempts = await attemptsOf(scope);
      const unresolved: string[] = [];
      for (const id of attempts) {
        await h!.dispatcher.stop(h!.principal, id, { reason: options.force ? "force stop" : "stop after preparation", ...(options.force ? { emergency: true } : {}) });
        for (const op of (await h!.dispatcher.operations(h!.principal, id)) ?? []) if (op.state === "uncertain") unresolved.push(`${id}/${op.callId}`.slice(0, 120));
      }
      return { ended: true, unresolved };
    },
  };
}

import { DomainError } from "../domain/errors.js";
import type { DispatcherService } from "../dispatch/dispatcher.js";
import type { Principal } from "../security/principals.js";
import type { WorkEndDeps } from "./work-end.js";

type Dispatcher = Pick<DispatcherService, "get" | "freeze" | "settle" | "operations" | "finishWith">;

/**
 * The attempt port of the ending (card H12n) bound to the real dispatcher: the attempt's state, its freeze, the settling of calls in flight (with the calls that had to be cut, and whether each could have changed the checkout), and its end
 * with the agent's result. Everything runs as the dispatcher's service principal. Without a dispatcher (it is built after the API, or not at all) a call says so.
 */
export function dispatcherEndingPorts(dispatch: () => { readonly dispatcher: Dispatcher; readonly principal: Principal } | undefined): WorkEndDeps["attempts"] {
  const need = (): { readonly dispatcher: Dispatcher; readonly principal: Principal } => dispatch() ?? ((): never => { throw new DomainError("unavailable", "the dispatcher is not running, so an attempt cannot be ended now"); })();
  return {
    get: async (attemptId) => {
      const h = need();
      const d = await h.dispatcher.get(h.principal, attemptId);
      if (d === undefined) return undefined;
      return { attemptId: d.attemptId, taskId: d.taskId, projectId: d.projectId, agentId: d.agentId, live: d.state !== "finished" };
    },
    freeze: async (attemptId, reason) => { const h = need(); await h.dispatcher.freeze(h.principal, attemptId, reason); },
    settle: async (attemptId) => {
      const h = need();
      await h.dispatcher.settle(h.principal, attemptId, { cancel: true });
      // A call that did not end by itself is recorded as cancelled, or as uncertain when its effect had begun; a call that is not read-only may have changed the checkout.
      const ops = (await h.dispatcher.operations(h.principal, attemptId)) ?? [];
      return { killed: ops.filter((o) => o.state === "cancelled" || o.state === "uncertain").map((o) => ({ callId: o.callId, write: !o.readOnly, reason: o.state === "uncertain" ? "its outcome is not known" : "it was told to stop" })) };
    },
    finish: async (attemptId, result) => { const h = need(); await h.dispatcher.finishWith(h.principal, attemptId, result); },
  };
}

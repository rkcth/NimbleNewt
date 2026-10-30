import { DomainError } from "../domain/errors.js";
import type { DispatcherService } from "../dispatch/dispatcher.js";
import { TERMINAL } from "../dispatch/model.js";
import type { Principal } from "../security/principals.js";
import type { SubmissionService } from "../submissions/index.js";
import type { EndingAttempt, WorkEndDeps } from "./work-end.js";

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
      return { attemptId: d.attemptId, taskId: d.taskId, projectId: d.projectId, agentId: d.agentId, live: d.state !== "finished", ...(d.stopped === undefined ? {} : { stopped: { by: d.stopped.by, reason: d.stopped.reason } }) };
    },
    freeze: async (attemptId, reason) => { const h = need(); await h.dispatcher.freeze(h.principal, attemptId, reason, { ending: true }); },
    settle: async (attemptId) => {
      const h = need();
      // Only the calls this settle cuts count: those still running when it began (an earlier cancelled or uncertain call in the history is not this ending's doing).
      const running = new Set(((await h.dispatcher.operations(h.principal, attemptId)) ?? []).filter((o) => !TERMINAL.has(o.state)).map((o) => o.callId));
      try { await h.dispatcher.settle(h.principal, attemptId, { cancel: true }); } catch (error) {
        // The attempt ended meanwhile (the agent's turn, a stop): there is nothing left to settle, and nothing was cut by this call.
        if (error instanceof DomainError && error.code === "not_found") return { killed: [] };
        throw error;
      }
      // A call told to stop is `cancelled` (it had no effect yet: not a write); one whose effect had begun and whose outcome is not known is `uncertain`, and may have changed the checkout unless it only looks.
      const ops = (await h.dispatcher.operations(h.principal, attemptId)) ?? [];
      return { killed: ops.filter((o) => running.has(o.callId) && (o.state === "cancelled" || o.state === "uncertain")).map((o) => ({ callId: o.callId, write: o.state === "uncertain" && !o.readOnly, reason: o.state === "uncertain" ? "its outcome is not known" : "it was told to stop" })) };
    },
    finish: async (attemptId, result, _key, confirm) => { const h = need(); return h.dispatcher.finishWith(h.principal, attemptId, { ...result, ...(confirm === undefined ? {} : { confirm }) }); },
  };
}

/** The agent's staged work as the workspace reports it: the commit the checkout is based on, the tree and patch id of what is staged, and the files changed (card H12n, submit binding). */
export interface StagedWork {
  readonly base: string;
  readonly tree: string;
  readonly patchId: string;
  readonly files: readonly string[];
}

/**
 * The submit port bound to the submission service (card H12n): stages the attempt's work (through the host-provided `stage`) and records ONE code submission in the `author` role, tied to the attempt's task. The command ID is the ending's step key,
 * so a replay records once. The base staged must be the base that was checked for freshness; if the checkout moved in between the submission is not made (the ending then ends plainly with `release_failed`). Nothing here verifies the tree or patch id: that is
 * the landing queue's check (P08).
 */
export function stagedSubmit(deps: {
  readonly stage: (attempt: EndingAttempt) => Promise<StagedWork>;
  readonly submissions: Pick<SubmissionService, "record">;
  /** The effective principal of the attempt's agent (`agent:<id>`), or undefined when it cannot act. */
  readonly principalOf: (agentId: string) => Promise<Principal | undefined>;
}): NonNullable<WorkEndDeps["submit"]> {
  return async (attempt, base, key) => {
    const by = await deps.principalOf(attempt.agentId);
    if (by === undefined) throw new DomainError("forbidden", `${attempt.agentId} cannot act, so its work cannot be submitted`);
    const staged = await deps.stage(attempt);
    if (staged.base !== base) throw new DomainError("checkout_changed", `the staged work is based on ${staged.base}, not on ${base} that was checked; it was not submitted`);
    const made = await deps.submissions.record(by, { commandId: key, taskId: attempt.taskId, kind: "code", role: "author", base: staged.base, tree: staged.tree, patchId: staged.patchId });
    return { submissionId: made.id };
  };
}

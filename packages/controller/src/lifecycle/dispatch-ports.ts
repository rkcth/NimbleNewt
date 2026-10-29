import type { ControllerStorage } from "../storage/types.js";
import type { DispatcherService } from "../dispatch/dispatcher.js";
import { TERMINAL } from "../dispatch/model.js";
import type { Principal } from "../security/principals.js";
import type { PauseScope } from "./pause.js";
import type { InventoryItem, StopPorts } from "./stop.js";

type Dispatcher = Pick<DispatcherService, "liveAttemptsOf" | "quiesce" | "stop" | "operations" | "release">;

/**
 * The agent IDs a scope covers (card L02b): an agent is itself; a team is every agent whose team chain passes through it (the same walk the pause gate reads); the installation is every agent. Cycles and over-long chains stop the walk.
 * Read from the records at the moment of asking, so an agent moved into the team since the request is in the next call's answer (the inventory is asked again at each phase).
 */
/** The dispatcher keeps an attempt's agent as its principal ID (`agent:agt-…`); scopes and agent records use the bare ID. */
const principalForm = (id: string): string => (id.startsWith("agent:") ? id : `agent:${id}`);

export async function agentsUnder(storage: Pick<ControllerStorage, "listAggregates">, scope: PauseScope): Promise<string[]> {
  const page = 200;
  const teams = new Map<string, string | undefined>();
  for (let after: string | undefined; ;) {
    const chunk = await storage.listAggregates("team", { ...(after === undefined ? {} : { afterId: after }), limit: page });
    for (const t of chunk) { after = t.id; teams.set(t.id, (t.body as unknown as { parentTeamId?: string }).parentTeamId); }
    if (chunk.length < page) break;
  }
  const out: string[] = [];
  for (let after: string | undefined; ;) {
    const chunk = await storage.listAggregates("agent", { ...(after === undefined ? {} : { afterId: after }), limit: page });
    for (const a of chunk) {
      after = a.id;
      if (scope.kind === "installation") { out.push(a.id); continue; }
      let at = (a.body as unknown as { teamId?: string }).teamId;
      for (let hops = 0; at !== undefined && hops < 50; hops++) { if (at === scope.id) { out.push(a.id); break; } at = teams.get(at); }
    }
    if (chunk.length < page) return out;
  }
}

/**
 * The runtime side of Suspend and Stop for the attempt dispatcher (card L02). Task and agent scopes are the attempts the dispatcher has live for them; a team or installation scope is resolved to the agents under it by the `members` hook (card L02b); without the hook it says so and the request is refused instead of claiming a suspension. The dispatcher's own steps are the cleanup: new calls are refused, calls in flight settle (a
 * ledger call is never cut), and a checkpoint is taken; the checkpoint counts as durable when the checkpoint hook returned one. Whether the artifacts a checkpoint names are durable is not known here, so it is
 * taken from the hook's answer when it says (`artifactsDurable`), and otherwise assumed durable only when the checkpoint came back.
 */
export function dispatchStopPorts(dispatch: () => { dispatcher: Dispatcher; principal: Principal } | undefined, runtime: () => "none" | "pending" = () => "pending", members?: (scope: PauseScope) => Promise<readonly string[]>): StopPorts {
  const attemptsOf = async (scope: PauseScope): Promise<string[]> => {
    const h = dispatch();
    // No dispatcher exists in this controller: nothing can be running. A dispatcher that should exist but is not up (a restart in progress, a failed start) is not the same, and nothing is claimed about it.
    if (h === undefined) { if (runtime() === "none") return []; throw new Error("the dispatcher is not running, so what is running cannot be known"); }
    if (scope.kind === "task") return h.dispatcher.liveAttemptsOf(h.principal, { taskId: scope.id });
    if (scope.kind === "agent") return h.dispatcher.liveAttemptsOf(h.principal, { agentId: principalForm(scope.id) });
    if (members === undefined) throw new Error(`a ${scope.kind} scope is not resolved to attempts by this runtime yet`);
    const out = new Set<string>();
    for (const agentId of await members(scope)) for (const id of await h.dispatcher.liveAttemptsOf(h.principal, { agentId: principalForm(agentId) })) out.add(id);
    return [...out];
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
    unsupported: (scope) => (scope.kind === "task" || scope.kind === "agent" || members !== undefined ? undefined : `stopping a whole ${scope.kind} is not supported yet; stop its tasks or agents one by one (Force Stop works on each)`),
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

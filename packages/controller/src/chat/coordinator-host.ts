import { DomainError } from "../domain/errors.js";
import type { AgentService } from "../agents/index.js";
import type { PauseScope, PauseService, StopService, ObservedState } from "../lifecycle/index.js";
import type { Principal } from "../security/principals.js";

/**
 * The coordinator as a hosted agent (card U03c). When the coordinator's principal is an agent record (card H11), its lifecycle is the agent's own lifecycle: the pause gate of its agent scope (and of the teams above it
 * and the installation), and a Stop of that scope. The owner pauses, stops and resumes it through the same controls as any other agent, and the coordinator reads the answer from the same gates at each use.
 * Nothing here grants anything: the port only reads gates and, for the owner, asks the pause and stop services the owner could ask directly.
 */
export type HostedState = "running" | "paused" | "stopping" | "suspended" | "stopped";

export interface HostedLook {
  /** The agent record: `active`, `retired` (a retired agent cannot be the coordinator) or `missing`. */
  readonly agent: "active" | "retired" | "missing";
  /** What the agent controls say now. `running` only when no gate on the agent's chain is paused. */
  readonly state: HostedState;
  /** The agent's `defaultProfile` (a routing profile name), when it has one: the coordinator's routes come from it unless the owner stated routes (card U03d). */
  readonly profile?: string;
  /** The paused gates that hold the agent, nearest first, with what the executor reported for each. */
  readonly heldBy: readonly { readonly scope: PauseScope; readonly observed?: ObservedState; readonly reason?: string; readonly by?: string }[];
}

export interface AgentLifecyclePort {
  /** The agent's lifecycle as the agent controls show it. `viewer` must be someone who may read the gates (the owner). */
  look(viewer: Principal, agentId: string): Promise<HostedLook>;
  /** Pauses the agent's own scope (nothing if it is already paused). Repeating with the same command ID changes nothing. `requestId` is set only when this call made the pause (not when the gate was already paused), so a caller can take back exactly its own pause. */
  pause(by: Principal, agentId: string, commandId: string, reason: string): Promise<{ readonly requestId?: string }>;
  /** Lifts the agent's own gate only if it is still the pause `requestId` made (card U03d): a pause somebody else made or renewed since is left alone. Answers whether the gate was lifted. */
  undoPause(by: Principal, agentId: string, commandId: string, requestId: string, reason: string): Promise<boolean>;
  /** Lifts the agent's own gate. Gates above it (a team, the installation) are not touched; `stillHeldBy` names those that still hold. */
  resume(by: Principal, agentId: string, commandId: string, reason: string): Promise<{ readonly stillHeldBy: readonly PauseScope[] }>;
  /** Asks for a Stop of the agent's scope (the stop service walks it to the end). */
  stop(by: Principal, agentId: string, commandId: string, reason: string): Promise<void>;
  /** Tells the pause gate the coordinator has reached its safe boundary: it holds no work in flight. */
  settled(by: Principal, agentId: string): Promise<void>;
}

const AGENT = /^agt-[a-z2-7]{20}$/;
const own = (agentId: string): PauseScope => ({ kind: "agent", id: agentId });
const agentIdOf = (id: string): string => (AGENT.test(id) ? id : (() => { throw new DomainError("invalid_command", "agentId: is not an agent ID", { field: "agentId" }); })());

/** The port over the real agent, pause and stop services. `stops` is absent where stopping is not set up: a Stop is then refused (`unavailable`), a pause and a resume still work. */
export function agentLifecycle(deps: { readonly agents: Pick<AgentService, "get">; readonly pauses: PauseService; readonly stops?: StopService }): AgentLifecyclePort {
  const look = async (viewer: Principal, id: string): Promise<HostedLook> => {
    const agentId = agentIdOf(id);
    const record = await deps.agents.get(viewer, agentId);
    const heldBy: { scope: PauseScope; observed?: ObservedState; reason?: string; by?: string }[] = [];
    // The holds are read without the viewer's rights (whether the agent is held is not a secret from the coordinator that is the agent); what each gate reported is shown to whoever may read the gate.
    for (const hold of await deps.pauses.agentHolds(agentId)) {
      const gate = await deps.pauses.gate(viewer, hold.scope).catch(() => undefined);
      heldBy.push({ scope: hold.scope, ...(gate?.observed === undefined ? {} : { observed: gate.observed.state }), ...(gate?.reason === undefined ? {} : { reason: gate.reason }), ...(gate?.owner === undefined ? {} : { by: gate.owner }) });
    }
    const seen = new Set(heldBy.map((h) => h.observed));
    const state: HostedState = heldBy.length === 0 ? "running" : seen.has("stopped") ? "stopped" : seen.has("suspended") ? "suspended" : seen.has("stopping") ? "stopping" : "paused";
    return { agent: record === undefined ? "missing" : record.state === "retired" ? "retired" : "active", state, ...(record?.defaultProfile === undefined ? {} : { profile: record.defaultProfile }), heldBy };
  };
  const ownGate = async (viewer: Principal, agentId: string) => deps.pauses.gate(viewer, own(agentId));
  return {
    look,
    async pause(by, id, commandId, reason) {
      const agentId = agentIdOf(id);
      const gate = await ownGate(by, agentId);
      if (gate?.intent === "pause") return {};
      // The gate's revision is part of the command ID: a pause that was taken back (card U03d) is made again by a repeat of the owner's command, while a repeat that finds the gate unchanged is still the same command.
      const made = await deps.pauses.pause(by, { commandId: `${commandId}-r${gate?.revision ?? 0}`.slice(0, 120), scope: own(agentId), reason });
      return made.replayed ? {} : { requestId: made.requestId };
    },
    async undoPause(by, id, commandId, requestId, reason) {
      const agentId = agentIdOf(id);
      const gate = await ownGate(by, agentId);
      if (gate?.intent !== "pause" || gate.requestId !== requestId) return false;
      // Lifted in the same write only while it is still that very pause.
      await deps.pauses.resumeOwnHold(by, { commandId, scope: own(agentId), reason, requestId });
      return true;
    },
    async resume(by, id, commandId, reason) {
      const agentId = agentIdOf(id);
      if ((await ownGate(by, agentId))?.intent === "pause") {
        const done = await deps.pauses.resume(by, { commandId, scope: own(agentId), reason });
        return { stillHeldBy: done.stillPausedBy };
      }
      return { stillHeldBy: (await look(by, agentId)).heldBy.map((h) => h.scope) };
    },
    async stop(by, id, commandId, reason) {
      const agentId = agentIdOf(id);
      if (deps.stops === undefined) throw new DomainError("unavailable", "stopping agents is not set up here");
      const asked = await deps.stops.request(by, { commandId, scope: own(agentId), mode: "stop", reason });
      // As the state API's stop does: take it as far as it goes now. What is left (a blocked preparation, a restart) is carried on by the sweep, and the coordinator is held in the meantime.
      await deps.stops.advance(by, { intentId: asked.intentId }).catch(() => undefined);
    },
    async settled(by, id) {
      const agentId = agentIdOf(id);
      const gate = await ownGate(by, agentId);
      if (gate?.intent !== "pause" || gate.observed?.state === "paused" || gate.observed?.state === "stopped" || gate.observed?.state === "suspended" || gate.observed?.state === "stopping") return;
      await deps.pauses.observe(by, { commandId: `coord-settled-${gate.requestId ?? gate.revision}`, scope: own(agentId), state: "paused", boundary: "finished", evidence: "the coordinator holds no work in flight" });
    },
  };
}

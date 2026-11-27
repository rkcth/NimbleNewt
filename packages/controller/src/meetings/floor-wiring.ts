import type { AssignTask } from "../domain/assignments.js";
import type { ControllerStorage } from "../storage/types.js";
import type { FloorDeps } from "./floor.js";
import { isShareableKind } from "./shareable.js";

/**
 * The production side of two floor ports (card M05), kept apart from `api/start.ts` so they are tested on every storage backend.
 *
 * `floorSourceRevision`: the current revision of a record an answer to the owner cites, so a source that changed since the agent looked is marked stale. Only a project-visible kind (the same list a meeting may share,
 * `SHAREABLE_KINDS`) whose record belongs to the meeting's own project is looked up; for anything else (an agent's desk or scratch, another project's record, a record that does not exist, a read that fails) the answer is
 * "not checked", so nothing about a record the meeting could not see is told to it, not even that it exists. One read per cite.
 */
export function floorSourceRevision(storage: Pick<ControllerStorage, "getAggregate">): NonNullable<FloorDeps["sourceRevision"]> {
  return async (cite, context) => {
    if (typeof cite.kind !== "string" || typeof cite.id !== "string" || !isShareableKind(cite.kind) || !/^[\w-]{1,120}$/.test(cite.id)) return undefined;
    try {
      const found = await storage.getAggregate({ kind: cite.kind, id: cite.id });
      if (found === undefined) return undefined;
      const projectId = cite.kind === "project" ? found.id : (found.body as { projectId?: unknown }).projectId;
      return typeof projectId === "string" && projectId === context.projectId ? found.revision : undefined;
    } catch { return undefined; }
  };
}

const AGENT_OWNER = /^agent:([a-z0-9][a-z0-9-]{0,39})$/;

/**
 * `floorFollowUps`: a follow-up task the meeting left open, created in the meeting's project and given to its owner when the owner is an agent (an unresolved question is owned by whoever raised it, an unanswered chair question
 * by the member it was put to, an investigation by the agent that said it needs deeper work). The assignment is best effort: when it cannot be made (the agent is retired, the task already has an owner) the task stays open,
 * names its owner in its description and `assigned` is false. A repeat with the same command ID makes no second task and no second assignment.
 */
export function floorFollowUps(deps: {
  readonly createTask: (command: { commandId: string; actor: string; projectId: string; title: string; description: string }) => Promise<{ id: string }>;
  readonly assignTask: (command: AssignTask) => Promise<unknown>;
  readonly actor: string;
}): NonNullable<FloorDeps["followUps"]> {
  return {
    create: async (i) => {
      const t = await deps.createTask({ commandId: i.commandId, actor: deps.actor, projectId: i.projectId, title: i.title.slice(0, 150), description: `${i.description}${i.owner === undefined ? "" : ` Owner: ${i.owner}.`}`.slice(0, 2000) });
      const agent = i.owner === undefined ? undefined : AGENT_OWNER.exec(i.owner)?.[1];
      if (agent === undefined) return { id: t.id };
      try {
        await deps.assignTask({ commandId: `${i.commandId}:own`, actor: deps.actor, taskId: t.id, owner: { kind: "agent", id: agent }, reason: "follow-up work a meeting left open" } as AssignTask);
        return { id: t.id, assigned: true };
      } catch { return { id: t.id, assigned: false }; }
    },
  };
}

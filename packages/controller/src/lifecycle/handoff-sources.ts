import type { Owner } from "../domain/assignment-model.js";
import type { TaskBody, View } from "../domain/model.js";
import type { ContractService } from "../planning/contracts.js";
import type { HandoffSources } from "./handoff.js";

/**
 * What the controller itself knows for a hand-off package (card L03b): the task's title and description as the brief, the contract's acceptance criteria and version, and the evidence the contract
 * requires. Sections that need other services (unfinished work, next action, drafts, uncommitted changes, background operations, locks) are left out until those are connected; the package then reports
 * them missing and the caller must accept the gap, which is recorded. Nothing here is invented to fill a section.
 */
export function controllerHandoffSources(deps: {
  getTask(taskId: string): Promise<View<TaskBody> | undefined>;
  contracts: Pick<ContractService, "runner">;
  /** The state of an agent record, or undefined when there is none. */
  agentState(id: string): Promise<"active" | "retired" | undefined>;
  /** Extra sections from services that hold them (continuation, locks, background operations), each already limited to what the recipient may see. */
  more?: (request: { taskId: string; from: Owner; to: Owner }) => Promise<Readonly<Record<string, string>>>;
}): HandoffSources {
  return {
    async collect({ taskId, from, to }) {
      const sections: Record<string, string> = {};
      const task = await deps.getTask(taskId);
      if (task !== undefined) sections["brief"] = `${task.title}\n${task.description}`.trim();
      const contract = (await deps.contracts.runner.get("task-contract", taskId))?.body as unknown as { version?: number; acceptanceCriteria?: readonly string[]; requiredEvidence?: readonly string[] } | undefined;
      if (contract?.acceptanceCriteria !== undefined && contract.acceptanceCriteria.length > 0) sections["acceptanceCriteria"] = contract.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
      if (contract?.version !== undefined) sections["versions"] = `task contract version ${contract.version}`;
      if (contract?.requiredEvidence !== undefined && contract.requiredEvidence.length > 0) sections["risks"] = `Evidence still required: ${contract.requiredEvidence.join(", ")}`;
      Object.assign(sections, await deps.more?.({ taskId, from, to }));
      return { sections };
    },
    async ineligible(to) {
      if (to.kind !== "agent") return `${to.kind} is not something a task can be handed to`;
      const state = await deps.agentState(to.id);
      return state === undefined ? "no such agent" : state === "retired" ? "that agent is retired" : undefined;
    },
  };
}

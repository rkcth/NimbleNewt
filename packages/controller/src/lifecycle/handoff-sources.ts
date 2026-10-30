import type { Owner } from "../domain/assignment-model.js";
import type { TaskBody, View } from "../domain/model.js";
import type { ContractService } from "../planning/contracts.js";
import type { HandoffSources } from "./handoff.js";

interface ContinuationShape {
  readonly seq: number; readonly capturedAt: string;
  readonly continuation: { readonly artifacts: readonly string[]; readonly decisions: readonly string[]; readonly pendingEffects: readonly { readonly effectId: string; readonly state: string }[]; readonly nextStep: string };
  readonly manifest: { readonly routingRevision: number; readonly environmentRevision: number };
  readonly checkpoint: { readonly runtime: { readonly name: string; readonly version: string } };
  readonly nonCheckpointableTools: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * What the controller itself knows for a hand-off package (card L03b): the task's title and description as the brief, the contract's acceptance criteria and version, and the evidence the contract
 * requires. The sections only the run knows (next action, unfinished work, completed work, background operations, risks, versions) come from the task's latest complete continuation (card L03g). Sections that need other services (drafts, uncommitted changes, locks) are left out until those are connected; the package then reports
 * them missing and the caller must accept the gap, which is recorded. Nothing here is invented to fill a section.
 */
export function controllerHandoffSources(deps: {
  getTask(taskId: string): Promise<View<TaskBody> | undefined>;
  contracts: Pick<ContractService, "runner">;
  /** The state of an agent record, or undefined when there is none. */
  agentState(id: string): Promise<"active" | "retired" | undefined>;
  /** Whether the agent holds the right to work on tasks of the project (card L03d): a task is not handed to an agent that could not act on it. Without it the access is not checked. */
  canWork?(agentId: string, projectId: string): Promise<boolean>;
  /** Extra sections from services that hold them (continuation, locks, background operations), each already limited to what the recipient may see. */
  more?: (request: { taskId: string; from: Owner; to: Owner }) => Promise<Readonly<Record<string, string>>>;
}): HandoffSources {
  // What the task's latest complete continuation says (card L03g) fills the sections that only the run itself knows. The controller reads it for the hand-off the caller was already allowed to ask for.
  const fromContinuation = async (taskId: string): Promise<Record<string, string>> => {
    const head = (await deps.contracts.runner.get("continuation-head", taskId))?.body as unknown as { latestCompleteId?: string } | undefined;
    if (head?.latestCompleteId === undefined) return {};
    const c = (await deps.contracts.runner.get("continuation", head.latestCompleteId))?.body as unknown as ContinuationShape | undefined;
    if (c === undefined) return {};
    const out: Record<string, string> = {};
    const at = `continuation ${c.seq}, captured ${c.capturedAt}`;
    if (c.continuation.nextStep.trim() !== "") out["nextAction"] = `${c.continuation.nextStep.trim()} (from ${at})`;
    const pending = c.continuation.pendingEffects;
    // With nothing pending the section stays unset: "no effect pending" does not say there is no other unfinished work, and a package must not read as ready on that.
    if (pending.length > 0) out["unfinishedWork"] = `Effects pending at the last checkpoint (${at}): ${pending.map((e) => `${e.effectId} (${e.state})`).join(", ")}.`;
    if (pending.length > 0) out["backgroundOperations"] = pending.map((e) => `${e.effectId}: ${e.state}`).join("\n");
    const done = [...c.continuation.decisions.map((d) => `Decision: ${d}`), ...c.continuation.artifacts.map((a) => `Artifact: ${a}`)];
    if (done.length > 0) out["completedWork"] = done.join("\n");
    if (c.nonCheckpointableTools.length > 0) out["risks"] = `Tools whose effects a resume does not reproduce: ${c.nonCheckpointableTools.map((t) => `${t.name} (${t.reason})`).join("; ")}.`;
    out["versions"] = `runtime ${c.checkpoint.runtime.name} ${c.checkpoint.runtime.version}, routing revision ${c.manifest.routingRevision}, environment revision ${c.manifest.environmentRevision} (${at})`;
    return out;
  };
  return {
    async collect({ taskId, from, to }) {
      const sections: Record<string, string> = {};
      const task = await deps.getTask(taskId);
      if (task !== undefined) sections["brief"] = `${task.title}\n${task.description}`.trim();
      const contract = (await deps.contracts.runner.get("task-contract", taskId))?.body as unknown as { version?: number; acceptanceCriteria?: readonly string[]; requiredEvidence?: readonly string[] } | undefined;
      if (contract?.acceptanceCriteria !== undefined && contract.acceptanceCriteria.length > 0) sections["acceptanceCriteria"] = contract.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
      if (contract?.version !== undefined) sections["versions"] = `task contract version ${contract.version}`;
      if (contract?.requiredEvidence !== undefined && contract.requiredEvidence.length > 0) sections["risks"] = `Evidence still required: ${contract.requiredEvidence.join(", ")}`;
      // The task's own record wins where it has the section (its contract version, its evidence); the continuation adds what it alone knows.
      const run = await fromContinuation(taskId);
      for (const [k, v] of Object.entries(run)) if (sections[k] === undefined) sections[k] = v; else if (k === "risks" || k === "versions") sections[k] = `${sections[k]}\n${v}`;
      Object.assign(sections, await deps.more?.({ taskId, from, to }));
      return { sections };
    },
    async ineligible(to, { taskId }) {
      if (to.kind !== "agent") return `${to.kind} is not something a task can be handed to`;
      const state = await deps.agentState(to.id);
      if (state === undefined) return "no such agent";
      if (state === "retired") return "that agent is retired";
      const projectId = (await deps.getTask(taskId))?.projectId;
      if (deps.canWork !== undefined && projectId !== undefined && !(await deps.canWork(to.id, projectId))) return "that agent has no right to work in the task's project";
      return undefined;
    },
  };
}

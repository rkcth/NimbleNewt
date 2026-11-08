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

/** Oldest change first (a stable sort: items with no time keep their place before those with one, in the source's order). */
const oldestFirst = <T extends { readonly updatedAt?: string }>(items: readonly T[] | undefined): readonly T[] | undefined =>
  items?.map((x, i) => ({ x, i })).sort((p, q) => (p.x.updatedAt ?? "").localeCompare(q.x.updatedAt ?? "") || p.i - q.i).map((p) => p.x);

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
  /** The sending agent's shared drafts on this task (never private scratch): the recipient could not otherwise read another agent's draft. */
  drafts?(request: { taskId: string; projectId: string; from: Owner }): Promise<readonly { readonly id: string; readonly title: string; readonly body: string; /** When it last changed: the section lists them oldest first, so a cut keeps the newest (card C07j review). */ readonly updatedAt?: string }[]>;
  /** The responsibilities the sending agent answers for in the task's project, whether or not they touch this task. */
  responsibilities?(request: { projectId: string; from: Owner }): Promise<readonly { readonly id: string; readonly title: string; readonly desiredCondition: string; readonly state: string; /** As for drafts. */ readonly updatedAt?: string }[]>;
  /** What the sending agent holds locked or leased for this task (workspace, branch, integrator lease), when a service keeps such holds. Each line is limited to what `to` may see; a line may also say that part of the answer is missing (a gap, not an absence). */
  locks?(request: { taskId: string; projectId: string; from: Owner; to: Owner }): Promise<readonly string[]>;
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
    // One effect per line under a heading line (card C07j review, round 4): a section over the limit keeps its heading and its last lines, so the newest pending effects stay in view; on one line a cut kept the oldest.
    if (pending.length > 0) out["unfinishedWork"] = [`Effects pending at the last checkpoint (${at}), in the order the run listed them:`, ...pending.map((e) => `${e.effectId} (${e.state})`)].join("\n");
    if (pending.length > 0) out["backgroundOperations"] = pending.map((e) => `${e.effectId}: ${e.state}`).join("\n");
    // Artifacts first and decisions last (card C07j review): a section over the limit keeps its last entries, so the newest decision must not sit above a long artifact list that would push it out.
    const done = [...c.continuation.artifacts.map((a) => `Artifact: ${a}`), ...c.continuation.decisions.map((d) => `Decision: ${d}`)];
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
      const projectId = task?.projectId;
      // Each of these is the sender's own and is given to the recipient by this hand-off, which the caller was already allowed to ask for; a failing source leaves its section missing rather than failing the package.
      if (projectId !== undefined) {
        // Record IDs are hashes, so a source's ID order says nothing of age: both lists are put oldest first, as every section is, for a cut keeps the last entries (card C07j review).
        const drafts = await deps.drafts?.({ taskId, projectId, from }).then(oldestFirst).catch(() => undefined);
        if (drafts !== undefined && drafts.length > 0) sections["drafts"] = drafts.map((d) => `${d.id} "${d.title}": ${d.body.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
        const owned = await deps.responsibilities?.({ projectId, from }).then(oldestFirst).catch(() => undefined);
        if (owned !== undefined && owned.length > 0) sections["responsibilities"] = `${from.id} answers for these in the project; they stay with ${from.id} unless moved with the hand-off (complete it with reassignResponsibilities listing the IDs to move; the owner or anyone who may assign responsibilities decides), and the recipient should know of them:\n${owned.map((r) => `${r.id} "${r.title}" (${r.state}): ${r.desiredCondition.replace(/\s+/g, " ").slice(0, 200)}`).join("\n")}`;
        const held = await deps.locks?.({ taskId, projectId, from, to }).catch(() => undefined);
        if (held !== undefined && held.length > 0) sections["locks"] = held.join("\n");
      }
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

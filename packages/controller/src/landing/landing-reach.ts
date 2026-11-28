import { DomainError } from "../domain/errors.js";
import { allowsExactly } from "../security/access.js";
import type { Principal } from "../security/principals.js";

/**
 * What a landing task's own credential reaches (card P10b, second clause: "credentials and context are fresh per project"). A woken integrator's attempt runs on its A10b task credential, cut to the landing task and
 * its project. That credential reaches exactly one thing beyond what every task credential has: the integrator lease of the one branch its landing task lands, in that task's project, and the landing made under it.
 * Nothing else: no other project, no other branch, no other agent's lease, no other workspace operation, and nothing the agent's own credential could do in the pool across projects.
 *
 * `IntegratorWake.landingReach` decides it on every call, from the records: the credential is an agent's task credential; its task has a sound `landing-task` record naming that agent; the task is assigned to that
 * agent now (`landingOf`); the branch's current wake names this very task and agent; and the task is open. Anything else (an ordinary task, a landing task given to someone else, an ended or replaced wake, a damaged
 * record) is no reach, and the lease door, the pool and the workspace service refuse the credential as before.
 */
export interface LandingReach {
  /** The landing task the credential was issued for. */
  readonly taskId: string;
  readonly projectId: string;
  /** The one landing branch whose lease and landing it reaches. */
  readonly branch: string;
  /** The integrator (bare agent ID) the wake woke; the credential must be this agent's. */
  readonly agentId: string;
}

export type LandingReachOf = (by: Principal) => Promise<LandingReach | undefined>;

/**
 * Whether a task-scoped principal reaches the lease (and landing) of `projectId`, on `branch` when one is named, through its landing reach. Also needs the agent's own exact right `integration.lease` on that project,
 * as every integrator does (the task credential keeps the agent's grants for its project, so a right taken away stops it at once).
 */
export function reachServes(by: Principal, reach: LandingReach | undefined, projectId: string, branch?: string): boolean {
  const scope = by.taskScope;
  return reach !== undefined && scope !== undefined && by.kind === "agent" && by.id === `agent:${reach.agentId}` && scope.taskId === reach.taskId && scope.projectId === reach.projectId
    && reach.projectId === projectId && (branch === undefined || branch === reach.branch) && allowsExactly(by, "integration.lease", projectId);
}

/** The reach of a task credential, or none: an own credential has none, and a refusal while reading (damage included) is none (fail closed). Any other failure is thrown. */
export async function reachOf(of: LandingReachOf | undefined, by: Principal): Promise<LandingReach | undefined> {
  if (of === undefined || by.taskScope === undefined) return undefined;
  try { return await of(by); } catch (error) { if (error instanceof DomainError) return undefined; throw error; }
}

/**
 * The key a principal's command IDs are scoped by in the lease door, the pool and the workspace service. An own credential: its principal ID, as before. A task credential: its principal ID and its task, so two takes of
 * one integrator (two landing tasks, in one project or two) never meet in a command: a repeat of a command ID in a later take is a new command, never a replay of another take's recorded answer. At most 72 characters
 * (an agent ID of at most 46, a dot and a task ID), so a scoped command ID stays within the 120 a command ID may have.
 */
export const takeKeyOf = (by: Principal): string => (by.taskScope === undefined ? by.id : `${by.id}.${by.taskScope.taskId}`);

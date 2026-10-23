import { DomainError } from "../domain/errors.js";
import type { Principal } from "./principals.js";
import { redactText } from "./redact.js";

/**
 * The actions the controller's own services expose, by the name a grant uses (card A01). A grant names an action (or `task.*`, or `*`) and a project
 * (or `*`). The owner may do everything. Anyone else may do exactly what a grant covers, in the project it names: a grant for project A says nothing about
 * project B. Actions that belong to no project (creating a project, managing principals) need a grant whose project is `*`.
 */
export const ACTIONS = [
  "project.create", "project.read", "project.update",
  "task.create", "task.read", "task.update", "task.transition",
  "assignment.manage", "assignment.read",
  "attempt.work",
  "artifact.publish", "artifact.read",
  "effect.perform",
  "wait.manage", "blocker.manage",
  "desk.write", "desk.read", "desk.scratch.read", "notes.chair.read",
  "history.append", "history.read",
  "review.request", "review.decide", "review.policy.write",
  "config.read", "config.write", "routing.write", "recovery.read",
  "conversation.start", "conversation.send", "conversation.receive", "conversation.request-action", "conversation.urgent",
  "principal.manage", "notification.emit", "catalog.register", "catalog.revoke", "catalog.read", "environment.manage", "mcp.use", "events.publish",
  "agent.manage", "agent.read",
  "task.contract.write", "task.priority.write", "task.difficulty.write", "task.class.write", "task.dependency.write",
  "budget.manage", "budget.read",
  "resource.read", "resource.write", "resource.scope.write", "project.plan.write", "project.participants.write",
  "responsibility.read", "responsibility.write", "responsibility.assign",
  "meeting.manage", "meeting.agenda", "meeting.read",
  "message.send", "message.urgent",
] as const;
export type Action = (typeof ACTIONS)[number];

/** Whether an action may be held by a `client` principal: a single named conversation action, never `*` or a prefix that could grow to cover others. */

/** Whether an action may be held by a `client` principal: a single named conversation action, never `*` or a prefix that could grow to cover others. */
export const clientMayHold = (action: string): boolean => /^conversation\.[a-z][a-z-]*$/.test(action);

/** Whether an action may be held by a service principal (the recovery service): a single named `recovery.*` action. */
export const serviceMayHold = (action: string): boolean => /^recovery\.[a-z][a-z-]*$/.test(action);

/** Whether a principal of this kind may hold this action at all, however it is granted. Clients and services are confined to their own families; the other kinds are not limited here. */
export const mayHold = (kind: string, action: string): boolean => (kind === "client" ? clientMayHold(action) : kind === "service" ? serviceMayHold(action) : true);

export const covers = (grantAction: string, action: string): boolean =>
  grantAction === "*" || grantAction === action || (grantAction.endsWith(".*") && action.startsWith(grantAction.slice(0, -1)));

/** What an access check may add: the resource the action is on (a narrow grant matches only that resource) and the time to judge expiry by (default: now). */
export interface CheckOptions {
  readonly resource?: { readonly kind: string; readonly id: string };
  readonly now?: string;
}

const sameResource = (a: { kind: string; id: string }, b: { kind: string; id: string }): boolean => a.kind === b.kind && a.id === b.id;
const projectMatches = (scope: string, project: string | undefined): boolean => scope === "*" || (project !== undefined && scope === project);

/** A task credential reaches its task's project only, and no other task by resource; an action that belongs to no project is out of reach. */
function outsideTask(principal: Principal, project: string | undefined, options: CheckOptions): boolean {
  const scope = principal.taskScope;
  if (scope === undefined) return false;
  if (project !== scope.projectId) return true;
  return options.resource !== undefined && options.resource.kind === "task" && options.resource.id !== scope.taskId;
}

/** False for a task credential asked about another project; true for every other principal. For rules decided by who a record belongs to, which `allows` does not see. */
export const inTaskScope = (principal: Principal, projectId: string): boolean => principal.taskScope === undefined || principal.taskScope.projectId === projectId;

/** Whether a standing restriction forbids it. A restriction that names a resource applies when the action is on that resource, or when the caller did not say which resource (the safe reading). */
function restricted(principal: Principal, action: string, project: string | undefined, options: CheckOptions): boolean {
  return (principal.restrictions ?? []).some((r) => covers(r.action, action) && projectMatches(r.project, project) && (r.resource === undefined || options.resource === undefined || sameResource(r.resource, options.resource)));
}

/**
 * Whether the principal may take the action on the project (`undefined`: an action that has none). A restriction always wins over a grant; a grant counts only
 * inside its project, for its resource (a grant that names one resource says nothing about others) and before it expires. The owner may do everything.
 */
export function allows(principal: Principal, action: string, project: string | undefined, options: CheckOptions = {}): boolean {
  if (principal.kind === "owner") return true;
  if (outsideTask(principal, project, options)) return false;
  // A principal that did not come from authentication (or `GrantService.effective`) has not had its restrictions loaded: it is refused rather than trusted.
  if (principal.asOf === undefined || restricted(principal, action, project, options)) return false;
  const now = options.now ?? new Date().toISOString();
  return principal.grants.some((g) => covers(g.action, action) && projectMatches(g.project, project)
    && (g.expiresAt === undefined || g.expiresAt > now) && (g.resource === undefined || (options.resource !== undefined && sameResource(g.resource, options.resource))));
}

/** Whether a grant names this exact action (not through `*` or a prefix) in the project: used where a broad grant must not be enough, such as reading another agent's private scratch. */
export function allowsExactly(principal: Principal, action: string, project: string | undefined, options: CheckOptions = {}): boolean {
  if (principal.kind === "owner") return true;
  if (outsideTask(principal, project, options)) return false;
  if (principal.asOf === undefined || restricted(principal, action, project, options)) return false;
  const now = options.now ?? new Date().toISOString();
  return principal.grants.some((g) => g.action === action && projectMatches(g.project, project)
    && (g.expiresAt === undefined || g.expiresAt > now) && (g.resource === undefined || (options.resource !== undefined && sameResource(g.resource, options.resource))));
}

/** Refuses with `forbidden` unless allowed. The message says what was refused and never anything about other projects or principals. */
export function requireAction(principal: Principal, action: string, project: string | undefined, options: CheckOptions = {}): void {
  if (!allows(principal, action, project, options)) {
    throw new DomainError("forbidden", redactText(`${principal.id} may not ${action}${project === undefined ? "" : ` in ${project}`}`));
  }
}

/** Tool names are checked the same way, as the action `tool.<name>` in the project the call is for. */
export const toolAction = (toolName: string): string => `tool.${toolName}`;

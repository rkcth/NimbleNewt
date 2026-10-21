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
  "principal.manage",
] as const;
export type Action = (typeof ACTIONS)[number];

const covers = (grantAction: string, action: string): boolean =>
  grantAction === "*" || grantAction === action || (grantAction.endsWith(".*") && action.startsWith(grantAction.slice(0, -1)));

/** Whether the principal may take the action on the project (`undefined`: an action that has none). */
export function allows(principal: Principal, action: string, project: string | undefined): boolean {
  if (principal.kind === "owner") return true;
  return principal.grants.some((g) => covers(g.action, action) && (g.project === "*" || (project !== undefined && g.project === project)));
}

/** Whether a grant names this exact action (not through `*` or a prefix) in the project: used where a broad grant must not be enough, such as reading another agent's private scratch. */
export function allowsExactly(principal: Principal, action: string, project: string | undefined): boolean {
  if (principal.kind === "owner") return true;
  return principal.grants.some((g) => g.action === action && (g.project === "*" || (project !== undefined && g.project === project)));
}

/** Refuses with `forbidden` unless allowed. The message says what was refused and never anything about other projects or principals. */
export function requireAction(principal: Principal, action: string, project: string | undefined): void {
  if (!allows(principal, action, project)) {
    throw new DomainError("forbidden", redactText(`${principal.id} may not ${action}${project === undefined ? "" : ` in ${project}`}`));
  }
}

/** Tool names are checked the same way, as the action `tool.<name>` in the project the call is for. */
export const toolAction = (toolName: string): string => `tool.${toolName}`;

import { DomainError } from "./errors.js";

// ---- projects ------------------------------------------------------------------------------------------------------------------

export type ProjectState = "active" | "archived";

/**
 * A repository a project works in. A project may have none (it can start before a repository exists, and non-code work never has one),
 * one, or several. `id` is the project's own stable handle for it; `location` is opaque to the controller here.
 */
export interface Repository {
  readonly id: string;
  readonly location: string;
  readonly label?: string;
}

/** A named strand of a project's work (card P01). Optional structure: nothing requires a project to have any. */
export interface Workstream { readonly id: string; readonly name: string; readonly description?: string }
/** A point in a project's plan. `dueDate` is information: passing it changes no state, and `reached` is set only by a command. */
export interface Milestone { readonly id: string; readonly name: string; readonly state: "open" | "reached"; readonly dueDate?: string; readonly workstreamId?: string }
/** An agent the owner has authorized to take part in the project (card P01). The record grants nothing by itself; grants are separate (A01). */
export interface Participant { readonly principalId: string; readonly role?: string }

export interface ProjectBody {
  readonly name: string;
  readonly goal: string;
  readonly state: ProjectState;
  readonly repositories: readonly Repository[];
  readonly createdBy: string;
  /** Planning fields (card P01), set by the project-plan command and kept by every other project command. */
  readonly dueDate?: string;
  readonly workstreams?: readonly Workstream[];
  readonly milestones?: readonly Milestone[];
  readonly participants?: readonly Participant[];
}

// ---- tasks ---------------------------------------------------------------------------------------------------------------------

export type TaskState = "proposed" | "ready" | "in_progress" | "blocked" | "done" | "cancelled";
export const TASK_STATES: readonly TaskState[] = ["proposed", "ready", "in_progress", "blocked", "done", "cancelled"];

/** The lifecycle of a task record. `done` and `cancelled` are final. Who is working on a task is a separate record (card S02), not a state. */
export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  proposed: ["ready", "cancelled"],
  ready: ["in_progress", "blocked", "cancelled"],
  in_progress: ["blocked", "done", "cancelled"],
  blocked: ["ready", "in_progress", "cancelled"],
  done: [],
  cancelled: [],
};

export interface TaskBody {
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly state: TaskState;
  /** One of the project's repositories. Absent for a task that has none; a task never needs one. */
  readonly repositoryId?: string;
  readonly createdBy: string;
}

/** A stored record with its identity and revision, as the service returns it. */
export type View<B> = B & { readonly id: string; readonly revision: number; readonly createdAt: string; readonly updatedAt: string };

// ---- validation ------------------------------------------------------------------------------------------------------------------

export const LIMITS = { name: 120, goal: 4000, title: 200, description: 8000, locationLength: 500, label: 80, repositories: 50, commandId: 120, actor: 120 } as const;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const PROJECT_ID = /^proj-[a-z2-7]{20}$/;
const TASK_ID = /^task-[a-z2-7]{20}$/;
const ARTIFACT_ID = /^art-[a-z2-7]{20}$/;

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/** Text that is stored and shown: well-formed Unicode, no control characters (a newline is allowed where `multiline` is). */
export function text(value: unknown, field: string, options: { min: number; max: number; multiline?: boolean }): string {
  if (typeof value !== "string") return invalid(field, "must be text");
  if (value.length < options.min || value.length > options.max) return invalid(field, options.min === 0 ? `must be at most ${options.max} characters` : `must be ${options.min} to ${options.max} characters`);
  if (LONE_SURROGATE.test(value)) return invalid(field, "must be well-formed Unicode text");
  // eslint-disable-next-line no-control-regex
  if (options.multiline === true ? /[\u0000-\u0009\u000b-\u001f\u007f]/.test(value) : /[\u0000-\u001f\u007f]/.test(value)) return invalid(field, "must not contain control characters");
  if (options.min > 0 && value.trim().length === 0) return invalid(field, "must not be blank");
  return value;
}

export const commandId = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > LIMITS.commandId || !COMMAND_ID.test(value)) return invalid("commandId", `must be 1 to ${LIMITS.commandId} ASCII letters, digits, '.', '_', ':' or '-', starting with a letter or digit`);
  return value;
};
export const actor = (value: unknown): string => text(value, "actor", { min: 1, max: LIMITS.actor });
export const projectId = (value: unknown): string => (typeof value === "string" && PROJECT_ID.test(value) ? value : invalid("projectId", "is not a project ID"));
export const artifactId = (value: unknown): string => (typeof value === "string" && ARTIFACT_ID.test(value) ? value : invalid("artifactId", "is not an artifact ID"));
export const taskId = (value: unknown): string => (typeof value === "string" && TASK_ID.test(value) ? value : invalid("taskId", "is not a task ID"));
export function revision(value: unknown, field = "expectedRevision"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid(field, "must be a whole number of at least 1");
  return value;
}
export function taskState(value: unknown, field = "to"): TaskState {
  if (typeof value !== "string" || !(TASK_STATES as readonly string[]).includes(value)) return invalid(field, `must be one of ${TASK_STATES.join(", ")}`);
  return value as TaskState;
}
export function repositories(value: unknown, field: string): Repository[] {
  if (!Array.isArray(value)) return invalid(field, "must be a list");
  if (value.length > LIMITS.repositories) return invalid(field, `must have at most ${LIMITS.repositories} entries`);
  const seen = new Set<string>();
  return value.map((raw: unknown, i) => {
    const at = `${field}[${i}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid(at, "must be an object");
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (key !== "id" && key !== "location" && key !== "label") invalid(`${at}.${key}`, "is not a repository field");
    const id = typeof entry["id"] === "string" && REPOSITORY_ID.test(entry["id"]) ? entry["id"] : invalid(`${at}.id`, "must be 1 to 40 lower-case letters, digits or hyphens, starting with a letter or digit");
    if (seen.has(id)) invalid(`${at}.id`, `repeats ${id}`);
    seen.add(id);
    const location = text(entry["location"], `${at}.location`, { min: 1, max: LIMITS.locationLength });
    return entry["label"] === undefined ? { id, location } : { id, location, label: text(entry["label"], `${at}.label`, { min: 1, max: LIMITS.label }) };
  });
}
export const repositoryId = (value: unknown, field: string): string =>
  (typeof value === "string" && REPOSITORY_ID.test(value) ? value : invalid(field, "is not a repository ID"));

/** Rejects any field the command does not define: a misspelt option must not be silently ignored. */
export function onlyKnown(command: object, known: readonly string[]): void {
  for (const key of Object.keys(command)) if (!known.includes(key)) invalid(key, "is not a field of this command");
}

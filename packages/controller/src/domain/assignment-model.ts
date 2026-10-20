import { DomainError } from "./errors.js";
import { text } from "./model.js";

/** Who works on a task: an agent (or a person) the controller knows by a stable ID. `kind` is free text such as `agent` or `person`. */
export interface Owner {
  readonly kind: string;
  readonly id: string;
}

export type AssignmentState = "assigned" | "released";

/**
 * The current assignment of one task (kind `assignment`, one per task, created by the first assignment and never deleted). `generation`
 * counts ownership changes: it starts at 1, a transfer or a new assignment after a release makes it one higher, and every mutation made
 * on a task by or for an owner carries the generation it believes is current. Whatever carries an older generation is refused (`fenced`).
 * `activeAttemptId` is the one attempt that may write now; an attempt belongs to one generation.
 */
export interface AssignmentBody {
  readonly taskId: string;
  readonly generation: number;
  readonly state: AssignmentState;
  /** Absent while released. */
  readonly owner?: Owner;
  readonly activeAttemptId?: string;
  /** Attempts admitted so far, over all generations. */
  readonly attempts: number;
}

/** One generation of ownership (kind `assignment-generation`), written when the generation begins and never changed: the assignment history. */
export interface GenerationBody {
  readonly taskId: string;
  readonly generation: number;
  readonly owner: Owner;
  readonly assignedBy: string;
  /** How the generation began. */
  readonly cause: "assigned" | "transferred" | "reassigned";
  readonly previousOwner?: Owner;
  readonly reason?: string;
}

export type AttemptState = "active" | "succeeded" | "failed" | "abandoned" | "superseded" | "released";

/** One attempt of an owner at a task (kind `attempt`): the unit that may write. At most one attempt of a task is active at any time. */
export interface AttemptBody {
  readonly taskId: string;
  readonly generation: number;
  readonly owner: Owner;
  /** 1 for the task's first attempt, over all generations. */
  readonly number: number;
  readonly state: AttemptState;
  readonly admittedBy: string;
  readonly summary?: string;
}

/**
 * What the controller has observed from a worker about a task (kind `activity`, one per task). It is **not** ownership: a worker that
 * lost its generation can still be seen working, and that is worth knowing, but seeing it never renews, grants or restores anything.
 * `current` is whether the last observation carried the generation that was current when it was recorded.
 */
export interface ActivityBody {
  readonly taskId: string;
  readonly observedBy: string;
  readonly generation: number;
  readonly current: boolean;
  readonly kind: string;
  readonly detail: string;
  readonly observedAt: string;
  readonly observations: number;
}

/** The token a mutation made on behalf of an owner carries. */
export interface Fence {
  readonly generation: number;
  readonly attemptId: string;
}

export const ASSIGNMENT_LIMITS = { ownerKind: 40, ownerId: 120, reason: 500, summary: 2000, activityKind: 40, activityDetail: 500 } as const;

const OWNER_KIND = /^[a-z][a-z0-9-]{0,39}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

export function owner(value: unknown, field = "owner"): Owner {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(field, "must be an object with kind and id");
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (key !== "kind" && key !== "id") invalid(`${field}.${key}`, "is not an owner field");
  const kind = typeof entry["kind"] === "string" && OWNER_KIND.test(entry["kind"]) ? entry["kind"] : invalid(`${field}.kind`, "must be 1 to 40 lower-case letters, digits or hyphens, starting with a letter");
  return { kind, id: text(entry["id"], `${field}.id`, { min: 1, max: ASSIGNMENT_LIMITS.ownerId }) };
}

export const sameOwner = (a: Owner, b: Owner): boolean => a.kind === b.kind && a.id === b.id;

export function generation(value: unknown, field = "generation"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid(field, "must be a whole number of at least 1");
  return value;
}

const ATTEMPT_ID = /^att-[a-z2-7]{20}$/;
export const attemptId = (value: unknown, field = "attemptId"): string => (typeof value === "string" && ATTEMPT_ID.test(value) ? value : invalid(field, "is not an attempt ID"));

export function fence(value: unknown): Fence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("fence", "must be an object with generation and attemptId");
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (key !== "generation" && key !== "attemptId") invalid(`fence.${key}`, "is not a fence field");
  return { generation: generation(entry["generation"], "fence.generation"), attemptId: attemptId(entry["attemptId"], "fence.attemptId") };
}

/** Assignment IDs derive from the task: one assignment per task, and two first assignments of one task collide on it. */
export const assignmentIdOf = (taskId: string): string => `asg-${taskId.slice(5)}`;
/** Generation records sort by task and then by generation (zero-padded), so a task's history is one contiguous range. */
export const generationIdOf = (taskId: string, n: number): string => `agen-${taskId.slice(5)}-${String(n).padStart(10, "0")}`;
export const activityIdOf = (taskId: string): string => `act-${taskId.slice(5)}`;

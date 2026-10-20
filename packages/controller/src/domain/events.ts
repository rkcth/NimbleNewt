import type { AggregateRef, JsonObject, OutboxEntry } from "../storage/types.js";
import type { TaskBody } from "./model.js";

/** The outbox destination of task events. A consumer (the engine bridge, later cards) claims deliveries for this destination. */
export const TASK_EVENTS = "task-events";

export type TaskEventChange = "created" | "updated" | "transitioned" | "reconciled";

/**
 * What a task event says: "task `taskId` of project `projectId` is at `revision` and in `state`". Events are snapshots, not diffs, so a
 * receiver that missed an earlier one (or sees one twice, or late) loses nothing by applying the newest and ignoring any with a
 * revision it has already seen. `from` is present for a transition.
 */
export interface TaskEvent {
  readonly taskId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly state: string;
  readonly change: TaskEventChange;
  readonly from?: string;
}

/**
 * The delivery ID of the event for one revision of one task: stable, so the same revision can never be announced twice (storage rejects a
 * second use of the ID) and a repair can ask whether a revision already has its event. IDs are at most 200 characters (a task ID is 25).
 */
export const taskEventId = (taskId: string, revision: number): string => `tev:${taskId}:${revision}`;

export function taskEventEntry(taskId: string, body: TaskBody, revision: number, change: TaskEventChange, from?: string): OutboxEntry {
  const aggregate: AggregateRef = { kind: "task", id: taskId };
  const event: TaskEvent = { taskId, projectId: body.projectId, revision, state: body.state, change, ...(from === undefined ? {} : { from }) };
  return { deliveryId: taskEventId(taskId, revision), destination: TASK_EVENTS, orderingKey: taskId, priority: 5, aggregate, payload: event as unknown as JsonObject };
}

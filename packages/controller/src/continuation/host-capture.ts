import { createHash } from "node:crypto";
import type { LineageEarlier } from "../context/lineage.js";
import { clipText } from "../activity/activity.js";
import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { JsonObject } from "../storage/types.js";
import { CONTINUATION_LIMITS, type BoundaryKind, type ContinuationBody, type ContinuationInput, type ContinuationService } from "./continuation.js";

/** A checkpoint a worker host handed the dispatcher for an attempt, at a safe boundary (card L04d). */
export interface CheckpointTaken {
  readonly attemptId: string;
  readonly taskId: string;
  /** The run's agent (`agent:<id>`). */
  readonly agentId: string;
  /** Why it was taken, in the controller's words ("the turn completed", "the controller shut down", a stop's reason). */
  readonly reason: string;
  readonly boundary: BoundaryKind;
  /** The checkpoint as the host wrote it: `{ pi, nn }` for the local and remote Pi hosts. */
  readonly checkpoint: JsonObject;
}

/** What the controller itself knows of a task at a capture, each read best effort (a source that fails or is absent leaves its part as the capture's honest default). */
export interface CaptureSources {
  /** The task's latest compaction (card C07q): the summary lineage the capture names, newest IDs listed and the rest folded. */
  compaction?(taskId: string): Promise<{ readonly id: string; readonly lineage: readonly string[]; readonly earlier?: LineageEarlier } | undefined>;
  /** The task's budget from accounting: spent and still available, in one unit. */
  budget?(taskId: string): Promise<{ readonly spent: number; readonly remaining: number; readonly unit: string } | undefined>;
  /** The task's latest complete continuation: its identity is kept, and the artifacts and decisions it names are carried forward. */
  previous?(taskId: string): Promise<(ContinuationBody & { id: string }) | undefined>;
}

export type CaptureOutcome = { readonly captured: { readonly id: string; readonly status: "complete" | "incomplete"; readonly replayed: boolean } } | { readonly skipped: string } | { readonly failed: string };

const DIGEST = /^v1:sha256:[0-9a-f]{64}$/;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const short = (text: string, max: number): string => { const t = redactText(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim(); return t.length <= max ? t : `${clipText(t, max - 1)}…`; };

/** The adapter's checkpoint reference inside a host's checkpoint, when it is one the capture can name; otherwise why not. A checkpoint taken in the middle of a turn has none: a turn in progress is not a boundary. */
export function adapterCheckpointOf(taken: JsonObject): ContinuationInput["checkpoint"] | string {
  const pi = (taken as Record<string, unknown>)["pi"];
  if (!isObject(pi)) return isObject((taken as Record<string, unknown>)["nn"]) && ((taken as Record<string, unknown>)["nn"] as Record<string, unknown>)["midTurn"] === true ? "the checkpoint was taken in the middle of a turn" : "the host's checkpoint carries no adapter checkpoint";
  const rt = pi["runtime"];
  if (!count(pi["conversationId"]) || !count(pi["at"]) || !count(pi["format"]) || typeof pi["digest"] !== "string" || !DIGEST.test(pi["digest"]) || !isObject(rt) || typeof rt["name"] !== "string" || typeof rt["version"] !== "string" || rt["name"].length === 0 || rt["name"].length > 40 || rt["version"].length === 0 || rt["version"].length > 40) return "the adapter checkpoint is not one this controller reads";
  return { conversationId: pi["conversationId"], at: pi["at"], digest: pi["digest"], runtime: { name: rt["name"], version: rt["version"] }, format: pi["format"] };
}

/** The host's read-back check of the checkpoint, as it said it (`nn.durable`). A host that said nothing did not check: not verified. */
export function durabilityOf(taken: JsonObject): { verified: boolean; error?: string } {
  const nn = (taken as Record<string, unknown>)["nn"];
  const d = isObject(nn) ? nn["durable"] : undefined;
  if (!isObject(d) || typeof d["verified"] !== "boolean") return { verified: false, error: "the host did not say that the checkpoint reads back from its store" };
  if (d["verified"]) return { verified: true };
  return { verified: false, error: short(typeof d["error"] === "string" && d["error"].length > 0 ? d["error"] : "the host's read-back check of the checkpoint failed", 300) };
}

/**
 * Captures a continuation from a checkpoint a worker host handed the dispatcher (card L04d): the third piece of L04c's checked resume. Every safe boundary the dispatcher sees — the end of a turn, a shutdown, a stop,
 * a quiesce, a recipe change — becomes a `continuation.capture` of the task, so a resumed attempt is checked against the continuation its own worker left, not only one an owner captured by hand.
 *
 * What goes in it, and from where:
 * - the adapter's checkpoint reference and the host's durability check of it (`nn.durable`, the worker process reading its store back). Without a passed check the capture is kept `incomplete` and never resumed from;
 * - the conversation identity: the one the task's continuations already have, else `task:<taskId>`;
 * - the summary lineage from the task's latest compaction (card C07q: the newest IDs listed, the older ones folded and continued), and as many compactions as that lineage counts;
 * - the budget from accounting; the artifacts and decisions the task's previous complete continuation named, carried forward;
 * - the next step in the controller's words (the agent's own is not known here), and no pending effects, scratch records, credentials or non-checkpointable tools (none of which the controller can name from a checkpoint).
 *
 * Never throws: a capture that cannot be made is reported to `onError` and answered as `failed`; a checkpoint it cannot name is `skipped`. One command per attempt, checkpoint and boundary, so the same checkpoint
 * taken again at the same boundary is one capture.
 */
export function continuationRecorder(deps: { readonly continuations: Pick<ContinuationService, "capture">; readonly principal: Principal; readonly sources?: CaptureSources; readonly onError?: (error: unknown) => void }): (taken: CheckpointTaken) => Promise<CaptureOutcome> {
  const quietly = async <T>(read: (() => Promise<T>) | undefined): Promise<T | undefined> => {
    if (read === undefined) return undefined;
    try { return await read(); } catch (error) { deps.onError?.(error); return undefined; }
  };
  return async (taken) => {
    const checkpoint = adapterCheckpointOf(taken.checkpoint);
    if (typeof checkpoint === "string") return { skipped: checkpoint };
    if (!/^agent:[A-Za-z0-9._-]{1,64}$/.test(taken.agentId)) return { skipped: "the attempt's agent is not one a continuation can name" };
    const durable = durabilityOf(taken.checkpoint);
    const [compaction, budget, previous] = await Promise.all([
      quietly(deps.sources?.compaction === undefined ? undefined : () => deps.sources!.compaction!(taken.taskId)),
      quietly(deps.sources?.budget === undefined ? undefined : () => deps.sources!.budget!(taken.taskId)),
      quietly(deps.sources?.previous === undefined ? undefined : () => deps.sources!.previous!(taken.taskId)),
    ]);
    const lineage = compaction === undefined ? [] : [...compaction.lineage, compaction.id];
    const compactions = compaction === undefined ? 0 : lineage.length + (compaction.earlier?.count ?? 0);
    const carried = (ids: readonly string[] | undefined): string[] => [...new Set(ids ?? [])].slice(-CONTINUATION_LIMITS.items);
    const input: ContinuationInput = {
      identity: previous?.identity ?? `task:${taken.taskId}`,
      agent: taken.agentId,
      boundary: { kind: taken.boundary },
      checkpoint,
      durable,
      continuation: {
        artifacts: carried(previous?.continuation.artifacts), decisions: carried(previous?.continuation.decisions), pendingEffects: [],
        budget: budget === undefined ? { spent: 0, remaining: 0, unit: "not metered" } : { spent: Math.max(0, Math.round(budget.spent)), remaining: Math.max(0, Math.round(budget.remaining)), unit: budget.unit.slice(0, 20) || "not metered" },
        nextStep: short(`Carry on with the task from the checkpoint taken when ${taken.reason}.`, 500),
      },
      manifest: {
        summaryLineage: lineage, ...(compaction?.earlier === undefined ? {} : { summaryLineageEarlier: compaction.earlier }),
        sourceRanges: [{ source: `conversation ${checkpoint.conversationId}`, from: 0, to: checkpoint.at }],
        compression: { state: compactions > 0 ? "compacted" : "none", compactions },
        branches: [], messageCursor: checkpoint.at, routingRevision: 0, environmentRevision: 0,
        adapter: { name: checkpoint.runtime.name, version: checkpoint.runtime.version },
      },
      nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
    };
    const key = createHash("sha256").update(JSON.stringify([taken.attemptId, checkpoint.conversationId, checkpoint.at, checkpoint.digest, taken.boundary, durable.verified])).digest("hex").slice(0, 32);
    try {
      const r = await deps.continuations.capture(deps.principal, { commandId: `hcap:${key}`, taskId: taken.taskId, ...input });
      return { captured: { id: r.id, status: r.status, replayed: r.replayed } };
    } catch (error) {
      // The same checkpoint captured at the same boundary already (what the controller knew about it moved since, a budget spent): that capture stands.
      if (error instanceof DomainError && error.code === "command_conflict") return { skipped: "this checkpoint was captured at this boundary already" };
      deps.onError?.(error);
      return { failed: short(error instanceof Error ? error.message : String(error), 300) };
    }
  };
}

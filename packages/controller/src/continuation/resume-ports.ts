import type { ControllerStorage } from "../storage/types.js";
import { ReviewNotRun, type ResumePorts } from "./resume.js";

/**
 * What the controller itself can say for a checked resume (card L04b). Context the continuation names (artifacts, decisions, scratch records) that no longer exists is missing; effects the continuation
 * recorded as pending whose stored status is `uncertain` must be settled first. No worker observations are available yet, so every dependency that needs one reads `unknown`, never "unchanged". With no
 * independent reviewer connected, the review is recorded as not run (`ReviewNotRun`) and every change is treated as relevant; it is never passed off as a judgement.
 */
export function controllerResumePorts(storage: Pick<ControllerStorage, "getAggregate" | "getEffect">, more: Partial<ResumePorts> = {}): ResumePorts {
  return {
    observe: async (taskId) => (await more.observe?.(taskId)) ?? {},
    async missingContext(taskId, c) {
      const missing: string[] = [];
      for (const id of c.continuation.artifacts) if ((await storage.getAggregate({ kind: "artifact", id })) === undefined) missing.push(`artifact ${id}`);
      for (const id of c.continuation.decisions) if ((await storage.getAggregate({ kind: "desk-record", id })) === undefined) missing.push(`decision ${id}`);
      for (const id of c.scratchRecords) if ((await storage.getAggregate({ kind: "desk-record", id })) === undefined) missing.push(`scratch record ${id}`);
      return [...missing, ...((await more.missingContext?.(taskId, c)) ?? [])];
    },
    async uncertainEffects(taskId, c) {
      const out: string[] = [];
      for (const e of c.continuation.pendingEffects) if ((await storage.getEffect(e.effectId))?.status === "uncertain") out.push(e.effectId);
      return [...out, ...((await more.uncertainEffects?.(taskId, c)) ?? [])];
    },
    // With no reviewer, the review did not run: the check records that and treats every change as relevant (the owner decides), as it always has.
    review: more.review ?? (async () => { throw new ReviewNotRun("no reviewer is connected"); }),
  };
}

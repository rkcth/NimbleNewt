import type { AssignmentBody, AttemptBody } from "../domain/assignment-model.js";
import type { TaskBody } from "../domain/model.js";
import { view, type CommandRunner } from "../domain/runner.js";
import { holdsNow, type GrantRecordBody } from "./grants.js";
import { redactText } from "./redact.js";

/**
 * Running work that relies on a standing right (follow-up to card T7). Before the owner takes a right back they are told which agent work is going on now that the right covers: an agent that holds
 * the right, working on an unfinished task now (its assignment has an active attempt) in the project the right is for (every project for `*`; only that task for a right on one task).
 * It is what the right COULD be used for, not what it is used for: the controller does not record which action a running attempt will take next, so each entry says "may rely on it".
 * The list is capped (`RELIANCE_LISTED` entries, the rest counted); a look that could not read everything says so (`complete: false`) instead of reading as "nothing relies on it".
 */
export const RELIANCE_LISTED = 10;
/** Most active attempts one look considers, and most assignment records it reads (a look never decides from a partial read without saying so). */
export const RELIANCE_RUNNING_MAX = 500;
export const RELIANCE_SCAN_MAX = 10_000;
/** Most rights one answer without a named right covers. */
export const RELIANCE_GRANTS_MAX = 50;

export interface RunningWork { readonly agentId: string; readonly taskId: string; readonly title: string; readonly projectId: string; readonly attemptId: string; readonly attemptNumber: number }
export interface Reliance {
  readonly grantId: string;
  readonly grantee: string;
  readonly action: string;
  readonly project: string;
  readonly state: "active" | "revoked";
  /** Whether the right gives anything now (T7b review): an active right that ended, lapsed from non-use, has not started yet or rests on a parent that no longer holds is not in force, and no running work relies on it. */
  readonly inForce: boolean;
  readonly revision: number;
  /** All the running work found, whatever the cap on `items`. */
  readonly total: number;
  readonly items: readonly RunningWork[];
  /** False when the records could not all be read: `total` is then at least what was found. */
  readonly complete: boolean;
}

const FINAL = new Set(["done", "cancelled"]);
const bare = (id: string): string => (id.startsWith("agent:") ? id.slice("agent:".length) : id);

/** Every agent's running work: assignments that are held with an active attempt on a task that is not finished. */
export async function runningWork(runner: CommandRunner): Promise<{ readonly work: readonly RunningWork[]; readonly complete: boolean }> {
  const work: RunningWork[] = [];
  let after: string | undefined; let seen = 0; let complete = true;
  scanning: for (;;) {
    const page = await runner.list("assignment", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
    seen += page.length;
    for (const a of page) {
      const b = a.body as unknown as AssignmentBody;
      if (b.state !== "assigned" || b.owner === undefined || b.owner.kind !== "agent" || b.activeAttemptId === undefined) continue;
      const attempt = await runner.get("attempt", b.activeAttemptId);
      const ab = attempt?.body as unknown as AttemptBody | undefined;
      if (ab === undefined || ab.state !== "active") continue;
      const task = await runner.get("task", b.taskId);
      const tb = task?.body as unknown as TaskBody | undefined;
      if (tb === undefined || FINAL.has(tb.state)) continue;
      if (work.length >= RELIANCE_RUNNING_MAX) { complete = false; break scanning; }
      work.push({ agentId: bare(b.owner.id), taskId: b.taskId, title: redactText(tb.title), projectId: tb.projectId, attemptId: b.activeAttemptId, attemptNumber: ab.number });
    }
    if (page.length < 500) break;
    if (seen >= RELIANCE_SCAN_MAX) { complete = false; break; }
    after = page[page.length - 1]!.id;
  }
  return { work, complete };
}

/** What of the running work one right covers. A revoked right covers nothing (it is already taken back), nor does one that is not in force now (`inForce`). */
export function covered(grant: GrantRecordBody, work: readonly RunningWork[], inForce = true): RunningWork[] {
  if (grant.state !== "active" || !inForce) return [];
  return work.filter((w) => `agent:${w.agentId}` === grant.grantee && (grant.project === "*" || grant.project === w.projectId) && (grant.resource === undefined || grant.resource.kind !== "task" || grant.resource.id === w.taskId));
}

/** The running work of the named right, or of every active right (at most `RELIANCE_GRANTS_MAX`, oldest first). `undefined` when a named right does not exist. */
export async function relianceOf(runner: CommandRunner, query: { grantId?: string } = {}): Promise<{ readonly items: readonly Reliance[]; readonly more: boolean } | undefined> {
  const records: { id: string; body: GrantRecordBody; revision: number }[] = [];
  let more = false;
  if (query.grantId !== undefined) {
    const found = await runner.get("grant-record", query.grantId);
    if (found === undefined) return undefined;
    records.push({ id: found.id, body: found.body as unknown as GrantRecordBody, revision: view<GrantRecordBody>(found).revision });
  } else {
    let after: string | undefined;
    scanning: for (let rounds = 0; rounds < 20; rounds++) {
      const page = await runner.list("grant-record", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const r of page) {
        const body = r.body as unknown as GrantRecordBody;
        if (body.state !== "active") continue;
        if (records.length === RELIANCE_GRANTS_MAX) { more = true; break scanning; }
        records.push({ id: r.id, body, revision: view<GrantRecordBody>(r).revision });
      }
      if (page.length < 200) break;
      after = page[page.length - 1]!.id;
      if (rounds === 19) more = true;
    }
  }
  const { work, complete } = await runningWork(runner);
  const now = runner.now();
  const items: Reliance[] = [];
  for (const { id, body, revision } of records) {
    const inForce = await holdsNow(runner, body, now);
    const all = covered(body, work, inForce);
    items.push({ grantId: id, grantee: body.grantee, action: body.action, project: body.project, state: body.state, inForce, revision, total: all.length, items: all.slice(0, RELIANCE_LISTED), complete });
  }
  return { items, more };
}

import { assignmentIdOf } from "../domain/assignment-model.js";
import type { Change, JsonObject } from "../storage/types.js";

/**
 * Who contributed to a task's work (card Q04: "a QA agent that commits a fix becomes a contributor and cannot approve it"). ONE definition, shared by the QA gate, the recording of QA evidence, the approval of a
 * code review and the review policy's choice of reviewer (card Q02 review: the settle rule of `qa-review-policy.ts`, whose definition this is):
 *
 * - every agent that submitted CODE on the task, in any earlier or later version and whatever became of it (approved, asked for changes, rejected, replaced by a newer version: each submitted version is work in
 *   the task's tree), and
 * - the agent that holds the task now (its assignment's owner): it is the one making the next version.
 *
 * The scope is the task, not the project: work on one task does not make an agent a contributor of another. Agents are compared by principal ID (`agent:<id>`), which a rename does not change; an agent the task
 * was moved away from stays a contributor only by the code it submitted (holding the task once, without submitting, is not a contribution once it no longer holds it). The owner is never a contributor (the owner
 * cannot submit code), so nothing here changes what the owner may decide.
 *
 * Storage: one record per task (`task-code-contributors`, keyed by the task ID) lists the submitters, written in the same write as each code submission, so reading it is one record, never a scan. A task whose
 * code was submitted before the record existed is seeded when its next code submission is written (`contributorChange`): from the project's code index, or, when that index does not cover every submission, one
 * bounded scan of the submission table; the record says `complete: false` when the seed could not read everything, and a reader then adds the project's code index entries for the task as well.
 */
export const CONTRIBUTORS = "task-code-contributors";
export interface ContributorsBody { readonly taskId: string; readonly ids: readonly string[]; readonly complete: boolean }
/** The most submitters one task's record keeps. A task submitted by more agents than this keeps the first ones and is marked incomplete (readers then add the project's code index as well). */
export const CONTRIBUTORS_KEPT = 200;

/** The principal ID of an agent named by its bare ID (an assignment's owner) or already as a principal ID. */
export const principalOf = (id: string): string => (id.startsWith("agent:") ? id : `agent:${id}`);

interface Reader { get(kind: string, id: string): Promise<{ readonly body: unknown; readonly revision: number } | undefined> }

/** The stored record, when it is readable as one. */
export function contributorsOf(found: { readonly body: unknown } | undefined): ContributorsBody | undefined {
  const b = found?.body as Partial<ContributorsBody> | undefined;
  if (b === undefined || b === null || typeof b.taskId !== "string" || !Array.isArray(b.ids) || typeof b.complete !== "boolean" || !b.ids.every((x) => typeof x === "string")) return undefined;
  return b as ContributorsBody;
}

/** The project's code index entries (`code-submission-index`, see `submissions.ts`) for one task: the agents that submitted code on it, as far as the index reaches. */
async function indexed(runner: Reader, projectId: string, taskId: string): Promise<string[]> {
  const entries = (((await runner.get("code-submission-index", projectId))?.body as { entries?: unknown } | undefined)?.entries);
  if (!Array.isArray(entries)) return [];
  return entries.filter((e): e is { taskId: string; by: string } => e !== null && typeof e === "object" && (e as { taskId?: unknown }).taskId === taskId && typeof (e as { by?: unknown }).by === "string").map((e) => e.by);
}

/**
 * Everyone that contributed to the task (see above), as principal IDs: the submitters of its code and the agent that holds it now, with `also` (submitters the caller already knows, such as the submitter of the
 * submission in question, or a scan's) added. Reads at most three records (the task's contributor record, the project's code index when the record is missing or incomplete, and the task's assignment).
 */
export async function taskContributors(runner: Reader, projectId: string, taskId: string, also: readonly string[] = []): Promise<ReadonlySet<string>> {
  const out = new Set(also.map(principalOf));
  const record = contributorsOf(await runner.get(CONTRIBUTORS, taskId));
  for (const id of record?.ids ?? []) out.add(principalOf(id));
  if (record === undefined || !record.complete) for (const id of await indexed(runner, projectId, taskId)) out.add(principalOf(id));
  const holder = ((await runner.get("assignment", assignmentIdOf(taskId)))?.body as { owner?: { id?: unknown } } | undefined)?.owner?.id;
  if (typeof holder === "string" && holder !== "") out.add(principalOf(holder));
  return out;
}

/** The plain reason given when a contributor's approval or evidence does not count (the owner may read it). */
export const CONTRIBUTOR_APPROVAL_TEXT = "this agent already contributed code to this task, so it cannot approve it; another reviewer has to";

/**
 * The change that adds a code submission's submitter to its task's record, for the same write as the submission (`SubmissionService.record`). `seed` reads the submitters of code recorded before the record existed
 * (called only when there is no record yet); it says whether it read every one.
 */
export async function contributorChange(runner: Reader, taskId: string, submittedBy: string, seed: () => Promise<{ ids: readonly string[]; complete: boolean }>): Promise<Change[]> {
  const ref = { kind: CONTRIBUTORS, id: taskId };
  const found = await runner.get(CONTRIBUTORS, taskId);
  const had = contributorsOf(found);
  // A record that exists but cannot be read is left alone (a write could not be revision-checked against what it does not understand); readers then add the project's code index.
  if (found !== undefined && had === undefined) return [];
  const me = principalOf(submittedBy);
  if (had !== undefined && had.ids.includes(me)) return [];
  const start = had ?? await (async (): Promise<ContributorsBody> => { const s = await seed(); return { taskId, ids: [...new Set(s.ids.map(principalOf))].sort().slice(0, CONTRIBUTORS_KEPT), complete: s.complete && new Set(s.ids.map(principalOf)).size <= CONTRIBUTORS_KEPT }; })();
  const full = start.ids.length >= CONTRIBUTORS_KEPT && !start.ids.includes(me);
  const next: ContributorsBody = { taskId, ids: full ? start.ids : [...new Set([...start.ids, me])].sort(), complete: start.complete && !full };
  if (had !== undefined && next.complete === had.complete && next.ids.length === had.ids.length) return [];
  return [found === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }];
}

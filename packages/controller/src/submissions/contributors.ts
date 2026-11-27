import { assignmentIdOf } from "../domain/assignment-model.js";
import { DomainError } from "../domain/errors.js";
import { TASK_ATTEMPTS_KIND } from "../dispatch/model.js";
import type { Change, JsonObject } from "../storage/types.js";

/**
 * Who contributed to a task's work (card Q04: "a QA agent that commits a fix becomes a contributor and cannot approve it"). ONE definition, shared by the QA gate, the recording of QA evidence, the approval of a
 * code review and the review policy's choice of reviewer (card Q02 review: the settle rule of `qa-review-policy.ts`, whose definition this is):
 *
 * - every agent that submitted CODE on the task, in any earlier or later version and whatever became of it (approved, asked for changes, rejected, replaced by a newer version: each submitted version is work in
 *   the task's tree).
 *
 * Holding the task is not by itself a contribution (second review of the seventh slice): a local reviewer, QA or director worker reviews a task's code in an attempt of that very task (the owner transfers the task
 * to it for the review, and the tool bridge records its review on its own task only, card Q01b), so counting the holder would refuse every such review. An agent that holds the task and submits code becomes a
 * contributor by that submission, and everything it approved or passed before stops counting when read. Only the review policy's choice of reviewer (`withHolder`) also leaves out the agent holding the task now,
 * as it did before this card: that agent is busy with the task.
 *
 * The scope is the task, not the project: work on one task does not make an agent a contributor of another. Agents are compared by principal ID (`agent:<id>`), which a rename does not change. The owner is never
 * a contributor (the owner cannot submit code), so nothing here changes what the owner may decide.
 *
 * - every agent whose attempt of the task LEFT CHANGES in the task's checkout that a later submission staged (the holder gap of the seventh slice): the checkout belongs to the task, so the next attempt starts
 *   from what the attempt before it left (card P02) and its submission stages all of it. The worker host that holds the checkout tells which attempts left the checkout different from what they were handed
 *   (`LocalWorkspaces`' handover record, reported with the submit's staging as `leftBy`), with every change the platform made itself (a refresh, re-apply, release, landing) not counted. Those attempts'
 *   agents are added in the same write as the submission (`leftChangesBy`). A reviewer that changed nothing in the checkout stays independent; one whose test run left files git does not ignore becomes a
 *   contributor.
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
 * Everyone that contributed to the task (see above), as principal IDs: the submitters of its code, with `also` (submitters the caller already knows, such as the submitter of the submission in question, or a
 * scan's) added, and with `withHolder` the agent that holds the task now as well (the review policy's choice of reviewer only). Reads at most three records (the task's contributor record, the project's code
 * index when the record is missing or incomplete, and, with `withHolder`, the task's assignment).
 */
export async function taskContributors(runner: Reader, projectId: string, taskId: string, also: readonly string[] = [], options: { readonly withHolder?: boolean } = {}): Promise<ReadonlySet<string>> {
  const out = new Set(also.map(principalOf));
  const record = contributorsOf(await runner.get(CONTRIBUTORS, taskId));
  for (const id of record?.ids ?? []) out.add(principalOf(id));
  if (record === undefined || !record.complete) for (const id of await indexed(runner, projectId, taskId)) out.add(principalOf(id));
  if (options.withHolder !== true) return out;
  // Only an agent owner holds the task as an agent (`isAgentOwner`): a person, role or team owner with the same name is someone else. An owner whose kind cannot be read is taken as an agent (fail closed).
  const held = ((await runner.get("assignment", assignmentIdOf(taskId)))?.body as { owner?: { kind?: unknown; id?: unknown } } | undefined)?.owner;
  if (typeof held?.id === "string" && held.id !== "" && (typeof held.kind !== "string" || held.kind === "agent")) out.add(principalOf(held.id));
  return out;
}

/**
 * The plain reason given when a contributor's approval does not count (the owner reads it in the status and the landing gate). It says the owner's way out too (second review: when every reviewer agent of the
 * project contributed, no agent can approve and the owner does not record reviews): add a reviewer agent, or take review out of the project's required landing checks (`integration.set`, by chat as well).
 * Short enough that the landing gate's review and director summaries (300 characters) and the queue and commit refusals keep the whole of it for an agent name of the full 40 characters.
 */
export const CONTRIBUTOR_APPROVAL_TEXT = "this agent already contributed code to this task, so it cannot approve it; another reviewer has to (with none left, the owner adds a reviewer agent or drops the review check)";
/** The same, for a director's sign-off approving the task's code. */
export const CONTRIBUTOR_SIGNOFF_TEXT = "this agent already contributed code to this task, so it cannot sign it off; another director has to (with none left, the owner adds one or drops the director check)";

/**
 * The change that adds a code submission's submitter to its task's record, for the same write as the submission (`SubmissionService.record`). `seed` reads the submitters of code recorded before the record existed
 * (called only when there is no record yet); it says whether it read every one.
 */
export async function contributorChange(runner: Reader, taskId: string, submittedBy: string | readonly string[], seed: () => Promise<{ ids: readonly string[]; complete: boolean }>): Promise<Change[]> {
  const ref = { kind: CONTRIBUTORS, id: taskId };
  const found = await runner.get(CONTRIBUTORS, taskId);
  const had = contributorsOf(found);
  // A record that exists but cannot be read is left alone (a write could not be revision-checked against what it does not understand); readers then add the project's code index.
  if (found !== undefined && had === undefined) return [];
  const mine = [...new Set((typeof submittedBy === "string" ? [submittedBy] : submittedBy).map(principalOf))];
  if (had !== undefined && mine.every((me) => had.ids.includes(me))) return [];
  const start = had ?? await (async (): Promise<ContributorsBody> => { const s = await seed(); return { taskId, ids: [...new Set(s.ids.map(principalOf))].sort().slice(0, CONTRIBUTORS_KEPT), complete: s.complete && new Set(s.ids.map(principalOf)).size <= CONTRIBUTORS_KEPT }; })();
  const ids = new Set(start.ids);
  let full = false;
  for (const me of mine) { if (ids.has(me)) continue; if (ids.size >= CONTRIBUTORS_KEPT) full = true; else ids.add(me); }
  const next: ContributorsBody = { taskId, ids: [...ids].sort(), complete: start.complete && !full };
  if (had !== undefined && next.complete === had.complete && next.ids.length === had.ids.length) return [];
  return [found === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }];
}

/** The most attempts a host's `leftBy` report may name (the worker keeps at most this many, `HANDOVER_LIMITS.attempts`). */
export const LEFT_BY_LIMIT = 64;

/** The agent (principal ID) that owned an attempt of this task, `null` when its owner is not an agent, `undefined` when there is no such attempt of this task. An owner whose kind cannot be read is taken as an agent. */
async function ownerOfAttempt(runner: Reader, taskId: string, attemptId: string): Promise<string | null | undefined> {
  const body = (await runner.get("attempt", attemptId))?.body as { taskId?: unknown; owner?: { kind?: unknown; id?: unknown } } | undefined;
  if (body === undefined || body === null || body.taskId !== taskId) return undefined;
  const owner = body.owner;
  if (typeof owner?.id !== "string" || owner.id === "") return undefined;
  return typeof owner.kind !== "string" || owner.kind === "agent" ? principalOf(owner.id) : null;
}

/**
 * The agents to add to the task's contributors when the attempt `attemptId` submits code (the holder gap, see above): the owners of the attempts the host reported as having left changes in the checkout (`reported`,
 * the staging's `leftBy`). Fails closed when the host's report is missing, malformed, incomplete, or names an attempt the controller does not know for this task (an older or other host, a damaged record): the
 * owner of the task's attempt just before this one is added as well, found through the dispatcher's per-task attempt list (`dispatch-task-attempts`). When even that cannot be told (this is not the task's first
 * attempt, and the list does not show the one before it), the submission is refused (`unavailable`) rather than made without knowing who changed the checkout. A person, role or team owner is never added.
 */
export async function leftChangesBy(runner: Reader, taskId: string, attemptId: string, reported: unknown): Promise<string[]> {
  const out = new Set<string>();
  const r = reported as { attempts?: unknown; complete?: unknown } | null | undefined;
  const attempts = r !== null && typeof r === "object" && Array.isArray(r.attempts) && r.attempts.length <= LEFT_BY_LIMIT && r.attempts.every((a) => typeof a === "string" && a.length > 0 && a.length <= 120) ? (r.attempts as string[]) : undefined;
  let unknown = attempts === undefined || r?.complete !== true;
  for (const id of new Set(attempts ?? [])) {
    if (id === attemptId) continue;
    const owner = await ownerOfAttempt(runner, taskId, id);
    if (owner === undefined) unknown = true;
    else if (owner !== null) out.add(owner);
  }
  if (!unknown) return [...out];
  const refuse = (): never => { throw new DomainError("unavailable", "the host could not say which earlier attempts changed the task's checkout, and the attempt before this one could not be found, so the work was not submitted"); };
  const mine = (await runner.get("attempt", attemptId))?.body as { taskId?: unknown; number?: unknown } | undefined;
  if (mine === undefined || mine.taskId !== taskId || typeof mine.number !== "number") return refuse();
  if (mine.number <= 1) return [...out];
  const listed: unknown = ((await runner.get(TASK_ATTEMPTS_KIND, taskId))?.body as { attempts?: unknown } | undefined)?.attempts;
  const list: readonly unknown[] = Array.isArray(listed) ? listed : [];
  const index = list.indexOf(attemptId);
  const previous = index >= 1 ? list[index - 1] : undefined;
  if (typeof previous !== "string") return refuse();
  const before = await ownerOfAttempt(runner, taskId, previous);
  if (before === undefined) return refuse();
  if (before !== null) out.add(before);
  return [...out];
}

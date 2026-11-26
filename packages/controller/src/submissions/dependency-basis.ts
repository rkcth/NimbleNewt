import { createHash } from "node:crypto";
import { derivedId } from "../domain/ids.js";
import type { CommandRunner } from "../domain/runner.js";
import { judgeFromState, type DependencyEntry, type DependencyStatus, type ManifestBody } from "../dependencies/dependencies.js";
import { redactText } from "../security/redact.js";
import type { Change, JsonObject } from "../storage/types.js";

/**
 * What QA evidence or an approval was judged against among the task's recorded dependencies (card C03), so a changed dependency takes it back (card Q02: "changed dependency invalidates affected test/review").
 *
 * When the evidence or approval is recorded, the task's dependency manifest is read and its entries (each with a fingerprint of what was observed: hash, ETag, members, a search's scope and results, not when it was seen) are kept once as a
 * `dependency-snapshot` record, named by the task and the digest of its entries, so many records judged against the same manifest share one snapshot. The evidence or approval keeps only the snapshot's ID
 * (`NO_DEPENDENCIES` when the task had recorded none). Later it no longer holds when, for an entry of the snapshot:
 * - the entry was recorded again with a different observation (the agent saw it change: a file's new hash, a directory's other members, a search's other results), or it is gone from the manifest (fail closed);
 * - the controller judges it changed or deleted from its own state (`judgeFromState`: a shared record or decision edited or superseded, a tool version revoked or with another digest, the agent's active environment
 *   moved, a record that was absent now exists). A change the agent acknowledged by recording the entry again while it stood (`seen`: a superseded or deleted record, a revoked tool version cannot be recorded
 *   back into an unchanged state) does not take back what was recorded after that acknowledgement, and new evidence and approvals are accepted again; a further change still takes them back.
 * A dependency recorded after it is the work of a later attempt and does not take it back (that work is submitted again and judged on its own). An observation-only kind with no new recording (a file nobody read
 * again) cannot be told to have changed and does not take it back; the worker's re-read is what records the change.
 */
export const DEPENDENCY_SNAPSHOT = "dependency-snapshot";
/** The basis of evidence or an approval recorded while the task had no dependency manifest. */
export const NO_DEPENDENCIES = "none";
/** At most this many changes are named (each is one line for the owner). */
export const DEPENDENCY_CHANGES_NAMED = 5;

/**
 * Second review (cost): what one pass over a task's evidence has already judged, so many evidence records judged against the same entries read each entry's state once, and each snapshot once. Made fresh for one pass
 * (one read of the gate, one check of the task), never kept.
 */
export type DependencyMemo = Map<string, Promise<unknown>>;

interface SnapshotBody { readonly taskId: string; readonly digest: string; readonly entries: Readonly<Record<string, string>> }

/** One recorded dependency that changed since the evidence or approval was judged, in words the owner can read. */
export interface DependencyChange { readonly entryId: string; readonly kind: string; readonly key: string; readonly status: DependencyStatus | "re-recorded" | "missing"; readonly detail: string }

const sha = (v: string): string => createHash("sha256").update(v).digest("hex");
const manifestId = (taskId: string): string => derivedId("dpm", taskId);
const msOf = (t: unknown): number => (typeof t === "string" ? Date.parse(t) : Number.NaN);

/**
 * A short fingerprint of what one entry observed (not when): the same observation recorded again has the same fingerprint. A search's position in the event stream (`cursor`) says when it was made, not what it
 * found, so the same search recorded again later with the same results is the same observation; a weak ETag (`W/`) names the same version as the strong one (as `check` compares them). A change the agent
 * acknowledged by recording the entry again (`seen`) is part of it, so evidence and approvals judged before the acknowledgement stay taken back.
 */
export function fingerprint(e: DependencyEntry): string {
  return sha(JSON.stringify([e.kind, e.key, e.hash?.replace(/^sha256:/, "") ?? null, e.etag?.replace(/^W\//, "") ?? null, e.members ?? null, e.scope ?? null, e.freshness ?? null, e.server ?? null, e.protocol ?? null, ...(e.seen === undefined ? [] : [e.seen])])).slice(0, 16);
}

/**
 * The entry judged from the controller's own state (`judgeFromState`) when that is a change: changed or deleted, unless it is the very state the agent acknowledged by recording the entry again (`seen`). Undefined:
 * no change, or not a kind the controller judges itself.
 */
async function changedFromState(get: (kind: string, id: string) => Promise<{ readonly body: unknown; readonly revision?: number } | undefined>, e: DependencyEntry): Promise<DependencyChange | undefined> {
  // Second review: an entry its recorder could not read (`unverified`) holds only its word, not an observation of the record; judging it would tell that recorder, through a refusal or a reason, whether its guess
  // matches a record it may not read. It is judged as an observation-only entry: only recording it again with another observation changes it.
  if (e.unverified === true) return undefined;
  const j = await judgeFromState(get, e);
  if (j === undefined || (j[0] !== "changed" && j[0] !== "deleted") || (e.seen !== undefined && e.seen === j[2])) return undefined;
  return { entryId: e.id, kind: e.kind, key: e.key, status: j[0], detail: j[1] };
}

/**
 * The kinds whose key names a shared record or catalog version (or a lookup of one) that a reader of the reason may not be allowed to read (second review): the reason goes to the assigned reviewer, the recorder of
 * evidence and the views, so it names the manifest entry instead (`resume.dependencies.check` gives each entry's ID and key to those who may read it).
 */
const PRIVATE_KEYS: ReadonlySet<string> = new Set(["record", "decision", "tool-version", "negative"]);

/** The key as the owner may see it: one line, redacted, at most 80 characters. */
const shown = (key: string): string => { const one = redactText(key.replace(/[\u0000-\u001f\u007f]/g, " ")); return one.length > 80 ? `${one.slice(0, 79)}…` : one; };

/** One change in plain words. */
export function dependencyChangeText(c: DependencyChange): string {
  if (c.kind === "manifest") return `the task's recorded dependencies ${c.status === "missing" && c.entryId.startsWith("dps-") ? "this was judged against cannot be read" : `changed: an entry ${c.detail}`}`;
  return `the task's recorded ${c.kind} dependency ${PRIVATE_KEYS.has(c.kind) ? `(entry ${c.entryId})` : `"${shown(c.key)}"`} ${c.status === "re-recorded" ? c.detail : `${c.status === "deleted" ? "is gone" : "changed"} (${c.detail})`}`;
}

/**
 * The basis to keep with new evidence or a new approval: the snapshot ID (or `NO_DEPENDENCIES`), and the changes the same write must carry: a revision check on the manifest (so a dependency recorded while the
 * write is built makes it build again) and, the first time this manifest state is kept, the snapshot itself.
 */
export async function readDependencyBasis(runner: Pick<CommandRunner, "get">, taskId: string): Promise<{ readonly snapshot: string; readonly changes: readonly Change[] }> {
  const found = await runner.get("dependency-manifest", manifestId(taskId));
  const manifest = found?.body as unknown as ManifestBody | undefined;
  if (found === undefined || manifest === undefined || !Array.isArray(manifest.entries)) return { snapshot: NO_DEPENDENCIES, changes: [] };
  const entries: Record<string, string> = {};
  for (const e of [...manifest.entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) entries[e.id] = fingerprint(e);
  const digest = sha(JSON.stringify(entries));
  const id = derivedId("dps", `${taskId}|${digest}`);
  const changes: Change[] = [{ type: "check", ref: { kind: "dependency-manifest", id: found.id }, expectedRevision: found.revision }];
  if ((await runner.get(DEPENDENCY_SNAPSHOT, id)) === undefined) changes.push({ type: "create", ref: { kind: DEPENDENCY_SNAPSHOT, id }, body: { taskId, digest, entries } satisfies SnapshotBody as unknown as JsonObject });
  return { snapshot: id, changes };
}

/** The task's recorded dependencies that the controller judges changed or deleted now (before new evidence or an approval is recorded on them), at most `limit`. */
export async function dependencyChangesNow(runner: Pick<CommandRunner, "get">, taskId: string, limit = DEPENDENCY_CHANGES_NAMED): Promise<DependencyChange[]> {
  const manifest = (await runner.get("dependency-manifest", manifestId(taskId)))?.body as unknown as ManifestBody | undefined;
  const out: DependencyChange[] = [];
  for (const e of manifest?.entries ?? []) {
    if (out.length >= limit) break;
    const c = await changedFromState((kind, id) => runner.get(kind, id), e);
    if (c !== undefined) out.push(c);
  }
  return out;
}

/**
 * What changed among the dependencies the evidence or approval was judged against (empty: nothing). `snapshot` is what it kept; `undefined` for a record made before dependencies were kept, which is judged by its
 * time `at` instead: each entry the controller judges itself and not observed strictly after it (fail closed: the same millisecond, or a time that cannot be read, is judged) is checked against the controller's state. A snapshot that cannot be read counts as a change (fail closed). At most `limit` changes are named.
 */
export async function dependencyChanges(runner: Pick<CommandRunner, "get">, taskId: string, snapshot: string | undefined, at: string, limit = DEPENDENCY_CHANGES_NAMED, memo?: DependencyMemo): Promise<DependencyChange[]> {
  if (snapshot === NO_DEPENDENCIES) return [];
  const get = (kind: string, id: string) => runner.get(kind, id);
  const once = <T>(key: string, make: () => Promise<T>): Promise<T> => { if (memo === undefined) return make(); let p = memo.get(key) as Promise<T> | undefined; if (p === undefined) { p = make(); memo.set(key, p); } return p; };
  const manifest = (await once(`m:${taskId}`, () => runner.get("dependency-manifest", manifestId(taskId))))?.body as unknown as ManifestBody | undefined;
  const current = new Map((manifest?.entries ?? []).map((e) => [e.id, e] as const));
  const out: DependencyChange[] = [];
  const judged = async (e: DependencyEntry): Promise<void> => { const c = await once(`e:${taskId}:${JSON.stringify([e.id, e.kind, e.key, e.hash ?? null, e.seen ?? null, e.unverified ?? null])}`, () => changedFromState(get, e)); if (c !== undefined) out.push(c); };
  if (snapshot === undefined) {
    const atMs = msOf(at);
    for (const e of current.values()) {
      if (out.length >= limit) break;
      // Fail closed, as the decision links are: only an entry observed strictly after it is later work; the same millisecond, or a time that cannot be read on either side, is judged.
      const observed = msOf(e.observedAt);
      if (Number.isFinite(observed) && Number.isFinite(atMs) && observed > atMs) continue;
      await judged(e);
    }
    return out;
  }
  const kept = (await once(`s:${snapshot}`, () => runner.get(DEPENDENCY_SNAPSHOT, snapshot)))?.body as unknown as SnapshotBody | undefined;
  if (kept === undefined || kept.taskId !== taskId || typeof kept.entries !== "object" || kept.entries === null) return [{ entryId: snapshot, kind: "manifest", key: snapshot, status: "missing", detail: "cannot be read" }];
  for (const [id, fp] of Object.entries(kept.entries)) {
    if (out.length >= limit) break;
    const e = current.get(id);
    if (e === undefined) { out.push({ entryId: id, kind: "manifest", key: id, status: "missing", detail: "is no longer in its manifest" }); continue; }
    if (fingerprint(e) !== fp) { out.push({ entryId: id, kind: e.kind, key: e.key, status: "re-recorded", detail: `was recorded again with a different observation at ${e.observedAt}` }); continue; }
    await judged(e);
  }
  return out;
}

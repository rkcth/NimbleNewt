import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { LIMITS as MODEL_LIMITS, onlyKnown, projectId as checkProjectId, revision as checkRevision, taskId as checkTaskId, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows, allowsExactly, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { PublicationService } from "./publication.js";

export type DeskKind = "plan" | "progress" | "evidence" | "decision" | "note";
export const DESK_KINDS: readonly DeskKind[] = ["plan", "progress", "evidence", "decision", "note"];
export type DeskStatus = "draft" | "accepted" | "superseded";
/** `shared`: readable, once committed, by peers with `desk.read` in the project. `private`: scratch, readable by its owner only. */
export type DeskVisibility = "shared" | "private";

/** One record on an agent's desk (kind `desk-record`). The desk belongs to the persistent agent identity; the project is fixed when the record is written. */
export interface DeskRecordBody {
  /** The principal that owns the desk and wrote this record, taken from authentication. */
  readonly owner: string;
  readonly projectId: string;
  readonly taskId?: string;
  readonly kind: DeskKind;
  readonly title: string;
  readonly body: string;
  readonly status: DeskStatus;
  readonly visibility: DeskVisibility;
  /** The record this one replaces, in the same project and on the same desk. */
  readonly supersedes?: string;
  /** The records this one cites (card A10). Each was readable by the writer, and each is in this project or in one the owner opened a path from. */
  readonly sources?: readonly string[];
  /** The record this one was copied from, and the original at the root of any chain of copies. A copy's claims are the original's, not independent evidence. */
  readonly copiedFrom?: string;
  readonly origin?: { readonly recordId: string; readonly owner: string; readonly projectId: string };
}

export interface WriteDeskRecord extends NoActor {
  readonly projectId: string;
  readonly taskId?: string;
  readonly kind: DeskKind;
  readonly title: string;
  readonly body: string;
  readonly visibility: DeskVisibility;
  /** `draft` (default) or `accepted`. */
  readonly status?: "draft" | "accepted";
  readonly supersedes?: string;
  /** Desk records this one cites. */
  readonly sources?: readonly string[];
}

export interface CopyDeskRecord extends NoActor {
  readonly recordId: string;
  /** The project to copy into. Default: the original's. Another project needs a path the owner opened. */
  readonly projectId?: string;
  /** Default `private`: a copy lands in the copier's scratch until it is deliberately published. */
  readonly visibility?: DeskVisibility;
}

export interface ReviseDeskRecord extends NoActor {
  readonly recordId: string;
  readonly expectedRevision: number;
  readonly title?: string;
  readonly body?: string;
  readonly status?: DeskStatus;
}

export const DESK_LIMITS = { title: 200, body: 16_000 } as const;
const RECORD_ID = /^dsk-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/** Desk text is data, never a credential: anything shaped like a secret is refused, so a desk cannot become a place to keep one (secrets have their own storage). */
function plain(value: unknown, field: string, max: number, min = 1): string {
  const out = text(value, field, { min, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those do not belong on a desk");
  return out;
}

/**
 * Agent desks (card C01): records owned by a persistent agent identity, readable by authorized peers once committed, with private scratch that only its owner reads.
 * - **Owner-written.** Only the owner, taken from authentication and checked against the stored record, writes or revises a record. A peer cannot edit it, a supervisor's rank or a
 *   friendly name changes nothing, and a grant to read is not a grant to write.
 * - **Project-scoped.** A record belongs to one project and needs `desk.write` there to write and `desk.read` there to read. Superseding another record is refused across projects or desks,
 *   so one project's restricted information is not published into another.
 * - **Committed snapshots.** A draft is the owner's working copy: peers see only `accepted` and `superseded` records, each as one whole revision.
 * - **Private scratch.** `private` records are readable only by their owner (and by a principal holding an explicit `desk.scratch.read` grant in that project). Listings never include
 *   what the caller may not read, and a record that does not exist reads like one the caller may not see.
 * - **Data, not instructions.** A record is text; reading it activates nothing and grants nothing. Credentials are refused.
 */
export class DeskService {
  readonly #runner: CommandRunner;
  readonly #paths: PublicationService;

  private constructor(runner: CommandRunner, paths: PublicationService) {
    this.#runner = runner;
    this.#paths = paths;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): DeskService {
    return new DeskService(new CommandRunner(storage, epoch, options), PublicationService.withEpoch(storage, epoch, options));
  }

  async write(principal: Principal, command: WriteDeskRecord): Promise<{ id: string; revision: number; replayed: boolean }> {
    if (principal.kind !== "agent") throw new DomainError("forbidden", `${principal.id} has no desk; desks belong to agents`);
    return this.#runner.command("desk.write", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => {
      onlyKnown(command, ["commandId", "projectId", "taskId", "kind", "title", "body", "visibility", "status", "supersedes", "sources"]);
      const projectId = checkProjectId(command.projectId);
      const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
      const kind = (DESK_KINDS as readonly string[]).includes(command.kind) ? command.kind : invalid("kind", `must be one of ${DESK_KINDS.join(", ")}`);
      const title = plain(command.title, "title", DESK_LIMITS.title);
      const body = plain(command.body, "body", DESK_LIMITS.body, 0);
      const visibility = command.visibility === "shared" || command.visibility === "private" ? command.visibility : invalid("visibility", "must be shared or private");
      const status = command.status === undefined ? "draft" : command.status === "draft" || command.status === "accepted" ? command.status : invalid("status", "must be draft or accepted");
      const supersedes = command.supersedes === undefined ? undefined : typeof command.supersedes === "string" && RECORD_ID.test(command.supersedes) ? command.supersedes : invalid("supersedes", "is not a desk record ID");
      const sources = command.sources === undefined ? undefined : citedIds(command.sources);
      if (!allows(principal, "desk.write", projectId)) throw new DomainError("forbidden", `${principal.id} may not desk.write in ${projectId}`);
      return {
        payload: { projectId, ...(taskId === undefined ? {} : { taskId }), kind, title, body, visibility, status, ...(supersedes === undefined ? {} : { supersedes }), ...(sources === undefined ? {} : { sources }) },
        build: async () => {
          const project = await this.#runner.get("project", projectId);
          if (project === undefined) throw new DomainError("not_found", `project ${projectId} does not exist`);
          if (taskId !== undefined) {
            const task = await this.#runner.get("task", taskId);
            if ((task?.body as { projectId?: string } | undefined)?.projectId !== projectId) throw new DomainError("invalid_command", `task ${taskId} is not in project ${projectId}`, { field: "taskId" });
          }
          const changes: import("../storage/types.js").Change[] = [];
          if (supersedes !== undefined) {
            const old = await this.#runner.get("desk-record", supersedes);
            const oldBody = old?.body as unknown as DeskRecordBody | undefined;
            if (old === undefined || oldBody === undefined || oldBody.owner !== principal.id || oldBody.projectId !== projectId) throw new DomainError("invalid_command", "supersedes: must name one of your own records in the same project", { field: "supersedes" });
            changes.push({ type: "update", ref: { kind: "desk-record", id: supersedes }, expectedRevision: old.revision, body: { ...oldBody, status: "superseded" } as unknown as JsonObject });
          }
          if (sources !== undefined) await this.#checkCitations(principal, sources, projectId);
          const id = derivedId("dsk", scopedCommandId(principal.id, command.commandId));
          const ref: AggregateRef = { kind: "desk-record", id };
          const record: DeskRecordBody = { owner: principal.id, projectId, ...(taskId === undefined ? {} : { taskId }), kind, title, body, status, visibility, ...(supersedes === undefined ? {} : { supersedes }), ...(sources === undefined ? {} : { sources }) };
          return { ref, creates: true, changes: [{ type: "create", ref, body: record as unknown as JsonObject }, ...changes], detail: { projectId, kind, visibility, status } };
        },
      };
    }).then((r) => ({ id: r.id, revision: r.revision, replayed: r.replayed }));
  }

  /** Revises a record. Only its owner may; a peer is refused whatever it holds. */
  async revise(principal: Principal, command: ReviseDeskRecord): Promise<{ id: string; revision: number; replayed: boolean }> {
    return this.#runner.command("desk.revise", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => {
      onlyKnown(command, ["commandId", "recordId", "expectedRevision", "title", "body", "status"]);
      const id = typeof command.recordId === "string" && RECORD_ID.test(command.recordId) ? command.recordId : invalid("recordId", "is not a desk record ID");
      const expected = checkRevision(command.expectedRevision);
      const title = command.title === undefined ? undefined : plain(command.title, "title", DESK_LIMITS.title);
      const body = command.body === undefined ? undefined : plain(command.body, "body", DESK_LIMITS.body, 0);
      const status = command.status === undefined ? undefined : (["draft", "accepted", "superseded"] as const).includes(command.status) ? command.status : invalid("status", "must be draft, accepted or superseded");
      if (title === undefined && body === undefined && status === undefined) invalid("title", "a revision must change the title, body or status");
      return {
        payload: { recordId: id, expectedRevision: expected, ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }), ...(status === undefined ? {} : { status }) },
        build: async () => {
          const found = await this.#runner.get("desk-record", id);
          const current = found?.body as unknown as DeskRecordBody | undefined;
          // Not yours, and not there, are the same answer.
          if (found === undefined || current === undefined || current.owner !== principal.id) throw new DomainError("forbidden", `${principal.id} may not revise that record`);
          if (found.revision !== expected) throw new DomainError("stale_revision", `desk record ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
          // Writing needs the grant now, not only when the record was first written: revoking it ends the right to change what is already there.
          if (!allows(principal, "desk.write", current.projectId)) throw new DomainError("forbidden", `${principal.id} may not revise that record`);
          if (current.status === "superseded" && status !== undefined && status !== "superseded") throw new DomainError("invalid_command", "a superseded record stays superseded", { field: "status" });
          // A committed record is what peers have read: it is not edited in place or taken back (write a new record that supersedes it instead).
          if ((current.status === "accepted" || current.status === "superseded") && (title !== undefined || body !== undefined)) throw new DomainError("invalid_command", "an accepted or superseded record is not edited in place; write a new record that supersedes it", { field: "body" });
          if (current.status === "accepted" && status === "draft") throw new DomainError("invalid_command", "an accepted record cannot go back to draft", { field: "status" });
          const next: DeskRecordBody = { ...current, ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }), ...(status === undefined ? {} : { status }) };
          const ref: AggregateRef = { kind: "desk-record", id };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: { status: next.status } };
        },
      };
    }).then((r) => ({ id: r.id, revision: r.revision, replayed: r.replayed }));
  }


  /** Whether the principal may read the record now: the ordinary rule, and, for another agent's private scratch read on a scratch grant, the installation's inspection policy (a `denied` policy stops such grants too). */
  async #readable(principal: Principal, record: DeskRecordBody): Promise<boolean> {
    if (!canRead(principal, record)) return false;
    if (principal.kind === "owner") return true;
    if (record.visibility !== "private" || (record.owner === principal.id && inTaskScope(principal, record.projectId))) return true;
    const policy = (await this.#runner.get("inspection-policy", "installation"))?.body as unknown as { scratch?: string } | undefined;
    return policy?.scratch !== "denied";
  }

  /** Every cited record must be one the writer can read, and in this project or in one the owner has opened a path from. One answer for a record that is missing and one that is not readable. */
  async #checkCitations(principal: Principal, sources: readonly string[], projectId: string): Promise<void> {
    for (const id of sources) {
      const found = await this.#runner.get("desk-record", id);
      const record = found?.body as unknown as DeskRecordBody | undefined;
      if (found === undefined || record === undefined || !(await this.#readable(principal, record))) throw new DomainError("invalid_command", `sources: ${id} is not a record you can read`, { field: "sources" });
      if (!(await this.#paths.isOpen(record.projectId, projectId))) throw new DomainError("forbidden", `sources: ${id} belongs to ${record.projectId}, and the owner has not opened a path from there to ${projectId}`);
    }
  }

  /**
   * Copies a record the principal can read onto its own desk. The copy is its own record (draft, private unless asked otherwise) that cites the original, keeps the original's identity at the
   * root (`origin`), and stays in the original's project unless the owner opened a path to another. Copying never makes a record the copier's own work: its claims remain the original's.
   */
  async copy(principal: Principal, command: CopyDeskRecord): Promise<{ id: string; revision: number; replayed: boolean }> {
    if (principal.kind !== "agent") throw new DomainError("forbidden", `${principal.id} has no desk; desks belong to agents`);
    return this.#runner.command("desk.copy", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => {
      onlyKnown(command, ["commandId", "recordId", "projectId", "visibility"]);
      const sourceId = typeof command.recordId === "string" && RECORD_ID.test(command.recordId) ? command.recordId : invalid("recordId", "is not a desk record ID");
      const targetProject = command.projectId === undefined ? undefined : checkProjectId(command.projectId);
      const visibility = command.visibility === undefined ? "private" : command.visibility === "shared" || command.visibility === "private" ? command.visibility : invalid("visibility", "must be shared or private");
      return {
        payload: { recordId: sourceId, ...(targetProject === undefined ? {} : { projectId: targetProject }), visibility },
        build: async () => {
          const found = await this.#runner.get("desk-record", sourceId);
          const source = found?.body as unknown as DeskRecordBody | undefined;
          if (found === undefined || source === undefined || !(await this.#readable(principal, source))) throw new DomainError("forbidden", `${principal.id} may not copy that record`);
          // A copy is never more public than what it was copied from: a private record or a draft can only be copied into private scratch.
          const publishable = source.visibility === "shared" && source.status !== "draft";
          if (visibility === "shared" && !publishable) throw new DomainError("invalid_command", "visibility: a private record or a draft can be copied only into your own private scratch; publish your own account of it instead", { field: "visibility" });
          const projectId = targetProject ?? source.projectId;
          if (!allows(principal, "desk.write", projectId)) throw new DomainError("forbidden", `${principal.id} may not desk.write in ${projectId}`);
          if (!(await this.#paths.isOpen(source.projectId, projectId))) throw new DomainError("forbidden", `the owner has not opened a path from ${source.projectId} to ${projectId}; a record does not move between projects on an agent's say-so`);
          const id = derivedId("dsk", scopedCommandId(principal.id, command.commandId));
          const ref: AggregateRef = { kind: "desk-record", id };
          const origin = source.origin ?? { recordId: sourceId, owner: source.owner, projectId: source.projectId };
          const record: DeskRecordBody = { owner: principal.id, projectId, kind: source.kind, title: source.title, body: source.body, status: "draft", visibility, sources: [sourceId], copiedFrom: sourceId, origin };
          return { ref, creates: true, changes: [{ type: "create", ref, body: record as unknown as JsonObject }], detail: { projectId, copiedFrom: sourceId, origin: origin.recordId } };
        },
      };
    }).then((r) => ({ id: r.id, revision: r.revision, replayed: r.replayed }));
  }

  /**
   * How many of these records are independent evidence. A copy, and a copy of a copy, stand on the original they came from, so they count with it, not apart from it. Only records the
   * principal can read are counted; one it cannot read is listed as unavailable.
   */
  async independence(principal: Principal, recordIds: readonly string[]): Promise<{ independent: number; groups: { origin: string; records: string[] }[]; unavailable: string[] }> {
    const ids = citedIds(recordIds);
    const groups = new Map<string, string[]>();
    const unavailable: string[] = [];
    for (const id of ids) {
      const found = await this.#runner.get("desk-record", id);
      const record = found?.body as unknown as DeskRecordBody | undefined;
      if (found === undefined || record === undefined || !(await this.#readable(principal, record))) { unavailable.push(id); continue; }
      const root = record.origin?.recordId ?? id;
      groups.set(root, [...(groups.get(root) ?? []), id]);
    }
    return { independent: groups.size, groups: [...groups].map(([origin, records]) => ({ origin, records })), unavailable };
  }

  /**
   * The text of a record, for registering it as a skill or tool or running it (cards T01 and T06 call this first). Only the agent's own, accepted, original work qualifies: content from
   * another desk, and a copy of it, is data and never becomes executable by being read. (Retyped text cannot be told from original work here; the review of a new tool is what covers that.)
   */
  async executableSource(principal: Principal, recordId: string): Promise<{ id: string; revision: number; body: string }> {
    const found = typeof recordId === "string" && RECORD_ID.test(recordId) ? await this.#runner.get("desk-record", recordId) : undefined;
    const record = found?.body as unknown as DeskRecordBody | undefined;
    if (found === undefined || record === undefined || !(await this.#readable(principal, record))) throw new DomainError("forbidden", `${principal.id} may not use that record`);
    if (record.owner !== principal.id) throw new DomainError("forbidden", "content from another agent's desk cannot be registered or run as a skill or tool; it is data");
    if (record.origin !== undefined || record.copiedFrom !== undefined) throw new DomainError("forbidden", `this record is a copy of ${record.origin?.owner ?? "another desk"}'s content, which cannot be registered or run as a skill or tool`);
    if (record.status !== "accepted") throw new DomainError("invalid_command", "only an accepted record can be registered or run", { field: "recordId" });
    return { id: found.id, revision: found.revision, body: record.body };
  }

  /** The record, if the principal may read it; otherwise `forbidden`, the same whether or not it exists (except for the installation owner, who gets `not_found` for a missing one). */
  async read(principal: Principal, recordId: string): Promise<View<DeskRecordBody>> {
    const found = typeof recordId === "string" && RECORD_ID.test(recordId) ? await this.#runner.get("desk-record", recordId) : undefined;
    if (found === undefined) throw principal.kind === "owner" ? new DomainError("not_found", "no such record") : new DomainError("forbidden", `${principal.id} may not read that record`);
    const record = found.body as unknown as DeskRecordBody;
    if (!(await this.#readable(principal, record))) throw new DomainError("forbidden", `${principal.id} may not read that record`);
    return view<DeskRecordBody>(found);
  }

  /** The records of one desk that the principal may read, in ID order. A page can hold fewer than `limit` while `next` is present (unreadable records are skipped). */
  async list(principal: Principal, query: { ownerId?: string; projectId?: string; afterId?: string; limit: number }): Promise<{ items: View<DeskRecordBody>[]; next?: string }> {
    const items: View<DeskRecordBody>[] = [];
    let after = query.afterId;
    for (let reads = 0; reads < 20; reads++) {
      const page = await this.#runner.list("desk-record", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const aggregate of page) {
        after = aggregate.id;
        const record = aggregate.body as unknown as DeskRecordBody;
        if (query.ownerId !== undefined && record.owner !== query.ownerId) continue;
        if (query.projectId !== undefined && record.projectId !== query.projectId) continue;
        if (!(await this.#readable(principal, record))) continue;
        items.push(view<DeskRecordBody>(aggregate));
        if (items.length >= query.limit) return { items, next: aggregate.id };
      }
      if (page.length < 500) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }
}

/** Reading rules: the installation owner reads everything; private scratch and a draft are their agent's own (private scratch also with an explicit scratch grant); the rest needs `desk.read` in the record's project. */
export function canRead(principal: Principal, record: DeskRecordBody): boolean {
  // The installation owner reads everything: nothing on a desk is kept from the owner (owner decision 2026-10-22). Writing is another matter and stays with the record's own agent.
  if (principal.kind === "owner") return true;
  if (record.owner === principal.id && inTaskScope(principal, record.projectId)) return true;
  // A broad grant (`*`, `desk.*`) is not enough to read another agent's private scratch: it takes a grant that names it.
  if (record.visibility === "private") return allowsExactly(principal, "desk.scratch.read", record.projectId);
  if (record.status === "draft") return false;
  return allows(principal, "desk.read", record.projectId);
}

/** A list of at most 20 distinct desk record IDs. */
function citedIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) return invalid("sources", "must be a list of at most 20 desk record IDs");
  const out = value.map((v, i) => (typeof v === "string" && RECORD_ID.test(v) ? v : invalid(`sources[${i}]`, "is not a desk record ID")));
  return [...new Set(out)].sort();
}

void MODEL_LIMITS;

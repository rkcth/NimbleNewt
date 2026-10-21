import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { LIMITS as MODEL_LIMITS, onlyKnown, projectId as checkProjectId, revision as checkRevision, taskId as checkTaskId, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows, allowsExactly } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";

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

  private constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): DeskService {
    return new DeskService(new CommandRunner(storage, epoch, options));
  }

  async write(principal: Principal, command: WriteDeskRecord): Promise<{ id: string; revision: number; replayed: boolean }> {
    if (principal.kind !== "agent") throw new DomainError("forbidden", `${principal.id} has no desk; desks belong to agents`);
    return this.#runner.command("desk.write", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => {
      onlyKnown(command, ["commandId", "projectId", "taskId", "kind", "title", "body", "visibility", "status", "supersedes"]);
      const projectId = checkProjectId(command.projectId);
      const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
      const kind = (DESK_KINDS as readonly string[]).includes(command.kind) ? command.kind : invalid("kind", `must be one of ${DESK_KINDS.join(", ")}`);
      const title = plain(command.title, "title", DESK_LIMITS.title);
      const body = plain(command.body, "body", DESK_LIMITS.body, 0);
      const visibility = command.visibility === "shared" || command.visibility === "private" ? command.visibility : invalid("visibility", "must be shared or private");
      const status = command.status === undefined ? "draft" : command.status === "draft" || command.status === "accepted" ? command.status : invalid("status", "must be draft or accepted");
      const supersedes = command.supersedes === undefined ? undefined : typeof command.supersedes === "string" && RECORD_ID.test(command.supersedes) ? command.supersedes : invalid("supersedes", "is not a desk record ID");
      if (!allows(principal, "desk.write", projectId)) throw new DomainError("forbidden", `${principal.id} may not desk.write in ${projectId}`);
      return {
        payload: { projectId, ...(taskId === undefined ? {} : { taskId }), kind, title, body, visibility, status, ...(supersedes === undefined ? {} : { supersedes }) },
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
          const id = derivedId("dsk", scopedCommandId(principal.id, command.commandId));
          const ref: AggregateRef = { kind: "desk-record", id };
          const record: DeskRecordBody = { owner: principal.id, projectId, ...(taskId === undefined ? {} : { taskId }), kind, title, body, status, visibility, ...(supersedes === undefined ? {} : { supersedes }) };
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

  /** The record, if the principal may read it; otherwise `forbidden`, the same whether or not it exists (except for the installation owner, who gets `not_found` for a missing one). */
  async read(principal: Principal, recordId: string): Promise<View<DeskRecordBody>> {
    const found = typeof recordId === "string" && RECORD_ID.test(recordId) ? await this.#runner.get("desk-record", recordId) : undefined;
    if (found === undefined) throw principal.kind === "owner" ? new DomainError("not_found", "no such record") : new DomainError("forbidden", `${principal.id} may not read that record`);
    const record = found.body as unknown as DeskRecordBody;
    if (!canRead(principal, record)) throw new DomainError("forbidden", `${principal.id} may not read that record`);
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
        if (!canRead(principal, record)) continue;
        items.push(view<DeskRecordBody>(aggregate));
        if (items.length >= query.limit) return { items, next: aggregate.id };
      }
      if (page.length < 500) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }
}

/** Reading rules: private scratch is the owner's (or an explicit scratch grant); a draft is the owner's; the rest needs `desk.read` in the record's project. */
export function canRead(principal: Principal, record: DeskRecordBody): boolean {
  if (record.owner === principal.id) return true;
  // A broad grant (`*`, `desk.*`) is not enough to read another agent's private scratch: it takes a grant that names it.
  if (record.visibility === "private") return allowsExactly(principal, "desk.scratch.read", record.projectId);
  if (record.status === "draft") return false;
  return allows(principal, "desk.read", record.projectId);
}

void MODEL_LIMITS;

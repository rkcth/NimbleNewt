import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allowsExactly, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { DeskRecordBody } from "../context/desks.js";
import type { InspectionBody } from "../context/inspection.js";
import type { WorkingNoteBody } from "../context/notes.js";
import type { RecordBody } from "./record-types.js";

/** What the chair gets back: exactly the title and body that `sha256` and `bytes` cover, with the record's identity and revision. */
export interface DeskReadContent { readonly id: string; readonly revision: number; readonly title: string; readonly body: string }

/** One file the chair read from an absent member's desk (or one shared working note) during a meeting. One record per read; the absent member can see it. Never changed after it is written. */
export interface DeskReadBody {
  readonly occurrenceId: string;
  readonly meetingRecordId: string;
  readonly projectId: string;
  /** The desk record read; for a note read (`source: "note"`) the note's ID. */
  readonly deskRecordId: string;
  readonly deskOwner: string;
  /** The desk record's revision at the time of the read, and the SHA-256 and UTF-8 size of `JSON.stringify([title, body])` and of title + body: what was returned, nothing more. */
  readonly deskRevision: number;
  readonly sha256: string;
  readonly bytes: number;
  readonly visibility: "shared" | "private";
  readonly reader: string;
  readonly at: string;
  /** A desk record (`desk`; also what records written before this field existed are) or a shared working note (`note`, always `shared`, read without any meeting grant). */
  readonly source?: "desk" | "note";
  /** The inspection record the same step wrote, which the absent member sees among its inspections (`via: "meeting-chair"`). */
  readonly inspectionId?: string;
}

/** The operations the chair's read path refuses; each attempt is recorded. */
export const REFUSED_OPERATIONS = ["write", "revise", "rename", "delete", "lock"] as const;
export type RefusedOperation = (typeof REFUSED_OPERATIONS)[number];

/** A refused attempt to change something through the chair's read path: one record per meeting record, target and operation, `count` counting the repeats. It never changes anything else. */
export interface DeskAttemptBody {
  readonly occurrenceId: string;
  readonly meetingRecordId: string;
  readonly projectId: string;
  /** The desk record or note the chair tried to change (it need not exist). */
  readonly targetId: string;
  /** Whose it is, when it exists in the meeting's project. */
  readonly deskOwner?: string;
  readonly operation: RefusedOperation;
  readonly count: number;
  readonly first: string;
  readonly last: string;
  readonly lastBy: string;
}

const RECORD_ID = /^dsk-[a-z2-7]{20}$/;
const NOTE_ID = /^wnt-[a-z2-7]{20}$/;
const MEETING_RECORD_ID = /^mrc-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const forbidden = (chair: Principal): DomainError => new DomainError("forbidden", `${chair.id} may not read that record in this meeting`);

interface Listed { readonly occurrenceId: string; readonly meetingRecordId: string; readonly projectId: string; readonly deskOwner?: string; readonly at?: string; readonly last?: string }

/**
 * The chair's meeting-scoped read of an absent member's desk (card M05b). Read-only by construction: the service holds a runner and uses only `get` on desk records and notes;
 * its only writes are the per-file read record (and the inspection record beside it), created in the same step as the read and guarded by the record's revision, and the record of a
 * refused attempt to change something. A read of a record leaves exactly one `meeting-desk-read` record (occurrence, file, revision, digest, bytes, reader, time) and one `inspection`
 * record (`via: "meeting-chair"`) that the file's owner sees among its inspections; no record is made for files not read, and the record is made before the content is returned: a read
 * whose records cannot be written returns nothing.
 * Allowed only to the open meeting's current chair (an authenticated agent, `asOf` set, in task scope for the meeting's project, as every other chair check in `record.ts`), for a member
 * of the roster who has not attended, in the meeting's project. The chair's authority is read from the meeting record every time, so it ends when the meeting ends or the chair changes.
 *
 * What the chair may see (owner decision 2026-10-22, "option B": the chair reads an absent member's desk, read-only, every file logged; the plan text names no exception for scratch or
 * drafts and C01b gives members neither): committed (`accepted`/`superseded`) shared records. A draft is never returned. A private record is returned only to a chair holding the exact
 * `desk.scratch.read` grant in the project, and never when the installation's inspection policy says `scratch: "denied"` (the kill-switch of A10, applied here as in `DeskService`).
 * Shared working notes (C01b) of the project are read with `readNote`: no desk grant and no scratch grant is involved, the member may be present or absent, and the record says `shared`.
 *
 * Nothing here wakes, messages or touches the agent whose files are read (no message, delivery, wake, lease or attempt is written); `attemptChange` is the one place a write, rename, delete
 * or lock can be asked of the read path, and it always refuses and records the attempt.
 */
export class MeetingDeskReadService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): MeetingDeskReadService {
    return new MeetingDeskReadService(new CommandRunner(storage, epoch, options));
  }

  /** The meeting record, when `chair` is the current chair of that open meeting; otherwise `forbidden` (the same answer for a missing record, a stranger, a former chair and a finished meeting). */
  async #chairOf(chair: Principal, meetingRecordId: string): Promise<{ meeting: RecordBody; revision: number }> {
    const m = await this.#runner.get("meeting-record", meetingRecordId);
    const meeting = m?.body as unknown as RecordBody | undefined;
    if (m === undefined || meeting === undefined) throw new DomainError("forbidden", `${chair.id} may not read for that meeting`);
    if (chair.kind !== "agent" || chair.asOf === undefined || !inTaskScope(chair, meeting.projectId)) throw new DomainError("forbidden", `${chair.id} may not read for that meeting`);
    if (meeting.state !== "open" || meeting.chair !== chair.id) throw new DomainError("forbidden", `${chair.id} is not the chair of an open meeting ${meetingRecordId}`);
    return { meeting, revision: m.revision };
  }

  /** The records one read leaves, made together with the read itself. */
  #records(chair: Principal, meeting: RecordBody, meetingRecordId: string, commandId: string, what: { targetId: string; owner: string; revision: number; title: string; body: string; visibility: "shared" | "private"; source: "desk" | "note"; policy: InspectionBody["policy"] }): { readRef: AggregateRef; changes: Change[] } {
    const at = this.#runner.now();
    const readRef: AggregateRef = { kind: "meeting-desk-read", id: derivedId("mdr", commandId) };
    const inspectionId = derivedId("ins", `mdr:${commandId}`);
    const body: DeskReadBody = {
      occurrenceId: meeting.occurrenceId, meetingRecordId, projectId: meeting.projectId, deskRecordId: what.targetId, deskOwner: what.owner, deskRevision: what.revision,
      sha256: createHash("sha256").update(JSON.stringify([what.title, what.body])).digest("hex"), bytes: Buffer.byteLength(what.title + what.body, "utf8"),
      visibility: what.visibility, reader: chair.id, at, source: what.source, inspectionId,
    };
    const look: InspectionBody = {
      inspector: chair.id, via: "meeting-chair", recordId: what.targetId, recordOwner: what.owner, projectId: meeting.projectId,
      reason: `read by the chair of meeting ${meeting.occurrenceId}`, policy: what.policy, at, meetingRecordId, revision: what.revision,
    };
    return {
      readRef,
      changes: [
        { type: "create", ref: readRef, body: body as unknown as JsonObject },
        { type: "create", ref: { kind: "inspection", id: inspectionId }, body: look as unknown as JsonObject },
      ],
    };
  }

  async read(chair: Principal, command: NoActor & { meetingRecordId: string; deskRecordId: string }): Promise<{ record?: DeskReadContent; readId: string; inspectionId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "meetingRecordId", "deskRecordId"]);
    const meetingRecordId = typeof command.meetingRecordId === "string" && MEETING_RECORD_ID.test(command.meetingRecordId) ? command.meetingRecordId : invalid("meetingRecordId", "is not a meeting record ID");
    const deskRecordId = typeof command.deskRecordId === "string" && RECORD_ID.test(command.deskRecordId) ? command.deskRecordId : invalid("deskRecordId", "is not a desk record ID");
    const commandId = scopedCommandId(chair.id, command.commandId);
    const readId = derivedId("mdr", commandId);
    const inspectionId = derivedId("ins", `mdr:${commandId}`);
    let seen: DeskReadContent | undefined;
    const r = await this.#runner.command("meeting.desk-read", { commandId, actor: chair.id }, async () => ({
      payload: { meetingRecordId, deskRecordId },
      build: async () => {
        const { meeting, revision } = await this.#chairOf(chair, meetingRecordId);
        const found = await this.#runner.get("desk-record", deskRecordId);
        const desk = found?.body as unknown as DeskRecordBody | undefined;
        // Present members, other projects and non-members read like missing records.
        const absent = desk !== undefined && desk.projectId === meeting.projectId && meeting.roster.includes(desk.owner) && !meeting.attended.includes(desk.owner);
        if (found === undefined || desk === undefined || !absent) throw forbidden(chair);
        if (desk.status === "draft") throw forbidden(chair);
        let policyNow: InspectionBody["policy"] = "not-applicable";
        if (desk.visibility === "private") {
          const policy = (await this.#runner.get("inspection-policy", "installation"))?.body as unknown as { scratch?: string } | undefined;
          if (policy?.scratch === "denied" || !allowsExactly(chair, "desk.scratch.read", desk.projectId)) throw forbidden(chair);
          policyNow = "allowed";
        }
        seen = { id: found.id, revision: found.revision, title: desk.title, body: desk.body };
        const made = this.#records(chair, meeting, meetingRecordId, commandId, { targetId: deskRecordId, owner: desk.owner, revision: found.revision, title: desk.title, body: desk.body, visibility: desk.visibility, source: "desk", policy: policyNow });
        return { ref: made.readRef, creates: true, changes: [...made.changes, { type: "check", ref: { kind: "desk-record", id: deskRecordId }, expectedRevision: found.revision }, { type: "check", ref: { kind: "meeting-record", id: meetingRecordId }, expectedRevision: revision }], detail: { deskRecordId, deskOwner: desk.owner, revision: found.revision } };
      },
    }));
    return r.replayed ? { readId, inspectionId, replayed: true } : { record: seen!, readId, inspectionId, replayed: false };
  }

  /**
   * The chair reads a shared working note of the meeting's project (card C01b's tier; M05b: "needs no meetingRead and appears in the record as shared"). The note's agent may be present or
   * absent. No grant is needed beyond being the current chair of the open meeting; a private, deleted or other project's note reads like a missing one. The read is recorded like a desk read,
   * with `source: "note"` and `visibility: "shared"`, and the note's agent sees it among its inspections.
   */
  async readNote(chair: Principal, command: NoActor & { meetingRecordId: string; noteId: string }): Promise<{ record?: DeskReadContent; readId: string; inspectionId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "meetingRecordId", "noteId"]);
    const meetingRecordId = typeof command.meetingRecordId === "string" && MEETING_RECORD_ID.test(command.meetingRecordId) ? command.meetingRecordId : invalid("meetingRecordId", "is not a meeting record ID");
    const noteId = typeof command.noteId === "string" && NOTE_ID.test(command.noteId) ? command.noteId : invalid("noteId", "is not a note ID");
    const commandId = scopedCommandId(chair.id, command.commandId);
    const readId = derivedId("mdr", commandId);
    const inspectionId = derivedId("ins", `mdr:${commandId}`);
    let seen: DeskReadContent | undefined;
    const r = await this.#runner.command("meeting.note-read", { commandId, actor: chair.id }, async () => ({
      payload: { meetingRecordId, noteId },
      build: async () => {
        const { meeting, revision } = await this.#chairOf(chair, meetingRecordId);
        const found = await this.#runner.get("working-note", noteId);
        const note = found?.body as unknown as WorkingNoteBody | undefined;
        if (found === undefined || note === undefined || note.projectId !== meeting.projectId || note.visibility !== "shared" || note.deleted !== undefined) throw forbidden(chair);
        seen = { id: found.id, revision: found.revision, title: note.title, body: note.body };
        const made = this.#records(chair, meeting, meetingRecordId, commandId, { targetId: noteId, owner: note.owner, revision: found.revision, title: note.title, body: note.body, visibility: "shared", source: "note", policy: "not-applicable" });
        return { ref: made.readRef, creates: true, changes: [...made.changes, { type: "check", ref: { kind: "working-note", id: noteId }, expectedRevision: found.revision }, { type: "check", ref: { kind: "meeting-record", id: meetingRecordId }, expectedRevision: revision }], detail: { noteId, noteOwner: note.owner, revision: found.revision } };
      },
    }));
    return r.replayed ? { readId, inspectionId, replayed: true } : { record: seen!, readId, inspectionId, replayed: false };
  }

  /**
   * The one place a write, revision, rename, deletion or lock can be asked of the chair's read path. It never does any of them: it refuses (`forbidden`, every time, a repeat included) and
   * leaves a record of the attempt, one per meeting record, target and operation with a count, so a chair that keeps trying cannot grow the record. Only the current chair of an open meeting is
   * recorded; anyone else is refused without a record (as for a read). The target need not exist; when it is a desk record or note of the meeting's project its owner is noted and sees the attempt.
   */
  async attemptChange(chair: Principal, command: NoActor & { meetingRecordId: string; targetId: string; operation: string }): Promise<never> {
    onlyKnown(command, ["commandId", "meetingRecordId", "targetId", "operation"]);
    const meetingRecordId = typeof command.meetingRecordId === "string" && MEETING_RECORD_ID.test(command.meetingRecordId) ? command.meetingRecordId : invalid("meetingRecordId", "is not a meeting record ID");
    const targetId = typeof command.targetId === "string" && (RECORD_ID.test(command.targetId) || NOTE_ID.test(command.targetId)) ? command.targetId : invalid("targetId", "is not a desk record or note ID");
    const operation = (REFUSED_OPERATIONS as readonly string[]).includes(command.operation) ? command.operation as RefusedOperation : invalid("operation", `must be one of ${REFUSED_OPERATIONS.join(", ")}`);
    const commandId = scopedCommandId(chair.id, command.commandId);
    await this.#runner.command("meeting.desk-change-attempt", { commandId, actor: chair.id }, async () => ({
      payload: { meetingRecordId, targetId, operation },
      build: async () => {
        const { meeting, revision } = await this.#chairOf(chair, meetingRecordId);
        const target = await this.#runner.get(RECORD_ID.test(targetId) ? "desk-record" : "working-note", targetId);
        const owner = (target?.body as unknown as { owner?: string; projectId?: string } | undefined);
        const deskOwner = owner !== undefined && owner.projectId === meeting.projectId && typeof owner.owner === "string" ? owner.owner : undefined;
        const ref: AggregateRef = { kind: "meeting-desk-attempt", id: derivedId("mda", `${meetingRecordId}|${targetId}|${operation}`) };
        const now = this.#runner.now();
        const existing = await this.#runner.get("meeting-desk-attempt", ref.id);
        const prior = existing?.body as unknown as DeskAttemptBody | undefined;
        const body: DeskAttemptBody = {
          occurrenceId: meeting.occurrenceId, meetingRecordId, projectId: meeting.projectId, targetId, ...(deskOwner === undefined ? {} : { deskOwner }), operation,
          count: (prior?.count ?? 0) + 1, first: prior?.first ?? now, last: now, lastBy: chair.id,
        };
        const change: Change = existing === undefined || prior === undefined
          ? { type: "create", ref, body: body as unknown as JsonObject }
          : { type: "update", ref, expectedRevision: existing.revision, body: body as unknown as JsonObject };
        return { ref, creates: existing === undefined, changes: [change, { type: "check", ref: { kind: "meeting-record", id: meetingRecordId }, expectedRevision: revision }], detail: { targetId, operation, refused: true } };
      },
    }));
    throw new DomainError("forbidden", `the chair's meeting read cannot ${operation} a record; the attempt is recorded`);
  }

  /** Who sees a recorded read or attempt: the owner; the file's owner; and the roster members and the chair of the occurrence's meeting (so a later chair sees what an earlier one did). */
  #mayList(by: Principal): (b: Listed) => Promise<boolean> {
    const member = new Map<string, boolean>();
    return async (b) => {
      if (by.kind === "owner") return true;
      if (by.kind !== "agent" || by.asOf === undefined || !inTaskScope(by, b.projectId)) return false;
      if (b.deskOwner === by.id) return true;
      let ok = member.get(b.meetingRecordId);
      if (ok === undefined) {
        const rec = (await this.#runner.get("meeting-record", b.meetingRecordId))?.body as unknown as RecordBody | undefined;
        ok = rec !== undefined && rec.occurrenceId === b.occurrenceId && (rec.roster.includes(by.id) || rec.chair === by.id);
        member.set(b.meetingRecordId, ok);
      }
      return ok;
    };
  }

  /** Every matching record of a kind, oldest first (time, then ID), a page at a time by cursor. All records of the kind are scanned in ID order; per installation they are few (one per file read). */
  async #page<B extends Listed>(kind: string, by: Principal, query: { occurrenceId: string; filter?: (b: B) => boolean; after?: string; limit?: number }): Promise<{ items: View<B>[]; next?: string }> {
    const limit = query.limit === undefined ? 100 : Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 500 ? query.limit : invalid("limit", "must be 1 to 500");
    const may = this.#mayList(by);
    const found: { time: string; id: string; view: View<B> }[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.#runner.list(kind, { ...(cursor === undefined ? {} : { afterId: cursor }), limit: 200 });
      for (const a of page) {
        cursor = a.id;
        const b = a.body as unknown as B;
        if (b.occurrenceId !== query.occurrenceId || (query.filter !== undefined && !query.filter(b)) || !(await may(b))) continue;
        found.push({ time: (b.last ?? b.at)!, id: a.id, view: view<B>(a) });
      }
      if (page.length < 200) break;
    }
    found.sort((x, y) => (x.time < y.time ? -1 : x.time > y.time ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    let from = 0;
    if (query.after !== undefined) {
      const at = found.findIndex((f) => f.id === query.after);
      if (at < 0) invalid("after", "is not a cursor from this listing");
      from = at + 1;
    }
    const slice = found.slice(from, from + limit);
    return { items: slice.map((f) => f.view), ...(from + limit < found.length ? { next: slice[slice.length - 1]!.id } : {}) };
  }

  /**
   * The recorded reads of one meeting occurrence in time order (then ID), a page at a time (`limit` default 100, at most 500; pass `next` back as `after`). Seen by the owner; by the
   * occurrence's roster members and chair (so a later chair sees what an earlier one read); and, whatever else, by the owner of a file for the reads of that file.
   */
  async reads(by: Principal, query: { occurrenceId: string; deskRecordId?: string; after?: string; limit?: number }): Promise<{ reads: View<DeskReadBody>[]; next?: string }> {
    const filter = query.deskRecordId === undefined ? undefined : (b: DeskReadBody) => b.deskRecordId === query.deskRecordId;
    const r = await this.#page<DeskReadBody>("meeting-desk-read", by, { occurrenceId: query.occurrenceId, ...(filter === undefined ? {} : { filter }), ...(query.after === undefined ? {} : { after: query.after }), ...(query.limit === undefined ? {} : { limit: query.limit }) });
    return { reads: r.items, ...(r.next === undefined ? {} : { next: r.next }) };
  }

  /** The refused attempts to change something through the read path, for one occurrence, in time order of their last repeat; seen by the same people as the reads. */
  async attempts(by: Principal, query: { occurrenceId: string; after?: string; limit?: number }): Promise<{ attempts: View<DeskAttemptBody>[]; next?: string }> {
    const r = await this.#page<DeskAttemptBody>("meeting-desk-attempt", by, { occurrenceId: query.occurrenceId, ...(query.after === undefined ? {} : { after: query.after }), ...(query.limit === undefined ? {} : { limit: query.limit }) });
    return { attempts: r.items, ...(r.next === undefined ? {} : { next: r.next }) };
  }
}

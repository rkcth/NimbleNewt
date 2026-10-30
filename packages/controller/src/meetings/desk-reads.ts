import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allowsExactly, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { DeskRecordBody } from "../context/desks.js";
import type { RecordBody } from "./record-types.js";

/** What the chair gets back: exactly the title and body that `sha256` and `bytes` cover, with the record's identity and revision. */
export interface DeskReadContent { readonly id: string; readonly revision: number; readonly title: string; readonly body: string }

/** One file the chair read from an absent member's desk during a meeting. One record per read; the absent member can see it. Never changed after it is written. */
export interface DeskReadBody {
  readonly occurrenceId: string;
  readonly meetingRecordId: string;
  readonly projectId: string;
  readonly deskRecordId: string;
  readonly deskOwner: string;
  /** The desk record's revision at the time of the read, and the SHA-256 and UTF-8 size of `JSON.stringify([title, body])` and of title + body: what was returned, nothing more. */
  readonly deskRevision: number;
  readonly sha256: string;
  readonly bytes: number;
  readonly visibility: "shared" | "private";
  readonly reader: string;
  readonly at: string;
}

const RECORD_ID = /^dsk-[a-z2-7]{20}$/;
const MEETING_RECORD_ID = /^mrc-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/**
 * The chair's meeting-scoped read of an absent member's desk (card M05b). Read-only by construction: the service holds a runner and uses only `get` on desk records;
 * its only write is the per-file read record, created in the same step as the read and guarded by the desk record's revision. A read of a record leaves exactly one
 * `meeting-desk-read` record (occurrence, file, revision, digest, bytes, reader, time); no record is made for files not read, and the record is made before the content is returned.
 * Allowed only to the open meeting's current chair (an authenticated agent, `asOf` set, in task scope for the meeting's project, as every other chair check in `record.ts`), for a member
 * of the roster who has not attended, in the meeting's project.
 *
 * What the chair may see (owner decision 2026-10-22, "option B": the chair reads an absent member's desk, read-only, every file logged; the plan text names no exception for scratch or
 * drafts and C01b gives members neither): committed (`accepted`/`superseded`) shared records. A draft is never returned. A private record is returned only to a chair holding the exact
 * `desk.scratch.read` grant in the project, and never when the installation's inspection policy says `scratch: "denied"` (the kill-switch of A10, applied here as in `DeskService`).
 */
export class MeetingDeskReadService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): MeetingDeskReadService {
    return new MeetingDeskReadService(new CommandRunner(storage, epoch, options));
  }

  async read(chair: Principal, command: NoActor & { meetingRecordId: string; deskRecordId: string }): Promise<{ record?: DeskReadContent; readId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "meetingRecordId", "deskRecordId"]);
    const meetingRecordId = typeof command.meetingRecordId === "string" && MEETING_RECORD_ID.test(command.meetingRecordId) ? command.meetingRecordId : invalid("meetingRecordId", "is not a meeting record ID");
    const deskRecordId = typeof command.deskRecordId === "string" && RECORD_ID.test(command.deskRecordId) ? command.deskRecordId : invalid("deskRecordId", "is not a desk record ID");
    const commandId = scopedCommandId(chair.id, command.commandId);
    const id = derivedId("mdr", commandId);
    let seen: DeskReadContent | undefined;
    const r = await this.#runner.command("meeting.desk-read", { commandId, actor: chair.id }, async () => ({
      payload: { meetingRecordId, deskRecordId },
      build: async () => {
        const m = await this.#runner.get("meeting-record", meetingRecordId);
        const meeting = m?.body as unknown as RecordBody | undefined;
        if (m === undefined || meeting === undefined) throw new DomainError("forbidden", `${chair.id} may not read for that meeting`);
        if (chair.kind !== "agent" || chair.asOf === undefined || !inTaskScope(chair, meeting.projectId)) throw new DomainError("forbidden", `${chair.id} may not read for that meeting`);
        if (meeting.state !== "open" || meeting.chair !== chair.id) throw new DomainError("forbidden", `${chair.id} is not the chair of an open meeting ${meetingRecordId}`);
        const found = await this.#runner.get("desk-record", deskRecordId);
        const desk = found?.body as unknown as DeskRecordBody | undefined;
        // Present members, other projects and non-members read like missing records.
        const absent = desk !== undefined && desk.projectId === meeting.projectId && meeting.roster.includes(desk.owner) && !meeting.attended.includes(desk.owner);
        if (found === undefined || desk === undefined || !absent) throw new DomainError("forbidden", `${chair.id} may not read that record in this meeting`);
        if (desk.status === "draft") throw new DomainError("forbidden", `${chair.id} may not read that record in this meeting`);
        if (desk.visibility === "private") {
          const policy = (await this.#runner.get("inspection-policy", "installation"))?.body as unknown as { scratch?: string } | undefined;
          if (policy?.scratch === "denied" || !allowsExactly(chair, "desk.scratch.read", desk.projectId)) throw new DomainError("forbidden", `${chair.id} may not read that record in this meeting`);
        }
        seen = { id: found.id, revision: found.revision, title: desk.title, body: desk.body };
        const ref: AggregateRef = { kind: "meeting-desk-read", id };
        const body: DeskReadBody = {
          occurrenceId: meeting.occurrenceId, meetingRecordId, projectId: desk.projectId, deskRecordId, deskOwner: desk.owner, deskRevision: found.revision,
          sha256: createHash("sha256").update(JSON.stringify([desk.title, desk.body])).digest("hex"), bytes: Buffer.byteLength(desk.title + desk.body, "utf8"),
          visibility: desk.visibility, reader: chair.id, at: this.#runner.now(),
        };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }, { type: "check", ref: { kind: "desk-record", id: deskRecordId }, expectedRevision: found.revision }, { type: "check", ref: { kind: "meeting-record", id: meetingRecordId }, expectedRevision: m.revision }], detail: { deskRecordId, deskOwner: desk.owner, revision: found.revision } };
      },
    }));
    return r.replayed ? { readId: id, replayed: true } : { record: seen!, readId: id, replayed: false };
  }

  /**
   * The recorded reads of one meeting occurrence, in ID order, a page at a time (`limit` default 100, at most 500; pass `next` back as `after`). Seen by the owner; by the occurrence's
   * roster members and chair (so a later chair sees what an earlier one read); and, whatever else, by the owner of a desk for the reads of that desk.
   */
  async reads(by: Principal, query: { occurrenceId: string; deskRecordId?: string; after?: string; limit?: number }): Promise<{ reads: View<DeskReadBody>[]; next?: string }> {
    const limit = query.limit === undefined ? 100 : Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 500 ? query.limit : invalid("limit", "must be 1 to 500");
    const member = new Map<string, boolean>();
    const mayList = async (b: DeskReadBody): Promise<boolean> => {
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
    const out: View<DeskReadBody>[] = [];
    let after = query.after;
    for (;;) {
      const page = await this.#runner.list("meeting-desk-read", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id;
        const b = a.body as unknown as DeskReadBody;
        if (b.occurrenceId !== query.occurrenceId || (query.deskRecordId !== undefined && b.deskRecordId !== query.deskRecordId) || !(await mayList(b))) continue;
        if (out.length === limit) return { reads: out, next: out[out.length - 1]!.id };
        out.push(view<DeskReadBody>(a));
      }
      if (page.length < 200) return { reads: out };
    }
  }
}

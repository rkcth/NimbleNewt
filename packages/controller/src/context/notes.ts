import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, taskId as checkTaskId, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows, allowsExactly, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import { findCredentialShapes } from "../security/credential-patterns.js";
import type { NoActor, Principal } from "../security/principals.js";
import { sha256 } from "../storage/json.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { PublicationService } from "./publication.js";

export type NoteCategory = "status" | "decision" | "measurement" | "handoff" | "other";
export const NOTE_CATEGORIES: readonly NoteCategory[] = ["status", "decision", "measurement", "handoff", "other"];
/** `shared`: readable by the project's members, a meeting chair there and the owner. `private`: its agent and the owner only. */
export type NoteVisibility = "shared" | "private";

/** One shared working note (kind `working-note`): the agent's own account, written on purpose for its project while work is in progress. */
export interface WorkingNoteBody {
  /** The agent whose note it is (taken from authentication); only this agent writes it. */
  readonly owner: string;
  /** Who wrote the current revision: the agent, or the owner after a correction. */
  readonly author: string;
  readonly projectId: string;
  readonly taskId?: string;
  readonly category: NoteCategory;
  readonly title: string;
  readonly body: string;
  /** Why, for a decision (and optionally for anything else). */
  readonly reason?: string;
  readonly visibility: NoteVisibility;
  readonly writtenAt: string;
  readonly updatedAt: string;
  /** Set when the owner deleted the note: the content is gone and only this marker remains. */
  readonly deleted?: { readonly by: string; readonly at: string; readonly deletionId: string };
}

/** What revision N of a note said, and who wrote it (kind `working-note-version`, id `<note>.<revision>`). */
export interface NoteVersionBody {
  readonly noteId: string;
  /** The note's revision this version is. */
  readonly noteRevision: number;
  readonly author: string;
  readonly correction: boolean;
  readonly at: string;
  readonly visibility: NoteVisibility;
  readonly title: string;
  readonly body: string;
  readonly reason?: string;
  readonly deleted?: true;
}

/** The record of a promotion request (kind `working-note-promotion`): the agent asks that a note's content go into the codebase or the documents. The review path decides; this only records the ask. */
export interface NotePromotionBody {
  readonly noteId: string;
  readonly noteRevision: number;
  readonly noteOwner: string;
  readonly projectId: string;
  readonly target: "codebase" | "docs";
  readonly path: string;
  readonly reason: string;
  /** Digest of the note's title and body as promoted, so a later change to the note is visible against what was asked. */
  readonly contentDigest: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  /** The review request this rides on, when the agent already made one (card A05/H05). */
  readonly reviewId?: string;
  readonly state: "requested";
  /** Set when the owner deleted the note: reason and path were blanked because they may have echoed its content. */
  readonly scrubbed?: true;
}

/** The record of an owner deletion (kind `working-note-deletion`). It keeps who, why, when and a digest of what was deleted, never the content. */
export interface NoteDeletionBody {
  readonly noteId: string;
  readonly noteOwner: string;
  readonly projectId: string;
  readonly deletedBy: string;
  readonly reason: string;
  readonly at: string;
  readonly finalRevision: number;
  readonly contentDigest: string;
}

export interface WriteNote extends NoActor {
  readonly projectId: string;
  readonly taskId?: string;
  readonly category: NoteCategory;
  readonly title: string;
  readonly body: string;
  readonly reason?: string;
}
export interface ReviseNote extends NoActor {
  readonly noteId: string;
  readonly expectedRevision: number;
  readonly title?: string;
  readonly body?: string;
  readonly reason?: string;
}

export const NOTE_LIMITS = { title: 200, body: 8_000, reason: 1_000, path: 300, revisions: 50, correctionsExtra: 10, promotions: 20, listLimit: 200 } as const;
/** Most revisions a note can reach, corrections and marking private included. */
const HARD_CEILING = NOTE_LIMITS.revisions + NOTE_LIMITS.correctionsExtra;
const NOTE_ID = /^wnt-[a-z2-7]{20}$/;
const REVIEW_ID = /^rev-[a-z2-7]{20}$/;
const PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\-/]{1,300}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/** Note text is data, never a credential: a shape on the credential-pattern list is refused at write time, and the refusal names the kind of shape, not the text. */
function plain(value: unknown, field: string, max: number, min = 1): string {
  const out = text(value, field, { min, max, multiline: true });
  const shapes = findCredentialShapes(out);
  if (shapes.length > 0) invalid(field, `looks like a credential or key (${shapes.join(", ")}); those do not belong in a note`);
  return out;
}

const promotionIdOf = (noteId: string, n: number): string => `${noteId}.p${n}`;
const noteIdOf = (value: unknown): string => (typeof value === "string" && NOTE_ID.test(value) ? value : invalid("noteId", "is not a note ID"));

/**
 * Shared working notes (card C01b): a tier beside private scratch. An agent writes an entry on purpose for its project (status, a decision with its reason, a measurement, hand-off state) while
 * the work is not yet in the codebase.
 * - **Readers.** A shared note is read by its agent, by principals holding `desk.read` in its project (the project's members), by a meeting chair there (stand-in: the exact grant
 *   `notes.chair.read`, until a chair exists in M05b) and by the owner. A private note is read by its agent and the owner only. Another project reads a shared note only for a project of its own
 *   (`viaProject`) that the owner has opened an A10 path to. Unreadable reads like missing.
 * - **Writers.** Only the note's own agent, with `desk.write` in the project, writes or revises it; nobody else, whatever they hold. The owner corrects or deletes.
 * - **Versions.** Every revision keeps its author, time and content (up to {@link NOTE_LIMITS.revisions} revisions), and a read returns the record and its revision.
 * - **Reading never wakes the agent.** Reads and listings only read stored records; they send nothing to the author and need nothing from it, so notes stay readable while it is inside a
 *   long-running command.
 * - **Data, not instructions.** Reading a note activates nothing.
 */
export class WorkingNoteService {
  readonly #runner: CommandRunner;
  readonly #paths: PublicationService;

  private constructor(runner: CommandRunner, paths: PublicationService) { this.#runner = runner; this.#paths = paths; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): WorkingNoteService {
    return new WorkingNoteService(new CommandRunner(storage, epoch, options), PublicationService.withEpoch(storage, epoch, options));
  }

  /** Writes a new shared note on the agent's own desk. */
  async write(principal: Principal, command: WriteNote): Promise<{ id: string; revision: number; replayed: boolean }> {
    if (principal.kind !== "agent") throw new DomainError("forbidden", `${principal.id} has no desk; notes belong to agents`);
    return this.#runner.command("note.write", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => {
      onlyKnown(command, ["commandId", "projectId", "taskId", "category", "title", "body", "reason"]);
      const projectId = checkProjectId(command.projectId);
      const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
      const category = (NOTE_CATEGORIES as readonly string[]).includes(command.category) ? command.category : invalid("category", `must be one of ${NOTE_CATEGORIES.join(", ")}`);
      const title = plain(command.title, "title", NOTE_LIMITS.title);
      const body = plain(command.body, "body", NOTE_LIMITS.body);
      const reason = command.reason === undefined ? undefined : plain(command.reason, "reason", NOTE_LIMITS.reason);
      if (category === "decision" && reason === undefined) invalid("reason", "a decision note says why");
      if (!allows(principal, "desk.write", projectId)) throw new DomainError("forbidden", `${principal.id} may not desk.write in ${projectId}`);
      return {
        payload: { projectId, ...(taskId === undefined ? {} : { taskId }), category, title, body, ...(reason === undefined ? {} : { reason }) },
        build: async () => {
          if ((await this.#runner.get("project", projectId)) === undefined) throw new DomainError("not_found", `project ${projectId} does not exist`);
          if (taskId !== undefined) {
            const task = await this.#runner.get("task", taskId);
            if ((task?.body as { projectId?: string } | undefined)?.projectId !== projectId) throw new DomainError("invalid_command", `task ${taskId} is not in project ${projectId}`, { field: "taskId" });
          }
          const id = derivedId("wnt", scopedCommandId(principal.id, command.commandId));
          const now = this.#runner.now();
          const note: WorkingNoteBody = { owner: principal.id, author: principal.id, projectId, ...(taskId === undefined ? {} : { taskId }), category, title, body, ...(reason === undefined ? {} : { reason }), visibility: "shared", writtenAt: now, updatedAt: now };
          const ref: AggregateRef = { kind: "working-note", id };
          return { ref, creates: true, changes: [{ type: "create", ref, body: note as unknown as JsonObject }, this.#version(id, 1, note, false)], detail: { projectId, category } };
        },
      };
    }).then((r) => ({ id: r.id, revision: r.revision, replayed: r.replayed }));
  }

  /** Revises the agent's own note (new title, body or reason). The previous revision stays in the versions. */
  async revise(principal: Principal, command: ReviseNote): Promise<{ id: string; revision: number; replayed: boolean }> {
    return this.#runner.command("note.revise", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => {
      onlyKnown(command, ["commandId", "noteId", "expectedRevision", "title", "body", "reason"]);
      const id = noteIdOf(command.noteId);
      const expected = checkRevision(command.expectedRevision);
      const title = command.title === undefined ? undefined : plain(command.title, "title", NOTE_LIMITS.title);
      const body = command.body === undefined ? undefined : plain(command.body, "body", NOTE_LIMITS.body);
      const reason = command.reason === undefined ? undefined : plain(command.reason, "reason", NOTE_LIMITS.reason);
      if (title === undefined && body === undefined && reason === undefined) invalid("title", "a revision must change the title, body or reason");
      return {
        payload: { noteId: id, expectedRevision: expected, ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }), ...(reason === undefined ? {} : { reason }) },
        build: async () => {
          const found = await this.#runner.get("working-note", id);
          const current = found?.body as unknown as WorkingNoteBody | undefined;
          if (found === undefined || current === undefined || current.owner !== principal.id || current.deleted !== undefined || !inTaskScope(principal, current.projectId) || !allows(principal, "desk.write", current.projectId)) throw new DomainError("forbidden", `${principal.id} may not revise that note`);
          this.#staleOrFull(found.revision, expected, id, NOTE_LIMITS.revisions);
          return this.#next(id, found.revision, current, principal.id, { ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }), ...(reason === undefined ? {} : { reason }) }, false, "revised");
        },
      };
    }).then((r) => ({ id: r.id, revision: r.revision, replayed: r.replayed }));
  }

  /** The agent marks its own note private again (or shares it once more). A private note is read by the agent and the owner only; the change is a revision with its own version record. */
  async setVisibility(principal: Principal, command: NoActor & { noteId: string; expectedRevision: number; visibility: NoteVisibility }): Promise<{ id: string; revision: number; replayed: boolean }> {
    return this.#runner.command("note.visibility", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => {
      onlyKnown(command, ["commandId", "noteId", "expectedRevision", "visibility"]);
      const id = noteIdOf(command.noteId);
      const expected = checkRevision(command.expectedRevision);
      const visibility = command.visibility === "shared" || command.visibility === "private" ? command.visibility : invalid("visibility", "must be shared or private");
      return {
        payload: { noteId: id, expectedRevision: expected, visibility },
        build: async () => {
          const found = await this.#runner.get("working-note", id);
          const current = found?.body as unknown as WorkingNoteBody | undefined;
          if (found === undefined || current === undefined || current.owner !== principal.id || current.deleted !== undefined || !inTaskScope(principal, current.projectId)) throw new DomainError("forbidden", `${principal.id} may not change that note`);
          this.#staleOrFull(found.revision, expected, id, visibility === "private" ? HARD_CEILING : NOTE_LIMITS.revisions);
          // Taking a note back is never blocked by a lost grant; sharing it again needs one.
          if (visibility === "shared" && !allows(principal, "desk.write", current.projectId)) throw new DomainError("forbidden", `${principal.id} may not share in ${current.projectId}`);
          if (current.visibility === visibility) throw new DomainError("invalid_command", `the note is already ${visibility}`, { field: "visibility" });
          return this.#next(id, found.revision, current, principal.id, { visibility }, false, "visibility");
        },
      };
    }).then((r) => ({ id: r.id, revision: r.revision, replayed: r.replayed }));
  }

  /**
   * The agent asks that a note's content go into the codebase or the documents. This records the request against the note's revision and content digest; it changes neither the note nor any
   * file. The decision is the normal review path's (cards A05 and H05): pass the `reviewId` of a review request the agent made, if there is one.
   */
  async promote(principal: Principal, command: NoActor & { noteId: string; expectedRevision: number; target: "codebase" | "docs"; path: string; reason: string; reviewId?: string }): Promise<{ id: string; replayed: boolean }> {
    return this.#runner.command("note.promote", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => {
      onlyKnown(command, ["commandId", "noteId", "expectedRevision", "target", "path", "reason", "reviewId"]);
      const noteId = noteIdOf(command.noteId);
      const expected = checkRevision(command.expectedRevision);
      const target = command.target === "codebase" || command.target === "docs" ? command.target : invalid("target", "must be codebase or docs");
      const path = typeof command.path === "string" && PATH.test(command.path) ? command.path : invalid("path", "must be a relative path inside the repository, without ..");
      const reason = plain(command.reason, "reason", NOTE_LIMITS.reason);
      const reviewId = command.reviewId === undefined ? undefined : typeof command.reviewId === "string" && REVIEW_ID.test(command.reviewId) ? command.reviewId : invalid("reviewId", "is not a review request ID");
      return {
        payload: { noteId, expectedRevision: expected, target, path, reason, ...(reviewId === undefined ? {} : { reviewId }) },
        build: async () => {
          const found = await this.#runner.get("working-note", noteId);
          const note = found?.body as unknown as WorkingNoteBody | undefined;
          if (found === undefined || note === undefined || note.owner !== principal.id || note.deleted !== undefined || !inTaskScope(principal, note.projectId)) throw new DomainError("forbidden", `${principal.id} may not promote that note`);
          this.#staleOrFull(found.revision, expected, noteId);
          if (reviewId !== undefined) {
            const review = await this.#runner.get("review", reviewId);
            if ((review?.body as { binding?: { requester?: string; projectId?: string } } | undefined)?.binding?.requester !== principal.id || (review?.body as { binding?: { projectId?: string } }).binding?.projectId !== note.projectId) throw new DomainError("invalid_command", "reviewId: must be a review request you made in this project", { field: "reviewId" });
          }
          // A note's requests have IDs `<note>.p<n>`, so they are found directly and counted; the cap is per note.
          let n = 1;
          while (n <= NOTE_LIMITS.promotions && (await this.#runner.get("working-note-promotion", promotionIdOf(noteId, n))) !== undefined) n++;
          if (n > NOTE_LIMITS.promotions) throw new DomainError("invalid_command", `a note takes at most ${NOTE_LIMITS.promotions} promotion requests; ask the owner or write a new note`, { field: "noteId" });
          const id = promotionIdOf(noteId, n);
          const ref: AggregateRef = { kind: "working-note-promotion", id };
          const body: NotePromotionBody = { noteId, noteRevision: found.revision, noteOwner: note.owner, projectId: note.projectId, target, path, reason, contentDigest: sha256(`${note.title}\0${note.body}`), requestedBy: principal.id, requestedAt: this.#runner.now(), ...(reviewId === undefined ? {} : { reviewId }), state: "requested" };
          // The check ties the request to the revision it was made against.
          return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }, { type: "check", ref: { kind: "working-note", id: noteId }, expectedRevision: found.revision }], detail: { noteId, noteRevision: found.revision, target, path } };
        },
      };
    }).then((r) => ({ id: r.id, replayed: r.replayed }));
  }

  /** The owner corrects a note's text. The version records the owner as author and marks it a correction; the agent's earlier revisions stay. */
  async correct(owner: Principal, command: NoActor & { noteId: string; expectedRevision: number; title?: string; body?: string; reason?: string }): Promise<{ id: string; revision: number; replayed: boolean }> {
    this.#owner(owner, "corrects");
    return this.#runner.command("note.correct", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "noteId", "expectedRevision", "title", "body", "reason"]);
      const id = noteIdOf(command.noteId);
      const expected = checkRevision(command.expectedRevision);
      const title = command.title === undefined ? undefined : plain(command.title, "title", NOTE_LIMITS.title);
      const body = command.body === undefined ? undefined : plain(command.body, "body", NOTE_LIMITS.body);
      const reason = command.reason === undefined ? undefined : plain(command.reason, "reason", NOTE_LIMITS.reason);
      if (title === undefined && body === undefined && reason === undefined) invalid("title", "a correction must change the title, body or reason");
      return {
        payload: { noteId: id, expectedRevision: expected, ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }), ...(reason === undefined ? {} : { reason }) },
        build: async () => {
          const found = await this.#runner.get("working-note", id);
          const current = found?.body as unknown as WorkingNoteBody | undefined;
          if (found === undefined || current === undefined) throw new DomainError("not_found", "no such note");
          if (current.deleted !== undefined) throw new DomainError("invalid_command", "that note was deleted", { field: "noteId" });
          this.#staleOrFull(found.revision, expected, id, HARD_CEILING);
          return this.#next(id, found.revision, current, owner.id, { ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }), ...(reason === undefined ? {} : { reason }) }, true, "corrected");
        },
      };
    }).then((r) => ({ id: r.id, revision: r.revision, replayed: r.replayed }));
  }

  /**
   * The owner deletes a note. Its content and that of every version is removed (a marker with author, time and revision stays), and a deletion record keeps who, why, when and a digest of
   * what was there, never the content.
   */
  async delete(owner: Principal, command: NoActor & { noteId: string; expectedRevision: number; reason: string }): Promise<{ id: string; replayed: boolean }> {
    this.#owner(owner, "deletes");
    return this.#runner.command("note.delete", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "noteId", "expectedRevision", "reason"]);
      const noteId = noteIdOf(command.noteId);
      const expected = checkRevision(command.expectedRevision);
      const reason = plain(command.reason, "reason", NOTE_LIMITS.reason);
      return {
        payload: { noteId, expectedRevision: expected, reason },
        build: async () => {
          const found = await this.#runner.get("working-note", noteId);
          const note = found?.body as unknown as WorkingNoteBody | undefined;
          if (found === undefined || note === undefined) throw new DomainError("not_found", "no such note");
          if (note.deleted !== undefined) throw new DomainError("invalid_command", "that note was already deleted", { field: "noteId" });
          this.#staleOrFull(found.revision, expected, noteId);
          const id = derivedId("wnd", scopedCommandId(owner.id, command.commandId));
          const now = this.#runner.now();
          const ref: AggregateRef = { kind: "working-note-deletion", id };
          const deletion: NoteDeletionBody = { noteId, noteOwner: note.owner, projectId: note.projectId, deletedBy: owner.id, reason, at: now, finalRevision: found.revision, contentDigest: sha256(`${note.title}\0${note.body}`) };
          const changes: import("../storage/types.js").Change[] = [{ type: "create", ref, body: deletion as unknown as JsonObject }];
          for (let r = 1; r <= found.revision; r++) {
            const v = await this.#runner.get("working-note-version", `${noteId}.${r}`);
            if (v === undefined) continue;
            const vb = v.body as unknown as NoteVersionBody;
            changes.push({ type: "update", ref: { kind: "working-note-version", id: `${noteId}.${r}` }, expectedRevision: v.revision, body: { noteId: vb.noteId, noteRevision: vb.noteRevision, author: vb.author, correction: vb.correction, at: vb.at, visibility: vb.visibility, title: "", body: "", deleted: true } as unknown as JsonObject });
          }
          // Promotion requests may echo the deleted content in their reason or path: blank those too, in the same step.
          for (let n = 1; n <= NOTE_LIMITS.promotions; n++) {
            const pa = await this.#runner.get("working-note-promotion", promotionIdOf(noteId, n));
            if (pa === undefined) break;
            changes.push({ type: "update", ref: { kind: "working-note-promotion", id: pa.id }, expectedRevision: pa.revision, body: { ...(pa.body as unknown as NotePromotionBody), reason: "", path: "", scrubbed: true } as unknown as JsonObject });
          }
          const tomb: WorkingNoteBody = { owner: note.owner, author: note.author, projectId: note.projectId, ...(note.taskId === undefined ? {} : { taskId: note.taskId }), category: note.category, title: "", body: "", visibility: "private", writtenAt: note.writtenAt, updatedAt: now, deleted: { by: owner.id, at: now, deletionId: id } };
          changes.push({ type: "update", ref: { kind: "working-note", id: noteId }, expectedRevision: found.revision, body: tomb as unknown as JsonObject });
          return { ref, creates: true, changes, detail: { noteId, noteOwner: note.owner, finalRevision: found.revision } };
        },
      };
    }).then((r) => ({ id: r.id, replayed: r.replayed }));
  }

  /**
   * The note, if the principal may read it, with its ID and revision. `viaProject` names the project of the reader's own work when it is not the note's project: it needs read access there and an
   * open A10 path from the note's project. A deleted note is seen by the owner as a marker only.
   */
  async read(principal: Principal, noteId: string, options: { viaProject?: string } = {}): Promise<View<WorkingNoteBody>> {
    const via = options.viaProject === undefined ? undefined : checkProjectId(options.viaProject);
    const found = typeof noteId === "string" && NOTE_ID.test(noteId) ? await this.#runner.get("working-note", noteId) : undefined;
    if (found === undefined) throw principal.kind === "owner" ? new DomainError("not_found", "no such note") : new DomainError("forbidden", `${principal.id} may not read that note`);
    if (!(await this.#readable(principal, found.body as unknown as WorkingNoteBody, via))) throw new DomainError("forbidden", `${principal.id} may not read that note`);
    return view<WorkingNoteBody>(found);
  }

  /** The versions of a note (each with author and time), oldest first. The agent and the owner see all; others see only versions written while the note was shared. */
  async versions(principal: Principal, noteId: string, options: { viaProject?: string } = {}): Promise<View<NoteVersionBody>[]> {
    const note = await this.read(principal, noteId, options);
    // Text written while the note was private stays with its agent and the owner, even after the note is shared again.
    const all = principal.kind === "owner" || note.owner === principal.id;
    const out: View<NoteVersionBody>[] = [];
    for (let r = 1; r <= note.revision; r++) {
      const v = await this.#runner.get("working-note-version", `${noteId}.${r}`);
      if (v !== undefined && (all || (v.body as unknown as NoteVersionBody).visibility === "shared")) out.push(view<NoteVersionBody>(v));
    }
    return out;
  }

  /** The notes the principal may read, in ID order, filtered by author and project. Deleted notes and unreadable ones are skipped. A page can hold fewer than `limit` while `next` is present. */
  async list(principal: Principal, query: { ownerId?: string; projectId?: string; viaProject?: string; afterId?: string; limit: number }): Promise<{ items: View<WorkingNoteBody>[]; next?: string }> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > NOTE_LIMITS.listLimit) invalid("limit", `must be a whole number from 1 to ${NOTE_LIMITS.listLimit}`);
    const via = query.viaProject === undefined ? undefined : checkProjectId(query.viaProject);
    if (query.afterId !== undefined && !NOTE_ID.test(query.afterId)) invalid("afterId", "is not a note ID");
    const items: View<WorkingNoteBody>[] = [];
    let after = query.afterId;
    for (let reads = 0; reads < 20; reads++) {
      const page = await this.#runner.list("working-note", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const aggregate of page) {
        after = aggregate.id;
        const note = aggregate.body as unknown as WorkingNoteBody;
        if (note.deleted !== undefined) continue;
        if (query.ownerId !== undefined && note.owner !== query.ownerId) continue;
        if (query.projectId !== undefined && note.projectId !== query.projectId) continue;
        if (!(await this.#readable(principal, note, via))) continue;
        items.push(view<WorkingNoteBody>(aggregate));
        if (items.length >= query.limit) return { items, next: aggregate.id };
      }
      if (page.length < 500) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }

  /** Promotion requests: the agent sees its own, the owner sees all. Oldest first. Without `noteId` this scans the first 4,000 requests of the installation only. */
  async promotions(principal: Principal, query: { noteId?: string } = {}): Promise<View<NotePromotionBody>[]> {
    const noteId = query.noteId === undefined ? undefined : noteIdOf(query.noteId);
    const out: View<NotePromotionBody>[] = [];
    const mayRead = (b: NotePromotionBody): boolean => principal.kind === "owner" || (b.requestedBy === principal.id && inTaskScope(principal, b.projectId));
    if (noteId !== undefined) {
      // A note's requests are found directly (at most NOTE_LIMITS.promotions of them).
      for (let n = 1; n <= NOTE_LIMITS.promotions; n++) {
        const found = await this.#runner.get("working-note-promotion", promotionIdOf(noteId, n));
        if (found === undefined) break;
        if (mayRead(found.body as unknown as NotePromotionBody)) out.push(view<NotePromotionBody>(found));
      }
      return out;
    }
    let after: string | undefined;
    for (let reads = 0; reads < 20; reads++) {
      const page = await this.#runner.list("working-note-promotion", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id;
        const b = a.body as unknown as NotePromotionBody;
        if (!mayRead(b)) continue;
        out.push(view<NotePromotionBody>(a));
      }
      if (page.length < 200) break;
    }
    return out;
  }

  /** Deletion records, for the owner. */
  async deletions(owner: Principal): Promise<View<NoteDeletionBody>[]> {
    this.#owner(owner, "reads the deletion records");
    const out: View<NoteDeletionBody>[] = [];
    let after: string | undefined;
    for (let reads = 0; reads < 20; reads++) {
      const page = await this.#runner.list("working-note-deletion", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) { after = a.id; out.push(view<NoteDeletionBody>(a)); }
      if (page.length < 200) break;
    }
    return out;
  }

  /** Reading rules. The owner reads everything; the agent reads its own; a private note stops there. A shared note also goes to `desk.read` holders in its project and to a chair there; for another project only along an open path. */
  async #readable(principal: Principal, note: WorkingNoteBody, via: string | undefined): Promise<boolean> {
    if (principal.kind === "owner") return true;
    if (note.deleted !== undefined) return false;
    if (note.owner === principal.id && inTaskScope(principal, note.projectId)) return true;
    if (note.visibility !== "shared") return false;
    const member = (project: string): boolean => allows(principal, "desk.read", project) || allowsExactly(principal, "notes.chair.read", project);
    if (via === undefined || via === note.projectId) return member(note.projectId);
    return member(via) && (await this.#paths.isOpen(note.projectId, via));
  }

  #owner(p: Principal, what: string): void { if (p.kind !== "owner") throw new DomainError("forbidden", `${p.id} is not the owner; only the owner ${what} agents' shared notes`); }

  /** Stale check and revision ceiling. The agent's text revisions stop at `revisions`; marking private and owner corrections go on to the hard ceiling, which also bounds delete and `versions`. */
  #staleOrFull(actual: number, expected: number, id: string, ceiling?: number): void {
    if (actual !== expected) throw new DomainError("stale_revision", `note ${id} is at revision ${actual}, not ${expected}`, { currentRevision: actual });
    if (ceiling === undefined || actual < ceiling) return;
    throw new DomainError("invalid_command", ceiling === HARD_CEILING
      ? `a note keeps at most ${HARD_CEILING} revisions in all; delete it or have the agent write a new note that carries on from it`
      : `a note keeps at most ${NOTE_LIMITS.revisions} revisions of text; write a new note that carries on from it`, { field: "noteId" });
  }

  #version(id: string, revision: number, note: WorkingNoteBody, correction: boolean): import("../storage/types.js").Change {
    const body: NoteVersionBody = { noteId: id, noteRevision: revision, author: note.author, correction, at: note.updatedAt, visibility: note.visibility, title: note.title, body: note.body, ...(note.reason === undefined ? {} : { reason: note.reason }) };
    return { type: "create", ref: { kind: "working-note-version", id: `${id}.${revision}` }, body: body as unknown as JsonObject };
  }

  #next(id: string, revision: number, current: WorkingNoteBody, author: string, change: Partial<Pick<WorkingNoteBody, "title" | "body" | "reason" | "visibility">>, correction: boolean, what: string) {
    const next: WorkingNoteBody = { ...current, ...change, author, updatedAt: this.#runner.now() };
    const ref: AggregateRef = { kind: "working-note", id };
    return { ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: revision, body: next as unknown as JsonObject }, this.#version(id, revision + 1, next, correction)], detail: { what, revision: revision + 1 } };
  }
}

import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { DomainError } from "./errors.js";
import { derivedId } from "./ids.js";
import { onlyKnown, revision as checkRevision, text, type View } from "./model.js";
import { CommandRunner, view, type CommandMeta, type CommandResult, type RunnerOptions } from "./runner.js";

/**
 * Why work is stopped and who can restart it (cards S07, S08). A blocker is a visible, durable record, never a log line:
 * - `manual_hold`: a person said "do not touch this" (a task, an effect, a message). Automatic repair never clears or works around it.
 * - `delivery_exhausted`: a message failed its allowed number of deliveries and is held until someone looks.
 * - `effect_uncertain`: an effect may or may not have happened (card S05).
 * - `wait_overdue`: a typed wait passed its deadline (card S08).
 * - `scan_failure`: a repair scan could not process one item for a reason retrying will not fix (a malformed record); the item is skipped until a person looks.
 * - `unexplained_block`: a task is blocked and nothing says why or what happens next (card S08).
 */
export type BlockerType = "manual_hold" | "delivery_exhausted" | "effect_uncertain" | "wait_overdue" | "scan_failure" | "unexplained_block";
export const BLOCKER_TYPES: readonly BlockerType[] = ["manual_hold", "delivery_exhausted", "effect_uncertain", "wait_overdue", "scan_failure", "unexplained_block"];

export interface BlockerBody {
  readonly type: BlockerType;
  /** The thing that is stopped: for example `{ kind: "task", id }` or `{ kind: "delivery", id }`. */
  readonly subject: AggregateRef;
  readonly summary: string;
  /** Who can resolve it (a role or principal name), so a blocker always says whom it is waiting for. */
  readonly resolver: string;
  readonly state: "open" | "resolved";
  readonly openedBy: string;
  readonly openedAt: string;
  /** When someone should look again. */
  readonly nextReviewAt?: string;
  readonly resolution?: string;
  readonly resolvedBy?: string;
}

/** One slot per (type, subject): remembers how many blockers it has had and which one is open, so "is this held?" is a single read. */
interface SlotBody { readonly type: BlockerType; readonly subject: AggregateRef; readonly count: number; readonly openId?: string }

export interface OpenBlocker extends CommandMeta {
  readonly type: BlockerType;
  readonly subject: AggregateRef;
  readonly summary: string;
  readonly resolver: string;
  readonly nextReviewAt?: string;
}
export interface ResolveBlocker extends CommandMeta { readonly blockerId: string; readonly expectedRevision: number; readonly resolution: string }

export const BLOCKER_LIMITS = { summary: 1000, resolver: 120, resolution: 1000 } as const;
const BLOCKER_ID = /^blk-[a-z2-7]{20}$/;
const SUBJECT_KIND = /^[a-z][a-z0-9-]{0,39}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const slotId = (type: BlockerType, subject: AggregateRef): string => derivedId("slot", `${type}\0${subject.kind}\0${subject.id}`);
const blockerIdFor = (type: BlockerType, subject: AggregateRef, n: number): string => derivedId("blk", `${type}\0${subject.kind}\0${subject.id}\0${n}`);

export function subjectRef(value: unknown, field = "subject"): AggregateRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(field, "must be an object with kind and id");
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (key !== "kind" && key !== "id") invalid(`${field}.${key}`, "is not a subject field");
  const kind = typeof entry["kind"] === "string" && SUBJECT_KIND.test(entry["kind"]) ? entry["kind"] : invalid(`${field}.kind`, "must be lower-case words joined by hyphens");
  return { kind, id: text(entry["id"], `${field}.id`, { min: 1, max: 200 }) };
}

/**
 * Blockers (card S07). Opening one is idempotent per subject: asking again while one is open returns it, so a repair scan that finds the
 * same trouble every pass opens exactly one blocker. Only `resolveBlocker` closes one, and only a caller does that: nothing in the
 * automatic repair path resolves, edits or works around an open blocker.
 */
export class BlockerService {
  readonly #runner: CommandRunner;

  private constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): BlockerService {
    return new BlockerService(new CommandRunner(storage, epoch, options));
  }

  get epoch(): number { return this.#runner.epoch; }

  /** Opens a blocker, or returns the one already open for this type and subject (`replayed: true`). */
  openBlocker(command: OpenBlocker): Promise<CommandResult> {
    return this.#runner.command("blocker.open", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "type", "subject", "summary", "resolver", "nextReviewAt"]);
      const type = (BLOCKER_TYPES as readonly string[]).includes(command.type) ? command.type : invalid("type", `must be one of ${BLOCKER_TYPES.join(", ")}`);
      const subject = subjectRef(command.subject);
      const summary = text(command.summary, "summary", { min: 1, max: BLOCKER_LIMITS.summary, multiline: true });
      const resolver = text(command.resolver, "resolver", { min: 1, max: BLOCKER_LIMITS.resolver });
      const review = command.nextReviewAt === undefined ? undefined : typeof command.nextReviewAt === "string" && TIMESTAMP.test(command.nextReviewAt) ? command.nextReviewAt : invalid("nextReviewAt", "must be a UTC timestamp such as 2026-10-20T12:00:00.000Z");
      return {
        payload: { type, subject: subject as unknown as JsonObject, summary, resolver, ...(review === undefined ? {} : { nextReviewAt: review }) },
        build: async () => {
          const slotRef: AggregateRef = { kind: "blocker-slot", id: slotId(type, subject) };
          const slot = await this.#runner.get(slotRef.kind, slotRef.id);
          const body = slot?.body as unknown as SlotBody | undefined;
          if (body?.openId !== undefined) {
            // Already open: answer with it. The command writes nothing but must still name a record, so it checks the slot.
            const open = await this.#runner.get("blocker", body.openId);
            if (open !== undefined) return { ref: { kind: "blocker", id: body.openId }, creates: false, changes: [{ type: "check", ref: { kind: "blocker", id: body.openId }, expectedRevision: open.revision }], detail: { type, existing: true } };
          }
          const n = (body?.count ?? 0) + 1;
          const id = blockerIdFor(type, subject, n);
          const ref: AggregateRef = { kind: "blocker", id };
          const blocker: BlockerBody = { type, subject, summary, resolver, state: "open", openedBy: meta.actor, openedAt: this.#runner.now(), ...(review === undefined ? {} : { nextReviewAt: review }) };
          const nextSlot: SlotBody = { type, subject, count: n, openId: id };
          return {
            ref, creates: true,
            changes: [{ type: "create", ref, body: blocker as unknown as JsonObject }, slot === undefined ? { type: "create", ref: slotRef, body: nextSlot as unknown as JsonObject } : { type: "update", ref: slotRef, expectedRevision: slot.revision, body: nextSlot as unknown as JsonObject }],
            detail: { type, subject: subject as unknown as JsonObject, resolver },
            contention: async () => new DomainError("stale_revision", `a blocker for ${type} on ${subject.kind} ${subject.id} was opened meanwhile; ask again`),
          };
        },
      };
    });
  }

  resolveBlocker(command: ResolveBlocker): Promise<CommandResult> {
    return this.#runner.command("blocker.resolve", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "blockerId", "expectedRevision", "resolution"]);
      const id = typeof command.blockerId === "string" && BLOCKER_ID.test(command.blockerId) ? command.blockerId : invalid("blockerId", "is not a blocker ID");
      const expected = checkRevision(command.expectedRevision);
      const resolution = text(command.resolution, "resolution", { min: 1, max: BLOCKER_LIMITS.resolution, multiline: true });
      return {
        payload: { blockerId: id, expectedRevision: expected, resolution },
        build: async () => {
          const current = await this.#runner.existing("blocker", id, expected);
          const body = current.body as unknown as BlockerBody;
          if (body.state !== "open") throw new DomainError("invalid_command", `blocker ${id} is already resolved`, { field: "blockerId" });
          const slotRef: AggregateRef = { kind: "blocker-slot", id: slotId(body.type, body.subject) };
          const slot = await this.#runner.get(slotRef.kind, slotRef.id);
          if (slot === undefined) throw new DomainError("integrity", `blocker ${id} has no slot`);
          const { openId, ...rest } = slot.body as unknown as SlotBody;
          if (openId !== id) throw new DomainError("integrity", `blocker ${id} is open but its slot names ${openId ?? "no blocker"}`);
          const ref: AggregateRef = { kind: "blocker", id };
          const next: BlockerBody = { ...body, state: "resolved", resolution, resolvedBy: meta.actor };
          return {
            ref, creates: false,
            changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }, { type: "update", ref: slotRef, expectedRevision: slot.revision, body: rest as unknown as JsonObject }],
            detail: { type: body.type, subject: body.subject as unknown as JsonObject },
          };
        },
      };
    });
  }

  async getBlocker(id: string): Promise<View<BlockerBody> | undefined> {
    const found = await this.#runner.get("blocker", typeof id === "string" && BLOCKER_ID.test(id) ? id : invalid("blockerId", "is not a blocker ID"));
    return found === undefined ? undefined : view<BlockerBody>(found);
  }

  /** How many blockers of this type this subject has had so far (open or resolved). The next one is this plus 1; callers use it to give each occurrence its own command ID. */
  async occurrences(type: BlockerType, subject: AggregateRef): Promise<number> {
    const slot = await this.#runner.get("blocker-slot", slotId(type, subjectRef(subject)));
    return (slot?.body as unknown as SlotBody | undefined)?.count ?? 0;
  }

  /** The open blocker of this type on this subject, if any: one read. */
  async openFor(type: BlockerType, subject: AggregateRef): Promise<View<BlockerBody> | undefined> {
    const slot = await this.#runner.get("blocker-slot", slotId(type, subjectRef(subject)));
    const openId = (slot?.body as unknown as SlotBody | undefined)?.openId;
    if (openId === undefined) return undefined;
    const found = await this.#runner.get("blocker", openId);
    return found === undefined ? undefined : view<BlockerBody>(found);
  }

  /** Blockers in ID order after `afterId`, optionally only open ones (pages are scanned, so a page may hold fewer than `limit`). */
  async list(query: { afterId?: string; limit: number; openOnly?: boolean }): Promise<{ items: View<BlockerBody>[]; next?: string }> {
    const items: View<BlockerBody>[] = [];
    let after = query.afterId;
    for (let reads = 0; reads < 20; reads++) {
      const page = await this.#runner.list("blocker", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const aggregate of page) {
        after = aggregate.id;
        if (query.openOnly === true && (aggregate.body as unknown as BlockerBody).state !== "open") continue;
        items.push(view<BlockerBody>(aggregate));
        if (items.length >= query.limit) return { items, next: aggregate.id };
      }
      if (page.length < 500) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }
}

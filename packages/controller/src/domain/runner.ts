import { setTimeout as sleep } from "node:timers/promises";
import { commitOperation } from "../storage/commit.js";
import { isStorageError } from "../storage/errors.js";
import { canonicalJson, sha256 } from "../storage/json.js";
import type { Aggregate, AggregateRef, AuditEntry, Change, ControllerStorage, EffectEntry, JsonObject, OperationInput, OperationResult, OutboxEntry, TimerEntry } from "../storage/types.js";
import { DomainError } from "./errors.js";
import { operationIdOf } from "./ids.js";
import { actor as checkActor, commandId as checkCommandId, type View } from "./model.js";

/** Who is asking and which command this is. The command ID is the idempotency key: the same command may be sent any number of times and applies once. */
export interface CommandMeta {
  readonly commandId: string;
  readonly actor: string;
}

export interface CommandResult {
  /** The record the command created or changed. */
  readonly id: string;
  /** Its revision after the command. A repeated command returns the revision the first application produced. */
  readonly revision: number;
  /** True when this call found the command already applied and returned its recorded result. */
  readonly replayed: boolean;
}

export interface RunnerOptions {
  /** The time recorded with each command. Never compared; tests may fix it. */
  readonly clock?: () => string;
  /** Total storage attempts for one command, including the first (contention is retried; the command applies once). Default 5. */
  readonly attempts?: number;
  /** Pause before a retry. Default: a short jittered backoff. */
  readonly pause?: (attempt: number) => Promise<void>;
}

/** What a command resolved to: the record it targets, whether it creates it, and the storage changes and audit detail that do it. */
export interface Built {
  readonly ref: AggregateRef;
  readonly creates: boolean;
  readonly changes: readonly Change[];
  readonly detail: JsonObject;
  /**
   * What the command also commits in the same transaction (all optional): messages for other parts of the system (card S03), effect
   * intentions (S05), timers, and extra audit entries after the command's own. They are part of the command's digest only through its
   * payload, so a builder must derive them deterministically from the command and the state it saw.
   */
  readonly outbox?: readonly OutboxEntry[];
  readonly effects?: readonly EffectEntry[];
  readonly timers?: readonly TimerEntry[];
  readonly audit?: readonly AuditEntry[];
}

/** The same object without its undefined fields (an absent optional field is omitted, never stored as undefined). */
export const defined = <T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * The machinery every domain service shares (cards S01 and S06; later services use it too): one command is one storage operation named by
 * its command ID, a repeat is recognised by the digest kept in the command's audit entry and answered with the recorded result,
 * a command ID reused for a different command is `command_conflict`, and storage failures are reported in the domain's terms.
 */
export class CommandRunner {
  readonly storage: ControllerStorage;
  readonly epoch: number;
  readonly #clock: () => string;
  readonly #attempts: number;
  readonly #pause: (attempt: number) => Promise<void>;

  constructor(storage: ControllerStorage, epoch: number, options: RunnerOptions) {
    this.storage = storage;
    this.epoch = epoch;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#attempts = options.attempts ?? 5;
    this.#pause = options.pause ?? ((attempt) => sleep(Math.round(Math.random() * Math.min(200, 10 * 2 ** attempt))));
  }

  /** Takes a new primary epoch and returns a runner that writes under it. */
  static async acquire(storage: ControllerStorage, holder: string, options: RunnerOptions): Promise<CommandRunner> {
    try {
      const { epoch } = await storage.acquireEpoch({ holder, at: (options.clock ?? (() => new Date().toISOString()))() });
      return new CommandRunner(storage, epoch, options);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async get(kind: string, id: string): Promise<Aggregate | undefined> {
    try { return await this.storage.getAggregate({ kind, id }); } catch (error) { throw mapStorageError(error); }
  }

  async list(kind: string, page: { afterId?: string; limit: number }): Promise<Aggregate[]> {
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 1000) throw new DomainError("invalid_command", "limit: must be a whole number from 1 to 1000", { field: "limit" });
    if (page.afterId !== undefined && (typeof page.afterId !== "string" || page.afterId.length > 200)) throw new DomainError("invalid_command", "afterId: must be a record ID", { field: "afterId" });
    try { return await this.storage.listAggregates(kind, { ...(page.afterId === undefined ? {} : { afterId: page.afterId }), limit: page.limit }); } catch (error) { throw mapStorageError(error); }
  }

  /** The record, which must exist and be at `expected`. */
  async existing(kind: string, id: string, expected: number): Promise<Aggregate> {
    const found = await this.get(kind, id);
    if (found === undefined) throw new DomainError("not_found", `${kind} ${id} does not exist`);
    if (found.revision !== expected) throw new DomainError("stale_revision", `${kind} ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
    return found;
  }

  /**
   * Runs one command: validate, recognise a repeat, build the change from current state, commit it as one operation.
   * `prepare` validates and returns the normalised payload (for the command digest) and the builder of the change.
   */
  async command<C extends CommandMeta>(
    type: string, command: C,
    prepare: (meta: CommandMeta) => Promise<{ payload: JsonObject; build: () => Promise<Built> }>,
  ): Promise<CommandResult> {
    if (command === null || typeof command !== "object") throw new DomainError("invalid_command", "a command is an object");
    const meta: CommandMeta = { commandId: checkCommandId(command.commandId), actor: checkActor(command.actor) };
    const { payload, build } = await prepare(meta);
    const operationId = operationIdOf(meta.commandId);
    const digest = sha256(canonicalJson({ v: 1, type, actor: meta.actor, payload }));

    const recorded = await this.#recorded(operationId, digest);
    if (recorded !== undefined) return recorded;

    // A duplicate sent at the same moment as the original can pass the check above before the original commits, and then meet the state
    // the original produced. Whenever this command is about to be refused because of state, look once more for a record of itself: if it
    // has been applied meanwhile, the duplicate is answered with that result instead of an error.
    const refusedUnlessApplied = async (refusal: DomainError): Promise<CommandResult> => (await this.#recorded(operationId, digest)) ?? Promise.reject(refusal);

    let built: Built;
    try {
      built = await build();
    } catch (error) {
      if (error instanceof DomainError) return refusedUnlessApplied(error);
      throw error;
    }
    const input: OperationInput = {
      operationId, epoch: this.epoch, actor: meta.actor, correlationId: operationId, at: this.#clock(),
      changes: built.changes, audit: [{ type, subject: built.ref, detail: { commandDigest: digest, ...built.detail } }, ...(built.audit ?? [])],
      outbox: built.outbox ?? [], effects: built.effects ?? [], timers: built.timers ?? [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
    };
    let result: OperationResult;
    try {
      result = await commitOperation(this.storage, input, { attempts: this.#attempts, pause: this.#pause });
    } catch (error) {
      if (isStorageError(error, "revision_conflict")) {
        if (built.creates) return refusedUnlessApplied(new DomainError("command_conflict", `${built.ref.kind} ${built.ref.id} already exists, so this command ID was used by something else`, { cause: error }));
        const now = await this.get(built.ref.kind, built.ref.id);
        if (now === undefined) throw new DomainError("not_found", `${built.ref.kind} ${built.ref.id} does not exist`, { cause: error });
        return refusedUnlessApplied(new DomainError("stale_revision", `${built.ref.kind} ${built.ref.id} changed meanwhile and is now at revision ${now.revision}`, { currentRevision: now.revision, cause: error }));
      }
      throw mapStorageError(error);
    }
    return { id: built.ref.id, revision: revisionOf(result, built.ref), replayed: result.replayed };
  }

  /** The recorded result if this command already applied; `command_conflict` if the command ID was used for a different command. */
  async #recorded(operationId: string, digest: string): Promise<CommandResult | undefined> {
    try {
      const stored = await this.storage.getOperation(operationId);
      if (stored === undefined) return undefined;
      const seq = stored.result.auditSeqs[0];
      const audit = seq === undefined ? undefined : (await this.storage.listAudit({ afterSeq: seq - 1, limit: 1 }))[0];
      if (audit === undefined || audit.seq !== seq || audit.operationId !== operationId || audit.subject === undefined) {
        throw new DomainError("command_conflict", `command ID ${operationId.slice(4)} belongs to an operation that is not a project command`);
      }
      if (audit.detail["commandDigest"] !== digest) throw new DomainError("command_conflict", `command ID ${operationId.slice(4)} was already used for a different command`);
      return { id: audit.subject.id, revision: revisionOf(stored.result, audit.subject), replayed: true };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStorageError(error);
    }
  }
}

export function revisionOf(result: OperationResult, ref: AggregateRef): number {
  const found = result.revisions.find((r) => r.ref.kind === ref.kind && r.ref.id === ref.id);
  if (found === undefined) throw new DomainError("unavailable", `storage did not report a revision for ${ref.kind} ${ref.id}`);
  return found.revision;
}

export function view<B>(aggregate: Aggregate): View<B> {
  return { ...(aggregate.body as unknown as B), id: aggregate.id, revision: aggregate.revision, createdAt: aggregate.createdAt, updatedAt: aggregate.updatedAt };
}

/** Storage failures that no command-specific rule explains, in the domain's terms. */
export function mapStorageError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (isStorageError(error, "stale_epoch")) return new DomainError("stale_epoch", "this controller is no longer the primary", { cause: error });
  if (isStorageError(error, "idempotency_conflict")) return new DomainError("command_conflict", "this command ID was already used for a different command", { cause: error });
  if (isStorageError(error, "not_found")) return new DomainError("not_found", error instanceof Error ? error.message : "not found", { cause: error });
  if (isStorageError(error, "invalid_input")) return new DomainError("invalid_command", error instanceof Error ? error.message : "invalid command", { ...(error.path === undefined ? {} : { field: error.path }), cause: error });
  return new DomainError("unavailable", error instanceof Error ? `storage could not complete the request: ${error.message}` : "storage could not complete the request", { cause: error });
}

import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "../storage/json.js";
import type { AggregateRef, Change, ControllerStorage, EffectRecord, JsonObject } from "../storage/types.js";
import type { AssignmentService } from "./assignments.js";
import { DomainError, isDomainError } from "./errors.js";
import { derivedId } from "./ids.js";
import { fence as checkFence, type Fence } from "./assignment-model.js";
import { onlyKnown, taskId as checkTaskId, text, type View } from "./model.js";
import { CommandRunner, defined, mapStorageError, view, type CommandMeta, type CommandResult, type RunnerOptions } from "./runner.js";

/** What a bridge is asked to do. `key` is the external idempotency key: stable for the effect, derived from its ID. */
export interface EffectRequest {
  readonly effectId: string;
  readonly key: string;
  readonly kind: string;
  readonly target: string;
  readonly input: JsonObject;
}

/** Thrown by a bridge that knows the effect was **not** applied (the target refused it). Anything else it throws means the outcome is unknown. */
export class EffectRejected extends Error {
  constructor(message: string, readonly evidence: JsonObject = {}) {
    super(message);
    this.name = "EffectRejected";
  }
}

export interface Reconciliation {
  readonly state: "applied" | "not_applied" | "unknown";
  readonly evidence?: JsonObject;
}

/**
 * The only way an effect on the outside world is performed (card S05). A bridge declares what it can promise:
 * - `idempotent`: the target honours `request.key`, so executing again with the same key applies at most once;
 * - `reconcile`: the target can be asked whether the key was applied.
 * A bridge with neither is **unsupported**: after any doubt its effect becomes `uncertain` and is never retried blindly.
 */
export interface EffectBridge {
  readonly idempotent: boolean;
  execute(request: EffectRequest): Promise<JsonObject>;
  reconcile?(request: EffectRequest): Promise<Reconciliation>;
}

export interface EffectBody {
  readonly kind: string;
  readonly target: string;
  readonly input: JsonObject;
  readonly inputDigest: string;
  /** The external idempotency key. */
  readonly key: string;
  readonly createdBy: string;
  readonly taskId?: string;
  /** If the effect is performed on an attempt's behalf, the fence it carries. */
  readonly fence?: Fence;
  /** True once an executor has started it: from then on the external effect may have happened. */
  readonly started: boolean;
  /** The executor currently allowed to act, until `until`. */
  readonly claim?: { readonly holder: string; readonly until: string };
}

export type EffectStatus = EffectRecord["status"];
export interface EffectOutcome {
  readonly effectId: string;
  /** `pending`: the outcome is not known yet and a retry is safe (the target is idempotent); nothing is final. */
  readonly status: EffectStatus | "pending";
  readonly evidence?: JsonObject;
  readonly note?: string;
}

export interface IntendEffect extends CommandMeta {
  readonly kind: string;
  readonly target: string;
  readonly input: JsonObject;
  /** Required with `fence`. */
  readonly taskId?: string;
  readonly fence?: Fence;
}
export interface ResolveEffect extends CommandMeta {
  readonly effectId: string;
  readonly outcome: "confirmed" | "failed";
  readonly evidence: JsonObject;
}

export const EFFECT_LIMITS = { kind: 40, target: 500, inputBytes: 64 * 1024, lease: 5 * 60_000 } as const;
const EFFECT_ID = /^eff-[a-z2-7]{20}$/;
const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const EFFECTS_ACTOR = "effects";

/** Options of one `run`. */
export interface RunOptions {
  /** Called before an effect that has not started is claimed. Throws to refuse; returns guard changes that commit with the claim (a lost race on one repeats the check). */
  readonly beforeStart?: () => Promise<readonly Change[]>;
}

export interface EffectServiceOptions extends RunnerOptions {
  /** How long an executor holds an effect before another may take it over. Default five minutes; must exceed the bridge's worst case. */
  readonly leaseMs?: number;
  /** Names this executor in claims. */
  readonly holder?: string;
}

/**
 * The effect ledger and idempotent bridge (card S05).
 *
 * 1. **Intent first.** `intend` records, in one transaction, the effect's storage row (target, input digest, external key) and its full
 *    input, before anything is done. If the attempt's fence is given it is checked in that transaction.
 * 2. **Execute under a claim.** `run` claims the effect (a revision-guarded write, with a lease), then calls the bridge with the effect's
 *    stable key, then records the result. A crash after the external success and before the result is saved leaves the effect `intended`
 *    and started: the next `run` does not execute blindly, it recovers.
 * 3. **Recovery.** A started effect is reconciled with the target if the bridge can be asked; else re-executed with the same key if the
 *    bridge is idempotent; else it becomes `uncertain`, and every later `run` is refused (`effect_uncertain`) until a person resolves it
 *    (`resolve`). So the protected effect happens once, or the system stops and says it does not know.
 * 4. **Fencing.** If the attempt that wanted the effect has lost its generation before the effect started, it never starts (`failed`,
 *    superseded). If it was lost after it started, recovery only asks the target; it never starts the effect again.
 */
export class EffectService {
  readonly #runner: CommandRunner;
  readonly #assignments: AssignmentService | undefined;
  readonly #leaseMs: number;
  readonly #holder: string;
  /** Effects this instance is executing right now: a second `run` of one is refused, whatever the stored claim says. */
  readonly #running = new Set<string>();

  private constructor(runner: CommandRunner, assignments: AssignmentService | undefined, options: EffectServiceOptions) {
    this.#runner = runner;
    this.#assignments = assignments;
    this.#leaseMs = options.leaseMs ?? EFFECT_LIMITS.lease;
    this.#holder = options.holder ?? `executor-${randomUUID()}`;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, assignments: AssignmentService | undefined, options: EffectServiceOptions = {}): EffectService {
    if (assignments !== undefined && assignments.epoch !== epoch) throw new DomainError("invalid_command", "epoch: must be the epoch the assignment service writes under", { field: "epoch" });
    return new EffectService(new CommandRunner(storage, epoch, options), assignments, options);
  }

  /** Records the intent. Repeating the command returns the same effect. */
  intend(command: IntendEffect): Promise<CommandResult> {
    return this.#runner.command("effect.intend", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "kind", "target", "input", "taskId", "fence"]);
      const kind = typeof command.kind === "string" && KIND.test(command.kind) ? command.kind : invalid("kind", "must be 1 to 40 lower-case letters, digits or hyphens, starting with a letter");
      const target = text(command.target, "target", { min: 1, max: EFFECT_LIMITS.target });
      if (command.input === null || typeof command.input !== "object" || Array.isArray(command.input)) invalid("input", "must be a JSON object");
      const canonical = canonicalJson(command.input);
      if (canonical.length > EFFECT_LIMITS.inputBytes) invalid("input", `must be at most ${EFFECT_LIMITS.inputBytes} characters`);
      const fence = command.fence === undefined ? undefined : checkFence(command.fence);
      const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
      if (fence !== undefined && taskId === undefined) invalid("taskId", "is required with a fence");
      if (fence !== undefined && this.#assignments === undefined) invalid("fence", "cannot be checked: this service has no assignment service");
      const inputDigest = sha256(canonical);
      return {
        payload: defined({ kind, target, inputDigest, taskId, fence: fence as unknown as JsonObject | undefined }),
        build: async () => {
          const effectId = derivedId("eff", meta.commandId);
          const ref: AggregateRef = { kind: "effect", id: effectId };
          const guard = fence === undefined ? undefined : await this.#assignments!.guardFor(fence).check(taskId!);
          const body: EffectBody = { kind, target, input: command.input, inputDigest, key: effectId, createdBy: meta.actor, ...(taskId === undefined ? {} : { taskId }), ...(fence === undefined ? {} : { fence }), started: false };
          return {
            ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }, ...(guard?.changes ?? [])],
            detail: { kind, target, inputDigest, ...(guard?.detail ?? {}) },
            effects: [{ effectId, ...(fence === undefined ? {} : { attemptId: fence.attemptId }), target, inputDigest, reconciliationHandle: effectId }],
          };
        },
      };
    });
  }

  /** Records the intent and runs it. */
  async perform(command: IntendEffect, bridge: EffectBridge): Promise<EffectOutcome> {
    const intent = await this.intend(command);
    return this.run(intent.id, bridge);
  }

  /**
   * Does what is needed to bring the effect to a final state, once and safely (see the class description). Returns the final status, or
   * `pending` when the target is idempotent and the outcome is not known yet (call again). Throws `effect_uncertain` for an uncertain
   * effect and `effect_busy` while another executor holds it.
   */
  async run(effectId: string, bridge: EffectBridge, options: RunOptions = {}): Promise<EffectOutcome> {
    if (typeof effectId !== "string" || !EFFECT_ID.test(effectId)) invalid("effectId", "is not an effect ID");
    if (this.#running.has(effectId)) throw new DomainError("effect_busy", `effect ${effectId} is already being run by this executor`, { field: "effectId" });
    this.#running.add(effectId);
    try {
      return await this.#runLoop(effectId, bridge, options);
    } finally {
      this.#running.delete(effectId);
    }
  }

  async #runLoop(effectId: string, bridge: EffectBridge, options: RunOptions): Promise<EffectOutcome> {
    for (let tries = 0; tries < 5; tries++) {
      const { aggregate, record } = await this.#load(effectId);
      if (record.status === "confirmed" || record.status === "failed") return { effectId, status: record.status, ...(record.evidence === undefined ? {} : { evidence: record.evidence }) };
      if (record.status === "uncertain") throw new DomainError("effect_uncertain", `effect ${effectId} (${record.target}) may or may not have happened and cannot be retried blindly; check the target and resolve it`, { field: "effectId" });
      const body = aggregate.body as unknown as EffectBody;
      const now = Date.parse(this.#runner.now());
      // Any unexpired claim is a busy effect, this executor's own included: a claim that was not released belongs to a run that may still be in
      // flight (or to a process that died and has to wait out its lease).
      if (body.claim !== undefined && Date.parse(body.claim.until) > now) throw new DomainError("effect_busy", `effect ${effectId} is being handled by ${body.claim.holder} until ${body.claim.until}`, { field: "effectId" });
      const abandoned = body.claim !== undefined;

      // Fence: before the effect started, an attempt that lost its generation never starts it.
      let fenceLost = false;
      let guardChanges: readonly Change[] = [];
      if (body.fence !== undefined && body.taskId !== undefined && this.#assignments !== undefined) {
        try { guardChanges = (await this.#assignments.guardFor(body.fence).check(body.taskId)).changes; } catch (error) {
          if (!isDomainError(error, "fenced")) throw error;
          fenceLost = true;
        }
      }
      if (fenceLost && !body.started) return this.#settle(effectId, aggregate, "failed", { reason: "superseded before it started", fence: body.fence as unknown as JsonObject });
      // A caller's own gate on starting (card L05: a pause or an interruption blocks effects that have not started). It may refuse by throwing; the checks it returns commit with the claim, so
      // a change it saw cannot slip in between. It is not consulted for an effect that already started: that one is only ever reconciled.
      if (!body.started && options.beforeStart !== undefined) guardChanges = [...guardChanges, ...(await options.beforeStart())];

      // Claim (revision-guarded, with the fence as a guard so the claim is atomic with ownership).
      try {
        await this.#claim(effectId, aggregate, body, guardChanges, now);
      } catch (error) {
        if (isDomainError(error, "stale_revision") || isDomainError(error, "fenced")) continue;
        throw error;
      }
      const request: EffectRequest = { effectId, key: body.key, kind: body.kind, target: body.target, input: body.input };

      try {
        const outcome = !body.started && !fenceLost ? await this.#execute(request, bridge) : await this.#recover(request, bridge, fenceLost, !abandoned);
        if (outcome.status === "pending") await this.#release(effectId);
        return outcome;
      } catch (error) {
        await this.#release(effectId);
        throw error;
      }
    }
    throw new DomainError("unavailable", `effect ${effectId} could not be claimed: it kept changing`);
  }

  /** A person's decision on an uncertain effect, after checking the target. */
  resolve(command: ResolveEffect): Promise<CommandResult> {
    return this.#runner.command("effect.resolve", command, async () => {
      onlyKnown(command, ["commandId", "actor", "effectId", "outcome", "evidence"]);
      const effectId = typeof command.effectId === "string" && EFFECT_ID.test(command.effectId) ? command.effectId : invalid("effectId", "is not an effect ID");
      if (command.outcome !== "confirmed" && command.outcome !== "failed") invalid("outcome", "must be confirmed or failed");
      if (command.evidence === null || typeof command.evidence !== "object" || Array.isArray(command.evidence) || Object.keys(command.evidence).length === 0) invalid("evidence", "must be a non-empty JSON object saying how the target was checked");
      return {
        payload: { effectId, outcome: command.outcome, evidence: command.evidence },
        build: async () => {
          const { aggregate, record } = await this.#load(effectId);
          if (record.status !== "uncertain") throw new DomainError("invalid_command", `effect ${effectId} is ${record.status}; only an uncertain effect is resolved by hand`, { field: "effectId" });
          const ref: AggregateRef = { kind: "effect", id: effectId };
          return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: aggregate.revision }], detail: { outcome: command.outcome, resolvedBy: command.actor }, settle: [{ effectId, outcome: command.outcome, evidence: { ...command.evidence, resolvedBy: command.actor } }] };
        },
      };
    });
  }

  async get(effectId: string): Promise<(View<EffectBody> & { readonly status: EffectStatus; readonly evidence?: JsonObject }) | undefined> {
    if (typeof effectId !== "string" || !EFFECT_ID.test(effectId)) invalid("effectId", "is not an effect ID");
    const aggregate = await this.#runner.get("effect", effectId);
    if (aggregate === undefined) return undefined;
    const record = await this.#record(effectId);
    return { ...view<EffectBody>(aggregate), status: record.status, ...(record.evidence === undefined ? {} : { evidence: record.evidence }) };
  }

  // ---- execution -------------------------------------------------------------------------------------------------------------

  /** `tries`: executions made so far in this call plus this one; a call executes at most twice, so a target that keeps failing ends the call as `pending` instead of looping. */
  async #execute(request: EffectRequest, bridge: EffectBridge, tries = 1): Promise<EffectOutcome> {
    let evidence: JsonObject;
    try {
      evidence = await bridge.execute(request);
    } catch (error) {
      if (error instanceof EffectRejected) return this.#settleById(request.effectId, "failed", { reason: error.message, ...error.evidence });
      // The outcome is unknown: it may have been applied. Ask, or retry the same key, or stop.
      return this.#recoverAfterError(request, bridge, error, tries);
    }
    return this.#settleById(request.effectId, "confirmed", evidence);
  }

  async #recoverAfterError(request: EffectRequest, bridge: EffectBridge, cause: unknown, tries: number): Promise<EffectOutcome> {
    if (bridge.reconcile !== undefined) return this.#recover(request, bridge, false, true, tries);
    if (bridge.idempotent) return { effectId: request.effectId, status: "pending", note: `the target did not answer (${cause instanceof Error ? cause.message : String(cause)}); run again to retry with the same key` };
    return this.#settleById(request.effectId, "uncertain", { reason: "the target gave no answer and cannot be asked or retried safely", error: cause instanceof Error ? cause.message : String(cause) });
  }

  /**
   * `trustNotApplied`: whether a target's "not applied" can be believed. It can when the previous run is known to have finished (it released
   * its claim or this very call just saw the attempt fail); it cannot when a previous executor vanished holding the claim, because its
   * request may still be in flight. Then, for a target that does not honour a key, executing again could apply the effect twice.
   */
  async #recover(request: EffectRequest, bridge: EffectBridge, fenceLost: boolean, trustNotApplied: boolean, tries = 1): Promise<EffectOutcome> {
    if (bridge.reconcile !== undefined) {
      let answer: Reconciliation;
      try { answer = await bridge.reconcile(request); } catch (error) {
        return bridge.idempotent && !fenceLost
          ? { effectId: request.effectId, status: "pending", note: `the target could not be asked (${error instanceof Error ? error.message : String(error)}); run again` }
          : this.#settleById(request.effectId, "uncertain", { reason: "the target could not be asked", error: error instanceof Error ? error.message : String(error) });
      }
      if (answer.state === "applied") return this.#settleById(request.effectId, "confirmed", { ...(answer.evidence ?? {}), recovered: true });
      if (answer.state === "not_applied") {
        if (!trustNotApplied && !bridge.idempotent) return this.#settleById(request.effectId, "uncertain", { reason: "an earlier executor vanished holding the effect and the target does not honour a key, so its request may still be in flight", ...(answer.evidence ?? {}) });
        if (fenceLost) return this.#settleById(request.effectId, "failed", { reason: "superseded; the target confirms it never happened", ...(answer.evidence ?? {}) });
        if (tries >= 2) return { effectId: request.effectId, status: "pending", note: "the target keeps failing the request, and says it did not happen; run again later" };
        return this.#execute(request, bridge, tries + 1);
      }
      return this.#settleById(request.effectId, "uncertain", { reason: "the target does not know either", ...(answer.evidence ?? {}) });
    }
    if (bridge.idempotent && !fenceLost) return tries >= 2 ? { effectId: request.effectId, status: "pending", note: "the target keeps failing; run again later" } : this.#execute(request, bridge, tries + 1);
    return this.#settleById(request.effectId, "uncertain", { reason: fenceLost ? "the attempt lost its generation after the effect started and the target cannot be asked" : "the effect started, the target cannot be asked and does not honour a key, so it cannot be retried safely" });
  }

  // ---- records ---------------------------------------------------------------------------------------------------------------

  async #load(effectId: string) {
    const aggregate = await this.#runner.get("effect", effectId);
    if (aggregate === undefined) throw new DomainError("not_found", `effect ${effectId} does not exist`);
    return { aggregate, record: await this.#record(effectId) };
  }

  async #record(effectId: string): Promise<EffectRecord> {
    let record: EffectRecord | undefined;
    try { record = await this.#runner.storage.getEffect(effectId); } catch (error) { throw mapStorageError(error); }
    if (record === undefined) throw new DomainError("integrity", `effect ${effectId} has a record but no ledger row`);
    return record;
  }

  async #claim(effectId: string, aggregate: { revision: number; body: unknown }, body: EffectBody, guardChanges: readonly Change[], now: number): Promise<void> {
    const next: EffectBody = { ...body, started: true, claim: { holder: this.#holder, until: new Date(now + this.#leaseMs).toISOString() } };
    const ref: AggregateRef = { kind: "effect", id: effectId };
    await this.#runner.command("effect.claim", { commandId: `claim:${effectId}:${aggregate.revision}:${this.#holder}`, actor: EFFECTS_ACTOR }, async () => ({
      payload: { effectId, revision: aggregate.revision, holder: this.#holder },
      build: async () => ({ ref, creates: false, changes: [{ type: "update", ref, expectedRevision: aggregate.revision, body: next as unknown as JsonObject }, ...guardChanges], detail: { holder: this.#holder } }),
    }));
  }

  /** Gives the claim back after a run that ended without a result (best effort: if this fails the claim simply expires). */
  async #release(effectId: string): Promise<void> {
    try {
      const aggregate = await this.#runner.get("effect", effectId);
      const body = aggregate?.body as unknown as EffectBody | undefined;
      if (aggregate === undefined || body?.claim === undefined || body.claim.holder !== this.#holder) return;
      const { claim: _claim, ...rest } = body;
      const ref: AggregateRef = { kind: "effect", id: effectId };
      await this.#runner.command("effect.release", { commandId: `release:${effectId}:${aggregate.revision}:${this.#holder}`, actor: EFFECTS_ACTOR }, async () => ({
        payload: { effectId, revision: aggregate.revision, holder: this.#holder },
        build: async () => ({ ref, creates: false, changes: [{ type: "update", ref, expectedRevision: aggregate.revision, body: rest as unknown as JsonObject }], detail: { holder: this.#holder } }),
      }));
    } catch {
      // The claim expires on its own.
    }
  }

  #settleById(effectId: string, outcome: "confirmed" | "failed" | "uncertain", evidence: JsonObject): Promise<EffectOutcome> {
    return this.#load(effectId).then(({ aggregate }) => this.#settle(effectId, aggregate, outcome, evidence));
  }

  /** Records the result: the ledger row moves and the claim is released, in one transaction. A concurrent settlement wins and is returned. */
  async #settle(effectId: string, aggregate: { revision: number; body: unknown }, outcome: "confirmed" | "failed" | "uncertain", evidence: JsonObject): Promise<EffectOutcome> {
    const ref: AggregateRef = { kind: "effect", id: effectId };
    const { claim, ...rest } = aggregate.body as EffectBody;
    const next: EffectBody = rest;
    // A result is recorded only by the executor that still holds the claim (or by anyone for an effect nobody holds, such as one that never started).
    if (claim !== undefined && claim.holder !== this.#holder) {
      return { effectId, status: "pending", note: `the lease on this effect passed to ${claim.holder} while it was being done; the result was not recorded here and that executor will find out what happened` };
    }
    try {
      await this.#runner.command("effect.settle", { commandId: `settle:${effectId}:${outcome}`, actor: EFFECTS_ACTOR }, async () => ({
        payload: { effectId, outcome, evidence },
        build: async () => {
          await this.#runner.existing("effect", effectId, aggregate.revision);
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: aggregate.revision, body: next as unknown as JsonObject }], detail: { outcome }, settle: [{ effectId, outcome, evidence }] };
        },
      }));
    } catch (error) {
      // A concurrent settlement got there first (or contradicts this one): report what the ledger says.
      if (isDomainError(error, "stale_revision") || isDomainError(error, "command_conflict") || isDomainError(error, "unavailable")) {
        const now = await this.#record(effectId);
        if (now.status === "confirmed" || now.status === "failed") {
          if ((outcome === "confirmed" || outcome === "failed") && outcome !== now.status) throw new DomainError("integrity", `effect ${effectId} was recorded as ${now.status} and a result of ${outcome} arrived later`);
          return { effectId, status: now.status, ...(now.evidence === undefined ? {} : { evidence: now.evidence }) };
        }
        if (now.status === "uncertain" && outcome === "uncertain") return { effectId, status: "uncertain", ...(now.evidence === undefined ? {} : { evidence: now.evidence }) };
      }
      throw error;
    }
    return { effectId, status: outcome, evidence };
  }
}

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

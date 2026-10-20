import type { AggregateRef, ControllerStorage, DeliveryClaim, JsonObject } from "../storage/types.js";
import type { BlockerService } from "./blockers.js";
import { DeliveryDispatcher, type DeliveryHandler } from "./delivery.js";
import { DomainError, isDomainError } from "./errors.js";
import { sha256 } from "../storage/json.js";
import { derivedId } from "./ids.js";
import type { EffectBody, EffectBridge, EffectService } from "./effects.js";
import type { InboxMessageBody, InboxService } from "./inbox.js";
import { CommandRunner, mapStorageError, type RunnerOptions } from "./runner.js";
import type { ProjectService } from "./service.js";

/** One destination whose messages the reconciler delivers: where they go. */
export interface Destination {
  readonly name: string;
  readonly handler: DeliveryHandler;
}

export interface ReconcilerDependencies {
  readonly projects: ProjectService;
  readonly inbox: InboxService;
  readonly effects: EffectService;
  readonly blockers: BlockerService;
  readonly destinations: readonly Destination[];
  /** The bridge for each effect kind. An effect of a kind with no bridge is left for a person (it is reported, never guessed at). */
  readonly bridges: Readonly<Record<string, EffectBridge>>;
}

export interface ReconcilerOptions extends RunnerOptions {
  /** Names this reconciler in claims. */
  readonly claimant?: string;
  /** Items looked at per scan per pass; a scan continues from its saved cursor on the next pass. Default 100. */
  readonly pageSize?: number;
  /** Deliveries of one message before it is held and a blocker opened. Default 5. */
  readonly maxDeliveryAttempts?: number;
  /** How long a held delivery waits before its hold is looked at again. Default 5 minutes. */
  readonly holdCheckMs?: number;
  /** Rounds of delivery per destination in one pass (each round delivers what is due). Default 20. */
  readonly deliveryRounds?: number;
  readonly leaseMs?: number;
  readonly backoffMs?: (attempt: number) => number;
}

export interface PassReport {
  /** Task events written for tasks that lacked one for their current revision. */
  readonly eventsRepaired: number;
  /** Messages delivered, by destination. */
  readonly delivered: Readonly<Record<string, number>>;
  /** Deliveries that failed this pass and will be tried again. */
  readonly deliveryFailures: number;
  /** Deliveries not attempted because they are held (exhausted or on hold). */
  readonly deliveriesHeld: number;
  readonly inboxAdmitted: number;
  /** Inbox messages left alone because their task is on a manual hold. */
  readonly inboxHeld: number;
  /** Inbox messages whose task is not ready yet. */
  readonly inboxDeferred: number;
  readonly effectsRun: number;
  readonly effectsHeld: number;
  /** Effects of a kind that has no bridge. */
  readonly effectsUnbridged: number;
  readonly blockersOpened: number;
  /** Items or steps that failed this pass and were skipped so the rest could go on (a record that cannot be processed for a lasting reason also gets a `scan_failure` blocker). */
  readonly errors: number;
  /** True when every scan reached the end of its data in this pass (so the pass saw everything). */
  readonly complete: boolean;
}

interface CursorBody { readonly scan: string; readonly afterId?: string; readonly passes: number }

/** A short stable digest of text that may be long, for command IDs (which are limited to 120 characters and must never collide by truncation). */
const h = (text: string): string => sha256(text).slice(0, 32);
const LASTING = new Set(["integrity", "invalid_command", "not_found", "command_conflict", "payload_changed"]);
const cursorId = (scan: string): string => `cur:${scan}`;

/**
 * Startup and periodic reconciliation (card S07). Nothing here is driven by wake-up signals: every pass reads durable state and does what
 * is pending, so a dropped wake-up, a crash or a restart loses nothing and costs only a delay. No model is involved; each step is a
 * deterministic rule over stored records.
 *
 * A pass: (1) announces tasks whose current revision has no event; (2) delivers due messages to each destination, with bounded retry (a
 * message that keeps failing is held and a visible blocker is opened); (3) admits received inbox messages (leaving alone anything on a
 * manual hold); (4) runs effects that were started and not finished (opening a blocker for an uncertain one). Scans keep a durable cursor
 * and look at a page per pass, wrapping around at the end. Blockers are opened but never resolved here: a person resolves them.
 */
export class Reconciler {
  readonly #runner: CommandRunner;
  readonly #storage: ControllerStorage;
  readonly #deps: ReconcilerDependencies;
  readonly #options: ReconcilerOptions;

  constructor(storage: ControllerStorage, epoch: number, deps: ReconcilerDependencies, options: ReconcilerOptions = {}) {
    this.#storage = storage;
    this.#runner = new CommandRunner(storage, epoch, options);
    this.#deps = deps;
    this.#options = options;
  }

  async runPass(): Promise<PassReport> {
    const report = { eventsRepaired: 0, delivered: {} as Record<string, number>, deliveryFailures: 0, deliveriesHeld: 0, inboxAdmitted: 0, inboxHeld: 0, inboxDeferred: 0, effectsRun: 0, effectsHeld: 0, effectsUnbridged: 0, blockersOpened: 0, errors: 0 };
    let complete = true;
    // Each step stands alone: one that fails (storage trouble, a bad record) is counted and the others still run. Only losing the epoch stops the pass.
    const step = async (run: () => Promise<boolean | void>): Promise<void> => {
      try { if ((await run()) === false) complete = false; } catch (error) {
        if (error instanceof DomainError && error.code === "stale_epoch") throw error;
        report.errors += 1;
        complete = false;
      }
    };
    await step(() => this.#repairTaskEvents(report));
    await step(() => this.#deliver(report));
    await step(() => this.#admitInbox(report));
    await step(() => this.#recoverEffects(report));
    return { ...report, complete };
  }

  // ---- cursors ---------------------------------------------------------------------------------------------------------------

  async #cursor(scan: string): Promise<{ afterId: string | undefined; revision: number | undefined; passes: number }> {
    const found = await this.#runner.get("scan-cursor", cursorId(scan));
    const body = found?.body as unknown as CursorBody | undefined;
    return { afterId: body?.afterId, revision: found?.revision, passes: body?.passes ?? 0 };
  }

  async #saveCursor(scan: string, afterId: string | undefined, before: { revision: number | undefined; passes: number }): Promise<void> {
    const ref: AggregateRef = { kind: "scan-cursor", id: cursorId(scan) };
    const body: CursorBody = { scan, ...(afterId === undefined ? {} : { afterId }), passes: before.passes + 1 };
    await this.#runner.command("scan.cursor", { commandId: `cursor:${scan}:${before.passes + 1}`, actor: this.#options.claimant ?? "reconciler" }, async () => ({
      payload: { scan, passes: body.passes, ...(afterId === undefined ? {} : { afterId }) },
      build: async () => ({
        ref, creates: before.revision === undefined,
        changes: [before.revision === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: before.revision, body: body as unknown as JsonObject }],
        detail: { scan },
      }),
    })).catch((error: unknown) => {
      // Another reconciler moved the cursor first: its position stands; this pass simply does not save its own.
      if (!(isDomainError(error, "stale_revision") || isDomainError(error, "command_conflict"))) throw error;
    });
  }

  // ---- steps -----------------------------------------------------------------------------------------------------------------

  /** A record that cannot be processed for a lasting reason is skipped with a visible blocker; a passing trouble is only counted and tried again next pass. */
  async #flag(subject: { kind: string; id: string }, error: unknown, report: { errors: number; blockersOpened: number }): Promise<void> {
    if (error instanceof DomainError && error.code === "stale_epoch") throw error;
    report.errors += 1;
    const code = error instanceof DomainError ? error.code : "unknown";
    if (!LASTING.has(code)) return;
    if ((await this.#deps.blockers.openFor("scan_failure", subject)) !== undefined) return;
    await this.#deps.blockers.openBlocker({
      commandId: `scanfail:${h(`${subject.kind}\0${subject.id}\0${code}\0${await this.#deps.blockers.occurrences("scan_failure", subject)}`)}`, actor: this.#options.claimant ?? "reconciler", type: "scan_failure", subject, resolver: "owner",
      summary: `Repair could not process ${subject.kind} ${subject.id} (${code}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}). It is skipped until this blocker is resolved.`,
    });
    report.blockersOpened += 1;
  }

  /** Returns whether the scan reached the end. */
  async #repairTaskEvents(report: { eventsRepaired: number; errors: number; blockersOpened: number }): Promise<boolean> {
    const pageSize = this.#options.pageSize ?? 100;
    const cursor = await this.#cursor("task-events");
    const result = await this.#deps.projects.reconcileTaskEvents({ ...(cursor.afterId === undefined ? {} : { afterId: cursor.afterId }), limit: pageSize });
    report.eventsRepaired += result.repaired.length;
    for (const failure of result.failed) await this.#flag({ kind: "task", id: failure.taskId }, new DomainError(failure.code as never, `task ${failure.taskId} could not be announced`), report);
    await this.#saveCursor("task-events", result.next, cursor);
    return result.next === undefined;
  }

  /** Counts a failed handler call (not a claim: a message only found held is not a failure). Idempotent per claim. Returns the failures so far. */
  async #countFailure(deliveryId: string, attempt: number): Promise<number> {
    const ref: AggregateRef = { kind: "delivery-failures", id: derivedId("dfail", deliveryId) };
    await this.#runner.command("delivery.failure", { commandId: `dfail:${h(deliveryId)}:${attempt}`, actor: this.#options.claimant ?? "reconciler" }, async () => ({
      payload: { deliveryId, attempt },
      build: async () => {
        const current = await this.#runner.get(ref.kind, ref.id);
        const count = ((current?.body as unknown as { count?: number } | undefined)?.count ?? 0) + 1;
        const body = { deliveryId, count } as unknown as JsonObject;
        return { ref, creates: current === undefined, changes: [current === undefined ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: current.revision, body }], detail: { deliveryId, count } };
      },
    }));
    return ((await this.#runner.get(ref.kind, ref.id))?.body as unknown as { count: number }).count;
  }

  /** After a person has resolved the blocker that held a message, it starts again with a clean count (otherwise its first new failure would hold it at once). */
  async #clearSpentFailures(deliveryId: string, max: number): Promise<void> {
    const ref: AggregateRef = { kind: "delivery-failures", id: derivedId("dfail", deliveryId) };
    const current = await this.#runner.get(ref.kind, ref.id);
    if (current === undefined || ((current.body as unknown as { count: number }).count) < max) return;
    await this.#runner.command("delivery.failure.reset", { commandId: `dreset:${h(deliveryId)}:${current.revision}`, actor: this.#options.claimant ?? "reconciler" }, async () => ({
      payload: { deliveryId, revision: current.revision },
      build: async () => ({ ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { deliveryId, count: 0 } }], detail: { deliveryId } }),
    })).catch((error: unknown) => { if (!(isDomainError(error, "stale_revision") || isDomainError(error, "command_conflict"))) throw error; });
  }

  async #deliver(report: { delivered: Record<string, number>; deliveryFailures: number; deliveriesHeld: number; blockersOpened: number }): Promise<void> {
    const max = this.#options.maxDeliveryAttempts ?? 5;
    const holdMs = this.#options.holdCheckMs ?? 5 * 60_000;
    for (const destination of this.#deps.destinations) {
      const dispatcher = new DeliveryDispatcher(this.#storage, this.#runner.epoch, {
        destination: destination.name, claimant: this.#options.claimant ?? "reconciler", handler: destination.handler,
        ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
        ...(this.#options.leaseMs === undefined ? {} : { leaseMs: this.#options.leaseMs }),
        ...(this.#options.backoffMs === undefined ? {} : { backoffMs: this.#options.backoffMs }),
        ...(this.#options.pause === undefined ? {} : { pause: this.#options.pause }),
        holdBackoffMs: holdMs,
        isHeld: async (claim) => {
          if ((await this.#deps.blockers.openFor("delivery_exhausted", { kind: "delivery", id: claim.deliveryId })) !== undefined) return true;
          await this.#clearSpentFailures(claim.deliveryId, max);
          return false;
        },
        onFailure: async (claim, reason) => {
          const failures = await this.#countFailure(claim.deliveryId, claim.attempt);
          if (failures < max) return "retry";
          if ((await this.#deps.blockers.openFor("delivery_exhausted", { kind: "delivery", id: claim.deliveryId })) === undefined) {
            await this.#deps.blockers.openBlocker({
              commandId: `exhausted:${h(`${claim.deliveryId}\0${await this.#deps.blockers.occurrences("delivery_exhausted", { kind: "delivery", id: claim.deliveryId })}`)}`, actor: this.#options.claimant ?? "reconciler", type: "delivery_exhausted",
              subject: { kind: "delivery", id: claim.deliveryId }, resolver: "owner",
              summary: `Delivery ${claim.deliveryId} to ${claim.destination} failed ${failures} times (last error: ${reason.slice(0, 300)}). It is held until the blocker is resolved.`,
              nextReviewAt: new Date(Date.parse((this.#options.clock ?? (() => new Date().toISOString()))()) + holdMs).toISOString(),
            });
            report.blockersOpened += 1;
          }
          return "hold";
        },
      });
      for (let round = 0; round < (this.#options.deliveryRounds ?? 20); round++) {
        const result = await dispatcher.runOnce();
        report.delivered[destination.name] = (report.delivered[destination.name] ?? 0) + result.delivered;
        report.deliveryFailures += result.failed;
        report.deliveriesHeld += result.held;
        // Stop when nothing more is due now: a failure is retried after its backoff, in a later pass.
        if (result.delivered === 0) break;
      }
    }
  }

  async #admitInbox(report: { inboxAdmitted: number; inboxHeld: number; inboxDeferred: number; errors: number; blockersOpened: number }): Promise<boolean> {
    const pageSize = this.#options.pageSize ?? 100;
    const cursor = await this.#cursor("inbox");
    const page = await this.#runner.list("inbox-message", { ...(cursor.afterId === undefined ? {} : { afterId: cursor.afterId }), limit: pageSize });
    for (const aggregate of page) {
      const message = aggregate.body as unknown as InboxMessageBody;
      if (message.state !== "received") continue;
      const taskId = (message.payload as { taskId?: unknown }).taskId;
      if (typeof taskId === "string" && (await this.#deps.blockers.openFor("manual_hold", { kind: "task", id: taskId })) !== undefined) { report.inboxHeld += 1; continue; }
      if ((await this.#deps.blockers.openFor("manual_hold", { kind: "inbox-message", id: aggregate.id })) !== undefined) { report.inboxHeld += 1; continue; }
      if ((await this.#deps.blockers.openFor("scan_failure", { kind: "inbox-message", id: aggregate.id })) !== undefined) { report.inboxHeld += 1; continue; }
      try {
        const admission = await this.#deps.inbox.admitAssignment({ commandId: `scan:${aggregate.id}`, actor: this.#options.claimant ?? "reconciler", messageId: aggregate.id });
        if (admission.outcome === "deferred") report.inboxDeferred += 1; else report.inboxAdmitted += 1;
      } catch (error) {
        await this.#flag({ kind: "inbox-message", id: aggregate.id }, error, report);
      }
    }
    const last = page[page.length - 1];
    const more = page.length === pageSize && last !== undefined;
    await this.#saveCursor("inbox", more ? last.id : undefined, cursor);
    return !more;
  }

  async #recoverEffects(report: { effectsRun: number; effectsHeld: number; effectsUnbridged: number; blockersOpened: number; errors: number }): Promise<boolean> {
    const pageSize = this.#options.pageSize ?? 100;
    const cursor = await this.#cursor("effects");
    const page = await this.#runner.list("effect", { ...(cursor.afterId === undefined ? {} : { afterId: cursor.afterId }), limit: pageSize });
    for (const aggregate of page) {
      const body = aggregate.body as unknown as EffectBody;
      let record;
      try { record = await this.#storage.getEffect(aggregate.id); } catch (error) { throw mapStorageError(error); }
      if (record === undefined || record.status === "confirmed" || record.status === "failed") continue;
      if (record.status === "uncertain") {
        if ((await this.#deps.blockers.openFor("effect_uncertain", { kind: "effect", id: aggregate.id })) === undefined) {
          await this.#deps.blockers.openBlocker({
            commandId: `uncertain:${h(`${aggregate.id}\0${await this.#deps.blockers.occurrences("effect_uncertain", { kind: "effect", id: aggregate.id })}`)}`, actor: this.#options.claimant ?? "reconciler", type: "effect_uncertain", subject: { kind: "effect", id: aggregate.id }, resolver: "owner",
            summary: `Effect ${aggregate.id} (${body.kind} on ${body.target}) may or may not have happened and cannot be retried blindly. Check the target, then resolve the effect and this blocker.`,
          });
          report.blockersOpened += 1;
        }
        continue;
      }
      // intended
      if (body.taskId !== undefined && (await this.#deps.blockers.openFor("manual_hold", { kind: "task", id: body.taskId })) !== undefined) { report.effectsHeld += 1; continue; }
      if ((await this.#deps.blockers.openFor("manual_hold", { kind: "effect", id: aggregate.id })) !== undefined) { report.effectsHeld += 1; continue; }
      // Only effects an executor started and did not finish need repair; an effect never started is waiting for its owner's attempt to do it.
      if (!body.started) continue;
      const bridge = this.#deps.bridges[body.kind];
      if (bridge === undefined) { report.effectsUnbridged += 1; continue; }
      try {
        await this.#deps.effects.run(aggregate.id, bridge);
        report.effectsRun += 1;
      } catch (error) {
        // Busy (someone else is on it) and uncertain (reported by a blocker) are expected; anything else is counted, and a lasting one gets a blocker.
        if (error instanceof DomainError && (error.code === "effect_busy" || error.code === "effect_uncertain")) continue;
        await this.#flag({ kind: "effect", id: aggregate.id }, error, report);
      }
    }
    const last = page[page.length - 1];
    const more = page.length === pageSize && last !== undefined;
    await this.#saveCursor("effects", more ? last.id : undefined, cursor);
    return !more;
  }
}

export type { DeliveryClaim };

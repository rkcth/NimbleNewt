import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { PauseScope, PauseService } from "./pause.js";
import { PAUSE_LIMITS } from "./pause.js";
import { assignmentIdOf, generationIdOf, type AssignmentBody } from "../domain/assignment-model.js";

/** `suspend` stops at a durable checkpoint; `stop` goes on to end execution; `force-stop` skips preparation. */
export type StopMode = "suspend" | "stop" | "force-stop";
export type StopPhase = "preparing" | "blocked" | "prepared" | "terminating" | "done" | "recovery-required" | "cancelled";
export const STOP_CHOICES = ["wait", "restart-earlier-boundary", "force-stop"] as const;
export type StopChoice = (typeof STOP_CHOICES)[number];

/** One thing that may still be running for the scope (the inventory covers foreground operations, local processes, T07 jobs and delegated child work). */
export interface InventoryItem { readonly kind: "foreground" | "process" | "job" | "child"; readonly ref: string; /** `tracked`: a permitted remote background job that keeps running through a stop, listed as an exception and not waited for. */ readonly state: "settled" | "tracked" | "running" | "uncooperative" | "unknown" }

/** What the controller asks of the runtime. Every call must be safe to repeat: a restart makes the same call again. */
export interface StopPorts {
  /** What is running for the scope. `lookOnly` asks for a look that remembers and changes nothing (readiness checks). */
  inventory(scope: PauseScope, options?: { lookOnly?: boolean }): Promise<readonly InventoryItem[]>;
  /** Lets go of what preparation froze, when the request is cancelled because the scope was resumed. Best effort. */
  release?(scope: PauseScope): Promise<void>;
  /** A stop or suspension was recorded for the scope: whatever the runtime had in hand for it that a stop must win over (the agent's own ending, card H12n) is dropped now, not when the attempt is finally terminated. Best effort. */
  begin?(scope: PauseScope, options: { force: boolean; by: Principal }): Promise<void>;
  /** Why a stop cannot be done for this scope at all (so it is refused before anything is paused or recorded), or undefined. */
  unsupported?(scope: PauseScope): string | undefined;
  /** Scoped cleanup only (finish or checkpoint what is running, nothing new). `backup` asks for an eligible backup model after the first one was lost. */
  cleanup(scope: PauseScope, options: { deadlineAt: string; spendBudget?: number; backup: boolean; by: Principal }): Promise<{ remaining: readonly InventoryItem[]; spent?: number; modelLost?: boolean; costs?: readonly CleanupCost[] }>;
  /** The checkpoint of the scope's state, and whether it and the artifacts it names are durable. */
  checkpoint(scope: PauseScope, options?: { by: Principal; mode: StopMode; deadlineAt?: string }): Promise<{ checkpointId: string; durable: boolean; artifactsDurable: boolean }>;
  /** Ends execution. `force` skips waiting. `unresolved` names what could not be settled (effects of unknown outcome, children still running). */
  terminate(scope: PauseScope, options: { force: boolean; by: Principal }): Promise<{ ended: boolean; unresolved: readonly string[]; costs?: readonly CleanupCost[] }>;
  /** Charges the cleanup cost of one attempt to the budget of its task (card L02d). Safe to repeat with the same `commandId`; the amounts are what is new since the last charge. Absent: nothing is charged. */
  charge?(charge: { commandId: string; attemptId: string; costMicros: number; computeMs: number }): Promise<void>;
  /** The attempt IDs the runtime has seen for the scope in this stop (so the request can record them and a restart still asks about one that ended during preparation). */
  attempts?(scope: PauseScope): readonly string[];
  /** Gives the runtime the attempt IDs recorded on the request, after a restart lost its memory. */
  remember?(scope: PauseScope, attempts: readonly string[]): void;
}

/** What cleanup (and the ending) has cost for one attempt, as a running total: the stop charges only the part it has not charged yet. */
export interface CleanupCost { readonly attemptId: string; readonly costMicros?: number; readonly computeMs?: number }

export type StopSettled = (by: Principal, event: { intentId: string; scope: PauseScope; mode: StopMode; outcome: StopOutcome }) => Promise<void>;
export interface StopOutcome { readonly state: "suspended" | "stopped" | "recovery-required"; readonly graceful: boolean; readonly unresolved: readonly string[]; readonly at: string }

export interface StopIntentBody {
  readonly scope: PauseScope;
  readonly projectId?: string;
  readonly mode: StopMode;
  readonly phase: StopPhase;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly reason: string;
  readonly deadlineAt: string;
  readonly spendBudget?: number;
  readonly spent: number;
  readonly backupUsed: boolean;
  readonly prepared?: { readonly at: string; readonly checkpointId: string };
  /** Set when the request was made as a Stop after a finished Suspend and went on from that Suspend's checkpoint instead of preparing: the ID of the Suspend. Written once, at creation (the capped history cannot say it reliably). */
  readonly reusedFrom?: string;
  /** Set once the ending of execution (terminate) has run and its cost was billed (a charge that failed leaves the request marked unpaid). */
  readonly ended?: true;
  /**
   * Figures this request's own pass reported but could not record anywhere else (the attempt's note and its wait both lost six races): per attempt the highest one. The sweep charges them and takes each off once it is charged;
   * until then the request counts as unpaid. At most the inventory limit of attempts: a figure for one more attempt is refused (the pass ends with the retryable `stale_revision`), never written over an older one. Records written by older builds have none.
   */
  readonly owed?: readonly { readonly attemptId: string; readonly costMicros: number; readonly computeMs: number }[];
  readonly inventory: readonly InventoryItem[];
  /** The attempts the runtime saw for the scope while preparing (so a process of one that ended meanwhile is still asked about after a restart). */
  readonly attempts?: readonly string[];
  readonly blocked?: { readonly reason: string; readonly choices: readonly StopChoice[]; /** The phase `wait` goes back to. */ readonly resume?: StopPhase } | undefined;
  /** The pause request that held the scope when this request was made: a later stop reuses this request's checkpoint only if the same hold is still in place. */
  readonly gateRequestId?: string;
  readonly outcome?: StopOutcome;
  readonly forced?: { readonly by: string; readonly reason: string; readonly at: string; /** The Force Stop took over a request that began as a Suspend or Stop, whatever phase it had reached (its `spent`, `spendBudget` and `attempts` are from that earlier work). A Force Stop that began as one has no such work. */ readonly afterPreparation?: true };
  readonly history: readonly { readonly phase: StopPhase; readonly at: string; readonly by: string; readonly note: string }[];
}

export const STOP_LIMITS = { reason: 500, deadlineMs: { default: 60_000, max: 3_600_000 }, inventory: 100, history: 60, advances: 8 } as const;
const KIND = "stop-intent";
const ACTIVE = "stop-active";
const FORCE_REF = "stop-force-ref";
/** What has been charged for the cleanup of one attempt, whichever stop request asked (card L02d): one record per attempt, so Suspend then Stop, overlapping task and agent stops, and a stop after a resume never charge twice. */
const CHARGE = "stop-charge";
/** The index of attempts whose charge note was ever pending, with the stop requests waiting on it: a sweep reads this (small) set instead of every charge record, and takes a settled entry off after it has cleared the requests' marks. */
const OPEN = "stop-charge-open";
/** `want` is the highest figure a request reported for the attempt while another request's pending note stood in its way (a running maximum, with the request that raised it); the sweep charges it once that note is paid. */
interface OpenBody { readonly intents: readonly string[]; readonly settled: boolean; readonly want?: { readonly costMicros: number; readonly computeMs: number; readonly intentId: string } }
/** How many requests an open entry lists before the ones that no longer carry the "not charged" mark are dropped. A request that still carries it is never dropped. */
const OPEN_INTENTS = 20;
/** The most the host's figure for one attempt's cleanup is trusted to be: 10^12 micros (a million units of the currency) and 10^12 ms of compute. A larger figure is cut to this. */
export const CLEANUP_CAP = 1_000_000_000_000;
const CLEANUP_UNPAID = "cleanup spend not charged";
interface ChargeBody { readonly costMicros: number; readonly computeMs: number; readonly pending?: { readonly costMicros: number; readonly computeMs: number; readonly commandId: string; readonly intentId: string; readonly counted: boolean } }
/** The refs of host-side "unknown" placeholders: a remote placement (`remote:<attempt>`), or an attempt a local worker forgot (`attempt:<attempt>`). */
const PLACEHOLDER = /^(remote|attempt):/;
const RETRY_PAGES = 20;
/** The attempt IDs a runtime reported a cleanup cost for, those a charge would accept. */
const costAttempts = (costs: readonly CleanupCost[] | undefined): string[] => (costs ?? []).map((c) => c?.attemptId).filter((a): a is string => typeof a === "string" && /^[A-Za-z0-9:_-]{1,120}$/.test(a));
const TERMINAL: readonly StopPhase[] = ["done", "recovery-required", "cancelled"];
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const plain = (value: unknown, field: string): string => {
  const out = text(value, field, { min: 1, max: STOP_LIMITS.reason, multiline: true });
  return redactText(out) !== out ? invalid(field, "looks like a credential or key; those are not recorded") : out;
};
const scopeKey = (scope: PauseScope): string => `${scope.kind}\0${scope.id}`;
const clean = (body: object): JsonObject => JSON.parse(JSON.stringify(body)) as JsonObject;

/**
 * Suspend and graceful Stop (card L02), on top of Pause. A request pauses the scope (ordinary work stops at once), records a durable intent and walks it phase by phase: preparing (inventory, then scoped cleanup inside a
 * deadline and a spend budget), prepared (checkpoint, durable only if the state and its artifacts are), and for Stop, terminating. Each phase is written before its work starts and each port call is repeatable, so a restart
 * (`sweep`) carries on from the phase it was in and reuses a preparation that already finished. What is reported to the pause gate is what was reached: `suspended` only after a durable checkpoint, `stopped` only after
 * execution ended, `recovery-required` otherwise. Time alone claims nothing: a deadline that passes with work still running blocks the intent and offers wait, restart from an earlier boundary, or Force Stop.
 *
 * Stop never resumes work to shut it down, never changes an assignment and never cancels the task's goal: it touches the pause gate and its own records only. Force Stop is separate and explicit, and is recorded as forced.
 */
export class StopService {
  readonly #runner: CommandRunner;
  readonly #pauses: PauseService;
  readonly #ports: StopPorts;

  readonly #onSettled: StopSettled | undefined;
  readonly #mayHold: ((requestedBy: string, taskId: string) => Promise<boolean>) | undefined;
  private constructor(runner: CommandRunner, pauses: PauseService, ports: StopPorts, onSettled?: StopSettled, mayHold?: (requestedBy: string, taskId: string) => Promise<boolean>) { this.#runner = runner; this.#pauses = pauses; this.#ports = ports; this.#onSettled = onSettled; this.#mayHold = mayHold; }

  static withEpoch(storage: ControllerStorage, epoch: number, pauses: PauseService, ports: StopPorts, options: RunnerOptions & { /** Told when a request reaches its end (best effort: a failure never undoes the stop). */ onSettled?: StopSettled; /** Whether the one who asked for a stop may touch this (child) task: a swarm child they may not control is not held by their stop (card L02d). Absent: every child. */ mayHold?: (requestedBy: string, taskId: string) => Promise<boolean> } = {}): StopService {
    return new StopService(new CommandRunner(storage, epoch, options), pauses, ports, options.onSettled, options.mayHold);
  }

  // ---- requests ------------------------------------------------------------------------------------------------------------

  /**
   * Asks for a suspension or a stop. Whoever may pause the scope may ask; anyone else (an agent without the grant) is refused. The scope is paused first if nobody has paused it (a pause somebody else made keeps its
   * owner). A second request while one is active is refused, except Stop after Suspend, which upgrades the same intent and keeps its completed preparation.
   */
  async request(by: Principal, command: NoActor & { scope: PauseScope; mode: "suspend" | "stop"; reason: string; deadlineMs?: number; spendBudget?: number }): Promise<{ intentId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "scope", "mode", "reason", "deadlineMs", "spendBudget"]);
    if (command.mode !== "suspend" && command.mode !== "stop") invalid("mode", "must be suspend or stop");
    const reason = plain(command.reason, "reason");
    const deadlineMs = command.deadlineMs ?? STOP_LIMITS.deadlineMs.default;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > STOP_LIMITS.deadlineMs.max) invalid("deadlineMs", `must be a whole number from 1 to ${STOP_LIMITS.deadlineMs.max}`);
    if (command.spendBudget !== undefined && (typeof command.spendBudget !== "number" || !(command.spendBudget >= 0) || !Number.isFinite(command.spendBudget))) invalid("spendBudget", "must be a number of at least 0");
    const target = await this.#pauses.authorizeControl(by, command.scope);
    const scope = { kind: command.scope.kind, id: command.scope.id } as PauseScope;
    const cannot = this.#ports.unsupported?.(scope);
    if (cannot !== undefined) throw new DomainError("unavailable", cannot, { field: "scope" });
    await this.#abandonIfResumed(by, scope);
    if ((await this.#pauses.gate(by, scope))?.intent !== "pause") await this.#pauses.pause(by, { commandId: `${String(command.commandId)}-pause`, scope, reason: `${command.mode}: ${reason}`.slice(0, 500) });
    // A time the owner recorded for an ordinary pause does not carry over to a Stop or Suspend that takes the pause over (card L06b).
    await this.#pauses.dropResumeCondition(by, scope);
    const gateRequestId = (await this.#pauses.gate(by, scope))?.requestId;
    const intentId = derivedId("stp", scopedCommandId(by.id, command.commandId));
    const activeRef: AggregateRef = { kind: ACTIVE, id: derivedId("stp", scopeKey(scope)) };
    const run = await this.#runner.command("stop.request", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { scope: scope as unknown as JsonObject, mode: command.mode, reason, deadlineMs, spendBudget: command.spendBudget ?? null },
      build: async () => {
        const at = this.#runner.now();
        const active = await this.#runner.get(ACTIVE, activeRef.id);
        const current = (active?.body as unknown as { intentId?: string } | undefined)?.intentId;
        const found = current === undefined ? undefined : await this.#runner.get(KIND, current);
        const intent = found?.body as unknown as StopIntentBody | undefined;
        if (found !== undefined && intent !== undefined && !TERMINAL.includes(intent.phase)) {
          if (!(intent.mode === "suspend" && command.mode === "stop")) throw new DomainError("invalid_command", `${scope.kind} ${scope.id} already has a ${intent.mode} in progress (${intent.phase})`, { field: "scope" });
          const next: StopIntentBody = { ...intent, mode: "stop", history: [...intent.history, { phase: intent.phase, at, by: by.id, note: "stop requested after suspend; preparation is reused" }].slice(-STOP_LIMITS.history) };
          return { ref: { kind: KIND, id: current! }, creates: false, changes: [{ type: "update", ref: { kind: KIND, id: current! }, expectedRevision: found.revision, body: clean(next) }], detail: { scope: scope as unknown as JsonObject, upgraded: true } };
        }
        const ref: AggregateRef = { kind: KIND, id: intentId };
        // A stop after a finished suspension, while the scope is still held, goes on from the durable checkpoint instead of preparing again.
        const reuse = command.mode === "stop" && intent?.phase === "done" && intent.outcome?.state === "suspended" && intent.prepared !== undefined && gateRequestId !== undefined && intent.gateRequestId === gateRequestId ? intent.prepared : undefined;
        const body: StopIntentBody = {
          scope, ...(target.projectId === undefined ? {} : { projectId: target.projectId }), mode: command.mode, phase: reuse === undefined ? "preparing" : "prepared", ...(reuse === undefined ? {} : { prepared: reuse, reusedFrom: current! }), ...(reuse === undefined || (intent?.attempts ?? []).length === 0 ? {} : { attempts: intent!.attempts }), ...(gateRequestId === undefined ? {} : { gateRequestId }), requestedBy: by.id, requestedAt: at, reason,
          deadlineAt: new Date(Date.parse(at) + deadlineMs).toISOString(), ...(command.spendBudget === undefined ? {} : { spendBudget: command.spendBudget }), spent: 0, backupUsed: false, inventory: [],
          history: [{ phase: reuse === undefined ? "preparing" : "prepared", at, by: by.id, note: reuse === undefined ? `${command.mode} requested` : `stop requested after suspend; checkpoint ${reuse.checkpointId} is reused` }],
        };
        const pointer = clean({ intentId });
        return {
          ref, creates: true,
          changes: [{ type: "create", ref, body: clean(body) }, active === undefined ? { type: "create", ref: activeRef, body: pointer } : { type: "update", ref: activeRef, expectedRevision: active.revision, body: pointer }],
          detail: { scope: scope as unknown as JsonObject, mode: command.mode },
        };
      },
    }));
    // A replay (a retried old request) does not begin again: it would drop the endings of attempts newer than the request. Nor does a stop that is already over.
    const startedIntent = await this.#runner.get(KIND, intentId);
    const startedPhase = (startedIntent?.body as unknown as StopIntentBody | undefined)?.phase;
    if (!run.replayed && !(startedPhase !== undefined && TERMINAL.includes(startedPhase))) await this.#ports.begin?.(scope, { force: false, by }).catch(() => undefined);
    // A replay of a request that upgraded an earlier one has no intent of its own: it answers with the one it upgraded.
    const own = await this.#runner.get(KIND, intentId);
    return { intentId: own !== undefined ? intentId : (await this.#activeId(scope)) ?? intentId, replayed: run.replayed };
  }

  /** Force Stop: explicit, audited, and never reached by waiting. Skips preparation and ends execution at once; anything unresolved is reported and the result is `recovery-required` rather than clean. */
  async force(by: Principal, command: NoActor & { scope: PauseScope; reason: string }): Promise<{ intentId: string; outcome: StopOutcome }> {
    onlyKnown(command, ["commandId", "scope", "reason"]);
    const reason = plain(command.reason, "reason");
    const target = await this.#pauses.authorizeControl(by, command.scope);
    const scope = { kind: command.scope.kind, id: command.scope.id } as PauseScope;
    const cannot = this.#ports.unsupported?.(scope);
    if (cannot !== undefined) throw new DomainError("unavailable", cannot, { field: "scope" });
    // The same force sent again answers with what it did; it never ends running work a second time (the owner may have resumed the scope since).
    const mine = derivedId("stp", scopedCommandId(by.id, command.commandId));
    // A force that took over a request already under way left a marker at its own id naming that request.
    const marker = await this.#runner.get(FORCE_REF, mine);
    const took = marker === undefined ? mine : (marker.body as unknown as { intentId: string }).intentId;
    const prior = await this.#runner.get(KIND, took);
    if (prior !== undefined) {
      const done = (prior.body as unknown as StopIntentBody);
      if (!TERMINAL.includes(done.phase)) await this.advance(by, { intentId: took });
      return { intentId: took, outcome: ((await this.#runner.get(KIND, took))!.body as unknown as StopIntentBody).outcome! };
    }
    if ((await this.#pauses.gate(by, scope))?.intent !== "pause") await this.#pauses.pause(by, { commandId: `${String(command.commandId)}-pause`, scope, reason: `force stop: ${reason}`.slice(0, 500) });
    await this.#pauses.dropResumeCondition(by, scope);
    await this.#ports.begin?.(scope, { force: true, by }).catch(() => undefined);
    let id = await this.#activeId(scope);
    const existing = id === undefined ? undefined : await this.#runner.get(KIND, id);
    if (existing === undefined || TERMINAL.includes((existing.body as unknown as StopIntentBody).phase)) {
      id = derivedId("stp", scopedCommandId(by.id, command.commandId));
      // The pause the Force Stop holds by is recorded like a request's, so once the scope is resumed and merely paused again the finished Force Stop no longer holds swarm children (`holding`; second review of card L02e).
      await this.#create(by, command.commandId, id, scope, target.projectId, "force-stop", reason, (await this.#pauses.gate(by, scope))?.requestId);
    } else {
      const ref: AggregateRef = { kind: FORCE_REF, id: mine };
      await this.#runner.command("stop.force-ref", { commandId: `stop-fref-${mine.slice(4)}`, actor: by.id }, async () => ({ payload: { intentId: id! }, build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: { intentId: id! } }], detail: {} }) }));
    }
    await this.#update(id!, (b) => ({ ...b, mode: "force-stop", phase: "terminating", forced: { by: by.id, reason, at: this.#runner.now(), ...(b.mode !== "force-stop" || b.forced?.afterPreparation === true ? { afterPreparation: true as const } : {}) }, blocked: undefined, history: this.#push(b, "terminating", by.id, `force stop: ${reason}`) }), ["preparing", "blocked", "prepared", "terminating"]);
    await this.advance(by, { intentId: id! });
    const done = (await this.#runner.get(KIND, id!))!.body as unknown as StopIntentBody;
    return { intentId: id!, outcome: done.outcome! };
  }

  /** The answer to a blocked intent: wait (more time), restart from an earlier boundary (the scope is never called suspended), or Force Stop. */
  async choose(by: Principal, command: NoActor & { intentId: string; choice: StopChoice; extendMs?: number; reason?: string }): Promise<{ phase: StopPhase }> {
    onlyKnown(command, ["commandId", "intentId", "choice", "extendMs", "reason"]);
    if (!(STOP_CHOICES as readonly string[]).includes(command.choice)) invalid("choice", `must be one of ${STOP_CHOICES.join(", ")}`);
    const found = await this.#runner.get(KIND, String(command.intentId));
    if (found === undefined) throw new DomainError("not_found", "no such stop request");
    const body = found.body as unknown as StopIntentBody;
    await this.#mayControl(by, body.scope);
    if (body.phase !== "blocked") throw new DomainError("invalid_command", `the request is ${body.phase}; there is nothing to choose`, { field: "intentId" });
    if (command.choice === "force-stop") { const r = await this.force(by, { commandId: command.commandId, scope: body.scope, reason: command.reason ?? "chosen after a blocked preparation" }); return { phase: (r.outcome.state === "recovery-required" ? "recovery-required" : "done") }; }
    const at = this.#runner.now();
    if (command.choice === "wait") {
      const extend = command.extendMs ?? STOP_LIMITS.deadlineMs.default;
      if (!Number.isSafeInteger(extend) || extend < 1 || extend > STOP_LIMITS.deadlineMs.max) invalid("extendMs", `must be a whole number from 1 to ${STOP_LIMITS.deadlineMs.max}`);
      await this.#update(String(command.intentId), (b) => ({ ...b, phase: b.blocked?.resume ?? "preparing", blocked: undefined, deadlineAt: new Date(Date.parse(at) + extend).toISOString(), ...((b.blocked?.resume ?? "preparing") === "preparing" ? { spent: 0 } : {}), history: this.#push(b, b.blocked?.resume ?? "preparing", by.id, `waiting ${extend} ms more`) }), ["blocked"]);
      return { phase: body.blocked?.resume ?? "preparing" };
    }
    await this.#observe(by, body.scope, String(command.intentId), "recovery-required", "restart from an earlier boundary chosen; the scope is not suspended");
    await this.#settle(String(command.intentId), by, { state: "recovery-required", graceful: false, unresolved: body.inventory.filter((i) => i.state !== "settled" && i.state !== "tracked").map((i) => i.ref), at }, "recovery-required", "restart from an earlier boundary chosen", ["blocked"]);
    return { phase: "recovery-required" };
  }

  // ---- progress --------------------------------------------------------------------------------------------------------------

  /** Takes the intent as far as it can go now. Safe to call again at any time (the controller's loop does, and so does a restart). Returns where it stands. */
  async advance(by: Principal, command: { intentId: string }): Promise<View<StopIntentBody>> {
    const id = String(command.intentId);
    const first = await this.#runner.get(KIND, id);
    if (first === undefined) throw new DomainError("not_found", "no such stop request");
    await this.#mayControl(by, (first.body as unknown as StopIntentBody).scope);
    const LIVE: readonly StopPhase[] = ["preparing", "blocked", "prepared", "terminating"];
    for (let step = 0; step < STOP_LIMITS.advances; step++) {
      const found = (await this.#runner.get(KIND, id))!;
      const b = found.body as unknown as StopIntentBody;
      if (TERMINAL.includes(b.phase)) return view<StopIntentBody>(found);
      if (b.forced === undefined && (await this.#pauses.gate(by, b.scope))?.intent !== "pause") {
        // Somebody resumed the scope before the request finished (blocked or not): the request is over and nothing more is done for it; what preparation froze is let go.
        await this.#update(id, (x) => (x.forced !== undefined ? x : { ...x, phase: x.phase === "terminating" ? "recovery-required" : "cancelled", blocked: undefined, history: this.#push(x, x.phase === "terminating" ? "recovery-required" : "cancelled", by.id, "the scope was resumed before the request finished") }), LIVE);
        await this.#ports.release?.(b.scope).catch(() => undefined);
        continue;
      }
      if (b.phase === "blocked") return view<StopIntentBody>(found);
      const now = this.#runner.now();
      this.#ports.remember?.(b.scope, b.attempts ?? []);
      if (b.phase === "preparing") {
        await this.#observe(by, b.scope, id, "preparing-to-suspend", "preparing to suspend");
        let inventory = b.inventory;
        let result: Awaited<ReturnType<StopPorts["cleanup"]>>;
        try {
          if (inventory.length === 0) inventory = (await this.#ports.inventory(b.scope)).slice(0, STOP_LIMITS.inventory);
          result = await this.#ports.cleanup(b.scope, { deadlineAt: b.deadlineAt, ...(b.spendBudget === undefined ? {} : { spendBudget: b.spendBudget }), backup: b.backupUsed, by });
        } catch (error) {
          await this.#block(id, by.id, `cleanup could not run: ${redactText(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, ["preparing"]);
          continue;
        }
        // Cleanup is billed even when this pass turns out stale: what was spent was spent.
        const billed = await this.#charge(id, by, result.costs);
        // The attempts the runtime saw are recorded, so a restart still asks about a process of one that has ended since.
        // Attempts that reported a cleanup cost are recorded too (a runtime may report a cost for an attempt it does not list), so the owner's view lists what was charged.
        const seenNow = [...new Set([...(this.#ports.attempts?.(b.scope) ?? []), ...costAttempts(result.costs)])];
        if (seenNow.some((a) => !(b.attempts ?? []).includes(a))) await this.#update(id, (x) => ({ ...x, attempts: [...new Set([...(x.attempts ?? []), ...seenNow])].slice(-STOP_LIMITS.inventory) }));
        // Something else (a Force Stop, a choice, a resume) may have moved the request while the cleanup ran: then this pass is stale and does nothing more.
        if (((await this.#runner.get(KIND, id))?.body as unknown as StopIntentBody | undefined)?.phase !== "preparing") continue;
        const spent = b.spent + (result.spent ?? billed.costMicros);
        if (result.modelLost === true && !b.backupUsed) { await this.#update(id, (x) => ({ ...x, backupUsed: true, spent, inventory, history: this.#push(x, "preparing", by.id, "the cleanup model was lost; an eligible backup model is used") }), ["preparing"]); continue; }
        if (result.modelLost === true) { await this.#block(id, by.id, "the cleanup model was lost and the backup model could not finish the cleanup", ["preparing"]); continue; }
        // A Stop ends processes, child work and background jobs itself, in the ending step (card L02d): only calls in flight, and anything that was asked to stop and did not, are waited for in preparation. A Suspend waits for everything.
        // A Suspend does not wait for a placeholder: the host-side "unknown" item that only says a remote placement exists, or that a local worker forgot the attempt in a restart. Once the attempt is quiesced (the cleanup ran) it cannot be
        // verified or waited on, so it is recorded as unverified in the history and the checkpoint goes on; a Stop still ends the attempt and finds it gone (or lists it as unresolved).
        const placeholders = b.mode === "suspend" ? result.remaining.filter((i) => i.kind === "process" && i.state === "unknown" && PLACEHOLDER.test(i.ref)) : [];
        const waited = placeholders.length === 0 ? result.remaining : result.remaining.filter((i) => !placeholders.includes(i));
        const settling = b.mode === "stop" ? waited.filter((i) => i.kind === "foreground" || i.state === "uncooperative") : waited;
        if (b.spendBudget !== undefined && spent > b.spendBudget && settling.length > 0) { await this.#update(id, (x) => ({ ...x, spent }), ["preparing"]); await this.#block(id, by.id, "the cleanup budget is used up with work still running", ["preparing"]); continue; }
        if (settling.length > 0) {
          const stuck = settling.filter((i) => i.state !== "settled" && i.state !== "tracked");
          await this.#update(id, (x) => ({ ...x, spent, inventory: result.remaining.slice(0, STOP_LIMITS.inventory) }), ["preparing"]);
          if (Date.parse(now) >= Date.parse(b.deadlineAt) || stuck.some((i) => i.state === "uncooperative")) { await this.#block(id, by.id, stuck.some((i) => i.state === "uncooperative") ? "an uncooperative operation will not settle" : "the deadline passed with work still running", ["preparing"]); continue; }
          return view<StopIntentBody>((await this.#runner.get(KIND, id))!); // still settling: the next call looks again
        }
        let cp: Awaited<ReturnType<StopPorts["checkpoint"]>>;
        try { cp = await this.#ports.checkpoint(b.scope, { by, mode: b.mode, deadlineAt: b.deadlineAt }); } catch (error) {
          await this.#block(id, by.id, `the checkpoint could not be taken: ${redactText(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, ["preparing"]);
          continue;
        }
        if (!cp.durable || !cp.artifactsDurable) { await this.#update(id, (x) => ({ ...x, spent, inventory: [] }), ["preparing"]); await this.#block(id, by.id, !cp.durable ? "the checkpoint is not durable" : "the artifacts the checkpoint names are not durable", ["preparing"]); continue; }
        const unverified = placeholders.length === 0 ? "" : `; unverified, not waited for: ${placeholders.map((p) => p.ref).join(", ").slice(0, 200)}`;
        await this.#update(id, (x) => ({ ...x, phase: "prepared", spent, inventory: [], prepared: { at: now, checkpointId: cp.checkpointId }, history: this.#push(x, "prepared", by.id, `checkpoint ${cp.checkpointId} is durable${unverified}`) }), ["preparing"]);
        continue;
      }
      if (b.phase === "prepared") {
        if (b.mode === "suspend") {
          await this.#observe(by, b.scope, id, "suspended", `checkpoint ${b.prepared?.checkpointId ?? "?"} is durable`);
          await this.#settle(id, by, { state: "suspended", graceful: true, unresolved: [], at: now }, "done", "suspended", ["prepared"]);
          continue;
        }
        await this.#update(id, (x) => ({ ...x, phase: "terminating", history: this.#push(x, "terminating", by.id, "ending execution") }), ["prepared"]);
        continue;
      }
      if (b.phase === "terminating") {
        await this.#observe(by, b.scope, id, "stopping", b.forced === undefined ? "ending execution after preparation" : "force stop: ending execution without cleanup");
        let ended: Awaited<ReturnType<StopPorts["terminate"]>>;
        try { ended = await this.#ports.terminate(b.scope, { force: b.forced !== undefined, by }); } catch (error) {
          await this.#block(id, by.id, `execution could not be ended: ${redactText(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, ["terminating"], "terminating");
          continue;
        }
        const graceful = b.forced === undefined;
        // What the ending cost is billed too; a charge that cannot be made is named, never dropped.
        const billed = await this.#charge(id, by, ended.costs);
        // The attempts the ending charged are recorded on the request too (a Force Stop, or a Stop that reused a checkpoint, never saw them while preparing), so the owner's view lists them.
        const charged = costAttempts(ended.costs);
        await this.#update(id, (x) => ({ ...x, ended: true as const, ...(charged.some((a) => !(x.attempts ?? []).includes(a)) ? { attempts: [...new Set([...(x.attempts ?? []), ...charged])].slice(-STOP_LIMITS.inventory) } : {}) }));
        if (billed.failed) ended = { ...ended, unresolved: [...ended.unresolved, CLEANUP_UNPAID] };
        if (ended.ended && ended.unresolved.length === 0) {
          await this.#observe(by, b.scope, id, "stopped", graceful ? "ended after preparation" : "force stopped; incomplete state may need reconciling");
          await this.#settle(id, by, { state: "stopped", graceful, unresolved: [], at: now }, "done", graceful ? "stopped" : "force stopped", ["terminating"]);
        } else {
          await this.#observe(by, b.scope, id, "recovery-required", `unresolved: ${ended.unresolved.join(", ").slice(0, 300) || "execution did not end"}`);
          await this.#settle(id, by, { state: "recovery-required", graceful: false, unresolved: ended.unresolved.slice(0, 50), at: now }, "recovery-required", "unresolved work remains", ["terminating"]);
        }
        continue;
      }
    }
    return view<StopIntentBody>((await this.#runner.get(KIND, id))!);
  }

  /** Carries every unfinished intent on after a restart. */
  async sweep(by: Principal): Promise<{ advanced: string[]; failed: string[] }> {
    const advanced: string[] = [];
    const failed: string[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const rec of page) {
        after = rec.id;
        const b = rec.body as unknown as StopIntentBody;
        // What a pass could not record anywhere else is charged first (see `owed`), for a finished request too. A finished request that still carries the "not charged" mark is looked at as well, owed or not: the write
        // that takes the mark off may have failed after the last owed figure was taken off, or a sweep may have paid what was owed before the request settled with the mark; `#payOwed` clears it then unless an open entry
        // still lists the request. Only a request this build marked (it carries `ended`, written before the mark) is cleared this way: an older record's mark says nothing about where its figure went.
        if ((b.owed?.length ?? 0) > 0 || (TERMINAL.includes(b.phase) && b.ended === true && b.outcome?.unresolved.includes(CLEANUP_UNPAID) === true)) await this.#payOwed(by, rec.id).catch(() => undefined);
        if (TERMINAL.includes(b.phase)) continue;
        try { await this.advance(by, { intentId: rec.id }); advanced.push(rec.id); } catch { failed.push(rec.id); }
      }
      if (page.length < 100) break;
    }
    await this.#retryCharges(by).catch(() => undefined);
    return { advanced, failed };
  }

  /**
   * Whether a stop of the scope could finish now, without starting one (card L06): everything the stop inventory finds for the scope that is not settled, as it is today. A look that fails is not "ready": it is reported as one unknown item.
   * `truncated` says the inventory was cut at its limit, so the list is not all of it. Nothing is paused, recorded or changed.
   */
  async readiness(by: Principal, scope: PauseScope): Promise<{ scope: PauseScope; ready: boolean; paused: boolean; unsettled: readonly InventoryItem[]; /** Permitted remote jobs that keep running through a stop: not waited for, but named. */ tracked: readonly InventoryItem[]; truncated: boolean }> {
    await this.#pauses.authorizeControl(by, scope);
    const clean = { kind: scope.kind, id: scope.id } as PauseScope;
    const cannot = this.#ports.unsupported?.(clean);
    if (cannot !== undefined) throw new DomainError("unavailable", cannot, { field: "scope" });
    const found = await this.#ports.inventory(clean, { lookOnly: true }).catch(() => [{ kind: "process", ref: "runtime:inventory", state: "unknown" } as InventoryItem]);
    const unsettled = found.filter((i) => i.state !== "settled" && i.state !== "tracked");
    const tracked = found.filter((i) => i.state === "tracked");
    return { scope: clean, ready: unsettled.length === 0, paused: (await this.#pauses.gate(by, clean))?.intent === "pause", unsettled: unsettled.slice(0, STOP_LIMITS.inventory), tracked: tracked.slice(0, STOP_LIMITS.inventory), truncated: unsettled.length > STOP_LIMITS.inventory };
  }

  async get(viewer: Principal, intentId: string): Promise<View<StopIntentBody> | undefined> {
    const found = await this.#runner.get(KIND, String(intentId));
    if (found === undefined) return undefined;
    try { await this.#pauses.authorizeControl(viewer, (found.body as unknown as StopIntentBody).scope); } catch { return undefined; }
    return view<StopIntentBody>(found);
  }

  /**
   * What the latest suspension or stop of a scope has spent on cleanup, for the owner to read (card L02d): the figure the request counted, what the runtime reported and the budgets were charged for each attempt the
   * request saw, and whether a charge is still unpaid. Read only; whoever may control the scope may ask (anyone else is refused: `forbidden`, or `not_found` for a scope that does not exist). When nothing was asked for
   * exactly this scope, the latest request made for a scope that covers it is answered instead (card L02e): a task is covered by its agent, a team above that agent, a swarm parent or the installation, an agent by its team and
   * the installation, a team by a team above it and the installation; the answer then carries `through`, naming that scope, and its figures are the whole wider scope's. `undefined` when no request was made for the scope or
   * for any scope above it, or the asker may control none of them. `spent` is the figure of the request's current cleanup budget window (a `wait` on a blocked preparation starts a new one, not one after a failed ending; a pass
   * that went stale is not in it), not the full cost.
   */
  async cleanupSpend(viewer: Principal, scope: PauseScope): Promise<{ intentId: string; mode: StopMode; phase: StopPhase; spent: number; spendBudget?: number; unpaid: boolean; /** Unpaid only because the request's outcome still carries the "not charged" mark: this request has no charge of its own left (no pending note, no figure above what was charged: another request paid what it waited on, or the sweep has yet to look), and the next sweep clears the mark once what it waited on is paid (false when no sweep will: see `markKept`, and when the scan was cut: see `scanCut`). */ markOnly: boolean; /** Unpaid only because of the mark, on a record an older build wrote (no `ended`) that no open entry lists: nothing says where its figure went, so no sweep clears this mark; it is left for the owner. */ markKept: boolean; /** The open index is longer than the view reads (`RETRY_PAGES` x 100 entries) and no charge of this request's own was found in the part read: whether one is left on an attempt the request's record does not list is not known. */ scanCut: boolean; /** A Force Stop that took over a Suspend or Stop in whatever phase it had reached: `spent` and `spendBudget` are that request's own. */ forcedAfterPreparation: boolean; /** The ending of execution has run (terminate was called and its cost charged). */ endingRan: boolean; /** A Stop made after a finished Suspend, which went on from its checkpoint instead of preparing (its `spent` is 0 because no preparation ran). */ reusedCheckpoint: boolean; /** The request was made for this wider scope, which covers the one asked about (card L02e); every figure here is that scope's, not only the asked scope's. */ through?: { kind: string; id: string }; /** When that request was asked for. */ requestedAt?: string; attempts: { attemptId: string; costMicros: number; computeMs: number; pending: boolean }[] } | undefined> {
    // Whoever may not control the scope (or names one that does not exist) is refused, never told "nothing happened"; the status view reads that as missing.
    await this.#pauses.authorizeControl(viewer, scope);
    const ownId = await this.#activeId(scope);
    const mine = ownId === undefined ? undefined : await this.#runner.get(KIND, ownId);
    // Nothing was asked for this scope itself: a stop of a scope above it reached it too, so that request's cleanup is what the owner is asking about (card L02e).
    const above = mine === undefined ? await this.#coveringRequest(viewer, scope) : undefined;
    const id = ownId ?? above?.id;
    const found = (mine?.body ?? above?.body) as unknown as StopIntentBody | undefined;
    if (found === undefined || id === undefined) return undefined;
    const through = mine === undefined && above !== undefined ? above.through : undefined;
    const attempts: { attemptId: string; costMicros: number; computeMs: number; pending: boolean }[] = [];
    // A figure the request's own pass could not record elsewhere is its debt too.
    let ownPending = (found.owed?.length ?? 0) > 0;
    for (const attemptId of (found.attempts ?? []).slice(0, STOP_LIMITS.inventory)) {
      const charge = (await this.#runner.get(CHARGE, attemptId))?.body as unknown as ChargeBody | undefined;
      if (charge === undefined) continue;
      attempts.push({ attemptId, costMicros: charge.costMicros, computeMs: charge.computeMs, pending: charge.pending !== undefined });
      // A pending note belongs to the request that wrote it; another request's further charge on the same attempt is not this request's debt.
      if (charge.pending?.intentId === id) ownPending = true;
    }
    // The request's own pending note may be on an attempt its record does not list: the open index names every request with a note or a wait on an attempt. The scan is cut at `RETRY_PAGES` pages; a scan that did not reach
    // the end (a short page, or nothing after a full last page) says nothing about the rest, so it is reported as cut, never as "nothing of its own left". `listed`: some entry read lists the request (the sweep clears its mark
    // there once that entry is paid).
    let complete = ownPending, listed = false, after: string | undefined;
    for (let pages = 0; !ownPending && pages < RETRY_PAGES; pages++) {
      const page = await this.#runner.list(OPEN, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const rec of page) {
        after = rec.id;
        if (!(rec.body as unknown as OpenBody).intents.includes(id)) continue;
        listed = true;
        const charge = (await this.#runner.get(CHARGE, rec.id))?.body as unknown as ChargeBody | undefined;
        const want = (rec.body as unknown as OpenBody).want;
        // Its own note, or a figure it (or a request after it) reported that is still above what was charged: the request has charging left to do, not just a mark.
        if (charge?.pending?.intentId === id || (want !== undefined && (charge === undefined || charge.costMicros < want.costMicros || charge.computeMs < want.computeMs))) { ownPending = true; break; }
      }
      if (ownPending || page.length < 100) { complete = true; break; }
    }
    // Every page read was full: the scan reached the end only if nothing follows the last entry read.
    if (!complete && !ownPending) complete = await this.#nothingAfter(after);
    const marked = found.outcome?.unresolved.includes(CLEANUP_UNPAID) === true;
    // Records written before the flags existed (see the notes): a Force Stop that carries a limit, a spent figure, a checkpoint or a preparing/prepared step in its history took over earlier work (a pure Force Stop has none of them),
    // and a request settled as "unresolved work remains" got there through its ending.
    const forcedAfterPreparation = found.forced !== undefined && (found.forced.afterPreparation === true || found.spendBudget !== undefined || found.spent > 0 || found.prepared !== undefined || found.history.some((h) => h.phase === "preparing" || h.phase === "prepared"));
    const endingRan = found.ended === true || found.history.some((h) => h.note === "unresolved work remains");
    // Only a request this build marked (`ended`) or one an open entry lists has its mark cleared by a sweep (see `sweep`); an older record's mark on no entry is kept for good.
    const scanCut = !complete;
    const markKept = marked && !ownPending && !scanCut && found.ended !== true && !listed;
    return { intentId: id, mode: found.mode, phase: found.phase, spent: found.spent, requestedAt: found.requestedAt, ...(through === undefined ? {} : { through }), ...(found.spendBudget === undefined ? {} : { spendBudget: found.spendBudget }), unpaid: marked || ownPending, markOnly: marked && !ownPending && !scanCut && !markKept, markKept, scanCut, forcedAfterPreparation, reusedCheckpoint: found.reusedFrom !== undefined, endingRan, attempts };
  }

  /**
   * The scopes whose stop reaches this one, besides the scope itself: those above it (a task's assignee agent and the teams above that, an agent's teams, a team's parent teams) and, for a task, its swarm parents, whose
   * Stop ends the children's work (card L02e). The whole installation comes last, since it covers everything and explains least. Cycles and over-long chains end the walks; nothing is listed twice.
   */
  async #covering(scope: PauseScope): Promise<PauseScope[]> {
    const here = scopeKey(scope);
    const near: PauseScope[] = [];
    const whole: PauseScope[] = [];
    const seen = new Set<string>([here]);
    const add = (s: PauseScope): void => { const k = scopeKey(s); if (k === here || seen.has(k)) return; seen.add(k); (s.kind === "installation" ? whole : near).push(s); };
    for (const s of await this.#pauses.chain(scope)) add(s);
    for (let at = scope.kind === "task" ? scope.id : undefined, hops = 0; at !== undefined && hops < PAUSE_LIMITS.chain; hops++) {
      const up = ((await this.#runner.get("swarm-link", at))?.body as unknown as { parentTaskId?: string } | undefined)?.parentTaskId;
      if (typeof up !== "string") break;
      if (seen.has(scopeKey({ kind: "task", id: up }))) break;
      add({ kind: "task", id: up });
      at = up;
    }
    return [...near, ...whole];
  }

  /** The latest request made for any scope that covers this one; a request on a scope the asker may not control is not shown to them at all, and is not even said to exist. */
  async #coveringRequest(viewer: Principal, scope: PauseScope): Promise<{ id: string; body: StopIntentBody; through: { kind: string; id: string } } | undefined> {
    let best: { id: string; body: StopIntentBody; through: { kind: string; id: string }; at: number } | undefined;
    // A request made before the asked scope existed did not reach it (a task created after the installation was stopped and resumed), nor did an agent's or team's request made before the task was given to that agent
    // (review of card L02e): such a request is not this scope's answer.
    const createdAt = async (kind: string, id: string): Promise<number | undefined> => { const at = (await this.#runner.get(kind, id))?.createdAt; return at === undefined ? undefined : Date.parse(at); };
    const born = scope.kind === "installation" ? undefined : await createdAt(scope.kind, scope.id);
    let given: number | undefined;
    if (scope.kind === "task") {
      const asg = (await this.#runner.get("assignment", assignmentIdOf(scope.id)))?.body as unknown as AssignmentBody | undefined;
      if (asg !== undefined && asg.generation > 0) given = await createdAt("assignment-generation", generationIdOf(scope.id, asg.generation));
    }
    for (const s of await this.#covering(scope)) {
      const id = await this.#activeId(s);
      if (id === undefined) continue;
      const rec = await this.#runner.get(KIND, id);
      if (rec === undefined) continue;
      const asked = Date.parse((rec.body as unknown as StopIntentBody).requestedAt);
      if (born !== undefined && asked < born) continue;
      if (given !== undefined && (s.kind === "agent" || s.kind === "team") && asked < given) continue;
      try { await this.#pauses.authorizeControl(viewer, s); } catch (error) {
        if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) continue;
        throw error;
      }
      const body = rec.body as unknown as StopIntentBody;
      // The newest request wins; on equal times the nearest scope, which is the one looked at first, is kept.
      const at = Date.parse(body.requestedAt);
      if (best !== undefined && !(at > best.at)) continue;
      best = { id, body, at, through: { kind: s.kind, id: s.id } };
    }
    return best;
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  /** An unfinished request on a scope that has since been resumed is over; it must not block the next request. */
  async #abandonIfResumed(by: Principal, scope: PauseScope): Promise<void> {
    const id = await this.#activeId(scope);
    const found = id === undefined ? undefined : await this.#runner.get(KIND, id);
    if (id === undefined || found === undefined) return;
    const b = found.body as unknown as StopIntentBody;
    if (TERMINAL.includes(b.phase) || (await this.#pauses.gate(by, scope))?.intent === "pause") return;
    await this.#update(id, (x) => ({ ...x, phase: "cancelled", blocked: undefined, history: this.#push(x, "cancelled", by.id, "the scope was resumed before the request finished") }), ["preparing", "blocked", "prepared", "terminating"]);
    await this.#ports.release?.(scope).catch(() => undefined);
  }

  async #activeId(scope: PauseScope): Promise<string | undefined> {
    return ((await this.#runner.get(ACTIVE, derivedId("stp", scopeKey(scope))))?.body as unknown as { intentId?: string } | undefined)?.intentId;
  }

  #push(b: StopIntentBody, phase: StopPhase, by: string, note: string): StopIntentBody["history"] {
    return [...b.history, { phase, at: this.#runner.now(), by, note }].slice(-STOP_LIMITS.history);
  }

  async #create(by: Principal, commandId: unknown, id: string, scope: PauseScope, projectId: string | undefined, mode: StopMode, reason: string, gateRequestId?: string): Promise<void> {
    const activeRef: AggregateRef = { kind: ACTIVE, id: derivedId("stp", scopeKey(scope)) };
    await this.#runner.command("stop.request", { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { scope: scope as unknown as JsonObject, mode, reason },
      build: async () => {
        const at = this.#runner.now();
        const active = await this.#runner.get(ACTIVE, activeRef.id);
        const ref: AggregateRef = { kind: KIND, id };
        const body: StopIntentBody = { scope, ...(projectId === undefined ? {} : { projectId }), mode, phase: "terminating", ...(gateRequestId === undefined ? {} : { gateRequestId }), requestedBy: by.id, requestedAt: at, reason, deadlineAt: at, spent: 0, backupUsed: false, inventory: [], history: [{ phase: "terminating", at, by: by.id, note: `${mode} requested` }] };
        const pointer = clean({ intentId: id });
        return { ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }, active === undefined ? { type: "create", ref: activeRef, body: pointer } : { type: "update", ref: activeRef, expectedRevision: active.revision, body: pointer }], detail: { scope: scope as unknown as JsonObject, mode } };
      },
    }));
  }

  /** Whether the principal may control the scope; anyone who may not learns nothing, not even that the request exists. */
  async #mayControl(by: Principal, scope: PauseScope): Promise<void> {
    try { await this.#pauses.authorizeControl(by, scope); } catch (error) { if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) throw new DomainError("not_found", "no such stop request"); throw error; }
  }

  /**
   * Charges the part of the cleanup cost that has not been charged (card L02d). What was charged is kept per ATTEMPT (`stop-charge`, not per stop request). Each step is written before it is done: the new running total is noted
   * as pending with the charge's command ID (derived from the attempt, the total charged so far and the new total), then the charge is made (the budget applies a command ID once), then the note is cleared. A crash between the
   * steps is finished first by the next try with the same command ID, so a replay after the total has grown charges the part already paid once and only the rest as new. A figure that is not a whole number of zero or more is ignored
   * and one above `CLEANUP_CAP` is cut to it. A charge that fails is left pending (retried by the next pass and by `sweep`), counted once against the spend budget, and reported as `failed`.
   */
  async #charge(id: string, by: Principal, costs: readonly CleanupCost[] | undefined): Promise<{ costMicros: number; failed: boolean }> {
    let billed = 0;
    let failed = false;
    if (costs === undefined || this.#ports.charge === undefined) return { costMicros: 0, failed: false };
    for (const c of costs.slice(0, STOP_LIMITS.inventory)) {
      const cost = c?.costMicros ?? 0, compute = c?.computeMs ?? 0;
      if (typeof c?.attemptId !== "string" || !/^[A-Za-z0-9:_-]{1,120}$/.test(c.attemptId) || !Number.isSafeInteger(cost) || cost < 0 || !Number.isSafeInteger(compute) || compute < 0) continue;
      // Another stop of the same attempt may write the note between our read and our write: that is a lost race, never a failure. Look again (the other one's figure may already cover ours) and go on.
      let done = false;
      for (let race = 0; race < 6 && !done; race++) {
        let found = await this.#runner.get(CHARGE, c.attemptId);
        let have = (found?.body as unknown as ChargeBody | undefined) ?? { costMicros: 0, computeMs: 0 };
        if (have.pending !== undefined) {
          const paid = await this.#payPending(c.attemptId);
          billed += paid.billed;
          if (!paid.ok) { await this.#wait(c.attemptId, id, { costMicros: Math.min(cost, CLEANUP_CAP), computeMs: Math.min(compute, CLEANUP_CAP) }); failed = true; done = true; break; }
          found = await this.#runner.get(CHARGE, c.attemptId);
          have = (found?.body as unknown as ChargeBody | undefined) ?? { costMicros: 0, computeMs: 0 };
          // Another request noted a new charge right after the one we paid: ours is never written over it (that charge would be made twice); look again and pay it first.
          if (have.pending !== undefined) continue;
        }
        const newCost = Math.max(Math.min(cost, CLEANUP_CAP), have.costMicros), newCompute = Math.max(Math.min(compute, CLEANUP_CAP), have.computeMs);
        if (newCost === have.costMicros && newCompute === have.computeMs) { done = true; break; }
        const commandId = `stopcl-${createHash("sha256").update(`${c.attemptId}:${have.costMicros}:${have.computeMs}:${newCost}:${newCompute}`).digest("hex").slice(0, 40)}`;
        const noted = await this.#note(c.attemptId, found?.revision, { ...have, pending: { costMicros: newCost, computeMs: newCompute, commandId, intentId: id, counted: false } });
        if (!noted) continue;
        const paid = await this.#payPending(c.attemptId);
        billed += paid.billed;
        if (!paid.ok) failed = true;
        done = true;
      }
      if (!done) { await this.#wait(c.attemptId, id, { costMicros: Math.min(cost, CLEANUP_CAP), computeMs: Math.min(compute, CLEANUP_CAP) }); failed = true; }
    }
    return { costMicros: billed, failed };
  }

  /**
   * Records the figure a request could not charge now: in the attempt's open entry (`#waitOn`), or, when that entry keeps changing, on the request's OWN record as `owed` (a record only that request's passes write), so the figure is
   * never left unrecorded. The error never reaches the caller: `#charge` reports the charge as failed, the request counts as unpaid, and the sweep charges what is owed (`#payOwed`). Only a record that cannot be written either
   * (six lost races on it too), or a request that already owes figures for the inventory limit of other attempts, throws, and then the pass is left unfinished and retried.
   */
  async #wait(attemptId: string, intentId: string, want: { costMicros: number; computeMs: number }): Promise<void> {
    try { await this.#waitOn(attemptId, intentId, want); } catch (error) {
      if (!(error instanceof DomainError && error.code === "stale_revision")) throw error;
      await this.#update(intentId, (x) => {
        const have = (x.owed ?? []).find((o) => o.attemptId === attemptId);
        // The list is never cut (that would drop a figure nobody charged): a new attempt past the limit is refused like a write that cannot be made, and the pass is left unfinished and retried.
        if (have === undefined && (x.owed ?? []).length >= STOP_LIMITS.inventory) throw new DomainError("stale_revision", `the request already owes figures for ${STOP_LIMITS.inventory} attempts; the pass is left unfinished and the next sweep carries it on`);
        const merged = { attemptId, costMicros: Math.max(have?.costMicros ?? 0, want.costMicros), computeMs: Math.max(have?.computeMs ?? 0, want.computeMs) };
        return { ...x, owed: [...(x.owed ?? []).filter((o) => o.attemptId !== attemptId), merged] };
      });
    }
  }

  /**
   * Charges what a request owes (see `owed`), per attempt, and takes an entry off only once it is charged, and only if no higher figure was added meanwhile. The charge uses the same derived command ID as any other, so charging
   * again after a crash or by two sweeps at once never pays twice. When nothing is owed any more, a finished request's "not charged" mark is taken off unless an open entry still lists the request (the sweep clears it there).
   */
  async #payOwed(by: Principal, id: string): Promise<void> {
    // Without a way to charge nothing is charged, so nothing owed is taken off.
    if (this.#ports.charge === undefined) return;
    const owed = ((await this.#runner.get(KIND, id))?.body as unknown as StopIntentBody | undefined)?.owed ?? [];
    for (const o of owed) {
      const r = await this.#charge(id, by, [o]);
      if (r.failed) continue;
      await this.#update(id, (x) => {
        const rest = (x.owed ?? []).filter((e) => !(e.attemptId === o.attemptId && e.costMicros <= o.costMicros && e.computeMs <= o.computeMs));
        const { owed: _gone, ...others } = x;
        return rest.length === 0 ? others as StopIntentBody : { ...others, owed: rest };
      });
    }
    const now = (await this.#runner.get(KIND, id))?.body as unknown as StopIntentBody | undefined;
    if (now === undefined || (now.owed?.length ?? 0) > 0 || !TERMINAL.includes(now.phase) || now.outcome?.unresolved.includes(CLEANUP_UNPAID) !== true) return;
    // The mark is taken off only after the WHOLE index was read: a scan cut at `RETRY_PAGES` pages may have missed the entry that lists the request, so the mark is kept then (a later sweep looks again).
    let complete = false, after: string | undefined;
    for (let pages = 0; pages < RETRY_PAGES; pages++) {
      const page = await this.#runner.list(OPEN, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const rec of page) { after = rec.id; if ((rec.body as unknown as OpenBody).intents.includes(id)) return; }
      if (page.length < 100) { complete = true; break; }
    }
    if (!complete && !(await this.#nothingAfter(after))) return;
    await this.#update(id, (x) => (x.outcome === undefined || (x.owed?.length ?? 0) > 0 || !x.outcome.unresolved.includes(CLEANUP_UNPAID) ? x : { ...x, outcome: { ...x.outcome, unresolved: x.outcome.unresolved.filter((u) => u !== CLEANUP_UNPAID) }, history: this.#push(x, x.phase, "system", "the cleanup spend was charged later") })).catch(() => false);
  }

  /**
   * Records that a request is waiting on an attempt's pending charge written by ANOTHER request (its own cleanup found that note and could not pay it), in the same open index the sweep reads, so the sweep clears this request's
   * "not charged" mark once the note is paid. Without it the request would carry the mark for good. A lost race is read again; after six lost races in a row it throws a retryable error, so the pass does not go on (the request stays live and the sweep carries it on, charging again), never returning with the wait unrecorded. Called only from `#wait`.
   */
  async #waitOn(attemptId: string, intentId: string, want?: { costMicros: number; computeMs: number }): Promise<void> {
    const openRef: AggregateRef = { kind: OPEN, id: attemptId };
    for (let race = 0; race < 6; race++) {
      const open = await this.#runner.get(OPEN, attemptId);
      const had = open?.body as unknown as OpenBody | undefined;
      const raised = this.#raise(had?.want, want, intentId);
      if (had !== undefined && !had.settled && had.intents.includes(intentId) && raised === had.want) return;
      const next = clean({ intents: await this.#listed(attemptId, had?.intents ?? [], intentId, [raised?.intentId]), settled: false, ...(raised === undefined ? {} : { want: raised }) });
      // The figure is part of the identity of the write: two passes that wait at the same revision with different figures are different commands (the second then loses the race and looks again).
      const digest = createHash("sha256").update(JSON.stringify(next)).digest("hex").slice(0, 16);
      try {
        await this.#runner.command("stop.charge-wait", { commandId: `stop-wait-${attemptId}-${intentId}-${open?.revision ?? 0}-${digest}`.slice(0, 200), actor: "system" }, async () => ({
          payload: { attemptId, intentId, ...(raised === undefined ? {} : { costMicros: raised.costMicros, computeMs: raised.computeMs }) },
          build: async () => ({ ref: openRef, creates: open === undefined, changes: [open === undefined ? { type: "create", ref: openRef, body: next } : { type: "update", ref: openRef, expectedRevision: open.revision, body: next }], detail: { attemptId } }),
        }));
        return;
      } catch (error) {
        if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict" || error.code === "not_found")) continue;
        throw error;
      }
    }
    throw new DomainError("stale_revision", `the open charge entry of ${attemptId} kept changing; the pass is left unfinished and the next sweep carries it on`);
  }

  /** The running maximum of the figures requests wanted charged (the same object when nothing is raised). */
  #raise(had: OpenBody["want"], add: { costMicros: number; computeMs: number } | undefined, intentId: string): OpenBody["want"] {
    if (add === undefined) return had;
    if (had !== undefined && add.costMicros <= had.costMicros && add.computeMs <= had.computeMs) return had;
    return { costMicros: Math.max(add.costMicros, had?.costMicros ?? 0), computeMs: Math.max(add.computeMs, had?.computeMs ?? 0), intentId };
  }

  /**
   * The requests an open entry lists once `add` joins. Past `OPEN_INTENTS` only requests the sweep may still have something to do for are kept: one that carries the "not charged" mark, one that has not finished (its mark may yet be
   * written), the one whose note is pending, the one whose figure is wanted, and `add`. A request is never dropped while any of these holds.
   */
  async #listed(attemptId: string, have: readonly string[], add: string, extra: readonly (string | undefined)[] = []): Promise<string[]> {
    const all = [...new Set([...have, add])];
    if (all.length <= OPEN_INTENTS) return all;
    const pending = ((await this.#runner.get(CHARGE, attemptId))?.body as unknown as ChargeBody | undefined)?.pending?.intentId;
    const keep: string[] = [];
    for (const i of all) {
      const b = i === add || i === pending || extra.includes(i) ? undefined : (await this.#runner.get(KIND, i))?.body as unknown as StopIntentBody | undefined;
      if (i === add || i === pending || extra.includes(i) || (b !== undefined && (!TERMINAL.includes(b.phase) || b.outcome?.unresolved.includes(CLEANUP_UNPAID) === true))) keep.push(i);
    }
    return keep;
  }

  /** Writes the per-attempt charge record if it is still at the revision it was read at (false when someone else got there first and the caller should try again later). */
  async #note(attemptId: string, revision: number | undefined, body: ChargeBody): Promise<boolean> {
    const ref: AggregateRef = { kind: CHARGE, id: attemptId };
    const openRef: AggregateRef = { kind: OPEN, id: attemptId };
    const next = clean(body);
    const digest = createHash("sha256").update(JSON.stringify(next)).digest("hex").slice(0, 16);
    try {
      await this.#runner.command("stop.charge-note", { commandId: `stop-chg-${attemptId}-${revision ?? 0}-${digest}`.slice(0, 200), actor: "system" }, async () => ({
        payload: { attemptId, revision: revision ?? 0 },
        build: async () => {
          // The index of open charges is kept in the same operation as the note.
          const open = await this.#runner.get(OPEN, attemptId);
          const had = open?.body as unknown as OpenBody | undefined;
          // What a request wanted charged stays on the entry until the attempt's total covers it.
          const want = had?.want !== undefined && (had.want.costMicros > body.costMicros || had.want.computeMs > body.computeMs) ? had.want : undefined;
          const idx: JsonObject | undefined = body.pending !== undefined
            ? clean({ intents: await this.#listed(attemptId, had?.intents ?? [], body.pending.intentId, [had?.want?.intentId]), settled: false, ...(want === undefined ? {} : { want }) })
            : had === undefined || (had.settled && had.want === want) ? undefined : clean({ intents: had.intents, settled: true, ...(want === undefined ? {} : { want }) });
          const indexChange: Change[] = idx === undefined ? [] : [open === undefined ? { type: "create", ref: openRef, body: idx } : { type: "update", ref: openRef, expectedRevision: open.revision, body: idx }];
          return { ref, creates: revision === undefined, changes: [revision === undefined ? { type: "create", ref, body: next } : { type: "update", ref, expectedRevision: revision, body: next }, ...indexChange], detail: { attemptId } };
        },
      }));
      return true;
    } catch (error) {
      // An entry the sweep dropped between the read and the write is a lost race too: the next try creates it again.
      if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict" || error.code === "not_found")) return false;
      throw error;
    }
  }

  /** Makes the charge a record has noted as pending and clears the note. The same command ID is used on every try, so a charge made before a crash is not made twice. `billed` is the part not yet counted against the spend budget. */
  async #payPending(attemptId: string): Promise<{ ok: boolean; billed: number }> {
    for (let tries = 0; tries < 4; tries++) {
      const found = await this.#runner.get(CHARGE, attemptId);
      const have = found?.body as unknown as ChargeBody | undefined;
      const pending = have?.pending;
      if (found === undefined || have === undefined || pending === undefined) return { ok: true, billed: 0 };
      const dCost = pending.costMicros - have.costMicros, dCompute = pending.computeMs - have.computeMs;
      try { await this.#ports.charge!({ commandId: pending.commandId, attemptId, costMicros: dCost, computeMs: dCompute }); } catch {
        // Left pending; the spend counts against the budget once, and the next try (a later pass or a sweep) makes the charge again.
        if (pending.counted) return { ok: false, billed: 0 };
        await this.#note(attemptId, found.revision, { ...have, pending: { ...pending, counted: true } });
        return { ok: false, billed: dCost };
      }
      if (await this.#note(attemptId, found.revision, { costMicros: pending.costMicros, computeMs: pending.computeMs })) return { ok: true, billed: pending.counted ? 0 : dCost };
    }
    return { ok: false, billed: 0 };
  }

  /** Whether the open index has no entry after `after` (the last entry of a full page): a scan that read only full pages reached the end only then. */
  async #nothingAfter(after: string | undefined): Promise<boolean> {
    return after !== undefined && (await this.#runner.list(OPEN, { afterId: after, limit: 1 })).length === 0;
  }

  /**
   * Makes the charges that failed or were cut short by a crash, for any request (a sweep does this, so a charge that could not be made at the time is retried later). When every charge a finished request was waiting on is made, the
   * request's "cleanup spend not charged" mark is taken off its outcome.
   *
   * The window matters: a sweep reads `RETRY_PAGES` x 100 open entries and the rest wait for a later sweep. An entry whose charge is made and whose wanted figure is charged has nothing left to pay, so it is taken off the index
   * even while a request it lists has not finished (card L02e): that request has no debt on it, and when it settles with the "not charged" mark the sweep clears the mark once no entry lists it (`#payOwed`). Kept on the index only
   * for a request the sweep could not pay, one whose record it could not read, one that still owes a figure of its own, or one some entry past the cut lists: otherwise entries that stay only for an unfinished request would fill
   * every window and keep a later unpaid charge from ever being reached.
   */
  async #retryCharges(by: Principal): Promise<void> {
    const cleared = new Set<string>();
    const stuck = new Set<string>();
    // Requests listed on a settled entry that have not finished yet: nothing to pay for them there, so they hold nothing back (see above).
    const live = new Set<string>();
    // Requests an entry past the cut lists: their marks are kept (that entry was not paid by this sweep), but the paid entries in the window that list them are still taken off (see below).
    const pastCut = new Set<string>();
    const finished: { attemptId: string; revision: number }[] = [];
    // Only the open entries are read (not every charge record ever written); a sweep pays up to RETRY_PAGES x 100 of them and the rest wait for the next sweep.
    let after: string | undefined, complete = false;
    for (let pages = 0; pages < RETRY_PAGES; pages++) {
      const page = await this.#runner.list(OPEN, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const rec of page) {
        after = rec.id;
        const open = rec.body as unknown as OpenBody;
        let ok = (await this.#payPending(rec.id)).ok;
        // A figure a request reported while another request's note stood in the way is charged now that the note is paid; its requests are cleared only when that is charged too.
        if (ok && open.want !== undefined) {
          const have = (await this.#runner.get(CHARGE, rec.id))?.body as unknown as ChargeBody | undefined;
          if (have === undefined || have.costMicros < open.want.costMicros || have.computeMs < open.want.computeMs) {
            // One contended entry (its wait lost six races) holds back only itself: the want stays on the entry, so the next sweep tries again, and the other entries go on.
            const wanted = await this.#charge(open.want.intentId, by, [{ attemptId: rec.id, costMicros: open.want.costMicros, computeMs: open.want.computeMs }]).catch((e: unknown) => { if (e instanceof DomainError && e.code === "stale_revision") return { costMicros: 0, failed: true }; throw e; });
            ok = !wanted.failed;
          }
        }
        // A request is cleared when every charge it waited on is made, also one that another request (a concurrent stop of the same attempt) made.
        for (const intentId of open.intents) { if (ok) cleared.add(intentId); else stuck.add(intentId); }
        if (ok) finished.push({ attemptId: rec.id, revision: rec.revision });
      }
      if (page.length < 100) { complete = true; break; }
    }
    // An entry past the cut was not paid by this sweep, so the mark of every request it lists is kept: the rest of the index is read (only read, nothing is paid) to find them. They go in `pastCut`, not `stuck`: a paid entry
    // in the window that lists such a request is still taken off, since the entry past the cut keeps listing the request and its mark is cleared once that entry is paid. Holding the window's paid entries back for it would
    // keep the same entries in the window on every sweep, and the entries past the cut would never be paid.
    while (!complete) {
      const page = await this.#runner.list(OPEN, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const rec of page) { after = rec.id; for (const intentId of (rec.body as unknown as OpenBody).intents) pastCut.add(intentId); }
      if (page.length < 100) complete = true;
    }
    for (const intentId of cleared) {
      if (stuck.has(intentId) || pastCut.has(intentId)) continue;
      // A request that has not finished has no outcome to clear yet (its mark may still be written): it stays listed. Nor is a request cleared while it still owes a figure of its own (`owed`): its mark stays until
      // `#payOwed` has charged that too, and it stays listed here. A clear that fails is tried again by the next sweep.
      const x0 = (await this.#runner.get(KIND, intentId))?.body as unknown as StopIntentBody | undefined;
      if (x0 === undefined || (x0.owed?.length ?? 0) > 0) { stuck.add(intentId); continue; }
      // Not finished: it has no mark to clear and nothing left on a settled entry, so it does not hold that entry (its own note, when it writes one, puts the entry back).
      if (!TERMINAL.includes(x0.phase)) { live.add(intentId); continue; }
      let owes = false;
      const wrote = await this.#update(intentId, (x) => {
        owes = (x.owed?.length ?? 0) > 0;
        return owes || x.outcome === undefined || !x.outcome.unresolved.includes(CLEANUP_UNPAID) ? x : { ...x, outcome: { ...x.outcome, unresolved: x.outcome.unresolved.filter((u) => u !== CLEANUP_UNPAID) }, history: this.#push(x, x.phase, "system", "the cleanup spend was charged later") };
      }).catch(() => false);
      if (!wrote || owes) stuck.add(intentId);
    }
    // A settled entry whose requests are cleared is taken off the index (the per-attempt running total stays: it is what keeps a later stop from charging twice).
    for (const f of finished) {
      const now = await this.#runner.get(OPEN, f.attemptId);
      const charge = (await this.#runner.get(CHARGE, f.attemptId))?.body as unknown as ChargeBody | undefined;
      const wants = (now?.body as unknown as OpenBody | undefined)?.want;
      const holds = (i: string): boolean => stuck.has(i) || (!cleared.has(i) && !live.has(i));
      if (now === undefined || charge?.pending !== undefined || (now.body as unknown as OpenBody).intents.some(holds) || (wants !== undefined && (charge === undefined || charge.costMicros < wants.costMicros || charge.computeMs < wants.computeMs))) continue;
      await this.#runner.command("stop.charge-index-drop", { commandId: `stop-drop-${f.attemptId}-${now.revision}`.slice(0, 200), actor: "system" }, async () => ({
        payload: { attemptId: f.attemptId, revision: now.revision },
        build: async () => ({ ref: { kind: OPEN, id: f.attemptId }, creates: false, changes: [{ type: "delete", ref: { kind: OPEN, id: f.attemptId }, expectedRevision: now.revision }], detail: { attemptId: f.attemptId } }),
      })).catch(() => undefined);
    }
  }

  /**
   * Whether an agent is at rest because a Suspend or Stop of its own, or of a team above it, finished (card M04h): `suspended` or `stopped`, with the request. Undefined when no such request is finished and still the cause of the
   * gate (a resume, a newer pause or an unfinished or failed stop all end it), and for a stop of the whole installation, which is the emergency brake and is never treated as a rest an invitation could lift. No viewer check: the
   * caller is a lifecycle service deciding availability, not an answer shown to anyone.
   */
  async agentRest(agentId: string): Promise<{ state: "suspended" | "stopped"; intentId: string; scope: PauseScope } | undefined> {
    if (!/^agt-[a-z2-7]{20}$/.test(agentId)) return undefined;
    const own: PauseScope = { kind: "agent", id: agentId };
    for (const scope of [own, ...(await this.#covering(own))]) {
      if (scope.kind === "installation") continue;
      const id = await this.#activeId(scope);
      const found = id === undefined ? undefined : await this.#runner.get(KIND, id);
      if (id === undefined || found === undefined) continue;
      const b = found.body as unknown as StopIntentBody;
      if (b.phase !== "done" || (b.outcome?.state !== "suspended" && b.outcome?.state !== "stopped")) continue;
      const gate = await this.#pauses.gateState(scope);
      if (gate === undefined || gate.intent !== "pause" || (b.gateRequestId !== undefined && gate.requestId !== b.gateRequestId)) continue;
      return { state: b.outcome.state, intentId: id, scope };
    }
    return undefined;
  }

  /**
   * Whether a Stop or Suspend of this task is in force: its request is not cancelled and the task is still paused. The dispatcher asks it for the swarm ancestors of a task before it starts an attempt, so a child of a stopped
   * task is not started again while the parent's stop holds (card L02d). Resuming the parent, or cancelling the request, lets go.
   * With `wider`, a Stop or Suspend of a scope above the task (its agent, a team above that, the installation) whose pause blocks the task holds too: such a Stop ends the work of the task's swarm children (card L02e), so the
   * dispatcher must not start them again either (review of card L02e). Without it only the task's own request counts (`swarm.cancel` carries on the child's own Stop).
   */
  async holding(taskId: string, child?: string, options?: { readonly wider?: boolean }): Promise<{ intentId: string; mode: StopMode; requestedBy: string } | undefined> {
    const own: PauseScope = { kind: "task", id: taskId };
    const guard = await this.#pauses.guard(taskId);
    const scopes = options?.wider === true ? guard.blockedBy : guard.blockedBy.filter((s) => s.kind === "task" && s.id === taskId);
    for (const scope of scopes) {
      const id = await this.#activeId(scope.kind === "task" && scope.id === taskId ? own : scope);
      const found = id === undefined ? undefined : await this.#runner.get(KIND, id);
      if (id === undefined || found === undefined) continue;
      const b = found.body as unknown as StopIntentBody;
      if (b.phase === "cancelled") continue;
      // The request must be the cause of the gate as it stands now: a Stop or Suspend that finished, followed by a resume, does not hold when the scope is merely paused again.
      const gate = await this.#pauses.gateState(scope);
      if (gate === undefined || gate.intent !== "pause" || (b.gateRequestId !== undefined && gate.requestId !== b.gateRequestId)) continue;
      // A child the one who asked may not control is not held by their stop.
      if (child !== undefined && this.#mayHold !== undefined && !(await this.#mayHold(b.requestedBy, child).catch(() => false))) continue;
      return { intentId: id, mode: b.mode, requestedBy: b.requestedBy };
    }
    return undefined;
  }

  /**
   * Changes the record only if it is still in one of the phases the decision was made in (`from`); otherwise someone else got there first and nothing is written (false). The command ID carries the new body's digest, so two
   * different writes at the same revision are never mistaken for one replayed command.
   */
  async #update(id: string, change: (b: StopIntentBody) => StopIntentBody, from?: readonly StopPhase[]): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get(KIND, id);
      if (found === undefined) throw new DomainError("not_found", "no such stop request");
      if (from !== undefined && !from.includes((found.body as unknown as StopIntentBody).phase)) return false;
      const next = change(found.body as unknown as StopIntentBody);
      const digest = createHash("sha256").update(JSON.stringify(clean(next))).digest("hex").slice(0, 16);
      try {
        await this.#runner.command("stop.advance", { commandId: `stop-adv-${id.slice(4)}-${found.revision}-${digest}`, actor: "system" }, async () => ({
          payload: { phase: next.phase, revision: found.revision },
          build: async () => ({ ref: { kind: KIND, id }, creates: false, changes: [{ type: "update", ref: { kind: KIND, id }, expectedRevision: found.revision, body: clean(next) }], detail: { phase: next.phase } }),
        }));
        return true;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 6) throw error;
      }
    }
  }

  async #block(id: string, by: string, reason: string, from: readonly StopPhase[], resume?: StopPhase): Promise<void> {
    await this.#update(id, (x) => ({ ...x, phase: "blocked", blocked: { reason, choices: STOP_CHOICES, ...(resume === undefined ? {} : { resume }) }, history: this.#push(x, "blocked", by, reason) }), from);
  }

  async #settle(id: string, by: Principal, outcome: StopOutcome, phase: "done" | "recovery-required", note: string, from: readonly StopPhase[]): Promise<void> {
    await this.#update(id, (x) => ({ ...x, phase, blocked: undefined, outcome, history: this.#push(x, phase, by.id, note) }), from);
    const b = (await this.#runner.get(KIND, id))?.body as unknown as StopIntentBody | undefined;
    if (b !== undefined) try { await this.#onSettled?.(by, { intentId: id, scope: b.scope, mode: b.mode, outcome }); } catch { /* the record of it is best effort */ }
  }

  /** Tells the pause gate what was reached. The intent's own record is the durable source; a refusal here (the gate was resumed meanwhile) does not undo it. */
  async #observe(by: Principal, scope: PauseScope, intentId: string, state: "preparing-to-suspend" | "suspended" | "stopping" | "stopped" | "recovery-required", evidence: string): Promise<void> {
    try { await this.#pauses.observe(by, { commandId: `stop-obs-${intentId.slice(4)}-${state}`, scope, state, evidence }); } catch (error) { if (!(error instanceof DomainError)) throw error; }
  }
}

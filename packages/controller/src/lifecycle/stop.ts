import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { PauseScope, PauseService } from "./pause.js";

/** `suspend` stops at a durable checkpoint; `stop` goes on to end execution; `force-stop` skips preparation. */
export type StopMode = "suspend" | "stop" | "force-stop";
export type StopPhase = "preparing" | "blocked" | "prepared" | "terminating" | "done" | "recovery-required" | "cancelled";
export const STOP_CHOICES = ["wait", "restart-earlier-boundary", "force-stop"] as const;
export type StopChoice = (typeof STOP_CHOICES)[number];

/** One thing that may still be running for the scope (the inventory covers foreground operations, local processes, T07 jobs and delegated child work). */
export interface InventoryItem { readonly kind: "foreground" | "process" | "job" | "child"; readonly ref: string; readonly state: "settled" | "running" | "uncooperative" | "unknown" }

/** What the controller asks of the runtime. Every call must be safe to repeat: a restart makes the same call again. */
export interface StopPorts {
  /** What is running for the scope. `lookOnly` asks for a look that remembers and changes nothing (readiness checks). */
  inventory(scope: PauseScope, options?: { lookOnly?: boolean }): Promise<readonly InventoryItem[]>;
  /** Lets go of what preparation froze, when the request is cancelled because the scope was resumed. Best effort. */
  release?(scope: PauseScope): Promise<void>;
  /** Why a stop cannot be done for this scope at all (so it is refused before anything is paused or recorded), or undefined. */
  unsupported?(scope: PauseScope): string | undefined;
  /** Scoped cleanup only (finish or checkpoint what is running, nothing new). `backup` asks for an eligible backup model after the first one was lost. */
  cleanup(scope: PauseScope, options: { deadlineAt: string; spendBudget?: number; backup: boolean }): Promise<{ remaining: readonly InventoryItem[]; spent?: number; modelLost?: boolean }>;
  /** The checkpoint of the scope's state, and whether it and the artifacts it names are durable. */
  checkpoint(scope: PauseScope): Promise<{ checkpointId: string; durable: boolean; artifactsDurable: boolean }>;
  /** Ends execution. `force` skips waiting. `unresolved` names what could not be settled (effects of unknown outcome, children still running). */
  terminate(scope: PauseScope, options: { force: boolean }): Promise<{ ended: boolean; unresolved: readonly string[] }>;
}

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
  readonly inventory: readonly InventoryItem[];
  readonly blocked?: { readonly reason: string; readonly choices: readonly StopChoice[]; /** The phase `wait` goes back to. */ readonly resume?: StopPhase } | undefined;
  /** The pause request that held the scope when this request was made: a later stop reuses this request's checkpoint only if the same hold is still in place. */
  readonly gateRequestId?: string;
  readonly outcome?: StopOutcome;
  readonly forced?: { readonly by: string; readonly reason: string; readonly at: string };
  readonly history: readonly { readonly phase: StopPhase; readonly at: string; readonly by: string; readonly note: string }[];
}

export const STOP_LIMITS = { reason: 500, deadlineMs: { default: 60_000, max: 3_600_000 }, inventory: 100, history: 60, advances: 8 } as const;
const KIND = "stop-intent";
const ACTIVE = "stop-active";
const FORCE_REF = "stop-force-ref";
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
  private constructor(runner: CommandRunner, pauses: PauseService, ports: StopPorts, onSettled?: StopSettled) { this.#runner = runner; this.#pauses = pauses; this.#ports = ports; this.#onSettled = onSettled; }

  static withEpoch(storage: ControllerStorage, epoch: number, pauses: PauseService, ports: StopPorts, options: RunnerOptions & { /** Told when a request reaches its end (best effort: a failure never undoes the stop). */ onSettled?: StopSettled } = {}): StopService {
    return new StopService(new CommandRunner(storage, epoch, options), pauses, ports, options.onSettled);
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
          scope, ...(target.projectId === undefined ? {} : { projectId: target.projectId }), mode: command.mode, phase: reuse === undefined ? "preparing" : "prepared", ...(reuse === undefined ? {} : { prepared: reuse }), ...(gateRequestId === undefined ? {} : { gateRequestId }), requestedBy: by.id, requestedAt: at, reason,
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
    let id = await this.#activeId(scope);
    const existing = id === undefined ? undefined : await this.#runner.get(KIND, id);
    if (existing === undefined || TERMINAL.includes((existing.body as unknown as StopIntentBody).phase)) {
      id = derivedId("stp", scopedCommandId(by.id, command.commandId));
      await this.#create(by, command.commandId, id, scope, target.projectId, "force-stop", reason);
    } else {
      const ref: AggregateRef = { kind: FORCE_REF, id: mine };
      await this.#runner.command("stop.force-ref", { commandId: `stop-fref-${mine.slice(4)}`, actor: by.id }, async () => ({ payload: { intentId: id! }, build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: { intentId: id! } }], detail: {} }) }));
    }
    await this.#update(id!, (b) => ({ ...b, mode: "force-stop", phase: "terminating", forced: { by: by.id, reason, at: this.#runner.now() }, blocked: undefined, history: this.#push(b, "terminating", by.id, `force stop: ${reason}`) }), ["preparing", "blocked", "prepared", "terminating"]);
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
      await this.#update(String(command.intentId), (b) => ({ ...b, phase: b.blocked?.resume ?? "preparing", blocked: undefined, deadlineAt: new Date(Date.parse(at) + extend).toISOString(), spent: 0, history: this.#push(b, b.blocked?.resume ?? "preparing", by.id, `waiting ${extend} ms more`) }), ["blocked"]);
      return { phase: body.blocked?.resume ?? "preparing" };
    }
    await this.#observe(by, body.scope, String(command.intentId), "recovery-required", "restart from an earlier boundary chosen; the scope is not suspended");
    await this.#settle(String(command.intentId), by, { state: "recovery-required", graceful: false, unresolved: body.inventory.filter((i) => i.state !== "settled").map((i) => i.ref), at }, "recovery-required", "restart from an earlier boundary chosen", ["blocked"]);
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
      if (b.phase === "preparing") {
        await this.#observe(by, b.scope, id, "preparing-to-suspend", "preparing to suspend");
        let inventory = b.inventory;
        let result: Awaited<ReturnType<StopPorts["cleanup"]>>;
        try {
          if (inventory.length === 0) inventory = (await this.#ports.inventory(b.scope)).slice(0, STOP_LIMITS.inventory);
          result = await this.#ports.cleanup(b.scope, { deadlineAt: b.deadlineAt, ...(b.spendBudget === undefined ? {} : { spendBudget: b.spendBudget }), backup: b.backupUsed });
        } catch (error) {
          await this.#block(id, by.id, `cleanup could not run: ${redactText(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, ["preparing"]);
          continue;
        }
        // Something else (a Force Stop, a choice, a resume) may have moved the request while the cleanup ran: then this pass is stale and does nothing more.
        if (((await this.#runner.get(KIND, id))?.body as unknown as StopIntentBody | undefined)?.phase !== "preparing") continue;
        const spent = b.spent + (result.spent ?? 0);
        if (result.modelLost === true && !b.backupUsed) { await this.#update(id, (x) => ({ ...x, backupUsed: true, spent, inventory, history: this.#push(x, "preparing", by.id, "the cleanup model was lost; an eligible backup model is used") }), ["preparing"]); continue; }
        if (result.modelLost === true) { await this.#block(id, by.id, "the cleanup model was lost and the backup model could not finish the cleanup", ["preparing"]); continue; }
        if (b.spendBudget !== undefined && spent > b.spendBudget && result.remaining.length > 0) { await this.#update(id, (x) => ({ ...x, spent }), ["preparing"]); await this.#block(id, by.id, "the cleanup budget is used up with work still running", ["preparing"]); continue; }
        if (result.remaining.length > 0) {
          const stuck = result.remaining.filter((i) => i.state !== "settled");
          await this.#update(id, (x) => ({ ...x, spent, inventory: result.remaining.slice(0, STOP_LIMITS.inventory) }), ["preparing"]);
          if (Date.parse(now) >= Date.parse(b.deadlineAt) || stuck.some((i) => i.state === "uncooperative")) { await this.#block(id, by.id, stuck.some((i) => i.state === "uncooperative") ? "an uncooperative operation will not settle" : "the deadline passed with work still running", ["preparing"]); continue; }
          return view<StopIntentBody>((await this.#runner.get(KIND, id))!); // still settling: the next call looks again
        }
        let cp: Awaited<ReturnType<StopPorts["checkpoint"]>>;
        try { cp = await this.#ports.checkpoint(b.scope); } catch (error) {
          await this.#block(id, by.id, `the checkpoint could not be taken: ${redactText(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, ["preparing"]);
          continue;
        }
        if (!cp.durable || !cp.artifactsDurable) { await this.#update(id, (x) => ({ ...x, spent, inventory: [] }), ["preparing"]); await this.#block(id, by.id, !cp.durable ? "the checkpoint is not durable" : "the artifacts the checkpoint names are not durable", ["preparing"]); continue; }
        await this.#update(id, (x) => ({ ...x, phase: "prepared", spent, inventory: [], prepared: { at: now, checkpointId: cp.checkpointId }, history: this.#push(x, "prepared", by.id, `checkpoint ${cp.checkpointId} is durable`) }), ["preparing"]);
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
        try { ended = await this.#ports.terminate(b.scope, { force: b.forced !== undefined }); } catch (error) {
          await this.#block(id, by.id, `execution could not be ended: ${redactText(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, ["terminating"], "terminating");
          continue;
        }
        const graceful = b.forced === undefined;
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
        if (TERMINAL.includes(b.phase)) continue;
        try { await this.advance(by, { intentId: rec.id }); advanced.push(rec.id); } catch { failed.push(rec.id); }
      }
      if (page.length < 100) break;
    }
    return { advanced, failed };
  }

  /**
   * Whether a stop of the scope could finish now, without starting one (card L06): everything the stop inventory finds for the scope that is not settled, as it is today. A look that fails is not "ready": it is reported as one unknown item.
   * `truncated` says the inventory was cut at its limit, so the list is not all of it. Nothing is paused, recorded or changed.
   */
  async readiness(by: Principal, scope: PauseScope): Promise<{ scope: PauseScope; ready: boolean; paused: boolean; unsettled: readonly InventoryItem[]; truncated: boolean }> {
    await this.#pauses.authorizeControl(by, scope);
    const clean = { kind: scope.kind, id: scope.id } as PauseScope;
    const cannot = this.#ports.unsupported?.(clean);
    if (cannot !== undefined) throw new DomainError("unavailable", cannot, { field: "scope" });
    const found = await this.#ports.inventory(clean, { lookOnly: true }).catch(() => [{ kind: "process", ref: "runtime:inventory", state: "unknown" } as InventoryItem]);
    const unsettled = found.filter((i) => i.state !== "settled");
    return { scope: clean, ready: unsettled.length === 0, paused: (await this.#pauses.gate(by, clean))?.intent === "pause", unsettled: unsettled.slice(0, STOP_LIMITS.inventory), truncated: unsettled.length > STOP_LIMITS.inventory };
  }

  async get(viewer: Principal, intentId: string): Promise<View<StopIntentBody> | undefined> {
    const found = await this.#runner.get(KIND, String(intentId));
    if (found === undefined) return undefined;
    try { await this.#pauses.authorizeControl(viewer, (found.body as unknown as StopIntentBody).scope); } catch { return undefined; }
    return view<StopIntentBody>(found);
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

  async #create(by: Principal, commandId: unknown, id: string, scope: PauseScope, projectId: string | undefined, mode: StopMode, reason: string): Promise<void> {
    const activeRef: AggregateRef = { kind: ACTIVE, id: derivedId("stp", scopeKey(scope)) };
    await this.#runner.command("stop.request", { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { scope: scope as unknown as JsonObject, mode, reason },
      build: async () => {
        const at = this.#runner.now();
        const active = await this.#runner.get(ACTIVE, activeRef.id);
        const ref: AggregateRef = { kind: KIND, id };
        const body: StopIntentBody = { scope, ...(projectId === undefined ? {} : { projectId }), mode, phase: "terminating", requestedBy: by.id, requestedAt: at, reason, deadlineAt: at, spent: 0, backupUsed: false, inventory: [], history: [{ phase: "terminating", at, by: by.id, note: `${mode} requested` }] };
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

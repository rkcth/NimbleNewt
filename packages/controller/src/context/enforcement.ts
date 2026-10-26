import type { BlockerService } from "../domain/blockers.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { sha256 } from "../storage/json.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { classifyFailure, contextBudget, handoffFromFacts, limitToolOutput, page, type BudgetOverrides, type ContextBudget, type HandoffFacts, type StartupItem, type StartupResult, type ToolOutput } from "./budget.js";
import { admitFirstCall, boundedSummarise, calibratedCharsPerToken, reviewRouteChange, SUMMARY_DEFAULTS, type FirstCallDecision, type FirstCall, type SummariseAttempt, type SummariseLimits, type Summariser } from "./dispatch.js";
import type { RetrievalService, SourceRef } from "./retrieval.js";

// Card C07b: the controller-side service the dispatcher (H12) and the Pi adapter's `beforeCompact` hook call to enforce the C07 budgets. Every decision is a durable record keyed by the task and the
// attempt (or compaction key), so a repeat after a restart finds what was decided and does not decide again.

export const ENFORCEMENT_LIMITS = { pinned: 12, pinnedSnippet: 80, material: 1_000_000, spill: 256_000, handoff: 4000, reason: 300, overflowAttempts: 10, title: 200 } as const;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const key = (field: string, value: unknown): string => (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) ? value : invalid(field, "must be 1 to 80 ASCII letters, digits, '.', '_', ':' or '-'"));
const round = (value: unknown): number => (value === undefined ? 1 : Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1000 ? (value as number) : invalid("round", "must be a whole number from 1 to 1000"));
const window = (value: unknown): number => (Number.isSafeInteger(value) ? (value as number) : invalid("window", "must be a whole number of tokens"));
const cleanReason = (value: unknown, field: string): string => redactText(text(value, field, { min: 1, max: 2000, multiline: true })).slice(0, ENFORCEMENT_LIMITS.reason);
const sameSource = (a: SourceRef, b: SourceRef): boolean => JSON.stringify(a) === JSON.stringify(b);
const handoffId = (taskId: string, attemptId: string, source: string): string => derivedId("hof", `${taskId}\0${attemptId}\0${source}`);
const label = (s: SourceRef): string => (s.kind === "desk-record" || s.kind === "owner-decision" ? s.id : `${s.scopeId}#${s.seq}`);

export interface AdmissionBody {
  readonly type: "first-call" | "route-change";
  readonly taskId: string; readonly projectId: string; readonly attemptId: string; readonly round: number; readonly window: number; readonly route: string;
  readonly admit: boolean;
  readonly startupTokens: number; readonly estimatedTokens: number; readonly rawEstimatedTokens: number; readonly workingTokens: number; readonly basis: string;
  readonly calibrationRatio?: number;
  readonly reasons: readonly string[];
  /** Set by `confirmUsage`: what the provider reported for the call that was sent. */
  readonly reported?: { readonly inputTokens: number; readonly charsPerToken: number; readonly overStartupLimit: boolean; readonly ratio: number };
  readonly decidedBy: string;
}
export interface CompactionBody {
  readonly taskId: string; readonly projectId: string; readonly key: string; readonly compressorId: string;
  readonly state: "started" | "done" | "failed";
  readonly generation: number; readonly parent?: string; readonly lineage: readonly string[];
  readonly sources: readonly SourceRef[]; readonly pinned: readonly SourceRef[];
  readonly title: string;
  /** Kept so that finishing the step after a restart writes exactly this text; readers get it only through the retrieval summary (`readSummary`), which checks every source. */
  readonly summary?: string; readonly digest?: string; readonly summaryId?: string;
  readonly route?: string; readonly degraded?: boolean; readonly attempts?: readonly SummariseAttempt[];
  readonly reason?: string; readonly superseded?: true; readonly startedBy: string;
}
export interface OverflowBody { readonly taskId: string; readonly count: number; readonly total: number; readonly events: readonly string[]; readonly last?: string; readonly blockerId?: string }
export interface HandoffBody { readonly taskId: string; readonly projectId: string; readonly attemptId: string; readonly source: "attempt" | "controller"; readonly text: string; readonly endedBecause: string; readonly writtenBy: string }
interface CalibrationBody { readonly taskId: string; readonly route: string; readonly ratio: number; readonly charsPerToken: number; readonly reportedTokens: number; readonly attemptId: string }
interface ChainBody { readonly taskId: string; readonly head?: string; readonly count: number }
interface SpillBody { readonly taskId: string; readonly projectId: string; readonly tool: string; readonly callId: string; readonly remainder: string; readonly remainderChars: number; readonly lostChars: number }

export interface EnforcementOptions extends RunnerOptions {
  /** Context-window overrides for the budgets (shares, characters per token); validated by `contextBudget`. */
  readonly budget?: BudgetOverrides;
  /** Consecutive overflows of one task before a blocker (default 2). */
  readonly maxOverflows?: number;
  readonly summary?: Partial<SummariseLimits>;
}
export interface OverflowAction { readonly action: "none" | "restart-fresh" | "blocked"; readonly count: number; readonly reason: string; readonly blockerId?: string }
export type CompactionOutcome =
  | { readonly kind: "summary"; readonly id: string; readonly summary: string; readonly summaryId: string; readonly route: string; readonly degraded: boolean; readonly generation: number; readonly lineage: readonly string[]; readonly attempts: readonly SummariseAttempt[]; readonly replayed: boolean }
  | { readonly kind: "aborted"; readonly id: string }
  | { readonly kind: "superseded"; readonly id: string; readonly reason: string }
  | { readonly kind: "overflow"; readonly id: string; readonly reason: string; readonly attempts: readonly SummariseAttempt[]; readonly overflow: OverflowAction; readonly replayed: boolean };

/**
 * Enforcement of the context budgets at dispatch (card C07b). It does five jobs, each a small durable record so that repeating a call after a restart is safe:
 * - **Admission.** The first call is measured (Pi's system prompt and tool schemas included, the provider's reported size winning when larger) against the startup and working limits; a refusal opens a
 *   visible `context_overflow` blocker and the call is not sent. A route with a smaller window rebuilds the context view or blocks. One compressor per context.
 * - **Compaction.** A bounded summariser chain (its own timeout per route, a fallback route, a deterministic fallback summary) or, failing that, `context_overflow`. The record is written before and after,
 *   the summary is stored once, lineage and the owner decisions to keep are carried forward, and the readable summary is a retrieval summary (readable only by someone who can read every source).
 * - **Overflow.** Counted per task; repeated overflow ends in a blocker.
 * - **Tool output.** One gate for Pi's tools and MCP tools: cut to the window's limit, the remainder kept and paged.
 * - **Hand-off.** Written from the ledger and artifacts when an attempt ends without one.
 */
export class ContextEnforcementService {
  readonly #runner: CommandRunner;
  readonly #blockers: BlockerService;
  readonly #retrieval: RetrievalService;
  readonly #overrides: BudgetOverrides;
  readonly #maxOverflows: number;
  readonly #summary: Partial<SummariseLimits>;

  private constructor(runner: CommandRunner, deps: { blockers: BlockerService; retrieval: RetrievalService }, options: EnforcementOptions) {
    this.#runner = runner; this.#blockers = deps.blockers; this.#retrieval = deps.retrieval;
    this.#overrides = options.budget ?? {};
    contextBudget(131_072, this.#overrides); // validates the overrides now, not at the first call
    this.#maxOverflows = options.maxOverflows ?? 2;
    if (!Number.isSafeInteger(this.#maxOverflows) || this.#maxOverflows < 1 || this.#maxOverflows > 10) throw new RangeError("maxOverflows must be a whole number from 1 to 10");
    this.#summary = options.summary ?? {};
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: { blockers: BlockerService; retrieval: RetrievalService }, options: EnforcementOptions = {}): ContextEnforcementService {
    if (deps.blockers.epoch !== epoch) throw new DomainError("invalid_command", "epoch: must be the epoch the blocker service writes under", { field: "epoch" });
    return new ContextEnforcementService(new CommandRunner(storage, epoch, options), deps, options);
  }

  budget(windowTokens: number): ContextBudget { return contextBudget(windowTokens, this.#overrides); }

  async #task(principal: Principal, taskId: string, forRead = false): Promise<string | undefined> {
    const task = await this.#runner.get("task", taskId);
    const projectId = (task?.body as unknown as TaskBody | undefined)?.projectId;
    // A task the caller may not work on reads exactly like one that does not exist.
    if (projectId === undefined || !allows(principal, "attempt.work", projectId, { resource: { kind: "task", id: taskId } })) {
      if (forRead) return undefined;
      throw new DomainError("forbidden", `${principal.id} may not work on that task`);
    }
    return projectId;
  }
  /** The dispatcher's methods are for the controller, its hosts and services (the same gate as R01's model calls), never for an agent, whatever its grants. */
  async #dispatch(principal: Principal, taskId: string): Promise<string> {
    if (!(principal.kind === "owner" || principal.kind === "host" || principal.kind === "service")) throw new DomainError("forbidden", `${principal.id} is not the dispatcher; context enforcement is the controller's and its hosts'`);
    const projectId = ((await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined)?.projectId;
    if (projectId === undefined) throw new DomainError("not_found", `task ${taskId} does not exist`);
    return projectId;
  }
  async #block(principal: Principal, taskId: string, summary: string): Promise<string> {
    const subject: AggregateRef = { kind: "task", id: taskId };
    const open = await this.#blockers.openFor("context_overflow", subject);
    if (open !== undefined) return open.id;
    const n = (await this.#blockers.occurrences("context_overflow", subject)) + 1;
    const r = await this.#blockers.openBlocker({ commandId: `ctx-blk-${derivedId("ctx", `${taskId}\0blk`).slice(4)}-${n}`, actor: principal.id, type: "context_overflow", subject, summary: summary.slice(0, 1000), resolver: "owner" });
    return r.id;
  }
  /** Writes one record if it is not there; a repeat of the same command is its recorded result. */
  async #create(principal: Principal, type: string, commandId: string, ref: AggregateRef, body: JsonObject, payload: JsonObject): Promise<void> {
    await this.#runner.command(type, { commandId, actor: principal.id }, async () => ({ payload, build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body }], detail: {} }) }));
  }

  // ---- admission --------------------------------------------------------------------------------------------------------------

  /**
   * Decides whether the first call of an attempt may be sent. Repeating it (same task, attempt and round) answers with the recorded decision; a refusal has opened a blocker. While a `context_overflow`
   * blocker is open on the task nothing is admitted. If an earlier confirmed call on the same route (`route`, default one per window) was larger than estimated, the estimate is scaled by that ratio.
   */
  async admit(principal: Principal, command: { taskId: string; attemptId: string; round?: number; window: number; route?: string; call: FirstCall }): Promise<FirstCallDecision & { id: string; blockerId?: string; replayed: boolean }> {
    onlyKnown(command, ["taskId", "attemptId", "round", "window", "route", "call"]);
    const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId); const r = round(command.round); const w = window(command.window);
    const route = command.route === undefined ? `window-${w}` : key("route", command.route);
    const projectId = (await this.#dispatch(principal, taskId))!;
    const budget = this.budget(w);
    onlyKnown(command.call, ["systemPromptChars", "toolSchemaChars", "startupTokens", "replyReserveTokens", "likelyToolOutputTokens", "reportedInputTokens"]);
    const call = command.call;
    const id = derivedId("adm", `${taskId}\0${attemptId}\0first\0${r}`);
    const ref: AggregateRef = { kind: "ctx-admission", id };
    let raw: FirstCallDecision;
    try { raw = admitFirstCall(call, budget); } catch (error) { if (error instanceof RangeError) return invalid("call", error.message); throw error; }
    const calibration = (await this.#runner.get("ctx-calibration", derivedId("ctx", `${taskId}\0${route}\0calibration`)))?.body as unknown as CalibrationBody | undefined;
    const ratio = call.reportedInputTokens === undefined ? Math.max(1, calibration?.ratio ?? 1) : 1;
    const scaled: FirstCall = ratio === 1 ? call : { ...call, systemPromptChars: Math.ceil(call.systemPromptChars * ratio), toolSchemaChars: Math.ceil(call.toolSchemaChars * ratio), startupTokens: Math.ceil(call.startupTokens * ratio) };
    let decision = admitFirstCall(scaled, budget);
    if (ratio > 1) decision = { ...decision, reasons: decision.admit ? [] : [...decision.reasons, `(the estimate was scaled by ${ratio}: an earlier call on route ${route} was reported at that multiple of its estimate)`] };
    // Nothing new is admitted while the task is blocked for context overflow (an earlier decision of this very call is still answered as recorded).
    const open = await this.#blockers.openFor("context_overflow", { kind: "task", id: taskId });
    if (open !== undefined && (await this.#runner.get(ref.kind, id)) === undefined) decision = { ...decision, admit: false, reasons: [`a context_overflow blocker is open on this task (${open.id}); it must be resolved first`, ...decision.reasons] };
    const body: AdmissionBody = { type: "first-call", taskId, projectId, attemptId, round: r, window: w, route, admit: decision.admit, startupTokens: decision.startupTokens, estimatedTokens: decision.estimatedTokens, rawEstimatedTokens: raw.estimatedTokens, workingTokens: decision.workingTokens, basis: decision.basis, reasons: decision.reasons, ...(ratio > 1 ? { calibrationRatio: ratio } : {}), decidedBy: principal.id };
    const run = await this.#runner.command("context.admit", { commandId: `ctx-adm-${id.slice(4)}`, actor: principal.id }, async () => ({
      payload: { taskId, attemptId, round: r, window: w, route, call: call as unknown as JsonObject },
      build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { admit: decision.admit } }),
    }));
    const recorded = view<AdmissionBody>((await this.#runner.get(ref.kind, id))!);
    const blockerId = recorded.admit ? undefined : await this.#block(principal, taskId, `The first call of attempt ${attemptId} was not sent: ${recorded.reasons.join("; ")}.`);
    return { admit: recorded.admit, startupTokens: recorded.startupTokens, estimatedTokens: recorded.estimatedTokens, basis: recorded.basis as FirstCallDecision["basis"], workingTokens: recorded.workingTokens, limits: { startup: budget.startupTokens, working: budget.workingTokens }, reasons: recorded.reasons, id, ...(blockerId === undefined ? {} : { blockerId }), replayed: run.replayed };
  }

  /**
   * After the call went out: records the size the provider reported and what characters per token it implies, whether the call was in fact over the startup limit, and (per task and route) how far the
   * estimate was off, which later `admit` calls on that route apply.
   */
  async confirmUsage(principal: Principal, command: { taskId: string; attemptId: string; round?: number; reportedInputTokens: number; promptChars: number }): Promise<{ charsPerToken: number; overStartupLimit: boolean; ratio: number; replayed: boolean }> {
    onlyKnown(command, ["taskId", "attemptId", "round", "reportedInputTokens", "promptChars"]);
    const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId);
    await this.#dispatch(principal, taskId);
    const id = derivedId("adm", `${taskId}\0${attemptId}\0first\0${round(command.round)}`);
    let cpt: number;
    try { cpt = calibratedCharsPerToken(command.promptChars, command.reportedInputTokens); } catch (error) { if (error instanceof RangeError) return invalid("reportedInputTokens", error.message); throw error; }
    const r = await this.#runner.command("context.confirm", { commandId: `ctx-cnf-${id.slice(4)}`, actor: principal.id }, async () => ({
      payload: { taskId, attemptId, round: round(command.round), reportedInputTokens: command.reportedInputTokens, promptChars: command.promptChars },
      build: async () => {
        const found = await this.#runner.get("ctx-admission", id);
        if (found === undefined) throw new DomainError("not_found", "no first call was admitted for that attempt");
        const body = found.body as unknown as AdmissionBody;
        const over = command.reportedInputTokens > this.budget(body.window).startupTokens;
        const ratio = Math.min(10, Math.round((command.reportedInputTokens / Math.max(1, body.rawEstimatedTokens)) * 100) / 100);
        const next: AdmissionBody = { ...body, reported: { inputTokens: command.reportedInputTokens, charsPerToken: cpt, overStartupLimit: over, ratio } };
        const ref: AggregateRef = { kind: "ctx-admission", id };
        const calRef: AggregateRef = { kind: "ctx-calibration", id: derivedId("ctx", `${taskId}\0${body.route}\0calibration`) };
        const cal = await this.#runner.get(calRef.kind, calRef.id);
        const calBody: CalibrationBody = { taskId, route: body.route, ratio: cal === undefined ? ratio : Math.max(ratio, Math.round((cal.body as unknown as CalibrationBody).ratio * 80) / 100), charsPerToken: cpt, reportedTokens: command.reportedInputTokens, attemptId };
        return {
          ref, creates: false,
          changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }, cal === undefined ? { type: "create", ref: calRef, body: calBody as unknown as JsonObject } : { type: "update", ref: calRef, expectedRevision: cal.revision, body: calBody as unknown as JsonObject }],
          detail: { over, ratio },
        };
      },
    }));
    const body = (await this.#runner.get("ctx-admission", id))!.body as unknown as AdmissionBody;
    return { charsPerToken: body.reported!.charsPerToken, overStartupLimit: body.reported!.overStartupLimit, ratio: body.reported!.ratio, replayed: r.replayed };
  }

  /**
   * Falling back to a route with a smaller window: the startup context is built again for that window and that route's fixed part; if what must stay whole does not fit, a blocker is opened and nothing
   * is to be sent. The cut text is returned for archiving. Repeating it answers with the recorded decision (the view is rebuilt from the same items).
   */
  async changeRoute(principal: Principal, command: { taskId: string; attemptId: string; round?: number; window: number; fixedTokens: number; items: readonly StartupItem[] }): Promise<{ rebuilt: boolean; startup: StartupResult; reason?: string; blockerId?: string; id: string; replayed: boolean }> {
    onlyKnown(command, ["taskId", "attemptId", "round", "window", "fixedTokens", "items"]);
    const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId); const r = round(command.round); const w = window(command.window);
    const projectId = (await this.#dispatch(principal, taskId))!;
    if (!Array.isArray(command.items) || command.items.length > 1000) invalid("items", "must be a list of at most 1000 items");
    let review: ReturnType<typeof reviewRouteChange>;
    try { review = reviewRouteChange(command.items, this.budget(w), command.fixedTokens); } catch (error) { if (error instanceof RangeError) return invalid("fixedTokens", error.message); throw error; }
    const id = derivedId("adm", `${taskId}\0${attemptId}\0route\0${r}`);
    const ref: AggregateRef = { kind: "ctx-admission", id };
    const reasons = review.kind === "blocked" ? [review.reason] : [];
    const body: AdmissionBody = { type: "route-change", taskId, projectId, attemptId, round: r, window: w, route: `window-${w}`, admit: review.kind === "rebuilt", startupTokens: review.startup.tokens + command.fixedTokens, estimatedTokens: review.startup.tokens + command.fixedTokens, rawEstimatedTokens: review.startup.tokens + command.fixedTokens, workingTokens: 0, basis: "estimated", reasons, decidedBy: principal.id };
    const run = await this.#runner.command("context.route", { commandId: `ctx-rte-${id.slice(4)}`, actor: principal.id }, async () => ({
      payload: { taskId, attemptId, round: r, window: w, fixedTokens: command.fixedTokens, items: sha256(JSON.stringify(command.items)) },
      build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { rebuilt: review.kind === "rebuilt" } }),
    }));
    const blockerId = review.kind === "blocked" ? await this.#block(principal, taskId, `Attempt ${attemptId} cannot move to the ${w}-token route: ${review.reason}.`) : undefined;
    return { rebuilt: review.kind === "rebuilt", startup: review.startup, ...(review.kind === "blocked" ? { reason: review.reason } : {}), ...(blockerId === undefined ? {} : { blockerId }), id, replayed: run.replayed };
  }

  // ---- one compressor per context ----------------------------------------------------------------------------------------

  /** Registers the one thing that may compress this task's context. A second, different compressor is refused; registering the same one again is a no-op. */
  async registerCompressor(principal: Principal, command: { taskId: string; compressorId: string }): Promise<{ compressorId: string; replayed: boolean }> {
    onlyKnown(command, ["taskId", "compressorId"]);
    const taskId = checkTaskId(command.taskId); const compressorId = key("compressorId", command.compressorId);
    await this.#dispatch(principal, taskId);
    const ref: AggregateRef = { kind: "ctx-compressor", id: derivedId("ctx", `${taskId}\0compressor`) };
    const existing = await this.#runner.get(ref.kind, ref.id);
    const current = (existing?.body as unknown as { compressorId: string } | undefined)?.compressorId;
    if (current !== undefined && current !== compressorId) throw new DomainError("invalid_command", `compressor ${current} is already registered on this context; a second compressor (${compressorId}) would compress it twice`, { field: "compressorId" });
    try {
      const r = await this.#runner.command("context.compressor", { commandId: `ctx-cmp-${ref.id.slice(4)}-${sha256(compressorId).slice(0, 16)}`, actor: principal.id }, async () => ({
        payload: { taskId, compressorId },
        build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: { taskId, compressorId, registeredBy: principal.id } }], detail: { compressorId } }),
      }));
      return { compressorId, replayed: r.replayed };
    } catch (error) {
      // Two different compressors registering at once: the loser meets the winner's record.
      if (error instanceof DomainError && error.code === "command_conflict") throw new DomainError("invalid_command", "another compressor was registered on this context first", { field: "compressorId", cause: error });
      throw error;
    }
  }

  // ---- compaction ----------------------------------------------------------------------------------------------------------

  /**
   * One compaction of a task's context, by its registered compressor. `key` names it (the same key is the same compaction, whatever restarts happen: a finished one is answered from its record and the
   * summariser is not called again). `parent` must be the latest compaction of the task, so the chain is a line. `pinned` are the owner decisions (desk records or history entries) that must stay retrievable:
   * they are carried through every later compaction and written into the summary. `sources` are what the summary was made from; the summary is a retrieval summary of them and is readable only by
   * someone who can read every one. If no summariser (each under its own timeout, then the fallback) produces a smaller summary, the compaction fails as `context_overflow` and counts toward the blocker.
   */
  async compact(principal: Principal, command: { taskId: string; attemptId: string; key: string; compressorId: string; title: string; material: string; sources: readonly SourceRef[]; pinned?: readonly SourceRef[]; parent?: string; window?: number }, summarisers: readonly Summariser[], options: { extractive?: boolean; signal?: AbortSignal } = {}): Promise<CompactionOutcome> {
    onlyKnown(command, ["taskId", "attemptId", "key", "compressorId", "title", "material", "sources", "pinned", "parent", "window"]);
    const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId); const k = key("key", command.key); const compressorId = key("compressorId", command.compressorId);
    const projectId = (await this.#dispatch(principal, taskId))!;
    const title = text(command.title, "title", { min: 1, max: ENFORCEMENT_LIMITS.title });
    const material = text(command.material, "material", { min: 1, max: ENFORCEMENT_LIMITS.material, multiline: true });
    const id = derivedId("cmp", `${taskId}\0${k}`);
    const ref: AggregateRef = { kind: "ctx-compaction", id };
    const registered = (await this.#runner.get("ctx-compressor", derivedId("ctx", `${taskId}\0compressor`)))?.body as unknown as { compressorId: string } | undefined;
    if (registered?.compressorId !== compressorId) throw new DomainError("invalid_command", registered === undefined ? "no compressor is registered on this context" : `${compressorId} is not the registered compressor (${registered.compressorId})`, { field: "compressorId" });

    let record = await this.#runner.get(ref.kind, id);
    if (record === undefined) record = await this.#begin(principal, { taskId, projectId, k, id, ref, compressorId, title, command });
    let body = record.body as unknown as CompactionBody;
    // A repeat of a finished or failed compaction answers from the record.
    if (body.state === "failed" && body.superseded === true) return { kind: "superseded", id, reason: body.reason ?? "" };
    if (body.state === "failed") return { kind: "overflow", id, reason: body.reason ?? "", attempts: body.attempts ?? [], overflow: await this.#overflowAction(taskId), replayed: true };
    let replayed = true;
    if (body.state === "started") {
      replayed = false;
      const pinnedLines = await this.#pinnedLines(principal, body.pinned);
      const result = await boundedSummarise(material, summarisers, { ...SUMMARY_DEFAULTS, ...this.#summary }, { pinned: pinnedLines, extractive: options.extractive ?? true, ...(options.signal === undefined ? {} : { signal: options.signal }) });
      // The caller (the adapter's hook) gave up: nothing is recorded as done or published, so no summary exists that the conversation does not have. The record stays `started` and a later run of the key resumes.
      if (result.kind === "aborted" || (result.kind === "summary" && options.signal?.aborted === true)) return { kind: "aborted", id };
      if (result.kind === "overflow") {
        await this.#firstWriterWins(ref, () => this.#runner.command("context.compaction.fail", { commandId: `ctx-cfl-${id.slice(4)}`, actor: principal.id }, async () => ({
          // The payload names the compaction only: two runs of one key may fail with different notes, and the first recorded one stands.
          payload: { id },
          build: async () => {
            const found = await this.#runner.get(ref.kind, id);
            if (found === undefined) throw new DomainError("not_found", "compaction record is missing");
            const b = found.body as unknown as CompactionBody;
            // A result already recorded by a concurrent run of this key stands.
            if (b.state !== "started") return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found.revision }], detail: { kept: b.state } };
            const next: CompactionBody = { ...b, state: "failed", reason: result.reason.slice(0, 600), attempts: result.attempts };
            return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: { failed: true } };
          },
        })));
        const finalState = view<CompactionBody>((await this.#runner.get(ref.kind, id))!);
        if (finalState.state === "failed") {
          const overflow = await this.reportOverflow(principal, { taskId, attemptId, failure: `context compression timed out without reducing this conversation: ${result.reason}` });
          return { kind: "overflow", id, reason: result.reason, attempts: result.attempts, overflow, replayed: false };
        }
        record = (await this.#runner.get(ref.kind, id))!; body = record.body as unknown as CompactionBody;
      } else {
        const full = `${result.summary}${pinnedLines.length === 0 ? "" : `\n\nOwner decisions kept (full text by link):\n${pinnedLines.map((l) => `- ${l}`).join("\n")}`}`;
        record = await this.#finish(principal, { id, ref, taskId, full, result });
        body = record.body as unknown as CompactionBody;
        if (body.state === "failed" && body.superseded === true) return { kind: "superseded", id, reason: body.reason ?? "" };
      }
    }
    if (body.state !== "done") return { kind: "overflow", id, reason: body.reason ?? "", attempts: body.attempts ?? [], overflow: await this.#overflowAction(taskId), replayed };
    // Publish as a retrieval summary (idempotent), and record its ID once.
    const summaryId = body.summaryId ?? await this.#publish(principal, { id, ref, body });
    return { kind: "summary", id, summary: body.summary ?? "", summaryId, route: body.route ?? "", degraded: body.degraded === true, generation: body.generation, lineage: body.lineage, attempts: body.attempts ?? [], replayed };
  }

  async #begin(principal: Principal, a: { taskId: string; projectId: string; k: string; id: string; ref: AggregateRef; compressorId: string; title: string; command: { sources: readonly SourceRef[]; pinned?: readonly SourceRef[]; parent?: string } }) {
    const sources = a.command.sources, pinned = a.command.pinned ?? [];
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 50) invalid("sources", "must list 1 to 50 originals");
    if (!Array.isArray(pinned) || pinned.length > ENFORCEMENT_LIMITS.pinned) invalid("pinned", `must list at most ${ENFORCEMENT_LIMITS.pinned} decisions`);
    const parent = a.command.parent;
    if (parent !== undefined && !/^cmp-[a-z2-7]{20}$/.test(parent)) invalid("parent", "is not a compaction ID");
    const chainRef: AggregateRef = { kind: "ctx-chain", id: derivedId("ctx", `${a.taskId}\0chain`) };
    const chain = await this.#runner.get(chainRef.kind, chainRef.id);
    const head = (chain?.body as unknown as ChainBody | undefined)?.head;
    if (parent !== head) throw new DomainError("invalid_command", head === undefined ? "parent: this task has no earlier compaction" : `parent: the latest compaction of this task is ${head}; a compaction continues the latest one`, { field: "parent" });
    let generation = 1; let lineage: string[] = []; let carried: SourceRef[] = [];
    if (parent !== undefined) {
      const p = (await this.#runner.get("ctx-compaction", parent))?.body as unknown as CompactionBody | undefined;
      if (p === undefined || p.taskId !== a.taskId || p.state !== "done") throw new DomainError("invalid_command", "parent: must be a finished compaction of this task", { field: "parent" });
      generation = p.generation + 1; lineage = [...p.lineage, parent]; carried = [...p.pinned];
    }
    // Owner decisions already carried stay; the new ones are added once.
    const allPinned = [...carried]; for (const s of pinned) if (!allPinned.some((o) => sameSource(o, s))) allPinned.push(s);
    if (allPinned.length > ENFORCEMENT_LIMITS.pinned) invalid("pinned", `more than ${ENFORCEMENT_LIMITS.pinned} decisions would have to be kept; supersede some first`);
    for (const [i, s] of [...sources, ...pinned].entries()) {
      const original = await this.#retrieval.fetch(principal, s);
      if (original === undefined || original.projectId !== a.projectId) invalid(i < sources.length ? `sources[${i}]` : `pinned[${i - sources.length}]`, "must exist, be readable by the writer and belong to the task's project");
    }
    const body: CompactionBody = { taskId: a.taskId, projectId: a.projectId, key: a.k, compressorId: a.compressorId, state: "started", generation, ...(parent === undefined ? {} : { parent }), lineage, sources: [...sources], pinned: allPinned, title: a.title, startedBy: principal.id };
    await this.#runner.command("context.compaction.begin", { commandId: `ctx-cbg-${a.id.slice(4)}`, actor: principal.id }, async () => ({
      payload: { taskId: a.taskId, key: a.k, compressorId: a.compressorId, title: a.title, sources: sources as unknown as JsonObject[], pinned: pinned as unknown as JsonObject[], ...(parent === undefined ? {} : { parent }) },
      build: async () => ({ ref: a.ref, creates: true, changes: [{ type: "create", ref: a.ref, body: body as unknown as JsonObject }], detail: { generation } }),
    }));
    return (await this.#runner.get(a.ref.kind, a.id))!;
  }

  async #finish(principal: Principal, a: { id: string; ref: AggregateRef; taskId: string; full: string; result: { route: string; degraded: boolean; attempts: readonly SummariseAttempt[] } }) {
    const chainRef: AggregateRef = { kind: "ctx-chain", id: derivedId("ctx", `${a.taskId}\0chain`) };
    // A lost race on the chain (another compaction finished between our read and our write) is retried, and the retry sees the new head and closes this one as superseded.
    for (let tries = 0; ; tries++) {
      try { await this.#finishOnce(principal, a, chainRef); break; } catch (error) {
        if (!(error instanceof DomainError && error.code === "stale_revision") || tries >= 3) throw error;
      }
    }
    return (await this.#runner.get(a.ref.kind, a.id))!;
  }
  async #finishOnce(principal: Principal, a: { id: string; ref: AggregateRef; taskId: string; full: string; result: { route: string; degraded: boolean; attempts: readonly SummariseAttempt[] } }, chainRef: AggregateRef): Promise<void> {
    await this.#firstWriterWins(a.ref, () => this.#runner.command("context.compaction.finish", { commandId: `ctx-cfn-${a.id.slice(4)}`, actor: principal.id }, async () => ({
      // The payload names the compaction only: two runs of one key write different summaries, and the first recorded one stands.
      payload: { id: a.id },
      build: async () => {
        const found = await this.#runner.get(a.ref.kind, a.id);
        if (found === undefined) throw new DomainError("not_found", "compaction record is missing");
        const b = found.body as unknown as CompactionBody;
        // Written once: a concurrent run of the same key that finished first wins, and this one's summary is dropped.
        if (b.state !== "started") return { ref: a.ref, creates: false, changes: [{ type: "check", ref: a.ref, expectedRevision: found.revision }], detail: { kept: b.state } };
        const chain = await this.#runner.get(chainRef.kind, chainRef.id);
        const cb = chain?.body as unknown as ChainBody | undefined;
        if (cb?.head !== b.parent) {
          // Another compaction of this task finished first: this one is closed as superseded (not left started, and not an overflow).
          const lost: CompactionBody = { ...b, state: "failed", superseded: true, reason: `superseded: another compaction of this task finished first (the latest is now ${cb?.head ?? "none"})` };
          return { ref: a.ref, creates: false, changes: [{ type: "update", ref: a.ref, expectedRevision: found.revision, body: lost as unknown as JsonObject }], detail: { superseded: true } };
        }
        const next: CompactionBody = { ...b, state: "done", summary: a.full, digest: sha256(a.full), route: a.result.route, degraded: a.result.degraded, attempts: a.result.attempts };
        const nextChain: ChainBody = { taskId: a.taskId, head: a.id, count: (cb?.count ?? 0) + 1 };
        const changes: Change[] = [{ type: "update", ref: a.ref, expectedRevision: found.revision, body: next as unknown as JsonObject }, chain === undefined ? { type: "create", ref: chainRef, body: nextChain as unknown as JsonObject } : { type: "update", ref: chainRef, expectedRevision: chain.revision, body: nextChain as unknown as JsonObject }];
        return { ref: a.ref, creates: false, changes, detail: { route: a.result.route, generation: b.generation } };
      },
    })));
  }

  /** Runs a step that leaves a compaction `done` or `failed`. If another run of the same key recorded its result first (storage sees the same step with different content), that result stands and this one is dropped. */
  async #firstWriterWins(ref: AggregateRef, step: () => Promise<unknown>, settled: (b: CompactionBody) => boolean = (b) => b.state !== "started"): Promise<void> {
    try { await step(); } catch (error) {
      if (!(error instanceof DomainError) || (error.code !== "command_conflict" && error.code !== "stale_revision")) throw error;
      const now = await this.#runner.get(ref.kind, ref.id);
      if (now === undefined || !settled(now.body as unknown as CompactionBody)) throw error;
    }
  }

  async #publish(principal: Principal, a: { id: string; ref: AggregateRef; body: CompactionBody }): Promise<string> {
    const made = await this.#retrieval.summarize(principal, { commandId: `ctx-sum-${a.id.slice(4)}`, projectId: a.body.projectId, title: `Context summary ${a.body.key} (generation ${a.body.generation})`, text: a.body.summary ?? "", sources: [...a.body.sources, ...a.body.pinned.filter((p) => !a.body.sources.some((s) => sameSource(s, p)))] });
    await this.#firstWriterWins(a.ref, () => this.#runner.command("context.compaction.publish", { commandId: `ctx-cpb-${a.id.slice(4)}`, actor: principal.id }, async () => ({
      payload: { id: a.id, summaryId: made.id },
      build: async () => {
        const found = await this.#runner.get(a.ref.kind, a.id);
        if (found === undefined) throw new DomainError("not_found", "compaction record is missing");
        const b = found.body as unknown as CompactionBody;
        if (b.summaryId !== undefined) return { ref: a.ref, creates: false, changes: [{ type: "check", ref: a.ref, expectedRevision: found.revision }], detail: {} };
        return { ref: a.ref, creates: false, changes: [{ type: "update", ref: a.ref, expectedRevision: found.revision, body: { ...b, summaryId: made.id } as unknown as JsonObject }], detail: {} };
      },
    })), (b) => b.summaryId !== undefined);
    return ((await this.#runner.get(a.ref.kind, a.id))!.body as unknown as CompactionBody).summaryId ?? made.id;
  }

  async #pinnedLines(principal: Principal, pinned: readonly SourceRef[]): Promise<string[]> {
    const lines: string[] = [];
    for (const s of pinned) {
      const original = await this.#retrieval.fetch(principal, s);
      if (original !== undefined) lines.push(`${label(s)}: ${redactText(original.text).replace(/\s+/g, " ").trim().slice(0, ENFORCEMENT_LIMITS.pinnedSnippet)}`);
    }
    return lines;
  }

  /** The compaction record without its summary text (that is read through `readSummary`). Unreadable reads like missing. */
  async getCompaction(principal: Principal, id: string): Promise<Omit<CompactionBody, "summary"> & { id: string } | undefined> {
    const found = typeof id === "string" && /^cmp-[a-z2-7]{20}$/.test(id) ? await this.#runner.get("ctx-compaction", id) : undefined;
    if (found === undefined) return undefined;
    const { summary: _summary, ...rest } = found.body as unknown as CompactionBody;
    return (await this.#task(principal, rest.taskId, true)) === undefined ? undefined : { id, ...rest };
  }
  /** The summary text, only for someone who can read every original it was made from (the retrieval rule); otherwise withheld. */
  async readSummary(principal: Principal, id: string) {
    const rec = await this.getCompaction(principal, id);
    return rec?.summaryId === undefined ? undefined : this.#retrieval.resolve(principal, rec.summaryId);
  }
  /** The latest compaction of a task, if any. */
  async latestCompaction(principal: Principal, taskId: string): Promise<{ id: string; generation: number; lineage: readonly string[] } | undefined> {
    taskId = checkTaskId(taskId);
    if ((await this.#task(principal, taskId, true)) === undefined) return undefined;
    const head = ((await this.#runner.get("ctx-chain", derivedId("ctx", `${taskId}\0chain`)))?.body as unknown as ChainBody | undefined)?.head;
    const rec = head === undefined ? undefined : await this.getCompaction(principal, head);
    return rec === undefined ? undefined : { id: rec.id, generation: rec.generation, lineage: rec.lineage };
  }
  /** The owner decisions kept through every compaction of the task, each read again now with this reader's rights (`unavailable`: gone or not readable by this reader). */
  async keptDecisions(principal: Principal, taskId: string): Promise<{ source: SourceRef; state: "available" | "unavailable"; text?: string }[]> {
    const latest = await this.latestCompaction(principal, taskId);
    const rec = latest === undefined ? undefined : await this.getCompaction(principal, latest.id);
    const out: { source: SourceRef; state: "available" | "unavailable"; text?: string }[] = [];
    for (const source of rec?.pinned ?? []) { const original = await this.#retrieval.fetch(principal, source); out.push(original === undefined ? { source, state: "unavailable" } : { source, state: "available", text: original.text }); }
    return out;
  }

  // ---- overflow ----------------------------------------------------------------------------------------------------------------

  /** Records that an attempt failed (counted once per attempt); anything that is not a context failure is not counted. Repeated overflow ends in a blocker and says so. */
  async reportOverflow(principal: Principal, command: { taskId: string; attemptId: string; failure: string }): Promise<OverflowAction> {
    onlyKnown(command, ["taskId", "attemptId", "failure"]);
    const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId);
    await this.#dispatch(principal, taskId);
    const failure = cleanReason(command.failure, "failure");
    if (classifyFailure(command.failure) !== "context_overflow") return { action: "none", count: 0, reason: "not a context failure" };
    const ref: AggregateRef = { kind: "ctx-overflow", id: derivedId("ctx", `${taskId}\0overflow`) };
    try {
    await this.#runner.command("context.overflow", { commandId: `ctx-ovf-${derivedId("ctx", `${taskId}\0${attemptId}\0ovf`).slice(4)}`, actor: principal.id }, async () => ({
      // The payload names the attempt only: the same attempt may report the same failure in different words (a failed compaction, then the generation error) and counts once.
      payload: { taskId, attemptId },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const b = (found?.body as unknown as OverflowBody | undefined) ?? { taskId, count: 0, total: 0, events: [] };
        if (found !== undefined && b.events.includes(attemptId)) return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found.revision }], detail: { counted: true } };
        const next: OverflowBody = { taskId, count: b.count + 1, total: b.total + 1, events: [...b.events, attemptId].slice(-ENFORCEMENT_LIMITS.overflowAttempts), last: failure, ...(b.blockerId === undefined ? {} : { blockerId: b.blockerId }) };
        const change: Change = found === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject };
        return { ref, creates: found === undefined, changes: [change], detail: { count: next.count } };
      },
    }));
    } catch (error) {
      // The same attempt reporting twice at once: the first write counted it.
      if (!(error instanceof DomainError && (error.code === "command_conflict" || error.code === "stale_revision"))) throw error;
      const now = (await this.#runner.get(ref.kind, ref.id))?.body as unknown as OverflowBody | undefined;
      if (now === undefined || !now.events.includes(attemptId)) throw error;
    }
    return this.#overflowAction(taskId, principal);
  }
  async #overflowAction(taskId: string, principal?: Principal): Promise<OverflowAction> {
    const b = (await this.#runner.get("ctx-overflow", derivedId("ctx", `${taskId}\0overflow`)))?.body as unknown as OverflowBody | undefined;
    const count = b?.count ?? 0;
    if (count === 0) return { action: "none", count, reason: "no context failure recorded" };
    if (count < this.#maxOverflows) return { action: "restart-fresh", count, reason: `context overflow ${count} of ${this.#maxOverflows}: restart fresh from the continuation record (not resumed)` };
    const open = await this.#blockers.openFor("context_overflow", { kind: "task", id: taskId });
    const blockerId = open?.id ?? (principal === undefined ? undefined : await this.#block(principal, taskId, `The context overflowed ${count} times in a row (${b?.last ?? "no detail"}); no further attempt starts until someone changes the route, the task or the budget.`));
    return { action: "blocked", count, reason: `context overflow ${count} times in a row: blocked until someone looks`, ...(blockerId === undefined ? {} : { blockerId }) };
  }
  /** An attempt ran within budget, or the owner resolved the blocker: the count starts again. */
  async resetOverflow(principal: Principal, command: { taskId: string; attemptId: string }): Promise<void> {
    onlyKnown(command, ["taskId", "attemptId"]);
    const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId);
    await this.#dispatch(principal, taskId);
    const ref: AggregateRef = { kind: "ctx-overflow", id: derivedId("ctx", `${taskId}\0overflow`) };
    // Nothing counted, nothing to start again (a command with no change reports no revision).
    const counted = (await this.#runner.get(ref.kind, ref.id))?.body as unknown as OverflowBody | undefined;
    if (counted === undefined || counted.count === 0) return;
    await this.#runner.command("context.overflow.reset", { commandId: `ctx-rst-${derivedId("ctx", `${taskId}\0${attemptId}\0rst`).slice(4)}`, actor: principal.id }, async () => ({
      payload: { taskId, attemptId },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        if (found === undefined || (found.body as unknown as OverflowBody).count === 0) return { ref, creates: false, changes: found === undefined ? [] : [{ type: "check", ref, expectedRevision: found.revision }], detail: {} };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: { ...(found.body as unknown as OverflowBody), count: 0 } as unknown as JsonObject }], detail: { reset: true } };
      },
    }));
  }

  // ---- tool output ---------------------------------------------------------------------------------------------------------

  /**
   * The one gate for tool results, Pi's and MCP tools': cut to the window's per-tool limit (non-text results counted), the remainder kept (up to a bound) under a spill ID the model can page through.
   * Repeating it for the same call answers with the same spill.
   */
  async limitTool(principal: Principal, command: { taskId: string; callId: string; tool: string; window: number; output: ToolOutput; pageSize?: number }): Promise<{ text: string; truncated: boolean; spillId?: string; remainderChars: number; lostChars: number; nonTextDropped: number }> {
    onlyKnown(command, ["taskId", "callId", "tool", "window", "output", "pageSize"]);
    const taskId = checkTaskId(command.taskId); const callId = key("callId", command.callId); const tool = text(command.tool, "tool", { min: 1, max: 120 });
    const projectId = (await this.#dispatch(principal, taskId))!;
    const budget = this.budget(window(command.window));
    const out = limitToolOutput(command.output, budget);
    if (!out.truncated) return { text: out.text, truncated: false, remainderChars: 0, lostChars: 0, nonTextDropped: out.nonTextDropped };
    // Credentials are removed from the whole remainder first, so a secret the cap would split is still recognised.
    const redacted = redactText(out.remainder);
    const kept = redacted.slice(0, ENFORCEMENT_LIMITS.spill);
    const lost = redacted.length - kept.length;
    const id = derivedId("spl", `${taskId}\0${callId}`);
    const ref: AggregateRef = { kind: "ctx-spill", id };
    const body: SpillBody = { taskId, projectId, tool, callId, remainder: kept, remainderChars: out.remainderChars, lostChars: lost };
    await this.#runner.command("context.spill", { commandId: `ctx-spl-${id.slice(4)}`, actor: principal.id }, async () => ({
      payload: { taskId, callId, tool, remainderDigest: sha256(out.remainder), lostChars: lost },
      build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { remainderChars: out.remainderChars } }),
    }));
    const note = `\n[Rest of this result: spill ${id}, ${out.remainderChars} characters${lost > 0 ? `, of which ${lost} could not be kept` : ""}; read it in pages]`;
    return { text: out.text + note, truncated: true, spillId: id, remainderChars: out.remainderChars, lostChars: lost, nonTextDropped: out.nonTextDropped };
  }
  /** One page of a kept remainder, for someone who may work on the task; otherwise it reads like a missing spill. */
  async readSpill(principal: Principal, spillId: string, index: number, size = 12_000): Promise<{ text: string; next?: number } | undefined> {
    const found = typeof spillId === "string" && /^spl-[a-z2-7]{20}$/.test(spillId) ? await this.#runner.get("ctx-spill", spillId) : undefined;
    if (found === undefined) return undefined;
    const b = found.body as unknown as SpillBody;
    if ((await this.#task(principal, b.taskId, true)) === undefined) return undefined;
    try { return page(b.remainder, index, size); } catch (error) { if (error instanceof RangeError) return invalid("index", error.message); throw error; }
  }

  // ---- hand-off ----------------------------------------------------------------------------------------------------------

  /** The attempt's own hand-off. If the controller already wrote one for this attempt, both are kept and the attempt's own becomes the task's latest. */
  async recordHandoff(principal: Principal, command: { taskId: string; attemptId: string; text: string }): Promise<{ id: string; controllerKept: boolean }> {
    onlyKnown(command, ["taskId", "attemptId", "text"]);
    const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId);
    const projectId = (await this.#task(principal, taskId))!;
    const body = redactText(text(command.text, "text", { min: 1, max: ENFORCEMENT_LIMITS.handoff, multiline: true }));
    const id = await this.#writeHandoff(principal, { taskId, projectId, attemptId, source: "attempt", text: body, endedBecause: "the attempt wrote it" });
    return { id, controllerKept: (await this.#runner.get("ctx-handoff", handoffId(taskId, attemptId, "controller"))) !== undefined };
  }
  /**
   * Called when an attempt ends. If the attempt left a hand-off, that one is returned; otherwise the controller writes one from the facts the dispatcher can read (the effect ledger, artifacts, the
   * checkpoint and the last known state), credentials removed, and attaches it to the task. A crash after a confirmed effect and before the attempt's own hand-off therefore still yields one.
   */
  async ensureHandoff(principal: Principal, command: { taskId: string; attemptId: string; endedBecause: string }, facts: (taskId: string, attemptId: string) => Promise<HandoffFacts>): Promise<{ id: string; source: "attempt" | "controller"; text: string }> {
    onlyKnown(command, ["taskId", "attemptId", "endedBecause"]);
    const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId);
    const projectId = (await this.#dispatch(principal, taskId))!;
    const ended = cleanReason(command.endedBecause, "endedBecause");
    for (const source of ["attempt", "controller"] as const) {
      const existing = await this.#runner.get("ctx-handoff", handoffId(taskId, attemptId, source));
      if (existing !== undefined) return { id: existing.id, source, text: (existing.body as unknown as HandoffBody).text };
    }
    const written = handoffFromFacts({ ...(await facts(taskId, attemptId)), endedBecause: ended }, ENFORCEMENT_LIMITS.handoff);
    const id = await this.#writeHandoff(principal, { taskId, projectId, attemptId, source: "controller", text: written, endedBecause: ended });
    const b = (await this.#runner.get("ctx-handoff", id))!.body as unknown as HandoffBody;
    return { id, source: b.source, text: b.text };
  }
  /** Both hand-offs of an attempt, if any (the attempt's own and the controller's). Unreadable reads like missing. */
  async handoffsOf(principal: Principal, taskId: string, attemptId: string): Promise<{ attempt?: string; controller?: string }> {
    taskId = checkTaskId(taskId); attemptId = key("attemptId", attemptId);
    if ((await this.#task(principal, taskId, true)) === undefined) return {};
    const out: { attempt?: string; controller?: string } = {};
    for (const source of ["attempt", "controller"] as const) { const r = await this.#runner.get("ctx-handoff", handoffId(taskId, attemptId, source)); if (r !== undefined) out[source] = (r.body as unknown as HandoffBody).text; }
    return out;
  }
  async #writeHandoff(principal: Principal, h: { taskId: string; projectId: string; attemptId: string; source: "attempt" | "controller"; text: string; endedBecause: string }): Promise<string> {
    const id = handoffId(h.taskId, h.attemptId, h.source);
    const ref: AggregateRef = { kind: "ctx-handoff", id };
    const headRef: AggregateRef = { kind: "ctx-handoff-head", id: derivedId("ctx", `${h.taskId}\0handoff`) };
    const body: HandoffBody = { taskId: h.taskId, projectId: h.projectId, attemptId: h.attemptId, source: h.source, text: h.text, endedBecause: h.endedBecause, writtenBy: principal.id };
    for (let tries = 0; tries < 4; tries++) {
      try {
        await this.#runner.command("context.handoff", { commandId: `ctx-hof-${id.slice(4)}`, actor: principal.id }, async () => ({
          payload: { taskId: h.taskId, attemptId: h.attemptId, source: h.source },
          build: async () => {
            if (await this.#runner.get(ref.kind, id) !== undefined) throw new DomainError("command_conflict", "a hand-off from this writer exists for this attempt");
            const head = await this.#runner.get(headRef.kind, headRef.id);
            const cur = head?.body as unknown as { attemptId: string; source: string } | undefined;
            // The attempt's own hand-off is preferred as the head; the controller's takes the head only when it would not replace the attempt's own for the same attempt.
            const keepHead = cur !== undefined && h.source === "controller" && cur.attemptId === h.attemptId && cur.source === "attempt";
            const nextHead = { taskId: h.taskId, latest: id, attemptId: h.attemptId, source: h.source };
            const headChange: Change[] = keepHead ? [{ type: "check", ref: headRef, expectedRevision: head!.revision }] : [head === undefined ? { type: "create", ref: headRef, body: nextHead } : { type: "update", ref: headRef, expectedRevision: head.revision, body: nextHead }];
            return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }, ...headChange], detail: { source: h.source } };
          },
        }));
        break;
      } catch (error) {
        // The same writer got there first, or the head moved under us (retried).
        if (!(error instanceof DomainError) || (error.code !== "command_conflict" && error.code !== "stale_revision")) throw error;
        if (await this.#runner.get(ref.kind, id) !== undefined) break;
        if (tries === 3) throw error;
      }
    }
    return id;
  }
  /** The newest hand-off attached to a task (the attempt's own is preferred over the controller's for the same attempt). Unreadable reads like missing. */
  async latestHandoff(principal: Principal, taskId: string): Promise<{ id: string; attemptId: string; source: "attempt" | "controller"; text: string } | undefined> {
    taskId = checkTaskId(taskId);
    if ((await this.#task(principal, taskId, true)) === undefined) return undefined;
    const head = (await this.#runner.get("ctx-handoff-head", derivedId("ctx", `${taskId}\0handoff`)))?.body as unknown as { latest: string } | undefined;
    const rec = head === undefined ? undefined : await this.#runner.get("ctx-handoff", head.latest);
    const b = rec?.body as unknown as HandoffBody | undefined;
    return b === undefined ? undefined : { id: head!.latest, attemptId: b.attemptId, source: b.source, text: b.text };
  }
}

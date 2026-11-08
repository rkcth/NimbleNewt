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
import { classifyFailure, contextBudget, tokensOf, handoffFromFacts, limitToolOutput, page, type BudgetOverrides, type ContextBudget, type HandoffFacts, type StartupItem, type StartupResult, type ToolOutput } from "./budget.js";
import { admitFirstCall, boundedSummarise, calibratedCharsPerToken, reviewRouteChange, SUMMARY_DEFAULTS, type FirstCallDecision, type FirstCall, type SummariseAttempt, type SummariseLimits, type Summariser } from "./dispatch.js";
import type { RetrievalService, SourceRef } from "./retrieval.js";
import { DEFAULT_ROUTE_FLOOR_CHARS, type RouteSettingsEffective } from "./route-settings.js";

// Card C07b: the controller-side service the dispatcher (H12) and the Pi adapter's `beforeCompact` hook call to enforce the C07 budgets. Every decision is a durable record keyed by the task and the
// attempt (or compaction key), so a repeat after a restart finds what was decided and does not decide again.

export const ENFORCEMENT_LIMITS = { pinned: 12, pinnedSnippet: 80, material: 1_000_000, spill: 256_000, handoff: 4000, reason: 300, overflowAttempts: 10, title: 200, archiveChars: 100_000 } as const;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const ROUTE_BLOCK = "[route change]";
const key = (field: string, value: unknown): string => (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,79}$/.test(value) ? value : invalid(field, "must be 1 to 80 ASCII letters, digits, '.', '_', ':', '~' or '-'"));
const round = (value: unknown): number => (value === undefined ? 1 : Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1000 ? (value as number) : invalid("round", "must be a whole number from 1 to 1000"));
const window = (value: unknown): number => (Number.isSafeInteger(value) ? (value as number) : invalid("window", "must be a whole number of tokens"));
const cleanReason = (value: unknown, field: string): string => redactText(text(value, field, { min: 1, max: 2000, multiline: true })).slice(0, ENFORCEMENT_LIMITS.reason);
const sameSource = (a: SourceRef, b: SourceRef): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Part of an admission's identity that tells one start of the worker apart from another (the same attempt resumed after a restart, a host loss or a move is judged afresh, not given the answer of an earlier, smaller conversation). */
const launchPart = (launch: unknown): string => (launch === undefined ? "" : `\0launch\0${key("launch", launch)}`);
const handoffId = (taskId: string, attemptId: string, source: string): string => derivedId("hof", `${taskId}\0${attemptId}\0${source}`);
const label = (s: SourceRef): string => (s.kind === "desk-record" || s.kind === "owner-decision" ? s.id : `${s.scopeId}#${s.seq}`);

export interface AdmissionBody {
  readonly type: "first-call" | "route-change";
  readonly taskId: string; readonly projectId: string; readonly attemptId: string; readonly round: number; readonly window: number; readonly route: string;
  readonly admit: boolean;
  readonly startupTokens: number; readonly estimatedTokens: number; readonly rawEstimatedTokens: number; readonly workingTokens: number; readonly basis: string;
  readonly calibrationRatio?: number;
  /** The route's own name, kept when the key is a cut one, so records written under an older key of that name are found. */
  readonly routeName?: string;
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
/** What a route's fixed part (the system prompt and tool schemas) measured at the last first call admitted on it (card C07f). */
interface RouteFixedSample { readonly systemPromptChars: number; readonly toolSchemaChars: number; readonly attemptId: string }
/** The recent measurements for one route and harness (newest first, at most `FIXED_SAMPLES`); the figure used is the median of them, so one task with a very large tool set does not set the figure for the others. */
interface RouteFixedBody { readonly route: string; readonly harness: string; readonly samples: readonly RouteFixedSample[] }
const FIXED_SAMPLES = 5;
/** The route as the context records name it: the same cleaning every caller applies, so a route measured at admission is the one a route change finds. */
/**
 * Injective. Every key starts with `c~r`: the encoding below writes `~` only before four hex digits, and `r` is not one, so no encoded name can contain `~r` and a name can never be mistaken for another by its first letters.
 * A character outside the allowed set becomes `~` and its four hex digits (and `~` itself too), so `a/b` and `a:b` stay two routes. A name that would pass 80 characters is cut and ends in `~h` (not a hex digit either, so no encoded name contains it)
 * and a digest of the whole name.
 */
const PROJECT_WIDE: ReadonlySet<string> = new Set(["human", "permission", "goal", "decision"]);
const ROUTE_KEY_PREFIX = "c~r";
const encodeRoute = (route: string): string => route.replace(/[^A-Za-z0-9._:-]/g, (c) => `~${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
export const contextRouteKey = (route: string): string => {
  const safe = `${ROUTE_KEY_PREFIX}${encodeRoute(route)}`;
  return safe.length <= 80 ? safe : `${safe.slice(0, 61)}~h${sha256(route).slice(0, 16)}`;
};
/**
 * The names a route was kept under before the key was always prefixed, for reading records written then: the form of the previous release (an `r` before a name that began oddly; a name past 80 characters cut to 63 and a digest of the whole)
 * and the older one that turned every other character into `:` and cut at 80. Taken from the route's own name. A key that cannot be told from another name's is left out: the older form maps `a/b` and `a:b` to the same key (read only when
 * nothing was replaced and nothing cut), and an `r`-prefixed one is the key of a name that really begins with `r`.
 */
const legacyKeysOfName = (name: string, current: string): string[] => {
  const encoded = encodeRoute(name);
  const previousSafe = /^[A-Za-z0-9]/.test(encoded) ? encoded : `r${encoded}`;
  const previous = previousSafe.length <= 80 ? previousSafe : `${previousSafe.slice(0, 63)}~${sha256(name).slice(0, 16)}`;
  const oldest = /[^A-Za-z0-9._:-]/.test(name) || name.length > 80 ? undefined : name;
  return [...new Set([previous, ...(oldest === undefined ? [] : [oldest])])].filter((k) => k !== current && /^[A-Za-z0-9]/.test(k));
};
/** The same from the key alone, which is the name itself unless the key is a cut one (then the name is needed). */
const legacyRouteKeys = (routeKey: string, name?: string): string[] => {
  if (name !== undefined) return legacyKeysOfName(name, routeKey);
  if (!routeKey.startsWith(ROUTE_KEY_PREFIX) || routeKey.includes("~h")) return [];
  const original = routeKey.slice(ROUTE_KEY_PREFIX.length).replace(/~([0-9a-f]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  return legacyKeysOfName(original, routeKey);
};
/**
 * The rebuilt view as the worker puts it in the first prompt on the new route (card C07g): a header naming the route, the kept pieces in their order (a cut item keeps its head and tail and names the full
 * text's digest; a dropped one is a one-line reference with the digest), and a footer that says how the full text of a cut item is read. Nothing when there is nothing to show.
 */
export function startupViewText(startup: StartupResult, route: string, window: number): string {
  const pieces = startup.pieces.filter((p) => p.text !== "");
  if (pieces.length === 0) return "";
  const footer = startup.cuts.length === 0 ? "" : `\n\n${viewFooter(startup.cuts.length)}`;
  return `${viewHeader(route, window)}\n\n${pieces.map((p) => p.text).join("\n\n")}${footer}`;
}
const viewHeader = (route: string, window: number): string => `[The owner's decisions, goals, permissions and open questions for this task, rebuilt for model route ${route.length <= 80 ? route : `${route.slice(0, 77)}...`} (a ${window}-token window).]`;
const viewFooter = (n: number): string => `[${n} item${n === 1 ? " was" : "s were"} cut or left out to fit this route. Nothing is lost: each names the digest of its full text (sha256:...); read it with the state API query context.route-archive.read, giving this task's ID and that digest (the owner's own items need the right to read the project's history).]`;
/** What the header, the footer and the separators of a view add at most, in characters: the pieces are built with room for them, so the whole view stays within the startup share. */
const viewFrameChars = (route: string, window: number, items: number): number => viewHeader(route, window).length + 4 + viewFooter(Math.max(2, items)).length + 2 * Math.max(0, items - 1);
/** Room kept in the first prompt beside the view for the notes the controller adds to the task's own text (the project's rules, a resume note), in characters, when their exact size is not known yet (card C07g). */
export const PROMPT_NOTE_RESERVE_CHARS = 2000;
interface CalibrationBody { readonly taskId: string; readonly route: string; readonly ratio: number; readonly charsPerToken: number; readonly reportedTokens: number; readonly attemptId: string }
interface ChainBody { readonly taskId: string; readonly head?: string; readonly count: number }
interface SpillBody { /** An outside server's text: read only by those who may use MCP in the project, and framed as data when paged out. */ readonly untrusted?: boolean; readonly taskId: string; readonly projectId: string; readonly tool: string; readonly callId: string; readonly remainder: string; readonly remainderChars: number; readonly lostChars: number }

export interface EnforcementOptions extends RunnerOptions {
  /** Context-window overrides for the budgets (shares, characters per token); validated by `contextBudget`. */
  readonly budget?: BudgetOverrides;
  /** Consecutive overflows of one task before a blocker (default 2). */
  readonly maxOverflows?: number;
  readonly summary?: Partial<SummariseLimits>;
  /** The owner's settings for the route-change check (card C07f): the floor counted for a route nobody has measured. Absent: the defaults. */
  readonly routeSettings?: { effective(): Promise<RouteSettingsEffective> };
  /** Told of a fault that is not part of the call that met it (the route's figure could not be kept); at most once a minute. */
  readonly onError?: (error: unknown) => void;
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
  readonly #routeSettings: { effective(): Promise<RouteSettingsEffective> } | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  #lastFixedError = 0;

  private constructor(runner: CommandRunner, deps: { blockers: BlockerService; retrieval: RetrievalService }, options: EnforcementOptions) {
    this.#runner = runner; this.#blockers = deps.blockers; this.#retrieval = deps.retrieval;
    this.#overrides = options.budget ?? {};
    contextBudget(131_072, this.#overrides); // validates the overrides now, not at the first call
    this.#maxOverflows = options.maxOverflows ?? 2;
    if (!Number.isSafeInteger(this.#maxOverflows) || this.#maxOverflows < 1 || this.#maxOverflows > 10) throw new RangeError("maxOverflows must be a whole number from 1 to 10");
    this.#summary = options.summary ?? {};
    this.#routeSettings = options.routeSettings;
    this.#onError = options.onError;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: { blockers: BlockerService; retrieval: RetrievalService }, options: EnforcementOptions = {}): ContextEnforcementService {
    if (deps.blockers.epoch !== epoch) throw new DomainError("invalid_command", "epoch: must be the epoch the blocker service writes under", { field: "epoch" });
    return new ContextEnforcementService(new CommandRunner(storage, epoch, options), deps, options);
  }

  budget(windowTokens: number): ContextBudget { return contextBudget(windowTokens, this.#overrides); }
  /** The same, but a window the budgets cannot be made for is a refusal of the command (a DomainError), not a RangeError that surfaces at every tick. */
  #budgetOf(field: string, windowTokens: number): ContextBudget {
    try { return this.budget(windowTokens); } catch (error) { if (error instanceof RangeError) return invalid(field, error.message); throw error; }
  }

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
  /** The calibration of a task on a route; a record written under the name the route had before the key was always prefixed is found too. */
  async #calibrationOf(taskId: string, route: string, routeName?: string): Promise<CalibrationBody | undefined> {
    for (const name of [route, ...legacyRouteKeys(route, routeName)]) {
      const found = (await this.#runner.get("ctx-calibration", derivedId("ctx", `${taskId}\0${name}\0calibration`)))?.body as unknown as CalibrationBody | undefined;
      if (found !== undefined) return found;
    }
    return undefined;
  }
  /** Writes one record if it is not there; a repeat of the same command is its recorded result. */
  async #create(principal: Principal, type: string, commandId: string, ref: AggregateRef, body: JsonObject, payload: JsonObject): Promise<void> {
    await this.#runner.command(type, { commandId, actor: principal.id }, async () => ({ payload, build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body }], detail: {} }) }));
  }

  // ---- admission --------------------------------------------------------------------------------------------------------------

  /**
   * Decides whether the first call of an attempt may be sent. Repeating it (same task, attempt and round) answers with the recorded decision; a refusal has opened a blocker (unless the caller said it will `retry` after making the call smaller). While a `context_overflow`
   * blocker is open on the task nothing is admitted. If an earlier confirmed call on the same route (`route`, default one per window) was larger than estimated, the estimate is scaled by that ratio.
   */
  async admit(principal: Principal, command: { taskId: string; attemptId: string; round?: number; launch?: string; window: number; route?: string; routeName?: string; harness?: string; call: FirstCall; retry?: boolean }): Promise<FirstCallDecision & { id: string; blockerId?: string; replayed: boolean }> {
    onlyKnown(command, ["taskId", "attemptId", "round", "launch", "window", "route", "routeName", "harness", "call", "retry"]);
    if (command.retry !== undefined && typeof command.retry !== "boolean") return invalid("retry", "must be true or false");
    const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId); const r = round(command.round); const w = window(command.window);
    const route = command.route === undefined ? `window-${w}` : key("route", command.route);
    // The route's own name, when the caller has it, finds the records a cut key lost the name of; it must be the name the key was made from.
    const routeName = command.routeName === undefined ? undefined : typeof command.routeName === "string" && command.routeName.length <= 500 && contextRouteKey(command.routeName) === route ? command.routeName : invalid("routeName", "must be the name the route key was made from");
    const projectId = (await this.#dispatch(principal, taskId))!;
    const budget = this.#budgetOf("window", w);
    onlyKnown(command.call, ["systemPromptChars", "toolSchemaChars", "startupTokens", "replyReserveTokens", "likelyToolOutputTokens", "reportedInputTokens"]);
    const call = command.call;
    const id = derivedId("adm", `${taskId}\0${attemptId}\0first\0${r}${launchPart(command.launch)}`);
    const ref: AggregateRef = { kind: "ctx-admission", id };
    let raw: FirstCallDecision;
    try { raw = admitFirstCall(call, budget); } catch (error) { if (error instanceof RangeError) return invalid("call", error.message); throw error; }
    const calibration = await this.#calibrationOf(taskId, route, routeName);
    const ratio = call.reportedInputTokens === undefined ? Math.max(1, calibration?.ratio ?? 1) : 1;
    const scaled: FirstCall = ratio === 1 ? call : { ...call, systemPromptChars: Math.ceil(call.systemPromptChars * ratio), toolSchemaChars: Math.ceil(call.toolSchemaChars * ratio), startupTokens: Math.ceil(call.startupTokens * ratio) };
    let decision = admitFirstCall(scaled, budget);
    if (ratio > 1) decision = { ...decision, reasons: decision.admit ? [] : [...decision.reasons, `(the estimate was scaled by ${ratio}: an earlier call on route ${route} was reported at that multiple of its estimate)`] };
    // Nothing new is admitted while the task is blocked for context overflow (an earlier decision of this very call is still answered as recorded).
    const open = await this.#blockers.openFor("context_overflow", { kind: "task", id: taskId });
    if (open !== undefined && (await this.#runner.get(ref.kind, id)) === undefined) decision = { ...decision, admit: false, reasons: [`a context_overflow blocker is open on this task (${open.id}); it must be resolved first`, ...decision.reasons] };
    const body: AdmissionBody = { type: "first-call", taskId, projectId, attemptId, round: r, window: w, route, admit: decision.admit, startupTokens: decision.startupTokens, estimatedTokens: decision.estimatedTokens, rawEstimatedTokens: raw.estimatedTokens, workingTokens: decision.workingTokens, basis: decision.basis, reasons: decision.reasons, ...(routeName === undefined || routeName === route ? {} : { routeName }), ...(ratio > 1 ? { calibrationRatio: ratio } : {}), decidedBy: principal.id };
    const run = await this.#runner.command("context.admit", { commandId: `ctx-adm-${id.slice(4)}`, actor: principal.id }, async () => ({
      payload: { taskId, attemptId, round: r, window: w, route, call: call as unknown as JsonObject },
      build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { admit: decision.admit } }),
    }));
    const recorded = view<AdmissionBody>((await this.#runner.get(ref.kind, id))!);
    // The route's measured fixed part is kept from every first call that was sized, refused ones too (a refusal is a real measurement of the prompt and the tool schemas, and a route whose first call overflows must still become measured), and never fails the admission (card C07f).
    await this.#recordFixed(principal, { route, harness: command.harness, attemptId, admissionId: id, call });
    // `retry`: the caller will make the call smaller (compact the stored conversation) and ask again as the next round; that round, if refused, is the one that opens the blocker.
    const blockerId = recorded.admit || command.retry === true ? undefined : await this.#block(principal, taskId, `The first call of attempt ${attemptId} was not sent: ${recorded.reasons.join("; ")}.`);
    return { admit: recorded.admit, startupTokens: recorded.startupTokens, estimatedTokens: recorded.estimatedTokens, basis: recorded.basis as FirstCallDecision["basis"], workingTokens: recorded.workingTokens, limits: { startup: budget.startupTokens, working: budget.workingTokens }, reasons: recorded.reasons, id, ...(blockerId === undefined ? {} : { blockerId }), replayed: run.replayed };
  }

  /**
   * After the call went out: records the size the provider reported and what characters per token it implies, whether the call was in fact over the startup limit, and (per task and route) how far the
   * estimate was off, which later `admit` calls on that route apply.
   */
  async confirmUsage(principal: Principal, command: { taskId: string; attemptId: string; round?: number; launch?: string; reportedInputTokens: number; promptChars: number }): Promise<{ charsPerToken: number; overStartupLimit: boolean; ratio: number; replayed: boolean }> {
    onlyKnown(command, ["taskId", "attemptId", "round", "launch", "reportedInputTokens", "promptChars"]);
    const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId);
    await this.#dispatch(principal, taskId);
    const id = derivedId("adm", `${taskId}\0${attemptId}\0first\0${round(command.round)}${launchPart(command.launch)}`);
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
        const earlier = cal === undefined ? await this.#calibrationOf(taskId, body.route, body.routeName) : (cal.body as unknown as CalibrationBody);
        const calBody: CalibrationBody = { taskId, route: body.route, ratio: earlier === undefined ? ratio : Math.max(ratio, Math.round(earlier.ratio * 80) / 100), charsPerToken: cpt, reportedTokens: command.reportedInputTokens, attemptId };
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
   * Keeps what a first call measured of its route's fixed part, beside the decision and not in it: a failure or a lost race never costs the admission. Kept per route and harness (a prompt differs between harnesses),
   * the latest few measurements, the largest counting; a repeat of the same admission is the same command.
   */
  async #recordFixed(principal: Principal, m: { route: string; harness: string | undefined; attemptId: string; admissionId: string; call: FirstCall }): Promise<void> {
    if (m.call.systemPromptChars + m.call.toolSchemaChars <= 0) return;
    try {
      const harness = m.harness === undefined ? "any" : key("harness", m.harness);
      const ref: AggregateRef = { kind: "ctx-route-fixed", id: derivedId("ctx", `route\0${m.route}\0${harness}\0fixed`) };
      for (let tries = 0; tries < 6; tries++) {
        let creating = false;
        try {
          await this.#runner.command("context.route-fixed", { commandId: `ctx-fix-${m.admissionId.slice(4)}`, actor: principal.id }, async () => ({
            payload: { route: m.route, harness, systemPromptChars: m.call.systemPromptChars, toolSchemaChars: m.call.toolSchemaChars },
            build: async () => {
              const old = await this.#runner.get(ref.kind, ref.id);
              const was = old?.body as unknown as RouteFixedBody | undefined;
              creating = old === undefined;
              const samples = [{ systemPromptChars: m.call.systemPromptChars, toolSchemaChars: m.call.toolSchemaChars, attemptId: m.attemptId }, ...(was?.samples ?? [])].slice(0, FIXED_SAMPLES);
              const body = { route: m.route, harness, samples } as unknown as JsonObject;
              return { ref, creates: old === undefined, changes: [old === undefined ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: old.revision, body }], detail: {} };
            },
          }));
          return;
        } catch (error) {
          // Another first call wrote the figure at the same moment: read it again and add ours to it. Anything else (including a command that conflicts with itself, which no retry changes) is reported, not hidden, and never fails the admission.
          // Two creations of the record at once make the loser's `command_conflict` ("already exists"): that one is a race and is retried. The same command ID used for another payload (the record was there when this try began) cannot succeed on a retry.
          if (error instanceof DomainError && (error.code === "stale_revision" || (error.code === "command_conflict" && creating))) continue;
          this.#reportFixedError(error);
          return;
        }
      }
      this.#reportFixedError(new Error(`the figure of route ${m.route} could not be kept: other first calls kept changing it`));
    } catch (error) { this.#reportFixedError(error); /* best effort: the figure is an aid for later route changes, never a condition of this call */ }
  }
  /** At most once a minute, so a store that refuses every write is one line, not one per admission. */
  #reportFixedError(error: unknown): void {
    if (this.#onError === undefined) return;
    const now = Date.parse(this.#runner.now());
    if (Number.isFinite(now) && this.#lastFixedError !== 0 && now - this.#lastFixedError < 60_000) return;
    this.#lastFixedError = Number.isFinite(now) ? now : 1;
    try { this.#onError(error); } catch { /* the reporter must not fail the call */ }
  }

  /** The fixed part of a route, by the route's own name (the cleaning is done here, once) (with a harness; without one, the figure kept for no harness) as the latest first calls measured it, in characters and, at this window, in tokens; `undefined` when none has been measured. */
  async fixedPartOf(route: string, window: number, harness?: string): Promise<{ readonly systemPromptChars: number; readonly toolSchemaChars: number; readonly tokens: number } | undefined> {
    const h = harness === undefined ? "any" : key("harness", harness);
    const found = await this.#runner.get("ctx-route-fixed", derivedId("ctx", `route\0${key("route", contextRouteKey(route))}\0${h}\0fixed`));
    if (found === undefined) return undefined;
    const samples = (found.body as unknown as RouteFixedBody).samples;
    if (!Array.isArray(samples) || samples.length === 0) return undefined;
    // The median of the recent measurements (the upper one of an even count, so the figure errs toward the larger prompt; a sample of no size is no measurement and is ignored), as one of them whole so the parts stay consistent: one outlier, such as a task with a very large tool set, does not decide the figure for the other tasks.
    const sized = samples.filter((x) => x.systemPromptChars + x.toolSchemaChars > 0);
    if (sized.length === 0) return undefined;
    const sorted = [...sized].sort((a, b) => a.systemPromptChars + a.toolSchemaChars - (b.systemPromptChars + b.toolSchemaChars));
    const mid = sorted[Math.floor(sorted.length / 2)]!;
    return { systemPromptChars: mid.systemPromptChars, toolSchemaChars: mid.toolSchemaChars, tokens: tokensOf(mid.systemPromptChars + mid.toolSchemaChars, this.budget(window)) };
  }

  /** The recent measurements kept for a route and harness (newest first), as first calls reported them. */
  async fixedSamplesOf(route: string, harness?: string): Promise<readonly { systemPromptChars: number; toolSchemaChars: number }[]> {
    const h = harness === undefined ? "any" : key("harness", harness);
    const found = await this.#runner.get("ctx-route-fixed", derivedId("ctx", `route\0${key("route", contextRouteKey(route))}\0${h}\0fixed`));
    const samples = (found?.body as unknown as RouteFixedBody | undefined)?.samples;
    return Array.isArray(samples) ? samples.map((x) => ({ systemPromptChars: x.systemPromptChars, toolSchemaChars: x.toolSchemaChars })) : [];
  }

  /**
   * A running task moves to another route (a fallback, a cutover, a re-admitted attempt): the startup context is built again for the new route's window and its measured fixed part (card C07f). A route never measured
   * has no figure yet: its fixed part counts as 0 here (said in the reason of the record's basis `unmeasured`), and the first call on it is measured and checked by `admit` anyway. Repeating it with the same items answers with the recorded decision.
   */
  async routeMoved(principal: Principal, command: { taskId: string; attemptId: string; route: string; harness?: string; window: number; items: readonly StartupItem[]; promptChars?: number }): Promise<Awaited<ReturnType<ContextEnforcementService["changeRoute"]>> & { measured: boolean; view: string }> {
    onlyKnown(command, ["taskId", "attemptId", "route", "harness", "window", "items", "promptChars"]);
    const route = contextRouteKey(command.route);
    const promptChars = command.promptChars === undefined ? 0 : Number.isSafeInteger(command.promptChars) && command.promptChars >= 0 && command.promptChars <= ENFORCEMENT_LIMITS.material ? command.promptChars : invalid("promptChars", "must be a whole number of characters");
    const window = command.window;
    // A window the budgets cannot be made for (under 1,024 tokens, or absurdly large) is a refusal with a blocker, once; not a fault at every tick.
    if (Number.isSafeInteger(window)) {
      try { this.budget(window); } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId);
        await this.#dispatch(principal, taskId);
        const reason = `the route's context window of ${window} tokens is not one the context budgets can be made for (${error.message})`;
        const blockerId = await this.#openRouteBlock(principal, taskId, route, `${ROUTE_BLOCK} Attempt ${attemptId} cannot move to route ${route}: ${reason}. Set the route's contextTokens to its real window, or choose another route; then resolve this blocker.`);
        const startup: StartupResult = { pieces: [], tokens: 0, cuts: [], archive: [], blocked: { reason, needTokens: 0, haveTokens: 0 } };
        return { rebuilt: false, startup, reason, blockerId, id: derivedId("adm", `${taskId}\0${attemptId}\0route\0badwindow\0${route}\0${window}`), replayed: false, measured: false, view: "" };
      }
    }
    const measured = await this.fixedPartOf(command.route, window, command.harness);
    // A route nobody has measured counts a floor (a prompt of the size a host assumes, and the bridge tools' schemas), not 0: a count of 0 would admit what the first call then refuses. The owner can turn the floor off.
    const floorChars = measured === undefined ? (await this.#routeSettings?.effective())?.floorChars ?? DEFAULT_ROUTE_FLOOR_CHARS : 0;
    // The view's own header and footer go in the first prompt too (card C07g), and so does the rest of the prompt (the task's own text, the rules note; `promptChars`): they are counted with the fixed part, so the pieces are cut
    // to leave room for them and the first call that carries the view fits the startup share.
    const frame = Array.isArray(command.items) && command.items.length > 0 && Number.isSafeInteger(window) ? tokensOf(viewFrameChars(command.route, window, command.items.length) + promptChars, this.budget(window)) : 0;
    const fixedTokens = (measured?.tokens ?? (floorChars > 0 ? tokensOf(floorChars, this.budget(window)) : 0)) + frame;
    // The route and the window are part of the decision (a different window of the same attempt is a new decision, as is a different set of items or figure); the same ones repeat the recorded one.
    const launch = sha256(JSON.stringify([route, window, command.items, fixedTokens, measured === undefined ? "unmeasured" : "measured"])).slice(0, 16);
    const r = await this.changeRoute(principal, { taskId: command.taskId, attemptId: command.attemptId, launch, window, route, fixedTokens, items: command.items, ...(measured === undefined ? { fixedBasis: "unmeasured" as const } : {}) });
    // What the worker puts in its first prompt on this route: the kept pieces and the references of what was cut (empty when there is nothing to show, or nothing fits).
    return { ...r, measured: measured !== undefined, view: r.rebuilt ? startupViewText(r.startup, command.route, window) : "" };
  }

  /**
   * The fixed part of a route as a worker measured it when its process came up (card C07g), before the first prompt is built: the system prompt and the tool schemas the process will send. Kept like the figure of an
   * admitted first call (best effort: a failure is reported, never thrown), so a route nobody had measured is measured before the view built for it is trusted. Returns whether the route has a figure now.
   */
  async measureRoute(principal: Principal, command: { taskId: string; attemptId: string; launch?: string; route: string; harness?: string; systemPromptChars: number; toolSchemaChars: number }): Promise<{ measured: boolean }> {
    onlyKnown(command, ["taskId", "attemptId", "launch", "route", "harness", "systemPromptChars", "toolSchemaChars"]);
    const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId);
    await this.#dispatch(principal, taskId);
    if (typeof command.route !== "string" || command.route.length < 1 || command.route.length > 500) invalid("route", "must be a route name of 1 to 500 characters");
    const whole = (v: unknown, field: string): number => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= ENFORCEMENT_LIMITS.material ? (v as number) : invalid(field, "must be a whole number of characters"));
    const call: FirstCall = { systemPromptChars: whole(command.systemPromptChars, "systemPromptChars"), toolSchemaChars: whole(command.toolSchemaChars, "toolSchemaChars"), startupTokens: 0, replyReserveTokens: 0 };
    await this.#recordFixed(principal, { route: contextRouteKey(command.route), harness: command.harness, attemptId, admissionId: derivedId("adm", `${taskId}\0${attemptId}\0measure${launchPart(command.launch)}`), call });
    return { measured: (await this.fixedPartOf(command.route, 131_072, command.harness)) !== undefined };
  }

  /**
   * Falling back to a route with a smaller window: the startup context is built again for that window and that route's fixed part; if what must stay whole does not fit, a blocker is opened and nothing
   * is to be sent. The cut text is returned for archiving. Repeating it answers with the recorded decision (the view is rebuilt from the same items).
   */
  async changeRoute(principal: Principal, command: { taskId: string; attemptId: string; round?: number; launch?: string; window: number; route?: string; fixedTokens: number; fixedBasis?: "unmeasured"; items: readonly StartupItem[] }): Promise<{ rebuilt: boolean; startup: StartupResult; reason?: string; warning?: string; blockerId?: string; id: string; replayed: boolean }> {
    onlyKnown(command, ["taskId", "attemptId", "round", "launch", "window", "route", "fixedTokens", "fixedBasis", "items"]);
    const taskId = checkTaskId(command.taskId); const attemptId = key("attemptId", command.attemptId); const r = round(command.round); const w = window(command.window);
    const route = command.route === undefined ? `window-${w}` : key("route", command.route);
    const projectId = (await this.#dispatch(principal, taskId))!;
    if (!Array.isArray(command.items) || command.items.length > 1000) invalid("items", "must be a list of at most 1000 items");
    let review: ReturnType<typeof reviewRouteChange>;
    const budget = this.#budgetOf("window", w);
    let fixedTokens = command.fixedTokens;
    let warning: string | undefined;
    try {
      review = reviewRouteChange(command.items, budget, fixedTokens);
      // A route nobody has measured is not refused on a guess: the floor sizes the cut, and when even that leaves no room for the essentials the view is built without it and the first call, with the real figure, decides (a warning, not a blocker).
      if (review.kind === "blocked" && command.fixedBasis === "unmeasured" && fixedTokens > 0) {
        // The room the essentials leave is what the fixed part may take: the optional items are cut to the rest, not given the whole startup budget.
        const left = Math.max(0, Math.min(fixedTokens, budget.startupTokens - review.startup.tokens));
        const bare = reviewRouteChange(command.items, budget, left);
        if (bare.kind === "rebuilt") { review = bare; warning = `route ${route} has not been measured yet and its assumed fixed part (${fixedTokens} tokens) does not fit the ${w}-token window beside the essential constraints; the context was built with ${left} tokens set aside for it and the first call on the route will be checked with its real size`; fixedTokens = left; }
      }
    } catch (error) { if (error instanceof RangeError) return invalid("fixedTokens", error.message); throw error; }
    // The decision is named by everything it was made from (route, window, fixed part, items): the same attempt asked again with another route or window is a new decision, never the old command ID with a different payload.
    const asked = sha256(JSON.stringify([route, w, command.fixedTokens, command.fixedBasis ?? null, command.items])).slice(0, 16);
    const id = derivedId("adm", `${taskId}\0${attemptId}\0route\0${r}${launchPart(command.launch)}\0${asked}`);
    const ref: AggregateRef = { kind: "ctx-admission", id };
    const reasons = review.kind === "blocked" ? [review.reason] : [];
    const body: AdmissionBody = { type: "route-change", taskId, projectId, attemptId, round: r, window: w, route, admit: review.kind === "rebuilt", startupTokens: review.startup.tokens + fixedTokens, estimatedTokens: review.startup.tokens + fixedTokens, rawEstimatedTokens: review.startup.tokens + fixedTokens, workingTokens: 0, basis: command.fixedBasis === "unmeasured" ? "unmeasured" : "estimated", reasons: warning === undefined ? reasons : [warning], decidedBy: principal.id };
    // The text that was cut is kept (once per task and content) before the decision is written, in batches, so it is archived even if the caller never stores what is returned; a very long item is kept up to a limit and says so.
    const fresh: { aref: AggregateRef; body: JsonObject }[] = [];
    for (const a of review.startup.archive) {
      const aref: AggregateRef = { kind: "ctx-route-archive", id: derivedId("ctx", `${taskId}\0archive\0${a.digest}`) };
      if (fresh.some((f) => f.aref.id === aref.id) || (await this.#runner.get(aref.kind, aref.id)) !== undefined) continue;
      const kept = redactText(a.text);
      fresh.push({ aref, body: { taskId, projectId, itemId: a.id, kind: review.startup.cuts.find((c) => c.digest === a.digest)?.kind ?? "other", digest: a.digest, text: kept.slice(0, ENFORCEMENT_LIMITS.archiveChars), ...(kept.length > ENFORCEMENT_LIMITS.archiveChars ? { truncated: true } : {}), routeDecision: id } as unknown as JsonObject });
    }
    for (let i = 0; i < fresh.length; i += 50) {
      const chunk = fresh.slice(i, i + 50);
      // Named by what is in the batch (the cut set can differ from an earlier try of the same decision when some of it was stored meanwhile).
      await this.#runner.command("context.route-archive", { commandId: `ctx-rta-${id.slice(4)}-${i / 50}-${sha256(chunk.map((c) => c.aref.id).join("\0")).slice(0, 12)}`, actor: principal.id }, async () => ({
        payload: { digests: chunk.map((c) => c.aref.id) },
        build: async () => ({ ref: chunk[0]!.aref, creates: true, changes: chunk.map((c) => ({ type: "create" as const, ref: c.aref, body: c.body })), detail: { archived: chunk.length } }),
      }));
    }
    const run = await this.#runner.command("context.route", { commandId: `ctx-rte-${id.slice(4)}`, actor: principal.id }, async () => ({
      payload: { taskId, attemptId, round: r, window: w, route, fixedTokens: command.fixedTokens, basis: command.fixedBasis ?? null, items: sha256(JSON.stringify(command.items)) },
      build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { rebuilt: review.kind === "rebuilt" } }),
    }));
    const blockerId = review.kind === "blocked" ? await this.#openRouteBlock(principal, taskId, route, `${ROUTE_BLOCK} Attempt ${attemptId} cannot move to the ${w}-token route ${route}: ${review.reason}. Choose a route with a larger window (raise the route's contextTokens), reduce the task contract, supersede decisions that are no longer needed, or reassign the task; then resolve this blocker.`) : undefined;
    // The context fits this route now: a refusal this mechanism opened for an earlier move (to this route before its window was raised, or to another one) is stale and is closed, so the first call is not held for it.
    if (review.kind === "rebuilt") await this.#closeRouteBlock(principal, taskId, `The task's context now fits route ${route} (${w} tokens); the route change this blocker was about is settled.`);
    return { rebuilt: review.kind === "rebuilt", startup: review.startup, ...(review.kind === "blocked" ? { reason: review.reason } : {}), ...(warning === undefined ? {} : { warning }), ...(blockerId === undefined ? {} : { blockerId }), id, replayed: run.replayed };
  }

  /**
   * The task is back on the route it ran on (a route that flapped): a `context_overflow` blocker a route change opened is stale and is closed, so that admission is not held for a move that is no longer wanted. Any other context blocker stays.
   * Returns the blocker closed, if any.
   */
  async routeKept(principal: Principal, command: { taskId: string; route?: string }): Promise<{ closed?: string }> {
    onlyKnown(command, ["taskId", "route"]);
    const taskId = checkTaskId(command.taskId);
    if (command.route !== undefined && (typeof command.route !== "string" || command.route.length < 1 || command.route.length > 500)) invalid("route", "must be a route name of 1 to 500 characters");
    await this.#dispatch(principal, taskId);
    // A refusal for the very route the task is on is not stale (card C07g review): the worker refused the first call on this route after the task was placed on it, and a later attempt on the same route must not close it.
    const closed = await this.#closeRouteBlock(principal, taskId, "The task is back on the route it ran on; the route change this blocker was about is no longer wanted.", command.route === undefined ? undefined : contextRouteKey(command.route));
    return closed === undefined ? {} : { closed };
  }

  /** The record of the blocker a route change opened (one per task): the structured mark that tells it from any other `context_overflow` blocker. */
  static #routeBlockRef = (taskId: string): AggregateRef => ({ kind: "ctx-route-block", id: derivedId("ctx", `${taskId}\0routeblock`) });
  /** Opens the task's `context_overflow` blocker for a refused move and marks it as this mechanism's; one that was already open (an admission refusal, or this one on an earlier tick) is returned and left as it is. */
  async #openRouteBlock(principal: Principal, taskId: string, route: string, summary: string): Promise<string> {
    const id = await this.#block(principal, taskId, summary);
    // Marked by what the blocker is, read after it was opened or found, not by a look taken before: a blocker an admission refusal opened meanwhile is not this mechanism's, and one this mechanism opened on an earlier tick whose mark was lost is marked now.
    const blocker = await this.#blockers.getBlocker(id);
    const ref = ContextEnforcementService.#routeBlockRef(taskId);
    // The mark names the route the refusal was for (card C07g review), so that being on that same route does not count as having moved back.
    const markFound = await this.#runner.get(ref.kind, ref.id);
    const marked = markFound?.body as unknown as { blockerId?: string; route?: string } | undefined;
    if (blocker !== undefined && blocker.summary.startsWith(ROUTE_BLOCK) && (marked?.blockerId !== id || marked.route !== route)) {
      // The command ID carries the mark's revision as read: a blocker kept open while its refusals go A, then B, then A again is marked for A again (the ID of the first marking would replay it and leave the mark on B,
      // and the task then placed on A would close the refusal as stale).
      await this.#runner.command("context.route-block", { commandId: `ctx-rtm-${id}-${sha256(route).slice(0, 12)}-${markFound?.revision ?? 0}`, actor: principal.id }, async () => ({
        payload: { taskId, blockerId: id, route },
        build: async () => {
          const old = await this.#runner.get(ref.kind, ref.id);
          const body = { taskId, blockerId: id, route } as unknown as JsonObject;
          return { ref, creates: old === undefined, changes: [old === undefined ? { type: "create" as const, ref, body } : { type: "update" as const, ref, expectedRevision: old.revision, body }], detail: {} };
        },
      }));
    }
    return id;
  }
  /**
   * Closes the open `context_overflow` blocker of the task if (and only if) a route change opened it, by the mark written with it; an admission refusal or any other context blocker stays.
   * A blocker opened before the mark existed (no mark record for the task) is recognised by the start of its text, once.
   */
  async #closeRouteBlock(principal: Principal, taskId: string, resolution: string, /** The route the task is kept on: a refusal marked for this same route stays. */ keptOn?: string): Promise<string | undefined> {
    const open = await this.#blockers.openFor("context_overflow", { kind: "task", id: taskId });
    if (open === undefined) return undefined;
    const ref = ContextEnforcementService.#routeBlockRef(taskId);
    const mark = (await this.#runner.get(ref.kind, ref.id))?.body as unknown as { blockerId?: string; route?: string } | undefined;
    if (mark === undefined ? !open.summary.startsWith(ROUTE_BLOCK) : mark.blockerId !== open.id) return undefined;
    if (keptOn !== undefined && mark?.route === keptOn) return undefined;
    try { await this.#blockers.resolveBlocker({ commandId: `ctx-rtk-${open.id}`, actor: principal.id, blockerId: open.id, expectedRevision: open.revision, resolution }); } catch (error) { if (!(error instanceof DomainError && (error.code === "stale_revision" || error.code === "invalid_command"))) throw error; }
    return open.id;
  }

  /** The full text of an item cut or left out when a smaller route was chosen, by the digest the cut names. Readable by whoever may work on the task. */
  async routeArchive(principal: Principal, command: { taskId: string; digest: string }): Promise<{ itemId: string; text: string; digest: string } | undefined> {
    onlyKnown(command, ["taskId", "digest"]);
    const taskId = checkTaskId(command.taskId);
    if ((await this.#task(principal, taskId, true)) === undefined) return undefined;
    const found = typeof command.digest === "string" ? await this.#runner.get("ctx-route-archive", derivedId("ctx", `${taskId}\0archive\0${command.digest}`)) : undefined;
    if (found === undefined) return undefined;
    const b = found.body as unknown as { itemId: string; text: string; digest: string; kind?: string; projectId?: string };
    // The owner's decisions, goals, instructions and permissions are the project's, not the task's: whoever works on the task reads the cut text of those only with the right to read the project's history.
    if (b.kind === undefined || PROJECT_WIDE.has(b.kind)) { if (b.projectId === undefined || !allows(principal, "history.read", b.projectId)) return undefined; }
    return { itemId: b.itemId, text: b.text, digest: b.digest };
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
    const made = await this.#retrieval.summarize(principal, { commandId: `ctx-sum-${a.id.slice(4)}`, projectId: a.body.projectId, title: `Context summary ${a.body.key} (generation ${a.body.generation})`, text: a.body.summary ?? "", sources: [...a.body.sources, ...a.body.pinned.filter((p) => !a.body.sources.some((s) => sameSource(s, p)))] }, { taskId: a.body.taskId });
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
  async limitTool(principal: Principal, command: { taskId: string; callId: string; tool: string; window: number; output: ToolOutput; pageSize?: number; untrusted?: boolean }): Promise<{ text: string; truncated: boolean; spillId?: string; remainderChars: number; lostChars: number; nonTextDropped: number }> {
    onlyKnown(command, ["taskId", "callId", "tool", "window", "output", "pageSize", "untrusted"]);
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
    const body: SpillBody = { ...(command.untrusted === true ? { untrusted: true } : {}), taskId, projectId, tool, callId, remainder: kept, remainderChars: out.remainderChars, lostChars: lost };
    await this.#runner.command("context.spill", { commandId: `ctx-spl-${id.slice(4)}`, actor: principal.id }, async () => ({
      payload: { taskId, callId, tool, remainderDigest: sha256(out.remainder), lostChars: lost },
      build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { remainderChars: out.remainderChars } }),
    }));
    const note = `\n[Rest of this result: spill ${id}, ${out.remainderChars} characters${lost > 0 ? `, of which ${lost} could not be kept` : ""}; read it in pages]`;
    return { text: out.text + note, truncated: true, spillId: id, remainderChars: out.remainderChars, lostChars: lost, nonTextDropped: out.nonTextDropped };
  }
  /** One page of a kept remainder, for someone who may work on the task; otherwise it reads like a missing spill. */
  async readSpill(principal: Principal, spillId: string, index: number, size = 12_000): Promise<{ text: string; next?: number; tool?: string; untrusted?: true } | undefined> {
    const found = typeof spillId === "string" && /^spl-[a-z2-7]{20}$/.test(spillId) ? await this.#runner.get("ctx-spill", spillId) : undefined;
    if (found === undefined) return undefined;
    const b = found.body as unknown as SpillBody;
    if ((await this.#task(principal, b.taskId, true)) === undefined) return undefined;
    // An outside server's answer is read only by those who could have been given it: the owner and those who may use MCP in the project.
    if (b.untrusted === true && principal.kind !== "owner" && !allows(principal, "mcp.use", b.projectId)) return undefined;
    try { return { ...page(b.remainder, index, size), tool: b.tool, ...(b.untrusted === true ? { untrusted: true as const } : {}) }; } catch (error) { if (error instanceof RangeError) return invalid("index", error.message); throw error; }
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

import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";

// Card C07i: each attempt's starting size (the first call it was given), watched across a task's hand-offs, so a slowdown is noticed while it is still small. The watch only records and tells: it never trims, cuts
// or compacts anything, and it writes no record but its own (the task, its hand-offs, notes and archives are left exactly as they are).

/** What a first call is made of, as far as the controller can tell them apart (tokens each). `other` is what is left of the whole once the named parts are taken away. */
export const START_PARTS = ["conversation", "handoff", "notes", "rules", "task", "view", "fixed", "other"] as const;
export type StartPart = (typeof START_PARTS)[number];
/** The parts in the owner's words. */
export const START_PART_WORDS: Readonly<Record<StartPart, string>> = { conversation: "stored conversation", handoff: "hand-off package", notes: "notes (resume and approval notes)", rules: "project rules", task: "the task's own text", view: "the owner's context rebuilt for the route", fixed: "system prompt and tool schemas", other: "the rest" };

export const START_SIZE_DEFAULTS = { risingHandoffs: 3, warnPercent: 80, minRisePercent: 1 } as const;
type SettingName = keyof typeof START_SIZE_DEFAULTS;
const SETTING_NAMES: readonly SettingName[] = ["risingHandoffs", "warnPercent", "minRisePercent"];
/** Validated bounds of the owner's figures. A warning at 100 percent or more would come only after the refusal it is meant to precede, so the share stops at 99. */
export const START_SIZE_BOUNDS: Readonly<Record<SettingName, { readonly min: number; readonly max: number }>> = { risingHandoffs: { min: 2, max: 20 }, warnPercent: { min: 50, max: 99 }, minRisePercent: { min: 0, max: 100 } };
/** The points kept whole per task; older ones are rolled up into one summary (count, smallest, largest, mean). Bigger than the longest rising run the owner can ask for. */
export const START_SIZE_LIMITS = { points: 50, refs: 8, contributors: 3 } as const;
if (START_SIZE_LIMITS.points <= START_SIZE_BOUNDS.risingHandoffs.max) throw new Error("START_SIZE_LIMITS.points must exceed the longest rising run");

export interface StartSizePoint {
  readonly attemptId: string;
  /** How many hand-offs the task had had when this attempt started: 0 for its first attempt. */
  readonly handoff: number;
  readonly at: string;
  readonly route: string;
  readonly worker: "local" | "remote";
  readonly tokens: number;
  /** The route's window and the startup limit in tokens (the refusal line). Absent: the route's window is not known, and the share is unknown, never zero. */
  readonly window?: number;
  readonly limitTokens?: number;
  /** Percent of the startup limit, one decimal. Absent with the limit. */
  readonly share?: number;
  readonly admitted: boolean;
  readonly parts: Readonly<Partial<Record<StartPart, number>>>;
  /** Records that hold the originals of what this call carried by reference (hand-offs, hand-off notes, cut notes' digests). */
  readonly refs: readonly string[];
}
export interface StartSizeRollup { readonly count: number; readonly fromHandoff: number; readonly toHandoff: number; readonly firstAt: string; readonly lastAt: string; readonly minTokens: number; readonly maxTokens: number; readonly sumTokens: number }
export interface StartSizeAlert {
  readonly id: string;
  readonly kind: "trend" | "share";
  readonly state: "open" | "cleared";
  readonly openedAt: string; readonly openedAtHandoff: number; readonly attemptId: string;
  readonly clearedAt?: string;
  /** The starting sizes of the run, oldest first (trend), or the size that passed the line (share). */
  readonly tokens: readonly number[];
  readonly share?: number; readonly limitTokens?: number;
  /** The largest contributors of the newest call, largest first, and how much each grew over the run (trend). */
  readonly contributors: readonly { readonly part: StartPart; readonly tokens: number; readonly grew?: number }[];
  readonly refs: readonly string[];
}
export interface StartSizeBody {
  readonly taskId: string; readonly projectId: string;
  /** Attempts seen; the next new attempt is hand-off number `attempts`. */
  readonly attempts: number;
  readonly points: readonly StartSizePoint[];
  readonly rolled?: StartSizeRollup;
  readonly alerts: { readonly trend?: StartSizeAlert; readonly share?: StartSizeAlert };
  readonly raised: number;
}
export interface StartSizeSample {
  readonly taskId: string; readonly attemptId: string;
  /** Tells one admission of an attempt from another (its round and launch), so a repeat of the same one is the same command. */
  readonly key: string;
  readonly route: string; readonly worker: "local" | "remote";
  readonly tokens: number; readonly window?: number; readonly limitTokens?: number; readonly admitted: boolean;
  readonly parts?: Readonly<Partial<Record<StartPart, number>>>;
  readonly refs?: readonly string[];
}
export interface StartSizeSettingsEffective { readonly risingHandoffs: number; readonly warnPercent: number; readonly minRisePercent: number }

const KIND = "ctx-start-size";
const SETTINGS: AggregateRef = { kind: "ctx-start-size-settings", id: "main" };
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const whole = (v: unknown, field: string): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : invalid(field, "must be a whole number from 0"));
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,199}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;
const seriesId = (taskId: string): string => derivedId("css", taskId);

/** Consecutive rises that end at the newest point: each at least `minRisePercent` above the one before it. */
export function risingRun(tokens: readonly number[], minRisePercent: number): number {
  let run = 0;
  for (let i = tokens.length - 1; i > 0; i--) {
    const prev = tokens[i - 1]!; const cur = tokens[i]!;
    if (cur > prev && cur >= prev * (1 + minRisePercent / 100)) run++; else break;
  }
  return run;
}
const shareOf = (tokens: number, limit: number | undefined): number | undefined => (limit === undefined || limit <= 0 ? undefined : Math.round((tokens / limit) * 1000) / 10);
/** The largest parts of a call, largest first; with `from`, how much each grew since. */
function largest(parts: StartSizePoint["parts"], from?: StartSizePoint["parts"]): StartSizeAlert["contributors"] {
  return START_PARTS.map((part) => ({ part, tokens: parts[part] ?? 0, ...(from === undefined ? {} : { grew: (parts[part] ?? 0) - (from[part] ?? 0) }) }))
    .filter((c) => c.tokens > 0)
    .sort((a, b) => (from === undefined ? b.tokens - a.tokens : (b.grew ?? 0) - (a.grew ?? 0) || b.tokens - a.tokens))
    .slice(0, START_SIZE_LIMITS.contributors);
}

/** One line that tells the owner what an alert is about, in the controller's words (record IDs and figures only). */
export function startSizeAlertText(a: Pick<StartSizeAlert, "kind" | "tokens" | "share" | "limitTokens" | "contributors" | "openedAtHandoff">): string {
  const parts = a.contributors.map((c) => `${START_PART_WORDS[c.part]} ${c.tokens}${c.grew === undefined || c.grew === 0 ? "" : ` (${c.grew > 0 ? "+" : ""}${c.grew})`}`).join(", ");
  const head = a.kind === "trend"
    ? `its starting size rose over ${a.tokens.length - 1} hand-offs in a row (${a.tokens.join(" -> ")} tokens, up to hand-off ${a.openedAtHandoff})`
    : `its starting size of ${a.tokens[a.tokens.length - 1]} tokens is ${a.share} percent of the route's startup limit of ${a.limitTokens} tokens (the first call is refused above it)`;
  return `${head}; largest contributors: ${parts === "" ? "none named" : parts}. Nothing was cut for it`;
}

/**
 * The watch on each attempt's starting size (card C07i). The dispatcher's guards record every first call they judge, local and remote, admitted or refused, with the route's limit (unknown when the route's window
 * is), keyed by task and hand-off. A task's run of rising sizes and a size past the owner's share of the limit each raise ONE alert while they last (not one per attempt), which clears when the run breaks or the size falls back
 * below the line; the next one raises a new alert. The record is bounded: the newest points stay whole and older ones are rolled up.
 */
export class StartSizeService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): StartSizeService { return new StartSizeService(new CommandRunner(storage, epoch, options)); }

  // ---- settings ---------------------------------------------------------------------------------------------------------------

  async effective(): Promise<StartSizeSettingsEffective> {
    const b = this.#settingsOf((await this.#runner.get(SETTINGS.kind, SETTINGS.id))?.body);
    return { risingHandoffs: b.risingHandoffs ?? START_SIZE_DEFAULTS.risingHandoffs, warnPercent: b.warnPercent ?? START_SIZE_DEFAULTS.warnPercent, minRisePercent: b.minRisePercent ?? START_SIZE_DEFAULTS.minRisePercent };
  }
  /** A damaged entry is read as not set (the default applies) rather than stopping the watch. */
  #settingsOf(body: unknown): Partial<StartSizeSettingsEffective> {
    if (body === undefined || body === null || typeof body !== "object") return {};
    const out: Partial<Record<SettingName, number>> = {};
    for (const n of SETTING_NAMES) {
      const v = (body as Record<string, unknown>)[n];
      if (typeof v === "number" && Number.isSafeInteger(v) && v >= START_SIZE_BOUNDS[n].min && v <= START_SIZE_BOUNDS[n].max) out[n] = v;
    }
    return out;
  }

  async getSettings(by: Principal): Promise<{ revision: number; settings: Partial<StartSizeSettingsEffective>; defaults: StartSizeSettingsEffective; bounds: typeof START_SIZE_BOUNDS; effective: StartSizeSettingsEffective }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the starting-size watch settings`);
    const found = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
    return { revision: found?.revision ?? 0, settings: this.#settingsOf(found?.body), defaults: { ...START_SIZE_DEFAULTS }, bounds: START_SIZE_BOUNDS, effective: await this.effective() };
  }

  /** The owner sets or clears the watch's figures (owner only); a figure not named keeps its value. */
  async changeSettings(owner: Principal, command: NoActor & { set?: unknown; unset?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the starting-size watch settings`);
    onlyKnown(command, ["commandId", "set", "unset", "expectedRevision"]);
    const set: Partial<Record<SettingName, number>> = {};
    if (command.set !== undefined) {
      if (command.set === null || typeof command.set !== "object" || Array.isArray(command.set)) invalid("set", "must be an object such as { \"risingHandoffs\": 4 }");
      for (const [k, v] of Object.entries(command.set as object)) {
        if (!(SETTING_NAMES as readonly string[]).includes(k)) invalid("set", `${k.slice(0, 30)} is not a setting (${SETTING_NAMES.join(", ")})`);
        const b = START_SIZE_BOUNDS[k as SettingName];
        set[k as SettingName] = typeof v === "number" && Number.isSafeInteger(v) && v >= b.min && v <= b.max ? v : invalid(`set.${k}`, `must be a whole number from ${b.min} to ${b.max}`);
      }
    }
    const unset = command.unset === undefined ? [] : Array.isArray(command.unset) ? command.unset.map((k) => (typeof k === "string" && (SETTING_NAMES as readonly string[]).includes(k) ? (k as SettingName) : invalid("unset", `${String(k).slice(0, 30)} is not a setting (${SETTING_NAMES.join(", ")})`))) : invalid("unset", "must be a list of setting names");
    const named = [...Object.keys(set), ...unset];
    if (named.length === 0) invalid("set", "name at least one setting to set or unset");
    if (new Set(named).size !== named.length) invalid("set", "a setting is named once across set and unset");
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) invalid("expectedRevision", "must be a whole number");
    const r = await this.#runner.command("context.start-size.settings", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { set: set as JsonObject, unset, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the starting-size watch settings are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const next: Record<string, unknown> = { ...this.#settingsOf(current?.body), ...set };
        for (const k of unset) delete next[k];
        const body = { ...next, updatedBy: owner.id, updatedAt: this.#runner.now() } as JsonObject;
        return { ref: SETTINGS, creates: current === undefined, changes: [current === undefined ? { type: "create" as const, ref: SETTINGS, body } : { type: "update" as const, ref: SETTINGS, expectedRevision: current.revision, body }], detail: {} };
      },
    }));
    return { revision: r.revision };
  }

  // ---- the watch --------------------------------------------------------------------------------------------------------------

  /**
   * Records one first call (the dispatcher's guards, as the controller: never an agent). Returns the alerts this call opened, for the caller to tell the owner; a repeat of the same admission records nothing new and
   * opens nothing. A later admission of an attempt already recorded (another round or launch) replaces that attempt's point and is not a new hand-off.
   */
  async record(by: Principal, sample: StartSizeSample): Promise<{ readonly opened: readonly StartSizeAlert[]; readonly replayed: boolean; readonly projectId: string }> {
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} may not record starting sizes; it is the controller's watch`);
    onlyKnown(sample, ["taskId", "attemptId", "key", "route", "worker", "tokens", "window", "limitTokens", "admitted", "parts", "refs"]);
    const taskId = checkTaskId(sample.taskId);
    if (typeof sample.attemptId !== "string" || !KEY.test(sample.attemptId)) invalid("attemptId", "must be an attempt ID");
    if (typeof sample.key !== "string" || !KEY.test(sample.key)) invalid("key", "must be 1 to 200 ASCII letters, digits, '.', '_', ':', '~' or '-'");
    if (sample.worker !== "local" && sample.worker !== "remote") invalid("worker", "must be local or remote");
    if (typeof sample.admitted !== "boolean") invalid("admitted", "must be true or false");
    const tokens = whole(sample.tokens, "tokens");
    const windowTokens = sample.window === undefined ? undefined : whole(sample.window, "window") || invalid("window", "must be a positive number of tokens");
    const limitTokens = sample.limitTokens === undefined || windowTokens === undefined ? undefined : whole(sample.limitTokens, "limitTokens") || invalid("limitTokens", "must be a positive number of tokens");
    const parts: Partial<Record<StartPart, number>> = {};
    for (const [k, v] of Object.entries(sample.parts ?? {})) { if (!(START_PARTS as readonly string[]).includes(k)) invalid("parts", `${k.slice(0, 30)} is not a part`); if (v !== undefined && v !== 0) parts[k as StartPart] = whole(v, `parts.${k}`); }
    const refs = [...new Set((sample.refs ?? []).filter((r) => typeof r === "string" && REF.test(r)))].slice(0, START_SIZE_LIMITS.refs);
    const route = String(sample.route).replace(/\s+/g, " ").slice(0, 200);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", `task ${taskId} does not exist`);
    const settings = await this.effective();
    const ref: AggregateRef = { kind: KIND, id: seriesId(taskId) };
    let opened: StartSizeAlert[] = [];
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.#runner.command("context.start-size.record", { commandId: `css-${derivedId("css", `${taskId}\0${sample.attemptId}\0${sample.key}`).slice(4)}`, actor: by.id }, async () => ({
          payload: { taskId, attemptId: sample.attemptId, key: sample.key, route, worker: sample.worker, tokens, window: windowTokens ?? null, limitTokens: limitTokens ?? null, admitted: sample.admitted, parts: parts as JsonObject, refs },
          build: async () => {
            const found = await this.#runner.get(KIND, ref.id);
            const old = found?.body as unknown as StartSizeBody | undefined;
            const now = this.#runner.now();
            const at = old?.points.findIndex((p) => p.attemptId === sample.attemptId) ?? -1;
            const handoff = at >= 0 ? old!.points[at]!.handoff : old?.attempts ?? 0;
            const share = shareOf(tokens, limitTokens);
            const point: StartSizePoint = { attemptId: sample.attemptId, handoff, at: now, route, worker: sample.worker, tokens, ...(windowTokens === undefined ? {} : { window: windowTokens }), ...(limitTokens === undefined ? {} : { limitTokens }), ...(share === undefined ? {} : { share }), admitted: sample.admitted, parts, refs };
            let points = [...(old?.points ?? [])];
            if (at >= 0) points[at] = point; else points.push(point);
            let rolled = old?.rolled;
            while (points.length > START_SIZE_LIMITS.points) {
              const p = points.shift()!;
              rolled = rolled === undefined ? { count: 1, fromHandoff: p.handoff, toHandoff: p.handoff, firstAt: p.at, lastAt: p.at, minTokens: p.tokens, maxTokens: p.tokens, sumTokens: p.tokens }
                : { count: rolled.count + 1, fromHandoff: rolled.fromHandoff, toHandoff: p.handoff, firstAt: rolled.firstAt, lastAt: p.at, minTokens: Math.min(rolled.minTokens, p.tokens), maxTokens: Math.max(rolled.maxTokens, p.tokens), sumTokens: rolled.sumTokens + p.tokens };
            }
            // Judged on the newest point only: a late admission of an older attempt corrects its figure but does not raise or clear anything.
            const newest = points[points.length - 1]!.attemptId === sample.attemptId;
            const alerts = { ...(old?.alerts ?? {}) };
            let raised = old?.raised ?? 0;
            opened = [];
            const open = (kind: StartSizeAlert["kind"], a: Omit<StartSizeAlert, "id" | "kind" | "state" | "openedAt" | "openedAtHandoff" | "attemptId" | "refs">): void => {
              raised++;
              const alert: StartSizeAlert = { id: derivedId("css", `${taskId}\0alert\0${raised}`), kind, state: "open", openedAt: now, openedAtHandoff: handoff, attemptId: sample.attemptId, ...a, refs: [...new Set(points.slice(-(settings.risingHandoffs + 1)).flatMap((p) => p.refs))].slice(0, START_SIZE_LIMITS.refs) };
              alerts[kind] = alert; opened.push(alert);
            };
            const clear = (kind: StartSizeAlert["kind"]): void => { const a = alerts[kind]; if (a !== undefined && a.state === "open") alerts[kind] = { ...a, state: "cleared", clearedAt: now }; };
            if (newest) {
              const run = risingRun(points.map((p) => p.tokens), settings.minRisePercent);
              if (run >= settings.risingHandoffs) {
                if (alerts.trend?.state !== "open") { const first = points[points.length - 1 - run]!; open("trend", { tokens: points.slice(-(run + 1)).map((p) => p.tokens), contributors: largest(parts, first.parts) }); }
              } else clear("trend");
              if (share !== undefined && share >= settings.warnPercent) {
                if (alerts.share?.state !== "open") open("share", { tokens: [tokens], share, limitTokens: limitTokens!, contributors: largest(parts) });
              } else clear("share");
            }
            const body: StartSizeBody = { taskId, projectId: task.projectId, attempts: at >= 0 ? old!.attempts : (old?.attempts ?? 0) + 1, points, ...(rolled === undefined ? {} : { rolled }), alerts, raised };
            return { ref, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref, body: body as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: found.revision, body: body as unknown as JsonObject }], detail: { opened: opened.map((a) => a.kind) }, contention: async () => new DomainError("stale_revision", "the starting sizes of this task were recorded at the same moment") };
          },
        }));
        return { opened: r.replayed ? [] : opened, replayed: r.replayed, projectId: task.projectId };
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || attempt >= 8) throw error;
      }
    }
  }

  /** A task's starting sizes, as recorded: the owner, and whoever may work on the task. Anyone else gets nothing, as for a task that does not exist. */
  async read(by: Principal, query: { taskId: string }): Promise<(StartSizeBody & { revision: number; settings: StartSizeSettingsEffective }) | undefined> {
    onlyKnown(query, ["taskId"]);
    const taskId = checkTaskId(query.taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined || !(by.kind === "owner" || allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } }))) return undefined;
    const found = await this.#runner.get(KIND, seriesId(taskId));
    const settings = await this.effective();
    if (found === undefined) return { taskId, projectId: task.projectId, attempts: 0, points: [], alerts: {}, raised: 0, revision: 0, settings };
    return { ...(found.body as unknown as StartSizeBody), revision: found.revision, settings };
  }

  /** The alerts open on a task, for the controller's own views (the task status). */
  async openAlerts(taskId: string): Promise<readonly StartSizeAlert[]> {
    const b = (await this.#runner.get(KIND, seriesId(checkTaskId(taskId))))?.body as unknown as StartSizeBody | undefined;
    return [b?.alerts.trend, b?.alerts.share].filter((a): a is StartSizeAlert => a !== undefined && a.state === "open");
  }
}

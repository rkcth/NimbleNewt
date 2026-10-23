import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, taskId as checkTaskId, text, type ProjectBody, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type Built, type CommandResult, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { PROJECT_WORK_LIMITS as L, hidden, invalid, may, noCredential, scanAll } from "./common.js";
import { CLAIM, RESOURCE, resourceIdOf, type ClaimBody, type ResourceBody } from "./resources.js";

export type ResponsibilityState = "active" | "paused" | "retired";
export const RESPONSIBILITY_STATES: readonly ResponsibilityState[] = ["active", "paused", "retired"];

/** A recurring period in UTC: days 0 (Sunday) to 6, `start` up to but not including `end` (HH:MM). A window that crosses midnight is two windows. */
export interface MaintenanceWindow { readonly days: readonly number[]; readonly start: string; readonly end: string }
export interface Escalation {
  /** `owner`, or the principal ID of an agent. */
  readonly to: string;
  readonly afterMinutes?: number;
  readonly note?: string;
}

/**
 * A continuing responsibility (kind `responsibility`): an objective that does not end when one task does, such as keeping a server healthy, running marketing or maintaining documents.
 * It lives in a project (which needs no repository), is answered for by at most one agent, and names the project's resources it manages, the condition it should be in, how often and on
 * which events it is checked, which actions it may use at most, when maintenance may happen and who is told when it cannot be kept.
 */
export interface ResponsibilityBody {
  readonly projectId: string;
  readonly title: string;
  readonly objective: string;
  readonly desiredCondition: string;
  /** The agent answerable for it (a principal ID). */
  readonly ownerId?: string;
  /** IDs of the project's resource bindings it manages. A resource has at most one holder. */
  readonly managed: readonly string[];
  readonly everyMinutes?: number;
  readonly eventSources: readonly string[];
  /** Action names its work may use at most; narrows, never grants (the same meaning as a task contract's `permissions`). */
  readonly permittedActions: readonly string[];
  readonly maintenanceWindows: readonly MaintenanceWindow[];
  readonly escalation?: Escalation;
  readonly state: ResponsibilityState;
  readonly createdBy: string;
}

export const OBSERVATION_KINDS = ["check", "intervention", "incident", "note"] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];
export const OUTCOMES = ["ok", "attention", "failed"] as const;

/** One entry of a responsibility's operational history (kind `responsibility-event`, ID `<responsibility>.<seq>`). Append-only. */
export interface ObservationBody {
  readonly responsibilityId: string;
  readonly projectId: string;
  readonly seq: number;
  readonly kind: ObservationKind;
  readonly summary: string;
  readonly outcome?: (typeof OUTCOMES)[number];
  /** The bounded task a check or intervention produced, when it produced one. */
  readonly taskId?: string;
  readonly at: string;
  readonly by: string;
}

interface LogBody { readonly n: number; readonly lastCheckAt?: string; readonly lastCheckOutcome?: string }

export interface ResponsibilityStatus {
  readonly responsibilityId: string;
  readonly state: ResponsibilityState;
  readonly asOf: string;
  readonly events: number;
  readonly lastCheckAt?: string;
  readonly lastCheckOutcome?: string;
  /** When the next check is due (from the last check, or from creation), when checks are scheduled. */
  readonly nextCheckDue?: string;
  /** An active responsibility whose next check is past due. Information only: nothing is started or changed by it. */
  readonly checkOverdue: boolean;
  readonly inMaintenanceWindow: boolean;
}

const RESPONSIBILITY = "responsibility";
const LOG = "responsibility-log";
const EVENT = "responsibility-event";
const RESPONSIBILITY_ID = /^rsp-[a-z2-7]{20}$/;
const ACTION = /^(?:\*|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*(?:\.\*)?)$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FIELDS = ["title", "objective", "desiredCondition", "ownerId", "managed", "everyMinutes", "eventSources", "permittedActions", "maintenanceWindows", "escalation"] as const;
const MINUTES_MAX = 525_600;

const responsibilityIdOf = (value: unknown): string => (typeof value === "string" && RESPONSIBILITY_ID.test(value) ? value : invalid("responsibilityId", "is not a responsibility ID"));
const strings = (v: unknown, field: string, max: number, item: number): string[] => {
  if (!Array.isArray(v) || v.length > max) return invalid(field, `must be a list of at most ${max} entries`);
  return [...new Set(v.map((x, i) => text(x, `${field}[${i}]`, { min: 1, max: item })))];
};
const minutes = (v: unknown, field: string): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= MINUTES_MAX ? v : invalid(field, `must be a whole number of minutes from 1 to ${MINUTES_MAX}`));

function parseWindows(value: unknown): MaintenanceWindow[] {
  if (!Array.isArray(value) || value.length > L.windows) return invalid("maintenanceWindows", `must be a list of at most ${L.windows} windows`);
  return value.map((raw, i) => {
    const at = `maintenanceWindows[${i}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid(at, "must be an object");
    const w = raw as Record<string, unknown>;
    for (const k of Object.keys(w)) if (!["days", "start", "end"].includes(k)) invalid(`${at}.${k}`, "is not a field here");
    if (!Array.isArray(w["days"]) || w["days"].length === 0 || w["days"].length > 7 || w["days"].some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) invalid(`${at}.days`, "must be a list of weekdays, 0 (Sunday) to 6");
    const start = typeof w["start"] === "string" && TIME.test(w["start"]) ? w["start"] : invalid(`${at}.start`, "must be a UTC time HH:MM");
    const end = typeof w["end"] === "string" && TIME.test(w["end"]) ? w["end"] : invalid(`${at}.end`, "must be a UTC time HH:MM");
    if (start >= end) invalid(`${at}.end`, "must be later than start (a window across midnight is two windows)");
    return { days: [...new Set(w["days"] as number[])].sort(), start, end };
  });
}

function parseEscalation(value: unknown): Escalation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("escalation", "must be an object");
  const e = value as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!["to", "afterMinutes", "note"].includes(k)) invalid(`escalation.${k}`, "is not a field here");
  return {
    to: text(e["to"], "escalation.to", { min: 1, max: 120 }),
    ...(e["afterMinutes"] === undefined ? {} : { afterMinutes: minutes(e["afterMinutes"], "escalation.afterMinutes") }),
    ...(e["note"] === undefined ? {} : { note: noCredential(text(e["note"], "escalation.note", { min: 1, max: L.note }), "escalation.note") }),
  };
}

type Patch = { title?: string; objective?: string; desiredCondition?: string; ownerId?: string | null; managed?: string[]; everyMinutes?: number | null; eventSources?: string[]; permittedActions?: string[]; maintenanceWindows?: MaintenanceWindow[]; escalation?: Escalation | null };

function parsePatch(source: Record<string, unknown>): Patch {
  const p: Patch = {};
  if (source["title"] !== undefined) p.title = text(source["title"], "title", { min: 1, max: L.name });
  if (source["objective"] !== undefined) p.objective = noCredential(text(source["objective"], "objective", { min: 1, max: L.responsibilityText, multiline: true }), "objective");
  if (source["desiredCondition"] !== undefined) p.desiredCondition = noCredential(text(source["desiredCondition"], "desiredCondition", { min: 0, max: L.responsibilityText, multiline: true }), "desiredCondition");
  if (source["ownerId"] !== undefined) p.ownerId = source["ownerId"] === null ? null : text(source["ownerId"], "ownerId", { min: 1, max: 120 });
  if (source["managed"] !== undefined) {
    if (!Array.isArray(source["managed"]) || source["managed"].length > L.managed) invalid("managed", `must be a list of at most ${L.managed} resource IDs`);
    p.managed = [...new Set((source["managed"] as unknown[]).map((x, i) => resourceIdOf(x, `managed[${i}]`)))];
  }
  if (source["everyMinutes"] !== undefined) p.everyMinutes = source["everyMinutes"] === null ? null : minutes(source["everyMinutes"], "everyMinutes");
  if (source["eventSources"] !== undefined) p.eventSources = strings(source["eventSources"], "eventSources", L.eventSources, L.eventSource);
  if (source["permittedActions"] !== undefined) {
    p.permittedActions = strings(source["permittedActions"], "permittedActions", L.permittedActions, 60);
    for (const [i, a] of p.permittedActions.entries()) if (!ACTION.test(a)) invalid(`permittedActions[${i}]`, "must be an action name such as task.create or a prefix such as task.*");
  }
  if (source["maintenanceWindows"] !== undefined) p.maintenanceWindows = parseWindows(source["maintenanceWindows"]);
  if (source["escalation"] !== undefined) p.escalation = source["escalation"] === null ? null : parseEscalation(source["escalation"]);
  return p;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Ongoing responsibility records and their history (card P01).
 *
 * - **A record, not a conversation.** A responsibility persists after any one check, update or incident. Each of those is a bounded entry (`record`) in an append-only history, optionally linked
 *   to the bounded task it produced; nothing here starts a model conversation, runs a check or acts on a resource. Schedules and windows are data: `status` reads the clock and says whether a
 *   check is overdue, and writes nothing.
 * - **One holder per resource.** A resource a responsibility manages carries a claim (ID = the resource's); a second responsibility cannot take it while it is held, however the two commands
 *   race, and a claim is released when the resource is dropped from `managed` or the responsibility retires. A resource that is managed cannot be unbound.
 * - **Authority.** `responsibility.write` for the record; naming the answerable agent or the managed resources (who answers for what) also needs `responsibility.assign`. The owner agent
 *   named must be an active agent. Only the owner agent, the installation owner or a holder of `responsibility.write` may add history. `permittedActions` narrow and never grant.
 * - **Lifecycle.** active and paused switch freely; retired is final and releases the claims.
 */
export class ResponsibilityService {
  readonly #runner: CommandRunner;
  readonly #scanLimit: number;

  private constructor(runner: CommandRunner, scanLimit: number) { this.#runner = runner; this.#scanLimit = scanLimit; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { scanLimit?: number } = {}): ResponsibilityService {
    return new ResponsibilityService(new CommandRunner(storage, epoch, options), options.scanLimit ?? L.scan);
  }

  // ---- commands ---------------------------------------------------------------------------------------------------------------

  async create(by: Principal, command: NoActor & { projectId: string } & Patch): Promise<CommandResult> {
    return this.#runner.command("responsibility.create", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async (meta) => {
      onlyKnown(command, ["commandId", "projectId", ...FIELDS]);
      const projectId = checkProjectId(command.projectId);
      const patch = parsePatch(command as unknown as Record<string, unknown>);
      if (patch.title === undefined || patch.objective === undefined) invalid("title", "a responsibility needs a title and an objective");
      if (patch.ownerId === null || patch.everyMinutes === null || patch.escalation === null) invalid("fields", "null clears a field of an existing responsibility; there is nothing to clear yet");
      return {
        payload: { projectId, patch: JSON.parse(JSON.stringify(patch)) as JsonObject },
        build: async () => {
          const project = await this.#runner.get("project", projectId);
          if (project === undefined || !may(by, "responsibility.write", projectId)) throw hidden(by, "create responsibilities in that project");
          if ((project.body as unknown as ProjectBody).state === "archived") invalid("projectId", `project ${projectId} is archived`);
          if ((patch.ownerId !== undefined || (patch.managed?.length ?? 0) > 0) && !may(by, "responsibility.assign", projectId)) throw hidden(by, "assign responsibilities");
          await this.#checkPeople(patch);
          const id = derivedId("rsp", meta.commandId);
          const ref: AggregateRef = { kind: RESPONSIBILITY, id };
          const body: ResponsibilityBody = {
            projectId, title: patch.title!, objective: patch.objective!, desiredCondition: patch.desiredCondition ?? "",
            ...(patch.ownerId === undefined || patch.ownerId === null ? {} : { ownerId: patch.ownerId }), managed: patch.managed ?? [],
            ...(patch.everyMinutes === undefined || patch.everyMinutes === null ? {} : { everyMinutes: patch.everyMinutes }),
            eventSources: patch.eventSources ?? [], permittedActions: patch.permittedActions ?? [], maintenanceWindows: patch.maintenanceWindows ?? [],
            ...(patch.escalation === undefined || patch.escalation === null ? {} : { escalation: patch.escalation }), state: "active", createdBy: by.id,
          };
          const claims = await this.#claimChanges(id, projectId, body.managed, []);
          return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }, ...claims.changes], detail: { projectId, title: body.title }, contention: claims.contention };
        },
      };
    });
  }

  async update(by: Principal, command: NoActor & { responsibilityId: string; expectedRevision: number; state?: ResponsibilityState } & Patch): Promise<CommandResult> {
    return this.#runner.command("responsibility.update", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "responsibilityId", "expectedRevision", "state", ...FIELDS]);
      const id = responsibilityIdOf(command.responsibilityId);
      const expected = checkRevision(command.expectedRevision);
      const patch = parsePatch(command as unknown as Record<string, unknown>);
      const state = command.state === undefined ? undefined : (RESPONSIBILITY_STATES as readonly unknown[]).includes(command.state) ? command.state : invalid("state", `must be one of ${RESPONSIBILITY_STATES.join(", ")}`);
      if (Object.keys(patch).length === 0 && state === undefined) invalid("fields", "name at least one field to change");
      return {
        payload: { responsibilityId: id, expectedRevision: expected, ...(state === undefined ? {} : { state }), patch: JSON.parse(JSON.stringify(patch)) as JsonObject },
        build: async () => {
          const found = await this.#runner.get(RESPONSIBILITY, id);
          const body = found?.body as unknown as ResponsibilityBody | undefined;
          if (found === undefined || body === undefined || !may(by, "responsibility.write", body.projectId)) throw hidden(by, "change that responsibility");
          if (found.revision !== expected) throw new DomainError("stale_revision", `responsibility ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
          if (body.state === "retired") invalid("responsibilityId", `responsibility ${id} is retired and final`);
          const changesWho = (patch.ownerId !== undefined && (patch.ownerId ?? undefined) !== body.ownerId) || (patch.managed !== undefined && !sameSet(patch.managed, body.managed));
          if (changesWho && !may(by, "responsibility.assign", body.projectId)) throw hidden(by, "assign responsibilities");
          await this.#checkPeople(patch);
          const { ownerId: _o, everyMinutes: _e, escalation: _x, ...rest } = body;
          const managed = state === "retired" ? [] : patch.managed ?? body.managed;
          const ownerId = patch.ownerId === undefined ? body.ownerId : patch.ownerId ?? undefined;
          const everyMinutes = patch.everyMinutes === undefined ? body.everyMinutes : patch.everyMinutes ?? undefined;
          const escalation = patch.escalation === undefined ? body.escalation : patch.escalation ?? undefined;
          const next: ResponsibilityBody = {
            ...rest,
            title: patch.title ?? body.title, objective: patch.objective ?? body.objective, desiredCondition: patch.desiredCondition ?? body.desiredCondition,
            managed, eventSources: patch.eventSources ?? body.eventSources, permittedActions: patch.permittedActions ?? body.permittedActions,
            maintenanceWindows: patch.maintenanceWindows ?? body.maintenanceWindows, state: state ?? body.state,
            ...(ownerId === undefined ? {} : { ownerId }), ...(everyMinutes === undefined ? {} : { everyMinutes }), ...(escalation === undefined ? {} : { escalation }),
          };
          const ref: AggregateRef = { kind: RESPONSIBILITY, id };
          const claims = await this.#claimChanges(id, body.projectId, managed, body.managed);
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: expected, body: next as unknown as JsonObject }, ...claims.changes], detail: { projectId: body.projectId, ...(state === undefined ? {} : { state }) }, contention: claims.contention };
        },
      };
    });
  }

  /**
   * Adds an entry to the history: a check, an intervention, an incident or a note, with its outcome and the bounded task it produced, if any. Refused for a retired responsibility.
   * Sequence numbers are gap-free; two writers racing get one entry each or a retry-able `stale_revision`.
   */
  async record(by: Principal, command: NoActor & { responsibilityId: string; kind: ObservationKind; summary: string; outcome?: (typeof OUTCOMES)[number]; taskId?: string }): Promise<CommandResult> {
    return this.#runner.command("responsibility.record", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "responsibilityId", "kind", "summary", "outcome", "taskId"]);
      const id = responsibilityIdOf(command.responsibilityId);
      const kind = (OBSERVATION_KINDS as readonly unknown[]).includes(command.kind) ? command.kind : invalid("kind", `must be one of ${OBSERVATION_KINDS.join(", ")}`);
      const summary = noCredential(text(command.summary, "summary", { min: 1, max: L.summary, multiline: true }), "summary");
      const outcome = command.outcome === undefined ? undefined : (OUTCOMES as readonly unknown[]).includes(command.outcome) ? command.outcome : invalid("outcome", `must be one of ${OUTCOMES.join(", ")}`);
      const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
      return {
        payload: { responsibilityId: id, kind, summary, ...(outcome === undefined ? {} : { outcome }), ...(taskId === undefined ? {} : { taskId }) },
        build: async (): Promise<Built> => {
          const found = await this.#runner.get(RESPONSIBILITY, id);
          const body = found?.body as unknown as ResponsibilityBody | undefined;
          if (found === undefined || body === undefined || !this.#mayRecord(by, body)) throw hidden(by, "record on that responsibility");
          if (body.state === "retired") invalid("responsibilityId", `responsibility ${id} is retired`);
          if (taskId !== undefined) {
            const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
            // A task the caller may not read answers like one that does not exist.
            if (task === undefined || task.projectId !== body.projectId || !may(by, "task.read", task.projectId, { kind: "task", id: taskId })) invalid("taskId", "must be a task of the responsibility's project");
          }
          const log = await this.#runner.get(LOG, id);
          const before = log?.body as unknown as LogBody | undefined;
          const seq = (before?.n ?? 0) + 1;
          const at = this.#runner.now();
          const entry: ObservationBody = { responsibilityId: id, projectId: body.projectId, seq, kind, summary, ...(outcome === undefined ? {} : { outcome }), ...(taskId === undefined ? {} : { taskId }), at, by: by.id };
          const nextLog: LogBody = { n: seq, ...(kind === "check" ? { lastCheckAt: at, ...(outcome === undefined ? {} : { lastCheckOutcome: outcome }) } : before?.lastCheckAt === undefined ? {} : { lastCheckAt: before.lastCheckAt, ...(before.lastCheckOutcome === undefined ? {} : { lastCheckOutcome: before.lastCheckOutcome }) }) };
          const ref: AggregateRef = { kind: EVENT, id: `${id}.${seq}` };
          const logRef: AggregateRef = { kind: LOG, id };
          const changes: Change[] = [
            { type: "create", ref, body: entry as unknown as JsonObject },
            log === undefined ? { type: "create", ref: logRef, body: nextLog as unknown as JsonObject } : { type: "update", ref: logRef, expectedRevision: log.revision, body: nextLog as unknown as JsonObject },
            { type: "check", ref: { kind: RESPONSIBILITY, id }, expectedRevision: found.revision },
          ];
          return { ref, creates: true, changes, detail: { responsibilityId: id, seq, kind }, contention: async () => new DomainError("stale_revision", `the history of ${id} changed meanwhile; try again`) };
        },
      };
    });
  }

  // ---- reads ------------------------------------------------------------------------------------------------------------------

  /** One responsibility, or `undefined` when missing or unreadable (the same). */
  async get(by: Principal, responsibilityId: string): Promise<View<ResponsibilityBody> | undefined> {
    const found = await this.#runner.get(RESPONSIBILITY, responsibilityIdOf(responsibilityId));
    if (found === undefined || !may(by, "responsibility.read", (found.body as unknown as ResponsibilityBody).projectId)) return undefined;
    return view<ResponsibilityBody>(found);
  }

  /** A project's responsibilities in ID order (never truncated: too many is `unavailable`). `undefined` for a project the caller may not read. */
  async list(by: Principal, projectId: string, filter: { state?: ResponsibilityState } = {}): Promise<View<ResponsibilityBody>[] | undefined> {
    const id = checkProjectId(projectId);
    if (!may(by, "responsibility.read", id) || (await this.#runner.get("project", id)) === undefined) return undefined;
    return (await scanAll(this.#runner, RESPONSIBILITY, this.#scanLimit, (a) => { const b = a.body as unknown as ResponsibilityBody; return b.projectId === id && (filter.state === undefined || b.state === filter.state); })).map((a) => view<ResponsibilityBody>(a));
  }

  /** History entries after `afterSeq` (0 for the start), oldest first, at most `limit` (1 to 100). `next` is the last sequence number when more may follow. */
  async history(by: Principal, responsibilityId: string, page: { afterSeq?: number; limit: number }): Promise<{ items: View<ObservationBody>[]; next?: number } | undefined> {
    const id = responsibilityIdOf(responsibilityId);
    const found = await this.#runner.get(RESPONSIBILITY, id);
    if (found === undefined || !may(by, "responsibility.read", (found.body as unknown as ResponsibilityBody).projectId)) return undefined;
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) invalid("limit", "must be a whole number from 1 to 100");
    const after = page.afterSeq ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) invalid("after", "must be 0 or a sequence number");
    const n = ((await this.#runner.get(LOG, id))?.body as unknown as LogBody | undefined)?.n ?? 0;
    const items: View<ObservationBody>[] = [];
    let seq = after;
    while (seq < n && items.length < page.limit) {
      seq += 1;
      const entry = await this.#runner.get(EVENT, `${id}.${seq}`);
      if (entry !== undefined) items.push(view<ObservationBody>(entry));
    }
    return { items, ...(seq < n ? { next: seq } : {}) };
  }

  /** Where the responsibility stands against its schedule now. A pure read: an overdue check starts nothing. */
  async status(by: Principal, responsibilityId: string): Promise<ResponsibilityStatus | undefined> {
    const id = responsibilityIdOf(responsibilityId);
    const found = await this.#runner.get(RESPONSIBILITY, id);
    if (found === undefined || !may(by, "responsibility.read", (found.body as unknown as ResponsibilityBody).projectId)) return undefined;
    const body = found.body as unknown as ResponsibilityBody;
    const log = (await this.#runner.get(LOG, id))?.body as unknown as LogBody | undefined;
    const asOf = this.#runner.now();
    const now = Date.parse(asOf);
    const since = log?.lastCheckAt ?? found.createdAt;
    const due = body.everyMinutes === undefined ? undefined : new Date(Date.parse(since) + body.everyMinutes * 60_000).toISOString();
    const d = new Date(now);
    const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    return {
      responsibilityId: id, state: body.state, asOf, events: log?.n ?? 0,
      ...(log?.lastCheckAt === undefined ? {} : { lastCheckAt: log.lastCheckAt }), ...(log?.lastCheckOutcome === undefined ? {} : { lastCheckOutcome: log.lastCheckOutcome }),
      ...(due === undefined ? {} : { nextCheckDue: due }),
      checkOverdue: body.state === "active" && due !== undefined && Date.parse(due) < now,
      inMaintenanceWindow: body.maintenanceWindows.some((w) => w.days.includes(d.getUTCDay()) && w.start <= hhmm && hhmm < w.end),
    };
  }

  // ---- plumbing ---------------------------------------------------------------------------------------------------------------

  #mayRecord(by: Principal, body: ResponsibilityBody): boolean {
    return by.kind === "owner" || (body.ownerId !== undefined && by.id === body.ownerId && may(by, "responsibility.read", body.projectId)) || may(by, "responsibility.write", body.projectId);
  }

  /** The owner agent and the escalation target must be active agents (escalating to `owner` is always possible). */
  async #checkPeople(patch: Patch): Promise<void> {
    const agent = async (id: string, field: string): Promise<void> => {
      const who = (await this.#runner.get("principal", id))?.body as unknown as PrincipalBody | undefined;
      if (who === undefined || who.kind !== "agent" || who.state !== "active") invalid(field, "must be an active agent");
    };
    if (typeof patch.ownerId === "string") await agent(patch.ownerId, "ownerId");
    if (patch.escalation !== undefined && patch.escalation !== null && patch.escalation.to !== "owner") await agent(patch.escalation.to, "escalation.to");
  }

  /**
   * The claim records that move a responsibility from managing `before` to managing `after`: take each new resource (it must be a bound resource of the project and not held by another
   * responsibility; each is guarded at the revision seen, so an unbind or a rival claim racing it fails one of the two) and release each dropped one.
   */
  async #claimChanges(responsibilityId: string, projectId: string, after: readonly string[], before: readonly string[]): Promise<{ changes: Change[]; contention: () => Promise<DomainError> }> {
    const changes: Change[] = [];
    const wanted: string[] = [];
    for (const resourceId of after.filter((r) => !before.includes(r))) {
      const resource = await this.#runner.get(RESOURCE, resourceId);
      const rb = resource?.body as unknown as ResourceBody | undefined;
      if (resource === undefined || rb === undefined || rb.projectId !== projectId || rb.state !== "bound") invalid("managed", `${resourceId} is not a bound resource of this project`);
      const claim = await this.#runner.get(CLAIM, resourceId);
      const cb = claim?.body as unknown as ClaimBody | undefined;
      if (cb !== undefined && cb.state === "held" && cb.responsibilityId !== responsibilityId) invalid("managed", `${resourceId} is already managed by responsibility ${cb.responsibilityId}`);
      const held: ClaimBody = { resourceId, projectId, responsibilityId, state: "held" };
      changes.push({ type: "check", ref: { kind: RESOURCE, id: resourceId }, expectedRevision: resource!.revision });
      changes.push(claim === undefined ? { type: "create", ref: { kind: CLAIM, id: resourceId }, body: held as unknown as JsonObject } : { type: "update", ref: { kind: CLAIM, id: resourceId }, expectedRevision: claim.revision, body: held as unknown as JsonObject });
      wanted.push(resourceId);
    }
    for (const resourceId of before.filter((r) => !after.includes(r))) {
      const claim = await this.#runner.get(CLAIM, resourceId);
      const cb = claim?.body as unknown as ClaimBody | undefined;
      if (claim !== undefined && cb !== undefined && cb.state === "held" && cb.responsibilityId === responsibilityId) changes.push({ type: "update", ref: { kind: CLAIM, id: resourceId }, expectedRevision: claim.revision, body: { ...cb, state: "released" } as unknown as JsonObject });
    }
    // A lost race over a claim means someone else took the resource (or unbound it) between the read and the write.
    const contention = async (): Promise<DomainError> => {
      for (const resourceId of wanted) {
        const now = (await this.#runner.get(CLAIM, resourceId))?.body as unknown as ClaimBody | undefined;
        if (now !== undefined && now.state === "held" && now.responsibilityId !== responsibilityId) return new DomainError("invalid_command", `managed: ${resourceId} is already managed by responsibility ${now.responsibilityId}`, { field: "managed" });
      }
      return new DomainError("stale_revision", "the responsibility or the resources it names changed meanwhile; read them again and retry");
    };
    return { changes, contention };
  }
}

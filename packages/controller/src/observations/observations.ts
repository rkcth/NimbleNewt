import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { canRead as deskCanRead, type DeskRecordBody } from "../context/desks.js";
import type { ArtifactBody } from "../artifacts/service.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { clean, cut, invalid, optionalPlain, plain, whole } from "../standups/shared.js";

/**
 * Observations (card B02, first slice): what the controller saw go wrong or get put right in a project's work (a correction, a failure, a recovery, friction, an approval that stalled, a prompt that was
 * asked again, a review that failed), and the friction agents report themselves. They are the raw material of lessons (B03): nothing here changes work, grants anything or creates a task.
 *
 * - **Provenance, not wording, decides what is the same.** Each observation names the records it comes from (`sources`). Records that ARE an event (a submission, a review request, another observation)
 *   are its provenance: a second report of the same event, by the controller or by any agent, in any words and of any kind, joins the first observation (`reports` goes up, the reporter is listed) and is
 *   never a second observation. Citing an observation is a retelling of it. A report that cites only context (a task, an artifact, a desk record) has no shared event, so it is the same only when the same
 *   reporter tells the same words about the same records again. The record's ID is derived from that key, so two controllers telling the same event at once still make one record.
 * - **Scope.** Every source must belong to the observation's project; an agent may only cite records it can read now. Reads are for the owner and holders of `meeting.read` or `meeting.manage` in the
 *   project, and for the agents who reported it (they see themselves as the only reporter). Anyone else gets what a missing record gives.
 * - **Storm limits.** Per project and clock hour (UTC) at most `perProjectPerHour` new observations, and per agent at most `perReporterPerHour` reports (new or joined). The open list holds at most `open`.
 *   An agent over a limit is refused; the controller is never refused (a source event must not fail because of this) but its observation is not made: it is counted as `suppressed` on the project's
 *   rate record, which the status view shows. A retelling of an existing observation by the controller always counts.
 * - **Disposition.** `open` -> `promoted` (to an improvement proposal), `dismissed` or `resolved` (each with a reason), and back to `open`. Managers of the project's meetings and the owner decide. The
 *   agent who reported friction owns it until a manager names someone else.
 */
export const OBSERVATION_KINDS = ["correction", "failure", "recovery", "friction", "approval-stall", "redundant-prompt", "failed-review"] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];
export type ObservationDisposition = "open" | "promoted" | "dismissed" | "resolved";
const DISPOSITIONS: readonly ObservationDisposition[] = ["open", "promoted", "dismissed", "resolved"];

/** Records an observation may name. The first three are context; the last three are events, and decide what counts as the same observation. */
export const SOURCE_KINDS = ["task", "artifact", "desk-record", "submission", "review", "observation"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
const EVENT_KINDS: readonly SourceKind[] = ["submission", "review", "observation"];
const ID_PREFIX: Readonly<Record<SourceKind, string>> = { task: "task", artifact: "art", "desk-record": "dsk", submission: "sbm", review: "rev", observation: "obs" };
export interface SourceRef { readonly kind: SourceKind; readonly id: string }

export interface ObservationBody {
  readonly projectId: string;
  readonly kind: ObservationKind;
  /** Who first told it: the controller (a host or service principal, or the owner) or an agent. */
  readonly origin: "controller" | "agent";
  /** One line, from typed records when the controller made it, in the agent's own words when an agent did. */
  readonly summary: string;
  readonly detail?: string;
  readonly sources: readonly SourceRef[];
  /** The task it is about, when there is one (from the sources). */
  readonly taskId?: string;
  /** The digest of what made it this observation (see the class comment). */
  readonly provenance: string;
  readonly reportedBy: string;
  /** Distinct reporters, the first `reporters` of them. */
  readonly reporters: readonly string[];
  /** Every report that joined it, the first included. It is still ONE observation. */
  readonly reports: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** Who follows it up (an agent's own friction: that agent; set by a manager otherwise). */
  readonly owner?: string;
  readonly disposition: ObservationDisposition;
  readonly reason?: string;
  readonly improvementId?: string;
  readonly history: readonly { readonly at: string; readonly by: string; readonly to: ObservationDisposition }[];
}

/** Per project, the current clock hour (UTC) of new observations and agent reports, and what the controller could not record. */
export interface ObservationRateBody {
  readonly hour: string;
  readonly created: number;
  readonly byReporter: readonly { readonly id: string; readonly n: number }[];
  /** This hour: controller observations not made because a limit was reached. */
  readonly suppressed: number;
  readonly suppressedTotal: number;
  readonly lastSuppressed?: { readonly at: string; readonly kind: ObservationKind; readonly why: "rate" | "open-list" };
}

export const OBSERVATION_LIMITS = {
  summary: 300, detail: 2000, reason: 500, sources: 10, reporters: 20, history: 10, page: 100, retries: 8,
  perProjectPerHour: 60, perReporterPerHour: 10, open: 500, rateReporters: 200,
} as const;

export interface ObservationOptions extends RunnerOptions {
  /** Smaller limits for tests (never larger than the defaults' meaning: each must be a whole number of at least 1). */
  readonly limits?: { readonly perProjectPerHour?: number; readonly perReporterPerHour?: number; readonly open?: number };
}

export type RecordOutcome = { readonly outcome: "created" | "joined"; readonly id: string; readonly replayed: boolean } | { readonly outcome: "suppressed"; readonly replayed: boolean };

const OBSERVATION_ID = /^obs-[a-z2-7]{20}$/;
const SOURCE_ID = /^[a-z]{3,4}-[a-z2-7]{20}$/;
const AGENT = /^agent:[a-z0-9][a-z0-9-]{0,39}$/;
interface IndexBody { readonly ids: readonly string[] }
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export class ObservationService {
  readonly #runner: CommandRunner;
  readonly #limits: { perProjectPerHour: number; perReporterPerHour: number; open: number };

  private constructor(runner: CommandRunner, options: ObservationOptions) {
    this.#runner = runner;
    const l = options.limits ?? {};
    const pick = (v: number | undefined, d: number, f: string): number => (v === undefined ? d : Number.isSafeInteger(v) && v >= 1 ? v : invalid(f, "must be a whole number of at least 1"));
    this.#limits = { perProjectPerHour: pick(l.perProjectPerHour, OBSERVATION_LIMITS.perProjectPerHour, "perProjectPerHour"), perReporterPerHour: pick(l.perReporterPerHour, OBSERVATION_LIMITS.perReporterPerHour, "perReporterPerHour"), open: pick(l.open, OBSERVATION_LIMITS.open, "open") };
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: ObservationOptions = {}): ObservationService {
    return new ObservationService(new CommandRunner(storage, epoch, options), options);
  }

  /**
   * The controller records what it saw (owner, host or service; never a task credential). The project is the sources' (all must be of one project); the summary and detail are made safe (credential-shaped
   * text is replaced, whitespace folded, length cut) rather than refused, because they come from the controller's own records. Never refused for a storm: see the class comment.
   */
  async record(by: Principal, command: NoActor & { kind: ObservationKind; summary: string; detail?: string; sources: readonly SourceRef[] }): Promise<RecordOutcome> {
    if ((by.kind !== "owner" && by.kind !== "host" && by.kind !== "service") || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not record controller observations`);
    onlyKnown(command, ["commandId", "kind", "summary", "detail", "sources"]);
    const kind = (typeof command.kind === "string" && (OBSERVATION_KINDS as readonly string[]).includes(command.kind) ? command.kind : invalid("kind", `must be one of ${OBSERVATION_KINDS.join(", ")}`)) as ObservationKind;
    if (typeof command.summary !== "string" || command.summary.trim() === "") invalid("summary", "is required");
    const summary = cut(command.summary, OBSERVATION_LIMITS.summary);
    const detail = command.detail === undefined ? undefined : (typeof command.detail === "string" ? cut(command.detail, OBSERVATION_LIMITS.detail) : invalid("detail", "must be text"));
    const sources = this.#refs(command.sources, 1);
    const resolved = await this.#resolve(sources, undefined);
    return this.#tell(by, "controller", command.commandId, { projectId: resolved.projectId, kind, summary, ...(detail === undefined || detail === "" ? {} : { detail }), sources, ...(resolved.taskId === undefined ? {} : { taskId: resolved.taskId }) }, resolved.joins);
  }

  /**
   * An agent reports friction it met (needs `meeting.agenda` or `meeting.manage` in the project, or the owner): in its own words (credential-shaped text is refused), citing up to ten records of this
   * project it can read now. Citing an observation, or the same event another report cites, joins that observation. Over a storm limit it is refused with `unavailable`.
   */
  async submit(by: Principal, command: NoActor & { projectId: string; summary: string; detail?: string; sources?: readonly SourceRef[] }): Promise<RecordOutcome> {
    onlyKnown(command, ["commandId", "projectId", "summary", "detail", "sources"]);
    const projectId = checkProjectId(command.projectId);
    if (!inTaskScope(by, projectId) || !(allows(by, "meeting.agenda", projectId) || allows(by, "meeting.manage", projectId)) || (await this.#runner.get("project", projectId)) === undefined) throw new DomainError("forbidden", `${by.id} may not report friction in that project`);
    const summary = plain(command.summary, "summary", OBSERVATION_LIMITS.summary);
    const detail = optionalPlain(command.detail, "detail", OBSERVATION_LIMITS.detail);
    const sources = this.#refs(command.sources ?? [], 0);
    const resolved = sources.length === 0 ? { projectId, joins: undefined, taskId: undefined } : await this.#resolve(sources, by);
    if (resolved.projectId !== projectId) invalid("sources", "must be records of this project that you may read");
    return this.#tell(by, "agent", command.commandId, { projectId, kind: "friction", summary, ...(detail === undefined ? {} : { detail }), sources, ...(resolved.taskId === undefined ? {} : { taskId: resolved.taskId }) }, resolved.joins);
  }

  /**
   * Settles an observation (managers of the project's meetings, or the owner): `promoted` names the improvement proposal of this project it became; `dismissed` and `resolved` say why; `open` takes it up
   * again. A new owner may be named with it.
   */
  async dispose(by: Principal, command: NoActor & { observationId: string; expectedRevision: number; to: ObservationDisposition; reason?: string; improvementId?: string; owner?: string }): Promise<{ revision: number }> {
    onlyKnown(command, ["commandId", "observationId", "expectedRevision", "to", "reason", "improvementId", "owner"]);
    const id = this.#id(command.observationId, "observationId");
    const expected = checkRevision(command.expectedRevision);
    const to = (typeof command.to === "string" && (DISPOSITIONS as readonly string[]).includes(command.to) ? command.to : invalid("to", "must be open, promoted, dismissed or resolved")) as ObservationDisposition;
    const reason = to === "dismissed" || to === "resolved" ? plain(command.reason, "reason", OBSERVATION_LIMITS.reason) : (command.reason === undefined ? undefined : invalid("reason", "only a dismissal or a resolution carries a reason"));
    const improvementId = to === "promoted" ? (typeof command.improvementId === "string" && /^imp-[a-z2-7]{20}$/.test(command.improvementId) ? command.improvementId : invalid("improvementId", "a promotion names the improvement proposal it became")) : (command.improvementId === undefined ? undefined : invalid("improvementId", "only a promotion names an improvement proposal"));
    const owner = command.owner === undefined ? undefined : (typeof command.owner === "string" && (AGENT.test(command.owner) || command.owner === "owner") ? command.owner : invalid("owner", "must be an agent principal or owner"));
    const result = await this.#retrying(() => this.#runner.command("observation.dispose", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: clean({ observationId: id, expectedRevision: expected, to, reason, improvementId, owner }),
      build: async () => {
        const found = await this.#runner.get("observation", id);
        const body = found?.body as unknown as ObservationBody | undefined;
        if (found === undefined || body === undefined || !this.#mayManage(by, body.projectId)) throw new DomainError("forbidden", `${by.id} may not settle that observation`);
        if (found.revision !== expected) throw new DomainError("stale_revision", `observation ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
        if (body.disposition === to && to === "open") throw new DomainError("invalid_command", `observation ${id} is already open`, { field: "to" });
        if (improvementId !== undefined && ((await this.#runner.get("improvement-item", improvementId))?.body as unknown as { projectId?: string } | undefined)?.projectId !== body.projectId) invalid("improvementId", "must be an improvement proposal of this project");
        const nowIso = this.#runner.now();
        const { reason: _r, improvementId: _i, ...rest } = body;
        void _r; void _i;
        const next: ObservationBody = { ...rest, disposition: to, ...(reason === undefined ? {} : { reason }), ...(improvementId === undefined ? {} : { improvementId }), ...(owner === undefined ? {} : { owner }), history: [...body.history, { at: nowIso, by: by.id, to }].slice(-OBSERVATION_LIMITS.history) };
        const ref: AggregateRef = { kind: "observation", id };
        const changes: Change[] = [{ type: "update", ref, expectedRevision: found.revision, body: clean(next) }];
        const index = await this.#index(body.projectId);
        if (to === "open" && !index.ids.includes(id)) {
          if (index.ids.length >= this.#limits.open) throw new DomainError("unavailable", `${this.#limits.open} observations are already open in this project; settle some first`);
          changes.push(this.#indexChange(body.projectId, index, [...index.ids, id]));
        } else if (to !== "open" && index.ids.includes(id)) changes.push(this.#indexChange(body.projectId, index, index.ids.filter((x) => x !== id)));
        return { ref, creates: false, changes, detail: { projectId: body.projectId, to } };
      },
    })));
    return { revision: result.revision };
  }

  /** One observation: the owner, a reader or manager of the project's meetings, or one of its reporters (who sees only itself as a reporter). Anyone else gets `undefined`, as for one that does not exist. */
  async get(viewer: Principal, observationId: string): Promise<View<ObservationBody> | undefined> {
    const found = typeof observationId === "string" && OBSERVATION_ID.test(observationId) ? await this.#runner.get("observation", observationId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as ObservationBody;
    if (this.#mayRead(viewer, body.projectId)) return view<ObservationBody>(found);
    if (body.reporters.includes(viewer.id) && inTaskScope(viewer, body.projectId)) {
      const own = view<ObservationBody>(found);
      return { ...own, reportedBy: own.reportedBy === viewer.id ? viewer.id : "another reporter", reporters: [viewer.id] };
    }
    return undefined;
  }

  /**
   * The open observations of a project, oldest first, a page at a time, with the hour's storm count (`rate`). Needs `meeting.read` or `meeting.manage` (or the owner). `kind` keeps one kind.
   */
  async open(viewer: Principal, projectId: string, page: { afterId?: string; limit?: number; kind?: string } = {}): Promise<{ items: View<ObservationBody>[]; next?: string; rate: { hour: string; created: number; suppressed: number; suppressedTotal: number; lastSuppressed?: ObservationRateBody["lastSuppressed"] } } | undefined> {
    const project = checkProjectId(projectId);
    if (!this.#mayRead(viewer, project)) return undefined;
    const limit = page.limit === undefined ? 20 : whole(page.limit, "limit", 1, OBSERVATION_LIMITS.page);
    const kind = page.kind === undefined ? undefined : ((OBSERVATION_KINDS as readonly string[]).includes(page.kind) ? page.kind : invalid("kind", `must be one of ${OBSERVATION_KINDS.join(", ")}`));
    const index = await this.#index(project);
    const start = page.afterId === undefined ? 0 : index.ids.indexOf(page.afterId) + 1;
    if (page.afterId !== undefined && start === 0) invalid("afterId", "is not in the list");
    const items: View<ObservationBody>[] = [];
    let pos = start;
    for (; pos < index.ids.length && items.length < limit; pos++) {
      const found = await this.#runner.get("observation", index.ids[pos]!);
      if (found !== undefined && (kind === undefined || (found.body as unknown as ObservationBody).kind === kind)) items.push(view<ObservationBody>(found));
    }
    const r = (await this.#runner.get("observation-rate", project))?.body as unknown as ObservationRateBody | undefined;
    const hour = this.#hour();
    const rate = r === undefined ? { hour, created: 0, suppressed: 0, suppressedTotal: 0 } : { hour, created: r.hour === hour ? r.created : 0, suppressed: r.hour === hour ? r.suppressed : 0, suppressedTotal: r.suppressedTotal, ...(r.lastSuppressed === undefined ? {} : { lastSuppressed: r.lastSuppressed }) };
    return { items, ...(pos < index.ids.length ? { next: index.ids[pos - 1]! } : {}), rate };
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  /** Creates the observation, or joins the one with the same provenance, under the storm limits, in one write with the index and the rate record. Retried on a lost race with the same command ID. */
  async #tell(by: Principal, origin: "controller" | "agent", commandId: unknown, fields: { projectId: string; kind: ObservationKind; summary: string; detail?: string; sources: readonly SourceRef[]; taskId?: string }, joins: string | undefined): Promise<RecordOutcome> {
    const scoped = scopedCommandId(by.id, commandId);
    const events = fields.sources.filter((s) => EVENT_KINDS.includes(s.kind) && s.kind !== "observation").map((s) => `${s.kind}:${s.id}`).sort();
    // Events are the same whoever tells them; context alone is the same only from the same reporter in the same words.
    const provenance = digest(events.length > 0 ? `event\0${fields.projectId}\0${events.join("\0")}` : `context\0${fields.projectId}\0${fields.kind}\0${by.id}\0${fields.sources.map((s) => `${s.kind}:${s.id}`).sort().join("\0")}\0${fields.summary.toLowerCase().replace(/\s+/g, " ").trim()}`);
    const id = joins ?? derivedId("obs", provenance);
    const result = await this.#retrying(() => this.#runner.command(origin === "agent" ? "observation.submit" : "observation.record", { commandId: scoped, actor: by.id }, async () => ({
      payload: clean({ ...fields, sources: fields.sources.map((s) => ({ kind: s.kind, id: s.id })), joins }),
      build: async () => {
        const nowIso = this.#runner.now();
        const hour = this.#hour();
        const rateFound = await this.#runner.get("observation-rate", fields.projectId);
        const prior = rateFound?.body as unknown as ObservationRateBody | undefined;
        const rate: ObservationRateBody = prior === undefined || prior.hour !== hour ? { hour, created: 0, byReporter: [], suppressed: 0, suppressedTotal: prior?.suppressedTotal ?? 0, ...(prior?.lastSuppressed === undefined ? {} : { lastSuppressed: prior.lastSuppressed }) } : prior;
        const rateRef: AggregateRef = { kind: "observation-rate", id: fields.projectId };
        const rateChange = (body: ObservationRateBody): Change => (rateFound === undefined ? { type: "create", ref: rateRef, body: body as unknown as JsonObject } : { type: "update", ref: rateRef, expectedRevision: rateFound.revision, body: body as unknown as JsonObject });
        const mine = rate.byReporter.find((x) => x.id === by.id)?.n ?? 0;
        const counted = (): ObservationRateBody["byReporter"] => (origin !== "agent" ? rate.byReporter : rate.byReporter.some((x) => x.id === by.id) ? rate.byReporter.map((x) => (x.id === by.id ? { id: x.id, n: x.n + 1 } : x)) : [...rate.byReporter, { id: by.id, n: 1 }]);
        if (origin === "agent" && (mine >= this.#limits.perReporterPerHour || (mine === 0 && rate.byReporter.length >= OBSERVATION_LIMITS.rateReporters))) {
          throw new DomainError("unavailable", `you have reported ${mine} observations in this project this hour, the most allowed; try again after ${hour.slice(11, 13)}:59 UTC`);
        }
        const ref: AggregateRef = { kind: "observation", id };
        const found = await this.#runner.get("observation", id);
        if (found !== undefined) {
          const body = found.body as unknown as ObservationBody;
          if (body.projectId !== fields.projectId) throw new DomainError("forbidden", `${by.id} may not report that`);
          const reporters = body.reporters.includes(by.id) || body.reporters.length >= OBSERVATION_LIMITS.reporters ? body.reporters : [...body.reporters, by.id];
          const changes: Change[] = [{ type: "update", ref, expectedRevision: found.revision, body: clean({ ...body, reporters, reports: body.reports + 1, lastSeenAt: nowIso }) }];
          if (origin === "agent") changes.push(rateChange({ ...rate, byReporter: counted() }));
          return { ref, creates: false, changes, detail: { projectId: fields.projectId, joined: true } };
        }
        if (joins !== undefined) throw new DomainError("not_found", "the observation cited does not exist");
        const index = await this.#index(fields.projectId);
        const why = rate.created >= this.#limits.perProjectPerHour ? "rate" : index.ids.length >= this.#limits.open ? "open-list" : undefined;
        if (why !== undefined) {
          if (origin === "agent") throw new DomainError("unavailable", why === "rate" ? `${rate.created} observations were made in this project this hour, the most allowed; try again after ${hour.slice(11, 13)}:59 UTC` : `${this.#limits.open} observations are already open in this project; a manager settles some first`);
          // The controller's event goes on; only the observation is not made, and that is counted where the owner sees it.
          return { ref: rateRef, creates: false, changes: [rateChange({ ...rate, suppressed: rate.suppressed + 1, suppressedTotal: rate.suppressedTotal + 1, lastSuppressed: { at: nowIso, kind: fields.kind, why } })], detail: { projectId: fields.projectId, suppressed: why } };
        }
        const body: ObservationBody = {
          ...fields, origin, provenance, reportedBy: by.id, reporters: [by.id], reports: 1, firstSeenAt: nowIso, lastSeenAt: nowIso, ...(origin === "agent" ? { owner: by.id } : {}), disposition: "open", history: [{ at: nowIso, by: by.id, to: "open" }],
        };
        return { ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }, this.#indexChange(fields.projectId, index, [...index.ids, id]), rateChange({ ...rate, created: rate.created + 1, byReporter: counted() })], detail: { projectId: fields.projectId } };
      },
    })));
    if (!result.id.startsWith("obs-")) return { outcome: "suppressed", replayed: result.replayed };
    return { outcome: result.revision === 1 ? "created" : "joined", id: result.id, replayed: result.replayed };
  }

  #refs(value: unknown, min: number): SourceRef[] {
    if (!Array.isArray(value) || value.length < min || value.length > OBSERVATION_LIMITS.sources) return invalid("sources", `must be a list of ${min} to ${OBSERVATION_LIMITS.sources} records`);
    const out: SourceRef[] = [];
    for (const [i, raw] of value.entries()) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid(`sources[${i}]`, "must be an object with kind and id");
      onlyKnown(raw, ["kind", "id"]);
      const s = raw as { kind?: unknown; id?: unknown };
      if (typeof s.kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(s.kind) || typeof s.id !== "string" || !SOURCE_ID.test(s.id) || !s.id.startsWith(`${ID_PREFIX[s.kind as SourceKind]}-`)) return invalid(`sources[${i}]`, `must be one of ${SOURCE_KINDS.join(", ")} with its ID`);
      if (!out.some((x) => x.kind === s.kind && x.id === s.id)) out.push({ kind: s.kind as SourceKind, id: s.id });
    }
    return out;
  }

  /**
   * The one project of the sources, the task they are about (the first named), and the observation a citation joins. With `reader`, each source must also be one that reader may read now; a source that is
   * missing, of another project or unreadable is refused the same way, so nothing is learnt about other projects.
   */
  async #resolve(sources: readonly SourceRef[], reader: Principal | undefined): Promise<{ projectId: string; taskId: string | undefined; joins: string | undefined }> {
    let projectId: string | undefined;
    let taskId: string | undefined;
    let joins: string | undefined;
    for (const [i, s] of sources.entries()) {
      const found = await this.#runner.get(s.kind, s.id);
      const b = found?.body as unknown as Record<string, unknown> | undefined;
      const binding = b?.["binding"] as { projectId?: unknown; taskId?: unknown } | undefined;
      const p = s.kind === "review" ? binding?.projectId : b?.["projectId"];
      const t = s.kind === "task" ? s.id : s.kind === "review" ? binding?.taskId : b?.["taskId"];
      let ok = found !== undefined && typeof p === "string" && (projectId === undefined || p === projectId);
      if (ok && reader !== undefined && reader.kind !== "owner") ok = await this.#readable(reader, s, p as string, b!, typeof t === "string" ? t : undefined);
      if (!ok) return invalid(`sources[${i}]`, reader === undefined ? "must be a record of the same project" : "must be a record of this project that you may read");
      projectId = p as string;
      if (taskId === undefined && typeof t === "string") taskId = t;
      if (s.kind === "observation" && joins === undefined) joins = s.id;
    }
    return { projectId: projectId!, taskId, joins };
  }

  async #readable(by: Principal, s: SourceRef, projectId: string, body: Record<string, unknown>, taskId: string | undefined): Promise<boolean> {
    if (!inTaskScope(by, projectId)) return false;
    const taskRead = (t: string | undefined): boolean => t !== undefined && allows(by, "task.read", projectId, { resource: { kind: "task", id: t } });
    switch (s.kind) {
      case "task": return taskRead(s.id);
      case "artifact": return allows(by, "artifact.read", projectId) || ((body as unknown as ArtifactBody).taskId !== undefined && allows(by, "artifact.read", projectId, { resource: { kind: "task", id: (body as unknown as ArtifactBody).taskId as string } }));
      case "desk-record": return deskCanRead(by, body as unknown as DeskRecordBody);
      case "submission": return body["submittedBy"] === by.id || taskRead(taskId);
      case "review": return (body["binding"] as { requester?: unknown } | undefined)?.requester === by.id || taskRead(taskId);
      case "observation": return this.#mayRead(by, projectId) || ((body["reporters"] as readonly string[] | undefined) ?? []).includes(by.id);
    }
  }

  #hour(): string { return `${this.#runner.now().slice(0, 13)}:00:00.000Z`; }
  #mayRead(viewer: Principal, projectId: string): boolean { return inTaskScope(viewer, projectId) && (allows(viewer, "meeting.read", projectId) || allows(viewer, "meeting.manage", projectId)); }
  #mayManage(by: Principal, projectId: string): boolean { return inTaskScope(by, projectId) && allows(by, "meeting.manage", projectId); }
  #id(value: unknown, field: string): string { return typeof value === "string" && OBSERVATION_ID.test(value) ? value : invalid(field, "is not an observation ID"); }

  async #index(projectId: string): Promise<{ ids: readonly string[]; revision: number }> {
    const found = await this.#runner.get("observation-index", projectId);
    return found === undefined ? { ids: [], revision: 0 } : { ids: (found.body as unknown as IndexBody).ids, revision: found.revision };
  }

  #indexChange(projectId: string, index: { revision: number }, ids: readonly string[]): Change {
    const ref: AggregateRef = { kind: "observation-index", id: projectId };
    const body = { ids: [...ids] } as unknown as JsonObject;
    return index.revision === 0 ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: index.revision, body };
  }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= OBSERVATION_LIMITS.retries) throw error;
      }
    }
  }
}


import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { clean, invalid, plain, whole } from "../standups/shared.js";

/**
 * Optional agent work on NimbleNewt's own code (card B06, first slice): the feature, an agent's request to work on it, the owner's decision, and the start gate.
 *
 * - **Off by default.** Nothing here does anything until the owner enables it and names the NimbleNewt development project (an existing, active project of this installation). While it is off a request is
 *   refused with a message saying the owner can enable it. The development project, once named, stays the development project (it cannot be pointed somewhere else, so tasks there are never left ungated).
 * - **Asked ahead.** An agent asks first, in its own words: what it wants to change, why, the expected effort and the expected cost. A request starts nothing and spends nothing.
 * - **Only the owner approves.** Approval creates the task in the development project (the separate project with its own checkout); a rejected request creates nothing. The owner may withdraw an approval at
 *   any time, and the requester (or the owner) may withdraw a request still waiting.
 * - **No work starts without an approved request.** `checkAttempt` is part of the attempt gate (`AssignmentService.admitAttempt`): an attempt on a task of the development project is refused while the feature
 *   is off, when the task came from no request, and when its request is not approved now (withdrawn, for example). Tasks of every other project are not affected.
 * - **Work already running is stopped** (second slice). `stopRefused`, run on every dispatcher tick, looks at the attempts running in the development project and asks L02's Stop of the task for each one
 *   whose start the gate would refuse now (the approval withdrawn, the feature switched off, the task's text changed, or no approved request). The Stop pauses the task, lets the calls in flight settle, takes a
 *   checkpoint and ends the attempt (`abandoned`, its records kept); its reason is the gate's own words. The task stays stopped until the owner resumes it.
 * - **Not here** (later slices): launch proposals and their explanation, review, revision binding and installation (the card's other clauses), chat wording for the owner's controls.
 */
export const OWNCODE_STATUSES = ["pending", "approved", "rejected", "withdrawn"] as const;
export type OwnCodeStatus = (typeof OWNCODE_STATUSES)[number];

export const OWNCODE_LIMITS = { text: 600, note: 400, title: 200, pendingPerAgent: 5, listed: 500, page: 100, history: 10, retries: 8 } as const;
/** How much one tick's stop look does (card B06, second slice): at most `look` live attempts are looked at (the rest on the next ticks, from where this one stopped), and at most `perTick` Stops are asked for. */
export const OWNCODE_STOP = { look: 100, perTick: 5 } as const;
/** What the stop look is given: an attempt that is running, with its task and project (the dispatcher's record). */
export interface OwnCodeRunning { readonly attemptId: string; readonly taskId: string; readonly projectId: string }
/** The part of L02's Stop (`StopService`) the stop look uses. */
export interface OwnCodeStops {
  holding(taskId: string): Promise<{ intentId: string; mode: string } | undefined>;
  request(by: Principal, command: { commandId: string; scope: { kind: "task"; id: string }; mode: "stop"; reason: string }): Promise<{ intentId: string; replayed: boolean }>;
  advance(by: Principal, command: { intentId: string }): Promise<unknown>;
}
/** The reason a Stop of running development work records (the pause and the Stop show it): the gate's own refusal. */
export const ownCodeStopReason = (why: string): string => `Stopped NimbleNewt development work: ${why}`.slice(0, 500);
const REQUEST_ID = /^ocr-[a-z2-7]{20}$/;
const SETTINGS: AggregateRef = { kind: "owncode-settings", id: "installation" };
const INDEX: AggregateRef = { kind: "owncode-index", id: "installation" };
/** What a refusal says while the feature is off: the owner can enable it. */
export const OWNCODE_OFF = "Work on NimbleNewt's own code is off in this installation. The owner can enable it (and name the NimbleNewt development project) if this work is wanted.";

export interface OwnCodeSettings {
  readonly enabled: boolean;
  /** The NimbleNewt development project, named by the owner the first time the feature is enabled; it never changes afterwards. */
  readonly projectId?: string;
  readonly history: readonly { readonly at: string; readonly by: string; readonly enabled: boolean }[];
}

export interface OwnCodeRequestText { readonly what: string; readonly why: string; readonly effort: string; readonly cost: string }
const REQUEST_FIELDS = ["what", "why", "effort", "cost"] as const;

export interface OwnCodeRequestBody {
  readonly requestedBy: string;
  readonly request: OwnCodeRequestText;
  readonly status: OwnCodeStatus;
  /** The development project the request was approved into, and the task the approval created there. */
  readonly projectId?: string;
  readonly taskId?: string;
  readonly decidedBy?: string;
  readonly note?: string;
  /** The status a withdrawal ended (`pending` or `approved`). */
  readonly withdrawnFrom?: "pending" | "approved";
  readonly history: readonly { readonly at: string; readonly by: string; readonly to: OwnCodeStatus; readonly cause?: string }[];
}

interface IndexBody { readonly ids: readonly string[]; readonly pending: Readonly<Record<string, readonly string[]>> }
interface TaskLink { readonly requestId: string }

export interface OwnCodeOptions extends RunnerOptions {
  /** Creates the approved task in the development project. Without it nothing is approved (fail closed). */
  readonly projects?: Pick<ProjectService, "createTask">;
}

/** The command ID of the task an approval creates: derived from the request, so a repeat of the approval finds the same task. */
const taskCommandOf = (requestId: string): string => `owncode-task:${requestId}`;
/** Thrown inside an approval's build when the request is already approved but its task was never created: nothing is written, and the task is created after the build (any command ID of the owner finishes it). */
const UNFINISHED: unique symbol = Symbol("owncode-unfinished-approval");
/** The task ID an approval of this request creates (ProjectService derives a task's ID from its command ID). */
export const taskIdOf = (requestId: string): string => derivedId("task", taskCommandOf(requestId));

export class OwnCodeService {
  readonly #runner: CommandRunner;
  readonly #projects: Pick<ProjectService, "createTask"> | undefined;
  /** Where the next stop look begins in the dispatcher's live list (card B06, second slice). */
  #stopFrom = 0;

  private constructor(runner: CommandRunner, projects: Pick<ProjectService, "createTask"> | undefined) { this.#runner = runner; this.#projects = projects; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: OwnCodeOptions = {}): OwnCodeService {
    const { projects, ...rest } = options;
    return new OwnCodeService(new CommandRunner(storage, epoch, rest), projects);
  }

  // ---- the feature -----------------------------------------------------------------------------------------------------------

  /** The feature's settings (the owner only; anyone else gets `undefined`). Never written: off, with no development project. */
  async settings(viewer: Principal): Promise<{ revision: number; enabled: boolean; projectId?: string; history: OwnCodeSettings["history"] } | undefined> {
    if (!this.#isOwner(viewer)) return undefined;
    const found = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
    if (found === undefined) return { revision: 0, enabled: false, history: [] };
    const b = found.body as unknown as OwnCodeSettings;
    return { revision: found.revision, enabled: b.enabled, ...(b.projectId === undefined ? {} : { projectId: b.projectId }), history: b.history };
  }

  /**
   * Enables the feature (the owner only, not with a token confined to a task). The first time it names the development project, which must exist and be active; afterwards it may be left out, and naming a
   * different one is refused. `expectedRevision` is the settings' revision, left out only before they were first written.
   */
  async enable(by: Principal, command: NoActor & { expectedRevision?: number; projectId?: string }): Promise<{ revision: number; projectId: string }> {
    onlyKnown(command, ["commandId", "expectedRevision", "projectId"]);
    const named = command.projectId === undefined ? undefined : checkProjectId(command.projectId);
    const expected = command.expectedRevision === undefined ? undefined : checkRevision(command.expectedRevision);
    let projectId = "";
    const result = await this.#retrying(() => this.#runner.command("owncode.enable", { commandId: this.#scoped(by, command.commandId), actor: by.id }, async () => ({
      payload: clean({ expectedRevision: expected, projectId: named }),
      build: async () => {
        this.#owner(by, "enable work on NimbleNewt's own code");
        const found = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
        this.#revisionMatches(found?.revision, expected);
        const b = found?.body as unknown as OwnCodeSettings | undefined;
        if (b?.projectId !== undefined && named !== undefined && named !== b.projectId) invalid("projectId", `the NimbleNewt development project is ${b.projectId}; it stays the same once named`);
        projectId = b?.projectId ?? named ?? invalid("projectId", "name the NimbleNewt development project the first time the feature is enabled");
        if (b === undefined) {
          const project = await this.#runner.get("project", projectId);
          if (project === undefined) throw new DomainError("not_found", `project ${projectId} does not exist`);
          if ((project.body as unknown as { state?: string }).state !== "active") invalid("projectId", `project ${projectId} is not active`);
        }
        if (b?.enabled === true) invalid("enabled", "work on NimbleNewt's own code is already enabled");
        const next: OwnCodeSettings = { enabled: true, projectId, history: this.#settingsHistory(b, by.id, true) };
        return { ref: SETTINGS, creates: found === undefined, changes: [found === undefined ? { type: "create", ref: SETTINGS, body: clean(next) } : { type: "update", ref: SETTINGS, expectedRevision: found.revision, body: clean(next) }], detail: { projectId } };
      },
    })));
    if (result.replayed) projectId = (await this.settings(by))?.projectId ?? projectId;
    return { revision: result.revision, projectId };
  }

  /** Switches the feature off (the owner only). Requests are then refused and no attempt starts in the development project; approvals already given stay recorded, and count again only once it is enabled again. */
  async disable(by: Principal, command: NoActor & { expectedRevision: number }): Promise<{ revision: number }> {
    onlyKnown(command, ["commandId", "expectedRevision"]);
    const expected = checkRevision(command.expectedRevision);
    const result = await this.#retrying(() => this.#runner.command("owncode.disable", { commandId: this.#scoped(by, command.commandId), actor: by.id }, async () => ({
      payload: { expectedRevision: expected },
      build: async () => {
        this.#owner(by, "disable work on NimbleNewt's own code");
        const found = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
        this.#revisionMatches(found?.revision, expected);
        const b = found!.body as unknown as OwnCodeSettings;
        if (!b.enabled) invalid("enabled", "work on NimbleNewt's own code is already off");
        const next: OwnCodeSettings = { ...b, enabled: false, history: this.#settingsHistory(b, by.id, false) };
        return { ref: SETTINGS, creates: false, changes: [{ type: "update", ref: SETTINGS, expectedRevision: found!.revision, body: clean(next) }], detail: {} };
      },
    })));
    return { revision: result.revision };
  }

  // ---- requests --------------------------------------------------------------------------------------------------------------

  /**
   * An agent (or the owner) asks to work on NimbleNewt's own code: what, why, the expected effort and the expected cost, each in its own words. Refused while the feature is off, with a message saying the owner
   * can enable it. At most five of one requester wait at a time. Nothing starts and nothing is spent.
   */
  async request(by: Principal, command: NoActor & OwnCodeRequestText): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", ...REQUEST_FIELDS]);
    if (by.kind !== "agent" && by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not ask to work on NimbleNewt's own code; agents and the owner ask`);
    const request = Object.fromEntries(REQUEST_FIELDS.map((f) => [f, plain((command as unknown as Record<string, unknown>)[f], f, OWNCODE_LIMITS.text)])) as unknown as OwnCodeRequestText;
    const scoped = this.#scoped(by, command.commandId);
    const id = derivedId("ocr", scoped);
    const result = await this.#retrying(() => this.#runner.command("owncode.request", { commandId: scoped, actor: by.id }, async () => ({
      payload: request as unknown as JsonObject,
      build: async () => {
        await this.#enabledOrRefuse();
        const index = await this.#index();
        if (index.ids.length >= OWNCODE_LIMITS.listed) throw new DomainError("unavailable", `${OWNCODE_LIMITS.listed} requests to work on NimbleNewt's own code are kept, the most`);
        const mine = index.pending[by.id] ?? [];
        if (mine.length >= OWNCODE_LIMITS.pendingPerAgent) throw new DomainError("unavailable", `${mine.length} of your requests already wait for the owner's decision; at most ${OWNCODE_LIMITS.pendingPerAgent} wait at a time`);
        const body: OwnCodeRequestBody = { requestedBy: by.id, request, status: "pending", history: [{ at: this.#runner.now(), by: by.id, to: "pending" }] };
        const ref: AggregateRef = { kind: "owncode-request", id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }, this.#indexChange(index, [...index.ids, id], { ...index.pending, [by.id]: [...mine, id] })], detail: {} };
      },
    })));
    return { id: result.id, replayed: result.replayed };
  }

  /**
   * The owner decides a waiting request (only the owner; not with a token confined to a task). `approve` needs the feature on and creates the task in the development project, titled from the request; the
   * request then names the task. `reject` creates nothing. A repeat of the same command finds the same task (its ID derives from the request). When the approval was recorded but its task creation failed, a
   * new `approve` of the request at its current revision (any command ID) creates the task, still exactly once.
   */
  async decide(by: Principal, command: NoActor & { requestId: string; expectedRevision: number; decision: "approve" | "reject"; note?: string }): Promise<{ revision: number; status: OwnCodeStatus; taskId?: string }> {
    onlyKnown(command, ["commandId", "requestId", "expectedRevision", "decision", "note"]);
    const id = this.#id(command.requestId);
    const expected = checkRevision(command.expectedRevision);
    const decision = command.decision === "approve" || command.decision === "reject" ? command.decision : invalid("decision", "must be approve or reject");
    const note = command.note === undefined ? undefined : plain(command.note, "note", OWNCODE_LIMITS.note);
    if (decision === "approve" && this.#projects === undefined) throw new DomainError("unavailable", "the project records are not available here, so no request can be approved");
    let finishing = false;
    const result = await this.#retrying(() => this.#runner.command("owncode.decide", { commandId: this.#scoped(by, command.commandId), actor: by.id }, async () => ({
      payload: clean({ requestId: id, expectedRevision: expected, decision, note }),
      build: async () => {
        this.#owner(by, "decide requests to work on NimbleNewt's own code");
        const got = await this.#get(id);
        if (got === undefined) throw new DomainError("not_found", `no request ${id}`);
        if (got.revision !== expected) throw new DomainError("stale_revision", `request ${id} is at revision ${got.revision}, not ${expected}`, { currentRevision: got.revision });
        if (decision === "approve" && got.body.status === "approved" && got.body.taskId !== undefined && (await this.#runner.get("task", got.body.taskId)) === undefined) { finishing = true; throw UNFINISHED; }
        if (got.body.status !== "pending") invalid("requestId", `request ${id} is ${got.body.status}; only a waiting request is decided`);
        const index = await this.#index();
        const pending = this.#withoutPending(index, got.body.requestedBy, id);
        const nowIso = this.#runner.now();
        const changes: Change[] = [];
        let next: OwnCodeRequestBody;
        if (decision === "approve") {
          const settings = await this.#enabledOrRefuse();
          const project = await this.#runner.get("project", settings.projectId);
          if (project === undefined || (project.body as unknown as { state?: string }).state !== "active") throw new DomainError("unavailable", `the NimbleNewt development project ${settings.projectId} is not active, so no work can be approved into it`);
          const taskId = taskIdOf(id);
          const link: AggregateRef = { kind: "owncode-task", id: taskId };
          if ((await this.#runner.get(link.kind, link.id)) !== undefined) throw new DomainError("integrity", `task ${taskId} is already linked to a request`);
          next = { ...got.body, status: "approved", projectId: settings.projectId, taskId, decidedBy: by.id, ...(note === undefined ? {} : { note }), history: this.#history(got.body, nowIso, by.id, "approved") };
          changes.push({ type: "create", ref: link, body: { requestId: id } satisfies TaskLink as unknown as JsonObject });
        } else {
          next = { ...got.body, status: "rejected", decidedBy: by.id, ...(note === undefined ? {} : { note }), history: this.#history(got.body, nowIso, by.id, "rejected") };
        }
        changes.unshift({ type: "update", ref: { kind: "owncode-request", id }, expectedRevision: got.revision, body: clean(next) }, this.#indexChange(index, index.ids, pending));
        return { ref: { kind: "owncode-request", id }, creates: false, changes, detail: clean({ decision, taskId: next.taskId }) };
      },
    }))).catch((error: unknown) => { if (error === UNFINISHED && finishing) return undefined; throw error; });
    const stored = (await this.#get(id))?.body;
    if (stored === undefined) throw new DomainError("integrity", `request ${id} is not found after its decision`);
    if (stored.status === "approved" && stored.taskId !== undefined && stored.projectId !== undefined) await this.#createTask(by, id, stored);
    return { revision: result?.revision ?? expected, status: stored.status, ...(stored.taskId === undefined ? {} : { taskId: stored.taskId }) };
  }

  /**
   * Withdraws a request: the owner withdraws a waiting or an approved one (an approval is withdrawn: no further attempt starts on its task); the requester withdraws its own waiting one. It stays listed.
   */
  async withdraw(by: Principal, command: NoActor & { requestId: string; expectedRevision: number; reason: string }): Promise<{ revision: number }> {
    onlyKnown(command, ["commandId", "requestId", "expectedRevision", "reason"]);
    const id = this.#id(command.requestId);
    const expected = checkRevision(command.expectedRevision);
    const reason = plain(command.reason, "reason", OWNCODE_LIMITS.note);
    const result = await this.#retrying(() => this.#runner.command("owncode.withdraw", { commandId: this.#scoped(by, command.commandId), actor: by.id }, async () => ({
      payload: { requestId: id, expectedRevision: expected, reason },
      build: async () => {
        const got = await this.#get(id);
        const owner = this.#isOwner(by);
        if (got === undefined || !(owner || got.body.requestedBy === by.id)) throw new DomainError("not_found", `no request ${id} you may withdraw`);
        if (got.revision !== expected) throw new DomainError("stale_revision", `request ${id} is at revision ${got.revision}, not ${expected}`, { currentRevision: got.revision });
        const status = got.body.status;
        if (status === "approved" && !owner) throw new DomainError("forbidden", `only the owner withdraws an approval (request ${id})`);
        const from = status === "pending" || status === "approved" ? status : invalid("requestId", `request ${id} is ${status}; only a waiting or approved request is withdrawn`);
        const next: OwnCodeRequestBody = { ...got.body, status: "withdrawn", withdrawnFrom: from, history: this.#history(got.body, this.#runner.now(), by.id, "withdrawn", reason) };
        const changes: Change[] = [{ type: "update", ref: { kind: "owncode-request", id }, expectedRevision: got.revision, body: clean(next) }];
        if (from === "pending") { const index = await this.#index(); changes.push(this.#indexChange(index, index.ids, this.#withoutPending(index, got.body.requestedBy, id))); }
        return { ref: { kind: "owncode-request", id }, creates: false, changes, detail: { from } };
      },
    })));
    return { revision: result.revision };
  }

  /** One request: the owner, or its requester. Anyone else gets `undefined`. */
  async get(viewer: Principal, requestId: string): Promise<View<OwnCodeRequestBody> | undefined> {
    const found = typeof requestId === "string" && REQUEST_ID.test(requestId) ? await this.#runner.get("owncode-request", requestId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as OwnCodeRequestBody;
    return this.#isOwner(viewer) || body.requestedBy === viewer.id ? view<OwnCodeRequestBody>(found) : undefined;
  }

  /** The requests, oldest first, paged: the owner sees all, an agent its own. `status` keeps one status. */
  async list(viewer: Principal, page: { afterId?: string; limit?: number; status?: string } = {}): Promise<{ items: View<OwnCodeRequestBody>[]; next?: string }> {
    const limit = page.limit === undefined ? 20 : whole(page.limit, "limit", 1, OWNCODE_LIMITS.page);
    const status = page.status === undefined ? undefined : (OWNCODE_STATUSES as readonly string[]).includes(page.status) ? page.status : invalid("status", `must be one of ${OWNCODE_STATUSES.join(", ")}`);
    const index = await this.#index();
    const start = page.afterId === undefined ? 0 : index.ids.indexOf(page.afterId) + 1;
    if (page.afterId !== undefined && start === 0) invalid("afterId", "is not in the list");
    const owner = this.#isOwner(viewer);
    const items: View<OwnCodeRequestBody>[] = [];
    let pos = start;
    for (; pos < index.ids.length && items.length < limit; pos++) {
      const found = await this.#runner.get("owncode-request", index.ids[pos]!);
      const b = found?.body as unknown as OwnCodeRequestBody | undefined;
      if (found !== undefined && b !== undefined && (owner || b.requestedBy === viewer.id) && (status === undefined || b.status === status)) items.push(view<OwnCodeRequestBody>(found));
    }
    return { items, ...(pos < index.ids.length ? { next: index.ids[pos - 1]! } : {}) };
  }

  // ---- the start gate --------------------------------------------------------------------------------------------------------

  /**
   * Why an attempt on this task may not start, or `undefined`. Only tasks of the development project are judged: while the feature is off, a task there that no approved request created, and one whose request
   * is no longer approved, are refused, and so is a task whose title or description is no longer the one the approval created. A task that cannot be read is left to the admission's own check (which refuses it). A settings or request record that cannot be read throws, so admission fails.
   */
  async checkAttempt(taskId: string): Promise<string | undefined> {
    const settings = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
    const s = settings?.body as unknown as OwnCodeSettings | undefined;
    if (s?.projectId === undefined) return undefined;
    const task = await this.#runner.get("task", taskId);
    if (task === undefined || (task.body as unknown as { projectId?: string }).projectId !== s.projectId) return undefined;
    if (!s.enabled) return `task ${taskId} is in the NimbleNewt development project. ${OWNCODE_OFF}`;
    const link = (await this.#runner.get("owncode-task", taskId))?.body as unknown as TaskLink | undefined;
    if (link === undefined) return `task ${taskId} is in the NimbleNewt development project and came from no approved request; work on NimbleNewt's own code starts only after the owner approves a request`;
    const request = await this.#get(link.requestId);
    if (request === undefined) return `task ${taskId}: its request ${link.requestId} is not found, so no work starts`;
    if (request.body.status !== "approved" || request.body.taskId !== taskId || request.body.projectId !== s.projectId) return `task ${taskId}: its request ${link.requestId} is ${request.body.status}${request.body.withdrawnFrom === "approved" ? " (the owner withdrew the approval)" : ""}, so no work starts`;
    // The approval is of the work as asked: a task whose title or description was changed afterwards (by its worker, a meeting decision or anyone with task.update) is not that work.
    const want = this.#taskText(link.requestId, request.body);
    const t = task.body as unknown as { title?: string; description?: string };
    if (t.title !== want.title || t.description !== want.description) return `task ${taskId} was changed after the owner approved request ${link.requestId} (its title or description is not the approved one), so no work starts; changed work needs a new request`;
    return undefined;
  }

  /**
   * Stops work already running in the development project that the gate would not let start now (card B06, second slice). Run on every dispatcher tick with the attempts the dispatcher has running
   * (`running(from, limit)` is asked only once a development project is named, for at most `OWNCODE_STOP.look` live attempts from where the last look stopped, so an installation that never enabled the feature does no look at all). For each task there whose `checkAttempt` refuses, L02's Stop
   * of the task is asked for, as whoever runs the look (the dispatcher's service principal acting for the owner): the task is paused at once, then prepared and ended through the Stop's own phases (which
   * its sweep carries on after a restart). The Stop's reason is the gate's refusal, so the owner reads why. Idempotent: the command ID is the attempt's, so a repeat (or a look after a restart) replays the
   * same request; a task whose Stop is already in force (anyone's) is left to it. At most `OWNCODE_STOP.perTick` Stops are asked for per call; the rest are found on the next tick. A failure for one task
   * does not keep the others from being stopped; the failed ones are returned (and asked again next tick).
   */
  async stopRefused(by: Principal, deps: { readonly running: (from: number, limit: number) => Promise<{ readonly items: readonly OwnCodeRunning[]; readonly next: number }>; readonly stops: OwnCodeStops; readonly told?: (stop: { attemptId: string; taskId: string; projectId: string; reason: string; intentId: string }) => Promise<void> }): Promise<{ stopped: string[]; failed: { attemptId: string; error: string }[] }> {
    const stopped: string[] = [];
    const failed: { attemptId: string; error: string }[] = [];
    const s = (await this.#runner.get(SETTINGS.kind, SETTINGS.id))?.body as unknown as OwnCodeSettings | undefined;
    if (s?.projectId === undefined) return { stopped, failed };
    const seen = new Set<string>();
    // The look begins where the last one stopped (in memory: after a restart it begins at the start again, which only means the first look after it covers the front of the list again).
    const look = await deps.running(this.#stopFrom, OWNCODE_STOP.look);
    this.#stopFrom = look.next;
    for (const a of look.items) {
      if (stopped.length + failed.length >= OWNCODE_STOP.perTick) break;
      if (a.projectId !== s.projectId || seen.has(a.taskId)) continue;
      seen.add(a.taskId);
      try {
        const why = await this.checkAttempt(a.taskId);
        if (why === undefined) continue;
        // A Stop (or Force Stop) of the task already in force (the owner's own, or this look's from an earlier tick) is carried on by the Stop's sweep; a Suspend is taken over by the Stop.
        const held = await deps.stops.holding(a.taskId);
        if (held !== undefined && held.mode !== "suspend") continue;
        const reason = ownCodeStopReason(why);
        const asked = await deps.stops.request(by, { commandId: `owncode-stop:${a.attemptId}`, scope: { kind: "task", id: a.taskId }, mode: "stop", reason });
        // A replay is a Stop this look already asked for this attempt: in progress, it is the Stop's sweep's to carry on; cancelled, the owner resumed the task while it was being stopped, and that
        // later choice of the owner's stands for this attempt (its next start is still refused by the gate). Either way nothing more is done, and it does not count toward this tick's Stops.
        if (asked.replayed) continue;
        // The Stop's first steps run now (as the owner's own Stop does); whatever is left, the Stop's sweep carries on.
        await deps.stops.advance(by, { intentId: asked.intentId }).catch(() => undefined);
        stopped.push(a.attemptId);
        await deps.told?.({ attemptId: a.attemptId, taskId: a.taskId, projectId: a.projectId, reason, intentId: asked.intentId }).catch(() => undefined);
      } catch (error) { failed.push({ attemptId: a.attemptId, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }); }
    }
    return { stopped, failed };
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  /**
   * The title and description of the task an approval creates, derived from the stored request alone (so the gate can tell later whether the task still says what was approved). The title is cut at a character
   * boundary to the task title's limit, which counts UTF-16 code units.
   */
  #taskText(id: string, stored: OwnCodeRequestBody): { title: string; description: string } {
    let title = "";
    for (const ch of `NimbleNewt: ${stored.request.what.replace(/\s+/g, " ").trim()}`) { if (title.length + ch.length > OWNCODE_LIMITS.title) break; title += ch; }
    const description = `Approved request ${id} from ${stored.requestedBy}.\nWhat: ${stored.request.what}\nWhy: ${stored.request.why}\nExpected effort: ${stored.request.effort}\nExpected cost: ${stored.request.cost}`;
    return { title, description };
  }

  async #createTask(by: Principal, id: string, stored: OwnCodeRequestBody): Promise<void> {
    const { title, description } = this.#taskText(id, stored);
    const created = await this.#projects!.createTask({ commandId: taskCommandOf(id), actor: stored.decidedBy ?? by.id, projectId: stored.projectId!, title, description });
    if (created.id !== stored.taskId) throw new DomainError("integrity", `request ${id}: the task created (${created.id}) is not the one recorded (${stored.taskId})`);
  }

  async #enabledOrRefuse(): Promise<{ projectId: string }> {
    const found = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
    const b = found?.body as unknown as OwnCodeSettings | undefined;
    if (b === undefined || !b.enabled || b.projectId === undefined) throw new DomainError("unavailable", OWNCODE_OFF);
    return { projectId: b.projectId };
  }

  #isOwner(p: Principal): boolean { return p.kind === "owner" && p.taskScope === undefined; }
  #owner(by: Principal, what: string): void { if (!this.#isOwner(by)) throw new DomainError("forbidden", `only the owner may ${what}${by.kind === "owner" ? " (not with a token confined to a task)" : ""}`); }
  #scoped(by: Principal, commandId: unknown): string {
    try { return scopedCommandId(by.id, commandId); } catch { return invalid("commandId", "must be 1 to 120 characters"); }
  }
  #revisionMatches(current: number | undefined, expected: number | undefined): void {
    if (current === undefined && expected === undefined) return;
    if (current === undefined) throw new DomainError("stale_revision", "the settings were never written; leave expectedRevision out", { currentRevision: 0 });
    if (expected !== current) throw new DomainError("stale_revision", `the settings are at revision ${current}, not ${expected ?? "unset"}`, { currentRevision: current });
  }
  #settingsHistory(b: OwnCodeSettings | undefined, by: string, enabled: boolean): OwnCodeSettings["history"] {
    return [...(b?.history ?? []), { at: this.#runner.now(), by, enabled }].slice(-OWNCODE_LIMITS.history);
  }
  #history(b: OwnCodeRequestBody, at: string, by: string, to: OwnCodeStatus, cause?: string): OwnCodeRequestBody["history"] {
    return [...b.history, { at, by, to, ...(cause === undefined ? {} : { cause }) }].slice(-OWNCODE_LIMITS.history);
  }
  #id(value: unknown): string { return typeof value === "string" && REQUEST_ID.test(value) ? value : invalid("requestId", "is not a request ID"); }

  async #get(id: string): Promise<{ revision: number; body: OwnCodeRequestBody } | undefined> {
    const found = await this.#runner.get("owncode-request", id);
    return found === undefined ? undefined : { revision: found.revision, body: found.body as unknown as OwnCodeRequestBody };
  }

  async #index(): Promise<IndexBody & { revision: number }> {
    const found = await this.#runner.get(INDEX.kind, INDEX.id);
    const b = found?.body as unknown as IndexBody | undefined;
    return found === undefined || b === undefined ? { ids: [], pending: {}, revision: 0 } : { ids: b.ids, pending: b.pending, revision: found.revision };
  }

  #withoutPending(index: IndexBody, agent: string, id: string): Record<string, readonly string[]> {
    const rest = (index.pending[agent] ?? []).filter((x) => x !== id);
    const out: Record<string, readonly string[]> = { ...index.pending };
    if (rest.length === 0) delete out[agent]; else out[agent] = rest;
    return out;
  }

  #indexChange(index: { revision: number }, ids: readonly string[], pending: Readonly<Record<string, readonly string[]>>): Change {
    const body = { ids: [...ids], pending: Object.fromEntries(Object.entries(pending).map(([k, v]) => [k, [...v]])) } as unknown as JsonObject;
    return index.revision === 0 ? { type: "create", ref: INDEX, body } : { type: "update", ref: INDEX, expectedRevision: index.revision, body };
  }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= OWNCODE_LIMITS.retries) throw error;
      }
    }
  }
}

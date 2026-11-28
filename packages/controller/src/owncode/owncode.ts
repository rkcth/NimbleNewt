import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { keptWindow } from "../domain/kept-window.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { clean, invalid, plain, whole } from "../standups/shared.js";
import { SEPARATE_LIMITS, judgeSeparate, type GuardedPlace, type OwnPlace, type Separation, type SeparationFs } from "./separate.js";

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
 * - **Its own checkout** (third slice). The development project works only in a checkout of its own: enabling, approving and every start (so also the stop look) need every local place of the project
 *   (`judgeSeparate`) to be apart from the running installation (its program files, runtime, data directory, database file, transfer state and release folders): not the same folder, not inside one and not
 *   above one, after symbolic links and bind mounts are resolved. When it cannot tell, it refuses. The owner reads why in `settings`; anyone else is told only that the checkout is not confirmed separate.
 * - **The listed window** (retention slice, K06's recorded gap). At most `OWNCODE_LIMITS.listed` (500) requests are listed. A new request that would make the list longer first moves the oldest ENDED
 *   requests out of it in the same write (`keptWindow`, as cards B04 and B05 do), and the index counts them as `archived`. Ended is rejected, withdrawn, or approved with its task done or cancelled. A waiting
 *   request, an approval whose task is open or not yet made, and a record that does not read as one of the four statuses are open and are never moved out (fail closed). A request moved out is kept unchanged:
 *   it stays readable by its ID with the same rights, its task link stays, and the start gate (which reads the link and the request, never the list) judges it as before. Only when every listed request is
 *   open is a new one refused. The work is bounded: only a full list is looked at, at most one request and one task read per listed request, oldest first, stopping once enough are found.
 * - **Not here** (later slices): launch proposals and their explanation, review, revision binding and installation (the card's other clauses), chat wording for the owner's controls.
 */
export const OWNCODE_STATUSES = ["pending", "approved", "rejected", "withdrawn"] as const;
export type OwnCodeStatus = (typeof OWNCODE_STATUSES)[number];

export const OWNCODE_LIMITS = { text: 600, note: 400, title: 200, pendingPerAgent: 5, listed: 500, page: 100, history: 10, retries: 8 } as const;
/** How much one tick's stop look does (card B06, second slice): at most `look` live attempts are looked at (the rest on the next ticks, from where this one stopped), and at most `perTick` Stops are asked for. */
export const OWNCODE_STOP = { look: 100, perTick: 5 } as const;
/** What the stop look is given: an attempt that is running, with its task and project (the dispatcher's record). */
export interface OwnCodeRunning { readonly attemptId: string; readonly taskId: string; readonly projectId: string; /** Its position in the live list, so a look cut short goes on from it next time. */ readonly at?: number }
/** The part of L02's Stop (`StopService`) the stop look uses. */
export interface OwnCodeStops {
  holding(taskId: string): Promise<{ intentId: string; mode: string } | undefined>;
  request(by: Principal, command: { commandId: string; scope: { kind: "task"; id: string }; mode: "stop"; reason: string }): Promise<{ intentId: string; replayed: boolean }>;
  advance(by: Principal, command: { intentId: string }): Promise<unknown>;
  get(by: Principal, intentId: string): Promise<{ readonly phase: string; readonly reason: string } | undefined>;
}
const STOP_REASON_PREFIX = "Stopped NimbleNewt development work: ";
/** The reason a Stop of running development work records (the pause and the Stop show it): the gate's own refusal. */
export const ownCodeStopReason = (why: string): string => `${STOP_REASON_PREFIX}${why}`.slice(0, 500);
/**
 * The owner's notice for one stopped attempt (at most 200 characters, the notice limit): the gate's own words when they fit whole, otherwise a fixed sentence that points at the Stop, whose reason holds them
 * whole. Never cut in the middle.
 */
export const ownCodeStopNotice = (stop: { readonly attemptId: string; readonly intentId: string; readonly reason: string }): string => {
  const why = stop.reason.startsWith(STOP_REASON_PREFIX) ? stop.reason.slice(STOP_REASON_PREFIX.length) : stop.reason;
  const whole = `Attempt ${stop.attemptId} was stopped: ${why}`;
  if (whole.length <= 200) return whole;
  const short = `Attempt ${stop.attemptId} was stopped: work on NimbleNewt's own code may not run now. The full reason is on Stop ${stop.intentId}. The task stays paused until the owner resumes it.`;
  return short.length <= 200 ? short : `Attempt ${stop.attemptId} was stopped. The full reason is on its Stop.`;
};
/** The ID L02's Stop gives the request this look makes for an attempt (`StopService.request`: derived from the asker and the command ID). */
const ownStopIntentId = (by: Principal, attemptId: string): string => derivedId("stp", scopedCommandId(by.id, `owncode-stop:${attemptId}`));
const STOP_OVER = ["done", "recovery-required", "cancelled"];
const REQUEST_ID = /^ocr-[a-z2-7]{20}$/;
const SETTINGS: AggregateRef = { kind: "owncode-settings", id: "installation" };
const INDEX: AggregateRef = { kind: "owncode-index", id: "installation" };
/** What the start gate says when the development project's checkout is not confirmed apart from the running installation (the detail is the owner's, in `settings`). */
export const ownCodeCheckoutRefused = (taskId: string): string => `task ${taskId} is in the NimbleNewt development project, but that project's own checkout is not confirmed to be apart from the running installation, so no work starts; the owner can see why in the feature's settings`;
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

interface IndexBody { readonly ids: readonly string[]; readonly pending: Readonly<Record<string, readonly string[]>>; /** How many ended requests the listed window moved out (retention slice). */ readonly archived?: number }
/** The task states in which an approved request's work is over (its request may then leave the listed window). */
const TASK_OVER = new Set(["done", "cancelled"]);
interface TaskLink { readonly requestId: string }

export interface OwnCodeOptions extends RunnerOptions {
  /** Creates the approved task in the development project. Without it nothing is approved (fail closed). */
  readonly projects?: Pick<ProjectService, "createTask">;
  /**
   * Card B06, third slice: where the development project works, and where it must never work. `places` reads the project's places from its records (`ProjectResourceService.localPlaces`); `guarded` are the
   * running installation's folders (`installationGuards`, from what builds the controller). Without it nothing is enabled or approved and no work starts in the development project (fail closed).
   */
  readonly checkout?: { readonly places: (projectId: string, limit: number) => Promise<readonly OwnPlace[] | "too-many">; readonly guarded: readonly GuardedPlace[]; readonly fs?: SeparationFs; readonly platform?: string };
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
  readonly #checkout: OwnCodeOptions["checkout"];
  /** Where the next stop look begins in the dispatcher's live list (card B06, second slice). */
  #stopFrom = 0;

  private constructor(runner: CommandRunner, projects: Pick<ProjectService, "createTask"> | undefined, checkout: OwnCodeOptions["checkout"]) { this.#runner = runner; this.#projects = projects; this.#checkout = checkout; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: OwnCodeOptions = {}): OwnCodeService {
    const { projects, checkout, ...rest } = options;
    return new OwnCodeService(new CommandRunner(storage, epoch, rest), projects, checkout);
  }

  // ---- the feature -----------------------------------------------------------------------------------------------------------

  /**
   * The feature's settings (the owner only; anyone else gets `undefined`). Never written: off, with no development project. Once a development project is named, `checkout` says whether its own checkout
   * is apart from the running installation now (judged at each read, as at each start), and why not.
   */
  async settings(viewer: Principal): Promise<{ revision: number; enabled: boolean; projectId?: string; checkout?: { separate: boolean; reason?: string }; history: OwnCodeSettings["history"] } | undefined> {
    if (!this.#isOwner(viewer)) return undefined;
    const found = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
    if (found === undefined) return { revision: 0, enabled: false, history: [] };
    const b = found.body as unknown as OwnCodeSettings;
    const checkout = b.projectId === undefined ? undefined : await this.#separation(b.projectId);
    return { revision: found.revision, enabled: b.enabled, ...(b.projectId === undefined ? {} : { projectId: b.projectId }), ...(checkout === undefined ? {} : { checkout: checkout.separate ? { separate: true } : { separate: false, reason: checkout.detail } }), history: b.history };
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
        const apart = await this.#separation(projectId);
        if (!apart.separate) throw new DomainError("unavailable", `work on NimbleNewt's own code is not enabled: ${apart.detail}`);
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
        const mine = index.pending[by.id] ?? [];
        if (mine.length >= OWNCODE_LIMITS.pendingPerAgent) throw new DomainError("unavailable", `${mine.length} of your requests already wait for the owner's decision; at most ${OWNCODE_LIMITS.pendingPerAgent} wait at a time`);
        const kept = await this.#window(index.ids, id);
        if (kept === undefined) throw new DomainError("unavailable", `${OWNCODE_LIMITS.listed} requests to work on NimbleNewt's own code are listed and all are waiting or approved with their work open; one is decided, withdrawn or its task finished first`);
        const body: OwnCodeRequestBody = { requestedBy: by.id, request, status: "pending", history: [{ at: this.#runner.now(), by: by.id, to: "pending" }] };
        const ref: AggregateRef = { kind: "owncode-request", id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }, this.#indexChange(index, kept.ids, { ...index.pending, [by.id]: [...mine, id] }, index.archived + kept.archived.length)], detail: {} };
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
          const apart = await this.#separation(settings.projectId);
          if (!apart.separate) throw new DomainError("unavailable", `no work can be approved into the NimbleNewt development project now: ${apart.detail}`);
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
   * Withdraws a request: the owner withdraws a waiting or an approved one (an approval is withdrawn: no further attempt starts on its task); the requester withdraws its own waiting one. It is kept, and stays
   * listed until newer requests move it out of the listed window (archived, still readable by its ID).
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

  /** The requests, oldest first, paged: the owner sees all, an agent its own. `status` keeps one status. `archived` (the owner only, when above 0) counts the ended requests the listed window moved out. */
  async list(viewer: Principal, page: { afterId?: string; limit?: number; status?: string } = {}): Promise<{ items: View<OwnCodeRequestBody>[]; next?: string; archived?: number }> {
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
    return { items, ...(pos < index.ids.length ? { next: index.ids[pos - 1]! } : {}), ...(owner && index.archived > 0 ? { archived: index.archived } : {}) };
  }

  // ---- the start gate --------------------------------------------------------------------------------------------------------

  /**
   * Why an attempt on this task may not start, or `undefined`. Only tasks of the development project are judged: while the feature is off, a task there that no approved request created, and one whose request
   * is no longer approved, are refused, and so is a task whose title or description is no longer the one the approval created. A task that cannot be read is left to the admission's own check (which refuses it). A settings or request record that cannot be read throws, so admission fails.
   */
  async checkAttempt(taskId: string): Promise<string | undefined> { return this.#checkAttempt(taskId, undefined); }

  /** `checkAttempt`, with the development project's checkout judged once per `memo` (one stop look judges it once, not once per attempt). */
  async #checkAttempt(taskId: string, memo: { apart?: Promise<Separation> } | undefined): Promise<string | undefined> {
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
    // Third slice: the work happens in the project's own checkout, apart from the running installation. Judged at every start (a binding can be moved after the approval). The detail is the owner's.
    const apart = memo === undefined ? this.#separation(s.projectId) : (memo.apart ??= this.#separation(s.projectId));
    if (!(await apart).separate) return ownCodeCheckoutRefused(taskId);
    return undefined;
  }

  /**
   * Whether a child task may be made in this project (card B06, third slice; asked by `swarm.spawn` before anything is made). Not in the development project, once it is named (on or off): the owner
   * approved each task there by its own text, and a child's text is its parent's agent's, so a child there could never start (`checkAttempt` finds no approved request for it) and would only hold part of its
   * parent's allowance. Work there is divided by new requests instead. A settings record that cannot be read throws, so the spawn fails.
   */
  async checkSpawn(projectId: string): Promise<string | undefined> {
    const s = (await this.#runner.get(SETTINGS.kind, SETTINGS.id))?.body as unknown as OwnCodeSettings | undefined;
    if (s?.projectId === undefined || s.projectId !== projectId) return undefined;
    return "no child task is made in the NimbleNewt development project: the owner approves each piece of work there by its own request, so ask for the part as a new request (owncode.request)";
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
    const memo: { apart?: Promise<Separation> } = {};
    // The look begins where the last one stopped (in memory: after a restart it begins at the start again, which only means the first look after it covers the front of the list again).
    const look = await deps.running(this.#stopFrom, OWNCODE_STOP.look);
    this.#stopFrom = look.next;
    for (const a of look.items) {
      // Cut short by the per-tick limit: the next look begins at the first attempt not judged, so the ones after a failure (or after five Stops) are reached next tick, also when the whole list fits in one look.
      if (stopped.length + failed.length >= OWNCODE_STOP.perTick) { if (a.at !== undefined && Number.isSafeInteger(a.at) && a.at >= 0) this.#stopFrom = a.at; break; }
      if (a.projectId !== s.projectId || seen.has(a.taskId)) continue;
      seen.add(a.taskId);
      try {
        const why = await this.#checkAttempt(a.taskId, memo);
        if (why === undefined) continue;
        // A Stop this look already asked for this attempt on an earlier tick is not asked for again (asking again would touch the task's pause, which may be the owner's own by now). In progress, it is the
        // Stop's sweep's to carry on, and the owner's notice is sent again under the same command ID (so a notice lost to a restart between the Stop and the notice is sent, and never twice). Over or
        // cancelled (the owner resumed the task while it was being stopped), the owner's later choice stands for this attempt; its next start is still refused by the gate. Not counted toward this tick's Stops.
        const mine = await deps.stops.get(by, ownStopIntentId(by, a.attemptId));
        if (mine !== undefined) {
          if (!STOP_OVER.includes(mine.phase)) await deps.told?.({ attemptId: a.attemptId, taskId: a.taskId, projectId: a.projectId, reason: mine.reason, intentId: ownStopIntentId(by, a.attemptId) }).catch(() => undefined);
          continue;
        }
        // A Stop (or Force Stop) of the task already in force (the owner's own, or another attempt's) is carried on by the Stop's sweep. A Suspend still in progress is waited for, never upgraded: an upgraded
        // Suspend leaves no record under this look's own ID, so once the owner resumed the task a later tick would ask again, and L02's request would pause the task anew over the owner's resume (second
        // review of the second slice). A finished Suspend that still holds the task is followed by this look's own Stop, which goes on from its checkpoint.
        const held = await deps.stops.holding(a.taskId);
        if (held !== undefined) {
          if (held.mode !== "suspend") continue;
          const suspend = await deps.stops.get(by, held.intentId);
          if (suspend === undefined || !STOP_OVER.includes(suspend.phase)) continue;
        }
        const reason = ownCodeStopReason(why);
        const asked = await deps.stops.request(by, { commandId: `owncode-stop:${a.attemptId}`, scope: { kind: "task", id: a.taskId }, mode: "stop", reason });
        // A replay (the request was recorded but its record could not be read back above) is the Stop's sweep's to carry on, and it does not count toward this tick's Stops.
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

  /** Whether the development project's own checkout is apart from the running installation (`judgeSeparate`). Never throws: a failure to read is "cannot tell", which is not separate. */
  async #separation(projectId: string): Promise<Separation> {
    const c = this.#checkout;
    if (c === undefined) return { separate: false, detail: "this controller cannot check where the development project's checkout is, so nothing is enabled, approved or started there" };
    try {
      return await judgeSeparate(await c.places(projectId, SEPARATE_LIMITS.places), c.guarded, { ...(c.fs === undefined ? {} : { fs: c.fs }), ...(c.platform === undefined ? {} : { platform: c.platform }) });
    } catch (error) {
      return { separate: false, detail: `the development project's places could not be read (${error instanceof DomainError ? error.message.slice(0, 200) : "a storage failure"}), so its checkout cannot be checked` };
    }
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

  async #index(): Promise<{ ids: readonly string[]; pending: Readonly<Record<string, readonly string[]>>; archived: number; revision: number }> {
    const found = await this.#runner.get(INDEX.kind, INDEX.id);
    const b = found?.body as unknown as IndexBody | undefined;
    if (found === undefined || b === undefined) return { ids: [], pending: {}, archived: 0, revision: 0 };
    const archived = typeof b.archived === "number" && Number.isSafeInteger(b.archived) && b.archived >= 0 ? b.archived : 0;
    return { ids: b.ids, pending: b.pending, archived, revision: found.revision };
  }

  /**
   * The listed window for a new request `add` (retention slice): the list with `add` at its end, after the oldest ended requests left it when it is full; `undefined` when every listed request is open.
   * Only a full list is looked at: oldest first, one request read (and, for an approval, one task read) per entry, stopping once enough ended ones are found. A list that is not a list of strings is an
   * integrity failure (nothing is written). A list longer than the window (no controller writes one; only a damaged store): the IDs before its last `OWNCODE_LIMITS.listed` are not read and count as open, so
   * none of them leaves and the reads stay at most one request and one task per window place (as card B05's experiment index does; first review of the retention slice). Such a list comes back under the
   * cap only when its window holds enough ended requests; otherwise (from 1000 entries always) a new request is refused, as every full list was before this slice.
   */
  async #window(ids: readonly string[], add: string): Promise<{ ids: string[]; archived: string[] } | undefined> {
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new DomainError("integrity", "the list of requests to work on NimbleNewt's own code cannot be read, so no request is added");
    const need = ids.length - OWNCODE_LIMITS.listed + 1;
    const ended = new Set<string>();
    for (const x of ids.slice(Math.max(0, ids.length - OWNCODE_LIMITS.listed))) { if (ended.size >= need) break; if (!(await this.#open(x))) ended.add(x); }
    return keptWindow(ids, (x) => !ended.has(x), OWNCODE_LIMITS.listed, add);
  }

  /**
   * Whether a listed request is still open, so it keeps its place in the list: waiting, or approved with its task open or not yet made (the owner may still finish the approval), or a record that does not
   * read as one of the four statuses (fail closed). Rejected, withdrawn, and approved with its task done or cancelled are ended. An entry that is not a request ID, or names no record, holds nothing and is ended.
   */
  async #open(id: string): Promise<boolean> {
    if (!REQUEST_ID.test(id)) return false;
    const found = await this.#runner.get("owncode-request", id);
    if (found === undefined) return false;
    const b = found.body as unknown as Partial<OwnCodeRequestBody> | null;
    const status = typeof b === "object" && b !== null ? b.status : undefined;
    if (status === "rejected" || status === "withdrawn") return false;
    if (status !== "approved") return true;
    if (typeof b!.taskId !== "string" || b!.taskId === "") return true;
    const task = await this.#runner.get("task", b!.taskId);
    const state = (task?.body as { state?: unknown } | undefined)?.state;
    return !(typeof state === "string" && TASK_OVER.has(state));
  }

  #withoutPending(index: IndexBody, agent: string, id: string): Record<string, readonly string[]> {
    const rest = (index.pending[agent] ?? []).filter((x) => x !== id);
    const out: Record<string, readonly string[]> = { ...index.pending };
    if (rest.length === 0) delete out[agent]; else out[agent] = rest;
    return out;
  }

  #indexChange(index: { revision: number; archived: number }, ids: readonly string[], pending: Readonly<Record<string, readonly string[]>>, archived: number = index.archived): Change {
    const body = { ids: [...ids], pending: Object.fromEntries(Object.entries(pending).map(([k, v]) => [k, [...v]])), ...(archived > 0 ? { archived } : {}) } as unknown as JsonObject;
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

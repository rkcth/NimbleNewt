import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { keptWindow, waitingOf } from "../domain/kept-window.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { CatalogService } from "../catalog/catalog.js";
import { METRICS, betterPct, sealOf, type ExperimentBody, type Metric } from "../experiments/experiments.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { clean, invalid, plain, whole } from "../standups/shared.js";
import { AffectedWorkLook, lookStartChanges, type AdoptionLookPorts, type LookBody } from "./affected.js";

/**
 * Scoped adoption and monitored withdrawal (card B05, first slice). An experiment (B04) the controller judged `improved` may be adopted in its project: the practice it tried, or one exact, already published
 * shared tool version it tried. An adoption never publishes, installs or grants anything.
 *
 * - **Adoption needs an existing grant and an independent review.** Anyone who may read the experiment (its proposer, a reader or manager of the project's meetings, the owner) asks for it. It is in force
 *   only when a reviewer approves it in words: the owner, or a manager of the project's meetings who is neither the experiment's proposer nor the one who asked. For a tool the reviewer must also already
 *   hold `toolbox.manage` for the project, must be able to read the version in the catalog, and must not be its registrant or author; the version must be a shared (`toolbox.`) one, published and not
 *   revoked. A personal or protected tool is refused: adopting cannot do what only the toolbox's own review publishes, so a finished improvement (PC) task never publishes a shared tool by being adopted.
 * - **Monitoring triggers withdrawal.** While an adoption is in force, its asker, a manager or the owner reports what the adopted change does now: exactly the experiment's pinned metrics. Each report is
 *   compared with the pinned baseline (the work as it was before), by the experiment's own rule; a metric worse by more than the pinned `maxRegressionPct` is a regression, and a regression withdraws the
 *   adoption in the same write. A manager or the owner (or its asker) can also withdraw it with a reason.
 * - **Regression stops future use.** A withdrawn adoption is no longer in force (`inForce`), and only one adoption of a target is open (asked or in force) at a time. Withdrawal is final; adopting again is
 *   a new request with a new review. Nothing is deleted.
 * - **Every transition is a stored record** written by one command (idempotent by command ID), so a controller restart between any two steps loses nothing and a repeat is answered from the record.
 *
 * - **Retention (retention slice).** Only OPEN adoptions (asked or in force) count toward the project's limit (`ADOPTION_LIMITS.open`), and one asker has at most `ADOPTION_LIMITS.waiting` requests
 *   waiting for a review in a project at once, so asking and taking back cannot fill the project. The list keeps the newest `ADOPTION_LIMITS.listed`; when it is full, the oldest ENDED adoption (declined
 *   or withdrawn) leaves the list in the same write as the new request and is counted as `archived`. An archived adoption is kept unchanged and stays readable by its ID with the same rights.
 *
 * - **Honest future use (standing slice).** A tool version set aside in the catalog (deprecated, or rolled back past) is not adopted, and a tool adoption approved earlier is not in force while the
 *   catalog no longer offers its exact version (revoked, set aside, gone, or another digest). Asking writes nothing; `standing` says why it is not used.
 * - **Nothing else is undone.** Withdrawal (by a decision or a regression) writes only the adoption, its index and the start of its look at affected work; the look then writes only its own record,
 *   the pending list, one activity step per unfinished task and the owner's notice. No task state, effect, timer, outbox entry or catalog record is touched, so a completed external effect stays as it
 *   was recorded.
 *
 * - **Affected work (affected-work slice).** A withdrawal (by a decision or a regression) also starts a look at the work that used the withdrawn change, in the same write: a stored look record and an
 *   entry in a bounded pending list (`affected.ts`). The look reads the catalog's run records of the project in bounded pages, tells each unfinished task that ran exactly that version through one step of
 *   its activity (it keeps the version), counts the finished ones and leaves them as they are, and then tells the owner once. A practice's use by a task is not recorded, so its look tells no task and
 *   says so. A look cut short is carried on by the dispatcher's tick (`sweepAffected`). Declining or taking back an asked adoption starts no look: it was never in force, so nothing used it through it.
 *
 * Not here (later slices): a typed migration blocker (a withdrawal never sets the version aside or removes it, so no task needs one yet), recording which task applied a practice, and setting a withdrawn
 * tool version aside in the catalog.
 */
export const ADOPTION_STATUSES = ["requested", "active", "declined", "withdrawn"] as const;
export type AdoptionStatus = (typeof ADOPTION_STATUSES)[number];

/** Where an adopted tool version stands in the catalog now (`live` is the only one in force); a practice is always `live` while its adoption is active. */
export type ToolStanding = "live" | "revoked" | "set-aside" | "gone" | "unavailable";
export type AdoptionTarget = { readonly kind: "practice" } | { readonly kind: "tool"; readonly name: string; readonly version: string };
export interface Report {
  readonly n: number;
  /** The adoption's revision this report produced: a replayed command finds its own report by it. */
  readonly revision: number;
  readonly at: string;
  readonly by: string;
  readonly metrics: Readonly<Partial<Record<Metric, number>>>;
  /** Per metric: how much better (positive) or worse (negative) than the pinned baseline, in percent of it. */
  readonly betterPct: Readonly<Partial<Record<Metric, number>>>;
  readonly regressed: readonly Metric[];
  readonly note?: string;
}
export interface AdoptionBody {
  readonly projectId: string;
  readonly experimentId: string;
  /** The experiment's seal when the adoption was asked for: the pinned criteria it was judged on. */
  readonly criteriaDigest: string;
  readonly target: AdoptionTarget;
  /** The tool version's digest as the reviewer found it in the catalog (tools only). */
  readonly targetDigest?: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly status: AdoptionStatus;
  readonly approvedBy?: string;
  /** The reviewer's words. */
  readonly review?: string;
  /** The grant the reviewer already held: `owner`, `meeting.manage`, and `toolbox.manage` for a tool. */
  readonly grantBasis?: readonly string[];
  readonly reports: readonly Report[];
  readonly reportCount: number;
  readonly withdrawnWhy?: "regression" | "decision";
  readonly withdrawnBy?: string;
  readonly history: readonly { readonly at: string; readonly by: string; readonly to: AdoptionStatus; readonly cause?: string }[];
}

/** `listed`: the adoptions a project lists (open and the newest ended); `open`: the most open (asked or in force) at once in a project; `waiting`: the most of one asker's requests waiting for a review in a project. */
export const ADOPTION_LIMITS = { text: 600, reports: 20, history: 12, page: 100, listed: 300, open: 300, waiting: 5, retries: 8, value: 1e9, name: 120, version: 60 } as const;
const ADOPTION_ID = /^adp-[a-z2-7]{20}$/;
const EXPERIMENT_ID = /^exp-[a-z2-7]{20}$/;
const TOOL_NAME = /^[a-z0-9_][a-z0-9_.-]{0,119}$/;
const TOOL_VERSION = /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-[0-9a-z][0-9a-z.-]{0,30})?$/;
interface IndexBody {
  readonly ids: readonly string[];
  /** Target key to the one open (asked or in force) adoption of it. */
  readonly open: Readonly<Record<string, string>>;
  /** Asked adoptions waiting for a review: ID to its asker (retention slice; absent in an index written before it, then rebuilt from the records). */
  readonly waiting?: Readonly<Record<string, string>>;
  /** How many ended adoptions have left the list (kept, readable by ID). */
  readonly archived?: number;
}
interface Index { readonly ids: readonly string[]; readonly open: Readonly<Record<string, string>>; readonly waiting: Readonly<Record<string, string>>; readonly archived: number; readonly revision: number }
const OPEN: readonly AdoptionStatus[] = ["requested", "active"];

/** One open adoption per key: a practice per experiment, a tool version per project (whichever experiment asks). */
export const targetKey = (experimentId: string, t: AdoptionTarget): string => (t.kind === "practice" ? `practice:${experimentId}` : `tool:${t.name}@${t.version}`);

export interface AdoptionOptions extends RunnerOptions {
  /**
   * The catalog: `get` finds a tool version as the reviewer sees it; `standingOf` says whether it is revoked or set aside now (asked at approval and by every `inForce` of a tool). Without it no tool is
   * adopted and no tool adoption is answered as in force (fail closed); practices still are.
   */
  readonly tools?: AdoptionCatalog;
  /** What the look at affected work after a withdrawal needs (the affected-work slice). Absent: the look is still recorded at the withdrawal, and nothing carries it on here. */
  readonly looks?: AdoptionLookPorts;
}
export type AdoptionCatalog = Pick<CatalogService, "get" | "standingOf">;

export class AdoptionService {
  readonly #runner: CommandRunner;
  readonly #tools: AdoptionCatalog | undefined;
  readonly #looks: AffectedWorkLook;

  private constructor(runner: CommandRunner, tools: AdoptionCatalog | undefined, looks: AdoptionLookPorts | undefined) { this.#runner = runner; this.#tools = tools; this.#looks = new AffectedWorkLook(runner, looks); }

  static withEpoch(storage: ControllerStorage, epoch: number, options: AdoptionOptions = {}): AdoptionService {
    const { tools, looks, ...rest } = options;
    return new AdoptionService(new CommandRunner(storage, epoch, rest), tools, looks);
  }

  /** Asks to adopt what an `improved` experiment tried (whoever may read the experiment). Nothing is in force until a reviewer approves it. */
  async request(by: Principal, command: NoActor & { experimentId: string; target: unknown; reason: string }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "experimentId", "target", "reason"]);
    const experimentId = typeof command.experimentId === "string" && EXPERIMENT_ID.test(command.experimentId) ? command.experimentId : invalid("experimentId", "is not an experiment ID");
    const target = this.#target(command.target);
    const reason = plain(command.reason, "reason", ADOPTION_LIMITS.text);
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("adp", scoped);
    const result = await this.#retrying(() => this.#runner.command("adoption.request", { commandId: scoped, actor: by.id }, async () => ({
      payload: { experimentId, target: target as unknown as JsonObject, reason },
      build: async () => {
        const exp = await this.#experiment(experimentId);
        if (exp === undefined || !this.#mayReadExperiment(by, exp)) throw new DomainError("forbidden", `${by.id} may not ask to adopt that experiment`);
        this.#judgedImproved(experimentId, exp);
        const index = await this.#index(exp.projectId);
        const key = targetKey(experimentId, target);
        if (index.open[key] !== undefined) throw new DomainError("invalid_command", `${key} already has an open adoption (${index.open[key]}); it is decided or withdrawn first`, { field: "target" });
        if (waitingOf(index.waiting, by.id) >= ADOPTION_LIMITS.waiting) throw new DomainError("unavailable", `you already have ${ADOPTION_LIMITS.waiting} adoption requests waiting for a review in this project, the most; one is decided or taken back first`);
        if (Object.keys(index.open).length >= ADOPTION_LIMITS.open) throw new DomainError("unavailable", `${ADOPTION_LIMITS.open} adoptions are open (asked or in force) in this project, the most; one is decided or withdrawn first`);
        const openIds = new Set(Object.values(index.open));
        const kept = keptWindow(index.ids, (x) => openIds.has(x), ADOPTION_LIMITS.listed, id);
        if (kept === undefined) throw new DomainError("unavailable", `${ADOPTION_LIMITS.listed} adoptions are listed in this project and all are open; one is decided or withdrawn first`);
        const nowIso = this.#runner.now();
        const body: AdoptionBody = { projectId: exp.projectId, experimentId, criteriaDigest: exp.criteriaDigest!, target, requestedBy: by.id, reason, status: "requested", reports: [], reportCount: 0, history: [{ at: nowIso, by: by.id, to: "requested" }] };
        const ref: AggregateRef = { kind: "adoption", id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }, this.#indexChange(exp.projectId, index, { ids: kept.ids, open: { ...index.open, [key]: id }, waiting: { ...index.waiting, [id]: by.id }, archived: index.archived + kept.archived.length })], detail: { projectId: exp.projectId, experimentId } };
      },
    })));
    return { id: result.id, replayed: result.replayed };
  }

  /**
   * Approves an asked adoption, in the reviewer's words: the owner, or a manager of the project's meetings who is neither the experiment's proposer nor the asker. A tool also needs the reviewer's own
   * `toolbox.manage` for the project and a shared, published, unrevoked version the reviewer can read and did not register or write. Nothing is published or granted.
   */
  async approve(by: Principal, command: NoActor & { adoptionId: string; expectedRevision: number; review: string }): Promise<{ revision: number }> {
    onlyKnown(command, ["commandId", "adoptionId", "expectedRevision", "review"]);
    const id = this.#id(command.adoptionId);
    const expected = checkRevision(command.expectedRevision);
    const review = plain(command.review, "review", ADOPTION_LIMITS.text);
    const result = await this.#retrying(() => this.#runner.command("adoption.approve", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { adoptionId: id, expectedRevision: expected, review },
      build: async () => {
        const got = await this.#get(id);
        const exp = got === undefined ? undefined : await this.#experiment(got.body.experimentId);
        if (got === undefined || exp === undefined || !this.#independent(by, got.body, exp)) throw new DomainError("forbidden", `${by.id} may not approve that adoption: the reviewer is the owner or a manager of the project's meetings who neither proposed the experiment nor asked for the adoption`);
        if (got.found.revision !== expected) throw new DomainError("stale_revision", `adoption ${id} is at revision ${got.found.revision}, not ${expected}`, { currentRevision: got.found.revision });
        const b = got.body;
        if (b.status !== "requested") throw new DomainError("invalid_command", `adoption ${id} is ${b.status}; only an asked adoption is approved`, { field: "adoptionId" });
        this.#judgedImproved(b.experimentId, exp);
        if (exp.criteriaDigest !== b.criteriaDigest) throw new DomainError("integrity", `adoption ${id}: the experiment's criteria are not the ones it was asked on`);
        const grantBasis: string[] = by.kind === "owner" ? ["owner"] : ["meeting.manage"];
        let targetDigest: string | undefined;
        if (b.target.kind === "tool") {
          if (by.kind !== "owner") {
            if (!allows(by, "toolbox.manage", b.projectId)) throw new DomainError("forbidden", `${by.id} may not approve adopting a tool: that needs toolbox.manage already held for this project (an adoption grants nothing)`);
            grantBasis.push("toolbox.manage");
          }
          targetDigest = await this.#toolDigest(by, b.target);
        }
        const nowIso = this.#runner.now();
        const index = await this.#index(b.projectId);
        const key = targetKey(b.experimentId, b.target);
        if (index.open[key] !== id) throw new DomainError("integrity", `adoption ${id} is not the open adoption of ${key}`);
        const next: AdoptionBody = { ...b, status: "active", approvedBy: by.id, review, grantBasis, ...(targetDigest === undefined ? {} : { targetDigest }), history: this.#history(b, nowIso, by.id, "active") };
        // Approved, it no longer waits for a review, so it leaves its asker's waiting count in the same write (it stays open).
        const { [id]: _w, ...waiting } = index.waiting;
        void _w;
        return { ref: { kind: "adoption", id }, creates: false, changes: [{ type: "update", ref: { kind: "adoption", id }, expectedRevision: got.found.revision, body: clean(next) }, this.#indexChange(b.projectId, index, { ...index, waiting })], detail: { projectId: b.projectId } };
      },
    })));
    return { revision: result.revision };
  }

  /** Declines an asked adoption with a reason (a reviewer who could approve it, or its asker taking it back). The target is free for a new request; the adoption is kept and stays listed until newer ones move it out (archived). */
  async decline(by: Principal, command: NoActor & { adoptionId: string; expectedRevision: number; reason: string }): Promise<{ revision: number }> {
    return this.#close(by, command, "adoption.decline", "requested", "declined");
  }

  /** Withdraws an adoption in force with a reason (the owner, a manager of the project's meetings, or its asker). Future use stops; nothing is deleted or undone. */
  async withdraw(by: Principal, command: NoActor & { adoptionId: string; expectedRevision: number; reason: string }): Promise<{ revision: number }> {
    const out = await this.#close(by, command, "adoption.withdraw", "active", "withdrawn");
    await this.#lookNow(this.#id(command.adoptionId));
    return out;
  }

  /**
   * Reports what an adoption in force does now (its asker while still allowed to propose, a manager of the project's meetings, or the owner): exactly the experiment's pinned metrics. A metric worse than
   * the pinned baseline by more than the pinned `maxRegressionPct` is a regression, and the adoption is withdrawn in the same write.
   */
  async monitor(by: Principal, command: NoActor & { adoptionId: string; metrics: Record<string, number>; note?: string }): Promise<{ report: number; status: AdoptionStatus; regressed: Metric[] }> {
    onlyKnown(command, ["commandId", "adoptionId", "metrics", "note"]);
    const id = this.#id(command.adoptionId);
    const metrics = this.#metrics(command.metrics);
    const note = command.note === undefined ? undefined : plain(command.note, "note", ADOPTION_LIMITS.text);
    const result = await this.#retrying(() => this.#runner.command("adoption.monitor", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: clean({ adoptionId: id, metrics, note }),
      build: async () => {
        const got = await this.#get(id);
        if (got === undefined || !this.#mayMonitor(by, got.body)) throw new DomainError("forbidden", `${by.id} may not report on that adoption`);
        const b = got.body;
        if (b.status !== "active") throw new DomainError("invalid_command", `adoption ${id} is ${b.status}; only an adoption in force is monitored`, { field: "adoptionId" });
        const exp = await this.#experiment(b.experimentId);
        const criteria = exp?.criteria;
        if (exp === undefined || criteria === undefined || exp.criteriaDigest !== b.criteriaDigest || sealOf(criteria) !== b.criteriaDigest) throw new DomainError("integrity", `adoption ${id}: the experiment's pinned criteria no longer match the ones it was adopted on`);
        const want = METRICS.filter((m) => criteria.baselineMetrics[m] !== undefined);
        if (Object.keys(metrics).length !== want.length || want.some((m) => metrics[m] === undefined)) invalid("metrics", `must report exactly the experiment's pinned metrics: ${want.join(", ")}`);
        const better: Partial<Record<Metric, number>> = {};
        for (const m of want) better[m] = betterPct(m, criteria.baselineMetrics[m]!, metrics[m]!);
        const regressed = want.filter((m) => better[m]! < -criteria.maxRegressionPct);
        const nowIso = this.#runner.now();
        const n = b.reportCount + 1;
        const report: Report = { n, revision: got.found.revision + 1, at: nowIso, by: by.id, metrics, betterPct: better, regressed, ...(note === undefined ? {} : { note }) };
        const out = regressed.length > 0;
        const next: AdoptionBody = { ...b, reports: [...b.reports, report].slice(-ADOPTION_LIMITS.reports), reportCount: n,
          ...(out ? { status: "withdrawn" as const, withdrawnWhy: "regression" as const, withdrawnBy: by.id, history: this.#history(b, nowIso, by.id, "withdrawn", `regression: ${regressed.join(", ")}`) } : {}) };
        const changes: Change[] = [{ type: "update", ref: { kind: "adoption", id }, expectedRevision: got.found.revision, body: clean(next) }];
        if (out) changes.push(await this.#release(b, id), ...(await this.#lookStart(b, id, "regression")));
        return { ref: { kind: "adoption", id }, creates: false, changes, detail: { projectId: b.projectId, report: n, regressed: regressed.length } };
      },
    })));
    // The report this command wrote (the first time or on a replay) is the one at the revision it produced; the status is the adoption's now.
    const after = await this.#get(id);
    // A regression withdrew it (now or on the original of a repeat): its look at affected work is carried on.
    if (after?.body.status === "withdrawn") await this.#lookNow(id);
    const mine = after?.body.reports.find((r) => r.revision === result.revision);
    if (after === undefined || (mine === undefined && !result.replayed)) throw new DomainError("integrity", `adoption ${id}: the report recorded by this command is not found at revision ${result.revision}`);
    // A repeat of a report older than the kept ones (the last ADOPTION_LIMITS.reports) is answered with report 0: it was recorded, and is no longer kept.
    return { report: mine?.n ?? 0, status: after.body.status, regressed: [...(mine?.regressed ?? [])] };
  }

  /**
   * The adoption of a target now in force in a project, if any: what a later use consults. A practice is named with its experiment; a tool version is one target in the project whichever experiment
   * adopted it (`experimentId` is then ignored). Whoever may read the project's adoptions; anyone else, or a target with none in force, gets `undefined`.
   * A tool adoption approved earlier is not in force while the catalog no longer offers that exact version: revoked, set aside (deprecated or rolled back past), gone, or with another digest. Nothing is
   * written by asking: the adoption stays `active` (a manager withdraws it; a set-aside version is in force again once the owner rolls back to it), and `standing` tells its readers why it is not used.
   */
  async inForce(viewer: Principal, query: { projectId: string; experimentId?: string; target: unknown }): Promise<{ adoptionId: string; experimentId: string; revision: number; targetDigest?: string } | undefined> {
    const projectId = checkProjectId(query.projectId);
    const target = this.#target(query.target);
    const experimentId = target.kind === "tool" ? "" : typeof query.experimentId === "string" && EXPERIMENT_ID.test(query.experimentId) ? query.experimentId : invalid("experimentId", "is not an experiment ID");
    if (!this.#mayRead(viewer, projectId)) return undefined;
    const open = (await this.#index(projectId, false)).open[targetKey(experimentId, target)];
    const found = open === undefined ? undefined : await this.#runner.get("adoption", open);
    const b = found?.body as unknown as AdoptionBody | undefined;
    if (found === undefined || b === undefined || b.status !== "active" || b.projectId !== projectId || targetKey(b.experimentId, b.target) !== targetKey(experimentId, target)) return undefined;
    // A tool adoption is in force only while the catalog still offers the exact version it approved: not revoked, not set aside, the same digest (fail closed without a catalog).
    if (b.target.kind === "tool" && (await this.#toolStanding(b.target, b.targetDigest)) !== "live") return undefined;
    return { adoptionId: open!, experimentId: b.experimentId, revision: found.revision, ...(b.targetDigest === undefined ? {} : { targetDigest: b.targetDigest }) };
  }

  /**
   * Why an adoption in force is or is not used now (card B05): `live` for an active practice, or an active tool whose exact version the catalog still offers; otherwise the tool's standing (`revoked`,
   * `set-aside`, `gone`, `unavailable`). An adoption that is not active, or one the viewer may not read, answers `undefined` (the same as an ID that does not exist).
   */
  async standing(viewer: Principal, adoptionId: string): Promise<ToolStanding | undefined> {
    const got = await this.get(viewer, adoptionId);
    if (got === undefined || got.status !== "active") return undefined;
    return got.target.kind === "practice" ? "live" : this.#toolStanding(got.target, got.targetDigest);
  }

  /**
   * The look at the work that used a withdrawn adoption (the affected-work slice): the tasks that ran exactly the withdrawn tool version, what each was when first seen, how many runs were read and
   * whether the look is done. The same readers as `get`; an adoption with no look (not withdrawn, or withdrawn before looks existed), one the viewer may not read and an unknown ID all answer `undefined`.
   */
  async affected(viewer: Principal, adoptionId: string): Promise<(LookBody & { revision: number }) | undefined> {
    const got = await this.get(viewer, adoptionId);
    if (got === undefined) return undefined;
    const look = await this.#looks.read(got.id);
    return look === undefined ? undefined : { ...look.body, revision: look.revision };
  }

  /**
   * Carries one withdrawn adoption's look on (the controller's own call after a withdrawal, and the tick's): a few pages of the run records, then the owner's notice once it is done. Not an API operation.
   */
  async lookAtAffected(adoptionId: string, pages?: number): Promise<LookBody | undefined> { return this.#looks.run(this.#id(adoptionId), pages); }

  /** The dispatcher's tick: carries on looks that were cut short or interrupted (a bounded number per tick). Writes nothing when none is pending. */
  async sweepAffected(): Promise<{ looked: number; failed: number }> { return this.#looks.sweep(); }

  /** One adoption: the owner, a reader or manager of the project's meetings, or its asker. Anyone else gets `undefined`. */
  async get(viewer: Principal, adoptionId: string): Promise<View<AdoptionBody> | undefined> {
    const found = typeof adoptionId === "string" && ADOPTION_ID.test(adoptionId) ? await this.#runner.get("adoption", adoptionId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as AdoptionBody;
    return this.#mayRead(viewer, body.projectId) || (body.requestedBy === viewer.id && inTaskScope(viewer, body.projectId)) ? view<AdoptionBody>(found) : undefined;
  }

  /** The adoptions of a project, oldest first, paged (whoever may read them). `status` keeps one status. */
  async list(viewer: Principal, projectId: string, page: { afterId?: string; limit?: number; status?: string } = {}): Promise<{ items: View<AdoptionBody>[]; next?: string; archived?: number } | undefined> {
    const project = checkProjectId(projectId);
    if (!this.#mayRead(viewer, project)) return undefined;
    const limit = page.limit === undefined ? 20 : whole(page.limit, "limit", 1, ADOPTION_LIMITS.page);
    const status = page.status === undefined ? undefined : ((ADOPTION_STATUSES as readonly string[]).includes(page.status) ? page.status : invalid("status", `must be one of ${ADOPTION_STATUSES.join(", ")}`));
    const index = await this.#index(project, false);
    const start = page.afterId === undefined ? 0 : index.ids.indexOf(page.afterId) + 1;
    if (page.afterId !== undefined && start === 0) invalid("afterId", "is not in the list");
    const items: View<AdoptionBody>[] = [];
    let pos = start;
    for (; pos < index.ids.length && items.length < limit; pos++) {
      const found = await this.#runner.get("adoption", index.ids[pos]!);
      if (found !== undefined && (status === undefined || (found.body as unknown as AdoptionBody).status === status)) items.push(view<AdoptionBody>(found));
    }
    return { items, ...(pos < index.ids.length ? { next: index.ids[pos - 1]! } : {}), ...(index.archived > 0 ? { archived: index.archived } : {}) };
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  async #close(by: Principal, command: NoActor & { adoptionId: string; expectedRevision: number; reason: string }, op: string, from: AdoptionStatus, to: AdoptionStatus): Promise<{ revision: number }> {
    onlyKnown(command, ["commandId", "adoptionId", "expectedRevision", "reason"]);
    const id = this.#id(command.adoptionId);
    const expected = checkRevision(command.expectedRevision);
    const reason = plain(command.reason, "reason", ADOPTION_LIMITS.text);
    const result = await this.#retrying(() => this.#runner.command(op, { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { adoptionId: id, expectedRevision: expected, reason },
      build: async () => {
        const got = await this.#get(id);
        const exp = got === undefined ? undefined : await this.#experiment(got.body.experimentId);
        const asker = got !== undefined && got.body.requestedBy === by.id && inTaskScope(by, got.body.projectId);
        // Declining is a reviewer's call (or the asker taking it back); withdrawing narrows what is in force, so any manager of the project's meetings may do it.
        const may = got !== undefined && exp !== undefined && (asker || (to === "declined" ? this.#independent(by, got.body, exp) : this.#isManager(by, got.body.projectId)));
        if (!may) throw new DomainError("forbidden", `${by.id} may not ${to === "declined" ? "decline" : "withdraw"} that adoption`);
        if (got.found.revision !== expected) throw new DomainError("stale_revision", `adoption ${id} is at revision ${got.found.revision}, not ${expected}`, { currentRevision: got.found.revision });
        const b = got.body;
        if (b.status !== from) throw new DomainError("invalid_command", `adoption ${id} is ${b.status}; only ${from === "requested" ? "an asked" : "an in-force"} adoption is ${to}`, { field: "adoptionId" });
        const nowIso = this.#runner.now();
        const next: AdoptionBody = { ...b, status: to, ...(to === "withdrawn" ? { withdrawnWhy: "decision" as const, withdrawnBy: by.id } : {}), history: this.#history(b, nowIso, by.id, to, reason) };
        const look = to === "withdrawn" ? await this.#lookStart(b, id, "decision") : [];
        return { ref: { kind: "adoption", id }, creates: false, changes: [{ type: "update", ref: { kind: "adoption", id }, expectedRevision: got.found.revision, body: clean(next) }, await this.#release(b, id), ...look], detail: { projectId: b.projectId } };
      },
    })));
    return { revision: result.revision };
  }

  /** The index change that frees the target of an adoption that is no longer open (in the same write as its status). */
  async #release(b: AdoptionBody, id: string): Promise<Change> {
    const index = await this.#index(b.projectId);
    const key = targetKey(b.experimentId, b.target);
    if (index.open[key] !== id) throw new DomainError("integrity", `adoption ${id} is not the open adoption of ${key}`);
    const { [key]: _gone, ...open } = index.open;
    const { [id]: _waited, ...waiting } = index.waiting;
    void _gone; void _waited;
    return this.#indexChange(b.projectId, index, { ...index, open, waiting });
  }

  /** The changes that start the look at affected work, in the withdrawal's own write. */
  async #lookStart(b: AdoptionBody, id: string, why: "regression" | "decision"): Promise<Change[]> {
    return lookStartChanges(this.#runner, { adoptionId: id, projectId: b.projectId, experimentId: b.experimentId, target: b.target, ...(b.targetDigest === undefined ? {} : { targetDigest: b.targetDigest }), why });
  }

  /** The look right after a withdrawal. Its failure never fails the withdrawal, which is written: the look stays pending and the tick carries it on. */
  async #lookNow(id: string): Promise<void> {
    if (!this.#looks.ready) return;
    try { await this.#looks.run(id); } catch { /* carried on by the tick */ }
  }

  async #toolDigest(by: Principal, t: { name: string; version: string }): Promise<string> {
    const tools = this.#tools ?? (() => { throw new DomainError("unavailable", "the catalog is not available here, so no tool can be adopted"); })();
    let found: Awaited<ReturnType<CatalogService["get"]>>;
    try { found = await tools.get(by, t.name, t.version); } catch (error) {
      if (error instanceof DomainError && (error.code === "not_found" || error.code === "forbidden" || error.code === "invalid_command")) found = undefined; else throw error;
    }
    if (found === undefined || found.version !== t.version || found.name !== t.name) throw new DomainError("not_found", `${t.name} ${t.version} is not a published version you can read; adopting does not publish a tool (that is the toolbox's own review)`);
    // The reviewer's own independence (a right) is checked before anything about where the version stands (state).
    if (by.kind !== "owner" && (found.registeredBy === by.id || found.instructional.author === by.id || found.executable?.author === by.id)) throw new DomainError("forbidden", `${by.id} registered or wrote ${t.name} ${t.version}, so its review of the adoption is not independent`);
    if (found.layer !== "toolbox") throw new DomainError("invalid_command", `${t.name} is not a shared toolbox tool; only a shared version already published through the toolbox's review is adopted (a personal or protected one is not)`, { field: "target" });
    if (found.revoked !== undefined) throw new DomainError("invalid_command", `${t.name} ${t.version} is revoked and is not adopted`, { field: "target" });
    // Where the version stands now: revoked by the entry's own list, or set aside (deprecated, or a rollback went below it), is not adopted; a digest other than the one just read is not that version.
    const standing = await this.#toolStanding(t, found.digest);
    if (standing === "revoked") throw new DomainError("invalid_command", `${t.name} ${t.version} is revoked and is not adopted`, { field: "target" });
    if (standing === "set-aside") throw new DomainError("invalid_command", `${t.name} ${t.version} was set aside in the catalog (deprecated, or rolled back past) and is not adopted; a version still chosen is`, { field: "target" });
    if (standing !== "live") throw new DomainError("not_found", `${t.name} ${t.version} is not a published version you can read; adopting does not publish a tool (that is the toolbox's own review)`);
    return found.digest;
  }

  /**
   * Where an approved (or about to be approved) tool version stands in the catalog now: `live`, `revoked`, `set-aside`, `gone` (not published, dropped, or another digest than `digest`), or `unavailable`
   * (no catalog here). A catalog refusal is `gone`; any other error is passed on, never taken for `live`.
   */
  async #toolStanding(t: { name: string; version: string }, digest: string | undefined): Promise<ToolStanding> {
    if (this.#tools === undefined) return "unavailable";
    let s: Awaited<ReturnType<CatalogService["standingOf"]>>;
    try { s = await this.#tools.standingOf(t.name, t.version); } catch (error) {
      if (error instanceof DomainError && (error.code === "not_found" || error.code === "forbidden" || error.code === "invalid_command")) return "gone"; else throw error;
    }
    if (s === undefined || digest === undefined || s.digest !== digest) return "gone";
    return s.revoked ? "revoked" : s.setAside ? "set-aside" : "live";
  }

  #target(raw: unknown): AdoptionTarget {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid("target", "must be { kind: practice } or { kind: tool, name, version }");
    const t = raw as Record<string, unknown>;
    if (t["kind"] === "practice") { onlyKnown(t, ["kind"]); return { kind: "practice" }; }
    if (t["kind"] !== "tool") return invalid("target.kind", "must be practice or tool");
    onlyKnown(t, ["kind", "name", "version"]);
    const name = typeof t["name"] === "string" && TOOL_NAME.test(t["name"]) ? t["name"] : invalid("target.name", "must be a catalog name (lower case letters, digits, _ . -, at most 120)");
    const version = typeof t["version"] === "string" && t["version"].length <= ADOPTION_LIMITS.version && TOOL_VERSION.test(t["version"]) ? t["version"] : invalid("target.version", "must be an exact version such as 1.2.0");
    return { kind: "tool", name, version };
  }

  #metrics(raw: unknown): Partial<Record<Metric, number>> {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid("metrics", `must be an object of ${METRICS.join(", ")}`);
    onlyKnown(raw, [...METRICS]);
    const out: Partial<Record<Metric, number>> = {};
    for (const m of METRICS) {
      if (!Object.prototype.hasOwnProperty.call(raw, m)) continue;
      const v = (raw as Record<string, unknown>)[m];
      out[m] = typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= ADOPTION_LIMITS.value ? v : invalid(`metrics.${m}`, `must be a number from 0 to ${ADOPTION_LIMITS.value}`);
    }
    return out;
  }

  /** The experiment is concluded `improved` by the controller and its criteria still match their seal. */
  #judgedImproved(experimentId: string, exp: ExperimentBody): void {
    if (exp.status !== "concluded" || exp.result?.verdict !== "improved") throw new DomainError("invalid_command", `experiment ${experimentId} is ${exp.status}${exp.result === undefined ? "" : ` (${exp.result.verdict})`}; only an experiment the controller judged improved is adopted`, { field: "experimentId" });
    if (exp.criteria === undefined || exp.criteriaDigest === undefined || sealOf(exp.criteria) !== exp.criteriaDigest) throw new DomainError("integrity", `experiment ${experimentId}: the pinned criteria no longer match their seal`);
  }

  #history(b: AdoptionBody, at: string, by: string, to: AdoptionStatus, cause?: string): AdoptionBody["history"] {
    return [...b.history, { at, by, to, ...(cause === undefined ? {} : { cause }) }].slice(-ADOPTION_LIMITS.history);
  }

  async #get(id: string): Promise<{ found: { revision: number }; body: AdoptionBody } | undefined> {
    const found = await this.#runner.get("adoption", id);
    return found === undefined ? undefined : { found, body: found.body as unknown as AdoptionBody };
  }

  async #experiment(id: string): Promise<ExperimentBody | undefined> {
    const found = await this.#runner.get("experiment", id);
    return found?.body as unknown as ExperimentBody | undefined;
  }

  #isManager(by: Principal, projectId: string): boolean { return by.kind === "owner" || (inTaskScope(by, projectId) && allows(by, "meeting.manage", projectId)); }
  #mayRead(viewer: Principal, projectId: string): boolean { return inTaskScope(viewer, projectId) && (allows(viewer, "meeting.read", projectId) || allows(viewer, "meeting.manage", projectId)); }
  #mayReadExperiment(by: Principal, exp: ExperimentBody): boolean { return this.#mayRead(by, exp.projectId) || (exp.proposedBy === by.id && inTaskScope(by, exp.projectId)); }
  /** The independent reviewer: the owner, or a manager of the project's meetings who neither proposed the experiment nor asked for the adoption. */
  #independent(by: Principal, b: AdoptionBody, exp: ExperimentBody): boolean {
    return by.kind === "owner" || (by.id !== exp.proposedBy && by.id !== b.requestedBy && inTaskScope(by, b.projectId) && allows(by, "meeting.manage", b.projectId));
  }
  #mayMonitor(by: Principal, b: AdoptionBody): boolean {
    return this.#isManager(by, b.projectId) || (b.requestedBy === by.id && inTaskScope(by, b.projectId) && (allows(by, "meeting.agenda", b.projectId) || allows(by, "meeting.read", b.projectId)));
  }
  #id(value: unknown): string { return typeof value === "string" && ADOPTION_ID.test(value) ? value : invalid("adoptionId", "is not an adoption ID"); }

  /** `writing`: the waiting map is needed (a read that only lists or answers `inForce` skips rebuilding it for an older index). */
  async #index(projectId: string, writing = true): Promise<Index> {
    const found = await this.#runner.get("adoption-index", projectId);
    const b = found?.body as unknown as IndexBody | undefined;
    if (found === undefined || b === undefined) return { ids: [], open: {}, waiting: {}, archived: 0, revision: 0 };
    const archived = typeof b.archived === "number" && Number.isSafeInteger(b.archived) && b.archived >= 0 ? b.archived : 0;
    const isMap = (m: unknown): m is Record<string, string> => m !== null && typeof m === "object" && !Array.isArray(m);
    if (!writing || isMap(b.waiting)) return { ids: b.ids, open: b.open, waiting: isMap(b.waiting) ? b.waiting : {}, archived, revision: found.revision };
    // An index written before the retention slice (or a damaged waiting map): the asked adoptions are found among the open ones (at most ADOPTION_LIMITS.open reads), and written with the next change of the index.
    const waiting: Record<string, string> = {};
    for (const openId of Object.values(b.open).slice(0, ADOPTION_LIMITS.open)) {
      const a = (await this.#runner.get("adoption", openId))?.body as unknown as AdoptionBody | undefined;
      if (a?.status === "requested" && typeof a.requestedBy === "string") waiting[openId] = a.requestedBy;
    }
    return { ids: b.ids, open: b.open, waiting, archived, revision: found.revision };
  }

  #indexChange(projectId: string, index: { revision: number }, next: { ids: readonly string[]; open: Readonly<Record<string, string>>; waiting: Readonly<Record<string, string>>; archived: number }): Change {
    const ref: AggregateRef = { kind: "adoption-index", id: projectId };
    const body = { ids: [...next.ids], open: { ...next.open }, waiting: { ...next.waiting }, archived: next.archived } as unknown as JsonObject;
    return index.revision === 0 ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: index.revision, body };
  }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= ADOPTION_LIMITS.retries) throw error;
      }
    }
  }
}

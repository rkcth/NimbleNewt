import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { clean, invalid, plain, whole } from "../standups/shared.js";

/**
 * Bounded baseline experiments (card B04, first slice): a proposed change to how the team works is tried against a pinned baseline, judged by a pinned evaluator on separate evaluation cases, inside a pinned
 * budget, and the result is kept whichever way it comes out.
 *
 * - **A proposal says what it is.** Problem, affected work, change, effort, running cost, benefit, evaluation and stopping condition, each in the proposer's words, and optionally the lesson (B03) it tests.
 * - **The candidate cannot move its own goalposts.** Only the owner, or a manager of the project's meetings who is not the proposer, pins the criteria: the baseline and the evaluator (a label, a reference and a
 *   SHA-256 digest each), the separate evaluation cases, the baseline's own numbers and the cases it passes, the budget, the least runs and the thresholds. The controller seals them with a digest of its own
 *   and checks it again on every run and at the end; a run must report exactly the pinned metrics and cases, so a candidate cannot add, drop or swap either. Pinned criteria never change; the budget can only
 *   be raised, by the same people, with a reason.
 * - **The verdict is the controller's.** The proposer reports runs (the environment, the cost, the five metrics and each case's result); the controller compares their mean with the baseline and decides
 *   `improved`, `no-change`, `worse` or `inconclusive` (fewer runs than pinned). A result that is not an improvement is saved exactly like one that is, nothing is deleted, and the experiment stays listed.
 * - **Budget exhaustion pauses.** When the runs or the cost reach the pinned budget the experiment is `paused` (reason budget): another run is refused (`unavailable`) and nothing changes until a manager
 *   raises the budget or concludes it. The run that used the last of the budget is kept.
 * - **Savings are counted once.** An improvement's saving on a metric is claimed per (metric, affected work): a second improvement over the same metric and work is recorded as not counted and names the first.
 */
export const EXPERIMENT_STATUSES = ["proposed", "running", "paused", "concluded", "withdrawn"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export const VERDICTS = ["improved", "no-change", "worse", "inconclusive"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** The five measures of the card. Time, rework, cost and maintenance are better lower; adoption is better higher. */
export const METRICS = ["timeToAcceptedSeconds", "reworkCount", "costPerSuccess", "adoptionCount", "maintenanceMinutes"] as const;
export type Metric = (typeof METRICS)[number];
const HIGHER_IS_BETTER: readonly Metric[] = ["adoptionCount"];

export interface Pin { readonly label: string; readonly ref: string; readonly digest: string }
export interface Criteria {
  readonly baseline: Pin;
  readonly evaluator: Pin;
  readonly cases: readonly { readonly id: string; readonly text: string }[];
  /** The cases the baseline passes: the candidate must pass them too. */
  readonly baselinePassing: readonly string[];
  readonly baselineMetrics: Readonly<Partial<Record<Metric, number>>>;
  readonly budget: { readonly maxRuns: number; readonly maxCost: number };
  readonly minRuns: number;
  readonly minImprovementPct: number;
  readonly maxRegressionPct: number;
}
export interface Run {
  readonly n: number;
  readonly at: string;
  readonly by: string;
  readonly environment: string;
  readonly cost: number;
  readonly metrics: Readonly<Partial<Record<Metric, number>>>;
  readonly cases: readonly { readonly id: string; readonly passed: boolean }[];
  readonly note?: string;
}
export interface Saving { readonly metric: Metric; readonly amount: number; readonly counted: boolean; readonly duplicateOf?: string }
export interface Result {
  readonly verdict: Verdict;
  readonly at: string;
  readonly by: string;
  readonly finding: string;
  readonly runsUsed: number;
  readonly candidateMetrics: Readonly<Partial<Record<Metric, number>>>;
  /** Per metric: how much better (positive) or worse (negative) the candidate is than the baseline, in percent of the baseline. */
  readonly betterPct: Readonly<Partial<Record<Metric, number>>>;
  readonly failedCases: readonly string[];
  readonly savings: readonly Saving[];
}
export interface ProposalText { readonly problem: string; readonly affectedWork: string; readonly change: string; readonly effort: string; readonly runningCost: string; readonly benefit: string; readonly evaluation: string; readonly stoppingCondition: string }
const PROPOSAL_FIELDS = ["problem", "affectedWork", "change", "effort", "runningCost", "benefit", "evaluation", "stoppingCondition"] as const;

export interface ExperimentBody {
  readonly projectId: string;
  readonly title: string;
  readonly proposedBy: string;
  readonly proposal: ProposalText;
  /** A short label for the affected work, used to count a saving once. */
  readonly affectedKey: string;
  readonly lessonId?: string;
  readonly status: ExperimentStatus;
  readonly criteria?: Criteria;
  /** The controller's seal of the criteria. */
  readonly criteriaDigest?: string;
  readonly pinnedBy?: string;
  readonly spent: { readonly runs: number; readonly cost: number };
  readonly pausedWhy?: "budget";
  readonly runs: readonly Run[];
  readonly budgetRaises: readonly { readonly at: string; readonly by: string; readonly maxRuns: number; readonly maxCost: number; readonly reason: string }[];
  readonly result?: Result;
  readonly history: readonly { readonly at: string; readonly by: string; readonly to: ExperimentStatus; readonly cause?: string }[];
}

export const EXPERIMENT_LIMITS = { title: 200, text: 600, affectedKey: 60, label: 200, finding: 1000, cases: 20, runs: 50, raises: 10, history: 12, page: 100, listed: 300, retries: 8, cost: 1e9 } as const;
const EXPERIMENT_ID = /^exp-[a-z2-7]{20}$/;
const LESSON_ID = /^lsn-[a-z2-7]{20}$/;
const CASE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DIGEST = /^[0-9a-f]{64}$/;
interface IndexBody { readonly ids: readonly string[]; readonly claims: Readonly<Record<string, string>> }

const canonical = (v: unknown): string => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`);
/** The seal over the pinned criteria. */
export const sealOf = (criteria: Criteria): string => createHash("sha256").update(canonical(criteria)).digest("hex");

/** How much better (positive) the candidate's mean is than the baseline's, in percent of the baseline; a zero baseline moves by 100 either way. */
export function betterPct(metric: Metric, baseline: number, candidate: number): number {
  const gain = HIGHER_IS_BETTER.includes(metric) ? candidate - baseline : baseline - candidate;
  if (baseline === 0) return gain === 0 ? 0 : gain > 0 ? 100 : -100;
  return Math.round((gain / baseline) * 10000) / 100;
}

/** The controller's verdict from the pinned criteria and the reported runs (never the proposer's word). */
export function judge(criteria: Criteria, runs: readonly Run[]): Omit<Result, "at" | "by" | "finding"> & { claims: Metric[] } {
  const candidateMetrics: Partial<Record<Metric, number>> = {};
  const better: Partial<Record<Metric, number>> = {};
  for (const m of METRICS) {
    const base = criteria.baselineMetrics[m];
    if (base === undefined || runs.length === 0) continue;
    const mean = Math.round((runs.reduce((s, r) => s + (r.metrics[m] ?? 0), 0) / runs.length) * 1e6) / 1e6;
    candidateMetrics[m] = mean;
    better[m] = betterPct(m, base, mean);
  }
  const failedCases = criteria.baselinePassing.filter((id) => runs.some((r) => r.cases.some((c) => c.id === id && !c.passed)));
  const values = Object.values(better) as number[];
  const regressed = values.some((v) => v < -criteria.maxRegressionPct) || failedCases.length > 0;
  const gained = values.some((v) => v > 0 && v >= criteria.minImprovementPct);
  const verdict: Verdict = runs.length < criteria.minRuns ? "inconclusive" : regressed ? "worse" : gained ? "improved" : "no-change";
  const claims = verdict === "improved" ? METRICS.filter((m) => !HIGHER_IS_BETTER.includes(m) && (better[m] ?? 0) > 0) : [];
  return { verdict, runsUsed: runs.length, candidateMetrics, betterPct: better, failedCases, savings: [], claims };
}

export interface ExperimentOptions extends RunnerOptions {}

export class ExperimentService {
  readonly #runner: CommandRunner;

  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: ExperimentOptions = {}): ExperimentService {
    return new ExperimentService(new CommandRunner(storage, epoch, options));
  }

  /** Proposes an experiment (needs `meeting.agenda` or `meeting.manage` in the project, or the owner). It changes nothing until a manager pins its criteria. */
  async propose(by: Principal, command: NoActor & { projectId: string; title: string; proposal: ProposalText; affectedKey: string; lessonId?: string }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "projectId", "title", "proposal", "affectedKey", "lessonId"]);
    const projectId = checkProjectId(command.projectId);
    if (!this.#mayPropose(by, projectId) || (await this.#runner.get("project", projectId)) === undefined) throw new DomainError("forbidden", `${by.id} may not propose experiments in that project`);
    const title = plain(command.title, "title", EXPERIMENT_LIMITS.title);
    if (command.proposal === null || typeof command.proposal !== "object" || Array.isArray(command.proposal)) invalid("proposal", `must state ${PROPOSAL_FIELDS.join(", ")}`);
    onlyKnown(command.proposal, [...PROPOSAL_FIELDS]);
    const proposal = Object.fromEntries(PROPOSAL_FIELDS.map((f) => [f, plain((command.proposal as unknown as Record<string, unknown>)[f], `proposal.${f}`, EXPERIMENT_LIMITS.text)])) as unknown as ProposalText;
    const affectedKey = plain(command.affectedKey, "affectedKey", EXPERIMENT_LIMITS.affectedKey).toLowerCase();
    const lessonId = command.lessonId === undefined ? undefined : typeof command.lessonId === "string" && LESSON_ID.test(command.lessonId) ? command.lessonId : invalid("lessonId", "is not a lesson ID");
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("exp", scoped);
    const result = await this.#retrying(() => this.#runner.command("experiment.propose", { commandId: scoped, actor: by.id }, async () => ({
      payload: clean({ projectId, title, proposal: proposal as unknown as JsonObject, affectedKey, lessonId }),
      build: async () => {
        if (lessonId !== undefined) {
          const l = await this.#runner.get("lesson", lessonId);
          const lb = l?.body as unknown as { projectId?: string; proposedBy?: string } | undefined;
          if (l === undefined || lb?.projectId !== projectId || !(by.kind === "owner" || this.#mayRead(by, projectId) || lb.proposedBy === by.id)) invalid("lessonId", "must be a lesson of this project that you may read");
        }
        const index = await this.#index(projectId);
        if (index.ids.length >= EXPERIMENT_LIMITS.listed) throw new DomainError("unavailable", `${EXPERIMENT_LIMITS.listed} experiments are kept in this project, the most; results are never deleted`);
        const nowIso = this.#runner.now();
        const body: ExperimentBody = { projectId, title, proposedBy: by.id, proposal, affectedKey, ...(lessonId === undefined ? {} : { lessonId }), status: "proposed", spent: { runs: 0, cost: 0 }, runs: [], budgetRaises: [], history: [{ at: nowIso, by: by.id, to: "proposed" }] };
        const ref: AggregateRef = { kind: "experiment", id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }, this.#indexChange(projectId, index, [...index.ids, id], index.claims)], detail: { projectId } };
      },
    })));
    return { id: result.id, replayed: result.replayed };
  }

  /**
   * Pins the criteria and starts the experiment (the owner, or a manager of the project's meetings who is not the proposer). Once pinned they never change; the controller seals them.
   */
  async pin(by: Principal, command: NoActor & { experimentId: string; expectedRevision: number; criteria: Record<string, unknown> }): Promise<{ revision: number; seal: string }> {
    onlyKnown(command, ["commandId", "experimentId", "expectedRevision", "criteria"]);
    const id = this.#id(command.experimentId);
    const expected = checkRevision(command.expectedRevision);
    const criteria = this.#criteria(command.criteria);
    const seal = sealOf(criteria);
    const result = await this.#retrying(() => this.#runner.command("experiment.pin", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { experimentId: id, expectedRevision: expected, seal },
      build: async () => {
        const got = await this.#get(id);
        if (got === undefined || !this.#mayJudge(by, got.body)) throw new DomainError("forbidden", `${by.id} may not pin the criteria of that experiment: the proposer cannot set its own criteria`);
        if (got.found.revision !== expected) throw new DomainError("stale_revision", `experiment ${id} is at revision ${got.found.revision}, not ${expected}`, { currentRevision: got.found.revision });
        if (got.body.status !== "proposed") throw new DomainError("invalid_command", `experiment ${id} is ${got.body.status}; criteria are pinned once, when it is proposed`, { field: "experimentId" });
        const nowIso = this.#runner.now();
        const next: ExperimentBody = { ...got.body, status: "running", criteria, criteriaDigest: seal, pinnedBy: by.id, history: this.#history(got.body, nowIso, by.id, "running") };
        return { ref: { kind: "experiment", id }, creates: false, changes: [{ type: "update", ref: { kind: "experiment", id }, expectedRevision: got.found.revision, body: clean(next) }], detail: { projectId: got.body.projectId } };
      },
    })));
    return { revision: result.revision, seal };
  }

  /**
   * Records one run (the proposer, or a judge). It names a disposable environment, the cost, exactly the pinned metrics and exactly the pinned cases. A run that uses up the budget is kept and pauses the
   * experiment; once paused or concluded another run is refused.
   */
  async recordRun(by: Principal, command: NoActor & { experimentId: string; environment: { ref: string; disposable: boolean }; cost: number; metrics: Record<string, number>; cases: { id: string; passed: boolean }[]; note?: string }): Promise<{ run: number; status: ExperimentStatus }> {
    onlyKnown(command, ["commandId", "experimentId", "environment", "cost", "metrics", "cases", "note"]);
    const id = this.#id(command.experimentId);
    if (command.environment === null || typeof command.environment !== "object") invalid("environment", "must name the disposable environment the run used");
    onlyKnown(command.environment, ["ref", "disposable"]);
    if (command.environment.disposable !== true) invalid("environment", "a candidate runs only in a disposable environment (disposable must be true)");
    const environment = plain(command.environment.ref, "environment.ref", EXPERIMENT_LIMITS.label);
    const cost = this.#number(command.cost, "cost", EXPERIMENT_LIMITS.cost);
    const note = command.note === undefined ? undefined : plain(command.note, "note", EXPERIMENT_LIMITS.text);
    const metrics = this.#metrics(command.metrics, "metrics");
    if (!Array.isArray(command.cases) || command.cases.length > EXPERIMENT_LIMITS.cases) invalid("cases", `must list at most ${EXPERIMENT_LIMITS.cases} case results`);
    const cases = command.cases.map((c, i) => {
      if (c === null || typeof c !== "object") return invalid(`cases[${i}]`, "must be an object with id and passed");
      onlyKnown(c, ["id", "passed"]);
      if (typeof c.id !== "string" || typeof c.passed !== "boolean") return invalid(`cases[${i}]`, "needs a case id and passed true or false");
      return { id: c.id, passed: c.passed };
    });
    let status: ExperimentStatus = "running";
    let run = 0;
    await this.#retrying(() => this.#runner.command("experiment.run", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: clean({ experimentId: id, environment, cost, metrics, cases, note }),
      build: async () => {
        const got = await this.#get(id);
        if (got === undefined || !this.#mayRun(by, got.body)) throw new DomainError("forbidden", `${by.id} may not report runs for that experiment`);
        const b = got.body;
        if (b.status === "paused") throw new DomainError("unavailable", `experiment ${id} is paused: its budget (${b.criteria!.budget.maxRuns} runs, cost ${b.criteria!.budget.maxCost}) is used up; a manager can raise it or conclude the experiment`);
        if (b.status !== "running" || b.criteria === undefined) throw new DomainError("invalid_command", `experiment ${id} is ${b.status}; runs are reported while it is running`, { field: "experimentId" });
        if (sealOf(b.criteria) !== b.criteriaDigest) throw new DomainError("integrity", `experiment ${id}: the pinned criteria no longer match their seal`);
        const wantMetrics = METRICS.filter((m) => b.criteria!.baselineMetrics[m] !== undefined);
        if (Object.keys(metrics).length !== wantMetrics.length || wantMetrics.some((m) => metrics[m] === undefined)) invalid("metrics", `must report exactly the pinned metrics: ${wantMetrics.join(", ")}`);
        const wantCases = b.criteria.cases.map((c) => c.id).sort();
        const gotCases = cases.map((c) => c.id).sort();
        if (wantCases.length !== gotCases.length || wantCases.some((c, i) => c !== gotCases[i])) invalid("cases", `must report exactly the pinned evaluation cases once each: ${wantCases.join(", ")}`);
        const nowIso = this.#runner.now();
        run = b.runs.length + 1;
        const spent = { runs: b.spent.runs + 1, cost: Math.round((b.spent.cost + cost) * 1e6) / 1e6 };
        const out = spent.runs >= b.criteria.budget.maxRuns || spent.cost >= b.criteria.budget.maxCost;
        status = out ? "paused" : "running";
        const next: ExperimentBody = { ...b, spent, runs: [...b.runs, { n: run, at: nowIso, by: by.id, environment, cost, metrics, cases, ...(note === undefined ? {} : { note }) }], status, ...(out ? { pausedWhy: "budget" as const, history: this.#history(b, nowIso, by.id, "paused", "budget used up") } : {}) };
        return { ref: { kind: "experiment", id }, creates: false, changes: [{ type: "update", ref: { kind: "experiment", id }, expectedRevision: got.found.revision, body: clean(next) }], detail: { projectId: b.projectId, run } };
      },
    })));
    const after = await this.#get(id);
    if (after !== undefined) { run = run || after.body.runs.length; status = after.body.status; }
    return { run, status };
  }

  /** Raises the budget (never lowers it) with a reason; a paused experiment runs again. The owner or a manager who is not the proposer. */
  async raiseBudget(by: Principal, command: NoActor & { experimentId: string; expectedRevision: number; maxRuns: number; maxCost: number; reason: string }): Promise<{ revision: number }> {
    onlyKnown(command, ["commandId", "experimentId", "expectedRevision", "maxRuns", "maxCost", "reason"]);
    const id = this.#id(command.experimentId);
    const expected = checkRevision(command.expectedRevision);
    const maxRuns = whole(command.maxRuns, "maxRuns", 1, EXPERIMENT_LIMITS.runs);
    const maxCost = this.#number(command.maxCost, "maxCost", EXPERIMENT_LIMITS.cost);
    const reason = plain(command.reason, "reason", EXPERIMENT_LIMITS.text);
    const result = await this.#retrying(() => this.#runner.command("experiment.budget", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { experimentId: id, expectedRevision: expected, maxRuns, maxCost, reason },
      build: async () => {
        const got = await this.#get(id);
        if (got === undefined || !this.#mayJudge(by, got.body)) throw new DomainError("forbidden", `${by.id} may not change the budget of that experiment`);
        if (got.found.revision !== expected) throw new DomainError("stale_revision", `experiment ${id} is at revision ${got.found.revision}, not ${expected}`, { currentRevision: got.found.revision });
        const b = got.body;
        if ((b.status !== "running" && b.status !== "paused") || b.criteria === undefined) throw new DomainError("invalid_command", `experiment ${id} is ${b.status}; only a running or paused experiment has a budget to raise`, { field: "experimentId" });
        if (maxRuns < b.criteria.budget.maxRuns || maxCost < b.criteria.budget.maxCost || (maxRuns === b.criteria.budget.maxRuns && maxCost === b.criteria.budget.maxCost)) invalid("maxRuns", `the budget can only be raised (now ${b.criteria.budget.maxRuns} runs, cost ${b.criteria.budget.maxCost})`);
        const nowIso = this.#runner.now();
        // The raised budget is part of the sealed criteria, so the seal is renewed in the same write, by the controller, and the old criteria stay in the history of raises.
        const criteria: Criteria = { ...b.criteria, budget: { maxRuns, maxCost } };
        const out = b.spent.runs >= maxRuns || b.spent.cost >= maxCost;
        const { pausedWhy: _p, ...rest } = b;
        void _p;
        const next: ExperimentBody = { ...rest, criteria, criteriaDigest: sealOf(criteria), status: out ? "paused" : "running", ...(out ? { pausedWhy: "budget" as const } : {}),
          budgetRaises: [...b.budgetRaises, { at: nowIso, by: by.id, maxRuns, maxCost, reason }].slice(-EXPERIMENT_LIMITS.raises),
          history: b.status === "paused" && !out ? this.#history(b, nowIso, by.id, "running", "budget raised") : b.history };
        return { ref: { kind: "experiment", id }, creates: false, changes: [{ type: "update", ref: { kind: "experiment", id }, expectedRevision: got.found.revision, body: clean(next) }], detail: { projectId: b.projectId } };
      },
    })));
    return { revision: result.revision };
  }

  /**
   * Concludes a running or paused experiment (the owner or a manager who is not the proposer) with the finding in words. The verdict is the controller's, from the runs and the pinned criteria; whatever it is,
   * the result is saved. An improvement's savings are counted once per (metric, affected work).
   */
  async conclude(by: Principal, command: NoActor & { experimentId: string; expectedRevision: number; finding: string }): Promise<{ revision: number; verdict: Verdict }> {
    onlyKnown(command, ["commandId", "experimentId", "expectedRevision", "finding"]);
    const id = this.#id(command.experimentId);
    const expected = checkRevision(command.expectedRevision);
    const finding = plain(command.finding, "finding", EXPERIMENT_LIMITS.finding);
    let verdict: Verdict = "inconclusive";
    const result = await this.#retrying(() => this.#runner.command("experiment.conclude", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { experimentId: id, expectedRevision: expected, finding },
      build: async () => {
        const got = await this.#get(id);
        if (got === undefined || !this.#mayJudge(by, got.body)) throw new DomainError("forbidden", `${by.id} may not conclude that experiment: the proposer cannot judge its own result`);
        if (got.found.revision !== expected) throw new DomainError("stale_revision", `experiment ${id} is at revision ${got.found.revision}, not ${expected}`, { currentRevision: got.found.revision });
        const b = got.body;
        if ((b.status !== "running" && b.status !== "paused") || b.criteria === undefined) throw new DomainError("invalid_command", `experiment ${id} is ${b.status}; only a running or paused experiment is concluded`, { field: "experimentId" });
        if (sealOf(b.criteria) !== b.criteriaDigest) throw new DomainError("integrity", `experiment ${id}: the pinned criteria no longer match their seal`);
        const nowIso = this.#runner.now();
        const index = await this.#index(b.projectId);
        const claims = { ...index.claims };
        const judged = judge(b.criteria, b.runs);
        const savings: Saving[] = judged.claims.map((metric) => {
          const key = `${metric}:${b.affectedKey}`;
          const amount = Math.round((b.criteria!.baselineMetrics[metric]! - judged.candidateMetrics[metric]!) * 1e6) / 1e6;
          if (claims[key] === undefined || claims[key] === id) { claims[key] = id; return { metric, amount, counted: true }; }
          return { metric, amount, counted: false, duplicateOf: claims[key]! };
        });
        const { claims: _c, ...part } = judged;
        void _c;
        verdict = judged.verdict;
        const next: ExperimentBody = { ...b, status: "concluded", result: { ...part, at: nowIso, by: by.id, finding, savings }, history: this.#history(b, nowIso, by.id, "concluded", judged.verdict) };
        const changes: Change[] = [{ type: "update", ref: { kind: "experiment", id }, expectedRevision: got.found.revision, body: clean(next) }];
        if (savings.some((s) => s.counted)) changes.push(this.#indexChange(b.projectId, index, index.ids, claims));
        return { ref: { kind: "experiment", id }, creates: false, changes, detail: { projectId: b.projectId, verdict: judged.verdict } };
      },
    })));
    return { revision: result.revision, verdict };
  }

  /** Withdraws an experiment that has not started (the proposer, or the owner or a manager). It stays listed. */
  async withdraw(by: Principal, command: NoActor & { experimentId: string; expectedRevision: number; reason: string }): Promise<{ revision: number }> {
    onlyKnown(command, ["commandId", "experimentId", "expectedRevision", "reason"]);
    const id = this.#id(command.experimentId);
    const expected = checkRevision(command.expectedRevision);
    const reason = plain(command.reason, "reason", EXPERIMENT_LIMITS.text);
    const result = await this.#retrying(() => this.#runner.command("experiment.withdraw", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { experimentId: id, expectedRevision: expected, reason },
      build: async () => {
        const got = await this.#get(id);
        if (got === undefined || !(this.#mayJudge(by, got.body) || (got.body.proposedBy === by.id && inTaskScope(by, got.body.projectId)))) throw new DomainError("forbidden", `${by.id} may not withdraw that experiment`);
        if (got.found.revision !== expected) throw new DomainError("stale_revision", `experiment ${id} is at revision ${got.found.revision}, not ${expected}`, { currentRevision: got.found.revision });
        if (got.body.status !== "proposed") throw new DomainError("invalid_command", `experiment ${id} is ${got.body.status}; only one not yet started is withdrawn (a started one is concluded and its runs kept)`, { field: "experimentId" });
        const next: ExperimentBody = { ...got.body, status: "withdrawn", history: this.#history(got.body, this.#runner.now(), by.id, "withdrawn", reason) };
        return { ref: { kind: "experiment", id }, creates: false, changes: [{ type: "update", ref: { kind: "experiment", id }, expectedRevision: got.found.revision, body: clean(next) }], detail: { projectId: got.body.projectId } };
      },
    })));
    return { revision: result.revision };
  }

  /** One experiment: the owner, a reader or manager of the project's meetings, or its proposer. Anyone else gets `undefined`. */
  async get(viewer: Principal, experimentId: string): Promise<View<ExperimentBody> | undefined> {
    const found = typeof experimentId === "string" && EXPERIMENT_ID.test(experimentId) ? await this.#runner.get("experiment", experimentId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as ExperimentBody;
    return this.#mayRead(viewer, body.projectId) || (body.proposedBy === viewer.id && inTaskScope(viewer, body.projectId)) ? view<ExperimentBody>(found) : undefined;
  }

  /** The experiments of a project, oldest first, paged (whoever may read them). `status` keeps one status. */
  async list(viewer: Principal, projectId: string, page: { afterId?: string; limit?: number; status?: string } = {}): Promise<{ items: View<ExperimentBody>[]; next?: string } | undefined> {
    const project = checkProjectId(projectId);
    if (!this.#mayRead(viewer, project)) return undefined;
    const limit = page.limit === undefined ? 20 : whole(page.limit, "limit", 1, EXPERIMENT_LIMITS.page);
    const status = page.status === undefined ? undefined : ((EXPERIMENT_STATUSES as readonly string[]).includes(page.status) ? page.status : invalid("status", `must be one of ${EXPERIMENT_STATUSES.join(", ")}`));
    const index = await this.#index(project);
    const start = page.afterId === undefined ? 0 : index.ids.indexOf(page.afterId) + 1;
    if (page.afterId !== undefined && start === 0) invalid("afterId", "is not in the list");
    const items: View<ExperimentBody>[] = [];
    let pos = start;
    for (; pos < index.ids.length && items.length < limit; pos++) {
      const found = await this.#runner.get("experiment", index.ids[pos]!);
      if (found !== undefined && (status === undefined || (found.body as unknown as ExperimentBody).status === status)) items.push(view<ExperimentBody>(found));
    }
    return { items, ...(pos < index.ids.length ? { next: index.ids[pos - 1]! } : {}) };
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  #criteria(raw: unknown): Criteria {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid("criteria", "must be an object");
    const c = raw as Record<string, unknown>;
    onlyKnown(c, ["baseline", "evaluator", "cases", "baselinePassing", "baselineMetrics", "budget", "minRuns", "minImprovementPct", "maxRegressionPct"]);
    const pin = (v: unknown, field: string): Pin => {
      if (v === null || typeof v !== "object" || Array.isArray(v)) return invalid(field, "must have label, ref and digest");
      onlyKnown(v, ["label", "ref", "digest"]);
      const p = v as Record<string, unknown>;
      if (typeof p["digest"] !== "string" || !DIGEST.test(p["digest"])) return invalid(`${field}.digest`, "must be a lowercase SHA-256 hex digest");
      return { label: plain(p["label"], `${field}.label`, EXPERIMENT_LIMITS.label), ref: plain(p["ref"], `${field}.ref`, EXPERIMENT_LIMITS.label), digest: p["digest"] };
    };
    if (!Array.isArray(c["cases"]) || c["cases"].length < 1 || c["cases"].length > EXPERIMENT_LIMITS.cases) invalid("cases", `must list 1 to ${EXPERIMENT_LIMITS.cases} evaluation cases`);
    const cases = (c["cases"] as unknown[]).map((v, i) => {
      if (v === null || typeof v !== "object") return invalid(`cases[${i}]`, "must have id and text");
      onlyKnown(v, ["id", "text"]);
      const k = v as Record<string, unknown>;
      if (typeof k["id"] !== "string" || !CASE_ID.test(k["id"])) return invalid(`cases[${i}].id`, "must be lowercase letters, digits and dashes");
      return { id: k["id"], text: plain(k["text"], `cases[${i}].text`, EXPERIMENT_LIMITS.text) };
    });
    if (new Set(cases.map((k) => k.id)).size !== cases.length) invalid("cases", "case IDs must be different");
    const passing = c["baselinePassing"] === undefined ? [] : c["baselinePassing"];
    if (!Array.isArray(passing) || passing.some((p) => typeof p !== "string" || !cases.some((k) => k.id === p))) invalid("baselinePassing", "must list pinned case IDs the baseline passes");
    const baselineMetrics = this.#metrics(c["baselineMetrics"], "baselineMetrics");
    if (Object.keys(baselineMetrics).length < 1) invalid("baselineMetrics", "must pin at least one metric");
    const b = c["budget"];
    if (b === null || typeof b !== "object" || Array.isArray(b)) return invalid("budget", "must have maxRuns and maxCost");
    onlyKnown(b, ["maxRuns", "maxCost"]);
    const budget = { maxRuns: whole((b as Record<string, unknown>)["maxRuns"], "budget.maxRuns", 1, EXPERIMENT_LIMITS.runs), maxCost: this.#number((b as Record<string, unknown>)["maxCost"], "budget.maxCost", EXPERIMENT_LIMITS.cost) };
    const minRuns = c["minRuns"] === undefined ? 1 : whole(c["minRuns"], "minRuns", 1, budget.maxRuns);
    return {
      baseline: pin(c["baseline"], "baseline"), evaluator: pin(c["evaluator"], "evaluator"), cases, baselinePassing: [...new Set(passing as string[])].sort(), baselineMetrics, budget, minRuns,
      minImprovementPct: c["minImprovementPct"] === undefined ? 0 : this.#number(c["minImprovementPct"], "minImprovementPct", 1000),
      maxRegressionPct: c["maxRegressionPct"] === undefined ? 0 : this.#number(c["maxRegressionPct"], "maxRegressionPct", 100),
    };
  }

  #metrics(raw: unknown, field: string): Partial<Record<Metric, number>> {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid(field, `must be an object of ${METRICS.join(", ")}`);
    onlyKnown(raw, [...METRICS]);
    const out: Partial<Record<Metric, number>> = {};
    for (const m of METRICS) { const v = (raw as Record<string, unknown>)[m]; if (v !== undefined) out[m] = this.#number(v, `${field}.${m}`, EXPERIMENT_LIMITS.cost); }
    return out;
  }

  #number(v: unknown, field: string, max: number): number {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : invalid(field, `must be a number from 0 to ${max}`);
  }

  #history(b: ExperimentBody, at: string, by: string, to: ExperimentStatus, cause?: string): ExperimentBody["history"] {
    return [...b.history, { at, by, to, ...(cause === undefined ? {} : { cause }) }].slice(-EXPERIMENT_LIMITS.history);
  }

  async #get(id: string): Promise<{ found: { revision: number }; body: ExperimentBody } | undefined> {
    const found = await this.#runner.get("experiment", id);
    return found === undefined ? undefined : { found, body: found.body as unknown as ExperimentBody };
  }

  #mayPropose(by: Principal, projectId: string): boolean { return inTaskScope(by, projectId) && (allows(by, "meeting.agenda", projectId) || allows(by, "meeting.manage", projectId)); }
  #mayRead(viewer: Principal, projectId: string): boolean { return inTaskScope(viewer, projectId) && (allows(viewer, "meeting.read", projectId) || allows(viewer, "meeting.manage", projectId)); }
  /** Who sets and judges the criteria: the owner, or a manager of the project's meetings who did not propose the experiment. */
  #mayJudge(by: Principal, b: ExperimentBody): boolean { return by.kind === "owner" || (by.id !== b.proposedBy && inTaskScope(by, b.projectId) && allows(by, "meeting.manage", b.projectId)); }
  #mayRun(by: Principal, b: ExperimentBody): boolean { return this.#mayJudge(by, b) || (b.proposedBy === by.id && this.#mayPropose(by, b.projectId)); }
  #id(value: unknown): string { return typeof value === "string" && EXPERIMENT_ID.test(value) ? value : invalid("experimentId", "is not an experiment ID"); }

  async #index(projectId: string): Promise<{ ids: readonly string[]; claims: Readonly<Record<string, string>>; revision: number }> {
    const found = await this.#runner.get("experiment-index", projectId);
    const b = found?.body as unknown as IndexBody | undefined;
    return found === undefined || b === undefined ? { ids: [], claims: {}, revision: 0 } : { ids: b.ids, claims: b.claims, revision: found.revision };
  }

  #indexChange(projectId: string, index: { revision: number }, ids: readonly string[], claims: Readonly<Record<string, string>>): Change {
    const ref: AggregateRef = { kind: "experiment-index", id: projectId };
    const body = { ids: [...ids], claims: { ...claims } } as unknown as JsonObject;
    return index.revision === 0 ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: index.revision, body };
  }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= EXPERIMENT_LIMITS.retries) throw error;
      }
    }
  }
}

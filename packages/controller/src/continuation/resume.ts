import { createHash } from "node:crypto";
import type { BlockerService } from "../domain/blockers.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { DependencyCheck, DependencyService, Observation } from "../dependencies/dependencies.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { ContinuationBody, ContinuationService, RestoreMethod } from "./continuation.js";
import { RESTORE_METHODS } from "./continuation.js";

export type ResumePhase = "collecting" | "verifying" | "reviewing" | "ready" | "blocked" | "executing" | "done" | "cancelled";
const TERMINAL: readonly ResumePhase[] = ["done", "cancelled"];
const LIVE: readonly ResumePhase[] = ["collecting", "verifying", "reviewing", "ready", "blocked", "executing"];

export interface ResumeVerdict { readonly relevant: boolean; readonly rationale: string; /** The status and detail the verdict was given for: a verdict is reused only while the change is still this one. */ readonly digest: string }
export interface DeltaItem { readonly id: string; readonly kind: string; readonly key: string; readonly status: string; readonly detail: string }

/** What a checked resume reads from the rest of the system. Every call must be repeatable. */
export interface ResumePorts {
  /** What the worker sees now for the task's recorded dependencies (by entry ID). Entries it does not report read as `unknown`, never as unchanged. */
  observe(taskId: string): Promise<Readonly<Record<string, Observation>>>;
  /** Names of context the task cannot continue without that is not there (an empty list when it is all present). */
  missingContext(taskId: string, continuation: ContinuationBody & { id: string }): Promise<readonly string[]>;
  /** Earlier effects whose outcome is unknown; they are resolved before work goes on. */
  uncertainEffects(taskId: string, continuation: ContinuationBody & { id: string }): Promise<readonly string[]>;
  /** An independent verdict on whether each change matters to the work, with a reason. May fail; the resume then waits at the review. */
  review(request: { taskId: string; changes: readonly DeltaItem[] }): Promise<Readonly<Record<string, { relevant: boolean; rationale: string }>>>;
}

export interface ResumeCheckBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly phase: ResumePhase;
  /** How many times the inputs changed between review and commit and the check started over. */
  readonly round: number;
  readonly maxRounds: number;
  readonly model: { readonly provider: string; readonly id: string };
  readonly previousModel?: { readonly provider: string; readonly id: string };
  readonly after: "restart" | "model-change" | "continue";
  readonly continuationId?: string;
  /** The revisions that were verified: the continuation and the digest of every dependency's status. A commit is allowed only while these still hold. */
  readonly revisionSet?: { readonly continuationId: string; readonly digest: string; readonly dependencies: number; readonly unverified: boolean };
  /** What changed, permission-filtered by the checker's own rights; nothing of the content itself. */
  readonly delta?: { readonly changed: readonly DeltaItem[]; readonly unchanged: number };
  readonly verdicts: Readonly<Record<string, ResumeVerdict>>;
  readonly blocked?: { readonly type: "missing_context" | "resume_churn" | "effects_uncertain" | "review_failed"; readonly reason: string; readonly blockerId?: string } | undefined;
  /** How the earlier context was brought back, and what that cannot promise. */
  readonly restore?: { readonly method: RestoreMethod; readonly limits: readonly string[] };
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly history: readonly { readonly phase: ResumePhase; readonly at: string; readonly by: string; readonly note: string }[];
}

export const RESUME_LIMITS = { rounds: 3, advances: 10, history: 40, note: 300, limits: 10 } as const;
const KIND = "resume-check";
const ACTIVE = "resume-active";
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const clean = (body: object): JsonObject => JSON.parse(JSON.stringify(body)) as JsonObject;
const short = (value: string): string => redactText(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, RESUME_LIMITS.note);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const checkModel = (v: unknown, field: string): { provider: string; id: string } => {
  if (v === null || typeof v !== "object") return invalid(field, "must be { provider, id }");
  const m = v as Record<string, unknown>;
  if (typeof m["provider"] !== "string" || !MODEL.test(m["provider"]) || typeof m["id"] !== "string" || !MODEL.test(m["id"])) return invalid(field, "must be { provider, id } of plain names");
  return { provider: m["provider"], id: m["id"] };
};

/**
 * Checked resume (card L04): collect, verify, review, commit. A task is not carried on from its stored context just because the context exists. The check collects the latest complete continuation
 * (C03), verifies every recorded dependency against what is true now (the controller's own state, and the worker's observations; a dependency nobody observed reads `unknown`, never "unchanged"), has an
 * independent reviewer give a verdict with a reason for each change, and only then lets the resume commit. The commit looks again: if the continuation or any dependency changed between review and commit, the
 * check starts over (changes already judged and still the same keep their verdict, so nothing unchanged is rebuilt), and after a bounded number of rounds it stops with a `resume_churn` blocker instead of
 * chasing the inputs for ever. Missing critical context opens a `missing_context` blocker; earlier effects of unknown outcome are resolved before work goes on. The delta packet is made from what the checker
 * is allowed to read, so content that was revoked is never carried into it. The way the context came back (native restore, reconstruction or restart) and what it cannot promise are recorded with the result.
 */
export class ResumeCheckService {
  readonly #runner: CommandRunner;
  readonly #continuations: Pick<ContinuationService, "latest" | "resume">;
  readonly #dependencies: Pick<DependencyService, "check">;
  readonly #blockers: Pick<BlockerService, "openBlocker">;
  readonly #ports: ResumePorts;
  readonly #rounds: number;

  private constructor(runner: CommandRunner, deps: { continuations: Pick<ContinuationService, "latest" | "resume">; dependencies: Pick<DependencyService, "check">; blockers: Pick<BlockerService, "openBlocker">; ports: ResumePorts }, rounds: number) {
    this.#runner = runner; this.#continuations = deps.continuations; this.#dependencies = deps.dependencies; this.#blockers = deps.blockers; this.#ports = deps.ports; this.#rounds = rounds;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: { continuations: Pick<ContinuationService, "latest" | "resume">; dependencies: Pick<DependencyService, "check">; blockers: Pick<BlockerService, "openBlocker">; ports: ResumePorts }, options: RunnerOptions & { maxRounds?: number } = {}): ResumeCheckService {
    const rounds = options.maxRounds ?? RESUME_LIMITS.rounds;
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10) throw new RangeError("maxRounds must be a whole number from 1 to 10");
    return new ResumeCheckService(new CommandRunner(storage, epoch, options), deps, rounds);
  }

  // ---- requests ------------------------------------------------------------------------------------------------------------

  /** Begins a checked resume of a task. One at a time per task; the same command again answers where it stands. Returns after one pass. */
  async start(by: Principal, command: NoActor & { taskId: string; model: unknown; previousModel?: unknown; after: "restart" | "model-change" | "continue" }): Promise<View<ResumeCheckBody>> {
    onlyKnown(command, ["commandId", "taskId", "model", "previousModel", "after"]);
    const taskId = checkTaskId(command.taskId);
    const projectId = await this.#authorize(by, taskId);
    if (!["restart", "model-change", "continue"].includes(command.after)) invalid("after", "must be restart, model-change or continue");
    const model = checkModel(command.model, "model");
    const previousModel = command.previousModel === undefined ? undefined : checkModel(command.previousModel, "previousModel");
    const id = derivedId("rck", scopedCommandId(by.id, command.commandId));
    const activeRef: AggregateRef = { kind: ACTIVE, id: derivedId("rck", `active\0${taskId}`) };
    await this.#runner.command("resume.start", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, model: model as unknown as JsonObject, previousModel: (previousModel ?? null) as unknown as JsonObject, after: command.after },
      build: async () => {
        const at = this.#runner.now();
        const active = await this.#runner.get(ACTIVE, activeRef.id);
        const current = (active?.body as unknown as { checkId?: string } | undefined)?.checkId;
        if (current !== undefined && current !== id) {
          const cur = await this.#runner.get(KIND, current);
          if (cur !== undefined && LIVE.includes((cur.body as unknown as ResumeCheckBody).phase)) throw new DomainError("invalid_command", `task ${taskId} already has a resume check in progress`, { field: "taskId" });
        }
        const ref: AggregateRef = { kind: KIND, id };
        const body: ResumeCheckBody = {
          taskId, projectId, phase: "collecting", round: 0, maxRounds: this.#rounds, model, ...(previousModel === undefined ? {} : { previousModel }), after: command.after, verdicts: {},
          requestedBy: by.id, requestedAt: at, history: [{ phase: "collecting", at, by: by.id, note: "resume check started" }],
        };
        const pointer = clean({ checkId: id });
        return {
          ref, creates: true,
          changes: [{ type: "create", ref, body: clean(body) }, active === undefined ? { type: "create", ref: activeRef, body: pointer } : { type: "update", ref: activeRef, expectedRevision: active.revision, body: pointer }],
          detail: { taskId },
        };
      },
    }));
    return this.advance(by, { checkId: id });
  }

  /**
   * Commits: looks once more at the continuation and every dependency. If they are as they were when the check was reviewed, the resume is recorded (`continuation.resume`) with how the context was restored;
   * if anything changed, nothing is committed and the check starts over (or stops as `resume_churn` after its rounds).
   */
  async commit(by: Principal, command: NoActor & { checkId: string; restoredBy?: RestoreMethod; limits?: readonly string[] }): Promise<View<ResumeCheckBody>> {
    onlyKnown(command, ["commandId", "checkId", "restoredBy", "limits"]);
    if (command.restoredBy !== undefined && !RESTORE_METHODS.includes(command.restoredBy)) invalid("restoredBy", "must be native-restore, reconstruction or restart");
    const limits = (command.limits ?? []).map((l) => short(String(l))).slice(0, RESUME_LIMITS.limits);
    const found = await this.#get(by, command.checkId);
    const b = found.body as unknown as ResumeCheckBody;
    if (b.phase === "done" || b.phase === "executing") return this.advance(by, { checkId: command.checkId });
    if (b.phase !== "ready") throw new DomainError("invalid_command", `the resume check is ${b.phase}; it can be committed when it is ready`, { field: "checkId" });
    const now = await this.#verify(by, b);
    if (now.stale !== undefined) {
      // The inputs moved after the review: nothing is committed.
      await this.#restart(by, command.checkId, now.stale);
      return this.advance(by, { checkId: command.checkId });
    }
    const at = this.#runner.now();
    await this.#update(command.checkId, (x) => ({ ...x, phase: "executing", restore: { method: command.restoredBy ?? "reconstruction", limits }, history: this.#push(x, "executing", by.id, `committing; restored by ${command.restoredBy ?? "reconstruction"}`) }), ["ready"]);
    void at;
    return this.advance(by, { checkId: command.checkId, commandId: String(command.commandId) });
  }

  /** Starts a blocked check over from the beginning, once whoever blocked it has dealt with the reason. */
  async retry(by: Principal, command: { checkId: string }): Promise<View<ResumeCheckBody>> {
    const found = await this.#get(by, command.checkId);
    const b = found.body as unknown as ResumeCheckBody;
    if (b.phase !== "blocked") throw new DomainError("invalid_command", `the resume check is ${b.phase}; only a blocked one is retried`, { field: "checkId" });
    await this.#update(command.checkId, (x) => ({ ...x, phase: "collecting", round: 0, blocked: undefined, history: this.#push(x, "collecting", by.id, "retried after the blocker was dealt with") }), ["blocked"]);
    return this.advance(by, { checkId: command.checkId });
  }

  async cancel(by: Principal, command: { checkId: string }): Promise<View<ResumeCheckBody>> {
    const found = await this.#get(by, command.checkId);
    const b = found.body as unknown as ResumeCheckBody;
    if (b.phase === "executing" || b.phase === "done") throw new DomainError("invalid_command", `the resume check is ${b.phase}; it can no longer be cancelled`, { field: "checkId" });
    if (!TERMINAL.includes(b.phase)) await this.#update(command.checkId, (x) => ({ ...x, phase: "cancelled", blocked: undefined, history: this.#push(x, "cancelled", by.id, "cancelled") }), ["collecting", "verifying", "reviewing", "ready", "blocked"]);
    return view<ResumeCheckBody>((await this.#runner.get(KIND, command.checkId))!);
  }

  // ---- progress ------------------------------------------------------------------------------------------------------------

  /** Takes the check as far as it can go now. Safe to repeat. A check at `ready` waits for `commit`; one at `blocked` waits for `retry`. */
  async advance(by: Principal, command: { checkId: string; commandId?: string }): Promise<View<ResumeCheckBody>> {
    const id = String(command.checkId);
    await this.#get(by, id);
    for (let step = 0; step < RESUME_LIMITS.advances; step++) {
      const found = await this.#get(by, id);
      const b = found.body as unknown as ResumeCheckBody;
      if (TERMINAL.includes(b.phase) || b.phase === "ready" || b.phase === "blocked") return view<ResumeCheckBody>(found);
      if (b.phase === "collecting") {
        const c = await this.#continuations.latest(by, b.taskId);
        if (c === undefined) { await this.#block(by, id, b, "missing_context", "no complete continuation exists for the task, so there is nothing to resume from"); continue; }
        const missing = await this.#ports.missingContext(b.taskId, c);
        if (missing.length > 0) { await this.#block(by, id, b, "missing_context", `critical context is missing: ${missing.slice(0, 10).join(", ")}`); continue; }
        await this.#update(id, (x) => ({ ...x, phase: "verifying", continuationId: c.id, history: this.#push(x, "verifying", by.id, `continuation ${c.id} collected`) }), ["collecting"]);
        continue;
      }
      if (b.phase === "verifying") {
        const current = await this.#continuations.latest(by, b.taskId);
        const effects = current === undefined ? [] : await this.#ports.uncertainEffects(b.taskId, current);
        if (effects.length > 0) { await this.#block(by, id, b, "effects_uncertain", `earlier effects of unknown outcome must be settled first: ${effects.slice(0, 10).join(", ")}`); continue; }
        const now = await this.#verify(by, b, true);
        const changed = now.changed;
        const verdicts: Record<string, ResumeVerdict> = {};
        for (const item of changed) { const kept = b.verdicts[item.id]; if (kept !== undefined && kept.digest === digestOf(item)) verdicts[item.id] = kept; }
        const next = changed.every((i) => verdicts[i.id] !== undefined) ? "ready" : "reviewing";
        await this.#update(id, (x) => ({
          ...x, phase: next, continuationId: now.continuationId, revisionSet: { continuationId: now.continuationId, digest: now.digest, dependencies: now.total, unverified: now.unverified },
          delta: { changed, unchanged: now.total - changed.length }, verdicts,
          history: this.#push(x, next, by.id, `${changed.length} of ${now.total} dependencies changed${now.unverified ? " (no dependencies were recorded, so nothing could be verified)" : ""}`),
        }), ["verifying"]);
        continue;
      }
      if (b.phase === "reviewing") {
        const open = (b.delta?.changed ?? []).filter((i) => b.verdicts[i.id] === undefined);
        let got: Awaited<ReturnType<ResumePorts["review"]>>;
        try { got = await this.#ports.review({ taskId: b.taskId, changes: open }); } catch (error) {
          await this.#block(by, id, b, "review_failed", `the reviewer could not give a verdict: ${short(error instanceof Error ? error.message : String(error))}`);
          continue;
        }
        const verdicts: Record<string, ResumeVerdict> = { ...b.verdicts };
        for (const item of open) {
          const v = got[item.id];
          if (v === undefined || typeof v.relevant !== "boolean" || typeof v.rationale !== "string" || v.rationale.trim().length === 0) continue; // a change with no reasoned verdict stays open
          verdicts[item.id] = { relevant: v.relevant, rationale: short(v.rationale), digest: digestOf(item) };
        }
        const done = (b.delta?.changed ?? []).every((i) => verdicts[i.id] !== undefined);
        if (!done) { await this.#block(by, id, b, "review_failed", "the reviewer gave no reasoned verdict for every change"); continue; }
        await this.#update(id, (x) => ({ ...x, phase: "ready", verdicts, history: this.#push(x, "ready", by.id, `${open.length} change(s) reviewed`) }), ["reviewing"]);
        continue;
      }
      if (b.phase === "executing") {
        // Repeatable: the continuation resume is recorded under this check's own command ID, so a restart records it once.
        const r = await this.#continuations.resume(by, { commandId: `${id}-resume`, taskId: b.taskId, ...(b.continuationId === undefined ? {} : { continuationId: b.continuationId }), model: b.model, ...(b.previousModel === undefined ? {} : { previousModel: b.previousModel }), after: b.after, ...(b.restore === undefined ? {} : { restoredBy: b.restore.method }) });
        await this.#update(id, (x) => ({ ...x, phase: "done", history: this.#push(x, "done", by.id, `resumed from ${r.continuation.id}`) }), ["executing"]);
        continue;
      }
    }
    return view<ResumeCheckBody>(await this.#get(by, id));
  }

  /** Carries every unfinished check on after a restart: collecting, verifying, reviewing and executing ones are advanced (a ready or blocked one waits for a person or the committer). */
  async sweep(by: Principal): Promise<{ advanced: string[]; failed: string[] }> {
    if (by.kind !== "owner" && by.kind !== "service" && by.kind !== "host") throw new DomainError("forbidden", `${by.id} may not sweep resume checks`);
    const advanced: string[] = []; const failed: string[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const rec of page) {
        after = rec.id;
        const b = rec.body as unknown as ResumeCheckBody;
        if (TERMINAL.includes(b.phase) || b.phase === "ready" || b.phase === "blocked") continue;
        try { await this.advance(by, { checkId: rec.id }); advanced.push(rec.id); } catch { failed.push(rec.id); }
      }
      if (page.length < 100) break;
    }
    return { advanced, failed };
  }

  async get(by: Principal, checkId: string): Promise<View<ResumeCheckBody> | undefined> {
    try { return view<ResumeCheckBody>(await this.#get(by, checkId)); } catch (error) { if (error instanceof DomainError && error.code === "not_found") return undefined; throw error; }
  }

  // ---- internals -----------------------------------------------------------------------------------------------------------

  async #authorize(by: Principal, taskId: string): Promise<string> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined || !(by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } }))) throw new DomainError("forbidden", `${by.id} may not resume that task`);
    return task.projectId;
  }

  async #get(by: Principal, checkId: string) {
    const found = await this.#runner.get(KIND, String(checkId));
    if (found === undefined) throw new DomainError("not_found", "no such resume check");
    try { await this.#authorize(by, (found.body as unknown as ResumeCheckBody).taskId); } catch (error) { if (error instanceof DomainError && error.code === "forbidden") throw new DomainError("not_found", "no such resume check"); throw error; }
    return found;
  }

  /** The continuation and every dependency as they are now: what changed (with the checker's rights), and a digest of the whole set. `stale` says why a revision set that was verified before no longer holds. */
  async #verify(by: Principal, b: ResumeCheckBody, collecting = false): Promise<{ continuationId: string; changed: DeltaItem[]; total: number; digest: string; unverified: boolean; stale?: string }> {
    const c = await this.#continuations.latest(by, b.taskId);
    if (c === undefined) throw new DomainError("not_found", "the task's continuation is gone");
    let checks: DependencyCheck[] = [];
    let unverified = false;
    try { checks = await this.#dependencies.check(by, b.taskId, await this.#ports.observe(b.taskId)); } catch (error) { if (error instanceof DomainError && error.code === "not_found") unverified = true; else throw error; }
    const changed: DeltaItem[] = checks.filter((k) => k.status !== "unchanged").map((k) => ({ id: k.id, kind: k.kind, key: k.key, status: k.status, detail: short(k.detail) }));
    const digest = sha(JSON.stringify([c.id, checks.map((k) => [k.id, k.status, k.detail]).sort()]));
    const out = { continuationId: c.id, changed, total: checks.length, digest, unverified };
    if (collecting || b.revisionSet === undefined) return out;
    if (b.revisionSet.continuationId !== c.id) return { ...out, stale: `a newer continuation (${c.id}) was captured after the review` };
    if (b.revisionSet.digest !== digest) return { ...out, stale: "a dependency changed after the review" };
    return out;
  }

  /** The inputs moved after the review: start over, or stop as churn when the rounds are used up. */
  async #restart(by: Principal, id: string, why: string): Promise<void> {
    const b = (await this.#runner.get(KIND, id))!.body as unknown as ResumeCheckBody;
    if (b.round + 1 >= b.maxRounds) { await this.#block(by, id, b, "resume_churn", `the inputs kept changing (${why}); ${b.maxRounds} rounds did not settle`, ["ready"]); return; }
    await this.#update(id, (x) => ({ ...x, phase: "verifying", round: x.round + 1, history: this.#push(x, "verifying", by.id, `started over: ${why}`) }), ["ready"]);
  }

  async #block(by: Principal, id: string, b: ResumeCheckBody, type: NonNullable<ResumeCheckBody["blocked"]>["type"], reason: string, from: readonly ResumePhase[] = LIVE): Promise<void> {
    let blockerId: string | undefined;
    if (type === "missing_context" || type === "resume_churn") {
      const opened = await this.#blockers.openBlocker({ commandId: `${id}-blk-${type}-${b.round}`, actor: "system", type, subject: { kind: "task", id: b.taskId }, summary: short(reason), resolver: "owner" });
      blockerId = opened.id;
    }
    await this.#update(id, (x) => ({ ...x, phase: "blocked", blocked: { type, reason: short(reason), ...(blockerId === undefined ? {} : { blockerId }) }, history: this.#push(x, "blocked", by.id, short(reason)) }), from);
  }

  async #update(id: string, change: (b: ResumeCheckBody) => ResumeCheckBody, from: readonly ResumePhase[]): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get(KIND, id);
      if (found === undefined) throw new DomainError("not_found", "no such resume check");
      if (!from.includes((found.body as unknown as ResumeCheckBody).phase)) return false;
      const next = change(found.body as unknown as ResumeCheckBody);
      const digest = sha(JSON.stringify(clean(next))).slice(0, 16);
      try {
        await this.#runner.command("resume.advance", { commandId: `rck-adv-${id.slice(4)}-${found.revision}-${digest}`, actor: "system" }, async () => ({
          payload: { phase: next.phase, revision: found.revision },
          build: async () => ({ ref: { kind: KIND, id }, creates: false, changes: [{ type: "update", ref: { kind: KIND, id }, expectedRevision: found.revision, body: clean(next) }], detail: { phase: next.phase } }),
        }));
        return true;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 6) throw error;
      }
    }
  }

  #push(b: ResumeCheckBody, phase: ResumePhase, by: string, note: string): ResumeCheckBody["history"] {
    return [...b.history, { phase, at: this.#runner.now(), by, note: short(note) }].slice(-RESUME_LIMITS.history);
  }
}

const digestOf = (item: DeltaItem): string => sha(`${item.status}\0${item.detail}`);


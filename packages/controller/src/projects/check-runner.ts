import { DomainError } from "../domain/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import { assignmentIdOf } from "../domain/assignment-model.js";
import { derivedId } from "../domain/ids.js";
import { type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { hidden, may } from "./common.js";
import type { CheckBody, ResponsibilityChecks } from "./checks.js";
import type { IncidentService } from "./incidents.js";
import type { ResponsibilityBody, ResponsibilityService } from "./responsibilities.js";

/** What a deterministic probe found, with no agent asked. */
export interface CheckProbeResult { readonly outcome: "ok" | "attention" | "failed"; readonly summary: string }
/** A way to take a check without an agent: given the responsibility and the due check it returns what it found, or `undefined` when the check needs interpretation or action (then the agent is given a bounded task). */
export type CheckProbe = (context: { readonly responsibility: View<ResponsibilityBody>; readonly check: View<CheckBody> }) => Promise<CheckProbeResult | undefined>;

export const CHECK_RUN_LIMITS = { maxOpen: { min: 1, max: 50, default: 5 }, summary: 500, perPass: 100, attempts: 3, retryMinutes: 5 } as const;
export interface CheckRunSettings { readonly enabled: boolean; readonly maxOpen: number }
interface SettingsBody { readonly enabled: boolean; readonly maxOpen?: number; readonly updatedBy: string; readonly updatedAt: string }
const SETTINGS = { kind: "responsibility-check-settings", id: "main" } as const;
const wholeMax = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= CHECK_RUN_LIMITS.maxOpen.min && v <= CHECK_RUN_LIMITS.maxOpen.max;

/**
 * The owner's choice about check tasks (card P04f). On by default; `maxOpen` bounds how many check tasks may be open at once in one project (default 5), so a quiet failure cannot start a crowd of agent runs. Turning it off
 * leaves due checks owed (shown as no recent observation, never healthy) and starts no agent work.
 */
export class CheckRunSettingsService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): CheckRunSettingsService { return new CheckRunSettingsService(new CommandRunner(storage, epoch, options)); }

  async get(by: Principal): Promise<{ readonly revision: number; readonly effective: CheckRunSettings; readonly default: CheckRunSettings }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the check settings`);
    const found = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
    return { revision: found?.revision ?? 0, effective: await this.effective(), default: { enabled: true, maxOpen: CHECK_RUN_LIMITS.maxOpen.default } };
  }

  /** Only the fields given change: `enabled`, `maxOpen` (whole number 1 to 50, or null for the default). */
  async set(owner: Principal, command: NoActor & { enabled?: unknown; maxOpen?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the check settings`);
    const bad = Object.keys(command).filter((k) => !["commandId", "enabled", "maxOpen", "expectedRevision"].includes(k));
    if (bad.length > 0) throw new DomainError("invalid_command", `${bad[0]}: is not a field of this command`, { field: bad[0]! });
    if (command.enabled === undefined && command.maxOpen === undefined) throw new DomainError("invalid_command", "enabled: give enabled, maxOpen or both", { field: "enabled" });
    if (command.enabled !== undefined && typeof command.enabled !== "boolean") throw new DomainError("invalid_command", "enabled: must be true or false", { field: "enabled" });
    if (command.maxOpen !== undefined && command.maxOpen !== null && !wholeMax(command.maxOpen)) throw new DomainError("invalid_command", `maxOpen: must be a whole number from ${CHECK_RUN_LIMITS.maxOpen.min} to ${CHECK_RUN_LIMITS.maxOpen.max}, or null for the default`, { field: "maxOpen" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("check.settings.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { enabled: (command.enabled as boolean | undefined) ?? null, maxOpen: command.maxOpen === undefined ? "keep" : (command.maxOpen as number | null), expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the check setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const before = current === undefined ? undefined : this.#parse(current.body);
        const enabled = (command.enabled as boolean | undefined) ?? before?.enabled ?? true;
        const maxOpen = command.maxOpen === undefined ? before?.maxOpen : command.maxOpen === null ? undefined : (command.maxOpen as number);
        const next: SettingsBody = { enabled, ...(maxOpen === undefined ? {} : { maxOpen }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        return { ref: SETTINGS, creates: current === undefined, changes: [current === undefined ? { type: "create" as const, ref: SETTINGS, body: next as unknown as JsonObject } : { type: "update" as const, ref: SETTINGS, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { enabled, maxOpen: maxOpen ?? null } };
      },
    }));
    return { revision: result.revision };
  }

  /** What applies now. A damaged record throws, so the setting never silently changes meaning. */
  async effective(): Promise<CheckRunSettings> {
    const found = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
    if (found === undefined) return { enabled: true, maxOpen: CHECK_RUN_LIMITS.maxOpen.default };
    const b = this.#parse(found.body);
    if (b === undefined) throw new DomainError("unavailable", "the stored check setting is damaged; set it again (check.settings.set)");
    return { enabled: b.enabled, maxOpen: b.maxOpen ?? CHECK_RUN_LIMITS.maxOpen.default };
  }

  #parse(body: unknown): { enabled: boolean; maxOpen?: number } | undefined {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
    const b = body as Record<string, unknown>;
    if (typeof b["enabled"] !== "boolean" || (b["maxOpen"] !== undefined && !wholeMax(b["maxOpen"]))) return undefined;
    return { enabled: b["enabled"], ...(b["maxOpen"] === undefined ? {} : { maxOpen: b["maxOpen"] as number }) };
  }
}

const SIGNATURE = "scheduled-check";
const cut = (value: string, max: number): string => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028\u2029]/g, " ").slice(0, max);
const TERMINAL = new Set(["done", "cancelled"]);

export interface CheckPassResult {
  /** Checks taken by a probe (no agent). */
  readonly observed: number;
  /** Bounded tasks opened for the answerable agent. */
  readonly tasks: number;
  /** Checks that ride on an earlier task of the same responsibility that is still open. */
  readonly coalesced: number;
  /** Checks recorded as not taken because nobody answers for the responsibility. */
  readonly noAgent: number;
  /** Checks left owed for now: the owner switched check tasks off, or the project is at its limit of open check tasks. */
  readonly deferred: number;
}

/**
 * Takes the checks that came due (card P04f): each one ends as a recorded observation or a bounded task, and an agent is only asked when interpretation or action is needed.
 *
 * - **A probe first.** When a deterministic probe gives the result it is written to the history as a `check` entry (and a bad result reported as an incident) with no agent and no model.
 * - **Otherwise a bounded task** for the answerable agent: created, made ready and assigned under derived IDs, so a crash part-way or a second instance finishes the same task and never makes another. The task says what is wanted, what
 *   the responsibility may do at most, and that changes are held while a maintenance window is on. The check stays owed until the agent records a `check` entry: a task that ends without one leaves "no recent observation".
 * - **Bounded.** One open task per responsibility (later checks ride on it, and a new one opens only when the earlier task ended), at most the owner's limit of open check tasks in a project, at most `perPass` checks looked at in a pass.
 * - **No answerable agent**: the check is recorded as `attention` ("not taken"), reported as an incident, never as healthy.
 * - **Paused and retired responsibilities** are left alone; their checks wait.
 */
export class CheckRunService {
  readonly #runner: CommandRunner;
  readonly #deps: CheckRunDeps;
  private constructor(runner: CommandRunner, deps: CheckRunDeps) { this.#runner = runner; this.#deps = deps; }
  static withEpoch(storage: ControllerStorage, epoch: number, deps: CheckRunDeps, options: RunnerOptions = {}): CheckRunService { return new CheckRunService(new CommandRunner(storage, epoch, options), deps); }

  async run(by: Principal, projectId: string): Promise<CheckPassResult> {
    if (!(by.kind === "owner" || by.kind === "service" || may(by, "responsibility.write", projectId))) throw hidden(by, "run checks for that project");
    const pending = await this.#deps.checks.pending(by, projectId);
    const out = { observed: 0, tasks: 0, coalesced: 0, noAgent: 0, deferred: 0 };
    if (pending === undefined || pending.length === 0) return out;
    const settings = await this.#deps.settings.effective();
    // The open check tasks now: a pending check taken up as a task whose task has not ended. Counted per responsibility and for the project.
    const openOf = new Map<string, { checkId: string; taskId: string }>();
    let open = 0;
    for (const c of pending) {
      if (c.run?.how === "task" && c.run.taskId !== undefined && !(await this.#ended(c.run.taskId))) {
        if (!openOf.has(c.responsibilityId)) openOf.set(c.responsibilityId, { checkId: c.id, taskId: c.run.taskId });
        open++;
      }
    }
    let failure: unknown; let looked = 0;
    // A `check` entry finishes every owed check of its responsibility, so one entry per responsibility per pass is enough.
    const finished = new Set<string>();
    for (const c of pending) {
      // Already taken up by a task or a ride on one that is still open, or finished: nothing more to do. A task that ended with no check entry is tried again, after a wait and at most three times in all.
      if (finished.has(c.responsibilityId)) continue;
      let attempt = 1;
      if (c.run !== undefined) {
        const t = c.run.taskId;
        if ((c.run.how !== "task" && c.run.how !== "coalesced") || t === undefined || !(await this.#ended(t))) continue;
        attempt = (c.run.attempt ?? 1) + 1;
        const r0 = await this.#deps.responsibilities.get(by, c.responsibilityId);
        if (r0 === undefined || r0.state !== "active") continue;
        if (Date.parse(this.#runner.now()) < Date.parse(c.run.at) + Math.max(r0.everyMinutes ?? 60, CHECK_RUN_LIMITS.retryMinutes) * 60_000) continue;
        if (attempt > CHECK_RUN_LIMITS.attempts) {
          await this.#observe(by, r0, c, { outcome: "attention", summary: `The task for this check ended ${CHECK_RUN_LIMITS.attempts} times without a recorded result, so it was not taken.` }, "no-agent", attempt);
          out.noAgent++; finished.add(c.responsibilityId);
          continue;
        }
      }
      if (++looked > CHECK_RUN_LIMITS.perPass) { out.deferred++; continue; }
      try {
        const r = await this.#deps.responsibilities.get(by, c.responsibilityId);
        if (r === undefined || r.state !== "active") continue;
        const probed = this.#deps.probe === undefined ? undefined : await this.#deps.probe({ responsibility: r, check: c });
        if (probed !== undefined) { await this.#observe(by, r, c, probed); out.observed++; finished.add(r.id); continue; }
        if (r.ownerId === undefined) { await this.#observe(by, r, c, { outcome: "attention", summary: "Nobody answers for this responsibility, so this check was not taken." }, "no-agent"); out.noAgent++; finished.add(r.id); continue; }
        const earlier = openOf.get(r.id);
        if (earlier !== undefined) {
          await this.#deps.checks.noteRun(by, c.id, { how: "coalesced", at: this.#runner.now(), attempt, taskId: earlier.taskId, summary: `An earlier check task of this responsibility is still open (${earlier.taskId}); this check rides on it.` });
          out.coalesced++;
          continue;
        }
        if (!settings.enabled || open >= settings.maxOpen) { out.deferred++; continue; }
        const taskId = await this.#openTask(by, r, c, attempt);
        open++; openOf.set(r.id, { checkId: c.id, taskId }); out.tasks++;
      } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
    return out;
  }

  async #ended(taskId: string): Promise<boolean> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    return task === undefined || TERMINAL.has(task.state);
  }

  /** A result from a probe, or a check that could not be taken: written to the history (a `check` entry finishes the check), a bad result reported as one grouped incident, and the way it was taken noted on the check. */
  async #observe(by: Principal, r: View<ResponsibilityBody>, c: View<CheckBody>, found: CheckProbeResult, how: "observation" | "no-agent" = "observation", attempt = 1): Promise<void> {
    const summary = cut(found.summary, CHECK_RUN_LIMITS.summary) || "(no summary)";
    await this.#deps.responsibilities.record(by, { commandId: `rcr-obs-${c.id}${attempt === 1 ? "" : `:${attempt}`}`, responsibilityId: r.id, kind: "check", summary, outcome: found.outcome });
    if (found.outcome !== "ok") await this.#deps.incidents.report(by, { commandId: `rcr-inc-${c.id}${attempt === 1 ? "" : `:${attempt}`}`, responsibilityId: r.id, signature: SIGNATURE, summary, outcome: found.outcome });
    await this.#deps.checks.noteRun(by, c.id, { how, at: this.#runner.now(), attempt, outcome: found.outcome, summary });
  }

  async #openTask(by: Principal, r: View<ResponsibilityBody>, c: View<CheckBody>, attempt: number): Promise<string> {
    const base = `rcr-task:${c.id}${attempt === 1 ? "" : `:${attempt}`}`;
    const tag = `${c.id}${attempt === 1 ? "" : `:${attempt}`}`;
    const taskId = derivedId("task", base);
    const agent = r.ownerId!.startsWith("agent:") ? r.ownerId!.slice("agent:".length) : r.ownerId!;
    const done = async (): Promise<TaskBody | undefined> => (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    const step = async (finished: () => Promise<boolean>, run: () => Promise<unknown>): Promise<void> => {
      if (await finished()) return;
      try { await run(); } catch (error) { if (!(error instanceof DomainError) || !(await finished())) throw error; }
    };
    const title = cut(`Check: ${r.title}`, 200);
    const why = c.trigger === undefined ? `The check due at ${c.slotStart} came due.` : `${c.trigger.events} event${c.trigger.events === 1 ? "" : "s"} from ${c.trigger.source} (${c.trigger.kinds.join(", ")}) came in; the check is owed since ${c.slotStart}.`;
    const description = cut([
      `Take one check of the responsibility "${r.title}". ${why}`,
      `Objective: ${r.objective}`,
      `Desired condition: ${r.desiredCondition || "(none stated)"}`,
      r.managed.length === 0 ? "No managed resources are named." : `Managed resources: ${r.managed.join(", ")}.`,
      r.permittedActions.length === 0 ? "You may only look and report: no actions are permitted." : `Actions you may use at most: ${r.permittedActions.join(", ")}.`,
      c.inMaintenanceWindow ? "A maintenance window is on: look and report, and hold any change until it ends." : "",
      c.gap === undefined ? "" : `Earlier checks were missed from ${c.gap.start} to ${c.gap.end} (${c.gap.missedChecks}); say what you cannot know about that time.`,
      `Finish by recording a check entry on responsibility ${r.id} (responsibility.record, kind check) with outcome ok, attention or failed and what you found; report an alert with incident.report. This task ends then; it does not replace any other task.`,
    ].filter((x) => x !== "").join("\n"), 3000);
    await step(async () => (await done()) !== undefined, () => this.#deps.projects.createTask({ commandId: base, actor: by.id, projectId: r.projectId, title, description }));
    await step(async () => (await done())?.state !== "proposed", async () => this.#deps.projects.transitionTask({ commandId: `rcr-ready:${tag}`, actor: by.id, taskId, expectedRevision: (await this.#runner.get("task", taskId))!.revision, to: "ready" }));
    await step(async () => (await this.#runner.get("assignment", assignmentIdOf(taskId))) !== undefined, () => this.#deps.assignments.assignTask({ commandId: `rcr-assign:${tag}`, actor: by.id, taskId, owner: { kind: "agent", id: agent }, reason: `check of ${r.title}`.slice(0, 200) }));
    await this.#deps.responsibilities.record(by, { commandId: `rcr-note-${tag}`, responsibilityId: r.id, kind: "note", summary: cut(`Check due since ${c.slotStart}${c.trigger === undefined ? "" : " (events)"}: a bounded task was opened for the answerable agent.`, 300), taskId });
    await this.#deps.checks.noteRun(by, c.id, { how: "task", at: this.#runner.now(), attempt, taskId, summary: `A bounded task was opened for ${r.ownerId}.` });
    return taskId;
  }
}

export interface CheckRunDeps {
  readonly responsibilities: Pick<ResponsibilityService, "get" | "record">;
  readonly checks: Pick<ResponsibilityChecks, "pending" | "noteRun">;
  readonly incidents: Pick<IncidentService, "report">;
  readonly settings: Pick<CheckRunSettingsService, "effective">;
  readonly projects: Pick<ProjectService, "createTask" | "transitionTask">;
  readonly assignments: Pick<AssignmentService, "assignTask">;
  /** A deterministic way to take a check without an agent. Absent: every check needs an agent. */
  readonly probe?: CheckProbe;
}


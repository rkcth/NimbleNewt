import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { projectId as checkProjectId, type View } from "../domain/model.js";
import { CommandRunner, view, type Built, type RunnerOptions } from "../domain/runner.js";
import type { Principal } from "../security/principals.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { hidden, may, scanAll } from "./common.js";
import type { ResponsibilityService } from "./responsibilities.js";

/** One check that came due (kind `responsibility-check`). It is a record that a check is owed, not a conversation: nothing here runs it. It is finished by a `check` observation recorded on the responsibility after `slotStart`. */
export interface CheckBody {
  readonly responsibilityId: string;
  readonly projectId: string;
  /** When the check came due: the slot, so the same slot is only ever recorded once. */
  readonly slotStart: string;
  readonly scheduledAt: string;
  /** The check came due inside a maintenance window: it is still owed, and any action it would take is held until the window ends. */
  readonly inMaintenanceWindow: boolean;
  /** Slots that were skipped over because nobody looked (the controller was down, or the checks were not generated) before this catch-up check: one check is owed, and the gap is kept as a fact, not hidden. */
  readonly gap?: { readonly start: string; readonly end: string; readonly missedChecks: number; readonly reason: "not-generated" };
  /** Present when the check came due because events arrived (card P04f), not because the schedule did: one check for all the events of one look. */
  readonly trigger?: CheckTrigger;
  /** How the check was taken up (card P04f). Absent while nothing has looked at it: it is only owed. */
  readonly run?: CheckRun;
}

export interface CheckTrigger { readonly kind: "event"; readonly source: string; readonly events: number; readonly firstSeq: number; readonly lastSeq: number; readonly kinds: readonly string[] }

/**
 * What became of a due check (card P04f). `observation`: a deterministic probe gave the result and it was written to the history, no agent involved. `task`: the answerable agent was given a bounded task (the check stays owed until
 * it records a `check` entry). `coalesced`: an earlier task of the same responsibility is still open, so this check rides on it. `no-agent`: nobody answers for the responsibility, so the check was recorded as not taken.
 */
export interface CheckRun { readonly how: "observation" | "task" | "coalesced" | "no-agent"; readonly at: string; /** Which try this is: 1, then one more each time the task ended with no check entry recorded (at most 3). */ readonly attempt?: number; readonly taskId?: string; readonly outcome?: "ok" | "attention" | "failed"; readonly summary: string }

const KIND = "responsibility-check";
const idOf = (responsibilityId: string, slotStart: string): string => `rck-${createHash("sha256").update(`${responsibilityId}\0${slotStart}`).digest("hex").slice(0, 24)}`;

/**
 * Deterministic scheduling of responsibility checks (card P04).
 *
 * - **Idempotent.** A check is identified by its responsibility and the slot it came due at, so generating twice, after a restart, or from two instances gives one record.
 * - **Catch-up, not a flood.** After downtime one check is owed with the gap named (how many were missed and over which time), not one per missed slot.
 * - **Only active responsibilities with a schedule** produce checks; paused and retired ones produce nothing. A check inside a maintenance window is still owed and says so.
 * - **No model, no task.** This only records that a check is owed. Turning it into a bounded task or an observation is the caller's work.
 */
export class ResponsibilityChecks {
  readonly #runner: CommandRunner;
  readonly #responsibilities: Pick<ResponsibilityService, "list" | "status">;

  private constructor(runner: CommandRunner, responsibilities: Pick<ResponsibilityService, "list" | "status">) { this.#runner = runner; this.#responsibilities = responsibilities; }

  static withEpoch(storage: ControllerStorage, epoch: number, responsibilities: Pick<ResponsibilityService, "list" | "status">, options: RunnerOptions = {}): ResponsibilityChecks {
    return new ResponsibilityChecks(new CommandRunner(storage, epoch, options), responsibilities);
  }

  /** Records the checks that are due now in a project. Returns the IDs of the checks newly recorded. Owner, service, or `responsibility.write` in the project. */
  async generate(by: Principal, projectIdValue: string): Promise<string[]> {
    const projectId = checkProjectId(projectIdValue);
    if (!(by.kind === "owner" || by.kind === "service" || may(by, "responsibility.write", projectId))) throw hidden(by, "generate checks for that project");
    const made: string[] = [];
    for (const r of (await this.#responsibilities.list(by, projectId, { state: "active" })) ?? []) {
      const status = await this.#responsibilities.status(by, r.id);
      if (status === undefined || r.everyMinutes === undefined || status.nextCheckDue === undefined) continue;
      const now = Date.parse(status.asOf);
      const due = Date.parse(status.nextCheckDue);
      if (due > now) continue;
      const every = r.everyMinutes * 60_000;
      const missed = Math.floor((now - due) / every);
      const body: CheckBody = {
        responsibilityId: r.id, projectId, slotStart: status.nextCheckDue, scheduledAt: status.asOf, inMaintenanceWindow: status.inMaintenanceWindow,
        ...(missed >= 1 ? { gap: { start: new Date(due + every).toISOString(), end: new Date(due + missed * every + every).toISOString(), missedChecks: missed, reason: "not-generated" as const } } : {}),
      };
      const id = idOf(r.id, body.slotStart);
      const result = await this.#runner.command("responsibility.check.generate", { commandId: id, actor: by.id }, async () => ({
        payload: { id },
        build: async (): Promise<Built> => {
          const ref: AggregateRef = { kind: KIND, id };
          return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { responsibilityId: r.id, slotStart: body.slotStart } };
        },
      }));
      if (!result.replayed) made.push(id);
    }
    return made;
  }

  /** Records that events woke a responsibility (card P04f): one check for the events of one look, identified by the responsibility and the first and last event, so a repeat records nothing new. Owner, service or `responsibility.write`. */
  async recordEvent(by: Principal, projectIdValue: string, responsibilityId: string, trigger: CheckTrigger, slotStart: string): Promise<boolean> {
    const projectId = checkProjectId(projectIdValue);
    if (!(by.kind === "owner" || by.kind === "service" || may(by, "responsibility.write", projectId))) throw hidden(by, "generate checks for that project");
    const status = await this.#responsibilities.status(by, responsibilityId);
    if (status === undefined) return false;
    const body: CheckBody = { responsibilityId, projectId, slotStart, scheduledAt: status.asOf, inMaintenanceWindow: status.inMaintenanceWindow, trigger };
    const id = idOf(responsibilityId, `event:${trigger.firstSeq}-${trigger.lastSeq}`);
    const result = await this.#runner.command("responsibility.check.generate", { commandId: id, actor: by.id }, async () => ({
      payload: { id },
      build: async (): Promise<Built> => {
        const ref: AggregateRef = { kind: KIND, id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { responsibilityId, firstSeq: trigger.firstSeq, lastSeq: trigger.lastSeq } };
      },
    }));
    return !result.replayed;
  }

  /** Notes how a check was taken up (card P04f), once: a second note on the same check changes nothing. Returns whether this call wrote it. */
  async noteRun(by: Principal, checkId: string, run: CheckRun): Promise<boolean> {
    const attempt = run.attempt ?? 1;
    const found = await this.#runner.get(KIND, checkId);
    if (found === undefined) return false;
    const body = found.body as unknown as CheckBody;
    if (!(by.kind === "owner" || by.kind === "service" || may(by, "responsibility.write", body.projectId))) throw hidden(by, "note a check");
    if (body.run !== undefined && (body.run.attempt ?? 1) >= attempt) return false;
    try {
      await this.#runner.command("responsibility.check.run", { commandId: `${checkId}-run${attempt === 1 ? "" : `-${attempt}`}`, actor: by.id }, async () => ({
        payload: { checkId, how: run.how },
        build: async (): Promise<Built> => {
          const ref: AggregateRef = { kind: KIND, id: checkId };
          const cur = await this.#runner.get(KIND, checkId);
          if (cur === undefined) throw new DomainError("not_found", `check ${checkId} is gone`);
          if ((cur.body as unknown as CheckBody).run !== undefined && ((cur.body as unknown as CheckBody).run!.attempt ?? 1) >= attempt) return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: cur.revision }], detail: { checkId, again: true } };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: cur.revision, body: { ...(cur.body as unknown as CheckBody), run } as unknown as JsonObject }], detail: { checkId, how: run.how } };
        },
      }));
    } catch (error) { if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict")) return false; throw error; }
    return true;
  }

  /** One check by ID, for those who may read its project. */
  async get(by: Principal, checkId: string): Promise<View<CheckBody> | undefined> {
    const found = await this.#runner.get(KIND, checkId);
    if (found === undefined) return undefined;
    const body = found.body as unknown as CheckBody;
    return may(by, "responsibility.read", body.projectId) ? view<CheckBody>(found) : undefined;
  }

  /** The checks still owed in a project (their slot is after the responsibility's last check), oldest slot first. `undefined` for a project the caller may not read. */
  async pending(by: Principal, projectIdValue: string): Promise<View<CheckBody>[] | undefined> {
    const projectId = checkProjectId(projectIdValue);
    const list = await this.#responsibilities.list(by, projectId);
    if (list === undefined) return undefined;
    const last = new Map<string, number | undefined>();
    for (const r of list) { const lastAt = (await this.#responsibilities.status(by, r.id))?.lastCheckAt; last.set(r.id, lastAt === undefined ? undefined : Date.parse(lastAt)); }
    const found = await scanAll(this.#runner, KIND, 50_000, (a) => (a.body as unknown as CheckBody).projectId === projectId);
    return found.map((a) => view<CheckBody>(a)).filter((c) => last.has(c.responsibilityId) && (last.get(c.responsibilityId) === undefined || Date.parse(c.slotStart) > last.get(c.responsibilityId)!)).sort((a, b) => (a.slotStart < b.slotStart ? -1 : a.slotStart > b.slotStart ? 1 : a.id < b.id ? -1 : 1));
  }
}


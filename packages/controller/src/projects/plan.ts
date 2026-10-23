import { DomainError } from "../domain/errors.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, text, type Milestone, type Participant, type ProjectBody, type Workstream } from "../domain/model.js";
import { CommandRunner, type CommandResult, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { PROJECT_WORK_LIMITS as L, dueAt, dueDate, hidden, invalid, may, slug } from "./common.js";

export interface SetProjectPlan extends NoActor {
  readonly projectId: string;
  readonly expectedRevision: number;
  /** A date, or `null` to clear it. */
  readonly dueDate?: string | null;
  readonly workstreams?: readonly Workstream[];
  /** `state` defaults to open. */
  readonly milestones?: readonly (Omit<Milestone, "state"> & { readonly state?: Milestone["state"] })[];
  readonly participants?: readonly Participant[];
}

export interface Schedule {
  readonly projectId: string;
  /** The clock's reading when the answer was computed. */
  readonly asOf: string;
  readonly dueDate?: string;
  readonly overdue: boolean;
  readonly milestones: readonly (Milestone & { overdue: boolean })[];
}

const FIELDS = ["dueDate", "workstreams", "milestones", "participants"] as const;

function objects(value: unknown, field: string, max: number): Record<string, unknown>[] {
  if (!Array.isArray(value)) return invalid(field, "must be a list");
  if (value.length > max) return invalid(field, `must have at most ${max} entries`);
  return value.map((v, i) => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : invalid(`${field}[${i}]`, "must be an object")));
}
const known = (entry: object, allowed: readonly string[], at: string): void => { for (const k of Object.keys(entry)) if (!allowed.includes(k)) invalid(`${at}.${k}`, "is not a field here"); };

function parseWorkstreams(value: unknown): Workstream[] {
  const seen = new Set<string>();
  return objects(value, "workstreams", L.workstreams).map((w, i) => {
    known(w, ["id", "name", "description"], `workstreams[${i}]`);
    const id = slug(w["id"], `workstreams[${i}].id`);
    if (seen.has(id)) invalid(`workstreams[${i}].id`, `repeats ${id}`);
    seen.add(id);
    return { id, name: text(w["name"], `workstreams[${i}].name`, { min: 1, max: L.name }), ...(w["description"] === undefined ? {} : { description: text(w["description"], `workstreams[${i}].description`, { min: 1, max: L.description, multiline: true }) }) };
  });
}

function parseMilestones(value: unknown): Milestone[] {
  const seen = new Set<string>();
  return objects(value, "milestones", L.milestones).map((m, i) => {
    known(m, ["id", "name", "state", "dueDate", "workstreamId"], `milestones[${i}]`);
    const id = slug(m["id"], `milestones[${i}].id`);
    if (seen.has(id)) invalid(`milestones[${i}].id`, `repeats ${id}`);
    seen.add(id);
    const state = m["state"] === undefined ? "open" : m["state"] === "open" || m["state"] === "reached" ? m["state"] : invalid(`milestones[${i}].state`, "must be open or reached");
    return {
      id, name: text(m["name"], `milestones[${i}].name`, { min: 1, max: L.name }), state,
      ...(m["dueDate"] === undefined ? {} : { dueDate: dueDate(m["dueDate"], `milestones[${i}].dueDate`) }),
      ...(m["workstreamId"] === undefined ? {} : { workstreamId: slug(m["workstreamId"], `milestones[${i}].workstreamId`) }),
    };
  });
}

function parseParticipants(value: unknown): Participant[] {
  const seen = new Set<string>();
  return objects(value, "participants", L.participants).map((p, i) => {
    known(p, ["principalId", "role"], `participants[${i}]`);
    const principalId = text(p["principalId"], `participants[${i}].principalId`, { min: 1, max: 120 });
    if (seen.has(principalId)) invalid(`participants[${i}].principalId`, `repeats ${principalId}`);
    seen.add(principalId);
    return { principalId, ...(p["role"] === undefined ? {} : { role: text(p["role"], `participants[${i}].role`, { min: 1, max: L.role }) }) };
  });
}

/**
 * The optional planning fields of a project record (card P01): a due date, workstreams, milestones and the agents authorized to take part. All are optional and a project works
 * without any. They are information for people and for scheduling reads; none of them drives a state.
 *
 * - **A due date is not a trigger.** Nothing here reads the clock to change anything: `schedule` computes `overdue` when asked, from the injected clock, and writes nothing. Passing a date
 *   changes no project, task or milestone state; a milestone is `reached` only because a command said so.
 * - **Participants** must be active agent principals, are listed on the project record and grant nothing: what an agent may do is its grants (A01). Setting the list needs
 *   `project.participants.write`, the rest of the plan `project.plan.write`; a command naming a field needs the authority for that field.
 * - Each field given replaces that field whole (workstreams, milestones and participants are lists of at most 20, 50 and 50); a field left out is kept, and `dueDate: null` clears the date.
 *   Dropping a workstream that a milestone names is refused.
 */
export class ProjectPlanService {
  readonly #runner: CommandRunner;

  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): ProjectPlanService {
    return new ProjectPlanService(new CommandRunner(storage, epoch, options));
  }

  async setPlan(by: Principal, command: SetProjectPlan): Promise<CommandResult> {
    return this.#runner.command("project.plan", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "projectId", "expectedRevision", ...FIELDS]);
      const projectId = checkProjectId(command.projectId);
      const expected = checkRevision(command.expectedRevision);
      const due = command.dueDate === undefined || command.dueDate === null ? command.dueDate : dueDate(command.dueDate, "dueDate");
      const workstreams = command.workstreams === undefined ? undefined : parseWorkstreams(command.workstreams);
      const milestones = command.milestones === undefined ? undefined : parseMilestones(command.milestones);
      const participants = command.participants === undefined ? undefined : parseParticipants(command.participants);
      if (due === undefined && workstreams === undefined && milestones === undefined && participants === undefined) invalid("dueDate", "name at least one of dueDate, workstreams, milestones or participants");
      return {
        payload: { projectId, expectedRevision: expected, ...(due === undefined ? {} : { dueDate: due }), ...(workstreams === undefined ? {} : { workstreams: workstreams as unknown as JsonObject[] }), ...(milestones === undefined ? {} : { milestones: milestones as unknown as JsonObject[] }), ...(participants === undefined ? {} : { participants: participants as unknown as JsonObject[] }) },
        build: async () => {
          const found = await this.#runner.get("project", projectId);
          if (found === undefined || !may(by, "project.read", projectId)) throw hidden(by, "plan that project");
          if (due !== undefined || workstreams !== undefined || milestones !== undefined) this.#require(by, "project.plan.write", projectId, "change the plan of that project");
          if (participants !== undefined) this.#require(by, "project.participants.write", projectId, "change who takes part in that project");
          if (found.revision !== expected) throw new DomainError("stale_revision", `project ${projectId} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
          const body = found.body as unknown as ProjectBody;
          if (body.state === "archived") invalid("projectId", `project ${projectId} is archived; reactivate it to change its plan`);
          const ws = workstreams ?? body.workstreams ?? [];
          const ms = milestones ?? body.milestones ?? [];
          for (const [i, m] of ms.entries()) if (m.workstreamId !== undefined && !ws.some((w) => w.id === m.workstreamId)) invalid(`milestones[${i}].workstreamId`, `the project has no workstream ${m.workstreamId}`);
          if (participants !== undefined) {
            for (const [i, p] of participants.entries()) {
              const who = (await this.#runner.get("principal", p.principalId))?.body as unknown as PrincipalBody | undefined;
              if (who === undefined || who.kind !== "agent" || who.state !== "active") invalid(`participants[${i}].principalId`, "must be an active agent");
            }
          }
          const { dueDate: _due, workstreams: _ws, milestones: _ms, participants: _ps, ...rest } = body;
          const nextDue = due === undefined ? body.dueDate : due === null ? undefined : due;
          const nextParticipants = participants ?? body.participants;
          const next: ProjectBody = {
            ...rest,
            ...(nextDue === undefined ? {} : { dueDate: nextDue }),
            ...(workstreams !== undefined || body.workstreams !== undefined ? { workstreams: ws } : {}),
            ...(milestones !== undefined || body.milestones !== undefined ? { milestones: ms } : {}),
            ...(nextParticipants === undefined ? {} : { participants: nextParticipants }),
          };
          const ref = { kind: "project", id: projectId };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: expected, body: next as unknown as JsonObject }], detail: { fields: FIELDS.filter((f) => command[f] !== undefined).join(",") } };
        },
      };
    });
  }

  /**
   * The project's dates against the clock now. A pure read: it writes nothing and changes nothing, so a due date that has passed leaves every state as it was. A milestone already
   * `reached` is never overdue. `undefined` for a project the caller may not read.
   */
  async schedule(by: Principal, projectId: string): Promise<Schedule | undefined> {
    const id = checkProjectId(projectId);
    const found = await this.#runner.get("project", id);
    if (found === undefined || !may(by, "project.read", id)) return undefined;
    const body = found.body as unknown as ProjectBody;
    const now = this.#runner.now();
    const late = (d: string | undefined): boolean => d !== undefined && dueAt(d) < Date.parse(now);
    return {
      projectId: id, asOf: now,
      ...(body.dueDate === undefined ? {} : { dueDate: body.dueDate }),
      overdue: body.state === "active" && late(body.dueDate),
      milestones: (body.milestones ?? []).map((m) => ({ ...m, overdue: m.state === "open" && late(m.dueDate) })),
    };
  }

  /** Whether the agent is listed as a participant of the project. A listing only; it grants nothing. */
  async isParticipant(projectId: string, principalId: string): Promise<boolean> {
    const found = await this.#runner.get("project", checkProjectId(projectId));
    return ((found?.body as unknown as ProjectBody | undefined)?.participants ?? []).some((p) => p.principalId === principalId);
  }

  #require(by: Principal, action: string, projectId: string, what: string): void {
    if (!may(by, action, projectId)) throw hidden(by, what);
  }
}

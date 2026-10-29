import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, text, type View } from "../domain/model.js";
import { CommandRunner, view, type Built, type CommandResult, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

/**
 * A role template: a name and the bundle of capabilities (action names) it stands for, plus the roles it may not be combined with. **A role grants nothing by itself**:
 * granting is a separate, bounded act (card A02); the bundle says what the owner would grant for the role, and the exclusions are enforced when roles are assigned.
 */
export interface RoleBody {
  readonly name: string;
  readonly capabilities: readonly string[];
  /** Roles that may not be held together with this one. The rule is symmetric: either side naming the other is enough. */
  readonly excludes: readonly string[];
  readonly description?: string;
  /** What the owner calls the role in screens and chat (for example "CTO" for director). Display only: it decides no grant, check or history, and only the owner sets it (card H11b). */
  readonly label?: string;
}

export interface TeamBody {
  readonly name: string;
  /** The team this one reports into. Organisational only: it gives no authority over tasks. */
  readonly parentTeamId?: string;
}

export interface AgentBody {
  /** A label for people. It may change and may repeat; it never decides identity, ownership, authorization or routing. */
  readonly friendlyName: string;
  readonly roles: readonly string[];
  readonly teamId?: string;
  /** The agent this one reports to. Organisational only: it is not a task dependency and grants no write to this agent's desk and no read of its scratch. */
  readonly supervisorId?: string;
  /** A name from the routing configuration (card R01), not a model: changing the model or harness behind it leaves the agent the same agent. */
  readonly defaultProfile?: string;
  readonly permittedOverrides: readonly string[];
  /** The agent's chosen environment (card A08). */
  readonly environment?: string;
  /** Style and temperament for the agent's prompts. It has no effect on permissions, authority or evidence requirements. */
  readonly persona?: string;
  readonly state: "active" | "retired";
  /** The identity the agent authenticates as; it is made from the agent's ID, so renaming the agent changes nothing about it. */
  readonly principalId: string;
  readonly createdBy: string;
  /** Where a cloned or imported agent came from. */
  readonly clonedFrom?: string;
  readonly importedFrom?: string;
}

export interface AgentOptions extends RunnerOptions {
  /** How many agents a safety check may read before it refuses to answer (default 5000). It fails closed: a check that cannot see every agent does not pass. */
  readonly scanLimit?: number;
}

/**
 * The standard role templates (card H11b). Ids are fixed; an owner label is display only. Each bundle is what the owner would grant for the role, never a grant. The integrator holds no `workspace.manage`: it asks the controller to
 * integrate under the project's policy (card P10), and it holds no write to the shared workspace. No role excludes another here: that an author may not review their own work is decided per piece of work (card H05), not per agent,
 * so a one-agent project still works.
 */
export const STANDARD_ROLES: readonly { readonly name: string; readonly capabilities: readonly string[]; readonly description: string }[] = [
  { name: "author", capabilities: ["project.read", "task.read", "attempt.work", "desk.read", "desk.write", "history.append", "artifact.read", "artifact.publish"], description: "Does the work of a task and submits it." },
  { name: "reviewer", capabilities: ["project.read", "task.read", "desk.read", "history.read", "artifact.read", "review.decide"], description: "Reads submitted work and gives an independent verdict." },
  { name: "integrator", capabilities: ["project.read", "task.read", "desk.read", "history.read", "artifact.read"], description: "Orders submitted work and asks the controller to land it; writes no content." },
  { name: "qa", capabilities: ["project.read", "task.read", "desk.read", "desk.write", "history.read", "artifact.read", "artifact.publish"], description: "Tests submitted work and reports what it finds." },
  { name: "docs", capabilities: ["project.read", "task.read", "desk.read", "desk.write", "history.read", "artifact.read", "artifact.publish"], description: "Writes and updates documents for the work." },
  { name: "director", capabilities: ["project.read", "task.read", "desk.read", "history.read", "artifact.read", "review.decide", "meeting.read", "budget.read", "responsibility.read"], description: "Signs off for the project as a whole; one agent may also be another agent's supervisor." },
];

export const AGENT_LIMITS = { name: 80, persona: 2000, roles: 20, overrides: 20, capabilities: 100, excludes: 20, word: 60, description: 400, chain: 64, scan: 5000, label: 40 } as const;
const ROLE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const ACTION = /^(?:\*|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*(?:\.\*)?)$/;
const AGENT_ID = /^agt-[a-z2-7]{20}$/;
const TEAM_ID = /^team-[a-z2-7]{20}$/;

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const agentId = (v: unknown, field = "agentId"): string => (typeof v === "string" && AGENT_ID.test(v) ? v : invalid(field, "is not an agent ID"));
const teamId = (v: unknown, field = "teamId"): string => (typeof v === "string" && TEAM_ID.test(v) ? v : invalid(field, "is not a team ID"));
const roleName = (v: unknown, field: string): string => (typeof v === "string" && ROLE_NAME.test(v) ? v : invalid(field, "must be 1 to 40 lower-case letters, digits or hyphens, starting with a letter"));
const names = (v: unknown, field: string, max: number, one: (x: unknown, f: string) => string): string[] => {
  if (!Array.isArray(v)) return invalid(field, "must be a list");
  if (v.length > max) return invalid(field, `must have at most ${max} entries`);
  const out = v.map((x, i) => one(x, `${field}[${i}]`));
  if (new Set(out).size !== out.length) invalid(field, "must not repeat an entry");
  return out;
};
const word = (v: unknown, field: string): string => text(v, field, { min: 1, max: AGENT_LIMITS.word });
const action = (v: unknown, field: string): string => (typeof v === "string" && v.length <= AGENT_LIMITS.word && ACTION.test(v) ? v : invalid(field, "must be an action name such as task.create, a prefix such as task.*, or *"));

/** Fields of an agent that can be changed by `update`; `null` clears an optional one. */
const AGENT_FIELDS = ["friendlyName", "roles", "teamId", "supervisorId", "defaultProfile", "permittedOverrides", "environment", "persona"] as const;

/**
 * Agent, team and role records (card H11). An agent has a durable computer-assigned ID (made from its creating command, so a retry names the same agent and no one chooses or
 * guesses one), a friendly name that may change or repeat, roles, a team and a supervisor, and its own identity for authentication (`agent:<ID>`, so a rename moves nothing:
 * desk records, grants, queued work and history stay with the same identity). Retired IDs are never reused: a retired agent stays as a record.
 *
 * Organisation is kept apart from authority and from work. A supervisor or team parent gets no write to a child's desk and no read of its scratch (card C01 decides that
 * from the record's owner), no toolbox or release authority, and moving an agent in the hierarchy changes only the agent's own record: no task dependency or assignment is
 * touched. Role names grant nothing; persona text is not read by any permission check. Managing needs the owner or an `agent.manage` grant; a manager creates agents with
 * no grants, so managing agents cannot be used to widen anyone's authority.
 */
export class AgentService {
  readonly #runner: CommandRunner;
  readonly #scanLimit: number;

  private constructor(runner: CommandRunner, scanLimit: number) { this.#runner = runner; this.#scanLimit = scanLimit; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: AgentOptions = {}): AgentService {
    return new AgentService(new CommandRunner(storage, epoch, options), options.scanLimit ?? AGENT_LIMITS.scan);
  }

  // ---- roles ----------------------------------------------------------------------------------------------------------------

  /**
   * Defines a role template. Without `expectedRevision` it creates the role (a name already defined is refused); with it, it replaces the role. A change that would put two
   * conflicting roles on one active agent is refused.
   */
  async defineRole(by: Principal, command: NoActor & { name: string; capabilities: readonly string[]; excludes?: readonly string[]; description?: string; expectedRevision?: number }): Promise<CommandResult> {
    this.#requireManage(by);
    return this.#command(by, "role.define", command, async () => {
      onlyKnown(command, ["commandId", "name", "capabilities", "excludes", "description", "expectedRevision"]);
      const name = roleName(command.name, "name");
      const body: RoleBody = {
        name,
        capabilities: names(command.capabilities, "capabilities", AGENT_LIMITS.capabilities, action),
        excludes: names(command.excludes ?? [], "excludes", AGENT_LIMITS.excludes, roleName),
        ...(command.description === undefined ? {} : { description: text(command.description, "description", { min: 1, max: AGENT_LIMITS.description }) }),
      };
      if (body.excludes.includes(name)) invalid("excludes", "a role cannot exclude itself");
      const revision = command.expectedRevision;
      return {
        payload: { name, capabilities: [...body.capabilities], excludes: [...body.excludes], description: body.description ?? null, expectedRevision: revision ?? null },
        build: async () => {
          const ref: AggregateRef = { kind: "role", id: name };
          if (revision === undefined) return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { role: name }, contention: async () => ((await this.#runner.get("role", name)) === undefined ? raced() : new DomainError("command_conflict", `role ${name} is already defined; send the revision to replace it`)) };
          const current = await this.#runner.existing("role", name, revision);
          await this.#checkRoleChange(name, body);
          const label = (current.body as unknown as RoleBody).label;
          const next: RoleBody = label === undefined ? body : { ...body, label };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { role: name } };
        },
      };
    });
  }

  /** Sets or clears the owner's label for a role (card H11b). Owner only; the label is display only and changes nothing else about the role. */
  async setRoleLabel(by: Principal, command: NoActor & { name: string; label: string | null; expectedRevision?: number }): Promise<CommandResult> {
    if (by.kind !== "owner") throw new DomainError("forbidden", "only the owner sets a role label");
    return this.#command(by, "role.label", command, async () => {
      onlyKnown(command, ["commandId", "name", "label", "expectedRevision"]);
      const name = roleName(command.name, "name");
      if (typeof command.label === "string" && /[\p{Cf}\p{Cc}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u3164\u115F\u1160\uFFA0\u2800]/u.test(command.label)) throw new DomainError("invalid_command", "label: may not contain invisible or direction-changing characters", { field: "label" });
      const label = command.label === null ? null : text(command.label, "label", { min: 1, max: AGENT_LIMITS.label });
      return {
        payload: { name, label, expectedRevision: command.expectedRevision ?? null },
        build: async () => {
          const found = await this.#runner.get("role", name);
          if (found === undefined) throw new DomainError("not_found", `role ${name} is not defined`);
          const { label: _old, ...rest } = found.body as unknown as RoleBody;
          const ref: AggregateRef = { kind: "role", id: name };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: command.expectedRevision ?? found.revision, body: (label === null ? rest : { ...rest, label }) as unknown as JsonObject }], detail: { role: name } };
        },
      };
    });
  }

  /**
   * Defines the standard role templates that are not defined yet (card H11b). Run by the controller when it starts, so a new installation has them; a role the owner defined under the same name first is left as it is, and a later start does
   * nothing. It is not an act of any principal and grants nothing.
   */
  async seedStandardRoles(): Promise<void> {
    // The command ID follows the list of standard roles, so a release that adds one seeds it instead of meeting the old digest.
    const listed = STANDARD_ROLES.map((r) => r.name).join(",");
    await this.#runner.command("role.seed", { commandId: `role-seed-${createHash("sha256").update(listed).digest("hex").slice(0, 16)}`, actor: "system" }, async () => ({
      payload: { roles: listed },
      build: async () => {
        const changes: Change[] = [];
        for (const r of STANDARD_ROLES) {
          if ((await this.#runner.get("role", r.name)) !== undefined) continue;
          const body: RoleBody = { name: r.name, capabilities: [...r.capabilities], excludes: [], description: r.description };
          changes.push({ type: "create", ref: { kind: "role", id: r.name }, body: body as unknown as JsonObject });
        }
        const registry = await this.#runner.get("org-registry", "org");
        const ref: AggregateRef = { kind: "org-registry", id: "org" };
        const n = registry === undefined ? 0 : (registry.body as unknown as { n: number }).n;
        changes.push(registry === undefined ? { type: "create", ref, body: { n: 1 } } : { type: "update", ref, expectedRevision: registry.revision, body: { n: n + 1 } });
        return { ref, creates: false, changes, detail: { seeded: changes.length - 1 }, contention: async () => raced() };
      },
    }));
  }

  /** No active agent may end up holding two roles that conflict because of this role's new definition. */
  async #checkRoleChange(name: string, next: RoleBody): Promise<void> {
    const roles = new Map<string, RoleBody>([[name, next]]);
    for (const agent of await this.#all("agent")) {
      const body = agent.body as unknown as AgentBody;
      if (body.state !== "active" || !body.roles.includes(name)) continue;
      for (const r of body.roles) if (!roles.has(r)) roles.set(r, (await this.#runner.get("role", r))?.body as unknown as RoleBody);
      const conflict = conflictIn(body.roles, roles);
      if (conflict !== undefined) invalid("excludes", `would put ${conflict[0]} and ${conflict[1]} together on ${agent.id}`);
    }
  }

  async getRole(by: Principal, name: string): Promise<View<RoleBody> | undefined> {
    this.#requireRead(by);
    const found = await this.#runner.get("role", roleName(name, "name"));
    return found === undefined ? undefined : view<RoleBody>(found);
  }

  async listRoles(by: Principal, page: { afterId?: string; limit?: number } = {}): Promise<{ items: View<RoleBody>[]; next?: string }> {
    this.#requireRead(by);
    return this.#page<RoleBody>("role", page);
  }

  // ---- teams ----------------------------------------------------------------------------------------------------------------

  async createTeam(by: Principal, command: NoActor & { name: string; parentTeamId?: string }): Promise<CommandResult> {
    this.#requireManage(by);
    return this.#command(by, "team.create", command, async () => {
      onlyKnown(command, ["commandId", "name", "parentTeamId"]);
      const name = text(command.name, "name", { min: 1, max: AGENT_LIMITS.name });
      const parent = command.parentTeamId === undefined ? undefined : teamId(command.parentTeamId, "parentTeamId");
      return {
        payload: { name, parentTeamId: parent ?? null },
        build: async () => {
          if (parent !== undefined && (await this.#runner.get("team", parent)) === undefined) invalid("parentTeamId", "names no team");
          const id = derivedId("team", this.#commandIdOf(by, command.commandId));
          const ref: AggregateRef = { kind: "team", id };
          const body: TeamBody = { name, ...(parent === undefined ? {} : { parentTeamId: parent }) };
          return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { team: id } };
        },
      };
    });
  }

  /** Renames a team or moves it under another (`null` makes it a top-level team). A move that would make a team its own ancestor is refused. */
  async updateTeam(by: Principal, command: NoActor & { teamId: string; expectedRevision: number; name?: string; parentTeamId?: string | null }): Promise<CommandResult> {
    this.#requireManage(by);
    return this.#command(by, "team.update", command, async () => {
      onlyKnown(command, ["commandId", "teamId", "expectedRevision", "name", "parentTeamId"]);
      const id = teamId(command.teamId);
      const name = command.name === undefined ? undefined : text(command.name, "name", { min: 1, max: AGENT_LIMITS.name });
      const parent = command.parentTeamId === undefined || command.parentTeamId === null ? command.parentTeamId : teamId(command.parentTeamId, "parentTeamId");
      return {
        payload: { teamId: id, expectedRevision: command.expectedRevision, name: name ?? null, parentTeamId: parent === undefined ? "unchanged" : parent },
        build: async () => {
          const current = await this.#runner.existing("team", id, command.expectedRevision);
          const before = current.body as unknown as TeamBody;
          if (typeof parent === "string") {
            if ((await this.#runner.get("team", parent)) === undefined) invalid("parentTeamId", "names no team");
            let at: string | undefined = parent;
            for (let i = 0; at !== undefined; i++) {
              if (at === id) invalid("parentTeamId", "would make the team its own ancestor");
              if (i > AGENT_LIMITS.chain) invalid("parentTeamId", "the team hierarchy is too deep");
              at = ((await this.#runner.get("team", at))?.body as unknown as TeamBody | undefined)?.parentTeamId;
            }
          }
          const { parentTeamId: _drop, ...keep } = before;
          const next: TeamBody = { ...keep, ...(name === undefined ? {} : { name }), ...(parent === undefined ? (before.parentTeamId === undefined ? {} : { parentTeamId: before.parentTeamId }) : parent === null ? {} : { parentTeamId: parent }) };
          const ref: AggregateRef = { kind: "team", id };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { team: id } };
        },
      };
    });
  }

  async getTeam(by: Principal, id: string): Promise<View<TeamBody> | undefined> {
    this.#requireRead(by);
    const found = await this.#runner.get("team", teamId(id));
    return found === undefined ? undefined : view<TeamBody>(found);
  }

  async listTeams(by: Principal, page: { afterId?: string; limit?: number } = {}): Promise<{ items: View<TeamBody>[]; next?: string }> {
    this.#requireRead(by);
    return this.#page<TeamBody>("team", page);
  }

  // ---- agents ---------------------------------------------------------------------------------------------------------------

  /** Creates an agent and its identity (no grants, no credential: those are separate acts). */
  async create(by: Principal, command: NoActor & { friendlyName: string; roles?: readonly string[]; teamId?: string; supervisorId?: string; defaultProfile?: string; permittedOverrides?: readonly string[]; environment?: string; persona?: string }): Promise<CommandResult> {
    this.#requireManage(by);
    return this.#command(by, "agent.create", command, async () => {
      onlyKnown(command, ["commandId", ...AGENT_FIELDS]);
      const fields = parseFields(command, false);
      return {
        payload: { fields: fieldsPayload(fields) },
        build: async () => {
          const id = derivedId("agt", this.#commandIdOf(by, command.commandId));
          const body: AgentBody = { ...(await this.#resolved(id, undefined, fields)), state: "active", principalId: `agent:${id}`, createdBy: by.id };
          return this.#creation(id, body);
        },
      };
    });
  }

  /** A new agent with the same roles, team, supervisor, profile and environment as `sourceId`, and a new identity. */
  async clone(by: Principal, command: NoActor & { sourceId: string; friendlyName?: string }): Promise<CommandResult> {
    this.#requireManage(by);
    return this.#command(by, "agent.clone", command, async () => {
      onlyKnown(command, ["commandId", "sourceId", "friendlyName"]);
      const sourceId = agentId(command.sourceId, "sourceId");
      const friendlyName = command.friendlyName === undefined ? undefined : text(command.friendlyName, "friendlyName", { min: 1, max: AGENT_LIMITS.name });
      return {
        payload: { sourceId, friendlyName: friendlyName ?? null },
        build: async () => {
          const source = await this.#runner.get("agent", sourceId);
          if (source === undefined) throw new DomainError("not_found", `agent ${sourceId} does not exist`);
          const from = source.body as unknown as AgentBody;
          const id = derivedId("agt", this.#commandIdOf(by, command.commandId));
          const { friendlyName: _n, state: _s, principalId: _p, createdBy: _c, clonedFrom: _f, importedFrom: _i, ...keep } = from;
          const body: AgentBody = { ...keep, friendlyName: friendlyName ?? `${from.friendlyName} (copy)`.slice(0, AGENT_LIMITS.name), state: "active", principalId: `agent:${id}`, createdBy: by.id, clonedFrom: sourceId };
          await this.#resolved(id, undefined, parseFields(body as unknown as Record<string, unknown>, false));
          return this.#creation(id, body);
        },
      };
    });
  }

  /**
   * Brings in an agent record from elsewhere (another installation, an export). It always gets a new ID here; the source's ID is kept only as `importedFrom`. A source ID
   * that is one of this installation's own agents, or that was imported before, is a collision and is refused: identities are never merged.
   */
  async importAgent(by: Principal, command: NoActor & { sourceId: string; friendlyName: string; roles?: readonly string[]; defaultProfile?: string; permittedOverrides?: readonly string[]; environment?: string; persona?: string }): Promise<CommandResult> {
    this.#requireManage(by);
    return this.#command(by, "agent.import", command, async () => {
      onlyKnown(command, ["commandId", "sourceId", "friendlyName", "roles", "defaultProfile", "permittedOverrides", "environment", "persona"]);
      const sourceId = agentId(command.sourceId, "sourceId");
      const fields = parseFields(command, false);
      return {
        payload: { sourceId, fields: fieldsPayload(fields) },
        build: async () => {
          if ((await this.#runner.get("agent", sourceId)) !== undefined) throw new DomainError("invalid_command", `collision: ${sourceId} is already an agent of this installation, so it cannot be imported as another`, { field: "sourceId" });
          const id = derivedId("agt", this.#commandIdOf(by, command.commandId));
          const body: AgentBody = { ...(await this.#resolved(id, undefined, fields)), state: "active", principalId: `agent:${id}`, createdBy: by.id, importedFrom: sourceId };
          const marker: AggregateRef = { kind: "agent-import", id: sourceId };
          const built = this.#creation(id, body);
          return { ...built, changes: [...built.changes, { type: "create", ref: marker, body: { agentId: id } }], contention: async () => ((await this.#runner.get("agent-import", sourceId)) === undefined ? raced() : new DomainError("invalid_command", `collision: ${sourceId} was already imported`, { field: "sourceId" })) };
        },
      };
    });
  }

  /** Changes some fields of an agent (`null` clears an optional one). Only the agent's own record changes. A retired agent cannot be changed. */
  async update(by: Principal, command: NoActor & { agentId: string; expectedRevision: number; friendlyName?: string; roles?: readonly string[]; teamId?: string | null; supervisorId?: string | null; defaultProfile?: string | null; permittedOverrides?: readonly string[]; environment?: string | null; persona?: string | null }): Promise<CommandResult> {
    this.#requireManage(by);
    return this.#command(by, "agent.update", command, async () => {
      onlyKnown(command, ["commandId", "agentId", "expectedRevision", ...AGENT_FIELDS]);
      const id = agentId(command.agentId);
      const fields = parseFields(command, true);
      if (Object.keys(fields).length === 0) invalid("fields", "name at least one field to change");
      return {
        payload: { agentId: id, expectedRevision: command.expectedRevision, fields: fieldsPayload(fields) },
        build: async () => {
          const current = await this.#runner.existing("agent", id, command.expectedRevision);
          const before = current.body as unknown as AgentBody;
          if (before.state === "retired") invalid("agentId", "a retired agent cannot be changed");
          const next: AgentBody = { ...(await this.#resolved(id, before, fields)), state: "active", principalId: before.principalId, createdBy: before.createdBy, ...(before.clonedFrom === undefined ? {} : { clonedFrom: before.clonedFrom }), ...(before.importedFrom === undefined ? {} : { importedFrom: before.importedFrom }) };
          const ref: AggregateRef = { kind: "agent", id };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { agent: id, fields: Object.keys(fields).join(",") } };
        },
      };
    });
  }

  /** Retires an agent and disables its identity in the same step. Refused while active agents report to it: move them first. The ID is never reused. */
  async retire(by: Principal, command: NoActor & { agentId: string; expectedRevision: number }): Promise<CommandResult> {
    this.#requireManage(by);
    return this.#command(by, "agent.retire", command, async () => {
      onlyKnown(command, ["commandId", "agentId", "expectedRevision"]);
      const id = agentId(command.agentId);
      return {
        payload: { agentId: id, expectedRevision: command.expectedRevision },
        build: async () => {
          const current = await this.#runner.existing("agent", id, command.expectedRevision);
          const before = current.body as unknown as AgentBody;
          if (before.state === "retired") invalid("agentId", "the agent is already retired");
          for (const other of await this.#all("agent")) {
            const o = other.body as unknown as AgentBody;
            if (o.state === "active" && o.supervisorId === id) invalid("agentId", `${other.id} still reports to this agent; move it first`);
          }
          const ref: AggregateRef = { kind: "agent", id };
          const changes: Change[] = [{ type: "update", ref, expectedRevision: current.revision, body: { ...before, state: "retired" } as unknown as JsonObject }];
          const principal = await this.#runner.get("principal", before.principalId);
          if (principal !== undefined) changes.push({ type: "update", ref: { kind: "principal", id: principal.id }, expectedRevision: principal.revision, body: { ...(principal.body as unknown as PrincipalBody), state: "disabled" } as unknown as JsonObject });
          return { ref, creates: false, changes, detail: { agent: id } };
        },
      };
    });
  }

  /** The roles of the agent behind an `agent:<ID>` principal, for the controller's own checks (the approval policy, card A07g). Nothing for any other principal or an agent that does not exist. */
  async rolesOfPrincipal(principalId: string): Promise<readonly string[]> {
    if (typeof principalId !== "string" || !principalId.startsWith("agent:")) return [];
    const found = await this.#runner.get("agent", principalId.slice("agent:".length));
    const body = found?.body as unknown as AgentBody | undefined;
    return body === undefined || (body as { state?: string }).state !== "active" ? [] : body.roles;
  }

  /** One agent. The owner, a manager or reader, and the agent itself may ask; anyone else gets the answer a missing agent would get. */
  async get(by: Principal, id: string): Promise<View<AgentBody> | undefined> {
    const found = await this.#runner.get("agent", agentId(id));
    if (found === undefined || !this.#mayRead(by, found)) return undefined;
    return view<AgentBody>(found);
  }

  async list(by: Principal, query: { teamId?: string; state?: "active" | "retired"; afterId?: string; limit?: number } = {}): Promise<{ items: View<AgentBody>[]; next?: string }> {
    this.#requireRead(by);
    const limit = query.limit ?? 50;
    const items: View<AgentBody>[] = [];
    let after = query.afterId;
    let scanned = 0;
    for (;;) {
      const records = await this.#runner.list("agent", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const r of records) {
        scanned += 1;
        const b = r.body as unknown as AgentBody;
        after = r.id;
        if ((query.teamId === undefined || b.teamId === query.teamId) && (query.state === undefined || b.state === query.state)) items.push(view<AgentBody>(r));
        // A page ends when it is full or when this call has read as many records as it may; either way `next` says where to continue.
        if (items.length === limit || scanned >= this.#scanLimit) return { items, next: r.id };
      }
      if (records.length < 200) return { items };
    }
  }

  /** The capability bundle the agent's roles stand for: what the owner would grant, not what the agent holds. */
  async capabilitiesOf(by: Principal, id: string): Promise<readonly string[] | undefined> {
    const agent = await this.get(by, id);
    if (agent === undefined) return undefined;
    const all = new Set<string>();
    for (const r of agent.roles) for (const c of ((await this.#runner.get("role", r))?.body as unknown as RoleBody | undefined)?.capabilities ?? []) all.add(c);
    return [...all].sort();
  }

  // ---- shared parts ---------------------------------------------------------------------------------------------------------

  #creation(id: string, body: AgentBody) {
    const ref: AggregateRef = { kind: "agent", id };
    const principal: PrincipalBody = { kind: "agent", name: id, state: "active", grants: [], createdBy: body.createdBy };
    return {
      ref, creates: true,
      changes: [{ type: "create", ref, body: body as unknown as JsonObject }, { type: "create", ref: { kind: "principal", id: body.principalId }, body: principal as unknown as JsonObject }] as Change[],
      detail: { agent: id } as JsonObject,
    };
  }

  /** The agent's fields after the change, with every reference checked: roles defined and not conflicting, team and supervisor existing and active, no reporting cycle. */
  async #resolved(id: string, before: AgentBody | undefined, fields: Fields): Promise<Omit<AgentBody, "state" | "principalId" | "createdBy" | "clonedFrom" | "importedFrom">> {
    const pick = <K extends keyof Fields>(key: K, old: unknown): unknown => (key in fields ? fields[key] : old);
    const friendlyName = (pick("friendlyName", before?.friendlyName) as string | undefined) ?? invalid("friendlyName", "is required");
    const roles = (pick("roles", before?.roles) as readonly string[] | undefined) ?? [];
    const team = pick("teamId", before?.teamId) as string | null | undefined;
    const supervisor = pick("supervisorId", before?.supervisorId) as string | null | undefined;
    const profile = pick("defaultProfile", before?.defaultProfile) as string | null | undefined;
    const overrides = (pick("permittedOverrides", before?.permittedOverrides) as readonly string[] | undefined) ?? [];
    const environment = pick("environment", before?.environment) as string | null | undefined;
    const persona = pick("persona", before?.persona) as string | null | undefined;

    const defined = new Map<string, RoleBody>();
    for (const r of roles) {
      const found = await this.#runner.get("role", r);
      if (found === undefined) invalid("roles", `role ${r} is not defined`);
      defined.set(r, found!.body as unknown as RoleBody);
    }
    const conflict = conflictIn(roles, defined);
    if (conflict !== undefined) invalid("roles", `${conflict[0]} and ${conflict[1]} may not be held by the same agent`);
    if (typeof team === "string") {
      if ((await this.#runner.get("team", team)) === undefined) invalid("teamId", "names no team");
    }
    if (typeof supervisor === "string") {
      if (supervisor === id) invalid("supervisorId", "an agent cannot report to itself");
      let at: string | undefined = supervisor;
      for (let i = 0; at !== undefined; i++) {
        const found = await this.#runner.get("agent", at);
        const b = found?.body as unknown as AgentBody | undefined;
        if (b === undefined) invalid("supervisorId", at === supervisor ? "names no agent" : `${at} names no agent`);
        if (at === supervisor && b!.state !== "active") invalid("supervisorId", "names a retired agent");
        if (b!.supervisorId === id) invalid("supervisorId", "would make the agents report to each other, directly or through others");
        if (i > AGENT_LIMITS.chain) invalid("supervisorId", "the reporting chain is too deep");
        at = b!.supervisorId;
      }
    }
    return {
      friendlyName, roles, permittedOverrides: overrides,
      ...(typeof team === "string" ? { teamId: team } : {}), ...(typeof supervisor === "string" ? { supervisorId: supervisor } : {}),
      ...(typeof profile === "string" ? { defaultProfile: profile } : {}), ...(typeof environment === "string" ? { environment } : {}), ...(typeof persona === "string" ? { persona } : {}),
    };
  }

  #requireManage(by: Principal): void {
    if (!allows(by, "agent.manage", undefined)) throw new DomainError("forbidden", `${by.id} may not manage agents`);
  }
  #requireRead(by: Principal): void {
    if (!allows(by, "agent.read", undefined) && !allows(by, "agent.manage", undefined)) throw new DomainError("forbidden", `${by.id} may not read agent records`);
  }
  #mayRead(by: Principal, agent: { id: string; body: unknown }): boolean {
    return by.id === (agent.body as AgentBody).principalId || allows(by, "agent.read", undefined) || allows(by, "agent.manage", undefined);
  }
  /** The command ID as recorded: another principal's identical ID is a different command. */
  #commandIdOf(by: Principal, commandId: string): string { return scopedCommandId(by.id, commandId); }

  /**
   * Every command that changes the organisation (roles, teams, reporting lines, retirement) also updates one record, `org-registry`, at the revision it read before it looked at
   * anything else. So two such commands never both commit on what they saw: the second finds the registry moved and is told so (and tried again here), which is what keeps
   * the checks that read many records (no reporting cycle, no conflicting roles, no retirement under active reports) true when commands run at the same moment.
   */
  async #command<C extends NoActor>(by: Principal, type: string, command: C, prepare: () => Promise<{ payload: JsonObject; build: () => Promise<Built> }>): Promise<CommandResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#runner.command(type, { commandId: this.#commandIdOf(by, command.commandId), actor: by.id }, async () => {
          const prepared = await prepare();
          return { payload: prepared.payload, build: async () => {
            const registry = await this.#runner.get("org-registry", "org");
            const ref: AggregateRef = { kind: "org-registry", id: "org" };
            const n = registry === undefined ? 0 : (registry.body as unknown as { n: number }).n;
            const touch: Change = registry === undefined ? { type: "create", ref, body: { n: 1 } } : { type: "update", ref, expectedRevision: registry.revision, body: { n: n + 1 } };
            const built = await prepared.build();
            return { ...built, changes: [...built.changes, touch], contention: built.contention ?? (async () => raced()) };
          } };
        });
      } catch (error) {
        // Only losing the race on the registry is retried (it has no revision to report); a caller's own stale revision is final.
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || error.currentRevision !== undefined || attempt >= 8) throw error;
        await sleep(Math.round(Math.random() * 10 * attempt));
      }
    }
  }

  async #all(kind: string): Promise<{ id: string; revision: number; body: unknown }[]> {
    const out: { id: string; revision: number; body: unknown }[] = [];
    let after: string | undefined;
    for (;;) {
      const records = await this.#runner.list(kind, { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      out.push(...records);
      if (out.length > this.#scanLimit) throw new DomainError("unavailable", `there are more than ${this.#scanLimit} ${kind}s, too many to check safely`);
      if (records.length < 500) return out;
      after = records.at(-1)!.id;
    }
  }

  async #page<B>(kind: string, page: { afterId?: string; limit?: number }): Promise<{ items: View<B>[]; next?: string }> {
    const limit = page.limit ?? 50;
    const records = await this.#runner.list(kind, { ...(page.afterId === undefined ? {} : { afterId: page.afterId }), limit });
    const last = records.at(-1);
    return { items: records.map((r) => view<B>(r)), ...(records.length === limit && last !== undefined ? { next: last.id } : {}) };
  }
}

/** Lost a race with another change to the organisation: no revision to report, and the command is tried again. */
const raced = (): DomainError => new DomainError("stale_revision", "the organisation changed meanwhile; try again");

type Fields = Partial<Record<(typeof AGENT_FIELDS)[number], string | readonly string[] | null>>;

function parseFields(source: Record<string, unknown>, allowNull: boolean): Fields {
  const out: Fields = {};
  const optional = (key: "teamId" | "supervisorId" | "defaultProfile" | "environment" | "persona", parse: (v: unknown) => string): void => {
    const v = source[key];
    if (v === undefined) return;
    if (v === null) { if (!allowNull) invalid(key, "is not set on a new agent; leave it out"); out[key] = null; return; }
    out[key] = parse(v);
  };
  if (source["friendlyName"] !== undefined) out.friendlyName = text(source["friendlyName"], "friendlyName", { min: 1, max: AGENT_LIMITS.name });
  if (source["roles"] !== undefined) out.roles = names(source["roles"], "roles", AGENT_LIMITS.roles, roleName);
  if (source["permittedOverrides"] !== undefined) out.permittedOverrides = names(source["permittedOverrides"], "permittedOverrides", AGENT_LIMITS.overrides, word);
  optional("teamId", (v) => teamId(v));
  optional("supervisorId", (v) => agentId(v, "supervisorId"));
  optional("defaultProfile", (v) => word(v, "defaultProfile"));
  optional("environment", (v) => word(v, "environment"));
  optional("persona", (v) => text(v, "persona", { min: 1, max: AGENT_LIMITS.persona, multiline: true }));
  return out;
}
const fieldsPayload = (f: Fields): JsonObject => JSON.parse(JSON.stringify(f)) as JsonObject;

/** The first pair of roles that may not be held together (either one excludes the other), or undefined. */
function conflictIn(roles: readonly string[], defined: ReadonlyMap<string, RoleBody>): [string, string] | undefined {
  for (const a of roles) for (const b of roles) if (a !== b && (defined.get(a)?.excludes ?? []).includes(b)) return [a, b];
  return undefined;
}

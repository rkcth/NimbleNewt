import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";

/** Where finished work lands (card P08, owner decision 2026-10-28; all three are supported). */
export const LANDINGS = ["integration-branch", "main-automatic", "human-promotes"] as const;
export type Landing = (typeof LANDINGS)[number];
export const INTEGRATORS = ["agent", "human"] as const;
export type Integrator = (typeof INTEGRATORS)[number];
/** The checks a landing may require; each is run or collected by a later card (P09). */
export const CHECKS = ["tests", "review", "qa", "docs", "director"] as const;
export type Check = (typeof CHECKS)[number];

export interface IntegrationSettings {
  /** `integration-branch`: finished work lands on the integration branch only. `main-automatic`: it is promoted to main with no human step once the required checks pass. `human-promotes`: a human promotes it. */
  readonly landing: Landing;
  /** Who integrates the submissions of the project's agents: its integrator agent, or a human. */
  readonly integrator: Integrator;
  readonly requiredChecks: readonly Check[];
  /** How many times an author refreshes its checkout before the integrator takes over (card H12p). */
  readonly refreshRounds: number;
}

export interface IntegrationBody extends IntegrationSettings {
  /** Where the values came from when the record was made: the owner's own setting for the project, the installation default for new projects, or the approval profile. */
  readonly source: "owner" | "installation-default" | "profile";
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface IntegrationDefaultBody extends Partial<IntegrationSettings> {
  /** The installation lock: no project may use `main-automatic` while it is set; it wins over every project setting (card U10's lock rule). */
  readonly forbidMainAutomatic?: boolean;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/** What the approval profile gives a project that has no setting and no installation default. Strict asks a human to promote; the others land on the integration branch and let the checks decide. */
export function profileDefaults(profile: string): IntegrationSettings {
  if (profile === "autonomous") return { landing: "integration-branch", integrator: "agent", requiredChecks: ["tests"], refreshRounds: 3 };
  if (profile === "derived") return { landing: "integration-branch", integrator: "agent", requiredChecks: ["tests", "review"], refreshRounds: 3 };
  return { landing: "human-promotes", integrator: "agent", requiredChecks: ["tests", "review"], refreshRounds: 3 };
}

const PROJECT_ID = /^proj-[a-z2-7]{20}$/;
const KIND = "integration-policy";
const DEFAULT_REF: AggregateRef = { kind: "integration-default", id: "main" };
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

function parse(command: Record<string, unknown>, fields: readonly string[]): Partial<IntegrationSettings> & { forbidMainAutomatic?: boolean } {
  const out: { landing?: Landing; integrator?: Integrator; requiredChecks?: Check[]; refreshRounds?: number; forbidMainAutomatic?: boolean } = {};
  for (const key of Object.keys(command)) if (!["commandId", "projectId", "expectedRevision", ...fields].includes(key)) invalid(key, "is not a field of this command");
  if (command["landing"] !== undefined) out.landing = (LANDINGS as readonly unknown[]).includes(command["landing"]) ? (command["landing"] as Landing) : invalid("landing", `must be ${LANDINGS.join(", ")}`);
  if (command["integrator"] !== undefined) out.integrator = (INTEGRATORS as readonly unknown[]).includes(command["integrator"]) ? (command["integrator"] as Integrator) : invalid("integrator", `must be ${INTEGRATORS.join(" or ")}`);
  if (command["requiredChecks"] !== undefined) {
    const list = command["requiredChecks"];
    if (!Array.isArray(list) || list.length > CHECKS.length || list.some((c) => !(CHECKS as readonly unknown[]).includes(c))) invalid("requiredChecks", `must be a list of ${CHECKS.join(", ")}`);
    out.requiredChecks = [...new Set(list as Check[])].sort((a, b) => CHECKS.indexOf(a) - CHECKS.indexOf(b));
  }
  if (command["refreshRounds"] !== undefined) {
    const n = command["refreshRounds"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 10) invalid("refreshRounds", "must be a whole number from 0 to 10");
    out.refreshRounds = n as number;
  }
  if (command["forbidMainAutomatic"] !== undefined) out.forbidMainAutomatic = typeof command["forbidMainAutomatic"] === "boolean" ? command["forbidMainAutomatic"] : invalid("forbidMainAutomatic", "must be true or false");
  return out;
}

/**
 * The integration policy of each project and the installation's default for new ones (card P08). A project's record is made when it is created, from the installation default where the owner set one and from the approval
 * profile otherwise, and keeps its values: a later change of the profile or of the default changes no existing project. Only the owner writes either record. Precedence: the installation lock (`forbidMainAutomatic`), then the
 * project's own setting, then the installation default, then the profile. The checks and the landing themselves are carried out by later cards (P09, P10); this is where their rules are kept.
 */
export class IntegrationPolicyService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): IntegrationPolicyService {
    return new IntegrationPolicyService(new CommandRunner(storage, epoch, options));
  }

  /** Makes the project's record if it has none (a no-op otherwise), from the installation default or the profile. Called when a project is created and when the policy is first read. */
  async ensure(projectId: string): Promise<void> {
    const id = this.#id(projectId);
    if ((await this.#runner.get(KIND, id)) !== undefined) return;
    if ((await this.#runner.get("project", id)) === undefined) throw new DomainError("not_found", `project ${id} does not exist`);
    try {
      await this.#runner.command("integration.ensure", { commandId: `integration-ensure-${id}`, actor: "system" }, async () => ({
        payload: { projectId: id },
        build: async () => {
          const def = (await this.#runner.get(DEFAULT_REF.kind, DEFAULT_REF.id))?.body as unknown as IntegrationDefaultBody | undefined;
          const base = profileDefaults(await this.#profile());
          const merged = this.#coerce({ landing: def?.landing ?? base.landing, integrator: def?.integrator ?? base.integrator, requiredChecks: def?.requiredChecks ?? base.requiredChecks, refreshRounds: def?.refreshRounds ?? base.refreshRounds }, def?.forbidMainAutomatic === true);
          const usesDefault = def?.landing !== undefined || def?.integrator !== undefined || def?.requiredChecks !== undefined || def?.refreshRounds !== undefined;
          const body: IntegrationBody = { ...merged, source: usesDefault ? "installation-default" : "profile", updatedBy: "system", updatedAt: this.#runner.now() };
          const ref: AggregateRef = { kind: KIND, id };
          return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { projectId: id, landing: body.landing, source: body.source } };
        },
      }));
    } catch (error) {
      // Two creators at the same moment: the first record stands.
      if (!(error instanceof DomainError) || (error.code !== "command_conflict" && error.code !== "stale_revision")) throw error;
    }
  }

  /** The project's policy as it stands (owner only). It makes the record first if the project has none. */
  async get(owner: Principal, projectId: string): Promise<IntegrationSettings & { revision: number; source: string; lockedMainAutomatic: boolean }> {
    this.#owner(owner, "read");
    await this.ensure(projectId);
    const found = (await this.#runner.get(KIND, this.#id(projectId)))!;
    const body = found.body as unknown as IntegrationBody;
    const locked = await this.#locked();
    const settings = this.#coerce(body, locked);
    return { ...settings, revision: found.revision, source: body.source, lockedMainAutomatic: locked };
  }

  /** The owner changes the project's policy; fields left out stay. A landing of `main-automatic` is refused while the installation lock is set. */
  async set(owner: Principal, command: NoActor & { projectId: string; landing?: Landing; integrator?: Integrator; requiredChecks?: readonly Check[]; refreshRounds?: number; expectedRevision?: number }): Promise<{ revision: number }> {
    this.#owner(owner, "change");
    const changes = parse(command as unknown as Record<string, unknown>, ["landing", "integrator", "requiredChecks", "refreshRounds"]);
    if (Object.keys(changes).length === 0) invalid("landing", "name what to change: landing, integrator, requiredChecks or refreshRounds");
    const id = this.#id(command.projectId);
    await this.ensure(id);
    if (changes.landing === "main-automatic" && (await this.#locked())) throw new DomainError("forbidden", "the installation forbids landing on main automatically; the owner lifts that lock first");
    const result = await this.#runner.command("integration.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { projectId: id, ...(changes as unknown as JsonObject), expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = (await this.#runner.get(KIND, id))!;
        if (command.expectedRevision !== undefined && current.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the integration policy is at revision ${current.revision}, not ${command.expectedRevision}`);
        const before = current.body as unknown as IntegrationBody;
        const next: IntegrationBody = { landing: changes.landing ?? before.landing, integrator: changes.integrator ?? before.integrator, requiredChecks: changes.requiredChecks ?? before.requiredChecks, refreshRounds: changes.refreshRounds ?? before.refreshRounds, source: "owner", updatedBy: owner.id, updatedAt: this.#runner.now() };
        const ref: AggregateRef = { kind: KIND, id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { projectId: id, landing: next.landing, from: before.landing } };
      },
    }));
    return { revision: result.revision };
  }

  /** The installation default for new projects, and the lock (owner only). */
  async getDefault(owner: Principal): Promise<Partial<IntegrationSettings> & { revision: number; forbidMainAutomatic: boolean }> {
    this.#owner(owner, "read");
    const found = await this.#runner.get(DEFAULT_REF.kind, DEFAULT_REF.id);
    const body = found?.body as unknown as IntegrationDefaultBody | undefined;
    const { updatedBy: _by, updatedAt: _at, forbidMainAutomatic, ...settings } = body ?? ({} as IntegrationDefaultBody);
    void _by; void _at;
    return { ...settings, revision: found?.revision ?? 0, forbidMainAutomatic: forbidMainAutomatic === true };
  }

  /** The owner sets what new projects start with, and may set the lock. Existing projects are not touched. */
  async setDefault(owner: Principal, command: NoActor & { landing?: Landing; integrator?: Integrator; requiredChecks?: readonly Check[]; refreshRounds?: number; forbidMainAutomatic?: boolean; expectedRevision?: number }): Promise<{ revision: number }> {
    this.#owner(owner, "change");
    const changes = parse(command as unknown as Record<string, unknown>, ["landing", "integrator", "requiredChecks", "refreshRounds", "forbidMainAutomatic"]);
    if (Object.keys(changes).length === 0) invalid("landing", "name what to change");
    const result = await this.#runner.command("integration.default.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { ...(changes as unknown as JsonObject), expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(DEFAULT_REF.kind, DEFAULT_REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the default is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`);
        const before = current?.body as unknown as IntegrationDefaultBody | undefined;
        const forbid = changes.forbidMainAutomatic ?? before?.forbidMainAutomatic;
        const landing = changes.landing ?? before?.landing;
        if (landing === "main-automatic" && forbid === true) throw new DomainError("invalid_command", "landing: the default cannot be main-automatic while main-automatic is forbidden", { field: "landing" });
        const next: IntegrationDefaultBody = { ...(landing === undefined ? {} : { landing }), ...((changes.integrator ?? before?.integrator) === undefined ? {} : { integrator: changes.integrator ?? before!.integrator! }), ...((changes.requiredChecks ?? before?.requiredChecks) === undefined ? {} : { requiredChecks: changes.requiredChecks ?? before!.requiredChecks! }), ...((changes.refreshRounds ?? before?.refreshRounds) === undefined ? {} : { refreshRounds: changes.refreshRounds ?? before!.refreshRounds! }), ...(forbid === undefined ? {} : { forbidMainAutomatic: forbid }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: DEFAULT_REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: DEFAULT_REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: DEFAULT_REF, creates: current === undefined, changes: [change], detail: { landing: next.landing ?? null, forbidMainAutomatic: next.forbidMainAutomatic === true } };
      },
    }));
    return { revision: result.revision };
  }

  /** The effective settings: a project stored as main-automatic is held at the integration branch while the installation lock is set. */
  #coerce(s: IntegrationSettings, locked: boolean): IntegrationSettings {
    return { landing: locked && s.landing === "main-automatic" ? "integration-branch" : s.landing, integrator: s.integrator, requiredChecks: [...s.requiredChecks], refreshRounds: s.refreshRounds };
  }

  async #locked(): Promise<boolean> {
    return ((await this.#runner.get(DEFAULT_REF.kind, DEFAULT_REF.id))?.body as unknown as IntegrationDefaultBody | undefined)?.forbidMainAutomatic === true;
  }

  async #profile(): Promise<string> {
    try { return ((await this.#runner.get("approval-policy", "installation"))?.body as unknown as { profile?: string } | undefined)?.profile ?? "strict"; } catch { return "strict"; }
  }

  #owner(by: Principal, what: string): void {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not ${what} the integration policy`);
  }

  #id(projectId: unknown): string {
    if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) return invalid("projectId", "is not a project ID");
    return projectId;
  }
}

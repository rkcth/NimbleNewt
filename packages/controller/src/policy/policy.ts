import { DomainError } from "../domain/errors.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import { GrantService, type GrantRecordBody } from "../security/grants.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { ActionCatalog, ENVIRONMENTS, tierOf, type ActionClass, type Environment } from "./catalog.js";
import { CELL_KEYS, MODES, PROFILE_TABLES, PROFILES, evaluate, tightness, type CellKey, type Decision, type GrantView, type Mode, type PolicyRequest, type PolicyView, type Profile } from "./engine.js";

/** One approval policy record: the installation's (profile, all-command gate, locks) or a project's (environment, overrides). */
export interface PolicyBody {
  /** The installation's profile. Absent in a project's record: the profile is installation-wide. */
  readonly profile?: Profile;
  readonly allCommandGate?: boolean;
  /** A project's environment: where its work runs by default (development when absent). */
  readonly environment?: Environment;
  /** Cells set away from the profile's table. */
  readonly overrides: Readonly<Record<string, Mode>>;
  /** The installation's locks: cells (or `gate`) a project cannot make looser. */
  readonly locked: readonly string[];
  readonly history: readonly { readonly revision: number; readonly at: string; readonly by: string; readonly summary: string }[];
}

export interface SetPolicy extends NoActor {
  /** `installation` or a project ID. */
  readonly scope: string;
  /** Without it the record is created; with it, it must be at that revision. */
  readonly expectedRevision?: number;
  readonly profile?: Profile;
  readonly allCommandGate?: boolean;
  readonly environment?: Environment;
  /** A cell to a mode, or `null` to return it to the profile's table. */
  readonly overrides?: Readonly<Record<string, Mode | null>>;
  readonly lock?: readonly string[];
  readonly unlock?: readonly string[];
}

export interface EffectiveCell { readonly mode: Mode; readonly source: "profile" | "installation override" | "project override" | "locked by the installation"; readonly locked: boolean }
export interface EffectivePolicy {
  readonly profile: Profile;
  readonly allCommandGate: boolean;
  readonly environment: Environment;
  readonly mandatoryHuman: readonly string[];
  readonly cells: Readonly<Record<string, EffectiveCell>>;
  readonly revisions: { readonly installation: number; readonly project?: number };
  /** When a change starts to count: policy is read at every evaluation, and a command waiting for approval is checked again as it runs. */
  readonly takesEffect: "next evaluation";
  /** For a principal asked about: the grants it holds and the restrictions on it, with their terms. */
  readonly grants?: readonly { id: string; action: string; project: string; terms?: unknown; expiresAt?: string }[];
  readonly restrictions?: readonly { action: string; project: string; reason?: string }[];
}

export interface PolicyChange { readonly cell: string; readonly from: Mode; readonly to: Mode }
export interface PolicyPreview {
  readonly changes: readonly PolicyChange[];
  readonly loosened: readonly PolicyChange[];
  readonly tightened: readonly PolicyChange[];
  /** Plain sentences about what would now run without asking, for the owner to read before applying. */
  readonly notes: readonly string[];
}

export interface EvaluateInput {
  readonly principalId: string;
  readonly projectId: string;
  readonly tool: string;
  readonly targetKind?: string;
  readonly environment?: Environment;
  readonly estimatedSpend?: number;
  readonly branchProtected?: boolean;
  readonly audience?: string;
  readonly irreversible?: boolean;
  /** The task the action is for. Its stored contract gives the instruction's scope (the permission ceiling, who set it, and the estimate); the caller cannot supply those. */
  readonly taskId?: string;
  /** What the task has spent so far (from budget accounting), so the estimate left can be worked out. */
  readonly spentSoFar?: number;
}

/** A policy record being edited. */
interface Draft { profile?: Profile; allCommandGate?: boolean; environment?: Environment; overrides: Record<string, Mode>; locked: string[]; history: PolicyBody["history"] }

const INSTALLATION: AggregateRef = { kind: "approval-policy", id: "installation" };
const HISTORY = 40;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const isCell = (key: string): key is CellKey => (CELL_KEYS as readonly string[]).includes(key);

/**
 * The approval policy (card A07): which actions run, which go to an independent agent for review, and which ask the owner, by class of action and environment. A new installation starts in the
 * strict profile; the owner can choose derived (which leans toward less asking, and lets an instruction's scope authorize what it needs) or autonomous, set cells away from a profile, lock cells
 * so no project loosens them, mark a project's environment, and switch on the all-command gate. Every evaluation reads the policy as it is now, so a change counts at the next request and a
 * command already waiting for approval is judged again as it runs. The engine (`evaluate`) is a pure function; this service holds the records and gathers what the engine needs.
 */
export class PolicyService {
  readonly #runner: CommandRunner;
  readonly #grants: GrantService;
  readonly #catalog: ActionCatalog;

  private constructor(runner: CommandRunner, grants: GrantService, catalog: ActionCatalog) {
    this.#runner = runner; this.#grants = grants; this.#catalog = catalog;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, grants: GrantService, options: RunnerOptions & { catalog?: ActionCatalog } = {}): PolicyService {
    return new PolicyService(new CommandRunner(storage, epoch, options), grants, options.catalog ?? ActionCatalog.default);
  }

  /** The owner changes the installation's policy or one project's. */
  async set(owner: Principal, command: SetPolicy): Promise<{ revision: number; replayed: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner sets the approval policy`);
    onlyKnown(command, ["commandId", "scope", "expectedRevision", "profile", "allCommandGate", "environment", "overrides", "lock", "unlock"]);
    const scope = command.scope === "installation" ? "installation" : checkProjectId(command.scope);
    const expected = command.expectedRevision === undefined ? undefined : checkRevision(command.expectedRevision);
    if (command.profile !== undefined && !PROFILES.includes(command.profile)) invalid("profile", `must be ${PROFILES.join(", ")}`);
    if (command.allCommandGate !== undefined && typeof command.allCommandGate !== "boolean") invalid("allCommandGate", "must be true or false");
    if (command.environment !== undefined && !ENVIRONMENTS.includes(command.environment)) invalid("environment", `must be ${ENVIRONMENTS.join(", ")}`);
    if (scope === "installation" && command.environment !== undefined) invalid("environment", "belongs to a project, not the installation");
    if (scope !== "installation" && (command.profile !== undefined || command.lock !== undefined || command.unlock !== undefined)) invalid("profile", "the profile and the locks belong to the installation");
    const overrides = command.overrides ?? {};
    if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) invalid("overrides", "must be an object of cells and modes");
    for (const [key, mode] of Object.entries(overrides)) {
      if (!isCell(key)) invalid(`overrides.${key}`, `is not a cell; a cell is a class and a tier such as deploy.live (classes ${ACTION_CLASSES_TEXT})`);
      if (mode !== null && !MODES.includes(mode)) invalid(`overrides.${key}`, `must be ${MODES.join(", ")} or null`);
    }
    const keyList = (v: unknown, field: string): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > 100) return invalid(field, "must be a list of cells");
      return [...new Set(v.map((k) => (typeof k === "string" && (isCell(k) || k === "gate") ? k : invalid(field, `${String(k)} is not a cell or gate`))))];
    };
    const lock = keyList(command.lock, "lock"); const unlock = keyList(command.unlock, "unlock");
    const id = scope === "installation" ? INSTALLATION.id : scope;
    const r = await this.#runner.command("policy.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { scope, expectedRevision: expected ?? null, profile: command.profile ?? null, allCommandGate: command.allCommandGate ?? null, environment: command.environment ?? null, overrides: overrides as JsonObject, lock, unlock },
      build: async () => {
        if (scope !== "installation" && (await this.#runner.get("project", scope)) === undefined) throw new DomainError("not_found", `project ${scope} does not exist`);
        const ref: AggregateRef = { kind: "approval-policy", id };
        const current = await this.#runner.get("approval-policy", id);
        if ((current === undefined ? undefined : current.revision) !== expected) throw new DomainError("stale_revision", `the ${scope} policy is at revision ${current?.revision ?? 0}, not ${expected ?? 0}`, ...(current === undefined ? [] : [{ currentRevision: current.revision }]));
        const old = (current?.body as unknown as PolicyBody | undefined) ?? { overrides: {}, locked: [], history: [] };
        const next: Draft = { ...old, overrides: { ...old.overrides }, locked: [...old.locked] };
        const parts: string[] = [];
        if (command.profile !== undefined) { next.profile = command.profile; parts.push(`profile ${command.profile}`); }
        if (command.allCommandGate !== undefined) { next.allCommandGate = command.allCommandGate; parts.push(`all-command gate ${command.allCommandGate ? "on" : "off"}`); }
        if (command.environment !== undefined) { next.environment = command.environment; parts.push(`environment ${command.environment}`); }
        if (scope !== "installation") {
          // A project cannot make a cell looser than the installation's locked cell, nor undo a locked gate.
          const inst = await this.#installation();
          for (const [key, mode] of Object.entries(overrides)) {
            if (mode !== null && inst.locked.includes(key) && tightness(mode) < tightness(this.#cell(inst, key as CellKey))) throw new DomainError("forbidden", `${key} is locked by the installation at ${this.#cell(inst, key as CellKey)}; a project cannot make it looser`, { field: `overrides.${key}` });
          }
          if (command.allCommandGate === false && inst.locked.includes("gate") && inst.allCommandGate === true) throw new DomainError("forbidden", "the all-command gate is locked on by the installation", { field: "allCommandGate" });
        }
        for (const [key, mode] of Object.entries(overrides)) { if (mode === null) delete next.overrides[key]; else next.overrides[key] = mode; parts.push(`${key} ${mode ?? "back to the profile"}`); }
        for (const k of lock) { if (!next.locked.includes(k)) next.locked.push(k); parts.push(`locked ${k}`); }
        for (const k of unlock) { next.locked = next.locked.filter((x) => x !== k); parts.push(`unlocked ${k}`); }
        if (parts.length === 0) invalid("profile", "nothing to change");
        next.history = [...old.history, { revision: (current?.revision ?? 0) + 1, at: this.#runner.now(), by: owner.id, summary: parts.join("; ").slice(0, 300) }].slice(-HISTORY);
        return { ref, creates: current === undefined, changes: [current === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { scope, changed: parts.length } };
      },
    }));
    return { revision: r.revision, replayed: r.replayed };
  }

  /** One policy record as stored (owner, or a principal that may read configuration). */
  async get(by: Principal, scope: string): Promise<View<PolicyBody> | undefined> {
    if (!(await this.#mayRead(by))) return undefined;
    const id = scope === "installation" ? INSTALLATION.id : checkProjectId(scope);
    const found = await this.#runner.get("approval-policy", id);
    return found === undefined ? undefined : view<PolicyBody>(found);
  }

  /**
   * The policy in force for the installation or a project: the profile, every cell's mode with where it comes from and whether it is locked, the tools reserved for the owner (from the review
   * policy), and, for a principal asked about, the grants it holds and the restrictions on it. Readable by the owner and those who may read configuration.
   */
  async effective(by: Principal, projectId?: string, about?: string): Promise<EffectivePolicy | undefined> {
    if (!(await this.#mayRead(by))) return undefined;
    const project = projectId === undefined ? undefined : checkProjectId(projectId);
    const inst = await this.#installationRecord();
    const proj = project === undefined ? undefined : await this.#runner.get("approval-policy", project);
    const view_ = this.#view(inst.body, proj?.body as unknown as PolicyBody | undefined, await this.#reserved(project));
    const cells: Record<string, EffectiveCell> = {};
    const profile = inst.body.profile ?? "strict";
    for (const key of CELL_KEYS) {
      const locked = inst.body.locked.includes(key);
      const p = (proj?.body as unknown as PolicyBody | undefined)?.overrides[key];
      const i = inst.body.overrides[key];
      const base = PROFILE_TABLES[profile][key.slice(0, key.lastIndexOf(".")) as ActionClass][key.slice(key.lastIndexOf(".") + 1) as "free" | "guarded" | "live"];
      let source: EffectiveCell["source"] = i === undefined ? "profile" : "installation override";
      if (p !== undefined) source = "project override";
      if (locked && p !== undefined && tightness(p) < tightness(i ?? base)) source = "locked by the installation";
      cells[key] = { mode: view_.cells[key], source, locked };
    }
    const out: { -readonly [K in keyof EffectivePolicy]: EffectivePolicy[K] } = {
      profile, allCommandGate: view_.allCommandGate, environment: (proj?.body as unknown as PolicyBody | undefined)?.environment ?? "development", mandatoryHuman: view_.mandatoryHuman, cells,
      revisions: { installation: inst.revision, ...(proj === undefined ? {} : { project: proj.revision }) }, takesEffect: "next evaluation",
    };
    if (about !== undefined) {
      const held = await this.#grants.held(about, this.#runner.now());
      out.grants = held.map(({ id, body }) => ({ id, action: body.action, project: body.project, ...(body.terms === undefined ? {} : { terms: body.terms }), ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }) }));
      const principal = await this.#principal(about);
      out.restrictions = principal === undefined ? [] : ((await this.#grants.effective(principal, this.#runner.now())).restrictions ?? []).map((r) => ({ action: r.action, project: r.project, ...(r.reason === undefined ? {} : { reason: r.reason }) }));
    }
    return out;
  }

  /** What a change would do, in cells and in plain words, before it is applied. Reads only. */
  async preview(by: Principal, change: Omit<SetPolicy, "commandId" | "expectedRevision">): Promise<PolicyPreview> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} is not the owner; only the owner previews a policy change`);
    const scope = change.scope === "installation" ? "installation" : checkProjectId(change.scope);
    const inst = await this.#installation();
    const projBody = scope === "installation" ? undefined : ((await this.#runner.get("approval-policy", scope))?.body as unknown as PolicyBody | undefined);
    const apply = (b: PolicyBody | undefined): PolicyBody => {
      const base: Draft = { ...(b ?? { overrides: {}, locked: [], history: [] }), overrides: { ...(b?.overrides ?? {}) }, locked: [...(b?.locked ?? [])] };
      if (change.profile !== undefined) base.profile = change.profile;
      if (change.allCommandGate !== undefined) base.allCommandGate = change.allCommandGate;
      if (change.environment !== undefined) base.environment = change.environment;
      for (const [k, m] of Object.entries(change.overrides ?? {})) { if (!isCell(k)) invalid(`overrides.${k}`, "is not a cell"); if (m === null) delete base.overrides[k]; else base.overrides[k] = m; }
      for (const k of change.lock ?? []) if (!base.locked.includes(k)) base.locked.push(k);
      base.locked = base.locked.filter((k) => !(change.unlock ?? []).includes(k));
      return base;
    };
    const reserved = await this.#reserved(scope === "installation" ? undefined : scope);
    const before = this.#view(inst, projBody, reserved);
    const after = scope === "installation" ? this.#view(apply(inst), undefined, reserved) : this.#view(inst, apply(projBody), reserved);
    const changes: PolicyChange[] = [];
    for (const key of CELL_KEYS) if (before.cells[key] !== after.cells[key]) changes.push({ cell: key, from: before.cells[key], to: after.cells[key] });
    const loosened = changes.filter((c) => tightness(c.to) < tightness(c.from));
    const tightened = changes.filter((c) => tightness(c.to) > tightness(c.from));
    const notes: string[] = [];
    if (before.profile !== after.profile) notes.push(`the profile goes from ${before.profile} to ${after.profile}`);
    for (const c of loosened) notes.push(`${c.cell.replace(".", " in ")} environments would ${c.to === "allow" ? "run without asking" : "go to an agent review"} instead of ${c.from === "owner" ? "asking you" : "an agent review"}`);
    for (const c of tightened) notes.push(`${c.cell.replace(".", " in ")} environments would ${c.to === "owner" ? "ask you" : "go to an agent review"} instead of ${c.from === "allow" ? "running without asking" : "an agent review"}`);
    if (before.allCommandGate !== after.allCommandGate) notes.push(after.allCommandGate ? "every program run would ask you first" : "program runs would stop asking you first");
    if (changes.length === 0 && notes.length === 0) notes.push("nothing about how actions are decided would change");
    return { changes, loosened, tightened, notes };
  }

  /**
   * The decision for one action by one principal in one project, read against the policy as it is now. Called by the controller's own dispatcher before an action runs; it is not an operation
   * a worker or an agent can call. The owner is the decider and is always allowed.
   */
  async evaluate(input: EvaluateInput): Promise<Decision> {
    const now = this.#runner.now();
    const project = checkProjectId(input.projectId);
    if (typeof input.tool !== "string" || !/^[a-z][a-z0-9._-]{0,79}$/.test(input.tool)) invalid("tool", "must be a tool name in lower case");
    if (input.environment !== undefined && !ENVIRONMENTS.includes(input.environment)) invalid("environment", `must be ${ENVIRONMENTS.join(", ")}`);
    const cls = this.#catalog.classify(input.tool, input.targetKind);
    const principal = await this.#principal(input.principalId);
    const inst = await this.#installationRecord();
    const proj = (await this.#runner.get("approval-policy", project))?.body as unknown as PolicyBody | undefined;
    const environment = input.environment ?? proj?.environment ?? "development";
    if (principal === undefined) throw new DomainError("forbidden", `${input.principalId} is not an active principal`);
    if (principal.kind === "owner") return { mode: "allow", cls, tier: tierOf(environment), reasons: ["the owner is the one who decides"], via: "profile", profile: inst.body.profile ?? "strict" };
    const eff = await this.#grants.effective(principal, now);
    const action = `tool.${input.tool}`;
    const restricted = !allows({ ...eff, grants: [{ action: "*", project: "*" }] }, action, project);
    const held: GrantView[] = (await this.#grants.held(input.principalId, now)).filter(({ body }) => (body.project === "*" || body.project === project) && body.resource === undefined).map(({ id, body }) => grantView(id, body));
    const scope = input.taskId === undefined ? undefined : await this.#scopeOf(input.taskId, project, input.principalId, input.spentSoFar ?? 0);
    const scopeFields = scope === undefined ? {} : { scope };
    const request: PolicyRequest = {
      tool: input.tool, cls, environment, now,
      ...(input.estimatedSpend === undefined ? {} : { estimatedSpend: input.estimatedSpend }), ...(input.branchProtected === undefined ? {} : { branchProtected: input.branchProtected }),
      ...(input.audience === undefined ? {} : { audience: input.audience }), ...(input.irreversible === undefined ? {} : { irreversible: input.irreversible }),
      ...scopeFields,
    };
    return evaluate(this.#view(inst.body, proj, await this.#reserved(project)), request, held, restricted);
  }

  /**
   * A conversation's action request (card U02 stores it with `needsAuthorization`) judged as a request. It is not a tool call and not a class the catalogue knows, so it goes to review: an agent
   * review under derived and autonomous, the owner under strict. Nothing is executed because a message asked; the answer only says how the request is to be treated.
   */
  async evaluateRequest(input: { principalId: string; projectId: string }): Promise<Decision & { executed: false }> {
    const decision = await this.evaluate({ principalId: input.principalId, projectId: input.projectId, tool: "conversation-action-request" });
    return { ...decision, mode: decision.mode === "allow" ? "agent-review" : decision.mode, executed: false };
  }

  // ---- internals -----------------------------------------------------------------------------------------------------------

  /**
   * The instruction's scope, read from the task's stored contract and never from the caller: the permission ceiling, who set that ceiling (the author of the earliest version in the unbroken run
   * of versions that carry it), and the estimate left. A ceiling the acting principal wrote itself does not count as its instruction. No contract, or one of another project, means no scope.
   */
  async #scopeOf(taskId: string, projectId: string, actor: string, spent: number): Promise<{ ceiling: readonly string[]; approvedBy: string; budgetRemaining?: number } | undefined> {
    const current = (await this.#runner.get("task-contract", taskId))?.body as unknown as { projectId: string; version: number; permissions?: readonly string[]; budget?: { maxCost?: number } } | undefined;
    if (current === undefined || current.projectId !== projectId) return undefined;
    const ceiling = [...(current.permissions ?? [])].sort();
    let approver: string | undefined;
    for (let v = current.version; v >= 1; v--) {
      const stored = (await this.#runner.get("task-contract-version", `${taskId}.${v}`))?.body as unknown as { permissions?: readonly string[]; changedBy: string } | undefined;
      if (stored === undefined || JSON.stringify([...(stored.permissions ?? [])].sort()) !== JSON.stringify(ceiling)) break;
      approver = stored.changedBy;
    }
    if (approver === undefined || approver === actor) return undefined;
    const max = current.budget?.maxCost;
    return { ceiling, approvedBy: approver, ...(max === undefined ? {} : { budgetRemaining: Math.max(0, max - spent) }) };
  }

  async #mayRead(by: Principal): Promise<boolean> {
    if (by.kind === "owner") return true;
    const found = await this.#runner.get("principal", by.id);
    const body = found?.body as unknown as PrincipalBody | undefined;
    if (found === undefined || body === undefined || body.state !== "active") return false;
    const eff = await this.#grants.effective({ id: found.id, kind: body.kind, name: body.name, grants: body.grants }, this.#runner.now());
    return allows(eff, "config.read", "*") || allows(eff, "config.write", "*");
  }

  async #principal(id: string): Promise<Principal | undefined> {
    const found = await this.#runner.get("principal", id);
    const body = found?.body as unknown as PrincipalBody | undefined;
    if (found === undefined || body === undefined || body.state !== "active") return undefined;
    return { id: found.id, kind: body.kind, name: body.name, grants: body.grants };
  }

  async #installationRecord(): Promise<{ body: PolicyBody; revision: number }> {
    const found = await this.#runner.get(INSTALLATION.kind, INSTALLATION.id);
    return found === undefined ? { body: { overrides: {}, locked: [], history: [] }, revision: 0 } : { body: found.body as unknown as PolicyBody, revision: found.revision };
  }
  async #installation(): Promise<PolicyBody> { return (await this.#installationRecord()).body; }

  /** The tools the project's review policy reserves for the owner (card H05). */
  async #reserved(projectId: string | undefined): Promise<readonly string[]> {
    if (projectId === undefined) return [];
    return ((await this.#runner.get("review-policy", projectId))?.body as unknown as { mandatoryHuman?: readonly string[] } | undefined)?.mandatoryHuman ?? [];
  }

  #cell(inst: PolicyBody, key: CellKey): Mode {
    return inst.overrides[key] ?? PROFILE_TABLES[inst.profile ?? "strict"][key.slice(0, key.lastIndexOf(".")) as ActionClass][key.slice(key.lastIndexOf(".") + 1) as "free" | "guarded" | "live"];
  }

  /** The installation's table with a project's overrides on top; where the installation locked a cell, the project can only make it tighter. */
  #view(inst: PolicyBody, proj: PolicyBody | undefined, mandatoryHuman: readonly string[]): PolicyView {
    const cells = {} as Record<CellKey, Mode>;
    for (const key of CELL_KEYS) {
      const installationMode = this.#cell(inst, key);
      const projectMode = proj?.overrides[key] as Mode | undefined;
      cells[key] = projectMode === undefined ? installationMode : inst.locked.includes(key) && tightness(projectMode) < tightness(installationMode) ? installationMode : projectMode;
    }
    const gate = (inst.allCommandGate ?? false) || ((proj?.allCommandGate ?? false) && true);
    return { profile: inst.profile ?? "strict", allCommandGate: inst.locked.includes("gate") && inst.allCommandGate === true ? true : gate, cells, mandatoryHuman };
  }
}

const ACTION_CLASSES_TEXT = "inspect, workspace-edit, mutate, external-send, publish, spend, install-executable, access-change, commit, push, merge, deploy; tiers free, guarded, live";

function grantView(id: string, body: GrantRecordBody): GrantView {
  const t = body.terms;
  return {
    id, action: body.action, source: body.rootSource ?? body.source,
    ...(t?.environments === undefined ? {} : { environments: t.environments }), ...(t?.spendLimit === undefined ? {} : { spendLimit: t.spendLimit }),
    ...(t?.window === undefined ? {} : { window: t.window }), ...(t?.audiences === undefined ? {} : { audiences: t.audiences }),
  };
}

void text; void redactText;

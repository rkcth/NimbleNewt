import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, taskId as checkTaskId, text, type View } from "../domain/model.js";
import { CommandRunner, view, type Built, type CommandResult, type RunnerOptions } from "../domain/runner.js";
import type { TaskBody } from "../domain/model.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import type { Aggregate, AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

export const DIFFICULTIES = ["trivial", "easy", "medium", "hard", "expert"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export type WorkClass = "P" | "PC";

/** What the task is expected to deliver and under which terms. Absent fields mean "not stated"; a task with no stored contract reads as the defaults. */
export interface ContractFields {
  readonly expectedResult?: string;
  readonly acceptanceCriteria: readonly string[];
  /** 0 to 9, higher is served first; the scale admission uses. */
  readonly priority: number;
  readonly difficulty?: Difficulty;
  readonly budget: { readonly maxAttempts?: number; readonly maxMinutes?: number; readonly maxCost?: number };
  /** P (production: the requested deliverable and its necessary checks) or PC (improvement of how the team works). */
  readonly workClass: WorkClass;
  readonly requiredEvidence: readonly string[];
  /** Action names the task's work may use, at most; it narrows, it never grants. Stored now; the tool path (cards T06 and H12) is what enforces it. */
  readonly permissions: readonly string[];
}

export interface ContractBody extends ContractFields {
  readonly taskId: string;
  readonly projectId: string;
  /** 1 for the first stored contract; every change adds one. */
  readonly version: number;
  readonly changedBy: string;
}

/** One stored version, kept for ever (kind `task-contract-version`): the history. */
export interface ContractVersionBody extends ContractBody { readonly changedAt: string }

export interface DependencyBody {
  readonly taskId: string;
  readonly prerequisiteId: string;
  readonly projectId: string;
  /** The agent answerable for the prerequisite being delivered (a principal ID), so a wait can name who can unblock it. Falls back to the prerequisite's owner. */
  readonly responsible?: string;
  readonly state: "active" | "removed";
  readonly createdBy: string;
}

export const DEFAULT_CONTRACT: ContractFields = { acceptanceCriteria: [], priority: 5, budget: {}, workClass: "P", requiredEvidence: [], permissions: [] };
export const CONTRACT_LIMITS = { result: 4000, criterion: 500, criteria: 50, evidence: 30, evidenceItem: 200, permissions: 100, scan: 5000, budgetMax: 1_000_000 } as const;
const ACTION = /^(?:\*|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*(?:\.\*)?)$/;
const FIELDS = ["expectedResult", "acceptanceCriteria", "priority", "difficulty", "budget", "workClass", "requiredEvidence", "permissions"] as const;

const TASK_ID = /^task-[a-z2-7]{20}$/;
const taskIdAt = (v: unknown, field: string): string => (typeof v === "string" && TASK_ID.test(v) ? v : invalid(field, "is not a task ID"));
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const list = (v: unknown, field: string, max: number, item: number): string[] => {
  if (!Array.isArray(v)) return invalid(field, "must be a list");
  if (v.length > max) return invalid(field, `must have at most ${max} entries`);
  return v.map((x, i) => text(x, `${field}[${i}]`, { min: 1, max: item, multiline: true }));
};

type Patch = { [K in (typeof FIELDS)[number]]?: ContractFields[K] | null };

function parsePatch(source: Record<string, unknown>): Patch {
  const out: Record<string, unknown> = {};
  if (source["expectedResult"] !== undefined) out["expectedResult"] = source["expectedResult"] === null ? null : text(source["expectedResult"], "expectedResult", { min: 1, max: CONTRACT_LIMITS.result, multiline: true });
  if (source["acceptanceCriteria"] !== undefined) out["acceptanceCriteria"] = list(source["acceptanceCriteria"], "acceptanceCriteria", CONTRACT_LIMITS.criteria, CONTRACT_LIMITS.criterion);
  if (source["requiredEvidence"] !== undefined) out["requiredEvidence"] = list(source["requiredEvidence"], "requiredEvidence", CONTRACT_LIMITS.evidence, CONTRACT_LIMITS.evidenceItem);
  if (source["priority"] !== undefined) {
    const p = source["priority"];
    out["priority"] = typeof p === "number" && Number.isSafeInteger(p) && p >= 0 && p <= 9 ? p : invalid("priority", "must be a whole number from 0 to 9");
  }
  if (source["difficulty"] !== undefined) out["difficulty"] = source["difficulty"] === null ? null : (DIFFICULTIES as readonly string[]).includes(source["difficulty"] as string) ? source["difficulty"] : invalid("difficulty", `must be one of ${DIFFICULTIES.join(", ")}`);
  if (source["workClass"] !== undefined) out["workClass"] = source["workClass"] === "P" || source["workClass"] === "PC" ? source["workClass"] : invalid("workClass", "must be P or PC");
  if (source["permissions"] !== undefined) {
    const perms = source["permissions"];
    if (!Array.isArray(perms) || perms.length > CONTRACT_LIMITS.permissions) invalid("permissions", `must be a list of at most ${CONTRACT_LIMITS.permissions} action names`);
    out["permissions"] = (perms as unknown[]).map((a, i) => (typeof a === "string" && a.length <= 60 && ACTION.test(a) ? a : invalid(`permissions[${i}]`, "must be an action name such as task.create or a prefix such as task.*")));
  }
  if (source["budget"] !== undefined) {
    const b = source["budget"];
    if (b === null || typeof b !== "object" || Array.isArray(b)) invalid("budget", "must be an object");
    const budget: Record<string, number> = {};
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
      if (k !== "maxAttempts" && k !== "maxMinutes" && k !== "maxCost") invalid(`budget.${k}`, "is not a budget field (maxAttempts, maxMinutes, maxCost)");
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > CONTRACT_LIMITS.budgetMax) invalid(`budget.${k}`, `must be a whole number from 1 to ${CONTRACT_LIMITS.budgetMax}`);
      budget[k] = v as number;
    }
    out["budget"] = budget;
  }
  return out as Patch;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Task contracts and the task dependency graph (card S10). A contract is versioned: every change stores a new version and keeps the old ones, so the history of what was promised is
 * never rewritten, and a task that never had a contract reads as the documented defaults (so tasks made before contracts keep working). Who may change what is separate by field:
 * the general contract, the priority, the difficulty and the P or PC class each have their own action, and the class is the one that needs planning authority. Dependencies are edges
 * between tasks of one project with a named responsible agent; an edge that would make a cycle is refused, and the cycle check cannot be raced (project-wide serialization through one
 * registry record, as the agent records do).
 */
export class ContractService {
  readonly #runner: CommandRunner;
  readonly #scanLimit: number;

  private constructor(runner: CommandRunner, scanLimit: number) { this.#runner = runner; this.#scanLimit = scanLimit; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { scanLimit?: number } = {}): ContractService {
    return new ContractService(new CommandRunner(storage, epoch, options), options.scanLimit ?? CONTRACT_LIMITS.scan);
  }

  get runner(): CommandRunner { return this.#runner; }

  // ---- contracts ------------------------------------------------------------------------------------------------------------

  /** The contract as it stands now: the stored one, or the defaults at version 0 for a task that has none. Hidden as for a missing task when the caller may not read the task. */
  async get(by: Principal, taskId: string): Promise<{ taskId: string; projectId: string; version: number } & ContractFields | undefined> {
    const task = await this.#readableTask(by, checkTaskId(taskId));
    if (task === undefined) return undefined;
    return this.#current(taskId, task.projectId);
  }

  async history(by: Principal, taskId: string): Promise<View<ContractVersionBody>[] | undefined> {
    const task = await this.#readableTask(by, checkTaskId(taskId));
    if (task === undefined) return undefined;
    const current = await this.#runner.get("task-contract", taskId);
    const versions = (current?.body as unknown as ContractBody | undefined)?.version ?? 0;
    const out: View<ContractVersionBody>[] = [];
    for (let v = 1; v <= versions; v++) {
      const found = await this.#runner.get("task-contract-version", `${taskId}.${v}`);
      if (found !== undefined) out.push(view<ContractVersionBody>(found));
    }
    return out;
  }

  /**
   * Changes some fields of a task's contract (`null` clears expectedResult and difficulty). `expectedVersion` is the version read (0 when the task has none yet). Each field needs its
   * own authority: priority `task.priority.write`, difficulty `task.difficulty.write`, workClass `task.class.write`, the rest `task.contract.write`; a change that sets a field to the
   * value it already has needs nothing for that field. The new version is stored beside the old ones.
   */
  async setContract(by: Principal, command: NoActor & { taskId: string; expectedVersion: number } & Patch): Promise<CommandResult> {
    return this.#runner.command("contract.set", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "taskId", "expectedVersion", ...FIELDS]);
      const taskId = checkTaskId(command.taskId);
      if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) invalid("expectedVersion", "must be 0 or the version you read");
      const patch = parsePatch(command as unknown as Record<string, unknown>);
      if (Object.keys(patch).length === 0) invalid("fields", "name at least one field to change");
      return {
        payload: { taskId, expectedVersion: command.expectedVersion, patch: JSON.parse(JSON.stringify(patch)) as JsonObject },
        build: async () => {
          const task = await this.#readableTask(by, taskId);
          if (task === undefined) throw new DomainError("forbidden", `${by.id} may not change the contract of ${taskId}`);
          const current = await this.#runner.get("task-contract", taskId);
          const before = current?.body as unknown as ContractBody | undefined;
          const version = before?.version ?? 0;
          if (version !== command.expectedVersion) throw new DomainError("stale_revision", `the contract of ${taskId} is at version ${version}, not ${command.expectedVersion}`, { currentRevision: version });
          const base = before ?? { ...DEFAULT_CONTRACT, taskId, projectId: task.projectId, version: 0, changedBy: by.id };
          const next: Record<string, unknown> = { ...base };
          let changed = false;
          for (const [key, value] of Object.entries(patch)) {
            if (sameJson(value, (base as unknown as Record<string, unknown>)[key] ?? null)) continue;
            this.#authorize(by, key as (typeof FIELDS)[number], task.projectId, taskId);
            changed = true;
            if (value === null) delete next[key]; else next[key] = value;
          }
          if (!changed) invalid("fields", "the contract already has these values");
          const body = { ...next, version: version + 1, changedBy: by.id } as unknown as ContractBody;
          const ref: AggregateRef = { kind: "task-contract", id: taskId };
          const versionRef: AggregateRef = { kind: "task-contract-version", id: `${taskId}.${body.version}` };
          const stored: ContractVersionBody = { ...body, changedAt: this.#runner.now() };
          const changes: Change[] = [
            current === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject },
            { type: "create", ref: versionRef, body: stored as unknown as JsonObject },
          ];
          return { ref, creates: current === undefined, changes, detail: { task: taskId, version: body.version, fields: Object.keys(patch).join(",") }, contention: async () => new DomainError("stale_revision", `the contract of ${taskId} changed meanwhile; read it again`) };
        },
      };
    });
  }

  /** The priority admission should use for the task now. A change takes effect at the next decision that asks; versions already stored keep the priority they had. */
  async priorityOf(taskId: string): Promise<number> {
    const stored = await this.#runner.get("task-contract", taskId);
    return (stored?.body as unknown as ContractBody | undefined)?.priority ?? DEFAULT_CONTRACT.priority;
  }

  #authorize(by: Principal, field: (typeof FIELDS)[number], project: string, taskId: string): void {
    const action = field === "priority" ? "task.priority.write" : field === "difficulty" ? "task.difficulty.write" : field === "workClass" ? "task.class.write" : "task.contract.write";
    if (!allows(by, action, project, { resource: { kind: "task", id: taskId } })) throw new DomainError("forbidden", `${by.id} may not change ${field} of ${taskId}`);
  }

  async #current(taskId: string, projectId: string): Promise<{ taskId: string; projectId: string; version: number } & ContractFields> {
    const stored = await this.#runner.get("task-contract", taskId);
    const b = stored?.body as unknown as ContractBody | undefined;
    if (b === undefined) return { ...DEFAULT_CONTRACT, taskId, projectId, version: 0 };
    const { changedBy: _c, ...rest } = b;
    return rest;
  }

  /** The task when the caller may read it, otherwise undefined: a task of a project the caller cannot read looks like a missing one. */
  async #readableTask(by: Principal, taskId: string): Promise<(TaskBody & { revision: number }) | undefined> {
    const found = await this.#runner.get("task", taskId);
    if (found === undefined) return undefined;
    const body = found.body as unknown as TaskBody;
    if (!allows(by, "task.read", body.projectId, { resource: { kind: "task", id: taskId } })) return undefined;
    return { ...body, revision: found.revision };
  }

  // ---- dependencies ---------------------------------------------------------------------------------------------------------

  /** `taskId` depends on `prerequisiteId` (both in one project). Needs `task.dependency.write` for the dependent task. Refused if it would make a cycle. */
  async addDependency(by: Principal, command: NoActor & { taskId: string; prerequisiteId: string; responsible?: string }): Promise<CommandResult> {
    return this.#runner.command("dependency.add", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "taskId", "prerequisiteId", "responsible"]);
      const taskId = checkTaskId(command.taskId);
      const prerequisiteId = taskIdAt(command.prerequisiteId, "prerequisiteId");
      const responsible = command.responsible === undefined ? undefined : text(command.responsible, "responsible", { min: 1, max: 120 });
      return {
        payload: { taskId, prerequisiteId, responsible: responsible ?? null },
        build: async () => {
          const registry = await this.#registryFor(taskId);
          const task = await this.#readableTask(by, taskId);
          if (task === undefined) throw new DomainError("forbidden", `${by.id} may not change the dependencies of ${taskId}`);
          if (!allows(by, "task.dependency.write", task.projectId, { resource: { kind: "task", id: taskId } })) throw new DomainError("forbidden", `${by.id} may not change the dependencies of ${taskId}`);
          // A prerequisite the caller may not read answers like one that is not there.
          const pre = await this.#readableTask(by, prerequisiteId);
          if (pre === undefined || pre.projectId !== task.projectId) invalid("prerequisiteId", "must be a task of the same project");
          if (responsible !== undefined) {
            const who = (await this.#runner.get("principal", responsible))?.body as unknown as PrincipalBody | undefined;
            if (who === undefined || who.kind !== "agent" || who.state !== "active") invalid("responsible", "must be an active agent");
          }
          if (taskId === prerequisiteId) invalid("prerequisiteId", "a task cannot depend on itself");
          const edges = await this.#edges(task.projectId);
          if (edges.some((e) => e.taskId === taskId && e.prerequisiteId === prerequisiteId)) invalid("prerequisiteId", "the dependency already exists");
          if (reaches(edges, prerequisiteId, taskId)) invalid("prerequisiteId", "would make the tasks depend on each other, directly or through others");
          const id = derivedId("dep", `${taskId}\0${prerequisiteId}`);
          const ref: AggregateRef = { kind: "task-dep", id };
          const existing = await this.#runner.get("task-dep", id);
          const body: DependencyBody = { taskId, prerequisiteId, projectId: task.projectId, ...(responsible === undefined ? {} : { responsible }), state: "active", createdBy: by.id };
          const changes: Change[] = [existing === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: existing.revision, body: body as unknown as JsonObject }, registry.touch];
          return { ref, creates: existing === undefined, changes, detail: { task: taskId, prerequisite: prerequisiteId }, contention: async () => raced() } satisfies Built;
        },
      };
    });
  }

  async removeDependency(by: Principal, command: NoActor & { taskId: string; prerequisiteId: string }): Promise<CommandResult> {
    return this.#runner.command("dependency.remove", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "taskId", "prerequisiteId"]);
      const taskId = checkTaskId(command.taskId);
      const prerequisiteId = taskIdAt(command.prerequisiteId, "prerequisiteId");
      return {
        payload: { taskId, prerequisiteId },
        build: async () => {
          const registry = await this.#registryFor(taskId);
          const task = await this.#readableTask(by, taskId);
          if (task === undefined || !allows(by, "task.dependency.write", task.projectId, { resource: { kind: "task", id: taskId } })) throw new DomainError("forbidden", `${by.id} may not change the dependencies of ${taskId}`);
          const id = derivedId("dep", `${taskId}\0${prerequisiteId}`);
          const found = await this.#runner.get("task-dep", id);
          const body = found?.body as unknown as DependencyBody | undefined;
          if (found === undefined || body === undefined || body.state !== "active") invalid("prerequisiteId", "there is no such dependency");
          const ref: AggregateRef = { kind: "task-dep", id };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found!.revision, body: { ...body!, state: "removed" } as unknown as JsonObject }, registry.touch], detail: { task: taskId, prerequisite: prerequisiteId }, contention: async () => raced() };
        },
      };
    });
  }

  /** What `taskId` depends on, and which tasks depend on it. Needs read access to the task. */
  async dependencies(by: Principal, taskId: string): Promise<{ dependsOn: View<DependencyBody>[]; dependents: View<DependencyBody>[] } | undefined> {
    const task = await this.#readableTask(by, checkTaskId(taskId));
    if (task === undefined) return undefined;
    const all = await this.#edgeRecords(task.projectId);
    // Only edges whose other end the caller may also read are shown.
    const visible = async (edge: (typeof all)[number], otherId: string): Promise<boolean> => (await this.#readableTask(by, otherId)) !== undefined && edge !== undefined;
    const dependsOn: View<DependencyBody>[] = [];
    for (const e of all.filter((x) => x.taskId === taskId)) if (await visible(e, e.prerequisiteId)) dependsOn.push(view<DependencyBody>(e));
    const dependents: View<DependencyBody>[] = [];
    for (const e of all.filter((x) => x.prerequisiteId === taskId)) if (await visible(e, e.taskId)) dependents.push(view<DependencyBody>(e));
    return { dependsOn, dependents };
  }

  /** A per-project record that every change to the project's dependencies updates at the revision it read first. */
  async #registryFor(taskId: string): Promise<{ touch: Change }> {
    const task = await this.#runner.get("task", taskId);
    const project = (task?.body as unknown as TaskBody | undefined)?.projectId ?? "unknown";
    const ref: AggregateRef = { kind: "dep-registry", id: project };
    const registry = await this.#runner.get(ref.kind, ref.id);
    const n = registry === undefined ? 0 : (registry.body as unknown as { n: number }).n;
    return { touch: registry === undefined ? { type: "create", ref, body: { n: 1 } } : { type: "update", ref, expectedRevision: registry.revision, body: { n: n + 1 } } };
  }

  async #edgeRecords(projectId: string): Promise<(Aggregate & { taskId: string; prerequisiteId: string })[]> {
    const out: (Aggregate & { taskId: string; prerequisiteId: string })[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list("task-dep", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const r of page) {
        const b = r.body as unknown as DependencyBody;
        if (b.projectId === projectId && b.state === "active") out.push({ ...r, taskId: b.taskId, prerequisiteId: b.prerequisiteId });
      }
      if (page.length < 500) return out;
      if (out.length > this.#scanLimit) throw new DomainError("unavailable", `there are more than ${this.#scanLimit} dependencies, too many to check safely`);
      after = page.at(-1)!.id;
    }
  }
  async #edges(projectId: string): Promise<{ taskId: string; prerequisiteId: string }[]> { return this.#edgeRecords(projectId); }

  /** Active dependency edges of a project, for the wait-for graph. */
  async activeEdges(projectId: string): Promise<DependencyBody[]> {
    return (await this.#edgeRecords(checkProjectId(projectId))).map((r) => r.body as unknown as DependencyBody);
  }
}

/** Whether `to` can be reached from `from` by following "depends on" edges. */
function reaches(edges: readonly { taskId: string; prerequisiteId: string }[], from: string, to: string): boolean {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.taskId, [...(next.get(e.taskId) ?? []), e.prerequisiteId]);
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (at === to) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    stack.push(...(next.get(at) ?? []));
  }
  return false;
}

const raced = (): DomainError => new DomainError("stale_revision", "the dependencies changed meanwhile; try again");

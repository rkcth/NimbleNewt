import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const KIND = "branch-settings";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,97}(?:\/\*)?$/;
const MAX_PROTECTED = 100;
/** What is protected in a project the owner has not set (card A07f). */
export const DEFAULT_PROTECTED = ["main", "master"] as const;

export interface BranchSettingsBody {
  /** Branch names, or a prefix ending in `/*` (`release/*`), that a push or merge may not change without the owner's decision. */
  readonly protected: readonly string[];
  /** The branch finished work is integrated onto (card P08); informational here. */
  readonly landing?: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/** Whether a branch is protected by a list of names and `prefix/*` patterns. Pure. */
export function isProtectedBy(list: readonly string[], branch: string): boolean {
  const b = normalBranch(branch);
  if (b === undefined) return true;
  return list.some((raw) => { const p = raw.toLowerCase(); return p.endsWith("/*") ? b.startsWith(p.slice(0, -1)) : p === b; });
}

/**
 * The branch a name means, the way git would resolve it, lower-cased (a file system or a host may fold case, so `Main` is `main`). `refs/heads/x` is `x`. A name git would read another way (`heads/x`, a trailing or doubled
 * slash, `refs/...` other than heads) has no single meaning here: undefined, which callers treat as protected.
 */
export function normalBranch(name: string): string | undefined {
  let b = name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name;
  if (b === "" || b === "@" || b.toLowerCase() === "head" || b.startsWith("heads/") || b.startsWith("refs/") || b.startsWith("-") || b.startsWith("/") || b.endsWith("/") || b.endsWith(".") || b.endsWith(".lock") || b.includes("//") || b.includes("..") || b.includes("@{") || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(b)) return undefined;
  b = b.toLowerCase();
  return b;
}

/** Every string in a call's arguments, at any depth (for a refspec, the part after the colon): any of them may be the branch the tool really pushes to, so each must be the declared one. Used to hold the call to it. */
export function branchesNamedIn(args: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6) { out.push(""); return; }
    if (typeof v === "string") out.push(v.includes(":") ? v.slice(v.lastIndexOf(":") + 1) : v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v !== null && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(args, 0);
  return out;
}

/**
 * Which branches of a project are protected (card A07f), decided by the controller and set only by the owner. The call a worker makes does not decide it: an agent that leaves out a "protected" flag, or says false, changes nothing here.
 * A project the owner has not set protects `main` and `master`.
 */
export class ProtectedBranchService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): ProtectedBranchService {
    return new ProtectedBranchService(new CommandRunner(storage, epoch, options));
  }

  /** The controller's own question, for a push or a merge: is this branch protected? A branch that is not named is treated as protected, because nothing says it is not. */
  async isProtected(projectId: string, branch: string | undefined): Promise<boolean> {
    if (branch === undefined || !NAME.test(branch) || branch.includes("..")) return true;
    return isProtectedBy(await this.#list(projectId), branch);
  }

  async get(by: Principal, projectId: string): Promise<{ revision: number; protected: readonly string[]; landing?: string; isDefault: boolean }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read a project's branch settings`);
    const found = await this.#runner.get(KIND, this.#id(projectId));
    const body = found?.body as unknown as BranchSettingsBody | undefined;
    return { revision: found?.revision ?? 0, protected: body?.protected ?? [...DEFAULT_PROTECTED], ...(body?.landing === undefined ? {} : { landing: body.landing }), isDefault: body === undefined };
  }

  /** The owner replaces the list of protected branches and, optionally, names the landing branch (null clears it). */
  async set(owner: Principal, command: NoActor & { projectId: string; protected?: readonly string[]; landing?: string | null; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change a project's branch settings`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "projectId", "protected", "landing", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    const id = this.#id(command.projectId);
    const list = command.protected;
    if (list !== undefined) {
      if (!Array.isArray(list) || list.length > MAX_PROTECTED) throw new DomainError("invalid_command", `protected: must be a list of at most ${MAX_PROTECTED} branch names`, { field: "protected" });
      for (const b of list) if (typeof b !== "string" || !PATTERN.test(b) || b.includes("..")) throw new DomainError("invalid_command", `protected: ${String(b)} is not a branch name or a prefix such as release/*`, { field: "protected" });
    }
    const landing = command.landing;
    if (typeof landing === "string" && (!NAME.test(landing) || landing.includes(".."))) throw new DomainError("invalid_command", "landing: is not a branch name", { field: "landing" });
    if (list === undefined && landing === undefined) throw new DomainError("invalid_command", "protected: name the protected branches or the landing branch", { field: "protected" });
    const result = await this.#runner.command("branch-settings.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { projectId: id, protected: list === undefined ? null : [...new Set(list)].sort(), landing: landing ?? null, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const ref = { kind: KIND, id };
        const current = await this.#runner.get(KIND, id);
        const before = current?.body as unknown as BranchSettingsBody | undefined;
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the branch settings are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`);
        const keptLanding = landing === undefined ? before?.landing : landing === null ? undefined : landing;
        const next: BranchSettingsBody = { protected: list === undefined ? (before?.protected ?? [...DEFAULT_PROTECTED]) : [...new Set(list)].sort(), ...(keptLanding === undefined ? {} : { landing: keptLanding }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref, body: next as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref, creates: current === undefined, changes: [change], detail: { projectId: id, protected: next.protected.length } };
      },
    }));
    return { revision: result.revision };
  }

  /**
   * The owner adds branches to the protected list and takes named ones off it, leaving the others as they are (the form the chat uses, so a request that waits does only what it says). `landing` is set or cleared (null) as in `set`.
   * `expectedRevision` is optional. Taking a branch off a list that is only the default (`main`, `master`) first writes the default out, so the other default stays protected.
   */
  async change(owner: Principal, command: NoActor & { projectId: string; add?: readonly string[]; remove?: readonly string[]; landing?: string | null; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change a project's branch settings`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "projectId", "add", "remove", "landing", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    const id = this.#id(command.projectId);
    const names = (value: unknown, field: string): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > MAX_PROTECTED) throw new DomainError("invalid_command", `${field}: must be a list of at most ${MAX_PROTECTED} branch names`, { field });
      for (const b of value) if (typeof b !== "string" || !PATTERN.test(b) || b.includes("..")) throw new DomainError("invalid_command", `${field}: ${String(b).slice(0, 40)} is not a branch name or a prefix such as release/*`, { field });
      return [...new Set(value as string[])].sort();
    };
    const add = names(command.add, "add");
    const remove = names(command.remove, "remove");
    for (const b of add) if (remove.includes(b)) throw new DomainError("invalid_command", `remove: ${b} is also in add; a branch is named once`, { field: "remove" });
    const landing = command.landing;
    if (typeof landing === "string" && (!NAME.test(landing) || landing.includes(".."))) throw new DomainError("invalid_command", "landing: is not a branch name", { field: "landing" });
    if (add.length + remove.length === 0 && landing === undefined) throw new DomainError("invalid_command", "add: name branches to protect or unprotect, or the landing branch", { field: "add" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("branch-settings.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { projectId: id, add, remove, landing: landing ?? null, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const ref = { kind: KIND, id };
        const current = await this.#runner.get(KIND, id);
        const before = current?.body as unknown as BranchSettingsBody | undefined;
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the branch settings are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`);
        const merged = [...new Set([...(before?.protected ?? DEFAULT_PROTECTED), ...add])].filter((b) => !remove.includes(b)).sort();
        if (merged.length > MAX_PROTECTED) throw new DomainError("invalid_command", `add: at most ${MAX_PROTECTED} protected branches`, { field: "add" });
        const keptLanding = landing === undefined ? before?.landing : landing === null ? undefined : landing;
        const next: BranchSettingsBody = { protected: merged, ...(keptLanding === undefined ? {} : { landing: keptLanding }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref, body: next as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref, creates: current === undefined, changes: [change], detail: { projectId: id, protected: next.protected.length } };
      },
    }));
    return { revision: result.revision };
  }

  async #list(projectId: string): Promise<readonly string[]> {
    return ((await this.#runner.get(KIND, this.#id(projectId)))?.body as unknown as BranchSettingsBody | undefined)?.protected ?? DEFAULT_PROTECTED;
  }

  #id(projectId: unknown): string {
    if (typeof projectId !== "string" || !/^proj-[a-z2-7]{20}$/.test(projectId)) throw new DomainError("invalid_command", "projectId: is not a project ID", { field: "projectId" });
    return projectId;
  }
}

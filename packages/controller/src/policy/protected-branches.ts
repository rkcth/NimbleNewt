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
  return list.some((p) => (p.endsWith("/*") ? branch.startsWith(p.slice(0, -1)) : p === branch));
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

  async #list(projectId: string): Promise<readonly string[]> {
    return ((await this.#runner.get(KIND, this.#id(projectId)))?.body as unknown as BranchSettingsBody | undefined)?.protected ?? DEFAULT_PROTECTED;
  }

  #id(projectId: unknown): string {
    if (typeof projectId !== "string" || !/^proj-[a-z2-7]{20}$/.test(projectId)) throw new DomainError("invalid_command", "projectId: is not a project ID", { field: "projectId" });
    return projectId;
  }
}

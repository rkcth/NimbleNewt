import { DomainError } from "../domain/errors.js";
import { declarationProblems, recoveryGap, type HarnessDeclaration, type RecoveryRequirement } from "./declarations.js";

/**
 * The harnesses this installation ships and what each can recover (card F08). Only the declarations given here exist: a harness that is not in the catalog cannot run a task, and a task's
 * recovery requirement is checked against the harness's declaration before an attempt is admitted. The first release ships the Pi declaration only; adding another harness is the owner's
 * decision (the catalog is built by the installer, not discovered).
 */
export class HarnessCatalog {
  readonly #byName: ReadonlyMap<string, HarnessDeclaration>;

  private constructor(byName: Map<string, HarnessDeclaration>) { this.#byName = byName; }

  static of(declarations: readonly HarnessDeclaration[]): HarnessCatalog {
    const byName = new Map<string, HarnessDeclaration>();
    for (const d of declarations) {
      const problems = declarationProblems(d);
      if (problems.length > 0) throw new DomainError("invalid_command", `harness ${typeof d.harness === "string" ? d.harness : "?"}: ${problems.join("; ")}`, { field: "harnesses" });
      if (byName.has(d.harness)) throw new DomainError("invalid_command", `harness ${d.harness} is declared twice`, { field: "harnesses" });
      byName.set(d.harness, { ...d });
    }
    return new HarnessCatalog(byName);
  }

  get(name: string): HarnessDeclaration | undefined { return this.#byName.get(name); }
  list(): HarnessDeclaration[] { return [...this.#byName.values()].sort((a, b) => a.harness.localeCompare(b.harness)); }

  /** The check for an attempt: as `check`, except that an attempt naming no harness is acceptable only for work that may be lost (requirement `none`). */
  checkAttempt(requirement: RecoveryRequirement, harness: string | undefined): string | undefined {
    if (harness !== undefined) return this.check(requirement, harness);
    return requirement === "none" ? undefined : "the attempt names no harness, so the task's recovery requirement cannot be checked; name the harness it runs in";
  }

  /** Why a task with this requirement cannot run in the harness (naming the gap), or undefined when it can. */
  check(requirement: RecoveryRequirement, harness: string): string | undefined {
    const declaration = this.#byName.get(harness);
    if (declaration === undefined) return `harness ${harness} is not one this installation ships (${this.list().map((d) => d.harness).join(", ") || "none"})`;
    return recoveryGap(requirement, declaration);
  }
}

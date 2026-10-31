import type { JsonObject } from "../storage/types.js";
import type { ApplyOutcome, MaintenanceApplier, MaintenanceView, RevertOutcome } from "./maintenance.js";

/**
 * A scriptable applier for tests: it records every call, answers `applied` with an effect naming the request, and is idempotent by request ID (a repeat gets the first effect back). `script` can make the next
 * calls fail, be unsupported, throw, or wait.
 */
export class FakeApplier implements MaintenanceApplier {
  readonly calls: { readonly op: "apply" | "revert"; readonly id: string; readonly kind: string; readonly spec: JsonObject }[] = [];
  readonly effects = new Map<string, JsonObject>();
  readonly reverted = new Set<string>();
  /** Outcomes used in order for the next `apply` calls; when empty the call succeeds. */
  nextApply: (ApplyOutcome | "throw")[] = [];
  nextRevert: (RevertOutcome | "throw")[] = [];
  /** Awaited at the start of `apply` (to hold an application open in a test). */
  gate: Promise<void> | undefined;
  /** One gate per upcoming `apply` call, used first (to hold several overlapping applications open in a test). */
  gates: Promise<void>[] = [];
  /** What each source really serves, as a sha256 content digest by source URL. When set, the applier verifies `spec.digest` against it (as the contract requires) and refuses on a mismatch. */
  artifacts: Record<string, string> | undefined;
  readonly verified: string[] = [];
  /** Awaited at the start of `revert` (to hold a revert open in a test). */
  revertGate: Promise<void> | undefined;

  async apply(view: MaintenanceView): Promise<ApplyOutcome> {
    this.calls.push({ op: "apply", id: view.id, kind: view.kind, spec: view.spec });
    const mine = this.gates.shift();
    if (mine !== undefined) await mine;
    else if (this.gate !== undefined) await this.gate;
    if (this.artifacts !== undefined && (view.kind === "package" || view.kind === "extension")) {
      const served = this.artifacts[String(view.spec["source"])];
      this.verified.push(view.id);
      if (served !== view.spec["digest"]) return { outcome: "failed", reason: "digest mismatch: the fetched artifact is not the one that was approved; nothing was installed" };
    }
    const next = this.nextApply.shift();
    if (next === "throw") throw new Error("applier offline");
    if (next !== undefined) return next;
    const known = this.effects.get(view.id);
    if (known !== undefined) return { outcome: "applied", effect: known };
    const effect = { applied: view.id, kind: view.kind, environmentRevision: this.effects.size + 1 };
    this.effects.set(view.id, effect);
    return { outcome: "applied", effect };
  }
  async revert(view: MaintenanceView, _effect: JsonObject): Promise<RevertOutcome> {
    this.calls.push({ op: "revert", id: view.id, kind: view.kind, spec: view.spec });
    if (this.revertGate !== undefined) await this.revertGate;
    const next = this.nextRevert.shift();
    if (next === "throw") throw new Error("applier offline");
    if (next !== undefined) return next;
    this.reverted.add(view.id);
    return { outcome: "reverted", effect: { reverted: view.id } };
  }
}

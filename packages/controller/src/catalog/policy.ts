import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { operationIdOf } from "../domain/ids.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { RunningCallsChoice } from "./catalog.js";

const REF = { kind: "catalog-policy", id: "main" } as const;
export const RUNNING_CALL_POLICIES: readonly RunningCallsChoice[] = ["finish", "cancel", "pause"];

interface PolicyBody { readonly runningCalls?: RunningCallsChoice; readonly updatedBy: string; readonly updatedAt: string }
/** Where the policy in force comes from: the operator's startup option (it beats the setting), the owner's setting, the default, or `damaged` (the stored setting is unreadable, so calls are cancelled). */
export type PolicySource = "operator" | "setting" | "default" | "damaged";
export interface CatalogPolicyView {
  readonly revision: number; readonly runningCalls: RunningCallsChoice | null; readonly damaged: boolean; readonly default: RunningCallsChoice; readonly effective: RunningCallsChoice;
  /** What `effective` comes from. When it is `operator` the owner's setting is shown but does not apply until the operator drops the startup option. */
  readonly source: PolicySource;
}

/**
 * The owner's standing answer to "a version is revoked while calls of it run" (card T02c): `finish` (default), `cancel` or `pause` (the running call is stopped and its task is paused so the owner decides).
 * It is used only when a revoke names no choice of its own (an owner's chat choice always wins), and an operator's startup answer beats it (`get` says which applies). Owner only, race-safe (`expectedRevision`), replay-safe (command ID); `null` clears to the default.
 * A damaged record reads as `cancel` (a revocation is a safety act) and `get` says so.
 */
export class CatalogPolicyService {
  readonly #runner: CommandRunner;
  readonly #startup: RunningCallsChoice;
  readonly #operator: (() => unknown) | undefined;
  private constructor(runner: CommandRunner, startup: RunningCallsChoice, operator: (() => unknown) | undefined) { this.#runner = runner; this.#startup = startup; this.#operator = operator; }

  /** `operator`: the host program's own answer (the `tools.revocationPolicy` startup option); when given it beats the owner's setting, and `get` says so. */
  static withEpoch(storage: ControllerStorage, epoch: number, startup: RunningCallsChoice = "finish", options: RunnerOptions = {}, operator?: () => unknown): CatalogPolicyService {
    if (!RUNNING_CALL_POLICIES.includes(startup)) throw new RangeError("runningCalls default must be finish, cancel or pause");
    return new CatalogPolicyService(new CommandRunner(storage, epoch, options), startup, operator);
  }

  async get(by: Principal): Promise<CatalogPolicyView> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the catalogue policy`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const body = found?.body as unknown as PolicyBody | undefined;
    const damaged = found !== undefined && !this.#valid(body);
    const now = await this.#resolve();
    return { revision: found?.revision ?? 0, runningCalls: !damaged && body?.runningCalls !== undefined ? body.runningCalls : null, damaged, default: this.#startup, effective: now.choice, source: now.source };
  }

  async change(owner: Principal, command: NoActor & { runningCalls?: unknown; expectedRevision?: number }): Promise<{ revision: number; old: RunningCallsChoice | null; new: RunningCallsChoice | null; effective: RunningCallsChoice; source: PolicySource }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the catalogue policy`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "runningCalls", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (command.runningCalls === undefined) throw new DomainError("invalid_command", "runningCalls: name finish, cancel, pause or null to clear", { field: "runningCalls" });
    if (command.runningCalls !== null && !RUNNING_CALL_POLICIES.includes(command.runningCalls as RunningCallsChoice)) throw new DomainError("invalid_command", "runningCalls: must be finish, cancel, pause or null to clear", { field: "runningCalls" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const wanted = command.runningCalls as RunningCallsChoice | null;
    let old: RunningCallsChoice | null = null;
    const result = await this.#runner.command("catalog.policy.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { runningCalls: wanted, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the catalogue policy is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const before = current?.body as unknown as PolicyBody | undefined;
        old = this.#valid(before) && before?.runningCalls !== undefined ? before.runningCalls : null;
        const next: PolicyBody = { ...(wanted === null ? {} : { runningCalls: wanted }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { old, new: wanted } };
      },
    }));
    // A replay answers with what the first application recorded (the value it replaced), not with what the record holds now.
    if (result.replayed) old = await this.#recordedOld(owner, command.commandId);
    const now = await this.#resolve();
    return { revision: result.revision, old, new: wanted, effective: now.choice, source: now.source };
  }

  async #recordedOld(owner: Principal, commandId: string): Promise<RunningCallsChoice | null> {
    const stored = await this.#runner.storage.getOperation(operationIdOf(scopedCommandId(owner.id, commandId)));
    const seq = stored?.result.auditSeqs[0];
    if (seq === undefined) return null;
    const audit = (await this.#runner.storage.listAudit({ afterSeq: seq - 1, limit: 1 }))[0];
    const old = audit?.seq === seq ? audit.detail["old"] : undefined;
    return typeof old === "string" && (RUNNING_CALL_POLICIES as readonly string[]).includes(old) ? (old as RunningCallsChoice) : null;
  }

  async #resolve(): Promise<{ choice: RunningCallsChoice; source: PolicySource }> {
    if (this.#operator !== undefined) {
      // The operator's answer beats the setting. One that throws or answers anything else cancels (a revocation is a safety act).
      try { const v = await this.#operator(); return { choice: (RUNNING_CALL_POLICIES as readonly unknown[]).includes(v) ? (v as RunningCallsChoice) : "cancel", source: "operator" }; } catch { return { choice: "cancel", source: "operator" }; }
    }
    const found = await this.#runner.get(REF.kind, REF.id);
    if (found === undefined) return { choice: this.#startup, source: "default" };
    const body = found.body as unknown as PolicyBody;
    if (!this.#valid(body)) return { choice: "cancel", source: "damaged" };
    return body.runningCalls === undefined ? { choice: this.#startup, source: "default" } : { choice: body.runningCalls, source: "setting" };
  }

  /** What the bridge uses when a revoke carried no choice. Never throws for a damaged record: it reads as `cancel`. */
  async effective(): Promise<RunningCallsChoice> { return (await this.#resolve()).choice; }

  #valid(body: unknown): boolean {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
    const v = (body as PolicyBody).runningCalls;
    return v === undefined || RUNNING_CALL_POLICIES.includes(v);
  }
}

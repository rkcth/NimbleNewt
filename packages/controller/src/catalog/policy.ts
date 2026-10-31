import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { RunningCallsChoice } from "./catalog.js";

const REF = { kind: "catalog-policy", id: "main" } as const;
export const RUNNING_CALL_POLICIES: readonly RunningCallsChoice[] = ["finish", "cancel", "pause"];

interface PolicyBody { readonly runningCalls?: RunningCallsChoice; readonly updatedBy: string; readonly updatedAt: string }
export interface CatalogPolicyView { readonly revision: number; readonly runningCalls: RunningCallsChoice | null; readonly damaged: boolean; readonly default: RunningCallsChoice; readonly effective: RunningCallsChoice }

/**
 * The owner's standing answer to "a version is revoked while calls of it run" (card T02c): `finish` (default), `cancel` or `pause` (the task of each running call is paused so the owner decides; the call itself is not aborted).
 * It is used only when a revoke names no choice of its own (an owner's chat choice always wins). Owner only, race-safe (`expectedRevision`), replay-safe (command ID); `null` clears to the default.
 * A damaged record reads as `cancel` (a revocation is a safety act) and `get` says so.
 */
export class CatalogPolicyService {
  readonly #runner: CommandRunner;
  readonly #startup: RunningCallsChoice;
  private constructor(runner: CommandRunner, startup: RunningCallsChoice) { this.#runner = runner; this.#startup = startup; }

  static withEpoch(storage: ControllerStorage, epoch: number, startup: RunningCallsChoice = "finish", options: RunnerOptions = {}): CatalogPolicyService {
    if (!RUNNING_CALL_POLICIES.includes(startup)) throw new RangeError("runningCalls default must be finish, cancel or pause");
    return new CatalogPolicyService(new CommandRunner(storage, epoch, options), startup);
  }

  async get(by: Principal): Promise<CatalogPolicyView> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the catalogue policy`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const body = found?.body as unknown as PolicyBody | undefined;
    const damaged = found !== undefined && !this.#valid(body);
    return { revision: found?.revision ?? 0, runningCalls: !damaged && body?.runningCalls !== undefined ? body.runningCalls : null, damaged, default: this.#startup, effective: await this.effective() };
  }

  async change(owner: Principal, command: NoActor & { runningCalls?: unknown; expectedRevision?: number }): Promise<{ revision: number; old: RunningCallsChoice | null; new: RunningCallsChoice | null }> {
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
    return { revision: result.revision, old, new: wanted };
  }

  /** What the bridge uses when a revoke carried no choice. Never throws for a damaged record: it reads as `cancel`. */
  async effective(): Promise<RunningCallsChoice> {
    const found = await this.#runner.get(REF.kind, REF.id);
    if (found === undefined) return this.#startup;
    const body = found.body as unknown as PolicyBody;
    if (!this.#valid(body)) return "cancel";
    return body.runningCalls ?? this.#startup;
  }

  #valid(body: unknown): boolean {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
    const v = (body as PolicyBody).runningCalls;
    return v === undefined || RUNNING_CALL_POLICIES.includes(v);
  }
}

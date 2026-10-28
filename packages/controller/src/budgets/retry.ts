import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { BudgetService } from "./budgets.js";

export const CHARGE_RETRY_KIND = "charge-retry";
/** The charge exactly as `BudgetService.charge` takes it. Its command ID makes a retry count once. */
export type ChargeRequest = Parameters<BudgetService["charge"]>[1];

export interface RetryBody {
  readonly charge: JsonObject;
  readonly state: "pending" | "settled" | "dropped";
  readonly attempts: number;
  readonly firstFailedAt: string;
  readonly lastError: string;
  /** Not tried again before this time. */
  readonly nextAt: string;
  readonly endedAt?: string;
}

export const CHARGE_RETRY_LIMITS = { baseMs: 5_000, maxMs: 3_600_000, attempts: 20, scan: 1000, perSweep: 50 } as const;
/** Codes that no later try can change: the charge itself is wrong (an unknown task, a refused shape). Anything else (the ledger or the store was down, a lost race) is tried again. */
const PERMANENT = new Set(["invalid_command", "not_found", "forbidden", "unauthenticated"]);

export interface ChargeRetryOptions extends RunnerOptions {
  /** Told about a charge that was given up on, and about a failure to keep a failed charge (the charge is then lost). */
  readonly onDropped?: (event: { readonly commandId: string; readonly reason: string }) => void;
}

/**
 * A charge that cannot be booked now is kept and tried again (card R05g). Without this a review, job or meeting charged while the budget ledger was down was reported and then forgotten, so the spending was
 * missing from `budget.usage` for good. `submit` tries the charge at once; when that fails for a reason that may pass it records the charge and a time to try again, and `sweep` (a dispatcher loop) tries the due ones
 * with a doubling delay up to an hour and gives up after twenty tries or at once when the charge itself is wrong. The charge's command ID is its key, so a try that did land but whose answer was lost is not booked twice.
 */
export class ChargeRetryService {
  readonly #runner: CommandRunner;
  readonly #budgets: Pick<BudgetService, "charge">;
  readonly #options: ChargeRetryOptions;

  private constructor(runner: CommandRunner, budgets: Pick<BudgetService, "charge">, options: ChargeRetryOptions) { this.#runner = runner; this.#budgets = budgets; this.#options = options; }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: { budgets: Pick<BudgetService, "charge"> }, options: ChargeRetryOptions = {}): ChargeRetryService {
    return new ChargeRetryService(new CommandRunner(storage, epoch, options), deps.budgets, options);
  }

  /** Books the charge, or keeps it to try again. Returns whether it is booked now. A charge that is wrong in itself throws, as `BudgetService.charge` does. */
  async submit(by: Principal, charge: ChargeRequest): Promise<{ readonly booked: boolean }> {
    try {
      await this.#budgets.charge(by, charge);
      return { booked: true };
    } catch (error) {
      if (error instanceof DomainError && PERMANENT.has(error.code)) throw error;
      await this.#keep(by, charge, error);
      return { booked: false };
    }
  }

  /** Tries the charges that are due. Returns how many were booked, kept for later and given up. */
  async sweep(by: Principal): Promise<{ booked: number; later: number; dropped: number }> {
    const now = this.#runner.now();
    const out = { booked: 0, later: 0, dropped: 0 };
    let handled = 0;
    let seen = 0;
    for (let after: string | undefined; seen < CHARGE_RETRY_LIMITS.scan && handled < CHARGE_RETRY_LIMITS.perSweep;) {
      const page = await this.#runner.list(CHARGE_RETRY_KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const found of page) {
        after = found.id; seen++;
        const body = found.body as unknown as RetryBody;
        if (body.state !== "pending" || body.nextAt > now || handled >= CHARGE_RETRY_LIMITS.perSweep) continue;
        handled++;
        const result = await this.#try(by, found.id, found.revision, body);
        out[result]++;
      }
      if (page.length < 200) break;
    }
    return out;
  }

  /** The charges still waiting or given up on, for the owner. */
  async unsettled(by: Principal): Promise<{ id: string; body: RetryBody }[]> {
    if (by.kind !== "owner" && by.id !== "service:dispatcher") return [];
    const out: { id: string; body: RetryBody }[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(CHARGE_RETRY_KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const f of page) { after = f.id; const b = f.body as unknown as RetryBody; if (b.state !== "settled") out.push({ id: f.id, body: b }); }
      if (page.length < 200) return out;
    }
  }

  async #try(by: Principal, id: string, revision: number, body: RetryBody): Promise<"booked" | "later" | "dropped"> {
    const charge = body.charge as unknown as ChargeRequest;
    try {
      await this.#budgets.charge(by, charge);
      await this.#end(id, revision, body, "settled", body.lastError);
      return "booked";
    } catch (error) {
      const reason = describe(error);
      const permanent = error instanceof DomainError && PERMANENT.has(error.code);
      if (permanent || body.attempts + 1 >= CHARGE_RETRY_LIMITS.attempts) {
        await this.#end(id, revision, body, "dropped", reason);
        this.#options.onDropped?.({ commandId: String(body.charge["commandId"]), reason });
        return "dropped";
      }
      await this.#reschedule(id, revision, body, reason);
      return "later";
    }
  }

  async #keep(by: Principal, charge: ChargeRequest, error: unknown): Promise<void> {
    const id = derivedId("chq", scopedCommandId(by.id, charge.commandId));
    const at = this.#runner.now();
    const body: RetryBody = { charge: JSON.parse(JSON.stringify(charge)) as JsonObject, state: "pending", attempts: 1, firstFailedAt: at, lastError: describe(error), nextAt: later(at, 1) };
    try {
      await this.#runner.command("charge.keep", { commandId: scopedCommandId(by.id, `keep:${charge.commandId}`), actor: by.id }, async () => ({
        payload: { id },
        build: async () => {
          const ref = { kind: CHARGE_RETRY_KIND, id };
          const current = await this.#runner.get(CHARGE_RETRY_KIND, id);
          // Kept already (the same charge failed again): leave the earlier record and its count.
          if (current !== undefined) return { ref, creates: false, changes: [{ type: "check" as const, ref, expectedRevision: current.revision }], detail: { id } };
          return { ref, creates: true, changes: [{ type: "create" as const, ref, body: body as unknown as JsonObject }], detail: { id } };
        },
      }));
    } catch (kept) {
      // The charge could not even be kept (the store is down as well): it is lost, and the host is told.
      this.#options.onDropped?.({ commandId: charge.commandId, reason: `could not be kept for a retry: ${describe(kept)}` });
    }
  }

  async #end(id: string, revision: number, body: RetryBody, state: "settled" | "dropped", lastError: string): Promise<void> {
    const next: RetryBody = { ...body, state, lastError, endedAt: this.#runner.now() };
    await this.#update(id, revision, next, `end:${state}`);
  }

  async #reschedule(id: string, revision: number, body: RetryBody, lastError: string): Promise<void> {
    const attempts = body.attempts + 1;
    const next: RetryBody = { ...body, attempts, lastError, nextAt: later(this.#runner.now(), attempts) };
    await this.#update(id, revision, next, `try${attempts}`);
  }

  async #update(id: string, revision: number, next: RetryBody, step: string): Promise<void> {
    try {
      await this.#runner.command("charge.retry", { commandId: scopedCommandId("service:dispatcher", `retry:${id}:${step}`), actor: "service:dispatcher" }, async () => ({
        payload: { id, step },
        build: async () => {
          const ref = { kind: CHARGE_RETRY_KIND, id };
          return { ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: revision, body: next as unknown as JsonObject }], detail: { id, state: next.state } };
        },
      }));
    } catch (error) {
      // A concurrent sweep got there first; the budget's own key makes a double try harmless.
      if (!(error instanceof DomainError)) throw error;
    }
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const later = (iso: string, attempts: number): string => new Date(Date.parse(iso) + Math.min(CHARGE_RETRY_LIMITS.maxMs, CHARGE_RETRY_LIMITS.baseMs * 2 ** Math.min(20, attempts - 1))).toISOString();

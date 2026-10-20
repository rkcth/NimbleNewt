import { StorageError, type StorageErrorKind } from "./errors.js";
import type { ControllerStorage, OperationInput, OperationResult } from "./types.js";

export interface ScriptedFault {
  /** `before`: fail without touching the inner storage. `after`: let the inner storage commit, then fail (an ambiguous commit). */
  readonly when: "before" | "after";
  readonly kind: StorageErrorKind;
}

/**
 * Wraps any `ControllerStorage` and fails `applyOperation` calls as scripted, one fault per call in order, so the retry and
 * ambiguous-commit handling can be exercised identically against every adapter. Real connection loss is exercised against
 * the real databases by the adapter qualification (F04d).
 */
export class FaultInjectingStorage implements ControllerStorage {
  readonly #faults: ScriptedFault[];
  /** How many times `applyOperation` was called on this wrapper. */
  calls = 0;
  readonly #inner: ControllerStorage;

  constructor(inner: ControllerStorage, faults: readonly ScriptedFault[]) {
    this.#inner = inner;
    this.#faults = [...faults];
  }

  async applyOperation(input: OperationInput): Promise<OperationResult> {
    this.calls += 1;
    const fault = this.#faults.shift();
    if (fault === undefined) return this.#inner.applyOperation(input);
    if (fault.when === "after") await this.#inner.applyOperation(input);
    throw new StorageError(fault.kind, `injected ${fault.kind} (${fault.when} commit)`);
  }

  currentEpoch: ControllerStorage["currentEpoch"] = (...a) => this.#inner.currentEpoch(...a);
  acquireEpoch: ControllerStorage["acquireEpoch"] = (...a) => this.#inner.acquireEpoch(...a);
  getOperation: ControllerStorage["getOperation"] = (...a) => this.#inner.getOperation(...a);
  getAggregate: ControllerStorage["getAggregate"] = (...a) => this.#inner.getAggregate(...a);
  listAggregates: ControllerStorage["listAggregates"] = (...a) => this.#inner.listAggregates(...a);
  listAudit: ControllerStorage["listAudit"] = (...a) => this.#inner.listAudit(...a);
  claimDeliveries: ControllerStorage["claimDeliveries"] = (...a) => this.#inner.claimDeliveries(...a);
  retryDelivery: ControllerStorage["retryDelivery"] = (...a) => this.#inner.retryDelivery(...a);
  getDelivery: ControllerStorage["getDelivery"] = (...a) => this.#inner.getDelivery(...a);
  getEffect: ControllerStorage["getEffect"] = (...a) => this.#inner.getEffect(...a);
  claimDueTimers: ControllerStorage["claimDueTimers"] = (...a) => this.#inner.claimDueTimers(...a);
  getTimer: ControllerStorage["getTimer"] = (...a) => this.#inner.getTimer(...a);
  close: ControllerStorage["close"] = () => this.#inner.close();
}

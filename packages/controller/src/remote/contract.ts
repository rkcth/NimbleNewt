import { DomainError } from "../domain/errors.js";
import type { ContractLimits, DispatchContract, WorkOrder } from "../dispatch/ports.js";
import { BOUNDS, CONTRACT_FORMAT, MAX_PERMISSIONS, contractDigest, requiresOf, type ContractLimitName } from "./contract-wire.js";

export * from "./contract-wire.js";

/** The controller's half of carrying the dispatch contract to a remote worker (card H12a): sealing it onto an order and checking one that comes with a placement. The worker's half is `contract-wire.ts`. */

/** Puts the contract on the order with its digest. `parts.limits` and `bestEffort` are the owner's as read for this launch. */
export function sealContract(order: WorkOrder, parts: { readonly taskContractVersion: number; readonly permissions: readonly string[]; readonly budget?: DispatchContract["budget"]; readonly limits?: ContractLimits; readonly bestEffort: boolean }): WorkOrder {
  const limits = parts.limits !== undefined && Object.keys(parts.limits).length > 0 ? parts.limits : undefined;
  const body: Omit<DispatchContract, "digest"> = {
    format: CONTRACT_FORMAT, taskContractVersion: parts.taskContractVersion, permissions: [...parts.permissions].slice(0, MAX_PERMISSIONS),
    ...(parts.budget === undefined || Object.keys(parts.budget).length === 0 ? {} : { budget: parts.budget }), ...(limits === undefined ? {} : { limits }), bestEffort: parts.bestEffort,
    requires: requiresOf({ ...(limits === undefined ? {} : { limits }) }, order),
  };
  return { ...order, contract: { ...body, digest: contractDigest(order, body) } };
}

/** The shape of a contract as the controller accepts it with a placement: known fields only, bounded, and its digest matching the order it came with. Throws `invalid_command`. */
export function checkContract(order: WorkOrder): DispatchContract {
  const bad = (m: string): never => { throw new DomainError("invalid_command", `order.contract: ${m}`, { field: "order" }); };
  const c = order.contract as unknown as Record<string, unknown> | undefined;
  if (c === undefined || c === null || typeof c !== "object" || Array.isArray(c)) return bad("must be an object");
  for (const k of Object.keys(c)) if (!["format", "taskContractVersion", "permissions", "budget", "limits", "bestEffort", "requires", "digest"].includes(k)) bad(`${k.slice(0, 30)} is not a field of the contract`);
  if (!Number.isSafeInteger(c["format"])) bad("format must be a whole number");
  if (!Number.isSafeInteger(c["taskContractVersion"]) || (c["taskContractVersion"] as number) < 0) bad("taskContractVersion must be a whole number");
  if (!Array.isArray(c["permissions"]) || c["permissions"].length > MAX_PERMISSIONS || c["permissions"].some((p) => typeof p !== "string" || p.length > 200)) bad(`permissions must be a list of at most ${MAX_PERMISSIONS} short strings`);
  if (typeof c["bestEffort"] !== "boolean") bad("bestEffort must be true or false");
  if (!Array.isArray(c["requires"]) || c["requires"].length > 8 || c["requires"].some((p) => typeof p !== "string" || p.length > 40)) bad("requires must be a short list of names");
  if (c["limits"] !== undefined) {
    const l = c["limits"] as Record<string, unknown>;
    if (l === null || typeof l !== "object" || Array.isArray(l)) bad("limits must be an object");
    for (const [k, v] of Object.entries(l)) {
      if (!Object.hasOwn(BOUNDS, k)) bad(`limits.${k.slice(0, 30)} is not a limit`);
      const [lo, hi] = BOUNDS[k as ContractLimitName];
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < lo || v > hi) bad(`limits.${k} must be a whole number from ${lo} to ${hi}`);
    }
  }
  if (c["budget"] !== undefined && (c["budget"] === null || typeof c["budget"] !== "object" || Array.isArray(c["budget"]))) bad("budget must be an object");
  if (typeof c["digest"] !== "string") bad("digest must be a string");
  const { digest, ...rest } = c as unknown as DispatchContract;
  if (contractDigest(order, rest) !== digest) bad("the digest does not match the order");
  return c as unknown as DispatchContract;
}


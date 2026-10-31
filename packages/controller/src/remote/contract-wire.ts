import { createHash } from "node:crypto";
import type { ContractLimits, DispatchContract, WorkOrder } from "../dispatch/ports.js";

/**
 * Carrying the dispatch contract to a remote worker (card H12a). The controller seals the contract onto the order (`sealContract`); the worker checks that it can honour it (`contractProblems`) and
 * either confirms it (`launched`, with what it really enforces) or refuses the order; the controller lets no tool call through until the confirmation for this very placement and digest is on record.
 */

export const CONTRACT_FORMAT = 1;
/** What a worker may be asked to enforce itself. */
export const CONTRACT_FEATURES = ["limits", "wall-time"] as const;
export const CONTRACT_LIMIT_NAMES = ["cpus", "memoryMb", "diskMb", "processes", "wallTimeMs"] as const;
export type ContractLimitName = (typeof CONTRACT_LIMIT_NAMES)[number];
export type Enforced = "full" | "partial" | "none";

export const BOUNDS: Record<ContractLimitName, readonly [number, number]> = { cpus: [1, 256], memoryMb: [16, 4_194_304], diskMb: [1, 16_777_216], processes: [1, 100_000], wallTimeMs: [1000, 604_800_000] };
export const MAX_PERMISSIONS = 200;

/** The part of an order the digest covers: who and what the attempt is, how it is sandboxed and until when. Never the credential. */
function identity(order: WorkOrder): unknown {
  return { attemptId: order.attemptId, taskId: order.taskId, projectId: order.projectId, agentId: order.agentId, generation: order.generation, route: order.route, harness: order.harness ?? null, recipe: order.recipe, expiresAt: order.expiresAt ?? null };
}

/** Keys sorted at every level, so the same figures give the same text on every machine. `undefined` members are left out. */
export function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function contractDigest(order: WorkOrder, contract: Omit<DispatchContract, "digest">): string {
  return createHash("sha256").update(stable({ order: identity(order), contract })).digest("hex");
}

export function requiresOf(contract: { readonly limits?: ContractLimits }, order: { readonly expiresAt?: string }): string[] {
  const out: string[] = [];
  const keys = Object.keys(contract.limits ?? {});
  if (keys.some((k) => k !== "wallTimeMs")) out.push("limits");
  if (contract.limits?.wallTimeMs !== undefined || order.expiresAt !== undefined) out.push("wall-time");
  return out;
}

/** What a worker can hold. `enforces` says, per limit, how far its sandbox enforces it. */
export interface WorkerAbilities {
  /** The contract formats it speaks. */
  readonly formats: readonly number[];
  /** The `requires` names it knows. */
  readonly features: readonly string[];
  readonly enforces: Partial<Record<ContractLimitName, Enforced>>;
}

/**
 * Why this worker cannot honour the order's contract; empty: it can. An order with no contract is refused (a worker never runs unbound), and so is one whose digest does not match what was sent. Pure, so the same
 * rule runs on any worker implementation; `now` is an ISO time.
 */
export function contractProblems(order: WorkOrder, abilities: WorkerAbilities, now: string): string[] {
  const c = order.contract;
  if (c === undefined) return ["the order carries no dispatch contract"];
  const problems: string[] = [];
  if (!abilities.formats.includes(c.format)) return [`this worker does not speak dispatch contract format ${String(c.format)}`];
  const { digest, ...rest } = c;
  if (contractDigest(order, rest) !== digest) problems.push("the contract does not match the order it came with (digest)");
  for (const need of c.requires) if (!abilities.features.includes(need)) problems.push(`this worker cannot enforce ${need}`);
  for (const [name, value] of Object.entries(c.limits ?? {})) {
    if (value === undefined) continue;
    const level = abilities.enforces[name as ContractLimitName] ?? "none";
    if (level !== "full" && !c.bestEffort) problems.push(`the limit ${name} (${String(value)}) would be enforced ${level === "none" ? "not at all" : "only in part"} and the owner has not allowed best effort`);
  }
  if (order.expiresAt !== undefined && order.expiresAt <= now) problems.push("the attempt has already expired");
  return problems;
}

/** What a worker reports once it has applied the contract: per limit, how far it is enforced. Bounded and checked by the controller. */
export interface ContractEnforcement { readonly limit: ContractLimitName; readonly value: number; readonly enforced: Enforced; readonly detail?: string }

export function enforcementFor(contract: DispatchContract, abilities: WorkerAbilities): ContractEnforcement[] {
  return Object.entries(contract.limits ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => ({ limit: k as ContractLimitName, value: v as number, enforced: abilities.enforces[k as ContractLimitName] ?? "none" }));
}

/**
 * The digest a worker confirms after a `restart` that changed the recipe (reach or limits): the digest it held, bound to the new recipe. Both sides compute it the same way, so the confirmation names
 * exactly the recipe the worker is about to run. It is a binding, not authentication (see the notes on the transport).
 */
export function restartDigest(previous: string, recipe: { readonly revision: string; readonly reach: readonly string[]; readonly limits?: object }): string {
  return createHash("sha256").update(stable({ previous, recipe: { revision: recipe.revision, reach: recipe.reach, limits: recipe.limits ?? null } })).digest("hex");
}

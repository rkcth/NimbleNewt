import type { RoutingTable } from "../routing/policy.js";

/** What a task has spent, as the budget accounting reports it (only the figures this text needs). */
export interface CostFigures {
  readonly currency: string;
  readonly limit: { readonly costMicros: number };
  readonly spent: { readonly costMicros: number };
  readonly uncertain: { readonly costMicros: number };
}

const money = (micros: number, currency: string): string => `${(micros / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0")} ${currency}`.slice(0, 40);
const providerOf = (route: string): string => route.slice(0, Math.max(0, route.indexOf("/")));

/**
 * What a change of model route costs the owner, in plain words (card G09 follow-up). The owner is told, where the change is recorded, whether the route the work now runs on is paid or free, what the route it left was, and
 * what the task has spent against its limit so far. Only facts the controller holds are said: the routing table (a provider is paid or not) and the task's budget accounting. There is no price list, so a paid route is
 * never given a rate or a forecast; the words say that every call is charged to the task's budget and name the figures. Anything unknown is said to be unknown, never guessed: a route whose provider is not in the table
 * is "not in the routing table", not free.
 */
export function routeCostWords(input: { readonly table: Pick<RoutingTable, "providers"> | undefined; readonly from: string | undefined; readonly to: string; readonly budget: CostFigures | undefined }): string {
  const { table, from, to, budget } = input;
  const kindOf = (route: string): "paid" | "free" | "unknown" => {
    const provider = providerOf(route);
    const entry = table === undefined || provider === "" || !Object.hasOwn(table.providers, provider) ? undefined : table.providers[provider];
    return entry === undefined ? "unknown" : entry.paid ? "paid" : "free";
  };
  const now = kindOf(to);
  const before = from === undefined ? undefined : kindOf(from);
  const parts: string[] = [];
  if (now === "paid") parts.push(`Cost: route ${to} is paid, so every call it makes is charged to this task's budget${before === "paid" ? " (the route it left was paid too)" : before === "free" ? " (the route it left was free: this change starts a charge)" : ""}.`);
  else if (now === "free") parts.push(`Cost: route ${to} is free, so its calls add nothing to this task's budget${before === "paid" ? " (the route it left was paid: this change stops the charge)" : before === "free" ? " (the route it left was free too)" : ""}.`);
  else parts.push(`Cost: route ${to} is not in the routing table, so whether it is paid is not known.`);
  if (now !== "free" && budget !== undefined) {
    const spent = budget.spent.costMicros + budget.uncertain.costMicros;
    parts.push(budget.limit.costMicros > 0 ? `So far the task has spent ${money(spent, budget.currency)} of its ${money(budget.limit.costMicros, budget.currency)} limit${budget.uncertain.costMicros > 0 ? ` (${money(budget.uncertain.costMicros, budget.currency)} of it not yet settled)` : ""}.` : `So far the task has spent ${money(spent, budget.currency)}; it has no money limit.`);
  } else if (now !== "free") parts.push("The task has no budget record, so its spending so far is not shown.");
  return parts.join(" ");
}

import { ACTION_CLASSES, ENVIRONMENTS, EXECUTION_TOOLS, TIERS, tierOf, type ActionClass, type Environment, type Tier } from "./catalog.js";

/** What to do with an action: run it; have an independent agent review it; or ask the owner. */
export type Mode = "allow" | "agent-review" | "owner";
export const MODES: readonly Mode[] = ["allow", "agent-review", "owner"];
/** Tightness: a larger number asks more. */
export const tightness = (mode: Mode): number => (mode === "allow" ? 0 : mode === "agent-review" ? 1 : 2);

export type Profile = "strict" | "derived" | "autonomous";
export const PROFILES: readonly Profile[] = ["strict", "derived", "autonomous"];

/** The key of one cell of the policy table: a class in a tier of environment. */
export type CellKey = `${ActionClass}.${Tier}`;
export const CELL_KEYS: readonly CellKey[] = ACTION_CLASSES.flatMap((c) => TIERS.map((t) => `${c}.${t}` as CellKey));

const row = (free: Mode, guarded: Mode, live: Mode): Record<Tier, Mode> => ({ free, guarded, live });

/**
 * The built-in tables. `strict` asks the owner for every consequential class; it is what a new installation starts in. `derived` leans toward less asking: routine work flows in development
 * and testing, a staging deployment and the shared-state classes get an independent review, and the owner is asked for what only the owner should decide. `autonomous` acts within grants.
 * Whatever the table says, the engine adds the things that stay decisions (see `evaluate`).
 */
export const PROFILE_TABLES: Readonly<Record<Profile, Readonly<Record<ActionClass, Record<Tier, Mode>>>>> = {
  strict: {
    "inspect": row("allow", "allow", "allow"), "workspace-edit": row("allow", "allow", "allow"),
    "mutate": row("owner", "owner", "owner"), "external-send": row("owner", "owner", "owner"), "publish": row("owner", "owner", "owner"), "spend": row("owner", "owner", "owner"),
    "install-executable": row("owner", "owner", "owner"), "access-change": row("owner", "owner", "owner"), "commit": row("owner", "owner", "owner"),
    "push": row("owner", "owner", "owner"), "merge": row("owner", "owner", "owner"), "deploy": row("owner", "owner", "owner"),
  },
  derived: {
    "inspect": row("allow", "allow", "allow"), "workspace-edit": row("allow", "allow", "allow"),
    "mutate": row("allow", "agent-review", "owner"), "external-send": row("owner", "owner", "owner"), "publish": row("owner", "owner", "owner"), "spend": row("allow", "agent-review", "owner"),
    "install-executable": row("agent-review", "agent-review", "owner"), "access-change": row("owner", "owner", "owner"), "commit": row("allow", "allow", "agent-review"),
    "push": row("allow", "allow", "agent-review"), "merge": row("allow", "agent-review", "owner"), "deploy": row("allow", "agent-review", "owner"),
  },
  autonomous: {
    "inspect": row("allow", "allow", "allow"), "workspace-edit": row("allow", "allow", "allow"),
    "mutate": row("allow", "allow", "agent-review"), "external-send": row("allow", "allow", "agent-review"), "publish": row("agent-review", "agent-review", "owner"), "spend": row("allow", "allow", "agent-review"),
    "install-executable": row("allow", "allow", "agent-review"), "access-change": row("owner", "owner", "owner"), "commit": row("allow", "allow", "allow"),
    "push": row("allow", "allow", "allow"), "merge": row("allow", "allow", "agent-review"), "deploy": row("allow", "allow", "owner"),
  },
};

/** What the engine knows of the grants the actor holds (already filtered to the project and the time): only terms matter here. */
export interface GrantView {
  readonly id: string;
  /** The approval grant's action: `approve.tool.<name>` or `approve.class.<class>` (exact), or a wildcard such as `approve.class.*` or `approve.*`. Capability grants (`tool.*`, `*`) are never approval grants. */
  readonly action: string;
  readonly environments?: readonly string[];
  readonly spendLimit?: number;
  readonly window?: { readonly start: string; readonly end: string; readonly days?: readonly number[] };
  readonly audiences?: readonly string[];
  /** The protected branches the grant waives, by exact name (card A07f). */
  readonly branches?: readonly string[];
  /** How the grant came about (`standing` for one made from a proposal or a standing rule). A standing grant never waives what stays a decision, however exactly it names it. */
  readonly source?: string;
}

export interface PolicyRequest {
  readonly tool: string;
  readonly cls: ActionClass | "unknown";
  readonly environment: Environment;
  readonly estimatedSpend?: number;
  readonly branchProtected?: boolean;
  /** The branch a push or merge changes, when it is known (card A07f). */
  readonly branch?: string;
  /** A send or publication to an audience that no grant names. */
  readonly audience?: string;
  /** The action cannot be undone outside a sandbox. */
  readonly irreversible?: boolean;
  /** The instruction's scope: the permission ceiling of the task contract, who approved it, and what budget is left. */
  readonly scope?: { readonly ceiling: readonly string[]; readonly approvedBy: string; readonly budgetRemaining?: number };
  readonly now: string;
}

export interface PolicyView {
  readonly profile: Profile;
  readonly allCommandGate: boolean;
  /** The mode of each cell, after overrides. */
  readonly cells: Readonly<Record<CellKey, Mode>>;
  readonly mandatoryHuman: readonly string[];
}

export interface Decision {
  readonly mode: Mode | "deny";
  readonly cls: ActionClass | "unknown";
  readonly tier: Tier;
  /** Why, in order of the rules that applied. */
  readonly reasons: readonly string[];
  /** What decided it. */
  readonly via: "restriction" | "reserved" | "all-command-gate" | "unknown-action" | "grant" | "must-decide" | "scope" | "profile";
  readonly grantId?: string;
  readonly profile: Profile;
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
function inWindow(window: NonNullable<GrantView["window"]>, now: string): boolean {
  const d = new Date(now);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const start = toMinutes(window.start); const end = toMinutes(window.end);
  const hours = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  return hours && (window.days === undefined || window.days.includes(d.getUTCDay()));
}
/**
 * Whether an approval grant covers this tool or class, and whether it names it exactly. Only actions in the `approve.` family count: a grant that gives an agent the capability to use a tool
 * (`tool.deploy`, `tool.*`, `*`) says nothing about asking and is ignored here.
 */
function approves(grant: GrantView, tool: string, cls: string): { covers: boolean; exact: boolean } {
  const a = grant.action;
  if (!a.startsWith("approve.")) return { covers: false, exact: false };
  const targets = [`approve.tool.${tool}`, `approve.class.${cls}`];
  if (targets.includes(a)) return { covers: true, exact: true };
  return { covers: a === "approve.*" || (a.endsWith(".*") && targets.some((t) => t.startsWith(a.slice(0, -1)))), exact: false };
}

/** Whether a grant's terms are met by this request; `why` is the first term that is not. */
export function termsMet(grant: GrantView, request: PolicyRequest): { ok: true } | { ok: false; why: string } {
  if (grant.environments !== undefined && !grant.environments.includes(request.environment)) return { ok: false, why: `the grant is for ${grant.environments.join(", ")}, not ${request.environment}` };
  if (grant.window !== undefined && !inWindow(grant.window, request.now)) return { ok: false, why: "the grant applies only in its time window" };
  if (request.cls === "spend" || request.estimatedSpend !== undefined) {
    const amount = request.estimatedSpend ?? 0;
    if (grant.spendLimit !== undefined && amount > grant.spendLimit) return { ok: false, why: `the spend ${amount} is above the grant's limit ${grant.spendLimit}` };
    if (request.cls === "spend" && grant.spendLimit === undefined) return { ok: false, why: "a spend grant has to state its limit" };
  }
  if ((request.cls === "external-send" || request.cls === "publish") && request.audience !== undefined && !(grant.audiences ?? []).includes(request.audience)) return { ok: false, why: `the grant does not name the audience ${request.audience}` };
  if ((request.cls === "external-send" || request.cls === "publish") && request.audience === undefined) return { ok: false, why: "the request does not say who it goes to, so no grant for named audiences covers it" };
  return { ok: true };
}

/**
 * The decision for one action (card A07). In order: a restriction denies; a tool the policy reserves for the owner, and every execution when the all-command gate is on, goes to the owner; an
 * action the catalogue does not know goes to review; an approval grant (`approve.tool.<name>` or `approve.class.<class>`, never a capability grant) whose terms are met allows it, and for a thing that
 * stays a decision it must name the tool or class exactly and, for a customer-live deployment, the environment; things that stay a decision (changing access, a customer-live deployment, a protected
 * branch, spending beyond the estimate, an irreversible destructive action, a send or publication to an audience no grant names) go to the owner unless the owner's instruction named that very tool;
 * the instruction's own scope allows what its ceiling covers; and otherwise the profile's table decides. Nothing in the order lets a profile, a ceiling or a grant override a reservation.
 */
export function evaluate(policy: PolicyView, request: PolicyRequest, held: readonly GrantView[], restricted: boolean): Decision {
  const tier = tierOf(request.environment);
  const base = { cls: request.cls, tier, profile: policy.profile } as const;
  if (restricted) return { ...base, mode: "deny", via: "restriction", reasons: ["a standing restriction forbids it"] };
  if (policy.mandatoryHuman.includes(request.tool)) return { ...base, mode: "owner", via: "reserved", reasons: [`${request.tool} is reserved for the owner`] };
  if (policy.allCommandGate && (EXECUTION_TOOLS.has(request.tool) || request.cls === "install-executable")) return { ...base, mode: "owner", via: "all-command-gate", reasons: ["the all-command gate asks the owner before every execution (a program run, or an install that runs one)"] };
  if (request.cls === "unknown") {
    return { ...base, mode: policy.profile === "strict" ? "owner" : "agent-review", via: "unknown-action", reasons: [`${request.tool} is not a classified action, so it goes to review and is never allowed unasked`] };
  }
  const reasons: string[] = [];
  const tool = `tool.${request.tool}`;
  const named = request.scope !== undefined && request.scope.ceiling.includes(tool) && request.scope.approvedBy.startsWith("owner:");
  const decisions: string[] = [];
  if (request.cls === "access-change") decisions.push("it changes access");
  if (request.cls === "deploy" && tier === "live") decisions.push("it deploys to a customer-live environment");
  if ((request.cls === "push" || request.cls === "merge") && request.branchProtected === true) decisions.push("it changes a protected branch");
  if (request.cls === "spend" || request.estimatedSpend !== undefined) {
    const left = request.scope?.budgetRemaining;
    if (request.cls === "spend" && (left === undefined || (request.estimatedSpend ?? 0) > left)) decisions.push(left === undefined ? "it spends with no estimate to spend within" : `it spends ${request.estimatedSpend ?? 0}, beyond the ${left} left of the estimate`);
    if (request.cls !== "spend" && left !== undefined && (request.estimatedSpend ?? 0) > left) decisions.push(`it would spend ${request.estimatedSpend ?? 0}, beyond the ${left} left of the estimate`);
  }
  if (request.irreversible === true) decisions.push("it cannot be undone outside a sandbox");
  const audienceNamed = held.some((g) => approves(g, request.tool, request.cls).covers && (g.audiences ?? []).includes(request.audience ?? ""));
  if ((request.cls === "external-send" || request.cls === "publish") && !audienceNamed) decisions.push("it goes to an audience no grant names");
  // An approval grant waives asking. For a thing that stays a decision it has to name that tool or class exactly (no wildcard), and for a customer-live deployment it has to name that environment.
  for (const grant of held) {
    const match = approves(grant, request.tool, request.cls);
    if (!match.covers) continue;
    if (decisions.length > 0 && grant.source === "standing") { reasons.push(`grant ${grant.id} is a standing grant and cannot waive what stays a decision (${decisions.join("; ")})`); continue; }
    if (decisions.length > 0 && !match.exact) { reasons.push(`grant ${grant.id} is a wildcard and cannot waive what stays a decision (${decisions.join("; ")})`); continue; }
    if (request.cls === "deploy" && tier === "live" && !(grant.environments ?? []).includes("customer-live")) { reasons.push(`grant ${grant.id} does not name customer-live, which a live deployment needs`); continue; }
    if ((request.cls === "push" || request.cls === "merge") && request.branchProtected === true && (request.branch === undefined || !(grant.branches ?? []).includes(request.branch))) { reasons.push(`grant ${grant.id} does not name the protected branch${request.branch === undefined ? "" : ` ${request.branch}`}`); continue; }
    const terms = termsMet(grant, request);
    if (terms.ok) return { ...base, mode: "allow", via: "grant", grantId: grant.id, reasons: [`approval grant ${grant.id} covers it`] };
    reasons.push(`grant ${grant.id} does not apply: ${terms.why}`);
  }
  if (decisions.length > 0 && !named) {
    return { ...base, mode: "owner", via: "must-decide", reasons: [...reasons, `this stays a decision for the owner: ${decisions.join("; ")}`] };
  }
  if (decisions.length > 0 && named) reasons.push(`the owner's instruction names ${tool}`);
  const table = policy.cells[`${request.cls}.${tier}` as CellKey];
  // The instruction's scope: what its ceiling covers (by tool or by class) is allowed, never beyond a reservation, a customer-live environment or something that stays a decision.
  const covered = request.scope !== undefined && (request.scope.ceiling.includes(tool) || request.scope.ceiling.includes(`class.${request.cls}`));
  if (covered && request.scope !== undefined && (policy.profile === "derived" || request.scope.approvedBy.startsWith("owner:")) && (tier !== "live" || named)) {
    return { ...base, mode: "allow", via: "scope", reasons: [...reasons, `the instruction's ceiling covers ${request.tool}${named ? " by name" : ""}`] };
  }
  return { ...base, mode: table, via: "profile", reasons: [...reasons, `the ${policy.profile} profile puts ${request.cls} in ${tier} environments at ${table}`] };
}

export { ENVIRONMENTS };

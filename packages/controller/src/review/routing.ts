import { DomainError } from "../domain/errors.js";
import { text } from "../domain/model.js";
import { redactText } from "../security/redact.js";
import { sha256 } from "../storage/json.js";

/** What the owner decides per project about who may review (card H05). The numbers are provisional and adjustable (decision record, 2026-10-20). */
export interface ReviewPolicyBody {
  /** `required`: a contributor to the work never reviews it. `preferred`: a contributor (never the requester) may review when no one else is eligible. */
  readonly independence: "required" | "preferred";
  /** Designated reviewers (agent principals). Empty: every active agent that holds `review.decide` in the project is eligible. */
  readonly reviewers: readonly string[];
  /** Authorized fallbacks, used only when no designated reviewer is eligible. */
  readonly fallbackReviewers: readonly string[];
  /** Minutes a review may wait for a verdict, or for a reviewer, before it moves on (to a fallback, then to the owner). */
  readonly deadlineMinutes: number;
  /** Tool names that only the owner may review: never routed to an agent and never cleared by an earlier agent approval. */
  readonly mandatoryHuman: readonly string[];
}

export const DEFAULT_POLICY: ReviewPolicyBody = { independence: "required", reviewers: [], fallbackReviewers: [], deadlineMinutes: 60, mandatoryHuman: [] };
export const ROUTING_LIMITS = { reviewers: 50, mandatoryHuman: 50, minDeadlineMinutes: 1, maxDeadlineMinutes: 1440, scan: 5000, history: 40, contextList: 50, contextItem: 500, contextText: 4000, cost: 1_000_000 } as const;

const PRINCIPAL = /^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL = /^[a-z][a-z0-9._-]{0,79}$/;
const HEX = /^[0-9a-f]{64}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

export function checkPolicy(value: unknown): ReviewPolicyBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("policy", "must be an object");
  const p = value as Record<string, unknown>;
  for (const key of Object.keys(p)) if (!["independence", "reviewers", "fallbackReviewers", "deadlineMinutes", "mandatoryHuman"].includes(key)) invalid(`policy.${key}`, "is not a policy field");
  const list = (v: unknown, field: string, max: number, one: RegExp, what: string): string[] => {
    const raw = v === undefined ? [] : v;
    if (!Array.isArray(raw) || raw.length > max) return invalid(field, `must be a list of at most ${max} ${what}`);
    const out = raw.map((x, i) => (typeof x === "string" && one.test(x) ? x : invalid(`${field}[${i}]`, `must be ${what.replace(/s$/, "")}`)));
    if (new Set(out).size !== out.length) invalid(field, "must not repeat an entry");
    return out;
  };
  const independence = p["independence"] === undefined ? DEFAULT_POLICY.independence : p["independence"] === "required" || p["independence"] === "preferred" ? p["independence"] : invalid("policy.independence", "must be required or preferred");
  const minutes = p["deadlineMinutes"] === undefined ? DEFAULT_POLICY.deadlineMinutes : p["deadlineMinutes"];
  if (typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < ROUTING_LIMITS.minDeadlineMinutes || minutes > ROUTING_LIMITS.maxDeadlineMinutes) invalid("policy.deadlineMinutes", `must be a whole number from ${ROUTING_LIMITS.minDeadlineMinutes} to ${ROUTING_LIMITS.maxDeadlineMinutes}`);
  const reviewers = list(p["reviewers"], "policy.reviewers", ROUTING_LIMITS.reviewers, PRINCIPAL, "agent principal IDs such as agent:agt-...");
  const fallbackReviewers = list(p["fallbackReviewers"], "policy.fallbackReviewers", ROUTING_LIMITS.reviewers, PRINCIPAL, "agent principal IDs such as agent:agt-...");
  const overlap = reviewers.find((r) => fallbackReviewers.includes(r));
  if (overlap !== undefined) invalid("policy.fallbackReviewers", `${overlap} is already a designated reviewer`);
  return { independence, reviewers, fallbackReviewers, deadlineMinutes: minutes as number, mandatoryHuman: list(p["mandatoryHuman"], "policy.mandatoryHuman", ROUTING_LIMITS.mandatoryHuman, TOOL, "tool names") };
}

/** The context a reviewer is shown with an operation. Credentials in it are replaced before it is stored. */
export interface ReviewContext {
  readonly toolVersion?: string;
  readonly workingDirectory?: string;
  readonly environmentRevision?: string;
  readonly affectedResources?: readonly string[];
  readonly scriptHashes?: readonly string[];
  readonly expectedEffects?: readonly string[];
  readonly authoritySource?: string;
  readonly budget?: string;
  readonly boundedContext?: string;
}

export interface StoredContext extends ReviewContext {
  /** True when something in the context looked like a credential and was replaced. */
  readonly redacted: boolean;
}

/** Without these a reviewer cannot judge the operation, so `allow` is refused until they are supplied. */
export const ESSENTIAL_CONTEXT = ["toolVersion", "authoritySource", "expectedEffects"] as const;

export function checkContext(value: unknown, script: string | undefined, field = "context"): StoredContext {
  const c = value === undefined ? {} : value;
  if (c === null || typeof c !== "object" || Array.isArray(c)) return invalid(field, "must be an object");
  const r = c as Record<string, unknown>;
  const allowed = ["toolVersion", "workingDirectory", "environmentRevision", "affectedResources", "scriptHashes", "expectedEffects", "authoritySource", "budget", "boundedContext"];
  for (const key of Object.keys(r)) if (!allowed.includes(key)) invalid(`${field}.${key}`, "is not a context field");
  let redacted = false;
  const clean = (s: string): string => { const out = redactText(s); if (out !== s) redacted = true; return out; };
  const one = (key: string, max: number = ROUTING_LIMITS.contextItem, multiline = false): string | undefined => (r[key] === undefined ? undefined : clean(text(r[key], `${field}.${key}`, { min: 1, max, multiline })));
  const many = (key: string): string[] | undefined => {
    if (r[key] === undefined) return undefined;
    const v = r[key];
    if (!Array.isArray(v) || v.length > ROUTING_LIMITS.contextList) return invalid(`${field}.${key}`, `must be a list of at most ${ROUTING_LIMITS.contextList} entries`);
    return v.map((x, i) => clean(text(x, `${field}.${key}[${i}]`, { min: 1, max: ROUTING_LIMITS.contextItem })));
  };
  const hashes = many("scriptHashes");
  for (const h of hashes ?? []) if (!HEX.test(h)) invalid(`${field}.scriptHashes`, "must be SHA-256 digests in lower-case hex");
  // The hash of the script under review is always there, whatever the requester listed.
  const scriptHashes = script === undefined && hashes === undefined ? undefined : [...new Set([...(hashes ?? []), ...(script === undefined ? [] : [sha256(script)])])].sort();
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown): void => { if (v !== undefined) out[k] = v; };
  set("toolVersion", one("toolVersion", 100)); set("workingDirectory", one("workingDirectory")); set("environmentRevision", one("environmentRevision", 100));
  set("affectedResources", many("affectedResources")); set("scriptHashes", scriptHashes); set("expectedEffects", many("expectedEffects"));
  set("authoritySource", one("authoritySource")); set("budget", one("budget")); set("boundedContext", one("boundedContext", ROUTING_LIMITS.contextText, true));
  return { ...(out as ReviewContext), redacted };
}

/** The essential context that is missing (empty when the reviewer has what is needed). */
export function missingEssentials(context: ReviewContext | undefined): string[] {
  const c = context ?? {};
  return ESSENTIAL_CONTEXT.filter((k) => (k === "expectedEffects" ? (c.expectedEffects ?? []).length === 0 : (c[k] ?? "").trim() === ""));
}

/** Newer values replace older ones; lists replace whole. */
export function mergeContext(old: StoredContext | undefined, update: StoredContext): StoredContext {
  return { ...(old ?? {}), ...update, redacted: (old?.redacted ?? false) || update.redacted };
}

export type RouteState = "assigned" | "waiting" | "escalated";

export interface RouteEvent { readonly at: string; readonly event: string; readonly detail: string }

/** Where one review stands in routing: who is on it, why others are not, and the figures kept about it. */
export interface ReviewRouteBody {
  readonly projectId: string;
  readonly taskId: string;
  readonly requester: string;
  readonly state: RouteState;
  readonly assigned?: string;
  readonly assignedVia?: "designated" | "pool" | "fallback";
  /** Reviewers already tried on this review (they did not decide in time or became contributors); they are not chosen again. */
  readonly tried: readonly string[];
  readonly contributors: readonly string[];
  /** When this stage ends: the reviewer's time to decide, or the wait for an eligible reviewer. After it the review moves on. */
  readonly deadline: string;
  readonly mandatoryHuman: boolean;
  readonly events: readonly RouteEvent[];
  readonly requestedAt: string;
  readonly assignedAt?: string;
  readonly decidedAt?: string;
  readonly queueMs?: number;
  readonly latencyMs?: number;
  readonly cost?: number;
  readonly verdict?: string;
  /** True once the review was withdrawn; the route is then closed. */
  readonly withdrawn?: boolean;
  readonly falseBlock?: boolean;
  readonly missedHazard?: boolean;
}

export const addEvent = (events: readonly RouteEvent[], at: string, event: string, detail: string): RouteEvent[] => [...events, { at, event, detail: detail.slice(0, 300) }].slice(-ROUTING_LIMITS.history);

export const minutesLater = (at: string, minutes: number): string => new Date(Date.parse(at) + minutes * 60_000).toISOString();

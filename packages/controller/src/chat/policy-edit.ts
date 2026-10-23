import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { onlyKnown } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { ConversationService } from "../conversations/conversations.js";
import { ACTION_CLASSES, ActionCatalog, ENVIRONMENTS, tierOf, type ActionClass, type Environment, type Tier } from "../policy/catalog.js";
import { CELL_KEYS, tightness, type Mode } from "../policy/engine.js";
import type { PolicyBody, PolicyService } from "../policy/policy.js";
import type { ConfigurationService } from "../configuration/configuration.js";
import { definitionFor, type SettingDefinition } from "../configuration/settings.js";
import type { ReviewPolicyBody } from "../review/routing.js";
import type { ReviewService } from "../review/review.js";
import { scopedCommandId } from "../security/credentials.js";
import type { GrantRecordBody, GrantService } from "../security/grants.js";
import type { Principal } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { foreignValue } from "./commands.js";
import { checkIntents, evidenceInText, evidenceStrong, refuseCredentials, splitQuoted, type ChatInterpreter } from "./interpreter.js";
import type { PolicyEditChange } from "./policy-intent.js";

/**
 * Conversational policy editing (card U04). The owner's words about policy are kept as said, next to the interpretation the system drew from them and the revision it produced. Nothing here is a
 * second way to change a policy: an edit ends in a call to the same service the API uses (the approval policy of A07, the review policy of A05, approval grants of A02, configuration layers of
 * U10), under the owner's own principal, with the revision the owner was shown as the revision expected, so an edit made meanwhere through the API is detected and nothing is overwritten.
 *
 * What applies at once and what is shown first. An edit that only makes things stricter (a cell asked more, a lock, a reserved tool, the all-command gate on, a revoked grant) applies when the
 * owner's own, unquoted sentence orders it. Everything that loosens, widens or cannot be judged (a cell asked less, a profile that asks less, a grant, an unlock, a project moved to a freer
 * environment, any configuration value) is saved as a proposal with a preview and applies only on a later explicit request. A tool reserved for the owner is never released from chat. A condition
 * the system cannot enforce is listed as not applied; and an edit that loosens something is not applied at all when its condition cannot be kept, because dropping it would make the edit wider
 * than the owner asked.
 */

export type EditStatus = "proposed" | "applying" | "applied" | "noop" | "refused" | "stale" | "discarded";
const OPEN: readonly EditStatus[] = ["proposed", "applying"];
export type Direction = "tighten" | "loosen" | "neutral" | "unknown";

export const POLICY_EDIT_LIMITS = { open: 50, forwarded: 50, lease: 15 * 60_000, grantScan: 5, wording: 4000, lines: 20, line: 400, grantees: 200, scan: 5 } as const;
export const GRANT_LENGTH_OPTIONS: readonly number[] = [1, 7, 30, 90];
/** The length of a standing grant when nothing says otherwise (the fallback of A07b; the derived default of A07d will be added on top of it). */
export const DEFAULT_GRANT_DAYS = 30;
export const MAX_GRANT_DAYS = 365;
const DAY_MS = 86_400_000;

/** The typed operation an edit ends in. Everything an operation needs is fixed when it is proposed, apart from the time. */
export type EditOp =
  | { readonly kind: "policy"; readonly scope: string; readonly expectedRevision?: number; readonly profile?: string; readonly allCommandGate?: boolean; readonly environment?: string; readonly overrides?: Readonly<Record<string, string | null>>; readonly lock?: readonly string[]; readonly unlock?: readonly string[] }
  | { readonly kind: "reserve"; readonly projectId: string; readonly expectedRevision?: number; readonly policy: ReviewPolicyBody }
  | { readonly kind: "grant"; readonly grantee: string; readonly action: string; readonly projectId: string; readonly environments: readonly string[]; readonly spendLimit?: number; readonly audiences?: readonly string[]; readonly lengthDays?: number; readonly until?: string; readonly options: readonly number[]; readonly lengthWhy: string }
  | { readonly kind: "revoke"; readonly grants: readonly { readonly id: string; readonly revision: number }[] }
  | { readonly kind: "setting"; readonly layer: string; readonly scopeId?: string; readonly expectedRevision?: number; readonly key: string; readonly value?: unknown; readonly remove?: true };

export interface AppliedRef { readonly kind: string; readonly id: string; readonly revision: number }

export interface PolicyEditBody {
  readonly ownerId: string;
  /** The authenticated origin of the words (never the forwarder). */
  readonly origin: { readonly principal: string; readonly via: "chat" | "conversation"; readonly turnId?: string; readonly threadId?: string; readonly messageId?: string };
  /** The agent that passed the owner's message on, recorded apart from the origin; it has no authority of its own here. */
  readonly forwardedBy?: string;
  /** The turn that drew the edit up: an edit is not applied by the message that proposed it (unless it applies at once). */
  readonly turnId: string;
  /** The original wording: the owner's own text of the message, without quoted material. */
  readonly wording: string;
  readonly evidence: string;
  /** The change as the interpreter stated it. */
  readonly change: JsonObject;
  /** What it was understood as, in plain lines (built from the typed operation, never from model text). */
  readonly summary: readonly string[];
  /** What it means in practice and what stays as it is. */
  readonly explanation: readonly string[];
  readonly unapplied: readonly { readonly text: string; readonly why: string }[];
  readonly op?: EditOp;
  readonly direction: Direction;
  /** Applies at once when created by the owner's own message. */
  readonly direct: boolean;
  /** Why it is a proposal, or why it was not applied. */
  readonly reason?: string;
  readonly status: EditStatus;
  readonly refusal?: { readonly code: string; readonly message: string };
  readonly createdAt: string;
  /** Fixed when the edit starts to apply, so a retry after a crash does the same thing. */
  readonly decided?: { readonly at: string; readonly expiresAt?: string; readonly lengthDays?: number };
  readonly appliedAt?: string;
  /** The revisions the edit produced. */
  readonly applied?: readonly AppliedRef[];
  readonly takesEffect?: string;
  readonly failure?: { readonly code: string; readonly message: string };
}

interface IndexBody { readonly open: readonly string[] }

/** What `prepare` produced for an edit: everything the stored record needs apart from who and when. */
export type EditDraft = Pick<PolicyEditBody, "change" | "summary" | "explanation" | "unapplied" | "direction" | "direct" | "status" | "evidence"> & { readonly op?: EditOp; readonly reason?: string; readonly refusal?: { code: string; message: string } };
export type PolicyEditPrepared = { readonly ok: true; readonly draft: EditDraft } | { readonly ok: false; readonly kind: "ask"; readonly question: string; readonly options: string[] } | { readonly ok: false; readonly kind: "refuse"; readonly code: string; readonly message: string };

export interface PolicyEditDeps {
  readonly policy: PolicyService;
  readonly reviews: ReviewService;
  readonly grants: GrantService;
  readonly configuration: ConfigurationService;
  /** For edits forwarded by an agent: the conversations the owner's messages are read from. */
  readonly conversations?: ConversationService;
  /** For edits forwarded by an agent: the same interpreter the chat uses. */
  readonly interpreter?: ChatInterpreter;
  readonly catalog?: ActionCatalog;
}

export interface PrepareInput {
  readonly change: PolicyEditChange;
  readonly conditions: readonly string[];
  readonly evidence: string;
  /** The owner's own words (never quoted material). */
  readonly wording: string;
  readonly focusProjectId?: string;
  /** The message carried quoted or forwarded material. */
  readonly quoted: boolean;
  /** The edit comes from a message an agent passed on: never applied at once. */
  readonly forwarded: boolean;
}

export interface EditResult { readonly editId: string; readonly status: EditStatus; readonly replayed: boolean; readonly applied: readonly AppliedRef[]; readonly failure?: { readonly code: string; readonly message: string }; readonly takesEffect?: string }

const MODE_WORDS: Readonly<Record<string, string>> = { allow: "runs without asking", "agent-review": "goes to an agent review", owner: "asks you" };
const TIER_WORDS: Readonly<Record<Tier, string>> = { free: "development and testing", guarded: "staging", live: "customer-live" };
const CLASS_WORDS: Readonly<Record<ActionClass, string>> = {
  "inspect": "Reading", "workspace-edit": "Editing files in a workspace", "mutate": "Changing outside systems", "external-send": "Sending messages out", "publish": "Publishing", "spend": "Spending",
  "install-executable": "Installing programs", "access-change": "Changing access", "commit": "Commits", "push": "Pushes", "merge": "Merges", "deploy": "Deployments",
};
/** What stays the owner's decision whatever a table or a standing grant says (card A07). */
const STAYS_DECISION: Readonly<Partial<Record<ActionClass, string>>> = {
  "access-change": "Changing access always stays your decision.",
  "deploy": "A customer-live deployment stays your decision.",
  "spend": "Spending beyond the estimate stays your decision.",
  "push": "A change to a protected branch stays your decision.",
  "merge": "A change to a protected branch stays your decision.",
  "external-send": "A send to an audience nobody named stays your decision.",
  "publish": "A publication to an audience nobody named stays your decision.",
};
const EFFECT_WORDS: Readonly<Record<string, string>> = { "next-request": "from the next request", "after-current-operation": "after the current operation", "after-restart": "after Suspend and restart" };
/**
 * The verbs with which an owner orders each kind of stricter move. One list per move, so a verb that fits one move cannot order another ("keep" never revokes, "switch" never reserves).
 * A sentence with a negation, or one that muses instead of deciding, is never an order.
 */
const MOVE_ORDER: Readonly<Record<string, RegExp>> = {
  revoke: /\b(revoke|withdraw|take away|remove|end)\b/i,
  lock: /\block\b/i,
  reserve: /\b(reserve|require my|ask me|check with me)\b/i,
  gate: /\b(turn|switch)\b[^.!;]*\bon\b|\benable\b|\brequire\b/i,
  // A cell is ordered by the verb of the mode it is set to: to the owner (ask me), to an agent review (review). Setting a cell looser is never an at-once edit.
  "cell:owner": /\b(ask me|check with me|require|always ask|gate)\b/i,
  "cell:agent-review": /\breview\b/i,
  profile: /\b(switch|set|change|move|put|go back|return)\b/i,
  environment: /\b(set|switch|make|mark|move|change|put)\b/i,
};
const NEGATION = /\b(don'?t|do not|doesn'?t|never|not|no|keep|leave|without|can'?t|cannot|won'?t|stop|quit|no longer|no need|need not|skip)\b/i;
const MUSING = /\b(maybe|perhaps|should we|should i|i wonder|what if|let me think|thinking about|might|could we|would it|if we|not sure)\b/i;
const moveOf = (c: PolicyEditChange): string => (c.type === "gate" ? (c.on ? "gate" : "none") : c.type === "revoke" || c.type === "lock" || c.type === "reserve" || c.type === "profile" || c.type === "environment" ? c.type : c.type === "cell" ? `cell:${c.mode}` : "none");
const ENV_WORDS: Readonly<Record<string, RegExp>> = { development: /\b(dev|development)\b/i, testing: /\b(test|testing)\b/i, staging: /\bstag(e|ing)\b/i, "customer-live": /\b(prod|production|live|customer-live)\b/i };
/** The words by which an owner names an action class. */
const CLASS_SYNONYMS: Readonly<Record<string, RegExp>> = {
  "inspect": /\b(read|reading|inspect)/i, "workspace-edit": /\b(edit|editing|write|writing|files?|workspace)\b/i, "mutate": /\b(mutat|change|changing|update|delete|call)/i, "external-send": /\b(send|sending|e-?mail|mail|message)/i,
  "publish": /\bpublish/i, "spend": /\b(spend|spending|purchase|pay|buy)/i, "install-executable": /\binstall/i, "access-change": /\b(access|permission)/i, "commit": /\bcommit/i, "push": /\bpush/i, "merge": /\bmerge/i, "deploy": /\bdeploy/i,
};
const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** What the sentence that orders a change must name: the class, the tool, the grantee, the profile or the environment the change is about. Each regex must match the same sentence as the evidence. */
export function targetsOf(c: PolicyEditChange): RegExp[] {
  switch (c.type) {
    case "cell": return [CLASS_SYNONYMS[c.class] as RegExp];
    case "lock": case "unlock": return c.cells.map((k) => (k === "gate" ? /\b(gate|command)/i : (CLASS_SYNONYMS[k.slice(0, k.lastIndexOf("."))] as RegExp)));
    case "gate": return [/\b(gate|command)/i];
    case "reserve": case "unreserve": return [new RegExp(esc(c.tool), "i")];
    case "revoke": return [new RegExp(esc(c.grantee), "i"), c.approve.tool !== undefined ? new RegExp(esc(c.approve.tool), "i") : (CLASS_SYNONYMS[c.approve.class as string] as RegExp)];
    case "profile": return [new RegExp(`\\b${c.to}\\b`, "i")];
    case "environment": return [ENV_WORDS[c.environment] as RegExp];
    default: return [];
  }
}
const hash = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const asJson = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const EDIT_ID = /^pedit-[0-9a-f]{32}$/;
const PROJECT_ID = /^proj-[a-z2-7]{20}$/;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const line = (s: string): string => (s.length > POLICY_EDIT_LIMITS.line ? `${s.slice(0, POLICY_EDIT_LIMITS.line - 3)}...` : s);
const freedom = (profile: string): number => (profile === "strict" ? 0 : profile === "derived" ? 1 : 2);
const refuseDraft = (change: PolicyEditChange, evidence: string, code: string, message: string, conditions: readonly string[] = [], wording = ""): PolicyEditPrepared => ({
  ok: true, draft: { change: asJson(change), evidence, summary: [], explanation: [], unapplied: unappliedOf(conditions, wording), direction: "unknown", direct: false, status: "refused", reason: message, refusal: { code, message } },
});
const unappliedOf = (conditions: readonly string[], wording: string): { text: string; why: string }[] => conditions.map((c) => (evidenceInText(c, wording) ? { text: c, why: "this system cannot enforce that condition" } : { text: "a condition that is not in your message", why: "this system cannot enforce it and its wording was not yours" }));

/** The length of a standing grant, from what the owner said, else the fallback. The explanation is in plain words and is kept with the edit and the grant (card A07d adds the pattern of earlier approvals as an input). */
export function chooseGrantLength(input: { lengthDays?: number; until?: string; now: string }): { ok: true; days: number; why: string; until?: string } | { ok: false; message: string } {
  const now = Date.parse(input.now);
  if (input.until !== undefined) {
    const until = input.until.length === 10 ? `${input.until}T23:59:59.000Z` : new Date(input.until).toISOString();
    const days = Math.ceil((Date.parse(until) - now) / DAY_MS);
    if (!(Date.parse(until) > now)) return { ok: false, message: `${input.until} is not in the future` };
    if (days > MAX_GRANT_DAYS) return { ok: false, message: `a standing grant lasts at most ${MAX_GRANT_DAYS} days; ${input.until} is further away` };
    return { ok: true, days, until, why: `you asked for it to last until ${input.until}` };
  }
  if (input.lengthDays !== undefined) {
    if (input.lengthDays > MAX_GRANT_DAYS) return { ok: false, message: `a standing grant lasts at most ${MAX_GRANT_DAYS} days, not ${input.lengthDays}` };
    return { ok: true, days: input.lengthDays, why: `you asked for ${input.lengthDays} day${input.lengthDays === 1 ? "" : "s"}` };
  }
  return { ok: true, days: DEFAULT_GRANT_DAYS, why: `you did not say how long and there is no pattern of earlier approvals to go on, so the default of ${DEFAULT_GRANT_DAYS} days is used` };
}
const lengthOptions = (stated?: number): number[] => [...new Set([...GRANT_LENGTH_OPTIONS, ...(stated === undefined ? [] : [stated])])].sort((a, b) => a - b);

/** Whether a sentence of the owner's own words that holds the evidence orders this move: it has a verb of that move, no negation, no musing, and is not a question. */
export function ownerOrders(evidence: string, wording: string, move: string, targets: readonly RegExp[] = []): boolean {
  const verb = MOVE_ORDER[move];
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  const wanted = norm(evidence);
  if (verb === undefined || wanted.length === 0) return false;
  const sentences = (wording.match(/[^.!?;\n]+[.!?;]*/g) ?? []).filter((x) => !x.trimEnd().endsWith("?"));
  return sentences.some((x) => norm(x).includes(wanted) && verb.test(x) && targets.every((t) => t.test(x)) && !NEGATION.test(x) && !MUSING.test(x));
}

/** Whether the owner's own words state this number of days ("90", "a week", "a month"). */
export function lengthInWords(days: number, text: string): boolean {
  // Record IDs and anything shaped like one are not the owner's numbers.
  const t = text.toLowerCase().replace(/\b[a-z]+-[a-z0-9-]*\d[a-z0-9-]*/g, " ").replace(/\b(pedit|prop|turn|thr|agt|proj|task|grt)-\S+/g, " ");
  if (new RegExp(`(^|[^0-9])${days}[ -]?days?\\b`).test(t)) return true;
  if (days % 7 === 0 && new RegExp(`(^|[^0-9])${days / 7}[ -]?weeks?\\b`).test(t)) return true;
  if (days % 30 === 0 && new RegExp(`(^|[^0-9])${days / 30}[ -]?months?\\b`).test(t)) return true;
  return (days === 1 && /\b(a|one) day\b|\btomorrow\b/.test(t)) || (days === 7 && /\b(a|one) week\b/.test(t)) || (days === 30 && /\b(a|one) month\b/.test(t)) || (days === 90 && /\b(three months|quarter)\b/.test(t)) || (days === 365 && /\b(a|one) year\b|\b1 ?y(ea)?r\b/.test(t));
}

export class PolicyEditService {
  readonly #runner: CommandRunner;
  readonly #deps: PolicyEditDeps;
  readonly #catalog: ActionCatalog;

  private constructor(runner: CommandRunner, deps: PolicyEditDeps) {
    this.#runner = runner; this.#deps = deps; this.#catalog = deps.catalog ?? ActionCatalog.default;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: PolicyEditDeps, options: RunnerOptions = {}): PolicyEditService {
    return new PolicyEditService(new CommandRunner(storage, epoch, options), deps);
  }

  /** The ID an edit made by a command gets, for the plan to name before the edit exists. */
  idFor(ownerId: string, commandId: string): string { return `pedit-${hash(scopedCommandId(ownerId, commandId))}`; }

  // ---- understanding ------------------------------------------------------------------------------------------------------------

  /**
   * Works out what one policy instruction would do, from the records as they are now: resolves the project and agent, reads the revision it will expect, previews the effect in plain words and
   * decides whether it may apply at once. Changes nothing. A question comes back when a name cannot be resolved; everything else is a draft (possibly a refused one, kept so that the wording is not lost).
   */
  async prepare(owner: Principal, input: PrepareInput): Promise<PolicyEditPrepared> {
    this.#requireOwner(owner);
    const { change, evidence, wording } = input;
    const conditions = input.conditions.slice(0, 5);
    // Every free text of the change must be the owner's own words (or a record, or a fixed choice): a model cannot add what the owner never said.
    const foreign = foreignValue({ tool: "tool" in change ? change.tool : undefined, approveTool: "approve" in change ? change.approve.tool : undefined, projectName: "projectName" in change ? change.projectName : undefined, grantee: "grantee" in change ? change.grantee : undefined, audiences: "audiences" in change ? change.audiences : undefined, value: "value" in change ? change.value : undefined }, wording);
    if (foreign !== undefined) return { ok: false, kind: "refuse", code: "unsupported_value", message: `${foreign} is not in your message, so it was not done. Say what it should be.` };
    if (change.type === "grant") {
      const bad = (change.environments ?? []).find((e) => !(ENV_WORDS[e] as RegExp).test(wording));
      if (bad !== undefined) return { ok: false, kind: "refuse", code: "unsupported_value", message: `${bad} is not in your message, so it was not done. Say which environments.` };
      if (change.spendLimit !== undefined && !new RegExp(`(^|[^0-9.])${String(change.spendLimit).replace(".", "\\.")}([^0-9]|$)`).test(wording)) return { ok: false, kind: "refuse", code: "unsupported_value", message: `${change.spendLimit} is not in your message, so it was not done. Say the limit.` };
    }
    let built: Built | { ask: PolicyEditPrepared & { ok: false } };
    try { built = await this.#build(owner, change, input); } catch (error) {
      if (error instanceof Refusal) return refuseDraft(change, evidence, error.code, error.message, conditions, wording);
      throw error;
    }
    if ("ask" in built) return built.ask;
    const unapplied = unappliedOf(conditions, wording);
    const { direction } = built;
    const explanation = [...built.explanation];
    if (built.noop) return { ok: true, draft: { change: asJson(change), evidence, summary: built.summary, explanation: [...explanation, ...unapplied.map((u) => `Not applied: "${u.text}" (${u.why}).`)], unapplied, direction, direct: false, status: "noop", reason: "it is already so" } };
    if (unapplied.length > 0 && direction !== "tighten" && direction !== "neutral") {
      return { ok: true, draft: { change: asJson(change), evidence, summary: built.summary, explanation, unapplied, direction, direct: false, status: "refused", reason: `Not applied: ${unapplied.map((u) => `"${u.text}"`).join("; ")} cannot be enforced here, and without it this would be wider than you asked. Nothing was changed.`, refusal: { code: "unsupported_condition", message: `${unapplied.map((u) => `"${u.text}"`).join("; ")} cannot be enforced here, and without it this would be wider than you asked. Nothing was changed.` } } };
    }
    for (const u of unapplied) explanation.push(`Not applied: "${u.text}" (${u.why}); the rest is as you said.`);
    let reason: string | undefined;
    if (direction === "loosen") reason = "it asks less or gives more, so you see it first";
    else if (direction === "unknown") reason = "a setting is shown first";
    else if (input.forwarded) reason = "it came from a message an agent passed on, so only you can apply it";
    else if (input.quoted) reason = "your message carried quoted text, so this is shown first";
    else if (!ownerOrders(evidence, wording, moveOf(change), targetsOf(change))) reason = "your own words do not order this, so it is shown first";
    const direct = reason === undefined;
    return { ok: true, draft: { change: asJson(change), evidence, summary: built.summary, explanation, unapplied, direction, direct, status: "proposed", ...(built.op === undefined ? {} : { op: built.op }), ...(reason === undefined ? {} : { reason }) } };
  }

  // ---- records ------------------------------------------------------------------------------------------------------------------

  /** Records an edit drawn up from the owner's message. Repeating the command returns the same edit. */
  async create(owner: Principal, input: { commandId: string; turnId: string; wording: string; draft: EditDraft }): Promise<{ id: string; status: EditStatus; replayed: boolean }> {
    this.#requireOwner(owner);
    const id = this.idFor(owner.id, input.commandId);
    const body = this.#bodyOf(owner.id, { principal: owner.id, via: "chat", turnId: input.turnId }, undefined, input.turnId, input.wording, input.draft);
    return this.#store(owner.id, owner.id, scopedCommandId(owner.id, input.commandId), id, body);
  }

  async get(owner: Principal, editId: string): Promise<(PolicyEditBody & { id: string; revision: number }) | undefined> {
    this.#requireOwner(owner);
    const found = EDIT_ID.test(editId) ? await this.#runner.get("policy-edit", editId) : undefined;
    const body = found?.body as unknown as PolicyEditBody | undefined;
    return found === undefined || body === undefined || body.ownerId !== owner.id ? undefined : view<PolicyEditBody>(found);
  }

  /** The owner's open edits (proposed or being applied; those an agent passed on have an index and a limit of their own), from an index, so no scan can run short. */
  async open(owner: Principal): Promise<{ id: string; summary: string[]; status: EditStatus; forwardedBy?: string }[]> {
    this.#requireOwner(owner);
    const out: { id: string; summary: string[]; status: EditStatus; forwardedBy?: string }[] = [];
    for (const index of [owner.id, `fwd:${owner.id}`]) {
      for (const id of (await this.#index(index)).body.open) {
        const b = (await this.#runner.get("policy-edit", id))?.body as unknown as PolicyEditBody | undefined;
        if (b !== undefined && OPEN.includes(b.status)) out.push({ id, summary: b.forwardedBy === undefined ? [...b.summary] : [`(passed on by ${b.forwardedBy}) ${b.summary[0] ?? ""}`, ...b.summary.slice(1)], status: b.status, ...(b.forwardedBy === undefined ? {} : { forwardedBy: b.forwardedBy }) });
      }
    }
    return out;
  }

  async discard(owner: Principal, request: { commandId: string; editId: string; fromTurn?: string }): Promise<{ editId: string; replayed: boolean }> {
    this.#requireOwner(owner);
    onlyKnown(request, ["commandId", "editId", "fromTurn"]);
    const found = await this.get(owner, request.editId);
    if (found === undefined) throw new DomainError("not_found", "no such policy edit");
    if (request.fromTurn !== undefined && found.turnId === request.fromTurn) invalid("editId", "an edit is not discarded in the message that drew it up");
    if (found.status === "discarded") return { editId: found.id, replayed: true };
    if (found.status === "applying") {
      // An apply that was started and not finished blocks the edit; after a lease the owner may discard it. What it had already done stays done and is listed.
      const started = found.decided?.at;
      if (started === undefined || Date.parse(this.#runner.now()) - Date.parse(started) < POLICY_EDIT_LIMITS.lease) invalid("editId", `that edit is being applied; it can be discarded ${POLICY_EDIT_LIMITS.lease / 60_000} minutes after it started`);
    } else if (found.status !== "proposed") invalid("editId", `that edit is ${found.status}`);
    const done = await this.#move(owner.id, found.id, `${found.id}-discard`, ["proposed", "applying"], (b) => ({
      ...b, status: "discarded",
      ...(b.status === "applying" ? { failure: { code: "abandoned", message: `Discarded while being applied. Revisions recorded so far: ${(b.applied ?? []).map((r) => `${r.kind} ${r.id} at revision ${r.revision}`).join("; ") || "none"}. A step that was in flight may not be listed; check the policy.` } } : {}),
    }));
    if (done.body.status !== "discarded") invalid("editId", `that edit is ${done.body.status}`);
    return { editId: found.id, replayed: !done.changed };
  }

  // ---- applying -----------------------------------------------------------------------------------------------------------------

  /**
   * The explicit request that applies an edit (or the message that drew up an edit that applies at once). The owner only. The time and the length of a grant are fixed first and stored, so a retry
   * after a crash does exactly the same; each service call has a command ID of its own, so nothing is done twice; a revision that moved since the owner was shown the edit is refused as stale.
   */
  async apply(owner: Principal, request: { commandId: string; editId: string; lengthDays?: number; fromTurn?: string }): Promise<EditResult> {
    this.#requireOwner(owner);
    onlyKnown(request, ["commandId", "editId", "lengthDays", "fromTurn"]);
    let found = await this.get(owner, request.editId);
    if (found === undefined) throw new DomainError("not_found", "no such policy edit");
    const id = found.id;
    if (found.status === "applied") return { editId: id, status: "applied", replayed: true, applied: found.applied ?? [], ...(found.takesEffect === undefined ? {} : { takesEffect: found.takesEffect }) };
    if (found.status === "discarded" || found.status === "refused" || found.status === "stale" || found.status === "noop") {
      throw new DomainError("invalid_command", `that edit is ${found.status}${found.failure === undefined && found.reason === undefined ? "" : `: ${found.failure?.message ?? found.reason}`}`, { field: "editId" });
    }
    if (request.fromTurn !== undefined && found.turnId === request.fromTurn && !(found.direct && found.status === "proposed")) invalid("editId", "an edit is applied by a later, explicit request, not in the message that drew it up");
    const op = found.op;
    if (op === undefined) invalid("editId", "that edit has nothing to apply");
    if (request.lengthDays !== undefined && !(op?.kind === "grant" && op.options.includes(request.lengthDays))) {
      invalid("lengthDays", op?.kind === "grant" ? `choose one of ${op.options.join(", ")} days` : "only a standing grant has a length");
    }
    // Phase 1: fix the time and the length. A second request, or a retry, finds them already stored.
    const at = this.#runner.now();
    const chosen = op?.kind === "grant" ? this.#length(op, at, request.lengthDays) : undefined;
    if (chosen !== undefined && "message" in chosen) throw new DomainError("invalid_command", chosen.message, { field: "lengthDays" });
    const begun = await this.#move(owner.id, id, `${id}-begin`, ["proposed", "applying"], (b) => (b.status === "applying" ? b : { ...b, status: "applying", decided: { at, ...(chosen === undefined || "message" in chosen ? {} : { expiresAt: chosen.expiresAt, lengthDays: chosen.days }) } }));
    if (begun.body.status !== "applying") {
      if (begun.body.status === "applied") return { editId: id, status: "applied", replayed: true, applied: begun.body.applied ?? [] };
      invalid("editId", `that edit is ${begun.body.status}`);
    }
    const body = begun.body;
    // Phase 2: the service calls, each idempotent.
    let applied: AppliedRef[];
    let takesEffect: string | undefined;
    try {
      let noted = 0;
      const note = async (ref: AppliedRef): Promise<void> => { await this.#move(owner.id, id, `${id}-p${noted++}`, ["applying"], (b) => ({ ...b, applied: [...(b.applied ?? []), ref] })); };
      const result = await this.#run(owner, id, body, op as EditOp, note);
      applied = result.applied; takesEffect = result.takesEffect;
    } catch (error) {
      if (!(error instanceof DomainError) || error.code === "unavailable" || error.code === "stale_epoch" || error.code === "fenced" || error.code === "effect_uncertain") throw error;
      const stale = error.code === "stale_revision" || error.code === "command_conflict";
      const failure = { code: stale ? "stale_revision" : error.code, message: stale ? "The policy changed since you were shown this edit, so nothing was applied. Say it again to see it against the policy as it is now." : error.message };
      const ended = await this.#move(owner.id, id, `${id}-end`, ["applying"], (b) => ({ ...b, status: stale ? "stale" : "refused", failure, refusal: failure }));
      if (ended.body.status === "applied") return { editId: id, status: "applied", replayed: true, applied: ended.body.applied ?? [] };
      return { editId: id, status: ended.body.status, replayed: false, applied: [], failure };
    }
    // Phase 3: record the revisions it produced.
    const ended = await this.#move(owner.id, id, `${id}-end`, ["applying"], (b) => ({ ...b, status: "applied", appliedAt: this.#runner.now(), applied, ...(takesEffect === undefined ? {} : { takesEffect }) }));
    return { editId: id, status: "applied", replayed: !ended.changed && ended.body.status === "applied" && begun.changed === false, applied: ended.body.applied ?? applied, ...(ended.body.takesEffect === undefined ? {} : { takesEffect: ended.body.takesEffect }) };
  }

  // ---- forwarded messages -------------------------------------------------------------------------------------------------------

  /**
   * An agent passes on a message of the owner's that holds a policy instruction. The message is read from the conversation record, so its origin is the sender the controller authenticated when
   * it was sent and not anything the agent says; a message from anyone but the owner is not an owner instruction and is refused. Each instruction becomes a proposed edit, recorded with the origin
   * and the forwarding agent apart. The agent gets only the edit IDs and states: it cannot apply, and cannot read what the edit would do.
   */
  async forward(by: Principal, request: { commandId: string; threadId: string; seq: number }): Promise<{ edits: { editId: string; status: EditStatus }[] }> {
    if (by.kind !== "agent") throw new DomainError("forbidden", "only an agent passes on an owner's message");
    onlyKnown(request, ["commandId", "threadId", "seq"]);
    const conversations = this.#deps.conversations; const interpreter = this.#deps.interpreter;
    if (conversations === undefined || interpreter === undefined) throw new DomainError("unavailable", "forwarding is not set up");
    if (!Number.isSafeInteger(request.seq) || request.seq < 1) invalid("seq", "must be a whole number, 1 or more");
    const page = await conversations.read(by, { threadId: request.threadId, afterSeq: request.seq - 1, limit: 1 });
    const message = page?.items[0];
    if (message === undefined || message.seq !== request.seq) throw new DomainError("not_found", "no such message");
    // The origin is the stored, authenticated sender. A claimed sender, a role in the text, or an agent's say-so counts for nothing.
    if (message.senderKind !== "owner" || !message.sender.startsWith("owner:")) throw new DomainError("forbidden", "that message is not from the owner, so it is not an instruction");
    if (message.redacted) throw new DomainError("invalid_command", "that message was altered because it looked like a credential, so it cannot be read as an instruction");
    refuseCredentials(message.text, "text");
    const ownerPrincipal: Principal = { id: message.sender, kind: "owner", name: message.sender.slice(6), grants: [] };
    const thread = await conversations.thread(by, request.threadId);
    const split = splitQuoted(message.text);
    if (split.text.length === 0) invalid("text", "the message has no words of the owner's own outside quoted material");
    let intents;
    try { intents = checkIntents(await interpreter.interpret({ text: split.text, quoted: split.quoted, focus: thread === undefined ? {} : { projectId: thread.projectId }, proposals: [], now: this.#runner.now() })); } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("unavailable", "the assistant that reads free-form messages is unavailable");
    }
    const edits: { editId: string; status: EditStatus }[] = [];
    let k = 0;
    for (const intent of intents) {
      if (intent.kind !== "policy_edit") continue;
      const n = k++;
      const editId = `pedit-${hash("forward", message.id, String(n))}`;
      const existing = await this.#runner.get("policy-edit", editId);
      if (existing !== undefined) { edits.push({ editId, status: (existing.body as unknown as PolicyEditBody).status }); continue; }
      if (intent.basis === "quoted" || !evidenceInText(intent.evidence, split.text) || !evidenceStrong(intent.evidence)) continue;
      const prepared = await this.prepare(ownerPrincipal, { change: intent.change, conditions: intent.conditions ?? [], evidence: intent.evidence, wording: split.text, ...(thread === undefined ? {} : { focusProjectId: thread.projectId }), quoted: split.quoted.length > 0, forwarded: true });
      if (!prepared.ok) continue;
      const body = this.#bodyOf(message.sender, { principal: message.sender, via: "conversation", threadId: request.threadId, messageId: message.id }, by.id, `forward-${message.id}`, split.text, prepared.draft);
      const stored = await this.#store(message.sender, by.id, scopedCommandId(by.id, `${request.commandId}-${n}`), editId, body);
      edits.push({ editId, status: stored.status });
    }
    return { edits };
  }

  // ---- building -----------------------------------------------------------------------------------------------------------------

  async #build(owner: Principal, change: PolicyEditChange, input: PrepareInput): Promise<Built | { ask: PolicyEditPrepared & { ok: false } }> {
    switch (change.type) {
      case "profile": return this.#profile(owner, change.to);
      case "cell": {
        const scope = await this.#scopeOf(change.scope, change, input.focusProjectId);
        if ("ask" in scope) return scope;
        return this.#cell(owner, change, scope);
      }
      case "gate": {
        const scope = await this.#scopeOf(change.scope, change, input.focusProjectId);
        if ("ask" in scope) return scope;
        return this.#gate(owner, change.on, scope);
      }
      case "environment": {
        const project = await this.#project(change, input.focusProjectId);
        if ("ask" in project) return project;
        return this.#environment(owner, change.environment, project);
      }
      case "lock": case "unlock": return this.#locks(owner, change.type === "lock", change.cells);
      case "reserve": case "unreserve": {
        const project = await this.#project(change, input.focusProjectId);
        if ("ask" in project) return project;
        return this.#reserve(owner, change.type === "reserve", change.tool, project);
      }
      case "grant": {
        const project = await this.#project(change, input.focusProjectId);
        if ("ask" in project) return project;
        const grantee = await this.#agent(change.grantee);
        if ("ask" in grantee) return grantee;
        return this.#grant(owner, change, project, grantee);
      }
      case "revoke": {
        const project = await this.#project(change, input.focusProjectId);
        if ("ask" in project) return project;
        const grantee = await this.#agent(change.grantee);
        if ("ask" in grantee) return grantee;
        return this.#revoke(change.approve, project, grantee);
      }
      case "setting": return this.#setting(owner, change);
    }
  }

  async #profile(owner: Principal, to: string): Promise<Built> {
    const now = (await this.#deps.policy.effective(owner))!;
    const summary = [`Switch the installation to the ${to} profile.`];
    if (now.profile === to) return { summary, explanation: [`The installation is in the ${to} profile already.`], direction: "neutral", noop: true };
    const preview = await this.#deps.policy.preview(owner, { scope: "installation", profile: to as never });
    const explanation = [...cellLines(preview.changes), "Cells you set yourself, your locks and the tools reserved for you stay as they are; a decision that always stays yours still does.", ...preview.notes.filter((n) => !/^the profile goes/.test(n))];
    // The profile carries authority beyond the cells (a scope's ceiling, what an instruction authorizes): a move to a freer one is a loosening whatever the cell preview shows.
    const direction: Direction = freedom(to) > freedom(now.profile) || preview.loosened.length > 0 ? "loosen" : "tighten";
    if (freedom(to) > freedom(now.profile) && preview.changes.length === 0) explanation.push(`No cell changes, but the ${to} profile gives more room to an instruction's own scope.`);
    return { summary, explanation, direction, op: { kind: "policy", scope: "installation", ...revisionField(now.revisions.installation), profile: to } };
  }

  async #cell(owner: Principal, change: Extract<PolicyEditChange, { type: "cell" }>, scope: ScopeRef): Promise<Built> {
    const tier = tierOf(change.environment);
    const key = `${change.class}.${tier}`;
    const where = scope.id === "installation" ? "every project" : `project "${scope.name}"`;
    const wanted = change.mode === "default" ? null : change.mode;
    const summary = [wanted === null ? `${cap(CLASS_WORDS[change.class])} in ${TIER_WORDS[tier]} environments go back to what the profile says, for ${where}.` : `${cap(CLASS_WORDS[change.class])} in ${TIER_WORDS[tier]} environments: ${MODE_WORDS[wanted]}, for ${where}.`];
    const effective = (await this.#deps.policy.effective(owner, scope.id === "installation" ? undefined : scope.id))!;
    const preview = await this.#deps.policy.preview(owner, { scope: scope.id, overrides: { [key]: wanted } });
    const result = preview.changes.find((c) => c.cell === key)?.to ?? effective.cells[key]!.mode;
    if (wanted !== null && result !== wanted) throw new Refusal("locked", `${key} is locked by the installation at "${result}", so a project cannot make it ${wanted === "allow" ? "looser" : "different"}. Unlock it first if you want that.`);
    const reserved = scope.id === "installation" ? [] : (await this.#deps.reviews.getPolicy(owner, scope.id))?.policy.mandatoryHuman ?? [];
    const explanation = [...cellLines(preview.changes)];
    if (preview.changes.length === 0) {
      explanation.push(wanted === null ? "Nothing about how actions are decided would change." : `It is already so for ${where}.`);
      return { summary, explanation, direction: "neutral", noop: true };
    }
    const loosened = preview.loosened.length > 0;
    if (loosened && STAYS_DECISION[change.class] !== undefined) explanation.push(STAYS_DECISION[change.class] as string);
    if (loosened && reserved.length > 0) explanation.push(`Tools reserved for you in this project still ask you whatever this says: ${reserved.join(", ")}.`);
    explanation.push("Every other class, environment and project is unchanged.");
    const current = effective.revisions;
    const expected = scope.id === "installation" ? current.installation : (current.project ?? 0);
    return { summary, explanation, direction: loosened ? "loosen" : preview.tightened.length > 0 ? "tighten" : "neutral", op: { kind: "policy", scope: scope.id, ...revisionField(expected), overrides: { [key]: wanted } } };
  }

  async #gate(owner: Principal, on: boolean, scope: ScopeRef): Promise<Built> {
    const where = scope.id === "installation" ? "the installation" : `project "${scope.name}"`;
    const summary = [`Turn the all-command gate ${on ? "on" : "off"} for ${where}: every program run ${on ? "asks you first" : "no longer asks you first because of this switch"}.`];
    const inst = await this.#deps.policy.get(owner, "installation");
    const proj = scope.id === "installation" ? undefined : await this.#deps.policy.get(owner, scope.id);
    const before = (inst?.allCommandGate ?? false) || (proj?.allCommandGate ?? false);
    const after = ((scope.id === "installation" ? on : inst?.allCommandGate) ?? false) || ((scope.id === "installation" ? proj?.allCommandGate : on) ?? false);
    if (before === after) return { summary, explanation: [after ? "Every program run asks you already." : on ? "" : "The gate stays on because another level also has it on."].filter((s) => s !== ""), direction: "neutral", noop: true };
    const expected = scope.id === "installation" ? inst?.revision : proj?.revision;
    return { summary, explanation: [after ? "From the next evaluation every program run, and every install that runs one, asks you." : "From the next evaluation program runs follow the cells of the policy again."], direction: after ? "tighten" : "loosen", op: { kind: "policy", scope: scope.id, ...(expected === undefined ? {} : { expectedRevision: expected }), allCommandGate: on } };
  }

  async #environment(owner: Principal, environment: Environment, project: ScopeRef): Promise<Built> {
    const rec = await this.#deps.policy.get(owner, project.id);
    const current = rec?.environment ?? "development";
    const summary = [`Mark project "${project.name}" as ${environment}.`];
    if (current === environment) return { summary, explanation: [`It is ${environment} already.`], direction: "neutral", noop: true };
    // Judged by what would actually be decided: each class's effective mode (overrides and locks included) in the old tier and the new one, and the approval grants that name the new environment and not the old.
    const eff = (await this.#deps.policy.effective(owner, project.id))!;
    const oldTier = tierOf(current); const newTier = tierOf(environment);
    const explanation: string[] = [`Its work would be judged as ${TIER_WORDS[newTier]} work from the next evaluation (it was ${current}).`];
    let loosened = false; let tightened = false;
    if (oldTier !== newTier) {
      for (const cls of ACTION_CLASSES) {
        const was = eff.cells[`${cls}.${oldTier}`]!.mode; const will = eff.cells[`${cls}.${newTier}`]!.mode;
        if (was === will) continue;
        explanation.push(`${cap(CLASS_WORDS[cls])}: ${MODE_WORDS[was]} -> ${MODE_WORDS[will]}.`);
        if (tightness(will) < tightness(was)) loosened = true; else tightened = true;
      }
    }
    const opened = await this.#grantsOpened(project.id, current, environment);
    for (const g of opened.ids) explanation.push(`Approval grant ${g} names ${environment} and not ${current}, so it starts to apply.`);
    if (opened.truncated) explanation.push("Not every grant could be checked, so this is treated as giving more.");
    if (opened.ids.length > 0 || opened.truncated) loosened = true;
    explanation.push("The table of the profile, your cells and your reserved tools do not change.");
    return { summary, explanation, direction: loosened ? "loosen" : tightened ? "tighten" : "neutral", op: { kind: "policy", scope: project.id, ...(rec === undefined ? {} : { expectedRevision: rec.revision }), environment } };
  }

  /** The active approval grants of the project (any holder) that name `to` among their environments and not `from`. Bounded scan; a scan that cannot finish says so. */
  async #grantsOpened(projectId: string, from: string, to: string): Promise<{ ids: string[]; truncated: boolean }> {
    const ids: string[] = [];
    const now = this.#runner.now();
    let after: string | undefined;
    for (let page = 0; page < POLICY_EDIT_LIMITS.grantScan; page++) {
      const chunk = await this.#runner.list("grant-record", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of chunk) {
        after = a.id;
        const g = a.body as unknown as GrantRecordBody;
        if (g.state === "active" && g.action.startsWith("approve.") && (g.project === projectId || g.project === "*") && (g.expiresAt === undefined || g.expiresAt > now) && (g.terms?.environments ?? []).includes(to) && !(g.terms?.environments ?? []).includes(from)) ids.push(a.id);
      }
      if (chunk.length < 200) return { ids, truncated: false };
    }
    return { ids, truncated: true };
  }

  async #locks(owner: Principal, lock: boolean, cells: readonly string[]): Promise<Built> {
    const inst = await this.#deps.policy.get(owner, "installation");
    const locked = inst?.locked ?? [];
    const todo = cells.filter((c) => (lock ? !locked.includes(c) : locked.includes(c)));
    const summary = [`${lock ? "Lock" : "Unlock"} ${cells.join(", ")}${lock ? ": no project can make them looser" : ": projects may make them looser again"}.`];
    if (todo.length === 0) return { summary, explanation: [lock ? "They are locked already." : "They are not locked."], direction: "neutral", noop: true };
    return { summary, explanation: [lock ? "A project policy can only make these cells stricter from the next evaluation." : "A project policy may set these cells looser again; what projects set before the lock comes back into effect."], direction: lock ? "tighten" : "loosen", op: { kind: "policy", scope: "installation", ...(inst === undefined ? {} : { expectedRevision: inst.revision }), [lock ? "lock" : "unlock"]: todo } };
  }

  async #reserve(owner: Principal, reserve: boolean, tool: string, project: ScopeRef): Promise<Built> {
    const summary = [`${reserve ? "Reserve" : "Release"} ${tool} in project "${project.name}" ${reserve ? "for you" : "from you"}.`];
    if (!reserve) throw new Refusal("mandatory_gate", `${tool} is reserved for you in "${project.name}" and a chat message does not release it: a human gate is only lowered by you directly, in the review policy of the project (settings or API). Nothing was changed.`);
    const found = await this.#deps.reviews.getPolicy(owner, project.id);
    if (found === undefined) throw new Refusal("unavailable", "the review policy cannot be read");
    if (found.policy.mandatoryHuman.includes(tool)) return { summary, explanation: [`${tool} is reserved for you already.`], direction: "neutral", noop: true };
    const policy: ReviewPolicyBody = { ...found.policy, mandatoryHuman: [...found.policy.mandatoryHuman, tool] };
    return { summary, explanation: [`${tool} will always ask you, whatever the profile, a grant or an agent's review says; it is never routed to an agent and an earlier agent approval never clears it. The other rules of the project's review policy are unchanged.`], direction: "tighten", op: { kind: "reserve", projectId: project.id, ...revisionField(found.revision), policy } };
  }

  async #grant(owner: Principal, change: Extract<PolicyEditChange, { type: "grant" }>, project: ScopeRef, grantee: AgentRef): Promise<Built> {
    const tool = change.approve.tool;
    const cls: ActionClass | "unknown" = change.approve.class ?? this.#catalog.classify(tool as string);
    const what = tool !== undefined ? `use ${tool}` : `do ${change.approve.class} actions`;
    const summary = [`Let ${grantee.name} ${what} in project "${project.name}" without asking you.`];
    if (cls === "unknown") throw new Refusal("unsupported", `${tool} is not a classified action, so it goes to review and no approval can waive that.`);
    if (cls === "access-change") throw new Refusal("stays_decision", "Changing access always stays your decision, and a standing grant cannot waive it.");
    const reserved = (await this.#deps.reviews.getPolicy(owner, project.id))?.policy.mandatoryHuman ?? [];
    if (tool !== undefined && reserved.includes(tool)) throw new Refusal("mandatory_gate", `${tool} is reserved for you in "${project.name}"; no grant can waive that, so none was made.`);
    if ((cls === "external-send" || cls === "publish") && (change.audiences ?? []).length === 0) throw new Refusal("needs_audience", `Sending out and publishing are granted per account and audience. Say who ${grantee.name} may ${cls === "publish" ? "publish for" : "send to"}.`);
    if (cls === "spend" && change.spendLimit === undefined) throw new Refusal("needs_limit", "A spending grant has to state its limit. Say how much.");
    const chosen = chooseGrantLength({ ...(change.lengthDays === undefined ? {} : { lengthDays: change.lengthDays }), ...(change.until === undefined ? {} : { until: change.until }), now: this.#runner.now() });
    if (!chosen.ok) throw new Refusal("invalid_length", chosen.message);
    const environments = change.environments ?? ["development", "testing"];
    const options = lengthOptions(change.lengthDays ?? (change.until === undefined ? undefined : chosen.days));
    const explanation = [
      `It covers ${environments.join(" and ")} only${change.environments === undefined ? " (you did not name an environment, so only the free ones)" : ""}.`,
      `Length: ${chosen.days} day${chosen.days === 1 ? "" : "s"} (${chosen.why}). You can pick another when you apply it: ${options.map((d) => `${d} day${d === 1 ? "" : "s"}`).join(", ")}.`,
      "It expires by itself and you can revoke it at any time. A standing grant never covers what stays your decision: changing access, a customer-live deployment, a protected branch, spending beyond the estimate, an irreversible action, or an audience nobody named.",
      ...(change.audiences === undefined ? [] : [`Audiences: ${change.audiences.join(", ")}.`]), ...(change.spendLimit === undefined ? [] : [`Spend limit: ${change.spendLimit}.`]),
    ];
    return {
      summary, explanation, direction: "loosen",
      op: { kind: "grant", grantee: grantee.principalId, action: `approve.${tool !== undefined ? `tool.${tool}` : `class.${change.approve.class as string}`}`, projectId: project.id, environments, ...(change.spendLimit === undefined ? {} : { spendLimit: change.spendLimit }), ...(change.audiences === undefined ? {} : { audiences: change.audiences }), ...(change.lengthDays === undefined ? {} : { lengthDays: change.lengthDays }), ...(chosen.until === undefined ? {} : { until: chosen.until }), options, lengthWhy: chosen.why },
    };
  }

  async #revoke(approve: { class?: ActionClass; tool?: string }, project: ScopeRef, grantee: AgentRef): Promise<Built> {
    const action = `approve.${approve.tool !== undefined ? `tool.${approve.tool}` : `class.${approve.class as string}`}`;
    const summary = [`Revoke ${grantee.name}'s approval to ${approve.tool !== undefined ? `use ${approve.tool}` : `do ${approve.class} actions`} in project "${project.name}".`];
    const held = (await this.#deps.grants.held(grantee.principalId, this.#runner.now())).filter(({ body }) => body.action === action && body.project === project.id && body.resource === undefined && body.source !== "derived");
    if (held.length === 0) throw new Refusal("not_found", `${grantee.name} holds no such approval in "${project.name}" right now.`);
    const grants: { id: string; revision: number }[] = [];
    for (const { id } of held.slice(0, 10)) { const g = await this.#deps.grants.getGrant(id); if (g !== undefined) grants.push({ id, revision: g.revision }); }
    return { summary, explanation: [`${grants.length} grant${grants.length === 1 ? "" : "s"} end${grants.length === 1 ? "s" : ""} from the next snapshot, and anything derived from ${grants.length === 1 ? "it" : "them"} ends too. Their other approvals are unchanged.`], direction: "tighten", op: { kind: "revoke", grants } };
  }

  async #setting(owner: Principal, change: Extract<PolicyEditChange, { type: "setting" }>): Promise<Built> {
    if (change.layer === "installation" ? change.scopeId !== undefined : change.scopeId === undefined) throw new Refusal("invalid_command", change.layer === "installation" ? "the installation layer has no scope ID" : `a ${change.layer} setting needs the ID of the ${change.layer}`);
    const definitions: SettingDefinition[] = this.#deps.configuration.settings().map((d) => ({ ...d, check: (v: unknown) => v }));
    const def = definitionFor(change.key, definitions);
    if (def === undefined) throw new Refusal("unsupported", `${change.key} is not a setting this system has. Known settings: ${this.#deps.configuration.settings().map((d) => d.key).join(", ")}.`);
    const layerName = change.layer === "installation" ? "the whole installation" : `${change.layer} ${change.scopeId as string}`;
    const summary = [change.remove === true ? `Remove ${change.key} from ${layerName}.` : `Set ${change.key} to ${JSON.stringify(change.value)} for ${layerName}.`];
    const layer = await this.#deps.configuration.layer(owner, change.layer, change.scopeId);
    const explanation = [`${def.description}`, `It takes effect ${EFFECT_WORDS[def.effect] ?? def.effect}.`, def.kind === "restriction" ? "A narrower layer can only narrow it further, and a value wider than the layers above allow is refused." : "A narrower layer may override it.", "It is applied as a whole after the combination of settings is checked; if the check fails nothing changes."];
    if (change.layer === "installation") {
      const eff = await this.#deps.configuration.effective(owner);
      const now = eff?.values[change.key];
      if (now !== undefined) explanation.unshift(`It is ${JSON.stringify(now.value)} now (from ${now.source.layer}).`);
    }
    return { summary, explanation, direction: "unknown", op: { kind: "setting", layer: change.layer, ...(change.scopeId === undefined ? {} : { scopeId: change.scopeId }), ...(layer === undefined ? {} : { expectedRevision: layer.revision }), key: change.key, ...(change.remove === true ? { remove: true as const } : { value: change.value }) } };
  }

  // ---- resolving names ----------------------------------------------------------------------------------------------------------

  async #scopeOf(scope: "installation" | "project", where: { projectName?: string; projectId?: string }, focus: string | undefined): Promise<ScopeRef | { ask: PolicyEditPrepared & { ok: false } }> {
    if (scope === "installation") return { id: "installation", name: "the installation" };
    return this.#project(where, focus);
  }

  async #project(where: { projectName?: string; projectId?: string }, focus: string | undefined): Promise<ScopeRef | { ask: PolicyEditPrepared & { ok: false } }> {
    const named = async (id: string): Promise<ScopeRef> => {
      const found = PROJECT_ID.test(id) ? await this.#runner.get("project", id) : undefined;
      if (found === undefined) throw new Refusal("not_found", "no such project");
      return { id, name: (found.body as unknown as { name: string }).name };
    };
    if (where.projectId !== undefined) return named(where.projectId);
    if (where.projectName !== undefined) {
      const wanted = where.projectName.trim().toLowerCase();
      const matches: ScopeRef[] = [];
      let after: string | undefined;
      for (let page = 0; page < POLICY_EDIT_LIMITS.scan; page++) {
        const chunk = await this.#runner.list("project", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
        for (const a of chunk) { after = a.id; const n = (a.body as unknown as { name: string }).name; if (n.trim().toLowerCase() === wanted) matches.push({ id: a.id, name: n }); }
        if (chunk.length < 200) break;
      }
      if (matches.length === 0) throw new Refusal("not_found", `no project called "${where.projectName.slice(0, 80)}"`);
      if (matches.length > 1) return { ask: { ok: false, kind: "ask", question: `More than one project is called "${where.projectName.slice(0, 80)}". Which one?`, options: matches.slice(0, 10).map((m) => m.id) } };
      return matches[0] as ScopeRef;
    }
    if (focus !== undefined) return named(focus);
    return { ask: { ok: false, kind: "ask", question: "Which project do you mean? There is none in focus. Name it, or say it applies to every project.", options: [] } };
  }

  async #agent(who: string): Promise<AgentRef | { ask: PolicyEditPrepared & { ok: false } }> {
    const text = who.trim();
    const byPrincipal = async (principalId: string): Promise<AgentRef | undefined> => {
      const p = await this.#runner.get("principal", principalId);
      const body = p?.body as unknown as { kind: string; name: string; state: string } | undefined;
      return p === undefined || body === undefined || body.kind !== "agent" || body.state !== "active" ? undefined : { principalId, name: body.name };
    };
    if (/^agent:/.test(text)) { const found = await byPrincipal(text); if (found === undefined) throw new Refusal("not_found", `no active agent ${text.slice(0, 80)}`); return found; }
    const matches: AgentRef[] = [];
    let after: string | undefined;
    for (let page = 0; page < POLICY_EDIT_LIMITS.scan; page++) {
      const chunk = await this.#runner.list("agent", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of chunk) {
        after = a.id;
        const b = a.body as unknown as { friendlyName: string; state: string; principalId: string };
        if (b.state === "active" && (a.id === text || b.friendlyName.trim().toLowerCase() === text.toLowerCase())) matches.push({ principalId: b.principalId, name: b.friendlyName });
      }
      if (chunk.length < 200) break;
    }
    if (matches.length === 0) throw new Refusal("not_found", `no active agent called "${text.slice(0, 80)}"`);
    if (matches.length > 1) return { ask: { ok: false, kind: "ask", question: `More than one agent is called "${text.slice(0, 80)}". Which one?`, options: matches.slice(0, 10).map((m) => m.principalId) } };
    return matches[0] as AgentRef;
  }

  // ---- doing ----------------------------------------------------------------------------------------------------------------------

  #length(op: Extract<EditOp, { kind: "grant" }>, at: string, override: number | undefined): { days: number; expiresAt: string } | { message: string } {
    if (override === undefined && op.until !== undefined) {
      const until = op.until.length === 10 ? `${op.until}T23:59:59.000Z` : new Date(op.until).toISOString();
      if (!(Date.parse(until) > Date.parse(at))) return { message: `${op.until} has passed, so this grant can no longer be made as asked; ask again` };
      return { days: Math.ceil((Date.parse(until) - Date.parse(at)) / DAY_MS), expiresAt: until };
    }
    const days = override ?? op.lengthDays ?? DEFAULT_GRANT_DAYS;
    return { days, expiresAt: new Date(Date.parse(at) + days * DAY_MS).toISOString() };
  }

  async #run(owner: Principal, id: string, body: PolicyEditBody, op: EditOp, note: (ref: AppliedRef) => Promise<void>): Promise<{ applied: AppliedRef[]; takesEffect?: string }> {
    const d = this.#deps;
    switch (op.kind) {
      case "policy": {
        const r = await d.policy.set(owner, { commandId: `${id}-set`, scope: op.scope, ...(op.expectedRevision === undefined ? {} : { expectedRevision: op.expectedRevision }), ...(op.profile === undefined ? {} : { profile: op.profile as never }), ...(op.allCommandGate === undefined ? {} : { allCommandGate: op.allCommandGate }), ...(op.environment === undefined ? {} : { environment: op.environment as never }), ...(op.overrides === undefined ? {} : { overrides: op.overrides as never }), ...(op.lock === undefined ? {} : { lock: op.lock }), ...(op.unlock === undefined ? {} : { unlock: op.unlock }) });
        return { applied: [{ kind: "approval-policy", id: op.scope, revision: r.revision }], takesEffect: "at the next evaluation" };
      }
      case "reserve": {
        await d.reviews.setPolicy(owner, { commandId: `${id}-rv`, projectId: op.projectId, policy: op.policy, ...(op.expectedRevision === undefined ? {} : { expectedRevision: op.expectedRevision }) });
        // The revision it left the record at follows from the one it expected; reading it again would give a later one on a replay.
        return { applied: [{ kind: "review-policy", id: op.projectId, revision: (op.expectedRevision ?? 0) + 1 }], takesEffect: "at the next review request" };
      }
      case "grant": {
        const g = await d.grants.grant(owner, {
          commandId: `${id}-gr`, grantee: op.grantee, action: op.action, project: op.projectId, source: "standing", expiresAt: body.decided?.expiresAt as string,
          basis: `chat, edit ${id}: "${body.wording}" Length: ${body.decided?.lengthDays ?? "?"} days (${op.lengthWhy}).`.slice(0, 900),
          terms: { environments: [...op.environments], ...(op.spendLimit === undefined ? {} : { spendLimit: op.spendLimit }), ...(op.audiences === undefined ? {} : { audiences: [...op.audiences] }) },
        });
        return { applied: [{ kind: "grant-record", id: g.id, revision: g.revision }], takesEffect: "from the grantee's next snapshot" };
      }
      case "revoke": {
        const out: AppliedRef[] = [];
        for (const [k, g] of op.grants.entries()) {
          await d.grants.revoke(owner, { commandId: `${id}-rk${k}`, grantId: g.id, expectedRevision: g.revision, reason: `revoked by the owner in chat, edit ${id}` });
          out.push({ kind: "grant-record", id: g.id, revision: g.revision + 1 });
          await note({ kind: "grant-record", id: g.id, revision: g.revision + 1 });
        }
        return { applied: out, takesEffect: "from the grantee's next snapshot" };
      }
      case "setting": {
        const target = { layer: op.layer as never, ...(op.scopeId === undefined ? {} : { scopeId: op.scopeId }) };
        const staged = await d.configuration.stage(owner, { commandId: `${id}-st`, ...target, ...(op.expectedRevision === undefined ? {} : { expectedRevision: op.expectedRevision }), ...(op.remove === true ? { remove: [op.key] } : { set: { [op.key]: op.value } }) });
        await note({ kind: "config-layer", id: op.layer === "installation" ? "installation" : `${op.layer}.${op.scopeId as string}`, revision: staged.revision });
        const result = await d.configuration.apply(owner, { commandId: `${id}-ap`, ...target, expectedRevision: staged.revision });
        if (!result.applied) {
          await d.configuration.discard(owner, { commandId: `${id}-dc`, ...target, expectedRevision: result.revision });
          throw new DomainError("invalid_command", `the configuration check refused it: ${result.problems.join("; ")}. Nothing is in force.`);
        }
        const effect = result.takesEffect[op.key];
        return { applied: [{ kind: "config-layer", id: op.layer === "installation" ? "installation" : `${op.layer}.${op.scopeId as string}`, revision: result.revision }], ...(effect === undefined ? {} : { takesEffect: EFFECT_WORDS[effect] ?? effect }) };
      }
    }
  }

  // ---- storage ------------------------------------------------------------------------------------------------------------------

  #requireOwner(owner: Principal): void {
    if (owner.kind !== "owner" || owner.taskScope !== undefined) throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner edits policy`);
  }

  #bodyOf(ownerId: string, origin: PolicyEditBody["origin"], forwardedBy: string | undefined, turnId: string, wording: string, draft: EditDraft): PolicyEditBody {
    return {
      ownerId, origin, ...(forwardedBy === undefined ? {} : { forwardedBy }), turnId, wording: wording.slice(0, POLICY_EDIT_LIMITS.wording), evidence: draft.evidence, change: draft.change,
      summary: draft.summary.map(line).slice(0, POLICY_EDIT_LIMITS.lines), explanation: draft.explanation.map(line).slice(0, POLICY_EDIT_LIMITS.lines), unapplied: draft.unapplied,
      ...(draft.op === undefined ? {} : { op: draft.op }), direction: draft.direction, direct: draft.direct, status: draft.status, ...(draft.reason === undefined ? {} : { reason: draft.reason }), ...(draft.refusal === undefined ? {} : { refusal: draft.refusal }),
      createdAt: this.#runner.now(),
    };
  }

  async #index(ownerId: string): Promise<{ body: IndexBody; revision?: number }> {
    const found = await this.#runner.get("policy-edit-index", ownerId);
    return found === undefined ? { body: { open: [] } } : { body: found.body as unknown as IndexBody, revision: found.revision };
  }

  /** Creates an edit (once: the ID names it) and, if it is open, lists it in the owner's index in the same operation. */
  async #store(ownerId: string, actor: string, scopedId: string, id: string, body: PolicyEditBody): Promise<{ id: string; status: EditStatus; replayed: boolean }> {
    for (let attempt = 1; ; attempt++) {
      const existing = await this.#runner.get("policy-edit", id);
      if (existing !== undefined) return { id, status: (existing.body as unknown as PolicyEditBody).status, replayed: true };
      try {
        const r = await this.#runner.command("policy.edit.create", { commandId: scopedId, actor }, async () => ({
          payload: { id, wording: body.wording, change: body.change, status: body.status },
          build: async () => {
            const ref: AggregateRef = { kind: "policy-edit", id };
            const changes: Change[] = [{ type: "create", ref, body: asJson(body) }];
            if (OPEN.includes(body.status)) {
              const index = body.forwardedBy === undefined ? ownerId : `fwd:${ownerId}`;
              const idx = await this.#index(index);
              const limit = body.forwardedBy === undefined ? POLICY_EDIT_LIMITS.open : POLICY_EDIT_LIMITS.forwarded;
              if (idx.body.open.length >= limit) throw new DomainError("unavailable", `${limit} policy edits ${body.forwardedBy === undefined ? "" : "passed on by agents "}are waiting already; apply or discard some`);
              const iref: AggregateRef = { kind: "policy-edit-index", id: index };
              const next = asJson({ open: [...idx.body.open, id] });
              changes.push(idx.revision === undefined ? { type: "create", ref: iref, body: next } : { type: "update", ref: iref, expectedRevision: idx.revision, body: next });
            }
            return { ref, creates: true, changes, detail: { status: body.status, via: body.origin.via, ...(body.forwardedBy === undefined ? {} : { forwardedBy: body.forwardedBy }) } };
          },
        }));
        return { id: r.id, status: body.status, replayed: r.replayed };
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 8) throw error;
      }
    }
  }

  /** Moves an edit from one of the `from` states to another, updating the owner's index in the same operation. If it is not in a `from` state, nothing is written and the current record is returned. */
  async #move(ownerId: string, id: string, commandId: string, from: readonly EditStatus[], change: (b: PolicyEditBody) => PolicyEditBody): Promise<{ body: PolicyEditBody; changed: boolean }> {
    for (let attempt = 1; ; attempt++) {
      const current = await this.#runner.get("policy-edit", id);
      if (current === undefined) throw new DomainError("not_found", "no such policy edit");
      const before = current.body as unknown as PolicyEditBody;
      if (!from.includes(before.status)) return { body: before, changed: false };
      const next = change(before);
      if (next === before) return { body: before, changed: false };
      try {
        await this.#runner.command("policy.edit.move", { commandId: scopedCommandId(ownerId, commandId), actor: ownerId }, async () => ({
          payload: { id, to: next.status },
          build: async () => {
            const now = await this.#runner.get("policy-edit", id);
            if (now === undefined) throw new DomainError("not_found", "no such policy edit");
            const ref: AggregateRef = { kind: "policy-edit", id };
            const changes: Change[] = [{ type: "update", ref, expectedRevision: now.revision, body: asJson(next) }];
            if (OPEN.includes(before.status) && !OPEN.includes(next.status)) {
              const index = before.forwardedBy === undefined ? ownerId : `fwd:${ownerId}`;
              const idx = await this.#index(index);
              if (idx.revision !== undefined) changes.push({ type: "update", ref: { kind: "policy-edit-index", id: index }, expectedRevision: idx.revision, body: asJson({ open: idx.body.open.filter((x) => x !== id) }) });
            }
            return { ref, creates: false, changes, detail: { from: before.status, to: next.status } };
          },
        }));
        return { body: next, changed: true };
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 8) throw error;
        // Someone else moved it, or the index moved: read again and decide on what is there now.
        const again = (await this.#runner.get("policy-edit", id))?.body as unknown as PolicyEditBody | undefined;
        if (again !== undefined && !from.includes(again.status)) return { body: again, changed: false };
      }
    }
  }
}

// ---- helpers --------------------------------------------------------------------------------------------------------------------

interface ScopeRef { readonly id: string; readonly name: string }
interface AgentRef { readonly principalId: string; readonly name: string }
interface Built { readonly summary: string[]; readonly explanation: string[]; readonly direction: Direction; readonly op?: EditOp; readonly noop?: boolean }

/** A reason an edit cannot be made; it becomes a recorded, refused edit so the wording is kept. */
class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const revisionField = (revision: number): { expectedRevision?: number } => (revision > 0 ? { expectedRevision: revision } : {});

function cellLines(changes: readonly { cell: string; from: Mode; to: Mode }[]): string[] {
  return changes.map((c) => {
    const [cls, tier] = [c.cell.slice(0, c.cell.lastIndexOf(".")), c.cell.slice(c.cell.lastIndexOf(".") + 1)] as [ActionClass, Tier];
    return `${cap(CLASS_WORDS[cls])} in ${TIER_WORDS[tier]} environments: ${MODE_WORDS[c.from]} -> ${MODE_WORDS[c.to]}.`;
  });
}

void CELL_KEYS; void tightness; void ENVIRONMENTS; void ({} as PolicyBody);

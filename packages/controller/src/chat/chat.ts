import { createHash, randomUUID } from "node:crypto";
import { BUILTIN_COMMANDS, OPERATION_BY_NAME } from "../api/operations.js";
import { expandShorthand } from "./shorthand.js";
import { parseInvocation } from "../commands/resolve.js";
import { API_VERSION, type StateApi } from "../api/state-api.js";
import { GATE_TOPIC, TOPIC, normalText, normalTopic, notADecision, notADecisionIn } from "../decisions/records.js";
import { DomainError } from "../domain/errors.js";
import { onlyKnown } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { derivedId } from "../domain/ids.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal, PrincipalService } from "../security/principals.js";
import { LIMITS as STORAGE_LIMITS, type AggregateRef, type Change, type ControllerStorage, type JsonObject } from "../storage/types.js";
import type { Cite, StatusRequest } from "../status/index.js";
// A task title is checked text without C0 controls, but an agent's sub-task (swarm) or a meeting task may carry C1 controls, bidirectional overrides or line separators: it is shown quoted.
import { quoted as quotedText } from "../status/explain.js";
import { docVerifyCode } from "../submissions/doc-obligations.js";
import { probeUrl } from "../projects/probes.js";
import { instantOf, isLocalDate, isLocalTime, knownZone, wallClock } from "../meetings/zones.js";
import type { ApprovedCodeLookup } from "./approved-code.js";
import { WINDOW_DEFAULTS } from "../release/windows.js";
import { DEFAULT_REPLY_TOKENS, smallWindowWarning } from "../context/fixed-part.js";
import { MIN_WORKABLE_CONTEXT_TOKENS, PROVIDER_NAME } from "../setup/providers.js";
import { ROUTING_LIMITS } from "../routing/index.js";
import { ACTIVATION_LIMITS } from "../release/activation.js";
import type { CoordinatorService } from "./coordinator.js";
import { relianceLines } from "../status/reliance-words.js";
import type { Reliance } from "../security/reliance.js";
import { LIFECYCLE_OPS, WHOLE_INSTALLATION_WORDS, FLOOR_CONTROLS, NEED_CHOICES, ROUTE_SETTING_EXEMPT, SETUP_EXEMPT, wholeWord, addressWritten, platformsNamed, platformChoices, saysPlatform, durationInWords, windowLengthInWords, leadInWords, sizeInWords, grantDateInWords, GRANT_BUNDLES, GRANT_BUNDLE_LIMIT, GRANT_EXEMPT, CHAT_OPS, LANDING_MEANS, PROJECT_AS_PROJECT, TITLE_KEYS, acceptedArgs, describe, foreignValue, landingOf, RELEASE_ID_KEYS, MAINTENANCE_ID_KEYS, OWNER_RESPOND_EXEMPT, MEETING_CONTROLS, MEETING_CONTROL_EXEMPT, RECOVERY_STEP_EXEMPT, WORKSPACE_REQUEST_EXEMPT, SIMULATION_EXEMPT, EVENT_SOURCE_EXEMPT, STREAM_SWITCH_EXEMPT, DEFECT_EXEMPT, DOC_EXEMPT, hasRefMarker, ownerSaysMove, proposalReason } from "./commands.js";
import { CHECKS, INTEGRATORS, LANDINGS, profileDefaults } from "../policy/integration-policy.js";
import { lengthInWords, type EditDraft, type PolicyEditService } from "./policy-edit.js";
import { CHAT_LIMITS, checkIntents, evidenceInText, evidenceStrong, evidenceWholeMessage, refuseCredentials, splitQuoted, type ChatInterpreter, type Intent } from "./interpreter.js";

// ---- records -------------------------------------------------------------------------------------------------------------------

/** One command of a proposal: a typed state-API command with its own fixed command ID, so applying the proposal twice, or after a crash, does each step once. */
export interface ChatStep {
  readonly op: string;
  readonly args: Record<string, unknown>;
  readonly commandId: string;
  /** A name later steps may refer to (`"$ref:name"` in an argument becomes the ID this step produced). */
  readonly key?: string;
  /** Who runs the step: the owner (default) or the coordinator, which only a coordinator holding the grant is given. */
  readonly as?: "owner" | "coordinator";
}

/** A task a proposal hands out: the project and repository it carries, fixed when the proposal was drawn up, so a later change of focus cannot retarget it. */
export interface ChatPin {
  readonly taskId: string;
  readonly projectId: string;
  readonly repositoryId?: string;
  /** The repository is set by an earlier step of the same proposal. */
  readonly repositoryFromStep?: string;
  /** The task must still be idle (not in progress, not assigned) when this is applied: a running task keeps its checkout. */
  readonly idle?: true;
}

export interface ChatStepResult { readonly op: string; readonly id: string; readonly revision?: number; readonly key?: string; readonly shown?: readonly string[]; readonly accepted: true; readonly completed: boolean; readonly awaits?: string }

export interface ChatProposalBody {
  readonly ownerId: string;
  readonly turnId: string;
  readonly source: "chat" | "coordinator";
  readonly status: "open" | "applied" | "discarded";
  readonly reason: string;
  /** What will happen, one plain line per step, as shown to the owner. */
  readonly preview: readonly string[];
  readonly steps: readonly ChatStep[];
  readonly pins: readonly ChatPin[];
  readonly notes: readonly string[];
  readonly createdAt: string;
  readonly appliedAt?: string;
  readonly results?: readonly ChatStepResult[];
  readonly discardedAt?: string;
}

type PlanItem =
  | { readonly i: number; readonly kind: "apply"; readonly op: string; readonly args: JsonObject; readonly commandId: string; readonly preview: string; /** For a decision: the version of its topic when the message was planned, before any step of the message. A decision applied later (a turn run again) is based on it when someone else changed the topic since, so the change becomes a dispute and is not overwritten. */ readonly planBase?: number }
  | { readonly i: number; readonly kind: "propose"; readonly proposalId: string; readonly steps: readonly ChatStep[]; readonly pins: readonly ChatPin[]; readonly preview: readonly string[]; readonly reason: string }
  | { readonly i: number; readonly kind: "focus"; readonly projectId: string; readonly preview: string }
  /** A command the owner typed (`/nimblenewt.…`, card T09b): it runs as typed, not through the interpreter. */
  | { readonly i: number; readonly kind: "command"; readonly typed: string }
  | { readonly i: number; readonly kind: "apply_proposal" | "discard_proposal"; readonly proposalId: string; readonly lengthDays?: number }
  | { readonly i: number; readonly kind: "status"; readonly request: JsonObject }
  | { readonly i: number; readonly kind: "coordinator"; readonly action: "answer" | "decompose" | "assign" | "configure" | "start" | "pause" | "stop"; readonly projectId?: string; readonly question?: string; readonly outcome?: string; readonly principalId?: string; readonly agentName?: string; readonly routes?: readonly string[]; /** The revision of the coordinator record the order expects, read once when the message was planned, so a retry of the turn sends the same thing. */ readonly expectedRevision?: number }
  | { readonly i: number; readonly kind: "policy"; readonly editId: string; readonly draft: EditDraft; readonly preview: readonly string[] }
  | { readonly i: number; readonly kind: "asked"; readonly question: string; readonly options: readonly string[]; /** For a question the service asked: which command (by position) and which argument the answer fills, and the answers that are allowed. */ readonly intentIndex?: number; readonly field?: string; readonly choices?: readonly string[] }
  | { readonly i: number; readonly kind: "held"; readonly preview: string }
  | { readonly i: number; readonly kind: "refused"; readonly code: string; readonly message: string }
  | { readonly i: number; readonly kind: "ignored"; readonly reason: string };

export interface Outcome {
  readonly i: number;
  readonly status: "applied" | "proposed" | "asked" | "held" | "refused" | "ignored" | "focused" | "discarded" | "answered";
  readonly op?: string;
  readonly commandId?: string;
  readonly id?: string;
  readonly revision?: number;
  readonly accepted?: true;
  readonly completed?: boolean;
  readonly awaits?: string;
  readonly proposalId?: string;
  /** A policy edit (card U04): its record, what it means, and what was left unapplied. */
  readonly editId?: string;
  readonly explanation?: readonly string[];
  readonly unapplied?: readonly string[];
  readonly takesEffect?: string;
  readonly preview?: readonly string[];
  readonly question?: string;
  readonly options?: readonly string[];
  readonly code?: string;
  readonly message?: string;
  readonly projectId?: string;
  readonly results?: readonly ChatStepResult[];
  /** For a status answer (card U05): when it was read, and what the records say, each line with the records it comes from. A replay of the message returns this answer as it was, not a fresh one. */
  readonly observedAt?: string;
  readonly lines?: readonly { readonly text: string; readonly cites: readonly Cite[] }[];
  readonly moreLines?: number;
  /** For an agenda topic that was captured or corrected (card M03): the item as it now reads, in plain lines, for the owner to check. */
  readonly shown?: readonly string[];
}

export interface TurnBody {
  readonly ownerId: string;
  readonly messageId: string;
  readonly text: string;
  readonly quotedCount: number;
  /** The project the conversation was about when the message arrived (the focus), or the project the message named. */
  readonly projectId?: string;
  readonly status: "planned" | "done";
  readonly plan: readonly PlanItem[];
  /** When part of the message waits for an answer: the held commands, in plan order, each with the words it was said in; an `answer` intent resumes them. */
  readonly held?: readonly { readonly intent: Intent; readonly text: string; /** The turn the words were said in, when it is not this one (the commands were held through a question). */ readonly from?: string }[];
  /** The turn whose held commands this one carries on (it is closed once this one is done). */
  readonly resumes?: string;
  readonly resumedBy?: string;
  readonly outcomes?: readonly Outcome[];
  /** What the stand-up later decided about a topic taken from this turn (card M03f), put here by the controller. */
  readonly followUps?: readonly { readonly key: string; readonly text: string; readonly at: string }[];
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface ContextBody {
  readonly focusProjectId?: string;
  /** The latest question whose answer would carry on held commands. */
  readonly awaiting?: { readonly turnId: string; readonly question: string; readonly choices: readonly string[] };
  readonly projects: Readonly<Record<string, { readonly touchedAt: string; readonly lastTaskId?: string; readonly turns: readonly { readonly turnId: string; readonly at: string; readonly summary: string; /** What happened later to the topic (card M03g): shown by `context()` only, never stored. */ readonly followUps?: { /** How many are kept on the turn (at most 20; older ones are dropped), not a total. */ readonly kept: number; readonly latest: readonly { readonly text: string; readonly at: string }[] } }[] }>>;
}

/** Follow-ups are read for the project in focus and the few most recently touched ones; the rest of the listing shows no follow-ups (card M03g). */
export const FOLLOW_UP_PROJECTS = 5;
/** The latest follow-ups of a turn the listing shows. */
export const FOLLOW_UP_SHOWN = 3;

/** What the channel a message came by can do. A channel that keeps what it shows (the web page's outbox) says `secrets: false`. */
export interface ChatChannel {
  readonly secrets?: boolean;
  /**
   * What the message means, already decided by code that built the message (the web page's buttons, card U08b): checked like an interpreter's answer, and planned, shown and applied exactly as if the
   * assistant had read the words. The words are still the owner's evidence, so a proposal-first command is still shown first. Only in-process callers can set it; no API operation passes it.
   */
  readonly fixedIntents?: readonly unknown[];
}
/** Operations whose result carries a secret shown once (card U14b). */
export const SECRET_OPS: ReadonlySet<string> = new Set(["credential.issue"]);
const NO_SECRET_CHANNEL = "this channel keeps what it shows, so it cannot show a credential once; issue it in the terminal chat (or through the API)";

/** A secret an operation made for the owner (card U14b: a credential). It is handed to the caller of the turn once, in memory, and is in no record: not the turn, the proposal, an outcome or a log. */
export interface RevealedSecret { readonly label: string; readonly value: string }

export interface TurnResult {
  readonly turnId: string;
  readonly replayed: boolean;
  readonly outcomes: readonly Outcome[];
  /** The owner-facing answer, one plain line each. */
  readonly reply: readonly string[];
  /** Secrets this turn made (a new credential), shown once to the owner. Never stored: a turn sent again (`replayed`) does not have them. */
  readonly secrets?: readonly RevealedSecret[];
}

export interface ApplyResult { readonly proposalId: string; readonly applied: boolean; readonly replayed: boolean; readonly results: readonly ChatStepResult[]; readonly secrets?: readonly RevealedSecret[]; readonly failure?: { readonly step: number; readonly code: string; readonly message: string } }

export interface ChatDeps {
  readonly principals: PrincipalService;
  readonly api: Pick<StateApi, "handle">;
  readonly interpreter: ChatInterpreter;
  /** The coordinator's own credential, for steps a coordinator that holds the grant runs itself. Absent: none. */
  readonly coordinatorToken?: () => Promise<string | undefined>;
  /** The approval policy (card A07): its profile decides whether an explicit order applies at once. Absent or unreadable: the strict profile, so a proposal. */
  readonly policy?: { effective(by: Principal, projectId?: string): Promise<{ readonly profile: string } | undefined> };
  /** Status and blocker explanations (card U05). Absent: a status question is answered as unavailable; nothing else changes. */
  readonly status?: { ask(by: Principal, request: StatusRequest): Promise<{ readonly observedAt: string; readonly lines: readonly { readonly text: string; readonly cites: readonly Cite[] }[] } | undefined> };
  /** Conversational policy editing (card U04). Absent: a policy instruction is answered with a refusal. */
  readonly policyEdits?: PolicyEditService;
  /** The coordinator (card U03), looked up when used, because it is built after the chat (it proposes through it). Absent, or answering undefined: what is said to the coordinator is refused as unavailable. */
  readonly coordinator?: () => CoordinatorService | undefined;
  /** How many questions from agents wait for the owner's answer (card U12e). Shown as a last line of every reply, so the owner is never unaware of them. Absent, or failing: nothing is added. */
  readonly waiting?: (owner: Principal) => Promise<number>;
  /** Everything waiting for the owner's decision (card U11b); when given it is counted in place of the questions alone. */
  readonly needing?: (owner: Principal) => Promise<number>;
  /** The approved code of a task that is not committed yet (card D01, release by words): a release request names the submission by it. Absent: a release that names no submission is not proposed. */
  readonly approvedCode?: ApprovedCodeLookup;
}

/**
 * Typed orders that work without the assistant and run as typed (card U06): pause and resume, suspend, stop and Force Stop, and taking a right back. The owner typing the exact command is the order, so they are not shown first;
 * every other command that changes things still is. They need nothing from the model, so a provider outage does not stand between the owner and a stop.
 */
const RECOVERY_OPS: ReadonlySet<string> = new Set(["lifecycle.pause", "lifecycle.resume", "lifecycle.stop", "lifecycle.force", "lifecycle.choose", "lifecycle.advance", "grant.revoke", "routing.disable", "routing.drain", "routing.cutover", "routing.reenable"]);

/**
 * What a maintenance window proposal (card K07) shows about its time and limits: the owner's local time and zone, the instants it comes to in UTC (a time the clocks skip, or one they pass twice, is
 * said so), how long it lasts, how early preparation starts and how much free space it needs, with the defaults filled in, so every number the window would be set with is on the proposal.
 */
export function windowTimeNote(args: Readonly<Record<string, unknown>>): string {
  const num = (v: unknown, fallback: number): string => (v === undefined ? `${fallback} (the default)` : typeof v === "number" ? String(v) : quotedText(String(v), 20));
  const parts = [`The window opens on ${quotedText(String(args["date"]), 20)} at ${quotedText(String(args["time"]), 10)} in ${quotedText(String(args["timeZone"]), 64)}`];
  const zone = knownZone(args["timeZone"]);
  const minutes = args["durationMinutes"];
  if (zone !== undefined && isLocalDate(args["date"]) && isLocalTime(args["time"])) {
    const opens = instantOf(args["date"], args["time"], zone);
    const wall = wallClock(opens, zone);
    const shownAt = `${wall.date} ${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
    if (shownAt !== `${args["date"]} ${args["time"]}`) parts.push(`(that time does not exist that day, because the clocks go forward; it opens at ${shownAt} local time instead)`);
    else if (wallClock(opens + 3_600_000, zone).hour === wall.hour && wallClock(opens + 3_600_000, zone).minute === wall.minute && wallClock(opens + 3_600_000, zone).date === wall.date) parts.push("(that time happens twice that night, because the clocks go back; it opens at the first of the two)");
    parts.push(`= ${new Date(opens).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    if (typeof minutes === "number" && Number.isSafeInteger(minutes)) parts.push(`until ${new Date(opens + minutes * 60_000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  }
  return `${parts.join(" ")}; it lasts ${typeof minutes === "number" ? String(minutes) : quotedText(String(minutes), 20)} minutes. Preparation starts ${num(args["prepareLeadMinutes"], WINDOW_DEFAULTS.prepareLeadMinutes)} minutes before it opens and needs ${num(args["minFreeBytes"], WINDOW_DEFAULTS.minFreeBytes)} bytes free under the release folder. Check that this is the time you meant.`;
}

/** What the staged-release picker reads from `release.status`. */
export interface ReleaseStatusForPick { readonly current?: { id: string }; readonly previous?: { id: string }; readonly lastKnownGood?: { id: string }; readonly history?: readonly { kind?: string; to?: string; from?: string }[]; readonly failedStarts?: readonly { id: string }[]; readonly staged?: readonly { candidateId: string; stagedAt?: string }[] }

/**
 * The one staged release waiting to be installed, for a maintenance window set without a release named (card K07), or what to ask the owner. A release that ran here stays staged for going back
 * and is never "the update waiting": the current, previous and last known good releases and every release the activation history shows switched to or from (an aborted switch, or a resolve that
 * may have aborted, does not count as having run). The history is trimmed, so a release staged before the current one could have run long ago: such a release is never picked silently, nor is one
 * of several, and when the status's page of staged releases is full the owner is asked too.
 */
export function pickWaitingRelease(s: ReleaseStatusForPick, quarantined: readonly string[]): { id: string } | { ask: string } {
  const ran = new Set<string>();
  for (const id of [s.current?.id, s.previous?.id, s.lastKnownGood?.id]) if (typeof id === "string") ran.add(id);
  for (const h of s.history ?? []) {
    if (typeof h.from === "string") ran.add(h.from);
    if (typeof h.to === "string" && h.kind !== "aborted" && h.kind !== "resolved") ran.add(h.to);
  }
  const q = new Set(quarantined);
  const failed = new Set((s.failedStarts ?? []).map((f) => f.id));
  const staged = s.staged ?? [];
  const eligible = staged.filter((x) => !ran.has(x.candidateId) && !q.has(x.candidateId) && !failed.has(x.candidateId));
  const name = (xs: readonly { candidateId: string }[]): string => `${xs.slice(0, 5).map((x) => x.candidateId).join(", ")}${xs.length > 5 ? ", ..." : ""}`;
  if (staged.length >= ACTIVATION_LIMITS.listed) return { ask: `Many staged releases are kept (${staged.length} or more), so the one waiting cannot be told from the list: which one should the window install? Name its rcn- ID.` };
  if (eligible.length === 0) return { ask: "No staged release is waiting to be installed (stage one first with release.stage), so there is nothing for a maintenance window to install." };
  if (eligible.length > 1) return { ask: `${eligible.length} staged releases could be installed (${name(eligible)}): which one should the window install?` };
  const only = eligible[0]!;
  // Staged before the running release: it may be an older build (or one that ran before the history kept), so it is offered by name, not taken.
  const currentStagedAt = s.current === undefined ? undefined : staged.find((x) => x.candidateId === s.current!.id)?.stagedAt;
  if (s.current !== undefined && (currentStagedAt === undefined || only.stagedAt === undefined || only.stagedAt <= currentStagedAt)) return { ask: `The only staged release that has not run here, ${only.candidateId}, was staged before the running release ${s.current.id}, so it may be older: name it if that is the one the window should install.` };
  return { id: only.candidateId };
}

const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROJECT_ID = /^proj-[a-z2-7]{20}$/;
const PROPOSAL_ID = /^prop-[0-9a-f]{32}$/;
/** Chat turns `history` reads at most in one call, and the shape of its page cursor (an ISO time, a bar, a turn ID). */
const HISTORY_SCAN = 4000;
const HISTORY_CURSOR = /^[0-9TZ:.+-]{10,40}\|turn-[0-9a-f]{32}$/;
/** One turn of the owner's recorded conversation, as `history` returns it. An outcome that proposes something also says whether the proposal is still `open`. */
export interface HistoryTurn {
  readonly turnId: string;
  readonly messageId: string;
  readonly text: string;
  readonly status: "planned" | "done";
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly reply: readonly string[];
  readonly outcomes: readonly Outcome[];
}
const hash = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const asJson = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

type Resolved =
  | { readonly ok: true; readonly steps: ChatStep[]; readonly pins: ChatPin[]; readonly labels: Record<string, string>; readonly projectId?: string; readonly reason?: string; /** Extra lines for the owner's preview (the calls a revocation would reach). */ readonly notes?: readonly string[]; readonly args: Record<string, unknown>; readonly op: string }
  | { readonly ok: false; readonly kind: "ask"; readonly question: string; readonly options: string[]; readonly field?: string; readonly choices?: string[] }
  | { readonly ok: false; readonly kind: "refuse"; readonly code: string; readonly message: string };

/**
 * Owner chat command interpretation (card U03). A free-form message from the owner is turned into typed commands by an injected interpreter (the model call, scripted in tests) and then handled
 * by rules that do not depend on the model:
 *
 * - **Never executed from model text.** The interpreter's answer is validated field by field (`checkIntents`); a command must name a known operation of the state API with known arguments; the
 *   details the owner leaves out (revisions, the project in focus, a task named by its title) are filled in from records, and a name that matches nothing or several things is a question.
 * - **Same door as every client.** An applied command is a request to `StateApi` under the owner's own credential with a command ID derived from the message, so authorization, revision
 *   checks and idempotency are exactly the API's; a repeated message does nothing twice.
 * - **Authority comes from the owner's words only.** Quoted material (lines after `>`, fenced blocks, or text the client marks as quoted) is shown to the interpreter as material; an intent
 *   based on it, or whose cited words are not in the owner's own text, is refused.
 * - **Show before anything irreversible.** A reversible edit applies; a new project, an assignment, a retirement, a final state and anything the owner asked to see as a draft are saved as
 *   a proposal with a plain preview, and nothing happens until an explicit request applies it (never in the message that created it).
 * - **One question holds the whole message.** If any part of a message needs an answer, nothing in that message is applied: the question is returned and the owner says it again with the answer.
 * - **Plan first, then act.** The planned commands are stored before the first one runs, so a restart carries on from the stored plan (without asking the model again) and every step keeps its
 *   command ID. The stored turn links each outcome to the command IDs (and so to the audit entries) it produced.
 */
/** The owner saying a running-call choice in their own words, with its usual endings ("cancel", "cancelled", "cancels"; "finish", "finished"; "pause", "paused"). */
const SAID_CHOICE: Readonly<Record<"finish" | "cancel" | "pause", RegExp>> = { finish: /\bfinish(?:ed|es|ing)?\b/i, cancel: /\bcancel(?:l?ed|s|l?ing)?\b/i, pause: /\bpause(?:d|s)?\b|\bpausing\b/i };
/** True if `value` is a whole number the owner wrote as a number of its own in `text` ("revision 4", "v4", "revision #4", full-width "４"; not the 4 of "14" or "4.5"): a revision the owner quoted, as opposed to one the interpreter supplied. Digits of other scripts and number words do not count. */
const ownerWroteNumber = (text: string, value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && (text.normalize("NFKC").match(/(?<![\d.])\d+(?![\d.]?\d)/g) ?? []).some((n) => Number(n) === value);
/** The sentence of `text` that holds `value` as a whole word (a scope or a time limit counts only when said about the same right). */
const sentenceWith = (text: string, value: string): string | undefined => text.split(/(?<=[.!?])\s+|\n+/).find((part) => wholeWord(part, value));

/** What a caller may pass to a chat call: `stillAllowed` is asked again before each state-changing step and throws when the caller's authority has ended (a revoked browser session); the call then stops with that error. */
export interface CallOptions { readonly stillAllowed?: () => void | Promise<void> }
type Guard = () => Promise<void>;
/** The guard's error, wrapped so that it is not mistaken for a DomainError (which a step turns into a refused outcome): it ends the whole call. */
class CallEnded extends Error { constructor(readonly original: unknown) { super("the caller's authority ended"); } }
const guardOf = (o: CallOptions): Guard | undefined => o.stillAllowed === undefined ? undefined : async () => { try { await o.stillAllowed!(); } catch (e) { throw new CallEnded(e); } };
async function endedOf<T>(run: () => Promise<T>): Promise<T> { try { return await run(); } catch (e) { throw e instanceof CallEnded ? e.original : e; } }

export class ChatService {
  readonly #runner: CommandRunner;
  readonly #deps: ChatDeps;
  /** Secrets made while a turn runs, by turn, until the turn's caller takes them. Memory only. */
  readonly #revealed = new Map<string, RevealedSecret[]>();
  /** Turns from a channel that cannot show a secret once (the web page keeps what it receives): an operation that makes one is refused in them. */
  readonly #noSecrets = new Set<string>();

  private constructor(runner: CommandRunner, deps: ChatDeps) {
    this.#runner = runner;
    this.#deps = deps;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: ChatDeps, options: RunnerOptions = {}): ChatService {
    return new ChatService(new CommandRunner(storage, epoch, options), deps);
  }

  // ---- the message -----------------------------------------------------------------------------------------------------------

  /** Handles one message from the owner. `messageId` is the owner's idempotency key for the message: sending it again returns the first turn. */
  async submit(token: unknown, message: { messageId: string; text: string; quoted?: readonly string[] }, options: CallOptions & ChatChannel = {}): Promise<TurnResult> {
    return endedOf(() => this.#submit(token, message, options, guardOf(options)));
  }

  async #submit(token: unknown, message: { messageId: string; text: string; quoted?: readonly string[] }, options: ChatChannel, guard: Guard | undefined): Promise<TurnResult> {
    const owner = await this.#owner(token);
    const tok = token as string;
    onlyKnown(message, ["messageId", "text", "quoted"]);
    const messageId = typeof message.messageId === "string" && message.messageId.length <= CHAT_LIMITS.messageId && MESSAGE_ID.test(message.messageId) ? message.messageId : invalid("messageId", "must be 1 to 100 letters, digits, dots, dashes or underscores");
    if (typeof message.text !== "string" || message.text.length === 0 || message.text.length > CHAT_LIMITS.text) invalid("text", `must be text of 1 to ${CHAT_LIMITS.text} characters`);
    refuseCredentials(message.text, "text");
    const split = splitQuoted(message.text);
    const given = message.quoted ?? [];
    if (!Array.isArray(given) || given.length + split.quoted.length > CHAT_LIMITS.quoted) invalid("quoted", `at most ${CHAT_LIMITS.quoted} quoted items`);
    const quoted = [...given, ...split.quoted].map((q, i) => (typeof q === "string" && q.length <= CHAT_LIMITS.quotedText ? q : invalid(`quoted[${i}]`, `must be text of at most ${CHAT_LIMITS.quotedText} characters`)));
    // Quoted material is untrusted and may well hold secrets: they are cut out before anything sees it.
    const safeQuoted = quoted.map((q) => redactForModel(q));
    const turnId = `turn-${hash(owner.id, messageId)}`;
    if (options.secrets === false) this.#noSecrets.add(turnId);

    let turn = await this.#turn(turnId);
    let replayed = turn !== undefined;
    if (turn === undefined) {
      if (split.text.length === 0) invalid("text", "has no words of the owner's own outside quoted material");
      const context = await this.#context(owner.id);
      const focus = await this.#focus(tok, context.focusProjectId);
      // A message that is a typed command (`/nimblenewt.grant-list`) is not read by the assistant: it is the command, as the owner typed it.
      const typed = split.text.trim();
      const fixed = options.fixedIntents === undefined ? undefined : checkIntents([...options.fixedIntents]);
      const isCommand = fixed === undefined && quoted.length === 0 && parseInvocation(typed) !== undefined;
      // A short form of a routing order is expanded and shown, not run (card U06b): the exact line it stands for is what runs.
      const short = fixed !== undefined || isCommand || quoted.length > 0 ? undefined : expandShorthand(typed);
      const interpreted = fixed !== undefined ? { intents: fixed } : isCommand || short !== undefined ? { intents: [] as never[], problem: "" } : await this.#interpret({ text: split.text, quoted: safeQuoted, focus, now: this.#runner.now(), proposals: [...(await this.#openProposals(owner.id)), ...(await this.#openEdits(owner))].slice(0, 10), ...(context.awaiting === undefined ? {} : { awaiting: context.awaiting }) });
      if ("unavailable" in interpreted) return { turnId, replayed: false, outcomes: [], reply: ["The assistant that reads free-form messages is unavailable right now. Nothing was done; the commands of the API and the proposals you already have work as usual."] };
      const planned = short !== undefined
        ? { items: [{ i: 0, kind: "refused", code: "needs_confirmation", message: "typed" in short ? `That short form stands for this order. It has not run; send the line as it is to run it:\n${short.typed}` : short.error } as PlanItem], projectId: context.focusProjectId, held: undefined, resumes: undefined }
        : isCommand
        ? { items: [{ i: 0, kind: "command", typed } as PlanItem], projectId: context.focusProjectId, held: undefined, resumes: undefined }
        : interpreted.intents === undefined
        ? { items: [{ i: 0, kind: "refused", code: "interpreter_invalid", message: interpreted.problem } as PlanItem], projectId: context.focusProjectId, held: undefined, resumes: undefined }
        : await this.#plan(owner, tok, turnId, split.text, interpreted.intents, focus, context.focusProjectId, safeQuoted.length > 0);
      const body: TurnBody = { ownerId: owner.id, messageId, text: split.text, quotedCount: quoted.length, ...(planned.projectId === undefined ? {} : { projectId: planned.projectId }), ...(planned.held === undefined ? {} : { held: planned.held }), ...(planned.resumes === undefined ? {} : { resumes: planned.resumes }), status: "planned", plan: planned.items, createdAt: this.#runner.now() };
      // A long interpretation may have outlived the browser session that asked: nothing is recorded for a session that ended meanwhile.
      await guard?.();
      try {
        await this.#createTurn(owner, turnId, body);
        turn = await this.#turn(turnId);
      } catch (error) {
        // A message with the same ID arriving at the same moment: the first plan stands.
        if (!(error instanceof DomainError) || (error.code !== "command_conflict" && error.code !== "stale_revision")) throw error;
        turn = await this.#turn(turnId);
        replayed = true;
        if (turn === undefined) throw error;
      }
    }
    if (turn === undefined) throw new DomainError("unavailable", "the turn could not be recorded");
    let finished: TurnBody;
    try { finished = turn.status === "done" ? turn : await this.#execute(owner, tok, turnId, turn, guard); } catch (error) { this.#revealed.delete(turnId); throw error; } finally { this.#noSecrets.delete(turnId); }
    const secrets = this.#revealed.get(turnId);
    this.#revealed.delete(turnId);
    const reply = replyOf(finished.outcomes ?? []);
    if (secrets !== undefined) reply.push(`${secrets.length === 1 ? "A credential was made" : "Credentials were made"}. ${secrets.length === 1 ? "It is" : "They are"} shown once, below, and kept nowhere: copy ${secrets.length === 1 ? "it" : "them"} now into the secret store of the agent or host. If ${secrets.length === 1 ? "it is" : "they are"} lost, ask for a new one.`);
    let count = 0;
    let needing = 0;
    try { needing = (await this.#deps.needing?.(owner)) ?? 0; } catch { /* the reply is still given */ }
    try { count = needing > 0 ? 0 : (await this.#deps.waiting?.(owner)) ?? 0; } catch { /* the reply is still given */ }
    if (needing > 0) reply.push(`${needing >= 50 ? "50 or more" : needing} ${needing === 1 ? "thing needs" : "things need"} your decision. Ask what needs you to see ${needing === 1 ? "it" : "them"}.`);
    if (count > 0) reply.push(`${count >= 50 ? "50 or more" : count} ${count === 1 ? "question from an agent is" : "questions from agents are"} waiting for your answer. Ask what is waiting to see ${count === 1 ? "it" : "them"}.`);
    return { turnId, replayed, outcomes: finished.outcomes ?? [], reply, ...(secrets === undefined ? {} : { secrets }) };
  }

  /** A turn as recorded (the owner only): what was planned and what came of each part, with the command IDs that link it to the audit trail. */
  async getTurn(token: unknown, turnId: string): Promise<TurnBody | undefined> {
    const owner = await this.#owner(token);
    const turn = await this.#turn(turnId);
    return turn === undefined || turn.ownerId !== owner.id ? undefined : turn;
  }

  /**
   * The owner's recent conversation as recorded (card U07 finish): the newest turns first, each with the words said, what came of them in plain lines and its outcomes, and for every proposal in them
   * whether it is still open, applied or discarded (so a second browser never offers a button for a decision that was already made). Read only: it runs no command, calls no model and writes nothing.
   * The turns are found by a bounded scan (at most `HISTORY_SCAN` records, ordered by identity, not time), so a very long history reports `complete: false`: the turns it then gives are the newest of those it read, which need not be the newest the owner made (no time index exists; one would remove the bound).
   * `before` is the `next` of the previous page.
   */
  async history(token: unknown, request: { limit?: number; before?: string } = {}): Promise<{ turns: readonly HistoryTurn[]; next?: string; complete: boolean }> {
    const owner = await this.#owner(token);
    onlyKnown(request, ["limit", "before"]);
    const limit = request.limit === undefined ? 20 : Number.isInteger(request.limit) && request.limit >= 1 && request.limit <= 50 ? request.limit : invalid("limit", "must be a whole number from 1 to 50");
    if (request.before !== undefined && (typeof request.before !== "string" || !HISTORY_CURSOR.test(request.before))) invalid("before", "must be the next of an earlier history page");
    const mine: { id: string; body: TurnBody }[] = [];
    let complete = true;
    let scanned = 0;
    for (let after: string | undefined; ;) {
      const chunk = await this.#runner.list("chat-turn", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of chunk) { const b = a.body as unknown as TurnBody; if (b.ownerId === owner.id) mine.push({ id: a.id, body: b }); }
      scanned += chunk.length;
      if (chunk.length < 200) break;
      if (scanned >= HISTORY_SCAN) { complete = false; break; }
      after = chunk[chunk.length - 1]!.id;
    }
    // Newest first; the cursor is the time and ID of the last turn shown, so turns made meanwhile never shift a page.
    mine.sort((a, b) => (a.body.createdAt === b.body.createdAt ? (a.id < b.id ? 1 : -1) : a.body.createdAt < b.body.createdAt ? 1 : -1));
    const bar = request.before === undefined ? undefined : request.before.indexOf("|");
    const cursor = request.before === undefined || bar === undefined ? undefined : { at: request.before.slice(0, bar), id: request.before.slice(bar + 1) };
    const older = cursor === undefined ? mine : mine.filter((t) => t.body.createdAt < cursor.at || (t.body.createdAt === cursor.at && t.id < cursor.id));
    const page = older.slice(0, limit);
    const state = new Map<string, "open" | "applied" | "discarded" | "unknown">();
    const turns: HistoryTurn[] = [];
    for (const t of page) {
      const outcomes: Outcome[] = [];
      for (const o of t.body.outcomes ?? []) {
        if (o.status === "proposed" && o.proposalId !== undefined) {
          if (!state.has(o.proposalId)) { const p = await this.getProposal(token, o.proposalId).catch(() => undefined); state.set(o.proposalId, p === undefined ? "unknown" : p.status); }
          outcomes.push({ ...o, proposalState: state.get(o.proposalId) } as Outcome);
        } else outcomes.push(o);
      }
      turns.push({ turnId: t.id, messageId: t.body.messageId, text: t.body.text, status: t.body.status, createdAt: t.body.createdAt, ...(t.body.completedAt === undefined ? {} : { completedAt: t.body.completedAt }), reply: replyOf(outcomes).map((l) => (l.length > 2000 ? `${l.slice(0, 1997)}...` : l)), outcomes });
    }
    const last = page[page.length - 1];
    return { turns, ...(older.length > page.length && last !== undefined ? { next: `${last.body.createdAt}|${last.id}` } : {}), complete };
  }

  // ---- proposals -------------------------------------------------------------------------------------------------------------

  /** Saves steps as a proposal (the coordinator uses this for plans). Nothing is changed until `applyProposal`. */
  async propose(owner: Principal, input: { commandId: string; source: "chat" | "coordinator"; turnId?: string; reason: string; preview: readonly string[]; steps: readonly Omit<ChatStep, "commandId">[]; pins?: readonly ChatPin[]; notes?: readonly string[] }): Promise<{ id: string; replayed: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", "only the owner has proposals");
    const id = `prop-${hash(scopedCommandId(owner.id, input.commandId))}`;
    if (input.steps.length === 0 || input.steps.length > CHAT_LIMITS.steps) invalid("steps", `must be 1 to ${CHAT_LIMITS.steps} commands`);
    const steps = input.steps.map((s, i): ChatStep => ({ ...s, commandId: `${id}-s${i}` }));
    for (const step of steps) if (OPERATION_BY_NAME.get(step.op)?.kind !== "command") invalid("steps", `${step.op} is not a command of the state API`);
    if (input.preview.length > CHAT_LIMITS.summaryLines) invalid("preview", `at most ${CHAT_LIMITS.summaryLines} lines`);
    if (await this.#openCount(owner.id) >= CHAT_LIMITS.openProposals) throw new DomainError("unavailable", `${CHAT_LIMITS.openProposals} proposals are open already; apply or discard some`);
    const body: ChatProposalBody = { ownerId: owner.id, turnId: input.turnId ?? `direct-${id}`, source: input.source, status: "open", reason: input.reason, preview: [...input.preview], steps, pins: [...(input.pins ?? [])], notes: [...(input.notes ?? [])], createdAt: this.#runner.now() };
    const result = await this.#runner.command("chat.propose", { commandId: scopedCommandId(owner.id, input.commandId), actor: owner.id }, async () => ({
      payload: asJson({ id, steps, preview: input.preview, reason: input.reason }),
      build: async () => {
        const ref: AggregateRef = { kind: "chat-proposal", id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: asJson(body) }], detail: { turnId: body.turnId, steps: steps.map((s) => s.commandId) } };
      },
    }));
    return { id: result.id, replayed: result.replayed };
  }

  async getProposal(token: unknown, proposalId: string): Promise<(ChatProposalBody & { id: string; revision: number }) | undefined> {
    const owner = await this.#owner(token);
    const found = PROPOSAL_ID.test(proposalId) ? await this.#runner.get("chat-proposal", proposalId) : undefined;
    const body = found?.body as unknown as ChatProposalBody | undefined;
    return found === undefined || body === undefined || body.ownerId !== owner.id ? undefined : view<ChatProposalBody>(found);
  }

  /**
   * The explicit request that applies a proposal: its steps are sent to the state API in order, each under its fixed command ID and the credential it names. A proposal that was applied is
   * answered with its recorded results (`replayed`); one whose step is refused stays open, with the steps that did apply recorded by the API, and applying it again carries on.
   */
  async applyProposal(token: unknown, request: { commandId: string; proposalId: string }, options: CallOptions & ChatChannel = {}): Promise<ApplyResult> {
    const owner = await this.#owner(token);
    onlyKnown(request, ["commandId", "proposalId"]);
    const guard = guardOf(options);
    // A policy edit (a setting, the approval profile, a grant) is shown first with its own ID and applied by the policy service, exactly as the typed "apply it" does: the Apply button of a page reaches the same code (card U08).
    if (request.proposalId.startsWith("pedit-")) return endedOf(async () => { await guard?.(); return this.#applyEdit(owner, request.proposalId, request.commandId); });
    return endedOf(() => this.#apply(owner, token as string, request.proposalId, request.commandId, undefined, options.secrets !== false, guard));
  }

  async discardProposal(token: unknown, request: { commandId: string; proposalId: string }, options: CallOptions = {}): Promise<{ proposalId: string; replayed: boolean }> {
    const owner = await this.#owner(token);
    onlyKnown(request, ["commandId", "proposalId"]);
    const guard = guardOf(options);
    if (request.proposalId.startsWith("pedit-")) return endedOf(async () => { await guard?.(); const edits = this.#deps.policyEdits; if (edits === undefined) throw new DomainError("unavailable", "policy editing by chat is not set up here"); const done = await edits.discard(owner, { commandId: request.commandId, editId: request.proposalId }); return { proposalId: done.editId, replayed: done.replayed }; });
    return endedOf(async () => { await guard?.(); return this.#discard(owner, request.proposalId, request.commandId, undefined); });
  }

  // ---- per-project conversation context ----------------------------------------------------------------------------------------

  /** The owner's conversation context: the project in focus and, per project, what was last said and done there. Switching focus keeps every project's own thread. */
  async context(token: unknown): Promise<ContextBody> {
    const context = await this.#context((await this.#owner(token)).id);
    // What the stand-up (or anything else) put back on a turn is shown in the listing of turns. Read, never stored: the stored summary stays what it was when the turn was done.
    const ids = Object.entries(context.projects).sort((a, b) => (a[0] === context.focusProjectId ? -1 : b[0] === context.focusProjectId ? 1 : b[1].touchedAt.localeCompare(a[1].touchedAt))).slice(0, FOLLOW_UP_PROJECTS).map(([id]) => id);
    const projects = { ...context.projects };
    for (const id of ids) {
      const entry = projects[id]!;
      const turns = [];
      for (const t of entry.turns) {
        const body = await this.#turn(t.turnId).catch(() => undefined);
        const f = body?.followUps ?? [];
        turns.push(f.length === 0 ? t : { ...t, followUps: { kept: f.length, latest: f.slice(-FOLLOW_UP_SHOWN).map(({ text, at }) => ({ text, at })) } });
      }
      projects[id] = { ...entry, turns };
    }
    return { ...context, projects };
  }

  /** Changes the focus (the project later messages are about). It changes nothing about a task that is running or a proposal that was drawn up: those carry their own project. */
  async setFocus(token: unknown, request: { commandId: string; projectId: string }): Promise<void> {
    const owner = await this.#owner(token);
    onlyKnown(request, ["commandId", "projectId"]);
    const projectId = PROJECT_ID.test(request.projectId) ? request.projectId : invalid("projectId", "is not a project ID");
    if ((await this.#get(token as string, "project.get", { projectId })) === undefined) throw new DomainError("not_found", "no such project");
    await this.#updateContext(owner.id, scopedCommandId(owner.id, request.commandId), { focus: projectId }, (c, at) => ({ ...c, focusProjectId: projectId, projects: touch(c, projectId, at) }));
  }

  // ---- planning --------------------------------------------------------------------------------------------------------------

  async #interpret(input: Parameters<ChatInterpreter["interpret"]>[0]): Promise<{ unavailable: true } | { intents: Intent[] } | { intents?: undefined; problem: string }> {
    let raw: unknown;
    try { raw = await this.#deps.interpreter.interpret(input); } catch { return { unavailable: true }; }
    try { return { intents: checkIntents(raw) }; } catch (error) { return { problem: error instanceof DomainError ? error.message : "the interpretation was not usable" }; }
  }

  async #profile(owner: Principal): Promise<string> {
    try { return (await this.#deps.policy?.effective(owner))?.profile ?? "strict"; } catch { return "strict"; }
  }

  async #plan(owner: Principal, token: string, turnId: string, text: string, intents: Intent[], focus: { projectId?: string; projectName?: string }, focusProjectId: string | undefined, hasQuoted: boolean): Promise<{ items: PlanItem[]; projectId: string | undefined; held: { intent: Intent; text: string; from?: string }[] | undefined; resumes: string | undefined }> {
    if (intents.length === 0) return { items: [{ i: 0, kind: "asked", question: "I could not tell what you want done. Which project or task do you mean, and what should change?", options: [] }], projectId: focusProjectId, held: undefined, resumes: undefined };
    // Work to plan: each intent with the owner's words it was said in. An `answer` to an earlier question is replaced by that turn's held commands with the answer filled in.
    const work: { intent: Intent; text: string; trusted: boolean; quoted: boolean; from?: string }[] = [];
    let resumes: string | undefined;
    const early: PlanItem[] = [];
    for (const intent of intents) {
      if (intent.kind !== "answer") { work.push({ intent, text, trusted: false, quoted: hasQuoted }); continue; }
      // A reply of one word ("A", "finish") is no phrase, so the model's claim of what was chosen cannot be checked against it. It counts only when it is the owner's whole message and, read against the recorded question, names exactly one recorded answer, and that is the answer the model reported.
      const oneWord = intent.basis !== "quoted" && evidenceInText(intent.evidence, text) && !evidenceStrong(intent.evidence) && evidenceWholeMessage(intent.evidence, text) && intent.choice === await this.#choiceSaid(owner, intent.turnId, text);
      if (intent.basis === "quoted" || !evidenceInText(intent.evidence, text) || (!evidenceStrong(intent.evidence) && !oneWord)) { early.push({ i: work.length + early.length, kind: "refused", code: "untrusted_authority", message: "That answer is not in your own words." }); continue; }
      const expanded = await this.#expandAnswer(owner, intent.turnId, intent.choice);
      if ("refuse" in expanded) { early.push({ i: work.length + early.length, kind: "refused", code: "not_resumable", message: expanded.refuse }); continue; }
      resumes = intent.turnId;
      for (const w of expanded.work) work.push({ ...w, trusted: true, quoted: expanded.quoted || hasQuoted });
    }
    const items: PlanItem[] = [...early];
    const workOf: number[] = early.map(() => -1);
    let projectId = focusProjectId;
    let currentFocus = focus;
    const profile = await this.#profile(owner);
    // Several commands in one message that change the same record: each write moves its revision on by one, so a later command expects the revision the earlier ones will have left.
    const pending = new Map<string, number>();
    const answeredHere = new Set<string>();
    let coordinatorRevision: number | undefined;
    let openForAnswer: { id: string; summary: string[] }[] | undefined;
    let editsUnread = false;
    for (const [n, { intent, text: words, trusted, quoted, from }] of work.entries()) {
      const i = items.length;
      const push = (item: PlanItem): void => { items.push(item); workOf.push(n); };
      if (intent.kind === "clarify") { push({ i, kind: "asked", question: intent.question, options: intent.options ?? [] }); continue; }
      if (intent.kind === "none") { push({ i, kind: "ignored", reason: intent.reason }); continue; }
      if (intent.kind === "answer") { push({ i, kind: "refused", code: "not_resumable", message: "an answer cannot be held" }); continue; }
      // A message that is only "yes" (or only "no") agrees to (or drops) a proposal shown to the owner: the guide says to say yes in any words, and such a message is the owner's whole own text.
      const wholeAnswer = (intent.kind === "apply_proposal" || intent.kind === "discard_proposal") && evidenceWholeMessage(intent.evidence, words);
      if (!trusted && (intent.basis === "quoted" || !evidenceInText(intent.evidence, words) || (!evidenceStrong(intent.evidence) && !wholeAnswer))) {
        push({ i, kind: "refused", code: "untrusted_authority", message: intent.basis === "quoted" ? "That instruction came from quoted text, which cannot ask for anything; only your own message can ask for something." : "The words this was based on are not a phrase of your own message, so it was not done." });
        continue;
      }
      if (intent.kind === "switch_focus") {
        const found = await this.#projectByIntent(token, intent.projectId, intent.projectName);
        if (found.ok) { currentFocus = { projectId: found.id, projectName: found.name }; projectId = found.id; push({ i, kind: "focus", projectId: found.id, preview: `Focus on project ${quotedText(found.name, CHAT_LIMITS.line)}` }); }
        else push(askOrRefuse(i, found, n));
        continue;
      }
      if (intent.kind === "apply_proposal" || intent.kind === "discard_proposal") {
        // A message that is only "yes" or "no" names no proposal: it counts only while exactly one is open. With several open the model's pick would be a guess, so the owner is asked which.
        if (!trusted) {
          // A message that is only a word of refusal ("no") never agrees to a proposal, and one that is only a word of agreement ("yes") never drops one, whatever the model made of it: the chat reads that one word itself.
          const sole = evidenceStrong(intent.evidence) ? "" : tidyWords(words);
          if ((intent.kind === "apply_proposal" ? REFUSAL : ASSENT).has(sole)) {
            push({ i, kind: "asked", question: `Your message was only ${quotedText(sole, 20)}, which does not ${intent.kind === "apply_proposal" ? "agree to the proposal, so it was not applied" : "drop the proposal, so it was kept"}. Nothing was done. What would you like: go ahead with it, or drop it?`, options: [] });
            continue;
          }
          // A list of policy edits that cannot be read is not taken as none open: the owner is asked (fail closed).
          if (openForAnswer === undefined) { const edits = await this.#openEdits(owner, true); editsUnread = edits === undefined; openForAnswer = [...(await this.#openProposals(owner.id, OPEN_SCAN)), ...(edits ?? [])]; }
          if (editsUnread && !intent.evidence.toLowerCase().includes(intent.proposalId.toLowerCase())) {
            push({ i, kind: "asked", question: "Your open policy edits could not be read just now, so I cannot tell which proposals are open. Nothing was done. Say it again with the proposal's ID, or try again in a moment.", options: openForAnswer.slice(0, CHAT_LIMITS.options).map((p) => `${p.id}: ${quotedText(p.summary[0] ?? "", 80)}`) });
            continue;
          }
          const targeted = new Set(work.flatMap((w) => (w.intent.kind === "apply_proposal" || w.intent.kind === "discard_proposal" ? [w.intent.proposalId] : [])));
          if (!editsUnread && openForAnswer.length > 1 && !namesOneProposal(intent.evidence, words, intent.proposalId, openForAnswer, targeted)) {
            push({ i, kind: "asked", question: `More than one proposal is open, and ${evidenceStrong(intent.evidence) ? "your words" : `a message that is only "${intent.kind === "apply_proposal" ? "yes" : "no"}"`} do${evidenceStrong(intent.evidence) ? "" : "es"} not say which. Nothing was done. Which one do you mean? Say it in a few words or by its ID (or drop the ones you no longer want).`, options: openForAnswer.slice(0, CHAT_LIMITS.options).map((p) => `${p.id}: ${quotedText(p.summary[0] ?? "", 80)}`) });
            continue;
          }
        }
        push({ i, kind: intent.kind, proposalId: intent.proposalId, ...(intent.kind === "apply_proposal" && intent.lengthDays !== undefined && lengthInWords(intent.lengthDays, words) ? { lengthDays: intent.lengthDays } : {}) });
        continue;
      }
      if (intent.kind === "policy_edit") {
        if (this.#deps.policyEdits === undefined) { push({ i, kind: "refused", code: "unavailable", message: "Policy editing by chat is not set up here." }); continue; }
        const prepared = await this.#deps.policyEdits.prepare(owner, { change: intent.change, conditions: intent.conditions ?? [], evidence: intent.evidence, wording: words, ...(currentFocus.projectId === undefined ? {} : { focusProjectId: currentFocus.projectId }), quoted, forwarded: false });
        if (!prepared.ok) { push(prepared.kind === "ask" ? { i, kind: "asked", question: prepared.question, options: prepared.options } : { i, kind: "refused", code: prepared.code, message: prepared.message }); continue; }
        push({ i, kind: "policy", editId: this.#deps.policyEdits.idFor(owner.id, `${turnId}-e${i}`), draft: prepared.draft, preview: prepared.draft.summary });
        continue;
      }
      if (intent.kind === "status") {
        // A read: it changes nothing, so quoted material cannot make it do harm, but it still needs the owner's own words like everything else. The view that needs a project gets the one in focus.
        const request: Record<string, unknown> = { ...intent.request };
        if (request["projectId"] === undefined && ["changes", "delivered", "noticeboard", "agenda", "meetings", "standups", "standup_questions", "timeline", "wip_backup", "docs", "qa_project", "submissions_project", "defect_risks", "landing_queue", "landing_settings", "observations", "lessons", "experiments"].includes(String(request["kind"]))) {
          if (currentFocus.projectId === undefined) { push({ i, kind: "refused", code: "invalid_command", message: "Which project do you mean?" }); continue; }
          request["projectId"] = currentFocus.projectId;
        }
        // A stop's cost for an agent, a team or the whole installation named in the owner's own words (card L02e leftover): the installation's
        // agents and teams are read from the records and the one whose name stands as a whole word of the owner's message is meant - a name inside
        // a bigger word names nothing. Nothing is invented: one answer decides, several ask which, none says what is not called that; an ID the
        // owner gave is used as given, and the words are the chat's own field, never sent to the status service (which takes IDs and refuses an unknown key).
        if ((request["kind"] === "stop_cleanup" || request["kind"] === "lifecycle")) {
          // An ID the owner wrote decides, and nothing here overwrites it: words beside it are dropped, as a task title beside an ID is. An ID only the interpreter
          // offered beside a name does not outweigh the owner's words: it is dropped and the name is looked up in what the owner said. The status service takes IDs only, so the words never leave the chat.
          // (The interpreter speaks the flat form only; the nested `scope` is the API's and comes as it came.)
          const offeredId = request["scopeId"];
          const hasName = typeof request["scopeName"] === "string" && (request["scopeName"] as string).trim() !== "";
          if (offeredId !== undefined && request["scope"] === undefined && hasName && !(typeof offeredId === "string" && wholeWord(words, offeredId))) delete request["scopeId"];
          const declared = request["scopeKind"];
          const bare = request["scope"] === undefined && request["scopeId"] === undefined;
          const given = bare && hasName ? (request["scopeName"] as string).trim() : "";
          const named = given === "" ? undefined : given;
          if (declared === "installation" && bare) request["scopeId"] = "installation"; // the whole installation has the one ID: nothing to look up, nothing to choose
          else if (named !== undefined && declared !== undefined && declared !== "agent" && declared !== "team" && declared !== "task") {
            push({ i, kind: "refused", code: "invalid_command", message: `a stop is read for a task, an agent, a team or the whole installation, not for ${quotedText(String(declared), 40)}. Which did you mean?` });
            continue;
          } else if ((named !== undefined && declared === undefined) || (bare && (declared === "agent" || declared === "team"))) {
            const what = declared === undefined ? "agent or team" : declared;
            const plural = declared === undefined ? "agents or teams" : `${declared}s`;
            // With no kind said the message is read against both lists; only a name standing as a whole word of the owner's message counts, whatever the interpreter offered for it.
            const { items: all, complete } = await this.#scopeCandidates(token, declared === undefined ? ["agent", "team"] : [declared]);
            let found = namesMeant(words, all);
            // Among the names the owner did write, the one the interpreter read as the name (when it is one of them) is meant: an agent called "the" beside the Alpha team the owner named is not.
            if (named !== undefined && found.length > 1) { const same = found.filter((c) => sameName(c.name, named)); if (same.length > 0) found = same; }
            const calledThat = named === undefined ? "by a name in your message" : quotedText(named, 80);
            if (found.length === 0) {
              push({ i, kind: "refused", code: "not_found", message: !complete ? `no ${what} among the first ${String(all.length)} ${plural} of this installation is called ${calledThat}, and there are more than one look covers. Which did you mean? Give its ID to read it.`
                : all.length === 0 ? `no ${what} of this installation is called ${calledThat} and this installation has no ${plural} at all. Did you mean a task or the whole installation?`
                : `no ${what} of this installation is called ${calledThat}. Here they are: ${titleList(all.map((c) => c.name))}. Which did you mean?` });
              continue;
            }
            if (found.length > 1) { push({ i, kind: "asked", question: `More than one ${what} here answers to the name in your message${found.length > CHAT_LIMITS.options ? ` (${String(found.length)} of them; the first ${String(CHAT_LIMITS.options)} are shown)` : ""}. Which did you mean?`, options: found.slice(0, CHAT_LIMITS.options).map((f) => `${f.id}: ${quotedText(f.name, 60)} (${f.kind})`) }); continue; }
            request["scopeKind"] = found[0]!.kind;
            request["scopeId"] = found[0]!.id;
          } else if (declared === "task" && bare) {
            // A task is read by its title, not by a flat scope: the words (when there are none already) become the task title the block below answers for the project in focus.
            if (named !== undefined && request["taskTitle"] === undefined && request["taskId"] === undefined) request["taskTitle"] = named;
            delete request["scopeKind"];
          }
          delete request["scopeName"]; // never sent on: the status service refuses a key it does not know
        }
        // A task's activity, explanations, replay, hand-off, work report (card W10) or stop cleanup is asked for by the task's title (the project in focus); a title that fits more than one task asks nothing and says so.
        // A title beside an ID, or one that is not text, is dropped: the ID (or the missing task) decides. A stop-cleanup question that names a scope has no use for a title either, so the title goes.
        if ((request["kind"] === "stop_cleanup" || request["kind"] === "lifecycle") && (request["scope"] !== undefined || request["scopeKind"] !== undefined)) delete request["taskTitle"];
        if ((request["kind"] === "activity" || request["kind"] === "explanations" || request["kind"] === "replay" || request["kind"] === "thinking" || request["kind"] === "handoff" || request["kind"] === "handoff_archive" || request["kind"] === "start_size" || request["kind"] === "work_report" || request["kind"] === "defects" || request["kind"] === "qa" || request["kind"] === "task_docs" || request["kind"] === "submissions" || request["kind"] === "attempt_endings" || request["kind"] === "command_state" || ((request["kind"] === "stop_cleanup" || request["kind"] === "lifecycle") && request["scope"] === undefined && request["scopeKind"] === undefined)) && (request["taskId"] !== undefined || typeof request["taskTitle"] !== "string")) delete request["taskTitle"];
        if ((request["kind"] === "activity" || request["kind"] === "explanations" || request["kind"] === "replay" || request["kind"] === "thinking" || request["kind"] === "handoff" || request["kind"] === "handoff_archive" || request["kind"] === "start_size" || request["kind"] === "work_report" || request["kind"] === "defects" || request["kind"] === "qa" || request["kind"] === "task_docs" || request["kind"] === "submissions" || request["kind"] === "attempt_endings" || request["kind"] === "command_state" || ((request["kind"] === "stop_cleanup" || request["kind"] === "lifecycle") && request["scope"] === undefined && request["scopeKind"] === undefined)) && request["taskId"] === undefined && typeof request["taskTitle"] === "string") {
          if (currentFocus.projectId === undefined) { push({ i, kind: "refused", code: "invalid_command", message: "Which project do you mean?" }); continue; }
          const wanted = request["taskTitle"];
          const { exact, partial } = await this.#taskCandidates(token, currentFocus.projectId, wanted);
          // One exact match decides. Several, or only partial matches, are listed and the owner is asked; nothing is read until the owner says which.
          const candidates = exact.length > 0 ? exact : partial;
          if (candidates.length === 0) { push({ i, kind: "refused", code: "not_found", message: `no task called ${quotedText(wanted, 80)} in that project` }); continue; }
          if (exact.length !== 1) {
            push({ i, kind: "asked", question: exact.length > 1 ? `More than one task is called ${quotedText(wanted, 80)}. Which one?` : `No task is called ${quotedText(wanted, 80)}, but ${candidates.length === 1 ? "one task fits" : "these tasks fit"}. Which one do you mean?`, options: candidates.slice(0, CHAT_LIMITS.options).map((m) => `${m.id}: ${quotedText(m.title, 80)} (${m.state})`) });
            continue;
          }
          const matches = exact;
          request["taskId"] = matches[0]!.id;
          delete request["taskTitle"];
        }
        // An agent's environment, or its change requests, asked for by the agent's name in the owner's words: the name is looked up in the active agents (exact, then loose); unclear asks.
        if (request["kind"] === "environment" || request["kind"] === "maintenance" || request["kind"] === "access") {
          const agentName = request["agentName"];
          delete request["agentName"];
          if (agentName !== undefined && typeof agentName !== "string") { push({ i, kind: "refused", code: "invalid_command", message: "agentName must be the agent's name as the owner said it" }); continue; }
          if (request["agent"] === undefined && typeof agentName === "string" && agentName.trim() !== "") {
            const agents = await this.#listAll(token, "agent.list", { state: "active" });
            const wanted = agentName.trim().toLowerCase();
            const exact = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === wanted);
            const found = exact.length > 0 ? exact : agents.filter((a) => looseMatch(wanted, String(a["friendlyName"])));
            if (found.length === 0) { push({ i, kind: "refused", code: "not_found", message: `no active agent is called ${quotedText(agentName.trim(), 80)}` }); continue; }
            if (found.length > 1) { push({ i, kind: "asked", question: "Which agent do you mean?", options: found.slice(0, CHAT_LIMITS.options).map((a) => String(a["friendlyName"]).slice(0, 60)) }); continue; }
            request["agent"] = String(found[0]!["principalId"]);
          }
          if ((request["kind"] === "environment" || request["kind"] === "access") && request["agent"] === undefined) { push({ i, kind: "asked", question: request["kind"] === "access" ? "Which agent's access do you want to see?" : "Which agent's environment do you want to see?", options: [] }); continue; }
        }
        // A stand-up's briefs asked for by the stand-up's and the agent's names in the owner's words: the stand-up is the one whose title fits (else the next one coming up, else the latest), the agent the one named. Unclear asks.
        if (request["kind"] === "standup_briefs") {
          const topic = request["meetingTopic"];
          const agentName = request["agentName"];
          delete request["meetingTopic"];
          delete request["agentName"];
          if ((topic !== undefined && typeof topic !== "string") || (agentName !== undefined && typeof agentName !== "string")) { push({ i, kind: "refused", code: "invalid_command", message: "meetingTopic and agentName must be text" }); continue; }
          if (request["occurrenceId"] === undefined) {
            if (currentFocus.projectId === undefined) { push({ i, kind: "refused", code: "invalid_command", message: "Which project do you mean?" }); continue; }
            const recent = await this.#get(token, "standup.recent", { projectId: currentFocus.projectId, limit: 50 });
            const all = (recent?.["items"] as Record<string, unknown>[] | undefined) ?? [];
            const words = typeof topic === "string" ? topic : "";
            // A meeting is named by its own title or by the title its stand-up has now (a stand-up renamed after its meeting was made is still that stand-up).
            const setUp = await this.#standups(token, currentFocus.projectId);
            const titles = setUp.titles;
            const matches = meetingsNamed(words, all, setUp.titleOf);
            if (matches.length === 0) {
              // The project's stand-ups are read from the schedules, so a stand-up that has not met yet is answered about itself rather than called a name that fits nothing (card M03h).
              const named = titles.filter((t) => looseMatch(words, t));
              if (named.length > 0) { push({ i, kind: "refused", code: "not_found", message: named.length === 1 ? `${quotedText(named[0]!, 60)} has no stand-up meeting yet, so nothing has been briefed for it` : `more than one stand-up of that project has no meeting yet: ${titleList(named)}` }); continue; }
              if (titles.length === 0) { push({ i, kind: "refused", code: "not_found", message: "there is no stand-up in that project" }); continue; }
              push({ i, kind: "refused", code: "not_found", message: `no stand-up in that project is called ${quotedText(words, 80)}. It has ${titleList(titles)}.` }); continue;
            }
            const coming = matches.filter((m) => m["state"] === "planned").sort((a, b) => (String(a["startsAt"]) < String(b["startsAt"]) ? -1 : 1));
            // Words that fit several stand-ups ask; with no words, the next one coming up is meant.
            // Several stand-ups are told apart by their schedules, not their titles: two stand-ups can carry the same title (one renamed to what another's meeting is still called).
            if (words.trim() !== "" && new Set(matches.map((m) => String(m["scheduleId"] ?? m["title"]))).size > 1) { push({ i, kind: "asked", question: "Which stand-up do you mean?", options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${quotedText(shownTitle(m, setUp.titleOf), 60)}, ${String(m["startsAt"])}`) }); continue; }
            request["occurrenceId"] = String((coming[0] ?? matches[0])!["occurrenceId"]);
          }
          if (request["agent"] === undefined && typeof agentName === "string" && agentName.trim() !== "") {
            const agents = await this.#listAll(token, "agent.list", { state: "active" });
            const wanted = agentName.trim().toLowerCase();
            const exact = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === wanted);
            const found = exact.length > 0 ? exact : agents.filter((a) => looseMatch(wanted, String(a["friendlyName"])));
            if (found.length === 0) { push({ i, kind: "refused", code: "not_found", message: `no active agent is called ${quotedText(agentName.trim(), 80)}` }); continue; }
            if (found.length > 1) { push({ i, kind: "asked", question: "Which agent do you mean?", options: found.slice(0, CHAT_LIMITS.options).map((a) => String(a["friendlyName"]).slice(0, 60)) }); continue; }
            request["agent"] = String(found[0]!["principalId"]);
          }
        }
        // Where a motion's procedure stands, and what a meeting waits on, asked for in the owner's words: the motion or meeting is the one the words fit among those the owner may act on; several ask, none says so. A read is answered at once.
        if (request["kind"] === "meeting_procedure" || request["kind"] === "meeting_waiting") {
          const forMotion = request["kind"] === "meeting_procedure";
          const wordsKey = forMotion ? "motionTopic" : "meetingTopic";
          const idKey = forMotion ? "motionId" : "recordId";
          const topic = request[wordsKey];
          delete request[wordsKey];
          if (topic !== undefined && typeof topic !== "string") { push({ i, kind: "refused", code: "invalid_command", message: `${wordsKey} must be text` }); continue; }
          if (typeof request[idKey] !== "string") {
            const listed = await this.#get(token, "meeting.owner-controls", {});
            const meetings = (listed?.["meetings"] as { id: string; projectId: string; title: string; motions: { id: string; number: number; text: string; topic?: string; state: string }[] }[] | undefined) ?? [];
            const here = currentFocus.projectId === undefined ? meetings : meetings.filter((m) => m.projectId === currentFocus.projectId);
            const all = forMotion ? here.flatMap((m) => m.motions.map((x) => ({ id: x.id, text: `${x.text} ${x.topic ?? ""} ${m.title}`, label: `motion ${x.number} in ${m.title.slice(0, 40)}: ${x.text.slice(0, 60)}` }))) : here.map((m) => ({ id: m.id, text: m.title, label: m.title.slice(0, 80) }));
            const typed = typeof topic === "string" ? topic : "";
            let matches = typed.trim() === "" ? all : all.filter((c) => decisionWordsMatch(typed, c.text, true));
            if (matches.length === 0) matches = all.filter((c) => decisionWordsMatch(typed, c.text, false));
            if (matches.length === 0) { push({ i, kind: "refused", code: "not_found", message: all.length === 0 ? `there is no ${forMotion ? "motion" : "open meeting"} you can ask about` : `no ${forMotion ? "motion" : "meeting"} is about ${quotedText(typed, 80)}` }); continue; }
            if (matches.length > 1) { push({ i, kind: "asked", question: `Which ${forMotion ? "motion" : "meeting"} do you mean?`, options: matches.slice(0, CHAT_LIMITS.options).map((c) => c.label) }); continue; }
            request[idKey] = matches[0]!.id;
          }
        }
        if (!isObject(request) || hasRefMarker(request)) { push({ i, kind: "refused", code: "invalid_command", message: "that question is not understood" }); continue; }
        push({ i, kind: "status", request: asJson(request) });
        continue;
      }
      if (intent.kind === "coordinator") {
        // What is said to the coordinator is the owner's own: its texts must be in the message, like any command's. The project is the one named or in focus.
        const texts = { ...(intent.question === undefined ? {} : { question: intent.question }), ...(intent.outcome === undefined ? {} : { outcome: intent.outcome }), ...(intent.principalId === undefined ? {} : { principalId: intent.principalId }), ...(intent.agentName === undefined ? {} : { agentName: intent.agentName }), ...(intent.routes === undefined ? {} : { routes: [...intent.routes] }) };
        const foreign = foreignValue(texts, words);
        if (foreign !== undefined) { push({ i, kind: "refused", code: "unsupported_value", message: `What was given for ${quotedText(foreign, 60)} is not in your message, so it was not done. What did you mean instead?` }); continue; }
        let target: string | undefined;
        if (intent.action === "answer" || intent.action === "decompose" || intent.action === "assign") {
          const found = intent.projectId === undefined && intent.projectName === undefined ? (currentFocus.projectId === undefined ? undefined : { ok: true as const, id: currentFocus.projectId, name: currentFocus.projectName ?? "" }) : await this.#projectByIntent(token, intent.projectId, intent.projectName);
          if (found === undefined) { const ask = await this.#askProject(); push(ask.ok ? { i, kind: "refused", code: "invalid_command", message: "Which project do you mean?" } : askOrRefuse(i, ask, n)); continue; }
          if (!found.ok) { push(askOrRefuse(i, found, n)); continue; }
          target = found.id;
          projectId = found.id;
        }
        // The agent that is to be the coordinator, named in the owner's own words: looked up among the active agents (card U03c), and asked about when several fit. Its principal is what the coordinator is set up with.
        let principalId = intent.principalId;
        if (intent.action === "configure" && intent.agentName !== undefined) {
          const agents = await this.#listAll(token, "agent.list", { state: "active" });
          const wanted = intent.agentName.trim().toLowerCase();
          const exact = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === wanted);
          const found = exact.length > 0 ? exact : agents.filter((a) => looseMatch(wanted, String(a["friendlyName"])));
          if (found.length === 0) { push({ i, kind: "refused", code: "not_found", message: `no active agent is called ${quotedText(intent.agentName.trim(), 80)}` }); continue; }
          if (found.length > 1) { push({ i, kind: "asked", question: "Which agent do you mean?", options: found.slice(0, CHAT_LIMITS.options).map((a) => String(a["friendlyName"]).slice(0, 60)) }); continue; }
          principalId = String(found[0]!["principalId"]);
        }
        // The coordinator record's revision is read once, here, and counted for each earlier change to it in this message; a retry of the turn then sends the very same order.
        let expectedRevision: number | undefined;
        if (intent.action === "configure" || intent.action === "start" || intent.action === "pause" || intent.action === "stop") {
          // The revision the record will have when this item runs: as it stands now, plus one for each change to it that an earlier item of this message makes (a configure that creates it makes revision 1).
          const now = coordinatorRevision ?? (await this.#deps.coordinator?.()?.get(owner))?.revision;
          if (now === undefined && intent.action !== "configure") { push({ i, kind: "refused", code: "not_found", message: "the coordinator is not set up yet" }); continue; }
          if (now !== undefined) expectedRevision = now;
          coordinatorRevision = (now ?? 0) + 1;
        }
        push({ i, kind: "coordinator", action: intent.action, ...(expectedRevision === undefined ? {} : { expectedRevision }), ...(target === undefined ? {} : { projectId: target }), ...(intent.question === undefined ? {} : { question: intent.question }), ...(intent.outcome === undefined ? {} : { outcome: intent.outcome }), ...(principalId === undefined ? {} : { principalId }), ...(intent.routes === undefined ? {} : { routes: intent.routes }) });
        continue;
      }
      // Every text in the command must be the owner's own words (or a record, or a fixed choice): a model cannot add content the owner never said. Left unchecked here: a right's `basis` (set by the chat), a gate's kind and topic (always shown first), a release digest, a restore or transfer `confirm` (refilled from a fresh plan), `runningCalls` of a revoke or the standing policy (a fixed choice, always shown first or asked about), and the `confirm` of a real retention run (refilled from a fresh preview, never the model's).
      if (hasRefMarker(intent.args)) { push({ i, kind: "refused", code: "invalid_command", message: "$ref is reserved for steps the controller builds" }); continue; }
      // The reason recorded with a right is the owner's message, set by the chat. A gate is always shown to the owner first, so its kind and its (fixed) topic need not be words of the message: the wording still must be.
      const unchecked = intent.op === "needs-you.answer" ? (typeof intent.args["answer"] === "string" && NEED_CHOICES.has(intent.args["answer"]) ? ["answer", "id"] : ["id"]) : intent.op === "release.activate" ? ["digest", "migrationPlan"] : intent.op === "release.window.set" ? ["digest", "date", "time", "timeZone"] : intent.op === "release.approve" ? ["expectedFailures", "acknowledgeFlaky"] : intent.op === "backup.restore.apply" || intent.op === "database.transfer.apply" || intent.op === "database.transfer.wipe" ? ["confirm"] : intent.op === "grant.create" ? ["basis"] : intent.op === "catalog.policy.change" ? ["runningCalls"] : intent.op === "catalog.revoke" ? ["runningCalls"] : intent.op === "retention.run" || intent.op === "retirement.agent" || intent.op === "retirement.project" ? ["confirm"] : intent.op === "decision.record" && intent.args["category"] === "gate" ? ["gate", "topic"] : [];
      const foreign = foreignValue(unchecked.length === 0 ? intent.args : Object.fromEntries(Object.entries(intent.args).filter(([k]) => !unchecked.includes(k))), words, "", intent.op.startsWith("release.") ? RELEASE_ID_KEYS : intent.op.startsWith("maintenance.") ? MAINTENANCE_ID_KEYS : undefined, intent.op === "meeting.record.owner-respond" ? OWNER_RESPOND_EXEMPT : MEETING_CONTROLS.has(intent.op) ? MEETING_CONTROL_EXEMPT : intent.op === "recovery.step" ? RECOVERY_STEP_EXEMPT : intent.op === "workspace.request" ? WORKSPACE_REQUEST_EXEMPT : intent.op.startsWith("simulation.") ? SIMULATION_EXEMPT : intent.op === "events.sources.define" || intent.op === "events.sources.remove" ? EVENT_SOURCE_EXEMPT : intent.op === "grant.create" ? GRANT_EXEMPT : intent.op === "generation.stream.change" ? STREAM_SWITCH_EXEMPT : intent.op === "context.route.change" ? ROUTE_SETTING_EXEMPT : intent.op.startsWith("defect.") ? DEFECT_EXEMPT : intent.op.startsWith("doc.") ? DOC_EXEMPT : Object.hasOwn(SETUP_EXEMPT, intent.op) ? SETUP_EXEMPT[intent.op] : undefined);
      if (foreign !== undefined) { push({ i, kind: "refused", code: "unsupported_value", message: foreign.startsWith("reassignResponsibilities") ? `What was given for ${quotedText(foreign, 60)} is not in your message, so it was not done. A hand-off moves responsibilities only by the IDs the hand-off package lists (the rsp- IDs): which of those did you mean?` : `What was given for ${quotedText(foreign, 60)} is not in your message, so it was not done. What did you mean instead?` }); continue; }
      // A probe's address is the reach the owner approves (card P04i): it must be written out whole in the owner's message, exactly as given; a part of a longer address or one in other letter case is not theirs.
      // An address the probe would refuse is refused here, before it is shown: the proposal then always shows the whole address, as it would be asked (second review).
      if (intent.op === "responsibility.probe.set" && typeof intent.args["url"] === "string") { const bad = probeUrlProblem(intent.args["url"]); if (bad !== undefined) { push({ i, kind: "refused", code: "invalid_command", message: `That address cannot be a health address, so the probe was not set: it ${bad}.` }); continue; } }
      if (intent.op === "responsibility.probe.set" && typeof intent.args["url"] === "string" && !addressWritten(words, intent.args["url"])) { push({ i, kind: "refused", code: "unsupported_value", message: "That address is not written out in your message exactly as it would be asked, so the probe was not set. Write the whole address, for example https://web.example.com/health." }); continue; }
      // How long running work may go on before a drain cancels it must be the owner's own number, never one the model chose (card R04c).
      if (intent.op === "routing.drain" && !durationInWords(intent.args["drainSeconds"] as number, words)) { push({ i, kind: "refused", code: "unsupported_value", message: "How long running work may go on is not in your message, so the drain was not started; the chat will not pick a time that could cancel work early. How long may it go on?" }); continue; }
      // Accepting a platform that passed only after earlier failures is never read out of the owner's wording and never taken from the interpreter (card X09b part 2 review, redone): the approval is drawn up as a
      // proposal that shows the exact earlier failures the gate lists, and the owner's confirmation of that shown proposal is the acceptance. No wording is a gate; the binding is the shown failures themselves.
      let command = intent;
      // Which machine, and which platform of it, a destructive release test may run on is the owner's choice: `os` and `arch` are fixed choices, so the words check lets them through and they are checked here
      // (card X09b part 2 review, item 3). The owner's own spelling counts (linux-x64, my mac, x86_64); a platform they ruled out ("linux x64, not the mac") and an ordinary word that merely spells one
      // ("its MAC address is on the sticker") name nothing (card X09b part 2 review 3, item D3). Naming no platform of a kind is a question, naming another one is refused, and naming two of the same kind
      // is refused too, because the chat cannot tell which one the machine is. Withdrawing a host (`active: false`) picks no platform for a machine — it takes one off the list — so it asks for neither
      // os nor arch, and the interpreter's os and arch are dropped from it unless the owner's own words name them (item D4): sent as they are they would rewrite the platform on the record.
      // A candidate's platforms decide what approval requires, and `os` and `arch` are fixed choices the words check lets through, so each platform the model lists must be one the owner's own words name
      // (any spelling: linux-x64, my mac, windows, aarch64). One the owner never named is refused rather than tested for (or silently left out): the owner is asked which platforms they meant.
      if (intent.op === "release.submit") {
        const m = intent.args["manifest"];
        const matrix = m !== null && typeof m === "object" && Array.isArray((m as Record<string, unknown>)["matrix"]) ? ((m as Record<string, unknown>)["matrix"] as unknown[]) : [];
        const stray = matrix.flatMap((c) => (["os", "arch"] as const).map((key) => ({ key, value: c !== null && typeof c === "object" ? (c as Record<string, unknown>)[key] : undefined }))).find((x) => typeof x.value === "string" && !saysPlatform(words, x.key, x.value));
        if (stray !== undefined) { push({ i, kind: "refused", code: "unsupported_value", message: `The ${stray.key} ${quotedText(String(stray.value), 30)} is not in your message, so the candidate was not drawn up. Which platforms (${platformChoices("os").join(", ")} on ${platformChoices("arch").join(", ")}) must it pass on?` }); continue; }
      }
      if (intent.op === "release.host") {
        const withdrawing = intent.args["active"] === false;
        const host = typeof intent.args["hostId"] === "string" ? quotedText(intent.args["hostId"] as string, 80) : "that host";
        const kinds = (["os", "arch"] as const)
          .map((key) => { const value = intent.args[key]; return typeof value === "string" ? { key, value, named: platformsNamed(words, key) } : undefined; })
          .filter((x): x is { key: "os" | "arch"; value: string; named: string[] } => x !== undefined);
        const off = kinds.filter(({ value, named }) => !(named.length === 1 && named[0] === value.trim().toLowerCase()));
        const gap = off.find((x) => !(withdrawing && x.named.length === 0));
        if (gap !== undefined) {
          const { key, value, named } = gap;
          if (named.length > 1) { push({ i, kind: "refused", code: "unsupported_value", message: `${key} is not settled by your message, so nothing was changed for ${host}. Your own words name ${named.map((v) => quotedText(v, 30)).join(" and ")}: which ${key} is ${host} authorized for (${platformChoices(key).join(", ")})?` }); continue; }
          if (named.length === 1) { push({ i, kind: "refused", code: "unsupported_value", message: `${key} is not in your message, so nothing was changed for ${host}. Your own words say ${key} ${quotedText(named[0]!, 30)}, not ${quotedText(value, 30)}. Which ${key} is ${host} authorized for (${platformChoices(key).join(", ")})?` }); continue; }
          push({ i, kind: "asked", intentIndex: n, field: key, choices: [...platformChoices(key)], options: [...platformChoices(key)], question: key === "os" ? `${host} is to be authorized for release tests, but your message does not say which platform it runs. Which one — ${platformChoices("os").join(", ")}?` : `${host} is to be authorized for release tests, but your message does not say which chip it has. Which one — ${platformChoices("arch").join(", ")}?` });
          continue;
        }
        // A withdrawal's own: a platform the owner did not say is dropped rather than asked for, because the machine is being taken off the list, not chosen for a platform (item D4).
        if (withdrawing && off.length > 0) {
          const args = { ...intent.args };
          for (const { key } of off) delete args[key];
          command = { ...intent, args };
        }
      }
      const resolved = await this.#resolve(token, command, currentFocus, pending, profile, words, quoted);
      if (!resolved.ok) { push(askOrRefuse(i, resolved, n)); continue; }
      // One message answers a waiting meeting decision once: a second answer to the same decision could only fail when confirmed.
      const answering = resolved.steps.find((st) => st.op === "meeting.record.owner-respond")?.args["decisionId"];
      if (typeof answering === "string") {
        if (answeredHere.has(answering)) { push({ i, kind: "refused", code: "invalid_command", message: "That meeting decision is already answered in this message, and a decision is answered once. Which answer did you mean? It needs a message of its own." }); continue; }
        answeredHere.add(answering);
      }
      projectId = resolved.projectId ?? projectId;
      // A captured topic is linked to this very turn (set here, after the interpreter's arguments were checked, so it cannot be named by anyone else).
      // An alternative to a meeting decision is the owner's own decision from the turn the words were said in (the same link as a decision stated in chat; after a question that is the turn before the answer), under a command ID of this turn.
      const steps = resolved.steps.map((st) => (st.op === "agenda.capture" || st.op === "decision.record" ? { ...st, args: { ...st.args, sourceTurnId: from ?? turnId } } : st.op === "meeting.record.owner-respond" && isObject(st.args["alternative"]) ? { ...st, args: { ...st.args, alternative: { ...(st.args["alternative"] as Record<string, unknown>), source: { channel: "chat", turnId: from ?? turnId }, commandId: `${turnId}-alt${i}` } } } : st));
      if (resolved.reason === undefined) {
        // An explicit order applies now, one API command per step (a first step such as setting the repository, then the order itself).
        const last = steps.length - 1;
        for (const [k, step] of steps.entries()) {
          const written = recordOf(step);
          const base = step.op === "decision.record" ? await this.#revisionFor(token, "decision", step.args, undefined, new Map()) : undefined;
          if (written !== undefined) pending.set(written, (pending.get(written) ?? 0) + 1);
          push({ i: items.length, kind: "apply", op: step.op, args: asJson(step.args), commandId: k === last ? `${turnId}-c${i}` : `${turnId}-c${i}-${k}`, preview: describe(step.op, step.args, resolved.labels), ...(base?.ok === true && base.value !== undefined ? { planBase: base.value } : {}) });
        }
      } else {
        // Words that are not a decision (a question, a hypothetical) are not offered for the owner to confirm: nothing would be recorded.
        const wordsOf = steps.find((st) => st.op === "decision.record")?.args["wording"];
        const notDecided = typeof wordsOf === "string" ? notADecisionIn(words, wordsOf) : undefined;
        if (notDecided !== undefined) { push({ i, kind: "ignored", reason: `Nothing was recorded: ${notDecided}` }); continue; }
        const proposalId = `prop-${hash(scopedCommandId(owner.id, `${turnId}-p${i}`))}`;
        push({ i, kind: "propose", proposalId, steps, pins: resolved.pins, preview: [...steps.map((st) => describe(st.op, st.args, resolved.labels)), ...(resolved.notes ?? [])], reason: resolved.reason });
      }
    }
    // One question holds the message: nothing that would change a record runs while something is unanswered. The held commands are kept, so the answer carries them on.
    if (items.some((it) => it.kind === "asked")) {
      const held = items.map((it): PlanItem => it.kind === "apply" ? { i: it.i, kind: "held", preview: it.preview } : it.kind === "propose" ? { i: it.i, kind: "held", preview: it.preview[0] ?? "" } : it.kind === "focus" || it.kind === "apply_proposal" || it.kind === "discard_proposal" || it.kind === "policy" || it.kind === "coordinator" ? { i: it.i, kind: "held", preview: it.kind === "focus" ? it.preview : it.kind === "policy" ? it.preview[0] ?? "policy change" : it.kind === "coordinator" ? `coordinator: ${it.action}` : it.kind } : it);
      // What was refused stays refused: it is kept as a no-op, so an answer cannot let it through. A model's own question cannot be answered by the owner's choice, so it is not resumable.
      const refusedWork = new Set(items.flatMap((it, k) => (it.kind === "refused" ? [workOf[k] as number] : [])));
      const resumable = !work.some((w) => w.intent.kind === "clarify") && early.length === 0;
      return { items: held, projectId, held: resumable ? work.map((w, n) => (refusedWork.has(n) ? { intent: { kind: "none", reason: "refused earlier" } as Intent, text: w.text } : { intent: w.intent, text: w.text, ...(w.from === undefined ? {} : { from: w.from }) })) : undefined, resumes };
    }
    return { items, projectId, held: undefined, resumes };
  }

  /** The commands an earlier, unanswered turn held, with the owner's answer filled in; or why they cannot be carried on. */
  async #expandAnswer(owner: Principal, turnId: string, choice: string): Promise<{ work: { intent: Intent; text: string; from: string }[]; quoted: boolean } | { refuse: string }> {
    const old = typeof turnId === "string" ? await this.#turn(turnId) : undefined;
    if (old === undefined || old.ownerId !== owner.id || old.held === undefined) return { refuse: "there is no unanswered question to carry on" };
    if (old.resumedBy !== undefined) return { refuse: "that question was already answered" };
    const asked = old.plan.find((it): it is Extract<PlanItem, { kind: "asked" }> => it.kind === "asked" && it.field !== undefined);
    if (asked === undefined || asked.intentIndex === undefined || asked.field === undefined || !(asked.choices ?? []).includes(choice)) return { refuse: "that is not one of the answers offered" };
    const work = old.held.map((h) => ({ ...h, from: h.from ?? turnId }));
    const target = work[asked.intentIndex];
    if (target === undefined || target.intent.kind !== "command") return { refuse: "the held command is gone" };
    const args: Record<string, unknown> = { ...target.intent.args };
    const titleKey = Object.entries(TITLE_KEYS).find(([, id]) => id === asked.field)?.[0];
    if (titleKey !== undefined) delete args[titleKey];
    if (asked.field === "projectId") delete args["projectName"];
    const nameKey = { scheduleId: "standupTitle", inquiryId: "questionTopic", questionId: "questionTopic", id: "itemTopic", occurrenceId: "meetingTopic", decisionId: "decisionTopic", motionId: "motionTopic", recordId: "meetingTopic", briefId: "agentName", watchedTaskId: "watchedTaskTitle" }[asked.field];
    if (nameKey !== undefined) delete args[nameKey];
    if (asked.field.startsWith("integration.")) {
      // An answer to one of the project-creation questions fills one field of the integration section (a number for the refresh rounds, a list for the checks); the choice is the owner's word, so it counts as said.
      const key = asked.field.slice("integration.".length);
      const value: unknown = key === "refreshRounds" && choice !== "default" ? Number(choice) : key === "requiredChecks" && choice !== "default" ? choice.split("+") : choice;
      args["integration"] = { ...((args["integration"] as Record<string, unknown> | undefined) ?? {}), [key]: value };
      work[asked.intentIndex] = { from: target.from, intent: { ...target.intent, args }, text: `${target.text}. ${choice}` };
      return { work, quoted: old.quotedCount > 0 };
    }
    args[asked.field] = choice;
    // The owner's pick among letting running calls finish, cancelling them and pausing their tasks is their word, as is the platform (or chip) they name for a host: it counts as said, like the project-creation answers.
    // A motion or meeting picked from the question of a meeting control (card M02h) is likewise the owner's own choice, and so is the stand-up question picked for an answer (card M03h).
    work[asked.intentIndex] = { from: target.from, intent: { ...target.intent, args }, text: asked.field === "runningCalls" || asked.field === "decisionId" || asked.field === "questionId" || asked.field === "motionId" || asked.field === "recordId" || asked.field === "os" || asked.field === "arch" ? `${target.text}. ${choice}` : target.text };
    return { work, quoted: old.quotedCount > 0 };
  }

  /** Turns one command intent into steps: checks the operation and its arguments, names things from records, fills in revisions, decides apply or propose. */
  /**
   * Finds what a meeting control acts on (card M02h). The model gives the owner's words (`motionTopic`, `meetingTopic` or `decisionTopic`); the candidates are the records the owner may act on (`meeting.owner-controls`) that the operation can
   * still do something to, narrowed to the project in focus. Every significant word must fit, else at least one; several fits ask which, none refuses. An ID the owner did not say or pick from the question is the model's own: with
   * several candidates the owner is asked. The version of the motion a vote is opened on is read here, never said. Returns a refusal or question, or nothing when `args` now holds what the operation takes.
   */
  async #resolveMeetingControl(token: string, op: string, args: Record<string, unknown>, labels: Record<string, string>, notes: string[], projectId: string | undefined, words: string): Promise<(Resolved & { ok: false }) | undefined> {
    const floor = FLOOR_CONTROLS.has(op);
    const ofMeeting = op === "meeting.record.finish" || op === "meeting.record.outcomes" || op === "meeting.proc.owner-message" || floor;
    const wholeMeeting = op === "meeting.record.finish" || op === "meeting.proc.owner-message" || floor;
    const proc = op === "meeting.proc.rule" || op === "meeting.proc.untable";
    const wordsKey = ofMeeting ? "meetingTopic" : op === "meeting.record.apply" ? "decisionTopic" : "motionTopic";
    const idKey = ofMeeting ? "recordId" : op === "meeting.record.apply" ? "decisionId" : "motionId";
    const named = args[wordsKey];
    delete args[wordsKey];
    if (named !== undefined && typeof named !== "string") return refuse("invalid_command", `${wordsKey} must be text`);
    if (named !== undefined && args[idKey] !== undefined) return refuse("invalid_command", `${idKey === "motionId" ? "the motion" : idKey === "recordId" ? "the meeting" : "the meeting decision"} is named twice over, as ${idKey} and as ${wordsKey}; which one is meant has to be settled.`);
    if (op === "meeting.record.finish" && args["interrupted"] !== undefined && typeof args["interrupted"] !== "boolean") return refuse("invalid_command", "interrupted must be true or false");
    delete args["expectedVersion"];
    // Handing outcomes back (card M05): the meetings found are those with outcomes still to go back; asking the owner is a plain yes or no, and only a deferred decision has something to ask about.
    const outcomes = op === "meeting.record.outcomes";
    if (outcomes && args["askOwner"] !== undefined && typeof args["askOwner"] !== "boolean") return refuse("invalid_command", "askOwner is true or false when asked by chat");
    const listed = await this.#get(token, outcomes ? "meeting.owner-outcomes" : proc ? "meeting.proc.owner-controls" : "meeting.owner-controls", {});
    const cut = listed?.["truncated"] === true;
    type Candidate = { id: string; projectId: string; text: string; label: string; version?: number };
    const meetings = (listed?.["meetings"] as { id: string; projectId: string; title: string; motions: { id: string; number: number; text: string; topic?: string; state: string; version: number; deferred?: boolean }[] }[] | undefined) ?? [];
    const unfinished = (listed?.["unfinished"] as { id: string; projectId: string; text: string; topic?: string; left: number; applying: number }[] | undefined) ?? [];
    // The states the operation acts on, as the records service checks them: a vote opens on a proposed motion, closes when open, and only a motion not yet put to a vote can be tabled.
    const states = op === "meeting.record.close-vote" ? ["voting"] : op === "meeting.proc.advance" ? ["proposed", "voting"] : ["proposed"];
    const procItems = (listed as { rulings?: { motionId: string; projectId: string; number: number; text: string; why: string }[]; tabled?: { motionId: string; projectId: string; number: number; text: string; reason: string }[] } | undefined) ?? {};
    const all: Candidate[] = proc
      ? (op === "meeting.proc.rule" ? (procItems.rulings ?? []).map((r) => ({ id: r.motionId, projectId: r.projectId, text: r.text, label: `motion ${r.number}: ${r.text.slice(0, 60)} (${r.why.slice(0, 80)})` })) : (procItems.tabled ?? []).map((r) => ({ id: r.motionId, projectId: r.projectId, text: `${r.text} ${r.reason}`, label: `tabled motion ${r.number}: ${r.text.slice(0, 60)}` })))
      : wholeMeeting || outcomes
      ? meetings.map((m) => ({ id: m.id, projectId: m.projectId, text: outcomes ? `${m.title} ${m.motions.map((x) => x.text).join(" ")}` : m.title, label: m.title.slice(0, 80) }))
      : op === "meeting.record.apply"
        ? unfinished.map((d) => ({ id: d.id, projectId: d.projectId, text: `${d.text} ${d.topic ?? ""}`, label: `${d.text.slice(0, 80)}; ${d.left} change${d.left === 1 ? "" : "s"} left to carry out` }))
        : meetings.flatMap((m) => m.motions.filter((x) => states.includes(x.state)).map((x) => ({ id: x.id, projectId: m.projectId, text: `${x.text} ${x.topic ?? ""} ${m.title}`, label: `motion ${x.number} in ${m.title.slice(0, 40)}: ${x.text.slice(0, 60)}`, version: x.version })));
    const what = op === "meeting.proc.rule" ? "motion whose vote waits for a ruling on an objection" : op === "meeting.proc.untable" ? "tabled motion" : outcomes ? "meeting with outcomes still to be handed back" : wholeMeeting ? "open meeting" : op === "meeting.record.apply" ? "meeting decision with changes left to carry out" : op === "meeting.record.open-vote" ? "motion waiting for a vote" : op === "meeting.record.close-vote" ? "motion with a vote open" : "motion not yet put to a vote";
    const candidates = projectId === undefined ? all : all.filter((c) => c.projectId === projectId);
    const tooMany = `More records exist than could be read at once, and the words do not say which one. Which ${what} is it?`;
    if (candidates.length === 0) return refuse("not_found", cut ? `More records exist than could be read at once, and none of those read is a ${what}; which one is meant cannot be told from the words.` : all.length > 0 ? `no ${what} in that project` : `there is no ${what}`);
    const names = new Map<string, string>();
    if (new Set(candidates.map((c) => c.projectId)).size > 1) for (const id of new Set(candidates.map((c) => c.projectId))) names.set(id, ((await this.#get(token, "project.get", { projectId: id }))?.["name"] as string | undefined)?.slice(0, 40) ?? id);
    const pick = (c: Candidate): string => `${c.id} (${c.label.slice(0, 80)}${names.has(c.projectId) ? `, in ${names.get(c.projectId)}` : ""})`;
    const ask = (list: Candidate[]): Resolved & { ok: false } => ({ ok: false, kind: "ask", question: `Which ${what} do you mean?`, options: list.slice(0, CHAT_LIMITS.options).map(pick), field: idKey, choices: list.slice(0, CHAT_LIMITS.options).map((c) => c.id) });
    let chosen: Candidate | undefined;
    if (typeof args[idKey] === "string") {
      chosen = candidates.find((c) => c.id === args[idKey]);
      if (chosen === undefined) return refuse("not_found", cut ? tooMany : `that is not a ${what}`);
      // An ID the owner did not say or pick from the question is the model's own: with several candidates the owner is asked.
      if (candidates.length > 1 && !words.includes(chosen.id)) return ask(candidates);
    } else {
      const typed = typeof named === "string" ? named : "";
      let matches = candidates.filter((c) => decisionWordsMatch(typed, c.text, true));
      if (matches.length === 0 && !wholeMeeting && op !== "meeting.record.apply" && !outcomes && !proc) {
        // Every word fits a motion in another state (its vote already open, or not open yet): that motion is the one meant, so a looser fit on some other motion is not taken in its place.
        const elsewhere = meetings.filter((m) => projectId === undefined || m.projectId === projectId).flatMap((m) => m.motions.filter((x) => !states.includes(x.state) && decisionWordsMatch(typed, `${x.text} ${x.topic ?? ""} ${m.title}`, true)));
        if (elsewhere.length > 0) return refuse("invalid_command", `${elsewhere.length === 1 ? `motion ${elsewhere[0]!.number} (${quotedText(elsewhere[0]!.text, 60)}) is` : "the motions those words fit are"} ${[...new Set(elsewhere.map((x) => x.state))].join(" or ")}, not a ${what}; nothing was proposed.`);
      }
      if (matches.length === 0) matches = candidates.filter((c) => decisionWordsMatch(typed, c.text, false));
      if (matches.length === 0) return refuse("not_found", cut ? tooMany : `no ${what} is about ${quotedText(typed, 80)}`);
      if (matches.length > 1) return ask(matches);
      chosen = matches[0]!;
      args[idKey] = chosen.id;
    }
    // Only part of the records was read: another that fits may be among the rest.
    if (cut) notes.push("Not everything you can act on in meetings could be read; check this is the one you mean.");
    labels[chosen.id] = chosen.label;
    if (outcomes && args["askOwner"] === true && !(meetings.find((m) => m.id === chosen!.id)?.motions ?? []).some((m) => m.deferred === true)) return refuse("invalid_command", "that meeting deferred nothing, so there is no question to ask you; the outcomes can be handed back without one.");
    if (op === "meeting.record.open-vote") args["expectedVersion"] = chosen.version;
    // Overruling a challenged chair question: the challenged questions of that meeting are read from its floor; the owner's words pick one, a single one is taken, several ask.
    if (op === "meeting.floor.cq-rule") {
      const state = await this.#get(token, "meeting.floor.state", { recordId: chosen.id });
      const asked = (((state?.["chairQuestions"]) ?? []) as { id: string; to: string; topic: string; challenge?: { by: string; reason: string; ruling?: string } }[]).filter((q) => q.challenge !== undefined && q.challenge.ruling === undefined);
      if (asked.length === 0) return refuse("not_found", "no chair question of that meeting is waiting for a ruling on a challenge");
      const label = (q: (typeof asked)[number]): string => `${q.id} (question to ${q.to} about ${q.topic.slice(0, 50)}; challenged by ${q.challenge!.by}: ${q.challenge!.reason.slice(0, 60)})`;
      let one = typeof args["questionId"] === "string" ? asked.find((q) => q.id === args["questionId"]) : undefined;
      if (typeof args["questionId"] === "string" && one === undefined) return refuse("not_found", "that chair question is not waiting for a ruling on a challenge");
      if (one !== undefined && asked.length > 1 && !words.includes(one.id)) one = undefined;
      if (one === undefined) {
        const fits = asked.filter((q) => decisionWordsMatch(words, `${q.topic} ${q.to} ${q.challenge!.reason}`, false));
        const pickFrom = asked.length === 1 ? asked : fits.length === 1 ? fits : asked;
        if (pickFrom.length > 1) return { ok: false, kind: "ask", question: "Which challenged chair question do you mean?", options: pickFrom.slice(0, CHAT_LIMITS.options).map(label), field: "questionId", choices: pickFrom.slice(0, CHAT_LIMITS.options).map((q) => q.id) };
        one = pickFrom[0]!;
      }
      args["questionId"] = one.id;
      labels[one.id] = `chair question to ${one.to} about ${one.topic.slice(0, 50)}`;
    }
    // The owner's own words are what is asked, said or ended with: the meeting's end is the reason they gave.
    if (op === "meeting.floor.end" && (typeof args["reason"] !== "string" || args["reason"].trim() === "")) args["reason"] = words.trim().slice(0, 400);
    // A motion is tabled for a reason: the owner's own words when they gave one, else their message.
    if (op === "meeting.record.table" && (typeof args["reason"] !== "string" || args["reason"].trim() === "")) args["reason"] = words.trim().slice(0, 500);
    if (op === "meeting.proc.rule" && args["ruling"] === "table" && (typeof args["reason"] !== "string" || args["reason"].trim() === "")) args["reason"] = words.trim().slice(0, 500);
    if (op === "meeting.proc.owner-message" && (typeof args["text"] !== "string" || args["text"].trim() === "")) return refuse("invalid_command", "say what the message to the meeting is");
    return undefined;
  }

  async #resolve(token: string, intent: Extract<Intent, { kind: "command" }>, focus: { projectId?: string; projectName?: string }, pending: ReadonlyMap<string, number>, profile: string, words: string, quoted: boolean): Promise<Resolved> {
    const spec = CHAT_OPS[intent.op];
    // Names that stand for the target of a move besides the labelled arguments, and a reason to show the command first that the resolution found.
    const extraTargets: string[] = [];
    let showFirst: string | undefined;
    const accepted = acceptedArgs(intent.op);
    if (spec === undefined || accepted === undefined) return refuse("not_a_chat_command", `${intent.op.slice(0, 60)} is not something that can be done by chat`);
    if (hasRefMarker(intent.args)) return refuse("invalid_command", "$ref is reserved for steps the controller builds");
    // Which conversation a topic came from is the controller's to say, never the interpreter's.
    if ((intent.op === "agenda.capture" || intent.op === "decision.record") && intent.args["sourceTurnId"] !== undefined) return refuse("invalid_command", "sourceTurnId is set by the controller");
    // The version a decision is based on is read from the records and the session label is the controller's: neither is the interpreter's to say.
    if (intent.op === "decision.record" && (intent.args["basedOn"] !== undefined || intent.args["session"] !== undefined)) return refuse("invalid_command", "basedOn and session are set by the controller");
    for (const key of Object.keys(intent.args)) if (!accepted.includes(key) && !(key === "repositoryId" && spec.dispatch === true)) return refuse("invalid_command", `${key} is not an argument of ${intent.op}`);
    const args: Record<string, unknown> = { ...intent.args };
    // Backup encryption takes only a switch and one of two scopes (card K01b3): any other value is refused before a proposal is made, so text the model put there (a passcode, say) is never stored or shown.
    if (intent.op === "backup.encryption.set" && ((args["enabled"] !== undefined && typeof args["enabled"] !== "boolean") || (args["scope"] !== undefined && args["scope"] !== "everything" && args["scope"] !== "secrets"))) return refuse("invalid_command", "backup encryption is set with enabled (true or false) and scope (everything or secrets) only");
    // The backup scope (card K01d) takes only whole numbers of days or null: anything else is refused before a proposal is made.
    if (intent.op === "backup.scope.set") for (const f of ["scratchDays", "transcriptDays", "logDays"]) { const v = args[f]; if (v !== undefined && v !== null && !(typeof v === "number" && Number.isSafeInteger(v))) return refuse("invalid_command", "the backup scope is set with scratchDays, transcriptDays and logDays: a whole number of days (7 to 3650) or null for off"); }
    // Backup targets and purges (card K01c): a credential is only ever the NAME of a stored secret, an address never carries a user name or password, and the purge takes names, never patterns: anything else is refused before a proposal is made, so text the model put there (a password, say) is never stored or shown.
    if (intent.op === "backup.target.add") {
      if (args["credential"] !== undefined && (typeof args["credential"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args["credential"]))) return refuse("invalid_command", "credential is the name of a stored secret (letters, digits, dots, dashes, underscores), never the secret itself");
      if (args["credential"] === "backup-signing-key") return refuse("invalid_command", "that is the backup-signing key, which never leaves this machine: name the credential of the off-machine store");
      if (typeof args["location"] === "string" && /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/.test(args["location"])) return refuse("invalid_command", "the address must not hold a user name or password: name a stored credential instead");
    }
    if (intent.op === "backup.purge" && ((args["confirm"] !== undefined && typeof args["confirm"] !== "boolean") || (args["dryRun"] !== undefined && typeof args["dryRun"] !== "boolean") || !Array.isArray(args["names"]) || (args["names"] as unknown[]).some((n) => typeof n !== "string"))) return refuse("invalid_command", "backup.purge takes the names of the backups (a list of names), and confirm or dryRun as true or false only");
    if (intent.op === "backup.signing.rotate" && args["revokePrevious"] !== undefined && typeof args["revokePrevious"] !== "boolean") return refuse("invalid_command", "revokePrevious is true or false");
    if (intent.op === "decision.record" && args["category"] === "gate") args["topic"] = GATE_TOPIC;
    // Cancelling a release test applies at once: it names an attempt ID the owner said, or a candidate (also in the owner's words) with exactly one test running.
    if (intent.op === "release.cancel") {
      const candidate = args["candidateId"];
      delete args["candidateId"];
      if (args["attemptId"] === undefined) {
        if (typeof candidate !== "string") return refuse("invalid_command", "Which release test should be cancelled? Nothing in your message names one: an attempt ID does, or the candidate when only one of its tests is running.");
        const found = await this.#deps.api.handle(token, { v: API_VERSION, op: "release.attempts", args: { candidateId: candidate } });
        if (!found.ok) return refuse(found.error.code, found.error.message);
        const open = ((found.result["attempts"] ?? []) as { id: string; state: string }[]).filter((a) => a.state === "issued");
        if (open.length !== 1) return refuse("invalid_command", open.length === 0 ? "no release test of that candidate is running" : `${open.length} release tests of that candidate are running, so which one to cancel is not settled — which of them, by its attempt ID?`);
        args["attemptId"] = open[0]!.id;
      }
    }
    // Activation names the digest from the staged record, never from the interpreter or the owner's words (the owner sees it in the preview and the controller binds the word to it).
    const fillNotes: string[] = [];
    // A maintenance window names the digest from the staged record too (card K07); its date, time and zone are the interpreter's reading of the owner's words, so the proposal shows them before anything is set.
    if (intent.op === "release.window.set") {
      delete args["digest"];
      let wanted = args["candidateId"];
      // No release named ("put the update on tonight at 2"): the one staged release that never ran here (not current, previous, last known good or in the activation history), is not quarantined and never failed to start is meant; with several, the owner is asked which.
      if (wanted === undefined) {
        const st = await this.#deps.api.handle(token, { v: API_VERSION, op: "release.status", args: {} });
        if (!st.ok) return refuse(st.error.code, st.error.message);
        const wl = await this.#deps.api.handle(token, { v: API_VERSION, op: "release.window.list", args: {} });
        if (!wl.ok) return refuse(wl.error.code, wl.error.message);
        const pick = pickWaitingRelease(st.result["item"] as ReleaseStatusForPick, ((wl.result["quarantined"] ?? []) as { candidateId: string }[]).map((q) => q.candidateId));
        if ("ask" in pick) return refuse("invalid_command", pick.ask);
        wanted = pick.id;
        args["candidateId"] = wanted;
        fillNotes.push(`Release ${wanted}: the one staged release waiting to be installed (you did not name one).`);
      }
      if (typeof wanted !== "string") return refuse("invalid_command", "Which staged release should the window activate? Nothing in your message names one.");
      const found = await this.#deps.api.handle(token, { v: API_VERSION, op: "release.verify", args: { releaseId: wanted } });
      if (!found.ok) return refuse(found.error.code, found.error.message);
      args["digest"] = String(found.result["digest"]);
      fillNotes.push(`Digest of the staged release, filled in from its record: ${String(found.result["digest"])}${found.result["ok"] === true ? "" : " (its files do not match this digest now; the window will fail its preparation)"}`);
      if (args["durationMinutes"] === undefined) return refuse("invalid_command", "How long should the maintenance window last (15 minutes to 24 hours)?");
      // Every number the window is set with is the owner's own (the texts are checked by `foreignValue`, numbers are not): the length said outright or as an end time after the start, and the
      // optional preparation lead, free space and health deadline only when the owner named them. A number found nowhere in the message is the model's, so it is asked for, never proposed.
      if (!windowLengthInWords(args["durationMinutes"] as number, args["time"], words)) return refuse("unsupported_value", "How long the maintenance window should last is not in your message, so nothing was proposed; the chat does not choose the length for you. How long should it last (15 minutes to 24 hours)?");
      if (args["prepareLeadMinutes"] !== undefined && !leadInWords(args["prepareLeadMinutes"] as number, words)) return refuse("unsupported_value", `How early preparation should start is not in your message, so nothing was proposed. How long before the opening should it start? Leave it unsaid and the default (${WINDOW_DEFAULTS.prepareLeadMinutes} minutes) applies.`);
      if (args["minFreeBytes"] !== undefined && !sizeInWords(args["minFreeBytes"] as number, words)) return refuse("unsupported_value", "How much free space the update needs is not in your message, so nothing was proposed. How much should be free? Leave it unsaid and the default (1 GiB) applies.");
      if (args["healthDeadlineSeconds"] !== undefined && !durationInWords(args["healthDeadlineSeconds"] as number, words)) return refuse("unsupported_value", "How long the new release has to show it started well is not in your message, so nothing was proposed. How long should it have? Leave it unsaid and the default (5 minutes) applies.");
      fillNotes.push(windowTimeNote(args));
    }
    // Cancelling a maintenance window without naming it ("cancel the maintenance window") means the one window that is open; there is at most one, and with none the owner is told so.
    if (intent.op === "release.window.cancel" && args["windowId"] === undefined) {
      const wl = await this.#deps.api.handle(token, { v: API_VERSION, op: "release.window.list", args: {} });
      if (!wl.ok) return refuse(wl.error.code, wl.error.message);
      const open = ((wl.result["windows"] ?? []) as { windowId: string; status: string }[]).filter((w) => w.status === "scheduled" || w.status === "prepared" || w.status === "activated");
      if (open.length !== 1) return refuse(open.length === 0 ? "not_found" : "invalid_command", open.length === 0 ? "No maintenance window is open, so there is nothing to cancel." : `${open.length} maintenance windows are open (${open.slice(0, 5).map((w) => w.windowId).join(", ")}): which one should be cancelled?`);
      args["windowId"] = open[0]!.windowId;
    }
    // Verifying a document by chat (card Q03b): "verify the user guide". The document change, the code and a release's version are records, so what the owner did not name is filled from the records the
    // `docs` view shows: the one document change of the project made since the flag (several: the owner is asked which; none: they are told the keeper must submit it first), per task the code the document
    // was flagged for (else the code it was last verified with), and the release's version. A document change the interpreter names must be one the view lists or one the owner wrote out.
    if (intent.op === "doc.obligation.verify" && typeof args["obligationId"] === "string") {
      const item = await this.#get(token, "doc.obligation.get", { id: args["obligationId"] });
      if (item === undefined) return refuse("not_found", "no such documentation obligation");
      const title = `${quotedText(String(item["title"]), 80)} (${args["obligationId"]})`;
      const flaggedAt = typeof item["flaggedAt"] === "string" ? item["flaggedAt"] : undefined;
      const since = flaggedAt === undefined ? "" : ` made since it was flagged at ${flaggedAt}`;
      if (item["state"] === "verified" && args["documentSubmissionId"] === undefined) return refuse("invalid_command", `${title} is already verified against tested code and nothing has flagged it since, so there is nothing to verify. To check it again, name the document change to verify it with.`);
      const listed = await this.#deps.api.handle(token, { v: API_VERSION, op: "submission.documents", args: { projectId: String(item["projectId"]), limit: DOC_CHOICES + 1, ...(flaggedAt === undefined ? {} : { since: flaggedAt }) } });
      if (!listed.ok) return refuse(listed.error.code, listed.error.message);
      const docs = (listed.result["items"] ?? []) as { id: string; taskId: string; submittedBy: string; createdAt: string; artifactDigest?: string }[];
      const shownDocs = docs.slice(0, DOC_CHOICES);
      const label = (x: (typeof docs)[number]): string => `${x.id}: task ${x.taskId}, by ${x.submittedBy}, at ${x.createdAt}, ${String(x.artifactDigest).slice(0, 19)}`;
      const given = args["documentSubmissionId"];
      if (given === undefined) {
        if (docs.length === 0) return refuse("not_found", `No document change of this project${since} can verify ${title}, so nothing was proposed. ${String(item["owner"])}, who keeps it, submits the updated document first (a document submission in the docs role); then ask again.`);
        if (docs.length > 1) return { ok: false, kind: "ask", question: `${docs.length > DOC_CHOICES ? `More than ${DOC_CHOICES}` : String(docs.length)} document changes of this project${since} could verify ${title}${docs.length > DOC_CHOICES ? " (the newest are shown)" : ""}. Which one is the updated document?`, options: shownDocs.map(label), field: "documentSubmissionId", choices: shownDocs.map((x) => x.id) };
        args["documentSubmissionId"] = docs[0]!.id;
        fillNotes.push(`Document change ${label(docs[0]!)}: the one document change of this project${since}.`);
      } else if (typeof given !== "string" || (!shownDocs.some((x) => x.id === given) && !wholeWord(words, given))) {
        return refuse("unsupported_value", `${typeof given === "string" ? quotedText(given, 40) : "That"} is not a document change the docs view lists for ${title}${shownDocs.length === 0 ? ` (it lists none${since})` : ` (it lists ${shownDocs.map((x) => x.id).join(", ")})`}, and your message does not name it, so nothing was proposed.`);
      }
      if (args["evidence"] === undefined) {
        const code = docVerifyCode(item as unknown as Parameters<typeof docVerifyCode>[0]);
        const refs = (Array.isArray(item["implementationRefs"]) ? item["implementationRefs"] : []) as string[];
        const missing = refs.filter((t) => code[t] === undefined);
        if (missing.length > 0) return refuse("invalid_command", `Which tested code should ${title} be verified against for ${missing.join(", ")}? Nothing in its record names code for ${missing.length === 1 ? "that task" : "those tasks"}; the qa view of a task lists its code submissions and whether their QA gate passes.`);
        args["evidence"] = refs.map((t) => code[t]!);
        fillNotes.push(`Checked against ${refs.map((t) => `code ${code[t]!} of ${t}`).join(", ")}: ${(item["reasons"] as unknown[] | undefined)?.length ? "the newest code it was flagged for, or the code it was last verified with" : "the code it was last verified with"}, from its record; the QA gate of each must pass when this is applied.`);
      }
      if (args["applicableVersion"] === undefined && typeof item["releaseVersion"] === "string") {
        args["applicableVersion"] = item["releaseVersion"];
        fillNotes.push(`For version ${quotedText(item["releaseVersion"], 40)}: the release that flagged it.`);
      }
    }
    // Retiring a document by chat (Q03 leftover, first review): the owner chose it by its title or place, so the proposal names it by them (not only by its ID) and says how many update tasks go with it;
    // one already retired is answered at once rather than proposed.
    if (intent.op === "doc.obligation.retire" && typeof args["obligationId"] === "string") {
      const item = await this.#get(token, "doc.obligation.get", { id: args["obligationId"] });
      if (item === undefined) return refuse("not_found", "no such documentation obligation");
      const title = `${quotedText(String(item["title"]), 80)} (${args["obligationId"]})`;
      if (item["retired"] !== undefined) return refuse("invalid_command", `${title} was already taken away, so nothing was proposed.`);
      const open = (Array.isArray(item["updates"]) ? (item["updates"] as { state?: unknown }[]) : []).filter((u) => u.state === "open").length;
      fillNotes.push(`Takes away ${title} at ${quotedText(String(item["location"]), 80)}, kept by ${String(item["owner"])}${open === 0 ? "; it has no open update task" : `; its ${open} open update task${open === 1 ? " is" : "s are"} cancelled unless already started`}.`);
    }
    if (intent.op === "release.activate") {
      delete args["digest"];
      delete args["migrationPlan"];
      const wanted = args["candidateId"];
      if (typeof wanted !== "string") return refuse("invalid_command", "Which staged release should be activated? Nothing in your message names one.");
      const found = await this.#deps.api.handle(token, { v: API_VERSION, op: "release.verify", args: { releaseId: wanted } });
      if (!found.ok) return refuse(found.error.code, found.error.message);
      const digest = String(found.result["digest"]);
      args["digest"] = digest;
      fillNotes.push(`Digest of the staged release, filled in from its record: ${digest}${found.result["ok"] === true ? "" : " (its files do not match this digest now; activation will refuse)"}`);
      // The migration plan the release carries is part of what is being approved (K02): its digest is read from the candidate's record and shown, never taken from the interpreter or the owner's words.
      if (typeof found.result["migrationPlan"] === "string") { args["migrationPlan"] = found.result["migrationPlan"]; fillNotes.push(`Digest of the migration plan this release carries, from its record: ${found.result["migrationPlan"]}`); }
      if (Array.isArray(found.result["targets"])) fillNotes.push(`This release is built for the installation(s): ${(found.result["targets"] as string[]).join(", ")}`);
      fillNotes.push(found.result["signedBy"] === null || found.result["signedBy"] === undefined ? "No trusted signature is on this release." : `Signed by trusted key ${String(found.result["signedBy"])}.`);
    }
    // An approval is shown with what the gate says just now, so a flaky candidate shows the owner which platform failed before it passed and exactly which attempts those failures were (card X09b part 2 review, redone):
    // their confirmation of that shown proposal is the acceptance — no scanning of their wording, and the interpreter's acknowledgeFlaky is dropped and re-read from the gate here.
    // And what they were shown is written into the approval itself (expectedFailures), so a gate that changed before the owner confirms is refused rather than slipped past them (card X09b part 2 review 2, item 1).
    // The interpreter's acknowledgeFlaky and expectedFailures are dropped whatever else the approval carries, so neither can survive on any path (not even one with no candidate named).
    if (intent.op === "release.approve") {
      delete args["expectedFailures"];
      delete args["acknowledgeFlaky"];
      // Without a candidate there is no gate to read, so nothing to show and nothing to bind: the approval is not drawn up.
      if (typeof args["candidateId"] !== "string") return refuse("invalid_command", "Which release candidate should be approved? Nothing in your message names one.");
    }
    if (intent.op === "release.approve" && typeof args["candidateId"] === "string") {
      const found = await this.#deps.api.handle(token, { v: API_VERSION, op: "release.gate", args: { candidateId: args["candidateId"] } });
      // The gate is what the approval is bound to: without reading it there is nothing to show and nothing to bind, so the approval is not drawn up at all.
      if (!found.ok) return refuse(found.error.code, found.error.message);
      const cells = (found.result["gate"] as { cells?: readonly { cell: { os: string; arch: string }; flaky?: boolean; earlierFailures?: readonly { id: string }[] }[] } | undefined)?.cells ?? [];
      const flaky = cells.filter((x) => x.flaky === true);
      const shown = cells.flatMap((x) => x.earlierFailures ?? []).map((f) => f.id);
      // Every approval the chat draws up carries the failures it shows — none on a clean gate — so the confirmation accepts exactly the gate the owner was shown, and a moved gate is refused at confirmation.
      args["expectedFailures"] = shown;
      if (flaky.length > 0) {
        args["acknowledgeFlaky"] = true;
        fillNotes.push(`release.gate just now: ${flaky.map((x) => `${x.cell.os} ${x.cell.arch} passed only after ${x.earlierFailures?.length ?? 0} earlier failure${(x.earlierFailures?.length ?? 0) === 1 ? "" : "s"} (${(x.earlierFailures ?? []).map((f) => f.id).join(", ")})`).join("; ")}. Approving accepts that these platforms had to be retried before they went green. If the gate shows anything different when you confirm, the approval is refused and you are shown it again.`);
      } else fillNotes.push("release.gate just now: no platform failed before it passed. Confirming accepts the gate exactly as it stands; if the gate changes before you confirm, this approval is refused and you are shown it again.");
    }
    // A restore is proposed with the plan the controller computes NOW from the backup's record; the approval token comes from that plan (never from the interpreter's words), so the owner's yes is bound to exactly what is shown.
    if (intent.op === "backup.restore.apply") {
      delete args["confirm"];
      const wanted = args["name"];
      if (typeof wanted !== "string") return refuse("invalid_command", "Which backup should be restored? Nothing in your message names one; backup.list shows the names.");
      const found = await this.#deps.api.handle(token, { v: API_VERSION, op: "backup.restore.preview", args: { name: wanted } });
      if (!found.ok) return refuse(found.error.code, found.error.message);
      const plan = found.result["item"] as { token: string; expiresAt?: string; name: string; createdAt: string; kind: string; rows: number; artifactFiles: number; piStores: number; piFiles: number; piStateIncluded: boolean; changesSinceBackup?: number; effectsToMarkUncertain?: number; deliveriesToResend?: number; leftOutByScope?: { text: string }; steps: string[]; warnings: string[] };
      args["confirm"] = plan.token;
      if (args["stopAttempts"] === true) fillNotes.push("Approving this also STOPS ALL RUNNING AGENT WORK first (every running attempt is checkpointed and ended, as the owner's graceful Stop of the whole installation does; the work stays paused until you resume it); the restore is prepared once the work has settled, and work that will not settle refuses the restore and stays paused.");
      fillNotes.push(`Restore plan, worked out just now from the backup ${plan.name} (made ${plan.createdAt}, ${plan.kind}): ${plan.rows} records, ${plan.artifactFiles} artifact files, ${plan.piStateIncluded ? `${plan.piFiles} conversation files in ${plan.piStores} stores` : "NO conversation state (Pi state not included)"}${plan.changesSinceBackup === undefined ? "" : `; about ${plan.changesSinceBackup} changes made since then will be lost`}${plan.effectsToMarkUncertain === undefined ? "" : `; ${plan.effectsToMarkUncertain} intended actions come back as uncertain`}${plan.deliveriesToResend === undefined ? "" : `; ${plan.deliveriesToResend} undelivered messages are sent again`}${plan.leftOutByScope === undefined ? "" : "; NOT A FULL COPY (it left records out by your backup scope, see the warnings)"}. ${plan.expiresAt === undefined ? "" : `Your approval is good until ${plan.expiresAt}. `}Steps: ${plan.steps.join(" ")} Warnings: ${plan.warnings.join(" ")}`);
    }
    // A real retention run is proposed with the digest of the preview worked out NOW (never one the interpreter wrote), so the owner's yes is bound to exactly what is shown; a digest the interpreter gave is dropped.
    if (intent.op === "retention.run") {
      const real = args["dryRun"] === false;
      delete args["confirm"];
      if (real) {
        const found = await this.#deps.api.handle(token, { v: API_VERSION, op: "retention.run", commandId: `cp-${randomUUID()}`, args: { dryRun: true, ...(args["limit"] === undefined ? {} : { limit: args["limit"] }) } });
        if (!found.ok) return refuse(found.error.code, found.error.message);
        const shown = (found.result["shown"] as string[] | undefined)?.[0];
        if (typeof found.result["digest"] !== "string") return refuse("invalid_command", "retention could not be previewed just now");
        args["dryRun"] = false;
        args["confirm"] = found.result["digest"];
        fillNotes.push(`What retention would do, worked out just now: ${shown ?? "see the preview"}`);
      }
    }
    // A database transfer is proposed with the plan the controller computes NOW; the approval token comes from that plan (never from the interpreter's words).
    if (intent.op === "database.transfer.apply") {
      delete args["confirm"];
      const wanted = args["target"];
      if (typeof wanted !== "string") return refuse("invalid_command", "Which database should it move to? Nothing in your message names one; database.transfer.status shows the names.");
      const found = await this.#deps.api.handle(token, { v: API_VERSION, op: "database.transfer.preview", args: { target: wanted } });
      if (!found.ok) return refuse(found.error.code, found.error.message);
      const plan = found.result["item"] as { token: string; direction: string; to: { name: string }; totalRows: number; bytesNeeded: number; freeBytes?: number; ok: boolean; claimsReleased: number; uncertainEffects: number; findings: { severity: string; text: string }[]; steps: string[] };
      if (!plan.ok) return refuse("invalid_transition", `the database cannot be moved now: ${plan.findings.filter((f) => f.severity === "error").map((f) => f.text).join("; ")}`);
      args["confirm"] = plan.token;
      fillNotes.push(`Transfer plan, worked out just now (${plan.direction}, to ${plan.to.name}): ${plan.totalRows} records; room: about ${plan.bytesNeeded} bytes needed, ${plan.freeBytes === undefined ? "free room at the destination not known" : `${plan.freeBytes} free at the destination`}; ${plan.claimsReleased} claims are released; ${plan.uncertainEffects} uncertain actions stay uncertain. Steps: ${plan.steps.join(" ")} Warnings: ${plan.findings.filter((f) => f.severity === "warning").map((f) => f.text).join(" ") || "none"}`);
    }
    // Removing a left-over copy is proposed with what the controller finds at the destination NOW; the token comes from that look, never from the interpreter's words.
    if (intent.op === "database.transfer.wipe") {
      delete args["confirm"];
      const wanted = args["target"];
      if (typeof wanted !== "string") return refuse("invalid_command", "At which destination should the left-over copy be removed? Nothing in your message names one; the database transfer status lists the names.");
      const found = await this.#deps.api.handle(token, { v: API_VERSION, op: "database.transfer.wipeplan", args: { target: wanted } });
      if (!found.ok) return refuse(found.error.code, found.error.message);
      const plan = found.result["item"] as { token: string; target: { name: string }; leftoverOf: string; cleanable: boolean; findings: { severity: string; text: string }[]; steps: string[] };
      if (!plan.cleanable) return refuse("invalid_transition", `nothing can be removed there: ${plan.findings.map((f) => f.text).join("; ")}`);
      args["confirm"] = plan.token;
      fillNotes.push(`What is at ${plan.target.name}, found just now: ${plan.findings.map((f) => f.text).join(" ")} Steps: ${plan.steps.join(" ")}`);
    }
    // A purge is proposed with what it would delete on every target, worked out NOW (card K01c). Whether it may delete the last good backup comes from that look, never from the interpreter's words:
    // `confirm` is set only when the preview warns, and the warning is shown, so the owner's yes is given to exactly that; without a warning now, a purge that would later take the last good backup still stops and asks.
    if (intent.op === "backup.purge" && args["dryRun"] !== true) {
      delete args["confirm"];
      const found = await this.#deps.api.handle(token, { v: API_VERSION, op: "backup.purge", commandId: `cp-${randomUUID()}`, args: { names: args["names"], dryRun: true } });
      if (!found.ok) return refuse(found.error.code, found.error.message);
      const warning = found.result["warning"];
      if (typeof warning === "string") { args["confirm"] = true; fillNotes.push(`WARNING: ${warning}. Saying yes deletes it anyway.`); }
      fillNotes.push(`What this purge would do, worked out just now: ${String(found.result["text"] ?? "").slice(0, 1200)}`);
    }
    const labels: Record<string, string> = {};
    const pins: ChatPin[] = [];
    const steps: ChatStep[] = [];

    // A right is only what the owner said: the principal, the action, the grant and the scope must each appear in the message as a whole word, never as a part of a longer one.
    if (intent.op.startsWith("grant.")) {
      if (args["projectId"] !== undefined) return refuse("invalid_command", "projectId is not an argument of a right; its scope is `project`");
      // A right for an agent the owner names by its name (card U14e review): the agents status shows `agt-` IDs, never the `agent:` principal a grant names, so a first-run owner could not give a
      // right in words. The name is looked up as an assignment's is (exactly one active agent, case ignored; none is refused, two are asked about) and the right is drawn up for that agent's principal.
      const grantName = args["agentName"];
      delete args["agentName"];
      // A bundle of rights (card D01): "let Ann work on Garden" asks for every right Ann's own roles stand for, in that project. It is drawn up below, once the project and the times are settled.
      const bundle = args["bundle"];
      delete args["bundle"];
      if (bundle !== undefined) {
        if (intent.op !== "grant.create") return refuse("invalid_command", "bundle is not an argument of this operation");
        if (typeof bundle !== "string" || !GRANT_BUNDLES.has(bundle)) return refuse("invalid_command", `bundle must be one of ${[...GRANT_BUNDLES].join(", ")}: the rights the agent's own roles stand for`);
        if (args["action"] !== undefined) return refuse("invalid_command", "the right is named twice over, as one action and as the agent's whole bundle; which one is meant has to be settled.");
        if (grantName === undefined) return refuse("invalid_command", "a bundle of rights is given to an agent named by its name; which agent should have it?");
      }
      let namedGrantee: { principal: string; name: string; roles: readonly string[] } | undefined;
      if (grantName !== undefined) {
        if (intent.op !== "grant.create") return refuse("invalid_command", "agentName is not an argument of this operation");
        if (args["grantee"] !== undefined) return refuse("invalid_command", "the agent is named twice over, as a grantee and by name; which one is meant has to be settled.");
        if (typeof grantName !== "string" || grantName.trim() === "") return refuse("invalid_command", "agentName must be the agent's name as the owner said it");
        const agents = await this.#listAll(token, "agent.list", { state: "active" });
        const exact = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === grantName.trim().toLowerCase());
        if (exact.length === 0) return refuse("not_found", `no active agent is called ${quotedText(grantName.trim(), 80)}`);
        if (exact.length > 1) return { ok: false, kind: "ask", question: `More than one agent is called ${quotedText(grantName.trim(), 80)}. Which one do you mean?`, options: exact.slice(0, CHAT_LIMITS.options).map((a) => String(a["id"]).slice(0, 60)) };
        namedGrantee = { principal: `agent:${String(exact[0]!["id"])}`, name: String(exact[0]!["friendlyName"]).slice(0, 80), roles: Array.isArray(exact[0]!["roles"]) ? (exact[0]!["roles"] as unknown[]).filter((r): r is string => typeof r === "string") : [] };
      }
      for (const key of ["grantee", "action", "grantId"] as const) if (typeof args[key] === "string" && !wholeWord(words, args[key] as string)) return refuse("unsupported_value", `${key === "grantId" ? "The right" : "The " + key} ${quotedText(args[key] as string, 60)} is not in your message as written, so nothing was drawn up — the chat will not invent one. Which ${key === "grantId" ? "grant did you mean, by its grt- ID?" : key === "action" ? "right did you mean?" : "principal did you mean?"}`);
      // The principal found from the owner's name is not in their words (only the name is), so it is put in after the check above.
      if (namedGrantee !== undefined) { args["grantee"] = namedGrantee.principal; labels[namedGrantee.principal] = namedGrantee.name; }
      // A project the owner named by its name (already checked above to be in their own words) is the right's scope: the project with exactly that name, or a question when several have it.
      // A name and a different `project` together are two scopes, and which one the owner meant is asked rather than picked.
      const named = args["projectName"];
      delete args["projectName"];
      if (named !== undefined && intent.op !== "grant.create") return refuse("invalid_command", "projectName is not an argument of this operation");
      if (named !== undefined) {
        if (typeof named !== "string") return refuse("invalid_command", "projectName must be text");
        if (!wholeWord(words, named.trim())) return refuse("unsupported_value", `project ${quotedText(named.trim(), 60)} is not in your message as written, so nothing was drawn up — the chat will not invent one. Which project should this right cover?`);
        const found = await this.#projectByIntent(token, undefined, named);
        if (!found.ok) return found.kind === "ask" ? { ok: false, kind: "ask", question: found.question, options: found.options } : found;
        if (args["project"] !== undefined && args["project"] !== found.id) return { ok: false, kind: "ask", question: `Should this right cover only ${quotedText(found.name, 80)}, or ${args["project"] === "*" ? "every project" : "another project"}?`, options: [] };
        args["project"] = found.id;
        labels[found.id] = found.name;
      }
      if (intent.op === "grant.create") {
        const scope = args["project"];
        // A right given in chat is always a proposal (`grant.*` is shown first in every profile). Its consequence — when it starts, when it ends, how far it reaches — is stated on the proposal line
        // itself (`describe`), and the owner's confirmation of that shown proposal is the consent: nothing here reads the owner's wording for "permanently" or "everywhere", and nothing tells them
        // what to say. A negated or conditional sentence the interpreter read as a plain grant is still only shown, and the owner's no ends it. The reason recorded is the owner's message itself.
        // The two times are values like every other text of the command, so they are the owner's or nobody's: the day must be one their own words give (`grantDateInWords` — the same rule `foreignValue`
        // applies to the rest of the command, read for the day rather than for the exact characters of an ISO moment). The time of day on that day is the interpreter's reading, and the line the owner
        // confirms shows the whole moment, so nothing is settled behind their back.
        for (const [key, what] of [["notBefore", "starts"], ["expiresAt", "ends"]] as const) {
          if (args[key] === undefined) continue;
          const when = grantDateInWords(args[key], words);
          if (when === undefined) return refuse("unsupported_value", `The day the right ${what} is not a day your message gives, so nothing was drawn up. Which day should it ${what}?`);
          args[key] = when;
        }
        // An idle window (card A07h) is a number like any other value of the command: it is the owner's or nobody's, so it must be a length their own words give.
        if (args["idleDays"] !== undefined && !(typeof args["idleDays"] === "number" && Number.isSafeInteger(args["idleDays"]) && args["idleDays"] >= 1 && lengthInWords(args["idleDays"], words))) return refuse("unsupported_value", "How long the right may go unused before it lapses is not a length your message gives, so nothing was drawn up. How many days unused should end it?");
        // A right that would end before it ever starts is not a right: said here, rather than proposing something the records refuse when it is confirmed.
        if (typeof args["notBefore"] === "string" && typeof args["expiresAt"] === "string" && args["expiresAt"] <= args["notBefore"]) return refuse("invalid_command", `That right would be over before it began, so nothing was drawn up: it would end ${args["expiresAt"] === args["notBefore"] ? "on the same moment it starts" : "before it starts"}. Which days did you mean?`);
        // An end already past is a right nobody could ever use: confirming it would leave the owner believing a right exists that does nothing (a day with no year read into the wrong year, say).
        if (typeof args["expiresAt"] === "string" && Date.parse(args["expiresAt"]) <= Date.parse(this.#runner.now())) return refuse("invalid_command", `The day the right ends, ${args["expiresAt"]}, has already passed, so nothing was drawn up: the right could never be used. Which day should it end?`);
        args["basis"] = `owner chat: ${words}`.slice(0, 200);
        if (scope === "*") { /* every project: the proposal says so */ }
        else if (typeof scope === "string" && named !== undefined) { /* resolved from the name the owner said, above */ }
        else if (typeof scope === "string") {
          if (!wholeWord(words, scope)) return refuse("unsupported_value", `project ${quotedText(scope, 60)} is not in your message as written, so nothing was drawn up — the chat will not invent one. Which project should this right cover?`);
          const found = await this.#projectByIntent(token, scope, undefined);
          if (!found.ok) return found;
          labels[found.id] = found.name;
        } else return refuse("invalid_command", "Which project should this right cover, or should it cover every project?");
        if (bundle !== undefined && namedGrantee !== undefined) {
          // A bundle is for one project (first review): a plain "let Ann work" sentence never reaches every project at once; rights for every project are named one by one.
          if (scope === "*") return refuse("invalid_command", `a bundle of rights covers one project, never every project. Which project should ${quotedText(namedGrantee.name, 80)} work on? To give rights in every project, name each right.`);
          const drawn = await this.#rightsBundle(token, namedGrantee, args, typeof scope === "string" ? labels[scope] ?? scope : "");
          if (!drawn.ok) return drawn;
          // One grant.create per right, each with the same grantee, scope, times and reason; the last is the command's own step, pushed at the end like every other command's.
          // The action is put first, so each line of the proposal starts with the right it gives.
          const rest = { ...args };
          for (const action of drawn.actions.slice(0, -1)) steps.push({ op: intent.op, args: { action, ...rest }, commandId: "" });
          for (const key of Object.keys(args)) delete args[key];
          Object.assign(args, { action: drawn.actions[drawn.actions.length - 1] }, rest);
          fillNotes.push(drawn.note);
        }
      }
    }

    // A project made in chat walks through how its finished work is handled, one question at a time (card P08c); a question left unanswered is never guessed.
    if (intent.op === "project.create") {
      const section = args["integration"];
      if (section !== undefined && (section === null || typeof section !== "object" || Array.isArray(section))) return refuse("invalid_command", "integration must be an object");
      const given = { ...((section as Record<string, unknown> | undefined) ?? {}) };
      const q = await this.#integrationQuestion(token, given, profile);
      if (q !== undefined) return q;
      // "default" means the owner chose what the installation default or the profile gives; it is not sent.
      const kept = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== "default"));
      // The section is shown on the proposal line, so only real settings are: an unknown field or a value the policy does not take is refused here, never displayed.
      for (const [key, value] of Object.entries(kept)) {
        const ok = key === "landing" ? (LANDINGS as readonly unknown[]).includes(value) : key === "integrator" ? (INTEGRATORS as readonly unknown[]).includes(value) : key === "requiredChecks" ? Array.isArray(value) && value.every((x) => (CHECKS as readonly unknown[]).includes(x)) : key === "refreshRounds" ? Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10 : false;
        if (!ok) return refuse("invalid_command", `integration.${/^[A-Za-z]{1,30}$/.test(key) ? key : "?"} is not a setting the project takes (landing ${LANDINGS.join(", ")}; integrator ${INTEGRATORS.join(" or ")}; requiredChecks a list of ${CHECKS.join(", ")}; refreshRounds 0 to 10)`);
      }
      if (Object.keys(kept).length === 0) delete args["integration"]; else args["integration"] = kept;
    }

    // The project: named, or the one in focus.
    let projectId: string | undefined;
    if (PROJECT_AS_PROJECT.has(intent.op) && typeof args["project"] === "string" && args["projectId"] === undefined) { args["projectId"] = args["project"]; delete args["project"]; }
    if (args["projectName"] !== undefined) {
      if (typeof args["projectName"] !== "string") return refuse("invalid_command", "projectName must be text");
      const found = await this.#projectByIntent(token, undefined, args["projectName"]);
      if (!found.ok) return found;
      projectId = found.id; labels[found.id] = found.name;
      delete args["projectName"];
      if (accepted.includes("projectId")) args["projectId"] = projectId;
    } else if (typeof args["projectId"] === "string") {
      const found = await this.#projectByIntent(token, args["projectId"], undefined);
      if (!found.ok) return found;
      projectId = found.id; labels[found.id] = found.name;
    }
    const needsScope = spec.needsProject === true || Object.keys(args).some((k) => k in TITLE_KEYS);
    if (projectId === undefined && needsScope && focus.projectId !== undefined) {
      projectId = focus.projectId;
      if (focus.projectName !== undefined) labels[projectId] = focus.projectName;
      if (spec.needsProject === true) args["projectId"] = projectId;
    }
    // An owner with exactly one project (the first-run case, card U14e) is not asked which project a task title or a project-scoped control is about: there is only one it can be.
    if (projectId === undefined && needsScope) {
      const only = await this.#listAll(token, "project.list", {});
      if (only.length === 1) {
        projectId = only[0]!["id"] as string;
        labels[projectId] = only[0]!["name"] as string;
        if (spec.needsProject === true) args["projectId"] = projectId;
      }
    }
    if (projectId === undefined && needsScope) return await this.#askProject();
    // These operations name the project as `project`, not `projectId`: it was read as `projectId` above and is named back here.
    if (PROJECT_AS_PROJECT.has(intent.op)) { delete args["projectId"]; if (projectId !== undefined) args["project"] = projectId; }

    // Tasks named by title: exactly one match in the project, or a question.
    for (const [titleKey, idKey] of Object.entries(TITLE_KEYS)) {
      const title = args[titleKey];
      if (title === undefined) continue;
      delete args[titleKey];
      if (typeof title !== "string" || title.length === 0) return refuse("invalid_command", `${titleKey} must be text`);
      if (args[idKey] !== undefined) return refuse("invalid_command", `the message names the task twice over, as ${idKey} and as ${titleKey}; which one is meant has to be settled.`);
      const matches = await this.#tasksByTitle(token, projectId as string, title);
      if (matches.length === 0) return refuse("not_found", `no task called ${quotedText(title, 80)} in that project`);
      if (matches.length > 1) return { ok: false, kind: "ask", question: `More than one task is called ${quotedText(title, 80)}. Which one?`, options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${m.id} (${m.state})`), field: idKey, choices: matches.slice(0, CHAT_LIMITS.options).map((m) => m.id) };
      args[idKey] = (matches[0] as { id: string }).id;
    }
    // A release commits approved code (card D01, release by words). The owner names the task, not the submission: the CHAT finds the task's approved code that is not committed yet, never the model. A release that names no
    // submission would commit the whole folder as a plain commit, so one is never proposed without it, nor one for no task. An ID the model supplied counts only when it is one of the found submissions. With no ID,
    // only the task's NEWEST code is filled in when it is approved and not committed, or else the newest approved, uncommitted submission with exactly the same base and tree (the same code submitted again and not
    // reviewed yet; never when a reviewer asked for changes to that newest submission, which takes back exactly that code): each code submission is the checkout as it was submitted, and the host commits only when the checkout holds exactly the approved tree on the approved base, so older approved code that
    // different newer code followed would be refused after the task was made quiet.
    if (intent.op === "workspace.request" && args["operation"] === "release") {
      if (typeof args["taskId"] !== "string") return refuse("invalid_command", "A release commits the approved code of one task, and no task was named, so nothing was proposed. Name the task (for example \"commit the approved parser fix\").");
      const supplied = args["submissionId"];
      if (supplied !== undefined && typeof supplied !== "string") return refuse("invalid_command", "submissionId must be text");
      if (this.#deps.approvedCode === undefined) {
        if (supplied === undefined) return refuse("unavailable", "Which approved code to commit cannot be looked up here, so nothing was proposed. Name its submission ID (it starts with sbm-).");
      } else {
        let found: Awaited<ReturnType<ApprovedCodeLookup>>;
        let taskItem: Record<string, unknown> | undefined;
        try { found = await this.#deps.approvedCode(await this.#owner(token), args["taskId"]); taskItem = await this.#get(token, "task.get", { taskId: args["taskId"] }); } catch { return refuse("unavailable", "The approved code of that task could not be checked just now, so nothing was proposed. Try again in a moment."); }
        const taskLabel = quotedText(typeof taskItem?.["title"] === "string" ? taskItem["title"] : args["taskId"], 80);
        if (supplied !== undefined) {
          const named = found.items.find((i) => i.id === supplied);
          if (named === undefined) return refuse("not_found", `${quotedText(supplied, 40)} is not approved code of ${taskLabel} that is waiting to be committed${found.truncated ? " (not every submission of the task could be read)" : ""}, so nothing was proposed.`);
          fillNotes.push(`Commits ${supplied} of ${taskLabel}: approved code, not committed yet.`);
          const n = found.newest;
          if (n !== undefined && n.id !== supplied && n.committed !== true && n.changesAsked === true && n.base === named.base && n.tree === named.tree) fillNotes.push(`The same code was submitted again on ${taskLabel} after it (${n.id}, submitted ${n.submittedAt}), and a reviewer asked for changes to that submission.`);
          if (n !== undefined && n.id !== supplied && (n.committed === true || n.base === undefined || n.base !== named.base || n.tree !== named.tree)) fillNotes.push(`Newer code (${n.id}, submitted ${n.submittedAt}) was submitted on ${taskLabel} after it${n.committed === true ? " and already committed" : ""}, so the working folder most likely no longer holds ${supplied}: a release commits only the exact approved code the folder holds, and otherwise it is refused and nothing is committed.`);
        } else if (found.truncated) {
          return refuse(found.items.length === 0 ? "not_found" : "unavailable", `Not every submission of ${taskLabel} could be read, so which code of it is the newest cannot be told and nothing was proposed. Name the submission ID (it starts with sbm-) if you know it.`);
        } else if (found.newest === undefined) {
          return refuse("not_found", `No code has been submitted on ${taskLabel}, so there is no approved code to commit and nothing was proposed.`);
        } else {
          const n = found.newest;
          const same = n.committed === true || n.changesAsked === true || n.base === undefined || n.tree === undefined ? undefined : found.items.find((i) => i.base === n.base && i.tree === n.tree);
          if (same === undefined) {
            const older = found.items.length;
            return refuse("not_found", `The newest code of ${taskLabel} (${n.id}, submitted ${n.submittedAt}) is not approved code waiting to be committed (${n.committed === true ? "it is already committed" : n.changesAsked === true ? "a reviewer asked for changes to it" : "it is not approved yet"}), so nothing was proposed.${older === 0 ? "" : ` ${older} older approved submission${older === 1 ? " is" : "s are"} not committed, but ${n.changesAsked === true ? "newer code followed" : "different newer code followed"} ${older === 1 ? "it" : "them"}, and a release commits only the exact approved code the task's working folder holds; name one by its ID only if you mean it.`}`);
          }
          args["submissionId"] = same.id;
          fillNotes.push(same.id === n.id
            ? `Commits ${n.id} of ${taskLabel}, submitted ${n.submittedAt}: the task's newest code, approved and not committed yet, found just now (you did not name it).`
            : `Commits ${same.id} of ${taskLabel}, submitted ${same.submittedAt}: approved code, not committed yet, found just now (you did not name it). The task's newest code (${n.id}) is not approved yet, but it holds exactly the same code on the same starting point, so this approval covers what the working folder was last submitted with.`);
        }
      }
    }
    // An agenda item named by its words: exactly one open item of the project whose topic contains them, or the owner is asked.
    if (intent.op === "agenda.correct") {
      const named = args["agendaTopic"];
      delete args["agendaTopic"];
      if (named !== undefined && args["itemId"] !== undefined) return refuse("invalid_command", "the agenda item is named twice over, as itemId and as agendaTopic; which one is meant has to be settled.");
      if (args["itemId"] === undefined) {
        if (named !== undefined && typeof named !== "string") return refuse("invalid_command", "agendaTopic must be text");
        const open = await this.#listAll(token, "agenda.list", { projectId });
        const words = typeof named === "string" ? named.trim().toLowerCase() : "";
        const matches = open.filter((i) => words === "" || String(i["topic"]).toLowerCase().includes(words));
        if (matches.length === 0) return refuse("not_found", words === "" ? "there is no open agenda item in that project" : `no open agenda item about ${quotedText(named as string, 80)} in that project`);
        if (matches.length > 1) return { ok: false, kind: "ask", question: "Which agenda item do you mean?", options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${String(m["id"])} (${String(m["topic"]).slice(0, 60)})`), field: "itemId", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => String(m["id"])) };
        args["itemId"] = String(matches[0]!["id"]);
      }
      const found = await this.#get(token, "agenda.get", { itemId: args["itemId"] });
      if (found === undefined) return refuse("not_found", "no such agenda item");
      labels[String(args["itemId"])] = String(found["topic"]);
    }
    // Ongoing responsibilities (card P04): a responsibility is named by its title, a managed resource by its label, an incident by the responsibility's title and, when it has several, the words of its signature. Exactly one match, else the owner is asked.
    if (intent.op === "responsibility.update" || intent.op === "responsibility.probe.set" || intent.op === "incident.resolve" || intent.op === "lease.acquire" || intent.op === "lease.release") {
      const pick = (what: string, field: string, words: string, items: { id: string; name: string }[]): { id: string } | ReturnType<typeof refuse> | { ok: false; kind: "ask"; question: string; options: string[]; field: string; choices: string[] } => {
        const matches = items.filter((i) => words === "" || i.name.toLowerCase().includes(words));
        if (matches.length === 0) return refuse("not_found", words === "" ? `there is no ${what} in that project` : `no ${what} in that project is called ${quotedText(words, 80)}`);
        if (matches.length > 1) return { ok: false, kind: "ask", question: `Which ${what} do you mean?`, options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${m.id} (${m.name.slice(0, 60)})`), field, choices: matches.slice(0, CHAT_LIMITS.options).map((m) => m.id) };
        return { id: matches[0]!.id };
      };
      const words = (key: string): string | undefined | ReturnType<typeof refuse> => {
        const v = args[key];
        delete args[key];
        if (v !== undefined && typeof v !== "string") return refuse("invalid_command", `${key} must be text`);
        return v?.trim().toLowerCase();
      };
      const dutyTitle = intent.op === "responsibility.update" || intent.op === "responsibility.probe.set" || intent.op === "incident.resolve" ? words("responsibilityTitle") : undefined;
      const resourceLabel = intent.op.startsWith("lease.") ? words("resourceLabel") : undefined;
      const signature = intent.op === "incident.resolve" ? words("incidentSignature") : undefined;
      for (const w of [dutyTitle, resourceLabel, signature]) if (typeof w === "object") return w;
      if ((intent.op === "responsibility.update" || intent.op === "responsibility.probe.set") && args["responsibilityId"] === undefined) {
        const listed = await this.#plainItems(token, "responsibility.list", { projectId });
        const r = pick("responsibility", "responsibilityId", (dutyTitle as string | undefined) ?? "", listed.map((i) => ({ id: String(i["id"]), name: String(i["title"]) })));
        if (!("id" in r)) return r;
        args["responsibilityId"] = r.id;
      } else if (intent.op === "incident.resolve" && args["incidentId"] === undefined) {
        const listed = await this.#plainItems(token, "responsibility.incidents", { projectId, open: true });
        const duties = dutyTitle === undefined ? undefined : await this.#plainItems(token, "responsibility.list", { projectId });
        const ids = duties === undefined ? undefined : new Set(duties.filter((d) => String(d["title"]).toLowerCase().includes(dutyTitle as string)).map((d) => String(d["id"])));
        const own = listed.filter((i) => ids === undefined || ids.has(String(i["responsibilityId"])));
        const r = pick("open incident", "incidentId", (signature as string | undefined) ?? "", own.map((i) => ({ id: String(i["id"]), name: String(i["signature"]) })));
        if (!("id" in r)) return r;
        args["incidentId"] = r.id;
      } else if (intent.op.startsWith("lease.") && args["resourceId"] === undefined) {
        const listed = await this.#plainItems(token, "resource.list", { projectId, state: "bound" });
        const r = pick("resource", "resourceId", (resourceLabel as string | undefined) ?? "", listed.map((i) => ({ id: String(i["id"]), name: String(i["label"]) })));
        if (!("id" in r)) return r;
        args["resourceId"] = r.id;
      } else if (dutyTitle !== undefined || resourceLabel !== undefined || signature !== undefined) {
        return refuse("invalid_command", "the message names the same thing twice over, as an ID and in words; which one is meant has to be settled.");
      }
    }
    // A stand-up named by its title (or the only one of the project): exactly one whose title contains the words, else the owner is asked.
    if (intent.op === "standup.update") {
      const named = args["standupTitle"];
      delete args["standupTitle"];
      if (named !== undefined && args["scheduleId"] !== undefined) return refuse("invalid_command", "the stand-up is named twice over, as scheduleId and as standupTitle; which one is meant has to be settled.");
      if (named !== undefined && typeof named !== "string") return refuse("invalid_command", "standupTitle must be text");
      if (args["scheduleId"] !== undefined) {
        // An ID is looked at directly, so a project with many ended stand-ups cannot hide it.
        const got = typeof args["scheduleId"] === "string" ? await this.#get(token, "standup.get", { scheduleId: args["scheduleId"] }) : undefined;
        const schedule = got?.["schedule"] as { projectId?: string; state?: string; title?: string } | undefined;
        if (schedule === undefined || schedule.projectId !== projectId) return refuse("not_found", "that stand-up is not in this project");
        if (schedule.state === "ended") return refuse("invalid_command", "that stand-up has ended and cannot be changed or started again");
        labels[String(args["scheduleId"])] = String(schedule.title);
      } else {
        const words = typeof named === "string" ? named.trim().toLowerCase() : "";
        const listed = await this.#get(token, "standup.list", { projectId, limit: 50 });
        const more = listed?.["more"] === true;
        const matches = ((listed?.["items"] as Record<string, unknown>[] | undefined) ?? []).filter((i) => words === "" || String(i["title"]).toLowerCase().includes(words));
        if (matches.length === 0) {
          // Ended stand-ups are only looked up to explain a miss.
          const endedList = more ? undefined : await this.#get(token, "standup.list", { projectId, endedOnly: true, limit: 50 });
          const ended = ((endedList?.["items"] as Record<string, unknown>[] | undefined) ?? []).filter((i) => words === "" || String(i["title"]).toLowerCase().includes(words));
          if (ended.length > 0) return refuse("invalid_command", `the stand-up ${quotedText(String(ended[0]!["title"]), 80)} has ended and cannot be changed or started again`);
          if (more) return refuse("not_found", "the project has more than 50 active stand-ups and none of those looked at matches, so which stand-up is meant is not settled");
          return refuse("not_found", words === "" ? "there is no stand-up in that project" : `no stand-up in that project is called ${quotedText(words, 80)}`);
        }
        if (matches.length > 1) return { ok: false, kind: "ask", question: "Which stand-up do you mean?", options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${String(m["scheduleId"])} (${String(m["title"]).slice(0, 60)})`), field: "scheduleId", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => String(m["scheduleId"])) };
        args["scheduleId"] = String(matches[0]!["scheduleId"]);
        labels[String(args["scheduleId"])] = String(matches[0]!["title"]);
      }
    }
    // A question to the owner named by its words (or the only one waiting): the one open question whose words, task or asker contain them, else the owner is asked.
    if (intent.op === "owner.answer") {
      const named = args["questionTopic"];
      delete args["questionTopic"];
      if (named !== undefined && args["inquiryId"] !== undefined) return refuse("invalid_command", "the question is named twice over, as inquiryId and as questionTopic; which one is meant has to be settled.");
      if (named !== undefined && typeof named !== "string") return refuse("invalid_command", "questionTopic must be text");
      const open = await this.#listAll(token, "owner.questions", {});
      if (args["inquiryId"] !== undefined && !open.some((i) => i["inquiryId"] === args["inquiryId"])) return refuse("not_found", "that question is not waiting for your answer");
      // An ID given directly (by the model or carried on from a chosen answer) is shown first like an unnamed question.
      if (args["inquiryId"] !== undefined) showFirst = "the question it answers is shown to you first";
      if (args["inquiryId"] === undefined) {
        const words = typeof named === "string" ? named.trim().toLowerCase() : "";
        // An answer given with no word naming the question could land on one the owner never saw: it is shown first, with the question it would answer.
        if (words.length < 4) showFirst = "no question was clearly named, so you are shown the one it would answer first";
        const has = (i: Record<string, unknown>): boolean => [String(i["question"]), String((i["task"] as { title?: unknown } | undefined)?.title ?? "")].some((t) => t.toLowerCase().includes(words));
        const matches = open.filter((i) => words === "" || has(i));
        if (matches.length === 0) return refuse("not_found", words === "" ? "no agent is waiting for your answer" : `no waiting question is about ${quotedText(words, 80)}`);
        if (matches.length > 1) return { ok: false, kind: "ask", question: "Which question are you answering?", options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${String(m["inquiryId"])} (${String(m["question"]).slice(0, 60)})`), field: "inquiryId", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => String(m["inquiryId"])) };
        args["inquiryId"] = String(matches[0]!["inquiryId"]);
      }
    }
    // An item of the Needs-you list answered where it stands (card U11d), named by the owner's words for it (any part of what the list says about it) or the only one that waits; the item's kind, ID and project come from the list.
    // The choice (allow, deny, agree, ...) or the words are the owner's own; an approval and a blocker, which no other command answers, are shown first.
    if (intent.op === "needs-you.answer") {
      const named = args["itemTopic"];
      delete args["itemTopic"];
      if (named !== undefined && typeof named !== "string") return refuse("invalid_command", "itemTopic must be text");
      // An ID is only ever one the owner just picked from the choices offered (it is checked against the list below); a kind is never given.
      if (args["kind"] !== undefined) return refuse("invalid_command", "an item of the Needs-you list is named in your words (itemTopic), not by a kind");
      if (args["expectedRevision"] !== undefined) return refuse("invalid_command", "the revision of an item of the Needs-you list is taken from the list, not given");
      const picked = args["id"];
      if (picked !== undefined && typeof picked !== "string") return refuse("invalid_command", "id must be text");
      const listed = await this.#deps.api.handle(token, { v: API_VERSION, op: "status.ask", args: { request: { kind: "needs_you", limit: 50 } } });
      if (!listed.ok) return refuse(listed.error.code, listed.error.message);
      const all = ((((listed.result["item"] ?? listed.result) as Record<string, unknown>)["items"] ?? []) as { kind: string; id: string; projectId?: string; taskId?: string; text: string; answer: { kind: string; choices?: string[] }; revision?: number }[]);
      const words = typeof named === "string" ? named.trim().toLowerCase() : "";
      const given = typeof args["answer"] === "string" ? args["answer"] : "";
      // Only an item the owner's answer can mean: a choice the item offers, or the owner's own words for an item that takes words (a bare "allow" explains nothing, so it fits no blocker or question).
      const fits = all.filter((i) => (i.answer.kind === "words" ? given.length > 0 && !NEED_CHOICES.has(given) : (i.answer.choices ?? []).includes(given)));
      const matches = fits.filter((i) => (picked === undefined ? words === "" || i.text.toLowerCase().includes(words) : i.id === picked));
      showFirst = "the item it answers is shown to you first";
      if (matches.length === 0) return refuse("not_found", words === "" ? "nothing in your Needs-you list can be answered that way" : `no item in your Needs-you list that ${given.length > 0 ? "takes that answer " : ""}is about ${quotedText(words, 80)}`);
      if (matches.length > 1) return { ok: false, kind: "ask", question: "Which item are you answering?", options: matches.slice(0, CHAT_LIMITS.options).map((m) => { /* a defect item begins with its own ID: the choice keeps the room for its severity and task title (two similar titles told apart) */ const own = `Defect ${m.id} `; const said = m.kind === "defect" && m.text.startsWith(own) ? m.text.slice(own.length) : m.text; return said === m.text ? `${m.id} (${m.text.slice(0, 60)})` : `${m.id} ${said.slice(0, 120)}`; }), field: "id", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => m.id) };
      const one = matches[0]!;
      args["kind"] = one.kind; args["id"] = one.id;
      if (one.projectId !== undefined && one.kind === "meeting-question") args["projectId"] = one.projectId;
      if (one.taskId !== undefined && one.kind === "held-resume") args["taskId"] = one.taskId;
      // A defect's item is the escalation listed now: the proposal carries its revision, so a "yes" given after the defect escalated again is refused rather than applied to the new escalation.
      if (one.kind === "defect" && typeof one.revision === "number") args["expectedRevision"] = one.revision;
      labels[one.id] = one.text.slice(0, 80);
    }
    // A question a stand-up asked the owner (card M03h), named by any part of the topic or the words asked, or the only one waiting. The answer is the owner's own words (the text guard below holds them to the message); an unclear name asks.
    if (intent.op === "standup.answer-question") {
      const named = args["questionTopic"];
      delete args["questionTopic"];
      if (named !== undefined && args["questionId"] !== undefined) return refuse("invalid_command", "the question is named twice over, as questionId and as questionTopic; which one is meant has to be settled.");
      if (named !== undefined && typeof named !== "string") return refuse("invalid_command", "questionTopic must be text");
      const asked = await this.#get(token, "standup.owner-questions", { projectId });
      const open = ((asked?.["open"] as Record<string, unknown>[] | undefined) ?? []);
      if (args["questionId"] !== undefined && !open.some((q) => q["id"] === args["questionId"])) return refuse("not_found", "that question is not waiting for your answer");
      if (args["questionId"] !== undefined) showFirst = "the question it answers is shown to you first";
      if (args["questionId"] === undefined) {
        const words = typeof named === "string" ? named.trim().toLowerCase() : "";
        // An answer that names nothing could land on a question the owner never saw: with several waiting it asks, and a lone one is shown first with the answer.
        if (words.length < 4) showFirst = "no question was clearly named, so you are shown the one it would answer first";
        const matches = open.filter((q) => words === "" || [String(q["topic"]), String(q["question"])].some((t) => t.toLowerCase().includes(words)));
        if (matches.length === 0) return refuse("not_found", words === "" ? "no stand-up is waiting for your answer in this project" : `no question a stand-up asked is about ${quotedText(words, 80)}`);
        if (matches.length > 1) return { ok: false, kind: "ask", question: "Which of the stand-up's questions are you answering?", options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${String(m["id"])} (${String(m["question"]).slice(0, 60)})`), field: "questionId", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => String(m["id"])) };
        args["questionId"] = String(matches[0]!["id"]);
      }
      const chosen = open.find((q) => q["id"] === args["questionId"]);
      args["expectedRevision"] = chosen?.["revision"];
      labels[String(args["questionId"])] = `the stand-up's question ${quotedText(String(chosen?.["question"] ?? ""), 80)}`;
    }
    // The owner's answer to a meeting decision that waits for them (card M02h). The model gives the owner's words for the decision (`decisionTopic`: any part of what was decided or its topic) and the answer; the decision is found among those
    // waiting, and anything unclear is asked, never guessed (a `decisionId` the owner did not say or choose is asked about too when several wait). An alternative is the owner's own wording (`alternativeStatement`, optionally
    // `alternativeTopic`), recorded as their decision from this turn; the checks the decision service will make on those words are made here first, so nothing is proposed that is bound to fail after the owner confirms.
    if (intent.op === "meeting.record.owner-respond") {
      const named = args["decisionTopic"];
      const statement = args["alternativeStatement"];
      const topicWords = args["alternativeTopic"];
      delete args["decisionTopic"];
      delete args["alternativeStatement"];
      delete args["alternativeTopic"];
      if (!["agree", "decline", "alternative"].includes(String(args["response"]))) return refuse("invalid_command", "response must be agree, decline or alternative");
      if ((named !== undefined && typeof named !== "string") || (statement !== undefined && typeof statement !== "string") || (topicWords !== undefined && typeof topicWords !== "string")) return refuse("invalid_command", "decisionTopic, alternativeStatement and alternativeTopic must be text");
      if (named !== undefined && args["decisionId"] !== undefined) return refuse("invalid_command", "the meeting decision is named twice over, as decisionId and as decisionTopic; which one is meant has to be settled.");
      const isAlternative = args["response"] === "alternative";
      if (!isAlternative && (statement !== undefined || topicWords !== undefined)) return refuse("invalid_command", "alternativeStatement and alternativeTopic go only with response alternative");
      // What to do next depends on why: the words are the owner's to rephrase, a topic is theirs to name, a conflict is theirs to settle.
      const instead = (reason: string, next = "what do you decide instead?"): Resolved & { ok: false } => refuse("invalid_command", `Nothing was proposed: ${reason}. The meeting decision still waits for your answer; ${next}${next.endsWith("?") ? "" : "."}`);
      const said = typeof statement === "string" ? statement.trim() : "";
      if (isAlternative) {
        if (said === "") return refuse("invalid_command", "Nothing was proposed: no answer of yours is here to record. What do you decide instead?");
        if (!evidenceStrong(said)) return instead("a decision needs at least two words and at least six characters");
        if (said.length > 150) return instead("it is too long to show whole before you confirm (150 characters at most)");
        const notDecision = notADecision(said) ?? notADecisionIn(words, said);
        if (notDecision !== undefined) return instead(notDecision);
      }
      const waitingList = await this.#get(token, "meeting.decisions.waiting", {});
      const everyone = (waitingList?.["items"] as Record<string, unknown>[] | undefined) ?? [];
      // A project the owner named narrows the decisions to that project.
      const waiting = projectId === undefined ? everyone : everyone.filter((d) => d["projectId"] === projectId);
      const cut = waitingList?.["truncated"] === true;
      const tooMany = "More meeting decisions wait for you than could be read at once, and the words do not say which one. Which is it?";
      let chosen: Record<string, unknown> | undefined;
      if (waiting.length === 0) return refuse("not_found", cut ? "More meeting decisions exist than could be read at once, and none of those read waits for you; which one is meant cannot be told from the words." : everyone.length > 0 ? "no meeting decision of that project is waiting for your answer" : "no meeting decision is waiting for your answer");
      // Decisions of several projects are told apart by the project's name.
      const names = new Map<string, string>();
      if (new Set(waiting.map((d) => String(d["projectId"]))).size > 1) for (const id of new Set(waiting.map((d) => String(d["projectId"])))) names.set(id, ((await this.#get(token, "project.get", { projectId: id }))?.["name"] as string | undefined)?.slice(0, 40) ?? id);
      const pick = (d: Record<string, unknown>): string => `${String(d["id"])} (${String(d["text"]).slice(0, 60)}${names.has(String(d["projectId"])) ? `, in ${names.get(String(d["projectId"]))}` : ""})`;
      const askWhich = (list: Record<string, unknown>[]): Resolved & { ok: false } => ({ ok: false, kind: "ask", question: "Which meeting decision are you answering?", options: list.slice(0, CHAT_LIMITS.options).map(pick), field: "decisionId", choices: list.slice(0, CHAT_LIMITS.options).map((d) => String(d["id"])) });
      if (typeof args["decisionId"] === "string") {
        chosen = waiting.find((d) => d["id"] === args["decisionId"]);
        if (chosen === undefined) return refuse("not_found", cut ? tooMany : "that meeting decision is not waiting for your answer");
        // An ID the owner did not say or pick from the question is the model's own: with several waiting, the owner is asked.
        if (waiting.length > 1 && !words.includes(String(chosen["id"]))) return askWhich(waiting);
      } else {
        const typed = typeof named === "string" ? named : "";
        const text = (d: Record<string, unknown>): string => `${String(d["text"])} ${String(d["topic"] ?? "")}`;
        let matches = waiting.filter((d) => decisionWordsMatch(typed, text(d), true));
        if (matches.length === 0) matches = waiting.filter((d) => decisionWordsMatch(typed, text(d), false));
        if (matches.length === 0) return refuse("not_found", cut ? tooMany : `no waiting meeting decision is about ${quotedText(typed, 80)}`);
        if (matches.length > 1) return askWhich(matches);
        chosen = matches[0]!;
        args["decisionId"] = String(chosen["id"]);
        if (cut) fillNotes.push("Not every waiting decision could be read; check this is the one you mean.");
      }
      const started = Number(chosen["applying"] ?? 0);
      labels[String(args["decisionId"])] = `${String(chosen["text"]).slice(0, 80)}; ${String(chosen["left"])} change${chosen["left"] === 1 ? "" : "s"} left to carry out`;
      labels[`started:${String(args["decisionId"])}`] = String(started);
      if (isAlternative) {
        // The topic is the owner's words or the topic the decision answered; the wording of a motion (an agent's text) is never made into a topic.
        const raw = typeof topicWords === "string" && topicWords.trim() !== "" ? topicWords : typeof chosen["topic"] === "string" ? chosen["topic"] : undefined;
        if (raw === undefined) return instead("the decision has no topic of its own", "name a topic for yours in your own words (a short phrase), or decline the meeting's decision");
        const topic = normalTopic(raw.replace(/[^\p{L}\p{N} ._/-]+/gu, " ")).replace(/^[^a-z0-9]+/, "").slice(0, 80).trim();
        if (!TOPIC.test(topic)) return instead("the topic of your decision must be 1 to 80 letters, digits or spaces starting with a letter or digit", "name one in your own words — a short phrase of letters, digits or spaces");
        // What the decision service would refuse on the topic is read now, so nothing bound to fail is proposed: another kind of decision on the topic, a conflict not yet settled, the same words already decided.
        const history = ((await this.#get(token, "decision.history", { projectId: chosen["projectId"], topic })) as unknown as Record<string, unknown>[] | undefined) ?? [];
        const kindHeld = history.find((e) => typeof e["category"] === "string" && e["category"] !== "decision");
        if (kindHeld !== undefined) return instead(`the topic ${quotedText(topic, 80)} holds ${String(kindHeld["category"]).slice(0, 20)} decisions, not decisions of this kind`, "name another topic for yours, in your own words");
        const live = history.filter((e) => e["state"] !== "superseded");
        // Any unsettled conflict on the topic stops a project-wide decision, a task's own included.
        if (live.some((e) => e["state"] === "disputed")) return instead(`the topic ${quotedText(topic, 80)} has a conflict between two of your instructions`, "that conflict has to be settled first, or the meeting's decision declined");
        if (live.some((e) => e["taskId"] === undefined && typeof e["statement"] === "string" && normalText(e["statement"]) === normalText(said) && e["gate"] === undefined)) return instead(`you have already decided exactly this on the topic ${quotedText(topic, 80)}; it stands`, "the meeting's decision is declined if that is what you mean, or the two are settled together");
        const alt: Record<string, unknown> = { projectId: chosen["projectId"], category: "decision", topic, statement: said, wording: said };
        const base = await this.#revisionFor(token, "decision", alt, undefined, new Map());
        if (!base.ok) return base;
        alt["basedOn"] = base.value;
        args["alternative"] = alt;
      }
    }
    // A stand-up and an agent's brief named in the owner's own words (card M03h). The model gives the words (`meetingTopic`, `agentName`); the stand-up is looked up in the project's records by any part of its title, the agent by name,
    // and anything unclear is asked, never guessed. The brief's current revision is read here, so the proposal the owner sees is for exactly that brief.
    if (intent.op === "standup.prepare" || intent.op === "standup.add-statement") {
      const topic = args["meetingTopic"];
      const agentName = args["agentName"];
      delete args["meetingTopic"];
      delete args["agentName"];
      const isNote = intent.op === "standup.add-statement";
      if ((topic !== undefined && typeof topic !== "string") || (agentName !== undefined && typeof agentName !== "string")) return refuse("invalid_command", "meetingTopic and agentName must be text");
      if (topic !== undefined && args["occurrenceId"] !== undefined) return refuse("invalid_command", "the meeting is named twice over, as occurrenceId and as meetingTopic; which one is meant has to be settled.");
      if (agentName !== undefined && args["briefId"] !== undefined) return refuse("invalid_command", "the brief is named twice over, as briefId and as agentName; which one is meant has to be settled.");
      if (typeof args["briefId"] === "string") {
        // A brief picked from the owner's answer (or named by ID): it must be in this project, and its revision is read now.
        if (!isNote) return refuse("invalid_command", "preparing a stand-up takes the stand-up, not a brief");
        const brief = await this.#get(token, "standup.brief", { briefId: args["briefId"] });
        if (brief === undefined || brief["projectId"] !== projectId) return refuse("not_found", "that brief is not in this project");
        args["expectedRevision"] = brief["revision"];
        labels[String(args["briefId"])] = `${String(brief["agent"]).slice(0, 80)}'s brief`;
      } else {
        // The stand-ups the project has set up are read from the schedules, because a stand-up made this morning is one of them even before it has met (card M03h); the meeting to prepare, or to write into, is the one its latest occurrence is.
        const setUp = await this.#standups(token, projectId);
        const titles = setUp.titles;
        const noneReady = (): string => titles.length === 0
          ? `no stand-up is set up in this project, so there is nothing to ${isNote ? "write into" : "prepare"}`
          : `${titleList(titles)} ${titles.length === 1 ? "has" : "have"} no meeting to ${isNote ? "write into" : "prepare"} yet`;
        const recent = await this.#get(token, "standup.recent", { projectId, limit: 50 });
        const open = ((recent?.["items"] as Record<string, unknown>[] | undefined) ?? []).filter((i) => (isNote ? i["state"] === "planned" : i["state"] === "planned" || i["state"] === "reported"));
        const pick = (i: Record<string, unknown>): string => `${String(i["occurrenceId"])} (${quotedText(shownTitle(i, setUp.titleOf), 60)}, ${String(i["startsAt"])})`;
        let occurrence: Record<string, unknown> | undefined;
        if (typeof args["occurrenceId"] === "string") {
          occurrence = open.find((i) => i["occurrenceId"] === args["occurrenceId"]);
          if (occurrence === undefined) return refuse("not_found", isNote ? "that stand-up is not coming up in this project, so its briefs are closed" : "that stand-up is not one that can be prepared in this project");
        } else {
          const words = typeof topic === "string" ? topic : "";
          // A meeting is named by its own title or by the title its stand-up has now (a stand-up renamed after its meeting was made is still that stand-up).
          const matches = meetingsNamed(words, open, setUp.titleOf);
          // Words that fit one of the project's own stand-ups are answered about that stand-up, even when it has no meeting to work on: asking which one the owner meant would be odd when they named it.
          const named = words === "" ? [] : titles.filter((t) => looseMatch(words, t));
          if (matches.length === 0 && named.length === 1) return refuse("not_found", `${quotedText(named[0]!, 60)} is set up in this project but has no meeting to ${isNote ? "write into" : "prepare"} right now`);
          if (open.length === 0) return refuse("not_found", noneReady());
          if (matches.length === 0) return { ok: false, kind: "ask", question: `No stand-up here is called ${quotedText(words, 80)}. Which one do you mean?`, options: open.slice(0, CHAT_LIMITS.options).map(pick), field: "occurrenceId", choices: open.slice(0, CHAT_LIMITS.options).map((m) => String(m["occurrenceId"])) };
          if (matches.length > 1) return { ok: false, kind: "ask", question: "Which stand-up do you mean?", options: matches.slice(0, CHAT_LIMITS.options).map(pick), field: "occurrenceId", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => String(m["occurrenceId"])) };
          occurrence = matches[0]!;
          args["occurrenceId"] = String(occurrence["occurrenceId"]);
        }
        labels[String(args["occurrenceId"])] = `${shownTitle(occurrence, setUp.titleOf).slice(0, 80)} (${String(occurrence["startsAt"])})`;
        if (isNote) {
          const briefs = (await this.#get(token, "standup.briefs", { occurrenceId: args["occurrenceId"] })) as unknown as Record<string, unknown>[] | undefined;
          if (briefs === undefined || briefs.length === 0) return refuse("not_found", "that stand-up has no briefs yet; they are made when it is prepared");
          const agents = await this.#listAll(token, "agent.list", { state: "active" });
          const nameOf = (id: unknown): string => String(agents.find((a) => a["principalId"] === id)?.["friendlyName"] ?? id);
          const wanted = typeof agentName === "string" ? agentName.trim().toLowerCase() : "";
          if (wanted === "") return refuse("invalid_command", "Which agent's brief is the note for? Nothing in your message names one.");
          const exact = briefs.filter((b) => nameOf(b["agent"]).trim().toLowerCase() === wanted);
          const chosen = exact.length > 0 ? exact : briefs.filter((b) => looseMatch(wanted, nameOf(b["agent"])));
          if (chosen.length === 0) return refuse("not_found", `no brief in that stand-up is for an agent called ${quotedText(wanted, 80)}`);
          if (chosen.length > 1) return { ok: false, kind: "ask", question: "Whose brief do you mean?", options: chosen.slice(0, CHAT_LIMITS.options).map((b) => `${String(b["id"])} (${nameOf(b["agent"]).slice(0, 60)})`), field: "briefId", choices: chosen.slice(0, CHAT_LIMITS.options).map((b) => String(b["id"])) };
          args["briefId"] = String(chosen[0]!["id"]);
          args["expectedRevision"] = chosen[0]!["revision"];
          delete args["occurrenceId"];
          labels[String(args["briefId"])] = `${nameOf(chosen[0]!["agent"]).slice(0, 80)}'s brief`;
        }
      }
      // A brief belongs to its stand-up, and the operation takes the brief alone; the occurrence only served to find it.
      if (isNote) delete args["occurrenceId"];
    }
    // The owner's other meeting controls (card M02h): the motion, meeting or decision is found among those the records list for the owner, by the owner's words.
    if (intent.op === "meeting.floor.ask" || intent.op === "meeting.floor.address") {
      const agentName = args["agentName"];
      delete args["agentName"];
      if (agentName !== undefined && args["agent"] !== undefined) return refuse("invalid_command", "the agent is named twice over, as agent and as agentName; which one is meant has to be settled.");
      if (agentName !== undefined && typeof agentName !== "string") return refuse("invalid_command", "agentName must be the agent's name as the owner said it");
      if (typeof agentName === "string" && agentName.trim() !== "") {
        const agents = await this.#listAll(token, "agent.list", { state: "active" });
        const wanted = agentName.trim().toLowerCase();
        const exact = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === wanted);
        const found = exact.length > 0 ? exact : agents.filter((a) => looseMatch(wanted, String(a["friendlyName"])));
        if (found.length === 0) return refuse("not_found", `no active agent is called ${quotedText(agentName.trim(), 80)}`);
        if (found.length > 1) return { ok: false, kind: "ask", question: `More than one agent fits ${quotedText(agentName.trim(), 80)}. Which one do you mean?`, options: found.slice(0, CHAT_LIMITS.options).map((a) => String(a["friendlyName"]).slice(0, 60)) };
        args["agent"] = `agent:${String(found[0]!["id"])}`;
        labels[String(args["agent"])] = String(found[0]!["friendlyName"]).slice(0, 80);
      }
      if (intent.op === "meeting.floor.ask" && args["agent"] === undefined) return refuse("invalid_command", "which agent should be asked? Name it.");
    }
    if (intent.op === "meeting.floor.priorities") {
      const topic = args["agendaTopic"];
      const urgency = args["urgency"];
      delete args["agendaTopic"]; delete args["urgency"];
      if (typeof topic !== "string" || topic.trim() === "") return refuse("invalid_command", "which agenda item? Say it in your own words.");
      if (urgency !== "urgent" && urgency !== "normal") return refuse("invalid_command", "urgency is urgent or normal");
      const open = await this.#listAll(token, "agenda.list", { projectId });
      const wanted = topic.trim().toLowerCase();
      const matches = open.filter((i) => String(i["topic"]).toLowerCase().includes(wanted));
      if (matches.length === 0) return refuse("not_found", `no open agenda item about ${quotedText(topic, 80)} in that project`);
      if (matches.length > 1) return { ok: false, kind: "ask", question: "Which agenda item do you mean?", options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${String(m["id"])} (${String(m["topic"]).slice(0, 60)})`), field: "agendaTopic", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => String(m["topic"])) };
      args["items"] = [{ itemId: String(matches[0]!["id"]), urgency }];
      delete args["projectId"];
      labels[String(matches[0]!["id"])] = String(matches[0]!["topic"]);
    }
    if (MEETING_CONTROLS.has(intent.op)) {
      const refused = await this.#resolveMeetingControl(token, intent.op, args, labels, fillNotes, projectId, words);
      if (refused !== undefined) return refused;
    }
    // A meeting named by its words (the one planned meeting of the project whose title contains them, or the only one) and an agent named by its name: both are resolved from the records, and anything unclear asks.
    if (intent.op === "meeting.invite-direct" || intent.op === "meeting.attend.wake" || intent.op === "meeting.attend.wake-stop") {
      const topic = args["meetingTopic"];
      const agentName = args["agentName"];
      delete args["meetingTopic"];
      delete args["agentName"];
      if (topic !== undefined && args["occurrenceId"] !== undefined) return refuse("invalid_command", "the meeting is named twice over, as occurrenceId and as meetingTopic; which one is meant has to be settled.");
      if (agentName !== undefined && args["agent"] !== undefined) return refuse("invalid_command", "the agent is named twice over, as agent and as agentName; which one is meant has to be settled.");
      if ((topic !== undefined && typeof topic !== "string") || (agentName !== undefined && typeof agentName !== "string")) return refuse("invalid_command", "meetingTopic and agentName must be text");
      if (typeof args["occurrenceId"] === "string") {
        const planned = await this.#listAll(token, "meeting.planned", { projectId });
        if (!planned.some((i) => i["id"] === args["occurrenceId"])) return refuse("not_found", "that meeting is not planned in this project");
      }
      if (args["occurrenceId"] === undefined) {
        const planned = await this.#listAll(token, "meeting.planned", { projectId });
        const words = typeof topic === "string" ? topic.trim().toLowerCase() : "";
        const matches = planned.filter((i) => words === "" || String(i["title"]).toLowerCase().includes(words));
        if (matches.length === 0) return refuse("not_found", words === "" ? "no meeting is planned in that project" : `no planned meeting is called ${quotedText(words, 80)}`);
        if (matches.length > 1) return { ok: false, kind: "ask", question: "Which meeting do you mean?", options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${String(m["id"])} (${String(m["title"]).slice(0, 60)}, ${String(m["startsAt"])})`), field: "occurrenceId", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => String(m["id"])) };
        args["occurrenceId"] = String(matches[0]!["id"]);
      }
      if (args["agent"] === undefined) {
        if (typeof agentName !== "string" || agentName.trim() === "") return refuse("invalid_command", "Which agent should attend? Nothing in your message names one.");
        const agents = await this.#listAll(token, "agent.list", { state: "active" });
        const named = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === agentName.trim().toLowerCase());
        if (named.length !== 1) return refuse(named.length === 0 ? "not_found" : "invalid_command", named.length === 0 ? `no active agent called ${quotedText(agentName, 80)}` : `more than one agent is called ${quotedText(agentName, 80)}`);
        args["agent"] = String(named[0]!["principalId"]);
        labels[String(args["agent"])] = agentName.trim();
      }
    }
    // A watch: the stream is the named task's own unless another task is named (`watchedTaskTitle`, exactly one task of the project); the task whose owner is told is the one named in the usual way.
    if (intent.op === "watch.create") {
      const watched = args["watchedTaskTitle"];
      delete args["watchedTaskTitle"];
      // The whole project's stream (card H13f: where a source defined for the project reports), the project being the one in focus.
      const wholeProject = args["watchProject"];
      delete args["watchProject"];
      if (wholeProject !== undefined && wholeProject !== true && wholeProject !== false) return refuse("invalid_command", "watchProject must be true or false");
      if (wholeProject === true) {
        if (args["stream"] !== undefined || watched !== undefined || args["watchedTaskId"] !== undefined) return refuse("invalid_command", "what to watch is given twice over, as watchProject and as the task to watch; only one of them can be used.");
        args["stream"] = `project:${projectId}`;
      }
      if (typeof args["watchedTaskId"] === "string" && args["stream"] === undefined) {
        const t = await this.#get(token, "task.get", { taskId: args["watchedTaskId"] });
        if (t === undefined || t["projectId"] !== projectId) return refuse("not_found", "that task is not in this project");
        args["stream"] = `task:${args["watchedTaskId"]}`;
      }
      delete args["watchedTaskId"];
      if (args["stream"] !== undefined && watched !== undefined) return refuse("invalid_command", "what to watch is given twice over, as stream and as watchedTaskTitle; only one of them can be used.");
      if (typeof args["taskId"] !== "string") return refuse("invalid_command", "Which task's owner should be told? Nothing in your message names one.");
      if (args["stream"] === undefined) {
        if (watched === undefined) args["stream"] = `task:${args["taskId"]}`;
        else {
          if (typeof watched !== "string" || watched.length === 0) return refuse("invalid_command", "watchedTaskTitle must be text");
          const matches = await this.#tasksByTitle(token, projectId as string, watched);
          if (matches.length === 0) return refuse("not_found", `no task called ${quotedText(watched, 80)} in that project`);
          if (matches.length > 1) return { ok: false, kind: "ask", question: `More than one task is called ${quotedText(watched, 80)}. Which one?`, options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${m.id} (${m.state})`), field: "watchedTaskId", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => m.id) };
          args["stream"] = `task:${(matches[0] as { id: string }).id}`;
        }
      }
    }
    // A watch to end: found as the one that tells the named task's owner (exactly one, else the owner is asked); an ID given directly must be an active watch.
    if (intent.op === "watch.cancel") {
      const active = await this.#listItems(token, "watch.describe");
      const inScope = (w: Record<string, unknown>): boolean => focus.projectId === undefined || w["projectId"] === focus.projectId;
      if (typeof args["watchId"] === "string") {
        if (!active.some((w) => w["id"] === args["watchId"] && inScope(w))) return refuse("not_found", "that watch is not active");
        showFirst = "the watch comes from an ID, not from the task you named, so it is shown first";
      }
      else {
        if (typeof args["taskId"] !== "string") return refuse("invalid_command", "Which task's watch should end? Nothing in your message names one.");
        const mine = active.filter((w) => w["taskId"] === args["taskId"] && inScope(w));
        if (mine.length === 0) return refuse("not_found", "no watch is active for that task");
        if (mine.length > 1) return { ok: false, kind: "ask", question: "More than one watch tells that task's owner. Which one?", options: mine.slice(0, CHAT_LIMITS.options).map((w) => `${String(w["id"])} (${String(w["stream"])})`), field: "watchId", choices: mine.slice(0, CHAT_LIMITS.options).map((w) => String(w["id"])) };
        args["watchId"] = String(mine[0]!["id"]);
      }
      delete args["taskId"];
    }
    // A source defined in chat (card H13f): what is looked at (a path) or asked (an address) must be in the owner's own words, so the model cannot point the controller somewhere the owner did not say.
    if (intent.op === "events.sources.define") {
      for (const field of ["path", "url"] as const) {
        const value = args[field];
        if (value !== undefined && (typeof value !== "string" || value.length === 0 || !words.includes(value))) return refuse("invalid_command", `the ${field === "path" ? "path" : "address"} to watch must be written in your message exactly as it should be used`);
      }
    }
    // Revoking a tool version (owner decision 2026-10-30): when calls of it are running, the owner is asked whether they finish, are cancelled, or their tasks are paused; the calls are listed. Nothing is assumed: the answer is the owner's.
    const notes: string[] = [];
    if (intent.op === "catalog.revoke") {
      // ASSUMPTION (2026-11-07): a choice is taken without asking only when the owner said the word; a choice the model supplied that the owner did not say is dropped, so the question below is asked instead of the move being refused.
      if (args["runningCalls"] !== undefined && !(typeof args["runningCalls"] === "string" && ["finish", "cancel", "pause"].includes(args["runningCalls"]) && SAID_CHOICE[args["runningCalls"] as "finish" | "cancel" | "pause"].test(words))) delete args["runningCalls"];
      if (typeof args["name"] !== "string" || typeof args["version"] !== "string") return refuse("invalid_command", "Which tool should be revoked, and which version of it? Nothing in your message names them.");
      const found = await this.#deps.api.handle(token, { v: API_VERSION, op: "catalog.running", args: { name: args["name"], version: args["version"] } });
      if (!found.ok) return refuse(found.error.code, found.error.message);
      const running = (found.result["items"] ?? []) as { attemptId: string; callId: string; taskId: string; agentId: string; elsewhere?: boolean }[];
      const total = typeof found.result["total"] === "number" ? Math.max(found.result["total"], running.length) : running.length;
      const listed = running.slice(0, 10).map((r) => `call ${String(r.callId).slice(0, 40)} of task ${String(r.taskId).slice(0, 60)} (agent ${String(r.agentId).slice(0, 60)})${r.elsewhere === true ? " in another controller process" : ""}`);
      const more = total > listed.length ? ` and ${total - listed.length} more` : "";
      if (total > 0) notes.push(`${total} running ${total === 1 ? "call" : "calls"} of ${args["name"].slice(0, 80)} ${args["version"].slice(0, 20)}: ${listed.join("; ")}${more}.`.slice(0, CHAT_LIMITS.line - 10));
      // Card T02d close-out: when the record of other processes' calls could not be read, the owner is told rather than shown "nothing is running" as a fact.
      // Review: and asked, even when none runs here, so a choice is recorded for any that do run there (without the question none could be made, and they followed the standing policy behind the owner's back).
      const unknownElsewhere = found.result["elsewhereUnknown"] === true;
      if (unknownElsewhere) notes.push(`${total > 0 ? "Calls" : "No call is running in this controller process, but calls"} running in another controller process on this store could not be checked just now; any there follow your choice, or the standing policy if you make none.`);
      notes.push("A version is revoked once: choosing finish cannot be changed to cancel or pause later. Cancel and pause reach every running call when they are carried out, including calls that start before you accept.");
      if (args["runningCalls"] === undefined) {
        if (total > 0 || unknownElsewhere) return { ok: false, kind: "ask", question: `${notes[0]!.slice(0, 380)} ${total > 0 ? "Should they finish" : "If any run there, should they finish"}, be cancelled, or should their tasks be paused? (A cancelled call ends as failed. A pause stops the call too, so nothing the revoked tool writes reaches the agent, and it also pauses the task: the agent does nothing more until you resume it.)`, options: ["finish: let them end on the version they started with", "cancel: stop them now; each ends as failed", "pause: stop each call and pause its task; you decide when to resume"], field: "runningCalls", choices: ["finish", "cancel", "pause"] };
        // Nothing is running now: no choice is recorded, so a call that slips in before the owner accepts follows the standing policy in force (the owner's setting, or the operator's), which is told here.
        const standing = await this.#get(token, "catalog.policy.get", {});
        const effective = typeof standing?.["effective"] === "string" ? String(standing["effective"]) : "cancel";
        notes.push(`No call is running now; one that starts before you accept follows the standing policy: ${effective}${standing?.["source"] === "operator" ? " (set by the operator at startup)" : ""}.`);
      }
    }
    // Taking a right back (follow-up to card T7): the owner is shown the running work that may rely on it, from the same read as the page and the status answer, so a typed request and the page's button say the same.
    // A read that fails is said so rather than shown as "nothing relies on it".
    if (intent.op === "grant.revoke" && typeof args["grantId"] === "string") {
      const found = await this.#deps.api.handle(token, { v: API_VERSION, op: "grant.reliance", args: { grantId: args["grantId"] } });
      const first = found.ok ? (found.result["items"] as Reliance[] | undefined)?.[0] : undefined;
      if (first !== undefined) notes.push(...relianceLines(first));
      else if (!found.ok && found.error.code !== "not_found" && found.error.code !== "invalid_command") notes.push("Which running work relies on this right could not be checked just now; work that does may stop at its next check.");
    }
    // A model window too small to start a task (card "Fixed-part sizing after T08", follow-up): the owner reads the warning in the proposal, before saying yes, not only in the answer after it. The same rule as the
    // first-call admission decides it (`smallWindowWarning`): a new provider's routes have no reply limit, so the hosts' usual reply room counts; a reply limit counts with the route's stored window.
    if (intent.op === "routing.provider.add" && Array.isArray(args["providers"])) {
      for (const p of args["providers"].slice(0, 10)) {
        if (p === null || typeof p !== "object") continue;
        const { name, contextTokens } = p as Record<string, unknown>;
        if (typeof contextTokens !== "number" || !Number.isSafeInteger(contextTokens) || contextTokens < MIN_WORKABLE_CONTEXT_TOKENS || contextTokens > ROUTING_LIMITS.contextTokens) continue;
        const warning = smallWindowWarning(contextTokens);
        if (warning !== undefined) notes.push(`Provider ${typeof name === "string" && PROVIDER_NAME.test(name) ? name : "(unnamed)"}: ${warning}`);
      }
    }
    if (intent.op === "routing.budget.set" && typeof args["route"] === "string" && Object.hasOwn(args, "maxTokens")) {
      const limit = args["maxTokens"];
      const read = limit === null || (typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1 && limit <= ROUTING_LIMITS.maxTokens) ? await this.#deps.api.handle(token, { v: API_VERSION, op: "routing.budgets", args: {} }) : undefined;
      const entry = read?.ok === true ? (read.result["routes"] as { route: string; contextTokens: number }[] | undefined)?.find((r) => r.route === args["route"]) : undefined;
      const warning = entry === undefined ? undefined : smallWindowWarning(entry.contextTokens, limit === null ? DEFAULT_REPLY_TOKENS : (limit as number));
      if (warning !== undefined) notes.push(`Route ${entry!.route}: ${warning}`);
    }
    if (intent.op === "catalog.policy.change") {
      const standing = await this.#get(token, "catalog.policy.get", {});
      if (standing?.["source"] === "operator") notes.push(`The operator set this at startup (${String(standing["effective"])}); your setting is saved but does not apply until that startup option is removed.`);
    }
    // Retiring an agent or archiving a project (card P06): the agent is named by its name, and the confirmation is the digest of a preview made NOW (never the interpreter's), so the owner's yes is bound to what is shown.
    // A plan that is blocked (live assignments, active responsibilities) is not proposed at all: the owner is told what to release or transfer first.
    if (intent.op === "retirement.agent" || intent.op === "retirement.project") {
      delete args["confirm"];
      const agentOp = intent.op === "retirement.agent";
      if (agentOp) {
        const named = args["agentName"];
        delete args["agentName"];
        if (named !== undefined && args["agentId"] !== undefined) return refuse("invalid_command", "the agent is named twice over, as agentId and as agentName; which one is meant has to be settled.");
        if (args["agentId"] === undefined) {
          if (typeof named !== "string" || named.trim() === "") return refuse("invalid_command", "Which agent should be retired? Nothing in your message names one.");
          const agents = await this.#listAll(token, "agent.list", { state: "active" });
          const wanted = named.trim().toLowerCase();
          const exact = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === wanted);
          const found = exact.length > 0 ? exact : agents.filter((a) => looseMatch(wanted, String(a["friendlyName"])));
          if (found.length !== 1) return refuse(found.length === 0 ? "not_found" : "invalid_command", found.length === 0 ? `no active agent is called ${quotedText(named, 80)}` : `more than one agent fits ${quotedText(named, 80)}; say which`);
          args["agentId"] = String(found[0]!["id"]);
          labels[String(found[0]!["id"])] = String(found[0]!["friendlyName"]).slice(0, 80);
        }
      }
      const subject = agentOp ? args["agentId"] : args["projectId"];
      if (typeof subject !== "string") return refuse("invalid_command", agentOp ? "Which agent should be retired? Nothing in your message names one." : "Which project should be archived? Nothing in your message names one.");
      const found = await this.#deps.api.handle(token, { v: API_VERSION, op: "retirement.preview", args: { kind: agentOp ? "agent" : "project", id: subject } });
      if (!found.ok) return refuse(found.error.code, found.error.message);
      const item = found.result["item"] as { digest?: unknown; blockers?: unknown[] };
      if (typeof item.digest !== "string") return refuse("invalid_command", "the retirement could not be previewed just now");
      const shown = (found.result["shown"] as string[] | undefined)?.[0] ?? "see the preview";
      if ((item.blockers ?? []).length > 0) return refuse("invalid_transition", shown);
      args["confirm"] = item.digest;
      if (args["reason"] === undefined) args["reason"] = "requested by the owner in chat";
      fillNotes.push(`What this would do, worked out just now: ${shown}`);
    }
    // Pause, resume and stop by words: the owner's own words name the scope (an agent, a team, a task of the project in focus, or everything); nothing is guessed, and the API's nested `scope` is built here from what was found.
    if (LIFECYCLE_OPS.has(intent.op)) {
      const found = await this.#lifecycleScope(token, args, words, focus, intent.op);
      if (!found.ok) return found;
      delete args["scopeKind"];
      delete args["scopeName"];
      args["scope"] = found.scope;
      labels[found.scope.id] = found.label;
      extraTargets.push(found.label);
      if (typeof args["reason"] !== "string" || args["reason"].trim() === "") args["reason"] = "requested by the owner in chat";
      if (intent.op === "lifecycle.stop") {
        if (args["mode"] === undefined) { args["mode"] = "stop"; fillNotes.push("You did not say whether to keep its place: this is a full stop. Say \"suspend\" instead to stop at a saved point."); }
        if (args["mode"] !== "stop" && args["mode"] !== "suspend") return refuse("invalid_command", "mode is stop or suspend");
        fillNotes.push(args["mode"] === "stop" ? "What a stop does: the scope is paused at once, prepared inside a deadline, and then its running work ends, including local processes, swarm children and background jobs. Assignments and goals are untouched and nothing resumes by itself; a resume lifts it." : "What a suspend does: the scope is paused at once and checkpointed; its work is called suspended only after a durable checkpoint. Assignments and goals are untouched and nothing resumes by itself.");
      } else if (args["mode"] !== undefined) return refuse("invalid_command", "mode is an argument of lifecycle.stop only");
      if (found.scope.kind === "installation") fillNotes.push("This reaches every agent, team and task in the whole installation.");
    }
    // A hand-off: the recipient named by the agent's name (exactly one active agent), and, for completing or cancelling, the hand-off itself found as the one going on for the named task.
    if (intent.op === "handoff.prepare" || intent.op === "handoff.takeover") {
      const named = args["toAgentName"];
      delete args["toAgentName"];
      if (named !== undefined && args["to"] !== undefined) return refuse("invalid_command", "the new owner is named twice over, as to and as toAgentName; which one is meant has to be settled.");
      if (args["to"] === undefined) {
        if (typeof named !== "string" || named.trim() === "") return refuse("invalid_command", "Which agent should take the task? Nothing in your message names one.");
        const agents = await this.#listAll(token, "agent.list", { state: "active" });
        const found = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === named.trim().toLowerCase());
        if (found.length !== 1) return refuse(found.length === 0 ? "not_found" : "invalid_command", found.length === 0 ? `no active agent called ${quotedText(named, 80)}` : `more than one agent is called ${quotedText(named, 80)}`);
        args["to"] = { kind: "agent", id: String(found[0]!["id"]) };
        labels[String(found[0]!["id"])] = named.trim();
      }
    }
    // Work given to an agent the owner names by name (card U14e): the owner never has to know an agent's ID. The name is looked up in the active agents (exactly one, else asked or refused), and what is shown
    // and confirmed is the agent's name; the owner may also be given as an ID the owner wrote, as before.
    if (intent.op === "task.assign" || intent.op === "task.transfer") {
      const named = args["agentName"];
      delete args["agentName"];
      const key = intent.op === "task.assign" ? "owner" : "to";
      if (named !== undefined && args[key] !== undefined) return refuse("invalid_command", "the agent is named twice over, as an ID and by name; which one is meant has to be settled.");
      if (named !== undefined) {
        if (typeof named !== "string" || named.trim() === "") return refuse("invalid_command", "agentName must be the agent's name as the owner said it");
        const agents = await this.#listAll(token, "agent.list", { state: "active" });
        const exact = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === named.trim().toLowerCase());
        if (exact.length === 0) return refuse("not_found", `no active agent is called ${quotedText(named.trim(), 80)}`);
        if (exact.length > 1) return { ok: false, kind: "ask", question: `More than one agent is called ${quotedText(named.trim(), 80)}. Which one do you mean?`, options: exact.slice(0, CHAT_LIMITS.options).map((a) => String(a["id"]).slice(0, 60)) };
        args[key] = { kind: "agent", id: String(exact[0]!["id"]) };
        labels[String(exact[0]!["id"])] = named.trim();
      }
    }
    // Moving an agent to another version of a shared tool (card T08): the agent named by its name (exactly one active agent, else asked or refused), or everyone pinned to the tool.
    if (intent.op === "toolbox.optin") {
      const named = args["agentName"];
      delete args["agentName"];
      if (named !== undefined && args["agentId"] !== undefined) return refuse("invalid_command", "the agent is named twice over, as an ID and by name; which one is meant has to be settled.");
      if (named !== undefined && args["everyone"] !== undefined) return refuse("invalid_command", "one agent and everyone are both named; which one is meant has to be settled.");
      if (named !== undefined) {
        if (typeof named !== "string" || named.trim() === "") return refuse("invalid_command", "agentName must be the agent's name as the owner said it");
        const agents = await this.#listAll(token, "agent.list", { state: "active" });
        const exact = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === named.trim().toLowerCase());
        if (exact.length === 0) return refuse("not_found", `no active agent is called ${quotedText(named.trim(), 80)}`);
        if (exact.length > 1) return { ok: false, kind: "ask", question: `More than one agent is called ${quotedText(named.trim(), 80)}. Which one do you mean?`, options: exact.slice(0, CHAT_LIMITS.options).map((a) => String(a["id"]).slice(0, 60)) };
        args["agentId"] = String(exact[0]!["id"]);
        labels[String(exact[0]!["id"])] = named.trim();
      }
      if (args["agentId"] === undefined && args["everyone"] === undefined) return refuse("invalid_command", "Which agent should move to that version, or should every agent using the tool move?");
    }
    if (intent.op === "resume.retry" || intent.op === "resume.cancel") {
      // The owner names the task; the check is always the one the task has now, so what is shown (the task) and what is acted on (its check) are the same. A check ID the interpreter put in is
      // never acted on by itself: it must be the named task's current check. Nothing is guessed when the task has none.
      if (typeof args["taskId"] !== "string") return refuse("invalid_command", "Which task's resume check is this about? Nothing in your message names one.");
      const current = await this.#get(token, "resume.for-task", { taskId: args["taskId"] });
      if (current === undefined) return refuse("not_found", "that task has no resume check");
      if (args["checkId"] !== undefined && args["checkId"] !== current["id"]) return refuse("invalid_command", "that resume check is not the named task's current one; name the task only");
      args["checkId"] = String(current["id"]);
      const t = await this.#get(token, "task.get", { taskId: args["taskId"] });
      if (typeof t?.["title"] === "string") extraTargets.push(t["title"]);
      delete args["taskId"];
    }
    if (intent.op === "handoff.complete" || intent.op === "handoff.cancel") {
      if (args["handoffId"] === undefined) {
        if (typeof args["taskId"] !== "string") return refuse("invalid_command", "Which task's hand-off is this about? Nothing in your message names one.");
        const going = await this.#get(token, "handoff.for-task", { taskId: args["taskId"] });
        if (going === undefined) return refuse("not_found", "that task has no hand-off going");
        args["handoffId"] = String(going["id"]);
      }
      if (typeof args["taskId"] === "string") {
        const t = await this.#get(token, "task.get", { taskId: args["taskId"] });
        if (typeof t?.["title"] === "string") extraTargets.push(t["title"]);
      }
      delete args["taskId"];
    }
    // A project argument belongs only to the operations that take one (the others only used it to find the task).
    if ("projectId" in args && !acceptedForOp(intent.op).includes("projectId")) delete args["projectId"];

    // The task, as it is now: its project, repository and revision.
    let task: { projectId: string; repositoryId?: string; revision: number; title: string; state: string } | undefined;
    if (typeof args["taskId"] === "string") {
      const item = await this.#get(token, "task.get", { taskId: args["taskId"] });
      if (item === undefined) return refuse("not_found", "no such task");
      task = { projectId: item["projectId"] as string, ...(typeof item["repositoryId"] === "string" ? { repositoryId: item["repositoryId"] } : {}), revision: item["revision"] as number, title: item["title"] as string, state: item["state"] as string };
      labels[args["taskId"]] = task.title;
      projectId = task.projectId;
    }
    if (typeof args["prerequisiteId"] === "string") {
      const item = await this.#get(token, "task.get", { taskId: args["prerequisiteId"] });
      if (item === undefined) return refuse("not_found", "no such task");
      labels[args["prerequisiteId"]] = item["title"] as string;
    }

    if (typeof args["agentId"] === "string") {
      const agent = await this.#get(token, "agent.get", { agentId: args["agentId"] });
      if (typeof agent?.["friendlyName"] === "string") labels[args["agentId"]] = agent["friendlyName"];
    }

    // A standing-rule proposal is named by what accepting it would let stand (card U08 review): the ID alone would not tell the owner which agent, class of action, project and environment a grant covers,
    // and the ID is not checked against their words, so the line they confirm must say it.
    if ((intent.op === "approval.proposal.accept" || intent.op === "approval.proposal.dismiss") && typeof args["proposalId"] === "string") {
      const r = await this.#deps.api.handle(token, { v: API_VERSION, op: "approval.proposals", args: {} });
      const p = r.ok ? (r.result["items"] as Record<string, unknown>[] | undefined)?.find((x) => x["id"] === args["proposalId"]) : undefined;
      if (p === undefined) return refuse("not_found", "no such standing-rule proposal");
      const suggested = (p["defaultLength"] as { days?: unknown } | undefined)?.days ?? (p["suggestion"] as { days?: unknown } | undefined)?.days;
      labels[args["proposalId"]] = `${String(p["cls"])} for ${String(p["requester"])} in project ${String(p["projectId"])} (${String(p["environment"])}), approved ${String(p["count"])} times, ${String(p["state"])}${typeof suggested === "number" ? `, suggested ${suggested} days` : ""}`;
    }

    // The revision the owner does not have to quote.
    if (spec.revision !== undefined) {
      const filled = await this.#revisionFor(token, spec.revision, args, task, pending);
      if (!filled.ok) return filled;
      // The controller's own reading stands unless the owner wrote the revision themselves (Q04 follow-up, first review): a number the interpreter supplied that is not in the owner's
      // own words was invented or taken from elsewhere and is replaced, so it can neither refuse nor mislead the command. A revision the owner did write (one a view showed them,
      // "accept it at revision 4") is the version they decided on and is kept as given, so a record that moved since they looked is refused as stale, never applied against the newer one.
      if (filled.name !== undefined && filled.value !== undefined && !ownerWroteNumber(words, args[filled.name])) args[filled.name] = filled.value;
    }

    // A running task keeps its checkout: a different repository for a task that is in progress or has an owner is refused, and otherwise it is a proposal (it is an authority field).
    if (intent.op === "task.update" && typeof args["repositoryId"] === "string" && task !== undefined && args["repositoryId"] !== task.repositoryId) {
      const assignment = await this.#get(token, "assignment.get", { taskId: args["taskId"] });
      if (task.state === "in_progress" || (assignment !== undefined && assignment["state"] === "assigned")) return refuse("task_running", `${quotedText(task.title, 80)} is being worked on and keeps its repository; release it first if it must move`);
      pins.push({ taskId: args["taskId"] as string, projectId: task.projectId, idle: true });
    }

    // Work handed to someone carries an explicit project and repository.
    const chosen = spec.dispatch === true && typeof args["repositoryId"] === "string" ? args["repositoryId"] : undefined;
    if (spec.dispatch === true) delete args["repositoryId"];
    if (spec.dispatch === true && task !== undefined) {
      let repositoryId = task.repositoryId;
      if (repositoryId === undefined) {
        const project = await this.#get(token, "project.get", { projectId: task.projectId });
        const repos = ((project?.["repositories"] ?? []) as { id: string }[]).map((r) => r.id);
        if (chosen !== undefined && repos.includes(chosen)) repositoryId = chosen;
        else if (repos.length === 1) repositoryId = repos[0] as string;
        else return { ok: false, kind: "ask", question: `Which repository should ${quotedText(task.title, 80)} work in?${repos.length === 0 ? " The project has none; add one first." : ""}`, options: repos.slice(0, CHAT_LIMITS.options), ...(repos.length === 0 ? {} : { field: "repositoryId", choices: repos.slice(0, CHAT_LIMITS.options) }) };
        steps.push({ op: "task.update", args: { taskId: args["taskId"], expectedRevision: task.revision + (pending.get(`task:${args["taskId"] as string}`) ?? 0), repositoryId }, commandId: "", key: "repo" });
        pins.push({ taskId: args["taskId"] as string, projectId: task.projectId, repositoryId, repositoryFromStep: "repo", idle: true });
      } else pins.push({ taskId: args["taskId"] as string, projectId: task.projectId, repositoryId });
      labels[repositoryId] = repositoryId;
    }
    // A bind with no location: the record knows it only if exactly one unbound binding of that name exists; otherwise the owner is asked (it cannot be determined).
    let fromRecord = false;
    if (intent.op === "resource.bind" && args["locator"] === undefined) {
      const label = typeof args["label"] === "string" ? args["label"].trim().toLowerCase() : "";
      const old = label === "" || typeof args["projectId"] !== "string" ? [] : (await this.#unboundResources(token, args["projectId"])).filter((r) => String(r["label"]).trim().toLowerCase() === label);
      if (old.length !== 1) return { ok: false, kind: "ask", question: `Where is ${quotedText(typeof args["label"] === "string" ? args["label"] : "it", 80)}? Nothing in your message gives its location (a path or an address).`, options: [] };
      args["locator"] = old[0]!["locator"];
      if (args["kind"] === undefined) args["kind"] = old[0]!["kind"];
      fromRecord = true;
    }
    // Participants may be named by agent name; the name is resolved from records to the agent's principal (exactly one active agent, else refused).
    if (intent.op === "project.plan" && Array.isArray(args["participants"])) {
      const agents = (await this.#listAll(token, "agent.list", { state: "active" }));
      const resolved: unknown[] = [];
      for (const raw of args["participants"] as unknown[]) {
        const entry = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : undefined;
        if (entry === undefined || entry["agentName"] === undefined) { resolved.push(raw); continue; }
        if (entry["principalId"] !== undefined || typeof entry["agentName"] !== "string") return refuse("invalid_command", "a participant is named both as agentName and as principalId; which one is meant has to be settled.");
        const matches = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === (entry["agentName"] as string).trim().toLowerCase());
        if (matches.length !== 1) return refuse(matches.length === 0 ? "not_found" : "invalid_command", matches.length === 0 ? `no active agent called ${quotedText(entry["agentName"] as string, 80)}` : `more than one agent is called ${quotedText(entry["agentName"] as string, 80)}, so which one is meant is not settled`);
        delete entry["agentName"];
        entry["principalId"] = matches[0]!["principalId"];
        resolved.push(entry);
      }
      args["participants"] = resolved;
    }
    // An environment change request (card A09): named by an ID the owner said; deciding it is bound to the request as it is now (its digest and revision are read from the record, never said), and the owner sees what it asks for.
    if (intent.op === "maintenance.decide" || intent.op === "maintenance.revoke" || intent.op === "maintenance.apply") {
      if (typeof args["maintenanceId"] !== "string") return refuse("invalid_command", "Which maintenance request is this about? Nothing in your message names one, and the chat will not invent an ID.");
      const item = await this.#get(token, "maintenance.get", { maintenanceId: args["maintenanceId"] });
      if (item === undefined) return refuse("not_found", "no such maintenance request");
      extraTargets.push(args["maintenanceId"]);
      if (intent.op === "maintenance.decide") {
        if (item["status"] !== "pending") return refuse("invalid_command", `that request is ${String(item["status"]).slice(0, 20)}, not waiting for a decision`);
        args["specDigest"] = item["specDigest"];
        args["expectedRevision"] = item["revision"];
        // The label always shows what is installed from where (name, version, source, a short digest, install scripts) and what is reached; only the free text is cut.
        const spec = (item["spec"] ?? {}) as Record<string, unknown>;
        const pick = (k: string, max: number): string[] => (spec[k] === undefined ? [] : [`${k}=${String(spec[k]).slice(0, max)}`]);
        // What matters comes first and is short (install scripts, the digest, the version); the source is cut last, so the preview's own limit never hides the first four.
        const shown = [...pick("installScripts", 5), ...(typeof spec["digest"] === "string" ? [`digest=${spec["digest"].slice(0, 15)}...`] : []), ...pick("version", 20), ...pick("name", 40), ...pick("site", 80), ...pick("port", 6), ...pick("mountPath", 60), ...pick("resource", 50), ...pick("mode", 6), ...pick("setting", 50), ...pick("source", 90)];
        const free = ["change"].filter((k) => spec[k] !== undefined).map((k) => `${k}: ${String(spec[k]).slice(0, 60)}`);
        labels[String(item["specDigest"])] = `${String(item["agentId"]).slice(0, 50)} asks: ${String(item["kind"])} ${shown.join(" ")}${free.length === 0 ? "" : ` ${free.join(" ")}`}; rollback and reason: see maintenance.get`;
      }
    }
    if (intent.op === "maintenance.site.set" && typeof args["site"] === "string") extraTargets.push(args["site"]);
    // Landing finished work on main with no human step (card P08b, redone the way the flaky release approval was): the owner's wording is never
    // scanned for a phrase and no refusal tells them one to say. The change is drawn up as a proposal that says plainly what will happen and what
    // gates it (the project's own required checks, read from its record) and whether the installation lock stands; confirming that shown proposal
    // is the consent, and nothing is applied until they do.
    if ((intent.op === "integration.set" || intent.op === "integration.default.set" || intent.op === "project.create") && landingOf(args) === "main-automatic") {
      // Whatever form the checks were given in is judged here, so the proposal never shows the record's checks while sending something else: a single check name is that one check, anything else not a list is refused.
      if (typeof args["requiredChecks"] === "string" && (CHECKS as readonly unknown[]).includes(args["requiredChecks"])) args["requiredChecks"] = [args["requiredChecks"]];
      const given = args["requiredChecks"] !== undefined ? args["requiredChecks"] : (args["integration"] as { requiredChecks?: unknown } | undefined)?.requiredChecks;
      // The checks are shown in the proposal, so only the policy's own check names are: anything else is not a check and is refused here, never displayed.
      if (given !== undefined && (!Array.isArray(given) || given.some((x) => !(CHECKS as readonly unknown[]).includes(x)))) return refuse("invalid_command", `requiredChecks must be a list of ${CHECKS.join(", ")}`);
      // An empty list would show the record's checks but set none, which the policy refuses for this landing: it is refused now, before anything is shown.
      if (Array.isArray(given) && given.length === 0) return refuse("invalid_command", "landing on main with no human step needs at least one required check");
      // Shown as the policy stores them: each once, in the policy's order.
      const named = Array.isArray(given) ? CHECKS.filter((c) => (given as unknown[]).includes(c)).join(", ") : undefined;
      const listed = (value: unknown): string | undefined => (Array.isArray(value) && value.length > 0 ? value.map((x) => String(x)).join(", ") : undefined);
      const record = named === undefined && intent.op === "integration.set" && typeof args["project"] === "string" && /^proj-[a-z2-7]{20}$/i.test(args["project"]) ? await this.#get(token, "integration.get", { project: args["project"] }) : undefined;
      const defItem = await this.#get(token, "integration.default.get", {});
      // The checks shown are the ones that will gate the landing when the owner confirms: a project's own record (pinned by its revision, so a change
      // to it in between refuses the stale proposal), else for a new project or the default, the installation default's (pinned likewise) or the profile's.
      let fromRecord: string | undefined;
      if (named === undefined && intent.op === "integration.set" && record !== undefined) {
        fromRecord = listed(record["requiredChecks"]);
        if (typeof record["revision"] === "number") args["expectedRevision"] = record["revision"];
      } else if (named === undefined && intent.op !== "integration.set") {
        fromRecord = listed(defItem?.["requiredChecks"]) ?? listed(profileDefaults(profile).requiredChecks);
        if (intent.op === "integration.default.set" && typeof defItem?.["revision"] === "number") args["expectedRevision"] = defItem["revision"];
        // A default with no checks of its own follows the profile, which the revision above does not pin: the profile's checks that were shown are set with it.
        if (intent.op === "integration.default.set" && fromRecord !== undefined && listed(defItem?.["requiredChecks"]) === undefined) args["requiredChecks"] = fromRecord.split(", ");
        // A new project has no record to pin: the checks shown are written into its section, so what is created is what was shown.
        if (intent.op === "project.create" && fromRecord !== undefined) args["integration"] = { ...(args["integration"] as Record<string, unknown>), requiredChecks: fromRecord.split(", ") };
      }
      const who = intent.op === "project.create" ? "the new project's" : intent.op === "integration.default.set" ? "every new project's" : "this project's";
      const locked = defItem?.["forbidMainAutomatic"] === true;
      fillNotes.push(`What this means: ${who} finished work goes to main on its own once ${named !== undefined ? `its checks (${named})` : fromRecord !== undefined ? `its checks (${fromRecord})` : "the checks it requires"} pass — no person approves each one, so anything that only passed on the integration branch is on main. Confirming this proposal is what turns it on.${locked ? " The installation currently forbids landing on main automatically, so it is refused while that lock stands." : ""}`);
    }
    steps.push({ op: intent.op, args, commandId: "" });
    const raisesSpend = intent.op === "difficulty.set" ? await this.#raisesSpend(token, args) : false;
    const reasonBase = proposalReason(intent.op, args, intent.draft === true, { profile, quoted, raisesSpend, said: ownerSaysMove(intent.op, args, words, ["taskId", "prerequisiteId", "projectId", "agentId"].flatMap((k) => (typeof args[k] === "string" && labels[args[k] as string] !== undefined ? [labels[args[k] as string] as string] : [])).concat(intent.op === "resource.bind" && typeof args["label"] === "string" ? [args["label"]] : []).concat(extraTargets)) });
    const reason = reasonBase ?? showFirst ?? (fromRecord ? "the location comes from an earlier binding, not from your words, so it is shown first" : undefined);
    return { ok: true, steps, pins, labels, ...(projectId === undefined ? {} : { projectId }), ...(reason === undefined ? {} : { reason }), ...(notes.length + fillNotes.length === 0 ? {} : { notes: [...fillNotes, ...notes] }), args, op: intent.op };
  }

  /**
   * The version a decision step is based on when it is applied. Normally the topic as it is now. But when someone else (not this turn) recorded a decision on the topic after the message was planned, the step is
   * based on the version the message saw: that is below the change, so the decision service records a dispute and the later change stands, even for a step that read the topic only now (a turn run again after a crash).
   * What this turn recorded itself is not added: it may have been written in a narrower scope that never saw the change.
   */
  async #decisionBase(token: string, turnId: string, args: Record<string, unknown>, planBase: number | undefined, current: number): Promise<number> {
    if (planBase === undefined) return current;
    const taskId = typeof args["taskId"] === "string" ? args["taskId"] : undefined;
    const history = ((await this.#get(token, "decision.history", { projectId: args["projectId"], topic: args["topic"], ...(taskId === undefined ? {} : { taskId }) })) as unknown as Record<string, unknown>[] | undefined) ?? [];
    for (const e of history) {
      if (e["state"] === "superseded" || (taskId !== undefined && e["taskId"] !== undefined && e["taskId"] !== taskId)) continue;
      const version = typeof e["version"] === "number" ? (e["version"] as number) : 0;
      if (version > planBase && (e["source"] as { turnId?: string } | undefined)?.turnId !== turnId) return planBase;
    }
    return current;
  }

  async #revisionFor(token: string, what: NonNullable<(typeof CHAT_OPS)[string]["revision"]>, args: Record<string, unknown>, task: { revision: number } | undefined, pending: ReadonlyMap<string, number>): Promise<{ ok: true; name?: string; value?: number } | Resolved & { ok: false }> {
    const ahead = (key: string | undefined): number => (key === undefined ? 0 : pending.get(key) ?? 0);
    switch (what) {
      case "task": return task === undefined ? refuse("invalid_command", "taskId is required") : { ok: true, name: "expectedRevision", value: task.revision + ahead(`task:${args["taskId"] as string}`) };
      case "project": {
        const item = typeof args["projectId"] === "string" ? await this.#get(token, "project.get", { projectId: args["projectId"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such project") : { ok: true, name: "expectedRevision", value: (item["revision"] as number) + ahead(`project:${args["projectId"] as string}`) };
      }
      case "agent": {
        const item = typeof args["agentId"] === "string" ? await this.#get(token, "agent.get", { agentId: args["agentId"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such agent") : { ok: true, name: "expectedRevision", value: (item["revision"] as number) + ahead(`agent:${args["agentId"] as string}`) };
      }
      case "assignment": {
        const item = typeof args["taskId"] === "string" ? await this.#get(token, "assignment.get", { taskId: args["taskId"] }) : undefined;
        // A task never assigned has no assignment revision to expect (that is how a first assignment is asked for).
        return item === undefined ? { ok: true } : { ok: true, name: "expectedRevision", value: item["revision"] as number };
      }
      case "responsibility": {
        const item = typeof args["responsibilityId"] === "string" ? await this.#get(token, "responsibility.get", { responsibilityId: args["responsibilityId"] }) : undefined;
        const revision = (item?.["item"] as { revision?: number } | undefined)?.revision ?? (item?.["revision"] as number | undefined);
        return revision === undefined ? refuse("not_found", "no such responsibility") : { ok: true, name: "expectedRevision", value: revision + ahead(`responsibility:${args["responsibilityId"] as string}`) };
      }
      case "agenda": {
        const item = typeof args["itemId"] === "string" ? await this.#get(token, "agenda.get", { itemId: args["itemId"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such agenda item") : { ok: true, name: "expectedRevision", value: (item["revision"] as number) + ahead(`agenda:${args["itemId"] as string}`) };
      }
      case "standup": {
        const item = typeof args["scheduleId"] === "string" ? await this.#get(token, "standup.get", { scheduleId: args["scheduleId"] }) : undefined;
        const revision = (item?.["schedule"] as { revision?: number } | undefined)?.revision;
        return revision === undefined ? refuse("not_found", "no such stand-up") : { ok: true, name: "expectedRevision", value: revision + ahead(`standup:${args["scheduleId"] as string}`) };
      }
      case "decision": {
        // The version of the topic the owner's session sees now (0 when nothing was decided): the newest live version that applies to the scope (task-level ones count for a project-wide decision), so a decision that moved meanwhile is never overwritten.
        if (typeof args["projectId"] !== "string" || typeof args["topic"] !== "string") return refuse("invalid_command", "a decision needs a project and a topic");
        const taskId = typeof args["taskId"] === "string" ? args["taskId"] : undefined;
        const history = ((await this.#get(token, "decision.history", { projectId: args["projectId"], topic: args["topic"], ...(taskId === undefined ? {} : { taskId }) })) as unknown as Record<string, unknown>[] | undefined) ?? [];
        const relevant = history.filter((e) => e["state"] !== "superseded" && (taskId === undefined || e["taskId"] === undefined || e["taskId"] === taskId));
        if (relevant.some((e) => e["state"] === "disputed")) return refuse("invalid_command", "that topic is in dispute between two of your instructions; settle the dispute first");
        const version = relevant.reduce((m, e) => Math.max(m, typeof e["version"] === "number" ? (e["version"] as number) : 0), 0);
        // Decisions of this message not yet applied count only where they apply to this one: a project-wide one applies to all, a task's own to that task and to project-wide ones.
        const base = `decision:${args["projectId"] as string}:${normalTopic(args["topic"] as string)}:`;
        let before = 0;
        for (const [key, n] of pending) { if (!key.startsWith(base)) continue; const scope = key.slice(base.length); if (scope.includes(":")) continue; if (taskId === undefined || scope === "*" || scope === taskId) before += n; }
        return { ok: true, name: "basedOn", value: version + before };
      }
      case "grant": {
        const item = typeof args["grantId"] === "string" ? await this.#get(token, "grant.get", { grantId: args["grantId"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such grant") : { ok: true, name: "expectedRevision", value: item["revision"] as number };
      }
      case "notifications": {
        // Settings never made have no revision to expect (the operation takes that as 0).
        const item = await this.#get(token, "notifications.settings", {});
        return item === undefined || typeof item["revision"] !== "number" ? { ok: true } : { ok: true, name: "expectedRevision", value: item["revision"] + ahead("notifications") };
      }
      case "retention": {
        // Never set: the operation takes 0.
        const item = await this.#get(token, "retention.settings.get", {});
        return { ok: true, name: "expectedRevision", value: (typeof item?.["revision"] === "number" ? (item["revision"] as number) : 0) + ahead("retention") };
      }
      case "standing-proposal": {
        // The proposal's revision now (cards A07b, U08); a proposal that is not the owner's to see, or does not exist, is not found.
        const r = typeof args["proposalId"] === "string" ? await this.#deps.api.handle(token, { v: API_VERSION, op: "approval.proposals", args: {} }) : undefined;
        const found = r !== undefined && r.ok ? (r.result["items"] as { id: string; revision: number }[] | undefined)?.find((x) => x.id === args["proposalId"]) : undefined;
        return found === undefined ? refuse("not_found", "no such standing-rule proposal") : { ok: true, name: "expectedRevision", value: found.revision };
      }
      case "profile-suggestion": {
        // The suggestion's revision now; 0 before the first answer.
        const item = await this.#get(token, "approval.suggestion", {});
        return item === undefined || typeof item["revision"] !== "number" ? refuse("not_found", "the derived-profile question is not available") : { ok: true, name: "expectedRevision", value: item["revision"] as number };
      }
      case "database-transfer": {
        // The installation settings layer the two switches live in, as it is when the message is planned (0 before anything was set); a change to it before the owner confirms makes the proposal stale (card F04m).
        const item = await this.#get(token, "database.transfer.settings", {});
        return item === undefined || typeof item["revision"] !== "number" ? refuse("forbidden", "only the owner reads and changes the database transfer settings") : { ok: true, name: "expectedRevision", value: item["revision"] as number };
      }
      case "catalog-policy": {
        // Never set: the operation takes 0.
        const item = await this.#get(token, "catalog.policy.get", {});
        return { ok: true, name: "expectedRevision", value: (typeof item?.["revision"] === "number" ? (item["revision"] as number) : 0) + ahead("catalog-policy") };
      }
      case "difficulty-profiles": {
        // Never set: the operation takes 0.
        const item = await this.#get(token, "difficulty.profiles", {});
        return { ok: true, name: "expectedRevision", value: (typeof item?.["revision"] === "number" ? (item["revision"] as number) : 0) + ahead("difficulty-profiles") };
      }
      case "concern": {
        // A stuck agent's concern (card V02c): its revision now; a step or an answer of the same message is not predicted (a second one is refused as stale and asked again).
        const item = typeof args["concernId"] === "string" ? await this.#get(token, "stall.concern.get", { concernId: args["concernId"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such concern") : { ok: true, name: "expectedRevision", value: item["revision"] as number };
      }
      case "experiment": {
        // An experiment's revision when the owner pins, concludes, withdraws or raises it (card B04).
        const item = typeof args["experimentId"] === "string" ? await this.#get(token, "experiment.get", { experimentId: args["experimentId"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such experiment") : { ok: true, name: "expectedRevision", value: (item["revision"] as number) + ahead(`experiment:${args["experimentId"] as string}`) };
      }
      case "lesson": {
        // A lesson's revision when the owner evaluates it (card B03); a second decision on the same lesson in one message expects the next revision.
        const item = typeof args["lessonId"] === "string" ? await this.#get(token, "lesson.get", { lessonId: args["lessonId"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such lesson") : { ok: true, name: "expectedRevision", value: (item["revision"] as number) + ahead(`lesson:${args["lessonId"] as string}`) };
      }
      case "observation": {
        // An observation's revision when the owner settles it (card B02).
        const item = typeof args["observationId"] === "string" ? await this.#get(token, "observation.get", { observationId: args["observationId"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such observation") : { ok: true, name: "expectedRevision", value: (item["revision"] as number) + ahead(`observation:${args["observationId"] as string}`) };
      }
      case "defect": {
        // A defect's revision when the judgement or decision is shown (card Q04): a check, a repair or a decision in between makes the proposal stale, so the owner never judges a version they were not shown.
        const item = typeof args["id"] === "string" ? await this.#get(token, "defect.get", { id: args["id"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such defect") : { ok: true, name: "expectedRevision", value: (item["revision"] as number) + ahead(`defect:${args["id"] as string}`) };
      }
      case "doc-obligation": {
        // A documentation obligation's revision when the replacement or verification is shown (card Q03); a new obligation has none to expect.
        if (args["obligationId"] === undefined) return { ok: true };
        const item = typeof args["obligationId"] === "string" ? await this.#get(token, "doc.obligation.get", { id: args["obligationId"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such documentation obligation") : { ok: true, name: "expectedRevision", value: (item["revision"] as number) + ahead(`doc-obligation:${args["obligationId"] as string}`) };
      }
      case "contract": {
        const item = typeof args["taskId"] === "string" ? await this.#get(token, "contract.get", { taskId: args["taskId"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such task") : { ok: true, name: "expectedVersion", value: (item["version"] as number) + ahead(`contract:${args["taskId"] as string}`) };
      }
    }
  }

  /** The next question about how a new project's work is handled, or undefined when every setting has been given or taken as the default. Each has a plain explanation and a recommendation. */
  async #integrationQuestion(token: string, given: Record<string, unknown>, profile: string): Promise<{ ok: false; kind: "ask"; question: string; options: string[]; field: string; choices: string[] } | undefined> {
    const rec = profileDefaults(profile);
    const def = await this.#deps.api.handle(token, { v: API_VERSION, op: "integration.default.get", args: {} });
    const locked = def.ok && (def.result as { item?: { forbidMainAutomatic?: boolean } }).item?.forbidMainAutomatic === true;
    const ask = (field: string, question: string, rows: { choice: string; says: string }[]) => ({ ok: false as const, kind: "ask" as const, question, options: rows.map((r) => `${r.choice}: ${r.says}`), field: `integration.${field}`, choices: rows.map((r) => r.choice) });
    if (given["landing"] === undefined) {
      const rows = [
        { choice: "integration-branch", says: LANDING_MEANS["integration-branch"]! },
        { choice: "human-promotes", says: LANDING_MEANS["human-promotes"]! },
        ...(locked ? [] : [{ choice: "main-automatic", says: LANDING_MEANS["main-automatic"]! }]),
        { choice: "default", says: `use the installation default (or the ${profile} profile's, which is ${rec.landing})` },
      ];
      return ask("landing", `How should finished work land on this project? I suggest ${rec.landing}.`, rows);
    }
    if (given["integrator"] === undefined) {
      return ask("integrator", `Who integrates finished work, an agent (the integrator role) or a person? I suggest ${rec.integrator}.`, [
        { choice: "agent", says: "an integrator agent merges and resolves refresh conflicts with the author" },
        { choice: "human", says: "a person merges" },
        { choice: "default", says: `use the default (${rec.integrator})` },
      ]);
    }
    if (given["requiredChecks"] === undefined) {
      return ask("requiredChecks", `Which checks must pass before work lands? I suggest ${rec.requiredChecks.join(" and ")}.`, [
        { choice: "tests", says: "automated tests only" },
        { choice: "tests+review", says: "tests and an independent review" },
        { choice: "tests+review+qa", says: "tests, review and a QA pass" },
        { choice: "default", says: `use the default (${rec.requiredChecks.join(" and ")})` },
      ]);
    }
    if (given["refreshRounds"] === undefined) {
      return ask("refreshRounds", `How many times may an author refresh onto newer work before the integrator steps in? I suggest ${rec.refreshRounds}.`, [
        { choice: "1", says: "one refresh" }, { choice: "3", says: "three refreshes" }, { choice: "5", says: "five refreshes" },
        { choice: "default", says: `use the default (${rec.refreshRounds})` },
      ]);
    }
    return undefined;
  }

  async #projectByIntent(token: string, projectId: string | undefined, projectName: string | undefined): Promise<{ ok: true; id: string; name: string } | { ok: false; kind: "ask"; question: string; options: string[]; field?: string; choices?: string[] } | { ok: false; kind: "refuse"; code: string; message: string }> {
    if (projectId !== undefined) {
      const item = PROJECT_ID.test(projectId) ? await this.#get(token, "project.get", { projectId }) : undefined;
      return item === undefined ? { ok: false, kind: "refuse", code: "not_found", message: "no such project" } : { ok: true, id: projectId, name: item["name"] as string };
    }
    const wanted = (projectName ?? "").trim().toLowerCase();
    const all = await this.#listAll(token, "project.list", {});
    const matches = all.filter((p) => (p["name"] as string).trim().toLowerCase() === wanted);
    if (matches.length === 0) return { ok: false, kind: "refuse", code: "not_found", message: `no project called ${quotedText(projectName ?? "", 80)}` };
    if (matches.length > 1) return { ok: false, kind: "ask", question: `More than one project is called ${quotedText(projectName ?? "", 80)}. Which one?`, options: matches.slice(0, CHAT_LIMITS.options).map((p) => p["id"] as string), field: "projectId", choices: matches.slice(0, CHAT_LIMITS.options).map((p) => p["id"] as string) };
    return { ok: true, id: (matches[0] as { id: string })["id"] as string, name: (matches[0] as { name: string })["name"] as string };
  }

  async #askProject(): Promise<Resolved> {
    return { ok: false, kind: "ask", question: "Which project do you mean? There is none in focus.", options: [] };
  }

  /** The project's tasks whose title is exactly the words (case ignored), and those that only contain them. */
  async #taskCandidates(token: string, projectId: string, title: string): Promise<{ exact: { id: string; title: string; state: string }[]; partial: { id: string; title: string; state: string }[] }> {
    const wanted = title.trim().toLowerCase();
    const exact: { id: string; title: string; state: string }[] = []; const partial: { id: string; title: string; state: string }[] = [];
    if (wanted.length === 0) return { exact, partial };
    for (const t of await this.#listAll(token, "task.list", { projectId })) {
      const name = String(t["title"] ?? "");
      const item = { id: t["id"] as string, title: name, state: t["state"] as string };
      const lower = name.trim().toLowerCase();
      if (lower === wanted) exact.push(item); else if (lower.includes(wanted)) partial.push(item);
    }
    return { exact, partial };
  }

  async #tasksByTitle(token: string, projectId: string, title: string): Promise<{ id: string; state: string }[]> {
    const wanted = title.trim().toLowerCase();
    const all = await this.#listAll(token, "task.list", { projectId });
    return all.filter((t) => (t["title"] as string).trim().toLowerCase() === wanted).map((t) => ({ id: t["id"] as string, state: t["state"] as string }));
  }

  /**
   * The scope of a pause, resume or stop named in the owner's words. Nothing is guessed: no scope asks which, an agent or team name must stand as a whole word of the message, several answers ask, none says what is not called that, and the
   * whole installation needs the owner's own word for everything (never the bare order, which also sits in the message). A task is the one titled that in the project in focus.
   */
  async #lifecycleScope(token: string, args: Record<string, unknown>, words: string, focus: { projectId?: string }, op: string): Promise<{ ok: true; scope: { kind: "task" | "agent" | "team" | "installation"; id: string }; label: string } | Extract<Resolved, { ok: false }>> {
    const kind = args["scopeKind"];
    const rawName = args["scopeName"];
    if (args["scope"] !== undefined) return refuse("invalid_command", "scope is built by the chat from scopeKind and scopeName");
    if ((kind !== undefined && typeof kind !== "string") || (rawName !== undefined && typeof rawName !== "string")) return refuse("invalid_command", "scopeKind and scopeName must be text");
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const what = op.slice("lifecycle.".length);
    const choices = ["an agent (say its name)", "a team (say its name)", "a task (say its title)", "everything (the whole installation)"];
    if (kind !== undefined && kind !== "task" && kind !== "agent" && kind !== "team" && kind !== "installation") return { ok: false, kind: "ask", question: `A ${what} is for a task, an agent, a team or the whole installation, not for ${quotedText(kind, 40)}. Which did you mean?`, options: choices };
    if (kind === "installation") {
      if (name === "" || !WHOLE_INSTALLATION_WORDS.test(name) || !wholeWord(words, name)) return { ok: false, kind: "ask", question: `Nothing was done. Do you mean the whole installation, every agent and task? A ${what} of everything needs you to say so in your own words (for example "everything" or "the whole installation"). Otherwise, which agent, team or task?`, options: choices };
      return { ok: true, scope: { kind: "installation", id: "installation" }, label: "the whole installation" };
    }
    if (name === "") return { ok: false, kind: "ask", question: `Nothing was done. What should be ${what === "stop" ? "stopped" : what === "pause" ? "paused" : "resumed"}: an agent, a team, a task or everything? Say which, in a few words.`, options: choices };
    if (kind === "task") {
      if (focus.projectId === undefined) return { ok: false, kind: "ask", question: "Which project is that task in? Nothing was done.", options: [] };
      const { exact, partial } = await this.#taskCandidates(token, focus.projectId, name);
      const candidates = exact.length > 0 ? exact : partial;
      if (candidates.length === 0) return refuse("not_found", `no task called ${quotedText(name, 80)} in that project`);
      if (exact.length !== 1) return { ok: false, kind: "ask", question: exact.length > 1 ? `More than one task is called ${quotedText(name, 80)}. Which one?` : `No task is called ${quotedText(name, 80)}, but ${candidates.length === 1 ? "one task fits" : "these tasks fit"}. Which one do you mean?`, options: candidates.slice(0, CHAT_LIMITS.options).map((m) => `${m.id}: ${quotedText(m.title, 80)} (${m.state})`) };
      return { ok: true, scope: { kind: "task", id: exact[0]!.id }, label: exact[0]!.title };
    }
    const label = kind === undefined ? "agent or team" : kind;
    const { items: all, complete } = await this.#scopeCandidates(token, kind === undefined ? ["agent", "team"] : [kind], true);
    let hit = namesMeant(words, all);
    if (hit.length > 1) { const same = hit.filter((c) => sameName(c.name, name)); if (same.length > 0) hit = same; }
    if (hit.length === 0) {
      const plural = kind === undefined ? "agents or teams" : `${kind}s`;
      return refuse("not_found", !complete ? `no ${label} among the first ${String(all.length)} ${plural} is called ${quotedText(name, 80)}, and there are more. Which did you mean?` : all.length === 0 ? `no ${label} of this installation is called ${quotedText(name, 80)}, and there are no ${plural} at all` : `no ${label} of this installation is called ${quotedText(name, 80)}. Here they are: ${titleList(all.map((c) => c.name))}. Which did you mean?`);
    }
    if (hit.length > 1) return { ok: false, kind: "ask", question: `More than one ${label} here answers to the name in your message. Nothing was done. Which did you mean?`, options: hit.slice(0, CHAT_LIMITS.options).map((f) => `${f.id}: ${quotedText(f.name, 60)} (${f.kind})`) };
    return { ok: true, scope: { kind: hit[0]!.kind, id: hit[0]!.id }, label: hit[0]!.name };
  }

  /** The installation's agents and teams as the owner can name them (card L02e leftover): the kind a lifecycle scope takes, the ID for that scope and the name it goes by. Retired agents are in: what the stop of one cost is a fair thing to ask afterwards. */
  /** `complete` is false when a list was longer than the pages one look reads: a name not found then may still be there, and the owner is told so. */
  async #scopeCandidates(token: string, kinds: readonly ("agent" | "team")[], activeOnly = false): Promise<{ items: { kind: "agent" | "team"; id: string; name: string }[]; complete: boolean }> {
    const out: { kind: "agent" | "team"; id: string; name: string }[] = [];
    let complete = true;
    for (const kind of kinds) {
      const listed = await this.#listPages(token, kind === "agent" ? "agent.list" : "team.list", activeOnly && kind === "agent" ? { state: "active" } : {});
      if (!listed.complete) complete = false;
      for (const item of listed.items) {
        const name = String(kind === "agent" ? item["friendlyName"] ?? "" : item["name"] ?? "").trim();
        const id = String(item["id"] ?? "");
        if (name !== "" && id !== "") out.push({ kind, id, name });
      }
    }
    return { items: out, complete };
  }

  /** The project's unbound resource bindings (the list operation takes no paging). */
  async #unboundResources(token: string, projectId: string): Promise<Record<string, unknown>[]> {
    const response = await this.#deps.api.handle(token, { v: API_VERSION, op: "resource.list", args: { projectId, state: "unbound" } });
    return response.ok ? ((response.result["items"] ?? []) as Record<string, unknown>[]) : [];
  }

  /** A list the operation returns whole (it takes no paging arguments). */
  async #listItems(token: string, op: string): Promise<Record<string, unknown>[]> {
    const response = await this.#deps.api.handle(token, { v: API_VERSION, op, args: {} });
    if (!response.ok) { if (response.error.code === "forbidden" || response.error.code === "not_found") return []; throw new DomainError("unavailable", response.error.message); }
    return (response.result["items"] ?? []) as Record<string, unknown>[];
  }

  /** The `items` of a query that takes no paging arguments (the responsibility, incident and resource lists). */
  async #plainItems(token: string, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const response = await this.#deps.api.handle(token, { v: API_VERSION, op, args });
    if (response.ok) return (response.result["items"] as Record<string, unknown>[] | undefined) ?? [];
    throw new DomainError(response.error.code === "unauthenticated" ? "unauthenticated" : "unavailable", response.error.message);
  }

  /**
   * The rights a bundle stands for (card D01): every capability of the agent's own roles, as the role templates list them now, in the order the roles and their capabilities are written, each once.
   * A right the agent already holds in exactly that scope for good (active, no start, no end, no idle window, no terms, not derived) is left out, so saying it twice gives nothing twice.
   * An agent with no role, a role with no template, a template holding a wildcard or an approval, or nothing left to give is refused with what to do instead; nothing is guessed.
   */
  async #rightsBundle(token: string, agent: { principal: string; name: string; roles: readonly string[] }, args: Readonly<Record<string, unknown>>, projectName: string): Promise<{ ok: true; actions: string[]; note: string } | ReturnType<typeof refuse>> {
    const who = quotedText(agent.name, 80);
    if (agent.roles.length === 0) return refuse("invalid_command", `${who} has no role, so there is no bundle of rights to give. Give ${who} a role first (for example "make ${agent.name} an author"), or name the rights one by one.`);
    const templates = new Map((await this.#listAll(token, "role.list", {})).map((r) => [String(r["name"]), Array.isArray(r["capabilities"]) ? (r["capabilities"] as unknown[]).filter((c): c is string => typeof c === "string") : []]));
    const unknown = agent.roles.find((r) => !templates.has(r));
    if (unknown !== undefined) return refuse("not_found", `the role ${quotedText(unknown, 60)} of ${who} has no template, so what it stands for is not known. Name the rights one by one, or define the role first.`);
    const actions = [...new Set(agent.roles.flatMap((r) => templates.get(r) ?? []))];
    if (actions.length === 0) return refuse("invalid_command", `the roles of ${who} (${agent.roles.join(", ")}) stand for no rights, so there is nothing to give. Name the rights one by one.`);
    // A template may hold a wildcard (`*`, `task.*`); a plain sentence never draws one up (first review): each line of a bundle names one exact right, so the owner sees what each one gives.
    const wide = actions.find((a) => a === "*" || a.endsWith(".*"));
    if (wide !== undefined) return refuse("invalid_command", `the roles of ${who} stand for ${quotedText(wide, 60)}, which covers more than one right, so no bundle was drawn up. Name the rights one by one.`);
    // An approval right (`approve.…`) lets an agent's action through without asking the owner; a plain "let Ann work" sentence never gives one (first review), as an agent never derives one and a meeting never grants one.
    const waiver = actions.find((a) => a.startsWith("approve."));
    if (waiver !== undefined) return refuse("invalid_command", `the roles of ${who} stand for ${quotedText(waiver, 60)}, an approval that lets actions through without asking you, so no bundle was drawn up. Name the rights one by one.`);
    // A right held for good already covers whatever times the new one would have; one that starts later, ends, lapses, rests on another right or holds only under terms (hours, environments, a spend limit) does not.
    // Only the agent's own rights count (second review): the list is asked for by grantee, and each item is checked again, so another agent's right in the project never leaves one of Ann's out.
    const held = new Set((await this.#listAll(token, "grant.list", { grantee: agent.principal }))
      .filter((g) => g["grantee"] === agent.principal && g["state"] === "active" && g["project"] === args["project"] && g["resource"] === undefined && g["notBefore"] === undefined && g["expiresAt"] === undefined && g["idleDays"] === undefined && g["parentId"] === undefined && g["terms"] === undefined)
      .map((g) => String(g["action"])));
    const fresh = actions.filter((a) => !held.has(a));
    const where = quotedText(projectName, 80);
    if (fresh.length === 0) return refuse("invalid_command", `${who} already holds every right of the role${agent.roles.length === 1 ? "" : "s"} ${agent.roles.join(", ")} in ${where}, so nothing was drawn up.`);
    if (fresh.length > GRANT_BUNDLE_LIMIT) return refuse("invalid_command", `the roles of ${who} stand for ${String(fresh.length)} rights, more than the ${String(GRANT_BUNDLE_LIMIT)} one proposal can show. Name the rights you want in smaller groups.`);
    const skipped = actions.filter((a) => held.has(a));
    const note = `These are the rights the role${agent.roles.length === 1 ? "" : "s"} ${agent.roles.join(", ")} of ${who} stand${agent.roles.length === 1 ? "s" : ""} for, each only in ${where}${skipped.length === 0 ? "" : `; already held there and left out: ${skipped.join(", ")}`}. Saying yes gives them all; to give fewer, say no and name the rights you want.`;
    return { ok: true, actions: fresh, note };
  }

  /** Every item of a list operation, bounded (five pages). */
  async #listAll(token: string, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    return (await this.#listPages(token, op, args)).items;
  }

  /** `#listAll` that also says whether the list ended within the pages read (`complete`), or went on past them. */
  async #listPages(token: string, op: string, args: Record<string, unknown>): Promise<{ items: Record<string, unknown>[]; complete: boolean }> {
    const items: Record<string, unknown>[] = [];
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const response = await this.#deps.api.handle(token, { v: API_VERSION, op, args: { ...args, limit: 100, ...(after === undefined ? {} : { after }) } });
      if (!response.ok) { if (response.error.code === "forbidden" || response.error.code === "not_found") return { items, complete: true }; throw new DomainError("unavailable", response.error.message); }
      items.push(...((response.result["items"] ?? []) as Record<string, unknown>[]));
      after = response.result["next"] as string | undefined;
      if (after === undefined) return { items, complete: true };
    }
    return { items, complete: false };
  }

  /** A read through the API: the item, or undefined when it is missing or not readable (the two read alike). */
  /** Whether setting this difficulty moves the task to a profile whose spending limit is higher than the one it has now (an unrated task uses the `unrated` mapping). Clearing never does; anything that cannot be compared counts as yes. */
  async #raisesSpend(token: string, args: Record<string, unknown>): Promise<boolean> {
    try {
      if (typeof args["difficulty"] !== "string") return false;
      const profiles = await this.#get(token, "difficulty.profiles", {}) as { profiles?: Record<string, { spendLimitMicros?: number }>; mapping?: Record<string, string> } | undefined;
      const contract = await this.#get(token, "contract.get", { taskId: args["taskId"] }) as { difficulty?: string } | undefined;
      // A profile with no spendLimitMicros allows paid routes with NO limit (see routing/difficulty.ts: only a limit of 0 forbids them), so it is the highest; no profile at all spends nothing.
      const spendOf = (level: string): number => { const profile = profiles?.profiles?.[profiles.mapping?.[level] ?? ""]; return profile === undefined ? 0 : profile.spendLimitMicros ?? Infinity; };
      return spendOf(args["difficulty"]) > spendOf(contract?.difficulty ?? "unrated");
    } catch { return true; }
  }

  /**
   * The stand-ups a project has set up, ended ones left out (card M03h): their titles, sorted, and each one's title now by its schedule. A stand-up made this morning is one of them even before it has met, which is why this is not read
   * from the meetings; and a meeting keeps the title its stand-up had when it was made, so a renamed stand-up is found by its schedule.
   */
  async #standups(token: string, projectId: string | undefined): Promise<{ titles: string[]; titleOf: Map<string, string> }> {
    if (projectId === undefined) return { titles: [], titleOf: new Map() };
    const listed = await this.#get(token, "standup.list", { projectId, limit: 50 });
    const running = ((listed?.["items"] as Record<string, unknown>[] | undefined) ?? []).filter((s) => s["state"] !== "ended");
    // Sorted, because the order records come back in is not something the owner should see change between one answer and the next.
    return { titles: running.map((s) => String(s["title"])).sort(), titleOf: new Map(running.map((s) => [String(s["scheduleId"]), String(s["title"])])) };
  }

  async #get(token: string, op: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const response = await this.#deps.api.handle(token, { v: API_VERSION, op, args });
    if (response.ok) return response.result["item"] as Record<string, unknown>;
    if (response.error.code === "not_found" || response.error.code === "forbidden") return undefined;
    throw new DomainError(response.error.code === "unauthenticated" ? "unauthenticated" : "unavailable", response.error.message);
  }

  async #focus(token: string, projectId: string | undefined): Promise<{ projectId?: string; projectName?: string }> {
    if (projectId === undefined) return {};
    const item = await this.#get(token, "project.get", { projectId });
    return item === undefined ? {} : { projectId, projectName: item["name"] as string };
  }

  // ---- doing -----------------------------------------------------------------------------------------------------------------

  async #execute(owner: Principal, token: string, turnId: string, turn: TurnBody, guard?: Guard): Promise<TurnBody> {
    const outcomes: Outcome[] = [];
    // Before each part of the plan (the state-changing step) the caller's own authority is looked at again: a request whose browser session was revoked while it ran stops here.
    for (const item of turn.plan) { await guard?.(); outcomes.push(await this.#do(owner, token, turnId, item, turn.text, guard)); }
    const done: TurnBody = fitAnswers({ ...turn, status: "done", outcomes, completedAt: this.#runner.now() });
    // The model's thinking quoted in an answer (card U09b) is shown now and not kept in the turn or the project's context line: the copy the controller keeps is removed by retention (thinking-days), and a copy in the chat would outlive it.
    const kept = withoutThinkingText(done);
    try {
      await this.#finishTurn(owner, turnId, kept);
    } catch (error) {
      // A database transfer applied by this very message fences the database the turn lives in (card F04m): the move was made, and the note that the turn is done cannot be written to the database that was just retired.
      // The owner is told it was applied. The turn stays unfinished in the new database and the records that would follow (the project's context line, the resumed question) are not written; nothing writes them later (card F04m).
      if (error instanceof DomainError && error.code === "stale_epoch" && outcomes.some((o) => o.status === "applied" && o.results?.some((r) => r.op === "database.transfer.apply" || r.op === "database.transfer.rollback") === true)) return done;
      if (!(error instanceof DomainError) || error.code !== "stale_revision") throw error;
      const now = await this.#turn(turnId);
      if (now?.status === "done") return now;
      throw error;
    }
    if (turn.resumes !== undefined) await this.#markResumed(owner, turn.resumes, turnId);
    const waiting = turn.held === undefined ? undefined : turn.plan.find((it): it is Extract<PlanItem, { kind: "asked" }> => it.kind === "asked" && it.field !== undefined);
    if (waiting !== undefined || turn.resumes !== undefined) {
      await this.#updateContext(owner.id, `${turnId}-aw`, { turnId }, (c) => {
        const { awaiting: _gone, ...rest } = c;
        return waiting === undefined ? (c.awaiting?.turnId === turn.resumes ? rest : c) : { ...rest, awaiting: { turnId, question: waiting.question, choices: waiting.choices ?? [] } };
      });
    }
    // The conversation context of the project this was about keeps a line of it, so returning to the project later finds the thread.
    if (turn.projectId !== undefined) {
      const pid = turn.projectId;
      const lastTask = outcomes.map((o) => (o.op?.startsWith("task.") === true ? o.id : undefined)).find((id) => id !== undefined);
      const summary = replyOf(kept.outcomes ?? []).join(" ").slice(0, 200);
      await this.#updateContext(owner.id, `${turnId}-ctx`, { turnId }, (c, at) => {
        const prev = c.projects[pid] ?? { touchedAt: at, turns: [] };
        const turns = [...prev.turns, { turnId, at, summary: `${turn.text.slice(0, 100)} -> ${summary}`.slice(0, 300) }].slice(-CHAT_LIMITS.turnsPerProject);
        return { ...c, projects: { ...c.projects, [pid]: { touchedAt: at, ...(lastTask !== undefined || prev.lastTaskId !== undefined ? { lastTaskId: lastTask ?? prev.lastTaskId } : {}), turns } } };
      });
    }
    return done;
  }

  /**
   * A typed command (card T09b), run as the owner through the state API's `command.run`. A command that changes things is not run from here: the chat shows those first (a proposal), so the owner says it in words; a
   * query, and a name that does not resolve, are answered at once.
   */
  async #runTyped(token: string, turnId: string, item: Extract<PlanItem, { kind: "command" }>): Promise<Outcome> {
    const inv = parseInvocation(item.typed);
    const op = inv?.namespace === "nimblenewt" ? BUILTIN_COMMANDS.operationOf(`nimblenewt.${inv.name}`) : undefined;
    if (op !== undefined && op.kind !== "query" && !RECOVERY_OPS.has(op.name)) {
      return { i: item.i, status: "refused", code: "needs_confirmation", message: `/nimblenewt.${inv!.name} changes things, so a typed line does not run it. Asked for in a message, the same thing is drawn up for you to confirm first (or sent as command.run through the API).` };
    }
    const response = await this.#deps.api.handle(token, { v: API_VERSION, op: "command.run", commandId: `${turnId}-c${item.i}`, args: { typed: item.typed } });
    if (!response.ok) return { i: item.i, status: "refused", code: response.error.code, message: response.error.message };
    const r = response.result as Record<string, unknown>;
    const status = String(r["status"]);
    if (status === "done") {
      const text = JSON.stringify(r["answer"] ?? {}, null, 1).slice(0, 1500);
      // A recovery order says what stage it reached: received, accepted, and whether it took effect or waits (card U06). It never says more than the record does.
      const recovery = op !== undefined && RECOVERY_OPS.has(op.name);
      const whole = (r["answer"] ?? {}) as Record<string, unknown>;
      // advance answers { item }, the others the record or { phase }; read the stage from whichever carries it.
      const answer = ((whole["item"] ?? whole) as Record<string, unknown>) as { phase?: string; outcome?: { state?: string; graceful?: boolean }; blocked?: { reason?: string } };
      const stages = !recovery ? [] : [
        "Received: yes", "Accepted: yes",
        answer.blocked !== undefined ? `Effected: not yet; it is blocked (${String(answer.blocked.reason)}). Choices: wait, restart-earlier-boundary, force-stop.`
          : answer.outcome !== undefined ? `Effected: ${String(answer.outcome.state)}${answer.outcome.graceful === false ? " (not graceful)" : ""}.`
            : answer.phase === "cancelled" ? "Effected: no; the request was cancelled because the scope was resumed."
              : answer.phase === "done" || answer.phase === "recovery-required" ? `Effected: ${answer.phase}.`
                : answer.phase !== undefined ? `Effected: not yet (${answer.phase}).`
                  : op?.name.startsWith("routing.") === true ? (Array.isArray(whole["cancelled"]) ? `Effected: new work no longer reaches the target; ${(whole["cancelled"] as unknown[]).length} running attempt(s) cancelled so their calls move on.` : op.name === "routing.reenable" ? "Effected: the target may be used again." : "Effected: new work no longer reaches the target (running work is left to finish).")
                    : "Effected: recorded.",
      ];
      return { i: item.i, status: "applied", op: String(r["command"]), commandId: `${turnId}-c${item.i}`, shown: [`Ran ${String(r["command"])}:`, ...stages, ...text.split("\n").slice(0, 40)] } as Outcome;
    }
    const why = status === "failed" || status === "unsupported" ? (r["error"] as { message?: string } | undefined)?.message : (r["reason"] ?? r["asks"]);
    const options = Array.isArray(r["candidates"]) ? ` (${(r["candidates"] as string[]).join(", ")})` : "";
    return { i: item.i, status: "refused", code: status === "failed" ? String((r["error"] as { code?: string } | undefined)?.code ?? "failed") : status, message: `${String(why ?? "that command could not be run")}${options}` };
  }

  async #do(owner: Principal, token: string, turnId: string, item: PlanItem, words: string, guard?: Guard): Promise<Outcome> {
    switch (item.kind) {
      case "asked": return { i: item.i, status: "asked", question: item.question, options: item.options };
      case "held": return { i: item.i, status: "held", message: `Not done yet: ${item.preview}. It waits for the answer to the question.` };
      case "ignored": return { i: item.i, status: "ignored", message: item.reason };
      case "refused": return { i: item.i, status: "refused", code: item.code, message: item.message };
      case "status": {
        if (this.#deps.status === undefined) return { i: item.i, status: "refused", code: "unavailable", message: "status answers are not set up" };
        try {
          const answer = await this.#deps.status.ask(owner, item.request as unknown as StatusRequest);
          if (answer === undefined) return { i: item.i, status: "refused", code: "not_found", message: "the records have nothing you may read for that" };
          const shown = answer.lines.slice(0, CHAT_LIMITS.statusLines);
          return { i: item.i, status: "answered", observedAt: answer.observedAt, lines: shown, ...(answer.lines.length > shown.length ? { moreLines: answer.lines.length - shown.length } : {}) };
        } catch (error) { return refusal(item.i, error); }
      }
      case "coordinator": return this.#coordinate(owner, turnId, item);
      case "command": return this.#runTyped(token, turnId, item);
      case "focus": {
        try { await this.setFocus(token, { commandId: `${turnId}-f${item.i}`, projectId: item.projectId }); } catch (error) { return refusal(item.i, error); }
        return { i: item.i, status: "focused", projectId: item.projectId };
      }
      case "apply": {
        let args = item.args;
        if (item.op === "decision.record") {
          // The version a decision is based on is read when it is applied, after the earlier steps of this message were (a restatement that changes nothing, or a decision for another task, moves nothing or moves it by its own scope): predicting it from the plan is only right for a proposal that waits for the owner.
          // A turn run again (after a crash, or sent twice at once) has this step's decision already: it is the same command, answered from the record, not sent again with a version that now includes itself.
          // Found only if it is this turn's own record (a direct decision that happens to use the same command ID is not).
          const sourceTurn = typeof item.args["sourceTurnId"] === "string" ? item.args["sourceTurnId"] : turnId;
          const known = async (): Promise<Record<string, unknown> | undefined> => {
            const done = await this.#get(token, "decision.get", { decisionId: derivedId("dec", scopedCommandId(owner.id, item.commandId)) });
            const src = done?.["source"] as { turnId?: string } | undefined;
            if (done === undefined || src?.turnId !== sourceTurn) return undefined;
            const text = done["state"] === "disputed" ? `Recorded decision version ${String(done["version"])}, but it conflicts with a decision made after the version it was based on: nothing on that topic is in force until you choose.` : `Recorded decision version ${String(done["version"])} on ${quotedText(String(done["topic"] ?? "the gate"), 80)}: ${quotedText(String(done["statement"] ?? ""), 200)}`;
            return { i: item.i, status: "applied", op: item.op, commandId: item.commandId, id: done["id"] as string, shown: [text.slice(0, 600)], accepted: true, completed: true } as Record<string, unknown>;
          };
          const already = await known();
          if (already !== undefined) return already as never;
          const fresh = await this.#revisionFor(token, "decision", args, undefined, new Map());
          if (!fresh.ok) return { i: item.i, status: "refused", op: item.op, commandId: item.commandId, code: "kind" in fresh && fresh.kind === "refuse" ? fresh.code : "invalid_command", message: "kind" in fresh && fresh.kind === "refuse" ? fresh.message : "that decision needs more from you" };
          args = { ...args, basedOn: await this.#decisionBase(token, sourceTurn, args, item.planBase, fresh.value as number) };
        }
        if (SECRET_OPS.has(item.op) && this.#noSecrets.has(turnId)) return { i: item.i, status: "refused", op: item.op, commandId: item.commandId, code: "unavailable", message: NO_SECRET_CHANNEL };
        const response = await this.#deps.api.handle(token, { v: API_VERSION, op: item.op, commandId: item.commandId, args });
        if (!response.ok && response.error.code === "command_conflict" && item.op === "decision.record") {
          // The same turn was sent twice at once and the other copy recorded this step between the look and the send: it is done.
          const recorded = await this.#get(token, "decision.get", { decisionId: derivedId("dec", scopedCommandId(owner.id, item.commandId)) });
          const src = recorded?.["source"] as { turnId?: string } | undefined;
          if (recorded !== undefined && src?.turnId === (typeof item.args["sourceTurnId"] === "string" ? item.args["sourceTurnId"] : turnId)) return { i: item.i, status: "applied", op: item.op, commandId: item.commandId, id: recorded["id"] as string, shown: [`Recorded decision version ${String(recorded["version"])} on ${quotedText(String(recorded["topic"] ?? "the gate"), 80)}.`], accepted: true, completed: true } as never;
        }
        if (!response.ok) return { i: item.i, status: "refused", op: item.op, commandId: item.commandId, code: response.error.code, message: response.error.message };
        this.#reveal(turnId, secretOf(response.result));
        return { i: item.i, status: "applied", op: item.op, commandId: item.commandId, id: response.result["id"] as string, ...(typeof response.result["revision"] === "number" ? { revision: response.result["revision"] } : {}), ...(shownOf(response.result) === undefined ? {} : { shown: shownOf(response.result) as string[] }), accepted: true, completed: response.completed ?? true, ...(response.awaits === undefined ? {} : { awaits: response.awaits }) };
      }
      case "propose": {
        try {
          const saved = await this.propose(owner, { commandId: `${turnId}-p${item.i}`, source: "chat", turnId, reason: item.reason, preview: item.preview, steps: item.steps.map(({ commandId: _c, ...s }) => s), pins: item.pins });
          return { i: item.i, status: "proposed", proposalId: saved.id, preview: item.preview, message: item.reason };
        } catch (error) { return refusal(item.i, error); }
      }
      case "policy": {
        const edits = this.#deps.policyEdits;
        if (edits === undefined) return { i: item.i, status: "refused", code: "unavailable", message: "Policy editing by chat is not set up here." };
        try {
          const saved = await edits.create(owner, { commandId: `${turnId}-e${item.i}`, turnId, wording: words, draft: item.draft });
          const unapplied = item.draft.unapplied.map((u) => u.text);
          const shared = { i: item.i, editId: saved.id, preview: item.draft.summary, explanation: item.draft.explanation, ...(unapplied.length === 0 ? {} : { unapplied }) };
          if (item.draft.status === "refused") return { ...shared, status: "refused", code: item.draft.refusal?.code ?? "refused", message: item.draft.refusal?.message ?? item.draft.reason ?? "not done" };
          if (item.draft.status === "noop") return { ...shared, status: "ignored", message: item.draft.reason ?? "it is already so" };
          if (item.draft.direct) {
            const done = await edits.apply(owner, { commandId: `${turnId}-ea${item.i}`, editId: saved.id, fromTurn: turnId });
            if (done.status !== "applied") return { ...shared, status: "refused", code: done.failure?.code ?? "refused", message: done.failure?.message ?? "not applied" };
            return { ...shared, status: "applied", accepted: true, completed: true, ...(done.takesEffect === undefined ? {} : { takesEffect: done.takesEffect }) };
          }
          return { ...shared, status: "proposed", proposalId: saved.id, message: item.draft.reason ?? "it is shown first" };
        } catch (error) { return refusal(item.i, error); }
      }
      case "apply_proposal": {
        if (item.proposalId.startsWith("pedit-")) {
          const edits = this.#deps.policyEdits;
          if (edits === undefined) return { i: item.i, status: "refused", code: "unavailable", message: "Policy editing by chat is not set up here." };
          try {
            const done = await edits.apply(owner, { commandId: `${turnId}-a${item.i}`, editId: item.proposalId, fromTurn: turnId, ...(item.lengthDays === undefined ? {} : { lengthDays: item.lengthDays }) });
            const found = await edits.get(owner, item.proposalId);
            const shared = { i: item.i, editId: item.proposalId, preview: found === undefined ? [] : found.forwardedBy === undefined ? found.summary : [`(passed on by ${found.forwardedBy}) ${found.summary[0] ?? ""}`, ...found.summary.slice(1)], explanation: found?.explanation ?? [] };
            if (done.status !== "applied") return { ...shared, status: "refused", code: done.failure?.code ?? "refused", message: done.failure?.message ?? "not applied" };
            return { ...shared, status: "applied", accepted: true, completed: true, ...(done.takesEffect === undefined ? {} : { takesEffect: done.takesEffect }) };
          } catch (error) { return refusal(item.i, error); }
        }
        try {
          const result = await this.#apply(owner, token, item.proposalId, `${turnId}-a${item.i}`, turnId, !this.#noSecrets.has(turnId), guard);
          for (const secret of result.secrets ?? []) this.#reveal(turnId, secret);
          return result.applied ? { i: item.i, status: "applied", proposalId: item.proposalId, results: result.results, accepted: true, completed: result.results.every((r) => r.completed) } : { i: item.i, status: "refused", proposalId: item.proposalId, code: result.failure?.code ?? "invalid_command", message: result.failure?.message ?? "not applied", results: result.results };
        } catch (error) { return refusal(item.i, error); }
      }
      case "discard_proposal": {
        if (item.proposalId.startsWith("pedit-")) {
          if (this.#deps.policyEdits === undefined) return { i: item.i, status: "refused", code: "unavailable", message: "Policy editing by chat is not set up here." };
          try { await this.#deps.policyEdits.discard(owner, { commandId: `${turnId}-d${item.i}`, editId: item.proposalId, fromTurn: turnId }); } catch (error) { return refusal(item.i, error); }
          return { i: item.i, status: "discarded", proposalId: item.proposalId };
        }
        try { await this.#discard(owner, item.proposalId, `${turnId}-d${item.i}`, turnId); } catch (error) { return refusal(item.i, error); }
        return { i: item.i, status: "discarded", proposalId: item.proposalId };
      }
    }
  }

  /** What the owner said to the coordinator (card U03), done through its own service under the owner's authority, one command ID per item so the message is applied once. */
  async #coordinate(owner: Principal, turnId: string, item: Extract<PlanItem, { kind: "coordinator" }>): Promise<Outcome> {
    const service = this.#deps.coordinator?.();
    if (service === undefined) return { i: item.i, status: "refused", code: "unavailable", message: "the coordinator is not set up here" };
    const commandId = `${turnId}-k${item.i}`;
    const line = (text: string, cites: readonly Cite[] = []) => ({ text, cites });
    try {
      switch (item.action) {
        case "answer": {
          const answer = await service.answer(owner, { commandId, projectId: item.projectId!, question: item.question! });
          if (answer.kind === "unavailable") return { i: item.i, status: "refused", code: "unavailable", message: answer.reason };
          const lines = answer.kind === "answer" ? [line(answer.text, answer.cites.map((c): Cite => ("id" in c ? { kind: c.kind, id: c.id } : { kind: c.kind, id: `${c.scopeId}#${c.seq}` })))]
            : answer.kind === "asked" ? [line(`The records do not answer that, so I asked ${answer.to} (inquiry ${answer.inquiryId}).`, [{ kind: "inquiry", id: answer.inquiryId }])] : [line(answer.note)];
          return { i: item.i, status: "answered", observedAt: this.#runner.now(), lines };
        }
        case "decompose": {
          const plan = await service.decompose(owner, { commandId, projectId: item.projectId!, outcome: item.outcome! });
          if ("kind" in plan) return { i: item.i, status: "refused", code: "unavailable", message: plan.reason };
          return { i: item.i, status: "proposed", proposalId: plan.proposalId, preview: [`${plan.tasks} task${plan.tasks === 1 ? "" : "s"} drafted by the coordinator`, ...plan.notes], message: "It is a proposal: nothing exists until you apply it." };
        }
        case "assign": {
          const result = await service.assign(owner, { commandId, projectId: item.projectId! });
          if (result.kind === "unavailable") return { i: item.i, status: "refused", code: "unavailable", message: result.reason };
          if (result.kind === "proposed") return { i: item.i, status: "proposed", proposalId: result.proposalId, preview: [`a plan of assignments drafted by the coordinator${result.skipped.length === 0 ? "" : ` (${result.skipped.length} left out)`}`], message: "It is a proposal: nothing is assigned until you apply it." };
          return { i: item.i, status: "answered", observedAt: this.#runner.now(), lines: [line(`${result.assigned.length} assigned, ${result.skipped.length} left`), ...result.assigned.map((a) => line(`${a.taskId} to ${a.owner}: ${a.reason}`, [{ kind: "task", id: a.taskId }]))] };
        }
        case "configure": {
          const made = await service.configure(owner, { commandId, principalId: item.principalId!, ...(item.routes === undefined ? {} : { routes: item.routes }), ...(item.expectedRevision === undefined ? {} : { expectedRevision: item.expectedRevision }) });
          return { i: item.i, status: "applied", op: "coordinator.configure", commandId, id: made.id, revision: made.revision };
        }
        case "start": case "pause": case "stop": {
          if (item.expectedRevision === undefined) return { i: item.i, status: "refused", code: "not_found", message: "the coordinator is not set up yet" };
          const made = await service.setState(owner, { commandId, expectedRevision: item.expectedRevision, to: item.action === "start" ? "running" : item.action === "pause" ? "paused" : "stopped" });
          // A hosted coordinator is started through its agent's own gate; a pause above it (a team, the installation) still holds it, and the owner is told so.
          return { i: item.i, status: "applied", op: "coordinator.state", commandId, id: made.id, revision: made.revision, ...(made.stillHeldBy === undefined ? {} : { shown: [`The coordinator's own pause is lifted, but it is still held by ${made.stillHeldBy.join(", ")}.`] }) };
        }
      }
    } catch (error) { return refusal(item.i, error); }
  }

  /** Closes the turn whose held commands another turn carried on (once; repeating it is harmless). */
  async #markResumed(owner: Principal, oldId: string, byId: string): Promise<void> {
    await this.#runner.command("chat.turn.resumed", { commandId: `${byId}-resumed`, actor: owner.id }, async () => ({
      payload: { oldId, byId },
      build: async () => {
        const current = await this.#runner.get("chat-turn", oldId);
        if (current === undefined) throw new DomainError("not_found", "no such turn");
        const ref: AggregateRef = { kind: "chat-turn", id: oldId };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: asJson({ ...(current.body as unknown as TurnBody), resumedBy: byId }) }], detail: { by: byId } };
      },
    }));
  }

  async #applyEdit(owner: Principal, editId: string, commandId: string): Promise<ApplyResult> {
    const edits = this.#deps.policyEdits;
    if (edits === undefined) throw new DomainError("unavailable", "policy editing by chat is not set up here");
    const done = await edits.apply(owner, { commandId, editId });
    return { proposalId: editId, applied: done.status === "applied", replayed: done.replayed, results: [], ...(done.status === "applied" || done.failure === undefined ? {} : { failure: { step: 0, code: done.failure.code, message: done.failure.message } }) };
  }

  async #apply(owner: Principal, token: string, proposalId: string, commandId: string, fromTurn: string | undefined, allowSecrets = true, guard?: Guard): Promise<ApplyResult> {
    let found = PROPOSAL_ID.test(proposalId) ? await this.#runner.get("chat-proposal", proposalId) : undefined;
    let body = found?.body as unknown as ChatProposalBody | undefined;
    if (found === undefined || body === undefined || body.ownerId !== owner.id) throw new DomainError("not_found", "no such proposal");
    if (body.status === "applied") return { proposalId, applied: true, replayed: true, results: body.results ?? [] };
    if (body.status === "discarded") throw new DomainError("invalid_command", "that proposal was discarded", { field: "proposalId" });
    // Whatever the owner said, a proposal drawn up in this very message is not applied by it.
    if (fromTurn !== undefined && body.turnId === fromTurn) throw new DomainError("invalid_command", "a proposal is applied by a later, explicit request, not in the message that drew it up", { field: "proposalId" });

    // What was shown must still be what is dispatched: each pinned task is still in its project and repository.
    for (const pin of body.pins) {
      const task = await this.#get(token, "task.get", { taskId: pin.taskId });
      const repositoryOk = pin.repositoryId === undefined ? true : pin.repositoryFromStep !== undefined ? task?.["repositoryId"] === undefined || task["repositoryId"] === pin.repositoryId : task?.["repositoryId"] === pin.repositoryId;
      if (task === undefined || task["projectId"] !== pin.projectId || !repositoryOk) throw new DomainError("invalid_command", "a task in this proposal is no longer in the project and repository it was shown with; ask again", { field: "proposalId" });
    }
    for (const pin of body.pins) {
      if (pin.idle !== true) continue;
      const task = await this.#get(token, "task.get", { taskId: pin.taskId });
      const assignment = await this.#get(token, "assignment.get", { taskId: pin.taskId });
      if (task?.["state"] === "in_progress" || (assignment !== undefined && assignment["state"] === "assigned")) throw new DomainError("invalid_command", "a task in this proposal is being worked on now and keeps its repository; ask again", { field: "proposalId" });
    }
    const coordinatorToken = body.steps.some((s) => s.as === "coordinator") ? await this.#deps.coordinatorToken?.() : undefined;
    const results: ChatStepResult[] = [];
    const secrets: RevealedSecret[] = [];
    const withSecrets = <T extends object>(r: T): T => (secrets.length === 0 ? r : { ...r, secrets });
    // A channel that keeps what it shows is refused before any step is sent, so a proposal that would make a credential is never half applied from it.
    const secretStep = allowSecrets ? -1 : body.steps.findIndex((s) => SECRET_OPS.has(s.op));
    if (secretStep >= 0) return { proposalId, applied: false, replayed: false, results, failure: { step: secretStep, code: "unavailable", message: NO_SECRET_CHANNEL } };
    for (const [index, step] of body.steps.entries()) {
      await guard?.();
      const args = substitute(step.args, results);
      const using = step.as === "coordinator" ? coordinatorToken : token;
      if (using === undefined) return withSecrets({ proposalId, applied: false, replayed: false, results, failure: { step: index, code: "unavailable", message: "the coordinator is not available to make this step" } });
      if (step.op === "decision.record" && step.as === undefined) {
        // A decision step is based on the version of its topic when it was shown, but decisions of the same message applied before it do not count as the topic having moved. A step already recorded (this apply run again) is answered from the record.
        const done = await this.#get(token, "decision.get", { decisionId: derivedId("dec", scopedCommandId(owner.id, step.commandId)) });
        if (done !== undefined) {
          results.push({ op: step.op, id: done["id"] as string, shown: [`Recorded decision version ${String(done["version"])} on ${quotedText(String(done["topic"] ?? "the gate"), 80)}.`], ...(step.key === undefined ? {} : { key: step.key }), accepted: true, completed: true });
          continue;
        }
        const fresh = await this.#revisionFor(token, "decision", args, undefined, new Map());
        if (!fresh.ok) return withSecrets({ proposalId, applied: false, replayed: false, results, failure: { step: index, code: "kind" in fresh && fresh.kind === "refuse" ? fresh.code : "invalid_command", message: "kind" in fresh && fresh.kind === "refuse" ? fresh.message : "that decision needs more from you" } });
        args["basedOn"] = await this.#decisionBase(token, typeof args["sourceTurnId"] === "string" ? args["sourceTurnId"] : "", args, typeof args["basedOn"] === "number" ? args["basedOn"] : undefined, fresh.value as number);
      }
      if (step.op === "meeting.record.owner-respond" && isObject(args["alternative"])) {
        // The owner's alternative is based on the version of its topic when it is recorded, as a decision step is, and decisions of this very message do not count as the topic having moved.
        const alt = { ...(args["alternative"] as Record<string, unknown>) };
        const fresh = await this.#revisionFor(token, "decision", alt, undefined, new Map());
        if (!fresh.ok) return withSecrets({ proposalId, applied: false, replayed: false, results, failure: { step: index, code: "kind" in fresh && fresh.kind === "refuse" ? fresh.code : "invalid_command", message: "kind" in fresh && fresh.kind === "refuse" ? fresh.message : "that decision needs more from you" } });
        alt["basedOn"] = await this.#decisionBase(token, String((alt["source"] as { turnId?: unknown } | undefined)?.turnId ?? ""), alt, typeof alt["basedOn"] === "number" ? alt["basedOn"] : undefined, fresh.value as number);
        args["alternative"] = alt;
      }
      if (step.op === "standup.answer-question" && typeof args["questionId"] === "string") {
        // The revision in the shown proposal is the one read when it was drawn up. Announcing the question (marking it told) moves its revision without changing a word of it, so the owner's agreement is applied
        // to the revision the question has now, as long as it is still open: the words the owner saw are the same. An answered question is never answered again; the same words are the step already done.
        const cur = await this.#runner.get("owner-question", args["questionId"]);
        const qb = cur?.body as unknown as { state?: string; answer?: string } | undefined;
        if (cur !== undefined && qb?.state === "open") args["expectedRevision"] = cur.revision;
        else if (cur !== undefined && qb?.state === "answered") {
          if (qb.answer === args["answer"]) { results.push({ op: step.op, id: args["questionId"], shown: ["The stand-up's question was already answered with these words."], ...(step.key === undefined ? {} : { key: step.key }), accepted: true, completed: true }); continue; }
          return withSecrets({ proposalId, applied: false, replayed: false, results, failure: { step: index, code: "invalid_command", message: "the stand-up's question was already answered" } });
        }
      }
      let response = await this.#deps.api.handle(using, { v: API_VERSION, op: step.op, commandId: step.commandId, args: args as Record<string, unknown> });
      // The question's revision can move once more between the look and the send (the delivery loop marking it told): look again, a few times.
      for (let again = 0; again < 3 && !response.ok && response.error.code === "stale_revision" && step.op === "standup.answer-question" && typeof args["questionId"] === "string"; again++) {
        const cur = await this.#runner.get("owner-question", args["questionId"]);
        if ((cur?.body as unknown as { state?: string } | undefined)?.state !== "open") break;
        args["expectedRevision"] = cur!.revision;
        response = await this.#deps.api.handle(using, { v: API_VERSION, op: step.op, commandId: step.commandId, args: args as Record<string, unknown> });
      }
      if (!response.ok) return withSecrets({ proposalId, applied: false, replayed: false, results, failure: { step: index, code: response.error.code, message: response.error.message } });
      const made = secretOf(response.result);
      if (made !== undefined) secrets.push(made);
      results.push({ op: step.op, id: response.result["id"] as string, ...(typeof response.result["revision"] === "number" ? { revision: response.result["revision"] } : {}), ...(shownOf(response.result) === undefined ? {} : { shown: shownOf(response.result) as string[] }), ...(step.key === undefined ? {} : { key: step.key }), accepted: true, completed: response.completed ?? true, ...(response.awaits === undefined ? {} : { awaits: response.awaits }) });
    }
    try {
      await this.#runner.command("chat.apply", { commandId: scopedCommandId(owner.id, commandId), actor: owner.id }, async () => ({
        payload: { proposalId },
        build: async () => {
          const current = await this.#runner.get("chat-proposal", proposalId);
          const now = current?.body as unknown as ChatProposalBody | undefined;
          if (current === undefined || now === undefined) throw new DomainError("not_found", "no such proposal");
          if (now.status !== "open") throw new DomainError("stale_revision", "the proposal changed meanwhile", { currentRevision: current.revision });
          const ref: AggregateRef = { kind: "chat-proposal", id: proposalId };
          const next: ChatProposalBody = { ...now, status: "applied", appliedAt: this.#runner.now(), results };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: asJson(next) }], detail: { steps: now.steps.map((s) => s.commandId) } };
        },
      }));
    } catch (error) {
      // A database transfer fences the database this record lives in (card F04e): the move was made, and the note that it was cannot be written to the database that was just retired. The owner is told it was applied (restart required).
      if (error instanceof DomainError && error.code === "stale_epoch" && body.steps.some((s) => s.op === "database.transfer.apply" || s.op === "database.transfer.rollback") && results.some((r) => r.op === "database.transfer.apply" || r.op === "database.transfer.rollback")) return { proposalId, applied: true, replayed: false, results };
      if (!(error instanceof DomainError) || error.code !== "stale_revision") throw error;
      found = await this.#runner.get("chat-proposal", proposalId);
      body = found?.body as unknown as ChatProposalBody | undefined;
      if (body?.status !== "applied") throw error;
      // Another copy recorded the proposal as applied first; a credential this copy made is still handed over (it is in no record, so this is its only showing).
      return withSecrets({ proposalId, applied: true, replayed: true, results: body.results ?? [] });
    }
    return withSecrets({ proposalId, applied: true, replayed: false, results });
  }

  /** Keeps a secret an operation made, for the caller of this turn to take once. */
  #reveal(turnId: string, secret: RevealedSecret | undefined): void {
    if (secret === undefined) return;
    const held = this.#revealed.get(turnId);
    if (held === undefined) this.#revealed.set(turnId, [secret]); else held.push(secret);
  }

  async #discard(owner: Principal, proposalId: string, commandId: string, fromTurn: string | undefined): Promise<{ proposalId: string; replayed: boolean }> {
    const found = PROPOSAL_ID.test(proposalId) ? await this.#runner.get("chat-proposal", proposalId) : undefined;
    const body = found?.body as unknown as ChatProposalBody | undefined;
    if (found === undefined || body === undefined || body.ownerId !== owner.id) throw new DomainError("not_found", "no such proposal");
    if (fromTurn !== undefined && body.turnId === fromTurn) throw new DomainError("invalid_command", "a proposal is not discarded in the message that drew it up", { field: "proposalId" });
    if (body.status === "applied") throw new DomainError("invalid_command", "that proposal was already applied", { field: "proposalId" });
    const result = await this.#runner.command("chat.discard", { commandId: scopedCommandId(owner.id, commandId), actor: owner.id }, async () => ({
      payload: { proposalId },
      build: async () => {
        const current = await this.#runner.get("chat-proposal", proposalId);
        const now = current?.body as unknown as ChatProposalBody | undefined;
        if (current === undefined || now === undefined) throw new DomainError("not_found", "no such proposal");
        if (now.status !== "open") throw new DomainError("invalid_command", `that proposal is ${now.status}`, { field: "proposalId" });
        const ref: AggregateRef = { kind: "chat-proposal", id: proposalId };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: asJson({ ...now, status: "discarded", discardedAt: this.#runner.now() }) }], detail: {} };
      },
    }));
    return { proposalId, replayed: result.replayed };
  }

  // ---- records ---------------------------------------------------------------------------------------------------------------

  async #owner(token: unknown): Promise<Principal> {
    const principal = await this.#deps.principals.authenticate(token);
    if (principal.kind !== "owner" || principal.taskScope !== undefined) throw new DomainError("forbidden", "only the owner talks to the chat");
    return principal;
  }

  async #turn(turnId: string): Promise<TurnBody | undefined> {
    const found = await this.#runner.get("chat-turn", turnId);
    return found === undefined ? undefined : found.body as unknown as TurnBody;
  }

  async #createTurn(owner: Principal, turnId: string, body: TurnBody): Promise<void> {
    await this.#runner.command("chat.turn", { commandId: `${turnId}-plan`, actor: owner.id }, async () => ({
      payload: { turnId },
      build: async () => {
        const ref: AggregateRef = { kind: "chat-turn", id: turnId };
        return { ref, creates: true, changes: [{ type: "create", ref, body: asJson(body) }], detail: { messageId: body.messageId, commands: body.plan.flatMap((p) => (p.kind === "apply" ? [p.commandId] : p.kind === "propose" ? [p.proposalId] : p.kind === "policy" ? [p.editId] : [])) } };
      },
    }));
  }

  async #finishTurn(owner: Principal, turnId: string, body: TurnBody): Promise<void> {
    await this.#runner.command("chat.turn.done", { commandId: `${turnId}-done`, actor: owner.id }, async () => ({
      payload: { turnId },
      build: async () => {
        const current = await this.#runner.get("chat-turn", turnId);
        if (current === undefined) throw new DomainError("not_found", "no such turn");
        if ((current.body as unknown as TurnBody).status === "done") throw new DomainError("stale_revision", "already done", { currentRevision: current.revision });
        const ref: AggregateRef = { kind: "chat-turn", id: turnId };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: asJson(body) }], detail: { outcomes: (body.outcomes ?? []).map((o) => o.status) } };
      },
    }));
  }

  async #context(ownerId: string): Promise<ContextBody> {
    const found = await this.#runner.get("chat-context", `ctx:${ownerId}`);
    return found === undefined ? { projects: {} } : found.body as unknown as ContextBody;
  }

  async #updateContext(ownerId: string, commandId: string, payload: JsonObject, change: (c: ContextBody, at: string) => ContextBody): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#runner.command("chat.context", { commandId, actor: ownerId }, async () => ({
          payload,
          build: async () => {
            const current = await this.#runner.get("chat-context", `ctx:${ownerId}`);
            const next = change(current === undefined ? { projects: {} } : current.body as unknown as ContextBody, this.#runner.now());
            const ref: AggregateRef = { kind: "chat-context", id: `ctx:${ownerId}` };
            const body = asJson(next);
            const changes: Change[] = [current === undefined ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: current.revision, body }];
            return { ref, creates: current === undefined, changes, detail: {} };
          },
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 8) throw error;
      }
    }
  }

  async #openProposals(ownerId: string, limit = 10): Promise<{ id: string; summary: string[] }[]> {
    // Every record is read until ten are found: proposals are never deleted and their IDs are hashes, so a scan that stopped early would miss open ones at random (the count of a message that is only "yes" relies on it).
    const out: { id: string; summary: string[] }[] = [];
    let after: string | undefined;
    for (;;) {
      const chunk = await this.#runner.list("chat-proposal", { ...(after === undefined ? {} : { afterId: after }), limit: 1000 });
      for (const a of chunk) {
        after = a.id;
        const b = a.body as unknown as ChatProposalBody;
        if (b.ownerId === ownerId && b.status === "open") out.push({ id: a.id, summary: [...b.preview] });
        if (out.length >= limit) return out;
      }
      if (chunk.length < 1000) return out;
    }
  }

  /** The recorded answer a one-word reply names, from the question the chat itself asked: its whole text equals exactly one recorded choice or exactly one option's label. Never from what the model says; nothing when it is not one. */
  async #choiceSaid(owner: Principal, turnId: string, words: string): Promise<string | undefined> {
    const old = typeof turnId === "string" ? await this.#turn(turnId) : undefined;
    if (old === undefined || old.ownerId !== owner.id || old.held === undefined || old.resumedBy !== undefined) return undefined;
    // Only the question the chat is waiting on now (the one the model was shown): an older question that a later one replaced is not answered by a single word.
    if ((await this.#context(owner.id)).awaiting?.turnId !== turnId) return undefined;
    const asked = old.plan.find((it): it is Extract<PlanItem, { kind: "asked" }> => it.kind === "asked" && it.field !== undefined);
    if (asked === undefined) return undefined;
    const said = tidyWords(words);
    if (said === "") return undefined;
    const choices = asked.choices ?? [];
    const hits = new Set<string>();
    choices.forEach((choice, k) => {
      const label = asked.options.length === choices.length ? asked.options[k] : undefined;
      // A word of agreement or refusal ("yes", "ok", "no") answers only a question that offers it as a choice: an option's label can hold text someone else wrote (a task's or an item's name in brackets).
      const names = label === undefined || AGREEMENT.has(said) ? [] : [label, label.split(": ")[0] ?? "", /\(([^()]*)\)/.exec(label)?.[1] ?? ""];
      if (tidyWords(choice) === said || names.some((n) => tidyWords(n) === said)) hits.add(choice);
    });
    return hits.size === 1 ? [...hits][0] : undefined;
  }

  async #openEdits(owner: Principal): Promise<{ id: string; summary: string[] }[]>;
  async #openEdits(owner: Principal, failed: true): Promise<{ id: string; summary: string[] }[] | undefined>;
  async #openEdits(owner: Principal, failed?: true): Promise<{ id: string; summary: string[] }[] | undefined> {
    try { return (await this.#deps.policyEdits?.open(owner))?.map((e) => ({ id: e.id, summary: e.summary })) ?? []; } catch { return failed ? undefined : []; }
  }

  async #openCount(ownerId: string): Promise<number> {
    // Read to the end (or to the limit), for the same reason as #openProposals.
    let count = 0;
    let after: string | undefined;
    for (;;) {
      const chunk = await this.#runner.list("chat-proposal", { ...(after === undefined ? {} : { afterId: after }), limit: 1000 });
      for (const a of chunk) { after = a.id; const b = a.body as unknown as ChatProposalBody; if (b.ownerId === ownerId && b.status === "open" && ++count >= CHAT_LIMITS.openProposals) return count; }
      if (chunk.length < 1000) return count;
    }
  }
}

// ---- helpers -------------------------------------------------------------------------------------------------------------------

/** The record an applied command writes and whose revision it moves on, for the predicted revisions of later commands of the same message. */
function recordOf(step: ChatStep): string | undefined {
  const a = step.args;
  switch (step.op) {
    case "task.update": case "task.transition": return `task:${a["taskId"] as string}`;
    case "project.update": case "project.plan": return `project:${a["projectId"] as string}`;
    // A new repository also changes the project's own record, so a later project command of the same message expects the next revision.
    case "resource.bind": return a["kind"] === "repository" ? `project:${a["projectId"] as string}` : undefined;
    case "agent.update": return `agent:${a["agentId"] as string}`;
    case "contract.set": case "difficulty.set": return `contract:${a["taskId"] as string}`;
    case "difficulty.set-profiles": return "difficulty-profiles";
    case "decision.record": return `decision:${a["projectId"] as string}:${normalTopic(String(a["topic"] ?? ""))}:${typeof a["taskId"] === "string" ? a["taskId"] : "*"}`;
    case "agenda.correct": return `agenda:${a["itemId"] as string}`;
    case "observation.dispose": return `observation:${a["observationId"] as string}`;
    case "lesson.decide": return `lesson:${a["lessonId"] as string}`;
    case "experiment.pin": case "experiment.budget": case "experiment.conclude": case "experiment.withdraw": return `experiment:${a["experimentId"] as string}`;
    // A repair named in the same message comes before the owner's judgement of it, which then expects the defect's next revision.
    case "defect.repair": return `defect:${a["id"] as string}`;
    case "standup.update": return `standup:${a["scheduleId"] as string}`;
    case "notifications.configure": return "notifications";
    case "retention.settings.set": return "retention";
    case "catalog.policy.change": return "catalog-policy";
    default: return undefined;
  }
}

/** The secret an operation's result carries for the owner (`secret: { label, value }`), if it has one. It is taken out here, so nothing that keeps the result keeps it. */
function secretOf(result: JsonObject): RevealedSecret | undefined {
  const s = result["secret"];
  if (s === null || typeof s !== "object" || Array.isArray(s)) return undefined;
  const { label, value } = s as { label?: unknown; value?: unknown };
  return typeof label === "string" && typeof value === "string" && value !== "" ? { label: label.slice(0, 120), value } : undefined;
}

/** The plain lines an API result asks to be shown to the owner (a captured agenda topic), if it has any. */
function shownOf(result: JsonObject): string[] | undefined {
  const lines = result["shown"];
  return Array.isArray(lines) && lines.length > 0 && lines.every((l) => typeof l === "string") ? (lines as string[]).slice(0, 12).map((l) => l.slice(0, 600)) : undefined;
}

/** How many document changes the chat offers when it asks which one verifies a document (card Q03b): the `docs` view lists as many. */
const DOC_CHOICES = 3;
const refuse = (code: string, message: string): { ok: false; kind: "refuse"; code: string; message: string } => ({ ok: false, kind: "refuse", code, message });

/**
 * The stand-up meetings the owner's words name (second review of card M03h). A stand-up is named first by the title it has now; only when no stand-up's current title fits are the meetings' own titles tried (a meeting keeps the title its
 * stand-up had when it was made). So when one stand-up was renamed and another took its old title, the words mean the one called that now, not the renamed one whose meeting still carries the old title. No words name every meeting.
 */
function meetingsNamed(words: string, items: readonly Record<string, unknown>[], titleOf: ReadonlyMap<string, string>): Record<string, unknown>[] {
  if (words.trim() === "") return [...items];
  const byCurrent = items.filter((m) => { const now = titleOf.get(String(m["scheduleId"])); return now !== undefined && looseMatch(words, now); });
  return byCurrent.length > 0 ? byCurrent : items.filter((m) => looseMatch(words, String(m["title"])));
}

/** The title a stand-up meeting is shown by: its stand-up's title now, else the title the meeting was made with. */
const shownTitle = (m: Record<string, unknown>, titleOf: ReadonlyMap<string, string>): string => titleOf.get(String(m["scheduleId"])) ?? String(m["title"]);

/** Whether a name an agent or a team goes by stands as a whole word of the owner's message: `wholeWord`'s rule, and no letter, digit or mark of any script touches it either (Ann is not in Jóann, Bob is not in Bobé). */
/** Both sides are read in one Unicode form (NFC), so a name typed with a separate accent mark is the name stored with the accented letter. */
const nameInWords = (text: string, name: string): boolean => { const t = text.normalize("NFC"); const n = name.normalize("NFC"); return wholeWord(t, n) && nameAt(n).test(t); };
const nameAt = (name: string, flags = "iu"): RegExp => new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}\\p{M}])`, flags);
const sameName = (a: string, b: string): boolean => a.normalize("NFC").trim().toLowerCase() === b.normalize("NFC").trim().toLowerCase();
/** The agents and teams whose name the owner's message names: a shorter name that the message has only inside a longer one also named (Bob inside "Bob Squad") is not named on its own. */
const namesMeant = <T extends { name: string }>(text: string, all: readonly T[]): T[] => {
  const found = all.filter((c) => nameInWords(text, c.name));
  const t = text.normalize("NFC");
  return found.filter((c) => {
    const longer = found.filter((d) => d.name.normalize("NFC").length > c.name.normalize("NFC").length && nameAt(c.name.normalize("NFC")).test(d.name.normalize("NFC")));
    if (longer.length === 0) return true;
    // Blank out where the longer names stand; the shorter one counts only if it still stands somewhere else.
    const rest = longer.reduce((acc, d) => acc.replace(nameAt(d.name.normalize("NFC"), "giu"), (m) => " ".repeat(m.length)), t);
    return nameInWords(rest, c.name);
  });
};

/** A few things the owner is being told about, as one phrase: `x`, `x and y`, `x, y and z`; a long list is cut with a count. Each is quoted, because a title like this was written by whoever set it up. */
const titleList = (titles: readonly string[]): string => {
  const listed = titles.slice(0, 3).map((t) => quotedText(t, 60));
  return `${listed.slice(0, -1).join(", ")}${listed.length > 2 ? "," : ""}${listed.length > 1 ? " and " : ""}${listed[listed.length - 1] ?? ""}${titles.length > 3 ? ` and ${titles.length - 3} more` : ""}`;
};
const acceptedForOp = (op: string): readonly string[] => (acceptedArgs(op) ?? []).filter((k) => !(k in TITLE_KEYS) && k !== "projectName");

function askOrRefuse(i: number, r: { ok: false; kind: "ask"; question: string; options: string[]; field?: string; choices?: string[] } | { ok: false; kind: "refuse"; code: string; message: string }, intentIndex: number): PlanItem {
  return r.kind === "ask" ? { i, kind: "asked", question: r.question, options: r.options, ...(r.field === undefined ? {} : { intentIndex, field: r.field, choices: r.choices ?? [] }) } : { i, kind: "refused", code: r.code, message: r.message };
}

function refusal(i: number, error: unknown): Outcome {
  if (error instanceof DomainError) return { i, status: "refused", code: error.code, message: error.message };
  throw error;
}

function touch(c: ContextBody, projectId: string, at: string): ContextBody["projects"] {
  const prev = c.projects[projectId] ?? { touchedAt: at, turns: [] };
  const projects: Record<string, ContextBody["projects"][string]> = { ...c.projects, [projectId]: { ...prev, touchedAt: at } };
  const ids = Object.keys(projects);
  if (ids.length > CHAT_LIMITS.projects) {
    const oldest = ids.filter((id) => id !== projectId).sort((a, b) => (projects[a] as { touchedAt: string }).touchedAt.localeCompare((projects[b] as { touchedAt: string }).touchedAt))[0];
    if (oldest !== undefined) delete projects[oldest];
  }
  return projects;
}

/** `{ "$ref": "name" }` (only in steps the controller builds: interpreter text carrying `$ref` is refused) becomes the ID the earlier step of that name produced. */
function substitute(args: Record<string, unknown>, results: readonly ChatStepResult[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (isObject(value) && typeof value["$ref"] === "string" && Object.keys(value).length === 1) {
      const found = results.find((r) => r.key === value["$ref"]);
      if (found === undefined) throw new DomainError("invalid_command", `${key}: refers to a step that has not run`, { field: key });
      out[key] = found.id;
    } else out[key] = isObject(value) ? substitute(value, results) : value;
  }
  return out;
}

const redactForModel = (text: string): string => {
  try { refuseCredentials(text, "quoted"); return text; } catch { return "[quoted text withheld: it looked like it held a credential]"; }
};

/** The owner-facing answer: one plain line per outcome. */
/** Room kept free in a finished turn's record for what the size estimate does not count exactly. */
const TURN_SLACK_BYTES = 8 * 1024;
/**
 * A finished turn is one record of at most `bodyBytes` (card U09 review, round 3). Each status answer is at most 30 lines, but a message may ask eight questions and a line holding agent text in a
 * three-byte script can be over a kilobyte, so eight long answers could pass the limit and the turn could never be recorded as done. Lines are left out from the end of the last answers first until the
 * record fits; each answer counts what it left out in `moreLines`, as an answer cut at 30 lines does.
 */
/** A finished turn as it is stored: the quoted blocks of a `thinking` status answer (card U09b) are replaced by a line saying they were shown; the count, the label and where to continue stay. */
export function withoutThinkingText(body: TurnBody): TurnBody {
  const thinking = new Set(body.plan.filter((it) => it.kind === "status" && (it as { request?: { kind?: unknown } }).request?.kind === "thinking").map((it) => it.i));
  if (thinking.size === 0) return body;
  const outcomes = (body.outcomes ?? []).map((o) => (!thinking.has(o.i) || o.lines === undefined ? o : {
    ...o,
    lines: o.lines.map((l) => { const m = /^Block (\d+) \(/.exec(l.text); return m === null ? l : { ...l, text: `Block ${m[1]}: shown when it was asked for; the chat keeps no copy of the model's thinking (ask again to see it while it is kept).` }; }),
  }));
  return { ...body, outcomes };
}

export function fitAnswers(body: TurnBody): TurnBody {
  const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");
  let excess = bytes(body) - (STORAGE_LIMITS.bodyBytes - TURN_SLACK_BYTES);
  if (excess <= 0) return body;
  const outcomes = [...(body.outcomes ?? [])];
  for (let k = outcomes.length - 1; k >= 0 && excess > 0; k--) {
    const o = outcomes[k]!;
    if (o.status !== "answered" || o.lines === undefined || o.lines.length === 0) continue;
    const lines = [...o.lines];
    while (lines.length > 0 && excess > 0) excess -= bytes(lines.pop()) + 1;
    // `moreLines` itself takes a few bytes, which the slack covers.
    outcomes[k] = { ...o, lines, moreLines: (o.moreLines ?? 0) + o.lines.length - lines.length };
  }
  return { ...body, outcomes };
}

export function replyOf(outcomes: readonly Outcome[]): string[] {
  const lines: string[] = [];
  for (const o of outcomes) {
    // A policy edit says what it means in plain words, what stays as it is, and what was not applied.
    const edit = o.editId === undefined ? "" : [...(o.preview ?? []), ...(o.explanation ?? []), ...(o.unapplied ?? []).map((u) => `Not applied: ${quotedText(u, 120)}.`)].join(" ");
    switch (o.status) {
      case "asked": lines.push(`${o.question ?? ""}${o.options !== undefined && o.options.length > 0 ? ` (${o.options.join("; ")})` : ""}`); break;
      case "held": lines.push(o.message ?? "Held."); break;
      case "ignored": lines.push(`No change: ${o.message ?? ""}${edit === "" ? "" : ` ${edit}`}`); break;
      case "refused": lines.push(`Not done (${o.code ?? "refused"}): ${o.message ?? ""}${edit === "" ? "" : ` ${edit}`}`); break;
      case "focused": lines.push(`Now focused on project ${o.projectId ?? ""}.`); break;
      case "discarded": lines.push(`Proposal ${o.proposalId ?? ""} discarded.`); break;
      case "answered":
        lines.push(`As of ${o.observedAt ?? "now"}, from the records:`);
        for (const l of o.lines ?? []) lines.push(`${l.text} [${l.cites.map((c) => `${c.kind} ${c.id}`).join(", ")}]`);
        if (o.moreLines !== undefined) lines.push(`${o.moreLines} more line${o.moreLines === 1 ? "" : "s"} not shown; ask for a narrower view.`);
        break;
      case "proposed": lines.push(o.editId !== undefined ? `Proposed, nothing has changed yet (${o.message ?? ""}). ${edit} Edit ${o.editId} waits for your word: apply it, or discard it?` : `Proposed, nothing has happened yet (${o.message ?? ""}). Proposal ${o.proposalId ?? ""}: ${(o.preview ?? []).join("; ")}. Apply it, or discard it?`); break;
      case "applied":
        if (!(o.op === "decision.record" && o.shown !== undefined)) lines.push(o.editId !== undefined ? `Done. ${edit}${o.takesEffect === undefined ? "" : ` It takes effect ${o.takesEffect}.`} Recorded as ${o.editId}.` : o.proposalId !== undefined ? `Applied proposal ${o.proposalId}.` : `Done: ${o.op ?? ""}${o.completed === false ? `, accepted but not complete yet (${o.awaits ?? "waiting"})` : ""}.`);
        // A captured or corrected agenda topic is shown as it now reads, so the owner can check it.
        for (const l of o.shown ?? []) lines.push(l);
        for (const r of o.results ?? []) for (const l of r.shown ?? []) lines.push(l);
        break;
    }
  }
  return lines;
}

/** Whether the words the owner used fit a title or a name: every word of any length that says something (not "stand-up", "meeting", "the", ...) is found in it, in any case. No words fit everything. */
const FILLER = new Set(["the", "a", "an", "my", "our", "of", "for", "stand", "up", "standup", "stand-up", "meeting"]);
function looseMatch(words: string, text: string): boolean {
  const haystack = text.toLowerCase();
  const wanted = words.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length > 0 && !FILLER.has(w));
  return wanted.every((w) => haystack.includes(w));
}

/** Words that say nothing about which meeting decision is meant, besides those every title match ignores. */
const DECISION_FILLER = new Set(["decision", "decisions", "change", "changes", "one", "ones", "thing", "things", "it", "that", "this", "those", "these", "motion", "vote", "proposal", "item", "agree", "decline", "yes", "no", "please", "go", "ahead", "with", "to", "on", "about", "and", "in"]);
/** Whether the owner's words fit a held decision's wording or topic: every significant word (`all`), or at least one when `all` is false; whole words only, a plural fits its singular. No significant word fits everything. */
function decisionWordsMatch(words: string, text: string, all: boolean): boolean {
  // Words are letters and digits only, so "staging-server" is "staging server".
  const split = (x: string): string[] => x.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  const have = new Set(split(text));
  const wanted = split(words).filter((w) => !FILLER.has(w) && !DECISION_FILLER.has(w));
  // Whole words only ("art" is not "start"); a plural fits its singular and the other way round ("boxes" and "box", "builds" and "build").
  const has = (w: string): boolean => have.has(w) || (w.length > 3 && w.endsWith("s") && have.has(w.slice(0, -1))) || (w.length > 4 && w.endsWith("es") && have.has(w.slice(0, -2))) || (w.length > 2 && (have.has(`${w}s`) || have.has(`${w}es`)));
  return wanted.length === 0 || (all ? wanted.every(has) : wanted.some(has));
}

/** Why an address cannot be a probe's, in the words of the probe's own check (the field name left off), or `undefined` when it can. */
function probeUrlProblem(url: string): string | undefined {
  try { probeUrl(url); return undefined; } catch (e) { return e instanceof Error ? e.message.replace(/^url: /, "").slice(0, 200) : "is not usable"; }
}

/** Enough open proposals to tell them apart: more than this and the owner is asked rather than the model's pick trusted on a partial list. */
const OPEN_SCAN = 100;

/** Lower case, white space collapsed, punctuation at either end dropped. */
const tidyWords = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");

/** One-word replies that agree. */
const ASSENT = new Set(["yes", "y", "yeah", "yep", "yup", "ok", "okay", "sure", "fine", "right", "correct", "agreed"]);
/** One-word replies that refuse. Used only to refuse: a message that is only one of these never applies a proposal (and one of ASSENT never drops one); neither list makes the chat do anything. */
const REFUSAL = new Set(["no", "n", "nope", "nah", "cancel", "stop", "never", "dont", "don't", "don\u2019t"]);
/** One-word replies that agree or refuse: they answer a question only when they are one of its recorded choices, never through an option's label. */
const AGREEMENT = new Set([...ASSENT, ...REFUSAL]);

/** Small words that say nothing about which proposal is meant: they neither name one nor point away from one. */
const PLAIN_WORDS = new Set(["the", "and", "for", "that", "this", "these", "those", "with", "from", "into", "onto", "one", "ones", "yes", "yeah", "yep", "please", "okay", "sure", "its", "not", "but", "you", "your", "our", "all", "any", "are", "was", "were", "has", "have", "had", "will", "would", "should", "can", "could", "just", "now", "then", "there", "here", "what", "which", "too", "also", "thanks", "thank", "ahead", "them", "they", "their", "let", "lets", "out", "off", "about", "only"]);

/**
 * Whether the owner's words single out the proposal the model picked among several open ones: the words the model cites say something that appears in that proposal's text and in no other open one's (a word of
 * at least three letters that is not a plain small word, or any number), or its ID as written; and the owner's whole message says nothing that points to another open proposal instead (a word that proposal's text
 * has and the pick's has not, or its ID), unless the same message also agrees to or drops that other one. Words that fit every proposal alike ("yes please", "do that") name none, so the owner is asked. A pick that
 * is not open at all is left to the stale-proposal checks; a list too long to read in full names nothing.
 */
function namesOneProposal(evidence: string, words: string, proposalId: string, open: readonly { id: string; summary: string[] }[], targeted: ReadonlySet<string>): boolean {
  if (open.length >= OPEN_SCAN) return false;
  const chosen = open.find((p) => p.id === proposalId);
  if (chosen === undefined) return evidenceStrong(evidence);
  const tokens = (text: string): Set<string> => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => /^\p{N}+$/u.test(t) || ([...t].length >= 3 && !PLAIN_WORDS.has(t))));
  const own = tokens(chosen.summary.join(" "));
  const others = open.filter((p) => p !== chosen);
  const message = words.toLowerCase();
  const said = tokens(words);
  const elsewhere = others.filter((p) => !targeted.has(p.id));
  if (elsewhere.some((p) => message.includes(p.id.toLowerCase()) || [...tokens(p.summary.join(" "))].some((t) => !own.has(t) && said.has(t)))) return false;
  if (evidence.toLowerCase().includes(chosen.id.toLowerCase())) return true;
  const otherTokens = others.map((p) => tokens(p.summary.join(" ")));
  return [...tokens(evidence)].some((t) => own.has(t) && otherTokens.every((o) => !o.has(t)));
}

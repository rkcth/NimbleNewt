import { createHash } from "node:crypto";
import { BUILTIN_COMMANDS, OPERATION_BY_NAME } from "../api/operations.js";
import { parseInvocation } from "../commands/resolve.js";
import { API_VERSION, type StateApi } from "../api/state-api.js";
import { GATE_TOPIC, normalTopic, notADecisionIn } from "../decisions/records.js";
import { DomainError } from "../domain/errors.js";
import { onlyKnown } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { derivedId } from "../domain/ids.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal, PrincipalService } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { Cite, StatusRequest } from "../status/index.js";
import type { CoordinatorService } from "./coordinator.js";
import { saysMainAutomatic, CHAT_OPS, TITLE_KEYS, acceptedArgs, describe, foreignValue, hasRefMarker, ownerSaysMove, proposalReason } from "./commands.js";
import { profileDefaults } from "../policy/integration-policy.js";
import { lengthInWords, type EditDraft, type PolicyEditService } from "./policy-edit.js";
import { CHAT_LIMITS, checkIntents, evidenceInText, evidenceStrong, refuseCredentials, splitQuoted, type ChatInterpreter, type Intent } from "./interpreter.js";

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
  | { readonly i: number; readonly kind: "coordinator"; readonly action: "answer" | "decompose" | "assign" | "configure" | "start" | "pause" | "stop"; readonly projectId?: string; readonly question?: string; readonly outcome?: string; readonly principalId?: string; readonly routes?: readonly string[]; /** The revision of the coordinator record the order expects, read once when the message was planned, so a retry of the turn sends the same thing. */ readonly expectedRevision?: number }
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
  readonly held?: readonly { readonly intent: Intent; readonly text: string }[];
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
  readonly projects: Readonly<Record<string, { readonly touchedAt: string; readonly lastTaskId?: string; readonly turns: readonly { readonly turnId: string; readonly at: string; readonly summary: string }[] }>>;
}

export interface TurnResult {
  readonly turnId: string;
  readonly replayed: boolean;
  readonly outcomes: readonly Outcome[];
  /** The owner-facing answer, one plain line each. */
  readonly reply: readonly string[];
}

export interface ApplyResult { readonly proposalId: string; readonly applied: boolean; readonly replayed: boolean; readonly results: readonly ChatStepResult[]; readonly failure?: { readonly step: number; readonly code: string; readonly message: string } }

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
}

/**
 * Typed orders that work without the assistant and run as typed (card U06): pause and resume, suspend, stop and Force Stop, and taking a right back. The owner typing the exact command is the order, so they are not shown first;
 * every other command that changes things still is. They need nothing from the model, so a provider outage does not stand between the owner and a stop.
 */
const RECOVERY_OPS: ReadonlySet<string> = new Set(["lifecycle.pause", "lifecycle.resume", "lifecycle.stop", "lifecycle.force", "lifecycle.choose", "lifecycle.advance", "grant.revoke"]);

const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROJECT_ID = /^proj-[a-z2-7]{20}$/;
const PROPOSAL_ID = /^prop-[0-9a-f]{32}$/;
const hash = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const asJson = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

type Resolved =
  | { readonly ok: true; readonly steps: ChatStep[]; readonly pins: ChatPin[]; readonly labels: Record<string, string>; readonly projectId?: string; readonly reason?: string; readonly args: Record<string, unknown>; readonly op: string }
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
/** True if `value` appears in `text` as a whole word: not as a part of a longer name, ID or action. */
const wholeWord = (text: string, value: string): boolean => value.length > 0 && new RegExp(`(^|[^A-Za-z0-9:._*-])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9:_*-]|\\.(?![A-Za-z0-9:_*-]))`, "i").test(text);
/** The sentence of `text` that holds `value` as a whole word (a scope or a time limit counts only when said about the same right). */
const sentenceWith = (text: string, value: string): string | undefined => text.split(/(?<=[.!?])\s+|\n+/).find((part) => wholeWord(part, value));

export class ChatService {
  readonly #runner: CommandRunner;
  readonly #deps: ChatDeps;

  private constructor(runner: CommandRunner, deps: ChatDeps) {
    this.#runner = runner;
    this.#deps = deps;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: ChatDeps, options: RunnerOptions = {}): ChatService {
    return new ChatService(new CommandRunner(storage, epoch, options), deps);
  }

  // ---- the message -----------------------------------------------------------------------------------------------------------

  /** Handles one message from the owner. `messageId` is the owner's idempotency key for the message: sending it again returns the first turn. */
  async submit(token: unknown, message: { messageId: string; text: string; quoted?: readonly string[] }): Promise<TurnResult> {
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

    let turn = await this.#turn(turnId);
    let replayed = turn !== undefined;
    if (turn === undefined) {
      if (split.text.length === 0) invalid("text", "has no words of the owner's own outside quoted material");
      const context = await this.#context(owner.id);
      const focus = await this.#focus(tok, context.focusProjectId);
      // A message that is a typed command (`/nimblenewt.grant-list`) is not read by the assistant: it is the command, as the owner typed it.
      const typed = split.text.trim();
      const isCommand = quoted.length === 0 && parseInvocation(typed) !== undefined;
      const interpreted = isCommand ? { intents: [] as never[], problem: "" } : await this.#interpret({ text: split.text, quoted: safeQuoted, focus, now: this.#runner.now(), proposals: [...(await this.#openProposals(owner.id)), ...(await this.#openEdits(owner))].slice(0, 10), ...(context.awaiting === undefined ? {} : { awaiting: context.awaiting }) });
      if ("unavailable" in interpreted) return { turnId, replayed: false, outcomes: [], reply: ["The assistant that reads free-form messages is unavailable right now. Nothing was done; the commands of the API and the proposals you already have work as usual."] };
      const planned = isCommand
        ? { items: [{ i: 0, kind: "command", typed } as PlanItem], projectId: context.focusProjectId, held: undefined, resumes: undefined }
        : interpreted.intents === undefined
        ? { items: [{ i: 0, kind: "refused", code: "interpreter_invalid", message: interpreted.problem } as PlanItem], projectId: context.focusProjectId, held: undefined, resumes: undefined }
        : await this.#plan(owner, tok, turnId, split.text, interpreted.intents, focus, context.focusProjectId, safeQuoted.length > 0);
      const body: TurnBody = { ownerId: owner.id, messageId, text: split.text, quotedCount: quoted.length, ...(planned.projectId === undefined ? {} : { projectId: planned.projectId }), ...(planned.held === undefined ? {} : { held: planned.held }), ...(planned.resumes === undefined ? {} : { resumes: planned.resumes }), status: "planned", plan: planned.items, createdAt: this.#runner.now() };
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
    const finished = turn.status === "done" ? turn : await this.#execute(owner, tok, turnId, turn);
    return { turnId, replayed, outcomes: finished.outcomes ?? [], reply: replyOf(finished.outcomes ?? []) };
  }

  /** A turn as recorded (the owner only): what was planned and what came of each part, with the command IDs that link it to the audit trail. */
  async getTurn(token: unknown, turnId: string): Promise<TurnBody | undefined> {
    const owner = await this.#owner(token);
    const turn = await this.#turn(turnId);
    return turn === undefined || turn.ownerId !== owner.id ? undefined : turn;
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
  async applyProposal(token: unknown, request: { commandId: string; proposalId: string }): Promise<ApplyResult> {
    const owner = await this.#owner(token);
    onlyKnown(request, ["commandId", "proposalId"]);
    return this.#apply(owner, token as string, request.proposalId, request.commandId, undefined);
  }

  async discardProposal(token: unknown, request: { commandId: string; proposalId: string }): Promise<{ proposalId: string; replayed: boolean }> {
    const owner = await this.#owner(token);
    onlyKnown(request, ["commandId", "proposalId"]);
    return this.#discard(owner, request.proposalId, request.commandId, undefined);
  }

  // ---- per-project conversation context ----------------------------------------------------------------------------------------

  /** The owner's conversation context: the project in focus and, per project, what was last said and done there. Switching focus keeps every project's own thread. */
  async context(token: unknown): Promise<ContextBody> {
    return this.#context((await this.#owner(token)).id);
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

  async #plan(owner: Principal, token: string, turnId: string, text: string, intents: Intent[], focus: { projectId?: string; projectName?: string }, focusProjectId: string | undefined, hasQuoted: boolean): Promise<{ items: PlanItem[]; projectId: string | undefined; held: { intent: Intent; text: string }[] | undefined; resumes: string | undefined }> {
    if (intents.length === 0) return { items: [{ i: 0, kind: "asked", question: "I could not tell what you want done. Which project or task do you mean, and what should change?", options: [] }], projectId: focusProjectId, held: undefined, resumes: undefined };
    // Work to plan: each intent with the owner's words it was said in. An `answer` to an earlier question is replaced by that turn's held commands with the answer filled in.
    const work: { intent: Intent; text: string; trusted: boolean; quoted: boolean }[] = [];
    let resumes: string | undefined;
    const early: PlanItem[] = [];
    for (const intent of intents) {
      if (intent.kind !== "answer") { work.push({ intent, text, trusted: false, quoted: hasQuoted }); continue; }
      if (intent.basis === "quoted" || !evidenceInText(intent.evidence, text) || !evidenceStrong(intent.evidence)) { early.push({ i: work.length + early.length, kind: "refused", code: "untrusted_authority", message: "That answer is not in your own words." }); continue; }
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
    let coordinatorRevision: number | undefined;
    for (const [n, { intent, text: words, trusted, quoted }] of work.entries()) {
      const i = items.length;
      const push = (item: PlanItem): void => { items.push(item); workOf.push(n); };
      if (intent.kind === "clarify") { push({ i, kind: "asked", question: intent.question, options: intent.options ?? [] }); continue; }
      if (intent.kind === "none") { push({ i, kind: "ignored", reason: intent.reason }); continue; }
      if (intent.kind === "answer") { push({ i, kind: "refused", code: "not_resumable", message: "an answer cannot be held" }); continue; }
      if (!trusted && (intent.basis === "quoted" || !evidenceInText(intent.evidence, words) || !evidenceStrong(intent.evidence))) {
        push({ i, kind: "refused", code: "untrusted_authority", message: intent.basis === "quoted" ? "That instruction came from quoted text, which cannot ask for anything. Say it yourself if you want it." : "The words this was based on are not a phrase of your own message, so it was not done." });
        continue;
      }
      if (intent.kind === "switch_focus") {
        const found = await this.#projectByIntent(token, intent.projectId, intent.projectName);
        if (found.ok) { currentFocus = { projectId: found.id, projectName: found.name }; projectId = found.id; push({ i, kind: "focus", projectId: found.id, preview: `Focus on project "${found.name}"` }); }
        else push(askOrRefuse(i, found, n));
        continue;
      }
      if (intent.kind === "apply_proposal" || intent.kind === "discard_proposal") {
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
        if (request["projectId"] === undefined && ["changes", "delivered", "noticeboard"].includes(String(request["kind"]))) {
          if (currentFocus.projectId === undefined) { push({ i, kind: "refused", code: "invalid_command", message: "Say which project you mean." }); continue; }
          request["projectId"] = currentFocus.projectId;
        }
        // A task's activity is asked for by the task's title (the project in focus); a title that fits more than one task asks nothing and says so.
        if (request["kind"] === "activity" && request["taskId"] === undefined && typeof request["taskTitle"] === "string") {
          if (currentFocus.projectId === undefined) { push({ i, kind: "refused", code: "invalid_command", message: "Say which project you mean." }); continue; }
          const matches = await this.#tasksByTitle(token, currentFocus.projectId, request["taskTitle"]);
          if (matches.length !== 1) { push({ i, kind: "refused", code: matches.length === 0 ? "not_found" : "invalid_command", message: matches.length === 0 ? `no task called "${request["taskTitle"].slice(0, 80)}" in that project` : `more than one task is called "${request["taskTitle"].slice(0, 80)}"; use its ID` }); continue; }
          request["taskId"] = matches[0]!.id;
          delete request["taskTitle"];
        }
        if (!isObject(request) || hasRefMarker(request)) { push({ i, kind: "refused", code: "invalid_command", message: "that question is not understood" }); continue; }
        push({ i, kind: "status", request: asJson(request) });
        continue;
      }
      if (intent.kind === "coordinator") {
        // What is said to the coordinator is the owner's own: its texts must be in the message, like any command's. The project is the one named or in focus.
        const texts = { ...(intent.question === undefined ? {} : { question: intent.question }), ...(intent.outcome === undefined ? {} : { outcome: intent.outcome }), ...(intent.principalId === undefined ? {} : { principalId: intent.principalId }), ...(intent.routes === undefined ? {} : { routes: [...intent.routes] }) };
        const foreign = foreignValue(texts, words);
        if (foreign !== undefined) { push({ i, kind: "refused", code: "unsupported_value", message: `${foreign} is not in your message, so it was not done. Say what it should be.` }); continue; }
        let target: string | undefined;
        if (intent.action === "answer" || intent.action === "decompose" || intent.action === "assign") {
          const found = intent.projectId === undefined && intent.projectName === undefined ? (currentFocus.projectId === undefined ? undefined : { ok: true as const, id: currentFocus.projectId, name: currentFocus.projectName ?? "" }) : await this.#projectByIntent(token, intent.projectId, intent.projectName);
          if (found === undefined) { const ask = await this.#askProject(); push(ask.ok ? { i, kind: "refused", code: "invalid_command", message: "Say which project you mean." } : askOrRefuse(i, ask, n)); continue; }
          if (!found.ok) { push(askOrRefuse(i, found, n)); continue; }
          target = found.id;
          projectId = found.id;
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
        push({ i, kind: "coordinator", action: intent.action, ...(expectedRevision === undefined ? {} : { expectedRevision }), ...(target === undefined ? {} : { projectId: target }), ...(intent.question === undefined ? {} : { question: intent.question }), ...(intent.outcome === undefined ? {} : { outcome: intent.outcome }), ...(intent.principalId === undefined ? {} : { principalId: intent.principalId }), ...(intent.routes === undefined ? {} : { routes: intent.routes }) });
        continue;
      }
      // Every text in the command must be the owner's own words (or a record, or a fixed choice): a model cannot add content the owner never said.
      if (hasRefMarker(intent.args)) { push({ i, kind: "refused", code: "invalid_command", message: "$ref is reserved for steps the controller builds" }); continue; }
      // The reason recorded with a right is the owner's message, set by the chat. A gate is always shown to the owner first, so its kind and its (fixed) topic need not be words of the message: the wording still must be.
      const unchecked = intent.op === "grant.create" ? ["basis"] : intent.op === "decision.record" && intent.args["category"] === "gate" ? ["gate", "topic"] : [];
      const foreign = foreignValue(unchecked.length === 0 ? intent.args : Object.fromEntries(Object.entries(intent.args).filter(([k]) => !unchecked.includes(k))), words);
      if (foreign !== undefined) { push({ i, kind: "refused", code: "unsupported_value", message: `${foreign} is not in your message, so it was not done. Say what it should be.` }); continue; }
      const landing = intent.op === "project.create" ? (intent.args["integration"] as { landing?: unknown } | undefined)?.landing : intent.args["landing"];
      if (landing === "main-automatic" && !saysMainAutomatic(words)) { push({ i, kind: "refused", code: "unsupported_value", message: "Landing on main with no human step is only set when your own message says so (for example \"land finished work on main automatically\")." }); continue; }
      const resolved = await this.#resolve(token, intent, currentFocus, pending, profile, words, quoted);
      if (!resolved.ok) { push(askOrRefuse(i, resolved, n)); continue; }
      projectId = resolved.projectId ?? projectId;
      // A captured topic is linked to this very turn (set here, after the interpreter's arguments were checked, so it cannot be named by anyone else).
      const steps = resolved.steps.map((st) => (st.op === "agenda.capture" || st.op === "decision.record" ? { ...st, args: { ...st.args, sourceTurnId: turnId } } : st));
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
        push({ i, kind: "propose", proposalId, steps, pins: resolved.pins, preview: steps.map((st) => describe(st.op, st.args, resolved.labels)), reason: resolved.reason });
      }
    }
    // One question holds the message: nothing that would change a record runs while something is unanswered. The held commands are kept, so the answer carries them on.
    if (items.some((it) => it.kind === "asked")) {
      const held = items.map((it): PlanItem => it.kind === "apply" ? { i: it.i, kind: "held", preview: it.preview } : it.kind === "propose" ? { i: it.i, kind: "held", preview: it.preview[0] ?? "" } : it.kind === "focus" || it.kind === "apply_proposal" || it.kind === "discard_proposal" || it.kind === "policy" || it.kind === "coordinator" ? { i: it.i, kind: "held", preview: it.kind === "focus" ? it.preview : it.kind === "policy" ? it.preview[0] ?? "policy change" : it.kind === "coordinator" ? `coordinator: ${it.action}` : it.kind } : it);
      // What was refused stays refused: it is kept as a no-op, so an answer cannot let it through. A model's own question cannot be answered by the owner's choice, so it is not resumable.
      const refusedWork = new Set(items.flatMap((it, k) => (it.kind === "refused" ? [workOf[k] as number] : [])));
      const resumable = !work.some((w) => w.intent.kind === "clarify") && early.length === 0;
      return { items: held, projectId, held: resumable ? work.map((w, n) => (refusedWork.has(n) ? { intent: { kind: "none", reason: "refused earlier" } as Intent, text: w.text } : { intent: w.intent, text: w.text })) : undefined, resumes };
    }
    return { items, projectId, held: undefined, resumes };
  }

  /** The commands an earlier, unanswered turn held, with the owner's answer filled in; or why they cannot be carried on. */
  async #expandAnswer(owner: Principal, turnId: string, choice: string): Promise<{ work: { intent: Intent; text: string }[]; quoted: boolean } | { refuse: string }> {
    const old = typeof turnId === "string" ? await this.#turn(turnId) : undefined;
    if (old === undefined || old.ownerId !== owner.id || old.held === undefined) return { refuse: "there is no unanswered question to carry on" };
    if (old.resumedBy !== undefined) return { refuse: "that question was already answered" };
    const asked = old.plan.find((it): it is Extract<PlanItem, { kind: "asked" }> => it.kind === "asked" && it.field !== undefined);
    if (asked === undefined || asked.intentIndex === undefined || asked.field === undefined || !(asked.choices ?? []).includes(choice)) return { refuse: "that is not one of the answers offered" };
    const work = old.held.map((h) => ({ ...h }));
    const target = work[asked.intentIndex];
    if (target === undefined || target.intent.kind !== "command") return { refuse: "the held command is gone" };
    const args: Record<string, unknown> = { ...target.intent.args };
    const titleKey = Object.entries(TITLE_KEYS).find(([, id]) => id === asked.field)?.[0];
    if (titleKey !== undefined) delete args[titleKey];
    if (asked.field === "projectId") delete args["projectName"];
    const nameKey = { inquiryId: "questionTopic", occurrenceId: "meetingTopic", watchedTaskId: "watchedTaskTitle" }[asked.field];
    if (nameKey !== undefined) delete args[nameKey];
    if (asked.field.startsWith("integration.")) {
      // An answer to one of the project-creation questions fills one field of the integration section (a number for the refresh rounds, a list for the checks); the choice is the owner's word, so it counts as said.
      const key = asked.field.slice("integration.".length);
      const value: unknown = key === "refreshRounds" && choice !== "default" ? Number(choice) : key === "requiredChecks" && choice !== "default" ? choice.split("+") : choice;
      args["integration"] = { ...((args["integration"] as Record<string, unknown> | undefined) ?? {}), [key]: value };
      work[asked.intentIndex] = { intent: { ...target.intent, args }, text: `${target.text}. ${choice}` };
      return { work, quoted: old.quotedCount > 0 };
    }
    args[asked.field] = choice;
    work[asked.intentIndex] = { intent: { ...target.intent, args }, text: target.text };
    return { work, quoted: old.quotedCount > 0 };
  }

  /** Turns one command intent into steps: checks the operation and its arguments, names things from records, fills in revisions, decides apply or propose. */
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
    if (intent.op === "decision.record" && args["category"] === "gate") args["topic"] = GATE_TOPIC;
    const labels: Record<string, string> = {};
    const pins: ChatPin[] = [];
    const steps: ChatStep[] = [];

    // A right is only what the owner said: the principal, the action, the grant and the scope must each appear in the message as a whole word, never as a part of a longer one.
    if (intent.op.startsWith("grant.")) {
      if (args["projectName"] !== undefined || args["projectId"] !== undefined) return refuse("invalid_command", "a right names its scope as `project`: a project ID, or * for everywhere");
      for (const key of ["grantee", "action", "grantId"]) if (typeof args[key] === "string" && !wholeWord(words, args[key] as string)) return refuse("unsupported_value", `${key} is not in your message as written, so it was not done. Say it exactly.`);
      if (intent.op === "grant.create") {
        const scope = args["project"];
        // The chat gives a right only in one plain form, so nothing can limit, negate or change it unseen: "give <principal> the <action> right everywhere permanently" (or in <project ID>). Every word that is not one of those, or filler from a short fixed list, refuses the message; the reason recorded with the right is the owner's message itself.
        if (args["expiresAt"] !== undefined || args["notBefore"] !== undefined) return refuse("unsupported_value", "the chat gives rights with no time limit; for a limited right use the grant.create operation with expiresAt");
        const FILL = new Set(["please", "give", "grant", "allow", "let", "the", "right", "permission", "access", "to", "everywhere", "permanently", "in", "all", "every", "projects", "project"]);
        let rest = words.toLowerCase();
        for (const v of [args["grantee"], args["action"], scope]) if (typeof v === "string" && v !== "*") rest = rest.split(v.toLowerCase()).join(" ");
        const leftover = rest.split(/[\s,;.!?:]+/).filter((w) => w.length > 0 && w !== "*" && !FILL.has(w));
        if (leftover.length > 0) return refuse("unsupported_value", `"${leftover[0]!.slice(0, 40)}" is not understood in a request for a right. Say only: give <who> the <action> right everywhere permanently (a limited right uses the grant.create operation).`);
        if (!/\bpermanently\b/i.test(words)) return refuse("unsupported_value", "say that the right is permanent: give <who> the <action> right everywhere permanently");
        args["basis"] = `owner chat: ${words}`.slice(0, 200);
        if (scope === "*") { if (!/\b(everywhere|all projects|every project)\b|\*/i.test(words)) return refuse("unsupported_value", "everywhere is not what you said, so it was not done. Name the project, or say everywhere."); }
        else if (typeof scope === "string") {
          if (!wholeWord(words, scope)) return refuse("unsupported_value", "project is not in your message as written, so it was not done. Say it exactly.");
          const found = await this.#projectByIntent(token, scope, undefined);
          if (!found.ok) return found;
          labels[found.id] = found.name;
        } else return refuse("invalid_command", "which project? Name its ID, or say everywhere.");
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
      if (Object.keys(kept).length === 0) delete args["integration"]; else args["integration"] = kept;
    }

    // The project: named, or the one in focus.
    let projectId: string | undefined;
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
    if (projectId === undefined && needsScope) return await this.#askProject();

    // Tasks named by title: exactly one match in the project, or a question.
    for (const [titleKey, idKey] of Object.entries(TITLE_KEYS)) {
      const title = args[titleKey];
      if (title === undefined) continue;
      delete args[titleKey];
      if (typeof title !== "string" || title.length === 0) return refuse("invalid_command", `${titleKey} must be text`);
      if (args[idKey] !== undefined) return refuse("invalid_command", `give either ${idKey} or ${titleKey}, not both`);
      const matches = await this.#tasksByTitle(token, projectId as string, title);
      if (matches.length === 0) return refuse("not_found", `no task called "${title.slice(0, 80)}" in that project`);
      if (matches.length > 1) return { ok: false, kind: "ask", question: `More than one task is called "${title.slice(0, 80)}". Which one?`, options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${m.id} (${m.state})`), field: idKey, choices: matches.slice(0, CHAT_LIMITS.options).map((m) => m.id) };
      args[idKey] = (matches[0] as { id: string }).id;
    }
    // An agenda item named by its words: exactly one open item of the project whose topic contains them, or the owner is asked.
    if (intent.op === "agenda.correct") {
      const named = args["agendaTopic"];
      delete args["agendaTopic"];
      if (named !== undefined && args["itemId"] !== undefined) return refuse("invalid_command", "give either itemId or agendaTopic, not both");
      if (args["itemId"] === undefined) {
        if (named !== undefined && typeof named !== "string") return refuse("invalid_command", "agendaTopic must be text");
        const open = await this.#listAll(token, "agenda.list", { projectId });
        const words = typeof named === "string" ? named.trim().toLowerCase() : "";
        const matches = open.filter((i) => words === "" || String(i["topic"]).toLowerCase().includes(words));
        if (matches.length === 0) return refuse("not_found", words === "" ? "there is no open agenda item in that project" : `no open agenda item about "${(named as string).slice(0, 80)}" in that project`);
        if (matches.length > 1) return { ok: false, kind: "ask", question: "Which agenda item do you mean?", options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${String(m["id"])} (${String(m["topic"]).slice(0, 60)})`), field: "itemId", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => String(m["id"])) };
        args["itemId"] = String(matches[0]!["id"]);
      }
      const found = await this.#get(token, "agenda.get", { itemId: args["itemId"] });
      if (found === undefined) return refuse("not_found", "no such agenda item");
      labels[String(args["itemId"])] = String(found["topic"]);
    }
    // A question to the owner named by its words (or the only one waiting): the one open question whose words, task or asker contain them, else the owner is asked.
    if (intent.op === "owner.answer") {
      const named = args["questionTopic"];
      delete args["questionTopic"];
      if (named !== undefined && args["inquiryId"] !== undefined) return refuse("invalid_command", "give either inquiryId or questionTopic, not both");
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
        if (matches.length === 0) return refuse("not_found", words === "" ? "no agent is waiting for your answer" : `no waiting question is about "${words.slice(0, 80)}"`);
        if (matches.length > 1) return { ok: false, kind: "ask", question: "Which question are you answering?", options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${String(m["inquiryId"])} (${String(m["question"]).slice(0, 60)})`), field: "inquiryId", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => String(m["inquiryId"])) };
        args["inquiryId"] = String(matches[0]!["inquiryId"]);
      }
    }
    // A meeting named by its words (the one planned meeting of the project whose title contains them, or the only one) and an agent named by its name: both are resolved from the records, and anything unclear asks.
    if (intent.op === "meeting.invite-direct") {
      const topic = args["meetingTopic"];
      const agentName = args["agentName"];
      delete args["meetingTopic"];
      delete args["agentName"];
      if (topic !== undefined && args["occurrenceId"] !== undefined) return refuse("invalid_command", "give either occurrenceId or meetingTopic, not both");
      if (agentName !== undefined && args["agent"] !== undefined) return refuse("invalid_command", "give either agent or agentName, not both");
      if ((topic !== undefined && typeof topic !== "string") || (agentName !== undefined && typeof agentName !== "string")) return refuse("invalid_command", "meetingTopic and agentName must be text");
      if (typeof args["occurrenceId"] === "string") {
        const planned = await this.#listAll(token, "meeting.planned", { projectId });
        if (!planned.some((i) => i["id"] === args["occurrenceId"])) return refuse("not_found", "that meeting is not planned in this project");
      }
      if (args["occurrenceId"] === undefined) {
        const planned = await this.#listAll(token, "meeting.planned", { projectId });
        const words = typeof topic === "string" ? topic.trim().toLowerCase() : "";
        const matches = planned.filter((i) => words === "" || String(i["title"]).toLowerCase().includes(words));
        if (matches.length === 0) return refuse("not_found", words === "" ? "no meeting is planned in that project" : `no planned meeting is called "${words.slice(0, 80)}"`);
        if (matches.length > 1) return { ok: false, kind: "ask", question: "Which meeting do you mean?", options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${String(m["id"])} (${String(m["title"]).slice(0, 60)}, ${String(m["startsAt"])})`), field: "occurrenceId", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => String(m["id"])) };
        args["occurrenceId"] = String(matches[0]!["id"]);
      }
      if (args["agent"] === undefined) {
        if (typeof agentName !== "string" || agentName.trim() === "") return refuse("invalid_command", "say which agent should attend");
        const agents = await this.#listAll(token, "agent.list", { state: "active" });
        const named = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === agentName.trim().toLowerCase());
        if (named.length !== 1) return refuse(named.length === 0 ? "not_found" : "invalid_command", named.length === 0 ? `no active agent called "${agentName.slice(0, 80)}"` : `more than one agent is called "${agentName.slice(0, 80)}"`);
        args["agent"] = String(named[0]!["principalId"]);
        labels[String(args["agent"])] = agentName.trim();
      }
    }
    // A watch: the stream is the named task's own unless another task is named (`watchedTaskTitle`, exactly one task of the project); the task whose owner is told is the one named in the usual way.
    if (intent.op === "watch.create") {
      const watched = args["watchedTaskTitle"];
      delete args["watchedTaskTitle"];
      if (typeof args["watchedTaskId"] === "string" && args["stream"] === undefined) {
        const t = await this.#get(token, "task.get", { taskId: args["watchedTaskId"] });
        if (t === undefined || t["projectId"] !== projectId) return refuse("not_found", "that task is not in this project");
        args["stream"] = `task:${args["watchedTaskId"]}`;
      }
      delete args["watchedTaskId"];
      if (args["stream"] !== undefined && watched !== undefined) return refuse("invalid_command", "give either stream or watchedTaskTitle, not both");
      if (typeof args["taskId"] !== "string") return refuse("invalid_command", "say which task's owner should be told");
      if (args["stream"] === undefined) {
        if (watched === undefined) args["stream"] = `task:${args["taskId"]}`;
        else {
          if (typeof watched !== "string" || watched.length === 0) return refuse("invalid_command", "watchedTaskTitle must be text");
          const matches = await this.#tasksByTitle(token, projectId as string, watched);
          if (matches.length === 0) return refuse("not_found", `no task called "${watched.slice(0, 80)}" in that project`);
          if (matches.length > 1) return { ok: false, kind: "ask", question: `More than one task is called "${watched.slice(0, 80)}". Which one?`, options: matches.slice(0, CHAT_LIMITS.options).map((m) => `${m.id} (${m.state})`), field: "watchedTaskId", choices: matches.slice(0, CHAT_LIMITS.options).map((m) => m.id) };
          args["stream"] = `task:${(matches[0] as { id: string }).id}`;
        }
      }
    }
    // A hand-off: the recipient named by the agent's name (exactly one active agent), and, for completing or cancelling, the hand-off itself found as the one going on for the named task.
    if (intent.op === "handoff.prepare" || intent.op === "handoff.takeover") {
      const named = args["toAgentName"];
      delete args["toAgentName"];
      if (named !== undefined && args["to"] !== undefined) return refuse("invalid_command", "give either to or toAgentName, not both");
      if (args["to"] === undefined) {
        if (typeof named !== "string" || named.trim() === "") return refuse("invalid_command", "say which agent should take the task");
        const agents = await this.#listAll(token, "agent.list", { state: "active" });
        const found = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === named.trim().toLowerCase());
        if (found.length !== 1) return refuse(found.length === 0 ? "not_found" : "invalid_command", found.length === 0 ? `no active agent called "${named.slice(0, 80)}"` : `more than one agent is called "${named.slice(0, 80)}"`);
        args["to"] = { kind: "agent", id: String(found[0]!["id"]) };
        labels[String(found[0]!["id"])] = named.trim();
      }
    }
    if (intent.op === "handoff.complete" || intent.op === "handoff.cancel") {
      if (args["handoffId"] === undefined) {
        if (typeof args["taskId"] !== "string") return refuse("invalid_command", "say which task's hand-off you mean");
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

    // The revision the owner does not have to quote.
    if (spec.revision !== undefined) {
      const filled = await this.#revisionFor(token, spec.revision, args, task, pending);
      if (!filled.ok) return filled;
      if (filled.name !== undefined && filled.value !== undefined && args[filled.name] === undefined) args[filled.name] = filled.value;
    }

    // A running task keeps its checkout: a different repository for a task that is in progress or has an owner is refused, and otherwise it is a proposal (it is an authority field).
    if (intent.op === "task.update" && typeof args["repositoryId"] === "string" && task !== undefined && args["repositoryId"] !== task.repositoryId) {
      const assignment = await this.#get(token, "assignment.get", { taskId: args["taskId"] });
      if (task.state === "in_progress" || (assignment !== undefined && assignment["state"] === "assigned")) return refuse("task_running", `"${task.title}" is being worked on and keeps its repository; release it first if it must move`);
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
        else return { ok: false, kind: "ask", question: `Which repository should "${task.title}" work in?${repos.length === 0 ? " The project has none; add one first." : ""}`, options: repos.slice(0, CHAT_LIMITS.options), ...(repos.length === 0 ? {} : { field: "repositoryId", choices: repos.slice(0, CHAT_LIMITS.options) }) };
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
      if (old.length !== 1) return { ok: false, kind: "ask", question: `Where is "${String(args["label"] ?? "it").slice(0, 80)}"? Give its location (a path or address).`, options: [] };
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
        if (entry["principalId"] !== undefined || typeof entry["agentName"] !== "string") return refuse("invalid_command", "name a participant by agentName or principalId, not both");
        const matches = agents.filter((a) => String(a["friendlyName"]).trim().toLowerCase() === (entry["agentName"] as string).trim().toLowerCase());
        if (matches.length !== 1) return refuse(matches.length === 0 ? "not_found" : "invalid_command", matches.length === 0 ? `no active agent called "${(entry["agentName"] as string).slice(0, 80)}"` : `more than one agent is called "${(entry["agentName"] as string).slice(0, 80)}"; use the agent's ID`);
        delete entry["agentName"];
        entry["principalId"] = matches[0]!["principalId"];
        resolved.push(entry);
      }
      args["participants"] = resolved;
    }
    steps.push({ op: intent.op, args, commandId: "" });
    const reasonBase = proposalReason(intent.op, args, intent.draft === true, { profile, quoted, said: ownerSaysMove(intent.op, args, words, ["taskId", "prerequisiteId", "projectId", "agentId"].flatMap((k) => (typeof args[k] === "string" && labels[args[k] as string] !== undefined ? [labels[args[k] as string] as string] : [])).concat(intent.op === "resource.bind" && typeof args["label"] === "string" ? [args["label"]] : []).concat(extraTargets)) });
    const reason = reasonBase ?? showFirst ?? (fromRecord ? "the location comes from an earlier binding, not from your words, so it is shown first" : undefined);
    return { ok: true, steps, pins, labels, ...(projectId === undefined ? {} : { projectId }), ...(reason === undefined ? {} : { reason }), args, op: intent.op };
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
      case "agenda": {
        const item = typeof args["itemId"] === "string" ? await this.#get(token, "agenda.get", { itemId: args["itemId"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such agenda item") : { ok: true, name: "expectedRevision", value: (item["revision"] as number) + ahead(`agenda:${args["itemId"] as string}`) };
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
        { choice: "integration-branch", says: "finished work is merged onto a separate integration branch; nothing reaches main until you or an integrator promotes it" },
        { choice: "human-promotes", says: "finished work waits for a person to promote it" },
        ...(locked ? [] : [{ choice: "main-automatic", says: "finished work goes to main by itself once its required checks pass, with no human step" }]),
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
    if (matches.length === 0) return { ok: false, kind: "refuse", code: "not_found", message: `no project called "${(projectName ?? "").slice(0, 80)}"` };
    if (matches.length > 1) return { ok: false, kind: "ask", question: `More than one project is called "${(projectName ?? "").slice(0, 80)}". Which one?`, options: matches.slice(0, CHAT_LIMITS.options).map((p) => p["id"] as string), field: "projectId", choices: matches.slice(0, CHAT_LIMITS.options).map((p) => p["id"] as string) };
    return { ok: true, id: (matches[0] as { id: string })["id"] as string, name: (matches[0] as { name: string })["name"] as string };
  }

  async #askProject(): Promise<Resolved> {
    return { ok: false, kind: "ask", question: "Which project do you mean? There is none in focus.", options: [] };
  }

  async #tasksByTitle(token: string, projectId: string, title: string): Promise<{ id: string; state: string }[]> {
    const wanted = title.trim().toLowerCase();
    const all = await this.#listAll(token, "task.list", { projectId });
    return all.filter((t) => (t["title"] as string).trim().toLowerCase() === wanted).map((t) => ({ id: t["id"] as string, state: t["state"] as string }));
  }

  /** The project's unbound resource bindings (the list operation takes no paging). */
  async #unboundResources(token: string, projectId: string): Promise<Record<string, unknown>[]> {
    const response = await this.#deps.api.handle(token, { v: API_VERSION, op: "resource.list", args: { projectId, state: "unbound" } });
    return response.ok ? ((response.result["items"] ?? []) as Record<string, unknown>[]) : [];
  }

  /** Every item of a list operation, bounded (five pages). */
  async #listAll(token: string, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const response = await this.#deps.api.handle(token, { v: API_VERSION, op, args: { ...args, limit: 100, ...(after === undefined ? {} : { after }) } });
      if (!response.ok) { if (response.error.code === "forbidden" || response.error.code === "not_found") return items; throw new DomainError("unavailable", response.error.message); }
      items.push(...((response.result["items"] ?? []) as Record<string, unknown>[]));
      after = response.result["next"] as string | undefined;
      if (after === undefined) break;
    }
    return items;
  }

  /** A read through the API: the item, or undefined when it is missing or not readable (the two read alike). */
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

  async #execute(owner: Principal, token: string, turnId: string, turn: TurnBody): Promise<TurnBody> {
    const outcomes: Outcome[] = [];
    for (const item of turn.plan) outcomes.push(await this.#do(owner, token, turnId, item, turn.text));
    const done: TurnBody = { ...turn, status: "done", outcomes, completedAt: this.#runner.now() };
    try {
      await this.#finishTurn(owner, turnId, done);
    } catch (error) {
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
      const summary = replyOf(outcomes).join(" ").slice(0, 200);
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
      return { i: item.i, status: "refused", code: "needs_confirmation", message: `/nimblenewt.${inv!.name} changes things, so it is not run from a typed line: say what you want in words and it is shown to you first (or send command.run through the API).` };
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
                : answer.phase !== undefined ? `Effected: not yet (${answer.phase}).` : "Effected: recorded.",
      ];
      return { i: item.i, status: "applied", op: String(r["command"]), commandId: `${turnId}-c${item.i}`, shown: [`Ran ${String(r["command"])}:`, ...stages, ...text.split("\n").slice(0, 40)] } as Outcome;
    }
    const why = status === "failed" || status === "unsupported" ? (r["error"] as { message?: string } | undefined)?.message : (r["reason"] ?? r["asks"]);
    const options = Array.isArray(r["candidates"]) ? ` (${(r["candidates"] as string[]).join(", ")})` : "";
    return { i: item.i, status: "refused", code: status === "failed" ? String((r["error"] as { code?: string } | undefined)?.code ?? "failed") : status, message: `${String(why ?? "that command could not be run")}${options}` };
  }

  async #do(owner: Principal, token: string, turnId: string, item: PlanItem, words: string): Promise<Outcome> {
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
          const known = async (): Promise<Record<string, unknown> | undefined> => {
            const done = await this.#get(token, "decision.get", { decisionId: derivedId("dec", scopedCommandId(owner.id, item.commandId)) });
            const src = done?.["source"] as { turnId?: string } | undefined;
            if (done === undefined || src?.turnId !== turnId) return undefined;
            const text = done["state"] === "disputed" ? `Recorded decision version ${String(done["version"])}, but it conflicts with a decision made after the version it was based on: nothing on that topic is in force until you choose.` : `Recorded decision version ${String(done["version"])} on "${String(done["topic"] ?? "the gate")}": ${String(done["statement"] ?? "")}`;
            return { i: item.i, status: "applied", op: item.op, commandId: item.commandId, id: done["id"] as string, shown: [text.slice(0, 600)], accepted: true, completed: true } as Record<string, unknown>;
          };
          const already = await known();
          if (already !== undefined) return already as never;
          const fresh = await this.#revisionFor(token, "decision", args, undefined, new Map());
          if (!fresh.ok) return { i: item.i, status: "refused", op: item.op, commandId: item.commandId, code: "kind" in fresh && fresh.kind === "refuse" ? fresh.code : "invalid_command", message: "kind" in fresh && fresh.kind === "refuse" ? fresh.message : "that decision needs more from you" };
          args = { ...args, basedOn: await this.#decisionBase(token, turnId, args, item.planBase, fresh.value as number) };
        }
        const response = await this.#deps.api.handle(token, { v: API_VERSION, op: item.op, commandId: item.commandId, args });
        if (!response.ok && response.error.code === "command_conflict" && item.op === "decision.record") {
          // The same turn was sent twice at once and the other copy recorded this step between the look and the send: it is done.
          const recorded = await this.#get(token, "decision.get", { decisionId: derivedId("dec", scopedCommandId(owner.id, item.commandId)) });
          const src = recorded?.["source"] as { turnId?: string } | undefined;
          if (recorded !== undefined && src?.turnId === turnId) return { i: item.i, status: "applied", op: item.op, commandId: item.commandId, id: recorded["id"] as string, shown: [`Recorded decision version ${String(recorded["version"])} on "${String(recorded["topic"] ?? "the gate")}".`], accepted: true, completed: true } as never;
        }
        if (!response.ok) return { i: item.i, status: "refused", op: item.op, commandId: item.commandId, code: response.error.code, message: response.error.message };
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
          const result = await this.#apply(owner, token, item.proposalId, `${turnId}-a${item.i}`, turnId);
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
          const made = await service.configure(owner, { commandId, principalId: item.principalId!, routes: item.routes!, ...(item.expectedRevision === undefined ? {} : { expectedRevision: item.expectedRevision }) });
          return { i: item.i, status: "applied", op: "coordinator.configure", commandId, id: made.id, revision: made.revision };
        }
        case "start": case "pause": case "stop": {
          if (item.expectedRevision === undefined) return { i: item.i, status: "refused", code: "not_found", message: "the coordinator is not set up yet" };
          const made = await service.setState(owner, { commandId, expectedRevision: item.expectedRevision, to: item.action === "start" ? "running" : item.action === "pause" ? "paused" : "stopped" });
          return { i: item.i, status: "applied", op: "coordinator.state", commandId, id: made.id, revision: made.revision };
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

  async #apply(owner: Principal, token: string, proposalId: string, commandId: string, fromTurn: string | undefined): Promise<ApplyResult> {
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
    for (const [index, step] of body.steps.entries()) {
      const args = substitute(step.args, results);
      const using = step.as === "coordinator" ? coordinatorToken : token;
      if (using === undefined) return { proposalId, applied: false, replayed: false, results, failure: { step: index, code: "unavailable", message: "the coordinator is not available to make this step" } };
      if (step.op === "decision.record" && step.as === undefined) {
        // A decision step is based on the version of its topic when it was shown, but decisions of the same message applied before it do not count as the topic having moved. A step already recorded (this apply run again) is answered from the record.
        const done = await this.#get(token, "decision.get", { decisionId: derivedId("dec", scopedCommandId(owner.id, step.commandId)) });
        if (done !== undefined) {
          results.push({ op: step.op, id: done["id"] as string, shown: [`Recorded decision version ${String(done["version"])} on "${String(done["topic"] ?? "the gate")}".`], ...(step.key === undefined ? {} : { key: step.key }), accepted: true, completed: true });
          continue;
        }
        const fresh = await this.#revisionFor(token, "decision", args, undefined, new Map());
        if (!fresh.ok) return { proposalId, applied: false, replayed: false, results, failure: { step: index, code: "kind" in fresh && fresh.kind === "refuse" ? fresh.code : "invalid_command", message: "kind" in fresh && fresh.kind === "refuse" ? fresh.message : "that decision needs more from you" } };
        args["basedOn"] = await this.#decisionBase(token, typeof args["sourceTurnId"] === "string" ? args["sourceTurnId"] : "", args, typeof args["basedOn"] === "number" ? args["basedOn"] : undefined, fresh.value as number);
      }
      const response = await this.#deps.api.handle(using, { v: API_VERSION, op: step.op, commandId: step.commandId, args: args as Record<string, unknown> });
      if (!response.ok) return { proposalId, applied: false, replayed: false, results, failure: { step: index, code: response.error.code, message: response.error.message } };
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
      if (!(error instanceof DomainError) || error.code !== "stale_revision") throw error;
      found = await this.#runner.get("chat-proposal", proposalId);
      body = found?.body as unknown as ChatProposalBody | undefined;
      if (body?.status !== "applied") throw error;
      return { proposalId, applied: true, replayed: true, results: body.results ?? [] };
    }
    return { proposalId, applied: true, replayed: false, results };
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

  async #openProposals(ownerId: string): Promise<{ id: string; summary: string[] }[]> {
    const out: { id: string; summary: string[] }[] = [];
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const chunk = await this.#runner.list("chat-proposal", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of chunk) {
        after = a.id;
        const b = a.body as unknown as ChatProposalBody;
        if (b.ownerId === ownerId && b.status === "open" && out.length < 10) out.push({ id: a.id, summary: [...b.preview] });
      }
      if (chunk.length < 200) break;
    }
    return out;
  }

  async #openEdits(owner: Principal): Promise<{ id: string; summary: string[] }[]> {
    try { return (await this.#deps.policyEdits?.open(owner))?.map((e) => ({ id: e.id, summary: e.summary })) ?? []; } catch { return []; }
  }

  async #openCount(ownerId: string): Promise<number> {
    let count = 0;
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const chunk = await this.#runner.list("chat-proposal", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of chunk) { after = a.id; const b = a.body as unknown as ChatProposalBody; if (b.ownerId === ownerId && b.status === "open") count++; }
      if (chunk.length < 200) break;
    }
    return count;
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
    case "contract.set": return `contract:${a["taskId"] as string}`;
    case "decision.record": return `decision:${a["projectId"] as string}:${normalTopic(String(a["topic"] ?? ""))}:${typeof a["taskId"] === "string" ? a["taskId"] : "*"}`;
    case "agenda.correct": return `agenda:${a["itemId"] as string}`;
    default: return undefined;
  }
}

/** The plain lines an API result asks to be shown to the owner (a captured agenda topic), if it has any. */
function shownOf(result: JsonObject): string[] | undefined {
  const lines = result["shown"];
  return Array.isArray(lines) && lines.length > 0 && lines.every((l) => typeof l === "string") ? (lines as string[]).slice(0, 12).map((l) => l.slice(0, 600)) : undefined;
}

const refuse = (code: string, message: string): { ok: false; kind: "refuse"; code: string; message: string } => ({ ok: false, kind: "refuse", code, message });
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
export function replyOf(outcomes: readonly Outcome[]): string[] {
  const lines: string[] = [];
  for (const o of outcomes) {
    // A policy edit says what it means in plain words, what stays as it is, and what was not applied.
    const edit = o.editId === undefined ? "" : [...(o.preview ?? []), ...(o.explanation ?? []), ...(o.unapplied ?? []).map((u) => `Not applied: "${u}".`)].join(" ");
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
      case "proposed": lines.push(o.editId !== undefined ? `Proposed, nothing has changed yet (${o.message ?? ""}). ${edit} Edit ${o.editId}: say to apply it, or to discard it.` : `Proposed, nothing has happened yet (${o.message ?? ""}). Proposal ${o.proposalId ?? ""}: ${(o.preview ?? []).join("; ")}. Say to apply it, or to discard it.`); break;
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

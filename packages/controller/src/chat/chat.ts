import { createHash } from "node:crypto";
import { OPERATION_BY_NAME } from "../api/operations.js";
import { API_VERSION, type StateApi } from "../api/state-api.js";
import { DomainError } from "../domain/errors.js";
import { onlyKnown } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal, PrincipalService } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { CHAT_OPS, TITLE_KEYS, acceptedArgs, describe, foreignValue, hasRefMarker, ownerSaysMove, proposalReason } from "./commands.js";
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

export interface ChatStepResult { readonly op: string; readonly id: string; readonly revision?: number; readonly key?: string; readonly accepted: true; readonly completed: boolean; readonly awaits?: string }

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
  | { readonly i: number; readonly kind: "apply"; readonly op: string; readonly args: JsonObject; readonly commandId: string; readonly preview: string }
  | { readonly i: number; readonly kind: "propose"; readonly proposalId: string; readonly steps: readonly ChatStep[]; readonly pins: readonly ChatPin[]; readonly preview: readonly string[]; readonly reason: string }
  | { readonly i: number; readonly kind: "focus"; readonly projectId: string; readonly preview: string }
  | { readonly i: number; readonly kind: "apply_proposal" | "discard_proposal"; readonly proposalId: string }
  | { readonly i: number; readonly kind: "asked"; readonly question: string; readonly options: readonly string[]; /** For a question the service asked: which command (by position) and which argument the answer fills, and the answers that are allowed. */ readonly intentIndex?: number; readonly field?: string; readonly choices?: readonly string[] }
  | { readonly i: number; readonly kind: "held"; readonly preview: string }
  | { readonly i: number; readonly kind: "refused"; readonly code: string; readonly message: string }
  | { readonly i: number; readonly kind: "ignored"; readonly reason: string };

export interface Outcome {
  readonly i: number;
  readonly status: "applied" | "proposed" | "asked" | "held" | "refused" | "ignored" | "focused" | "discarded";
  readonly op?: string;
  readonly commandId?: string;
  readonly id?: string;
  readonly revision?: number;
  readonly accepted?: true;
  readonly completed?: boolean;
  readonly awaits?: string;
  readonly proposalId?: string;
  readonly preview?: readonly string[];
  readonly question?: string;
  readonly options?: readonly string[];
  readonly code?: string;
  readonly message?: string;
  readonly projectId?: string;
  readonly results?: readonly ChatStepResult[];
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
}

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
      const interpreted = await this.#interpret({ text: split.text, quoted: safeQuoted, focus, proposals: await this.#openProposals(owner.id), ...(context.awaiting === undefined ? {} : { awaiting: context.awaiting }) });
      if ("unavailable" in interpreted) return { turnId, replayed: false, outcomes: [], reply: ["The assistant that reads free-form messages is unavailable right now. Nothing was done; the commands of the API and the proposals you already have work as usual."] };
      const planned = interpreted.intents === undefined
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
        push({ i, kind: intent.kind, proposalId: intent.proposalId });
        continue;
      }
      // Every text in the command must be the owner's own words (or a record, or a fixed choice): a model cannot add content the owner never said.
      if (hasRefMarker(intent.args)) { push({ i, kind: "refused", code: "invalid_command", message: "$ref is reserved for steps the controller builds" }); continue; }
      const foreign = foreignValue(intent.args, words);
      if (foreign !== undefined) { push({ i, kind: "refused", code: "unsupported_value", message: `${foreign} is not in your message, so it was not done. Say what it should be.` }); continue; }
      const resolved = await this.#resolve(token, intent, currentFocus, pending, profile, words, quoted);
      if (!resolved.ok) { push(askOrRefuse(i, resolved, n)); continue; }
      projectId = resolved.projectId ?? projectId;
      if (resolved.reason === undefined) {
        // An explicit order applies now, one API command per step (a first step such as setting the repository, then the order itself).
        const last = resolved.steps.length - 1;
        for (const [k, step] of resolved.steps.entries()) {
          const written = recordOf(step);
          if (written !== undefined) pending.set(written, (pending.get(written) ?? 0) + 1);
          push({ i: items.length, kind: "apply", op: step.op, args: asJson(step.args), commandId: k === last ? `${turnId}-c${i}` : `${turnId}-c${i}-${k}`, preview: describe(step.op, step.args, resolved.labels) });
        }
      } else {
        const proposalId = `prop-${hash(scopedCommandId(owner.id, `${turnId}-p${i}`))}`;
        push({ i, kind: "propose", proposalId, steps: resolved.steps, pins: resolved.pins, preview: resolved.steps.map((st) => describe(st.op, st.args, resolved.labels)), reason: resolved.reason });
      }
    }
    // One question holds the message: nothing that would change a record runs while something is unanswered. The held commands are kept, so the answer carries them on.
    if (items.some((it) => it.kind === "asked")) {
      const held = items.map((it): PlanItem => it.kind === "apply" ? { i: it.i, kind: "held", preview: it.preview } : it.kind === "propose" ? { i: it.i, kind: "held", preview: it.preview[0] ?? "" } : it.kind === "focus" || it.kind === "apply_proposal" || it.kind === "discard_proposal" ? { i: it.i, kind: "held", preview: it.kind === "focus" ? it.preview : it.kind } : it);
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
    args[asked.field] = choice;
    work[asked.intentIndex] = { intent: { ...target.intent, args }, text: target.text };
    return { work, quoted: old.quotedCount > 0 };
  }

  /** Turns one command intent into steps: checks the operation and its arguments, names things from records, fills in revisions, decides apply or propose. */
  async #resolve(token: string, intent: Extract<Intent, { kind: "command" }>, focus: { projectId?: string; projectName?: string }, pending: ReadonlyMap<string, number>, profile: string, words: string, quoted: boolean): Promise<Resolved> {
    const spec = CHAT_OPS[intent.op];
    const accepted = acceptedArgs(intent.op);
    if (spec === undefined || accepted === undefined) return refuse("not_a_chat_command", `${intent.op.slice(0, 60)} is not something that can be done by chat`);
    if (hasRefMarker(intent.args)) return refuse("invalid_command", "$ref is reserved for steps the controller builds");
    for (const key of Object.keys(intent.args)) if (!accepted.includes(key) && !(key === "repositoryId" && spec.dispatch === true)) return refuse("invalid_command", `${key} is not an argument of ${intent.op}`);
    const args: Record<string, unknown> = { ...intent.args };
    const labels: Record<string, string> = {};
    const pins: ChatPin[] = [];
    const steps: ChatStep[] = [];

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
    const reasonBase = proposalReason(intent.op, args, intent.draft === true, { profile, quoted, said: ownerSaysMove(intent.op, args, words, ["taskId", "prerequisiteId", "projectId", "agentId"].flatMap((k) => (typeof args[k] === "string" && labels[args[k] as string] !== undefined ? [labels[args[k] as string] as string] : [])).concat(intent.op === "resource.bind" && typeof args["label"] === "string" ? [args["label"]] : [])) });
    const reason = reasonBase ?? (fromRecord ? "the location comes from an earlier binding, not from your words, so it is shown first" : undefined);
    return { ok: true, steps, pins, labels, ...(projectId === undefined ? {} : { projectId }), ...(reason === undefined ? {} : { reason }), args, op: intent.op };
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
      case "contract": {
        const item = typeof args["taskId"] === "string" ? await this.#get(token, "contract.get", { taskId: args["taskId"] }) : undefined;
        return item === undefined ? refuse("not_found", "no such task") : { ok: true, name: "expectedVersion", value: (item["version"] as number) + ahead(`contract:${args["taskId"] as string}`) };
      }
    }
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
    for (const item of turn.plan) outcomes.push(await this.#do(owner, token, turnId, item));
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

  async #do(owner: Principal, token: string, turnId: string, item: PlanItem): Promise<Outcome> {
    switch (item.kind) {
      case "asked": return { i: item.i, status: "asked", question: item.question, options: item.options };
      case "held": return { i: item.i, status: "held", message: `Not done yet: ${item.preview}. It waits for the answer to the question.` };
      case "ignored": return { i: item.i, status: "ignored", message: item.reason };
      case "refused": return { i: item.i, status: "refused", code: item.code, message: item.message };
      case "focus": {
        try { await this.setFocus(token, { commandId: `${turnId}-f${item.i}`, projectId: item.projectId }); } catch (error) { return refusal(item.i, error); }
        return { i: item.i, status: "focused", projectId: item.projectId };
      }
      case "apply": {
        const response = await this.#deps.api.handle(token, { v: API_VERSION, op: item.op, commandId: item.commandId, args: item.args });
        if (!response.ok) return { i: item.i, status: "refused", op: item.op, commandId: item.commandId, code: response.error.code, message: response.error.message };
        return { i: item.i, status: "applied", op: item.op, commandId: item.commandId, id: response.result["id"] as string, ...(typeof response.result["revision"] === "number" ? { revision: response.result["revision"] } : {}), accepted: true, completed: response.completed ?? true, ...(response.awaits === undefined ? {} : { awaits: response.awaits }) };
      }
      case "propose": {
        try {
          const saved = await this.propose(owner, { commandId: `${turnId}-p${item.i}`, source: "chat", turnId, reason: item.reason, preview: item.preview, steps: item.steps.map(({ commandId: _c, ...s }) => s), pins: item.pins });
          return { i: item.i, status: "proposed", proposalId: saved.id, preview: item.preview, message: item.reason };
        } catch (error) { return refusal(item.i, error); }
      }
      case "apply_proposal": {
        try {
          const result = await this.#apply(owner, token, item.proposalId, `${turnId}-a${item.i}`, turnId);
          return result.applied ? { i: item.i, status: "applied", proposalId: item.proposalId, results: result.results, accepted: true, completed: result.results.every((r) => r.completed) } : { i: item.i, status: "refused", proposalId: item.proposalId, code: result.failure?.code ?? "invalid_command", message: result.failure?.message ?? "not applied", results: result.results };
        } catch (error) { return refusal(item.i, error); }
      }
      case "discard_proposal": {
        try { await this.#discard(owner, item.proposalId, `${turnId}-d${item.i}`, turnId); } catch (error) { return refusal(item.i, error); }
        return { i: item.i, status: "discarded", proposalId: item.proposalId };
      }
    }
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
      const response = await this.#deps.api.handle(using, { v: API_VERSION, op: step.op, commandId: step.commandId, args: args as Record<string, unknown> });
      if (!response.ok) return { proposalId, applied: false, replayed: false, results, failure: { step: index, code: response.error.code, message: response.error.message } };
      results.push({ op: step.op, id: response.result["id"] as string, ...(typeof response.result["revision"] === "number" ? { revision: response.result["revision"] } : {}), ...(step.key === undefined ? {} : { key: step.key }), accepted: true, completed: response.completed ?? true, ...(response.awaits === undefined ? {} : { awaits: response.awaits }) });
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
        return { ref, creates: true, changes: [{ type: "create", ref, body: asJson(body) }], detail: { messageId: body.messageId, commands: body.plan.flatMap((p) => (p.kind === "apply" ? [p.commandId] : p.kind === "propose" ? [p.proposalId] : [])) } };
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
    default: return undefined;
  }
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
    switch (o.status) {
      case "asked": lines.push(`${o.question ?? ""}${o.options !== undefined && o.options.length > 0 ? ` (${o.options.join("; ")})` : ""}`); break;
      case "held": lines.push(o.message ?? "Held."); break;
      case "ignored": lines.push(`No change: ${o.message ?? ""}`); break;
      case "refused": lines.push(`Not done (${o.code ?? "refused"}): ${o.message ?? ""}`); break;
      case "focused": lines.push(`Now focused on project ${o.projectId ?? ""}.`); break;
      case "discarded": lines.push(`Proposal ${o.proposalId ?? ""} discarded.`); break;
      case "proposed": lines.push(`Proposed, nothing has happened yet (${o.message ?? ""}). Proposal ${o.proposalId ?? ""}: ${(o.preview ?? []).join("; ")}. Say to apply it, or to discard it.`); break;
      case "applied": lines.push(o.proposalId !== undefined ? `Applied proposal ${o.proposalId}.` : `Done: ${o.op ?? ""}${o.completed === false ? `, accepted but not complete yet (${o.awaits ?? "waiting"})` : ""}.`); break;
    }
  }
  return lines;
}


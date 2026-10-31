import { OPERATION_BY_NAME } from "../api/operations.js";
import { CHAT_LIMITS } from "./interpreter.js";

/**
 * What the owner may do by chat, and how each command is treated (card U03). Every chat command is one operation of the state API (card U01); nothing here is a second way to change a record.
 * `mode` says whether a clear, authorized command applies at once (a reversible edit) or is first saved as a proposal that shows the owner what will happen and applies only on an explicit
 * request (anything that creates a project, hands work to someone, or cannot be taken back). `revision` names the read that supplies the revision the owner does not have to quote.
 */
export interface ChatOp {
  readonly verb: string;
  /** `apply`: at once. `propose`: always a proposal. `profile`: an explicit owner order applies directly in the derived and autonomous profiles and is a proposal in the strict one (or when read failed). */
  readonly mode: "apply" | "propose" | "profile";
  readonly revision?: "task" | "project" | "agent" | "assignment" | "contract" | "agenda" | "grant" | "decision" | "notifications" | "difficulty-profiles";
  /** The project the command is about is needed, and comes from the conversation's focus when the owner does not name it. */
  readonly needsProject?: boolean;
  /** The command hands a task to someone: it carries an explicit project and repository (checkout) and is always a proposal. */
  readonly dispatch?: boolean;
}

/** Operations whose project argument is named `project`, not `projectId`. */
export const PROJECT_AS_PROJECT: ReadonlySet<string> = new Set(["project.branches.set", "project.branches.change"]);

export const CHAT_OPS: Readonly<Record<string, ChatOp>> = {
  "project.create": { verb: "Create project", mode: "propose" },
  "project.update": { verb: "Change project", mode: "apply", revision: "project", needsProject: true },
  "task.create": { verb: "Create task", mode: "apply", needsProject: true },
  "task.update": { verb: "Change task", mode: "apply", revision: "task" },
  "task.transition": { verb: "Move task", mode: "apply", revision: "task" },
  "task.assign": { verb: "Assign task", mode: "profile", revision: "assignment", dispatch: true },
  "task.transfer": { verb: "Transfer task", mode: "profile", revision: "assignment", dispatch: true },
  "task.release": { verb: "Release task", mode: "profile", revision: "assignment" },
  "contract.set": { verb: "Change contract of task", mode: "apply", revision: "contract" },
  "dependency.add": { verb: "Add dependency", mode: "apply" },
  "dependency.remove": { verb: "Remove dependency", mode: "profile" },
  "agent.create": { verb: "Create agent", mode: "apply" },
  "agent.update": { verb: "Change agent", mode: "apply", revision: "agent" },
  "agent.retire": { verb: "Retire agent", mode: "profile", revision: "agent" },
  "team.create": { verb: "Create team", mode: "apply" },
  "role.define": { verb: "Define role", mode: "propose" },
  // Rights (card U03e): giving or taking back a right is always shown first and applies only when the owner says so; every text of it must be in the owner's own words.
  "grant.create": { verb: "Grant right", mode: "propose" },
  "grant.revoke": { verb: "Revoke grant", mode: "propose", revision: "grant" },
  // Where local-only data may go is where work is done: shown to the owner first in every profile (card H07c).
  // Which event sources are watched decides what wakes agents and spends work (card H13f): shown first in every profile (provisional; see the notes).
  // Withdrawing a tool version (owner decision 2026-10-30): always shown first; when calls of it are running, the owner is asked whether they finish or are cancelled.
  "catalog.revoke": { verb: "Revoke tool version", mode: "propose" },
  "events.sources.change": { verb: "Change which event sources are watched", mode: "propose" },
  // What a local agent may use is a resource decision (card H12k): shown first in every profile (provisional).
  // How long a stuck agent's concern waits at each supervisor before it climbs is an escalation policy (owner decision 2026-10-30, supervisor ladder): shown first in every profile (provisional).
  // Which recovery actions may be taken on a stuck agent (pausing, stopping, giving its task away) is authority over work: shown first in every profile (provisional, card V02c). Turning the steps off only narrows; on widens.
  "recovery.ladder.set": { verb: "Change which recovery actions may be taken on a stuck agent at each level", mode: "propose" },
  "recovery.ladder.enable": { verb: "Let supervisors take recovery steps on a stuck agent", mode: "propose" },
  "recovery.ladder.disable": { verb: "Stop supervisors taking recovery steps on a stuck agent", mode: "apply" },
  "escalation.ladder.set": { verb: "Change how long a stuck agent waits at each level of supervisors", mode: "propose" },
  // A ceiling on agreed raises and grants widens or narrows what a decision may carry out: shown first in every profile (owner decision 2026-10-30).
  "agreed.limits.change": { verb: "Change the limits on agreed raises and grants", mode: "propose" },
  // How long a stalled resume is retried before the owner is told is a work-and-spend decision: shown first in every profile.
  // The coverage-lapse alert is off by default and only tells the owner; turning it on or off, or changing its period, is reversible and applies at once (provisional, see the notes).
  "coverage.settings.set": { verb: "Change the coverage-lapse alert", mode: "apply" },
  "resume.settings.set": { verb: "Change how many blocked rounds a resume retries", mode: "propose" },
  // What happens when a host stops reporting is where work runs and when it moves: shown first in every profile (owner decision 2026-10-30). The owner's own order to move the work off a host applies at once, but only when their own words say the move and name the host.
  "host.quiet.change": { verb: "Change what happens when a host stops reporting", mode: "propose" },
  "host.move-work": { verb: "Move the work off a host", mode: "apply" },
  "workers.limits.change": { verb: "Change the limits for local agents", mode: "propose" },
  "workers.limits.besteffort": { verb: "Allow or forbid local agents to start when a limit cannot be fully enforced on this system (enable or disable best effort)", mode: "propose" },
  // How long an attempt may run and how many attempts are admitted are resource decisions: shown first in every profile (provisional). Both limits are off unless the owner turns them on.
  "dispatch.limits.change": { verb: "Change the dispatcher's time and attempt limits", mode: "propose" },
  // Whether the controller may remove an ended attempt's scratch workspace is a data-keeping decision: shown first in every profile (owner decision 2026-10-30; default after-handoff).
  "cleanup.settings.change": { verb: "Change whether an ended attempt's scratch workspace is removed", mode: "propose" },
  // Whether a reconnected worker takes its attempt up again by itself, and the owner's decision on one that waits, are authority over running work: shown first in every profile (card H09b, provisional).
  "reconnect.settings.set": { verb: "Change whether reconnected workers take their attempts up again by themselves", mode: "propose" },
  "reconnect.reaccept": { verb: "Decide on a reconnected worker's attempt", mode: "propose" },
  // Proving a backup unlock method still works reads a secret file on the host and changes nothing but the record of the proof; it carries no secret in the chat (card K01b).
  "backup.encryption.verify": { verb: "Check that a backup unlock method still works", mode: "apply" },
  // Approving a new backup key decides who can read every later backup: always a proposal, shown first in every profile.
  "backup.encryption.rekey": { verb: "Approve a new backup key", mode: "propose" },
  "placement.change": { verb: "Change where local-only data may go", mode: "propose" },
  // How finished work lands (card P08b): where work reaches the codebase is authority, so it is shown first in every profile. The record and the rules are the same as through the API.
  "integration.set": { verb: "Change how finished work lands", mode: "propose" },
  "integration.default.set": { verb: "Change how new projects land finished work", mode: "propose" },
  // Project resources, plan and responsibilities (card P01). A read-only bind of a location the owner typed in their own words follows the profile like other explicit orders; write access, an acknowledged overlap and anything quoted are shown first.
  "resource.bind": { verb: "Bind resource", mode: "profile", needsProject: true },
  "project.plan": { verb: "Plan project", mode: "apply", revision: "project", needsProject: true },
  "responsibility.create": { verb: "Create responsibility", mode: "propose", needsProject: true },
  // Topics for a later stand-up (card M03). Capturing and correcting are reversible edits of a saved topic and apply at once, shown back to the owner; a topic that records an instruction or a decision for the team is first shown (see `proposalReason`).
  "agenda.capture": { verb: "Add agenda item", mode: "apply", needsProject: true },
  "agenda.correct": { verb: "Correct agenda item", mode: "apply", revision: "agenda", needsProject: true },
  // A decision the owner states (card C08b): recorded from this very turn, with the owner's own words as the wording. The version it is based on is read from the records, not said.
  "decision.record": { verb: "Record decision", mode: "apply", revision: "decision", needsProject: true },
  // An answer to a question an agent put to the owner (card U12e): the answer is the owner's own words; the question is named by its words or, when only one waits, needs no name.
  "owner.answer": { verb: "Answer question", mode: "apply" },
  // Handing a task to another agent (card L03f). Preparing suspends the task at a checkpoint and moves nothing, and cancelling gives it back, so both apply at once; the move itself follows the profile like other explicit orders; a forced takeover (Force Stop) is always shown first.
  "handoff.prepare": { verb: "Prepare hand-off of task", mode: "apply", needsProject: true },
  "handoff.complete": { verb: "Complete hand-off of task", mode: "profile", needsProject: true },
  "handoff.cancel": { verb: "Cancel hand-off of task", mode: "apply", needsProject: true },
  "handoff.takeover": { verb: "Take task over by force", mode: "propose", needsProject: true },
  // Limits on what a task may use of model calls (card V02): they cap spending and retries, and raising one spends more, so the change is always shown first.
  "model-budget.set": { verb: "Limit model use of task", mode: "propose", needsProject: true },
  // Watching a task's events (card H13f): matching events wake the task's owner, which spends work, so an explicit order follows the profile.
  "watch.cancel": { verb: "Stop watching events for task", mode: "apply", needsProject: true },
  "watch.create": { verb: "Watch events for task", mode: "profile", needsProject: true },
  // The owner's exception for a paused, suspended or stopped agent to attend one meeting (card M04f): it widens who may be in the room, so an explicit order applies directly only where the profile lets rights widen, and is shown first in the strict one.
  "meeting.invite-direct": { verb: "Let an agent attend a meeting", mode: "profile", needsProject: true },
  // How notifications reach the owner (card U11b): digest times, quiet hours, the hours before an unanswered item is escalated, and the channel. It only changes how the owner is told, can be set back by saying so, and applies from the next notification, so an explicit order applies at once. The settings revision is read, not quoted.
  "notifications.configure": { verb: "Change how notifications reach you", mode: "apply", revision: "notifications" },
  // Money (card chat-gaps). Spending more, opening or ending a budget, and a cap on all spending are decisions about money: shown first in every profile. The aggregate cap is optional and off until set; turning it off is also shown first (it lifts a limit).
  "budget.decide": { verb: "Decide a request for more budget", mode: "propose" },
  "budget.open": { verb: "Open a budget for task", mode: "propose", needsProject: true },
  "budget.raise": { verb: "Add to the budget of task", mode: "propose", needsProject: true },
  "budget.close": { verb: "Close the budget of task", mode: "propose", needsProject: true },
  "budget.aggregate.set": { verb: "Set the overall spending cap", mode: "propose" },
  // Which branches are protected is authority (a push or merge that touches one stays the owner's decision): shown first, both the replacing form and the merging form the chat prefers.
  "project.branches.set": { verb: "Set the protected branches of project", mode: "propose", needsProject: true },
  "project.branches.change": { verb: "Change the protected branches of project", mode: "propose", needsProject: true },
  // How long a subscription may sit idle before it expires: a reversible setting with no authority in it.
  "events.configure-idle": { verb: "Change how long an event subscription may sit idle", mode: "apply" },
  // Which models work may reach: switching one off is the safe direction and follows the profile; bringing one back, and how failed ones return by themselves, widen what is used and are shown first.
  "routing.disable": { verb: "Stop new work reaching a model route", mode: "profile" },
  "routing.reenable": { verb: "Let a model route be used again", mode: "propose" },
  "routing.failback.set": { verb: "Change how failed model routes come back", mode: "propose" },
  // How tasks are matched to model profiles decides what they cost and where they run: the profiles are shown first; a task's own difficulty follows the profile.
  "difficulty.set-profiles": { verb: "Replace the difficulty profiles", mode: "propose", revision: "difficulty-profiles" },
  // Release testing (card X09b). Starting a destructive test on a host is shown first (provisional); cancelling is the safe direction and applies at once (an ended attempt is never a pass). Who besides the owner may start or cancel is a widening
  // when turned on (shown first) and a narrowing when turned off (applies at once).
  "release.start": { verb: "Start release test", mode: "propose" },
  "release.cancel": { verb: "Cancel release test", mode: "apply" },
  "release.settings.set": { verb: "Change who may start release tests", mode: "propose" },
  "release.issuers.enable": { verb: "Let QA agents or their supervisors start release tests", mode: "propose" },
  "release.issuers.disable": { verb: "Stop QA agents or their supervisors starting release tests", mode: "apply" },
  "difficulty.set": { verb: "Set difficulty of task", mode: "profile", revision: "contract", needsProject: true },
};

/** Names the owner may use in place of an ID; each is resolved from records and an unclear match asks. */
export const TITLE_KEYS: Readonly<Record<string, string>> = { taskTitle: "taskId", prerequisiteTitle: "prerequisiteId" };

/** The argument names the operation takes (from the API's own table, so they cannot drift), plus the chat-only names and the revision the chat fills in. */
/** The owner's own words say that finished work goes to main with no human step (card P08b). Quoted or forwarded text is never part of `words`. */
const MAIN_AUTOMATIC = /\bmain[\s-]*automatic(?:ally)?\b|\bautomatic(?:ally)?\s+(?:to|into|onto|on)\s+(?:the\s+)?main\b|\b(?:straight|directly)\s+(?:to|into|onto)\s+(?:the\s+)?main\b/i;
/** A negation in the same sentence as the phrase (not, never, don't, without, no, stop): then it is not an order to turn it on. */
const NEGATED = /\b(?:not|never|no|without|don'?t|do\s+not|won'?t|shouldn'?t|stop|disable|turn\s+off)\b/i;
export function saysMainAutomatic(words: string): boolean {
  return words.split(/(?<=[.!?\n])\s+/).some((sentence) => MAIN_AUTOMATIC.test(sentence) && !NEGATED.test(sentence));
}

export function acceptedArgs(op: string): readonly string[] | undefined {
  const operation = OPERATION_BY_NAME.get(op);
  if (operation === undefined || operation.kind !== "command") return undefined;
  // `agendaTopic` names an agenda item by its words; the chat resolves it to the item (exactly one open item of the project, else it asks).
  return [...Object.keys(operation.args).map((k) => k.replace(/\?$/, "")).filter((k) => k !== "commandId"), ...Object.keys(TITLE_KEYS), "projectName", ...(op === "agenda.correct" ? ["agendaTopic"] : []), ...(op === "release.cancel" ? ["candidateId"] : []), ...(op === "owner.answer" ? ["questionTopic"] : []), ...(op === "meeting.invite-direct" ? ["meetingTopic", "agentName"] : []), ...(op === "watch.create" ? ["watchedTaskTitle", "watchedTaskId"] : []), ...(op === "watch.cancel" ? ["taskId", "watchId"] : []), ...(op === "handoff.prepare" || op === "handoff.takeover" ? ["toAgentName"] : []), ...(op === "handoff.complete" || op === "handoff.cancel" ? ["taskId"] : [])];
}

/**
 * Fields that change what someone is allowed to do or where work is done. A command that sets one is a proposal in every profile, whatever the evidence: the owner sees it before it exists.
 * (Giving a task a different repository belongs here; a running task also refuses it outright.)
 */
export const AUTHORITY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "contract.set": ["permissions", "budget", "workClass"],
  "agent.create": ["roles", "supervisorId", "permittedOverrides", "defaultProfile"],
  "agent.update": ["roles", "supervisorId", "permittedOverrides", "defaultProfile"],
  "project.update": ["addRepositories"],
  "task.update": ["repositoryId"],
  "project.plan": ["participants"],
  "resource.bind": ["acknowledgeOverlap"],
  // A time to return the task, and handing over an incomplete package, change what the move does: shown first.
  "handoff.prepare": ["returnAt"],
  "handoff.takeover": ["returnAt"],
  "handoff.complete": ["acceptGaps"],
};

/**
 * The words that must appear in the owner's own text, in the same sentence as the target's name, before an irreversible or final move may apply directly. The list is small and fixed on purpose;
 * a word that is not here is a proposal, never a guess.
 */
export const MOVE_VERBS: Readonly<Record<string, RegExp>> = {
  "task.transition:done": /\b(done|finish|complete|close)/i,
  "task.transition:cancelled": /\b(cancel|drop|abandon)/i,
  "project.update:archived": /\b(archive)/i,
  "agent.retire": /\b(retire|fire|let go|remove)/i,
  "dependency.remove": /\b(remove|delete|drop|unlink)/i,
  "handoff.complete": /\b(complete|finish|transfer|move|give|pass on|hand (?:it|over)|go ahead)/i,
  "handoff.cancel": /\b(cancel|stop|abort|drop|call off)/i,
  "task.release": /\b(release|give up|let go)/i,
  "resource.bind": /\b(bind|add|attach|connect|link)/i,
  "task.transfer": /\b(transfer|hand over|reassign|move)/i,
  "task.assign": /\b(assign|give|allocate)/i,
  "host.move-work": /\b(move|relocate|re-?place|reassign|transfer|shift|take)/i,
};

/** The key into `MOVE_VERBS` for a command, or undefined when the command needs no verb. */
export function moveKey(op: string, args: Readonly<Record<string, unknown>>): string | undefined {
  const key = op === "task.transition" ? `${op}:${String(args["to"])}` : op === "project.update" ? `${op}:${String(args["state"])}` : op;
  return key in MOVE_VERBS ? key : undefined;
}

/** Whether a sentence of the owner's own text has the verb for this move and names the target. Sentences end at . ! ? ; or a line break, and a question never counts. Each move has its own list, and no list satisfies another move. */
export function ownerSaysMove(op: string, args: Readonly<Record<string, unknown>>, ownText: string, targets: readonly string[]): boolean {
  const key = moveKey(op, args);
  if (key === undefined) return true;
  const verb = MOVE_VERBS[key] as RegExp;
  const names = targets.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = names.map((n) => new RegExp(`(^|[^a-z0-9])${esc(n)}($|[^a-z0-9])`, "i"));
  // A question is not an order: sentences ending in "?" never count.
  const sentences = (ownText.match(/[^.!?;\n]+[.!?;]*/g) ?? []).filter((s) => !s.trimEnd().endsWith("?"));
  return sentences.some((s) => verb.test(s) && named.some((r) => r.test(s)));
}

/** Commands that are plain edits of text or fields: with quoted material in the message they may still apply; every other command becomes a proposal. */
const PLAIN_EDITS = new Set(["task.update", "task.create", "project.update", "agent.update", "contract.set"]);

export interface ProposalContext {
  /** The installation's approval profile (`strict` when it could not be read). */
  readonly profile: string;
  /** The owner's own words say this move (see `ownerSaysMove`). */
  readonly said: boolean;
  /** The message carried quoted or untrusted material. */
  readonly quoted: boolean;
  /** Setting a difficulty would move the task to a profile that may spend more than its present one (or the profile could not be compared). */
  readonly raisesSpend?: boolean;
}

/** Why a command that would apply is a proposal anyway, or undefined when it applies at once. */
export function proposalReason(op: string, args: Readonly<Record<string, unknown>>, draft: boolean, context: ProposalContext): string | undefined {
  const spec = CHAT_OPS[op];
  if (spec === undefined) return undefined;
  if (draft) return "you asked for a draft";
  if (op === "resource.bind" && args["access"] === "write") return "it gives write access";
  if ((AUTHORITY_FIELDS[op] ?? []).some((f) => args[f] !== undefined)) return "it changes what someone may do or where work is done";
  // A gate holds work (or lifts a hold) for the whole project until the owner decides otherwise: it is shown first whatever the profile, so the gate and its kind are seen before they bind.
  if (op === "decision.record" && args["category"] === "gate") return "a gate holds or releases work until you say otherwise, so it is shown first";
  // The request type is authority: an instruction or a decision left to the team is shown to the owner before it is recorded, whatever the profile, so a paraphrase cannot slip one in.
  if ((op === "agenda.capture" || op === "agenda.correct") && (args["intent"] === "owner-instruction" || args["intent"] === "delegated-decision")) return "it records an instruction or a decision for the team, so it is shown first";
  // Forbidding best effort is the narrowing direction (a stricter launch rule): it applies at once when the owner's words say it. Allowing it is shown first.
  if (spec.mode === "propose" && !(op === "workers.limits.besteffort" && args["enabled"] === false)) return op === "project.create" ? "a new project is drafted first" : op.startsWith("grant.") ? "a right is shown first" : op.startsWith("placement.") ? "where your local-only data may go is shown first" : op.startsWith("catalog.") ? "withdrawing a tool version is shown first, with the calls it would reach" : op.startsWith("events.") ? "which event sources wake your agents is shown first" : op.startsWith("budget.") ? "money and spending limits are shown first" : op.startsWith("routing.") ? "which models work may reach is shown first" : op.startsWith("difficulty.") ? "how tasks are matched to models is shown first" : op.startsWith("host.quiet") ? "what happens to the work of a host that stops reporting is shown first" : op.startsWith("project.branches.") ? "which branches are protected is shown first" : "a role's capabilities are shown first";
  // Moving a task up to a profile that may spend more is a spending decision: shown first in every profile, as a budget raise is.
  if (op === "difficulty.set" && context.raisesSpend === true) return "it moves the task to a profile that may spend more, so it is shown first";
  if (context.quoted && (!PLAIN_EDITS.has(op) || (op === "project.update" && args["state"] !== undefined))) return "your message carried quoted text, so this is shown first";
  if (!context.said) return "your own words do not say this move, so it is shown first";
  const strict = context.profile === "strict";
  if (spec.mode === "profile") return strict ? "the strict profile shows this first" : undefined;
  // A recorded decision can interrupt running generation and block dependent work, so the strict profile shows it first.
  if (strict && op === "decision.record") return "the strict profile shows a recorded decision first";
  if (strict && op === "task.transition" && (args["to"] === "done" || args["to"] === "cancelled")) return "the strict profile shows a final state first";
  if (strict && op === "project.update" && args["state"] === "archived") return "the strict profile shows archiving first";
  return undefined;
}

/** Keys whose values name records or fixed choices; every other text in a command must be in the owner's own words. */
const EXEMPT = new Set(["taskId", "projectId", "project", "prerequisiteId", "agentId", "supervisorId", "teamId", "parentTeamId", "repositoryId", "resourceId", "responsibilityId", "ownerId", "managed", "access", "landing", "integrator", "requiredChecks", "integration", "refreshRounds", "expectedRevision", "expectedVersion", "requestId", "currency", "level", "to", "state", "workClass", "difficulty", "recovery", "kind", "priority", "itemId", "inquiryId", "occurrenceId", "watchedTaskId", "watchId", "returnAt", "sourceTurnId", "intent", "urgency", "category", "participants", "fingerprint", "attemptId", "sessionId", "waitingSince", "decision", "reaccept", "patienceHours", "who", "os", "arch", "osVersion"]);

/** Release-test IDs are not record references the owner picked: for the release commands they must be in the owner's own words (cancel applies at once, so a model must not choose which test). */
export const RELEASE_ID_KEYS: ReadonlySet<string> = new Set(["attemptId", "candidateId"]);

/** The first text value of a command's arguments that is not the owner's own words (and not a record reference or fixed choice), or undefined. */
export function foreignValue(args: Readonly<Record<string, unknown>>, ownText: string, path = "", strict: ReadonlySet<string> = new Set()): string | undefined {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  const own = norm(ownText);
  const walk = (value: unknown, where: string, key: string): string | undefined => {
    if (typeof value === "string") return (EXEMPT.has(key) && !strict.has(key)) || value.length === 0 || own.includes(norm(value)) ? undefined : where;
    if (Array.isArray(value)) { for (const [i, v] of value.entries()) { const bad = walk(v, `${where}[${i}]`, key); if (bad !== undefined) return bad; } return undefined; }
    if (value !== null && typeof value === "object") { for (const [k, v] of Object.entries(value)) { const bad = walk(v, `${where}.${k}`, k); if (bad !== undefined) return bad; } }
    return undefined;
  };
  for (const [k, v] of Object.entries(args)) { const bad = walk(v, path === "" ? k : `${path}.${k}`, k); if (bad !== undefined) return bad; }
  return undefined;
}

/** True if a `$ref` marker (reserved for steps the service builds) appears anywhere in the value. */
export function hasRefMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRefMarker);
  if (value !== null && typeof value === "object") return "$ref" in value || Object.values(value).some(hasRefMarker);
  return false;
}

const short = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

/** One plain line saying what a command will do, for the owner to read before it happens. Built from the typed command, never from model text. */
export function describe(op: string, args: Readonly<Record<string, unknown>>, labels: Readonly<Record<string, string>>): string {
  const spec = CHAT_OPS[op];
  const parts: string[] = [];
  // What a decision is (a gate and its kind above all) is said first, so a long text or label after it can never push it off the line.
  const first = op === "decision.record" ? ["category", "gate"] : [];
  const ordered = [...first.filter((k) => k in args).map((k): [string, unknown] => [k, args[k]]), ...Object.entries(args).filter(([k]) => !first.includes(k))];
  for (const [key, value] of ordered) {
    if (key === "expectedRevision" || key === "expectedVersion") continue;
    const label = typeof value === "string" ? labels[value] : undefined;
    parts.push(`${key}=${label === undefined ? short(value) : `"${label}"`}`);
  }
  // What the exception means is said before the details, so a long topic can never push it off the line.
  // A right's end (or that it has none) is said before the long basis and terms, so truncating the line can never drop it.
  const meaning = op === "meeting.invite-direct" ? " (this meeting only, then the agent is back as it was; no long-running work in it)" : op === "grant.create" ? (typeof args["expiresAt"] === "string" ? ` (ends ${args["expiresAt"]})` : " (permanent: no end time)") : "";
  const line = `${spec?.verb ?? op}${meaning}${parts.length === 0 ? "" : `: ${parts.join(", ")}`}`;
  return line.length > CHAT_LIMITS.line ? `${line.slice(0, CHAT_LIMITS.line - 3)}...` : line;
}

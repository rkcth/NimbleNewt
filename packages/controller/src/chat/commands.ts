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
  readonly revision?: "task" | "project" | "agent" | "assignment" | "contract" | "agenda" | "grant";
  /** The project the command is about is needed, and comes from the conversation's focus when the owner does not name it. */
  readonly needsProject?: boolean;
  /** The command hands a task to someone: it carries an explicit project and repository (checkout) and is always a proposal. */
  readonly dispatch?: boolean;
}

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
  // Project resources, plan and responsibilities (card P01). A read-only bind of a location the owner typed in their own words follows the profile like other explicit orders; write access, an acknowledged overlap and anything quoted are shown first.
  "resource.bind": { verb: "Bind resource", mode: "profile", needsProject: true },
  "project.plan": { verb: "Plan project", mode: "apply", revision: "project", needsProject: true },
  "responsibility.create": { verb: "Create responsibility", mode: "propose", needsProject: true },
  // Topics for a later stand-up (card M03). Capturing and correcting are reversible edits of a saved topic and apply at once, shown back to the owner; a topic that records an instruction or a decision for the team is first shown (see `proposalReason`).
  "agenda.capture": { verb: "Add agenda item", mode: "apply", needsProject: true },
  "agenda.correct": { verb: "Correct agenda item", mode: "apply", revision: "agenda", needsProject: true },
};

/** Names the owner may use in place of an ID; each is resolved from records and an unclear match asks. */
export const TITLE_KEYS: Readonly<Record<string, string>> = { taskTitle: "taskId", prerequisiteTitle: "prerequisiteId" };

/** The argument names the operation takes (from the API's own table, so they cannot drift), plus the chat-only names and the revision the chat fills in. */
export function acceptedArgs(op: string): readonly string[] | undefined {
  const operation = OPERATION_BY_NAME.get(op);
  if (operation === undefined || operation.kind !== "command") return undefined;
  // `agendaTopic` names an agenda item by its words; the chat resolves it to the item (exactly one open item of the project, else it asks).
  return [...Object.keys(operation.args).map((k) => k.replace(/\?$/, "")), ...Object.keys(TITLE_KEYS), "projectName", ...(op === "agenda.correct" ? ["agendaTopic"] : [])];
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
  "task.release": /\b(release|give up|let go)/i,
  "resource.bind": /\b(bind|add|attach|connect|link)/i,
  "task.transfer": /\b(transfer|hand over|reassign|move)/i,
  "task.assign": /\b(assign|give|allocate)/i,
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
}

/** Why a command that would apply is a proposal anyway, or undefined when it applies at once. */
export function proposalReason(op: string, args: Readonly<Record<string, unknown>>, draft: boolean, context: ProposalContext): string | undefined {
  const spec = CHAT_OPS[op];
  if (spec === undefined) return undefined;
  if (draft) return "you asked for a draft";
  if (op === "resource.bind" && args["access"] === "write") return "it gives write access";
  if ((AUTHORITY_FIELDS[op] ?? []).some((f) => args[f] !== undefined)) return "it changes what someone may do or where work is done";
  // The request type is authority: an instruction or a decision left to the team is shown to the owner before it is recorded, whatever the profile, so a paraphrase cannot slip one in.
  if ((op === "agenda.capture" || op === "agenda.correct") && (args["intent"] === "owner-instruction" || args["intent"] === "delegated-decision")) return "it records an instruction or a decision for the team, so it is shown first";
  if (spec.mode === "propose") return op === "project.create" ? "a new project is drafted first" : op.startsWith("grant.") ? "a right is shown first" : "a role's capabilities are shown first";
  if (context.quoted && (!PLAIN_EDITS.has(op) || (op === "project.update" && args["state"] !== undefined))) return "your message carried quoted text, so this is shown first";
  if (!context.said) return "your own words do not say this move, so it is shown first";
  const strict = context.profile === "strict";
  if (spec.mode === "profile") return strict ? "the strict profile shows this first" : undefined;
  if (strict && op === "task.transition" && (args["to"] === "done" || args["to"] === "cancelled")) return "the strict profile shows a final state first";
  if (strict && op === "project.update" && args["state"] === "archived") return "the strict profile shows archiving first";
  return undefined;
}

/** Keys whose values name records or fixed choices; every other text in a command must be in the owner's own words. */
const EXEMPT = new Set(["taskId", "projectId", "project", "prerequisiteId", "agentId", "supervisorId", "teamId", "parentTeamId", "repositoryId", "resourceId", "responsibilityId", "ownerId", "managed", "access", "expectedRevision", "expectedVersion", "to", "state", "workClass", "difficulty", "recovery", "kind", "priority", "itemId", "sourceTurnId", "intent", "urgency", "category", "participants"]);

/** The first text value of a command's arguments that is not the owner's own words (and not a record reference or fixed choice), or undefined. */
export function foreignValue(args: Readonly<Record<string, unknown>>, ownText: string, path = ""): string | undefined {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  const own = norm(ownText);
  const walk = (value: unknown, where: string, key: string): string | undefined => {
    if (typeof value === "string") return EXEMPT.has(key) || value.length === 0 || own.includes(norm(value)) ? undefined : where;
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
  for (const [key, value] of Object.entries(args)) {
    if (key === "expectedRevision" || key === "expectedVersion") continue;
    const label = typeof value === "string" ? labels[value] : undefined;
    parts.push(`${key}=${label === undefined ? short(value) : `"${label}"`}`);
  }
  const line = `${spec?.verb ?? op}${parts.length === 0 ? "" : `: ${parts.join(", ")}`}${op === "grant.create" ? " (permanent: no end time)" : ""}`;
  return line.length > CHAT_LIMITS.line ? `${line.slice(0, CHAT_LIMITS.line - 3)}...` : line;
}

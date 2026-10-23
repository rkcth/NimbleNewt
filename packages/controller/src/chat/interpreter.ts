import { DomainError } from "../domain/errors.js";
import { redactText } from "../security/redact.js";

/**
 * What the interpreter is shown (card U03). `text` is the owner's own words and the only source of authority; `quoted` is text the owner pasted or forwarded (an email, a log, another agent's
 * message), which is shown to the interpreter as material to read and can never ask for anything.
 */
export interface InterpreterInput {
  readonly text: string;
  readonly quoted: readonly string[];
  readonly focus: { readonly projectId?: string; readonly projectName?: string };
  /** The owner's open proposals, so that "yes, do that" can name one. */
  readonly proposals: readonly { readonly id: string; readonly summary: readonly string[] }[];
  /** A question the owner has not answered yet, whose held commands wait for it: an answer to it is an `answer` intent. */
  readonly awaiting?: { readonly turnId: string; readonly question: string; readonly choices: readonly string[] };
}

/**
 * What the interpreter may produce. It is data, never an action: the chat service validates it, resolves the details from records, decides whether it applies or is only proposed, and sends
 * it through the same state API as any other client. `evidence` is the owner's words the intent comes from; it must occur in `text`, so a model that was steered by quoted text cannot
 * credit the owner with it. `basis: "quoted"` is how an honest interpreter reports an instruction that only appeared in quoted material; it is refused.
 */
export type Intent =
  | { readonly kind: "command"; readonly op: string; readonly args: Readonly<Record<string, unknown>>; readonly evidence: string; readonly basis: "owner" | "quoted"; readonly draft?: boolean }
  | { readonly kind: "clarify"; readonly question: string; readonly options?: readonly string[] }
  | { readonly kind: "switch_focus"; readonly projectName?: string; readonly projectId?: string; readonly evidence: string; readonly basis: "owner" | "quoted" }
  | { readonly kind: "apply_proposal"; readonly proposalId: string; readonly evidence: string; readonly basis: "owner" | "quoted" }
  | { readonly kind: "discard_proposal"; readonly proposalId: string; readonly evidence: string; readonly basis: "owner" | "quoted" }
  /** A question about status (card U05): which view to read (`request.kind`, as `StatusService.ask` takes it). It reads records and changes nothing; the details are checked there, not trusted from the model. */
  | { readonly kind: "status"; readonly request: Readonly<Record<string, unknown>>; readonly evidence: string; readonly basis: "owner" | "quoted" }
  | { readonly kind: "answer"; readonly turnId: string; readonly choice: string; readonly evidence: string; readonly basis: "owner" | "quoted" }
  | { readonly kind: "none"; readonly reason: string };

/** The model call behind an interface. Whatever it returns is checked by `checkIntents`; tests use `ScriptedInterpreter`. */
export interface ChatInterpreter {
  interpret(input: InterpreterInput): Promise<unknown>;
}

export const CHAT_LIMITS = { text: 4000, quoted: 10, quotedText: 4000, intents: 8, evidence: 500, question: 500, options: 10, option: 200, messageId: 100, summaryLines: 40, line: 400, steps: 40, planTasks: 20, turnsPerProject: 20, projects: 50, openProposals: 50, routes: 5, statusLines: 30, key: 30 } as const;

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, field: string, max: number): string => (typeof v === "string" && v.length >= 1 && v.length <= max ? v : invalid(field, `must be text of 1 to ${max} characters`));
const known = (o: Record<string, unknown>, keys: readonly string[], field: string): void => { for (const k of Object.keys(o)) if (!keys.includes(k)) invalid(`${field}.${k}`, "is not a field of this intent"); };
const basisOf = (v: unknown, field: string): "owner" | "quoted" => (v === "owner" || v === "quoted" ? v : invalid(field, "must be owner or quoted"));

/** Strictly validates what an interpreter returned. A malformed answer is refused whole; nothing is guessed from it. */
export function checkIntents(raw: unknown): Intent[] {
  if (!Array.isArray(raw)) return invalid("intents", "must be a list");
  if (raw.length > CHAT_LIMITS.intents) return invalid("intents", `at most ${CHAT_LIMITS.intents} per message`);
  return raw.map((entry: unknown, i): Intent => {
    const f = `intents[${i}]`;
    if (!isObject(entry)) return invalid(f, "must be an object");
    switch (entry["kind"]) {
      case "command": {
        known(entry, ["kind", "op", "args", "evidence", "basis", "draft"], f);
        if (!isObject(entry["args"])) return invalid(`${f}.args`, "must be an object");
        if (entry["draft"] !== undefined && typeof entry["draft"] !== "boolean") return invalid(`${f}.draft`, "must be true or false");
        return { kind: "command", op: str(entry["op"], `${f}.op`, 60), args: entry["args"], evidence: str(entry["evidence"], `${f}.evidence`, CHAT_LIMITS.evidence), basis: basisOf(entry["basis"], `${f}.basis`), ...(entry["draft"] === true ? { draft: true } : {}) };
      }
      case "clarify": {
        known(entry, ["kind", "question", "options"], f);
        const options = entry["options"];
        if (options !== undefined && (!Array.isArray(options) || options.length > CHAT_LIMITS.options)) return invalid(`${f}.options`, `must be a list of at most ${CHAT_LIMITS.options} texts`);
        return { kind: "clarify", question: str(entry["question"], `${f}.question`, CHAT_LIMITS.question), ...(options === undefined ? {} : { options: (options as unknown[]).map((o, j) => str(o, `${f}.options[${j}]`, CHAT_LIMITS.option)) }) };
      }
      case "switch_focus": {
        known(entry, ["kind", "projectName", "projectId", "evidence", "basis"], f);
        if ((entry["projectName"] === undefined) === (entry["projectId"] === undefined)) return invalid(f, "needs exactly one of projectName and projectId");
        return { kind: "switch_focus", ...(entry["projectName"] === undefined ? { projectId: str(entry["projectId"], `${f}.projectId`, 60) } : { projectName: str(entry["projectName"], `${f}.projectName`, 200) }), evidence: str(entry["evidence"], `${f}.evidence`, CHAT_LIMITS.evidence), basis: basisOf(entry["basis"], `${f}.basis`) };
      }
      case "apply_proposal": case "discard_proposal": {
        known(entry, ["kind", "proposalId", "evidence", "basis"], f);
        return { kind: entry["kind"], proposalId: str(entry["proposalId"], `${f}.proposalId`, 80), evidence: str(entry["evidence"], `${f}.evidence`, CHAT_LIMITS.evidence), basis: basisOf(entry["basis"], `${f}.basis`) };
      }
      case "answer": {
        known(entry, ["kind", "turnId", "choice", "evidence", "basis"], f);
        return { kind: "answer", turnId: str(entry["turnId"], `${f}.turnId`, 80), choice: str(entry["choice"], `${f}.choice`, CHAT_LIMITS.option), evidence: str(entry["evidence"], `${f}.evidence`, CHAT_LIMITS.evidence), basis: basisOf(entry["basis"], `${f}.basis`) };
      }
      case "status": {
        known(entry, ["kind", "request", "evidence", "basis"], f);
        if (!isObject(entry["request"]) || typeof entry["request"]["kind"] !== "string") return invalid(`${f}.request`, "must be an object with a kind");
        // The request is bounded here (a few short keys, no nesting); what it may mean is checked by the status service.
        const req = entry["request"] as Record<string, unknown>;
        if (Object.keys(req).length > 8) return invalid(`${f}.request`, "has too many fields");
        for (const [k, v] of Object.entries(req)) {
          if (k.length > 30 || !/^[A-Za-z]+$/.test(k)) return invalid(`${f}.request.${k}`, "is not a request field name");
          if (!(typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 200))) return invalid(`${f}.request.${k}`, "must be a number, true or false, or text of at most 200 characters");
        }
        return { kind: "status", request: entry["request"], evidence: str(entry["evidence"], `${f}.evidence`, CHAT_LIMITS.evidence), basis: basisOf(entry["basis"], `${f}.basis`) };
      }
      case "none": {
        known(entry, ["kind", "reason"], f);
        return { kind: "none", reason: str(entry["reason"], `${f}.reason`, CHAT_LIMITS.question) };
      }
      default: return invalid(`${f}.kind`, "is not an intent kind");
    }
  });
}

/**
 * Splits a message into the owner's own words and quoted material: lines that start with `>` and fenced blocks (three backticks) are quoted. A client that knows better (a forwarded message) passes
 * `quoted` itself; this is the fallback for plain typed text, and it only ever moves text from authority to non-authority.
 */
export function splitQuoted(message: string): { text: string; quoted: string[] } {
  const own: string[] = [];
  const quoted: string[] = [];
  let fenced = false;
  let current: string[] = [];
  const flush = () => { if (current.length > 0) { quoted.push(current.join("\n")); current = []; } };
  for (const line of message.split("\n")) {
    if (line.trimStart().startsWith("```")) { flush(); fenced = !fenced; continue; }
    if (fenced || line.trimStart().startsWith(">")) { current.push(line.replace(/^\s*>\s?/, "")); continue; }
    flush();
    own.push(line);
  }
  flush();
  return { text: own.join("\n").trim(), quoted };
}

/** Whether `evidence` occurs in the owner's own words (ignoring case and runs of white space). */
export const evidenceInText = (evidence: string, text: string): boolean => {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(evidence).length > 0 && norm(text).includes(norm(evidence));
};

/** Evidence must be a phrase (at least two words and six characters), not a token that any message contains. */
export const evidenceStrong = (evidence: string): boolean => evidence.trim().length >= 6 && evidence.trim().split(/\s+/).length >= 2;

/** A credential-shaped text is never sent to a model or stored. */
export const refuseCredentials = (value: string, field: string): void => { if (redactText(value) !== value) invalid(field, "looks like a credential or key; it was not read or recorded"); };

/**
 * The scripted interpreter for tests: the output for an exact owner text, or a function of the whole input. Unscripted text yields no intents, which the service answers by asking. It records
 * every input so a test can check what the interpreter was shown (and that quoted text arrived marked as quoted).
 */
export class ScriptedInterpreter implements ChatInterpreter {
  readonly calls: InterpreterInput[] = [];
  readonly #script: Readonly<Record<string, unknown>> | ((input: InterpreterInput) => unknown);
  failWith: Error | undefined;

  constructor(script: Readonly<Record<string, unknown>> | ((input: InterpreterInput) => unknown)) {
    this.#script = script;
  }

  async interpret(input: InterpreterInput): Promise<unknown> {
    this.calls.push(input);
    if (this.failWith !== undefined) throw this.failWith;
    return typeof this.#script === "function" ? this.#script(input) : (this.#script[input.text] ?? []);
  }
}

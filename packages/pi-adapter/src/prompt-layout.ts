import { createHash } from "node:crypto";
import type { PromptSection } from "@earendil-works/pi-durable";
import { PLAN_FILE } from "@nimblenewt/contracts";
import { InvalidToolError, PiAdapterError } from "./errors.js";
import { WORK_ANSWER_TOOL, WORK_END_TOOL, WORK_NOTE_TOOL, bridgeToolName } from "./bridge.js";

/**
 * The prompt layout NimbleNewt gives every Pi agent (card C06b). Pi Durable 1.3.0 renders no system text of its own; it renders whatever sections the agent has, in order, and replays them with the tool declarations into one
 * leading system message before each request. Anything that changes in a section or in the tool set therefore rewrites the head of the request and loses every cached prefix after it. The layout below keeps the head still:
 *
 *   1. tool declarations, sorted by name (the order callers pass them in is not part of the prompt),
 *   2. the completion rules (card W06), when the layout asks for them: fixed text, the same bytes for every Pi agent of every installation, task and role,
 *   3. a preamble common to every agent of the installation,
 *   4. the project's context (shared by every agent of the project),
 *   5. the agent's own instructions,
 *   6. nothing volatile: what changes from turn to turn (the time, the current task state, retrieved notes) is sent as a user message after all of this (`volatileContext`).
 *
 * The text is fixed when the layout is given and changes only through `PiAdapter.changePromptLayout`, which is audited, because every change costs a re-read of everything after it.
 */
export interface PromptLayout {
  /**
   * The fixed completion rules (card W06, `COMPLETION_RULES`): how the agent finishes its work. They are the same bytes everywhere, so they go first, before the preamble. Every Pi agent the worker process runs has them. Default false
   * (an adapter opened by a test or a tool of its own has no rules it did not ask for).
   */
  readonly completionRules?: boolean;
  /** Common to every agent of the installation (house rules, tool etiquette, output conventions). May be empty only when the layout has the completion rules (the section is then left out). */
  readonly preamble: string;
  /** Shared by every agent of one project (project description, conventions). */
  readonly project?: string;
  /** This agent's own role and instructions. */
  readonly agent?: string;
}

/**
 * The completion rules (card W06): how every Pi agent finishes its work. Fixed text, one named constant per group of sentences, so a later card adds its sentence as a group of its own (W10: the report) without touching the others. Each
 * group agrees with what the agent is told elsewhere: the in-turn nudge (W04, `worker/nudge.ts`), the go-on note after an early stop (W03), the done check and its refusal (W05), the work.end tool's description and the job-start reply
 * (W11). Changing any of it changes the head of every agent's request (one re-read of the cached prefix per agent), so it changes only with the code.
 */
export const COMPLETION_INTRO = "How to finish your work (these rules hold for every task):";
/** Plan and steps. PLAN.md at the top of the checkout is what the host reads for the owner when the work stops early (W03). */
export const COMPLETION_PLAN_RULE = `Keep a ${PLAN_FILE} at the top of your checkout, written before you change anything: one Markdown checkbox line (- [ ] ...) per step, in order. Keep each step small: one change and its tests. Tick a step (- [x] ...) as soon as it is done and checked, and keep the file up to date as you go, so you and anyone after you can see what is left.`;
/** No commit; what the done check looks at (W05; the plan file is not counted as a change, W06 second review). The check runs only for a task whose contract names evidence or checks, and such a task's first prompt says so (the dispatcher's done note), so the rule is conditional. */
export const COMPLETION_CHECK_RULE = `You do not commit: what your checkout holds when you end is your work, and it is committed after review. When the task names required evidence or checks (you are told so at the start), a done is checked before it is taken: your checkout must hold a change against the task's base other than ${PLAN_FILE} (your plan is a working note, not the work); every evidence item the task requires must be named in the work.end evidence with the file of your checkout that holds it, a plain file that is not empty; and the checks the task names are run by the host in your sandbox and must pass. A done that does not pass is refused with the list of what failed: fix what it lists and end again.`;
/** How the work ends: work.end, the honest endings, never prose alone (W02 to W04). */
export const COMPLETION_END_RULE = `End your work with ${WORK_END_TOOL} as your last call. Use result done only when every step of ${PLAN_FILE} is done and checked. If you cannot go on, end with result blocked or partial and say why in the report; never report done for work that is not done. Never end with prose alone: a reply without a tool call does not end the work, and you are asked to go on.`;
/** Notes, the report and the second agent's questions (card W10): every ending carries a report (`work.end` refuses one without it); a done that passes W05 may be questioned by a second agent, answered with `work.answer`; an unsupported report counts toward the go-ons as a refused done does. */
export const COMPLETION_REPORT_RULE = `Keep running notes with ${WORK_NOTE_TOOL} as you work (kind did, found, left or could-not). Every ${WORK_END_TOOL}, done or not, carries a report built from those notes: what you did, found, left and could not do. A done may be questioned by a second agent: answer its questions with ${WORK_ANSWER_TOOL} and call ${WORK_END_TOOL} again. It cannot approve your work, and a report it finds unsupported is refused like a done that does not pass.`;
/**
 * The job rule of card W11, word for word. It is the controller's `JOB_WAKE_RULE` (`controller/src/jobs/wakes.ts`), which this package may not import (the adapter is independent of the controller); an integration test keeps the two
 * copies equal.
 */
export const JOB_WAKE_RULE_TEXT = "When this job ends (completed, failed, cancelled or outcome unknown), this task is woken once to read it, unless the task is stopped, paused (it is then woken when the pause is lifted), finished or reassigned first, or its wake-ups are used up (a few per hour). So either write where you are in your notes and end your turn, or check it yourself with job-status. The owner sees the job's end; do not promise anyone any other notification.";
/** Long jobs: the one turn that may end without work.end. */
export const COMPLETION_JOB_RULE = `A job you start with ${bridgeToolName("job.start")} is the one time you may end a turn without ${WORK_END_TOOL} (your work is not ended: the attempt waits for the job). ${JOB_WAKE_RULE_TEXT}`;
/** The groups in order. A later card appends its group here. */
export const COMPLETION_RULE_GROUPS: readonly string[] = Object.freeze([COMPLETION_INTRO, COMPLETION_PLAN_RULE, COMPLETION_CHECK_RULE, COMPLETION_END_RULE, COMPLETION_REPORT_RULE, COMPLETION_JOB_RULE]);
/** The section's text: the groups, one paragraph each. */
export const COMPLETION_RULES = COMPLETION_RULE_GROUPS.join("\n\n");
/** The section's key (Pi renders it as `<nn_completion>...</nn_completion>`). */
export const COMPLETION_SECTION_KEY = "nn_completion";

/** The layout the worker process gives every Pi agent it runs: the completion rules and nothing else (no installation preamble, project or role text exists yet). The same object for every task, role and context switch. */
export const PI_AGENT_LAYOUT: PromptLayout = Object.freeze({ completionRules: true, preamble: "" });

/** The text of a section is not stable: it carries something that is different on every run or every day. */
export class UnstablePromptError extends PiAdapterError {
  override readonly name = "UnstablePromptError";
  constructor(readonly section: string, readonly found: string) {
    super(`prompt section "${section}" contains ${found}; sections must be the same bytes on every turn (send volatile content with volatileContext instead)`);
  }
}

/** The patterns that make a section differ from one run to the next. Deliberately blunt: a false alarm costs a rewording, a miss costs every cached prefix. */
const D = "\\p{Nd}";
const NOT_WORD = "(?<![\\p{L}\\p{Nd}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{Nd}])";
const UNSTABLE: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  // Digits are never delimited by \b: a letter or underscore beside them ("seed_1792741784932", "2026-10-23T07:49Z") must not hide them.
  { what: "a date", pattern: new RegExp(`(?<!${D})${D}{4}-${D}{2}-${D}{2}(?!${D})`, "u") },
  { what: "a time of day", pattern: new RegExp(`(?<!${D})${D}{1,2}:${D}{2}(?!${D})`, "u") },
  { what: "a UUID", pattern: new RegExp(`${NOT_WORD}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${NOT_WORD_AFTER}`, "iu") },
  { what: "a timestamp", pattern: new RegExp(`(?<!${D})${D}{10,13}(?!${D})`, "u") },
  { what: "a generated identifier", pattern: new RegExp(`${NOT_WORD}[a-z]{2,6}-[a-z2-7]{20,}${NOT_WORD_AFTER}`, "u") },
  { what: "a long hexadecimal identifier", pattern: new RegExp(`${NOT_WORD}[0-9a-f]{24,}${NOT_WORD_AFTER}`, "iu") },
];

/** The text as a reader of digits sees it: compatibility forms (fullwidth digits) folded, invisible format characters (zero-width space, joiners) removed, every dash a hyphen. */
const canonical = (text: string): string => text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\p{Pd}/gu, "-");

const MAX_SECTION_CHARS = 200_000;

/** Throws `UnstablePromptError` when the text carries a date, time, UUID, timestamp or generated ID. */
export function assertStableText(section: string, text: string): void {
  if (text.length > MAX_SECTION_CHARS) throw new PiAdapterError(`prompt section "${section}" is longer than ${MAX_SECTION_CHARS} characters`);
  const seen = canonical(text);
  for (const { what, pattern } of UNSTABLE) if (pattern.test(seen)) throw new UnstablePromptError(section, what);
}

/** Checks a layout and returns a frozen copy (so a caller cannot change a section behind the adapter's back). */
export function checkLayout(layout: PromptLayout): PromptLayout {
  if (layout.completionRules !== undefined && typeof layout.completionRules !== "boolean") throw new PiAdapterError("completionRules is true or false");
  const rules = layout.completionRules === true;
  if (typeof layout.preamble !== "string" || (layout.preamble.trim().length === 0 && !(rules && layout.preamble.length === 0))) throw new PiAdapterError("the prompt layout needs a preamble (or the completion rules and an empty preamble)");
  assertStableText("preamble", layout.preamble);
  if (layout.project !== undefined) assertStableText("project", layout.project);
  if (layout.agent !== undefined) assertStableText("agent", layout.agent);
  return Object.freeze({ ...(rules ? { completionRules: true } : {}), preamble: layout.preamble, ...(layout.project === undefined || layout.project.length === 0 ? {} : { project: layout.project }), ...(layout.agent === undefined || layout.agent.length === 0 ? {} : { agent: layout.agent }) });
}

/**
 * Tools in the one order every agent offers them: the ones declared `shared` (offered to every agent of the project) first, then the rest, each group by name. Providers render the tools before the system text, so a tool only
 * one agent has, sitting in front, would stop every other agent from sharing the system prompt behind it. Duplicate or empty names are refused (as `PiAdapter.open` always has).
 */
export function sortedTools<T extends { readonly name: string; readonly shared?: boolean }>(tools: readonly T[]): T[] {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (tool.name.length === 0) throw new InvalidToolError("tool name must not be empty");
    if (seen.has(tool.name)) throw new InvalidToolError(`duplicate tool name "${tool.name}"`);
    seen.add(tool.name);
  }
  return [...tools].sort((a, b) => (a.shared === true ? 0 : 1) - (b.shared === true ? 0 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A short digest of the layout and the tool declarations: equal digests mean the same head bytes. Used for audit events and tests, never as a key sent to a provider. */
export function layoutFingerprint(layout: PromptLayout, tools: readonly { readonly name: string; readonly description: string; readonly parameters: unknown; readonly shared?: boolean }[]): string {
  const declarations = [...tools].sort((a, b) => (a.name < b.name ? -1 : 1)).map((t) => ({ name: t.name, shared: t.shared === true, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters)) as unknown }));
  return `pl-${createHash("sha256").update(JSON.stringify({ ...(layout.completionRules === true ? { c: COMPLETION_RULES } : {}), p: layout.preamble, j: layout.project ?? null, a: layout.agent ?? null, t: declarations })).digest("base64url").slice(0, 22)}`;
}

/** Holds the layout the sections render from. The sections read it on every request, so a change takes effect at the next request, exactly once, through `PiAdapter.changePromptLayout`. */
export class LayoutHolder {
  #current: PromptLayout;
  constructor(layout: PromptLayout) { this.#current = checkLayout(layout); }
  get current(): PromptLayout { return this.#current; }
  replace(next: PromptLayout): PromptLayout { const previous = this.#current; this.#current = checkLayout(next); return previous; }
}

/** The extension sections, most widely shared first. A section whose text is absent is omitted, not rendered empty. */
export function layoutSections(holder: LayoutHolder): PromptSection[] {
  return [
    { key: COMPLETION_SECTION_KEY, render: () => (holder.current.completionRules === true ? COMPLETION_RULES : undefined) },
    { key: "nn_preamble", render: () => (holder.current.preamble.length === 0 ? undefined : holder.current.preamble) },
    { key: "nn_project", render: () => holder.current.project },
    { key: "nn_agent", render: () => holder.current.agent },
  ];
}

/**
 * Wraps content that changes between turns so it can be sent as a user message after the stable prompt. It is never put in a system section: a system section that changes rewrites the head of the request.
 */
export function volatileContext(text: string): string {
  return `<context>\n${text}\n</context>`;
}

/** The system text exactly as Pi renders the sections every agent of a project has in common (each wrapped in its tag, joined by a blank line). A request whose system text does not start with this is left alone. */
export function sharedSystemText(layout: PromptLayout): string {
  return [
    ...(layout.completionRules === true ? [`<${COMPLETION_SECTION_KEY}>\n${COMPLETION_RULES}\n</${COMPLETION_SECTION_KEY}>`] : []),
    ...(layout.preamble.length === 0 ? [] : [`<nn_preamble>\n${layout.preamble}\n</nn_preamble>`]),
    ...(layout.project === undefined ? [] : [`<nn_project>\n${layout.project}\n</nn_project>`]),
  ].join("\n\n");
}

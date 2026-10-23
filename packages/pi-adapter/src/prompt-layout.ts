import { createHash } from "node:crypto";
import type { PromptSection } from "@earendil-works/pi-durable";
import { InvalidToolError, PiAdapterError } from "./errors.js";

/**
 * The prompt layout NimbleNewt gives every Pi agent (card C06b). Pi Durable 1.3.0 renders no system text of its own; it renders whatever sections the agent has, in order, and replays them with the tool declarations into one
 * leading system message before each request. Anything that changes in a section or in the tool set therefore rewrites the head of the request and loses every cached prefix after it. The layout below keeps the head still:
 *
 *   1. tool declarations, sorted by name (the order callers pass them in is not part of the prompt),
 *   2. a preamble common to every agent of the installation,
 *   3. the project's context (shared by every agent of the project),
 *   4. the agent's own instructions,
 *   5. nothing volatile: what changes from turn to turn (the time, the current task state, retrieved notes) is sent as a user message after all of this (`volatileContext`).
 *
 * The text is fixed when the layout is given and changes only through `PiAdapter.changePromptLayout`, which is audited, because every change costs a re-read of everything after it.
 */
export interface PromptLayout {
  /** Common to every agent of the installation (house rules, tool etiquette, output conventions). The most widely shared text, so it goes first. */
  readonly preamble: string;
  /** Shared by every agent of one project (project description, conventions). */
  readonly project?: string;
  /** This agent's own role and instructions. */
  readonly agent?: string;
}

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
  if (typeof layout.preamble !== "string" || layout.preamble.trim().length === 0) throw new PiAdapterError("the prompt layout needs a preamble");
  assertStableText("preamble", layout.preamble);
  if (layout.project !== undefined) assertStableText("project", layout.project);
  if (layout.agent !== undefined) assertStableText("agent", layout.agent);
  return Object.freeze({ preamble: layout.preamble, ...(layout.project === undefined || layout.project.length === 0 ? {} : { project: layout.project }), ...(layout.agent === undefined || layout.agent.length === 0 ? {} : { agent: layout.agent }) });
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
  return `pl-${createHash("sha256").update(JSON.stringify({ p: layout.preamble, j: layout.project ?? null, a: layout.agent ?? null, t: declarations })).digest("base64url").slice(0, 22)}`;
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
    { key: "nn_preamble", render: () => holder.current.preamble },
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
  return [`<nn_preamble>\n${layout.preamble}\n</nn_preamble>`, ...(layout.project === undefined ? [] : [`<nn_project>\n${layout.project}\n</nn_project>`])].join("\n\n");
}

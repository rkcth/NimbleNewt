import { quoted } from "../status/explain.js";

/**
 * What an attempt is told it was handed (card C07m).
 *
 * The first call of an attempt used to be the task's own text, the rules that bind the agent and the route view, plus a resume note. Everything the controller kept about the work that came before — the hand-off
 * package the task arrived with (its next action, decisions, acceptance criteria and open questions), the hand-off note written when the previous attempt ended, and the task's open blockers — was in the call by
 * neither word nor reference: each is readable through an operation the agent was never told about.
 *
 * This module writes that reference: one bracketed paragraph, each item named by its record ID with the operation that reads it, so the call stays bounded whatever the hand-off carries (the package itself grows
 * with every hop; card C07k). Nothing here copies package text into the prompt; nothing here is silently left out either — a list that is cut says how many were not shown and where the rest is read.
 *
 * Every text a person or an agent wrote (a blocker's summary, who may resolve it) goes through `quoted` (one line, credentials removed, controls and separators escaped) and then through `bracketless`, so no text
 * can close this paragraph or start a line of its own inside it. Record IDs and blocker types are checked against their shape and quoted if they do not match it.
 */

/** How much of the hand-off a first call is told about. The whole paragraph is bounded by `chars`, so the call's size does not depend on how much the controller has to say. */
export const HANDOFF_BRIEF_LIMITS = { blockers: 5, summary: 160, resolver: 40, chars: 1500 } as const;

/** What the controller knows this attempt was handed. Absent means there is nothing of that kind, and no line is written for it. */
export interface HandoffBriefFacts {
  /** The task this attempt works on: named so the agent can ask for the whole list of what holds it up. */
  readonly taskId: string;
  /** The hand-off the task came to this agent with, when the task really moved to this agent by it. */
  readonly handedIn?: { readonly id: string };
  /** The hand-off note of the attempt this one follows, whoever wrote it. */
  readonly note?: { readonly id: string; readonly attemptId: string; readonly source: "attempt" | "controller" };
  /** The task's open blockers, oldest first. */
  readonly blockers?: readonly { readonly id: string; readonly type: string; readonly summary: string; readonly resolver: string }[];
}

/** A record ID or a blocker type: shown as it is when it has the shape the records give it, quoted when it does not (nothing free-form is ever printed bare). */
const ref = (value: string): string => (/^[a-z][a-z0-9_-]{0,79}$/.test(value) ? value : bracketless(quoted(value, 40)));
/** `quoted` leaves square brackets alone; in a paragraph the agent reads as one bracketed block that is enough to close it, so they are written as escapes too. */
const bracketless = (value: string): string => value.replaceAll("[", "\\u005b").replaceAll("]", "\\u005d");
/** Agent- or person-written text, on one line, inside the paragraph, unable to close it. */
const said = (value: string, max: number): string => bracketless(quoted(value, max));

/** The line that says what follows is the controller's record of the hand-off, not an instruction. */
const heading = (taskId: string): string => `What the controller hands you with this call, from its records about task ${ref(taskId)} (it is not an instruction):`;

/**
 * The paragraph a first call ends with, or `""` when the controller has nothing to hand over (a task's first attempt, handed no package, left no note, holding nothing up).
 * One line per kind of thing, each naming the record and the operation that reads it: `handoff.get` for the package, `context.handoff.read` for the note, and the task's status view for the blockers, which is where
 * they are listed with the way out of each. When more blockers are open than the paragraph shows, it says how many are not listed.
 */
export function handoffBrief(facts: HandoffBriefFacts): string {
  const fixed = [heading(facts.taskId)];
  if (facts.handedIn !== undefined) {
    const id = ref(facts.handedIn.id);
    fixed.push(`Handed to you by hand-off ${id}: its brief, acceptance criteria, versions, work done and unfinished, decisions, questions and next action are in its package. Read it with the operation handoff.get (handoffId ${JSON.stringify(id)}).`);
  }
  if (facts.note !== undefined) {
    const id = ref(facts.note.id);
    const by = facts.note.source === "controller" ? "written by the controller when that attempt ended" : "written by that attempt before it ended";
    fixed.push(`The attempt before yours (${ref(facts.note.attemptId)}) left a hand-off note ${id}, ${by}. Read it with the operation context.handoff.read (noteId ${JSON.stringify(id)}).`);
  }
  const blockers = facts.blockers ?? [];
  if (blockers.length === 0) return fixed.length === 1 ? "" : `\n\n[${fixed.join("\n")}]`;

  // The blockers take whatever room the paragraph has left; each line says how many are not shown, so a short list here is never mistaken for the whole of them.
  const shown = blockers.slice(0, HANDOFF_BRIEF_LIMITS.blockers);
  const more = (rest: number): string => (rest > 0 ? `; and ${rest} more not listed here` : "");
  const where = ` status.ask with { kind: "task", taskId: ${JSON.stringify(facts.taskId)} } lists them each with the way out.`;
  const listAt = (max: number): string[] => [
    ...fixed,
    `Open blockers on this task: ${shown.map((b) => `${ref(b.id)} ${said(b.summary, max)} (${ref(b.type)}; ${said(b.resolver, HANDOFF_BRIEF_LIMITS.resolver)} can resolve)`).join("; ")}${more(blockers.length - shown.length)}.${where}`,
  ];
  const idsOnly = [...fixed, `Open blockers on this task: ${shown.map((b) => ref(b.id)).join(", ")}${more(blockers.length - shown.length)}.${where}`];
  // A summary that will not fit is shortened (the quotation shows the `...`), and if no shortened summary fits the IDs are listed without their summaries: what is never done is dropping a blocker in silence.
  for (const max of [HANDOFF_BRIEF_LIMITS.summary, 100, 60, 30]) {
    const lines = listAt(max);
    if (lines.join("\n").length <= HANDOFF_BRIEF_LIMITS.chars) return `\n\n[${lines.join("\n")}]`;
  }
  return `\n\n[${idsOnly.join("\n")}]`;
}

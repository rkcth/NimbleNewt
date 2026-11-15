import type { SettingDefinition } from "../configuration/settings.js";

/**
 * The owner's settings of the meeting procedure (card M06). Each is a default the owner can change in chat or by the API (installation layer, shown to the owner first). The values are the defaults proposed by the meeting
 * experiments (m00-meeting-experiments.md, "Provisional defaults") and are built in as defaults until the owner accepts or changes them: nothing here waits on an answer.
 */
export interface ProcedureSettings {
  /** Comment rounds before the objection check (default 2). */
  readonly rounds: number;
  /** How many times an upheld objection may be addressed and the check run again (default 2). */
  readonly objectionReruns: number;
  /** The most revision turns one voter is offered during one vote, one per owner message (default 3). */
  readonly maxRevisions: number;
  /** Whether the chair may table a motion when members need time to research (default true; the owner can always table). */
  readonly tabling: boolean;
  /** Whether a meeting that looked like an echo is flagged in its summary (default true). */
  readonly echoFlag: boolean;
  /** `diverse`: seat members of different model families (and information) next to each other where the roster allows; `listed`: the roster's own order (default diverse). */
  readonly seating: "diverse" | "listed";
}

export const PROCEDURE_DEFAULTS: ProcedureSettings = { rounds: 2, objectionReruns: 2, maxRevisions: 3, tabling: true, echoFlag: true, seating: "diverse" };

const refuse = (message: string): never => { throw message; };
const whole = (min: number, max: number) => (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : refuse(`must be a whole number from ${min} to ${max}`));
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : refuse("must be true or false"));

export const PROCEDURE_SETTING_KEYS = ["meeting.rounds", "meeting.objection.reruns", "meeting.vote.maxRevisions", "meeting.tabling", "meeting.echoFlag", "meeting.seating"] as const;

export const PROCEDURE_SETTINGS: readonly SettingDefinition[] = [
  { key: "meeting.rounds", kind: "default", installationOnly: true, check: whole(1, 5), fallback: PROCEDURE_DEFAULTS.rounds, effect: "next-request", description: "How many comment rounds a motion gets before the objection check and the vote (default 2, 1 to 5). In each round every present member has the floor once." },
  { key: "meeting.objection.reruns", kind: "default", installationOnly: true, check: whole(0, 5), fallback: PROCEDURE_DEFAULTS.objectionReruns, effect: "next-request", description: "How many times an upheld objection may be addressed and the objection check run again (default 2, 0 to 5); after that the chair or the owner rules whether to go ahead and the remaining objections are recorded as dissent." },
  { key: "meeting.vote.maxRevisions", kind: "default", installationOnly: true, check: whole(0, 10), fallback: PROCEDURE_DEFAULTS.maxRevisions, effect: "next-request", description: "The most revision turns one voter is offered during one vote, one for each owner message after its ballot (default 3, 0 to 10; 0 offers none)." },
  { key: "meeting.tabling", kind: "default", installationOnly: true, check: bool, fallback: PROCEDURE_DEFAULTS.tabling, effect: "next-request", description: "Whether the chair may table a motion, with no vote, when members say they need time to research (default true). The owner can always table, overrule a tabling or ask for the vote anyway." },
  { key: "meeting.echoFlag", kind: "default", installationOnly: true, check: bool, fallback: PROCEDURE_DEFAULTS.echoFlag, effect: "next-request", description: "Whether a meeting where every first-round stance and every ballot was the same is flagged in its summary as looking like an echo (default true)." },
  { key: "meeting.seating", kind: "default", installationOnly: true, check: (v) => (v === "diverse" || v === "listed" ? v : refuse("must be diverse or listed")), fallback: PROCEDURE_DEFAULTS.seating, effect: "next-request", description: "The speaking and ballot order of a meeting: diverse seats members of different model families, or with different information, next to each other where the roster allows; listed keeps the roster's order (default diverse)." },
];

import type { SettingDefinition } from "../configuration/settings.js";

/**
 * How a facilitated meeting runs (card M05). Every default is the one the M00 experiments proposed ("Provisional defaults"); the owner has not formally accepted them, so each is a setting the owner can change
 * for the whole installation (the configuration API, or in the chat with any words) and, for one meeting, with `MeetingFloorService.configure`.
 */
export interface FloorSettings {
  /** `blind`: every present member answers once, independently and without hearing anyone else, before the first statement is shown to anyone. `open`: the usual order, each hears the earlier speakers. */
  readonly firstRound: "blind" | "open";
  /** Comment rounds before the vote (the second may check the member's own desk). 0 goes straight to the objection check. */
  readonly commentRounds: number;
  /** The most VISIBLE output tokens one statement may have; hidden reasoning is budgeted separately. */
  readonly turnTokens: number;
  /** The most hidden reasoning tokens one turn may spend (asked of the model route; a turn that goes over is recorded). */
  readonly hiddenReasoningTokens: number;
  /** A turn that has not answered after this many seconds is given up on and recorded as no response. This is a safety, not a length limit. */
  readonly hangTimeoutSeconds: number;
  /** `auto`: the whole text up to `factsAboveMembers` present members, facts-style summaries above that (the full text stays retrievable). */
  readonly transcriptMode: "auto" | "full" | "facts";
  readonly factsAboveMembers: number;
  /** The chair's private notes: written once after round 1 (the default), after every statement (`rolling`, which cost more and changed no outcome in the experiments) or not at all. */
  readonly chairNotes: "once" | "rolling" | "off";
  /** Fact-finding questions the chair may put per motion. */
  readonly chairQuestionCap: number;
  /** Reminders of omitted points the chair may restate (facts-style transcripts only) and the most points in its round summary. */
  readonly chairReminders: number;
  readonly chairSummaryPoints: number;
  /** Direct questions one member may ask per round (the answer is a short turn; depth one). 0 turns them off. */
  readonly directQuestions: number;
  /** How many times the objection check may run again after an amendment. */
  readonly objectionReruns: number;
  /** Whether "needs time to research" may table the motion (the chair rules; no vote is held). */
  readonly tabling: boolean;
  /** `shared-first`: the part of a prompt that is the same for every member comes first and byte-identical (a hosted prompt cache reuses it); `agent-first` is the ordinary order. */
  readonly promptOrder: "shared-first" | "agent-first";
  /** After this many idle minutes of an open owner inquiry the owner is reminded. */
  readonly inquiryIdleMinutes: number;
  /** The most revision turns one voter is offered in a vote, whatever the owner's messages. */
  readonly maxRevisionsPerVoter: number;
  /** The meeting's model-spend timebox: dollars and tokens (the owner's own questions are recorded but not counted against them). */
  readonly spendCapUsd: number;
  readonly tokenCap: number;
  /** Turns of a blind round or an objection check that may be asked at once. */
  readonly parallel: number;
  /** The visible tokens an answer to the owner may have (the meeting's turn limit does not apply to the owner's questions). */
  readonly ownerAnswerTokens: number;
  /** Whether a question to a member who is not in the room is answered from its saved checkpoint (stamped as not live). */
  readonly checkpointAnswers: boolean;
  /** Whether an amendment after the comment rounds starts a fresh round (and a fresh vote). */
  readonly freshRoundAfterAmendment: boolean;
}

export const FLOOR_DEFAULTS: FloorSettings = {
  firstRound: "blind", commentRounds: 2, turnTokens: 220, hiddenReasoningTokens: 800, hangTimeoutSeconds: 120, transcriptMode: "auto", factsAboveMembers: 8, chairNotes: "once", chairQuestionCap: 2, chairReminders: 2,
  chairSummaryPoints: 6, directQuestions: 1, objectionReruns: 2, tabling: true, promptOrder: "shared-first", inquiryIdleMinutes: 30, maxRevisionsPerVoter: 3, spendCapUsd: 5, tokenCap: 600_000, parallel: 4, ownerAnswerTokens: 400,
  checkpointAnswers: true, freshRoundAfterAmendment: true,
};

type Kind = { readonly choice: readonly string[] } | { readonly flag: true } | { readonly whole: readonly [number, number] } | { readonly number: readonly [number, number] };
const TABLE: readonly { readonly name: keyof FloorSettings; readonly kind: Kind; readonly description: string }[] = [
  { name: "firstRound", kind: { choice: ["blind", "open"] }, description: "blind (default): each present member gives its view on its own, in parallel, before hearing anyone; open: each hears the earlier speakers." },
  { name: "commentRounds", kind: { whole: [0, 5] }, description: "How many comment rounds come before the vote (default 2)." },
  { name: "turnTokens", kind: { whole: [40, 4000] }, description: "The most visible output tokens one statement may have (default 220, about 150 words); hidden reasoning is budgeted separately." },
  { name: "hiddenReasoningTokens", kind: { whole: [0, 20000] }, description: "The most hidden reasoning tokens one turn may spend (default 800); a turn that goes over is recorded." },
  { name: "hangTimeoutSeconds", kind: { whole: [5, 3600] }, description: "Seconds after which a turn that has not answered is given up on and recorded as no response (default 120); a safety, not a length limit." },
  { name: "transcriptMode", kind: { choice: ["auto", "full", "facts"] }, description: "What members are shown of earlier statements: auto (default) is the whole text up to factsAboveMembers present members and facts-style summaries above that; full always the whole text; facts always summaries. The full text stays readable." },
  { name: "factsAboveMembers", kind: { whole: [1, 500] }, description: "Present members above which auto uses facts-style summaries (default 8)." },
  { name: "chairNotes", kind: { choice: ["once", "rolling", "off"] }, description: "The chair's private notes: once after round 1 (default), after every statement, or none." },
  { name: "chairQuestionCap", kind: { whole: [0, 10] }, description: "Fact-finding questions the chair may put per motion (default 2)." },
  { name: "chairReminders", kind: { whole: [0, 5] }, description: "Omitted points the chair may restate when summaries are used (default 2)." },
  { name: "chairSummaryPoints", kind: { whole: [1, 12] }, description: "The most points in the chair's summary of a round (default 6)." },
  { name: "directQuestions", kind: { whole: [0, 3] }, description: "Direct questions one member may ask another per round (default 1; 0 turns them off)." },
  { name: "objectionReruns", kind: { whole: [0, 5] }, description: "How many times the objection check may run again after an amendment (default 2)." },
  { name: "tabling", kind: { flag: true }, description: "Whether a member's \"needs time to research\" lets the chair table the motion with no vote (default true)." },
  { name: "promptOrder", kind: { choice: ["shared-first", "agent-first"] }, description: "shared-first (default): what is the same for every member comes first so a hosted prompt cache is reused; agent-first is the ordinary order." },
  { name: "inquiryIdleMinutes", kind: { whole: [1, 1440] }, description: "Minutes an open owner inquiry may sit idle before the owner is reminded (default 30)." },
  { name: "maxRevisionsPerVoter", kind: { whole: [0, 10] }, description: "The most revision turns one voter is offered in one vote (default 3)." },
  { name: "spendCapUsd", kind: { number: [0, 1000] }, description: "The meeting's model-spend timebox in dollars (default 5); the owner's own questions are recorded but not counted." },
  { name: "tokenCap", kind: { whole: [1000, 50_000_000] }, description: "The meeting's model-token timebox (default 600000); the owner's own questions are recorded but not counted." },
  { name: "parallel", kind: { whole: [1, 8] }, description: "How many members of a blind round or an objection check are asked at once (default 4)." },
  { name: "ownerAnswerTokens", kind: { whole: [40, 4000] }, description: "The visible tokens an answer to the owner may have (default 400)." },
  { name: "checkpointAnswers", kind: { flag: true }, description: "Whether a question to a member who is not in the room is answered from its saved checkpoint, stamped as not live (default true)." },
  { name: "freshRoundAfterAmendment", kind: { flag: true }, description: "Whether an amendment made after the comment rounds starts a fresh round and a fresh vote (default true)." },
];

const KEY = (name: string): string => `meeting.floor.${name}`;
const describe = (kind: Kind): string => ("choice" in kind ? `one of ${kind.choice.join(", ")}` : "flag" in kind ? "true or false" : "whole" in kind ? `a whole number from ${kind.whole[0]} to ${kind.whole[1]}` : `a number from ${kind.number[0]} to ${kind.number[1]}`);

/** Checks one value the way the setting wants it; throws the message (a string) when it is wrong. */
export function checkFloorValue(name: keyof FloorSettings, value: unknown): unknown {
  const entry = TABLE.find((t) => t.name === name);
  if (entry === undefined) throw `${String(name)} is not a meeting setting`;
  const kind = entry.kind;
  if ("choice" in kind) { if (typeof value === "string" && kind.choice.includes(value)) return value; }
  else if ("flag" in kind) { if (typeof value === "boolean") return value; }
  else if ("whole" in kind) { if (typeof value === "number" && Number.isSafeInteger(value) && value >= kind.whole[0] && value <= kind.whole[1]) return value; }
  else if (typeof value === "number" && Number.isFinite(value) && value >= kind.number[0] && value <= kind.number[1]) return value;
  throw `must be ${describe(kind)}`;
}

/** The settings the configuration service takes (`meeting.floor.<name>`), appended to `MEETING_SETTINGS`. Each is installation wide and takes effect with the next meeting. */
export const FLOOR_SETTINGS: readonly SettingDefinition[] = TABLE.map((t) => ({
  key: KEY(t.name), kind: "default" as const, installationOnly: true, check: (v: unknown) => checkFloorValue(t.name, v), fallback: FLOOR_DEFAULTS[t.name], effect: "next-request" as const,
  description: `${t.description} (Meeting floor; proposed by the M00 experiments and not yet formally accepted, so the owner may change it.)`,
}));

/** The names a per-meeting `configure` may set. */
export const FLOOR_SETTING_NAMES: readonly (keyof FloorSettings)[] = TABLE.map((t) => t.name);

/** The settings in force from the configuration's values (`meeting.floor.<name>` keys, as `ConfigurationService.effective` returns them): a value that does not check falls back to the default. */
export function floorSettingsFrom(values: Readonly<Record<string, { readonly value?: unknown } | unknown>> | undefined): FloorSettings {
  const out: Record<string, unknown> = { ...FLOOR_DEFAULTS };
  for (const t of TABLE) {
    const raw = values?.[KEY(t.name)];
    const value = raw !== null && typeof raw === "object" && "value" in (raw as object) ? (raw as { value?: unknown }).value : raw;
    if (value === undefined) continue;
    try { out[t.name] = checkFloorValue(t.name, value); } catch { /* an unusable value is not used */ }
  }
  return out as unknown as FloorSettings;
}

/** A per-meeting change: only known names, each checked. */
export function applyFloorChange(base: FloorSettings, change: Readonly<Record<string, unknown>>): FloorSettings {
  const out: Record<string, unknown> = { ...base };
  for (const [name, value] of Object.entries(change)) {
    if (!(FLOOR_SETTING_NAMES as readonly string[]).includes(name)) throw new RangeError(`${name} is not a meeting setting`);
    try { out[name] = checkFloorValue(name as keyof FloorSettings, value); } catch (message) { throw new RangeError(`${name} ${String(message)}`); }
  }
  return out as unknown as FloorSettings;
}

/** The four settings the meeting procedure (card M06) has as well: one choice for the owner. The floor follows the procedure's key unless its own `meeting.floor.*` key was set on purpose. */
export const FLOOR_SHARED_SETTINGS: readonly (readonly [floorKey: string, procedureKey: string])[] = [
  ["meeting.floor.commentRounds", "meeting.rounds"], ["meeting.floor.objectionReruns", "meeting.objection.reruns"], ["meeting.floor.tabling", "meeting.tabling"], ["meeting.floor.maxRevisionsPerVoter", "meeting.vote.maxRevisions"],
];

/** The floor's settings from the installation's (`installationSettings`, which says whether the owner set each): see `FLOOR_SHARED_SETTINGS`. */
export function floorSettingsFromInstallation(settings: Readonly<Record<string, { readonly value: unknown; readonly set: boolean } | undefined>>): FloorSettings {
  const values: Record<string, unknown> = Object.fromEntries(FLOOR_SETTINGS.map((d) => [d.key, settings[d.key]?.value]));
  for (const [own, proc] of FLOOR_SHARED_SETTINGS) if (settings[own]?.set !== true && settings[proc]?.set === true) values[own] = settings[proc]!.value;
  return floorSettingsFrom(values);
}

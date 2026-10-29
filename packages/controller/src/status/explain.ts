import type { BlockerBasis, BlockerType } from "../domain/blockers.js";
import type { ActivityBody, AssignmentBody, AttemptBody, Owner } from "../domain/assignment-model.js";
import type { Freshness } from "../hosts/hosts.js";
import { redactText } from "../security/redact.js";

/** A record a statement rests on: the kind and ID to look it up by, and the revision it was read at. */
export interface Cite { readonly kind: string; readonly id: string; readonly revision?: number }

/** One plain sentence and the records it comes from. A sentence with no cite is never produced. */
export interface Line { readonly text: string; readonly cites: readonly Cite[] }


/**
 * What the controller can honestly say about the work on a task (card U05). It is never taken from who owns the task: only an observation by the owner, of the current generation and recent enough, makes `working`.
 * - `closed`: the task is done or cancelled. `not_assigned`: nobody owns it. `assigned_not_started`: owned, but no attempt is active.
 * - `paused`: a pause gate holds it (the gate's own observed state is reported beside this).
 * - `working`: the owner (or the host reporting for it) was observed on the current generation within the freshness window.
 * - `unknown`: an attempt is recorded as active but nothing recent says so; the last observation is old, missing, or from someone who does not own the task any more.
 */
export type ExecutionState = "closed" | "not_assigned" | "assigned_not_started" | "paused" | "working" | "unknown";
export const EXECUTION_STATES: readonly ExecutionState[] = ["closed", "not_assigned", "assigned_not_started", "paused", "working", "unknown"];

export interface WorkObservation {
  readonly by: string;
  readonly kind: string;
  readonly detail: string;
  readonly at: string;
  readonly ageMs: number;
  readonly freshness: Freshness;
  /** The observation carried the generation that is current now. */
  readonly currentGeneration: boolean;
  /** The observer is the owner of record (or the host that has been reporting for it). */
  readonly byOwner: boolean;
}

export interface ExecutionInput {
  readonly taskState: string;
  readonly assignment: AssignmentBody | undefined;
  readonly attempt: AttemptBody | undefined;
  readonly activity: ActivityBody | undefined;
  /** Progress the stall evidence recorded for the current generation, with who reported it. */
  readonly evidence: { readonly lastProgressAt: string; readonly reportedBy: string; readonly generation: number } | undefined;
  readonly paused: boolean;
  readonly now: number;
  readonly staleAfterMs: number;
}

export interface ExecutionFacts {
  readonly state: ExecutionState;
  readonly observation?: WorkObservation;
  /** Why the answer is not certain, in words. Empty when it is. */
  readonly uncertainty: readonly string[];
}

export const isOwnerOf = (owner: Owner | undefined, principalId: string): boolean => owner !== undefined && (owner.id === principalId || `${owner.kind}:${owner.id}` === principalId);

export function freshnessOf(at: string | undefined, now: number, staleAfterMs: number): Freshness {
  if (at === undefined) return "unknown";
  return Math.max(0, now - Date.parse(at)) <= staleAfterMs ? "fresh" : "stale";
}

/** "3 min", "2 h 5 min", "1 d 4 h": coarse on purpose, since the exact moment is in the record. */
export function plainDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/** Record text shown in an answer: credential-shaped runs cut out, whitespace made plain, and bounded. */
export function shown(value: string | undefined, max = 200): string {
  const clean = redactText(value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

/**
 * Who is working on a task, as far as the records show (card U05). The latest sign of life is the newer of the host activity (card H01) and the stall evidence (card V01); either counts only when it is of the
 * current generation and from the owner of record (or the one that has been reporting for it). Time never promotes anything: an old sign is `stale` and the state is `unknown`, not `working`.
 */
export function executionOf(input: ExecutionInput): ExecutionFacts {
  const { assignment: a, attempt, now } = input;
  if (input.taskState === "done" || input.taskState === "cancelled") return { state: "closed", uncertainty: [] };
  if (a === undefined || a.state !== "assigned" || a.owner === undefined) return { state: "not_assigned", uncertainty: [] };
  const active = attempt !== undefined && attempt.state === "active" && a.activeAttemptId !== undefined;
  const uncertainty: string[] = [];
  // The newest sign of life of the current generation.
  const candidates: { by: string; kind: string; detail: string; at: string; current: boolean }[] = [];
  if (input.activity !== undefined) candidates.push({ by: input.activity.observedBy, kind: input.activity.kind, detail: input.activity.detail, at: input.activity.observedAt, current: input.activity.current && input.activity.generation === a.generation });
  if (input.evidence !== undefined) candidates.push({ by: input.evidence.reportedBy, kind: "progress", detail: "", at: input.evidence.lastProgressAt, current: input.evidence.generation === a.generation });
  const sorted = candidates.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  const mine = sorted.find((c) => c.current && (isOwnerOf(a.owner, c.by) || (c.by.startsWith("host:") && input.evidence?.reportedBy === c.by)));
  const newest = mine ?? sorted[0];
  const observation: WorkObservation | undefined = newest === undefined ? undefined : {
    by: newest.by, kind: newest.kind, detail: newest.detail, at: newest.at, ageMs: Math.max(0, now - Date.parse(newest.at)),
    freshness: freshnessOf(newest.at, now, input.staleAfterMs), currentGeneration: newest.current, byOwner: mine !== undefined,
  };
  if (observation !== undefined && !observation.currentGeneration) uncertainty.push(`the last thing seen (by ${observation.by}) was under an earlier owner, so it says nothing about the current one`);
  else if (observation !== undefined && !observation.byOwner) uncertainty.push(`the last thing seen was by ${observation.by}, who is not the owner of record`);
  const out = (state: ExecutionState): ExecutionFacts => ({ state, ...(observation === undefined ? {} : { observation }), uncertainty });
  if (!active) return out("assigned_not_started");
  if (input.paused) return out("paused");
  if (observation === undefined) { uncertainty.push("it is recorded as running, but no sign of work has been seen"); return out("unknown"); }
  if (observation.byOwner && observation.freshness === "fresh") return out("working");
  if (observation.freshness === "stale") uncertainty.push(`the last sign of work is ${plainDuration(observation.ageMs)} old`);
  return out("unknown");
}

// ---- blockers ------------------------------------------------------------------------------------------------------------------

const HINTS: Readonly<Record<BlockerType, string>> = {
  manual_hold: "only a person lifts it; nothing automatic clears it",
  delivery_exhausted: "find out why the message could not be delivered, then have it sent again",
  effect_uncertain: "check the outside system and record whether the action happened; it is never repeated blindly",
  wait_overdue: "answer the wait, or cancel it",
  scan_failure: "look at the record that could not be read",
  unexplained_block: "say why the task is blocked, or release it",
  runtime_hold: "review the unfinished work the runtime found and recover it",
  circular_wait: "break the ring by changing one dependency or answering one of the inquiries",
  context_overflow: "change the model route, the task or the budget",
  grant_needed: "give the grant the task needs, or change the task so it does not need it",
  dispatch_blocked: "change the route, the harness, the budget or the task, then the dispatcher starts it",
  missing_context: "supply the context the resume needs, or change the task so it does not need it",
  resume_churn: "look at what keeps changing under the task, settle it, then resume again",
};

/** The first words of the route: what kind of obstacle it is. */
export const BASIS_WORDS: Readonly<Record<BlockerBasis, string>> = {
  technical: "a technical problem",
  enforced_permission: "an enforced permission boundary",
  policy_conflict: "a conflict between configured policies",
  owner_hold: "a hold placed by a person",
  preference: "a preference",
};

export const whoText = (resolver: string, viewerIsOwner: boolean): string => (resolver === "owner" ? (viewerIsOwner ? "you" : "the owner") : resolver);

/** The way out, in words: what has to happen and who can do it. A preference is advice, so its route says it is not a boundary. */
export function routeFor(type: BlockerType, basis: BlockerBasis, resolver: string, viewerIsOwner: boolean): string {
  const who = whoText(resolver, viewerIsOwner);
  switch (basis) {
    case "enforced_permission": return `a permission is withheld on purpose; ${viewerIsOwner ? "you can grant it or choose another way" : "the owner can grant it, or another way can be chosen"} (${who === "you" ? "you resolve" : `${who} resolves`} it)`;
    case "policy_conflict": return `an explicit policy change is needed, made by ${viewerIsOwner ? "you" : "the owner"}; no team decision replaces it`;
    case "preference": return "this is a preference, not a boundary; nothing is prevented by it";
    default: return `${HINTS[type]} (${who === "you" ? "you resolve" : `${who} resolves`} it)`;
  }
}

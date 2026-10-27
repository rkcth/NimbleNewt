import type { Difficulty } from "../planning/contracts.js";

/** What a stall-detection pass reads, all of it recorded by the controller with its own clock. Nothing here is a judgement: `assessStall` turns it into one. */
export type StallKind = "loop" | "repeated_errors" | "silent" | "stuck_request" | "budget";
export const STALL_KINDS: readonly StallKind[] = ["loop", "repeated_errors", "silent", "stuck_request", "budget"];
export type JobStatus = "running" | "waiting" | "idle" | "finished" | "failed";
export const JOB_STATUSES: readonly JobStatus[] = ["running", "waiting", "idle", "finished", "failed"];

/** One step or error in the bounded window. `key` is the reporter's normal form of "the same action" (for example a tool name and a digest of its arguments). `ev` is how much acceptance evidence existed then. */
export interface WindowEntry { readonly t: "s" | "e"; readonly key: string; readonly at: string; readonly ev: number }

/** The bounded progress evidence of one task generation (kind `stall-evidence`, one per task). */
export interface EvidenceBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly generation: number;
  readonly since: string;
  readonly reportedBy: string;
  readonly lastReportAt: string;
  /** The last *progress* event (a step, an error, evidence, a finished request, a change of job status, a request start). A repeated `job: running` ping or a spend report is a report but not progress: a hung worker can send those for ever. */
  readonly lastProgressAt: string;
  readonly reports: number;
  /**
   * The open request. `promptTokens` is the estimate made when it started (card V01b: the body's characters over the route's characters per token, less the share the cache is expected to hold, `cachedShare`); `route` and
   * `hostId` say whose speed it measures; `firstOutputAt` is when the first output arrived (it ends the reading allowance) and `outputTokens` how much has been written so far.
   */
  readonly request?: { readonly id: string; readonly startedAt: string; readonly promptTokens?: number; readonly cachedShare?: number; readonly route?: string; readonly hostId?: string; readonly firstOutputAt?: string; readonly outputTokens?: number };
  /** Controller-measured length of the last request that finished. */
  readonly lastRequestMs?: number;
  readonly lastStep?: { readonly label: string; readonly at: string };
  readonly lastError?: { readonly errorClass: string; readonly at: string };
  readonly steps: number;
  /** For display only: the last 30 steps and errors. Loop detection uses `counts`. */
  readonly window: readonly WindowEntry[];
  /** Occurrences of each step (`s:<key>`) and error (`e:<key>`) since the latest acceptance evidence, at most `STALL_LIMITS.countKeys` keys (the least repeated is dropped to make room); reset when evidence arrives. */
  readonly counts: Readonly<Record<string, number>>;
  readonly job?: { readonly status: JobStatus; readonly at: string };
  readonly spend?: { readonly minutes?: number; readonly cost?: number };
  /** Names of the acceptance evidence produced (the latest `STALL_LIMITS.evidence`); `evidenceTotal` counts every one ever added. */
  readonly evidence: readonly string[];
  readonly evidenceTotal: number;
}

export interface StallThresholds {
  /** An open model or tool request this long, with nothing else reported since it began, is suspect. */
  readonly requestMs: number;
  /** No signal at all for this long is suspect. */
  readonly silenceMs: number;
  /** The same action this many times (within the window of the last 30 steps and errors) since the latest acceptance evidence is a suspected loop. */
  readonly repeatedActions: number;
  /** The same error this many times, likewise. */
  readonly repeatedErrors: number;
}

const MIN = 60_000;
/** Provisional, by difficulty: harder work legitimately has longer requests, longer quiet stretches and more retries before it is suspect. Measure and adjust (configurable per service). */
export const DEFAULT_THRESHOLDS: Readonly<Record<Difficulty, StallThresholds>> = {
  trivial: { requestMs: 2 * MIN, silenceMs: 5 * MIN, repeatedActions: 4, repeatedErrors: 3 },
  easy: { requestMs: 5 * MIN, silenceMs: 10 * MIN, repeatedActions: 5, repeatedErrors: 4 },
  medium: { requestMs: 10 * MIN, silenceMs: 20 * MIN, repeatedActions: 6, repeatedErrors: 5 },
  hard: { requestMs: 20 * MIN, silenceMs: 40 * MIN, repeatedActions: 8, repeatedErrors: 6 },
  expert: { requestMs: 45 * MIN, silenceMs: 90 * MIN, repeatedActions: 10, repeatedErrors: 8 },
};

export const STALL_LIMITS = { window: 30, evidence: 30, key: 120, label: 200, requestId: 80, maxRepeat: 1000, countKeys: 60, scan: 1000 } as const;

export interface HostEvidence { readonly hostId: string; readonly identity: "active" | "revoked"; readonly freshness: "fresh" | "stale" | "unknown" }

export interface AssessInput {
  readonly now: number;
  /** The task is in progress under an assignment with an active attempt. */
  readonly running: boolean;
  /** The task has an open wait (card S08): it is waiting on purpose, and its own deadline and owner are S08's business. */
  readonly waiting: boolean;
  /** A pause gate (card L01) applies to the task: it is not expected to make progress, so silence, loops and budget are not judged. */
  readonly paused?: boolean;
  readonly difficulty: Difficulty;
  readonly thresholds: StallThresholds;
  /** When the active attempt began: the earliest a silence can be counted from. */
  readonly attemptStart: number;
  /** The last time the worker's own activity was seen (card H01 progress), already checked to be the owner's or the evidence reporter's, and of the current generation. */
  readonly activityAt?: number;
  readonly evidence?: EvidenceBody;
  readonly budget: { readonly maxMinutes?: number; readonly maxCost?: number };
  readonly requiredEvidence: number;
  readonly host?: HostEvidence;
  /** How fast the request's route reads a prompt, and how much longer than the expected reading time a request may take before it is suspect (card V01b). Without it the difficulty's times alone apply. */
  readonly reading?: { readonly tokensPerSecond: number; readonly source: "measured" | "declared" | "default"; readonly marginPercent: number };
}

export interface Concern { readonly kind: StallKind; readonly detail: string }

export interface Assessment {
  /** `healthy`: signals are recent and moving. `long_running`: a request is long but the worker is still reporting, so it is not suspect. `waiting`: an open wait explains the quiet. `paused`: a pause gate explains it. `suspected`: see `concerns`. `not_running`: nothing to assess. */
  readonly status: "healthy" | "long_running" | "waiting" | "paused" | "suspected" | "not_running";
  readonly concerns: readonly Concern[];
  readonly signals: {
    readonly silenceMs: number;
    readonly requestOpenMs?: number;
    readonly lastRequestMs?: number;
    readonly lastStep?: { readonly label: string; readonly at: string };
    readonly topAction?: { readonly key: string; readonly count: number };
    readonly topError?: { readonly key: string; readonly count: number };
    readonly job?: { readonly status: JobStatus; readonly at: string };
    readonly spend?: { readonly minutes?: number; readonly cost?: number };
    readonly budget: { readonly maxMinutes?: number; readonly maxCost?: number };
    readonly evidenceCount: number;
    readonly requiredEvidence: number;
    readonly host?: HostEvidence;
    /** While a request reads its prompt (card V01b): the prompt size, the speed used and where it came from, the time that reading should take and the time the request is allowed. */
    readonly reading?: { readonly promptTokens: number; readonly tokensPerSecond: number; readonly source: "measured" | "declared" | "default"; readonly expectedMs: number; readonly allowedMs: number };
  };
  readonly takeover: {
    /** Always false: the controller never reassigns because of this assessment. Reassignment is the owner's explicit command (card S02). */
    readonly permitted: false;
    /** `may_be_proposed` only when the silence of the worker is backed by an independent channel (its host's identity revoked); timestamps alone, however stale, are `insufficient`. */
    readonly basis: "insufficient" | "may_be_proposed";
    readonly note: string;
  };
}

const TAKEOVER_NOTE = "A suspicion is not permission: reassigning needs the owner's explicit decision. Timestamps alone are never enough to propose it.";

/** The most repeated key of one kind since the latest acceptance evidence. */
function top(counts: Readonly<Record<string, number>>, t: "s" | "e"): { key: string; count: number } | undefined {
  let best: { key: string; count: number } | undefined;
  for (const [k, count] of Object.entries(counts)) if (k.startsWith(`${t}:`) && (best === undefined || count > best.count)) best = { key: k.slice(2), count };
  return best;
}

const minutes = (ms: number): string => `${Math.round(ms / MIN)} min`;

/**
 * The deterministic part of stall detection (card V01): signals in, concerns out, no clock of its own. A long job is told apart from a loop and from a dead worker by what is
 * still arriving: a long request with steps, errors, job status or evidence arriving is `long_running`; the same action or error repeating with no new acceptance evidence is a
 * loop; nothing at all for the threshold is silence (a dead worker looks like this, but so does a stalled connection, which is why silence alone never permits a takeover).
 */
export function assessStall(input: AssessInput): Assessment {
  const { evidence: ev, thresholds: th, now } = input;
  const progress = ev === undefined ? undefined : Date.parse(ev.lastProgressAt);
  const lastSignal = Math.max(input.attemptStart, progress ?? 0, input.activityAt ?? 0);
  const silenceMs = Math.max(0, now - lastSignal);
  const evidenceCount = ev?.evidenceTotal ?? 0;
  const topAction = ev === undefined ? undefined : top(ev.counts, "s");
  const topError = ev === undefined ? undefined : top(ev.counts, "e");
  const request = ev?.request;
  const requestOpenMs = request === undefined ? undefined : Math.max(0, now - Date.parse(request.startedAt));
  const signals: Assessment["signals"] = {
    silenceMs,
    ...(requestOpenMs === undefined ? {} : { requestOpenMs }),
    ...(ev?.lastRequestMs === undefined ? {} : { lastRequestMs: ev.lastRequestMs }),
    ...(ev?.lastStep === undefined ? {} : { lastStep: ev.lastStep }),
    ...(topAction === undefined ? {} : { topAction }),
    ...(topError === undefined ? {} : { topError }),
    ...(ev?.job === undefined ? {} : { job: ev.job }),
    ...(ev?.spend === undefined ? {} : { spend: ev.spend }),
    budget: input.budget,
    evidenceCount,
    requiredEvidence: input.requiredEvidence,
    ...(input.host === undefined ? {} : { host: input.host }),
  };
  // A request still reading its prompt (no output yet) is given the time the prompt should take at the route's speed, with a margin, when that is longer than the difficulty's time.
  let reading: NonNullable<Assessment["signals"]["reading"]> | undefined;
  if (request?.promptTokens !== undefined && request.firstOutputAt === undefined && input.reading !== undefined) {
    const expectedMs = Math.ceil((request.promptTokens * (1 - (request.cachedShare ?? 0)) / input.reading.tokensPerSecond) * 1000);
    reading = { promptTokens: request.promptTokens, tokensPerSecond: input.reading.tokensPerSecond, source: input.reading.source, expectedMs, allowedMs: Math.max(th.requestMs, Math.ceil(expectedMs * input.reading.marginPercent / 100)) };
  }
  if (reading !== undefined) Object.assign(signals, { reading });
  const takeover = (basis: "insufficient" | "may_be_proposed"): Assessment["takeover"] => ({ permitted: false, basis, note: TAKEOVER_NOTE });
  if (input.paused === true) return { status: "paused", concerns: [], signals, takeover: takeover("insufficient") };
  if (!input.running) return { status: input.waiting ? "waiting" : "not_running", concerns: [], signals, takeover: takeover("insufficient") };
  if (input.waiting) return { status: "waiting", concerns: [], signals, takeover: takeover("insufficient") };

  const concerns: Concern[] = [];
  if (topAction !== undefined && topAction.count >= th.repeatedActions)
    concerns.push({ kind: "loop", detail: `the same action ("${topAction.key}") repeated at least ${th.repeatedActions} times since the last acceptance evidence` });
  if (topError !== undefined && topError.count >= th.repeatedErrors)
    concerns.push({ kind: "repeated_errors", detail: `the same error ("${topError.key}") repeated at least ${th.repeatedErrors} times since the last acceptance evidence` });
  const finished = ev?.job?.status === "finished";
  // While a request reads a large prompt the quiet is expected for as long as the reading is allowed (card V01b).
  const silenceLimit = reading === undefined ? th.silenceMs : Math.max(th.silenceMs, reading.allowedMs);
  if (!finished && silenceMs >= silenceLimit)
    concerns.push({ kind: "silent", detail: `no progress for at least ${minutes(silenceLimit)}${reading === undefined || silenceLimit === th.silenceMs ? "" : ` (the prompt of about ${reading.promptTokens} tokens was allowed ${minutes(reading.allowedMs)} to read)`}` });
  // A request that has been open a long time is suspect only when nothing else has arrived since it began: a worker still reporting is simply on a long job.
  let longRequest = false;
  const requestLimit = reading === undefined ? th.requestMs : reading.allowedMs;
  if (request !== undefined && requestOpenMs !== undefined && requestOpenMs >= th.requestMs) {
    const sinceStart = Math.max(progress ?? 0, input.activityAt ?? 0) > Date.parse(request.startedAt);
    if (sinceStart || requestOpenMs < requestLimit) longRequest = true;
    else if (reading !== undefined) concerns.push({ kind: "stuck_request", detail: `a request open for ${minutes(requestOpenMs)} with no output; its prompt is about ${reading.promptTokens} tokens, read at ${Math.round(reading.tokensPerSecond)} tokens a second (${reading.source}), which should take about ${minutes(reading.expectedMs)}; it was allowed ${minutes(reading.allowedMs)}` });
    else concerns.push({ kind: "stuck_request", detail: `a request open for at least ${minutes(th.requestMs)} with no progress reported since it began` });
  }
  const spend = ev?.spend;
  const overMinutes = input.budget.maxMinutes !== undefined && spend?.minutes !== undefined && spend.minutes >= input.budget.maxMinutes;
  const overCost = input.budget.maxCost !== undefined && spend?.cost !== undefined && spend.cost >= input.budget.maxCost;
  if (overMinutes || overCost)
    concerns.push({ kind: "budget", detail: `the budget is used up (${overMinutes ? `${input.budget.maxMinutes} minutes` : `${input.budget.maxCost} cost`}); the signals show how much of the required evidence exists` });

  const silent = concerns.some((c) => c.kind === "silent");
  // Only a fact that is not a timestamp counts: a revoked identity. A host and a worker that both went quiet may simply share a broken network.
  const basis = silent && input.host?.identity === "revoked" ? "may_be_proposed" : "insufficient";
  const status = concerns.length > 0 ? "suspected" : longRequest ? "long_running" : "healthy";
  return { status, concerns, signals, takeover: takeover(basis) };
}

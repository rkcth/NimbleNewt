import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { BlockerService } from "../domain/blockers.js";
import { onlyKnown, text } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Aggregate, AggregateRef, JsonObject } from "../storage/types.js";
import type { ScratchAttempt, ScratchCleanupService } from "./scratch-cleanup.js";

/**
 * The agent's ending, `work.end { submit, result, note, message }` (card H12n, first slice). The agent's request is checked at once (shape, who asks, and for `submit` whether the base is stale and overlapping files changed) and
 * recorded as a durable ending intent, one per attempt, with the attempt frozen; the controller then completes the ending (`complete`): settle (hung calls are killed with a reason), stage, open a submission, finish the attempt.
 * Everything outside the ending (the attempt's control, the landing branch's changes, the staging and the submission) is a port; this file is the order, the records and the rules:
 *
 * - a plain end (no `submit`) is never refused for freshness;
 * - a submit is refused when the base is stale AND a file the agent changed was also changed on the landing branch since; the refusal carries the head commit and the overlapping files (`SubmitRefused`);
 * - one ending per attempt: a repeated request (same attempt) returns the recorded one, a repeated `complete` does nothing twice;
 * - an owner stop wins (the attempt is no longer live, or its stop reason is the owner's: the intent is dropped, nothing is staged or submitted); an emergency stop drops the intent (`drop`);
 * - a restart finds the intents that are still open (`recover`) and completes each once;
 * - a call that had to be killed and was a write turns a submit into a plain end with the typed blocker `release_failed` (the tree cannot be trusted).
 * NOT here (remain): the real ports (dispatcher, GitBridge staging, Q01b submission records), the agent tool registration and its API operation.
 */
export const WORK_END_LIMITS = { result: 40, note: 1000, message: 2000 } as const;
/** The values `result` may take. Provisional (an owner question): the card names the field but not its vocabulary. */
export const WORK_END_RESULTS = ["done", "blocked", "partial", "abandoned"] as const;
export type WorkEndResult = (typeof WORK_END_RESULTS)[number];
export type WorkEndState = "requested" | "ending" | "done" | "dropped";

const RECORD = "work-end";

export interface Landed {
  /** The commit the agent's checkout is based on, and the landing branch's head now. */
  readonly base: string;
  readonly head: string;
  /** Files the agent changed (changed and new), and files changed on the landing branch since `base`. */
  readonly mine: readonly string[];
  readonly landed: readonly string[];
}

/** A submit the base of which is stale where the changed files overlap. The agent can refresh (H12p) and submit again, or end plainly. */
export class SubmitRefused extends DomainError {
  constructor(readonly head: string, readonly overlapping: readonly string[]) {
    super("invalid_command", `submit refused: the landing branch moved to ${head} and changed ${overlapping.length} of your files (${overlapping.slice(0, 10).join(", ")}${overlapping.length > 10 ? ", ..." : ""}); refresh and submit again, or end without submitting`);
    this.name = "SubmitRefused";
  }
}

/** The pure rule: stale base and overlap refuse; stale with no overlap, or a current base, does not. Sorted and without repeats, so the answer is the same each time. */
export function overlapOf(l: Landed): string[] {
  if (l.base === l.head) return [];
  const moved = new Set(l.landed);
  return [...new Set(l.mine.filter((f) => moved.has(f)))].sort();
}

export interface EndingAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly projectId: string;
  /** The agent principal (`agent:<id>`) the attempt belongs to. */
  readonly agentId: string;
  /** False once the attempt has ended or been stopped. */
  readonly live: boolean;
  /** Set when the attempt was stopped, by whom (`owner`, or `emergency`) and why. */
  readonly stopped?: { readonly by: "owner" | "emergency" | "other"; readonly reason: string };
  /** True when the worker was confirmed stopped (its handle stopped, or the host that held it confirmed the release) when the attempt was finished. Anything else, or absent: not confirmed, so its scratch is not removed. */
  readonly workerStopped?: boolean;
  /** Where the attempt ran and its generation, passed on to the host with a scratch order (the scratch location is unique to the attempt; see `ScratchOrder`). */
  readonly hostId?: string;
  readonly generation?: number;
}

export interface SettleReport {
  /** Calls that had to be killed (they did not end when told to), with whether each could have changed the checkout. */
  readonly killed: readonly { readonly callId: string; readonly write: boolean; readonly reason: string }[];
}

export interface WorkEndDeps {
  readonly attempts: {
    get(attemptId: string): Promise<EndingAttempt | undefined>;
    freeze(attemptId: string, reason: string): Promise<void>;
    /** Whether the worker of the finished attempt is confirmed stopped now (the host is asked to let go again). Used by the scratch cleanup's sweep. */
    confirmStopped?(attemptId: string): Promise<boolean>;
    /** Lets the calls settle and kills those that hang, with a reason. */
    settle(attemptId: string): Promise<SettleReport>;
    /** Ends the attempt with the agent's result; the task outcome is the submission's, not this call's. */
    /** `key` is stable per attempt (`workend:<attempt>:finished`): a repeat with it must be harmless. */
    /** `confirm` is asked once more right before the end; false means the ending was dropped in between and the attempt must not be ended (the answer is then `false`). */
    finish(attemptId: string, result: { readonly result: WorkEndResult; readonly note?: string; readonly submissionId?: string }, key: string, confirm?: () => Promise<boolean>): Promise<boolean | void>;
  };
  /** True while the task is paused, stopped or suspended (any gate on its chain): the ending is not asked for or completed then, and a stop drops it. Absent: nothing is known to be paused. */
  readonly paused?: (taskId: string) => Promise<boolean>;
  /** The files the agent changed against the base and what the landing branch changed since (only asked for a submit). `undefined`: the checkout is unknown, which refuses the submit. */
  readonly landing: (taskId: string) => Promise<Landed | undefined>;
  /** Stages the agent's tree and opens a submission for it; returns its id. Absent: a submit cannot be completed and ends plainly with a blocker. */
  readonly submit?: (attempt: EndingAttempt, base: string, key: string) => Promise<{ readonly submissionId: string }>;
  readonly blockers: Pick<BlockerService, "openBlocker">;
  /** Hands the message to the agent's supervisor or the task thread. Optional. */
  readonly tell?: (attempt: EndingAttempt, message: string, key: string) => Promise<void>;
  /**
   * The scratch cleanup (owner decision 2026-10-30): after the attempt is finished and what matters was handed onward, the controller-created scratch workspace may be removed (step `cleanup.scratch`). Absent: scratch is never touched.
   * `checkpointRecorded` says whether a complete checkpoint/continuation was recorded BY THIS ATTEMPT (taken while it ran: one from an earlier attempt of the task says nothing about this attempt's own work), which a failed or stopped attempt's successor continues from; absent means no (the scratch stays unless a submission carries the work).
   */
  readonly scratch?: { readonly cleanup: Pick<ScratchCleanupService, "run" | "begin">; readonly checkpointRecorded?: (attempt: ScratchAttempt) => Promise<boolean | string> };
}

export interface WorkEndRecord {
  readonly attemptId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly state: WorkEndState;
  readonly submit: boolean;
  readonly result: WorkEndResult;
  readonly note?: string;
  readonly message?: string;
  /** For a submit, the base and head seen when it was checked. */
  readonly base?: string;
  readonly head?: string;
  readonly requestedAt: string;
  readonly finishedAt?: string;
  /** What happened: `submitted`, `ended`, `dropped`. */
  readonly outcome?: "submitted" | "ended" | "dropped";
  readonly submissionId?: string;
  /** Typed reason a submit became a plain end or a stop dropped the intent. */
  readonly typed?: "release_failed" | "submit_unavailable" | "submit_refused" | "owner_stop" | "emergency_stop" | "attempt_ended";
  readonly blocker?: string;
  readonly summary?: string;
  /** True once the attempt was frozen (a replayed request retries the freeze while this is missing). */
  readonly frozen?: boolean;
  /** Who runs `complete`: the controller epoch and the service instance. One runner per intent; an older epoch's claim may be taken over. */
  readonly claim?: { readonly epoch: number; readonly instance: string };
  /** What `complete` has done, written as it happens so a crash resumes from the first undone step. */
  readonly steps?: WorkEndSteps;
}
export interface WorkEndSteps {
  readonly settled?: { /** Set when a write call had to be killed (the submit is not made). */ readonly summary?: string; readonly blocker?: string; /** How many write calls had to be killed (set whether or not a submit was asked for). */ readonly killedWrites?: number };
  readonly submitted?: { readonly submissionId?: string; readonly typed?: WorkEndRecord["typed"]; readonly summary?: string; readonly blocker?: string };
  readonly told?: true;
  readonly finished?: true;
  /** The scratch cleanup ran: removed, or kept (with why). Written after `finished`; the ending is not done before it. */
  readonly "cleanup.scratch"?: { readonly state: "removed" | "kept"; readonly why?: string };
}
export interface WorkEndAnswer extends WorkEndRecord { readonly replayed: boolean }

const json = (v: object): JsonObject => v as unknown as JsonObject;
const clean = <T>(v: object): T => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as T;
const idOf = (attemptId: string): string => `wend-${createHash("sha256").update(attemptId).digest("hex").slice(0, 32)}`;
const OPEN_STATES: readonly WorkEndState[] = ["requested", "ending"];
const INDEX = "work-end-open";
const SHARDS = 32;
const SCANNED_ID = "scanned";
const shardOf = (attemptId: string): string => `s${createHash("sha256").update(attemptId).digest().readUInt16BE(0) % SHARDS}`;
/** At most this many open endings are completed in one `recover` (the rest wait for the next tick). */
const RECOVER_PER_TICK = 50;
interface OpenIndex { readonly attempts: readonly string[]; /** True once the records written before the index existed were scanned in. */ readonly scanned?: boolean }

/** Thrown inside `complete` when the intent was dropped before a side effect; carries the dropped record. */
class Stopped extends Error { constructor(readonly rec: { body: WorkEndRecord; revision: number }) { super("dropped"); } }
type Rec = { body: WorkEndRecord; revision: number };
const stepKey = (attemptId: string, step: string): string => `workend:${attemptId}:${step}`;
const busy = (): DomainError => new DomainError("unavailable", "busy: another instance is completing this ending; try again");

/** A dropped record keeps what really happened: a submission opened before the drop is named. */
function annotateDropped(b: WorkEndRecord): WorkEndRecord {
  const sid = b.steps?.submitted?.submissionId;
  if (b.state !== "dropped" || sid === undefined || b.submissionId === sid) return b;
  return { ...b, submissionId: sid, summary: `${b.summary ?? "dropped"}; a submission (${sid}) had already been opened before the drop`.slice(0, 500) };
}

export class WorkEndService {
  readonly #runner: CommandRunner;
  readonly #deps: WorkEndDeps;
  readonly #epoch: number;
  readonly #instance = randomUUID();
  /** Endings being completed in this process: a second `complete` for the same attempt waits for the first's answer. */
  #rotation = 0;
  readonly #running = new Map<string, Promise<WorkEndAnswer>>();
  private constructor(runner: CommandRunner, deps: WorkEndDeps, epoch: number) { this.#runner = runner; this.#deps = deps; this.#epoch = epoch; }
  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, deps: WorkEndDeps, options: RunnerOptions = {}): WorkEndService {
    return new WorkEndService(new CommandRunner(storage, epoch, options), deps, epoch);
  }

  /** The agent's call. Checked now; answers with the recorded intent (state `requested`). Only the attempt's own agent may end it. */
  async request(by: Principal, command: NoActor & { attemptId: string; submit?: boolean; result?: string; note?: string; message?: string }): Promise<WorkEndAnswer> {
    onlyKnown(command, ["commandId", "attemptId", "submit", "result", "note", "message"]);
    const attemptId = text(command.attemptId, "attemptId", { min: 1, max: 200 });
    const submit = command.submit === undefined ? false : command.submit === true || command.submit === false ? command.submit : invalid("submit", "must be true or false");
    const result = (command.result === undefined ? "done" : (WORK_END_RESULTS as readonly string[]).includes(command.result) ? command.result : invalid("result", `must be one of ${WORK_END_RESULTS.join(", ")}`)) as WorkEndResult;
    const note = command.note === undefined ? undefined : text(command.note, "note", { min: 1, max: WORK_END_LIMITS.note, multiline: true });
    const message = command.message === undefined ? undefined : text(command.message, "message", { min: 1, max: WORK_END_LIMITS.message, multiline: true });
    for (const [name, v] of [["note", note], ["message", message]] as const) if (v !== undefined && redactText(v) !== v) invalid(name, "looks like a credential or key; those are not recorded");
    if (by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not end an attempt`);
    const attempt = await this.#deps.attempts.get(attemptId);
    // The same answer for an unknown attempt and another agent's.
    if (attempt === undefined || attempt.agentId !== by.id) throw new DomainError("not_found", `attempt ${attemptId} does not exist or is not yours`);
    // A credential scoped to one task cannot end the same agent's attempt on another (the same answer as an attempt that is not yours).
    if (by.taskScope !== undefined && by.taskScope.taskId !== attempt.taskId) throw new DomainError("not_found", `attempt ${attemptId} does not exist or is not yours`);
    const id = idOf(attemptId);
    // A repeat finds the one ending (whatever its command ID), if it asks for the same thing.
    const existing = await this.#get(id);
    if (existing !== undefined) {
      const b = existing.body;
      if (b.submit !== submit || b.result !== result || b.note !== note || b.message !== message) {
        throw new DomainError("command_conflict", `attempt ${attemptId} already has an ending request with different submit/result/note/message`);
      }
      // The freeze is retried while the intent is still only requested and the freeze never completed.
      if (b.state === "requested" && b.frozen !== true && attempt.live) {
        if (await this.#freeze(attemptId)) return { ...(await this.#mutate(attemptId, "workend.frozen", (x) => ({ ...x, frozen: true }))).body, replayed: true };
      }
      return { ...b, replayed: true };
    }
    if (!attempt.live || attempt.stopped !== undefined) throw new DomainError("invalid_transition", `attempt ${attemptId} is no longer running`);
    if (await this.#deps.paused?.(attempt.taskId)) throw new DomainError("unavailable", `the task of attempt ${attemptId} is paused, stopped or suspended; it cannot be ended by the agent now`);

    let base: string | undefined; let head: string | undefined;
    if (submit) {
      const l = await this.#deps.landing(attempt.taskId);
      if (l === undefined) throw new DomainError("unavailable", "the checkout's base is not known, so a submit cannot be checked; end without submitting or try again");
      const overlapping = overlapOf(l);
      if (overlapping.length > 0) throw new SubmitRefused(l.head, overlapping);
      base = l.base; head = l.head;
    }
    const body: WorkEndRecord = clean({ attemptId, taskId: attempt.taskId, projectId: attempt.projectId, agentId: attempt.agentId, state: "requested" as const, submit, result, note, message, base, head, requestedAt: this.#runner.now() });
    const scoped = scopedCommandId(by.id, command.commandId);
    // Indexed first: a crash between the two leaves an index entry without an intent (skipped), never an intent no sweep knows of.
    await this.#index(attemptId, undefined);
    try { await this.#create(by.id, scoped, id, body); } catch (error) {
      // Two requests at once: the loser reads the winner's.
      const won = await this.#get(id);
      if (won === undefined) throw error;
      return { ...won.body, replayed: true };
    }
    // The freeze is written after the intent, so a crash between them leaves an intent that `recover` completes, never a freeze nothing knows of.
    if (await this.#freeze(attemptId)) await this.#mutate(attemptId, "workend.frozen", (x) => ({ ...x, frozen: true }));
    return { ...body, replayed: false };
  }

  /** True when the attempt was frozen; false when it does not exist (nothing to freeze). */
  async #freeze(attemptId: string): Promise<boolean> {
    try { await this.#deps.attempts.freeze(attemptId, "ending: the agent called work.end"); return true; } catch (error) {
      if (error instanceof DomainError && error.code === "not_found") return false;
      throw error;
    }
  }

  /** Completes the ending once. A finished or dropped one is returned as it is. A second instance gets the first's outcome once it is closed, else a retryable `busy`. */
  async complete(attemptId: string): Promise<WorkEndAnswer> {
    const running = this.#running.get(attemptId);
    if (running !== undefined) return running;
    const p = this.#complete(attemptId).finally(() => this.#running.delete(attemptId));
    this.#running.set(attemptId, p);
    return p;
  }

  async #complete(attemptId: string): Promise<WorkEndAnswer> {
    const id = idOf(attemptId);
    const found = await this.#get(id);
    if (found === undefined) throw new DomainError("not_found", `attempt ${attemptId} has no ending`);
    if (!OPEN_STATES.includes(found.body.state)) return { ...found.body, replayed: true };
    try { return await this.#run(attemptId, await this.#claim(found)); } catch (error) {
      if (error instanceof Stopped) return { ...error.rec.body, replayed: false };
      throw error;
    }
  }

  /** Writes this instance's claim (with the revision the read saw, so only one writer wins). Another live claim is `busy`; a closed intent is returned as it is. */
  async #claim(first: Rec): Promise<Rec> {
    let rec = first;
    for (let n = 0; n < 5; n++) {
      if (!OPEN_STATES.includes(rec.body.state)) return rec;
      const c = rec.body.claim;
      if (c !== undefined && c.instance === this.#instance && rec.body.state === "ending") return rec;
      if (c !== undefined && c.instance !== this.#instance && c.epoch >= this.#epoch) throw busy();
      try { return await this.#write(rec, { ...rec.body, state: "ending", claim: { epoch: this.#epoch, instance: this.#instance } }, "workend.claim"); } catch (error) {
        if (!(error instanceof DomainError && error.code === "stale_revision")) throw error;
        const again = await this.#get(idOf(rec.body.attemptId));
        if (again === undefined) throw error;
        rec = again;
      }
    }
    throw busy();
  }

  async #run(attemptId: string, claimed: Rec): Promise<WorkEndAnswer> {
    if (!OPEN_STATES.includes(claimed.body.state)) return { ...claimed.body, replayed: true };
    let body = claimed.body;
    const attempt = await this.#deps.attempts.get(attemptId);
    const started = body.steps?.settled !== undefined;
    // A recorded `finished` wins even though the attempt is no longer live (the crash came after finish): record done with what was stored.
    if (body.steps?.finished !== true) {
      // The owner's stop wins over the agent's ending; an emergency stop drops it. Nothing more is staged or submitted.
      if (attempt === undefined || attempt.stopped !== undefined || (!attempt.live && !started)) {
        // The true reason: an owner's (or emergency) stop only when the attempt was stopped; otherwise the attempt ended by itself before the ending could be completed.
        const by = attempt?.stopped?.by;
        return this.#drop(attemptId, by === "emergency" ? "emergency_stop" : by === "owner" ? "owner_stop" : "attempt_ended", attempt?.stopped?.reason ?? "the attempt ended before the ending was completed");
      }
      // A task that is paused, stopped or suspended makes no progress on the agent's ending; a stop drops it (begin), a plain pause leaves it for after the resume.
      if (attempt !== undefined && await this.#deps.paused?.(attempt.taskId)) return { ...body, replayed: false };
    }
    const step = (name: keyof WorkEndSteps, v: WorkEndSteps[typeof name]) => this.#mutate(attemptId, `workend.${name}`, (b) => ({ ...b, steps: { ...b.steps, [name]: v } }));
    // settled
    if (body.steps?.settled === undefined) {
      // The attempt finished meanwhile (its turn ended, a stop): nothing is in flight any more, so the settle is as good as done.
      const settled = await this.#deps.attempts.settle(attemptId).catch((error: unknown) => { if (error instanceof DomainError && error.code === "not_found") return { killed: [] } as SettleReport; throw error; });
      const wrote = settled.killed.filter((k) => k.write);
      let value: NonNullable<WorkEndSteps["settled"]> = wrote.length > 0 ? { killedWrites: wrote.length } : {};
      if (body.submit && wrote.length > 0) {
        const summary = `release_failed: ${wrote.length} write call(s) had to be killed (${wrote.map((k) => `${k.callId}: ${k.reason}`).join("; ").slice(0, 300)}); the work was not submitted`;
        value = clean({ summary, killedWrites: wrote.length, blocker: await this.#blocker(body, `${attemptId}:release_failed:settle`, summary) });
      }
      body = (await step("settled", value)).body;
    }
    // submitted
    if (body.submit && body.steps?.settled?.summary === undefined && body.steps?.submitted === undefined && attempt !== undefined) {
      await this.#guard(attemptId);
      let value: NonNullable<WorkEndSteps["submitted"]>;
      // The landing branch may have moved while the calls settled: the overlap is checked again before anything is staged.
      const l = await this.#deps.landing(attempt.taskId).catch(() => undefined);
      const overlap = l === undefined ? [] : overlapOf(l);
      if (l === undefined || overlap.length > 0) {
        const summary = l === undefined
          ? "submit_refused: the checkout's base could not be checked again after the calls settled; the attempt ended without a submission"
          : `submit_refused: the landing branch moved to ${l.head} and changed ${overlap.length} of your files (${overlap.slice(0, 10).join(", ")}) while the ending was settling; the attempt ended without a submission`;
        value = clean({ typed: "submit_refused" as const, summary, blocker: await this.#blocker(body, `${attemptId}:submit_refused`, summary) });
      } else if (this.#deps.submit === undefined) {
        const summary = "submit_unavailable: this controller cannot stage and open a submission yet; the attempt ended without one";
        value = clean({ typed: "submit_unavailable" as const, summary, blocker: await this.#blocker(body, `${attemptId}:submit_unavailable`, summary) });
      } else {
        try { value = { submissionId: (await this.#deps.submit(attempt, body.base!, stepKey(attemptId, "submitted"))).submissionId }; } catch (error) {
          const summary = `release_failed: staging or opening the submission failed (${redactText(String((error as Error)?.message ?? error)).slice(0, 300)}); the attempt ended without one`;
          value = clean({ typed: "release_failed" as const, summary, blocker: await this.#blocker(body, `${attemptId}:release_failed:submit`, summary) });
        }
      }
      body = (await step("submitted", value)).body;
    }
    // told
    if (body.message !== undefined && body.steps?.told !== true && attempt !== undefined) {
      await this.#guard(attemptId);
      await this.#deps.tell?.(attempt, body.message, stepKey(attemptId, "told")).catch(() => undefined);
      body = (await step("told", true)).body;
    }
    // finished
    if (body.steps?.finished !== true) {
      await this.#guard(attemptId);
      // Conditional: a drop that lands between the guard and the end is seen by the dispatcher right before it ends the attempt.
      const confirm = async (): Promise<boolean> => { const r = await this.#get(idOf(attemptId)); return r !== undefined && r.body.state !== "dropped" && r.body.claim?.instance === this.#instance; };
      const ended = await this.#deps.attempts.finish(attemptId, clean({ result: body.result, note: body.note, submissionId: body.steps?.submitted?.submissionId }), stepKey(attemptId, "finished"), confirm);
      if (ended === false) { await this.#guard(attemptId); throw busy(); }
      body = (await step("finished", true)).body;
    }
    // cleanup.scratch: only after the attempt is finished, and then only when what matters was handed onward (see `#missing`). A drop that landed meanwhile is respected before the order goes out.
    if (this.#deps.scratch !== undefined && body.steps?.["cleanup.scratch"] === undefined) {
      await this.#guard(attemptId);
      // The cleanup exists (listed, open) before anything that can fail is read, so the sweep can always finish it.
      await this.#deps.scratch.cleanup.begin(attemptId);
      const now = await this.#deps.attempts.get(attemptId);
      const scratchAttempt: ScratchAttempt = { attemptId, taskId: body.taskId, projectId: body.projectId, agentId: body.agentId, ...(now?.hostId === undefined ? {} : { hostId: now.hostId }), ...(now?.generation === undefined ? {} : { generation: now.generation }) };
      const dropped = async (): Promise<string | undefined> => this.droppedReason(attemptId);
      const m = await this.#missing(body, scratchAttempt, now);
      const ran = await this.#deps.scratch.cleanup.run(scratchAttempt, m.missing, dropped, { workerStopped: m.workerStopped });
      body = (await step("cleanup.scratch", { state: ran.state === "removed" ? "removed" : "kept", ...(ran.why === undefined ? {} : { why: ran.why }) })).body;
    }
    const written = await this.#mutate(attemptId, "workend.finish", (b) => {
      if (b.state === "dropped") return b;
      const s = b.steps;
      const typed = s?.settled?.summary !== undefined ? "release_failed" as const : s?.submitted?.typed;
      const submissionId = s?.submitted?.submissionId;
      return clean<WorkEndRecord>({ ...b, state: "done" as const, outcome: submissionId !== undefined ? "submitted" as const : "ended" as const, submissionId, typed, blocker: s?.settled?.summary !== undefined ? s.settled.blocker : s?.submitted?.blocker, summary: s?.settled?.summary ?? s?.submitted?.summary, finishedAt: this.#runner.now() });
    });
    return { ...written.body, replayed: false };
  }

  /**
   * What is not yet handed onward (empty: all of it is): the worker must be confirmed stopped, no write call may have been killed, the product (a submission, or else a checkpoint recorded by this attempt) and the message must be done.
   * `finished` is false for an attempt that ended another way, where the attempt's own ending steps are not the measure.
   */
  async #missing(b: WorkEndRecord | undefined, attempt: ScratchAttempt, now: EndingAttempt | undefined): Promise<{ missing: string[]; workerStopped: boolean }> {
    const s = b?.steps, out: string[] = [];
    if (s?.settled?.summary !== undefined || (s?.settled?.killedWrites ?? 0) > 0) out.push("a write call had to be killed");
    if (b?.submit === true && s?.submitted?.submissionId === undefined) out.push("no submission was opened");
    if (s?.submitted?.submissionId === undefined) {
      const c = await this.#deps.scratch?.checkpointRecorded?.(attempt).catch(() => false);
      if (c !== true) out.push(typeof c === "string" ? c : "no checkpoint is recorded");
    }
    if (b?.message !== undefined && s?.told !== true) out.push("the message was not passed on");
    return { missing: out, workerStopped: now?.workerStopped === true };
  }

  /** A reason to keep scratch when the attempt's ending was dropped (checked right before an order goes out, by the completed path and by the sweep). */
  async droppedReason(attemptId: string): Promise<string | undefined> {
    return (await this.#get(idOf(attemptId)))?.body.state === "dropped" ? "the ending was dropped before the order went out" : undefined;
  }

  /**
   * The scratch decision for an attempt that ended some other way than through its own completed ending, worked out from what is recorded now: the attempt, what is missing, whether the worker is confirmed stopped. `undefined`: the ending is still open
   * (the completed path cleans up after it) or the cleanup is already done.
   */
  async scratchDecision(attemptId: string): Promise<{ attempt: ScratchAttempt; missing: string[]; workerStopped: boolean } | undefined> {
    const rec = await this.#get(idOf(attemptId));
    const attempt = await this.#deps.attempts.get(attemptId);
    const a: ScratchAttempt | undefined = attempt !== undefined ? { attemptId, taskId: attempt.taskId, projectId: attempt.projectId, agentId: attempt.agentId, ...(attempt.hostId === undefined ? {} : { hostId: attempt.hostId }), ...(attempt.generation === undefined ? {} : { generation: attempt.generation }) } : rec === undefined ? undefined : { attemptId, taskId: rec.body.taskId, projectId: rec.body.projectId, agentId: rec.body.agentId };
    if (a === undefined) return undefined;
    // An ending of this attempt still open is the completed path's to clean up (after it finished); a done one has done so.
    if (rec !== undefined && OPEN_STATES.includes(rec.body.state)) return undefined;
    if (rec?.body.state === "done" && rec.body.steps?.["cleanup.scratch"] !== undefined) return undefined;
    const m = await this.#missing(rec?.body, a, attempt);
    return { attempt: a, ...m };
  }

  /**
   * An attempt ended some other way than through its own completed ending (a failure, a stop, a turn that ended, an ending dropped): the scratch is removed only under the same conditions as after a completed ending (see `#missing`): a checkpoint of
   * this attempt is recorded so the next attempt can continue from it, no write call was killed, any message was passed on, and the worker is confirmed stopped (else the cleanup waits for the sweep to confirm it).
   * The cleanup record exists before anything is read. Never throws into the caller (the sweep finishes what is left open); `signal` is the dispatcher's cut-off: once aborted nothing more is started.
   */
  async cleanupAfterEnd(attemptId: string, signal?: AbortSignal): Promise<void> {
    const sc = this.#deps.scratch;
    if (sc === undefined) return;
    try {
      await sc.cleanup.begin(attemptId);
      const d = await this.scratchDecision(attemptId);
      if (d === undefined) return;
      const cutOff = (): never => { throw new DomainError("unavailable", "the cleanup was cut off (timeout); the sweep finishes it"); };
      if (signal?.aborted === true) cutOff();
      await sc.cleanup.run(d.attempt, d.missing, async () => { if (signal?.aborted === true) cutOff(); return undefined; }, { workerStopped: d.workerStopped, ...(signal === undefined ? {} : { signal }) });
    } catch { /* kept; the sweep tries again for what is left open */ }
  }

  /** Before a side effect: the intent is re-read; a dropped one aborts the run, another instance's claim is `busy`. */
  async #guard(attemptId: string): Promise<void> {
    const rec = await this.#get(idOf(attemptId));
    if (rec === undefined) throw new DomainError("not_found", `attempt ${attemptId} has no ending`);
    if (rec.body.state === "dropped") throw new Stopped(rec);
    if (rec.body.claim?.instance !== this.#instance) throw busy();
  }

  /** An emergency stop: the intent is dropped at once, nothing else is done. A finished ending is left as it is. */
  async drop(attemptId: string, why: "emergency_stop" | "owner_stop" = "emergency_stop", reason = "stopped"): Promise<WorkEndAnswer | undefined> {
    const found = await this.#get(idOf(attemptId));
    if (found === undefined) return undefined;
    if (!OPEN_STATES.includes(found.body.state)) return { ...found.body, replayed: true };
    return this.#drop(attemptId, why, reason);
  }

  /**
   * The endings still open are completed once each, from the first undone step: after a restart, and by the sweep every tick. Only the open ones are looked at (an index of them, like the pause times of L06b; the records written before it are scanned in once), at most
   * `RECOVER_PER_TICK` per call. One that fails does not stop the others: the rest are completed and the failures are reported together at the end. One another instance is running is skipped.
   */
  async recover(): Promise<WorkEndAnswer[]> {
    await this.#backfill();
    const out: WorkEndAnswer[] = [];
    const failed: string[] = [];
    const gone: string[] = [];
    const open = await this.#openList();
    // Only endings completed or failed count against the cap; paused or busy ones are passed over, and the start rotates so they cannot starve the rest.
    let handled = 0;
    const start = open.length === 0 ? 0 : this.#rotation % open.length;
    let seen = 0;
    for (; seen < open.length && handled < RECOVER_PER_TICK; seen++) {
      const attemptId = open[(start + seen) % open.length]!;
      const b = (await this.#get(idOf(attemptId)))?.body;
      if (b === undefined || !OPEN_STATES.includes(b.state)) { gone.push(attemptId); continue; }
      try {
        const answer = await this.complete(attemptId);
        out.push(answer);
        if (!OPEN_STATES.includes(answer.state)) handled++;
      } catch (error) {
        if (error instanceof DomainError && error.code === "unavailable" && /^busy/.test(error.message)) continue;
        handled++;
        failed.push(`${attemptId}: ${redactText(String((error as Error)?.message ?? error)).slice(0, 150)}`);
      }
    }
    this.#rotation = open.length === 0 ? 0 : (start + seen) % open.length;
    if (gone.length > 0) await this.#index(undefined, gone);
    if (failed.length > 0) throw new DomainError("unavailable", `${failed.length} ending(s) could not be completed (${out.length} were): ${failed.slice(0, 5).join("; ")}`);
    return out;
  }

  /** The records written before the index existed: scanned in once. */
  async #backfill(): Promise<void> {
    if (((await this.#runner.get(INDEX, SCANNED_ID))?.body as unknown as OpenIndex | undefined)?.scanned === true) return;
    const found: string[] = [];
    for (let after: string | undefined;;) {
      const page = await this.#runner.list(RECORD, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const a of page) { after = a.id; const b = a.body as unknown as WorkEndRecord; if (OPEN_STATES.includes(b.state)) found.push(b.attemptId); }
      if (page.length < 100) break;
    }
    await this.#index(undefined, undefined, found, true);
  }

  /** Adds and removes attempts in the index of open endings. The index is split in shards by attempt, so concurrent `work.end` calls rarely write the same document (each shard is re-read and written again when it moved, with a jittered wait). */
  async #index(add: string | undefined, remove: readonly string[] | undefined, addMany: readonly string[] = [], scanned = false): Promise<void> {
    const byShard = new Map<string, { add: Set<string>; remove: Set<string> }>();
    const slot = (a: string) => { const id = shardOf(a); let e = byShard.get(id); if (e === undefined) { e = { add: new Set(), remove: new Set() }; byShard.set(id, e); } return e; };
    if (add !== undefined) slot(add).add.add(add);
    for (const a of addMany) slot(a).add.add(a);
    for (const r of remove ?? []) slot(r).remove.add(r);
    for (const [id, e] of byShard) {
      await this.#shardWrite(id, (cur) => {
        const set = new Set(cur?.attempts ?? []);
        for (const a of e.add) set.add(a);
        for (const r of e.remove) set.delete(r);
        return { attempts: [...set].sort() };
      });
    }
    if (scanned) await this.#shardWrite(SCANNED_ID, () => ({ attempts: [], scanned: true }));
  }

  async #shardWrite(id: string, fn: (cur: OpenIndex | undefined) => OpenIndex): Promise<void> {
    for (let n = 0; n < 24; n++) {
      const rec = await this.#runner.get(INDEX, id);
      const cur = rec?.body as unknown as OpenIndex | undefined;
      const next = fn(cur);
      if (cur !== undefined && JSON.stringify(cur) === JSON.stringify(next)) return;
      const ref: AggregateRef = { kind: INDEX, id };
      const digest = createHash("sha256").update(JSON.stringify(next)).digest("hex").slice(0, 16);
      try {
        await this.#runner.command("workend.index", { commandId: `wend-idx:${id}:${rec?.revision ?? 0}:${digest}`, actor: "controller" }, async () => ({
          payload: { revision: rec?.revision ?? 0 },
          build: async () => ({ ref, creates: rec === undefined, changes: [rec === undefined ? { type: "create" as const, ref, body: json(next) } : { type: "update" as const, ref, expectedRevision: rec.revision, body: json(next) }], detail: {}, contention: async () => new DomainError("stale_revision", "the index changed at the same moment") }),
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict"))) throw error;
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5 * (n + 1))));
      }
    }
    throw new DomainError("stale_revision", "the index of open endings kept changing");
  }

  async #openList(): Promise<string[]> {
    const all: string[] = [];
    for (let i = 0; i < SHARDS; i++) all.push(...(((await this.#runner.get(INDEX, `s${i}`))?.body as unknown as OpenIndex | undefined)?.attempts ?? []));
    return all.sort();
  }

  /**
   * The dispatcher is about to end the attempt for its own reason (the turn completed, a stop, a lost worker). An ending the agent asked for is not lost: a stop drops it with its true reason; the turn completing after `work.end` completes it (settle, submit, tell,
   * and the attempt ends with the agent's result, which is what `handled` says); any other end drops it as `attempt_ended`, after the tell, with the agent's request written into the end's summary.
   */
  async resolveOnEnd(attemptId: string, how: { readonly outcome: "succeeded" | "failed" | "abandoned"; readonly summary: string; readonly stopped?: { readonly by: "owner" | "emergency"; readonly reason: string } }): Promise<{ readonly handled?: true; readonly summary?: string; readonly outcome?: "succeeded" | "failed" | "abandoned"; readonly partial?: true } | undefined> {
    const found = await this.#get(idOf(attemptId));
    if (found === undefined || !OPEN_STATES.includes(found.body.state)) return undefined;
    if (how.stopped !== undefined) { await this.#drop(attemptId, how.stopped.by === "emergency" ? "emergency_stop" : "owner_stop", how.stopped.reason); return undefined; }
    let override: "succeeded" | "abandoned" | undefined;
    if (how.outcome === "succeeded") {
      let incomplete = false;
      try { const answer = await this.complete(attemptId); if (answer.state === "done") return { handled: true }; incomplete = true; } catch (error) {
        if (!(error instanceof DomainError && error.code === "unavailable")) throw error;
        incomplete = true;
      }
      // The ending could not be completed now (the task is paused, another instance is busy): a plain `done` leaves it for later and the turn's own end stands; any other result is not lost, the end carries it.
      if (incomplete && found.body.result === "done") return undefined;
      override = found.body.result === "partial" ? "succeeded" : "abandoned";
    }
    const b = found.body;
    const attempt = await this.#deps.attempts.get(attemptId);
    if (b.message !== undefined && b.steps?.told !== true && attempt !== undefined) await this.#deps.tell?.(attempt, b.message, stepKey(attemptId, "told")).catch(() => undefined);
    const asked = `the agent had asked to end it: ${b.result}${b.note === undefined ? "" : `: ${b.note}`}`;
    await this.#drop(attemptId, "attempt_ended", `the attempt ended first (${how.summary}); ${asked}`.slice(0, 300));
    return { summary: `${how.summary}; ${asked}`.slice(0, 1000), ...(override === undefined ? {} : { outcome: override }), ...(override === "succeeded" ? { partial: true as const } : {}) };
  }

  async get(attemptId: string): Promise<WorkEndAnswer | undefined> {
    const f = await this.#get(idOf(attemptId));
    return f === undefined ? undefined : { ...f.body, replayed: false };
  }

  async #drop(attemptId: string, typed: "owner_stop" | "emergency_stop" | "attempt_ended", reason: string): Promise<WorkEndAnswer> {
    const written = await this.#mutate(attemptId, "workend.drop", (b) => !OPEN_STATES.includes(b.state) ? b : clean<WorkEndRecord>({ ...b, state: "dropped" as const, outcome: "dropped" as const, typed, summary: redactText(reason).slice(0, 300), finishedAt: this.#runner.now() }));
    return { ...written.body, replayed: false };
  }

  async #blocker(body: WorkEndRecord, key: string, summary: string): Promise<string | undefined> {
    try {
      return (await this.#deps.blockers.openBlocker({ commandId: `work-end-blk:${key}`, actor: "controller", type: "runtime_hold", subject: { kind: "task", id: body.taskId }, summary: summary.slice(0, 500), resolver: "owner" })).id;
    } catch { return undefined; }
  }

  async #get(id: string): Promise<Rec | undefined> {
    const f: Aggregate | undefined = await this.#runner.get(RECORD, id);
    return f === undefined ? undefined : { body: f.body as unknown as WorkEndRecord, revision: f.revision };
  }

  /** One revision-checked write (a stale revision throws); answers with what is stored. The command ID carries the revision, so each write is its own command. */
  async #write(rec: Rec, body: WorkEndRecord, type: string): Promise<Rec> {
    const id = idOf(rec.body.attemptId);
    const ref: AggregateRef = { kind: RECORD, id };
    await this.#runner.command(type, { commandId: `${id}:${type}:r${rec.revision}`, actor: "controller" }, async () => ({
      payload: { revision: rec.revision },
      build: async () => ({ ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: rec.revision, body: json(body) }], detail: { taskId: body.taskId }, contention: async () => new DomainError("stale_revision", "the ending changed at the same moment") }),
    }));
    return (await this.#get(id)) ?? { body, revision: rec.revision + 1 };
  }

  /** Re-reads, applies `fn` and writes, again when the record moved. A dropped record keeps the drop and gains what really happened. */
  async #mutate(attemptId: string, type: string, fn: (b: WorkEndRecord) => WorkEndRecord): Promise<Rec> {
    const id = idOf(attemptId);
    for (let n = 0; n < 8; n++) {
      const rec = await this.#get(id);
      if (rec === undefined) throw new DomainError("not_found", `attempt ${attemptId} has no ending`);
      const next = annotateDropped(fn(rec.body));
      if (next === rec.body) return rec;
      try { return await this.#write(rec, next, type); } catch (error) {
        if (!(error instanceof DomainError && error.code === "stale_revision")) throw error;
      }
    }
    throw new DomainError("stale_revision", "the ending kept changing");
  }

  async #create(actor: string, commandId: string, id: string, body: WorkEndRecord): Promise<void> {
    const ref: AggregateRef = { kind: RECORD, id };
    await this.#runner.command("workend.request", { commandId, actor }, async () => ({
      payload: { attemptId: body.attemptId, submit: body.submit, result: body.result },
      build: async () => ({ ref, creates: true, changes: [{ type: "create" as const, ref, body: json(body) }], detail: { taskId: body.taskId }, contention: async () => new DomainError("stale_revision", "the ending changed at the same moment") }),
    }));
  }
}

function invalid(field: string, message: string): never { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); }

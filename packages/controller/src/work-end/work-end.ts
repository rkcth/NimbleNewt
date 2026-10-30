import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { BlockerService } from "../domain/blockers.js";
import { onlyKnown, text } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Aggregate, AggregateRef, JsonObject } from "../storage/types.js";

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
}

export interface SettleReport {
  /** Calls that had to be killed (they did not end when told to), with whether each could have changed the checkout. */
  readonly killed: readonly { readonly callId: string; readonly write: boolean; readonly reason: string }[];
}

export interface WorkEndDeps {
  readonly attempts: {
    get(attemptId: string): Promise<EndingAttempt | undefined>;
    freeze(attemptId: string, reason: string): Promise<void>;
    /** Lets the calls settle and kills those that hang, with a reason. */
    settle(attemptId: string): Promise<SettleReport>;
    /** Ends the attempt with the agent's result; the task outcome is the submission's, not this call's. */
    finish(attemptId: string, result: { readonly result: WorkEndResult; readonly note?: string; readonly submissionId?: string }): Promise<void>;
  };
  /** The files the agent changed against the base and what the landing branch changed since (only asked for a submit). `undefined`: the checkout is unknown, which refuses the submit. */
  readonly landing: (taskId: string) => Promise<Landed | undefined>;
  /** Stages the agent's tree and opens a submission for it; returns its id. Absent: a submit cannot be completed and ends plainly with a blocker. */
  readonly submit?: (attempt: EndingAttempt, base: string) => Promise<{ readonly submissionId: string }>;
  readonly blockers: Pick<BlockerService, "openBlocker">;
  /** Hands the message to the agent's supervisor or the task thread. Optional. */
  readonly tell?: (attempt: EndingAttempt, message: string) => Promise<void>;
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
  readonly typed?: "release_failed" | "submit_unavailable" | "owner_stop" | "emergency_stop";
  readonly blocker?: string;
  readonly summary?: string;
}
export interface WorkEndAnswer extends WorkEndRecord { readonly replayed: boolean }

const json = (v: object): JsonObject => v as unknown as JsonObject;
const clean = <T>(v: object): T => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as T;
const idOf = (attemptId: string): string => `wend-${createHash("sha256").update(attemptId).digest("hex").slice(0, 32)}`;
const OPEN_STATES: readonly WorkEndState[] = ["requested", "ending"];

export class WorkEndService {
  readonly #runner: CommandRunner;
  readonly #deps: WorkEndDeps;
  /** Endings being completed in this process (one controller holds the epoch): a second `complete` for the same attempt waits for the first's answer. */
  readonly #running = new Map<string, Promise<WorkEndAnswer>>();
  private constructor(runner: CommandRunner, deps: WorkEndDeps) { this.#runner = runner; this.#deps = deps; }
  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, deps: WorkEndDeps, options: RunnerOptions = {}): WorkEndService {
    return new WorkEndService(new CommandRunner(storage, epoch, options), deps);
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
    const id = idOf(attemptId);
    // A repeat finds the one ending (whatever its command ID).
    const existing = await this.#get(id);
    if (existing !== undefined) return { ...existing.body, replayed: true };
    if (!attempt.live) throw new DomainError("invalid_transition", `attempt ${attemptId} is no longer running`);

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
    try { await this.#create(by.id, scoped, id, body); } catch (error) {
      // Two requests at once: the loser reads the winner's.
      const won = await this.#get(id);
      if (won === undefined) throw error;
      return { ...won.body, replayed: true };
    }
    // The freeze is written after the intent, so a crash between them leaves an intent that `recover` completes, never a freeze nothing knows of.
    await this.#deps.attempts.freeze(attemptId, "ending: the agent called work.end").catch((error: unknown) => { if (!(error instanceof DomainError && error.code === "not_found")) throw error; });
    return { ...body, replayed: false };
  }

  /** Completes the ending once. A finished or dropped one is returned as it is. */
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
    const attempt = await this.#deps.attempts.get(attemptId);
    // The owner's stop wins over the agent's ending; an emergency stop drops it. Nothing is staged or submitted.
    if (attempt === undefined || !attempt.live || attempt.stopped !== undefined) {
      const by = attempt?.stopped?.by;
      return this.#drop(found, by === "emergency" ? "emergency_stop" : "owner_stop", attempt?.stopped?.reason ?? "the attempt ended before the ending was completed");
    }
    let rec = found;
    if (rec.body.state === "requested") rec = await this.#set(rec, { ...rec.body, state: "ending" }, "workend.begin");
    let submit = rec.body.submit; let typed: WorkEndRecord["typed"]; let blocker: string | undefined; let summary: string | undefined;
    const settled = await this.#deps.attempts.settle(attemptId);
    const wrote = settled.killed.filter((k) => k.write);
    if (submit && wrote.length > 0) {
      submit = false; typed = "release_failed";
      summary = `release_failed: ${wrote.length} write call(s) had to be killed (${wrote.map((k) => `${k.callId}: ${k.reason}`).join("; ").slice(0, 300)}); the work was not submitted`;
      blocker = await this.#blocker(rec.body, `${attemptId}:release_failed`, summary);
    }
    let submissionId: string | undefined;
    if (submit) {
      if (this.#deps.submit === undefined) {
        submit = false; typed = "submit_unavailable";
        summary = "submit_unavailable: this controller cannot stage and open a submission yet; the attempt ended without one";
        blocker = await this.#blocker(rec.body, `${attemptId}:submit_unavailable`, summary);
      } else {
        try { submissionId = (await this.#deps.submit(attempt, rec.body.base!)).submissionId; } catch (error) {
          submit = false; typed = "release_failed";
          summary = `release_failed: staging or opening the submission failed (${redactText(String((error as Error)?.message ?? error)).slice(0, 300)}); the attempt ended without one`;
          blocker = await this.#blocker(rec.body, `${attemptId}:release_failed`, summary);
        }
      }
    }
    if (rec.body.message !== undefined) await this.#deps.tell?.(attempt, rec.body.message).catch(() => undefined);
    await this.#deps.attempts.finish(attemptId, clean({ result: rec.body.result, note: rec.body.note, submissionId }));
    const done: WorkEndRecord = clean({ ...rec.body, state: "done" as const, outcome: submit ? "submitted" as const : "ended" as const, submissionId, typed, blocker, summary, finishedAt: this.#runner.now() });
    const written = await this.#set(rec, done, "workend.finish");
    return { ...written.body, replayed: false };
  }

  /** An emergency stop: the intent is dropped at once, nothing else is done. A finished ending is left as it is. */
  async drop(attemptId: string, why: "emergency_stop" | "owner_stop" = "emergency_stop", reason = "stopped"): Promise<WorkEndAnswer | undefined> {
    const found = await this.#get(idOf(attemptId));
    if (found === undefined) return undefined;
    if (!OPEN_STATES.includes(found.body.state)) return { ...found.body, replayed: true };
    return this.#drop(found, why, reason);
  }

  /** After a restart: every ending still open is completed once. Returns the answers. */
  async recover(): Promise<WorkEndAnswer[]> {
    const out: WorkEndAnswer[] = [];
    for (let after: string | undefined;;) {
      const page = await this.#runner.list(RECORD, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const a of page) {
        after = a.id;
        const b = a.body as unknown as WorkEndRecord;
        if (OPEN_STATES.includes(b.state)) out.push(await this.complete(b.attemptId));
      }
      if (page.length < 100) return out;
    }
  }

  async get(attemptId: string): Promise<WorkEndAnswer | undefined> {
    const f = await this.#get(idOf(attemptId));
    return f === undefined ? undefined : { ...f.body, replayed: false };
  }

  async #drop(rec: { body: WorkEndRecord; revision: number }, typed: "owner_stop" | "emergency_stop", reason: string): Promise<WorkEndAnswer> {
    const written = await this.#set(rec, clean({ ...rec.body, state: "dropped" as const, outcome: "dropped" as const, typed, summary: redactText(reason).slice(0, 300), finishedAt: this.#runner.now() }), "workend.drop");
    return { ...written.body, replayed: false };
  }

  async #blocker(body: WorkEndRecord, key: string, summary: string): Promise<string | undefined> {
    try {
      return (await this.#deps.blockers.openBlocker({ commandId: `work-end-blk:${key}`, actor: "controller", type: "runtime_hold", subject: { kind: "task", id: body.taskId }, summary: summary.slice(0, 500), resolver: "owner" })).id;
    } catch { return undefined; }
  }

  async #get(id: string): Promise<{ body: WorkEndRecord; revision: number } | undefined> {
    const f: Aggregate | undefined = await this.#runner.get(RECORD, id);
    return f === undefined ? undefined : { body: f.body as unknown as WorkEndRecord, revision: f.revision };
  }

  async #set(rec: { body: WorkEndRecord; revision: number }, body: WorkEndRecord, type: string): Promise<{ body: WorkEndRecord; revision: number }> {
    const id = idOf(rec.body.attemptId);
    const ref: AggregateRef = { kind: RECORD, id };
    await this.#runner.command(type, { commandId: `${id}:${type}:${body.state}`, actor: "controller" }, async () => ({
      payload: { state: body.state },
      build: async () => ({ ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: rec.revision, body: json(body) }], detail: { taskId: body.taskId }, contention: async () => new DomainError("stale_revision", "the ending changed at the same moment") }),
    }));
    return { body, revision: rec.revision + 1 };
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

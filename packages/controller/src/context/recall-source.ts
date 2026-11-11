import type { Principal } from "../security/principals.js";
import type { DispatchBody } from "../dispatch/model.js";
import { handoffId } from "./enforcement.js";
import type { AnchorFacts } from "./anchor.js";
import type { RecallArchive, RecallAttempt, RecallHandoff, RecallSource } from "./recall.js";

/**
 * Card W13: reads, for the attempt a call came through, the records `task.recall` may show. The task is the attempt's (the controller bound the credential to the attempt before it asked): this reader takes no task, project or
 * agent from anywhere else. It reads this task's attempts (the dispatcher's per-task list, at most 20, each loaded and kept only when it belongs to the task), their running notes and reports, the hand-off notes
 * written for them (the record IDs are derived from the task, so no other task's note can be named) and, for the digests those notes name, the cut notes the controller kept (derived from the task and the digest, so another task's
 * archive is simply not there). It never reads the owner's chat, the owner's decisions beyond what the anchor already lists, stored thinking, another agent's desk or another task. Nothing is written.
 */
export interface RecallReaderDeps {
  /** The task's attempt IDs, oldest first (the dispatcher's list of the task). */
  readonly attemptsOf: (taskId: string) => Promise<readonly string[]>;
  readonly attempt: (attemptId: string) => Promise<DispatchBody | undefined>;
  /** The anchor facts for the attempt, as the dispatcher composes them for a start. */
  readonly anchorFacts: (attemptId: string) => Promise<AnchorFacts | undefined>;
  /** A hand-off note by ID (`undefined` when there is none). */
  readonly handoff?: (by: Principal, noteId: string) => Promise<{ id: string; taskId: string; attemptId: string; source: string; endedBecause: string; text: string } | undefined>;
  /** A cut note by task and digest. */
  readonly archive?: (by: Principal, taskId: string, digest: string) => Promise<{ taskId: string; attemptId?: string; what: string; digest: string; text: string } | undefined>;
}

const DIGESTS = /sha256:[0-9a-f]{64}/g;

export class RecallReader {
  readonly #deps: RecallReaderDeps;
  constructor(deps: RecallReaderDeps) { this.#deps = deps; }

  /** `by` is the caller as the credential proves it (the agent's task credential): the hand-off and cut-note records answer it as they answer any reader, with the right to work on the task. */
  async read(attemptId: string, by: Principal): Promise<RecallSource | undefined> {
    const here = await this.#deps.attempt(attemptId);
    if (here === undefined) return undefined;
    const taskId = here.taskId;
    const ids = [...new Set([...(await this.#deps.attemptsOf(taskId)), attemptId])];
    const attempts: RecallAttempt[] = [];
    for (const id of ids) {
      const b = id === attemptId ? here : await this.#deps.attempt(id);
      // An attempt of another task (a damaged list) is not this task's.
      if (b === undefined || b.taskId !== taskId) continue;
      attempts.push(attemptOf(b, id === attemptId));
    }
    const handoffs: RecallHandoff[] = [];
    const archives: { digest: string; attemptId: string }[] = [];
    if (this.#deps.handoff !== undefined) {
      for (const a of attempts) {
        for (const source of ["attempt", "controller"] as const) {
          const h = await this.#deps.handoff(by, handoffId(taskId, a.id, source)).catch((): undefined => undefined);
          if (h === undefined || h.taskId !== taskId || h.attemptId !== a.id) continue;
          handoffs.push({ id: h.id, attemptId: h.attemptId, source: h.source, endedBecause: h.endedBecause, text: h.text });
          for (const d of new Set(h.text.match(DIGESTS) ?? [])) if (!archives.some((x) => x.digest === d)) archives.push({ digest: d, attemptId: a.id });
        }
      }
    }
    const facts = await this.#deps.anchorFacts(attemptId);
    if (facts === undefined) return undefined;
    const read = this.#deps.archive;
    const archive = async (digest: string): Promise<RecallArchive | undefined> => {
      const got = read === undefined ? undefined : await read(by, taskId, digest).catch((): undefined => undefined);
      return got === undefined || got.taskId !== taskId || got.digest !== digest ? undefined : { digest: got.digest, ...(got.attemptId === undefined ? {} : { attemptId: got.attemptId }), what: got.what, text: got.text };
    };
    // The block lists the newest records first.
    const anchor: AnchorFacts = { ...facts, handoffIds: [...handoffs].reverse().map((h) => h.id), archiveDigests: [...archives].reverse().map((a) => a.digest) };
    return { taskId, attemptId, anchor, attempts, handoffs, archives, archive };
  }
}

function attemptOf(b: DispatchBody, current: boolean): RecallAttempt {
  const v = b.verifications ?? [];
  return {
    id: b.attemptId, state: b.state, claimedAt: b.claimedAt, current,
    ...(b.startedAt === undefined ? {} : { startedAt: b.startedAt }), ...(b.route === undefined ? {} : { route: b.route }),
    ...(b.outcome === undefined ? {} : { outcome: { status: b.outcome.status, summary: b.outcome.summary, at: b.outcome.at } }),
    notes: (b.notes ?? []).map((n) => ({ kind: n.kind, text: n.text, at: n.at })),
    ...(b.report === undefined ? {} : { report: { result: b.report.result, text: b.report.text, at: b.report.at, questioning: b.report.questioning } }),
    calls: b.calls, stoppedEarly: b.stoppedEarly?.length ?? 0, nudges: b.nudgesUsed ?? 0,
    verifications: { passed: v.filter((x) => x.state === "passed").length, failed: v.filter((x) => x.state === "failed").length, unknown: v.filter((x) => x.state === "unknown").length },
    anchors: b.anchors?.length ?? 0,
  };
}

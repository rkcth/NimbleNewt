import { randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { BlockerService } from "../domain/blockers.js";
import type { Principal } from "../security/principals.js";
import type { JsonObject } from "../storage/types.js";
import type { DispatcherService } from "./dispatcher.js";

/**
 * Makes the agent's attempts quiet around an operation on its work (card H12d): integrating its changes (A04), refreshing its checkout, releasing it (A06) or quarantining it. Before the operation every live attempt of the scope has its new calls
 * refused, its calls in flight settled and a checkpoint taken (`DispatcherService.quiesce`); the operation runs only if all of them are quiet. If one cannot be made quiet the operation does not run: a typed blocker (`runtime_hold`) says which
 * attempt and why, the attempts already quiet are released, and the caller gets the refusal. After the operation (whatever its result) every attempt is released, so each continues from where it was; `after` can tell the agent what changed.
 * The operations themselves live where their files are (the worker's workspace code); the composer hands them to `around`.
 */
export type QuiesceOperation = "integration" | "refresh" | "release" | "quarantine";

export interface QuiesceDeps {
  readonly dispatcher: Pick<DispatcherService, "liveAttemptsOf" | "quiesce" | "release" | "get">;
  readonly blockers: Pick<BlockerService, "openBlocker">;
  /** The principal the dispatcher's control calls are made as (the owner's, or the dispatcher's own). */
  readonly principal: Principal;
  /** How long a call told to stop may take to end before the attempt is judged not quiet (default 10 seconds). */
  readonly settleMs?: number;
}

export interface Quiet {
  /** The attempts that were made quiet, and the checkpoint taken for each (absent when the attempt had no running worker to checkpoint). */
  readonly attempts: readonly { readonly attemptId: string; readonly checkpoint?: JsonObject }[];
}

export class QuiesceRefused extends DomainError {
  constructor(readonly operation: QuiesceOperation, readonly attemptId: string, readonly blockerId: string | undefined, why: string) {
    super("unavailable", `${operation} did not run: attempt ${attemptId} could not be made quiet (${why})${blockerId === undefined ? "" : `; blocker ${blockerId} says so`}`);
    this.name = "QuiesceRefused";
  }
}

const reasonOf = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 200);

export class QuiesceCoordinator {
  readonly #deps: QuiesceDeps;
  #sequence = 0;
  readonly #nonce = randomBytes(6).toString("hex");
  constructor(deps: QuiesceDeps) { this.#deps = deps; }

  /**
   * Runs `run` with the scope's attempts quiet. `after` runs once the attempts are released and the operation did not throw, for each attempt (to tell the agent its checkout changed); a failure in it is the caller's to see
   * but never leaves an attempt frozen. `tag` is written into the freeze's reason, so whoever must lift it later can tell it from any other.
   */
  async around<T>(scope: { readonly taskId?: string; readonly agentId?: string }, operation: QuiesceOperation, run: (quiet: Quiet) => Promise<T>, after?: (attemptId: string) => Promise<void>, tag?: string): Promise<T> {
    const { dispatcher, principal } = this.#deps;
    const ids = await dispatcher.liveAttemptsOf(principal, scope);
    const reason = `${operation}: the agent's work is being changed${tag === undefined ? "" : ` (${tag})`}`;
    const quiet: { attemptId: string; checkpoint?: JsonObject }[] = [];
    // A freeze somebody else set (the owner, a recipe change that failed, a stop) is theirs: it is not lifted here.
    const theirs = new Set<string>();
    const releaseAll = async (): Promise<string | undefined> => {
      let failed: string | undefined;
      for (const entry of quiet) { if (theirs.has(entry.attemptId)) continue; try { await dispatcher.release(principal, entry.attemptId); } catch (error) {
        // An attempt that ended meanwhile has nothing to release.
        if (!(error instanceof DomainError && error.code === "not_found")) failed = `${entry.attemptId}: ${reasonOf(error)}`;
      } }
      return failed;
    };
    for (const attemptId of ids) {
      try {
        if ((await dispatcher.get(principal, attemptId))?.frozen !== undefined) theirs.add(attemptId);
        const { checkpoint } = await dispatcher.quiesce(principal, attemptId, reason.slice(0, 300), { strictMs: this.#deps.settleMs ?? 10_000 });
        quiet.push({ attemptId, ...(checkpoint === undefined ? {} : { checkpoint }) });
      } catch (error) {
        // It ended between the listing and now: there is nothing left to make quiet.
        if (error instanceof DomainError && error.code === "not_found") continue;
        // It may be frozen already even though it did not settle: it is released with the others, never left refusing calls.
        quiet.push({ attemptId });
        const why = reasonOf(error);
        const subject = scope.taskId !== undefined ? { kind: "task", id: scope.taskId } : { kind: "agent", id: scope.agentId! };
        let blockerId: string | undefined;
        try {
          const opened = await this.#deps.blockers.openBlocker({ commandId: `quiesce-blk:${this.#nonce}:${attemptId}:${operation}:${++this.#sequence}`, actor: principal.id, type: "runtime_hold", subject, summary: `${operation} did not run: attempt ${attemptId} could not be made quiet (${why})`, resolver: "owner" });
          blockerId = opened.id;
        } catch { /* the refusal below still says it */ }
        await releaseAll();
        throw new QuiesceRefused(operation, attemptId, blockerId, why);
      }
    }
    let result: T;
    try {
      result = await run({ attempts: quiet });
    } catch (error) {
      await releaseAll();
      throw error;
    }
    // The operation has happened: a release that fails is not the operation failing (a retry would do it twice). It is a blocker, and the others still continue.
    const failed = await releaseAll();
    if (failed !== undefined) {
      const subject = scope.taskId !== undefined ? { kind: "task", id: scope.taskId } : { kind: "agent", id: scope.agentId! };
      await this.#deps.blockers.openBlocker({ commandId: `quiesce-rel:${this.#nonce}:${operation}:${++this.#sequence}`, actor: principal.id, type: "runtime_hold", subject, summary: `${operation} ran, but an attempt could not be released: ${failed}`, resolver: "owner" }).catch(() => undefined);
    }
    if (after !== undefined) for (const entry of quiet) await after(entry.attemptId).catch(() => undefined);
    return result;
  }
}

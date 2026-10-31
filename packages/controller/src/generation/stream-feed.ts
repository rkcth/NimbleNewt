import { DomainError } from "../domain/errors.js";
import type { ModelStreamCall, ModelStreamEvent, ModelStreamTap } from "../dispatch/model-stream.js";
import { ModelStreamRefused } from "../dispatch/model-stream.js";
import type { Principal } from "../security/principals.js";
import { GENERATION_LIMITS, GenerationRefused, type GenerationService } from "./generation.js";

/** The attempt a model call belongs to, as the relay knows it. */
export interface StreamAttempt { readonly attemptId: string; readonly taskId: string; readonly generation: number }
export interface StreamFeedDeps {
  readonly generation: Pick<GenerationService, "begin" | "record" | "complete" | "gate" | "view">;
  /** The principal that records the streams (the dispatcher's service principal). */
  readonly principal: Principal;
  /** The owner's switches, read at the start of each call. A throw leaves both on. */
  readonly settings?: () => Promise<{ readonly record: boolean; readonly cut: boolean }>;
  /** Told about a failure that is neither a refusal nor an unknown task (the call is not affected). */
  readonly onError?: (error: unknown) => void;
  /** Distinguishes calls of one attempt across restarts of the controller (command IDs must not collide with those of an earlier process). */
  readonly nonce?: () => string;
}

const QUIET = new Set(["forbidden", "not_found", "fenced", "invalid_command"]);

/**
 * Records the model stream of one attempt's calls as revision-bound generations (card L05b). Each model call begins a generation under the task's context revision as it stands when the call is sent (and bound to the attempt's
 * fence); each decoded event is recorded in order; the end completes it. A generation that was interrupted meanwhile (a cancel, an owner's correction, a newer generation) records everything after as late and the call is told to hold
 * the reply back, with the reason read from the generation's interruption. A task that is held (finish-and-hold, cancel) begins no generation, so its call is refused before it is sent. Tasks the generation service does not know are not recorded.
 */
export function streamTapFor(deps: StreamFeedDeps, attempt: StreamAttempt): ModelStreamTap {
  let calls = 0;
  const nonce = (deps.nonce ?? ((): string => Math.random().toString(36).slice(2, 10)))();
  const report = (error: unknown): void => { try { deps.onError?.(error); } catch { /* the call is not affected */ } };
  return {
    async started() {
      let setting = { record: true, cut: true };
      try { if (deps.settings !== undefined) setting = await deps.settings(); } catch { /* both stay on */ }
      if (!setting.record) return undefined;
      const call = ++calls;
      const g = deps.generation;
      let run: { id: string; number: number } | undefined;
      for (let pass = 0; pass < 2 && run === undefined; pass++) {
        try {
          const revision = (await g.gate(deps.principal, attempt.taskId))?.gate.contextRevision ?? 1;
          run = await g.begin(deps.principal, { commandId: `sf-${attempt.attemptId}-${nonce}-${call}-${pass}`.slice(0, 120), taskId: attempt.taskId, contextRevision: revision, fence: { generation: attempt.generation, attemptId: attempt.attemptId } });
        } catch (error) {
          if (error instanceof GenerationRefused && error.reason === "held") throw new ModelStreamRefused(`no generation begins for task ${attempt.taskId}: ${error.message}`);
          // A correction that landed between reading the revision and beginning: read it again once, then give the call up rather than bind it to a revision that is gone.
          if (error instanceof GenerationRefused && error.reason === "stale") { if (pass === 1) throw new ModelStreamRefused(`task ${attempt.taskId} was corrected while the call began; it is not sent`); continue; }
          // Paused, unknown to the generation service, or an attempt that is no longer current: not recorded, not stopped.
          if (!(error instanceof GenerationRefused) && !(error instanceof DomainError && QUIET.has(error.code))) report(error);
          return undefined;
        }
      }
      if (run === undefined) return undefined;
      const runId = run.id;
      let seq = 0;
      let heldWhy: string | undefined;
      let broken = false;
      const why = async (): Promise<string> => {
        const v = await g.view(deps.principal, runId).catch(() => undefined);
        const i = v?.run.interrupted;
        return i === undefined ? `generation ${run!.number} of task ${attempt.taskId} is no longer current` : `generation ${run!.number} of task ${attempt.taskId} was ${i.kind} by ${i.by} (${i.reason})`;
      };
      const one = async (chunk: { text?: string; toolCall?: { id: string; name?: string; argumentsDelta?: string; done?: boolean } }): Promise<void> => {
        if (heldWhy !== undefined || broken) return;
        try {
          const r = await g.record(deps.principal, { commandId: `sf-${runId}-${seq + 1}`, runId, seq: seq + 1, ...chunk });
          seq += 1;
          if (r.late || !r.applied) heldWhy = await why();
        } catch (error) {
          if (error instanceof GenerationRefused && (error.reason === "stale" || error.reason === "held")) { heldWhy = await why(); return; }
          // A chunk the service will not take (a credential-shaped text, a limit): the rest of this reply is not recorded, and the reply goes on.
          broken = true;
          if (!(error instanceof DomainError && error.code === "invalid_command")) report(error);
        }
      };
      const stream: ModelStreamCall = {
        async events(events: readonly ModelStreamEvent[]) {
          let text = "";
          const flush = async (): Promise<void> => { while (text !== "") { const part = text.slice(0, GENERATION_LIMITS.delta); text = text.slice(part.length); await one({ text: part }); } };
          for (const e of events) {
            if (e.kind === "text") { text += e.text; continue; }
            await flush();
            if (e.kind === "tool") {
              for (let at = 0; at === 0 || at < e.argumentsDelta.length; at += GENERATION_LIMITS.delta) {
                const last = at + GENERATION_LIMITS.delta >= e.argumentsDelta.length;
                await one({ toolCall: { id: e.id, ...(at === 0 && e.name !== undefined ? { name: e.name } : {}), argumentsDelta: e.argumentsDelta.slice(at, at + GENERATION_LIMITS.delta), done: e.done && last } });
              }
            }
          }
          await flush();
          return setting.cut && heldWhy !== undefined ? { held: heldWhy } : {};
        },
        async ended() {
          try { await g.complete(deps.principal, { commandId: `sf-${runId}-end`, runId }); } catch (error) { if (!(error instanceof DomainError && QUIET.has(error.code)) && !(error instanceof GenerationRefused)) report(error); }
        },
      };
      return stream;
    },
  };
}

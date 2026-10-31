import { DomainError } from "../domain/errors.js";
import type { ModelStreamCall, ModelStreamEvent, ModelStreamTap } from "../dispatch/model-stream.js";
import { ModelStreamRefused } from "../dispatch/model-stream.js";
import type { Principal } from "../security/principals.js";
import { GENERATION_LIMITS, GenerationRefused, type GenerationService, type RecordPiece } from "./generation.js";
import { STREAM_VALUES, type StreamSettingsView } from "./stream-settings.js";

/** The attempt a model call belongs to, as the relay knows it. */
export interface StreamAttempt { readonly attemptId: string; readonly taskId: string; readonly generation: number }
export interface StreamFeedDeps {
  readonly generation: Pick<GenerationService, "begin" | "recordMany" | "complete" | "gate" | "view">;
  /** The principal that records the streams (the dispatcher's service principal). */
  readonly principal: Principal;
  /** The owner's settings, read at the start of each call. A throw leaves the defaults (record, cut, closed). */
  readonly settings?: () => Promise<Partial<Pick<StreamSettingsView, "record" | "cut" | "failClosed" | "storeTimeoutMs" | "batchMs" | "batchChars" | "heldBufferBytes">>>;
  /** Told about a failure that is neither a refusal nor an unknown task (the call is not affected unless the fail mode is closed). */
  readonly onError?: (error: unknown) => void;
  /** Distinguishes calls of one attempt across restarts of the controller (command IDs must not collide with those of an earlier process). */
  readonly nonce?: () => string;
  /** The time, in milliseconds (a test seam). */
  readonly now?: () => number;
}

/** A store call that did not answer in time. */
export class StoreTimeout extends Error { constructor(ms: number) { super(`the generation store did not answer within ${ms} ms`); this.name = "StoreTimeout"; } }

const QUIET = new Set(["forbidden", "not_found"]);
/** Cuts a string at `n` characters without splitting a surrogate pair. */
export const safeSlice = (value: string, n: number): string => (n >= value.length ? value : n > 0 && value.charCodeAt(n - 1) >= 0xd800 && value.charCodeAt(n - 1) <= 0xdbff ? value.slice(0, n - 1) : value.slice(0, n));

/**
 * Records the model stream of one attempt's calls as revision-bound generations (card L05b). Each model call begins a generation under the task's context revision as it stands when the call is sent (and bound to the attempt's
 * fence); the decoded events are recorded in order, in batches (by time and size, settable) so a long reply is not rewritten piece by piece; the end completes it. Whether the generation was interrupted meanwhile (a cancel, an owner's
 * correction, a newer generation) is checked cheaply at each piece (a read of the task's gate, at most once per batch interval), and always before a completed tool call or the end of the reply is passed on. An interrupted generation
 * records what follows as late and the call is told to hold the reply back, with the reason read from the generation's interruption. A task that is held, paused, waiting for the owner's decision, fenced, done or cancelled begins no
 * generation, so its call is refused before it is sent. Tasks the generation service does not know are not recorded. When the store cannot answer (an error or no answer in time) the owner's fail mode applies: closed (default) refuses the
 * call and cuts a reply being read, open lets it go on unrecorded.
 */
export function streamTapFor(deps: StreamFeedDeps, attempt: StreamAttempt): ModelStreamTap {
  let calls = 0;
  const nonce = (deps.nonce ?? ((): string => Math.random().toString(36).slice(2, 10)))();
  const now = deps.now ?? ((): number => Date.now());
  const report = (error: unknown): void => { try { deps.onError?.(error); } catch { /* the call is not affected */ } };
  /** Requests of this attempt whose reply was held because the task was corrected: retried unchanged they would carry the old context. */
  const stale = new Map<string, { revision: number; text: string }>();
  return {
    async started(call) {
      let setting: NonNullable<ReturnType<NonNullable<StreamFeedDeps["settings"]>> extends Promise<infer T> ? T : never> = {};
      try { if (deps.settings !== undefined) setting = await within(deps.settings(), STREAM_VALUES.storeTimeoutMs.default); } catch { /* the defaults stay */ }
      if (setting.record === false) return undefined;
      const closed = setting.failClosed !== false;
      const timeoutMs = setting.storeTimeoutMs ?? STREAM_VALUES.storeTimeoutMs.default;
      const batchMs = setting.batchMs ?? STREAM_VALUES.batchMs.default;
      const batchChars = setting.batchChars ?? STREAM_VALUES.batchChars.default;
      const cut = setting.cut !== false;
      let waiters = 0;
      const hook = { on: (waiting: boolean): void => { stream.onWait?.(waiting); } };
      /** One store call, bounded in time, and marked as a wait on the store while it runs (stall detection must not blame the model for it). */
      const store = async <T>(fn: () => Promise<T>): Promise<T> => {
        if (++waiters === 1) try { hook.on(true); } catch { /* ignored */ }
        try { return await within(fn(), timeoutMs); } finally { if (--waiters === 0) try { hook.on(false); } catch { /* ignored */ } }
      };
      const g = deps.generation;
      const seen = call.requestDigest === undefined ? undefined : stale.get(call.requestDigest);
      // A request built before a correction and sent again unchanged does not know the correction: it carries it as a last message (the relay adds it), and is bound to the new revision.
      const amend = seen === undefined ? undefined : seen.text;
      const count = ++calls;
      let run: { id: string; number: number } | undefined;
      let bound = 1;
      for (let pass = 0; pass < 2 && run === undefined; pass++) {
        try {
          bound = (await store(() => g.gate(deps.principal, attempt.taskId)))?.gate.contextRevision ?? 1;
          run = await store(() => g.begin(deps.principal, { commandId: `sf-${attempt.attemptId}-${nonce}-${count}-${pass}`.slice(0, 120), taskId: attempt.taskId, contextRevision: bound, fence: { generation: attempt.generation, attemptId: attempt.attemptId } }));
        } catch (error) {
          if (error instanceof GenerationRefused) {
            if (error.reason === "held" || error.reason === "paused" || error.reason === "decision") throw new ModelStreamRefused(`no generation begins for task ${attempt.taskId}: ${error.message}`);
            // A correction that landed between reading the revision and beginning: read it again once, then give the call up rather than bind it to a revision that is gone.
            if (error.reason === "stale") { if (pass === 1) throw new ModelStreamRefused(`task ${attempt.taskId} was corrected while the call began; it is not sent`); continue; }
          }
          // The attempt is no longer current (fenced) or the task is done or cancelled: the call is not sent.
          if (error instanceof DomainError && (error.code === "fenced" || (error.code === "invalid_command" && error.field === "taskId"))) throw new ModelStreamRefused(`no generation begins for task ${attempt.taskId}: ${error.message}`);
          // Unknown to the generation service, or not this principal's to record: not recorded, not stopped.
          if (error instanceof DomainError && QUIET.has(error.code)) return undefined;
          // The store could not answer. Closed: no call goes out that could not be bound to a revision. Open: it goes out unrecorded.
          report(error);
          if (closed) throw new ModelStreamRefused(`the generation store could not be asked (${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}); the call is not sent (fail mode: closed)`);
          return undefined;
        }
      }
      if (run === undefined) return undefined;
      const runId = run.id;
      const number = run.number;
      let seq = 0;
      let heldWhy: string | undefined;
      let unrecorded = false;
      let pieces: RecordPiece[] = [];
      let text = "";
      let chars = 0;
      let lastFlush = now();
      let lastCheck = now();
      const why = async (): Promise<string> => {
        const v = await store(() => g.view(deps.principal, runId)).catch(() => undefined);
        const i = v?.run.interrupted;
        if (i?.kind === "corrected" && call.requestDigest !== undefined) stale.set(call.requestDigest, { revision: bound + 1, text: `[Correction by ${i.by} at context revision ${bound + 1}: ${i.reason} The reply you were writing was discarded; continue from this correction.]` });
        return i === undefined ? `generation ${number} of task ${attempt.taskId} is no longer current` : `generation ${number} of task ${attempt.taskId} was ${i.kind} by ${i.by} (${i.reason})`;
      };
      const stop = (reason: string, error?: unknown): void => { unrecorded = true; pieces = []; text = ""; chars = 0; if (error !== undefined && !(error instanceof DomainError && error.code === "invalid_command")) report(error); void reason; };
      const flushText = (): void => { while (text !== "") { const part = safeSlice(text, GENERATION_LIMITS.delta); text = text.slice(part.length); pieces.push({ text: part }); } };
      /** Writes what waits, in as few commits as the limits allow. Order is kept; a refusal of the service stops the recording but never the check. */
      const flush = async (): Promise<void> => {
        flushText();
        lastFlush = now();
        while (pieces.length > 0 && !unrecorded) {
          const batch = pieces.slice(0, GENERATION_LIMITS.batch);
          try {
            const r = await store(() => g.recordMany(deps.principal, { commandId: `sf-${runId}-${seq + 1}`, runId, seq: seq + 1, pieces: batch }));
            seq += batch.length;
            pieces = pieces.slice(batch.length);
            if ((r.late || !r.applied) && heldWhy === undefined) heldWhy = await why();
          } catch (error) {
            if (error instanceof GenerationRefused && (error.reason === "stale" || error.reason === "held")) { heldWhy = await why(); stop("held"); return; }
            if (error instanceof DomainError && error.code === "invalid_command") {
              // A piece the service will not take (credential-shaped text, a size limit): recording stops, with a visible placeholder; the check for an interruption goes on, so the cut still works.
              const reason = error.message.slice(0, 120);
              stop(reason, error);
              try { await store(() => g.recordMany(deps.principal, { commandId: `sf-${runId}-${seq + 1}-note`, runId, seq: seq + 1, pieces: [{ text: `[recording stopped here: ${reason}]`.slice(0, 300) }] })); seq += 1; } catch { /* the note is a courtesy */ }
              return;
            }
            if (error instanceof DomainError && (QUIET.has(error.code) || error.code === "fenced")) { stop("not recorded"); return; }
            // The store failed or timed out mid-reply.
            report(error);
            stop("store");
            if (closed && cut) heldWhy = `the generation store could not be reached while the reply streamed (${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}); fail mode: closed`;
            return;
          }
        }
      };
      /** Has the generation been interrupted? One read of the gate: the revision, the current generation, a cancel. */
      const interrupted = async (): Promise<void> => {
        lastCheck = now();
        if (heldWhy !== undefined) return;
        try {
          const gate = (await store(() => g.gate(deps.principal, attempt.taskId)))?.gate;
          if (gate !== undefined && (gate.contextRevision !== bound || gate.current !== number || gate.hold?.mode === "cancel")) heldWhy = await why();
        } catch (error) {
          report(error);
          if (closed && cut) heldWhy = `the generation store could not be reached while the reply streamed (${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}); fail mode: closed`;
        }
      };
      // Calls into this run are one at a time: the reply's own pieces, the end, and the timer that writes what waits when the model pauses.
      let chain: Promise<unknown> = Promise.resolve();
      const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(fn, fn); chain = r.then(() => undefined, () => undefined); return r; };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (): void => {
        if (timer !== undefined || batchMs <= 0 || unrecorded || (pieces.length === 0 && text === "")) return;
        timer = setTimeout(() => { timer = undefined; void serial(async () => { if (heldWhy === undefined && !unrecorded) { await flush(); chars = 0; } }).catch(() => undefined); }, batchMs);
        timer.unref?.();
      };
      const stream: ModelStreamCall = {
        ...(amend === undefined ? {} : { amend }),
        ...(setting.heldBufferBytes === undefined ? { heldBufferBytes: STREAM_VALUES.heldBufferBytes.default } : { heldBufferBytes: setting.heldBufferBytes }),
        events: (events: readonly ModelStreamEvent[]) => serial(async () => {
          let dangerous = false;
          for (const e of events) {
            if (unrecorded) { if (e.kind === "end" || (e.kind === "tool" && e.done)) dangerous = true; continue; }
            if (e.kind === "text") { text += e.text; chars += e.text.length; continue; }
            if (e.kind === "note") { flushText(); pieces.push({ text: `[${e.text}]`.slice(0, 300) }); continue; }
            if (e.kind === "end") { dangerous = true; continue; }
            flushText();
            if (e.done) dangerous = true;
            let first = true;
            for (let at = 0; at === 0 || at < e.argumentsDelta.length;) {
              const part = safeSlice(e.argumentsDelta.slice(at), GENERATION_LIMITS.delta);
              if (part === "" && at > 0) break;
              at += part.length;
              pieces.push({ toolCall: { id: e.id, ...(first && e.name !== undefined ? { name: e.name } : {}), argumentsDelta: part, done: e.done && at >= e.argumentsDelta.length } });
              first = false;
              if (part === "") break;
            }
            chars += e.argumentsDelta.length;
          }
          const due = batchMs === 0 || batchChars === 0 || chars >= batchChars || now() - lastFlush >= batchMs;
          if (dangerous || now() - lastCheck >= batchMs || batchMs === 0) await interrupted();
          // A tool call's completion and the end of the reply are recorded as applied before they are passed on.
          if (dangerous || due || heldWhy !== undefined) { await flush(); chars = 0; }
          arm();
          return cut && heldWhy !== undefined ? { held: heldWhy } : {};
        }),
        ended: (outcome) => serial(async () => {
          if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
          try {
            if (heldWhy === undefined) { await flush(); }
            const failed = outcome.ok ? undefined : (heldWhy !== undefined ? "the reply was held back and discarded" : "the reply failed or was cancelled before it ended");
            await store(() => g.complete(deps.principal, { commandId: `sf-${runId}-end`, runId, ...(failed === undefined ? {} : { failed }) }));
          } catch (error) { if (!(error instanceof DomainError && (QUIET.has(error.code) || error.code === "fenced")) && !(error instanceof GenerationRefused)) report(error); }
        }),
      };
      return stream;
    },
  };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StoreTimeout(ms)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

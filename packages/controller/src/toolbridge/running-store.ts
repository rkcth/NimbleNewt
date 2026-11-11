import { createHash, randomBytes } from "node:crypto";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

/**
 * Card T02d close-out: a durable record of each catalogue tool call (and job) that is running, so a controller process that did not start a call can still list it. The in-process list of
 * `ToolExecutionService` knows only its own calls; with a second controller process on the same store (the newer one takes the epoch and the older one keeps running the calls it had already
 * started until they end), the owner's revoke question would otherwise say "nothing is running" and record no choice.
 *
 * One record per call (`tool-run`, ID derived from attempt and call), written when the call starts and removed when it ends. No lease is renewed: every run is bounded by its manifest's
 * `limits.seconds`, which the sandbox launcher enforces for scripts and jobs alike, so the record says when the call can no longer be running (`until`, start + limit + a grace) and a
 * record past it is never listed. Records left by a process that stopped, or that lost the epoch and so could not remove its own, are removed by `sweep` once past `until`.
 * No input, output or content is stored: the tool name and version, attempt, call, task and agent, the writer and the times.
 */
export const RUNNING_CALL_KIND = "tool-run";
export const RUNNING_CALL_LIMITS = { graceMs: 60_000, page: 500, pages: 10, sweep: 200 } as const;

export interface RunningCallEntry { readonly name: string; readonly version: string; readonly attemptId: string; readonly callId: string; readonly taskId: string; readonly agentId: string }
export interface RunningCallRecord extends RunningCallEntry { readonly startedAt: string; readonly until: string }

/** What the tool execution service needs (structural, so a test can fake it). */
export interface RunningCallRecords {
  /** Records a call that starts now; answers the record ID, or `undefined` when nothing could be written (the call runs all the same). */
  begin(entry: RunningCallEntry & { readonly seconds: number }): Promise<string | undefined>;
  /** Removes the record of a call this writer began. Never throws. */
  end(id: string): Promise<void>;
  /**
   * The calls of a version that OTHER writers recorded and that can still be running. Throws when the store cannot be read. `incomplete: true` when there were more records than one bounded look reads, so calls may be
   * missing from the answer (the caller must not present it as everything).
   */
  elsewhere(name: string, version: string): Promise<{ readonly calls: readonly RunningCallRecord[]; readonly total: number; readonly incomplete?: true }>;
  /** Removes records past their `until` (any writer). Answers how many were removed. Never throws. */
  sweep(): Promise<number>;
}

interface Body extends RunningCallRecord { readonly holder: string }

const isBody = (b: unknown): b is Body => {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
  const o = b as Record<string, unknown>;
  return ["name", "version", "attemptId", "callId", "taskId", "agentId", "holder", "startedAt", "until"].every((k) => typeof o[k] === "string" && (o[k] as string).length > 0 && (o[k] as string).length <= 300) && Number.isFinite(Date.parse(o["until"] as string));
};

export class RunningCallStore implements RunningCallRecords {
  readonly #runner: CommandRunner;
  /** This writer (one per service instance): its own records are not "elsewhere", and only it removes them before their time. */
  readonly #holder: string;
  readonly #graceMs: number;
  readonly #page: number;
  readonly #pages: number;
  private constructor(runner: CommandRunner, holder: string, graceMs: number, page: number, pages: number) { this.#runner = runner; this.#holder = holder; this.#graceMs = graceMs; this.#page = page; this.#pages = pages; }

  /** `page` and `pages` bound one look through the records (defaults `RUNNING_CALL_LIMITS`; smaller values are for tests). */
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { readonly holder?: string; readonly graceMs?: number; readonly page?: number; readonly pages?: number } = {}): RunningCallStore {
    const graceMs = options.graceMs ?? RUNNING_CALL_LIMITS.graceMs;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new RangeError("graceMs must be a whole number of milliseconds, 0 or more");
    const page = options.page ?? RUNNING_CALL_LIMITS.page;
    const pages = options.pages ?? RUNNING_CALL_LIMITS.pages;
    if (!Number.isSafeInteger(page) || page < 1 || page > RUNNING_CALL_LIMITS.page || !Number.isSafeInteger(pages) || pages < 1 || pages > RUNNING_CALL_LIMITS.pages) throw new RangeError("page and pages must be whole numbers from 1 to the defaults");
    return new RunningCallStore(new CommandRunner(storage, epoch, options), options.holder ?? `h-${randomBytes(12).toString("hex")}`, graceMs, page, pages);
  }

  get holder(): string { return this.#holder; }

  static idOf(attemptId: string, callId: string): string { return `trun-${createHash("sha256").update(`${attemptId}\0${callId}`).digest("hex").slice(0, 40)}`; }

  async begin(entry: RunningCallEntry & { readonly seconds: number }): Promise<string | undefined> {
    try {
      const id = RunningCallStore.idOf(entry.attemptId, entry.callId);
      const ref = { kind: RUNNING_CALL_KIND, id };
      const now = this.#runner.now();
      const seconds = Number.isFinite(entry.seconds) && entry.seconds > 0 ? Math.min(entry.seconds, 86_400) : 86_400;
      const body: Body = { name: entry.name, version: entry.version, attemptId: entry.attemptId, callId: entry.callId, taskId: entry.taskId, agentId: entry.agentId, holder: this.#holder, startedAt: now, until: new Date(Date.parse(now) + seconds * 1000 + this.#graceMs).toISOString() };
      await this.#runner.command("tool.run.begin", { commandId: `trb-${randomBytes(16).toString("hex")}`, actor: "service:dispatcher" }, async () => ({
        payload: { id },
        build: async () => {
          // A leftover of the same attempt and call (a process that stopped before removing it) is replaced, revision-guarded.
          const current = await this.#runner.get(ref.kind, ref.id);
          const change = current === undefined ? { type: "create" as const, ref, body: body as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: current.revision, body: body as unknown as JsonObject };
          return { ref, creates: current === undefined, changes: [change], detail: { name: body.name, version: body.version, taskId: body.taskId } };
        },
      }));
      return id;
    } catch { return undefined; }
  }

  async end(id: string): Promise<void> {
    try {
      const current = await this.#runner.get(RUNNING_CALL_KIND, id);
      if (current === undefined || !isBody(current.body) || current.body.holder !== this.#holder) return;
      await this.#remove(id, current.revision, "tool.run.end");
    } catch { /* past its time the record is never listed, and the next sweep removes it */ }
  }

  async elsewhere(name: string, version: string): Promise<{ readonly calls: readonly RunningCallRecord[]; readonly total: number; readonly incomplete?: true }> {
    const now = Date.parse(this.#runner.now());
    const calls: RunningCallRecord[] = [];
    const all = await this.#all();
    for (const b of all.bodies) {
      if (b.holder === this.#holder || b.name !== name || b.version !== version || Date.parse(b.until) <= now) continue;
      calls.push({ name: b.name, version: b.version, attemptId: b.attemptId, callId: b.callId, taskId: b.taskId, agentId: b.agentId, startedAt: b.startedAt, until: b.until });
    }
    return { calls, total: calls.length, ...(all.complete ? {} : { incomplete: true as const }) };
  }

  async sweep(): Promise<number> {
    let removed = 0;
    try {
      const now = Date.parse(this.#runner.now());
      const pages = await this.#runner.list(RUNNING_CALL_KIND, { limit: this.#page });
      for (const a of pages) {
        if (removed >= RUNNING_CALL_LIMITS.sweep) break;
        // A record that cannot be read names no time, so it can never be listed; it is removed too.
        if (isBody(a.body) && Date.parse(a.body.until) > now) continue;
        try { await this.#remove(a.id, a.revision, "tool.run.expire"); removed += 1; } catch { /* changed meanwhile or this process lost the epoch: left for the next sweep */ }
      }
    } catch { /* the store cannot be read now */ }
    return removed;
  }

  /** Every record, at most `pages` pages; `complete: false` when the last page read was full, so more may follow (review: the cut was silent, and calls past it were hidden). */
  async #all(): Promise<{ readonly bodies: Body[]; readonly complete: boolean }> {
    const out: Body[] = [];
    let afterId: string | undefined;
    for (let i = 0; i < this.#pages; i++) {
      const page = await this.#runner.list(RUNNING_CALL_KIND, { ...(afterId === undefined ? {} : { afterId }), limit: this.#page });
      for (const a of page) if (isBody(a.body)) out.push(a.body);
      if (page.length < this.#page) return { bodies: out, complete: true };
      afterId = page[page.length - 1]!.id;
    }
    return { bodies: out, complete: false };
  }

  async #remove(id: string, revision: number, type: string): Promise<void> {
    const ref = { kind: RUNNING_CALL_KIND, id };
    await this.#runner.command(type, { commandId: `${type === "tool.run.end" ? "tre" : "trx"}-${id.slice(5)}-${revision}`, actor: "service:dispatcher" }, async () => ({
      payload: { id, revision },
      build: async () => ({ ref, creates: false, changes: [{ type: "delete" as const, ref, expectedRevision: revision }], detail: {} }),
    }));
  }
}

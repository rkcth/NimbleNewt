import type { Aggregate, ControllerStorage } from "../storage/types.js";

/** The most records of one kind the reference scan reads. Past it the scan is `partial` and nothing it did not see may be treated as unreferenced. */
export const REFERENCE_SCAN_LIMIT = 100_000;

const TERMINAL = new Set(["done", "cancelled"]);

/**
 * What a resumable task or a replay still needs (card K06: "material referenced by a resumable task or by replay is never deleted and shows as retained").
 * A task is resumable while it is not done or cancelled. Its material is: its own desk records, history scopes, artifacts, summaries and spill, what its compactions cite, and everything its continuation records list
 * (artifacts, scratch records, summary lineage, source scopes): the continuation is what a resume or a replay reads. The scan is bounded; when it hits the bound `complete` is false and a caller must treat everything as retained.
 */
export class RetainedMaterial {
  readonly #reasons = new Map<string, string[]>();
  #complete = true;
  /** The resumable tasks found (ID to project). */
  readonly tasks = new Map<string, string>();

  get complete(): boolean { return this.#complete; }
  #add(kind: string, id: string, reason: string): void { const key = `${kind}:${id}`; const list = this.#reasons.get(key); if (list === undefined) this.#reasons.set(key, [reason]); else if (!list.includes(reason) && list.length < 5) list.push(reason); }

  /** Why the record must stay, or `undefined` when no resumable task or replay needs it. An incomplete scan answers for every record. */
  why(kind: string, id: string): string[] | undefined {
    if (!this.#complete) return ["the check of what resumable tasks need did not finish, so nothing is treated as free to delete"];
    return this.#reasons.get(`${kind}:${id}`);
  }
  get size(): number { return this.#reasons.size; }

  static async build(storage: Pick<ControllerStorage, "listAggregates">): Promise<RetainedMaterial> {
    const out = new RetainedMaterial();
    const scan = async (kind: string, each: (a: Aggregate) => void): Promise<void> => {
      let after: string | undefined; let seen = 0;
      for (;;) {
        const page: Aggregate[] = await storage.listAggregates(kind, { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
        for (const a of page) each(a);
        seen += page.length;
        if (page.length < 500) return;
        if (seen >= REFERENCE_SCAN_LIMIT) { out.#complete = false; return; }
        after = page[page.length - 1]!.id;
      }
    };
    await scan("task", (a) => { const b = a.body as { state?: string; projectId?: string }; if (typeof b.state === "string" && !TERMINAL.has(b.state) && typeof b.projectId === "string") out.tasks.set(a.id, b.projectId); });
    const live = (taskId: unknown): taskId is string => typeof taskId === "string" && out.tasks.has(taskId);
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const source = (s: unknown, reason: string): void => {
      const r = s as { kind?: string; id?: string; scopeId?: string } | null;
      if (r === null || typeof r !== "object") return;
      if (r.kind === "desk-record" && typeof r.id === "string") out.#add("desk-record", r.id, reason);
      else if (r.kind === "history-entry" && typeof r.scopeId === "string") out.#add("history-scope", r.scopeId, reason);
      else if (r.kind === "owner-decision" && typeof r.id === "string") out.#add("decision", r.id, reason);
    };
    const liveDesk = new Map<string, string>();
    await scan("desk-record", (a) => { const b = a.body as { taskId?: unknown }; if (live(b.taskId)) { liveDesk.set(a.id, b.taskId); out.#add("desk-record", a.id, `written for task ${b.taskId}, which can still resume`); } });
    // A summary has no task of its own on older records: it belongs to a resumable task when it names one, or when it was built from that task's desk records (its sources).
    await scan("summary-record", (a) => {
      const b = a.body as { taskId?: unknown; sources?: { source?: { kind?: string; id?: string } }[] };
      if (live(b.taskId)) { out.#add("summary-record", a.id, `summary written by task ${b.taskId}, which can still resume`); return; }
      for (const x of Array.isArray(b.sources) ? b.sources : []) {
        const t = x?.source?.kind === "desk-record" && typeof x.source.id === "string" ? liveDesk.get(x.source.id) : undefined;
        if (t !== undefined) { out.#add("summary-record", a.id, `built from records of task ${t}, which can still resume`); return; }
      }
    });
    await scan("artifact", (a) => { const b = a.body as { taskId?: unknown }; if (live(b.taskId)) out.#add("artifact", a.id, `produced by task ${b.taskId}, which can still resume`); });
    await scan("history-scope", (a) => { const b = a.body as { taskId?: unknown }; if (live(b.taskId)) out.#add("history-scope", a.id, `history of task ${b.taskId}, which can still resume or be replayed`); });
    await scan("ctx-compaction", (a) => {
      const b = a.body as { taskId?: unknown; sources?: unknown; pinned?: unknown; summaryId?: unknown };
      if (!live(b.taskId)) return;
      const why = `cited by the context of task ${b.taskId}, which can still resume`;
      out.#add("ctx-compaction", a.id, why);
      if (typeof b.summaryId === "string") out.#add("summary-record", b.summaryId, why);
      for (const s of Array.isArray(b.sources) ? b.sources : []) source(s, why);
      for (const s of Array.isArray(b.pinned) ? b.pinned : []) source(s, why);
    });
    await scan("ctx-spill", (a) => { const b = a.body as { taskId?: unknown }; if (live(b.taskId)) out.#add("ctx-spill", a.id, `paged-out text of task ${b.taskId}, which can still resume`); });
    await scan("continuation", (a) => {
      const b = a.body as { taskId?: unknown; continuation?: { artifacts?: unknown }; scratchRecords?: unknown; manifest?: { summaryLineage?: unknown; sourceRanges?: unknown } };
      if (!live(b.taskId)) return;
      const why = `listed by a checkpoint of task ${b.taskId}, which can still resume or be replayed`;
      out.#add("continuation", a.id, why);
      for (const id of strings(b.continuation?.artifacts)) out.#add("artifact", id, why);
      for (const id of strings(b.scratchRecords)) out.#add("desk-record", id, why);
      for (const id of strings(b.manifest?.summaryLineage)) { out.#add("ctx-compaction", id, why); out.#add("summary-record", id, why); }
      for (const r of Array.isArray(b.manifest?.sourceRanges) ? (b.manifest.sourceRanges as { source?: unknown }[]) : []) if (typeof r?.source === "string") { out.#add("history-scope", r.source, why); out.#add("desk-record", r.source, why); }
    });
    return out;
  }
}

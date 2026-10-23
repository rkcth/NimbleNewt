import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { sha256 } from "../storage/json.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { canReadDecision, decisionText, type OwnerDecisionBody } from "../decisions/records.js";
import type { DeskService } from "./desks.js";
import type { HistoryService } from "./histories.js";

/** A link to the original: one desk record, one entry of a history, or one owner decision (card C08; its text is the owner's wording, marked non-authoritative once superseded). Following it is checked against the reader's rights every time. */
export type SourceRef = { readonly kind: "desk-record"; readonly id: string } | { readonly kind: "history-entry"; readonly scopeId: string; readonly seq: number } | { readonly kind: "owner-decision"; readonly id: string };

export interface Hit {
  readonly source: SourceRef;
  readonly projectId: string;
  readonly title?: string;
  /** A short piece of the original around the first match, cut to `RETRIEVAL_LIMITS.snippet` characters. */
  readonly snippet: string;
  /** How many query terms were found (a hit has at least one). */
  readonly matched: number;
}

export interface SearchResult {
  readonly hits: readonly Hit[];
  /** Where to continue, when anything may remain. */
  readonly next?: string;
  /** True when this call stopped because it had looked at `RETRIEVAL_LIMITS.scan` items, not because it had found enough or run out: continue from `next` to look further. */
  readonly scanLimited: boolean;
}

export interface SummaryBody {
  readonly projectId: string;
  readonly title: string;
  readonly text: string;
  /** The originals it was written from, each with a digest of the text at the time. */
  readonly sources: readonly { readonly source: SourceRef; readonly digest: string }[];
  readonly createdBy: string;
}

export type SourceState = "current" | "changed" | "unavailable";

export interface ResolvedSource {
  readonly source: SourceRef;
  /** `unavailable`: gone, or not readable by this reader (the two are not told apart). `changed`: the original differs from what the summary was written from. */
  readonly state: SourceState;
}

export interface ResolvedSummary {
  readonly id: string;
  /** The summary text, only when the reader may read every original; otherwise withheld (`withheld: true`) and the sources are still listed by state. */
  readonly text?: string;
  readonly title?: string;
  readonly withheld: boolean;
  readonly sources: readonly ResolvedSource[];
}

export type Wanted = { readonly source: SourceRef } | { readonly summaryId: string };

export interface Assembled {
  readonly included: readonly { readonly ref: Wanted; readonly text: string; readonly truncated: boolean }[];
  /** Everything asked for and not included, with why. Nothing is dropped without being listed. */
  readonly omitted: readonly { readonly ref: Wanted; readonly reason: "over-budget" | "unavailable" }[];
  readonly usedChars: number;
  readonly budgetChars: number;
}

export const RETRIEVAL_LIMITS = { query: 200, terms: 8, snippet: 240, hits: 50, scan: 2000, summaryText: 4000, sources: 50, items: 100, budget: 200_000, minPiece: 200, page: 200 } as const;

const SCOPE_ID = /^hst-[a-z2-7]{20}$/;
const RECORD_ID = /^dsk-[a-z2-7]{20}$/;
const SUMMARY_ID = /^sum-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

function checkSource(value: unknown, field: string): SourceRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(field, "must be an object");
  const e = value as Record<string, unknown>;
  if (e["kind"] === "desk-record") {
    for (const key of Object.keys(e)) if (key !== "kind" && key !== "id") invalid(`${field}.${key}`, "is not a field of a desk-record link");
    return { kind: "desk-record", id: typeof e["id"] === "string" && RECORD_ID.test(e["id"]) ? e["id"] : invalid(`${field}.id`, "is not a desk record ID") };
  }
  if (e["kind"] === "owner-decision") {
    for (const key of Object.keys(e)) if (key !== "kind" && key !== "id") invalid(`${field}.${key}`, "is not a field of an owner-decision link");
    return { kind: "owner-decision", id: typeof e["id"] === "string" && /^dec-[a-z2-7]{20}$/.test(e["id"]) ? e["id"] : invalid(`${field}.id`, "is not an owner decision ID") };
  }
  if (e["kind"] === "history-entry") {
    for (const key of Object.keys(e)) if (key !== "kind" && key !== "scopeId" && key !== "seq") invalid(`${field}.${key}`, "is not a field of a history-entry link");
    const seq = e["seq"];
    return {
      kind: "history-entry",
      scopeId: typeof e["scopeId"] === "string" && SCOPE_ID.test(e["scopeId"]) ? e["scopeId"] : invalid(`${field}.scopeId`, "is not a history scope ID"),
      seq: typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 1 ? seq : invalid(`${field}.seq`, "must be a whole number of at least 1"),
    };
  }
  return invalid(`${field}.kind`, "must be desk-record, history-entry or owner-decision");
}
const sameSource = (a: SourceRef, b: SourceRef): boolean => JSON.stringify(a) === JSON.stringify(b);
const keyOf = (s: SourceRef): string => (s.kind === "desk-record" ? `d:${s.id}` : s.kind === "owner-decision" ? `o:${s.id}` : `h:${s.scopeId}:${String(s.seq).padStart(9, "0")}`);

function terms(query: unknown): string[] {
  const q = text(query, "query", { min: 1, max: RETRIEVAL_LIMITS.query });
  const found = [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 2))];
  if (found.length === 0) return invalid("query", "needs at least one word of two or more characters");
  return found.slice(0, RETRIEVAL_LIMITS.terms);
}
/** `value.slice(from, to)` that never starts or ends inside a surrogate pair (a cut emoji would leave a lone half). */
function cut(value: string, from: number, to: number): string {
  let start = Math.max(0, from);
  let end = Math.min(value.length, to);
  if (start > 0 && start < value.length && value.charCodeAt(start) >= 0xdc00 && value.charCodeAt(start) <= 0xdfff) start++;
  if (end > start && end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
  return value.slice(start, end);
}
function snippetOf(content: string, wanted: readonly string[]): { snippet: string; matched: number } {
  const lower = content.toLowerCase();
  const positions = wanted.map((t) => lower.indexOf(t)).filter((p) => p >= 0);
  if (positions.length === 0) return { snippet: "", matched: 0 };
  const start = Math.max(0, Math.min(...positions) - 60);
  // Redact the whole text before cutting, so a secret the cut would split is still recognised.
  const raw = cut(redactText(content), start, start + RETRIEVAL_LIMITS.snippet).replace(/\s+/g, " ").trim();
  return { snippet: raw, matched: positions.length };
}

/**
 * Bounded, source-backed retrieval over desks and histories (card C02). It reads only through `DeskService` and `HistoryService`, so every search result, snippet, link and summary is checked against
 * the reader's rights at the moment it is read: something the reader cannot read is not in a search, not in a snippet, and a link to it reads like a link to nothing.
 *
 * - **Search** is a plain word search (case-insensitive; every query word counts, at least one must appear), in a stable order, with a cursor. One call looks at no more than
 *   `RETRIEVAL_LIMITS.scan` items and says so when it stopped for that reason.
 * - **Summaries** are written by a principal who can read every original, keep a digest of each original as it was, and are shown to a reader only when that reader can read every original too
 *   (otherwise the text is withheld and the sources are listed with their state), so a summary is never a way round a permission. `resolve` follows each link again and reports `current`,
 *   `changed` or `unavailable`.
 * - **Assembly** fills a character budget with the wanted items in the order given; what does not fit, or cannot be read, is listed as omitted with the reason, never silently dropped.
 */
export class RetrievalService {
  readonly #runner: CommandRunner;
  readonly #desks: DeskService;
  readonly #histories: HistoryService;

  private constructor(runner: CommandRunner, desks: DeskService, histories: HistoryService) {
    this.#runner = runner;
    this.#desks = desks;
    this.#histories = histories;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, desks: DeskService, histories: HistoryService, options: RunnerOptions = {}): RetrievalService {
    return new RetrievalService(new CommandRunner(storage, epoch, options), desks, histories);
  }

  // ---- search ----------------------------------------------------------------------------------------------------------------

  async search(principal: Principal, query: { projectId: string; query: string; limit?: number; cursor?: string }): Promise<SearchResult> {
    onlyKnown(query, ["projectId", "query", "limit", "cursor"]);
    const projectId = checkProjectId(query.projectId);
    const wanted = terms(query.query);
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RETRIEVAL_LIMITS.hits) invalid("limit", `must be a whole number from 1 to ${RETRIEVAL_LIMITS.hits}`);
    const after = query.cursor === undefined ? undefined : this.#cursor(query.cursor);
    const hits: Hit[] = [];
    let scanned = 0;
    let last: string | undefined = after;
    let more = false;

    const accept = (source: SourceRef, content: string, title?: string): "continue" | "stop" => {
      scanned++;
      last = keyOf(source);
      const { snippet, matched } = snippetOf(title === undefined ? content : `${title}\n${content}`, wanted);
      if (matched > 0) hits.push({ source, projectId, ...(title === undefined ? {} : { title }), snippet, matched });
      return hits.length >= limit || scanned >= RETRIEVAL_LIMITS.scan ? "stop" : "continue";
    };

    // Desk records first (in ID order), then history entries (by scope, then sequence).
    const deskAfter = after === undefined || after.startsWith("d:") ? after?.slice(2) : undefined;
    const deskDone = after !== undefined && after.startsWith("h:");
    if (!deskDone) {
      for (let cursor = deskAfter; ;) {
        const page = await this.#desks.list(principal, { projectId, ...(cursor === undefined ? {} : { afterId: cursor }), limit: 100 });
        for (const record of page.items) if (accept({ kind: "desk-record", id: record.id }, record.body, record.title) === "stop") { more = true; break; }
        if (more) break;
        if (page.next === undefined) break;
        cursor = page.next;
      }
    }
    if (!more) {
      const resume = after !== undefined && after.startsWith("h:") ? after.slice(2) : undefined;
      const resumeScope = resume === undefined ? undefined : resume.slice(0, resume.lastIndexOf(":"));
      const resumeSeq = resume === undefined ? 0 : Number(resume.slice(resume.lastIndexOf(":") + 1));
      scopes: for (let scopeCursor: string | undefined; ;) {
        const page = await this.#histories.listScopes(principal, { projectId, ...(scopeCursor === undefined ? {} : { afterId: scopeCursor }), limit: 20 });
        for (const scope of page.items) {
          // Scopes come in ID order, so everything before the one being resumed has been searched already.
          if (resumeScope !== undefined && scope.id < resumeScope) continue;
          let seq = scope.id === resumeScope ? resumeSeq : 0;
          for (;;) {
            const read = await this.#histories.read(principal, scope.id, { afterSeq: seq, limit: RETRIEVAL_LIMITS.page });
            for (const entry of read.entries) { seq = entry.seq; if (accept({ kind: "history-entry", scopeId: scope.id, seq: entry.seq }, entry.text) === "stop") { more = true; break scopes; } }
            if (read.entries.length < RETRIEVAL_LIMITS.page) break;
          }
        }
        if (page.next === undefined) break;
        scopeCursor = page.next;
      }
    }
    return { hits, ...(more && last !== undefined ? { next: last } : {}), scanLimited: more && hits.length < limit };
  }

  #cursor(value: unknown): string {
    if (typeof value !== "string" || value.length > 200 || !/^(?:d:dsk-[a-z2-7]{20}|h:hst-[a-z2-7]{20}:\d{1,9})$/.test(value)) return invalid("cursor", "is not a cursor from an earlier search");
    return value;
  }

  // ---- following a link ------------------------------------------------------------------------------------------------------

  /** The original a link points at, if this reader may read it. Missing and unreadable look the same (`undefined`). */
  async fetch(principal: Principal, source: SourceRef): Promise<{ text: string; digest: string; projectId: string } | undefined> {
    const ref = checkSource(source, "source");
    try {
      if (ref.kind === "desk-record") {
        const record = await this.#desks.read(principal, ref.id);
        // The digest covers what a reader relies on: the text, the title and whether the record is still the current one (a record that has been superseded is no longer as it was).
        return { text: record.body, digest: sha256(JSON.stringify([record.status, record.title, record.body])), projectId: record.projectId };
      }
      if (ref.kind === "owner-decision") {
        const found = await this.#runner.get("decision", ref.id);
        const d = found?.body as unknown as OwnerDecisionBody | undefined;
        // The digest covers what a reader relies on: the wording and reading, and whether the decision is still authoritative.
        return d === undefined || !canReadDecision(principal, d) ? undefined : { text: decisionText(d, ref.id), digest: sha256(JSON.stringify([d.state, d.statement, d.wording, d.supersededBy ?? null])), projectId: d.projectId };
      }
      const scope = await this.#histories.getScope(principal, ref.scopeId);
      if (scope === undefined) return undefined;
      const read = await this.#histories.read(principal, ref.scopeId, { afterSeq: ref.seq - 1, limit: 1 });
      const entry = read.entries[0];
      return entry === undefined || entry.seq !== ref.seq ? undefined : { text: entry.text, digest: sha256(entry.text), projectId: scope.projectId };
    } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) return undefined;
      throw error;
    }
  }

  // ---- summaries ---------------------------------------------------------------------------------------------------------------

  /** Records a summary of originals the writer can read, in one project, with a digest of each. */
  async summarize(principal: Principal, command: NoActor & { projectId: string; title: string; text: string; sources: readonly SourceRef[] }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "projectId", "title", "text", "sources"]);
    const projectId = checkProjectId(command.projectId);
    const title = text(command.title, "title", { min: 1, max: 200 });
    const body = text(command.text, "text", { min: 1, max: RETRIEVAL_LIMITS.summaryText, multiline: true });
    if (redactText(body) !== body || redactText(title) !== title) invalid("text", "looks like a credential or key; those are not recorded in a summary");
    if (!Array.isArray(command.sources) || command.sources.length < 1 || command.sources.length > RETRIEVAL_LIMITS.sources) return invalid("sources", `must list 1 to ${RETRIEVAL_LIMITS.sources} originals`);
    const sources = command.sources.map((s, i) => checkSource(s, `sources[${i}]`));
    if (sources.some((s, i) => sources.findIndex((o) => sameSource(o, s)) !== i)) invalid("sources", "lists the same original twice");
    if (!allows(principal, "desk.write", projectId)) throw new DomainError("forbidden", `${principal.id} may not write summaries in that project`);
    const id = derivedId("sum", scopedCommandId(principal.id, command.commandId));
    const r = await this.#runner.command("summary.create", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => ({
      payload: { projectId, title, text: body, sources: sources as unknown as JsonObject[] },
      build: async () => {
        const kept: { source: SourceRef; digest: string }[] = [];
        for (const source of sources) {
          const original = await this.fetch(principal, source);
          // A summary of something the writer cannot read, or from another project, is refused with one message for both.
          if (original === undefined || original.projectId !== projectId) throw new DomainError("invalid_command", "sources: each original must exist, be readable by the writer and belong to the project", { field: "sources" });
          kept.push({ source, digest: original.digest });
        }
        const ref: AggregateRef = { kind: "summary-record", id };
        const value: SummaryBody = { projectId, title, text: body, sources: kept, createdBy: principal.id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: value as unknown as JsonObject }], detail: { projectId, sources: kept.length } };
      },
    }));
    return { id: r.id, replayed: r.replayed };
  }

  /** The summary and, for each original, whether it is still as it was. The text is withheld unless this reader can read every original. */
  async resolve(principal: Principal, summaryId: string): Promise<ResolvedSummary | undefined> {
    const found = typeof summaryId === "string" && SUMMARY_ID.test(summaryId) ? await this.#runner.get("summary-record", summaryId) : undefined;
    if (found === undefined) return undefined;
    const summary = view<SummaryBody>(found);
    if (!allows(principal, "desk.read", summary.projectId)) return undefined;
    const sources: ResolvedSource[] = [];
    for (const kept of summary.sources) {
      const now = await this.fetch(principal, kept.source);
      sources.push({ source: kept.source, state: now === undefined ? "unavailable" : now.digest === kept.digest ? "current" : "changed" });
    }
    const readable = sources.every((s) => s.state !== "unavailable");
    return readable ? { id: summary.id, title: summary.title, text: summary.text, withheld: false, sources } : { id: summary.id, withheld: true, sources };
  }

  // ---- assembling context within a budget -----------------------------------------------------------------------------------

  async assemble(principal: Principal, request: { items: readonly Wanted[]; budgetChars: number }): Promise<Assembled> {
    onlyKnown(request, ["items", "budgetChars"]);
    const budget = request.budgetChars;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > RETRIEVAL_LIMITS.budget) invalid("budgetChars", `must be a whole number from 1 to ${RETRIEVAL_LIMITS.budget}`);
    if (!Array.isArray(request.items) || request.items.length > RETRIEVAL_LIMITS.items) return invalid("items", `must be a list of at most ${RETRIEVAL_LIMITS.items}`);
    const wantedItems = request.items.map((w, i): Wanted => {
      if (w !== null && typeof w === "object" && "summaryId" in w) {
        if (Object.keys(w).length !== 1 || typeof w.summaryId !== "string" || !SUMMARY_ID.test(w.summaryId)) invalid(`items[${i}]`, "is not a summary link");
        return { summaryId: w.summaryId };
      }
      if (w === null || typeof w !== "object" || !("source" in w) || Object.keys(w).length !== 1) return invalid(`items[${i}]`, "must be { source } or { summaryId }");
      return { source: checkSource((w as { source: unknown }).source, `items[${i}].source`) };
    });
    const included: { ref: Wanted; text: string; truncated: boolean }[] = [];
    const omitted: { ref: Wanted; reason: "over-budget" | "unavailable" }[] = [];
    let used = 0;
    for (const ref of wantedItems) {
      let content: string | undefined;
      if ("summaryId" in ref) {
        const s = await this.resolve(principal, ref.summaryId);
        content = s === undefined || s.withheld ? undefined : `${s.title ?? ""}\n${s.text ?? ""}${s.sources.some((x) => x.state === "changed") ? "\n[some originals have changed since this summary]" : ""}`;
      } else content = (await this.fetch(principal, ref.source))?.text;
      if (content === undefined) { omitted.push({ ref, reason: "unavailable" }); continue; }
      const room = budget - used;
      if (content.length <= room) { included.push({ ref, text: content, truncated: false }); used += content.length; continue; }
      if (room >= RETRIEVAL_LIMITS.minPiece) { const piece = cut(content, 0, room); included.push({ ref, text: piece, truncated: true }); used += piece.length; continue; }
      omitted.push({ ref, reason: "over-budget" });
    }
    return { included, omitted, usedChars: used, budgetChars: budget };
  }
}

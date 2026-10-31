import { randomBytes } from "node:crypto";
import { mkdir, open, rm, stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { DomainError } from "../domain/errors.js";
import { canonicalJson } from "../storage/json.js";
import type { Aggregate, ControllerStorage, OperationInput, OperationResult } from "../storage/types.js";
import type { RetentionValues } from "./settings.js";

/**
 * Capacity for the records that must always be written (card K06; operational-contracts 129: capacity limits reserve room for shutdown and recovery records).
 * The reserve is a real file of random bytes in the data directory. It takes the room: ordinary writes meet a full disk first. A CRITICAL write (a checkpoint, a stop, a recovery record, or a retention command, which is how room is
 * made) that finds the disk full gives the file back and writes again with the same operation ID; from then on ordinary writes are refused ("protected") until the owner has freed room and the reserve has been made again, so the
 * room is never spent twice. A write that still fails is reported as failed, never as done.
 */
export class ReserveFile {
  readonly #path: string;
  #wanted = 0;
  #released = false;
  #short = false;
  #releasedAt: string | undefined;
  constructor(path: string) { this.#path = path; }

  get released(): boolean { return this.#released; }
  /** The wanted reserve could not be made (not enough room): shown as a warning. */
  get short(): boolean { return this.#short; }
  get wanted(): number { return this.#wanted; }
  get releasedAt(): string | undefined { return this.#releasedAt; }

  /** Makes the file `bytes` long (or removes it for 0). A reserve already given back stays given back until `restore`. */
  async apply(bytes: number): Promise<void> {
    this.#wanted = bytes;
    if (this.#released) return;
    await this.#make(bytes);
  }

  /** Tries to make the reserve again after it was given back (the dispatcher's tick calls it). True when the reserve stands. */
  async restore(): Promise<boolean> {
    if (!this.#released) return true;
    if (await this.#make(this.#wanted)) { this.#released = false; this.#releasedAt = undefined; return true; }
    return false;
  }

  /** Gives the room back. False when there was none to give (no reserve, or already given back): a second disk-full is then a failure. */
  async release(at: string): Promise<boolean> {
    if (this.#released || this.#wanted === 0) return false;
    await rm(this.#path, { force: true });
    this.#released = true; this.#releasedAt = at;
    return true;
  }

  async #make(bytes: number): Promise<boolean> {
    this.#short = false;
    if (bytes === 0) { await rm(this.#path, { force: true }); return true; }
    const have = await stat(this.#path).then((s) => s.size, () => -1);
    if (have === bytes) return true;
    await rm(this.#path, { force: true });
    await mkdir(dirname(this.#path), { recursive: true });
    // Never make a nearly full disk fuller: the reserve is set aside only when twice its size is free.
    const space = await diskSpace(dirname(this.#path));
    if (space !== undefined && space.freeBytes < bytes * 2) { this.#short = true; return false; }
    const file = await open(this.#path, "w", 0o600);
    try {
      const chunk = 1024 * 1024;
      for (let written = 0; written < bytes; written += chunk) await file.write(randomBytes(Math.min(chunk, bytes - written)));
      await file.sync();
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(this.#path, { force: true });
      if (isDiskFull(error)) { this.#short = true; return false; }
      throw error;
    }
    await file.close();
    return true;
  }
}

/** A storage error whose cause chain says the disk is full (the adapters report it as `unavailable` with the driver's error as the cause). */
export function isDiskFull(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e !== undefined && e !== null && depth < 6; depth++) {
    const x = e as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    if (x.code === "ENOSPC" || x.code === "SQLITE_FULL" || x.code === "53100" || x.code === "EDQUOT") return true;
    if (typeof x.message === "string" && /no space left|disk is full|database or disk is full|disk full|quota exceeded/i.test(x.message)) return true;
    e = x.cause;
  }
  return false;
}

/** The commands whose records must reach the disk when it is nearly full: checkpoints, stops, recovery and resume records, pauses, and the retention commands that free room. */
const CRITICAL_PREFIXES = ["continuation.", "stop.", "recovery", "resume.", "stall.recover", "pause.", "retention.", "quiesce", "shutdown", "checkpoint"] as const;
export const isCriticalOperation = (input: Pick<OperationInput, "audit">): boolean => {
  const first = input.audit[0]?.type;
  return first !== undefined && CRITICAL_PREFIXES.some((p) => first.startsWith(p));
};

/** What is metered: the kinds that hold written content, with where their project and writer are. Bytes are the canonical size of the body, plus an artifact's blob bytes. */
interface Metered { readonly project: (b: Record<string, unknown>, scopes: ReadonlyMap<string, string>) => string | undefined; readonly agent: (b: Record<string, unknown>) => string | undefined; readonly bytes: (b: Record<string, unknown>) => number }
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bodySize = (b: Record<string, unknown>): number => Buffer.byteLength(canonicalJson(b as never));
export const METERED: Readonly<Record<string, Metered>> = {
  "desk-record": { project: (b) => str(b["projectId"]), agent: (b) => str(b["owner"]), bytes: bodySize },
  "working-note": { project: (b) => str(b["projectId"]), agent: (b) => str(b["owner"]), bytes: bodySize },
  "summary-record": { project: (b) => str(b["projectId"]), agent: (b) => str(b["createdBy"]), bytes: bodySize },
  // A history entry belongs to the project of its scope; a spill (text paged out of a context) to the project of its task.
  "history-entry": { project: (b, scopes) => (typeof b["scope"] === "string" ? scopes.get(b["scope"]) : undefined), agent: (b) => str(b["author"]), bytes: bodySize },
  "ctx-spill": { project: (b) => str(b["projectId"]), agent: () => undefined, bytes: bodySize },
  artifact: { project: (b) => str(b["projectId"]), agent: (b) => str(b["createdBy"]), bytes: (b) => bodySize(b) + (typeof b["totalBytes"] === "number" ? b["totalBytes"] : 0) },
};

export interface Usage { readonly byProject: ReadonlyMap<string, number>; readonly byAgent: ReadonlyMap<string, number>; readonly partial: boolean; readonly at: number }

/** The most records of one kind a usage count looks at; beyond it the count is a lower bound and says so (`partial`). */
export const USAGE_SCAN_LIMIT = 50_000;

/**
 * Quotas (card K06): optional, off by default. Usage is counted by one pass over the metered kinds, kept for `ttlMs`, and increased by what the guard admits meanwhile, so the figure is approximate between passes
 * (never lower than what was admitted) and the check costs nothing while no quota is set. A write is refused when it would take its project or its writer over the quota.
 */
export class QuotaMeter {
  readonly #storage: ControllerStorage;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #usage: { byProject: Map<string, number>; byAgent: Map<string, number>; partial: boolean; at: number } | undefined;
  constructor(storage: ControllerStorage, options: { ttlMs?: number; now?: () => number } = {}) { this.#storage = storage; this.#ttlMs = options.ttlMs ?? 60_000; this.#now = options.now ?? Date.now; }

  invalidate(): void { this.#usage = undefined; }

  async usage(): Promise<Usage> {
    if (this.#usage !== undefined && this.#now() - this.#usage.at < this.#ttlMs) return this.#usage;
    const byProject = new Map<string, number>(); const byAgent = new Map<string, number>();
    let partial = false;
    const scopes = new Map<string, string>();
    for (let after: string | undefined, seen = 0; ;) {
      const page: Aggregate[] = await this.#storage.listAggregates("history-scope", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const a of page) { const p = (a.body as { projectId?: unknown }).projectId; if (typeof p === "string") scopes.set(a.id, p); }
      seen += page.length;
      if (page.length < 500) break;
      if (seen >= USAGE_SCAN_LIMIT) { partial = true; break; }
      after = page[page.length - 1]!.id;
    }
    for (const [kind, meter] of Object.entries(METERED)) {
      let after: string | undefined; let seen = 0;
      for (;;) {
        const page: Aggregate[] = await this.#storage.listAggregates(kind, { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
        for (const a of page) {
          const b = a.body as Record<string, unknown>; const n = meter.bytes(b);
          const p = meter.project(b, scopes); const w = meter.agent(b);
          if (p !== undefined) byProject.set(p, (byProject.get(p) ?? 0) + n);
          if (w !== undefined) byAgent.set(w, (byAgent.get(w) ?? 0) + n);
        }
        seen += page.length;
        if (page.length < 500) break;
        if (seen >= USAGE_SCAN_LIMIT) { partial = true; break; }
        after = page[page.length - 1]!.id;
      }
    }
    this.#usage = { byProject, byAgent, partial, at: this.#now() };
    return this.#usage;
  }

  /** Adds what was admitted to the kept figures (an update is counted at its full new size: the next pass corrects it). */
  note(project: ReadonlyMap<string, number>, agent: ReadonlyMap<string, number>): void {
    if (this.#usage === undefined) return;
    for (const [k, v] of project) this.#usage.byProject.set(k, (this.#usage.byProject.get(k) ?? 0) + v);
    for (const [k, v] of agent) this.#usage.byAgent.set(k, (this.#usage.byAgent.get(k) ?? 0) + v);
  }
}

/** What an operation adds to each project and writer. */
export function addedBy(input: Pick<OperationInput, "changes">): { project: Map<string, number>; agent: Map<string, number> } {
  const project = new Map<string, number>(); const agent = new Map<string, number>();
  // The scopes this operation itself writes or checks (an entry is appended together with its scope's record).
  const scopes = new Map<string, string>();
  for (const c of input.changes) if ((c.type === "create" || c.type === "update") && c.ref.kind === "history-scope") { const p = (c.body as { projectId?: unknown }).projectId; if (typeof p === "string") scopes.set(c.ref.id, p); }
  for (const c of input.changes) {
    if (c.type !== "create" && c.type !== "update") continue;
    const meter = METERED[c.ref.kind];
    if (meter === undefined) continue;
    const b = c.body as Record<string, unknown>; const n = meter.bytes(b);
    const p = meter.project(b, scopes); const w = meter.agent(b);
    if (p !== undefined) project.set(p, (project.get(p) ?? 0) + n);
    if (w !== undefined) agent.set(w, (agent.get(w) ?? 0) + n);
  }
  return { project, agent };
}

export interface GuardOptions {
  readonly reserve?: ReserveFile;
  readonly meter: QuotaMeter;
  /** The values in force now (cached by the caller; may throw when the setting is damaged, in which case no quota applies and the reserve rule still does). */
  readonly values: () => Promise<RetentionValues>;
  readonly now?: () => string;
  /** Called when a critical write took the reserve. */
  readonly onReserveUsed?: (at: string) => void;
}

/**
 * The storage the controller runs on, with the retention rules in front of writes (card K06): the disk-full reserve and the optional quotas. Only `applyOperation` is changed; everything else passes straight through.
 * A refusal because of a quota or the protected state is `unavailable` (the same reason a full disk gives), and nothing is written.
 */
export function guardStorage(storage: ControllerStorage, options: GuardOptions): ControllerStorage {
  const now = options.now ?? (() => new Date().toISOString());
  const refusal = async (input: OperationInput): Promise<DomainError | undefined> => {
    if (options.reserve?.released === true) return new DomainError("unavailable", "the disk is nearly full and the reserve for shutdown and recovery records is in use; only those records are written until room is made (free some space, or delete something: retention.delete)");
    const added = addedBy(input);
    if (added.project.size === 0 && added.agent.size === 0) return undefined;
    let values: RetentionValues | undefined;
    try { values = await options.values(); } catch { values = undefined; }
    if (values === undefined || (values.quotaProjectBytes === null && values.quotaAgentBytes === null)) return undefined;
    const usage = await options.meter.usage();
    for (const [p, n] of added.project) if (values.quotaProjectBytes !== null && (usage.byProject.get(p) ?? 0) + n > values.quotaProjectBytes) return new DomainError("unavailable", `project ${p} is over its storage quota (${values.quotaProjectBytes} bytes, ${usage.byProject.get(p) ?? 0} used); the owner can raise it (retention.settings.set quotaProjectBytes) or delete something`);
    for (const [w, n] of added.agent) if (values.quotaAgentBytes !== null && (usage.byAgent.get(w) ?? 0) + n > values.quotaAgentBytes) return new DomainError("unavailable", `${w} is over its storage quota (${values.quotaAgentBytes} bytes, ${usage.byAgent.get(w) ?? 0} used); the owner can raise it (retention.settings.set quotaAgentBytes) or delete something`);
    return undefined;
  };
  const apply = async (input: OperationInput): Promise<OperationResult> => {
    const critical = isCriticalOperation(input);
    if (!critical) {
      const refused = await refusal(input);
      // A repeat of an operation that already committed is answered with its stored result, which writes nothing, so a rule about new writes does not apply to it.
      if (refused !== undefined && (await storage.getOperation(input.operationId)) === undefined) throw refused;
    }
    try {
      const result = await storage.applyOperation(input);
      if (!critical) { const added = addedBy(input); options.meter.note(added.project, added.agent); }
      return result;
    } catch (error) {
      if (!isDiskFull(error)) throw error;
      if (!critical) throw error;
      const at = now();
      if (options.reserve === undefined || !(await options.reserve.release(at))) throw error;
      options.onReserveUsed?.(at);
      return storage.applyOperation(input);
    }
  };
  return new Proxy(storage, {
    get(target, prop) {
      if (prop === "applyOperation") return apply;
      if (prop === RAW) return target;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const RAW: unique symbol = Symbol("nimblenewt.unguarded-storage");
/** The storage under the guard (for tests that inject faults beneath it); the storage itself when it is not guarded. */
export const unguarded = (storage: ControllerStorage): ControllerStorage => (storage as unknown as Record<symbol, ControllerStorage | undefined>)[RAW] ?? storage;

/** Free and total bytes of the disk the path is on, or `undefined` when this system cannot say. */
export async function diskSpace(path: string): Promise<{ freeBytes: number; totalBytes: number } | undefined> {
  try { const s = await statfs(path); return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }; } catch { return undefined; }
}

import type { Aggregate, AggregateRef, ControllerStorage, JsonObject } from "../storage/index.js";
import { derivedId } from "../domain/ids.js";
import { DISPATCH_KIND, DISPATCH_LIVE } from "../dispatch/model.js";
import { readControllerAuthority } from "./controller.js";

/**
 * Workers held until reconciled (card K05, clause 3). After a controller promotion the successor's workers stay stopped until each worker host that held work of the fenced controller has been
 * reconciled. The hold is a durable record, written once per promotion at the successor's first start, before the dispatcher or the worker channel runs:
 *
 * - It lists the attempts that were running under the fenced epochs (the dispatch records whose `primaryEpoch` is at or below the promotion's fence epoch, or absent), with what the store said of
 *   each (host, placement, the worker sessions it was held in, its lease, whether a result the worker sent was stored). That list is kept as evidence; nothing in it is deleted by the hold.
 * - While it stands: no attempt starts (`startReason`, asked before every start by the dispatcher's start gate); a result a worker sent under a fenced epoch is not taken over (`adoptReason`); and a
 *   reconnecting worker's attempt of the list waits for the owner's decision even when reconnecting workers take their attempts up again by themselves (`heldForReaccept`).
 * - The facts that reconcile an attempt come from the existing records (card H09/H09b): its dispatch is over (ended by its lease, a stop, its result), or its placement was taken up again in a session
 *   of this controller after the owner approved it (`reconnect.reaccept`). A host is reconciled once every listed attempt on it is; the hold is released once every host is.
 *
 * Restart-safe: the record is read again by every controller process, and a restart neither starts the hold again nor forgets it. The hold of a later promotion is its own record.
 */
export const WORKERS_HOLD_KIND = "recovery-workers-hold";
const HOLD_FORMAT = 1;
/** Bounds: the attempts listed (the rest are counted as `truncated` and keep the hold up until none runs), the sessions kept per attempt, the hosts named in a refusal. */
export const WORKERS_HOLD_LIMITS = { attempts: 200, sessions: 2, namedHosts: 5, liveScan: 600 } as const;
const PLACEMENT_KIND = "remote-placement";
const SESSION_KIND = "remote-session";
const ID_TEXT = /^[\x21-\x7e]{1,200}$/;

export interface HeldAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly hostId: string;
  /** The epoch of the controller that started or last took the attempt over (null on records from before the field). */
  readonly primaryEpoch: number | null;
  readonly leaseUntil: string | null;
  /** The remote placement as it stood when the hold began (null for a local worker). */
  readonly placement: number | null;
  readonly placementState: string | null;
  /** The worker sessions the attempt was held in under the fenced controller: a take-up in any of them is not a decision of this controller. */
  readonly sessions: readonly string[];
  /** The worker had sent its result and the store kept it; it is not taken over while the hold stands. */
  readonly storedResult: boolean;
  readonly resolved?: { readonly how: "ended" | "taken-up"; readonly at: string; readonly detail: string };
}

export interface HeldHost {
  readonly hostId: string;
  readonly attempts: number;
  readonly reconciledAt?: string;
  /** Whether the host's worker had connected to this controller when the host was reconciled (its session was opened after the fence). */
  readonly reconnected?: boolean;
}

export interface WorkersHold {
  readonly format: 1;
  readonly promotionId: string;
  readonly successor: string;
  readonly fencedEpoch: number;
  readonly fenceEpoch: number;
  /** The epoch and time of the successor's start that began the hold. */
  readonly heldEpoch: number;
  readonly heldAt: string;
  readonly state: "held" | "released";
  readonly releasedAt?: string;
  readonly attempts: readonly HeldAttempt[];
  /** More attempts were running than are listed: the hold stays up until none of the fenced epochs runs any more. */
  readonly truncated: boolean;
  readonly hosts: readonly HeldHost[];
}

const holdRef = (promotionId: string): AggregateRef => ({ kind: WORKERS_HOLD_KIND, id: promotionId });
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const epochOf = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
const idText = (v: unknown): v is string => typeof v === "string" && ID_TEXT.test(v);
const isOld = (primaryEpoch: unknown, fenceEpoch: number): boolean => { const e = epochOf(primaryEpoch); return e === null || e <= fenceEpoch; };

/** The record as stored, checked field by field. A record that does not read holds everything (fail closed). */
export function parseWorkersHold(aggregate: Aggregate | undefined): WorkersHold | "unreadable" | undefined {
  if (aggregate === undefined) return undefined;
  const b = obj(aggregate.body);
  const count = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
  if (b === undefined || b["format"] !== HOLD_FORMAT || (b["state"] !== "held" && b["state"] !== "released") || !idText(b["promotionId"]) || !idText(b["successor"]) || !count(b["fencedEpoch"]) || !count(b["fenceEpoch"])
    || !count(b["heldEpoch"]) || typeof b["heldAt"] !== "string" || typeof b["truncated"] !== "boolean" || !Array.isArray(b["attempts"]) || !Array.isArray(b["hosts"])
    || (b["attempts"] as unknown[]).length > WORKERS_HOLD_LIMITS.attempts || (b["hosts"] as unknown[]).length > WORKERS_HOLD_LIMITS.attempts) return "unreadable";
  for (const a of b["attempts"] as unknown[]) {
    const x = obj(a);
    if (x === undefined || !idText(x["attemptId"]) || !idText(x["hostId"]) || typeof x["taskId"] !== "string" || !Array.isArray(x["sessions"]) || typeof x["storedResult"] !== "boolean"
      || (x["sessions"] as unknown[]).some((s) => typeof s !== "string")) return "unreadable";
  }
  for (const h of b["hosts"] as unknown[]) { const x = obj(h); if (x === undefined || !idText(x["hostId"]) || !count(x["attempts"])) return "unreadable"; }
  return b as unknown as WorkersHold;
}

/** The hold of the store's last promotion, when there is one (read only; for status). `unreadable` when the promotion record or the hold cannot be read. */
export async function readWorkersHold(storage: Pick<ControllerStorage, "getAggregate">): Promise<WorkersHold | "unreadable" | undefined> {
  const authority = await readControllerAuthority(storage);
  if (authority === "unreadable") return "unreadable";
  if (authority === undefined || authority.state !== "promoted") return undefined;
  return parseWorkersHold(await storage.getAggregate(holdRef(authority.promotionId)));
}

async function write(storage: ControllerStorage, epoch: number, at: string, current: Aggregate | undefined, body: WorkersHold, audit: { type: string; detail: JsonObject }): Promise<void> {
  const ref = holdRef(body.promotionId);
  await storage.applyOperation({
    operationId: `workers-hold:${body.promotionId}:${current?.revision ?? 0}`, epoch, actor: body.successor, correlationId: `workers-hold:${body.promotionId}`, at,
    changes: [current === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject }],
    audit: [{ type: audit.type, subject: ref, detail: audit.detail }],
    outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
  });
}

/** What the store says of the attempts of the fenced epochs that are running now. */
async function runningOld(storage: ControllerStorage, fenceEpoch: number, limit: number): Promise<{ found: { attemptId: string; body: Record<string, unknown> }[]; more: boolean }> {
  const live = obj((await storage.getAggregate(DISPATCH_LIVE))?.body);
  const ids = Array.isArray(live?.["ids"]) ? (live!["ids"] as unknown[]).filter(idText).slice(0, WORKERS_HOLD_LIMITS.liveScan) : [];
  const found: { attemptId: string; body: Record<string, unknown> }[] = [];
  let more = Array.isArray(live?.["ids"]) && (live!["ids"] as unknown[]).length > WORKERS_HOLD_LIMITS.liveScan;
  for (const attemptId of ids) {
    const body = obj((await storage.getAggregate({ kind: DISPATCH_KIND, id: derivedId("dpa", attemptId) }))?.body);
    if (body === undefined || body["state"] !== "running" || !isOld(body["primaryEpoch"], fenceEpoch)) continue;
    if (found.length >= limit) { more = true; break; }
    found.push({ attemptId, body });
  }
  return { found, more };
}

/**
 * Begins the hold at the successor's start, once per promotion: nothing is written when the store was never promoted, or when this promotion's hold exists (a restart keeps the hold as it is). Runs at the
 * successor's own epoch, before the dispatcher and the worker channel. With nothing of the fenced epochs running, the hold is written already released (the record still says so). Throws when the
 * record cannot be written: the start must not go on without it. A hold that exists and cannot be read is returned as `unreadable`, and the gate built on it holds everything.
 */
export async function beginWorkersHold(storage: ControllerStorage, epoch: number, now: () => string): Promise<WorkersHold | { readonly promotionId: string; readonly unreadable: true } | undefined> {
  const authority = await readControllerAuthority(storage);
  if (authority === "unreadable") throw new Error("the record of a controller promotion on this store cannot be read, so whether its workers are held is not known");
  if (authority === undefined || authority.state !== "promoted") return undefined;
  const current = await storage.getAggregate(holdRef(authority.promotionId));
  const parsed = parseWorkersHold(current);
  // A hold that does not read is not written over (it may hold what the store no longer shows): the controller starts with everything held, and the owner's view says why.
  if (parsed === "unreadable") return { promotionId: authority.promotionId, unreadable: true };
  if (parsed !== undefined) return parsed;
  const at = now();
  const { found, more } = await runningOld(storage, authority.fenceEpoch, WORKERS_HOLD_LIMITS.attempts);
  const attempts: HeldAttempt[] = [];
  for (const { attemptId, body } of found) {
    const p = obj((await storage.getAggregate({ kind: PLACEMENT_KIND, id: attemptId }))?.body);
    const hostId = idText(body["hostId"]) ? body["hostId"] : "unknown";
    const mine = p !== undefined && p["hostId"] === hostId;
    const reaccept = obj(p?.["reaccept"]);
    const sessions = mine ? [p!["sessionId"], reaccept?.["sessionId"]].filter((s): s is string => typeof s === "string" && s.length <= 200).slice(0, WORKERS_HOLD_LIMITS.sessions) : [];
    attempts.push({
      attemptId, taskId: typeof body["taskId"] === "string" ? (body["taskId"] as string).slice(0, 200) : "", hostId, primaryEpoch: epochOf(body["primaryEpoch"]),
      leaseUntil: typeof obj(body["lease"])?.["until"] === "string" ? String(obj(body["lease"])!["until"]).slice(0, 40) : null,
      placement: mine && Number.isSafeInteger(p!["placement"]) ? (p!["placement"] as number) : null, placementState: mine && typeof p!["state"] === "string" ? String(p!["state"]).slice(0, 20) : null,
      sessions: [...new Set(sessions)], storedResult: mine && p!["state"] === "completed" && p!["result"] !== undefined,
    });
  }
  const hosts = [...new Set(attempts.map((a) => a.hostId))].sort().map((hostId) => ({ hostId, attempts: attempts.filter((a) => a.hostId === hostId).length }));
  const released = attempts.length === 0 && !more;
  const body: WorkersHold = {
    format: HOLD_FORMAT, promotionId: authority.promotionId, successor: authority.successor, fencedEpoch: authority.fencedEpoch, fenceEpoch: authority.fenceEpoch, heldEpoch: epoch, heldAt: at,
    state: released ? "released" : "held", ...(released ? { releasedAt: at } : {}), attempts, truncated: more, hosts,
  };
  await write(storage, epoch, at, undefined, body, { type: released ? "controller.workers.released" : "controller.workers.held", detail: { promotionId: body.promotionId, attempts: attempts.length, hosts: hosts.length, truncated: more } });
  return body;
}

/**
 * The hold as one controller process uses it. Every answer reads the record (a released hold is remembered, it never comes back for the same promotion); an unreadable record holds everything.
 */
export class WorkersHoldGate {
  #released = false;
  constructor(private readonly storage: ControllerStorage, private readonly epoch: number, private readonly promotionId: string | undefined, private readonly now: () => string) {}

  /** For a controller that was not started after a promotion, or whose promotion's hold was released. */
  static none(): WorkersHoldGate { const g = new WorkersHoldGate(undefined as never, 0, undefined, () => ""); g.#released = true; return g; }

  async #read(): Promise<{ hold: WorkersHold; aggregate: Aggregate } | "unreadable" | undefined> {
    if (this.#released || this.promotionId === undefined) return undefined;
    let aggregate: Aggregate | undefined;
    try { aggregate = await this.storage.getAggregate(holdRef(this.promotionId)); } catch { return "unreadable"; }
    const hold = parseWorkersHold(aggregate);
    // The hold of this controller's promotion was written at its start: a missing one was removed, which holds everything.
    if (hold === undefined || hold === "unreadable" || hold.promotionId !== this.promotionId) return "unreadable";
    if (hold.state === "released") { this.#released = true; return undefined; }
    return { hold, aggregate: aggregate! };
  }

  /** Why no attempt may start now, or undefined. */
  async startReason(): Promise<string | undefined> {
    const r = await this.#read();
    if (r === undefined) return undefined;
    if (r === "unreadable") return "the record of the workers held after the controller promotion cannot be read, so no work starts";
    const open = r.hold.hosts.filter((h) => h.reconciledAt === undefined);
    const named = open.slice(0, WORKERS_HOLD_LIMITS.namedHosts).map((h) => h.hostId).join(", ");
    const hosts = open.length === 0 ? "attempts of the fenced controller are still running beyond the ones listed" : `${open.length} worker host${open.length === 1 ? " is" : "s are"} not reconciled yet (${named}${open.length > WORKERS_HOLD_LIMITS.namedHosts ? `, and ${open.length - WORKERS_HOLD_LIMITS.namedHosts} more` : ""})`;
    return `the controller was promoted (promotion ${r.hold.promotionId}) and its workers stay stopped until they are reconciled: ${hosts}; each held attempt ends, or is taken up again once you approve it (reconnect.pending)`;
  }

  /** Why the dispatcher must not take this running attempt over now, or undefined: a result its worker sent under a fenced epoch is not taken while the hold stands. */
  async adoptReason(attempt: { readonly attemptId: string; readonly primaryEpoch?: number }): Promise<string | undefined> {
    const r = await this.#read();
    if (r === undefined) return undefined;
    if (r === "unreadable") return "the record of the workers held after the controller promotion cannot be read";
    if (!isOld(attempt.primaryEpoch, r.hold.fenceEpoch)) return undefined;
    const p = obj((await this.storage.getAggregate({ kind: PLACEMENT_KIND, id: attempt.attemptId }))?.body);
    if (p?.["state"] === "completed" && p["result"] !== undefined) return `attempt ${attempt.attemptId} has a result from the fenced controller's time; it is kept as evidence and not taken while the workers are held`;
    return undefined;
  }

  /** Whether a reconnecting worker's attempt must wait for the owner's decision whatever the reconnect setting says. Fails closed. */
  async heldForReaccept(attemptId: string): Promise<boolean> {
    let r;
    try { r = await this.#read(); } catch { return true; }
    if (r === undefined) return false;
    if (r === "unreadable") return true;
    const listed = r.hold.attempts.find((a) => a.attemptId === attemptId);
    if (listed === undefined) return r.hold.truncated;
    return listed.resolved === undefined;
  }

  /**
   * Looks at each held attempt that is not reconciled yet and records what the store now says: over, or taken up again after the owner's approval. Records each host whose attempts are all reconciled, and
   * releases the hold when every host is (and nothing of the fenced epochs runs beyond the list). Bounded by the list; writes only when something changed. A write that loses a race is tried at the next call.
   */
  async review(): Promise<WorkersHold | undefined> {
    const r = await this.#read();
    if (r === undefined) return undefined;
    if (r === "unreadable") throw new Error("the record of the workers held after the controller promotion cannot be read");
    const { hold, aggregate } = r;
    const at = this.now();
    let changed = false;
    const attempts: HeldAttempt[] = [];
    for (const a of hold.attempts) {
      if (a.resolved !== undefined) { attempts.push(a); continue; }
      const resolved = await this.#factOf(a);
      if (resolved === undefined) { attempts.push(a); continue; }
      changed = true;
      attempts.push({ ...a, resolved: { ...resolved, at } });
    }
    const reconciled: string[] = [];
    const hosts: HeldHost[] = [];
    for (const h of hold.hosts) {
      if (h.reconciledAt !== undefined || attempts.some((a) => a.hostId === h.hostId && a.resolved === undefined)) { hosts.push(h); continue; }
      const s = obj((await this.storage.getAggregate({ kind: SESSION_KIND, id: h.hostId }))?.body);
      const e = epochOf(s?.["primaryEpoch"]);
      hosts.push({ ...h, reconciledAt: at, reconnected: e !== null && e > hold.fenceEpoch });
      reconciled.push(h.hostId);
      changed = true;
    }
    const allDone = hosts.every((h) => h.reconciledAt !== undefined) && (!hold.truncated || !(await this.#oldBeyondList(attempts)));
    if (!changed && !allDone) return hold;
    const next: WorkersHold = { ...hold, attempts, hosts, ...(allDone ? { state: "released" as const, releasedAt: at } : {}) };
    try {
      await write(this.storage, this.epoch, at, aggregate, next, allDone
        ? { type: "controller.workers.released", detail: { promotionId: hold.promotionId, hosts: hosts.length, attempts: attempts.length } }
        : { type: reconciled.length > 0 ? "controller.workers.reconciled" : "controller.workers.resolved", detail: { promotionId: hold.promotionId, hosts: reconciled.slice(0, 20), resolved: attempts.filter((a) => a.resolved !== undefined).length } });
    } catch (error) {
      if ((error as { kind?: unknown })?.kind === "state_conflict" || (error as { code?: unknown })?.code === "state_conflict") return hold;
      throw error;
    }
    if (allDone) this.#released = true;
    return next;
  }

  /** The reconciliation fact of one held attempt, read from the dispatch record and its placement; undefined while it is still open. */
  async #factOf(a: HeldAttempt): Promise<{ how: "ended" | "taken-up"; detail: string } | undefined> {
    const d = obj((await this.storage.getAggregate({ kind: DISPATCH_KIND, id: derivedId("dpa", a.attemptId) }))?.body);
    if (d === undefined) return { how: "ended", detail: "its dispatch record is gone" };
    if (d["state"] === "finished") {
      const status = obj(d["outcome"])?.["status"];
      return { how: "ended", detail: `it ended (${typeof status === "string" ? status.slice(0, 20) : "finished"})` };
    }
    const p = a.placement === null ? undefined : obj((await this.storage.getAggregate({ kind: PLACEMENT_KIND, id: a.attemptId }))?.body);
    const live = p !== undefined && p["hostId"] === a.hostId && p["placement"] === a.placement && (p["state"] === "offered" || p["state"] === "accepted");
    // Put back to wait (a move, a quiesce) with no worker holding its run: no worker of the fenced controller runs it any more; it starts again only through this controller's start gate.
    if (d["state"] !== "running" && !live) return { how: "ended", detail: `it no longer runs on a worker (${typeof d["state"] === "string" ? String(d["state"]).slice(0, 20) : "not running"})` };
    // Only a run its worker had accepted under the fenced controller can be taken up again; an offer it made, or a result it was sent, is reconciled only by the attempt's end.
    if (a.placement === null || a.placementState !== "accepted") return undefined;
    if (p === undefined || p["hostId"] !== a.hostId || p["placement"] !== a.placement) return undefined;
    const reaccept = obj(p["reaccept"]);
    const fresh = (s: unknown): boolean => typeof s === "string" && !a.sessions.includes(s);
    if (p["state"] === "accepted" && fresh(p["sessionId"])) return { how: "taken-up", detail: "its worker took it up again in a session of this controller" };
    if (p["state"] === "accepted" && reaccept?.["state"] === "approved" && typeof reaccept["by"] === "string" && fresh(reaccept["sessionId"])) return { how: "taken-up", detail: "you approved taking it up again" };
    return undefined;
  }

  /** Whether an attempt of the fenced epochs runs that the list does not hold (only asked when the list was cut). */
  async #oldBeyondList(attempts: readonly HeldAttempt[]): Promise<boolean> {
    const hold = (await this.#read());
    if (hold === undefined) return false;
    if (hold === "unreadable") return true;
    const listed = new Set(attempts.map((a) => a.attemptId));
    const { found, more } = await runningOld(this.storage, hold.hold.fenceEpoch, WORKERS_HOLD_LIMITS.attempts + listed.size + 1);
    return more || found.some((f) => !listed.has(f.attemptId));
  }
}

/** The gate for a controller that has just started: the hold `beginWorkersHold` returned (none when the store was never promoted; a released hold holds nothing). */
export function workersHoldGate(storage: ControllerStorage, epoch: number, hold: WorkersHold | { readonly promotionId: string; readonly unreadable: true } | undefined, now: () => string): WorkersHoldGate {
  return hold === undefined || ("state" in hold && hold.state === "released") ? WorkersHoldGate.none() : new WorkersHoldGate(storage, epoch, hold.promotionId, now);
}

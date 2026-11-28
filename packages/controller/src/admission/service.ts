import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, text } from "../domain/model.js";
import { CommandRunner, type CommandMeta, type RunnerOptions } from "../domain/runner.js";
import { CAPS_REF, capsOf } from "./caps.js";
import { ConfigurationService } from "../configuration/configuration.js";
import { scopedCommandId } from "../security/credentials.js";
import { redactText } from "../security/redact.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import {
  BORROWS_KEPT, borrowAt, borrowEnd, borrowRestUntil, type ActiveBorrow, type Borrow,
  DEFAULT_LIMITS, EMPTY_STATE, LIMIT_BOUNDS, WITHDRAWN_KEPT, balancePlaces, balanceWaitReason, blockers, checkLimits, workClassOf, descendants, laneOf, order, promote, waitReason, capWaitReason, type AdmissionState, type Balance, type BalancePlaces, type Capacity, type Entry, type Limits, type RequestClass, type WorkClass,
} from "./policy.js";

/** The P/PC allocation settings admission reads (card B01). Only figures the owner set count: with neither set there is no allocation and admission is as before. */
export const BALANCE_KEYS = ["workClass.pcFloor", "workClass.pcCeiling"] as const;
/** How many lent places the balance view lists. */
export const BALANCE_LENT_SHOWN = 20;
export type BalanceReader = () => Promise<Balance | undefined>;

/** The allocation from a reader of installation settings (`ConfigurationService.installationSettings`). A figure that is not a whole percentage, or a floor above the ceiling, is damage: it throws. */
export function balanceFromSettings(read: (keys: readonly string[]) => Promise<Readonly<Record<string, { readonly value: unknown; readonly set: boolean }>>>): BalanceReader {
  return async () => {
    const got = await read(BALANCE_KEYS);
    const figure = (key: string): number | undefined => {
      const e = Object.hasOwn(got, key) ? got[key] : undefined;
      if (e === undefined || !e.set) return undefined;
      if (typeof e.value !== "number" || !Number.isSafeInteger(e.value) || e.value < 0 || e.value > 100) throw new DomainError("integrity", `the P/PC allocation setting ${key} is not a whole percentage`);
      return e.value;
    };
    const floor = figure("workClass.pcFloor"), ceiling = figure("workClass.pcCeiling");
    if (floor === undefined && ceiling === undefined) return undefined;
    const b = { floor: floor ?? 0, ceiling: ceiling ?? 100 };
    if (b.floor > b.ceiling) throw new DomainError("integrity", `the P/PC allocation floor (${b.floor}%) is above its ceiling (${b.ceiling}%)`);
    return b;
  };
}

/** The longest one emergency borrow of the improvement reserve may last, in hours (card B01; ASSUMPTION: three days, reversible). */
export const BORROW_MAX_HOURS = 72;
/** How long after a borrow's end its review date may lie, in days. */
export const BORROW_REVIEW_DAYS = 30;
const HOUR_MS = 3_600_000;
const BORROW_ID = /^brw-[a-z2-7]{20}$/;
/** A full ISO time (date, time and Z or an offset), as an emergency borrow's times must be given: a bare date would be read as a UTC day, which is not the owner's day. */
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const instant = (v: unknown, field: string): string => {
  const m = typeof v === "string" ? INSTANT.exec(v) : null;
  // A day the calendar does not have (2026-02-30, which Date.parse reads as 2 March) and hour 24 are refused, never moved to another day.
  const [y, mo, d, h, mi, s, oh, om] = (m ?? []).slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const day = new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1));
  if (m === null || mo! < 1 || mo! > 12 || day.getUTCMonth() !== mo! - 1 || day.getUTCDate() !== d || h! > 23 || mi! > 59 || s! > 59 || oh! > 23 || om! > 59 || !Number.isFinite(Date.parse(v as string))) {
    return invalid(field, "must be a date and time with its time zone, such as 2026-11-28T18:00:00-05:00");
  }
  return new Date(Date.parse(v as string)).toISOString();
};

/** One emergency borrow as the owner reviews it: what was directed and what it did (`taken`: production attempts it let in that would otherwise have been held for waiting improvement work). */
export interface BorrowView {
  readonly id: string; readonly reason: string; readonly places: number; readonly project?: string;
  readonly from: string; readonly until: string; readonly reviewBy: string; readonly endedAt?: string;
  readonly taken: number;
  /** Of those, how many still run (places come back as attempts end; never more production in reserved places than the borrow lends). */
  readonly running: number;
}

/** What the owner is told about the P/PC balance of admission now (card B01). */
export interface BalanceView {
  /** The emergency borrow in force now, with how many reserved places it lends now (never more than the floor keeps). */
  readonly borrow?: BorrowView & { readonly lends: number };
  /** The newest borrow that has ended, for its review, and when the floor may be lent again. */
  readonly lastBorrow?: BorrowView & { readonly ended: string; readonly againFrom: string };
  /** Set when the stored borrows cannot be read: nothing new is admitted until they are repaired. */
  readonly borrowProblem?: string;
  /** The allocation in force, in percent; absent when the owner set none (nothing is reserved or capped by class). */
  readonly allocation?: Balance;
  readonly places: BalancePlaces & { readonly productive: number };
  readonly running: { readonly P: number; readonly PC: number };
  readonly waiting: { readonly P: number; readonly PC: number };
  /** Production attempts running in places lent from the improvement reserve, oldest first (at most `BALANCE_LENT_SHOWN`), with why. */
  readonly lent: readonly { readonly requestId: string; readonly at: string; readonly reason: string }[];
  readonly lentTotal: number;
  /** Of `lentTotal`, those that took their place under an emergency borrow while improvement work could have used it. */
  readonly borrowedTotal: number;
  /** Set when improvement work waits while fewer of its reserved places are in use than the allocation keeps: how many are short and why. */
  readonly unmet?: { readonly short: number; readonly cause: string };
  readonly revision: number;
}

const STATE: AggregateRef = { kind: "admission-state", id: "admission" };
const CLASSES: readonly RequestClass[] = ["productive", "inquiry", "review", "landing"];
const REQUEST_ID = /^req-[a-z2-7]{20}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/;
const HOST_ID = /^host:[a-z0-9][a-z0-9-]{0,39}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const BALANCE_DAMAGED = "waiting for capacity: the owner's P/PC allocation setting cannot be read, nothing new starts until it is repaired";
const BORROWS_DAMAGED_TEXT = "the emergency borrows stored in the admission record are damaged";
const BORROWS_DAMAGED = `waiting for capacity: ${BORROWS_DAMAGED_TEXT}, nothing new starts until they are repaired`;

/** The admission limits the owner sets as host and global quotas (card H10). The spawn limits of attempts (`depth`, `children`) and `patience` stay the start-up figures. */
export const QUOTA_NAMES = ["productive", "perHost", "control", "queue"] as const;
export type QuotaName = (typeof QUOTA_NAMES)[number];
export type QuotaFigures = { readonly [K in QuotaName]: number };
const pickQuotas = (l: Limits): QuotaFigures => ({ productive: l.productive, perHost: l.perHost, control: l.control, queue: l.queue });

/** A host's declared CPUs and memory, checked. */
function checkCapacity(value: unknown, field: string): Capacity {
  const c = value as Record<string, unknown> | undefined;
  if (c === undefined || c === null || typeof c !== "object" || Array.isArray(c)) invalid(field, "must be an object with cpus and memoryMb");
  for (const key of Object.keys(c!)) if (key !== "cpus" && key !== "memoryMb") invalid(`${field}.${key}`, "is not a capacity field");
  const cpus = c!["cpus"];
  const memoryMb = c!["memoryMb"];
  if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus <= 0 || cpus > 1024) invalid(`${field}.cpus`, "must be a number above 0 and at most 1024");
  if (!Number.isSafeInteger(memoryMb) || (memoryMb as number) < 1 || (memoryMb as number) > 4_194_304) invalid(`${field}.memoryMb`, "must be a whole number of megabytes from 1 to 4194304");
  return { cpus: cpus as number, memoryMb: memoryMb as number };
}

export interface RequestAdmission extends CommandMeta {
  readonly class: RequestClass;
  /** P (production, the default) or PC (improvement), from the task's contract (card B01). Only productive work has one. */
  readonly workClass?: WorkClass;
  readonly priority?: number;
  /** The host the work runs on (required for productive work). */
  readonly host?: string;
  readonly cpus: number;
  readonly memoryMb: number;
  /** The running request that is starting this one. */
  readonly parent?: string;
  /** Who and what the work belongs to, for the owner's optional caps (project, agent, and the supervising agent that receives its report; reviewers are not counted). */
  readonly project?: string;
  readonly agent?: string;
  readonly reportsTo?: string;
}

export type Where = { readonly state: "running"; readonly entry: Entry } | { readonly state: "waiting"; readonly entry: Entry; readonly position?: number; /** Why it waits ("waiting for capacity: ..."); absent when only order holds it back. */ readonly reason?: string; /** Set only when one of the owner's capacity caps (per project, per agent, fan-in) is full, whatever else also holds it. */ readonly capReason?: string; /** Set only when the owner's P/PC allocation holds it (card B01), whatever else also holds it. */ readonly balanceReason?: string } | { readonly state: "withdrawn"; readonly reason: string } | { readonly state: "absent" };

/**
 * Priority admission and reserved control capacity (card H03). One small durable record holds what is running and what waits, so every decision is made on the whole picture in a single
 * guarded step and survives a restart. The initial limits are the owner's (decision D6): four productive attempts in total, two per host, and two places reserved for inquiries and reviews
 * that productive work can never occupy; a host's CPUs and memory are counted too. The queue is bounded, a full queue refuses instead of growing, and nothing starts without being counted:
 * an attempt may start others only up to a depth and a number of live children, so spawning cannot run away.
 *
 * Stopping and revoking never wait for a place: `release` frees capacity without needing any, so a saturated system can always be stopped.
 */
export class AdmissionService {
  readonly #runner: CommandRunner;
  readonly #balanceReader: BalanceReader;

  private constructor(runner: CommandRunner, balance: BalanceReader) {
    this.#runner = runner;
    this.#balanceReader = balance;
  }

  /** `balance` reads the owner's P/PC allocation (card B01); by default the installation settings on the same storage, so every controller's admission reads the same figures. */
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { balance?: BalanceReader } = {}): AdmissionService {
    const { balance, ...rest } = options;
    const configuration = balance === undefined ? ConfigurationService.withEpoch(storage, epoch) : undefined;
    return new AdmissionService(new CommandRunner(storage, epoch, rest), balance ?? balanceFromSettings((keys) => configuration!.installationSettings(keys)));
  }

  /** Asks to start something. It is admitted at once if a place is free, otherwise it waits in order; a full queue or a spawn beyond the limits is refused. */
  async request(command: RequestAdmission): Promise<{ id: string; state: "running" | "waiting" | "released"; replayed: boolean }> {
    const result = await this.#retrying(() => this.#runner.command("admission.request", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "class", "workClass", "priority", "host", "cpus", "memoryMb", "parent", "project", "agent", "reportsTo"]);
      const label = (v: unknown, field: string): string | undefined => (v === undefined ? undefined : typeof v === "string" && LABEL.test(v) ? v : invalid(field, "is not a valid ID"));
      const project = label(command.project, "project"), agent = label(command.agent, "agent"), reportsTo = label(command.reportsTo, "reportsTo");
      const cls = CLASSES.includes(command.class) ? command.class : invalid("class", `must be one of ${CLASSES.join(", ")}`);
      const priority = command.priority === undefined ? 5 : command.priority;
      if (!Number.isSafeInteger(priority) || priority < 0 || priority > 9) invalid("priority", "must be a whole number from 0 to 9");
      const host = command.host === undefined ? undefined : (typeof command.host === "string" && HOST_ID.test(command.host) ? command.host : invalid("host", "is not a host ID"));
      if (cls === "productive" && host === undefined) invalid("host", "is required for productive work");
      // A landing attempt is an integrator's for one project's landing branch (card P10b): the project it lands is named, so what holds the reserved places is known.
      if (cls === "landing" && project === undefined) invalid("project", "is required for a landing attempt");
      const workClass = command.workClass === undefined ? undefined : command.workClass === "P" || command.workClass === "PC" ? command.workClass : invalid("workClass", "must be P or PC");
      if (workClass !== undefined && cls !== "productive") invalid("workClass", "only productive work is production or improvement work; inquiries and reviews are neither");
      const cpus = command.cpus;
      const memoryMb = command.memoryMb;
      if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus <= 0 || cpus > 1024) invalid("cpus", "must be a number above 0 and at most 1024");
      if (!Number.isSafeInteger(memoryMb) || memoryMb < 1 || memoryMb > 4_194_304) invalid("memoryMb", "must be a whole number of megabytes from 1 to 4194304");
      const parent = command.parent === undefined ? undefined : (typeof command.parent === "string" && REQUEST_ID.test(command.parent) ? command.parent : invalid("parent", "is not a request ID"));
      const id = derivedId("req", meta.commandId);
      return {
        payload: { class: cls, ...(workClass === undefined ? {} : { workClass }), priority, ...(host === undefined ? {} : { host }), cpus: cpus as number, memoryMb: memoryMb as number, ...(parent === undefined ? {} : { parent }), ...(project === undefined ? {} : { project }), ...(agent === undefined ? {} : { agent }), ...(reportsTo === undefined ? {} : { reportsTo }) },
        build: async () => {
          const loaded = await this.#load();
          const revision = loaded.revision;
          const state = await this.#prepare(loaded.state);
          // An unreadable caps record stops new requests (nothing starts on a guess); release and the other decisions below never depend on it.
          const caps = await this.#caps();
          const balance = await this.#balance();
          if ([...state.running, ...state.queue].some((e) => e.id === id)) throw new DomainError("command_conflict", `request ${id} already exists`);
          const depth = parent === undefined ? 0 : await this.#childDepth(state, parent);
          if (depth > state.limits.depth) throw new DomainError("invalid_command", `starting this would make a chain of ${depth} attempts starting attempts; the limit is ${state.limits.depth}`, { field: "parent" });
          if (parent !== undefined && [...state.running, ...state.queue].filter((e) => e.parent === parent).length >= state.limits.children) throw new DomainError("invalid_command", `that attempt has already started ${state.limits.children} that are still live; the limit is ${state.limits.children}`, { field: "parent" });
          if (host !== undefined) await this.#requireActiveHost(host);
          if (host !== undefined && cls === "productive" && !Object.hasOwn(state.capacity, host)) throw new DomainError("invalid_command", `no capacity has been declared for ${host}`, { field: "host" });
          if (host !== undefined && cls === "productive") {
            const cap = state.capacity[host]!;
            if ((cpus as number) > cap.cpus || (memoryMb as number) > cap.memoryMb) throw new DomainError("invalid_command", `${host} can never run a request of ${cpus} CPUs and ${memoryMb} MB (it has ${cap.cpus} and ${cap.memoryMb})`, { field: "cpus" });
          }
          const entry: Entry = { id, class: cls, ...(workClass === undefined ? {} : { workClass }), priority, ...(host === undefined ? {} : { host }), cpus: cpus as number, memoryMb: memoryMb as number, ...(parent === undefined ? {} : { parent }), ...(project === undefined ? {} : { project }), ...(agent === undefined ? {} : { agent }), ...(reportsTo === undefined ? {} : { reportsTo }), depth, seq: state.nextSeq, skipped: 0, at: this.#runner.now() };
          const queued: AdmissionState = { ...state, queue: [...state.queue, entry], nextSeq: state.nextSeq + 1 };
          // A damaged borrow record stops new requests like a damaged caps record (it throws `integrity`).
          const after = this.#admit(queued, caps, balance);
          // The bound is on what is left waiting: a request that is admitted at once never sat in the queue. Each lane is bounded on its own (card P10b), so a queue full of productive work never refuses an
          // inquiry, a review or a landing, which have places of their own.
          if (after.queue.filter((e) => laneOf(e.class) === laneOf(cls)).length > state.limits.queue) throw new DomainError("unavailable", `the queue is full (${state.limits.queue} waiting); try again later`);
          return this.#built(revision, after, { request: id, class: cls });
        },
      };
    }));
    // The command is recorded against the shared state; the request's own ID is derived from the command ID.
    const id = derivedId("req", command.commandId);
    const where = await this.where(id);
    // "released": this was a repeat of a request that has since finished or been withdrawn.
    return { id, state: where.state === "running" ? "running" : where.state === "waiting" ? "waiting" : "released", replayed: result.replayed };
  }

  /**
   * Gives a request's place back (it finished, failed, was stopped or revoked) or withdraws it from the queue. It needs no capacity, so it works however saturated the system is. Anything
   * the request started that is still waiting is withdrawn with it; what is already running is left alone (it is stopped by its own release). Waiting requests that now fit are admitted.
   */
  async release(command: CommandMeta & { requestId: string; reason: string }): Promise<{ id: string; replayed: boolean }> {
    const result = await this.#retrying(() => this.#runner.command("admission.release", command, async () => {
      onlyKnown(command, ["commandId", "actor", "requestId", "reason"]);
      const requestId = typeof command.requestId === "string" && REQUEST_ID.test(command.requestId) ? command.requestId : invalid("requestId", "is not a request ID");
      const reason = text(command.reason, "reason", { min: 1, max: 300 });
      return {
        payload: { requestId, reason },
        build: async () => {
          const loaded = await this.#load();
          const revision = loaded.revision;
          const state = await this.#prepare(loaded.state);
          if (![...state.running, ...state.queue].some((e) => e.id === requestId)) throw new DomainError("not_found", `request ${requestId} is not running or waiting`);
          const dropped = descendants(state.queue, requestId);
          dropped.add(requestId);
          const next: AdmissionState = { ...state, running: state.running.filter((e) => e.id !== requestId), queue: state.queue.filter((e) => !dropped.has(e.id)) };
          return this.#built(revision, (await this.#promote(next)), { request: requestId, reason, withdrawn: dropped.size - 1 });
        },
      };
    }));
    return { id: command.requestId, replayed: result.replayed };
  }

  /** The owner changes the limits. Running work is never stopped by a lower limit; the system simply admits nothing new until it is under the limit. */
  async setLimits(command: CommandMeta & { limits: Limits }): Promise<void> {
    await this.#retrying(() => this.#runner.command("admission.limits", command, async () => {
      onlyKnown(command, ["commandId", "actor", "limits"]);
      const limits = checkLimits(command.limits);
      return {
        payload: { limits: limits as unknown as JsonObject },
        build: async () => {
          const loaded = await this.#load();
          const state = await this.#prepare(loaded.state);
          return this.#built(loaded.revision, (await this.#promote({ ...state, limits })), { limits: limits as unknown as JsonObject });
        },
      };
    }));
  }

  /** The owner declares what a host can run (CPUs and memory). Requests for a host with no declared capacity are refused. */
  async setCapacity(command: CommandMeta & { host: string; capacity: Capacity }): Promise<void> {
    await this.#retrying(() => this.#runner.command("admission.capacity", command, async () => {
      onlyKnown(command, ["commandId", "actor", "host", "capacity"]);
      const host = typeof command.host === "string" && HOST_ID.test(command.host) ? command.host : invalid("host", "is not a host ID");
      const { cpus, memoryMb } = checkCapacity(command.capacity, "capacity");
      return {
        payload: { host, cpus: cpus as number, memoryMb: memoryMb as number },
        build: async () => {
          const loaded = await this.#load();
          const revision = loaded.revision;
          const state = loaded.state;
          if (Object.keys(state.capacity).length >= 200 && !Object.hasOwn(state.capacity, host)) throw new DomainError("invalid_command", "at most 200 hosts are tracked", { field: "host" });
          await this.#requireActiveHost(host);
          const next: AdmissionState = { ...state, capacity: { ...state.capacity, [host]: { cpus: cpus as number, memoryMb: memoryMb as number } } };
          // Waiting requests that can no longer fit the lowered capacity are withdrawn (with the reason on record) rather than left to wait for ever.
          const prepared = await this.#prepare(next);
          return this.#built(revision, (await this.#promote(prepared)), { host, cpus: cpus as number, memoryMb: memoryMb as number, withdrawn: prepared.withdrawn.length - next.withdrawn.length });
        },
      };
    }));
  }

  /**
   * The host and global quotas as the owner sees them (card H10): the limits in force (productive attempts in total and per host, places reserved for inquiries and reviews, the queue),
   * each host's declared CPUs and memory, and what holds them now. Owner only.
   */
  async quotas(by: Principal): Promise<{ readonly revision: number; readonly limits: QuotaFigures; readonly defaults: QuotaFigures; readonly hosts: Readonly<Record<string, Capacity>>; readonly running: { readonly productive: number; readonly control: number; readonly perHost: Readonly<Record<string, number>> }; readonly waiting: number }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the capacity quotas`);
    const { state, revision } = await this.#load();
    const perHost: Record<string, number> = {};
    for (const e of state.running) if (laneOf(e.class) === "productive" && e.host !== undefined) perHost[e.host] = (perHost[e.host] ?? 0) + 1;
    return {
      revision, limits: pickQuotas(state.limits), defaults: pickQuotas(DEFAULT_LIMITS), hosts: state.capacity,
      running: { productive: state.running.filter((e) => laneOf(e.class) === "productive").length, control: state.running.filter((e) => laneOf(e.class) === "control").length, perHost },
      waiting: state.queue.length,
    };
  }

  /**
   * The owner changes the host and global quotas (card H10): `set` names any of `productive` (attempts at once in total), `perHost`, `control` (places only inquiries and reviews may use)
   * and `queue`; `hosts` declares hosts' CPUs and memory. One guarded step on the admission record, replay-safe by command ID. A lower figure stops nothing that runs: nothing new starts
   * until the work is under it, and waiting requests a host can no longer hold are withdrawn with the reason. A higher one lets waiting work in at once.
   */
  async changeQuotas(by: Principal, command: NoActor & { set?: unknown; hosts?: unknown }): Promise<{ revision: number }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not change the capacity quotas`);
    onlyKnown(command, ["commandId", "set", "hosts"]);
    const set: Partial<Record<QuotaName, number>> = {};
    if (command.set !== undefined) {
      if (command.set === null || typeof command.set !== "object" || Array.isArray(command.set)) invalid("set", `must be an object such as { "perHost": 1 } (${QUOTA_NAMES.join(", ")})`);
      for (const [k, v] of Object.entries(command.set as object)) {
        if (!(QUOTA_NAMES as readonly string[]).includes(k)) invalid("set", `${k.slice(0, 30)} is not a quota (${QUOTA_NAMES.join(", ")})`);
        const [lo, hi] = LIMIT_BOUNDS[k as QuotaName];
        set[k as QuotaName] = typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi ? v : invalid(`set.${k}`, `must be a whole number from ${lo} to ${hi}`);
      }
    }
    const hosts: Record<string, Capacity> = {};
    if (command.hosts !== undefined) {
      if (command.hosts === null || typeof command.hosts !== "object" || Array.isArray(command.hosts)) invalid("hosts", "must be an object such as { \"host:pc\": { \"cpus\": 8, \"memoryMb\": 16384 } }");
      const entries = Object.entries(command.hosts as object);
      if (entries.length > 50) invalid("hosts", "declare at most 50 hosts in one change");
      for (const [h, c] of entries) hosts[HOST_ID.test(h) ? h : invalid("hosts", `${h.slice(0, 50)} is not a host ID`)] = checkCapacity(c, `hosts.${h}`);
    }
    if (Object.keys(set).length === 0 && Object.keys(hosts).length === 0) invalid("set", "name at least one quota to set or one host to declare");
    const result = await this.#retrying(() => this.#runner.command("admission.quotas", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { set: set as unknown as JsonObject, hosts: hosts as unknown as JsonObject },
      build: async () => {
        const loaded = await this.#load();
        const limits = checkLimits({ ...loaded.state.limits, ...set });
        for (const h of Object.keys(hosts)) await this.#requireActiveHost(h);
        const capacity = { ...loaded.state.capacity, ...hosts };
        if (Object.keys(capacity).length > 200) invalid("hosts", "at most 200 hosts are tracked");
        const prepared = await this.#prepare({ ...loaded.state, limits, capacity });
        return this.#built(loaded.revision, (await this.#promote(prepared)), { set: set as unknown as JsonObject, hosts: Object.keys(hosts) });
      },
    })));
    return { revision: result.revision };
  }

  /**
   * The owner's emergency borrow of the improvement reserve (card B01, second slice), owner only. Starting one needs the owner's explicit direction: `reason` (1 to 300 characters), `places` (how
   * many of the places the floor keeps; at most as many as it keeps now), `until` (a time after now, at most `BORROW_MAX_HOURS` away), `reviewBy` (on or after `until`, at most `BORROW_REVIEW_DAYS`
   * after it) and, to lend only to one project's production work, `projectId`. Nothing else changes: the ceiling stays, nothing running is stopped, ownership never moves, and the borrow counts from
   * this decision (waiting production work it covers is let in at once). `end: true` ends the borrow in force now; the places it lent come back as their attempts end.
   *
   * Repeated urgency cannot remove the floor: one borrow at a time, never extended, and after it ends the floor stands again for at least as long as it was lent before another can start. Every
   * refusal says why and names the owner's way out (lower `workClass.pcFloor` itself, a setting the owner sees first). Stored in the admission record, so it survives a restart and expires by the clock.
   */
  async borrow(by: Principal, command: NoActor & { reason?: unknown; places?: unknown; projectId?: unknown; until?: unknown; reviewBy?: unknown; end?: unknown }): Promise<{ borrowId: string; ended: boolean; until: string; reviewBy: string; againFrom?: string; revision: number; replayed: boolean }> {
    if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not borrow the improvement reserve`);
    onlyKnown(command, ["commandId", "reason", "places", "projectId", "until", "reviewBy", "end"]);
    const ending = command.end === true;
    if (command.end !== undefined && command.end !== true) invalid("end", "must be true to end the borrow in force, or left out to start one");
    let payload: JsonObject;
    if (ending) {
      for (const k of ["reason", "places", "projectId", "until", "reviewBy"] as const) if (command[k] !== undefined) invalid(k, "is not used when ending a borrow (end true takes nothing else)");
      payload = { end: true };
    } else {
      const reason = text(command.reason, "reason", { min: 1, max: 300 });
      const places = Number.isSafeInteger(command.places) && (command.places as number) >= 1 && (command.places as number) <= LIMIT_BOUNDS.productive[1] ? command.places as number : invalid("places", `must be a whole number from 1 to ${LIMIT_BOUNDS.productive[1]}`);
      const project = command.projectId === undefined ? undefined : checkProjectId(command.projectId);
      const until = instant(command.until, "until");
      const reviewBy = instant(command.reviewBy, "reviewBy");
      if (reviewBy < until || Date.parse(reviewBy) - Date.parse(until) > BORROW_REVIEW_DAYS * 24 * HOUR_MS) invalid("reviewBy", `must be on or after until and at most ${BORROW_REVIEW_DAYS} days after it`);
      // Hiding a credential can make the text longer ("https://u:p@h" is kept as "https://u:[redacted]@h"); what is kept must still be what the stored-record check accepts, or every later
      // admission decision would read the record as damaged.
      const kept = redactText(reason);
      if (kept.length > 300) invalid("reason", `must be 1 to 300 characters as kept: with what looks like a credential hidden it is ${kept.length}; leave the credential out`);
      payload = { reason: kept, places, ...(project === undefined ? {} : { project }), until, reviewBy };
    }
    const scoped = scopedCommandId(by.id, command.commandId);
    const newId = derivedId("brw", scoped);
    const result = await this.#retrying(() => this.#runner.command("admission.borrow", { commandId: scoped, actor: by.id }, async () => ({
      payload,
      build: async () => {
        const loaded = await this.#load();
        const state = await this.#prepare(loaded.state);
        const now = this.#runner.now();
        const borrows = this.#borrows(state);
        const current = borrowAt(borrows, now);
        if (ending) {
          if (current === undefined) throw new DomainError("invalid_command", "no emergency borrow of the improvement reserve is in force now, so there is nothing to end", { field: "end" });
          const next: AdmissionState = { ...state, borrows: borrows.map((b) => (b.id === current.id ? { ...b, endedAt: now, endedBy: newId } : b)) };
          return this.#built(loaded.revision, await this.#promote(next), { borrow: current.id, ended: true });
        }
        const p = payload as { reason: string; places: number; project?: string; until: string; reviewBy: string };
        const way = "to give improvement work less for longer, lower workClass.pcFloor itself (a setting you see first)";
        if (current !== undefined) throw new DomainError("invalid_command", `emergency borrow ${current.id} is in force until ${borrowEnd(current)}; a borrow is never extended or stacked, and once it ends the floor stands again as long as it was lent; ${way}`, { field: "until" });
        const rest = borrowRestUntil(borrows);
        if (rest !== undefined && now < rest) { const last = borrows[borrows.length - 1]!; throw new DomainError("invalid_command", `the floor was lent from ${last.from} to ${borrowEnd(last)} and stands again for as long, until ${rest}, so repeated urgency cannot remove it; ${way}`, { field: "until" }); }
        if (!(p.until > now)) invalid("until", `must be after now (${now})`);
        if (Date.parse(p.until) - Date.parse(now) > BORROW_MAX_HOURS * HOUR_MS) invalid("until", `a borrow lasts at most ${BORROW_MAX_HOURS} hours (until ${new Date(Date.parse(now) + BORROW_MAX_HOURS * HOUR_MS).toISOString()} at the latest); ${way}`);
        if (p.project !== undefined && (await this.#runner.get("project", p.project)) === undefined) invalid("projectId", `${p.project} is not a project`);
        const allocation = await this.#balance();
        const reserved = allocation === undefined ? 0 : balancePlaces(state.limits.productive, allocation).reserved;
        if (reserved === 0) invalid("places", "there is nothing to borrow: the improvement floor (workClass.pcFloor) keeps no place now, so production is not held back by it");
        if (p.places > reserved) invalid("places", `the floor keeps ${reserved} place(s) for improvement work; borrow at most that many, or lower workClass.pcFloor itself (a setting you see first)`);
        const borrow: Borrow = { id: newId, reason: p.reason, places: p.places, ...(p.project === undefined ? {} : { project: p.project }), from: now, until: p.until, reviewBy: p.reviewBy, by: by.id };
        const next: AdmissionState = { ...state, borrows: [...borrows, borrow].slice(-BORROWS_KEPT) };
        return this.#built(loaded.revision, await this.#promote(next), { borrow: newId, places: p.places, until: p.until });
      },
    })));
    const after = this.#borrows((await this.#load()).state);
    // The borrow this command started, or (ending) the one it ended: on a repeat the same one, from the record.
    const mine = ending ? after.find((b) => b.endedBy === newId) : after.find((b) => b.id === newId);
    if (mine === undefined) throw new DomainError("integrity", "the emergency borrow this command recorded is no longer in the admission record");
    const rest = after[after.length - 1]?.id === mine.id ? borrowRestUntil(after) : undefined;
    return { borrowId: mine.id, ended: ending, until: borrowEnd(mine), reviewBy: mine.reviewBy, ...(rest === undefined ? {} : { againFrom: rest }), revision: result.revision, replayed: result.replayed };
  }

  /**
   * Takes out of the queue the requests that can no longer run (their host has been disabled or has no capacity that fits them) and admits what now fits. Every other change does this
   * first on its own; call it after disabling a host so the waiting requests for it are withdrawn at once and the reason is on record.
   */
  async sweep(command: CommandMeta): Promise<{ withdrawn: number }> {
    let withdrawn = 0;
    await this.#retrying(() => this.#runner.command("admission.sweep", command, async () => {
      onlyKnown(command, ["commandId", "actor"]);
      return {
        payload: {},
        build: async () => {
          const loaded = await this.#load();
          const state = await this.#prepare(loaded.state);
          withdrawn = state.withdrawn.length - loaded.state.withdrawn.length;
          return this.#built(loaded.revision, (await this.#promote(state)), { withdrawn });
        },
      };
    }));
    return { withdrawn };
  }

  /**
   * Gives waiting requests the priority their task has now (card H12: the dispatcher reads the contract's priority at each admission request, and a change of priority reorders the queue at the next
   * decision). It changes only the stored priority of requests that are still waiting; a request that is running, or gone, is left as it is and reported. Arrival order is kept, so equal priorities
   * stay first come, first served, and waiting requests that now fit are admitted in the same step. Nothing about the contract is written.
   */
  async reprioritize(command: CommandMeta & { changes: readonly { requestId: string; priority: number }[] }): Promise<{ changed: number; unchanged: number; missing: number }> {
    let report = { changed: 0, unchanged: 0, missing: 0 };
    await this.#retrying(() => this.#runner.command("admission.reprioritize", command, async () => {
      onlyKnown(command, ["commandId", "actor", "changes"]);
      if (!Array.isArray(command.changes) || command.changes.length < 1 || command.changes.length > 100) invalid("changes", "must list 1 to 100 requests");
      const seen = new Set<string>();
      const changes = command.changes.map((c, i) => {
        if (c === null || typeof c !== "object") return invalid(`changes[${i}]`, "must be an object with requestId and priority");
        onlyKnown(c, ["requestId", "priority"]);
        const requestId = typeof c.requestId === "string" && REQUEST_ID.test(c.requestId) ? c.requestId : invalid(`changes[${i}].requestId`, "is not a request ID");
        if (seen.has(requestId)) invalid(`changes[${i}].requestId`, "is listed twice");
        seen.add(requestId);
        if (!Number.isSafeInteger(c.priority) || c.priority < 0 || c.priority > 9) invalid(`changes[${i}].priority`, "must be a whole number from 0 to 9");
        return { requestId, priority: c.priority };
      });
      return {
        payload: { changes: changes as unknown as JsonObject[] },
        build: async () => {
          const loaded = await this.#load();
          const state = await this.#prepare(loaded.state);
          const wanted = new Map(changes.map((c) => [c.requestId, c.priority]));
          let changed = 0, unchanged = 0, missing = 0;
          for (const c of changes) {
            const waiting = state.queue.find((e) => e.id === c.requestId);
            if (waiting === undefined) { if (state.running.some((e) => e.id === c.requestId)) unchanged++; else missing++; } else if (waiting.priority === c.priority) unchanged++; else changed++;
          }
          report = { changed, unchanged, missing };
          const next: AdmissionState = { ...state, queue: state.queue.map((e) => (wanted.has(e.id) ? { ...e, priority: wanted.get(e.id)! } : e)) };
          return this.#built(loaded.revision, (await this.#promote(next)), { changed, unchanged, missing });
        },
      };
    }));
    return report;
  }

  /**
   * Keeps what the owner's caps count by up to date (card H10b follow-up). For requests that are running or waiting: `project` and `agent` are filled in when the record has none (a request made before the
   * caps existed), and `reportsTo` is set, or cleared with null, for a request that is still waiting (the supervisor is read again at each decision; a request that already runs keeps what it ran under).
   * Nothing else about a request changes, and requests that are gone are counted as missing. Waiting requests that now fit are admitted in the same step.
   */
  async annotate(command: CommandMeta & { changes: readonly { requestId: string; project?: string; agent?: string; reportsTo?: string | null }[] }): Promise<{ changed: number; missing: number }> {
    let report = { changed: 0, missing: 0 };
    await this.#retrying(() => this.#runner.command("admission.annotate", command, async () => {
      onlyKnown(command, ["commandId", "actor", "changes"]);
      if (!Array.isArray(command.changes) || command.changes.length < 1 || command.changes.length > 100) invalid("changes", "must list 1 to 100 requests");
      const seen = new Set<string>();
      const changes = command.changes.map((c, i) => {
        if (c === null || typeof c !== "object") return invalid(`changes[${i}]`, "must be an object with requestId");
        onlyKnown(c, ["requestId", "project", "agent", "reportsTo"]);
        const requestId = typeof c.requestId === "string" && REQUEST_ID.test(c.requestId) ? c.requestId : invalid(`changes[${i}].requestId`, "is not a request ID");
        if (seen.has(requestId)) invalid(`changes[${i}].requestId`, "is listed twice");
        seen.add(requestId);
        const one = (v: unknown, field: string): string | undefined => (v === undefined ? undefined : typeof v === "string" && LABEL.test(v) ? v : invalid(`changes[${i}].${field}`, "is not a valid ID"));
        const reportsTo = c.reportsTo === null ? null : one(c.reportsTo, "reportsTo");
        return { requestId, ...(one(c.project, "project") === undefined ? {} : { project: one(c.project, "project")! }), ...(one(c.agent, "agent") === undefined ? {} : { agent: one(c.agent, "agent")! }), ...(reportsTo === undefined ? {} : { reportsTo }) };
      });
      return {
        payload: { changes: changes as unknown as JsonObject[] },
        build: async () => {
          const loaded = await this.#load();
          const state = await this.#prepare(loaded.state);
          const by = new Map(changes.map((c) => [c.requestId, c]));
          let changed = 0;
          const apply = (e: Entry, waiting: boolean): Entry => {
            const c = by.get(e.id);
            if (c === undefined) return e;
            let next: { -readonly [K in keyof Entry]: Entry[K] } = { ...e };
            if (c.project !== undefined && e.project === undefined) next.project = c.project;
            if (c.agent !== undefined && e.agent === undefined) next.agent = c.agent;
            if (c.reportsTo !== undefined && (waiting || e.reportsTo === undefined)) { if (c.reportsTo === null) { const { reportsTo: _r, ...rest } = next; void _r; next = rest as typeof next; } else next.reportsTo = c.reportsTo; }
            if (JSON.stringify(next) !== JSON.stringify(e)) changed++;
            return next;
          };
          const next: AdmissionState = { ...state, running: state.running.map((e) => apply(e, false)), queue: state.queue.map((e) => apply(e, true)) };
          const missing = changes.filter((c) => ![...state.running, ...state.queue].some((e) => e.id === c.requestId)).length;
          report = { changed, missing };
          return this.#built(loaded.revision, (await this.#promote(next)), { changed, missing });
        },
      };
    }));
    return report;
  }

  /** Where a request is: running, waiting (with its position in its lane's order), or neither. */
  async where(requestId: string): Promise<Where> {
    const { state } = await this.#load();
    const running = state.running.find((e) => e.id === requestId);
    if (running !== undefined) return { state: "running", entry: running };
    const waiting = state.queue.find((e) => e.id === requestId);
    if (waiting === undefined) {
      const gone = (state.withdrawn ?? []).find((w) => w.id === requestId);
      return gone === undefined ? { state: "absent" } : { state: "withdrawn", reason: gone.reason };
    }
    const ahead = order(state, laneOf(waiting.class));
    let reason: string | null = null, capReason: string | null = null, balanceReason: string | null = null;
    try { const withCaps = { ...state, caps: await this.#caps() }; reason = waitReason(withCaps, waiting); capReason = capWaitReason(withCaps, waiting); } catch (error) { if (!(error instanceof DomainError && error.code === "integrity")) throw error; reason = capReason = "waiting for capacity: the owner's capacity limits setting is damaged, nothing new starts until it is repaired"; }
    if (laneOf(waiting.class) === "productive") {
      try {
        const balance = await this.#balance();
        if (balance !== undefined) {
          let caps: AdmissionState["caps"];
          try { caps = await this.#caps(); } catch { caps = undefined; }
          const borrow = this.#activeBorrow(state);
          const full = { ...state, ...(caps === undefined ? {} : { caps }), balance, ...(borrow === undefined ? {} : { borrow }) };
          balanceReason = balanceWaitReason(full, waiting);
          if (reason === null) reason = balanceReason;
        }
      } catch (error) { if (!(error instanceof DomainError && error.code === "integrity")) throw error; balanceReason = error.message === BORROWS_DAMAGED_TEXT ? BORROWS_DAMAGED : BALANCE_DAMAGED; reason ??= balanceReason; }
    }
    return { state: "waiting", entry: waiting, position: ahead.findIndex((e) => e.id === requestId) + 1, ...(reason === null ? {} : { reason }), ...(capReason === null ? {} : { capReason }), ...(balanceReason === null ? {} : { balanceReason }) };
  }

  /**
   * The P/PC balance of admission now (card B01), owner only: the allocation in force and the places it keeps and caps, what runs and waits of each kind, the production attempts running in lent
   * places (bounded) and, when improvement work waits short of its reserve, why. A damaged allocation setting is refused (`integrity`) rather than shown as no allocation.
   */
  async balance(by: Principal): Promise<BalanceView> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the P/PC balance`);
    const { state, revision } = await this.#load();
    const allocation = await this.#balance();
    const productive = state.limits.productive;
    const places = allocation === undefined ? { reserved: 0, ceiling: productive, protectedP: 0 } : balancePlaces(productive, allocation);
    const runningP = state.running.filter((e) => laneOf(e.class) === "productive");
    const waitingP = state.queue.filter((e) => laneOf(e.class) === "productive");
    const count = (list: readonly Entry[]) => ({ P: list.filter((e) => workClassOf(e) === "P").length, PC: list.filter((e) => workClassOf(e) === "PC").length });
    const running = count(runningP), waiting = count(waitingP);
    const lentAll = runningP.filter((e) => e.lent !== undefined).sort((a, b) => a.seq - b.seq);
    // The emergency borrows: the one in force and the newest that ended, each with what it did. Damage is shown, never read as "no borrow".
    let borrows: readonly Borrow[] = [], borrowProblem: string | undefined;
    try { borrows = this.#borrows(state); } catch (error) { if (!(error instanceof DomainError && error.code === "integrity")) throw error; borrowProblem = "the emergency borrows stored in the admission record cannot be read, so nothing new is admitted until they are repaired"; }
    const now = this.#runner.now();
    const viewOf = (b: Borrow): BorrowView => ({ id: b.id, reason: b.reason, places: b.places, ...(b.project === undefined ? {} : { project: b.project }), from: b.from, until: b.until, reviewBy: b.reviewBy, ...(b.endedAt === undefined ? {} : { endedAt: b.endedAt }), taken: b.taken ?? 0, running: runningP.filter((e) => e.borrowed === b.id).length });
    const inForce = borrowAt(borrows, now);
    const ended = [...borrows].reverse().find((b) => b.from <= now && borrowEnd(b) <= now);
    const activeBorrow: ActiveBorrow | undefined = inForce === undefined ? undefined : { id: inForce.id, places: inForce.places, ...(inForce.project === undefined ? {} : { project: inForce.project }), until: borrowEnd(inForce) };
    let unmet: BalanceView["unmet"];
    const short = places.reserved - running.PC;
    if (allocation !== undefined && short > 0 && waiting.PC > 0) {
      let caps: AdmissionState["caps"];
      try { caps = await this.#caps(); } catch { caps = undefined; }
      const plain: AdmissionState = { ...state, ...(caps === undefined ? {} : { caps }) };
      const full: AdmissionState = { ...plain, balance: allocation, ...(activeBorrow === undefined ? {} : { borrow: activeBorrow }) };
      const free = productive - runningP.length;
      const borrowedNow = lentAll.filter((e) => e.borrowed !== undefined).length;
      const first = order(full, "productive").find((e) => workClassOf(e) === "PC")!;
      const held = blockers(full, first).filter((b) => b !== "lane");
      const cause = free === 0
        ? `every productive place is taken (${running.P} production, ${running.PC} improvement)${lentAll.length === 0 ? "" : `; ${lentAll.length} production attempt${lentAll.length === 1 ? " was" : "s were"} lent a reserved place ${borrowedNow === 0 ? "while no improvement work could use it" : borrowedNow === lentAll.length ? "under your emergency borrow" : `(${borrowedNow} under your emergency borrow, the rest while no improvement work could use it)`}, and the place${lentAll.length === 1 ? " comes" : "s come"} back as ${lentAll.length === 1 ? "it ends" : "they end"}`}; nothing running is stopped to make room`
        : held.length > 0 ? (waitReason(plain, first) ?? "the waiting improvement work cannot run yet")
          : "the waiting improvement work is admitted at the next decision";
      unmet = { short, cause };
    }
    return {
      ...(allocation === undefined ? {} : { allocation }),
      places: { productive, ...places }, running, waiting,
      lent: lentAll.slice(0, BALANCE_LENT_SHOWN).map((e) => ({ requestId: e.id, at: e.at, reason: e.lent! })), lentTotal: lentAll.length, borrowedTotal: lentAll.filter((e) => e.borrowed !== undefined).length,
      ...(unmet === undefined ? {} : { unmet }),
      ...(inForce === undefined ? {} : { borrow: { ...viewOf(inForce), lends: Math.min(inForce.places, places.reserved) } }),
      ...(ended === undefined ? {} : { lastBorrow: { ...viewOf(ended), ended: borrowEnd(ended), againFrom: ended.id === borrows[borrows.length - 1]?.id ? borrowRestUntil(borrows)! : borrowEnd(ended) } }),
      ...(borrowProblem === undefined ? {} : { borrowProblem }), revision,
    };
  }

  async snapshot(): Promise<AdmissionState & { revision: number }> {
    const { state, revision } = await this.#load();
    return { ...state, revision };
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  async #load(): Promise<{ state: AdmissionState; revision: number }> {
    const found = await this.#runner.get(STATE.kind, STATE.id);
    return found === undefined ? { state: EMPTY_STATE, revision: 0 } : { state: { ...EMPTY_STATE, ...(found.body as unknown as AdmissionState) }, revision: found.revision };
  }

  /** The owner's caps now. Throws `integrity` when the record is damaged. */
  async #caps(): Promise<NonNullable<AdmissionState["caps"]>> {
    const found = await this.#runner.get(CAPS_REF.kind, CAPS_REF.id);
    return capsOf(found?.body, found?.revision);
  }

  /**
   * The owner's P/PC allocation now (card B01). Any failure to read it is reported as `integrity` with a fixed text (the reader's own message may come from storage and is not passed on), so it is
   * handled like a damaged caps record: nothing new starts on a guess, while release and stop still work.
   */
  async #balance(): Promise<Balance | undefined> {
    try { return await this.#balanceReader(); } catch (error) {
      if (error instanceof DomainError && error.code === "integrity") throw new DomainError("integrity", redactText(error.message).slice(0, 200));
      throw new DomainError("integrity", "the P/PC allocation settings cannot be read");
    }
  }

  /** Admits what fits under the caps and the P/PC allocation now. A damaged caps record, allocation or borrow record admits nothing new (work waits; stop and release still work) until it is repaired. */
  async #promote(state: AdmissionState): Promise<AdmissionState> {
    let caps: NonNullable<AdmissionState["caps"]>;
    let balance: Balance | undefined;
    try { caps = await this.#caps(); balance = await this.#balance(); return this.#admit(state, caps, balance); } catch (error) { if (error instanceof DomainError && error.code === "integrity") return state; throw error; }
  }

  /** One admission decision with the emergency borrow in force now (by the clock), counting on the borrow what it let in. Throws `integrity` when the stored borrows are damaged. */
  #admit(state: AdmissionState, caps: NonNullable<AdmissionState["caps"]>, balance: Balance | undefined): AdmissionState {
    const active = this.#activeBorrow(state);
    const r = promote({ ...state, caps, ...(balance === undefined ? {} : { balance }), ...(active === undefined ? {} : { borrow: active }) });
    const taken = r.admitted.filter((e) => e.borrowed !== undefined).length;
    if (active === undefined || taken === 0) return r.state;
    return { ...r.state, borrows: (state.borrows ?? []).map((b) => (b.id === active.id ? { ...b, taken: (b.taken ?? 0) + taken } : b)) };
  }

  /** The stored borrows, checked: a list that is not what `borrow` writes is damage (`integrity`), never read as "no borrow". */
  #borrows(state: AdmissionState): readonly Borrow[] {
    const list = state.borrows as unknown;
    if (list === undefined) return [];
    const damaged = (): never => { throw new DomainError("integrity", BORROWS_DAMAGED_TEXT); };
    if (!Array.isArray(list) || list.length > BORROWS_KEPT) return damaged();
    const time = (v: unknown): boolean => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
    let previous = "";
    for (const b of list as unknown[]) {
      const r = b as Record<string, unknown> | null;
      if (r === null || typeof r !== "object" || Array.isArray(r)) return damaged();
      const ok = typeof r["id"] === "string" && BORROW_ID.test(r["id"]) && typeof r["reason"] === "string" && r["reason"].length >= 1 && r["reason"].length <= 300
        && Number.isSafeInteger(r["places"]) && (r["places"] as number) >= 1 && (r["places"] as number) <= LIMIT_BOUNDS.productive[1]
        && (r["project"] === undefined || (typeof r["project"] === "string" && LABEL.test(r["project"]))) && typeof r["by"] === "string"
        && time(r["from"]) && time(r["until"]) && time(r["reviewBy"]) && (r["from"] as string) < (r["until"] as string) && (r["reviewBy"] as string) >= (r["until"] as string)
        && (r["endedAt"] === undefined || time(r["endedAt"])) && (r["endedBy"] === undefined || (r["endedAt"] !== undefined && typeof r["endedBy"] === "string" && BORROW_ID.test(r["endedBy"]))) &&(r["taken"] === undefined || (Number.isSafeInteger(r["taken"]) && (r["taken"] as number) >= 0))
        && (r["from"] as string) >= previous;
      if (!ok) return damaged();
      previous = r["from"] as string;
    }
    return list as Borrow[];
  }

  /** The emergency borrow in force now, by the runner's clock. Throws `integrity` when the stored borrows are damaged. */
  #activeBorrow(state: AdmissionState): ActiveBorrow | undefined {
    const b = borrowAt(this.#borrows(state), this.#runner.now());
    return b === undefined ? undefined : { id: b.id, places: b.places, ...(b.project === undefined ? {} : { project: b.project }), until: borrowEnd(b) };
  }

  #built(revision: number, stateWithCaps: AdmissionState, detail: JsonObject) {
    const { caps: _caps, balance: _balance, borrow: _borrow, ...state } = stateWithCaps; void _caps; void _balance; void _borrow;
    const change: Change = revision === 0
      ? { type: "create", ref: STATE, body: state as unknown as JsonObject }
      : { type: "update", ref: STATE, expectedRevision: revision, body: state as unknown as JsonObject };
    return { ref: STATE, creates: revision === 0, changes: [change], detail };
  }

  /** Withdraws waiting requests that can no longer run: their host is not an active host any more, or its declared capacity cannot ever hold them. What they started and left waiting goes with them. */
  async #prepare(state: AdmissionState): Promise<AdmissionState> {
    const reasons = new Map<string, string>();
    const active = new Map<string, boolean>();
    for (const entry of state.queue) {
      if (entry.host === undefined) continue;
      if (!active.has(entry.host)) {
        const found = await this.#runner.get("principal", entry.host);
        const body = found?.body as unknown as PrincipalBody | undefined;
        active.set(entry.host, body !== undefined && body.kind === "host" && body.state === "active");
      }
      if (active.get(entry.host) !== true) { reasons.set(entry.id, `${entry.host} is no longer an active host`); continue; }
      if (laneOf(entry.class) === "control") continue;
      const capacity = Object.hasOwn(state.capacity, entry.host) ? state.capacity[entry.host] : undefined;
      if (capacity === undefined) reasons.set(entry.id, `${entry.host} has no declared capacity`);
      else if (entry.cpus > capacity.cpus || entry.memoryMb > capacity.memoryMb) reasons.set(entry.id, `${entry.host} can no longer hold ${entry.cpus} CPUs and ${entry.memoryMb} MB (it has ${capacity.cpus} and ${capacity.memoryMb})`);
    }
    if (reasons.size === 0) return state;
    const gone = new Map(reasons);
    for (const id of reasons.keys()) for (const child of descendants(state.queue, id)) if (!gone.has(child)) gone.set(child, `the request that started it (${id}) was withdrawn`);
    const at = this.#runner.now();
    return {
      ...state,
      queue: state.queue.filter((e) => !gone.has(e.id)),
      withdrawn: [...state.withdrawn, ...[...gone].map(([id, reason]) => ({ id, reason, at }))].slice(-WITHDRAWN_KEPT),
    };
  }

  /** The depth a request started by `parent` would have; the parent must be running (an attempt that is not running cannot start anything). */
  async #childDepth(state: AdmissionState, parent: string): Promise<number> {
    const p = state.running.find((e) => e.id === parent);
    if (p === undefined) throw new DomainError("invalid_command", `${parent} is not running, so it cannot start anything`, { field: "parent" });
    return p.depth + 1;
  }

  async #requireActiveHost(host: string): Promise<void> {
    const found = await this.#runner.get("principal", host);
    const body = found?.body as unknown as PrincipalBody | undefined;
    if (body === undefined || body.kind !== "host" || body.state !== "active") throw new DomainError("invalid_command", `${host} is not an active host`, { field: "host" });
  }

  /**
   * The record is shared by every decision, so two at once meet a revision check; the loser reads again and decides again on the new picture. A lost race to create the very first record
   * is retried a few times; a command ID reused for a different command is a real conflict and is not retried.
   */
  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    let conflicts = 0;
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        const race = error instanceof DomainError && error.code === "stale_revision";
        const first = error instanceof DomainError && error.code === "command_conflict" && ++conflicts <= 3;
        if (!(race || first) || attempt >= 80) throw error;
        // A short random pause so many decisions at once take turns instead of colliding again together.
        await new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(25, attempt * 2)));
      }
    }
  }
}

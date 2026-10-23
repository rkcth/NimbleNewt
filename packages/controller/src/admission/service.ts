import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, text } from "../domain/model.js";
import { CommandRunner, type CommandMeta, type RunnerOptions } from "../domain/runner.js";
import type { PrincipalBody } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import {
  EMPTY_STATE, WITHDRAWN_KEPT, checkLimits, descendants, laneOf, order, promote, type AdmissionState, type Capacity, type Entry, type Limits, type RequestClass,
} from "./policy.js";

const STATE: AggregateRef = { kind: "admission-state", id: "admission" };
const CLASSES: readonly RequestClass[] = ["productive", "inquiry", "review"];
const REQUEST_ID = /^req-[a-z2-7]{20}$/;
const HOST_ID = /^host:[a-z0-9][a-z0-9-]{0,39}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

export interface RequestAdmission extends CommandMeta {
  readonly class: RequestClass;
  readonly priority?: number;
  /** The host the work runs on (required for productive work). */
  readonly host?: string;
  readonly cpus: number;
  readonly memoryMb: number;
  /** The running request that is starting this one. */
  readonly parent?: string;
}

export type Where = { readonly state: "running" | "waiting"; readonly entry: Entry; readonly position?: number } | { readonly state: "withdrawn"; readonly reason: string } | { readonly state: "absent" };

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

  private constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): AdmissionService {
    return new AdmissionService(new CommandRunner(storage, epoch, options));
  }

  /** Asks to start something. It is admitted at once if a place is free, otherwise it waits in order; a full queue or a spawn beyond the limits is refused. */
  async request(command: RequestAdmission): Promise<{ id: string; state: "running" | "waiting" | "released"; replayed: boolean }> {
    const result = await this.#retrying(() => this.#runner.command("admission.request", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "class", "priority", "host", "cpus", "memoryMb", "parent"]);
      const cls = CLASSES.includes(command.class) ? command.class : invalid("class", `must be one of ${CLASSES.join(", ")}`);
      const priority = command.priority === undefined ? 5 : command.priority;
      if (!Number.isSafeInteger(priority) || priority < 0 || priority > 9) invalid("priority", "must be a whole number from 0 to 9");
      const host = command.host === undefined ? undefined : (typeof command.host === "string" && HOST_ID.test(command.host) ? command.host : invalid("host", "is not a host ID"));
      if (cls === "productive" && host === undefined) invalid("host", "is required for productive work");
      const cpus = command.cpus;
      const memoryMb = command.memoryMb;
      if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus <= 0 || cpus > 1024) invalid("cpus", "must be a number above 0 and at most 1024");
      if (!Number.isSafeInteger(memoryMb) || memoryMb < 1 || memoryMb > 4_194_304) invalid("memoryMb", "must be a whole number of megabytes from 1 to 4194304");
      const parent = command.parent === undefined ? undefined : (typeof command.parent === "string" && REQUEST_ID.test(command.parent) ? command.parent : invalid("parent", "is not a request ID"));
      const id = derivedId("req", meta.commandId);
      return {
        payload: { class: cls, priority, ...(host === undefined ? {} : { host }), cpus: cpus as number, memoryMb: memoryMb as number, ...(parent === undefined ? {} : { parent }) },
        build: async () => {
          const loaded = await this.#load();
          const revision = loaded.revision;
          const state = await this.#prepare(loaded.state);
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
          const entry: Entry = { id, class: cls, priority, ...(host === undefined ? {} : { host }), cpus: cpus as number, memoryMb: memoryMb as number, ...(parent === undefined ? {} : { parent }), depth, seq: state.nextSeq, skipped: 0, at: this.#runner.now() };
          const queued: AdmissionState = { ...state, queue: [...state.queue, entry], nextSeq: state.nextSeq + 1 };
          const after = promote(queued).state;
          // The bound is on what is left waiting: a request that is admitted at once never sat in the queue.
          if (after.queue.length > state.limits.queue) throw new DomainError("unavailable", `the queue is full (${state.limits.queue} waiting); try again later`);
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
          return this.#built(revision, promote(next).state, { request: requestId, reason, withdrawn: dropped.size - 1 });
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
          return this.#built(loaded.revision, promote({ ...state, limits }).state, { limits: limits as unknown as JsonObject });
        },
      };
    }));
  }

  /** The owner declares what a host can run (CPUs and memory). Requests for a host with no declared capacity are refused. */
  async setCapacity(command: CommandMeta & { host: string; capacity: Capacity }): Promise<void> {
    await this.#retrying(() => this.#runner.command("admission.capacity", command, async () => {
      onlyKnown(command, ["commandId", "actor", "host", "capacity"]);
      const host = typeof command.host === "string" && HOST_ID.test(command.host) ? command.host : invalid("host", "is not a host ID");
      const c = command.capacity as unknown as Record<string, unknown> | undefined;
      if (c === undefined || c === null || typeof c !== "object") invalid("capacity", "must be an object with cpus and memoryMb");
      for (const key of Object.keys(c!)) if (key !== "cpus" && key !== "memoryMb") invalid(`capacity.${key}`, "is not a capacity field");
      const cpus = c!["cpus"];
      const memoryMb = c!["memoryMb"];
      if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus <= 0 || cpus > 1024) invalid("capacity.cpus", "must be a number above 0 and at most 1024");
      if (!Number.isSafeInteger(memoryMb) || (memoryMb as number) < 1 || (memoryMb as number) > 4_194_304) invalid("capacity.memoryMb", "must be a whole number of megabytes from 1 to 4194304");
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
          return this.#built(revision, promote(prepared).state, { host, cpus: cpus as number, memoryMb: memoryMb as number, withdrawn: prepared.withdrawn.length - next.withdrawn.length });
        },
      };
    }));
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
          return this.#built(loaded.revision, promote(state).state, { withdrawn });
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
          return this.#built(loaded.revision, promote(next).state, { changed, unchanged, missing });
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
    return { state: "waiting", entry: waiting, position: ahead.findIndex((e) => e.id === requestId) + 1 };
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

  #built(revision: number, state: AdmissionState, detail: JsonObject) {
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

import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { onlyKnown, revision as checkRevision, text } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allowsExactly } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { FALLBACK_LIMITS, type CallBody, type FailureClass, type FallbackService, type InFlight, type RouteGate } from "./fallback.js";
import { EMPTY_TOPOLOGY, TOPOLOGY_REF, assertLists, checkTopology, providerOf, targetOf, type ListRules, type Topology } from "./lists.js";
import { ROUTING_LIMITS, type RoutingTable } from "./policy.js";
import type { RoutingBody, RoutingService } from "./service.js";

/** What a control is aimed at. `model` is one route (an alias is resolved to the route it names), `service` is a local service such as an inference engine. */
export type ControlLevel = "model" | "endpoint" | "account" | "provider" | "service";
/** `disabled`: no new work, running work is left alone. `drain`: no new work now, running work may finish until the deadline. `cutover`: no new work, running attempts are cancelled. */
export type ControlMode = "disabled" | "drain" | "cutover";
export interface ControlEntry { readonly level: ControlLevel; readonly name: string; readonly mode: ControlMode; readonly reason: string; readonly by: string; readonly at: string; readonly drainUntil?: string;
  /** A cutover whose cancellations are not yet all carried out and passed to the listener; the target is not safe to stop meanwhile. */
  readonly cancelPending?: boolean;
  /** A drain that reached its deadline and became a cutover. */
  readonly expired?: boolean;
}
export interface FailbackPolicy {
  /** `manual`: a failed-over target comes back only when the owner restores it. `automatic`: when probes have been good for long enough, and it has not been flapping. */
  readonly mode: "manual" | "automatic";
  /** Consecutive good probes needed. */
  readonly minProbes: number;
  /** The good probes must span at least this long. */
  readonly stableSeconds: number;
  /** A target that fails again within this long of being restored is not restored automatically again: it needs the owner. */
  readonly holdDownSeconds: number;
}
export interface ControlsBody { readonly entries: readonly ControlEntry[]; readonly failback: FailbackPolicy; readonly updatedBy: string }
export type HealthScope = "account" | "endpoint" | "model";
export interface HealthBody {
  readonly scope: HealthScope;
  readonly name: string;
  readonly state: "down" | "healthy";
  readonly since: string;
  readonly lastClass: FailureClass;
  readonly failures: number;
  readonly probesOk: number;
  readonly firstOkAt?: string;
  readonly lastProbeAt?: string;
  readonly restoredAt?: string;
  /** Failed again soon after a restore: only the owner brings it back. */
  readonly needsOwner: boolean;
  /** A rate limit: usable again at this time, no probes needed. */
  readonly cooldownUntil?: string;
  /** Half-open: from this time one trial dispatch may go to a down target (the R02 cooldown, for when nothing probes). */
  readonly retryAt?: string;
  /** The call holding the trial, and until when it holds it. */
  readonly trialCall?: string;
  readonly trialUntil?: string;
}
export interface CutoverReport {
  readonly level: ControlLevel;
  readonly name: string;
  readonly mode?: ControlMode;
  /** Fact 1: the control is committed, so no new dispatch can reach the target (retries and resumes included). */
  readonly routingApplied: boolean;
  /** Fact 2: requests still running on the target. */
  readonly inFlightRemaining: number;
  readonly inFlight: readonly InFlight[];
  /** Fact 3: routing applied and nothing is running on it. */
  readonly safeToStop: boolean;
  readonly routesAffected: readonly string[];
  /** True when nothing is running on the target (also when no route uses it at all). */
  readonly noRouteInUse: boolean;
  readonly drainUntil?: string;
  readonly drainDeadlinePassed: boolean;
  /** Cancellations of a cutover still to be carried out or passed on. */
  readonly cancelPending: boolean;
  /** Abandoned attempts on paid providers whose cost is not yet known. */
  readonly possibleCharges: number;
  /** Stopping a local service loses the engine's in-memory conversation cache; nothing here evicts or flushes it. */
  readonly stopDiscardsCache: boolean;
}

export const CUTOVER_LIMITS = { entries: 100, drainSeconds: 7 * 24 * 3600, probes: 100, stableSeconds: 86_400, holdDownSeconds: 7 * 86_400 } as const;
export const DEFAULT_FAILBACK: FailbackPolicy = { mode: "automatic", minProbes: 3, stableSeconds: 120, holdDownSeconds: 900 };
const CONTROLS: AggregateRef = { kind: "route-controls", id: "controls" };
const LEVELS: readonly ControlLevel[] = ["model", "endpoint", "account", "provider", "service"];
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const digest = (...parts: string[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40);
const whole = (v: unknown, field: string, min: number, max: number): number => (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : invalid(field, `must be a whole number from ${min} to ${max}`));
const healthId = (scope: HealthScope, name: string): string => (scope === "model" ? `model-${digest(name)}` : `${scope}-${name}`);

/**
 * Provider drain, cutover and failback (card R04). Three pieces around the routing table (R01) and the fallback service (R02):
 *
 * - **Topology and lists.** The owner says where routes really go (endpoint, account, local service, aliases). Fallback lists are checked against it (`checkLists`).
 * - **Controls.** The owner can disable, drain or cut over a target at five levels: one model, an endpoint, an account, a provider, a local service. Aliases are resolved, so a
 *   disabled service cannot be reached through another name. A control blocks every new dispatch from the moment it commits (first attempts, fallbacks, retries, resumed tasks),
 *   because the fallback service asks this gate for every candidate and checks the chosen route again after it commits. A drain lets running requests finish until its explicit
 *   deadline; a cutover cancels them (the attempts are abandoned, late responses are not applied, possible charges are recorded). Only the owner lifts a control: probes never do.
 * - **Health and failback.** An availability failure marks its scope down for new work (credit or authentication: the whole account; an outage: the endpoint; a rate limit: that
 *   model, for a cooldown). Task errors, bad answers and context overflows are not availability failures and change nothing. A down scope returns by the failback policy: manual, or
 *   automatic after enough good probes spread over enough time, and never automatically again if it failed soon after its last restore (that is flapping). Running calls stay where
 *   they are; only new work starts again at the top of its list.
 */
export class CutoverService {
  readonly #runner: CommandRunner;
  readonly #routing: RoutingService;
  readonly #rules: ListRules | undefined;
  #fallback: FallbackService | undefined;
  #onCancelled: ((cancelled: readonly InFlight[]) => Promise<void>) | undefined;

  private constructor(runner: CommandRunner, routing: RoutingService, rules: ListRules | undefined) { this.#runner = runner; this.#routing = routing; this.#rules = rules; }

  static withEpoch(storage: ControllerStorage, epoch: number, routing: RoutingService, options: RunnerOptions = {}, rules?: ListRules): CutoverService {
    return new CutoverService(new CommandRunner(storage, epoch, options), routing, rules);
  }

  /** The fallback service whose calls a cutover cancels (it was built with `gate()`). `onCancelled` hears of the cancelled attempts, for example to interrupt their generations (L05) and abort the runtime. */
  bind(fallback: FallbackService, onCancelled?: (cancelled: readonly InFlight[]) => Promise<void>): void { this.#fallback = fallback; this.#onCancelled = onCancelled; }

  // ---- topology ------------------------------------------------------------------------------------------------------------

  /** Replaces the topology; refused if it names routes the table lacks, has an alias chain or cycle, or leaves a model-using role without a valid list. */
  async setTopology(owner: Principal, command: NoActor & { expectedRevision: number; topology: unknown }): Promise<{ revision: number; replayed: boolean }> {
    this.#requireWriter(owner);
    const r = await this.#runner.command("routing.topology", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "expectedRevision", "topology"]);
      const expected = command.expectedRevision === 0 ? 0 : checkRevision(command.expectedRevision);
      return {
        payload: { expectedRevision: expected, topology: command.topology as JsonObject },
        build: async () => {
          const table = await this.#table();
          const topology = checkTopology(command.topology, table);
          assertLists(table, topology, this.#rules);
          const current = await this.#runner.get(TOPOLOGY_REF.kind, TOPOLOGY_REF.id);
          if ((current === undefined ? 0 : current.revision) !== expected) throw new DomainError("stale_revision", `the topology is at revision ${current?.revision ?? 0}, not ${expected}`, { currentRevision: current?.revision ?? 0 });
          // A control must keep pointing at something that exists.
          for (const x of (await this.#controls()).entries) this.#known(x.level, x.name, table, topology);
          const body = { ...topology, updatedBy: owner.id } as unknown as JsonObject;
          const ref: AggregateRef = TOPOLOGY_REF;
          return { ref, creates: current === undefined, changes: [current === undefined ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: current.revision, body }] as Change[], detail: { routes: Object.keys(topology.targets).length, aliases: Object.keys(topology.aliases).length } };
        },
      };
    });
    return { revision: r.revision, replayed: r.replayed };
  }

  async topology(): Promise<Topology & { revision: number }> {
    const found = await this.#runner.get(TOPOLOGY_REF.kind, TOPOLOGY_REF.id);
    return found === undefined ? { ...EMPTY_TOPOLOGY, revision: 0 } : { ...this.#topologyOf(found.body), revision: found.revision };
  }

  // ---- controls ------------------------------------------------------------------------------------------------------------

  /** New work stops now; running work is left alone. */
  disable(owner: Principal, command: NoActor & { level: ControlLevel; name: string; reason: string }): Promise<{ revision: number; replayed: boolean }> { return this.#control(owner, "routing.disable", "disabled", command, undefined); }

  /** Planned maintenance: new work stops now; running work may finish until `drainSeconds` from now (there is no default; the owner chooses). */
  async drain(owner: Principal, command: NoActor & { level: ControlLevel; name: string; reason: string; drainSeconds: number }): Promise<{ revision: number; replayed: boolean }> {
    return this.#control(owner, "routing.drain", "drain", command, whole(command.drainSeconds, "drainSeconds", 1, CUTOVER_LIMITS.drainSeconds));
  }

  /**
   * Immediate cutover: new work stops now and running attempts are cancelled (their calls move to the next eligible route). The fallback service must be bound first (checked before
   * anything is committed). Repeat the same command to carry out what a crash or a failing listener left: every attempt this cutover abandoned is passed to the listener again.
   */
  async cutover(owner: Principal, command: NoActor & { level: ControlLevel; name: string; reason: string }): Promise<{ revision: number; replayed: boolean; cancelled: readonly InFlight[] }> {
    if (this.#fallback === undefined) throw new DomainError("unavailable", "no fallback service is bound; a cutover cannot cancel running attempts");
    const r = await this.#control(owner, "routing.cutover", "cutover", command, undefined);
    return { ...r, cancelled: await this.#process(owner, true) };
  }

  /** The owner lets a target be used again. Probes and recoveries never do this. */
  async reenable(owner: Principal, command: NoActor & { level: ControlLevel; name: string; reason: string }): Promise<{ revision: number; replayed: boolean }> {
    this.#requireWriter(owner);
    const reason = this.#reason(command.reason);
    const r = await this.#runner.command("routing.reenable", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "level", "name", "reason"]);
      const level = this.#level(command.level);
      const name = typeof command.name === "string" ? command.name : invalid("name", "must be text");
      return {
        payload: { level, name, reason },
        build: async () => {
          const current = await this.#controlsAggregate();
          const body = this.#bodyOf(current?.body);
          const key = await this.#key(level, name);
          if (!body.entries.some((e) => e.level === level && e.name === key)) throw new DomainError("invalid_command", `${level} ${name} is not disabled`, { field: "name" });
          return this.#write(owner, current, { ...body, entries: body.entries.filter((e) => !(e.level === level && e.name === key)) }, { level, name: key, reason });
        },
      };
    });
    return { revision: r.revision, replayed: r.replayed };
  }

  async setFailbackPolicy(owner: Principal, command: NoActor & { policy: unknown }): Promise<{ revision: number; replayed: boolean }> {
    this.#requireWriter(owner);
    const r = await this.#runner.command("routing.failback", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "policy"]);
      const p = command.policy as Record<string, unknown> | null;
      if (p === null || typeof p !== "object" || Array.isArray(p)) invalid("policy", "must be an object");
      for (const k of Object.keys(p!)) if (!["mode", "minProbes", "stableSeconds", "holdDownSeconds"].includes(k)) invalid(`policy.${k}`, "is not a field here");
      const policy: FailbackPolicy = {
        mode: p!["mode"] === "manual" || p!["mode"] === "automatic" ? p!["mode"] : invalid("policy.mode", "must be manual or automatic"),
        minProbes: whole(p!["minProbes"], "policy.minProbes", 1, CUTOVER_LIMITS.probes),
        stableSeconds: whole(p!["stableSeconds"], "policy.stableSeconds", 0, CUTOVER_LIMITS.stableSeconds),
        holdDownSeconds: whole(p!["holdDownSeconds"], "policy.holdDownSeconds", 0, CUTOVER_LIMITS.holdDownSeconds),
      };
      return {
        payload: { policy: policy as unknown as JsonObject },
        build: async () => {
          const current = await this.#controlsAggregate();
          return this.#write(owner, current, { ...this.#bodyOf(current?.body), failback: policy }, { failback: policy.mode });
        },
      };
    });
    return { revision: r.revision, replayed: r.replayed };
  }

  async controls(): Promise<ControlsBody> { return this.#controls(); }

  /**
   * The three facts about taking a target out of service, kept apart (README: routing applied, in-flight requests remaining, service safe to stop). With no control in force
   * routing is not applied and it is not safe to stop; with a control and nothing running (including when no route uses the target at all) it is safe.
   */
  async report(by: Principal, command: { level: ControlLevel; name: string }): Promise<CutoverReport> {
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service" || allowsExactly(by, "routing.write", "*"))) throw new DomainError("forbidden", `${by.id} may not read routing state`);
    onlyKnown(command, ["level", "name"]);
    const level = this.#level(command.level);
    await this.tick(by);
    const table = await this.#table();
    const topology = await this.topology();
    const name = this.#known(level, command.name, table, topology);
    const hits = (route: string): boolean => this.#hits({ level, name }, route, topology);
    const routesAffected = Object.keys(table.routes).filter(hits);
    // A control at this level, or at an enclosing level that covers every route of this target (a provider cutover seen from its service), applies.
    const all = (await this.#controls()).entries;
    const entry = all.find((e) => e.level === level && e.name === name) ?? (routesAffected.length === 0 ? undefined : all.find((e) => routesAffected.every((r) => this.#hits(e, r, topology))));
    const calls = await this.#calls();
    const flying = this.#flying(calls).filter((f) => hits(f.route));
    const possible = calls.reduce((n, c) => n + (c.body.charges ?? []).filter((x) => x.status === "possible" && hits(x.route)).length, 0);
    const now = Date.parse(this.#runner.now());
    const local = level === "service" || (routesAffected.length > 0 && routesAffected.every((r) => table.providers[providerOf(r)]?.location === "local"));
    return {
      level, name, ...(entry === undefined ? {} : { mode: entry.mode }), routingApplied: entry !== undefined, inFlightRemaining: flying.length, inFlight: flying.slice(0, 20),
      safeToStop: entry !== undefined && flying.length === 0 && entry.cancelPending !== true, routesAffected, noRouteInUse: flying.length === 0,
      ...(entry?.drainUntil === undefined ? {} : { drainUntil: entry.drainUntil }), drainDeadlinePassed: entry?.drainUntil !== undefined && Date.parse(entry.drainUntil) <= now, cancelPending: entry?.cancelPending === true,
      possibleCharges: possible, stopDiscardsCache: local,
    };
  }

  // ---- health and failback -------------------------------------------------------------------------------------------------

  /**
   * A dispatcher's probe of a target that failed (`account` or `endpoint` scope, named by a route on it). Good probes count toward failback by the policy; a bad one starts the
   * count again. A probe never lifts a control the owner set: those are checked separately by the gate.
   */
  async probe(by: Principal, command: NoActor & { scope: "account" | "endpoint"; route: string; ok: boolean }): Promise<HealthBody | undefined> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "scope", "route", "ok"]);
    if (typeof command.ok !== "boolean") invalid("ok", "must be true or false");
    const { scope, name } = await this.#scopeOf(command.scope, command.route);
    const ref: AggregateRef = { kind: "route-health", id: healthId(scope, name) };
    const ignoreHealthy = (error: unknown): void => { if (!(error instanceof DomainError) || error.code !== "invalid_transition") throw error; };
    await this.#runner.command("routing.probe", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { scope, name, ok: command.ok },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const h = found?.body as unknown as HealthBody | undefined;
        // Nothing to count for a target that is not marked down.
        if (found === undefined || h === undefined || h.state === "healthy") throw new DomainError("invalid_transition", `${scope} ${name} is not marked down`);
        const at = this.#runner.now();
        const policy = (await this.#controls()).failback;
        let next: HealthBody;
        if (!command.ok) { const { firstOkAt: _f, ...rest } = h; void _f; next = { ...rest, probesOk: 0, lastProbeAt: at }; }
        else {
          next = { ...h, probesOk: h.probesOk + 1, firstOkAt: h.firstOkAt ?? at, lastProbeAt: at };
          const stable = Date.parse(at) - Date.parse(next.firstOkAt!) >= policy.stableSeconds * 1000;
          if (policy.mode === "automatic" && !h.needsOwner && next.probesOk >= policy.minProbes && stable) {
            const { firstOkAt: _g, cooldownUntil: _c, retryAt: _r, trialCall: _t, trialUntil: _u, ...rest } = next; void _g; void _c; void _r; void _t; void _u;
            next = { ...rest, state: "healthy", probesOk: 0, restoredAt: at };
          }
        }
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }] as Change[], detail: { scope, name, state: next.state, probesOk: next.probesOk } };
      },
    })).catch(ignoreHealthy);
    return this.health(scope, name);
  }

  /** The owner brings a failed-over target back now, whatever the policy says. */
  async restore(owner: Principal, command: NoActor & { scope: HealthScope; route: string }): Promise<void> {
    this.#requireWriter(owner);
    onlyKnown(command, ["commandId", "scope", "route"]);
    const { scope, name } = await this.#scopeOf(command.scope, command.route);
    const ref: AggregateRef = { kind: "route-health", id: healthId(scope, name) };
    await this.#runner.command("routing.restore", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { scope, name },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const h = found?.body as unknown as HealthBody | undefined;
        if (found === undefined || h === undefined || h.state === "healthy") throw new DomainError("invalid_transition", `${scope} ${name} is not marked down`);
        const { firstOkAt: _f, cooldownUntil: _c, retryAt: _r, trialCall: _t, trialUntil: _u, ...rest } = h; void _f; void _c; void _r; void _t; void _u;
        const next: HealthBody = { ...rest, state: "healthy", probesOk: 0, needsOwner: false, restoredAt: this.#runner.now() };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }] as Change[], detail: { scope, name } };
      },
    }));
  }

  async health(scope: HealthScope, name: string): Promise<HealthBody | undefined> {
    return (await this.#runner.get("route-health", healthId(scope, name)))?.body as unknown as HealthBody | undefined;
  }

  // ---- the gate ------------------------------------------------------------------------------------------------------------

  /** The rules every dispatch obeys; give it to `FallbackService.withEpoch`. Reads current state every time, nothing is cached. */
  gate(): RouteGate {
    return {
      blocked: (route, callId, claim) => this.#blocked(route, callId, claim === true),
      failure: (f) => this.#failure(f),
      success: (x) => this.#success(x),
      tick: (by) => this.tick(by),
    };
  }

  // ---- internals -----------------------------------------------------------------------------------------------------------

  /**
   * Housekeeping on a dispatcher's call (the fallback service calls it from `step`, `report` does too; a scheduler may call it): a drain past its deadline becomes a cutover
   * ("drain deadline reached"), and cancellations still pending are carried out and passed to the listener. Failures here leave the work pending for the next call.
   */
  async tick(by: Principal): Promise<void> {
    await this.#expire();
    if (by.kind === "owner" || by.kind === "host" || by.kind === "service") await this.#process(by, false);
  }

  async #expire(): Promise<void> {
    const now = Date.parse(this.#runner.now());
    const due = (await this.#controls()).entries.filter((e) => e.mode === "drain" && e.drainUntil !== undefined && Date.parse(e.drainUntil) <= now);
    if (due.length === 0) return;
    const ids = due.map((e) => `${e.level}/${e.name}/${e.drainUntil}`);
    try {
      await this.#retry(() => this.#runner.command("routing.expire", { commandId: `drx-${digest(...ids)}`, actor: "controller" }, async () => ({
        payload: { due: ids },
        build: async () => {
          const current = await this.#controlsAggregate();
          const body = this.#bodyOf(current?.body);
          const at = this.#runner.now();
          const entries = body.entries.map((e) => (e.mode === "drain" && ids.includes(`${e.level}/${e.name}/${e.drainUntil}`) ? { ...e, mode: "cutover" as const, reason: `drain deadline reached (${e.reason})`.slice(0, ROUTING_LIMITS.reason), by: "controller", at, expired: true, cancelPending: true } : e));
          if (current === undefined || entries.every((e, i) => e === body.entries[i])) throw new DomainError("invalid_transition", "no drain is past its deadline");
          return { ref: CONTROLS, creates: false, changes: [{ type: "update", ref: CONTROLS, expectedRevision: current.revision, body: { ...body, entries } as unknown as JsonObject }] as Change[], detail: { expired: ids.length } };
        },
      })));
    } catch (error) { if (!(error instanceof DomainError) || error.code !== "invalid_transition") throw error; }
  }

  /** Runs `fn`, again if another writer got in first (a revision conflict), a few times. */
  async #retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (error) { if (i >= 7 || !(error instanceof DomainError) || (error.code !== "command_conflict" && error.code !== "stale_revision")) throw error; }
    }
  }

  /**
   * Carries out every pending cutover: abandons the attempts running on its target (each failure is kept and the others go on), passes everything the cutover has abandoned to the
   * listener (again on a repeat, so a listener that failed once hears it), and marks it done only when both succeeded. Returns what was passed on.
   */
  async #process(by: Principal, rethrow: boolean): Promise<InFlight[]> {
    if (this.#fallback === undefined) return [];
    const pending = (await this.#controls()).entries.filter((e) => e.mode === "cutover" && e.cancelPending === true);
    if (pending.length === 0) return [];
    const topology = await this.topology();
    const out: InFlight[] = [];
    let failure: unknown;
    for (const e of pending) {
      const reason = `cutover of ${e.level} ${e.name}`;
      let done = true;
      for (const f of this.#flying(await this.#calls())) {
        if (!this.#hits(e, f.route, topology)) continue;
        try { await this.#retry(() => this.#fallback!.abandon(by, { commandId: `cut-${digest(e.level, e.name, e.at, f.callId, String(f.attempt))}`, callId: f.callId, attempt: f.attempt, reason })); }
        catch (error) { if (error instanceof DomainError && error.code === "invalid_transition") continue; done = false; failure ??= error; }
      }
      const mine = (await this.#calls()).flatMap((c) => c.body.attempts.flatMap((a, i) => (a.outcome === "abandoned" && a.abandoned === reason && (a.endedAt ?? "") >= e.at ? [{ callId: c.id, taskId: c.body.taskId, route: a.route, attempt: i + 1, since: a.at }] : [])));
      out.push(...mine);
      if (mine.length > 0 && this.#onCancelled !== undefined) { try { await this.#onCancelled(mine); } catch (error) { done = false; failure ??= error; } }
      if (done) {
        try {
          await this.#retry(() => this.#runner.command("routing.cancelled", { commandId: `ack-${digest(e.level, e.name, e.at)}`, actor: "controller" }, async () => ({
            payload: { level: e.level, name: e.name, at: e.at },
            build: async () => {
              const current = await this.#controlsAggregate();
              const body = this.#bodyOf(current?.body);
              if (current === undefined || !body.entries.some((x) => x.level === e.level && x.name === e.name && x.at === e.at && x.cancelPending === true)) throw new DomainError("invalid_transition", "nothing is pending");
              const entries = body.entries.map((x) => (x.level === e.level && x.name === e.name && x.at === e.at ? { ...x, cancelPending: false } : x));
              return { ref: CONTROLS, creates: false, changes: [{ type: "update", ref: CONTROLS, expectedRevision: current.revision, body: { ...body, entries } as unknown as JsonObject }] as Change[], detail: { level: e.level, name: e.name } };
            },
          })));
        } catch (error) { if (!(error instanceof DomainError) || error.code !== "invalid_transition") { failure ??= error; } }
      }
    }
    if (failure !== undefined && rethrow) throw failure;
    return out;
  }

  async #claimTrial(scope: HealthScope, name: string, callId: string): Promise<boolean> {
    const found = await this.#runner.get("route-health", healthId(scope, name));
    const h = found?.body as unknown as HealthBody | undefined;
    if (found === undefined || h === undefined) return false;
    const now = this.#runner.now();
    const next: HealthBody = { ...h, trialCall: callId, trialUntil: new Date(Date.parse(now) + FALLBACK_LIMITS.outageSeconds * 1000).toISOString() };
    try {
      // One writer wins the revision; a loser is refused and stays blocked.
      await this.#runner.command("routing.trial", { commandId: `trial-${digest(scope, name, callId)}-${randomUUID()}`, actor: "controller" }, async () => ({
        payload: { scope, name, callId },
        build: async () => ({ ref: { kind: "route-health", id: healthId(scope, name) }, creates: false, changes: [{ type: "update", ref: { kind: "route-health", id: healthId(scope, name) }, expectedRevision: found.revision, body: next as unknown as JsonObject }] as Change[], detail: { scope, name } }),
      }));
      return true;
    } catch (error) { if (error instanceof DomainError) return false; throw error; }
  }

  /** A call that held a half-open trial succeeded: the target is back (the same as a restore by probes; a failure soon after is flapping). */
  async #success(x: { route: string; callId: string }): Promise<void> {
    const t = targetOf(await this.topology(), x.route);
    for (const [scope, name] of [["account", t.account], ["endpoint", t.endpoint]] as [HealthScope, string][]) {
      const h = await this.health(scope, name);
      if (h?.state !== "down" || h.trialCall !== x.callId) continue;
      const ref: AggregateRef = { kind: "route-health", id: healthId(scope, name) };
      try {
        await this.#retry(() => this.#runner.command("routing.trialok", { commandId: `tok-${digest(scope, name, x.callId)}`, actor: "controller" }, async () => ({
          payload: { scope, name, callId: x.callId },
          build: async () => {
            const found = await this.#runner.get(ref.kind, ref.id);
            const cur = found?.body as unknown as HealthBody | undefined;
            if (found === undefined || cur?.state !== "down" || cur.trialCall !== x.callId) throw new DomainError("invalid_transition", "that trial is over");
            const { firstOkAt: _f, cooldownUntil: _c, retryAt: _r, trialCall: _t, trialUntil: _u, ...rest } = cur; void _f; void _c; void _r; void _t; void _u;
            const next: HealthBody = { ...rest, state: "healthy", probesOk: 0, restoredAt: this.#runner.now() };
            return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }] as Change[], detail: { scope, name } };
          },
        })));
      } catch (error) { if (!(error instanceof DomainError) || error.code !== "invalid_transition") throw error; }
    }
  }

  async #blocked(route: string, callId?: string, claim = false): Promise<string[]> {
    await this.#expire();
    const reasons: string[] = [];
    const table = await this.#tableOrUndefined();
    const topology = await this.topology();
    const t = targetOf(topology, route);
    if (table !== undefined && t.canonical !== route) {
      // The alias is judged as the route it really is: a disabled or excluded provider or route stays out of reach under another name.
      if (table.routes[t.canonical] === undefined) reasons.push(`alias of ${t.canonical}, which is not a configured route`);
      if (table.providers[t.provider]?.enabled === false) reasons.push(`alias of ${t.canonical}, whose provider ${t.provider} is disabled`);
      for (const x of table.exclusions) if ((x.target.kind === "provider" && x.target.name === t.provider) || (x.target.kind === "route" && x.target.name === t.canonical)) reasons.push(`alias of ${t.canonical}, which is excluded: ${x.reason}`);
    }
    const { entries, failback } = await this.#controls();
    for (const e of entries) {
      if (!this.#hits(e, route, topology)) continue;
      reasons.push(`${e.level} ${e.name} is ${e.mode === "disabled" ? "disabled" : e.mode === "drain" ? "draining (no new work)" : "cut over"}: ${e.reason}`);
    }
    const now = Date.parse(this.#runner.now());
    for (const [scope, name] of [["account", t.account], ["endpoint", t.endpoint], ["model", t.canonical]] as [HealthScope, string][]) {
      const h = await this.health(scope, name);
      if (h === undefined) continue;
      if (h.scope === "model") { if (h.cooldownUntil !== undefined && Date.parse(h.cooldownUntil) > now) reasons.push(`model ${name} is rate limited until ${h.cooldownUntil}`); }
      else if (h.state === "down") {
        if (h.trialCall !== undefined && h.trialCall === callId && h.trialUntil !== undefined && Date.parse(h.trialUntil) > now) continue;
        // A due trial passes a look; it is claimed (one call wins) only when the caller says the route is the one chosen.
        if (failback.mode === "automatic" && !h.needsOwner && callId !== undefined && h.retryAt !== undefined && Date.parse(h.retryAt) <= now && (h.trialUntil === undefined || Date.parse(h.trialUntil) <= now) && (!claim || await this.#claimTrial(scope, name, callId))) continue;
        reasons.push(`${scope} ${name} is down since ${h.since} (${h.lastClass}); it returns by the failback policy${h.needsOwner ? " and needs the owner after failing again soon after its last restore" : ""}${h.retryAt === undefined ? "" : `; one trial is allowed from ${h.retryAt}`}`);
      }
    }
    return reasons;
  }

  async #failure(f: { route: string; class: FailureClass; at: string; key: string }): Promise<void> {
    if (!(f.class === "credit" || f.class === "auth" || f.class === "outage" || f.class === "rate-limit")) invalid("class", "is not an availability failure");
    // The payload is what was reported, never what the topology says now, so an older report replayed after a topology change is the recorded answer. Concurrent failures
    // meet on one health record; the loser of a revision race is run again against the new state.
    await this.#retry(() => this.#runner.command("routing.failure", { commandId: `hf-${digest(f.key)}`, actor: "controller" }, async () => ({
      payload: { route: f.route, class: f.class, at: f.at },
      build: async () => {
        const t = targetOf(await this.topology(), f.route);
        const [scope, name]: [HealthScope, string] = f.class === "credit" || f.class === "auth" ? ["account", t.account] : f.class === "outage" ? ["endpoint", t.endpoint] : ["model", t.canonical];
        const ref: AggregateRef = { kind: "route-health", id: healthId(scope, name) };
        const found = await this.#runner.get(ref.kind, ref.id);
        const h = found?.body as unknown as HealthBody | undefined;
        const policy = (await this.#controls()).failback;
        let next: HealthBody;
        if (scope === "model") {
          next = { scope, name, state: "healthy", since: f.at, lastClass: f.class, failures: (h?.failures ?? 0) + 1, probesOk: 0, needsOwner: false, cooldownUntil: new Date(Date.parse(f.at) + FALLBACK_LIMITS.rateLimitSeconds * 1000).toISOString() };
        } else {
          const flapped = h?.restoredAt !== undefined && Date.parse(f.at) - Date.parse(h.restoredAt) < policy.holdDownSeconds * 1000;
          const { firstOkAt: _f, trialCall: _t, trialUntil: _u, retryAt: _r, restoredAt, ...rest } = h ?? ({} as Partial<HealthBody>);
          void _f; void _t; void _u; void _r;
          // Nothing probes in a plain installation, so a down target is tried once after the R02 outage cooldown (half-open) instead of waiting for the owner.
          next = { ...(rest as object), scope, name, state: "down", since: h?.state === "down" ? h.since : f.at, lastClass: f.class, failures: (h?.failures ?? 0) + 1, probesOk: 0, needsOwner: (h?.needsOwner ?? false) || flapped, retryAt: new Date(Date.parse(f.at) + FALLBACK_LIMITS.outageSeconds * 1000).toISOString(), ...(restoredAt === undefined ? {} : { restoredAt }) } as HealthBody;
        }
        return { ref, creates: found === undefined, changes: [found === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }] as Change[], detail: { scope, name, class: f.class } };
      },
    })));
  }

  async #control(owner: Principal, type: string, mode: ControlMode, command: NoActor & { level: ControlLevel; name: string; reason: string }, drainSeconds: number | undefined): Promise<{ revision: number; replayed: boolean }> {
    this.#requireWriter(owner);
    const reason = this.#reason(command.reason);
    const r = await this.#runner.command(type, { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, mode === "drain" ? ["commandId", "level", "name", "reason", "drainSeconds"] : ["commandId", "level", "name", "reason"]);
      const level = this.#level(command.level);
      const name = typeof command.name === "string" ? command.name : invalid("name", "must be text");
      return {
        payload: { level, name, mode, reason, drainSeconds: drainSeconds ?? null },
        build: async () => {
          const key = await this.#key(level, name);
          const current = await this.#controlsAggregate();
          const body = this.#bodyOf(current?.body);
          const old = body.entries.find((e) => e.level === level && e.name === key);
          // disabled -> drain -> cutover, never back: a drain cannot be turned into a plain disable, and a cut over target is already as stopped as it gets.
          if (old !== undefined && (old.mode === "cutover" || (old.mode === "drain" && mode !== "cutover") || (old.mode === "disabled" && mode === "disabled"))) throw new DomainError("invalid_command", `${level} ${key} is already ${old.mode === "drain" ? "draining" : old.mode === "cutover" ? "cut over" : "disabled"}; lift it first to change it`, { field: "name" });
          if (old === undefined && body.entries.length >= CUTOVER_LIMITS.entries) throw new DomainError("invalid_command", `at most ${CUTOVER_LIMITS.entries} controls are kept; lift one first`, { field: "name" });
          const at = this.#runner.now();
          const entry: ControlEntry = { level, name: key, mode, reason, by: owner.id, at, ...(mode === "cutover" ? { cancelPending: true } : {}), ...(drainSeconds === undefined ? {} : { drainUntil: new Date(Date.parse(at) + drainSeconds * 1000).toISOString() }) };
          return this.#write(owner, current, { ...body, entries: [...body.entries.filter((e) => e !== old), entry] }, { level, name: key, mode, reason });
        },
      };
    });
    return { revision: r.revision, replayed: r.replayed };
  }

  #hits(target: { level: ControlLevel; name: string }, route: string, topology: Topology): boolean {
    const t = targetOf(topology, route);
    switch (target.level) {
      case "model": return t.canonical === target.name;
      case "endpoint": return t.endpoint === target.name;
      case "account": return t.account === target.name;
      case "provider": return t.provider === target.name || providerOf(route) === target.name;
      case "service": return t.service === target.name;
    }
  }

  /** The stored name of a target: a route name is stored as the route it resolves to. */
  async #key(level: ControlLevel, name: string): Promise<string> { return this.#known(level, name, await this.#table(), await this.topology()); }

  #known(level: ControlLevel, name: unknown, table: RoutingTable | Omit<RoutingTable, "exclusions">, topology: Topology): string {
    if (typeof name !== "string" || name.length < 1 || name.length > 200) return invalid("name", "must be a name");
    const found = (ok: boolean): string => (ok ? name : ((): never => { throw new DomainError("not_found", `${level} ${name} is not known to the routing table or topology`, { field: "name" }); })());
    switch (level) {
      case "model": { const canon = topology.aliases[name] ?? name; return Object.hasOwn(table.routes, canon) ? canon : found(false); }
      case "provider": return found(Object.hasOwn(table.providers, name));
      case "service": return found(topology.services.includes(name));
      case "endpoint": return found(Object.keys(table.routes).some((r) => targetOf(topology, r).endpoint === name));
      case "account": return found(Object.keys(table.routes).some((r) => targetOf(topology, r).account === name));
    }
  }

  async #scopeOf(scope: unknown, route: unknown): Promise<{ scope: HealthScope; name: string }> {
    if (scope !== "account" && scope !== "endpoint" && scope !== "model") return invalid("scope", "must be account, endpoint or model");
    if (typeof route !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}\/.{1,128}$/.test(route)) return invalid("route", "must be provider/model");
    const t = targetOf(await this.topology(), route);
    return { scope, name: scope === "account" ? t.account : scope === "endpoint" ? t.endpoint : t.canonical };
  }

  #write(owner: Principal, current: { revision: number } | undefined, body: ControlsBody, detail: JsonObject): { ref: AggregateRef; creates: boolean; changes: Change[]; detail: JsonObject } {
    const next = { ...body, updatedBy: owner.id } as unknown as JsonObject;
    return { ref: CONTROLS, creates: current === undefined, changes: [current === undefined ? { type: "create", ref: CONTROLS, body: next } : { type: "update", ref: CONTROLS, expectedRevision: current.revision, body: next }], detail };
  }

  #topologyOf(body: unknown): Topology { const b = body as Topology; return { targets: b.targets, aliases: b.aliases, services: b.services }; }
  #bodyOf(body: unknown): ControlsBody { return (body as ControlsBody | undefined) ?? { entries: [], failback: DEFAULT_FAILBACK, updatedBy: "" }; }
  async #controlsAggregate() { return this.#runner.get(CONTROLS.kind, CONTROLS.id); }
  async #controls(): Promise<ControlsBody> { return this.#bodyOf((await this.#controlsAggregate())?.body); }
  async #tableOrUndefined(): Promise<RoutingBody | undefined> { return this.#routing.get(); }
  async #table(): Promise<RoutingBody> { const t = await this.#routing.get(); if (t === undefined) throw new DomainError("not_found", "no routing table is configured"); return t; }
  /** Every model call's record (a bounded scan, 200 at a time). */
  async #calls(): Promise<{ id: string; body: CallBody }[]> {
    const out: { id: string; body: CallBody }[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list("model-call", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) { after = a.id; out.push({ id: a.id, body: a.body as unknown as CallBody }); }
      if (page.length < 200) return out;
    }
  }
  #flying(calls: readonly { id: string; body: CallBody }[]): InFlight[] {
    return calls.flatMap((c) => { const last = c.body.attempts.at(-1); return c.body.state === "running" && last?.outcome === "started" ? [{ callId: c.id, taskId: c.body.taskId, route: last.route, attempt: c.body.attempts.length, since: last.at }] : []; });
  }

  #level(v: unknown): ControlLevel { return LEVELS.includes(v as ControlLevel) ? (v as ControlLevel) : invalid("level", `must be one of ${LEVELS.join(", ")}`); }
  #reason(v: unknown): string {
    const out = text(v, "reason", { min: 1, max: ROUTING_LIMITS.reason });
    if (redactText(out) !== out) invalid("reason", "looks like a credential or key; those are not recorded");
    return out;
  }
  #requireWriter(p: Principal): void { if (!allowsExactly(p, "routing.write", "*")) throw new DomainError("forbidden", `${p.id} may not change routing; only the owner, or someone the owner gave routing.write`); }
  #dispatcher(p: Principal): void { if (!(p.kind === "owner" || p.kind === "host" || p.kind === "service")) throw new DomainError("forbidden", `${p.id} is not the dispatcher`); }
}

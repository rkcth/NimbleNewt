import { DomainError } from "../domain/errors.js";
import { clipText } from "../activity/activity.js";
import { redactText } from "../security/redact.js";
import type { ControllerStorage } from "../storage/types.js";
import type { DispatcherService } from "../dispatch/dispatcher.js";
import { TERMINAL } from "../dispatch/model.js";
import type { Principal } from "../security/principals.js";
import type { PauseScope } from "./pause.js";
import type { InventoryItem, StopPorts } from "./stop.js";

type Dispatcher = Pick<DispatcherService, "liveAttemptsOf" | "get" | "quiesce" | "stop" | "operations" | "release" | "localWorkOf">;

/**
 * The agent IDs a scope covers (card L02b): an agent is itself; a team is every agent whose team chain passes through it (the same walk the pause gate reads); the installation is every agent. Cycles and over-long chains stop the walk.
 * Read from the records at the moment of asking, so an agent moved into the team since the request is in the next call's answer (the inventory is asked again at each phase).
 */
/** The dispatcher keeps an attempt's agent as its principal ID (`agent:agt-…`); scopes and agent records use the bare ID. */
const principalForm = (id: string): string => (id.startsWith("agent:") ? id : `agent:${id}`);

export async function agentsUnder(storage: Pick<ControllerStorage, "listAggregates">, scope: PauseScope): Promise<string[]> {
  const page = 200;
  const teams = new Map<string, string | undefined>();
  for (let after: string | undefined; ;) {
    const chunk = await storage.listAggregates("team", { ...(after === undefined ? {} : { afterId: after }), limit: page });
    for (const t of chunk) { after = t.id; teams.set(t.id, (t.body as unknown as { parentTeamId?: string }).parentTeamId); }
    if (chunk.length < page) break;
  }
  const out: string[] = [];
  for (let after: string | undefined; ;) {
    const chunk = await storage.listAggregates("agent", { ...(after === undefined ? {} : { afterId: after }), limit: page });
    for (const a of chunk) {
      after = a.id;
      if (scope.kind === "installation") { out.push(a.id); continue; }
      let at = (a.body as unknown as { teamId?: string }).teamId;
      for (let hops = 0; at !== undefined && hops < 50; hops++) { if (at === scope.id) { out.push(a.id); break; } at = teams.get(at); }
    }
    if (chunk.length < page) return out;
  }
}

/**
 * The runtime side of Suspend and Stop for the attempt dispatcher (card L02). Task and agent scopes are the attempts the dispatcher has live for them; a team or installation scope is resolved to the agents under it by the `members` hook (card L02b); without the hook it says so and the request is refused instead of claiming a suspension. The dispatcher's own steps are the cleanup: new calls are refused, calls in flight settle (a
 * ledger call is never cut), and a checkpoint is taken; the checkpoint counts as durable when the checkpoint hook returned one. Whether the artifacts a checkpoint names are durable is not known here, so it is
 * taken from the hook's answer when it says (`artifactsDurable`), and otherwise assumed durable only when the checkpoint came back.
 */
/**
 * What only the runtime knows (card L02d): the local processes an attempt started and the work it delegated to children, each running, asked to stop and not stopped ("uncooperative", so Force Stop is offered), or of unknown state; and what the cleanup cost.
 * The controller keeps no registry of either, so a runtime that reports them passes this in; without it the inventory simply does not list them (nothing is claimed about what is not known).
 */
export async function swarmDescendants(storage: Pick<ControllerStorage, "listAggregates">, taskId: string, max = 200): Promise<string[]> {
  const page = 500;
  const children = new Map<string, string[]>();
  for (let after: string | undefined, pages = 0; pages < 40; pages++) {
    const chunk = await storage.listAggregates("swarm-link", { ...(after === undefined ? {} : { afterId: after }), limit: page });
    for (const l of chunk) { after = l.id; const parent = (l.body as unknown as { parentTaskId?: string }).parentTaskId; if (typeof parent === "string") children.set(parent, [...(children.get(parent) ?? []), l.id]); }
    if (chunk.length < page) break;
  }
  // Deepest first, each task once (a link cycle cannot loop), at most `max`.
  const out: string[] = [];
  const seen = new Set<string>([taskId]);
  const visit = (id: string): void => { for (const c of children.get(id) ?? []) { if (seen.has(c) || out.length >= max) continue; seen.add(c); visit(c); out.push(c); } };
  visit(taskId);
  return out;
}

/** The stop's view of what the worker hosts hold (card L02d), from the dispatcher: the default `localWork` when the composer passes none. A host that cannot say contributes nothing; one that fails fails the look (the stop shows an unknown item). */
export function hostLocalWork(dispatch: () => { dispatcher: Dispatcher; principal: Principal } | undefined): LocalWork {
  const ask = async (attempts: readonly string[]) => { const h = dispatch(); return h === undefined ? { processes: [], costs: [] } : h.dispatcher.localWorkOf(h.principal, attempts); };
  return {
    processes: async (attempts) => (await ask(attempts)).processes.map((p) => ({ ref: p.ref, kind: p.kind, state: p.state })),
    costs: async (attempts) => [...((await ask(attempts)).costs ?? [])],
  };
}

export interface LocalWork {
  processes?(attempts: readonly string[]): Promise<readonly { readonly ref: string; readonly kind: "process" | "child"; readonly state: "running" | "uncooperative" | "unknown" }[]>;
  /** What this cleanup pass cost (not a running total: the stop adds each pass). A figure that is not a finite number of zero or more is ignored. */
  spent?(attempts: readonly string[]): Promise<number | undefined>;
  /** What the cleanup has cost per attempt, as running totals (the stop charges only what is new). Asked for the attempts seen for the scope, also ones that have ended. */
  costs?(attempts: readonly string[]): Promise<readonly { readonly attemptId: string; readonly costMicros?: number; readonly computeMs?: number }[]>;
}

export function dispatchStopPorts(dispatch: () => { dispatcher: Dispatcher; principal: Principal } | undefined, runtime: () => "none" | "pending" = () => "pending", members?: (scope: PauseScope) => Promise<readonly string[]>, jobs?: (by: Principal, taskId: string) => Promise<readonly { readonly id: string; readonly state: string; readonly kind?: string; readonly background?: boolean; readonly resumability?: string }[]>, local?: LocalWork, ending?: { dropEnding(attemptId: string, why: "owner_stop" | "emergency_stop", reason: string): Promise<unknown> }, more?: {
  /** The tasks spawned (directly or not) by a task, deepest first: a Stop of the task ends their work too (card L02d). */
  readonly descendants?: (taskId: string) => Promise<readonly string[]>;
  /** Asks a task's job to stop on behalf of whoever advances the stop (`force` escalates a stop already asked for). Stop ends background jobs; Pause leaves them. */
  readonly cancelJob?: (by: Principal, jobId: string, options: { force: boolean; reason: string }) => Promise<unknown>;
  /** Charges cleanup spend to a task's budget. */
  readonly charge?: (by: Principal, charge: { commandId: string; taskId: string; agentId?: string; costMicros: number; computeMs: number }) => Promise<unknown>;
}): StopPorts {
  const attemptsOf = async (scope: PauseScope): Promise<string[]> => {
    const h = dispatch();
    // No dispatcher exists in this controller: nothing can be running. A dispatcher that should exist but is not up (a restart in progress, a failed start) is not the same, and nothing is claimed about it.
    if (h === undefined) { if (runtime() === "none") return []; throw new Error("the dispatcher is not running, so what is running cannot be known"); }
    if (scope.kind === "task") {
      // The work of the task's swarm children is part of the task's: a Stop of the task ends it too (the children are listed as `child` items).
      const out = new Set<string>(await h.dispatcher.liveAttemptsOf(h.principal, { taskId: scope.id }));
      for (const child of await more?.descendants?.(scope.id) ?? []) for (const id of await h.dispatcher.liveAttemptsOf(h.principal, { taskId: child })) out.add(id);
      return [...out];
    }
    if (scope.kind === "agent") return h.dispatcher.liveAttemptsOf(h.principal, { agentId: principalForm(scope.id) });
    if (members === undefined) throw new Error(`a ${scope.kind} scope is not resolved to attempts by this runtime yet`);
    const out = new Set<string>();
    for (const agentId of await members(scope)) for (const id of await h.dispatcher.liveAttemptsOf(h.principal, { agentId: principalForm(agentId) })) out.add(id);
    return [...out];
  };
  // The attempts seen for a scope, so a process of one that ended during preparation is still asked about when the stop ends.
  const seen = new Map<string, Set<string>>();
  const localOf = async (attempts: readonly string[], scope: PauseScope, lookOnly = false): Promise<InventoryItem[]> => {
    if (local?.processes === undefined) return [];
    const key = `${scope.kind}:${scope.id}`;
    // A look-only call (a readiness check) asks about what was remembered plus what runs now, and remembers nothing.
    const all = lookOnly ? new Set<string>([...(seen.get(key) ?? []), ...attempts]) : (seen.get(key) ?? new Set<string>());
    if (!lookOnly) { for (const a of attempts) all.add(a); seen.set(key, all); }
    if (all.size === 0) return [];
    const found = await local.processes([...all]).catch(() => undefined);
    // A runtime that cannot say what is running is itself unknown: one item says so, so a stop is never reported clean on silence.
    if (found === undefined) return [{ kind: "process", ref: "runtime:processes", state: "unknown" }];
    // What the runtime says is checked: an entry that is not shaped as promised is itself unknown. A ref (it may be a command line) is redacted before it is cut.
    return found.map((p, i) => (typeof p?.ref === "string" && (p.kind === "process" || p.kind === "child") && ["running", "uncooperative", "unknown"].includes(p.state) ? { kind: p.kind, ref: clipText(redactText(p.ref), 120), state: p.state } : { kind: "process" as const, ref: `runtime:processes#${i}`, state: "unknown" as const }));
  };
  // The tasks whose jobs a stop of this scope concerns: the task itself and its swarm children (task scope), and the task of every attempt seen.
  const tasksOf = async (attempts: readonly string[], scope: PauseScope): Promise<Set<string>> => {
    const h = dispatch();
    const tasks = new Set<string>();
    if (scope.kind === "task") { tasks.add(scope.id); for (const child of await more?.descendants?.(scope.id) ?? []) tasks.add(child); }
    if (h !== undefined) for (const attemptId of attempts) { const taskId = (await h.dispatcher.get(h.principal, attemptId))?.taskId; if (taskId !== undefined) tasks.add(taskId); }
    return tasks;
  };
  const inFlight = async (attempts: readonly string[], scope: PauseScope, lookOnly = false): Promise<InventoryItem[]> => {
    const localItems = await localOf(attempts, scope, lookOnly);
    const h = dispatch();
    const out: InventoryItem[] = [];
    for (const attemptId of attempts) {
      // Work of a swarm child of the task is delegated work (card L02d): listed while its attempt has not ended.
      if (scope.kind === "task" && h !== undefined && more?.descendants !== undefined) { const a = await h.dispatcher.get(h.principal, attemptId); if (a !== undefined && a.taskId !== scope.id && a.state !== "finished") out.push({ kind: "child", ref: attemptId.slice(0, 120), state: "running" }); }
      for (const op of (await h?.dispatcher.operations(h.principal, attemptId)) ?? []) if (!TERMINAL.has(op.state)) out.push({ kind: "foreground", ref: `${attemptId}/${op.callId}`.slice(0, 120), state: "running" });
    }
    // The task's background jobs (card L02c): a running one is counted, one asked to stop that has not is "uncooperative" (Force Stop is offered for it), and one whose outcome is not known is "unknown".
    if (jobs !== undefined && h !== undefined) {
      for (const taskId of await tasksOf(attempts, scope)) {
        for (const job of await jobs(h.principal, taskId)) {
          const state = job.state === "cancellation_requested" ? "uncooperative" : job.state === "outcome_unknown" ? "unknown" : ["admitted", "dispatched", "running"].includes(job.state) ? "running" : undefined;
          // A permitted remote background job that the controller tracks keeps running through a stop: it is named as an exception and not waited for (card L06).
          if (state === "running" && job.kind === "remote" && job.background === true && job.resumability === "remote_tracked") out.push({ kind: "job", ref: job.id.slice(0, 120), state: "tracked" });
          else if (state !== undefined) out.push({ kind: "job", ref: job.id.slice(0, 120), state });
        }
      }
    }
    out.push(...localItems);
    return out;
  };
  // What the cleanup cost, per attempt, for every attempt seen for the scope (also ones that ended during preparation). A runtime that cannot say charges nothing.
  const costsOf = async (scope: PauseScope, attempts: readonly string[]): Promise<{ costs?: { attemptId: string; costMicros?: number; computeMs?: number }[] }> => {
    if (local?.costs === undefined) return {};
    const all = [...new Set<string>([...(seen.get(`${scope.kind}:${scope.id}`) ?? []), ...attempts])];
    if (all.length === 0) return {};
    const costs = await local.costs(all).catch(() => undefined);
    return costs === undefined || !Array.isArray(costs) ? {} : { costs: costs.map((c) => ({ ...c })) };
  };
  return {
    ...(more?.charge === undefined ? {} : { charge: async (c: { commandId: string; attemptId: string; costMicros: number; computeMs: number }) => {
      const h = dispatch();
      const attempt = h === undefined ? undefined : await h.dispatcher.get(h.principal, c.attemptId);
      if (h === undefined || attempt === undefined) throw new Error("the attempt this cleanup cost belongs to is not known");
      await more.charge!(h.principal, { commandId: c.commandId, taskId: attempt.taskId, agentId: attempt.agentId, costMicros: c.costMicros, computeMs: c.computeMs });
    } }),
    // The stop is recorded: the agent's ending is dropped now (the owner's stop wins), so nothing in preparation can complete it (card H12n).
    begin: async (scope, options) => { if (ending === undefined) return; for (const id of await attemptsOf(scope)) await ending.dropEnding(id, options.force ? "emergency_stop" : "owner_stop", options.force ? "force stop" : "stop requested"); },
    attempts: (scope) => [...(seen.get(`${scope.kind}:${scope.id}`) ?? [])],
    remember: (scope, attempts) => { if (attempts.length === 0) return; const key = `${scope.kind}:${scope.id}`; const all = seen.get(key) ?? new Set<string>(); for (const a of attempts) all.add(a); seen.set(key, all); },
    unsupported: (scope) => (scope.kind === "task" || scope.kind === "agent" || members !== undefined ? undefined : `stopping a whole ${scope.kind} is not supported yet; stop its tasks or agents one by one (Force Stop works on each)`),
    inventory: async (scope, options) => inFlight(await attemptsOf(scope), scope, options?.lookOnly === true),
    release: async (scope) => { seen.delete(`${scope.kind}:${scope.id}`); const h = dispatch(); if (h === undefined) return; for (const id of await attemptsOf(scope)) await h.dispatcher.release(h.principal, id, { includeEnding: true }).catch(() => undefined); },
    cleanup: async (scope, options) => {
      const h = dispatch();
      const attempts = await attemptsOf(scope);
      for (const id of attempts) {
        const strictMs = Math.max(1, Math.min(60_000, Date.parse(options.deadlineAt) - Date.now()));
        await h!.dispatcher.quiesce(h!.principal, id, "suspend or stop preparation", { strictMs });
      }
      // What the preparation cost, as the runtime counts it (a hook that is absent or fails says nothing, so nothing is charged on a guess).
      const figure = local?.spent === undefined ? undefined : await local.spent(attempts).catch(() => undefined);
      const spent = typeof figure === "number" && Number.isFinite(figure) && figure >= 0 ? figure : undefined;
      return { remaining: await inFlight(attempts, scope), ...(spent === undefined ? {} : { spent }), ...(await costsOf(scope, attempts)) };
    },
    checkpoint: async (scope) => {
      const h = dispatch();
      const attempts = await attemptsOf(scope);
      if (h === undefined || attempts.length === 0) return { checkpointId: `${scope.kind}:${scope.id}`.slice(0, 120), durable: true, artifactsDurable: true }; // nothing runs here, so there is nothing to save
      let checkpointed = true;
      let artifacts = true;
      for (const id of attempts) {
        const { checkpoint } = await h!.dispatcher.quiesce(h!.principal, id, "checkpoint before suspension");
        if (checkpoint === undefined) checkpointed = false;
        else if (checkpoint["artifactsDurable"] === false) artifacts = false;
      }
      return { checkpointId: `${scope.kind}:${scope.id}`.slice(0, 120), durable: checkpointed, artifactsDurable: artifacts };
    },
    terminate: async (scope, options) => {
      const h = dispatch();
      const attempts = await attemptsOf(scope);
      const unresolved: string[] = [];
      for (const id of attempts) {
        // The owner's stop wins over an agent's ending (card H12n): the intent is dropped before the attempt is stopped, so nothing is staged or submitted for it afterwards.
        await ending?.dropEnding(id, options.force ? "emergency_stop" : "owner_stop", options.force ? "force stop" : "stop after preparation");
        // The attempt may have ended by itself meanwhile (the agent's ending finished it): that one is over, and the others are still stopped.
        try { await h!.dispatcher.stop(h!.principal, id, { reason: options.force ? "force stop" : "stop after preparation", ...(options.force ? { emergency: true } : {}) }); } catch (error) { if (error instanceof DomainError && error.code === "not_found") continue; throw error; }
        for (const op of (await h!.dispatcher.operations(h!.principal, id)) ?? []) if (op.state === "uncertain") unresolved.push(`${id}/${op.callId}`.slice(0, 120));
      }
      // Stop ends the task's background jobs (Pause leaves them running, owner decision): each is asked to stop, a Force Stop escalates one already asked. A permitted remote job the controller tracks is the named exception.
      // The one who advances the stop is the one who asks (they were checked to control the scope); a job they may not control is named as unresolved.
      if (more?.cancelJob !== undefined && jobs !== undefined && h !== undefined) {
        for (const taskId of await tasksOf(attempts, scope)) {
          for (const job of await jobs(h.principal, taskId)) {
            if (job.kind === "remote" && job.background === true && job.resumability === "remote_tracked") continue;
            if (!["admitted", "dispatched", "running"].includes(job.state) && !(options.force && job.state === "cancellation_requested")) continue;
            try { await more.cancelJob(options.by, job.id, { force: options.force, reason: options.force ? "force stop" : "stop after preparation" }); } catch (error) { if (!(error instanceof DomainError && (error.code === "invalid_command" || error.code === "not_found"))) unresolved.push(job.id.slice(0, 120)); }
          }
        }
      }
      // A job whose outcome is not known, or that was asked to stop and has not, is named as unresolved too.
      // Looking again can fail; that is not a clean stop. A process or child still running after the stop did not end either.
      const after = await inFlight(attempts, scope).catch(() => [{ kind: "process", ref: "runtime:inventory", state: "unknown" } as InventoryItem]);
      for (const item of after) if (((item.kind === "process" || item.kind === "child") && item.state !== "settled") || (item.kind === "job" && (item.state === "unknown" || item.state === "uncooperative"))) unresolved.push(item.ref);
      // The stop is over for this scope: what was remembered about its attempts is not carried into a later one.
      const costs = await costsOf(scope, attempts);
      seen.delete(`${scope.kind}:${scope.id}`);
      return { ended: true, unresolved, ...costs };
    },
  };
}

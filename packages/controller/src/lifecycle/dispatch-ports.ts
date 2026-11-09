import { DomainError } from "../domain/errors.js";
import { clipText } from "../activity/activity.js";
import { redactText } from "../security/redact.js";
import type { ControllerStorage } from "../storage/types.js";
import type { DispatcherService } from "../dispatch/dispatcher.js";
import { TERMINAL } from "../dispatch/model.js";
import type { Principal } from "../security/principals.js";
import type { PauseScope } from "./pause.js";
import type { InventoryItem, StopPorts } from "./stop.js";

type Dispatcher = Pick<DispatcherService, "liveAttemptsOf" | "get" | "quiesce" | "stop" | "operations" | "release" | "localWorkOf"> & Partial<Pick<DispatcherService, "endLocalWorkOf">>;

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
/** The swarm links read once: every task with the child tasks that hang below it. `truncated`: there are more links than were read. */
async function childIndexOf(storage: Pick<ControllerStorage, "listAggregates">): Promise<{ children: Map<string, string[]>; truncated: boolean }> {
  const page = 500;
  const children = new Map<string, string[]>();
  let truncated = false;
  for (let after: string | undefined, pages = 0; ; pages++) {
    // At most 40 pages (20,000 links) are read; more is said, not ignored.
    if (pages >= 40) { truncated = true; break; }
    const chunk = await storage.listAggregates("swarm-link", { ...(after === undefined ? {} : { afterId: after }), limit: page });
    for (const l of chunk) { after = l.id; const parent = (l.body as unknown as { parentTaskId?: string }).parentTaskId; if (typeof parent === "string") children.set(parent, [...(children.get(parent) ?? []), l.id]); }
    if (chunk.length < page) break;
  }
  return { children, truncated };
}

/** The tasks below `roots`, deepest first, each task once (a link cycle cannot loop), at most `max`; the roots themselves are never among them. */
function tasksBelow(children: ReadonlyMap<string, readonly string[]>, roots: readonly string[], max: number, cut: boolean): { ids: string[]; truncated: boolean } {
  let truncated = cut;
  const out: string[] = [];
  const seen = new Set<string>(roots);
  const visit = (id: string): void => { for (const c of children.get(id) ?? []) { if (seen.has(c)) continue; if (out.length >= max) { truncated = true; continue; } seen.add(c); visit(c); out.push(c); } };
  for (const root of roots) visit(root);
  return { ids: out, truncated };
}

export async function swarmDescendantsInfo(storage: Pick<ControllerStorage, "listAggregates">, taskId: string, max = 200): Promise<{ ids: string[]; truncated: boolean }> {
  const index = await childIndexOf(storage);
  return tasksBelow(index.children, [taskId], max, index.truncated);
}

/** The swarm descendants of several tasks at once, deduplicated: a Stop of an agent, a team or the installation wants the children of every task it covers (card L02e). */
export async function swarmDescendantsOf(storage: Pick<ControllerStorage, "listAggregates">, taskIds: readonly string[], max = 200): Promise<{ ids: string[]; truncated: boolean }> {
  const index = await childIndexOf(storage);
  return tasksBelow(index.children, taskIds, max, index.truncated);
}

export async function swarmDescendants(storage: Pick<ControllerStorage, "listAggregates">, taskId: string, max = 200): Promise<string[]> { return (await swarmDescendantsInfo(storage, taskId, max)).ids; }

/** The stop's view of what the worker hosts hold (card L02d), from the dispatcher: the default `localWork` when the composer passes none. A host that cannot say contributes nothing; one that fails fails the look (the stop shows an unknown item). */
export function hostLocalWork(dispatch: () => { dispatcher: Dispatcher; principal: Principal } | undefined): LocalWork {
  const ask = async (attempts: readonly string[]) => { const h = dispatch(); return h === undefined ? { processes: [], costs: [] } : h.dispatcher.localWorkOf(h.principal, attempts); };
  return {
    processes: async (attempts) => (await ask(attempts)).processes.map((p) => ({ ref: p.ref, kind: p.kind, state: p.state })),
    costs: async (attempts) => [...((await ask(attempts)).costs ?? [])],
    end: async (attempts) => { const h = dispatch(); await h?.dispatcher.endLocalWorkOf?.(h.principal, attempts); },
  };
}

export interface LocalWork {
  processes?(attempts: readonly string[]): Promise<readonly { readonly ref: string; readonly kind: "process" | "child"; readonly state: "running" | "uncooperative" | "unknown" }[]>;
  /** What this cleanup pass cost (not a running total: the stop adds each pass). A figure that is not a finite number of zero or more is ignored. */
  spent?(attempts: readonly string[]): Promise<number | undefined>;
  /** What the cleanup has cost per attempt, as running totals (the stop charges only what is new). Asked for the attempts seen for the scope, also ones that have ended. */
  costs?(attempts: readonly string[]): Promise<readonly { readonly attemptId: string; readonly costMicros?: number; readonly computeMs?: number }[]>;
  /** Force Stop: kill whatever the runtime still holds for these attempts, without asking first (card L02d). Asked for every attempt seen for the scope, after their attempts were ended. Absent: a Force Stop ends the attempts and nothing more. */
  end?(attempts: readonly string[]): Promise<void>;
}

type JobRow = { readonly ownerUnknown?: boolean; readonly id: string; readonly state: string; readonly kind?: string; readonly background?: boolean; readonly resumability?: string; readonly attemptId?: string };

export function dispatchStopPorts(dispatch: () => { dispatcher: Dispatcher; principal: Principal } | undefined, runtime: () => "none" | "pending" = () => "pending", members?: (scope: PauseScope) => Promise<readonly string[]>, jobs?: (by: Principal, taskId: string) => Promise<readonly JobRow[]>, local?: LocalWork, ending?: { dropEnding(attemptId: string, why: "owner_stop" | "emergency_stop", reason: string): Promise<unknown> }, more?: {
  /** The tasks spawned (directly or not) by a task, deepest first: a Stop of the task ends their work too (card L02d). `truncated`: there are more than were returned (the stop says so as an unknown item). */
  readonly descendants?: (taskId: string) => Promise<{ readonly ids: readonly string[]; readonly truncated: boolean }>;
  /** The tasks spawned below any of these tasks at once, for a Stop of an agent, a team or the installation, which covers many tasks (card L02e). Absent: the single-task walk is used for each root. */
  readonly descendantsOf?: (taskIds: readonly string[]) => Promise<{ readonly ids: readonly string[]; readonly truncated: boolean }>;
  /** Whether the one who advances the stop may end the work of this child task (the owner, or whoever holds its parent's budget, like `swarm.cancel`). Absent: every child. A child they may not control is listed as unresolved, not stopped. */
  readonly mayControl?: (by: Principal, taskId: string) => Promise<boolean>;
  /** Every unfinished job on any task, to find an agent's jobs also on a task with no live attempt (the owner of a job is the agent of its attempt). */
  readonly agentJobs?: (by: Principal) => Promise<{ readonly jobs: readonly (JobRow & { readonly taskId: string })[]; readonly truncated: boolean }>;
  /** Asks a task's job to stop on behalf of whoever advances the stop (`force` escalates a stop already asked for). Stop ends background jobs; Pause leaves them. */
  readonly cancelJob?: (by: Principal, jobId: string, options: { force: boolean; reason: string }) => Promise<unknown>;
  /** Charges cleanup spend to a task's budget. */
  readonly charge?: (by: Principal, charge: { commandId: string; taskId: string; agentId?: string; costMicros: number; computeMs: number }) => Promise<unknown>;
}): StopPorts {
  /** What one port call has already looked up (the swarm walk reads every link, so it is done once per call, not once per use). Per scope: `own` the tasks of the scope itself, `kids` the tasks spawned below them, `truncated` that the walk was cut, `attempts` every attempt seen for the scope (its own tasks' and their children's). */
  interface Look { readonly descendants: Map<string, { ids: readonly string[]; truncated: boolean }>; readonly agents: Map<string, string | undefined>; readonly scopes: Map<string, { own: Set<string>; kids: Set<string>; truncated: boolean; attempts: string[] }> }
  const look = (): Look => ({ descendants: new Map(), agents: new Map(), scopes: new Map() });
  const kids = async (l: Look, taskId: string): Promise<{ ids: readonly string[]; truncated: boolean }> => {
    const had = l.descendants.get(taskId);
    if (had !== undefined) return had;
    const got = more?.descendants === undefined ? { ids: [], truncated: false } : await more.descendants(taskId);
    l.descendants.set(taskId, got);
    return got;
  };
  /** The tasks below several roots at once: a hook that walks them together is used when there is one (the link index is read once for the lot), otherwise each root is walked on its own. */
  const kidsOf = async (roots: readonly string[]): Promise<{ ids: readonly string[]; truncated: boolean }> => {
    if (roots.length === 0) return { ids: [], truncated: false };
    if (more?.descendantsOf !== undefined) return await more.descendantsOf(roots);
    if (more?.descendants === undefined) return { ids: [], truncated: false };
    const ids: string[] = [];
    let truncated = false;
    for (const root of roots) { const got = await more.descendants(root); truncated = truncated || got.truncated; for (const id of got.ids) if (!ids.includes(id)) ids.push(id); }
    return { ids, truncated };
  };
  /** Whether this runtime walks the swarm at all. */
  const walks = () => more?.descendants !== undefined || more?.descendantsOf !== undefined;
  const agentOfAttempt = async (l: Look, attemptId: string): Promise<string | undefined> => {
    if (l.agents.has(attemptId)) return l.agents.get(attemptId);
    const h = dispatch();
    const agent = h === undefined ? undefined : (await h.dispatcher.get(h.principal, attemptId))?.agentId;
    l.agents.set(attemptId, agent);
    return agent;
  };
  /**
   * What a scope covers: `own` the tasks of the scope itself (a task is itself; a wider scope's tasks are those its attempts run), `kids` the tasks spawned below them (a Stop of an agent, a team or the installation reaches
   * their work as a task's own Stop does, card L02e), `truncated` that the walk was cut, and `attempts` every live attempt of either. Read once per port call.
   */
  const resolveScope = async (scope: PauseScope, l: Look): Promise<{ own: Set<string>; kids: Set<string>; truncated: boolean; attempts: string[] }> => {
    const key = `${scope.kind}:${scope.id}`;
    const had = l.scopes.get(key);
    if (had !== undefined) return had;
    // No dispatcher exists in this controller: nothing can be running. A dispatcher that should exist but is not up (a restart in progress, a failed start) is not the same, and nothing is claimed about it.
    const h = dispatch();
    if (h === undefined) {
      if (runtime() !== "none") throw new Error("the dispatcher is not running, so what is running cannot be known");
      const nothing = { own: new Set<string>(), kids: new Set<string>(), truncated: false, attempts: [] };
      l.scopes.set(key, nothing);
      return nothing;
    }
    let mine: string[] = [];
    if (scope.kind === "task") mine = await h.dispatcher.liveAttemptsOf(h.principal, { taskId: scope.id });
    else if (scope.kind === "agent") mine = await h.dispatcher.liveAttemptsOf(h.principal, { agentId: principalForm(scope.id) });
    else {
      if (members === undefined) throw new Error(`a ${scope.kind} scope is not resolved to attempts by this runtime yet`);
      for (const agentId of await members(scope)) mine.push(...await h.dispatcher.liveAttemptsOf(h.principal, { agentId: principalForm(agentId) }));
    }
    // The tasks the scope's own attempts run: a wider scope is named by its agent, team or the installation, so its tasks are known only from what runs for them.
    const own = new Set<string>(scope.kind === "task" ? [scope.id] : []);
    for (const id of mine) { const t = (await h.dispatcher.get(h.principal, id))?.taskId; if (t !== undefined) own.add(t); }
    const walked = scope.kind === "task" ? await kids(l, scope.id) : await kidsOf([...own]);
    const childTasks = new Set<string>(walked.ids);
    const out = new Set<string>(mine);
    for (const child of childTasks) for (const id of await h.dispatcher.liveAttemptsOf(h.principal, { taskId: child })) out.add(id);
    const resolved = { own, kids: childTasks, truncated: walked.truncated, attempts: [...out] };
    l.scopes.set(key, resolved);
    return resolved;
  };
  const attemptsOf = async (scope: PauseScope, l: Look = look()): Promise<string[]> => (await resolveScope(scope, l)).attempts;
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
  /**
   * The jobs a stop of this scope concerns. A task: its own jobs and its swarm children's. An agent, team or the installation: the jobs of the attempts of those agents (a job's owner is the agent of its attempt), found among all
   * unfinished jobs, also on a task with no live attempt, and never another agent's job on the same task. `incomplete`: the list was cut at a limit (an unknown item says so).
   */
  const jobsFor = async (attempts: readonly string[], scope: PauseScope, l: Look): Promise<{ rows: (JobRow & { taskId: string })[]; incomplete: boolean }> => {
    const h = dispatch();
    if (jobs === undefined || h === undefined) return { rows: [], incomplete: false };
    const rows = new Map<string, JobRow & { taskId: string }>();
    const covered = await resolveScope(scope, l);
    let incomplete = false;
    if (scope.kind !== "task" && more?.agentJobs !== undefined) {
      const owners = new Set<string>(scope.kind === "agent" ? [principalForm(scope.id)] : (await (members?.(scope) ?? Promise.resolve([]))).map(principalForm));
      const all = await more.agentJobs(h.principal);
      incomplete = all.truncated;
      // The tasks of the scope's attempts: a job there with no attempt has no known owner and is included as such (listed for everyone, ended only by the owner).
      const scopeTasks = new Set<string>();
      for (const attemptId of attempts) { const t = (await h.dispatcher.get(h.principal, attemptId))?.taskId; if (t !== undefined) scopeTasks.add(t); }
      for (const j of all.jobs) {
        if (j.attemptId === undefined) { if (scopeTasks.has(j.taskId)) rows.set(j.id, { ...j, ownerUnknown: true }); continue; }
        const owner = await agentOfAttempt(l, j.attemptId);
        if (owner !== undefined && owners.has(owner)) rows.set(j.id, j);
      }
      // A child task of the scope is the scope's work too (card L02e): its jobs are listed, and asked only of someone who may control that child (see `askJobs`).
      for (const taskId of covered.kids) for (const job of await jobs(h.principal, taskId)) rows.set(job.id, { ...job, taskId });
      return { rows: [...rows.values()], incomplete };
    }
    const tasks = new Set<string>(covered.own);
    for (const child of covered.kids) tasks.add(child);
    for (const attemptId of attempts) { const taskId = (await h.dispatcher.get(h.principal, attemptId))?.taskId; if (taskId !== undefined) tasks.add(taskId); }
    for (const taskId of tasks) for (const job of await jobs(h.principal, taskId)) rows.set(job.id, { ...job, taskId });
    return { rows: [...rows.values()], incomplete };
  };
  const inFlight = async (attempts: readonly string[], scope: PauseScope, l: Look, lookOnly = false): Promise<InventoryItem[]> => {
    const localItems = await localOf(attempts, scope, lookOnly);
    const h = dispatch();
    const covered = await resolveScope(scope, l);
    const out: InventoryItem[] = [];
    // More descendants than the walk returns, or links it did not read: what is beyond is not known, and the stop says so.
    if (walks() && covered.truncated) out.push({ kind: "child", ref: "swarm:descendants-truncated", state: "unknown" });
    for (const attemptId of attempts) {
      // Work of a swarm child of the scope is delegated work (cards L02d, L02e): listed while its attempt has not ended.
      if (walks() && h !== undefined) { const a = await h.dispatcher.get(h.principal, attemptId); if (a !== undefined && covered.kids.has(a.taskId) && a.state !== "finished") out.push({ kind: "child", ref: attemptId.slice(0, 120), state: "running" }); }
      for (const op of (await h?.dispatcher.operations(h.principal, attemptId)) ?? []) if (!TERMINAL.has(op.state)) out.push({ kind: "foreground", ref: `${attemptId}/${op.callId}`.slice(0, 120), state: "running" });
    }
    // The task's background jobs (card L02c): a running one is counted, one asked to stop that has not is "uncooperative" (Force Stop is offered for it), and one whose outcome is not known is "unknown".
    if (jobs !== undefined && h !== undefined) {
      const found = await jobsFor(attempts, scope, l);
      if (found.incomplete) out.push({ kind: "job", ref: "jobs:truncated", state: "unknown" });
      for (const job of found.rows) {
        const state = job.state === "cancellation_requested" ? "uncooperative" : job.state === "outcome_unknown" ? "unknown" : ["admitted", "dispatched", "running"].includes(job.state) ? "running" : undefined;
        // A permitted remote background job that the controller tracks keeps running through a stop: it is named as an exception and not waited for (card L06).
        if (state === "running" && job.kind === "remote" && job.background === true && job.resumability === "remote_tracked") out.push({ kind: "job", ref: job.id.slice(0, 120), state: "tracked" });
        else if (state !== undefined) out.push({ kind: "job", ref: job.id.slice(0, 120), state });
      }
    }
    out.push(...localItems);
    return out;
  };
  /**
   * Stop ends the task's background jobs (Pause leaves them running, owner decision): each is asked to stop, a Force Stop escalates one already asked. A permitted remote job the controller tracks is the named exception.
   * The one who advances the stop is the one who asks (they were checked to control the scope); a job they may not control, or whose task they may not control, is returned as unresolved.
   */
  const askJobs = async (scope: PauseScope, attempts: readonly string[], l: Look, by: Principal, force: boolean): Promise<string[]> => {
    const h = dispatch();
    const unresolved: string[] = [];
    if (more?.cancelJob === undefined || jobs === undefined || h === undefined) return unresolved;
    const found = await jobsFor(attempts, scope, l);
    const verdict = new Map<string, boolean>();
    for (const job of found.rows) {
      if (job.kind === "remote" && job.background === true && job.resumability === "remote_tracked") continue;
      if (!["admitted", "dispatched", "running"].includes(job.state) && !(force && job.state === "cancellation_requested")) continue;
      // A job whose owner is not known (no attempt) is ended only at the owner's own stop.
      if (job.ownerUnknown === true && by.kind !== "owner") { unresolved.push(`job ${job.id}: not stopped, its owner is not known and ${by.id} is not the owner`.slice(0, 120)); continue; }
      // A job of a swarm child is a child's work, whoever the scope was stopped for: ended only by someone who may control the child (cards L02d, L02e).
      const childTasks = (await resolveScope(scope, l)).kids;
      if (childTasks.has(job.taskId) && more.mayControl !== undefined) {
        if (!verdict.has(job.taskId)) verdict.set(job.taskId, await more.mayControl(by, job.taskId).catch(() => false));
        if (verdict.get(job.taskId) !== true) { unresolved.push(`job ${job.id}: not stopped, ${by.id} may not control its task`.slice(0, 120)); continue; }
      }
      try { await more.cancelJob(by, job.id, { force, reason: force ? "force stop" : "stop after preparation" }); } catch (error) { if (!(error instanceof DomainError && (error.code === "invalid_command" || error.code === "not_found"))) unresolved.push(job.id.slice(0, 120)); }
    }
    return unresolved;
  };
  /** The attempts of the scope the asker may end the work of: all of the scope's own, and a swarm child's only for someone who may control the child (the others are returned as `denied`, with their task). */
  const controllable = async (by: Principal, attempts: readonly string[], scope: PauseScope, l: Look): Promise<{ allowed: string[]; deniedTasks: Set<string> }> => {
    const h = dispatch();
    const deniedTasks = new Set<string>();
    const childTasks = (await resolveScope(scope, l)).kids;
    if (childTasks.size === 0 || more?.mayControl === undefined || h === undefined) return { allowed: [...attempts], deniedTasks };
    const verdict = new Map<string, boolean>();
    const allowed: string[] = [];
    for (const id of attempts) {
      const taskId = (await h.dispatcher.get(h.principal, id))?.taskId;
      if (taskId === undefined || !childTasks.has(taskId)) { allowed.push(id); continue; }
      if (!verdict.has(taskId)) verdict.set(taskId, await more.mayControl(by, taskId).catch(() => false));
      if (verdict.get(taskId)) allowed.push(id); else deniedTasks.add(taskId);
    }
    return { allowed, deniedTasks };
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
    // The stop is recorded: the agent's ending is dropped now (the owner's stop wins), so nothing in preparation can complete it (card H12n). A swarm child the asker may not control keeps its ending.
    begin: async (scope, options) => { if (ending === undefined) return; const l = look(); const { allowed } = await controllable(options.by, await attemptsOf(scope, l), scope, l); for (const id of allowed) await ending.dropEnding(id, options.force ? "emergency_stop" : "owner_stop", options.force ? "force stop" : "stop requested"); },
    attempts: (scope) => [...(seen.get(`${scope.kind}:${scope.id}`) ?? [])],
    remember: (scope, attempts) => { if (attempts.length === 0) return; const key = `${scope.kind}:${scope.id}`; const all = seen.get(key) ?? new Set<string>(); for (const a of attempts) all.add(a); seen.set(key, all); },
    unsupported: (scope) => (scope.kind === "task" || scope.kind === "agent" || members !== undefined ? undefined : `stopping a whole ${scope.kind} is not supported yet; stop its tasks or agents one by one (Force Stop works on each)`),
    inventory: async (scope, options) => { const l = look(); return inFlight(await attemptsOf(scope, l), scope, l, options?.lookOnly === true); },
    release: async (scope) => { seen.delete(`${scope.kind}:${scope.id}`); const h = dispatch(); if (h === undefined) return; for (const id of await attemptsOf(scope)) await h.dispatcher.release(h.principal, id, { includeEnding: true }).catch(() => undefined); },
    cleanup: async (scope, options) => {
      const h = dispatch();
      const l = look();
      const attempts = await attemptsOf(scope, l);
      const { allowed } = await controllable(options.by, attempts, scope, l);
      // A worker still coming up when the wait ran out (card H12q) is not a failed cleanup: it is frozen, and it is listed as a process still running. A Suspend waits for it like any other running work (the next pass
      // looks again, and the deadline blocks it as usual); a Stop does not wait for processes in preparation, and its ending stops the worker that came up.
      const starting: InventoryItem[] = [];
      for (const id of allowed) {
        const strictMs = Math.max(1, Math.min(60_000, Date.parse(options.deadlineAt) - Date.now()));
        try { await h!.dispatcher.quiesce(h!.principal, id, "suspend or stop preparation", { strictMs }); } catch (error) {
          if (error instanceof DomainError && error.code === "unavailable" && error.field === "starting") { starting.push({ kind: "process", ref: `${id}/starting`.slice(0, 120), state: "running" }); continue; }
          throw error;
        }
      }
      // What the preparation cost, as the runtime counts it (a hook that is absent or fails says nothing, so nothing is charged on a guess).
      const figure = local?.spent === undefined ? undefined : await local.spent(attempts).catch(() => undefined);
      const spent = typeof figure === "number" && Number.isFinite(figure) && figure >= 0 ? figure : undefined;
      return { remaining: [...await inFlight(attempts, scope, l), ...starting], ...(spent === undefined ? {} : { spent }), ...(await costsOf(scope, attempts)) };
    },
    checkpoint: async (scope, options) => {
      const h = dispatch();
      const l = look();
      const all = await attemptsOf(scope, l);
      // Only the attempts the asker may control are quiesced and checkpointed (a swarm child they may not touch is left alone; terminate names it as unresolved).
      const attempts = options?.by === undefined ? all : (await controllable(options.by, all, scope, l)).allowed;
      // A Stop asks the task's background jobs to stop before the checkpoint is taken (preparation does not wait for them), so the checkpoint is of a state they are changing as little as they can. A Suspend leaves jobs running:
      // its checkpoint is taken while they run, and whatever they produce after it is not in it. The ending step asks again and escalates.
      if (options?.mode === "stop" && options.by !== undefined) await askJobs(scope, all, l, options.by, false).catch(() => undefined);
      if (h === undefined || attempts.length === 0) return { checkpointId: `${scope.kind}:${scope.id}`.slice(0, 120), durable: true, artifactsDurable: true }; // nothing runs here, so there is nothing to save
      let checkpointed = true;
      let artifacts = true;
      for (const id of attempts) {
        // An attempt that never started (it still waits for a place) has no worker and nothing of its own to save, so a Stop does not wait for a checkpoint of it; its ending withdraws it (card H10: a
        // swarm child waiting for capacity is cancelled without blocking). A Suspend is unchanged.
        if (options?.mode === "stop") { const d = await h!.dispatcher.get(h!.principal, id); if (d !== undefined && d.state === "waiting" && d.startedAt === undefined) continue; }
        // A worker still coming up is waited for no longer than the request's deadline allows (card H12q). A Stop's ending stops it and it has nothing of its own to save yet, so a Stop goes on without it;
        // a Suspend cannot checkpoint it, and the refusal blocks the Suspend as before.
        const startingMs = options?.deadlineAt === undefined ? undefined : Math.max(1, Math.min(60_000, Date.parse(options.deadlineAt) - Date.now()));
        let checkpoint: Readonly<Record<string, unknown>> | undefined;
        try { ({ checkpoint } = await h!.dispatcher.quiesce(h!.principal, id, "checkpoint before suspension", startingMs === undefined || !Number.isFinite(startingMs) ? {} : { startingMs })); } catch (error) {
          if (options?.mode === "stop" && error instanceof DomainError && error.code === "unavailable" && error.field === "starting") continue;
          throw error;
        }
        if (checkpoint === undefined) checkpointed = false;
        else if (checkpoint["artifactsDurable"] === false) artifacts = false;
      }
      return { checkpointId: `${scope.kind}:${scope.id}`.slice(0, 120), durable: checkpointed, artifactsDurable: artifacts };
    },
    terminate: async (scope, options) => {
      const h = dispatch();
      const l = look();
      const attempts = await attemptsOf(scope, l);
      const { allowed, deniedTasks } = await controllable(options.by, attempts, scope, l);
      const unresolved: string[] = [];
      // A swarm child the one who stops may not control is not stopped, and is named.
      for (const taskId of deniedTasks) unresolved.push(`child ${taskId}: not stopped, ${options.by.id} may not control it`.slice(0, 120));
      for (const id of allowed) {
        // The owner's stop wins over an agent's ending (card H12n): the intent is dropped before the attempt is stopped, so nothing is staged or submitted for it afterwards.
        await ending?.dropEnding(id, options.force ? "emergency_stop" : "owner_stop", options.force ? "force stop" : "stop after preparation");
        // The attempt may have ended by itself meanwhile (the agent's ending finished it): that one is over, and the others are still stopped.
        try { await h!.dispatcher.stop(h!.principal, id, { reason: options.force ? "force stop" : "stop after preparation", ...(options.force ? { emergency: true } : {}) }); } catch (error) { if (error instanceof DomainError && error.code === "not_found") continue; throw error; }
        for (const op of (await h!.dispatcher.operations(h!.principal, id)) ?? []) if (op.state === "uncertain") unresolved.push(`${id}/${op.callId}`.slice(0, 120));
      }
      unresolved.push(...await askJobs(scope, attempts, l, options.by, options.force));
      // A Force Stop kills what the hosts still hold for every attempt seen for the scope (also one that ended earlier and left a process behind), without asking first (card L02d). A swarm child's attempt only for someone
      // who may control the child. A failure is not reported as such: the look below names whatever is still there.
      if (options.force && local?.end !== undefined) {
        const every = [...new Set([...(seen.get(`${scope.kind}:${scope.id}`) ?? []), ...attempts])];
        const mine = every.length === 0 ? [] : (await controllable(options.by, every, scope, l)).allowed;
        if (mine.length > 0) await local.end(mine).catch(() => undefined);
      }
      // A job whose outcome is not known, or that was asked to stop and has not, is named as unresolved too.
      // Looking again can fail; that is not a clean stop. A process or child still running after the stop did not end either.
      const after = await inFlight(attempts, scope, look()).catch(() => [{ kind: "process", ref: "runtime:inventory", state: "unknown" } as InventoryItem]);
      for (const item of after) if (((item.kind === "process" || item.kind === "child") && item.state !== "settled") || (item.kind === "job" && (item.state === "unknown" || item.state === "uncooperative"))) { if (!unresolved.includes(item.ref)) unresolved.push(item.ref); }
      // The stop is over for this scope: what was remembered about its attempts is not carried into a later one.
      const costs = await costsOf(scope, attempts);
      seen.delete(`${scope.kind}:${scope.id}`);
      return { ended: true, unresolved, ...costs };
    },
  };
}

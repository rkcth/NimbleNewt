import { randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { HostFacts } from "../catalog/index.js";
import type { FirstCall } from "../context/dispatch.js";
import type { Capabilities, HostService } from "../hosts/index.js";
import type { Principal } from "../security/principals.js";
import type { JsonObject } from "../storage/types.js";
import type { WorkspacePort } from "../workspace-ops/workspace-ops.js";
import type { RecipeSummary, ToolCallRequest, ToolExecutor, ToolGateway, ToolResult, TurnUsage, WorkerHandle, WorkerHost, HostLocalWork, WorkOrder, WorkerTurnResult, WorkProgress, DoneCheckReport, DoneCheckRequest } from "./ports.js";

/** An isolation session for one attempt (card A03's launcher, behind a port): the host opens one with the recipe the dispatcher stated and closes it when the attempt ends or the recipe changes. */
export interface SandboxSession {
  readonly revision: string;
  close(): Promise<void>;
  /**
   * What is still alive in this confinement and what the cleanup after a stop has cost so far (card L02d), as the backend sees it; it is asked also after `close()` (a process that outlived its confinement is `uncooperative`).
   * Optional: a sandbox that cannot list its processes leaves it out and nothing is claimed about them. `costMicros` and `computeMs` are running totals for the session.
   */
  work?(): Promise<{ readonly processes: readonly { readonly ref: string; readonly kind: "process" | "child"; readonly state: "running" | "uncooperative" | "unknown" }[]; readonly costMicros?: number; readonly computeMs?: number }>;
  /** Force Stop (card L02d): kills everything this confinement still holds, without asking first, and waits a moment for it to go. Optional: a sandbox that cannot leaves it out (its `close` is all there is). */
  end?(): Promise<void>;
}
export interface SandboxPort {
  /** Opens the sandbox for a recipe. It refuses (throws) when this host has no confinement: nothing ever runs unconfined as a fallback. */
  open(recipe: RecipeSummary, order: WorkOrder): Promise<SandboxSession>;
}

/** What the attempt's conversation runtime (the harness: the Pi adapter) does for the worker. */
export interface AttemptRuntime {
  /** What the first call for `content` will carry, for the admission check (C07b). A runtime that cannot tell is not checked. */
  firstCall?(content: string): FirstCall | undefined;
  /** Makes the conversation smaller (a summary of its older part). Used once when the first call is refused for size. */
  compact?(): Promise<void>;
  /** Runs the turn. Every tool the model calls must be made through `call`. */
  run(content: string, requestId: string): Promise<WorkerTurnResult>;
  checkpoint(): Promise<JsonObject>;
  tell?(text: string): Promise<void>;
  /** Puts the owner's current decisions in front of the agent (after a call was refused because they changed). */
  refreshContext?(): Promise<void>;
  /** Model calls started and not yet finished (a streaming answer is one). A paused attempt is not claimed paused, and advice is not delivered, while one is open. Absent: none is known. */
  activeModelCalls?(): number;
  close(): Promise<void>;
}
/**
 * The size of the conversation a checkpoint of the worker package's host holds, in tokens, when it says. The mirror of `storedTokensOf` in `packages/worker/src/host/local.ts` (the controller cannot import the worker
 * package): that host writes the size it last knew into the checkpoint's `nn` part, so a stored conversation is judged against the route's resume share wherever the checkpoint came from. `undefined` when the checkpoint
 * says nothing at all, which card C07n refuses to resume unchecked.
 */
export function checkpointStoredTokens(from: JsonObject | undefined): number | undefined {
  const tokens = (from?.["nn"] as JsonObject | undefined)?.["contextTokens"];
  return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : undefined;
}

/**
 * The resume decision for an order's stored conversation (cards C07b, C07n), shared by the local worker and the controller's check before a remote host is offered the order (card C07o). `from` is the checkpoint to
 * continue from, `undefined` when there is none or it is not carried; `note` is the order's resume note with the reason appended when it is not carried; `storedTokens` is the size that was judged and fits.
 * A stored conversation is continued only when its size was judged and fits: a checkpoint whose size nobody says, or a check that fails, is left behind (a fresh start from the continuation record is the safe side).
 * No guards: the order is left as it is.
 */
export async function judgeResume(context: RuntimeGuards["context"], order: WorkOrder, report: (what: string, error: unknown) => void): Promise<{ readonly from: JsonObject | undefined; readonly note: string | undefined; readonly storedTokens?: number }> {
  let from = order.resumeFrom;
  let note = order.resumeNote;
  const startFresh = (why: string): { from: undefined; note: string } => { from = undefined; note = note === undefined ? why : `${note}\n${why}`; return { from, note }; };
  if (from === undefined || context === undefined) return { from, note };
  try {
    // The reader the host was given answers where it gives a figure; where it answers nothing, the worker package's own checkpoint shape is read (card C07n).
    const byReader = await context.storedTokens?.(from);
    const stored = byReader === undefined ? checkpointStoredTokens(from) : byReader;
    if (stored === undefined) {
      report("resume decision", new Error("the checkpoint does not say how large the stored conversation is"));
      return startFresh("the size of the stored conversation is not known (its checkpoint does not say), so it was not resumed; starting fresh from the continuation record");
    }
    const decision = await context.resume(order, stored);
    return decision.resume ? { from, note, storedTokens: stored } : startFresh(decision.reason);
  } catch (error) {
    // The size of the stored conversation could not be judged: it is not continued.
    report("resume decision", error);
    return startFresh("the stored conversation could not be checked against the context budget; starting fresh");
  }
}

/** Two reports of one turn (the part cut short by a restart and the rest) as one: the same turn number, the cache figures added when they are about the same route. */
function mergeUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): TurnUsage | undefined {
  if (a === undefined || b === undefined) return b ?? a;
  const sameRoute = a.cache !== undefined && b.cache !== undefined && a.cache.backend === b.cache.backend && a.cache.route === b.cache.route;
  const cache = sameRoute ? { ...b.cache!, cachedTokens: a.cache!.cachedTokens + b.cache!.cachedTokens, computedTokens: a.cache!.computedTokens + b.cache!.computedTokens, writtenTokens: a.cache!.writtenTokens + b.cache!.writtenTokens } : (b.cache ?? a.cache);
  const sum = (x: number | undefined, y: number | undefined): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const costMicros = sum(a.costMicros, b.costMicros), computeMs = sum(a.computeMs, b.computeMs);
  return { ...(b.turnSeq === undefined ? (a.turnSeq === undefined ? {} : { turnSeq: a.turnSeq }) : { turnSeq: b.turnSeq }), ...(costMicros === undefined ? {} : { costMicros }), ...(computeMs === undefined ? {} : { computeMs }), ...(cache === undefined ? {} : { cache }) };
}

type Mutable<T extends readonly unknown[]> = T[number][];
export type BoundCall = (request: ToolCallRequest, executor: ToolExecutor) => Promise<ToolResult>;
export interface RuntimeFactory {
  /** Opens the runtime for an attempt. `from` is a checkpoint to continue from (a restart, a resumed attempt); `call` is the one way a tool reaches the world. */
  open(order: WorkOrder, call: BoundCall, from: JsonObject | undefined, lease?: AttemptLease): Promise<AttemptRuntime>;
}

/**
 * The attempt's lease for the runtime (card H08b): the duration the dispatcher holds the attempt without a heartbeat, and the renewal, which is the attempt's own heartbeat through its gateway. A renewal throws a `fenced` DomainError when the
 * attempt is no longer the task's current one (the runtime stops it); any other error means the controller could not be asked (before the turn has its gateway, too), and the lease runs on.
 */
export interface AttemptLease { readonly leaseMs: number; renew(): Promise<{ readonly leaseMs: number }> }

export interface LocalWorkerOptions {
  readonly hostId: string;
  readonly resources: { readonly cpus: number; readonly memoryMb: number };
  readonly version: string;
  /** Whether the host's runtime applies the owner's limits, best-effort setting and launch record (the worker package's `localWorkerParts(...).ownerPolicy`). */
  readonly ownerPolicy?: boolean;
  readonly sandbox: SandboxPort;
  readonly runtimes: RuntimeFactory;
  /** What this host states about itself when it registers: its own facts, never a caller's. */
  readonly capabilities: () => Capabilities;
  /** Beats the attempt's lease while a turn runs, from a scheduler the composer injects (a timer in production, a test's own tick). Returns a function that stops it. Without it the runtime calls `gateway.heartbeat` itself. */
  readonly schedule?: (beat: () => Promise<void>) => () => void;
  /** What the runtime asks the controller's services while it runs (card H12f). Absent: none of it happens. */
  readonly guards?: RuntimeGuards;
  /** This host's side of integration, checkout refresh and quarantine for the checkouts it holds (card H12m): the worker package's `WorkspaceHost.run` fits it. Absent: those requests are refused for this host. */
  readonly workspace?: WorkspacePort;
  /** What a task's checkout on this host holds (card W03): the worker package's `LocalWorkspaces.progress` fits it. Absent: this host does not report it. */
  readonly progress?: (scope: { readonly taskId: string; readonly projectId: string; readonly planOnly?: boolean }) => Promise<WorkProgress | undefined>;
  /** Checks an attempt's work when its agent says it is done (card W05): the worker package's `doneVerifier` fits it. Absent: this host cannot check work, and a done of a task with a contract is not taken as verified. */
  readonly verify?: (attemptId: string, scope: { readonly taskId: string; readonly projectId: string }, request: DoneCheckRequest) => Promise<DoneCheckReport>;
  /** Told when a guard fails (the attempt goes on; a guard never silently stops working). */
  readonly onGuardError?: (attemptId: string, what: string, error: unknown) => void;
}

/** A message the controller has for the running agent, already judged eligible for the boundary by the message service (U12). */
export interface DeliverableMessage { readonly id: string; readonly text: string }
export type MessageBoundaryName = "interrupt" | "safe-boundary";

/**
 * The controller's services as the local worker sees them (card H12f), as plain functions the composer binds to the services under the right principal, so the worker holds none of them:
 * context enforcement (C07b: the first call is admitted or refused; a stored conversation over the resume share is not resumed), pause observation (L01: a paused attempt is reported
 * `pausing` while a call is in flight and `paused` only once its calls have settled) and the message boundaries (U12: an interrupt, and advice at a safe boundary).
 */
export interface RuntimeGuards {
  readonly context?: {
    /** `retry`: the runtime will make the call smaller and ask again as the next round, so a refusal now opens no blocker (the refusal of that round does). */
    admit(order: WorkOrder, call: FirstCall, round: number, retry?: boolean, launch?: string): Promise<{ readonly admit: boolean; readonly reasons: readonly string[]; /** `false`: making the call smaller cannot change this answer (card C07n: the route's window is not known), so the worker does not spend its one compaction on it. */ readonly retryable?: boolean }>;
    /** The first call went out and the provider reported its input size (card C07b): recorded against the admission, which calibrates the estimate for the route. */
    confirm?(order: WorkOrder, usage: { readonly reportedInputTokens: number; readonly promptChars: number }): Promise<void>;
    resume(order: WorkOrder, storedTokens: number): Promise<{ readonly resume: boolean; readonly reason: string }>;
    /** The size of the conversation a checkpoint holds, in tokens, when it says. Absent, a checkpoint of the worker package's shape is read by `checkpointStoredTokens` (card C07n); one that says nothing is not resumed. */
    storedTokens?(from: JsonObject): number | undefined;
    /**
     * The order's rebuilt view was made for a route whose fixed part nobody had measured (card C07g): `fixed` is what this worker's process will send besides the prompt (its system prompt and tool schemas). The controller keeps
     * it as the route's measurement and builds the view again with it. `text`: the view to put in the first prompt instead (empty: nothing to show); `refused`: the context does not fit the route with its real fixed part (a
     * blocker is open), so nothing is sent; `undefined`: keep the view the order carries.
     */
    rebuildView?(order: WorkOrder, fixed: { readonly systemPromptChars: number; readonly toolSchemaChars: number }, launch: string, /** The rest of the first prompt besides the view (the task's text and notes), in characters. */ promptChars: number): Promise<{ readonly text: string } | { readonly refused: string } | undefined>;
  };
  readonly pause?: {
    isPaused(order: WorkOrder): Promise<boolean>;
    observe(order: WorkOrder, state: "pausing" | "paused", boundary?: "finished"): Promise<void>;
  };
  readonly messages?: {
    readable(order: WorkOrder, boundary: MessageBoundaryName): Promise<readonly DeliverableMessage[]>;
    /** Confirms the messages were put before the agent. Returns the IDs the service did not mark delivered (it refused them; they stay queued). */
    acknowledge(order: WorkOrder, boundary: MessageBoundaryName, ids: readonly string[]): Promise<readonly string[]>;
  };
}

/**
 * The local worker runtime (card H12): this machine's worker host. It registers with the controller from its own facts and beats, opens one sandbox and one conversation runtime per attempt through the
 * ports, runs the turn with every tool call going through the gateway the dispatcher bound to the attempt, keeps the attempt's lease beating while the turn runs, and restarts the sandbox from a
 * checkpoint when the dispatcher changes the recipe. It implements the dispatch contract (`WorkerHost`) a remote worker (H02) implements too.
 */
export class LocalWorker implements WorkerHost {
  readonly hostId: string;
  readonly resources: { readonly cpus: number; readonly memoryMb: number };
  readonly ownerPolicy: boolean;
  readonly #options: LocalWorkerOptions;
  readonly workspace?: WorkspacePort;
  readonly progress?: (attemptId: string, scope: { readonly taskId: string; readonly projectId: string; readonly planOnly?: boolean }) => Promise<WorkProgress | undefined>;
  readonly verify?: (attemptId: string, scope: { readonly taskId: string; readonly projectId: string }, request: DoneCheckRequest) => Promise<DoneCheckReport>;
  #sequence = 0;
  #beat = 0;
  /** For each attempt whose turn is running here, how much work (tool calls, model calls) it has in flight (card H12q). */
  readonly #busy = new Map<string, () => number>();

  constructor(options: LocalWorkerOptions) {
    if (options.workspace !== undefined) this.workspace = options.workspace;
    const progress = options.progress;
    if (progress !== undefined) this.progress = async (_attemptId, scope) => progress({ taskId: scope.taskId, projectId: scope.projectId, ...(scope.planOnly === true ? { planOnly: true } : {}) });
    if (options.verify !== undefined) this.verify = options.verify;
    this.hostId = options.hostId;
    this.resources = options.resources;
    this.ownerPolicy = options.ownerPolicy === true;
    this.#options = options;
  }

  /**
   * Every sandbox session of each attempt this process started, kept after the attempt ends so that Stop can still ask what outlived it. A restart opens a new session and the old confinement may still hold
   * processes, so the old ones are kept until they report nothing left (then their last cost is folded into `base`, the attempt's cost so far). Bounded: the oldest attempts are forgotten first, and at most 8 sessions
   * of one attempt are kept (the oldest idle ones go first).
   */
  readonly #sessions = new Map<string, { sessions: SandboxSession[]; base: { costMicros: number; computeMs: number } }>();
  /** Sessions the last look found holding nothing: the only ones the cap on remembered sessions may drop. */
  readonly #emptied = new WeakSet<SandboxSession>();
  #remember(attemptId: string, session: SandboxSession): void {
    const had = this.#sessions.get(attemptId);
    this.#sessions.delete(attemptId);
    const entry = had ?? { sessions: [], base: { costMicros: 0, computeMs: 0 } };
    entry.sessions.push(session);
    // Past 8 sessions, the oldest one that is known to hold nothing (or cannot say) goes; one that still holds processes stays, so Stop still reports them. A hard bound of 64 keeps memory bounded whatever happens.
    while (entry.sessions.length > 8) {
      const at = entry.sessions.findIndex((x, i) => i < entry.sessions.length - 1 && (x.work === undefined || this.#emptied.has(x)));
      if (at >= 0) entry.sessions.splice(at, 1);
      else if (entry.sessions.length > 64) entry.sessions.shift();
      else break;
    }
    this.#sessions.set(attemptId, entry);
    while (this.#sessions.size > 500) this.#sessions.delete(this.#sessions.keys().next().value!);
  }

  /**
   * The attempts of this host that have a tool call or a model call in flight right now, or a process of theirs still running in a sandbox (L02d: `localWork`, which asks every sandbox session the attempt has had). A workspace
   * host (the worker's `WorkspaceHost.attemptsQuiet`) refuses to change a checkout under any of these: the controller's quiesce has settled the calls first, so this is the host's own check that it really is quiet (card H12q).
   * A sandbox that cannot answer makes this throw, and the host then treats the attempt as not quiet.
   */
  async busyAttempts(): Promise<string[]> {
    const busy = new Set([...this.#busy].filter(([, count]) => count() > 0).map(([id]) => id));
    const work = await this.localWork([...this.#sessions.keys()]);
    for (const p of work.processes) if (p.attemptId !== undefined) busy.add(p.attemptId);
    return [...busy];
  }

  /**
   * What Stop needs from this host (card L02d): asked for the attempts it knows, answered from all their sandbox sessions (a replaced sandbox's processes are still reported until it is empty; the cost is the sum over the
   * attempt's sessions). A session that cannot say is left out; one that fails to answer fails the whole look (the stop then names an unknown item). `known` lists the attempts this process has a record of, so a caller can tell
   * "nothing runs" from "this host has forgotten the attempt" (a restart of the controller).
   */
  async localWork(attemptIds: readonly string[]): Promise<HostLocalWork> {
    const processes: Mutable<HostLocalWork["processes"]> = [];
    const costs: Mutable<NonNullable<HostLocalWork["costs"]>> = [];
    const known: string[] = [];
    for (const attemptId of attemptIds.slice(0, 500)) {
      const entry = this.#sessions.get(attemptId);
      if (entry === undefined) continue;
      known.push(attemptId);
      let cost = entry.base.costMicros, compute = entry.base.computeMs, said = false;
      const keep: SandboxSession[] = [];
      for (const [i, session] of entry.sessions.entries()) {
        if (session.work === undefined) { keep.push(session); continue; }
        const w = await session.work();
        if (w.processes.length === 0) this.#emptied.add(session); else this.#emptied.delete(session);
        for (const p of w.processes.slice(0, 200)) processes.push({ attemptId, ref: p.ref, kind: p.kind, state: p.state });
        if (w.costMicros !== undefined) { cost += w.costMicros; said = true; }
        if (w.computeMs !== undefined) { compute += w.computeMs; said = true; }
        // An older confinement that holds nothing any more is folded into the base; the newest session is always kept.
        if (i < entry.sessions.length - 1 && w.processes.length === 0) { entry.base = { costMicros: entry.base.costMicros + (w.costMicros ?? 0), computeMs: entry.base.computeMs + (w.computeMs ?? 0) }; continue; }
        keep.push(session);
      }
      entry.sessions = keep;
      if (said || entry.base.costMicros > 0 || entry.base.computeMs > 0) costs.push({ attemptId, costMicros: cost, computeMs: compute });
    }
    return { processes, costs, known };
  }

  /**
   * Whether an attempt that has finished has anything left here (card L02e): the dispatcher asks again later for an attempt whose close could not end its worker, and a look that finds every sandbox of the attempt
   * empty is the confirmation (it answers; the attempt's scratch may then be removed). Nothing is killed here (that is Force Stop's `endLocalWork`). It refuses, and the attempt stays unconfirmed, when a process
   * is still listed, when a sandbox cannot say what it holds, or when this process has no record of the attempt (the controller restarted: nothing can be said about what it left).
   */
  async release(attemptId: string, _reason: string, _signal?: AbortSignal): Promise<void> {
    // A worker of the attempt that is still starting here, or whose handle has not been stopped, is not gone whatever its sandbox lists now (a running worker process is the attempt itself and is not listed, and a start
    // in progress has launched nothing yet): an end that runs while the start has not answered must not be confirmed (review of L02e).
    if ((this.#unstopped.get(attemptId) ?? 0) > 0) throw new Error("a worker of the attempt is starting or has not been stopped here");
    const entry = this.#sessions.get(attemptId);
    if (entry === undefined) throw new Error("this host has no record of the attempt's sandboxes, so it cannot confirm they are empty");
    if (entry.sessions.some((s) => s.work === undefined)) throw new Error("a sandbox of the attempt cannot say what it holds");
    const found = await this.localWork([attemptId]);
    const left = found.processes.filter((p) => p.attemptId === attemptId).length;
    if (left > 0) throw new Error(`${left} process${left === 1 ? "" : "es"} of the attempt still run${left === 1 ? "s" : ""} in its sandbox`);
  }

  /**
   * Force Stop's last step on this host (card L02d): every sandbox session these attempts have had is told to kill what it still holds (`SandboxSession.end`), whether or not its close went through. A session that fails is
   * reported after the others were told (the stop looks again afterwards and names what is left).
   */
  async endLocalWork(attemptIds: readonly string[]): Promise<void> {
    const failures: string[] = [];
    // All at once (review 3 of L02d): each session waits a moment for what it killed to go, so one after the other the Force Stop would wait that moment for every session of every attempt.
    const sessions = attemptIds.slice(0, 500).flatMap((attemptId) => this.#sessions.get(attemptId)?.sessions ?? []).filter((s) => s.end !== undefined);
    for (const r of await Promise.allSettled(sessions.map((s) => s.end!()))) if (r.status === "rejected") failures.push(String((r.reason as Error)?.message ?? r.reason).slice(0, 200));
    if (failures.length > 0) throw new Error(`the sandbox could not end everything: ${failures.join("; ").slice(0, 500)}`);
  }

  /** Announces this host's capabilities (from its own facts) under its own credential, and beats once. */
  async register(hosts: Pick<HostService, "announce" | "heartbeat">, self: Principal): Promise<void> {
    if (self.id !== this.hostId || self.kind !== "host") throw new DomainError("forbidden", `${self.id} is not ${this.hostId}; a worker registers as itself`);
    await hosts.announce(self, { commandId: `register:${this.hostId}:${++this.#sequence}`, capabilities: this.#options.capabilities() });
    await this.beat(hosts, self);
  }

  /** One heartbeat of the host (the controller stamps it with its own time). */
  async beat(hosts: Pick<HostService, "heartbeat">, self: Principal): Promise<void> {
    await hosts.heartbeat(self, { commandId: `beat:${this.hostId}:${this.#beat + 1}`, sequence: ++this.#beat });
  }

  /** For each attempt, how many of its workers this process has started (or is starting) whose handle has not been stopped yet: `release` never confirms such an attempt (review of L02e). */
  readonly #unstopped = new Map<string, number>();
  #count(attemptId: string, by: 1 | -1): void {
    const next = (this.#unstopped.get(attemptId) ?? 0) + by;
    if (next > 0) this.#unstopped.set(attemptId, next); else this.#unstopped.delete(attemptId);
  }

  async start(order: WorkOrder): Promise<WorkerHandle> {
    const attemptId = order.attemptId;
    this.#count(attemptId, 1);
    let handle: WorkerHandle;
    try { handle = await this.#start(order); } catch (error) { this.#count(attemptId, -1); throw error; }
    // The count is taken off once the handle's stop has run, whether or not it ended everything: what is left is then what the sandbox lists.
    let counted = true;
    const stop = handle.stop.bind(handle);
    return { ...handle, stop: async () => { try { await stop(); } finally { if (counted) { counted = false; this.#count(attemptId, -1); } } } };
  }

  async #start(order: WorkOrder): Promise<WorkerHandle> {
    const options = this.#options;
    const guards = options.guards;
    const report = (what: string, error: unknown): void => { try { options.onGuardError?.(order.attemptId, what, error); } catch { /* the report must not stop the attempt */ } };
    // A stored conversation over the resume share is not continued: the attempt starts fresh, and the agent is told why (C07b). Card C07n: it is continued only when its size was judged — a checkpoint
    // whose size nobody says (no reader, or one that answers nothing, and not one of the worker package's shape either) is left behind, not carried in unchecked.
    const { from, note } = await judgeResume(guards?.context, order, report);
    // Card C07i: the first call is judged (and its size watched) for the order as it is sent: without a stored conversation that is not carried, and with the note that says why.
    const { resumeFrom: _rf, resumeNote: _rn, ...plain } = order; void _rf; void _rn;
    const sent: WorkOrder = { ...plain, ...(from === undefined ? {} : { resumeFrom: from }), ...(note === undefined ? {} : { resumeNote: note }) };
    let sandbox = await options.sandbox.open(order.recipe, order);
    this.#remember(order.attemptId, sandbox);
    let gateway: ToolGateway | undefined;
    let runtime: AttemptRuntime | undefined;
    let inFlight = 0;
    let generation = 0;
    let restarting: Promise<void> | undefined;
    let restartFailed = false;
    let stopped = false;
    const call: BoundCall = async (request, executor) => {
      if (gateway === undefined) throw new DomainError("fenced", "the turn has not started; a tool call needs the attempt's gateway");
      inFlight++;
      let result: ToolResult;
      try { result = await gateway.call(request, executor); } finally { inFlight--; }
      // The owner's decisions changed: the new ones are put before the agent, then calls are allowed again (this call stays refused; the agent makes it again under a new call ID).
      if (result.state === "refused" && /decision revision changed/.test(result.reason)) {
        // Acknowledged only once the agent has been given the new context; a runtime that cannot do it leaves the calls refused.
        if (runtime?.refreshContext !== undefined) { try { await runtime.refreshContext(); await gateway.acknowledgeDecisions(); } catch { /* the calls stay refused */ } }
      }
      return result;
    };
    // The lease the dispatcher meant goes to the runtime as a duration (card H08b); its renewals are the attempt's heartbeats.
    const lease: AttemptLease | undefined = order.leaseMs === undefined ? undefined : {
      leaseMs: order.leaseMs,
      renew: async () => {
        if (gateway === undefined) throw new Error("the turn has not started; the lease cannot be renewed yet");
        const beat = await gateway.heartbeat();
        return { leaseMs: beat.leaseMs ?? Math.max(0, Date.parse(beat.until) - Date.now()) };
      },
    };
    try { runtime = await options.runtimes.open(order, call, from, lease); } catch (error) { await sandbox.close().catch(() => undefined); throw error; }

    // Each start of the worker is judged afresh: an attempt resumed after a restart, a host loss or a move has the same attempt ID but a conversation that has grown since, so an earlier round's answer is never replayed for it.
    const launch = randomBytes(6).toString("hex");
    // Card C07g: the order's view of the owner's context was built for a route nobody had measured. Now that the process is up its fixed part is known: it is measured, and the view is built again with it before
    // anything is sent, so the first prompt never rests on the assumed figure. A view that no longer fits refuses the first call; a rebuild that fails keeps the view (the first call is still checked with its real size).
    let body = order.content;
    let viewRefusal: string | undefined;
    const view = order.startupView;
    if (view !== undefined && !view.measured && guards?.context?.rebuildView !== undefined && runtime.firstCall !== undefined && Number.isSafeInteger(view.chars) && view.chars > 0 && view.chars <= order.content.length) {
      try {
        const fixed = runtime.firstCall("");
        if (fixed !== undefined) {
          const rest = order.content.length - view.chars + (note === undefined ? 0 : note.length + 4);
          const rebuilt = await guards.context.rebuildView(order, { systemPromptChars: fixed.systemPromptChars, toolSchemaChars: fixed.toolSchemaChars }, launch, rest);
          if (rebuilt !== undefined && "refused" in rebuilt) viewRefusal = rebuilt.refused;
          else if (rebuilt !== undefined) body = `${order.content.slice(0, order.content.length - view.chars)}${rebuilt.text === "" ? "" : `\n\n${rebuilt.text}`}`;
        }
      } catch (error) { report("context rebuild", error); }
    }
    const content = note === undefined ? body : `${body}\n\n[${note}]`;

    // The first call is admitted or refused before anything is sent (C07b). A refused one is made smaller once, if the runtime can, and asked again.
    let round = 0;
    const admitFirst = async (rt: AttemptRuntime, text: string): Promise<string | undefined> => {
      if (guards?.context === undefined || rt.firstCall === undefined) return undefined;
      let refusal: string | undefined;
      try {
        for (let pass = 1; pass <= 2; pass++) {
          const first = rt.firstCall(text);
          if (first === undefined) return undefined;
          const compactable = pass === 1 && rt.compact !== undefined;
          const decision = await guards.context.admit(sent, first, ++round, compactable, launch);
          if (decision.admit) return undefined;
          refusal = decision.reasons.join("; ") || "the first call is over the context budget";
          // A refusal a smaller call cannot change (card C07n: the route's window is not known) is final at once: nothing is compacted for it.
          if (!compactable || decision.retryable === false) break;
          // A compaction that fails is not the end of the road: the second round asks about the unchanged call, is refused, and opens the blocker.
          try { await rt.compact!(); } catch (error) { report("compaction", error); }
        }
      } catch (error) { refusal = `the context check failed: ${String((error as Error)?.message ?? error).slice(0, 300)}`; report("context admission", error); }
      return refusal;
    };
    const refusal = viewRefusal !== undefined ? `the owner's context does not fit route ${order.route} with its measured prompt and tools: ${viewRefusal}` : await admitFirst(runtime, content);
    if (refusal !== undefined) {
      await runtime.close().catch(() => undefined);
      await sandbox.close().catch(() => undefined);
      return {
        workerVersion: options.version,
        run: async () => ({ status: "failed", error: `the first call was not sent: ${refusal}` }),
        checkpoint: async () => from ?? {},
        restart: async () => { throw new DomainError("fenced", "the attempt was refused at start"); },
        stop: async () => undefined,
      };
    }

    // While the turn runs, on each beat: the pause gates are observed and messages for the agent are delivered (L01, U12). One pass at a time: a slow service must not make two passes read the same batch.
    let reported: "pausing" | "paused" | undefined;
    const told = new Set<string>();
    let pass: Promise<void> = Promise.resolve();
    const watch = (deliver: boolean): Promise<void> => {
      pass = pass.then(() => observeAndDeliver(deliver), () => observeAndDeliver(deliver));
      return pass;
    };
    // Tool calls through the gateway and model calls the runtime has open both count: either one is work still in flight.
    const busy = (): number => inFlight + (runtime?.activeModelCalls?.() ?? 0);
    const observeAndDeliver = async (deliver: boolean): Promise<void> => {
      if (guards === undefined || runtime === undefined) return;
      let paused = false;
      if (guards.pause !== undefined) {
        try {
          paused = await guards.pause.isPaused(order);
          if (paused) {
            // Paused is claimed only when no call is in flight; until then the honest state is pausing.
            const state = busy() === 0 ? "paused" : "pausing";
            if (state !== reported) { await guards.pause.observe(order, state, state === "paused" ? "finished" : undefined); reported = state; }
          } else reported = undefined;
        } catch (error) { report("pause observation", error); }
      }
      // Nothing is delivered to a paused attempt, or after the turn: a message told then would be marked delivered and never acted on. An interrupt reaches a running attempt at once, advice only when no call is in flight.
      if (!deliver || paused || guards.messages === undefined || runtime.tell === undefined) return;
      for (const boundary of (busy() === 0 ? ["interrupt", "safe-boundary"] : ["interrupt"]) as MessageBoundaryName[]) {
        try {
          const items = await guards.messages.readable(order, boundary);
          if (items.length === 0) continue;
          // What was already told (an acknowledgement that failed or was refused) is not told again; only the acknowledgement is tried again.
          const fresh = items.filter((m) => !told.has(m.id));
          if (fresh.length > 0) { await runtime.tell(fresh.map((m) => m.text).join("\n\n")); for (const m of fresh) told.add(m.id); }
          const refused = await guards.messages.acknowledge(order, boundary, items.map((m) => m.id));
          for (const m of items) if (!refused.includes(m.id)) told.delete(m.id);
          if (refused.length > 0) report(`message delivery (${boundary})`, new Error(`the message service did not mark ${refused.length} message(s) delivered`));
        } catch (error) { report(`message delivery (${boundary})`, error); }
      }
    };

    return {
      workerVersion: options.version,
      run: async (g) => {
        gateway = g;
        this.#busy.set(order.attemptId, busy);
        const stop = options.schedule?.(async () => { await g.heartbeat().then(() => undefined, () => undefined); await watch(true); });
        try {
          let carried: TurnUsage | undefined;
          for (;;) {
            const at = generation;
            const result = await runtime!.run(content, order.requestId);
            // A recipe change ends the process the turn was running in on purpose (card H12b): the restart is waited for, and a turn cut short by it goes on in the new process under the same request ID, from the conversation the checkpoint kept.
            if (restarting !== undefined) await restarting.catch(() => undefined);
            if (generation === at || restartFailed || result.status === "completed") { const usage = mergeUsage(carried, result.usage); return carried === undefined || usage === undefined ? result : { ...result, usage }; }
            carried = mergeUsage(carried, result.usage);
          }
        } finally {
          stop?.();
          if (this.#busy.get(order.attemptId) === busy) this.#busy.delete(order.attemptId);
          // A turn that ended while the attempt is paused is reported as paused (its calls have settled); nothing is delivered after the turn.
          await watch(false);
        }
      },
      checkpoint: () => runtime!.checkpoint(),
      restart: async (recipe, resumeFrom) => {
        generation++;
        // One restart at a time, and none after the attempt was stopped: a stop that comes while the sandbox is being started again ends what the restart opened.
        const before = restarting;
        const done = (async () => {
          await before?.catch(() => undefined);
          if (stopped) throw new DomainError("fenced", "the attempt was stopped");
          await runtime!.close();
          await sandbox.close();
          // Whatever the restart opened is closed again when it fails (a refused re-admission, a process that did not start): a frozen attempt does not keep a second sandbox running.
          try {
            sandbox = await options.sandbox.open(recipe, order);
            this.#remember(order.attemptId, sandbox);
            if (stopped) { await sandbox.close().catch(() => undefined); throw new DomainError("fenced", "the attempt was stopped"); }
            // The conversation continues from a checkpoint just taken from the same attempt; the new process has told nothing yet.
            reported = undefined;
            runtime = await options.runtimes.open({ ...order, recipe }, call, resumeFrom, lease);
            if (stopped) { await runtime.close().catch(() => undefined); await sandbox.close().catch(() => undefined); throw new DomainError("fenced", "the attempt was stopped"); }
            // The new process takes the whole stored conversation into its next call: it is admitted again (and compacted once if it must be), and a refusal leaves the attempt frozen (the dispatcher keeps it so).
            const again = await admitFirst(runtime, "");
            if (again !== undefined) throw new DomainError("unavailable", `the restarted sandbox's first call was not sent: ${again}`);
          } catch (error) {
            await runtime?.close().catch(() => undefined);
            await sandbox.close().catch(() => undefined);
            throw error;
          }
        })();
        restarting = done;
        try { await done; restartFailed = false; } catch (error) { restartFailed = true; throw error; } finally { if (restarting === done) restarting = undefined; }
      },
      tell: async (text) => { await runtime!.tell?.(text); },
      // A sandbox whose close fails (its process could not be ended, card L02d) makes the stop fail after everything was tried, so the dispatcher never takes the worker as confirmed gone; Stop lists what is left.
      stop: async () => { stopped = true; await restarting?.catch(() => undefined); await runtime!.close().catch(() => undefined); await sandbox.close(); },
    };
  }
}

/**
 * The facts the tool catalogue (T01) is given for this host, taken from what the host announced when it registered and from the capacity the owner declared for it: never from the caller that asks.
 * A tool entry written `name@version` counts as an interpreter or package the host has; others are ignored. A host that has not announced has no facts (`undefined`).
 */
export function catalogFacts(announced: Capabilities | undefined, capacity: { cpus: number; memoryMb: number } | undefined): HostFacts | undefined {
  if (announced === undefined || capacity === undefined) return undefined;
  if (!(announced.os === "linux" || announced.os === "darwin" || announced.os === "win32") || !(announced.arch === "x64" || announced.arch === "arm64")) return undefined;
  const interpreters: Record<string, string> = {};
  const packages: Record<string, string> = {};
  for (const tool of announced.tools) {
    const at = tool.indexOf("@");
    if (at <= 0) continue;
    (tool.startsWith("pkg:") ? packages : interpreters)[tool.startsWith("pkg:") ? tool.slice(4, at) : tool.slice(0, at)] = tool.slice(at + 1);
  }
  return { os: announced.os, arch: announced.arch, interpreters, packages, cpus: capacity.cpus, memoryMb: capacity.memoryMb };
}

import { randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { FirstCall } from "../context/dispatch.js";
import { judgeResume, type RuntimeGuards } from "../dispatch/local-worker.js";
import type { JsonObject } from "../storage/types.js";
import type { Principal } from "../security/index.js";
import { tightenLimits } from "../environments/launch-limits.js";
import { sealContract } from "./contract.js";
import type { ContractLimits, DoneCheckReport, DoneCheckRequest, DoneCheckRun, HostLocalWork, HostProbe, RecipeSummary, ToolGateway, WorkOrder, WorkerHandle, WorkerHost, WorkerTurnResult } from "../dispatch/ports.js";
import type { CarriedLanding, WorkspacePort } from "../workspace-ops/workspace-ops.js";
import type { RemoteWorkerService, Requirements } from "./service.js";

export interface RemoteWorkerHostOptions {
  /** What one attempt asks of the host, for admission. */
  readonly resources: { readonly cpus: number; readonly memoryMb: number };
  /** What the attempt needs of the host (platform, isolation, workspaces and where its data may go). The operator's policy, never a default: a host that cannot say refuses the placement. */
  readonly requirements: (order: WorkOrder) => Requirements;
  /** The artifacts the worker fetches before it starts. */
  readonly inputs?: (order: WorkOrder) => readonly string[];
  /** How long to wait for the worker to send the checkpoint it was asked for. Default 5 seconds (a shutdown waits this long for each remote attempt). */
  readonly checkpointWaitMs?: number;
  /** Wait between looks for the checkpoint, in milliseconds. Default 100. */
  readonly pollMs?: number;
  /** How long a workspace request (integration, landing, refresh, quarantine) waits for the host's answer, in ms. Default 300 000 (five minutes); a host that is slower leaves the request recorded as failed, with the operation possibly done there. */
  readonly workspaceWaitMs?: number;
  /**
   * The owner's limits and best-effort setting (card H12k), read at every start and carried to the worker in the dispatch contract (card H12a). A read that fails refuses the start: nothing is sent
   * unlimited. Absent: the order goes with the task contract only (the composed controller always gives it).
   */
  readonly ownerPolicy?: { readonly limits: () => Promise<ContractLimits | undefined>; readonly bestEffort: () => Promise<boolean> };
  /**
   * The model's context window for an order's route on this host, in tokens, when the operator states one (card C07o; the remote counterpart of `local.window`). `undefined`: the routing table's `contextTokens` for the
   * route is used; a route neither states is refused (card C07n).
   */
  readonly window?: (order: WorkOrder) => number | undefined;
  /**
   * The controller's check of the first call and the stored conversation before the order is offered (card C07o), bound by the composer to the same guards the local worker has (`controllerGuards`). `firstCall`
   * estimates the first call from what the controller knows (the order's text and the route's measured fixed part); the host's own process is not up yet. Absent: the order is offered as it is.
   */
  readonly context?: { readonly guards: NonNullable<RuntimeGuards["context"]>; readonly firstCall: (order: WorkOrder, text: string, storedTokens: number) => Promise<FirstCall> };
  /**
   * The owner's landing policy for a task, read fresh at each landing (the same reader a local host uses: the project's own landing branch, else `workspace.landing.branch`, with the permit and protected paths; card H12s) and carried in the
   * landing request to this host (card H12a). A read that fails, or nothing, refuses the landing here and nothing is sent. The composed controller always gives it.
   */
  readonly landingPolicy?: (call: { readonly taskId: string; readonly projectId: string }) => Promise<CarriedLanding>;
  /** Told when the check fails or a stored conversation's size is not known (the order still goes, or is refused, as the check decided). */
  readonly onGuardError?: (attemptId: string, what: string, error: unknown) => void;
}

/**
 * The dispatcher's view of a remote worker (card H02): `start` places the attempt on the host through `RemoteWorkerService` (the host fetches the order over its authenticated channel),
 * and the handle waits for the result the worker sends, asks it for checkpoints, tells it and stops it by control messages. It holds no worker connection of its own: everything the worker
 * does arrives through the transport, fenced by the placement number.
 */
export class RemoteWorkerHost implements WorkerHost {
  readonly resources: { readonly cpus: number; readonly memoryMb: number };
  readonly ownerPolicy: boolean;
  /** The same request the local host answers, carried over the authenticated transport to the host (card H12m): the answer has the same typed outcomes. */
  readonly workspace: WorkspacePort;
  constructor(readonly hostId: string, private readonly remote: RemoteWorkerService, private readonly by: Principal, private readonly options: RemoteWorkerHostOptions) {
    this.resources = options.resources;
    this.ownerPolicy = options.ownerPolicy !== undefined;
    // A host whose port threw (the work may be half done) says so with `failed`: that is thrown here, as a local host's throw is, so the workspace service records `failed`, not a clean refusal.
    this.workspace = { run: async (call) => {
      // A landing carries the owner's policy (card H12a): the host cannot read the controller's settings. Fail closed: nothing is sent when it cannot be read, and what a caller put in the request is never taken (only this reader's word).
      if (call.operation === "landing") {
        let policy: CarriedLanding | undefined;
        try { policy = await this.options.landingPolicy?.({ taskId: call.taskId, projectId: call.projectId }); } catch { policy = undefined; }
        if (policy === undefined || typeof policy.branch !== "string" || policy.branch.length === 0) return { ok: false, reason: `the owner's landing policy for this project could not be read here, or names no landing branch, so the landing was not sent to ${this.hostId} (nothing was changed)` };
        call = { ...call, landing: policy };
      } else if (call.landing !== undefined) call = { requestId: call.requestId, operation: call.operation, taskId: call.taskId, projectId: call.projectId, reason: call.reason, quietAttempts: call.quietAttempts, ...(call.assignee === undefined ? {} : { assignee: call.assignee }) };
      let answer;
      try { answer = await this.remote.askWorkspace(this.by, this.hostId, call, { waitMs: this.options.workspaceWaitMs ?? 300_000 }); } catch (error) {
        // A landing whose carried policy the request check refuses (malformed, or beyond what a request carries) was never sent (that check runs before anything is listed for the host): a clean refusal, not a failure that
        // may have changed the checkout.
        if (call.operation === "landing" && error instanceof DomainError && error.code === "invalid_command") return { ok: false, reason: `the owner's landing policy could not be carried to ${this.hostId} (${String(error.message).slice(0, 200)}), so the landing was not sent (nothing was changed)` };
        throw error;
      }
      if (answer.ok === false && answer.failed === true) throw new DomainError("unavailable", answer.reason);
      return answer.ok ? answer : { ok: false, reason: answer.reason };
    } };
  }

  /**
   * The check of an attempt's done on this host (card H12a, the remote form of card W05): the contract's checks run in the attempt's own sandbox there and the checkout's state is read there, over the same authenticated channel as a
   * workspace request. Without this the dispatcher could not look at work done on a remote machine and a done of a task with a contract would never count. The answer is reshaped here (only the known fields, bounded, one entry per
   * check asked); anything that does not fit, an unanswered or refused request, is thrown, so the dispatcher records "could not check" and the done does not count (fail closed, never a pass). The worker's report is the worker's word,
   * as its work is: the controller cannot run the checks itself on another machine.
   */
  async verify(attemptId: string, scope: { readonly taskId: string; readonly projectId: string }, request: DoneCheckRequest): Promise<DoneCheckReport> {
    const requestId = `wsr-${base32(randomBytes(20)).slice(0, 20)}`;
    const waitMs = Math.min(3_600_000, request.checks.reduce((n, c) => n + c.timeoutMs, 0) + 60_000);
    const answer = await this.remote.askVerify(this.by, this.hostId, requestId, attemptId, scope, request, { waitMs });
    if (!answer.ok) throw new DomainError("unavailable", answer.reason);
    return reportOf(answer.detail, request);
  }

  /**
   * What this host holds for Stop (card L02d, L02e). The controller cannot look into a remote machine, so it goes by the worker's own report of the processes it holds for the placement (`reportProcesses`, kept on the placement):
   * - a live placement with a report: the entries reported, as the worker gave them (running, asked to stop and not stopped, or unknown);
   * - a live placement with no report (a worker that does not report, or has not yet): one unknown item, as before;
   * - a placement that is over, whose worker said it stopped the sandbox and looked (a final report): what that report lists (normally nothing), so a Stop is clean on the worker's word;
   * - a placement that is over whose worker last listed something and never confirmed (no final report): those entries as unknown, since nobody has said they are gone;
   * - a placement that is over and never reported: nothing, as before. A report of another placement (an older holder) is never read.
   * Bounded to 500 attempts.
   */
  async localWork(attemptIds: readonly string[]): Promise<HostLocalWork> {
    const processes: { attemptId: string; ref: string; kind: "process" | "child"; state: "running" | "uncooperative" | "unknown" }[] = [];
    for (const attemptId of attemptIds.slice(0, 500)) {
      const placement = await this.remote.placement(this.by, attemptId);
      if (placement === undefined || placement.hostId !== this.hostId) continue;
      const live = ["offered", "accepted", "relocating"].includes(placement.state);
      const report = placement.processReport !== undefined && placement.processReport.placement === placement.placement ? placement.processReport : undefined;
      if (live && report === undefined) { processes.push({ attemptId, ref: `remote:${attemptId}`, kind: "process", state: "unknown" }); continue; }
      if (report === undefined) continue;
      if (!live && report.final) { for (const p of report.processes) processes.push({ attemptId, ref: p.ref, kind: p.kind, state: p.state }); continue; }
      for (const p of report.processes) processes.push({ attemptId, ref: p.ref, kind: p.kind, state: live ? p.state : "unknown" });
    }
    return { processes, costs: [], known: attemptIds.slice(0, 500) };
  }

  /** Why this host would refuse the attempt (card H07e), judged by the same rules as the placement. The order is not built yet, so the requirements are asked of a preview of it that carries no credential. */
  async refuses(probe: HostProbe): Promise<{ readonly reasons: readonly string[]; readonly lasting: boolean }> {
    const preview: WorkOrder = { attemptId: probe.attemptId, taskId: probe.taskId, projectId: probe.projectId, agentId: probe.agentId, generation: probe.generation, ...(probe.harness === undefined ? {} : { harness: probe.harness }), route: probe.route, credential: "", recipe: { revision: "preview", reach: [] }, content: "", requestId: "", ...(probe.expiresAt === undefined ? {} : { expiresAt: probe.expiresAt }) };
    return this.remote.refusals(this.by, { hostId: this.hostId, attemptId: probe.attemptId, taskId: probe.taskId, projectId: probe.projectId, agentId: probe.agentId, requirements: this.options.requirements(preview) });
  }

  /** The offers made to this host that it has not accepted yet (card H07b), the same figure `candidates` orders by. */
  async load(): Promise<number> { return this.remote.offerLoad(this.by, this.hostId); }

  async release(attemptId: string, reason: string): Promise<void> { await this.remote.end(this.by, attemptId, reason); }

  /** A new primary takes over the run of an attempt on this host (card H09b): a handle on the placement the worker accepted (or already completed), or nothing when no live run is there. */
  async adopt(attemptId: string): Promise<WorkerHandle | undefined> {
    const placement = await adoptable(this.remote, this.by, this.hostId, attemptId);
    return placement === undefined ? undefined : new RemoteWorkerHandle(this.remote, this.by, attemptId, placement, this.options);
  }

  /** The order with the owner's limits and best-effort setting in its contract, sealed again. */
  async #carry(order: WorkOrder): Promise<WorkOrder> {
    const policy = this.options.ownerPolicy;
    if (policy === undefined) return order;
    const c = order.contract;
    // The figures the dispatcher put in the contract (the agent's environment cut by the installation, card A08d) and the owner's now: the smaller of each, never the owner's alone (that would drop an environment's tighter figure).
    const limits = tightenLimits(await policy.limits(), c?.limits);
    const bestEffort = await policy.bestEffort();
    // The goal anchor the dispatcher named stays named (W12 follow-up: sealed again without it, a remote worker could never find the block to put back after a cut).
    return sealContract(order, { taskContractVersion: c?.taskContractVersion ?? 0, permissions: c?.permissions ?? [], ...(c?.budget === undefined ? {} : { budget: c.budget }), ...(limits === undefined ? {} : { limits }), bestEffort, ...(c?.anchorDigest === undefined ? {} : { anchorDigest: c.anchorDigest }) });
  }

  /**
   * Card C07o: the first call and the stored conversation of an attempt are judged by the controller before the host is offered the order, through the same guards and records as the local worker's (a remote host is
   * untrusted, and the remote API has no operation through which it could ask). A stored conversation that is not carried is taken out of the order and the reason added to its resume note; a refused first call
   * offers nothing (the context service has recorded the refusal and opened a `context_overflow` blocker) and the attempt fails with the reason.
   */
  async #judge(given: WorkOrder): Promise<{ readonly order: WorkOrder; readonly refused?: string }> {
    const context = this.options.context;
    if (context === undefined) return { order: given };
    const report = (what: string, error: unknown): void => { try { this.options.onGuardError?.(given.attemptId, what, error); } catch { /* the report must not stop the attempt */ } };
    const { from, note, storedTokens } = await judgeResume(context.guards, given, report);
    const { resumeFrom: _f, resumeNote: _n, ...rest } = given; void _f; void _n;
    const order: WorkOrder = { ...rest, ...(from === undefined ? {} : { resumeFrom: from }), ...(note === undefined ? {} : { resumeNote: note }) };
    // The text the host will be given: the order's own and the resume note beside it (the local worker's `[note]` form, so both measure the same thing).
    const text = note === undefined ? order.content : `${order.content}\n\n[${note}]`;
    try {
      const call = await context.firstCall(order, text, storedTokens ?? 0);
      // Each offer is judged afresh (a resumed or re-placed attempt has the same ID and a conversation that has grown), so the launch names this offer; nothing is compacted before it, so a refusal opens the blocker.
      const decision = await context.guards.admit(order, call, 1, false, randomBytes(6).toString("hex"));
      return decision.admit ? { order } : { order, refused: decision.reasons.join("; ") || "the first call is over the context budget" };
    } catch (error) {
      report("context admission", error);
      return { order, refused: `the context check failed: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
    }
  }

  async start(given: WorkOrder): Promise<WorkerHandle> {
    const judged = await this.#judge(given);
    if (judged.refused !== undefined) {
      const why = `the first call was not sent: ${judged.refused}`;
      // Nothing was offered: the host never sees the order (or the task credential in it), and the attempt fails with the reason.
      return { workerVersion: "remote", run: async () => ({ status: "failed", error: why }), checkpoint: async () => judged.order.resumeFrom ?? {}, restart: async () => { throw new DomainError("fenced", "the attempt was refused before it was offered"); }, stop: async () => undefined };
    }
    // What the order's text is made of is the controller's own measure (card C07i): the host is not given it.
    const { startParts: _sp, ...offered } = judged.order; void _sp;
    const order = await this.#carry(offered);
    const placed = await this.remote.place(this.by, { hostId: this.hostId, order, requirements: this.options.requirements(order), inputs: this.options.inputs?.(order) ?? [] });
    return new RemoteWorkerHandle(this.remote, this.by, order.attemptId, placed.placement, this.options);
  }
}

/**
 * The placement number a new primary can take over on this host (card H09b): the run the worker accepted, or one that already completed (its result is taken at once). An offer that was never accepted is not: its order,
 * and the credential in it, lived only in the memory of the controller that made it. Ended, moving or another host's: nothing.
 */
export async function adoptable(remote: Pick<RemoteWorkerService, "placement">, by: Principal, hostId: string, attemptId: string): Promise<number | undefined> {
  const p = await remote.placement(by, attemptId);
  return p !== undefined && p.hostId === hostId && (p.state === "accepted" || (p.state === "completed" && p.result !== undefined)) ? p.placement : undefined;
}

export class RemoteWorkerHandle implements WorkerHandle {
  readonly workerVersion = "remote";
  constructor(private readonly remote: RemoteWorkerService, private readonly by: Principal, readonly attemptId: string, readonly placement: number, private readonly options: RemoteWorkerHostOptions) {}
  /** The placement's one stored result: a new primary that takes it again charges its figures under the same key (card H09b). */
  get resultKey(): string { return `result:${this.attemptId}:${this.placement}`; }
  run(_gateway: ToolGateway): Promise<WorkerTurnResult> { void _gateway; return this.remote.waitForResult(this.by, this.attemptId, this.placement) as Promise<WorkerTurnResult>; }
  /** The handle acts only while its own placement holds the attempt: after a move, an old handle controls nothing. */
  async #current(): Promise<void> {
    const p = await this.remote.placement(this.by, this.attemptId);
    if (p === undefined || p.placement !== this.placement) throw new DomainError("fenced", `attempt ${this.attemptId} is no longer held under placement ${this.placement}`);
  }
  async checkpoint(): Promise<JsonObject> {
    await this.#current();
    const before = (await this.remote.placement(this.by, this.attemptId))?.checkpoint?.sequence ?? 0;
    await this.remote.control(this.by, this.attemptId, { kind: "checkpoint" }, this.placement);
    const until = Date.now() + (this.options.checkpointWaitMs ?? 5_000);
    for (;;) {
      const now = await this.remote.placement(this.by, this.attemptId);
      // The wait is for this placement's checkpoint: after a move the new host's checkpoint is not the answer to this handle's request.
      if (now === undefined || now.placement !== this.placement) throw new DomainError("fenced", `attempt ${this.attemptId} is no longer held under placement ${this.placement}`);
      const seen = now.checkpoint?.sequence ?? 0;
      if (seen > before) { const latest = await this.remote.latestCheckpoint(this.by, this.attemptId); if (latest !== undefined) return latest.checkpoint; }
      if (Date.now() >= until) throw new Error("the worker did not send a checkpoint in time");
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 100));
    }
  }
  async restart(recipe: RecipeSummary, from: JsonObject): Promise<void> { await this.#current(); await this.remote.control(this.by, this.attemptId, { kind: "restart", recipe, checkpoint: from }, this.placement); }
  async tell(text: string): Promise<void> { await this.#current(); await this.remote.control(this.by, this.attemptId, { kind: "tell", text }, this.placement); }
  async stop(): Promise<void> { await this.remote.end(this.by, this.attemptId, "the dispatcher stopped the worker", this.placement); }
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes: Buffer): string { let out = ""; for (const b of bytes) out += B32[b & 31]; return out; }

/** A worker's check report as the dispatcher may read it: known fields only, bounded, one entry for each check asked and none other. Throws when it does not fit. */
function reportOf(detail: unknown, request: DoneCheckRequest): DoneCheckReport {
  const bad = (what: string): never => { throw new DomainError("unavailable", `the host's report of the check was not usable (${what})`); };
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return bad("not an object");
  const d = detail as Record<string, unknown>;
  if (typeof d["checkout"] !== "boolean") return bad("it did not say whether the host holds a checkout");
  const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
  let tree: DoneCheckReport["tree"];
  if (d["tree"] !== undefined) {
    const t = d["tree"];
    if (t === null || typeof t !== "object" || Array.isArray(t)) return bad("the tree");
    const o = t as Record<string, unknown>;
    const uncommittedCount = int(o["uncommittedCount"]), ahead = int(o["ahead"]), changed = int(o["changed"]);
    if (uncommittedCount === undefined || ahead === undefined || !Array.isArray(o["uncommitted"]) || o["uncommitted"].length > 20 || o["uncommitted"].some((f) => typeof f !== "string" || f.length > 300)) return bad("the tree figures");
    tree = { uncommitted: [...(o["uncommitted"] as string[])], uncommittedCount, ahead, ...(changed === undefined ? {} : { changed }), ...(typeof o["agentCommits"] === "boolean" ? { agentCommits: o["agentCommits"] } : {}) };
  }
  let evidence: NonNullable<DoneCheckReport["evidence"]> | undefined;
  if (d["evidence"] !== undefined) {
    if (!Array.isArray(d["evidence"]) || d["evidence"].length > request.evidence.length) return bad("the evidence");
    evidence = d["evidence"].map((e: unknown) => {
      const o = e as Record<string, unknown> | null;
      if (o === null || typeof o !== "object" || typeof o["path"] !== "string" || !request.evidence.includes(o["path"]) || typeof o["present"] !== "boolean") return bad("an evidence entry");
      return { path: o["path"], present: o["present"], ...(typeof o["why"] === "string" ? { why: o["why"].slice(0, 200) } : {}) };
    });
  }
  if (!Array.isArray(d["checks"]) || d["checks"].length > request.checks.length) return bad("the checks");
  const seen = new Set<string>();
  const checks = d["checks"].map((c: unknown): DoneCheckRun => {
    const o = c as Record<string, unknown> | null;
    if (o === null || typeof o !== "object" || typeof o["name"] !== "string" || !request.checks.some((r) => r.name === o["name"]) || seen.has(o["name"]) || (o["state"] !== "passed" && o["state"] !== "failed" && o["state"] !== "not-run")) return bad("a check entry");
    seen.add(o["name"]);
    return {
      name: o["name"], state: o["state"],
      ...(o["exitCode"] === null || typeof o["exitCode"] === "number" ? { exitCode: o["exitCode"] as number | null } : {}), ...(typeof o["signal"] === "string" || o["signal"] === null ? { signal: o["signal"] as string | null } : {}),
      ...(o["timedOut"] === true ? { timedOut: true } : {}), ...(typeof o["output"] === "string" ? { output: o["output"].slice(-2000) } : {}), ...(typeof o["reason"] === "string" ? { reason: o["reason"].slice(0, 300) } : {}),
      ...(typeof o["ms"] === "number" && Number.isFinite(o["ms"]) ? { ms: o["ms"] } : {}),
    };
  });
  return { checkout: d["checkout"], ...(tree === undefined ? {} : { tree }), ...(evidence === undefined ? {} : { evidence }), checks };
}

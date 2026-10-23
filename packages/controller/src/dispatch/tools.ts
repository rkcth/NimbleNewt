import type { EffectBridge, EffectService } from "../domain/effects.js";
import { mergeChanges } from "../domain/changes.js";
import { DomainError, isDomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, type View } from "../domain/model.js";
import { CommandRunner, view } from "../domain/runner.js";
import { ActionCatalog } from "../policy/catalog.js";
import { selectRoute } from "../routing/index.js";
import { allows, toolAction } from "../security/access.js";
import { redactText } from "../security/redact.js";
import type { Principal } from "../security/principals.js";
import { canonicalJson, sha256 } from "../storage/json.js";
import type { AggregateRef, Change, JsonObject } from "../storage/types.js";
import type { DispatcherDeps } from "./dispatcher.js";
import { DISPATCHER_ACTOR, DISPATCH_LIMITS, TERMINAL, checkCallId, checkToolName, operationKind, type DispatchBody, type OperationState, type ToolIdentity, type ToolOperationBody } from "./model.js";
import type { ToolCallRequest, ToolExecutor, ToolResult, WorkerHandle } from "./ports.js";

const FIELDS = ["callId", "tool", "args", "restricted", "script", "target", "estimatedSpend", "irreversible", "branchProtected", "audience", "environment"] as const;
const ENVIRONMENTS = ["development", "testing", "staging", "customer-live"];
const MAX_ARGS = 64 * 1024;
const SETTLE_TURNS = 5;
const TOLD_MAX = 1000;
/** Classes whose calls run inside the worker's sandbox or look at things; every other class acts on the outside and goes through the ledger and a bridge. */
const LOCAL_CLASSES = new Set(["inspect", "workspace-edit", "unknown"]);
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
/** Guards built by independent services may each create the same absent record (a pause gate); the first create stands, then checks are merged. */
export const merged = (...lists: readonly (readonly Change[])[]): Change[] => {
  const seen = new Map<string, string>();
  const kept = lists.flat().filter((c) => {
    if (c.type !== "create") return true;
    const k = `${c.ref.kind}\0${c.ref.id}`;
    const body = canonicalJson(c.body);
    const before = seen.get(k);
    // The same record created twice must be the same record: two different bodies are two guards that disagree.
    if (before !== undefined && before !== body) throw new DomainError("integrity", `two guards create ${c.ref.kind} ${c.ref.id} with different contents`);
    if (before !== undefined) return false;
    seen.set(k, body);
    return true;
  });
  return mergeChanges(kept);
};
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

export interface Loaded { readonly aggregate: { readonly id: string; readonly revision: number; readonly body: unknown }; readonly body: DispatchBody; readonly revision: number }

export interface PathHooks {
  readonly catalog: ActionCatalog;
  readonly bridges?: Readonly<Record<string, EffectBridge>>;
  update(attemptId: string, mutate: (body: DispatchBody) => DispatchBody, extra?: (body: DispatchBody) => Promise<readonly Change[]>): Promise<DispatchBody>;
  load(attemptId: string): Promise<Loaded | undefined>;
  handleOf(attemptId: string): WorkerHandle | undefined;
}

interface Normalized {
  readonly callId: string; readonly tool: ToolIdentity; readonly args: JsonObject; readonly restricted: boolean; readonly script?: string; readonly target?: { kind: string; id: string };
  readonly estimatedSpend?: number; readonly irreversible?: boolean; readonly branchProtected?: boolean; readonly audience?: string; readonly environment?: "development" | "testing" | "staging" | "customer-live";
  readonly digest: string; readonly bytes: number; readonly summary: string;
}

interface Ready { readonly d: DispatchBody; readonly agent: Principal; readonly opId: string; readonly ref: AggregateRef; readonly c: Normalized; readonly cls: string; readonly readOnly: boolean; readonly effectId: string; readonly kind: ToolExecutor["kind"] }
type Prepared = { readonly done: true; readonly result: ToolResult } | { readonly done: false; readonly ready: Ready };

/**
 * The tool path of the dispatcher (card H12): where every tool call of a worker is decided, recorded and, for an effect, run through the ledger. The gateway the worker holds is this class bound to its
 * attempt. A call is judged in a fixed order (the generation is current, the attempt is not frozen, the pause gates, the owner's decisions and gates, the decision revision the attempt was started under,
 * the route is still eligible, the budget, the agent's grants as they are now, the task contract's permission list, then the approval policy) and every outcome, a refusal included, is a durable
 * operation: its ID derives from the attempt and the worker's call ID, so asking again is the same call, never a second one.
 *
 * A call alone is not progress: nothing here writes the task's observed activity or its state; the attempt's outcome and the task are recorded by other means.
 */
export class ToolPath {
  readonly #runner: CommandRunner;
  readonly #deps: DispatcherDeps;
  readonly #hooks: PathHooks;
  /** Calls this process is running right now: local ones can be told to stop, all can be waited for. */
  readonly #active = new Map<string, { readonly attemptId: string; readonly abort: AbortController; readonly done: Promise<unknown> }>();
  /** Parked calls whose decision has been told to the worker already (by this process). */
  readonly #told = new Set<string>();
  /** Calls being made by this process right now, by attempt and call ID. */
  readonly #calls = new Map<string, { readonly digest: string; readonly promise: Promise<ToolResult> }>();

  constructor(runner: CommandRunner, deps: DispatcherDeps, hooks: PathHooks) {
    this.#runner = runner;
    this.#deps = deps;
    this.#hooks = hooks;
  }

  // ---- the calls --------------------------------------------------------------------------------------------------------------

  async call(attemptId: string, request: ToolCallRequest, executor: ToolExecutor): Promise<ToolResult> {
    // Two asks for one call ID at once are one call: the second joins the first (the claim is made before anything is awaited), so the call is run once.
    const c0 = this.#normalize(request);
    const key = `${attemptId}\0${c0.callId}`;
    const joined = this.#calls.get(key);
    if (joined !== undefined) {
      const c = c0;
      if (c.digest !== joined.digest) throw new DomainError("command_conflict", `call ${c.callId} of attempt ${attemptId} is being made with different arguments`);
      return joined.promise;
    }
    const mine = (async (): Promise<ToolResult> => {
      const prepared = await this.#prepare(attemptId, request, executor.kind);
      if (prepared.done) return prepared.result;
      return this.#execute(prepared.ready, executor);
    })();
    this.#calls.set(key, { digest: c0.digest, promise: mine });
    try { return await mine; } finally { this.#calls.delete(key); }
  }

  async begin(attemptId: string, request: ToolCallRequest): Promise<{ readonly operationId: string; readonly run: true } | { readonly operationId: string; readonly run: false; readonly result: ToolResult }> {
    const prepared = await this.#prepare(attemptId, request, "local");
    if (prepared.done) return { operationId: (prepared.result as { operationId: string }).operationId, run: false, result: prepared.result };
    return { operationId: prepared.ready.opId, run: true };
  }

  async report(attemptId: string, operationId: string, outcome: { readonly state: "confirmed" | "failed" | "cancelled" | "uncertain"; readonly text?: string; readonly error?: string; readonly cpuMs?: number; readonly memoryMb?: number }): Promise<ToolResult> {
    if (outcome === null || typeof outcome !== "object") invalid("outcome", "must be an object");
    onlyKnown(outcome, ["state", "text", "error", "cpuMs", "memoryMb"]);
    if (!["confirmed", "failed", "cancelled", "uncertain"].includes(outcome.state)) invalid("outcome.state", "must be confirmed, failed, cancelled or uncertain");
    const op = await this.#stored(attemptId, operationId);
    if (op === undefined) throw new DomainError("not_found", `operation ${String(operationId)} is not an operation of attempt ${attemptId}`);
    if (op.body.state !== "in-progress") return this.#resultOf(op.aggregate.id, op.body);
    const d = (await this.#hooks.load(attemptId))!.body;
    const ended = await this.#finalize(d, op.aggregate.id, outcome.state, { ...(outcome.text === undefined ? {} : { text: outcome.text }), ...(outcome.error === undefined ? {} : { error: outcome.error }), ...(outcome.cpuMs === undefined ? {} : { cpuMs: outcome.cpuMs }), ...(outcome.memoryMb === undefined ? {} : { memoryMb: outcome.memoryMb }) });
    return ended;
  }

  // ---- preparing: validating, judging and recording the start ---------------------------------------------------------------------

  async #prepare(attemptId: string, request: ToolCallRequest, kind: ToolExecutor["kind"]): Promise<Prepared> {
    const c = this.#normalize(request);
    const loaded = await this.#hooks.load(attemptId);
    if (loaded === undefined || loaded.body.state !== "running") throw new DomainError("fenced", `attempt ${attemptId} is not running; its calls are refused`, { field: "attemptId" });
    const d = loaded.body;
    const opId = derivedId("top", `${attemptId}\0${c.callId}`);
    const ref: AggregateRef = { kind: operationKind(attemptId), id: opId };
    const agent = await this.#deps.credentials.principalOf(this.#deps.principal, attemptId, { limit: false });
    const cls = this.#hooks.catalog.classify(c.tool.name, c.target?.kind);
    const readOnly = cls === "inspect";
    const effectId = derivedId("eff", `tool:${opId}`);
    const ready: Ready = { d, agent, opId, ref, c, cls, readOnly, effectId, kind };
    const existing = await this.#runner.get(ref.kind, ref.id);
    if (existing !== undefined) return this.#again(ready, existing.body as unknown as ToolOperationBody, kind);
    for (let attempt = 1; ; attempt++) {
      try { return await this.#fresh(ready, kind); } catch (error) {
        // A pause, a decision or a grant moved between the checks and the commit: the call is judged again on what is there now.
        if (isDomainError(error, "stale_revision") && attempt < 8) continue;
        throw error;
      }
    }
  }

  async #fresh(ready: Ready, kind: ToolExecutor["kind"]): Promise<Prepared> {
    const { d, c, cls } = ready;
    // The generation: a stale one never dispatches. This throws; nothing is recorded for a worker that has lost its task.
    const fence = await this.#deps.assignments.guardFor({ generation: d.generation, attemptId: d.attemptId }).check(d.taskId);
    const verdict = await this.#judge(ready, { policy: true });
    if (verdict.kind === "refused") return this.#refuse(ready, verdict.reason, fence.changes, verdict.diagnostics);
    if (!LOCAL_CLASSES.has(cls) && kind !== "effect") return this.#refuse(ready, `${c.tool.name} acts on the outside (${cls}); it must go through the effect ledger with a bridge, and the call named none`, fence.changes);
    if (verdict.kind === "park") return this.#park(ready, verdict, fence.changes);
    return this.#begin(ready, verdict.decision, fence.changes, verdict.guards);
  }

  /** The judgement of one call: refused (with why), parked for an approval, or allowed. The policy is asked last, and only when `policy` is set (an approved call has had its approval instead). */
  async #judge(ready: Ready, options: { policy: boolean }): Promise<
    | { kind: "refused"; reason: string; diagnostics?: readonly string[] }
    | { kind: "park"; decision: { mode: string; via: string; reasons: readonly string[] }; ownerOnly: boolean }
    | { kind: "allow"; decision: { mode: string; via: string; reasons: readonly string[] }; guards: readonly Change[] }
  > {
    const { d, c, agent, cls } = ready;
    const refused = (reason: string): { kind: "refused"; reason: string } => ({ kind: "refused", reason });
    if (d.frozen !== undefined) return refused(`frozen: ${d.frozen.reason}`);
    // Pause gates, owner decisions and gates, and the generation hold: each guard's revision checks commit with the call, so a pause or a correction racing it lands before or after, never inside.
    const guards: Change[] = [];
    const paused = await this.#deps.pauses.guard(d.taskId);
    if (paused.blockedBy.length > 0) return refused(`paused by ${paused.blockedBy.map((s) => `${s.kind} ${s.id}`).join(", ")}`);
    guards.push(...paused.changes);
    if (this.#deps.decisions !== undefined) {
      const g = await this.#deps.decisions.guard(d.taskId, "effect");
      if (g.blockedBy.length > 0) return refused(`the owner's decisions stand in the way: ${g.blockedBy.join("; ")}`);
      guards.push(...g.changes);
    }
    if (this.#deps.generation !== undefined) {
      try { guards.push(...await this.#deps.generation.guardFor(d.taskId)()); } catch (error) {
        if (isDomainError(error, "invalid_command")) return refused(error.message);
        throw error;
      }
    }
    // The decision revision the attempt was started under.
    const version = await this.#decisionVersion(d.projectId);
    if (version !== d.revisions.decisions) return refused(`decision revision changed (${d.revisions.decisions} to ${version}); the worker must put the new decisions before the agent and acknowledge them, and the agent makes the call again under a new call ID`);
    // The route is still eligible (a provider or route excluded, disabled or no longer allowed for the task's data).
    const route = await this.#routeProblem(d);
    if (route !== undefined) return refused(route);
    // The budget, from accounting.
    let spent: number | undefined;
    if (this.#deps.budgets !== undefined) {
      const report = await this.#deps.budgets.accounting(this.#deps.principal, d.taskId);
      if (report !== undefined) {
        spent = report.spent.costMicros;
        if ((report.limit.costMicros > 0 && report.spent.costMicros + report.uncertain.costMicros >= report.limit.costMicros) || (report.limit.computeMs > 0 && report.spent.computeMs + report.uncertain.computeMs >= report.limit.computeMs)) return refused("the task's budget is used up");
      }
    }
    // The agent's grants as they are now (the credential's snapshot is taken again for each call), and the contract's permission list.
    const fresh = await this.#deps.credentials.principalOf(this.#deps.principal, d.attemptId, { limit: false });
    if (!allows(fresh, toolAction(c.tool.name), d.projectId, { resource: { kind: "task", id: d.taskId }, now: this.#runner.now() })) return refused(`${d.agentId} holds no grant for ${toolAction(c.tool.name)} on this task now`);
    const permissions = await this.#permissions(d.taskId);
    // Inside the contract's ceiling the approved contract covers the call; beyond it the policy still decides, and what it would have allowed or sent to a reviewer goes to the owner instead (asked again).
    const beyond = permissions.length > 0 && !permissions.some((p) => p === "*" || p === "tool.*" || p === toolAction(c.tool.name) || p === `class.${cls}`);
    void agent;
    if (!options.policy) return { kind: "allow", decision: { mode: "approved", via: "review", reasons: ["an exact-operation approval covers it"] }, guards };
    // The approval policy, only through `PolicyService.evaluate`, with the spend so far from accounting.
    const decision = await this.#deps.policy.evaluate({
      principalId: d.agentId, projectId: d.projectId, tool: c.tool.name, taskId: d.taskId,
      ...(c.target === undefined ? {} : { targetKind: c.target.kind }), ...(c.environment === undefined ? {} : { environment: c.environment }), ...(c.estimatedSpend === undefined ? {} : { estimatedSpend: c.estimatedSpend }),
      ...(c.branchProtected === undefined ? {} : { branchProtected: c.branchProtected }), ...(c.audience === undefined ? {} : { audience: c.audience }), ...(c.irreversible === undefined ? {} : { irreversible: c.irreversible }),
      ...(spent === undefined ? {} : { spentSoFar: spent }),
    });
    const info = { mode: decision.mode, via: decision.via, reasons: decision.reasons.slice(0, 5).map((r) => clip(redactText(r), DISPATCH_LIMITS.diagnostic)) };
    if (decision.mode === "deny") return { kind: "refused", reason: `denied by policy: ${info.reasons.join("; ")}` };
    // An exact-operation review (A05: a call that runs a script, or installs something that runs) inside an approved ceiling still goes to the owner; a policy-level agent review stays with any reviewer.
    const exact = (c.script !== undefined || cls === "install-executable") && decision.via === "scope";
    if (exact) return { kind: "park", decision: { mode: "owner", via: "exact-operation", reasons: [`${c.tool.name} needs an exact-operation review, which goes to the owner even inside an approved ceiling`, ...info.reasons].slice(0, 5) }, ownerOnly: true };
    if (beyond) return { kind: "park", decision: { mode: "owner", via: "beyond-ceiling", reasons: [`${c.tool.name} is beyond the task contract's permission ceiling, so the owner is asked again`, ...info.reasons].slice(0, 5) }, ownerOnly: true };
    if (decision.mode === "allow") return { kind: "allow", decision: info, guards };
    return { kind: "park", decision: info, ownerOnly: decision.mode === "owner" };
  }

  async #routeProblem(d: DispatchBody): Promise<string | undefined> {
    if (this.#deps.routing === undefined) return undefined;
    const table = await this.#deps.routing.get();
    if (table === undefined) return "no routing table is configured";
    try {
      const picked = selectRoute({ ...table, profiles: { ...table.profiles, "dispatch-attempt": [d.route] } }, { role: d.role, profile: "dispatch-attempt", contextTokens: d.request.contextTokens, needs: d.request.needs, data: d.request.data, paidAuthorized: d.request.paidAuthorized });
      if (picked.chosen === d.route) return undefined;
      return `route ${d.route} is no longer eligible: ${picked.candidates[0]?.reasons.join("; ") ?? "not a configured route"}`;
    } catch (error) {
      if (error instanceof DomainError) return `route ${d.route} cannot be judged: ${error.message}`;
      throw error;
    }
  }

  async #decisionVersion(projectId: string): Promise<number> {
    return ((await this.#runner.get("decision-context", projectId))?.body as unknown as { version?: number } | undefined)?.version ?? 0;
  }

  async #permissions(taskId: string): Promise<readonly string[]> {
    return ((await this.#runner.get("task-contract", taskId))?.body as unknown as { permissions?: readonly string[] } | undefined)?.permissions ?? [];
  }

  // ---- recording ---------------------------------------------------------------------------------------------------------------

  #body(ready: Ready, state: OperationState, extra: Partial<ToolOperationBody>): ToolOperationBody {
    const { d, c, agent, readOnly, effectId } = ready;
    void agent;
    const now = this.#runner.now();
    return {
      attemptId: d.attemptId, callId: c.callId, taskId: d.taskId, projectId: d.projectId, agentId: d.agentId, generation: d.generation, tool: c.tool,
      invocation: { argsDigest: c.digest, bytes: c.bytes, summary: c.summary, restricted: c.restricted }, readOnly, state, startedAt: now, diagnostics: [],
      judgedAt: { policy: d.revisions.policy, decisions: d.revisions.decisions }, ...(this.#effectful(ready) ? { effectId } : {}), ...extra,
    };
  }

  #effectful(ready: Ready): boolean { return !LOCAL_CLASSES.has(ready.cls); }

  /** The operation record and the attempt's counters in one commit, with the fence and the guards. */
  async #write(ready: Ready, body: ToolOperationBody, mutate: (d: DispatchBody) => DispatchBody, guards: readonly Change[]): Promise<boolean> {
    const { d, ref } = ready;
    const fence = await this.#deps.assignments.guardFor({ generation: d.generation, attemptId: d.attemptId }).check(d.taskId);
    let created = true;
    await this.#hooks.update(d.attemptId, (b) => (created ? mutate(b) : b), async () => {
      // The create is the claim of the call: if the operation is already there, someone else made it first and this caller does not go on to run it.
      if ((await this.#runner.get(ref.kind, ref.id)) !== undefined) { created = false; return []; }
      created = true;
      return merged(fence.changes, guards, [{ type: "create", ref, body: body as unknown as JsonObject }]);
    });
    return created;
  }

  async #refuse(ready: Ready, reason: string, fence: readonly Change[], diagnostics: readonly string[] = []): Promise<Prepared> {
    const body = this.#body(ready, "refused", { endedAt: this.#runner.now(), diagnostics: [clip(redactText(reason), DISPATCH_LIMITS.diagnostic), ...diagnostics].slice(0, DISPATCH_LIMITS.diagnostics), usage: { durationMs: 0, outputBytes: 0 } });
    void fence;
    if (!await this.#write(ready, body, (b) => ({ ...b, calls: b.calls + 1 }), [])) return this.#existing(ready);
    return { done: true, result: { state: "refused", operationId: ready.opId, reason: clip(redactText(reason), DISPATCH_LIMITS.diagnostic) } };
  }

  async #begin(ready: Ready, decision: { mode: string; via: string; reasons: readonly string[] }, fence: readonly Change[], guards: readonly Change[]): Promise<Prepared> {
    void fence;
    const { d } = ready;
    // An MCP tool is authorized against its approved server first; the server's protocol and catalogue revision are written on the operation.
    let tool = ready.c.tool;
    if (tool.kind === "mcp") {
      if (this.#deps.mcp === undefined || tool.server === undefined) return this.#refuse(ready, "an MCP call needs the MCP service and a server", []);
      try {
        const authorized = await this.#deps.mcp.authorizeCall(ready.agent, { commandId: `mcp:${ready.opId}`, serverId: tool.server.id, kind: "tool", name: tool.name, taskId: d.taskId });
        tool = { ...tool, server: { id: tool.server.id, protocolRevision: authorized.protocolRevision, catalogRevision: authorized.catalogRevision, callId: authorized.callId } };
      } catch (error) {
        if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found" || error.code === "invalid_command")) return this.#refuse(ready, `the MCP server did not authorize the call: ${error.message}`, []);
        throw error;
      }
    }
    const body = this.#body({ ...ready, c: { ...ready.c, tool } }, "in-progress", { decision });
    const created = await this.#write(ready, body, (b) => {
      if (b.inFlight.includes(ready.opId)) return b;
      if (b.inFlight.length >= DISPATCH_LIMITS.inFlight) throw new DomainError("unavailable", `${DISPATCH_LIMITS.inFlight} calls are already in flight for this attempt`);
      return { ...b, calls: b.calls + 1, inFlight: [...b.inFlight, ready.opId] };
    }, guards);
    if (!created) return this.#existing(ready);
    return { done: false, ready: { ...ready, c: { ...ready.c, tool } } };
  }

  async #park(ready: Ready, verdict: { decision: { mode: string; via: string; reasons: readonly string[] }; ownerOnly: boolean }, fence: readonly Change[]): Promise<Prepared> {
    void fence;
    const { d, c, agent } = ready;
    if (this.#deps.reviews === undefined) return this.#refuse(ready, `the policy asks for ${verdict.decision.mode === "owner" ? "the owner's" : "a reviewer's"} approval and no review service is configured`, []);
    if (d.parked.length >= DISPATCH_LIMITS.parked) return this.#refuse(ready, `${DISPATCH_LIMITS.parked} calls of this attempt already wait for an approval`, []);
    let review: { id: string; cleared: boolean };
    try {
      review = await this.#deps.reviews.request(agent, {
        commandId: `rev:${ready.opId}`, taskId: d.taskId, operation: this.#operation(ready),
        note: `${c.tool.name} ${c.tool.version}: ${verdict.decision.reasons[0] ?? verdict.decision.via}`.slice(0, 900),
        ...(verdict.ownerOnly ? { ownerOnly: true } : {}),
        context: { toolVersion: `${c.tool.name}@${c.tool.version}`.slice(0, 100), authoritySource: `the task assignment (attempt ${d.attemptId})`, expectedEffects: [clip(c.summary, 200)] },
      });
    } catch (error) {
      if (error instanceof DomainError && (error.code === "invalid_command" || error.code === "forbidden")) return this.#refuse(ready, `the approval could not be asked for: ${error.message}`, []);
      throw error;
    }
    // A review waiting for the owner goes to the owner's attention queue (best effort: the review is the record, a failed notice is not an error).
    if (verdict.ownerOnly && !review.cleared) await this.#deps.notifications?.emitFromController({ commandId: `dpa-rvn:${review.id}`, kind: "review-request", ref: { kind: "review", id: review.id } }).catch(() => undefined);
    const body = this.#body(ready, "awaiting-approval", { decision: verdict.decision, reviewId: review.id, ...(verdict.ownerOnly ? { ownerOnly: true } : {}) });
    if (!await this.#write(ready, body, (b) => (b.parked.includes(ready.opId) ? b : { ...b, calls: b.calls + 1, parked: [...b.parked, ready.opId] }), [])) return this.#existing(ready);
    // An approval that already covers this exact operation (A05 clears a repeat against it) is used at once.
    if (review.cleared) return this.#approved(ready, body);
    return { done: true, result: { state: "awaiting-approval", operationId: ready.opId, reviewId: review.id, reason: `waiting for ${verdict.ownerOnly ? "the owner's" : "a reviewer's"} approval: ${verdict.decision.reasons[0] ?? verdict.decision.via}` } };
  }

  #operation(ready: Ready): { name: string; args: JsonObject; script?: string; target: { kind: string; id: string } } {
    const { c, d } = ready;
    return { name: c.tool.name, args: c.args, ...(c.script === undefined ? {} : { script: c.script }), target: c.target ?? { kind: "task", id: d.taskId } };
  }

  // ---- a call that already has an operation ---------------------------------------------------------------------------------

  /** Another caller made the operation first: this one is treated as asking again. */
  async #existing(ready: Ready): Promise<Prepared> {
    const op = (await this.#runner.get(ready.ref.kind, ready.ref.id))!.body as unknown as ToolOperationBody;
    return this.#again(ready, op, ready.kind);
  }

  async #again(ready: Ready, op: ToolOperationBody, kind: ToolExecutor["kind"]): Promise<Prepared> {
    if (op.invocation.argsDigest !== ready.c.digest || op.tool.name !== ready.c.tool.name) throw new DomainError("command_conflict", `call ${ready.c.callId} of attempt ${ready.d.attemptId} was already made with a different tool or arguments`);
    if (TERMINAL.has(op.state)) return { done: true, result: this.#resultOf(ready.opId, op) };
    if (op.state === "awaiting-approval") return this.#approval(ready, op);
    // In progress. If this process is running it, the second asker joins it; otherwise the worker died with the call open.
    const running = this.#active.get(ready.opId);
    if (running !== undefined) { await running.done.catch(() => undefined); return { done: true, result: await this.#settled(ready) }; }
    if (ready.d.state !== "running") return { done: true, result: this.#resultOf(ready.opId, op) };
    // A call recorded on the ledger is only ever continued through the ledger; asked again any other way it is settled from the ledger and never run (that would be the effect twice).
    if (op.effectId !== undefined) return kind === "effect" ? { done: false, ready } : { done: true, result: await this.#recoverOne(ready.d, ready.opId) };
    if (kind === "effect") return { done: true, result: await this.#recoverOne(ready.d, ready.opId) };
    // A local call that was open when the worker died: a read-only one is safe to run again; any other is not (it may have done its work), so it is settled as uncertain.
    if (ready.readOnly) return { done: false, ready };
    return { done: true, result: await this.#recoverOne(ready.d, ready.opId) };
  }

  async #settled(ready: Ready): Promise<ToolResult> {
    const op = (await this.#runner.get(ready.ref.kind, ready.ref.id))!.body as unknown as ToolOperationBody;
    return this.#resultOf(ready.opId, op);
  }

  /** A parked call that is asked again: still waiting, refused, or approved (then it is admitted and run). */
  async #approval(ready: Ready, op: ToolOperationBody): Promise<Prepared> {
    const reviews = this.#deps.reviews;
    if (reviews === undefined || op.reviewId === undefined) return this.#closeParked(ready, "the approval service is not available");
    const review = await reviews.get(ready.agent, op.reviewId);
    if (review === undefined) return this.#closeParked(ready, "the approval request is gone");
    if (review.state === "approved") return this.#approved(ready, op, review.decidedBy);
    if (review.state === "denied" || review.state === "withdrawn" || review.state === "used") return this.#closeParked(ready, `the approval was ${review.state}${review.reason === undefined ? "" : `: ${review.reason}`}`);
    return { done: true, result: { state: "awaiting-approval", operationId: ready.opId, reviewId: op.reviewId, reason: "still waiting for the approval" } };
  }

  /** The approval is in: the checks run again on what is there now (an approval waives asking, nothing else), the review is used, and the call runs. */
  async #approved(ready: Ready, op: ToolOperationBody, decidedBy?: string): Promise<Prepared> {
    const reviews = this.#deps.reviews!;
    if (op.ownerOnly === true) {
      const by = decidedBy ?? (await reviews.get(ready.agent, op.reviewId!))?.decidedBy;
      if (by === undefined || !by.startsWith("owner:")) return this.#closeParked(ready, `the policy sent this to the owner and ${by ?? "an agent"} decided; only the owner's approval counts`);
    }
    const verdict = await this.#judge(ready, { policy: false });
    if (verdict.kind === "refused") return this.#closeParked(ready, verdict.reason);
    if (verdict.kind !== "allow") return this.#closeParked(ready, "the call could not be judged");
    try {
      await reviews.admit(ready.agent, { commandId: `adm:${ready.opId}`, requestId: op.reviewId!, operation: this.#operation(ready) });
    } catch (error) {
      if (error instanceof DomainError && (error.code === "review_invalid" || error.code === "forbidden")) return this.#closeParked(ready, `the approval no longer admits the call: ${error.message}`);
      throw error;
    }
    const next: ToolOperationBody = { ...op, state: "in-progress", diagnostics: [...op.diagnostics, "approved"].slice(-DISPATCH_LIMITS.diagnostics) };
    await this.#rewrite(ready, next, (b) => ({ ...b, parked: b.parked.filter((p) => p !== ready.opId), inFlight: b.inFlight.includes(ready.opId) ? b.inFlight : [...b.inFlight, ready.opId] }), verdict.guards);
    return { done: false, ready };
  }

  async #closeParked(ready: { readonly d: DispatchBody; readonly ref: AggregateRef; readonly opId: string }, reason: string): Promise<Prepared> {
    const op = (await this.#runner.get(ready.ref.kind, ready.ref.id))!.body as unknown as ToolOperationBody;
    const next: ToolOperationBody = { ...op, state: "refused", endedAt: this.#runner.now(), diagnostics: [...op.diagnostics, clip(redactText(reason), DISPATCH_LIMITS.diagnostic)].slice(-DISPATCH_LIMITS.diagnostics), usage: { durationMs: 0, outputBytes: 0 } };
    await this.#rewrite(ready, next, (b) => ({ ...b, parked: b.parked.filter((p) => p !== ready.opId), inFlight: b.inFlight.filter((p) => p !== ready.opId) }), []);
    return { done: true, result: this.#resultOf(ready.opId, next) };
  }

  /** Rewrites an operation record (at its current revision) with the attempt's counters. */
  async #rewrite(ready: { d: DispatchBody; ref: AggregateRef }, body: ToolOperationBody, mutate: (d: DispatchBody) => DispatchBody, guards: readonly Change[]): Promise<void> {
    await this.#hooks.update(ready.d.attemptId, mutate, async () => {
      const current = await this.#runner.get(ready.ref.kind, ready.ref.id);
      if (current === undefined) throw new DomainError("integrity", `operation ${ready.ref.id} is missing`);
      return merged(guards, [{ type: "update", ref: ready.ref, expectedRevision: current.revision, body: body as unknown as JsonObject }]);
    });
  }

  // ---- running ----------------------------------------------------------------------------------------------------------------

  async #execute(ready: Ready, executor: ToolExecutor): Promise<ToolResult> {
    const abort = new AbortController();
    const done = executor.kind === "local" ? this.#runLocal(ready, executor, abort.signal) : this.#runEffect(ready, executor);
    this.#active.set(ready.opId, { attemptId: ready.d.attemptId, abort, done });
    try { return await done; } finally { this.#active.delete(ready.opId); }
  }

  async #runLocal(ready: Ready, executor: Extract<ToolExecutor, { kind: "local" }>, signal: AbortSignal): Promise<ToolResult> {
    try {
      const out = await executor.run(signal);
      return await this.#finalize(ready.d, ready.opId, "confirmed", { text: out.text, ...(out.cpuMs === undefined ? {} : { cpuMs: out.cpuMs }), ...(out.memoryMb === undefined ? {} : { memoryMb: out.memoryMb }) });
    } catch (error) {
      if (isDomainError(error, "stale_epoch")) throw error;
      const message = error instanceof Error ? error.message : "the call failed";
      return this.#finalize(ready.d, ready.opId, signal.aborted ? "cancelled" : "failed", { error: message });
    }
  }

  async #runEffect(ready: Ready, executor: Extract<ToolExecutor, { kind: "effect" }>): Promise<ToolResult> {
    const { d, c, effectId } = ready;
    if (!this.#effectful(ready)) return this.#finalize(d, ready.opId, "failed", { error: `${c.tool.name} is not an effect tool (class ${ready.cls}); it has no ledger entry` });
    try {
      await this.#deps.effects.intend({ commandId: `tool:${ready.opId}`, actor: d.agentId, kind: executor.effectKind, target: executor.target, input: executor.input, taskId: d.taskId, fence: { generation: d.generation, attemptId: d.attemptId } });
      const outcome = await this.#deps.effects.run(effectId, executor.bridge, { beforeStart: () => this.#beforeStart(d.taskId) });
      if (outcome.status === "confirmed") return await this.#finalize(d, ready.opId, "confirmed", { text: `the effect was applied${outcome.note === undefined ? "" : ` (${outcome.note})`}` });
      if (outcome.status === "failed") return await this.#finalize(d, ready.opId, "failed", { error: outcome.note ?? "the target refused the effect" });
      if (outcome.status === "uncertain") return await this.#finalize(d, ready.opId, "uncertain", { error: outcome.note ?? "the effect may or may not have been applied" });
      return { state: "in-progress", operationId: ready.opId, reason: "the target could not be reached; asking again with the same call ID tries it again safely" };
    } catch (error) {
      if (error instanceof DomainError && error.code === "effect_uncertain") return this.#finalize(d, ready.opId, "uncertain", { error: error.message });
      if (error instanceof DomainError && error.code === "effect_busy") return { state: "in-progress", operationId: ready.opId, reason: error.message };
      if (error instanceof DomainError && (error.code === "invalid_command" || error.code === "fenced")) return this.#finalize(d, ready.opId, "failed", { error: error.message });
      throw error;
    }
  }

  /** The guard of an effect that has not started: the pause gates, the owner's decisions and the generation hold, as one list of revision checks that commit with the claim. */
  async #beforeStart(taskId: string): Promise<readonly Change[]> {
    const lists: (readonly Change[])[] = [];
    const paused = await this.#deps.pauses.guard(taskId);
    if (paused.blockedBy.length > 0) throw new DomainError("invalid_command", `task ${taskId} is paused (${paused.blockedBy.map((s) => `${s.kind} ${s.id}`).join(", ")}); no new effect starts until it is resumed`);
    lists.push(paused.changes);
    if (this.#deps.decisions !== undefined) {
      const g = await this.#deps.decisions.guard(taskId, "effect");
      if (g.blockedBy.length > 0) throw new DomainError("invalid_command", `task ${taskId} may not continue: ${g.blockedBy.join("; ")}`);
      lists.push(g.changes);
    }
    if (this.#deps.generation !== undefined) lists.push(await this.#deps.generation.guardFor(taskId)());
    return merged(...lists);
  }

  /** Writes how a call ended and takes it out of the attempt's list of calls in flight. */
  async #finalize(d: DispatchBody, opId: string, state: "confirmed" | "failed" | "cancelled" | "uncertain", info: { text?: string; error?: string; cpuMs?: number; memoryMb?: number }): Promise<ToolResult> {
    const ref: AggregateRef = { kind: operationKind(d.attemptId), id: opId };
    const current = await this.#runner.get(ref.kind, ref.id);
    const op = current?.body as unknown as ToolOperationBody | undefined;
    if (op === undefined) throw new DomainError("integrity", `operation ${opId} is missing`);
    if (TERMINAL.has(op.state)) return this.#resultOf(opId, op);
    const now = this.#runner.now();
    const text = info.text ?? "";
    const next: ToolOperationBody = {
      ...op, state, endedAt: now,
      diagnostics: info.error === undefined ? op.diagnostics : [...op.diagnostics, clip(redactText(info.error), DISPATCH_LIMITS.diagnostic)].slice(-DISPATCH_LIMITS.diagnostics),
      usage: { durationMs: Math.max(0, Date.parse(now) - Date.parse(op.startedAt)), outputBytes: Buffer.byteLength(text), ...(info.cpuMs === undefined ? {} : { cpuMs: info.cpuMs }), ...(info.memoryMb === undefined ? {} : { memoryMb: info.memoryMb }) },
      ...(state === "confirmed" ? { resultSummary: op.invocation.restricted ? `[restricted result, ${Buffer.byteLength(text)} bytes]` : clip(redactText(text), DISPATCH_LIMITS.resultSummary) } : {}),
    };
    await this.#rewrite({ d, ref }, next, (b) => ({ ...b, inFlight: b.inFlight.filter((p) => p !== opId), parked: b.parked.filter((p) => p !== opId) }), []);
    if (op.tool.kind === "mcp" && this.#deps.mcp !== undefined && op.tool.server?.callId !== undefined) {
      const agent = await this.#deps.credentials.principalOf(this.#deps.principal, d.attemptId, { limit: false }).catch(() => undefined);
      if (agent !== undefined) await this.#deps.mcp.recordOutcome(agent, { commandId: `mcpo:${opId}`, taskId: d.taskId, callId: op.tool.server.callId ?? "", outcome: state === "confirmed" ? "ok" : state === "uncertain" ? "uncertain" : "error" }).catch(() => undefined);
    }
    return state === "confirmed" ? { state: "confirmed", operationId: opId, text } : { state, operationId: opId, reason: info.error === undefined ? state : clip(redactText(info.error), DISPATCH_LIMITS.diagnostic) };
  }

  #resultOf(opId: string, op: ToolOperationBody): ToolResult {
    if (op.state === "confirmed") return { state: "confirmed", operationId: opId, text: op.resultSummary ?? "" };
    if (op.state === "awaiting-approval") return { state: "awaiting-approval", operationId: opId, reviewId: op.reviewId ?? "", reason: "waiting for an approval" };
    if (op.state === "in-progress") return { state: "in-progress", operationId: opId, reason: "the call is in progress" };
    return { state: op.state as "failed" | "cancelled" | "uncertain" | "refused", operationId: opId, reason: op.diagnostics.at(-1) ?? op.state };
  }

  // ---- settling and recovery -----------------------------------------------------------------------------------------------------

  /**
   * Settles every call of the attempt: waits for the ones this process runs (a local call is told to stop first when `cancel` is set), then settles any left in flight from the ledger. Returns how many
   * calls it found in flight.
   */
  async settle(attemptId: string, cancel: boolean): Promise<number> {
    const mine = [...this.#active.entries()].filter(([, run]) => run.attemptId === attemptId);
    if (cancel) {
      for (const [, run] of mine) run.abort.abort();
      // A cooperative executor ends within a few turns of the event loop. One that ignores the signal is not waited for: its call is settled from what is known below (it cannot be allowed to hold up the end of an attempt), and whatever it returns later changes nothing.
      const all = Promise.allSettled(mine.map(([, run]) => run.done));
      for (let turn = 0; turn < SETTLE_TURNS; turn++) { if (await Promise.race([all.then(() => true), new Promise<boolean>((r) => setImmediate(() => r(false)))])) break; }
    } else await Promise.allSettled(mine.map(([, run]) => run.done));
    const loaded = await this.#hooks.load(attemptId);
    if (loaded === undefined) return mine.length;
    let n = mine.length;
    for (const opId of loaded.body.inFlight) {
      if (this.#active.has(opId) && !cancel) continue;
      await this.#recoverOne(loaded.body, opId);
      n++;
    }
    return n;
  }

  /**
   * One call that no running executor owns: an effect is settled from the ledger (the target is asked through its bridge when the effect had started, so it is never applied twice); a read-only call
   * is cancelled (it can simply be made again); any other local call may have done its work and is `uncertain`.
   */
  async #recoverOne(d: DispatchBody, opId: string): Promise<ToolResult> {
    const ref: AggregateRef = { kind: operationKind(d.attemptId), id: opId };
    const op = (await this.#runner.get(ref.kind, ref.id))?.body as unknown as ToolOperationBody | undefined;
    if (op === undefined) return { state: "refused", operationId: opId, reason: "no such operation" };
    if (op.state !== "in-progress") {
      if (d.inFlight.includes(opId) || d.parked.includes(opId)) await this.#rewrite({ d, ref }, op, (b) => ({ ...b, inFlight: b.inFlight.filter((p) => p !== opId), parked: b.parked.filter((p) => p !== opId) }), []);
      return this.#resultOf(opId, op);
    }
    if (op.effectId !== undefined) {
      const ledger = await this.#deps.effects.get(op.effectId);
      if (ledger === undefined) return this.#finalize(d, opId, "cancelled", { error: "the worker ended before the effect was recorded; nothing was done" });
      if (ledger.status === "confirmed") return this.#finalize(d, opId, "confirmed", { text: "the effect was applied (settled from the ledger)" });
      if (ledger.status === "failed") return this.#finalize(d, opId, "failed", { error: "the effect did not happen (settled from the ledger)" });
      if (ledger.status === "uncertain") return this.#finalize(d, opId, "uncertain", { error: "the effect may or may not have happened; it is not retried blindly" });
      // Intended. If it never started nothing happened; if it started, only the target can say, so the bridge is asked (never executed blindly).
      if (!ledger.started) return this.#finalize(d, opId, "cancelled", { error: "the worker ended before the effect started; nothing was done" });
      const bridge = this.#hooks.bridges?.[ledger.kind];
      if (bridge !== undefined) {
        try {
          const outcome = await this.#deps.effects.run(op.effectId, bridge);
          if (outcome.status === "confirmed") return this.#finalize(d, opId, "confirmed", { text: "the effect was applied (settled from the ledger)" });
          if (outcome.status === "failed") return this.#finalize(d, opId, "failed", { error: outcome.note ?? "the effect did not happen" });
          if (outcome.status === "uncertain") return this.#finalize(d, opId, "uncertain", { error: outcome.note ?? "the effect may or may not have happened" });
        } catch (error) {
          if (error instanceof DomainError && error.code === "effect_uncertain") return this.#finalize(d, opId, "uncertain", { error: error.message });
          if (!(error instanceof DomainError)) throw error;
        }
      }
      return this.#finalize(d, opId, "uncertain", { error: "the effect had started and the worker ended; no bridge was available to ask the target" });
    }
    return op.readOnly ? this.#finalize(d, opId, "cancelled", { error: "the worker ended while the call was running; it only reads and can be made again" }) : this.#finalize(d, opId, "uncertain", { error: "the worker ended while the call was running; it may have done its work" });
  }

  // ---- calls waiting for an approval ---------------------------------------------------------------------------------------------

  /** Looks at an attempt's parked calls: those whose approval came are told to the worker; those denied, withdrawn or run out are closed. */
  async sweepParked(attemptId: string, options: { includeTold?: boolean } = {}): Promise<{ attemptId: string; operationId: string; verdict: "approved" | "denied" | "expired" }[]> {
    const loaded = await this.#hooks.load(attemptId);
    const out: { attemptId: string; operationId: string; verdict: "approved" | "denied" | "expired" }[] = [];
    if (loaded === undefined || (loaded.body.state !== "running" && loaded.body.state !== "parked") || loaded.body.parked.length === 0 || this.#deps.reviews === undefined) return out;
    const agent = await this.#deps.credentials.principalOf(this.#deps.principal, attemptId, { limit: false }).catch(() => undefined);
    if (agent === undefined) return out;
    const now = this.#runner.now();
    for (const opId of loaded.body.parked) {
      const ref: AggregateRef = { kind: operationKind(attemptId), id: opId };
      const op = (await this.#runner.get(ref.kind, ref.id))?.body as unknown as ToolOperationBody | undefined;
      if (op === undefined || op.state !== "awaiting-approval" || op.reviewId === undefined) continue;
      const review = await this.#deps.reviews.get(agent, op.reviewId);
      if (review === undefined) continue;
      const handle = this.#hooks.handleOf(attemptId);
      if (review.state === "approved") {
        if (review.expiresAt !== undefined && review.expiresAt <= now) {
          await this.#closeParked({ d: loaded.body, ref, opId }, "the approval ran out before the call was made again");
          out.push({ attemptId, operationId: opId, verdict: "expired" });
          await handle?.tell?.(`Your call ${op.callId} was approved but the approval ran out before you made it again. Ask again.`);
        } else if (options.includeTold === true || !this.#told.has(opId)) {
          const first = !this.#told.has(opId);
          this.#told.add(opId);
          if (this.#told.size > TOLD_MAX) this.#told.delete(this.#told.values().next().value as string);
          out.push({ attemptId, operationId: opId, verdict: "approved" });
          if (first) await handle?.tell?.(`Your call ${op.callId} (${op.tool.name}) was approved. Make the same call again with the same call ID to run it.`);
        }
      } else if (review.state === "denied" || review.state === "withdrawn" || review.state === "used") {
        await this.#closeParked({ d: loaded.body, ref, opId }, `the approval was ${review.state}${review.reason === undefined ? "" : `: ${clip(redactText(review.reason), 200)}`}`);
        out.push({ attemptId, operationId: opId, verdict: "denied" });
        await handle?.tell?.(`Your call ${op.callId} (${op.tool.name}) was not approved${review.reason === undefined ? "" : `: ${clip(redactText(review.reason), 200)}`}.`);
      }
    }
    return out;
  }

  /** Forgets which parked calls of an attempt were announced (it gave its place back; the next run is told again). */
  forget(attemptId: string, opIds: readonly string[]): void { void attemptId; for (const id of opIds) this.#told.delete(id); }

  /** Calls the attempt was resumed for and the agent did not make again: closed as approved (or decided) but not made. */
  async closeUnmade(attemptId: string, opIds: readonly string[]): Promise<void> {
    for (const opId of opIds) {
      const loaded = await this.#hooks.load(attemptId);
      if (loaded === undefined || !loaded.body.parked.includes(opId)) continue;
      const ref: AggregateRef = { kind: operationKind(attemptId), id: opId };
      const op = (await this.#runner.get(ref.kind, ref.id))?.body as unknown as ToolOperationBody | undefined;
      if (op === undefined || op.state !== "awaiting-approval") continue;
      await this.#closeParked({ d: loaded.body, ref, opId }, "approved but not made again by the agent");
    }
  }

  /** The attempt is over: the calls still waiting for an approval will never be made. */
  async cancelParked(attemptId: string): Promise<void> {
    const loaded = await this.#hooks.load(attemptId);
    if (loaded === undefined) return;
    for (const opId of loaded.body.parked) {
      const ref: AggregateRef = { kind: operationKind(attemptId), id: opId };
      const op = (await this.#runner.get(ref.kind, ref.id))?.body as unknown as ToolOperationBody | undefined;
      if (op === undefined || op.state !== "awaiting-approval") continue;
      await this.#closeParked({ d: loaded.body, ref, opId }, "the attempt ended before the approval came");
    }
  }

  // ---- reads -------------------------------------------------------------------------------------------------------------------

  async list(attemptId: string): Promise<View<ToolOperationBody>[]> {
    const out: View<ToolOperationBody>[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(operationKind(attemptId), { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) { after = a.id; out.push(view<ToolOperationBody>(a)); }
      if (page.length < 200) break;
    }
    return out.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  }

  async #stored(attemptId: string, operationId: string): Promise<{ aggregate: { id: string }; body: ToolOperationBody } | undefined> {
    if (typeof operationId !== "string") return undefined;
    const found = await this.#runner.get(operationKind(attemptId), operationId);
    return found === undefined ? undefined : { aggregate: found, body: found.body as unknown as ToolOperationBody };
  }

  // ---- the request -------------------------------------------------------------------------------------------------------------

  #normalize(request: ToolCallRequest): Normalized {
    if (request === null || typeof request !== "object") invalid("request", "must be an object");
    onlyKnown(request, FIELDS);
    const callId = checkCallId(request.callId);
    const t = request.tool;
    if (t === null || typeof t !== "object") invalid("tool", "must be an object with name and version");
    onlyKnown(t, ["name", "version", "kind", "server"]);
    const name = checkToolName(t.name);
    if (typeof t.version !== "string" || t.version.length < 1 || t.version.length > DISPATCH_LIMITS.version) invalid("tool.version", `must be 1 to ${DISPATCH_LIMITS.version} characters`);
    const kind = t.kind === undefined ? "builtin" : t.kind === "builtin" || t.kind === "mcp" ? t.kind : invalid("tool.kind", "must be builtin or mcp");
    if (t.server !== undefined && (typeof t.server !== "string" || !/^mcs-[a-z2-7]{20}$/.test(t.server))) invalid("tool.server", "is not an MCP server ID");
    if (kind === "mcp" && t.server === undefined) invalid("tool.server", "an MCP tool names its server");
    if (request.args === null || typeof request.args !== "object" || Array.isArray(request.args)) invalid("args", "must be a JSON object");
    let encoded: string;
    try { encoded = canonicalJson(request.args); } catch { return invalid("args", "must be plain JSON"); }
    if (encoded.length > MAX_ARGS) invalid("args", `must be at most ${MAX_ARGS} characters when written out`);
    if (request.restricted !== undefined && typeof request.restricted !== "boolean") invalid("restricted", "must be true or false");
    if (request.script !== undefined && (typeof request.script !== "string" || request.script.length > 16 * 1024)) invalid("script", "must be text of at most 16 KB");
    const target = request.target === undefined ? undefined : (typeof request.target.kind === "string" && typeof request.target.id === "string" ? { kind: request.target.kind, id: request.target.id } : invalid("target", "needs a kind and an id"));
    if (request.estimatedSpend !== undefined && (typeof request.estimatedSpend !== "number" || !Number.isFinite(request.estimatedSpend) || request.estimatedSpend < 0)) invalid("estimatedSpend", "must be a number of at least 0");
    for (const flag of ["irreversible", "branchProtected"] as const) if (request[flag] !== undefined && typeof request[flag] !== "boolean") invalid(flag, "must be true or false");
    if (request.audience !== undefined && (typeof request.audience !== "string" || request.audience.length > 200)) invalid("audience", "must be text of at most 200 characters");
    if (request.environment !== undefined && !ENVIRONMENTS.includes(request.environment)) invalid("environment", `must be one of ${ENVIRONMENTS.join(", ")}`);
    const restricted = request.restricted === true;
    const digest = sha256(encoded);
    return {
      callId, tool: { name, version: t.version, kind, ...(t.server === undefined ? {} : { server: { id: t.server } }) }, args: request.args, restricted,
      ...(request.script === undefined ? {} : { script: request.script }), ...(target === undefined ? {} : { target }),
      ...(request.estimatedSpend === undefined ? {} : { estimatedSpend: request.estimatedSpend }), ...(request.irreversible === undefined ? {} : { irreversible: request.irreversible }),
      ...(request.branchProtected === undefined ? {} : { branchProtected: request.branchProtected }), ...(request.audience === undefined ? {} : { audience: request.audience }),
      ...(request.environment === undefined ? {} : { environment: request.environment }), digest, bytes: encoded.length,
      summary: restricted ? `[restricted payload, ${encoded.length} bytes]` : clip(redactText(encoded), DISPATCH_LIMITS.summary),
    };
  }
}

export type { EffectService };

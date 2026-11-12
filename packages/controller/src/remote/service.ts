import { createHash, randomUUID } from "node:crypto";
import type { ArtifactService } from "../artifacts/index.js";
import { canonicalJson, sha256 } from "../storage/json.js";
import type { DispatcherService } from "../dispatch/dispatcher.js";
import { DISPATCH_LIMITS } from "../dispatch/model.js";
import { ModelStreamRefused, type ModelStreamCall, type ModelStreamEvent, type ModelStreamTap } from "../dispatch/model-stream.js";
import type { CallMonitor, RelayMonitor } from "../dispatch/relay.js";
import { StartRefused, turnEndKindOf, type DoneCheckRequest, type ToolCallRequest, type ToolGateway, type ToolResult, type TurnUsage, type WorkOrder, type WorkerTurnResult } from "../dispatch/ports.js";
import type { SecurityEvent } from "../notifications/urgent.js";
import { DomainError, isDomainError } from "../domain/errors.js";
import type { EffectBridge } from "../domain/effects.js";
import { derivedId } from "../domain/ids.js";
import { mergeChanges } from "../domain/changes.js";
import { commandId as checkCommandId, onlyKnown, text } from "../domain/model.js";
import { CommandRunner, type CommandResult, type RunnerOptions } from "../domain/runner.js";
import type { Capabilities, HostService, HostStatus } from "../hosts/index.js";
import { credentialIdOf, scopedCommandId } from "../security/credentials.js";
import { DISPATCHER_PRINCIPAL } from "../security/task-credentials.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { cleanProcessRef } from "./process-ref.js";
import type { AggregateRef, Change, JsonObject } from "../storage/types.js";
import { WORKSPACE_OPERATIONS, type CarriedLanding, type WorkspaceCall } from "../workspace-ops/workspace-ops.js";
import { restartDigest } from "./contract-wire.js";
import { checkContract, CONTRACT_LIMIT_NAMES, type ContractEnforcement, type ContractLimitName } from "./contract.js";
import { WORKER_PROTOCOL, WAITING_FOR_OWNER, REMOTE_LIMITS, ProtocolMismatch, checkRange, negotiateProtocol, type ArtifactListing, type ToolBridgeAnswer, type ToolBridgeRequest, type ThinkingAnswer, type ThinkingWire, type ControlMessage, type Offer, type SequencedControl, type SessionInfo, type StoredResult, type VersionRange, type RemoteWorkspaceAnswer, type WorkspaceAsk } from "./protocol.js";

/** The latest events message of a model call: its number, a digest of its content and its (possibly still pending) answer. */
interface LastMessage { readonly n: number; readonly digest: string; readonly answer: Promise<{ readonly held?: string }> }

export const SESSION_KIND = "remote-session";
export const PLACEMENT_KIND = "remote-placement";
export const STORE_KIND = "remote-store";
export const RECONCILE_KIND = "remote-reconcile";

/** The most a worker may send as the input of one controller-run effect call. */
export const EFFECT_INPUT_BYTES = 64 * 1024;
const ATTEMPT = /^att-[a-z2-7]{20}$/;
const HOST = /^host:[a-z0-9][a-z0-9-]{0,39}$/;
const AGENT = /^agent:[a-z0-9][a-z0-9-]{0,39}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const attemptIdOf = (value: unknown): string => (typeof value === "string" && ATTEMPT.test(value) ? value : invalid("attemptId", "is not an attempt ID"));
const hostIdOf = (value: unknown, field = "hostId"): string => (typeof value === "string" && HOST.test(value) ? value : invalid(field, "must be a host principal ID"));

// ---- records ---------------------------------------------------------------------------------------------------------------------

/** One record per host: the latest connection of the worker and, if the controller ever turned it away, why. The record's revision at a connect is that connection's epoch, so epochs only grow. */
export interface SessionBody {
  readonly hostId: string;
  /** The current session's ID and epoch (0 and "" when the host has only ever been refused). Messages from an earlier session are fenced. */
  readonly sessionId: string;
  readonly sessionEpoch: number;
  /** The primary epoch of the controller the session was opened with (card H09b). Another controller that has taken over the store does not accept the session: the worker connects again and the recovery handshake decides on what it holds. */
  readonly primaryEpoch?: number;
  /** The credential the session was opened with: a rotation or a new enrolment ends the session. */
  readonly credentialId?: string;
  readonly protocol?: number;
  readonly workerVersion?: string;
  readonly connectedAt?: string;
  /** The latest time a worker was turned away (an incompatible protocol), kept until a connection succeeds: the owner sees it. */
  readonly refusal?: { readonly at: string; readonly reason: string; readonly worker: VersionRange; readonly controller: VersionRange };
  readonly refusals: number;
}

export type PlacementState = "offered" | "accepted" | "relocating" | "completed" | "ended";
const LIVE: ReadonlySet<PlacementState> = new Set(["offered", "accepted", "relocating"]);

/** What the attempt needs of a host. The platform is recorded from the host it was placed on. */
export interface Requirements {
  readonly os?: string;
  readonly arch?: string;
  readonly harness?: string;
  readonly isolation?: readonly string[];
  /** Named workspace bindings (never paths on the controller): the "path" part of the relocation policy. */
  readonly workspaces?: readonly string[];
  /** Where the attempt's data may be: `local-only` data moves only to hosts the policy lists. */
  readonly data: "local-only" | "cloud-allowed";
}

export interface PlacementBody {
  readonly attemptId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly generation: number;
  /** The model route of the order (card L05e), kept for the monitor's route and speed reading; absent from a placement made before it. */
  readonly route?: string;
  /** The host that holds the attempt now, and the number of this holding: every move, restart or re-offer raises it, and every worker message names it. */
  readonly hostId: string;
  readonly placement: number;
  readonly state: PlacementState;
  /** The worker session that accepted the placement (absent until it does). */
  readonly sessionId?: string;
  /** The controller's decision on taking the attempt up again in a newer session (card H09b): absent until a reconnected worker asks. It names the session it is for; a later session starts over. `auto` is a decision made by the setting at that time: it counts only while the setting is still `auto`; `approved` is the owner's. */
  readonly reaccept?: { readonly sessionId: string; readonly state: "pending" | "approved" | "auto"; readonly at: string; readonly by?: string };
  readonly offeredAt: string;
  readonly acceptedAt?: string;
  readonly expiresAt?: string;
  readonly requirements: Requirements;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly checkpoint?: { readonly artifactId: string; readonly sequence: number; readonly digest: string; readonly at: string };
  /** The dispatch contract sent with the order (card H12a). Until the worker has confirmed this very digest (`launched`) no tool call of the attempt is decided; a refusal ends the run. Rebuilt for every placement. */
  readonly contract?: { readonly digest: string; readonly recipe?: { readonly revision: string; readonly reach: readonly string[]; readonly limits?: JsonObject }; readonly bestEffort: boolean; readonly limits?: JsonObject; readonly requires: readonly string[]; readonly launched?: { readonly at: string; readonly sessionId: string; readonly enforcement: readonly ContractEnforcement[]; /** The confirmation is kept but the owner's launch record is still to be written (a retry of the confirmation writes it). */ readonly recordPending?: true }; /** When the contract was last cleared for a new confirmation (a restart with a changed recipe): heartbeats are accepted for a bounded window from then. */ readonly reconfirmSince?: string; readonly refused?: readonly string[] };
  /** The latest report of the worker on the processes it holds for this placement (card L02e). Belongs to the placement it names and to no other: a new placement (a move, a restart, a re-offer) starts without one. */
  readonly processReport?: { readonly placement: number; /** The worker session that sent it: `seq` rises within one session (absent on a record written before this was kept). */ readonly sessionId?: string; readonly seq: number; readonly at: string; readonly final: boolean; readonly processes: readonly { readonly ref: string; readonly kind: "process" | "child"; readonly state: "running" | "uncooperative" | "unknown" }[] };
  readonly checkpoints: number;
  readonly controlSeq: number;
  readonly control: readonly SequencedControl[];
  readonly result?: StoredResult;
  readonly relocations: number;
  /** The command that made the latest move (scoped to its issuer): the same command asked again is answered, not done again. */
  readonly lastRelocation?: { readonly commandId: string; readonly at: string };
  /** The earlier holders, newest last (bounded): a worker that held the attempt once is told it was fenced, anyone else is told nothing exists. */
  /** Card H07b: the offer was put back before the host read it (the policy refused it meanwhile); the reason is the last history entry. Dropped when the attempt is placed again. */
  readonly withdrawn?: true;
  readonly history: readonly { readonly hostId: string; readonly placement: number; readonly at: string; readonly reason: string; /** For a move: the command that made it. */ readonly commandId?: string }[];
}

/** The native Pi store of an agent has one exclusive owner host. The record says which, and which attempt holds it right now. */
export interface StoreBody {
  readonly agentId: string;
  readonly ownerHostId: string;
  readonly since: string;
  readonly liveAttempt?: string;
  readonly moves: number;
}

// ---- policy ----------------------------------------------------------------------------------------------------------------------

/** What the controller allows when an attempt moves to another host (card H02). Absent fields have the conservative defaults described on each. */
export interface RelocationPolicy {
  /** Platforms the attempt may run on. Default: the platform it was placed on. */
  readonly platforms?: readonly { readonly os: string; readonly arch: string }[];
  /** Hosts that may receive the attempt's task credential. Absent or empty: any enrolled host (the credential is bound to the attempt and ends with it); a non-empty list is the only hosts that may. */
  readonly credentialHosts?: readonly string[];
  /** Hosts that may hold `local-only` data. Default: none, so an attempt with local-only data is never moved. */
  readonly dataHosts?: readonly string[];
}
/** What may be placed where, beyond what a host can do (card H07). Absent fields do not restrict, except that `local-only` data needs the host to be listed in `dataHosts`, with or without a policy hook (default: never placed remotely). */
export interface PlacementPolicy {
  /** Hosts that may be given the attempt's task credential. Absent or empty: any enrolled host. */
  readonly credentialHosts?: readonly string[];
  /** Hosts that may hold `local-only` data. */
  readonly dataHosts?: readonly string[];
  /** Hosts that have access to the project's repository. Absent: not restricted. */
  readonly repositoryHosts?: readonly string[];
}
export type PlacementPolicyFor = (attempt: { readonly attemptId?: string; readonly taskId: string; readonly projectId: string; readonly agentId: string; readonly requirements: Requirements }) => Promise<PlacementPolicy>;

/** The reasons a policy keeps this host from the attempt. Pure. */
export function policyReasons(host: string, requirements: Requirements, policy: PlacementPolicy): string[] {
  const out: string[] = [];
  if (policy.credentialHosts !== undefined && policy.credentialHosts.length > 0 && !policy.credentialHosts.includes(host)) out.push(`the attempt's credential may not be given to ${host}`);
  if (requirements.data === "local-only" && !(policy.dataHosts ?? []).includes(host)) out.push(`the attempt's data is local-only and the data-location policy does not list ${host}`);
  if (policy.repositoryHosts !== undefined && !policy.repositoryHosts.includes(host)) out.push(`${host} has no access to the project's repository`);
  return out;
}

export type RelocationPolicyFor = (attempt: { readonly attemptId: string; readonly taskId: string; readonly projectId: string; readonly agentId: string; readonly from: string; readonly requirements: Requirements }) => Promise<RelocationPolicy>;

/** The reasons a host cannot take work with these requirements, from its announced capabilities. Pure. */
export function capabilityReasons(host: string, status: HostStatus | undefined, requirements: Requirements): string[] {
  if (status === undefined) return [`${host} is not an enrolled host`];
  const out: string[] = [];
  if (status.identity !== "active") out.push(`${host} is revoked`);
  if (status.freshness !== "fresh") out.push(`${host} has not been heard from recently (${status.freshness})`);
  const caps: Capabilities | undefined = status.capabilities;
  if (caps === undefined) return [...out, `${host} has not announced its capabilities`];
  if (requirements.os !== undefined && caps.os !== requirements.os) out.push(`${host} runs ${caps.os} and the attempt needs ${requirements.os}`);
  if (requirements.arch !== undefined && caps.arch !== requirements.arch) out.push(`${host} is ${caps.arch} and the attempt needs ${requirements.arch}`);
  if (requirements.harness !== undefined && !caps.harnesses.some((h) => h.name === requirements.harness)) out.push(`${host} does not have the ${requirements.harness} harness`);
  for (const iso of requirements.isolation ?? []) if (!caps.isolation.includes(iso)) out.push(`${host} does not offer ${iso} isolation`);
  for (const ws of requirements.workspaces ?? []) if (!caps.workspaces.includes(ws)) out.push(`${host} has no workspace binding named ${ws}`);
  return out;
}

interface WorkspaceAskState { readonly hostId: string; readonly wire: WorkspaceAsk; readonly at: number; abandoned: boolean; answer?: RemoteWorkspaceAnswer; readonly waiters: Set<() => void> }

/** The branch names a landing policy may carry: the same shape the owner's `workspace.landing.branch` accepts (up to 200 characters), so an owner's valid policy is never refused here as malformed (a host whose pin is another branch refuses it itself, by name). */
const LANDING_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** The owner's landing policy as carried to a remote host (card H12a): only the four owner-set figures, each checked and bounded; anything else is refused, so a request cannot smuggle a field. */
function checkCarriedLanding(value: unknown): CarriedLanding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("landing", "must be an object");
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!["branch", "requirePermit", "protectedPaths", "protectDefaults"].includes(key)) invalid("landing", `${key} is not a landing figure`);
  if (o["branch"] !== undefined && (typeof o["branch"] !== "string" || !LANDING_BRANCH.test(o["branch"]) || o["branch"].includes(".."))) invalid("landing.branch", "must be a branch name");
  if (o["requirePermit"] !== undefined && typeof o["requirePermit"] !== "boolean") invalid("landing.requirePermit", "must be true or false");
  if (o["protectDefaults"] !== undefined && typeof o["protectDefaults"] !== "boolean") invalid("landing.protectDefaults", "must be true or false");
  const paths = o["protectedPaths"];
  if (paths !== undefined && (!Array.isArray(paths) || paths.length > 200 || paths.some((p) => typeof p !== "string" || p.length < 1 || p.length > 300 || p.includes("\0")))) invalid("landing.protectedPaths", "must be a list of at most 200 paths of 1 to 300 characters");
  return { ...(o["branch"] === undefined ? {} : { branch: o["branch"] as string }), ...(o["requirePermit"] === undefined ? {} : { requirePermit: o["requirePermit"] as boolean }), ...(paths === undefined ? {} : { protectedPaths: [...(paths as string[])] }), ...(o["protectDefaults"] === undefined ? {} : { protectDefaults: o["protectDefaults"] as boolean }) };
}

/** The request as it is sent to a host: every field checked and bounded, nothing else carried. */
function checkAsk(call: WorkspaceCall): WorkspaceAsk {
  if (call === null || typeof call !== "object") invalid("call", "must be an object");
  const id = call.requestId;
  if (typeof id !== "string" || !/^wsr-[a-z2-7]{20}$/.test(id)) invalid("requestId", "is not a workspace request ID");
  if (!(WORKSPACE_OPERATIONS as readonly string[]).includes(call.operation)) invalid("operation", "is not a workspace operation");
  const name = /^[A-Za-z0-9._:-]{1,120}$/;
  if (typeof call.taskId !== "string" || !name.test(call.taskId) || typeof call.projectId !== "string" || !name.test(call.projectId)) invalid("taskId", "or projectId is malformed");
  if (typeof call.reason !== "string" || call.reason.length < 1 || call.reason.length > 500) invalid("reason", "must be 1 to 500 characters");
  if (!Array.isArray(call.quietAttempts) || call.quietAttempts.length > 50 || call.quietAttempts.some((a) => typeof a !== "string" || !ATTEMPT.test(a))) invalid("quietAttempts", "must be a short list of attempt IDs");
  if (call.assignee !== undefined && (typeof call.assignee !== "string" || !name.test(call.assignee))) invalid("assignee", "is malformed");
  // The owner's landing policy rides only a landing; any other operation carrying one is a mistake and is refused rather than quietly dropped.
  if (call.landing !== undefined && call.operation !== "landing") invalid("landing", "is carried only by a landing");
  return { requestId: id, operation: call.operation, taskId: call.taskId, projectId: call.projectId, reason: call.reason, quietAttempts: [...call.quietAttempts], ...(call.assignee === undefined ? {} : { assignee: call.assignee }), ...(call.landing === undefined ? {} : { landing: checkCarriedLanding(call.landing) }) };
}

/** The check of an attempt's done as it is sent to the host that holds the attempt (card H12a): every field bounded, nothing else carried. */
function checkVerifyAsk(requestId: string, attemptId: string, scope: { readonly taskId: string; readonly projectId: string }, request: DoneCheckRequest): WorkspaceAsk {
  if (typeof requestId !== "string" || !/^wsr-[a-z2-7]{20}$/.test(requestId)) invalid("requestId", "is not a workspace request ID");
  if (typeof attemptId !== "string" || !ATTEMPT.test(attemptId)) invalid("attemptId", "is not an attempt ID");
  const name = /^[A-Za-z0-9._:-]{1,120}$/;
  if (scope === null || typeof scope !== "object" || typeof scope.taskId !== "string" || !name.test(scope.taskId) || typeof scope.projectId !== "string" || !name.test(scope.projectId)) invalid("taskId", "or projectId is malformed");
  if (request === null || typeof request !== "object" || !Array.isArray(request.checks) || request.checks.length > 20 || !Array.isArray(request.evidence) || request.evidence.length > 100) invalid("verify", "must name at most 20 checks and 100 evidence paths");
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 1_048_576) invalid("verify.maxOutputBytes", "must be a whole number from 1 to 1048576");
  const checks = request.checks.map((c) => {
    if (c === null || typeof c !== "object" || typeof c.name !== "string" || c.name.length < 1 || c.name.length > 120 || !Array.isArray(c.run) || c.run.length < 1 || c.run.length > 50 || c.run.some((a) => typeof a !== "string" || a.length > 1000 || a.includes("\0")) || !Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1 || c.timeoutMs > 3_600_000) return invalid("verify.checks", "each check needs a name, a command of at most 50 words and a timeout of up to an hour");
    return { name: c.name, run: [...c.run], timeoutMs: c.timeoutMs };
  });
  const evidence = request.evidence.map((e) => (typeof e === "string" && e.length >= 1 && e.length <= 500 && !e.includes("\0") ? e : invalid("verify.evidence", "each path must be 1 to 500 characters")));
  return { requestId, operation: "verify", taskId: scope.taskId, projectId: scope.projectId, reason: "check the work of an attempt that said it is done", quietAttempts: [], verify: { attemptId, checks, evidence, maxOutputBytes: request.maxOutputBytes } };
}

/** A host's answer, checked: the typed outcome and nothing more, with the text and the detail bounded. */
function checkAnswer(value: unknown): RemoteWorkspaceAnswer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("outcome", "must be an object");
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!["ok", "summary", "detail", "reason", "failed"].includes(key)) invalid("outcome", `${key} is not a field of an answer`);
  if (o["failed"] !== undefined && (o["failed"] !== true || o["ok"] !== false)) invalid("failed", "is only true, on an answer that did not succeed");
  if (o["ok"] === true) {
    if (o["reason"] !== undefined) invalid("outcome", "an answer that succeeded has no reason");
    if (typeof o["summary"] !== "string" || o["summary"].length > 1000) invalid("summary", "must be text of at most 1000 characters");
    let detail: JsonObject | undefined;
    if (o["detail"] !== undefined) {
      if (o["detail"] === null || typeof o["detail"] !== "object" || Array.isArray(o["detail"])) invalid("detail", "must be an object");
      const encoded = JSON.stringify(o["detail"]);
      if (Buffer.byteLength(encoded, "utf8") > REMOTE_LIMITS.workspaceDetailBytes) invalid("detail", `must be at most ${REMOTE_LIMITS.workspaceDetailBytes} bytes`);
      detail = JSON.parse(encoded) as JsonObject;
    }
    return { ok: true, summary: o["summary"] as string, ...(detail === undefined ? {} : { detail }) };
  }
  if (o["ok"] !== false) invalid("ok", "must be true or false");
  if (o["summary"] !== undefined || o["detail"] !== undefined) invalid("outcome", "a refusal has only a reason");
  if (typeof o["reason"] !== "string" || o["reason"].length < 1 || o["reason"].length > 1000) invalid("reason", "must be text of 1 to 1000 characters");
  return { ok: false, reason: o["reason"] as string, ...(o["failed"] === true ? { failed: true as const } : {}) };
}

/** The promise's result, or an `unavailable` refusal when it takes longer than `ms` (its late result is ignored). */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DomainError("unavailable", `no answer within ${ms} ms`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}

// ---- the service -----------------------------------------------------------------------------------------------------------------

export interface RemoteDeps {
  /** The controller's security detectors (card U11d): a host that names an attempt it never held is a credential used on the wrong host. Never throws, never waits. */
  readonly detect?: (source: string, event: { readonly kind: SecurityEvent; readonly key: string; readonly subject?: string }) => void;
  /** Where a host's own security report goes (`UrgentWatch.reportSecurityFrom`): the report is the host's, so its allowance, once-per-key rule and collected item apply. Absent: reports are refused as unavailable. */
  readonly reportSecurity?: (by: Principal, event: { readonly kind: string; readonly key: string; readonly projectId?: string }) => Promise<{ readonly itemId: string; readonly held: boolean }>;
  /** Where a fault that must not stop the work is reported (card H07b: a policy that could not be read at delivery). Never throws is expected; a throw here is ignored. */
  readonly onError?: (error: unknown) => void;
  /** The dispatcher's own service principal (`service:dispatcher`): it places attempts, reads host status and moves attempts. */
  readonly principal: Principal;
  readonly hosts: Pick<HostService, "announce" | "heartbeat" | "status"> & Partial<Pick<HostService, "list">>;
  readonly artifacts: Pick<ArtifactService, "publish" | "get" | "readFile" | "assertResumable">;
  readonly dispatch: Pick<DispatcherService, "gateway" | "get" | "relocate" | "quiesce" | "release"> & Partial<Pick<DispatcherService, "liveAttempts">>;
  /** The policy for moving an attempt; the default is conservative (see `RelocationPolicy`). Always the controller's, never the caller's. */
  readonly relocationPolicy?: RelocationPolicyFor;
  /** Where an attempt may be placed in the first place (data location, repository access, who may hold the credential). Absent: only what a host can do decides. */
  readonly placementPolicy?: PlacementPolicyFor;
  /** Whether a worker that reconnected may take its still-owned attempt up again by itself (`auto`) or only once the owner approves (`owner`), card H09b. Absent or failing: `owner`. Read at every decision. */
  readonly reaccept?: () => Promise<"auto" | "owner">;
  /** How long the controller keeps the lease of an attempt that waits for the owner's decision alive, in ms, from the moment the waiting was recorded; `undefined`: it does not (off). Absent: 24 hours. */
  readonly patienceMs?: () => Promise<number | undefined>;
  /** How long, in ms, a worker's heartbeats are accepted before it has confirmed its dispatch contract (a slow sandbox start; after a restart with a changed recipe). Absent or undefined: the attempt lease. */
  readonly confirmWindowMs?: () => Promise<number | undefined>;
  /** Tells the owner an attempt waits for a decision (a Needs-you notice). Called whenever a worker is seen waiting; the notice ID makes a repeat one notice. A failure is ignored: the next poll calls again. */
  readonly notify?: (notice: ReconnectNotice) => Promise<void>;
  /**
   * The recorder of a remote worker's model streams (card L05c): given the attempt, the tap that begins, records and completes a generation for each model call the worker makes. The worker's events reach it through
   * `streamStart`, `streamEvents` and `streamEnd`, each checked against the placement like every other message. Absent: a worker's streams are not recorded (its calls are answered `recorded: false`).
   */
  readonly streams?: (attempt: { readonly attemptId: string; readonly taskId: string; readonly generation: number }) => ModelStreamTap;
  /**
   * The bridge for each effect kind (card H12a): the only code the controller runs for a remote worker's effect call. A worker names a kind; the controller looks it up here and never takes code, a target
   * address or a credential from the worker. Absent or empty: every effect call from a remote worker is refused. The composed controller passes the dispatcher's own `bridges`.
   */
  readonly bridges?: Readonly<Record<string, EffectBridge>>;
  /**
   * What the controller tells stall detection about a remote worker's model calls (card L05d): the same `RelayMonitor` a local relay reports to. The worker's calls are not seen by the controller's relay, so the start of a call, its first
   * output, its end and the time the controller itself spends waiting on its store while it records the reply (not the model's time) are reported from the stream messages. Absent: nothing is reported (as before).
   */
  readonly monitor?: (attempt: { readonly attemptId: string; readonly taskId: string; readonly generation: number; readonly route?: string; readonly hostId: string }) => RelayMonitor;
  /**
   * The controller's tool bridge (card L05e), for a remote worker's tool requests: `handle` is `ToolExecutionService.handle`, called with the worker's task credential and a gateway bound to the attempt. The request is admitted through the
   * same generation check and effect ledger as a local worker's. Absent: every bridge request from a remote worker is answered `unavailable`.
   */
  readonly toolBridge?: { readonly handle: (token: string, gateway: { readonly attemptId: string; readonly call: ToolGateway["call"] }, request: ToolBridgeRequest) => Promise<ToolBridgeAnswer> };
  /**
   * Keeps the model thinking a remote host's process reported (card U09c): the composed controller passes the thinking store, so a remote host's blocks are cleaned, redacted, bounded and kept exactly as a local process's are. It is called only
   * for the host's own accepted placement of the attempt, and judges the rest itself (the attempt must still be the task's current one at the generation of the placement). Absent: every thinking message is answered `unavailable`, nothing kept.
   */
  readonly thinking?: (attempt: { readonly attemptId: string; readonly taskId: string; readonly projectId: string; readonly agentId: string; readonly generation: number }, blocks: readonly ThinkingWire[]) => Promise<ThinkingAnswer>;
  /** The most thinking messages an attempt may send (default `REMOTE_LIMITS.thinkingMessages`, the figure a local process is held to); settable so a test need not send two thousand. */
  readonly thinkingMessages?: number;
  /** How often, at most, the output received so far of a remote model call is reported to `monitor` while it streams (ms, default 15,000, as for a local relay; 0 = with every message that carries output). */
  readonly monitorProgressMs?: number;
  /** Keeps what a remote launch came to, as for a local agent (card H12a; the owner's launch record). A failure refuses the confirmation: nothing runs unrecorded. */
  readonly recordLaunch?: (record: { readonly attemptId: string; readonly agentId: string; readonly outcome: "started" | "refused"; readonly requested: JsonObject; readonly bestEffort: boolean; readonly enforcement: readonly { readonly limit: string; readonly value: number; readonly enforced: "full" | "partial" | "none"; readonly by?: string; readonly detail: string }[]; readonly wallTimeMs: number; readonly failed?: readonly { readonly limit: string; readonly enforced: "partial" | "none"; readonly detail: string }[]; readonly reason?: string }) => Promise<void>;
}

export interface ReconnectNotice { readonly commandId: string; readonly attemptId: string; readonly hostId: string; readonly sessionId: string; readonly detail: string }
/** The longest a reconnect reconcile is answered from the last answer, and the shortest gap between two different ones, per session. */
export const RECONCILE_MIN_GAP_MS = 5000;
export const DEFAULT_REACCEPT_PATIENCE_MS = 24 * 3600_000;

export interface RemoteOptions extends RunnerOptions {
  /** The versions of the controller-worker protocol this controller speaks. Default `WORKER_PROTOCOL`. */
  readonly protocol?: VersionRange;
  /** The largest file one fetch returns, in bytes. Default `REMOTE_LIMITS.fileBytes`. */
  readonly fileBytes?: number;
  /** How long a move waits for the old host to settle its calls and send a checkpoint before it fences the host with the last stored one. Default 10 000 ms: a host that does not answer (a partition) must not hold up the pass that moves its work. */
  readonly settleMs?: number;
}

export interface ReconcileVerdict { readonly attemptId: string; readonly placement: number; readonly verdict: "stop" | "hold" | "reaccept" | "pending" | "unknown"; readonly reason: string }
export interface PendingReaccept { readonly attemptId: string; readonly placement: number; readonly hostId: string; readonly sessionId: string; readonly at: string }
export interface ReconcileReport {
  readonly sessionId: string;
  readonly mode: "auto" | "owner";
  readonly verdicts: readonly ReconcileVerdict[];
  /** Attempts the controller has accepted on this host that the worker did not list (card H09b), at most `REMOTE_LIMITS.held`: nobody runs them as far as the worker knows, so their lease ends them (nothing is resumed for them). Not worked out when the list is full (the worker may hold more than it can list). */
  readonly missing: readonly { readonly attemptId: string; readonly placement: number }[];
}
export interface Placed { readonly placement: number; readonly state: PlacementState }
export interface RelocationResult {
  readonly attemptId: string;
  readonly from: string;
  readonly to: string;
  readonly placement: number;
  /** `fresh`: the checkpoint was taken for this move; `stored`: the last one the worker had sent (the old host did not answer). */
  readonly checkpoint: "fresh" | "stored" | "none";
  readonly artifacts: readonly { readonly id: string; readonly manifestDigest: string; readonly files: number; readonly bytes: number }[];
}

/**
 * The controller's side of the remote worker transport (card H02), independent of how bytes travel (`WorkerTransport` is the HTTP carrier; the worker-facing methods take the authenticated host principal and
 * never a name the caller supplies).
 *
 * - **Admission of a worker.** `connect` accepts only an enrolled, active host on its current credential, negotiates the protocol version, takes the host's announced capabilities from its own registration
 *   (`HostService.announce`) and opens a session whose epoch only grows. A worker no common version can be found for is refused and the refusal is recorded where the owner can see it.
 * - **Admission of work.** A worker never asks for work and never creates any: the dispatcher `place`s an attempt on a host (an offer), the worker `accept`s that exact offer, and everything it does afterwards
 *   (tool calls, results, checkpoints, artifacts) is checked on every message against the placement: the host must be the holder, the placement number current, the session the one that accepted. A message
 *   that fails is `fenced` (a former holder, an old session, an old number) or reads as missing (anyone else). So a delayed or duplicated packet from before a partition, a reconnect or a relocation cannot act.
 * - **Calls** go to the dispatcher's own `ToolGateway` for the attempt: the same checks as a local worker's, and the generation fence besides.
 * - **Artifacts.** A worker fetches only artifacts its placement was given (inputs, its own outputs, its checkpoint), each read back verified against its recorded hash; what it publishes is recorded under the
 *   placement's own project and task, with the host as creator.
 * - **Relocation** (`relocate`, owner or dispatcher): judge the target against the policy, take or reuse a checkpoint, verify the checkpoint and every artifact, then in ONE commit raise the placement number
 *   (the old host is fenced from that moment), hand the attempt and the exclusive native store to the target; only then is the dispatcher told to restart the attempt there from the checkpoint.
 * - **The native Pi store** of an agent (`remote-store`) has one exclusive owner host; an attempt of that agent is placed only there, and the store moves only with `relocate` or the owner's `moveStore`.
 *
 * Offers hold the task credential, which is shown once and kept by nobody: they live in memory and are dropped when accepted, so a controller restart loses an unaccepted offer and the attempt's lease ends.
 */
export class RemoteWorkerService {
  readonly #runner: CommandRunner;
  readonly #deps: RemoteDeps;
  readonly #protocol: VersionRange;
  readonly #fileBytes: number;
  readonly #settleMs: number;
  readonly #reconciled = new Map<string, { at: number; key: string; report: ReconcileReport }>();
  readonly #offers = new Map<string, { readonly hostId: string; readonly placement: number; readonly order: WorkOrder }>();
  readonly #waiters = new Map<string, Set<(result: StoredResult) => void>>();
  /** The one open offers poll of each host (card H07): a new poll ends the earlier one, an offer or a new session ends it at once. */
  readonly #polls = new Map<string, { readonly end: () => void }>();
  readonly #pollStats = { polls: 0, held: 0, woken: 0, superseded: 0, timedOut: 0, disconnected: 0, withdrawn: 0 };
  /** Connected hosts by platform (`os/arch`), so a placement looks only at hosts that can run it (card H07). */
  readonly #byPlatform = new Map<string, Set<string>>();
  readonly #platformOf = new Map<string, string>();
  /** Workspace requests carried to hosts and their answers (card H12m). In memory: a request is recorded durably by the workspace service, and one lost with a restart reads there as uncertain. */
  readonly #asks = new Map<string, WorkspaceAskState>();
  /** The recording taps of attempts and the model calls open on them (card L05c). In memory: a restart loses them, the worker's open call then fails on its next message and the generation stays as the store left it. */
  readonly #taps = new Map<string, ModelStreamTap>();
  readonly #calls = new Map<string, { readonly attemptId: string; readonly placement: number; readonly hostId: string; readonly call: ModelStreamCall; /** What stall detection is told about this call (card L05d). */ readonly watch?: CallMonitor | undefined; seenOutput?: boolean; outputChars?: number; progressAt?: number; last?: LastMessage | undefined }>();
  /** One monitor per attempt, like the local relay's: its reports are numbered in order. */
  readonly #monitors = new Map<string, RelayMonitor>();
  /** The tool bridge requests being handled now, by attempt, call ID and placement (card L05e). */
  /** Per attempt: the thinking messages taken so far and those being kept now (card U09c). Bounded like the other per-attempt memos; an attempt that falls out starts counting again. */
  readonly #thinkingFlow = new Map<string, { readonly placement: number; messages: number; open: number }>();
  readonly #bridging = new Map<string, { readonly request: string; readonly answer: Promise<ToolBridgeAnswer> }>();
  /** The answer to each `stream-start` by its idempotency key, so a retry whose answer was lost does not begin a second generation (which would supersede the first). */
  readonly #starts = new Map<string, Promise<Awaited<ReturnType<RemoteWorkerService["streamStart"]>>>>();

  private constructor(runner: CommandRunner, deps: RemoteDeps, protocol: VersionRange, fileBytes: number, settleMs: number) {
    this.#settleMs = settleMs;
    this.#runner = runner;
    this.#deps = deps;
    this.#protocol = protocol;
    this.#fileBytes = fileBytes;
  }

  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, deps: RemoteDeps, options: RemoteOptions = {}): RemoteWorkerService {
    if (deps.principal.kind !== "service" || deps.principal.id !== DISPATCHER_PRINCIPAL || deps.principal.taskScope !== undefined) throw new DomainError("invalid_command", "principal: the remote service acts as the dispatcher's service principal", { field: "principal" });
    const fileBytes = options.fileBytes ?? REMOTE_LIMITS.fileBytes;
    if (!Number.isSafeInteger(fileBytes) || fileBytes < 1 || fileBytes > REMOTE_LIMITS.fileBytes) invalid("fileBytes", `must be a whole number from 1 to ${REMOTE_LIMITS.fileBytes}`);
    const settleMs = options.settleMs ?? 10_000;
    if (!Number.isSafeInteger(settleMs) || settleMs < 1 || settleMs > 600_000) invalid("settleMs", "must be a whole number of milliseconds from 1 to 600000");
    return new RemoteWorkerService(new CommandRunner(storage, epoch, options), deps, options.protocol === undefined ? WORKER_PROTOCOL : checkRange(options.protocol, "protocol"), fileBytes, settleMs);
  }

  /** The versions this controller speaks. */
  get protocol(): VersionRange { return this.#protocol; }
  get now(): string { return this.#runner.now(); }

  // ---- connecting --------------------------------------------------------------------------------------------------------------

  /** The caller must be an enrolled host on its current credential, checked against the stored record (an object kept from before a rotation or a revocation is refused). */
  async #active(host: Principal): Promise<void> {
    if (host.kind !== "host" || host.taskScope !== undefined) throw new DomainError("forbidden", `${host.id} is not a worker host`);
    const stored = await this.#runner.get("principal", host.id);
    const body = stored?.body as unknown as PrincipalBody | undefined;
    if (body === undefined || body.kind !== "host" || body.state !== "active" || body.credential === undefined || host.credentialId !== credentialIdOf(body.credential)) throw new DomainError("unauthenticated", "the credential was not accepted");
  }

  /**
   * Opens a session. The worker states the protocol versions it speaks, its own version and what it can do. The highest common protocol version is used; with none, the worker is refused (and the refusal is
   * recorded on its session record, visible to the owner) with a `ProtocolMismatch` that says what each side speaks. Repeating the same command ID returns the same session.
   */
  async connect(host: Principal, command: NoActor & { protocol: VersionRange; workerVersion: string; capabilities: Capabilities }): Promise<SessionInfo> {
    await this.#active(host);
    onlyKnown(command, ["commandId", "protocol", "workerVersion", "capabilities"]);
    checkCommandId(command.commandId);
    const worker = checkRange(command.protocol, "protocol");
    const workerVersion = text(command.workerVersion, "workerVersion", { min: 1, max: 80 });
    if (redactText(workerVersion) !== workerVersion) invalid("workerVersion", "looks like a credential or key; those are not recorded");
    const chosen = negotiateProtocol(this.#protocol, worker);
    if (!chosen.ok) {
      await this.#refuse(host, command.commandId, worker, chosen.reason);
      throw new ProtocolMismatch(`protocol: ${chosen.reason}`, this.#protocol);
    }
    // The host's facts come from its own registration, validated and bounded by the host service.
    await this.#deps.hosts.announce(host, { commandId: `${String(command.commandId)}:caps`, capabilities: command.capabilities });
    const result = await this.#runner.command("remote.connect", { commandId: scopedCommandId(host.id, command.commandId), actor: host.id }, async () => ({
      payload: { protocol: { ...worker }, workerVersion, version: chosen.version },
      build: async () => {
        const ref: AggregateRef = { kind: SESSION_KIND, id: host.id };
        const current = await this.#runner.get(SESSION_KIND, host.id);
        const before = current?.body as unknown as SessionBody | undefined;
        const epoch = (current?.revision ?? 0) + 1;
        const body: SessionBody = {
          hostId: host.id, sessionId: `ses-${epoch}`, sessionEpoch: epoch, primaryEpoch: this.#runner.epoch, ...(host.credentialId === undefined ? {} : { credentialId: host.credentialId }), protocol: chosen.version, workerVersion, connectedAt: this.#runner.now(), refusals: before?.refusals ?? 0,
        };
        const change: Change = current === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject };
        return { ref, creates: current === undefined, changes: [change], detail: { host: host.id, sessionEpoch: epoch, protocol: chosen.version } };
      },
    }));
    this.#index(host.id, command.capabilities);
    // An offers poll of the earlier session ends now; it is answered as fenced.
    this.#endPoll(host.id);
    return { sessionId: `ses-${result.revision}`, sessionEpoch: result.revision, primaryEpoch: this.#runner.epoch, protocol: chosen.version, controller: this.#protocol };
  }

  #index(hostId: string, caps: { readonly os?: unknown; readonly arch?: unknown } | undefined): void {
    if (caps === undefined || typeof caps.os !== "string" || typeof caps.arch !== "string") return;
    const key = `${caps.os}/${caps.arch}`;
    const old = this.#platformOf.get(hostId);
    if (old === key) return;
    if (old !== undefined) { const set = this.#byPlatform.get(old); set?.delete(hostId); if (set?.size === 0) this.#byPlatform.delete(old); }
    this.#platformOf.set(hostId, key);
    let set = this.#byPlatform.get(key);
    if (set === undefined) { set = new Set(); this.#byPlatform.set(key, set); }
    set.add(hostId);
  }

  #reportError(error: unknown): void { try { this.#deps.onError?.(error); } catch { /* ignored */ } }

  /** Takes a host out of the platform index (card H07b): a revoked host is no longer a candidate for any platform. */
  #unindex(hostId: string): void {
    const old = this.#platformOf.get(hostId);
    if (old === undefined) return;
    this.#platformOf.delete(hostId);
    const set = this.#byPlatform.get(old);
    set?.delete(hostId);
    if (set?.size === 0) this.#byPlatform.delete(old);
  }

  /**
   * Fills the platform index from the hosts the controller knows (card H07b), so a controller that restarted does not wait for each host to connect or poll before `candidates` can see it. Only active hosts that
   * announced a platform are indexed; a revoked one is left out. Being indexed is not being connected: `candidates` still refuses a host with no session of this run, saying so. Returns how many hosts were indexed.
   * Needs the host service's `list` (absent: nothing is indexed).
   */
  async rebuildIndex(by: Principal, pageSize = 100): Promise<number> {
    this.#staff(by);
    const list = this.#deps.hosts.list;
    if (list === undefined) return 0;
    let after: string | undefined; let n = 0;
    for (let page = 0; page < 1000; page++) {
      const got = await list.call(this.#deps.hosts, this.#deps.principal, { limit: Math.max(1, Math.min(100, Math.floor(pageSize))), ...(after === undefined ? {} : { afterId: after }) });
      for (const h of got.items) {
        if (h.identity !== "active") { this.#unindex(h.hostId); continue; }
        if (this.#platformOf.has(h.hostId)) continue;
        this.#index(h.hostId, h.capabilities);
        if (this.#platformOf.has(h.hostId)) n++;
      }
      if (got.next === undefined) break;
      after = got.next;
    }
    return n;
  }

  /** The platforms the index holds and their hosts, in order (card H07b); for the owner's and the dispatcher's view and for tests. */
  platformIndex(by: Principal): { readonly [platform: string]: readonly string[] } {
    this.#staff(by);
    return Object.fromEntries([...this.#byPlatform].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, [...v].sort()]));
  }

  /** Counts the offers made to each host, so a poll can tell that one arrived between its read and its wait. */
  readonly #made = new Map<string, number>();
  /** Attempts whose placement is being ended right now (H07b review): their offers are not handed out meanwhile. */
  readonly #ending = new Map<string, number>();
  #closed = false;

  #endPoll(hostId: string): void { this.#made.set(hostId, (this.#made.get(hostId) ?? 0) + 1); this.#polls.get(hostId)?.end(); }

  /** Ends every open poll (the controller is stopping). */
  close(): void { this.#closed = true; for (const c of this.#calls.values()) this.#abandon(c); this.#calls.clear(); for (const poll of [...this.#polls.values()]) poll.end(); for (const ask of this.#asks.values()) for (const wake of [...ask.waiters]) wake(); }

  // ---- workspace operations on a remote host (card H12m) -------------------------------------------------------------------------

  /**
   * Carries a workspace request (integration, landing, refresh, quarantine) to the host that holds the checkout and waits for its answer, which has the same typed shape a local host gives. Only the owner and the dispatcher may ask (the
   * workspace service does, after its own rights check, its record and the quiesce). Nothing is sent to a host that is not connected, revoked or not heard from lately: that is a refusal saying nothing was sent. A host that does not
   * answer within `waitMs` leaves the request as it is: this throws `unavailable` (the operation may or may not have been carried out) and the ask is withdrawn, so the host does not start it later; an answer that comes after is
   * accepted and dropped. The same request ID asked again joins the first ask and gets the same answer.
   */
  async askWorkspace(by: Principal, hostId: string, call: WorkspaceCall, options: { readonly waitMs: number }): Promise<RemoteWorkspaceAnswer> {
    this.#staff(by);
    return this.#ask(hostIdOf(hostId), checkAsk(call), options);
  }

  /**
   * Asks the host that holds an attempt to check its work (card H12a, the remote form of the check of a done, card W05): the contract's checks run in the attempt's own sandbox on that host and the state of its checkout is read
   * there. The same channel, limits and answer rules as a workspace request (withdrawn when the host is slow, one answer, bounded detail), but it changes nothing on the host. Only the owner and the dispatcher may ask.
   */
  async askVerify(by: Principal, hostId: string, requestId: string, attemptId: string, scope: { readonly taskId: string; readonly projectId: string }, request: DoneCheckRequest, options: { readonly waitMs: number }): Promise<RemoteWorkspaceAnswer> {
    this.#staff(by);
    return this.#ask(hostIdOf(hostId), checkVerifyAsk(requestId, attemptId, scope, request), options);
  }

  async #ask(host: string, wire: WorkspaceAsk, options: { readonly waitMs: number }): Promise<RemoteWorkspaceAnswer> {
    if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 1 || options.waitMs > 3_600_000) invalid("waitMs", "must be a whole number of milliseconds from 1 to 3600000");
    const earlier = this.#asks.get(wire.requestId);
    let ask: WorkspaceAskState;
    if (earlier !== undefined) {
      if (earlier.hostId !== host) invalid("requestId", "was asked of another host");
      // A request that timed out was withdrawn and is no longer listed: the host may have started it, or may refuse to start it, so joining it would wait for an answer that cannot come. Ask again with a new request ID.
      if (earlier.abandoned && earlier.answer === undefined) throw new DomainError("unavailable", `request ${wire.requestId} timed out earlier and was withdrawn from ${host}; it may or may not have been carried out there, so it is not asked again under the same ID`);
      ask = earlier;
    } else {
      const reasons = capabilityReasons(host, await this.#deps.hosts.status(this.#deps.principal, host), { data: "cloud-allowed" });
      if (reasons.length > 0 || (await this.#connected(host)) === undefined) return { ok: false, reason: `${reasons.length > 0 ? reasons.join("; ") : `${host} is not connected`}; nothing was sent` };
      const waiting = [...this.#asks.values()].filter((a) => a.hostId === host && a.answer === undefined && !a.abandoned).length;
      if (waiting >= REMOTE_LIMITS.workspaceAsks) return { ok: false, reason: `${host} already has ${waiting} workspace requests waiting; nothing was sent` };
      // The map stays bounded: answered and withdrawn requests older than an hour are dropped first.
      if (this.#asks.size >= 256) for (const [id, a] of this.#asks) if ((a.answer !== undefined || a.abandoned) && Date.now() - a.at > 3_600_000) this.#asks.delete(id);
      if (this.#asks.size >= 256) return { ok: false, reason: "too many workspace requests are open; nothing was sent" };
      const at = Date.now();
      // The host enforces the deadline: it does not start the request after the controller has stopped waiting and freed the agent.
      ask = { hostId: host, wire: { ...wire, expiresAt: new Date(at + options.waitMs).toISOString() }, at, abandoned: false, waiters: new Set() };
      this.#asks.set(wire.requestId, ask);
      // The host's offers poll ends now, so it reads its requests without waiting out the hold.
      this.#endPoll(host);
    }
    if (ask.answer === undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, options.waitMs);
        timer.unref?.();
        function done(): void { clearTimeout(timer); ask.waiters.delete(done); resolve(); }
        ask.waiters.add(done);
        if (this.#closed) done();
      });
    }
    if (ask.answer !== undefined) return ask.answer;
    ask.abandoned = true;
    throw new DomainError("unavailable", `${host} did not answer the workspace request within ${options.waitMs} ms; it may or may not have been carried out there`);
  }

  /** The workspace requests waiting for this host, oldest first. The same request is listed until the host answers it (or it is withdrawn). */
  async workspaceRequests(host: Principal, sessionId: unknown): Promise<WorkspaceAsk[]> {
    await this.#session(host, sessionId);
    return [...this.#asks.values()].filter((a) => a.hostId === host.id && a.answer === undefined && !a.abandoned).sort((x, y) => x.at - y.at).map((a) => a.wire);
  }

  /** The requests the controller withdrew from this host (it stopped waiting) and no answer came for; the host drops any it has queued and not started. Kept for an hour. */
  async workspaceWithdrawn(host: Principal, sessionId: unknown): Promise<string[]> {
    await this.#session(host, sessionId);
    return [...this.#asks.entries()].filter(([, a]) => a.hostId === host.id && a.answer === undefined && a.abandoned && Date.now() - a.at < 3_600_000).map(([id]) => id).slice(0, 100);
  }

  /**
   * The host's answer to one request. Only the host the request was made to may answer it (any other reads it as missing); the first answer stands, the same answer again is accepted as a repeat, a different one is refused;
   * an answer to a request that was withdrawn is accepted and dropped. The shape is checked and bounded here.
   */
  async answerWorkspace(host: Principal, sessionId: unknown, requestId: unknown, outcome: unknown): Promise<{ readonly accepted: true; readonly repeat: boolean; readonly late: boolean }> {
    await this.#session(host, sessionId);
    const ask = typeof requestId === "string" && /^wsr-[a-z2-7]{20}$/.test(requestId) ? this.#asks.get(requestId) : undefined;
    if (ask === undefined || ask.hostId !== host.id) throw new DomainError("not_found", "no such workspace request");
    const answer = checkAnswer(outcome);
    if (ask.answer !== undefined) {
      if (canonicalJson(ask.answer as unknown as JsonObject) !== canonicalJson(answer as unknown as JsonObject)) throw new DomainError("command_conflict", "that workspace request was already answered differently");
      return { accepted: true, repeat: true, late: false };
    }
    ask.answer = answer;
    const late = ask.abandoned;
    for (const wake of [...ask.waiters]) wake();
    return { accepted: true, repeat: false, late };
  }

  /**
   * A security event the host itself detected (card U11d, the worker-side hook): the report goes to the controller's Urgent watch as the host's own, so a host can neither fake nor mute another's event. The
   * kind, key and project are checked there; this only needs a current session of a known host.
   */
  async reportSecurity(host: Principal, sessionId: unknown, event: unknown): Promise<{ readonly itemId: string; readonly held: boolean }> {
    await this.#session(host, sessionId);
    if (this.#deps.reportSecurity === undefined) throw new DomainError("unavailable", "this controller takes no security reports");
    if (event === null || typeof event !== "object" || Array.isArray(event)) throw new DomainError("invalid_command", "event: must be an object with kind and key", { field: "event" });
    const e = event as Record<string, unknown>;
    for (const k of Object.keys(e)) if (k !== "kind" && k !== "key" && k !== "projectId") throw new DomainError("invalid_command", `event.${k}: is not a field of a security report`, { field: "event" });
    return this.#deps.reportSecurity(host, e as { kind: string; key: string; projectId?: string });
  }

  /** How many polls are held open and how they ended, for the owner and for tests (card H07). */
  pollStats(by: Principal): { readonly open: number; readonly polls: number; readonly held: number; readonly woken: number; readonly superseded: number; readonly timedOut: number; /** Held polls (or polls about to be held) whose client had gone (card H07b). */ readonly disconnected: number; /** Offers put back at delivery because the policy now refused them (card H07b). */ readonly withdrawn: number } {
    this.#staff(by);
    return { open: this.#polls.size, ...this.#pollStats };
  }

  async #refuse(host: Principal, commandId: unknown, worker: VersionRange, reason: string): Promise<void> {
    await this.#runner.command("remote.refuse", { commandId: scopedCommandId(host.id, `refuse:${String(commandId)}`), actor: host.id }, async () => ({
      payload: { worker: { ...worker }, reason },
      build: async () => {
        const ref: AggregateRef = { kind: SESSION_KIND, id: host.id };
        const current = await this.#runner.get(SESSION_KIND, host.id);
        const before = current?.body as unknown as SessionBody | undefined;
        const refusal = { at: this.#runner.now(), reason, worker, controller: this.#protocol };
        const body: SessionBody = before === undefined
          ? { hostId: host.id, sessionId: "", sessionEpoch: 0, refusal, refusals: 1 }
          : { ...before, refusal, refusals: before.refusals + 1 };
        const change: Change = current === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject };
        return { ref, creates: current === undefined, changes: [change], detail: { host: host.id, refused: reason.slice(0, 200) } };
      },
    }));
  }

  /** A host's session record as the owner (or the dispatcher) sees it; anyone else reads nothing. */
  async session(by: Principal, hostId: string): Promise<SessionBody | undefined> {
    this.#staff(by);
    const found = await this.#runner.get(SESSION_KIND, hostIdOf(hostId));
    return found === undefined ? undefined : found.body as unknown as SessionBody;
  }

  /** The hosts that have been turned away and not connected since, for the owner's attention. One page. */
  async refused(by: Principal, page: { afterId?: string; limit?: number } = {}): Promise<{ items: SessionBody[]; next?: string }> {
    this.#staff(by);
    const limit = page.limit ?? 100;
    const records = await this.#runner.list(SESSION_KIND, { ...(page.afterId === undefined ? {} : { afterId: page.afterId }), limit });
    const last = records.at(-1);
    return { items: records.map((r) => r.body as unknown as SessionBody).filter((s) => s.refusal !== undefined), ...(records.length === limit && last !== undefined ? { next: last.id } : {}) };
  }

  async #session(host: Principal, sessionId: unknown): Promise<SessionBody> {
    await this.#active(host);
    const found = await this.#runner.get(SESSION_KIND, host.id);
    const body = found?.body as unknown as SessionBody | undefined;
    if (body === undefined || body.sessionEpoch < 1 || typeof sessionId !== "string" || body.sessionId !== sessionId || body.credentialId !== host.credentialId) {
      throw new DomainError("fenced", "this is not the host's current session; connect again", { field: "session" });
    }
    // A session opened with an earlier primary is not taken over with the store (card H09b): the worker connects again, and what it holds is taken up again only by this controller's decision (the handshake, then accept).
    if (body.primaryEpoch !== this.#runner.epoch) throw new DomainError("fenced", "the session was opened with another controller, which is no longer the primary; connect again", { field: "session" });
    return body;
  }

  /** What the worker's current session is (and so which protocol version every message of it must name). */
  async sessionInfo(host: Principal, sessionId: unknown): Promise<SessionInfo> {
    const body = await this.#session(host, sessionId);
    return { sessionId: body.sessionId, sessionEpoch: body.sessionEpoch, primaryEpoch: this.#runner.epoch, protocol: body.protocol!, controller: this.#protocol };
  }

  /** The worker is alive. Counted by the host service (controller clock, increasing sequence). */
  async heartbeat(host: Principal, sessionId: unknown, command: NoActor & { sequence: number }): Promise<CommandResult> {
    await this.#session(host, sessionId);
    return this.#deps.hosts.heartbeat(host, command);
  }

  // ---- placing work (the dispatcher's side) ---------------------------------------------------------------------------------------

  #staff(by: Principal): void {
    const dispatcher = by.kind === "service" && by.id === DISPATCHER_PRINCIPAL;
    if (!((by.kind === "owner" || dispatcher) && by.taskScope === undefined)) throw new DomainError("forbidden", `${by.id} may not do that; remote placements are the owner's and the dispatcher's`);
  }

  async #connected(hostId: string): Promise<SessionBody | undefined> {
    const body = (await this.#runner.get(SESSION_KIND, hostId))?.body as unknown as SessionBody | undefined;
    return body !== undefined && body.sessionEpoch >= 1 && body.protocol !== undefined ? body : undefined;
  }

  /**
   * Why a host would refuse an attempt now, before any place is asked for it (card H07e): what it announced, its connection and the placement policy; empty when it would take it. `place` judges the same things again at the start.
   * The agent's native store is not judged here: the dispatcher handles it by pinning the attempt to the store's host.
   */
  async refusals(by: Principal, query: { readonly hostId: string; readonly attemptId: string; readonly taskId: string; readonly projectId: string; readonly agentId: string; readonly requirements: Requirements }): Promise<{ reasons: string[]; lasting: boolean }> {
    this.#staff(by);
    const hostId = hostIdOf(query.hostId);
    const attemptId = attemptIdOf(query.attemptId);
    const requirements = checkRequirements(query.requirements);
    const reasons = capabilityReasons(hostId, await this.#deps.hosts.status(this.#deps.principal, hostId), requirements);
    if ((await this.#connected(hostId)) === undefined) reasons.push(`${hostId} has not connected to the controller`);
    reasons.push(...policyReasons(hostId, requirements, this.#deps.placementPolicy === undefined ? {} : await this.#deps.placementPolicy({ attemptId, taskId: query.taskId, projectId: query.projectId, agentId: query.agentId, requirements })));
    // A host that is not connected, not heard from lately or has not announced yet may be fine in a moment; anything else (policy, what the host can do) lasts until someone changes it.
    return { reasons, lasting: lastingReasons(reasons) };
  }

  /**
   * Offers an attempt to a connected host (dispatcher or owner only). Refused, with every reason, when the host is revoked or stale, has not connected, or lacks what the attempt needs (platform, harness,
   * isolation, workspace bindings); when the agent's native store belongs to another host; or when an artifact it is given is missing or altered. The offer holds the order (and so the task credential) in
   * memory until the worker accepts it. A second placement of an attempt that is already on this host raises the placement number: the earlier run is fenced.
   */
  async place(by: Principal, command: { readonly hostId: string; readonly order: WorkOrder; readonly requirements: Requirements; readonly inputs?: readonly string[] }): Promise<Placed> {
    this.#staff(by);
    const hostId = hostIdOf(command.hostId);
    const order = command.order;
    if (order === null || typeof order !== "object") invalid("order", "must be a work order");
    const attemptId = attemptIdOf(order.attemptId);
    if (!AGENT.test(order.agentId)) invalid("order.agentId", "must be an agent principal ID");
    const inputs = [...new Set(command.inputs ?? [])];
    if (inputs.length > REMOTE_LIMITS.artifacts) invalid("inputs", `at most ${REMOTE_LIMITS.artifacts} artifacts`);
    const requirements = checkRequirements(command.requirements);
    // A remote placement is refused without a sealed contract: the gate on tool calls cannot be skipped by leaving the contract out.
    if (order.contract === undefined) throw new DomainError("invalid_command", `attempt ${attemptId} has no dispatch contract; a remote placement must carry one`, { field: "order.contract" });
    const sealed = checkContract(order);
    const contract: PlacementBody["contract"] = { digest: sealed.digest, recipe: { revision: order.recipe.revision, reach: [...order.recipe.reach], ...(order.recipe.limits === undefined ? {} : { limits: { ...order.recipe.limits } as JsonObject }) }, bestEffort: sealed.bestEffort, ...(sealed.limits === undefined ? {} : { limits: { ...sealed.limits } as JsonObject }), requires: [...sealed.requires] };
    // The dispatcher's own record decides whether this is the attempt's host: a placement cannot contradict it.
    const dispatch = await this.#deps.dispatch.get(by, attemptId);
    if (dispatch === undefined || dispatch.state !== "running" || dispatch.hostId !== hostId || dispatch.generation !== order.generation || dispatch.taskId !== order.taskId || dispatch.agentId !== order.agentId) {
      throw new DomainError("invalid_command", `attempt ${attemptId} is not running on ${hostId} under the dispatcher's record`, { field: "order" });
    }
    const status = await this.#deps.hosts.status(this.#deps.principal, hostId);
    const session = await this.#connected(hostId);
    const reasons = capabilityReasons(hostId, status, requirements);
    if (session === undefined) reasons.push(`${hostId} has not connected to the controller`);
    reasons.push(...policyReasons(hostId, requirements, this.#deps.placementPolicy === undefined ? {} : await this.#deps.placementPolicy({ attemptId, taskId: order.taskId, projectId: order.projectId, agentId: order.agentId, requirements })));
    // A typed refusal (card H07b): nothing was offered, so the dispatcher may try the attempt on another host.
    if (reasons.length > 0) throw new StartRefused(hostId, attemptId, reasons, lastingReasons(reasons));
    for (const id of inputs) await this.#deps.artifacts.assertResumable([id]);
    const placed = { ...requirements, os: status!.capabilities!.os, arch: status!.capabilities!.arch };
    let offered = 0;
    for (const o of this.#offers.values()) if (o.hostId === hostId) offered++;
    if (offered >= REMOTE_LIMITS.offers && !this.#offers.has(attemptId)) throw new StartRefused(hostId, attemptId, [`${hostId} already has ${REMOTE_LIMITS.offers} offers that are not accepted`], false, "unavailable");
    const now = this.#runner.now();
    const result = await this.#changePlacement(attemptId, async (current) => {
      const store = await this.#runner.get(STORE_KIND, order.agentId);
      const storeBody = store?.body as unknown as StoreBody | undefined;
      if (storeBody !== undefined && storeBody.ownerHostId !== hostId) {
        throw new DomainError("invalid_transition", `the native Pi store of ${order.agentId} belongs to ${storeBody.ownerHostId}; an attempt of that agent runs only there until the store is moved (relocate, or the owner's moveStore)`, { field: "hostId" });
      }
      if (storeBody?.liveAttempt !== undefined && storeBody.liveAttempt !== attemptId && (await this.#isLive(storeBody.liveAttempt))) {
        throw new DomainError("invalid_transition", `the native Pi store of ${order.agentId} is held by attempt ${storeBody.liveAttempt}, which is still live; one attempt at a time`, { field: "order" });
      }
      let next: PlacementBody;
      if (current === undefined) {
        next = { attemptId, taskId: order.taskId, projectId: order.projectId, agentId: order.agentId, generation: order.generation, ...(order.route === "" ? {} : { route: order.route }), hostId, placement: 1, state: "offered", offeredAt: now, ...(order.expiresAt === undefined ? {} : { expiresAt: order.expiresAt }), requirements: placed, inputs, outputs: [], checkpoints: 0, controlSeq: 0, control: [], relocations: 0, history: [], contract };
      } else {
        const b = current.body;
        if (b.hostId !== hostId) throw new DomainError("invalid_transition", `attempt ${attemptId} is placed on ${b.hostId}; it moves to ${hostId} only through relocate`, { field: "hostId" });
        if (b.generation !== order.generation) throw new DomainError("fenced", `the placement of attempt ${attemptId} belongs to generation ${b.generation}`, { field: "order" });
        // After a relocation the offer completes the move at the number already fenced; any other second placement is a new run and fences the earlier one.
        const number = b.state === "relocating" ? b.placement : b.placement + 1;
        const { sessionId: _s, acceptedAt: _a, result: _r, contract: _c, processReport: _p, withdrawn: _w, ...rest } = b; void _s; void _a; void _r; void _c; void _p; void _w;
        next = { ...rest, ...(order.route === "" ? {} : { route: order.route }), contract, placement: number, state: "offered", offeredAt: now, ...(order.expiresAt === undefined ? {} : { expiresAt: order.expiresAt }), requirements: placed, inputs: [...new Set([...b.inputs, ...inputs])], control: [], history: b.state === "relocating" ? b.history : pushHistory(b.history, { hostId: b.hostId, placement: b.placement, at: now, reason: "placed again" }) };
      }
      const storeChanges: Change[] = [];
      const holder: StoreBody = { agentId: order.agentId, ownerHostId: hostId, since: storeBody?.since ?? now, liveAttempt: attemptId, moves: storeBody?.moves ?? 0 };
      const storeRef: AggregateRef = { kind: STORE_KIND, id: order.agentId };
      storeChanges.push(store === undefined ? { type: "create", ref: storeRef, body: holder as unknown as JsonObject } : { type: "update", ref: storeRef, expectedRevision: store.revision, body: holder as unknown as JsonObject });
      return { next, extra: storeChanges };
    }, "place");
    if (wasLive(result.previous)) this.#wake(attemptId, result.previous!.placement, "the attempt was placed again; the earlier run is fenced");
    this.#offers.set(attemptId, { hostId, placement: result.body.placement, order });
    // The host's open poll, if it has one, is answered now.
    this.#endPoll(hostId);
    return { placement: result.body.placement, state: "offered" };
  }

  /** How many offers made to a host are not accepted yet (card H07b); the figure `candidates` orders by, for the dispatcher's own choice among hosts. */
  offerLoad(by: Principal, hostId: string): number {
    this.#staff(by);
    let n = 0;
    for (const o of this.#offers.values()) if (o.hostId === hostId) n++;
    return n;
  }

  /**
   * The hosts an attempt could be placed on now, and why the others cannot take it (card H07). Only hosts of the platform it needs are looked at (the index is by platform, so a pool of many hosts of other
   * platforms costs nothing); each of those is judged by what it announced, its freshness, its session and the placement policy. When none can, `waiting` says so in plain words, including which platforms are
   * connected, so an attempt that needs a platform nobody has waits visibly. The less loaded host (fewer offers not yet accepted) comes first, then the host ID.
   */
  async candidates(by: Principal, query: { readonly attemptId?: string; readonly taskId: string; readonly projectId: string; readonly agentId: string; readonly requirements: Requirements }): Promise<{ readonly eligible: readonly string[]; readonly considered: number; readonly refused: readonly { readonly hostId: string; readonly reasons: readonly string[] }[]; readonly waiting?: string }> {
    this.#staff(by);
    const requirements = checkRequirements(query.requirements);
    const keys = [...this.#byPlatform.keys()].filter((k) => { const [os, arch] = k.split("/"); return (requirements.os === undefined || os === requirements.os) && (requirements.arch === undefined || arch === requirements.arch); });
    const pool = keys.flatMap((k) => [...this.#byPlatform.get(k)!]);
    const policy = this.#deps.placementPolicy === undefined ? {} : await this.#deps.placementPolicy({ ...(query.attemptId === undefined ? {} : { attemptId: query.attemptId }), taskId: query.taskId, projectId: query.projectId, agentId: query.agentId, requirements });
    const load = new Map<string, number>();
    for (const o of this.#offers.values()) load.set(o.hostId, (load.get(o.hostId) ?? 0) + 1);
    const eligible: string[] = []; const refused: { hostId: string; reasons: string[] }[] = [];
    for (const hostId of pool) {
      const status = await this.#deps.hosts.status(this.#deps.principal, hostId);
      const reasons = capabilityReasons(hostId, status, requirements);
      // A revoked host is refused this once, with its reason, and leaves the index: it is not looked at again until it connects anew (card H07b).
      if (status?.identity === "revoked") this.#unindex(hostId);
      if ((await this.#connected(hostId)) === undefined) reasons.push(`${hostId} has not connected to the controller`);
      reasons.push(...policyReasons(hostId, requirements, policy));
      if (reasons.length === 0) eligible.push(hostId); else refused.push({ hostId, reasons });
    }
    eligible.sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || (a < b ? -1 : 1));
    refused.sort((a, b) => (a.hostId < b.hostId ? -1 : 1));
    let waiting: string | undefined;
    if (eligible.length === 0) {
      const have = [...this.#byPlatform].map(([k, v]) => `${k} x${v.size}`).sort().join(", ") || "no host";
      const need = [requirements.os, requirements.arch].filter((x) => x !== undefined).join("/") || "any platform";
      waiting = pool.length === 0 ? `no connected host runs ${need} (connected: ${have}); the attempt waits until one connects` : `${pool.length} host(s) run ${need} but none can take the attempt now (${refused.slice(0, 3).map((r) => r.reasons[0]).join("; ")}); it waits`;
    }
    return { eligible, considered: pool.length, refused: refused.slice(0, 20), ...(waiting === undefined ? {} : { waiting }) };
  }

  /** Whether an attempt's placement is still live (not ended, completed or expired). */
  async #isLive(attemptId: string): Promise<boolean> {
    const found = (await this.#runner.get(PLACEMENT_KIND, attemptId))?.body as unknown as PlacementBody | undefined;
    return found !== undefined && LIVE.has(found.state) && (found.expiresAt === undefined || found.expiresAt > this.#runner.now());
  }

  /** What a read of a placement shows the owner or dispatcher. */
  async placement(by: Principal, attemptId: string): Promise<PlacementBody | undefined> {
    this.#staff(by);
    const found = await this.#runner.get(PLACEMENT_KIND, attemptIdOf(attemptId));
    return found === undefined ? undefined : found.body as unknown as PlacementBody;
  }

  /** The owner of an agent's native Pi store, if it has one. */
  async store(by: Principal, agentId: string): Promise<StoreBody | undefined> {
    this.#staff(by);
    if (!AGENT.test(agentId)) invalid("agentId", "must be an agent principal ID");
    const found = await this.#runner.get(STORE_KIND, agentId);
    return found === undefined ? undefined : found.body as unknown as StoreBody;
  }

  /**
   * Where an agent's native store is and whether another attempt holds it right now (dispatcher or owner only). The dispatcher asks this before it starts an attempt, so an attempt whose store is
   * elsewhere goes there and one whose store is busy waits, instead of failing at the placement.
   */
  async storeOwner(by: Principal, agentId: string, attemptId: string): Promise<{ readonly hostId: string; readonly busy: boolean } | undefined> {
    this.#staff(by);
    if (!AGENT.test(agentId)) invalid("agentId", "must be an agent principal ID");
    const body = (await this.#runner.get(STORE_KIND, agentId))?.body as unknown as StoreBody | undefined;
    if (body === undefined) return undefined;
    const busy = body.liveAttempt !== undefined && body.liveAttempt !== attemptId && (await this.#isLive(body.liveAttempt));
    return { hostId: body.ownerHostId, busy };
  }

  /**
   * The owner moves an agent's native store to another host (for instance after the old one is retired). Refused while an attempt of the agent is live, and when the new host is not connected and fresh.
   * This changes the controller's record of who may run the agent; the store's files are moved by whatever the owner or the checkpoint transfer does.
   */
  async moveStore(owner: Principal, command: NoActor & { agentId: string; toHostId: string }): Promise<CommandResult> {
    if (owner.kind !== "owner" || owner.taskScope !== undefined) throw new DomainError("forbidden", `${owner.id} is not the owner`);
    onlyKnown(command, ["commandId", "agentId", "toHostId"]);
    checkCommandId(command.commandId);
    if (!AGENT.test(command.agentId)) invalid("agentId", "must be an agent principal ID");
    const to = hostIdOf(command.toHostId, "toHostId");
    return this.#runner.command("remote.move-store", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { agentId: command.agentId, toHostId: to },
      build: async () => {
        const ref: AggregateRef = { kind: STORE_KIND, id: command.agentId };
        const current = await this.#runner.get(STORE_KIND, command.agentId);
        const before = current?.body as unknown as StoreBody | undefined;
        if (before?.liveAttempt !== undefined && (await this.#isLive(before.liveAttempt))) throw new DomainError("invalid_transition", `attempt ${before.liveAttempt} of ${command.agentId} is live; its store cannot move`);
        const reasons = capabilityReasons(to, await this.#deps.hosts.status(this.#deps.principal, to), { data: "cloud-allowed" });
        if ((await this.#connected(to)) === undefined) reasons.push(`${to} has not connected to the controller`);
        if (reasons.length > 0) throw new DomainError("invalid_command", `the store cannot move to ${to}: ${reasons.join("; ")}`, { field: "toHostId" });
        const now = this.#runner.now();
        const body: StoreBody = { agentId: command.agentId, ownerHostId: to, since: now, moves: (before?.moves ?? -1) + 1 };
        const change: Change = current === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject };
        return { ref, creates: current === undefined, changes: [change], detail: { agentId: command.agentId, from: before?.ownerHostId ?? null, to } };
      },
    }));
  }

  /**
   * Ends the placement (the attempt is over, stopped or lost). The worker's later messages are fenced. Repeating it is harmless. With `placement`, only that run is ended: the stop of an earlier run
   * that arrives after the attempt was placed again does not end the new one.
   */
  async end(by: Principal, attemptId: string, reason: string, placement?: number): Promise<void> {
    this.#staff(by);
    await this.#endPlacement(attemptId, reason, placement, false);
  }

  /** Ends the placement; `withdrawn` marks an offer put back at delivery (card H07b), which the waiting turn is told so the dispatcher admits the task again. */
  async #endPlacement(attemptId: string, reason: string, placement: number | undefined, withdrawn: boolean): Promise<boolean> {
    attemptIdOf(attemptId);
    const why = text(reason, "reason", { min: 1, max: 300 });
    if (placement !== undefined && (!Number.isSafeInteger(placement) || placement < 1)) invalid("placement", "must be a whole number of at least 1");
    let ended: PlacementBody | undefined;
    // While the ending is being written, no poll hands the offer out (it is kept in memory in case the write fails).
    this.#ending.set(attemptId, (this.#ending.get(attemptId) ?? 0) + 1);
    try {
      const done = await this.#changePlacement(attemptId, async (current) => {
        // A withdrawal ends only an offer nobody has taken up (H07b review): if the host accepted it while the policy was being read, the run is its own now and is not ended as "withdrawn before it was delivered".
        if (current === undefined || !LIVE.has(current.body.state) || (placement !== undefined && current.body.placement !== placement) || (withdrawn && current.body.state !== "offered")) { ended = undefined; return undefined; }
        const now = this.#runner.now();
        const next: PlacementBody = { ...current.body, state: "ended", ...(withdrawn ? { withdrawn: true as const } : {}), history: pushHistory(current.body.history, { hostId: current.body.hostId, placement: current.body.placement, at: now, reason: why }) };
        return { next, extra: await this.#releaseStore(current.body) };
      }, "end");
      if (done.previous !== undefined && LIVE.has(done.previous.state) && done.body.state === "ended") ended = done.body;
    } catch (error) { if (!isDomainError(error, "not_found")) throw error; } finally {
      const n = (this.#ending.get(attemptId) ?? 1) - 1;
      if (n <= 0) this.#ending.delete(attemptId); else this.#ending.set(attemptId, n);
    }
    // The offer (and its credential) is dropped only once the ending is written (H07b review): a write that fails leaves the placement offered, and the offer must still be there for the next poll to judge it again.
    // Only the offer of the run that was ended: a newer placement's offer made meanwhile is kept.
    if (ended !== undefined && this.#offers.get(attemptId)?.placement === ended.placement) this.#offers.delete(attemptId);
    if (ended !== undefined) this.#wake(attemptId, ended.placement, why, withdrawn ? { status: "cancelled", error: why.slice(0, 300), withdrawn: true } : undefined);
    return ended !== undefined;
  }

  async #releaseStore(b: PlacementBody): Promise<Change[]> {
    const store = await this.#runner.get(STORE_KIND, b.agentId);
    const body = store?.body as unknown as StoreBody | undefined;
    if (store === undefined || body === undefined || body.liveAttempt !== b.attemptId) return [];
    const { liveAttempt: _l, ...rest } = body; void _l;
    return [{ type: "update", ref: { kind: STORE_KIND, id: b.agentId }, expectedRevision: store.revision, body: rest as unknown as JsonObject }];
  }

  /** Sends the worker a message (tell the agent, restart the sandbox, take a checkpoint, stop). With `placement` it is refused (`fenced`) unless that is the placement now holding the attempt. Bounded; the worker reads it with `pollControl`. */
  async control(by: Principal, attemptId: string, message: ControlMessage, placement?: number): Promise<number> {
    this.#staff(by);
    attemptIdOf(attemptId);
    const msg = checkControl(message);
    const done = await this.#changePlacement(attemptId, async (current) => {
      if (current === undefined) throw new DomainError("not_found", `attempt ${attemptId} has no remote placement`);
      if (!LIVE.has(current.body.state)) throw new DomainError("fenced", `the placement of attempt ${attemptId} is ${current.body.state}`);
      // The caller's placement is checked in the same commit as the message: a move that landed meanwhile cannot take an old handle's message.
      if (placement !== undefined && current.body.placement !== placement) throw new DomainError("fenced", `attempt ${attemptId} is held under placement ${current.body.placement}, not ${placement}`);
      const seq = current.body.controlSeq + 1;
      // A restart that changes what the sandbox reaches or the limits it runs under is a new launch: the confirmation is cleared and the digest is recomputed for the new recipe, so the worker must confirm
      // again before another call is decided (card H12a). A restart into the same recipe changes nothing.
      let contract = current.body.contract;
      if (msg.kind === "restart" && contract !== undefined) {
        const was = contract.recipe;
        const reach = [...new Set(msg.recipe.reach)].sort();
        const same = was !== undefined && canonicalJson({ reach: [...new Set(was.reach)].sort(), limits: (was.limits ?? null) as JsonObject | null } as unknown as JsonObject) === canonicalJson({ reach, limits: (msg.recipe.limits ?? null) as JsonObject | null } as unknown as JsonObject);
        if (!same) {
          // Limits can stay or tighten: a restart that drops a limit the attempt ran under is refused.
          for (const name of Object.keys(was?.limits ?? {})) if ((msg.recipe.limits as Record<string, number> | undefined)?.[name] === undefined) throw new DomainError("invalid_command", `the restart drops the limit ${name}; limits can stay or tighten, not go`, { field: "recipe.limits" });
          for (const [name, value] of Object.entries(msg.recipe.limits ?? {})) {
            const owner = (contract.limits as Record<string, number> | undefined)?.[name];
            if (owner !== undefined && value > owner) throw new DomainError("invalid_command", `the restart raises ${name} to ${value}, above the owner's limit ${owner}`, { field: "recipe.limits" });
          }
          const { launched: _l, ...rest } = contract; void _l;
          contract = { ...rest, reconfirmSince: this.#runner.now(), digest: restartDigest(contract.digest, msg.recipe), recipe: { revision: msg.recipe.revision, reach: [...msg.recipe.reach], ...(msg.recipe.limits === undefined ? {} : { limits: { ...msg.recipe.limits } as JsonObject }) } };
        }
      }
      return { next: { ...current.body, ...(contract === undefined ? {} : { contract }), controlSeq: seq, control: [...current.body.control, { ...msg, seq }].slice(-REMOTE_LIMITS.control) } };
    }, "control");
    return done.body.controlSeq;
  }

  /**
   * Resolves with the worker's result for this run of the attempt: what it reported with `complete`, or a cancelled result when the placement ended or was fenced meanwhile. Observing an already
   * decided placement answers at once. An aborted wait rejects.
   */
  waitForResult(by: Principal, attemptId: string, placement: number, signal?: AbortSignal): Promise<StoredResult> {
    this.#staff(by);
    attemptIdOf(attemptId);
    return new Promise<StoredResult>((resolve, reject) => {
      const key = `${attemptId}#${placement}`;
      const set = this.#waiters.get(key) ?? new Set();
      const done = (r: StoredResult): void => { set.delete(done); if (set.size === 0) this.#waiters.delete(key); signal?.removeEventListener("abort", onAbort); resolve(r); };
      const onAbort = (): void => { set.delete(done); if (set.size === 0) this.#waiters.delete(key); reject(new DomainError("unavailable", "the wait was aborted")); };
      set.add(done);
      this.#waiters.set(key, set);
      if (signal?.aborted === true) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      // Already decided? (Registered first, so a decision between the read and the registration is not missed.)
      void this.#runner.get(PLACEMENT_KIND, attemptId).then((found) => {
        const b = found?.body as unknown as PlacementBody | undefined;
        if (b === undefined) return;
        if (b.placement === placement && b.state === "completed" && b.result !== undefined) done(b.result);
        else if (b.placement === placement && b.state === "ended" && b.withdrawn === true) done({ status: "cancelled", error: (b.history.at(-1)?.reason ?? "the offer was withdrawn").slice(0, 300), withdrawn: true });
        else if (b.placement !== placement || b.state === "ended") done({ status: "cancelled", error: "the placement ended or was replaced" });
      }, () => undefined);
    });
  }

  /** Ends, as failed, the model calls still open for an attempt whose placement ended, completed or moved: their generations would otherwise stay streaming. */
  #endStreams(attemptId: string, placement?: number): void {
    for (const [id, c] of [...this.#calls.entries()]) {
      if (c.attemptId !== attemptId || (placement !== undefined && c.placement !== placement)) continue;
      this.#calls.delete(id);
      this.#abandon(c);
    }
    if (placement === undefined) { this.#taps.delete(attemptId); this.#monitors.delete(attemptId); }
  }

  #wake(attemptId: string, placement: number, reason: string, result?: StoredResult): void {
    this.#endStreams(attemptId, placement);
    const set = this.#waiters.get(`${attemptId}#${placement}`);
    if (set === undefined) return;
    for (const done of [...set]) done(result ?? { status: "cancelled", error: reason.slice(0, 300) });
  }

  // ---- the worker's side ---------------------------------------------------------------------------------------------------------

  /**
   * The offers waiting for this host, in the order made. Repeating the call returns the same offers until they are accepted. With `waitMs` (at most `REMOTE_LIMITS.pollMs`) and nothing waiting, the call is held until an
   * offer is made to this host, its session is replaced, a newer poll of its own takes over, the controller stops or the time is up (card H07): a host asks once, not once per agent, and an idle host costs the controller
   * one open request. A host has at most one held poll.
   */
  async offers(host: Principal, sessionId: unknown, asked: unknown = 0, signal?: AbortSignal): Promise<Offer[]> {
    if (typeof asked !== "number" || !Number.isSafeInteger(asked) || asked < 0 || asked > REMOTE_LIMITS.pollMs) invalid("wait", `must be a whole number of milliseconds from 0 to ${REMOTE_LIMITS.pollMs}`);
    const waitMs = asked as number;
    const session = await this.#session(host, sessionId);
    this.#pollStats.polls++;
    if (!this.#platformOf.has(host.id)) this.#index(host.id, (await this.#deps.hosts.status(this.#deps.principal, host.id))?.capabilities);
    let first: Offer[]; let seen: number;
    do {
      seen = this.#made.get(host.id) ?? 0;
      first = await this.#pending(host);
      // An offer made while the read was under way is read again, not waited for.
    } while (first.length === 0 && waitMs > 0 && (this.#made.get(host.id) ?? 0) !== seen);
    if (first.length > 0 || waitMs === 0 || this.#closed) return first;
    // A client that has already gone is not held for (card H07b).
    if (signal?.aborted === true) { this.#pollStats.disconnected++; return []; }
    const earlier = this.#polls.get(host.id);
    if (earlier !== undefined) { this.#pollStats.superseded++; earlier.end(); }
    this.#pollStats.held++;
    let left = false as boolean;
    const how = await new Promise<"woken" | "timeout">((resolve) => {
      const timer = setTimeout(() => finish("timeout"), waitMs);
      timer.unref?.();
      const entry = { end: () => finish("woken") };
      const finish = (result: "woken" | "timeout"): void => { clearTimeout(timer); signal?.removeEventListener("abort", gone); if (this.#polls.get(host.id) === entry) this.#polls.delete(host.id); resolve(result); };
      // The client's connection closed while the poll was held: the poll ends now and frees its place, so a dead connection does not hold a poll for the rest of the wait (card H07b).
      const gone = (): void => { left = true; finish("woken"); };
      signal?.addEventListener("abort", gone, { once: true });
      this.#polls.set(host.id, entry);
    });
    if (left) { this.#pollStats.disconnected++; return []; }
    if (how === "timeout") this.#pollStats.timedOut++; else this.#pollStats.woken++;
    // The session may have been replaced while the poll was held: the answer is then `fenced`, not offers for a session that no longer exists.
    await this.#session(host, session.sessionId);
    return this.#pending(host);
  }

  async #pending(host: Principal): Promise<Offer[]> {
    const out: Offer[] = [];
    for (const [attemptId, offer] of this.#offers) {
      if (offer.hostId !== host.id || this.#ending.has(attemptId)) continue;
      const b = (await this.#runner.get(PLACEMENT_KIND, attemptId))?.body as unknown as PlacementBody | undefined;
      // The attempt may have been placed again while the read was under way: the offer now held is the newer one, and is neither deleted nor judged by the older read.
      const live = this.#offers.get(attemptId);
      if (live === undefined) continue;
      if (live !== offer) { if (b !== undefined && b.hostId === host.id && b.placement === live.placement && b.state === "offered") out.push({ placement: live.placement, order: live.order }); continue; }
      if (b === undefined || b.hostId !== host.id || b.placement !== offer.placement || b.state !== "offered") { this.#offers.delete(attemptId); continue; }
      // Card H07b: the placement policy is judged again as the host reads its offer. An offer the policy has since refused for a reason that lasts is put back, not delivered.
      if ((await this.#withdrawIfRefused(host.id, attemptId, offer.placement, b, "delivered")) !== "deliver") continue;
      // Ended (or being ended) while the policy was read: not handed out.
      if (this.#ending.has(attemptId) || this.#offers.get(attemptId) !== offer) continue;
      out.push({ placement: offer.placement, order: offer.order });
    }
    return out;
  }

  /**
   * Judges an offer again at delivery (card H07b): what the host announced and the placement policy, read now. If the host would now refuse it for a reason that lasts (the policy no longer lists it, it cannot do what the
   * attempt needs), the offer is not delivered: it is withdrawn, the placement ends with the reasons in its history, and the attempt's waiting turn ends as cancelled with the same words, so the dispatcher ends that attempt
   * and the task is admitted again and placed by the policy as it is now. A reason that passes (not heard from lately, not connected) does not withdraw: the host is reading the offer, so it is connected, and the host judges the rest.
   * A policy (or host status) that cannot be read holds the offer back (H07b review): it is neither delivered nor withdrawn, the failure goes to `onError`, and the next poll judges it again. The policy decides who may be given the
   * task credential and local-only data, and `place` refuses on the same failure, so a read error must not hand the credential to a host the owner may just have removed. Without a policy hook the host's capabilities and the
   * built-in data rule are still judged, as `place` judges them. `stage` names the step in the recorded reason (`delivered` for a poll, `taken up` for an accept).
   * Returns `deliver`, `withdrawn` (put back now or by a concurrent read) or `held` (unreadable, or taken up meanwhile).
   */
  async #withdrawIfRefused(hostId: string, attemptId: string, placement: number, b: PlacementBody, stage: "delivered" | "taken up"): Promise<"deliver" | "withdrawn" | "held"> {
    let reasons: string[];
    try {
      const requirements = checkRequirements(b.requirements);
      reasons = capabilityReasons(hostId, await this.#deps.hosts.status(this.#deps.principal, hostId), requirements);
      reasons.push(...policyReasons(hostId, requirements, this.#deps.placementPolicy === undefined ? {} : await this.#deps.placementPolicy({ attemptId, taskId: b.taskId, projectId: b.projectId, agentId: b.agentId, requirements })));
    } catch (error) { this.#reportError(error); return "held"; }
    if (reasons.length === 0 || !lastingReasons(reasons)) return "deliver";
    const why = `withdrawn before it was ${stage}, ${hostId} would now refuse it: ${reasons.join("; ")}`.slice(0, 300);
    let ended: boolean;
    try { ended = await this.#endPlacement(attemptId, why, placement, true); } catch (error) { this.#reportError(error); return "held"; }
    if (ended) { this.#pollStats.withdrawn++; return "withdrawn"; }
    // Not ended by this call: another read withdrew it first, or the host took it up meanwhile (the accept judged it again itself). Either way it is not handed out here.
    return "held";
  }

  /**
   * The worker takes the offer it was made, binding the placement to its current session. Also how a worker that reconnected after a partition takes its work up again: if the attempt was moved or ended meanwhile,
   * this is where it learns (`fenced`). The offer (and with it the credential) is dropped once accepted.
   */
  async accept(host: Principal, sessionId: unknown, attemptId: string, placement: unknown): Promise<{ placement: number; expiresAt?: string; controlSeq: number; checkpoint?: { artifactId: string; sequence: number } }> {
    const session = await this.#session(host, sessionId);
    const id = attemptIdOf(attemptId);
    const found = await this.#runner.get(PLACEMENT_KIND, id);
    const b = found?.body as unknown as PlacementBody | undefined;
    this.#holds(host, b, placement);
    if (b!.state !== "offered" && b!.state !== "accepted") throw new DomainError("fenced", `the placement of attempt ${id} is ${b!.state}`);
    if (b!.expiresAt !== undefined && b!.expiresAt <= this.#runner.now()) throw new DomainError("fenced", `attempt ${id} has expired`);
    // H07b review: an offer is judged again when it is first taken up, not only when it is read. A host that read the offer before the policy changed could otherwise accept it later without polling again and start
    // the attempt where the policy now refuses it. A lasting refusal withdraws it (the task is readmitted as at delivery); a policy that cannot be read is answered `unavailable`, and the host asks again.
    if (b!.state === "offered") {
      const verdict = await this.#withdrawIfRefused(host.id, id, b!.placement, b!, "taken up");
      if (verdict === "withdrawn") throw new DomainError("fenced", `the offer of attempt ${id} was withdrawn: the placement policy no longer allows ${host.id}`);
      if (verdict === "held") {
        const now = (await this.#runner.get(PLACEMENT_KIND, id))?.body as unknown as PlacementBody | undefined;
        if (now === undefined || now.hostId !== host.id || now.placement !== b!.placement || now.state === "ended" || now.state === "completed") throw new DomainError("fenced", `the placement of attempt ${id} changed`);
        if (now.state === "offered") throw new DomainError("unavailable", `the placement policy for attempt ${id} could not be read; ask again`);
      }
    }
    const mode = await this.#reacceptMode();
    const patience = await this.#patienceMs();
    let waiting = false;
    let marker: PlacementBody["reaccept"];
    const done = await this.#changePlacement(id, async (current) => {
      const x = current?.body;
      if (x === undefined || x.hostId !== host.id || x.placement !== b!.placement || (x.state !== "offered" && x.state !== "accepted")) throw new DomainError("fenced", `the placement of attempt ${id} changed`);
      // An attempt accepted in an older session is taken up again only by the controller's decision (card H09b): `auto` is that decision made by setting (and it counts only while the setting is still `auto`), otherwise the owner's approval for this very session.
      const again = x.state === "accepted" && x.sessionId !== undefined && x.sessionId !== session.sessionId;
      if (again && mode !== "auto" && !(x.reaccept?.sessionId === session.sessionId && x.reaccept.state === "approved")) {
        waiting = true;
        if (x.reaccept?.sessionId === session.sessionId && x.reaccept.state === "pending") { marker = x.reaccept; return undefined; }
        const next = this.#waiting(x, session.sessionId);
        marker = next.reaccept;
        return { next };
      }
      waiting = false;
      const { reaccept: _decided, ...rest } = x;
      return { next: { ...rest, state: "accepted", sessionId: session.sessionId, acceptedAt: x.acceptedAt ?? this.#runner.now() } };
    }, "accept", { actor: host.id });
    if (waiting) {
      await this.#tellOwner(done.body, marker);
      await this.#keepLease(id, marker, patience);
      throw new DomainError("unavailable", `attempt ${id} was taken up in another session; ${WAITING_FOR_OWNER} to approve taking it up again`);
    }
    this.#offers.delete(id);
    return { placement: done.body.placement, ...(done.body.expiresAt === undefined ? {} : { expiresAt: done.body.expiresAt }), controlSeq: done.body.controlSeq, ...(done.body.checkpoint === undefined ? {} : { checkpoint: { artifactId: done.body.checkpoint.artifactId, sequence: done.body.checkpoint.sequence } }) };
  }

  async #patienceMs(): Promise<number | undefined> {
    try { return this.#deps.patienceMs === undefined ? DEFAULT_REACCEPT_PATIENCE_MS : await this.#deps.patienceMs(); } catch { return DEFAULT_REACCEPT_PATIENCE_MS; }
  }

  /** The placement marked as waiting for the owner for this session. */
  #waiting(x: PlacementBody, sessionId: string): PlacementBody & { reaccept: NonNullable<PlacementBody["reaccept"]> } {
    return { ...x, reaccept: { sessionId, state: "pending", at: this.#runner.now() } };
  }

  /**
   * While an attempt waits for the owner and its worker keeps asking, the controller keeps the attempt's lease alive on the worker's behalf (a pending worker cannot call heartbeat), for the patience from the moment the waiting was recorded
   * (default 24 hours, the owner's setting, off = never); so the lease running out does not move the attempt while the owner is deciding. When the worker stops asking, or the patience is spent, the lease runs out as usual.
   */
  async #keepLease(attemptId: string, marker: PlacementBody["reaccept"], patience: number | undefined): Promise<void> {
    if (marker === undefined || patience === undefined || Date.parse(this.#runner.now()) - Date.parse(marker.at) >= patience) return;
    try { await this.#deps.dispatch.gateway(attemptId).heartbeat(); } catch { /* the attempt is over or not running: nothing to keep */ }
  }

  /** The owner is told once per waiting marker (the notice ID is made from the attempt and the marker); a failed notice is tried again at the next poll. */
  async #tellOwner(b: PlacementBody, marker: PlacementBody["reaccept"]): Promise<void> {
    if (this.#deps.notify === undefined || marker === undefined) return;
    try {
      await this.#deps.notify({ commandId: `reconnect-wait:${b.attemptId}:${sha256(`${marker.sessionId}|${marker.at}`).slice(0, 16)}`, attemptId: b.attemptId, hostId: b.hostId, sessionId: marker.sessionId,
        detail: `The worker on ${b.hostId} reconnected and waits for your decision on attempt ${b.attemptId} (placement ${b.placement}, session ${marker.sessionId}). Approve it or stop it with reconnect.reaccept; reconnect.pending lists what waits.` });
    } catch { /* told again at the next poll */ }
  }

  /** The attempts that wait for the owner's decision on a reconnected worker, oldest first (owner only, paged by attempt ID). */
  async pending(owner: Principal, page: { after?: string; limit?: number } = {}): Promise<{ items: PendingReaccept[]; next?: string }> {
    if (owner.kind !== "owner" || owner.taskScope !== undefined) throw new DomainError("forbidden", `${owner.id} may not list the attempts waiting for a decision`);
    const limit = page.limit === undefined ? 50 : page.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid("limit", "must be a whole number from 1 to 100");
    if (page.after !== undefined) attemptIdOf(page.after);
    const items: PendingReaccept[] = [];
    let after = page.after;
    for (let rounds = 0; rounds < 50 && items.length < limit; rounds++) {
      const rows = await this.#runner.list(PLACEMENT_KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      if (rows.length === 0) return { items };
      for (const row of rows) {
        after = row.id;
        const x = row.body as unknown as PlacementBody;
        if (x.state !== "accepted" || x.reaccept?.state !== "pending") continue;
        items.push({ attemptId: x.attemptId, placement: x.placement, hostId: x.hostId, sessionId: x.reaccept.sessionId, at: x.reaccept.at });
        if (items.length >= limit) return { items, next: row.id };
      }
      if (rows.length < 100) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }

  async #reacceptMode(): Promise<"auto" | "owner"> {
    try { return (await this.#deps.reaccept?.()) === "auto" ? "auto" : "owner"; } catch { return "owner"; }
  }

  /**
   * The recovery handshake (card H09b). A worker that reconnected lists the attempts it still holds; the controller compares them with its own records and answers each one:
   * `stop` (moved, ended, completed, expired or never accepted: fenced, stop work), `hold` (already current in this session), `reaccept` (still owned and approved for this session: call accept), `pending` (still owned, waiting for
   * the owner's approval under the `owner` setting) or `unknown` (the controller has no such attempt for this host, or a placement number it never issued; recorded, nothing is resumed). Nothing here resumes work:
   * the worker takes an attempt up only with `accept`, after this decision. A held list is bounded; the answer never reveals another host's attempts (an attempt that was never this host's is `unknown`). The last write is a record of
   * the handshake under the controller's epoch, so a controller that lost the epoch (an old primary) answers `stale_epoch` instead of verdicts from its stale reads.
   */
  async reconcile(host: Principal, sessionId: unknown, command: NoActor & { held: unknown }): Promise<ReconcileReport> {
    const session = await this.#session(host, sessionId);
    onlyKnown(command, ["commandId", "held"]);
    checkCommandId(command.commandId);
    if (!Array.isArray(command.held) || command.held.length > REMOTE_LIMITS.held) invalid("held", `must be a list of at most ${REMOTE_LIMITS.held} attempts`);
    const seen = new Set<string>();
    const held = (command.held as unknown[]).map((x, i) => {
      if (x === null || typeof x !== "object" || Array.isArray(x)) return invalid(`held[${i}]`, "must be an object with attemptId and placement");
      onlyKnown(x as Record<string, unknown>, ["attemptId", "placement"]);
      const o = x as { attemptId?: unknown; placement?: unknown };
      const attemptId = attemptIdOf(o.attemptId);
      if (typeof o.placement !== "number" || !Number.isSafeInteger(o.placement) || o.placement < 1) invalid(`held[${i}].placement`, "must be a whole number of at least 1");
      if (seen.has(attemptId)) invalid(`held[${i}]`, `attempt ${attemptId} is listed twice`);
      seen.add(attemptId);
      return { attemptId, placement: o.placement as number };
    });
    // At most one handshake per session in a short while: the same list is answered with the last answer, a different list waits (a worker asks once after it connects, not in a loop).
    const key = held.map((h) => `${h.attemptId}:${h.placement}`).sort().join(",");
    const nowMs = Date.parse(this.#runner.now());
    const last = this.#reconciled.get(`${host.id}|${session.sessionId}`);
    if (last !== undefined && nowMs - last.at < RECONCILE_MIN_GAP_MS && nowMs >= last.at) {
      if (last.key === key) return last.report;
      throw new DomainError("unavailable", `the recovery handshake is answered once every ${RECONCILE_MIN_GAP_MS / 1000} seconds per session; ask again with the new list in a moment`);
    }
    const mode = await this.#reacceptMode();
    const patience = await this.#patienceMs();
    const verdicts: ReconcileVerdict[] = [];
    for (const h of held) verdicts.push(await this.#verdict(host, session, mode, patience, h.attemptId, h.placement));
    const counts: Record<string, number> = {};
    for (const v of verdicts) counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
    const missing = held.length >= REMOTE_LIMITS.held ? [] : await this.#missing(host.id, new Set(held.map((h) => h.attemptId)));
    const body = { hostId: host.id, sessionId: session.sessionId, mode, counts, heldDigest: sha256(key), unknown: verdicts.filter((v) => v.verdict === "unknown").map((v) => v.attemptId), missing: missing.map((m) => m.attemptId) };
    const before = (await this.#runner.get(RECONCILE_KIND, host.id))?.body as unknown as (typeof body & { at: string }) | undefined;
    // The same list from the same session with the same outcome is not written again.
    const unchanged = before !== undefined && canonicalJson({ ...before, at: "" } as unknown as JsonObject) === canonicalJson({ ...body, at: "" } as unknown as JsonObject);
    if (!unchanged) await this.#runner.command("remote.reconcile", { commandId: scopedCommandId(host.id, `reconcile:${String(command.commandId)}`), actor: host.id }, async () => ({
      payload: { sessionId: session.sessionId, held: held.map((h) => `${h.attemptId}:${h.placement}`) },
      build: async () => {
        const ref: AggregateRef = { kind: RECONCILE_KIND, id: host.id };
        const current = await this.#runner.get(RECONCILE_KIND, host.id);
        const written = { ...body, at: this.#runner.now() };
        const change: Change = current === undefined ? { type: "create", ref, body: written as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: written as unknown as JsonObject };
        return { ref, creates: current === undefined, changes: [change], detail: { host: host.id, held: held.length, ...counts } };
      },
    }));
    const report: ReconcileReport = { sessionId: session.sessionId, mode, verdicts, missing };
    if (this.#reconciled.size >= 512) for (const [k, v] of this.#reconciled) if (nowMs - v.at >= RECONCILE_MIN_GAP_MS || this.#reconciled.size >= 1024) this.#reconciled.delete(k);
    this.#reconciled.set(`${host.id}|${session.sessionId}`, { at: nowMs, key, report });
    return report;
  }

  /** The attempts the dispatcher runs on this host whose placement the worker accepted and did not list (card H09b), bounded. Read from the dispatcher's live list, so it costs at most one read per live attempt. */
  async #missing(hostId: string, listed: ReadonlySet<string>): Promise<{ attemptId: string; placement: number }[]> {
    const live = (await this.#deps.dispatch.liveAttempts?.(this.#deps.principal)) ?? [];
    const out: { attemptId: string; placement: number }[] = [];
    for (const a of live) {
      if (a.state !== "running" || listed.has(a.attemptId)) continue;
      const b = (await this.#runner.get(PLACEMENT_KIND, a.attemptId))?.body as unknown as PlacementBody | undefined;
      if (b === undefined || b.hostId !== hostId || b.state !== "accepted" || (b.expiresAt !== undefined && b.expiresAt <= this.#runner.now())) continue;
      out.push({ attemptId: a.attemptId, placement: b.placement });
      if (out.length >= REMOTE_LIMITS.held) break;
    }
    return out.sort((x, y) => (x.attemptId < y.attemptId ? -1 : 1));
  }

  async #verdict(host: Principal, session: SessionBody, mode: "auto" | "owner", patience: number | undefined, attemptId: string, placement: number): Promise<ReconcileVerdict> {
    const say = (verdict: ReconcileVerdict["verdict"], reason: string): ReconcileVerdict => ({ attemptId, placement, verdict, reason });
    const b = (await this.#runner.get(PLACEMENT_KIND, attemptId))?.body as unknown as PlacementBody | undefined;
    if (b === undefined) return say("unknown", "the controller has no such attempt");
    if (b.hostId !== host.id) return b.history.some((h) => h.hostId === host.id) ? say("stop", "the attempt was moved to another host: stop work on it") : say("unknown", "the controller has no such attempt");
    if (placement > b.placement) return say("unknown", `the controller never issued placement ${placement}`);
    if (placement < b.placement) return say("stop", "the attempt was placed again: this holding is over");
    if (b.state !== "accepted") return say("stop", b.state === "offered" ? "the attempt was never accepted: take it from the offers" : `the placement is ${b.state}`);
    if (b.expiresAt !== undefined && b.expiresAt <= this.#runner.now()) return say("stop", "the attempt's lease has expired");
    if (b.sessionId === session.sessionId) return say("hold", "already taken up in this session");
    try {
      const done = await this.#changePlacement(attemptId, async (current) => {
        const x = current?.body;
        if (x === undefined || x.hostId !== host.id || x.placement !== placement || x.state !== "accepted") throw new DomainError("fenced", "the placement changed");
        if (x.sessionId === session.sessionId) return undefined;
        const r = x.reaccept;
        if (r?.sessionId === session.sessionId) {
          if (r.state === "approved") return undefined;
          if (r.state === mode || (r.state === "pending" && mode === "owner")) return undefined;
          if (r.state === "pending" && mode === "auto") return { next: { ...x, reaccept: { sessionId: session.sessionId, state: "auto", at: this.#runner.now() } } };
        }
        // A decision made by the setting is stored as such (`auto`), so a switch to `owner` does not leave an approval behind.
        if (mode === "auto") return { next: { ...x, reaccept: { sessionId: session.sessionId, state: "auto", at: this.#runner.now() } } };
        return { next: this.#waiting(x, session.sessionId) };
      }, "reconcile", { actor: host.id });
      if (done.body.sessionId === session.sessionId) return say("hold", "already taken up in this session");
      const r = done.body.reaccept;
      const mine = r?.sessionId === session.sessionId;
      if (mine && (r!.state === "approved" || (r!.state === "auto" && mode === "auto"))) return say("reaccept", "still yours: call accept to take it up again");
      await this.#tellOwner(done.body, r);
      await this.#keepLease(attemptId, r, patience);
      return say("pending", `${WAITING_FOR_OWNER} to approve taking it up again`);
    } catch (error) {
      if (isDomainError(error, "fenced")) return say("stop", "the placement changed while it was checked: stop work on it");
      throw error;
    }
  }

  /**
   * The owner decides on a reconnected worker's attempt that waits (card H09b): `approve` lets that worker's accept in that session succeed; `stop` ends the attempt (fenced). The decision names the placement and the session that asked
   * (and, when given, the moment the waiting was recorded): if a newer session asked meanwhile, or the waiting was recorded again, it is fenced and nothing is approved for the wrong session. A repeat of the same command ID returns what it recorded.
   */
  async decideReaccept(owner: Principal, command: NoActor & { attemptId: string; placement: number; sessionId: string; waitingSince?: string; decision: "approve" | "stop" }): Promise<{ state: "approved" | "stopped" }> {
    if (owner.kind !== "owner" || owner.taskScope !== undefined) throw new DomainError("forbidden", `${owner.id} may not decide on taking an attempt up again`);
    onlyKnown(command, ["commandId", "attemptId", "placement", "sessionId", "waitingSince", "decision"]);
    checkCommandId(command.commandId);
    const id = attemptIdOf(command.attemptId);
    if (typeof command.placement !== "number" || !Number.isSafeInteger(command.placement) || command.placement < 1) invalid("placement", "must be a whole number of at least 1");
    const sessionId = text(command.sessionId, "sessionId", { min: 1, max: 200 });
    const at = command.waitingSince === undefined ? undefined : text(command.waitingSince, "waitingSince", { min: 1, max: 40 });
    if (command.decision !== "approve" && command.decision !== "stop") invalid("decision", "must be approve or stop");
    const decision = command.decision;
    const by = { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id };
    let ended: PlacementBody | undefined;
    const result = await this.#runner.command("remote.reaccept", by, async () => ({
      payload: { attemptId: id, placement: command.placement, sessionId, waitingSince: at ?? null, decision },
      build: async () => {
        const found = await this.#runner.get(PLACEMENT_KIND, id);
        const b = found?.body as unknown as PlacementBody | undefined;
        if (found === undefined || b === undefined) throw new DomainError("not_found", "no such attempt");
        if (b.placement !== command.placement) throw new DomainError("fenced", `placement ${command.placement} of attempt ${id} is not the current one`, { field: "placement" });
        if (b.state !== "accepted" || b.reaccept === undefined || b.reaccept.state !== "pending") throw new DomainError("invalid_transition", `nothing waits for a decision on attempt ${id}`);
        if (b.reaccept.sessionId !== sessionId || (at !== undefined && b.reaccept.at !== at)) throw new DomainError("fenced", `attempt ${id} now waits for another session (or was asked again): look at reconnect.pending and decide again`, { field: "sessionId" });
        const ref: AggregateRef = { kind: PLACEMENT_KIND, id };
        if (decision === "approve") {
          const next: PlacementBody = { ...b, reaccept: { ...b.reaccept, state: "approved", at: this.#runner.now(), by: owner.id } };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: { attemptId: id, decision, sessionId } };
        }
        const why = "stopped by the owner after the worker reconnected";
        const next: PlacementBody = { ...b, state: "ended", history: pushHistory(b.history, { hostId: b.hostId, placement: b.placement, at: this.#runner.now(), reason: why }) };
        ended = next;
        return { ref, creates: false, changes: mergeChanges([{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }, ...(await this.#releaseStore(b))]), detail: { attemptId: id, decision, sessionId } };
      },
    }));
    if (ended !== undefined && !result.replayed) { this.#offers.delete(id); this.#wake(id, (ended as PlacementBody).placement, "stopped by the owner after the worker reconnected"); }
    return { state: decision === "approve" ? "approved" : "stopped" };
  }

  /** The placement must exist, be held by this host, and be the number the message names: a former holder is told it is fenced, anyone else that nothing is there. */
  #holds(host: Principal, b: PlacementBody | undefined, placement: unknown): asserts b is PlacementBody {
    if (b === undefined) throw new DomainError("not_found", "no such attempt");
    if (b.hostId !== host.id) {
      if (b.history.some((h) => h.hostId === host.id)) throw new DomainError("fenced", `attempt ${b.attemptId} is no longer on this host`);
      // A host that never held this attempt names it: its session is used for something it was not given (card U11d). The refusal is unchanged; the detectors are only told.
      try { this.#deps.detect?.("host-channel", { kind: "credential-misused", key: `host:${host.id.slice(0, 80)}>attempt:${b.attemptId.slice(0, 80)}`, subject: host.id }); } catch { /* telling never changes the refusal */ }
      throw new DomainError("not_found", "no such attempt");
    }
    if (typeof placement !== "number" || !Number.isSafeInteger(placement)) invalid("placement", "must be a whole number");
    if (placement !== b.placement) throw new DomainError("fenced", `placement ${String(placement)} of attempt ${b.attemptId} is not the current one`, { field: "placement" });
  }

  /** The check every message about a running attempt goes through. Returns the placement as it stands. */
  async #running(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, states: readonly PlacementState[] = ["accepted"]): Promise<PlacementBody> {
    const session = await this.#session(host, sessionId);
    const id = attemptIdOf(attemptId);
    const b = (await this.#runner.get(PLACEMENT_KIND, id))?.body as unknown as PlacementBody | undefined;
    this.#holds(host, b, placement);
    if (!states.includes(b.state)) throw new DomainError("fenced", `the placement of attempt ${id} is ${b.state}`);
    if (b.state !== "offered" && b.sessionId !== session.sessionId) throw new DomainError("fenced", "the attempt was taken up in another session; accept it again", { field: "session" });
    if (b.expiresAt !== undefined && b.expiresAt <= this.#runner.now()) throw new DomainError("fenced", `attempt ${id} has expired`);
    return b;
  }

  /**
   * A worker that has not confirmed the dispatch contract of this placement does nothing the attempt counts: no call is judged, recorded or run, no usage is booked, no checkpoint is kept, and a heartbeat
   * does not extend the lease (so a worker that never confirms is ended by the lease, and cannot complete a turn) (card H12a).
   */
  #needsConfirmation(b: PlacementBody, what: string): void {
    if (b.contract !== undefined && b.contract.launched === undefined) throw new DomainError("invalid_transition", `attempt ${b.attemptId}: the worker has not confirmed the dispatch contract; confirm it (launched) or refuse the order before ${what}`, { field: "contract" });
  }

  /**
   * A heartbeat is accepted before the confirmation for a bounded window (the owner's `confirmWindowMinutes`, default the attempt lease) counted from the acceptance, or from the restart that cleared the confirmation, so a slow sandbox
   * start or a restart is not ended while it prepares. After the window the heartbeat is refused and the lease runs out.
   */
  async #heartbeatAllowed(b: PlacementBody): Promise<void> {
    if (b.contract === undefined || b.contract.launched !== undefined) return;
    const since = Date.parse(b.contract.reconfirmSince ?? b.acceptedAt ?? b.offeredAt);
    const window = (await this.#deps.confirmWindowMs?.().catch(() => undefined)) ?? DISPATCH_LIMITS.leaseMs;
    if (!Number.isFinite(since) || Date.parse(this.#runner.now()) - since >= window) this.#needsConfirmation(b, "any heartbeat after the confirmation window");
  }

  async #gateway(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, what?: string): Promise<ToolGateway> {
    const b = await this.#running(host, sessionId, attemptId, placement);
    if (what !== undefined) this.#needsConfirmation(b, what);
    return this.#deps.dispatch.gateway(b.attemptId);
  }

  /** The split form of the dispatch contract: the controller decides and records the call; the worker runs it. */
  async begin(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, request: ToolCallRequest): Promise<Awaited<ReturnType<ToolGateway["begin"]>>> {
    if (request === null || typeof request !== "object" || Array.isArray(request)) invalid("request", "must be a tool call request");
    const b = await this.#running(host, sessionId, attemptId, placement);
    this.#needsConfirmation(b, "any tool call");
    return (await this.#deps.dispatch.gateway(b.attemptId)).begin(request);
  }

  /**
   * The controller-run form of an effect call (card H12a). The worker cannot hold the controller's ledger or a bridge, so it sends the call and what it wants done (`kind`, `target`, `input`); the controller judges the call
   * exactly as it does a local one (placement, confirmation, generation fence, pauses, decisions, policy, approval), writes it on the S05 ledger and runs its own bridge for that kind. The call ID makes a repeated or delayed
   * message the same call: it is answered from the record and never applied twice, and an effect that had started when the link was lost is settled from the ledger and the target, not by asking the worker again.
   */
  async effect(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, request: ToolCallRequest, effect: { readonly kind: unknown; readonly target: unknown; readonly input: unknown }): Promise<ToolResult> {
    if (request === null || typeof request !== "object" || Array.isArray(request)) invalid("request", "must be a tool call request");
    if (effect === null || typeof effect !== "object" || Array.isArray(effect)) invalid("effect", "must be an object");
    onlyKnown(effect, ["kind", "target", "input"]);
    const kind = typeof effect.kind === "string" && effect.kind.length >= 1 && effect.kind.length <= 100 ? effect.kind : invalid("effect.kind", "must be an effect kind of 1 to 100 characters");
    const target = typeof effect.target === "string" && effect.target.length >= 1 && effect.target.length <= 500 ? effect.target : invalid("effect.target", "must be a target of 1 to 500 characters");
    const input = effect.input !== null && typeof effect.input === "object" && !Array.isArray(effect.input) ? effect.input as JsonObject : invalid("effect.input", "must be an object");
    let encoded: string;
    try { encoded = canonicalJson(input); } catch { return invalid("effect.input", "must be plain JSON"); }
    if (Buffer.byteLength(encoded) > EFFECT_INPUT_BYTES) invalid("effect.input", `must be at most ${EFFECT_INPUT_BYTES} bytes`);
    // What the bridge runs is what was judged: the policy, the protected-branch check and an approval see the tool name and its arguments, so the worker may not name another bridge or other input
    // (a call judged as one tool must not run a different kind's bridge, and arguments naming one branch must not push another).
    const tool = (request as { tool?: unknown }).tool;
    if (tool === null || typeof tool !== "object" || (tool as { name?: unknown }).name !== kind) invalid("effect.kind", "must be the name of the tool the call is made with");
    const args = (request as { args?: unknown }).args;
    let argsEncoded: string | undefined;
    try { argsEncoded = args !== null && typeof args === "object" && !Array.isArray(args) ? canonicalJson(args as JsonObject) : undefined; } catch { argsEncoded = undefined; }
    if (argsEncoded !== encoded) invalid("effect.input", "must be the call's arguments");
    const b = await this.#running(host, sessionId, attemptId, placement);
    this.#needsConfirmation(b, "any tool call");
    const bridges = this.#deps.bridges;
    // Own properties only: a kind such as "constructor" is no bridge.
    const bridge = bridges !== undefined && Object.hasOwn(bridges, kind) ? bridges[kind] : undefined;
    if (bridge === undefined) throw new DomainError("invalid_command", `the controller has no bridge for effect kind ${kind}; nothing was recorded or done`, { field: "effect.kind" });
    return (await this.#deps.dispatch.gateway(b.attemptId)).call(request, { kind: "effect", effectKind: kind, target, input, bridge });
  }

  /**
   * A remote worker's tool bridge request (card L05e): what its tool extension asked the machine's bridge, carried to the controller's own bridge. The session, the attempt, the placement and the host are checked like every message
   * about an attempt (another host's attempt, a stale placement or session is `fenced`, an unknown attempt `not_found`); the worker has confirmed its dispatch contract; then the task credential and the request go to the tool execution
   * service bound to THIS attempt, which judges the credential against the attempt, the generation against the task's current one and the call against the generation that recorded it, and admits a write as an effect of that generation
   * on the ledger. Asking again with the same call ID is the same request: copies that overlap share one answer, and a repeat is answered from the ledger (a parked call is asked again to go on) and never runs twice. A refusal by the bridge is
   * an answer (`ok: false` with a code), as for a local worker. The credential is never logged, kept or put in an error.
   */
  async toolBridge(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, token: unknown, request: unknown): Promise<ToolBridgeAnswer> {
    if (typeof token !== "string" || token.length < 1 || token.length > REMOTE_LIMITS.toolTokenChars) invalid("credential", `must be the task credential (1 to ${REMOTE_LIMITS.toolTokenChars} characters)`);
    if (request === null || typeof request !== "object" || Array.isArray(request)) invalid("request", "must be a bridge request");
    const r = request as { op?: unknown; callId?: unknown; args?: unknown };
    onlyKnown(r as object, ["op", "callId", "args"]);
    if (typeof r.op !== "string" || r.op.length < 1 || r.op.length > 40) invalid("request.op", "must be an operation name of 1 to 40 characters");
    if (typeof r.callId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(r.callId)) invalid("request.callId", "must be 1 to 120 letters, digits or . _ : -");
    if (r.args !== undefined && (r.args === null || typeof r.args !== "object" || Array.isArray(r.args))) invalid("request.args", "must be an object");
    const b = await this.#running(host, sessionId, attemptId, placement);
    this.#needsConfirmation(b, "any tool request");
    const bridge = this.#deps.toolBridge;
    if (bridge === undefined) return { ok: false, code: "unavailable", message: "the tool bridge is not available on this controller" };
    const callId = r.callId as string;
    // The credential is part of what makes two copies the same request (a digest, never the credential itself): a copy with another credential is judged by the bridge on its own and never handed the answer of a copy whose credential was accepted.
    const key = `${b.attemptId}\0${callId}\0${b.placement}\0${createHash("sha256").update(token as string).digest("hex")}`;
    let canonical: string;
    try { canonical = canonicalJson({ op: r.op as string, args: (r.args ?? {}) as JsonObject }); } catch { return invalid("request.args", "must be plain JSON"); }
    const gateway = await this.#deps.dispatch.gateway(b.attemptId);
    // From here to the entry being kept nothing is awaited, so copies of one request that overlap cannot both pass the check.
    const open = this.#bridging.get(key);
    if (open !== undefined) {
      // Copies of one request that overlap (a retry after a timeout) share the first one's answer; the same call ID with other content is not the same request.
      if (open.request !== canonical) return { ok: false, code: "invalid_command", message: `callId: ${callId.slice(0, 40)} was already used in this attempt for a different request; use a new call ID` };
      return await open.answer;
    }
    const answer = bridge.handle(token as string, { attemptId: b.attemptId, call: gateway.call.bind(gateway) }, { op: r.op as string, callId, ...(r.args === undefined ? {} : { args: r.args as JsonObject }) });
    this.#bridging.set(key, { request: canonical, answer });
    while (this.#bridging.size > 256) this.#bridging.delete(this.#bridging.keys().next().value as string);
    try { return await answer; } finally { if (this.#bridging.get(key)?.answer === answer) this.#bridging.delete(key); }
  }

  /**
   * The model's thinking a remote host's process reported for one of its attempts (card U09c), the counterpart of what a local host tells the thinking store. The session, host, placement and dispatch contract are checked like every message about
   * an attempt (another host's attempt is `not_found` with the security signal, a stale placement or session `fenced`). The shape is strict (1 to 50 blocks, each with exactly the channel's six fields, text at most 8000 characters, no unknown or
   * prototype members); the text is untrusted and goes unread to the thinking store, which cleans, redacts, bounds and dedups it and keeps it only while the attempt is still the task's current one at the placement's generation. Like the
   * local path, an attempt may send 2000 messages and have 2 in the controller at once; past that a message is answered `limit` and dropped. A message that fails is an error that names a field, never a block's text. The answer says how many
   * blocks were kept, never what they said.
   */
  async thinking(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, blocks: unknown): Promise<ThinkingAnswer> {
    if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > REMOTE_LIMITS.thinkingBlocks) invalid("blocks", `must be 1 to ${REMOTE_LIMITS.thinkingBlocks} blocks`);
    const whole = (v: unknown, field: string): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000 ? v : invalid(field, "must be a whole number"));
    const short = (v: unknown, field: string, max: number): string => (typeof v === "string" && v.length >= 1 && v.length <= max ? v : invalid(field, `must be text of 1 to ${max} characters`));
    const wire: ThinkingWire[] = (blocks as unknown[]).map((b, i) => {
      if (b === null || typeof b !== "object" || Array.isArray(b)) return invalid(`blocks[${i}]`, "each block is an object");
      onlyKnown(b as object, ["entryId", "block", "provider", "model", "text", "opaque"]);
      const r = b as Record<string, unknown>;
      if (typeof r["opaque"] !== "boolean") invalid("opaque", "must be true or false");
      if (typeof r["text"] !== "string" || (r["text"] as string).length > REMOTE_LIMITS.thinkingChars) invalid("text", `must be text of at most ${REMOTE_LIMITS.thinkingChars} characters`);
      return { entryId: whole(r["entryId"], "entryId"), block: whole(r["block"], "block"), provider: short(r["provider"], "provider", 80), model: short(r["model"], "model", 200), text: r["text"] as string, opaque: r["opaque"] as boolean };
    });
    const b = await this.#running(host, sessionId, attemptId, placement);
    this.#needsConfirmation(b, "any thinking report");
    const keep = this.#deps.thinking;
    if (keep === undefined) return { kept: 0, reason: "unavailable" };
    // The budget is the placement's, as a local process's is the process's: a move or restart (a new placement) starts again, so what one holding spent (a hostile host's included) is not taken from the next.
    let flow = this.#thinkingFlow.get(b.attemptId);
    if (flow === undefined || flow.placement !== b.placement) { flow = { placement: b.placement, messages: 0, open: 0 }; this.#thinkingFlow.delete(b.attemptId); this.#thinkingFlow.set(b.attemptId, flow); while (this.#thinkingFlow.size > 256) this.#thinkingFlow.delete(this.#thinkingFlow.keys().next().value as string); }
    if (flow.open >= REMOTE_LIMITS.thinkingInFlight || flow.messages >= (this.#deps.thinkingMessages ?? REMOTE_LIMITS.thinkingMessages)) return { kept: 0, reason: "limit" };
    flow.messages++; flow.open++;
    try { return await keep({ attemptId: b.attemptId, taskId: b.taskId, projectId: b.projectId, agentId: b.agentId, generation: b.generation }, wire); } finally { flow.open--; }
  }

  async report(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, operationId: string, outcome: Parameters<ToolGateway["report"]>[1]): Promise<ToolResult> {
    if (typeof operationId !== "string") invalid("operationId", "must be an operation ID");
    return (await this.#gateway(host, sessionId, attemptId, placement, "any report")).report(operationId, outcome);
  }

  /**
   * A remote worker is about to send a model request (card L05c): a generation is begun under the task's current context revision and the attempt's fence, exactly as for a local worker's call. The answer is one of
   * `{ recorded: false }` (not recorded: the owner's setting, a task the generation service does not know), `{ refused }` (no generation may begin: the task is held, waiting for a decision, fenced, done; the worker must not send
   * the request) or `{ streamId, amend?, heldBufferBytes? }`.
   */
  async streamStart(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, call: { readonly requestChars?: unknown; readonly requestDigest?: unknown }, requestKey: string): Promise<{ readonly recorded: false } | { readonly refused: string } | { readonly streamId: string; readonly amend?: string; readonly heldBufferBytes?: number }> {
    if (call === null || typeof call !== "object" || Array.isArray(call)) invalid("call", "must be an object");
    onlyKnown(call, ["requestChars", "requestDigest"]);
    if (typeof call.requestChars !== "number" || !Number.isSafeInteger(call.requestChars) || call.requestChars < 0) invalid("call.requestChars", "must be a whole number");
    if (call.requestDigest !== undefined && (typeof call.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(call.requestDigest))) invalid("call.requestDigest", "must be a SHA-256 digest in hexadecimal");
    const b = await this.#running(host, sessionId, attemptId, placement);
    this.#needsConfirmation(b, "any model call");
    const again = this.#starts.get(`${b.attemptId}\0${requestKey}`);
    if (again !== undefined) return await again;
    // The promise is kept before it is awaited, so a copy of the request that overlaps the first (a retry after a timeout) gets the same answer and no second generation begins.
    const key = `${b.attemptId}\0${requestKey}`;
    const answer = this.#streamStart(host, b, call as { requestChars: number; requestDigest?: string });
    this.#starts.set(key, answer);
    while (this.#starts.size > 256) this.#starts.delete(this.#starts.keys().next().value as string);
    try { return await answer; } catch (error) { this.#starts.delete(key); throw error; }
  }

  async #streamStart(host: Principal, b: PlacementBody, call: { requestChars: number; requestDigest?: string }): Promise<Awaited<ReturnType<RemoteWorkerService["streamStart"]>>> {
    if (this.#deps.streams === undefined) return { recorded: false };
    let tap = this.#taps.get(b.attemptId);
    if (tap === undefined) {
      tap = this.#deps.streams({ attemptId: b.attemptId, taskId: b.taskId, generation: b.generation });
      this.#taps.set(b.attemptId, tap);
      while (this.#taps.size > 256) this.#taps.delete(this.#taps.keys().next().value as string);
    }
    // At most 4 calls of an attempt are open: the oldest is ended as failed (its partial tool calls are dropped for good).
    const open = [...this.#calls.entries()].filter(([, c]) => c.attemptId === b.attemptId);
    for (const [id, c] of open.slice(0, Math.max(0, open.length - 3))) { this.#calls.delete(id); this.#abandon(c); }
    let feed: ModelStreamCall | undefined;
    try { feed = await tap.started({ requestChars: call.requestChars, ...(call.requestDigest === undefined ? {} : { requestDigest: call.requestDigest }) }); } catch (error) {
      if (error instanceof ModelStreamRefused) return { refused: error.message.slice(0, REMOTE_LIMITS.text) };
      throw error;
    }
    if (feed === undefined) return { recorded: false };
    const streamId = `rs-${randomUUID()}`;
    let watch: CallMonitor | undefined;
    if (this.#deps.monitor !== undefined) {
      try {
        let monitor = this.#monitors.get(b.attemptId);
        if (monitor === undefined) { monitor = this.#deps.monitor({ attemptId: b.attemptId, taskId: b.taskId, generation: b.generation, ...(b.route === undefined ? {} : { route: b.route }), hostId: b.hostId }); this.#monitors.set(b.attemptId, monitor); while (this.#monitors.size > 256) this.#monitors.delete(this.#monitors.keys().next().value as string); }
        watch = monitor.started({ requestChars: call.requestChars });
        const w = watch;
        // The controller's waits on its own store while it records this call's reply are not the model's time (the remote counterpart of the local relay's `onWait`).
        feed.onWait = (on) => { try { w.waiting?.(on); } catch { /* the call is not affected */ } };
      } catch { watch = undefined; }
    }
    this.#calls.set(streamId, { attemptId: b.attemptId, placement: b.placement, hostId: host.id, call: feed, ...(watch === undefined ? {} : { watch }) });
    return { streamId, ...(feed.amend === undefined ? {} : { amend: feed.amend.slice(0, REMOTE_LIMITS.text) }), ...(feed.heldBufferBytes === undefined ? {} : { heldBufferBytes: feed.heldBufferBytes }) };
  }

  /** The decoded events of one piece of a reply, recorded in order. `held` says the generation was interrupted or superseded: the worker must not pass the reply on. A stale placement or session is fenced like any message. */
  async streamEvents(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, streamId: unknown, n: unknown, events: unknown): Promise<{ readonly held?: string }> {
    const entry = (await this.#openCall(host, sessionId, attemptId, placement, streamId))!;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) invalid("n", "must be a whole number from 1");
    // The same message sent again (its answer was lost) is answered again and recorded once; the next must follow it.
    const checked = checkStreamEvents(events);
    const digest = sha256(canonicalJson(checked as unknown as JsonObject[] as never));
    if (entry.last !== undefined && n === entry.last.n) {
      if (entry.last.digest !== digest) invalid("n", `message ${n} of this call was already received with other events`);
      return await entry.last.answer;
    }
    if (n !== (entry.last?.n ?? 0) + 1) invalid("n", `must be ${(entry.last?.n ?? 0) + 1}, the next message of this call`);
    // Kept before it is awaited: a copy that overlaps the first gets the first's answer and is recorded once.
    const previous = entry.last;
    if (entry.watch !== undefined) {
      // The first output, then (at most once in `monitorProgressMs`) how much has arrived: a reply that keeps streaming is not silent (review of card L05d; the local relay reports the same every 15 s).
      const chars = checked.reduce((sum, e) => sum + (e.kind === "text" ? e.text.length : e.kind === "tool" ? e.argumentsDelta.length + 1 : 0), 0);
      if (chars > 0) {
        entry.outputChars = (entry.outputChars ?? 0) + chars;
        const now = Date.now();
        try {
          if (entry.seenOutput !== true) { entry.seenOutput = true; entry.progressAt = now; entry.watch.firstOutput(); }
          else if (now - (entry.progressAt ?? 0) >= (this.#deps.monitorProgressMs ?? 15_000)) { entry.progressAt = now; entry.watch.progress(entry.outputChars); }
        } catch { /* the call is not affected */ }
      }
    }
    const answer = entry.call.events(checked);
    entry.last = { n: n as number, digest, answer };
    try { return await answer; } catch (error) { entry.last = previous; throw error; }
  }

  /** The reply ended (`ok`) or failed or was cancelled part way. The generation is completed; a half-written tool call is dropped for good. */
  async streamEnd(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, streamId: unknown, outcome: { readonly ok?: unknown }): Promise<void> {
    if (outcome === null || typeof outcome !== "object" || typeof outcome.ok !== "boolean") invalid("ok", "must be true or false");
    // A call that already ended (the same message sent again) is not an error.
    const entry = await this.#openCall(host, sessionId, attemptId, placement, streamId, true);
    if (entry === undefined) return;
    this.#calls.delete(streamId as string);
    try { entry.watch?.finished({ ok: outcome.ok as boolean }); } catch { /* ignored */ }
    await entry.call.ended({ ok: outcome.ok as boolean });
  }

  /** A call that is ended as failed by the controller (an attempt that ended or moved, the oldest of too many, a closing service): its generation is completed and stall detection is told. */
  #abandon(c: { readonly call: ModelStreamCall; readonly watch?: CallMonitor | undefined }): void {
    try { c.watch?.finished({ ok: false }); } catch { /* ignored */ }
    void c.call.ended({ ok: false }).catch(() => undefined);
  }

  async #openCall(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, streamId: unknown, tolerateClosed?: true): Promise<{ readonly call: ModelStreamCall; readonly watch?: CallMonitor | undefined; seenOutput?: boolean; outputChars?: number; progressAt?: number; last?: LastMessage | undefined } | undefined> {
    const b = await this.#running(host, sessionId, attemptId, placement);
    const entry = typeof streamId === "string" ? this.#calls.get(streamId) : undefined;
    if (entry === undefined && tolerateClosed === true && typeof streamId === "string" && /^rs-[0-9a-f-]{36}$/.test(streamId)) return undefined;
    if (entry === undefined || entry.attemptId !== b.attemptId || entry.hostId !== host.id) throw new DomainError("not_found", "no such model call is open for this attempt");
    if (entry.placement !== b.placement) { this.#calls.delete(streamId as string); this.#abandon(entry); throw new DomainError("fenced", `the model call belongs to placement ${entry.placement}, not ${b.placement}`); }
    return entry;
  }

  async usage(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, usage: TurnUsage, requestKey?: string): Promise<void> {
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) invalid("usage", "must be an object");
    // Usage is booked before the confirmation too (the spend happened and the budget must see it); it does not count as a confirmation of anything.
    await (await this.#gateway(host, sessionId, attemptId, placement)).usage(usage, requestKey);
  }

  /** Extends the attempt's lease. A worker in a partition that cannot send this loses the attempt when the lease ends. */
  async attemptHeartbeat(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown): Promise<{ until: string; leaseMs?: number }> {
    const b = await this.#running(host, sessionId, attemptId, placement);
    await this.#heartbeatAllowed(b);
    return this.#deps.dispatch.gateway(b.attemptId).heartbeat();
  }

  /**
   * The worker reports the processes it holds for its placement (card L02e): what its sandbox lists for the attempt (running, asked to stop and not stopped, or unknown), and with `final` that it has stopped the sandbox and looked again. Stop reads it
   * (`RemoteWorkerHost.localWork`). The same fences as every message about the attempt: the host's session, the host that holds the placement and its number (an older holder or placement is `fenced`), the worker session that accepted it. Unlike
   * a tool call it is taken after the attempt ended or expired too, since a worker's last word is exactly "I stopped it": only a placement that was never accepted, or that moved on, is refused. `seq` must rise: an older report changes nothing
   * (`kept: false`), the same report again is the same answer, another report under a sequence already used is `payload_changed`, and nothing follows a final report of a placement. Entries are checked one by one and their references redacted and cut.
   */
  async reportProcesses(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, report: { readonly seq: unknown; readonly final: unknown; readonly processes: unknown }): Promise<{ readonly kept: boolean }> {
    const session = await this.#session(host, sessionId);
    const id = attemptIdOf(attemptId);
    const found = (await this.#runner.get(PLACEMENT_KIND, id))?.body as unknown as PlacementBody | undefined;
    this.#holds(host, found, placement);
    if (found.sessionId === undefined) throw new DomainError("fenced", `attempt ${id} was never accepted by this worker`);
    if (found.sessionId !== session.sessionId) throw new DomainError("fenced", "the attempt was taken up in another session; accept it again", { field: "session" });
    if (!["accepted", "completed", "ended"].includes(found.state)) throw new DomainError("fenced", `the placement of attempt ${id} is ${found.state}`);
    const checked = checkProcessReport(report);
    const sameAs = (x: NonNullable<PlacementBody["processReport"]>): boolean => canonicalJson({ final: x.final, processes: x.processes } as unknown as JsonObject) === canonicalJson({ final: checked.final, processes: checked.processes } as unknown as JsonObject);
    const decide = (x: PlacementBody): "keep" | "same" | "old" | "final" => {
      const had = x.processReport;
      // A sequence belongs to the worker session that sent it (review of L02e): a worker program that restarted and took the attempt up again in a new session counts from 1, and its reports are the newest word.
      if (had === undefined || had.placement !== x.placement || had.sessionId !== x.sessionId) return "keep";
      if (checked.seq === had.seq) { if (!sameAs(had)) throw new DomainError("payload_changed", `report ${checked.seq} of attempt ${id} was already given with other figures`, { field: "seq" }); return "same"; }
      if (checked.seq < had.seq) return "old";
      return had.final ? "final" : "keep";
    };
    const first = decide(found);
    if (first !== "keep") return { kept: first === "same" };
    let verdict: "keep" | "same" | "old" | "final" = "keep";
    await this.#changePlacement(id, async (current) => {
      const x = current?.body;
      if (x === undefined || x.hostId !== host.id || x.placement !== found.placement || x.sessionId !== found.sessionId) throw new DomainError("fenced", `the placement of attempt ${id} changed`);
      verdict = decide(x);
      if (verdict !== "keep") return undefined;
      return { next: { ...x, processReport: { placement: x.placement, ...(x.sessionId === undefined ? {} : { sessionId: x.sessionId }), seq: checked.seq, at: this.#runner.now(), final: checked.final, processes: checked.processes } } };
    }, "processes", { actor: host.id });
    return { kept: verdict === "keep" || verdict === "same" };
  }

  async acknowledgeDecisions(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown): Promise<void> {
    await (await this.#gateway(host, sessionId, attemptId, placement)).acknowledgeDecisions();
  }

  /**
   * The worker confirms the dispatch contract of its placement and says how far it enforces each limit (card H12a). Only the digest this placement was given is accepted; the figures must cover every limit the
   * contract names, and a limit not enforced in full is accepted only when the owner allowed best effort (otherwise the controller itself ends the run, whatever the worker meant to do). The launch is
   * recorded for the owner before the confirmation counts, so nothing runs unrecorded. The same confirmation again is the same answer.
   */
  async launched(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, command: { readonly digest: unknown; readonly enforcement: unknown }): Promise<{ readonly confirmed: boolean; readonly reasons?: readonly string[] }> {
    const b = await this.#running(host, sessionId, attemptId, placement);
    const c = b.contract;
    if (c === undefined) throw new DomainError("invalid_command", `attempt ${b.attemptId} was placed with no dispatch contract`, { field: "contract" });
    if (typeof command.digest !== "string" || command.digest !== c.digest) throw new DomainError("fenced", `the contract digest is not the one placement ${b.placement} of attempt ${b.attemptId} was given`, { field: "digest" });
    const reported = checkEnforcement(command.enforcement);
    if (c.launched !== undefined) {
      if (canonicalJson(c.launched.enforcement as unknown as JsonObject) === canonicalJson(reported as unknown as JsonObject)) {
        // A confirmation that was kept but whose launch record failed is finished by this retry.
        if (c.launched.recordPending === true) await this.#writeLaunchRecord(b, host, "started");
        return { confirmed: true };
      }
      throw new DomainError("fenced", `attempt ${b.attemptId} already confirmed its contract with other figures`);
    }
    const limits = (c.limits ?? {}) as Record<string, number>;
    const reasons: string[] = [];
    for (const name of Object.keys(limits)) {
      const got = reported.find((e) => e.limit === name);
      if (got === undefined) reasons.push(`the confirmation says nothing of the limit ${name}`);
      else if (got.value !== limits[name]) reasons.push(`the limit ${name} was confirmed at ${got.value}, the contract says ${String(limits[name])}`);
      else if (got.enforced !== "full" && !c.bestEffort) reasons.push(`the limit ${name} is enforced ${got.enforced === "none" ? "not at all" : "only in part"} and best effort is not allowed`);
    }
    for (const e of reported) if (!Object.hasOwn(limits, e.limit)) reasons.push(`the confirmation names the limit ${e.limit}, which the contract does not set`);
    const wallTimeMs = limits["wallTimeMs"] ?? 0;
    const record = (outcome: "started" | "refused", why?: string): Promise<void> | undefined => this.#recordFor(b, host, reported, outcome, why);
    if (reasons.length > 0) {
      await record("refused", reasons.join("; ").slice(0, 300));
      await this.#end(b, host, reasons);
      return { confirmed: false, reasons };
    }
    // The launch is recorded for the owner only after the confirmation is on the placement (a confirmation that is fenced meanwhile is recorded as refused, not as started).
    let done: { readonly body: PlacementBody; readonly previous: PlacementBody | undefined };
    try {
      done = await this.#changePlacement(b.attemptId, async (current) => {
        const x = current?.body;
        if (x === undefined || x.hostId !== host.id || x.placement !== b.placement || x.state !== "accepted" || x.contract?.digest !== c.digest) throw new DomainError("fenced", `the placement of attempt ${b.attemptId} changed`);
        if (x.contract.launched !== undefined) return undefined;
        return { next: { ...x, contract: { ...x.contract, launched: { at: this.#runner.now(), sessionId: x.sessionId ?? "", enforcement: reported, recordPending: true as const } } } };
      }, "launched", { actor: host.id });
    } catch (error) {
      if (isDomainError(error, "fenced")) await record("refused", "the placement changed before the confirmation could be kept");
      throw error;
    }
    if (done.previous?.contract?.launched === undefined) await this.#writeLaunchRecord(b, host, "started", record);
    return { confirmed: true };
  }

  #recordFor(b: PlacementBody, host: Principal, reported: readonly ContractEnforcement[], outcome: "started" | "refused", why?: string): Promise<void> | undefined {
    const c = b.contract!;
    const limits = (c.limits ?? {}) as Record<string, number>;
    const wallTimeMs = limits["wallTimeMs"] ?? 0;
    return this.#deps.recordLaunch?.({
      attemptId: b.attemptId, agentId: b.agentId, outcome, requested: limits as JsonObject, bestEffort: c.bestEffort, enforcement: reported.map((e) => ({ limit: e.limit, value: e.value, enforced: e.enforced, by: host.id, detail: e.detail ?? "" })), wallTimeMs,
      ...(outcome === "refused" ? { failed: reported.filter((e) => e.enforced !== "full").map((e) => ({ limit: e.limit, enforced: e.enforced === "partial" ? "partial" as const : "none" as const, detail: e.detail ?? "" })), reason: why ?? "" } : {}),
    });
  }

  /** Writes the owner's launch record for a kept confirmation, then clears the pending mark (a failure leaves the mark so the worker's retry writes the record). */
  async #writeLaunchRecord(b: PlacementBody, host: Principal, outcome: "started", record?: (o: "started" | "refused", why?: string) => Promise<void> | undefined): Promise<void> {
    const fresh = (await this.#runner.get(PLACEMENT_KIND, b.attemptId))?.body as unknown as PlacementBody | undefined;
    const reported = (fresh?.contract?.launched?.enforcement ?? b.contract?.launched?.enforcement ?? []) as readonly ContractEnforcement[];
    await (record === undefined ? this.#recordFor(fresh ?? b, host, reported, outcome) : record(outcome));
    await this.#changePlacement(b.attemptId, async (current) => {
      const x = current?.body;
      if (x === undefined || x.contract?.launched === undefined || x.contract.launched.recordPending !== true || x.contract.digest !== b.contract?.digest) return undefined;
      const { recordPending: _r, ...launched } = x.contract.launched; void _r;
      return { next: { ...x, contract: { ...x.contract, launched } } };
    }, "launched-recorded", { actor: host.id });
  }

  /** The worker cannot honour the contract it was given: the order is refused with its reasons, the run ends failed and the dispatcher ends the attempt without starting another (card H12a). */
  async refuseOrder(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, command: { readonly digest: unknown; readonly reasons: unknown }): Promise<void> {
    const b = await this.#running(host, sessionId, attemptId, placement, ["accepted", "completed"]);
    if (b.contract === undefined) throw new DomainError("invalid_command", `attempt ${b.attemptId} was placed with no dispatch contract`, { field: "contract" });
    // A worker that saw another order than the controller sealed (a tampered one) can only refuse it with a digest that does not match: the placement number already fenced stale messages, so this refusal
    // ends the attempt as failed all the same, and says why, rather than leaving the run accepted.
    const mismatch = typeof command.digest !== "string" || command.digest !== b.contract.digest;
    const given: unknown = command.reasons;
    if (!Array.isArray(given) || given.length === 0 || given.length > 10) return invalid("reasons", "must be a short list of reasons");
    const reasons = (given as unknown[]).map((r, i) => redactText(text(r, `reasons[${i}]`, { min: 1, max: 300 })).slice(0, 300));
    if (mismatch) reasons.unshift("the order the worker saw does not match the contract the controller sealed (digest)");
    // A confirmed contract cannot be refused afterwards: the worker already ran under it.
    if (b.contract.launched !== undefined) throw new DomainError("invalid_transition", `attempt ${b.attemptId} already confirmed its contract`, { field: "contract" });
    if (b.state === "completed") return;
    // The owner's launch record says the order was refused, and why.
    await this.#deps.recordLaunch?.({ attemptId: b.attemptId, agentId: b.agentId, outcome: "refused", requested: (b.contract.limits ?? {}) as JsonObject, bestEffort: b.contract.bestEffort, enforcement: [], wallTimeMs: Number((b.contract.limits as Record<string, unknown> | undefined)?.["wallTimeMs"] ?? 0), reason: reasons.join("; ").slice(0, 300) });
    await this.#end(b, host, reasons);
  }

  /** Ends the run as failed because of the contract. Idempotent per placement. */
  async #end(b: PlacementBody, host: Principal, reasons: readonly string[]): Promise<void> {
    const result: StoredResult = { status: "failed", error: `the worker refused the dispatch contract: ${reasons.join("; ")}`.slice(0, REMOTE_LIMITS.text) };
    const done = await this.#changePlacement(b.attemptId, async (current) => {
      const x = current?.body;
      if (x === undefined || x.hostId !== host.id || x.placement !== b.placement) throw new DomainError("fenced", `the placement of attempt ${b.attemptId} changed`);
      if (x.state === "completed") return undefined;
      if (x.state !== "accepted") throw new DomainError("fenced", `the placement of attempt ${b.attemptId} is ${x.state}`);
      return { next: { ...x, state: "completed", result, ...(x.contract === undefined ? {} : { contract: { ...x.contract, refused: reasons } }) }, extra: await this.#releaseStore(x) };
    }, "refuse", { actor: host.id });
    this.#wake(b.attemptId, done.body.placement, "", done.body.result);
  }

  /** The turn is over: the result is recorded on the placement (the checkpoint, if any, as an artifact) and whoever waits for it (`waitForResult`) is given it. */
  async complete(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, command: NoActor & { result: WorkerTurnResult }): Promise<StoredResult> {
    const b = await this.#running(host, sessionId, attemptId, placement, ["accepted", "completed"]);
    onlyKnown(command, ["commandId", "result"]);
    checkCommandId(command.commandId);
    const result = checkResult(command.result);
    // A completed turn needs a confirmed contract; a failed or cancelled one (the worker giving up) does not.
    if (b.state !== "completed" && result.status === "completed") this.#needsConfirmation(b, "completing a turn");
    // The answer to a result that was recorded but whose reply was lost: the same result again is the same answer.
    if (b.state === "completed") {
      if (canonicalJson(b.result as unknown as JsonObject) === canonicalJson(result as unknown as JsonObject)) return b.result!;
      throw new DomainError("fenced", `attempt ${b.attemptId} already reported a different result`);
    }
    if (command.result.checkpoint !== undefined) await this.#storeCheckpoint(b, { hostPrincipal: host.id, commandId: command.commandId, sequence: undefined, checkpoint: command.result.checkpoint, fixedId: `ckpt-done:${b.attemptId}:${b.placement}:${String(command.commandId).slice(0, 40)}`.slice(0, 120) });
    const done = await this.#changePlacement(b.attemptId, async (current) => {
      const x = current?.body;
      if (x === undefined || x.hostId !== host.id || x.placement !== b.placement || x.state !== "accepted") throw new DomainError("fenced", `the placement of attempt ${b.attemptId} changed`);
      return { next: { ...x, state: "completed", result }, extra: await this.#releaseStore(x) };
    }, "complete", { actor: host.id });
    this.#wake(b.attemptId, done.body.placement, "", result);
    return result;
  }

  /** The control messages after `after`. */
  async pollControl(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, after: number): Promise<SequencedControl[]> {
    const b = await this.#running(host, sessionId, attemptId, placement);
    if (!Number.isSafeInteger(after) || after < 0) invalid("after", "must be a whole number");
    return b.control.filter((m) => m.seq > after);
  }

  // ---- checkpoints ---------------------------------------------------------------------------------------------------------------

  /**
   * Stores a checkpoint the worker sends, as an artifact (so it is content-addressed and verified on every read). `sequence` must be higher than the last stored one: a delayed older checkpoint is refused
   * and cannot replace a newer one.
   */
  async putCheckpoint(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, command: NoActor & { sequence: number; checkpoint: JsonObject }): Promise<{ sequence: number; artifactId: string; digest: string }> {
    const b = await this.#running(host, sessionId, attemptId, placement);
    this.#needsConfirmation(b, "any checkpoint");
    onlyKnown(command, ["commandId", "sequence", "checkpoint"]);
    checkCommandId(command.commandId);
    if (typeof command.sequence !== "number" || !Number.isSafeInteger(command.sequence) || command.sequence < 1) invalid("sequence", "must be a whole number of at least 1");
    return this.#storeCheckpoint(b, { hostPrincipal: host.id, commandId: command.commandId, sequence: command.sequence, checkpoint: command.checkpoint });
  }

  async #storeCheckpoint(b: PlacementBody, c: { hostPrincipal: string; commandId: unknown; sequence: number | undefined; checkpoint: JsonObject; fixedId?: string; allowEnded?: boolean }): Promise<{ sequence: number; artifactId: string; digest: string }> {
    if (c.checkpoint === null || typeof c.checkpoint !== "object" || Array.isArray(c.checkpoint)) invalid("checkpoint", "must be a JSON object");
    const bytes = Buffer.from(canonicalJson(c.checkpoint), "utf8");
    if (bytes.byteLength > REMOTE_LIMITS.checkpointBytes) invalid("checkpoint", `must be at most ${REMOTE_LIMITS.checkpointBytes} bytes`);
    if (b.checkpoints >= REMOTE_LIMITS.checkpoints) throw new DomainError("unavailable", `attempt ${b.attemptId} has stored ${REMOTE_LIMITS.checkpoints} checkpoints, the most it may`);
    const sequence = c.sequence ?? (b.checkpoint?.sequence ?? 0) + 1;
    const commandId = c.fixedId ?? `ckpt:${b.attemptId}:${b.placement}:${sequence}:${String(c.commandId).slice(0, 40)}`.slice(0, 120);
    // A message stored before (its answer was lost, or a later step failed and is being repeated) is that same checkpoint, whatever number the next one would have.
    if (c.fixedId !== undefined && b.checkpoint !== undefined && b.checkpoint.artifactId === derivedId("art", commandId)) return { sequence: b.checkpoint.sequence, artifactId: b.checkpoint.artifactId, digest: b.checkpoint.digest };
    if (b.checkpoint !== undefined && sequence <= b.checkpoint.sequence) {
      // The same message again (its answer was lost) is the same checkpoint; an older or different one is not.
      if (sequence === b.checkpoint.sequence && b.checkpoint.artifactId === derivedId("art", commandId)) return { sequence, artifactId: b.checkpoint.artifactId, digest: b.checkpoint.digest };
      throw new DomainError("stale_revision", `checkpoint ${sequence} is not after the last stored one (${b.checkpoint.sequence})`, { field: "sequence" });
    }
    const published = await this.#deps.artifacts.publish({
      commandId, actor: c.hostPrincipal, name: `checkpoint ${sequence} of ${b.attemptId}`.slice(0, 120), projectId: b.projectId, taskId: b.taskId,
      files: [{ path: "checkpoint.json", content: bytes }],
    });
    const artifact = (await this.#deps.artifacts.get(published.id))!;
    const digest = artifact.entries[0]!.digest;
    await this.#changePlacement(b.attemptId, async (current) => {
      const x = current?.body;
      if (x === undefined || x.hostId !== b.hostId || x.placement !== b.placement || (c.allowEnded !== true && !LIVE.has(x.state))) throw new DomainError("fenced", `the placement of attempt ${b.attemptId} changed`);
      if (x.checkpoint !== undefined && x.checkpoint.sequence >= sequence) {
        if (x.checkpoint.artifactId === published.id) return undefined;
        throw new DomainError("stale_revision", `checkpoint ${sequence} is not after the last stored one (${x.checkpoint.sequence})`, { field: "sequence" });
      }
      return { next: { ...x, checkpoint: { artifactId: published.id, sequence, digest, at: this.#runner.now() }, checkpoints: x.checkpoints + 1 } };
    }, "checkpoint", { actor: c.hostPrincipal });
    return { sequence, artifactId: published.id, digest };
  }

  /** The latest checkpoint stored for the attempt, read back verified (a missing or altered blob is an `integrity` error). Owner or dispatcher only. */
  async latestCheckpoint(by: Principal, attemptId: string): Promise<{ checkpoint: JsonObject; artifactId: string; sequence: number; digest: string } | undefined> {
    this.#staff(by);
    const b = (await this.#runner.get(PLACEMENT_KIND, attemptIdOf(attemptId)))?.body as unknown as PlacementBody | undefined;
    return b?.checkpoint === undefined ? undefined : { ...(await this.#readCheckpoint(b.checkpoint)), artifactId: b.checkpoint.artifactId, sequence: b.checkpoint.sequence, digest: b.checkpoint.digest };
  }

  /** A stored file that no longer hashes to its record (card U11d, A08): told to the detectors, then refused as before. The key is the artifact only (no path, no content). */
  #damaged(artifactId: string, error: unknown): never {
    if (error instanceof DomainError && error.code === "integrity") { try { this.#deps.detect?.("artifact-store", { kind: "integrity-check-failed", key: `artifact:${artifactId.slice(0, 80)}` }); } catch { /* telling never changes the refusal */ } }
    throw error;
  }

  async #readCheckpoint(c: NonNullable<PlacementBody["checkpoint"]>): Promise<{ checkpoint: JsonObject }> {
    const bytes = await this.#deps.artifacts.readFile(c.artifactId, "checkpoint.json", { maxBytes: REMOTE_LIMITS.checkpointBytes }).catch((error: unknown) => this.#damaged(c.artifactId, error));
    return { checkpoint: JSON.parse(Buffer.from(bytes).toString("utf8")) as JsonObject };
  }

  // ---- artifacts -----------------------------------------------------------------------------------------------------------------

  #readable(b: PlacementBody): { id: string; role: ArtifactListing["role"] }[] {
    return [...b.inputs.map((id) => ({ id, role: "input" as const })), ...b.outputs.map((id) => ({ id, role: "output" as const })), ...(b.checkpoint === undefined ? [] : [{ id: b.checkpoint.artifactId, role: "checkpoint" as const }])];
  }

  /** The artifacts this placement may fetch: the inputs it was given, what it published and its latest checkpoint. */
  async listArtifacts(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown): Promise<ArtifactListing[]> {
    const b = await this.#running(host, sessionId, attemptId, placement, ["offered", "accepted"]);
    const out: ArtifactListing[] = [];
    for (const { id, role } of this.#readable(b)) {
      const a = await this.#deps.artifacts.get(id);
      if (a === undefined) throw new DomainError("integrity", "an artifact of the placement is missing");
      out.push({ id, name: a.name, role, manifestDigest: a.manifestDigest, files: a.entries.map((e) => ({ path: e.path, size: e.size, digest: e.digest })) });
    }
    return out;
  }

  /** One file of one artifact of the placement, read back verified against its recorded hash and size. An artifact the placement was not given reads as missing. */
  async fetchFile(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, artifactId: string, path: string): Promise<{ bytes: Uint8Array; digest: string; size: number }> {
    const b = await this.#running(host, sessionId, attemptId, placement, ["offered", "accepted"]);
    if (!this.#readable(b).some((r) => r.id === artifactId)) throw new DomainError("not_found", "no such artifact");
    const artifact = await this.#deps.artifacts.get(artifactId);
    const entry = artifact?.entries.find((e) => e.path === path);
    if (entry === undefined) throw new DomainError("not_found", "no such file");
    if (entry.size > this.#fileBytes) throw new DomainError("invalid_command", `${path} is ${entry.size} bytes; one fetch returns at most ${this.#fileBytes}`, { field: "path" });
    const bytes = await this.#deps.artifacts.readFile(artifactId, path, { maxBytes: this.#fileBytes }).catch((error: unknown) => this.#damaged(artifactId, error));
    return { bytes, digest: entry.digest, size: entry.size };
  }

  /** The worker publishes files as an artifact of the placement's own project and task, created by the host. It joins the placement's outputs (and so travels with it if the attempt is moved). */
  async publishArtifact(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, command: NoActor & { name: string; files: readonly { path: string; content: Uint8Array }[] }): Promise<{ artifactId: string }> {
    const b = await this.#running(host, sessionId, attemptId, placement);
    this.#needsConfirmation(b, "publishing an artifact");
    onlyKnown(command, ["commandId", "name", "files"]);
    checkCommandId(command.commandId);
    if (b.outputs.length >= REMOTE_LIMITS.artifacts) throw new DomainError("unavailable", `attempt ${b.attemptId} has published ${REMOTE_LIMITS.artifacts} artifacts, the most it may`);
    const published = await this.#deps.artifacts.publish({ commandId: scopedCommandId(host.id, `pub:${b.attemptId}:${String(command.commandId)}`), actor: host.id, name: command.name, projectId: b.projectId, taskId: b.taskId, files: command.files });
    await this.#changePlacement(b.attemptId, async (current) => {
      const x = current?.body;
      if (x === undefined || x.hostId !== host.id || x.placement !== b.placement || x.state !== "accepted") throw new DomainError("fenced", `the placement of attempt ${b.attemptId} changed`);
      if (x.outputs.includes(published.id)) return undefined;
      return { next: { ...x, outputs: [...x.outputs, published.id] } };
    }, "publish", { actor: host.id });
    return { artifactId: published.id };
  }

  // ---- relocation ----------------------------------------------------------------------------------------------------------------

  /**
   * Moves an attempt to another host (owner or dispatcher). Everything that can refuse comes first and changes nothing: the target must be an active, fresh, connected host that meets the attempt's platform,
   * harness, isolation and workspace requirements and the controller's policy for credentials and data location; the native store must be this attempt's to move; the checkpoint and every artifact must
   * verify against their hashes (a missing or altered blob refuses the move). Then, in one commit, the placement number is raised (the old host is fenced from that moment), the attempt and the store go to the
   * target, and only then is the dispatcher told to restart the attempt there from the checkpoint. The old host is asked for a fresh checkpoint first; if it does not answer (a partition) the last
   * stored one is used, and the move still fences it. Repeating the command ID finishes a move that stopped half way.
   */
  async relocate(by: Principal, command: NoActor & { attemptId: string; toHostId: string; reason: string }): Promise<RelocationResult> {
    this.#staff(by);
    onlyKnown(command, ["commandId", "attemptId", "toHostId", "reason"]);
    checkCommandId(command.commandId);
    const attemptId = attemptIdOf(command.attemptId);
    const to = hostIdOf(command.toHostId, "toHostId");
    const reason = text(command.reason, "reason", { min: 1, max: 300 });
    const commandId = scopedCommandId(by.id, command.commandId);
    const read = async (): Promise<PlacementBody> => {
      const found = (await this.#runner.get(PLACEMENT_KIND, attemptId))?.body as unknown as PlacementBody | undefined;
      if (found === undefined) throw new DomainError("not_found", `attempt ${attemptId} has no remote placement`);
      return found;
    };
    const first = await read();
    // A move to this target that was committed and not yet started by the dispatcher (state `relocating`) is finished by any repeat, whatever its command ID or reason; once the target has taken the
    // attempt up, only the very command that made the move is answered again, and nothing is done a second time.
    const finishing = first.state === "relocating" && first.hostId === to;
    // A command ID that made an earlier move of this attempt is not a new move: refused before anything is disturbed.
    if (!finishing && first.lastRelocation?.commandId !== commandId && first.history.some((h) => h.commandId === commandId)) throw new DomainError("command_conflict", `command ${String(command.commandId)} was used for an earlier move of attempt ${attemptId}`);
    const answered = !finishing && first.hostId === to && first.lastRelocation?.commandId === commandId;
    let checkpoint: "fresh" | "stored" | "none" = "stored";
    let frozen = false;
    const verified = async (): Promise<{ placement: PlacementBody; restored: JsonObject | undefined; summary: RelocationResult["artifacts"] }> => {
      // Integrity of everything that travels, read from the placement as it stands now: a missing or altered blob refuses the move.
      const placement = await read();
      const travelling = [...new Set([...placement.inputs, ...placement.outputs, ...(placement.checkpoint === undefined ? [] : [placement.checkpoint.artifactId])])];
      await this.#deps.artifacts.assertResumable(travelling);
      const restored = placement.checkpoint === undefined ? undefined : (await this.#readCheckpoint(placement.checkpoint)).checkpoint;
      const summary: { id: string; manifestDigest: string; files: number; bytes: number }[] = [];
      for (const id of travelling) { const a = (await this.#deps.artifacts.get(id))!; summary.push({ id, manifestDigest: a.manifestDigest, files: a.entries.length, bytes: a.totalBytes }); }
      return { placement, restored, summary };
    };
    if (answered) {
      const { summary } = await verified();
      return { attemptId, from: first.history.at(-1)?.hostId ?? first.hostId, to, placement: first.placement, checkpoint: first.checkpoint === undefined ? "none" : "stored", artifacts: summary };
    }
    let endedParked = false;
    let done: { now: PlacementBody; restored: JsonObject | undefined; summary: RelocationResult["artifacts"]; moved: PlacementBody } | undefined;
    // The fence: one commit.
    const commit = async (): Promise<PlacementBody> => (await this.#changePlacement(attemptId, async (current) => {
      const x = current?.body;
      if (x === undefined || x.hostId !== first.hostId || x.placement !== first.placement || (!LIVE.has(x.state) && !endedParked)) throw new DomainError("fenced", `the placement of attempt ${attemptId} changed while the move was prepared`);
      const store = await this.#runner.get(STORE_KIND, x.agentId);
      const storeBody = store?.body as unknown as StoreBody | undefined;
      if (storeBody !== undefined && storeBody.ownerHostId !== x.hostId) throw new DomainError("invalid_transition", `the native Pi store of ${x.agentId} belongs to ${storeBody.ownerHostId}, not to the host the attempt runs on`);
      const at = this.#runner.now();
      const { sessionId: _s, acceptedAt: _a, result: _r, processReport: _p, ...rest } = x; void _s; void _a; void _r; void _p;
      const next: PlacementBody = {
        ...rest, hostId: to, placement: x.placement + 1, state: "relocating", relocations: x.relocations + 1, control: [], lastRelocation: { commandId, at },
        history: pushHistory(x.history, { hostId: x.hostId, placement: x.placement, at, reason: `relocated: ${reason}`, commandId }),
      };
      const storeChange: Change[] = [];
      if (store !== undefined && storeBody !== undefined) storeChange.push({ type: "update", ref: { kind: STORE_KIND, id: x.agentId }, expectedRevision: store.revision, body: { ...storeBody, ownerHostId: to, since: at, moves: storeBody.moves + 1 } as unknown as JsonObject });
      return { next, extra: storeChange };
    }, "relocate", { commandId, actor: by.id })).body;
    if (!finishing) {
      if (first.hostId === to) throw new DomainError("invalid_command", `attempt ${attemptId} is already on ${to}`, { field: "toHostId" });
      const dispatch = await this.#deps.dispatch.get(by, attemptId);
      if (dispatch === undefined || dispatch.state === "finished") throw new DomainError("invalid_transition", `attempt ${attemptId} is not live under the dispatcher`, { field: "attemptId" });
      // An attempt that parked on a host that has since gone away has an ended placement and a dispatcher record in `parked`: it can be moved too, from the checkpoint it parked with.
      endedParked = !LIVE.has(first.state) && dispatch.state === "parked";
      if (!LIVE.has(first.state) && !endedParked) throw new DomainError("invalid_transition", `the placement of attempt ${attemptId} is ${first.state}; only a live or parked attempt moves`, { field: "attemptId" });
      const reasons = await this.#judge(first, to);
      if (reasons.length > 0) throw new DomainError("invalid_transition", `attempt ${attemptId} cannot move to ${to}: ${reasons.join("; ")}`, { field: "toHostId" });
      // What is stored must verify before the old host is disturbed at all.
      await verified();
      try {
        let fresh: JsonObject | undefined;
        if (!endedParked) {
          // The old host is asked for a checkpoint with the calls settled. One that does not answer (a partition) is fenced all the same, with the last checkpoint it sent.
          // Bounded twice: the settle gives up on a call that does not stop (`strictMs`), and nothing the old host does or does not answer holds the move longer than `settleMs`.
          try { frozen = true; fresh = (await within(this.#deps.dispatch.quiesce(by, attemptId, "relocation", { strictMs: this.#settleMs }), this.#settleMs)).checkpoint; } catch { fresh = undefined; }
        }
        let cur = await read();
        if (fresh !== undefined) {
          // A worker that answers sends its checkpoint itself, so it may already be stored; otherwise it is stored after the latest one.
          if (cur.checkpoint?.digest === sha256(canonicalJson(fresh))) checkpoint = "fresh";
          else {
            for (let tries = 0; ; tries++) {
              try { await this.#storeCheckpoint(cur, { hostPrincipal: by.id, commandId: "relocation", sequence: undefined, checkpoint: fresh, fixedId: `reloc:${commandId}`.slice(0, 120) }); break; } catch (error) {
                if (!isDomainError(error, "stale_revision") || tries >= 3) throw error;
                cur = await read();
              }
            }
            checkpoint = "fresh";
          }
        } else if (cur.checkpoint === undefined && endedParked && dispatch.resumeFrom !== undefined) {
          await this.#storeCheckpoint(cur, { hostPrincipal: by.id, commandId: "relocation", sequence: undefined, checkpoint: dispatch.resumeFrom, fixedId: `reloc:${commandId}`.slice(0, 120), allowEnded: true });
        } else if (cur.checkpoint === undefined) {
          if (dispatch.calls > 0) throw new DomainError("invalid_transition", `attempt ${attemptId} has made ${dispatch.calls} call(s) and no checkpoint reached the controller; it cannot be moved without losing its work`);
          checkpoint = "none";
        }
        await verified();
        const ready = await verified();
        done = { now: ready.placement, restored: ready.restored, summary: ready.summary, moved: (await commit()) };
      } catch (error) {
        // Nothing has moved: the old host goes on, as it was, once the attempt is released from the freeze that was put on it.
        if (frozen) await this.#deps.dispatch.release(by, attemptId).catch(() => undefined);
        throw error;
      }
    }
    if (done === undefined) {
      const ready = await verified();
      done = { now: ready.placement, restored: ready.restored, summary: ready.summary, moved: ready.placement };
    }
    const { restored, summary, moved } = done;
    const from = finishing ? (moved.history.at(-1)?.hostId ?? first.hostId) : first.hostId;
    this.#offers.delete(attemptId);
    await this.#deps.dispatch.relocate(by, attemptId, { hostId: to, ...(restored === undefined ? {} : { checkpoint: restored }), note: `moved from ${from} to ${to}: ${reason}`.slice(0, 500) });
    // The dispatcher has dropped its hold on the old run; only now is whoever waits for that run's result told it is over (before, it would have taken the attempt itself to be over).
    this.#wake(attemptId, moved.placement - 1, `relocated to ${to}`);
    return { attemptId, from, to, placement: moved.placement, checkpoint: finishing ? (moved.checkpoint === undefined ? "none" : "stored") : checkpoint, artifacts: summary };
  }

  /** Every reason the attempt may not move to `to`, from the target's record and the controller's policy. Empty means it may. */
  async #judge(b: PlacementBody, to: string): Promise<string[]> {
    const status = await this.#deps.hosts.status(this.#deps.principal, to);
    const policyFor: RelocationPolicyFor = this.#deps.relocationPolicy ?? (async () => ({}));
    const policy = await policyFor({ attemptId: b.attemptId, taskId: b.taskId, projectId: b.projectId, agentId: b.agentId, from: b.hostId, requirements: b.requirements });
    // By default the attempt stays on the platform it was placed on; a platform policy replaces that rule.
    const { os: _o, arch: _a, ...platformless } = b.requirements; void _o; void _a;
    const reasons = capabilityReasons(to, status, policy.platforms === undefined ? b.requirements : platformless);
    if ((await this.#connected(to)) === undefined) reasons.push(`${to} has not connected to the controller`);
    const caps = status?.capabilities;
    if (policy.platforms !== undefined && caps !== undefined && !policy.platforms.some((p) => p.os === caps.os && p.arch === caps.arch)) reasons.push(`the platform policy does not allow ${caps.os}/${caps.arch}`);
    if (policy.credentialHosts !== undefined && policy.credentialHosts.length > 0 && !policy.credentialHosts.includes(to)) reasons.push(`the credential policy does not allow ${to} to hold this attempt's task credential`);
    if (b.requirements.data === "local-only" && !(policy.dataHosts ?? []).includes(to)) reasons.push(`the attempt's data is local-only and the data-location policy does not list ${to}`);
    return reasons;
  }

  // ---- internals -----------------------------------------------------------------------------------------------------------------

  /**
   * Rewrites a placement from what is there now (a lost race reads again), with any extra changes. `decide` returns the new body (and extra changes), or undefined for "nothing to do".
   * Returns the body that stands afterwards and the one before.
   */
  async #changePlacement(attemptId: string, decide: (current: { body: PlacementBody; revision: number } | undefined) => Promise<{ next: PlacementBody; extra?: readonly Change[] } | undefined>, label: string, by: { readonly commandId?: string; readonly actor?: string } = {}): Promise<{ body: PlacementBody; previous: PlacementBody | undefined }> {
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get(PLACEMENT_KIND, attemptId);
      const current = found === undefined ? undefined : { body: found.body as unknown as PlacementBody, revision: found.revision };
      const decided = await decide(current);
      if (decided === undefined) return { body: current?.body as PlacementBody, previous: current?.body };
      const ref: AggregateRef = { kind: PLACEMENT_KIND, id: attemptId };
      const change: Change = current === undefined ? { type: "create", ref, body: decided.next as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: decided.next as unknown as JsonObject };
      try {
        await this.#runner.command(`remote.${label}`, { commandId: by.commandId ?? `rp:${label}:${attemptId}:${randomUUID().slice(0, 16)}`, actor: by.actor ?? DISPATCHER_PRINCIPAL }, async () => ({
          payload: { attemptId, revision: current?.revision ?? 0, next: sha256(canonicalJson(decided.next as unknown as JsonObject)) },
          build: async () => ({ ref, creates: current === undefined, changes: mergeChanges([change, ...(decided.extra ?? [])]), detail: { attemptId, host: decided.next.hostId, placement: decided.next.placement, state: decided.next.state } }),
        }));
        return { body: decided.next, previous: current?.body };
      } catch (error) {
        if ((isDomainError(error, "stale_revision") || (current === undefined && isDomainError(error, "command_conflict"))) && attempt < 25 && by.commandId === undefined) continue;
        throw error;
      }
    }
  }
}

const wasLive = (previous: PlacementBody | undefined): boolean => previous !== undefined && LIVE.has(previous.state);
const pushHistory = (history: PlacementBody["history"], entry: PlacementBody["history"][number]): PlacementBody["history"] => [...history, { ...entry, reason: entry.reason.slice(0, 300) }].slice(-REMOTE_LIMITS.history);

function checkRequirements(value: unknown): Requirements {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("requirements", "must be an object");
  const r = value as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!["os", "arch", "harness", "isolation", "workspaces", "data"].includes(key)) invalid(`requirements.${key}`, "is not a requirement");
  const words = (v: unknown, field: string, max: number): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > max) return invalid(field, `must be a list of at most ${max}`);
    return v.map((x, i) => text(x, `${field}[${i}]`, { min: 1, max: 120 }));
  };
  if (r["data"] !== "local-only" && r["data"] !== "cloud-allowed") invalid("requirements.data", "must be local-only or cloud-allowed");
  const isolation = words(r["isolation"], "requirements.isolation", 10);
  const workspaces = words(r["workspaces"], "requirements.workspaces", 20);
  return {
    data: r["data"] as "local-only" | "cloud-allowed",
    ...(r["os"] === undefined ? {} : { os: text(r["os"], "requirements.os", { min: 1, max: 40 }) }), ...(r["arch"] === undefined ? {} : { arch: text(r["arch"], "requirements.arch", { min: 1, max: 40 }) }),
    ...(r["harness"] === undefined ? {} : { harness: text(r["harness"], "requirements.harness", { min: 1, max: 40 }) }),
    ...(isolation === undefined ? {} : { isolation }), ...(workspaces === undefined ? {} : { workspaces }),
  };
}

function checkControl(value: unknown): ControlMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("message", "must be an object");
  const m = value as Record<string, unknown>;
  switch (m["kind"]) {
    case "tell": onlyKnown(m, ["kind", "text"]); return { kind: "tell", text: text(m["text"], "text", { min: 1, max: REMOTE_LIMITS.text, multiline: true }) };
    case "checkpoint": onlyKnown(m, ["kind"]); return { kind: "checkpoint" };
    case "stop": onlyKnown(m, ["kind", "emergency"]); return { kind: "stop", emergency: m["emergency"] === true };
    case "restart": {
      onlyKnown(m, ["kind", "recipe", "checkpoint"]);
      const recipe = m["recipe"] as { revision?: unknown; reach?: unknown; limits?: unknown } | undefined;
      if (recipe === undefined || recipe === null || typeof recipe.revision !== "string" || !Array.isArray(recipe.reach)) invalid("recipe", "must name its revision and reach");
      if (m["checkpoint"] === null || typeof m["checkpoint"] !== "object" || Array.isArray(m["checkpoint"])) invalid("checkpoint", "must be a checkpoint object");
      const limits = recipe!.limits;
      if (limits !== undefined && (limits === null || typeof limits !== "object" || Array.isArray(limits) || Object.entries(limits).some(([k, v]) => !["cpus", "memoryMb", "diskMb", "processes"].includes(k) || !Number.isSafeInteger(v) || (v as number) < 1))) invalid("recipe.limits", "must be whole numbers for cpus, memoryMb, diskMb and processes");
      return { kind: "restart", recipe: { revision: text(recipe!.revision, "recipe.revision", { min: 1, max: 120 }), reach: (recipe!.reach as unknown[]).slice(0, 100).map((x, i) => text(x, `recipe.reach[${i}]`, { min: 1, max: 120 })), ...(limits === undefined ? {} : { limits: { ...(limits as object) } }) }, checkpoint: m["checkpoint"] as JsonObject };
    }
    default: return invalid("kind", "must be tell, restart, checkpoint or stop");
  }
}

/** A process report as the worker sent it, checked field by field: nothing is kept that was not asked for (card L02e). */
function checkProcessReport(raw: { readonly seq: unknown; readonly final: unknown; readonly processes: unknown }): { seq: number; final: boolean; processes: { ref: string; kind: "process" | "child"; state: "running" | "uncooperative" | "unknown" }[] } {
  if (typeof raw.seq !== "number" || !Number.isSafeInteger(raw.seq) || raw.seq < 1) return invalid("seq", "must be a whole number from 1");
  if (typeof raw.final !== "boolean") return invalid("final", "must be true or false");
  const list = raw.processes;
  if (!Array.isArray(list) || list.length > REMOTE_LIMITS.processes) return invalid("processes", `must be a list of at most ${REMOTE_LIMITS.processes} entries`);
  const seen = new Set<string>();
  const processes = list.map((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return invalid(`processes[${i}]`, "must be an object");
    const e = entry as Record<string, unknown>;
    onlyKnown(e, ["ref", "kind", "state"]);
    if (typeof e["ref"] !== "string" || e["ref"].length === 0 || e["ref"].length > REMOTE_LIMITS.processRef * 4) return invalid(`processes[${i}].ref`, `must be text of at most ${REMOTE_LIMITS.processRef * 4} characters`);
    if (e["kind"] !== "process" && e["kind"] !== "child") return invalid(`processes[${i}].kind`, "must be process or child");
    if (e["state"] !== "running" && e["state"] !== "uncooperative" && e["state"] !== "unknown") return invalid(`processes[${i}].state`, "must be running, uncooperative or unknown");
    // A command line can hold a secret: it is redacted before it is cut, every control or format character is made a space, the cut keeps whole characters, and an entry that is the same after that is one entry.
    const ref = cleanProcessRef(e["ref"]);
    const key = `${e["kind"]}|${ref}`;
    return seen.has(key) ? undefined : (seen.add(key), { ref, kind: e["kind"], state: e["state"] });
  }).filter((x): x is { ref: string; kind: "process" | "child"; state: "running" | "uncooperative" | "unknown" } => x !== undefined);
  return { seq: raw.seq, final: raw.final, processes };
}

function checkEnforcement(value: unknown): ContractEnforcement[] {
  if (!Array.isArray(value) || value.length > CONTRACT_LIMIT_NAMES.length) return invalid("enforcement", `must be a list of at most ${CONTRACT_LIMIT_NAMES.length} entries`);
  const seen = new Set<string>();
  return value.map((raw, i) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid(`enforcement[${i}]`, "must be an object");
    const e = raw as Record<string, unknown>;
    onlyKnown(e, ["limit", "value", "enforced", "detail"]);
    if (typeof e["limit"] !== "string" || !(CONTRACT_LIMIT_NAMES as readonly string[]).includes(e["limit"])) return invalid(`enforcement[${i}].limit`, "must be a limit name");
    if (seen.has(e["limit"])) return invalid(`enforcement[${i}].limit`, "is named twice");
    seen.add(e["limit"]);
    if (typeof e["value"] !== "number" || !Number.isSafeInteger(e["value"])) return invalid(`enforcement[${i}].value`, "must be a whole number");
    if (e["enforced"] !== "full" && e["enforced"] !== "partial" && e["enforced"] !== "none") return invalid(`enforcement[${i}].enforced`, "must be full, partial or none");
    const detail = e["detail"] === undefined ? undefined : redactText(text(e["detail"], `enforcement[${i}].detail`, { min: 0, max: 300 })).slice(0, 300);
    return { limit: e["limit"] as ContractLimitName, value: e["value"], enforced: e["enforced"], ...(detail === undefined ? {} : { detail }) };
  });
}

function checkResult(value: unknown): StoredResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("result", "must be an object");
  const r = value as Record<string, unknown>;
  onlyKnown(r, ["status", "text", "error", "checkpoint", "usage", "endKind", "visibleChars", "nudges"]);
  if (r["status"] !== "completed" && r["status"] !== "failed" && r["status"] !== "cancelled") invalid("result.status", "must be completed, failed or cancelled");
  const clip = (v: unknown, field: string): string | undefined => (v === undefined ? undefined : redactText(text(v, field, { min: 0, max: 100_000, multiline: true })).slice(0, REMOTE_LIMITS.text));
  const t = clip(r["text"], "result.text");
  const e = clip(r["error"], "result.error");
  // How the turn ended (card W02; W02 review): a host that says it is carried, one this controller does not know is left out (read as unknown, never normal), and only a completed turn has one.
  const kind = r["endKind"] === undefined ? undefined : turnEndKindOf(text(r["endKind"], "result.endKind", { min: 1, max: 60 }));
  const visible = r["visibleChars"];
  if (visible !== undefined && !(Number.isSafeInteger(visible) && (visible as number) >= 0)) invalid("result.visibleChars", "must be a whole number of at least 0");
  const ending = r["status"] !== "completed" ? {} : { ...(kind === undefined || kind === "unknown" ? {} : { endKind: kind }), ...(visible === undefined ? {} : { visibleChars: visible as number }) };
  // Card W04: the nudges a remote worker gave the turn, carried for any status (a turn can be nudged and then fail).
  const nudges = r["nudges"];
  if (nudges !== undefined && !(Number.isSafeInteger(nudges) && (nudges as number) >= 0 && (nudges as number) <= 100)) invalid("result.nudges", "must be a whole number from 0 to 100");
  return { status: r["status"] as StoredResult["status"], ...(t === undefined ? {} : { text: t }), ...(e === undefined ? {} : { error: e }), ...(r["usage"] === undefined ? {} : { usage: r["usage"] as never }), ...ending, ...(nudges === undefined ? {} : { nudges: nudges as number }) };
}

/** The events a worker sends for a piece of a reply: a short list of known shapes, nothing else. */
export function checkStreamEvents(value: unknown): ModelStreamEvent[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) invalid("events", "must be a list of 1 to 500 events");
  return (value as unknown[]).map((raw, i): ModelStreamEvent => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid(`events[${i}]`, "must be an object");
    const e = raw as Record<string, unknown>;
    const str = (k: string, max: number): string => (typeof e[k] === "string" && (e[k] as string).length <= max ? (e[k] as string) : invalid(`events[${i}].${k}`, `must be a string of at most ${max} characters`));
    const known = (...keys: string[]): void => { for (const k of Object.keys(e)) if (k !== "kind" && !keys.includes(k)) invalid(`events[${i}].${k}`, "is not a field of this event"); };
    switch (e["kind"]) {
      case "text": known("text"); return { kind: "text", text: str("text", 1024 * 1024) };
      case "note": known("text"); return { kind: "note", text: str("text", 1000) };
      case "end": known(); return { kind: "end" };
      case "tool": {
        known("id", "name", "alias", "argumentsDelta", "done");
        if (typeof e["done"] !== "boolean") invalid(`events[${i}].done`, "must be true or false");
        const id = str("id", 80);
        if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) invalid(`events[${i}].id`, "is not a tool call ID");
        const alias = e["alias"] === undefined ? undefined : str("alias", 120);
        if (alias !== undefined && !/^[A-Za-z0-9._:-]{1,120}$/.test(alias)) invalid(`events[${i}].alias`, "is not a tool call ID");
        return { kind: "tool", id, ...(e["name"] === undefined ? {} : { name: str("name", 80) }), ...(alias === undefined ? {} : { alias }), argumentsDelta: str("argumentsDelta", 1024 * 1024), done: e["done"] as boolean };
      }
      default: return invalid(`events[${i}].kind`, "must be text, tool, note or end");
    }
  });
}

/** A host that is not connected, not heard from lately or has not announced yet may be fine in a moment; anything else (policy, what the host can do) lasts until someone changes it (cards H07e, H07b). */
export function lastingReasons(reasons: readonly string[]): boolean {
  return reasons.some((r) => !/has not connected to the controller|has not been heard from recently|has not announced its capabilities|offers that are not accepted/.test(r));
}

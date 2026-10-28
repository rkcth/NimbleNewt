import { randomUUID } from "node:crypto";
import type { ArtifactService } from "../artifacts/index.js";
import { canonicalJson, sha256 } from "../storage/json.js";
import type { DispatcherService } from "../dispatch/dispatcher.js";
import type { ToolCallRequest, ToolGateway, ToolResult, TurnUsage, WorkOrder, WorkerTurnResult } from "../dispatch/ports.js";
import { DomainError, isDomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { mergeChanges } from "../domain/changes.js";
import { commandId as checkCommandId, onlyKnown, text } from "../domain/model.js";
import { CommandRunner, type CommandResult, type RunnerOptions } from "../domain/runner.js";
import type { Capabilities, HostService, HostStatus } from "../hosts/index.js";
import { credentialIdOf, scopedCommandId } from "../security/credentials.js";
import { DISPATCHER_PRINCIPAL } from "../security/task-credentials.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, JsonObject } from "../storage/types.js";
import { WORKER_PROTOCOL, REMOTE_LIMITS, ProtocolMismatch, checkRange, negotiateProtocol, type ArtifactListing, type ControlMessage, type Offer, type SequencedControl, type SessionInfo, type StoredResult, type VersionRange } from "./protocol.js";

export const SESSION_KIND = "remote-session";
export const PLACEMENT_KIND = "remote-placement";
export const STORE_KIND = "remote-store";

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
  /** The host that holds the attempt now, and the number of this holding: every move, restart or re-offer raises it, and every worker message names it. */
  readonly hostId: string;
  readonly placement: number;
  readonly state: PlacementState;
  /** The worker session that accepted the placement (absent until it does). */
  readonly sessionId?: string;
  readonly offeredAt: string;
  readonly acceptedAt?: string;
  readonly expiresAt: string;
  readonly requirements: Requirements;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly checkpoint?: { readonly artifactId: string; readonly sequence: number; readonly digest: string; readonly at: string };
  readonly checkpoints: number;
  readonly controlSeq: number;
  readonly control: readonly SequencedControl[];
  readonly result?: StoredResult;
  readonly relocations: number;
  /** The command that made the latest move (scoped to its issuer): the same command asked again is answered, not done again. */
  readonly lastRelocation?: { readonly commandId: string; readonly at: string };
  /** The earlier holders, newest last (bounded): a worker that held the attempt once is told it was fenced, anyone else is told nothing exists. */
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

// ---- the service -----------------------------------------------------------------------------------------------------------------

export interface RemoteDeps {
  /** The dispatcher's own service principal (`service:dispatcher`): it places attempts, reads host status and moves attempts. */
  readonly principal: Principal;
  readonly hosts: Pick<HostService, "announce" | "heartbeat" | "status">;
  readonly artifacts: Pick<ArtifactService, "publish" | "get" | "readFile" | "assertResumable">;
  readonly dispatch: Pick<DispatcherService, "gateway" | "get" | "relocate" | "quiesce" | "release">;
  /** The policy for moving an attempt; the default is conservative (see `RelocationPolicy`). Always the controller's, never the caller's. */
  readonly relocationPolicy?: RelocationPolicyFor;
  /** Where an attempt may be placed in the first place (data location, repository access, who may hold the credential). Absent: only what a host can do decides. */
  readonly placementPolicy?: PlacementPolicyFor;
}

export interface RemoteOptions extends RunnerOptions {
  /** The versions of the controller-worker protocol this controller speaks. Default `WORKER_PROTOCOL`. */
  readonly protocol?: VersionRange;
  /** The largest file one fetch returns, in bytes. Default `REMOTE_LIMITS.fileBytes`. */
  readonly fileBytes?: number;
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
  readonly #offers = new Map<string, { readonly hostId: string; readonly placement: number; readonly order: WorkOrder }>();
  readonly #waiters = new Map<string, Set<(result: StoredResult) => void>>();
  /** The one open offers poll of each host (card H07): a new poll ends the earlier one, an offer or a new session ends it at once. */
  readonly #polls = new Map<string, { readonly end: () => void }>();
  readonly #pollStats = { polls: 0, held: 0, woken: 0, superseded: 0, timedOut: 0 };
  /** Connected hosts by platform (`os/arch`), so a placement looks only at hosts that can run it (card H07). */
  readonly #byPlatform = new Map<string, Set<string>>();
  readonly #platformOf = new Map<string, string>();

  private constructor(runner: CommandRunner, deps: RemoteDeps, protocol: VersionRange, fileBytes: number) {
    this.#runner = runner;
    this.#deps = deps;
    this.#protocol = protocol;
    this.#fileBytes = fileBytes;
  }

  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, deps: RemoteDeps, options: RemoteOptions = {}): RemoteWorkerService {
    if (deps.principal.kind !== "service" || deps.principal.id !== DISPATCHER_PRINCIPAL || deps.principal.taskScope !== undefined) throw new DomainError("invalid_command", "principal: the remote service acts as the dispatcher's service principal", { field: "principal" });
    const fileBytes = options.fileBytes ?? REMOTE_LIMITS.fileBytes;
    if (!Number.isSafeInteger(fileBytes) || fileBytes < 1 || fileBytes > REMOTE_LIMITS.fileBytes) invalid("fileBytes", `must be a whole number from 1 to ${REMOTE_LIMITS.fileBytes}`);
    return new RemoteWorkerService(new CommandRunner(storage, epoch, options), deps, options.protocol === undefined ? WORKER_PROTOCOL : checkRange(options.protocol, "protocol"), fileBytes);
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
          hostId: host.id, sessionId: `ses-${epoch}`, sessionEpoch: epoch, ...(host.credentialId === undefined ? {} : { credentialId: host.credentialId }), protocol: chosen.version, workerVersion, connectedAt: this.#runner.now(), refusals: before?.refusals ?? 0,
        };
        const change: Change = current === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject };
        return { ref, creates: current === undefined, changes: [change], detail: { host: host.id, sessionEpoch: epoch, protocol: chosen.version } };
      },
    }));
    this.#index(host.id, command.capabilities);
    // An offers poll of the earlier session ends now; it is answered as fenced.
    this.#endPoll(host.id);
    return { sessionId: `ses-${result.revision}`, sessionEpoch: result.revision, protocol: chosen.version, controller: this.#protocol };
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

  /** Counts the offers made to each host, so a poll can tell that one arrived between its read and its wait. */
  readonly #made = new Map<string, number>();
  #closed = false;

  #endPoll(hostId: string): void { this.#made.set(hostId, (this.#made.get(hostId) ?? 0) + 1); this.#polls.get(hostId)?.end(); }

  /** Ends every open poll (the controller is stopping). */
  close(): void { this.#closed = true; for (const poll of [...this.#polls.values()]) poll.end(); }

  /** How many polls are held open and how they ended, for the owner and for tests (card H07). */
  pollStats(by: Principal): { readonly open: number; readonly polls: number; readonly held: number; readonly woken: number; readonly superseded: number; readonly timedOut: number } {
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
    return body;
  }

  /** What the worker's current session is (and so which protocol version every message of it must name). */
  async sessionInfo(host: Principal, sessionId: unknown): Promise<SessionInfo> {
    const body = await this.#session(host, sessionId);
    return { sessionId: body.sessionId, sessionEpoch: body.sessionEpoch, protocol: body.protocol!, controller: this.#protocol };
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
    if (reasons.length > 0) throw new DomainError("invalid_command", `${hostId} cannot take attempt ${attemptId}: ${reasons.join("; ")}`, { field: "hostId" });
    for (const id of inputs) await this.#deps.artifacts.assertResumable([id]);
    const placed = { ...requirements, os: status!.capabilities!.os, arch: status!.capabilities!.arch };
    let offered = 0;
    for (const o of this.#offers.values()) if (o.hostId === hostId) offered++;
    if (offered >= REMOTE_LIMITS.offers && !this.#offers.has(attemptId)) throw new DomainError("unavailable", `${hostId} already has ${REMOTE_LIMITS.offers} offers that are not accepted`);
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
        next = { attemptId, taskId: order.taskId, projectId: order.projectId, agentId: order.agentId, generation: order.generation, hostId, placement: 1, state: "offered", offeredAt: now, expiresAt: order.expiresAt, requirements: placed, inputs, outputs: [], checkpoints: 0, controlSeq: 0, control: [], relocations: 0, history: [] };
      } else {
        const b = current.body;
        if (b.hostId !== hostId) throw new DomainError("invalid_transition", `attempt ${attemptId} is placed on ${b.hostId}; it moves to ${hostId} only through relocate`, { field: "hostId" });
        if (b.generation !== order.generation) throw new DomainError("fenced", `the placement of attempt ${attemptId} belongs to generation ${b.generation}`, { field: "order" });
        // After a relocation the offer completes the move at the number already fenced; any other second placement is a new run and fences the earlier one.
        const number = b.state === "relocating" ? b.placement : b.placement + 1;
        const { sessionId: _s, acceptedAt: _a, result: _r, ...rest } = b; void _s; void _a; void _r;
        next = { ...rest, placement: number, state: "offered", offeredAt: now, expiresAt: order.expiresAt, requirements: placed, inputs: [...new Set([...b.inputs, ...inputs])], control: [], history: b.state === "relocating" ? b.history : pushHistory(b.history, { hostId: b.hostId, placement: b.placement, at: now, reason: "placed again" }) };
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
    return found !== undefined && LIVE.has(found.state) && found.expiresAt > this.#runner.now();
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
    attemptIdOf(attemptId);
    const why = text(reason, "reason", { min: 1, max: 300 });
    if (placement !== undefined && (!Number.isSafeInteger(placement) || placement < 1)) invalid("placement", "must be a whole number of at least 1");
    let ended: PlacementBody | undefined;
    try {
      const done = await this.#changePlacement(attemptId, async (current) => {
        if (current === undefined || !LIVE.has(current.body.state) || (placement !== undefined && current.body.placement !== placement)) { ended = undefined; return undefined; }
        this.#offers.delete(attemptId);
        const now = this.#runner.now();
        const next: PlacementBody = { ...current.body, state: "ended", history: pushHistory(current.body.history, { hostId: current.body.hostId, placement: current.body.placement, at: now, reason: why }) };
        return { next, extra: await this.#releaseStore(current.body) };
      }, "end");
      if (done.previous !== undefined && LIVE.has(done.previous.state) && done.body.state === "ended") ended = done.body;
    } catch (error) { if (!isDomainError(error, "not_found")) throw error; }
    if (ended !== undefined) this.#wake(attemptId, ended.placement, why);
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
      return { next: { ...current.body, controlSeq: seq, control: [...current.body.control, { ...msg, seq }].slice(-REMOTE_LIMITS.control) } };
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
        else if (b.placement !== placement || b.state === "ended") done({ status: "cancelled", error: "the placement ended or was replaced" });
      }, () => undefined);
    });
  }

  #wake(attemptId: string, placement: number, reason: string, result?: StoredResult): void {
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
  async offers(host: Principal, sessionId: unknown, asked: unknown = 0): Promise<Offer[]> {
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
    const earlier = this.#polls.get(host.id);
    if (earlier !== undefined) { this.#pollStats.superseded++; earlier.end(); }
    this.#pollStats.held++;
    const how = await new Promise<"woken" | "timeout">((resolve) => {
      const timer = setTimeout(() => finish("timeout"), waitMs);
      timer.unref?.();
      const entry = { end: () => finish("woken") };
      const finish = (result: "woken" | "timeout"): void => { clearTimeout(timer); if (this.#polls.get(host.id) === entry) this.#polls.delete(host.id); resolve(result); };
      this.#polls.set(host.id, entry);
    });
    if (how === "timeout") this.#pollStats.timedOut++; else this.#pollStats.woken++;
    // The session may have been replaced while the poll was held: the answer is then `fenced`, not offers for a session that no longer exists.
    await this.#session(host, session.sessionId);
    return this.#pending(host);
  }

  async #pending(host: Principal): Promise<Offer[]> {
    const out: Offer[] = [];
    for (const [attemptId, offer] of this.#offers) {
      if (offer.hostId !== host.id) continue;
      const b = (await this.#runner.get(PLACEMENT_KIND, attemptId))?.body as unknown as PlacementBody | undefined;
      // The attempt may have been placed again while the read was under way: the offer now held is the newer one, and is neither deleted nor judged by the older read.
      const live = this.#offers.get(attemptId);
      if (live === undefined) continue;
      if (live !== offer) { if (b !== undefined && b.hostId === host.id && b.placement === live.placement && b.state === "offered") out.push({ placement: live.placement, order: live.order }); continue; }
      if (b === undefined || b.hostId !== host.id || b.placement !== offer.placement || b.state !== "offered") { this.#offers.delete(attemptId); continue; }
      out.push({ placement: offer.placement, order: offer.order });
    }
    return out;
  }

  /**
   * The worker takes the offer it was made, binding the placement to its current session. Also how a worker that reconnected after a partition takes its work up again: if the attempt was moved or ended meanwhile,
   * this is where it learns (`fenced`). The offer (and with it the credential) is dropped once accepted.
   */
  async accept(host: Principal, sessionId: unknown, attemptId: string, placement: unknown): Promise<{ placement: number; expiresAt: string; controlSeq: number; checkpoint?: { artifactId: string; sequence: number } }> {
    const session = await this.#session(host, sessionId);
    const id = attemptIdOf(attemptId);
    const found = await this.#runner.get(PLACEMENT_KIND, id);
    const b = found?.body as unknown as PlacementBody | undefined;
    this.#holds(host, b, placement);
    if (b!.state !== "offered" && b!.state !== "accepted") throw new DomainError("fenced", `the placement of attempt ${id} is ${b!.state}`);
    if (b!.expiresAt <= this.#runner.now()) throw new DomainError("fenced", `attempt ${id} has expired`);
    const done = await this.#changePlacement(id, async (current) => {
      const x = current?.body;
      if (x === undefined || x.hostId !== host.id || x.placement !== b!.placement || (x.state !== "offered" && x.state !== "accepted")) throw new DomainError("fenced", `the placement of attempt ${id} changed`);
      return { next: { ...x, state: "accepted", sessionId: session.sessionId, acceptedAt: x.acceptedAt ?? this.#runner.now() } };
    }, "accept", { actor: host.id });
    this.#offers.delete(id);
    return { placement: done.body.placement, expiresAt: done.body.expiresAt, controlSeq: done.body.controlSeq, ...(done.body.checkpoint === undefined ? {} : { checkpoint: { artifactId: done.body.checkpoint.artifactId, sequence: done.body.checkpoint.sequence } }) };
  }

  /** The placement must exist, be held by this host, and be the number the message names: a former holder is told it is fenced, anyone else that nothing is there. */
  #holds(host: Principal, b: PlacementBody | undefined, placement: unknown): asserts b is PlacementBody {
    if (b === undefined) throw new DomainError("not_found", "no such attempt");
    if (b.hostId !== host.id) {
      if (b.history.some((h) => h.hostId === host.id)) throw new DomainError("fenced", `attempt ${b.attemptId} is no longer on this host`);
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
    if (b.expiresAt <= this.#runner.now()) throw new DomainError("fenced", `attempt ${id} has expired`);
    return b;
  }

  async #gateway(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown): Promise<ToolGateway> {
    const b = await this.#running(host, sessionId, attemptId, placement);
    return this.#deps.dispatch.gateway(b.attemptId);
  }

  /** The split form of the dispatch contract: the controller decides and records the call; the worker runs it. */
  async begin(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, request: ToolCallRequest): Promise<Awaited<ReturnType<ToolGateway["begin"]>>> {
    if (request === null || typeof request !== "object" || Array.isArray(request)) invalid("request", "must be a tool call request");
    return (await this.#gateway(host, sessionId, attemptId, placement)).begin(request);
  }

  async report(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, operationId: string, outcome: Parameters<ToolGateway["report"]>[1]): Promise<ToolResult> {
    if (typeof operationId !== "string") invalid("operationId", "must be an operation ID");
    return (await this.#gateway(host, sessionId, attemptId, placement)).report(operationId, outcome);
  }

  async usage(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, usage: TurnUsage, requestKey?: string): Promise<void> {
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) invalid("usage", "must be an object");
    await (await this.#gateway(host, sessionId, attemptId, placement)).usage(usage, requestKey);
  }

  /** Extends the attempt's lease. A worker in a partition that cannot send this loses the attempt when the lease ends. */
  async attemptHeartbeat(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown): Promise<{ until: string }> {
    return (await this.#gateway(host, sessionId, attemptId, placement)).heartbeat();
  }

  async acknowledgeDecisions(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown): Promise<void> {
    await (await this.#gateway(host, sessionId, attemptId, placement)).acknowledgeDecisions();
  }

  /** The turn is over: the result is recorded on the placement (the checkpoint, if any, as an artifact) and whoever waits for it (`waitForResult`) is given it. */
  async complete(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, command: NoActor & { result: WorkerTurnResult }): Promise<StoredResult> {
    const b = await this.#running(host, sessionId, attemptId, placement, ["accepted", "completed"]);
    onlyKnown(command, ["commandId", "result"]);
    checkCommandId(command.commandId);
    const result = checkResult(command.result);
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

  async #readCheckpoint(c: NonNullable<PlacementBody["checkpoint"]>): Promise<{ checkpoint: JsonObject }> {
    const bytes = await this.#deps.artifacts.readFile(c.artifactId, "checkpoint.json", { maxBytes: REMOTE_LIMITS.checkpointBytes });
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
    const bytes = await this.#deps.artifacts.readFile(artifactId, path, { maxBytes: this.#fileBytes });
    return { bytes, digest: entry.digest, size: entry.size };
  }

  /** The worker publishes files as an artifact of the placement's own project and task, created by the host. It joins the placement's outputs (and so travels with it if the attempt is moved). */
  async publishArtifact(host: Principal, sessionId: unknown, attemptId: unknown, placement: unknown, command: NoActor & { name: string; files: readonly { path: string; content: Uint8Array }[] }): Promise<{ artifactId: string }> {
    const b = await this.#running(host, sessionId, attemptId, placement);
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
      const { sessionId: _s, acceptedAt: _a, result: _r, ...rest } = x; void _s; void _a; void _r;
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
      if (dispatch === undefined || dispatch.state === "finished") throw new DomainError("invalid_transition", `attempt ${attemptId} is not live under the dispatcher`);
      // An attempt that parked on a host that has since gone away has an ended placement and a dispatcher record in `parked`: it can be moved too, from the checkpoint it parked with.
      endedParked = !LIVE.has(first.state) && dispatch.state === "parked";
      if (!LIVE.has(first.state) && !endedParked) throw new DomainError("invalid_transition", `the placement of attempt ${attemptId} is ${first.state}; only a live or parked attempt moves`);
      const reasons = await this.#judge(first, to);
      if (reasons.length > 0) throw new DomainError("invalid_transition", `attempt ${attemptId} cannot move to ${to}: ${reasons.join("; ")}`, { field: "toHostId" });
      // What is stored must verify before the old host is disturbed at all.
      await verified();
      try {
        let fresh: JsonObject | undefined;
        if (!endedParked) {
          // The old host is asked for a checkpoint with the calls settled. One that does not answer (a partition) is fenced all the same, with the last checkpoint it sent.
          try { frozen = true; fresh = (await this.#deps.dispatch.quiesce(by, attemptId, "relocation")).checkpoint; } catch { fresh = undefined; }
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
      const recipe = m["recipe"] as { revision?: unknown; reach?: unknown } | undefined;
      if (recipe === undefined || recipe === null || typeof recipe.revision !== "string" || !Array.isArray(recipe.reach)) invalid("recipe", "must name its revision and reach");
      if (m["checkpoint"] === null || typeof m["checkpoint"] !== "object" || Array.isArray(m["checkpoint"])) invalid("checkpoint", "must be a checkpoint object");
      return { kind: "restart", recipe: { revision: text(recipe!.revision, "recipe.revision", { min: 1, max: 120 }), reach: (recipe!.reach as unknown[]).slice(0, 100).map((x, i) => text(x, `recipe.reach[${i}]`, { min: 1, max: 120 })) }, checkpoint: m["checkpoint"] as JsonObject };
    }
    default: return invalid("kind", "must be tell, restart, checkpoint or stop");
  }
}

function checkResult(value: unknown): StoredResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("result", "must be an object");
  const r = value as Record<string, unknown>;
  onlyKnown(r, ["status", "text", "error", "checkpoint", "usage"]);
  if (r["status"] !== "completed" && r["status"] !== "failed" && r["status"] !== "cancelled") invalid("result.status", "must be completed, failed or cancelled");
  const clip = (v: unknown, field: string): string | undefined => (v === undefined ? undefined : redactText(text(v, field, { min: 0, max: 100_000, multiline: true })).slice(0, REMOTE_LIMITS.text));
  const t = clip(r["text"], "result.text");
  const e = clip(r["error"], "result.error");
  return { status: r["status"] as StoredResult["status"], ...(t === undefined ? {} : { text: t }), ...(e === undefined ? {} : { error: e }), ...(r["usage"] === undefined ? {} : { usage: r["usage"] as never }) };
}

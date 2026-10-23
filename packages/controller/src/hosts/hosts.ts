import { DomainError } from "../domain/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import { onlyKnown, taskId as checkTaskId, text, type View } from "../domain/model.js";
import { CommandRunner, view, type CommandResult, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { credentialIdOf, scopedCommandId } from "../security/credentials.js";
import { DISPATCHER_PRINCIPAL } from "../security/task-credentials.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

/** What a host says it can do. The controller schedules only where a task's needs are met; this is what the host claims, not something the controller verified. */
export interface Capabilities {
  readonly os: string;
  readonly arch: string;
  /** Installed harnesses and their versions, such as `{ name: "pi", version: "1.3.0" }`. */
  readonly harnesses: readonly { readonly name: string; readonly version: string }[];
  readonly isolation: readonly string[];
  readonly tools: readonly string[];
  /** Named workspace bindings the host has (never paths on the controller). */
  readonly workspaces: readonly string[];
}

export interface HostBody {
  readonly hostId: string;
  readonly capabilities: Capabilities;
  readonly announcedAt: string;
  /** Controller time of the latest accepted heartbeat. The host's own clock is never used. */
  readonly lastSeenAt?: string;
  /** The highest heartbeat sequence accepted; a heartbeat must carry a higher one, so an old message replayed later cannot make a dead host look alive. */
  readonly lastSequence: number;
  readonly heartbeats: number;
  /** The credential the host last announced or beat under. A new credential (rotation, reinstall) starts its own sequence, since the old one can no longer send anything. */
  readonly credentialId?: string;
}

export type Freshness = "fresh" | "stale" | "unknown";

/** What the controller can say about a host right now: whether its identity still works, and how recently it was heard from. */
export interface HostStatus {
  readonly hostId: string;
  /** `revoked` when the host's identity has been disabled: it can no longer authenticate. */
  readonly identity: "active" | "revoked";
  /** `unknown`: never heard from. `stale`: not heard from within the freshness window. Staleness is evidence about the connection only; it says nothing about whether the host's work has stopped. */
  readonly freshness: Freshness;
  readonly lastSeenAt?: string;
  readonly ageMs?: number;
  readonly capabilities?: Capabilities;
}

export interface HostOptions extends RunnerOptions {
  /** How long after its last heartbeat a host still counts as fresh. Provisional default 90 seconds (three heartbeats at 30 s); configurable. */
  readonly staleAfterMs?: number;
}

/** Provisional default: three heartbeats at 30 s. Shared with stall detection (card V01) so both read freshness the same way. */
export const DEFAULT_HOST_STALE_AFTER_MS = 90_000;
/** Freshness of a host from its last heartbeat time (controller clock) at `now`. */
export function hostFreshness(lastSeenAt: string | undefined, now: string, staleAfterMs: number): Freshness {
  if (lastSeenAt === undefined) return "unknown";
  return Math.max(0, Date.parse(now) - Date.parse(lastSeenAt)) <= staleAfterMs ? "fresh" : "stale";
}

export const HOST_LIMITS = { word: 40, harnesses: 20, isolation: 10, tools: 50, workspaces: 20, workspaceName: 120, detail: 500 } as const;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

function words(value: unknown, field: string, max: number, length: number): string[] {
  if (!Array.isArray(value)) return invalid(field, "must be a list");
  if (value.length > max) return invalid(field, `must have at most ${max} entries`);
  return value.map((v, i) => label(v, `${field}[${i}]`, length));
}
function label(value: unknown, field: string, length: number): string {
  const out = text(value, field, { min: 1, max: length });
  if (redactText(out) !== out) return invalid(field, "looks like a credential or key; those are not recorded");
  return out;
}

function capabilities(value: unknown): Capabilities {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("capabilities", "must be an object");
  const c = value as Record<string, unknown>;
  for (const key of Object.keys(c)) if (!["os", "arch", "harnesses", "isolation", "tools", "workspaces"].includes(key)) invalid(`capabilities.${key}`, "is not a capability field");
  if (!Array.isArray(c["harnesses"])) invalid("capabilities.harnesses", "must be a list");
  const harnesses = (c["harnesses"] as unknown[]);
  if (harnesses.length > HOST_LIMITS.harnesses) invalid("capabilities.harnesses", `must have at most ${HOST_LIMITS.harnesses} entries`);
  return {
    os: label(c["os"], "capabilities.os", HOST_LIMITS.word),
    arch: label(c["arch"], "capabilities.arch", HOST_LIMITS.word),
    harnesses: harnesses.map((h, i) => {
      if (h === null || typeof h !== "object" || Array.isArray(h)) return invalid(`capabilities.harnesses[${i}]`, "must be an object with name and version");
      const e = h as Record<string, unknown>;
      for (const key of Object.keys(e)) if (key !== "name" && key !== "version") invalid(`capabilities.harnesses[${i}].${key}`, "is not a harness field");
      return { name: label(e["name"], `capabilities.harnesses[${i}].name`, HOST_LIMITS.word), version: label(e["version"], `capabilities.harnesses[${i}].version`, HOST_LIMITS.word) };
    }),
    isolation: words(c["isolation"], "capabilities.isolation", HOST_LIMITS.isolation, HOST_LIMITS.word),
    tools: words(c["tools"], "capabilities.tools", HOST_LIMITS.tools, HOST_LIMITS.word),
    workspaces: words(c["workspaces"], "capabilities.workspaces", HOST_LIMITS.workspaces, HOST_LIMITS.workspaceName),
  };
}

function requireHost(principal: Principal): void {
  if (principal.kind !== "host") throw new DomainError("forbidden", `${principal.id} is not a host`);
}

/**
 * Worker hosts (card H01). A host is an enrolled principal of kind `host` (card A01): its identity is its credential, never its name or address. The host announces what it
 * can do and sends heartbeats; the controller stamps each with its own time. Freshness (fresh, stale, unknown) and the state of the identity (active or revoked) are read from
 * those records. **Nothing here touches assignments**: a stale, silent, rotated or revoked host keeps every task it owns, because an unreachable host is not evidence that its
 * work has stopped; releasing or fencing an assignment is the owner's explicit decision (and the later reconciliation cards').
 */
export class HostService {
  readonly #runner: CommandRunner;
  readonly #assignments: AssignmentService;
  readonly #staleAfterMs: number;

  private constructor(runner: CommandRunner, assignments: AssignmentService, staleAfterMs: number) {
    this.#runner = runner;
    this.#assignments = assignments;
    this.#staleAfterMs = staleAfterMs;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, assignments: AssignmentService, options: HostOptions = {}): HostService {
    const stale = options.staleAfterMs ?? DEFAULT_HOST_STALE_AFTER_MS;
    if (!Number.isSafeInteger(stale) || stale < 1000) throw new DomainError("invalid_command", "staleAfterMs: must be a whole number of at least 1000", { field: "staleAfterMs" });
    return new HostService(new CommandRunner(storage, epoch, options), assignments, stale);
  }

  /** A principal object a caller still holds may be older than a revocation: the identity must be active in the stored record now. */
  async #active(host: Principal): Promise<void> {
    requireHost(host);
    const stored = await this.#runner.get("principal", host.id);
    const body = stored?.body as unknown as PrincipalBody | undefined;
    // The object must also be from the current credential: after a rotation, one obtained before it is refused like the old token.
    if (body === undefined || body.kind !== "host" || body.state !== "active" || body.credential === undefined || host.credentialId !== credentialIdOf(body.credential)) throw new DomainError("unauthenticated", "the credential was not accepted");
  }

  /** The host states what it can do (first time, or again after an upgrade). Replaces the earlier statement. */
  async announce(host: Principal, command: NoActor & { capabilities: Capabilities }): Promise<CommandResult> {
    await this.#active(host);
    return this.#retrying(() => this.#runner.command("host.announce", { commandId: scopedCommandId(host.id, command.commandId), actor: host.id }, async () => {
      onlyKnown(command, ["commandId", "capabilities"]);
      const caps = capabilities(command.capabilities);
      return {
        payload: { capabilities: caps as unknown as JsonObject },
        build: async () => {
          const ref: AggregateRef = { kind: "host-record", id: host.id };
          const current = await this.#runner.get("host-record", host.id);
          const before = current?.body as unknown as HostBody | undefined;
          const body: HostBody = before === undefined
            ? { hostId: host.id, capabilities: caps, announcedAt: this.#runner.now(), lastSequence: 0, heartbeats: 0, ...(host.credentialId === undefined ? {} : { credentialId: host.credentialId }) }
            : { ...before, capabilities: caps, ...(before.credentialId === host.credentialId ? {} : { lastSequence: 0, ...(host.credentialId === undefined ? {} : { credentialId: host.credentialId }) }) };
          const change: Change = current === undefined
            ? { type: "create", ref, body: body as unknown as JsonObject }
            : { type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject };
          return { ref, creates: current === undefined, changes: [change], detail: { host: host.id } };
        },
      };
    }));
  }

  /** The host reports that it is alive. `sequence` must be higher than the last accepted one. */
  async heartbeat(host: Principal, command: NoActor & { sequence: number }): Promise<CommandResult> {
    await this.#active(host);
    return this.#retrying(() => this.#runner.command("host.heartbeat", { commandId: scopedCommandId(host.id, command.commandId), actor: host.id }, async () => {
      onlyKnown(command, ["commandId", "sequence"]);
      const sequence = command.sequence;
      if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) return invalid("sequence", "must be a whole number of at least 1");
      return {
        payload: { sequence },
        build: async () => {
          const current = await this.#runner.get("host-record", host.id);
          if (current === undefined) throw new DomainError("invalid_command", `${host.id} has not announced its capabilities yet`, { field: "capabilities" });
          const before = current.body as unknown as HostBody;
          // A host on a new credential starts a new sequence; everything sent under the old credential can no longer authenticate.
          const sameCredential = before.credentialId === host.credentialId;
          if (sameCredential && sequence <= before.lastSequence) throw new DomainError("invalid_command", `sequence ${sequence} is not after the last accepted one (${before.lastSequence})`, { field: "sequence" });
          const ref: AggregateRef = { kind: "host-record", id: host.id };
          const body: HostBody = { ...before, lastSeenAt: this.#runner.now(), lastSequence: sequence, heartbeats: before.heartbeats + 1, ...(host.credentialId === undefined ? {} : { credentialId: host.credentialId }) };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { host: host.id, sequence } };
        },
      };
    }));
  }

  /**
   * The host reports progress on a task it works on. Recorded as the task's observed activity under the host's own identity (never one it names); it needs the
   * `attempt.work` grant for the task's project. It does not refresh the host's freshness (a heartbeat does not show progress, nor progress a heartbeat) and changes no ownership.
   */
  async reportProgress(host: Principal, command: NoActor & { taskId: string; generation: number; kind: string; detail?: string }): Promise<CommandResult> {
    await this.#active(host);
    onlyKnown(command, ["commandId", "taskId", "generation", "kind", "detail"]);
    const taskId = checkTaskId(command.taskId);
    const task = await this.#runner.get("task", taskId);
    // A task in a project the host has no grant for reads exactly like a task that is not there.
    if (task === undefined || !allows(host, "attempt.work", (task.body as unknown as { projectId: string }).projectId, { resource: { kind: "task", id: taskId } })) throw new DomainError("forbidden", `${host.id} may not report on that task`);
    return this.#assignments.observeActivity({
      commandId: scopedCommandId(host.id, command.commandId), actor: host.id, taskId, observedBy: host.id, generation: command.generation, kind: command.kind,
      ...(command.detail === undefined ? {} : { detail: command.detail }),
    });
  }

  /** One host as the controller sees it now. A host may ask about itself; the owner about any. Anything else is refused as if the host did not exist. */
  async status(asker: Principal, hostId: string): Promise<HostStatus | undefined> {
    // The owner, the host itself and the dispatcher (card H12: it must see whether a host is fresh and revoked before it starts an attempt there) may ask.
    if (asker.kind !== "owner" && asker.id !== hostId && !(asker.kind === "service" && asker.id === DISPATCHER_PRINCIPAL && asker.taskScope === undefined)) return undefined;
    // Only an enrolled host has a status: a name that was never enrolled (or belongs to an agent) reads as absent, not as revoked.
    const principal = await this.#runner.get("principal", hostId);
    if ((principal?.body as unknown as PrincipalBody | undefined)?.kind !== "host") return undefined;
    return this.#statusOf(hostId, this.#runner.now());
  }

  /** Announced hosts with freshness, for the owner, one page at a time (`next` is where to continue). */
  async list(owner: Principal, page: { afterId?: string; limit?: number } = {}): Promise<{ items: HostStatus[]; next?: string }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner`);
    const limit = page.limit ?? 100;
    const records = await this.#runner.list("host-record", { ...(page.afterId === undefined ? {} : { afterId: page.afterId }), limit });
    const now = this.#runner.now();
    const items: HostStatus[] = [];
    for (const record of records) items.push(await this.#statusOf(record.id, now));
    const last = records.at(-1);
    return { items, ...(records.length === limit && last !== undefined ? { next: last.id } : {}) };
  }

  async #statusOf(hostId: string, now: string): Promise<HostStatus> {
    const principal = await this.#runner.get("principal", hostId);
    const pbody = principal?.body as unknown as PrincipalBody | undefined;
    const record = await this.#runner.get("host-record", hostId);
    const body = record?.body as unknown as HostBody | undefined;
    const identity = pbody?.state === "active" ? "active" : "revoked";
    if (body === undefined) return { hostId, identity, freshness: "unknown" };
    const age = body.lastSeenAt === undefined ? undefined : Math.max(0, Date.parse(now) - Date.parse(body.lastSeenAt));
    const freshness = hostFreshness(body.lastSeenAt, now, this.#staleAfterMs);
    return { hostId, identity, freshness, ...(body.lastSeenAt === undefined ? {} : { lastSeenAt: body.lastSeenAt }), ...(age === undefined ? {} : { ageMs: age }), capabilities: body.capabilities };
  }

  async get(owner: Principal, hostId: string): Promise<View<HostBody> | undefined> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner`);
    const found = await this.#runner.get("host-record", hostId);
    return found === undefined ? undefined : view<HostBody>(found);
  }

  /** Two heartbeats (or a heartbeat and an announcement) at once: the later finds the record moved and tries again. */
  async #retrying(run: () => Promise<CommandResult>): Promise<CommandResult> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        // A lost race on the record (stale_revision), or on its very first creation (command_conflict), is simply tried again; a real conflict persists and is thrown after a few tries.
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 6) throw error;
      }
    }
  }
}

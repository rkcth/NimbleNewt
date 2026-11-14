import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { Principal } from "../security/principals.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";

/**
 * Resources an agent's environment may mount because a maintenance request for them was approved and applied (card A09, the mount kind). The controller keeps only the NAME of the resource and where it appears in the sandbox; the files
 * stay with the host that has them (the host's resource store: a private directory of named resources it was given), and a host path never appears in a request, a record or a log. The dispatcher asks `reachNames` when an attempt starts and puts a
 * named reach (`mount:<resource>`) in the attempt's recipe; the host turns the name into a read-only mount of its own directory for that resource. A name the host does not hold is refused by the host, never guessed.
 *
 * Only read access is offered: a named reach adds read-only inputs and nothing else (a writable path is outside what a reach may add), so a request for write access is refused when it is applied.
 */
export interface AgentMountEntry { readonly requestId: string; readonly resource: string; readonly mountPath: string; readonly mode: "read"; readonly at: string }
export interface AgentMountsBody { readonly agentId: string; readonly entries: readonly AgentMountEntry[]; readonly updatedAt: string }
export type AgentMountsView = AgentMountsBody & { readonly id: string; readonly revision: number };

export const AGENT_MOUNT_LIMITS = { perAgent: 20, resourceChars: 73 } as const;
/** Where a mounted resource appears in the sandbox: the one place the host's read-only inputs go. */
export const mountGuestPath = (resource: string): string => `/inputs/mounts/${resource}`;
/** The reach name for one resource (an attempt's recipe lists it; the host answers it). */
export const mountReachName = (resource: string): string => `mount:${resource}`;

const KIND = "agent-mounts";
const REQUEST_ID = /^mnt-[a-z2-7]{20}$/;
const RESOURCE = /^[a-z][a-z0-9._-]{0,79}$/;
const rowId = (agentId: string): string => `amt-${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}`;
const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

export class AgentMounts {
  readonly #runner: CommandRunner;
  readonly #service: Principal;
  private constructor(runner: CommandRunner, service: Principal) { this.#runner = runner; this.#service = service; }
  static withEpoch(storage: ControllerStorage, epoch: number, service: Principal, options: RunnerOptions = {}): AgentMounts { return new AgentMounts(new CommandRunner(storage, epoch, options), service); }

  /** Records that `requestId` gives `agentId` the named resource. Idempotent by request. At most 20 for an agent, and one entry per resource. */
  async add(requestId: string, agentId: string, resource: string, mountPath: string): Promise<{ readonly added: boolean }> {
    if (!REQUEST_ID.test(requestId)) bad("requestId", "must be a maintenance request ID");
    if (!RESOURCE.test(resource) || resource.length > AGENT_MOUNT_LIMITS.resourceChars) bad("resource", `must be a resource name of at most ${AGENT_MOUNT_LIMITS.resourceChars} characters`);
    const ref: AggregateRef = { kind: KIND, id: rowId(agentId) };
    const now = this.#runner.now();
    let added = false;
    // The record's revision is part of the command ID, so an add after an earlier add and end of the same request is carried out rather than answered from the first add (see `AgentSiteAllowances.allow`).
    const seen = (await this.#runner.get(KIND, ref.id))?.revision ?? 0;
    await this.#runner.command("maintenance.mount.add", { commandId: `amt-add:${requestId}:${seen}`, actor: this.#service.id }, async () => ({
      payload: { requestId, agentId, resource, mountPath },
      build: async () => {
        const found = await this.#runner.get(KIND, ref.id);
        const prior = found?.body as unknown as AgentMountsBody | undefined;
        if (prior?.entries.some((e) => e.requestId === requestId)) return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found!.revision }], detail: { agentId, resource, unchanged: true } };
        if ((prior?.entries.length ?? 0) >= AGENT_MOUNT_LIMITS.perAgent) throw new DomainError("invalid_command", `an agent may hold at most ${AGENT_MOUNT_LIMITS.perAgent} approved mounts`);
        added = true;
        const body: AgentMountsBody = { agentId, entries: [...(prior?.entries ?? []), { requestId, resource, mountPath, mode: "read", at: now }], updatedAt: now };
        const change = found === undefined ? { type: "create" as const, ref, body: body as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: found.revision, body: body as unknown as JsonObject };
        return { ref, creates: found === undefined, changes: [change], detail: { agentId, resource, requestId } };
      },
    }));
    return { added };
  }

  /** Takes back what `requestId` gave. Idempotent. Attempts that start afterwards no longer get the mount; one already running keeps what it was started with until it ends or restarts. */
  async end(requestId: string, agentId: string): Promise<void> {
    if (!REQUEST_ID.test(requestId)) bad("requestId", "must be a maintenance request ID");
    const ref: AggregateRef = { kind: KIND, id: rowId(agentId) };
    const now = this.#runner.now();
    const before = await this.#runner.get(KIND, ref.id);
    const standing = (before?.body as unknown as AgentMountsBody | undefined)?.entries.some((e) => e.requestId === requestId) === true;
    if (standing) await this.#runner.command("maintenance.mount.end", { commandId: `amt-end:${requestId}:${before?.revision ?? 0}`, actor: this.#service.id }, async () => ({
      payload: { requestId, agentId },
      build: async () => {
        const found = await this.#runner.get(KIND, ref.id);
        const prior = found?.body as unknown as AgentMountsBody | undefined;
        if (found === undefined || prior === undefined) throw new DomainError("not_found", "no such mount record");
        if (!prior.entries.some((e) => e.requestId === requestId)) return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found.revision }], detail: { agentId, unchanged: true } };
        const body: AgentMountsBody = { ...prior, entries: prior.entries.filter((e) => e.requestId !== requestId), updatedAt: now };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject }], detail: { agentId, requestId, ended: true } };
      },
    }));
  }

  /** The mounts an agent holds now, in the order approved. */
  async of(agentId: string): Promise<readonly AgentMountEntry[]> {
    const found = await this.#runner.get(KIND, rowId(agentId));
    return (found?.body as unknown as AgentMountsBody | undefined)?.entries ?? [];
  }

  /** The reach names an attempt of this agent starts with (see `DispatcherDeps.agentReach`). */
  async reachNames(agentId: string): Promise<readonly string[]> { return [...new Set((await this.of(agentId)).map((e) => mountReachName(e.resource)))]; }

  /** Owner view. */
  async list(by: Principal, agentId: string): Promise<readonly AgentMountEntry[]> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} is not the owner; only the owner lists approved mounts`);
    return this.of(agentId);
  }
}

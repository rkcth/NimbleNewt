import { DomainError } from "../domain/errors.js";
import { AgentSiteAllowances } from "../network/agent-sites.js";
import { redactText } from "../security/redact.js";
import type { JsonObject } from "../storage/types.js";
import { AGENT_MOUNT_LIMITS, mountGuestPath, type AgentMounts } from "./mounts.js";
import type { ApplyOutcome, MaintenanceApplier, MaintenanceView, RevertOutcome } from "./maintenance.js";

/** What the host holds for mounting: the named resources it was given. `check` says whether one can be mounted now (it exists, is a real directory the host owns and stays inside the host's resource directory). Never a path. */
export interface MountResources { check(resource: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> }

export interface AccessApplierDeps {
  /** What carries out the other kinds (the environment applier, a fake in tests, or the answer that nothing is wired). Skill, package, extension, host-policy and base requests go there untouched. */
  readonly inner: MaintenanceApplier;
  /** The agent-level network allowance (the controller's relay reads it). Absent: network requests stay pending, as the controller has no relay to enforce them. */
  readonly sites?: AgentSiteAllowances;
  /** The record of mounts the dispatcher reads when an attempt starts. Absent: mount requests stay pending. */
  readonly mounts?: AgentMounts;
  /** The host's resources. Absent: mount requests stay pending (nothing could be mounted). */
  readonly resources?: MountResources;
}

const say = (e: unknown): string => redactText(e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Applies the access kinds of an approved maintenance request (card A09): `network` allows the agent's attempts to reach the named site through the controller's relay (and revokes it the same way), `mount` makes a named host resource
 * appear read-only in the sandbox of the agent's next attempts. Neither touches an environment revision, so neither needs the suspend, reload and validate sequence the package kinds need: a connection is judged at every use, and a mount is read when
 * an attempt starts. Everything else goes to the inner applier.
 *
 * Both are idempotent by request ID, so a repeat after a crash does the same thing again. Neither can run an install script, write a file or reach a destination the request did not name.
 */
export class AccessChangeApplier implements MaintenanceApplier {
  readonly #d: AccessApplierDeps;
  constructor(deps: AccessApplierDeps) { this.#d = deps; }

  async apply(view: MaintenanceView): Promise<ApplyOutcome> {
    if (view.kind === "network") return this.#network(view);
    if (view.kind === "mount") return this.#mount(view);
    return this.#d.inner.apply(view);
  }

  async revert(view: MaintenanceView, effect: JsonObject): Promise<RevertOutcome> {
    if (view.kind === "network") {
      if (this.#d.sites === undefined) return { outcome: "unsupported", reason: "no network relay is wired into this controller, so there is nothing to take back here" };
      try { await this.#d.sites.end(view.id, view.agentId, view.spec["site"], view.spec["port"]); } catch (error) { return { outcome: "failed", reason: say(error) }; }
      return { outcome: "reverted", effect: { site: String(view.spec["site"]), port: Number(view.spec["port"]), allowed: false } };
    }
    if (view.kind === "mount") {
      if (this.#d.mounts === undefined) return { outcome: "unsupported", reason: "no mount record is wired into this controller, so there is nothing to take back here" };
      try { await this.#d.mounts.end(view.id, view.agentId); } catch (error) { return { outcome: "failed", reason: say(error) }; }
      return { outcome: "reverted", effect: { resource: String(view.spec["resource"]), mounted: false, note: "attempts that start from now on get no mount; one already running keeps it until it ends or restarts" } };
    }
    return this.#d.inner.revert(view, effect);
  }

  async #network(view: MaintenanceView): Promise<ApplyOutcome> {
    if (this.#d.sites === undefined) return { outcome: "unsupported", reason: "no network relay is wired into this controller, so an approved site cannot be enforced; the change stays pending" };
    try {
      const done = await this.#d.sites.allow(view.id, view.agentId, view.spec["site"], view.spec["port"]);
      return { outcome: "applied", effect: { site: String(view.spec["site"]), port: Number(view.spec["port"]), allowed: true, via: "relay", note: "every attempt of this agent may connect to this site and port through the controller's relay; the connection log names this request", ...(done.created ? {} : { alreadyAllowedByAnotherRequest: true }) } };
    } catch (error) {
      // A refusal (the owner's rule, a site no approval can reach) is final for this request: nothing was allowed, so there is nothing to roll back. A storage or other trouble is tried again.
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "invalid_command")) return { outcome: "failed", reason: say(error), rollback: { allowed: false } };
      throw error;
    }
  }

  async #mount(view: MaintenanceView): Promise<ApplyOutcome> {
    const { mounts, resources } = this.#d;
    if (mounts === undefined || resources === undefined) return { outcome: "unsupported", reason: "this host has no store of resources to mount from, so an approved mount cannot be made; the change stays pending" };
    const resource = String(view.spec["resource"]), mountPath = String(view.spec["mountPath"]);
    const refuse = (reason: string): ApplyOutcome => ({ outcome: "failed", reason, rollback: { mounted: false } });
    if (view.spec["mode"] !== "read") return refuse("only read access is offered: a mount reaches the sandbox as a read-only input, and a writable path is not something an environment request can add");
    // The request is checked again here, as the deciders did: an agent's own resource or a shared one read-only.
    const key = view.agentId.startsWith("agent:") ? view.agentId.slice("agent:".length) : view.agentId;
    if (!resource.startsWith(`${key}.`) && !resource.startsWith("shared.")) return refuse("an agent may mount its own resource or a shared one, not another agent's");
    if (resource.length > AGENT_MOUNT_LIMITS.resourceChars) return refuse(`the resource name is longer than ${AGENT_MOUNT_LIMITS.resourceChars} characters`);
    if (mountPath !== mountGuestPath(resource)) return refuse(`a mounted resource appears at ${mountGuestPath(resource)} in the sandbox; ask for exactly that path`);
    const held = await resources.check(resource);
    if (!held.ok) return refuse(`the host cannot mount ${resource}: ${redactText(held.reason).slice(0, 200)}`);
    try {
      const done = await mounts.add(view.id, view.agentId, resource, mountPath);
      return { outcome: "applied", effect: { resource, mountPath, mode: "read", mounted: true, note: "attempts of this agent that start from now on see the resource read-only at this path", ...(done.added ? {} : { alreadyRecorded: true }) } };
    } catch (error) {
      if (error instanceof DomainError && error.code === "invalid_command") return refuse(say(error));
      throw error;
    }
  }
}

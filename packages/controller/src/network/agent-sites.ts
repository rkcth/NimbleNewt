import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { canonicalHost, canonicalPort, neverReachable, isPrivate } from "./destination.js";
import type { GrantView } from "./grants.js";

/**
 * Network sites an agent may reach because the owner or a decider approved a maintenance request for them (card A09, the network kind). It is the agent-level counterpart of a task's grant (card H12i): the approval belongs to the agent's
 * environment, not to one task, so every attempt of that agent may connect to the named host and port through the controller's relay, and to nothing else. The relay stays the only way out of the sandbox; this record only says that the destination
 * is allowed for that agent.
 *
 * What is kept: one record for each agent, host and port, with the maintenance requests that stand behind it. The site is allowed while at least one request stands. The relay and the web tool read it as a grant whose ID is the maintenance
 * request's ID, so the connection log names the request that allowed each connection and revoking that request ends the connections it allowed.
 *
 * Rules (nothing here is chosen by the agent): only the maintenance applier writes, under the maintenance service identity; a site is a public name or address (a destination that resolves to a private address is refused at each connection, as for a
 * task's grant without `allowPrivate`; an address no grant can reach is refused here); and the owner's `deny` rule for a site wins at every connection, at once, whether or not the applier has taken the allowance back yet.
 */
export interface AgentSiteBody {
  readonly agentId: string;
  readonly host: string;
  readonly port: number;
  /** The maintenance requests that stand behind this site, newest last. Allowed while there is one. */
  readonly requests: readonly { readonly id: string; readonly at: string }[];
  readonly updatedAt: string;
}
export type AgentSiteView = AgentSiteBody & { readonly id: string; readonly revision: number };

export const AGENT_SITE_LIMITS = { sitesPerAgent: 200, requestsPerSite: 20 } as const;

const KIND = "net-agent-site";
const REQUEST_ID = /^mnt-[a-z2-7]{20}$/;
const siteId = (agentId: string, host: string, port: number): string => `nas-${createHash("sha256").update(`${agentId}\0${host}\0${port}`).digest("hex").slice(0, 32)}`;
const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

export interface AgentSiteOptions extends RunnerOptions {
  /** Whether the owner's rule denies this site now (`MaintenanceService.siteDenied`). Read at every connection; a throw counts as denied (fail closed). Absent: no rule is consulted. */
  readonly denied?: (host: string, port: number) => Promise<boolean>;
}

export class AgentSiteAllowances {
  readonly #runner: CommandRunner;
  readonly #denied: ((host: string, port: number) => Promise<boolean>) | undefined;
  readonly #listeners = new Set<(grant: GrantView) => void>();
  readonly #service: Principal;

  private constructor(runner: CommandRunner, service: Principal, options: AgentSiteOptions) { this.#runner = runner; this.#service = service; this.#denied = options.denied; }

  /** `service` is the identity the writes are made as (the maintenance service identity). */
  static withEpoch(storage: ControllerStorage, epoch: number, service: Principal, options: AgentSiteOptions = {}): AgentSiteAllowances {
    return new AgentSiteAllowances(new CommandRunner(storage, epoch, options), service, options);
  }

  /** Told when a request's allowance ends (so the relay closes the connections that request allowed at once). Returns the function that stops the listening. */
  onEnded(listener: (grant: GrantView) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }

  #view(a: { id: string; revision: number; body: JsonObject }): AgentSiteView { return { ...(a.body as unknown as AgentSiteBody), id: a.id, revision: a.revision }; }

  /** The destination written the one way the controller compares, or a refusal. A private or never-reachable address is not a site an agent-level approval can name. */
  static destination(host: unknown, port: unknown): { host: string; port: number } {
    const h = canonicalHost(host, "site");
    const p = canonicalPort(port, "port");
    if (neverReachable(h)) throw new DomainError("forbidden", `${h} is an address no network approval can reach`);
    if (isPrivate(h)) throw new DomainError("forbidden", `${h} is a private or local address; a site an agent may reach is a public one (the owner can give a task a grant for a private address)`);
    return { host: h, port: p };
  }

  /**
   * Allows `agentId` to reach host:port on behalf of the approved request `requestId`. Idempotent by request: the same request again changes nothing. Refused when the owner's rule denies the site. Returns what was written.
   * A site is an exact name or address and port; no wildcard.
   */
  async allow(requestId: string, agentId: string, site: unknown, port: unknown): Promise<{ id: string; created: boolean }> {
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) bad("requestId", "must be a maintenance request ID");
    if (typeof agentId !== "string" || !/^agent:[A-Za-z0-9._-]{1,120}$/.test(agentId)) bad("agentId", "must be an agent's principal ID");
    const d = AgentSiteAllowances.destination(site, port);
    if (await this.#isDenied(d.host, d.port)) throw new DomainError("forbidden", "the owner denied this site; no approval makes it reachable until the owner clears the rule");
    const id = siteId(agentId, d.host, d.port);
    const ref: AggregateRef = { kind: KIND, id };
    const now = this.#runner.now();
    let created = false;
    // The command ID carries the revision the record had: a retry of this step is the same command, but an allow after an earlier allow and end of the same request (an application that ended unclearly, was reverted and is
    // applied again) is a new command and is carried out, instead of being answered from the first one with nothing written.
    const seen = (await this.#runner.get(KIND, id))?.revision ?? 0;
    await this.#runner.command("network.agent-site.allow", { commandId: `nas-allow:${requestId}:${seen}`, actor: this.#service.id }, async () => ({
      payload: { requestId, agentId, host: d.host, port: d.port },
      build: async () => {
        const found = await this.#runner.get(KIND, id);
        const prior = found?.body as unknown as AgentSiteBody | undefined;
        if (prior?.requests.some((r) => r.id === requestId)) return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found!.revision }], detail: { agentId, host: d.host, port: d.port, unchanged: true } };
        if (prior === undefined) {
          let count = 0;
          for (let after: string | undefined; ;) {
            const page = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 1000 });
            for (const p of page) { after = p.id; const b = p.body as unknown as AgentSiteBody; if (b.agentId === agentId && b.requests.length > 0) count++; }
            if (page.length < 1000) break;
          }
          if (count >= AGENT_SITE_LIMITS.sitesPerAgent) throw new DomainError("invalid_command", `an agent may hold at most ${AGENT_SITE_LIMITS.sitesPerAgent} approved network sites`);
        }
        if ((prior?.requests.length ?? 0) >= AGENT_SITE_LIMITS.requestsPerSite) throw new DomainError("invalid_command", "too many approved requests stand behind this site");
        created = prior === undefined || prior.requests.length === 0;
        const body: AgentSiteBody = { agentId, host: d.host, port: d.port, requests: [...(prior?.requests ?? []), { id: requestId, at: now }], updatedAt: now };
        const change = found === undefined ? { type: "create" as const, ref, body: body as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: found.revision, body: body as unknown as JsonObject };
        return { ref, creates: found === undefined, changes: [change], detail: { agentId, host: d.host, port: d.port, requestId } };
      },
    }));
    return { id, created };
  }

  /**
   * Takes back what `requestId` allowed. The site stays allowed while another approved request stands behind it. Idempotent. Returns whether the site is still allowed afterwards. Open connections that were allowed under this request
   * are told to end at once (the relay also finds it at its next look).
   */
  async end(requestId: string, agentId: string, site: unknown, port: unknown): Promise<{ stillAllowed: boolean }> {
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) bad("requestId", "must be a maintenance request ID");
    const d = AgentSiteAllowances.destination(site, port);
    const id = siteId(agentId, d.host, d.port);
    const ref: AggregateRef = { kind: KIND, id };
    const now = this.#runner.now();
    const before = await this.#runner.get(KIND, id);
    const standing = (before?.body as unknown as AgentSiteBody | undefined)?.requests.some((r) => r.id === requestId) === true;
    // As for `allow`: the revision in the command ID makes a second end of the same request (after it was allowed again) a new command, so it is never answered from the first end while the site stays allowed.
    if (standing) await this.#runner.command("network.agent-site.end", { commandId: `nas-end:${requestId}:${before?.revision ?? 0}`, actor: this.#service.id }, async () => ({
      payload: { requestId, agentId, host: d.host, port: d.port },
      build: async () => {
        const found = await this.#runner.get(KIND, id);
        const prior = found?.body as unknown as AgentSiteBody | undefined;
        if (found === undefined || prior === undefined) throw new DomainError("not_found", "no such site");
        if (!prior.requests.some((r) => r.id === requestId)) return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found.revision }], detail: { agentId, host: d.host, port: d.port, unchanged: true } };
        const body: AgentSiteBody = { ...prior, requests: prior.requests.filter((r) => r.id !== requestId), updatedAt: now };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject }], detail: { agentId, host: d.host, port: d.port, requestId, ended: true } };
      },
    }));
    const after = await this.#runner.get(KIND, id);
    const b = after?.body as unknown as AgentSiteBody | undefined;
    const view: GrantView = { taskId: "", projectId: "", host: d.host, port: d.port, allowPrivate: false, state: "revoked", requestedBy: agentId, requestedAt: now, via: "maintenance", endedAt: now, endedBy: this.#service.id, id: requestId, revision: after?.revision ?? 0 };
    for (const l of [...this.#listeners]) { try { l(view); } catch { /* a listener never changes the record */ } }
    return { stillAllowed: (b?.requests.length ?? 0) > 0 };
  }

  async #isDenied(host: string, port: number): Promise<boolean> {
    if (this.#denied === undefined) return false;
    try { return await this.#denied(host, port); } catch { return true; }
  }

  /**
   * What the relay and the web tool ask at each connection: whether the agent holds an approved site for exactly this destination now. The owner's deny rule is judged first and wins at once. The answer is shaped as a grant whose ID is the maintenance
   * request that stands behind it. A read: it writes nothing.
   */
  async check(agentId: string, host: string, port: number): Promise<{ readonly live: boolean; readonly why?: string; readonly grant?: GrantView }> {
    const found = await this.#runner.get(KIND, siteId(agentId, host, port));
    const b = found?.body as unknown as AgentSiteBody | undefined;
    if (found === undefined || b === undefined || b.requests.length === 0) return { live: false, why: "the agent's environment holds no approved site for that destination" };
    if (await this.#isDenied(host, port)) return { live: false, why: "the owner's rule denies this site" };
    const standing = b.requests[b.requests.length - 1]!;
    const grant: GrantView = { taskId: "", projectId: "", host, port, allowPrivate: false, state: "granted", requestedBy: agentId, requestedAt: standing.at, approvedBy: `maintenance:${standing.id}`, via: "maintenance", decidedAt: standing.at, id: standing.id, revision: found.revision };
    return { live: true, grant };
  }

  /** The sites an agent's environment holds now (owner view). Sites with no standing request are left out. */
  async list(by: Principal, agentId: string): Promise<AgentSiteView[]> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} is not the owner; only the owner lists approved network sites`);
    const out: AgentSiteView[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 1000 });
      for (const p of page) { after = p.id; const b = p.body as unknown as AgentSiteBody; if (b.agentId === agentId && b.requests.length > 0) out.push(this.#view(p)); }
      if (page.length < 1000) return out.sort((a, c) => (a.host + a.port < c.host + c.port ? -1 : 1)).map((s) => ({ ...s, host: redactText(s.host) }));
    }
  }
}

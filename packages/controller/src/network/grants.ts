import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { canonicalHost, canonicalPort, neverReachable } from "./destination.js";

/**
 * Network grants for tasks (card H12i). A worker runs in a sandbox with no network; the only way out for a task is a route through the controller's relay, and the relay lets a connection through only for a destination this service holds a
 * live grant for. A grant names the task, the destination (host and port, written exactly), who approved it and how (the owner, or the approval policy through a standing approval grant), and it ends with the task or when it is revoked. The default
 * is none: a task with no grant reaches nothing. Every connection the relay is asked for, allowed or refused, is recorded in the connection log kept here (task, attempt, destination, bytes).
 *
 * Assumptions made here (nothing waits on the owner; see the implementation notes): one grant per task and destination; a worker may ask for a grant but only the owner or a standing approval grant makes one; a grant that names a private or
 * loopback address (`allowPrivate`, the way to reach a local service) is never made by the policy on its own, only by the owner; a credential (a header the web tool adds) is stated by the owner only.
 */

export type GrantState = "requested" | "granted" | "denied" | "revoked";
export interface GrantBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly host: string;
  readonly port: number;
  /** The grant names a private, loopback or otherwise internal destination: a connection may resolve to such an address. Without it, a name that resolves to one is refused. */
  readonly allowPrivate: boolean;
  readonly state: GrantState;
  readonly requestedBy: string;
  readonly requestedAt: string;
  /** Why the destination is wanted, as the requester said it (redacted, short). */
  readonly reason?: string;
  readonly approvedBy?: string;
  /** `owner`: the owner approved it; `policy`: the approval policy allowed it through a standing approval grant. */
  readonly via?: "owner" | "policy";
  readonly decidedAt?: string;
  readonly endedAt?: string;
  readonly endedBy?: string;
  /** The one header the web tool adds when it fetches from this destination: a header name and the NAME of a secret (never the secret). The tunnel through the relay never adds any credential. */
  readonly credential?: { readonly header: string; readonly ref: string };
}
export type GrantView = GrantBody & { readonly id: string; readonly revision: number };

/** What the relay learns of a destination for a task: the grant, whether it holds now and, when it does not, why. */
export interface GrantCheck { readonly grant?: GrantView; readonly live: boolean; readonly why?: string }

/** What a connection came to, as the log keeps it (card H12i). */
export interface ConnectionBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly host: string;
  readonly port: number;
  /** The address the connection went to (the one that was checked). Absent for a refused connection. */
  readonly address?: string;
  readonly grantId?: string;
  readonly via: "relay" | "web-tool";
  readonly outcome: "open" | "closed" | "refused" | "failed";
  readonly reason?: string;
  readonly bytesToTarget: number;
  readonly bytesFromTarget: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Who ended it: the task's own side, the destination, a revoked or ended grant, the end of the attempt, an idle limit or an error. */
  readonly endedBy?: "client" | "target" | "revoked" | "ended" | "attempt" | "idle" | "error";
}
export type ConnectionView = ConnectionBody & { readonly id: string };

export const NETWORK_LIMITS = { grantsPerTask: 50, reason: 300, logPerAttempt: 1000, page: 200, header: 60, ref: 64 } as const;

const HEADER = /^[a-z][a-z0-9-]{0,59}$/i;
/** A name that looks like a key itself (someone pasted the secret where its name goes). */
const KEY_SHAPED = /^(sk|pk|rk|ghp|gho|ghs|xox[a-z]|akia|aiza)[-_]?[a-z0-9]{16,}$/i;
const SECRET_REF = /^(?!.*__)[A-Za-z][A-Za-z0-9._-]{0,63}$/;
/** Headers a credential may never be put in: the ones that change how a request is routed or framed. */
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "proxy-authorization", "proxy-connection", "expect"]);

const GRANT_KIND = "net-grant";
const connKind = (taskId: string): string => `net-conn-${taskId}`;
const grantId = (taskId: string, host: string, port: number): string => derivedId("ngr", `${taskId}|${host}|${port}`);
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/** The approval policy's answer for a worker's request, as far as this service needs it (the policy service's `evaluate` fits). */
export interface NetworkJudge { evaluate(input: { readonly principalId: string; readonly projectId: string; readonly tool: string; readonly taskId: string }): Promise<{ readonly mode: string; readonly via: string; readonly grantId?: string; readonly reasons: readonly string[] }> }

export interface NetworkGrantOptions extends RunnerOptions {
  /** The approval policy. Absent: a worker's request always waits for the owner. */
  readonly judge?: NetworkJudge;
  /** Tells that a grant ended (revoked, or its task ended is noticed lazily by the relay); the relay closes the open connections of that grant at once (it also checks again on a timer, so another controller process's revoke is noticed). */
  readonly onEnded?: (grant: GrantView) => void;
}

export class NetworkGrantService {
  readonly #runner: CommandRunner;
  readonly #judge: NetworkJudge | undefined;
  readonly #onEnded: ((grant: GrantView) => void) | undefined;
  readonly #listeners = new Set<(grant: GrantView) => void>();

  private constructor(runner: CommandRunner, options: NetworkGrantOptions) { this.#runner = runner; this.#judge = options.judge; this.#onEnded = options.onEnded; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: NetworkGrantOptions = {}): NetworkGrantService {
    return new NetworkGrantService(new CommandRunner(storage, epoch, options), options);
  }

  /** Told when a grant is revoked through this service (in process; the relay's timer covers a revoke made elsewhere). Returns the function that stops the listening. */
  onRevoked(listener: (grant: GrantView) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #told(grant: GrantView): void {
    for (const l of [...this.#listeners]) { try { l(grant); } catch { /* a listener never changes the grant */ } }
    try { this.#onEnded?.(grant); } catch { /* the same */ }
  }

  async #task(taskId: string): Promise<TaskBody> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", "no such task");
    return task;
  }

  #view(a: { id: string; revision: number; body: JsonObject }): GrantView { return { ...(a.body as unknown as GrantBody), id: a.id, revision: a.revision }; }

  /**
   * Asks for, or makes, a grant. The owner makes one directly. A worker (the task's own credential) asks: the approval policy judges the request like any action that opens new outside access (tool `open-network`, class access change); only a
   * standing approval grant that names it lets the policy allow it, and then the grant is made with the policy as its approver. Otherwise the request waits as `requested` for the owner. A destination that names a private address is never allowed by
   * the policy, only by the owner. Asking again for a destination already requested or granted is answered with the record that is there; asking again after a revoke or a refusal opens a new request.
   */
  async grant(by: Principal, command: NoActor & { taskId: string; host: string; port: number; allowPrivate?: boolean; reason?: string; credential?: { header: string; ref: string } }): Promise<{ id: string; state: GrantState; revision: number }> {
    onlyKnown(command, ["commandId", "taskId", "host", "port", "allowPrivate", "reason", "credential"]);
    const taskId = checkTaskId(command.taskId);
    const host = canonicalHost(command.host);
    const port = canonicalPort(command.port);
    if (command.allowPrivate !== undefined && typeof command.allowPrivate !== "boolean") invalid("allowPrivate", "must be true or false");
    const allowPrivate = command.allowPrivate === true;
    if (neverReachable(host)) throw new DomainError("forbidden", `${host} is an address no grant can reach (unspecified, broadcast, multicast or link-local, where cloud services keep their credentials)`);
    const reason = command.reason === undefined ? undefined : typeof command.reason === "string" && command.reason.length <= NETWORK_LIMITS.reason ? redactText(command.reason).trim() : invalid("reason", `must be text of at most ${NETWORK_LIMITS.reason} characters`);
    let credential: { header: string; ref: string } | undefined;
    if (command.credential !== undefined) {
      const c = command.credential as { header?: unknown; ref?: unknown };
      if (by.kind !== "owner") throw new DomainError("forbidden", "only the owner states a credential for a destination");
      if (c === null || typeof c !== "object" || typeof c.header !== "string" || !HEADER.test(c.header) || FORBIDDEN_HEADERS.has(c.header.toLowerCase())) return invalid("credential.header", "must be a header name that does not frame or route the request");
      if (typeof c.ref !== "string" || !SECRET_REF.test(c.ref) || KEY_SHAPED.test(c.ref)) return invalid("credential.ref", "must be the NAME of a secret, never the secret");
      credential = { header: c.header.toLowerCase(), ref: c.ref };
    }
    const task = await this.#task(taskId);
    if (task.state === "done" || task.state === "cancelled") throw new DomainError("invalid_transition", `the task is ${task.state}; a grant ends with its task`);
    const isOwner = by.kind === "owner";
    if (!isOwner && !(by.kind === "agent" && allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } }))) throw new DomainError("forbidden", `${by.id} may neither make nor ask for network access for that task`);
    const id = grantId(taskId, host, port);
    const ref: AggregateRef = { kind: GRANT_KIND, id };
    const now = this.#runner.now();
    // The policy is asked outside the write: a standing approval grant that names the tool lets it allow; any other answer leaves the request for the owner.
    let via: "owner" | "policy" = "owner";
    let approver = by.id;
    let state: GrantState = "granted";
    if (!isOwner) {
      state = "requested";
      if (this.#judge !== undefined && !allowPrivate) {
        let decision: Awaited<ReturnType<NetworkJudge["evaluate"]>> | undefined;
        try { decision = await this.#judge.evaluate({ principalId: by.id, projectId: task.projectId, tool: "open-network", taskId }); } catch { decision = undefined; }
        if (decision?.mode === "deny") throw new DomainError("forbidden", `denied by policy: ${redactText(decision.reasons.join("; ")).slice(0, 300)}`);
        if (decision?.mode === "allow" && decision.via === "grant") { state = "granted"; via = "policy"; approver = `policy:${decision.grantId ?? "standing-approval"}`.slice(0, 120); }
      }
    }
    const cid = scopedCommandId(by.id, command.commandId);
    const result = await this.#runner.command("network.grant", { commandId: cid, actor: by.id }, async () => ({
      payload: { taskId, host, port, allowPrivate, ...(reason === undefined ? {} : { reason }), ...(credential === undefined ? {} : { credential }), state, via },
      build: async () => {
        const found = await this.#runner.get(GRANT_KIND, id);
        const prior = found?.body as unknown as GrantBody | undefined;
        if (prior !== undefined && (prior.state === "granted" || (prior.state === "requested" && state === "requested"))) {
          // Already there: a repeated ask is answered with it (an owner's grant over a request is the owner's decision, below).
          if (!(prior.state === "requested" && state === "granted")) return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found!.revision }], detail: { taskId, host, port, state: prior.state, unchanged: true } };
        }
        if (prior === undefined) {
          let count = 0;
          for (let after: string | undefined; ;) {
            const page = await this.#runner.list(GRANT_KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 1000 });
            for (const p of page) { after = p.id; if ((p.body as unknown as GrantBody).taskId === taskId) count++; }
            if (page.length < 1000) break;
          }
          if (count >= NETWORK_LIMITS.grantsPerTask) throw new DomainError("invalid_command", `a task may have at most ${NETWORK_LIMITS.grantsPerTask} network grants`);
        }
        const body: GrantBody = {
          taskId, projectId: task.projectId, host, port, allowPrivate, state, requestedBy: by.id, requestedAt: now, ...(reason === undefined || reason === "" ? {} : { reason }),
          ...(state === "granted" ? { approvedBy: approver, via, decidedAt: now } : {}), ...(credential === undefined ? {} : { credential }),
        };
        const change = found === undefined ? { type: "create" as const, ref, body: body as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: found.revision, body: body as unknown as JsonObject };
        return { ref, creates: found === undefined, changes: [change], detail: { taskId, host, port, allowPrivate, state, via: state === "granted" ? via : "pending" } };
      },
    }));
    return { id, state: ((await this.#runner.get(GRANT_KIND, id))?.body as unknown as GrantBody | undefined)?.state ?? state, revision: result.revision };
  }

  /** The owner approves or refuses a request. */
  async decide(owner: Principal, command: NoActor & { grantId?: string; taskId?: string; host?: string; port?: number; verdict: "approve" | "deny"; expectedRevision?: number }): Promise<{ state: GrantState; revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner decides a network request`);
    onlyKnown(command, ["commandId", "grantId", "taskId", "host", "port", "verdict", "expectedRevision"]);
    if (command.verdict !== "approve" && command.verdict !== "deny") invalid("verdict", "must be approve or deny");
    const id = this.#idOf(command);
    const ref: AggregateRef = { kind: GRANT_KIND, id };
    const now = this.#runner.now();
    const next: GrantState = command.verdict === "approve" ? "granted" : "denied";
    const result = await this.#runner.command("network.decide", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { grantId: id, verdict: command.verdict },
      build: async () => {
        const found = await this.#runner.get(ref.kind, id);
        if (found === undefined) throw new DomainError("not_found", "no such network grant");
        if (command.expectedRevision !== undefined && found.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the grant is at revision ${found.revision}`, { currentRevision: found.revision });
        const prior = found.body as unknown as GrantBody;
        if (prior.state !== "requested") throw new DomainError("invalid_transition", `the request is ${prior.state}, not waiting for a decision`);
        const task = await this.#task(prior.taskId);
        if (next === "granted" && (task.state === "done" || task.state === "cancelled")) throw new DomainError("invalid_transition", `the task is ${task.state}; a grant ends with its task`);
        const body: GrantBody = { ...prior, state: next, approvedBy: owner.id, via: "owner", decidedAt: now };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject }], detail: { taskId: prior.taskId, host: prior.host, port: prior.port, verdict: command.verdict } };
      },
    }));
    return { state: next, revision: result.revision };
  }

  /** The grant a command names: by its ID, or by the task and the destination (what an owner can say). */
  #idOf(command: { grantId?: string; taskId?: string; host?: string; port?: number }): string {
    if (command.grantId !== undefined) {
      if (command.taskId !== undefined || command.host !== undefined || command.port !== undefined) invalid("grantId", "name the grant by its ID, or by the task, host and port, not both");
      return typeof command.grantId === "string" && /^ngr-[a-z2-7]{20}$/.test(command.grantId) ? command.grantId : invalid("grantId", "is not a network grant ID");
    }
    if (command.taskId === undefined || command.host === undefined || command.port === undefined) return invalid("grantId", "name the grant by its ID, or by the task, host and port");
    return grantId(checkTaskId(command.taskId), canonicalHost(command.host), canonicalPort(command.port));
  }

  /** The owner revokes a grant (or a request) by its ID or by task, host and port, or every live grant of a task (the task alone). Open connections under it end at once. Revoking what is already over changes nothing. */
  async revoke(owner: Principal, command: NoActor & { grantId?: string; taskId?: string; host?: string; port?: number; expectedRevision?: number }): Promise<{ revoked: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner revokes network access`);
    onlyKnown(command, ["commandId", "grantId", "taskId", "host", "port", "expectedRevision"]);
    if (command.grantId === undefined && command.taskId === undefined) invalid("grantId", "name the grant (grantId, or taskId with host and port) or the task whose grants all end (taskId alone)");
    const single = command.grantId !== undefined || command.host !== undefined || command.port !== undefined;
    let targets: GrantView[];
    if (single) {
      const id = this.#idOf(command);
      const found = await this.#runner.get(GRANT_KIND, id);
      if (found === undefined) throw new DomainError("not_found", "no such network grant");
      targets = [this.#view(found)];
    } else targets = (await this.#ofTask(checkTaskId(command.taskId))).filter((g) => g.state === "granted" || g.state === "requested");
    const now = this.#runner.now();
    let revoked = 0;
    for (const g of targets) {
      if (g.state !== "granted" && g.state !== "requested") continue;
      const ref: AggregateRef = { kind: GRANT_KIND, id: g.id };
      const expected = single ? command.expectedRevision : undefined;
      await this.#runner.command("network.revoke", { commandId: `${scopedCommandId(owner.id, command.commandId)}:${g.id.slice(4, 12)}`, actor: owner.id }, async () => ({
        payload: { grantId: g.id },
        build: async () => {
          const found = await this.#runner.get(ref.kind, ref.id);
          if (found === undefined) throw new DomainError("not_found", "no such network grant");
          if (expected !== undefined && found.revision !== expected) throw new DomainError("stale_revision", `the grant is at revision ${found.revision}`, { currentRevision: found.revision });
          const prior = found.body as unknown as GrantBody;
          if (prior.state !== "granted" && prior.state !== "requested") return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found.revision }], detail: { taskId: prior.taskId, host: prior.host, port: prior.port, already: prior.state } };
          const body: GrantBody = { ...prior, state: "revoked", endedAt: now, endedBy: owner.id };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject }], detail: { taskId: prior.taskId, host: prior.host, port: prior.port, was: prior.state } };
        },
      }));
      revoked++;
      const after = await this.#runner.get(GRANT_KIND, g.id);
      if (after !== undefined) this.#told(this.#view(after));
    }
    return { revoked };
  }

  async #ofTask(taskId: string): Promise<GrantView[]> {
    const out: GrantView[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(GRANT_KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 1000 });
      for (const p of page) { after = p.id; if ((p.body as unknown as GrantBody).taskId === taskId) out.push(this.#view(p)); }
      if (page.length < 1000) return out.sort((a, b) => (a.host + a.port < b.host + b.port ? -1 : 1));
    }
  }

  /** The grants of a task, for the owner and for those who work the task. */
  async forTask(by: Principal, taskId: string): Promise<GrantView[]> {
    const id = checkTaskId(taskId);
    const task = (await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined;
    if (task === undefined) return [];
    if (!(by.kind === "owner" || allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id } }) || allows(by, "history.read", task.projectId))) return [];
    return this.#ofTask(id);
  }

  /**
   * What the relay asks at every connection and again while one is open: whether the task holds a live grant for exactly this destination. A grant is live while it is granted and its task has not ended. This is a read, not a command: it
   * writes nothing, so a refused connection costs the store only the log entry the relay writes.
   */
  async check(taskId: string, host: string, port: number): Promise<GrantCheck> {
    const found = await this.#runner.get(GRANT_KIND, grantId(taskId, host, port));
    if (found === undefined) return { live: false, why: "the task holds no grant for that destination" };
    const grant = this.#view(found);
    if (grant.state === "requested") return { grant, live: false, why: "the grant has been asked for and the owner has not approved it" };
    if (grant.state === "denied") return { grant, live: false, why: "the owner refused the request" };
    if (grant.state === "revoked") return { grant, live: false, why: "the grant was revoked" };
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined || task.state === "done" || task.state === "cancelled") return { grant, live: false, why: "the task has ended, and its grants with it" };
    return { grant, live: true };
  }

  // ---- the connection log (written by the relay and the web tool; not an operation of the state API) ----------------------------------

  /** Writes the record of a connection. `commandId` is made here; the id of the record is returned for `close`. A log that cannot be written fails: no connection goes ahead unrecorded. */
  async logOpen(entry: Omit<ConnectionBody, "outcome" | "bytesToTarget" | "bytesFromTarget" | "startedAt"> & { outcome: "open" | "refused" | "failed" }): Promise<string> {
    const id = derivedId("ncn", randomUUID());
    const ref: AggregateRef = { kind: connKind(entry.taskId), id };
    const now = this.#runner.now();
    const body: ConnectionBody = { ...entry, ...(entry.reason === undefined ? {} : { reason: redactText(entry.reason).slice(0, 300) }), bytesToTarget: 0, bytesFromTarget: 0, startedAt: now, ...(entry.outcome === "open" ? {} : { endedAt: now }) };
    await this.#runner.command("network.connection", { commandId: `ncn:${id}`, actor: "service:dispatcher" }, async () => ({
      payload: { taskId: entry.taskId, host: entry.host, port: entry.port, outcome: entry.outcome },
      build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { taskId: entry.taskId, attemptId: entry.attemptId, host: entry.host, port: entry.port, outcome: entry.outcome, via: entry.via } }),
    }));
    return id;
  }

  /** Completes a record `logOpen` made: how it ended and the bytes that passed each way. */
  async logClose(taskId: string, id: string, ended: { readonly outcome: "closed" | "failed"; readonly endedBy: NonNullable<ConnectionBody["endedBy"]>; readonly bytesToTarget: number; readonly bytesFromTarget: number; readonly reason?: string }): Promise<void> {
    const ref: AggregateRef = { kind: connKind(taskId), id };
    const now = this.#runner.now();
    await this.#runner.command("network.connection.end", { commandId: `ncn-end:${id}`, actor: "service:dispatcher" }, async () => ({
      payload: { id },
      build: async () => {
        const found = await this.#runner.get(ref.kind, id);
        if (found === undefined) throw new DomainError("not_found", "no such connection record");
        const prior = found.body as unknown as ConnectionBody;
        if (prior.outcome !== "open") return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found.revision }], detail: { already: prior.outcome } };
        const body: ConnectionBody = { ...prior, outcome: ended.outcome, endedBy: ended.endedBy, bytesToTarget: ended.bytesToTarget, bytesFromTarget: ended.bytesFromTarget, endedAt: now, ...(ended.reason === undefined ? {} : { reason: redactText(ended.reason).slice(0, 300) }) };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject }], detail: { endedBy: ended.endedBy, bytesToTarget: ended.bytesToTarget, bytesFromTarget: ended.bytesFromTarget } };
      },
    }));
  }

  /** How many connection records a task's attempt has written (the cap that stops a hostile worker from filling the store with refused attempts). */
  async loggedFor(taskId: string, attemptId: string): Promise<number> {
    let count = 0;
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(connKind(taskId), { ...(after === undefined ? {} : { afterId: after }), limit: 1000 });
      for (const p of page) { after = p.id; if ((p.body as unknown as ConnectionBody).attemptId === attemptId) count++; }
      if (page.length < 1000) return count;
    }
  }

  /** The connections of a task, oldest first: for the owner and for those who work or read the task. */
  async connections(by: Principal, taskId: string, options: { readonly limit?: number } = {}): Promise<ConnectionView[]> {
    const id = checkTaskId(taskId);
    const task = (await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined;
    if (task === undefined) return [];
    if (!(by.kind === "owner" || allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id } }) || allows(by, "history.read", task.projectId))) return [];
    const cap = Math.min(options.limit ?? NETWORK_LIMITS.page, NETWORK_LIMITS.page);
    const out: ConnectionView[] = [];
    for (let after: string | undefined; out.length < cap;) {
      const page = await this.#runner.list(connKind(id), { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const p of page) { after = p.id; out.push({ ...(p.body as unknown as ConnectionBody), id: p.id }); }
      if (page.length < 200) break;
    }
    return out.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1)).slice(0, cap);
  }
}

import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { JsonObject } from "../storage/types.js";
import type { MaintenanceLeaseService } from "./leases.js";
import type { ProjectResourceService } from "./resources.js";
import type { ResponsibilityService } from "./responsibilities.js";

/**
 * Card P04, "a remote host is managed through an approved tool with no worker enrolled on it": the acting half (P04i only watches). An agent that answers for a responsibility changes a managed service on a host where no worker runs,
 * from the controller's side, through `nimblenewt.remote-action`, a built-in tool of the bridge. Nothing here is a new state machine: each step is a production piece that already exists.
 *
 * - **Approved tool.** The tool is reached only through `tool.invoke` (the dispatcher's tool path): the agent needs the owner's grant `tool.nimblenewt.remote-action`, the call is classed `mutate` by the approval policy (so under the
 *   strict profile it waits for the owner, under derived it is reviewed outside development and testing), budgets and pauses apply, and the call is a durable operation of the attempt.
 * - **Approved reach.** Every request goes through the web tool's admission (`WebFetch.act`): only to a host and port the task holds a live network grant for (private and loopback addresses only when the owner's grant names them),
 *   to the one checked address, with no redirect followed, logged in the task's connection log as `remote-action`. And only to the managed resource's own address: the resource's locator gives the scheme, host and port; the agent
 *   gives only paths on it.
 * - **Under the lease.** The maintenance lease on the resource is taken for the agent (`MaintenanceLeaseService.acquire`, which checks the agent may maintain it and that the responsibility is active). Another agent's lease is a
 *   visible block and nothing is sent; so is the agent's own lease taken by another call (two calls of one agent never act on one resource at once). The responsibility's maintenance window holds the change: nothing is sent
 *   while one is on. Anything that fails before the lease is held is a refusal (nothing sent); the lease is held at least 5 minutes, longer than the three requests' time bounds together.
 * - **Validated, and the outcome recorded as leases record it.** After the action, the check path is asked (GET) and its status judged. The lease is released with that validation (`release`): passed; or failed with `rollback`, only
 *   when the agent gave a rollback request, the responsibility permits the action `rollback` and that request succeeded; otherwise failed with `escalate` (an incident, escalated at once). The history entry, incident and escalation
 *   are the lease service's own.
 *
 * Only statuses come back, never a server's text. The call is not run again after a restart (a built-in tool is not replay-safe): an interrupted one is uncertain, and its lease runs out at its time.
 */
export const REMOTE_ACTION_TOOL = {
  name: "nimblenewt.remote-action",
  version: "1.0.0",
  purpose: "Changes a managed service on a remote host with no worker there, under the responsibility's maintenance lease: sends one request to the service's own address, checks it, and records the outcome (passed, rolled back if the responsibility permits rollback, else escalated). Needs a network grant of the task for that host and port.",
  input: {
    type: "object", required: ["resourceId", "purpose", "action", "check"], additionalProperties: false,
    properties: {
      resourceId: { type: "string", minLength: 1, maxLength: 100 },
      purpose: { type: "string", minLength: 1, maxLength: 300 },
      action: { $ref: "#/$defs/request" },
      check: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", minLength: 1, maxLength: 500 }, expectStatus: { type: "array", minItems: 1, maxItems: 10, items: { type: "integer", minimum: 100, maximum: 599 } } } },
      rollback: { $ref: "#/$defs/request" },
      minutes: { type: "integer", minimum: 5, maximum: 120 },
    },
    $defs: {
      request: { type: "object", required: ["method", "path"], additionalProperties: false, properties: { method: { enum: ["POST", "PUT", "PATCH", "DELETE"] }, path: { type: "string", minLength: 1, maxLength: 500 }, body: { type: "object" } } },
    },
  } as JsonObject,
  output: {
    type: "object", required: ["outcome", "resourceId"],
    properties: {
      outcome: { enum: ["passed", "rolled-back", "escalated", "blocked"] }, resourceId: { type: "string" }, holder: { type: "string" }, until: { type: "string" },
      action: { type: "object" }, check: { type: "object" }, rollback: { type: "object" }, incidentId: { type: "string" }, note: { type: "string" },
    },
  } as JsonObject,
} as const;

export const REMOTE_ACTION_LIMITS = { body: 16 * 1024, defaultMinutes: 15 } as const;

type Method = "POST" | "PUT" | "PATCH" | "DELETE";
interface RequestSpec { readonly method: Method; readonly path: string; readonly body?: JsonObject }
/** What one request came to: a status, or why nothing came back (never the server's text); `sent: false` when it was refused before anything went out (admission, the grant's credential, the address). */
type Sent = { readonly status: number } | { readonly error: string; readonly sent: boolean };

export interface RemoteActionDeps {
  readonly leases: Pick<MaintenanceLeaseService, "acquire" | "release" | "list">;
  readonly resources: Pick<ProjectResourceService, "get">;
  readonly duties: Pick<ResponsibilityService, "get" | "status">;
  /** The web tool's guarded request (`WebFetch.act`) and its grant check, so nothing is leased for a destination the task cannot reach. */
  readonly web: { act(ctx: { taskId: string; projectId: string; attemptId: string; agentId?: string }, url: string, method: "GET" | Method, body: unknown, signal?: AbortSignal): Promise<{ readonly status: number }> };
  /** The responsibility whose claim holds the resource (`ProjectResourceService.heldClaim`), for its maintenance window before the lease is asked. */
  readonly claimOf: (resourceId: string) => Promise<string | undefined>;
  readonly reachable: (taskId: string, host: string, port: number, agentId?: string) => Promise<{ readonly live: boolean; readonly why?: string }>;
}

/** The tool as the bridge runs it (`BuiltinTool`, structurally: this module does not depend on the bridge). */
export interface RemoteActionTool {
  readonly name: string; readonly version: string; readonly purpose: string; readonly input: JsonObject; readonly output: JsonObject;
  /** Run through the effect ledger (the approval class is `mutate`): one effect per call, on the resource. */
  readonly effect: { readonly kind: string; target(input: JsonObject): string };
  run(call: { readonly attemptId: string; readonly taskId: string; readonly projectId: string; readonly agent: Principal; readonly callId?: string }, input: JsonObject, signal: AbortSignal): Promise<JsonObject>;
}

const refuse = (message: string, field?: string): never => { throw new DomainError("invalid_command", message, field === undefined ? undefined : { field }); };

/** A path on the service's own address: begins with one `/`, no `#`, no spaces or control characters, no `..` segment, and it must stay on the same scheme, host and port. */
function onOrigin(origin: URL, path: string, field: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("#") || /[\s\x00-\x1f\x7f\\]/.test(path)) refuse(`${field}: must be a path on the service's address, beginning with one /`, field);
  // Every spelling the URL parser reads as a parent segment ("..", ".%2e", "%2e.", "%2e%2e").
  if (path.split("?")[0]!.split("/").some((seg) => /^(?:\.|%2e){2}$/i.test(seg))) refuse(`${field}: must not contain '..'`, field);
  const url = new URL(path, origin);
  if (url.origin !== origin.origin) refuse(`${field}: must stay on the service's address`, field);
  if (redactText(decodeURIComponentSafe(path)) !== decodeURIComponentSafe(path)) refuse(`${field}: looks like it carries a credential; credentials go in the network grant, never in a path`, field);
  return url.href;
}
const decodeURIComponentSafe = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
const shown = (url: string): string => { const u = new URL(url); return u.pathname; };
const good = (sent: Sent, expect?: readonly number[]): boolean => "status" in sent && (expect === undefined ? sent.status >= 200 && sent.status < 300 : expect.includes(sent.status));
const said = (sent: Sent): string => ("status" in sent ? `answered ${sent.status}` : sent.sent ? `failed (${sent.error})` : `was refused before it was sent (${sent.error})`);
/** A refusal of `WebFetch.act` that says nothing went out: admission's `NetworkRefused`, or a typed refusal other than `unavailable` (which the web tool also uses for a request that failed after it was sent). */
const refusedBeforeSending = (error: unknown): boolean => (error instanceof DomainError ? error.code !== "unavailable" : error instanceof Error && error.name === "NetworkRefused");
const ownLease = (resourceId: string, holder: string, until: string | undefined): JsonObject => ({ outcome: "blocked", resourceId, holder, until: until ?? "", note: "this agent already holds the maintenance lease on this resource for another call (or one that stopped, until it runs out); nothing was sent" });
const why = (error: unknown): string => redactText(error instanceof Error ? error.message : "error").slice(0, 160);

/** Builds the tool over the production services. */
export function remoteActionTool(deps: RemoteActionDeps): RemoteActionTool {
  return {
    name: REMOTE_ACTION_TOOL.name, version: REMOTE_ACTION_TOOL.version, purpose: REMOTE_ACTION_TOOL.purpose, input: REMOTE_ACTION_TOOL.input, output: REMOTE_ACTION_TOOL.output,
    effect: { kind: "remote-action", target: (input) => `resource:${String(input["resourceId"]).slice(0, 100)}` },
    run: async (call, input, signal) => {
      // Before the lease is taken nothing has been sent: any failure up to there is a refusal (a failed effect, nothing done), never an uncertain one the owner has to resolve.
      let prepared: Awaited<ReturnType<typeof prepare>>;
      try { prepared = await prepare(call, input); } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError("unavailable", `the remote action could not be prepared (${why(error)}); nothing was sent`);
      }
      if ("blocked" in prepared) return prepared.blocked;
      return act(prepared, signal);
    },
  };

  async function prepare(call: Parameters<RemoteActionTool["run"]>[0], input: JsonObject) {
    const agent = call.agent;
    const resourceId = input["resourceId"] as string;
    const purpose = (input["purpose"] as string).trim();
    if (purpose.length === 0) refuse("purpose: say what the change is for", "purpose");
    const action = input["action"] as unknown as RequestSpec;
    const check = input["check"] as unknown as { path: string; expectStatus?: number[] };
    const rollback = input["rollback"] as unknown as RequestSpec | undefined;
    for (const [field, r] of [["action", action], ["rollback", rollback]] as const) {
      if (r?.body !== undefined && Buffer.byteLength(JSON.stringify(r.body), "utf8") > REMOTE_ACTION_LIMITS.body) refuse(`${field}.body: must be at most ${REMOTE_ACTION_LIMITS.body} bytes of JSON`, `${field}.body`);
    }
    // The resource and its address: only a managed service of this task's project with an http(s) address can be acted on.
    const resource = await deps.resources.get(agent, resourceId);
    if (resource === undefined || resource.projectId !== call.projectId || resource.state !== "bound") throw new DomainError("not_found", "no such resource in this task's project");
    let origin: URL;
    try { origin = new URL(resource.locator); } catch { return refuse("resourceId: the resource has no web address, so this tool cannot act on it", "resourceId"); }
    if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.username !== "" || origin.password !== "") refuse("resourceId: the resource's address is not a plain http or https address", "resourceId");
    const actionUrl = onOrigin(origin, action.path, "action.path");
    const checkUrl = onOrigin(origin, check.path, "check.path");
    const rollbackUrl = rollback === undefined ? undefined : onOrigin(origin, rollback.path, "rollback.path");
    const agentId = agent.id.startsWith("agent:") ? agent.id : undefined;
    const ctx = { taskId: call.taskId, projectId: call.projectId, attemptId: call.attemptId, ...(agentId === undefined ? {} : { agentId }) };
    // The grant is looked at before the lease is taken, so a task that cannot reach the host leases nothing (each request is still admitted on its own).
    const host = origin.hostname.replace(/^\[|\]$/g, "");
    const port = origin.port === "" ? (origin.protocol === "https:" ? 443 : 80) : Number(origin.port);
    const reach = await deps.reachable(call.taskId, host, port, agentId);
    if (!reach.live) throw new DomainError("forbidden", `this task holds no live network grant for ${host}:${port}; ask the owner for one (${(reach.why ?? "no grant").slice(0, 120)})`);
    // One call of the attempt is one lease holding and one release, whatever happens: a second call is a new key (the bridge gives the model's call ID).
    if (call.callId === undefined) throw new DomainError("unavailable", "the call has no ID, so its lease commands could not be told apart; nothing was sent");
    const key = createHash("sha256").update(`${call.attemptId}\0${call.callId}`).digest("hex").slice(0, 32);
    // The responsibility's maintenance window holds a change (P04: "hold any change until it ends"); asked before the lease, which also decides who may maintain the resource.
    const claimed = await deps.claimOf(resourceId);
    const status = claimed === undefined ? undefined : await deps.duties.status(agent, claimed);
    if (status?.inMaintenanceWindow === true) throw new DomainError("invalid_transition", "a maintenance window of this responsibility is on: changes are held until it ends; nothing was sent");
    // The agent's own lease, still in time, is looked at before asking: the lease service would renew it (a later expiry, this call's purpose), so asking would keep extending a holding this call does not own
    // (one that stopped would never run out while the agent kept trying). Nothing is asked, sent or changed; the renewal check below still covers two calls that both get past this look at once.
    const [current] = (await deps.leases.list(agent, resource.projectId, { resourceId })) ?? [];
    if (current !== undefined && current.status === "held" && current.holderId === agent.id) return { blocked: ownLease(resourceId, current.holderId, current.expiresAt) };
    const leased = await deps.leases.acquire(agent, { commandId: `rax-acq-${key}`, resourceId, purpose: `${purpose} (remote action)`.slice(0, 300), minutes: (input["minutes"] as number | undefined) ?? REMOTE_ACTION_LIMITS.defaultMinutes });
    // A block names the holder; the holder is this agent when another call of its own renewed the lease between this call's grant and its read.
    if (leased.status === "blocked") return { blocked: leased.lease.holderId === agent.id ? ownLease(resourceId, agent.id, leased.lease.expiresAt) : { outcome: "blocked", resourceId, holder: leased.lease.holderId ?? "", until: leased.lease.expiresAt ?? "", note: "another agent holds the maintenance lease on this resource; nothing was sent" } as JsonObject };
    // The lease service renews a lease for the agent that already holds it. A renewal here means another call of this agent is acting on the resource (or one that stopped left the lease to run out): this call
    // sends nothing and does not release a holding that is not its own, so two calls never act on one resource at once.
    if (leased.lease.renewals > 0) return { blocked: ownLease(resourceId, leased.lease.holderId ?? agent.id, leased.lease.expiresAt) };
    return { agent, resourceId, action, check, rollback, actionUrl, checkUrl, rollbackUrl, ctx, key, leased };
  }

  async function act(p: Exclude<Awaited<ReturnType<typeof prepare>>, { blocked: JsonObject }>, signal: AbortSignal): Promise<JsonObject> {
    const { agent, resourceId, action, check, rollback, actionUrl, checkUrl, rollbackUrl, ctx, key, leased } = p;
    const release = (validation: "passed" | "failed", evidence: string, onFailure?: "rollback" | "escalate") =>
      deps.leases.release(agent, { commandId: `rax-rel-${key}`, resourceId, validation, evidence: evidence.slice(0, 300), ...(onFailure === undefined ? {} : { onFailure }) });
    try {
      const send = async (url: string, method: "GET" | Method, body?: JsonObject): Promise<Sent> => {
        try { return await deps.web.act(ctx, url, method, body, signal); } catch (error) { return { error: why(error), sent: !refusedBeforeSending(error) }; }
      };
      const acted = await send(actionUrl, action.method, action.body);
      // The action was refused before it went out (the grant changed since it was looked at, the name now resolves to an address the grant does not allow): the service was not touched, so there is nothing to
      // check or roll back. The lease still ends as a failed maintenance, escalated, so the owner hears that the change could not be made.
      if ("error" in acted && !acted.sent) {
        const out = await release("failed", `${action.method} ${shown(actionUrl)} ${said(acted)}; nothing was sent`, "escalate");
        return { outcome: "escalated", resourceId, action: { method: action.method, path: shown(actionUrl), error: acted.error }, ...(out.incidentId === undefined ? {} : { incidentId: out.incidentId }), note: "the request was refused before it was sent; nothing reached the service; escalated" };
      }
      const checked: Sent | undefined = good(acted) ? await send(checkUrl, "GET") : undefined;
      const bare = (sent: Sent) => ("status" in sent ? { status: sent.status } : { error: sent.error });
      const shownAction = { method: action.method, path: shown(actionUrl), ...bare(acted) };
      if (checked !== undefined && good(checked, check.expectStatus)) {
        await release("passed", `${action.method} ${shown(actionUrl)} ${said(acted)}; check ${shown(checkUrl)} ${said(checked)}`);
        return { outcome: "passed", resourceId, action: shownAction, check: { path: shown(checkUrl), ...bare(checked) } };
      }
      const failure = checked === undefined ? `${action.method} ${shown(actionUrl)} ${said(acted)}` : `${action.method} ${shown(actionUrl)} ${said(acted)}; check ${shown(checkUrl)} ${said(checked)}`;
      const duty = await deps.duties.get(agent, leased.lease.responsibilityId);
      const permitted = duty?.permittedActions.includes("rollback") === true;
      if (rollback !== undefined && rollbackUrl !== undefined && permitted) {
        const undone = await send(rollbackUrl, rollback.method, rollback.body);
        const back = { method: rollback.method, path: shown(rollbackUrl), ...bare(undone) };
        if (good(undone)) {
          await release("failed", `${failure}; rolled back: ${rollback.method} ${shown(rollbackUrl)} ${said(undone)}`, "rollback");
          return { outcome: "rolled-back", resourceId, action: shownAction, ...(checked === undefined ? {} : { check: { path: shown(checkUrl), ...bare(checked) } }), rollback: back };
        }
        const out = await release("failed", `${failure}; the rollback ${rollback.method} ${shown(rollbackUrl)} ${said(undone)}`, "escalate");
        return { outcome: "escalated", resourceId, action: shownAction, ...(checked === undefined ? {} : { check: { path: shown(checkUrl), ...bare(checked) } }), rollback: back, ...(out.incidentId === undefined ? {} : { incidentId: out.incidentId }), note: "the rollback did not succeed; escalated" };
      }
      const out = await release("failed", failure, "escalate");
      return {
        outcome: "escalated", resourceId, action: shownAction, ...(checked === undefined ? {} : { check: { path: shown(checkUrl), ...bare(checked) } }), ...(out.incidentId === undefined ? {} : { incidentId: out.incidentId }),
        ...(rollback !== undefined && !permitted ? { note: "the responsibility does not permit rollback, so none was sent; escalated" } : {}),
      };
    } catch (error) {
      // Something stopped the call after the lease was taken (a refused release, an abort): the lease is given back as a failed maintenance so the owner hears of it. A release already recorded is not repeated (its
      // command ID is the same, so a second one is a replay or refused as a different command); a failure here leaves the lease to run out at its time.
      await release("failed", `the remote action stopped before its outcome was recorded: ${why(error)}`, "escalate").catch(() => undefined);
      // Requests may have been sent: never a typed refusal (which the ledger reads as "nothing was done"), so the effect is left uncertain. The text goes on the effect's evidence: cleaned like the rest.
      throw new Error(`the remote action stopped after it began: ${why(error)}`);
    }
  }
}

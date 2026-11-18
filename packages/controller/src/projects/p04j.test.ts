import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { CatalogService } from "../catalog/index.js";
import { DeskService } from "../context/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { DispatcherService } from "../dispatch/dispatcher.js";
import { buildWorld, workGrants, type DispatchWorld } from "../dispatch/testing/world.js";
import { NetworkGrantService, WebFetch } from "../network/index.js";
import type { Grant } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { ToolExecutionService, type BoundGateway, type BridgeResponse } from "../toolbridge/index.js";
import { IncidentService, MaintenanceLeaseService, ResponsibilityService, remoteActionTool } from "./index.js";

/**
 * Card P04 (P04j): a remote host is managed through an approved tool with no worker enrolled on it. The stand-in host is an HTTP server on 127.0.0.1 that no worker runs on; the agent works on the enrolled
 * worker host `host:w1` and acts on the stand-in only through `nimblenewt.remote-action`, a built-in tool of the real bridge: the tool grant, the approval policy and the dispatcher's durable call record, the
 * task's network grant, and the production maintenance lease (acquire, then release with the validation outcome).
 */

after(stopServer);

let n = 0;
const uid = (label: string): string => `${label}-${n++}`;
const good = (r: BridgeResponse): JsonObject => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { result: JsonObject }).result; };
const output = (r: JsonObject): JsonObject => { assert.equal(r["state"], "confirmed", JSON.stringify(r)); return JSON.parse(r["text"] as string) as JsonObject; };
const TOOL = "nimblenewt.remote-action";

interface Seen { readonly method: string; readonly path: string; readonly body: string; readonly agent: string }
/** The stand-in host: answers each method and path as `routes` says (default 200), and keeps what it was sent. */
async function standIn(): Promise<{ server: Server; port: number; seen: Seen[]; routes: Map<string, number> }> {
  const seen: Seen[] = [];
  /** A status of 0 never answers (the request runs into the web tool's time bound); a 3xx points elsewhere. */
  const routes = new Map<string, number>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", body: Buffer.concat(chunks).toString("utf8"), agent: String(req.headers["user-agent"] ?? "") });
      const status = routes.get(`${req.method} ${req.url}`) ?? 200;
      if (status === 0) return;
      res.writeHead(status, { "content-type": "text/plain", ...(status >= 300 && status < 400 ? { location: "/elsewhere" } : {}) });
      res.end("server text that must never reach the agent");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, seen, routes };
}

for (const backend of backends) {
  interface Ctx extends DispatchWorld {
    svc: ToolExecutionService; duties: ResponsibilityService; incidents: IncidentService; leases: MaintenanceLeaseService; network: NetworkGrantService;
    host: { port: number; seen: Seen[]; routes: Map<string, number> };
    /** A responsibility answered by the agent, managing a service bound at the stand-in's address. */
    duty(answerer: string, extra?: Record<string, unknown>): Promise<{ duty: string; resource: string }>;
    agentFor(name: string, extra?: Grant[]): Promise<{ id: string; aid: string }>;
    /** Runs one attempt of a task assigned to the agent; `body` gets the bridge bound to it. */
    attempt(agent: { aid: string }, body: (s: Session, taskId: string) => Promise<void>, grantNetwork?: boolean): Promise<string>;
  }
  interface Session { readonly gateway: BoundGateway; send(op: string, args?: JsonObject, callId?: string): Promise<BridgeResponse> }

  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      const host = await standIn();
      try {
        const w = await buildWorld(store.storage);
        const desks = DeskService.withEpoch(w.storage, w.epoch, w.options);
        const catalog = CatalogService.withEpoch(w.storage, w.epoch, desks, w.options);
        const duties = ResponsibilityService.withEpoch(w.storage, w.epoch, w.options);
        const incidents = IncidentService.withEpoch(w.storage, w.epoch, duties, w.options);
        const leases = MaintenanceLeaseService.withEpoch(w.storage, w.epoch, duties, incidents, w.options);
        const network = NetworkGrantService.withEpoch(w.storage, w.epoch, w.options);
        const web = new WebFetch({ grants: network, resolve: async () => { throw new Error("no name lookups in this test"); }, timeoutMs: 1500 });
        const tool = remoteActionTool({ leases, resources: w.resources, duties, claimOf: async (id) => (await w.resources.heldClaim(id))?.responsibilityId, web, reachable: (t, h, p, a) => network.check(t, h, p, a) });
        const serviceOver = (dispatcher: Pick<DispatcherService, "get" | "toolOperation">): ToolExecutionService =>
          new ToolExecutionService({ principal: w.dispatcherPrincipal, credentials: w.credentials, dispatch: dispatcher, assignments: w.assignments, catalog, hosts: w.hosts, admission: w.admission, runner: { run: async () => { throw new Error("no scripts here"); } }, pauses: w.pauses, desks, builtins: [tool], facts: async () => ({ os: "linux", arch: "x64", interpreters: {}, packages: {}, cpus: 8, memoryMb: 16_384 }), isLocalHost: () => true });
        let failure: unknown;
        const c: Ctx = Object.assign(w, {
          svc: serviceOver({ get: (...a: Parameters<DispatcherService["get"]>) => c.dispatcher.get(...a), toolOperation: (...a: Parameters<DispatcherService["toolOperation"]>) => c.dispatcher.toolOperation(...a) } as never),
          duties, incidents, leases, network, host,
          agentFor: async (nm: string, extra: Grant[] = []) => w.agent(nm, [...workGrants(w.project), { action: "resource.read", project: w.project }, { action: "responsibility.read", project: w.project }, ...extra]),
          duty: async (answerer: string, extra: Record<string, unknown> = {}) => {
            const res = await w.resources.bindResource(w.owner, { commandId: uid("b"), projectId: w.project, kind: "service", label: `Web ${n++}`, locator: `http://127.0.0.1:${host.port}/` } as never);
            const duty = (await duties.create(w.owner, { commandId: uid("r"), projectId: w.project, title: "Keep the web service healthy", objective: "Up", ownerId: answerer, managed: [res.id], ...extra } as never)).id;
            return { duty, resource: res.id };
          },
          attempt: async (agent: { aid: string }, script: (s: Session, taskId: string) => Promise<void>, grantNetwork = true) => {
            const { taskId } = await w.task("tend the web service", agent);
            // The owner grants the task the stand-in's host and port, naming it as a loopback address (the only way a private address is reachable).
            if (grantNetwork) await network.grant(w.owner, { commandId: uid("ng"), taskId, host: "127.0.0.1", port: host.port, allowPrivate: true, reason: "the managed web service" });
            w.worker.script = async ({ order, gateway }) => {
              const send = (op: string, args: JsonObject = {}, callId: string = uid("call")) => c.svc.handle(order.credential, gateway, { op, callId, args });
              try { await script({ gateway, send }, taskId); } catch (error) { failure = error; throw error; }
              return { status: "completed", text: "done" };
            };
            await w.dispatcher.tick(); await w.dispatcher.idle();
            if (failure !== undefined) throw failure;
            return taskId;
          },
        });
        c.dispatcher = c.restart();
        await c.policy.set(c.owner, { scope: "installation", commandId: uid("pol"), profile: "autonomous" });
        await body(c);
      } finally { host.server.closeAllConnections(); await new Promise((r) => host.server.close(r)); await store.close(); }
    });

  const args = (resourceId: string, extra: JsonObject = {}): JsonObject => ({ tool: TOOL, input: { resourceId, purpose: "restart the web service", action: { method: "POST", path: "/admin/restart", body: { graceful: true } }, check: { path: "/health" }, ...extra } });

  suite("under the strict policy the owner approves the call; the agent then acts on the stand-in host with no worker there, the check passes and the lease records it", async (c) => {
    await c.policy.set(c.owner, { scope: "installation", commandId: uid("pol"), expectedRevision: 1, profile: "strict" });
    const ann = await c.agentFor("ann", [{ action: `tool.${TOOL}`, project: c.project }]);
    const { duty, resource } = await c.duty(ann.id);
    let parked: JsonObject | undefined; let done: JsonObject | undefined; let again: JsonObject | undefined; let sentBeforeApproval = -1;
    const taskId = await c.attempt(ann, async (s) => {
      parked = good(await s.send("tool.invoke", args(resource), "act-1"));
      sentBeforeApproval = c.host.seen.length;
      const review = (await c.reviews.get(c.owner, parked["reviewId"] as string))!;
      await c.reviews.decide(c.owner, { commandId: uid("dec"), requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "restart approved" });
      done = good(await s.send("tool.invoke", args(resource), "act-1"));
      // Asking again with the same call ID answers from the record: nothing is sent again.
      again = good(await s.send("tool.invoke", args(resource), "act-1"));
    });
    assert.equal(parked!["state"], "awaiting-approval", "a mutate call waits for the owner under the strict profile");
    assert.equal(sentBeforeApproval, 0, "nothing reached the host before the approval");
    const out = output(done!);
    assert.equal(out["outcome"], "passed", JSON.stringify(out));
    assert.deepEqual((out["action"] as JsonObject)["status"], 200);
    assert.ok(!JSON.stringify(out).includes("server text"), "the server's text never comes back");
    // The stand-in host saw the action and then the check, from the controller (no worker is enrolled on it: the only enrolled host is the agent's own worker host).
    assert.deepEqual(c.host.seen.map((x) => [x.method, x.path]), [["POST", "/admin/restart"], ["GET", "/health"]]);
    assert.deepEqual(JSON.parse(c.host.seen[0]!.body), { graceful: true });
    assert.match(c.host.seen[0]!.agent, /^NimbleNewt/);
    const enrolled = (await c.hosts.list(c.owner)).items.map((h) => h.hostId);
    assert.deepEqual(enrolled, ["host:w1"]);
    // The lease went through a whole holding: taken by the agent, released with a passed validation; the history says so.
    const [lease] = (await c.leases.list(c.owner, c.project, { resourceId: resource }))!;
    assert.deepEqual([lease!.status, lease!.generation, lease!.lastRelease?.by, lease!.lastRelease?.validation, lease!.lastRelease?.forced], ["free", 1, ann.id, "passed", false]);
    assert.match(lease!.lastRelease!.evidence, /POST \/admin\/restart answered 200; check \/health answered 200/);
    const history = (await c.duties.history(c.owner, duty, { limit: 20 }))!.items;
    assert.ok(history.some((h) => h.kind === "intervention" && h.outcome === "ok"), JSON.stringify(history.map((h) => [h.kind, h.outcome])));
    // Each request is in the task's connection log as a remote action.
    const log = await c.network.connections(c.owner, taskId);
    assert.deepEqual(log.map((l) => [l.via, l.outcome]).sort(), [["remote-action", "closed"], ["remote-action", "closed"]]);
    assert.equal(again!["state"], "confirmed", JSON.stringify(again));
    // The repeat answers with the tool's own outcome (the operation keeps it), not the general words.
    assert.deepEqual(output(again!), out);
    assert.equal(c.host.seen.length, 2, "the repeat sent nothing");
  });

  suite("a failed check is rolled back only when the responsibility permits rollback; otherwise it is escalated, and either way recorded on the lease", async (c) => {
    const ann = await c.agentFor("ann", [{ action: `tool.${TOOL}`, project: c.project }]);
    const permitted = await c.duty(ann.id, { permittedActions: ["rollback"], escalation: { to: "owner" } });
    const strict = await c.duty(ann.id, { escalation: { to: "owner" } });
    c.host.routes.set("GET /health", 503);
    const outs: JsonObject[] = [];
    await c.attempt(ann, async (s) => {
      outs.push(output(good(await s.send("tool.invoke", args(permitted.resource, { rollback: { method: "POST", path: "/admin/undo" } })))));
      outs.push(output(good(await s.send("tool.invoke", args(strict.resource, { rollback: { method: "POST", path: "/admin/undo" } })))));
      c.host.routes.set("POST /admin/restart", 500);
      outs.push(output(good(await s.send("tool.invoke", args(permitted.resource, { rollback: { method: "POST", path: "/admin/undo" } })))));
    });
    assert.deepEqual(outs.map((o) => o["outcome"]), ["rolled-back", "escalated", "rolled-back"], JSON.stringify(outs));
    assert.match(String(outs[1]!["note"]), /does not permit rollback/);
    assert.ok(typeof outs[1]!["incidentId"] === "string");
    // The host saw: restart, check, undo (permitted); restart, check, no undo (not permitted); a failed restart is not checked but is undone.
    assert.deepEqual(c.host.seen.map((x) => `${x.method} ${x.path}`), ["POST /admin/restart", "GET /health", "POST /admin/undo", "POST /admin/restart", "GET /health", "POST /admin/restart", "POST /admin/undo"]);
    const leaseOf = async (resource: string) => (await c.leases.list(c.owner, c.project, { resourceId: resource }))![0]!;
    const rolled = await leaseOf(permitted.resource);
    assert.deepEqual([rolled.status, rolled.generation, rolled.lastRelease?.validation, rolled.lastRelease?.response], ["free", 2, "failed", "rollback"]);
    const escalated = await leaseOf(strict.resource);
    assert.deepEqual([escalated.status, escalated.lastRelease?.validation, escalated.lastRelease?.response], ["free", "failed", "escalate"]);
    // The escalation is the lease service's own: one incident on the strict responsibility, escalated at once to the owner; none on the one that rolled back.
    const open = (await c.incidents.list(c.owner, c.project))!;
    assert.deepEqual(open.map((i) => [i.responsibilityId, i.signature, i.state, i.escalatedTo]), [[strict.duty, `maintenance-validation:${strict.resource}`, "open", "owner"]]);
    for (const d of [permitted.duty, strict.duty]) {
      const items = (await c.duties.history(c.owner, d, { limit: 20 }))!.items.filter((h) => h.kind === "intervention");
      assert.ok(items.length > 0 && items.every((h) => h.outcome === "failed"), JSON.stringify(items.map((h) => [h.kind, h.outcome])));
    }
  });

  suite("another agent's lease blocks visibly and nothing is sent; no grant, a path off the service, no tool grant and a maintenance window each refuse with nothing sent or leased", async (c) => {
    const ann = await c.agentFor("ann", [{ action: `tool.${TOOL}`, project: c.project }]);
    const bob = await c.agentFor("bob", [{ action: `tool.${TOOL}`, project: c.project }, { action: "responsibility.write", project: c.project }]);
    const cat = await c.agentFor("cat");
    const { resource } = await c.duty(ann.id);
    const bobP = await c.principals.authenticate((await c.principals.issueCredential(c.owner, bob.id)).token);
    const held = await c.leases.acquire(bobP, { commandId: uid("l"), resourceId: resource, purpose: "renew the certificate" });
    assert.equal(held.status, "granted");
    let blocked: JsonObject | undefined;
    const refused: JsonObject[] = [];
    await c.attempt(ann, async (s) => {
      blocked = output(good(await s.send("tool.invoke", args(resource))));
      refused.push(good(await s.send("tool.invoke", args(resource, { action: { method: "POST", path: "//elsewhere.example/x" } }))));
      refused.push(good(await s.send("tool.invoke", args(resource, { check: { path: "/a/../../x" } }))));
    });
    assert.deepEqual([blocked!["outcome"], blocked!["holder"]], ["blocked", bob.id]);
    const lease = (await c.leases.list(c.owner, c.project, { resourceId: resource }))![0]!;
    assert.deepEqual([lease.holderId, lease.blockedCount, lease.blocked[0]?.by], [bob.id, 1, ann.id]);
    for (const r of refused) assert.equal(r["state"], "failed", JSON.stringify(r));
    assert.match(String(refused[0]!["reason"]), /action\.path: must be a path on the service's address/);
    assert.match(String(refused[1]!["reason"]), /check\.path: must not contain '\.\.'/);
    // No network grant: refused before any lease is asked.
    const other = await c.duty(ann.id);
    let noGrant: JsonObject | undefined;
    await c.attempt(ann, async (s) => { noGrant = good(await s.send("tool.invoke", args(other.resource))); }, false);
    assert.equal(noGrant!["state"], "failed"); assert.match(String(noGrant!["reason"]), /no live network grant/);
    assert.equal((await c.leases.list(c.owner, c.project, { resourceId: other.resource }))!.length, 0, "nothing leased");
    // No tool grant: the dispatcher's tool path refuses the call.
    let noTool: BridgeResponse | undefined;
    await c.attempt(cat, async (s) => { noTool = await s.send("tool.invoke", args(other.resource)); });
    const noToolResult = good(noTool!);
    assert.equal(noToolResult["state"], "refused"); assert.match(String(noToolResult["reason"]), /holds no grant for tool\.nimblenewt\.remote-action/);
    // A maintenance window that is on holds the change.
    const windowed = await c.duty(ann.id, { maintenanceWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }] });
    let held2: JsonObject | undefined;
    await c.attempt(ann, async (s) => { held2 = good(await s.send("tool.invoke", args(windowed.resource))); });
    assert.equal(held2!["state"], "failed"); assert.match(String(held2!["reason"]), /maintenance window/);
    assert.equal((await c.leases.list(c.owner, c.project, { resourceId: windowed.resource }))!.length, 0);
    assert.equal(c.host.seen.length, 0, "the stand-in host received nothing");
  });

  suite("a redirect is not followed, a check that never answers ends the holding, the agent's own lease held by another call blocks, and a credential in the arguments is refused before anything is recorded", async (c) => {
    const ann = await c.agentFor("ann", [{ action: `tool.${TOOL}`, project: c.project }]);
    const annP = await c.principals.authenticate((await c.principals.issueCredential(c.owner, ann.id)).token);
    const redirected = await c.duty(ann.id, { escalation: { to: "owner" } });
    const hanging = await c.duty(ann.id, { escalation: { to: "owner" } });
    const ownHeld = await c.duty(ann.id);
    const secret = await c.duty(ann.id);
    const held = await c.leases.acquire(annP, { commandId: uid("l"), resourceId: ownHeld.resource, purpose: "a longer change" });
    assert.equal(held.status, "granted");
    const outs: JsonObject[] = []; let refused: BridgeResponse | undefined;
    c.host.routes.set("POST /admin/restart", 302);
    await c.attempt(ann, async (s) => {
      outs.push(output(good(await s.send("tool.invoke", args(redirected.resource)))));
      c.host.routes.set("POST /admin/restart", 200); c.host.routes.set("GET /health", 0);
      outs.push(output(good(await s.send("tool.invoke", args(hanging.resource)))));
      outs.push(output(good(await s.send("tool.invoke", args(ownHeld.resource)))));
      refused = await s.send("tool.invoke", args(secret.resource, { action: { method: "POST", path: "/admin/restart", body: { password: "hunter2-not-real" } } }));
    });
    // The redirect: the 302 is the action's answer (not 2xx), so nothing is checked, and /elsewhere is never asked.
    assert.deepEqual([outs[0]!["outcome"], (outs[0]!["action"] as JsonObject)["status"]], ["escalated", 302]);
    // The check that never answers: a failed check within the web tool's time bound, the lease given back as failed and escalated.
    assert.equal(outs[1]!["outcome"], "escalated", JSON.stringify(outs[1]));
    assert.ok(typeof (outs[1]!["check"] as JsonObject)["error"] === "string");
    for (const r of [redirected.resource, hanging.resource]) {
      const lease = (await c.leases.list(c.owner, c.project, { resourceId: r }))![0]!;
      assert.deepEqual([lease.status, lease.lastRelease?.validation, lease.lastRelease?.response], ["free", "failed", "escalate"]);
      assert.ok(!lease.lastRelease!.evidence.includes("server text"));
    }
    // The agent's own lease, held for something else: the call is blocked, sends nothing, and leaves that holding alone.
    assert.match(String(outs[2]!["note"]), /already holds the maintenance lease/);
    assert.equal(outs[2]!["outcome"], "blocked");
    const own = (await c.leases.list(c.owner, c.project, { resourceId: ownHeld.resource }))![0]!;
    assert.deepEqual([own.status, own.holderId, own.generation, own.renewals, own.purpose, own.expiresAt], ["held", ann.id, 1, 0, "a longer change", held.lease.expiresAt], "not renewed: the same end, the same purpose");
    // The credential: refused before the dispatcher records the call or the ledger its intent.
    assert.equal(refused!.ok, false, JSON.stringify(refused));
    assert.match((refused as { message: string }).message, /look like they carry a credential/);
    assert.ok(!JSON.stringify(refused).includes("hunter2"));
    assert.equal((await c.leases.list(c.owner, c.project, { resourceId: secret.resource }))!.length, 0);
    assert.deepEqual(c.host.seen.map((x) => `${x.method} ${x.path}`), ["POST /admin/restart", "POST /admin/restart", "GET /health"]);
  });
}

/** The paths that do not need storage, over stand-in services: what is released, and what kind of failure the effect ledger is told, when something goes wrong on the way. */
test("remote action: a failure before the lease is a refusal; a request refused before sending is escalated without a check or a rollback; a thrown error after the lease still releases it and is never a refusal", async () => {
  const calls: string[] = [];
  let releaseFails = 0;
  let resourceFails = false;
  let actRefused = false;
  let renewals = 0;
  const tool = remoteActionTool({
    leases: {
      acquire: async () => { calls.push("acquire"); return { status: "granted", lease: { responsibilityId: "r1", renewals, holderId: "agent:ann" } } as never; },
      list: async () => [],
      release: async (_by, cmd) => { calls.push(`release ${cmd.validation}/${cmd.onFailure ?? "-"}`); if (releaseFails-- > 0) throw new Error("storage gave way"); return { lease: {} } as never; },
    },
    resources: { get: async () => { if (resourceFails) throw new Error("storage gave way"); return { projectId: "p1", state: "bound", locator: "http://198.51.100.7:8080/" } as never; } },
    duties: { get: async () => ({ permittedActions: ["rollback"] }) as never, status: async () => ({ inMaintenanceWindow: false }) as never },
    claimOf: async () => "r1",
    reachable: async () => ({ live: true }),
    web: { act: async (_ctx, url, method) => {
      calls.push(`${method} ${new URL(url).pathname}`);
      if (actRefused) { const e = new Error("the name now resolves to an address the grant does not allow"); e.name = "NetworkRefused"; throw e; }
      return { status: method === "GET" ? 503 : 200 };
    } },
  });
  const call = { attemptId: "a1", taskId: "t1", projectId: "p1", agent: { id: "agent:ann", kind: "agent" } as never, callId: "c1" };
  const input = { resourceId: "res1", purpose: "restart", action: { method: "POST", path: "/restart" }, check: { path: "/health" }, rollback: { method: "POST", path: "/undo" } } as JsonObject;
  const signal = new AbortController().signal;

  resourceFails = true;
  await assert.rejects(tool.run(call, input, signal), (e: unknown) => e instanceof Error && e.constructor.name === "DomainError" && /nothing was sent/.test(e.message));
  assert.deepEqual(calls, [], "nothing leased or sent");
  resourceFails = false;

  // Two calls of the agent got past the look at its lease at once: the second one's ask renewed the first one's holding. It sends nothing and releases nothing (the holding is the other call's).
  renewals = 1;
  const raced = await tool.run({ ...call, callId: "c0" }, input, signal);
  assert.deepEqual([raced["outcome"], raced["holder"]], ["blocked", "agent:ann"]);
  assert.match(String(raced["note"]), /already holds the maintenance lease/);
  assert.deepEqual(calls, ["acquire"], "nothing sent or released");
  renewals = 0; calls.length = 0;

  actRefused = true;
  const refused = await tool.run({ ...call, callId: "c2" }, input, signal);
  assert.equal(refused["outcome"], "escalated");
  assert.deepEqual(calls, ["acquire", "POST /restart", "release failed/escalate"], "no check and no rollback after a request that never went out");
  actRefused = false; calls.length = 0;

  releaseFails = 1;
  await assert.rejects(tool.run({ ...call, callId: "c3" }, input, signal), (e: unknown) => e instanceof Error && e.constructor.name === "Error" && /stopped after it began/.test(e.message));
  // The check failed, the rollback was sent and its release failed; the lease was then given back as escalated.
  assert.deepEqual(calls, ["acquire", "POST /restart", "GET /health", "POST /undo", "release failed/rollback", "release failed/escalate"]);
});

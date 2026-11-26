import assert from "node:assert/strict";
import { after } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { RemoteWorkerClient } from "./client.js";
import { RemoteWorkerService, PLACEMENT_KIND, type PlacementBody } from "./service.js";
import { remoteSuite, wireRefuses, type Ctx } from "./testing/suite.js";
import { REMOTE_CAPS, type RemoteHost } from "./testing/world.js";
import { workGrants } from "../dispatch/testing/world.js";
import type { HostWorkspaceAdmission } from "./workspace-declaration.js";
import { folderDigest, hostWorkspaceAdmission, workspaceDeclaration } from "./workspace-declaration.js";

// Card P02 (remote hosts, second review): the remote service is never silently open (it refuses to be built without the folder admission), and an attempt accepted in an older session is taken up again in a new one only
// if the folder the host declares now is still admitted (a host that restarted with another `projects` folder would otherwise go on opening the task's workspace there).
after(stopServer);

const ADMITTED = "/srv/shared/garden";

for (const backend of backends) {
  // The product's reading of declarations over a folder admission that admits one folder (the binding), and can be made unreadable.
  const folder = { unreadable: false };
  const admission = hostWorkspaceAdmission(async ({ folderDigest: d }) => {
    if (folder.unreadable) throw new Error("the bindings could not be read");
    return d === folderDigest(ADMITTED) ? { admitted: true } : { admitted: false, reason: "the folder that host uses for the project is not a repository bound to the project" };
  });
  const suite = remoteSuite(backend);
  const capsFor = (c: Ctx, path: string | undefined) => ({ ...REMOTE_CAPS, workspaces: [...REMOTE_CAPS.workspaces, ...(path === undefined ? [] : [workspaceDeclaration(c.project, path)!])] });
  const reconnect = async (c: Ctx, r1: RemoteHost, key: string, path: string | undefined): Promise<RemoteWorkerClient> => {
    const fresh = new RemoteWorkerClient({ url: c.transport.url, token: r1.token, workerVersion: "w" });
    await fresh.connect(capsFor(c, path), key);
    return fresh;
  };
  const rec = async (c: Ctx, attemptId: string): Promise<PlacementBody> => (await c.storage.getAggregate({ kind: PLACEMENT_KIND, id: attemptId }))!.body as unknown as PlacementBody;

  suite("a reconnected host that now declares another folder, none, or whose admission cannot be read is not given its accepted attempt again; the attempt is not ended, and the admitted folder takes it up (card P02)", async (c) => {
    folder.unreadable = false;
    const r1 = await c.host("r1", { caps: capsFor(c, ADMITTED) });
    const { attemptId, placement } = await c.started(r1);
    assert.equal((await rec(c, attemptId)).state, "accepted");
    // Restarted with another folder for the project: refused, with the reason, and nothing changed on the placement.
    const moved = await reconnect(c, r1, "re-1", "/srv/elsewhere/garden");
    await wireRefuses("unavailable", () => moved.attempt(attemptId, placement).accept(), 503);
    const after1 = await rec(c, attemptId);
    assert.equal(after1.state, "accepted");
    assert.notEqual(after1.sessionId, moved.session!.sessionId, "the new session does not hold the attempt");
    // Restarted with no folder for the project (an older host): refused too.
    const none = await reconnect(c, r1, "re-2", undefined);
    await wireRefuses("unavailable", () => none.attempt(attemptId, placement).accept(), 503);
    // The admission cannot be read: refused (asked again later), never taken up on a guess.
    folder.unreadable = true;
    const unread = await reconnect(c, r1, "re-3", ADMITTED);
    await wireRefuses("unavailable", () => unread.attempt(attemptId, placement).accept(), 503);
    assert.notEqual((await rec(c, attemptId)).sessionId, unread.session!.sessionId);
    // Readable again, with the admitted folder: taken up in that session.
    folder.unreadable = false;
    assert.equal((await unread.attempt(attemptId, placement).accept()).placement, placement);
    assert.equal((await rec(c, attemptId)).sessionId, unread.session!.sessionId);
  }, { workspaceAdmission: admission });

  suite("an integration or a landing judged and asked is not listed for its host when what the host declares cannot be read when it reads its requests: refused, nothing sent; listed again once readable (card P02)", async (c) => {
    folder.unreadable = false;
    const r1 = await c.host("r1", { caps: capsFor(c, ADMITTED) });
    const hosts = c.hosts as unknown as { status: (...a: unknown[]) => Promise<unknown> };
    const status = hosts.status.bind(c.hosts);
    let failing = false;
    hosts.status = async (...a: unknown[]) => { if (failing) throw new Error("the host records could not be read"); return status(...a); };
    let n = 0;
    const call = (operation: "integration" | "landing") => ({ requestId: `wsr-abcdefghijklmnopqr${"abcdefghijklmnopqrstuvwxyz234567"[n++]}a`, operation, taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: c.project, reason: "the owner asked", quietAttempts: [], ...(operation === "landing" ? { landing: { branch: "main" } } : {}) });
    for (const operation of ["integration", "landing"] as const) {
      const pending = c.remote.askWorkspace(c.dispatcherPrincipal, r1.id, call(operation) as never, { waitMs: 5_000 });
      await new Promise((r) => setTimeout(r, 20));
      failing = true;
      assert.deepEqual(await r1.client.workspaceRequests(), [], `the ${operation} is not listed while the host's declaration cannot be read`);
      failing = false;
      const answer = await pending;
      assert.equal(answer.ok, false);
      assert.match((answer as { reason: string }).reason, new RegExp(`^nothing was sent to ${r1.id}, so nothing was written to the shared repository: what it declares now could not be read$`));
    }
    // Readable: a new request is listed as usual.
    const ok = c.remote.askWorkspace(c.dispatcherPrincipal, r1.id, call("landing") as never, { waitMs: 5_000 });
    await new Promise((r) => setTimeout(r, 20));
    const listed = await r1.client.workspaceRequests();
    assert.deepEqual(listed.map((r) => r.operation), ["landing"]);
    await r1.client.answerWorkspace(listed[0]!.requestId, { ok: true, summary: "landing done" });
    assert.deepEqual(await ok, { ok: true, summary: "landing done" });
  }, { workspaceAdmission: admission });

  // An admission that fails only where it is asked: at `place` (judged without `beforePin`, after the dispatcher's look passed) or for one target host.
  const gate: { place: boolean; host: string | undefined } = { place: false, host: undefined };
  const gated: HostWorkspaceAdmission = async (call) => {
    if (gate.place && call.beforePin !== true) throw new Error("the bindings could not be read at the placement");
    if (gate.host === call.hostId) throw new Error(`the bindings could not be read for ${call.hostId}`);
    return admission(call);
  };

  suite("an admission that cannot be read when the attempt is placed refuses the start: nothing is offered to the host (card P02)", async (c) => {
    folder.unreadable = false; gate.place = true; gate.host = undefined;
    const r1 = await c.host("r1", { caps: capsFor(c, ADMITTED) });
    const agent = await c.agent("ann", workGrants(c.project, ["read-file"]));
    const { attemptId } = await c.task("Order seeds", agent);
    await c.tick();
    assert.notEqual((await c.remote.placement(c.owner, attemptId!))?.state, "offered", "no offer was made on an unreadable admission");
    assert.deepEqual(await r1.client.offers(), []);
    gate.place = false;
  }, { workspaceAdmission: gated });

  suite("a move is judged on the target's folder: an admission that cannot be read there, or a target that declares another folder, leaves the attempt where it is (card P02)", async (c) => {
    folder.unreadable = false; gate.place = false; gate.host = undefined;
    const r1 = await c.host("r1", { caps: capsFor(c, ADMITTED) });
    const r2 = await c.host("r2", { caps: capsFor(c, ADMITTED) });
    const r3 = await c.host("r3", { caps: capsFor(c, "/srv/elsewhere/garden") });
    const { attemptId, placement } = await c.started(r1);
    gate.host = r2.id;
    await assert.rejects(c.remote.relocate(c.owner, { commandId: "mv-unread", attemptId, toHostId: r2.id, reason: "r1 is being retired" }));
    await assert.rejects(c.remote.relocate(c.owner, { commandId: "mv-other", attemptId, toHostId: r3.id, reason: "r1 is being retired" }), (e: unknown) => e instanceof DomainError && /host:r3 may not open this task's workspace/.test(e.message));
    const now = await rec(c, attemptId);
    assert.deepEqual([now.hostId, now.placement, now.state], [r1.id, placement, "accepted"], "the attempt stays where it is");
    gate.host = undefined;
  }, { workspaceAdmission: gated, policy: async () => ({ dataHosts: ["host:r1", "host:r2", "host:r3"] }) });

  suite("the remote service is not built without a folder admission (card P02): no composition leaves remote workspaces unjudged by leaving it out", async (c) => {
    const deps = { principal: c.dispatcherPrincipal, hosts: c.hosts, artifacts: c.artifacts, dispatch: c.current as never };
    for (const workspaceAdmission of [undefined, null, "yes", {}]) {
      assert.throws(() => RemoteWorkerService.withEpoch(c.storage, c.epoch, { ...deps, workspaceAdmission } as never, c.options), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && /workspaceAdmission/.test(e.message), String(workspaceAdmission));
    }
    assert.ok(RemoteWorkerService.withEpoch(c.storage, c.epoch, { ...deps, workspaceAdmission: async () => [] }, c.options) instanceof RemoteWorkerService);
  });
}

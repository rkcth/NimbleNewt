import assert from "node:assert/strict";
import { after } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { RemoteWorkerClient } from "./client.js";
import { RemoteWorkerService, PLACEMENT_KIND, type PlacementBody } from "./service.js";
import { remoteSuite, wireRefuses, type Ctx } from "./testing/suite.js";
import { REMOTE_CAPS, type RemoteHost } from "./testing/world.js";
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

  suite("the remote service is not built without a folder admission (card P02): no composition leaves remote workspaces unjudged by leaving it out", async (c) => {
    const deps = { principal: c.dispatcherPrincipal, hosts: c.hosts, artifacts: c.artifacts, dispatch: c.current as never };
    for (const workspaceAdmission of [undefined, null, "yes", {}]) {
      assert.throws(() => RemoteWorkerService.withEpoch(c.storage, c.epoch, { ...deps, workspaceAdmission } as never, c.options), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && /workspaceAdmission/.test(e.message), String(workspaceAdmission));
    }
    assert.ok(RemoteWorkerService.withEpoch(c.storage, c.epoch, { ...deps, workspaceAdmission: async () => [] }, c.options) instanceof RemoteWorkerService);
  });
}

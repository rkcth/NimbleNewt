import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { ProjectResourceService, type WorkspaceAdmission } from "./index.js";

// Card P02: a task's workspace admits only a repository in the task's access scope. `workspaceAdmission` is what the worker host on this computer asks before it opens (or hands out again) a task's checkout.
after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const GARDEN = "/srv/repos/garden";
const SHED = "/srv/repos/shed";
const refused = (a: WorkspaceAdmission, pattern: RegExp): void => { assert.equal(a.admitted, false, JSON.stringify(a)); assert.match((a as { reason: string }).reason, pattern); };

for (const backend of backends) {
  interface Ctx { owner: Principal; projects: ProjectService; resources: ProjectResourceService; project: string; other: string }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const options = { clock: () => "2026-11-26T10:00:00.000Z", pause: async () => undefined };
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const resources = ProjectResourceService.withEpoch(world.storage, projects.epoch, options);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Garden" })).id;
        const other = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Shed" })).id;
        await body({ owner, projects, resources, project, other });
      } finally { await world.close(); }
    });

  suite("a task that names no repository: admitted on a folder its project has bound with write access to all of it, and only there", async ({ owner, projects, resources, project, other }) => {
    const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Dig" })).id;
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: GARDEN }), /is not bound to the project; bind it to the project with write access first \(resource\.bind\)/);
    const bound = await resources.bindResource(owner, { commandId: cid("b"), projectId: project, kind: "repository", label: "garden", locator: GARDEN, repositoryId: "garden", access: "write" });
    const ok = await resources.workspaceAdmission({ taskId: task, projectId: project, folder: GARDEN });
    assert.deepEqual(ok, { admitted: true, binding: { resourceId: bound.id, repositoryId: "garden", locatorEpoch: 1, label: "garden", pinned: false } });
    // Another folder, a folder bound to another project, the same folder spelled differently, and another project's task.
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: SHED }), /not bound to the project/);
    await resources.bindResource(owner, { commandId: cid("b"), projectId: other, kind: "repository", label: "shed", locator: SHED, repositoryId: "shed", access: "write" });
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: SHED }), /not bound to the project/);
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: `${GARDEN}/` }), /not bound to the project/);
    refused(await resources.workspaceAdmission({ taskId: task, projectId: other, folder: SHED }), /is not a task of that project/);
    // Not a repository: an output folder bound with write access does not admit a workspace.
    const out = await resources.bindResource(owner, { commandId: cid("b"), projectId: project, kind: "output", label: "reports", locator: "/srv/out/reports", access: "write" });
    assert.ok(out.id);
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: "/srv/out/reports" }), /not bound to the project/);
    // Malformed requests are refused, not thrown.
    refused(await resources.workspaceAdmission({ taskId: "nope", projectId: project, folder: GARDEN }), /taskId/);
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: "" }), /does not name a task, a project and a folder/);
    refused(await resources.workspaceAdmission(undefined as never), /does not name/);
  });

  suite("read access or a path-limited scope does not admit a workspace (it is a writable copy of all of it); narrowing an admitted binding refuses the next hand-out, and an unbound one is refused", async ({ owner, projects, resources, project }) => {
    const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Dig" })).id;
    const bound = await resources.bindResource(owner, { commandId: cid("b"), projectId: project, kind: "repository", label: "garden", locator: GARDEN, repositoryId: "garden" });
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: GARDEN }), /has read access only to repository "garden", and an agent's workspace is written in/);
    let rev = (await resources.get(owner, bound.id))!.revision;
    await resources.setScope(owner, { commandId: cid("s"), resourceId: bound.id, expectedRevision: rev, access: "write", paths: ["src", "docs"] });
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: GARDEN }), /may use only some paths of repository "garden" \(docs, src\), and a workspace holds all of it/);
    rev = (await resources.get(owner, bound.id))!.revision;
    await resources.setScope(owner, { commandId: cid("s"), resourceId: bound.id, expectedRevision: rev, access: "write" });
    assert.equal((await resources.workspaceAdmission({ taskId: task, projectId: project, folder: GARDEN })).admitted, true);
    rev = (await resources.get(owner, bound.id))!.revision;
    await resources.setScope(owner, { commandId: cid("s"), resourceId: bound.id, expectedRevision: rev, access: "read" });
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: GARDEN }), /read access only/);
    rev = (await resources.get(owner, bound.id))!.revision;
    await resources.unbindResource(owner, { commandId: cid("u"), resourceId: bound.id, expectedRevision: rev });
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: GARDEN }), /not bound to the project/);
  });

  suite("a task that names a repository: only its pinned binding, at the location it was pinned at; not before the pin, not after a move, an unbind or a re-pointing", async ({ owner, projects, resources, project }) => {
    const bound = await resources.bindResource(owner, { commandId: cid("b"), projectId: project, kind: "repository", label: "garden", locator: GARDEN, repositoryId: "garden", access: "write" });
    await resources.bindResource(owner, { commandId: cid("b"), projectId: project, kind: "repository", label: "shed", locator: SHED, repositoryId: "shed", access: "write" });
    const created = await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Dig", repositoryId: "garden" });
    const task = created.id;
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: GARDEN }), /names repository garden but its checkout is not pinned yet/);
    assert.equal((await resources.dispatchCheckout({ commandId: cid("pin"), taskId: task, actor: "dispatcher", pin: true })).kind, "ok");
    assert.deepEqual(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: GARDEN }), { admitted: true, binding: { resourceId: bound.id, repositoryId: "garden", locatorEpoch: 1, label: "garden", pinned: true } });
    // Another bound repository of the same project is not the one the task was dispatched against.
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: SHED }), /is not where repository garden \(bound as "garden"\) is, and the task was dispatched against that one/);
    // A move of the binding: the pin no longer resolves until the owner confirms it.
    const rev = (await resources.get(owner, bound.id))!.revision;
    await resources.moveResource(owner, { commandId: cid("m"), resourceId: bound.id, expectedRevision: rev, locator: "/srv/repos/garden2" });
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: "/srv/repos/garden2" }), /has moved; confirm the new location first/);
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: GARDEN }), /has moved/);
    const pin = (await resources.getPin(owner, task))!;
    await resources.repinCheckout(owner, { commandId: cid("rp"), taskId: task, expectedRevision: pin.revision });
    const after = await resources.workspaceAdmission({ taskId: task, projectId: project, folder: "/srv/repos/garden2" });
    assert.deepEqual(after, { admitted: true, binding: { resourceId: bound.id, repositoryId: "garden", locatorEpoch: 2, label: "garden", pinned: true } });
    // Unbound after the pin: refused with the reason.
    const r2 = (await resources.get(owner, bound.id))!.revision;
    await resources.unbindResource(owner, { commandId: cid("u"), resourceId: bound.id, expectedRevision: r2 }).catch(() => undefined);
    const gone = await resources.workspaceAdmission({ taskId: task, projectId: project, folder: "/srv/repos/garden2" });
    if ((await resources.get(owner, bound.id))!.state === "unbound") refused(gone, /has been unbound|another checkout/);
    else assert.equal(gone.admitted, true, "the unbind was refused while a live task is pinned, so the pin still admits");
  });

  suite("a pinned task re-pointed at another repository is refused until the owner confirms the new checkout", async ({ owner, projects, resources, project }) => {
    await resources.bindResource(owner, { commandId: cid("b"), projectId: project, kind: "repository", label: "garden", locator: GARDEN, repositoryId: "garden", access: "write" });
    await resources.bindResource(owner, { commandId: cid("b"), projectId: project, kind: "repository", label: "shed", locator: SHED, repositoryId: "shed", access: "write" });
    const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Dig", repositoryId: "garden" })).id;
    await resources.dispatchCheckout({ commandId: cid("pin"), taskId: task, actor: "dispatcher", pin: true });
    const t = (await projects.getTask(task))!;
    await projects.updateTask({ commandId: cid("ut"), actor: owner.id, taskId: task, expectedRevision: t.revision, repositoryId: "shed" } as never);
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: SHED }), /was dispatched against another checkout than the one it now names/);
    refused(await resources.workspaceAdmission({ taskId: task, projectId: project, folder: GARDEN }), /another checkout/);
  });
}

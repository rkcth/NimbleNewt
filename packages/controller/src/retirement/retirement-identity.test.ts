import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { options as clockOptions, cid, openWorld, type World } from "../chat/testing/harness.js";
import { IntegratorLeaseService } from "../landing/index.js";
import { IncidentService, MaintenanceLeaseService } from "../projects/index.js";
import { GrantService, TaskCredentialService, type Principal } from "../security/index.js";
import { RetirementService, type RetirementPorts } from "./index.js";

// Card P06 (identity grants): grants written on a principal's own record for an archived project.
after(stopServer);

type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: unknown) => (e instanceof DomainError ? e.code : String(e)));

async function rig(backend: (typeof backends)[number], script: Record<string, unknown> = {}) {
  const late: { svc?: RetirementService } = {};
  const door = {
    preview: (...a: Parameters<RetirementService["preview"]>) => late.svc!.preview(...a),
    retireAgent: (...a: Parameters<RetirementService["retireAgent"]>) => late.svc!.retireAgent(...a),
    archiveProject: (...a: Parameters<RetirementService["archiveProject"]>) => late.svc!.archiveProject(...a),
    restoreProject: (...a: Parameters<RetirementService["restoreProject"]>) => late.svc!.restoreProject(...a),
    list: (...a: Parameters<RetirementService["list"]>) => late.svc!.list(...a),
  };
  const w = await openWorld(backend, script, undefined, { retirement: door });
  const storage = w.world.storage; const epoch = w.projects.epoch;
  const grants = GrantService.withEpoch(storage, epoch, clockOptions);
  const incidents = IncidentService.withEpoch(storage, epoch, w.responsibilities, clockOptions);
  const leases = MaintenanceLeaseService.withEpoch(storage, epoch, w.responsibilities, incidents, clockOptions);
  const integrator = IntegratorLeaseService.withEpoch(storage, epoch, clockOptions);
  const ports: RetirementPorts = { agents: w.agents, projects: w.projects, duties: w.responsibilities, resources: w.resources, leases, integrator, grants, principals: w.principals };
  const retirement = RetirementService.withEpoch(storage, epoch, ports, clockOptions);
  late.svc = retirement;
  const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => w.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
  const flaky = (wrap: (p: RetirementPorts) => RetirementPorts) => RetirementService.withEpoch(storage, epoch, wrap(ports), clockOptions);
  return { w, retirement, leases, integrator, grants, ports, call, flaky, close: () => w.close() };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const acting = (principalId: string, name: string, project: string): Principal => ({ id: principalId, kind: "agent", name, asOf: "2026-10-22T10:00:00.000Z", grants: [{ action: "responsibility.read", project }, { action: "responsibility.write", project }] }) as Principal;

async function makeAgent(r: Rig, name: string) {
  const { w } = r;
  const agentId = (await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: name })).id;
  const principalId = `agent:${agentId}`;
  const token = (await w.principals.issueCredential(w.owner, principalId)).token;
  return { agentId, principalId, token };
}

/** A project with a bound resource and a duty managing it (so a maintenance lease can be taken on it). */
async function site(w: World, name: string) {
  const p = await w.project(name);
  const res = await w.resources.bindResource(w.owner, { commandId: cid("b"), projectId: p, kind: "service", label: "Web", locator: "https://example.test" } as never);
  const duty = (await w.responsibilities.create(w.owner, { commandId: cid("r"), projectId: p, title: "Keep web up", objective: "Up", everyMinutes: 60, ownerId: (await w.agent(`keeper-${cid("k")}`, [])).principal.id, managed: [res.id] } as never)).id;
  return { p, res: res.id, duty };
}

const assign = async (w: World, taskId: string, ownerId: string) => { const cur = await w.assignments.getAssignment(taskId); return w.assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId, owner: { kind: "agent", id: ownerId }, ...(cur === undefined ? {} : { expectedRevision: cur.revision }) }); };
const release = async (w: World, taskId: string) => w.assignments.releaseTask({ commandId: cid("rl"), actor: "owner:rob", taskId, expectedRevision: (await w.assignments.getAssignment(taskId))!.revision });

for (const backend of backends) {
  test(`${backend.name}: P06 identity grants: an agent enrolled with task.update on a project cannot update its tasks once archived, a task.read holder still reads, a grant for every project and the owner keep working, restore brings the write back, the preview digest covers them and a stale digest is refused`, async () => {
    const r = await rig(backend);
    try {
      const { w } = r;
      const p = await w.project("Garden");
      const other = await w.project("Shed");
      const t = await w.task(p, "Water the beds");
      const tOther = await w.task(other, "Oil the hinges");
      const writer = await w.agent("writer", [{ action: "task.update", project: p }, { action: "task.read", project: p }]);
      const reader = await w.agent("reader", [{ action: "task.read", project: p }]);
      const wide = await w.agent("wide", [{ action: "task.update", project: "*" }, { action: "task.read", project: "*" }]);
      const elsewhere = await w.agent("elsewhere", [{ action: "task.update", project: other }, { action: "task.read", project: other }]);
      const update = async (token: string, taskId: string, title: string) => {
        const cur = (await w.projects.getTask(taskId))!;
        const x = await r.call(token, "task.update", { taskId, expectedRevision: cur.revision, title }, cid("u"));
        return x.ok ? "ok" : x.error!.code;
      };
      const read = async (token: string, taskId: string) => { const x = await r.call(token, "task.get", { taskId }); return x.ok ? "read" : x.error!.code; };
      assert.equal(await update(writer.token, t, "Water the beds early"), "ok", "before the archive the grant works");

      const before = await r.retirement.preview(w.owner, { kind: "project", id: p });
      assert.deepEqual(before.release.fencedGrants, ["agent:writer|task.update"], "only the execution grant of this project written on an identity is listed");
      assert.deepEqual(before.release.grants, []);
      assert.match((await r.call(w.ownerToken, "retirement.preview", { kind: "project", id: p })).result.shown[0], /1 grant\(s\) written on agents' own records stop working/);

      // A principal given a new such grant after the preview makes the digest stale.
      const late = await w.agent("late", []);
      await w.principals.setGrants(w.owner, { commandId: cid("sg"), principalId: late.principal.id, expectedRevision: (await w.world.storage.getAggregate({ kind: "principal", id: late.principal.id }))!.revision, grants: [{ action: "task.update", project: p }] });
      assert.equal(await code(r.retirement.archiveProject(w.owner, { commandId: cid("a0"), projectId: p, reason: "over", confirm: before.digest })), "invalid_command", "a stale digest is refused");
      const plan = await r.retirement.preview(w.owner, { kind: "project", id: p });
      assert.notEqual(plan.digest, before.digest, "the digest changes when such grants change");
      assert.equal(plan.release.fencedGrants!.length, 2);
      await w.principals.setGrants(w.owner, { commandId: cid("sg"), principalId: late.principal.id, expectedRevision: (await w.world.storage.getAggregate({ kind: "principal", id: late.principal.id }))!.revision, grants: [] });
      const plan2 = await r.retirement.preview(w.owner, { kind: "project", id: p });
      assert.equal(plan2.digest, before.digest, "the same grants give the same digest");

      const done = await r.retirement.archiveProject(w.owner, { commandId: cid("a"), projectId: p, reason: "over", confirm: plan2.digest });
      assert.deepEqual(done.record.released.fencedGrants, ["agent:writer|task.update"], "the ledger says what was suspended");
      assert.equal(await update(writer.token, t, "Water at night"), "forbidden", "an execution grant on an identity no longer writes in an archived project");
      assert.equal((await w.projects.getTask(t))!.title, "Water the beds early");
      assert.equal(await read(writer.token, t), "read");
      assert.equal(await read(reader.token, t), "read", "a read-only holder keeps reading");
      assert.equal(await update(wide.token, t, "Wide edit"), "ok", "a grant for every project is not touched");
      assert.equal(await update(elsewhere.token, tOther, "Oil them"), "ok", "another project is not touched");
      assert.equal(await update(w.ownerToken, t, "Owner edit"), "ok", "the owner keeps working");

      const back = await r.retirement.restoreProject(w.owner, { commandId: cid("rest"), projectId: p, reason: "spring" });
      assert.match(back.record.note ?? "", /1 grant\(s\) written on principals' own records \(agent:writer\|task.update\) were only suspended and work again now/);
      assert.equal(await update(writer.token, t, "Water in spring"), "ok", "restoring the project brings the identity grant back");
      assert.equal((await r.retirement.preview(w.owner, { kind: "project", id: p })).release.fencedGrants?.length, 1);
    } finally { await r.close(); }
  });
}

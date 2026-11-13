import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { options as clockOptions, cid, openWorld, type World } from "../chat/testing/harness.js";
import { IntegratorLeaseService } from "../landing/index.js";
import { IncidentService, MaintenanceLeaseService } from "../projects/index.js";
import { GrantService, TaskCredentialService, type Principal } from "../security/index.js";
import { RetirementService, type RetirementPorts } from "./index.js";

// Review of card P06 (finish slice): races, released leases, restore, the ledger in backups, owner-only access and the scanner on the reason.
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
  test(`${backend.name}: P06 review: an assigned task in any unfinished state blocks (proposed, ready, in progress, blocked), and a stale digest is refused (a task assigned or a grant given after the preview)`, async () => {
    const r = await rig(backend);
    try {
      const { w } = r;
      const { p } = await site(w, "Ops");
      const ann = await makeAgent(r, "Ann");
      const states = ["proposed", "ready", "in_progress", "blocked"] as const;
      const path: Record<(typeof states)[number], string[]> = { proposed: [], ready: ["ready"], in_progress: ["ready", "in_progress"], blocked: ["ready", "blocked"] };
      const tasks: string[] = [];
      for (const s of states) {
        const t = await w.task(p, `Task ${s}`);
        for (const to of path[s]) await w.projects.transitionTask({ commandId: cid("tt"), actor: "owner:rob", taskId: t, expectedRevision: (await w.projects.getTask(t))!.revision, to } as never);
        assert.equal((await w.projects.getTask(t))!.state, s);
        await assign(w, t, ann.principalId); tasks.push(t);
      }
      const plan = await r.retirement.preview(w.owner, { kind: "agent", id: ann.agentId });
      assert.deepEqual(plan.blockers.map((b) => b.id).sort(), [...tasks].sort(), "every unfinished assigned task blocks");
      const archive = await r.retirement.preview(w.owner, { kind: "project", id: p });
      assert.deepEqual(archive.blockers.filter((b) => b.kind === "assignment").map((b) => b.id).sort(), [...tasks].sort());
      for (const t of tasks) await release(w, t);

      // Stale: preview, then something changes, then the old digest is refused and nothing is touched.
      const first = await r.retirement.preview(w.owner, { kind: "agent", id: ann.agentId });
      assert.equal(first.blockers.length, 0);
      await r.grants.grant(w.owner, { commandId: cid("g"), grantee: ann.principalId, action: "attempt.work", project: p, source: "direct", basis: "late" });
      assert.equal(await code(r.retirement.retireAgent(w.owner, { commandId: cid("x"), agentId: ann.agentId, reason: "left", confirm: first.digest })), "invalid_command", "a grant given after the preview makes the digest stale");
      const second = await r.retirement.preview(w.owner, { kind: "agent", id: ann.agentId });
      const late = await w.task(p, "Late task");
      await assign(w, late, ann.agentId);
      assert.equal(await code(r.retirement.retireAgent(w.owner, { commandId: cid("x"), agentId: ann.agentId, reason: "left", confirm: second.digest })), "invalid_command", "a task assigned after the preview makes the digest stale");
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "active");
      assert.equal((await r.retirement.list(w.owner)).items.length, 0, "a refused retirement writes no ledger record");
    } finally { await r.close(); }
  });

  test(`${backend.name}: P06 review: the last look just before the subject step stops a retirement when a duty is given to the agent midway, and a task assigned in a project midway stops its archiving; the same command finishes once cleared`, async () => {
    const r = await rig(backend);
    try {
      const { w } = r;
      const { p, res } = await site(w, "Ops");
      const ann = await makeAgent(r, "Ann");
      await r.grants.grant(w.owner, { commandId: cid("g"), grantee: ann.principalId, action: "attempt.work", project: p, source: "direct", basis: "work" });
      const plan = await r.retirement.preview(w.owner, { kind: "agent", id: ann.agentId });
      assert.equal(plan.blockers.length, 0);
      // While the grants are being revoked, someone gives Ann a duty (plain agent.retire does not check duties, so only the last look stands in the way).
      const res2 = (await w.resources.bindResource(w.owner, { commandId: cid("b"), projectId: p, kind: "service", label: "Logs", locator: "https://example.test/logs" } as never)).id;
      let duty: string | undefined;
      const racing = r.flaky((ports) => ({ ...ports, grants: { revoke: async (...a: Parameters<GrantService["revoke"]>) => {
        if (duty === undefined) duty = (await w.responsibilities.create(w.owner, { commandId: cid("r"), projectId: p, title: "Watch the logs", objective: "Quiet", everyMinutes: 60, ownerId: ann.principalId, managed: [res2] } as never)).id;
        return ports.grants.revoke(...a);
      } } }));
      const commandId = cid("retire");
      assert.equal(await code(racing.retireAgent(w.owner, { commandId, agentId: ann.agentId, reason: "left", confirm: plan.digest })), "invalid_transition", "the last look sees the new duty");
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "active", "the agent is not retired with an active duty");
      assert.deepEqual((await r.retirement.list(w.owner)).items.map((x) => x.status), ["started"]);
      const cur = (await w.responsibilities.get(w.owner, duty!))!;
      await w.responsibilities.update(w.owner, { commandId: cid("ru"), responsibilityId: duty!, expectedRevision: cur.revision, state: "retired" } as never);
      const done = await r.retirement.retireAgent(w.owner, { commandId, agentId: ann.agentId, reason: "left", confirm: plan.digest });
      assert.equal(done.status, "done");
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "retired");
      assert.equal((await r.retirement.list(w.owner)).items.length, 1);

      // A project: a task assigned while its bindings are being unbound stops the archiving before the project record changes.
      const t = await w.task(p, "Late work");
      const bob = await makeAgent(r, "Bob");
      const ready = await r.retirement.preview(w.owner, { kind: "project", id: p });
      assert.equal(ready.blockers.length, 0, JSON.stringify(ready.blockers));
      let assigned = false;
      const racing2 = r.flaky((ports) => ({ ...ports, resources: { unbindResource: async (...a: Parameters<RetirementPorts["resources"]["unbindResource"]>) => {
        if (!assigned) { assigned = true; await assign(w, t, bob.principalId); }
        return ports.resources.unbindResource(...a);
      } } }));
      const archiveId = cid("arch");
      assert.equal(await code(racing2.archiveProject(w.owner, { commandId: archiveId, projectId: p, reason: "over", confirm: ready.digest })), "invalid_transition");
      assert.equal((await w.projects.getProject(p))!.state, "active", "the project is not archived under a live assignment");
      await release(w, t);
      assert.equal((await r.retirement.archiveProject(w.owner, { commandId: archiveId, projectId: p, reason: "over", confirm: ready.digest })).status, "done");
      assert.equal((await w.projects.getProject(p))!.state, "archived");
    } finally { await r.close(); }
  });

  test(`${backend.name}: P06 review: two retirements of the same agent at once make one ledger record (the second carries the first on), both at once and with the first held halfway`, async () => {
    const r = await rig(backend);
    try {
      const { w } = r;
      const { p } = await site(w, "Ops");
      const ann = await makeAgent(r, "Ann");
      for (const action of ["attempt.work", "task.update"]) await r.grants.grant(w.owner, { commandId: cid("g"), grantee: ann.principalId, action, project: p, source: "direct", basis: "work" });
      // The first is held inside its first revoke while the second runs from a fresh preview.
      let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; });
      let entered!: () => void; const inside = new Promise<void>((resolve) => { entered = resolve; });
      let held = false;
      const slow = r.flaky((ports) => ({ ...ports, grants: { revoke: async (...a: Parameters<GrantService["revoke"]>) => { if (!held) { held = true; entered(); await gate; } return ports.grants.revoke(...a); } } }));
      const plan = await r.retirement.preview(w.owner, { kind: "agent", id: ann.agentId });
      const first = slow.retireAgent(w.owner, { commandId: cid("one"), agentId: ann.agentId, reason: "left", confirm: plan.digest });
      await inside;
      const fresh = await r.retirement.preview(w.owner, { kind: "agent", id: ann.agentId });
      const twoId = cid("two");
      const second = await r.retirement.retireAgent(w.owner, { commandId: twoId, agentId: ann.agentId, reason: "left too", confirm: fresh.digest });
      open();
      const one = await first;
      assert.equal(second.id, one.id, "the second carried the first on");
      assert.deepEqual((await r.retirement.list(w.owner)).items.map((x) => [x.id, x.status]), [[one.id, "done"]], "one ledger record");
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "retired");

      // Truly at once (on PostgreSQL these are two connections): one record, the agent retired, and neither fails for any other reason than that.
      const bob = await makeAgent(r, "Bob");
      await r.grants.grant(w.owner, { commandId: cid("g"), grantee: bob.principalId, action: "attempt.work", project: p, source: "direct", basis: "work" });
      const bp = await r.retirement.preview(w.owner, { kind: "agent", id: bob.agentId });
      const both = await Promise.allSettled([1, 2, 3].map((n) => r.retirement.retireAgent(w.owner, { commandId: cid(`b${n}`), agentId: bob.agentId, reason: "left", confirm: bp.digest })));
      for (const o of both) if (o.status === "rejected") assert.ok(o.reason instanceof DomainError && ["invalid_command", "stale_revision"].includes(o.reason.code), String(o.reason));
      assert.ok(both.some((o) => o.status === "fulfilled"));
      assert.equal((await r.retirement.list(w.owner, { subjectId: bob.agentId })).items.length, 1, "one ledger record for Bob");
      assert.equal((await w.agents.get(w.owner, bob.agentId))!.state, "retired");
      // A repeat of the command that carried another on is answered from what it did, not refused as already retired; a new command is refused.
      const repeat = await r.retirement.retireAgent(w.owner, { commandId: twoId, agentId: ann.agentId, reason: "left too", confirm: fresh.digest });
      assert.deepEqual([repeat.id, repeat.replayed], [one.id, true]);
      assert.equal(await code(r.retirement.retireAgent(w.owner, { commandId: cid("three"), agentId: ann.agentId, reason: "x", confirm: fresh.digest })), "invalid_command");
    } finally { await r.close(); }
  });

  test(`${backend.name}: P06 review: a lease that changed hands is not freed from its new holder; a project's lease held by an agent still working elsewhere blocks the archive; a failed credential revoke leaves the agent unretired`, async () => {
    const r = await rig(backend);
    try {
      const { w } = r;
      const { p, res } = await site(w, "Ops");
      const ann = await makeAgent(r, "Ann"); const bob = await makeAgent(r, "Bob");
      const annActs = acting(ann.principalId, "Ann", p); const bobActs = acting(bob.principalId, "Bob", p);
      await r.leases.acquire(annActs, { commandId: cid("la"), resourceId: res, purpose: "patch", minutes: 30 });
      const plan = await r.retirement.preview(w.owner, { kind: "agent", id: ann.agentId });
      assert.equal(plan.release.maintenanceLeases.length, 1);
      // The first run stops at the lease; Ann then gives it back herself and Bob takes it.
      let failed = false;
      const flaky = r.flaky((ports) => ({ ...ports, leases: { release: async (...a: Parameters<MaintenanceLeaseService["release"]>) => { if (!failed) { failed = true; throw new DomainError("unavailable", "the store went away"); } return ports.leases.release(...a); } } }));
      const commandId = cid("retire");
      assert.equal(await code(flaky.retireAgent(w.owner, { commandId, agentId: ann.agentId, reason: "left", confirm: plan.digest })), "unavailable");
      await r.leases.release(annActs, { commandId: cid("lr"), resourceId: res, validation: "passed", evidence: "done" });
      await r.leases.acquire(bobActs, { commandId: cid("lb"), resourceId: res, purpose: "patch more", minutes: 30 });
      assert.equal((await r.retirement.retireAgent(w.owner, { commandId, agentId: ann.agentId, reason: "left", confirm: plan.digest })).status, "done");
      const lease = (await r.leases.list(w.owner, p))![0]!;
      assert.deepEqual([lease.status, lease.holderId], ["held", bob.principalId], "Bob's lease is not freed by Ann's retirement");

      // Archiving: Bob still holds the lease and works on a task of another project, so the lease is in use and the archive is blocked.
      const q = await w.project("Elsewhere");
      const elsewhere = await w.task(q, "Other work");
      await assign(w, elsewhere, bob.principalId);
      const blocked = await r.retirement.preview(w.owner, { kind: "project", id: p });
      assert.deepEqual(blocked.blockers.map((b) => b.kind), ["lease"], JSON.stringify(blocked.blockers));
      assert.equal(await code(r.retirement.archiveProject(w.owner, { commandId: cid("a"), projectId: p, reason: "over", confirm: blocked.digest })), "invalid_transition");
      assert.equal((await r.leases.list(w.owner, p))![0]!.status, "held");
      await release(w, elsewhere);
      const ready = await r.retirement.preview(w.owner, { kind: "project", id: p });
      assert.equal(ready.blockers.length, 0);
      assert.equal((await r.retirement.archiveProject(w.owner, { commandId: cid("a"), projectId: p, reason: "over", confirm: ready.digest })).status, "done");
      assert.equal((await r.leases.list(w.owner, p))![0]!.status, "free", "an idle holder's lease is released by the archive");

      // A credential revoke that fails stops before the agent record changes; the same command finishes.
      const cy = await makeAgent(r, "Cy");
      const cp = await r.retirement.preview(w.owner, { kind: "agent", id: cy.agentId });
      assert.equal(cp.release.credential, true);
      let once = true;
      const broken = r.flaky((ports) => ({ ...ports, principals: { revokeCredential: async (...a: Parameters<RetirementPorts["principals"]["revokeCredential"]>) => { if (once) { once = false; throw new DomainError("unavailable", "the store went away"); } return ports.principals.revokeCredential(...a); } } }));
      const cyCmd = cid("cy");
      assert.equal(await code(broken.retireAgent(w.owner, { commandId: cyCmd, agentId: cy.agentId, reason: "left", confirm: cp.digest })), "unavailable");
      assert.equal((await w.agents.get(w.owner, cy.agentId))!.state, "active", "not retired while its credential still works");
      assert.equal((await w.principals.authenticate(cy.token)).id, cy.principalId, "the credential still works: nothing was half-revoked");
      assert.equal((await r.retirement.retireAgent(w.owner, { commandId: cyCmd, agentId: cy.agentId, reason: "left", confirm: cp.digest })).status, "done");
      await assert.rejects(w.principals.authenticate(cy.token));
    } finally { await r.close(); }
  });

  test(`${backend.name}: P06 review: archive keeps read-only grants and revokes execution grants; while archived, readers still read and nothing new is assigned; restore brings the project back active and re-grants nothing; a retired agent is given no work`, async () => {
    const r = await rig(backend);
    try {
      const { w } = r;
      const { p, res } = await site(w, "Garden");
      const other = await w.project("Shed");
      const ann = await makeAgent(r, "Ann");
      const read = (await r.grants.grant(w.owner, { commandId: cid("g"), grantee: ann.principalId, action: "task.read", project: p, source: "direct", basis: "read" })).id;
      const work = (await r.grants.grant(w.owner, { commandId: cid("g"), grantee: ann.principalId, action: "attempt.work", project: p, source: "direct", basis: "work" })).id;
      const elsewhere = (await r.grants.grant(w.owner, { commandId: cid("g"), grantee: ann.principalId, action: "attempt.work", project: other, source: "direct", basis: "work" })).id;
      const everywhere = (await r.grants.grant(w.owner, { commandId: cid("g"), grantee: ann.principalId, action: "task.update", project: "*", source: "direct", basis: "work" })).id;
      const t = await w.task(p, "Water the beds");
      const readTask = async (token: string) => { const x = await r.call(token, "task.get", { taskId: t }); return x.ok ? "read" : x.error!.code; };
      assert.equal(await readTask(ann.token), "read");
      // The plain project change now refuses too while a task is assigned and unfinished.
      await assign(w, t, ann.principalId);
      assert.equal(await code(w.projects.updateProject({ commandId: cid("pu"), actor: "owner:rob", projectId: p, expectedRevision: (await w.projects.getProject(p))!.revision, state: "archived" } as never)), "invalid_command");
      await release(w, t);

      const plan = await r.retirement.preview(w.owner, { kind: "project", id: p });
      assert.deepEqual(plan.release.grants, [work], "only the execution grant made for this project is revoked");
      assert.match((await r.call(w.ownerToken, "retirement.preview", { kind: "project", id: p })).result.shown[0], /read-only grants stay/);
      assert.equal((await r.retirement.archiveProject(w.owner, { commandId: cid("a"), projectId: p, reason: "over", confirm: plan.digest })).status, "done");
      const state = async (g: string) => (await r.grants.getGrant(g))!.state;
      assert.deepEqual([await state(read), await state(work), await state(elsewhere), await state(everywhere)], ["active", "revoked", "active", "active"]);
      assert.equal(await readTask(ann.token), "read", "a reader keeps reading the archived project");
      assert.equal(await readTask(w.ownerToken), "read");
      assert.equal(await code(assign(w, t, ann.principalId)), "invalid_command", "an archived project's task is not assigned");
      assert.equal((await w.assignments.getAssignment(t))!.state, "released");

      const back = await r.retirement.restoreProject(w.owner, { commandId: cid("rest"), projectId: p, reason: "spring" });
      assert.equal((await w.projects.getProject(p))!.state, "active");
      assert.match(back.record.note ?? "", /1 execution grant\(s\) stay revoked/);
      assert.deepEqual([await state(read), await state(work)], ["active", "revoked"], "restore re-grants nothing");
      assert.equal((await w.resources.get(w.owner, res))!.state, "unbound", "and binds nothing again");
      await assign(w, t, ann.principalId);
      await release(w, t);

      // A retired agent is given no work, by agent ID or principal ID, by assignment or transfer.
      const bob = await makeAgent(r, "Bob");
      const bp = await r.retirement.preview(w.owner, { kind: "agent", id: bob.agentId });
      await r.retirement.retireAgent(w.owner, { commandId: cid("rb"), agentId: bob.agentId, reason: "left", confirm: bp.digest });
      assert.equal(await code(assign(w, t, bob.agentId)), "invalid_command");
      assert.equal(await code(assign(w, t, bob.principalId)), "invalid_command");
      await assign(w, t, ann.principalId);
      assert.equal(await code(w.assignments.transferTask({ commandId: cid("tr"), actor: "owner:rob", taskId: t, expectedRevision: (await w.assignments.getAssignment(t))!.revision, to: { kind: "agent", id: bob.principalId } })), "invalid_command");
      assert.deepEqual((await w.assignments.getAssignment(t))!.owner, { kind: "agent", id: ann.principalId });
    } finally { await r.close(); }
  });

  test(`${backend.name}: P06 review: the ledger and its claim are in a backup copy and held by retention; agents, task credentials and agent chat cannot reach retirement; a stale chat proposal is not applied; credential-shaped reasons are refused`, async () => {
    const script: Record<string, unknown> = {};
    const r = await rig(backend, script);
    try {
      const { w } = r;
      const { p } = await site(w, "Ops");
      const ann = await makeAgent(r, "Annabel");
      const t = await w.task(p, "Water");
      // Owner only through the API, for an agent with every grant and for a task credential.
      const bob = await w.agent("bob", [{ action: "*", project: "*" }]);
      await assign(w, t, ann.principalId);
      const tcr = (await TaskCredentialService.withEpoch(w.world.storage, w.projects.epoch, clockOptions).issue(w.owner, { commandId: cid("tc"), taskId: t, agentId: ann.principalId })).token;
      await release(w, t);
      const ops: [string, Record<string, unknown>][] = [["retirement.preview", { kind: "agent", id: ann.agentId }], ["retirement.list", {}], ["retirement.agent", { agentId: ann.agentId, reason: "x", confirm: "y" }], ["retirement.project", { projectId: p, reason: "x", confirm: "y" }], ["retirement.project.restore", { projectId: p }]];
      for (const token of [bob.token, ann.token, tcr]) for (const [op, args] of ops) {
        const reply = await r.call(token, op, args, op.startsWith("retirement.p") && op !== "retirement.preview" || op === "retirement.agent" ? cid("c") : undefined);
        assert.equal(reply.ok, false, op); assert.ok(["forbidden", "unauthenticated", "fenced"].includes(reply.error!.code), `${op}: ${reply.error!.code}`);
      }

      // Credential-shaped reasons (built here, never real) are refused before anything changes.
      const plan = await r.retirement.preview(w.owner, { kind: "agent", id: ann.agentId });
      const shapes = [
        ["sk-ant-api03-", "A".repeat(40)], ["ghp_", "b".repeat(36)], ["AKIA", "ABCDEFGHIJKLMNOP"], ["xoxb-", "1234567890-", "abcdefghijklmnop"],
        ["-----BEGIN ", "PRIVATE KEY-----"], ["Bearer ", "eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxIn0", ".", "c2lnbmF0dXJlc2lnbmF0dXJl"], ["password=", "hunter2hunter2"], ["sk-proj-", "c".repeat(40)], ["glpat-", "d".repeat(20)],
      ].map((parts) => `she left; ${parts.join("")}`);
      const passed: string[] = [];
      for (const reason of shapes) if (await code(r.retirement.retireAgent(w.owner, { commandId: cid("x"), agentId: ann.agentId, reason, confirm: plan.digest })) !== "invalid_command") passed.push(reason.slice(10, 24));
      assert.deepEqual(passed, [], "every credential shape is refused");
      assert.equal((await r.retirement.list(w.owner)).items.length, 0);

      // Chat: a proposal made, then a task assigned before the owner's yes: the yes does not retire the agent (the digest it carries is stale).
      const chat = w.chat();
      const text = "retire Annabel, she is leaving";
      script[text] = [{ kind: "command", op: "retirement.agent", args: { agentName: "Annabel", reason: "she is leaving" }, evidence: text, basis: "owner" }];
      const proposed = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
      assert.equal(proposed.outcomes[0]!.status, "proposed", JSON.stringify(proposed.outcomes[0]));
      await assign(w, t, ann.principalId);
      const yes = await chat.applyProposal(w.ownerToken, { commandId: cid("y"), proposalId: proposed.outcomes[0]!.proposalId! }).catch((e: unknown) => ({ applied: false, error: e }));
      assert.notEqual((yes as { applied?: boolean }).applied, true, JSON.stringify(yes));
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "active");
      await assert.rejects(chat.submit(bob.token, { messageId: cid("n"), text }), (e: unknown) => (e as { code?: string }).code === "forbidden");
      await release(w, t);

      // The ledger is an ordinary record: it and its claim are in a backup copy of the store, and retention holds both.
      const ok = await r.retirement.preview(w.owner, { kind: "agent", id: ann.agentId });
      const done = await r.retirement.retireAgent(w.owner, { commandId: cid("go"), agentId: ann.agentId, reason: "left", confirm: ok.digest });
      const snap = await w.world.storage.snapshot();
      const kinds = new Set<string>();
      try {
        for (let after: Record<string, unknown> | undefined; ;) {
          const rows = await snap.read("aggregates", { ...(after === undefined ? {} : { after: after as never }), limit: 500 });
          for (const row of rows) if (String(row["kind"]).startsWith("retirement")) kinds.add(`${String(row["kind"])}:${String(row["id"]).slice(0, 3)}`);
          if (rows.length < 500) break;
          after = rows[rows.length - 1] as Record<string, unknown>;
        }
      } finally { await snap.close(); }
      assert.deepEqual([...kinds].sort(), ["retirement-claim:rtc", "retirement:rtm"]);
      assert.ok(done.id.startsWith("rtm-"));
      const { RetainedMaterial } = await import("../retention/index.js");
      const material = await RetainedMaterial.build(w.world.storage, {});
      assert.ok((material.why("retirement", done.id) ?? []).length > 0);
      assert.ok((material.why("retirement-claim", "rtc-x") ?? []).length > 0);
    } finally { await r.close(); }
  });
}

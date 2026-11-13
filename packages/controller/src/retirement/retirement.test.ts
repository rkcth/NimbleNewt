import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { options as clockOptions, cid, openWorld, type World } from "../chat/testing/harness.js";
import { IntegratorLeaseService } from "../landing/index.js";
import { IncidentService, MaintenanceLeaseService } from "../projects/index.js";
import { RetainedMaterial } from "../retention/index.js";
import { GrantService, type Principal } from "../security/index.js";
import { RetirementService, type RetirementPorts } from "./index.js";

after(stopServer);

type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };

interface Rig {
  readonly w: World;
  readonly retirement: RetirementService;
  readonly leases: MaintenanceLeaseService;
  readonly integrator: IntegratorLeaseService;
  readonly grants: GrantService;
  readonly ports: RetirementPorts;
  readonly call: (token: string, op: string, args: Record<string, unknown>, commandId?: string) => Promise<Reply>;
  /** A second retirement service over the same store whose ports can be made to fail. */
  readonly flaky: (wrap: (p: RetirementPorts) => RetirementPorts) => RetirementService;
  readonly close: () => Promise<void>;
}

const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: unknown) => (e instanceof DomainError ? e.code : String(e)));

/** A world with the retirement service built on the same store and also reachable through the state API (and so chat). */
async function rig(backend: (typeof backends)[number], script: Record<string, unknown> = {}): Promise<Rig> {
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

/** An agent record with its own identity, a credential and two grants (one for the project, one for every project); optionally holding a maintenance lease and an integrator lease. */
async function makeAgent(r: Rig, name: string, project: string, hold?: { resource: string; task: string }) {
  const { w } = r;
  const created = await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: name });
  const agentId = created.id;
  const principalId = `agent:${agentId}`;
  const issued = await w.principals.issueCredential(w.owner, principalId);
  const g1 = (await r.grants.grant(w.owner, { commandId: cid("g"), grantee: principalId, action: "task.read", project, source: "direct", basis: "test" })).id;
  const g2 = (await r.grants.grant(w.owner, { commandId: cid("g"), grantee: principalId, action: "desk.read", project: "*", source: "direct", basis: "test" })).id;
  const acting: Principal = { id: principalId, kind: "agent", name, asOf: "2026-10-22T10:00:00.000Z", grants: [{ action: "responsibility.read", project }, { action: "responsibility.write", project }] } as Principal;
  let lease: { maintenance?: string; integrator?: string } = {};
  if (hold !== undefined) {
    await r.leases.acquire(acting, { commandId: cid("la"), resourceId: hold.resource, purpose: "patch the proxy", minutes: 30 });
    const il = await r.integrator.acquire({ commandId: cid("il"), projectId: project, branch: "main", holder: agentId, taskId: hold.task, ttlMs: 3_600_000 });
    lease = { maintenance: hold.resource, integrator: il.leaseId };
  }
  return { agentId, principalId, token: issued.token, g1, g2, acting, lease };
}

const assign = async (w: World, taskId: string, agent: { agentId: string; principalId: string }, kind: "id" | "principal" = "principal") => {
  const r = await w.assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId, owner: { kind: "agent", id: kind === "id" ? agent.agentId : agent.principalId } });
  return r;
};

for (const backend of backends) {
  test(`${backend.name}: retiring an agent is refused while it holds a live assignment, then releases its leases, revokes its grants and credential, keeps its record and ledgers it (card P06)`, async () => {
    const r = await rig(backend);
    try {
      const { w } = r;
      const p = await w.project("Ops");
      const t1 = await w.task(p, "Patch the proxy"); const t2 = await w.task(p, "Write the notes");
      const res = await w.resources.bindResource(w.owner, { commandId: cid("b"), projectId: p, kind: "service", label: "Web", locator: "https://example.test" } as never);
      await w.responsibilities.create(w.owner, { commandId: cid("r"), projectId: p, title: "Keep web up", objective: "Up", everyMinutes: 60, ownerId: (await w.agent(`keeper-${cid("k")}`, [])).principal.id, managed: [res.id] } as never);
      const ann = await makeAgent(r, "Ann", p, { resource: res.id, task: t1 });
      await assign(w, t2, ann);

      // The preview names the blocker and what would be released; a plain agent.retire is refused too.
      const plan = await r.retirement.preview(w.owner, { kind: "agent", id: ann.agentId });
      assert.deepEqual(plan.blockers.map((b) => [b.kind, b.id]), [["assignment", t2]]);
      assert.deepEqual([plan.release.maintenanceLeases.length, plan.release.integratorLeases.length, plan.release.grants.length, plan.release.credential], [1, 1, 2, true]);
      assert.equal(await code(r.retirement.retireAgent(w.owner, { commandId: cid("x"), agentId: ann.agentId, reason: "done", confirm: plan.digest })), "invalid_transition");
      const agentRev = (await w.agents.get(w.owner, ann.agentId))!.revision;
      assert.equal(await code(w.agents.retire(w.owner, { commandId: cid("x"), agentId: ann.agentId, expectedRevision: agentRev })), "invalid_command", "the plain command is refused too");
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "active");
      assert.equal((await r.leases.list(w.owner, p))![0]!.status, "held", "nothing was released by the refusal");
      assert.equal((await r.retirement.list(w.owner)).items.length, 0, "a refusal writes no ledger record");

      // A task that is finished no longer counts; a released one does not either.
      await w.assignments.releaseTask({ commandId: cid("rl"), actor: "owner:rob", taskId: t2, expectedRevision: (await w.assignments.getAssignment(t2))!.revision });
      const ready = await r.retirement.preview(w.owner, { kind: "agent", id: ann.agentId });
      assert.equal(ready.blockers.length, 0);

      // Owner only, and only with the digest of the plan as it is now.
      const bob = await w.agent("bob", [{ action: "*", project: "*" }]);
      assert.equal(await code(r.retirement.preview(bob.principal, { kind: "agent", id: ann.agentId })), "forbidden");
      assert.equal(await code(r.retirement.retireAgent(bob.principal, { commandId: cid("x"), agentId: ann.agentId, reason: "no", confirm: ready.digest })), "forbidden");
      assert.equal(await code(r.retirement.retireAgent(w.owner, { commandId: cid("x"), agentId: ann.agentId, reason: "done", confirm: "0".repeat(32) })), "invalid_command");
      assert.equal(await code(r.retirement.retireAgent(w.owner, { commandId: cid("x"), agentId: ann.agentId, reason: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", confirm: ready.digest })), "invalid_command", "a credential-shaped reason is refused");

      const commandId = cid("retire");
      const done = await r.retirement.retireAgent(w.owner, { commandId, agentId: ann.agentId, reason: "left the team", confirm: ready.digest });
      assert.equal(done.status, "done"); assert.equal(done.replayed, false);
      assert.deepEqual([done.record.action, done.record.subjectId, done.record.reason, done.record.requestedBy, done.record.status], ["retire-agent", ann.agentId, "left the team", w.owner.id, "done"]);
      assert.ok(done.record.finishedAt !== undefined);
      assert.deepEqual([done.record.released.maintenanceLeases.length, done.record.released.integratorLeases.length, done.record.released.grants.length, done.record.released.credential], [1, 1, 2, true]);

      // What it held is gone; its identity is disabled and its credential no longer works.
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "retired");
      assert.equal((await r.leases.list(w.owner, p))![0]!.status, "free");
      assert.equal((await r.integrator.get(ann.lease.integrator!))!.state, "released");
      for (const g of [ann.g1, ann.g2]) assert.equal((await r.grants.getGrant(g))!.state, "revoked");
      await assert.rejects(w.principals.authenticate(ann.token));
      assert.equal((await w.principals.get(ann.principalId))!.state, "disabled");

      // The same command is answered from the record; the record is in the ledger.
      const again = await r.retirement.retireAgent(w.owner, { commandId, agentId: ann.agentId, reason: "left the team", confirm: ready.digest });
      assert.deepEqual([again.replayed, again.id], [true, done.id]);
      assert.equal(await code(r.retirement.retireAgent(w.owner, { commandId, agentId: ann.agentId, reason: "other words", confirm: ready.digest })), "command_conflict");
      assert.equal(await code(r.retirement.retireAgent(w.owner, { commandId: cid("again"), agentId: ann.agentId, reason: "twice", confirm: ready.digest })), "invalid_command", "an agent already retired is not retired again");
      assert.deepEqual((await r.retirement.list(w.owner)).items.map((x) => x.id), [done.id]);
      assert.equal((await r.retirement.list(w.owner, { subjectId: "agt-nobody" })).items.length, 0);

      // The record stays, readable and listed as retired; its ID is not given to anyone new.
      assert.deepEqual((await w.agents.list(w.owner, { state: "retired" })).items.map((a) => a.id), [ann.agentId]);
      const newer = await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Ann" });
      assert.notEqual(newer.id, ann.agentId);
      assert.equal((await w.agents.create(w.owner, { commandId: "same-command-0001", friendlyName: "Cy" })).id, (await w.agents.create(w.owner, { commandId: "same-command-0001", friendlyName: "Cy" })).id);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a retirement that stops halfway is visible as started and the same command carries on without doing anything twice (card P06)`, async () => {
    const r = await rig(backend);
    try {
      const { w } = r;
      const p = await w.project("Ops");
      const t1 = await w.task(p, "Patch the proxy");
      const res = await w.resources.bindResource(w.owner, { commandId: cid("b"), projectId: p, kind: "service", label: "Web", locator: "https://example.test" } as never);
      await w.responsibilities.create(w.owner, { commandId: cid("r"), projectId: p, title: "Keep web up", objective: "Up", everyMinutes: 60, ownerId: (await w.agent(`keeper-${cid("k")}`, [])).principal.id, managed: [res.id] } as never);
      const ann = await makeAgent(r, "Ann", p, { resource: res.id, task: t1 });
      const plan = await r.retirement.preview(w.owner, { kind: "agent", id: ann.agentId });
      let revokes = 0; let failOnce = true;
      const flaky = r.flaky((ports) => ({ ...ports, grants: { revoke: async (...a: Parameters<GrantService["revoke"]>) => { revokes++; if (failOnce && revokes === 2) { failOnce = false; throw new DomainError("unavailable", "the store went away"); } return ports.grants.revoke(...a); } } }));
      const commandId = cid("retire");
      assert.equal(await code(flaky.retireAgent(w.owner, { commandId, agentId: ann.agentId, reason: "left", confirm: plan.digest })), "unavailable");
      // Halfway: the record says started, the lease and the first grant are released, the agent is not retired and nothing else was touched.
      const half = (await r.retirement.list(w.owner)).items;
      assert.deepEqual(half.map((x) => x.status), ["started"]);
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "active");
      assert.equal((await r.leases.list(w.owner, p))![0]!.status, "free");
      // The same command, sent again (the plan has changed since, so the recorded digest is what counts), finishes it.
      const done = await r.retirement.retireAgent(w.owner, { commandId, agentId: ann.agentId, reason: "left", confirm: plan.digest });
      assert.equal(done.status, "done");
      assert.equal((await r.retirement.list(w.owner)).items.length, 1, "one ledger record, not two");
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "retired");
      for (const g of [ann.g1, ann.g2]) assert.equal((await r.grants.getGrant(g))!.state, "revoked");
      assert.equal(revokes, 2, "the resumed run went through the other service; the first grant was revoked once and not again");
      const events = (await r.w.world.storage.listAggregates("grant-record", { limit: 50 })).filter((g) => g.id === ann.g1 || g.id === ann.g2).map((g) => g.revision);
      assert.deepEqual(events, [2, 2], "each grant record was written once for the grant and once for the revoke");
    } finally { await r.close(); }
  });

  test(`${backend.name}: archiving a project is refused while a task is assigned; then it retires duties, frees leases and bindings, revokes its grants, keeps everything readable under the same access rules, and can be restored (card P06)`, async () => {
    const r = await rig(backend);
    try {
      const { w } = r;
      const p = await w.project("Garden"); const other = await w.project("Shed");
      const open = await w.task(p, "Water the beds"); const finished = await w.task(p, "Buy seeds"); const otherTask = await w.task(other, "Paint");
      const res = await w.resources.bindResource(w.owner, { commandId: cid("b"), projectId: p, kind: "service", label: "Hose", locator: "https://example.test/hose" } as never);
      const duty = (await w.responsibilities.create(w.owner, { commandId: cid("r"), projectId: p, title: "Keep the hose working", objective: "Works", everyMinutes: 60, ownerId: (await w.agent(`keeper-${cid("k")}`, [])).principal.id, managed: [res.id] } as never)).id;
      const ann = await makeAgent(r, "Ann", p, { resource: res.id, task: open });
      // A task finished (cancelled) while still assigned does not block; an open assigned one does.
      await assign(w, finished, ann);
      await w.projects.transitionTask({ commandId: cid("tc"), actor: "owner:rob", taskId: finished, expectedRevision: (await w.projects.getTask(finished))!.revision, to: "cancelled" } as never);
      await assign(w, open, ann);
      const plan = await r.retirement.preview(w.owner, { kind: "project", id: p });
      // Ann works on the open task and holds both leases, so they are in use and block as well (review: a lease is not freed under live work).
      assert.deepEqual(plan.blockers.map((b) => b.kind), ["assignment", "lease", "lease"]);
      assert.equal(plan.blockers[0]!.id, open);
      assert.equal(await code(r.retirement.archiveProject(w.owner, { commandId: cid("x"), projectId: p, reason: "finished", confirm: plan.digest })), "invalid_transition");
      assert.equal((await w.projects.getProject(p))!.state, "active");
      await w.assignments.releaseTask({ commandId: cid("rl"), actor: "owner:rob", taskId: open, expectedRevision: (await w.assignments.getAssignment(open))!.revision });

      // Who can read the project's tasks before: the owner, an agent with a grant in it; not an agent with none.
      const reader = await w.agent("reader", [{ action: "task.read", project: p }]);
      const outsider = await w.agent("outsider", [{ action: "task.read", project: other }]);
      const readTask = async (token: string) => { const x = await r.call(token, "task.get", { taskId: open }); return x.ok ? "read" : x.error!.code; };
      const before = [await readTask(w.ownerToken), await readTask(reader.token), await readTask(outsider.token)];
      assert.deepEqual(before, ["read", "read", before[2]]); assert.notEqual(before[2], "read");

      const ready = await r.retirement.preview(w.owner, { kind: "project", id: p });
      assert.equal(ready.blockers.length, 0);
      assert.deepEqual([ready.release.responsibilities.length, ready.release.resources.length, ready.release.maintenanceLeases.length, ready.release.integratorLeases.length, ready.release.grants.length], [1, 1, 1, 1, 0], "Ann's grant here is read-only, so it stays");
      const done = await r.retirement.archiveProject(w.owner, { commandId: cid("arch"), projectId: p, reason: "the season is over", confirm: ready.digest });
      assert.equal(done.status, "done");
      assert.equal((await w.projects.getProject(p))!.state, "archived");
      assert.equal((await w.responsibilities.get(w.owner, duty))!.state, "retired");
      assert.equal((await w.resources.get(w.owner, res.id))!.state, "unbound");
      assert.equal((await r.leases.list(w.owner, p))![0]!.status, "free");
      assert.equal((await r.integrator.get(ann.lease.integrator!))!.state, "released");
      assert.equal((await r.grants.getGrant(ann.g1))!.state, "active", "a read-only grant made for this project stays (execution grants are revoked: see retirement-review.test.ts)");
      assert.equal((await r.grants.getGrant(ann.g2))!.state, "active", "a grant for every project is not this project's to revoke");
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "active", "the agent is not retired by archiving a project");
      assert.equal((await w.projects.getProject(other))!.state, "active");
      assert.equal((await w.projects.getTask(otherTask))!.state, "proposed");

      // Archived records are still found and the access rules are the same: the reader still reads, an outsider is still refused.
      assert.equal((await w.projects.getTask(open))!.title, "Water the beds");
      assert.equal(await readTask(w.ownerToken), "read");
      assert.equal((await r.call(w.ownerToken, "project.get", { projectId: p })).result.item.state, "archived");
      assert.ok((await r.call(w.ownerToken, "task.list", { projectId: p })).result.items.length >= 2);
      assert.equal(await readTask(reader.token), "read", "a reader still reads");
      assert.equal(await readTask(outsider.token), before[2], "an outsider is refused exactly as before");
      await assert.rejects(w.projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: p, title: "More" } as never), /archived/);
      assert.equal(await code(r.retirement.archiveProject(w.owner, { commandId: cid("again"), projectId: p, reason: "twice", confirm: ready.digest })), "invalid_command");

      // Restore: active again, the ledger has both records, and what stayed released is said.
      const back = await r.retirement.restoreProject(w.owner, { commandId: cid("rest"), projectId: p, reason: "spring again" });
      assert.equal(back.status, "done");
      assert.equal((await w.projects.getProject(p))!.state, "active");
      assert.match(back.record.note ?? "", /1 responsibility\(ies\) stay retired, its 1 resource binding\(s\) stay unbound and its 0 execution grant\(s\) stay revoked/);
      assert.deepEqual((await r.retirement.list(w.owner, { subjectId: p })).items.map((x) => [x.action, x.status]), [["restore-project", "done"], ["archive-project", "done"]]);
      assert.equal(await code(r.retirement.restoreProject(w.owner, { commandId: cid("rest"), projectId: p })), "invalid_command", "an active project is not restored");
      await w.projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: p, title: "Plant again" } as never);
      // Retired responsibilities stay final: a new one is made when it is wanted.
      assert.equal((await w.responsibilities.get(w.owner, duty))!.state, "retired");
    } finally { await r.close(); }
  });

  test(`${backend.name}: retirement through the API and chat: owner only, shown first with what it releases, confirmation filled from a fresh preview, blocked plans are refused with what to release first (card P06)`, async () => {
    const script: Record<string, unknown> = {};
    const r = await rig(backend, script);
    try {
      const { w } = r;
      const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
      const p = await w.project("Garden");
      const t = await w.task(p, "Water the beds");
      const ann = await makeAgent(r, "Annabel", p);
      const bob = await w.agent("bob", [{ action: "*", project: "*" }]);

      // The API: owner only, and the digest must match.
      for (const op of ["retirement.preview", "retirement.list"]) assert.equal((await r.call(bob.token, op, op === "retirement.preview" ? { kind: "agent", id: ann.agentId } : {})).error?.code, "forbidden", op);
      assert.equal((await r.call(bob.token, "retirement.agent", { agentId: ann.agentId, reason: "x", confirm: "y" }, cid("c"))).error?.code, "forbidden");
      const preview = await r.call(w.ownerToken, "retirement.preview", { kind: "agent", id: ann.agentId });
      assert.equal(preview.ok, true); assert.match(preview.result.shown[0], /Retiring agent Annabel would/);

      // Chat: by name, in free words. It is a proposal; nothing changes until the owner agrees.
      const chat = w.chat();
      await assign(w, t, ann);
      const blockedText = "let Annabel go, she is leaving the company";
      script[blockedText] = [cmd("retirement.agent", { agentName: "Annabel", reason: "she is leaving the company" }, blockedText)];
      const blocked = await chat.submit(w.ownerToken, { messageId: cid("m"), text: blockedText });
      assert.equal(blocked.outcomes[0]!.status, "refused", JSON.stringify(blocked.outcomes[0]));
      assert.match(JSON.stringify(blocked.outcomes[0]), /assignment/, "it says what is in the way");
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "active");
      await w.assignments.releaseTask({ commandId: cid("rl"), actor: "owner:rob", taskId: t, expectedRevision: (await w.assignments.getAssignment(t))!.revision });

      const text = "retire Annabel, she is leaving the company";
      script[text] = [cmd("retirement.agent", { agentName: "Annabel", reason: "she is leaving the company", confirm: "made-up-by-the-model" }, text)];
      const r1 = await chat.submit(w.ownerToken, { messageId: cid("m"), text });
      assert.equal(r1.outcomes[0]!.status, "proposed", JSON.stringify(r1.outcomes[0]));
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "active", "nothing happens until the owner agrees");
      const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r1.outcomes[0]!.proposalId! });
      assert.equal(applied.applied, true, JSON.stringify(applied));
      assert.equal((await w.agents.get(w.owner, ann.agentId))!.state, "retired");
      assert.equal((await r.call(w.ownerToken, "retirement.list", {})).result.items.length, 1);
      assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r1.outcomes[0]!.proposalId! })).replayed, true);

      // Projects: named in the owner's words, archived on the owner's yes, brought back the same way.
      const arch = "we are done with the Garden project, archive it";
      script[arch] = [cmd("retirement.project", { projectName: "Garden" }, arch)];
      const r2 = await chat.submit(w.ownerToken, { messageId: cid("m"), text: arch });
      assert.equal(r2.outcomes[0]!.status, "proposed", JSON.stringify(r2.outcomes[0]));
      assert.equal((await w.projects.getProject(p))!.state, "active");
      assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r2.outcomes[0]!.proposalId! })).applied, true);
      assert.equal((await w.projects.getProject(p))!.state, "archived");
      const back = "bring the Garden project back";
      script[back] = [cmd("retirement.project.restore", { projectName: "Garden" }, back)];
      const r3 = await chat.submit(w.ownerToken, { messageId: cid("m"), text: back });
      assert.equal(r3.outcomes[0]!.status, "proposed", JSON.stringify(r3.outcomes[0]));
      assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("a"), proposalId: r3.outcomes[0]!.proposalId! })).applied, true);
      assert.equal((await w.projects.getProject(p))!.state, "active");
      assert.equal((await r.call(w.ownerToken, "retirement.list", { limit: 10 })).result.items.length, 3);
      // An agent cannot ask for it in chat.
      await assert.rejects(chat.submit(bob.token, { messageId: cid("n"), text }), (e: unknown) => (e as { code?: string }).code === "forbidden");
    } finally { await r.close(); }
  });
}

test("retention holds the retirement ledger and agent records for good, and the interpreter is told how to reach the controls (card P06)", async () => {
  const material = await RetainedMaterial.build({ listAggregates: async () => [] }, {});
  assert.ok((material.why("retirement", "rtm-anything") ?? []).length > 0);
  assert.ok((material.why("agent", "agt-anything") ?? []).length > 0);
  assert.equal(material.why("desk-record", "dsk-unreferenced"), undefined, "other records are unaffected");
  const { ModelInterpreter } = await import("../chat/model-interpreter.js");
  const { CHAT_OPS, acceptedArgs } = await import("../chat/index.js");
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, req) => { system = req.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "let Ann go", quoted: [], focus: {}, proposals: [] });
  for (const op of ["retirement.agent", "retirement.project", "retirement.project.restore"]) { assert.ok(system.includes(`${op}(`), op); assert.equal(CHAT_OPS[op]?.mode, "propose", `${op} is shown first`); }
  assert.ok(acceptedArgs("retirement.agent")!.includes("agentName") && acceptedArgs("retirement.agent")!.includes("reason"));
  assert.match(system, /let Ann go|let an agent go|retire the old build agent/);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { EffectRejected, EffectService } from "../domain/effects.js";
import { SimulatedServices, operationBridge } from "../service-ops/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

const layout = () => new SimulatedServices({
  billing: { db: { state: { size: 10 }, dependents: [{ service: "billing", resource: "api" }] }, api: { state: {} }, cache: { state: {} } },
  shop: { cart: { state: { replicas: 1 } } },
});

async function world(name: string, target?: SimulatedServices) {
  const d = mkdtempSync(join(tmpdir(), `nn-${name}-`));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], artifacts: { directory: join(d, "blobs") }, ...(target === undefined ? {} : { serviceTarget: target }) });
  const s = c.services;
  const boot = await s.principals.bootstrapOwner({ name: "rob" });
  const rob = await s.principals.authenticate(boot.token);
  const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
  const other = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
  const mkTask = async (title: string) => { const n = title.replace(/ /g, "-"); const id = (await s.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId: project, title })).id; await s.projects.transitionTask({ commandId: `r-${n}`, actor: rob.id, taskId: id, expectedRevision: 1, to: "ready" }); return id; };
  const task = await mkTask("Write the guide");
  const task2 = await mkTask("Restart the cart");
  const hire = async (n: string, roles: string[], inProject: string, extra: { action: string; resource?: { kind: string; id: string } }[] = []) => {
    const made = await s.agents.create(rob, { commandId: `mk-${n}`, friendlyName: n, roles });
    const id = `agent:${made.id}`;
    await s.grants.grant(rob, { commandId: `g-${n}`, grantee: id, action: "task.read", project: inProject, source: "direct", basis: "test" } as never);
    if (roles.includes("reviewer")) await s.grants.grant(rob, { commandId: `gr-${n}`, grantee: id, action: "review.decide", project: inProject, source: "direct", basis: "test" } as never);
    for (const [i, g] of extra.entries()) await s.grants.grant(rob, { commandId: `gx-${n}-${i}`, grantee: id, action: g.action, project: inProject, ...(g.resource === undefined ? {} : { resource: g.resource }), source: "direct", basis: "test" } as never);
    return { id, token: (await s.principals.issueCredential(rob, id)).token };
  };
  const owns = async (taskId: string, agentId: string, tag: string) => {
    await s.assignments.assignTask({ commandId: `as-${tag}`, actor: rob.id, taskId, owner: { kind: "agent", id: agentId } } as never);
    await s.assignments.admitAttempt({ commandId: `adm-${tag}`, actor: rob.id, taskId, expectedRevision: (await s.assignments.getAssignment(taskId))!.revision, generation: 1, owner: { kind: "agent", id: agentId }, harness: "pi" } as never);
  };
  const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
  const done = async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); };
  return { c, s, boot, rob, project, other, task, task2, hire, owns, call, done };
}

const svc = (name: string, resource?: string) => ({ action: "effect.perform", resource: { kind: "service", id: `${name}/${resource}` } });

test("P03 sentence 1: a task that is not code produces an artifact through the API, a deliverable names it, an independent reviewer accepts it; nothing earlier accepts (card P03)", async () => {
  const w = await world("p03-doc");
  try {
    const { call, boot, task, project } = w;
    const ann = await w.hire("Ann", ["author", "docs"], project, [{ action: "artifact.publish" }]);
    const rev = await w.hire("Rev", ["reviewer"], project);
    const eve = await w.hire("Eve", [], project);
    const far = await w.hire("Far", ["author", "docs"], w.other, [{ action: "artifact.publish" }]);
    await w.owns(task, ann.id, "doc");
    const files = [{ path: "findings/summary.md", text: "# Findings\nThe cache hit rate is 91%." }, { path: "findings/data.json", text: "{\"hit\":0.91}" }];

    assert.equal((await call(far.token, "artifact.publish", { taskId: task, name: "Findings", files }, "a0")).error.code, "not_found", "another project's agent cannot see the task");
    assert.equal((await call(eve.token, "artifact.publish", { taskId: task, name: "Findings", files }, "a0")).error.code, "forbidden", "an agent without the right to publish");
    assert.equal((await call(ann.token, "artifact.publish", { taskId: task, name: "Findings", files })).error.code, "invalid_command", "a command ID is required");
    assert.equal((await call(ann.token, "artifact.publish", { taskId: task, name: "Findings", files: [] }, "a0b")).error.code, "invalid_command", "at least one file");
    assert.equal((await call(ann.token, "artifact.publish", { taskId: task, name: "Findings", files: [{ path: "../escape.md", text: "x" }] }, "a0c")).error.code, "invalid_command", "a path trick is refused");
    const made = await call(ann.token, "artifact.publish", { taskId: task, name: "Findings", files }, "a1");
    assert.equal(made.ok, true, JSON.stringify(made));
    assert.equal((await call(ann.token, "artifact.publish", { taskId: task, name: "Findings", files }, "a1")).result.replayed, true, "a replay publishes once");
    const art = made.result.id as string;
    const listed = await call(boot.token, "deliverable.list", { taskId: task });
    assert.deepEqual(listed.result.items.map((i: any) => [i.id, i.files.map((f: any) => f.path)]), [[art, ["findings/data.json", "findings/summary.md"]]]);

    const draft = await call(ann.token, "deliverable.draft", { taskId: task, type: "report", title: "Cache findings", artifacts: [{ artifactId: art }] }, "d1");
    assert.equal(draft.ok, true, JSON.stringify(draft));
    const id = draft.result.id as string;
    assert.equal((await call(ann.token, "deliverable.submit", { id, expectedRevision: 1, contractVersion: 0 }, "s1")).ok, true);
    // The author finishing its work does not accept it; neither can the author.
    await call(boot.token, "task.transition", { taskId: task, expectedRevision: 2, to: "in_progress" }, "tt");
    assert.equal((await call(ann.token, "deliverable.accept", { id, version: 1 }, "x0")).error.code, "invalid_transition", "a submitted version is not under review");
    let item = (await call(boot.token, "deliverable.record.get", { id })).result.item;
    assert.equal(item.state, "submitted", "a submitted report is not accepted");
    assert.equal((await call(rev.token, "deliverable.review.start", { id, version: 1 }, "rs")).ok, true);
    assert.equal((await call(ann.token, "deliverable.accept", { id, version: 1 }, "x1")).error.code, "forbidden", "the author cannot accept its own work");
    assert.equal((await call(rev.token, "deliverable.accept", { id, version: 1 }, "ac")).ok, true);
    item = (await call(boot.token, "deliverable.record.get", { id })).result.item;
    assert.deepEqual([item.state, item.type, item.responsibleAgent, item.version.content.artifacts.map((a: any) => a.artifactId)], ["accepted", "report", ann.id, [art]]);
    assert.deepEqual((await call(boot.token, "deliverable.record.events", { id, limit: 20 })).result.items.map((e: any) => e.kind), ["draft", "submitted", "under-review", "accepted"]);
    // The accepted artifact is the one published, byte for byte.
    assert.equal((await call(boot.token, "deliverable.check", { id }, "ck")).ok, true);
  } finally { await w.done(); }
});

test("P03 sentence 2: an operation is recorded in the effect ledger and verified against the target; only a confirmed, verified operation can be named by an operational outcome (card P03)", async () => {
  const sim = layout();
  const w = await world("p03-op", sim);
  try {
    const { call, boot, c, task, task2, project } = w;
    const ann = await w.hire("Ann", ["author", "docs"], project, [svc("billing", "cache")]);
    const rev = await w.hire("Rev", ["reviewer"], project);
    await w.owns(task, ann.id, "op");
    const cache = { service: "billing", resource: "cache" };
    const before = sim.versionOf(cache)!;

    const first = await call(ann.token, "service.operate", { taskId: task, ...cache, action: { type: "set", params: { fields: { ttl: 60 } } } }, "o1");
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.result.status, "confirmed");
    const out = first.result.outcome as { reference: string; systemVersion: string; observedAt: string };
    assert.equal(out.systemVersion, `v${before + 1}`, "the version the TARGET reports");
    assert.equal(out.reference, first.result.effectId);
    assert.deepEqual(sim.stateOf(cache), { ttl: 60 });
    const row = await c.storage.getEffect(out.reference);
    assert.equal(row!.status, "confirmed");
    assert.equal(row!.target, "service:billing/cache", "the ledger names the target");
    assert.equal((row!.evidence as any).verified, true);
    assert.equal((row!.evidence as any).observedAt, out.observedAt);
    const again = await call(ann.token, "service.operate", { taskId: task, ...cache, action: { type: "set", params: { fields: { ttl: 60 } } } }, "o1");
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.result.effectId, first.result.effectId, "a replay is the same effect");
    assert.equal(sim.calls.filter((x) => x.applied).length, 1, "the target applied it once");

    // Free text, another version, another time, another task's operation: none is a verified reference.
    const draft = (extra: Record<string, unknown>, cid: string, taskId = task) => call(ann.token, "deliverable.draft", { taskId, type: "operational-outcome", title: "Cache TTL", outcome: { ...out, ...extra }, ...{} }, cid);
    assert.match((await draft({ reference: "restarted it, trust me" }, "d0")).error.message, /service\.operate/, "free text is refused");
    assert.equal((await draft({ reference: "eff-aaaaaaaaaaaaaaaaaaaa" }, "d0a")).error.code, "invalid_command", "an effect that does not exist");
    assert.match((await draft({ systemVersion: "v99" }, "d0b")).error.message, /not as the outcome says/);
    assert.match((await draft({ observedAt: "2026-01-01T00:00:00.000Z" }, "d0c")).error.message, /not as the outcome says/);
    assert.match((await draft({}, "d0d", task2)).error.message, /another task|not a service operation|may not/, "the operation belongs to another task");

    const made = await draft({}, "d1");
    assert.equal(made.ok, true, JSON.stringify(made));
    const id = made.result.id as string;
    assert.equal((await call(ann.token, "deliverable.submit", { id, expectedRevision: 1, contractVersion: 0 }, "s1")).ok, true);
    assert.equal((await call(rev.token, "deliverable.review.start", { id, version: 1 }, "rs")).ok, true);
    assert.equal((await call(rev.token, "deliverable.accept", { id, version: 1 }, "ac")).ok, true);

    // A lost answer: the target applied it; the adapter asks and finds it applied, and never applies twice.
    const applied = sim.calls.filter((x) => x.applied).length;
    sim.faults.loseNextAnswer = true;
    const lost = await call(ann.token, "service.operate", { taskId: task, ...cache, action: { type: "restart" } }, "o2");
    assert.equal(lost.result.status, "confirmed", JSON.stringify(lost));
    assert.equal(lost.result.evidence.recovered, true);
    assert.equal(sim.calls.filter((x) => x.applied).length, applied + 1, "applied once");

    // The target did something else than asked: not confirmed, no outcome, never retried blindly.
    sim.faults.corruptNext = true;
    const bad = await call(ann.token, "service.operate", { taskId: task, ...cache, action: { type: "set", params: { fields: { ttl: 5 } } } }, "o3");
    assert.equal(bad.result.status, "uncertain", JSON.stringify(bad));
    assert.equal(bad.result.outcome, undefined);
    assert.match(bad.result.evidence.reason, /ttl/);
    const calls = sim.calls.length;
    const retry = await call(ann.token, "service.operate", { taskId: task, ...cache, action: { type: "set", params: { fields: { ttl: 5 } } } }, "o3");
    assert.equal(retry.error.code, "effect_uncertain", "an uncertain effect blocks a blind retry");
    assert.equal(sim.calls.length, calls, "the target was not asked to do it again");
    const nameIt = await call(ann.token, "deliverable.draft", { taskId: task, type: "operational-outcome", title: "x", outcome: { reference: bad.result.effectId, systemVersion: "v1", observedAt: "2026-10-31T10:00:00.000Z" } }, "d2");
    assert.match(nameIt.error.message, /uncertain, not confirmed/, "an unverified operation cannot be named");
    // A person who checked by hand and resolves it as confirmed: the ledger says confirmed, but the adapter never verified it, so it is still not a verified outcome.
    await EffectService.withEpoch(c.storage, c.epoch, undefined).resolve({ commandId: "res1", actor: w.rob.id, effectId: bad.result.effectId, outcome: "confirmed", evidence: { checkedBy: "rob", how: "looked at the dashboard" } });
    const byHand = await call(ann.token, "deliverable.draft", { taskId: task, type: "operational-outcome", title: "x", outcome: { reference: bad.result.effectId, systemVersion: "v1", observedAt: "2026-10-31T10:00:00.000Z" } }, "d3");
    assert.match(byHand.error.message, /not verified against the target/, "a hand-resolved effect is not a verified outcome");

    // The target refuses: failed, nothing changed.
    sim.faults.refuseNext = "maintenance window";
    const refused = await call(ann.token, "service.operate", { taskId: task, ...cache, action: { type: "restart" } }, "o4");
    assert.equal(refused.result.status, "failed");
    assert.equal(refused.result.outcome, undefined);
    // Nothing to operate: unknown resource.
    assert.equal((await call(boot.token, "service.operate", { taskId: task, service: "billing", resource: "nope", action: { type: "restart" } }, "o5")).error.code, "not_found");
  } finally { await w.done(); }
});

test("P03 sentence 3: a scoped repair cannot affect a collateral service: refused before anything is done, and a leak is caught and not confirmed (card P03)", async () => {
  const sim = layout();
  const w = await world("p03-scope", sim);
  try {
    const { call, boot, task, project } = w;
    const db = { service: "billing", resource: "db" };
    const ann = await w.hire("Ann", ["author", "docs"], project, [svc("billing", "db")]);
    const bob = await w.hire("Bob", ["author"], project, [svc("billing", "db")]);
    const wide = await w.hire("Wide", ["author"], project, [{ action: "effect.perform" }]);
    await w.owns(task, ann.id, "scope");
    const snapshot = () => ["billing/db", "billing/api", "billing/cache", "shop/cart"].map((k) => sim.versionOf({ service: k.split("/")[0]!, resource: k.split("/")[1]! }));
    const start = snapshot();

    // A restart of the database also restarts the API that depends on it: outside the scope, refused, nothing touched.
    const refused = await call(ann.token, "service.operate", { taskId: task, ...db, action: { type: "restart" } }, "r1");
    assert.equal(refused.error.code, "forbidden", JSON.stringify(refused));
    assert.match(refused.error.message, /billing\/api/, "the message names the collateral service");
    assert.deepEqual(snapshot(), start, "no service changed");
    assert.equal(sim.calls.length, 0, "the target was not called");
    assert.equal((await boot.token !== "" && (await call(boot.token, "task.get", { taskId: task })).ok), true);
    // Another resource entirely, and a resource of another service: no right.
    assert.equal((await call(ann.token, "service.operate", { taskId: task, service: "shop", resource: "cart", action: { type: "set", params: { fields: { replicas: 5 } } } }, "r2")).error.code, "forbidden");
    assert.equal((await call(ann.token, "service.operate", { taskId: task, service: "billing", resource: "cache", action: { type: "restart" } }, "r2b")).error.code, "forbidden");
    // An agent that does not own the task's current attempt cannot operate even with the right.
    assert.equal((await call(bob.token, "service.operate", { taskId: task, ...db, action: { type: "set", params: { fields: { size: 11 } } } }, "r3")).error.code, "forbidden");
    // Looking is scoped the same way.
    assert.equal((await call(ann.token, "service.observe", { taskId: task, ...db })).ok, true);
    assert.equal((await call(ann.token, "service.observe", { taskId: task, service: "shop", resource: "cart" })).error.code, "forbidden");

    // The change that stays inside the scope is applied, verified, and the neighbours are shown unchanged.
    const ok = await call(ann.token, "service.operate", { taskId: task, ...db, action: { type: "set", params: { fields: { size: 20 } } } }, "r4");
    assert.equal(ok.result.status, "confirmed", JSON.stringify(ok));
    assert.equal(ok.result.evidence.collateralUnchanged, true);
    assert.equal(ok.result.evidence.collateralChecked, 3);
    assert.deepEqual(snapshot(), [start[0]! + 1, start[1], start[2], start[3]], "only the target moved");

    // A target that leaks into a neighbour: the change landed, but it is NOT confirmed, and the leak is named.
    sim.faults.leakInto = { service: "shop", resource: "cart" };
    const leaked = await call(ann.token, "service.operate", { taskId: task, ...db, action: { type: "set", params: { fields: { size: 30 } } } }, "r5");
    assert.equal(leaked.result.status, "uncertain", JSON.stringify(leaked));
    assert.equal(leaked.result.outcome, undefined);
    assert.deepEqual(leaked.result.evidence.collateralMoved, ["shop/cart"]);
    assert.equal(leaked.result.evidence.verified, false);

    // The bridge itself also refuses an action that reaches beyond the scope recorded in the intent (defence in depth).
    const calls = sim.calls.length;
    const bridge = operationBridge(sim);
    const request = { effectId: "eff-aaaaaaaaaaaaaaaaaaaa", key: "k", kind: "service-op", target: "service:billing/db", input: { ...db, action: { type: "restart" }, allowed: [db], before: (await sim.observe(db))!, baseline: {} } as never };
    await assert.rejects(() => bridge.execute(request), (e: unknown) => e instanceof EffectRejected && /billing\/api/.test((e as Error).message));
    assert.equal(sim.calls.length, calls, "nothing was applied");

    // With the right on every resource the action reaches, the same restart is allowed, and its cascade is recorded.
    await w.owns(w.task2, wide.id, "wide");
    const cascade = await call(wide.token, "service.operate", { taskId: w.task2, ...db, action: { type: "restart" } }, "r6");
    assert.equal(cascade.result.status, "confirmed", JSON.stringify(cascade));
    assert.deepEqual(cascade.result.evidence.affected, ["billing/db", "billing/api"]);
    // The owner may do it too; without a connected service nothing can be done.
    assert.equal((await call(boot.token, "service.operate", { taskId: task, ...db, action: { type: "bogus" } }, "r7")).result.status, "failed");
  } finally { await w.done(); }

  const none = await world("p03-none");
  try {
    const r = await none.call(none.boot.token, "service.operate", { taskId: none.task, service: "billing", resource: "db", action: { type: "restart" } }, "n1");
    assert.equal(r.error.code, "unavailable");
    const draft = await none.call(none.boot.token, "deliverable.draft", { taskId: none.task, type: "operational-outcome", title: "x", outcome: { reference: "eff-aaaaaaaaaaaaaaaaaaaa", systemVersion: "v1", observedAt: "2026-10-31T10:00:00.000Z" } }, "n2");
    assert.equal(draft.error.code, "invalid_command", "an outcome naming no real operation is refused");
  } finally { await none.done(); }
});

test("P03 review: a per-resource service grant survives on the agent's task credential, so the scoping works through the real credential path, and a decision may agree such a grant (card P03)", async () => {
  const sim = layout();
  const w = await world("p03-cred", sim);
  try {
    const { call, task, project, s, rob } = w;
    const db = { service: "billing", resource: "db" };
    const ann = await w.hire("Ann", ["author"], project, [svc("billing", "db")]);
    await w.owns(task, ann.id, "cred");
    const cred = (await s.taskCredentials.issue(rob, { commandId: "tc-ann", taskId: task, agentId: ann.id })).token;
    const effective = await s.taskCredentials.authenticate(cred);
    assert.ok(effective.grants.some((g) => g.action === "effect.perform" && g.resource?.kind === "service" && g.resource.id === "billing/db"), "the resource grant is on the task credential");
    // The database alone: allowed. Its dependent API and everything else: no right, though the same credential holds the db one.
    const ok = await call(cred, "service.operate", { taskId: task, ...db, action: { type: "set", params: { fields: { size: 12 } } } }, "c1");
    assert.equal(ok.result?.status, "confirmed", JSON.stringify(ok));
    assert.equal((await call(cred, "service.operate", { taskId: task, service: "billing", resource: "api", action: { type: "restart" } }, "c2")).error.code, "forbidden");
    assert.equal((await call(cred, "service.observe", { taskId: task, service: "shop", resource: "cart" })).error.code, "forbidden");
    assert.equal((await call(cred, "service.observe", { taskId: task, ...db })).ok, true);

    // A decision may agree such a grant, for one service resource and nothing else.
    const bob = await w.hire("Bob", ["author"], project);
    const agreed = { grantee: bob.id, project, basis: "agreed in the meeting", expiresAt: new Date(Date.now() + 3600_000).toISOString(), decisionId: "dec-1", agreedBy: "owner:rob" };
    const made = await s.grants.grantAgreed(rob, { commandId: "ag-1", action: "effect.perform", resource: { kind: "service", id: "billing/api" }, ...agreed } as never);
    assert.ok(made.id);
    await assert.rejects(s.grants.grantAgreed(rob, { commandId: "ag-2", action: "effect.perform", ...agreed } as never), /one service resource/);
    await assert.rejects(s.grants.grantAgreed(rob, { commandId: "ag-3", action: "effect.perform", resource: { kind: "task", id: task }, ...agreed } as never), /service resource/);
    await assert.rejects(s.grants.grantAgreed(rob, { commandId: "ag-4", action: "task.read", resource: { kind: "service", id: "billing/api" }, ...agreed } as never), /cannot be granted on a service resource/);
  } finally { await w.done(); }
});

test("P03 review: settling an operation whose answer was lost compares the neighbours with their versions when it was applied, not with the older intent (card P03)", async () => {
  const sim = layout();
  const db = { service: "billing", resource: "db" };
  const cache = { service: "billing", resource: "cache" };
  const stale: Record<string, number> = {};
  for (const n of await sim.neighbours(db)) if (!(n.service === db.service && n.resource === db.resource)) stale[`${n.service}/${n.resource}`] = sim.versionOf(n)!;
  // Someone else changes a neighbour after the intent was recorded and before the operation was applied.
  await sim.apply("someone-else", cache, { type: "set", params: { fields: { x: 1 } } });
  const bridge = operationBridge(sim);
  const request = { effectId: "eff-bbbbbbbbbbbbbbbbbbbb", key: "k-lost", kind: "service-op", target: "service:billing/db", input: { ...db, action: { type: "set", params: { fields: { size: 11 } } }, allowed: [db], before: (await sim.observe(db))!, baseline: stale } as never };
  sim.faults.loseNextAnswer = true;
  await assert.rejects(() => bridge.execute(request));
  const settled = await bridge.reconcile!(request);
  assert.equal(settled.state, "applied", JSON.stringify(settled));
});

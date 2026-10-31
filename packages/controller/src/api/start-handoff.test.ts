import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { WorkerHost } from "../dispatch/index.js";
import { PI } from "../dispatch/testing/world.js";
import { DomainError } from "../domain/errors.js";
import { NotificationService } from "../notifications/index.js";
import { describeReassigned, responsibilityHandover } from "../lifecycle/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const UNTRACKED = "integrator lease and workspace holds: not tracked by this installation yet, so any the sender holds are missing from this section, not absent";
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a task is handed to another agent through the state API: prepared, package from the contract, incomplete until the gap is accepted, then moved once (card L03b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-handoff-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "weed the beds", description: "Clear the north beds." }, "t1")).result.id as string;
    const a = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    const b = (await c.services.agents.create(rob, { commandId: "ag-b", friendlyName: "B" })).id;
    await c.services.contracts.setContract(rob, { commandId: "ct1", taskId: task, expectedVersion: 0, acceptanceCriteria: ["beds are clear", "photos attached"] } as never);
    await call(boot.token, "task.transition", { taskId: task, to: "ready", expectedRevision: 1 }, "tr1");
    assert.ok((await call(boot.token, "task.assign", { taskId: task, owner: { kind: "agent", id: a } }, "as1")).ok);
    await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
    const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;

    // A stranger, a retired or unknown recipient, and the same owner are refused.
    assert.equal((await call(zed, "handoff.prepare", { taskId: task, to: { kind: "agent", id: b }, reason: "x" }, "h0")).error.code, "forbidden");
    assert.equal((await call(boot.token, "handoff.prepare", { taskId: task, to: { kind: "agent", id: "agt-zzzzzzzzzzzzzzzzzzzz" }, reason: "x" }, "h1")).error.code, "invalid_command");
    assert.equal((await call(boot.token, "handoff.prepare", { taskId: task, to: { kind: "agent", id: a }, reason: "x" }, "h2")).error.code, "invalid_command");

    // An agent with no right to work in the project cannot take the task (card L03d); once it has the right the hand-off goes ahead.
    const noRight = await call(boot.token, "handoff.prepare", { taskId: task, to: { kind: "agent", id: b }, reason: "A is going on leave" }, "h2b");
    assert.equal(noRight.error.code, "invalid_command");
    assert.match(noRight.error.message, /no right to work/);
    await c.services.grants.grant(rob, { commandId: "g-b", grantee: `agent:${b}`, action: "attempt.work", project, source: "direct", basis: "test" });
    const prepared = await call(boot.token, "handoff.prepare", { taskId: task, to: { kind: "agent", id: b }, reason: "A is going on leave" }, "h3");
    assert.ok(prepared.ok, JSON.stringify(prepared));
    const item = prepared.result.item;
    assert.equal(item.phase, "ready");
    assert.match(item.package.sections.brief, /weed the beds/);
    assert.match(item.package.sections.acceptanceCriteria, /photos attached/);
    assert.deepEqual(item.package.missing, ["unfinishedWork", "nextAction"], "what the controller cannot supply is reported, not invented");
    assert.equal((await call(boot.token, "handoff.complete", { handoffId: item.id }, "h4")).error.code, "invalid_command");
    assert.equal((await call(zed, "handoff.get", { handoffId: item.id })).error.code, "not_found");
    const done = await call(boot.token, "handoff.complete", { handoffId: item.id, acceptGaps: true }, "h5");
    assert.equal(done.result.item.phase, "transferred", JSON.stringify(done));
    assert.deepEqual(done.result.item.acceptedGaps.missing, ["unfinishedWork", "nextAction"]);
    const owner = (await call(boot.token, "assignment.get", { taskId: task })).result.item;
    assert.equal(owner.owner.id, b);
    const steps = await call(boot.token, "activity.steps", { taskId: task });
    assert.ok(steps.ok, JSON.stringify(steps));
    assert.ok(steps.result.steps.some((x: { kind: string; summary: string }) => x.kind === "ownership" && x.summary.includes(b)), "the move is in the task's activity record");
    assert.equal((await call(boot.token, "handoff.sweep", {}, "sw")).ok, true);
    assert.equal((await call(zed, "handoff.sweep", {}, "sw2")).error.code, "forbidden");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a hand-off left mid-transfer when the controller stopped is finished by the running controller's own sweep, once (card L03c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-handoff-"));
  const file = join(d, "c.sqlite");
  const open = () => startController({ storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  let c = await open();
  let hid = "";
  let task = ""; let b = ""; let token = "";
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    token = boot.token;
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
    task = (await call("task.create", { projectId: project, title: "weed", description: "north beds" }, "t1")).result.id as string;
    const a = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    b = (await c.services.agents.create(rob, { commandId: "ag-b", friendlyName: "B" })).id;
    await c.services.grants.grant(rob, { commandId: "g-b", grantee: `agent:${b}`, action: "attempt.work", project, source: "direct", basis: "test" });
    await call("task.transition", { taskId: task, to: "ready", expectedRevision: 1 }, "tr1");
    await call("task.assign", { taskId: task, owner: { kind: "agent", id: a } }, "as1");
    const prepared = await call("handoff.prepare", { taskId: task, to: { kind: "agent", id: b }, reason: "leave" }, "h1");
    hid = prepared.result.item.id;
    // The controller died after writing "transferring" and before the transfer.
    const rec = await c.storage.getAggregate({ kind: "handoff", id: hid });
    const left = { ...(rec!.body as Record<string, unknown>), phase: "transferring" } as never;
    await c.storage.applyOperation({ operationId: "left", epoch: c.epoch, actor: "owner:rob", correlationId: "left", at: new Date().toISOString(), changes: [{ type: "update", ref: { kind: "handoff", id: hid }, expectedRevision: rec!.revision, body: left }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
  } finally { await c.close(); }
  c = await open();
  try {
    await c.dispatch!.dispatcher.tick();
    const after = await c.storage.getAggregate({ kind: "handoff", id: hid });
    assert.equal((after!.body as { phase: string }).phase, "transferred");
    const owner = (await c.api.handle(token, { v: 1, op: "assignment.get", args: { taskId: task } } as never)) as any;
    assert.equal(owner.result.item.owner.id, b, "moved to the new owner");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the package carries the sender's shared drafts on the task and the responsibilities it answers for, never private scratch (card L03g)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-handoff-extra-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "weed the beds", description: "Clear the north beds." }, "t1")).result.id as string;
    const other = (await call(boot.token, "task.create", { projectId: project, title: "water", description: "Water." }, "t2")).result.id as string;
    const a = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    const b = (await c.services.agents.create(rob, { commandId: "ag-b", friendlyName: "B" })).id;
    for (const [who, action] of [[a, "desk.write"], [a, "desk.read"], [a, "responsibility.read"], [a, "attempt.work"], [b, "attempt.work"]] as const) await c.services.grants.grant(rob, { commandId: `g-${who}-${action}`, grantee: `agent:${who}`, action, project, source: "direct", basis: "test" });
    await call(boot.token, "task.transition", { taskId: task, to: "ready", expectedRevision: 1 }, "tr1");
    assert.ok((await call(boot.token, "task.assign", { taskId: task, owner: { kind: "agent", id: a } }, "as1")).ok);
    const aToken = (await c.services.principals.issueCredential(rob, `agent:${a}`)).token;
    const asA = await c.services.principals.authenticate(aToken);
    const write = (commandId: string, extra: Record<string, unknown>) => c.services.desks.write(asA, { commandId, projectId: project, kind: "note", title: "work", body: "text", visibility: "shared", status: "draft", ...extra } as never);
    await write("d1", { taskId: task, title: "Bed plan", body: "North bed:\n  carrots first" });
    await write("d2", { taskId: task, title: "Private thought", body: "do not share", visibility: "private" });
    await write("d3", { taskId: other, title: "Other task draft" });
    await write("d4", { taskId: task, title: "Accepted note", status: "accepted" });
    await c.services.responsibilities.create(rob, { commandId: "r1", projectId: project, title: "Keep the compost turned", objective: "Compost stays healthy", desiredCondition: "Turned weekly", ownerId: `agent:${a}` } as never);
    await c.services.responsibilities.create(rob, { commandId: "r2", projectId: project, title: "Someone else's", objective: "x", desiredCondition: "y" } as never);
    const prepared = await call(boot.token, "handoff.prepare", { taskId: task, to: { kind: "agent", id: b }, reason: "leave" }, "h1");
    assert.ok(prepared.ok, JSON.stringify(prepared));
    const sections = prepared.result.item.package.sections;
    assert.match(sections.drafts, /"Bed plan": North bed: carrots first/);
    assert.ok(!/Private thought|do not share|Other task draft|Accepted note/.test(sections.drafts), sections.drafts);
    assert.match(sections.responsibilities, /Keep the compost turned/);
    assert.ok(!/Someone else's/.test(sections.responsibilities));
    assert.equal(sections.locks, UNTRACKED, "no hold is known, but the two kinds nobody keeps yet are named as a gap and not claimed absent");
    // Someone who only controls the task does not see the sender's drafts or responsibilities; the owner and the sender do.
    await c.services.grants.grant(rob, { commandId: "g-mgr", grantee: `agent:${b}`, action: "lifecycle.pause", project, source: "direct", basis: "test" });
    const bToken = (await c.services.principals.issueCredential(rob, `agent:${b}`)).token;
    const seen = await call(bToken, "handoff.get", { handoffId: prepared.result.item.id });
    if (seen.ok) assert.ok(seen.result.item === undefined || (seen.result.item.package.sections.drafts === undefined && seen.result.item.package.sections.responsibilities === undefined), JSON.stringify(seen.result.item?.package?.sections));
    assert.match((await call(boot.token, "handoff.get", { handoffId: prepared.result.item.id })).result?.item?.package?.sections?.drafts ?? "", /Bed plan/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the real hand-off locks source: checkout holds whoever started them, claims limited to what the recipient may see, a sender who cannot read is a gap and not 'no claims', a malformed managed entry skips only itself (card L03h)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-handoff-locks-"));
  let enter!: () => void; const entered = new Promise<void>((ok) => { enter = ok; });
  let release!: () => void; const gate = new Promise<void>((ok) => { release = ok; });
  const host: WorkerHost = { hostId: "host:w1", resources: { cpus: 1, memoryMb: 512 }, start: async () => { throw new Error("no attempt"); }, workspace: { run: async () => { enter(); await gate; return { ok: true, summary: "refreshed" }; } } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), intervalMs: 1000, workers: [host] } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
    const mk = async (n: string) => (await call("task.create", { projectId: project, title: n, description: n }, `t-${n}`)).result.id as string;
    const agent = async (n: string, actions: string[]) => { const id = (await c.services.agents.create(rob, { commandId: `ag-${n}`, friendlyName: n })).id; for (const action of actions) await c.services.grants.grant(rob, { commandId: `g-${n}-${action}`, grantee: `agent:${id}`, action, project, source: "direct", basis: "test" } as never); return id; };
    const a = await agent("A", ["responsibility.read"]);          // sender who can read responsibilities
    const blind = await agent("Blind", []);                         // sender who cannot
    const clean = await agent("Clean", ["responsibility.read"]);   // sender with no claims
    const noSee = await agent("NoSee", ["attempt.work"]);          // recipient with no read rights
    const sees = await agent("Sees", ["attempt.work", "resource.read", "responsibility.read"]);
    const t1 = await mk("one"), t2 = await mk("two"), t3 = await mk("three"), t4 = await mk("four");
    let n = 0;
    for (const [t, who] of [[t1, a], [t2, a], [t3, blind], [t4, clean]] as const) { await call("task.transition", { taskId: t, to: "ready", expectedRevision: 1 }, `tr${n++}`); assert.ok((await call("task.assign", { taskId: t, owner: { kind: "agent", id: who } }, `as${n++}`)).ok); }
    const res = await c.services.resources.bindResource(rob, { commandId: "b1", projectId: project, kind: "repository", label: "plot", locator: "/r/plot" } as never);
    const duty = await c.services.responsibilities.create(rob, { commandId: "r1", projectId: project, title: "Keep the plot", objective: "o", desiredCondition: "tidy", ownerId: `agent:${a}`, managed: [res.id] } as never);
    const blindDuty = await c.services.responsibilities.create(rob, { commandId: "r2", projectId: project, title: "Blind duty", objective: "o", desiredCondition: "tidy", ownerId: `agent:${blind}` } as never);
    // A managed entry that is not a resource ID (as an older record might hold) must skip only itself.
    void blindDuty;
    const corrupt = async () => { const rec = await c.storage.getAggregate({ kind: "responsibility", id: duty.id }); await c.storage.applyOperation({ operationId: "corrupt", epoch: c.epoch, actor: "owner:rob", correlationId: "corrupt", at: new Date().toISOString(), changes: [{ type: "update", ref: { kind: "responsibility", id: duty.id }, expectedRevision: rec!.revision, body: { ...(rec!.body as Record<string, unknown>), managed: ["not a resource id", res.id] } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never); };
    const sections = async (task: string, to: string, id: string) => { const r = await call("handoff.prepare", { taskId: task, to: { kind: "agent", id: to }, reason: "leave" }, id); assert.ok(r.ok, JSON.stringify(r)); return r.result.item.package.sections as Record<string, string | undefined>; };

    // Requester not the sender: the owner starts a refresh on t1 and the checkout hold shows, labelled with who started it.
    const pending = call("workspace.request", { operation: "refresh", taskId: t1, reason: "base moved" }, "w1");
    await entered;
    const none = await sections(t1, noSee, "h1");
    assert.match(none["locks"] ?? "", /checkout of .*refresh in progress, started by owner:rob/, none["locks"]);
    assert.ok(!(none["locks"] ?? "").includes(res.id) && !(none["locks"] ?? "").includes(duty.id), "a recipient without the rights does not get the IDs");
    assert.match(none["locks"] ?? "", /1 held by the sender's responsibilities \(repository x1\); details withheld/);
    release(); await pending;
    // Claim match with a recipient who may read both: named. The refresh is over, so no checkout line. A malformed managed entry skips only itself.
    await corrupt();
    const full = await sections(t2, sees, "h2");
    assert.equal(full["locks"], `resource claims: 1 managed entry of the sender's responsibilities could not be checked and is missing from this section\nresource ${res.id}: claimed by responsibility ${duty.id}; the claim stays with ${duty.id} until it is reassigned\n${UNTRACKED}`);
    // Gap versus none: a sender who cannot read responsibilities is reported as unknown; one who can and holds nothing leaves the section empty.
    assert.match((await sections(t3, sees, "h3"))["locks"] ?? "", /not known; the sender may not read/);
    assert.equal((await sections(t4, sees, "h4"))["locks"], UNTRACKED, "nothing held, but the two kinds of lock nobody keeps yet are named as a gap");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the owner moves chosen responsibilities of the sender to the recipient with the task: checked before anything moves, claims travel with them, per-entry failures reported (card L03i)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-handoff-reassign-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
    const agent = async (n: string) => { const id = (await c.services.agents.create(rob, { commandId: `ag-${n}`, friendlyName: n })).id; for (const action of ["attempt.work", "responsibility.read"]) await c.services.grants.grant(rob, { commandId: `g-${n}-${action}`, grantee: `agent:${id}`, action, project, source: "direct", basis: "test" } as never); return id; };
    const a = await agent("A"), b = await agent("B"), other = await agent("Other");
    const mkTask = async (n: string) => { const t = (await call("task.create", { projectId: project, title: n, description: n }, `t-${n}`)).result.id as string; await call("task.transition", { taskId: t, to: "ready", expectedRevision: 1 }, `tr-${n}`); assert.ok((await call("task.assign", { taskId: t, owner: { kind: "agent", id: a } }, `as-${n}`)).ok); return t; };
    const t1 = await mkTask("one"), t2 = await mkTask("two");
    const res = await c.services.resources.bindResource(rob, { commandId: "b1", projectId: project, kind: "repository", label: "plot", locator: "/r/plot" } as never);
    const mk = (n: string, ownerId: string, extra: Record<string, unknown> = {}) => c.services.responsibilities.create(rob, { commandId: `r-${n}`, projectId: project, title: `Duty ${n}`, objective: "o", desiredCondition: "tidy", ownerId, ...extra } as never);
    const r1 = await mk("1", `agent:${a}`, { managed: [res.id] }), r2 = await mk("2", `agent:${a}`), r3 = await mk("3", `agent:${other}`);
    const ownerOf = async (id: string) => (await c.services.responsibilities.get(rob, id))?.ownerId;

    // The package tells the owner how to move them.
    const prepared = await call("handoff.prepare", { taskId: t1, to: { kind: "agent", id: b }, reason: "leave" }, "h1");
    assert.ok(prepared.ok, JSON.stringify(prepared));
    const item = prepared.result.item;
    assert.match(item.package.sections.responsibilities, /reassignResponsibilities/);
    assert.match(item.package.sections.responsibilities, new RegExp(r1.id));

    // Refused before anything moves: someone else's responsibility, an unknown ID, a bad shape.
    for (const [ids, id] of [[[r1.id, r3.id], "c1"], [["rsp-aaaaaaaaaaaaaaaaaaaa"], "c2"]] as const) {
      const refused = await call("handoff.complete", { handoffId: item.id, acceptGaps: true, reassignResponsibilities: ids }, id);
      assert.equal(refused.error.code, "invalid_command", JSON.stringify(refused));
    }
    assert.equal((await call("handoff.complete", { handoffId: item.id, acceptGaps: true, reassignResponsibilities: "all" }, "c3")).error.code, "invalid_command");
    assert.equal((await call("handoff.get", { handoffId: item.id })).result.item.phase, "ready", "a refused request moved nothing");
    assert.equal(await ownerOf(r1.id), `agent:${a}`);

    // Chosen ones move with the task; the claim on the managed resource stays with the responsibility; the unchosen one stays.
    const done = await call("handoff.complete", { handoffId: item.id, acceptGaps: true, reassignResponsibilities: [r1.id] }, "c4");
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal(done.result.item.phase, "transferred");
    assert.deepEqual(done.result.item.reassigned.moved, [r1.id]);
    assert.deepEqual(done.result.item.reassigned.failed, []);
    assert.equal(await ownerOf(r1.id), `agent:${b}`);
    assert.equal(await ownerOf(r2.id), `agent:${a}`, "not chosen, so it stays with the sender");
    assert.equal(await ownerOf(r3.id), `agent:${other}`);
    assert.equal((await c.services.resources.heldClaim(res.id))?.responsibilityId, r1.id);

    // A hand-off that does not ask for it moves none; a temporary reassignment cannot carry them.
    const t2h = await call("handoff.prepare", { taskId: t2, to: { kind: "agent", id: b }, reason: "back soon", returnAt: new Date(Date.now() + 3_600_000).toISOString() }, "h2");
    assert.ok(t2h.ok, JSON.stringify(t2h));
    assert.equal((await call("handoff.complete", { handoffId: t2h.result.item.id, acceptGaps: true, reassignResponsibilities: [r2.id] }, "c5")).error.code, "invalid_command");
    assert.ok((await call("handoff.complete", { handoffId: t2h.result.item.id, acceptGaps: true }, "c6")).ok);
    assert.equal(await ownerOf(r2.id), `agent:${a}`);

    // Per-entry failure and a gone asker, through the mover itself.
    const mover = responsibilityHandover({ responsibilities: c.services.responsibilities, projectOf: async () => project });
    const r4 = await mk("4", `agent:${a}`);
    const partial = await mover.apply(rob, { handoffId: "hnd-x", ids: [r4.id, r3.id], from: { kind: "agent", id: a }, to: { kind: "agent", id: b } });
    assert.deepEqual(partial.moved, [r4.id]);
    assert.deepEqual(partial.failed.map((f) => f.id), [r3.id]);
    assert.match(partial.failed[0]!.reason, /no longer the sender/);
    const again = await mover.apply(rob, { handoffId: "hnd-x", ids: [r4.id], from: { kind: "agent", id: a }, to: { kind: "agent", id: b } });
    assert.deepEqual(again.moved, [r4.id], "repeating it is harmless");
    const gone = await mover.apply(undefined, { handoffId: "hnd-y", ids: [r2.id], from: { kind: "agent", id: a }, to: { kind: "agent", id: b } });
    assert.deepEqual(gone.moved, []);
    assert.match(gone.failed[0]!.reason, /gone or no longer active/);
    assert.equal(await ownerOf(r2.id), `agent:${a}`);
    // A storage error is not an answer for the entry: it is thrown so the step is repeated; a refusal of the update is a final answer for that entry only.
    const r6 = await mk("6", `agent:${a}`);
    const flaky = (error: Error) => responsibilityHandover({ responsibilities: { get: (by: never, id: string) => c.services.responsibilities.get(by, id), update: async () => { throw error; } } as never, projectOf: async () => project });
    await assert.rejects(flaky(new Error("SQLITE_BUSY")).apply(rob, { handoffId: "hnd-z", ids: [r6.id], from: { kind: "agent", id: a }, to: { kind: "agent", id: b } }), /SQLITE_BUSY/);
    const refusedUpdate = await flaky(new DomainError("invalid_command", "must be an active agent")).apply(rob, { handoffId: "hnd-z", ids: [r6.id], from: { kind: "agent", id: a }, to: { kind: "agent", id: b } });
    assert.deepEqual(refusedUpdate.failed, [{ id: r6.id, reason: "must be an active agent" }]);
    assert.equal(await ownerOf(r6.id), `agent:${a}`);
    // A recipient that is not an active agent is refused before anything moves.
    const picky = responsibilityHandover({ responsibilities: c.services.responsibilities, projectOf: async () => project, activeAgent: async () => false });
    await assert.rejects(picky.check(rob, { taskId: t1, ids: [r2.id], from: { kind: "agent", id: a }, to: { kind: "agent", id: b } }), /not an active agent/);
    // Without the right to assign, nothing is accepted.
    const nobody = { id: "agent:zzz", kind: "agent", name: "zzz", grants: [] } as never;
    await assert.rejects(mover.check(nobody, { taskId: t1, ids: [r2.id], from: { kind: "agent", id: a }, to: { kind: "agent", id: b } }), /may not assign/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("moving responsibilities with a hand-off: refused before anything moves without the assign and write rights, for another project's or a retired duty, for an inactive recipient; a recipient lacking rights is warned about to the owner; the activity sentence names what stayed (card L03i)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-handoff-reassign2-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const other = (await call(boot.token, "project.create", { name: "Shed" }, "p2")).result.id as string;
    const grant = async (who: string, action: string, proj = project) => { await c.services.grants.grant(rob, { commandId: `g-${who}-${action}-${proj}`, grantee: who.startsWith("agent:") ? who : `agent:${who}`, action, project: proj, source: "direct", basis: "test" } as never); };
    const agent = async (n: string, actions: string[]) => { const id = (await c.services.agents.create(rob, { commandId: `ag-${n}`, friendlyName: n })).id; for (const a of actions) await grant(id, a); return id; };
    const a = await agent("A", ["responsibility.read"]);
    const bare = await agent("Bare", ["attempt.work"]);
    const full = await agent("Full", ["attempt.work", "responsibility.read", "responsibility.write"]);
    const mkTask = async (n: string) => { const t = (await call(boot.token, "task.create", { projectId: project, title: n, description: n }, `t-${n}`)).result.id as string; await call(boot.token, "task.transition", { taskId: t, to: "ready", expectedRevision: 1 }, `tr-${n}`); assert.ok((await call(boot.token, "task.assign", { taskId: t, owner: { kind: "agent", id: a } }, `as-${n}`)).ok); return t; };
    const mk = (n: string, proj: string, ownerId: string) => c.services.responsibilities.create(rob, { commandId: `r-${n}`, projectId: proj, title: `Duty ${n}`, objective: "o", desiredCondition: "tidy", ownerId } as never);
    const ownerOf = async (id: string) => (await c.services.responsibilities.get(rob, id))?.ownerId;
    // A caller who may hand the task over but not assign responsibilities.
    await c.services.principals.enroll(rob, { commandId: "e-mgr", kind: "agent", name: "mgr", grants: [{ action: "assignment.manage", project }, { action: "assignment.read", project }, { action: "task.read", project }, { action: "responsibility.read", project }] });
    const mgr = (await c.services.principals.issueCredential(rob, "agent:mgr")).token;
    const t1 = await mkTask("one");
    const r1 = await mk("1", project, `agent:${a}`);
    const h1 = await call(mgr, "handoff.prepare", { taskId: t1, to: { kind: "agent", id: full }, reason: "leave" }, "h1");
    assert.ok(h1.ok, JSON.stringify(h1));
    const noAssign = await call(mgr, "handoff.complete", { handoffId: h1.result.item.id, acceptGaps: true, reassignResponsibilities: [r1.id] }, "c1");
    assert.equal(noAssign.error.code, "invalid_command", JSON.stringify(noAssign));
    assert.match(noAssign.error.message, /responsibility\.assign is missing/);
    await grant("mgr", "responsibility.assign");
    const noWrite = await call(mgr, "handoff.complete", { handoffId: h1.result.item.id, acceptGaps: true, reassignResponsibilities: [r1.id] }, "c2");
    assert.equal(noWrite.error.code, "invalid_command", JSON.stringify(noWrite));
    assert.match(noWrite.error.message, /responsibility\.write is missing/);
    assert.equal(await ownerOf(r1.id), `agent:${a}`);
    assert.equal((await call(boot.token, "handoff.get", { handoffId: h1.result.item.id })).result.item.phase, "ready", "nothing moved");
    // Without the list the caller still hands the task over; no duty moved.
    assert.ok((await call(mgr, "handoff.complete", { handoffId: h1.result.item.id, acceptGaps: true }, "c3")).ok);
    assert.equal(await ownerOf(r1.id), `agent:${a}`);

    // Another project's duty and a retired duty are refused, with the owner completing; the task did not move.
    const t2 = await mkTask("two");
    const foreign = await mk("2", other, `agent:${a}`);
    const retired = await mk("3", project, `agent:${a}`);
    assert.ok((await c.services.responsibilities.update(rob, { commandId: "ret", responsibilityId: retired.id, expectedRevision: retired.revision, state: "retired" } as never)).id);
    await grant(bare, "responsibility.read"); // bare keeps attempt.work + read; lacks write
    const h2 = await call(boot.token, "handoff.prepare", { taskId: t2, to: { kind: "agent", id: bare }, reason: "leave" }, "h2");
    assert.ok(h2.ok, JSON.stringify(h2));
    for (const [rid, label] of [[foreign.id, "another project"], [retired.id, "retired"]] as const) {
      const refused = await call(boot.token, "handoff.complete", { handoffId: h2.result.item.id, acceptGaps: true, reassignResponsibilities: [rid] }, `c-${label}`);
      assert.equal(refused.error.code, "invalid_command", `${label}: ${JSON.stringify(refused)}`);
    }
    assert.equal((await call(boot.token, "handoff.get", { handoffId: h2.result.item.id })).result.item.phase, "ready");

    // A recipient that cannot fully hold the duty gets it at once and the owner is warned, naming what is missing; the warning is raised once.
    const r4 = await mk("4", project, `agent:${a}`);
    const done = await call(boot.token, "handoff.complete", { handoffId: h2.result.item.id, acceptGaps: true, reassignResponsibilities: [r4.id] }, "c-ok");
    assert.ok(done.ok, JSON.stringify(done));
    assert.deepEqual(done.result.item.reassigned.moved, [r4.id]);
    assert.equal(await ownerOf(r4.id), `agent:${bare}`, "moved at once, not held back by the missing right");
    const warnings = (await NotificationService.withEpoch(c.storage, c.epoch, {}).inbox(rob)).items.filter((i: any) => /after a hand-off but lacks/.test(String((i as any).detail ?? JSON.stringify(i))));
    assert.equal(warnings.length, 1);
    assert.match(JSON.stringify(warnings[0]), /responsibility\.write/);
    assert.ok(!/responsibility\.read, /.test(JSON.stringify(warnings[0])), "only what is missing is named");
    // A recipient with every right is not warned about.
    const t3 = await mkTask("three");
    const r5 = await mk("5", project, `agent:${a}`);
    await grant(full, "attempt.work");
    const h3 = await call(boot.token, "handoff.prepare", { taskId: t3, to: { kind: "agent", id: full }, reason: "leave" }, "h3");
    assert.ok((await call(boot.token, "handoff.complete", { handoffId: h3.result.item.id, acceptGaps: true, reassignResponsibilities: [r5.id] }, "c-ok2")).ok);
    assert.equal((await NotificationService.withEpoch(c.storage, c.epoch, {}).inbox(rob)).items.filter((i: any) => /after a hand-off but lacks/.test(JSON.stringify(i))).length, 1);

    // The sentence for the task's record says what stayed with the sender and why.
    const note = describeReassigned({ moved: ["rsp-a"], failed: [{ id: "rsp-b", reason: "retired meanwhile" }] });
    assert.match(note, /moved with it: 1\./);
    assert.match(note, /1 stayed with the sender: rsp-b \(retired meanwhile\)/);
    assert.equal(describeReassigned(undefined), "");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

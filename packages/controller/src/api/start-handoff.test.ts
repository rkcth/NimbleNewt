import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { WorkerHost } from "../dispatch/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
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
    assert.equal(sections.locks, undefined, "nothing keeps locks yet, so none is claimed");
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
    assert.equal(full["locks"], `resource claims: 1 managed entry of the sender's responsibilities could not be checked and is missing from this section\nresource ${res.id}: claimed by responsibility ${duty.id}; the claim stays with ${duty.id} until it is reassigned`);
    // Gap versus none: a sender who cannot read responsibilities is reported as unknown; one who can and holds nothing leaves the section empty.
    assert.match((await sections(t3, sees, "h3"))["locks"] ?? "", /not known; the sender may not read/);
    assert.equal((await sections(t4, sees, "h4"))["locks"], undefined);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, EXEC_PROFILES, ROUTING_TABLE, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { NOTE_ARCHIVE_READ } from "../context/index.js";
import { startController, type Controller } from "./index.js";

// Card C07p through the composed controller: an attempt ends without a hand-off, the controller writes one from the facts it is given, and the note is too long to keep whole. What the next agent is handed keeps
// its newest entries and names where the rest of itself is kept — and that pointer is one the agent can actually follow: the whole text answers through `context.note-archive.read`, to whoever may work on the
// task and to no one else.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
/** Enough effects that the hand-off note cannot be kept whole in the 4 000 characters an attempt's hand-off may take. */
const EFFECTS = Array.from({ length: 200 }, (_, i) => ({ id: `eff-${String(i).padStart(3, "0")}`, state: "confirmed" as const, summary: `watered bed ${i} twice` }));

test("the hand-off note an ended attempt leaves behind is cut to fit, and the whole text it names reads back through the API (card C07p)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-notearch-"));
  const worker = new ScriptedWorker("host:w1", async () => ({ status: "completed", text: "half the beds, then the worker died" }));
  const c: Controller = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true, workers: [worker],
      // The facts producer a host with a ledger reader would give: every effect the attempt recorded, oldest first.
      handoffFacts: async () => ({ task: "Water the beds", effects: EFFECTS, artifacts: [{ id: "art-001", title: "the bed plan" }], lastKnownState: "beds 1-3 watered" }),
    },
  } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const callAs = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, profiles: { "r-local": ["localp/small", "cloudp/big"] }, roles: { coordinator: "r-local", "safety-supervisor": "r-local" } } } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const annId = (await s.agents.create(owner, { commandId: "ag-a", friendlyName: "ann" })).id;
    const bobId = (await s.agents.create(owner, { commandId: "ag-b", friendlyName: "bob" })).id;
    for (const who of [annId, bobId]) for (const g of workGrants(project)) await s.grants.grant(owner, { commandId: `g-${who}-${g.action}`, grantee: `agent:${who}`, action: g.action, project, source: "direct", basis: "test" });
    const bob = (await s.principals.issueCredential(owner, `agent:${bobId}`)).token;
    // Someone who may look at the task but not work on it.
    await s.principals.enroll(owner, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
    const zed = (await s.principals.issueCredential(owner, "agent:zed")).token;

    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Water the beds", description: "Soak the north bed twice a week." })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: annId } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const first = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: annId }, harness: "pi" })).id;
    await c.dispatch!.dispatcher.tick();
    assert.ok(worker.handles.some((h) => h.order.attemptId === first), "the attempt was started");
    // The worker returns, which ends the attempt: that is when the controller writes the hand-off the attempt never left.
    for (let i = 0; i < 5; i++) await c.dispatch!.dispatcher.tick();
    assert.notEqual((await s.assignments.getAssignment(taskId))!.activeAttemptId, first, "the attempt ended");

    // The note the next attempt is pointed at, as it is kept.
    const notes = (await c.storage.listAggregates("ctx-handoff", { limit: 50 })).map((r) => r.body as unknown as { taskId: string; source: string; text: string });
    const note = notes.find((n) => n.source === "controller" && n.taskId === taskId);
    assert.ok(note !== undefined, `the controller wrote no hand-off note for the attempt: ${JSON.stringify(notes)}`);
    assert.ok(note.text.length <= 4_000, `the note is ${note.text.length} characters`);
    const marker = note.text.split("\n").at(-1)!;
    assert.match(marker, /older lines of this note left out \(\d+ characters\)/, marker);
    assert.ok(marker.includes(NOTE_ARCHIVE_READ), `the marker names no read: ${marker}`);
    const digest = /sha256:[0-9a-f]{64}/.exec(marker)![0];
    assert.ok(!note.text.includes("eff-000 ") && note.text.includes("eff-199"), "the newest effect is the one the cut took");

    // The pointer holds: the whole text comes back, oldest entries and all, to the agent that works on the task and to the owner.
    for (const who of [{ at: boot.token, who: "the owner" }, { at: bob, who: "an agent of the project" }]) {
      const read = await callAs(who.at, "context.note-archive.read", { taskId, digest });
      assert.equal(read.ok, true, `${who.who} could not read the whole note: ${JSON.stringify(read)}`);
      assert.deepEqual([read.result.item.taskId, read.result.item.attemptId, read.result.item.digest], [taskId, first, digest]);
      assert.equal(read.result.item.what, `the controller's hand-off note for attempt ${first}`);
      assert.match(read.result.item.text, /- effect eff-000 \[confirmed\] "watered bed 0 twice"/, "the whole text leaves the oldest effect out");
      assert.match(read.result.item.text, /- artifact art-001 "the bed plan"/);
      assert.ok(read.result.item.text.length > note.text.length, "the archived text is shorter than the note it completes");
    }
    // An agent that may look at the task but not work on it reads it as nothing, and so does another task's digest.
    assert.equal((await callAs(zed, "context.note-archive.read", { taskId, digest })).error.code, "not_found", "an agent that may not work on the task reads nothing");
    assert.equal((await callAs(bob, "context.note-archive.read", { taskId, digest: `sha256:${"0".repeat(64)}` })).error.code, "not_found");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});

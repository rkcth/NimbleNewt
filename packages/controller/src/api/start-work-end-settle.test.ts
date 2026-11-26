import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { AdmissionService } from "../admission/service.js";
import { BlockerService } from "../domain/blockers.js";
import { ModelInterpreter } from "../chat/model-interpreter.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, workGrants } from "../dispatch/testing/world.js";
import { PolicyService } from "../policy/index.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { FULL_ABILITIES } from "../remote/testing/suite.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type StartOptions } from "./index.js";

// Card H12n, slice 1 "Remains" item 5: the ending's settle through the REAL dispatcher binding (`dispatcherEndingPorts.settle`), with a tool call in flight. The remote host begins a call and never reports it (its
// worker was killed with the call running), the agent asks `work.end { submit: true }`, and the dispatcher's tick completes the ending: the settle cuts the call from the ledger, and whether it counts as a write comes
// from the controller's own tool catalogue (`read-file`, `grep`: inspect; `write-file`: workspace-edit), never from the test. The owner then asks the chat in free words what holds the task up.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const B = "a".repeat(40);
const TOOLS = ["read-file", "grep", "write-file"];
// A routing table on which the attempts' route stays eligible, so the calls are judged and begun (the neighbour W08 test's table).
const TABLE = {
  providers: { localp: { enabled: true, paid: false, location: "local" }, localq: { enabled: true, paid: false, location: "local" } },
  routes: { "localp/small": { contextTokens: 128_000, capabilities: ["tools"] }, "localp/other": { contextTokens: 128_000, capabilities: ["tools"] }, "localq/judge": { contextTokens: 128_000, capabilities: ["tools"] }, "localq/backup": { contextTokens: 128_000, capabilities: ["tools"] } },
  profiles: { "r-local": ["localp/small", "localq/backup"], judge: ["localq/judge", "localp/other"] }, roles: { coordinator: "r-local", "safety-supervisor": "judge" },
};

let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; blobs: string; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-wes-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, blobs: join(d, "blobs"), close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const d = mkdtempSync(join(tmpdir(), "nn-wes-"));
    const schema = `wes_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, blobs: join(d, "blobs"), close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
  } }]),
];

/** A stand-in for the chat's model: it finds the status view by what the prompt says the view answers (not by its name) and copies the task's title from the owner's own words. */
function fakeModel(seen: { system: string }[]) {
  return {
    complete: async (_route: string, request: { system: string; user: string }): Promise<string> => {
      seen.push(request);
      const kinds = /request\.kind is one of \(with its keys; `a\|b` means either\): (.*)$/m.exec(request.system)?.[1] ?? "";
      const kind = kinds.split("; ").find((k) => / - how one task is going and what blocks it$/.test(k))?.split("(")[0];
      const words = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(request.user)?.[1] ?? "";
      const title = /Order seeds \d/.exec(words)?.[0];
      if (kind === undefined || title === undefined) return JSON.stringify([{ kind: "none", reason: "no view fits" }]);
      return JSON.stringify([{ kind: "status", request: { kind, taskTitle: title }, evidence: title, basis: "owner" }]);
    },
  };
}

async function world(store: Store) {
  const db = await store.open();
  const staged: string[] = [];
  const seen: { system: string }[] = [];
  const c = await startController({
    storage: db.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    landing: async () => ({ base: B, head: B, mine: ["beds.txt"], landed: [] }),
    stage: async (a: { attemptId: string }) => { staged.push(a.attemptId); return { base: B, tree: "b".repeat(40), patchId: "c".repeat(40), files: ["beds.txt"] }; },
    chat: { interpreter: new ModelInterpreter(fakeModel(seen), () => ["localp/chat"]) },
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { workspaceAdmission: async () => [], blobDirectory: db.blobs, hosts: [{ hostId: "host:pc", window: () => 131_072, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 256 }, requirements: () => ({ data: "cloud-allowed" as const, harness: "pi" }) }] },
    },
  } as never);
  assert.ok(c.dispatch !== undefined, c.dispatchProblem);
  const s = c.services;
  const boot = await s.principals.bootstrapOwner({ name: "rob" });
  const owner = await s.principals.authenticate(boot.token);
  await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: TABLE } as never);
  // The calls run without asking the owner, so each begins at once and stays in flight.
  await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
  const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
  await s.principals.enroll(owner, { commandId: "e-pc", kind: "host", name: "pc", grants: [] });
  const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl!, token: (await s.principals.issueCredential(owner, "host:pc")).token, workerVersion: "worker-9.1.0" });
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-pc", actor: owner.id, host: "host:pc", capacity: { cpus: 32, memoryMb: 65_536 } });
  await client.connect({ ...CAPS } as never);
  await client.heartbeat(1);
  const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
  /** An author agent's attempt on its own task, started on the host and accepted there, so its calls can begin. */
  const attempt = async (n: number) => {
    const agent = ((await s.agents.create(owner, { commandId: `mk-${n}`, friendlyName: `Ann${n}`, roles: ["author"] })) as { id: string }).id;
    for (const g of workGrants(project, TOOLS)) await s.grants.grant(owner, { commandId: `g-${n}-${g.action}`, grantee: `agent:${agent}`, action: g.action, project, source: "direct", basis: "test" } as never);
    const token = (await s.principals.issueCredential(owner, `agent:${agent}`)).token;
    const task = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `Order seeds ${n}` })).id;
    await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
    const a = (await s.assignments.getAssignment(task))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
    await c.dispatch!.dispatcher.tick();
    const offer = (await client.offers()).find((o) => o.order.attemptId === attemptId);
    assert.ok(offer !== undefined, "the host was offered the attempt");
    const att = client.attempt(attemptId, offer.placement);
    await att.accept();
    const honored = await att.honorContract(offer.order, FULL_ABILITIES);
    assert.ok(honored.ok, JSON.stringify(honored));
    return { attempt: attemptId, task, token, agent, att };
  };
  const ops = async (attemptId: string) => (await c.dispatch!.dispatcher.operations(c.dispatch!.principal, attemptId)) ?? [];
  const opOf = async (attemptId: string, callId: string) => (await ops(attemptId)).find((o) => o.callId === callId);
  const ask = async (messageId: string, text: string): Promise<string[]> => {
    const out = (await c.chat!.submit(boot.token, { messageId, text })).outcomes[0] as { status: string; lines?: readonly { text: string }[] };
    assert.equal(out.status, "answered", JSON.stringify(out));
    return (out.lines ?? []).map((l) => l.text);
  };
  return { c, db, boot, owner, project, call, attempt, opOf, ask, staged, seen, close: async () => { await c.close(); await db.close(); } };
}

for (const store of stores) {
  test(`${store.name}: a write call in flight when the ending settles is cut as uncertain by the real dispatcher; the submit becomes a plain end with a typed release_failed blocker, nothing is staged or submitted, and the owner reads why in free words (card H12n)`, async () => {
    const w = await world(store);
    try {
      await w.c.chat!.setFocus(w.boot.token, { commandId: "f1", projectId: w.project });
      const one = await w.attempt(1);
      // The host begins a write and its worker dies before it can report: the call stays in flight on the controller.
      const began = await one.att.begin({ callId: "w1", tool: { name: "write-file", version: "1.0.0" }, args: { path: "beds.txt" } });
      assert.equal(began.run, true, JSON.stringify(began));
      const before = await w.opOf(one.attempt, "w1");
      assert.deepEqual([before?.state, before?.readOnly], ["in-progress", false], "the catalogue classes write-file as an edit, so the call is not read-only");

      const asked = await w.call(one.token, "work.end", { report: "beds planted", attemptId: one.attempt, submit: true, result: "done" }, "s1");
      assert.ok(asked.ok, JSON.stringify(asked));
      const tick = await w.c.dispatch!.dispatcher.tick();
      assert.ok(tick.loops.some((l) => l.name === "workend.complete" && l.ok), JSON.stringify(tick.loops.filter((l) => !l.ok)));

      const cut = await w.opOf(one.attempt, "w1");
      assert.deepEqual([cut?.state, cut?.readOnly], ["uncertain", false], "a write nobody reported may have done its work");
      const rec = await w.c.services.workEnd.get(one.attempt);
      assert.deepEqual([rec?.state, rec?.outcome, rec?.typed, rec?.submissionId], ["done", "ended", "release_failed", undefined], JSON.stringify(rec));
      assert.match(rec?.summary ?? "", /^release_failed: 1 write call\(s\) had to be killed \(w1: its outcome is not known\); the work was not submitted/);
      assert.ok(rec?.blocker !== undefined, "the ending names its blocker");
      assert.deepEqual(w.staged, [], "nothing was staged");
      const listed = await w.call(w.boot.token, "submission.list", { taskId: one.task });
      assert.deepEqual(listed.result?.items, [], `no submission was recorded: ${JSON.stringify(listed)}`);
      const blocker = await BlockerService.withEpoch(w.c.storage, w.c.epoch).openFor("runtime_hold", { kind: "task", id: one.task });
      assert.ok(blocker !== undefined, "the owner has an open blocker on the task");
      assert.equal(blocker.id, rec!.blocker);
      assert.match(blocker.summary, /^release_failed: 1 write call\(s\) had to be killed/);
      const ended = (await w.c.dispatch!.dispatcher.get(w.c.dispatch!.principal, one.attempt))!;
      assert.equal(ended.state, "finished");
      // A plain end with the agent's own result (the card: "turns submit into end"): done ends the attempt succeeded, as any plain done does; what holds the work is the open blocker, and nothing was submitted.
      assert.equal(ended.outcome?.status, "succeeded");

      // The owner asks in free words; the stand-in model finds the view by its description in the prompt; the answer quotes the blocker.
      const why = await w.ask("m1", "what is holding up Order seeds 1? did it get submitted?");
      assert.match(w.seen[0]!.system, /task\(taskId\|taskTitle\) - how one task is going and what blocks it/);
      const text = why.join("\n");
      assert.match(text, /^Order seeds 1 is /);
      assert.match(text, /It is held up by a technical problem: release_failed: 1 write call\(s\) had to be killed \(w1: its outcome is not known\); the work was not submitted/);
      assert.deepEqual(await w.ask("m2", "Order seeds 1 - why is it stuck"), why, "other words, the same answer");
      // The state API (the browser's source) gives the same lines.
      const viewed = await w.call(w.boot.token, "status.ask", { request: { kind: "task", taskId: one.task } });
      assert.ok(viewed.ok, JSON.stringify(viewed));
      assert.deepEqual(viewed.result.item.lines.map((l: { text: string }) => l.text), why);
    } finally { await w.close(); }
  });

  test(`${store.name}: read-only calls in flight (classed inspect by the catalogue) are cut as cancelled and do not stop the submit; a write that ended before the ending, or was already uncertain, is not this ending's to count (card H12n)`, async () => {
    const w = await world(store);
    try {
      const two = await w.attempt(2);
      // Earlier in the attempt: a write the host reported as done, and one whose outcome it did not know. Neither is in flight when the ending begins.
      const w0 = await two.att.begin({ callId: "w0", tool: { name: "write-file", version: "1.0.0" }, args: { path: "beds.txt" } });
      assert.equal(w0.run, true);
      await two.att.report(w0.operationId, { state: "confirmed", text: "written" });
      const w9 = await two.att.begin({ callId: "w9", tool: { name: "write-file", version: "1.0.0" }, args: { path: "rows.txt" } });
      assert.equal(w9.run, true);
      await two.att.report(w9.operationId, { state: "uncertain", error: "the disk went away" });
      // In flight when the agent ends: two reads.
      for (const [callId, name] of [["r1", "read-file"], ["r2", "grep"]] as const) {
        const b = await two.att.begin({ callId, tool: { name, version: "1.0.0" }, args: { path: "beds.txt" } });
        assert.equal(b.run, true, JSON.stringify(b));
        const op = await w.opOf(two.attempt, callId);
        assert.deepEqual([op?.state, op?.readOnly], ["in-progress", true], `${name} is classed inspect by the catalogue`);
      }

      assert.ok((await w.call(two.token, "work.end", { report: "beds planted", attemptId: two.attempt, submit: true, result: "done" }, "s2")).ok);
      const tick = await w.c.dispatch!.dispatcher.tick();
      assert.ok(tick.loops.some((l) => l.name === "workend.complete" && l.ok), JSON.stringify(tick.loops.filter((l) => !l.ok)));

      for (const callId of ["r1", "r2"]) assert.equal((await w.opOf(two.attempt, callId))?.state, "cancelled", `${callId} only read, so it was cut as cancelled`);
      assert.deepEqual([(await w.opOf(two.attempt, "w0"))?.state, (await w.opOf(two.attempt, "w9"))?.state], ["confirmed", "uncertain"]);
      const rec = await w.c.services.workEnd.get(two.attempt);
      assert.deepEqual([rec?.state, rec?.outcome, rec?.typed, rec?.blocker], ["done", "submitted", undefined, undefined], JSON.stringify(rec));
      assert.equal(rec?.steps?.settled?.killedWrites, undefined, "no write was cut by this ending");
      assert.deepEqual(w.staged, [two.attempt], "staged once");
      const sub = await w.call(two.token, "submission.get", { submissionId: rec!.submissionId });
      assert.deepEqual([sub.result.item.kind, sub.result.item.taskId, sub.result.item.attemptId, sub.result.item.tree], ["code", two.task, two.attempt, "b".repeat(40)]);
      assert.equal(await BlockerService.withEpoch(w.c.storage, w.c.epoch).openFor("runtime_hold", { kind: "task", id: two.task }), undefined, "no blocker");
    } finally { await w.close(); }
  });
}

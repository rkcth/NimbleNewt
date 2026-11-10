import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ChatSpendService, ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, EXEC_PROFILES, workGrants } from "../dispatch/testing/world.js";
import type { WorkOrder, WorkerTurnResult } from "../dispatch/ports.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type Controller, type StartOptions } from "./index.js";

// Card W10 through the composed controller: an agent keeps running notes through the state API with its task credential, an ending without a report is refused with them, a done is questioned by a second agent on the
// routed, metered client (its routes from the routing table's safety-supervisor list, its tokens under the daily cap on the controller's own calls), and the owner reads the report through the state API and by chat in their
// own words. At the cap no call is made and the report says the done was not questioned.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const TABLE = {
  providers: { localp: { enabled: true, paid: false, location: "local" }, localq: { enabled: true, paid: false, location: "local" } },
  routes: { "localp/small": { contextTokens: 128_000, capabilities: ["tools"] }, "localp/other": { contextTokens: 128_000, capabilities: ["tools"] }, "localq/judge": { contextTokens: 128_000, capabilities: ["tools"] }, "localq/backup": { contextTokens: 128_000, capabilities: ["tools"] } },
  profiles: { "r-local": ["localp/small", "localq/backup"], judge: ["localq/judge", "localp/other"] }, roles: { coordinator: "r-local", "safety-supervisor": "judge" },
};

let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-report-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `report_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

for (const store of stores) {
  test(`${store.name}: notes, a refused end without a report, a done questioned by a second agent on the routed and metered client, and the report read by the owner through the state API and by chat; at the daily cap no call is made (card W10)`, async () => {
    const db = await store.open();
    const asked: { route: string; system: string; user: string }[] = [];
    const replies = [JSON.stringify({ verdict: "questions", questions: ["Which beds were watered, and how do you know?"] }), JSON.stringify({ verdict: "supported" })];
    const model = {
      complete: async (): Promise<string> => { throw new Error("the routed client asks for the detailed reply"); },
      completeDetailed: async (route: string, request: { system: string; user: string }) => { asked.push({ route, ...request }); return { text: replies[Math.min(asked.length - 1, replies.length - 1)]!, usage: { inputTokens: 40, outputTokens: 10 } }; },
    };
    let script: (order: WorkOrder) => Promise<WorkerTurnResult> = async () => ({ status: "completed", text: "done", endKind: "normal" });
    const worker = new ScriptedWorker("host:w1", async ({ order }) => script(order));
    const say: Record<string, unknown[]> = {};
    const c: Controller = await startController({
      storage: db.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
      dispatch: { timer: new ManualTimer(), manual: true, workers: [worker] },
      reportInterrogation: { model },
      chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    } as never);
    try {
      const s = c.services;
      const boot = await s.principals.bootstrapOwner({ name: "rob" });
      const owner = await s.principals.authenticate(boot.token);
      await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: TABLE } as never);
      await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
      await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
      const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
      const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
      await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
      let beat = 0;
      const heartbeat = async (): Promise<void> => { await hosts.heartbeat(hostP, { commandId: `hb${++beat}`, sequence: beat }); };
      await heartbeat();
      await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
      await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
      const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
      const annId = (await s.agents.create(owner, { commandId: "ag-a", friendlyName: "ann" })).id;
      for (const g of workGrants(project)) await s.grants.grant(owner, { commandId: `g-${g.action}`, grantee: `agent:${annId}`, action: g.action, project, source: "direct", basis: "test" });
      const newTask = async (n: number, title: string): Promise<{ taskId: string; attemptId: string }> => {
        const taskId = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title })).id;
        await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
        await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId, owner: { kind: "agent", id: annId } });
        const a = (await s.assignments.getAssignment(taskId))!;
        return { taskId, attemptId: (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: annId }, harness: "pi" })).id };
      };
      const api = async (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<any> => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
      const state = async (id: string) => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, id))!;
      const spend = ChatSpendService.withEpoch(c.storage, c.epoch);

      // A non-coding task: the agent notes as it goes, tries to end without a report, writes one, is questioned, answers and ends.
      const one = await newTask(1, "Water the beds");
      const seen: Record<string, any> = {};
      script = async (order) => {
        const t = order.credential;
        const a = order.attemptId;
        seen["note"] = await api(t, "work.note", { attemptId: a, kind: "did", text: "watered the north bed" }, "n1");
        seen["note2"] = await api(t, "work.note", { attemptId: a, kind: "left", text: "the south bed is dry" }, "n2");
        seen["bare"] = await api(t, "work.end", { attemptId: a, result: "done" }, "e0");
        seen["asked"] = await api(t, "work.end", { attemptId: a, result: "done", report: "Watered both beds." }, "e1");
        seen["answer"] = await api(t, "work.answer", { attemptId: a, answers: ["North and south; the soil is wet to 5 cm in both."] }, "a1");
        seen["end"] = await api(t, "work.end", { attemptId: a, result: "done", report: "Watered both beds; the soil is wet to 5 cm in both." }, "e2");
        return { status: "completed", text: "Ended.", endKind: "normal" };
      };
      for (let i = 0; i < 4 && (await c.dispatch!.dispatcher.get(c.dispatch!.principal, one.attemptId))?.state !== "finished"; i++) { await heartbeat(); await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle(); }
      assert.ok(seen["note"].ok, JSON.stringify(seen["note"]));
      assert.equal(seen["bare"].ok, false);
      assert.match(seen["bare"].error.message, /^work\.end needs a report: /);
      assert.match(seen["bare"].error.message, /- did: "watered the north bed"\n- left to do: "the south bed is dry"/, "the agent is shown its notes");
      assert.equal(seen["asked"].ok, false);
      assert.match(seen["asked"].error.message, /a second agent questions your report[\s\S]*\n1\. "Which beds were watered, and how do you know\?"/);
      assert.ok(seen["answer"].ok, JSON.stringify(seen["answer"]));
      assert.ok(seen["end"].ok, JSON.stringify(seen["end"]));
      const d = await state(one.attemptId);
      assert.equal(d.outcome?.status, "succeeded");
      // The second agent: on the safety supervisor's route from the routing table, with no tools and no conversation (a system and a user text), shown the notes and the report, and metered.
      assert.deepEqual(asked.map((x) => x.route), ["localq/judge", "localq/judge"]);
      assert.match(asked[0]!.system, /You cannot approve or accept the work/);
      assert.match(asked[0]!.user, /REPORT "Watered both beds\."/);
      assert.match(asked[0]!.user, /- left: "the south bed is dry"/);
      assert.match(asked[1]!.user, /A1 "North and south; the soil is wet to 5 cm in both\."/);
      assert.equal(await spend.used(), 100, "both calls are counted against the daily cap");

      // The owner reads the report through the state API and by chat in their own words.
      const viewed = await api(boot.token, "status.ask", { request: { kind: "work_report", taskId: one.taskId } });
      assert.ok(viewed.ok, JSON.stringify(viewed));
      const text = (viewed.result.item.lines as { text: string }[]).map((l) => l.text).join("\n");
      assert.match(text, new RegExp(`Attempt ${one.attemptId} of agent:${annId} ended done at [^;]+; a second agent questioned it and found it supported`));
      assert.match(text, /Report \(quoted\): "Watered both beds; the soil is wet to 5 cm in both\."/);
      assert.match(text, /Running notes \(2, quoted\):\n- did: "watered the north bed"\n- left to do: "the south bed is dry"/);
      assert.match(text, /1\. Q "Which beds were watered, and how do you know\?" A "North and south; the soil is wet to 5 cm in both\."/);
      await c.chat!.setFocus(boot.token, { commandId: "f1", projectId: project });
      const words = "what did ann say about watering when it finished?";
      say[words] = [{ kind: "status", request: { kind: "work_report", taskTitle: "Water the beds" }, evidence: words, basis: "owner" }];
      const chat = (await c.chat!.submit(boot.token, { messageId: "m1", text: words })).outcomes[0] as { status: string; lines?: readonly { text: string }[] };
      const chatText = (chat.lines ?? []).map((l) => l.text).join("\n");
      assert.match(chatText, /found it supported/, JSON.stringify(chat));
      assert.match(chatText, /Report \(quoted\): "Watered both beds; the soil is wet to 5 cm in both\."/);
      // Another agent cannot read it.
      await s.principals.enroll(owner, { commandId: "e-bob", kind: "agent", name: "bob", grants: [{ action: "task.read", project }] });
      const bob = (await s.principals.issueCredential(owner, "agent:bob")).token;
      const hidden = await api(bob, "status.ask", { request: { kind: "work_report", taskId: one.taskId } });
      assert.ok(!JSON.stringify(hidden).includes("Watered both beds"), JSON.stringify(hidden));

      // At the owner's daily cap no call is made: the done is taken on the controller's checks and the report says it was not questioned, and why.
      await spend.setBudget(owner, { commandId: "cap-day", maxTokensPerDay: 100 });
      const two = await newTask(2, "Order seeds");
      script = async (order) => { seen["capped"] = await api(order.credential, "work.end", { attemptId: order.attemptId, result: "done", report: "Ordered the seeds." }, "e3"); return { status: "completed", text: "Ended.", endKind: "normal" }; };
      for (let i = 0; i < 4 && (await c.dispatch!.dispatcher.get(c.dispatch!.principal, two.attemptId))?.state !== "finished"; i++) { await heartbeat(); await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle(); }
      assert.ok(seen["capped"].ok, JSON.stringify(seen["capped"]));
      assert.equal(asked.length, 2, "no model call past the cap");
      const capped = await state(two.attemptId);
      assert.equal(capped.outcome?.status, "succeeded");
      const report = (capped as unknown as { report?: { questioning: string; why?: string } }).report;
      assert.equal(report?.questioning, "not-run");
      assert.match(report?.why ?? "", /could not be asked: .*budget: the chat's token budget for today \(100\) is used/);
    } finally { await c.close(); await db.close(); }
  });
}

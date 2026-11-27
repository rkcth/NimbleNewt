import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import type { ToolGateway, WorkOrder } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import { stopServer } from "../domain/testing/backends.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startTestServer, type TestServer } from "../storage/postgres/testing/server.js";
import type { DispatchStartOptions } from "./dispatch-compose.js";
import { startController, type Controller } from "./index.js";

after(stopServer);

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const ASSETS = { "/": { type: "text/html; charset=utf-8", body: "<!doctype html><title>t</title>" }, "/app.js": { type: "text/javascript", body: "1" } };
const local = { enabled: true, paid: false, location: "local" as const };
const route = { contextTokens: 100_000, capabilities: ["tools"] };
// Two local engines on two endpoints; every model-using role has a list over them, so a cutover of the first sends the replacement to the second.
const TABLE = {
  providers: { strata: local, gpu2: local },
  routes: { "strata/qwen": route, "gpu2/qwen": route },
  profiles: { main: ["strata/qwen", "gpu2/qwen"] },
  roles: { coordinator: "main", "safety-supervisor": "main" },
};
const TOPOLOGY = { services: [], targets: { "strata/qwen": { endpoint: "strata-http", account: "local" }, "gpu2/qwen": { endpoint: "gpu2-http", account: "local" } }, aliases: {} };
const PROFILES = { profiles: { default: { harness: "pi", routingProfile: "main" } }, mapping: { unrated: "default" } };
const ANN = "agt-annannannannannannan";
type Storage = "sqlite" | { pg: TestServer };
type Reply = { status: number; body: any; text: string; headers: Record<string, string | string[] | undefined> };
type Step = { seq: number; kind: string; actor: string; summary: string; outcome: string; outcomeNote?: string; lane: string; laneStatus: string; authority: string; supersededBy?: number[] };
type BuildServices = Parameters<NonNullable<DispatchStartOptions["local"]>["build"]>[0];

// Card U09b: the card's own validation scenario through the RUNNING controller, with every step written by its real producer and none by hand: the owner's instruction (the messages service), a
// failed tool call (the dispatcher's gateway), a compressed history (the attempt's process compaction), a task branch (the branch registry), a provider switch (an owner cutover of the route the
// attempt runs on; the dispatcher starts the replacement on the next open route and says so), the agent's answer (the messages service again) and a later owner correction from free words in chat.
// The replay of it through the state API and the web routes is read with zero effects: no operation, no delivery, no effect and no model call.
async function story(storage: Storage): Promise<void> {
  const d = mkdtempSync(join(tmpdir(), "nn-rprod-"));
  const choice = storage === "sqlite" ? { kind: "sqlite" as const, path: join(d, "c.sqlite") } : { kind: "postgres" as const, url: storage.pg.url(), schema: `u9b_${process.pid}_${Math.random().toString(36).slice(2, 8)}` };
  const say: { [text: string]: unknown[] } = {};
  const interpreter = new ScriptedInterpreter((input) => say[input.text] ?? []);
  const modelCalls: string[] = [];
  const countingModel = { complete: async (r: string): Promise<string> => { modelCalls.push(`complete:${r}`); throw new Error("no model is reachable in this test"); }, completeDetailed: async (r: string): Promise<never> => { modelCalls.push(`detailed:${r}`); throw new Error("no model is reachable in this test"); } };
  let services: BuildServices | undefined;
  let script: (ctx: { order: WorkOrder; gateway: ToolGateway; worker: { stopped: number } }) => Promise<{ status: string; text: string }> = async () => ({ status: "completed", text: "done" });
  const worker = new ScriptedWorker("host:w1", (ctx) => script(ctx as never) as never);
  const c: Controller = await startController({
    storage: choice, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    resumeReview: { model: countingModel, routes: ["stand-in-a"] }, reportInterrogation: { model: countingModel, routes: ["stand-in-b"] },
    chat: { interpreter, coordinator: { model: { respond: async (r: string) => { modelCalls.push(`coordinator:${r}`); throw new Error("no model is reachable in this test"); } }, token: async () => undefined, routes: () => ["stand-in-c"] } },
    webChat: { host: "127.0.0.1", network: "loopback", assets: ASSETS },
    dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 32768, acceptUnenforcedLimits: true, build: (s: BuildServices) => { services = s; return worker; } } },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: { [k: string]: unknown }, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: TABLE } as never);
    await s.cutover.setTopology(owner, { commandId: "topo", expectedRevision: 0, topology: TOPOLOGY } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: ANN, grants: [...workGrants(project, ["write-file"]), { action: "message.send", project }, { action: "message.read", project }, { action: "history.read", project }, { action: "history.append", project }] });
    const ann = (await s.principals.issueCredential(owner, `agent:${ANN}`)).token;
    const task = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "fix the login bug" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId: task, owner: { kind: "agent", id: ANN } });
    const a = (await s.assignments.getAssignment(task))!;
    const first = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ANN }, harness: "pi" })).id;

    // ---- the producers, each the real one ----
    // The owner's instruction is a message to the agent (the messages service writes the step).
    const told = await call(boot.token, "message.send", { taskId: task, to: `agent:${ANN}`, class: "advice", purpose: "fix it the old way", text: "use the old login form" }, "msg-1");
    assert.ok(told.ok, JSON.stringify(told));
    // The first attempt runs on the first route of the list. Its process makes a tool call that fails, compacts its history and opens a side line, then works until the owner cuts the route over.
    let ready!: () => void;
    const working = new Promise<void>((resolve) => { ready = resolve; });
    const failures: unknown[] = [];
    let lane = "";
    script = async ({ order, gateway, worker: handle }) => {
      try {
        const r = await gateway.call({ callId: "w1", tool: { name: "write-file", version: "2.1.0" }, args: { path: "login.ts" } }, { kind: "local", run: async () => { throw new Error("disk full"); } });
        assert.equal(r.state, "failed", JSON.stringify(r));
        await services!.recordCompaction(order, { messageCount: 40, summaryChars: 900, digest: "d".repeat(64) });
        const b = await call(ann, "branch.open", { taskId: task, purpose: "check whether the cache is stale" }, "b1");
        assert.ok(b.ok, JSON.stringify(b));
        lane = b.result.id as string;
        await services!.recordThinking(order, [{ entryId: 1, block: 0, provider: "strata", model: "qwen", text: "the disk is full; try the other engine", opaque: false }] as never);
      } catch (error) { failures.push(error); }
      ready();
      await new Promise<void>((resolve) => { const t = setInterval(() => { if (handle.stopped > 0) { clearInterval(t); resolve(); } }, 5); });
      return { status: "cancelled", text: "stopped" };
    };
    await c.dispatch.dispatcher.tick();
    await working;
    assert.equal(failures.length, 0, failures.map(String).join("; "));
    assert.equal(worker.starts.find((o) => o.attemptId === first)?.route, "strata/qwen");
    // The owner cuts the first engine over: the running attempt is cancelled and its replacement is started on the next open route. Its process answers the owner and finishes.
    script = async () => {
      try {
        const answered = await call(ann, "message.send", { taskId: task, to: owner.id, class: "informational", purpose: "the old form is gone", text: "the old login form was removed last week" }, "msg-2");
        assert.ok(answered.ok, JSON.stringify(answered));
      } catch (error) { failures.push(error); }
      return { status: "completed", text: "done" };
    };
    const cut = await call(boot.token, "routing.cutover", { level: "endpoint", name: "strata-http", reason: "the disk is full" }, "cut1");
    assert.ok(cut.ok && cut.result.cancelled.length === 1, JSON.stringify(cut));
    const second = (await s.assignments.getAssignment(task))!.activeAttemptId!;
    assert.ok(second !== undefined && second !== first, "a replacement was admitted");
    await c.dispatch.dispatcher.tick();
    await c.dispatch.dispatcher.idle();
    assert.equal(failures.length, 0, failures.map(String).join("; "));
    assert.equal(worker.starts.find((o) => o.attemptId === second)?.route, "gpu2/qwen", "the replacement runs on the next open route");

    // ---- the owner's correction, in free words through the chat: shown first, applied on yes ----
    const steps0 = (await call(boot.token, "activity.steps", { taskId: task })).result.steps as { seq: number; kind: string }[];
    const instruction = steps0.find((x) => x.kind === "owner-message")!.seq;
    const wrong = "the first thing I said was wrong: the old way is gone; use the new login API";
    say[wrong] = [{ kind: "command", op: "activity.correct", args: { taskId: task, seq: instruction, note: "the old way is gone; use the new login API", replaces: true }, evidence: wrong, basis: "owner" }];
    const proposed = await c.chat!.submit(boot.token, { messageId: "m1", text: wrong });
    const pid = (proposed.outcomes as readonly { proposalId?: string }[]).find((o) => o.proposalId !== undefined)?.proposalId;
    assert.ok(pid !== undefined, JSON.stringify(proposed));
    assert.equal((await call(boot.token, "activity.replay.open", { taskId: task })).result.summary.superseded, 0, "nothing replaced before the yes");
    assert.equal((await c.chat!.applyProposal(boot.token, { commandId: "ap1", proposalId: pid! })).applied, true);

    // ---- the replay: each producer's step, with an honest outcome, on its line ----
    const open = (await call(boot.token, "activity.replay.open", { taskId: task, limit: 50 })).result;
    const steps = (open.entries as Step[]).filter((e) => e.authority !== undefined);
    const one = (what: string, pick: (x: Step) => boolean): Step => { const found = steps.filter(pick); assert.equal(found.length, 1, `${what}: ${JSON.stringify(steps.map((x) => [x.seq, x.kind, x.actor, x.outcome, x.summary]))}`); return found[0]!; };
    const byController = (x: Step) => x.actor !== owner.id && !x.actor.startsWith("agent:");
    const ownerSaid = one("the owner's instruction", (x) => x.kind === "owner-message");
    assert.deepEqual([ownerSaid.outcome, ownerSaid.authority, ownerSaid.lane], ["dispatched", "superseded", "main"]);
    assert.ok(byController(ownerSaid), "the messages service wrote it, not the owner by hand");
    const failedCall = one("the failed tool call", (x) => x.kind === "tool-call");
    assert.match(failedCall.summary, /write-file failed/);
    assert.deepEqual([failedCall.outcome, failedCall.outcomeNote, failedCall.lane], ["failed", undefined, "main"], "the dispatcher's own knowledge that the call came back without effect");
    assert.ok(byController(failedCall));
    const compressed = one("the compressed history", (x) => x.kind === "compression");
    assert.ok(byController(compressed) && compressed.outcome === "confirmed");
    const side = steps.filter((x) => x.kind === "branch");
    assert.ok(side.length >= 1 && side.every((x) => x.lane === lane && x.laneStatus === "controller" && byController(x)), JSON.stringify(side));
    const moved = one("the provider switch", (x) => x.kind === "model-selected" && /moved from route strata\/qwen to route gpu2\/qwen/.test(x.summary));
    assert.ok(byController(moved) && moved.outcome === "confirmed" && moved.lane === "main");
    assert.ok(moved.seq > failedCall.seq, "the switch comes after the failure it followed");
    const routes = steps.filter((x) => x.kind === "model-selected" && /runs on route/.test(x.summary)).map((x) => x.summary.replace(/^.* on route (\S+)\.$/, "$1"));
    assert.deepEqual(routes, ["strata/qwen", "gpu2/qwen"], "each attempt's route, as the dispatcher chose it");
    const answer = one("the agent's answer", (x) => x.kind === "agent-message");
    assert.ok(byController(answer) && answer.outcome === "dispatched" && answer.seq > moved.seq);
    const correction = one("the owner's correction", (x) => x.kind === "instruction");
    assert.deepEqual([correction.actor, correction.outcome, correction.authority], [owner.id, "confirmed", "current"]);
    assert.deepEqual(ownerSaid.supersededBy, [correction.seq]);
    assert.equal(open.summary.superseded, 1);
    assert.deepEqual(open.summary.lanes.map((l: { lane: string }) => l.lane), ["main", lane]);
    assert.equal(open.summary.byOutcome.failed, 1);
    // No step of the story was written by hand: every step is the owner's correction or a controller service's.
    assert.deepEqual(steps.filter((x) => !byController(x)).map((x) => x.seq), [correction.seq]);

    // ---- what the steps cite, resolved for the reader: both messages are readable, and the agent's words are marked untrusted ----
    const linksOf = async (token: string, seq: number) => (await call(token, "activity.replay.links", { taskId: task, seq })).result.items as { kind: string; resolution: { state: string; title?: string; lines?: string[]; untrusted?: boolean } }[];
    const fromAgent = (await linksOf(boot.token, answer.seq)).find((i) => i.kind === "agent-message")!;
    assert.equal(fromAgent.resolution.state, "readable", JSON.stringify(fromAgent));
    assert.equal(fromAgent.resolution.untrusted, true, "an agent's words are marked untrusted");
    assert.ok(JSON.stringify(fromAgent.resolution).includes("the old login form was removed last week"), JSON.stringify(fromAgent));
    const toAgent = (await linksOf(boot.token, ownerSaid.seq)).find((i) => i.kind === "agent-message")!;
    assert.equal(toAgent.resolution.state, "readable", JSON.stringify(toAgent));
    assert.equal(toAgent.resolution.untrusted, true);
    assert.ok((await linksOf(boot.token, failedCall.seq)).some((i) => i.kind === "tool-operation"), "the failed call cites its operation");

    // ---- the web view reads the same replay, with zero effects ----
    const readTable = async (table: "operations" | "deliveries" | "effects" | "state"): Promise<Record<string, unknown>[]> => {
      const snap = await c.storage.snapshot();
      try {
        const rows: Record<string, unknown>[] = [];
        for (let afterRow: Record<string, unknown> | undefined; ;) { const page = await snap.read(table, { ...(afterRow === undefined ? {} : { after: afterRow }), limit: 500 } as never) as Record<string, unknown>[]; rows.push(...page); if (page.length < 500) break; afterRow = page[page.length - 1]; }
        return rows;
      } finally { await snap.close(); }
    };
    const watched = async () => ({ ops: (await readTable("operations")).map((o) => String(o["operation_id"])), deliveries: JSON.stringify(await readTable("deliveries")), deliverySeq: String((await readTable("state"))[0]!["delivery_seq"]), effects: (await readTable("effects")).length, models: modelCalls.length, interpreted: interpreter.calls.length });
    const port = c.webChat!.port;
    const http = (method: string, path: string, o: { cookie?: string; csrf?: string; body?: unknown } = {}): Promise<Reply> => new Promise((resolve, reject) => {
      const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
      const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }), ...(o.cookie === undefined ? {} : { cookie: o.cookie }), ...(o.csrf === undefined ? {} : { "x-nn-csrf": o.csrf }) };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => { const chunks: Buffer[] = []; res.on("data", (x: Buffer) => chunks.push(x)); res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let body: unknown; try { body = JSON.parse(text); } catch { body = undefined; } resolve({ status: res.statusCode!, body, text, headers: res.headers }); }); });
      req.on("error", reject); if (payload !== undefined) req.write(payload); req.end();
    });
    const login = await http("POST", "/web/login", { body: { token: boot.token } });
    assert.equal(login.status, 200, login.text);
    const sess = { cookie: String([login.headers["set-cookie"]].flat()[0]).split(";")[0]! };
    const quiet0 = await watched();
    const web = await http("GET", `/web/replay/${task}?limit=50`, sess);
    assert.equal(web.status, 200, web.text);
    assert.deepEqual((web.body.replay.entries as Step[]).filter((e) => e.authority !== undefined).map((e) => [e.seq, e.kind, e.outcome, e.lane, e.authority]), steps.map((e) => [e.seq, e.kind, e.outcome, e.lane, e.authority]), "the page shows the same steps as the API");
    const onLane = await http("GET", `/web/replay/${task}?lane=${encodeURIComponent(lane)}`, sess);
    assert.deepEqual((onLane.body.replay.entries as Step[]).map((e) => e.seq), side.map((x) => x.seq));
    const page = await http("GET", `/web/replay/${task}/steps/${answer.seq}`, sess);
    assert.equal(page.status, 200, page.text);
    assert.equal(page.body.links.items.find((i: { kind: string }) => i.kind === "agent-message").resolution.untrusted, true);
    const found = await http("GET", `/web/replay/${task}/search?q=${encodeURIComponent("write-file")}`, sess);
    assert.deepEqual(found.body.search.matches.map((m: { seq: number }) => m.seq), [failedCall.seq]);
    for (const seq of steps.map((x) => x.seq)) assert.equal((await http("GET", `/web/replay/${task}/steps/${seq}`, sess)).status, 200);
    assert.equal((await call(boot.token, "activity.replay.rerun", { taskId: task }, "rr1")).error?.code, "forbidden", "a rerun is refused inside the replay");
    const quiet1 = await watched();
    assert.deepEqual(quiet1.ops, quiet0.ops, "a replay read wrote an operation");
    assert.equal(quiet1.deliveries, quiet0.deliveries, "a replay read changed the outbox");
    assert.equal(quiet1.deliverySeq, quiet0.deliverySeq, "a replay read queued a delivery");
    assert.equal(quiet1.effects, quiet0.effects, "a replay read opened an effect");
    assert.equal(quiet1.interpreted, quiet0.interpreted, "no replay read went through the chat interpreter");
    assert.equal(modelCalls.length, 0, `no model or route was called anywhere in the story: ${modelCalls.join(",")}`);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

test("the replay of a task whose steps all come from their real producers through the composed controller: an owner message, a failed tool call, a compaction, a side line, a cutover to the next route, the agent's answer and a chat correction (SQLite, card U09b)", async () => { await story("sqlite"); });

test("the same on PostgreSQL (card U09b)", async () => {
  const pg = await startTestServer();
  try { await story({ pg }); } finally { await pg.stop(); }
});

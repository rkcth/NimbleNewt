import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RETENTION_DEFAULTS, RetentionService } from "../retention/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const ASSETS = { "/": { type: "text/html; charset=utf-8", body: "<!doctype html><title>t</title>" }, "/app.js": { type: "text/javascript", body: "1" } };
const DAY = 86_400_000;
type Reply = { status: number; body: any; text: string; headers: Record<string, string | string[] | undefined> };

// Card U09b (finish): one task's replay through the RUNNING controller and its web door. Producers fill outcome, branch and supersedes honestly; the owner's replay and the page's routes read them with zero effects;
// the thinking is collapsed, labelled and, after retention, only a notice; a rerun is refused in the replay and is a separate simulation; the owner's correction replaces a step.
test("the replay of a task with a side line, a compaction, an approval, a submission-free owner correction and thinking, through the composed controller, the web routes and the chat (card U09b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-replay-finish-"));
  const built: { recordThinking: (order: never, blocks: never) => Promise<void>; recordCompaction: (order: never, note: never) => Promise<void> }[] = [];
  const say: { [text: string]: unknown[] } = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) }, webChat: { host: "127.0.0.1", network: "loopback", assets: ASSETS },
    dispatch: { timer: new ManualTimer(), manual: true, local: { acceptUnenforcedLimits: true, window: () => 8192, build: async (services) => { built.push(services as never); return { hostId: "host:w1" } as unknown as WorkerHost; } } },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: { [k: string]: unknown }, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "fix the login bug" })).id;
    const annId = (await c.services.agents.create(owner, { commandId: "ag-1", friendlyName: "ann" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId: task, owner: { kind: "agent", id: annId } });
    const assigned = (await c.services.assignments.getAssignment(task))!;
    const attemptId = (await c.services.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId: task, expectedRevision: assigned.revision, generation: assigned.generation, owner: { kind: "agent", id: annId }, harness: "pi" })).id;
    const order = { route: "x", projectId: project, taskId: task, agentId: annId, attemptId, generation: assigned.generation } as never;
    await c.services.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "attempt.work", project }, { action: "history.append", project }, { action: "history.read", project }, { action: "review.request", project }, { action: "task.read", project }] });
    const ann = (await c.services.principals.issueCredential(owner, "agent:ann")).token;

    const auditAll = async () => { const all: Awaited<ReturnType<typeof c.storage.listAudit>> = []; for (let seq = 0; ; ) { const page = await c.storage.listAudit({ afterSeq: seq, limit: 1000 }); if (page.length === 0) return all; all.push(...page); seq = page[page.length - 1]!.seq; } };

    // ---- the producers ----
    const rec = (token: string, id: string, args: { [k: string]: unknown }) => call(token, "activity.record", { taskId: task, ...args }, id);
    assert.ok((await rec(boot.token, "s1", { kind: "instruction", summary: "fix the login bug the old way", outcome: "confirmed" })).ok);          // 1
    assert.ok((await rec(boot.token, "s2", { kind: "model-selected", summary: "moved from route local to route cloud", outcome: "confirmed" })).ok);  // 2 (what the dispatcher writes on a provider switch)
    await built[0]!.recordCompaction(order, { messageCount: 40, summaryChars: 900, digest: "d".repeat(64) } as never);                               // 3 the real producer
    const branch = await call(ann, "branch.open", { taskId: task, purpose: "check whether the cache is stale" }, "b1");
    assert.ok(branch.ok, JSON.stringify(branch));
    const lane = branch.result.id as string;                                                                                                              // 4 the real producer
    assert.ok((await rec(ann, "s5", { kind: "tool-call", summary: "ran the cache probe", outcome: "dispatched", branch: lane })).ok);              // 5 an agent's own claim on the lane
    assert.ok((await rec(ann, "s6", { kind: "tool-call", summary: "the probe failed: connection refused", outcome: "failed", branch: lane })).ok);  // 6 a failed tool call came back without taking effect
    const rq = await c.services.reviews.request({ ...(await c.services.principals.authenticate(ann)) }, { commandId: "rq1", taskId: task, operation: { name: "git-commit", args: { n: 1 } as never, target: { kind: "repository", id: "main" } }, context: { toolVersion: "1.0", authoritySource: "task grant", expectedEffects: ["commits"] } });
    await c.services.reviews.decide(owner, { commandId: "dc1", requestId: rq.id, expectedRevision: (await c.services.reviews.get(owner, rq.id))!.revision, verdict: "allow", reason: "fine, the commit is small" });  // 7 the real producer
    await built[0]!.recordThinking(order, [{ entryId: 1, block: 0, provider: "llama", model: "local-m", text: "the cache looks stale; check the probe first", opaque: false }] as never);

    // ---- the owner's correction, in free words through the chat: shown first, applied on yes ----
    const wrong = "step 1 was wrong: the old way is gone; use the new login API";
    say[wrong] = [{ kind: "command", op: "activity.correct", args: { taskId: task, seq: 1, note: "the old way is gone; use the new login API", replaces: true }, evidence: wrong, basis: "owner" }];
    const proposed = await c.chat!.submit(boot.token, { messageId: "m1", text: wrong });
    const pid = (proposed.outcomes as readonly { proposalId?: string }[]).find((o) => o.proposalId !== undefined)?.proposalId;
    assert.ok(pid !== undefined, JSON.stringify(proposed));
    assert.equal(((await call(boot.token, "activity.replay.open", { taskId: task })).result.summary.superseded), 0, "nothing written before the yes");
    assert.equal((await c.chat!.applyProposal(boot.token, { commandId: "ap1", proposalId: pid! })).applied, true);

    // ---- the replay through the API: honest outcomes, lanes verified, the correction visible ----
    const open = (await call(boot.token, "activity.replay.open", { taskId: task, limit: 50 })).result;
    const steps = open.entries.filter((e: { seq: number; authority?: string }) => e.authority !== undefined) as { seq: number; kind: string; actor: string; outcome: string; outcomeNote?: string; lane: string; laneStatus: string; authority: string; supersededBy?: number[] }[];
    const at = (seq: number) => steps.find((s) => s.seq === seq)!;
    assert.deepEqual(steps.map((s) => s.kind), ["instruction", "model-selected", "compression", "branch", "tool-call", "tool-call", "approval", "instruction"]);
    assert.deepEqual(steps.map((s) => s.outcome), ["confirmed", "confirmed", "confirmed", "confirmed", "dispatched", "failed", "confirmed", "confirmed"]);
    assert.ok(at(3).actor !== owner.id && !at(3).actor.startsWith("agent:"), `the compaction is written by the controller's own identity, not by an agent or the owner: ${at(3).actor}`);
    assert.equal(at(4).lane, lane); assert.equal(at(4).laneStatus, "controller", "a step a controller service wrote on the line");
    assert.equal(at(5).laneStatus, "verified", "an agent's step on a line the branch registry knows");
    assert.equal(at(5).outcomeNote, "reported by agent", "an agent's claim is shown as its claim");
    assert.equal(at(7).outcomeNote, undefined, "the controller's own outcome carries no such note");
    assert.deepEqual([at(1).authority, at(1).supersededBy], ["superseded", [8]]);
    assert.deepEqual(open.summary.lanes.map((l: { lane: string }) => l.lane), ["main", lane]);
    assert.ok(open.summary.byOutcome.dispatched === 1 && open.summary.byOutcome.failed === 1 && open.summary.byOutcome.confirmed === 6, JSON.stringify(open.summary.byOutcome));

    // ---- links resolved for the reader: the approval, the side line; a kind with no reader stays a reference ----
    const approval = (await call(boot.token, "activity.replay.links", { taskId: task, seq: 7 })).result;
    const rv = approval.items.find((i: { kind: string }) => i.kind === "review");
    assert.equal(rv.resolution.state, "readable"); assert.match(rv.resolution.title, /Approval request for git-commit by agent:ann: approved/); assert.ok(rv.resolution.lines.includes("fine, the commit is small"));
    const side = (await call(boot.token, "activity.replay.links", { taskId: task, seq: 4 })).result.items.find((i: { kind: string }) => i.kind === "context-branch");
    assert.match(side.resolution.title, /Side line of work \(active\)/);
    const compaction = (await call(boot.token, "activity.replay.links", { taskId: task, seq: 3 })).result.items.find((i: { kind: string }) => i.kind === "compaction");
    assert.equal(compaction.resolution.state, "no-reader");
    assert.equal((await call(ann, "activity.replay.links", { taskId: task, seq: 7 })).result.items.find((i: { kind: string }) => i.kind === "review").resolution.state, "readable", "the requester reads its own approval");
    // Review: nobody else reads this task's replay, links or simulation. A task credential for ANOTHER task of the same project, and an agent of another project with full history rights there, are refused on
    // the new reads exactly as on the old ones, and neither can start a simulation.
    const task2 = (await c.services.projects.createTask({ commandId: "t2", actor: owner.id, projectId: project, title: "another task" })).id;
    const cred2 = (await c.services.taskCredentials.issue(owner, { commandId: "tc-ann-2", taskId: task2, agentId: "agent:ann" })).token;
    for (const op of ["activity.replay.links", "activity.replay.step", "activity.replay.led"]) assert.equal((await call(cred2, op, { taskId: task, seq: 7 })).error?.code, "forbidden", `${op} through another task's credential`);
    assert.equal((await call(cred2, "activity.replay.simulate", { taskId: task }, "sm-tc")).error?.code, "forbidden");
    assert.equal((await call(cred2, "activity.replay.simulate", { taskId: task2 }, "sm-tc2")).error?.code, "forbidden", "not even on its own task: a simulation is the owner's");
    assert.equal((await call(cred2, "activity.replay.thinking", { taskId: task2, reason: "peek" }, "pk-tc")).error?.code, "not_found");
    const elsewhere = (await c.services.projects.createProject({ commandId: "p2", actor: owner.id, name: "Elsewhere" })).id;
    await c.services.principals.enroll(owner, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "history.read", project: elsewhere }, { action: "history.append", project: elsewhere }, { action: "task.read", project: elsewhere }] });
    const zed = (await c.services.principals.issueCredential(owner, "agent:zed")).token;
    for (const op of ["activity.replay.links", "activity.replay.step"]) { const r = await call(zed, op, { taskId: task, seq: 7 }); assert.ok(r.ok === false && ["forbidden", "not_found"].includes(r.error.code), `${op} for another project's agent: ${JSON.stringify(r)}`); }
    assert.equal((await call(zed, "activity.replay.simulate", { taskId: task }, "sm-z")).error?.code, "forbidden");
    assert.equal((await call(zed, "activity.correct", { taskId: task, seq: 1, note: "no", replaces: true }, "cz")).error?.code, "forbidden");
    assert.equal((await call(ann, "activity.correct", { taskId: task, seq: 2, note: "it was wrong", replaces: true }, "ca")).error?.code, "forbidden", "an agent with history rights still cannot replace a step");
    // The chat's step view quotes what the step cites.
    say["show step 7"] = [{ kind: "status", request: { kind: "replay", taskId: task, seq: 7 }, evidence: "show step 7", basis: "owner" }];
    assert.match(JSON.stringify(await c.chat!.submit(boot.token, { messageId: "m2", text: "show step 7" })), /Approval request for git-commit/);

    // ---- the web routes, as the owner's page uses them ----
    const port = c.webChat!.port;
    const http = (method: string, path: string, o: { cookie?: string; csrf?: string; body?: unknown; key?: string } = {}): Promise<Reply> => new Promise((resolve, reject) => {
      const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
      const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }), ...(o.cookie === undefined ? {} : { cookie: o.cookie }), ...(o.csrf === undefined ? {} : { "x-nn-csrf": o.csrf }), ...(o.key === undefined ? {} : { "idempotency-key": o.key }) };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => { const chunks: Buffer[] = []; res.on("data", (x: Buffer) => chunks.push(x)); res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let body: unknown; try { body = JSON.parse(text); } catch { body = undefined; } resolve({ status: res.statusCode!, body, text, headers: res.headers }); }); });
      req.on("error", reject); if (payload !== undefined) req.write(payload); req.end();
    });
    assert.equal((await http("GET", `/web/replay/${task}`)).status, 401, "no session, no replay");
    const login = await http("POST", "/web/login", { body: { token: boot.token } });
    assert.equal(login.status, 200, login.text);
    const sess = { cookie: String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!, csrf: login.body.csrf as string };
    const list = await http("GET", "/web/views/replay", sess);
    assert.equal(list.status, 200, list.text);
    assert.ok(list.body.parts.tasks.items.some((t: { id: string }) => t.id === task), "the page offers the task");
    const audit0 = (await auditAll()).length;
    const effects0 = (await c.storage.listAggregates("effect", { limit: 100 })).length;
    const web = await http("GET", `/web/replay/${task}?limit=50`, sess);
    assert.equal(web.status, 200, web.text);
    assert.deepEqual(web.body.replay.summary.lanes.map((l: { lane: string }) => l.lane), ["main", lane]);
    assert.match(web.body.labels.concurrent, /side by side/); assert.match(web.body.labels.thinking, /Model output/);
    const filtered = await http("GET", `/web/replay/${task}?lane=${encodeURIComponent(lane)}`, sess);
    assert.deepEqual(filtered.body.replay.entries.map((e: { seq: number }) => e.seq), [4, 5, 6]);
    assert.equal((await http("GET", `/web/replay/${task}?limit=51`, sess)).status, 400);
    assert.equal((await http("GET", `/web/replay/${task}?from=abc`, sess)).status, 400);
    assert.equal((await http("GET", `/web/replay/not-a-task`, sess)).status, 404);
    assert.equal((await http("GET", `/web/replay/${task}?since=yesterday`, sess)).status, 400, "the controller's own refusal reaches the page in its words");
    const step = await http("GET", `/web/replay/${task}/steps/7`, sess);
    assert.equal(step.status, 200, step.text);
    assert.equal(step.body.detail.step.kind, "approval");
    assert.ok(step.body.links.items.some((i: { resolution: { state: string } }) => i.resolution.state === "readable"));
    assert.equal((await http("GET", `/web/replay/${task}/steps/0`, sess)).status, 404);
    assert.equal((await http("GET", `/web/replay/${task}/steps/99`, sess)).status, 404);
    const search = await http("GET", `/web/replay/${task}/search?q=probe`, sess);
    assert.deepEqual(search.body.search.matches.map((m: { seq: number }) => m.seq), [5, 6]);
    assert.equal((await http("GET", `/web/replay/${task}/search`, sess)).status, 400);
    assert.equal((await auditAll()).length, audit0, "reading the replay wrote nothing, not even an audit entry");
    assert.equal((await c.storage.listAggregates("effect", { limit: 100 })).length, effects0);

    // ---- the thinking: collapsed until asked, a recorded look, model output; no key, no CSRF, no extra fields ----
    assert.equal((await http("POST", `/web/replay/${task}/thinking`, { cookie: sess.cookie, body: {}, key: "k1" })).status, 403, "no CSRF header");
    assert.equal((await http("POST", `/web/replay/${task}/thinking`, { ...sess, body: {} })).status, 400, "no Idempotency-Key");
    assert.equal((await http("POST", `/web/replay/${task}/thinking`, { ...sess, body: { reason: "mine" }, key: "k1" })).status, 400, "the page cannot say another reason in the owner's name");
    const look = await http("POST", `/web/replay/${task}/thinking`, { ...sess, body: {}, key: "k2" });
    assert.equal(look.status, 200, look.text);
    assert.deepEqual([look.body.thinking.collapsed, look.body.thinking.state], [true, "stored"]);
    assert.match(look.body.thinking.label, /Model output/);
    assert.equal(look.body.thinking.blocks[0].text, "the cache looks stale; check the probe first");
    assert.equal((await http("POST", `/web/replay/${task}/thinking`, { ...sess, body: {}, key: "k2" })).status, 200, "a retry under the same key is answered, not a second look");
    assert.equal((await call(ann, "activity.replay.thinking", { taskId: task, reason: "peek" }, "pk")).error?.code, "not_found", "an agent never reads it");

    // ---- a rerun is refused in the replay and runs only as the separate, isolated simulation ----
    assert.equal((await call(boot.token, "activity.replay.rerun", { taskId: task }, "rr1")).error?.code, "forbidden");
    assert.equal((await call(ann, "activity.replay.simulate", { taskId: task }, "sm0")).error?.code, "forbidden");
    const audit1 = (await auditAll()).length;
    assert.equal((await http("POST", `/web/replay/${task}/simulate`, { cookie: sess.cookie, body: {}, key: "sim-x" })).status, 403, "no CSRF header");
    assert.equal((await http("POST", `/web/replay/${task}/simulate`, { cookie: sess.cookie, csrf: `${sess.csrf}x`, body: {}, key: "sim-x" })).status, 403, "a wrong CSRF header");
    assert.equal((await http("POST", `/web/replay/${task}/thinking`, { cookie: sess.cookie, csrf: "not-the-token", body: {}, key: "k-x" })).status, 403, "a wrong CSRF header");
    assert.equal((await http("POST", `/web/replay/${task}/simulate`, { ...sess, body: {} })).status, 400, "no Idempotency-Key");
    assert.equal((await http("POST", `/web/replay/${task}/simulate`, { ...sess, body: {}, key: "bad key!" })).status, 400, "an Idempotency-Key that is not a plain name");
    assert.equal((await http("GET", `/web/replay/${task}/simulate`, sess)).status, 405);
    assert.equal((await auditAll()).length, audit1, "nothing refused was written");
    const sim = await http("POST", `/web/replay/${task}/simulate`, { ...sess, body: { failAt: 5 }, key: "sim-1" });
    assert.equal(sim.status, 200, sim.text);
    assert.match(sim.body.simulation.label, /^Simulated\. Nothing was run, sent, spent or changed/);
    assert.deepEqual(sim.body.simulation.steps.map((s: { simulatedOutcome: string }) => s.simulatedOutcome), ["as-recorded", "as-recorded", "as-recorded", "as-recorded", "failed-injected", "not-reached", "not-reached", "not-reached"]);
    assert.equal((await auditAll()).length, audit1 + 1, "one record: the simulation's own");
    assert.equal((await c.storage.listAggregates("effect", { limit: 100 })).length, effects0, "no effect in the ledger");
    assert.equal((await http("POST", `/web/replay/${task}/simulate`, { ...sess, body: { failAt: 5 }, key: "sim-1" })).body.replayed, true);
    assert.equal((await http("POST", `/web/replay/${task}/simulate`, { ...sess, body: { tools: ["x"] }, key: "sim-2" })).status, 400);
    // By chat: free words, applied at once (it changes nothing), the interpreter prompt names it.
    const rerun = "rerun the replay of the login bug as a simulation and fail step 5";
    say[rerun] = [{ kind: "command", op: "activity.replay.simulate", args: { taskId: task, failAt: 5 }, evidence: rerun, basis: "owner" }];
    const simulated = await c.chat!.submit(boot.token, { messageId: "m3", text: rerun });
    assert.ok((simulated.outcomes as readonly { status: string }[]).some((o) => o.status === "applied"), JSON.stringify(simulated));

    // ---- the thinking after retention: only the notice; the timeline and the audit records of the work are unchanged ----
    const before = JSON.stringify({ open: (await call(boot.token, "activity.replay.open", { taskId: task, limit: 50 })).result.entries, timeline: (await call(boot.token, "activity.timeline", { projectId: project })).result.steps });
    const auditBefore = (await auditAll()).filter((a) => a.type !== "retention.expire").length;
    for (const to of ["in_progress", "done"]) await c.services.projects.transitionTask({ commandId: `end-${to}`, actor: owner.id, taskId: task, expectedRevision: (await c.services.projects.getTask(task))!.revision, to: to as never });
    const future = Date.now() + 30 * DAY;
    const retention = RetentionService.withEpoch(c.storage, c.epoch, { settings: { effective: async () => ({ ...RETENTION_DEFAULTS, reserveBytes: 0 }) }, now: () => future } as never, { clock: () => new Date(future).toISOString() });
    const preview = await retention.run(owner, { commandId: "ret-p" } as never);
    assert.ok(preview.candidates.some((x) => x.kind === "thinking-record"), JSON.stringify(preview.candidates));
    assert.ok((await retention.run(owner, { commandId: "ret-r", dryRun: false, confirm: preview.digest! } as never)).removed >= 1);
    const gone = await http("POST", `/web/replay/${task}/thinking`, { ...sess, body: {}, key: "k3" });
    assert.equal(gone.status, 200, gone.text);
    assert.deepEqual([gone.body.thinking.state, gone.body.thinking.blocks], ["removed-by-retention", undefined]);
    assert.match(gone.body.thinking.label, /removed by retention/);
    const detail = (await http("GET", `/web/replay/${task}/steps/1`, sess)).body.detail;
    assert.equal(detail.thinking.state, "removed-by-retention");
    const after = JSON.stringify({ open: (await call(boot.token, "activity.replay.open", { taskId: task, limit: 50 })).result.entries, timeline: (await call(boot.token, "activity.timeline", { projectId: project })).result.steps });
    // Only the task's own end is new in the timeline's data; the steps and their wording are the same, and the audit holds nothing but what was added (the task's two moves, the simulation, the looks, the retention run).
    assert.equal(after, before);
    assert.ok((await auditAll()).filter((a) => a.type !== "retention.expire").length >= auditBefore);
    assert.ok((await auditAll()).some((a) => a.type === "retention.expire"), "the deletion itself is on the audit record");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import { startController, type Controller } from "./index.js";

// Card C07g through the composed controller: a running attempt whose route is cut over is restarted on the next open route, and the replacement's first prompt is the owner's context rebuilt for that route's window,
// with the items cut to fit named by digests that read their full text back.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const local = { enabled: true, paid: false, location: "local" as const };
const table = {
  providers: { strata: local, gpu2: local, gpu3: local },
  // The second route of the list has a much smaller window than the first.
  routes: { "strata/qwen": { contextTokens: 100_000, capabilities: ["tools"] }, "gpu2/qwen": { contextTokens: 32_768, capabilities: ["tools"] }, "gpu3/qwen": { contextTokens: 100_000, capabilities: ["tools"] } },
  profiles: { main: ["strata/qwen", "gpu2/qwen", "gpu3/qwen"] },
  roles: { coordinator: "main", "safety-supervisor": "main" },
};
const topology = { services: [], targets: { "strata/qwen": { endpoint: "strata-http", account: "local" }, "gpu2/qwen": { endpoint: "gpu2-http", account: "local" }, "gpu3/qwen": { endpoint: "gpu3-http", account: "local" } }, aliases: {} };
const PROFILES = { profiles: { default: { harness: "pi", routingProfile: "main" } }, mapping: { unrated: "default" } };
const ANN = "agt-annannannannannannan";
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };
const HEADER = /\[The owner's decisions, goals, permissions and open questions for this task, rebuilt for model route ([^ ]+) \(a (\d+)-token window\)\.\]/;

test("a running attempt whose route is cut over is restarted on the next route with the owner's context rebuilt for its window in the first prompt; what was cut is named by digests that read the full text; the owner's setting turns it off (card C07g)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rview-"));
  // The turn lasts until its worker is stopped (a cutover, the controller closing).
  const worker = new ScriptedWorker("host:w1", async ({ worker: handle }) => {
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (handle.stopped > 0) { clearInterval(t); resolve(); } }, 5); });
    return { status: "cancelled", text: "stopped" };
  });
  const c: Controller = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, workers: [worker] },
  } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const call = (op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table } as never);
    await s.cutover.setTopology(owner, { commandId: "topo", expectedRevision: 0, topology } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.principals.enroll(owner, { commandId: `e-${ANN}`, kind: "agent", name: ANN, grants: [...workGrants(project)] });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Water the beds" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: ANN } });

    // The owner's record for the task: twenty long open questions, then a goal and a decision in the owner's own words.
    const questions: string[] = [];
    for (let i = 0; i < 20; i++) {
      const question = `Bed ${i}: ${"how much water does this bed need in a dry week, and at what time of day? ".repeat(11)}`.slice(0, 900);
      questions.push(question);
      const asked = await call("decision.ask", { taskId, topic: `bed-${i}`, question }, `q${i}`);
      assert.equal(asked.ok && asked.result.asked, true, JSON.stringify(asked));
    }
    const decide = async (category: string, topic: string, wording: string): Promise<void> => {
      const r = await call("decision.record", { projectId: project, category, topic, statement: wording, wording, basedOn: 0 }, `d-${topic}`);
      assert.equal(r.ok && r.result.recorded, true, JSON.stringify(r));
    };
    await decide("goal", "harvest", "Goal: every bed gives a harvest this summer.");
    await decide("decision", "hose", "Use the soaker hose, never the sprinkler.");

    const a = (await s.assignments.getAssignment(taskId))!;
    const first = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ANN }, harness: "pi" })).id;
    await c.dispatch!.dispatcher.tick();
    const orderOf = (attemptId: string) => worker.handles.find((h) => h.order.attemptId === attemptId)?.order;
    // The first attempt of the task: no earlier route, so no rebuilt view.
    assert.equal(orderOf(first)?.route, "strata/qwen");
    assert.doesNotMatch(orderOf(first)!.content, HEADER);
    assert.equal(orderOf(first)!.startupView, undefined);

    // The owner cuts the first route over while the attempt runs: it is ended and a replacement goes to the next open route, the small one.
    const cut = await call("routing.cutover", { level: "endpoint", name: "strata-http", reason: "swap the card" }, "cut1");
    assert.equal(cut.ok, true, JSON.stringify(cut));
    const replacement = (await s.assignments.getAssignment(taskId))!.activeAttemptId!;
    assert.notEqual(replacement, first);
    await c.dispatch!.dispatcher.tick();
    const order = orderOf(replacement)!;
    assert.equal(order.route, "gpu2/qwen");
    // The first prompt is the task's text, then the owner's context rebuilt for the small route.
    assert.ok(order.content.startsWith("Water the beds"), "the task's own text comes first");
    const header = HEADER.exec(order.content);
    assert.deepEqual(header?.slice(1), ["gpu2/qwen", "32768"]);
    assert.ok(order.content.includes("Goal: every bed gives a harvest this summer.") && order.content.includes("Use the soaker hose, never the sprinkler."), "the owner's goal and words are whole");
    assert.deepEqual([order.startupView?.route, order.startupView?.measured], ["gpu2/qwen", false], "the route was not measured: a host that can measure would rebuild it");
    assert.equal(order.content.length - order.startupView!.chars, order.content.indexOf("\n\n[The owner's decisions"), "the order says where the view begins");
    // Some questions did not fit the small window: they are cut or left out, each by the digest of its full text, and the footer says how to read them.
    const digests = [...order.content.matchAll(/sha256:[0-9a-f]{64}/g)].map((m) => m[0]);
    assert.ok(digests.length > 0, "something was cut to fit");
    assert.match(order.content, /items? (was|were) cut or left out to fit this route.*context\.route-archive\.read/);
    const whole = questions.filter((q) => order.content.includes(q)).length;
    assert.ok(whole > 0 && whole < questions.length, `some questions are whole (${whole}), the rest cut`);
    // Nothing is lost: every digest reads the full text back through the API, as the owner.
    for (const digest of new Set(digests)) {
      const back = await call("context.route-archive.read", { taskId, digest });
      assert.equal(back.ok, true, JSON.stringify(back));
      assert.ok(questions.some((q) => back.result.item.text.includes(q)), "the full question is read back");
    }
    // The decision that admitted the move is on record for the replacement.
    const decisions = (await c.storage.listAggregates("ctx-admission", { limit: 50 })).map((x) => x.body as unknown as { type: string; attemptId: string; admit: boolean });
    assert.ok(decisions.some((x) => x.type === "route-change" && x.attemptId === replacement && x.admit));

    // The owner turns the check off: the next move starts as before, without a rebuilt view.
    assert.ok((await call("context.route.change", { disable: ["check"] }, "rc1")).ok);
    assert.equal((await call("routing.cutover", { level: "endpoint", name: "gpu2-http", reason: "swap that card too" }, "cut2")).ok, true);
    const third = (await s.assignments.getAssignment(taskId))!.activeAttemptId!;
    await c.dispatch!.dispatcher.tick();
    assert.equal(orderOf(third)?.route, "gpu3/qwen");
    assert.doesNotMatch(orderOf(third)!.content, HEADER);
    assert.equal(orderOf(third)!.startupView, undefined);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});

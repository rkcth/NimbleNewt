import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OPERATIONS } from "../api/operations.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { EnvironmentService } from "../environments/index.js";
import { ExperimentService } from "../experiments/index.js";
import { StatusService, STATUS_KINDS } from "../status/index.js";
import { CHAT_OPS } from "./commands.js";
import { ModelInterpreter, promptAbout } from "./model-interpreter.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

// Card B04: the owner asks what the experiments found, proposes one, pins its criteria, raises its budget and concludes it, all in free words; nothing needs a fixed phrase.

after(stopServer);

const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const PROPOSAL = { problem: "slow reviews", affectedWork: "handler reviews", change: "a checklist in the coder prompt", effort: "a day", runningCost: "none", benefit: "less rework", evaluation: "five tasks with and without", stoppingCondition: "five runs" };
const CRITERIA = { baseline: { label: "v4", ref: "abc", digest: "a".repeat(64) }, evaluator: { label: "rubric", ref: "r2", digest: "b".repeat(64) }, cases: [{ id: "c1", text: "missing field" }], baselinePassing: ["c1"],
  baselineMetrics: { timeToAcceptedSeconds: 100, reworkCount: 4 }, budget: { maxRuns: 1, maxCost: 50 }, minRuns: 1 };
// The A08 revision a run's disposable environment is built from (no protected extension, so the host found none); the controller checks it before keeping the run (slice 2).
const MANIFEST = { base: { name: "nimblenewt-base", version: "1.0.0", digest: `sha256:${"1".repeat(64)}` }, packages: [], skills: [], capabilities: [], configuration: {}, limits: { cpus: 1, memoryMb: 512, diskMb: 1024, processes: 64 }, protectedExtensions: [] };
let environments: EnvironmentService | undefined;
const envOf = (agentId: string) => ({ agentId, revision: 1, observed: {}, disposable: true });

test("the interpreter prompt describes the experiments view, proposing, pinning, budget and concluding, from the one status-kind and operation tables (card B04)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "how are the experiments", quoted: [], focus: {}, proposals: [] });
  const kind = STATUS_KINDS["experiments"]!;
  assert.ok(system.includes(`experiments(${kind.keys.join(", ")}) - ${promptAbout(kind.about)}`), "the view is listed from the one table");
  for (const op of ["experiment.conclude(experimentId, expectedRevision, finding", "experiment.pin(experimentId, expectedRevision, criteria", "experiment.propose(projectId, title, proposal, affectedKey", "experiment.budget(experimentId, expectedRevision, maxRuns, maxCost, reason"]) assert.ok(system.includes(op), op);
  assert.match(system, /which experiments are running in Garden\?/);
  assert.match(system, /experiment\.pin with the criteria they gave, never invented digests or numbers/);
  for (const op of ["experiment.pin", "experiment.conclude", "experiment.withdraw", "experiment.budget"]) assert.equal(CHAT_OPS[op]?.revision, "experiment", op);
  assert.equal(CHAT_OPS["experiment.budget"]?.mode, "propose", "more spending is confirmed first");
  for (const op of ["propose", "pin", "run", "budget", "conclude", "withdraw", "get", "list"]) assert.ok(OPERATIONS.some((o) => o.name === `experiment.${op}`), op);
  assert.ok(!Object.keys(CHAT_OPS).includes("experiment.run"), "runs are reported by the proposing agent, never by chat");
});

for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>, experiments: ExperimentService, status: StatusService) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      let experiments: ExperimentService | undefined;
      const w = await openWorld(backend, script, undefined, (storage, epoch) => {
        environments = EnvironmentService.withEpoch(storage, epoch, { ...options, reservedDigest: async () => undefined, skillUsable: async () => true });
        experiments = ExperimentService.withEpoch(storage, epoch, { ...options, environments });
        return { experiments };
      });
      try {
        const epoch = w.projects.epoch;
        const status = StatusService.withEpoch(w.world.storage, epoch, { assignments: w.assignments, waits: WaitService.withEpoch(w.world.storage, epoch, w.assignments, options), blockers: BlockerService.withEpoch(w.world.storage, epoch, options), contracts: w.contracts, experiments: experiments! }, options);
        await body(w, script, experiments!, status);
      } finally { await w.close(); }
    });

  suite("the owner proposes, pins, sees the budget run out, raises it after confirming, and concludes in free words; a negative result is kept and shown; a stranger sees nothing", async (w, script, experiments, status) => {
    const a = await w.project("Garden");
    const dev = await w.agent("dev", [{ action: "meeting.agenda", project: a }]);
    await environments!.change(w.owner, { commandId: cid("env"), agentId: dev.principal.id, manifest: MANIFEST, reason: "first" });
    const chat = w.chat({ status });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const say = async (text: string, intents: unknown[]) => { script[text] = intents; return (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes[0]!; };
    const lines = (o: { lines?: readonly { text: string; cites: readonly unknown[] }[] }) => { assert.ok(o.lines!.every((l) => l.cites.length > 0), "every line cites a record"); return o.lines!.map((l) => l.text).join("\n"); };

    const proposeText = `let's test a checklist in the coder prompt against the current prompt. Title: Checklist prompt. Problem: slow reviews. Affected work: handler reviews. Change: a checklist in the coder prompt. Effort: a day. Running cost: none. Benefit: less rework. Evaluation: five tasks with and without. Stop condition: five runs. Label: handler reviews.`;
    let o = await say(proposeText, [cmd("experiment.propose", { title: "Checklist prompt", proposal: PROPOSAL, affectedKey: "handler reviews" }, "let's test a checklist in the coder prompt")]);
    assert.deepEqual([o.status, o.op], ["applied", "experiment.propose"], JSON.stringify(o));
    const id = (await experiments.list(w.owner, a))!.items[0]!.id;
    assert.match(lines(await say("which experiments are running in Garden?", [ask({ kind: "experiments" }, "which experiments")])), /1 experiment\(s\), oldest first[\s\S]*proposed: "Checklist prompt": a checklist in the coder prompt Stops: five runs\. criteria not pinned yet\./);

    o = await say(`go ahead with ${id}, baseline v4 abc digest ${"a".repeat(64)}, evaluator rubric r2 digest ${"b".repeat(64)}, case c1 missing field, one run, budget 50`, [cmd("experiment.pin", { experimentId: id, criteria: CRITERIA }, `go ahead with ${id}`)]);
    assert.deepEqual([o.status, o.op], ["applied", "experiment.pin"], JSON.stringify(o));
    const run = async (token: string, over: Record<string, unknown> = {}) => w.api.handle(token, { v: 1, op: "experiment.run", commandId: cid("r"), args: { experimentId: id, environment: envOf(dev.principal.id), cost: 4, metrics: { timeToAcceptedSeconds: 130, reworkCount: 5 }, cases: [{ id: "c1", passed: true }], ...over } } as never) as Promise<{ ok: boolean; error?: { code: string } }>;
    const first = await run(w.ownerToken);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual([(await run(dev.token)).error?.code, (await run(w.ownerToken)).error?.code], ["forbidden", "unavailable"], "an agent that did not propose it may not report runs; the budget is used up for the owner");
    assert.match(lines(await say("is the checklist trial out of budget?", [ask({ kind: "experiments", experimentStatus: "paused" }, "out of budget")])), /paused: "Checklist prompt"[\s\S]*1 of 1 runs, cost 4 of 50; the budget is used up, so it waits/);

    // More budget is a proposal the owner confirms, and the revision is filled in.
    o = await say(`give the checklist trial ${id} 3 more runs, because worth a closer look`, [cmd("experiment.budget", { experimentId: id, maxRuns: 4, maxCost: 50, reason: "worth a closer look" }, `give the checklist trial ${id} 3 more runs`)]);
    assert.equal(o.status, "proposed", JSON.stringify(o));
    assert.equal((await experiments.get(w.owner, id))!.status, "paused", "nothing changed before the owner confirmed");
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: (o as unknown as { proposalId: string }).proposalId });
    assert.equal(JSON.stringify(applied).includes("\"applied\""), true, JSON.stringify(applied));
    assert.equal((await experiments.get(w.owner, id))!.status, "running");

    o = await say(`stop the checklist trial ${id}, enough evidence: it was slower`, [cmd("experiment.conclude", { experimentId: id, finding: "it was slower" }, "stop the checklist trial")]);
    assert.deepEqual([o.status, o.op], ["applied", "experiment.conclude"], JSON.stringify(o));
    const got = (await experiments.get(w.owner, id))!;
    assert.deepEqual([got.status, got.result!.verdict, got.result!.finding, got.runs.length], ["concluded", "worse", "it was slower", 1]);
    const said = lines(await say("did the checklist help?", [ask({ kind: "experiments" }, "did the checklist help")]));
    assert.match(said, /concluded: "Checklist prompt"[\s\S]* Verdict: worse \(reworkCount 25% worse, timeToAcceptedSeconds 30% worse\)\. Finding: it was slower/);

    // An agent proposes through the API, reports its own runs, and cannot judge itself; a reader without meeting rights sees no list.
    const made = await w.api.handle(dev.token, { v: 1, op: "experiment.propose", commandId: cid("p"), args: { projectId: a, title: "Own idea", proposal: PROPOSAL, affectedKey: "docs" } } as never) as { ok: boolean; result?: { item?: { id: string }; id?: string } };
    assert.equal(made.ok, true, JSON.stringify(made));
    const mineId = (made.result as { id: string }).id;
    await experiments.pin(w.owner, { commandId: cid("pin"), experimentId: mineId, expectedRevision: 1, criteria: CRITERIA } as never);
    const ran = await w.api.handle(dev.token, { v: 1, op: "experiment.run", commandId: cid("r"), args: { experimentId: mineId, environment: envOf(dev.principal.id), cost: 1, metrics: { timeToAcceptedSeconds: 90, reworkCount: 3 }, cases: [{ id: "c1", passed: true }] } } as never) as { ok: boolean };
    assert.equal(ran.ok, true, "the proposer reports its own run");
    const own = await w.api.handle(dev.token, { v: 1, op: "experiment.conclude", commandId: cid("c"), args: { experimentId: mineId, expectedRevision: (await experiments.get(w.owner, mineId))!.revision, finding: "x" } } as never) as { ok: boolean; error?: { code: string } };
    assert.deepEqual([own.ok, own.error?.code], [false, "forbidden"]);
    const far = await w.agent("far", [{ action: "task.read", project: a }]);
    const listed = await w.api.handle(far.token, { v: 1, op: "experiment.list", args: { projectId: a } } as never) as { ok: boolean; error?: { code: string } };
    assert.deepEqual([listed.ok, listed.error?.code], [false, "not_found"]);
    const mine = await w.api.handle(dev.token, { v: 1, op: "experiment.get", args: { experimentId: mineId } } as never) as { ok: boolean; result?: { item: { status: string } } };
    assert.deepEqual([mine.ok, mine.result?.item.status], [true, "paused"], "one run used its budget of one");
    const other = await w.api.handle(dev.token, { v: 1, op: "experiment.get", args: { experimentId: id } } as never) as { ok: boolean; error?: { code: string } };
    assert.deepEqual([other.ok, other.error?.code], [false, "not_found"], "an agent reads only its own experiment");
  });
}

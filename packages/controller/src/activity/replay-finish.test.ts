import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { ActivityService, ReplayService, ReplaySimulationService, SIMULATION_LABEL, SIMULATION_LIMITS, LINK_LIMITS, type LinkResolver } from "./index.js";
import { replayResolvers } from "./replay-resolvers.js";

// Card U09b (finish): producers' claims (a step finished by a later one, an owner correction that replaces), links resolved for the reader, the isolated simulation, and a replay that still writes nothing.

after(stopServer);

let now = Date.parse("2026-11-12T10:00:00.000Z");
const options = { clock: () => new Date((now += 1000)).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, (error as Error).message); return true; });
};
const READS = new Set(["currentEpoch", "getOperation", "getAggregate", "listAggregates", "listAudit", "getDelivery", "getEffect", "getTimer", "snapshot"]);
const counting = (storage: ControllerStorage): { storage: ControllerStorage; calls: () => string[] } => {
  const calls: string[] = [];
  const proxy = new Proxy(storage, { get(target, key) {
    const value = (target as never)[key] as unknown;
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => { if (typeof key === "string" && !READS.has(key)) calls.push(key); return (value as (...a: unknown[]) => unknown).apply(target, args); };
  } });
  return { storage: proxy, calls: () => calls };
};
const service = (name: string): Principal => ({ id: `service:${name}`, kind: "service", name, grants: [] } as unknown as Principal);
const KEY = ["sk", "live", "ABCDEFGHIJKLMNOPQRSTUVWX1234"].join("-");
const op = (id: string) => ({ refs: [{ kind: "tool-operation", id }] });

async function world(backend: (typeof backends)[number]) {
  const w = await backend.open();
  const projects = await ProjectService.open(w.storage, { holder: "c1", ...options });
  const principals = PrincipalService.withEpoch(w.storage, projects.epoch, options);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const make = async (nm: string, grants: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
  const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
  const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
  return { w, projects, owner, make, project, task };
}

for (const backend of backends) {
  test(`${backend.name}: a later step finishes an earlier one of the same writer and line, never a confirmed one, another writer's or another line's, and telling either again is harmless (card U09b)`, async () => {
    const { w, projects, owner, make, project, task } = await world(backend);
    try {
      const svc = ActivityService.withEpoch(w.storage, projects.epoch, options);
      const replay = ReplayService.withEpoch(w.storage, projects.epoch, svc, {}, options);
      const disp = service("dispatch"); const other = service("other");
      const f = (by: Principal, c: Record<string, unknown>, ref?: string) => svc.recordFinishing(by, { commandId: cid("f"), taskId: task, kind: "tool-call", summary: "x", ...c } as never, ref === undefined ? undefined : { kind: "tool-operation", id: ref });
      await f(disp, { commandId: "a1", manifest: op("op1"), outcome: "proposed" }, "op1");     // 1 waiting for approval
      await f(disp, { commandId: "a2", manifest: op("op1"), outcome: "dispatched" }, "op1");   // 2 sent: replaces 1
      await f(disp, { commandId: "a3", manifest: op("op1"), outcome: "confirmed" }, "op1");    // 3 answer: replaces 2
      await f(disp, { commandId: "a4", manifest: op("op1"), outcome: "confirmed" }, "op1");    // 4 a confirmed step is never replaced
      await f(other, { commandId: "b1", manifest: op("op2"), outcome: "dispatched" }, "op2");  // 5 another writer's
      await f(disp, { commandId: "b2", manifest: op("op2"), outcome: "confirmed" }, "op2");    // 6 does not replace it
      await f(disp, { commandId: "c1", manifest: op("op3"), outcome: "dispatched", branch: "side" }, "op3"); // 7 on a side line
      await f(disp, { commandId: "c2", manifest: op("op3"), outcome: "confirmed" }, "op3");    // 8 on the main line: not the same line
      await f(disp, { commandId: "d1", manifest: op("op4"), outcome: "uncertain" }, "op4");    // 9
      await f(disp, { commandId: "d2", manifest: op("op4"), outcome: "confirmed" }, "op4");    // 10 an uncertain step is finished by the answer
      await f(disp, { commandId: "e1", manifest: op("op5"), outcome: "failed" }, "op5");       // 11 a call that came back failed is an answer, not an open step
      await f(disp, { commandId: "e2", manifest: op("op5"), outcome: "confirmed" }, "op5");    // 12 so a later step never replaces it
      const v = await replay.open(owner, task, { limit: 50 });
      const steps = v.entries.filter((e): e is Extract<typeof e, { seq: number; authority: string }> => "authority" in e);
      const bySeq = new Map(steps.map((s) => [s.seq, s]));
      assert.deepEqual(steps.filter((s) => s.authority === "superseded").map((s) => [s.seq, s.supersededBy]), [[1, [2]], [2, [3]], [9, [10]]]);
      assert.deepEqual([bySeq.get(3)!.supersedes, bySeq.get(4)!.supersedes, bySeq.get(6)!.supersedes, bySeq.get(8)!.supersedes, bySeq.get(10)!.supersedes, bySeq.get(12)!.supersedes], [2, undefined, undefined, undefined, 9, undefined]);
      assert.deepEqual([bySeq.get(11)!.outcome, bySeq.get(11)!.authority], ["failed", "current"]);
      assert.equal(bySeq.get(7)!.authority, "current");
      // Telling the same thing again (a retry of the dispatcher) is the first answer, also after the step it replaced is no longer open.
      for (const [id, ref, outcome, seq] of [["a1", "op1", "proposed", 1], ["a2", "op1", "dispatched", 2], ["a3", "op1", "confirmed", 3], ["d2", "op4", "confirmed", 10]] as const) {
        const again = await f(disp, { commandId: id, manifest: op(ref), outcome }, ref);
        assert.deepEqual([again.replayed, again.seq], [true, seq], id);
      }
      assert.equal((await replay.open(owner, task)).summary.total, 12, "nothing was added");
      // An agent's explicit claim keeps its own rule (record): it cannot replace a step another writer wrote, on any line, and the refusal writes nothing.
      const agent = await make("ann", [{ action: "attempt.work", project }]);
      await refuses("forbidden", () => svc.record(agent, { commandId: cid("z"), taskId: task, kind: "tool-call", summary: "y", supersedes: 6 } as never));
      await refuses("forbidden", () => svc.record(agent, { commandId: cid("z2"), taskId: task, kind: "tool-call", summary: "y", supersedes: 7, branch: "side" } as never));
      assert.equal((await replay.open(owner, task)).summary.total, 12, "the refusals wrote nothing");
      // The window is read in chunks: a finishing step finds its open step behind more than one chunk of other steps, and not beyond the window.
      await f(disp, { commandId: "w0", manifest: op("op-far"), outcome: "dispatched" }, "op-far");
      for (let i = 0; i < 60; i++) await f(other, { commandId: `w-${i}`, manifest: op(`noise-${i}`), outcome: "confirmed" });
      const far = await f(disp, { commandId: "w1", manifest: op("op-far"), outcome: "confirmed" }, "op-far");
      assert.equal((await replay.step(owner, task, far.seq)).step.supersedes, 13);
    } finally { await w.close(); }
  });

  test(`${backend.name}: only the owner's correction can say a step was wrong; it is kept as a note and also replaces the step on the same line, once (card U09b)`, async () => {
    const { w, projects, owner, make, project, task } = await world(backend);
    try {
      const ann = await make("ann", [{ action: "attempt.work", project }, { action: "history.append", project }]);
      const svc = ActivityService.withEpoch(w.storage, projects.epoch, options);
      const replay = ReplayService.withEpoch(w.storage, projects.epoch, svc, {}, options);
      await svc.record(ann, { commandId: cid("r"), taskId: task, kind: "instruction", summary: "use the old API", outcome: "confirmed" } as never);                 // 1
      await svc.record(ann, { commandId: cid("r"), taskId: task, kind: "tool-call", summary: "edit on the side", branch: "side", outcome: "confirmed" } as never);     // 2
      // A correction by an agent stays a note and cannot replace anything.
      await refuses("forbidden", () => svc.correct(ann, { commandId: cid("k"), taskId: task, seq: 1, note: "wrong", replaces: true }));
      await refuses("invalid_command", () => svc.correct(owner, { commandId: cid("k"), taskId: task, seq: 1, note: "wrong", replaces: "yes" as never }));
      const plain = await svc.correct(ann, { commandId: cid("k"), taskId: task, seq: 1, note: "just a note" });
      assert.equal(plain.supersededBy, undefined);
      assert.equal((await replay.open(owner, task)).summary.total, 2, "a note adds no step");
      const done = await svc.correct(owner, { commandId: "own-1", taskId: task, seq: 1, note: "the old API is gone; use v2", replaces: true });
      assert.equal(done.supersededBy, 3);
      const again = await svc.correct(owner, { commandId: "own-1", taskId: task, seq: 1, note: "the old API is gone; use v2", replaces: true });
      assert.deepEqual([again.replayed, again.supersededBy, again.id], [true, 3, done.id]);
      await refuses("command_conflict", () => svc.correct(owner, { commandId: "own-1", taskId: task, seq: 1, note: "the old API is gone; use v2" }));
      // A command ID at the length limit still completes both writes (the replacing step's command is derived at a fixed length).
      const long = `L${"x".repeat(119)}`;
      const atLimit = await svc.correct(owner, { commandId: long, taskId: task, seq: 2, note: "the side edit was wrong", replaces: true });
      assert.ok(atLimit.supersededBy !== undefined);
      assert.deepEqual((await svc.correct(owner, { commandId: long, taskId: task, seq: 2, note: "the side edit was wrong", replaces: true })).supersededBy, atLimit.supersededBy, "and a retry is answered as the first time");
      const v = await replay.open(owner, task);
      const s1 = v.entries.find((e) => "seq" in e && e.seq === 1) as unknown as { authority: string; supersededBy: number[]; corrections: number; links: { relation: string; seq?: number }[] };
      assert.deepEqual([s1.authority, s1.supersededBy, s1.corrections], ["superseded", [3], 2]);
      assert.ok(s1.links.some((l) => l.relation === "superseded-by" && l.seq === 3));
      const s3 = v.entries.find((e) => "seq" in e && e.seq === 3) as unknown as { actor: string; kind: string; outcome: string; supersedes: number; summary: string };
      assert.deepEqual([s3.actor, s3.kind, s3.outcome, s3.supersedes], [owner.id, "instruction", "confirmed", 1]);
      assert.match(s3.summary, /Owner correction replaces step 1: the old API is gone/);
      // A step on a side line is replaced on its own line.
      const side = await svc.correct(owner, { commandId: "own-2", taskId: task, seq: 2, note: "redo it", replaces: true });
      assert.equal(side.supersededBy, atLimit.supersededBy! + 1);
      const s4 = (await replay.open(owner, task)).entries.find((e) => "seq" in e && e.seq === side.supersededBy) as unknown as { lane: string; supersedes: number };
      assert.deepEqual([s4.lane, s4.supersedes], ["side", 2]);
    } finally { await w.close(); }
  });

  test(`${backend.name}: links are resolved by the record's own reader for this reader, wrong-task and unreadable records read as gone, text is cleaned and bounded, and nothing is written (card U09b)`, async () => {
    const { w, projects, owner, make, project, task } = await world(backend);
    try {
      const reader = await make("aud", [{ action: "history.read", project }]);
      const spy = counting(w.storage);
      const svc = ActivityService.withEpoch(w.storage, projects.epoch, options);
      await svc.record(owner, { commandId: cid("r"), taskId: task, kind: "agent-message", summary: "asked", manifest: { refs: [{ kind: "agent-message", id: "m1" }, { kind: "agent-message", id: "m-other" }, { kind: "agent-message", id: "m-forbidden" }, { kind: "context-branch", id: "no-reader" }, { kind: "constructor", id: "c" }, { kind: "submission", id: "dirty" }, { kind: "submission", id: "r1" }] } } as never);
      const seen: string[] = [];
      const resolvers: Record<string, LinkResolver> = {
        "agent-message": async (by, ref, t) => {
          seen.push(`${by.id}:${ref.id}:${t.taskId}`);
          if (ref.id === "m1") return { title: "Message from ann to bea", lines: ["Purpose: ask", "hello"], untrusted: true };
          if (ref.id === "m-forbidden") throw new DomainError("forbidden", "no");
          return undefined;
        },
        submission: async (_by, ref) => ref.id === "dirty"
          ? { title: `t\u009b2J \u202eevil\u2066 \u200bzero ${"T".repeat(500)} key ${KEY}`, lines: Array.from({ length: 20 }, (_, i) => `line ${i}\u2028${"x".repeat(397)}\ud83d\ude00${"y".repeat(500)}`), untrusted: true }
          : { title: "Diff", lines: [], untrusted: false },
      };
      const replay = ReplayService.withEpoch(spy.storage, projects.epoch, ActivityService.withEpoch(spy.storage, projects.epoch, options), { resolvers }, options);
      const got = await replay.links(reader, task, 1);
      const res = (id: string) => got.items.find((i) => i.id === id)!.resolution;
      assert.deepEqual(seen.sort(), [`${reader.id}:m-forbidden:${task}`, `${reader.id}:m-other:${task}`, `${reader.id}:m1:${task}`], "the reader's own identity is what is asked with");
      assert.equal(res("m1").state, "readable");
      assert.equal(res("m-other").state, "not-readable");
      assert.equal(res("m-forbidden").state, "not-readable");
      assert.deepEqual(JSON.stringify(res("m-other")), JSON.stringify(res("m-forbidden")), "unreadable reads exactly like gone");
      assert.equal(res("no-reader").state, "no-reader");
      assert.equal(res("c").state, "no-reader", "a kind named like an object's own member is not a reader");
      const dirty = res("dirty") as unknown as { state: "readable"; title: string; lines: string[] };
      assert.ok(dirty.title.length <= LINK_LIMITS.title && !new RegExp("[\\u0080-\\u009f]").test(dirty.title) && !dirty.title.includes(KEY), dirty.title);
      assert.equal(dirty.lines.length, LINK_LIMITS.lines);
      assert.ok(dirty.lines.every((l) => l.length <= LINK_LIMITS.line && !new RegExp("[\\u2028\\n]").test(l)));
      assert.ok(!new RegExp("[\\u202a-\\u202e\\u2066-\\u2069\\u200b]").test(dirty.title), `no direction-changing or invisible character: ${JSON.stringify(dirty.title.slice(0, 30))}`);
      assert.ok(dirty.lines.every((l) => !new RegExp("[\\ud800-\\udbff]$").test(l)), "a cut never leaves half a character");
      // Another project's agent, even with every history right there, reads nothing of this task through the links, and no resolver is asked.
      const stranger = await make("zed", [{ action: "history.read", project: (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "B" })).id }]);
      const asked = seen.length;
      await assert.rejects(() => replay.links(stranger, task, 1), (e: unknown) => e instanceof DomainError && (e.code === "forbidden" || e.code === "not_found"));
      assert.equal(seen.length, asked);
      assert.deepEqual(spy.calls(), [], "resolving links writes nothing");
      // A kind with no resolvers at all is a reference, never a guess.
      const bare = ReplayService.withEpoch(w.storage, projects.epoch, svc, {}, options);
      assert.ok((await bare.links(owner, task, 1)).items.every((i) => i.resolution.state === "no-reader"));
      // The number of links is bounded and says so.
      for (let i = 0; i < 3; i++) await svc.record(owner, { commandId: cid("m"), taskId: task, kind: "instruction", summary: "many", manifest: { refs: Array.from({ length: 20 }, (_, k) => ({ kind: "agent-message", id: `bulk-${i}-${k}` })) } } as never);
      const many = await replay.links(owner, task, 4);
      assert.ok(many.items.length <= LINK_LIMITS.links);
      await refuses("not_found", () => replay.links(owner, task, 99));
      await refuses("not_found", () => replay.links(reader, "task-aaaaaaaaaaaaaaaaaaaa", 1));
    } finally { await w.close(); }
  });

  test(`${backend.name}: a rerun is refused inside the replay and runs only as the owner's simulation: isolated, labelled, with an injected failure, and no step, effect or other record is written (card U09b)`, async () => {
    const { w, projects, owner, make, project, task } = await world(backend);
    try {
      const ann = await make("ann", [{ action: "attempt.work", project }]);
      const svc = ActivityService.withEpoch(w.storage, projects.epoch, options);
      const kinds = ["instruction", "model-selected", "tool-call", "agent-message", "compression", "tool-call"] as const;
      for (const k of kinds) await svc.record(owner, { commandId: cid("r"), taskId: task, kind: k, summary: `a ${k} with text`, outcome: "confirmed" } as never);
      const before = await svc.steps(owner, task);
      const spy = counting(w.storage);
      const sim = ReplaySimulationService.withEpoch(spy.storage, projects.epoch, ActivityService.withEpoch(spy.storage, projects.epoch, options), options);
      const replay = ReplayService.withEpoch(w.storage, projects.epoch, svc, {}, options);
      await refuses("forbidden", () => replay.rerun());
      await refuses("forbidden", () => sim.simulate(ann, { commandId: cid("s"), taskId: task }));
      await refuses("not_found", () => sim.simulate(owner, { commandId: cid("s"), taskId: "task-aaaaaaaaaaaaaaaaaaaa" }));
      for (const bad of [{ from: 0 }, { from: 1.5 }, { failAt: 99 }, { from: 4, failAt: 2 }, { failAt: "3" }]) await refuses("invalid_command", () => sim.simulate(owner, { commandId: cid("s"), taskId: task, ...bad } as never));
      await refuses("invalid_command", () => sim.simulate(owner, { commandId: cid("s"), taskId: task, extra: 1 } as never));
      assert.deepEqual(spy.calls(), [], "a refused simulation wrote nothing");
      const one = await sim.simulate(owner, { commandId: "sim-1", taskId: task, failAt: 3 });
      assert.equal(one.simulation.label, SIMULATION_LABEL);
      assert.deepEqual(one.simulation.scope, { kind: "simulation", isolated: true, tools: 0, providers: 0, effects: 0 });
      assert.deepEqual(one.simulation.steps.map((s) => [s.seq, s.simulatedOutcome, s.simulated]), [[1, "as-recorded", true], [2, "as-recorded", true], [3, "failed-injected", true], [4, "not-reached", true], [5, "not-reached", true], [6, "not-reached", true]]);
      assert.equal(one.simulation.steps[3]!.would, "not be reached after the injected failure");
      assert.equal(one.simulation.steps[0]!.would, "be given the instruction again");
      // The only thing written is the simulation's own record; the task's steps are as they were.
      assert.ok(spy.calls().length > 0 && new Set(spy.calls()).size === 1, `one kind of write, the simulation's own record: ${JSON.stringify(spy.calls())}`);
      assert.deepEqual(await svc.steps(owner, task), before);
      const again = await sim.simulate(owner, { commandId: "sim-1", taskId: task, failAt: 3 });
      assert.deepEqual([again.replayed, again.id], [true, one.id]);
      await refuses("command_conflict", () => sim.simulate(owner, { commandId: "sim-1", taskId: task, failAt: 4 }));
      const got = await sim.get(owner, one.id);
      assert.deepEqual(got.simulation.steps.length, 6);
      await refuses("not_found", () => sim.get(ann, one.id));
      await refuses("not_found", () => sim.get(owner, "sim-aaaaaaaaaaaaaaaaaaaa"));
      // From a step on, and the walk is bounded.
      const late = await sim.simulate(owner, { commandId: cid("s"), taskId: task, from: 5 });
      assert.deepEqual(late.simulation.steps.map((s) => s.seq), [5, 6]);
      assert.equal(SIMULATION_LIMITS.steps, 200);
    } finally { await w.close(); }
  });

  test(`${backend.name}: the simulation walks at most 200 recorded steps and says it was cut short (card U09b)`, async () => {
    const { w, projects, owner, task } = await world(backend);
    try {
      const svc = ActivityService.withEpoch(w.storage, projects.epoch, options);
      for (let i = 0; i < 205; i++) await svc.record(owner, { commandId: cid("r"), taskId: task, kind: "tool-call", summary: `call ${i}`, outcome: i % 2 === 0 ? "confirmed" : "failed" } as never);
      const sim = ReplaySimulationService.withEpoch(w.storage, projects.epoch, svc, options);
      const all = await sim.simulate(owner, { commandId: cid("s"), taskId: task });
      assert.equal(all.simulation.steps.length, SIMULATION_LIMITS.steps);
      assert.equal(all.simulation.truncated, true);
      assert.deepEqual([all.simulation.steps[0]!.seq, all.simulation.steps.at(-1)!.seq, all.simulation.steps[1]!.recordedOutcome], [1, 200, "failed"]);
      await refuses("invalid_command", () => sim.simulate(owner, { commandId: cid("s"), taskId: task, failAt: 203 }));
      const tail = await sim.simulate(owner, { commandId: cid("s"), taskId: task, from: 201, failAt: 203 });
      assert.deepEqual([tail.simulation.steps.map((s) => s.simulatedOutcome), tail.simulation.truncated], [["as-recorded", "as-recorded", "failed-injected", "not-reached", "not-reached"], false]);
    } finally { await w.close(); }
  });
}

test("a recorded step with a missing or odd field never stops the simulation's walk, and a page that does not move forward ends it (card U09b)", async () => {
  const w = await backends[0]!.open();
  try {
    const projects = await ProjectService.open(w.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(w.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
    const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
    let reads = 0;
    const odd = { steps: async () => { reads++; return { steps: [
      { seq: 1, kind: "tool-call", summary: "fine", outcome: "confirmed" }, { seq: 2 }, { seq: 3, kind: "constructor", summary: 7, outcome: { x: 1 } }, { seq: 4, kind: null, summary: null }, null, { unavailable: "gone", seq: 5 }, { seq: "6" },
      { seq: 7, kind: "x".repeat(500), summary: `secret ${KEY}`, outcome: "y".repeat(500) },
    ], next: 0 }; } } as never;
    const sim = ReplaySimulationService.withEpoch(w.storage, projects.epoch, odd, options);
    const got = await sim.simulate(owner, { commandId: cid("s"), taskId: task, failAt: 3 });
    assert.equal(reads, 1, "a page that does not move forward is read once");
    assert.deepEqual(got.simulation.steps.map((s) => [s.seq, s.kind, s.simulatedOutcome]), [[1, "tool-call", "as-recorded"], [2, "unknown", "as-recorded"], [3, "constructor", "failed-injected"], [4, "unknown", "not-reached"], [7, "x".repeat(40), "not-reached"]]);
    assert.equal(got.simulation.steps[1]!.would, "do it again");
    assert.deepEqual([got.simulation.steps[1]!.summary, got.simulation.steps[1]!.recordedOutcome], ["", "not-recorded"]);
    assert.ok(!JSON.stringify(got.simulation).includes(KEY), "a summary is redacted again");
    assert.ok(got.simulation.steps.every((s) => typeof s.would === "string" && s.recordedOutcome.length <= 20));
  } finally { await w.close(); }
});

test("the readers behind the links ask the record's own service, as the reader, and never show a record of another task or a diff's lines (card U09b)", async () => {
  const task = { projectId: "proj-a", taskId: "task-aaaaaaaaaaaaaaaaaaaa" };
  const other = "task-bbbbbbbbbbbbbbbbbbbb";
  const asked: string[] = [];
  const reader = { id: "agent:ann", kind: "agent", name: "ann", grants: [] } as unknown as Principal;
  const r = replayResolvers({
    messages: { get: async (v, id) => { asked.push(`m:${v.id}:${id}`); return id === "m-other" ? { taskId: other, sender: "a", to: "b", kind: "k", class: "normal", state: "delivered", purpose: "p", text: "t" } : id === "m1" ? { taskId: task.taskId, sender: "agent:ann", to: "agent:bea", kind: "k", class: "normal", state: "delivered", purpose: "ask", text: "hello" } : undefined; } },
    submissions: { get: async (_b, id) => id === "code" ? { taskId: task.taskId, kind: "code", role: "worker", submittedBy: "agent:ann", base: "a".repeat(40), tree: "b".repeat(40), patchId: "p1", evidence: [{ check: "unit", result: "pass" }] } : id === "review" ? { taskId: task.taskId, kind: "review", role: "reviewer", submittedBy: "agent:bea", subject: "sbm-x", verdict: "changes", report: "rename the helper", evidence: [] } : id === "elsewhere" ? { taskId: other, kind: "qa", role: "qa", submittedBy: "x", evidence: [] } : undefined },
    reviews: { get: async (_b, id) => id === "rv-other" ? { binding: { taskId: other, requester: "agent:ann" }, operation: { name: "tool.push" }, state: "allowed" } : id === "rv" ? { binding: { taskId: task.taskId, requester: "agent:ann" }, operation: { name: "tool.push" }, state: "allowed", decidedBy: "owner", reason: "fine" } : undefined },
    artifacts: { get: async (id) => id === "art" ? { name: "notes", taskId: task.taskId, projectId: task.projectId, entries: [{}, {}], totalBytes: 10, createdBy: "agent:ann" } : id === "art-p" ? { name: "n", taskId: task.taskId, projectId: "proj-z", entries: [], totalBytes: 0, createdBy: "x" } : undefined },
    branches: { view: async (_v, id) => id === "br" ? { branch: { taskId: task.taskId, purpose: "check the cache", state: "active", owner: "agent:ann", openedAt: "t" }, counts: { parent: 3, branch: 1 } } : undefined },
  });
  const get = (kind: string, id: string) => r[kind]!(reader, { id }, task);
  assert.equal((await get("agent-message", "m1"))!.untrusted, true);
  assert.equal(await get("agent-message", "m-other"), undefined, "another task's message is not shown through this task");
  assert.deepEqual(asked, ["m:agent:ann:m1", "m:agent:ann:m-other"]);
  const diff = (await get("submission", "code"))!;
  assert.match(diff.title, /^Diff of a code submission/);
  assert.ok(diff.lines[0]!.includes("a".repeat(40)) && diff.lines[1]!.includes("not copied"), diff.lines.join("|"));
  assert.equal(diff.untrusted, false);
  const comment = (await get("submission", "review"))!;
  assert.deepEqual([comment.title, comment.untrusted, comment.lines.includes("rename the helper")], ["Comment: review by agent:bea (reviewer), changes", true, true]);
  assert.equal(await get("submission", "elsewhere"), undefined);
  assert.match((await get("review", "rv"))!.title, /Approval request for tool.push by agent:ann: allowed/);
  assert.equal(await get("review", "rv-other"), undefined, "another task's approval is not shown through this task");
  const ownerP = { id: "owner", kind: "owner", name: "rob", grants: [] } as unknown as Principal;
  assert.match((await r["artifact"]!(ownerP, { id: "art" }, task))!.lines[0]!, /2 files, 10 bytes/);
  assert.equal(await r["artifact"]!(ownerP, { id: "art-p" }, task), undefined, "another project's artifact");
  assert.match((await get("context-branch", "br"))!.title, /Side line of work \(active\)/);
  // The owner and a service may read an artifact's metadata; an agent needs the task's read right.
  assert.equal(await r["artifact"]!({ id: "agent:zed", kind: "agent", name: "zed", grants: [] } as unknown as Principal, { id: "art" }, task), undefined);
  // A source that is not composed offers no reader at all.
  assert.deepEqual(Object.keys(replayResolvers({})), []);
});

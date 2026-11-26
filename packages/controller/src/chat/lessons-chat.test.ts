import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OPERATIONS } from "../api/operations.js";
import { BlockerService } from "../domain/blockers.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { LessonService } from "../lessons/index.js";
import { StatusService, STATUS_KINDS } from "../status/index.js";
import { CHAT_OPS } from "./commands.js";
import { ModelInterpreter, promptAbout } from "./model-interpreter.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

// Card B03: the owner asks in any words what the team learnt, records a lesson and judges one by chat; nothing needs a fixed phrase.

after(stopServer);

const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

test("the interpreter prompt describes the lessons view, proposing and judging a lesson, from the one status-kind and operation tables (card B03)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "what have we learnt", quoted: [], focus: {}, proposals: [] });
  const kind = STATUS_KINDS["lessons"]!;
  assert.ok(system.includes(`lessons(${kind.keys.join(", ")}) - ${promptAbout(kind.about)}`), "the view is listed from the one table");
  assert.ok(system.includes("lesson.decide(lessonId, expectedRevision, to, finding"), "the decision is listed with the arguments the chat takes");
  assert.ok(system.includes("lesson.propose(projectId, title, statement, applicability, evidence"), "proposing is listed too");
  assert.match(system, /what have we learnt in Garden\?/);
  assert.match(system, /lesson\.decide with the lessonId shown there \(its revision is filled in\)/);
  assert.equal(CHAT_OPS["lesson.decide"]?.revision, "lesson");
  for (const op of ["lesson.propose", "lesson.evidence", "lesson.decide", "lesson.get", "lesson.list"]) assert.ok(OPERATIONS.some((o) => o.name === op), op);
  assert.ok(!Object.keys(CHAT_OPS).includes("lesson.evidence"), "evidence is added by agents, the owner cites it when proposing");
});

for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>, lessons: LessonService, status: StatusService) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      let lessons: LessonService | undefined;
      const w = await openWorld(backend, script, undefined, (storage, epoch) => { lessons = LessonService.withEpoch(storage, epoch, options); return { lessons }; });
      try {
        const epoch = w.projects.epoch;
        const status = StatusService.withEpoch(w.world.storage, epoch, { assignments: w.assignments, waits: WaitService.withEpoch(w.world.storage, epoch, w.assignments, options), blockers: BlockerService.withEpoch(w.world.storage, epoch, options), contracts: w.contracts, lessons: lessons! }, options);
        await body(w, script, lessons!, status);
      } finally { await w.close(); }
    });

  suite("the owner records a lesson in free words, asks what the team learnt, judges a lesson by chat with the revision filled in, and a stranger sees nothing", async (w, script, lessons, status) => {
    const a = await w.project("Garden");
    const task = await w.task(a, "Build login");
    const runner = new CommandRunner(w.world.storage, w.projects.epoch, options);
    const sbm = derivedId("sbm", cid("s"));
    await runner.command("test.put", { commandId: cid("put"), actor: w.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "submission", id: sbm }, creates: true, changes: [{ type: "create" as const, ref: { kind: "submission", id: sbm }, body: { projectId: a, taskId: task, kind: "review", submittedBy: "agent:dev" } as never }], detail: {} }) }));
    const dev = await w.agent("dev", [{ action: "meeting.agenda", project: a }, { action: "task.read", project: a }]);
    const proposed = await lessons.propose(dev.principal, { commandId: cid("l"), projectId: a, title: "Error paths need tests", statement: "Reviews send back handlers without error-path tests.", applicability: "request handlers", evidence: [{ kind: "submission", id: sbm }] });
    const chat = w.chat({ status });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });

    let text = `remember that small PRs get reviewed faster, for every change, see ${sbm}`;
    script[text] = [cmd("lesson.propose", { title: "Small PRs", statement: "small PRs get reviewed faster", applicability: "every change", evidence: [{ kind: "submission", id: sbm }] }, text)];
    let o = (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes[0]!;
    assert.deepEqual([o.status, o.op], ["applied", "lesson.propose"], JSON.stringify(o));

    for (const t of ["what have we learnt in Garden?", "which lessons are still candidates"]) {
      script[t] = [ask({ kind: "lessons", ...(t.includes("candidates") ? { lessonStatus: "candidate" } : {}) }, t)];
      o = (await chat.submit(w.ownerToken, { messageId: cid("m"), text: t })).outcomes[0]!;
      assert.equal(o.status, "answered", JSON.stringify(o));
      const said = o.lines!.map((l) => l.text).join("\n");
      assert.match(said, /2 (current|candidate) lesson\(s\), oldest first/);
      assert.match(said, /candidate, version 1: "Error paths need tests": Reviews send back handlers without error-path tests\. Applies when: request handlers\. Evidence: 1 independent, 0 derived\./);
      assert.match(said, /"Small PRs"/);
      assert.ok(o.lines!.every((l) => l.cites.length > 0), "every line cites a record");
    }

    text = `the error path lesson holds, we saw it three times (${proposed.id})`;
    script[text] = [cmd("lesson.decide", { lessonId: proposed.id, to: "accepted", finding: "we saw it three times" }, text)];
    o = (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes[0]!;
    assert.deepEqual([o.status, o.op], ["applied", "lesson.decide"], JSON.stringify(o));
    const got = (await lessons.get(w.owner, proposed.id))!;
    assert.deepEqual([got.status, got.finding, got.outcomePending, got.revision], ["accepted", "we saw it three times", true, 2]);
    const view = (await chat.submit(w.ownerToken, { messageId: cid("m"), text: "what have we learnt in Garden?" })).outcomes[0]!.lines!.map((l) => l.text).join("\n");
    assert.match(view, /accepted, version 1: "Error paths need tests".* Finding: we saw it three times Not yet told to agent:dev\./);

    // An agent with no meeting right sees no list; the proposer reads its own lesson.
    const far = await w.agent("far", [{ action: "task.read", project: a }]);
    const listed = await w.api.handle(far.token, { v: 1, op: "lesson.list", args: { projectId: a } } as never) as { ok: boolean; error?: { code: string } };
    assert.deepEqual([listed.ok, listed.error?.code], [false, "not_found"]);
    const mine = await w.api.handle(dev.token, { v: 1, op: "lesson.get", args: { lessonId: proposed.id } } as never) as { ok: boolean; result?: { item: { status: string } } };
    assert.deepEqual([mine.ok, mine.result?.item.status], [true, "accepted"]);
  });
}

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { requestId } from "@nimblenewt/contracts";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { DomainError, GenerationRefused, HistoryService, type RefusalReason } from "@nimblenewt/controller";
import { backends, stopServer } from "@nimblenewt/controller/testing";
import { InvalidBranchPointError, NoBranchPointError, turnBoundaries, type AdapterTool, type PiAdapter } from "@nimblenewt/pi-adapter";
import { Mirror, Outside, PiHome, cid, openWorld, provider, type Provider, type World } from "./g09-fixture.js";

// Card G09: retained-context inquiry and mid-generation interruption, proved by running the production C05 (retained context branches), L05 (generation interruption), H04 (inquiries) and
// C04 (continuation) services together with the production Pi adapter (F06b/F06c/F06d) over durable storage and the scripted offline provider. The evidence record is
// docs/nimblenewt/implementation-plan/g09-evidence.md.

after(stopServer);

const SENTINEL = "TOOL-SENTINEL-42";
const echo: AdapterTool = { name: "echo", description: "Returns the sentinel", parameters: Type.Object({}), execute: async () => SENTINEL };
const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;
const done = async (handle: { result(): Promise<{ status: string }> }, status = "completed") => { const r = await handle.result(); assert.equal(r.status, status, JSON.stringify(r)); };

/** The parent task from the first scenario: one turn with a tool call, then a final answer. Leaves the conversation at a boundary. */
async function finishedTask(p: Provider, adapter: PiAdapter) {
  p.script(() => fauxAssistantMessage(fauxToolCall("echo", {}, { id: "t1" }), { stopReason: "toolUse" }), () => fauxAssistantMessage("task answer"));
  await done(await adapter.root().submit(input(cid("task"), "do the task")));
}
/** Pi sends an empty system prompt first; it is part of the exact manifest. */
const SYS = "system: ";
const TASK_MANIFEST = [SYS, "user: do the task", "assistant: <call echo>", `toolResult: ${SENTINEL}`, "assistant: task answer"];

const refusedFor = async (reason: RefusalReason, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof GenerationRefused, String(error)); assert.equal(error.reason, reason, (error as Error).message); return true; });
};

/** The H04 inquiry and the C05 branch opened for it, and the Pi fork the branch's request ID names: one inquiry, three records of it. */
async function openInquiry(w: World, adapter: PiAdapter, question: string, mirror: Mirror) {
  await mirror.sync(adapter);
  const branches = w.branches();
  const asked = await w.inquiries.ask(w.ann, { commandId: cid("ask"), taskId: w.task, to: "agent:ben", question });
  const opened = await branches.open(w.ann, { commandId: cid("open"), taskId: w.task, purpose: question, inquiryId: asked.id });
  const fork = await adapter.root().branch({ requestId: requestId(opened.id) });
  return { branches, inquiryId: asked.id, branchId: opened.id, throughSeq: opened.throughSeq, fork };
}

for (const backend of backends) {
  const scenario = (name: string, body: (w: World, home: PiHome) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const w = await openWorld(backend);
      const home = new PiHome();
      try { await body(w, home); } finally { await home.dispose(); await w.close(); }
    });

  scenario("an inquiry sees the original current context exactly, leaves the parent unpolluted, and an unchanged resume continues from that context only", async (w, home) => {
    const p = provider("offline", "scripted");
    const adapter = await home.open(p, [echo]);
    const parent = adapter.root();
    const mirror = new Mirror(w, w.task);
    await finishedTask(p, adapter);
    await mirror.sync(adapter);
    const parentBefore = JSON.stringify([await parent.transcript(), await w.histories.read(w.owner, HistoryService.taskScopeId(w.task), { limit: 50, taskId: w.task }), await w.assignments.getAssignment(w.task)]);

    const q = await openInquiry(w, adapter, "How is it going?", mirror);
    // The controller's branch and the adapter's fork stand at the same boundary: the controller's inherited history is exactly the parent's text, and the adapter forked at the last entry.
    assert.equal(q.throughSeq, 2);
    assert.deepEqual((await q.branches.history(w.ann, q.branchId, { part: "parent", limit: 50 }))!.entries.map((e) => e.text), ["user: do the task", "assistant: task answer"]);
    assert.equal(q.fork.forkedAt, (await parent.transcript()).at(-1)!.id);

    // The inquiry is answered by the model from the retained context: it was handed exactly the parent's context plus the question.
    p.answers("About half way: the tool ran and the answer is written.");
    const answer = await (await q.fork.conversation.submit(input(cid("ask"), "How is it going?"))).result();
    assert.equal(answer.status, "completed");
    assert.deepEqual(p.seen.at(-1), [...TASK_MANIFEST, "user: How is it going?"]);
    await q.branches.append(w.ann, { commandId: cid("q"), branchId: q.branchId, text: "How is it going?" });
    await q.branches.append(w.ann, { commandId: cid("a"), branchId: q.branchId, text: "About half way: the tool ran and the answer is written." });
    await w.inquiries.answer(w.ben, { commandId: cid("ans"), inquiryId: q.inquiryId, answer: "About half way." });
    const view = (await w.inquiries.view(w.ann, q.inquiryId))!;
    assert.deepEqual([view.inquiry.state, view.generationUnchanged], ["answered", true]);

    // The parent is exactly as it was: transcript, task history, assignment; the branch's own entries are the branch's only.
    const parentAfter = JSON.stringify([await parent.transcript(), await w.histories.read(w.owner, HistoryService.taskScopeId(w.task), { limit: 50, taskId: w.task }), await w.assignments.getAssignment(w.task)]);
    assert.equal(parentAfter, parentBefore, "the inquiry changed the parent");
    assert.deepEqual((await q.branches.history(w.ann, q.branchId, { part: "branch", limit: 50 }))!.entries.map((e) => e.text), ["How is it going?", "About half way: the tool ran and the answer is written."]);

    // An unchanged resume: no update was selected, the parent goes back with its original context, and its next request carries nothing of the inquiry.
    const v = (await q.branches.view(w.ann, q.branchId))!;
    assert.deepEqual([v.updates.length, v.branch.updateRevision], [0, 0]);
    const resumed = await q.branches.resume(w.ann, { commandId: cid("rsm"), branchId: q.branchId, expectedRevision: v.branch.revision });
    assert.equal(resumed.returnedTo.taskId, w.task);
    p.answers("carrying on");
    await done(await parent.submit(input(cid("go"), "carry on")));
    assert.deepEqual(p.seen.at(-1), [...TASK_MANIFEST, "user: carry on"], "the parent's next request is its original context plus the new instruction, exactly");
    assert.equal((await parent.transcript()).filter((e) => e.kind === "nimblenewt.update").length, 0);
    // The adapter refuses to fork inside a turn: the branch point is always a boundary the task has finished.
    await assert.rejects(parent.branch({ requestId: requestId(cid("bad")), at: (await parent.transcript())[0]!.id }), InvalidBranchPointError);
  });

  scenario("an updated resume applies the selected update once, with provenance, and a corrected old owner decision replaces what the parent acts on", async (w, home) => {
    const p = provider("offline", "scripted");
    const adapter = await home.open(p, [echo]);
    const parent = adapter.root();
    const mirror = new Mirror(w, w.task);
    p.answers("started on plan A");
    await done(await parent.submit(input(cid("t1"), "start the work")));
    // The owner's decision (plan A) is part of the task's context, placed without asking the model anything.
    const decisionA = await w.desks.write(w.ann, { commandId: cid("d"), projectId: w.a, kind: "decision", title: "Plan", body: "Owner decision: use plan A.", visibility: "shared", status: "accepted" } as never);
    const placed = await (await parent.submit({ kind: "update", requestId: requestId(cid("place")), content: "Owner decision: use plan A.", run: false })).result();
    assert.equal(placed.status, "placed");
    p.script();
    const q = await openInquiry(w, adapter, "Which plan are we on?", mirror);
    p.answers("Plan A.");
    await done(await q.fork.conversation.submit(input(cid("ask"), "Which plan are we on?")));
    assert.deepEqual(p.seen.at(-1), [SYS, "user: start the work", "assistant: started on plan A", "user: Owner decision: use plan A.", "user: Which plan are we on?"]);

    // Decision A was selected into the branch too. The owner then corrects it while the inquiry is open: the branch shows its copy of A as changed, and the correction is selected and applied once.
    let v = (await q.branches.view(w.ann, q.branchId))!;
    await q.branches.applyUpdates(w.ann, { commandId: cid("upd"), branchId: q.branchId, expectedRevision: v.branch.revision, updates: [{ kind: "desk-record", id: decisionA.id }] });
    const decisionB = await w.desks.write(w.ann, { commandId: cid("d"), projectId: w.a, kind: "decision", title: "Plan", body: "Owner correction: plan A is withdrawn, use plan B.", visibility: "shared", status: "accepted", supersedes: decisionA.id } as never);
    v = (await q.branches.view(w.ann, q.branchId))!;
    assert.deepEqual(v.updates.map((u) => [u.state, u.text]), [["changed", "Owner decision: use plan A."]], "the branch's copy of the corrected original is shown as changed");
    const cmd = cid("upd");
    const select = [{ kind: "desk-record" as const, id: decisionB.id }];
    const applied = await q.branches.applyUpdates(w.ann, { commandId: cmd, branchId: q.branchId, expectedRevision: v.branch.revision, updates: select });
    const again = await q.branches.applyUpdates(w.ann, { commandId: cmd, branchId: q.branchId, expectedRevision: v.branch.revision, updates: select });
    assert.deepEqual([applied.replayed, again.replayed, again.revision], [false, true, applied.revision]);
    v = (await q.branches.view(w.ann, q.branchId))!;
    assert.deepEqual(v.updates.map((u) => [u.revision, u.state, u.text]).sort(), [[1, "changed", "Owner decision: use plan A."], [2, "current", "Owner correction: plan A is withdrawn, use plan B."]]);
    const correction = v.updates.find((u) => u.revision === 2)!.text!;
    await assert.rejects(q.branches.applyUpdates(w.ann, { commandId: cid("upd"), branchId: q.branchId, expectedRevision: v.branch.revision, updates: select }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");

    // Resume with the update: the parent receives the correction once, with the branch entry it came from, and acts on it. A repeat of the submission does not ask the model again.
    const answerEntry = (await q.fork.conversation.transcript()).at(-1)!;
    await q.branches.resume(w.ann, { commandId: cid("rsm"), branchId: q.branchId, expectedRevision: v.branch.revision });
    p.answers("switching to plan B");
    const update = { kind: "update", requestId: requestId(cid("upd-run")), content: correction, source: { conversationId: q.fork.conversation.id, entryId: answerEntry.id } } as const;
    const first = await parent.submit(update);
    const second = await parent.submit(update);
    assert.equal(second.submissionId, first.submissionId);
    await done(first);
    assert.deepEqual(p.seen.at(-1), [
      SYS, "user: start the work", "assistant: started on plan A", "user: Owner decision: use plan A.", "user: Owner correction: plan A is withdrawn, use plan B.",
    ], "the parent sees its context, the old decision and then the correction, and nothing of the inquiry");
    assert.equal(p.seen.length, 3, "the model was asked once for the first turn, once for the inquiry and once for the update");
    const updates = (await parent.transcript()).filter((e) => e.kind === "nimblenewt.update");
    assert.deepEqual(updates.map((e) => e.data), [{ source: null, run: false }, { source: { conversationId: q.fork.conversation.id, entryId: answerEntry.id }, run: true }]);
    assert.ok(!JSON.stringify(p.seen.at(-1)).includes("Plan A."), "the inquiry answer did not reach the parent");

    // The correction also fences generation (L05): a response begun on the old decision cannot act after the owner's correction.
    const gen = w.generation();
    const oldRun = await gen.begin(w.ann, { commandId: cid("begin"), taskId: w.task, contextRevision: 1 });
    await gen.record(w.ann, { commandId: cid("c"), runId: oldRun.id, seq: 1, toolCall: { id: "c1", name: "push", argumentsDelta: '{"ref":"plan-a"}', done: true } });
    const corrected = await gen.correct(w.mgr, { commandId: cid("corr"), taskId: w.task, expectedContextRevision: 1, reason: "owner corrected the plan decision" });
    assert.equal(corrected.contextRevision, 2);
    await refusedFor("interrupted", () => gen.admitEffect(w.ann, { commandId: cid("adm"), runId: oldRun.id, toolCallId: "c1", kind: "git-push", target: "repo:plan-a" }));
    await refusedFor("stale", () => gen.begin(w.ann, { commandId: cid("begin"), taskId: w.task, contextRevision: 1 }));
    const newRun = await gen.begin(w.ann, { commandId: cid("begin"), taskId: w.task, contextRevision: 2 });
    assert.equal((await gen.view(w.ann, newRun.id))!.current, true);
  });

  scenario("a correction landing between a complete tool call and its execution stops it, and a pause holds a complete call until it is readmitted on purpose", async (w, home) => {
    const outside = new Outside();
    const gen = w.generation();
    const state: { run?: string; seq: number; reached?: () => void; hold: Promise<void> | undefined; refusals: string[] } = { seq: 1, hold: undefined, refusals: [] };
    // The adapter tool is the controller's gate: the call is recorded as complete, then admitted and executed only through the generation service.
    const push: AdapterTool = {
      name: "push", description: "Pushes a branch", parameters: Type.Object({ ref: Type.String() }),
      execute: async (args, { callId }) => {
        const { ref } = args as { ref: string };
        await gen.record(w.ann, { commandId: cid("rec"), runId: state.run!, seq: state.seq++, toolCall: { id: callId, name: "push", argumentsDelta: JSON.stringify(args), done: true } });
        // The model's response has ended with this call: the controller closes the generation before anything is admitted.
        await gen.complete(w.ann, { commandId: cid("fin"), runId: state.run! });
        state.reached?.();
        await state.hold;
        try {
          await gen.admitEffect(w.ann, { commandId: cid("adm"), runId: state.run!, toolCallId: callId, kind: "git-push", target: `repo:${ref}` });
          return `pushed ${ref}: ${(await gen.execute(w.ann, { runId: state.run!, toolCallId: callId }, outside.bridge())).status}`;
        } catch (error) {
          if (!(error instanceof GenerationRefused)) throw error;
          state.refusals.push(error.reason);
          return `refused: ${error.reason}`;
        }
      },
    };
    const p = provider("offline", "scripted");
    const adapter = await home.open(p, [push]);
    const parent = adapter.root();

    // (a) The response is complete and the tool call is recorded as complete. The owner corrects the decision before the action is admitted.
    const run = (await gen.begin(w.ann, { commandId: cid("begin"), taskId: w.task, contextRevision: 1 })).id;
    state.run = run;
    const reached = new Promise<void>((resolve) => { state.reached = resolve; });
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => { release = resolve; });
    p.script(() => fauxAssistantMessage(fauxToolCall("push", { ref: "plan-a" }, { id: "p1" }), { stopReason: "toolUse" }), () => fauxAssistantMessage("could not push; waiting for the corrected plan"));
    const running = await parent.submit(input(cid("go"), "push plan A"));
    await reached;
    assert.equal((await gen.view(w.ann, run))!.run.toolCalls[0]!.state, "complete");
    await gen.correct(w.mgr, { commandId: cid("corr"), taskId: w.task, expectedContextRevision: 1, reason: "owner corrected: plan B" });
    release();
    const result = await running.result();
    assert.equal(result.status, "completed");
    assert.deepEqual(state.refusals, ["interrupted"]);
    assert.equal(outside.executions.length, 0, "the stale action reached the outside world");
    assert.equal((await gen.view(w.ann, run))!.run.toolCalls[0]!.effectId, undefined);
    assert.deepEqual(p.seen.at(-1)!.slice(-1), ["toolResult: refused: interrupted"]);
    // What the old response still delivers is late and not applied; a pause is explicit, so release it, and the corrected generation then acts on the corrected decision.
    assert.deepEqual(await gen.complete(w.ann, { commandId: cid("fin"), runId: run }), { state: "interrupted", late: true, replayed: false });
    assert.equal((await gen.view(w.ann, run))!.run.lateCount, 1);
    const run2 = (await gen.begin(w.ann, { commandId: cid("begin"), taskId: w.task, contextRevision: 2 })).id;
    state.run = run2; state.seq = 1; state.hold = undefined;
    p.script(() => fauxAssistantMessage(fauxToolCall("push", { ref: "plan-b" }, { id: "p2" }), { stopReason: "toolUse" }), () => fauxAssistantMessage("pushed plan B"));
    await done(await parent.submit(input(cid("go2"), "push the corrected plan")));
    assert.equal(outside.executions.length, 1, JSON.stringify([state.refusals, (await gen.view(w.ann, run2))!.run]));
    assert.equal((await gen.view(w.ann, run2))!.run.toolCalls[0]!.state, "admitted");
    assert.deepEqual([(await gen.view(w.ann, run2))!.run.state, (await gen.view(w.ann, run2))!.current], ["finished", true]);

    // (c) A pause (finish and hold) after a complete response: the call is held, nothing is admitted until the pause is lifted and the call is admitted again on purpose.
    const run3 = (await gen.begin(w.ann, { commandId: cid("begin"), taskId: w.task, contextRevision: 2 })).id;
    await gen.record(w.ann, { commandId: cid("c"), runId: run3, seq: 1, toolCall: { id: "p3", name: "push", argumentsDelta: '{"ref":"plan-b2"}', done: true } });
    await gen.complete(w.ann, { commandId: cid("fin"), runId: run3 });
    await gen.interrupt(w.mgr, { commandId: cid("int"), taskId: w.task, mode: "finish_and_hold", reason: "pause for review" });
    const admit3 = () => gen.admitEffect(w.ann, { commandId: cid("adm"), runId: run3, toolCallId: "p3", kind: "git-push", target: "repo:plan-b2" });
    await refusedFor("held", admit3);
    await gen.release(w.mgr, { commandId: cid("rel"), taskId: w.task, reason: "reviewed" });
    assert.equal((await gen.view(w.ann, run3))!.run.toolCalls[0]!.state, "held", "lifting the pause admits nothing by itself");
    assert.equal(outside.executions.length, 1);
    await admit3();
    assert.equal((await gen.execute(w.ann, { runId: run3, toolCallId: "p3" }, outside.bridge())).status, "confirmed");
    assert.equal(outside.executions.length, 2);
  });

  scenario("a stream cut in the middle of a tool call's arguments cannot be admitted, executed, branched from or seen by the next request", async (w, home) => {
    const outside = new Outside();
    let executions = 0;
    const danger: AdapterTool = { name: "push", description: "Pushes a branch", parameters: Type.Object({ payload: Type.String() }), execute: async () => { executions += 1; return "ran"; } };
    const p = provider("offline", "scripted", { tokensPerSecond: 40, tokenSize: 3 });
    const adapter = await home.open(p, [danger]);
    const parent = adapter.root();
    const gen = w.generation();
    const run = (await gen.begin(w.ann, { commandId: cid("begin"), taskId: w.task, contextRevision: 1 })).id;
    let requested!: () => void;
    const requestSeen = new Promise<void>((resolve) => { requested = resolve; });
    p.script(
      () => { requested(); return fauxAssistantMessage(fauxToolCall("push", { payload: "x".repeat(400) }, { id: "partial-1" }), { stopReason: "toolUse" }); },
      () => fauxAssistantMessage("next answer"),
    );
    const first = await parent.submit(input(cid("stream"), "go"));
    // Wait for the provider to have the request (a signal from the scripted reply, not a fixed delay from submission). The stream then runs at 40 tokens a second in 3-character pieces, so the
    // 400-character arguments need seconds; the short wait lets it start, and the aborted entry checked below proves the cut landed inside the call.
    await requestSeen;
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The controller cuts the generation first (its record of the call is partial), then asks the runtime to abort.
    await gen.record(w.ann, { commandId: cid("c"), runId: run, seq: 1, toolCall: { id: "partial-1", name: "push", argumentsDelta: '{"payload":"xxxxxxxx' } });
    await gen.interrupt(w.mgr, { commandId: cid("int"), taskId: w.task, mode: "cancel", reason: "owner said stop" });
    assert.equal((await parent.abort()).aborted.length, 1);
    const aborted = await first.result();
    assert.deepEqual([aborted.status, aborted.status === "unanswered" && aborted.reason, aborted.toolCalls], ["unanswered", "aborted", []]);
    // The abort really landed inside the call (so the test cannot pass vacuously on a fast or slow machine).
    const partial = (await parent.transcript()).find((e) => e.kind === "pi.assistant")!;
    assert.deepEqual([partial.stopReason, partial.toolCallIds], ["aborted", ["partial-1"]]);
    // Even with the task's pending instruction taken away, the aborted partial turn (and the framing entry after it) is no turn boundary.
    const entries = (await parent.transcript()).filter((e) => e.kind !== "pi.user").map((e) => ({ id: e.id, kind: e.kind, model: [{ role: e.role, stopReason: e.stopReason, content: e.toolCallIds.map((id) => ({ type: "toolCall", id })) }], data: e.data }));
    assert.deepEqual(turnBoundaries(entries), []);

    // Whatever the runtime still delivers is late and not applied; the partial call is dropped; admission is refused before and after the hold is lifted.
    const late = await gen.record(w.ann, { commandId: cid("late"), runId: run, seq: 2, toolCall: { id: "partial-1", argumentsDelta: '"}', done: true } });
    assert.deepEqual([late.applied, late.late], [false, true]);
    const view = (await gen.view(w.ann, run))!.run;
    assert.deepEqual([view.state, view.toolCalls[0]!.state, view.toolCalls[0]!.args, view.lateCount], ["interrupted", "dropped", '{"payload":"xxxxxxxx', 1]);
    const admit = () => gen.admitEffect(w.ann, { commandId: cid("adm"), runId: run, toolCallId: "partial-1", kind: "git-push", target: "repo:main" });
    await refusedFor("interrupted", admit);
    await refusedFor("held", () => gen.begin(w.ann, { commandId: cid("begin"), taskId: w.task, contextRevision: 1 }));
    await gen.release(w.mgr, { commandId: cid("rel"), taskId: w.task, reason: "reviewed" });
    await refusedFor("interrupted", admit);
    assert.equal(executions, 0);
    assert.equal(outside.executions.length, 0);

    // The aborted turn is not a fork point and the partial call is not in the next request's context.
    await assert.rejects(parent.branch({ requestId: requestId(cid("after-abort")) }), NoBranchPointError);
    await done(await parent.submit(input(cid("again"), "second")));
    assert.ok(!JSON.stringify(p.seen.at(-1)).includes("partial-1") && !p.seen.at(-1)!.some((l) => l.includes("<call")), `the partial call reached the model: ${JSON.stringify(p.seen.at(-1))}`);
    assert.equal(executions, 0);
  });

  scenario("the context survives a restart and a change of provider with no summary reconstruction, a suspended branch restores exactly, and each resume record says how the context came back", async (w, home) => {
    const first = provider("offline", "scripted");
    let adapter = await home.open(first, [echo]);
    const mirror = new Mirror(w, w.task);
    await finishedTask(first, adapter);
    const q = await openInquiry(w, adapter, "How is it going?", mirror);
    first.answers("fine");
    await done(await q.fork.conversation.submit(input(cid("ask"), "How is it going?")));
    await q.branches.append(w.ann, { commandId: cid("b"), branchId: q.branchId, text: "How is it going?" });

    // Suspend the branch; take the continuation at a boundary, with the durability check being the adapter's own verification of the checkpoint.
    const bv = (await q.branches.view(w.ann, q.branchId))!;
    await q.branches.suspend(w.ann, { commandId: cid("s"), branchId: q.branchId, expectedRevision: bv.branch.revision, reason: "urgent task arrived" });
    const collected = async (svc: ReturnType<World["branches"]>) => JSON.stringify({ parent: (await svc.history(w.ann, q.branchId, { part: "parent", limit: 50 }))!.entries.map((e) => e.text), branch: (await svc.history(w.ann, q.branchId, { part: "branch", limit: 50 }))!.entries.map((e) => e.text) });
    const branchBefore = await collected(q.branches);
    const beforeTranscript = await adapter.root().transcript();
    const checkpoint = await adapter.root().checkpoint();
    assert.deepEqual(await adapter.verifyCheckpoint(checkpoint), { valid: true });
    const manifest = { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: beforeTranscript.length }], compression: { state: "none" as const, compactions: 0 }, branches: (await adapter.root().listBranches()).map((b) => ({ conversationId: b.conversationId, parent: adapter.root().id })), messageCursor: checkpoint.at, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-adapter", version: "0.0.0" } };
    const capture = await w.continuations.capture(w.host, {
      commandId: cid("cap"), taskId: w.task, identity: `conversation-${checkpoint.conversationId}`, agent: "agent:ann", boundary: { kind: "turn-complete" },
      checkpoint: { format: checkpoint.format, conversationId: checkpoint.conversationId, at: checkpoint.at, digest: checkpoint.digest, runtime: checkpoint.runtime }, durable: { verified: true },
      continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 99, unit: "k-tokens" }, nextStep: "carry on with the task" },
      manifest, nonCheckpointableTools: [{ name: "echo", reason: "its effects are outside the history" }], scratchRecords: [], credentialRefs: [],
    });
    assert.equal(capture.status, "complete");

    // Restart: the adapter and the controller services are closed and opened again; the model provider is a different one.
    await home.close(adapter);
    const second = provider("alt-provider", "alt-model");
    adapter = await home.open(second, [echo]);
    const afterTranscript = await adapter.root().transcript();
    await adapter.root().useModel(second.ref);
    assert.deepEqual(afterTranscript, beforeTranscript, "the stored history came back exactly");
    assert.ok(!afterTranscript.some((e) => e.kind === "pi.compaction" || /summar/i.test(e.text)), "no summary stands in for the history");
    const verdict = await adapter.verifyCheckpoint(checkpoint);
    assert.deepEqual(verdict, { valid: true });
    // The host's rule (the fixture's, not a service's): a checkpoint that verifies on the reopened storage is a native restore. The label is the host's word.
    assert.equal(verdict.valid, true);
    const label = "native-restore" as const;
    const resumed = await w.continuations.resume(w.host, { commandId: cid("rsm"), taskId: w.task, model: { provider: "alt-provider", id: "alt-model" }, previousModel: { provider: "offline", id: "scripted" }, after: "model-change", restoredBy: label });
    assert.deepEqual([resumed.identity, resumed.modelChanged, resumed.restoredBy, resumed.continuation.id], [`conversation-${checkpoint.conversationId}`, true, "native-restore", capture.id]);
    const stored = (await w.continuations.latest(w.host, w.task))!;
    assert.equal(stored.id, capture.id);

    // The suspended branch restores to exactly the history that was available, through a restarted service.
    const svc = w.branches();
    const sv = (await svc.view(w.ann, q.branchId))!;
    assert.equal(sv.branch.state, "suspended");
    await svc.restore(w.ann, { commandId: cid("rs"), branchId: q.branchId, expectedRevision: sv.branch.revision });
    const restored = (await svc.view(w.ann, q.branchId))!.branch.restored!;
    assert.deepEqual([restored.exact, restored.extraEntries], [true, 0]);
    assert.equal(await collected(svc), branchBefore);

    // The new provider is handed the same context the old one had, then the new instruction. Nothing was summarised or re-asked.
    second.answers("continuing on the new provider");
    await done(await adapter.root().submit(input(cid("go"), "carry on")));
    assert.deepEqual(second.seen, [[...TASK_MANIFEST, "user: carry on"]]);
    assert.deepEqual(first.seen.at(-1), [...TASK_MANIFEST, "user: How is it going?"], "the old provider saw the same prefix");
    // The restored inquiry branch keeps the model it was created with, so it is moved too; it then answers from its own, unchanged context on the new provider.
    const again = await adapter.root().branch({ requestId: requestId(q.branchId) });
    assert.equal(again.conversation.id, q.fork.conversation.id, "the fork is found again by the branch's request ID");
    await again.conversation.useModel(second.ref);
    second.answers("still fine");
    await done(await again.conversation.submit(input(cid("ask2"), "And now?")));
    assert.deepEqual(second.seen.at(-1), [...TASK_MANIFEST, "user: How is it going?", "assistant: fine", "user: And now?"]);

    // A correction of an old owner decision, placed after the restart, reaches the new provider after the old context and before the next instruction.
    await done(await adapter.root().submit({ kind: "update", requestId: requestId(cid("corr")), content: "Owner correction: the earlier decision is withdrawn.", run: false }), "placed");
    second.answers("noted");
    await done(await adapter.root().submit(input(cid("go2"), "what now?")));
    assert.deepEqual(second.seen.at(-1), [...TASK_MANIFEST, "user: carry on", "assistant: continuing on the new provider", "user: Owner correction: the earlier decision is withdrawn.", "user: what now?"]);

    // A storage that does not hold the history cannot be labelled a native restore: the checkpoint is rejected and the honest label is restart (or reconstruction, if material was used to rebuild).
    const empty = new PiHome();
    try {
      const fresh = provider("offline", "scripted");
      const bare = await empty.open(fresh, [echo]);
      const empty_ = await bare.verifyCheckpoint(checkpoint);
      assert.equal(empty_.valid, false);
      assert.equal(empty_.valid === false && empty_.reason, "unknown_entry");
      // Reconstruction: the controller's mirrored history is replayed as one instruction. The model works, but its context is not the original, and the record says so.
      const rebuilt = (await mirror.sync(adapter)).join("\n");
      fresh.answers("rebuilt answer");
      await done(await bare.root().submit(input(cid("rebuild"), `Earlier in this task:\n${rebuilt}\nContinue.`)));
      assert.notDeepEqual(fresh.seen.at(-1)!.slice(0, 4), TASK_MANIFEST, "a reconstructed context is not the original");
      const restart = await w.continuations.resume(w.host, { commandId: cid("rsm"), taskId: w.task, model: { provider: "offline", id: "scripted" }, after: "restart", restoredBy: "restart" });
      const rebuiltRecord = await w.continuations.resume(w.host, { commandId: cid("rsm"), taskId: w.task, model: { provider: "offline", id: "scripted" }, after: "restart", restoredBy: "reconstruction" });
      assert.deepEqual([restart.restoredBy, rebuiltRecord.restoredBy], ["restart", "reconstruction"]);
    } finally { await empty.dispose(); }
  });
}

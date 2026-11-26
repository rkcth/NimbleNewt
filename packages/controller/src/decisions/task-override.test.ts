// Card C08 (decision handling), the gap Q02 found: a TASK-LEVEL decision of the owner's that overrides a PROJECT-WIDE one leaves the project-wide decision in force for every other task, but that task's
// work linked to the project-wide decision stops counting in the same commit: its links are marked superseded (naming the override, with the reason in plain words), so its next action is blocked, its earlier
// approvals stop counting (Q02 `approvalOutdated`) and it must revalidate onto the override, after which a new review restores the flow. Other tasks keep the project-wide decision and their approvals.
// Also: a second override, a project-wide correction while an override exists, a task with no links, follow-ups for actions that already happened, the replay of the same command, races between an override
// and a link or an approval, and the chat: the proposal shown first and the answer say what happens. Runs on all four storage backends.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openWorld, cid, options } from "../chat/testing/harness.js";
import type { Outcome } from "../chat/index.js";
import { DomainError } from "../domain/errors.js";
import { EffectService, type EffectBridge } from "../domain/effects.js";
import { backends, stopServer, type Backend } from "../domain/testing/backends.js";
import { EventService } from "../events/index.js";
import { GenerationService } from "../generation/index.js";
import { PauseService } from "../lifecycle/index.js";
import type { Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { QaEvidenceService, SubmissionService } from "../submissions/index.js";
import { StatusService } from "../status/index.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { DecisionService, type DecisionDeps, type RecordDecision } from "./index.js";
import { propagationIdOf, relianceIdOf } from "./records.js";

after(stopServer);

const bridge: EffectBridge = { idempotent: true, execute: async (): Promise<JsonObject> => ({ receipt: 1 }) };
let n_ = 0;
const T = (c: string) => c.repeat(40);

async function rig(backend: Backend) {
  const script: Record<string, unknown> = {};
  const w = await openWorld(backend, script as never);
  const st = w.world.storage, epoch = w.projects.epoch;
  const effects = EffectService.withEpoch(st, epoch, w.assignments, { holder: "exec-1", ...options });
  const realEvents = EventService.withEpoch(st, epoch, options);
  const published: string[] = [];
  const events = { publish: async (by: Principal, command: Parameters<EventService["publish"]>[1]): ReturnType<EventService["publish"]> => { const r = await realEvents.publish(by, command); if (r.accepted && !r.duplicate) published.push(`${command.stream}:${command.kind}`); return r; } } as unknown as EventService;
  const deps = { events, effects } as { -readonly [K in keyof DecisionDeps]: DecisionDeps[K] };
  const decisions = DecisionService.withEpoch(st, epoch, deps, options);
  const pauses = PauseService.withEpoch(st, epoch, {}, options);
  const gen = GenerationService.withEpoch(st, epoch, { assignments: w.assignments, effects, pauses, decisions }, options);
  deps.generation = gen;
  const a = await w.project("A");
  const t1 = await w.task(a, "first task");
  const t2 = await w.task(a, "second task");
  const t3 = await w.task(a, "third task");
  const roles = new Map<string, string[]>();
  const grants = [{ action: "attempt.work", project: a }, { action: "effect.perform", project: a }, { action: "task.read", project: a }, { action: "history.read", project: a }];
  const ann = (await w.agent("ann", grants)).principal;
  const rev = (await w.agent("rev", [{ action: "review.decide", project: a }, { action: "task.read", project: a }, { action: "history.read", project: a }])).principal;
  roles.set(ann.id, ["author"]); roles.set(rev.id, ["reviewer"]);
  const subs = SubmissionService.withEpoch(st, epoch, async (id) => roles.get(id) ?? [], options);
  const decide = (over: Partial<RecordDecision> & Record<string, unknown> = {}) =>
    decisions.record(w.owner, { commandId: cid("dec"), projectId: a, category: "decision", topic: "database", statement: "Use PostgreSQL for the controller", wording: "We will use PostgreSQL for the controller", source: { channel: "direct" }, basedOn: 0, ...over } as never);
  const recorded = async (over: Partial<RecordDecision> & Record<string, unknown> = {}) => { const r = await decide(over); assert.equal(r.recorded, true, JSON.stringify(r)); return r as Extract<typeof r, { recorded: true }>; };
  const link = (taskId: string, ids: string[], subject: { kind: string; id: string } = { kind: "contract", id: taskId }) => decisions.link(ann, { commandId: cid("lk"), taskId, subject, decisions: ids } as never);
  const revalidate = (taskId: string, ids: string[], by: Principal = ann) => decisions.revalidate(by, { commandId: cid("rv"), taskId, decisions: ids, note: "re-read the owner's decision" });
  const code = async (taskId: string, tree = T("a")) => (await subs.record(ann, { commandId: cid("s"), taskId, kind: "code", role: "author", base: T("c"), tree, patchId: T("d") })).id;
  const approve = (subject: string, taskId: string) => subs.record(rev, { commandId: cid("ap"), taskId, kind: "review", role: "reviewer", subject, verdict: "approve" } as never);
  const blocked = async (taskId: string) => (await decisions.guard(taskId, "effect")).blockedBy;
  const rel = async (taskId: string) => (await decisions.reliance(w.owner, taskId))!;
  const revOf = async (taskId: string) => (await st.getAggregate({ kind: "decision-reliance", id: relianceIdOf(taskId) }))?.revision;
  const intend = async (taskId: string): Promise<string> => (await effects.intend({ commandId: cid("in"), actor: ann.id, kind: "deploy", target: "prod", input: { n: n_++ }, taskId })).id;
  return { w, st, script, decisions, gen, effects, published, a, t1, t2, t3, ann, rev, subs, decide, recorded, link, revalidate, code, approve, blocked, rel, revOf, intend };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const refuses = async (code: string, run: () => Promise<unknown>, pattern?: RegExp): Promise<void> => {
  await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, e.message); if (pattern !== undefined) assert.match(e.message, pattern); return true; });
};

for (const backend of backends) {
  const suite = (name: string, body: (r: Rig) => Promise<void>) => test(`${backend.name}: ${name}`, async () => { const r = await rig(backend); try { await body(r); } finally { await r.w.close(); } });

  suite("a task-level override supersedes that task's links to the project-wide decision only: its effects wait, its approval stops counting, it revalidates onto the override and a new review restores it; the other task keeps both", async (r) => {
    const wide = await r.recorded();
    await r.link(r.t1, [wide.id]);
    await r.link(r.t2, [wide.id]);
    const c1 = await r.code(r.t1), c2 = await r.code(r.t2);
    await r.approve(c1, r.t1); await r.approve(c2, r.t2);
    assert.deepEqual([(await r.subs.approvalOf(c1))?.approved, (await r.subs.approvalOf(c2))?.approved], [true, true]);
    assert.deepEqual([await r.blocked(r.t1), await r.blocked(r.t2)], [[], []]);
    r.published.length = 0;

    const over = await r.recorded({ taskId: r.t1, statement: "Task one uses SQLite for its fixtures", wording: "task one uses SQLite for its fixtures", basedOn: 1 });
    // The project-wide decision supersedes nothing and stays in force; the result says whose links changed.
    assert.deepEqual([over.superseded, over.overridden, over.propagation], [[], { taskId: r.t1, decisionIds: [wide.id] }, "done"]);
    assert.equal((await r.decisions.get(r.w.owner, wide.id))?.state, "active");
    // That task's link is marked, with the reason in plain words; the other task's is not.
    const l1 = (await r.rel(r.t1)).links[0]!, l2 = (await r.rel(r.t2)).links[0]!;
    assert.deepEqual([l1.state, l1.supersededBy, l1.stale, l1.decisionState], ["superseded", over.id, true, "active"]);
    assert.match(l1.because!, new RegExp(`task-level decision ${over.id} overrode the project-wide decision ${wide.id} for this task .*other tasks keep the project-wide one`));
    assert.deepEqual([l2.state, l2.stale], ["current", false]);
    // The task's own context record (what its agent reads at start-up) holds the override, not the project-wide decision; the other task's holds the project-wide one.
    assert.deepEqual((await r.decisions.context(r.w.owner, { projectId: r.a, taskId: r.t1 }))!.decisions.map((d) => d.id), [over.id]);
    assert.deepEqual((await r.decisions.context(r.w.owner, { projectId: r.a, taskId: r.t2 }))!.decisions.map((d) => d.id), [wide.id]);
    assert.deepEqual((await r.decisions.context(r.w.owner, { projectId: r.a }))!.decisions.map((d) => d.id).sort(), [wide.id, over.id].sort());
    // The guard blocks the task's next action, not the other's.
    const b1 = await r.blocked(r.t1);
    assert.equal(b1.length, 1);
    assert.match(b1[0]!, /no longer applies to this task: the owner's task-level decision .* overrode/);
    assert.deepEqual(await r.blocked(r.t2), []);
    // The approval of the task stops counting, with the reason; the other task's still counts.
    const a1 = (await r.subs.approvalOf(c1))!;
    assert.equal(a1.approved, false);
    assert.match(a1.outdated!.because, new RegExp(`owner decision ${wide.id} no longer applies to this task: the owner's task-level decision ${over.id} overrode`));
    assert.equal((await r.subs.approvalOf(c2))?.approved, true);
    // A new approval waits too (the link is no longer in force), with the plain reason.
    await refuses("invalid_command", () => r.approve(c1, r.t1), /no longer applies to it \(the owner's task-level decision/);
    // Only that task was told, once.
    assert.deepEqual(r.published, [`task:${r.t1}:decision-superseded`]);

    // Revalidating onto the project-wide decision is refused (it does not govern this task); onto the override it clears the block.
    await refuses("invalid_command", () => r.revalidate(r.t1, [wide.id]), /governs this task/);
    assert.deepEqual(await r.revalidate(r.t1, [over.id]), { revalidated: 1, remaining: 0, replayed: false });
    assert.deepEqual(await r.blocked(r.t1), []);
    assert.deepEqual((await r.rel(r.t1)).links.map((l) => [l.decisionId, l.state, l.stale]), [[over.id, "current", false]]);
    // The old approval was given on the project-wide decision: it still does not count until a reviewer looks again.
    assert.equal((await r.subs.approvalOf(c1))?.approved, false);
    await r.approve(c1, r.t1);
    assert.equal((await r.subs.approvalOf(c1))?.approved, true);
    assert.equal((await r.subs.approvalOf(c2))?.approved, true, "the other task was never touched");
  });

  suite("the same override sent again changes nothing a second time; a task with no linked work gets an empty reliance record and can no longer link the project-wide decision", async (r) => {
    const wide = await r.recorded();
    await r.link(r.t1, [wide.id]);
    const cmd = { commandId: cid("dec"), projectId: r.a, taskId: r.t1, category: "decision", topic: "database", statement: "Task one uses SQLite", wording: "task one uses SQLite", source: { channel: "direct" }, basedOn: 1 } as never;
    const first = await r.decisions.record(r.w.owner, cmd);
    const revision = await r.revOf(r.t1);
    const again = await r.decisions.record(r.w.owner, cmd);
    assert.deepEqual([again.recorded, (again as { replayed?: boolean }).replayed, (again as { overridden?: unknown }).overridden], [true, true, (first as { overridden?: unknown }).overridden]);
    assert.equal(await r.revOf(r.t1), revision, "the reliance record was not written again");
    assert.equal((await r.st.getAggregate({ kind: "decision-propagation", id: propagationIdOf((first as { id: string }).id) }))?.body["state"], "done");

    // A task with no reliance record: one is created (empty), nothing is marked and nothing is passed on.
    assert.equal(await r.revOf(r.t3), undefined);
    const none = await r.recorded({ taskId: r.t3, statement: "Task three uses MySQL", wording: "task three uses MySQL", basedOn: 1 });
    assert.deepEqual([none.overridden, none.propagation], [undefined, "none"]);
    assert.equal(await r.revOf(r.t3), 1);
    assert.deepEqual((await r.rel(r.t3)).links, []);
    await refuses("invalid_command", () => r.link(r.t3, [wide.id]), /does not govern this task/);
    await r.link(r.t3, [none.id]);
    // A task-level decision on a topic the project has not decided marks nothing and writes no reliance record.
    const own = await r.recorded({ taskId: r.t2, topic: "logging", statement: "Task two logs JSON", wording: "task two logs JSON" });
    assert.deepEqual([own.overridden, await r.revOf(r.t2)], [undefined, undefined]);
  });

  suite("a second override supersedes the first for that task as an ordinary correction; a project-wide correction while an override exists supersedes both and every linked task revalidates onto it", async (r) => {
    const wide = await r.recorded();
    await r.link(r.t1, [wide.id]); await r.link(r.t2, [wide.id]);
    await r.link(r.t1, [wide.id], { kind: "task", id: r.t1 });
    const o1 = await r.recorded({ taskId: r.t1, statement: "Task one uses SQLite", wording: "task one uses SQLite", basedOn: 1 });
    // Only the contract is revalidated; the task's other link stays marked by the first override.
    await r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [o1.id], note: "re-read", subjects: [{ kind: "contract", id: r.t1 }] });
    // Two overrides: the second is a task-level correction of the first.
    const o2 = await r.recorded({ taskId: r.t1, statement: "Task one uses DuckDB", wording: "task one uses DuckDB", basedOn: 2 });
    assert.deepEqual([o2.superseded, o2.overridden], [[o1.id], undefined], "the project-wide decision's links were already marked; nothing new to mark");
    const kept = (await r.rel(r.t1)).links.find((l) => l.subject.kind === "task")!;
    assert.deepEqual([kept.decisionId, kept.state, kept.supersededBy], [wide.id, "superseded", o1.id], "a link an earlier override marked keeps that mark");
    assert.ok((await r.blocked(r.t1)).some((b) => new RegExp(`decision ${o1.id}, which is superseded by ${o2.id}`).test(b)));
    assert.deepEqual(await r.blocked(r.t2), []);
    await r.revalidate(r.t1, [o2.id]);
    // An override for another task leaves this one alone.
    const o3 = await r.recorded({ taskId: r.t2, statement: "Task two uses Redis", wording: "task two uses Redis", basedOn: 1 });
    assert.deepEqual(o3.overridden, { taskId: r.t2, decisionIds: [wide.id] });
    assert.deepEqual([await r.blocked(r.t1), (await r.blocked(r.t2)).length], [[], 1]);
    await r.revalidate(r.t2, [o3.id]);
    // The owner corrects the project-wide decision: the task-level exceptions are superseded too (C08), and both tasks wait for the new one.
    const wide2 = await r.recorded({ statement: "Use CockroachDB everywhere", wording: "use CockroachDB everywhere", basedOn: 4 });
    assert.deepEqual([...wide2.superseded].sort(), [wide.id, o2.id, o3.id].sort());
    assert.equal((await r.blocked(r.t1)).length, 2, "both of the task's links wait");
    assert.equal((await r.blocked(r.t2)).length, 1);
    await refuses("invalid_command", () => r.revalidate(r.t1, [o2.id]), /not an authoritative decision/);
    await r.revalidate(r.t1, [wide2.id]); await r.revalidate(r.t2, [wide2.id]);
    assert.deepEqual([await r.blocked(r.t1), await r.blocked(r.t2)], [[], []]);
  });

  suite("QA evidence judged on the project-wide decision stops holding for the overridden task only, with the reason in plain words", async (r) => {
    const qaAgent = (await r.w.agent("qa", [{ action: "task.read", project: r.a }])).principal;
    const qa = QaEvidenceService.withEpoch(r.st, r.w.projects.epoch, { rolesOf: async (id) => (id === qaAgent.id ? ["qa"] : []), notify: async () => undefined, invalidated: async () => undefined }, options);
    const wide = await r.recorded();
    await r.link(r.t1, [wide.id]); await r.link(r.t2, [wide.id]);
    const c1 = await r.code(r.t1), c2 = await r.code(r.t2);
    for (const c of [c1, c2]) await qa.record(qaAgent, { commandId: cid("qa"), submissionId: c, criteriaRevision: 0, decisions: [wide.id], environment: "linux", observedAt: "2026-10-22T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] });
    await r.recorded({ taskId: r.t1, statement: "Task one uses SQLite", wording: "task one uses SQLite", basedOn: 1 });
    const stale = (await qa.list(r.w.owner, r.t1)).items[0]!.staleNow;
    assert.ok(stale.some((x) => x.kind === "decision_superseded" && x.decisionId === wide.id && /no longer in force for this task/.test((x as { state: string }).state)), JSON.stringify(stale));
    assert.equal((await qa.decisionChanged(r.t1)).invalidated.length, 1);
    assert.deepEqual([(await qa.list(r.w.owner, r.t2)).items[0]!.staleNow, (await qa.decisionChanged(r.t2)).invalidated], [[], []]);
  });

  suite("an action that already happened on the overridden decision gets a corrective follow-up (never claimed undone); one queued is blocked by the guard", async (r) => {
    const wide = await r.recorded();
    const done = await r.intend(r.t1);
    assert.equal((await r.effects.run(done, bridge)).status, "confirmed");
    const queued = await r.intend(r.t1);
    await r.link(r.t1, [wide.id], { kind: "action", id: done });
    await r.link(r.t1, [wide.id], { kind: "action", id: queued });
    const other = await r.intend(r.t2);
    assert.equal((await r.effects.run(other, bridge)).status, "confirmed");
    await r.link(r.t2, [wide.id], { kind: "action", id: other });
    const over = await r.recorded({ taskId: r.t1, statement: "Task one uses SQLite", wording: "task one uses SQLite", basedOn: 1 });
    const fu = (await r.rel(r.t1)).followUps;
    assert.deepEqual(fu.map((f) => [f.effectId, f.effectStatus, f.undone, f.state, f.supersededBy]), [[done, "confirmed", false, "open", over.id]]);
    assert.deepEqual((await r.rel(r.t2)).followUps, [], "the other task's action stands on the project-wide decision");
    assert.ok((await r.blocked(r.t1)).some((b) => b.includes(`action ${queued}`)));
  });

  suite("an override racing a link or an approval lands strictly before or after it: the task never ends with current work on the overridden decision or an approval that counts", async (r) => {
    for (let round = 0; round < 4; round++) {
      const wide = await r.recorded({ topic: `store ${round}`, statement: `Use store ${round}`, wording: `we use store ${round}` });
      const task = await r.w.task(r.a, `race ${round}`);
      const raced = await Promise.allSettled([
        r.link(task, [wide.id]),
        r.recorded({ topic: `store ${round}`, taskId: task, statement: `Race ${round} keeps files`, wording: `race task ${round} keeps files`, basedOn: 1 }),
      ]);
      assert.equal(raced[1].status, "fulfilled");
      const links = (await r.rel(task)).links;
      assert.ok(links.every((l) => l.decisionId !== wide.id || l.state === "superseded"), `round ${round}: ${JSON.stringify(links)}`);
      if (raced[0].status === "rejected") assert.match(String(raced[0].reason), /does not govern this task/);
      else assert.equal((await r.blocked(task)).length, 1);
    }
    for (let round = 0; round < 4; round++) {
      const wide = await r.recorded({ topic: `queue ${round}`, statement: `Use queue ${round}`, wording: `we use queue ${round}` });
      const task = await r.w.task(r.a, `approval race ${round}`);
      await r.link(task, [wide.id]);
      const c = await r.code(task);
      const raced = await Promise.allSettled([r.approve(c, task), r.recorded({ topic: `queue ${round}`, taskId: task, statement: `Approval race ${round} keeps files`, wording: `approval race task ${round} keeps files`, basedOn: 1 })]);
      assert.equal(raced[1].status, "fulfilled");
      assert.equal((await r.subs.approvalOf(c))?.approved ?? false, false, `round ${round}: an approval racing the override never counts after it`);
    }
  });

  suite("in chat the proposal shown first says which task's linked work stops counting and that its approvals stop; the applied answer says it too; the other tasks are named as keeping it", async (r) => {
    const chat = r.w.chat();
    await chat.setFocus(r.w.ownerToken, { commandId: cid("f"), projectId: r.a });
    const wide = await r.recorded();
    await r.link(r.t1, [wide.id]);
    const cmd = (args: Record<string, unknown>, evidence: string) => ({ kind: "command", op: "decision.record", args, evidence, basis: "owner" });
    const text = "For the first task the database will be SQLite instead.";
    r.script[text] = [cmd({ category: "decision", topic: "database", taskTitle: "first task", statement: "the database will be SQLite", wording: "For the first task the database will be SQLite instead" }, "For the first task the database will be SQLite instead")];
    r.w.profile.value = "strict";
    const shown = (await chat.submit(r.w.ownerToken, { messageId: "m-o1", text })).outcomes[0] as Outcome;
    assert.equal(shown.status, "proposed", JSON.stringify(shown));
    const preview = JSON.stringify(shown.preview);
    assert.match(preview, new RegExp(`overrides the project-wide decision ${wide.id} .*for this task only; other tasks keep it`));
    assert.match(preview, /This task's contract linked to it \(1 link\) stops counting: its earlier approvals no longer count and its next action waits until the work is revalidated onto this decision and reviewed again/);
    assert.equal((await r.rel(r.t1)).links[0]!.state, "current", "nothing changes before the owner says yes");
    const applied = await chat.applyProposal(r.w.ownerToken, { commandId: cid("ap"), proposalId: shown.proposalId! });
    assert.equal(applied.applied, true);
    assert.match(JSON.stringify(applied.results), new RegExp(`It overrides the project-wide decision ${wide.id} for task ${r.t1} only; other tasks keep it\\. That task's work linked to the project-wide decision no longer counts: its earlier approvals stop counting`));
    assert.equal((await r.rel(r.t1)).links[0]!.state, "superseded");
    // In another profile it applies at once, and the answer says the same; a task with nothing linked is told nothing stops counting when shown first.
    r.w.profile.value = "derived";
    const t2text = "For the second task the database will be DuckDB instead.";
    r.script[t2text] = [cmd({ category: "decision", topic: "database", taskTitle: "second task", statement: "the database will be DuckDB", wording: "For the second task the database will be DuckDB instead" }, "For the second task the database will be DuckDB instead")];
    const done = (await chat.submit(r.w.ownerToken, { messageId: "m-o2", text: t2text })).outcomes[0] as Outcome;
    assert.equal(done.status, "applied", JSON.stringify(done));
    assert.doesNotMatch(JSON.stringify(done), /It overrides/, "nothing of the second task was linked, so no task's work changes");
    r.w.profile.value = "strict";
    const t3text = "For the third task the database will be MySQL instead.";
    r.script[t3text] = [cmd({ category: "decision", topic: "database", taskTitle: "third task", statement: "the database will be MySQL", wording: "For the third task the database will be MySQL instead" }, "For the third task the database will be MySQL instead")];
    const t3 = (await chat.submit(r.w.ownerToken, { messageId: "m-o3", text: t3text })).outcomes[0] as Outcome;
    assert.match(JSON.stringify(t3.preview), /None of this task's work is linked to the project-wide decision, so nothing of it stops counting/);
  });

  suite("the project-wide decision said again while a task overrides it records nothing and says which task still follows its own decision; a review or QA evidence cannot cite the overridden decision, and one that cited it without a link stops counting", async (r) => {
    const wide = await r.recorded();
    const over = await r.recorded({ taskId: r.t1, statement: "Task one uses SQLite", wording: "task one uses SQLite", basedOn: 1 });
    const again = await r.decide({ basedOn: 2 });
    assert.equal(again.recorded, false);
    assert.match((again as { reason: string }).reason, new RegExp(`it stands.*For task ${r.t1} the owner's own task-level decision on this topic \\(${over.id}\\) still overrides it; to have that task follow the project-wide decision, decide again for each such task`));
    // With no override the answer is the plain one.
    const plain = await r.decide({ topic: "logging", statement: "Log JSON", wording: "we log JSON" });
    assert.equal(plain.recorded, true);
    const plainAgain = await r.decide({ topic: "logging", statement: "Log JSON", wording: "we log JSON", basedOn: 1 });
    assert.equal((plainAgain as { reason: string }).reason, "the owner already decided exactly this; it stands, and nothing needs to be asked again");

    // A verdict or QA evidence of the overridden task is not judged against the project-wide decision; the other task's may be.
    const qaAgent = (await r.w.agent("qa", [{ action: "task.read", project: r.a }])).principal;
    const qa = QaEvidenceService.withEpoch(r.st, r.w.projects.epoch, { rolesOf: async (id) => (id === qaAgent.id ? ["qa"] : []), notify: async () => undefined, invalidated: async () => undefined }, options);
    const evidence = (submissionId: string, decisions: string[]) => qa.record(qaAgent, { commandId: cid("qa"), submissionId, criteriaRevision: 0, decisions, environment: "linux", observedAt: "2026-10-22T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] });
    const cited = (subject: string, taskId: string, decisions: string[]) => r.subs.record(r.rev, { commandId: cid("ap"), taskId, kind: "review", role: "reviewer", subject, verdict: "approve", criteriaRevision: 0, decisions } as never);
    const c1 = await r.code(r.t1);
    await refuses("invalid_command", () => cited(c1, r.t1, [wide.id]), new RegExp(`for this task the owner's task-level decision ${over.id} overrides it`));
    await refuses("invalid_command", () => evidence(c1, [wide.id]), new RegExp(`for this task the owner's task-level decision ${over.id} overrides it`));
    await cited(c1, r.t1, [over.id]);
    assert.equal((await r.subs.approvalOf(c1))?.approved, true);

    // An approval and evidence that cited the project-wide decision with no link (task three never linked): the owner then overrides it for that task, and both stop counting there only.
    const c3 = await r.code(r.t3), c2 = await r.code(r.t2);
    await cited(c3, r.t3, [wide.id]); await cited(c2, r.t2, [wide.id]);
    await evidence(c3, [wide.id]); await evidence(c2, [wide.id]);
    assert.deepEqual([(await r.subs.approvalOf(c3))?.approved, (await qa.list(r.w.owner, r.t3)).items[0]!.staleNow], [true, []]);
    const over3 = await r.recorded({ taskId: r.t3, statement: "Task three uses MySQL", wording: "task three uses MySQL", basedOn: 1 });
    const a3 = (await r.subs.approvalOf(c3))!;
    assert.equal(a3.approved, false);
    assert.match(a3.outdated!.because, new RegExp(`owner decision ${wide.id} it cites no longer applies to this task: the owner's task-level decision ${over3.id} overrides it`));
    const stale = (await qa.list(r.w.owner, r.t3)).items[0]!.staleNow;
    assert.ok(stale.some((x) => x.kind === "decision_superseded" && x.decisionId === wide.id && /no longer in force for this task/.test((x as { state: string }).state)), JSON.stringify(stale));
    assert.deepEqual([(await r.subs.approvalOf(c2))?.approved, (await qa.list(r.w.owner, r.t2)).items[0]!.staleNow], [true, []], "the other task keeps both");
  });

  suite("a dispute the owner settles by keeping the project-wide decision over the override gives the task's marked links back; settling it for the override keeps them marked", async (r) => {
    for (const keep of ["wide", "override"] as const) {
      const topic = `cache ${keep}`;
      const wide = await r.recorded({ topic, statement: `Use Redis for ${keep}`, wording: `we use Redis for ${keep}` });
      const task = await r.w.task(r.a, `dispute ${keep}`);
      await r.link(task, [wide.id]);
      const c = await r.code(task);
      await r.approve(c, task);
      const over = await r.recorded({ topic, taskId: task, statement: `Dispute ${keep} uses Memcached`, wording: `the dispute ${keep} task uses Memcached`, basedOn: 1 });
      assert.equal((await r.rel(task)).links[0]!.state, "superseded");
      // A project-wide correction based on the version before the override: the owner's instructions conflict.
      const late = await r.recorded({ topic, statement: `Use Valkey for ${keep}`, wording: `we use Valkey for ${keep}`, basedOn: 1 });
      assert.ok(late.disputeId !== undefined, JSON.stringify(late));
      await r.decisions.resolveDispute(r.w.owner, { commandId: cid("rd"), disputeId: late.disputeId!, chosen: keep === "wide" ? wide.id : over.id });
      const l = (await r.rel(task)).links[0]!;
      if (keep === "wide") {
        assert.deepEqual([l.decisionId, l.state, l.stale, l.because, l.supersededBy], [wide.id, "current", false, undefined, undefined]);
        assert.deepEqual(await r.blocked(task), []);
        assert.equal((await r.subs.approvalOf(c))?.approved, true, "the approval was judged on the decision the owner kept");
      } else {
        assert.deepEqual([l.decisionId, l.state], [wide.id, "superseded"]);
        assert.equal((await r.blocked(task)).length, 1);
        assert.equal((await r.subs.approvalOf(c))?.approved, false);
      }
    }
  });

  suite("asked in free words why the task is held up, the owner's chat answers with the task view: which work relies on the overridden decision and why, and the way out", async (r) => {
    const status = StatusService.withEpoch(r.st, r.w.projects.epoch, { assignments: r.w.assignments, waits: WaitService.withEpoch(r.st, r.w.projects.epoch, r.w.assignments, options), blockers: BlockerService.withEpoch(r.st, r.w.projects.epoch, options), contracts: r.w.contracts }, options);
    const chat = r.w.chat({ status });
    await chat.setFocus(r.w.ownerToken, { commandId: cid("f"), projectId: r.a });
    const wide = await r.recorded();
    await r.link(r.t1, [wide.id]);
    const over = await r.recorded({ taskId: r.t1, statement: "Task one uses SQLite", wording: "task one uses SQLite", basedOn: 1 });
    const q = "Why is the first task held up?";
    r.script[q] = [{ kind: "status", request: { kind: "task", taskTitle: "first task" }, evidence: q, basis: "owner" }];
    const o = (await chat.submit(r.w.ownerToken, { messageId: "m-why", text: q })).outcomes[0] as Outcome;
    assert.equal(o.status, "answered", JSON.stringify(o));
    const text = (o.lines ?? []).map((l) => l.text).join("\n");
    assert.match(text, new RegExp(`Its next action waits: its contract ${r.t1} relies on your decision ${wide.id} on "database", which no longer applies to it: the owner's task-level decision ${over.id} overrode the project-wide decision ${wide.id} for this task`));
    assert.match(text, /The way out: its agent \(or you\) revalidates the work onto the decision that governs the task now/);
    // The other task is not held up by it; once revalidated, the line is gone.
    await r.link(r.t2, [wide.id]);
    const q2 = "Why is the second task held up?";
    r.script[q2] = [{ kind: "status", request: { kind: "task", taskTitle: "second task" }, evidence: q2, basis: "owner" }];
    assert.doesNotMatch(((await chat.submit(r.w.ownerToken, { messageId: "m-why2", text: q2 })).outcomes[0] as Outcome).lines!.map((l) => l.text).join("\n"), /next action waits/);
    await r.revalidate(r.t1, [over.id]);
    const q3 = "And the first task now?";
    r.script[q3] = [{ kind: "status", request: { kind: "task", taskTitle: "first task" }, evidence: q3, basis: "owner" }];
    assert.doesNotMatch(((await chat.submit(r.w.ownerToken, { messageId: "m-why3", text: q3 })).outcomes[0] as Outcome).lines!.map((l) => l.text).join("\n"), /next action waits/);
  });
}

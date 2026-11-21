import assert from "node:assert/strict";
import { after, test } from "node:test";
import { derivedId } from "../domain/ids.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ObservationService } from "../observations/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { OutcomeNotice } from "../standups/shared.js";
import type { ControllerStorage } from "../storage/types.js";
import { LessonService, lessonOutcomeSink, type LessonOptions } from "./index.js";

// Card B03: versioned lessons with applicability, premises, supersession and contradiction; independent evidence told apart from derived; stale premises send lessons to review; every candidate can finish;
// the proposer is told the outcome. Real storage on each backend; the only clock is the test's, and nothing sleeps.

after(stopServer);

let now = Date.parse("2026-11-21T10:05:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};

interface Ctx {
  owner: Principal; host: Principal; mgr: Principal; dev: Principal; dev2: Principal; reader: Principal; eve: Principal;
  a: string; b: string; taskA: string; taskB: string; lessons: LessonService; storage: ControllerStorage; epoch: number;
  make(o?: LessonOptions): LessonService;
  submission(project: string, task: string, by?: string): Promise<string>;
  review(project: string, task: string, requester: string): Promise<string>;
  improvement(project: string, by?: string): Promise<string>;
  observation(sources: { kind: "submission" | "review" | "task"; id: string }[], summary?: string): Promise<string>;
  /** A lesson proposed by `by` (the owner by default, so no outcome waits to be told) with one fresh submission as evidence. */
  lesson(title: string, extra?: Record<string, unknown>, by?: Principal): Promise<string>;
  decide(id: string, to: string, finding?: string, by?: Principal): Promise<{ revision: number; marked: string[] }>;
  status(id: string): Promise<string | undefined>;
}

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-11-21T10:05:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const enroll = async (kind: "agent" | "host", nm: string, grants: Grant[]): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind, name: nm, grants });
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${nm}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "B" })).id;
        const taskA = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: a, title: "Build login" })).id;
        const taskB = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: b, title: "Secret plan" })).id;
        const runner = new CommandRunner(world.storage, epoch, options);
        const put = async (kind: string, id: string, body: Record<string, unknown>): Promise<void> => {
          await runner.command("test.put", { commandId: cid("put"), actor: owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind, id }, creates: true, changes: [{ type: "create" as const, ref: { kind, id }, body: body as never }], detail: {} }) }));
        };
        const submission: Ctx["submission"] = async (project, task, by = "agent:dev") => { const id = derivedId("sbm", cid("s")); await put("submission", id, { projectId: project, taskId: task, kind: "review", submittedBy: by }); return id; };
        const review: Ctx["review"] = async (project, task, requester) => { const id = derivedId("rev", cid("r")); await put("review", id, { binding: { projectId: project, taskId: task, requester } }); return id; };
        const improvement: Ctx["improvement"] = async (project, by = "agent:dev") => { const id = derivedId("imp", cid("i")); await put("improvement-item", id, { projectId: project, proposedBy: by }); return id; };
        const host = await enroll("host", "h1", []);
        const obs = ObservationService.withEpoch(world.storage, epoch, options);
        const observation: Ctx["observation"] = async (sources, summary = "seen") => { const r = await obs.record(host, { commandId: cid("o"), kind: "failure", summary, sources }); assert.notEqual(r.outcome, "suppressed"); return (r as { id: string }).id; };
        const make = (o: LessonOptions = {}) => LessonService.withEpoch(world.storage, epoch, { ...options, ...o });
        const lessons = make();
        const mgr = await enroll("agent", "mgr", [{ action: "meeting.manage", project: a }, { action: "task.read", project: a }]);
        const lesson: Ctx["lesson"] = async (title, extra = {}, by = owner) => (await lessons.propose(by, { commandId: cid("l"), projectId: a, title, statement: `${title}: it holds`, applicability: "when building", evidence: [{ kind: "submission", id: await submission(a, taskA) }], ...extra } as never)).id;
        const decide: Ctx["decide"] = async (id, to, finding = "checked", by = mgr) => lessons.decide(by, { commandId: cid("d"), lessonId: id, expectedRevision: (await lessons.get(owner, id))!.revision, to: to as never, ...(to === "evaluating" ? {} : { finding }) });
        const status: Ctx["status"] = async (id) => (await lessons.get(owner, id))?.status;
        await body({
          owner, host, mgr,
          dev: await enroll("agent", "dev", [{ action: "meeting.agenda", project: a }, { action: "task.read", project: a }]),
          dev2: await enroll("agent", "dev2", [{ action: "meeting.agenda", project: a }]),
          reader: await enroll("agent", "reader", [{ action: "meeting.read", project: a }]),
          eve: await enroll("agent", "eve", [{ action: "meeting.manage", project: b }, { action: "meeting.agenda", project: b }, { action: "task.read", project: b }]),
          a, b, taskA, taskB, lessons, storage: world.storage, epoch, make, submission, review, improvement, observation, lesson, decide, status,
        });
      } finally { await world.close(); }
    });

  suite("independent evidence is told apart from derived: the same event told again, or another lesson's conclusion, is derived; a replayed proposal is the same lesson", async (c) => {
    const sbm = await c.submission(c.a, c.taskA);
    const rev = await c.review(c.a, c.taskA, "agent:dev");
    const fromSbm = await c.observation([{ kind: "submission", id: sbm }], "the review sent it back");
    const lone = await c.observation([{ kind: "task", id: c.taskA }], "the build was slow");
    const imp = await c.improvement(c.a);
    const premise = await c.lesson("Small changes");
    const command = { commandId: "lesson-1", projectId: c.a, title: "Error paths need tests", statement: "Reviews send back changes without tests of the error path.", applicability: "any change to a request handler",
      evidence: [{ kind: "observation", id: fromSbm }, { kind: "submission", id: sbm }, { kind: "review", id: rev }, { kind: "observation", id: lone }, { kind: "improvement-item", id: imp }, { kind: "lesson", id: premise }] } as const;
    const made = await c.lessons.propose(c.mgr, command as never);
    const again = await c.make().propose(c.mgr, command as never);
    assert.deepEqual([again.id, again.replayed], [made.id, true], "a restart that sends the same proposal gets the same lesson");
    const got = (await c.lessons.get(c.reader, made.id))!;
    assert.deepEqual(got.evidence.map((e) => [e.kind, e.independence, e.repeats ?? null, e.why ?? null]), [
      ["observation", "independent", null, null],
      ["submission", "derived", 0, "same event as an earlier piece"],
      ["review", "independent", null, null],
      ["observation", "independent", null, null],
      ["improvement-item", "independent", null, null],
      ["lesson", "derived", null, "another lesson's conclusion"],
    ]);
    assert.deepEqual([got.independentEvidence, got.version, got.lineage, got.status, got.taskId, got.applicability], [4, 1, made.id, "candidate", c.taskA, "any change to a request handler"]);
    // More evidence later is judged against what is there: another observation of the same review is derived, a new review independent, a repeat is skipped.
    const sameRev = await c.observation([{ kind: "review", id: rev }], "denied");
    const added = await c.lessons.addEvidence(c.mgr, { commandId: cid("ev"), lessonId: made.id, evidence: [{ kind: "submission", id: sbm }, { kind: "review", id: await c.review(c.a, c.taskA, "agent:dev") }] });
    assert.equal(added.independentEvidence, 5);
    await refuses("not_found", () => c.lessons.addEvidence(c.dev, { commandId: cid("ev"), lessonId: made.id, evidence: [{ kind: "observation", id: sameRev }] }), /may add evidence/);
    const more = await c.lessons.addEvidence(c.mgr, { commandId: cid("ev"), lessonId: made.id, evidence: [{ kind: "observation", id: sameRev }] });
    assert.equal(more.independentEvidence, 5, "an observation of an event already cited is derived");
    assert.deepEqual((await c.lessons.get(c.owner, made.id))!.evidence.at(-1)!.repeats, 2);

    // Scope: another project's records, records the proposer may not read, and an agent without the right are refused alike.
    await refuses("invalid_command", () => c.lessons.propose(c.dev, { commandId: cid("l"), projectId: c.a, title: "x", statement: "x", applicability: "x", evidence: [{ kind: "submission", id: "sbm-aaaaaaaaaaaaaaaaaaaa" }] }), /may read/);
    await refuses("invalid_command", () => c.lessons.propose(c.dev2, { commandId: cid("l"), projectId: c.a, title: "x", statement: "x", applicability: "x", evidence: [{ kind: "submission", id: sbm }] }), /may read/);
    await refuses("invalid_command", async () => c.lessons.propose(c.eve, { commandId: cid("l"), projectId: c.b, title: "x", statement: "x", applicability: "x", evidence: [{ kind: "submission", id: await c.submission(c.b, c.taskB, "agent:eve") }], dependsOn: [premise] }), /lessons of this project/);
    // The owner may read everything, yet a lesson of project B still cannot rest on, supersede or contradict a lesson of A, nor cite A's records; nor can B's manager cite them.
    for (const link of ["dependsOn", "supersedes", "contradicts"]) {
      await refuses("invalid_command", async () => c.lessons.propose(c.owner, { commandId: cid("l"), projectId: c.b, title: "x", statement: "x", applicability: "x", evidence: [{ kind: "submission", id: await c.submission(c.b, c.taskB) }], [link]: [premise] } as never), /lessons of this project/);
    }
    await refuses("invalid_command", () => c.lessons.propose(c.owner, { commandId: cid("l"), projectId: c.b, title: "x", statement: "x", applicability: "x", evidence: [{ kind: "submission", id: sbm }] }), /record of this project/);
    await refuses("invalid_command", async () => c.lessons.propose(c.eve, { commandId: cid("l"), projectId: c.b, title: "x", statement: "x", applicability: "x", evidence: [{ kind: "submission", id: await c.submission(c.a, c.taskA, "agent:eve") }] }), /record of this project/);
    await refuses("forbidden", () => c.lessons.propose(c.reader, { commandId: cid("l"), projectId: c.a, title: "x", statement: "x", applicability: "x", evidence: [{ kind: "submission", id: sbm }] }));
    await refuses("invalid_command", () => c.lessons.propose(c.mgr, { commandId: cid("l"), projectId: c.a, title: "x", statement: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789", applicability: "x", evidence: [{ kind: "submission", id: sbm }] }), /credential/);
    assert.equal(await c.lessons.get(c.eve, made.id), undefined, "another project's manager sees nothing");
    assert.equal(await c.lessons.current(c.dev, c.a), undefined, "a proposer without meeting.read sees no list");
  });

  suite("a revision is the next version; accepting it supersedes the old one and sends what rested on it to review, which cannot be accepted again on a superseded premise", async (c) => {
    const base = await c.lesson("Run the slow tests nightly");
    await c.decide(base, "accepted");
    const leaning = await c.lesson("Merge when the fast tests pass", { dependsOn: [base] });
    const pending = await c.lesson("Tag nightly failures", { dependsOn: [base] });
    await c.decide(leaning, "accepted");
    const v2 = await c.lesson("Run the slow tests on every merge", { revises: base });
    assert.deepEqual([(await c.lessons.get(c.owner, v2))!.version, (await c.lessons.get(c.owner, v2))!.lineage, await c.status(base)], [2, base, "accepted"], "proposing a revision changes nothing yet");
    assert.deepEqual((await c.lessons.get(c.owner, base))!.dependents, [leaning, pending]);
    const accepted = await c.decide(v2, "accepted", "the nightly run missed two regressions");
    assert.deepEqual(accepted.marked.sort(), [leaning, pending].sort());
    const old = (await c.lessons.get(c.owner, base))!;
    assert.deepEqual([old.status, old.supersededBy], ["superseded", v2]);
    const stale = (await c.lessons.get(c.owner, leaning))!;
    assert.deepEqual([stale.status, stale.stalePremises.map((p) => [p.id, p.why])], ["needs-review", [[base, "superseded"]]]);
    assert.deepEqual([await c.status(pending), (await c.lessons.get(c.owner, pending))!.stalePremises.length], ["candidate", 1], "a candidate keeps its status and carries the stale premise");
    await refuses("invalid_command", () => c.decide(leaning, "accepted"), /premise .* is superseded/);
    await refuses("invalid_command", async () => c.lessons.propose(c.mgr, { commandId: cid("l"), projectId: c.a, title: "x", statement: "x", applicability: "x", evidence: [{ kind: "submission", id: await c.submission(c.a, c.taskA) }], dependsOn: [base] }), /superseded/);
    // Its own next version rests on the new lesson; accepting it supersedes the stale one.
    const leaning2 = await c.lesson("Merge when the fast tests pass and the merge run is green", { revises: leaning, dependsOn: [v2] });
    await c.decide(leaning2, "accepted");
    assert.deepEqual([await c.status(leaning), (await c.lessons.get(c.owner, leaning2))!.version], ["superseded", 2]);
    // A second revision of a lesson already superseded cannot be accepted.
    const late = await c.lesson("Nightly, but twice", { revises: v2 });
    const rival = await c.lesson("Nightly, three times", { revises: v2 });
    await c.decide(late, "accepted");
    await refuses("invalid_command", () => c.decide(rival, "accepted"), /already superseded/);
    // The current list keeps current lessons only (the owner proposed these, so no outcome waits to be told).
    const listed = (await c.lessons.current(c.reader, c.a, { limit: 100 }))!.items.map((l) => l.id);
    assert.ok(!listed.includes(base) && !listed.includes(leaning) && listed.includes(late) && listed.includes(rival), JSON.stringify(listed));
  });

  suite("an accepted contradiction sends the contradicted lesson and what rests on it to review; reconfirming clears the stale premise", async (c) => {
    const a1 = await c.lesson("Retries hide flaky tests");
    await c.decide(a1, "accepted");
    const dep = await c.lesson("Turn retries off in CI", { dependsOn: [a1] });
    await c.decide(dep, "accepted");
    const cand = await c.lesson("Count retries per test", { dependsOn: [a1] });
    const contra = await c.lesson("Retries are needed for the network tests", { contradicts: [a1] });
    assert.equal(await c.status(a1), "accepted", "a proposed contradiction changes nothing");
    const r = await c.decide(contra, "accepted", "the network tests fail one run in five without them");
    assert.deepEqual(r.marked.sort(), [dep, cand].sort());
    const a1v = (await c.lessons.get(c.owner, a1))!;
    assert.deepEqual([a1v.status, a1v.contradictedBy], ["needs-review", [contra]]);
    assert.deepEqual([await c.status(dep), (await c.lessons.get(c.owner, dep))!.stalePremises[0]!.why, await c.status(cand)], ["needs-review", "contradicted", "candidate"]);
    await refuses("invalid_command", () => c.decide(dep, "accepted"), /premise .* is needs-review/);
    await c.decide(a1, "accepted", "both hold: retries only for the network tests");
    await c.decide(dep, "accepted", "still right outside the network tests");
    const depv = (await c.lessons.get(c.owner, dep))!;
    assert.deepEqual([depv.status, depv.stalePremises], ["accepted", []]);
    // A premise found inconclusive on review is stale for what rests on it too.
    await c.decide(a1, "needs-review", "taking another look");
    await c.decide(a1, "inconclusive", "the data cannot tell");
    assert.deepEqual([await c.status(dep), (await c.lessons.get(c.owner, dep))!.stalePremises.at(-1)!.why], ["needs-review", "inconclusive"]);
    await refuses("invalid_command", () => c.decide(a1, "accepted"), /inconclusive and cannot become accepted/);
  });

  suite("a rejected or inconclusive candidate finishes; the proposer is told once, on the lesson's task; one with nowhere to file waits; only managers decide", async (c) => {
    const notices: OutcomeNotice[] = [];
    let accept = true;
    const sink = { deliver: async (x: OutcomeNotice) => { if (!accept) return false; notices.push(x); return true; } };
    const svc = c.make({ outcomes: sink });
    const evidence = [{ kind: "submission" as const, id: await c.submission(c.a, c.taskA) }];
    const mine = (await svc.propose(c.dev, { commandId: cid("l"), projectId: c.a, title: "Lint before push", statement: "Running lint first saves a review round.", applicability: "every change", evidence })).id;
    const other = (await svc.propose(c.dev, { commandId: cid("l"), projectId: c.a, title: "Pair on migrations", statement: "Two agents on a migration avoid a failed review.", applicability: "database migrations", evidence: [{ kind: "improvement-item", id: await c.improvement(c.a) }] })).id;
    const owners = (await svc.propose(c.owner, { commandId: cid("l"), projectId: c.a, title: "Owner's own", statement: "x", applicability: "y", evidence })).id;
    await refuses("forbidden", () => c.decide(mine, "rejected", "no", c.dev), /may not decide/);
    await refuses("forbidden", () => c.decide(mine, "rejected", "no", c.eve));
    await refuses("invalid_command", () => c.lessons.decide(c.mgr, { commandId: cid("d"), lessonId: mine, expectedRevision: 1, to: "rejected" }), /finding/);
    await c.decide(mine, "evaluating");
    await c.decide(mine, "inconclusive", "two runs, no difference either way");
    await c.decide(other, "rejected", "the migrations failed for other reasons");
    await c.decide(owners, "rejected", "not needed");
    assert.deepEqual([await c.status(mine), (await c.lessons.get(c.owner, mine))!.outcomePending, (await c.lessons.get(c.owner, owners))!.outcomePending], ["inconclusive", true, false]);
    // The proposer reads its own lesson, without who decided it; another agent does not.
    const own = (await c.lessons.get(c.dev, mine))!;
    assert.deepEqual([own.status, own.finding, own.history.map((h) => h.by)], ["inconclusive", "two runs, no difference either way", [c.dev.id, "someone else", "someone else"]]);
    assert.equal(await c.lessons.get(c.dev2, mine), undefined);
    // Finished ones whose proposer has not been told stay listed; the owner's own is gone.
    const listed = async () => (await c.lessons.current(c.owner, c.a))!.items.map((l) => l.id);
    assert.deepEqual(await listed(), [mine, other]);
    accept = false;
    assert.deepEqual(await svc.deliverOutcomes(c.host, c.a), { delivered: [], waiting: [mine, other] });
    accept = true;
    const out = await svc.deliverOutcomes(c.host, c.a);
    assert.deepEqual(out.delivered, [mine, other]);
    assert.deepEqual(notices.map((x) => [x.kind, x.to.id, x.taskId ?? null, x.text]), [
      ["lesson-outcome", c.dev.id, c.taskA, "Your lesson \"Lint before push\" (version 1) was found inconclusive: two runs, no difference either way"],
      ["lesson-outcome", c.dev.id, null, "Your lesson \"Pair on migrations\" (version 1) was rejected: the migrations failed for other reasons"],
    ]);
    assert.deepEqual(await listed(), [], "told and final: off the list");
    assert.deepEqual(await svc.deliverOutcomes(c.host, c.a), { delivered: [], waiting: [] }, "nothing is told twice");
    await refuses("forbidden", () => svc.deliverOutcomes(c.dev, c.a));
    // The notice sink files on the lesson's task with a stable command ID, and leaves a lesson with no task waiting.
    const filed: { commandId: string; taskId: string; to: string }[] = [];
    const real = lessonOutcomeSink({ noticeFromController: async (x) => { filed.push(x); } });
    assert.equal(await real.deliver(notices[0]!), true);
    assert.equal(await real.deliver(notices[1]!), false);
    assert.deepEqual(filed.map((f) => [f.commandId, f.taskId, f.to]), [[`lso:${notices[0]!.key}`, c.taskA, c.dev.id]]);
    // An accepted outcome is told too, and a restart's second service tells nothing again.
    const third = (await svc.propose(c.dev, { commandId: cid("l"), projectId: c.a, title: "Name the branch", statement: "x", applicability: "y", evidence })).id;
    await c.decide(third, "accepted", "it held in three tasks");
    await c.make({ outcomes: sink }).deliverOutcomes(c.host, c.a);
    await svc.deliverOutcomes(c.host, c.a);
    assert.equal(notices.filter((x) => x.refs[0]!.id === third).length, 1);
    assert.match(notices.at(-1)!.text, /was accepted\. Finding: it held in three tasks/);
    assert.deepEqual(await listed(), [third], "an accepted lesson stays current after it is told");
  });

  suite("two controllers proposing lessons on the same premise at once both rest on it", async (c) => {
    const base = await c.lesson("Base");
    await c.decide(base, "accepted");
    const one = c.make(); const two = c.make();
    const ev = async () => [{ kind: "submission" as const, id: await c.submission(c.a, c.taskA) }];
    const [e1, e2, e3, e4] = [await ev(), await ev(), await ev(), await ev()];
    const ids = await Promise.all([
      one.propose(c.mgr, { commandId: cid("l"), projectId: c.a, title: "One", statement: "x", applicability: "y", evidence: e1, dependsOn: [base] }),
      two.propose(c.mgr, { commandId: cid("l"), projectId: c.a, title: "Two", statement: "x", applicability: "y", evidence: e2, dependsOn: [base] }),
      one.propose(c.mgr, { commandId: cid("l"), projectId: c.a, title: "Three", statement: "x", applicability: "y", evidence: e3, dependsOn: [base] }),
      two.propose(c.mgr, { commandId: cid("l"), projectId: c.a, title: "Four", statement: "x", applicability: "y", evidence: e4, dependsOn: [base] }),
    ]);
    assert.deepEqual([...(await c.lessons.get(c.owner, base))!.dependents].sort(), ids.map((x) => x.id).sort());
    assert.equal((await c.lessons.current(c.owner, c.a, { limit: 100 }))!.items.length, 5);
    // Rejecting the base marks every one of them.
    const marked = await c.decide(base, "needs-review", "look again");
    assert.deepEqual(marked.marked, [], "taking a lesson up for review is not yet a stale premise");
    assert.equal((await c.decide(base, "rejected", "it was wrong")).marked.length, 4);
  });

  suite("an agent's own word counts once however worded; finished lessons free a crowded premise; an acceptance that would stale its own premise is refused; a stale premise carries its latest reason", async (c) => {
    // Accounts with no event behind them: two reworded friction reports and two proposals by the same agent are one independent piece; another agent's report is a second one.
    const obs = ObservationService.withEpoch(c.storage, c.epoch, options);
    const said = async (by: Principal, summary: string) => ((await obs.submit(by, { commandId: cid("o"), projectId: c.a, summary })) as { id: string }).id;
    const o1 = await said(c.dev, "the build is slow on large changes");
    const o2 = await said(c.dev, "big changes take ages to build");
    const o3 = await said(c.mgr, "the build is slow");
    assert.notEqual(o1, o2, "different words are different observations");
    const words = (await c.lessons.propose(c.mgr, { commandId: cid("l"), projectId: c.a, title: "Split large changes", statement: "Large changes build slowly.", applicability: "large changes",
      evidence: [{ kind: "observation", id: o1 }, { kind: "observation", id: o2 }, { kind: "improvement-item", id: await c.improvement(c.a) }, { kind: "improvement-item", id: await c.improvement(c.a) }, { kind: "observation", id: o3 }] })).id;
    const w = (await c.lessons.get(c.owner, words))!;
    assert.deepEqual(w.evidence.map((e) => [e.independence, e.repeats ?? null, e.why ?? null]), [
      ["independent", null, null], ["derived", 0, "same reporter's own account as an earlier piece"], ["derived", 0, "same reporter's own account as an earlier piece"],
      ["derived", 0, "same reporter's own account as an earlier piece"], ["independent", null, null],
    ]);
    assert.equal(w.independentEvidence, 2);
    // The proposer reading its own lesson sees itself, not who else added evidence.
    const devs = (await c.lessons.propose(c.dev, { commandId: cid("l"), projectId: c.a, title: "Builds", statement: "x", applicability: "y", evidence: [{ kind: "observation", id: o1 }] })).id;
    await c.lessons.addEvidence(c.mgr, { commandId: cid("ev"), lessonId: devs, evidence: [{ kind: "submission", id: await c.submission(c.a, c.taskA) }] });
    assert.deepEqual((await c.lessons.get(c.dev, devs))!.evidence.map((e) => e.addedBy), [c.dev.id, "someone else"]);
    assert.deepEqual((await c.lessons.get(c.owner, devs))!.evidence.map((e) => e.addedBy), [c.dev.id, c.mgr.id]);

    // Twenty lessons crowd a premise; rejecting some frees room for another, and the finished ones leave its list.
    const base = await c.lesson("Base");
    await c.decide(base, "accepted");
    const crowd: string[] = [];
    for (let i = 0; i < 20; i++) crowd.push(await c.lesson(`Crowd ${i}`, { dependsOn: [base] }, c.mgr));
    await refuses("unavailable", () => c.lesson("One more", { dependsOn: [base] }), /20 current lessons resting on it/);
    await c.decide(crowd[3]!, "rejected", "noise");
    await c.decide(crowd[7]!, "rejected", "noise");
    const room = await c.lesson("One more", { dependsOn: [base] });
    const deps = (await c.lessons.get(c.owner, base))!.dependents;
    assert.deepEqual([deps.length, deps.includes(room), deps.includes(crowd[3]!), deps.includes(crowd[7]!)], [19, true, false, false]);

    // P rests on Q; L rests on P and supersedes Q: accepting L would send its own premise P to review in the same write, so it is refused and nothing changes.
    const q = await c.lesson("Q"); await c.decide(q, "accepted");
    const p = await c.lesson("P", { dependsOn: [q] }); await c.decide(p, "accepted");
    const l = await c.lesson("L", { dependsOn: [p], supersedes: [q] });
    await refuses("invalid_command", () => c.decide(l, "accepted"), /premise .* would become needs-review through this acceptance/);
    assert.deepEqual([await c.status(q), await c.status(p), await c.status(l)], ["accepted", "accepted", "candidate"]);

    // A premise contradicted, then rejected on review: its dependent carries one entry, with the latest reason.
    const k = await c.lesson("K", { contradicts: [q] });
    const dq = await c.lesson("Rests on Q", { dependsOn: [q] });
    await c.decide(k, "accepted");
    assert.deepEqual((await c.lessons.get(c.owner, dq))!.stalePremises.map((s) => [s.id, s.why]), [[q, "contradicted"]]);
    const rejected = await c.decide(q, "rejected", "it was wrong");
    assert.ok(rejected.marked.includes(dq), JSON.stringify(rejected.marked));
    assert.deepEqual((await c.lessons.get(c.owner, dq))!.stalePremises.map((s) => [s.id, s.why]), [[q, "rejected"]]);
  });

  suite("second review: versions in a chain, final decisions, a premise found inconclusive, the proposer's view of events, a stable outcome key, and two controllers deciding at once", async (c) => {
    // A <- B <- C: accepting version 3 over a candidate version 2 replaces version 1 too (and marks what rested on it); it never leaves two accepted versions of one lineage.
    const a1 = await c.lesson("Version one"); await c.decide(a1, "accepted");
    const onA1 = await c.lesson("Rests on version one", { dependsOn: [a1] }); await c.decide(onA1, "accepted");
    const b1 = await c.lesson("Version two", { revises: a1 });
    const c1 = await c.lesson("Version three", { revises: b1 });
    assert.equal((await c.lessons.get(c.owner, c1))!.version, 3);
    const r = await c.decide(c1, "accepted");
    assert.deepEqual([await c.status(a1), (await c.lessons.get(c.owner, a1))!.supersededBy, await c.status(b1), await c.status(onA1)], ["superseded", c1, "superseded", "needs-review"]);
    assert.ok(r.marked.includes(onA1), JSON.stringify(r.marked));
    // A version 3 on a branch that lost (version 1 already replaced by a rival version 2) cannot be accepted, and nothing changes.
    const x1 = await c.lesson("X one"); await c.decide(x1, "accepted");
    const x2 = await c.lesson("X two", { revises: x1 });
    const x2rival = await c.lesson("X two, rival", { revises: x1 });
    const x3 = await c.lesson("X three", { revises: x2 });
    await c.decide(x2rival, "accepted");
    await refuses("invalid_command", () => c.decide(x3, "accepted"), /earlier version, lesson .* is already superseded/);
    assert.deepEqual([await c.status(x2), await c.status(x3)], ["candidate", "candidate"]);

    // A full premise makes room only by dropping finished dependents (superseded, inconclusive): every open one (accepted, evaluating, under review, candidate) stays, and is marked when the premise is replaced.
    const base = await c.lesson("Crowded base"); await c.decide(base, "accepted");
    const crowd: string[] = [];
    for (let i = 0; i < 20; i++) crowd.push(await c.lesson(`On base ${i}`, { dependsOn: [base] }));
    await c.decide(crowd[0]!, "accepted");
    await c.decide(crowd[1]!, "evaluating");
    await c.decide(crowd[2]!, "accepted"); await c.decide(crowd[2]!, "needs-review", "look again");
    await c.decide(await c.lesson("Replaces crowd 3", { revises: crowd[3]! }), "accepted");
    await c.decide(crowd[4]!, "inconclusive", "cannot tell");
    const extra = await c.lesson("One more on base", { dependsOn: [base] });
    const kept = (await c.lessons.get(c.owner, base))!.dependents;
    assert.deepEqual([kept.length, kept.includes(extra), kept.includes(crowd[3]!), kept.includes(crowd[4]!)], [19, true, false, false]);
    assert.ok([0, 1, 2, ...Array.from({ length: 15 }, (_, i) => i + 5)].every((i) => kept.includes(crowd[i]!)), "no open lesson leaves its premise's list");
    const replaced = await c.decide(await c.lesson("Replaces base", { supersedes: [base] }), "accepted");
    assert.deepEqual([...replaced.marked].sort(), [...kept].sort());
    assert.deepEqual([await c.status(crowd[0]!), await c.status(crowd[1]!), await c.status(crowd[2]!)], ["needs-review", "evaluating", "needs-review"]);

    // Decisions: rejected and inconclusive are final; an accepted lesson changes only by being taken up for review first.
    const f = await c.lesson("Final"); await c.decide(f, "rejected", "no");
    for (const to of ["accepted", "evaluating", "needs-review", "inconclusive"]) await refuses("invalid_command", () => c.decide(f, to), /rejected and cannot become/);
    const g = await c.lesson("Reopened"); await c.decide(g, "accepted");
    await refuses("invalid_command", () => c.decide(g, "rejected", "no"), /accepted and cannot become rejected/);
    await c.decide(g, "needs-review", "look again"); await c.decide(g, "accepted", "still holds");
    await refuses("invalid_command", async () => c.lessons.propose(c.mgr, { commandId: cid("l"), projectId: c.a, title: "v2", statement: "x", applicability: "y", evidence: [{ kind: "submission", id: await c.submission(c.a, c.taskA) }], revises: f }), /is rejected/);

    // A lesson whose premise was found inconclusive cannot be accepted.
    const p = await c.lesson("Premise"); const d = await c.lesson("On the premise", { dependsOn: [p] });
    await c.decide(p, "inconclusive", "cannot tell");
    assert.deepEqual((await c.lessons.get(c.owner, d))!.stalePremises.map((s) => [s.id, s.why]), [[p, "inconclusive"]]);
    await refuses("invalid_command", () => c.decide(d, "accepted"), /premise .* is inconclusive/);

    // The proposer's own view hides who else's account a piece rests on, as it hides who added it.
    const obs = ObservationService.withEpoch(c.storage, c.epoch, options);
    const mine = ((await obs.submit(c.dev, { commandId: cid("o"), projectId: c.a, summary: "my build is slow" })) as { id: string }).id;
    const theirs = ((await obs.submit(c.mgr, { commandId: cid("o"), projectId: c.a, summary: "the manager's build is slow" })) as { id: string }).id;
    const devs = (await c.lessons.propose(c.dev, { commandId: cid("l"), projectId: c.a, title: "Slow builds", statement: "x", applicability: "y", evidence: [{ kind: "observation", id: mine }] })).id;
    await c.lessons.addEvidence(c.mgr, { commandId: cid("ev"), lessonId: devs, evidence: [{ kind: "observation", id: theirs }] });
    assert.deepEqual((await c.lessons.get(c.dev, devs))!.evidence.map((e) => e.events), [[`account:${c.dev.id}`], ["account:someone else"]]);
    assert.deepEqual((await c.lessons.get(c.owner, devs))!.evidence.map((e) => e.events), [[`account:${c.dev.id}`], [`account:${c.mgr.id}`]]);

    // A notice filed but not confirmed is offered again under the same key, so the notice sink files it once.
    const keys: string[] = [];
    let confirm = false;
    const svc = c.make({ outcomes: { deliver: async (x: OutcomeNotice) => { keys.push(x.key); return confirm; } } });
    const told = (await svc.propose(c.dev, { commandId: cid("l"), projectId: c.a, title: "Told", statement: "x", applicability: "y", evidence: [{ kind: "submission", id: await c.submission(c.a, c.taskA) }] })).id;
    await c.decide(told, "rejected", "no");
    await svc.deliverOutcomes(c.host, c.a);
    await c.make({ outcomes: { deliver: async (x: OutcomeNotice) => { keys.push(x.key); return confirm; } } }).deliverOutcomes(c.host, c.a);
    confirm = true;
    await svc.deliverOutcomes(c.host, c.a);
    await svc.deliverOutcomes(c.host, c.a);
    const toldKeys = keys.filter((k) => k.startsWith(told));
    assert.equal(toldKeys.length, 3);
    assert.equal(new Set(toldKeys).size, 1, JSON.stringify(toldKeys));

    // Two controllers at once: one accepts a lesson resting on P, the other accepts a lesson that supersedes P. Whatever the order, no lesson is left accepted on a superseded premise.
    for (let round = 0; round < 3; round++) {
      const prem = await c.lesson(`P${round}`); await c.decide(prem, "accepted");
      const dep = await c.lesson(`D${round}`, { dependsOn: [prem] });
      const repl = await c.lesson(`R${round}`, { supersedes: [prem] });
      const one = c.make(); const two = c.make();
      const rev = async (x: string) => (await c.lessons.get(c.owner, x))!.revision;
      const [rd, rr] = [await rev(dep), await rev(repl)];
      await Promise.allSettled([
        one.decide(c.mgr, { commandId: cid("d"), lessonId: dep, expectedRevision: rd, to: "accepted", finding: "ok" }),
        two.decide(c.mgr, { commandId: cid("d"), lessonId: repl, expectedRevision: rr, to: "accepted", finding: "ok" }),
      ]);
      assert.equal(await c.status(repl), "accepted", "the replacement always goes through");
      assert.equal(await c.status(prem), "superseded");
      assert.notEqual(await c.status(dep), "accepted", `round ${round}: a lesson was left accepted on a superseded premise`);
    }
  });

  if (backend.name === backends[0]!.name) {
    suite("finished lessons waiting to be told do not count against the open-lesson limit, so a project cannot be locked by them", async (c) => {
      // An agent's lessons with no task have nowhere to be told; rejected, they stay listed (waiting) but are no longer open.
      const ids: string[] = [];
      for (let i = 0; i < 500; i++) ids.push((await c.lessons.propose(c.dev, { commandId: cid("l"), projectId: c.a, title: `L${i}`, statement: "x", applicability: "y", evidence: [{ kind: "improvement-item", id: await c.improvement(c.a) }] })).id);
      await refuses("unavailable", () => c.lesson("Over"), /500 lessons are open/);
      for (const id of ids.slice(0, 3)) await c.decide(id, "rejected", "noise");
      assert.equal((await c.lessons.get(c.owner, ids[0]!))!.outcomePending, true);
      const fresh = await c.lesson("Room again");
      assert.equal(await c.status(fresh), "candidate");
      // Second review: finished lessons that can never be told filled the list (1000) for good, and every new lesson was refused as if 500 were open. The oldest finished one now leaves the list instead;
      // it stays readable, still waiting to be told.
      for (const id of ids.slice(3)) await c.decide(id, "rejected", "noise");
      const more: string[] = [];
      for (let i = 0; i < 499; i++) more.push((await c.lessons.propose(c.dev, { commandId: cid("l"), projectId: c.a, title: `M${i}`, statement: "x", applicability: "y", evidence: [{ kind: "improvement-item", id: await c.improvement(c.a) }] })).id);
      await c.decide(more[0]!, "rejected", "noise");
      const all = async (): Promise<string[]> => { const out: string[] = []; let after: string | undefined; do { const p = (await c.lessons.current(c.owner, c.a, { limit: 100, ...(after === undefined ? {} : { afterId: after }) }))!; out.push(...p.items.map((x) => x.id)); after = p.next; } while (after !== undefined); return out; };
      assert.equal((await all()).length, 1000);
      const last = await c.lesson("Room at a full list");
      const listed = await all();
      assert.deepEqual([listed.length, listed.includes(last), listed.includes(ids[0]!), listed.includes(ids[1]!), listed.includes(fresh)], [1000, true, false, true, true]);
      assert.deepEqual([(await c.lessons.get(c.owner, ids[0]!))!.status, (await c.lessons.get(c.dev, ids[0]!))!.outcomePending], ["rejected", true]);
      // Open lessons are never dropped: with 500 open the next is still refused.
      await refuses("unavailable", async () => { for (let i = 0; i < 2; i++) await c.lesson(`Fill ${i}`); }, /500 lessons are open/);
    });
  }
}

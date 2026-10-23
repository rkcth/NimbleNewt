import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openWorld, cid, options, type World } from "../chat/testing/harness.js";
import { ContextBranchService } from "../branches/index.js";
import { ConfigurationService } from "../configuration/index.js";
import { ContextEnforcementService, HistoryService, buildStartup, contextBudget, type SourceRef, type Summariser } from "../context/index.js";
import { BlockerService } from "../domain/blockers.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { EffectService, type EffectBridge } from "../domain/effects.js";
import { backends, stopServer, type Backend } from "../domain/testing/backends.js";
import { EventService } from "../events/index.js";
import { GenerationRefused, GenerationService, type RefusalReason } from "../generation/index.js";
import { PauseService } from "../lifecycle/index.js";
import { ReviewService, type Operation } from "../review/index.js";
import type { Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { derivedId } from "../domain/ids.js";
import { scopedCommandId } from "../security/credentials.js";
import { DecisionService, startupItems, type DecisionDeps, type RecordDecision } from "./index.js";

after(stopServer);

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const refusedFor = async (reason: RefusalReason, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof GenerationRefused, String(error)); assert.equal(error.reason, reason, error.message); return true; });
};
const bridge = (log: string[]): EffectBridge => ({ idempotent: true, execute: async (r): Promise<JsonObject> => { log.push(r.key); return { receipt: log.length }; } });
const op = (): Operation => ({ name: "run-script", args: { cwd: "/work" }, script: "make deploy\n", target: { kind: "workspace", id: "main" } });
const context = { toolVersion: "1.2.3", authoritySource: "task grant", expectedEffects: ["deploys"], affectedResources: ["workspace:main"] };
const summariser = (out: string): Summariser => ({ route: "local", summarise: async () => out });

/** Everything a decision test needs over one backend, wired the way production would: the guard sits in generation and review, and the decision service tells events and interrupts generations. */
async function rig(backend: Backend, flaky?: { failEvents: number }) {
  const w = await openWorld(backend);
  const st = w.world.storage, epoch = w.projects.epoch;
  const effects = EffectService.withEpoch(st, epoch, w.assignments, { holder: "exec-1", ...options });
  const realEvents = EventService.withEpoch(st, epoch, options);
  const published: string[] = [];
  // The events seam: counts what is published and can refuse a few publishes, to stage a pass that dies half way.
  const events = {
    publish: async (by: Principal, command: Parameters<EventService["publish"]>[1]): ReturnType<EventService["publish"]> => {
      if (flaky !== undefined && flaky.failEvents > 0) { flaky.failEvents--; return { accepted: false, retryAfterSeconds: 5, reason: "the subscriber is behind" }; }
      const r = await realEvents.publish(by, command);
      if (r.accepted && !r.duplicate) published.push(`${command.stream}:${command.kind}`);
      return r;
    },
  } as unknown as EventService;
  const deps = { events, effects } as { -readonly [K in keyof DecisionDeps]: DecisionDeps[K] };
  const decisions = DecisionService.withEpoch(st, epoch, deps, options);
  const reopen = (): DecisionService => DecisionService.withEpoch(st, epoch, deps, options);
  const pauses = PauseService.withEpoch(st, epoch, {}, options);
  const gen = GenerationService.withEpoch(st, epoch, { assignments: w.assignments, effects, pauses, decisions }, options);
  deps.generation = gen;
  const reviews = ReviewService.withEpoch(st, epoch, { ...options, decisions });
  const histories = HistoryService.withEpoch(st, epoch, options);
  const branches = ContextBranchService.withEpoch(st, epoch, { histories, retrieval: w.retrieval }, options);
  const a = await w.project("A");
  const b = await w.project("B");
  const t1 = await w.task(a, "first task");
  const t2 = await w.task(a, "second task");
  const tb = await w.task(b, "task in B");
  const work = (p: string) => [{ action: "attempt.work", project: p }, { action: "effect.perform", project: p }, { action: "desk.write", project: p }, { action: "desk.read", project: p }, { action: "history.read", project: p }, { action: "history.append", project: p }, { action: "review.request", project: p }, { action: "tool.run-script", project: p }];
  const ann = (await w.agent("ann", work(a))).principal;
  const ben = (await w.agent("ben", [{ action: "attempt.work", project: a }, { action: "effect.perform", project: a }])).principal;
  const rev = (await w.agent("rev", [{ action: "review.decide", project: a }, { action: "history.read", project: a }])).principal;
  const eve = (await w.agent("eve", [...work(b)])).principal;
  await w.principals.enroll(w.owner, { commandId: cid("h"), kind: "host", name: "h1", grants: [{ action: "assignment.manage", project: a }, { action: "assignment.read", project: a }] });
  const host = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:h1")).token);
  const say = async (text: string, quoted?: string[]): Promise<string> => (await w.chat().submit(w.ownerToken, { messageId: cid("m"), text, ...(quoted === undefined ? {} : { quoted }) })).turnId;
  const decide = (over: Partial<RecordDecision> & Record<string, unknown> = {}, as: DecisionService = decisions, by: Principal = w.owner) =>
    as.record(by, { commandId: cid("dec"), projectId: a, category: "decision", topic: "database", statement: "Use PostgreSQL for the controller", wording: "We will use PostgreSQL for the controller", source: { channel: "direct" }, basedOn: 0, ...over } as never);
  const recorded = async (over: Partial<RecordDecision> & Record<string, unknown> = {}, as?: DecisionService) => { const r = await decide(over, as); assert.equal(r.recorded, true, JSON.stringify(r)); return r as Extract<typeof r, { recorded: true }>; };
  const plan = async (taskId: string, by: Principal = ann): Promise<string> => (await w.desks.write(by, { commandId: cid("pl"), projectId: a, taskId, kind: "plan", title: "plan", body: "step one", visibility: "shared", status: "accepted" })).id;
  const work1 = async (taskId: string, by: Principal = ann): Promise<string> => { const r = await gen.begin(by, { commandId: cid("b"), taskId, contextRevision: (await gen.gate(w.owner, taskId))?.gate.contextRevision ?? 1 }); return r.id; };
  const withCall = async (taskId: string, by: Principal = ann): Promise<string> => {
    const run = await work1(taskId, by);
    await gen.record(by, { commandId: cid("c"), runId: run, seq: 1, toolCall: { id: "c1", name: "deploy", argumentsDelta: '{"to":"prod"}', done: true } });
    await gen.complete(by, { commandId: cid("done"), runId: run });
    return run;
  };
  const admit = (run: string, by: Principal = ann) => gen.admitEffect(by, { commandId: cid("ad"), runId: run, toolCallId: "c1", kind: "deploy", target: "prod" });
  const intend = async (taskId: string): Promise<string> => (await effects.intend({ commandId: cid("in"), actor: ann.id, kind: "deploy", target: "prod", input: { n: n_++ }, taskId })).id;
  return { w, st, epoch, effects, events, published, decisions, reopen, pauses, gen, reviews, branches, histories, a, b, t1, t2, tb, ann, ben, rev, eve, host, say, decide, recorded, plan, work1, withCall, admit, intend, deps, realEvents };
}
let n_ = 0;
const flakyRef = { failEvents: 100000 };
type Rig = Awaited<ReturnType<typeof rig>>;

for (const backend of backends) {
  const suite = (name: string, body: (r: Rig) => Promise<void>, flaky?: { failEvents: number }) =>
    test(`${backend.name}: ${name}`, async () => {
      const r = await rig(backend, flaky);
      try { await body(r); } finally { await r.w.close(); }
    });
  const link = (r: Rig, taskId: string, subject: { kind: string; id: string }, ids: string[], by: Principal = r.ann) => r.decisions.link(by, { commandId: cid("lk"), taskId, subject, decisions: ids } as never);

  suite("only the owner's own words make a decision; it keeps wording, scope, version, origin and source, apart from the agents' conclusions", async (r) => {
    const turn = await r.say("We will use PostgreSQL for the controller, and that is final");
    const first = await r.recorded({ source: { channel: "chat", turnId: turn }, wording: "use PostgreSQL for the controller", session: "laptop" });
    const d = (await r.decisions.get(r.w.owner, first.id))!;
    assert.deepEqual([d.state, d.version, d.category, d.topic, d.wording, d.supersedes, d.source.channel, d.source.turnId, d.origin.principalId, d.origin.session], ["active", 1, "decision", "database", "use PostgreSQL for the controller", [], "chat", turn, "owner:rob", "laptop"]);
    assert.ok(d.origin.credentialId, "the origin carries the credential the owner authenticated with");
    // Nobody else records one, whatever they hold, and no one names an actor.
    for (const who of [r.ann, r.ben, r.host, r.rev]) await refuses("forbidden", () => r.decide({}, r.decisions, who));
    await refuses("invalid_command", () => r.decide({ actor: "owner:rob" } as never), (e) => assert.match(e.message, /actor/));
    // An agent's own "decision" on its desk is a conclusion: it is not the owner's, and it governs nothing.
    await r.w.desks.write(r.ann, { commandId: cid("w"), projectId: r.a, kind: "decision", title: "database", body: "use MySQL", visibility: "shared", status: "accepted" });
    const auth = (await r.decisions.authoritative(r.w.owner, { projectId: r.a, topic: "database" }))!;
    assert.deepEqual([auth.status, auth.status === "decided" ? auth.decision.statement : ""], ["decided", "Use PostgreSQL for the controller"]);
    // The wording must be in a turn of the owner's own; a made-up turn or other words are refused.
    await refuses("invalid_command", () => r.decide({ source: { channel: "chat", turnId: turn }, wording: "something the owner never said" }));
    await refuses("invalid_command", () => r.decide({ source: { channel: "chat", turnId: "turn-doesnotexist" } }));
    // Credential-shaped text is not recorded.
    await refuses("invalid_command", () => r.decide({ topic: "keys", wording: "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }));
  });

  suite("brainstorming, hypotheticals, quoted text, questions and an agent's paraphrase create no decision", async (r) => {
    const before = (await r.decisions.context(r.w.owner, { projectId: r.a }))!.version;
    for (const stance of ["brainstorm", "hypothetical", "quoted", "paraphrase", "question"]) {
      const x = await r.decide({ stance: stance as never });
      assert.equal(x.recorded, false, stance);
    }
    for (const wording of ["what if we used MySQL instead of PostgreSQL", "maybe we could switch the database later", "Should the controller use PostgreSQL?", "for example we might pick SQLite"]) {
      const x = await r.decide({ wording });
      assert.deepEqual([x.recorded, (x as { reason: string }).reason.includes("nothing was recorded")], [false, true], wording);
    }
    // Words that sit in a quoted block of the owner's message are not the owner's words.
    const turn = await r.say("As a comment, see below\n> Use MySQL for everything now\nthanks");
    await refuses("invalid_command", () => r.decide({ source: { channel: "chat", turnId: turn }, wording: "Use MySQL for everything now" }));
    const turn2 = await r.say("fine", ["Use MySQL for everything now"]);
    await refuses("invalid_command", () => r.decide({ source: { channel: "chat", turnId: turn2 }, wording: "Use MySQL for everything now" }));
    // A paraphrase by an agent cannot become a decision: the agent is not the owner.
    await refuses("forbidden", () => r.decide({ wording: "the owner said we use MySQL" }, r.decisions, r.ann));
    const ctx = (await r.decisions.context(r.w.owner, { projectId: r.a }))!;
    assert.deepEqual([ctx.version, ctx.decisions.length], [before, 0], "nothing was written");
  });

  suite("a correction supersedes only the conflicting decisions in its scope, is authoritative at once, and the old ones stay visible and non-authoritative", async (r) => {
    const project = await r.recorded({ topic: "database" });
    const onT1 = await r.recorded({ topic: "database", taskId: r.t1, statement: "Task one uses SQLite for its test fixtures", wording: "task one uses SQLite for fixtures", basedOn: 1 });
    const other = await r.recorded({ topic: "language", statement: "TypeScript", wording: "write everything in TypeScript" });
    const onT2 = await r.recorded({ topic: "database", taskId: r.t2, statement: "Task two uses DuckDB", wording: "task two uses DuckDB for analysis", basedOn: 1 });
    // A task-level correction touches that task's decision only.
    const fix = await r.recorded({ topic: "database", taskId: r.t1, statement: "Task one uses PostgreSQL after all", wording: "task one will use PostgreSQL after all", basedOn: 2 });
    assert.deepEqual(fix.superseded, [onT1.id]);
    assert.equal((await r.decisions.get(r.w.owner, onT2.id))!.state, "active");
    assert.equal((await r.decisions.get(r.w.owner, project.id))!.state, "active");
    // A project-wide correction supersedes the project's decision and the task-level ones on that topic; other topics are untouched.
    const wide = await r.recorded({ topic: "database", statement: "Use CockroachDB everywhere", wording: "everything uses CockroachDB now", basedOn: 4 });
    assert.deepEqual([...wide.superseded].sort(), [project.id, fix.id, onT2.id].sort());
    assert.equal((await r.decisions.get(r.w.owner, other.id))!.state, "active");
    // Authoritative at once: the next read, for any task, is the new decision.
    for (const taskId of [r.t1, r.t2, undefined]) {
      const a = (await r.decisions.authoritative(r.w.owner, { projectId: r.a, ...(taskId === undefined ? {} : { taskId }), topic: "database" }))!;
      assert.deepEqual([a.status, a.status === "decided" ? a.decision.id : ""], ["decided", wide.id]);
    }
    // The superseded ones stay, in order, marked non-authoritative, with what replaced them.
    const history = await r.decisions.history(r.w.owner, { projectId: r.a, topic: "database" });
    assert.deepEqual(history.map((d) => [d.version, d.state]), [[1, "superseded"], [2, "superseded"], [3, "superseded"], [4, "superseded"], [5, "active"]], "every version stays, in order, with its state");
    assert.deepEqual(history.map((d) => d.supersededBy), [wide.id, fix.id, wide.id, wide.id, undefined]);
    // A session that had not seen the task-level exception cannot silently override it: it is a conflict, not a correction.
    const stale = await r.decide({ topic: "database", statement: "Use Oracle everywhere", wording: "everything uses Oracle now", basedOn: 3 });
    assert.ok((stale as { disputeId?: string }).disputeId, "a stale project-wide correction is surfaced");
  });

  suite("a decision said again is not recorded twice or asked again; a question the owner already settled is answered from the record, and one open question is not asked twice", async (r) => {
    const first = await r.recorded({});
    const again = await r.decide({ statement: "use postgresql for the controller", wording: "yes, PostgreSQL it is" });
    assert.deepEqual([again.recorded, (again as { decisionId?: string }).decisionId], [false, first.id]);
    const asked = await r.decisions.ask(r.ann, { commandId: cid("q"), taskId: r.t1, topic: "Database", question: "Which database should the controller use?" });
    assert.deepEqual([asked.asked, asked.decided?.id], [false, first.id], "the owner is not asked again");
    // An undecided topic: one question, however many agents ask.
    const q1 = await r.decisions.ask(r.ann, { commandId: cid("q"), taskId: r.t1, topic: "logging", question: "Which log format?" });
    assert.equal(q1.asked, true);
    const q2 = await r.decisions.ask(r.ben, { commandId: cid("q"), taskId: r.t2, topic: "logging", question: "Which log format do we use?" });
    assert.deepEqual([q2.asked, q2.questionId], [false, q1.questionId]);
    const withQ = (await r.decisions.context(r.w.owner, { projectId: r.a }))!;
    assert.deepEqual(withQ.questions.map((q) => q.topic), ["logging"]);
    assert.equal(startupItems(withQ).some((i) => i.id === q1.questionId), true);
    // The owner's decision answers and closes it; asking now returns the decision.
    const decided = await r.recorded({ topic: "logging", statement: "JSON lines", wording: "log in JSON lines please" });
    assert.equal((await r.decisions.context(r.w.owner, { projectId: r.a }))!.questions.length, 0);
    const after = await r.decisions.ask(r.ben, { commandId: cid("q"), taskId: r.t2, topic: "logging", question: "Which log format?" });
    assert.deepEqual([after.asked, after.decided?.id], [false, decided.id]);
    // The owner can also set a question aside; only the owner.
    const q3 = await r.decisions.ask(r.ann, { commandId: cid("q"), taskId: r.t1, topic: "tracing", question: "Trace everything?" });
    await refuses("forbidden", () => r.decisions.dismissQuestion(r.ann, { commandId: cid("dq"), questionId: q3.questionId!, reason: "no" }));
    await r.decisions.dismissQuestion(r.w.owner, { commandId: cid("dq"), questionId: q3.questionId!, reason: "not needed now" });
    assert.equal((await r.decisions.context(r.w.owner, { projectId: r.a }))!.questions.length, 0);
    // A worker of another project cannot ask about this task.
    await refuses("forbidden", () => r.decisions.ask(r.eve, { commandId: cid("q"), taskId: r.t1, topic: "x", question: "hello" }));
  });

  suite("conflicting instructions from two owner sessions are surfaced, block the disputed action, and only the owner's choice settles them", async (r) => {
    const base = await r.recorded({});
    await link(r, r.t1, { kind: "task", id: r.t1 }, [base.id]);
    const sub = await r.realEvents.subscribe(r.host, { commandId: cid("s"), stream: `task:${r.t1}`, fromStart: true });
    // Two sessions both saw version 1; the first corrects it and the second, not having seen that, says something else.
    const one = await r.recorded({ statement: "Use MySQL", wording: "switch the controller to MySQL", basedOn: 1, session: "phone" });
    await r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [one.id], note: "re-read" });
    const two = await r.decide({ statement: "Use SQLite", wording: "make it SQLite for the controller", basedOn: 1, session: "laptop" });
    assert.equal(two.recorded, true);
    const dispute = (two as { disputeId?: string }).disputeId!;
    assert.ok(dispute, "the conflict is surfaced");
    const twoId = (two as { id: string }).id;
    const auth = (await r.decisions.authoritative(r.w.owner, { projectId: r.a, topic: "database" }))!;
    assert.equal(auth.status, "disputed", "neither arrival order nor anything else makes one of them authoritative");
    assert.deepEqual([(await r.decisions.get(r.w.owner, one.id))!.state, (await r.decisions.get(r.w.owner, twoId))!.state], ["disputed", "disputed"]);
    const ctx = (await r.decisions.context(r.w.owner, { projectId: r.a }))!;
    assert.deepEqual([ctx.decisions.length, ctx.disputes.length], [0, 1]);
    assert.ok(startupItems(ctx).some((i) => i.kind === "human" && /UNRESOLVED CONFLICT/.test(i.text)), "every new agent is told");
    assert.deepEqual((await r.realEvents.pull(r.host, sub.id)).events.map((e) => e.kind), ["decision-superseded", "decision-disputed"], "the task is told about the correction, then about the conflict");
    // The disputed action is blocked, and a further decision on the topic is refused until the owner chooses.
    const run = await r.withCall(r.t1);
    await refusedFor("decision", () => r.admit(run));
    await refuses("invalid_command", () => r.decide({ statement: "Use Oracle", wording: "go with Oracle instead", basedOn: 2 }), (e) => assert.match(e.message, /unresolved conflict/));
    // Agents, hosts and a vote of agents cannot settle it.
    for (const who of [r.ann, r.ben, r.host]) await refuses("forbidden", () => r.decisions.resolveDispute(who, { commandId: cid("rd"), disputeId: dispute, chosen: one.id }));
    // The owner picks one; the other is superseded. Work that relied on the one now superseded needs revalidating against the chosen decision.
    const settled = await r.decisions.resolveDispute(r.w.owner, { commandId: cid("rd"), disputeId: dispute, chosen: twoId });
    assert.equal(settled.replayed, false);
    assert.deepEqual([(await r.decisions.get(r.w.owner, one.id))!.state, (await r.decisions.get(r.w.owner, twoId))!.state], ["superseded", "active"]);
    await refuses("invalid_command", () => r.decisions.resolveDispute(r.w.owner, { commandId: cid("rd"), disputeId: dispute, chosen: twoId }), (e) => assert.match(e.message, /already resolved/));
    assert.equal((await r.realEvents.pull(r.host, sub.id)).events.at(-1)?.kind, "decision-resolved");
    const afterChoice = await r.withCall(r.t1);
    await refusedFor("decision", () => r.admit(afterChoice));
    await r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [twoId], note: "re-read the owner's choice" });
    assert.equal((await r.admit(afterChoice)).replayed, false);
  });

  suite("when the owner chooses the decision the work already relied on, the work goes on without revalidation", async (r) => {
    const base = await r.recorded({});
    await link(r, r.t1, { kind: "task", id: r.t1 }, [base.id]);
    const other = await r.decide({ statement: "Use SQLite", wording: "make it SQLite for the controller", basedOn: 0 });
    const dispute = (other as { disputeId: string }).disputeId;
    assert.equal(startupItems((await r.decisions.context(r.w.owner, { projectId: r.a, taskId: r.t1 }))!).filter((i) => /CONFLICT/.test(i.text)).length, 1);
    const blockedRun = await r.withCall(r.t1);
    await refusedFor("decision", () => r.admit(blockedRun));
    await r.decisions.resolveDispute(r.w.owner, { commandId: cid("rd"), disputeId: dispute, chosen: base.id });
    assert.deepEqual([(await r.decisions.get(r.w.owner, base.id))!.state, (await r.decisions.get(r.w.owner, (other as { id: string }).id))!.state], ["active", "superseded"]);
    assert.equal((await r.admit(await r.withCall(r.t1))).replayed, false);
  });

  suite("two sessions at the same moment never make one authoritative by arrival order", async (r) => {
    const results = await Promise.all([
      r.decide({ topic: "queue", statement: "Use RabbitMQ", wording: "use RabbitMQ for the queue", basedOn: 0, session: "a" }),
      r.decide({ topic: "queue", statement: "Use Kafka", wording: "use Kafka for the queue", basedOn: 0, session: "b" }),
    ]);
    assert.ok(results.every((x) => x.recorded));
    assert.equal(results.filter((x) => (x as { disputeId?: string }).disputeId !== undefined).length, 1, "exactly one of the two sees the other and surfaces the conflict");
    const auth = (await r.decisions.authoritative(r.w.owner, { projectId: r.a, topic: "queue" }))!;
    assert.equal(auth.status, "disputed");
    // basedOn is required, so a session cannot overwrite without saying what it saw.
    await refuses("invalid_command", () => r.decisions.record(r.w.owner, { commandId: cid("x"), projectId: r.a, category: "decision", topic: "queue", statement: "s", wording: "use Pulsar for the queue", source: { channel: "direct" } } as never), (e) => assert.match(e.message, /basedOn/));
  });

  suite("links reach plans, contracts, reviews, actions and branches; only authoritative decisions, of this project, readable and for this task, can be linked", async (r) => {
    const d = await r.recorded({});
    const plan = await r.plan(r.t1);
    const effect = await r.intend(r.t1);
    const opened = await r.branches.open(r.ann, { commandId: cid("br"), taskId: r.t1, purpose: "assess the database choice" });
    const review = await r.reviews.request(r.ann, { commandId: cid("rq"), taskId: r.t1, operation: op(), note: "check", context });
    for (const subject of [{ kind: "plan", id: plan }, { kind: "task", id: r.t1 }, { kind: "contract", id: r.t1 }, { kind: "action", id: effect }, { kind: "branch", id: opened.id }, { kind: "review", id: review.id }]) {
      assert.equal((await link(r, r.t1, subject, [d.id])).links, 1, subject.kind);
    }
    const rel = (await r.decisions.reliance(r.ann, r.t1))!;
    assert.equal(rel.links.length, 6);
    assert.ok(rel.links.every((l) => !l.stale && l.version === 1));
    // Things that are not this task's, malformed, or not owner decisions are refused.
    await refuses("invalid_command", () => link(r, r.t2, { kind: "plan", id: plan }, [d.id], r.ben));
    const foreign = await r.intend(r.t2);
    await refuses("invalid_command", () => link(r, r.t1, { kind: "action", id: foreign }, [d.id]));
    await refuses("invalid_command", () => link(r, r.t1, { kind: "task", id: r.t1 }, ["dec-aaaaaaaaaaaaaaaaaaaa"]));
    await refuses("invalid_command", () => link(r, r.t1, { kind: "thing", id: "x" }, [d.id]));
    await refuses("forbidden", () => link(r, r.t1, { kind: "task", id: r.t1 }, [d.id], r.eve));
    // A decision for another task, or of another project, cannot be relied on.
    const mine = await r.recorded({ topic: "other", taskId: r.t2, statement: "x y", wording: "task two only does this" });
    await refuses("invalid_command", () => link(r, r.t1, { kind: "task", id: r.t1 }, [mine.id]));
    const inB = await r.recorded({ projectId: r.b, topic: "database", statement: "Use SQLite", wording: "project B uses SQLite" });
    await refuses("invalid_command", () => link(r, r.t1, { kind: "task", id: r.t1 }, [inB.id]));
    // A gate binds by itself and is not linked; a superseded decision is not linkable, and the refusal names the current one.
    const gate = await r.recorded({ category: "gate", gate: "planning-only", topic: "implementation-gate", statement: "plan only", wording: "planning only for now" });
    await refuses("invalid_command", () => link(r, r.t1, { kind: "task", id: r.t1 }, [gate.id]), (e) => assert.match(e.message, /gate/));
    const next = await r.recorded({ statement: "Use MySQL", wording: "MySQL it is, not PostgreSQL", basedOn: 1 });
    await refuses("invalid_command", () => link(r, r.t1, { kind: "task", id: r.t1 }, [d.id]), (e) => assert.match(e.message, new RegExp(`superseded.*${next.id}`)));
    // Unreadable reads like missing.
    assert.equal(await r.decisions.get(r.eve, d.id), undefined);
    assert.equal(await r.decisions.context(r.eve, { projectId: r.a }), undefined);
    assert.equal(await r.decisions.reliance(r.eve, r.t1), undefined);
  });

  suite("a correction blocks the next action of busy, paused and restarted work until it is revalidated, and revalidation can never restore superseded guidance", async (r) => {
    const old = await r.recorded({});
    const run = await r.withCall(r.t1);
    await link(r, r.t1, { kind: "plan", id: await r.plan(r.t1) }, [old.id]);
    // A second agent is paused: its task is paused by the owner before the correction.
    const run2 = await r.withCall(r.t2, r.ben);
    await link(r, r.t2, { kind: "task", id: r.t2 }, [old.id], r.ben);
    await r.pauses.pause(r.w.owner, { commandId: cid("pz"), scope: { kind: "task", id: r.t2 }, reason: "owner stepped in" });
    // The correction commits: the busy agent's finished generation is cut with it (L05), and work begun after it is blocked by the decision itself until it is revalidated.
    const fix = await r.recorded({ statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 });
    assert.equal(fix.propagation, "done");
    await refusedFor("interrupted", () => r.admit(run));
    const again = await r.withCall(r.t1);
    await refusedFor("decision", () => r.admit(again));
    // The paused task: resuming does not release it.
    await r.pauses.resume(r.w.owner, { commandId: cid("rz"), scope: { kind: "task", id: r.t2 }, reason: "carry on" });
    await refusedFor("interrupted", () => r.admit(run2, r.ben));
    const again2 = await r.withCall(r.t2, r.ben);
    await refusedFor("decision", () => r.admit(again2, r.ben));
    // After a restart (new service objects over the same records) the block is still there.
    const reopened = r.reopen();
    assert.ok((await reopened.guard(r.t1, "effect")).blockedBy.length > 0);
    assert.ok((await reopened.guard(r.t2, "effect")).blockedBy.length > 0);
    // Thinking is not blocked (the agent has to read the new decision), effects are.
    assert.deepEqual((await reopened.guard(r.t1, "start")).blockedBy, []);
    // Naming the superseded decision, or one that does not cover the topic, restores nothing; many agents asking changes nothing.
    await refuses("invalid_command", () => r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [old.id], note: "the team agrees" }), (e) => assert.match(e.message, /superseded guidance cannot be restored/));
    await refuses("invalid_command", () => r.decisions.revalidate(r.ben, { commandId: cid("rv"), taskId: r.t1, decisions: [old.id], note: "agreed" }));
    const unrelated = await r.recorded({ topic: "language", statement: "TS", wording: "use TypeScript" });
    await refuses("invalid_command", () => r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [unrelated.id], note: "wrong topic" }), (e) => assert.match(e.message, /"database"/));
    await refuses("forbidden", () => r.decisions.revalidate(r.eve, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "outsider" }));
    // Revalidation against the current decision unblocks exactly that task.
    const rv = await r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "plan re-read against MySQL" });
    assert.equal(rv.revalidated, 1);
    assert.equal((await r.admit(again)).replayed, false);
    await refusedFor("decision", () => r.admit(again2, r.ben));
    await r.decisions.revalidate(r.ben, { commandId: cid("rv"), taskId: r.t2, decisions: [fix.id], note: "re-read" });
    assert.equal((await r.admit(again2, r.ben)).replayed, false);
    await refuses("invalid_command", () => r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "again" }), (e) => assert.match(e.message, /nothing to revalidate/));
  });

  suite("a correction racing an admission lands strictly before or after it: an effect is never admitted from work the owner has just superseded", async (r) => {
    const old = await r.recorded({});
    await link(r, r.t1, { kind: "task", id: r.t1 }, [old.id]);
    const run = await r.withCall(r.t1);
    let corrected = false;
    const racing = GenerationService.withEpoch(r.st, r.epoch, { assignments: r.w.assignments, effects: r.effects, pauses: r.pauses, decisions: r.decisions }, { ...options, testHooks: { afterDecisionRead: async () => {
      if (corrected) return;
      corrected = true;
      // The owner's correction commits between the guard's read and the admission's commit (without interrupting the generation, so only the guard can stop the admission).
      const saved = r.deps.generation;
      delete r.deps.generation;
      await r.recorded({ statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 });
      if (saved !== undefined) r.deps.generation = saved;
    } } });
    await assert.rejects(() => racing.admitEffect(r.ann, { commandId: "admit-race", runId: run, toolCallId: "c1", kind: "deploy", target: "prod" }), (e: unknown) => e instanceof GenerationRefused && e.reason === "decision");
    assert.equal(corrected, true);
    assert.equal(await r.effects.get(derivedId("eff", scopedCommandId(r.ann.id, "admit-race"))), undefined, "no effect intent was written");
  });

  suite("a running generation is interrupted by a correction, and a queued effect cannot start from outdated work", async (r) => {
    const old = await r.recorded({});
    const streaming = await r.work1(r.t1);
    await r.gen.record(r.ann, { commandId: cid("tx"), runId: streaming, seq: 1, text: "deploying with PostgreSQL now" });
    const queued = await r.withCall(r.t2, r.ben);
    const admitted = await r.admit(queued, r.ben);
    await link(r, r.t1, { kind: "task", id: r.t1 }, [old.id]);
    await link(r, r.t2, { kind: "action", id: admitted.effectId }, [old.id], r.ben);
    const revisionBefore = (await r.gen.gate(r.w.owner, r.t1))!.gate.contextRevision;
    const fix = await r.recorded({ statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 });
    assert.equal(fix.propagation, "done");
    // The busy agent's generation was cut by the correction; what it still sends is late and not applied.
    const run = (await r.gen.view(r.w.owner, streaming))!;
    assert.deepEqual([run.run.state, run.run.interrupted?.kind, run.current], ["interrupted", "corrected", false]);
    assert.equal((await r.gen.gate(r.w.owner, r.t1))!.gate.contextRevision, revisionBefore + 1);
    const late = await r.gen.record(r.ann, { commandId: cid("tx"), runId: streaming, seq: 2, text: "...and pushing" });
    assert.deepEqual([late.applied, late.late], [false, true]);
    // The effect the busy agent had admitted but not started was withdrawn by the correction (L05); it cannot run.
    const log: string[] = [];
    assert.equal((await r.effects.get(admitted.effectId))!.status, "failed");
    assert.equal((await r.gen.execute(r.ben, { runId: queued, toolCallId: "c1" }, bridge(log))).status, "failed");
    assert.deepEqual(log, [], "nothing ran");
    // Work begun at the old context revision is stale; at the new one the agent may think, but no effect starts from outdated work.
    await refusedFor("stale", () => r.gen.begin(r.ann, { commandId: cid("b"), taskId: r.t1, contextRevision: 1 }));
    const next = await r.withCall(r.t1);
    await refusedFor("decision", () => r.admit(next));
    // An effect queued outside the generation service is stopped by the guard its starter is given (the slice pipeline, a dispatcher).
    const outside = await r.intend(r.t2);
    await link(r, r.t2, { kind: "action", id: outside }, [fix.id], r.ben);
    await r.decisions.revalidate(r.ben, { commandId: cid("rv"), taskId: r.t2, decisions: [fix.id], note: "re-read" });
    const newer = await r.recorded({ statement: "Use CockroachDB", wording: "use CockroachDB, not MySQL", basedOn: 2 });
    await assert.rejects(() => r.effects.run(outside, bridge(log), { beforeStart: async () => r.gen.guardFor(r.t2)() }), (e: unknown) => e instanceof GenerationRefused && e.reason === "decision");
    assert.deepEqual(log, []);
    const rel = (await r.decisions.reliance(r.ben, r.t2))!;
    assert.deepEqual(rel.links.map((l) => [l.subject.kind, l.state, l.supersededBy, l.stale]).sort(), [["action", "superseded", newer.id, true], ["action", "superseded", newer.id, true]].sort());
  });

  suite("effects that already happened are recorded with a corrective follow-up and never claimed undone", async (r) => {
    const old = await r.recorded({});
    const done = await r.intend(r.t1);
    const outcome = await r.effects.run(done, bridge([]));
    assert.equal(outcome.status, "confirmed");
    const queued = await r.intend(r.t1);
    const failed = await r.intend(r.t1);
    await r.effects.run(failed, { idempotent: true, execute: async () => { throw Object.assign(new Error("refused"), {}); } }).catch(() => undefined);
    await link(r, r.t1, { kind: "action", id: done }, [old.id]);
    await link(r, r.t1, { kind: "action", id: queued }, [old.id]);
    await r.recorded({ statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 });
    const rel = (await r.decisions.reliance(r.ann, r.t1))!;
    assert.equal(rel.followUps.length, 1, "only the action that really happened needs follow-up; the queued one is blocked instead");
    const f = rel.followUps[0]!;
    assert.deepEqual([f.effectId, f.effectStatus, f.undone, f.state], [done, "confirmed", false, "open"]);
    assert.match(f.note, /has not been undone/);
    // Closing it never says undone: the agent says what was done, the owner may accept it as it stands.
    await refuses("forbidden", () => r.decisions.closeFollowUp(r.ann, { commandId: cid("fu"), followUpId: f.id, state: "accepted", note: "fine" }));
    await refuses("invalid_command", () => r.decisions.closeFollowUp(r.ann, { commandId: cid("fu"), followUpId: f.id, state: "addressed", note: "reverted", correctiveEffectId: done }), (e) => assert.match(e.message, /another effect/));
    const corrective = await r.intend(r.t1);
    await r.decisions.closeFollowUp(r.ann, { commandId: cid("fu"), followUpId: f.id, state: "addressed", note: "deployed the MySQL variant", correctiveEffectId: corrective });
    const closed = (await r.decisions.reliance(r.ann, r.t1))!.followUps[0]!;
    assert.deepEqual([closed.state, closed.undone, closed.correctiveEffectId], ["addressed", false, corrective]);
    await refuses("invalid_command", () => r.decisions.closeFollowUp(r.w.owner, { commandId: cid("fu"), followUpId: f.id, state: "accepted", note: "ok" }), (e) => assert.match(e.message, /already addressed/));
    // The original effect record is untouched.
    assert.equal((await r.effects.get(done))!.status, "confirmed");
  });

  suite("agents are told through their task's event stream, once, and a pass that dies half way is finished after a restart without telling anyone twice", async (r) => {
    const old = await r.recorded({});
    await link(r, r.t1, { kind: "task", id: r.t1 }, [old.id]);
    await link(r, r.t2, { kind: "task", id: r.t2 }, [old.id], r.ben);
    const sub1 = await r.realEvents.subscribe(r.host, { commandId: cid("s"), stream: `task:${r.t1}`, fromStart: true });
    const sub2 = await r.realEvents.subscribe(r.host, { commandId: cid("s"), stream: `task:${r.t2}`, fromStart: true });
    // The first publish is refused by the stream (backpressure); the correction itself is committed and authoritative anyway.
    const fix = await r.recorded({ statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 });
    assert.equal(fix.propagation, "pending", "one task could not be told yet");
    assert.equal((await r.decisions.authoritative(r.w.owner, { projectId: r.a, topic: "database" }))!.status, "decided");
    const unfinished = (await r.decisions.context(r.w.owner, { projectId: r.a }))!;
    assert.equal(unfinished.version > 0, true);
    // After a restart, resume finishes it; each task is told exactly once.
    const reopened = r.reopen();
    const resumed = await reopened.resume(r.host, { projectId: r.a });
    assert.deepEqual([resumed.done, resumed.pending, resumed.failures.length], [1, 0, 0]);
    assert.deepEqual([...r.published].sort(), [`task:${r.t1}:decision-superseded`, `task:${r.t2}:decision-superseded`].sort());
    assert.deepEqual(await reopened.resume(r.host, { projectId: r.a }), { done: 0, pending: 0, more: false, failures: [] }, "nothing left, nothing repeated");
    assert.equal(r.published.length, 2);
    // The tasks read the notice when they next wake, even long after (the cursor is durable).
    for (const [sub, taskId] of [[sub1, r.t1], [sub2, r.t2]] as const) {
      const pulled = await r.realEvents.pull(r.host, sub.id);
      assert.deepEqual(pulled.events.map((e) => [e.kind, e.ref.id]), [["decision-superseded", fix.id]], taskId);
    }
    // Only the owner, a host or a service passes corrections on.
    await refuses("forbidden", () => reopened.resume(r.ann, { projectId: r.a }));
    await refuses("forbidden", () => reopened.propagate(r.ann, { propagationId: "dpr-00000000000000000000000000000000" }));
  }, { failEvents: 1 });

  suite("repeating the correction after a crash between the commit and the passing on finishes the passing on", async (r) => {
    const old = await r.recorded({});
    await link(r, r.t1, { kind: "task", id: r.t1 }, [old.id]);
    const command = { commandId: "fix-once", statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 };
    const first = await r.decide(command) as { propagation: string; id: string };
    assert.equal(first.propagation, "pending");
    const again = await r.decide(command, r.reopen()) as { propagation: string; replayed: boolean; id: string };
    assert.deepEqual([again.replayed, again.propagation, again.id], [true, "done", first.id]);
    assert.equal(r.published.length, 1);
    assert.equal((await r.decisions.reliance(r.ann, r.t1))!.links[0]!.state, "superseded");
  }, { failEvents: 1 });

  suite("part of a sentence cannot be recorded as a decision: a question, a hypothetical or a negation around the phrase is read with it", async (r) => {
    const cases: [string, string][] = [
      ["What if we use MySQL for the controller", "we use MySQL for the controller"],
      ["Should we use MySQL for the controller?", "we use MySQL for the controller"],
      ["Do not use MySQL for the controller", "use MySQL for the controller"],
      ["I wonder whether to use MySQL for the controller. Not now.", "use MySQL for the controller"],
      ["Could we use MySQL for the controller", "use MySQL for the controller"],
      ["We will never use MySQL for the controller anymore", "use MySQL for the controller"],
    ];
    for (const [text, wording] of cases) {
      const turn = await r.say(text);
      const x = await r.decide({ topic: `t${n_++}`, source: { channel: "chat", turnId: turn }, wording });
      assert.equal(x.recorded, false, text);
    }
    // The same phrase said plainly, in another sentence of the message, is a decision.
    const plainly = await r.say("What if we waited? No. We will use MySQL for the controller.");
    assert.equal((await r.decide({ topic: "plain", source: { channel: "chat", turnId: plainly }, wording: "We will use MySQL for the controller" })).recorded, true);
    // The whole sentence as the owner said it, negation included, is a decision (not to use it).
    const neg = await r.say("Do not use MySQL for the controller");
    assert.equal((await r.decide({ topic: "neg", source: { channel: "chat", turnId: neg }, wording: "Do not use MySQL for the controller" })).recorded, true);
  });

  suite("a reviewer who does not work on the task clears only its review links; the worker clears the rest; each can name the subjects it covers", async (r) => {
    const old = await r.recorded({});
    const review = await r.reviews.request(r.ann, { commandId: cid("rq"), taskId: r.t1, operation: op(), note: "check", context });
    const plan = await r.plan(r.t1);
    await link(r, r.t1, { kind: "task", id: r.t1 }, [old.id]);
    await link(r, r.t1, { kind: "plan", id: plan }, [old.id]);
    await link(r, r.t1, { kind: "review", id: review.id }, [old.id]);
    const fix = await r.recorded({ statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 });
    const blocked = async () => (await r.decisions.guard(r.t1, "effect")).blockedBy.length;
    assert.equal(await blocked(), 3);
    // The reviewer holds only review.decide: it cannot unblock the task's own links.
    await refuses("forbidden", () => r.decisions.revalidate(r.rev, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "x", subjects: [{ kind: "task", id: r.t1 }] }), (e) => assert.match(e.message, /does not work on that task/));
    const byReviewer = await r.decisions.revalidate(r.rev, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "the review holds against MySQL" });
    assert.deepEqual([byReviewer.revalidated, byReviewer.remaining], [1, 2]);
    assert.equal(await blocked(), 2, "the task's own links are still stale");
    // The worker clears its plan only, naming it; the review is not its to clear.
    await refuses("invalid_command", () => r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "x", subjects: [{ kind: "review", id: review.id }] }), (e) => assert.match(e.message, /no stale link/));
    await refuses("invalid_command", () => r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "x", subjects: [{ kind: "review", id: review.id }, { kind: "task", id: "task-aaaaaaaaaaaaaaaaaaaa" }] }));
    const byWorker = await r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "plan re-read", subjects: [{ kind: "plan", id: plan }] });
    assert.deepEqual([byWorker.revalidated, byWorker.remaining], [1, 1]);
    assert.equal((await r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "rest" })).remaining, 0);
    assert.equal(await blocked(), 0);
  });

  suite("work attaches only to the decision that governs its task: a project-level decision a task-level one overrides is refused, also when revalidating", async (r) => {
    const wide = await r.recorded({});
    const exception = await r.recorded({ taskId: r.t1, statement: "Task one uses SQLite", wording: "task one uses SQLite instead", basedOn: 1 });
    await refuses("invalid_command", () => link(r, r.t1, { kind: "task", id: r.t1 }, [wide.id]), (e) => assert.match(e.message, new RegExp(`${exception.id} does`)));
    assert.equal((await link(r, r.t1, { kind: "task", id: r.t1 }, [exception.id])).links, 1);
    assert.equal((await link(r, r.t2, { kind: "task", id: r.t2 }, [wide.id], r.ben)).links, 1, "task two is governed by the project-level decision");
    // A correction of the task's exception: revalidating with the overridden project-level decision is refused.
    const newer = await r.recorded({ taskId: r.t1, statement: "Task one uses DuckDB", wording: "task one uses DuckDB now", basedOn: 2 });
    await refuses("invalid_command", () => r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [wide.id], note: "x" }), (e) => assert.match(e.message, /governs this task/));
    assert.equal((await r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [newer.id], note: "ok" })).revalidated, 1);
  });

  suite("uncertain and started actions get a follow-up too, and a finished one is not undone", async (r) => {
    const old = await r.recorded({});
    const uncertain = await r.intend(r.t1);
    const outcome = await r.effects.run(uncertain, { idempotent: false, execute: async () => { throw new Error("connection lost"); } });
    assert.equal(outcome.status, "uncertain");
    const started = await r.intend(r.t1);
    const pending = await r.effects.run(started, { idempotent: true, execute: async () => { throw new Error("timeout"); } });
    assert.equal(pending.status, "pending");
    assert.equal((await r.effects.get(started))!.started, true);
    for (const id of [uncertain, started]) await link(r, r.t1, { kind: "action", id }, [old.id]);
    await r.recorded({ statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 });
    const rel = (await r.decisions.reliance(r.ann, r.t1))!;
    assert.deepEqual(rel.followUps.map((f) => [f.effectId, f.effectStatus, f.undone, f.state]).sort(), [[uncertain, "uncertain", false, "open"], [started, "in-flight", false, "open"]].sort());
  });

  suite("an unrelated decision does not make an admission retry, a related one does", async (r) => {
    const old = await r.recorded({});
    await link(r, r.t1, { kind: "task", id: r.t1 }, [old.id]);
    const run = await r.withCall(r.t1);
    let reads = 0;
    const racing = GenerationService.withEpoch(r.st, r.epoch, { assignments: r.w.assignments, effects: r.effects, pauses: r.pauses, decisions: r.decisions }, { ...options, testHooks: { afterDecisionRead: async () => {
      reads++;
      if (reads === 1) await r.recorded({ topic: "logging", statement: "JSON lines", wording: "log in JSON lines please" });
    } } });
    await racing.admitEffect(r.ann, { commandId: cid("ad"), runId: run, toolCallId: "c1", kind: "deploy", target: "prod" });
    assert.equal(reads, 1, "the unrelated decision did not invalidate the guard's read");
  });

  suite("a host or service passes corrections on only in the projects it holds assignment rights for", async (r) => {
    const old = await r.recorded({});
    await link(r, r.t1, { kind: "task", id: r.t1 }, [old.id]);
    const sub = await r.realEvents.subscribe(r.host, { commandId: cid("s"), stream: `task:${r.t1}`, fromStart: true });
    void sub;
    const fix = await r.recorded({ statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 });
    const propId = fix.superseded.length > 0 ? (await r.decisions.context(r.w.owner, { projectId: r.a }))!.version : 0;
    void propId;
    await r.w.principals.enroll(r.w.owner, { commandId: cid("h"), kind: "host", name: "h2", grants: [{ action: "assignment.manage", project: r.b }] });
    const other = await r.w.principals.authenticate((await r.w.principals.issueCredential(r.w.owner, "host:h2")).token);
    await refuses("forbidden", () => r.reopen().resume(other, { projectId: r.a }));
    await refuses("forbidden", () => r.reopen().resume(r.ann, { projectId: r.a }));
    assert.deepEqual(await r.reopen().resume(r.host, { projectId: r.a }), { done: 0, pending: 0, more: false, failures: [] });
    assert.equal(await r.decisions.propagation(other, "dpr-00000000000000000000000000000000"), undefined);
  });

  suite("the owner's correction is never refused for a backlog of unfinished propagations; a resume pass works through them 20 at a time", async (r) => {
    flakyRef.failEvents = 100000;
    let current = (await r.recorded({ topic: "t0", statement: "v0", wording: "use variant zero" })).id;
    await link(r, r.t1, { kind: "task", id: r.t1 }, [current]);
    for (let i = 1; i <= 22; i++) {
      const next = await r.recorded({ topic: "t0", statement: `v${i}`, wording: `use variant ${i}`, basedOn: i });
      assert.equal(next.propagation, "pending");
      await r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [next.id], note: "ok" });
      current = next.id;
    }
    assert.equal((await r.decisions.authoritative(r.w.owner, { projectId: r.a, topic: "t0" }) as { decision: { id: string } }).decision.id, current);
    flakyRef.failEvents = 0;
    const one = await r.decisions.resume(r.host, { projectId: r.a });
    assert.deepEqual([one.done, one.more], [20, true]);
    const two = await r.decisions.resume(r.host, { projectId: r.a });
    assert.deepEqual([two.done, two.more], [2, false]);
  }, flakyRef);

  suite("a conflict involves every live decision in its scope: nothing stays authoritative meanwhile, and the owner's choice is honoured everywhere", async (r) => {
    const mk = (over: Record<string, unknown>) => r.decide({ topic: "db", ...over });
    const run = async (choose: "N" | "T") => {
      const P = await mk({ statement: "Postgres", wording: "use Postgres", basedOn: 0 }) as { id: string; version: number };
      const T = await mk({ taskId: r.t1, statement: "SQLite for t1", wording: "task one uses SQLite", basedOn: P.version }) as { id: string; version: number };
      await link(r, r.t2, { kind: "task", id: r.t2 }, [P.id], r.ben);
      // A session that had seen only P corrects it project-wide.
      const N = await mk({ statement: "MySQL", wording: "use MySQL everywhere", basedOn: P.version }) as { id: string; disputeId: string };
      assert.ok(N.disputeId);
      for (const id of [P.id, T.id, N.id]) assert.equal((await r.decisions.get(r.w.owner, id))!.state, "disputed", "all three are in the conflict");
      for (const taskId of [r.t1, r.t2, undefined]) assert.equal((await r.decisions.authoritative(r.w.owner, { projectId: r.a, ...(taskId === undefined ? {} : { taskId }), topic: "db" }))!.status, "disputed", String(taskId));
      assert.equal((await r.decisions.context(r.w.owner, { projectId: r.a }))!.decisions.length, 0);
      const run2 = await r.withCall(r.t2, r.ben);
      await refusedFor("decision", () => r.admit(run2, r.ben));
      await r.decisions.resolveDispute(r.w.owner, { commandId: cid("rd"), disputeId: N.disputeId, chosen: choose === "N" ? N.id : T.id });
      const states = await Promise.all([P, T, N].map(async (x) => (await r.decisions.get(r.w.owner, x.id))!.state));
      const at = async (taskId?: string) => { const a = (await r.decisions.authoritative(r.w.owner, { projectId: r.a, ...(taskId === undefined ? {} : { taskId }), topic: "db" }))!; return a.status === "decided" ? a.decision.id : a.status; };
      const ctx = (await r.decisions.context(r.w.owner, { projectId: r.a }))!;
      return { P, T, N, states, at, ctx };
    };
    const n = await run("N");
    assert.deepEqual(n.states, ["superseded", "superseded", "active"], "choosing the newcomer leaves it the only live decision");
    assert.deepEqual([await n.at(r.t1), await n.at(r.t2), await n.at()], [n.N.id, n.N.id, n.N.id]);
    assert.deepEqual(n.ctx.decisions.map((d) => d.id), [n.N.id]);
    const run3 = await r.withCall(r.t2, r.ben);
    await refusedFor("decision", () => r.admit(run3, r.ben));
    assert.equal((await r.decisions.revalidate(r.ben, { commandId: cid("rv"), taskId: r.t2, decisions: [n.N.id], note: "ok" })).revalidated, 1);
    assert.equal((await r.admit(run3, r.ben)).replayed, false);
  });

  suite("choosing the task-level decision in a conflict supersedes the rest: the project then has no decision until the owner makes one", async (r) => {
    const P = await r.decide({ topic: "db", statement: "Postgres", wording: "use Postgres", basedOn: 0 }) as { id: string; version: number };
    const T = await r.decide({ topic: "db", taskId: r.t1, statement: "SQLite for t1", wording: "task one uses SQLite", basedOn: P.version }) as { id: string };
    const N = await r.decide({ topic: "db", statement: "MySQL", wording: "use MySQL everywhere", basedOn: P.version }) as { id: string; disputeId: string };
    await r.decisions.resolveDispute(r.w.owner, { commandId: cid("rd"), disputeId: N.disputeId, chosen: T.id });
    assert.deepEqual(await Promise.all([P, T, N].map(async (x) => (await r.decisions.get(r.w.owner, x.id))!.state)), ["superseded", "active", "superseded"]);
    const at = async (taskId?: string) => { const a = (await r.decisions.authoritative(r.w.owner, { projectId: r.a, ...(taskId === undefined ? {} : { taskId }), topic: "db" }))!; return a.status === "decided" ? a.decision.id : a.status; };
    assert.deepEqual([await at(r.t1), await at(r.t2), await at()], [T.id, "none", "none"]);
  });

  suite("the project's first record creates the gate topic, so a gate made later is ordered against admissions", async (r) => {
    await r.recorded({});
    const old = await r.recorded({ topic: "other", statement: "x y", wording: "some other choice" });
    await link(r, r.t1, { kind: "task", id: r.t1 }, [old.id]);
    const run = await r.withCall(r.t1);
    let corrected = false;
    const racing = GenerationService.withEpoch(r.st, r.epoch, { assignments: r.w.assignments, effects: r.effects, pauses: r.pauses, decisions: r.decisions }, { ...options, testHooks: { afterDecisionRead: async () => {
      if (corrected) return;
      corrected = true;
      await r.recorded({ category: "gate", gate: "implementation-hold", topic: "implementation-gate", statement: "hold", wording: "hold all implementation now" });
    } } });
    await assert.rejects(() => racing.admitEffect(r.ann, { commandId: "admit-gate-race", runId: run, toolCallId: "c1", kind: "deploy", target: "prod" }), (e: unknown) => e instanceof GenerationRefused && e.reason === "decision");
  });

  suite("a planning-only instruction or an implementation hold is a binding gate: it needs no link, admits no work, and only the owner's decision lifts it", async (r) => {
    const run = await r.withCall(r.t1);
    const planning = await r.recorded({ category: "gate", gate: "planning-only", topic: "implementation-gate", statement: "plan only, no implementation", wording: "planning only until I say otherwise" });
    await refusedFor("decision", () => r.admit(run));
    assert.equal((await r.gen.begin(r.ann, { commandId: cid("b"), taskId: r.t2, contextRevision: 1 })).number, 1, "planning itself is allowed");
    // A hold is stricter: not even a generation starts. Agents cannot lift or change it.
    const hold = await r.recorded({ category: "gate", gate: "implementation-hold", topic: "implementation-gate", statement: "hold everything", wording: "hold all implementation now", basedOn: 1 });
    assert.deepEqual([(await r.decisions.get(r.w.owner, planning.id))!.state, (await r.decisions.get(r.w.owner, hold.id))!.state], ["superseded", "active"]);
    await refusedFor("decision", () => r.gen.begin(r.ann, { commandId: cid("b"), taskId: r.t2, contextRevision: 1 }));
    await refuses("forbidden", () => r.decide({ category: "gate", gate: "open", topic: "implementation-gate", statement: "all clear", wording: "everyone may implement now", basedOn: 2 }, r.decisions, r.ann));
    // The same block applies to a starter that skips the generation service, and to reviews.
    await refuses("review_invalid", async () => { const q = await r.reviews.request(r.ann, { commandId: cid("rq"), taskId: r.t1, operation: op(), note: "x", context }); const v = (await r.reviews.get(r.ann, q.id))!; await r.reviews.decide(r.rev, { commandId: cid("dc"), requestId: q.id, expectedRevision: v.revision, verdict: "allow", reason: "looks fine" }); });
    // A task-level exception opens one task; the project stays held.
    const except = await r.recorded({ taskId: r.t2, category: "gate", gate: "open", topic: "implementation-gate", statement: "task two may go on", wording: "task two may implement now", basedOn: 2 });
    assert.deepEqual((await r.decisions.guard(r.t2, "effect")).blockedBy, []);
    assert.equal((await r.decisions.guard(r.t1, "start")).blockedBy.length, 1);
    // Only the owner's later decision lifts it, at once.
    await r.recorded({ category: "gate", gate: "open", topic: "implementation-gate", statement: "all clear", wording: "everyone may implement now", basedOn: 3 });
    assert.deepEqual((await r.decisions.guard(r.t1, "effect")).blockedBy, []);
    assert.equal((await r.decisions.get(r.w.owner, except.id))!.state, "superseded");
    assert.equal((await r.admit(run)).replayed, false);
    // A gate must say what it is.
    await refuses("invalid_command", () => r.decide({ category: "gate", topic: "implementation-gate" }));
    await refuses("invalid_command", () => r.decide({ gate: "open" }));
  });

  suite("a stale review cannot pass or be used on the strength of earlier agreement, and the agent whose work it was cannot re-approve it", async (r) => {
    const old = await r.recorded({});
    const asked = await r.reviews.request(r.ann, { commandId: cid("rq"), taskId: r.t1, operation: op(), note: "please check", context });
    const approved = await r.reviews.request(r.ann, { commandId: cid("rq"), taskId: r.t1, operation: { ...op(), args: { cwd: "/other" } }, note: "second", context });
    for (const id of [asked.id, approved.id]) await link(r, r.t1, { kind: "review", id }, [old.id]);
    // An agent that may both request and decide reviews, with a review of its own on the same task.
    const dual = (await r.w.agent("dual", [{ action: "attempt.work", project: r.a }, { action: "review.decide", project: r.a }, { action: "review.request", project: r.a }, { action: "history.read", project: r.a }, { action: "tool.run-script", project: r.a }])).principal;
    const own = await r.reviews.request(dual, { commandId: cid("rq"), taskId: r.t1, operation: { ...op(), args: { cwd: "/dual" } }, note: "mine", context });
    await link(r, r.t1, { kind: "review", id: own.id }, [old.id], dual);
    const v = (await r.reviews.get(r.ann, approved.id))!;
    await r.reviews.decide(r.rev, { commandId: cid("dc"), requestId: approved.id, expectedRevision: v.revision, verdict: "allow", reason: "fine under PostgreSQL" });
    assert.equal((await r.reviews.get(r.ann, approved.id))!.state, "approved");
    const fix = await r.recorded({ statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 });
    // The pending review cannot be allowed; the approved one cannot be used. A denial is still possible.
    const pending = (await r.reviews.get(r.ann, asked.id))!;
    await refuses("review_invalid", () => r.reviews.decide(r.rev, { commandId: cid("dc"), requestId: asked.id, expectedRevision: pending.revision, verdict: "allow", reason: "the team already agreed" }), (e) => assert.match(e.message, /superseded/));
    await refuses("review_invalid", () => r.reviews.admit(r.ann, { commandId: cid("ad"), requestId: approved.id, operation: { ...op(), args: { cwd: "/other" } } }), (e) => assert.match(e.message, /cannot stand/));
    await r.reviews.decide(r.rev, { commandId: cid("dc"), requestId: asked.id, expectedRevision: pending.revision, verdict: "deny", reason: "outdated" });
    // The requesting agent cannot revalidate the review's link; a reviewer (or the owner) can.
    await refuses("forbidden", () => r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "I re-checked" }), (e) => assert.match(e.message, /cannot re-approve/));
    await refuses("forbidden", () => r.decisions.revalidate(r.ann, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "mine" }), (e) => assert.match(e.message, /cannot re-approve/));
    const first = await r.decisions.revalidate(dual, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "reviewed the other two" });
    assert.deepEqual([first.revalidated, first.remaining], [2, 1], "dual clears the reviews it did not ask for, not its own");
    const last = await r.decisions.revalidate(r.rev, { commandId: cid("rv"), taskId: r.t1, decisions: [fix.id], note: "the reviewer looked at the new decision" });
    assert.deepEqual([last.revalidated, last.remaining], [1, 0]);
    assert.equal((await r.reviews.admit(r.ann, { commandId: cid("ad"), requestId: approved.id, operation: { ...op(), args: { cwd: "/other" } } })).admitted, true);
  });

  suite("the same command is applied once, also after a restart; a different command with the same ID is refused", async (r) => {
    const command = { commandId: "dec-once", topic: "cache", statement: "Use Redis", wording: "use Redis as the cache", basedOn: 0 };
    const first = await r.decide(command);
    assert.deepEqual([first.recorded, (first as { replayed?: boolean }).replayed], [true, false]);
    const again = await r.decide(command, r.reopen());
    assert.deepEqual([again.recorded, (again as { replayed?: boolean }).replayed, (again as { id?: string }).id], [true, true, (first as { id: string }).id]);
    await refuses("command_conflict", () => r.decide({ ...command, statement: "Use Memcached", wording: "use Memcached as the cache" }));
    const ctx = (await r.decisions.context(r.w.owner, { projectId: r.a }))!;
    assert.equal(ctx.decisions.length, 1);
    // A link command repeats the same way.
    const link1 = { commandId: "link-once", taskId: r.t1, subject: { kind: "task", id: r.t1 }, decisions: [(first as { id: string }).id] };
    assert.equal((await r.decisions.link(r.ann, link1 as never)).replayed, false);
    assert.equal((await r.reopen().link(r.ann, link1 as never)).replayed, true);
  });

  suite("the context record is versioned, holds the owner's current words, goals, permissions and questions, and feeds the startup builder", async (r) => {
    const v0 = (await r.decisions.context(r.w.owner, { projectId: r.a }))!.version;
    assert.equal(v0, 0);
    await r.recorded({ topic: "database" });
    const goal = await r.recorded({ category: "goal", topic: "goal", statement: "Ship the beta by March", wording: "the goal is to ship the beta by March" });
    const perm = await r.recorded({ category: "permission", topic: "publishing", statement: "Agents may publish to the staging registry", wording: "you may publish to the staging registry" });
    await r.decisions.ask(r.ann, { commandId: cid("q"), taskId: r.t1, topic: "logging", question: "Which log format?" });
    const ctx = (await r.decisions.context(r.w.owner, { projectId: r.a }))!;
    assert.equal(ctx.version, 4, "each change to decisions or questions is a new version");
    assert.deepEqual([ctx.decisions.length, ctx.goals[0]!.id, ctx.permissions[0]!.id, ctx.questions.length], [1, goal.id, perm.id, 1]);
    const items = startupItems(ctx);
    assert.deepEqual(items.map((i) => i.kind).sort(), ["decision", "goal", "human", "permission"]);
    assert.ok(items.find((i) => i.kind === "human")!.text.includes("We will use PostgreSQL for the controller"), "the owner's own wording, whole");
    // Under a tight budget the owner's words, the goal and the permission stay whole; only the cuttable question can go.
    const tight = buildStartup(items, contextBudget(2048), 100, { keepNewest: 0 });
    assert.equal(tight.blocked, undefined);
    for (const kept of ["human", "goal", "permission"]) { const item = items.find((i) => i.kind === kept)!; assert.equal(tight.pieces.find((p) => p.id === item.id)?.text, item.text, `${kept} kept whole`); }
    // A task sees the project-wide record and its own decisions, not other tasks'.
    await r.recorded({ topic: "task-one", taskId: r.t1, statement: "only for one", wording: "this is only for task one" });
    assert.equal((await r.decisions.context(r.ann, { projectId: r.a, taskId: r.t1 }))!.decisions.length, 2);
    assert.equal((await r.decisions.context(r.ben, { projectId: r.a, taskId: r.t2 }))!.decisions.length, 1);
    assert.equal(await r.decisions.context(r.eve, { projectId: r.a, taskId: r.t1 }), undefined);
    // A superseded decision is not in the context; it is still readable, marked.
    await r.recorded({ topic: "database", statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 });
    const after = startupItems((await r.decisions.context(r.w.owner, { projectId: r.a }))!);
    assert.equal(after.some((i) => i.text.includes("We will use PostgreSQL")), false);
  });

  suite("links to the owner's wording survive repeated compaction, and show a superseded decision as non-authoritative", async (r) => {
    const blockers = BlockerService.withEpoch(r.st, r.epoch, options);
    const enf = ContextEnforcementService.withEpoch(r.st, r.epoch, { blockers, retrieval: r.w.retrieval }, options);
    await enf.registerCompressor(r.w.owner, { taskId: r.t1, compressorId: "pi-before-compact" });
    const d = await r.recorded({});
    const ref: SourceRef = { kind: "owner-decision", id: d.id };
    const material = "The agents talked about the controller database at length. ".repeat(120);
    const src: SourceRef = { kind: "desk-record", id: (await r.w.desks.write(r.ann, { commandId: cid("w"), projectId: r.a, kind: "note", title: "notes", body: "talk", visibility: "shared", status: "accepted" })).id };
    let latest: string | undefined;
    for (let i = 1; i <= 3; i++) {
      const out = await enf.compact(r.w.owner, { taskId: r.t1, attemptId: "att-1", key: `k${i}`, compressorId: "pi-before-compact", title: `summary ${i}`, material, sources: [src], ...(i === 1 ? { pinned: [ref] } : {}), ...(latest === undefined ? {} : { parent: latest }) }, [summariser(`Summary number ${i} of the talk.`)]);
      assert.equal(out.kind, "summary");
      latest = out.id;
      const kept = await enf.keptDecisions(r.w.owner, r.t1);
      assert.deepEqual([kept.length, kept[0]!.state, kept[0]!.text?.includes("We will use PostgreSQL for the controller")], [1, "available", true], `after compaction ${i}`);
    }
    // The owner corrects it: the same link now shows the original wording, marked as not authoritative.
    await r.recorded({ statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 });
    const kept = (await enf.keptDecisions(r.w.owner, r.t1))[0]!;
    assert.match(kept.text!, /^\[NOT AUTHORITATIVE, superseded by dec-/);
    assert.ok(kept.text!.includes("We will use PostgreSQL for the controller"), "the original wording is still there");
    // An agent that cannot read the project's decisions gets nothing.
    assert.equal((await r.w.retrieval.fetch(r.eve, ref)), undefined);
  });

  suite("a branch that took in a decision sees that it changed when the owner corrects it", async (r) => {
    const d = await r.recorded({});
    const opened = await r.branches.open(r.ann, { commandId: cid("br"), taskId: r.t1, purpose: "assess" });
    const rev = (await r.branches.view(r.ann, opened.id))!.branch.revision;
    await r.branches.applyUpdates(r.ann, { commandId: cid("up"), branchId: opened.id, expectedRevision: rev, updates: [{ kind: "owner-decision", id: d.id }] });
    assert.deepEqual((await r.branches.view(r.ann, opened.id))!.updates.map((u) => u.state), ["current"]);
    await r.recorded({ statement: "Use MySQL", wording: "use MySQL, not PostgreSQL", basedOn: 1 });
    const view = (await r.branches.view(r.ann, opened.id))!;
    assert.deepEqual(view.updates.map((u) => u.state), ["changed"]);
    assert.match(view.updates[0]!.text ?? "", /NOT AUTHORITATIVE/);
  });

  suite("applying or reloading configuration leaves pending decisions, disputes and questions where they are", async (r) => {
    const config = ConfigurationService.withEpoch(r.st, r.epoch, options);
    await r.recorded({});
    await r.decide({ statement: "Use SQLite", wording: "make it SQLite for the controller", basedOn: 0 });
    await r.decisions.ask(r.ann, { commandId: cid("q"), taskId: r.t1, topic: "logging", question: "Which log format?" });
    const before = JSON.stringify(await r.decisions.context(r.w.owner, { projectId: r.a }));
    const staged = await config.stage(r.w.owner, { commandId: cid("st"), layer: "installation", set: { "time.maxMinutes": 90 } });
    await config.apply(r.w.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: staged.revision });
    assert.equal(JSON.stringify(await r.reopen().context(r.w.owner, { projectId: r.a })), before);
    const ctx = (await r.decisions.context(r.w.owner, { projectId: r.a }))!;
    assert.deepEqual([ctx.disputes.length, ctx.questions.length], [1, 1]);
  });

  suite("boundaries: the owner decides, services only pass corrections on, scopes are checked, limits hold", async (r) => {
    await refuses("not_found", () => r.decide({ projectId: "proj-aaaaaaaaaaaaaaaaaaaa" }));
    await refuses("invalid_command", () => r.decide({ taskId: r.tb }), (e) => assert.match(e.message, /not a task of that project/));
    await refuses("invalid_command", () => r.decide({ topic: "Bad/Topic!!" }));
    await refuses("invalid_command", () => r.decide({ session: "has spaces" }));
    await refuses("invalid_command", () => r.decide({ basedOn: -1 }));
    await refuses("invalid_command", () => r.decide({ extra: 1 }));
    const first = await r.recorded({ topic: "Database  Choice" });
    assert.equal((await r.decisions.history(r.w.owner, { projectId: r.a, topic: "database choice" })).length, 1, "topics compare case and spacing insensitively");
    // A topic holds one category.
    await refuses("invalid_command", () => r.decide({ topic: "database choice", category: "goal", basedOn: 1 }), (e) => assert.match(e.message, /holds decision decisions/));
    // Reading history needs the right to read the project.
    assert.deepEqual(await r.decisions.history(r.eve, { projectId: r.a, topic: "database choice" }), []);
    assert.equal(await r.decisions.get(r.ben, first.id), undefined, "ben has no history.read and no grant on a task this concerns");
    assert.ok(await r.decisions.get(r.rev, first.id));
    // Propagation records are the owner's, a host's or a service's to read.
    assert.equal(await r.decisions.propagation(r.ann, "dpr-x"), undefined);
  });
}

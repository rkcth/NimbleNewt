import assert from "node:assert/strict";
import { after, test } from "node:test";
import { derivedId } from "../domain/ids.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { ObservationService, type ObservationOptions, type RecordOutcome } from "./index.js";

after(stopServer);

// The only clock anything here reads. Tests move it; nothing sleeps.
let now = Date.parse("2026-11-21T10:05:00.000Z");
const at = (iso: string): void => { now = Date.parse(iso); };
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const idOf = (r: RecordOutcome): string => { assert.notEqual(r.outcome, "suppressed"); return (r as { id: string }).id; };

interface Ctx {
  owner: Principal; host: Principal; mgr: Principal; scribe: Principal; dev: Principal; dev2: Principal; reader: Principal; bare: Principal; eve: Principal;
  a: string; b: string; taskA: string; taskB: string; obs: ObservationService; storage: ControllerStorage; epoch: number;
  make(o?: ObservationOptions): ObservationService;
  submission(project: string, task: string, by?: string): Promise<string>;
  review(project: string, task: string, requester: string): Promise<string>;
  improvement(project: string): Promise<string>;
}

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      at("2026-11-21T10:05:00.000Z");
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
        const improvement: Ctx["improvement"] = async (project) => { const id = derivedId("imp", cid("i")); await put("improvement-item", id, { projectId: project }); return id; };
        const make = (o: ObservationOptions = {}) => ObservationService.withEpoch(world.storage, epoch, { ...options, ...o });
        await body({
          owner, host: await enroll("host", "h1", []),
          mgr: await enroll("agent", "mgr", [{ action: "meeting.manage", project: a }]),
          scribe: await enroll("agent", "scribe", [{ action: "meeting.agenda", project: a }]),
          dev: await enroll("agent", "dev", [{ action: "meeting.agenda", project: a }, { action: "task.read", project: a }]),
          dev2: await enroll("agent", "dev2", [{ action: "meeting.agenda", project: a }, { action: "task.read", project: a }]),
          reader: await enroll("agent", "reader", [{ action: "meeting.read", project: a }]),
          bare: await enroll("agent", "bare", [{ action: "task.read", project: a }]),
          eve: await enroll("agent", "eve", [{ action: "meeting.manage", project: b }, { action: "meeting.agenda", project: b }, { action: "task.read", project: b }]),
          a, b, taskA, taskB, obs: make(), storage: world.storage, epoch, make, submission, review, improvement,
        });
      } finally { await world.close(); }
    });

  suite("a failed review told by the controller, again by the controller and by two agents in their own words is one observation; citing it joins it too", async (c) => {
    const sbm = await c.submission(c.a, c.taskA);
    const first = await c.obs.record(c.host, { commandId: "obs-review:1", kind: "failed-review", summary: "agent:rev asked for changes to the work on task one.", sources: [{ kind: "submission", id: sbm }] });
    assert.equal(first.outcome, "created");
    const id = idOf(first);
    // A restart replays the same hook: the same answer, nothing counted twice.
    const replay = await c.make().record(c.host, { commandId: "obs-review:1", kind: "failed-review", summary: "agent:rev asked for changes to the work on task one.", sources: [{ kind: "submission", id: sbm }] });
    assert.deepEqual([replay.outcome, idOf(replay), replay.replayed], ["created", id, true]);
    const viaDev = await c.obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "My login change was sent back again", sources: [{ kind: "submission", id: sbm }, { kind: "task", id: c.taskA }] });
    assert.deepEqual([viaDev.outcome, idOf(viaDev)], ["joined", id]);
    const viaDev2 = await c.obs.submit(c.dev2, { commandId: cid("f"), projectId: c.a, summary: "dev told me the review failed", sources: [{ kind: "submission", id: sbm }] });
    assert.deepEqual([viaDev2.outcome, idOf(viaDev2)], ["joined", id]);
    // A reporter may cite the observation it told; an agent that may not read it cannot.
    assert.deepEqual(idOf(await c.obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "still failing", sources: [{ kind: "observation", id }] })), id);
    await refuses("invalid_command", () => c.obs.submit(c.eve, { commandId: cid("f"), projectId: c.b, summary: "x", sources: [{ kind: "observation", id }] }));
    const again = await c.obs.record(c.host, { commandId: "obs-review:1-again", kind: "failure", summary: "the same review", sources: [{ kind: "submission", id: sbm }] });
    assert.deepEqual([again.outcome, idOf(again)], ["joined", id]);
    const list = await c.obs.open(c.mgr, c.a);
    assert.equal(list?.items.length, 1, "four retellings count once");
    const got = list!.items[0]!;
    assert.deepEqual([got.kind, got.origin, got.reports, got.reporters, got.taskId, got.disposition], ["failed-review", "controller", 5, [c.host.id, c.dev.id, c.dev2.id], c.taskA, "open"]);
    assert.equal(list!.rate.created, 1);
    // A different review of the same task is a different event.
    const other = await c.obs.record(c.host, { commandId: "obs-review:2", kind: "failed-review", summary: "another review", sources: [{ kind: "submission", id: await c.submission(c.a, c.taskA) }] });
    assert.equal(other.outcome, "created");
    assert.equal((await c.obs.open(c.mgr, c.a))?.items.length, 2);
  });

  suite("friction with no shared event is the same only from the same reporter in the same words", async (c) => {
    const s1 = await c.obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "The lint step takes ten minutes", sources: [{ kind: "task", id: c.taskA }] });
    const s2 = await c.obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "  the LINT step takes   ten minutes ", sources: [{ kind: "task", id: c.taskA }] });
    assert.deepEqual([s1.outcome, s2.outcome, idOf(s2)], ["created", "joined", idOf(s1)]);
    const s3 = await c.obs.submit(c.dev2, { commandId: cid("f"), projectId: c.a, summary: "The lint step takes ten minutes", sources: [{ kind: "task", id: c.taskA }] });
    const s4 = await c.obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "Tests are flaky" });
    assert.deepEqual([s3.outcome, s4.outcome], ["created", "created"]);
    const mine = await c.obs.get(c.dev, idOf(s1));
    assert.deepEqual([mine?.owner, mine?.origin, mine?.kind, mine?.reports], [c.dev.id, "agent", "friction", 2]);
  });

  suite("cross-scope records stay out: other projects' and unreadable sources are refused alike, reads need the project's meeting rights, a reporter sees only itself", async (c) => {
    const foreign = await c.submission(c.b, c.taskB);
    const missing = derivedId("sbm", "never-made");
    for (const sources of [[{ kind: "task", id: c.taskB }], [{ kind: "submission", id: foreign }], [{ kind: "submission", id: missing }]]) {
      await refuses("invalid_command", () => c.obs.submit(c.dev, { commandId: cid("x"), projectId: c.a, summary: "look", sources: sources as never }), /of this project that you may read/);
    }
    await refuses("invalid_command", () => c.obs.record(c.host, { commandId: cid("x"), kind: "failure", summary: "two projects", sources: [{ kind: "task", id: c.taskA }, { kind: "task", id: c.taskB }] }), /same project/);
    await refuses("forbidden", () => c.obs.submit(c.bare, { commandId: cid("x"), projectId: c.a, summary: "no agenda right" }));
    await refuses("forbidden", () => c.obs.submit(c.eve, { commandId: cid("x"), projectId: c.a, summary: "not my project" }));
    await refuses("forbidden", () => c.obs.record(c.dev, { commandId: cid("x"), kind: "failure", summary: "agents do not record for the controller", sources: [{ kind: "task", id: c.taskA }] }));
    // In its own project an agent still cites only what it may read: without task.read, not the task, its submissions or its reviews.
    const own = await c.submission(c.a, c.taskA, c.dev.id);
    const asked = await c.review(c.a, c.taskA, c.dev.id);
    for (const sources of [[{ kind: "task", id: c.taskA }], [{ kind: "submission", id: own }], [{ kind: "review", id: asked }]]) {
      await refuses("invalid_command", () => c.obs.submit(c.scribe, { commandId: cid("x"), projectId: c.a, summary: "look", sources: sources as never }), /of this project that you may read/);
    }
    assert.equal((await c.obs.submit(c.scribe, { commandId: cid("x"), projectId: c.a, summary: "the build is slow" })).outcome, "created", "with no sources it may still report");
    // An agent cannot cite a review it neither asked for nor may read the task of.
    const rev = await c.review(c.a, c.taskA, c.dev.id);
    await refuses("invalid_command", () => c.obs.submit(c.eve, { commandId: cid("x"), projectId: c.b, summary: "peek", sources: [{ kind: "review", id: rev }] }));
    const denied = await c.obs.record(c.host, { commandId: "obs-deny:1", kind: "correction", summary: "the owner denied a request to use deploy", sources: [{ kind: "review", id: rev }] });
    const id = idOf(denied);
    const told = await c.obs.submit(c.dev2, { commandId: cid("f"), projectId: c.a, summary: "deploy was refused", sources: [{ kind: "review", id: rev }] });
    assert.equal(idOf(told), id);
    assert.equal(await c.obs.get(c.eve, id), undefined);
    assert.equal(await c.obs.get(c.bare, id), undefined);
    assert.equal(await c.obs.open(c.eve, c.a), undefined);
    assert.equal(await c.obs.open(c.dev, c.a), undefined, "meeting.agenda alone does not list the project's observations");
    assert.equal((await c.obs.get(c.reader, id))?.reporters.length, 2);
    const asReporter = await c.obs.get(c.dev2, id);
    assert.deepEqual([asReporter?.reporters, asReporter?.reportedBy], [[c.dev2.id], "another reporter"]);
    // Credential-shaped words: an agent's are refused, the controller's are replaced.
    await refuses("invalid_command", () => c.obs.submit(c.dev, { commandId: cid("x"), projectId: c.a, summary: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked" }), /credential/);
    const safe = await c.obs.record(c.host, { commandId: cid("x"), kind: "failure", summary: "push failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789", detail: "line one\nAKIAABCDEFGHIJKLMNOP more", sources: [{ kind: "submission", id: await c.submission(c.a, c.taskA) }] });
    const body = await c.obs.get(c.owner, idOf(safe));
    assert.doesNotMatch(`${body?.summary} ${body?.detail}`, /ghp_abcdefghijklmnop|AKIAABCDEFGHIJKLMNOP/);
  });

  suite("storm limits: per project and hour, per agent and hour, and the open list; the controller is counted, never refused, and the next hour is new", async (c) => {
    const obs = c.make({ limits: { perProjectPerHour: 3, perReporterPerHour: 2, open: 4 } });
    const ev = async () => [{ kind: "submission" as const, id: await c.submission(c.a, c.taskA) }];
    for (let i = 0; i < 3; i++) assert.equal((await obs.record(c.host, { commandId: cid("s"), kind: "failure", summary: `f${i}`, sources: await ev() })).outcome, "created");
    const held = await obs.record(c.host, { commandId: "storm-4", kind: "failure", summary: "f3", sources: await ev() });
    assert.equal(held.outcome, "suppressed");
    assert.equal((await obs.record(c.host, { commandId: "storm-4", kind: "failure", summary: "f3", sources: [{ kind: "submission", id: (await obs.open(c.owner, c.a))!.items[0]!.sources[0]!.id }] }).catch((e: Error) => e)) instanceof DomainError, true, "the same command ID with other content is a conflict");
    await refuses("unavailable", () => obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "storm" }), /this hour/);
    const listed = await obs.open(c.owner, c.a);
    assert.deepEqual([listed?.items.length, listed?.rate.created, listed?.rate.suppressed, listed?.rate.lastSuppressed?.why], [3, 3, 1, "rate"]);
    // A retelling is still counted (no new observation is made), up to the agent's own limit.
    const first = listed!.items[0]!;
    assert.equal((await obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "same", sources: first.sources })).outcome, "joined");
    assert.equal((await obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "same", sources: [{ kind: "observation", id: first.id }] })).outcome, "joined");
    await refuses("unavailable", () => obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "same", sources: [{ kind: "observation", id: first.id }] }), /reported 2/);
    assert.equal((await obs.record(c.host, { commandId: cid("s"), kind: "failure", summary: "again", sources: first.sources })).outcome, "joined", "the controller's retelling always counts");
    // The next hour: new observations again; the open list (4) then holds the line.
    at("2026-11-21T11:00:00.000Z");
    assert.equal((await obs.record(c.host, { commandId: cid("s"), kind: "failure", summary: "f4", sources: await ev() })).outcome, "created");
    const full = await obs.record(c.host, { commandId: cid("s"), kind: "failure", summary: "f5", sources: await ev() });
    assert.equal(full.outcome, "suppressed");
    await refuses("unavailable", () => obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "full" }), /already open/);
    const later = await obs.open(c.owner, c.a);
    assert.deepEqual([later?.rate.created, later?.rate.suppressed, later?.rate.suppressedTotal, later?.rate.lastSuppressed?.why], [1, 1, 2, "open-list"]);
    // Another project is not affected.
    assert.equal((await obs.submit(c.eve, { commandId: cid("f"), projectId: c.b, summary: "fine here" })).outcome, "created");
  });

  suite("a manager settles an observation: promoted to an improvement of the project, dismissed or resolved with a reason, open again; others may not", async (c) => {
    const id = idOf(await c.obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "The lint step takes ten minutes" }));
    const rev = (await c.obs.get(c.mgr, id))!.revision;
    await refuses("forbidden", () => c.obs.dispose(c.dev, { commandId: cid("d"), observationId: id, expectedRevision: rev, to: "dismissed", reason: "mine" }));
    await refuses("forbidden", () => c.obs.dispose(c.eve, { commandId: cid("d"), observationId: id, expectedRevision: rev, to: "dismissed", reason: "not yours" }));
    await refuses("invalid_command", () => c.obs.dispose(c.mgr, { commandId: cid("d"), observationId: id, expectedRevision: rev, to: "dismissed" }), /reason/);
    const foreignImp = await c.improvement(c.b);
    await refuses("invalid_command", () => c.obs.dispose(c.mgr, { commandId: cid("d"), observationId: id, expectedRevision: rev, to: "promoted", improvementId: foreignImp }), /of this project/);
    await refuses("stale_revision", () => c.obs.dispose(c.mgr, { commandId: cid("d"), observationId: id, expectedRevision: rev + 1, to: "resolved", reason: "x" }));
    const imp = await c.improvement(c.a);
    const promoted = await c.obs.dispose(c.mgr, { commandId: cid("d"), observationId: id, expectedRevision: rev, to: "promoted", improvementId: imp, owner: c.dev2.id });
    const after1 = await c.obs.get(c.mgr, id);
    assert.deepEqual([after1?.disposition, after1?.improvementId, after1?.owner, after1?.revision], ["promoted", imp, c.dev2.id, promoted.revision]);
    assert.equal((await c.obs.open(c.mgr, c.a))?.items.length, 0, "a settled observation leaves the open list");
    // A retelling of a settled observation still counts once and does not reopen it.
    assert.equal((await c.obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "lint again", sources: [{ kind: "observation", id }] })).outcome, "joined");
    assert.equal((await c.obs.get(c.mgr, id))?.disposition, "promoted");
    const current = (await c.obs.get(c.mgr, id))!.revision;
    const reopened = await c.obs.dispose(c.owner, { commandId: cid("d"), observationId: id, expectedRevision: current, to: "open" });
    assert.equal((await c.obs.open(c.mgr, c.a))?.items.length, 1);
    await c.obs.dispose(c.owner, { commandId: cid("d"), observationId: id, expectedRevision: reopened.revision, to: "resolved", reason: "lint is cached now" });
    const done = await c.obs.get(c.owner, id);
    assert.deepEqual([done?.disposition, done?.reason, done?.improvementId, done?.history.map((h) => h.to)], ["resolved", "lint is cached now", undefined, ["open", "promoted", "open", "resolved"]]);
  });

  suite("two controllers telling the same event at once make one observation, and the hour's limit holds across them", async (c) => {
    const sbm = await c.submission(c.a, c.taskA);
    const one = c.make(), two = c.make();
    const both = await Promise.all([
      one.record(c.host, { commandId: "two-a", kind: "failed-review", summary: "seen here", sources: [{ kind: "submission", id: sbm }] }),
      two.record(c.owner, { commandId: "two-b", kind: "failed-review", summary: "seen there", sources: [{ kind: "submission", id: sbm }] }),
    ]);
    assert.equal(idOf(both[0]!), idOf(both[1]!));
    assert.deepEqual(both.map((r) => r.outcome).sort(), ["created", "joined"]);
    const got = await c.obs.get(c.owner, idOf(both[0]!));
    assert.equal(got?.reports, 2);
    const limited = [c.make({ limits: { perProjectPerHour: 4 } }), c.make({ limits: { perProjectPerHour: 4 } })];
    const sources = await Promise.all(Array.from({ length: 8 }, () => c.submission(c.a, c.taskA)));
    const outcomes = await Promise.all(sources.map((id, i) => limited[i % 2]!.record(c.host, { commandId: `burst-${i}`, kind: "failure", summary: `burst ${i}`, sources: [{ kind: "submission", id }] })));
    assert.equal(outcomes.filter((o) => o.outcome === "created").length, 3, "one was already made this hour, so three more fit under four");
    assert.equal(outcomes.filter((o) => o.outcome === "suppressed").length, 5);
    const rate = (await c.obs.open(c.owner, c.a))?.rate;
    assert.deepEqual([rate?.created, rate?.suppressed], [4, 5]);
  });
}

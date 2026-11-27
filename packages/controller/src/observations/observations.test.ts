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
  /** A stall concern record as the stall service names it (card V02): the task's part, the generation, the kind. */
  concern(project: string, task: string, generation?: number, kind?: string): Promise<string>;
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
        const concern: Ctx["concern"] = async (project, task, generation = 1, kind = "loop") => { const id = `stl-${task.slice(5)}-${String(generation).padStart(10, "0")}-${kind}`; await put("stall-concern", id, { projectId: project, taskId: task, generation, kind: kind.replace("-", "_"), state: "confirmed", reopened: 0 }); return id; };
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
          a, b, taskA, taskB, obs: make(), storage: world.storage, epoch, make, submission, review, improvement, concern,
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
    const denied = await c.obs.record(c.host, { commandId: "obs-deny:1", kind: "correction", summary: "the owner denied a request to use deploy", detail: "not on the shared tree", sources: [{ kind: "review", id: rev }, { kind: "task", id: c.taskA }] });
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
    // Nor who owns or settled it, another reporter's detail, or the context records another reporter named.
    const settled = await c.obs.dispose(c.mgr, { commandId: cid("d"), observationId: id, expectedRevision: (await c.obs.get(c.mgr, id))!.revision, to: "resolved", reason: "fixed", owner: c.dev.id });
    const masked = await c.obs.get(c.dev2, id);
    assert.deepEqual([masked?.owner, masked?.detail, masked?.sources, masked?.history.map((h) => h.by), masked?.revision], ["someone else", undefined, [{ kind: "review", id: rev }], ["someone else", "someone else"], settled.revision]);
    assert.doesNotMatch(JSON.stringify(masked), new RegExp(`${c.dev.id}(?!2)|${c.mgr.id}|${c.host.id}|shared tree`));
    assert.deepEqual([(await c.obs.get(c.mgr, id))?.owner, (await c.obs.get(c.mgr, id))?.detail], [c.dev.id, "not on the shared tree"], "a reader of the project's meetings sees all");
    // A task credential acts only in its own task's project: one of another project neither reads its holder's reports nor reports here; the controller's record takes no task credential.
    const elsewhere = { ...c.dev2, taskScope: { taskId: c.taskB, projectId: c.b } } as Principal;
    assert.equal(await c.obs.get(elsewhere, id), undefined);
    await refuses("forbidden", () => c.obs.submit(elsewhere, { commandId: cid("x"), projectId: c.a, summary: "from another task" }));
    assert.equal((await c.obs.get({ ...c.dev2, taskScope: { taskId: c.taskA, projectId: c.a } } as Principal, id))?.reportedBy, "another reporter");
    assert.equal(await c.obs.open({ ...c.mgr, taskScope: { taskId: c.taskB, projectId: c.b } } as Principal, c.a), undefined);
    await refuses("forbidden", () => c.obs.record({ ...c.host, taskScope: { taskId: c.taskA, projectId: c.a } } as Principal, { commandId: cid("x"), kind: "failure", summary: "x", sources: [{ kind: "task", id: c.taskA }] }));
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

  suite("the hour never goes back: a clock set back or a second controller whose clock is behind counts against the hour already recorded", async (c) => {
    const limits = { perProjectPerHour: 2, perReporterPerHour: 1, open: 50 };
    const ahead = c.make({ limits });
    // The other controller's clock is two minutes behind, just before the hour.
    const behind = c.make({ limits, clock: () => new Date(now - 120_000).toISOString() });
    at("2026-11-21T11:01:00.000Z");
    const ev = async () => [{ kind: "submission" as const, id: await c.submission(c.a, c.taskA) }];
    assert.equal((await ahead.record(c.host, { commandId: cid("s"), kind: "failure", summary: "one", sources: await ev() })).outcome, "created");
    assert.equal((await ahead.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "two" })).outcome, "created");
    // Behind (10:59): the counts of 11:00 hold; nothing starts again at zero.
    assert.equal((await behind.record(c.host, { commandId: cid("s"), kind: "failure", summary: "three", sources: await ev() })).outcome, "suppressed");
    await refuses("unavailable", () => behind.submit(c.dev2, { commandId: cid("f"), projectId: c.a, summary: "four" }), /after 12:00 UTC/);
    await refuses("unavailable", () => behind.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "five" }), /reported 1 .*after 12:00 UTC/);
    const seen = await behind.open(c.owner, c.a);
    assert.deepEqual([seen?.rate.hour, seen?.rate.created, seen?.rate.suppressed], ["2026-11-21T11:00:00.000Z", 2, 1]);
    // The whole clock set back an hour: still the same counts.
    at("2026-11-21T10:30:00.000Z");
    assert.equal((await ahead.record(c.host, { commandId: cid("s"), kind: "failure", summary: "six", sources: await ev() })).outcome, "suppressed");
    // Forward into the next hour: new counts.
    at("2026-11-21T12:00:00.000Z");
    assert.equal((await ahead.record(c.host, { commandId: cid("s"), kind: "failure", summary: "seven", sources: await ev() })).outcome, "created");
    assert.deepEqual([(await ahead.open(c.owner, c.a))?.rate.created, (await ahead.open(c.owner, c.a))?.rate.suppressedTotal], [1, 2]);
    // A controller whose clock is days ahead cannot hold everyone's counts in its far-off hour: a recorded hour more than a day ahead is not trusted.
    const future = c.make({ limits, clock: () => new Date(now + 3 * 86_400_000).toISOString() });
    assert.equal((await future.record(c.host, { commandId: cid("s"), kind: "failure", summary: "eight", sources: await ev() })).outcome, "created");
    assert.equal((await future.record(c.host, { commandId: cid("s"), kind: "failure", summary: "nine", sources: await ev() })).outcome, "created");
    assert.equal((await ahead.record(c.host, { commandId: cid("s"), kind: "failure", summary: "ten", sources: await ev() })).outcome, "created", "the far-future hour's counts do not hold this controller");
    const own = await ahead.open(c.owner, c.a);
    assert.deepEqual([own?.rate.hour, own?.rate.created], ["2026-11-21T12:00:00.000Z", 1]);
    // Up to a day ahead is still the later hour (a clock set back by hours does not start the counts again).
    const dayAhead = c.make({ limits, clock: () => new Date(now + 23 * 3_600_000).toISOString() });
    assert.equal((await dayAhead.record(c.host, { commandId: cid("s"), kind: "failure", summary: "eleven", sources: await ev() })).outcome, "created");
    assert.equal((await dayAhead.record(c.host, { commandId: cid("s"), kind: "failure", summary: "twelve", sources: await ev() })).outcome, "created");
    assert.equal((await ahead.record(c.host, { commandId: cid("s"), kind: "failure", summary: "thirteen", sources: await ev() })).outcome, "suppressed", "an hour less than a day ahead holds");
  });

  suite("an agent that tells an event first does not decide the controller's record of it, and another agent's words stay its own", async (c) => {
    // The agent cites its own review request before the owner denies it; the denial then becomes the record, kind, words, detail and all.
    const rev = await c.review(c.a, c.taskA, c.dev.id);
    const early = await c.obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "My deploy request is fine, nothing to see", detail: "my own words", sources: [{ kind: "review", id: rev }, { kind: "task", id: c.taskA }] });
    assert.equal(early.outcome, "created");
    const denied = await c.obs.record(c.host, { commandId: "obs-deny:early", kind: "correction", summary: "the owner denied a request to use deploy", detail: "not on the shared tree", sources: [{ kind: "review", id: rev }] });
    assert.deepEqual([denied.outcome, idOf(denied)], ["joined", idOf(early)]);
    const full = await c.obs.get(c.mgr, idOf(early));
    assert.deepEqual([full?.kind, full?.origin, full?.reportedBy, full?.summary, full?.detail, full?.owner, full?.reports, full?.reporters], ["correction", "controller", c.host.id, "the owner denied a request to use deploy", "not on the shared tree", undefined, 2, [c.dev.id, c.host.id]]);
    assert.equal((await c.obs.open(c.mgr, c.a, { kind: "correction" }))?.items.length, 1, "found under the controller's kind");
    const asDev = await c.obs.get(c.dev, idOf(early));
    assert.deepEqual([asDev?.reportedBy, asDev?.detail, asDev?.owner], ["another reporter", undefined, undefined]);
    // Two agents: the later one sees neither the first one's words nor the task its context records named.
    const sbm = await c.submission(c.a, c.taskA, c.dev.id);
    const one = await c.obs.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "The reviewer keeps asking for the same rename", detail: "private detail", sources: [{ kind: "task", id: c.taskA }, { kind: "submission", id: sbm }] });
    const two = await c.obs.submit(c.dev2, { commandId: cid("f"), projectId: c.a, summary: "rename again", sources: [{ kind: "submission", id: sbm }] });
    assert.equal(idOf(two), idOf(one));
    const asDev2 = await c.obs.get(c.dev2, idOf(one));
    assert.deepEqual([asDev2?.reportedBy, asDev2?.taskId, asDev2?.sources], ["another reporter", undefined, [{ kind: "submission", id: sbm }]]);
    assert.doesNotMatch(JSON.stringify(asDev2), /same rename|private detail|agent:dev(?!2)/);
    assert.equal((await c.obs.get(c.dev, idOf(one)))?.summary, "The reviewer keeps asking for the same rename", "the first reporter sees its own words");
  });

  suite("agents' new observations leave room for the controller in the hour and in the open list", async (c) => {
    const ev = async () => [{ kind: "submission" as const, id: await c.submission(c.a, c.taskA) }];
    const hourly = c.make({ limits: { perProjectPerHour: 4, open: 100 } });
    for (const [i, who] of [c.dev, c.dev2, c.scribe].entries()) assert.equal((await hourly.submit(who, { commandId: cid("f"), projectId: c.a, summary: `slow step ${i}` })).outcome, "created");
    await refuses("unavailable", () => hourly.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "slow step 3" }), /most agents may add/);
    assert.equal((await hourly.record(c.host, { commandId: cid("s"), kind: "failure", summary: "the controller's", sources: await ev() })).outcome, "created", "a quarter of the hour is the controller's");
    at("2026-11-21T11:00:00.000Z");
    const listed = c.make({ limits: { perProjectPerHour: 100, open: 10 } });
    for (let i = 0; i < 5; i++) assert.equal((await listed.submit(c.dev2, { commandId: cid("f"), projectId: c.a, summary: `list item ${i}` })).outcome, "created");
    await refuses("unavailable", () => listed.submit(c.dev, { commandId: cid("f"), projectId: c.a, summary: "list item 5" }), /9 observations are already open/);
    assert.equal((await listed.record(c.host, { commandId: cid("s"), kind: "failure", summary: "the controller's too", sources: await ev() })).outcome, "created", "the last tenth of the open list is the controller's");
    assert.equal((await listed.record(c.host, { commandId: cid("s"), kind: "failure", summary: "and then full", sources: await ev() })).outcome, "suppressed");
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
  suite("a stall concern is an event by its stage and episode: a failure and its recovery are two observations, each told once; only the controller cites one; malformed citations are refused; text is redacted; nothing is granted (card B02, second slice)", async (c) => {
    const stl = await c.concern(c.a, c.taskA);
    const src = (event: string) => [{ kind: "stall-concern" as const, id: stl, event }];
    const before = await c.storage.getAggregate({ kind: "stall-concern", id: stl });
    const failed = await c.obs.record(c.host, { commandId: `obs-stall:${stl}:confirmed.0`, kind: "failure", summary: "owner:rob confirmed that task one is stalled (loop).", detail: "looping on the same test", sources: src("confirmed.0") });
    assert.equal(failed.outcome, "created");
    const fid = idOf(failed);
    // A second controller telling the same stage of the same episode, under another command and kind, joins it; the same command again is answered as recorded.
    const twice = await c.make().record(c.host, { commandId: "another-controller", kind: "correction", summary: "the same confirmation", sources: src("confirmed.0") });
    assert.deepEqual([twice.outcome, idOf(twice)], ["joined", fid]);
    const replay = await c.make().record(c.host, { commandId: `obs-stall:${stl}:confirmed.0`, kind: "failure", summary: "owner:rob confirmed that task one is stalled (loop).", detail: "looping on the same test", sources: src("confirmed.0") });
    assert.deepEqual([idOf(replay), replay.replayed], [fid, true]);
    // The recovery of that episode, and the failure of the next episode, are other events.
    const recovered = await c.obs.record(c.host, { commandId: `obs-stall:${stl}:recovered.0`, kind: "recovery", summary: "Task one recovered from a loop stall after 1 recovery step(s) (nudge).", detail: "the signals recovered", sources: src("recovered.0") });
    const again = await c.obs.record(c.host, { commandId: `obs-stall:${stl}:confirmed.1`, kind: "failure", summary: "it came back", sources: src("confirmed.1") });
    assert.equal(new Set([fid, idOf(recovered), idOf(again)]).size, 3);
    // The same concern named with its event twice is one source; with the same event and another context record it is still the same event.
    const dup = await c.obs.record(c.host, { commandId: cid("x"), kind: "failure", summary: "x", sources: [...src("confirmed.0"), ...src("confirmed.0"), { kind: "task", id: c.taskA }] });
    assert.deepEqual([dup.outcome, idOf(dup)], ["joined", fid]);
    const got = (await c.obs.get(c.mgr, fid))!;
    assert.deepEqual([got.kind, got.origin, got.taskId, got.reports, got.sources], ["failure", "controller", c.taskA, 3, [{ kind: "stall-concern", id: stl, event: "confirmed.0" }]]);
    const list = (await c.obs.open(c.mgr, c.a))!;
    assert.deepEqual(list.items.map((x) => x.kind).sort(), ["failure", "failure", "recovery"]);
    assert.equal(list.rate.created, 3);

    // Only the controller cites a concern: an agent may not, whatever its rights, and is told the kinds it may cite. It retells the failure by citing the observation, which joins it.
    for (const by of [c.dev, c.mgr]) await refuses("invalid_command", () => c.obs.submit(by, { commandId: cid("x"), projectId: c.a, summary: "the stall was mine", sources: src("confirmed.0") }), /task, artifact, desk-record, submission, review, observation with its ID/);
    // dev may not read the project's observations, so it may not cite this one; a manager may, and its retelling joins.
    await refuses("invalid_command", () => c.obs.submit(c.dev, { commandId: cid("x"), projectId: c.a, summary: "I was stuck on that test", sources: [{ kind: "observation", id: fid }] }), /of this project that you may read/);
    const retold = await c.obs.submit(c.mgr, { commandId: cid("f"), projectId: c.a, summary: "I was stuck on that test", sources: [{ kind: "observation", id: fid }] });
    assert.deepEqual([retold.outcome, idOf(retold)], ["joined", fid]);
    assert.equal((await c.obs.get(c.mgr, fid))!.reports, 4);

    // Malformed citations are refused before anything is read: the event is required with a concern, has one shape, and nothing else carries one; concern IDs have one shape.
    // Each refused by its own check (the message says which), so a looser check is not hidden by a later one.
    const hostile: [unknown[], RegExp | undefined][] = [
      [[{ kind: "stall-concern", id: stl }], /names its event: confirmed/],
      ...["confirmed", "recovered.", "confirmed.01", "confirmed.-1", "confirmed.1000000000", "failed.1", "confirmed.1\n", "Confirmed.1", "confirmed.1.2", " confirmed.1", "", "confirmed.१"].map((event): [unknown[], RegExp] => [[{ kind: "stall-concern", id: stl, event }], /names its event: confirmed/]),
      ...[1, null, { stage: "confirmed" }].map((event): [unknown[], RegExp] => [[{ kind: "stall-concern", id: stl, event }], /names its event: confirmed/]),
      [[{ kind: "submission", id: await c.submission(c.a, c.taskA), event: "confirmed.0" }], /only a stall concern names an event/], [[{ kind: "task", id: c.taskA, event: "confirmed.0" }], /only a stall concern names an event/],
      ...[`stl-${c.taskA.slice(5)}-0000000001-other`, `stl-${c.taskA.slice(5)}-000000001-loop`, `stl-${c.taskA.slice(5)}-0000000001-repeated_errors`, `stl-../../${c.taskA.slice(5)}-0000000001-loop`, `stl-${c.taskA.slice(5).toUpperCase()}-0000000001-loop`, `${stl}\n`, `${stl}-x`, `stl-${"a".repeat(19)}-0000000001-loop`, c.taskA].map((id): [unknown[], RegExp] => [[{ kind: "stall-concern", id, event: "confirmed.0" }], /with its ID/]),
      [[{ kind: "stall-concern", id: stl, event: "confirmed.0", extra: true }], undefined],
    ];
    for (const [sources, why] of hostile) await refuses("invalid_command", () => c.obs.record(c.host, { commandId: cid("x"), kind: "failure", summary: "x", sources: sources as never }), why);
    // One command ID is one event: the same ID telling another episode is a conflict, not a replay of the first.
    await c.obs.record(c.host, { commandId: "obs-stall:conflict", kind: "failure", summary: "x", sources: src("confirmed.7") });
    await refuses("command_conflict", () => c.obs.record(c.host, { commandId: "obs-stall:conflict", kind: "failure", summary: "x", sources: src("confirmed.8") }));
    // A well-formed concern that does not exist, or of another project than the other sources, is refused like any source.
    const ghost = `stl-${c.taskA.slice(5)}-0000000007-silent`;
    await refuses("invalid_command", () => c.obs.record(c.host, { commandId: cid("x"), kind: "failure", summary: "x", sources: [{ kind: "stall-concern", id: ghost, event: "confirmed.0" }] }), /same project/);
    const foreign = await c.concern(c.b, c.taskB, 1, "stuck-request");
    await refuses("invalid_command", () => c.obs.record(c.host, { commandId: cid("x"), kind: "failure", summary: "x", sources: [{ kind: "stall-concern", id: foreign, event: "confirmed.0" }, { kind: "task", id: c.taskA }] }), /same project/);
    // A concern of the other project is that project's observation, unseen from here.
    const there = idOf(await c.obs.record(c.host, { commandId: cid("x"), kind: "failure", summary: "elsewhere", sources: [{ kind: "stall-concern", id: foreign, event: "confirmed.0" }] }));
    assert.equal(await c.obs.get(c.mgr, there), undefined);
    assert.equal((await c.obs.open(c.mgr, c.a))!.items.some((x) => x.id === there), false);

    // The decider's words are the detail: credential-shaped text and control characters are made safe, length is cut.
    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const said = await c.obs.record(c.host, { commandId: cid("x"), kind: "failure", summary: `confirmed with token ${secret}\nnext line`, detail: `reason: use ${secret}\u0007${"x".repeat(5000)}`, sources: src("confirmed.5") });
    const shown = (await c.obs.get(c.owner, idOf(said)))!;
    assert.ok(!shown.summary.includes(secret) && !(shown.detail ?? "").includes(secret), JSON.stringify(shown).slice(0, 300));
    assert.ok(!shown.summary.includes("\n"));
    assert.ok([...(shown.detail ?? "")].length <= 2000);

    // An observation changes nothing it cites and grants nothing: the concern is as it was, and the agents' rights are unchanged.
    const after = await c.storage.getAggregate({ kind: "stall-concern", id: stl });
    assert.deepEqual([after?.revision, after?.body], [before?.revision, before?.body]);
    await refuses("invalid_command", () => c.obs.submit(c.scribe, { commandId: cid("x"), projectId: c.a, summary: "x", sources: [{ kind: "task", id: c.taskA }] }), /of this project that you may read/);
    assert.equal(await c.obs.get(c.bare, fid), undefined, "being cited gives no read");
  });
}

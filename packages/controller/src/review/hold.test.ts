import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import type { Availability } from "../conversations/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { AssignmentService } from "../domain/assignments.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { HostService } from "../hosts/index.js";
import { PauseService } from "../lifecycle/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ReviewService, type Operation } from "./index.js";
import type { ReviewBody } from "./review.js";
import type { ReviewRouteBody } from "./routing.js";

after(stopServer);

let now = Date.parse("2026-10-22T10:00:00.000Z");
const minutes = (m: number): void => { now += m * 60_000; };
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    review: ReviewService; owner: Principal; a: string; task: string; storage: Parameters<typeof ReviewService.withEpoch>[0]; epoch: number;
    ann: Principal; r1: Principal; r2: Principal; r3: Principal; admin: Principal;
    /** What `availability` answers for a reviewer (default available). */
    availability: Map<string, Availability>;
    /** The host a reviewer runs on. */
    hostOf: Map<string, string>;
    host(name: string, beat?: boolean): Promise<string>;
    revoke(id: string): Promise<void>;
    beat(host: string): Promise<void>;
    policy(policy: object, expectedRevision?: number): Promise<void>;
    sweep(): Promise<{ reassigned: string[]; escalated: string[]; assigned: string[]; more: boolean }>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-22T10:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const hosts = HostService.withEpoch(world.storage, projects.epoch, assignments, { ...options, staleAfterMs: 60_000 });
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const enrolled = async (kind: "agent" | "host", nm: string, grants: Grant[]) => {
          await principals.enroll(owner, { commandId: cid("e"), kind, name: nm, grants });
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${nm}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "the task" })).id;
        const availability = new Map<string, Availability>();
        const hostOf = new Map<string, string>();
        const review = ReviewService.withEpoch(world.storage, projects.epoch, { ...options, availability: async (id) => availability.get(id) ?? "available", reviewerHost: async (id) => hostOf.get(id), hostStaleAfterMs: 60_000 });
        const reviewer = (nm: string) => enrolled("agent", nm, [{ action: "review.decide", project: a }, { action: "attempt.work", project: a }]);
        const ann = await enrolled("agent", "ann", [{ action: "review.request", project: a }, { action: "attempt.work", project: a }, { action: "tool.run-script", project: a }]);
        const r1 = await reviewer("r1"), r2 = await reviewer("r2"), r3 = await reviewer("r3");
        const admin = await enrolled("agent", "admin", [{ action: "review.policy.write", project: a }]);
        const hostPrincipals = new Map<string, Principal>();
        const seq = new Map<string, number>();
        const host = async (nm: string, beat = true): Promise<string> => {
          const p = await enrolled("host", nm, []);
          hostPrincipals.set(p.id, p);
          await hosts.announce(p, { commandId: cid("an"), capabilities: { os: "linux", arch: "x64", harnesses: [], isolation: [], tools: [], workspaces: [] } });
          if (beat) { seq.set(p.id, 1); await hosts.heartbeat(p, { commandId: cid("hb"), sequence: 1 }); }
          return p.id;
        };
        const beat = async (id: string): Promise<void> => { const s = (seq.get(id) ?? 0) + 1; seq.set(id, s); await hosts.heartbeat(hostPrincipals.get(id)!, { commandId: cid("hb"), sequence: s }); };
        const revoke = async (id: string): Promise<void> => { const f = await world.storage.getAggregate({ kind: "principal", id }); await principals.disable(owner, { commandId: cid("dis"), principalId: id, expectedRevision: f!.revision }); };
        const policy = (p: object, expectedRevision?: number) => review.setPolicy(admin, { commandId: cid("pol"), projectId: a, policy: p, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
        const sweep = () => review.sweep(admin, { commandId: cid("sw"), projectId: a });
        await body({ review, owner, a, task, storage: world.storage, epoch: projects.epoch, ann, r1, r2, r3, admin, availability, hostOf, host, revoke, beat, policy, sweep });
      } finally { await world.close(); }
    });

  const op = (extra: Partial<Operation> = {}): Operation => ({ name: "run-script", args: { cwd: "/work" }, script: "echo hello\n", target: { kind: "workspace", id: "main" }, ...extra });
  const context = { toolVersion: "1.2.3", authoritySource: "task grant", expectedEffects: ["builds the project"] };
  const ask = (c: Ctx, operation: Operation = op()) => c.review.request(c.ann, { commandId: cid("rq"), taskId: c.task, operation, context });
  const decide = async (c: Ctx, who: Principal, id: string, verdict: "allow" | "deny") => {
    const v = (await c.review.get(c.owner, id))!;
    await c.review.decide(who, { commandId: cid("dc"), requestId: id, expectedRevision: v.revision, verdict, reason: `${verdict} because` });
  };
  const route = async (c: Ctx, id: string): Promise<ReviewRouteBody> => (await c.review.getRoute(c.owner, id))!;
  const state = async (c: Ctx, id: string): Promise<ReviewBody["state"]> => (await c.review.get(c.owner, id))!.state;
  const events = async (c: Ctx, id: string, kind: string): Promise<number> => (await route(c, id)).events.filter((e) => e.event === kind).length;
  const noop = { reassigned: [], escalated: [], assigned: [], more: false };

  suite("a held reviewer keeps its review: no reassignment before the deadline, no decision while held, a decision after the resume", async (c) => {
    await c.policy({ reviewers: ["agent:r1", "agent:r2"], deadlineMinutes: 30 });
    const r = await ask(c);
    assert.equal((await route(c, r.id)).assigned, "agent:r1");
    c.availability.set("agent:r1", "paused");
    minutes(10);
    // The sweep notes the hold and moves nothing; the deadline is the original one.
    const deadline = (await route(c, r.id)).deadline;
    assert.deepEqual(await c.sweep(), noop);
    let now1 = await route(c, r.id);
    assert.deepEqual([now1.state, now1.assigned, now1.reviewerStatus, now1.tried, now1.deadline], ["assigned", "agent:r1", "held", [], deadline]);
    assert.equal(await events(c, r.id, "held"), 1);
    assert.equal(await state(c, r.id), "pending");
    // Repeating the sweep changes nothing and records nothing more.
    const revision = (await c.review.getRoute(c.owner, r.id))!.revision;
    assert.deepEqual(await c.sweep(), noop);
    assert.equal((await c.review.getRoute(c.owner, r.id))!.revision, revision);
    // Nobody is woken for it, and the held reviewer does not decide; the review is not approved or denied by anyone else's turn.
    await refuses("invalid_command", () => decide(c, c.r1, r.id, "allow"), (e) => assert.match(e.message, /paused/));
    await refuses("forbidden", () => decide(c, c.r2, r.id, "allow"));
    assert.equal(await state(c, r.id), "pending");
    const listed = await c.review.wakeList(c.admin, c.a);
    assert.deepEqual([listed.wake, listed.held], [[], [{ requestId: r.id, reviewer: "agent:r1", why: "paused" }]]);
    // Resumed: the same reviewer still has the review, the sweep notes it, and the decision is theirs.
    c.availability.delete("agent:r1");
    assert.deepEqual(await c.sweep(), noop);
    now1 = await route(c, r.id);
    assert.deepEqual([now1.assigned, now1.reviewerStatus, now1.tried], ["agent:r1", undefined, []]);
    assert.equal(await events(c, r.id, "resumed"), 1);
    assert.equal(now1.deadline, deadline, "resuming does not extend the deadline");
    assert.deepEqual((await c.review.wakeList(c.admin, c.a)).wake, [{ requestId: r.id, reviewer: "agent:r1" }]);
    await decide(c, c.r1, r.id, "allow");
    assert.equal(await state(c, r.id), "approved");
  });

  suite("held, suspended and stopped reviewers are skipped when a reviewer is chosen, and a review with nobody else waits instead of being approved", async (c) => {
    c.availability.set("agent:r1", "paused");
    assert.equal((await route(c, (await ask(c, op({ args: { n: 1 } }))).id)).assigned, "agent:r2");
    c.availability.set("agent:r2", "suspended");
    assert.equal((await route(c, (await ask(c, op({ args: { n: 2 } }))).id)).assigned, "agent:r3");
    c.availability.set("agent:r3", "stopped");
    const last = await ask(c, op({ args: { n: 3 } }));
    const waiting = await route(c, last.id);
    assert.deepEqual([waiting.state, waiting.assigned], ["waiting", undefined]);
    assert.match(waiting.events.at(-1)!.detail, /agent:r1 is paused/);
    assert.equal(await state(c, last.id), "pending");
    assert.deepEqual(await c.sweep(), noop);
    assert.deepEqual((await c.review.wakeList(c.admin, c.a)).wake.map((w) => w.requestId).includes(last.id), false);
    // Whoever is resumed first takes it at the next sweep.
    c.availability.delete("agent:r3");
    assert.deepEqual((await c.sweep()).assigned, [last.id]);
    assert.equal((await route(c, last.id)).assigned, "agent:r3");
  });

  suite("a held reviewer's review moves on under the project policy at the deadline: to another reviewer, then the fallback, then the owner, and never by approval", async (c) => {
    await c.policy({ reviewers: ["agent:r1"], fallbackReviewers: ["agent:r3"], deadlineMinutes: 20 });
    const r = await ask(c);
    c.availability.set("agent:r1", "paused");
    minutes(19);
    assert.deepEqual(await c.sweep(), noop);
    assert.equal((await route(c, r.id)).assigned, "agent:r1");
    minutes(2);
    assert.deepEqual((await c.sweep()).reassigned, [r.id]);
    const moved = await route(c, r.id);
    assert.deepEqual([moved.assigned, moved.assignedVia, moved.tried, moved.reviewerStatus], ["agent:r3", "fallback", ["agent:r1"], undefined]);
    assert.match(moved.events.at(-1)!.detail, /agent:r1 was held and did not decide by the deadline/);
    assert.equal(await state(c, r.id), "pending");
    // The fallback is held too: at the next deadline the owner decides.
    c.availability.set("agent:r3", "stopped");
    minutes(21);
    assert.deepEqual((await c.sweep()).escalated, [r.id]);
    assert.equal(await state(c, r.id), "owner-decision");
    assert.equal((await route(c, r.id)).verdict, undefined);
    // Resuming the old reviewer does not give the review back; only the owner decides it now.
    c.availability.clear();
    minutes(500);
    assert.deepEqual(await c.sweep(), noop);
    await refuses("forbidden", () => decide(c, c.r1, r.id, "allow"));
    assert.equal(await state(c, r.id), "owner-decision");
    await decide(c, c.owner, r.id, "deny");
    assert.equal(await state(c, r.id), "denied");
  });

  suite("a lost reviewer host moves the review at once; a quiet host or a slow reviewer waits for the deadline", async (c) => {
    const h1 = await c.host("hh1"), h2 = await c.host("hh2");
    c.hostOf.set("agent:r1", h1); c.hostOf.set("agent:r2", h2);
    await c.policy({ reviewers: ["agent:r1", "agent:r2"], deadlineMinutes: 30 });
    const r = await ask(c);
    assert.equal((await route(c, r.id)).assigned, "agent:r1");
    // Slow: the host is alive and heartbeating, the reviewer has not decided. Nothing moves before the deadline.
    minutes(20); await c.beat(h1);
    assert.deepEqual(await c.sweep(), noop);
    assert.deepEqual([(await route(c, r.id)).assigned, (await route(c, r.id)).reviewerStatus], ["agent:r1", undefined]);
    // Quiet: heartbeats stop. That is also what a partition looks like, so it is noted and the deadline stands.
    minutes(5);
    assert.deepEqual(await c.sweep(), noop);
    assert.deepEqual([(await route(c, r.id)).assigned, (await route(c, r.id)).reviewerStatus], ["agent:r1", "host-silent"]);
    assert.match((await route(c, r.id)).events.at(-1)!.detail, /cannot tell a lost host from a partition/);
    // Lost: the host's identity is revoked, an independent fact. The review moves now, not at the deadline.
    await c.revoke(h1);
    assert.deepEqual((await c.sweep()).reassigned, [r.id]);
    const moved = await route(c, r.id);
    assert.deepEqual([moved.assigned, moved.tried, moved.reviewerStatus], ["agent:r2", ["agent:r1"], undefined]);
    assert.match(moved.events.at(-1)!.detail, /the host of agent:r1 is lost/);
    assert.equal(await state(c, r.id), "pending");
    // A lost host is not chosen for a new review either.
    c.hostOf.set("agent:r3", h1);
    await c.policy({ reviewers: ["agent:r1", "agent:r3"] }, 1);
    const fresh = await ask(c, op({ args: { n: 9 } }));
    assert.equal((await route(c, fresh.id)).state, "waiting");
    assert.match((await route(c, fresh.id)).events.at(-1)!.detail, /its host is lost/);
  });

  suite("a lost host with no one else eligible is noted and kept to the deadline, then the owner decides; a held reviewer on a lost host keeps the review until the deadline", async (c) => {
    const h1 = await c.host("hh1");
    c.hostOf.set("agent:r1", h1);
    await c.policy({ reviewers: ["agent:r1"], deadlineMinutes: 30 });
    const r = await ask(c);
    await c.revoke(h1);
    minutes(10);
    assert.deepEqual(await c.sweep(), noop);
    assert.deepEqual([(await route(c, r.id)).assigned, (await route(c, r.id)).reviewerStatus], ["agent:r1", "host-lost"]);
    assert.deepEqual((await c.review.wakeList(c.admin, c.a)).held, [{ requestId: r.id, reviewer: "agent:r1", why: "host-lost" }]);
    minutes(25);
    assert.deepEqual((await c.sweep()).escalated, [r.id]);
    assert.equal(await state(c, r.id), "owner-decision");
    // Held takes precedence over a lost host: the hold keeps the place to the deadline even when others are eligible.
    await c.policy({ reviewers: ["agent:r1", "agent:r2"] }, 1);
    const r2 = await ask(c, op({ args: { n: 2 } }));
    assert.equal((await route(c, r2.id)).assigned, "agent:r2");
    c.availability.set("agent:r2", "paused");
    c.hostOf.set("agent:r2", h1);
    assert.deepEqual(await c.sweep(), noop);
    assert.deepEqual([(await route(c, r2.id)).assigned, (await route(c, r2.id)).reviewerStatus], ["agent:r2", "held"]);
  });

  suite("the wake list is for those who manage reviews, covers only pending assigned reviews", async (c) => {
    await refuses("forbidden", () => c.review.wakeList(c.ann, c.a));
    await refuses("forbidden", () => c.review.wakeList(c.r1, c.a));
    const r = await ask(c);
    const other = await ask(c, op({ args: { n: 2 } }));
    const full = await c.review.wakeList(c.admin, c.a);
    assert.deepEqual(full.wake.map((w) => w.requestId).sort(), [r.id, other.id].sort());
    assert.deepEqual([full.held, full.more], [[], false]);
    await decide(c, c.owner, r.id, "deny");
    assert.deepEqual((await c.review.wakeList(c.admin, c.a)).wake.map((w) => w.requestId), [other.id]);
    assert.deepEqual((await c.review.wakeList(c.owner, c.a)).wake.map((w) => w.requestId), [other.id]);
  });

  suite("a host never heard from is not judged, and the 50-per-sweep cap reports more", async (c) => {
    const h = await c.host("silent-from-start", false);
    c.hostOf.set("agent:r1", h);
    await c.policy({ reviewers: ["agent:r1"], deadlineMinutes: 30 });
    const r = await ask(c);
    minutes(10);
    assert.deepEqual(await c.sweep(), noop);
    assert.deepEqual([(await route(c, r.id)).assigned, (await route(c, r.id)).reviewerStatus], ["agent:r1", undefined]);
    assert.deepEqual((await c.review.wakeList(c.admin, c.a)).wake, [{ requestId: r.id, reviewer: "agent:r1" }]);
    // 52 reviews, all assigned to a reviewer that is then held: one sweep notes 50 and says there are more.
    for (let i = 0; i < 51; i++) await ask(c, op({ args: { i } }));
    c.availability.set("agent:r1", "paused");
    const first = await c.sweep();
    assert.equal(first.more, true);
    let more = true;
    for (let i = 0; i < 3 && more; i++) more = (await c.sweep()).more;
    assert.equal(more, false);
    assert.equal((await c.review.wakeList(c.admin, c.a)).held.length, 52);
  });

  suite("an operation the owner reserves after routing drops the held status along with the assignment", async (c) => {
    await c.policy({ reviewers: ["agent:r1"], deadlineMinutes: 30 });
    const r = await ask(c);
    c.availability.set("agent:r1", "paused");
    await c.sweep();
    assert.equal((await route(c, r.id)).reviewerStatus, "held");
    await c.policy({ reviewers: ["agent:r1"], deadlineMinutes: 30, mandatoryHuman: ["run-script"] }, 1);
    assert.deepEqual((await c.sweep()).escalated, [r.id]);
    const moved = await route(c, r.id);
    assert.deepEqual([moved.state, moved.assigned, moved.reviewerStatus], ["escalated", undefined, undefined]);
  });

  suite("repeating a sweep by its command ID records the hold once", async (c) => {
    await c.policy({ reviewers: ["agent:r1"] });
    const r = await ask(c);
    c.availability.set("agent:r1", "stopped");
    const command = { commandId: cid("sw-fixed"), projectId: c.a };
    await c.review.sweep(c.admin, command);
    await c.review.sweep(c.admin, command);
    assert.equal(await events(c, r.id, "held"), 1);
    assert.equal((await route(c, r.id)).reviewerStatus, "held");
  });

  suite("hostStaleAfterMs is validated", async (c) => {
    assert.throws(() => ReviewService.withEpoch(c.storage, c.epoch, { hostStaleAfterMs: 10 }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  });
}

// The real lifecycle: a Pause gate on the reviewer's agent, its team or the installation holds the reviewer, and the reviewer reaches its own safe boundary.
for (const backend of backends) {
  test(`${backend.name}: Pause gates (agent, team, installation) hold a reviewer; a task pause of its other work does not; the reviewer reports its boundary and the review waits`, async () => {
    now = Date.parse("2026-10-22T10:00:00.000Z");
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      const agents = AgentService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const a = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: a, title: "the task" })).id;
      const other = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: a, title: "reviewer's own work" })).id;
      await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: other, expectedRevision: 1, to: "ready" });
      const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
      const team = (await agents.createTeam(owner, { commandId: cid("tm"), name: "reviewers" })).id;
      const g1 = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "G1", teamId: team })).id;
      const g2 = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "G2" })).id;
      const grants = (id: string): Grant[] => [{ action: "review.decide", project: a }, { action: "attempt.work", project: a }];
      const asAgent = async (id: string): Promise<Principal> => {
        const f = await world.storage.getAggregate({ kind: "principal", id: `agent:${id}` });
        await principals.setGrants(owner, { commandId: cid("sg"), principalId: `agent:${id}`, expectedRevision: f!.revision, grants: grants(id) });
        return principals.authenticate((await principals.issueCredential(owner, `agent:${id}`)).token);
      };
      const p1 = await asAgent(g1), p2 = await asAgent(g2);
      const enrolled = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
      const ann = await enrolled("ann", [{ action: "review.request", project: a }, { action: "attempt.work", project: a }, { action: "tool.run-script", project: a }]);
      const admin = await enrolled("admin", [{ action: "review.policy.write", project: a }]);
      const manager = await enrolled("mgr", [{ action: "agent.manage", project: "*" }, { action: "agent.read", project: "*" }, { action: "assignment.manage", project: a }]);
      const pauses = PauseService.withEpoch(world.storage, epoch, {}, options);
      const review = ReviewService.withEpoch(world.storage, epoch, { ...options, availability: pauses.availability });
      await review.setPolicy(admin, { commandId: cid("pol"), projectId: a, policy: { reviewers: [`agent:${g1}`, `agent:${g2}`], deadlineMinutes: 30 } });
      const sweep = () => review.sweep(admin, { commandId: cid("sw"), projectId: a });
      const r = await review.request(ann, { commandId: cid("rq"), taskId: task, operation: op(), context });
      const first = (await review.getRoute(owner, r.id))!.assigned!;
      const holder = first === `agent:${g1}` ? p1 : p2;
      const holderId = first.slice("agent:".length);
      await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: other, owner: { kind: "agent", id: holderId } });
      // A pause of another task of the reviewer leaves the reviewer available.
      await pauses.pause(manager, { commandId: cid("pz"), scope: { kind: "task", id: other }, reason: "unrelated" });
      assert.deepEqual(await sweep(), noop);
      assert.equal((await review.getRoute(owner, r.id))!.reviewerStatus, undefined);
      // Pause the reviewer itself; it reaches its own safe boundary and reports paused. The review is neither reassigned nor decided.
      await pauses.pause(manager, { commandId: cid("pz"), scope: { kind: "agent", id: holderId }, reason: "owner asked" });
      await pauses.observe(holder, { commandId: cid("ob"), scope: { kind: "agent", id: holderId }, state: "paused", boundary: "finished", evidence: "between steps" });
      assert.deepEqual(await sweep(), noop);
      let route1 = (await review.getRoute(owner, r.id))!;
      assert.deepEqual([route1.assigned, route1.reviewerStatus, route1.tried, (await review.get(owner, r.id))!.state], [first, "held", [], "pending"]);
      await refuses("invalid_command", async () => { const v = (await review.get(owner, r.id))!; await review.decide(holder, { commandId: cid("dc"), requestId: r.id, expectedRevision: v.revision, verdict: "allow", reason: "ok" }); });
      assert.deepEqual((await review.wakeList(admin, a)).held.map((h) => h.reviewer), [first]);
      // A new review goes to the other reviewer.
      const second = await review.request(ann, { commandId: cid("rq"), taskId: task, operation: op({ args: { n: 2 } }), context });
      assert.notEqual((await review.getRoute(owner, second.id))!.assigned, first);
      // Resume: the same reviewer decides the review it held.
      await pauses.resume(manager, { commandId: cid("rs"), scope: { kind: "agent", id: holderId }, reason: "back" });
      await sweep();
      route1 = (await review.getRoute(owner, r.id))!;
      assert.deepEqual([route1.assigned, route1.reviewerStatus], [first, undefined]);
      const v = (await review.get(owner, r.id))!;
      await review.decide(holder, { commandId: cid("dc"), requestId: r.id, expectedRevision: v.revision, verdict: "allow", reason: "fine" });
      assert.equal((await review.get(owner, r.id))!.state, "approved");
      // The team's gate holds g1, and the installation's gate holds everyone.
      await pauses.pause(manager, { commandId: cid("pz"), scope: { kind: "team", id: team }, reason: "team break" });
      assert.equal(await pauses.availability(`agent:${g1}`), "paused");
      const third = await review.request(ann, { commandId: cid("rq"), taskId: task, operation: op({ args: { n: 3 } }), context });
      assert.equal((await review.getRoute(owner, third.id))!.assigned, `agent:${g2}`);
      await pauses.pause(owner, { commandId: cid("pz"), scope: { kind: "installation", id: "installation" }, reason: "everything" });
      const fourth = await review.request(ann, { commandId: cid("rq"), taskId: task, operation: op({ args: { n: 4 } }), context });
      assert.equal((await review.getRoute(owner, fourth.id))!.state, "waiting");
      assert.deepEqual((await review.wakeList(admin, a)).wake, []);
      minutes(40);
      assert.deepEqual((await sweep()).escalated.includes(fourth.id), true);
      assert.equal((await review.get(owner, fourth.id))!.state, "owner-decision");
    } finally { await world.close(); }
  });
}

function op(extra: Partial<Operation> = {}): Operation { return { name: "run-script", args: { cwd: "/work" }, script: "echo hello\n", target: { kind: "workspace", id: "main" }, ...extra }; }
const context = { toolVersion: "1.2.3", authoritySource: "task grant", expectedEffects: ["builds the project"] };
const noop = { reassigned: [], escalated: [], assigned: [], more: false };

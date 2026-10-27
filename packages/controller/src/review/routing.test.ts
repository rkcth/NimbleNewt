import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { InquiryService } from "../inquiries/index.js";
import { ContractService, WaitGraphService } from "../planning/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ReviewService, type Operation } from "./index.js";
import type { ReviewRouteBody } from "./routing.js";

after(stopServer);

let now = Date.parse("2026-10-21T10:00:00.000Z");
const minutes = (m: number): void => { now += m * 60_000; };
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

const charged: { commandId: string; taskId: string; agentId: string; computeMs: number }[] = [];

for (const backend of backends) {
  interface Ctx {
    review: ReviewService; owner: Principal; a: string; task: string; graph: WaitGraphService; contracts: ContractService;
    ann: Principal; r1: Principal; r2: Principal; r3: Principal; mallory: Principal; admin: Principal; service: Principal;
    agent(name: string, grants: Grant[]): Promise<Principal>;
    newTask(title: string, ownedBy?: string): Promise<string>;
    disable(name: string): Promise<void>;
    policy(policy: object, expectedRevision?: number): Promise<void>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-21T10:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const agent = async (nm: string, grants: Grant[]) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const newTask = async (title: string, ownedBy?: string) => {
          const id = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title })).id;
          if (ownedBy !== undefined) {
            await projects.transitionTask({ commandId: cid("tr"), actor: "owner:rob", taskId: id, expectedRevision: 1, to: "ready" });
            await assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId: id, owner: { kind: "agent", id: ownedBy } });
          }
          return id;
        };
        const task = await newTask("the task");
        const review = ReviewService.withEpoch(world.storage, projects.epoch, { ...options, onUsage: async (u) => { charged.push(u); } });
        const contracts = ContractService.withEpoch(world.storage, projects.epoch, options);
        const blockers = BlockerService.withEpoch(world.storage, projects.epoch, options);
        const graph = WaitGraphService.withEpoch(world.storage, projects.epoch, contracts, blockers, { ...options, extraEdges: (p, t) => review.waitEdges(p, t) });
        const work = (project: string): Grant[] => [{ action: "review.request", project }, { action: "attempt.work", project }, { action: "tool.run-script", project }];
        const ann = await agent("ann", work(a));
        const r1 = await agent("r1", [{ action: "review.decide", project: a }, { action: "attempt.work", project: a }]);
        const r2 = await agent("r2", [{ action: "review.decide", project: a }, { action: "attempt.work", project: a }]);
        const r3 = await agent("r3", [{ action: "review.decide", project: a }, { action: "attempt.work", project: a }]);
        const mallory = await agent("mallory", []);
        const admin = await agent("admin", [{ action: "review.policy.write", project: a }]);
        const disable = async (nm: string) => { const found = await world.storage.getAggregate({ kind: "principal", id: `agent:${nm}` }); await principals.disable(owner, { commandId: cid("dis"), principalId: `agent:${nm}`, expectedRevision: found!.revision }); };
        const service = await principals.authenticate((await principals.provisionService("dispatcher")).token);
        const policy = (p: object, expectedRevision?: number) => review.setPolicy(admin, { commandId: cid("pol"), projectId: a, policy: p, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
        await body({ review, owner, a, task, graph, contracts, ann, r1, r2, r3, mallory, admin, service, agent, newTask, disable, policy });
      } finally { await world.close(); }
    });

  const op = (extra: Partial<Operation> = {}): Operation => ({ name: "run-script", args: { cwd: "/work" }, script: "echo hello\n", target: { kind: "workspace", id: "main" }, ...extra });
  const context = { toolVersion: "1.2.3", authoritySource: "task grant", expectedEffects: ["builds the project"] };
  const ask = (c: Ctx, operation: Operation = op(), taskId = c.task, withContext = true, who: Principal = c.ann) =>
    c.review.request(who, { commandId: cid("rq"), taskId, operation, ...(withContext ? { context } : {}) });
  const decide = async (c: Ctx, who: Principal, id: string, verdict: "allow" | "deny" | "request-context" | "requires-owner-decision", extra: Record<string, unknown> = {}) => {
    const v = (await c.review.get(c.owner, id))!;
    await c.review.decide(who, { commandId: cid("dc"), requestId: id, expectedRevision: v.revision, verdict, reason: `${verdict} because`, ...extra });
  };
  const route = async (c: Ctx, id: string): Promise<ReviewRouteBody> => (await c.review.getRoute(c.owner, id))!;

  suite("the policy is set by those with the right to, validated, versioned, and defaults apply until then", async (c) => {
    assert.deepEqual(await c.review.getPolicy(c.owner, c.a), { policy: { independence: "required", reviewers: [], fallbackReviewers: [], deadlineMinutes: 60, mandatoryHuman: [] }, revision: 0 });
    assert.equal(await c.review.getPolicy(c.mallory, c.a), undefined);
    await refuses("forbidden", () => c.review.setPolicy(c.ann, { commandId: cid("p"), projectId: c.a, policy: {} }));
    await c.policy({ reviewers: ["agent:r1"], fallbackReviewers: ["agent:r3"], deadlineMinutes: 30, mandatoryHuman: ["deploy"] });
    const got = (await c.review.getPolicy(c.r2, c.a))!;
    assert.deepEqual([got.revision, got.policy.reviewers, got.policy.deadlineMinutes, got.policy.independence], [1, ["agent:r1"], 30, "required"]);
    await refuses("stale_revision", () => c.policy({}));
    await refuses("stale_revision", () => c.policy({}, 5));
    await c.policy({ independence: "preferred" }, 1);
    assert.equal((await c.review.getPolicy(c.owner, c.a))!.revision, 2);
    for (const bad of [{ independence: "sometimes" }, { deadlineMinutes: 0 }, { deadlineMinutes: 1.5 }, { deadlineMinutes: 2000 }, { reviewers: ["owner:rob"] }, { reviewers: ["agent:nobody"] }, { reviewers: ["agent:r1"], fallbackReviewers: ["agent:r1"] }, { reviewers: ["agent:r1", "agent:r1"] }, { mandatoryHuman: ["Deploy!"] }, { surprise: 1 }, []]) {
      await refuses("invalid_command", () => c.policy(bad, 2));
    }
    await c.disable("r2");
    await refuses("invalid_command", () => c.policy({ reviewers: ["agent:r2"] }, 2), (e) => assert.match(e.message, /not an active agent/));
  });

  suite("a reviewer is chosen from those who hold the right, never the requester, the least loaded first; designated reviewers come first", async (c) => {
    const first = await ask(c, op({ args: { n: 1 } }));
    assert.equal((await route(c, first.id)).assigned, "agent:r1");
    assert.equal((await route(c, (await ask(c, op({ args: { n: 2 } }))).id)).assigned, "agent:r2");
    assert.equal((await route(c, (await ask(c, op({ args: { n: 3 } }))).id)).assigned, "agent:r3");
    assert.equal((await route(c, (await ask(c, op({ args: { n: 4 } }))).id)).assigned, "agent:r1");
    // The requester holds the review right here too and is still never chosen for their own request.
    const anne = await c.agent("anne", [{ action: "review.request", project: c.a }, { action: "attempt.work", project: c.a }, { action: "review.decide", project: c.a }]);
    const own = await c.review.request(anne, { commandId: cid("rq"), taskId: c.task, operation: op({ args: { n: 5 } }), context });
    assert.notEqual((await c.review.getRoute(c.owner, own.id))!.assigned, "agent:anne");
    assert.equal((await c.review.getRoute(c.owner, own.id))!.assigned, "agent:r2");
    // Finishing a review lowers its reviewer's load.
    await decide(c, c.r1, first.id, "deny");
    // r1 now carries one open review, r2 two, r3 one and anne none, so anne is next.
    assert.equal((await route(c, (await ask(c, op({ args: { n: 6 } }))).id)).assigned, "agent:anne");
    await c.policy({ reviewers: ["agent:r3"] });
    const designated = await route(c, (await ask(c, op({ args: { n: 7 } }))).id);
    assert.deepEqual([designated.assigned, designated.assignedVia], ["agent:r3", "designated"]);
  });

  suite("only the assigned reviewer or the owner may decide; the requester and unassigned reviewers may not", async (c) => {
    const r = await ask(c);
    assert.equal((await route(c, r.id)).assigned, "agent:r1");
    await refuses("forbidden", () => decide(c, c.ann, r.id, "allow"));
    await refuses("forbidden", () => decide(c, c.r2, r.id, "allow"), (e) => assert.match(e.message, /not assigned/));
    await refuses("forbidden", () => decide(c, c.mallory, r.id, "allow"));
    await decide(c, c.r1, r.id, "allow");
    assert.equal((await c.review.get(c.ann, r.id))!.state, "approved");
    const other = await ask(c, op({ args: { other: true } }));
    await decide(c, c.owner, other.id, "deny");
    assert.equal((await c.review.get(c.ann, other.id))!.state, "denied");
  });

  suite("with no eligible reviewer the review waits and is never approved by waiting; a late reviewer takes it at the next sweep", async (c) => {
    await c.policy({ reviewers: ["agent:r1"] });
    await c.disable("r1");
    const r = await ask(c);
    assert.deepEqual([(await route(c, r.id)).state, (await route(c, r.id)).assigned], ["waiting", undefined]);
    await refuses("forbidden", () => decide(c, c.r2, r.id, "allow"));
    await refuses("forbidden", () => c.review.sweep(c.ann, { commandId: cid("sw"), projectId: c.a }));
    assert.deepEqual(await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a }), { reassigned: [], escalated: [], assigned: [], more: false });
    assert.equal((await c.review.get(c.ann, r.id))!.state, "pending");
    await c.policy({ reviewers: ["agent:r2"] }, 1);
    const moved = await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a });
    assert.deepEqual(moved.assigned, [r.id]);
    assert.deepEqual([(await route(c, r.id)).state, (await route(c, r.id)).assigned], ["assigned", "agent:r2"]);
  });

  suite("the controller's own service moves reviews along by rule with no grant, and can neither decide nor set the policy", async (c) => {
    await c.policy({ reviewers: ["agent:r1"], fallbackReviewers: ["agent:r3"], deadlineMinutes: 10 });
    const r = await ask(c);
    minutes(11);
    assert.deepEqual((await c.review.sweep(c.service, { commandId: cid("sw"), projectId: c.a })).reassigned, [r.id]);
    assert.equal((await route(c, r.id)).assigned, "agent:r3");
    assert.equal((await c.review.get(c.ann, r.id))!.state, "pending", "moving a review never approves it");
    await refuses("forbidden", () => decide(c, c.service, r.id, "allow"));
    await refuses("forbidden", () => c.review.setPolicy(c.service, { commandId: cid("pol2"), projectId: c.a, policy: { reviewers: ["agent:r2"] }, expectedRevision: 1 }));
  });

  suite("a reviewer who misses the deadline is replaced by another, then by an authorized fallback, then the review goes to the owner who alone may decide it", async (c) => {
    await c.policy({ reviewers: ["agent:r1"], fallbackReviewers: ["agent:r3"], deadlineMinutes: 10 });
    const r = await ask(c);
    assert.equal((await route(c, r.id)).assigned, "agent:r1");
    minutes(5);
    assert.deepEqual((await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a })).reassigned, []);
    minutes(6);
    assert.deepEqual((await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a })).reassigned, [r.id]);
    const moved = await route(c, r.id);
    assert.deepEqual([moved.assigned, moved.assignedVia, moved.tried], ["agent:r3", "fallback", ["agent:r1"]]);
    await refuses("forbidden", () => decide(c, c.r1, r.id, "allow"));
    minutes(11);
    const last = await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a });
    assert.deepEqual(last.escalated, [r.id]);
    assert.equal((await c.review.get(c.owner, r.id))!.state, "owner-decision");
    await refuses("forbidden", () => decide(c, c.r3, r.id, "allow"));
    await refuses("forbidden", () => decide(c, c.r2, r.id, "allow"));
    minutes(500);
    await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a });
    assert.equal((await c.review.get(c.owner, r.id))!.state, "owner-decision");
    await decide(c, c.owner, r.id, "allow");
    assert.equal((await c.review.get(c.ann, r.id))!.state, "approved");
  });

  suite("a waiting review that nobody takes in time goes to the owner", async (c) => {
    await c.policy({ reviewers: ["agent:r1"], deadlineMinutes: 5 });
    await c.disable("r1");
    const r = await ask(c);
    minutes(6);
    assert.deepEqual((await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a })).escalated, [r.id]);
    assert.equal((await route(c, r.id)).state, "escalated");
  });

  suite("a contributor to the work cannot approve it: the assigned reviewer is replaced, and an approval already given is withdrawn", async (c) => {
    await c.policy({ reviewers: ["agent:r1", "agent:r2"] });
    const r = await ask(c);
    assert.equal((await route(c, r.id)).assigned, "agent:r1");
    await refuses("forbidden", () => c.review.addContributor(c.mallory, { commandId: cid("ct"), requestId: r.id }));
    await refuses("forbidden", () => c.review.addContributor(c.r2, { commandId: cid("ct"), requestId: r.id, contributor: "agent:r1" }));
    await c.review.addContributor(c.r1, { commandId: cid("ct"), requestId: r.id });
    const moved = await route(c, r.id);
    assert.deepEqual([moved.assigned, moved.contributors, moved.tried], ["agent:r2", ["agent:ann", "agent:r1"], ["agent:r1"]]);
    await refuses("forbidden", () => decide(c, c.r1, r.id, "allow"));
    await decide(c, c.r2, r.id, "allow");
    await c.review.addContributor(c.r2, { commandId: cid("ct"), requestId: r.id });
    const view = (await c.review.get(c.ann, r.id))!;
    assert.deepEqual([view.state, view.withdrawnBy], ["withdrawn", "agent:r2"]);
    await refuses("review_invalid", () => c.review.admit(c.ann, { commandId: cid("ad"), requestId: r.id, operation: op() }));
  });

  suite("when the only other reviewer is a contributor the review waits under required independence and goes to them under preferred", async (c) => {
    await c.policy({ reviewers: ["agent:r1"] });
    await c.disable("r2"); await c.disable("r3");
    await c.disable("r1");
    const r = await ask(c);
    assert.equal((await route(c, r.id)).state, "waiting");
    // r1 is gone, so bring a designated reviewer back and mark them a contributor before they are ever assigned.
    const r4 = await c.agent("r4", [{ action: "review.decide", project: c.a }, { action: "attempt.work", project: c.a }]);
    await c.policy({ reviewers: ["agent:r4"] }, 1);
    await c.review.addContributor(c.owner, { commandId: cid("ct"), requestId: r.id, contributor: "agent:r4" });
    await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a });
    assert.equal((await route(c, r.id)).state, "waiting");
    await c.policy({ independence: "preferred", reviewers: ["agent:r4"] }, 2);
    assert.deepEqual((await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a })).assigned, [r.id]);
    assert.equal((await route(c, r.id)).assigned, "agent:r4");
    await refuses("forbidden", () => decide(c, r4, r.id, "allow"), (e) => assert.match(e.message, /may not decide/));
  });

  suite("allow needs the essential context; a reviewer can ask for more, only the requester can supply it, and it goes back to the same reviewer", async (c) => {
    const r = await ask(c, op(), c.task, false);
    await refuses("invalid_command", () => decide(c, c.r1, r.id, "allow"), (e) => assert.match(e.message, /toolVersion, authoritySource, expectedEffects/));
    assert.equal((await c.review.get(c.ann, r.id))!.state, "pending");
    await decide(c, c.r1, r.id, "request-context", { reason: "what tool version and what will it change?" });
    const waiting = (await c.review.get(c.ann, r.id))!;
    assert.deepEqual([waiting.state, waiting.contextRequest], ["needs-context", "what tool version and what will it change?"]);
    await refuses("invalid_command", () => decide(c, c.r1, r.id, "deny"), (e) => assert.match(e.message, /requester has to supply/));
    await refuses("forbidden", () => c.review.supplyContext(c.mallory, { commandId: cid("sc"), requestId: r.id, expectedRevision: waiting.revision, context }));
    await refuses("stale_revision", () => c.review.supplyContext(c.ann, { commandId: cid("sc"), requestId: r.id, expectedRevision: waiting.revision + 3, context }));
    await c.review.supplyContext(c.ann, { commandId: cid("sc"), requestId: r.id, expectedRevision: waiting.revision, context: { ...context, boundedContext: "the build step" } });
    const back = (await c.review.get(c.r1, r.id))!;
    assert.deepEqual([back.state, back.contextRequest, back.context?.boundedContext, (await route(c, r.id)).assigned], ["pending", undefined, "the build step", "agent:r1"]);
    await refuses("invalid_command", () => c.review.supplyContext(c.ann, { commandId: cid("sc"), requestId: r.id, expectedRevision: back.revision, context }));
    await decide(c, c.r1, r.id, "allow");
    assert.equal((await c.review.get(c.ann, r.id))!.state, "approved");
  });

  suite("requires-owner-decision hands the review to the owner; the owner cannot hand it on", async (c) => {
    const r = await ask(c);
    await decide(c, c.r1, r.id, "requires-owner-decision", { reason: "this touches billing" });
    assert.equal((await route(c, r.id)).state, "escalated");
    assert.equal((await c.review.get(c.ann, r.id))!.state, "owner-decision");
    await refuses("forbidden", () => decide(c, c.r1, r.id, "allow"));
    await refuses("invalid_command", () => decide(c, c.owner, r.id, "requires-owner-decision"));
    await decide(c, c.owner, r.id, "deny");
    assert.equal((await c.review.get(c.ann, r.id))!.state, "denied");
  });

  suite("context is bounded, credentials in it are replaced, and the hash of the script under review is always there", async (c) => {
    const r = await ask(c, op(), c.task, false, c.ann);
    void r;
    const withSecret = await c.review.request(c.ann, { commandId: cid("rq"), taskId: c.task, operation: op({ args: { x: 1 } }), context: { ...context, boundedContext: "deploy with Bearer abcdefghijklmnopqrstuvwxyz0123456789 now", workingDirectory: "/work" } });
    const seen = (await c.review.get(c.owner, withSecret.id))!;
    assert.equal(seen.context?.redacted, true);
    assert.ok(!JSON.stringify(seen.context).includes("abcdefghijklmnopqrstuvwxyz"));
    assert.equal(seen.context?.scriptHashes?.length, 1);
    assert.match(seen.context!.scriptHashes![0]!, /^[0-9a-f]{64}$/);
    for (const bad of [{ surprise: 1 }, { scriptHashes: ["nope"] }, { affectedResources: Array.from({ length: 51 }, (_, i) => `r${i}`) }, { toolVersion: "x".repeat(101) }, { boundedContext: "x".repeat(4001) }, "text"]) {
      await refuses("invalid_command", () => c.review.request(c.ann, { commandId: cid("rq"), taskId: c.task, operation: op({ args: { y: 2 } }), context: bad as never }));
    }
  });

  suite("a tool reserved for the owner is never routed to an agent and never cleared by an agent's approval", async (c) => {
    await c.policy({ mandatoryHuman: ["run-script"] });
    const r = await ask(c);
    assert.deepEqual([(await route(c, r.id)).state, (await route(c, r.id)).assigned, (await c.review.get(c.ann, r.id))!.state], ["escalated", undefined, "owner-decision"]);
    await refuses("forbidden", () => decide(c, c.r1, r.id, "allow"));
    await decide(c, c.owner, r.id, "allow");
    // The owner's approval may stand in for a repeat request.
    const again = await ask(c);
    assert.deepEqual([again.cleared, again.id], [true, r.id]);
    // An agent's approval of a tool that is not reserved clears; once the tool is reserved it no longer does.
    const plain = op({ name: "other-tool", args: { p: 1 } });
    const q = await ask(c, plain);
    assert.equal((await route(c, q.id)).assigned, "agent:r1");
    await c.policy({ mandatoryHuman: [] }, 1);
    const q2 = await ask(c, op({ name: "other-tool", args: { p: 2 } }));
    await decide(c, c.r2, q2.id, "allow");
    assert.equal((await ask(c, op({ name: "other-tool", args: { p: 2 } }))).cleared, true);
    await c.policy({ mandatoryHuman: ["other-tool"] }, 2);
    const fresh = await ask(c, op({ name: "other-tool", args: { p: 2 } }));
    assert.deepEqual([fresh.cleared, (await c.review.get(c.ann, fresh.id))!.state], [false, "owner-decision"]);
  });

  suite("reserving a tool for the owner takes effect on reviews already open or approved: an agent's verdict or approval no longer passes it", async (c) => {
    const open = await ask(c, op({ args: { open: 1 } }));
    const approved = await ask(c, op({ args: { approved: 1 } }));
    await decide(c, c.r2, approved.id, "allow");
    await c.policy({ mandatoryHuman: ["run-script"] });
    // The open one: the assigned agent may no longer decide it, and the next sweep hands it to the owner.
    await refuses("forbidden", () => decide(c, c.r1, open.id, "allow"), (e) => assert.match(e.message, /reserved for the owner/));
    assert.deepEqual((await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a })).escalated, [open.id]);
    assert.deepEqual([(await c.review.get(c.ann, open.id))!.state, (await route(c, open.id)).state], ["owner-decision", "escalated"]);
    await decide(c, c.owner, open.id, "allow");
    await c.review.admit(c.ann, { commandId: cid("ad"), requestId: open.id, operation: op({ args: { open: 1 } }) });
    // The agent-approved one no longer admits; the same call is refused with the reason.
    await refuses("review_invalid", () => c.review.admit(c.ann, { commandId: cid("ad"), requestId: approved.id, operation: op({ args: { approved: 1 } }) }), (e) => assert.match(e.message, /now reserved for the owner/));
    // Lifting the reservation lets the approval stand again.
    await c.policy({ mandatoryHuman: [] }, 1);
    await c.review.admit(c.ann, { commandId: cid("ad"), requestId: approved.id, operation: op({ args: { approved: 1 } }) });
  });

  suite("a repeat request that an unexpired, unused approval already covers is cleared and recorded; any difference asks again", async (c) => {
    const first = await ask(c);
    await decide(c, c.r1, first.id, "allow");
    const again = await ask(c);
    assert.deepEqual([again.cleared, again.id], [true, first.id]);
    assert.ok((await route(c, first.id)).events.some((e) => e.event === "cleared" && /agent:r1/.test(e.detail)));
    const different = await ask(c, op({ args: { cwd: "/elsewhere" } }));
    assert.equal(different.cleared, false);
    assert.notEqual(different.id, first.id);
    await c.review.admit(c.ann, { commandId: cid("ad"), requestId: first.id, operation: op() });
    const afterUse = await ask(c);
    assert.deepEqual([afterUse.cleared, afterUse.id === first.id], [false, false]);
    await decide(c, c.r2, afterUse.id, "allow", { expiresAt: new Date(now + 10 * 60_000).toISOString() });
    minutes(11);
    assert.equal((await ask(c)).cleared, false);
    // Replaying the same command answers the same way.
    const commandId = cid("same");
    const one = await c.review.request(c.ann, { commandId, taskId: c.task, operation: op({ args: { z: 1 } }), context });
    assert.deepEqual(await c.review.request(c.ann, { commandId, taskId: c.task, operation: op({ args: { z: 1 } }), context }), { id: one.id, replayed: true, cleared: false });
  });

  suite("an agent reviewer's allow or deny is reported with the time from its assignment to its decision, once per review; an escalation, a request for context and the owner's own decision are not (card R05f)", async (c) => {
    charged.length = 0;
    await c.policy({ reviewers: ["agent:r1"] });
    const first = await ask(c);
    minutes(4);
    await decide(c, c.r1, first.id, "allow", {});
    assert.deepEqual(charged, [{ commandId: `review-use:${first.id}`, taskId: c.task, agentId: "agent:r1", computeMs: 240_000 }]);
    const second = await ask(c, op({ args: { n: 2 } }));
    minutes(1);
    await decide(c, c.r1, second.id, "request-context", {});
    await decide(c, c.r1, (await ask(c, op({ args: { n: 3 } }))).id, "requires-owner-decision", {});
    assert.equal(charged.length, 1, "only a final verdict by an agent is charged");
    const third = (await ask(c, op({ args: { n: 4 } }))).id;
    await decide(c, c.owner, third, "deny", {});
    assert.equal(charged.length, 1, "the owner's time is not charged");
  });

  suite("the figures kept about reviewing: queue delay, latency, cost, escalations, false blocks and missed hazards", async (c) => {
    await c.policy({ reviewers: ["agent:r1"] });
    await c.disable("r1");
    const queued = await ask(c);
    minutes(10);
    await c.policy({ reviewers: ["agent:r2"] }, 1);
    await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a });
    minutes(2);
    await decide(c, c.r2, queued.id, "allow", { cost: 3 });
    const quick = await ask(c, op({ args: { q: 1 } }));
    minutes(5);
    await decide(c, c.r2, quick.id, "deny", { cost: 1 });
    const open = await ask(c, op({ args: { o: 1 } }));
    void open;
    const a = await route(c, queued.id);
    assert.deepEqual([a.queueMs, a.latencyMs, a.cost, a.verdict], [600_000, 120_000, 3, "allow"]);
    await c.review.recordOutcome(c.admin, { commandId: cid("oc"), requestId: queued.id, missedHazard: true });
    await c.review.recordOutcome(c.admin, { commandId: cid("oc"), requestId: quick.id, falseBlock: true });
    await refuses("invalid_command", () => c.review.recordOutcome(c.admin, { commandId: cid("oc"), requestId: queued.id, falseBlock: true }));
    await refuses("invalid_command", () => c.review.recordOutcome(c.admin, { commandId: cid("oc"), requestId: quick.id, missedHazard: true }));
    await refuses("invalid_command", () => c.review.recordOutcome(c.admin, { commandId: cid("oc"), requestId: quick.id }));
    await refuses("forbidden", () => c.review.recordOutcome(c.ann, { commandId: cid("oc"), requestId: quick.id, falseBlock: true }));
    await refuses("forbidden", () => c.review.metrics(c.ann, c.a));
    const m = await c.review.metrics(c.admin, c.a);
    assert.deepEqual(m, { reviews: 3, decided: 2, open: 1, escalated: 0, allowed: 1, denied: 1, falseBlocks: 1, missedHazards: 1, averageQueueMs: 300_000, averageLatencyMs: 210_000, totalCost: 4 });
  });

  suite("a task waiting for a review waits on the reviewer's unfinished tasks, and a ring through a review is found", async (c) => {
    const mine = await c.newTask("ann's task", "agent:ann");
    const theirs = await c.newTask("r1's task", "agent:r1");
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: theirs, prerequisiteId: mine });
    assert.deepEqual(await c.graph.cycles(c.a), []);
    const r = await c.review.request(c.ann, { commandId: cid("rq"), taskId: mine, operation: op(), context });
    assert.equal((await route(c, r.id)).assigned, "agent:r1");
    const edges = await c.graph.edges(c.a);
    assert.ok(edges.some((e) => e.via === "review" && e.fromTask === mine && e.toTask === theirs));
    const rings = await c.graph.cycles(c.a);
    assert.equal(rings.length, 1);
    assert.deepEqual(rings[0]!.tasks, [mine, theirs].sort());
    assert.ok(rings[0]!.edges.some((e) => e.via === "review") && rings[0]!.edges.some((e) => e.via === "dependency"));
    const found = await c.graph.detect(c.owner, { commandId: cid("dt"), projectId: c.a });
    assert.equal(found.cycles.length, 1);
    // Once the verdict is in, the review no longer holds the task.
    await decide(c, c.r1, r.id, "allow");
    assert.deepEqual(await c.graph.cycles(c.a), []);
    // A review waiting for context, or sent to the owner, adds no edge either.
    const q = await c.review.request(c.ann, { commandId: cid("rq"), taskId: mine, operation: op({ args: { again: 1 } }), context });
    await decide(c, c.r1, q.id, "requires-owner-decision");
    assert.deepEqual(await c.graph.cycles(c.a), []);
  });

  suite("two verdicts at the same moment: exactly one wins and the route agrees with the review", async (c) => {
    for (let round = 0; round < 6; round++) {
      const r = await ask(c, op({ args: { round } }));
      const v = (await c.review.get(c.owner, r.id))!;
      const attempts = await Promise.allSettled([
        c.review.decide(c.r1, { commandId: cid("dc"), requestId: r.id, expectedRevision: v.revision, verdict: "allow", reason: "fine" }),
        c.review.decide(c.owner, { commandId: cid("dc"), requestId: r.id, expectedRevision: v.revision, verdict: "deny", reason: "no" }),
        c.review.withdraw(c.ann, { commandId: cid("wd"), requestId: r.id, expectedRevision: v.revision, reason: "changed my mind" }),
      ]);
      assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1, JSON.stringify(attempts.map((a) => a.status === "rejected" ? String(a.reason) : "ok")));
      const state = (await c.review.get(c.owner, r.id))!.state;
      const rt = await route(c, r.id);
      assert.ok(["approved", "denied", "withdrawn"].includes(state), state);
      assert.equal(rt.verdict, state === "approved" ? "allow" : state === "denied" ? "deny" : undefined);
      assert.equal(rt.withdrawn === true, state === "withdrawn");
    }
  });

  suite("a sweep and a verdict at the same moment never leave a decided review escalated", async (c) => {
    await c.policy({ reviewers: ["agent:r1"], deadlineMinutes: 5 });
    for (let round = 0; round < 4; round++) {
      const r = await ask(c, op({ args: { round } }));
      minutes(6);
      const v = (await c.review.get(c.owner, r.id))!;
      await Promise.allSettled([
        c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a }),
        c.review.decide(c.r1, { commandId: cid("dc"), requestId: r.id, expectedRevision: v.revision, verdict: "allow", reason: "fine" }),
      ]);
      const state = (await c.review.get(c.owner, r.id))!.state;
      const rt = await route(c, r.id);
      if (state === "approved") assert.equal(rt.verdict, "allow");
      else { assert.equal(state, "owner-decision"); assert.equal(rt.state, "escalated"); assert.equal(rt.verdict, undefined); }
    }
  });

  suite("withdrawing closes the route and the review leaves the queue", async (c) => {
    const r = await ask(c);
    const v = (await c.review.get(c.ann, r.id))!;
    await c.review.withdraw(c.ann, { commandId: cid("wd"), requestId: r.id, expectedRevision: v.revision, reason: "not needed" });
    assert.equal((await route(c, r.id)).withdrawn, true);
    assert.equal((await c.review.metrics(c.admin, c.a)).open, 0);
    const next = await ask(c, op({ args: { n: 9 } }));
    assert.equal((await route(c, next.id)).assigned, "agent:r1");
  });
}

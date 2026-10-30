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

for (const backend of backends) {
  interface Ctx {
    review: ReviewService; owner: Principal; a: string; task: string; graph: WaitGraphService; contracts: ContractService;
    ann: Principal; r1: Principal; r2: Principal; r3: Principal; mallory: Principal; admin: Principal;
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
        const review = ReviewService.withEpoch(world.storage, projects.epoch, options);
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
        const policy = (p: object, expectedRevision?: number) => review.setPolicy(admin, { commandId: cid("pol"), projectId: a, policy: p, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
        await body({ review, owner, a, task, graph, contracts, ann, r1, r2, r3, mallory, admin, agent, newTask, disable, policy });
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

  // Card H12h: a review in owner mode (reserved by the policy, escalated by a reviewer, or escalated by the deadline) is only ever the owner's.
  const onlyOwner = async (c: Ctx, id: string, agents: Principal[]): Promise<void> => {
    for (const who of agents) {
      const v = (await c.review.get(c.owner, id))!;
      for (const verdict of ["allow", "deny", "request-context", "requires-owner-decision"] as const) {
        await refuses("forbidden", () => c.review.decide(who, { commandId: cid("dc"), requestId: id, expectedRevision: v.revision, verdict, reason: "trying" }), (e) => assert.match(e.message, /may not decide that review/));
      }
      assert.equal(await c.review.get(who, id), undefined, `${who.id} is not shown the review`);
      assert.equal(await c.review.getRoute(who, id), undefined, `${who.id} is not shown its route`);
    }
    assert.deepEqual((await c.review.wakeList(c.admin, c.a)).wake, [], "no agent is woken for it");
    assert.deepEqual((await c.review.waitEdges(c.a, new Map([["task-x", { state: "ready", owner: "agent:r1" }]]))), [], "and nobody waits on an agent for it");
  };

  suite("a tool reserved for the owner goes only to the owner: no agent decides, reads or is woken for it, and a sweep does not hand it out", async (c) => {
    await c.policy({ mandatoryHuman: ["run-script"], reviewers: ["agent:r1"], fallbackReviewers: ["agent:r2"] });
    const r = await ask(c);
    const rt = await route(c, r.id);
    assert.deepEqual([rt.state, rt.assigned, rt.mandatoryHuman], ["escalated", undefined, true]);
    await onlyOwner(c, r.id, [c.r1, c.r2, c.r3]);
    assert.deepEqual(await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a }), { reassigned: [], escalated: [], assigned: [], more: false });
    minutes(120);
    await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a });
    assert.equal((await route(c, r.id)).assigned, undefined);
    await onlyOwner(c, r.id, [c.r1, c.r2, c.r3]);
    assert.ok(await c.review.get(c.ann, r.id), "the requester sees it");
    await decide(c, c.owner, r.id, "allow");
    assert.equal((await c.review.admit(c.ann, { commandId: cid("ad"), requestId: r.id, operation: op() })).admitted, true);
  });

  suite("a reviewer who sends a review to the owner cannot decide it again, and the owner's request for context does not send it back to the reviewer", async (c) => {
    await c.policy({ reviewers: ["agent:r1"], fallbackReviewers: ["agent:r2"] });
    const r = await ask(c);
    assert.equal((await route(c, r.id)).assigned, "agent:r1");
    await decide(c, c.r1, r.id, "requires-owner-decision");
    assert.equal((await c.review.get(c.owner, r.id))!.state, "owner-decision");
    // The owner can list what waits for them (card U11b); nobody else can.
    assert.deepEqual((await c.review.ownerPending(c.owner)).map((x) => x.id), [r.id]);
    await assert.rejects(c.review.ownerPending(c.r1), /only the owner/);
    await onlyOwner(c, r.id, [c.r1, c.r2]);
    await decide(c, c.owner, r.id, "request-context");
    assert.deepEqual(await c.review.ownerPending(c.owner), [], "once it asks for context it no longer waits for a decision");
    assert.equal((await c.review.get(c.owner, r.id))!.state, "needs-context");
    await onlyOwner(c, r.id, [c.r1, c.r2]);
    // the reviewer still named on the route becomes a contributor: the review is not handed to another agent either
    await c.review.addContributor(c.r1, { commandId: cid("ct"), requestId: r.id });
    const before = (await c.review.get(c.owner, r.id))!;
    await c.review.supplyContext(c.ann, { commandId: cid("sc"), requestId: r.id, expectedRevision: before.revision, context: { boundedContext: "more detail" } });
    const after = (await c.review.get(c.owner, r.id))!;
    assert.equal(after.state, "owner-decision", "back to the owner, not to a pending review an agent can decide");
    const rt = await route(c, r.id);
    assert.equal(rt.state, "escalated");
    assert.ok(!rt.events.some((e) => e.event === "reassigned" || e.event === "waiting"));
    await onlyOwner(c, r.id, [c.r1, c.r2, c.r3]);
    await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a });
    minutes(300);
    await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a });
    await onlyOwner(c, r.id, [c.r1, c.r2, c.r3]);
    await decide(c, c.owner, r.id, "deny");
    assert.equal((await c.review.get(c.owner, r.id))!.decidedBy, "owner:rob");
  });

  suite("a review that no agent decided in time goes to the owner alone; so does one whose tool is reserved after the request", async (c) => {
    await c.policy({ reviewers: ["agent:r1"] });
    const late = await ask(c);
    minutes(61);
    await c.review.sweep(c.admin, { commandId: cid("sw"), projectId: c.a });
    assert.equal((await route(c, late.id)).state, "escalated");
    await onlyOwner(c, late.id, [c.r1, c.r2, c.r3]);
    const reserved = await ask(c, op({ args: { cwd: "/other" } }));
    const asking = await ask(c, op({ args: { cwd: "/third" } }));
    assert.equal((await route(c, reserved.id)).assigned, "agent:r1");
    await decide(c, c.r1, asking.id, "request-context");
    await c.policy({ reviewers: ["agent:r1"], mandatoryHuman: ["run-script"] }, 1);
    // before any sweep: the gate is read now, so the agent already assigned neither decides nor reads it
    await onlyOwner(c, reserved.id, [c.r1, c.r2, c.r3]);
    // the answer to a request for context goes to the owner, not back to the agent, once the tool is reserved
    const v = (await c.review.get(c.owner, asking.id))!;
    await c.review.supplyContext(c.ann, { commandId: cid("sc"), requestId: asking.id, expectedRevision: v.revision, context: { boundedContext: "more" } });
    assert.equal((await c.review.get(c.owner, asking.id))!.state, "owner-decision");
    await decide(c, c.owner, late.id, "allow");
    await decide(c, c.owner, reserved.id, "allow");
    await decide(c, c.owner, asking.id, "deny");
  });

  suite("a request marked owner-only is created in owner mode whatever the policy says, and is idempotent by command", async (c) => {
    await c.policy({ reviewers: ["agent:r1"] });
    const r = await c.review.request(c.ann, { commandId: "own-1", taskId: c.task, operation: op(), context, ownerOnly: true });
    const again = await c.review.request(c.ann, { commandId: "own-1", taskId: c.task, operation: op(), context, ownerOnly: true });
    assert.deepEqual([again.id, again.replayed], [r.id, true]);
    const rt = await route(c, r.id);
    assert.deepEqual([rt.state, rt.assigned, rt.mandatoryHuman], ["escalated", undefined, true]);
    assert.equal((await c.review.get(c.owner, r.id))!.state, "owner-decision");
    await onlyOwner(c, r.id, [c.r1, c.r2, c.r3]);
    await refuses("invalid_command", () => c.review.request(c.ann, { commandId: "own-2", taskId: c.task, operation: op(), context, ownerOnly: "yes" as never }));
    // an agent approval never clears a later owner-only request; the owner's does
    const plain = await ask(c, op({ args: { cwd: "/p" } }));
    await decide(c, c.r1, plain.id, "allow");
    const strict = await c.review.request(c.ann, { commandId: "own-3", taskId: c.task, operation: op({ args: { cwd: "/p" } }), context, ownerOnly: true });
    assert.equal(strict.cleared, false);
    assert.notEqual(strict.id, plain.id);
    await decide(c, c.owner, strict.id, "allow");
    const cleared = await c.review.request(c.ann, { commandId: "own-4", taskId: c.task, operation: op({ args: { cwd: "/p" } }), context, ownerOnly: true });
    assert.equal(cleared.cleared, true);
  });

  suite("an ordinary review is still routed to, read and decided by its agent reviewer", async (c) => {
    await c.policy({ reviewers: ["agent:r1"], mandatoryHuman: ["deploy"] });
    const r = await ask(c);
    assert.ok(await c.review.get(c.r1, r.id));
    assert.ok(await c.review.get(c.r2, r.id), "another reviewer with the right may read a review in agent mode");
    assert.deepEqual((await c.review.wakeList(c.admin, c.a)).wake, [{ requestId: r.id, reviewer: "agent:r1" }]);
    await decide(c, c.r1, r.id, "allow");
    assert.equal((await c.review.get(c.ann, r.id))!.decidedBy, "agent:r1");
  });
}

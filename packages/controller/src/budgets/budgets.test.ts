import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { BUDGET_ENFORCEMENT, BudgetService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T21:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const budgetRefusal = (e: DomainError): void => { assert.match(e.message, /^costMicros: budget:|^budget:/, e.message); };

for (const backend of backends) {
  interface Ctx {
    svc: BudgetService; open(): BudgetService; owner: Principal; host: Principal; ann: Principal; ben: Principal; cat: Principal; reader: Principal; a: string; b: string;
    root: string; kid1: string; kid2: string; grandkid: string; foreign: string;
    reserve(task: string, cost: number, compute?: number, by?: Principal): Promise<{ id: string }>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [] });
        const host = await principals.authenticate((await principals.issueCredential(owner, "host:h1")).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const mk = async (p: string) => (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: p, title: "t" })).id;
        const [root, kid1, kid2, grandkid] = [await mk(a), await mk(a), await mk(a), await mk(a)];
        const foreign = await mk(b);
        const agent = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const ann = await agent("ann", [{ action: "attempt.work", project: a }, { action: "budget.manage", project: a }]);
        const ben = await agent("ben", [{ action: "attempt.work", project: a }]);
        const cat = await agent("cat", [{ action: "budget.manage", project: a }]);
        const reader = await agent("reader", [{ action: "budget.read", project: a }]);
        const svc = BudgetService.withEpoch(world.storage, projects.epoch, options);
        const reserve = (task: string, cost: number, compute = 0, by: Principal = host) => svc.reserve(by, { commandId: cid("r"), taskId: task, costMicros: cost, computeMs: compute, agentId: "agent:ben", purpose: "a call" });
        await body({ svc, open: () => BudgetService.withEpoch(world.storage, projects.epoch, options), owner, host, ann, ben, cat, reader, a, b, root, kid1, kid2, grandkid, foreign, reserve });
      } finally { await world.close(); }
    });
  const open = (c: Ctx, cost = 100, compute = 1000, holder = "agent:ann") => c.svc.open(c.owner, { commandId: cid("o"), taskId: c.root, currency: "USD", costMicros: cost, computeMs: compute, holder });
  const give = (c: Ctx, child: string, cost: number, compute = 0, by: Principal = c.owner, parent = c.root, holder?: string) => c.svc.delegate(by, { commandId: cid("d"), parentTaskId: parent, childTaskId: child, costMicros: cost, computeMs: compute, ...(holder === undefined ? {} : { holder }) });
  const rep = async (c: Ctx, task: string) => (await c.svc.report(c.owner, task))!;

  suite("spend is reserved before dispatch and reconciled to actual use: lower returns the difference, higher is overrun and blocks", async (c) => {
    await open(c);
    const r1 = await c.reserve(c.root, 60);
    assert.deepEqual((await rep(c, c.root)).available, { costMicros: 40, computeMs: 1000 });
    await refuses("invalid_command", () => c.reserve(c.root, 41), budgetRefusal);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: r1.id, costMicros: 25 });
    let r = await rep(c, c.root);
    assert.deepEqual([r.spent.costMicros, r.reservedInFlight.costMicros, r.available.costMicros, r.overrun.costMicros], [25, 0, 75, 0]);
    // A call that cost more than it reserved: the excess is recorded as overrun, and the task cannot reserve until it is covered again.
    const r2 = await c.reserve(c.root, 70);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: r2.id, costMicros: 90 });
    r = await rep(c, c.root);
    assert.deepEqual([r.spent.costMicros, r.overrun.costMicros, r.available.costMicros], [115, 15, 0]);
    await refuses("invalid_command", () => c.reserve(c.root, 1), budgetRefusal);
    // A task with no budget at all cannot reserve.
    await refuses("not_found", () => c.reserve(c.kid1, 1));
  });

  suite("a reservation that never happened is released; settle and release are idempotent and a settled one cannot be settled again", async (c) => {
    await open(c);
    const r1 = await c.reserve(c.root, 80);
    const cmd = cid("rel");
    await c.svc.release(c.host, { commandId: cmd, reservationId: r1.id });
    await c.svc.release(c.host, { commandId: cmd, reservationId: r1.id });
    assert.equal((await rep(c, c.root)).available.costMicros, 100);
    await refuses("invalid_transition", () => c.svc.release(c.host, { commandId: cid("rel"), reservationId: r1.id }));
    const r2 = await c.reserve(c.root, 50);
    const sc = cid("s");
    await c.svc.settle(c.host, { commandId: sc, reservationId: r2.id, costMicros: 10 });
    assert.equal((await c.svc.settle(c.host, { commandId: sc, reservationId: r2.id, costMicros: 10 }), (await rep(c, c.root)).spent.costMicros), 10, "a repeat charges once");
    await refuses("invalid_transition", () => c.svc.settle(c.host, { commandId: cid("s"), reservationId: r2.id, costMicros: 10 }));
    await refuses("command_conflict", () => c.svc.settle(c.host, { commandId: sc, reservationId: r2.id, costMicros: 11 }));
    await refuses("not_found", () => c.svc.settle(c.host, { commandId: cid("s"), reservationId: "bgr-aaaaaaaaaaaaaaaaaaaa", costMicros: 1 }));
    // The same reserve command repeated is the same reservation, taken once.
    const rc = cid("r");
    const x = await c.svc.reserve(c.host, { commandId: rc, taskId: c.root, costMicros: 30, purpose: "p" });
    const y = await c.svc.reserve(c.host, { commandId: rc, taskId: c.root, costMicros: 30, purpose: "p" });
    assert.deepEqual([x.id === y.id, y.replayed, (await rep(c, c.root)).reservedInFlight.costMicros], [true, true, 30]);
  });

  suite("concurrent reservations and delegations cannot spend the same allocation", async (c) => {
    await open(c, 100, 0);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => c.reserve(c.root, 15)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 6, "100 covers six reservations of 15 and no more");
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && r.reason.code === "invalid_command", String(r.reason));
    const r = await rep(c, c.root);
    assert.deepEqual([r.reservedInFlight.costMicros, r.available.costMicros], [90, 10]);
    // Two children asking for the same allocation at once: one gets it.
    const c2 = await rep(c, c.root);
    for (const x of r.reservations) await c.svc.release(c.host, { commandId: cid("rel"), reservationId: x.id });
    assert.equal(c2.limit.costMicros, 100);
    const both = await Promise.allSettled([give(c, c.kid1, 60), give(c, c.kid2, 60)]);
    assert.deepEqual(both.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
    assert.equal((await rep(c, c.root)).available.costMicros, 40);
    // And a delegation racing a reservation on the same node: together they never exceed the node.
    const mixed = await Promise.allSettled([give(c, c.kid2, 30), c.reserve(c.root, 30)]);
    assert.ok(mixed.filter((x) => x.status === "fulfilled").length >= 1);
    const after = await rep(c, c.root);
    assert.ok(after.delegatedToChildren.costMicros + after.reservedInFlight.costMicros + after.spent.costMicros <= after.limit.costMicros);
  });

  suite("delegation moves allowance down and never multiplies it", async (c) => {
    await open(c);
    await give(c, c.kid1, 60, 400, c.owner, c.root, "agent:ann");
    let r = await rep(c, c.root);
    assert.deepEqual([r.available.costMicros, r.available.computeMs, r.delegatedToChildren.costMicros, r.children], [40, 600, 60, [c.kid1]]);
    await refuses("invalid_command", () => c.reserve(c.root, 50), budgetRefusal);
    await refuses("invalid_command", () => give(c, c.kid2, 50), budgetRefusal);
    // The child spends only from its own allowance; the holder hands part of it on.
    await give(c, c.grandkid, 25, 100, c.ann, c.kid1);
    assert.equal((await rep(c, c.kid1)).available.costMicros, 35);
    await refuses("invalid_command", () => c.reserve(c.kid1, 36), budgetRefusal);
    await c.reserve(c.grandkid, 25);
    await refuses("invalid_command", () => c.reserve(c.grandkid, 1), budgetRefusal);
    r = await rep(c, c.root);
    assert.deepEqual([r.subtree.nodes, r.subtree.reserved.costMicros], [3, 25], "the root sees what is held below it");
    // Reclaiming a finished child's unused allowance gives it back to the parent.
    const back = await c.svc.reclaim(c.ann, { commandId: cid("rc"), taskId: c.grandkid });
    assert.deepEqual(back, { costMicros: 0, computeMs: 100 });
    await refuses("forbidden", () => c.svc.reclaim(c.ben, { commandId: cid("rc"), taskId: c.kid1 }));
    const kid = await rep(c, c.kid1);
    assert.equal(kid.limit.costMicros, 60);
    // Tasks of another project, a task already in a budget, or a parent the caller does not hold are refused.
    await refuses("invalid_command", () => give(c, c.foreign, 1));
    await refuses("invalid_command", () => give(c, c.kid1, 1));
    await refuses("forbidden", () => give(c, c.kid2, 1, 0, c.ben));
    await refuses("forbidden", () => give(c, c.grandkid, 1, 0, c.ann, c.kid2), undefined);
    await refuses("forbidden", () => give(c, c.kid2, 1, 0, c.ben, c.kid1), undefined);
    // Holding budget.manage is not enough: only the node's own holder may hand its allowance on or take it back.
    await refuses("forbidden", () => give(c, c.kid2, 1, 0, c.cat, c.kid1), undefined);
    await refuses("forbidden", () => c.svc.reclaim(c.cat, { commandId: cid("rc"), taskId: c.grandkid }));
  });

  suite("an agreed raise is carried out by the controller's own identity for exactly the task and amounts it names, with who allowed it recorded; nobody else may use that path (card M02e)", async (c) => {
    await open(c);
    const controller = { id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as unknown as Principal;
    const before = (await rep(c, c.root)).available.costMicros;
    await c.svc.raiseAgreed(controller, { commandId: cid("ag"), taskId: c.root, costMicros: 7, decisionId: "mtg:dec-1:chg-1", agreedBy: "owner:agreed" });
    assert.equal((await rep(c, c.root)).available.costMicros, before + 7, "exactly what was named");
    await c.svc.raiseAgreed(controller, { commandId: "same-id", taskId: c.root, costMicros: 3, decisionId: "mtg:dec-1:chg-2", agreedBy: "policy:spend" });
    await c.svc.raiseAgreed(controller, { commandId: "same-id", taskId: c.root, costMicros: 3, decisionId: "mtg:dec-1:chg-2", agreedBy: "policy:spend" });
    assert.equal((await rep(c, c.root)).available.costMicros, before + 10, "a repeat after a crash adds once");
    for (const who of [c.ann, c.host, c.reader]) await refuses("forbidden", () => c.svc.raiseAgreed(who, { commandId: cid("ag"), taskId: c.root, costMicros: 1, decisionId: "d", agreedBy: "owner:agreed" }));
    await refuses("invalid_command", () => c.svc.raiseAgreed(controller, { commandId: cid("ag"), taskId: c.root, costMicros: 1, decisionId: "d", agreedBy: "the agent said so" }));
    await refuses("invalid_command", () => c.svc.raiseAgreed(controller, { commandId: cid("ag"), taskId: c.root, costMicros: 1, decisionId: "d", agreedBy: "owner:agreed", extra: 1 } as never));
    assert.equal((await rep(c, c.root)).available.costMicros, before + 10, "nothing refused changed the budget");
  });

  suite("uncertain and in-flight amounts are held and shown until reconciled", async (c) => {
    await open(c, 100, 500);
    const r1 = await c.reserve(c.root, 40, 100);
    const r2 = await c.reserve(c.root, 30, 50);
    await c.svc.markUncertain(c.host, { commandId: cid("u"), reservationId: r2.id, reason: "the host lost contact mid-call" });
    await refuses("invalid_transition", () => c.svc.markUncertain(c.host, { commandId: cid("u"), reservationId: r2.id, reason: "again" }));
    await refuses("invalid_transition", () => c.svc.release(c.host, { commandId: cid("rel"), reservationId: r2.id }));
    let r = await rep(c, c.root);
    assert.deepEqual([r.reservedInFlight, r.uncertain, r.outstanding, r.available], [{ costMicros: 40, computeMs: 100 }, { costMicros: 30, computeMs: 50 }, { costMicros: 70, computeMs: 150 }, { costMicros: 30, computeMs: 350 }]);
    assert.deepEqual(r.reservations.map((x) => [x.id === r1.id ? "open" : "other", x.state]).sort(), [["open", "open"], ["other", "uncertain"]]);
    assert.match(r.reservations.find((x) => x.state === "uncertain")!.uncertainReason!, /lost contact/);
    await refuses("invalid_command", () => c.reserve(c.root, 31), budgetRefusal);
    // Reconciled: the provider says it charged 12.
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: r2.id, costMicros: 12, computeMs: 20 });
    r = await rep(c, c.root);
    assert.deepEqual([r.uncertain.costMicros, r.spent.costMicros, r.available.costMicros], [0, 12, 48]);
  });

  suite("a child's uncertain hold shows in the subtree totals of every ancestor", async (c) => {
    await open(c);
    await give(c, c.kid1, 50, 0, c.owner, c.root, "agent:ann");
    await give(c, c.grandkid, 20, 0, c.ann, c.kid1);
    const held = await c.reserve(c.grandkid, 15);
    await c.reserve(c.kid1, 5);
    await c.svc.markUncertain(c.host, { commandId: cid("u"), reservationId: held.id, reason: "lost" });
    for (const [task, nodes] of [[c.root, 3], [c.kid1, 2], [c.grandkid, 1]] as const) {
      const r = await rep(c, task);
      assert.deepEqual([r.subtree.nodes, r.subtree.uncertain.costMicros, r.subtree.reserved.costMicros], [nodes, 15, task === c.grandkid ? 0 : 5], task);
    }
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: held.id, costMicros: 9 });
    const r = await rep(c, c.root);
    assert.deepEqual([r.subtree.uncertain.costMicros, r.subtree.spent.costMicros], [0, 9]);
  });

  suite("overrun is counted once however many other holds are open, for settlements and charges", async (c) => {
    await open(c, 100, 0);
    const a = await c.reserve(c.root, 60);
    const b = await c.reserve(c.root, 40);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: a.id, costMicros: 70 });
    assert.equal((await rep(c, c.root)).overrun.costMicros, 0, "while the other hold is open the node has spent 70 of 100: no overrun yet");
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: b.id, costMicros: 40 });
    let r = await rep(c, c.root);
    assert.deepEqual([r.overrun.costMicros, r.spent.costMicros], [10, 110], "settling the other hold at exactly its estimate adds nothing");
    // The charge variant, on a second tree.
    await c.svc.open(c.owner, { commandId: cid("o"), taskId: c.kid1, currency: "USD", costMicros: 100 });
    const cc = await c.reserve(c.kid1, 100);
    await c.svc.charge(c.host, { commandId: cid("c"), activity: "background-job", taskId: c.kid1, costMicros: 10 });
    assert.equal((await rep(c, c.kid1)).overrun.costMicros, 0);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: cc.id, costMicros: 100 });
    r = await rep(c, c.kid1);
    assert.deepEqual([r.overrun.costMicros, r.spent.costMicros], [10, 110]);
    // A third dimension check: compute overruns the same way and independently of money.
    await c.svc.open(c.owner, { commandId: cid("o"), taskId: c.kid2, currency: "USD", costMicros: 100, computeMs: 50 });
    const x = await c.reserve(c.kid2, 10, 30);
    const y = await c.reserve(c.kid2, 10, 20);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: x.id, costMicros: 10, computeMs: 45 });
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: y.id, costMicros: 10, computeMs: 20 });
    r = await rep(c, c.kid2);
    assert.deepEqual([r.overrun.costMicros, r.overrun.computeMs], [0, 15]);
  });

  suite("a child's overrun is passed up so the parent's available figure shows what was really consumed", async (c) => {
    await open(c);
    await give(c, c.kid1, 40, 0, c.owner, c.root, "agent:ann");
    const r1 = await c.reserve(c.kid1, 40);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: r1.id, costMicros: 55 });
    assert.deepEqual([(await rep(c, c.kid1)).overrun.costMicros, (await rep(c, c.root)).delegatedToChildren.costMicros, (await rep(c, c.root)).available.costMicros, (await rep(c, c.root)).overrun.costMicros], [15, 55, 45, 0]);
    // Past the parent's own free allowance the excess becomes the parent's overrun too.
    await c.reserve(c.root, 45);
    await c.svc.charge(c.host, { commandId: cid("c"), activity: "supervision", taskId: c.kid1, costMicros: 20 });
    assert.deepEqual([(await rep(c, c.kid1)).overrun.costMicros, (await rep(c, c.root)).overrun.costMicros, (await rep(c, c.root)).delegatedToChildren.costMicros], [35, 0, 75]);
    await refuses("invalid_command", () => c.reserve(c.root, 1), budgetRefusal);
  });

  suite("an overspend that only eats into another call's hold leaves no overrun once that hold is released", async (c) => {
    await open(c, 200, 0);
    await give(c, c.kid1, 100, 0, c.owner, c.root, "agent:ann");
    const a = await c.reserve(c.kid1, 60);
    const b = await c.reserve(c.kid1, 40);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: a.id, costMicros: 70 });
    await c.svc.release(c.host, { commandId: cid("rel"), reservationId: b.id });
    const k = await c.reserve(c.kid1, 30);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: k.id, costMicros: 30 });
    const kid = await rep(c, c.kid1), root = await rep(c, c.root);
    assert.deepEqual([kid.overrun.costMicros, kid.spent.costMicros, root.delegatedToChildren.costMicros, root.available.costMicros, root.overrun.costMicros], [0, 100, 100, 100, 0]);
  });

  suite("ten concurrent charges to one budgeted task all apply", async (c) => {
    await open(c, 1000, 0);
    const done = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => c.svc.charge(c.host, { commandId: cid("c"), activity: "background-job", taskId: c.root, costMicros: i + 1 })));
    assert.deepEqual(done.map((d) => d.status), Array(10).fill("fulfilled"), JSON.stringify(done.filter((d) => d.status === "rejected")));
    assert.equal((await rep(c, c.root)).spent.costMicros, 55);
    assert.equal((await c.svc.usage(c.owner, { taskId: c.root })).entries, 10);
  });

  suite("the reservation's activity is kept and reaches the ledger", async (c) => {
    await open(c);
    const m = await c.svc.reserve(c.host, { commandId: cid("r"), taskId: c.root, costMicros: 5, purpose: "review pass", activity: "review", agentId: "agent:ben" });
    const d = await c.reserve(c.root, 5);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: m.id, costMicros: 4 });
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: d.id, costMicros: 3 });
    const u = await c.svc.usage(c.owner, { taskId: c.root });
    assert.deepEqual([u.byActivity["review"], u.byActivity["model-call"]], [{ costMicros: 4, computeMs: 0 }, { costMicros: 3, computeMs: 0 }]);
    await refuses("invalid_command", () => c.svc.reserve(c.host, { commandId: cid("r"), taskId: c.root, costMicros: 1, purpose: "x", activity: "dancing" as never }), (e) => assert.equal(e.field, "activity"));
  });

  suite("the addressee finds its pending requests without knowing the tasks, and a caller without rights cannot tell a missing task from a real one", async (c) => {
    await open(c, 100, 0);
    await give(c, c.kid1, 40, 0, c.owner, c.root, "agent:ann");
    const toAnn = await c.svc.requestMore(c.ben, { commandId: cid("q"), taskId: c.kid1, costMicros: 5, reason: "a" });
    const toOwner = await c.svc.requestMore(c.ann, { commandId: cid("q"), taskId: c.root, costMicros: 5, reason: "b" });
    assert.deepEqual((await c.svc.pending(c.ann)).requests.map((r) => r.id), [toAnn.id]);
    assert.deepEqual((await c.svc.pending(c.owner)).requests.map((r) => r.id), [toOwner.id]);
    assert.deepEqual((await c.svc.pending(c.ben)).requests, []);
    assert.equal((await c.svc.pending(c.ann)).truncated, false);
    await c.svc.decide(c.ann, { commandId: cid("dq"), requestId: toAnn.id, approve: false });
    assert.deepEqual((await c.svc.pending(c.ann)).requests, [], "decided requests are no longer pending");
    // Missing task, task without a budget and a task in another project give the same refusal.
    const ghost = "task-aaaaaaaaaaaaaaaaaaaa";
    const msg = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); } catch (e) { assert.ok(e instanceof DomainError); return `${e.code}`; } return "ok"; };
    assert.deepEqual([
      await msg(() => c.svc.requestMore(c.reader, { commandId: cid("q"), taskId: ghost, costMicros: 1, reason: "x" })),
      await msg(() => c.svc.requestMore(c.reader, { commandId: cid("q"), taskId: c.kid2, costMicros: 1, reason: "x" })),
      await msg(() => c.svc.delegate(c.ben, { commandId: cid("d"), parentTaskId: c.root, childTaskId: ghost, costMicros: 1 })),
      await msg(() => c.svc.delegate(c.ben, { commandId: cid("d"), parentTaskId: c.root, childTaskId: c.kid2, costMicros: 1 })),
    ], ["forbidden", "forbidden", "forbidden", "forbidden"]);
  });

  suite("currency and compute are tracked separately", async (c) => {
    await open(c, 100, 1000);
    await refuses("invalid_command", () => c.reserve(c.root, 10, 1001), budgetRefusal);
    await c.reserve(c.root, 0, 900);
    let r = await rep(c, c.root);
    assert.deepEqual([r.available.costMicros, r.available.computeMs, r.reservedInFlight.costMicros], [100, 100, 0], "compute held does not use up money");
    await refuses("invalid_command", () => c.reserve(c.root, 10, 101), budgetRefusal);
    await c.reserve(c.root, 100, 0);
    r = await rep(c, c.root);
    assert.deepEqual([r.available.costMicros, r.available.computeMs], [0, 100]);
    await refuses("invalid_command", () => c.svc.reserve(c.host, { commandId: cid("r"), taskId: c.root, purpose: "nothing" }), (e) => assert.equal(e.field, "costMicros"));
    await refuses("invalid_command", () => c.svc.open(c.owner, { commandId: cid("o"), taskId: c.kid1, currency: "dollars", costMicros: 1 }));
    // A bad number never gets stored.
    await refuses("invalid_command", () => c.reserve(c.root, -1));
    await refuses("invalid_command", () => c.reserve(c.root, 1.5));
  });

  suite("background jobs, meetings and supervision go to their work or to an explicit shared-overhead rule", async (c) => {
    await open(c);
    const r1 = await c.reserve(c.root, 20, 100);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: r1.id, costMicros: 20, computeMs: 80 });
    await c.svc.charge(c.host, { commandId: cid("c"), activity: "background-job", taskId: c.root, agentId: "agent:ann", costMicros: 5, computeMs: 300 });
    await c.svc.charge(c.host, { commandId: cid("c"), activity: "meeting", sharedOverheadRule: "daily meeting, split by nobody: kept as installation overhead", projectId: c.a, costMicros: 7, computeMs: 60 });
    await c.svc.charge(c.host, { commandId: cid("c"), activity: "supervision", sharedOverheadRule: "supervision of idle agents", computeMs: 40 });
    await refuses("invalid_command", () => c.svc.charge(c.host, { commandId: cid("c"), activity: "meeting", costMicros: 1 }), (e) => assert.equal(e.field, "taskId"));
    await refuses("invalid_command", () => c.svc.charge(c.host, { commandId: cid("c"), activity: "meeting", taskId: c.root, sharedOverheadRule: "both", costMicros: 1 }));
    await refuses("invalid_command", () => c.svc.charge(c.host, { commandId: cid("c"), activity: "chatting" as never, taskId: c.root }));
    await refuses("invalid_command", () => c.svc.charge(c.host, { commandId: cid("c"), activity: "meeting", sharedOverheadRule: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", costMicros: 1 }));
    const r = await rep(c, c.root);
    assert.deepEqual([r.spent.costMicros, r.spent.computeMs], [25, 380], "work charged to the task counts against its budget; shared overhead does not");
    const u = await c.svc.usage(c.owner);
    assert.deepEqual(u.totals, { costMicros: 32, computeMs: 480 });
    assert.deepEqual(u.byCategory, { work: { costMicros: 25, computeMs: 380 }, "shared-overhead": { costMicros: 7, computeMs: 100 } });
    assert.deepEqual(u.byActivity["meeting"], { costMicros: 7, computeMs: 60 });
    assert.deepEqual([u.byAgent["agent:ben"], u.byAgent["agent:ann"], u.byAgent["unattributed"]], [{ costMicros: 20, computeMs: 80 }, { costMicros: 5, computeMs: 300 }, { costMicros: 7, computeMs: 100 }]);
    assert.deepEqual(u.byProject[c.a], { costMicros: 32, computeMs: 440 });
    assert.deepEqual(u.byProject["none"], { costMicros: 0, computeMs: 40 });
    assert.deepEqual(u.overheadRules, ["daily meeting, split by nobody: kept as installation overhead", "supervision of idle agents"]);
    assert.equal(u.truncated, false);
    assert.deepEqual((await c.svc.usage(c.owner, { category: "shared-overhead" })).totals, { costMicros: 7, computeMs: 100 });
    assert.deepEqual((await c.svc.usage(c.owner, { taskId: c.root })).totals, { costMicros: 25, computeMs: 380 });
    // Work charged beyond what was free is recorded, as overrun, never refused (it has happened). A task without a budget is attributed in the ledger only.
    await c.svc.charge(c.host, { commandId: cid("c"), activity: "supervision", taskId: c.root, costMicros: 100 });
    assert.equal((await rep(c, c.root)).overrun.costMicros, 25);
    await c.svc.charge(c.host, { commandId: cid("c"), activity: "review", taskId: c.kid1, costMicros: 3 });
    assert.equal((await c.svc.usage(c.owner, { taskId: c.kid1 })).totals.costMicros, 3);
    // A charge repeated by its command ID counts once.
    const cc = cid("c");
    await c.svc.charge(c.host, { commandId: cc, activity: "background-job", taskId: c.kid1, costMicros: 4 });
    await c.svc.charge(c.host, { commandId: cc, activity: "background-job", taskId: c.kid1, costMicros: 4 });
    assert.equal((await c.svc.usage(c.owner, { taskId: c.kid1 })).totals.costMicros, 7);
  });

  suite("usage is readable only where the caller has budget.read, and a report reads like a missing one otherwise", async (c) => {
    await open(c);
    await c.svc.charge(c.host, { commandId: cid("c"), activity: "meeting", sharedOverheadRule: "overhead", costMicros: 1 });
    await c.svc.charge(c.host, { commandId: cid("c"), activity: "meeting", taskId: c.root, costMicros: 2 });
    assert.equal((await c.svc.usage(c.reader, { projectId: c.a })).totals.costMicros, 2);
    await refuses("forbidden", () => c.svc.usage(c.reader, { projectId: c.b }));
    await refuses("forbidden", () => c.svc.usage(c.reader), undefined);
    await refuses("forbidden", () => c.svc.usage(c.ben, { projectId: c.a }));
    assert.ok(await c.svc.report(c.reader, c.root));
    assert.equal(await c.svc.report(c.ben, c.root), undefined);
    assert.equal(await c.svc.report(c.reader, c.foreign), undefined);
    assert.equal(await c.svc.report(c.reader, c.kid1), undefined, "no budget reads like a missing task");
    // The honest statement about ceilings is part of every report.
    const r = await rep(c, c.root);
    assert.equal(r.enforcement, BUDGET_ENFORCEMENT);
    assert.match(r.enforcement.providerCeiling, /not set, checked or enforced by the controller/);
    // Money and compute move only by the right principals.
    await refuses("forbidden", () => c.svc.open(c.ann, { commandId: cid("o"), taskId: c.kid1, currency: "USD", costMicros: 1 }));
    await refuses("forbidden", () => c.reserve(c.root, 1, 0, c.ann));
    await refuses("forbidden", () => c.svc.raise(c.ann, { commandId: cid("r"), taskId: c.root, costMicros: 1 }));
    await refuses("invalid_command", () => c.svc.open(c.owner, { commandId: cid("o"), taskId: c.root, currency: "USD", costMicros: 1 }), (e) => assert.match(e.message, /already has a budget/));
    await refuses("invalid_command", () => c.svc.reserve(c.host, { commandId: cid("r"), taskId: c.root, costMicros: 1, purpose: "x", extra: 1 } as never));
  });

  suite("a request for more budget goes to the owner or the delegated holder, and approval cannot create money the approver lacks", async (c) => {
    await open(c, 100, 0);
    await give(c, c.kid1, 40, 0, c.owner, c.root, "agent:ann");
    await give(c, c.grandkid, 10, 0, c.ann, c.kid1, "agent:ben");
    // The root's request goes to the owner; the grandchild's to the holder of its parent (ann).
    const toOwner = await c.svc.requestMore(c.ann, { commandId: cid("q"), taskId: c.root, costMicros: 50, reason: "more tests than planned" });
    assert.equal(toOwner.to, "owner");
    const toAnn = await c.svc.requestMore(c.ben, { commandId: cid("q"), taskId: c.grandkid, costMicros: 20, reason: "the retry loop was bigger than estimated" });
    assert.equal(toAnn.to, "agent:ann");
    assert.deepEqual((await rep(c, c.grandkid)).pendingRequests.map((p) => [p.id === toAnn.id, p.to, p.costMicros]), [[true, "agent:ann", 20]]);
    // Only the addressee (or the owner) may read or decide it.
    assert.equal(await c.svc.request(c.reader, toAnn.id), undefined);
    assert.equal((await c.svc.request(c.ben, toAnn.id))?.state, "open");
    await refuses("forbidden", () => c.svc.decide(c.ben, { commandId: cid("dq"), requestId: toAnn.id, approve: true }));
    await refuses("forbidden", () => c.svc.decide(c.ann, { commandId: cid("dq"), requestId: toOwner.id, approve: true }));
    await refuses("forbidden", () => c.svc.decide(c.cat, { commandId: cid("dq"), requestId: toAnn.id, approve: true }));
    // Ann's own node has 30 free (40 - 10 handed on): she may give 20, then cannot give more than she has.
    await c.svc.decide(c.ann, { commandId: cid("dq"), requestId: toAnn.id, approve: true, costMicros: 15, note: "15 is what I can spare" });
    assert.deepEqual([(await rep(c, c.grandkid)).limit.costMicros, (await rep(c, c.kid1)).available.costMicros, (await rep(c, c.grandkid)).pendingRequests.length], [25, 15, 0]);
    const second = await c.svc.requestMore(c.ben, { commandId: cid("q"), taskId: c.grandkid, costMicros: 50, reason: "still short" });
    await refuses("invalid_command", () => c.svc.decide(c.ann, { commandId: cid("dq"), requestId: second.id, approve: true }), budgetRefusal);
    await refuses("invalid_command", () => c.svc.decide(c.owner, { commandId: cid("dq"), requestId: second.id, approve: true, costMicros: 60 }));
    // The owner's approval is new money for the task and for every ancestor above it.
    await c.svc.decide(c.owner, { commandId: cid("dq"), requestId: second.id, approve: true, costMicros: 50 });
    assert.deepEqual([(await rep(c, c.grandkid)).limit.costMicros, (await rep(c, c.kid1)).limit.costMicros, (await rep(c, c.kid1)).available.costMicros, (await rep(c, c.root)).limit.costMicros, (await rep(c, c.root)).available.costMicros], [75, 90, 15, 150, 60]);
    await refuses("invalid_transition", () => c.svc.decide(c.owner, { commandId: cid("dq"), requestId: second.id, approve: false }));
    // Denial changes nothing; the request records who decided and why.
    await c.svc.decide(c.owner, { commandId: cid("dq"), requestId: toOwner.id, approve: false, note: "finish within what you have" });
    const denied = await c.svc.request(c.owner, toOwner.id);
    assert.deepEqual([denied?.state, denied?.decidedBy, denied?.note, (await rep(c, c.root)).limit.costMicros], ["denied", "owner:rob", "finish within what you have", 150]);
    // Who may ask, and what may be said.
    await refuses("forbidden", () => c.svc.requestMore(c.reader, { commandId: cid("q"), taskId: c.root, costMicros: 1, reason: "x" }));
    await refuses("forbidden", () => c.svc.requestMore(c.ben, { commandId: cid("q"), taskId: c.foreign, costMicros: 1, reason: "x" }));
    await refuses("invalid_command", () => c.svc.requestMore(c.ann, { commandId: cid("q"), taskId: c.root, costMicros: 1, reason: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }));
    // Owner's direct raise.
    await c.svc.raise(c.owner, { commandId: cid("ra"), taskId: c.kid1, costMicros: 5 });
    assert.deepEqual([(await rep(c, c.kid1)).limit.costMicros, (await rep(c, c.root)).limit.costMicros, (await rep(c, c.root)).available.costMicros], [95, 155, 60]);
    // Open requests per task are bounded.
    for (let i = 0; i < 5; i++) await c.svc.requestMore(c.ann, { commandId: cid("q"), taskId: c.root, costMicros: 1, reason: "r" });
    await refuses("invalid_command", () => c.svc.requestMore(c.ann, { commandId: cid("q"), taskId: c.root, costMicros: 1, reason: "r" }));
  });

  suite("decisions and requests survive a restart and a repeated command applies once", async (c) => {
    await open(c, 100, 0);
    const rc = cid("q");
    const q1 = await c.svc.requestMore(c.ann, { commandId: rc, taskId: c.root, costMicros: 10, reason: "more" });
    const q2 = await c.svc.requestMore(c.ann, { commandId: rc, taskId: c.root, costMicros: 10, reason: "more" });
    assert.deepEqual([q1.id === q2.id, q2.replayed, q2.to], [true, true, "owner"]);
    const r = await c.reserve(c.root, 30);
    await c.svc.markUncertain(c.host, { commandId: cid("u"), reservationId: r.id, reason: "crash" });
    // A new service instance on the same storage (a restart) sees the same picture and carries on.
    const again = c.open();
    const dc = cid("dq");
    await again.decide(c.owner, { commandId: dc, requestId: q1.id, approve: true, costMicros: 10 });
    await c.svc.decide(c.owner, { commandId: dc, requestId: q1.id, approve: true, costMicros: 10 });
    const seen = (await again.report(c.owner, c.root))!;
    assert.deepEqual([seen.limit.costMicros, seen.uncertain.costMicros, seen.available.costMicros, seen.pendingRequests.length], [110, 30, 80, 0]);
    await again.settle(c.host, { commandId: cid("s"), reservationId: r.id, costMicros: 30 });
    assert.deepEqual([(await rep(c, c.root)).spent.costMicros, (await rep(c, c.root)).uncertain.costMicros], [30, 0]);
  });

  suite("cache figures of a call (C06) reach the ledger through settle and charge, are summed by backend, and a call without them counts as unknown, not zero", async (c) => {
    await open(c, 100, 0);
    const hit = (cachedTokens: number, backend = "claude", route = "anthropic/claude-opus-5-5") => ({ backend, route, cachedTokens, computedTokens: 10, writtenTokens: 5 });
    const r1 = await c.reserve(c.root, 20);
    const sc = cid("s");
    await c.svc.settle(c.host, { commandId: sc, reservationId: r1.id, costMicros: 10, cache: hit(900) });
    await c.svc.settle(c.host, { commandId: sc, reservationId: r1.id, costMicros: 10, cache: hit(900) }); // a repeat is the recorded answer
    const r2 = await c.reserve(c.root, 20);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: r2.id, costMicros: 10 }); // no cache figures
    const cc = cid("c");
    await c.svc.charge(c.host, { commandId: cc, activity: "meeting", taskId: c.root, costMicros: 1, cache: hit(50, "radiance", "local/qwen3.8") });
    await c.svc.charge(c.host, { commandId: cc, activity: "meeting", taskId: c.root, costMicros: 1, cache: hit(50, "radiance", "local/qwen3.8") });
    const u = await c.svc.usage(c.owner, { taskId: c.root });
    assert.equal(u.entries, 3);
    assert.deepEqual(u.cache, { cachedTokens: 950, computedTokens: 20, writtenTokens: 10, calls: 2 });
    assert.deepEqual(u.cacheByBackend, { claude: { cachedTokens: 900, computedTokens: 10, writtenTokens: 5, calls: 1 }, radiance: { cachedTokens: 50, computedTokens: 10, writtenTokens: 5, calls: 1 } });
    assert.deepEqual(u.totals, { costMicros: 21, computeMs: 0 }, "tokens never mix into money");
    // The same command with different cache figures is a conflict, and bad figures are refused.
    const r3 = await c.reserve(c.root, 5);
    const sc3 = cid("s");
    await c.svc.settle(c.host, { commandId: sc3, reservationId: r3.id, costMicros: 1, cache: hit(7) });
    await refuses("command_conflict", () => c.svc.settle(c.host, { commandId: sc3, reservationId: r3.id, costMicros: 1, cache: hit(8) }));
    const r4 = await c.reserve(c.root, 5);
    for (const bad of [{ ...hit(1), cachedTokens: -1 }, { ...hit(1), route: "no slash" }, { ...hit(1), backend: "Bad Name" }, { ...hit(1), extra: 1 }, "x"]) {
      await refuses("invalid_command", () => c.svc.settle(c.host, { commandId: cid("s"), reservationId: r4.id, costMicros: 1, cache: bad as never }));
    }
  });
}

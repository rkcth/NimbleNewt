import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ReviewService } from "../review/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { CommitGateService, commitOnce, type CommitPermit, type CommitPort, type MadeCommit } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-22T15:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const ID = (c: string): string => c.repeat(40).slice(0, 40);

for (const backend of backends) {
  interface Ctx { gate: CommitGateService; reviews: ReviewService; grants: GrantService; owner: Principal; ann: Principal; rev: Principal; ben: Principal; a: string; task: string; ask(by?: Principal, extra?: Record<string, unknown>): Promise<{ id: string; reviewId: string }>; decide(reviewId: string, by?: Principal, verdict?: "allow" | "deny"): Promise<void> }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-22T15:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
        const agent = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const worker: Grant[] = [{ action: "attempt.work", project: a }, { action: "review.request", project: a }, { action: "tool.git-commit", project: a }, { action: "history.read", project: a }];
        const ann = await agent("ann", worker);
        const ben = await agent("ben", worker.filter((g) => g.action !== "history.read"));
        const rev = await agent("rev", [{ action: "review.decide", project: a }, { action: "attempt.work", project: a }, { action: "review.request", project: a }, { action: "tool.git-commit", project: a }]);
        const reviews = ReviewService.withEpoch(world.storage, projects.epoch, options);
        const gate = CommitGateService.withEpoch(world.storage, projects.epoch, reviews, grants, options);
        const staged = (extra: Record<string, unknown> = {}) => ({ taskId: task, base: ID("a"), tree: ID("b"), message: "Add the thing\n\nWith a body.", files: [{ path: "src/a.ts", op: "write" as const }, { path: "old.txt", op: "delete" as const }], ...extra });
        await body({
          gate, reviews, grants, owner, ann, rev, ben, a, task,
          ask: async (by = ann, extra = {}) => { const r = await gate.request(by, { commandId: cid("rq"), ...staged(extra) } as never); return { id: r.id, reviewId: r.reviewId }; },
          decide: async (reviewId, by = owner, verdict = "allow") => { const v = (await reviews.get(owner, reviewId))!; await reviews.decide(by, { commandId: cid("dc"), requestId: reviewId, expectedRevision: v.revision, verdict, reason: "reviewed the tree" }); },
        });
      } finally { await world.close(); }
    });

  const present = (id: string) => ({ requestId: id, base: ID("a"), tree: ID("b"), message: "Add the thing\n\nWith a body." });
  const fake = (found?: MadeCommit) => {
    const state = { commits: found === undefined ? [] as MadeCommit[] : [found], made: 0, crashAfterCommit: false };
    const port: CommitPort = {
      find: async (id) => { void id; return state.commits[0]; },
      commit: async (_permit: CommitPermit) => { state.made++; const m = { commitId: ID("c"), parent: ID("a"), tree: ID("b") }; state.commits.push(m); if (state.crashAfterCommit) { state.crashAfterCommit = false; throw new Error("crash between commit and record"); } return m; },
    };
    return { state, port };
  };

  suite("H12o: a retry or restart between the commit and its record makes one commit, also after the permit ran out", async (c) => {
    const { id, reviewId } = await c.ask(); await c.decide(reviewId);
    const { state, port } = fake(); state.crashAfterCommit = true;
    await assert.rejects(() => commitOnce(c.gate, c.ann, port, present(id)), /crash between/);
    assert.equal((await c.gate.get(c.ann, id))!.state, "authorized");
    now += 2 * 60 * 60 * 1000; // restart much later: the permit is gone, the commit is not
    const again = await commitOnce(c.gate, c.ann, port, present(id));
    assert.deepEqual([again.commitId, again.recovered, again.alreadyRecorded, state.made], [ID("c"), true, false, 1]);
    const third = await commitOnce(c.gate, c.ann, port, present(id));
    assert.deepEqual([third.commitId, third.alreadyRecorded, state.made], [ID("c"), true, 1]);
    assert.equal((await c.gate.get(c.ann, id))!.state, "committed");
  });

  suite("H12o: the normal path commits once and a repeat answers from the record", async (c) => {
    const { id, reviewId } = await c.ask(); await c.decide(reviewId);
    const { state, port } = fake();
    const first = await commitOnce(c.gate, c.ann, port, present(id));
    assert.deepEqual([first.recovered, first.alreadyRecorded, state.made], [false, false, 1]);
    const second = await commitOnce(c.gate, c.ann, port, present(id));
    assert.deepEqual([second.commitId, second.alreadyRecorded, state.made], [first.commitId, true, 1]);
  });

  suite("H12o: two concurrent calls for one request make one commit", async (c) => {
    const { id, reviewId } = await c.ask(); await c.decide(reviewId);
    const { state, port } = fake();
    const slow: CommitPort = { ...port, commit: async (p) => { await new Promise((r) => setTimeout(r, 30)); return port.commit(p); } };
    const [x, y] = await Promise.all([commitOnce(c.gate, c.ann, slow, present(id)), commitOnce(c.gate, c.ann, slow, present(id))]);
    assert.equal(state.made, 1);
    assert.equal(x.commitId, y.commitId);
    assert.deepEqual([x.alreadyRecorded, y.alreadyRecorded].sort(), [false, true]);
  });

  suite("H12o: a commit made before HEAD moved is found by the request marker and not made again", async (c) => {
    const { id, reviewId } = await c.ask(); await c.decide(reviewId);
    const { state, port } = fake(); state.crashAfterCommit = true;
    const moved: CommitPort = { ...port, find: async () => undefined, findByRequest: async () => state.commits[0] }; // reachable history no longer has it; the made record does
    await assert.rejects(() => commitOnce(c.gate, c.ann, moved, present(id)), /crash between/);
    now += 2 * 60 * 60 * 1000;
    const again = await commitOnce(c.gate, c.ann, moved, present(id));
    assert.deepEqual([again.commitId, again.recovered, state.made], [ID("c"), true, 1]);
    // without findByRequest the miss would make a second commit; the port's intent hook is called before the commit
    const intents: string[] = [];
    const { id: id2, reviewId: r2 } = await c.ask(); await c.decide(r2);
    const f2 = fake();
    await commitOnce(c.gate, c.ann, { ...f2.port, intend: async (rid, tree) => { intents.push(`${rid}:${tree}`); } }, present(id2));
    assert.deepEqual(intents, [`${id2}:${ID("b")}`]);
  });

  suite("H12o: recovery records a found commit only while the approval stands", async (c) => {
    const { id, reviewId } = await c.ask(); await c.decide(reviewId);
    assert.equal((await c.gate.approvalStands(c.ann, id)).stands, true);
    const { state, port } = fake(); state.crashAfterCommit = true;
    await assert.rejects(() => commitOnce(c.gate, c.ann, port, present(id)), /crash between/);
    assert.equal((await c.gate.approvalStands(c.ann, id)).stands, true, "used still stands");
    const withdrawn = { get: c.gate.get.bind(c.gate), recordCommit: c.gate.recordCommit.bind(c.gate), authorize: c.gate.authorize.bind(c.gate), approvalStands: async () => ({ stands: false, reason: "the review is withdrawn" }) } as unknown as CommitGateService;
    await refuses("review_invalid", () => commitOnce(withdrawn, c.ann, port, present(id)), (e) => assert.match(e.message, /withdrawn/));
    assert.equal((await c.gate.get(c.ann, id))!.state, "authorized");
    // a different request whose review was withdrawn does not stand
    const q = await c.ask(); await c.decide(q.reviewId);
    const v = (await c.reviews.get(c.owner, q.reviewId))!;
    await c.reviews.withdraw(c.owner, { commandId: cid("wd"), requestId: q.reviewId, expectedRevision: v.revision, reason: "changed my mind" });
    assert.equal((await c.gate.approvalStands(c.ann, q.id)).stands, false);
  });

  suite("H12o: a commit made with another tree than the approved one is refused and not recorded", async (c) => {
    const { id, reviewId } = await c.ask(); await c.decide(reviewId);
    const { port } = fake();
    const odd: CommitPort = { ...port, commit: async () => ({ commitId: ID("c"), parent: ID("a"), tree: ID("f") }) };
    await refuses("review_invalid", () => commitOnce(c.gate, c.ann, odd, present(id)), (e) => assert.match(e.message, /not the approved tree|not recorded/));
    assert.equal((await c.gate.get(c.ann, id))!.state, "authorized");
  });

  suite("H12o: a changed tree or base needs a new approval, and a found commit of another tree or base is never recorded", async (c) => {
    const { id, reviewId } = await c.ask(); await c.decide(reviewId);
    const { state, port } = fake();
    await refuses("review_invalid", () => commitOnce(c.gate, c.ann, port, { ...present(id), tree: ID("d") }), (e) => assert.match(e.message, /staged tree/));
    assert.equal(state.made, 0);
    for (const odd of [{ commitId: ID("e"), parent: ID("a"), tree: ID("f") }, { commitId: ID("e"), parent: ID("9"), tree: ID("b") }]) {
      await c.gate.authorize(c.ann, { commandId: cid("au"), ...present(id) });
      await refuses("review_invalid", () => commitOnce(c.gate, c.ann, fake(odd).port, present(id)), (e) => assert.match(e.message, /new approval/));
      assert.equal((await c.gate.get(c.ann, id))!.state, "authorized");
    }
  });

  suite("H12o: a commit found for a request that was never authorized, and a stranger, are refused", async (c) => {
    const { id } = await c.ask();
    await refuses("review_invalid", () => commitOnce(c.gate, c.ann, fake({ commitId: ID("c"), parent: ID("a"), tree: ID("b") }).port, present(id)), (e) => assert.match(e.message, /never authorized/));
    await refuses("forbidden", () => commitOnce(c.gate, c.ben, fake().port, present(id)));
    assert.equal((await c.gate.get(c.ann, id))!.state, "requested");
  });
}

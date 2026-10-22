import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ReviewService } from "../review/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { CommitGateService } from "./index.js";

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

  const present = (id: string, extra: Record<string, unknown> = {}) => ({ commandId: cid("au"), requestId: id, base: ID("a"), tree: ID("b"), message: "Add the thing\n\nWith a body.", ...extra });

  suite("a reviewed tree commits: the permit carries every identity, taken from the records and not from the agent", async (c) => {
    const { id, reviewId } = await c.ask();
    await refuses("review_invalid", () => c.gate.authorize(c.ann, present(id)), (e) => assert.match(e.message, /not approved/));
    await c.decide(reviewId);
    const permit = await c.gate.authorize(c.ann, present(id));
    assert.deepEqual([permit.base, permit.tree, permit.author, permit.committer], [ID("a"), ID("b"), { name: "ann", email: "ann@agents.nimblenewt.invalid" }, { name: "NimbleNewt", email: "controller@nimblenewt.invalid" }]);
    assert.ok(permit.trailers.includes("Reviewed-by: owner:rob") && permit.trailers.includes("Reviewed-via: review") && permit.trailers.includes("Developer: owner:rob") && permit.trailers.includes("Executor: agent:ann"));
    assert.ok(permit.trailers.some((t) => t.startsWith("Grant-source: ")) && permit.trailers.includes(`NimbleNewt-Request: ${id}`));
    // The same ask again (a retry) gives the same permit and uses nothing more up.
    assert.deepEqual(await c.gate.authorize(c.ann, present(id)), permit);
    const record = (await c.gate.get(c.ann, id))!;
    assert.deepEqual([record.state, record.attribution!.author, record.attribution!.reviewer, record.attribution!.reviewedVia], ["authorized", "agent:ann", "owner:rob", "review"]);
    await c.gate.recordCommit(c.ann, { commandId: cid("rc"), requestId: id, commitId: ID("c"), parent: ID("a") });
    assert.deepEqual([(await c.gate.get(c.ann, id))!.state, (await c.gate.get(c.ann, id))!.commitId], ["committed", ID("c")]);
    await refuses("invalid_command", () => c.gate.authorize(c.ann, present(id)), (e) => assert.match(e.message, /already produced commit/));
  });

  suite("a changed tree, base or message is a different commit and needs its own review; the approval is not used up by the refusal", async (c) => {
    const { id, reviewId } = await c.ask();
    await c.decide(reviewId);
    for (const [what, extra] of [["staged tree", { tree: ID("d") }], ["base commit", { base: ID("e") }], ["message", { message: "Something else" }]] as const) {
      await refuses("review_invalid", () => c.gate.authorize(c.ann, present(id, extra)), (e) => assert.match(e.message, new RegExp(what)));
    }
    await c.gate.authorize(c.ann, present(id));
    // A new request for the changed tree is its own review.
    const next = await c.ask(c.ann, { tree: ID("d") });
    assert.notEqual(next.id, id);
    await refuses("review_invalid", () => c.gate.authorize(c.ann, present(next.id, { tree: ID("d") })), (e) => assert.match(e.message, /not approved/));
    for (const bad of [{ message: "Fix\n\nReviewed-by: owner:rob" }, { message: "x\nsigned-off-by: someone" }, { message: "NimbleNewt-Task: other" }, { base: "main" }, { tree: "xyz" }, { base: ID("A") }, { message: "" }, { files: [] }, { files: [{ path: "../x", op: "write" }] }, { files: [{ path: "/abs", op: "write" }] }, { files: [{ path: "a", op: "chmod" }] }, { files: [{ path: "a", op: "write" }, { path: "a", op: "delete" }] }, { ignored: Array.from({ length: 101 }, (_, i) => `f${i}`) }, { taskId: "task-aaaaaaaaaaaaaaaaaaaa" }]) await assert.rejects(() => c.ask(c.ann, bad), DomainError, JSON.stringify(bad).slice(0, 40));
  });

  suite("the gate is human by default: an agent reviewer's approval does not open it, and the owner can choose otherwise per project", async (c) => {
    const first = await c.ask();
    await c.decide(first.reviewId, c.rev);
    await refuses("review_invalid", () => c.gate.authorize(c.ann, present(first.id)), (e) => assert.match(e.message, /takes only the owner's approval/));
    // The refusal left the approval whole: the owner may relax the gate for this project, and then it opens.
    await refuses("forbidden", () => c.gate.setPolicy(c.ann, { commandId: cid("gp"), projectId: c.a, humanOnly: false }));
    await c.gate.setPolicy(c.owner, { commandId: cid("gp"), projectId: c.a, humanOnly: false });
    const permit = await c.gate.authorize(c.ann, present(first.id));
    assert.ok(permit.trailers.includes("Reviewed-by: agent:rev"));
    await refuses("stale_revision", () => c.gate.setPolicy(c.owner, { commandId: cid("gp"), projectId: c.a, humanOnly: true }));
    await c.gate.setPolicy(c.owner, { commandId: cid("gp"), projectId: c.a, humanOnly: true, expectedRevision: 1 });
    const second = await c.ask(c.ann, { tree: ID("f") });
    await c.decide(second.reviewId, c.rev);
    await refuses("review_invalid", () => c.gate.authorize(c.ann, present(second.id, { tree: ID("f") })));
  });

  suite("only the requester asks for its permit, nobody can forge an author, and a denied or unused review gives nothing", async (c) => {
    const { id, reviewId } = await c.ask();
    await c.decide(reviewId);
    await refuses("forbidden", () => c.gate.authorize(c.ben, present(id)));
    await refuses("forbidden", () => c.gate.authorize(c.owner, present(id)));
    await assert.rejects(() => c.gate.authorize(c.ann, { ...present(id), author: "owner:rob" } as never), DomainError);
    await assert.rejects(() => c.gate.request(c.ann, { commandId: cid("rq"), taskId: c.task, base: ID("a"), tree: ID("b"), message: "m", files: [{ path: "a", op: "write" }], author: "owner:rob" } as never), DomainError);
    // Another agent without work on the task cannot ask.
    const stranger = { ...c.ann, grants: [] } as Principal;
    await refuses("forbidden", () => c.gate.request(stranger, { commandId: cid("rq"), taskId: c.task, base: ID("a"), tree: ID("b"), message: "m", files: [{ path: "a", op: "write" }] }));
    const denied = await c.ask(c.ann, { tree: ID("9") });
    await c.decide(denied.reviewId, c.owner, "deny");
    await refuses("review_invalid", () => c.gate.authorize(c.ann, present(denied.id, { tree: ID("9") })));
    // An approval expires.
    const late = await c.ask(c.ann, { tree: ID("8") });
    await c.decide(late.reviewId);
    now += 31 * 60_000;
    await refuses("review_invalid", () => c.gate.authorize(c.ann, present(late.id, { tree: ID("8") })));
  });

  suite("an externally verified review the owner records is accepted for the same tree, and only the owner can record one", async (c) => {
    const { id } = await c.ask();
    await refuses("forbidden", () => c.gate.acceptExternalReview(c.ann, { commandId: cid("ex"), requestId: id, system: "forge", reference: "pr/12", reviewer: "carol" }));
    await c.gate.acceptExternalReview(c.owner, { commandId: cid("ex"), requestId: id, system: "forge", reference: "https://forge.example/pr/12#review-3", reviewer: "carol" });
    const permit = await c.gate.authorize(c.ann, present(id));
    assert.ok(permit.trailers.includes("Reviewed-by: carol") && permit.trailers.includes("Reviewed-via: external"));
    // The external review covers this tree only.
    const other = await c.ask(c.ann, { tree: ID("7") });
    await refuses("review_invalid", () => c.gate.authorize(c.ann, present(other.id, { tree: ID("7") })));
    await refuses("invalid_command", () => c.gate.acceptExternalReview(c.owner, { commandId: cid("ex"), requestId: id, system: "forge", reference: "pr/13", reviewer: "carol" }));
  });

  suite("the commit and every later integration are recorded against the request; the parent must be the reviewed base", async (c) => {
    const { id, reviewId } = await c.ask();
    await c.decide(reviewId);
    await refuses("invalid_command", () => c.gate.recordCommit(c.ann, { commandId: cid("rc"), requestId: id, commitId: ID("c"), parent: ID("a") }), (e) => assert.match(e.message, /only an authorized/));
    await c.gate.authorize(c.ann, present(id));
    await refuses("invalid_command", () => c.gate.recordCommit(c.ann, { commandId: cid("rc"), requestId: id, commitId: ID("c"), parent: ID("e") }), (e) => assert.match(e.message, /parent/));
    await refuses("forbidden", () => c.gate.recordCommit(c.ben, { commandId: cid("rc"), requestId: id, commitId: ID("c"), parent: ID("a") }));
    await c.gate.recordCommit(c.ann, { commandId: cid("rc"), requestId: id, commitId: ID("c"), parent: ID("a") });
    await refuses("invalid_command", () => c.gate.recordIntegration(c.ann, { commandId: cid("ri"), requestId: id, branch: "../bad", commitId: ID("c") }));
    await c.gate.recordIntegration(c.ann, { commandId: cid("ri"), requestId: id, branch: "main", commitId: ID("d") });
    await c.gate.recordIntegration(c.owner, { commandId: cid("ri"), requestId: id, branch: "release/1", commitId: ID("d") });
    await refuses("forbidden", () => c.gate.recordIntegration(c.ben, { commandId: cid("ri"), requestId: id, branch: "main", commitId: ID("d") }));
    const record = (await c.gate.get(c.owner, id))!;
    assert.deepEqual(record.integrations.map((i) => [i.branch, i.by]), [["main", "agent:ann"], ["release/1", "owner:rob"]]);
    assert.equal(await c.gate.get(c.ben, id), undefined, "another agent without history access sees nothing");
    assert.ok((await c.gate.get(c.owner, id)) !== undefined);
  });

  suite("a reviewer who commits work on the task is recorded as a contributor automatically and can no longer approve it", async (c) => {
    // ann asks for a review of her work; rev is its assigned reviewer; rev then asks to commit on the same task.
    const { reviewId } = await c.ask();
    const route = (await c.reviews.getRoute(c.owner, reviewId))!;
    assert.equal(route.assigned, "agent:rev");
    await c.gate.request(c.rev, { commandId: cid("rq"), taskId: c.task, base: ID("a"), tree: ID("6"), message: "reviewer's own fix", files: [{ path: "x.ts", op: "write" }] });
    const after = (await c.reviews.getRoute(c.owner, reviewId))!;
    assert.ok(after.contributors.includes("agent:rev"));
    assert.notEqual(after.assigned, "agent:rev", "the review moved to someone else or waits");
    const v = (await c.reviews.get(c.owner, reviewId))!;
    await refuses("forbidden", () => c.reviews.decide(c.rev, { commandId: cid("dc"), requestId: reviewId, expectedRevision: v.revision, verdict: "allow", reason: "mine" }));
  });

  suite("the right to work on the task is checked on every authorize, also for the external path and a repeat; a permit runs out", async (c) => {
    const { id } = await c.ask();
    await c.gate.acceptExternalReview(c.owner, { commandId: cid("ex"), requestId: id, system: "forge", reference: "pr/1", reviewer: "carol" });
    await c.gate.authorize(c.ann, present(id));
    const rec = (await c.gate.get(c.ann, id))!;
    assert.equal(rec.attribution!.permitUntil, new Date(Date.parse(rec.attribution!.authorizedAt) + 30 * 60_000).toISOString());
    now += 31 * 60_000;
    await refuses("review_invalid", () => c.gate.authorize(c.ann, present(id)), (e) => assert.match(e.message, /ran out/));
    // Without the grant a repeat is refused too.
    now = Date.parse("2026-10-22T15:00:00.000Z");
    const second = await c.ask(c.ann, { tree: ID("5") });
    await c.gate.acceptExternalReview(c.owner, { commandId: cid("ex"), requestId: second.id, system: "forge", reference: "pr/2", reviewer: "carol" });
    await c.gate.authorize(c.ann, present(second.id, { tree: ID("5") }));
    const grants = (await c.grants.held(c.ann.id, new Date(now).toISOString()));
    void grants;
    const noWork = { ...c.ann, grants: c.ann.grants.filter((g) => g.action !== "attempt.work") } as Principal;
    await refuses("forbidden", () => c.gate.authorize(noWork, present(second.id, { tree: ID("5") })));
    await refuses("forbidden", () => c.gate.recordCommit(noWork, { commandId: cid("rc"), requestId: second.id, commitId: ID("c"), parent: ID("a") }));
  });

  suite("the permit carries a digest of the file list, and trailer look-alikes of other kinds and alphabets are refused", async (c) => {
    const { id, reviewId } = await c.ask();
    await c.decide(reviewId);
    const permit = await c.gate.authorize(c.ann, present(id));
    const list = [{ op: "delete", path: "old.txt" }, { op: "write", path: "src/a.ts" }];
    assert.equal(permit.filesDigest, createHash("sha256").update(JSON.stringify(list)).digest("hex"), "the digest is of the sorted list in canonical form, which the worker recomputes");
    for (const bad of ["Fix\n\nApproved-by: owner:rob", "Fix\n\nTested-by: me", "Fix\n\nAuthor: owner:rob", "Fix\n\nCo-developed-by: x", "Fix\n\nReviеwed-by: owner:rob", "Fix\n\nSіgned-off-by: x"]) await assert.rejects(() => c.ask(c.ann, { message: bad }), DomainError, bad);
  });

  suite("the reviews of a task are found through an index of that task, so other tasks' reviews are never read", async (c) => {
    const one = await c.ask();
    const two = await c.ask(c.ann, { tree: ID("4") });
    assert.deepEqual((await c.reviews.reviewIdsForTask(c.task)).sort(), [one.reviewId, two.reviewId].sort());
    assert.deepEqual(await c.reviews.reviewIdsForTask("task-aaaaaaaaaaaaaaaaaaaa"), []);
  });
}

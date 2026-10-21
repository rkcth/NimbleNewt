import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ReviewService, REVIEW_LIMITS, type Operation } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-21T10:00:00.000Z");
const stamp = (ms = now): string => new Date(ms).toISOString();
const options = { clock: () => stamp(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    review: ReviewService; grants: GrantService; owner: Principal; a: string; b: string; task: string; ann: Principal; rev: Principal; mallory: Principal;
    agent(name: string, grants: Grant[]): Promise<Principal>; login(name: string): Promise<Principal>;
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
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "the task" })).id;
        const ann = await agent("ann", [{ action: "review.request", project: a }, { action: "attempt.work", project: a }, { action: "tool.run-script", project: a }]);
        const rev = await agent("rev", [{ action: "review.decide", project: a }]);
        const mallory = await agent("mallory", []);
        await body({
          review: ReviewService.withEpoch(world.storage, projects.epoch, options), grants: GrantService.withEpoch(world.storage, projects.epoch, options),
          owner, a, b, task, ann, rev, mallory, agent, login: async (nm) => principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token),
        });
      } finally { await world.close(); }
    });
  const op = (extra: Partial<Operation> = {}): Operation => ({ name: "run-script", args: { cwd: "/work", flags: ["-x"] }, script: "echo hello\nrm -rf build\n", target: { kind: "workspace", id: "main" }, ...extra });
  const context = { toolVersion: "1.2.3", authoritySource: "task grant", expectedEffects: ["builds the project"], affectedResources: ["workspace:main"] };
  const ask = (review: ReviewService, who: Principal, task: string, operation: Operation = op()) => review.request(who, { commandId: cid("rq"), taskId: task, operation, note: "please check", context });
  const approve = async (review: ReviewService, who: Principal, id: string, extra: Record<string, unknown> = {}) => {
    const v = (await review.get(who, id))!;
    await review.decide(who, { commandId: cid("dc"), requestId: id, expectedRevision: v.revision, verdict: "allow", reason: "reviewed the script", ...extra });
  };

  suite("the exact reviewed operation is admitted once; a repeat of the same call replays and a second use is refused", async ({ review, ann, rev, task }) => {
    const r = await ask(review, ann, task);
    await approve(review, rev, r.id);
    const seen = (await review.get(ann, r.id))!;
    assert.deepEqual([seen.state, seen.decidedBy], ["approved", "agent:rev"]);
    const call = { commandId: "run-it", requestId: r.id, operation: op() };
    assert.deepEqual(await review.admit(ann, call), { admitted: true, requestId: r.id, replayed: false });
    assert.equal((await review.admit(ann, call)).replayed, true, "the same call again is recognised, not a second use");
    assert.equal((await review.get(ann, r.id))!.state, "used");
    await refuses("review_invalid", () => review.admit(ann, { ...call, commandId: cid("again") }), (e) => assert.match(e.message, /is used, not approved/));
  });

  suite("a changed tool, argument, script or target is not the reviewed operation, is named, and does not use the approval up", async ({ review, ann, rev, task }) => {
    const r = await ask(review, ann, task);
    await approve(review, rev, r.id);
    const attempt = (operation: Operation) => review.admit(ann, { commandId: cid("ad"), requestId: r.id, operation });
    await refuses("review_invalid", () => attempt(op({ args: { cwd: "/work", flags: ["-x", "--force"] } })), (e) => assert.match(e.message, /the arguments changed/));
    await refuses("review_invalid", () => attempt(op({ script: "echo hello\nrm -rf /\n" })), (e) => assert.match(e.message, /the script changed/));
    await refuses("review_invalid", () => { const { script: _s, ...noScript } = op(); return attempt(noScript); }, (e) => assert.match(e.message, /the script changed/));
    await refuses("review_invalid", () => attempt(op({ target: { kind: "workspace", id: "other" } })), (e) => assert.match(e.message, /the target changed/));
    await refuses("review_invalid", () => attempt(op({ name: "write-file" })), (e) => assert.match(e.message, /the tool/));
    await refuses("review_invalid", () => attempt(op({ name: "write-file", args: {}, target: { kind: "workspace", id: "x" } })), (e) => assert.match(e.message, /the tool, the arguments, the target/));
    // Key order and whitespace in the arguments do not matter; content does.
    assert.equal((await attempt(op({ args: { flags: ["-x"], cwd: "/work" } }))).admitted, true, "the refused tries did not use the approval up");
  });

  suite("revoking the executor's grant, adding a restriction, or any change to the grants that bear on it, invalidates the approval before it runs", async ({ review, grants, owner, ann, rev, task, a, login }) => {
    const g = await grants.grant(owner, { commandId: cid("g"), grantee: "agent:ann", action: "tool.run-script", project: a, source: "direct", basis: "may run scripts" });
    const one = await ask(review, await login("ann"), task);
    await approve(review, rev, one.id);
    await grants.revoke(owner, { commandId: cid("r"), grantId: g.id, expectedRevision: g.revision, reason: "no longer" });
    await refuses("review_invalid", () => review.admit(ann, { commandId: cid("ad"), requestId: one.id, operation: op() }), (e) => assert.match(e.message, /grants or restrictions that bear on it changed/));
    // A restriction.
    const two = await ask(review, await login("ann"), task);
    await approve(review, rev, two.id);
    await grants.restrict(owner, { commandId: cid("rs"), subject: "agent:ann", action: "tool.run-script", project: a, reason: "frozen" });
    await refuses("review_invalid", () => review.admit(ann, { commandId: cid("ad"), requestId: two.id, operation: op() }), (e) => assert.match(e.message, /grants or restrictions/));
  });

  suite("an approval adds no capability: without the grant itself the executor is refused, and approving needs no capability of the tool", async ({ review, agent, rev, task, a }) => {
    const bob = await agent("bob", [{ action: "review.request", project: a }, { action: "attempt.work", project: a }]);
    const r = await ask(review, bob, task);
    await approve(review, rev, r.id);
    await refuses("forbidden", () => review.admit(bob, { commandId: cid("ad"), requestId: r.id, operation: op() }), (e) => assert.match(e.message, /does not give one/));
    assert.equal((await review.get(bob, r.id))!.state, "approved", "and nothing was used");
  });

  suite("who may request, decide and admit: no self-review, the review right is needed, other principals' reviews read as missing", async ({ review, owner, ann, rev, mallory, task, agent, a, b }) => {
    await refuses("forbidden", () => ask(review, mallory, task), (e) => assert.match(e.message, /may not ask for a review/));
    const missingTask = await review.request(mallory, { commandId: cid("rq"), taskId: "task-aaaaaaaaaaaaaaaaaaaa", operation: op() }).then(() => "ok", (e: DomainError) => `${e.code}: ${e.message.replace(mallory.id, "WHO")}`);
    const noRight = await review.request(mallory, { commandId: cid("rq"), taskId: task, operation: op() }).then(() => "ok", (e: DomainError) => `${e.code}: ${e.message.replace(mallory.id, "WHO")}`);
    assert.equal(missingTask, noRight);
    const r = await ask(review, ann, task);
    const selfReviewer = await agent("both", [{ action: "review.request", project: a }, { action: "attempt.work", project: a }, { action: "review.decide", project: a }]);
    const own = await ask(review, selfReviewer, task);
    await refuses("forbidden", () => review.decide(selfReviewer, { commandId: cid("dc"), requestId: own.id, expectedRevision: 1, verdict: "allow", reason: "me" }), (e) => assert.match(e.message, /may not decide/));
    await review.decide(owner, { commandId: cid("dc"), requestId: own.id, expectedRevision: 1, verdict: "allow", reason: "the owner may review what others request" });
    assert.equal((await review.get(owner, own.id))!.decidedBy, "owner:rob");
    const outsider = await agent("outsider", [{ action: "review.decide", project: b }]);
    await refuses("forbidden", () => review.decide(outsider, { commandId: cid("dc"), requestId: r.id, expectedRevision: 1, verdict: "allow", reason: "wrong project" }));
    await refuses("forbidden", () => review.decide(mallory, { commandId: cid("dc"), requestId: r.id, expectedRevision: 1, verdict: "allow", reason: "no right" }));
    await refuses("forbidden", () => review.decide(rev, { commandId: cid("dc"), requestId: "rev-aaaaaaaaaaaaaaaaaaaa", expectedRevision: 1, verdict: "allow", reason: "missing" }));
    await approve(review, rev, r.id);
    await refuses("forbidden", () => review.admit(selfReviewer, { commandId: cid("ad"), requestId: r.id, operation: op() }), (e) => assert.match(e.message, /has no such review/));
    assert.equal(await review.get(mallory, r.id), undefined);
    assert.ok(await review.get(owner, r.id));
    assert.ok(await review.get(rev, r.id));
    await refuses("invalid_command", () => review.decide(rev, { commandId: cid("dc"), requestId: r.id, expectedRevision: 2, verdict: "deny", reason: "again" }), (e) => assert.match(e.message, /only a pending review/));
  });

  suite("an approval expires; its time is bounded; a denial admits nothing", async ({ review, ann, rev, task }) => {
    const r = await ask(review, ann, task);
    await approve(review, rev, r.id, { expiresAt: stamp(now + 60_000) });
    now += 61_000;
    await refuses("review_invalid", () => review.admit(ann, { commandId: cid("ad"), requestId: r.id, operation: op() }), (e) => assert.match(e.message, /expired at/));
    const d = await ask(review, ann, task);
    await refuses("invalid_command", () => review.decide(rev, { commandId: cid("dc"), requestId: d.id, expectedRevision: 1, verdict: "allow", reason: "x", expiresAt: stamp(now - 1000) }), (e) => assert.match(e.message, /after now/));
    await refuses("invalid_command", () => review.decide(rev, { commandId: cid("dc"), requestId: d.id, expectedRevision: 1, verdict: "allow", reason: "x", expiresAt: stamp(now + 25 * 3_600_000) }), (e) => assert.match(e.message, /within 24 hours/));
    await refuses("invalid_command", () => review.decide(rev, { commandId: cid("dc"), requestId: d.id, expectedRevision: 1, verdict: "allow", reason: "x", expiresAt: "tomorrow" }));
    await review.decide(rev, { commandId: cid("dc"), requestId: d.id, expectedRevision: 1, verdict: "deny", reason: "too risky" });
    await refuses("review_invalid", () => review.admit(ann, { commandId: cid("ad"), requestId: d.id, operation: op() }), (e) => assert.match(e.message, /is denied, not approved/));
    const e = await ask(review, ann, task);
    await approve(review, rev, e.id);
    now += 25 * 60_000;
    assert.equal((await review.admit(ann, { commandId: cid("ad"), requestId: e.id, operation: op() })).admitted, true, "the default 30 minutes had not passed");
  });

  suite("the reviewer, the requester or the owner can take an approval back before it is used, not after", async ({ review, owner, ann, rev, task, mallory }) => {
    const r = await ask(review, ann, task);
    await approve(review, rev, r.id);
    const rv = (await review.get(rev, r.id))!.revision;
    await refuses("forbidden", () => review.withdraw(mallory, { commandId: cid("w"), requestId: r.id, expectedRevision: rv, reason: "meddling" }));
    await review.withdraw(rev, { commandId: cid("w"), requestId: r.id, expectedRevision: rv, reason: "I changed my mind" });
    await refuses("review_invalid", () => review.admit(ann, { commandId: cid("ad"), requestId: r.id, operation: op() }), (e) => assert.match(e.message, /is withdrawn/));
    const u = await ask(review, ann, task);
    await approve(review, rev, u.id);
    await review.admit(ann, { commandId: cid("ad"), requestId: u.id, operation: op() });
    await refuses("invalid_command", () => review.withdraw(owner, { commandId: cid("w"), requestId: u.id, expectedRevision: 3, reason: "too late" }), (e) => assert.match(e.message, /cannot be withdrawn/));
    const o = await ask(review, ann, task);
    await review.withdraw(owner, { commandId: cid("w"), requestId: o.id, expectedRevision: 1, reason: "owner cancelled the request" });
    assert.equal((await review.get(owner, o.id))!.state, "withdrawn");
  });

  suite("two executions of one approval at the same moment: exactly one is admitted", async ({ review, ann, rev, task }) => {
    const r = await ask(review, ann, task);
    await approve(review, rev, r.id);
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => review.admit(ann, { commandId: cid("ad"), requestId: r.id, operation: op() })));
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(results.map((x) => x.status === "rejected" ? (x.reason as DomainError).code : "ok")));
    for (const x of results) if (x.status === "rejected") assert.ok(x.reason instanceof DomainError && x.reason.code === "review_invalid", String(x.reason));
  });

  suite("requests and operations are validated and kept free of credentials", async ({ review, ann, task }) => {
    const bad = (operation: unknown, extra: Record<string, unknown> = {}) => review.request(ann, { commandId: cid("rq"), taskId: task, operation: operation as never, ...extra } as never);
    await refuses("invalid_command", () => bad("rm -rf /"));
    await refuses("invalid_command", () => bad({ ...op(), surprise: 1 }));
    await refuses("invalid_command", () => bad(op({ name: "Run Script" })));
    await refuses("invalid_command", () => bad(op({ args: [] as never })));
    await refuses("invalid_command", () => bad(op({ args: { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } })), (e) => assert.match(e.message, /credential/));
    await refuses("invalid_command", () => bad(op({ script: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' x" })), (e) => assert.match(e.message, /credential/));
    await refuses("invalid_command", () => bad(op({ args: { blob: "x".repeat(REVIEW_LIMITS.args) } })), (e) => assert.match(e.message, /at most/));
    await refuses("invalid_command", () => bad(op({ target: { kind: "Workspace", id: "x" } })));
    await refuses("invalid_command", () => bad(op(), { note: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }));
    await refuses("invalid_command", () => bad(op(), { surprise: 1 }));
    await refuses("invalid_command", () => review.admit(ann, { commandId: cid("ad"), requestId: "nope", operation: op() }));
  });
}

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ReviewService, type Operation } from "./index.js";

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


  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const DIGEST = `sha256:${"ab12".repeat(16)}`;
  const at = (version: string | undefined): Operation => op({ target: { kind: "workspace", id: "main", ...(version === undefined ? {} : { version }) } });
  const admitAt = (review: ReviewService, who: Principal, id: string, version: string | undefined) => review.admit(who, { commandId: cid("ad"), requestId: id, operation: at(version) });

  suite("card A05b: an approval is bound to the target's version; the target changing before the run refuses it, names the version, and does not use the approval up", async ({ review, ann, rev, task }) => {
    const r = await ask(review, ann, task, at(COMMIT));
    await approve(review, rev, r.id);
    const shown = (await review.get(rev, r.id))!;
    assert.equal(shown.operation.target.version, COMMIT, "the reviewer is shown the version");
    assert.equal(shown.binding.target.version, COMMIT);
    await refuses("review_invalid", () => admitAt(review, ann, r.id, "fedcba9876543210fedcba9876543210fedcba98"), (e) => assert.match(e.message, /the target's version changed/));
    await refuses("review_invalid", () => admitAt(review, ann, r.id, undefined), (e) => assert.match(e.message, /the target's version changed/));
    assert.equal((await review.get(ann, r.id))!.state, "approved", "refused tries use nothing up");
    assert.equal((await admitAt(review, ann, r.id, COMMIT)).admitted, true);
  });

  suite("card A05b: an approval given with no version admits no version (a version the reviewer never saw is a change); a digest is a valid version", async ({ review, ann, rev, task }) => {
    const plain = await ask(review, ann, task, at(undefined));
    await approve(review, rev, plain.id);
    await refuses("review_invalid", () => admitAt(review, ann, plain.id, DIGEST), (e) => assert.match(e.message, /the target's version changed/));
    assert.equal((await admitAt(review, ann, plain.id, undefined)).admitted, true);
    const digested = await ask(review, ann, task, at(DIGEST));
    await approve(review, rev, digested.id);
    assert.equal((await admitAt(review, ann, digested.id, DIGEST)).admitted, true);
  });

  suite("card A05b: a repeat request for a changed version is not cleared against the earlier approval; the same version is", async ({ review, ann, rev, task }) => {
    const first = await ask(review, ann, task, at("v1"));
    await approve(review, rev, first.id);
    const same = await ask(review, ann, task, at("v1"));
    assert.deepEqual([same.cleared, same.id], [true, first.id], "the same version is covered");
    const moved = await ask(review, ann, task, at("v2"));
    assert.equal(moved.cleared, false, "a moved target needs its own review");
    assert.notEqual(moved.id, first.id);
    assert.equal((await review.get(rev, moved.id))!.state, "pending");
  });

  suite("card A05b: a version is one short printable token; spaces, control characters, long text, other types, credentials and unknown target fields are refused", async ({ review, ann, task }) => {
    for (const bad of ["", " v1", "v 1", "v1\n", "v1\u0000", "é", "x".repeat(201), "../../etc", "-rf", 7 as unknown as string, null as unknown as string, "sk-" + "a1B2c3D4".repeat(8), "ghp_" + "a1B2c3D4e5F6".repeat(3)]) {
      await refuses("invalid_command", () => ask(review, ann, task, op({ target: { kind: "workspace", id: "main", version: bad } })), (e) => assert.match(e.message, /target\.version/));
    }
    await refuses("invalid_command", () => ask(review, ann, task, op({ target: { kind: "workspace", id: "main", revision: "1" } as never })), (e) => assert.match(e.message, /target\.revision/));
    assert.ok((await ask(review, ann, task, at("x".repeat(200)))).id, "200 characters is the limit");
  });

  suite("card A05b: a version adds no capability: a grant on a resource still matches by kind and ID, and a missing grant is still refused", async ({ review, grants, owner, agent, login, rev, task, a }) => {
    await agent("bob", [{ action: "review.request", project: a }, { action: "attempt.work", project: a }]);
    await grants.grant(owner, { commandId: cid("g"), grantee: "agent:bob", action: "tool.run-script", project: a, resource: { kind: "workspace", id: "main" }, source: "direct", basis: "may run scripts in main" });
    const bob = await login("bob");
    const r = await ask(review, bob, task, at(COMMIT));
    await approve(review, rev, r.id);
    assert.equal((await admitAt(review, bob, r.id, COMMIT)).admitted, true, "a grant on the resource covers its versions");
    const carol = await agent("carol", [{ action: "review.request", project: a }, { action: "attempt.work", project: a }]);
    const c2 = await ask(review, carol, task, at(COMMIT));
    await approve(review, rev, c2.id);
    await refuses("forbidden", () => admitAt(review, carol, c2.id, COMMIT), (e) => assert.match(e.message, /does not give one/));
  });

  suite("card A05b: admissions racing for one approval: only the reviewed version can win, and it wins exactly once", async ({ review, ann, rev, task }) => {
    const r = await ask(review, ann, task, at(COMMIT));
    await approve(review, rev, r.id);
    const tries = [COMMIT, "v2", COMMIT, undefined, COMMIT, `${COMMIT} `.trim().toUpperCase()];
    const outcomes = await Promise.allSettled(tries.map((v) => admitAt(review, ann, r.id, v)));
    const won = outcomes.flatMap((o, i) => (o.status === "fulfilled" ? [tries[i]] : []));
    assert.deepEqual(won, [COMMIT], "one admission, at the reviewed version");
    for (const o of outcomes) if (o.status === "rejected") assert.ok(o.reason instanceof DomainError && o.reason.code === "review_invalid", String(o.reason));
    assert.equal((await review.get(ann, r.id))!.state, "used");
  });

  suite("card A05b: a review stored before versions existed (no version in its binding) is cleared and admitted exactly as before", async ({ review, ann, rev, task }) => {
    const r = await ask(review, ann, task, op());
    await approve(review, rev, r.id);
    const stored = (await review.get(rev, r.id))!;
    assert.deepEqual(Object.keys(stored.binding.target).sort(), ["id", "kind"], "nothing new is written when there is no version");
    assert.deepEqual(Object.keys(stored.operation.target).sort(), ["id", "kind"]);
    const again = await ask(review, ann, task, op());
    assert.deepEqual([again.cleared, again.id], [true, r.id]);
    assert.equal((await review.admit(ann, { commandId: cid("ad"), requestId: r.id, operation: op() })).admitted, true);
  });
}

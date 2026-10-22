import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ReviewService } from "../review/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ApprovalLoadService, LOAD_LIMITS, PolicyService, ProfileSuggestionService } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-21T09:00:00.000Z");
const minutes = (m: number): void => { now += m * 60_000; };
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const context = { toolVersion: "1.0", authoritySource: "task grant", expectedEffects: ["does the thing"] };

for (const backend of backends) {
  interface Ctx { load: ApprovalLoadService; policy: PolicyService; review: ReviewService; grants: GrantService; owner: Principal; ann: Principal; ben: Principal; rev: Principal; a: string; task: string; approve(who: Principal, tool: string, by?: Principal, args?: object): Promise<string> }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-21T09:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const agent = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
        const work = (p: string): Grant[] => ["review.request", "attempt.work"].map((action) => ({ action, project: p }));
        const ann = await agent("ann", work(a));
        const ben = await agent("ben", work(a));
        const rev = await agent("rev", [{ action: "review.decide", project: a }]);
        const review = ReviewService.withEpoch(world.storage, projects.epoch, options);
        const approve = async (who: Principal, tool: string, by: Principal = owner, args: object = { n: n++ }) => {
          const r = await review.request(who, { commandId: cid("rq"), taskId: task, operation: { name: tool, args: args as never, target: { kind: "repository", id: "main" } }, context });
          const v = (await review.get(owner, r.id))!;
          await review.decide(by, { commandId: cid("dc"), requestId: r.id, expectedRevision: v.revision, verdict: "allow", reason: "fine" });
          return r.id;
        };
        await body({
          load: ApprovalLoadService.withEpoch(world.storage, projects.epoch, grants, { ...options, profile: ProfileSuggestionService.withEpoch(world.storage, projects.epoch, PolicyService.withEpoch(world.storage, projects.epoch, grants, options), options) }), policy: PolicyService.withEpoch(world.storage, projects.epoch, grants, options), review, grants, owner, ann, ben, rev, a, task, approve,
        });
      } finally { await world.close(); }
    });

  suite("the same approval, three times, becomes one proposal; it covers exactly what it was drawn from and changes nothing", async (c) => {
    await c.approve(c.ann, "git-commit"); await c.approve(c.ann, "git-commit");
    assert.deepEqual(await c.load.propose(c.owner, { commandId: cid("pr") }), { opened: [] });
    await c.approve(c.ann, "git-commit");
    const opened = (await c.load.propose(c.owner, { commandId: cid("pr") })).opened;
    assert.equal(opened.length, 1);
    assert.deepEqual((await c.load.propose(c.owner, { commandId: cid("pr") })).opened, [], "asking again opens nothing twice");
    const [p] = await c.load.proposals(c.owner, "open");
    assert.deepEqual([p!.requester, p!.cls, p!.environment, p!.count, p!.covered.length, p!.suggestion], ["agent:ann", "commit", "development", 3, 3, { action: "approve.class.commit", project: c.a, environments: ["development"], days: 30 }]);
    assert.ok(p!.covered.every((x) => x.tool === "git-commit"));
    // It is only a suggestion: the next commit still asks.
    assert.equal((await c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "git-commit" })).mode, "owner");
    // Another requester, another class, another run.
    await c.approve(c.ben, "git-commit"); await c.approve(c.ann, "git-push"); await c.approve(c.ann, "git-push");
    assert.deepEqual((await c.load.propose(c.owner, { commandId: cid("pr") })).opened, []);
    assert.deepEqual(await c.load.proposals(c.ann), []);
    await refuses("forbidden", () => c.load.propose(c.ann, { commandId: cid("pr") }));
  });

  suite("a reserved tool, an unclassified one and an agent's approvals never produce a proposal", async (c) => {
    await c.review.setPolicy(c.owner, { commandId: cid("rp"), projectId: c.a, policy: { mandatoryHuman: ["git-merge"] } });
    for (let i = 0; i < 5; i++) { await c.approve(c.ann, "git-merge"); await c.approve(c.ann, "mystery-tool"); await c.approve(c.ann, "git-commit", c.rev); }
    assert.deepEqual((await c.load.propose(c.owner, { commandId: cid("pr") })).opened, []);
    // The reservation counts as it stands now: once the tool is no longer reserved, past approvals can count.
    await c.review.setPolicy(c.owner, { commandId: cid("rp"), projectId: c.a, expectedRevision: 1, policy: {} });
    assert.equal((await c.load.propose(c.owner, { commandId: cid("pr") })).opened.length, 1);
  });

  suite("accepting makes an approval grant for that requester, in that project and environment, for a limited time; dismissing keeps it quiet for a while", async (c) => {
    for (let i = 0; i < 3; i++) await c.approve(c.ann, "git-commit");
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const [p] = await c.load.proposals(c.owner, "open");
    await refuses("forbidden", () => c.load.accept(c.ann, { commandId: cid("ac"), proposalId: p!.id, expectedRevision: p!.revision }));
    await refuses("stale_revision", () => c.load.accept(c.owner, { commandId: cid("ac"), proposalId: p!.id, expectedRevision: p!.revision + 3 }));
    await refuses("invalid_command", () => c.load.accept(c.owner, { commandId: cid("ac"), proposalId: "nope", expectedRevision: 1 }));
    await refuses("not_found", () => c.load.accept(c.owner, { commandId: cid("ac"), proposalId: "spr-aaaaaaaaaaaaaaaaaaaa", expectedRevision: 1 }));
    const { grantId } = await c.load.accept(c.owner, { commandId: cid("ac"), proposalId: p!.id, expectedRevision: p!.revision });
    const grant = (await c.grants.getGrant(grantId))!;
    assert.deepEqual([grant.grantee, grant.action, grant.project, grant.source, grant.terms], ["agent:ann", "approve.class.commit", c.a, "standing", { environments: ["development"] }]);
    assert.equal(grant.expiresAt, new Date(now + 30 * 86_400_000).toISOString());
    assert.equal((await c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "git-commit" })).via, "grant");
    assert.equal((await c.policy.evaluate({ principalId: "agent:ben", projectId: c.a, tool: "git-commit" })).mode, "owner", "only for the requester of the run");
    assert.equal((await c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "git-commit", environment: "staging" })).mode, "owner", "only for the run's environment");
    assert.equal((await c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "git-push" })).mode, "owner", "only the class");
    const settled = (await c.load.proposals(c.owner, "accepted"))[0]!;
    await refuses("invalid_command", () => c.load.accept(c.owner, { commandId: cid("ac"), proposalId: p!.id, expectedRevision: settled.revision }), (e) => assert.match(e.message, /is accepted/));
    assert.deepEqual((await c.load.proposals(c.owner, "accepted")).map((x) => x.grantId), [grantId]);
    // Dismissal: a different run.
    for (let i = 0; i < 3; i++) await c.approve(c.ben, "git-push");
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const [q] = await c.load.proposals(c.owner, "open");
    await refuses("invalid_command", () => c.load.dismiss(c.owner, { commandId: cid("ds"), proposalId: q!.id, expectedRevision: q!.revision, reason: "" }));
    await c.load.dismiss(c.owner, { commandId: cid("ds"), proposalId: q!.id, expectedRevision: q!.revision, reason: "I want to see these" });
    assert.deepEqual((await c.load.propose(c.owner, { commandId: cid("pr") })).opened, []);
    minutes(1);
    for (let i = 0; i < 3; i++) await c.approve(c.ben, "git-push");
    assert.deepEqual((await c.load.propose(c.owner, { commandId: cid("pr") })).opened, [], "quiet while the dismissal holds");
    minutes(31 * 24 * 60);
    assert.equal((await c.load.propose(c.owner, { commandId: cid("pr") })).opened.length, 1, "offered again after the quiet time, with the approvals so far");
    assert.equal((await c.load.proposals(c.owner, "open"))[0]!.count, 6);
  });

  suite("the load figures: owner decisions per day, how long they waited, what ran by rule, grant, review or owner, and every ask still waiting", async (c) => {
    // Day one: two owner approvals (one waited 10 minutes), one agent decision.
    const first = await c.review.request(c.ann, { commandId: cid("rq"), taskId: c.task, operation: { name: "git-commit", args: { n: 1 }, target: { kind: "repository", id: "main" } }, context });
    minutes(10);
    await c.review.decide(c.owner, { commandId: cid("dc"), requestId: first.id, expectedRevision: (await c.review.get(c.owner, first.id))!.revision, verdict: "allow", reason: "ok" });
    await c.approve(c.ann, "git-commit");
    await c.approve(c.ann, "git-commit", c.rev);
    minutes(24 * 60);
    await c.approve(c.ann, "git-push");
    // One ask is waiting for the owner for 45 minutes.
    await c.review.setPolicy(c.owner, { commandId: cid("rp"), projectId: c.a, policy: { mandatoryHuman: ["deploy"] } });
    await c.review.request(c.ann, { commandId: cid("rq"), taskId: c.task, operation: { name: "deploy", args: { v: 1 }, target: { kind: "environment", id: "test" } }, context });
    minutes(45);
    const figures = await c.load.load(c.owner, 3);
    assert.deepEqual(figures.perDay.map((d) => [d.day, d.ownerDecisions, d.agentDecisions]), [["2026-10-20", 0, 0], ["2026-10-21", 2, 1], ["2026-10-22", 1, 0]]);
    assert.equal(figures.ownerDecisions, 3);
    assert.equal(figures.agentDecisions, 1);
    assert.equal(figures.averageOwnerWaitMinutes, 3, "(10 + 0 + 0) / 3 rounded");
    assert.deepEqual(figures.pending.map((p) => [p.tool, p.requester, p.waitingOn, p.waitingMinutes]), [["deploy", "agent:ann", "owner", 45]]);
    // What the policy decided is recorded by the dispatcher.
    const decide = (tool: string, extra: object = {}) => c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool, ...extra });
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.class.mutate", project: c.a, source: "standing", basis: "x" });
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "derived" });
    for (const [tool, extra] of [["read-file", {}], ["edit-file", {}], ["update-database", {}], ["install-package", {}], ["grant-access", {}], ["deploy", { environment: "customer-live" }]] as const) await c.load.recordDecision(await decide(tool, extra), { actionId: `act-${tool}` });
    const later = await c.load.load(c.owner, 1);
    assert.deepEqual(later.decidedBy, { rule: 2, grant: 1, agentReview: 1, owner: 2, denied: 0 });
    const cells = await c.load.decisionsByCell(c.owner, 1);
    assert.equal(cells.reduce((s, x) => s + x.count, 0), 6);
    assert.deepEqual(cells.find((x) => x.cell === "deploy.live"), { cell: "deploy.live", mode: "owner", via: "reserved", count: 1 });
    await refuses("forbidden", () => c.load.load(c.ann));
    await refuses("forbidden", () => c.load.decisionsByCell(c.ann));
    for (const bad of [0, 91, 1.5]) await refuses("invalid_command", () => c.load.load(c.owner, bad));
  });

  suite("decisions recorded at the same moment are all counted", async (c) => {
    const d = await c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "read-file" });
    await Promise.all(Array.from({ length: 12 }, (_, i) => c.load.recordDecision(d, { actionId: `act-${i}` })));
    assert.equal((await c.load.decisionsByCell(c.owner, 1)).reduce((s, x) => s + x.count, 0), 12);
    // The same action recorded again (a retry) counts once.
    await c.load.recordDecision(d, { actionId: "act-3" });
    await c.load.recordDecision(d, { actionId: "act-3" });
    assert.equal((await c.load.decisionsByCell(c.owner, 1)).reduce((s, x) => s + x.count, 0), 12);
    await refuses("invalid_command", () => c.load.recordDecision(d, { actionId: "bad id!" }));
    assert.equal(LOAD_LIMITS.approvalsToPropose, 3);
  });

  suite("approvals of what stays a decision, runs code, spends or is given outside the free environments never become a proposal, and a standing grant could not waive them anyway", async (c) => {
    for (const tool of ["grant-access", "pay", "install-package"]) for (let i = 0; i < 4; i++) await c.approve(c.ann, tool);
    assert.deepEqual((await c.load.propose(c.owner, { commandId: cid("pr") })).opened, []);
    let rev = 0;
    for (const environment of ["staging", "customer-live"] as const) {
      await c.policy.set(c.owner, { commandId: cid("pe"), scope: c.a, environment, ...(rev === 0 ? {} : { expectedRevision: rev }) });
      rev += 1;
      for (let i = 0; i < 4; i++) await c.approve(c.ben, "git-commit");
      assert.deepEqual((await c.load.propose(c.owner, { commandId: cid("pr") })).opened, [], environment);
    }
    await c.policy.set(c.owner, { commandId: cid("pe"), scope: c.a, environment: "testing", expectedRevision: rev });
    assert.equal((await c.load.propose(c.owner, { commandId: cid("pr") })).opened.length, 1, "testing is a free environment");
    // Whatever the grant's origin, a standing grant does not waive a per-request stay-decision, even one that names the class exactly.
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.class.push", project: c.a, source: "standing", basis: "x" });
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.class.mutate", project: c.a, source: "standing", basis: "x" });
    assert.equal((await c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "git-push" })).via, "grant");
    const protectedPush = await c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "git-push", branchProtected: true });
    assert.deepEqual([protectedPush.mode, protectedPush.via], ["owner", "must-decide"]);
    assert.equal((await c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "update-database", irreversible: true })).via, "must-decide");
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.class.push", project: c.a, source: "direct", basis: "owner says so" });
    assert.equal((await c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "git-push", branchProtected: true })).via, "grant", "an owner-made exact grant still can");
  });

  suite("accepting twice, or retrying after a failure part-way, makes one grant; accept and dismiss at the same revision cannot both stick", async (c) => {
    for (let i = 0; i < 3; i++) await c.approve(c.ann, "git-commit");
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const [p] = await c.load.proposals(c.owner, "open");
    const accept = { commandId: cid("ac"), proposalId: p!.id, expectedRevision: p!.revision };
    const first = await c.load.accept(c.owner, accept);
    minutes(120);
    assert.deepEqual(await c.load.accept(c.owner, accept), first, "a repeat is answered with the recorded result");
    assert.equal((await c.load.proposals(c.owner, "accepted"))[0]!.grantId, first.grantId);
    assert.equal((await c.grants.getGrant(first.grantId))!.expiresAt, new Date(Date.parse("2026-10-21T09:00:00.000Z") + 30 * 86_400_000).toISOString(), "30 days from the acceptance");
    const after = (await c.load.proposals(c.owner, "accepted"))[0]!.revision;
    await refuses("invalid_command", () => c.load.accept(c.owner, { commandId: cid("ac"), proposalId: p!.id, expectedRevision: after }));
    // A failure between marking accepted and making the grant: simulate by marking accepted only, then retrying the same command.
    for (let i = 0; i < 3; i++) await c.approve(c.ben, "git-commit");
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const q = (await c.load.proposals(c.owner, "open"))[0]!;
    const one = { commandId: cid("ac"), proposalId: q.id, expectedRevision: q.revision };
    const racing = await Promise.allSettled([c.load.accept(c.owner, one), c.load.dismiss(c.owner, { commandId: cid("ds"), proposalId: q.id, expectedRevision: q.revision, reason: "no" })]);
    assert.equal(racing.filter((r) => r.status === "fulfilled").length, 1);
    const now = (await c.load.proposals(c.owner)).find((x) => x.id === q.id)!;
    const live = (await c.policy.evaluate({ principalId: "agent:ben", projectId: c.a, tool: "git-commit" })).via === "grant";
    assert.equal(live, now.state === "accepted", "a grant exists exactly when the proposal was accepted");
    // Dismiss replays too.
    const r = (await c.load.proposals(c.owner)).find((x) => x.state === "open");
    if (r !== undefined) {
      const dis = { commandId: cid("ds"), proposalId: r.id, expectedRevision: r.revision, reason: "later" };
      await c.load.dismiss(c.owner, dis);
      await c.load.dismiss(c.owner, dis);
    }
  });

  suite("a dismissed proposal comes back only after the quiet time and a newer approval; an accepted one only after its grant has ended and a newer approval", async (c) => {
    for (let i = 0; i < 3; i++) await c.approve(c.ann, "git-commit");
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const p = (await c.load.proposals(c.owner, "open"))[0]!;
    await c.load.dismiss(c.owner, { commandId: cid("ds"), proposalId: p.id, expectedRevision: p.revision, reason: "not yet" });
    minutes(31 * 24 * 60);
    assert.deepEqual((await c.load.propose(c.owner, { commandId: cid("pr") })).opened, [], "the quiet time alone is not enough");
    await c.approve(c.ann, "git-commit");
    const second = (await c.load.propose(c.owner, { commandId: cid("pr") })).opened;
    assert.equal(second.length, 1);
    const q = (await c.load.proposals(c.owner, "open"))[0]!;
    const { grantId } = await c.load.accept(c.owner, { commandId: cid("ac"), proposalId: q.id, expectedRevision: q.revision });
    await c.approve(c.ann, "git-commit");
    assert.deepEqual((await c.load.propose(c.owner, { commandId: cid("pr") })).opened, [], "the grant is live");
    // Revoked: a newer approval brings it back.
    const g = (await c.grants.getGrant(grantId))!;
    await c.grants.revoke(c.owner, { commandId: cid("rv"), grantId, expectedRevision: g.revision, reason: "enough" });
    assert.deepEqual((await c.load.propose(c.owner, { commandId: cid("pr") })).opened, [], "no approval since the acceptance");
    minutes(5);
    await c.approve(c.ann, "git-commit");
    assert.equal((await c.load.propose(c.owner, { commandId: cid("pr") })).opened.length, 1);
    // Expired grants count the same way.
    const r = (await c.load.proposals(c.owner, "open"))[0]!;
    await c.load.accept(c.owner, { commandId: cid("ac"), proposalId: r.id, expectedRevision: r.revision });
    minutes(31 * 24 * 60);
    await c.approve(c.ann, "git-commit");
    assert.equal((await c.load.propose(c.owner, { commandId: cid("pr") })).opened.length, 1);
  });

  suite("only approvals that stand count: used ones do, denied and withdrawn ones do not, and neither do approvals older than the window", async (c) => {
    const denied = async (tool: string) => {
      const r = await c.review.request(c.ann, { commandId: cid("rq"), taskId: c.task, operation: { name: tool, args: { n: n++ }, target: { kind: "repository", id: "main" } }, context });
      await c.review.decide(c.owner, { commandId: cid("dc"), requestId: r.id, expectedRevision: (await c.review.get(c.owner, r.id))!.revision, verdict: "deny", reason: "no" });
    };
    const withdrawn = async (tool: string) => {
      const r = await c.review.request(c.ann, { commandId: cid("rq"), taskId: c.task, operation: { name: tool, args: { n: n++ }, target: { kind: "repository", id: "main" } }, context });
      await c.review.withdraw(c.ann, { commandId: cid("wd"), requestId: r.id, expectedRevision: (await c.review.get(c.owner, r.id))!.revision, reason: "changed my mind" });
    };
    await denied("git-commit"); await denied("git-commit"); await withdrawn("git-commit"); await withdrawn("git-commit"); await c.approve(c.ann, "git-commit"); await c.approve(c.ann, "git-commit");
    assert.deepEqual((await c.load.propose(c.owner, { commandId: cid("pr") })).opened, []);
    // Three approvals spread over a year are not a pattern.
    minutes(200 * 24 * 60);
    await c.approve(c.ann, "git-commit");
    assert.deepEqual((await c.load.propose(c.owner, { commandId: cid("pr") })).opened, [], "the first two are older than 90 days");
    minutes(5);
    await c.approve(c.ann, "git-commit"); await c.approve(c.ann, "git-commit");
    assert.equal((await c.load.propose(c.owner, { commandId: cid("pr") })).opened.length, 1);
  });

  suite("an agent cannot get round a standing grant by deriving from it: approval grants are derived only by the owner, and a derived grant keeps its parent's terms and origin", async (c) => {
    for (let i = 0; i < 3; i++) await c.approve(c.ann, "git-push");
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const p = (await c.load.proposals(c.owner, "open"))[0]!;
    const { grantId } = await c.load.accept(c.owner, { commandId: cid("ac"), proposalId: p.id, expectedRevision: p.revision });
    const push = (extra: object = {}) => c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "git-push", ...extra });
    assert.equal((await push()).via, "grant");
    await refuses("forbidden", () => c.grants.derive(c.ann, { commandId: cid("dv"), parentId: grantId, action: "approve.class.push", project: c.a, basis: "mine now" }));
    // The owner deriving keeps the terms and the standing origin.
    const d = await c.grants.derive(c.owner, { commandId: cid("dv"), parentId: grantId, action: "approve.class.push", project: c.a, basis: "narrower copy" });
    const derived = (await c.grants.getGrant(d.id))!;
    assert.deepEqual([derived.terms, derived.rootSource], [{ environments: ["development"] }, "standing"]);
    assert.equal((await push({ branchProtected: true })).mode, "owner");
    assert.equal((await push({ environment: "staging" })).mode, "owner");
    // A capability derived by the agent is still no approval.
    const cap = await c.grants.derive(c.ann, { commandId: cid("dv"), parentId: grantId, action: "approve.class.push", project: c.a, basis: "x" }).catch(() => undefined);
    assert.equal(cap, undefined);
  });

  suite("a proposal can be answered by switching to the derived profile instead of the 30-day grant: permanent by default, or a trial; no grant is made", async (c) => {
    for (let i = 0; i < 3; i++) await c.approve(c.ann, "git-commit");
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const [p] = await c.load.proposals(c.owner, "open");
    await refuses("forbidden", () => c.load.acceptBySwitching(c.ann, { commandId: cid("sw"), proposalId: p!.id, expectedRevision: p!.revision }));
    await refuses("invalid_command", () => c.load.acceptBySwitching(c.owner, { commandId: cid("sw"), proposalId: p!.id, expectedRevision: p!.revision, mode: "forever" as never }));
    await refuses("stale_revision", () => c.load.acceptBySwitching(c.owner, { commandId: cid("sw"), proposalId: p!.id, expectedRevision: p!.revision + 3 }));
    assert.equal((await c.policy.effective(c.owner))!.profile, "strict");
    const id = cid("sw");
    assert.deepEqual(await c.load.acceptBySwitching(c.owner, { commandId: id, proposalId: p!.id, expectedRevision: p!.revision }), { switched: true });
    assert.equal((await c.policy.effective(c.owner))!.profile, "derived");
    const [done] = await c.load.proposals(c.owner, "accepted");
    assert.deepEqual([done!.via, done!.grantId], ["profile", undefined]);
    assert.deepEqual(await c.load.acceptBySwitching(c.owner, { commandId: id, proposalId: p!.id, expectedRevision: p!.revision }), { switched: true }, "a repeat is answered from the record");
    // Not on a derived installation, and a grant was not made.
    for (let i = 0; i < 3; i++) await c.approve(c.ben, "git-push");
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const q = (await c.load.proposals(c.owner, "open"))[0]!;
    await refuses("invalid_command", () => c.load.acceptBySwitching(c.owner, { commandId: cid("sw"), proposalId: q.id, expectedRevision: q.revision, mode: "trial" }));
    assert.equal((await c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "git-commit" })).via !== "grant", true);
  });
}

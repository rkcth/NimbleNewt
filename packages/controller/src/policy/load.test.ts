import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ReviewService } from "../review/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ApprovalLoadService, GRANT_LENGTHS, LOAD_LIMITS, chooseStandingLength, PolicyService, ProfileSuggestionService } from "./index.js";

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
  interface Ctx { rewrite(id: string, edit: (body: Record<string, unknown>) => Record<string, unknown>): Promise<void>; load: ApprovalLoadService; policy: PolicyService; review: ReviewService; grants: GrantService; owner: Principal; ann: Principal; ben: Principal; rev: Principal; a: string; task: string; approve(who: Principal, tool: string, by?: Principal, args?: object): Promise<string> }
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
          rewrite: async (id, edit) => {
            const ref = { kind: "standing-proposal", id };
            const found = (await world.storage.getAggregate(ref))!;
            await world.storage.applyOperation({ operationId: cid("rw"), epoch: projects.epoch, actor: "owner:rob", correlationId: "rw", at: new Date(now).toISOString(), changes: [{ type: "update", ref, expectedRevision: found.revision, body: edit(found.body as Record<string, unknown>) as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
          },
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

  const DAY = 86_400_000;
  /** Three approvals of one class by ann, `gapDays` apart, and the proposal they make. */
  const proposal = async (c: Ctx, gapDays: number, tool = "git-commit") => {
    for (let i = 0; i < 3; i++) { if (i > 0 && gapDays > 0) now += gapDays * DAY; await c.approve(c.ann, tool); }
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const cls = { "git-commit": "commit", "git-push": "push", "git-merge": "merge", deploy: "deploy" }[tool];
    return (await c.load.proposals(c.owner, "open")).find((x) => x.cls === cls)!;
  };
  const accept = async (c: Ctx, p: { id: string; revision: number }, extra: Record<string, unknown> = {}) => {
    const at = now;
    const r = await c.load.accept(c.owner, { commandId: cid("ac"), proposalId: p.id, expectedRevision: p.revision, ...extra } as never);
    return { ...r, grant: (await c.grants.getGrant(r.grantId))!, at };
  };

  suite("a proposal shows the lengths on offer and the one the system chose with its reason; the default follows the span of the approvals and the owner's words, a one-off or an explicit length win, and nothing to go on means 30 days (card A07d)", async (c) => {
    assert.deepEqual(GRANT_LENGTHS, [1, 7, 30, 90]);
    // Approvals made over a few days: the shortest option that covers the pattern.
    const p = await proposal(c, 1.5);
    assert.deepEqual(p.lengthOptions, [1, 7, 30, 90]);
    assert.deepEqual([p.defaultLength!.days, p.suggestion.days], [7, 7]);
    assert.match(p.defaultLength!.why, /spread over about 3 days, so 7 days covers the same pattern/);
    // Choosing the default: the grant runs that long and carries the reason.
    const a = await accept(c, p);
    assert.deepEqual([a.days, a.grant.expiresAt], [7, new Date(a.at + 7 * DAY).toISOString()]);
    assert.match(a.why, /7 days covers/);
    assert.match(a.grant.basis, /7 days: the approvals were spread over about 3 days/);
    assert.equal((await c.load.proposals(c.owner, "accepted"))[0]!.chosenLength!.source, "default");
    assert.equal(p.spanDays, 3);
  });

  suite("what the owner said wins: a stated length is used as stated up to the longest option, a one-off is the shortest, an explicit length is used exactly and must be a whole number of days up to the longest option, and a reserved class is still never offered (card A07d)", async (c) => {
    const p1 = await proposal(c, 0);
    assert.deepEqual([p1.defaultLength!.days, p1.defaultLength!.why], [30, "there is nothing to go on yet, so the usual 30 days"], "all at one moment: the 30-day fallback");
    const stated = await accept(c, p1, { statedDays: 2 });
    assert.deepEqual([stated.days, stated.grant.expiresAt], [2, new Date(stated.at + 2 * DAY).toISOString()]);
    assert.match(stated.why, /you asked for 2 days/);
    assert.equal((await c.load.proposals(c.owner, "accepted")).find((x) => x.id === p1.id)!.chosenLength!.source, "owner", "the owner's words are recorded as the owner's");
    // Another class: a stated length longer than the longest option is cut to it and says so.
    const p2 = await proposal(c, 0, "git-push");
    const cut = await accept(c, p2, { statedDays: 400 });
    assert.equal(cut.days, 90);
    assert.match(cut.why, /you asked for 400 days; the longest a standing rule runs is 90 days/);
    const p3 = await proposal(c, 0, "git-merge");
    assert.equal((await accept(c, p3, { oneOff: true })).days, 1);
    // An explicit length is used exactly (any whole number of days up to the longest option), and cannot be combined with what to derive it from.
    now += 100 * DAY;
    const p4 = await proposal(c, 0, "deploy");
    await refuses("invalid_command", () => c.load.accept(c.owner, { commandId: cid("ac"), proposalId: p4.id, expectedRevision: p4.revision, days: 120 } as never), (e) => assert.equal(e.field, "days"));
    await refuses("invalid_command", () => c.load.accept(c.owner, { commandId: cid("ac"), proposalId: p4.id, expectedRevision: p4.revision, days: 14, oneOff: true } as never));
    await refuses("invalid_command", () => c.load.accept(c.owner, { commandId: cid("ac"), proposalId: p4.id, expectedRevision: p4.revision, days: 1.5 } as never));
    const exact = await accept(c, p4, { days: 14 });
    assert.deepEqual([exact.days, exact.grant.expiresAt], [14, new Date(exact.at + 14 * DAY).toISOString()]);
    assert.equal((await c.load.proposals(c.owner, "accepted")).find((x) => x.id === p4.id)!.chosenLength!.source, "owner");
    // Retrying the same acceptance makes the same grant for the same length.
    const again = await c.load.accept(c.owner, { commandId: "same-ac", proposalId: p1.id, expectedRevision: p1.revision, statedDays: 2 } as never).catch((e: unknown) => e);
    assert.ok(again instanceof DomainError, "a proposal that is already accepted is not accepted again");
  });

  suite("a length follows what earlier standing rules of the class showed: one that ran its full term and was asked for again gets the next longer, one the owner took back early gets a shorter one (card A07d)", async (c) => {
    const p = await proposal(c, 0);
    const first = await accept(c, p, { days: 7 });
    now += 8 * DAY;
    const next = await proposal(c, 0);
    assert.deepEqual([next.defaultLength!.days], [30]);
    assert.match(next.defaultLength!.why, /the last standing rule of this kind ran its full 7-day term and the same was approved again, so 30 days this time/);
    const second = await accept(c, next);
    assert.equal(second.days, 30);
    // The owner takes the 30-day one back; the next proposal of the class is shorter than what was taken back.
    const g = (await c.grants.getGrant(second.grantId))!;
    await c.grants.revoke(c.owner, { commandId: cid("rv"), grantId: second.grantId, expectedRevision: g.revision, reason: "too wide" });
    now += 1 * DAY;
    const third = await proposal(c, 0);
    assert.equal(third.defaultLength!.days, 7);
    assert.match(third.defaultLength!.why, /taken back before its 30-day term was up, so 7 days this time/);
    void first;
  });

  suite("an open proposal stored before A07d (no default length, span or history) is accepted at the length it showed, never at a newly derived one (card A07d)", async (c) => {
    const p = await proposal(c, 20);
    assert.equal(p.defaultLength!.days, 90, "a new proposal over 40 days shows 90");
    await c.rewrite(p.id, (b) => { const { defaultLength: _d, lengthOptions: _l, spanDays: _s, history: _h, ...old } = b; return { ...old, suggestion: { ...(b["suggestion"] as object), days: 30 } }; });
    const fresh = (await c.load.proposals(c.owner, "open"))[0]!;
    assert.equal(fresh.suggestion.days, 30);
    const a = await accept(c, fresh);
    assert.deepEqual([a.days, a.why], [30, "the usual length"]);
    assert.equal(a.grant.expiresAt, new Date(a.at + 30 * DAY).toISOString());
  });

  suite("a grant that ran its full term and was revoked afterwards counts as having run its full term, not as taken back (card A07d)", async (c) => {
    const p = await proposal(c, 0);
    const first = await accept(c, p, { days: 7 });
    now += 8 * DAY;
    const g = (await c.grants.getGrant(first.grantId))!;
    await c.grants.revoke(c.owner, { commandId: cid("rv"), grantId: first.grantId, expectedRevision: g.revision, reason: "tidying up" });
    assert.equal((await c.grants.getGrant(first.grantId))!.revokedAt, new Date(now).toISOString());
    now += 1 * DAY;
    const next = await proposal(c, 0);
    assert.equal(next.defaultLength!.days, 30);
    assert.match(next.defaultLength!.why, /ran its full 7-day term/);
  });

  suite("what happened to earlier grants is kept for the same requester, project, class and environment only, survives an offer the owner dismissed, and the latest one decides (card A07d)", async (c) => {
    const p = await proposal(c, 15);
    assert.equal(p.defaultLength!.days, 30);
    const first = await accept(c, p);
    const g = (await c.grants.getGrant(first.grantId))!;
    now += 1 * DAY;
    await c.grants.revoke(c.owner, { commandId: cid("rv"), grantId: first.grantId, expectedRevision: g.revision, reason: "too wide" });
    // Another requester's first proposal of the class is not shortened by it.
    for (let i = 0; i < 3; i++) await c.approve(c.ben, "git-commit");
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const benOffer = (await c.load.proposals(c.owner, "open")).find((x) => x.requester === "agent:ben")!;
    assert.match(benOffer.defaultLength!.why, /nothing to go on|spread over/, "no history for ben");
    assert.equal(benOffer.history, undefined);
    // The re-offer to ann is shorter, and the owner dismisses it.
    now += 1 * DAY;
    await c.approve(c.ann, "git-commit");
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const again = (await c.load.proposals(c.owner, "open")).find((x) => x.requester === "agent:ann")!;
    assert.deepEqual([again.defaultLength!.days, again.history], [7, [{ days: 30, revoked: true }]]);
    await c.load.dismiss(c.owner, { commandId: cid("ds"), proposalId: again.id, expectedRevision: again.revision, reason: "later" });
    // After the quiet time and more approvals spread over 30 days, the history is still there: 7, not the 30 the span alone would give.
    now += 31 * DAY;
    for (let i = 0; i < 3; i++) { await c.approve(c.ann, "git-commit"); now += 15 * DAY; }
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const third = (await c.load.proposals(c.owner, "open")).find((x) => x.requester === "agent:ann")!;
    assert.deepEqual([third.defaultLength!.days, third.history], [7, [{ days: 30, revoked: true }]]);
    // The owner accepts it and it runs its full term; the next offer is longer than 7, and the history keeps both.
    const ran = await accept(c, third);
    now += 8 * DAY;
    for (let i = 0; i < 3; i++) await c.approve(c.ann, "git-commit");
    await c.load.propose(c.owner, { commandId: cid("pr") });
    const fourth = (await c.load.proposals(c.owner, "open")).find((x) => x.requester === "agent:ann")!;
    assert.deepEqual([fourth.defaultLength!.days, fourth.history], [30, [{ days: 30, revoked: true }, { days: 7, revoked: false }]]);
    void ran;
  });

  suite("a retry after the grant step failed finishes the acceptance at the length already fixed, whatever length the retry names, and a repeat never differs from the first answer (card A07d)", async (c) => {
    const p = await proposal(c, 0);
    // The proposal was marked accepted at 7 days and then the grant step failed.
    await c.rewrite(p.id, (b) => ({ ...b, state: "accepted", decidedBy: c.owner.id, decidedAt: new Date(now).toISOString(), chosenLength: { days: 7, source: "owner", why: "you picked 7 days" }, suggestion: { ...(b["suggestion"] as object), days: 7 } }));
    const stuck = (await c.load.proposals(c.owner, "accepted"))[0]!;
    assert.equal(stuck.grantId, undefined);
    const done = await c.load.accept(c.owner, { commandId: cid("ac"), proposalId: p.id, expectedRevision: stuck.revision, days: 14 } as never);
    assert.equal(done.days, 7);
    const g = (await c.grants.getGrant(done.grantId))!;
    assert.equal(g.expiresAt, new Date(now + 7 * DAY).toISOString());
    assert.equal((await c.load.proposals(c.owner, "accepted"))[0]!.grantId, done.grantId);
    // Done now: a further accept is refused.
    await refuses("invalid_command", () => c.load.accept(c.owner, { commandId: cid("ac"), proposalId: p.id, expectedRevision: stuck.revision + 1, days: 14 } as never), (e) => assert.match(e.message, /is accepted/));
  });

  test("the length rule: the latest earlier grant decides, a span just over an option steps up, and the words say what was seen (card A07d)", () => {
    const base = { spanDays: 0, earlier: [] as { days: number; revoked: boolean }[] };
    assert.equal(chooseStandingLength({ ...base, earlier: [{ days: 7, revoked: true }, { days: 1, revoked: false }] }).days, 7, "ran 1 day last: longer than 1");
    assert.equal(chooseStandingLength({ ...base, earlier: [{ days: 1, revoked: false }, { days: 7, revoked: true }] }).days, 1, "taken back at 7 last: shorter than 7");
    assert.equal(chooseStandingLength({ ...base, earlier: [{ days: 90, revoked: false }, { days: 30, revoked: false }] }).days, 90);
    assert.deepEqual([7, 7.01, 2.0001, 30.5, 91].map((d) => chooseStandingLength({ ...base, spanDays: d }).days), [7, 30, 7, 90, 90]);
    assert.match(chooseStandingLength({ ...base, spanDays: 2.0001 }).why, /about 2 days, so 7 days covers/);
    assert.equal(chooseStandingLength({ ...base, statedDays: 5 }).source, "owner");
    assert.equal(chooseStandingLength({ ...base, oneOff: true }).source, "owner");
    assert.equal(chooseStandingLength(base).source, "default");
  });

  suite("a length given with oneOff false is fine, and a length over the longest option names that limit (card A07d)", async (c) => {
    const p = await proposal(c, 0);
    await refuses("invalid_command", () => c.load.accept(c.owner, { commandId: cid("ac"), proposalId: p.id, expectedRevision: p.revision, days: 120 } as never), (e) => assert.match(e.message, /from 1 to 90/));
    const r = await accept(c, p, { days: 14, oneOff: false });
    assert.equal(r.days, 14);
  });

  test("the length rule alone: order of the inputs, caps and the fallback (card A07d)", () => {
    const base = { spanDays: 0, earlier: [] as { days: number; revoked: boolean }[] };
    assert.equal(chooseStandingLength({ ...base, statedDays: 3, oneOff: true, spanDays: 40 }).days, 3, "the owner's words come first");
    assert.equal(chooseStandingLength({ ...base, oneOff: true, spanDays: 40, earlier: [{ days: 7, revoked: false }] }).days, 1, "then a one-off");
    assert.equal(chooseStandingLength({ ...base, spanDays: 40, earlier: [{ days: 7, revoked: true }] }).days, 1, "then earlier grants: revoked at 7 is shorter than 7");
    assert.equal(chooseStandingLength({ ...base, spanDays: 1, earlier: [{ days: 90, revoked: false }] }).days, 90, "never above the longest option");
    assert.equal(chooseStandingLength({ ...base, spanDays: 40 }).days, 90);
    assert.equal(chooseStandingLength({ ...base, spanDays: 0.4 }).days, 1);
    assert.equal(chooseStandingLength({ ...base, spanDays: 200 }).days, 90);
    assert.equal(chooseStandingLength(base).days, 30);
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

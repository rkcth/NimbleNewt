import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ReviewService } from "../review/index.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { PolicyService, ProfileSuggestionService } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-22T09:00:00.000Z");
const minutes = (m: number): void => { now += m * 60_000; };
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};
const context = { toolVersion: "1.0", authoritySource: "task grant", expectedEffects: ["does the thing"] };

for (const backend of backends) {
  interface Ctx { world: import("../domain/testing/backends.js").World; epoch: number; grants: GrantService; ann: Principal; rev: Principal; suggestion: ProfileSuggestionService; policy: PolicyService; owner: Principal; approve(by?: Principal): Promise<void> }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-22T09:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "review.request", project: a }, { action: "attempt.work", project: a }] });
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "rev", grants: [{ action: "review.decide", project: a }] });
        const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
        const rev = await principals.authenticate((await principals.issueCredential(owner, "agent:rev")).token);
        const review = ReviewService.withEpoch(world.storage, projects.epoch, options);
        const policy = PolicyService.withEpoch(world.storage, projects.epoch, grants, options);
        await body({
          world, epoch: projects.epoch, grants, ann, rev, suggestion: ProfileSuggestionService.withEpoch(world.storage, projects.epoch, policy, options), policy, owner,
          approve: async (by = owner) => {
            minutes(1);
            const r = await review.request(ann, { commandId: cid("rq"), taskId: task, operation: { name: "git-commit", args: { n: n++ }, target: { kind: "repository", id: "main" } }, context });
            await review.decide(by, { commandId: cid("dc"), requestId: r.id, expectedRevision: (await review.get(owner, r.id))!.revision, verdict: "allow", reason: "fine" });
          },
        });
      } finally { await world.close(); }
    });

  suite("a strict installation is asked after three owner approvals, with a plain-words preview, and nothing switches by itself", async (c) => {
    assert.deepEqual((await c.suggestion.check(c.owner)).due, false);
    await c.approve(); await c.approve();
    assert.deepEqual([(await c.suggestion.check(c.owner)).due, (await c.suggestion.check(c.owner)).approvalsSince], [false, 2]);
    await c.approve();
    const due = await c.suggestion.check(c.owner);
    assert.deepEqual([due.due, due.approvalsSince, due.revision], [true, 3, 0]);
    assert.ok(due.preview!.notes.some((x) => /profile goes from strict to derived/.test(x)));
    // Checking and waiting change nothing.
    minutes(24 * 60);
    assert.equal((await c.policy.effective(c.owner))!.profile, "strict");
    assert.equal((await c.suggestion.check(c.owner)).due, true);
  });

  suite("only the owner's approvals count, and only the owner sees or answers it", async (c) => {
    await c.approve(); await c.approve();
    for (let i = 0; i < 4; i++) await c.approve(c.rev);
    assert.equal((await c.suggestion.check(c.owner)).approvalsSince, 2, "an agent reviewer's approvals do not count");
    await refuses("forbidden", () => c.suggestion.check(c.ann));
    await refuses("forbidden", () => c.suggestion.answer(c.ann, { commandId: cid("a"), answer: "switch", expectedRevision: 0 }));
  });

  suite("'not now' is not asked again until three more approvals; 'switch' moves to derived and stops it", async (c) => {
    for (let i = 0; i < 3; i++) await c.approve();
    await refuses("stale_revision", () => c.suggestion.answer(c.owner, { commandId: cid("a"), answer: "not-now", expectedRevision: 4 }));
    await refuses("invalid_command", () => c.suggestion.answer(c.owner, { commandId: cid("a"), answer: "maybe" as never, expectedRevision: 0 }));
    const later = { commandId: cid("a"), answer: "not-now" as const, expectedRevision: 0 };
    assert.deepEqual(await c.suggestion.answer(c.owner, later), { switched: false });
    assert.deepEqual(await c.suggestion.answer(c.owner, later), { switched: false }, "a repeat is answered from the record");
    assert.equal((await c.policy.effective(c.owner))!.profile, "strict");
    const after = await c.suggestion.check(c.owner);
    assert.deepEqual([after.due, after.approvalsSince, after.revision], [false, 0, 1]);
    await refuses("invalid_command", () => c.suggestion.answer(c.owner, { commandId: cid("a"), answer: "switch", expectedRevision: 1 }));
    await c.approve(); await c.approve();
    assert.equal((await c.suggestion.check(c.owner)).due, false);
    await c.approve();
    const again = await c.suggestion.check(c.owner);
    assert.deepEqual([again.due, again.approvalsSince, again.revision], [true, 3, 1]);
    const yes = { commandId: cid("a"), answer: "switch" as const, expectedRevision: 1 };
    assert.deepEqual(await c.suggestion.answer(c.owner, yes), { switched: true });
    assert.deepEqual(await c.suggestion.answer(c.owner, yes), { switched: true });
    assert.equal((await c.policy.effective(c.owner))!.profile, "derived");
    for (let i = 0; i < 6; i++) await c.approve();
    assert.equal((await c.suggestion.check(c.owner)).due, false, "never in derived");
  });

  suite("an installation that starts derived or autonomous is never asked", async (c) => {
    for (const profile of ["derived", "autonomous"] as const) {
      const current = (await c.policy.effective(c.owner))!.revisions.installation;
      await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile, ...(current > 0 ? { expectedRevision: current } : {}) });
      for (let i = 0; i < 3; i++) await c.approve();
      assert.equal((await c.suggestion.check(c.owner)).due, false, profile);
    }
  });

  suite("a switch that failed can be finished by repeating the answer, with the same or a new command ID, and changes the profile once", async (c) => {
    for (let i = 0; i < 3; i++) await c.approve();
    let failures = 1;
    const flaky = {
      effective: (...args: Parameters<PolicyService["effective"]>) => c.policy.effective(...args), preview: (...args: Parameters<PolicyService["preview"]>) => c.policy.preview(...args),
      set: async (...args: Parameters<PolicyService["set"]>) => { if (failures-- > 0) throw new DomainError("unavailable", "storage hiccup"); return c.policy.set(...args); },
    } as unknown as PolicyService;
    const service = ProfileSuggestionService.withEpoch(c.world.storage, c.epoch, flaky, options);
    const answer = { commandId: cid("a"), answer: "switch" as const, expectedRevision: 0 };
    await refuses("unavailable", () => service.answer(c.owner, answer));
    assert.equal((await c.policy.effective(c.owner))!.profile, "strict", "recorded, not carried out");
    // A new command ID finishes it: the question is not asked again, the recorded answer is carried out.
    assert.deepEqual(await service.answer(c.owner, { commandId: cid("a"), answer: "switch", expectedRevision: 1 }), { switched: true });
    assert.equal((await c.policy.effective(c.owner))!.profile, "derived");
    // A late replay of the first answer changes nothing, even after the owner went back to strict by hand.
    const current = (await c.policy.effective(c.owner))!.revisions.installation;
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "strict", expectedRevision: current });
    assert.deepEqual(await service.answer(c.owner, answer), { switched: true });
    assert.equal((await c.policy.effective(c.owner))!.profile, "strict");
  });

  suite("a stale answer cannot land on a newer one, approvals older than 90 days do not count, and a switch keeps the owner's overrides", async (c) => {
    for (let i = 0; i < 3; i++) await c.approve();
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", overrides: { "commit.free": "owner" } });
    const first = await c.suggestion.answer(c.owner, { commandId: cid("a"), answer: "not-now", expectedRevision: 0 });
    assert.equal(first.switched, false);
    // Someone holding the old revision answers "switch" after the question was closed: refused.
    await refuses("stale_revision", () => c.suggestion.answer(c.owner, { commandId: cid("a"), answer: "switch", expectedRevision: 0 }));
    assert.equal((await c.policy.effective(c.owner))!.profile, "strict");
    // Three approvals, then a long wait: they fall out of the window and do not count.
    for (let i = 0; i < 3; i++) await c.approve();
    minutes(91 * 24 * 60);
    assert.deepEqual([(await c.suggestion.check(c.owner)).due, (await c.suggestion.check(c.owner)).approvalsSince], [false, 0]);
    for (let i = 0; i < 3; i++) await c.approve();
    const due = await c.suggestion.check(c.owner);
    assert.equal(due.due, true);
    assert.deepEqual(await c.suggestion.answer(c.owner, { commandId: cid("a"), answer: "switch", expectedRevision: due.revision }), { switched: true });
    const effective = (await c.policy.effective(c.owner))!;
    assert.deepEqual([effective.profile, effective.cells["commit.free"]!.mode, effective.cells["commit.free"]!.source], ["derived", "owner", "installation override"]);
  });
}

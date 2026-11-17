// Card H12o: whether a code submission is approved (SubmissionService.approvalOf) and the verdict list it is read from. Kept apart from submissions.test.ts so that file's shared harness stays as it was.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { SubmissionService, type SubmissionOptions } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-17T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const T1 = "a".repeat(40), T2 = "b".repeat(40), BASE = "c".repeat(40), PATCH = "d".repeat(40);

interface World { open(extra?: SubmissionOptions): SubmissionService; svc: SubmissionService; agent(name: string, roles: string[]): Promise<Principal>; task: string; raw(kind: string, id: string): Promise<unknown> }

for (const backend of backends) {
  const suite = (name: string, body: (c: World) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
        const roles = new Map<string, string[]>();
        const agent = async (nm: string, held: string[]): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
          const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
          roles.set(p.id, held);
          return p;
        };
        const open = (extra: SubmissionOptions = {}): SubmissionService => SubmissionService.withEpoch(world.storage, projects.epoch, async (id) => roles.get(id) ?? [], { ...options, ...extra });
        await body({ open, svc: open(), agent, task, raw: async (kind, id) => (await world.storage.getAggregate({ kind, id }))?.body });
      } finally { await world.close(); }
    });

  suite("a code submission is approved when its newest review approves it (or no other agent could review it); the verdicts are kept with it and bounded", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const ray = await c.agent("ray", ["reviewer"]);
    const svc = c.open({ reviewersAvailableIn: async () => ["agent:rev", "agent:ray"] });
    const code = await svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    const first = await svc.approvalOf(code.id);
    assert.deepEqual([first?.approved, first?.base, first?.tree, first?.taskId, first?.submittedBy], [false, BASE, T1, c.task, ann.id]);
    assert.match(first?.reason ?? "", /no reviewer has approved/);
    const ok = await svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve" });
    const approved = await svc.approvalOf(code.id);
    assert.deepEqual([approved?.approved, approved?.approvedBy, approved?.reviewId], [true, rev.id, ok.id]);
    // A repeat of the same review adds nothing; a later "changes" takes the approval back, a later approval gives it again.
    await svc.record(rev, { commandId: "h12o-rev-1", taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "changes" });
    await svc.record(rev, { commandId: "h12o-rev-1", taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "changes" });
    const back = await svc.approvalOf(code.id);
    assert.equal(back?.approved, false);
    assert.match(back?.reason ?? "", /says changes/);
    await svc.record(ray, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve" });
    assert.deepEqual([(await svc.approvalOf(code.id))?.approved, (await svc.approvalOf(code.id))?.approvedBy], [true, ray.id]);
    const verdicts = (await c.raw("submission-verdicts", code.id)) as { reviews: unknown[] };
    assert.equal(verdicts.reviews.length, 3, "the repeated review was kept once");
    // Not a code submission, an unknown ID or not an ID at all: nothing to approve.
    assert.equal(await svc.approvalOf(ok.id), undefined);
    assert.equal(await svc.approvalOf("sbm-aaaaaaaaaaaaaaaaaaaa"), undefined);
    assert.equal(await svc.approvalOf("../x"), undefined);
    // A one-agent project: no review is required, and that counts as approved, on the record as such.
    const solo = c.open({ reviewersAvailableIn: async () => [] });
    const alone = await solo.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH });
    assert.deepEqual([(await solo.approvalOf(alone.id))?.approved, (await solo.approvalOf(alone.id))?.approvedBy], [true, "review_disabled_single_agent"]);
    // Where review is required (or the requirement was not judged) and nobody reviewed, it is not approved.
    const plain = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH });
    assert.equal((await c.svc.approvalOf(plain.id))?.approved, false);
    // At most 50 reviews of one submission are kept; the 51st is refused and the verdict list is unchanged.
    for (let i = 0; i < 47; i++) await svc.record(i % 2 === 0 ? rev : ray, { commandId: cid("many"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve" });
    await refuses("unavailable", () => svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "reject" }), /already has 50 reviews/);
    assert.equal(((await c.raw("submission-verdicts", code.id)) as { reviews: unknown[] }).reviews.length, 50);
    assert.equal((await svc.approvalOf(code.id))?.approved, true);
  });

  suite("reviews of one submission recorded at the same moment are all kept (the verdict list is rebuilt, never a reviewer's review refused as a used command ID)", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const ray = await c.agent("ray", ["reviewer"]);
    const svc = c.open({ reviewersAvailableIn: async () => ["agent:rev", "agent:ray"] });
    const code = await svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    // Two services (two controllers' worth) so nothing in one process orders them; the first two create the list at the same moment, the next ones update it at the same moment.
    const other = c.open({ reviewersAvailableIn: async () => ["agent:rev", "agent:ray"] });
    for (let round = 0; round < 3; round++) {
      const made = await Promise.all([
        svc.record(rev, { commandId: cid("a"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "changes" }),
        other.record(ray, { commandId: cid("b"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve" }),
      ]);
      const listed = ((await c.raw("submission-verdicts", code.id)) as { reviews: { id: string }[] }).reviews.map((r) => r.id);
      assert.equal(listed.length, 2 * (round + 1));
      for (const m of made) assert.ok(listed.includes(m.id), `review ${m.id} is in the verdict list`);
    }
  });
}

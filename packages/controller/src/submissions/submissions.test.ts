import assert from "node:assert/strict";
import { after, test } from "node:test";
import { derivedId } from "../domain/ids.js";
import type { JsonObject } from "../storage/types.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { CommandRunner } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import { SubmissionService, type SubmissionBody, type SubmissionOptions } from "./index.js";
import { recordedSubmission, stagedSubmit } from "../work-end/index.js";
/** What the product's host reports when no earlier attempt left changes in the checkout (card Q04, `LocalWorkspaces.stageWork`). */
const NONE_LEFT = { attempts: [], complete: true } as const;

after(stopServer);

const options = { clock: () => "2026-10-30T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const T1 = "a".repeat(40), T2 = "b".repeat(40), BASE = "c".repeat(40), PATCH = "d".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;
const OWN = /^agent:/;
const pass = (boundTo: string) => [{ check: "tests", result: "pass" as const, boundTo }];

for (const backend of backends) {
  const suite = (name: string, body: (c: { open(roles: (id: string, scope: { projectId: string; taskId: string }) => Promise<readonly string[]>, extra?: SubmissionOptions): SubmissionService; other: { task: string }; rawBody(id: string): Promise<unknown>; plant(body: SubmissionBody): Promise<string>; plantOld(by: Principal, commandId: string, body: SubmissionBody): Promise<string>; projects: { task: string; other: string }; svc: SubmissionService; roles: Map<string, string[]>; agent(name: string, roles: string[], granted?: boolean): Promise<Principal>; owner: Principal; task: string }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
        const project2 = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Q" })).id;
        const task2 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project2, title: "T2" })).id;
        const roles = new Map<string, string[]>();
        const agent = async (nm: string, held: string[], granted = true): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: granted ? [{ action: "task.read", project }, { action: "task.read", project: project2 }] : [] });
          const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
          roles.set(p.id, held);
          return p;
        };
        const svc = SubmissionService.withEpoch(world.storage, projects.epoch, async (id) => roles.get(id) ?? [], options);
        await body({ svc, roles, agent, owner, task, other: { task: task2 }, projects: { task: project, other: project2 }, plant: async (b) => { const id = derivedId("sbm", `plant-${cid("x")}`); await new CommandRunner(world.storage, projects.epoch, options).command("submission.record", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { ...(b as unknown as JsonObject), submittedAt: null, plant: id }, build: async () => { const ref = { kind: "submission", id }; return { ref, creates: true, changes: [{ type: "create" as const, ref, body: b as unknown as JsonObject }], detail: {} }; } })); return id; }, plantOld: async (by, commandId, b) => { const scoped = scopedCommandId(by.id, commandId); const id = derivedId("sbm", scoped); /* exactly what record() stored before card Q01b's attemptId: the body, compared with the time left out */ await new CommandRunner(world.storage, projects.epoch, options).command("submission.record", { commandId: scoped, actor: by.id }, async () => ({ payload: { ...(b as unknown as JsonObject), submittedAt: null }, build: async () => { const ref = { kind: "submission", id }; return { ref, creates: true, changes: [{ type: "create" as const, ref, body: b as unknown as JsonObject }], detail: { taskId: b.taskId, kind: b.kind, role: b.role } }; } })); return id; }, rawBody: async (id) => (await world.storage.getAggregate({ kind: "submission", id }))?.body, open: (r, extra = {}) => SubmissionService.withEpoch(world.storage, projects.epoch, r, { ...options, ...extra }) });
      } finally { await world.close(); }
    });

  suite("with the controller's count of refresh rounds (card H12p review), a code submission carries that count: the agent's own number is refused when it differs and never recorded", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    let rounds = 3;
    const svc = c.open(async (id) => c.roles.get(id) ?? [], { refreshRounds: async (taskId) => (taskId === c.task ? rounds : 0) });
    await refuses("invalid_command", () => svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, refreshRound: 0 }), /refreshRound: is counted by the controller \(3/);
    await refuses("invalid_command", () => svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, refreshRound: 9 }), /refreshRound/);
    const left = await svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    assert.equal((await svc.get(ann, left.id))?.refreshRound, 3, "left out: the controller's count");
    rounds = 4;
    const same = await svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, refreshRound: 4 });
    assert.equal((await svc.get(ann, same.id))?.refreshRound, 4, "the same number as counted is accepted");
  });

  suite("a role submits only its own kinds, and only a role the agent holds", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const code = { taskId: c.task, kind: "code" as const, role: "author", base: BASE, tree: T1, patchId: PATCH };
    const made = await c.svc.record(ann, { commandId: cid("s"), ...code, evidence: pass(T1) });
    assert.match(made.id, /^sbm-/);
    const got = await c.svc.get(ann, made.id);
    assert.equal(got?.kind, "code");
    assert.equal(got?.refreshRound, 0);
    assert.equal(got?.makesCommit, false);
    await refuses("forbidden", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "qa", role: "author", subject: made.id, report: "x" }), /may not submit a qa/);
    await refuses("forbidden", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: made.id, verdict: "approve" }), /does not hold the role reviewer/);
    await refuses("forbidden", () => c.svc.record(ann, { commandId: cid("s"), ...code, role: "integrator" }));
    await refuses("forbidden", () => c.svc.record(c.owner, { commandId: cid("s"), ...code }), /not an agent/);
    // one agent holding two roles may submit in either, which keeps a one-agent project working
    c.roles.set(ann.id, ["author", "docs"]);
    await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, evidence: pass(DIGEST) });
  });

  suite("a code submission names base, tree and patch-id; a non-code one makes no commit", async (c) => {
    const ann = await c.agent("ann", ["author", "reviewer", "qa", "docs"]);
    const bob = await c.agent("bob", ["reviewer"]);
    for (const drop of ["base", "tree", "patchId"]) {
      const full: Record<string, unknown> = { taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH };
      delete full[drop];
      await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), ...full } as never), new RegExp(drop));
    }
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: "main", tree: T1, patchId: PATCH }), /base/);
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, refreshRound: 2 });
    assert.equal((await c.svc.get(ann, code.id))?.refreshRound, 2);
    for (const extra of [{ tree: T1 }, { base: BASE }, { patchId: PATCH }]) {
      await refuses("invalid_command", () => c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve", ...extra }), /makes no commit/);
      await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, ...extra }), /makes no commit/);
    }
    const review = await c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "changes", evidence: pass(T1) });
    const stored = await c.svc.get(bob, review.id);
    assert.equal(stored?.tree, T1, "the verdict is about the exact tree and patch it was given");
    assert.equal(stored?.patchId, PATCH);
    assert.equal(stored?.makesCommit, false);
    await refuses("invalid_command", () => c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: review.id, verdict: "approve" }), /code or document/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "qa", role: "qa", report: "ok" }), /subject/);
  });

  suite("evidence for a different tree or artifact version is rejected", async (c) => {
    const ann = await c.agent("ann", ["author", "reviewer", "docs"]);
    const bob = await c.agent("bob", ["reviewer"]);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, evidence: pass(T2) }), /bound to b+, not to the submitted tree/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, evidence: [...pass(T1), ...pass(T2)] }));
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, evidence: pass(T1) });
    await refuses("invalid_command", () => c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve", evidence: pass(T2) }), /not to the submitted tree/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, evidence: pass(T1) }), /artifact/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, evidence: [{ check: "x", result: "pass", boundTo: "latest" }] }), /boundTo/);
    // not_run is evidence too (it counts as failed at the gate, card P09), but it must still be bound to the exact tree
    await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH, evidence: [{ check: "lint", result: "not_run", boundTo: T2 }] });
  });

  suite("a director sign-off cannot be given on the director's own work", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const dee = await c.agent("dee", ["director", "author"]);
    const theirs = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    const mine = await c.svc.record(dee, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH });
    await refuses("forbidden", () => c.svc.record(dee, { commandId: cid("s"), taskId: c.task, kind: "signoff", role: "director", subject: mine.id, decision: "approve" }), /own work/);
    // Card Q04: having submitted code on the task, Dee is a contributor of it and cannot sign off another agent's version either; a director that never contributed can.
    await refuses("forbidden", () => c.svc.record(dee, { commandId: cid("s"), taskId: c.task, kind: "signoff", role: "director", subject: theirs.id, decision: "approve", evidence: pass(T1) }), /already contributed code to this task, so it cannot sign it off/);
    const eli = await c.agent("eli", ["director"]);
    const ok = await c.svc.record(eli, { commandId: cid("s"), taskId: c.task, kind: "signoff", role: "director", subject: theirs.id, decision: "approve", evidence: pass(T1) });
    assert.equal((await c.svc.get(eli, ok.id))?.decision, "approve");
    await refuses("forbidden", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "signoff", role: "director", subject: theirs.id, decision: "approve" }));
  });

  suite("a repeated command records once, a reused command ID with other content conflicts, reads are limited", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["author"]);
    const cmd = { commandId: "same-1", taskId: c.task, kind: "code" as const, role: "author", base: BASE, tree: T1, patchId: PATCH };
    const a = await c.svc.record(ann, cmd);
    const b = await c.svc.record(ann, cmd);
    assert.equal(a.id, b.id);
    await refuses("command_conflict", () => c.svc.record(ann, { ...cmd, tree: T2 }));
    assert.equal(await c.svc.get(bob, a.id), undefined);
    assert.equal((await c.svc.get(c.owner, a.id))?.submittedBy, ann.id);
    await refuses("invalid_command", () => c.svc.record(ann, { ...cmd, commandId: cid("s"), bogus: 1 } as never), /bogus/);
    await refuses("not_found", () => c.svc.record(ann, { ...cmd, commandId: cid("s"), taskId: "task-aaaaaaaaaaaaaaaaaaaa" }));
  });
  suite("a reviewer or qa agent cannot judge its own submission, and there is no flag to allow it", async (c) => {
    const ann = await c.agent("ann", ["author", "reviewer", "qa"]);
    const bob = await c.agent("bob", ["reviewer", "qa"]);
    const mine = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    await refuses("forbidden", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: mine.id, verdict: "approve" }), /own submission/);
    await refuses("forbidden", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "qa", role: "qa", subject: mine.id, report: "fine" }), /own submission/);
    await c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: mine.id, verdict: "approve" });
    // Even a service built to know of no other reviewer refuses it: there is no override.
    const solo = c.open(async (id) => c.roles.get(id) ?? [], { reviewersAvailableIn: async () => [] });
    await refuses("forbidden", () => solo.record(ann, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: mine.id, verdict: "approve" }), /own submission/);
  });

  suite("review is required of a code submission only while another agent could review it; otherwise the reason is recorded", async (c) => {
    const ann = await c.agent("ann", ["author", "reviewer"]);
    let others: string[] = [];
    const seen: string[] = [];
    const svc = c.open(async (id) => c.roles.get(id) ?? [], { reviewersAvailableIn: async (project, worker) => { seen.push(`${project}/${worker}`); return others; } });
    const code = (tree: string) => ({ taskId: c.task, kind: "code" as const, role: "author", base: BASE, tree, patchId: PATCH });
    const one = await svc.record(ann, { commandId: cid("s"), ...code(T1) });
    assert.deepEqual((await svc.get(ann, one.id))?.review, { required: false, reason: "review_disabled_single_agent" });
    assert.match(seen[0]!, new RegExp(`/${ann.id}$`));
    others = [ann.id]; // the worker never counts, even if a port names it
    assert.deepEqual((await svc.get(ann, (await svc.record(ann, { commandId: cid("s"), ...code(T2) })).id))?.review, { required: false, reason: "review_disabled_single_agent" });
    others = ["agent:bob"];
    const two = await svc.record(ann, { commandId: cid("s"), ...code("f".repeat(40)) });
    assert.deepEqual((await svc.get(ann, two.id))?.review, { required: true });
    assert.equal((await svc.get(ann, one.id))?.review?.required, false, "an earlier submission keeps what was recorded");
  });

  suite("roles are looked up for the task's project, so a role in one project is none in another", async (c) => {
    const ann = await c.agent("ann", []);
    const seen: string[] = [];
    const scoped = c.open(async (_id, scope) => { seen.push(`${scope.projectId}/${scope.taskId}`); return scope.taskId === c.task ? ["author"] : []; });
    const code = { kind: "code" as const, role: "author", base: BASE, tree: T1, patchId: PATCH };
    await scoped.record(ann, { commandId: cid("s"), taskId: c.task, ...code });
    await refuses("forbidden", () => scoped.record(ann, { commandId: cid("s"), taskId: c.other.task, ...code }), /in this project/);
    assert.equal(seen.length, 2);
    assert.match(seen[0]!, /^proj-[a-z2-7]{20}\/task-/);
  });

  suite("a code submission must come from the owner of the task's current attempt", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["author"]);
    const code = { kind: "code" as const, role: "author", base: BASE, tree: T1, patchId: PATCH, taskId: c.task };
    const roles = async (id: string): Promise<readonly string[]> => c.roles.get(id) ?? [];
    let attempt: { ownerId: string; state: string } | undefined;
    const gated = c.open(roles, { attemptOf: async () => attempt });
    await refuses("forbidden", () => gated.record(ann, { commandId: cid("s"), ...code }), /current attempt/);
    attempt = { ownerId: bob.id, state: "active" };
    await refuses("forbidden", () => gated.record(ann, { commandId: cid("s"), ...code }), /current attempt/);
    attempt = { ownerId: ann.id, state: "failed" };
    await refuses("forbidden", () => gated.record(ann, { commandId: cid("s"), ...code }), /current attempt/);
    attempt = { ownerId: ann.id, state: "active" };
    await gated.record(ann, { commandId: cid("s"), ...code });
    attempt = { ownerId: ann.id, state: "succeeded" };
    await gated.record(ann, { commandId: cid("s"), ...code, tree: T2 });
  });

  suite("a code submission records the attempt it came from; a replay keeps the first attempt; non-code kinds name none (card Q01b, a record per attempt)", async (c) => {
    const ann = await c.agent("ann", ["author", "docs"]);
    const bob = await c.agent("bob", ["reviewer"]);
    let attempt: { ownerId: string; state: string; attemptId?: string } | undefined = { ownerId: ann.id, state: "active", attemptId: "att-first" };
    const gated = c.open(async (id) => c.roles.get(id) ?? [], { attemptOf: async () => attempt });
    const cmd = { commandId: cid("s"), taskId: c.task, kind: "code" as const, role: "author", base: BASE, tree: T1, patchId: PATCH };
    // the attempt is the controller's observation: an agent naming one (its own or another task's) is refused, in every kind
    await refuses("invalid_command", () => gated.record(ann, { ...cmd, commandId: cid("s"), attemptId: "att-other" } as never), /attemptId: is not a field/);
    await refuses("invalid_command", () => gated.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, attemptId: "att-first" } as never), /attemptId: is not a field/);
    const first = await gated.record(ann, cmd);
    assert.equal((await gated.get(ann, first.id))?.attemptId, "att-first");
    // the next attempt of the same task (a retry) submits again: its own record names its own attempt
    attempt = { ownerId: ann.id, state: "active", attemptId: "att-second" };
    const second = await gated.record(ann, { ...cmd, commandId: cid("s"), tree: T2 });
    assert.equal((await gated.get(ann, second.id))?.attemptId, "att-second");
    assert.equal((await gated.get(ann, first.id))?.attemptId, "att-first", "an earlier record keeps its attempt");
    // a replay of the first command under the later attempt is the first record, unchanged (the attempt is observed, not part of the request)
    const again = await gated.record(ann, cmd);
    assert.deepEqual([again.id, again.replayed], [first.id, true]);
    assert.equal((await gated.get(ann, first.id))?.attemptId, "att-first");
    // review and document records name no attempt: they are not made by the task's code attempt
    const review = await gated.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: first.id, verdict: "approve" });
    assert.equal((await c.rawBody(review.id) as SubmissionBody).attemptId, undefined);
    const doc = await gated.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST });
    assert.equal((await c.rawBody(doc.id) as SubmissionBody).attemptId, undefined);
    // without the attempt port nothing is named (as before)
    const plain = await c.svc.record(ann, { ...cmd, commandId: cid("s") });
    assert.equal((await c.rawBody(plain.id) as SubmissionBody).attemptId, undefined);
    // a record from before this field (made without the attempt port, so the same compared payload as before) replays cleanly under the attempt port and gains no attempt
    const old = { ...cmd, commandId: cid("s"), tree: T2 };
    const oldMade = await c.svc.record(ann, old);
    const oldAgain = await gated.record(ann, old);
    assert.deepEqual([oldAgain.id, oldAgain.revision, oldAgain.replayed], [oldMade.id, oldMade.revision, true]);
    assert.equal((await c.rawBody(oldMade.id) as SubmissionBody).attemptId, undefined, "no backfill");
    // the same with a record stored in the format written before this change (a frozen copy, so a change of the compared payload cannot hide in both sides)
    const legacy = { ...cmd, commandId: cid("s"), tree: "f".repeat(40) };
    const legacyId = await c.plantOld(ann, legacy.commandId, { taskId: c.task, projectId: c.projects.task, kind: "code", role: "author", submittedBy: ann.id, submittedAt: options.clock(), makesCommit: false, base: BASE, tree: legacy.tree, patchId: PATCH, refreshRound: 0, evidence: [] });
    const legacyAgain = await gated.record(ann, legacy);
    assert.deepEqual([legacyAgain.id, legacyAgain.replayed], [legacyId, true], "a record from before attemptId replays");
    assert.equal((await gated.get(ann, legacyId))?.attemptId, undefined);
    // after the attempt has ended (or another agent's attempt took over), a repeat still answers with the first record; a new code submission is refused
    for (const later of [undefined, { ownerId: ann.id, state: "failed", attemptId: "att-second" }, { ownerId: bob.id, state: "active", attemptId: "att-third" }]) {
      attempt = later;
      const repeat = await gated.record(ann, cmd);
      assert.deepEqual([repeat.id, repeat.replayed], [first.id, true]);
      assert.equal((await gated.get(ann, first.id))?.attemptId, "att-first");
      await refuses("forbidden", () => gated.record(ann, { ...cmd, commandId: cid("s") }), /owns the task's current attempt/);
    }
    // the same command ID with a different request is still a conflict, not a replay
    attempt = { ownerId: ann.id, state: "active", attemptId: "att-fourth" };
    await refuses("command_conflict", () => gated.record(ann, { ...cmd, tree: T2 }));
  });

  suite("the ending's submission (work.end) is recorded only while its own attempt is the task's current one, and names that attempt (card Q01b second review)", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    // the agent's earlier attempt ended (its lease ran out) and a newer attempt of the same agent took over; the earlier attempt's ending then resumes (after a restart) and reaches its submit step
    let attempt: { ownerId: string; state: string; attemptId?: string } | undefined = { ownerId: ann.id, state: "active", attemptId: "att-new" };
    const gated = c.open(async (id) => c.roles.get(id) ?? [], { attemptOf: async () => attempt });
    const staged: string[] = [];
    const submit = stagedSubmit({ stage: async (a) => { staged.push(a.attemptId); return { base: BASE, tree: T1, patchId: PATCH, files: [], leftBy: NONE_LEFT }; }, submissions: gated, principalOf: async () => ann });
    const ending = (attemptId: string) => ({ attemptId, taskId: c.task, projectId: c.projects.task, agentId: ann.id, live: true, hostId: "h", generation: 1 }) as never;
    await refuses("forbidden", () => submit(ending("att-old"), BASE, cid("end")), /no longer the task's current attempt/);
    assert.deepEqual(staged, ["att-old"]);
    // the current attempt's own ending is recorded under it
    const key = cid("end");
    const made = await submit(ending("att-new"), BASE, key);
    assert.equal((await gated.get(ann, made.submissionId))?.attemptId, "att-new");
    // its repeat after the attempt ended (or another took over) is the same record
    attempt = { ownerId: ann.id, state: "active", attemptId: "att-later" };
    assert.equal((await submit(ending("att-new"), BASE, key)).submissionId, made.submissionId);
    assert.equal((await gated.get(ann, made.submissionId))?.attemptId, "att-new");
    // the same check straight on the service: `from` must be the current attempt
    await refuses("forbidden", () => gated.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH }, { attemptId: "att-new" }), /no longer the task's current attempt/);
    const direct = await gated.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH }, { attemptId: "att-later", leftBy: NONE_LEFT });
    assert.equal((await gated.get(ann, direct.id))?.attemptId, "att-later");
  });

  suite("a replay of the ending's submit whose submission is already recorded returns it without staging or reading the landing branch again, so a landing branch that moved since (or an attempt that can no longer be read) does not turn it into a refusal (card H12n second slice review)", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const svc = c.open(async (id) => c.roles.get(id) ?? []);
    let staged = 0; let reads = 0;
    let landing: () => Promise<{ base: string; head: string; mine: string[]; landed: string[] } | undefined> = async () => ({ base: BASE, head: BASE, mine: [], landed: [] });
    const submit = stagedSubmit({ stage: async () => { staged++; return { base: BASE, tree: T1, patchId: PATCH, files: ["a.ts"], leftBy: NONE_LEFT }; }, submissions: svc, principalOf: async () => ann, landing: async () => { reads++; return landing(); } });
    const ending = { attemptId: "att-1", taskId: c.task, projectId: c.projects.task, agentId: ann.id, live: true } as never;
    const key = cid("end");
    const made = await submit(ending, BASE, key);
    assert.deepEqual([staged, reads], [1, 1]);
    // the landing branch has since changed the same file, then cannot be read at all: the replay is still the recorded submission
    landing = async () => ({ base: BASE, head: "e".repeat(40), mine: [], landed: ["a.ts"] });
    assert.equal((await submit(ending, BASE, key)).submissionId, made.submissionId);
    landing = async () => undefined;
    assert.equal((await submit(ending, BASE, key)).submissionId, made.submissionId);
    assert.deepEqual([staged, reads], [1, 1]);
    // a new key is judged as before: refused, nothing recorded
    await assert.rejects(submit(ending, BASE, cid("end2")), (e: unknown) => e instanceof DomainError && e.name === "SubmitRefused");
    assert.equal((await svc.list(ann, c.task, { limit: 10 })).items.length, 1);
    // another agent's record under the same command ID is never taken as this one's
    const bob = await c.agent("bob", ["author"]);
    landing = async () => ({ base: BASE, head: BASE, mine: [], landed: [] });
    const bobs = stagedSubmit({ stage: async () => ({ base: BASE, tree: T2, patchId: PATCH, files: ["b.ts"], leftBy: NONE_LEFT }), submissions: svc, principalOf: async () => bob, landing: async () => landing() });
    assert.notEqual((await bobs({ ...(ending as object), agentId: bob.id } as never, BASE, key)).submissionId, made.submissionId);
  });

  suite("the ending's own lookup of its recorded submission finds only this agent's code submission of this task under the step key, and an agent cannot record one under the ending's step keys itself (card H12n second slice, second review)", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["author"]);
    const svc = c.open(async (id) => c.roles.get(id) ?? []);
    const key = "workend:att-1:submitted";
    // An agent's own record under the ending's key would be taken as the staged one: refused, nothing recorded; the ending's own record (with its attempt) is made.
    for (const by of [ann, bob]) await assert.rejects(svc.record(by, { commandId: key, taskId: c.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && /commandId: starting with workend:/.test(e.message));
    assert.equal((await svc.list(ann, c.task, { limit: 10 })).items.length, 0);
    const submit = stagedSubmit({ stage: async () => ({ base: BASE, tree: T1, patchId: PATCH, files: ["a.ts"], leftBy: NONE_LEFT }), submissions: svc, principalOf: async () => ann });
    const ending = { attemptId: "att-1", taskId: c.task, projectId: c.projects.task, agentId: ann.id, live: true };
    const made = await submit(ending as never, BASE, key);
    const recorded = (by: Principal | undefined) => recordedSubmission({ submissions: svc, principalOf: async () => by });
    assert.deepEqual(await recorded(ann)(ending as never, key), { submissionId: made.submissionId });
    assert.equal(await recorded(ann)(ending as never, "workend:att-1:other"), undefined);
    assert.equal(await recorded(ann)({ ...ending, taskId: c.other.task } as never, key), undefined);
    assert.equal(await recorded(bob)({ ...ending, agentId: bob.id } as never, key), undefined);
    assert.equal(await recorded(undefined)(ending as never, key), undefined);
  });

  suite("a repeat of a code submission is compared with what the controller observed when it was first made: a later refresh round or a change of reviewers does not turn it into a conflict (card Q01b second review)", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["author"]);
    let rounds = 1;
    let reviewers: string[] = [];
    let attempt: { ownerId: string; state: string; attemptId?: string } | undefined = { ownerId: ann.id, state: "active", attemptId: "att-1" };
    const svc = c.open(async (id) => c.roles.get(id) ?? [], { refreshRounds: async () => rounds, reviewersAvailableIn: async () => reviewers, attemptOf: async () => attempt });
    const cmd = { commandId: cid("s"), taskId: c.task, kind: "code" as const, role: "author", base: BASE, tree: T1, patchId: PATCH };
    const first = await svc.record(ann, cmd);
    const stored = await c.rawBody(first.id) as SubmissionBody;
    assert.deepEqual([stored.refreshRound, stored.review, stored.attemptId], [1, { required: false, reason: "review_disabled_single_agent" }, "att-1"]);
    // the attempt ended, a later attempt refreshed twice, and a reviewer joined
    attempt = { ownerId: ann.id, state: "active", attemptId: "att-2" };
    rounds = 3; reviewers = ["agent:rev"];
    for (const again of [cmd, { ...cmd, refreshRound: 1 }]) {
      const r = await svc.record(ann, again);
      assert.deepEqual([r.id, r.revision, r.replayed], [first.id, first.revision, true], "the first record, unchanged");
    }
    assert.deepEqual(await c.rawBody(first.id), stored);
    // a repeat that asks for something else is still a conflict; a new command counts today's round and reviewers
    await refuses("command_conflict", () => svc.record(ann, { ...cmd, tree: T2 }));
    const next = await svc.record(ann, { ...cmd, commandId: cid("s"), tree: T2 });
    const nextBody = await c.rawBody(next.id) as SubmissionBody;
    assert.deepEqual([nextBody.refreshRound, nextBody.review, nextBody.attemptId], [3, { required: true }, "att-2"]);
    // another agent's same command ID is its own command: nothing of ann's record is used or shown
    attempt = { ownerId: bob.id, state: "active", attemptId: "att-3" };
    const bobs = await svc.record(bob, cmd);
    assert.notEqual(bobs.id, first.id);
    assert.deepEqual([(await c.rawBody(bobs.id) as SubmissionBody).refreshRound, (await c.rawBody(bobs.id) as SubmissionBody).submittedBy], [3, bob.id]);
  });

  suite("formats are size-capped and checked: digests, evidence names, role, artifact ID", async (c) => {
    const ann = await c.agent("ann", ["author", "docs"]);
    const code = { taskId: c.task, kind: "code" as const, role: "author", base: BASE, tree: T1, patchId: PATCH };
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), ...code, tree: "a".repeat(5000) }), /tree/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), ...code, patchId: "d".repeat(65) }), /patchId/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), ...code, base: `${"c".repeat(39)}Z` }), /base/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), ...code, evidence: [{ check: "bad\nname", result: "pass", boundTo: T1 }] }), /evidence/);
    const long = "r".repeat(5000);
    await assert.rejects(() => c.svc.record(ann, { commandId: cid("s"), ...code, role: long }), (e: unknown) => { assert.ok(e instanceof DomainError); assert.ok(e.message.length < 300, "the echoed role is bounded"); return true; });
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, artifactId: "art-nope" }), /artifactId/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: `sha256:${"e".repeat(64)}${"e".repeat(5000)}` }), /artifactDigest/);
  });

  suite("a report is stored redacted, and a missing command ID is an invalid_command", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["qa", "docs"]);
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const qa = await c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "qa", role: "qa", subject: code.id, report: `token ${secret} leaked` });
    const doc = await c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, report: `token ${secret}` });
    for (const id of [qa.id, doc.id]) {
      const raw = (await c.rawBody(id)) as { report: string };
      assert.ok(!raw.report.includes(secret), "the stored report holds no secret");
    }
    for (const bad of [undefined, "", 7, null]) await refuses("invalid_command", () => c.svc.record(ann, { commandId: bad, taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH } as never), /commandId/);
  });


  suite("listing a task's submissions: owner sees all, an agent its own, other tasks and projects are hidden, paged and filtered by kind", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["reviewer"]);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, refreshRound: i })).id);
    const rev = await c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: ids[0]!, verdict: "changes" });
    await c.svc.record(ann, { commandId: cid("s"), taskId: c.other.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH });
    const all = await c.svc.list(c.owner, c.task, { limit: 50 });
    assert.deepEqual(all.items.map((x) => x.id), [...ids, rev.id].sort(), "the owner sees every record of this task and none of another task");
    assert.equal(all.next, undefined);
    // paging: pages are disjoint, ordered, and the cursor ends
    const seen: string[] = [];
    let after: string | undefined;
    for (let n = 0; n < 5; n++) {
      const p = await c.svc.list(c.owner, c.task, { limit: 2, ...(after === undefined ? {} : { afterId: after }) });
      assert.ok(p.items.length <= 2);
      seen.push(...p.items.map((x) => x.id));
      if (p.next === undefined) break;
      after = p.next;
    }
    assert.deepEqual(seen, all.items.map((x) => x.id));
    assert.deepEqual((await c.svc.list(c.owner, c.task, { kind: "review", limit: 50 })).items.map((x) => x.id), [rev.id]);
    // visibility: an agent sees only what it submitted
    assert.deepEqual((await c.svc.list(bob, c.task, { limit: 50 })).items.map((x) => x.id), [rev.id]);
    assert.equal((await c.svc.list(ann, c.task, { limit: 50 })).items.length, 3);
    // an agent without task.read in a task's project gets not_found, as does an unknown task
    const lone = await c.agent("lone", ["author"], false);
    await refuses("not_found", () => c.svc.list(lone, c.task, { limit: 5 }));
    await refuses("not_found", () => c.svc.list(c.owner, "task-aaaaaaaaaaaaaaaaaaaa", { limit: 5 }));
    await refuses("invalid_command", () => c.svc.list(c.owner, c.task, { limit: 0 }));
    await refuses("invalid_command", () => c.svc.list(c.owner, c.task, { limit: 101 }));
    await refuses("invalid_command", () => c.svc.list(c.owner, c.task, { limit: 5, kind: "nope" }));
    await refuses("invalid_command", () => c.svc.list(c.owner, c.task, { limit: 5, afterId: "zzz" }));
  });

  const rec = (taskId: string, projectId: string, extra: Partial<SubmissionBody>): SubmissionBody => ({ taskId, projectId, kind: "qa", role: "qa", submittedBy: "agent:ann", submittedAt: "2026-10-30T10:00:00.000Z", makesCommit: false, evidence: [], ...extra });

  suite("the cursor is sealed and bound to the caller and the task; the global table's other rows never leak", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["author"]);
    for (let i = 0; i < 3; i++) await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, refreshRound: i });
    // other tasks' records interleave in the same table
    for (let i = 0; i < 6; i++) await c.svc.record(bob, { commandId: cid("s"), taskId: c.other.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH, refreshRound: i });
    const foreignIds = (await c.svc.list(c.owner, c.other.task, { limit: 50 })).items.map((x) => x.id);
    const mine = new Set((await c.svc.list(c.owner, c.task, { limit: 50 })).items.map((x) => x.id));
    // a tiny scan window so the cursor lands on rows of the other task
    const small = c.open(async (id) => c.roles.get(id) ?? [], { listScan: { pageSize: 1, reads: 1 } });
    let cursor: string | undefined;
    for (let n = 0; n < 20; n++) {
      const p = await small.list(ann, c.task, { limit: 1, ...(cursor === undefined ? {} : { afterId: cursor }) });
      if (p.next === undefined) break;
      assert.ok(p.next.startsWith("~"), "the cursor is sealed");
      for (const id of [...foreignIds, ...mine]) assert.ok(!p.next.includes(id), "the cursor holds no submission ID in the clear");
      cursor = p.next;
    }
    const page = await c.svc.list(ann, c.task, { limit: 1 });
    assert.ok(page.next !== undefined && page.next.startsWith("~"));
    // plain IDs, tampered and foreign cursors are refused
    for (const id of [...foreignIds, ...mine]) await refuses("invalid_command", () => c.svc.list(ann, c.task, { limit: 5, afterId: id }), /cursor/);
    await refuses("invalid_command", () => c.svc.list(ann, c.task, { limit: 5, afterId: `${page.next!.slice(0, -2)}AA` }), /cursor/);
    await refuses("invalid_command", () => c.svc.list(ann, c.task, { limit: 5, afterId: "~" }), /cursor/);
    // a cursor of the same task from another caller, or of another task, does not open
    await refuses("invalid_command", () => c.svc.list(c.owner, c.task, { limit: 5, afterId: page.next! }), /cursor/);
    const o2 = await c.svc.list(c.owner, c.other.task, { limit: 1 });
    await refuses("invalid_command", () => c.svc.list(c.owner, c.task, { limit: 5, afterId: o2.next! }), /cursor/);
    // another instance (other key) cannot open it either
    await refuses("invalid_command", () => c.open(async () => []).list(ann, c.task, { limit: 5, afterId: page.next! }), /cursor/);
    // an honest cursor continues
    assert.ok((await c.svc.list(ann, c.task, { limit: 5, afterId: page.next! })).items.length >= 0);
  });

  suite("a scan that stops early says so, and its cursor continues the scan", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["author"]);
    const wanted: string[] = [];
    for (let i = 0; i < 2; i++) wanted.push((await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, refreshRound: i })).id);
    for (let i = 0; i < 8; i++) await c.svc.record(bob, { commandId: cid("s"), taskId: c.other.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH, refreshRound: i });
    const small = c.open(async (id) => c.roles.get(id) ?? [], { listScan: { pageSize: 2, reads: 1 } });
    const seen: string[] = [];
    let cursor: string | undefined;
    let limited = 0;
    for (let n = 0; n < 20; n++) {
      const p = await small.list(c.owner, c.task, { limit: 50, ...(cursor === undefined ? {} : { afterId: cursor }) });
      seen.push(...p.items.map((x) => x.id));
      if (p.scanLimited === true) limited++;
      if (p.next === undefined) break;
      cursor = p.next;
    }
    assert.ok(limited > 0, "the window of 2 rows is too small for 10 rows, so a call reported scanLimited");
    assert.deepEqual(seen.sort(), [...wanted].sort(), "following next finds every record exactly once");
    const whole = await c.svc.list(c.owner, c.task, { limit: 50 });
    assert.equal(whole.scanLimited, undefined);
  });

  suite("list redacts a report on the way out", async (c) => {
    const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const ann = await c.agent("ann", ["qa"]);
    const id = await c.plant(rec(c.task, c.projects.task, { submittedBy: ann.id, report: `token ${secret} leaked` }));
    assert.ok(JSON.stringify(await c.rawBody(id)).includes(secret), "the planted record is unredacted");
    for (const who of [c.owner, ann]) {
      const listed = (await c.svc.list(who, c.task, { limit: 10 })).items.find((x) => x.id === id);
      assert.ok(listed !== undefined && !JSON.stringify(listed).includes(secret));
      assert.ok(!JSON.stringify(await c.svc.get(who, id)).includes(secret));
    }
  });

  suite("a task credential reads only its own task, in list and get", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const mineHere = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    const mineThere = await c.svc.record(ann, { commandId: cid("s"), taskId: c.other.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH });
    const scoped = (taskId: string, projectId: string): Principal => ({ ...ann, taskScope: { taskId, projectId } });
    const here = scoped(c.task, c.projects.task);
    assert.deepEqual((await c.svc.list(here, c.task, { limit: 10 })).items.map((x) => x.id), [mineHere.id]);
    assert.equal((await c.svc.get(here, mineHere.id))?.id, mineHere.id);
    await refuses("not_found", () => c.svc.list(here, c.other.task, { limit: 10 }), /no such task/);
    assert.equal(await c.svc.get(here, mineThere.id), undefined, "the credential's task is not the submission's task");
    // a scope naming the right task in the wrong project is also refused
    const wrong = scoped(c.task, c.projects.other);
    await refuses("not_found", () => c.svc.list(wrong, c.task, { limit: 10 }));
    assert.equal(await c.svc.get(wrong, mineHere.id), undefined);
  });

  suite("get and list agree: an agent without task.read cannot read even its own submission", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const made = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    const revoked: Principal = { ...ann, grants: [] };
    assert.equal(await c.svc.get(revoked, made.id), undefined);
    await refuses("not_found", () => c.svc.list(revoked, c.task, { limit: 5 }));
    assert.equal((await c.svc.get(ann, made.id))?.id, made.id);
  });

  suite("a reviewer reads only the submission its review request names", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["reviewer"]);
    const cy = await c.agent("cy", ["reviewer"]);
    const first = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    const second = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, refreshRound: 1 });
    const elsewhere = await c.svc.record(ann, { commandId: cid("s"), taskId: c.other.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH });
    // without any assignment a reviewer sees nothing of others' work
    assert.equal(await c.svc.get(bob, first.id), undefined);
    assert.deepEqual((await c.svc.list(bob, c.task, { limit: 10 })).items, []);
    const assigned = new Map<string, string[]>([[`${bob.id}|${c.task}`, [first.id]], [`${bob.id}|${c.other.task}`, [elsewhere.id]], [`${cy.id}|${c.task}`, [first.id]]]);
    const svc = c.open(async (id) => c.roles.get(id) ?? [], { reviewAssignments: async (id, taskId) => assigned.get(`${id}|${taskId}`) ?? [] });
    assert.equal((await svc.get(bob, first.id))?.id, first.id, "the assigned submission is readable");
    assert.equal(await svc.get(bob, second.id), undefined, "the role-wide read does not exist");
    assert.equal((await svc.get(bob, elsewhere.id))?.id, elsewhere.id, "assigned in the other task, which bob may read");
    assert.deepEqual((await svc.list(bob, c.other.task, { limit: 10 })).items.map((x) => x.id), [elsewhere.id]);
    assert.deepEqual((await svc.list(bob, c.task, { limit: 10 })).items.map((x) => x.id), [first.id]);
    assert.deepEqual((await svc.list(cy, c.task, { limit: 10 })).items.map((x) => x.id), [first.id]);
    // a reviewer's own review stays readable beside the assigned one
    const rev = await svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: first.id, verdict: "approve" });
    assert.deepEqual((await svc.list(bob, c.task, { limit: 10 })).items.map((x) => x.id).sort(), [first.id, rev.id].sort());
    // the reviewer role must still be held, and task.read is still required
    c.roles.set(bob.id, []);
    assert.equal(await svc.get(bob, first.id), undefined);
    c.roles.set(bob.id, ["reviewer"]);
    assert.equal(await svc.get({ ...bob, grants: [] }, first.id), undefined);
  });

  // Card U09b: the task's activity is told of every recorded submission, so its replay can link to the diff or the comment.
  suite("the host is told of a recorded submission (and of a repeat, which it records once), and a hook that fails changes nothing", async (c) => {
    const told: string[] = [];
    let failing = false;
    const svc = c.open(async (id) => c.roles.get(id) ?? [], { onRecorded: async (e) => { if (failing) throw new Error("activity is down"); told.push(`${e.submissionId}|${e.taskId}|${e.kind}|${e.role}|${e.submittedBy}|${e.verdict ?? e.decision ?? ""}`); } });
    const ann = await c.agent("ann", ["author", "reviewer"]);
    const code = await svc.record(ann, { commandId: "u09b-1", taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    const again = await svc.record(ann, { commandId: "u09b-1", taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    assert.equal(again.replayed, true);
    const bob = await c.agent("bob", ["reviewer"]);
    const review = await svc.record(bob, { commandId: "u09b-2", taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "changes" });
    assert.deepEqual(told, [`${code.id}|${c.task}|code|author|${ann.id}|`, `${code.id}|${c.task}|code|author|${ann.id}|`, `${review.id}|${c.task}|review|reviewer|${bob.id}|changes`], "a repeat is told again; the host's own step command makes it one step");
    failing = true;
    const kept = await svc.record(ann, { commandId: "u09b-3", taskId: c.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH });
    assert.equal((await svc.get(ann, kept.id))?.tree, T2, "the submission stands though the hook failed");
    // Nothing is told of a refused submission.
    failing = false; told.length = 0;
    await refuses("forbidden", () => svc.record(ann, { commandId: "u09b-4", taskId: c.task, kind: "qa", role: "author", subject: code.id, report: "x" }));
    assert.deepEqual(told, []);
  });
}

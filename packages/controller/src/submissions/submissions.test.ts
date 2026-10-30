import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { SubmissionService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-30T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const T1 = "a".repeat(40), T2 = "b".repeat(40), BASE = "c".repeat(40), PATCH = "d".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;
const pass = (boundTo: string) => [{ check: "tests", result: "pass" as const, boundTo }];

for (const backend of backends) {
  const suite = (name: string, body: (c: { svc: SubmissionService; roles: Map<string, string[]>; agent(name: string, roles: string[]): Promise<Principal>; owner: Principal; task: string }) => Promise<void>) =>
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
        const svc = SubmissionService.withEpoch(world.storage, projects.epoch, async (id) => roles.get(id) ?? [], options);
        await body({ svc, roles, agent, owner, task });
      } finally { await world.close(); }
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
    for (const drop of ["base", "tree", "patchId"]) {
      const full: Record<string, unknown> = { taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH };
      delete full[drop];
      await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), ...full } as never), new RegExp(drop));
    }
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: "main", tree: T1, patchId: PATCH }), /base/);
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, refreshRound: 2 });
    assert.equal((await c.svc.get(ann, code.id))?.refreshRound, 2);
    for (const extra of [{ tree: T1 }, { base: BASE }, { patchId: PATCH }]) {
      await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve", ...extra }), /makes no commit/);
      await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, ...extra }), /makes no commit/);
    }
    const review = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "changes", evidence: pass(T1) });
    const stored = await c.svc.get(ann, review.id);
    assert.equal(stored?.tree, T1, "the verdict is about the exact tree and patch it was given");
    assert.equal(stored?.patchId, PATCH);
    assert.equal(stored?.makesCommit, false);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: review.id, verdict: "approve" }), /code or document/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "qa", role: "qa", report: "ok" }), /subject/);
  });

  suite("evidence for a different tree or artifact version is rejected", async (c) => {
    const ann = await c.agent("ann", ["author", "reviewer", "docs"]);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, evidence: pass(T2) }), /bound to b+, not to the submitted tree/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, evidence: [...pass(T1), ...pass(T2)] }));
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, evidence: pass(T1) });
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve", evidence: pass(T2) }), /not to the submitted tree/);
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
    const ok = await c.svc.record(dee, { commandId: cid("s"), taskId: c.task, kind: "signoff", role: "director", subject: theirs.id, decision: "approve", evidence: pass(T1) });
    assert.equal((await c.svc.get(dee, ok.id))?.decision, "approve");
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
}

import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Observation } from "../dependencies/dependencies.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant } from "../security/index.js";
import { ResumeCheckService, type ResumePorts } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-28T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};
const model = { provider: "local", id: "m1" };

/** The pieces the check reads, as fakes the test can change between steps. */
class Fakes {
  continuationId = "cnt-aaaaaaaaaaaaaaaaaaaa";
  statuses: Record<string, string> = { "dep-1": "unchanged", "dep-2": "changed" };
  missing: string[] = [];
  effects: string[] = [];
  reviewCalls: string[][] = [];
  reviewFails = false;
  resumes: string[] = [];
  blockers: string[] = [];
  /** Runs after each verification, to change inputs between review and commit. */
  onCheck: (() => void) | undefined;
  noManifest = false;
  continuations = {
    latest: async () => ({ id: this.continuationId } as never),
    resume: async (_by: unknown, c: { commandId: string; continuationId?: string }) => { if (!this.resumes.includes(c.commandId)) this.resumes.push(c.commandId); return { identity: "conv", continuation: { id: this.continuationId } as never, modelChanged: false, replayed: false }; },
  };
  dependencies = {
    check: async () => {
      if (this.noManifest) throw new DomainError("not_found", "no manifest");
      const out = Object.entries(this.statuses).map(([id, status]) => ({ id, kind: "file" as const, key: `/f/${id}`, status: status as never, detail: status === "unchanged" ? "same" : `now ${status}` }));
      this.onCheck?.();
      return out;
    },
  };
  seen = new Map<string, string>();
  bl = { openBlocker: async (c: { type: string; commandId: string }) => { const old = this.seen.get(c.commandId); if (old !== undefined) return { id: old } as never; this.blockers.push(c.type); const id = `blk-${this.blockers.length}`; this.seen.set(c.commandId, id); return { id } as never; } };
  ports: ResumePorts = {
    observe: async (): Promise<Record<string, Observation>> => ({}),
    missingContext: async () => this.missing,
    uncertainEffects: async (_t, _c) => this.effects,
    review: async (r) => { this.reviewCalls.push(r.changes.map((c) => c.id)); if (this.reviewFails) throw new Error("reviewer offline"); return Object.fromEntries(r.changes.map((c) => [c.id, { relevant: true, rationale: `${c.key} matters` }])); },
  };
}

for (const backend of backends) {
  const suite = (name: string, body: (c: { f: Fakes; svc: ResumeCheckService; task: string; owner: Awaited<ReturnType<PrincipalService["authenticate"]>>; stranger: Awaited<ReturnType<PrincipalService["authenticate"]>>; reopen(max?: number): ResumeCheckService }) => Promise<void>) =>
    test(`${backend.name}: resume check ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const make = async (nm: string, grants: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
        const stranger = await make("zed", [{ action: "task.read", project }]);
        const f = new Fakes();
        const reopen = (max?: number) => ResumeCheckService.withEpoch(world.storage, projects.epoch, { continuations: f.continuations, dependencies: f.dependencies, blockers: f.bl, ports: f.ports }, { ...options, ...(max === undefined ? {} : { maxRounds: max }) });
        await body({ f, svc: reopen(), task, owner, stranger, reopen });
      } finally { await world.close(); }
    });

  suite("reviews changes, commits once, and records how the context came back", async ({ f, svc, task, owner }) => {
    const s = await svc.start(owner, { commandId: cid("s"), taskId: task, model, after: "restart" });
    assert.equal(s.phase, "ready");
    assert.deepEqual(s.delta?.changed.map((c) => c.id), ["dep-2"]);
    assert.equal(s.delta?.unchanged, 1, "the unchanged dependency is not rebuilt or reviewed");
    assert.deepEqual(f.reviewCalls, [["dep-2"]]);
    assert.equal(s.verdicts["dep-2"]?.rationale, "/f/dep-2 matters");
    assert.equal(f.resumes.length, 0, "nothing is committed before commit");
    const done = await svc.commit(owner, { commandId: cid("c"), checkId: s.id, restoredBy: "reconstruction", limits: ["tool effects are not reproduced"] });
    assert.equal(done.phase, "done");
    assert.deepEqual([done.restore?.method, done.restore?.limits], ["reconstruction", ["tool effects are not reproduced"]]);
    assert.equal(f.resumes.length, 1);
    await svc.commit(owner, { commandId: cid("c"), checkId: s.id });
    assert.equal(f.resumes.length, 1, "a repeat does not resume twice");
  });

  suite("starts over when inputs change after the review, keeps still-valid verdicts, and stops as churn", async ({ f, svc, reopen, task, owner }) => {
    const s = await svc.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue" });
    f.statuses["dep-1"] = "changed";
    const again = await svc.commit(owner, { commandId: cid("c"), checkId: s.id });
    assert.equal(again.round, 1);
    assert.equal(again.phase, "ready");
    assert.deepEqual(f.reviewCalls, [["dep-2"], ["dep-1"]], "dep-2's verdict was kept");
    assert.equal(f.resumes.length, 0);
    await svc.cancel(owner, { checkId: s.id });
    // Inputs that never settle: every commit finds a new change.
    const churn = reopen(2);
    const c = await churn.start(owner, { commandId: cid("s"), taskId: task, model, after: "continue" });
    let k = 0;
    f.onCheck = () => { f.statuses["dep-3"] = `v${k++}`; };
    f.statuses["dep-3"] = "v-1";
    const r1 = await churn.commit(owner, { commandId: cid("c"), checkId: c.id });
    const end = r1.phase === "blocked" ? r1 : await churn.commit(owner, { commandId: cid("c"), checkId: c.id });
    assert.equal(end.phase, "blocked");
    assert.equal(end.blocked?.type, "resume_churn");
    assert.deepEqual(f.blockers.filter((b) => b === "resume_churn").length, 1);
    assert.equal(f.resumes.length, 0, "nothing was committed on moving inputs");
  });

  suite("blocks on missing context, uncertain effects and a failed review, and retries", async ({ f, svc, task, owner }) => {
    f.missing = ["the design doc"];
    const m = await svc.start(owner, { commandId: cid("s"), taskId: task, model, after: "restart" });
    assert.deepEqual([m.phase, m.blocked?.type], ["blocked", "missing_context"]);
    assert.deepEqual(f.blockers, ["missing_context"]);
    const again = await svc.retry(owner, { checkId: m.id });
    assert.deepEqual([again.phase, again.blocked?.type, f.blockers], ["blocked", "missing_context", ["missing_context", "missing_context"]], "blocking again after a retry opens a new blocker");
    f.missing = []; f.effects = ["effect:push-1"];
    const e = await svc.retry(owner, { checkId: m.id });
    assert.deepEqual([e.phase, e.blocked?.type], ["blocked", "effects_uncertain"]);
    f.effects = []; f.reviewFails = true;
    const r = await svc.retry(owner, { checkId: m.id });
    assert.deepEqual([r.phase, r.blocked?.type], ["blocked", "review_failed"]);
    f.reviewFails = false;
    const real = f.ports.review;
    f.ports.review = async (q) => Object.fromEntries(q.changes.map((c) => [c.id, { relevant: true, rationale: "  " }]));
    const blank = await svc.retry(owner, { checkId: m.id });
    assert.deepEqual([blank.phase, blank.blocked?.type], ["blocked", "review_failed"], "a verdict without a reason is no verdict");
    f.ports.review = real;
    const ok = await svc.retry(owner, { checkId: m.id });
    assert.equal(ok.phase, "ready");
    await refuses("invalid_command", () => svc.retry(owner, { checkId: m.id }));
  });

  suite("with nothing recorded nothing is called unchanged; a crash while executing is finished once", async ({ f, svc, reopen, task, owner }) => {
    f.noManifest = true;
    const s = await svc.start(owner, { commandId: cid("s"), taskId: task, model, after: "restart" });
    assert.equal(s.phase, "ready");
    assert.equal(s.revisionSet?.unverified, true);
    let calls = 0;
    const real = f.continuations.resume;
    f.continuations.resume = async (b, c) => { if (calls++ === 0) throw new Error("died"); return real(b, c); };
    await assert.rejects(svc.commit(owner, { commandId: cid("c"), checkId: s.id }), /died/);
    assert.equal((await svc.get(owner, s.id))?.phase, "executing");
    assert.deepEqual((await reopen().sweep(owner)).advanced, [s.id]);
    assert.equal((await svc.get(owner, s.id))?.phase, "done");
    assert.equal(f.resumes.length, 1);
  });

  suite("refusals: one at a time, strangers learn nothing, bad input", async ({ svc, task, owner, stranger }) => {
    const s = await svc.start(owner, { commandId: cid("s"), taskId: task, model, after: "restart" });
    await refuses("invalid_command", () => svc.start(owner, { commandId: cid("s"), taskId: task, model, after: "restart" }));
    await refuses("forbidden", () => svc.start(stranger, { commandId: cid("s"), taskId: task, model, after: "restart" }));
    await refuses("not_found", () => svc.advance(stranger, { checkId: s.id }));
    assert.equal(await svc.get(stranger, s.id), undefined);
    await refuses("invalid_command", () => svc.start(owner, { commandId: cid("s"), taskId: task, model: { provider: "x y", id: "m" }, after: "restart" }));
    await refuses("invalid_command", () => svc.commit(owner, { commandId: cid("c"), checkId: s.id, restoredBy: "magic" as never }));
    await refuses("invalid_command", () => svc.retry(owner, { checkId: s.id }));
  });
}

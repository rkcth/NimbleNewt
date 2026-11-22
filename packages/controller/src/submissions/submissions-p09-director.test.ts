// Card P09 (sixth slice): director sign-offs are kept in a per-submission list written with the sign-off, and `approvalOf` / `landingDirectorGate` answer the newest one. Same harness as submissions-h12o.test.ts.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { StorageError, type ControllerStorage } from "../storage/index.js";
import { SubmissionService, landingDirectorGate, type SubmissionOptions } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-22T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const T1 = "a".repeat(40), T2 = "b".repeat(40), BASE = "c".repeat(40), PATCH = "d".repeat(40);

interface World { open(extra?: SubmissionOptions, storage?: ControllerStorage): SubmissionService; storage: ControllerStorage; svc: SubmissionService; agent(name: string, roles: string[]): Promise<Principal>; task: string; raw(kind: string, id: string): Promise<unknown> }

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
        const open = (extra: SubmissionOptions = {}, storage: ControllerStorage = world.storage): SubmissionService => SubmissionService.withEpoch(storage, projects.epoch, async (id) => roles.get(id) ?? [], { ...options, ...extra });
        await body({ open, storage: world.storage, svc: open(), agent, task, raw: async (kind, id) => (await world.storage.getAggregate({ kind, id }))?.body });
      } finally { await world.close(); }
    });

  suite("the newest director sign-off is answered with the submission (none: no director field); a repeat records once; a later decline replaces an approval; the newest 50 are kept, so a 51st decline still decides", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const dee = await c.agent("dee", ["director"]);
    const dot = await c.agent("dot", ["director"]);
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    assert.equal("director" in ((await c.svc.approvalOf(code.id)) ?? {}), false, "no sign-off, no director field");
    assert.equal(await c.raw("submission-signoffs", code.id), undefined);
    const gate = landingDirectorGate(c.svc);
    assert.deepEqual(await gate(code.id), { submissionId: code.id, taskId: c.task, tree: T1 });
    const first = await c.svc.record(dee, { commandId: "p09-so-1", taskId: c.task, kind: "signoff", role: "director", subject: code.id, decision: "approve" });
    await c.svc.record(dee, { commandId: "p09-so-1", taskId: c.task, kind: "signoff", role: "director", subject: code.id, decision: "approve" });
    assert.deepEqual(((await c.raw("submission-signoffs", code.id)) as { signoffs: { id: string }[] }).signoffs.map((x) => x.id), [first.id], "a repeat adds nothing");
    assert.deepEqual((await c.svc.approvalOf(code.id))?.director, { newest: "approve", by: dee.id, signoffId: first.id });
    const decline = await c.svc.record(dot, { commandId: cid("so"), taskId: c.task, kind: "signoff", role: "director", subject: code.id, decision: "decline" });
    assert.deepEqual((await gate(code.id))?.signoff, { newest: "decline", by: dot.id, signoffId: decline.id });
    // A sign-off does not change what a review says.
    assert.equal((await c.svc.approvalOf(code.id))?.approved, false);
    for (let i = 0; i < 48; i++) await c.svc.record(i % 2 === 0 ? dee : dot, { commandId: cid("many"), taskId: c.task, kind: "signoff", role: "director", subject: code.id, decision: "approve" });
    assert.equal(((await c.raw("submission-signoffs", code.id)) as { signoffs: unknown[] }).signoffs.length, 50);
    assert.equal((await gate(code.id))?.signoff?.newest, "approve");
    // The 51st, a decline, is recorded and decides: the list keeps the newest 50 (the oldest drops off), so a decline is never refused for the list's size.
    const late = await c.svc.record(dee, { commandId: cid("so"), taskId: c.task, kind: "signoff", role: "director", subject: code.id, decision: "decline" });
    const kept = ((await c.raw("submission-signoffs", code.id)) as { signoffs: { id: string }[] }).signoffs.map((x) => x.id);
    assert.equal(kept.length, 50);
    assert.equal(kept.includes(first.id), false, "the oldest sign-off dropped off");
    assert.equal(kept[kept.length - 1], late.id);
    assert.equal(kept[0], decline.id);
    assert.deepEqual((await gate(code.id))?.signoff, { newest: "decline", by: dee.id, signoffId: late.id });
    // And an approval after it decides again.
    const again = await c.svc.record(dot, { commandId: cid("so"), taskId: c.task, kind: "signoff", role: "director", subject: code.id, decision: "approve" });
    assert.deepEqual((await gate(code.id))?.signoff, { newest: "approve", by: dot.id, signoffId: again.id });
    assert.equal(((await c.raw("submission-signoffs", code.id)) as { signoffs: unknown[] }).signoffs.length, 50);
    // Only a code submission is answered; a document or a sign-off ID is not one.
    assert.equal(await gate(first.id), undefined);
    assert.equal(await gate("sbm-aaaaaaaaaaaaaaaaaaaa"), undefined);
    assert.equal(await gate("nonsense"), undefined);
  });

  suite("sign-offs of one submission recorded at the same moment are all kept (the list is rebuilt, never a director's sign-off refused as a used command ID)", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const dee = await c.agent("dee", ["director"]);
    const dot = await c.agent("dot", ["director"]);
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    const other = c.open();
    for (let round = 0; round < 3; round++) {
      const made = await Promise.all([
        c.svc.record(dee, { commandId: cid("a"), taskId: c.task, kind: "signoff", role: "director", subject: code.id, decision: "decline" }),
        other.record(dot, { commandId: cid("b"), taskId: c.task, kind: "signoff", role: "director", subject: code.id, decision: "approve" }),
      ]);
      const listed = ((await c.raw("submission-signoffs", code.id)) as { signoffs: { id: string }[] }).signoffs.map((x) => x.id);
      assert.equal(listed.length, 2 * (round + 1));
      for (const m of made) assert.ok(listed.includes(m.id), `sign-off ${m.id} is in the list`);
    }
  });

  suite("a sign-off whose list write keeps losing is built again a bounded number of times, then answered unavailable with nothing recorded; sent again later it is recorded once", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const dee = await c.agent("dee", ["director"]);
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    let writes = 0;
    const losing = new Proxy(c.storage, { get: (target, key) => {
      if (key === "applyOperation") {
        return async (input: Parameters<ControllerStorage["applyOperation"]>[0]) => {
          if (input.changes.some((change) => change.ref.kind === "submission-signoffs")) { writes++; throw new StorageError("revision_conflict", "the sign-off list changed meanwhile (test)"); }
          return target.applyOperation(input);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    } });
    const signoff = { commandId: "p09-bounded-1", taskId: c.task, kind: "signoff" as const, role: "director", subject: code.id, decision: "approve" as const };
    await refuses("unavailable", () => c.open({}, losing).record(dee, signoff), /another sign-off of submission sbm-[a-z2-7]+ was recorded at the same moment; send this one again/);
    assert.equal(writes, 5, "built and written again at most five times in all");
    assert.equal(await c.raw("submission-signoffs", code.id), undefined, "nothing was recorded");
    assert.equal("director" in ((await c.svc.approvalOf(code.id)) ?? {}), false);
    const made = await c.svc.record(dee, signoff);
    const again = await c.svc.record(dee, signoff);
    assert.deepEqual([again.id, again.replayed], [made.id, true]);
    assert.deepEqual(((await c.raw("submission-signoffs", code.id)) as { signoffs: { id: string }[] }).signoffs.map((x) => x.id), [made.id]);
  });
}

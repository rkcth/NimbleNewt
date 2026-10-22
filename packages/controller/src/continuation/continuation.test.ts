import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DeskService, InspectionService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ContinuationService, type ContinuationInput } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T19:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const DIGEST = `v1:sha256:${"a".repeat(64)}`;

for (const backend of backends) {
  test(`${backend.name}: continuation capture and resume`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const make = async (kind: "agent" | "host" | "service", name: string, grants: Grant[] = []) => { await principals.enroll(owner, { commandId: cid("e"), kind, name, grants }); return principals.authenticate((await principals.issueCredential(owner, `${kind}:${name}`)).token); };
      const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
      const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
      const ta = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "in A" })).id;
      const tb = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: b, title: "in B" })).id;
      const host = await make("host", "h1");
      const ann = await make("agent", "ann", [{ action: "attempt.work", project: a }, { action: "desk.write", project: a }, { action: "desk.read", project: a }]);
      const stranger = await make("agent", "zed", [{ action: "task.read", project: a }]);
      const service = await make("service", "recovery", [{ action: "recovery.read", project: "*" }]);
      const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
      const inspection = InspectionService.withEpoch(world.storage, projects.epoch, options);
      const svc = ContinuationService.withEpoch(world.storage, projects.epoch, { ...options, inspection });
      const scratch = await desks.write(ann, { commandId: cid("w"), projectId: a, kind: "note", title: "notes", body: "half-finished idea", visibility: "private" } as never);

      const input = (extra: Partial<ContinuationInput> = {}): ContinuationInput => ({
        identity: "conv-ann-1", agent: "agent:ann", boundary: { kind: "turn-complete" }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
        continuation: { artifacts: ["art-aaaaaaaaaaaaaaaaaaaa"], decisions: ["dsk-bbbbbbbbbbbbbbbbbbbb"], pendingEffects: [{ effectId: "eff-cccccccccccccccccccc", state: "intended" }], budget: { spent: 120, remaining: 880, unit: "k-tokens" }, nextStep: "run the migration tests" },
        manifest: { summaryLineage: ["sum-dddddddddddddddddddd"], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "compacted", compactions: 2 }, branches: [{ conversationId: 8, parent: 7 }], messageCursor: 41, routingRevision: 3, environmentRevision: 2, adapter: { name: "pi-durable", version: "1.3.0" } },
        nonCheckpointableTools: [{ name: "shell", reason: "its effects are outside the history" }], scratchRecords: [scratch.id], credentialRefs: ["git.token"], ...extra });
      const capture = (by: Principal, extra: Partial<ContinuationInput> = {}, task = ta) => svc.capture(by, { commandId: cid("cap"), taskId: task, ...input(extra) });

      // A complete capture keeps everything the card lists, and a repeat is the same capture.
      const id = cid("keep");
      const one = await svc.capture(host, { commandId: id, taskId: ta, ...input() });
      assert.deepEqual([one.seq, one.status, one.replayed], [1, "complete", false]);
      const again = await svc.capture(host, { commandId: id, taskId: ta, ...input() });
      assert.deepEqual([again.id, again.replayed], [one.id, true]);
      const latest = (await svc.latest(host, ta))!;
      assert.equal(latest.continuation.nextStep, "run the migration tests");
      assert.deepEqual([latest.nonCheckpointableTools[0]!.name, latest.manifest.compression.state, latest.credentialRefs], ["shell", "compacted", ["git.token"]]);
      assert.equal(await svc.latest(stranger, ta), undefined, "only those who work on or read the task's history");

      // Timeout is a boundary too; a turn in progress never is.
      assert.equal((await capture(host, { boundary: { kind: "timeout" } })).seq, 2);
      await refuses("invalid_command", () => capture(host, { boundary: { kind: "turn-complete", turnInProgress: true } }), (e) => assert.equal(e.field, "boundary"));
      await refuses("invalid_command", () => capture(host, { boundary: { kind: "mid-turn" as never } }));

      // A failed durability check is kept as incomplete, never offered to resume, and never replaces the latest complete one.
      const failed = await capture(host, { durable: { verified: false, error: "disk full while writing the checkpoint" } });
      assert.deepEqual([failed.status, failed.seq], ["incomplete", 3]);
      assert.equal((await svc.latest(host, ta))!.seq, 2);
      await refuses("invalid_transition", () => svc.resume(host, { commandId: cid("r"), taskId: ta, continuationId: failed.id, model: { provider: "local", id: "m1" }, after: "restart" }));

      // An agent cannot declare its own checkpoint durable, name another agent's scratch, or capture for someone else.
      const own = await capture(ann);
      assert.equal(own.status, "incomplete");
      assert.equal((await svc.latest(host, ta))!.seq, 2);
      const zedScratch = await desks.write(stranger, { commandId: cid("w"), projectId: a, kind: "note", title: "z", body: "zed's private idea", visibility: "private" } as never).catch(() => undefined);
      void zedScratch;
      const benScratch = await make("agent", "ben", [{ action: "desk.write", project: a }, { action: "desk.read", project: a }]).then((p) => desks.write(p, { commandId: cid("w"), projectId: a, kind: "note", title: "b", body: "ben's private idea", visibility: "private" } as never));
      await refuses("invalid_command", () => capture(ann, { scratchRecords: [benScratch.id] }), (e) => assert.match(e.field ?? "", /scratchRecords/));
      await refuses("invalid_command", () => capture(host, { scratchRecords: [benScratch.id] }));
      await refuses("invalid_command", () => capture(ann, { agent: "agent:ben" }), (e) => assert.equal(e.field, "agent"));
      const other = await desks.write(ann, { commandId: cid("w"), projectId: b, kind: "note", title: "o", body: "ann in B", visibility: "private" } as never).catch(() => undefined);
      if (other !== undefined) await refuses("invalid_command", () => capture(host, { scratchRecords: [other.id] }));

      // No secret anywhere; credentials only by name.
      for (const bad of [{ continuation: { ...input().continuation, nextStep: "use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH to call" } }, { credentialRefs: ["Bearer abcdefghijklmnopqrstuvwxyz0123456789"] }, { nonCheckpointableTools: [{ name: "x", reason: "password=hunter2hunter2hunter2 in env" }] }])
        await assert.rejects(() => capture(host, bad as never), DomainError, JSON.stringify(bad).slice(0, 60));

      // Who and what: identity is fixed per task, other projects and unknown fields are refused.
      await refuses("invalid_command", () => capture(host, { identity: "conv-other" }), (e) => assert.equal(e.field, "identity"));
      await refuses("forbidden", () => capture(ann, {}, tb));
      await refuses("forbidden", () => capture(stranger));
      await assert.rejects(() => svc.capture(host, { commandId: cid("cap"), taskId: ta, ...input(), extra: 1 } as never), DomainError);
      await assert.rejects(() => capture(host, { checkpoint: { ...input().checkpoint, digest: "nope" } }), DomainError);

      // Resume after a restart and after a model change: the same conversation identity, the latest complete continuation.
      const restart = await svc.resume(host, { commandId: cid("r"), taskId: ta, model: { provider: "local", id: "m1" }, after: "restart" });
      assert.deepEqual([restart.identity, restart.continuation.seq, restart.modelChanged], ["conv-ann-1", 2, false]);
      const swapped = await svc.resume(host, { commandId: cid("r"), taskId: ta, model: { provider: "hosted", id: "m2" }, previousModel: { provider: "local", id: "m1" }, after: "model-change" });
      assert.deepEqual([swapped.identity, swapped.modelChanged, swapped.continuation.id], ["conv-ann-1", true, restart.continuation.id]);
      const rid = cid("r2");
      const first = await svc.resume(host, { commandId: rid, taskId: ta, model: { provider: "local", id: "m1" }, after: "continue" });
      assert.equal((await svc.resume(host, { commandId: rid, taskId: ta, model: { provider: "local", id: "m1" }, after: "continue" })).replayed, true);
      void first;
      await refuses("forbidden", () => svc.resume(stranger, { commandId: cid("r"), taskId: ta, model: { provider: "local", id: "m1" }, after: "restart" }));
      await refuses("not_found", () => svc.resume(host, { commandId: cid("r"), taskId: tb, model: { provider: "local", id: "m1" }, after: "restart" }));

      // Recovery reads scratch only through the inspection service, which leaves a record the agent can see.
      assert.equal((await inspection.inspections(ann)).items.length, 0);
      const rec = await svc.recoveryScratch(service, { commandId: cid("rs"), continuationId: one.id, reason: "restoring ann after a crash" });
      assert.deepEqual([rec.records.length, (rec.records[0] as { body: string }).body], [1, "half-finished idea"]);
      assert.equal((await inspection.inspections(ann)).items.length, 1);
      await refuses("invalid_transition", () => svc.recoveryScratch(service, { commandId: cid("rs"), continuationId: failed.id, reason: "x" }));
      await refuses("forbidden", () => svc.recoveryScratch(host, { commandId: cid("rs"), continuationId: one.id, reason: "just looking" }));
    } finally { await world.close(); }
  });
}

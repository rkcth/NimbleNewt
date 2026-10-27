import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { unlinkSync } from "node:fs";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a status question in the owner chat of the started controller is answered from the records, each line cites a record, and nothing is written (card U05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-status-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4,
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Fix the fence" })).id;
    const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });
    const turn = async (id: string, text: string, request: Record<string, unknown>) => { say[text] = [ask(request, text)]; return c.chat!.submit(boot.token, { messageId: id, text }); };
    const audit = async () => (await c.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((x) => !x.type.startsWith("chat.")).length;
    const before = await audit();

    const one = await turn("s1", "how is Fix the fence going", { kind: "task", taskId: task });
    assert.equal(one.outcomes[0]!.status, "answered", JSON.stringify(one.outcomes));
    assert.ok(one.outcomes[0]!.lines!.length > 0 && one.outcomes[0]!.lines!.every((l) => l.cites.length > 0), "every line cites a record");
    assert.match(one.reply.join("\n"), /Fix the fence is proposed and not yet ready/);
    const overview = await turn("s2", "what is going on in Garden", { kind: "overview", projectId: project });
    assert.equal(overview.outcomes[0]!.status, "answered", JSON.stringify(overview.outcomes));
    assert.match(overview.reply.join("\n"), /^As of /);
    const board = await turn("s3", "what is on the noticeboard", { kind: "noticeboard", projectId: project });
    assert.equal(board.outcomes[0]!.status, "answered", JSON.stringify(board.outcomes));
    assert.equal(await audit(), before, "answering writes no record");
    // The other views are reached too, each answered or honestly empty, never refused as unavailable: what changed, tools used, what was delivered, the failed event queue.
    for (const [id, text, request] of [
      ["s5", "what changed in Garden since the start", { kind: "changes", projectId: project, since: "2020-01-01T00:00:00.000Z" }],
      ["s6", "which tools were used in Garden", { kind: "tools", projectId: project }],
      ["s7", "what was delivered in Garden", { kind: "delivered", projectId: project }],
      ["s8", "show the failed events of Garden", { kind: "failed_events", projectId: project }],
    ] as const) {
      const r = await turn(id, text, { ...request });
      assert.equal(r.outcomes[0]!.status, "answered", `${request.kind}: ${JSON.stringify(r.outcomes)}`);
      assert.notEqual((r.outcomes[0] as { code?: string }).code, "unavailable", `${request.kind} is wired`);
    }
    const queue = await turn("s9", "show the failed events of Garden again", { kind: "failed_events", projectId: project });
    assert.equal(queue.outcomes[0]!.status, "answered", "the failed event queue can be listed in the running controller");
    // A made-up task is not a fabricated answer.
    const none = await turn("s4", "how is the moon task going", { kind: "task", taskId: "task-aaaaaaaaaaaaaaaaaaaa" });
    assert.notEqual(none.outcomes[0]!.status, "answered", JSON.stringify(none.outcomes));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a task credential may not read the failed event queue (card U05)", async () => {
  const { OPERATION_BY_NAME } = await import("./operations.js");
  const ctx = { principal: { id: "agent:ann", kind: "agent", name: "ann", grants: [], taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" } }, watches: { failures: async () => ({ items: [] }), inspect: async () => undefined } } as never;
  for (const op of ["events.failures", "events.handling", "events.loops"]) await assert.rejects(() => OPERATION_BY_NAME.get(op)!.run(ctx, {}, undefined), (e: { code?: string }) => e.code === "forbidden", op);
});

test("delivered artifacts are checked against their files and a failed event handling is listed and inspected in the composed status; a reader without the right sees none of it (card U05b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-status-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4,
    artifacts: { directory: join(d, "blobs") }, chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Fix the fence" })).id;
    const turn = async (id: string, text: string, request: Record<string, unknown>) => { say[text] = [{ kind: "status", request, evidence: text, basis: "owner" }]; return c.chat!.submit(boot.token, { messageId: id, text }); };

    // One artifact intact, one whose file was lost from the store.
    const blobs = await FileBlobStore.open({ directory: join(d, "blobs") });
    const artifacts = ArtifactService.withEpoch(c.storage, c.epoch, blobs);
    const file = (path: string, text: string) => ({ path, content: Buffer.from(text) });
    await artifacts.publish({ commandId: "a-good", actor: rob.id, name: "plans.txt", projectId: project, taskId: task, files: [file("plans.txt", "the plan")] });
    await artifacts.publish({ commandId: "a-bad", actor: rob.id, name: "lost.txt", projectId: project, taskId: task, files: [file("lost.txt", "a file that goes missing")] });
    const { digest } = await blobs.put(Buffer.from("a file that goes missing"));
    unlinkSync(blobs.pathOf(digest));
    const delivered = (await turn("d1", "what was delivered in Garden", { kind: "delivered", projectId: project })).reply.join("\n");
    assert.match(delivered, /plans\.txt.*its files were checked and match/s);
    assert.match(delivered, /lost\.txt.*missing or do not match, so it is NOT counted as delivered/s);
    assert.doesNotMatch(delivered, /have not been checked/);

    // A failed handling, seeded as the event service would leave it.
    const id = "evh-aaaaaaaaaaaaaaaaaaaa";
    const body = { watchId: "wat-aaaaaaaaaaaaaaaaaaaa", subscriptionId: "sub-aaaaaaaaaaaaaaaaaaaa", taskId: task, projectId: project, stream: `project:${project}`, owner: { kind: "agent", id: "ann" }, events: [], skipped: [], through: 0, reconcile: false, reasons: ["task completed"], state: "failed", round: 0, attempts: 2, counted: false, failure: { by: "delivery", at: "2026-10-27T01:00:00.000Z", error: "disk full" }, createdAt: "2026-10-27T00:59:00.000Z" };
    await c.storage.applyOperation({ operationId: "seed-handling", epoch: c.epoch, actor: "test", correlationId: "seed", at: "2026-10-27T01:00:00.000Z", changes: [{ type: "create", ref: { kind: "event-handling", id }, body }], audit: [{ type: "seed", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    const listed = (await turn("f1", "show the failed events of Garden", { kind: "failed_events", projectId: project })).reply.join("\n");
    assert.match(listed, new RegExp(`Failed to hand over events for task ${task} after 2 attempts`));
    const inspected = (await turn("f2", "look at that failed event", { kind: "failed_event", handlingId: id })).reply.join("\n");
    assert.match(inspected, new RegExp(`Handling ${id} for task ${task} is failed after 2 attempts`));
    assert.match(inspected, /disk full/);

    // Somebody with no right to read the project's histories sees neither the queue nor the handling.
    await c.services.principals.enroll(rob, { commandId: "e-eve", kind: "agent", name: "eve", grants: [{ action: "task.read", project }] });
    const eve = (await c.services.principals.issueCredential(rob, "agent:eve")).token;
    const asEve = (op: string, args: Record<string, unknown>) => c.api.handle(eve, { v: 1, op, args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    assert.deepEqual((await asEve("events.failures", {})).result?.items ?? [], []);
    assert.equal((await asEve("events.handling", { handlingId: id })).error?.code, "not_found");
    const asOwner = await c.api.handle(boot.token, { v: 1, op: "events.handling", args: { handlingId: id } } as never) as { ok: boolean };
    assert.ok(asOwner.ok, "the owner reads it");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

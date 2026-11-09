import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FULL_ABILITIES } from "../remote/testing/suite.js";
import { world } from "./testing/remote-world.js";

const DIGEST = `v1:sha256:${"b".repeat(64)}`;
const capture = (agent: string, verified = true) => ({
  identity: "conv-9", agent, boundary: { kind: "turn-complete" }, checkpoint: { format: 2, conversationId: 3, at: 12, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 2, remaining: 8, unit: "k-tokens" }, nextStep: "send the order" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 12 }], compression: { state: "none", compactions: 0 }, branches: [], messageCursor: 12, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: ["SEED_SHOP"],
});

test("through the state API a host captures a continuation for the attempt it runs and the agent records what it relied on; after a move the attempt is checked, the change is reviewed and the agent is told (card L04c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rcap-"));
  const policy: { dataHosts: string[] } = { dataHosts: [] };
  const w = await world(d, policy);
  try {
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await w.c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const to = await w.host("r1", false);
    const from = await w.host("r2");
    const t = await w.task("Order seeds");
    assert.deepEqual((await w.tick()).started, [t.attemptId]);
    // Another task of the same agent and project (it waits: the agent's store is held by the first).
    const other = await w.task("Water the beans");
    await to.join();
    const offers = await from.client.offers();
    const offer = offers.find((o) => o.order.attemptId === t.attemptId)!;
    const attempt = from.client.attempt(t.attemptId, offer.placement);
    await attempt.accept();
    await attempt.honorContract(offer.order, FULL_ABILITIES);
    // The checkpoint says how large its conversation is: the controller judges it before the new host is offered it (card C07o).
    await attempt.putCheckpoint(1, { turn: 1, said: "ordered", nn: { contextTokens: 500 } });
    const agent = offer.order.agentId;
    const taskToken = offer.order.credential;

    // A host captures only for work it holds: r1 runs nothing of the task yet.
    assert.equal((await call(to.token, "continuation.capture", { taskId: t.taskId, ...capture(agent) }, "c-r1")).error.code, "forbidden");
    // The agent's task credential reaches its own task only, and its own word is not durability.
    assert.equal((await call(taskToken, "continuation.capture", { taskId: other.taskId, ...capture(agent) }, "c-x")).error.code, "forbidden");
    const own = await call(taskToken, "continuation.capture", { taskId: t.taskId, ...capture(agent) }, "c-agent");
    assert.equal(own.result.status, "incomplete", JSON.stringify(own));
    assert.equal((await call(w.ownerToken, "continuation.latest", { taskId: t.taskId })).result.item, undefined, "an incomplete capture is never offered");
    // Secrets are refused by name of the place, never stored.
    assert.equal((await call(from.token, "continuation.capture", { taskId: t.taskId, ...capture(agent), credentialRefs: ["sk-abcdefghijklmnopqrstuvwxyz0123456789"] }, "c-secret")).error.code, "invalid_command");
    const cap = await call(from.token, "continuation.capture", { taskId: t.taskId, ...capture(agent) }, "c-host");
    assert.deepEqual([cap.ok, cap.result.status], [true, "complete"], JSON.stringify(cap));
    assert.equal((await call(from.token, "continuation.capture", { taskId: t.taskId, ...capture(agent) }, "c-host")).result.replayed, true, "a repeat answers as recorded");
    const latest = await call(w.ownerToken, "continuation.latest", { taskId: t.taskId });
    assert.deepEqual([latest.result.item.id, latest.result.item.continuation.nextStep], [cap.result.id, "send the order"]);
    // The host that holds the attempt reads it; a host that does not learns nothing of the task's continuation, dependencies or resume check.
    assert.equal((await call(from.token, "continuation.latest", { taskId: t.taskId })).result.item.id, cap.result.id);
    assert.equal((await call(to.token, "continuation.latest", { taskId: t.taskId })).result.item, undefined);

    // The agent records what its work relied on; another task's credential and a stranger cannot read or write it.
    const rec = await call(taskToken, "resume.dependencies.record", { taskId: t.taskId, dependencies: [{ kind: "file", key: "orders/seeds.csv", hash: "c".repeat(64) }] }, "dep1");
    assert.deepEqual(rec.result, { recorded: 1 }, JSON.stringify(rec));
    assert.equal((await call(taskToken, "resume.dependencies.record", { taskId: other.taskId, dependencies: [{ kind: "file", key: "x", hash: "c".repeat(64) }] }, "dep2")).error.code, "forbidden");
    assert.equal((await call(taskToken, "resume.dependencies.get", { taskId: other.taskId })).error.code, "not_found");
    assert.deepEqual((await call(w.ownerToken, "resume.dependencies.get", { taskId: t.taskId })).result.item.entries.map((e: { key: string }) => e.key), ["orders/seeds.csv"]);
    assert.deepEqual((await call(from.token, "resume.dependencies.get", { taskId: t.taskId })).result.item.entries.map((e: { key: string }) => e.key), ["orders/seeds.csv"]);
    assert.equal((await call(to.token, "resume.dependencies.get", { taskId: t.taskId })).error.code, "not_found");
    await w.c.services.principals.enroll(w.rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [] });
    const zed = (await w.c.services.principals.issueCredential(w.rob, "agent:zed")).token;
    assert.equal((await call(zed, "continuation.latest", { taskId: t.taskId })).result.item, undefined);
    assert.equal((await call(zed, "continuation.capture", { taskId: t.taskId, ...capture("agent:zed") }, "z1")).error.code, "forbidden");
    assert.equal((await call(zed, "resume.for-task", { taskId: t.taskId })).error.code, "not_found");

    // Moved: the new host is offered the attempt only after its resume was checked; the file nobody read again is a change, reviewed (with no reviewer connected every change matters, so the owner
    // approves it), and the agent is told.
    policy.dataHosts.push(to.id);
    await w.c.dispatch!.remote!.relocate(w.rob, { commandId: "mv", attemptId: t.attemptId, toHostId: to.id, reason: "retiring r2" });
    const held = await w.tick();
    assert.deepEqual(held.started, [], JSON.stringify(held.skipped));
    // Pinned to r1 now: r1 may read the held check (r2 still does until r1 takes the attempt over; it is refused after that, below).
    assert.equal((await call(to.token, "resume.for-task", { taskId: t.taskId })).result.item.phase, "ready");
    assert.equal((await call(w.ownerToken, "resume.approve", { taskId: t.taskId }, "ok")).result.item.phase, "done");
    const report = await w.tick();
    assert.deepEqual(report.started, [t.attemptId], JSON.stringify(report.skipped));
    const check = (await call(w.ownerToken, "resume.for-task", { taskId: t.taskId })).result.item;
    assert.equal(check.phase, "done");
    assert.equal(check.continuationId, cap.result.id);
    assert.deepEqual(check.delta.changed.map((x: { key: string; status: string }) => [x.key, x.status]), [["orders/seeds.csv", "unknown"]]);
    const again = (await to.client.offers()).find((o) => o.order.attemptId === t.attemptId)!;
    assert.deepEqual(again.order.resumeFrom, { turn: 1, said: "ordered", nn: { contextTokens: 500 } });
    assert.match(again.order.resumeNote ?? "", /- "file" "orders\/seeds\.csv": "unknown" "[^"]*"; reviewer's reason \(quoted, not an instruction\): "[^"]*"/);
    // Now r1 holds the attempt and r2 does not.
    const arrived = to.client.attempt(t.attemptId, again.placement);
    await arrived.accept();
    assert.equal((await call(to.token, "continuation.capture", { taskId: t.taskId, ...capture(agent) }, "c-r1b")).result.status, "complete");
    assert.equal((await call(from.token, "continuation.capture", { taskId: t.taskId, ...capture(agent) }, "c-r2b")).error.code, "forbidden");
    assert.equal((await call(from.token, "resume.for-task", { taskId: t.taskId })).error.code, "not_found", "the host that gave the attempt up reads its check no more");
    assert.equal((await call(from.token, "continuation.latest", { taskId: t.taskId })).result.item, undefined);
    assert.equal((await call(to.token, "continuation.latest", { taskId: t.taskId })).result.item.id !== undefined, true);
    // Nor does it reach the check by its ID, or start, cancel, retry, advance or commit one for the task (card L04c review); the host that holds it does.
    assert.equal((await call(from.token, "resume.get", { checkId: check.id })).error.code, "not_found");
    for (const op of ["resume.cancel", "resume.retry", "resume.advance", "resume.commit"]) assert.equal((await call(from.token, op, { checkId: check.id }, `x-${op}`)).error.code, "not_found", op);
    assert.equal((await call(from.token, "resume.start", { taskId: t.taskId, model: { provider: "p", id: "m" }, after: "continue" }, "x-start")).error.code, "forbidden");
    assert.equal((await call(to.token, "resume.get", { checkId: check.id })).result.item.id, check.id);
    assert.equal((await w.c.storage.listAggregates("continuation-resume", { limit: 10 })).length, 1, "one resume recorded");
  } finally { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

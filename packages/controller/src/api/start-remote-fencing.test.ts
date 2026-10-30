import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { RemoteWorkerClient, WorkerRequestError } from "../remote/index.js";
import { AGENT, CAPS, world } from "./testing/remote-world.js";


const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
const wireRefuses = async (code: string, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof WorkerRequestError, String(e)); assert.equal(e.code, code, e.message); assert.equal(e.status, 409); return true; });
};

test("a partition: a worker that falls silent is lost when its lease ends and every late packet from it, over the wire, is fenced and changes nothing (card H02c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-fence-"));
  const w = await world(d, {} as never);
  try {
    const r1 = await w.host("r1");
    const first = await w.task("Order seeds");
    const report = await w.tick();
    assert.deepEqual(report.started, [first.attemptId]);
    const offer = (await r1.client.offers())[0]!;
    const attempt = r1.client.attempt(first.attemptId, offer.placement);
    await attempt.accept();
    w.advance(61_000);
    await r1.beat();
    const lost = await w.tick();
    assert.deepEqual(lost.lost, [first.attemptId]);
    await wireRefuses("fenced", () => attempt.heartbeat());
    await wireRefuses("fenced", () => attempt.putCheckpoint(5, { late: true }));
    await wireRefuses("fenced", () => attempt.complete({ status: "completed" }));
    assert.equal((await w.c.dispatch!.remote!.placement(w.rob, first.attemptId))!.state, "ended");
    assert.equal((await w.c.dispatch!.dispatcher.get(w.rob, first.attemptId))!.outcome!.status, "abandoned", "the late result did not turn the lost attempt into a success");
    // The next attempt of the task is offered with a higher number: the old worker cannot take it by presenting its own.
    assert.equal(lost.readmitted.length, 1);
    const next = (await r1.client.offers())[0]!;
    assert.equal(next.placement, 1);
    assert.notEqual(next.order.attemptId, first.attemptId);
    await wireRefuses("fenced", () => r1.client.attempt(next.order.attemptId, next.placement + 5).accept());
    await wireRefuses("fenced", () => attempt.heartbeat());
  } finally { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("moving an attempt to another host: the policy and the integrity of what travels are checked first and refusals change nothing; the move fences the old host, hands over the store and the new host restarts from the checkpoint (card H02c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-fence-"));
  const policy: { dataHosts: string[] } = { dataHosts: [] };
  const w = await world(d, policy);
  try {
    // r1 is first in the dispatcher's order but has not connected, so the attempt starts on r2; r1 is the host it is moved to.
    const to = await w.host("r1", false);
    const from = await w.host("r2");
    const t = await w.task("Order seeds");
    const started = await w.tick();
    assert.deepEqual(started.started, [t.attemptId], JSON.stringify(started.skipped));
    assert.equal((await w.c.dispatch!.remote!.placement(w.rob, t.attemptId))!.hostId, from.id);
    await to.join();
    const offer = (await from.client.offers())[0]!;
    const attempt = from.client.attempt(t.attemptId, offer.placement);
    await attempt.accept();
    await attempt.putCheckpoint(1, { turn: 1, said: "ordered" });
    const move = (key: string) => w.c.dispatch!.remote!.relocate(w.rob, { commandId: key, attemptId: t.attemptId, toHostId: to.id, reason: "the host is being retired" });
    const refuses = async (code: string, key: string, message?: RegExp): Promise<void> => {
      await assert.rejects(move(key), (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, e.message); if (message !== undefined) assert.match(e.message, message); return true; });
      const p = (await w.c.dispatch!.remote!.placement(w.rob, t.attemptId))!;
      assert.deepEqual([p.hostId, p.state, p.relocations], [from.id, "accepted", 0], `${key}: nothing changed`);
      assert.equal((await w.c.dispatch!.remote!.store(w.rob, `agent:${AGENT}`))!.ownerHostId, from.id, `${key}: the store stayed`);
      assert.equal((await attempt.heartbeat()).until > w.now(), true, `${key}: the old host goes on`);
    };
    // Local-only data may only go to a host the policy lists.
    await refuses("invalid_transition", "mv-policy", /data/i);
    // A host the attempt is not placed on cannot take it up, whatever the number: it reads as missing.
    await assert.rejects(to.client.attempt(t.attemptId, offer.placement).accept(), (e: unknown) => e instanceof WorkerRequestError && e.code === "not_found");
    policy.dataHosts.push(to.id);
    // A checkpoint whose bytes were changed is never handed on.
    const blobs = files(join(d, "blobs"));
    assert.ok(blobs.length > 0);
    const saved = blobs.map((p) => ({ p, bytes: readFileSync(p) }));
    for (const { p, bytes } of saved) { chmodSync(p, 0o666); writeFileSync(p, Buffer.alloc(bytes.length, 0x58)); }
    await refuses("integrity", "mv-damaged");
    for (const { p, bytes } of saved) writeFileSync(p, bytes);
    // Whole again, the move goes through: the old host is fenced on every message, the new one is offered the attempt with the checkpoint.
    const moved = await move("mv-ok");
    assert.deepEqual([moved.from, moved.to], [from.id, to.id]);
    await wireRefuses("fenced", () => attempt.heartbeat());
    await wireRefuses("fenced", () => attempt.complete({ status: "completed" }));
    await wireRefuses("fenced", () => attempt.putCheckpoint(9, { late: true }));
    assert.equal((await w.c.dispatch!.remote!.latestCheckpoint(w.rob, t.attemptId))!.sequence, 1, "the old host's late checkpoint did not replace the one that was handed on");
    assert.equal((await w.c.dispatch!.remote!.store(w.rob, `agent:${AGENT}`))!.ownerHostId, to.id, "the store went with it");
    const report = await w.tick();
    assert.deepEqual(report.started, [t.attemptId]);
    const again = (await to.client.offers())[0]!;
    assert.equal(again.placement, moved.placement);
    assert.deepEqual(again.order.resumeFrom, (await w.c.dispatch!.remote!.latestCheckpoint(w.rob, t.attemptId))!.checkpoint, "the new host restarts from the checkpoint the old one sent");
    assert.deepEqual(again.order.resumeFrom, { turn: 1, said: "ordered" });
    await to.client.attempt(t.attemptId, again.placement).accept();
    // Repeating the command after the new host took the attempt up is answered, not done again.
    assert.equal((await move("mv-ok")).to, to.id);
    assert.equal((await w.c.dispatch!.remote!.placement(w.rob, t.attemptId))!.relocations, 1, "one move, however often it was asked for");
    assert.equal((await from.client.offers()).length, 0, "the old host is offered nothing");
  } finally { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a move whose checkpoint has no captured continuation does not wait on a resume check: the new host is offered the attempt from the checkpoint (card L04c, after H02c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-fence-"));
  const policy: { dataHosts: string[] } = { dataHosts: [] };
  const w = await world(d, policy);
  try {
    const to = await w.host("r1", false);
    const from = await w.host("r2");
    policy.dataHosts.push(to.id);
    const t = await w.task("Order seeds");
    assert.deepEqual((await w.tick()).started, [t.attemptId]);
    await to.join();
    const offer = (await from.client.offers())[0]!;
    const attempt = from.client.attempt(t.attemptId, offer.placement);
    await attempt.accept();
    await attempt.putCheckpoint(1, { turn: 1, said: "ordered" });
    assert.equal(await w.c.services.resumes.hasContinuation(w.rob, t.taskId), false, "nothing was captured for the task");
    const moved = await w.c.dispatch!.remote!.relocate(w.rob, { commandId: "mv-nocont", attemptId: t.attemptId, toHostId: to.id, reason: "retiring" });
    const report = await w.tick();
    assert.deepEqual(report.started, [t.attemptId], JSON.stringify(report.skipped));
    assert.deepEqual(report.blocked, [], "no blocker for a resume with nothing to check");
    assert.equal((await w.c.services.resumes.forTask(w.rob, t.taskId)), undefined, "no resume check was made");
    const again = (await to.client.offers())[0]!;
    assert.equal(again.placement, moved.placement);
    assert.deepEqual(again.order.resumeFrom, { turn: 1, said: "ordered" });
  } finally { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the native store of an agent has one owner host: another task of the agent waits while an attempt holds it, then runs on the same host, and only the owner moves the store (card H02c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-fence-"));
  const w = await world(d, { dataHosts: [] });
  try {
    // The store belongs to r2, the second host in the dispatcher's order: only the pin sends the agent's next task there once r1 is connected too.
    const other = await w.host("r1", false);
    const mine = await w.host("r2");
    const first = await w.task("one");
    assert.deepEqual((await w.tick()).started, [first.attemptId]);
    assert.equal((await w.c.dispatch!.remote!.store(w.rob, `agent:${AGENT}`))!.ownerHostId, mine.id);
    await other.join();
    const second = await w.task("two");
    const waiting = await w.tick();
    assert.deepEqual(waiting.started, []);
    assert.match(waiting.skipped.find((x) => x.attemptId === second.attemptId)?.reason ?? "", /native store of agent:.* is held by another attempt/);
    assert.deepEqual(waiting.blocked, [], "waiting for the store is not a blocker");
    const offer = (await mine.client.offers())[0]!;
    const run = mine.client.attempt(first.attemptId, offer.placement);
    await run.accept();
    await run.complete({ status: "completed" });
    await w.c.dispatch!.dispatcher.idle?.();
    const go = await w.tick();
    assert.deepEqual(go.started, [second.attemptId], JSON.stringify(go.skipped));
    assert.equal((await w.c.dispatch!.dispatcher.get(w.rob, second.attemptId))!.hostId, mine.id, "on the host that owns the store, not the other");
    assert.equal((await other.client.offers()).length, 0);
    // The agent itself and a host cannot move the store; the owner can once no attempt holds it.
    const ann = await w.c.services.principals.authenticate((await w.c.services.principals.issueCredential(w.rob, `agent:${AGENT}`)).token);
    const forbidden = (e: unknown): boolean => e instanceof DomainError && e.code === "forbidden";
    await assert.rejects(w.c.dispatch!.remote!.moveStore(ann, { commandId: "ms-1", agentId: `agent:${AGENT}`, toHostId: other.id }), forbidden);
    await assert.rejects(w.c.dispatch!.remote!.moveStore(mine.principal, { commandId: "ms-2", agentId: `agent:${AGENT}`, toHostId: other.id }), forbidden);
    const secondOffer = (await mine.client.offers())[0]!;
    const second2 = mine.client.attempt(second.attemptId, secondOffer.placement);
    await second2.accept();
    await second2.complete({ status: "completed" });
    await w.c.dispatch!.dispatcher.idle();
    await w.c.dispatch!.remote!.moveStore(w.rob, { commandId: "ms-3", agentId: `agent:${AGENT}`, toHostId: other.id });
    assert.equal((await w.c.dispatch!.remote!.store(w.rob, `agent:${AGENT}`))!.ownerHostId, other.id, "the owner moved it");
  } finally { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

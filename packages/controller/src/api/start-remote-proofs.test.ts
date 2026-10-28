import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { SESSION_HEADER, PROTOCOL_HEADER, WorkerRequestError } from "../remote/index.js";
import { rawRequest } from "../remote/testing/world.js";
import { AGENT, CAPS, world } from "./testing/remote-world.js";

const BOTH = { dataHosts: ["host:r1", "host:r2"] };
const until = async (what: string, ok: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 500; i++) { if (await ok()) return; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail(`never happened: ${what}`);
};
const asksForCheckpoint = (messages: readonly unknown[]): boolean => messages.some((m) => (m as { kind?: string }).kind === "checkpoint" || (m as { message?: { kind?: string } }).message?.kind === "checkpoint");
const fenced = (e: unknown): boolean => { assert.ok(e instanceof WorkerRequestError, String(e)); assert.equal(e.code, "fenced", e.message); return true; };

test("the owner's stop reaches a remote worker through its own poll and ends the attempt: a stop asks for a last checkpoint first, an emergency stop does not, and the worker is fenced afterwards (card H02d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-stop-"));
  const w = await world(d, BOTH, { checkpointWaitMs: 20_000 });
  try {
    const r1 = await w.host("r1");
    const first = await w.task("Order seeds");
    assert.deepEqual((await w.tick()).started, [first.attemptId]);
    const attempt = r1.client.attempt(first.attemptId, (await r1.client.offers())[0]!.placement);
    await attempt.accept();
    // A stop first asks the worker for a checkpoint: the request arrives through the worker's own poll, and the stop finishes when the worker answers it.
    const stopping = w.c.dispatch!.dispatcher.stop(w.rob, first.attemptId, { reason: "the owner stopped the work" });
    const outcome = stopping.then(() => "stopped" as const, (e: unknown) => e);
    let seq = 0;
    await until("the worker is asked for a checkpoint", async () => asksForCheckpoint(await attempt.pollControl(0)));
    assert.equal(await Promise.race([outcome, new Promise((r) => setTimeout(() => r("waiting"), 100))]), "waiting", "the stop waits for the checkpoint");
    await attempt.putCheckpoint(++seq, { turn: 3, said: "ordered" });
    assert.equal(await outcome, "stopped");
    assert.equal((await w.c.dispatch!.remote!.placement(w.rob, first.attemptId))!.state, "ended");
    assert.equal((await w.c.dispatch!.dispatcher.get(w.rob, first.attemptId))!.outcome!.status, "abandoned");
    assert.deepEqual((await w.c.dispatch!.remote!.latestCheckpoint(w.rob, first.attemptId))!.checkpoint, { turn: 3, said: "ordered" });
    // The worker's next poll and every message after it are fenced; it is offered nothing.
    await assert.rejects(() => attempt.pollControl(0), fenced);
    await assert.rejects(() => attempt.heartbeat(), fenced);
    await assert.rejects(() => attempt.complete({ status: "completed" }), fenced);
    assert.equal((await r1.client.offers()).length, 0);

    // An emergency stop does not wait for the worker at all.
    const second = await w.task("Water the beans");
    assert.deepEqual((await w.tick()).started, [second.attemptId]);
    const next = r1.client.attempt(second.attemptId, (await r1.client.offers())[0]!.placement);
    await next.accept();
    await w.c.dispatch!.dispatcher.stop(w.rob, second.attemptId, { reason: "stop now", emergency: true });
    assert.equal((await w.c.dispatch!.remote!.placement(w.rob, second.attemptId))!.state, "ended");
    await assert.rejects(() => next.pollControl(0), fenced);
    await assert.rejects(() => next.putCheckpoint(1, { late: true }), fenced);
    // Only the owner's stop ends it: the worker's own principal cannot stop an attempt through the dispatcher.
    await assert.rejects(() => w.c.dispatch!.dispatcher.stop(r1.principal, second.attemptId, { reason: "from the worker" }), (e: unknown) => e instanceof DomainError && (e.code === "forbidden" || e.code === "not_found"));
  } finally { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a new host's checkpoint never answers an old handle's request in the dispatcher's wait: the move ends the wait with a fence and the stop does not return the new host's checkpoint (card H02d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-stale-"));
  const w = await world(d, BOTH, { checkpointWaitMs: 4000 });
  try {
    const to = await w.host("r1", false);
    const from = await w.host("r2");
    const t = await w.task("Order seeds");
    assert.deepEqual((await w.tick()).started, [t.attemptId]);
    assert.equal((await w.c.dispatch!.remote!.placement(w.rob, t.attemptId))!.hostId, from.id);
    await to.join();
    const offer = (await from.client.offers())[0]!;
    const old = from.client.attempt(t.attemptId, offer.placement);
    await old.accept();
    await old.putCheckpoint(1, { turn: 1 });
    // The owner moves the attempt: the old host is asked for a checkpoint and stays silent. A while later the dispatcher's own stop asks it too, so the stop's wait ends after the move has been made.
    const moving = w.c.dispatch!.remote!.relocate(w.rob, { commandId: "mv", attemptId: t.attemptId, toHostId: to.id, reason: "r2 is being retired" }).then(() => "moved" as const, (e: unknown) => e);
    await until("the old host is asked", async () => asksForCheckpoint(await old.pollControl(0)));
    await new Promise((r) => setTimeout(r, 1500));
    const outcome = w.c.dispatch!.dispatcher.stop(w.rob, t.attemptId, { reason: "retiring r2" }).then(() => "stopped" as const, (e: unknown) => e);
    assert.equal(await moving, "moved");
    await until("the new host has the attempt", async () => { await w.tick(); return (await to.client.offers()).length > 0; });
    const again = (await to.client.offers())[0]!;
    const fresh = to.client.attempt(t.attemptId, again.placement);
    await fresh.accept();
    await fresh.putCheckpoint(7, { turn: 7, on: "the new host" });
    const result = await outcome;
    assert.ok(result instanceof DomainError && result.code === "fenced", `the old handle's wait was fenced, not answered: ${String(result)}`);
    // The attempt goes on at the new host, with its own checkpoint.
    assert.equal((await w.c.dispatch!.remote!.placement(w.rob, t.attemptId))!.state, "accepted");
    assert.equal((await fresh.heartbeat()).until > w.now(), true);
    assert.equal((await w.c.dispatch!.remote!.latestCheckpoint(w.rob, t.attemptId))!.sequence, 7);
  } finally { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a worker has no route that admits work, creates a task or reads the records, and a request with a field the protocol does not know is refused, in a started controller with an attempt placed (card H02d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-routes-"));
  const w = await world(d, BOTH);
  try {
    const r1 = await w.host("r1");
    const t = await w.task("Order seeds");
    assert.deepEqual((await w.tick()).started, [t.attemptId]);
    const offer = (await r1.client.offers())[0]!;
    const url = w.c.dispatch!.workerUrl!;
    const token = r1.token;
    const s = r1.client.session!;
    const headers = { [SESSION_HEADER]: s.sessionId, [PROTOCOL_HEADER]: String(s.protocol), "idempotency-key": "k1" };
    const taskBefore = JSON.stringify(await w.c.services.projects.getTask(t.taskId));
    const a = t.attemptId;
    for (const [method, path] of [["POST", "/worker/admit"], ["POST", "/worker/tasks"], ["POST", `/worker/attempts/${a}/admit`], ["POST", `/worker/attempts/${a}/promote`], ["POST", `/worker/attempts/${a}/relocate`], ["POST", `/worker/attempts/${a}/place`], ["GET", "/worker/hosts"], ["GET", "/v1/tasks"], ["DELETE", `/worker/attempts/${a}`]] as const) {
      const r = await rawRequest(url, method, path, { token, headers, ...(method === "POST" ? { body: {} } : {}) });
      assert.ok(r.status === 404 || r.status === 405 || (r.status === 409 && path.startsWith(`/worker/attempts/${a}/`)), `${method} ${path} -> ${r.status}`);
    }
    // Fields the protocol does not name are refused, not ignored: on the session, on the attempt's own messages and on the result.
    const refused = async (path: string, body: unknown, key: string, method = "POST"): Promise<void> => {
      const r = await rawRequest(url, method, path, { token, headers: { ...headers, "idempotency-key": key }, body });
      assert.equal(r.status, 400, `${path} ${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error?.code ?? r.body?.code, "invalid_command", JSON.stringify(r.body));
    };
    await refused("/worker/session/heartbeat", { seq: 1, extra: true }, "u1");
    await refused(`/worker/attempts/${a}/accept`, { placement: offer.placement, taskId: t.taskId }, "u2");
    assert.equal((await w.c.dispatch!.remote!.placement(w.rob, a))!.state, "offered", "a refused accept did not accept");
    await r1.client.attempt(a, offer.placement).accept();
    await refused(`/worker/attempts/${a}/heartbeat`, { placement: offer.placement, grant: "task.create" }, "u3");
    await refused(`/worker/attempts/${a}/complete`, { placement: offer.placement, result: { status: "completed", admit: true } }, "u4");
    await refused("/worker/connect", { capabilities: CAPS, workerVersion: "w", asOwner: true }, "u5");
    // None of it changed anything: the attempt is still only offered, and no task or attempt was added.
    assert.equal((await w.c.dispatch!.remote!.placement(w.rob, a))!.state, "accepted");
    assert.equal(JSON.stringify(await w.c.services.projects.getTask(t.taskId)), taskBefore, "the task is as it was");
  } finally { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a move to a host of another platform, without the workspace binding or outside the credential policy is refused through the started controller, with the reason, and the attempt carries on where it is (card H02d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-refuse-"));
  const policy: { dataHosts: string[]; credentialHosts?: string[] } = { dataHosts: [] };
  const w = await world(d, policy, { requirements: () => ({ data: "cloud-allowed", harness: "pi", isolation: ["bubblewrap"], workspaces: ["garden"] }) });
  try {
    const home = { ...CAPS, workspaces: ["garden"] };
    const from = await w.host("r2", true, home);
    const arm = await w.host("arm", true, { ...home, arch: "arm64" });
    const bare = await w.host("bare", true, { ...CAPS, workspaces: [] });
    const peer = await w.host("r1", true, home);
    const t = await w.task("Order seeds");
    const started = await w.tick();
    assert.deepEqual(started.started, [t.attemptId], JSON.stringify(started.skipped));
    const at = (await w.c.dispatch!.remote!.placement(w.rob, t.attemptId))!.hostId;
    const source = [from, arm, bare, peer].find((h) => h.id === at)!;
    const attempt = source.client.attempt(t.attemptId, (await source.client.offers())[0]!.placement);
    await attempt.accept();
    await attempt.putCheckpoint(1, { turn: 1 });
    const move = (to: { id: string }, key: string) => w.c.dispatch!.remote!.relocate(w.rob, { commandId: key, attemptId: t.attemptId, toHostId: to.id, reason: "balance" });
    const refusal = async (to: { id: string }, text: RegExp, key: string): Promise<void> => {
      await assert.rejects(move(to, key), (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, "invalid_transition"); assert.match(e.message, text); return true; });
      const p = (await w.c.dispatch!.remote!.placement(w.rob, t.attemptId))!;
      assert.deepEqual([p.hostId, p.state, p.relocations], [source.id, "accepted", 0], `${key}: nothing changed`);
      assert.equal((await attempt.heartbeat()).until > w.now(), true, `${key}: the old host goes on`);
    };
    const others = [from, arm, bare, peer].filter((h) => h.id !== source.id);
    const pick = (h: { id: string }) => others.find((o) => o.id === h.id)!;
    if (source.id !== arm.id) await refusal(pick(arm), /is arm64 and the attempt needs x64/, "mv-platform");
    if (source.id !== bare.id) await refusal(pick(bare), /no workspace binding named garden/, "mv-workspace");
    // A credential policy that names other hosts refuses a host that is not listed.
    const target = others.find((o) => o.id !== arm.id && o.id !== bare.id)!;
    policy.credentialHosts = ["host:nobody"];
    await refusal(target, /credential policy does not allow/, "mv-credential");
    // The same move is allowed once the policy lists the target: the refusals were the policy's, not the move's.
    policy.credentialHosts = [target.id];
    assert.equal((await move(target, "mv-ok")).to, target.id);
  } finally { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

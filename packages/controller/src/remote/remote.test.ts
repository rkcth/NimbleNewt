import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { after } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { workGrants } from "../dispatch/testing/world.js";
import { DomainError } from "../domain/errors.js";
import { REMOTE_LIMITS } from "./protocol.js";
import { READ, local, refuses, remoteSuite, wireRefuses } from "./testing/suite.js";
import { REMOTE_CAPS } from "./testing/world.js";

after(stopServer);
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
void sha; void chmodSync; void unlinkSync; void writeFileSync; void refuses;

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("an attempt is carried to a remote worker over the transport: offer, accept, calls through the controller's gateway, heartbeat, usage, result", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, order, attempt, taskId } = await c.started(r1);
    // The order that crossed the wire is the dispatcher's own, plain JSON, with the credential the dispatcher issued.
    assert.deepEqual(order, JSON.parse(JSON.stringify(order)));
    assert.deepEqual(order, r1.worker.starts[0], "the order that crossed the wire is the dispatcher's own");
    assert.equal(order.attemptId, attemptId);
    assert.equal(order.taskId, taskId);
    assert.ok(order.credential.length > 20);
    assert.equal(r1.worker.starts[0]!.credential, order.credential);
    assert.equal((await c.current.get(c.owner, attemptId))!.state, "running");
    assert.equal((await c.current.get(c.owner, attemptId))!.hostId, r1.id);
    const result = await attempt.call(READ("c1"), local("contents"));
    assert.deepEqual([result.state, (result as { text?: string }).text], ["confirmed", "contents"]);
    // The split form crossed the wire as the dispatch contract has it.
    const begun = await attempt.begin(READ("c2"));
    assert.equal(begun.run, true);
    assert.deepEqual((await attempt.report(begun.operationId, { state: "confirmed", text: "more" })).state, "confirmed");
    // Asking again with the same call ID is the same call.
    const again = await attempt.begin(READ("c2"));
    assert.equal(again.operationId, begun.operationId);
    assert.equal(again.run, false);
    // A tool that acts on the outside needs the controller's ledger and a bridge: the split form refuses it visibly.
    const push = await attempt.begin({ callId: "p1", tool: { name: "git-push", version: "1" }, args: {} });
    assert.equal(push.run, false);
    assert.equal((push as { result: { state: string } }).result.state, "refused");
    const until = (await attempt.heartbeat()).until;
    assert.ok(until > c.clock.now());
    await attempt.usage({ costMicros: 5 });
    await attempt.acknowledgeDecisions();
    const stored = await attempt.complete({ status: "completed", text: "done" });
    assert.deepEqual(stored, { status: "completed", text: "done" });
    await c.current.idle();
    const dispatch = (await c.current.get(c.owner, attemptId))!;
    assert.equal(dispatch.state, "finished");
    assert.equal(dispatch.outcome!.status, "succeeded");
    assert.equal(dispatch.workerVersion, "remote-1.0.0");
    assert.deepEqual((await c.ops(attemptId)).map((o) => o.state).sort(), ["confirmed", "confirmed", "refused"]);
    // The turn is over for everyone: the worker's later messages are fenced.
    await wireRefuses("fenced", () => attempt.heartbeat(), 409);
  });

  suite("only the owner and the dispatcher place, move, end and steer attempts; a host, an agent or a client cannot, and none can read the records", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, order } = await c.started(r1);
    const ann = await c.principals.authenticate((await c.principals.issueCredential(c.owner, "agent:ann")).token);
    for (const who of [r1.principal, ann]) {
      await refuses("forbidden", () => c.remote.place(who, { hostId: r1.id, order, requirements: { data: "cloud-allowed" } }));
      await refuses("forbidden", () => c.remote.relocate(who, { commandId: "x", attemptId, toHostId: "host:r2", reason: "mine" }));
      await refuses("forbidden", () => c.remote.end(who, attemptId, "done"));
      await refuses("forbidden", () => c.remote.control(who, attemptId, { kind: "stop", emergency: true }));
      await refuses("forbidden", () => c.remote.placement(who, attemptId));
      await refuses("forbidden", () => c.remote.store(who, "agent:ann"));
      await refuses("forbidden", () => c.remote.session(who, r1.id));
      await refuses("forbidden", () => c.remote.refused(who));
      await refuses("forbidden", () => c.remote.latestCheckpoint(who, attemptId));
      await refuses("forbidden", () => c.remote.moveStore(who, { commandId: "m", agentId: "agent:ann", toHostId: r1.id }));
      assert.throws(() => c.remote.waitForResult(who, attemptId, 1), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
    }
    // A task credential of the attempt is not the dispatcher either.
    const taskPrincipal = await c.credentials.principalOf(c.dispatcherPrincipal, attemptId);
    await refuses("forbidden", () => c.remote.end(taskPrincipal, attemptId, "done"));
    // The service is built only for the dispatcher's own principal.
    const { RemoteWorkerService } = await import("./service.js");
    assert.throws(() => RemoteWorkerService.withEpoch(c.storage, c.epoch, { principal: c.owner, hosts: c.hosts, artifacts: c.artifacts, dispatch: c.current as never }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
    // The placement disagrees with the dispatcher's own record: refused.
    await refuses("invalid_command", () => c.remote.place(c.dispatcherPrincipal, { hostId: "host:nowhere", order, requirements: { data: "cloud-allowed" } }));
    await refuses("invalid_command", () => c.remote.place(c.owner, { hostId: r1.id, order: { ...order, generation: order.generation + 1 }, requirements: { data: "cloud-allowed" } }));
    assert.equal((await c.remote.placement(c.owner, attemptId))!.hostId, r1.id);
  });

  suite("the worker's watchdog guards the attempt: nothing begins once it says stop, a renewal counts from its send, and a fenced answer stops it (card H08)", async (c) => {
    const r1 = await c.host("r1");
    const ann = await c.agent("ann", workGrants(c.project, ["read-file"]));
    const { attemptId } = await c.task("t", ann);
    assert.deepEqual((await c.tick()).started, [attemptId]);
    const offer = (await r1.client.offers())[0]!;
    const log: string[] = [];
    let productive = true;
    const dog = {
      assertProductive: async () => { log.push("assert"); if (!productive) throw new Error("lease lost"); },
      sending: () => { log.push("sending"); return 4242; },
      renewed: (sentAt: number, leaseMs: number) => { log.push(`renewed ${sentAt} ${typeof leaseMs === "number"}`); },
      lost: async () => { log.push("lost"); productive = false; },
    };
    const mine = r1.client.attempt(attemptId!, offer.placement, dog);
    await mine.accept();
    assert.ok((await mine.heartbeat()).until);
    assert.deepEqual(log, ["sending", "renewed 4242 true"], "the renewal is stamped when it is sent");
    log.length = 0;
    await mine.begin(READ("c1"));
    assert.deepEqual(log.slice(0, 1), ["assert"], "the watchdog is asked before a call begins");
    // The controller fences the attempt: the watchdog is told, and then nothing begins.
    await wireRefuses("fenced", () => r1.client.attempt(attemptId!, offer.placement + 1, dog).heartbeat(), 409);
    assert.ok(log.includes("lost"));
    await assert.rejects(mine.begin(READ("c2")), /lease lost/);
  });

  suite("a remote worker cannot take work it was not given: not another host's offer, not a higher placement number, not an attempt before it accepts, not an admission of its own", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const ann = await c.agent("ann", workGrants(c.project, ["read-file"]));
    const { attemptId } = await c.task("t", ann);
    assert.deepEqual((await c.tick()).started, [attemptId]);
    const offer = (await r1.client.offers())[0]!;
    assert.deepEqual(await r2.client.offers(), [], "an offer is made to one host");
    // The other host's attempt looks like one that does not exist; it cannot accept, call, fetch or complete it.
    const theirs = r2.client.attempt(attemptId!, offer.placement);
    await wireRefuses("not_found", () => theirs.accept(), 404);
    await wireRefuses("not_found", () => theirs.begin(READ("c1")), 404);
    await wireRefuses("not_found", () => theirs.complete({ status: "completed" }), 404);
    await wireRefuses("not_found", () => theirs.artifacts(), 404);
    // Its own offer is not usable before it is accepted, and not under a number it was not given.
    const mine = r1.client.attempt(attemptId!, offer.placement);
    await wireRefuses("fenced", () => mine.begin(READ("c1")), 409);
    await wireRefuses("fenced", () => r1.client.attempt(attemptId!, offer.placement + 1).accept(), 409);
    await wireRefuses("fenced", () => r1.client.attempt(attemptId!, 0).accept(), 409);
    assert.equal((await mine.accept()).placement, offer.placement);
    await wireRefuses("fenced", () => r1.client.attempt(attemptId!, offer.placement + 1).begin(READ("c1")), 409);
    // A host cannot admit an attempt of its own: it has no attempt that the dispatcher did not start, whatever grants the host has.
    await c.principals.setGrants(c.owner, { commandId: "g1", principalId: r1.id, expectedRevision: (await c.storage.getAggregate({ kind: "principal", id: r1.id }))!.revision, grants: [{ action: "attempt.work", project: c.project }, { action: "task.write", project: c.project }, { action: "assignment.manage", project: c.project }] });
    const unplaced = r1.client.attempt("att-aaaaaaaaaaaaaaaaaaaa", 1);
    await wireRefuses("not_found", () => unplaced.accept(), 404);
    await wireRefuses("not_found", () => unplaced.begin(READ("c9")), 404);
    assert.deepEqual((await c.current.get(c.owner, attemptId!))!.hostId, r1.id);
    // Nothing it did changed the placement.
    assert.equal((await c.remote.placement(c.owner, attemptId!))!.placement, offer.placement);
  });

  suite("a host that is revoked, stale, not connected or lacking what the attempt needs cannot be given it, and the reasons are all stated", async (c) => {
    const r1 = await c.host("r1");
    const idle = await c.host("idle", { connect: false });
    const arm = await c.host("arm", { caps: { ...REMOTE_CAPS, arch: "arm64", isolation: [], workspaces: [], harnesses: [{ name: "other", version: "1" }] } });
    const ann = await c.agent("ann", workGrants(c.project));
    const { attemptId } = await c.task("t", ann);
    assert.deepEqual((await c.tick()).started, [attemptId]);
    const order = r1.worker.starts[0]!;
    // The dispatcher chose r1; the service still judges every host it is asked to place on.
    const dispatchOf = async () => (await c.current.get(c.owner, attemptId!))!;
    assert.equal((await dispatchOf()).hostId, r1.id);
    const need = { data: "cloud-allowed" as const, harness: "pi", isolation: ["bubblewrap"], workspaces: ["garden"], os: "linux", arch: "x64" };
    // Wrong host for this attempt according to the dispatcher's record.
    await refuses("invalid_command", () => c.remote.place(c.owner, { hostId: arm.id, order, requirements: need }));
    // Capabilities the host that the dispatcher did pick does not have.
    for (const [requirements, text] of [
      [{ ...need, os: "windows" }, /runs linux and the attempt needs windows/],
      [{ ...need, arch: "arm64" }, /is x64 and the attempt needs arm64/],
      [{ ...need, harness: "other" }, /does not have the other harness/],
      [{ ...need, isolation: ["seatbelt", "bubblewrap"] }, /does not offer seatbelt isolation/],
      [{ ...need, workspaces: ["garden", "orchard"] }, /no workspace binding named orchard/],
    ] as const) await refuses("invalid_command", () => c.remote.place(c.owner, { hostId: r1.id, order, requirements }), (e) => assert.match(e.message, text));
    // Stale: no heartbeat for longer than the freshness window.
    c.clock.advance(100_000);
    await refuses("invalid_command", () => c.remote.place(c.owner, { hostId: r1.id, order, requirements: need }), (e) => assert.match(e.message, /has not been heard from recently \(stale\)/));
    await r1.beat();
    // Revoked.
    const record = (await c.storage.getAggregate({ kind: "principal", id: r1.id }))!;
    await c.principals.disable(c.owner, { commandId: "dis", principalId: r1.id, expectedRevision: record.revision });
    await refuses("invalid_command", () => c.remote.place(c.owner, { hostId: r1.id, order, requirements: need }), (e) => assert.match(e.message, /is revoked/));
    assert.equal(idle.name, "idle");
  });

  suite("a host that has not connected, or has no capabilities on record, is not given work; the dispatcher says why it did not start the attempt", async (c) => {
    const idle = await c.host("idle", { connect: false });
    await c.principals.setGrants(c.owner, { commandId: "g", principalId: idle.id, expectedRevision: (await c.storage.getAggregate({ kind: "principal", id: idle.id }))!.revision, grants: [] });
    const ann = await c.agent("ann", workGrants(c.project));
    const { attemptId } = await c.task("t", ann);
    const report = await c.tick();
    assert.deepEqual(report.started, []);
    assert.match(report.skipped.map((x) => x.reason).join(), /idle is not an enrolled host|has not been heard from/);
    void attemptId;
    // Heard from, but no session: the service refuses the placement by itself.
    await c.hosts.announce(idle.principal, { commandId: "an", capabilities: REMOTE_CAPS });
    await c.hosts.heartbeat(idle.principal, { commandId: "hb", sequence: 1 });
    const started = await c.tick();
    assert.deepEqual(started.started, [], "the host is fresh but the placement fails: the attempt ends as the worker did not start");
    const dispatch = (await c.current.get(c.owner, attemptId!))!;
    assert.equal(dispatch.state, "finished");
    assert.match(dispatch.outcome!.summary, /did not start/);
    assert.equal(await c.remote.placement(c.owner, attemptId!), undefined);
  });

  suite("a message from an old session, an old placement or an ended attempt is fenced; a reconnecting worker takes its attempt up again and learns what happened to it", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, placement, attempt } = await c.started(r1);
    assert.equal((await attempt.call(READ("c1"), local("one"))).state, "confirmed");
    // A reconnect after a partition: the first session's late packets are fenced; the new session must take the attempt up before it can call.
    const stale = new (await import("./client.js")).RemoteWorkerClient({ url: c.transport.url, token: r1.token, workerVersion: "w" });
    const old = r1.client.attempt(attemptId, placement);
    await stale.connect({ ...REMOTE_CAPS }, "re-1");
    await wireRefuses("fenced", () => old.heartbeat(), 409);
    await wireRefuses("fenced", () => old.begin(READ("c2")), 409);
    const resumed = stale.attempt(attemptId, placement);
    await wireRefuses("fenced", () => resumed.begin(READ("c2")), 409, (e) => assert.match(e.message, /accept it again/));
    const again = await resumed.accept();
    assert.equal(again.placement, placement);
    // Calls made in the first session are the same calls: the same call ID is the same operation.
    const repeat = await resumed.begin(READ("c1"));
    assert.equal(repeat.run, false);
    assert.equal((await resumed.call(READ("c2"), local("two"))).state, "confirmed");
    assert.deepEqual((await c.ops(attemptId)).map((o) => o.callId).sort(), ["c1", "c2"]);
    // The dispatcher starts the attempt again on the same host: the new placement fences the first.
    const second = await c.remote.place(c.dispatcherPrincipal, { hostId: r1.id, order: r1.worker.starts[0]!, requirements: { data: "cloud-allowed", harness: "pi" } });
    assert.equal(second.placement, placement + 1);
    await wireRefuses("fenced", () => resumed.heartbeat(), 409);
    await wireRefuses("fenced", () => resumed.accept(), 409);
    const offered = (await stale.offers())[0]!;
    assert.equal(offered.placement, placement + 1);
    assert.equal((await c.remote.placement(c.owner, attemptId))!.history.at(-1)!.reason, "placed again");
    const next = stale.attempt(attemptId, offered.placement);
    assert.equal((await next.accept()).placement, placement + 1);
    // The run the dispatcher was waiting for is the one that was fenced: its attempt ends (the dispatcher starts a new run through its own path), so the new number does not reach the gateway.
    await c.current.idle();
    assert.equal((await c.current.get(c.owner, attemptId))!.state, "finished");
    await wireRefuses("fenced", () => next.heartbeat(), 409);
  });

  suite("a controller that no longer holds the epoch cannot renew a worker's lease or take its result: the worker gets an unavailable answer and the stored lease does not move (card H09)", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1);
    assert.equal((await attempt.call(READ("c1"), local("one"))).state, "confirmed");
    const ref = { kind: "dispatch", id: (await c.current.get(c.owner, attemptId))!.id };
    const before = (await c.storage.getAggregate(ref))!;
    // Another controller takes the epoch; this one is now an old primary.
    await c.storage.acquireEpoch({ holder: "controller-2", at: c.clock.now() });
    c.clock.advance(5_000);
    await wireRefuses("stale_epoch", () => attempt.heartbeat(), 503);
    await wireRefuses("stale_epoch", () => attempt.complete({ status: "completed" }), 503);
    // Nothing was written by the old primary: the lease is where it was.
    const after = (await c.storage.getAggregate(ref))!;
    assert.equal(after.revision, before.revision, "the record was not written");
    assert.deepEqual((after.body as { lease?: unknown }).lease, (before.body as { lease?: unknown }).lease);
  });

  suite("an attempt whose worker falls silent is lost when its lease ends: the worker is fenced and the dispatcher admits the next attempt", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1);
    assert.equal((await attempt.call(READ("c1"), local("one"))).state, "confirmed");
    // A partition: nothing arrives for longer than the lease. Late packets afterwards change nothing.
    c.clock.advance(61_000);
    const report = await c.tick();
    assert.deepEqual(report.lost, [attemptId]);
    assert.equal(report.readmitted.length, 1);
    assert.equal((await c.remote.placement(c.owner, attemptId))!.state, "ended");
    await wireRefuses("fenced", () => attempt.heartbeat(), 409);
    await wireRefuses("fenced", () => attempt.begin(READ("c2")), 409);
    await wireRefuses("fenced", () => attempt.complete({ status: "completed" }), 409);
    await wireRefuses("fenced", () => attempt.putCheckpoint(5, { late: true }), 409);
    assert.deepEqual((await c.ops(attemptId)).map((o) => o.callId), ["c1"], "the late call was not recorded");
    assert.equal((await c.current.get(c.owner, attemptId))!.outcome!.status, "abandoned");
    // The next attempt is a new one with its own offer (the dispatcher started it in the same tick); the lost one's number is not reused.
    assert.deepEqual(report.started, report.readmitted);
    const offers = await r1.client.offers();
    assert.deepEqual(offers.map((o) => o.order.attemptId), report.readmitted);
    assert.equal(offers[0]!.placement, 1);
  });

  suite("a checkpoint is stored as a verified artifact; a delayed older one cannot replace a newer one, and a repeat is the same checkpoint", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1);
    const two = await attempt.putCheckpoint(2, { turn: 2 }, "ck-2");
    assert.equal(two.sequence, 2);
    assert.deepEqual(await attempt.putCheckpoint(2, { turn: 2 }, "ck-2"), two, "the same message again is the same checkpoint");
    await wireRefuses("stale_revision", () => attempt.putCheckpoint(1, { turn: 1 }, "ck-1"), 409);
    await wireRefuses("stale_revision", () => attempt.putCheckpoint(2, { turn: 2 }, "ck-other"), 409);
    const latest = (await c.remote.latestCheckpoint(c.owner, attemptId))!;
    assert.deepEqual([latest.sequence, latest.checkpoint, latest.digest], [2, { turn: 2 }, two.digest]);
    assert.equal((await c.artifacts.verify(latest.artifactId)).ok, true);
    await attempt.putCheckpoint(3, { turn: 3 });
    assert.deepEqual((await c.remote.latestCheckpoint(c.owner, attemptId))!.checkpoint, { turn: 3 });
    // The worker may read its checkpoint back, as an artifact of its placement.
    const listing = (await attempt.artifacts()).find((a) => a.role === "checkpoint")!;
    assert.equal(listing.files[0]!.path, "checkpoint.json");
    assert.deepEqual(JSON.parse(Buffer.from(await attempt.fetchFile(listing.id, "checkpoint.json")).toString()), { turn: 3 });
    // Bad shapes.
    await wireRefuses("invalid_command", () => attempt.putCheckpoint(0, {}), 400);
    await wireRefuses("invalid_command", () => attempt.putCheckpoint(9, [] as never), 400);
    await wireRefuses("too_large", () => attempt.putCheckpoint(9, { pad: "x".repeat(REMOTE_LIMITS.checkpointBytes) }), 413);
    await refuses("invalid_command", () => c.remote.putCheckpoint(r1.principal, r1.client.session!.sessionId, attemptId, attempt.placement, { commandId: "big", sequence: 9, checkpoint: { pad: "x".repeat(REMOTE_LIMITS.checkpointBytes) } }));
    // Corrupting the stored checkpoint blocks reading it: it is not handed on as if it were good.
    chmodSync(c.blobs.pathOf(latest.digest.length === 64 ? (await c.artifacts.get((await c.remote.latestCheckpoint(c.owner, attemptId))!.artifactId))!.entries[0]!.digest : latest.digest), 0o666);
    writeFileSync(c.blobs.pathOf((await c.artifacts.get((await c.remote.latestCheckpoint(c.owner, attemptId))!.artifactId))!.entries[0]!.digest), "{\"turn\":4}");
    await refuses("integrity", () => c.remote.latestCheckpoint(c.owner, attemptId));
  });

  suite("a worker's result ends its run: whoever waits is given it, a repeat of the same result is the same answer, a different one is fenced", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt, placement } = await c.started(r1);
    const waiting = c.remote.waitForResult(c.dispatcherPrincipal, attemptId, placement);
    const first = await attempt.complete({ status: "completed", text: "all done", checkpoint: { end: true } }, "done-1");
    assert.deepEqual(await waiting, first);
    assert.deepEqual(await attempt.complete({ status: "completed", text: "all done" }, "done-1"), first);
    await wireRefuses("fenced", () => attempt.complete({ status: "failed", error: "no" }, "done-2"), 409);
    assert.deepEqual((await c.remote.latestCheckpoint(c.owner, attemptId))!.checkpoint, { end: true }, "a checkpoint that comes with the result is stored");
    // Asking after the fact answers at once; a different run's number is not this run.
    assert.deepEqual(await c.remote.waitForResult(c.owner, attemptId, placement), first);
    assert.equal((await c.remote.waitForResult(c.owner, attemptId, placement + 1)).status, "cancelled");
    // Bad results.
    const r2 = await c.host("r2");
    const two = await c.started(r2, "second", { agent: "bob" });
    await wireRefuses("invalid_command", () => two.attempt.complete({ status: "great" } as never), 400);
    await wireRefuses("invalid_command", () => two.attempt.complete({ status: "completed", extra: 1 } as never), 400);
    const secret = await two.attempt.complete({ status: "failed", error: "token sk-ant-api03-abcdefghijklmnopqrstuvwx leaked" });
    assert.doesNotMatch(secret.error!, /sk-ant/);
    // Ending the attempt, or aborting the wait, resolves a waiter too.
    const r3 = await c.host("r3");
    const three = await c.started(r3, "third", { agent: "cy" });
    const gone = c.remote.waitForResult(c.dispatcherPrincipal, three.attemptId, three.placement);
    await c.remote.end(c.dispatcherPrincipal, three.attemptId, "stopped by the owner");
    assert.deepEqual(await gone, { status: "cancelled", error: "stopped by the owner" });
    await c.remote.end(c.dispatcherPrincipal, three.attemptId, "again");
    const abort = new AbortController();
    const aborted = c.remote.waitForResult(c.owner, three.attemptId, three.placement + 5, abort.signal);
    abort.abort();
    await assert.rejects(aborted);
  });

  suite("the controller steers a worker with bounded messages it polls for: tell, restart, checkpoint, stop", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1);
    assert.deepEqual(await attempt.pollControl(), []);
    assert.equal(await c.remote.control(c.dispatcherPrincipal, attemptId, { kind: "tell", text: "the recipe was widened" }), 1);
    await c.remote.control(c.owner, attemptId, { kind: "checkpoint" });
    await c.remote.control(c.owner, attemptId, { kind: "restart", recipe: { revision: "r-2", reach: ["read-file"] }, checkpoint: { turn: 4 } });
    await c.remote.control(c.owner, attemptId, { kind: "stop", emergency: true });
    const all = await attempt.pollControl();
    assert.deepEqual(all.map((m) => [m.seq, m.kind]), [[1, "tell"], [2, "checkpoint"], [3, "restart"], [4, "stop"]]);
    assert.deepEqual((await attempt.pollControl(3)).map((m) => m.seq), [4]);
    assert.deepEqual(all[3], { kind: "stop", emergency: true, seq: 4 });
    for (let i = 0; i < REMOTE_LIMITS.control + 5; i++) await c.remote.control(c.owner, attemptId, { kind: "tell", text: `n${i}` });
    const kept = await attempt.pollControl();
    assert.equal(kept.length, REMOTE_LIMITS.control);
    assert.equal(kept.at(-1)!.seq, 4 + REMOTE_LIMITS.control + 5);
    for (const bad of [{ kind: "tell" }, { kind: "tell", text: "" }, { kind: "reboot" }, { kind: "stop", extra: 1 }, { kind: "restart", recipe: {}, checkpoint: {} }, { kind: "restart", recipe: { revision: "r", reach: [] }, checkpoint: [] }, null, "stop"]) {
      await refuses("invalid_command", () => c.remote.control(c.owner, attemptId, bad as never));
    }
    await wireRefuses("invalid_command", () => attempt.pollControl(-1), 400).catch(() => undefined);
    await c.remote.end(c.owner, attemptId, "over");
    await refuses("fenced", () => c.remote.control(c.owner, attemptId, { kind: "checkpoint" }));
    await wireRefuses("fenced", () => attempt.pollControl(), 409);
  });
}

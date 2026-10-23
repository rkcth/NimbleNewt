import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { after } from "node:test";
import { derivedId } from "../domain/ids.js";
import { DomainError } from "../domain/errors.js";
import { commitOperation } from "../storage/commit.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { RelocationPolicyFor } from "./service.js";
import { READ, local, refuses, remoteSuite, wireRefuses, type Ctx } from "./testing/suite.js";
import { REMOTE_CAPS, type RemoteHost } from "./testing/world.js";

after(stopServer);
const bytes = (text: string) => new Uint8Array(Buffer.from(text));
const MOVE = (c: Ctx, attemptId: string, to: RemoteHost, key = `mv-${attemptId.slice(-4)}-${to.name}`) => ({ commandId: key, attemptId, toHostId: to.id, reason: "r1 is being retired" });
const open: RelocationPolicyFor = async () => ({ dataHosts: ["host:r2", "host:r3", "host:arm"] });

for (const backend of backends) {
  const suite = remoteSuite(backend);

  /** r1 runs an attempt that has made a call, sent a checkpoint and published an output; r2 is connected and fresh. */
  async function running(c: Ctx, o: { checkpoint?: boolean } = {}) {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    r1.worker.requirements = () => ({ data: "local-only", harness: "pi", isolation: ["bubblewrap"], workspaces: ["garden"] });
    r2.worker.requirements = r1.worker.requirements;
    const input = await c.artifacts.publish({ commandId: "in-1", actor: c.owner.id, name: "seed catalogue", projectId: c.project, files: [{ path: "seeds.csv", content: bytes("tomato,3\n") }] });
    r1.worker.inputs = () => [input.id];
    const s = await c.started(r1);
    assert.equal((await s.attempt.call(READ("c1"), local("one"))).state, "confirmed");
    const out = await s.attempt.publish("orders", [{ path: "orders.txt", content: bytes("12 tomato") }], "pub-1");
    if (o.checkpoint !== false) await s.attempt.putCheckpoint(1, { turn: 1, said: "ordered" });
    return { r1, r2, input: input.id, out: out.artifactId, ...s };
  }

  suite("relocating an attempt fences the old host, transfers the checkpoint and the artifacts with their hashes verified, hands over the native store, and restarts it on the new host from the checkpoint", async (c) => {
    const { r1, r2, input, out, attemptId, attempt, placement, order } = await running(c);
    const moved = await c.remote.relocate(c.owner, MOVE(c, attemptId, r2));
    assert.deepEqual([moved.from, moved.to, moved.placement, moved.checkpoint], [r1.id, r2.id, placement + 1, "fresh"]);
    const latest = (await c.remote.latestCheckpoint(c.owner, attemptId))!;
    assert.deepEqual(moved.artifacts.map((a) => a.id).sort(), [input, out, latest.artifactId].sort());
    for (const a of moved.artifacts) assert.equal(a.manifestDigest, (await c.artifacts.get(a.id))!.manifestDigest);
    // From the moment of the move the old host is fenced on every message, whatever it still holds.
    await wireRefuses("fenced", () => attempt.heartbeat(), 409);
    await wireRefuses("fenced", () => attempt.begin(READ("c2")), 409);
    await wireRefuses("fenced", () => attempt.report("top-x", { state: "confirmed" }), 409);
    await wireRefuses("fenced", () => attempt.usage({ costMicros: 1 }), 409);
    await wireRefuses("fenced", () => attempt.putCheckpoint(7, { late: true }), 409);
    await wireRefuses("fenced", () => attempt.complete({ status: "completed" }), 409);
    await wireRefuses("fenced", () => attempt.publish("late", [{ path: "late.txt", content: bytes("late") }]), 409);
    await wireRefuses("fenced", () => attempt.artifacts(), 409);
    await wireRefuses("fenced", () => attempt.fetchFile(out, "orders.txt"), 409);
    await wireRefuses("fenced", () => attempt.pollControl(), 409);
    await wireRefuses("fenced", () => attempt.accept(), 409);
    assert.deepEqual(await r1.client.offers(), []);
    // The store belongs to the new host in the same commit.
    assert.deepEqual([(await c.remote.store(c.owner, "agent:ann"))!.ownerHostId, (await c.remote.store(c.owner, "agent:ann"))!.moves], [r2.id, 1]);
    // Same command again: the same move, nothing twice.
    assert.deepEqual(await c.remote.relocate(c.owner, MOVE(c, attemptId, r2)), { ...moved, checkpoint: "stored" });
    // The dispatcher restarts it on the new host: no other host is tried, and the order carries the checkpoint.
    const dispatch = (await c.current.get(c.owner, attemptId))!;
    assert.deepEqual([dispatch.state, dispatch.pinnedHost, dispatch.requestId], ["waiting", r2.id, undefined]);
    assert.equal((await c.admission.snapshot()).running.filter((e) => e.host === r1.id).length, 0, "the old host's place was given back");
    const report = await c.tick();
    assert.deepEqual(report.started, [attemptId]);
    assert.equal((await c.current.get(c.owner, attemptId))!.pinnedHost, undefined);
    const offer = (await r2.client.offers())[0]!;
    assert.equal(offer.placement, moved.placement);
    assert.deepEqual(offer.order.resumeFrom, latest.checkpoint);
    assert.match(offer.order.resumeNote!, /moved from host:r1 to host:r2: r1 is being retired/);
    assert.notEqual(offer.order.resumeFrom, undefined);
    const next = r2.client.attempt(attemptId, offer.placement);
    await next.accept();
    // It finds the artifacts it needs and they are the bytes that were published.
    const listing = await next.artifacts();
    assert.deepEqual(listing.map((a) => a.id).sort(), [input, out, latest.artifactId].sort());
    assert.equal(Buffer.from(await next.fetchFile(out, "orders.txt")).toString(), "12 tomato");
    assert.equal(Buffer.from(await next.fetchFile(input, "seeds.csv")).toString(), "tomato,3\n");
    assert.deepEqual(JSON.parse(Buffer.from(await next.fetchFile(latest.artifactId, "checkpoint.json")).toString()), { turn: 2, fresh: true }, "the checkpoint the old host sent when asked, after its first");
    // And carries on: a call, then the result, which finishes the attempt once.
    assert.equal((await next.call(READ("c3"), local("three"))).state, "confirmed");
    await next.complete({ status: "completed", text: "done on r2" });
    await c.current.idle();
    const end = (await c.current.get(c.owner, attemptId))!;
    assert.deepEqual([end.state, end.outcome!.status, end.hostId], ["finished", "succeeded", r2.id]);
    assert.deepEqual((await c.ops(attemptId)).map((o) => o.callId).sort(), ["c1", "c3"]);
    const record = (await c.remote.placement(c.owner, attemptId))!;
    assert.deepEqual([record.relocations, record.history.map((h) => [h.hostId, h.placement, h.reason])], [1, [[r1.id, placement, "relocated: r1 is being retired"]]]);
    // The old host, told late, learns it lost the attempt.
    await wireRefuses("fenced", () => attempt.heartbeat(), 409);
    void order;
  }, { policy: open });

  suite("a relocation is refused, with every reason, and changes nothing when the target's platform, workspace paths, credential policy or data location do not allow it", async (c) => {
    const { r1, r2, attemptId, attempt, placement } = await running(c);
    const arm = await c.host("arm", { caps: { ...REMOTE_CAPS, arch: "arm64" } });
    const bare = await c.host("bare", { caps: { ...REMOTE_CAPS, workspaces: [], isolation: [] } });
    const intact = async (why: string): Promise<void> => {
      const b = (await c.remote.placement(c.owner, attemptId))!;
      assert.deepEqual([b.hostId, b.placement, b.state, b.relocations], [r1.id, placement, "accepted", 0], why);
      assert.equal((await c.remote.store(c.owner, "agent:ann"))!.ownerHostId, r1.id, why);
      assert.equal((await attempt.heartbeat()).until > c.clock.now(), true, `${why}: the old host goes on`);
      assert.equal((await c.current.get(c.owner, attemptId))!.frozen, undefined, `${why}: nothing is left frozen`);
      assert.equal((await attempt.call(READ(`ok-${why.length}-${why.slice(0, 4)}`), local("still works"))).state, "confirmed", why);
    };
    const refusal = async (to: RemoteHost, text: RegExp, why: string): Promise<void> => {
      await refuses("invalid_transition", () => c.remote.relocate(c.owner, MOVE(c, attemptId, to, `try-${why}`)), (e) => assert.match(e.message, text));
      await intact(why);
    };
    // Platform: the default is the platform it runs on.
    await refusal(arm, /is arm64 and the attempt needs x64/, "platform");
    // Path: the workspace binding the attempt uses must exist on the target; isolation likewise.
    await refusal(bare, /no workspace binding named garden/, "workspace");
    await refusal(bare, /does not offer bubblewrap isolation/, "isolation");
    // Data location: this attempt's data is local-only and nothing lists r2 as a place it may be.
    await refusal(r2, /data is local-only and the data-location policy does not list host:r2/, "data");
    // The same host is no move.
    await refuses("invalid_command", () => c.remote.relocate(c.owner, MOVE(c, attemptId, r1, "same")));
    // A host that is not connected, stale or revoked.
    const idle = await c.host("idle", { connect: false });
    await refusal(idle, /has not connected to the controller/, "not-connected");
    const gone = await c.host("gone");
    const record = (await c.storage.getAggregate({ kind: "principal", id: gone.id }))!;
    await c.principals.disable(c.owner, { commandId: "dis", principalId: gone.id, expectedRevision: record.revision });
    await refusal(gone, /is revoked/, "revoked");
    // An unknown host and a bad ID.
    await refuses("invalid_transition", () => c.remote.relocate(c.owner, { ...MOVE(c, attemptId, r2, "nohost"), toHostId: "host:nobody" }), (e) => assert.match(e.message, /not an enrolled host/));
    await refuses("invalid_command", () => c.remote.relocate(c.owner, { ...MOVE(c, attemptId, r2, "badhost"), toHostId: "agent:ann" }));
    await refuses("not_found", () => c.remote.relocate(c.owner, { commandId: "noatt", attemptId: "att-aaaaaaaaaaaaaaaaaaaa", toHostId: r2.id, reason: "x" }));
  });

  suite("a credential policy that does not list the target refuses the move; the policy is the controller's, not the caller's", async (c) => {
    const { r2, attemptId } = await running(c);
    const arm = await c.host("arm", { caps: { ...REMOTE_CAPS, arch: "arm64" } });
    await refuses("invalid_transition", () => c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "m1")), (e) => assert.match(e.message, /credential policy does not allow host:r2 to hold this attempt's task credential/));
    await refuses("invalid_transition", () => c.remote.relocate(c.owner, MOVE(c, attemptId, arm, "m2")), (e) => assert.match(e.message, /credential policy does not allow host:arm/));
    // The command has no field for a policy: one that is sent is refused as unknown.
    await refuses("invalid_command", () => c.remote.relocate(c.owner, { ...MOVE(c, attemptId, r2, "m3"), policy: {} } as never));
  }, { policy: async () => ({ dataHosts: ["host:r2", "host:arm"], credentialHosts: ["host:r1"] }) });

  suite("a credential policy that lists the target allows the move", async (c) => {
    const { r2, attemptId } = await running(c);
    assert.equal((await c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "m1"))).to, r2.id);
  }, { policy: async () => ({ dataHosts: ["host:r2"], credentialHosts: ["host:r1", "host:r2"] }) });

  suite("a platform policy that names the target's platform allows a move the default would refuse; one that does not name it refuses", async (c) => {
    const { attemptId } = await running(c);
    const arm = await c.host("arm", { caps: { ...REMOTE_CAPS, arch: "arm64" } });
    const x86 = await c.host("x86");
    const moved = await c.remote.relocate(c.owner, MOVE(c, attemptId, arm));
    assert.equal(moved.to, arm.id);
    await refuses("invalid_transition", () => c.remote.relocate(c.owner, MOVE(c, attemptId, x86, "back")), (e) => assert.match(e.message, /platform policy does not allow linux\/x64/));
  }, { policy: async () => ({ platforms: [{ os: "linux", arch: "arm64" }], dataHosts: ["host:arm", "host:x86"] }) });

  suite("an altered or missing blob in the checkpoint or any artifact that would travel refuses the move before the old host is touched", async (c) => {
    const { r1, r2, input, out, attemptId, attempt } = await running(c);
    const latest = (await c.remote.latestCheckpoint(c.owner, attemptId))!;
    const blobOf = async (id: string): Promise<string> => c.blobs.pathOf((await c.artifacts.get(id))!.entries[0]!.digest);
    for (const [id, what] of [[latest.artifactId, "checkpoint"], [out, "output"], [input, "input"]] as const) {
      const path = await blobOf(id);
      const original = readFileSync(path);
      chmodSync(path, 0o666); writeFileSync(path, Buffer.alloc(original.length, 0x58));
      await refuses("integrity", () => c.remote.relocate(c.owner, MOVE(c, attemptId, r2, `bad-${what}`)));
      const b = (await c.remote.placement(c.owner, attemptId))!;
      assert.deepEqual([b.hostId, b.state, b.relocations], [r1.id, "accepted", 0], what);
      assert.equal((await attempt.heartbeat()).until > c.clock.now(), true, `${what}: the old host is not fenced`);
      assert.equal((await c.current.get(c.owner, attemptId))!.frozen, undefined);
      writeFileSync(path, original);
    }
    // With the blobs whole again the same move goes through.
    assert.equal((await c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "whole"))).to, r2.id);
  }, { policy: open });

  suite("an attempt that has done work and has no checkpoint cannot be moved; one that has not started work can, with nothing to carry", async (c) => {
    const { r1, r2, attemptId, attempt } = await running(c, { checkpoint: false });
    r1.worker.silent = true;
    await refuses("invalid_transition", () => c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "nock")), (e) => assert.match(e.message, /made 1 call\(s\) and no checkpoint reached the controller/));
    assert.equal((await attempt.heartbeat()).until > c.clock.now(), true);
    assert.equal((await c.current.get(c.owner, attemptId))!.frozen, undefined, "the freeze was lifted");
    // A second attempt that has made no call moves without a checkpoint.
    const bob = await c.started(r1, "fresh", { agent: "bob" });
    const moved = await c.remote.relocate(c.owner, MOVE(c, bob.attemptId, r2, "fresh-1"));
    assert.equal(moved.checkpoint, "none");
    assert.deepEqual((await c.current.get(c.owner, bob.attemptId))!.pinnedHost, r2.id);
  }, { policy: open });

  suite("a partition: the old host does not answer a request for a checkpoint, so the last one it sent is used, and the move still fences it", async (c) => {
    const { r1, r2, attemptId, attempt } = await running(c);
    r1.worker.silent = true;
    const moved = await c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "part"));
    assert.equal(moved.checkpoint, "stored");
    await wireRefuses("fenced", () => attempt.putCheckpoint(2, { turn: 2 }), 409);
    assert.deepEqual((await c.current.get(c.owner, attemptId))!.resumeFrom, { turn: 1, said: "ordered" });
    // The old host, back on the network, finds out at its next message and not before; nothing it sent in between was acted on.
    assert.deepEqual((await c.ops(attemptId)).map((o) => o.callId), ["c1"]);
  }, { policy: open });

  suite("calls in flight when an attempt moves are settled on the controller and the old host cannot finish them afterwards", async (c) => {
    const { r2, attemptId, attempt } = await running(c);
    const begun = await attempt.begin(READ("slow"));
    assert.equal(begun.run, true);
    await c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "inflight"));
    const op = (await c.ops(attemptId)).find((o) => o.callId === "slow")!;
    assert.notEqual(op.state, "in-progress");
    assert.ok(["cancelled", "uncertain"].includes(op.state), op.state);
    await wireRefuses("fenced", () => attempt.report(begun.operationId, { state: "confirmed", text: "too late" }), 409);
    assert.equal((await c.ops(attemptId)).find((o) => o.callId === "slow")!.state, op.state);
  }, { policy: open });

  suite("a move that stopped after the fence is finished by repeating the command; two moves at once cannot both win", async (c) => {
    const { r1, r2, attemptId } = await running(c);
    const r3 = await c.host("r3");
    const real = c.current.relocate.bind(c.current);
    (c.current as { relocate: typeof c.current.relocate }).relocate = async () => { throw new DomainError("unavailable", "the dispatcher could not be reached"); };
    await refuses("unavailable", () => c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "half")));
    // The fence is in place and the store has moved; the dispatcher still thinks the attempt runs on the old host.
    const half = (await c.remote.placement(c.owner, attemptId))!;
    assert.deepEqual([half.hostId, half.state, half.placement], [r2.id, "relocating", 2]);
    assert.equal((await c.current.get(c.owner, attemptId))!.pinnedHost, undefined);
    (c.current as { relocate: typeof c.current.relocate }).relocate = real;
    const done = await c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "half"));
    assert.equal(done.to, r2.id);
    assert.equal((await c.current.get(c.owner, attemptId))!.pinnedHost, r2.id);
    assert.equal((await c.remote.placement(c.owner, attemptId))!.relocations, 1);
    // A second attempt, moved by two commands to two hosts at once: exactly one wins.
    const bob = await c.started(r1, "second", { agent: "bob" });
    await bob.attempt.putCheckpoint(1, { n: 1 });
    const results = await Promise.allSettled([c.remote.relocate(c.owner, MOVE(c, bob.attemptId, r2, "race-a")), c.remote.relocate(c.owner, MOVE(c, bob.attemptId, r3, "race-b"))]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(results.map((r) => r.status === "rejected" ? String((r.reason as Error).message) : "ok")));
    const record = (await c.remote.placement(c.owner, bob.attemptId))!;
    assert.equal(record.relocations, 1);
    assert.ok([r2.id, r3.id].includes(record.hostId));
  }, { policy: open });

  suite("only a live attempt moves", async (c) => {
    const { r2, attemptId, attempt } = await running(c);
    await attempt.complete({ status: "completed", text: "done" });
    await refuses("invalid_transition", () => c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "done")), (e) => assert.match(e.message, /is completed; only a live or parked attempt moves|is not live under the dispatcher/));
    await c.current.idle();
    await refuses("invalid_transition", () => c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "done2")));
  }, { policy: open });

  suite("the native Pi store has one exclusive owner host: another host cannot run the agent, a second attempt waits for the first and then runs once, and the store moves only by relocation or the owner's explicit move", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const first = await c.started(r1);
    const store = (await c.remote.store(c.owner, "agent:ann"))!;
    assert.deepEqual([store.ownerHostId, store.liveAttempt], [r1.id, first.attemptId]);
    // The same agent's next task waits while the first attempt holds the store: not failed, no blocker, no placement.
    const second = await c.task("second task", { aid: "ann" });
    const waiting = await c.tick();
    assert.deepEqual(waiting.started, []);
    assert.match(waiting.skipped.find((x) => x.attemptId === second.attemptId)!.reason, /native store of agent:ann is held by another attempt/);
    assert.deepEqual(waiting.blocked, []);
    assert.equal(await c.remote.placement(c.owner, second.attemptId!), undefined);
    // The first ends: the second starts, once, and on the host that owns the store even though r2 is preferred.
    await first.attempt.complete({ status: "completed" });
    await c.current.idle();
    c.prefer(r2);
    const go = await c.tick();
    assert.deepEqual(go.started, [second.attemptId]);
    assert.equal((await c.current.get(c.owner, second.attemptId!))!.hostId, r1.id);
    assert.equal((await c.remote.store(c.owner, "agent:ann"))!.liveAttempt, second.attemptId);
    assert.deepEqual((await c.tick()).started, [], "it is not started twice");
    // The placement itself is the backstop: asked to place the agent on r2 it refuses.
    await refuses("invalid_command", () => c.remote.place(c.dispatcherPrincipal, { hostId: r2.id, order: { ...r1.worker.starts[0]!, agentId: "agent:ann" }, requirements: { data: "cloud-allowed" } }));
    const done = (await r1.client.offers())[0]!;
    await r1.client.attempt(second.attemptId!, done.placement).accept();
    await r1.client.attempt(second.attemptId!, done.placement).complete({ status: "completed" });
    await c.current.idle();
    // Only the owner moves a store, only to a connected and fresh host, and a repeat is the same move.
    const ann1 = await c.principals.authenticate((await c.principals.issueCredential(c.owner, "agent:ann")).token);
    await refuses("forbidden", () => c.remote.moveStore(ann1, { commandId: "ms-0", agentId: "agent:ann", toHostId: r2.id }));
    await refuses("forbidden", () => c.remote.moveStore(r1.principal, { commandId: "ms-0", agentId: "agent:ann", toHostId: r2.id }));
    const idle = await c.host("idle", { connect: false });
    await refuses("invalid_command", () => c.remote.moveStore(c.owner, { commandId: "ms-1", agentId: "agent:ann", toHostId: idle.id }), (e) => assert.match(e.message, /has not connected/));
    const moved = await c.remote.moveStore(c.owner, { commandId: "ms-2", agentId: "agent:ann", toHostId: r2.id });
    assert.deepEqual(await c.remote.moveStore(c.owner, { commandId: "ms-2", agentId: "agent:ann", toHostId: r2.id }), { ...moved, replayed: true });
    assert.deepEqual([(await c.remote.store(c.owner, "agent:ann"))!.ownerHostId, (await c.remote.store(c.owner, "agent:ann"))!.moves], [r2.id, 1]);
    // Now r2 runs the agent, and a live attempt pins the store.
    c.prefer(r1);
    const fourth = await c.task("fourth task", { aid: "ann" });
    const ok = await c.tick();
    assert.deepEqual(ok.started, [fourth.attemptId], JSON.stringify(ok.skipped));
    assert.equal((await c.current.get(c.owner, fourth.attemptId!))!.hostId, r2.id);
    await refuses("invalid_transition", () => c.remote.moveStore(c.owner, { commandId: "ms-3", agentId: "agent:ann", toHostId: r1.id }), (e) => assert.match(e.message, /is live; its store cannot move/));
    assert.equal((await c.remote.store(c.owner, "agent:ann"))!.liveAttempt, fourth.attemptId);
  });

  suite("two writes to one placement at once are both applied: concurrent control messages and concurrent publications are all recorded", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1);
    const seqs = await Promise.all([c.remote.control(c.owner, attemptId, { kind: "tell", text: "one" }), c.remote.control(c.owner, attemptId, { kind: "stop", emergency: false }), c.remote.control(c.dispatcherPrincipal, attemptId, { kind: "checkpoint" })]);
    assert.deepEqual([...seqs].sort(), [1, 2, 3]);
    assert.deepEqual((await attempt.pollControl()).map((m) => m.kind).sort(), ["checkpoint", "stop", "tell"]);
    const made = await Promise.all([1, 2, 3, 4].map((i) => attempt.publish(`out ${i}`, [{ path: `f${i}.txt`, content: bytes(`file ${i}`) }], `pub-c-${i}`)));
    assert.equal(new Set(made.map((m) => m.artifactId)).size, 4);
    assert.deepEqual([...(await c.remote.placement(c.owner, attemptId))!.outputs].sort(), made.map((m) => m.artifactId).sort());
  });

  suite("a worker that answers the request for a checkpoint with its own, and a result sent with a checkpoint that is repeated, store one checkpoint each", async (c) => {
    const { r2, attemptId, attempt } = await running(c);
    const before = (await c.remote.placement(c.owner, attemptId))!.checkpoints;
    const moved = await c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "worker-answers"));
    assert.equal(moved.checkpoint, "fresh");
    assert.equal((await c.remote.placement(c.owner, attemptId))!.checkpoints, before + 1, "the worker's own checkpoint is the one used, not stored again");
    // A result with a checkpoint, sent again after its answer was lost, stores the checkpoint once.
    const bob = await c.started(r2, "b", { agent: "bob" });
    await bob.attempt.complete({ status: "completed", checkpoint: { end: 1 } }, "same");
    await bob.attempt.complete({ status: "completed", checkpoint: { end: 1 } }, "same");
    assert.equal((await c.remote.placement(c.owner, bob.attemptId))!.checkpoints, 1);
    void attempt;
  }, { policy: open });

  suite("a repeated move is finished while it is half done and answered, not redone, once the target has the attempt; another command with the same reason is not a repeat", async (c) => {
    const { r1, r2, attemptId } = await running(c);
    const real = c.current.relocate.bind(c.current);
    (c.current as { relocate: typeof c.current.relocate }).relocate = async () => { throw new DomainError("unavailable", "down"); };
    await refuses("unavailable", () => c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "half-1")));
    (c.current as { relocate: typeof c.current.relocate }).relocate = real;
    // Another command (another ID and reason) to the same target finishes the half-done move.
    const done = await c.remote.relocate(c.owner, { commandId: "half-2", attemptId, toHostId: r2.id, reason: "a different reason" });
    assert.equal(done.to, r2.id);
    assert.equal((await c.remote.placement(c.owner, attemptId))!.relocations, 1);
    assert.deepEqual((await c.tick()).started, [attemptId]);
    const offer = (await r2.client.offers())[0]!;
    const next = r2.client.attempt(attemptId, offer.placement);
    await next.accept();
    assert.equal((await next.call(READ("on-r2"), local("working"))).state, "confirmed");
    // The target is working: the same command asked again is answered and does nothing; a new one says the attempt is there.
    const again = await c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "half-1"));
    assert.deepEqual([again.to, again.placement], [r2.id, offer.placement]);
    await refuses("invalid_command", () => c.remote.relocate(c.owner, { commandId: "half-3", attemptId, toHostId: r2.id, reason: "r1 is being retired" }), (e) => assert.match(e.message, /already on/));
    assert.equal((await c.current.get(c.owner, attemptId))!.state, "running", "the target's turn was not stopped");
    assert.equal((await next.call(READ("still"), local("still working"))).state, "confirmed");
    assert.equal((await c.remote.placement(c.owner, attemptId))!.relocations, 1);
    void r1;
  }, { policy: open });

  suite("an attempt that parked on a host that has gone away can be moved: its ended placement is fenced and handed on with the checkpoint it parked with", async (c) => {
    const { r1, r2, attemptId, attempt, placement } = await running(c);
    // What the dispatcher does when a turn ends with every call waiting for an approval: the placement ends with the run and the attempt parks, pinned to its host, with its checkpoint.
    const ref = { kind: "dispatch", id: derivedId("dpa", attemptId) };
    const found = (await c.storage.getAggregate(ref))!;
    await commitOperation(c.storage, { operationId: "cmd:park-fixture", epoch: c.epoch, actor: "fixture", correlationId: "park-fixture", at: c.clock.now(), changes: [{ type: "update", ref, expectedRevision: found.revision, body: { ...(found.body as object), state: "parked", pinnedHost: r1.id, resumeFrom: { parked: true } } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] }, { attempts: 3, pause: async () => undefined });
    await c.remote.end(c.dispatcherPrincipal, attemptId, "parked", placement);
    assert.equal((await c.remote.placement(c.owner, attemptId))!.state, "ended");
    await wireRefuses("fenced", () => attempt.heartbeat(), 409);
    // r1 does not come back. The owner moves the parked attempt.
    const moved = await c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "r1-is-gone"));
    assert.equal(moved.placement, placement + 1);
    const after = (await c.current.get(c.owner, attemptId))!;
    assert.deepEqual([after.state, after.pinnedHost], ["parked", r2.id]);
    assert.deepEqual(after.resumeFrom, { turn: 1, said: "ordered" }, "the checkpoint the placement held");
    const record = (await c.remote.placement(c.owner, attemptId))!;
    assert.deepEqual([record.state, record.hostId, (await c.remote.store(c.owner, "agent:ann"))!.ownerHostId], ["relocating", r2.id, r2.id]);
    // An ended placement of an attempt that is not parked does not move.
    const bob = await c.started(r1, "b", { agent: "bob" });
    await c.remote.end(c.dispatcherPrincipal, bob.attemptId, "ended", bob.placement);
    await refuses("invalid_transition", () => c.remote.relocate(c.owner, MOVE(c, bob.attemptId, r2, "no")), (e) => assert.match(e.message, /only a live or parked attempt moves/));
  }, { policy: open });

  suite("a move that fails at its commit, or an older move repeated after newer ones, leaves the running attempt as it was and not frozen", async (c) => {
    const { r1, r2, attemptId } = await running(c);
    const r3 = await c.host("r3");
    r3.worker.requirements = r2.worker.requirements;
    const next = async (to: RemoteHost, key: string) => {
      await c.remote.relocate(c.owner, MOVE(c, attemptId, to, key));
      await c.tick();
      const offer = (await to.client.offers())[0]!;
      const a = to.client.attempt(attemptId, offer.placement);
      await a.accept();
      return a;
    };
    await next(r2, "move-a");
    const onR3 = await next(r3, "move-b");
    // Repeating the first move now is refused before anything is disturbed.
    await refuses("command_conflict", () => c.remote.relocate(c.owner, MOVE(c, attemptId, r2, "move-a")));
    assert.equal((await c.current.get(c.owner, attemptId))!.frozen, undefined);
    assert.equal((await onR3.call(READ("after-repeat"), local("fine"))).state, "confirmed");
    // A commit that throws (storage error injected) after the old host was quiesced lifts the freeze.
    const real = c.storage.applyOperation.bind(c.storage);
    c.storage.applyOperation = async (input) => {
      if (input.changes.some((ch) => ch.ref.kind === "remote-placement" && ch.type === "update" && (ch.body as { state?: string }).state === "relocating")) throw new Error("disk full");
      return real(input);
    };
    await refuses("unavailable", () => c.remote.relocate(c.owner, MOVE(c, attemptId, r1, "move-c")));
    c.storage.applyOperation = real;
    assert.equal((await c.current.get(c.owner, attemptId))!.frozen, undefined, "the freeze was lifted");
    assert.equal((await onR3.call(READ("after-failure"), local("fine"))).state, "confirmed");
    assert.equal((await c.remote.placement(c.owner, attemptId))!.hostId, r3.id);
  }, { policy: async () => ({ dataHosts: ["host:r1", "host:r2", "host:r3"] }) });
}

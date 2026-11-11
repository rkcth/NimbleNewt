import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { WorkOrder } from "../dispatch/ports.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { checkContract, contractDigest, contractProblems, sealContract, type WorkerAbilities } from "./contract.js";
import { restartDigest } from "./contract-wire.js";
import { FULL_ABILITIES, READ, local, remoteSuite, wireRefuses } from "./testing/suite.js";

after(stopServer);

const ORDER: WorkOrder = { attemptId: "att-aaaaaaaaaaaa", taskId: "tsk-aaaaaaaaaaaa", projectId: "prj-aaaaaaaaaaaa", agentId: "agent:ann", generation: 1, route: "localp/small", credential: "secret.token", recipe: { revision: "r-1", reach: ["read-file"] }, content: "do it", requestId: "cmd:adm:1", expiresAt: "2030-01-01T00:00:00.000Z" };
const NOW = "2026-10-31T00:00:00.000Z";
const LIMITED = sealContract(ORDER, { taskContractVersion: 3, permissions: ["tool.read-file", "class.inspect"], budget: { maxMinutes: 30, held: { computeMs: 1000 } }, limits: { memoryMb: 512, processes: 50 }, bestEffort: false });

test("the contract is sealed to its order: the digest covers identity, recipe, expiry and every figure, never the credential", () => {
  const c = LIMITED.contract!;
  assert.equal(c.format, 1);
  assert.deepEqual(c.requires, ["limits", "wall-time"]);
  assert.equal(checkContract(LIMITED).digest, c.digest);
  const { digest, ...rest } = c;
  assert.equal(contractDigest(LIMITED, rest), digest);
  assert.equal(contractDigest({ ...LIMITED, credential: "another" }, rest), digest, "the credential is not part of it");
  for (const changed of [{ ...LIMITED, route: "localp/big" }, { ...LIMITED, generation: 2 }, { ...LIMITED, recipe: { revision: "r-1", reach: [] } }, { ...LIMITED, expiresAt: "2031-01-01T00:00:00.000Z" }, { ...LIMITED, agentId: "agent:bob" }]) {
    assert.notEqual(contractDigest(changed, rest), digest);
    assert.throws(() => checkContract(changed as WorkOrder), /digest/);
  }
  for (const edit of [{ permissions: [] }, { limits: { memoryMb: 4096, processes: 50 } }, { bestEffort: true }, { budget: { maxMinutes: 999 } }]) {
    assert.throws(() => checkContract({ ...LIMITED, contract: { ...c, ...edit } }), /digest/, JSON.stringify(edit));
  }
});

test("a contract of the wrong shape is refused: unknown fields, limits out of bounds, an unlisted limit, too many permissions", () => {
  const c = LIMITED.contract!;
  for (const bad of [{ ...c, extra: 1 }, { ...c, limits: { memoryMb: 1 } }, { ...c, limits: { gpus: 2 } }, { ...c, limits: { cpus: 1.5 } }, { ...c, permissions: Array.from({ length: 201 }, () => "tool.x") }, { ...c, bestEffort: "yes" }, { ...c, digest: 7 }, { ...c, requires: "limits" }]) {
    assert.throws(() => checkContract({ ...LIMITED, contract: bad as never }), /order\.contract/, JSON.stringify(bad).slice(0, 80));
  }
  assert.throws(() => checkContract(ORDER), /must be an object/);
});

test("a worker refuses what it cannot honour, and an order without a contract; best effort lets a partial limit through", () => {
  assert.deepEqual(contractProblems(LIMITED, FULL_ABILITIES, NOW), []);
  assert.deepEqual(contractProblems(ORDER, FULL_ABILITIES, NOW), ["the order carries no dispatch contract"]);
  assert.match(contractProblems(LIMITED, { ...FULL_ABILITIES, formats: [2] }, NOW)[0]!, /format 1/);
  assert.match(contractProblems(LIMITED, { ...FULL_ABILITIES, features: ["wall-time"] }, NOW).join(), /cannot enforce limits/);
  assert.match(contractProblems(LIMITED, { ...FULL_ABILITIES, features: ["limits"] }, NOW).join(), /cannot enforce wall-time/);
  const partial: WorkerAbilities = { ...FULL_ABILITIES, enforces: { ...FULL_ABILITIES.enforces, memoryMb: "partial", processes: "none" } };
  const why = contractProblems(LIMITED, partial, NOW).join("; ");
  assert.match(why, /memoryMb \(512\).*only in part/);
  assert.match(why, /processes \(50\).*not at all/);
  const lenient = sealContract(ORDER, { taskContractVersion: 3, permissions: [], limits: { memoryMb: 512, processes: 50 }, bestEffort: true });
  assert.deepEqual(contractProblems(lenient, partial, NOW), []);
  assert.match(contractProblems(LIMITED, FULL_ABILITIES, "2031-06-01T00:00:00.000Z").join(), /expired/);
  assert.match(contractProblems({ ...LIMITED, route: "other/model" }, FULL_ABILITIES, NOW).join(), /digest/, "an order altered after sealing");
});

const expectedShort = "the limit memoryMb is enforced only in part and best effort is not allowed";

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("the dispatcher's order carries a sealed contract, and no tool call is decided until the worker confirms it for this placement", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, order, attempt, placement } = await c.started(r1, "Order seeds", { unconfirmed: true });
    assert.equal(checkContract(order).digest, order.contract!.digest);
    assert.equal(order.contract!.format, 1);
    assert.deepEqual(order.contract!.requires, ["wall-time"].filter(() => order.expiresAt !== undefined));
    // Before the confirmation: nothing is judged, recorded or run, the lease still counts.
    await wireRefuses("invalid_transition", () => attempt.begin(READ("c1")), 409, (e) => assert.match(e.message, /confirm/));
    await wireRefuses("invalid_transition", () => attempt.call(READ("c1"), local("x")), 409);
    assert.deepEqual(await c.ops(attemptId), []);
    // Another digest is not a confirmation, and neither is a confirmation of an older placement.
    await wireRefuses("fenced", () => r1.client.send("POST", `/worker/attempts/${attemptId}/launched`, { body: { placement, digest: "0".repeat(64), enforcement: [] }, session: true }), 409);
    await wireRefuses("fenced", () => r1.client.send("POST", `/worker/attempts/${attemptId}/launched`, { body: { placement: placement + 1, digest: order.contract!.digest, enforcement: [] }, session: true }), 409);
    await wireRefuses("invalid_transition", () => attempt.begin(READ("c1")), 409);
    assert.deepEqual(await attempt.honorContract(order, FULL_ABILITIES, c.clock.now()), { ok: true });
    assert.equal((await attempt.call(READ("c1"), local("ok"))).state, "confirmed");
    // The same confirmation again is the same answer; another set of figures is not.
    assert.deepEqual(await attempt.honorContract(order, FULL_ABILITIES, c.clock.now()), { ok: true });
    const stored = (await c.remote.placement(c.owner, attemptId))!;
    assert.equal(stored.contract!.launched!.sessionId, stored.sessionId);
    assert.equal((await c.ops(attemptId)).length, 1);
  });

  suite("a worker that cannot honour the contract refuses the order: the run ends failed with the reasons, the attempt is not started again, nothing ran", async (c) => {
    const r1 = await c.host("r1");
    r1.worker.seal = (o) => sealContract(o, { taskContractVersion: 1, permissions: [], limits: { memoryMb: 512, diskMb: 100 }, bestEffort: false });
    const { attemptId, order, attempt } = await c.started(r1, "Order seeds", { unconfirmed: true });
    assert.deepEqual(order.contract!.limits, { memoryMb: 512, diskMb: 100 });
    const weak: WorkerAbilities = { ...FULL_ABILITIES, enforces: { ...FULL_ABILITIES.enforces, diskMb: "none" } };
    const answer = await attempt.honorContract(order, weak, c.clock.now());
    assert.equal(answer.ok, false);
    assert.match((answer as unknown as { reasons: string[] }).reasons.join(), /diskMb \(100\).*not at all/);
    await c.current.idle();
    const dispatch = (await c.current.get(c.owner, attemptId))!;
    assert.equal(dispatch.state, "finished");
    assert.equal(dispatch.outcome!.status, "failed");
    assert.match(dispatch.outcome!.summary, /refused the dispatch contract.*diskMb/);
    assert.deepEqual(await c.ops(attemptId), []);
    const stored = (await c.remote.placement(c.owner, attemptId))!;
    assert.equal(stored.state, "completed");
    assert.equal(stored.contract!.launched, undefined);
    assert.match(stored.contract!.refused!.join(), /diskMb/);
    await wireRefuses("fenced", () => attempt.begin(READ("c1")), 409);
  });

  suite("the controller does not take the worker's word that a limit is held: a confirmation that is short, wrong or silent ends the run unless best effort is allowed", async (c) => {
    const r1 = await c.host("r1");
    r1.worker.seal = (o) => sealContract(o, { taskContractVersion: 1, permissions: [], limits: { memoryMb: 512, processes: 40 }, bestEffort: false });
    const { attemptId, order, attempt, placement } = await c.started(r1, "Order seeds", { unconfirmed: true });
    const post = (enforcement: unknown[]) => r1.client.send("POST", `/worker/attempts/${attemptId}/launched`, { body: { placement, digest: order.contract!.digest, enforcement: enforcement as never }, session: true });
    // Unknown limit, bad level, duplicate entry, too many entries: malformed, nothing recorded.
    await wireRefuses("invalid_command", () => post([{ limit: "gpus", value: 1, enforced: "full" }]), 400);
    await wireRefuses("invalid_command", () => post([{ limit: "memoryMb", value: 512, enforced: "mostly" }]), 400);
    await wireRefuses("invalid_command", () => post([{ limit: "memoryMb", value: 512, enforced: "full" }, { limit: "memoryMb", value: 512, enforced: "full" }]), 400);
    await wireRefuses("invalid_transition", () => attempt.begin(READ("c1")), 409);
    // Wrong figure, so the worker would run under another limit than the owner's: the controller ends the run itself.
    const wrong = await post([{ limit: "memoryMb", value: 4096, enforced: "full" }, { limit: "processes", value: 40, enforced: "full" }]);
    assert.equal((wrong.body as { confirmed: boolean }).confirmed, false);
    await c.current.idle();
    const dispatch = (await c.current.get(c.owner, attemptId))!;
    assert.equal(dispatch.outcome!.status, "failed");
    assert.match(dispatch.outcome!.summary, /memoryMb was confirmed at 4096/);
    await wireRefuses("fenced", () => attempt.begin(READ("c1")), 409);
  });

  suite("a short confirmation is accepted when the owner allowed best effort, and a silent one never is", async (c) => {
    const r1 = await c.host("r1");
    // Without best effort a partial limit is not accepted, whatever the worker meant to do about it.
    r1.worker.seal = (o) => sealContract(o, { taskContractVersion: 1, permissions: [], limits: { memoryMb: 512 }, bestEffort: false });
    const strict = await c.started(r1, "Strict task", { agent: "cy", unconfirmed: true });
    const short = await r1.client.send("POST", `/worker/attempts/${strict.attemptId}/launched`, { body: { placement: strict.placement, digest: strict.order.contract!.digest, enforcement: [{ limit: "memoryMb", value: 512, enforced: "partial" }] as never }, session: true });
    assert.deepEqual(short.body, { confirmed: false, reasons: [expectedShort] });
    await c.current.idle();
    assert.equal((await c.current.get(c.owner, strict.attemptId))!.outcome!.status, "failed");
    r1.worker.seal = (o) => sealContract(o, { taskContractVersion: 1, permissions: [], limits: { memoryMb: 512, processes: 40 }, bestEffort: true });
    const { attemptId, order, attempt, placement } = await c.started(r1, "Order seeds", { unconfirmed: true });
    const post = (enforcement: unknown[]) => r1.client.send("POST", `/worker/attempts/${attemptId}/launched`, { body: { placement, digest: order.contract!.digest, enforcement: enforcement as never }, session: true });
    const silent = await post([{ limit: "memoryMb", value: 512, enforced: "full" }]);
    assert.equal((silent.body as { confirmed: boolean }).confirmed, false, "a limit the confirmation does not mention is not held");
    const second = await c.started(r1, "Second task", { agent: "bob", unconfirmed: true });
    const post2 = (enforcement: unknown[]) => r1.client.send("POST", `/worker/attempts/${second.attemptId}/launched`, { body: { placement: second.placement, digest: second.order.contract!.digest, enforcement: enforcement as never }, session: true });
    const ok = await post2([{ limit: "memoryMb", value: 512, enforced: "partial", detail: "cgroup missing" }, { limit: "processes", value: 40, enforced: "none" }]);
    assert.equal((ok.body as { confirmed: boolean }).confirmed, true);
    assert.equal((await second.attempt.call(READ("c1"), local("ok"))).state, "confirmed");
    void attempt;
    // The confirmed figures are on the placement for the owner to see.
    const stored = (await c.remote.placement(c.owner, second.attemptId))!;
    assert.deepEqual(stored.contract!.launched!.enforcement.map((e) => [e.limit, e.enforced]), [["memoryMb", "partial"], ["processes", "none"]]);
  });

  suite("a move or a second placement starts over: the new holder must confirm the contract of its own placement before any call", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    r1.worker.requirements = () => ({ data: "local-only", harness: "pi", isolation: ["bubblewrap"], workspaces: ["garden"] });
    r2.worker.requirements = r1.worker.requirements;
    const { attemptId, attempt, order: first } = await c.started(r1);
    assert.equal((await attempt.call(READ("c1"), local("one"))).state, "confirmed");
    await attempt.putCheckpoint(1, { turn: 1 });
    await c.remote.relocate(c.owner, { commandId: "mv-1", attemptId, toHostId: r2.id, reason: "retired" });
    assert.deepEqual((await c.tick()).started, [attemptId]);
    const offer = (await r2.client.offers())[0]!;
    assert.notEqual(offer.order.contract!.digest, "");
    const next = r2.client.attempt(attemptId, offer.placement);
    await next.accept();
    assert.equal((await c.remote.placement(c.owner, attemptId))!.contract!.launched, undefined, "the old host's confirmation does not carry over");
    await wireRefuses("invalid_transition", () => next.begin(READ("c2")), 409);
    // A confirmation or a refusal that was delayed on the old host's side arrives after the move and is fenced.
    await wireRefuses("fenced", () => attempt.honorContract(first, FULL_ABILITIES, c.clock.now()), 409);
    await wireRefuses("fenced", () => attempt.honorContract(first, { ...FULL_ABILITIES, formats: [9] }, c.clock.now()), 409);
    assert.equal((await c.remote.placement(c.owner, attemptId))!.contract!.launched, undefined);
    assert.deepEqual(await next.honorContract(offer.order, FULL_ABILITIES, c.clock.now()), { ok: true });
    assert.equal((await next.call(READ("c2"), local("two"))).state, "confirmed");
  }, { policy: async () => ({ dataHosts: ["host:r1", "host:r2"] }) });

  suite("until the worker confirms the contract nothing is decided or kept: no checkpoint, no artifact, no completed turn; usage is booked, and heartbeats are accepted only for a bounded window", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, order, attempt } = await c.started(r1, "Order seeds", { unconfirmed: true });
    await wireRefuses("invalid_transition", () => attempt.putCheckpoint(1, { turn: 1 }), 409);
    await wireRefuses("invalid_transition", () => attempt.publish("out", [{ path: "a.txt", content: new TextEncoder().encode("x") }]), 409, (e) => assert.match(e.message, /publishing an artifact/));
    await wireRefuses("invalid_transition", () => attempt.complete({ status: "completed", text: "done" }), 409, (e) => assert.match(e.message, /completing a turn/));
    assert.equal((await c.remote.placement(c.owner, attemptId))!.state, "accepted");
    assert.equal((await c.remote.placement(c.owner, attemptId))!.checkpoint, undefined);
    // Usage before the confirmation is booked (the money was spent), and it is not a confirmation.
    await attempt.usage({ turnSeq: 1, costMicros: 5 });
    assert.equal((await c.remote.placement(c.owner, attemptId))!.contract!.launched, undefined);
    // A slow sandbox start: heartbeats are accepted inside the window, refused after it.
    await attempt.heartbeat();
    c.clock.advance(30_000);
    await attempt.heartbeat();
    c.clock.advance(31_000);
    await wireRefuses("invalid_transition", () => attempt.heartbeat(), 409, (e) => assert.match(e.message, /confirmation window/));
    c.confirmWindow.ms = 10 * 60_000;
    await attempt.heartbeat();
    // After the confirmation the same messages are taken.
    assert.deepEqual(await attempt.honorContract(order, FULL_ABILITIES, c.clock.now()), { ok: true });
    await attempt.heartbeat();
    await attempt.putCheckpoint(1, { turn: 1 });
    assert.equal((await attempt.complete({ status: "completed", text: "done" })).status, "completed");
  });

  suite("a worker that gives up before confirming may still end the run as failed (that is not a turn)", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1, "Order seeds", { unconfirmed: true });
    assert.equal((await attempt.complete({ status: "failed", error: "could not start" })).status, "failed");
    await c.current.idle();
    assert.equal((await c.remote.placement(c.owner, attemptId))!.state, "completed");
  });

  suite("limits rest on the worker's attestation, bounded by per-call checks, lease and expiry: the controller cannot measure them, so a confirmation that claims full enforcement is believed", async (c) => {
    const r1 = await c.host("r1");
    r1.worker.seal = (o) => sealContract(o, { taskContractVersion: 1, permissions: [], limits: { memoryMb: 512, processes: 40 }, bestEffort: false });
    const { attemptId, order, attempt } = await c.started(r1, "Order seeds", { unconfirmed: true });
    // Nothing here checks a cgroup or an rlimit: a worker that says "full" is recorded as having said it, with its host named.
    assert.deepEqual(await attempt.honorContract(order, FULL_ABILITIES, c.clock.now()), { ok: true });
    const stored = (await c.remote.placement(c.owner, attemptId))!;
    assert.ok(stored.contract!.launched!.enforcement.every((e) => e.enforced === "full"));
    assert.deepEqual(c.launches.filter((l) => l.attemptId === attemptId).map((l) => l.outcome), ["started"]);
    // What still binds it is the controller's own checking of every call and the lease; an expired attempt is fenced.
    assert.equal((await attempt.call(READ("c1"), local("ok"))).state, "confirmed");
  });

  suite("a remote placement without a contract is refused: the gate cannot be skipped by leaving the contract out", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, order } = await c.started(r1);
    const { contract: _c, ...bare } = order; void _c;
    await assert.rejects(c.remote.place(c.owner, { hostId: r1.id, order: bare as typeof order, requirements: { data: "local-only" } }), (e: unknown) => (e as { code?: string }).code === "invalid_command" && /no dispatch contract/.test((e as Error).message));
    assert.equal((await c.remote.placement(c.owner, attemptId))!.placement, 1, "nothing was placed again");
  });

  suite("a restart that changes the reach or the limits needs a new confirmation; the same recipe does not", async (c) => {
    const r1 = await c.host("r1");
    r1.worker.seal = (o) => sealContract(o, { taskContractVersion: 1, permissions: [], limits: { memoryMb: 512 }, bestEffort: false });
    const { attemptId, order, attempt, placement } = await c.started(r1);
    const first = order.contract!.digest;
    assert.equal((await attempt.call(READ("c1"), local("one"))).state, "confirmed");
    const restart = (recipe: { revision: string; reach: string[]; limits?: Record<string, number> }) => c.remote.control(c.owner, attemptId, { kind: "restart", recipe, checkpoint: { turn: 1 } }, placement);
    // The same reach and limits: nothing to confirm again.
    await restart({ revision: "r-2", reach: [...order.recipe.reach], ...(order.recipe.limits === undefined ? {} : { limits: { ...order.recipe.limits } }) });
    assert.equal((await c.remote.placement(c.owner, attemptId))!.contract!.digest, first);
    assert.equal((await attempt.call(READ("c2"), local("two"))).state, "confirmed");
    // A wider reach: the confirmation is cleared, the digest is that of the new recipe, no call until the worker confirms it.
    const wider = { revision: "r-3", reach: [...order.recipe.reach, "write-file"] };
    await restart(wider);
    const after = (await c.remote.placement(c.owner, attemptId))!.contract!;
    assert.equal(after.launched, undefined);
    assert.equal(after.digest, restartDigest(first, wider));
    await wireRefuses("invalid_transition", () => attempt.begin(READ("c3")), 409, (e) => assert.match(e.message, /confirm/));
    // The old digest is not a confirmation of the new launch.
    await wireRefuses("fenced", () => r1.client.send("POST", `/worker/attempts/${attemptId}/launched`, { body: { placement, digest: first, enforcement: [{ limit: "memoryMb", value: 512, enforced: "full" }] }, session: true }), 409);
    assert.deepEqual(await attempt.confirmRestart(first, { recipe: wider }, order.contract!, FULL_ABILITIES), { ok: true });
    assert.equal((await attempt.call(READ("c3"), local("three"))).state, "confirmed");
    // Dropping the limits is a change too; raising a limit above the owner's is refused outright.
    await restart({ revision: "r-4", reach: wider.reach, limits: { memoryMb: 256 } });
    assert.equal((await c.remote.placement(c.owner, attemptId))!.contract!.launched, undefined);
    await assert.rejects(restart({ revision: "r-5", reach: wider.reach, limits: { memoryMb: 4096 } }), /above the owner's limit/);
  });

  suite("a worker that sees a tampered order refuses it: the refusal ends the attempt as failed, also when the digest it names is not the controller's", async (c) => {
    const r1 = await c.host("r1");
    for (const [name, tamper] of [["route", (o: WorkOrder) => ({ ...o, route: "other/model" })], ["digest", (o: WorkOrder) => ({ ...o, contract: { ...o.contract!, digest: "f".repeat(64) } })]] as const) {
      const { attemptId, order, attempt } = await c.started(r1, `Order seeds ${name}`, { unconfirmed: true, agent: `ag${name}` });
      const answer = await attempt.honorContract(tamper(order), FULL_ABILITIES, c.clock.now());
      assert.equal(answer.ok, false, name);
      assert.match((answer as unknown as { reasons: string[] }).reasons.join(), /digest/);
      await c.current.idle();
      const dispatch = (await c.current.get(c.owner, attemptId))!;
      assert.equal(dispatch.state, "finished", name);
      assert.equal(dispatch.outcome!.status, "failed", name);
      const stored = (await c.remote.placement(c.owner, attemptId))!;
      assert.equal(stored.state, "completed", name);
      if (name === "digest") assert.match(stored.contract!.refused!.join(), /does not match the contract the controller sealed/);
      assert.equal(stored.contract!.launched, undefined);
      assert.deepEqual(c.launches.filter((l) => l.attemptId === attemptId).map((l) => l.outcome), ["refused"]);
    }
  });

  suite("the launch record says started once, after the confirmation is on the placement; the same confirmation again records nothing more", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, order, attempt } = await c.started(r1, "Order seeds", { unconfirmed: true });
    assert.equal(c.launches.length, 0);
    await attempt.honorContract(order, FULL_ABILITIES, c.clock.now());
    await attempt.honorContract(order, FULL_ABILITIES, c.clock.now());
    assert.deepEqual(c.launches.filter((l) => l.attemptId === attemptId).map((l) => l.outcome), ["started"]);
  });

  suite("after a restart that changed the recipe the heartbeat is still accepted for the window (the attempt is not lost while it reconfirms), and the worker flow confirms the restart itself", async (c) => {
    const r1 = await c.host("r1");
    r1.worker.seal = (o) => sealContract(o, { taskContractVersion: 1, permissions: [], limits: { memoryMb: 512 }, bestEffort: false });
    const { attemptId, order, attempt, placement } = await c.started(r1);
    const wider = { revision: "r-3", reach: [...order.recipe.reach, "write-file"] };
    await c.remote.control(c.owner, attemptId, { kind: "restart", recipe: wider, checkpoint: { turn: 1 } }, placement);
    assert.equal((await c.remote.placement(c.owner, attemptId))!.contract!.launched, undefined);
    await attempt.heartbeat();
    c.clock.advance(61_000);
    await wireRefuses("invalid_transition", () => attempt.heartbeat(), 409);
    // The worker's loop reads the control messages and confirms the restart through the client helper.
    const msgs = await attempt.pollControl(0);
    const held = { digest: order.contract!.digest, recipe: order.recipe };
    const done = await attempt.confirmRestarts(msgs, held, order.contract!, FULL_ABILITIES);
    assert.equal(done.refused, undefined);
    assert.equal(done.digest, restartDigest(held.digest, wider));
    await attempt.heartbeat();
    assert.equal((await attempt.call(READ("c9"), local("nine"))).state, "confirmed");
  });

  suite("a restart that drops a limit the attempt ran under is refused; one that keeps or tightens it is taken", async (c) => {
    const r1 = await c.host("r1");
    r1.worker.seal = (o) => sealContract({ ...o, recipe: { ...o.recipe, limits: { memoryMb: 512 } } }, { taskContractVersion: 1, permissions: [], limits: { memoryMb: 512 }, bestEffort: false });
    const { attemptId, order, placement } = await c.started(r1);
    const restart = (recipe: { revision: string; reach: string[]; limits?: Record<string, number> }) => c.remote.control(c.owner, attemptId, { kind: "restart", recipe, checkpoint: { turn: 1 } }, placement);
    await assert.rejects(restart({ revision: "r-2", reach: [...order.recipe.reach, "write-file"] }), /drops the limit memoryMb/);
    await restart({ revision: "r-3", reach: [...order.recipe.reach, "write-file"], limits: { memoryMb: 256 } });
  });

  suite("a confirmation kept but whose launch record failed is finished by the worker's retry; the record is written once", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, order, attempt } = await c.started(r1, "Order seeds", { unconfirmed: true });
    c.failLaunchRecords.count = 1;
    await assert.rejects(attempt.honorContract(order, FULL_ABILITIES, c.clock.now()));
    assert.equal(c.launches.filter((l) => l.attemptId === attemptId).length, 0);
    assert.deepEqual(await attempt.honorContract(order, FULL_ABILITIES, c.clock.now()), { ok: true });
    await attempt.honorContract(order, FULL_ABILITIES, c.clock.now());
    assert.deepEqual(c.launches.filter((l) => l.attemptId === attemptId).map((l) => l.outcome), ["started"]);
  });
}

// Card W12: the contract names the goal anchor at the top of the order's content by its digest, so the process that must put it back after a cut finds the controller's block and no other.
test("W12: the contract names the anchor in the order's content; a contract that names a block the content does not carry, or a malformed digest, is refused; the digest covers it", async () => {
  const { composeAnchor } = await import("../context/anchor.js");
  const block = composeAnchor({ taskId: "tsk-aaaaaaaaaaaa", projectId: "prj-aaaaaaaaaaaa", attemptId: "att-aaaaaaaaaaaa", title: "Water the plants" }, 2400)!;
  const withBlock: WorkOrder = { ...ORDER, content: `${block.text}\n\nWater the plants` };
  const sealed = sealContract(withBlock, { taskContractVersion: 1, permissions: [], bestEffort: false, anchorDigest: block.digest });
  assert.equal(checkContract(sealed).anchorDigest, block.digest);
  assert.equal(sealContract(withBlock, { taskContractVersion: 1, permissions: [], bestEffort: false }).contract!.anchorDigest, undefined, "no anchor, no field");
  // The digest of the contract covers the field: another digest or none no longer matches.
  const c = sealed.contract!;
  assert.throws(() => checkContract({ ...sealed, contract: { ...c, anchorDigest: "b".repeat(64) } }), /anchorDigest names no anchor block|digest/);
  const { anchorDigest: _drop, ...without } = c;
  assert.throws(() => checkContract({ ...sealed, contract: without }), /digest/);
  // The content must carry the block the contract names: a task text that holds a block of its own is not it.
  assert.throws(() => checkContract({ ...sealed, content: "Water the plants" }), /names no anchor block in the order's content/);
  assert.throws(() => checkContract({ ...sealed, contract: { ...c, anchorDigest: "not a digest" } }), /anchorDigest must be a SHA-256 in hex/);
});

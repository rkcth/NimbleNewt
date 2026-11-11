import assert from "node:assert/strict";
import { after } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { EffectBridge } from "../domain/effects.js";
import type { ToolResult } from "../dispatch/ports.js";
import { EffectService } from "../domain/effects.js";
import { remoteSuite, wireRefuses, type Ctx } from "./testing/suite.js";

after(stopServer);

// Card H12a: an effect call from a remote worker is run by the controller (its ledger, its bridge), judged and recorded like a local one, and never applied twice.

interface Log { applied: number; reconciled: number }
const bridge = (log: Log, hang?: { started: () => void; release: Promise<void> }): EffectBridge => ({
  idempotent: false,
  execute: async () => { log.applied++; if (hang !== undefined) { hang.started(); await hang.release; } return { receipt: "r" }; },
  reconcile: async () => { log.reconciled++; return { state: log.applied > 0 ? "applied" : "not_applied" }; },
});
const PUSH = (callId: string, branch = "feature-x") => ({ callId, tool: { name: "git-push", version: "2.0" }, args: { branch }, target: { kind: "branch", id: branch } });
const EFFECT = { kind: "git-push", target: "repo", input: { branch: "feature-x" } };
const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const autonomous = (c: Ctx): Promise<unknown> => c.policy.set(c.owner, { scope: "installation", commandId: "pol", profile: "autonomous" });

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("an effect call from a remote worker runs through the controller's ledger and bridge, once, however often the message arrives", async (c) => {
    const log: Log = { applied: 0, reconciled: 0 };
    c.bridges["git-push"] = bridge(log);
    await autonomous(c);
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1, "Push it", { tools: ["git-push"] });
    const first = await attempt.effect(PUSH("p1"), EFFECT);
    assert.equal(first.state, "confirmed");
    assert.equal(log.applied, 1);
    // The ledger holds the effect; the operation names it.
    const [op] = await c.ops(attemptId);
    assert.ok(op!.effectId !== undefined);
    const ledger = await c.effects.get(op!.effectId!);
    assert.equal(ledger!.status, "confirmed");
    assert.equal(ledger!.kind, "git-push");
    // A dropped answer: the worker asks again with the same call ID, and again, at once. Same call, same answer, one effect.
    const again = await attempt.effect(PUSH("p1"), EFFECT);
    assert.deepEqual(again, first);
    const burst: ToolResult[] = await Promise.all([1, 2, 3].map(() => attempt.effect(PUSH("p1"), EFFECT)));
    for (const b of burst) assert.deepEqual(b, first);
    // The same call through the executor form the worker's runtime uses (its own bridge is never sent or used).
    const never: EffectBridge = { idempotent: false, execute: async () => { throw new Error("the worker's own bridge must not run"); } };
    const viaCall = await attempt.call(PUSH("p2", "feature-y"), { kind: "effect", effectKind: "git-push", target: "repo", input: { branch: "feature-y" }, bridge: never });
    assert.equal(viaCall.state, "confirmed");
    assert.equal(log.applied, 2);
    assert.equal((await c.ops(attemptId)).length, 2);
    // The same call ID with another effect is not the same call and does not apply anything.
    // The same call ID with other figures is still that call: it is answered from the record and nothing is applied.
    assert.deepEqual(await attempt.effect(PUSH("p1"), { ...EFFECT, input: { branch: "feature-z" } }), first);
    assert.equal(log.applied, 2);
  });

  suite("the controller runs only its own bridges: an unknown kind, a prototype name and a malformed effect record and run nothing", async (c) => {
    const log: Log = { applied: 0, reconciled: 0 };
    c.bridges["git-push"] = bridge(log);
    await autonomous(c);
    const r1 = await c.host("r1");
    const { attemptId, attempt, placement } = await c.started(r1, "Push it", { tools: ["git-push"] });
    await wireRefuses("invalid_command", () => attempt.effect(PUSH("a"), { ...EFFECT, kind: "format-disk" }), 400, (e) => assert.match(e.message, /no bridge/));
    await wireRefuses("invalid_command", () => attempt.effect(PUSH("b"), { ...EFFECT, kind: "constructor" }), 400);
    await wireRefuses("invalid_command", () => attempt.effect(PUSH("c"), { ...EFFECT, kind: "" }), 400);
    await wireRefuses("invalid_command", () => attempt.effect(PUSH("d"), { ...EFFECT, input: [] as never }), 400);
    await wireRefuses("invalid_command", () => attempt.effect(PUSH("e"), { ...EFFECT, input: { blob: "x".repeat(70_000) } }), 400);
    // A field the contract does not have (a bridge, an address, a credential) is refused, not ignored.
    for (const extra of [{ bridge: "x" }, { credential: "secret" }, { url: "http://evil" }]) {
      await wireRefuses("invalid_command", () => r1.client.send("POST", `/worker/attempts/${attemptId}/effect`, { body: { placement, request: PUSH("f"), effect: { ...EFFECT, ...extra } }, session: true }), 400);
    }
    assert.equal(log.applied, 0);
    assert.deepEqual(await c.ops(attemptId), []);
  });

  suite("no effect is decided before the worker confirmed its dispatch contract, and nothing is run for a stale placement", async (c) => {
    const log: Log = { applied: 0, reconciled: 0 };
    c.bridges["git-push"] = bridge(log);
    await autonomous(c);
    const r1 = await c.host("r1");
    const { attemptId, attempt, placement } = await c.started(r1, "Push it", { tools: ["git-push"], unconfirmed: true });
    await wireRefuses("invalid_transition", () => attempt.effect(PUSH("p1"), EFFECT), 409, (e) => assert.match(e.message, /confirm/));
    await wireRefuses("fenced", () => r1.client.send("POST", `/worker/attempts/${attemptId}/effect`, { body: { placement: placement + 1, request: PUSH("p1"), effect: EFFECT }, session: true }), 409);
    assert.equal(log.applied, 0);
    assert.deepEqual(await c.ops(attemptId), []);
  });

  suite("a remote effect is judged like a local one: the policy asks for approval of a protected branch, and a pause stops it", async (c) => {
    const log: Log = { applied: 0, reconciled: 0 };
    c.bridges["git-push"] = bridge(log);
    await autonomous(c);
    const r1 = await c.host("r1");
    const { taskId, attempt } = await c.started(r1, "Push it", { tools: ["git-push"] });
    const protectedPush = await attempt.effect({ ...PUSH("m1", "main"), branchProtected: true }, { ...EFFECT, input: { branch: "main" } });
    assert.equal(protectedPush.state, "awaiting-approval", "a push to main waits for the owner");
    assert.equal(log.applied, 0);
    const read = await attempt.call({ callId: "r1", tool: { name: "read-file", version: "1.0.0" }, args: {} }, { kind: "local", run: async () => ({ text: "x" }) });
    assert.equal(read.state, "refused", "this agent holds no read-file grant");
    // A pause of the task: no new effect starts.
    await c.pauses.pause(c.owner, { commandId: "pz", scope: { kind: "task", id: taskId }, reason: "hold on" } as never);
    const paused = await attempt.effect(PUSH("p9"), EFFECT);
    assert.equal(paused.state, "refused");
    assert.match((paused as { reason: string }).reason, /paused/);
    assert.equal(log.applied, 0);
  });

  suite("a decision revision change refuses remote calls until the worker acknowledges it over the wire; the call is made again under a new call ID", async (c) => {
    const log: Log = { applied: 0, reconciled: 0 };
    c.bridges["git-push"] = bridge(log);
    await autonomous(c);
    const r1 = await c.host("r1");
    const { attemptId, attempt, placement } = await c.started(r1, "Push it", { tools: ["git-push"] });
    assert.equal((await attempt.effect(PUSH("p1"), EFFECT)).state, "confirmed");
    await c.decisions.record(c.owner, { commandId: "d1", projectId: c.project, category: "decision", topic: "db", statement: "use pg", wording: "We will use PostgreSQL here", source: { channel: "direct" }, basedOn: 0 } as never);
    const refused = await attempt.effect(PUSH("p2"), EFFECT);
    assert.equal(refused.state, "refused");
    assert.match((refused as { reason: string }).reason, /decision revision/);
    assert.equal(log.applied, 1, "a refused call applies nothing");
    // Before the acknowledgement the same call ID is still the refused call.
    assert.equal((await attempt.effect(PUSH("p2"), EFFECT)).state, "refused");
    await attempt.acknowledgeDecisions();
    // The refusal is on record under that call ID; the agent makes the call again under a new one.
    assert.equal((await attempt.effect(PUSH("p3"), EFFECT)).state, "confirmed");
    assert.equal(log.applied, 2);
    assert.deepEqual((await c.ops(attemptId)).map((o) => o.state).sort(), ["confirmed", "confirmed", "refused"]);
    // An acknowledgement from a stale placement is fenced and changes nothing.
    await wireRefuses("fenced", () => r1.client.send("POST", `/worker/attempts/${attemptId}/acknowledge`, { body: { placement: placement + 1 }, session: true }), 409);
  });

  suite("a link lost in the middle of an effect: the attempt is fenced, the effect is settled from the ledger and the target, and a late duplicate applies nothing", async (c) => {
    const log: Log = { applied: 0, reconciled: 0 };
    const started = deferred();
    const release = deferred();
    c.bridges["git-push"] = bridge(log, { started: started.resolve, release: release.promise });
    await autonomous(c);
    try {
      const r1 = await c.host("r1");
      const { attemptId, attempt } = await c.started(r1, "Push it", { tools: ["git-push"] });
      // The worker's request reaches the controller, the effect is applied, and the link goes (the answer never gets back).
      const inFlight = attempt.effect(PUSH("p1"), EFFECT).then((r) => `answered ${r.state}`, (e: unknown) => `failed ${String(e)}`);
      await Promise.race([started.promise, inFlight.then((x) => { throw new Error(`the effect call ended before the bridge ran: ${x}`); })]);
      assert.equal(log.applied, 1);
      assert.equal((await c.ops(attemptId))[0]!.state, "in-progress");
      // The controller process is replaced after the lease ran out: its dispatcher finds the lost attempt and settles the call from the target.
      c.clock.advance(6 * 60_000);
      const effects2 = EffectService.withEpoch(c.storage, c.epoch, c.assignments, { ...c.options, holder: "dispatcher-2" });
      const second = c.restart({ effects: effects2, workers: [r1.worker], storeOwner: (agentId, id) => c.remote.storeOwner(c.dispatcherPrincipal, agentId, id) }, { bridges: c.bridges });
      const report = await second.tick();
      assert.deepEqual(report.lost, [attemptId]);
      assert.equal((await c.ops(attemptId))[0]!.state, "confirmed", "settled from the target's own answer");
      assert.equal(log.applied, 1, "no duplicate effect");
      assert.ok(log.reconciled >= 1);
      assert.equal((await c.assignments.getAttempt(attemptId))!.state, "abandoned");
      // The worker, back on the link, sends its call again (and a new call): the attempt is no longer its own.
      await wireRefuses("fenced", () => attempt.effect(PUSH("p2"), EFFECT), 409);
      assert.equal(log.applied, 1);
      // The old process's own execution finishes late (a delayed message): it changes nothing, and the repeat of the first call is fenced too.
      release.resolve();
      assert.match(await inFlight, /^(answered|failed)/);
      await wireRefuses("fenced", () => attempt.effect(PUSH("p1"), EFFECT), 409);
      assert.equal(log.applied, 1);
      assert.equal((await c.ops(attemptId)).length, 1);
      assert.equal((await c.effects.get((await c.ops(attemptId))[0]!.effectId!))!.status, "confirmed");
    } finally { release.resolve(); } // a failed assertion must not leave the bridge hanging: the teardown waits for open requests
  });
}

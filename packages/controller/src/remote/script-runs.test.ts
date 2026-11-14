import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { HostService } from "../hosts/index.js";
import type { RemoteAttempt } from "./client.js";
import { WorkerRequestError } from "./client.js";
import { REMOTE_LIMITS, SCRIPT_PROTOCOL, type ControlMessage, type RunOutcomeWire, type SequencedControl } from "./protocol.js";
import { orderDigest, runIdOf, ScriptOrders, type ScriptOrderInput } from "./script-orders.js";
import { RemoteScriptRuns, orderProblem, type HostScriptLaunch, type HostScriptRunner } from "./script-runs.js";
import { RemoteWorkerService } from "./service.js";
import { refuses, remoteSuite, wireRefuses, type Ctx } from "./testing/suite.js";
import { rawRequest } from "./testing/world.js";
import { PROTOCOL_HEADER, SESSION_HEADER } from "./protocol.js";

after(stopServer);

// Card T02d (remote script execution): the run order, the host-side runner, the result and abort acknowledgement, fencing by placement and session, the `revoke` message and the limits, over the real worker transport and client with a
// loopback host (a fake script sandbox). What only a real second machine can show is listed in the notes.

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Waits (up to 15 s) until the condition holds. */
const until = async (cond: () => boolean | Promise<boolean>, what = "the condition"): Promise<void> => {
  for (let i = 0; i < 750; i++) { if (await cond()) return; await sleepMs(20); }
  assert.fail(`${what} never held`);
};

const input = (extra: Partial<ScriptOrderInput> = {}): ScriptOrderInput => ({
  program: "node", argv: ["bin/check.js"], stdin: '{"url":"https://example.org"}', source: "console.log('SOURCE-MARKER')", tool: { name: "a-ann.check", version: "1.0.0", digest: "d".repeat(64) },
  interpreterVersion: "22.19.0", maxOutputBytes: 4096, limits: { cpus: 1, memoryMb: 128, seconds: 30 }, ...extra,
});
const callOf = (attemptId: string, hostId: string, callId = "call-1") => ({ attemptId, callId, hostId });

/** The host's loop for one attempt: reads the control messages and hands the script kinds to the host runner. Ends when told. */
function serve(attempt: RemoteAttempt, attemptId: string, scripts: RemoteScriptRuns) {
  let stop = false;
  let after = 0;
  const seen: SequencedControl[] = [];
  const loop = (async () => {
    while (!stop) {
      const messages = await attempt.pollControl(after).catch(() => [] as SequencedControl[]);
      for (const m of messages) { after = Math.max(after, m.seq); seen.push(m); await scripts.handle(attempt, attemptId, m); }
      await sleepMs(10);
    }
  })();
  return { seen, end: async () => { stop = true; await loop; } };
}

/** A fake script sandbox: records each launch and answers as the test says. */
function sandbox() {
  const launches: HostScriptLaunch[] = [];
  const state = { behave: async (_l: HostScriptLaunch, _s: AbortSignal): Promise<{ text: string; cpuMs?: number }> => ({ text: '{"ok":true}', cpuMs: 7 }) };
  const runner: HostScriptRunner = { run: async (launch, signal) => { launches.push(launch); return state.behave(launch, signal); } };
  return { launches, state, runner };
}
/** A run that stays until aborted, then takes `stopMs` to end (a process that is slow to die). */
const holdsUntilAborted = (started: () => void, stopMs = 0) => (_l: HostScriptLaunch, signal: AbortSignal): Promise<{ text: string }> => new Promise((resolve, reject) => {
  started();
  signal.addEventListener("abort", () => { setTimeout(() => reject(new Error("killed")), stopMs); }, { once: true });
  void resolve;
});

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("T02d: a script is ordered of the host that holds the attempt, fetched, run in the host's sandbox with an empty environment, and its output comes back; the placement keeps only the run ID and digest", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt, placement } = await c.started(r1, "Order seeds");
    const box = sandbox();
    const host = serve(attempt, attemptId, new RemoteScriptRuns({ runner: box.runner, retryMs: 5 }));
    try {
      const out = await c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input(), new AbortController().signal);
      assert.deepEqual(out, { text: '{"ok":true}', cpuMs: 7 });
      assert.equal(box.launches.length, 1);
      const launch = box.launches[0]!;
      assert.deepEqual([launch.program, launch.argv, launch.stdin, launch.env], ["node", ["bin/check.js"], '{"url":"https://example.org"}', {}]);
      assert.match(launch.source, /SOURCE-MARKER/);
      // The wire message names the run and the digest of the order, never the source or the arguments.
      const stored = await c.remote.placement(c.dispatcherPrincipal, attemptId);
      const runMessages = stored!.control.filter((m) => m.kind === "run");
      assert.equal(runMessages.length, 1);
      assert.deepEqual(Object.keys(runMessages[0]!).sort(), ["digest", "kind", "runId", "seq"]);
      assert.equal((runMessages[0] as { runId: string }).runId, runIdOf(attemptId, "call-1", placement));
      const everything = JSON.stringify([stored, await c.ops(attemptId)]);
      for (const marker of ["SOURCE-MARKER", "example.org", '"ok":true']) assert.equal(everything.includes(marker), false, `${marker} is not in a record`);
      // The run is over on both sides.
      assert.deepEqual(c.remote.scriptRuns(c.dispatcherPrincipal, attemptId), []);
    } finally { await host.end(); }
  });

  suite("T02d: a host that fails, a script that wrote too much and a host with no sandbox are answered as failures with a redacted, bounded reason; nothing waits out the run's time", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1, "Order seeds");
    const box = sandbox();
    const host = serve(attempt, attemptId, new RemoteScriptRuns({ runner: box.runner, retryMs: 5 }));
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    try {
      box.state.behave = async () => { throw new Error(`boom ${secret} ${"x".repeat(2000)}`); };
      await assert.rejects(c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id, "c-fail"), input(), new AbortController().signal), (e: unknown) => {
        const m = (e as Error).message;
        assert.match(m, /^boom /); assert.equal(m.includes(secret), false); assert.ok(m.length <= REMOTE_LIMITS.scriptErrorChars);
        return true;
      });
      box.state.behave = async () => ({ text: "y".repeat(5000) });
      await assert.rejects(c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id, "c-big"), input({ maxOutputBytes: 4096 }), new AbortController().signal), /more than 4096 bytes/);
      assert.deepEqual(c.remote.scriptRuns(c.dispatcherPrincipal, attemptId), []);
    } finally { await host.end(); }
    // A host whose runner is absent says so for every order.
    const r2 = await c.host("r2");
    const second = await c.started(r2, "Order beans", { agent: "bob" });
    const bare = serve(second.attempt, second.attemptId, new RemoteScriptRuns({ retryMs: 5 }));
    try { await assert.rejects(c.remote.runScript(c.dispatcherPrincipal, callOf(second.attemptId, r2.id), input(), new AbortController().signal), /no script sandbox/); } finally { await bare.end(); }
  });

  suite("T02d: the call's own abort stops the run on the host, the call ends at once, and the run stays open until the host acknowledges that its process is gone", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1, "Order seeds");
    const box = sandbox();
    let started!: () => void; const hasStarted = new Promise<void>((r) => { started = r; });
    // The process takes a while to die: the acknowledgement is not sent before it has.
    let gone = false;
    box.state.behave = async (l, s) => { try { return await holdsUntilAborted(started, 150)(l, s); } finally { gone = true; } };
    const host = serve(attempt, attemptId, new RemoteScriptRuns({ runner: box.runner, retryMs: 5 }));
    try {
      const ctl = new AbortController();
      const call = c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input(), ctl.signal);
      const settled = call.then(() => "ran", (e: Error) => e.message);
      await hasStarted;
      assert.equal(c.remote.scriptRuns(c.dispatcherPrincipal, attemptId).length, 1);
      ctl.abort(new Error("the call was stopped"));
      assert.equal(await settled, "the call was stopped", "the call ends at once, with its own reason");
      assert.equal(gone, false, "the call ended before the process was gone");
      assert.equal(c.remote.scriptRuns(c.dispatcherPrincipal, attemptId)[0]?.state, "aborting", "the run is open, being stopped, until the host acknowledges");
      await until(() => c.remote.scriptRuns(c.dispatcherPrincipal, attemptId).length === 0, "the acknowledgement");
      assert.equal(gone, true, "acknowledged only after the process ended");
      assert.ok(host.seen.some((m) => m.kind === "abort"));
    } finally { await host.end(); }
  });

  for (const choice of ["finish", "cancel", "pause"] as const) {
    suite(`T02d: a revoke message carries the owner's choice (${choice}) to the host: ${choice === "finish" ? "a running call ends on its own" : "the running call is stopped and the run acknowledged"}`, async (c) => {
      const r1 = await c.host("r1");
      const { attemptId, attempt } = await c.started(r1, "Order seeds");
      const box = sandbox();
      let started!: () => void; const hasStarted = new Promise<void>((r) => { started = r; });
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      box.state.behave = async (_l, signal) => { started(); await new Promise<void>((resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("killed")), { once: true }); void gate.then(resolve); }); return { text: '{"ok":true}' }; };
      const host = serve(attempt, attemptId, new RemoteScriptRuns({ runner: box.runner, retryMs: 5 }));
      try {
        let tell!: (c: "finish" | "cancel" | "pause") => void;
        const ctl = new AbortController();
        const call = c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input(), ctl.signal, (t) => { tell = t; });
        const settled = call.then((r) => r.text, (e: Error) => `failed: ${e.message}`);
        await hasStarted;
        tell(choice);
        if (choice === "finish") {
          await until(() => host.seen.some((m) => m.kind === "revoke"), "the revoke message");
          await sleepMs(100);
          assert.equal(c.remote.scriptRuns(c.dispatcherPrincipal, attemptId).length, 1, "a finishing call is left alone");
          release();
          assert.equal(await settled, '{"ok":true}');
        } else {
          // The tool service aborts the call's own signal right after telling; the abort is not sent as a second message.
          ctl.abort(new Error("was revoked while it ran"));
          assert.match(await settled, /failed: was revoked while it ran/);
          await until(() => c.remote.scriptRuns(c.dispatcherPrincipal, attemptId).length === 0, "the acknowledgement");
          assert.equal(host.seen.filter((m) => m.kind === "abort").length, 0, "a revocation already stopped it");
        }
        const revoke = host.seen.find((m) => m.kind === "revoke") as (ControlMessage & { kind: "revoke" }) | undefined;
        assert.deepEqual([revoke?.name, revoke?.version, revoke?.choice], ["a-ann.check", "1.0.0", choice]);
      } finally { release(); await host.end(); }
    });
  }

  suite("T02d: a revocation that reaches the host before the order does stops the order from starting; a later order of another version is not affected", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1, "Order seeds");
    const box = sandbox();
    const scripts = new RemoteScriptRuns({ runner: box.runner, retryMs: 5 });
    const reported: RunOutcomeWire[] = [];
    const spy = { fetchRun: attempt.fetchRun.bind(attempt), finishRun: async (id: string, o: RunOutcomeWire) => { reported.push(o); return attempt.finishRun(id, o); } };
    // The host hears the revocation first (the messages are handed to it by hand here, in the order it happened).
    await scripts.handle(spy as never, attemptId, { kind: "revoke", name: "a-ann.check", version: "1.0.0", choice: "cancel" });
    const call = c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input(), new AbortController().signal);
    const settled = call.then(() => "ran", (e: Error) => e.message);
    let after = 0;
    await until(async () => { const ms = await attempt.pollControl(after); for (const m of ms) { after = m.seq; await scripts.handle(spy as never, attemptId, m); } return reported.length > 0; }, "the host's report");
    assert.deepEqual(reported[0], { state: "aborted", choice: "cancel" });
    assert.match(await settled, /stopped the run/);
    assert.equal(box.launches.length, 0, "nothing was started");
    // The other version runs.
    const other = c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id, "call-2"), input({ tool: { name: "a-ann.check", version: "2.0.0", digest: "e".repeat(64) } }), new AbortController().signal);
    await until(async () => { const ms = await attempt.pollControl(after); for (const m of ms) { after = m.seq; await scripts.handle(spy as never, attemptId, m); } return box.launches.length > 0; }, "the second run");
    assert.equal((await other).text, '{"ok":true}');
  });

  suite("T02d: fencing: another host, a stale placement, a stale session and a session at protocol 1 cannot fetch or settle a run; a report for a run that is not open is not kept", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const { attemptId, placement, attempt, order: workOrder } = await c.started(r1, "Order seeds");
    const ctl = new AbortController();
    const call = c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input(), ctl.signal);
    call.catch(() => undefined);
    const runId = runIdOf(attemptId, "call-1", placement);
    // Another host's name on the attempt: not found, and a security signal.
    await wireRefuses("not_found", () => r2.client.attempt(attemptId, placement).fetchRun(runId), 404);
    assert.ok(c.security.detected.some((d) => d.event.kind === "credential-misused"));
    await wireRefuses("not_found", () => r2.client.attempt(attemptId, placement).finishRun(runId, { state: "failed", error: "mine now" }), 404);
    // A stale placement number.
    await wireRefuses("fenced", () => r1.client.attempt(attemptId, placement + 1).fetchRun(runId), 409);
    await wireRefuses("fenced", () => r1.client.attempt(attemptId, placement + 1).finishRun(runId, { state: "failed", error: "late" }), 409);
    // A run ID the controller never made, a malformed one, an unknown field, a bad outcome.
    await wireRefuses("not_found", () => attempt.fetchRun(runIdOf(attemptId, "nobody", placement)), 404);
    await wireRefuses("invalid_command", () => attempt.fetchRun("run-nope"), 400);
    assert.deepEqual(await attempt.finishRun(runIdOf(attemptId, "nobody", placement), { state: "failed", error: "x" }), { kept: false });
    const post = (action: string, body: unknown, key = "k") => r1.client.send("POST", `/worker/attempts/${attemptId}/${action}`, { body: body as never, session: true, key });
    await wireRefuses("invalid_command", () => post("run-fetch", { placement, runId, extra: 1 }), 400);
    await wireRefuses("invalid_command", () => post("run-done", { placement, runId, outcome: { state: "done", text: 5 } }), 400);
    await wireRefuses("invalid_command", () => post("run-done", { placement, runId, outcome: { state: "done", text: "x", extra: 1 } }), 400);
    await wireRefuses("invalid_command", () => post("run-done", { placement, runId, outcome: { state: "failed", error: "" } }), 400);
    await wireRefuses("invalid_command", () => post("run-done", { placement, runId, outcome: { state: "odd" } }), 400);
    await wireRefuses("invalid_command", () => post("run-done", { placement, runId, outcome: { state: "done", text: "x", cpuMs: -1 } }), 400);
    await wireRefuses("too_large", () => post("run-done", { placement, runId, outcome: { state: "done", text: "x".repeat(REMOTE_LIMITS.scriptBytes + 10) } }), 413);
    // run-done changes the run: it needs an idempotency key, and the session's own protocol.
    const session = r1.client.session!;
    const noKey = await rawRequest(c.transport.url, "POST", `/worker/attempts/${attemptId}/run-done`, { token: r1.token, body: { placement, runId, outcome: { state: "failed", error: "x" } }, headers: { [SESSION_HEADER]: session.sessionId, [PROTOCOL_HEADER]: String(session.protocol) } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error.code, "idempotency_key_required");
    assert.equal(c.remote.scriptRuns(c.dispatcherPrincipal, attemptId).length, 1, "none of that changed the run");
    // The rightful host fetches the order: it matches the digest the controller announced, and carries no credential and an empty environment.
    const order = await attempt.fetchRun(runId);
    const announced = (await c.remote.placement(c.dispatcherPrincipal, attemptId))!.control.find((m) => m.kind === "run");
    assert.equal(announced?.kind === "run" ? orderProblem(order, runId, announced.digest) : "no run message", undefined, "the fetched order matches the digest in the control message");
    assert.deepEqual(order.env, {});
    assert.ok(typeof workOrder.credential === "string" && workOrder.credential.length > 0);
    assert.equal(JSON.stringify(order).includes(workOrder.credential), false, "no task credential in the order");
    // The wrong order is not taken by the host: a tampered one fails the digest, a wrong run ID fails, an oversized source fails.
    assert.match(orderProblem({ ...order, stdin: "{}" }, runId, orderDigest(order)) ?? "", /digest/);
    assert.match(orderProblem(order, "run-" + "0".repeat(24), orderDigest(order)) ?? "", /another run/);
    assert.match(orderProblem({ ...order, program: "sh -c x" }, runId, orderDigest({ ...order, program: "sh -c x" })) ?? "", /plain program name/);
    assert.match(orderProblem({ ...order, source: "x".repeat(REMOTE_LIMITS.scriptSourceBytes + 1) }, runId, orderDigest({ ...order, source: "x".repeat(REMOTE_LIMITS.scriptSourceBytes + 1) })) ?? "", /too large/);
    assert.match(orderProblem({ ...order, maxOutputBytes: REMOTE_LIMITS.scriptOutputBytes + 1 }, runId, orderDigest({ ...order, maxOutputBytes: REMOTE_LIMITS.scriptOutputBytes + 1 })) ?? "", /output limit/);
    // The host that settles the run settles it once; a second report is not kept.
    assert.deepEqual(await attempt.finishRun(runId, { state: "done", text: '{"ok":true}' }), { kept: true });
    assert.equal((await call).text, '{"ok":true}');
    assert.deepEqual(await attempt.finishRun(runId, { state: "done", text: '{"ok":false}' }), { kept: false });
  });

  suite("T02d: the placement ending, moving or being replaced ends the runs of it; a report from the old holder is fenced and settles nothing", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, placement, attempt } = await c.started(r1, "Order seeds");
    const call = c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input(), new AbortController().signal);
    const settled = call.then(() => "ran", (e: Error) => e.message);
    const runId = runIdOf(attemptId, "call-1", placement);
    await until(() => c.remote.scriptRuns(c.dispatcherPrincipal, attemptId).length === 1);
    await c.remote.end(c.dispatcherPrincipal, attemptId, "the dispatcher stopped the worker", placement);
    assert.match(await settled, /the host's run was ended/);
    assert.deepEqual(c.remote.scriptRuns(c.dispatcherPrincipal, attemptId), []);
    await wireRefuses("fenced", () => attempt.finishRun(runId, { state: "done", text: "late" }), 409);
    await wireRefuses("fenced", () => attempt.fetchRun(runId), 409);
    // Nothing is ordered of a placement that is not accepted.
    await refuses("unavailable", () => c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id, "c2"), input(), new AbortController().signal));
  });

  suite("T02d: only the owner and the dispatcher order a run; a host that does not hold the attempt, one not connected in the session that accepted it, one at protocol 1 and an unconfirmed contract are refused before anything is sent", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const { attemptId, attempt } = await c.started(r1, "Order seeds");
    const fresh = await c.started(r2, "Order beans", { agent: "bob", unconfirmed: true });
    // Not a staff principal: the host itself.
    await refuses("forbidden", () => c.remote.runScript(r1.principal, callOf(attemptId, r1.id), input(), new AbortController().signal));
    // Another host's name.
    await refuses("unavailable", () => c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r2.id), input(), new AbortController().signal), (e) => assert.match(e.message, /is not held by host/));
    // The dispatch contract is not confirmed.
    await refuses("invalid_transition", () => c.remote.runScript(c.dispatcherPrincipal, callOf(fresh.attemptId, r2.id), input(), new AbortController().signal), (e) => assert.match(e.message, /confirm/));
    // An aborted signal orders nothing.
    const gone = new AbortController(); gone.abort(new Error("already over"));
    await assert.rejects(c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input(), gone.signal), /already over/);
    assert.deepEqual((await c.remote.placement(c.dispatcherPrincipal, attemptId))!.control.filter((m) => m.kind === "run"), [], "nothing was sent");
    void attempt;
  });

  suite("T02d: a controller that took the store over orders nothing of a host whose session was opened with the earlier primary (the host connects again first)", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId } = await c.started(r1, "Order seeds");
    const { epoch } = await c.storage.acquireEpoch({ holder: "controller-2", at: c.clock.now() });
    const hosts = HostService.withEpoch(c.storage, epoch, c.assignments, c.options);
    const second = RemoteWorkerService.withEpoch(c.storage, epoch, { principal: c.dispatcherPrincipal, hosts, artifacts: c.artifacts, dispatch: c.current as never }, c.options);
    try {
      await refuses("unavailable", () => second.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input(), new AbortController().signal), (e) => assert.match(e.message, /not connected to this controller in the session that holds the attempt/));
      assert.deepEqual((await second.placement(c.dispatcherPrincipal, attemptId))!.control.filter((m) => m.kind === "run"), [], "nothing was sent");
      assert.deepEqual(second.scriptRuns(c.dispatcherPrincipal, attemptId), []);
    } finally { second.close(); }
  });

  suite("T02d: a host whose session negotiated protocol 1 is never ordered a script, and the routes refuse it", async (c) => {
    const r1 = await c.host("r1", { protocol: { min: 1, max: 1 } });
    assert.equal(r1.client.session!.protocol, 1);
    const { attemptId, placement, attempt } = await c.started(r1, "Order seeds");
    await refuses("unavailable", () => c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input(), new AbortController().signal), (e) => assert.match(e.message, /speaks worker protocol 1.*needs protocol 2/));
    assert.deepEqual((await c.remote.placement(c.dispatcherPrincipal, attemptId))!.control.filter((m) => m.kind === "run"), []);
    await wireRefuses("invalid_command", () => attempt.fetchRun(runIdOf(attemptId, "c", placement)), 400);
    await wireRefuses("invalid_command", () => attempt.finishRun(runIdOf(attemptId, "c", placement), { state: "failed", error: "x" }), 400);
    assert.equal(SCRIPT_PROTOCOL, 2);
  });

  suite("T02d: the limits: an executable or arguments over what the protocol carries are refused before sending; more runs than an attempt may have at once are refused; the same call asked again joins the same run", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1, "Order seeds");
    const sig = () => new AbortController().signal;
    await refuses("invalid_command", () => c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input({ source: "x".repeat(REMOTE_LIMITS.scriptSourceBytes + 1) }), sig()), (e) => assert.match(e.message, /executable is larger/));
    await refuses("invalid_command", () => c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input({ stdin: "x".repeat(REMOTE_LIMITS.scriptStdinBytes + 1) }), sig()), (e) => assert.match(e.message, /arguments are larger/));
    await refuses("invalid_command", () => c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input({ maxOutputBytes: REMOTE_LIMITS.scriptOutputBytes + 1 }), sig()), (e) => assert.match(e.message, /output limit/));
    assert.deepEqual((await c.remote.placement(c.dispatcherPrincipal, attemptId))!.control.filter((m) => m.kind === "run"), [], "nothing was sent");
    const ctls = Array.from({ length: REMOTE_LIMITS.scriptRuns }, () => new AbortController());
    const calls = ctls.map((ctl, i) => c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id, `call-${i}`), input(), ctl.signal));
    for (const p of calls) p.catch(() => undefined);
    await until(() => c.remote.scriptRuns(c.dispatcherPrincipal, attemptId).length === REMOTE_LIMITS.scriptRuns);
    await refuses("unavailable", () => c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id, "one-more"), input(), sig()), (e) => assert.match(e.message, /already has 4 scripts/));
    // The same call asked again is the same run: no second order.
    const again = c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id, "call-0"), input(), sig());
    again.catch(() => undefined);
    // The orders are committed to the placement one by one (a slower store takes longer): wait until all four are there, and a moment more to see that no fifth comes.
    await until(async () => (await c.remote.placement(c.dispatcherPrincipal, attemptId))!.control.filter((m) => m.kind === "run").length === REMOTE_LIMITS.scriptRuns, "the four orders");
    await sleepMs(100);
    const orders = (await c.remote.placement(c.dispatcherPrincipal, attemptId))!.control.filter((m) => m.kind === "run");
    assert.equal(orders.length, REMOTE_LIMITS.scriptRuns);
    assert.equal(new Set(orders.map((m) => (m as { runId: string }).runId)).size, REMOTE_LIMITS.scriptRuns);
    // The host settles one; the joiner and the first caller both get its answer.
    const runId = runIdOf(attemptId, "call-0", (await c.remote.placement(c.dispatcherPrincipal, attemptId))!.placement);
    await attempt.finishRun(runId, { state: "done", text: '{"n":1}' });
    assert.equal((await calls[0]!).text, '{"n":1}');
    assert.equal((await again).text, '{"n":1}');
    for (const ctl of ctls) ctl.abort(new Error("test over"));
  }, { });

  suite("T02d: a run the host never reports is failed when its own time plus the grace is up, and the call hears it", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId } = await c.started(r1, "Order seeds");
    const started = Date.now();
    await assert.rejects(c.remote.runScript(c.dispatcherPrincipal, callOf(attemptId, r1.id), input({ limits: { cpus: 1, memoryMb: 128, seconds: 1 } }), new AbortController().signal), /did not report the run in time/);
    assert.ok(Date.now() - started >= 900, "not before the script's own time");
    await until(async () => (await c.remote.placement(c.dispatcherPrincipal, attemptId))!.control.some((m) => m.kind === "abort"), "the abort message (the host is told to stop it)");
    assert.deepEqual(c.remote.scriptRuns(c.dispatcherPrincipal, attemptId), []);
  }, { scriptGraceMs: 0 });

  suite("T02d: the run message's shape is checked: a bad run ID or digest, an unknown field and a bad revoke choice are refused by the control queue", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, placement } = await c.started(r1, "Order seeds");
    const by = c.dispatcherPrincipal;
    await refuses("invalid_command", () => c.remote.control(by, attemptId, { kind: "run", runId: "run-x", digest: "a".repeat(64) }, placement));
    await refuses("invalid_command", () => c.remote.control(by, attemptId, { kind: "run", runId: runIdOf(attemptId, "c", 1), digest: "zz" }, placement));
    await refuses("invalid_command", () => c.remote.control(by, attemptId, { kind: "run", runId: runIdOf(attemptId, "c", 1), digest: "a".repeat(64), extra: 1 } as never, placement));
    await refuses("invalid_command", () => c.remote.control(by, attemptId, { kind: "abort", runId: "nope" }, placement));
    await refuses("invalid_command", () => c.remote.control(by, attemptId, { kind: "revoke", name: "a-ann.check", version: "1.0.0", choice: "ignore" } as never, placement));
    await refuses("invalid_command", () => c.remote.control(by, attemptId, { kind: "revoke", name: "", version: "1.0.0", choice: "cancel" }, placement));
    await refuses("fenced", () => c.remote.control(by, attemptId, { kind: "revoke", name: "a-ann.check", version: "1.0.0", choice: "cancel" }, placement + 1));
    await c.remote.control(by, attemptId, { kind: "stop", emergency: false }, placement);
    await c.remote.control(by, attemptId, { kind: "revoke", name: "a-ann.check", version: "1.0.0", choice: "cancel" }, placement);
    assert.equal((await c.remote.placement(by, attemptId))!.control.filter((m) => m.kind === "revoke").length, 1);
    // A revocation tells every running call of the version: those messages replace one another in the bounded queue, so many calls of one version cannot push the owner's stop out. Another version's is its own message.
    for (let i = 0; i < REMOTE_LIMITS.control + 5; i++) await c.remote.control(by, attemptId, { kind: "revoke", name: "a-ann.check", version: "1.0.0", choice: "cancel" }, placement);
    await c.remote.control(by, attemptId, { kind: "revoke", name: "a-ann.check", version: "2.0.0", choice: "cancel" }, placement);
    const queue = (await c.remote.placement(by, attemptId))!.control;
    assert.deepEqual(queue.map((m) => m.kind === "revoke" ? `revoke ${m.version}` : m.kind), ["stop", "revoke 1.0.0", "revoke 2.0.0"]);
  });
}

// ---- the host's runner and the controller's order book, alone ----------------------------------------------------------------

test("T02d: a repeated run message is run once; one that already ended is reported again, so a controller that lost the first report is answered", async () => {
  const reports: [string, RunOutcomeWire][] = [];
  let runs = 0;
  const order = { runId: runIdOf("att-a", "c", 1), program: "node", argv: ["x.js"], stdin: "{}", source: "1", tool: { name: "a-b.c", version: "1.0.0", digest: "d" }, interpreterVersion: "22", maxOutputBytes: 100, limits: { cpus: 1, memoryMb: 16, seconds: 5 }, env: { LEAK: "1" } };
  const attempt = { fetchRun: async () => order, finishRun: async (id: string, o: RunOutcomeWire) => { reports.push([id, o]); return { kept: true }; } };
  let launched: HostScriptLaunch | undefined;
  const scripts = new RemoteScriptRuns({ runner: { run: async (l) => { runs++; launched = l; return { text: "ok" }; } }, retryMs: 1 });
  const msg: ControlMessage = { kind: "run", runId: order.runId, digest: orderDigest(order) };
  await scripts.handle(attempt as never, "att-a", msg);
  await scripts.handle(attempt as never, "att-a", msg);
  await until(() => reports.length >= 1);
  assert.equal(runs, 1);
  assert.deepEqual(launched!.env, {}, "the environment is empty whatever the order says");
  await scripts.handle(attempt as never, "att-a", msg);
  assert.equal(reports.length, 2, "an ended run is reported again");
  assert.deepEqual(reports[1], reports[0]);
  await scripts.endAttempt("att-a");
  assert.deepEqual(scripts.running("att-a"), []);
});

test("T02d: a host reports an order that does not match its digest as failed and runs nothing; a fetch that fails is reported; a fenced host reports nothing", async () => {
  const order = { runId: runIdOf("att-a", "c", 1), program: "node", argv: ["x.js"], stdin: "{}", source: "1", tool: { name: "a-b.c", version: "1.0.0", digest: "d" }, interpreterVersion: "22", maxOutputBytes: 100, limits: { cpus: 1, memoryMb: 16, seconds: 5 }, env: {} };
  const reports: RunOutcomeWire[] = [];
  let ran = 0;
  const runner = { run: async () => { ran++; return { text: "x" }; } };
  const make = (fetchRun: () => Promise<unknown>) => ({ fetchRun, finishRun: async (_i: string, o: RunOutcomeWire) => { reports.push(o); return { kept: true }; } });
  const scripts = new RemoteScriptRuns({ runner, retryMs: 1 });
  await scripts.handle(make(async () => ({ ...order, stdin: "{\"evil\":1}" })) as never, "att-a", { kind: "run", runId: order.runId, digest: orderDigest(order) });
  await until(() => reports.length === 1);
  assert.equal(reports[0]!.state, "failed");
  assert.match((reports[0] as { error: string }).error, /digest/);
  const other = { ...order, runId: runIdOf("att-a", "c2", 1) };
  await scripts.handle(make(async () => { throw new Error("connection reset"); }) as never, "att-a", { kind: "run", runId: other.runId, digest: orderDigest(other) });
  await until(() => reports.length === 2);
  assert.match((reports[1] as { error: string }).error, /could not be fetched/);
  const third = { ...order, runId: runIdOf("att-a", "c3", 1) };
  await scripts.handle(make(async () => { throw new WorkerRequestError(409, "fenced", "no longer current"); }) as never, "att-a", { kind: "run", runId: third.runId, digest: orderDigest(third) });
  await sleepMs(50);
  assert.equal(reports.length, 2, "a fenced host reports nothing");
  assert.equal(ran, 0);
  // A message that is not one of the script kinds is ignored.
  await scripts.handle(make(async () => order) as never, "att-a", { kind: "stop", emergency: false });
  assert.deepEqual(scripts.running("att-a"), []);
});

test("T02d: an outcome the controller cannot deliver is tried three times and then dropped; a refusal of the report is not retried", async () => {
  const order = { runId: runIdOf("att-a", "c", 1), program: "node", argv: ["x.js"], stdin: "{}", source: "1", tool: { name: "a-b.c", version: "1.0.0", digest: "d" }, interpreterVersion: "22", maxOutputBytes: 100, limits: { cpus: 1, memoryMb: 16, seconds: 5 }, env: {} };
  let tries = 0;
  const troubles: string[] = [];
  const scripts = new RemoteScriptRuns({ runner: { run: async () => ({ text: "x" }) }, retryMs: 1, onTrouble: (_a, what) => { troubles.push(what); } });
  const attempt = { fetchRun: async () => order, finishRun: async () => { tries++; throw new WorkerRequestError(503, "unavailable", "busy"); } };
  await scripts.handle(attempt as never, "att-a", { kind: "run", runId: order.runId, digest: orderDigest(order) });
  await until(() => troubles.length === 1);
  assert.equal(tries, 3);
  const o2 = { ...order, runId: runIdOf("att-a", "c2", 1) };
  let t2 = 0;
  await scripts.handle({ fetchRun: async () => o2, finishRun: async () => { t2++; throw new WorkerRequestError(400, "invalid_command", "outcome: bad"); } } as never, "att-a", { kind: "run", runId: o2.runId, digest: orderDigest(o2) });
  await until(() => troubles.length === 2);
  assert.equal(t2, 1);
});

test("T02d: the order book: the run ID follows the placement, a send that fails drops the run, close ends every wait", async () => {
  const sent: ControlMessage[] = [];
  let failSend = false;
  const book = new ScriptOrders({ send: async (_a, _p, m) => { if (failSend) throw new Error("fenced"); sent.push(m); } });
  const call = { attemptId: "att-a", callId: "c", placement: 1, sessionId: "ses-1" };
  assert.notEqual(runIdOf("att-a", "c", 1), runIdOf("att-a", "c", 2));
  assert.notEqual(runIdOf("att-a", "c", 1), runIdOf("att-a", "d", 1));
  failSend = true;
  await assert.rejects(book.run(call, input(), new AbortController().signal), /could not be sent/);
  assert.deepEqual(book.open("att-a"), [], "a run whose order could not be sent is not left open");
  failSend = false;
  const waiting = book.run(call, input(), new AbortController().signal).then(() => "ran", (e: Error) => e.message);
  await until(() => book.open("att-a").length === 1);
  // A report from another placement or session is not this run's.
  const runId = runIdOf("att-a", "c", 1);
  assert.deepEqual(book.done("att-a", 2, "ses-1", runId, { state: "done", text: "x" }), { kept: false });
  assert.deepEqual(book.done("att-a", 1, "ses-2", runId, { state: "done", text: "x" }), { kept: false });
  assert.throws(() => book.fetch("att-a", 2, "ses-1", runId), /no such run/);
  book.close();
  // A call that joined a run another caller stopped is never answered with an empty or late result: the run ends as stopped for it too, whatever the host reports.
  const book2 = new ScriptOrders({ send: async (_a, _p, m) => { sent.push(m); } });
  const first = new AbortController();
  const a = book2.run(call, input(), first.signal).then(() => "ran", (e: Error) => e.message);
  await until(() => book2.open("att-a").length === 1);
  const b = book2.run(call, input(), new AbortController().signal).then((r) => `ran: ${JSON.stringify(r)}`, (e: Error) => e.message);
  first.abort(new Error("first caller stopped"));
  assert.equal(await a, "first caller stopped");
  assert.equal(book2.open("att-a")[0]?.state, "aborting");
  assert.ok(sent.some((m) => m.kind === "abort"), "the host was told to stop it");
  // The host's script had finished before the stop reached it: its output is not given to the joiner.
  assert.deepEqual(book2.done("att-a", 1, "ses-1", runId, { state: "done", text: '{"late":true}' }), { kept: true });
  assert.equal(await b, "the run was stopped before it ended");
  assert.deepEqual(book2.open("att-a"), []);
  assert.match(await waiting, /closing/);
  assert.deepEqual(book.open("att-a"), []);
  await assert.rejects(book.run(call, input(), new AbortController().signal), /closing/);
  void sent;
});

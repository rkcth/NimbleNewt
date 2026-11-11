import assert from "node:assert/strict";
import { after } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { RemoteWorkerHost } from "./host.js";
import { PROTOCOL_HEADER, REMOTE_LIMITS, SESSION_HEADER } from "./protocol.js";
import { RemoteOfferRunner } from "./runner.js";
import { remoteSuite, wireRefuses, FULL_ABILITIES } from "./testing/suite.js";
import { RemoteWorkerClient, WorkerRequestError } from "./client.js";
import { REMOTE_CAPS } from "./testing/world.js";
import { test } from "node:test";
import { rawRequest } from "./testing/world.js";
import type { WorkOrder, WorkerHandle } from "../dispatch/ports.js";

after(stopServer);

// Card L02e: a remote worker reports the processes it started for an attempt, and that it cleaned them up; Stop reads that report instead of one unknown item. The same fences as every message about the attempt:
// the host's session, the host and number of the placement, the worker session that accepted it, a body of bounded size, exact fields and a sequence that only rises.

const P = (ref: string, state: "running" | "uncooperative" | "unknown" = "running", kind: "process" | "child" = "process") => ({ ref, kind, state });

for (const backend of backends) {
  const suite = remoteSuite(backend);
  const hostOf = (c: { remote: ConstructorParameters<typeof RemoteWorkerHost>[1]; dispatcherPrincipal: ConstructorParameters<typeof RemoteWorkerHost>[2] }, id: string) => new RemoteWorkerHost(id, c.remote, c.dispatcherPrincipal, { resources: { cpus: 1, memoryMb: 1 }, requirements: () => ({}) as never });

  suite("Stop reads the worker's own report: no report is one unknown item, a report lists what the worker holds, an empty one lists nothing, and a final one is the worker's word that it is clean (card L02e)", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1);
    const host = hostOf(c, r1.id);
    assert.deepEqual((await host.localWork([attemptId])).processes, [{ attemptId, ref: `remote:${attemptId}`, kind: "process", state: "unknown" }], "no report yet: as before");
    assert.deepEqual(await attempt.reportProcesses({ seq: 1, final: false, processes: [P("node server.js"), P("child:task-x", "uncooperative", "child")] }), { kept: true });
    assert.deepEqual((await host.localWork([attemptId])).processes, [
      { attemptId, ref: "node server.js", kind: "process", state: "running" },
      { attemptId, ref: "child:task-x", kind: "child", state: "uncooperative" },
    ]);
    // The same report again is the same answer, and an older one is ignored.
    assert.deepEqual(await attempt.reportProcesses({ seq: 1, final: false, processes: [P("node server.js"), P("child:task-x", "uncooperative", "child")] }), { kept: true });
    assert.deepEqual(await attempt.reportProcesses({ seq: 2, final: false, processes: [] }), { kept: true });
    assert.deepEqual(await attempt.reportProcesses({ seq: 1, final: false, processes: [P("old")] }), { kept: false }, "an older report changes nothing");
    assert.deepEqual((await host.localWork([attemptId])).processes, [], "a live placement that reports nothing held holds nothing");
    // Another report under a sequence already used is a conflict, not a silent change.
    await wireRefuses("payload_changed", () => attempt.reportProcesses({ seq: 2, final: false, processes: [P("other")] }), 409);
    // The worker stops the sandbox, the attempt completes, and its last word says what is left.
    await attempt.reportProcesses({ seq: 3, final: false, processes: [P("sleep 1000")] });
    await attempt.complete({ status: "completed", text: "done", endKind: "normal" });
    await host.release(attemptId, "the attempt ended");
    assert.equal((await c.remote.placement(c.dispatcherPrincipal, attemptId))!.state, "completed");
    assert.deepEqual((await host.localWork([attemptId])).processes, [{ attemptId, ref: "sleep 1000", kind: "process", state: "unknown" }], "over, and the worker never said the process was gone: unknown, not clean");
    assert.deepEqual(await attempt.reportProcesses({ seq: 4, final: true, processes: [] }), { kept: true }, "a worker's last word is taken after the end");
    assert.deepEqual((await host.localWork([attemptId])).processes, [], "its final report says nothing is left");
    // Nothing follows a final report.
    assert.deepEqual(await attempt.reportProcesses({ seq: 5, final: false, processes: [P("again")] }), { kept: false });
    assert.deepEqual((await host.localWork([attemptId])).processes, []);
    // A final report that lists something shows it, as the worker gave it.
    const r2 = await c.host("r2");
    const second = await c.started(r2, "Order beans", { agent: "bob" });
    await second.attempt.reportProcesses({ seq: 1, final: true, processes: [P("stuck", "uncooperative")] });
    await second.attempt.complete({ status: "completed", text: "done", endKind: "normal" });
    await hostOf(c, r2.id).release(second.attemptId, "ended");
    assert.deepEqual((await hostOf(c, r2.id).localWork([second.attemptId])).processes, [{ attemptId: second.attemptId, ref: "stuck", kind: "process", state: "uncooperative" }]);
    // An attempt that never reported and is over contributes nothing, as before; one the host does not hold is not listed.
    const r3 = await c.host("r3");
    const quiet = await c.started(r3, "Order peas", { agent: "cy" });
    await quiet.attempt.complete({ status: "completed", text: "done", endKind: "normal" });
    await hostOf(c, r3.id).release(quiet.attemptId, "ended");
    assert.deepEqual((await hostOf(c, r3.id).localWork([quiet.attemptId])).processes, []);
    assert.deepEqual((await hostOf(c, r3.id).localWork([attemptId])).processes, [], "an attempt of another host is not this host's");
  });

  suite("a report is fenced like every message about the attempt: another host, an older placement, a stale session, an unknown attempt and a placement that was never accepted are refused, and nothing of theirs is kept (card L02e)", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const { attemptId, placement, attempt } = await c.started(r1);
    await wireRefuses("not_found", () => r2.client.attempt(attemptId, placement).reportProcesses({ seq: 1, final: false, processes: [P("theirs")] }), 404);
    await wireRefuses("fenced", () => r1.client.attempt(attemptId, placement + 1).reportProcesses({ seq: 1, final: false, processes: [P("future")] }), 409);
    await wireRefuses("not_found", () => r2.client.attempt("att-aaaaaaaaaaaaaaaaaaaa", 1).reportProcesses({ seq: 1, final: false, processes: [] }), 404);
    const raw = await rawRequest(c.transport.url, "POST", `/worker/attempts/${attemptId}/processes`, { token: r1.token, body: { placement, seq: 1, final: false, processes: [P("x")] }, headers: { [SESSION_HEADER]: "ses-nonexistent", [PROTOCOL_HEADER]: "1" } });
    assert.ok(raw.status === 409 || raw.status === 404, String(raw.status));
    assert.equal((await c.remote.placement(c.dispatcherPrincipal, attemptId))!.processReport, undefined, "nothing was kept");
    // A move: the old holder's report is fenced and the new placement starts with none.
    await attempt.reportProcesses({ seq: 1, final: false, processes: [P("before the move")] });
    await c.remote.relocate(c.owner, { commandId: "mv-1", attemptId, toHostId: r2.id, reason: "retired" });
    await wireRefuses("fenced", () => attempt.reportProcesses({ seq: 2, final: false, processes: [P("late")] }), 409);
    const moved = await c.remote.placement(c.dispatcherPrincipal, attemptId);
    assert.equal(moved!.processReport, undefined, "the new placement does not inherit the old holder's report");
    assert.deepEqual((await hostOf(c, r2.id).localWork([attemptId])).processes.map((p) => p.ref), [`remote:${attemptId}`], "the new host's placement has reported nothing yet: unknown");
    assert.deepEqual((await hostOf(c, r1.id).localWork([attemptId])).processes, [], "and the old host holds no placement of it");
  }, { policy: async () => ({ dataHosts: ["host:r1", "host:r2"] }) });

  suite("a report from a newer session of the same host that has not taken the attempt up again is fenced, and the older session's report is kept as it was (card L02e)", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, placement, attempt } = await c.started(r1);
    await attempt.reportProcesses({ seq: 1, final: false, processes: [P("kept")] });
    const fresh = new RemoteWorkerClient({ url: c.transport.url, token: r1.token, workerVersion: "w" });
    await fresh.connect({ ...REMOTE_CAPS }, "re-1");
    await wireRefuses("fenced", () => fresh.attempt(attemptId, placement).reportProcesses({ seq: 2, final: false, processes: [P("from the new session")] }), 409);
    assert.deepEqual((await c.remote.placement(c.dispatcherPrincipal, attemptId))!.processReport!.processes, [P("kept")]);
  });

  suite("a worker that took the attempt up again in a newer session (a restarted worker program) starts its own sequence: its reports and its final word are kept, and the older session's are fenced (review of L02e)", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, placement, attempt } = await c.started(r1);
    assert.deepEqual(await attempt.reportProcesses({ seq: 5, final: false, processes: [P("from the old program")] }), { kept: true });
    // The worker program restarts: a new session, the attempt taken up again (auto), and a runner whose sequence starts from 1.
    const fresh = new RemoteWorkerClient({ url: c.transport.url, token: r1.token, workerVersion: "w" });
    await fresh.connect({ ...REMOTE_CAPS }, "re-2");
    const again = fresh.attempt(attemptId, placement);
    await again.accept();
    assert.deepEqual(await again.reportProcesses({ seq: 1, final: false, processes: [P("from the new program")] }), { kept: true }, "a new session's first report is not an old one");
    assert.deepEqual((await hostOf(c, r1.id).localWork([attemptId])).processes.map((p) => p.ref), ["from the new program"]);
    assert.deepEqual(await again.reportProcesses({ seq: 2, final: true, processes: [] }), { kept: true }, "and its last word is taken");
    assert.deepEqual((await hostOf(c, r1.id).localWork([attemptId])).processes, []);
    await wireRefuses("fenced", () => attempt.reportProcesses({ seq: 6, final: false, processes: [P("late, old program")] }), 409);
    assert.deepEqual(await again.reportProcesses({ seq: 1, final: false, processes: [P("replayed")] }), { kept: false }, "within one session the sequence still only rises");
  });

  suite("a report is checked entry by entry: exact fields, the kinds and states that exist, a bounded list and body, a sequence from 1, redacted and cut references; a bad report keeps nothing (card L02e)", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, placement } = await c.started(r1);
    const post = (body: unknown) => r1.client.send("POST", `/worker/attempts/${attemptId}/processes`, { body: body as never, session: true, key: "k" });
    const bad = async (body: unknown, field: string): Promise<void> => { await wireRefuses("invalid_command", () => post(body), 400, (e) => assert.match(e.message, new RegExp(field))); };
    await bad({ placement, seq: 0, final: false, processes: [] }, "seq");
    await bad({ placement, seq: 1.5, final: false, processes: [] }, "seq");
    await bad({ placement, seq: "1", final: false, processes: [] }, "seq");
    await bad({ placement, seq: 1, final: "no", processes: [] }, "final");
    await bad({ placement, seq: 1, final: false, processes: "none" }, "processes");
    await bad({ placement, seq: 1, final: false, processes: Array.from({ length: REMOTE_LIMITS.processes + 1 }, (_, i) => P(`p${i}`)) }, "processes");
    await bad({ placement, seq: 1, final: false, processes: [P("x"), 5] }, "processes\\[1\\]");
    await bad({ placement, seq: 1, final: false, processes: [{ ref: "x", kind: "process", state: "running", extra: 1 }] }, "extra");
    await bad({ placement, seq: 1, final: false, processes: [{ ref: "x", kind: "daemon", state: "running" }] }, "kind");
    await bad({ placement, seq: 1, final: false, processes: [{ ref: "x", kind: "process", state: "gone" }] }, "state");
    await bad({ placement, seq: 1, final: false, processes: [{ ref: "", kind: "process", state: "running" }] }, "ref");
    await bad({ placement, seq: 1, final: false, processes: [{ ref: "x".repeat(REMOTE_LIMITS.processRef * 4 + 1), kind: "process", state: "running" }] }, "ref");
    await bad({ placement, seq: 1, final: false, processes: [], extra: true }, "extra");
    await wireRefuses("too_large", () => post({ placement, seq: 1, final: false, processes: [P("y".repeat(REMOTE_LIMITS.processBytes))] }), 413);
    assert.equal((await c.remote.placement(c.dispatcherPrincipal, attemptId))!.processReport, undefined, "a bad report keeps nothing");
    // A full list is taken; a command line with a credential is redacted before it is cut, a control or direction character is replaced, and a repeat is one entry.
    const secret = "curl -H 'Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789' https://x.example/" + "a".repeat(300);
    const said = await post({ placement, seq: 1, final: false, processes: [{ ref: secret, kind: "process", state: "running" }, P("two\nlines‮evil"), P("two\nlines‮evil"), ...Array.from({ length: REMOTE_LIMITS.processes - 3 }, (_, i) => P(`p${i}`))] });
    assert.deepEqual(said.body, { kept: true });
    const kept = (await c.remote.placement(c.dispatcherPrincipal, attemptId))!.processReport!;
    assert.equal(kept.processes.length, REMOTE_LIMITS.processes - 1, "the repeat is one entry");
    assert.ok(kept.processes[0]!.ref.length <= REMOTE_LIMITS.processRef);
    assert.ok(!/sk-live-abcdef/.test(JSON.stringify(kept)), "no credential is kept");
    assert.equal(kept.processes[1]!.ref, "two lines evil");
    assert.equal(kept.placement, placement);
    assert.deepEqual(await hostOf(c, r1.id).localWork([attemptId]).then((w) => w.processes.length), REMOTE_LIMITS.processes - 1);
    // Every control or format character is replaced (C1 controls, the marks that turn text around, line separators), and a cut never leaves half a character (review of L02e).
    const odd = `a\u0085b‏c؜d e f﻿g ${"x".repeat(REMOTE_LIMITS.processRef - 17)}😀😀`;
    await post({ placement, seq: 2, final: false, processes: [{ ref: odd, kind: "process", state: "running" }] });
    const cleaned = (await c.remote.placement(c.dispatcherPrincipal, attemptId))!.processReport!.processes[0]!.ref;
    assert.ok(!new RegExp("[\\u0080-\\u009f\\u200e\\u200f\\u061c\\u2028\\u2029\\ufeff]").test(cleaned), JSON.stringify(cleaned));
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(cleaned), "no half of a character is kept");
    assert.ok(cleaned.length <= REMOTE_LIMITS.processRef);
  });

}

// The worker's side, without a controller: a runner over a stub attempt and a stub host.
type Held = { attemptId?: string; ref: string; kind: "process" | "child"; state: "running" | "uncooperative" | "unknown" };
function stubRun(options: { list: () => Held[]; look?: boolean; failReport?: (n: number) => Error | undefined; fenceAt?: number; runMs?: number }) {
  const sent: { seq: number; final: boolean; processes: readonly unknown[] }[] = [];
  const trouble: string[] = [];
  let n = 0;
  const attempt = {
    accept: async () => ({}), honorContract: async () => ({ ok: true }), pollControl: async () => [], complete: async () => ({}),
    reportProcesses: async (r: { seq: number; final: boolean; processes: readonly unknown[] }) => {
      n += 1;
      const failure = options.failReport?.(n); if (failure !== undefined) throw failure;
      sent.push(r); return { kept: true };
    },
  };
  const state = { stopped: false };
  const handle = { run: async () => { await new Promise((ok) => setTimeout(ok, options.runMs ?? 150)); return { status: "completed", text: "done", endKind: "normal" }; }, checkpoint: async () => undefined, restart: async () => undefined, stop: async () => { state.stopped = true; } };
  const host = { start: async () => handle, ...(options.look === false ? {} : { localWork: async () => ({ processes: options.list(), known: [] }) }) };
  const runner = new RemoteOfferRunner({ client: { attempt: () => attempt } as never, host: host as never, abilities: FULL_ABILITIES, controlMs: 10, onTrouble: (_id, what) => trouble.push(what) });
  const offer = { placement: 1, order: { attemptId: "att-aaaaaaaaaaaaaaaaaaaa", taskId: "t", projectId: "p", agentId: "a", generation: 1, route: "x/y", credential: "", recipe: { revision: "r", reach: [] } } } as unknown as { placement: number; order: WorkOrder };
  return { runner, sent, trouble, state, offer };
}

test("the runner reports what its host holds when it changes (not on every look), and once more at the end marked final, with the sandbox stopped first (card L02e)", async () => {
  let list: Held[] = [];
  const w = stubRun({ list: () => list, runMs: 400 });
  const done = w.runner.run(w.offer);
  await new Promise((ok) => setTimeout(ok, 120));
  list = [{ attemptId: "att-aaaaaaaaaaaaaaaaaaaa", ref: "node dev.js", kind: "process", state: "running" }, { attemptId: "att-bbbbbbbbbbbbbbbbbbbb", ref: "another attempt's", kind: "process", state: "running" }];
  await new Promise((ok) => setTimeout(ok, 120));
  const settled = await done;
  assert.equal(settled, "completed");
  assert.equal(w.state.stopped, true);
  const seqs = w.sent.map((r) => r.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), "the sequence rises by one");
  assert.deepEqual(w.sent.filter((r) => !r.final).map((r) => r.processes), [[], [{ ref: "node dev.js", kind: "process", state: "running" }]], "one report for each change, and only the attempt's own entries");
  assert.equal(w.sent.at(-1)!.final, true);
  assert.deepEqual(w.sent.at(-1)!.processes, [{ ref: "node dev.js", kind: "process", state: "running" }], "the last word lists what is still there after the stop");
  assert.equal(w.sent.filter((r) => r.final).length, 1);
});

test("a host that cannot look reports nothing; a look that fails or a report that fails is a trouble, never the end of the attempt; a fenced report ends the sandbox; an over-long list is cut with a line saying so (card L02e)", async () => {
  const none = stubRun({ list: () => [], look: false });
  assert.equal(await none.runner.run(none.offer), "completed");
  assert.deepEqual(none.sent, [], "nothing to say: the controller reads a live placement as unknown, as before");
  const failing = stubRun({ list: () => { throw new Error("the sandbox would not say"); } });
  assert.equal(await failing.runner.run(failing.offer), "completed");
  assert.deepEqual(failing.sent, []);
  assert.ok(failing.trouble.includes("process report") && failing.trouble.includes("final process report"));
  const flaky = stubRun({ list: () => [{ ref: "x", kind: "process", state: "running" }], failReport: (n) => (n === 1 ? new Error("network") : undefined) });
  assert.equal(await flaky.runner.run(flaky.offer), "completed");
  assert.ok(flaky.sent.length >= 1 && flaky.sent[0]!.seq === 2, "a report that failed is sent again under a new number (it may have arrived: its number is never used for other figures)");
  assert.ok(flaky.trouble.includes("process report"));
  const fenced = stubRun({ list: () => [{ ref: "x", kind: "process", state: "running" }], failReport: () => new WorkerRequestError(409, "fenced", "the placement moved"), runMs: 600 });
  assert.notEqual(await fenced.runner.run(fenced.offer), undefined);
  assert.equal(fenced.state.stopped, true, "a worker told it is fenced stops the sandbox");
  const many = stubRun({ list: () => Array.from({ length: REMOTE_LIMITS.processes + 20 }, (_, i) => ({ ref: `p${i}`, kind: "process" as const, state: "running" as const })) });
  await many.runner.run(many.offer);
  const last = many.sent.at(-1)!;
  assert.equal(last.processes.length, REMOTE_LIMITS.processes);
  assert.match(String((last.processes.at(-1) as { ref: string }).ref), /21 more processes are not listed/);
});

test("the host reads only the report that belongs to the placement it holds now: a report left from another placement is never taken as this one's (card L02e)", async () => {
  const body = (extra: object) => ({ attemptId: "att-aaaaaaaaaaaaaaaaaaaa", hostId: "host:r1", placement: 2, state: "accepted", ...extra });
  const remote = (placement: object) => ({ placement: async () => placement }) as never;
  const ask = async (placement: object) => (await new RemoteWorkerHost("host:r1", remote(placement), {} as never, { resources: { cpus: 1, memoryMb: 1 }, requirements: () => ({}) as never }).localWork(["att-aaaaaaaaaaaaaaaaaaaa"])).processes;
  const left = { placement: 1, seq: 9, at: "2026-11-11T08:00:00.000Z", final: true, processes: [P("from placement one")] };
  assert.deepEqual(await ask(body({ processReport: left })), [{ attemptId: "att-aaaaaaaaaaaaaaaaaaaa", ref: "remote:att-aaaaaaaaaaaaaaaaaaaa", kind: "process", state: "unknown" }], "a live placement whose only report is another placement's reads as unreported");
  assert.deepEqual(await ask(body({ state: "ended", processReport: left })), [], "and an ended one as never reported");
  assert.deepEqual((await ask(body({ processReport: { ...left, placement: 2, final: false } }))).map((p) => p.ref), ["from placement one"], "its own is read");
});

test("a report whose answer was lost never has its number used again for other figures, so the controller does not refuse every later report and the final one (review of L02e)", async () => {
  // The stub controller keeps what it was sent by number, as the real one does, and the answer to the first report is lost after it arrived.
  const kept = new Map<number, string>();
  let list: Held[] = [{ ref: "one", kind: "process", state: "running" }];
  let calls = 0;
  const offer = stubRun({ list: () => [] }).offer;
  const real: { seq: number; final: boolean; processes: readonly unknown[] }[] = [];
  const attempt = {
    accept: async () => ({}), honorContract: async () => ({ ok: true }), pollControl: async () => [], complete: async () => ({}),
    reportProcesses: async (r: { seq: number; final: boolean; processes: readonly unknown[] }) => {
      calls += 1;
      const body = JSON.stringify([r.final, r.processes]);
      const had = kept.get(r.seq);
      if (had !== undefined && had !== body) throw new WorkerRequestError(409, "payload_changed", `report ${r.seq} was already given with other figures`);
      kept.set(r.seq, body); real.push(r);
      // The answer is lost, and what the sandbox holds changes before the next look.
      if (calls === 1) { list = [{ ref: "two", kind: "process", state: "running" }]; throw new Error("the connection dropped before the answer"); }
      return { kept: true };
    },
  };
  const handle = { run: async () => { await new Promise((ok) => setTimeout(ok, 400)); return { status: "completed", text: "done", endKind: "normal" }; }, checkpoint: async () => undefined, restart: async () => undefined, stop: async () => { list = []; } };
  const trouble: string[] = [];
  const runner = new RemoteOfferRunner({ client: { attempt: () => attempt } as never, host: { start: async () => handle, localWork: async () => ({ processes: list, known: [] }) } as never, abilities: FULL_ABILITIES, controlMs: 10, onTrouble: (_id, what) => trouble.push(what) });
  const done = runner.run(offer);
  assert.equal(await done, "completed");
  assert.ok(!trouble.some((t) => t === "final process report"), `the final report was taken: ${trouble.join(", ")}`);
  const last = real.at(-1)!;
  assert.equal(last.final, true);
  assert.deepEqual(last.processes, []);
  assert.equal(trouble.filter((t) => t === "process report").length, 1, "only the lost answer was a trouble");
});

test("a report always fits the controller's body limit: references are redacted before they are cut, and a list too big for the body is cut with a line saying so (review of L02e)", async () => {
  const secret = "Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789";
  // Three bytes a character: 50 references of 120 characters are over the 16 KB body.
  const long = (i: number): Held => ({ ref: `${i} ${"€".repeat(50)} -H 'Authorization: ${secret}' ${"€".repeat(300)}`, kind: "process", state: "running" });
  const w = stubRun({ list: () => Array.from({ length: REMOTE_LIMITS.processes }, (_, i) => long(i)) });
  assert.equal(await w.runner.run(w.offer), "completed");
  assert.ok(w.sent.length >= 2);
  for (const r of w.sent) {
    const bytes = Buffer.byteLength(JSON.stringify({ placement: Number.MAX_SAFE_INTEGER, seq: r.seq, final: r.final, processes: r.processes }), "utf8");
    assert.ok(bytes <= REMOTE_LIMITS.processBytes, `a report of ${bytes} bytes is over the limit`);
    for (const p of r.processes as { ref: string }[]) {
      assert.ok(p.ref.length <= REMOTE_LIMITS.processRef, String(p.ref.length));
      assert.ok(!/sk-live-abc/.test(p.ref), "no part of a credential is sent");
    }
    assert.match(String((r.processes.at(-1) as { ref: string }).ref), /more processes are not listed/);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeMessage, type ChannelStart, type FromChild, type ToChild } from "@nimblenewt/contracts";
import type { LaunchRequest, RunResult, SandboxRun } from "../sandbox/launcher.js";
import { PROCESS_LIMITS, ProcessNotEnded, WorkerProcess, type ProcessHandlers } from "./process.js";

const start = { attemptId: "a", agentId: "g", namespaceId: "abcdef0123456789", credential: "c", storeDir: "/s", relayBase: "http://relay.invalid", model: { alias: "m0", provider: "p", api: "openai-completions", modelId: "m", contextWindow: 10, maxTokens: 10, reasoning: false, input: ["text"] } } as ChannelStart;
const handlers: ProcessHandlers = { bridge: async () => ({ ok: true, result: {} }), relay: async () => { throw new Error("no"); } };

/** A launcher whose process the test plays: it sees what the host writes and chooses what to send back. */
function fake(options: { stuckWrites?: boolean } = {}) {
  const written: ToChild[] = [];
  let emit!: (m: FromChild | string) => void;
  let finish!: (r: RunResult) => void;
  const result = new Promise<RunResult>((ok) => { finish = ok; });
  const done = (extra: Partial<RunResult> = {}): RunResult => ({ exitCode: 0, signal: null, timedOut: false, killed: false, stdout: "", stderr: "", stdoutTruncated: false, ...extra } as RunResult);
  const run: SandboxRun = {
    result, kill: () => finish(done({ killed: true, exitCode: null })), endInput: () => undefined,
    write: (text: string) => { written.push(...text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ToChild)); return options.stuckWrites === true ? new Promise<void>(() => undefined) : Promise.resolve(); },
  } as unknown as SandboxRun;
  const launcher = { launch: async (request: LaunchRequest) => { emit = (m) => request.stream!.onStdout(Buffer.from(typeof m === "string" ? m : encodeMessage(m))); return run; } };
  return { launcher, written, send: (m: FromChild | string) => emit(m), exit: (r: Partial<RunResult> = {}) => finish(done(r)) };
}
const launch = (f: ReturnType<typeof fake>) => WorkerProcess.launch(f.launcher as never, { recipe: {} as never, command: ["x"], timeoutMs: 1000, maxOutputBytes: 1000 }, handlers);

test("a process that faults or exits while the host is still writing to it does not crash the host", async () => {
  const f = fake({ stuckWrites: true });
  const process = await launch(f);
  const starting = process.start(start, 5000);
  f.send({ t: "fault", message: "cannot start" });
  await assert.rejects(starting, /cannot start/);
  const running = process.run("r", "go").catch((e: Error) => e);
  f.exit({ exitCode: 1, stderr: "boom" });
  assert.match(String(((await running) as Error).message), /ended|cannot be written/);
  await new Promise((r) => setTimeout(r, 20));
});

test("a process that does not read the channel is stopped, not held in memory", async () => {
  const f = fake({ stuckWrites: true });
  const process = await launch(f);
  const big = "x".repeat(300_000);
  const sends = [] as Promise<unknown>[];
  for (let i = 0; i < 20; i++) sends.push(process.tell(big).catch((e: Error) => e));
  const outcomes = await Promise.all(sends);
  assert.ok(outcomes.some((o) => o instanceof Error && /not reading|ended|stopped/.test(o.message)));
  assert.equal((await process.exited).killed, true);
});

test("a process that keeps asking past its limits is stopped", async () => {
  const f = fake();
  const never = new Promise<never>(() => undefined);
  const process = await WorkerProcess.launch(f.launcher as never, { recipe: {} as never, command: ["x"], timeoutMs: 1000, maxOutputBytes: 1000 }, { bridge: handlers.bridge, relay: () => never });
  for (let i = 1; i <= PROCESS_LIMITS.fetchInFlight + PROCESS_LIMITS.refusals + 5; i++) f.send({ t: "fetch", id: i, url: "http://relay.invalid/m0/chat/completions", method: "POST", headers: [] });
  assert.equal((await process.exited).killed, true);
});

test("H12j: modelCallsInFlight counts relay calls from the request until they end", async () => {
  const f = fake();
  let end!: () => void;
  const gate = new Promise<void>((ok) => { end = ok; });
  const process = await WorkerProcess.launch(f.launcher as never, { recipe: {} as never, command: ["x"], timeoutMs: 1000, maxOutputBytes: 1000 }, { bridge: handlers.bridge, relay: async () => { await gate; return { status: 200, statusText: "OK", headers: [], body: null } as never; } });
  assert.equal(process.modelCallsInFlight, 0);
  f.send({ t: "fetch", id: 1, url: "http://relay.invalid/m0/chat/completions", method: "POST", headers: [] });
  assert.equal(process.modelCallsInFlight, 1);
  end();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(process.modelCallsInFlight, 0);
  process.kill("done");
});

test("H12b: the relay's answer is sent to the process piece by piece as it arrives, not after the whole stream", async () => {
  const f = fake();
  let release!: () => void;
  const rest = new Promise<void>((ok) => { release = ok; });
  async function* body(): AsyncGenerator<Uint8Array> { yield Buffer.from("data: first\n\n"); await rest; yield Buffer.from("data: second\n\n"); }
  const process = await WorkerProcess.launch(f.launcher as never, { recipe: {} as never, command: ["x"], timeoutMs: 1000, maxOutputBytes: 1000 }, { bridge: handlers.bridge, relay: async () => ({ status: 200, statusText: "OK", headers: [["content-type", "text/event-stream"]], body: body() }) as never });
  f.send({ t: "fetch", id: 1, url: "http://relay.invalid/m0/chat/completions", method: "POST", headers: [] });
  const sent = (t: string): ToChild[] => f.written.filter((m) => m.t === t);
  for (let i = 0; i < 100 && sent("fetch.chunk").length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent("fetch.chunk").length, 1, "the first piece went to the process while the stream was still open");
  assert.equal(Buffer.from((sent("fetch.chunk")[0] as { data: string }).data, "base64").toString("utf8"), "data: first\n\n");
  assert.equal(sent("fetch.end").length, 0, "the stream has not ended yet");
  release();
  for (let i = 0; i < 100 && sent("fetch.end").length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent("fetch.chunk").map((m) => Buffer.from((m as { data: string }).data, "base64").toString("utf8")), ["data: first\n\n", "data: second\n\n"]);
  assert.equal(sent("fetch.end").length, 1);
  process.kill("done");
});

test("H08b3: a lease.lost from the process is observed by the host with no turn open", async () => {
  const f = fake();
  const process = await launch(f);
  assert.equal(process.leaseLost, undefined);
  const waiting = process.whenLeaseLost();
  f.send({ t: "lease.lost", reason: "wake" });
  assert.equal(await waiting, "wake");
  assert.equal(process.leaseLost, "wake");
  assert.equal(await process.whenLeaseLost(), "wake");
  f.send({ t: "lease.lost", reason: "silent" });
  assert.equal(process.leaseLost, "wake", "the first reason stands");
  f.exit();
});

test("H08b: the host answers a renewal with the controller's duration or as fenced, sends nothing when the controller cannot be asked, and ends a process that outlives the grace after a loss", async () => {
  const f = fake();
  const answers: (() => Promise<{ leaseMs: number } | { fenced: string }>)[] = [async () => ({ leaseMs: 60_000.7 }), async () => { throw new Error("the controller is restarting"); }, async () => ({ fenced: "the attempt has been replaced" })];
  const process = await WorkerProcess.launch(f.launcher as never, { recipe: {} as never, command: ["x"], timeoutMs: 1000, maxOutputBytes: 1000 }, { ...handlers, renew: () => answers.shift()!() });
  const starting = process.start({ ...start, lease: { leaseMs: 60_000, graceMs: 50 } }, 5000);
  f.send({ t: "ready", v: 1 });
  await starting;
  for (const id of [1, 2, 3]) f.send({ t: "lease.renew", id });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(f.written.filter((m) => m.t.startsWith("lease.")), [{ t: "lease.ok", id: 1, leaseMs: 60_000 }, { t: "lease.fenced", id: 3, reason: "the attempt has been replaced" }]);
  // The grace timer does not hold the host's event loop (the controller does); the test holds it while it waits.
  const hold = setInterval(() => undefined, 1000);
  const ended = await Promise.race([process.exited, new Promise<undefined>((r) => { setTimeout(() => r(undefined), 2000); })]);
  clearInterval(hold);
  assert.equal(ended?.killed, true, "the process did not end itself within the grace, so the host ended it");
  if (ended === undefined) f.exit();
});

test("H08b: a process that says its lease ended and then exits on its own is not killed; a host with no renewal answers nothing", async () => {
  const f = fake();
  const process = await launch(f);
  const starting = process.start({ ...start, lease: { leaseMs: 60_000, graceMs: 30 } }, 5000);
  f.send({ t: "ready", v: 1 });
  await starting;
  f.send({ t: "lease.lost", reason: "silent" });
  f.exit({ exitCode: 75 });
  const ended = await process.exited;
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual([ended.killed, ended.exitCode], [false, 75]);
  const g = fake();
  const other = await launch(g);
  const s2 = other.start(start, 5000);
  g.send({ t: "ready", v: 1 });
  await s2;
  g.send({ t: "lease.lost", reason: "silent" });
  g.send({ t: "lease.renew", id: 1 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(g.written.some((m) => m.t.startsWith("lease.")), false, "a host with no renewal answers nothing");
  g.exit();
  assert.equal((await other.exited).killed, false, "no lease in the start: nothing is scheduled");
});

test("H08b: a process may not keep more renewals waiting at the controller than a few; one that floods them is stopped", async () => {
  const f = fake();
  let asked = 0;
  const never = new Promise<never>(() => undefined);
  const process = await WorkerProcess.launch(f.launcher as never, { recipe: {} as never, command: ["x"], timeoutMs: 1000, maxOutputBytes: 1000 }, { ...handlers, renew: () => { asked++; return never; } });
  for (let i = 1; i <= PROCESS_LIMITS.renewInFlight + PROCESS_LIMITS.refusals + 5; i++) f.send({ t: "lease.renew", id: i });
  assert.equal(asked, PROCESS_LIMITS.renewInFlight, "only a few renewals reach the controller at once");
  assert.equal((await process.exited).killed, true);
});

// Card L02d: winding a process down is timed, a process that outlives its kill is reported (never waited on for ever), and Force Stop kills it again.
test("L02d: close asks, kills after the grace, and gives up with ProcessNotEnded when the process is still there; the winding-down time counts from the first request; Force Stop kills again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  t.mock.method(performance, "now", () => Date.now());
  let kills = 0;
  let killable = false;
  let finish!: (r: RunResult) => void;
  const result = new Promise<RunResult>((ok) => { finish = ok; });
  const written: ToChild[] = [];
  const run = {
    result, endInput: () => undefined,
    kill: () => { kills++; if (killable) finish({ exitCode: null, signal: "SIGKILL", timedOut: false, killed: true, stdout: "", stderr: "", truncated: false, stdoutTruncated: false, durationMs: 1 }); },
    write: async (text: string) => { written.push(...text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ToChild)); },
    processes: async () => ({ processes: [{ pid: 7, parent: 1, name: "node", started: "1" }], truncated: false }),
  } as unknown as SandboxRun;
  const p = await WorkerProcess.launch({ launch: async () => run } as never, { recipe: {} as never, command: ["x"], timeoutMs: 1000, maxOutputBytes: 1000 }, handlers);
  assert.equal(p.alive, true);
  assert.equal(p.endAsked, false);
  assert.equal(p.windDownMs(), 0, "never asked to end: nothing to count");
  assert.deepEqual((await p.processes())?.processes.map((x) => x.pid), [7]);
  const closing = p.close();
  closing.catch(() => undefined);
  await new Promise((r) => setImmediate(r));
  assert.ok(written.some((m) => m.t === "close"), "it is asked first");
  assert.equal(p.endAsked, true);
  t.mock.timers.tick(PROCESS_LIMITS.closeGraceMs);
  assert.equal(kills, 1, "killed once the grace is over");
  t.mock.timers.tick(PROCESS_LIMITS.killWaitMs);
  await assert.rejects(closing, (e: unknown) => e instanceof ProcessNotEnded && /did not end/.test((e as Error).message));
  assert.equal(p.alive, true, "not taken as gone");
  assert.equal(p.windDownMs(), PROCESS_LIMITS.closeGraceMs + PROCESS_LIMITS.killWaitMs, "still counting from the first request");
  t.mock.timers.tick(1000);
  assert.equal(p.windDownMs(), PROCESS_LIMITS.closeGraceMs + PROCESS_LIMITS.killWaitMs + 1000);
  // Force Stop: killed again; this time it goes, and the count stops there.
  killable = true;
  const before = kills;
  await p.forceEnd(10);
  assert.ok(kills > before);
  await new Promise((r) => setImmediate(r));
  assert.equal(p.alive, false);
  const total = p.windDownMs();
  t.mock.timers.tick(5000);
  assert.equal(p.windDownMs(), total, "an ended process costs nothing more");
});

test("L02d: a process that obeys the close ends without a kill, and its winding-down time is what it took", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000 });
  t.mock.method(performance, "now", () => Date.now());
  const f = fake();
  const p = await launch(f);
  const closing = p.close();
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(40);
  f.exit();
  const r = await closing;
  assert.equal(r.killed, false);
  await new Promise((r2) => setImmediate(r2));
  assert.equal(p.alive, false);
  assert.equal(p.windDownMs(), 40);
});

test("L02d review: the winding-down time is on the monotonic clock; a wall clock set back a day or forward a year changes nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 9_000_000_000 });
  let mono = 1_000;
  t.mock.method(performance, "now", () => mono);
  const f = fake();
  const p = await launch(f);
  p.kill("stop");
  mono += 250;
  t.mock.timers.setTime(9_000_000_000 - 86_400_000);
  assert.equal(p.windDownMs(), 250, "set back: never negative, never 0 while it winds down");
  t.mock.timers.setTime(9_000_000_000 + 365 * 86_400_000);
  mono += 50;
  await new Promise((r) => setImmediate(r));
  assert.equal(p.alive, false);
  assert.equal(p.windDownMs(), 300, "set forward: not a year of compute");
});

test("C07q: a compacted notice from the process reaches the host's handler; a handler that throws or is absent changes nothing", async () => {
  const note = { messageCount: 9, summaryChars: 400, digest: "b".repeat(64) };
  const got: unknown[] = [];
  const f = fake();
  const process = await WorkerProcess.launch(f.launcher as never, { recipe: {} as never, command: ["x"], timeoutMs: 1000, maxOutputBytes: 1000 }, { ...handlers, compacted: (n) => { got.push(n); throw new Error("controller down"); } });
  f.send({ t: "compacted", ...note });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got, [note]);
  assert.equal(process.alive, true, "a handler that throws does not end the process");
  const g = fake();
  const plain = await launch(g);
  g.send({ t: "compacted", ...note });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(plain.alive, true);
  f.exit(); g.exit();
});

test("C07q review: compaction notices are bounded; a flood is refused past the in-flight bound and the process that keeps on is ended, and no more than the per-process total reach the controller", async () => {
  const note = { messageCount: 9, summaryChars: 400, digest: "b".repeat(64) };
  // Held: nothing finishes, so every notice past the in-flight bound is refused.
  let held = 0;
  const f = fake();
  const p = await WorkerProcess.launch(f.launcher as never, { recipe: {} as never, command: ["x"], timeoutMs: 1000, maxOutputBytes: 1000 }, { ...handlers, compacted: () => { held++; return new Promise<void>(() => undefined); } });
  for (let i = 0; i < PROCESS_LIMITS.compactedInFlight + PROCESS_LIMITS.refusals + 5; i++) f.send({ t: "compacted", ...note });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(held, PROCESS_LIMITS.compactedInFlight, "only the in-flight bound reaches the controller");
  assert.equal(p.alive, false, "a process that keeps flooding is ended");
  // Answered at once: one at a time, all are kept up to the per-process total, then dropped (not refused: the process is not ended for compacting often).
  let kept = 0;
  const g = fake();
  const q = await WorkerProcess.launch(g.launcher as never, { recipe: {} as never, command: ["x"], timeoutMs: 1000, maxOutputBytes: 1000 }, { ...handlers, compacted: async () => { kept++; } });
  for (let i = 0; i < PROCESS_LIMITS.compactions + 10; i++) { g.send({ t: "compacted", ...note }); await new Promise((r) => setImmediate(r)); }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(kept, PROCESS_LIMITS.compactions);
  assert.equal(q.alive, true);
  f.exit(); g.exit();
});

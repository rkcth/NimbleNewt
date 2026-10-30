import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeMessage, type ChannelStart, type FromChild, type ToChild } from "@nimblenewt/contracts";
import type { LaunchRequest, RunResult, SandboxRun } from "../sandbox/launcher.js";
import { PROCESS_LIMITS, WorkerProcess, type ProcessHandlers } from "./process.js";

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

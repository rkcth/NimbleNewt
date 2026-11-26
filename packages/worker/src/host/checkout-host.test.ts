import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LaunchRequest, RunResult } from "../sandbox/launcher.js";
import { CHECKOUT_TOOL_LIMITS } from "./checkout-tool.js";
import { localWorkerParts, type HostOrder } from "./local.js";

// First review of card W09b: the host's side of the checkout tool (`localWorkerParts(...).checkout`), which the real-sandbox tests of checkout-tool.test.ts do not reach: the call's sandbox is made from the attempt's with
// an empty home and scratch of its own and the strictest limits, calls of one attempt run one at a time, the sandbox's close ends a running call, an attempt makes at most `callsPerAttempt` calls, and a launcher that shows the
// host's own paths, or an attempt with no sandbox open, is refused. The launcher is a fake that records what it was asked; nothing real is started.
const root = realpathSync(mkdtempSync(join(tmpdir(), "nn checkout host ")));
const dir = (name: string): string => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d; };
const node = dir("node"); writeFileSync(join(node, "marker"), "x");
const app = { node: { root: node, executable: "bin/node" }, mounts: [] as { host: string; guest: string }[], entry: "/opt/app/main.js" };
const work = { checkout: dir("work/checkout"), gitDir: dir("work/git"), home: dir("work/home"), scratch: dir("work/scratch"), env: { LANGUAGE_MODE: "plain" } };
const order: HostOrder = { attemptId: "att-1", taskId: "task-1", projectId: "proj-1", agentId: "agent:ann", route: "r", credential: "c", recipe: { revision: "r1", reach: [] } };
const done = (r: Partial<RunResult> = {}): RunResult => ({ exitCode: 0, signal: null, timedOut: false, killed: false, stdout: "", stderr: "", truncated: false, stdoutTruncated: false, durationMs: 5, ...r });

function make(answer: (request: LaunchRequest, index: number) => Promise<RunResult>, more: { guestPaths?: "host"; limits?: Record<string, number> } = {}) {
  const asked: LaunchRequest[] = [];
  const killed: number[] = [];
  const launcher = {
    launch: async (request: LaunchRequest) => {
      const index = asked.push(request) - 1;
      let stop!: () => void;
      const stopped = new Promise<RunResult>((resolve) => { stop = () => resolve(done({ exitCode: null, signal: "SIGKILL", killed: true })); });
      return { result: Promise.race([answer(request, index), stopped]), kill: () => { killed.push(index); stop(); } } as never;
    },
  };
  const parts = localWorkerParts<unknown>({
    launcher: launcher as never, app: more.guestPaths === "host" ? { ...app, hostEntry: join(node, "marker") } : app, protectedPaths: [], workspace: () => ({ ...work, limits: { memoryMb: 1024, cpus: 2, processes: 4096 } }), model: () => { throw new Error("unused"); }, namespaceId: () => "abcdef0123456789",
    bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); }, checkBase: dir("calls"), requireEnforced: false,
    ...(more.guestPaths === undefined ? {} : { guestPaths: more.guestPaths }), ...(more.limits === undefined ? {} : { limits: () => more.limits }),
  });
  return { parts, asked, killed };
}
const signal = (): AbortSignal => new AbortController().signal;
const helperAnswer = (body = "text\n"): RunResult => done({ stdout: JSON.stringify({ ok: true, body, facts: { path: "a.txt" } }) });

test("a checkout call runs in a sandbox made from the attempt's, with an empty home and scratch of its own and the strictest limits; with no sandbox open nothing runs (W09b review)", async () => {
  const m = make(async (request) => (request.command.includes("-c") && request.command[2] === "/bin/bash" ? done({ stdout: "ran\n" }) : helperAnswer()), { limits: { memoryMb: 512, wallTimeMs: 7_000 } });
  await assert.rejects(m.parts.checkout.run("att-1", { action: "read", path: "a.txt" }, signal()), /no sandbox open/);
  assert.equal(m.asked.length, 0);
  const session = await m.parts.sandbox.open(order.recipe, order);
  try {
    assert.deepEqual(await m.parts.checkout.run("att-1", { action: "read", path: "a.txt" }, signal()), { ok: true, body: "text\n", facts: { path: "a.txt" } });
    const ran = await m.parts.checkout.run("att-1", { action: "run", command: "echo ran" }, signal());
    assert.equal(ran.ok && ran.body, "ran\n");
    for (const r of m.asked) {
      assert.equal(r.recipe.workdir, work.checkout);
      assert.notEqual(r.recipe.home, work.home, "never the agent's home (its conversation store)");
      assert.notEqual(r.recipe.scratch, work.scratch);
      assert.equal(r.recipe.network, "none");
      assert.deepEqual(r.limits, { memoryMb: 512, cpus: 2, processes: CHECKOUT_TOOL_LIMITS.processes }, "the smaller of the attempt's and the owner's, and at most 512 processes");
      assert.equal(r.timeoutMs, 7_000, "the owner's wall time when it is smaller");
      assert.ok(!existsSync(r.recipe.home) && !existsSync(r.recipe.scratch), "the call's own folders are removed");
    }
    // A file action's request goes on standard input, never on a command line; a command is one argument to bash.
    assert.equal(m.asked[0]!.stdin, JSON.stringify({ action: "read", path: "a.txt" }));
    assert.deepEqual(m.asked[1]!.command.slice(-3), ["/bin/bash", "-c", "echo ran"]);
  } finally { await session.close(); }
});

test("calls of one attempt run one at a time, and the sandbox's close ends the running call and refuses the waiting one (W09b review)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const m = make(async (_request, index) => { if (index === 0) await gate; return helperAnswer(`call ${index}\n`); });
  const session = await m.parts.sandbox.open(order.recipe, order);
  let closed = false;
  try {
    const first = m.parts.checkout.run("att-1", { action: "read", path: "a.txt" }, signal());
    const second = m.parts.checkout.run("att-1", { action: "read", path: "b.txt" }, signal());
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(m.asked.length, 1, "the second call waits for the first");
    release();
    assert.equal(((await first) as { body: string }).body, "call 0\n");
    assert.equal(((await second) as { body: string }).body, "call 1\n");
    // A command that never ends by itself: the sandbox's close kills it; a call still waiting its turn is refused, never started.
    const m2 = make(async () => new Promise<RunResult>(() => undefined));
    const s2 = await m2.parts.sandbox.open(order.recipe, order);
    const running = m2.parts.checkout.run("att-1", { action: "run", command: "sleep 600" }, signal());
    const waiting = m2.parts.checkout.run("att-1", { action: "write", path: "a.txt", text: "x" }, signal());
    await new Promise((resolve) => setTimeout(resolve, 100));
    await s2.close();
    closed = true;
    const ended = await running;
    assert.equal(ended.ok && ended.facts["signal"], "SIGKILL", JSON.stringify(ended));
    assert.deepEqual(m2.killed, [0]);
    await assert.rejects(waiting, /sandbox was closed/);
    assert.equal(m2.asked.length, 1, "the waiting call never started");
  } finally { await session.close(); assert.equal(closed, true); }
});

test("an attempt makes at most callsPerAttempt checkout calls, and a launcher that shows the host's own paths cannot run the tool (W09b review)", async () => {
  const m = make(async () => helperAnswer());
  const session = await m.parts.sandbox.open(order.recipe, order);
  try {
    for (let i = 0; i < CHECKOUT_TOOL_LIMITS.callsPerAttempt; i++) await m.parts.checkout.run("att-1", { action: "read", path: "a.txt" }, signal());
    await assert.rejects(m.parts.checkout.run("att-1", { action: "read", path: "a.txt" }, signal()), /5000 checkout calls, the most one attempt may make/);
    assert.equal(m.asked.length, CHECKOUT_TOOL_LIMITS.callsPerAttempt);
  } finally { await session.close(); }
  const h = make(async () => helperAnswer(), { guestPaths: "host" });
  const hs = await h.parts.sandbox.open(order.recipe, order).catch(() => undefined);
  try {
    assert.ok(hs !== undefined, "the sandbox opened");
    await assert.rejects(h.parts.checkout.run("att-1", { action: "read", path: "a.txt" }, signal()), /needs a sandbox with a view of its own/);
    assert.equal(h.asked.length, 0);
  } finally { await hs?.close(); }
});

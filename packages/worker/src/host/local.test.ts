import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { WORKER_CHANNEL_VERSION, encodeMessage, type FromChild, type ToChild } from "@nimblenewt/contracts";
import type { LaunchRequest, RunResult, SandboxRun } from "../sandbox/launcher.js";
import type { RunProcess } from "../sandbox/proc.js";
import { estimateStoredTokens, localWorkerParts, ownerPolicyOptions, recoveryFor, type HostOrder } from "./local.js";
import { PROCESS_LIMITS } from "./process.js";

// Card H12b: the recipe the dispatcher states (named reaches and limits) becomes a real recipe when the sandbox is opened. Nothing is launched here; the launcher's own checks run on the recipe at open.
const root = realpathSync(mkdtempSync(join(tmpdir(), "nn host local ")));
const dir = (name: string): string => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d; };
const node = dir("node"); writeFileSync(join(node, "marker"), "x");
const inputA = dir("input-a"); const inputB = dir("input-b");
const app = { node: { root: node, executable: "bin/node" }, mounts: [] as { host: string; guest: string }[], entry: "/opt/app/main.js" };
const work = { checkout: dir("work/checkout"), gitDir: dir("work/git"), home: dir("work/home"), scratch: dir("work/scratch") };
const order = (reach: string[], extra: Partial<HostOrder["recipe"]> = {}): HostOrder => ({ attemptId: "att-1", agentId: "agent:ann", route: "r", credential: "c", recipe: { revision: "r1", reach, ...extra } });
const parts = (reach?: Parameters<typeof localWorkerParts>[0]["reach"]) => localWorkerParts<unknown>({
  launcher: { launch: async () => { throw new Error("not launched here"); } } as never, app, protectedPaths: [], workspace: () => work,
  model: () => { throw new Error("unused"); }, namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); },
  ...(reach === undefined ? {} : { reach }),
});
const known = (name: string) => (name === "a" ? { readOnly: [{ host: inputA, guest: "/inputs/a" }] } : name === "b" ? { readOnly: [{ host: inputB, guest: "/inputs/b" }], env: { MODE: "b" } } : undefined);

test("a recipe with reaches changes the sandbox's recipe: the same reaches give the same revision, a wider or narrower set another", async () => {
  const p = parts(known);
  const none = await p.sandbox.open(order([]).recipe, order([]));
  const a = await p.sandbox.open(order(["a"]).recipe, order(["a"]));
  const ab = await p.sandbox.open(order(["a", "b"]).recipe, order(["a", "b"]));
  const again = await p.sandbox.open(order([]).recipe, order([]));
  assert.notEqual(none.revision, a.revision);
  assert.notEqual(a.revision, ab.revision);
  assert.equal(again.revision, none.revision, "narrowing back gives the first recipe, with its revision");
  for (const s of [none, a, ab, again]) await s.close();
});

test("a reach this host does not know refuses the sandbox: a recipe is never applied in part; with no resolver at all every reach is refused", async () => {
  await assert.rejects(parts(known).sandbox.open(order(["a", "nope"]).recipe, order(["a", "nope"])), /cannot provide the reach "nope"/);
  await assert.rejects(parts().sandbox.open(order(["a"]).recipe, order(["a"])), /cannot provide the reach "a"/);
  const plain = await parts().sandbox.open(order([]).recipe, order([]));
  await plain.close();
});

test("the names of a recipe are bounded and distinct, and what a reach grants still passes the launcher's mount rules", async () => {
  const p = parts(known);
  for (const reach of [["a", "a"], ["bad name"], [""], Array.from({ length: 33 }, (_, i) => `n${i}`), ["../x"]]) await assert.rejects(p.sandbox.open(order(reach).recipe, order(reach)), /reach must be at most 32 distinct names|cannot provide/, JSON.stringify(reach));
  // A reach that tries to mount the system or somewhere that is not under /inputs or /opt is refused by the recipe checks, not trusted because a host function named it.
  const evil = parts(() => ({ readOnly: [{ host: "/etc", guest: "/inputs/etc" }] }));
  await assert.rejects(evil.sandbox.open(order(["x"]).recipe, order(["x"])), process.platform === "win32" ? /absolute, normalised path|system directory|cannot be mounted|symbolic link/ : /system directory|cannot be mounted|symbolic link/); // a POSIX path such as /etc is not an absolute path on Windows, which the recipe check refuses first
  const outside = parts(() => ({ readOnly: [{ host: inputA, guest: "/work/elsewhere" }] }));
  await assert.rejects(outside.sandbox.open(order(["x"]).recipe, order(["x"])), /read-only mounts go under/);
  // Two reaches that set one variable differently are a conflict, not a silent win for the later one.
  const clash = parts((name) => ({ env: { MODE: name } }));
  await assert.rejects(clash.sandbox.open(order(["p", "q"]).recipe, order(["p", "q"])), /set MODE to different values/);
});

test("the launch command and the store follow the launcher's path style: private paths for bubblewrap, the host's own for a launcher with no private view (Seatbelt); a recipe's limits are the launch's limits", async () => {
  const launched: { command: readonly string[]; limits: unknown; mounts: readonly string[] }[] = [];
  const capture = { launch: async (request: { command: readonly string[]; limits?: unknown; recipe: { readOnly: readonly { guest: string }[] } }) => { launched.push({ command: request.command, limits: request.limits, mounts: request.recipe.readOnly.map((m) => m.guest) }); throw new Error("captured"); } };
  const withEntry = { ...app, hostEntry: join(root, "app", "main.js") };
  const make = (guestPaths?: "private" | "host") => localWorkerParts<unknown>({ launcher: capture as never, app: withEntry, protectedPaths: [], workspace: () => ({ ...work, limits: { memoryMb: 512 } }), model: () => ({ alias: "m0", provider: "p", api: "openai-completions", modelId: "m", contextWindow: 8192, maxTokens: 256, reasoning: false, input: ["text"] }), namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); }, requireEnforced: false, ...(guestPaths === undefined ? {} : { guestPaths }) });
  for (const [style, expected] of [["private", ["/opt/node/bin/node", "/opt/app/main.js"]], ["host", [join(node, "bin/node"), join(root, "app", "main.js")]]] as const) {
    const p = make(style);
    const session = await p.sandbox.open(order([]).recipe, order([]));
    await assert.rejects(p.runtimes.open(order([]), {}, undefined), /captured/);
    await session.close();
    assert.deepEqual(launched.at(-1)!.command, expected, style);
  }
  // The limits of the recipe replace the workspace's default for that launch; without any the workspace's apply.
  const p = make();
  const narrow = await p.sandbox.open({ revision: "r2", reach: [], limits: { memoryMb: 256, processes: 32 } }, order([], { limits: { memoryMb: 256, processes: 32 } }));
  await assert.rejects(p.runtimes.open(order([]), {}, undefined), /captured/);
  await narrow.close();
  assert.deepEqual(launched.at(-1)!.limits, { memoryMb: 256, processes: 32 });
  const plain = await p.sandbox.open(order([]).recipe, order([]));
  await assert.rejects(p.runtimes.open(order([]), {}, undefined), /captured/);
  await plain.close();
  assert.deepEqual(launched.at(-1)!.limits, { memoryMb: 512 });
  // A launcher that shows host paths cannot run an app that does not say where its entry file is.
  assert.throws(() => localWorkerParts<unknown>({ launcher: capture as never, app, protectedPaths: [], workspace: () => work, model: () => { throw new Error("unused"); }, namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); }, guestPaths: "host" }), /host entry file/);
});

test("a reach may not set the environment that changes how programs start (NODE_OPTIONS, GIT_*, BASH_ENV, PYTHON*, ...), and the workspace's own environment is never overridden by a reach (review fixes, card H12b)", async () => {
  const launched: { env: Record<string, string> }[] = [];
  const capture = { launch: async (request: { recipe: { env?: Record<string, string> } }) => { launched.push({ env: request.recipe.env ?? {} }); throw new Error("captured"); } };
  const make = (reach: (name: string) => { env: Record<string, string> } | undefined) => localWorkerParts<unknown>({ launcher: capture as never, app, protectedPaths: [], workspace: () => ({ ...work, env: { MODE: "workspace", KEEP: "1" } }), model: () => ({ alias: "m0", provider: "p", api: "openai-completions", modelId: "m", contextWindow: 8192, maxTokens: 256, reasoning: false, input: ["text"] }), namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); }, reach });
  for (const bad of ["NODE_OPTIONS", "GIT_SSH_COMMAND", "GIT_CONFIG_COUNT", "BASH_ENV", "ENV", "PYTHONSTARTUP", "PYTHONPATH", "RUBYOPT", "PERL5OPT", "LD_PRELOAD", "PATH", "HOME", "NPM_CONFIG_REGISTRY", "BAD KEY"]) {
    await assert.rejects(make(() => ({ env: { [bad]: "x" } })).sandbox.open(order(["e"]).recipe, order(["e"])), /may not set/, bad);
  }
  // A harmless name is passed; where the workspace sets the same name, the workspace's value stays.
  const p = make(() => ({ env: { REGION: "eu", MODE: "reach" } }));
  const session = await p.sandbox.open(order(["e"]).recipe, order(["e"]));
  await assert.rejects(p.runtimes.open(order(["e"]), {}, undefined), /captured/);
  await session.close();
  assert.equal(launched.at(-1)!.env["REGION"], "eu");
  assert.equal(launched.at(-1)!.env["MODE"], "workspace", "the workspace wins");
  assert.equal(launched.at(-1)!.env["KEEP"], "1");
});

test("a restart or resume asks the process to release Pi's hold only when the controller's review says nothing is held; otherwise the hold stays and is reported (review fixes, card H12b)", async () => {
  const told: string[] = [];
  const o = order([]);
  assert.equal(await recoveryFor({ heldForReview: () => true, onHeld: (_o, why) => told.push(why) }, o, true), undefined);
  assert.equal(told.length, 1, "the held work is reported");
  assert.equal(await recoveryFor({}, o, true), undefined, "no review given: the hold stays");
  assert.equal(await recoveryFor({ heldForReview: () => { throw new Error("ledger unreadable"); } }, o, false), undefined, "a review that fails is not a review");
  assert.deepEqual(await recoveryFor({ heldForReview: async () => false }, o, true), { reason: "the controller restarted the sandbox of this attempt" });
  assert.deepEqual(await recoveryFor({ heldForReview: () => false }, o, false), { reason: "the controller resumed this attempt from a checkpoint" });
});

test("a checkpoint that does not say how big the conversation is is estimated from the stored conversation, not taken as empty (review fixes, card H12f)", async () => {
  const store = dir("store/pi");
  assert.equal(estimateStoredTokens(store), undefined, "nothing stored");
  assert.equal(estimateStoredTokens(join(root, "no-such-dir")), undefined);
  writeFileSync(join(store, "a.jsonl"), "x".repeat(3000)); mkdirSync(join(store, "sub")); writeFileSync(join(store, "sub", "b.jsonl"), "y".repeat(6000));
  assert.equal(estimateStoredTokens(store), 3000);
});

// Card H12e (review): a turn whose process ends before it answers still reports the cache figures its model calls produced, under a turn number of its own: a crash, and a process the host closed (a stop, a restart for a recipe change, which the local worker continues).
/** A launcher whose process the test plays: ready at the start, a turn that never answers, and an exit on `close` (or when the test ends it). */
function playedProcess(seen: ToChild[] = []) {
  let finish!: (r: RunResult) => void;
  const result = new Promise<RunResult>((ok) => { finish = ok; });
  const exit = (extra: Partial<RunResult> = {}) => finish({ exitCode: 0, signal: null, timedOut: false, killed: false, stdout: "", stderr: "", stdoutTruncated: false, ...extra } as RunResult);
  let emit!: (m: FromChild) => void;
  let turnStarted!: () => void;
  const running = new Promise<void>((ok) => { turnStarted = ok; });
  const run = {
    result, kill: () => exit({ killed: true, exitCode: null }), endInput: () => undefined,
    write: async (text: string) => {
      for (const m of text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ToChild)) {
        seen.push(m);
        if (m.t === "start") queueMicrotask(() => emit({ t: "ready", v: WORKER_CHANNEL_VERSION }));
        if (m.t === "run") turnStarted();
        if (m.t === "close") exit();
      }
    },
  } as unknown as SandboxRun;
  const launcher = { launch: async (request: LaunchRequest) => { emit = (m) => request.stream!.onStdout(Buffer.from(encodeMessage(m))); return run; } };
  return { launcher, running, crash: () => exit({ exitCode: 1, stderr: "killed" }) };
}
test("the context the controller gives for an order, read when the process starts (it may be read from storage), reaches the process with the owner's decisions it keeps through compaction (card C07q)", async () => {
  const seen: ToChild[] = [];
  const played = playedProcess(seen);
  const keep = { note: "The owner's decisions for this task.", lines: ['dec-aaaaaaaaaaaaaaaaaaaa: "[AUTHORITATIVE] Only raised beds"'] };
  let asked = 0;
  const p = localWorkerParts<unknown>({
    launcher: played.launcher as never, app, protectedPaths: [], workspace: () => work, requireEnforced: false,
    model: () => ({ alias: "m0", provider: "p", api: "openai-completions", modelId: "m", contextWindow: 8192, maxTokens: 256, reasoning: false, input: ["text"] }),
    namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); },
    context: async () => { asked++; await new Promise((ok) => setTimeout(ok, 5)); return { compaction: { fallback: "extractive", keep } }; },
  });
  const session = await p.sandbox.open(order([]).recipe, order([]));
  const runtime = await p.runtimes.open(order([]), {}, undefined);
  const start = seen.find((m) => m.t === "start") as Extract<ToChild, { t: "start" }> | undefined;
  assert.deepEqual(start?.start.context, { compaction: { fallback: "extractive", keep } });
  assert.equal(asked, 1, "read once per process start");
  await runtime.close();
  await session.close();
});
const figures = (cachedTokens: number) => ({ backend: "llama-cpp", route: "r", cachedTokens, computedTokens: 3, writtenTokens: 0 });

test("a turn whose process dies after its model calls reports their cache figures with the failure, under the next turn number after the checkpoint's (card H12e)", async () => {
  const played = playedProcess();
  const pending = [figures(40)];
  const p = localWorkerParts<unknown>({
    launcher: played.launcher as never, app, protectedPaths: [], workspace: () => work, requireEnforced: false,
    model: () => ({ alias: "m0", provider: "p", api: "openai-completions", modelId: "m", contextWindow: 8192, maxTokens: 256, reasoning: false, input: ["text"] }),
    namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); },
    cache: () => ({ takeUsage: async () => pending.shift() }),
  });
  const session = await p.sandbox.open(order([]).recipe, order([]));
  const runtime = await p.runtimes.open(order([]), {}, { nn: { turnSeq: 3 } });
  const turn = runtime.run("go", "req-1");
  await played.running;
  played.crash();
  const result = await turn;
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /exit code 1/);
  assert.deepEqual(result.usage, { turnSeq: 4, cache: figures(40) }, "the figures are reported once, under the turn after the checkpoint's");
  assert.equal(pending.length, 0);
  await runtime.close().catch(() => undefined);
  await session.close();
});

test("a turn cut by the host closing its process (a stop, a restart for a recipe change) also reports the figures its model calls produced: a restart that fails ends the attempt with this result, so they would otherwise never be taken (card H12e)", async () => {
  const played = playedProcess();
  const pending = [figures(25)];
  const p = localWorkerParts<unknown>({
    launcher: played.launcher as never, app, protectedPaths: [], workspace: () => work, requireEnforced: false,
    model: () => ({ alias: "m0", provider: "p", api: "openai-completions", modelId: "m", contextWindow: 8192, maxTokens: 256, reasoning: false, input: ["text"] }),
    namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); },
    cache: () => ({ takeUsage: async () => pending.shift() }),
  });
  const session = await p.sandbox.open(order([]).recipe, order([]));
  const runtime = await p.runtimes.open(order([]), {}, undefined);
  const turn = runtime.run("go", "req-1");
  await played.running;
  await runtime.close();
  const result = await turn;
  assert.equal(result.status, "failed");
  assert.deepEqual(result.usage, { turnSeq: 1, cache: figures(25) }, "taken from the attempt's cache and reported, not left behind");
  await session.close();
});

// Card L02d: what a sandbox still holds, from its worker process's run tree, and what winding it down cost.
/** A launcher whose run the test plays: ready at the start; `tree` is the run's process list; it obeys `close` and the kill only while `obeys` is true. */
function heldProcess() {
  let finish!: (r: RunResult) => void;
  const result = new Promise<RunResult>((ok) => { finish = ok; });
  const state = { obeys: true, ended: false, kills: 0, tree: [] as RunProcess[], survivors: [] as RunProcess[], cannotList: false };
  const exit = () => { if (state.ended) return; state.ended = true; finish({ exitCode: null, signal: null, timedOut: false, killed: true, stdout: "", stderr: "", truncated: false, stdoutTruncated: false, durationMs: 1 }); };
  let emit!: (m: FromChild) => void;
  const run = {
    result, endInput: () => undefined,
    kill: () => { state.kills++; if (state.obeys) { exit(); state.survivors = []; } },
    write: async (text: string) => {
      for (const m of text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ToChild)) {
        if (m.t === "start") queueMicrotask(() => emit({ t: "ready", v: WORKER_CHANNEL_VERSION }));
        if (m.t === "close" && state.obeys) exit();
      }
    },
    processes: async () => (state.cannotList ? undefined : { processes: state.ended ? state.survivors : state.tree, truncated: false }),
  } as unknown as SandboxRun;
  const launcher = { launch: async (request: LaunchRequest) => { emit = (m) => request.stream!.onStdout(Buffer.from(encodeMessage(m))); return run; } };
  return { launcher, state };
}
const heldParts = (launcher: unknown) => localWorkerParts<unknown>({
  launcher: launcher as never, app, protectedPaths: [], workspace: () => work, requireEnforced: false,
  model: () => ({ alias: "m0", provider: "p", api: "openai-completions", modelId: "m", contextWindow: 8192, maxTokens: 256, reasoning: false, input: ["text"] }),
  namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); },
});
const proc = (pid: number, parent: number, name: string): RunProcess => ({ pid, parent, name, started: String(pid) });
const TREE = [proc(10, 1, "bwrap"), proc(11, 10, "bwrap"), proc(12, 11, "node"), proc(20, 12, "server")];

test("L02d: a running sandbox lists what the agent started but not its own worker process; once asked to end it lists the worker until it has gone, and the time it took is the cleanup's compute", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 50_000 });
  t.mock.method(performance, "now", () => Date.now());
  const played = heldProcess();
  played.state.tree = TREE;
  const p = heldParts(played.launcher);
  const session = await p.sandbox.open(order([]).recipe, order([]));
  assert.deepEqual(await session.work(), { processes: [] }, "nothing launched yet");
  await p.runtimes.open(order([]), {}, undefined);
  assert.deepEqual(await session.work(), { processes: [{ ref: "pid 20 \"server\"", kind: "process", state: "running" }] }, "the worker process is the attempt itself; the server the agent started is listed");
  // The process ignores the close: within the grace it is still ending (running), after it it did not obey (uncooperative), and the close gives up instead of waiting for ever.
  played.state.obeys = false;
  const closing = session.close();
  closing.catch(() => undefined);
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(1000);
  assert.deepEqual((await session.work()).processes.map((x) => [x.ref, x.state]), [["worker process pid 12 \"node\"", "running"], ["pid 20 \"server\"", "running"]]);
  assert.equal((await session.work()).computeMs, 1000);
  t.mock.timers.tick(PROCESS_LIMITS.closeGraceMs + PROCESS_LIMITS.killWaitMs);
  await assert.rejects(closing, /did not end/, "the close says the process is still there");
  const stuck = await session.work();
  assert.deepEqual(stuck.processes.map((x) => [x.ref, x.state]), [["worker process pid 12 \"node\"", "uncooperative"], ["pid 20 \"server\"", "uncooperative"]]);
  assert.equal(stuck.computeMs, 1000 + PROCESS_LIMITS.closeGraceMs + PROCESS_LIMITS.killWaitMs);
  // Force Stop kills it again; a process that left something behind when its run ended still lists that as having outlived it.
  played.state.obeys = true;
  const kills = played.state.kills;
  await session.end();
  assert.ok(played.state.kills > kills, "Force Stop killed again");
  await new Promise((r) => setImmediate(r));
  const after = await session.work();
  assert.deepEqual(after.processes, []);
  const total = after.computeMs;
  t.mock.timers.tick(10_000);
  assert.equal((await session.work()).computeMs, total, "an ended process costs nothing more");
});

test("L02d: a process that outlived its run is uncooperative; a system that cannot list processes names only the worker once it was asked to end; a winding down of 0 ms charges nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 50_000 });
  t.mock.method(performance, "now", () => Date.now());
  const played = heldProcess();
  played.state.tree = TREE;
  const p = heldParts(played.launcher);
  const session = await p.sandbox.open(order([]).recipe, order([]));
  await p.runtimes.open(order([]), {}, undefined);
  // The run ends at once on the close, but a process the agent started outlived it.
  const closing = session.close();
  await closing;
  played.state.survivors = [proc(30, 1, "daemon")];
  const after = await session.work();
  assert.deepEqual(after.processes, [{ ref: "pid 30 \"daemon\"", kind: "process", state: "uncooperative" }]);
  assert.equal(after.computeMs, undefined, "it ended in 0 ms: no figure");
  // A system with no process list: nothing is claimed about what the agent started, and the worker is named only once asked to end.
  const blind = heldProcess();
  blind.state.cannotList = true;
  blind.state.obeys = false;
  const q = heldParts(blind.launcher);
  const s2 = await q.sandbox.open(order([]).recipe, order([]));
  await q.runtimes.open(order([]), {}, undefined);
  assert.deepEqual((await s2.work()).processes, []);
  const c2 = s2.close();
  c2.catch(() => undefined);
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(PROCESS_LIMITS.closeGraceMs + 1);
  assert.deepEqual((await s2.work()).processes, [{ ref: "worker process (asked to end)", kind: "process", state: "uncooperative" }]);
  t.mock.timers.tick(PROCESS_LIMITS.killWaitMs);
  await assert.rejects(c2, /did not end/);
  blind.state.obeys = true;
  await s2.end();
});

test("L02d review: a process name (the program's own choice) is quoted in what the sandbox lists, so it cannot pass for more of the line", async () => {
  const played = heldProcess();
  played.state.tree = [...TREE.slice(0, 3), proc(21, 12, "x): settled. pid 1 (init"), proc(22, 12, "[cut: 1 of 2 entries]"), proc(23, 12, "say \"hi\" \\o/")];
  const p = heldParts(played.launcher);
  const session = await p.sandbox.open(order([]).recipe, order([]));
  await p.runtimes.open(order([]), {}, undefined);
  assert.deepEqual((await session.work()).processes.map((x) => x.ref), ["pid 21 \"x): settled. pid 1 (init\"", "pid 22 \"[cut: 1 of 2 entries]\"", "pid 23 \"say \\\"hi\\\" \\\\o/\""]);
  await session.close();
});

test.after(() => { rmSync(root, { recursive: true, force: true }); void dirname; });

// Card W02: the host carries how a turn ended. A process the test plays answers the start, the run and the checkpoint the host asks for; what its result says (or does not say) is what the host passes on.
function scriptedProcess(result: FromChild, durable?: { verified: boolean; error?: string }) {
  const written: ToChild[] = [];
  const launcher = {
    launch: async (request: LaunchRequest): Promise<SandboxRun> => {
      let finish!: (r: RunResult) => void;
      const ended = new Promise<RunResult>((ok) => { finish = ok; });
      const send = (m: FromChild): void => { setImmediate(() => request.stream!.onStdout(Buffer.from(encodeMessage(m)))); };
      return {
        result: ended, kill: () => finish({ exitCode: null, signal: null, timedOut: false, killed: true, stdout: "", stderr: "", stdoutTruncated: false } as RunResult), endInput: () => undefined,
        write: (text: string) => {
          for (const m of text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ToChild)) {
            written.push(m);
            if (m.t === "start") send({ t: "ready", v: WORKER_CHANNEL_VERSION, toolSchemaChars: 10, systemPromptChars: 0 });
            else if (m.t === "run") send(result);
            else if (m.t === "checkpoint") send({ t: "checkpoint.ok", id: m.id, checkpoint: { n: 1 }, contextTokens: 5, ...(durable === undefined ? {} : { durable }) });
            else if (m.t === "close") finish({ exitCode: 0, signal: null, timedOut: false, killed: false, stdout: "", stderr: "", stdoutTruncated: false } as RunResult);
          }
          return Promise.resolve();
        },
      } as unknown as SandboxRun;
    },
  };
  return { launcher, written };
}

test("every turn result from the host carries an end kind: the process's own, unknown when an older process says none, and unknown for a turn that failed (card W02)", async () => {
  const run = async (result: FromChild) => {
    const f = scriptedProcess(result);
    const p = localWorkerParts<unknown>({
      launcher: f.launcher as never, app, protectedPaths: [], workspace: () => work, requireEnforced: false,
      model: () => ({ alias: "m0", provider: "p", api: "openai-completions", modelId: "m", contextWindow: 8192, maxTokens: 256, reasoning: false, input: ["text"] }),
      namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); },
    });
    const o = order([]);
    const session = await p.sandbox.open(o.recipe, o);
    try {
      const runtime = await p.runtimes.open(o, {}, undefined);
      const out = await runtime.run("go", "req-1");
      await runtime.close();
      return out;
    } finally { await session.close(); }
  };
  const classified = await run({ t: "result", status: "completed", text: "Now let me run the tests:", endKind: "announced-step-without-tool-call", visibleChars: 25 });
  assert.equal(classified.endKind, "announced-step-without-tool-call");
  assert.equal(classified.visibleChars, 25);
  assert.equal(classified.text, "Now let me run the tests:");
  const older = await run({ t: "result", status: "completed", text: "all done" });
  assert.equal(older.endKind, "unknown", "a worker from before W02 says nothing: unknown, never normal");
  assert.equal(older.visibleChars, undefined);
  // A line from a newer worker with a kind this host does not know is read as unknown too (the channel leaves it out).
  const newer = await run({ t: "result", status: "completed", text: "x", endKind: "some-new-kind" as never });
  assert.equal(newer.endKind, "unknown");
  const failed = await run({ t: "result", status: "failed", error: "the model did not answer" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.endKind, "unknown");
  // Card W04: the nudges the process gave the turn are passed on, for a failed turn too; an older process says none and none is claimed.
  const nudged = await run({ t: "result", status: "completed", text: "", endKind: "empty-visible-text", visibleChars: 0, nudges: 3 });
  assert.equal(nudged.nudges, 3);
  assert.equal((await run({ t: "result", status: "failed", error: "x", nudges: 1 })).nudges, 1);
  assert.equal(older.nudges, undefined);
});

test("the process's read-back check of a checkpoint goes on the checkpoint the host hands the controller; a process that ran none hands none (card L04d)", async () => {
  const run = async (durable?: { verified: boolean; error?: string }) => {
    const f = scriptedProcess({ t: "result", status: "completed", text: "done", endKind: "normal", visibleChars: 4 }, durable);
    const p = localWorkerParts<unknown>({
      launcher: f.launcher as never, app, protectedPaths: [], workspace: () => work, requireEnforced: false,
      model: () => ({ alias: "m0", provider: "p", api: "openai-completions", modelId: "m", contextWindow: 8192, maxTokens: 256, reasoning: false, input: ["text"] }),
      namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); },
    });
    const o = order([]);
    const session = await p.sandbox.open(o.recipe, o);
    try {
      const runtime = await p.runtimes.open(o, {}, undefined);
      const out = await runtime.run("go", "req-1");
      const asked = await runtime.checkpoint();
      await runtime.close();
      return { turn: out.checkpoint as { nn: Record<string, unknown> } | undefined, asked: asked as { nn: Record<string, unknown> } };
    } finally { await session.close(); }
  };
  const verified = await run({ verified: true });
  assert.deepEqual(verified.turn?.nn["durable"], { verified: true }, "the turn's checkpoint says it was read back");
  assert.deepEqual(verified.asked.nn["durable"], { verified: true }, "and so does one asked for");
  const failed = await run({ verified: false, error: "the checkpoint did not read back: history_changed" });
  assert.deepEqual(failed.turn?.nn["durable"], { verified: false, error: "the checkpoint did not read back: history_changed" });
  const none = await run();
  assert.equal(none.turn?.nn["durable"], undefined, "nothing is said for a process that did not check");
});

test("C07q: ownerPolicyOptions connects the controller's compaction record to the host, and leaves it out when the controller gave none", async () => {
  const seen: unknown[] = [];
  const base = { currentLimits: async () => undefined, bestEffortAllowed: async () => false, recordLaunch: async () => undefined };
  const note = { messageCount: 4, summaryChars: 50, digest: "e".repeat(64) };
  const order = { attemptId: "att-1" } as never;
  const withRecord = ownerPolicyOptions({ ...base, recordCompaction: async (o, n) => { seen.push([o, n]); } });
  await withRecord.onCompaction!(order, note);
  assert.deepEqual(seen, [[order, note]]);
  assert.equal(ownerPolicyOptions(base).onCompaction, undefined);
});

test("U09b: ownerPolicyOptions connects the controller's thinking record to the host, and leaves it out when the controller gave none", async () => {
  const seen: unknown[] = [];
  const base = { currentLimits: async () => undefined, bestEffortAllowed: async () => false, recordLaunch: async () => undefined };
  const blocks = [{ entryId: 1, block: 0, provider: "p", model: "m", text: "t", opaque: false }];
  const order = { attemptId: "att-1" } as never;
  const withRecord = ownerPolicyOptions({ ...base, recordThinking: async (o, b) => { seen.push([o, b]); } });
  await withRecord.onThinking!(order, blocks);
  assert.deepEqual(seen, [[order, blocks]]);
  assert.equal(ownerPolicyOptions(base).onThinking, undefined);
});

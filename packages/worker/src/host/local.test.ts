import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { WORKER_CHANNEL_VERSION, encodeMessage, type FromChild, type ToChild } from "@nimblenewt/contracts";
import type { LaunchRequest, RunResult, SandboxRun } from "../sandbox/launcher.js";
import { estimateStoredTokens, localWorkerParts, recoveryFor, type HostOrder } from "./local.js";

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
function playedProcess() {
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
        if (m.t === "start") queueMicrotask(() => emit({ t: "ready", v: WORKER_CHANNEL_VERSION }));
        if (m.t === "run") turnStarted();
        if (m.t === "close") exit();
      }
    },
  } as unknown as SandboxRun;
  const launcher = { launch: async (request: LaunchRequest) => { emit = (m) => request.stream!.onStdout(Buffer.from(encodeMessage(m))); return run; } };
  return { launcher, running, crash: () => exit({ exitCode: 1, stderr: "killed" }) };
}
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

test.after(() => { rmSync(root, { recursive: true, force: true }); void dirname; });

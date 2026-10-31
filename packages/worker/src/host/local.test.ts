import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { localWorkerParts, type HostOrder } from "./local.js";

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
  await assert.rejects(evil.sandbox.open(order(["x"]).recipe, order(["x"])), /system directory|cannot be mounted/);
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

test.after(() => { rmSync(root, { recursive: true, force: true }); void dirname; });

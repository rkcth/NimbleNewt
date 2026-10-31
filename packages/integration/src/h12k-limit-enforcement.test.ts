import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { startController } from "@nimblenewt/controller";
import { SandboxError, SandboxLauncher, limitedPlan, localWorkerParts, ownerPolicyOptions, strictestLimits, type LaunchEnforcement, type LimitCapabilities } from "@nimblenewt/worker";
import type { HostOrder, LaunchRequest, RunResult, SandboxRun } from "@nimblenewt/worker";

// Card H12k (limits): the owner's limits for local agents reach the sandbox launch, a launch whose limits this OS cannot enforce in full is refused unless the owner allowed best effort, and every launch is recorded.
// The host is built through startController (the services it hands to `build`), the recipe is built for real (attemptSandbox, normalizeRecipe) and the translation of limits is the real `limitedPlan`; only the process start is faked.

const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const supported = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" } as never;
const ext4 = (async () => ({ type: "ext4", network: false })) as never;
/** No user systemd: memory and cpus are partial, processes cannot be enforced, disk is partial. */
const CAPS: LimitCapabilities = { platform: "linux", cgroupScope: false, escapeDollar: false, prlimit: true, taskset: true, passEnv: {} };
const timer = { schedule: () => () => undefined } as never;

type Call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => Promise<{ ok: boolean; result?: any; error?: { code: string; message?: string } }>;

async function rig(options: { onLaunchFails?: boolean; hang?: boolean; workspaceLimits?: Record<string, number> } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nn h12kl ")));
  const dirs = { checkout: join(dir, "checkout"), gitDir: join(dir, "git"), home: join(dir, "home"), scratch: join(dir, "scratch") };
  for (const d of Object.values(dirs)) mkdirSync(d);
  const requests: LaunchRequest[] = [];
  const killed: string[] = [];
  const launcher = {
    // Behaves as the real launcher does after its checks: the limits are translated by the real `limitedPlan` and a limit not enforced in full is refused when asked to be.
    launch: async (request: LaunchRequest): Promise<SandboxRun> => {
      const report = limitedPlan({ file: request.command[0]!, args: [], env: {} } as never, request.limits ?? {}, CAPS).report;
      if (request.requireEnforced === true) {
        const weak = report.filter((r) => r.enforced !== "full");
        if (weak.length > 0) throw new SandboxError("unavailable", `these limits cannot be fully enforced on this host: ${weak.map((r) => `${r.limit} (${r.detail})`).join("; ")}`, { limitFailures: weak.map((r) => ({ limit: r.limit, enforced: r.enforced as "partial" | "none", detail: r.detail })) });
      }
      requests.push(request);
      const result: RunResult = { exitCode: 1, signal: null, timedOut: false, killed: false, stdout: "", stderr: "fake: no process", truncated: false, stdoutTruncated: false, durationMs: 1 };
      let end!: (r: RunResult) => void;
      const pending = new Promise<RunResult>((resolve) => { end = resolve; });
      return { runId: `run-${requests.length}`, mode: "sandboxed", recipeRevision: "r", guest: {} as never, enforcement: report, kill: () => { killed.push(`run-${requests.length}`); end(result); }, write: async () => undefined, endInput: () => undefined, result: options.hang === true ? pending : Promise.resolve(result) } as SandboxRun;
    },
  };
  const launches: LaunchEnforcement[] = [];
  let parts: ReturnType<typeof localWorkerParts<unknown>> | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    dispatch: { timer, manual: true, local: { window: () => 8192, close: async () => undefined, build: (s: any) => {
      parts = localWorkerParts<unknown>({
        launcher: launcher as never, app: { node: { root: nodeRoot, executable: "bin/node" }, mounts: [], entry: "/opt/app/main.js" }, protectedPaths: [],
        workspace: () => ({ ...dirs, ...(options.workspaceLimits === undefined ? {} : { limits: options.workspaceLimits }) }),
        model: () => ({ alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
        namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: true, result: {} }), relay: async () => { throw new Error("not used"); },
        limits: () => s.currentLimits(), bestEffort: () => s.bestEffortAllowed(),
        onLaunch: async (record) => { launches.push(record); if (options.onLaunchFails === true) throw new Error("record store down"); await s.recordLaunch(record); },
      });
      return { hostId: "host:w1", ownerPolicy: parts.ownerPolicy } as never;
    } } },
  } as never);
  const owner = await c.services.principals.bootstrapOwner({ name: "rob" });
  const call: Call = (token, op, args, commandId) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
  let n = 0;
  const order = (): HostOrder => ({ attemptId: `att-${++n}`, agentId: "agent:ann", route: "llama/local", credential: "task-credential-1", recipe: { revision: "r1", reach: [] }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  /** One attempt: reserve the sandbox, then open the runtime. The fake process ends at once, so a launch that was allowed fails after the launcher call; one that was refused fails before. */
  const attempt = async (o: HostOrder = order()): Promise<{ order: HostOrder; error?: Error }> => {
    const session = await parts!.sandbox.open(o.recipe, o);
    try { await parts!.runtimes.open(o, {} as never, undefined); return { order: o }; } catch (error) { return { order: o, error: error as Error }; } finally { await session.close(); }
  };
  return { c, call, token: owner.token, attempt, requests, launches, killed, order, dir, done: async () => { await c.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}

test("nothing configured: the process is launched with no limits and the default is to require full enforcement; the launch is recorded", async () => {
  const t = await rig();
  try {
    const { order } = await t.attempt();
    assert.equal(t.requests.length, 1);
    assert.equal(t.requests[0]!.limits, undefined);
    assert.equal(t.requests[0]!.requireEnforced, true);
    assert.equal(t.requests[0]!.timeoutMs > 3_000_000, true, "the wall-clock limit is the attempt's remaining time");
    assert.equal(t.launches[0]!.outcome, "started");
    const item = (await t.call(t.token, "workers.limits.enforced", { attemptId: order.attemptId })).result.item;
    assert.equal(item.count, 1);
    assert.equal(item.launches[0].outcome, "started");
    assert.equal(item.launches[0].bestEffort, false);
    assert.ok(item.launches[0].wallTimeMs > 3_000_000);
  } finally { await t.done(); }
});

test("limits the OS cannot enforce in full refuse the launch (nothing is started) and the refusal is recorded with the reason", async () => {
  const t = await rig();
  try {
    assert.ok((await t.call(t.token, "workers.limits.set", { limits: { memoryMb: 512, diskMb: 100, processes: 50 } }, "s1")).ok);
    const { order, error } = await t.attempt();
    assert.match(String(error?.message), /cannot be fully enforced/);
    assert.match(String(error?.message), /processes/);
    assert.equal(t.requests.length, 0, "no process was started");
    assert.equal(t.launches[0]!.outcome, "refused");
    const item = (await t.call(t.token, "workers.limits.enforced", { attemptId: order.attemptId })).result.item;
    assert.equal(item.launches[0].outcome, "refused");
    assert.deepEqual(item.launches[0].requested, { memoryMb: 512, diskMb: 100, processes: 50 });
    assert.match(item.launches[0].reason, /processes/);
    assert.deepEqual(item.launches[0].failed.map((f: any) => [f.limit, f.enforced]).sort(), [["diskMb", "partial"], ["memoryMb", "partial"], ["processes", "none"]], "the record names which limits failed, in a field of its own");
  } finally { await t.done(); }
});

test("best effort (owner, chat-settable) lets the weak ones through and the record says which were not full; disabling refuses again; limit changes keep the switch", async () => {
  const t = await rig();
  try {
    // cpus is only pinned to cores (partial) and processes cannot be enforced without a user systemd scope, so strict refuses both; with the switch on it starts and the record says which one was not enforced.
    assert.ok((await t.call(t.token, "workers.limits.set", { limits: { cpus: 2, processes: 10 } }, "s1")).ok);
    assert.ok((await t.attempt()).error?.message.includes("cannot be fully enforced"));
    const rev = (await t.call(t.token, "workers.limits.get", {})).result.item.revision;
    const on = await t.call(t.token, "workers.limits.besteffort", { enabled: true, expectedRevision: rev }, "b1");
    assert.ok(on.ok, JSON.stringify(on));
    assert.equal((await t.call(t.token, "workers.limits.get", {})).result.item.bestEffort, true);
    const ok = await t.attempt();
    assert.equal(t.requests.length, 1, "the process was launched");
    assert.equal(t.requests[0]!.requireEnforced, false);
    assert.deepEqual(t.requests[0]!.limits, { cpus: 2, processes: 10 });
    const rec = (await t.call(t.token, "workers.limits.enforced", { attemptId: ok.order.attemptId })).result.item.launches[0];
    assert.equal(rec.outcome, "started");
    assert.equal(rec.bestEffort, true);
    const byLimit = Object.fromEntries(rec.enforcement.map((e: any) => [e.limit, e.enforced]));
    assert.deepEqual(byLimit, { cpus: "partial", processes: "none" }, "what was not enforced in full is recorded, not hidden: a core pin is partial, an unprivileged process can widen it");
    // Changing figures does not switch best effort off.
    assert.ok((await t.call(t.token, "workers.limits.change", { set: { memoryMb: 256 } }, "c1")).ok);
    assert.ok((await t.call(t.token, "workers.limits.set", { limits: { cpus: 2, processes: 10 } }, "s2")).ok);
    assert.equal((await t.call(t.token, "workers.limits.get", {})).result.item.bestEffort, true);
    // Off again: refused from the next launch.
    assert.ok((await t.call(t.token, "workers.limits.besteffort", { enabled: false }, "b2")).ok);
    assert.ok((await t.attempt()).error?.message.includes("cannot be fully enforced"));
    assert.equal(t.requests.length, 1);
  } finally { await t.done(); }
});

test("the best-effort switch is owner only, needs a boolean, races are caught by expectedRevision, a replay applies once", async () => {
  const t = await rig();
  try {
    await t.c.services.principals.enroll(await t.c.services.principals.authenticate(t.token), { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [] });
    const ann = (await t.c.services.principals.issueCredential(await t.c.services.principals.authenticate(t.token), "agent:agt-abcdefghijklmnopqrst")).token;
    assert.equal((await t.call(ann, "workers.limits.besteffort", { enabled: true }, "a1")).error?.code, "forbidden");
    assert.equal((await t.call(ann, "workers.limits.enforced", { attemptId: "att-1" })).error?.code, "forbidden");
    for (const bad of [{}, { enabled: "yes" }, { enabled: 1 }, { enabled: true, expectedRevision: -1 }, { enabled: true, extra: 1 }]) {
      assert.equal((await t.call(t.token, "workers.limits.besteffort", bad, `bad-${JSON.stringify(bad)}`)).error?.code, "invalid_command", JSON.stringify(bad));
    }
    assert.equal((await t.call(t.token, "workers.limits.besteffort", { enabled: true, expectedRevision: 5 }, "r1")).error?.code, "stale_revision");
    assert.equal((await t.call(t.token, "workers.limits.get", {})).result.item.bestEffort, false, "refused commands changed nothing");
    const a = await t.call(t.token, "workers.limits.besteffort", { enabled: true, expectedRevision: 0 }, "same");
    const b = await t.call(t.token, "workers.limits.besteffort", { enabled: true, expectedRevision: 0 }, "same");
    assert.ok(a.ok && b.ok);
    assert.equal(a.result.revision, b.result.revision, "the replay applies once");
    assert.equal((await t.call(t.token, "workers.limits.besteffort", { enabled: false }, "same")).ok, false, "reusing a command id for another request is refused");
  } finally { await t.done(); }
});

test("when the setting cannot be read the launch is refused, not made unlimited or strict-by-guess", async () => {
  const t = await rig();
  try {
    assert.ok((await t.call(t.token, "workers.limits.set", { limits: { memoryMb: 512 } }, "s1")).ok);
    const storage = t.c.storage as unknown as { getAggregate: (ref: { kind: string; id: string }) => Promise<unknown> };
    const real = storage.getAggregate.bind(storage);
    storage.getAggregate = async (ref) => { if (ref.kind === "worker-limits-settings") throw new Error("disk gone"); return real(ref); };
    const { error } = await t.attempt();
    assert.ok(error !== undefined);
    assert.equal(t.requests.length, 0, "no process was started");
    assert.equal(t.launches.length, 1, "the refusal is reported to the record, not only thrown");
    assert.equal(t.launches[0]!.outcome, "refused");
    assert.match(String(t.launches[0]!.reason), /disk gone/);
    // A damaged best-effort flag is refused too.
    storage.getAggregate = async (ref) => { const a = await real(ref) as any; return ref.kind === "worker-limits-settings" && a !== undefined ? { ...a, body: { ...a.body, bestEffort: "yes" } } : a; };
    assert.ok((await t.attempt()).error !== undefined);
    assert.equal(t.requests.length, 0);
    storage.getAggregate = real;
  } finally { await t.done(); }
});

test("the workspace's own limits and the owner's combine by the smaller figure", async () => {
  const t = await rig({ workspaceLimits: { memoryMb: 100, cpus: 8 } });
  try {
    assert.ok((await t.call(t.token, "workers.limits.besteffort", { enabled: true }, "b1")).ok);
    assert.ok((await t.call(t.token, "workers.limits.set", { limits: { memoryMb: 512, cpus: 2, processes: 9 } }, "s1")).ok);
    await t.attempt();
    assert.deepEqual(t.requests[0]!.limits, { cpus: 2, memoryMb: 100, processes: 9 });
  } finally { await t.done(); }
  assert.deepEqual(strictestLimits({ memoryMb: 5 }, undefined), { memoryMb: 5 });
  assert.equal(strictestLimits(undefined, undefined), undefined);
});

test("a launch that cannot be recorded does not run: the process is ended", async () => {
  const t = await rig({ onLaunchFails: true, hang: true });
  try {
    assert.ok((await t.call(t.token, "workers.limits.besteffort", { enabled: true }, "b1")).ok);
    const { error } = await t.attempt();
    assert.match(String(error?.message), /record store down/);
    assert.equal(t.killed.length, 1, "the started process was killed");
  } finally { await t.done(); }
});

test("the real launcher refuses a disk limit it cannot enforce in full, before anything starts, and the host records it", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nn h12kr ")));
  try {
    const dirs = { checkout: join(dir, "checkout"), gitDir: join(dir, "git"), home: join(dir, "home"), scratch: join(dir, "scratch") };
    for (const d of Object.values(dirs)) mkdirSync(d);
    const real = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
    // Without a confined launch the refusal would be a different one ("no confined launch is possible"): this test is about the limit.
    if (!real.capacity.available) return t.skip(`no confined launch on this machine: ${real.capacity.reason}`);
    const records: LaunchEnforcement[] = [];
    const parts = localWorkerParts<unknown>({
      launcher: real, app: { node: { root: nodeRoot, executable: "bin/node" }, mounts: [], entry: "/opt/app/main.js" }, protectedPaths: [],
      workspace: () => dirs, limits: () => ({ diskMb: 10 }), bestEffort: () => false, onLaunch: (r) => { records.push(r); },
      model: () => ({ alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
      namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: true, result: {} }), relay: async () => { throw new Error("not used"); },
    });
    const order: HostOrder = { attemptId: "att-r", agentId: "agent:ann", route: "llama/local", credential: "c", recipe: { revision: "r1", reach: [] }, expiresAt: new Date(Date.now() + 600_000).toISOString() };
    const session = await parts.sandbox.open(order.recipe, order);
    await assert.rejects(parts.runtimes.open(order, {} as never, undefined), SandboxError);
    await session.close();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.outcome, "refused");
    assert.deepEqual(records[0]!.requested, { diskMb: 10 });
    assert.match(records[0]!.reason ?? "", /these limits cannot be fully enforced on this host: diskMb \(/, "refused for the disk limit specifically");
    assert.deepEqual(records[0]!.failed?.map((f) => f.limit), ["diskMb"]);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("an owner-set wallTimeMs ends the process at that time (optional, off by default) and the record shows it", async () => {
  const t = await rig();
  try {
    assert.ok((await t.call(t.token, "workers.limits.besteffort", { enabled: true }, "b1")).ok);
    await t.attempt();
    assert.ok(t.requests[0]!.timeoutMs > 3_000_000, "no wall-clock limit set: the attempt's remaining time");
    assert.ok((await t.call(t.token, "workers.limits.change", { set: { wallTimeMs: 5000 } }, "w1")).ok);
    assert.equal((await t.call(t.token, "workers.limits.set", { limits: { wallTimeMs: 10 } }, "w2")).error?.code, "invalid_command", "below the smallest allowed");
    const run = await t.attempt();
    assert.equal(t.requests[1]!.timeoutMs, 5000);
    assert.equal(t.requests[1]!.limits, undefined, "the time limit is the launcher's timeout, not a process limit");
    const rec = (await t.call(t.token, "workers.limits.enforced", { attemptId: run.order.attemptId })).result.item.launches[0];
    assert.equal(rec.wallTimeMs, 5000);
    assert.deepEqual(rec.enforcement.map((e: any) => [e.limit, e.enforced, e.by]), [["wallTimeMs", "full", "launcher time limit"]]);
    assert.ok((await t.call(t.token, "workers.limits.change", { unset: ["wallTimeMs"] }, "w3")).ok);
    await t.attempt();
    assert.ok(t.requests[2]!.timeoutMs > 3_000_000, "cleared: off again");
  } finally { await t.done(); }
});

test("the record says why a figure is not the one the owner set when the host's own start-up figure is stricter", async () => {
  const t = await rig({ workspaceLimits: { memoryMb: 100 } });
  try {
    assert.ok((await t.call(t.token, "workers.limits.besteffort", { enabled: true }, "b1")).ok);
    assert.ok((await t.call(t.token, "workers.limits.set", { limits: { memoryMb: 4096 } }, "s1")).ok);
    const run = await t.attempt();
    assert.deepEqual(t.requests[0]!.limits, { memoryMb: 100 });
    const rec = (await t.call(t.token, "workers.limits.enforced", { attemptId: run.order.attemptId })).result.item.launches[0];
    assert.deepEqual(rec.stricter.map((x: any) => [x.limit, x.owner, x.applied]), [["memoryMb", 4096, 100]]);
    assert.match(rec.stricter[0].why, /stricter than the 4096 you set/);
  } finally { await t.done(); }
});

test("a host built with the controller's policy services through ownerPolicyOptions is accepted and enforces the owner's limits; one that ignores them is refused at start", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nn h12ko ")));
  const base = (build: (s: any) => unknown) => ({ storage: { kind: "sqlite", path: join(dir, `${Math.random()}.sqlite`) }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer, manual: true, local: { window: () => 8192, close: async () => undefined, build } } }) as never;
  try {
    // Ignoring the policy: refused by startController.
    const ignoring = await startController(base(() => ({ hostId: "host:w1" })));
    assert.equal(ignoring.dispatch, undefined, "no dispatcher runs agents unlimited");
    assert.match(String(ignoring.dispatchProblem), /does not apply the owner's limits/);
    await ignoring.close();
    // Through the helper: accepted.
    const records: LaunchEnforcement[] = [];
    const c = await startController(base((s: any) => {
      const parts = localWorkerParts<unknown>({
        launcher: { launch: async () => { throw new Error("not reached"); } } as never, app: { node: { root: nodeRoot, executable: "bin/node" }, mounts: [], entry: "/opt/app/main.js" }, protectedPaths: [],
        workspace: () => ({ checkout: join(dir, "c"), gitDir: join(dir, "g"), home: join(dir, "h"), scratch: join(dir, "s") }),
        model: () => ({ alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] }),
        namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: true, result: {} }), relay: async () => { throw new Error("not used"); },
        ...ownerPolicyOptions({ ...s, recordLaunch: async (r: LaunchEnforcement) => { records.push(r); await s.recordLaunch(r); } }),
      });
      assert.equal(parts.ownerPolicy, true);
      return { hostId: "host:w1", ownerPolicy: parts.ownerPolicy };
    }));
    await c.close();
    // A host that connected only some of the three does not claim the policy.
    const partial = localWorkerParts<unknown>({ launcher: {} as never, app: { node: { root: nodeRoot, executable: "bin/node" }, mounts: [], entry: "/x" }, protectedPaths: [], workspace: () => ({} as never), model: () => ({} as never), namespaceId: () => "x", bridge: async () => ({ ok: true, result: {} }), relay: async () => { throw new Error("n"); }, limits: () => undefined });
    assert.equal(partial.ownerPolicy, false);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

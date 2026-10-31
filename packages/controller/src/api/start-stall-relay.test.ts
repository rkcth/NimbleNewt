import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ModelRelay } from "../dispatch/relay.js";
import type { WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a model call the relay carries is reported to stall detection by the controller: the size of the prompt while it reads, the first output and the end of the call (card V01b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-stallrelay-"));
  const problems: unknown[] = [];
  let services: Parameters<Parameters<NonNullable<NonNullable<Parameters<typeof startController>[0]["dispatch"]>["local"]>["build"]>[0] extends infer S ? (s: S) => void : never>[0] | undefined;
  const hold: { release?: () => void; first?: () => void } = {};
  const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({
    async start(c) {
      // The model reads for a while, then writes for a while, so the call tells the route's speed.
      await new Promise<void>((resolve) => { hold.first = resolve; });
      c.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n"));
      await new Promise<void>((resolve) => { hold.release = resolve; });
      c.enqueue(new TextEncoder().encode("data: {\"usage\":{\"prompt_tokens\":9000,\"completion_tokens\":50}}\n\n"));
      c.close();
    },
  }), { status: 200 });
  const relay = new ModelRelay({ endpoint: (route) => (route === "llama/local" ? { url: "http://llama.internal:8080/v1/" } : undefined), fetch });
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    onInternalError: (e) => { problems.push(e); },
    dispatch: { timer: new ManualTimer(), manual: true, local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined, build: (s) => { services = s as never; return { hostId: "host:w1" } as unknown as WorkerHost; } } },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const rob = await c.services.principals.authenticate((await c.services.principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Build" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    const ann = { kind: "agent", id: "ann" } as const;
    await c.services.assignments.assignTask({ commandId: "as", actor: rob.id, taskId: task, owner: ann });
    const a = (await c.services.assignments.getAssignment(task))!;
    await c.services.assignments.admitAttempt({ commandId: "ad", actor: rob.id, taskId: task, expectedRevision: a.revision, generation: a.generation, owner: ann, harness: "pi" });
    const t = (await c.services.projects.getTask(task))!;
    await c.services.projects.transitionTask({ commandId: "ip", actor: rob.id, taskId: task, expectedRevision: t.revision, to: "in_progress" });
    const live = (await c.services.assignments.getAssignment(task))!.activeAttemptId!;
    const order = { attemptId: live, taskId: task, projectId: project, agentId: "ann", generation: a.generation, route: "llama/local", expiresAt: "2999-01-01T00:00:00.000Z" };
    const attempt = services!.attemptRelay(order as never, relay);
    const body = Buffer.from(JSON.stringify({ model: "x", messages: [{ role: "user", content: "x".repeat(30_000) }] }));
    const response = await attempt.relay({ url: `${attempt.relayBase}/${attempt.alias}/chat/completions`, method: "POST", headers: [["content-type", "application/json"]], body, signal: new AbortController().signal } as never);
    const reader = (async () => { let n = 0; for await (const _ of response.body ?? []) n++; return n; })();
    const evidence = async () => c.services.stall.evidence(rob, task);
    const until = async (ok: () => Promise<boolean>): Promise<void> => { for (let i = 0; i < 200 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(await ok(), `reported in time: ${ok.toString().slice(0, 90)}`); };
    // While the model is still reading: the prompt's size (the body over 3 characters a token, rounded up) and the route.
    await until(async () => (await evidence())?.request !== undefined);
    const open = (await evidence())!.request!;
    assert.equal(open.firstOutputAt, undefined);
    assert.equal(open.route, "llama/local");
    assert.equal(open.promptTokens, Math.ceil(body.length / 3));
    assert.equal(open.id, `${live}:1`);
    await new Promise((r) => setTimeout(r, 1100));
    await until(async () => hold.first !== undefined);
    hold.first!();
    await until(async () => (await evidence())?.request?.firstOutputAt !== undefined);
    await new Promise((r) => setTimeout(r, 1100));
    await until(async () => hold.release !== undefined);
    hold.release!();
    assert.ok(await reader >= 1);
    await until(async () => (await evidence())?.request === undefined || (await evidence())?.lastRequestMs !== undefined);
    const done = (await evidence())!;
    assert.equal(done.request, undefined, "the call is closed");
    assert.equal(done.reportedBy, "controller", "the relay is the only reporter here");
    // The provider's counts and the two durations made a measurement: 9000 tokens read in a little over a second.
    const speed = (await c.services.stall.speed(rob, "llama/local", "-"))!;
    assert.ok(speed.readTps! > 1000 && speed.readTps! < 9000, `read speed ${speed.readTps}`);
    assert.ok(speed.writeTps! > 5 && speed.writeTps! < 60, `write speed ${speed.writeTps}`);
    assert.deepEqual(problems, []);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a route's declared reading speed in the routing table judges the first call, and the next call is started with the share the cache served on the last one (card V01c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-stallrelay-"));
  const problems: unknown[] = [];
  let services: Parameters<Parameters<NonNullable<NonNullable<Parameters<typeof startController>[0]["dispatch"]>["local"]>["build"]>[0] extends infer S ? (s: S) => void : never>[0] | undefined;
  let calls = 0;
  const hold: { release?: () => void } = {};
  const fetch: typeof globalThis.fetch = async () => {
    const n = ++calls;
    return new Response(new ReadableStream({
      async start(c) {
        if (n === 1) { c.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}],\"usage\":{\"prompt_tokens\":10000,\"completion_tokens\":5,\"prompt_tokens_details\":{\"cached_tokens\":7500}}}\n\n")); c.close(); return; }
        await new Promise<void>((resolve) => { hold.release = resolve; });
        c.close();
      },
    }), { status: 200 });
  };
  const relay = new ModelRelay({ endpoint: (route) => (route === "llama/local" ? { url: "http://llama.internal:8080/v1/" } : undefined), fetch });
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    onInternalError: (e) => { problems.push(e); },
    dispatch: { timer: new ManualTimer(), manual: true, local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined, build: (s) => { services = s as never; return { hostId: "host:w1" } as unknown as WorkerHost; } } },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const rob = await c.services.principals.authenticate((await c.services.principals.bootstrapOwner({ name: "rob" })).token);
    const table = { providers: { llama: { enabled: true, paid: false, location: "local" }, other: { enabled: true, paid: false, location: "local" } }, routes: { "llama/local": { contextTokens: 8192, capabilities: [], readTokensPerSecond: 20 }, "other/backup": { contextTokens: 8192, capabilities: [] } }, profiles: { fast: ["llama/local", "other/backup"] }, roles: { coordinator: "fast", "safety-supervisor": "fast" } };
    await c.services.routing.setTable(rob, { commandId: "tbl", expectedRevision: 0, table } as never);
    await assert.rejects(() => c.services.routing.setTable(rob, { commandId: "tbl2", expectedRevision: 1, table: { ...table, routes: { "llama/local": { contextTokens: 8192, capabilities: [], readTokensPerSecond: 0 } } } } as never), /readTokensPerSecond/);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Build" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    const ann = { kind: "agent", id: "ann" } as const;
    await c.services.assignments.assignTask({ commandId: "as", actor: rob.id, taskId: task, owner: ann });
    const a = (await c.services.assignments.getAssignment(task))!;
    await c.services.assignments.admitAttempt({ commandId: "ad", actor: rob.id, taskId: task, expectedRevision: a.revision, generation: a.generation, owner: ann, harness: "pi" });
    const t = (await c.services.projects.getTask(task))!;
    await c.services.projects.transitionTask({ commandId: "ip", actor: rob.id, taskId: task, expectedRevision: t.revision, to: "in_progress" });
    const live = (await c.services.assignments.getAssignment(task))!.activeAttemptId!;
    const order = { attemptId: live, taskId: task, projectId: project, agentId: "ann", generation: a.generation, route: "llama/local", expiresAt: "2999-01-01T00:00:00.000Z" };
    const attempt = services!.attemptRelay(order as never, relay);
    const send = async (chars: number) => {
      const response = await attempt.relay({ url: `${attempt.relayBase}/${attempt.alias}/chat/completions`, method: "POST", headers: [["content-type", "application/json"]], body: Buffer.from(JSON.stringify({ model: "x", messages: [{ role: "user", content: "x".repeat(chars) }] })), signal: new AbortController().signal } as never);
      return (async () => { for await (const _ of response.body ?? []) { /* read it all */ } })();
    };
    const until = async (ok: () => Promise<boolean>): Promise<void> => { for (let i = 0; i < 300 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(await ok(), "reported in time"); };
    const evidence = async () => c.services.stall.evidence(rob, task);
    // The first call: the route declares 20 tokens a second, nothing has been measured.
    await send(30_000);
    await until(async () => (await evidence())?.request === undefined && (await evidence())?.lastRequestMs !== undefined);
    // The second call is started with the share the first one's cache served (7500 of 10000), and is judged at the declared speed.
    const second = send(30_000);
    await until(async () => (await evidence())?.request !== undefined);
    const open = (await evidence())!.request!;
    assert.equal(open.cachedShare, 0.75);
    const assessed = (await c.services.stall.assess(rob, task))!;
    assert.deepEqual([assessed.signals.reading?.source, assessed.signals.reading?.tokensPerSecond], ["declared", 20]);
    hold.release!();
    await second;
    assert.deepEqual(problems, []);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

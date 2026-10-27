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
  const hold: { release?: () => void } = {};
  const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({
    async start(c) {
      c.enqueue(new TextEncoder().encode("data: a\n\n"));
      await new Promise<void>((resolve) => { hold.release = resolve; });
      c.enqueue(new TextEncoder().encode("data: {\"usage\":{\"prompt_tokens\":9000,\"completion_tokens\":50}}\n\n"));
      c.close();
    },
  }), { status: 200 });
  const relay = new ModelRelay({ endpoint: (route) => (route === "llama/local" ? { url: "http://llama.internal:8080/v1/" } : undefined), fetch });
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    onInternalError: (e) => { problems.push(e); },
    dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 8192, close: async () => undefined, build: (s) => { services = s as never; return { hostId: "host:w1" } as unknown as WorkerHost; } } },
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
    const order = { attemptId: "att-1", taskId: task, projectId: project, agentId: "ann", generation: a.generation, route: "llama/local", expiresAt: "2999-01-01T00:00:00.000Z" };
    const attempt = services!.attemptRelay(order as never, relay);
    const body = Buffer.from(JSON.stringify({ model: "x", messages: [{ role: "user", content: "x".repeat(30_000) }] }));
    const response = await attempt.relay({ url: `${attempt.relayBase}/${attempt.alias}/chat/completions`, method: "POST", headers: [["content-type", "application/json"]], body, signal: new AbortController().signal } as never);
    const reader = (async () => { let n = 0; for await (const _ of response.body ?? []) n++; return n; })();
    const evidence = async () => c.services.stall.evidence(rob, task);
    const until = async (ok: () => Promise<boolean>): Promise<void> => { for (let i = 0; i < 200 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(await ok(), "reported in time"); };
    // While the model is still reading: the prompt's size (the body over 3 characters a token, rounded up) and the route.
    await until(async () => (await evidence())?.request?.firstOutputAt !== undefined);
    const open = (await evidence())!.request!;
    assert.equal(open.route, "llama/local");
    assert.equal(open.promptTokens, Math.ceil(body.length / 3));
    assert.equal(open.id, "att-1:1");
    hold.release!();
    assert.ok(await reader >= 1);
    await until(async () => (await evidence())?.request === undefined || (await evidence())?.lastRequestMs !== undefined);
    const done = (await evidence())!;
    assert.equal(done.request, undefined, "the call is closed");
    assert.equal(done.reportedBy, "controller", "the relay is the only reporter here");
    assert.deepEqual(problems, []);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

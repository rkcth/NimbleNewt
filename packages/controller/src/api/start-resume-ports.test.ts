import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DependencyService } from "../dependencies/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type StartOptions } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const DIGEST = `v1:sha256:${"a".repeat(64)}`;
const capture = (durable: boolean) => ({
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" as const }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: durable ? { verified: true } : { verified: false, error: "fsync failed" },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: "run the tests" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none" as const, compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
});

// The stores a controller can be started on: SQLite and PostgreSQL (the reference store and the worker-thread SQLite are not offered by startController; they are covered by the domain tests).
// The typical tier (NIMBLENEWT_TIER=typical) runs SQLite only.
let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-ports-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `ports_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

// Card L04c: a host records continuations through the state API; the host's observation and reviewer ports reach the checked resume; changes judged to matter wait for the owner.
for (const store of stores) {
  test(`${store.name}: continuation.capture and continuation.latest work for a host through the API; an agent's own durability claim is not believed; a replay records once`, async () => {
    const db = await store.open();
    const c = await startController({ storage: db.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const rob = await c.services.principals.authenticate(boot.token);
      const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
      const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
      const task = (await call(boot.token, "task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
      await c.services.principals.enroll(rob, { commandId: "e-host", kind: "host", name: "h1", grants: [] });
      const host = (await c.services.principals.issueCredential(rob, "host:h1")).token;
      await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }, { action: "attempt.work", project }] });
      const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
      await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [] });
      const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;

      assert.equal((await call(host, "continuation.latest", { taskId: task })).result.item, undefined, "nothing captured yet");
      const first = await call(host, "continuation.capture", { taskId: task, ...capture(true) }, "cap1");
      assert.ok(first.ok, JSON.stringify(first));
      assert.deepEqual([first.result.seq, first.result.status, first.result.replayed], [1, "complete", false]);
      const again = await call(host, "continuation.capture", { taskId: task, ...capture(true) }, "cap1");
      assert.deepEqual([again.result.id, again.result.replayed], [first.result.id, true], "a replay records once");
      assert.equal((await call(host, "continuation.latest", { taskId: task })).result.item.id, first.result.id);

      // An agent saying "durable" is not believed: the capture is stored as incomplete and is not the one resumed from.
      const claimed = await call(ann, "continuation.capture", { taskId: task, ...capture(true) }, "cap2");
      assert.deepEqual([claimed.result.status, claimed.result.seq], ["incomplete", 2]);
      // A host's failed durability check is incomplete too.
      const failed = await call(host, "continuation.capture", { taskId: task, ...capture(false) }, "cap3");
      assert.equal(failed.result.status, "incomplete");
      assert.equal((await call(host, "continuation.latest", { taskId: task })).result.item.id, first.result.id, "only a complete capture is the latest");

      // Refusals: no rights, an unknown field, a missing command ID.
      assert.equal((await call(zed, "continuation.capture", { taskId: task, ...capture(true) }, "cap4")).error.code, "forbidden");
      assert.equal((await call(zed, "continuation.latest", { taskId: task })).result.item, undefined, "a stranger sees nothing");
      assert.equal((await call(host, "continuation.capture", { taskId: task, ...capture(true), extra: 1 }, "cap5")).error.code, "invalid_command");
      assert.equal((await call(host, "continuation.capture", { taskId: task, ...capture(true) })).ok, false, "a command needs its ID");
    } finally { await c.close(); await db.close(); }
  });

  for (const relevant of [true, false]) {
    test(`${store.name}: the host's observe and review ports reach the checked resume; changes ${relevant ? "judged to matter wait for the owner's approval" : "judged not to matter are committed by anyone allowed to resume"}`, async () => {
      const db = await store.open();
      const observed: string[] = [];
      const reviewed: string[][] = [];
      let deps: DependencyService | undefined;
      let owner: Awaited<ReturnType<typeof c.services.principals.authenticate>> | undefined;
      const c = await startController({
        storage: db.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
        resume: {
          observe: async (taskId) => {
            observed.push(taskId);
            const manifest = await deps?.get(owner!, taskId);
            return Object.fromEntries((manifest?.entries ?? []).map((e) => [e.id, { exists: true, hash: `sha256:${"2".repeat(64)}` }]));
          },
          review: async ({ changes }) => { reviewed.push(changes.map((x) => x.id)); return Object.fromEntries(changes.map((x) => [x.id, { relevant, rationale: relevant ? "the task edits this file" : "no link to the task" }])); },
        },
      });
      try {
        const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
        const rob = await c.services.principals.authenticate(boot.token);
        owner = rob;
        deps = DependencyService.withEpoch(c.storage, c.epoch);
        const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
        const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
        const task = (await call(boot.token, "task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
        await c.services.principals.enroll(rob, { commandId: "e-host", kind: "host", name: "h1", grants: [] });
        const hostP = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "host:h1")).token);
        const hostToken = (await c.services.principals.issueCredential(rob, "host:h1")).token;
        await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }, { action: "attempt.work", project }] });
        const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
        await c.services.continuations.capture(hostP, { commandId: "cap1", taskId: task, ...capture(true) });
        // A recorded file dependency that the worker reports as changed gives the check something to review.
        await deps.record(rob, { commandId: "d1", taskId: task, dependencies: [{ kind: "file", key: "/src/a.ts", hash: `sha256:${"1".repeat(64)}` }] });
        const model = { provider: "local", id: "m1" };
        const s = await call(boot.token, "resume.start", { taskId: task, model, after: "restart" }, "r1");
        assert.ok(s.ok, JSON.stringify(s));
        assert.ok(observed.includes(task), "the host's observe port was asked what the worker sees");
        assert.equal(reviewed.length, 1, "the changed file went to the reviewer");
        assert.equal(s.result.item.delta.changed.length, 1);
        assert.equal(s.result.item.phase, "ready");
        assert.ok(Object.values(s.result.item.verdicts as Record<string, { relevant: boolean }>).every((v) => v.relevant === relevant));
        if (relevant) {
          assert.equal((await call(ann, "resume.commit", { checkId: s.result.item.id }, "a1")).error.code, "forbidden", "the agent being resumed cannot commit over changes that matter");
          assert.equal((await call(hostToken, "resume.commit", { checkId: s.result.item.id }, "h1c")).error.code, "forbidden", "a host cannot commit over changes that matter");
          assert.equal((await call(ann, "resume.approve", { taskId: task }, "a2")).error.code, "forbidden");
          // The owner can ask what waits for them and finds the held resume with what changed; an agent does not.
          const needs = await call(boot.token, "status.ask", { request: { kind: "needs_you" } });
          const said = (needs.result.item.lines as { text: string }[]).map((l) => l.text).join("\n");
          assert.match(said, new RegExp(`Task ${task} is held before it resumes: 1 change since it stopped was judged to matter to it: file /src/a\\.ts \\(changed\\) \\(approve the resume`));
          const ok = await call(boot.token, "resume.approve", { taskId: task }, "o1");
          assert.equal(ok.result.item.phase, "done");
          assert.equal((await call(boot.token, "resume.approve", { taskId: task }, "o2")).result.item.phase, "done");
          const after = (await call(boot.token, "status.ask", { request: { kind: "needs_you" } })).result.item.lines as { text: string }[];
          assert.ok(after.every((l) => !l.text.includes("held before it resumes")), "once approved it no longer waits for the owner");
        } else {
          // Approving is the owner's decision even when nothing held the check.
          assert.equal((await call(hostToken, "resume.approve", { taskId: task }, "h1a")).error.code, "forbidden");
          assert.equal((await call(ann, "resume.approve", { taskId: task }, "a3")).error.code, "forbidden");
          assert.equal((await call(hostToken, "resume.commit", { checkId: s.result.item.id }, "h2")).result.item.phase, "done");
        }
      } finally { await c.close(); await db.close(); }
    });
  }
}

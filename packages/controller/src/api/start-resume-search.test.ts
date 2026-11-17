// Card L04d: a search the agent recorded is made again by the controller when the task is resumed, through the composed controller and the state API.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type StartOptions } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const DIGEST = `v1:sha256:${"a".repeat(64)}`;
const capture = {
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" as const }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: "run the tests" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none" as const, compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
};

// The stores a controller can be started on. The typical tier (NIMBLENEWT_TIER=typical) runs SQLite only.
let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-probe-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `probe_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

interface World {
  readonly c: Awaited<ReturnType<typeof startController>>;
  readonly owner: string;
  readonly ann: string;
  readonly task: string;
  readonly project: string;
  /** Ann writes a shared, accepted note to her desk in the task's project. */
  note(title: string, body: string): Promise<void>;
  readonly dir: string;
  readonly root: string;
  readonly lines: (token: string) => Promise<string>;
  call(token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<any>;
  write(rel: string, text: string): void;
  record(dependencies: readonly Record<string, unknown>[], commandId: string): Promise<any>;
  start(commandId: string): Promise<any>;
  close(): Promise<void>;
}

/** A controller whose project has a repository bound to a real folder, one task on it, an agent that may work it, and a captured continuation. */
async function begin(store: Store, extra: Omit<Partial<StartOptions>, "storage" | "facts" | "filesystem" | "argv" | "env" | "print">): Promise<World> {
  const db = await store.open();
  const root = mkdtempSync(join(tmpdir(), "nn-checkout-"));
  const dir = join(root, "checkout");
  mkdirSync(dir, { recursive: true });
  const c = await startController({ ...extra, storage: db.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<any> => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
  const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
  const bound = await call(boot.token, "resource.bind", { projectId: project, kind: "repository", label: "src", locator: dir, repositoryId: "repo-main" }, "b1");
  assert.ok(bound.ok, JSON.stringify(bound));
  const task = (await call(boot.token, "task.create", { projectId: project, title: "weed the bed", repositoryId: "repo-main" }, "t1")).result.id as string;
  await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }, { action: "attempt.work", project }, { action: "desk.write", project }, { action: "desk.read", project }] });
  const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
  // The host captured where the agent left off; the resume is checked against that.
  const captured = await call(boot.token, "continuation.capture", { taskId: task, ...capture }, "cap1");
  assert.ok(captured.ok, JSON.stringify(captured));
  const lines = async (token: string): Promise<string> => (((await call(token, "status.ask", { request: { kind: "needs_you" } })).result.item.lines as { text: string }[]) ?? []).map((l) => l.text).join("\n");
  return {
    c, owner: boot.token, ann, task, project, dir, root, call, lines,
    note: async (title, body) => { const p = await c.services.principals.authenticate(ann); await c.services.desks.write(p, { commandId: `n-${title}`, projectId: project, kind: "note", title, body, visibility: "shared", status: "accepted" } as never); },
    write: (rel: string, text: string) => { const at = join(dir, ...rel.split("/")); mkdirSync(join(at, ".."), { recursive: true }); writeFileSync(at, text, "utf8"); },
    record: async (dependencies, commandId) => await call(boot.token, "resume.dependencies.record", { taskId: task, dependencies }, commandId),
    start: async (commandId) => await call(boot.token, "resume.start", { taskId: task, model: { provider: "local", id: "m1" }, after: "restart" }, commandId),
    close: async () => { await c.close(); await db.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); },
  };
}

for (const store of stores) {
  test(`${store.name}: a search the agent recorded through the state API is made again at the resume: unchanged lets the agent commit without the owner, a new matching record holds it for the owner`, async () => {
    const w = await begin(store, {});
    try {
      await w.note("Soil report", "the soil needs lime before planting");
      const asked = await w.call(w.ann, "resume.dependencies.search", { projectId: w.project, query: "soil lime" });
      assert.ok(asked.ok, JSON.stringify(asked));
      const dep = asked.result.item;
      assert.deepEqual([dep.kind, dep.key, dep.scope.query], ["search", "soil lime", "soil lime"]);
      assert.equal(JSON.stringify(dep).includes("needs lime"), false, "the answer carries a digest, not the records' text");
      const recorded = await w.call(w.ann, "resume.dependencies.record", { taskId: w.task, dependencies: [dep] }, "d1");
      assert.ok(recorded.ok, JSON.stringify(recorded));
      const first = (await w.start("r1")).result.item;
      assert.deepEqual([first.phase, first.delta.changed.length, first.delta.unchanged], ["ready", 0, 1], "the search was made again and found the same: not unknown");
      assert.equal(await w.lines(w.owner), "Nothing is waiting for you.");
      assert.equal((await w.call(w.ann, "resume.commit", { checkId: first.id }, "c1")).result.item.phase, "done", "the agent commits it itself");

      // Another record now matches: the same search finds something new, so the next resume is held for the owner.
      await w.note("Lime delivery", "the lime arrives on Friday");
      const second = (await w.start("r2")).result.item;
      assert.deepEqual(second.delta.changed.map((x: { key: string; status: string; detail: string }) => [x.key, x.status, x.detail]), [["soil lime", "changed", "the results differ"]]);
      assert.equal(second.phase, "ready");
      assert.match(await w.lines(w.owner), /search soil lime \(changed\)/);
      assert.equal((await w.call(w.ann, "resume.commit", { checkId: second.id }, "c2")).error.code, "forbidden", "not committed over a change nobody judged");
      // A hash that is not what the search finds now is refused, as for a record.
      const wrong = await w.call(w.ann, "resume.dependencies.record", { taskId: w.task, dependencies: [{ ...dep, key: "stale" }] }, "d2");
      assert.equal(wrong.error.code, "invalid_command", JSON.stringify(wrong));
    } finally { await w.close(); }
  });

  test(`${store.name}: a host's own observer does not take the search from the controller; a caller outside the project finds nothing in the digest`, async () => {
    const w = await begin(store, { resume: { observe: async () => ({}) } });
    try {
      await w.note("Pests", "slugs on the lettuce");
      const dep = (await w.call(w.ann, "resume.dependencies.search", { projectId: w.project, query: "slugs" })).result.item;
      assert.ok((await w.call(w.ann, "resume.dependencies.record", { taskId: w.task, dependencies: [dep] }, "d1")).ok);
      const check = (await w.start("r1")).result.item;
      assert.equal(check.delta.unchanged, 1, "judged by the controller even though the host's observer answered nothing");
      // Someone with no rights in the project gets the digest of an empty search, and cannot record it for a task they do not work.
      const rob = await w.c.services.principals.authenticate(w.owner);
      await w.c.services.principals.enroll(rob, { commandId: "e-eve", kind: "agent", name: "eve", grants: [] });
      const eve = (await w.c.services.principals.issueCredential(rob, "agent:eve")).token;
      const hers = (await w.call(eve, "resume.dependencies.search", { projectId: w.project, query: "slugs" })).result.item;
      assert.notEqual(hers.hash, dep.hash, "what eve may not read is not in her digest");
      assert.equal((await w.call(eve, "resume.dependencies.record", { taskId: w.task, dependencies: [hers] }, "d2")).error.code, "forbidden");
    } finally { await w.close(); }
  });
}

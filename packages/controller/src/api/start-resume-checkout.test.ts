import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ChatSpendService } from "../chat/index.js";
import type { ResumeReviewModel } from "../continuation/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type StartOptions } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const DIGEST = `v1:sha256:${"a".repeat(64)}`;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const capture = {
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" as const }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: "run the tests" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none" as const, compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
};

/** A model that answers the reviewer with the same verdict for every change it is asked about; `asked` collects what it was told. */
const verdictModel = (verdict: { relevant: boolean; rationale: string }, asked: string[] = []): ResumeReviewModel => ({
  complete: async (_route: string, request: { system: string; user: string }) => {
    asked.push(request.user);
    const ids = (request.user.match(/these ids: ([^\n]*)/)?.[1] ?? "").split(", ").filter((x) => x !== "");
    return JSON.stringify(Object.fromEntries(ids.map((id) => [id, verdict])));
  },
});

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
  await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }, { action: "attempt.work", project }] });
  const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
  // The host captured where the agent left off; the resume is checked against that.
  const captured = await call(boot.token, "continuation.capture", { taskId: task, ...capture }, "cap1");
  assert.ok(captured.ok, JSON.stringify(captured));
  const lines = async (token: string): Promise<string> => (((await call(token, "status.ask", { request: { kind: "needs_you" } })).result.item.lines as { text: string }[]) ?? []).map((l) => l.text).join("\n");
  return {
    c, owner: boot.token, ann, task, dir, root, call, lines,
    write: (rel: string, text: string) => { const at = join(dir, ...rel.split("/")); mkdirSync(join(at, ".."), { recursive: true }); writeFileSync(at, text, "utf8"); },
    record: async (dependencies, commandId) => await call(boot.token, "resume.dependencies.record", { taskId: task, dependencies }, commandId),
    start: async (commandId) => await call(boot.token, "resume.start", { taskId: task, model: { provider: "local", id: "m1" }, after: "restart" }, commandId),
    close: async () => { await c.close(); await db.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); },
  };
}

for (const store of stores) {
  test(`${store.name}: a checked resume reads the task's checkout: a recorded file that is as it was is observed unchanged and the resumed attempt is committed without the owner`, async () => {
    const w = await begin(store, {});
    try {
      w.write("src/a.ts", "one");
      assert.equal((await w.record([{ kind: "file", key: "src/a.ts", hash: sha("one") }, { kind: "directory", key: "src", members: ["a.ts"] }], "d1")).ok, true);
      const started = await w.start("r1");
      assert.ok(started.ok, JSON.stringify(started));
      const check = started.result.item;
      assert.deepEqual([check.phase, check.delta.changed.length, check.delta.unchanged], ["ready", 0, 2], "the file was hashed and the directory listed: both were looked at, not left unknown");
      assert.equal(await w.lines(w.owner), "Nothing is waiting for you.", "nothing waited for the owner");
      // The agent being resumed commits it itself: no owner decision was needed.
      assert.equal((await w.call(w.ann, "resume.commit", { checkId: check.id }, "c1")).result.item.phase, "done");
    } finally { await w.close(); }
  });

  test(`${store.name}: what the checkout shows is told as it is: a changed file is changed, a deleted one deleted, and nothing outside the checkout is read`, async () => {
    const w = await begin(store, {});
    try {
      w.write("src/a.ts", "two");
      // Outside the checkout but exactly what was recorded: were the probe ever to look there, this would read "unchanged".
      writeFileSync(join(w.root, "outside.txt"), "gone", "utf8");
      const recorded = await w.record([
        { kind: "file", key: "src/a.ts", hash: sha("one") },
        { kind: "file", key: "src/gone.ts", hash: sha("was here") },
        { kind: "file", key: "../outside.txt", hash: sha("gone") },
        { kind: "file", key: "/etc/hostname", hash: sha("whatever") },
        { kind: "directory", key: "src", members: ["a.ts", "gone.ts"] },
      ], "d1");
      assert.ok(recorded.ok, JSON.stringify(recorded));
      const check = (await w.start("r1")).result.item;
      const byKey = Object.fromEntries((check.delta.changed as { key: string; status: string; detail: string }[]).map((x) => [x.key, x]));
      assert.equal(byKey["src/a.ts"]?.status, "changed", "the file's content differs from what was recorded");
      assert.equal(byKey.src?.status, "changed", "a member of the recorded listing is not there any more");
      assert.equal(byKey.src?.detail, "gone: gone.ts", "and which one is said");
      assert.equal(byKey["src/gone.ts"]?.status, "deleted", "it is not there any more");
      assert.equal(byKey["../outside.txt"]?.status, "unknown", "nothing outside the checkout is looked at, so nothing is claimed");
      assert.equal(byKey["/etc/hostname"]?.status, "unknown", "an absolute key is not read either");
      assert.equal(check.delta.unchanged, 0, "and none of them was called unchanged");
      // The attempt cannot start on its own: an unjudged change and dependencies of unknown effect both wait.
      assert.ok(["ready", "blocked"].includes(check.phase), JSON.stringify(check));
    } finally { await w.close(); }
  });

  test(`${store.name}: without the probe the same file is left unknown and the resume cannot go on; the probe's bounds leave the rest unknown too, and what the host gives for the port wins over the controller's own`, async () => {
    const off = await begin(store, { resumeProbe: false });
    try {
      off.write("src/a.ts", "one");
      assert.ok((await off.record([{ kind: "file", key: "src/a.ts", hash: sha("one") }], "d1")).ok);
      const check = (await off.start("r1")).result.item;
      assert.equal(check.phase, "ready");
      assert.deepEqual(check.delta.changed.map((x: { key: string; status: string }) => [x.key, x.status]), [["src/a.ts", "unknown"]], "as before card L04d: nothing was looked at, so the file is not called unchanged");
      const waiting = await off.lines(off.owner);
      assert.match(waiting, /"weed the bed" is held before it resumes/, waiting);
      assert.match(waiting, /file src\/a\.ts \(unknown\)/, waiting);
      assert.equal((await off.call(off.ann, "resume.commit", { checkId: check.id }, "c1")).error.code, "forbidden", "the attempt is not started over a change nobody looked at");
    } finally { await off.close(); }

    const bounded = await begin(store, { resumeProbe: { maxEntries: 1 } });
    try {
      bounded.write("src/a.ts", "one");
      bounded.write("src/b.ts", "two");
      assert.ok((await bounded.record([{ kind: "file", key: "src/a.ts", hash: sha("one") }, { kind: "file", key: "src/b.ts", hash: sha("two") }], "d1")).ok);
      const check = (await bounded.start("r2")).result.item;
      assert.equal(check.delta.unchanged, 1, "the one it read is unchanged");
      assert.deepEqual(check.delta.changed.map((x: { key: string; status: string }) => [x.key, x.status]), [["src/b.ts", "unknown"]], "the one beyond its bound was not read, so it is not claimed");
      assert.equal(check.phase, "ready");
    } finally { await bounded.close(); }

    // What the host supplies for the port is used instead of the controller's own probe (card L04d wiring).
    const hosts = await begin(store, { resume: { observe: async () => ({}) } });
    try {
      hosts.write("src/a.ts", "one");
      assert.ok((await hosts.record([{ kind: "file", key: "src/a.ts", hash: sha("one") }], "d1")).ok);
      const check = (await hosts.start("r3")).result.item;
      assert.deepEqual(check.delta.changed.map((x: { key: string; status: string }) => [x.key, x.status]), [["src/a.ts", "unknown"]], "the host's observer answered nothing, and the controller's probe was not put in its place");
    } finally { await hosts.close(); }
  });

  test(`${store.name}: the reviewer agent's "it does not matter" lets the resumed attempt be committed without the owner; "it matters" holds it and is said to the owner with the reason`, async () => {
    const told: string[] = [];
    const w = await begin(store, { resumeReview: { model: verdictModel({ relevant: false, rationale: "the task only reads the soil report" }, told), routes: ["m/reviewer"] } });
    try {
      w.write("src/a.ts", "two");
      assert.ok((await w.record([{ kind: "file", key: "src/a.ts", hash: sha("one") }], "d1")).ok);
      const check = (await w.start("r1")).result.item;
      assert.equal(check.phase, "ready");
      assert.equal(check.delta.changed.length, 1);
      const verdicts = Object.values(check.verdicts as Record<string, { relevant: boolean; rationale: string; digest: string }>);
      assert.deepEqual(verdicts.map((v) => [v.relevant, v.rationale]), [[false, "the task only reads the soil report"]], "the reviewer's own verdict, with its reason");
      assert.equal(typeof verdicts[0]!.digest, "string", "the verdict is tied to the change it was given for");
      assert.equal(await w.lines(w.owner), "Nothing is waiting for you.", "the owner is not asked about a change the reviewer set aside");
      assert.equal((await w.call(w.ann, "resume.commit", { checkId: check.id }, "c1")).result.item.phase, "done", "committed without the owner");
      // The reviewer was told the task in its own words, quoted, and the change as data.
      assert.match(told[0] ?? "", /^Task: "weed the bed"/m, "the task's title reaches the reviewer quoted, not bare");
      assert.match(told[0] ?? "", /Next step it recorded before stopping: "run the tests"/);
      assert.match(told[0] ?? "", /CHANGE \{"id":"dpm-/);
      assert.match(told[0] ?? "", /key="src\/a\.ts"/);
    } finally { await w.close(); }

    const held: string[] = [];
    const other = await begin(store, { resumeReview: { model: verdictModel({ relevant: true, rationale: "the task edits this very file" }, held), routes: ["m/first", "m/second"] } });
    try {
      other.write("src/a.ts", "two");
      assert.ok((await other.record([{ kind: "file", key: "src/a.ts", hash: sha("one") }], "d1")).ok);
      const check = (await other.start("r1")).result.item;
      assert.equal(check.phase, "ready");
      const said = await other.lines(other.owner);
      assert.match(said, /"weed the bed" is held before it resumes: 1 change since it stopped was judged to matter to it: file src\/a\.ts \(changed\)/, said);
      assert.ok(!said.includes(other.task), "the owner is shown the task's title, not its ID");
      assert.equal((await other.call(other.ann, "resume.commit", { checkId: check.id }, "c1")).error.code, "forbidden", "neither the agent nor the dispatcher commits over a change that matters");
      assert.equal((await other.call(other.owner, "resume.approve", { taskId: other.task }, "o1")).result.item.phase, "done", "the owner's approval is what lets it go on");
      assert.equal(held.length, 1, "the second route was not needed once one answered");
    } finally { await other.close(); }
  });

  test(`${store.name}: a reviewer that will not answer holds the resume at the review instead of passing it off as judged`, async () => {
    const rambling: string[] = [];
    const w = await begin(store, {
      resumeReview: {
        model: { complete: async (route: string) => { rambling.push(route); return "I am not sure about any of this, but it looks fine to me."; } },
        routes: ["m/first", "m/second"],
      },
    });
    try {
      w.write("src/a.ts", "two");
      assert.ok((await w.record([{ kind: "file", key: "src/a.ts", hash: sha("one") }], "d1")).ok);
      const check = (await w.start("r1")).result.item;
      assert.deepEqual([check.phase, check.blocked?.type], ["blocked", "review_failed"], JSON.stringify(check));
      assert.deepEqual(rambling, ["m/first", "m/second"], "every route was asked before it gave up");
      assert.match(check.blocked?.reason ?? "", /no route gave a reasoned verdict/, JSON.stringify(check.blocked));
      assert.equal((await w.call(w.ann, "resume.commit", { checkId: check.id }, "c1")).error.code, "invalid_command", "the attempt is never started from it");
      assert.equal((await w.call(w.owner, "resume.approve", { taskId: w.task }, "o1")).error.code, "invalid_command", "there is nothing for the owner to approve: no verdict was given");
    } finally { await w.close(); }
  });

  test(`${store.name}: the reviewer's model is behind the controller's routed client: its routes come from the routing table, a rate-limited route is cooled down and skipped, its tokens are counted, and at the daily cap no call is made (card L04d)`, async () => {
    const asked: string[] = [];
    let first = true;
    const answer = (user: string): string => JSON.stringify(Object.fromEntries((user.match(/these ids: ([^\n]*)/)?.[1] ?? "").split(", ").filter((x) => x !== "").map((id) => [id, { relevant: false, rationale: "the task only reads the soil report" }])));
    const model = {
      complete: async (): Promise<string> => { throw new Error("the routed client asks for the detailed reply"); },
      completeDetailed: async (route: string, request: { system: string; user: string }) => {
        asked.push(route);
        if (route === "mp/first" && first) { first = false; throw new Error("rate-limit: slow down"); }
        return { text: answer(request.user), usage: { inputTokens: 100, outputTokens: 20 } };
      },
    };
    const w = await begin(store, { resumeReview: { model } });
    try {
      const owner = await w.c.services.principals.authenticate(w.owner);
      await w.c.services.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: {
        providers: { mp: { enabled: true, paid: false, location: "local" }, mq: { enabled: true, paid: false, location: "local" } },
        routes: { "mp/first": { contextTokens: 32_000, capabilities: [] }, "mq/second": { contextTokens: 32_000, capabilities: [] } },
        profiles: { sup: ["mp/first", "mq/second"] }, roles: { coordinator: "sup", "safety-supervisor": "sup" },
      } } as never);
      const spend = ChatSpendService.withEpoch(w.c.storage, w.c.epoch);
      w.write("src/a.ts", "two");
      assert.ok((await w.record([{ kind: "file", key: "src/a.ts", hash: sha("one") }], "d1")).ok);
      const one = (await w.start("r1")).result.item;
      assert.equal(one.phase, "ready", JSON.stringify(one));
      assert.deepEqual(Object.values(one.verdicts as Record<string, { relevant: boolean }>).map((v) => v.relevant), [false]);
      assert.deepEqual(asked, ["mp/first", "mq/second"], "the safety supervisor's list, in the table's order; the rate-limited route gave way to the next");
      assert.equal(await spend.used(), 120, "the call that answered is counted");
      assert.equal((await w.call(w.ann, "resume.commit", { checkId: one.id }, "c1")).result.item.phase, "done");

      // The next review skips the route that is cooling down.
      w.write("src/a.ts", "three");
      assert.ok((await w.record([{ kind: "file", key: "src/a.ts", hash: sha("two") }], "d2")).ok);
      const two = (await w.start("r2")).result.item;
      assert.equal(two.phase, "ready", JSON.stringify(two));
      assert.deepEqual(asked, ["mp/first", "mq/second", "mq/second"], "the cooling route was not asked");
      assert.equal(await spend.used(), 240);
      assert.equal((await w.call(w.ann, "resume.commit", { checkId: two.id }, "c2")).result.item.phase, "done");

      // At the owner's daily cap no call is made: the check waits at the review.
      await spend.setBudget(owner, { commandId: "cap", maxTokensPerDay: 240 });
      w.write("src/a.ts", "four");
      assert.ok((await w.record([{ kind: "file", key: "src/a.ts", hash: sha("three") }], "d3")).ok);
      const three = (await w.start("r3")).result.item;
      assert.deepEqual([three.phase, three.blocked?.type], ["blocked", "review_failed"], JSON.stringify(three));
      assert.equal(asked.length, 3, "no model call past the cap");
    } finally { await w.close(); }
  });
}

// Card L04g through the composed controller and the state API: an external resource a task recorded is read again at a resume only where the owner allowed it (the setting, then the task's
// own network grant), with one bounded request to a stand-in server on loopback; an agent records what it relied on and the controller looks and fills it in; the resume reviewer is shown the
// change itself (a bounded, redacted diff), unless the owner turned that off.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ResumeReviewModel } from "../continuation/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type StartOptions } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const PUBLIC = "93.184.216.34";
// Built at run time so that no key-shaped literal sits in the source.
const SECRET = ["s", "k", "-", "live", "-"].join("") + "Q7w9".repeat(8);
const DIGEST = `v1:sha256:${"a".repeat(64)}`;
const capture = {
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" as const }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: "write the planting guide" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none" as const, compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
};

let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-ext-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `ext_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

/** The stand-in resource server: one page whose text and ETag the test sets; it records every request. */
interface Page { text: string; etag: string; status?: number }
async function standIn(page: Page): Promise<{ port: number; seen: IncomingMessage[]; close(): Promise<void> }> {
  const seen: IncomingMessage[] = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(req);
    if (page.status !== undefined) { res.writeHead(page.status); res.end(); return; }
    if (req.headers["if-none-match"] === page.etag) { res.writeHead(304, { etag: page.etag }); res.end(); return; }
    res.writeHead(200, { etag: page.etag, "content-type": "text/plain" });
    res.end(page.text);
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { port: (srv.address() as { port: number }).port, seen, close: () => new Promise<void>((ok) => srv.close(() => ok())) };
}

/** A reviewer model that says "relevant" for every id and keeps every prompt it was given. */
const reviewer = (asked: string[]): ResumeReviewModel => ({
  complete: async (_route: string, request: { system: string; user: string }) => {
    asked.push(request.user);
    const ids = (request.user.match(/these ids: ([^\n]*)/)?.[1] ?? "").split(", ").filter((x) => x !== "");
    return JSON.stringify(Object.fromEntries(ids.map((id) => [id, { relevant: true, rationale: "the guide quotes this text" }])));
  },
});

async function begin(store: Store, port: number, asked: string[], dialed: string[]) {
  const db = await store.open();
  const root = mkdtempSync(join(tmpdir(), "nn-ext-co-"));
  const dir = join(root, "checkout");
  mkdirSync(dir, { recursive: true });
  const c = await startController({
    storage: db.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    resumeReview: { model: reviewer(asked) as never, routes: ["m/reviewer"] },
    dispatch: {
      timer: new ManualTimer(), manual: true,
      local: { window: () => 32768, acceptUnenforcedLimits: true, build: () => new ScriptedWorker("host:w1", async () => ({ status: "completed", text: "done" })) },
      network: { resolve: async (h: string) => (h === "docs.example.com" ? [PUBLIC] : h === "inside.example.com" ? ["127.0.0.1"] : []), dial: (address: string) => { dialed.push(address); return netConnect({ host: "127.0.0.1", port }); }, secret: async (name: string) => (name === "docs-token" ? SECRET : undefined) },
    },
  } as never);
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<any> => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
  const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
  assert.ok((await call(boot.token, "resource.bind", { projectId: project, kind: "repository", label: "src", locator: dir, repositoryId: "repo-main" }, "b1")).ok);
  const task = (await call(boot.token, "task.create", { projectId: project, title: "write the planting guide", repositoryId: "repo-main" }, "t1")).result.id as string;
  await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }, { action: "attempt.work", project }] });
  const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
  assert.ok((await call(boot.token, "continuation.capture", { taskId: task, ...capture }, "cap1")).ok);
  return {
    c, rob, owner: boot.token, ann, task, project, dir, call,
    set: async (key: string, value: unknown, id: string) => { await c.services.configuration.change(rob, { commandId: id, layer: "installation", set: { [key]: value } } as never); },
    write: (rel: string, text: string) => { writeFileSync(join(dir, rel), text, "utf8"); },
    start: async (id: string) => { const r = await call(boot.token, "resume.start", { taskId: task, model: { provider: "local", id: "m1" }, after: "restart" }, id); assert.ok(r.ok, JSON.stringify(r));
      // Each look is its own check: the one made is cancelled, so the next start makes a new one.
      const cancelled = await call(boot.token, "resume.cancel", { checkId: r.result.item.id }, `x-${id}`); assert.ok(cancelled.ok, JSON.stringify(cancelled));
      return r.result.item; },
    close: async () => { await c.close(); await db.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); },
  };
}

const changed = (check: { delta: { changed: { key: string; status: string; detail: string }[] } }): [string, string, string][] => check.delta.changed.map((x) => [x.key, x.status, x.detail]);

for (const store of stores) {
  test(`${store.name}: an external resource is read again only where the owner allowed it, once per check, conditionally, through the task's grant`, async () => {
    const page: Page = { text: "Plant after the last frost.\n", etag: "\"v1\"" };
    const site = await standIn(page);
    const asked: string[] = []; const dialed: string[] = [];
    const w = await begin(store, site.port, asked, dialed);
    try {
      const url = "http://docs.example.com/frost";
      assert.ok((await w.call(w.owner, "resume.dependencies.record", { taskId: w.task, dependencies: [{ kind: "external", key: url, etag: "\"v1\"", freshness: "conditional-read" }] }, "d1")).ok);
      // The owner has not allowed reads: nothing is fetched, the dependency is unknown with that reason.
      const off = await w.start("r1");
      assert.equal(changed(off).length, 1);
      assert.equal(changed(off)[0]![1], "unknown");
      assert.match(changed(off)[0]![2], /owner has not allowed .*resume\.externalReads/);
      assert.equal(site.seen.length, 0, "nothing is fetched without the owner's allowance");
      // Allowed, but the task holds no grant for the address: still nothing is fetched.
      await w.set("resume.externalReads", true, "s1");
      const noGrant = await w.start("r2");
      assert.match(changed(noGrant)[0]![2], /no grant for that destination/);
      assert.equal(site.seen.length, 0);
      // With the owner's grant: one conditional request; the server's 304 reads unchanged.
      assert.ok((await w.call(w.owner, "network.grant", { taskId: w.task, host: "docs.example.com", port: 80, credential: { header: "authorization", ref: "docs-token" } }, "g1")).ok);
      const same = await w.start("r3");
      assert.deepEqual(changed(same), [], JSON.stringify(same.delta));
      assert.equal(same.delta.unchanged, 1);
      assert.equal(site.seen.length, 1, "one request for the one resource at this check");
      const first = site.seen.length;
      assert.equal(site.seen[0]!.headers["if-none-match"], "\"v1\"", "conditional on the recorded ETag");
      assert.equal(site.seen[0]!.headers["authorization"], SECRET, "the grant's own header, and only that");
      assert.deepEqual([...new Set(dialed)], [PUBLIC], "only the checked address is dialled");
      // The page changes: changed.
      page.etag = "\"v2\""; page.text = "Plant two weeks after the last frost.\n";
      const moved = await w.start("r4");
      assert.deepEqual(changed(moved).map((x) => [x[1], x[2]]), [["changed", "the hash or ETag differs"]]);
      assert.equal(site.seen.length, first + 1);
      // The read is logged in the task's connection log as the resume check's, and the secret is nowhere in it, nor in the check.
      const log = await w.call(w.owner, "network.connections", { taskId: w.task });
      const text = JSON.stringify(log);
      assert.match(text, /resume-check/);
      assert.equal(text.includes(SECRET), false);
      assert.equal(JSON.stringify(moved).includes(SECRET), false);
      // A redirect is not followed and a gone page is deleted.
      page.status = 302;
      assert.match(changed(await w.start("r5"))[0]![2], /redirect is not followed/);
      page.status = 404;
      assert.deepEqual(changed(await w.start("r6"))[0]!.slice(1), ["deleted", "the resource is gone"]);
      // A name that resolves to a private address is refused unless the grant names it: nothing is dialled for it.
      delete page.status;
      const before = dialed.length;
      assert.ok((await w.call(w.owner, "resume.dependencies.record", { taskId: w.task, dependencies: [{ kind: "external", key: "http://inside.example.com/x", etag: "\"v1\"", freshness: "conditional-read" }] }, "d2")).ok);
      assert.ok((await w.call(w.owner, "network.grant", { taskId: w.task, host: "inside.example.com", port: 80 }, "g2")).ok);
      const inside = changed(await w.start("r7")).find((x) => x[0] === "http://inside.example.com/x")!;
      assert.equal(inside[1], "unknown");
      assert.match(inside[2], /private or internal address/);
      assert.equal(dialed.slice(before).includes("127.0.0.1"), false);
    } finally { await w.close(); await site.close(); }
  });

  test(`${store.name}: the agent records what it relied on and the controller looks; the reviewer is shown the change itself, redacted, unless the owner turned it off`, async () => {
    const page: Page = { text: "Plant after the last frost.\n", etag: "\"v1\"" };
    const site = await standIn(page);
    const asked: string[] = []; const dialed: string[] = [];
    const w = await begin(store, site.port, asked, dialed);
    try {
      await w.set("resume.externalReads", true, "s1");
      assert.ok((await w.call(w.owner, "network.grant", { taskId: w.task, host: "docs.example.com", port: 80 }, "g1")).ok);
      w.write("guide.md", `# Guide\nBeds: 3\nkey=${SECRET}\nWater daily.\n`);
      const noted = await w.call(w.ann, "resume.dependencies.note", { taskId: w.task, dependencies: [{ kind: "file", key: "guide.md" }, { kind: "external", key: "http://docs.example.com/frost" }] }, "n1");
      assert.ok(noted.ok, JSON.stringify(noted));
      assert.deepEqual(noted.result.entries.map((e: { kind: string; checkedBy: string }) => [e.kind, e.checkedBy]), [["file", "controller"], ["external", "controller"]]);
      // A hash the agent gives must be what the controller finds.
      const wrong = await w.call(w.ann, "resume.dependencies.note", { taskId: w.task, dependencies: [{ kind: "file", key: "guide.md", hash: "0".repeat(64) }] }, "n2");
      assert.equal(wrong.error.code, "invalid_command", JSON.stringify(wrong));
      const manifest = (await w.call(w.owner, "resume.dependencies.get", { taskId: w.task })).result.item;
      assert.equal(manifest.entries.length, 2);
      assert.ok(manifest.entries.every((e: { hash?: string }) => typeof e.hash === "string" && e.hash.length === 64));
      assert.equal(JSON.stringify(manifest).includes(SECRET), false);

      // Both change. The reviewer is given the two diffs, with the secret redacted.
      w.write("guide.md", `# Guide\nBeds: 4\nkey=${SECRET}\nWater daily.\n`);
      page.etag = "\"v2\""; page.text = "Plant two weeks after the last frost.\n";
      const check = await w.start("r1");
      assert.deepEqual(changed(check).map((x) => x[1]).sort(), ["changed", "changed"], JSON.stringify(check.delta));
      const prompt = asked.join("\n");
      assert.match(prompt, /change="@@ line 2 @@\\n # Guide\\n-Beds: 3\\n\+Beds: 4/);
      assert.match(prompt, /-Plant after the last frost\.\\n\+Plant two weeks after the last frost\./);
      assert.equal(prompt.includes(SECRET), false, "a secret in the file never reaches the reviewer");

      // The owner turns the view off: the reviewer is told only the note.
      await w.set("resume.reviewerSeesChanges", false, "s2");
      asked.length = 0;
      w.write("guide.md", `# Guide\nBeds: 5\n`);
      await w.start("r2");
      assert.ok(asked.length > 0);
      assert.equal(asked.join("\n").includes("change="), false);
    } finally { await w.close(); await site.close(); }
  });
}

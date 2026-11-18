// Card L04g, the composed observation (`resumeObservation` as `startController` wires it): with the host's own `resume.observe` port, an external resource the agent noted is
// still read again where the owner allowed it, the host's observation wins for what it reports, and the text the read found reaches the reviewer only while its hash is the one
// this check observed for that entry. A host that reports a different hash keeps the read's text away from the reviewer (no stale diff); one that reports the read's hash lets the
// diff through; one that reports the recorded hash makes the entry unchanged, so nothing is put to the reviewer for it. Each part fails if `start.ts` stops composing the
// observation through `resumeObservation` (no resource read, or no stale-text rule).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ResumeReviewModel } from "../continuation/index.js";
import type { Observation } from "../dependencies/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const PUBLIC = "93.184.216.34";
const DIGEST = `v1:sha256:${"a".repeat(64)}`;
const capture = {
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" as const }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: "write the planting guide" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none" as const, compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
};
const sha = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

interface Page { text: string; etag: string }
async function standIn(page: Page): Promise<{ port: number; seen: IncomingMessage[]; close(): Promise<void> }> {
  const seen: IncomingMessage[] = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(req);
    if (req.headers["if-none-match"] === page.etag) { res.writeHead(304, { etag: page.etag }); res.end(); return; }
    res.writeHead(200, { etag: page.etag, "content-type": "text/plain" });
    res.end(page.text);
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { port: (srv.address() as { port: number }).port, seen, close: () => new Promise<void>((ok) => srv.close(() => ok())) };
}

const reviewer = (asked: string[]): ResumeReviewModel => ({
  complete: async (_route: string, request: { system: string; user: string }) => {
    asked.push(request.user);
    const ids = (request.user.match(/these ids: ([^\n]*)/)?.[1] ?? "").split(", ").filter((x) => x !== "");
    return JSON.stringify(Object.fromEntries(ids.map((id) => [id, { relevant: true, rationale: "the guide quotes this text" }])));
  },
});

test("SQLite: the composed observation reads the resource again beside the host's resume.observe, and only a text at the hash the check observed reaches the reviewer", async () => {
  const page: Page = { text: "Plant after the last frost.\n", etag: "\"v1\"" };
  const site = await standIn(page);
  const asked: string[] = [];
  // What the host's own observe port reports, per entry ID; set by the test before each check.
  let hostSays: Record<string, Observation> = {};
  const hostCalls: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "nn-obs-wire-"));
  const dir = join(root, "checkout");
  mkdirSync(dir, { recursive: true });
  let c: Awaited<ReturnType<typeof startController>> | undefined;
  try {
    c = await startController({
      storage: { kind: "sqlite", path: join(root, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
      resumeReview: { model: reviewer(asked) as never, routes: ["m/reviewer"] },
      resume: { observe: async (taskId: string) => { hostCalls.push(taskId); return hostSays; } },
      dispatch: {
        timer: new ManualTimer(), manual: true,
        local: { window: () => 32768, acceptUnenforcedLimits: true, build: () => new ScriptedWorker("host:w1", async () => ({ status: "completed", text: "done" })) },
        network: { resolve: async (h: string) => (h === "docs.example.com" ? [PUBLIC] : []), dial: () => netConnect({ host: "127.0.0.1", port: site.port }), secret: async () => undefined },
      },
    } as never);
    const ctl = c;
    const boot = await ctl.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await ctl.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<any> => (await ctl.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    assert.ok((await call(boot.token, "resource.bind", { projectId: project, kind: "repository", label: "src", locator: dir, repositoryId: "repo-main" }, "b1")).ok);
    const task = (await call(boot.token, "task.create", { projectId: project, title: "write the planting guide", repositoryId: "repo-main" }, "t1")).result.id as string;
    await ctl.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }, { action: "attempt.work", project }] });
    const ann = (await ctl.services.principals.issueCredential(rob, "agent:ann")).token;
    assert.ok((await call(boot.token, "continuation.capture", { taskId: task, ...capture }, "cap1")).ok);
    await ctl.services.configuration.change(rob, { commandId: "s1", layer: "installation", set: { "resume.externalReads": true } } as never);
    assert.ok((await call(boot.token, "network.grant", { taskId: task, host: "docs.example.com", port: 80 }, "g1")).ok);
    const start = async (id: string): Promise<any> => {
      const r = await call(boot.token, "resume.start", { taskId: task, model: { provider: "local", id: "m1" }, after: "restart" }, id); assert.ok(r.ok, JSON.stringify(r));
      assert.ok((await call(boot.token, "resume.cancel", { checkId: r.result.item.id }, `x-${id}`)).ok);
      return r.result.item;
    };
    const url = "http://docs.example.com/frost";

    // The agent notes the page; the controller reads it and keeps the text it saw (the earlier text of the reviewer's diff).
    const noted = await call(ann, "resume.dependencies.note", { taskId: task, dependencies: [{ kind: "external", key: url }] }, "n1");
    assert.ok(noted.ok, JSON.stringify(noted));
    const entry = (await call(boot.token, "resume.dependencies.get", { taskId: task })).result.item.entries[0] as { id: string; hash: string };
    assert.equal(entry.hash.replace(/^sha256:/, ""), sha(page.text));

    // The page changes. The host's port reports the entry at a hash other than the one the read found: the host's observation wins (changed), the read was still made through
    // the composed observation, and the text it found is not shown to the reviewer as the text now.
    page.text = "Plant two weeks after the last frost.\n"; page.etag = "\"v2\"";
    hostSays = { [entry.id]: { exists: true, hash: sha("Plant in June.\n"), etag: "\"v3\"" } };
    let seen = site.seen.length;
    const other = await start("r1");
    assert.ok(hostCalls.length > 0, "the host's own observe port is asked");
    assert.equal(site.seen.length, seen + 1, "the resource is read again beside the host's port, once");
    assert.deepEqual(other.delta.changed.map((x: { key: string; status: string }) => [x.key, x.status]), [[url, "changed"]], JSON.stringify(other.delta));
    let prompt = asked.join("\n");
    assert.ok(asked.length > 0, "the change is put to the reviewer");
    assert.equal(prompt.includes("Plant two weeks"), false, "a text read at another hash than the one observed is not given as the text now");
    assert.match(prompt, /change=\(not shown: "the text now could not be read here/);

    // The host reports the hash the read found: the read's text is the text now, and the reviewer is given the diff.
    hostSays = { [entry.id]: { exists: true, hash: sha(page.text), etag: "\"v2\"" } };
    asked.length = 0; seen = site.seen.length;
    const same = await start("r2");
    assert.equal(site.seen.length, seen + 1);
    assert.deepEqual(same.delta.changed.map((x: { key: string; status: string }) => [x.key, x.status]), [[url, "changed"]], JSON.stringify(same.delta));
    prompt = asked.join("\n");
    assert.match(prompt, /change="@@ line 1 @@\\n-Plant after the last frost\.\\n\+Plant two weeks after the last frost\./);

    // The host reports the recorded hash: the entry is unchanged, nothing about it is put to the reviewer, although the read found a new text.
    hostSays = { [entry.id]: { exists: true, hash: entry.hash.replace(/^sha256:/, ""), etag: "\"v1\"" } };
    // The read is still made (one bounded request per resource per observation, card L04g): "unchanged" here means nothing reaches the reviewer, not that nothing is fetched.
    asked.length = 0; seen = site.seen.length;
    const kept = await start("r3");
    assert.equal(site.seen.length, seen + 1, "the resource is still read once beside the host's port");
    assert.deepEqual(kept.delta.changed, [], JSON.stringify(kept.delta));
    assert.equal(kept.delta.unchanged, 1);
    assert.equal(asked.join("\n").includes("Plant two weeks"), false);
  } finally {
    await c?.close();
    await site.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

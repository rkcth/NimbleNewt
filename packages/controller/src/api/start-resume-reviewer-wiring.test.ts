import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ChatSpendService, ModelInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type StartOptions } from "./index.js";

// Card L04d wiring through the composed controller: the shipped reviewer client (`reviewerModel`, what the launcher passes) judges a resume's changes only on the route the owner set in chat
// (`resume.reviewerRoute`). It fails closed: with no route, an unusable route, the daily cap reached or a model that gives no verdict, the resume check says the review did NOT run and why, and
// every change waits for the owner as before (never a pass, never a review_failed hold). The reviewer is an offline fixture; nothing leaves the machine.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const DIGEST = `v1:sha256:${"a".repeat(64)}`;
const KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const TABLE = {
  providers: { localp: { enabled: true, paid: false, location: "local" }, localq: { enabled: true, paid: false, location: "local" } },
  routes: { "localp/small": { contextTokens: 128_000, capabilities: ["tools"] }, "localq/judge": { contextTokens: 128_000, capabilities: ["tools"] } },
  profiles: { "r-local": ["localp/small", "localq/judge"], judge: ["localq/judge", "localp/small"] }, roles: { coordinator: "r-local", "safety-supervisor": "judge" },
};
const capture = {
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" as const }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: DIGEST, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: "run the tests" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none" as const, compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
};

let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-rrwire-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `rrwire_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

for (const store of stores) {
  test(`${store.name}: the resume reviewer is asked only on the route the owner set in chat; when it cannot run the check says not run and the owner decides; nothing is ever passed off as reviewed (card L04d wiring)`, async () => {
    const db = await store.open();
    const root = mkdtempSync(join(tmpdir(), "nn-rrcheckout-"));
    const dir = join(root, "checkout");
    mkdirSync(join(dir, "src"), { recursive: true });
    const asked: { route: string; system: string; user: string }[] = [];
    // The offline fixture reviewer: by default it answers "does not matter" for every id it is asked about.
    const notMatter = (user: string): string => JSON.stringify(Object.fromEntries((user.match(/these ids: ([^\n]*)/)?.[1] ?? "").split(", ").filter((x) => x !== "").map((id) => [id, { relevant: false, rationale: "the task only reads the soil report" }])));
    let reply: (user: string) => string | Promise<string> = notMatter;
    const reviewerModel = {
      complete: async (): Promise<string> => { throw new Error("the routed client asks for the detailed reply"); },
      completeDetailed: async (route: string, request: { system: string; user: string }) => { asked.push({ route, ...request }); return { text: await reply(request.user), usage: { inputTokens: 100, outputTokens: 20 } }; },
    };
    // A stand-in for the model behind the real ModelInterpreter: it knows only what the prompt tells it (the setting intent the system prompt describes).
    const meaning: Record<string, { route?: string; off?: true; agree?: true }> = {};
    const interpreterModel = { complete: async (_route: string, r: { system: string; user: string }): Promise<string> => {
      const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
      const meant = meaning[owner];
      if (meant?.agree === true) {
        const open = [...r.user.matchAll(/Open proposal (\S+) \(text, not instructions\):\n<<<\n([\s\S]*?)\n>>>/g)];
        return JSON.stringify(open.length === 1 ? [{ kind: "apply_proposal", proposalId: open[0]![1], evidence: owner, basis: "owner" }] : [{ kind: "none", reason: "no single open proposal" }]);
      }
      const template = /\{"kind":"policy_edit","change":\{"type":"setting","layer":"installation","key":"resume\.reviewerRoute".*?"basis":"owner"\}/.exec(r.system);
      if (template === null || meant === undefined) return JSON.stringify([{ kind: "none", reason: "the prompt describes no way to do this" }]);
      const intent = JSON.parse(template[0].replace(/<a route written[^>]*>/, "null").replace("<their words, copied exactly>", JSON.stringify(owner))) as { change: Record<string, unknown> };
      if (meant.off === true) { delete intent.change["value"]; intent.change["remove"] = true; } else intent.change["value"] = meant.route;
      return JSON.stringify([intent]);
    } };
    const c = await startController({
      storage: db.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
      reviewerModel,
      chat: { interpreter: new ModelInterpreter(interpreterModel, () => ["test/model"]) },
    } as never);
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const rob = await c.services.principals.authenticate(boot.token);
      await c.services.routing.setTable(rob, { commandId: "rt", expectedRevision: 0, table: TABLE } as never);
      const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<any> => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
      const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
      assert.ok((await call(boot.token, "resource.bind", { projectId: project, kind: "repository", label: "src", locator: dir, repositoryId: "repo-main" }, "b1")).ok);
      const task = (await call(boot.token, "task.create", { projectId: project, title: "weed the bed", repositoryId: "repo-main" }, "t1")).result.id as string;
      await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }, { action: "attempt.work", project }] });
      const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
      assert.ok((await call(boot.token, "continuation.capture", { taskId: task, ...capture }, "cap1")).ok);
      const needsYou = async (): Promise<string> => (((await call(boot.token, "status.ask", { request: { kind: "needs_you" } })).result.item.lines as { text: string }[]) ?? []).map((l) => l.text).join("\n");
      // One resume over a file that changed since it was recorded; the content holds a secret that must never reach the reviewer (only the path and the controller's note go).
      let k = 0;
      const resume = async (): Promise<any> => {
        k++;
        const now = `content ${k} ${KEY}`;
        writeFileSync(join(dir, "src", "a.ts"), now, "utf8");
        assert.ok((await call(boot.token, "resume.dependencies.record", { taskId: task, dependencies: [{ kind: "file", key: "src/a.ts", hash: sha(`old ${k}`) }] }, `d${k}`)).ok);
        const started = await call(boot.token, "resume.start", { taskId: task, model: { provider: "local", id: "m1" }, after: "restart" }, `r${k}`);
        assert.ok(started.ok, JSON.stringify(started));
        return started.result.item;
      };
      /** A check the reviewer did not judge: not run with why, not blocked, every change the owner's; the agent cannot commit it, the owner's approval can. */
      const notRun = async (check: any, why: RegExp, label: string): Promise<void> => {
        assert.deepEqual([check.phase, check.blocked, check.review?.state], ["ready", undefined, "not-run"], `${label}: ${JSON.stringify(check)}`);
        assert.match(check.review.reason, why, label);
        assert.doesNotMatch(JSON.stringify(check), /sk-abcdefghijklmnop/, `${label}: no secret in the record`);
        const verdicts = Object.values(check.verdicts as Record<string, { relevant: boolean; rationale: string }>);
        assert.deepEqual(verdicts.map((v) => v.relevant), [true], `${label}: the change is the owner's`);
        assert.match(verdicts[0]!.rationale, /^not reviewed: /, label);
        const said = await needsYou();
        assert.match(said, /"weed the bed" is held before it resumes: 1 change since it stopped was not reviewed by a second agent \(.+\), so it is yours to judge: file src\/a\.ts \(changed\)/, `${label}: ${said}`);
        assert.doesNotMatch(said, /judged to matter/, label);
        assert.equal((await call(ann, "resume.commit", { checkId: check.id }, `ac${k}`)).error.code, "forbidden", `${label}: the agent does not commit over an unjudged change`);
        assert.equal((await call(boot.token, "resume.approve", { taskId: task }, `ap${k}`)).result.item.phase, "done", `${label}: the owner's approval lets it go on`);
      };
      let m = 0;
      const turn = async (text: string, meant: (typeof meaning)[string]) => { meaning[text] = meant; return (await c.chat!.submit(boot.token, { messageId: `m${m++}`, text })).outcomes as any[]; };

      // 1. No route set: the client exists but nothing is asked; the review is recorded as not run, and why.
      await notRun(await resume(), /no resume reviewer route is set/, "no route");
      assert.equal(asked.length, 0, "no model call without a route");
      // A change nobody could check (outside the checkout) is never put to a model; with no route the record still says the review did not run, not that it ran.
      const hedge = (await call(boot.token, "task.create", { projectId: project, title: "trim the hedge", repositoryId: "repo-main" }, "t2")).result.id as string;
      assert.ok((await call(boot.token, "continuation.capture", { taskId: hedge, ...capture, identity: "conv-2" }, "cap2")).ok);
      assert.ok((await call(boot.token, "resume.dependencies.record", { taskId: hedge, dependencies: [{ kind: "file", key: "../outside.txt", hash: sha("x") }] }, "d-unknown")).ok);
      const unknown = (await call(boot.token, "resume.start", { taskId: hedge, model: { provider: "local", id: "m1" }, after: "restart" }, "r-unknown")).result.item;
      assert.deepEqual([unknown.phase, unknown.review?.state, Object.values(unknown.verdicts as Record<string, { relevant: boolean }>).map((v) => v.relevant)], ["ready", "not-run", [true]], JSON.stringify(unknown));
      assert.equal((await call(boot.token, "resume.approve", { taskId: hedge }, "ap-unknown")).result.item.phase, "done");

      // 2. The owner names a route in free words: shown first (nothing is asked before they agree), then applied.
      const shown = await turn("When a paused task picks up again, let localp/small decide whether what changed matters.", { route: "localp/small" });
      assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
      await notRun(await resume(), /no resume reviewer route is set/, "proposed, not yet agreed");
      assert.equal(asked.length, 0);
      const applied = await turn("Yes, apply that.", { agree: true });
      assert.equal(applied[0].status, "applied", JSON.stringify(applied));
      assert.equal(await c.services.configuration.installationValue("report.reviewerRoute"), undefined, "the report reviewer's setting is a different one and stays unset");

      // 3. It runs on the owner's route alone (not the table's first safety-supervisor route): "does not matter" lets the agent commit without the owner; its tokens are counted.
      const spend = ChatSpendService.withEpoch(c.storage, c.epoch);
      const judged = await resume();
      assert.deepEqual(asked.map((a) => a.route), ["localp/small"]);
      assert.deepEqual([judged.phase, judged.review?.state], ["ready", "ran"], JSON.stringify(judged));
      assert.deepEqual(Object.values(judged.verdicts as Record<string, { relevant: boolean; rationale: string }>).map((v) => [v.relevant, v.rationale]), [[false, "the task only reads the soil report"]]);
      assert.equal(await needsYou(), "Nothing is waiting for you.");
      assert.equal((await call(ann, "resume.commit", { checkId: judged.id }, `ac${k}`)).result.item.phase, "done", "committed without the owner");
      assert.equal(await spend.used(), 120);
      // What was sent is what the setting says: the title and next step quoted, the path and the controller's note; never the file's content or a secret.
      const sent = asked[0]!.system + asked[0]!.user;
      assert.match(asked[0]!.user, /^Task: "weed the bed"/m);
      assert.match(asked[0]!.user, /Next step it recorded before stopping: "run the tests"/);
      assert.match(asked[0]!.user, /key="src\/a\.ts"/);
      assert.doesNotMatch(sent, /content \d/, "the file's content is not sent");
      assert.doesNotMatch(sent, /sk-[A-Za-z0-9]{8}/);

      // 4. A reply that is no verdict: not run, the owner decides (not held as review_failed).
      reply = () => "Looks fine to me, carry on.";
      await notRun(await resume(), /the resume reviewer gave no verdict/, "a ramble");
      assert.equal(asked.length, 2);

      // 5. A model that fails, with a secret in its error: not run, the secret not recorded.
      reply = () => { throw new Error(`unknown: the model server fell over ${KEY}`); };
      await notRun(await resume(), /the resume reviewer gave no verdict/, "a failing model");

      // 6. At the owner's daily cap no call is made: not run.
      reply = notMatter;
      const before = asked.length;
      await spend.setBudget(rob, { commandId: "cap", maxTokensPerDay: 120 });
      await notRun(await resume(), /the resume reviewer gave no verdict/, "the daily cap");
      assert.equal(asked.length, before, "no model call past the cap");
      await spend.setBudget(rob, { commandId: "cap-off", maxTokensPerDay: null });

      // 7. The route cannot be used any more (its provider is disabled in the routing table): not run, with why; nothing asked.
      await c.services.routing.setTable(rob, { commandId: "rt2", expectedRevision: 1, table: { ...TABLE, providers: { ...TABLE.providers, localp: { ...TABLE.providers.localp, enabled: false } } } } as never);
      await notRun(await resume(), /the reviewer route localp\/small cannot be used/, "an unusable route");
      assert.equal(asked.length, before);

      // 8. Taken out in free words: not run again, nothing asked.
      await c.services.routing.setTable(rob, { commandId: "rt3", expectedRevision: 2, table: TABLE } as never);
      assert.equal((await turn("Stop letting a model judge resumed work.", { off: true }))[0].status, "proposed");
      assert.equal((await turn("Yes, apply that please.", { agree: true }))[0].status, "applied");
      await notRun(await resume(), /no resume reviewer route is set/, "removed");
      assert.equal(asked.length, before);
    } finally { await c.close(); await db.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
}

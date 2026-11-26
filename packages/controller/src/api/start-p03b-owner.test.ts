import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { LocalFolderServices, type ServiceAction, type ServiceRef, type ServiceTarget } from "../service-ops/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import type { JsonObject } from "../storage/types.js";
import { startController, type StartOptions } from "./index.js";

// Card P03b, the owner's side, composed through startController with the real folder connector: the owner gives a right on ONE service resource in free-form chat and it is only proposed, with what
// it lets the agent do, and nothing is granted before the owner's yes; taking a right on one service resource back in chat applies at once, so the agent is refused on the very next call; and the owner
// reads in chat what each of the task's service operations did (confirmed with the version the service showed, refused, or not confirmed with the reason), in plain words, quoting what the service said.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(dir: string): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async (d) => ({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => undefined }) },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `p03b_owner_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

/** The real connector, with one thing a test can arm: after the next change, the file is swapped for a link to a file outside (the read-back must then not confirm it). */
function armable(inner: LocalFolderServices): ServiceTarget & { swapNext?: string } {
  const t: ServiceTarget & { swapNext?: string } = {
    observe: (r) => inner.observe(r), affects: (r) => inner.affects(r), neighbours: (r) => inner.neighbours(r), applied: (k) => inner.applied(k),
    verify: (r: ServiceRef, a: ServiceAction, b, x) => inner.verify(r, a, b, x),
    apply: async (k: string, r: ServiceRef, a: ServiceAction, c?: JsonObject) => {
      await inner.apply(k, r, a, c);
      if (t.swapNext === undefined) return;
      const p = join(inner.root, r.service, r.resource);
      unlinkSync(p); symlinkSync(t.swapNext, p);
      delete t.swapNext;
    },
  };
  return t;
}

for (const store of stores) {
  test(`${store.name}: a right on one service resource is proposed in chat with what it allows and granted only on yes, taking one back in chat applies at once, and the chat says what each operation did (card P03b)`, async () => {
    const d = mkdtempSync(join(tmpdir(), "nn-p03b-owner-"));
    const root = join(d, "services"), billing = join(root, "billing"), outside = join(d, "outside");
    mkdirSync(billing, { recursive: true }); mkdirSync(outside);
    writeFileSync(join(billing, "settings.json"), `${JSON.stringify({ replicas: 1 }, null, 2)}\n`);
    writeFileSync(join(billing, "queue.json"), "{}\n");
    writeFileSync(join(billing, "motd.txt"), "hello\n");
    writeFileSync(join(outside, "secret.txt"), "not yours\n");
    const target = armable(await LocalFolderServices.open(root));
    const opened = await store.open(d);
    const say: Record<string, unknown[]> = {};
    const c = await startController({
      storage: opened.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], artifacts: { directory: join(d, "blobs") },
      serviceTarget: target, chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    });
    try {
      const s = c.services;
      const boot = await s.principals.bootstrapOwner({ name: "rob" });
      const rob = await s.principals.authenticate(boot.token);
      const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
      const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
      const owner = (rest: Record<string, unknown>, evidence: string) => ({ kind: "command", ...rest, evidence, basis: "owner" });
      const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
      const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Tune billing" })).id;
      await c.chat!.setFocus(boot.token, { commandId: "focus", projectId: project });
      await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
      const made = await s.agents.create(rob, { commandId: "mk-ann", friendlyName: "Ann", roles: ["author"] });
      const annId = `agent:${made.id}`;
      // A right on one resource through the API (the new `resource` argument of grant.create): billing/queue.json only.
      assert.equal((await call(boot.token, "grant.create", { grantee: annId, action: "task.read", project, basis: "test" }, "g-read")).ok, true);
      const queueGrant = await call(boot.token, "grant.create", { grantee: annId, action: "effect.perform", project, resource: { kind: "service", id: "billing/queue.json" }, basis: "the queue" }, "g-queue");
      assert.equal(queueGrant.ok, true, JSON.stringify(queueGrant));
      const ann = (await s.principals.issueCredential(rob, annId)).token;
      await s.assignments.assignTask({ commandId: "as", actor: rob.id, taskId: task, owner: { kind: "agent", id: made.id } } as never);
      await s.assignments.admitAttempt({ commandId: "adm", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: made.id }, harness: "pi" } as never);
      let k = 0;
      const operate = (resource: string, action: Record<string, unknown>) => call(ann, "service.operate", { taskId: task, service: "billing", resource, action }, `op-${k++}`);
      const settings = () => JSON.parse(readFileSync(join(billing, "settings.json"), "utf8"));
      const activeRights = async (): Promise<any[]> => (await call(boot.token, "grant.list", { grantee: annId })).result.items.filter((g: any) => g.state === "active" && g.action === "effect.perform");

      // Before anything: Ann may change the queue, not the settings.
      assert.equal((await operate("queue.json", { type: "set", params: { fields: { paused: false } } })).result?.status, "confirmed");
      assert.equal((await operate("settings.json", { type: "set", params: { fields: { replicas: 2 } } })).error?.code, "forbidden");

      // WIDENING, in the owner's own words: drawn up as a proposal that says what the right lets Ann do, and nothing is granted until the owner's yes.
      const widen = "Let Ann fix billing/settings.json in Garden, she needs it to tune the replicas.";
      const shown = await turn("w1", widen, [owner({ op: "grant.create", args: { agentName: "Ann", action: "effect.perform", resource: "billing/settings.json", projectName: "Garden", basis: "she needs it to tune the replicas" } }, widen)]);
      assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
      const line = [...(shown[0]!.preview ?? []), shown[0]!.message ?? ""].join(" ");
      assert.match(line, /on the service resource billing\/settings\.json only: it may change that one resource \(each change is read back from the service before it counts\) and nothing next to it/, line);
      assert.match(line, /only in "Garden"/, line);
      assert.equal((await activeRights()).length, 1, "the proposal granted nothing");
      assert.equal((await operate("settings.json", { type: "set", params: { fields: { replicas: 2 } } })).error?.code, "forbidden", "before the owner's yes Ann is still refused");
      assert.deepEqual(settings(), { replicas: 1 }, "and the file is unchanged");
      // A resource the owner did not name is not drafted at all: the chat does not invent one.
      const invented = await turn("w0", "Let Ann fix the billing settings in Garden, she needs it to tune the replicas.", [owner({ op: "grant.create", args: { agentName: "Ann", action: "effect.perform", resource: "billing/db", projectName: "Garden", basis: "she needs it to tune the replicas" } }, "Let Ann fix the billing settings in Garden, she needs it to tune the replicas.")]);
      assert.equal(invented[0]!.status, "refused", JSON.stringify(invented));
      assert.match(invented[0]!.message ?? "", /not in your message as written.*\?$/);
      const yes = await turn("w2", `yes, go ahead ${shown[0]!.proposalId}`, [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: `go ahead ${shown[0]!.proposalId}`, basis: "owner" }]);
      assert.equal(yes[0]!.status, "applied", JSON.stringify(yes));
      const rights = await activeRights();
      assert.deepEqual(rights.map((g) => g.resource?.id).sort(), ["billing/queue.json", "billing/settings.json"], "exactly the resource shown, nothing wider");
      const setOk = await operate("settings.json", { type: "set", params: { fields: { replicas: 2 } } });
      assert.equal(setOk.result?.status, "confirmed", JSON.stringify(setOk));
      assert.deepEqual(settings(), { replicas: 2 });
      assert.equal((await operate("motd.txt", { type: "write", params: { text: "x" } })).error?.code, "forbidden", "the file next to it is not covered");

      // NARROWING, in the owner's own words: taking back the right on one service resource applies at once, and Ann is refused on her very next call.
      const queueId = queueGrant.result.id as string;
      const asked = await turn("n0", `Should I take back ${queueId}?`, [owner({ op: "grant.revoke", args: { grantId: queueId, reason: "Should I take back" } }, `Should I take back ${queueId}?`)]);
      assert.equal(asked[0]!.status, "proposed", `a question is not an order: ${JSON.stringify(asked)}`);
      assert.equal((await activeRights()).length, 2);
      await turn("n0x", `no ${asked[0]!.proposalId}`, [{ kind: "discard_proposal", proposalId: asked[0]!.proposalId, evidence: `no ${asked[0]!.proposalId}`, basis: "owner" }]);
      const narrow = `Take back ${queueId}: Ann should no longer change billing/queue.json.`;
      const cut = await turn("n1", narrow, [owner({ op: "grant.revoke", args: { grantId: queueId, reason: "Ann should no longer change billing/queue.json" } }, narrow)]);
      assert.equal(cut[0]!.status, "applied", `narrowing a service right applies at once: ${JSON.stringify(cut)}`);
      assert.deepEqual((await activeRights()).map((g) => g.resource?.id), ["billing/settings.json"]);
      const refusedNow = await operate("queue.json", { type: "set", params: { fields: { paused: true } } });
      assert.equal(refusedNow.error?.code, "forbidden", `refused on the very next call: ${JSON.stringify(refusedNow)}`);
      // Any other right taken back in the same kind of words is still shown first (only a right on one service resource is narrowed at once).
      const readGrant = (await call(boot.token, "grant.list", { grantee: annId })).result.items.find((g: any) => g.action === "task.read" && g.state === "active");
      const other = `Take back ${readGrant.id}: Ann should no longer read the tasks.`;
      const otherCut = await turn("n2", other, [owner({ op: "grant.revoke", args: { grantId: readGrant.id, reason: "Ann should no longer read the tasks" } }, other)]);
      assert.equal(otherCut[0]!.status, "proposed", JSON.stringify(otherCut));
      await turn("n2x", `no ${otherCut[0]!.proposalId}`, [{ kind: "discard_proposal", proposalId: otherCut[0]!.proposalId, evidence: `no ${otherCut[0]!.proposalId}`, basis: "owner" }]);

      // Two more operations to read about: one the service refuses (a set on a file that holds no JSON object), and one whose read-back fails.
      writeFileSync(join(billing, "notes.txt"), "plain text\n");
      assert.equal((await call(boot.token, "grant.create", { grantee: annId, action: "effect.perform", project, resource: { kind: "service", id: "billing/notes.txt" }, basis: "notes" }, "g-notes")).ok, true);
      const refused = await operate("notes.txt", { type: "set", params: { fields: { a: 1 } } });
      assert.equal(refused.result?.status, "failed", JSON.stringify(refused));
      target.swapNext = join(outside, "secret.txt");
      const unsure = await operate("settings.json", { type: "set", params: { fields: { replicas: 3 } } });
      assert.equal(unsure.result?.status, "uncertain", JSON.stringify(unsure));
      assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "not yours\n", "the outside file was read for nothing and written never");

      // THE OWNER READS IT IN CHAT: the task's view and the tools view say what each operation did, in plain words.
      const q = "What happened with Ann's changes on Tune billing?";
      const view = await turn("s1", q, [{ kind: "status", request: { kind: "task", taskTitle: "Tune billing" }, evidence: q, basis: "owner" }]);
      assert.equal(view[0]!.status, "answered", JSON.stringify(view));
      const text = (view[0]!.lines ?? []).map((l) => l.text).join("\n");
      const version = setOk.result.outcome.systemVersion as string;
      assert.ok(text.includes(`Service operation ${setOk.result.effectId}: the agent "Ann" asked for "set" on "billing/settings.json". Done and confirmed: the service was read back afterwards and showed the change (version "${version}", seen at ${setOk.result.outcome.observedAt})`), text);
      assert.match(text, new RegExp(`Service operation ${refused.result.effectId}: the agent "Ann" asked for "set" on "billing/notes.txt"\\. Not done: "billing/notes.txt does not hold a JSON object, so set cannot merge fields into it; nothing was changed"\\. Nothing was changed\\.`), text);
      assert.match(text, new RegExp(`Service operation ${unsure.result.effectId}: the agent "Ann" asked for "set" on "billing/settings.json"\\. Not confirmed: "billing/settings.json cannot be read back: the file is a link, which is not followed"\\. It may or may not have changed the service; it is not tried again by itself, and a person has to check the service and settle it\\.`), text);
      assert.doesNotMatch(text, new RegExp(`${unsure.result.effectId}[^\\n]*Done and confirmed`), "an unverified change is never called done");
      const tools = await turn("s2", "Which tools and services were used on Tune billing?", [{ kind: "status", request: { kind: "tools", taskTitle: "Tune billing" }, evidence: "Which tools and services were used on Tune billing?", basis: "owner" }]);
      assert.equal(tools[0]!.status, "answered", JSON.stringify(tools));
      const toolText = (tools[0]!.lines ?? []).map((l) => l.text).join("\n");
      for (const id of [setOk.result.effectId, refused.result.effectId, unsure.result.effectId]) assert.match(toolText, new RegExp(`Service operation ${id}: the agent "Ann"`), toolText);
      assert.doesNotMatch(toolText, /Outside action service-op/, "a service operation is told in words, not as a record kind");
    } finally {
      await c.close();
      await opened.close();
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}

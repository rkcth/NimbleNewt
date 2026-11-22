import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ModelInterpreter } from "../chat/model-interpreter.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type Controller, type StartOptions } from "./index.js";
import { OPERATION_BY_NAME } from "./operations.js";

// Card Q01b (fourth slice) through the composed controller: the owner asks in free words what was submitted on a task and whether it was reviewed or signed off; the interpreter is told of the `submissions` view in its prompt and
// picks it (no fixed phrase); the state API gives the same lines.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-q01b-view-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `q01bview_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

function fakeModel(seen: { system: string; user: string }[]) {
  return {
    complete: async (_route: string, request: { system: string; user: string }): Promise<string> => {
      seen.push(request);
      const kinds = /request\.kind is one of \(with its keys; `a\|b` means either\): (.*)$/m.exec(request.system)?.[1] ?? "";
      const kind = kinds.split("; ").find((k) => /what was submitted on a task and where each piece stands/.test(k))?.split("(")[0];
      const words = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(request.user)?.[1] ?? "";
      const title = /Fix the parser/.exec(words)?.[0];
      if (kind === undefined || title === undefined) return JSON.stringify([{ kind: "none", reason: "no view fits" }]);
      return JSON.stringify([{ kind: "status", request: { kind, taskTitle: title }, evidence: title, basis: "owner" }]);
    },
  };
}

const sha = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);
for (const store of stores) {
  test(`${store.name}: the owner asks in free words whether the parser fix was reviewed or signed off, through the model interpreter, and is told per code version; the state API shows the same; an agent sees only its own (card Q01b)`, async () => {
    const db = await store.open();
    const seen: { system: string; user: string }[] = [];
    const c: Controller = await startController({
      storage: db.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
      chat: { interpreter: new ModelInterpreter(fakeModel(seen), () => ["localp/chat"]) },
    } as never);
    try {
      const s = c.services;
      const boot = await s.principals.bootstrapOwner({ name: "rob" });
      const rob = await s.principals.authenticate(boot.token);
      const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
      const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Fix the parser" })).id;
      await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
      const hire = async (name: string, roles: string[]) => {
        const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
        const id = `agent:${made.id}`;
        await s.grants.grant(rob, { commandId: `g-${name}`, grantee: id, action: "task.read", project, source: "direct", basis: "test" } as never);
        return { id, token: (await s.principals.issueCredential(rob, id)).token };
      };
      const ann = await hire("Ann", ["author"]);
      const rev = await hire("Rev", ["reviewer"]);
      const dee = await hire("Dee", ["director"]);
      const bystander = await hire("Bystander", ["qa"]);
      await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
      await s.assignments.admitAttempt({ commandId: "adm1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
      const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
      const record = async (who: { token: string }, commandId: string, args: Record<string, unknown>): Promise<string> => {
        const r = await call(who.token, "submission.record", { taskId: task, ...args }, commandId);
        assert.equal(r.ok, true, JSON.stringify(r));
        return r.result.id as string;
      };
      await c.chat!.setFocus(boot.token, { commandId: "f1", projectId: project });
      const ask = async (messageId: string, text: string): Promise<string[]> => {
        const out = (await c.chat!.submit(boot.token, { messageId, text })).outcomes[0] as { status: string; lines?: readonly { text: string }[] };
        assert.equal(out.status, "answered", JSON.stringify(out));
        return (out.lines ?? []).map((l) => l.text);
      };

      assert.match((await ask("m0", "has anything been submitted on Fix the parser?"))[0]!, /^Nothing you may read has been submitted on Fix the parser yet/);
      const code = await record(ann, "s1", { kind: "code", role: "author", base: sha, tree, patchId: patch });
      const waiting = await ask("m1", "did anyone review the Fix the parser code yet?");
      assert.match(seen[0]!.system, /submissions\(taskId\|taskTitle\) - what was submitted on a task and where each piece stands/);
      assert.match(seen[0]!.system, /What was submitted on a task, in any words/, "the prompt describes the view with example words");
      assert.match(waiting[1]!, new RegExp(`^Newest code submission ${code} by ${ann.id} at \\S+: tree ${"b".repeat(12)}.*Review: none yet; it waits for a reviewer\\. Director sign-off: none\\.`));
      await record(rev, "s2", { kind: "review", role: "reviewer", subject: code, verdict: "approve" });
      await record(dee, "s3", { kind: "signoff", role: "director", subject: code, decision: "decline" });
      const told = await ask("m2", "has the director signed off on Fix the parser, and was it approved by a reviewer?");
      assert.match(told[1]!, new RegExp(`Review: approved by ${rev.id}\\. Director sign-off: declined by ${dee.id} \\(a project that requires the director check does not land it\\)\\.`));
      assert.match(told.join("\n"), new RegExp(`Director sign-off on ${code}: decline\\.`));

      const viewed = (await call(boot.token, "status.ask", { request: { kind: "submissions", taskId: task } })) as { ok: boolean; result?: { item: { lines: { text: string }[] } } };
      assert.ok(viewed.ok, JSON.stringify(viewed));
      assert.deepEqual(viewed.result!.item.lines.map((l) => l.text), told);
      // An agent sees only what it made or was asked to review; a bystander with task read sees nothing.
      const own = (await call(ann.token, "status.ask", { request: { kind: "submissions", taskId: task } })).result.item.lines.map((l: { text: string }) => l.text);
      assert.match(own[0], /^1 submission\(s\) of Fix the parser/);
      const none = (await call(bystander.token, "status.ask", { request: { kind: "submissions", taskId: task } })).result.item.lines.map((l: { text: string }) => l.text);
      assert.match(none[0], /^Nothing you may read has been submitted/);
      assert.equal((await call(boot.token, "status.ask", { request: { kind: "submissions", taskId: task, extra: 1 } })).ok, false);
      // The status.ask operation summary (and so the api docs) names the kind.
      assert.match(OPERATION_BY_NAME.get("status.ask")!.summary, /`submissions` \(what was submitted on a task, card Q01b:.*`\{ kind: "submissions", taskId \}`\)/);
    } finally { await c.close(); await db.close(); }
  });
}

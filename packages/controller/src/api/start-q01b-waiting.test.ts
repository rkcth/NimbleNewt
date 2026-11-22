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

// Card Q01b (fifth slice) through the composed controller: the owner asks in free words what code is waiting across the project; the interpreter is told of the `submissions_project` view in its prompt and picks it
// (no fixed phrase; the project in focus is used); the state API gives the same lines.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-q01b-waiting-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `q01bwait_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

function fakeModel(seen: { system: string; user: string }[]) {
  return {
    complete: async (_route: string, request: { system: string; user: string }): Promise<string> => {
      seen.push(request);
      const kinds = /request\.kind is one of \(with its keys; `a\|b` means either\): (.*)$/m.exec(request.system)?.[1] ?? "";
      const kind = kinds.split("; ").find((k) => /the code waiting across a project/.test(k))?.split("(")[0];
      const words = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(request.user)?.[1] ?? "";
      if (kind === undefined || !/waiting/.test(words)) return JSON.stringify([{ kind: "none", reason: "no view fits" }]);
      return JSON.stringify([{ kind: "status", request: { kind }, evidence: words, basis: "owner" }]);
    },
  };
}

const sha = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);
for (const store of stores) {
  test(`${store.name}: the owner asks in free words what code is waiting in the project, through the model interpreter, and is told per task; the state API shows the same; an agent sees only its own code (card Q01b)`, async () => {
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
      const mkTask = async (id: string, title: string): Promise<string> => {
        const t = (await s.projects.createTask({ commandId: `t-${id}`, actor: rob.id, projectId: project, title })).id;
        await s.projects.transitionTask({ commandId: `r-${id}`, actor: rob.id, taskId: t, expectedRevision: 1, to: "ready" });
        return t;
      };
      const parser = await mkTask("1", "Fix the parser");
      const lexer = await mkTask("2", "Fix the lexer");
      const hire = async (name: string, roles: string[]) => {
        const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
        const id = `agent:${made.id}`;
        await s.grants.grant(rob, { commandId: `g-${name}`, grantee: id, action: "task.read", project, source: "direct", basis: "test" } as never);
        return { id, token: (await s.principals.issueCredential(rob, id)).token };
      };
      const ann = await hire("Ann", ["author"]);
      const bob = await hire("Bob", ["author"]);
      const rev = await hire("Rev", ["reviewer"]);
      const bystander = await hire("Bystander", ["qa"]);
      for (const [n, task, who] of [["1", parser, ann], ["2", lexer, bob]] as const) {
        await s.assignments.assignTask({ commandId: `as${n}`, actor: rob.id, taskId: task, owner: { kind: "agent", id: who.id } } as never);
        await s.assignments.admitAttempt({ commandId: `adm${n}`, actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: who.id }, harness: "pi" } as never);
      }
      const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
      const record = async (who: { token: string }, commandId: string, task: string, args: Record<string, unknown>): Promise<string> => {
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

      assert.match((await ask("m0", "is any code waiting for a reviewer?"))[0]!, /^No unfinished task of this project has code you may read that is waiting/);
      assert.match(seen[0]!.system, /submissions_project\(projectId\) - the code waiting across a project/);
      assert.match(seen[0]!.system, /What code is waiting across the project, in any words/, "the prompt describes the view with example words");
      const first = await record(ann, "s1", parser, { kind: "code", role: "author", base: sha, tree, patchId: patch });
      const second = await record(bob, "s2", lexer, { kind: "code", role: "author", base: sha, tree: "d".repeat(40), patchId: patch });
      await record(rev, "s3", lexer, { kind: "review", role: "reviewer", subject: second, verdict: "approve" });
      const told = await ask("m1", "what is waiting for review right now?");
      assert.match(told[0]!, /^1 task\(s\) wait for a reviewer, 0 wait for their author \(changes were asked for\), 0 were approved but the director declined, 1 are approved with no director sign-off yet, 0 are approved and signed off;/);
      assert.match(told[1]!, new RegExp(`^Task "Fix the parser" \\(${parser}\\) waits for a reviewer: submission ${first} by ${ann.id}, tree ${"b".repeat(12)}`));
      assert.match(told[2]!, new RegExp(`^Task "Fix the lexer" \\(${lexer}\\) is approved, with no director sign-off yet: submission ${second} by ${bob.id}.*approved by ${rev.id}\\.$`));

      const viewed = (await call(boot.token, "status.ask", { request: { kind: "submissions_project", projectId: project } })) as { ok: boolean; result?: { item: { lines: { text: string }[] } } };
      assert.ok(viewed.ok, JSON.stringify(viewed));
      assert.deepEqual(viewed.result!.item.lines.map((l) => l.text), told);
      // An agent sees only the code it submitted itself, and not the review state of another's; a bystander sees none.
      const own = (await call(ann.token, "status.ask", { request: { kind: "submissions_project", projectId: project } })).result.item.lines.map((l: { text: string }) => l.text);
      assert.equal(own.length, 2);
      assert.match(own[0], /Only the code you submitted yourself is shown/);
      assert.match(own[1], /Fix the parser/);
      const none = (await call(bystander.token, "status.ask", { request: { kind: "submissions_project", projectId: project } })).result.item.lines.map((l: { text: string }) => l.text);
      assert.equal(none.length, 1);
      assert.doesNotMatch(none[0], /Fix the (parser|lexer)/);
      assert.equal((await call(boot.token, "status.ask", { request: { kind: "submissions_project", projectId: project, extra: 1 } })).ok, false);
      // The status.ask operation summary (and so the api docs) names the kind.
      assert.match(OPERATION_BY_NAME.get("status.ask")!.summary, /`submissions_project` \(the code waiting across a project, card Q01b:.*`\{ kind: "submissions_project", projectId \}`\)/);
    } finally { await c.close(); await db.close(); }
  });
}

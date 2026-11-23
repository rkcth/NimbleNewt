import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { ModelInterpreter } from "../chat/model-interpreter.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type Controller, type StartOptions } from "./index.js";
import { OPERATION_BY_NAME } from "./operations.js";

// Card Q02 (sixth slice) through the composed controller: a reviewer's verdict cites the criteria version and the owner decisions it judged against; the owner asks in free words what the reviewer decided and on what, and the
// answer (the `submissions` view, picked by the interpreter from the owner's words alone) says what the newest verdict cites. The state API enforces the same rules.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-q02-cites-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `q02cites_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
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
  test(`${store.name}: the owner asks in free words what the reviewer decided on the parser fix and is told what the verdict cites; the state API refuses a stale or unmet-less citation; agents see only their own (card Q02)`, async () => {
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
      const bystander = await hire("Bystander", ["qa"]);
      await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
      await s.assignments.admitAttempt({ commandId: "adm1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
      const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
      const record = async (who: { token: string }, commandId: string, args: Record<string, unknown>): Promise<any> => call(who.token, "submission.record", { taskId: task, ...args }, commandId);
      await c.chat!.setFocus(boot.token, { commandId: "f1", projectId: project });
      const ask = async (messageId: string, text: string): Promise<string[]> => {
        const out = (await c.chat!.submit(boot.token, { messageId, text })).outcomes[0] as { status: string; lines?: readonly { text: string }[] };
        assert.equal(out.status, "answered", JSON.stringify(out));
        return (out.lines ?? []).map((l) => l.text);
      };
      assert.equal((await call(boot.token, "contract.set", { taskId: task, expectedVersion: 0, acceptanceCriteria: ["the parser reads old files"] }, "c1")).ok, true);
      const dec = await call(boot.token, "decision.record", { projectId: project, category: "decision", topic: "format", statement: "Keep the old file format", wording: "keep reading the old file format", basedOn: 0 }, "d1");
      assert.equal(dec.ok, true, JSON.stringify(dec));
      const code = (await record(ann, "s1", { kind: "code", role: "author", base: sha, tree, patchId: patch })).result.id as string;

      // A stale version, decisions without a version, and a rejection that names nothing unmet are refused; nothing is recorded.
      const stale = await record(rev, "v0", { kind: "review", role: "reviewer", subject: code, verdict: "approve", criteriaRevision: 0, decisions: [] });
      assert.equal(stale.error.code, "stale_revision", JSON.stringify(stale));
      assert.equal((await record(rev, "v1", { kind: "review", role: "reviewer", subject: code, verdict: "reject", decisions: [dec.result.id] })).error.code, "invalid_command");
      assert.equal((await record(rev, "v2", { kind: "review", role: "reviewer", subject: code, verdict: "reject", criteriaRevision: 1 })).error.code, "invalid_command");
      assert.match((await ask("m0", "did anyone review the Fix the parser code yet?"))[1]!, /Review: none yet; it waits for a reviewer\./);

      // A rejection that cites the criteria, the decision and the unmet requirement is recorded and told.
      const rejected = await record(rev, "v3", { kind: "review", role: "reviewer", subject: code, verdict: "reject", criteriaRevision: 1, decisions: [dec.result.id], unmet: "keep reading the old file format" });
      assert.equal(rejected.ok, true, JSON.stringify(rejected));
      const told = await ask("m1", "what did the reviewer decide about the Fix the parser code, and on what?");
      assert.match(seen[seen.length - 1]!.system, /submissions\(taskId\|taskTitle\) - what was submitted on a task and where each piece stands/);
      assert.match(told[1]!, new RegExp(`Review: the newest review says reject; it waits for a new submission from its author \\(it cites criteria version 1 and decision ${dec.result.id} v1; unmet requirement: "keep reading the old file format"\\)\\. Director sign-off: none\\.`));
      // An approval that names the decision is told the same way; one that cites nothing reads as before.
      assert.equal((await record(rev, "v4", { kind: "review", role: "reviewer", subject: code, verdict: "approve", criteriaRevision: 1, decisions: [dec.result.id] })).ok, true);
      assert.match((await ask("m2", "was the Fix the parser code approved by the reviewer, and against what?"))[1]!, new RegExp(`Review: approved by ${rev.id} \\(it cites criteria version 1 and decision ${dec.result.id} v1\\)\\. Director sign-off: none\\.`));
      assert.equal((await record(rev, "v5", { kind: "review", role: "reviewer", subject: code, verdict: "approve" })).ok, true);
      assert.match((await ask("m3", "was the Fix the parser code approved by the reviewer?"))[1]!, new RegExp(`Review: approved by ${rev.id}\\. Director sign-off: none\\.`));

      // The owner changes the criteria: the old version is now stale for a new verdict.
      assert.equal((await call(boot.token, "contract.set", { taskId: task, expectedVersion: 1, acceptanceCriteria: ["the parser reads old files", "and new files"] }, "c2")).ok, true);
      assert.equal((await record(rev, "v6", { kind: "review", role: "reviewer", subject: code, verdict: "approve", criteriaRevision: 1 })).error.code, "stale_revision");
      assert.equal((await record(rev, "v7", { kind: "review", role: "reviewer", subject: code, verdict: "approve", criteriaRevision: 2, decisions: [dec.result.id] })).ok, true);

      const viewed = (await call(boot.token, "status.ask", { request: { kind: "submissions", taskId: task } })).result.item.lines.map((l: { text: string }) => l.text);
      assert.match(viewed[1], /\(it cites criteria version 2 and decision/);
      // The author reads its own code's review state; a bystander with task read sees nothing; the unknown fields stay refused.
      const own = (await call(ann.token, "status.ask", { request: { kind: "submissions", taskId: task } })).result.item.lines.map((l: { text: string }) => l.text);
      assert.match(own[1], /\(it cites criteria version 2/);
      const none = (await call(bystander.token, "status.ask", { request: { kind: "submissions", taskId: task } })).result.item.lines.map((l: { text: string }) => l.text);
      assert.match(none[0], /^Nothing you may read has been submitted/);
      assert.equal((await record(ann, "v8", { kind: "review", role: "reviewer", subject: code, verdict: "approve", criteriaRevision: 2 })).error.code, "forbidden", "a role title the agent does not hold, and its own work, are refused as before");
      assert.equal((await call(boot.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: code, verdict: "approve", criteriaRevision: 2 }, "v9")).ok, false, "the owner records no submission");
      // The task's work is linked to the decision; the owner then corrects it. Right after the correction (before propagation marks the link) every approval is refused, cited or not; a request for
      // changes is not. Once the work is revalidated against the new decision, approvals are accepted again, and a cited one names the new decision.
      assert.equal((await call(boot.token, "decision.link", { taskId: task, subject: { kind: "task", id: task }, decisions: [dec.result.id] }, "l1")).ok, true);
      assert.equal((await record(rev, "v10", { kind: "review", role: "reviewer", subject: code, verdict: "approve" })).ok, true, "a link to a decision in force changes nothing");
      const fix = await call(boot.token, "decision.record", { projectId: project, category: "decision", topic: "format", statement: "Write the new file format", wording: "write the new file format instead", basedOn: 1 }, "d2");
      assert.equal(fix.ok, true, JSON.stringify(fix));
      const fixId = (fix.result.decisionId ?? fix.result.id) as string;
      const held = await record(rev, "v11", { kind: "review", role: "reviewer", subject: code, verdict: "approve" });
      assert.equal(held.error?.code, "invalid_command", JSON.stringify(held));
      assert.match(held.error.message, new RegExp(`relies on decision ${dec.result.id}, which was superseded by ${fixId}: an approval waits until`));
      assert.equal((await record(rev, "v12", { kind: "review", role: "reviewer", subject: code, verdict: "approve", criteriaRevision: 2, decisions: [fixId] })).error?.code, "invalid_command");
      assert.equal((await record(rev, "v13", { kind: "review", role: "reviewer", subject: code, verdict: "changes" })).ok, true, "a request for changes is still recorded");
      const again = await call(boot.token, "decision.revalidate", { taskId: task, decisions: [fixId], note: "checked against the new format" }, "rv1");
      assert.equal(again.ok, true, JSON.stringify(again));
      assert.equal((await record(rev, "v14", { kind: "review", role: "reviewer", subject: code, verdict: "approve", criteriaRevision: 2, decisions: [dec.result.id] })).error?.code, "invalid_command", "the superseded decision is not in force");
      assert.equal((await record(rev, "v15", { kind: "review", role: "reviewer", subject: code, verdict: "approve", criteriaRevision: 2, decisions: [fixId] })).ok, true);
      assert.equal((await record(rev, "v16", { kind: "review", role: "reviewer", subject: code, verdict: "approve" })).ok, true);
      // The guide says what the view adds, in the words this view uses.
      const guide = readFileSync(fileURLToPath(new URL("../../../../docs/nimblenewt/user-guide.md", import.meta.url)), "utf8");
      assert.match(guide, /When the reviewer's newest verdict says what it judged against, the line adds it in brackets: the version of the task's acceptance criteria, the decisions of yours it was judged against and, for a rejection, the requirement of yours that is not met/);
      assert.match(guide, /An approval is refused while the work relies on a decision of yours that was corrected or is in dispute/);
      assert.match(OPERATION_BY_NAME.get("submission.record")!.summary + JSON.stringify(OPERATION_BY_NAME.get("submission.record")!.args), /criteriaRevision/);
    } finally { await c.close(); await db.close(); }
  });
}

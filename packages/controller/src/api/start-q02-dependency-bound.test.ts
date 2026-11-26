import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

// Card Q02 (finish) through the composed controller: the task's recorded dependencies (card C03) bind QA evidence and approvals. A file recorded again with another hash invalidates the QA evidence at once (a re-check for
// whoever recorded it) and takes the approval back; the owner asks in free words why the work did not land and is told which dependency changed. The scheduler's round (here the owner's `qa.review.sweep`, in a project
// with no review policy) asks the reviewer to review again, once, and a newer review settles it. By default a rejection names the unmet requirement. Code accepted without a review in a one-agent project stops
// counting when the owner corrects a decision it relied on. Nothing new is approved by the owner.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-q02-dep-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `q02dep_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
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
      const title = /Fix the parser|Solo work/.exec(words)?.[0];
      if (kind === undefined || title === undefined) return JSON.stringify([{ kind: "none", reason: "no view fits" }]);
      return JSON.stringify([{ kind: "status", request: { kind, taskTitle: title }, evidence: title, basis: "owner" }]);
    },
  };
}

const sha = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);
const h = (v: string): string => createHash("sha256").update(v).digest("hex");
for (const store of stores) {
  test(`${store.name}: a recorded dependency that changes invalidates the QA evidence and takes the approval back; the owner is told why in chat; a re-review is asked once and settled; a rejection names what is unmet; one-agent code is held to the same rules (card Q02)`, async () => {
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
      const O = boot.token;
      const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
      const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Fix the parser" })).id;
      await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
      const hire = async (name: string, roles: string[], where = project) => {
        const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
        const id = `agent:${made.id}`;
        await s.grants.grant(rob, { commandId: `g-${name}`, grantee: id, action: "task.read", project: where, source: "direct", basis: "test" } as never);
        return { id, token: (await s.principals.issueCredential(rob, id)).token };
      };
      const ann = await hire("Ann", ["author"]);
      const rev = await hire("Rev", ["reviewer"]);
      const qaAgent = await hire("Quinn", ["qa"]);
      await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
      await s.assignments.admitAttempt({ commandId: "adm1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
      const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
      await c.chat!.setFocus(O, { commandId: "f1", projectId: project });
      const ask = async (messageId: string, text: string): Promise<string> => {
        const out = (await c.chat!.submit(O, { messageId, text })).outcomes[0] as { status: string; lines?: readonly { text: string }[] };
        assert.equal(out.status, "answered", JSON.stringify(out));
        return (out.lines ?? []).map((l) => l.text)[1]!;
      };

      assert.equal((await call(O, "contract.set", { taskId: task, expectedVersion: 0, acceptanceCriteria: ["the parser reads old files"], checks: [{ name: "unit", run: ["true"] }] }, "c1")).ok, true);
      // The work relied on a file (the agent's word; the owner records it here for the agent).
      assert.equal((await call(O, "resume.dependencies.record", { taskId: task, dependencies: [{ kind: "file", key: "src/parser.ts", hash: h("v1") }] }, "dp1")).ok, true);
      const made = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base: sha, tree, patchId: patch }, "s1");
      assert.equal(made.ok, true, JSON.stringify(made));
      const code = made.result.id as string;
      const qa = await call(qaAgent.token, "qa.evidence.record", { submissionId: code, criteriaRevision: 1, environment: "linux", observedAt: new Date(Date.now() - 1000).toISOString(), checks: [{ name: "unit", result: "passed" }] }, "q1");
      assert.equal(qa.ok, true, JSON.stringify(qa));
      assert.equal((await call(O, "qa.evidence.gate", { submissionId: code })).result.item.verdict, "passed");
      // By default a rejection names the requirement it found unmet; the version in force is cited for it.
      const bare = await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: code, verdict: "reject" }, "v0");
      assert.equal(bare.ok, false);
      assert.match(bare.error.message, /^unmet: a rejection names the owner requirement that is not met: add unmet/);
      const rejected = await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: code, verdict: "reject", unmet: "old files with a BOM are not read" }, "v0b");
      assert.equal(rejected.ok, true, JSON.stringify(rejected));
      assert.match(((await call(O, "status.ask", { request: { kind: "submissions", taskId: task } })).result.item.lines as { text: string }[])[1]!.text, /cites criteria version 1; unmet requirement: "old files with a BOM are not read"/);
      const approve = await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: code, verdict: "approve" }, "v1");
      assert.equal(approve.ok, true, JSON.stringify(approve));
      assert.match(await ask("m1", "was the Fix the parser code approved?"), new RegExp(`Review: approved by ${rev.id}\\.`));

      // The file is recorded again with another hash. The QA evidence is invalidated at once, with a re-check for Quinn; the approval stops counting.
      assert.equal((await call(O, "resume.dependencies.record", { taskId: task, dependencies: [{ kind: "file", key: "src/parser.ts", hash: h("v2") }] }, "dp2")).ok, true);
      const listed = (await call(O, "qa.evidence.list", { taskId: task })).result;
      assert.deepEqual([listed.items[0].state, listed.items[0].reasons[0].kind, listed.rechecks[0].assignee, listed.rechecks[0].requestedBy], ["invalidated", "dependency_changed", qaAgent.id, "service:qa-evidence"]);
      assert.equal((await call(O, "qa.evidence.gate", { submissionId: code })).result.item.verdict, "failed");
      const told = await ask("m2", "why has the Fix the parser work not landed?");
      assert.match(told, new RegExp(`Review: approved by ${rev.id} at [^,]+, but that approval no longer counts and the work does not land on it: the task's recorded file dependency "src/parser\\.ts" was recorded again with a different observation at [^.]+\\.\\d+Z\\. It waits for a reviewer to review it again`));

      // The scheduler (the owner runs it here; the controller's rounds do the same) asks Rev to review again, once, in a project with no review policy.
      assert.equal((await call(O, "qa.review.policy.get", { projectId: project })).result.isDefault, true);
      const swept = await call(O, "qa.review.sweep", {}, "sw1");
      assert.equal(swept.ok, true, JSON.stringify(swept));
      const asked = (await call(rev.token, "qa.review.requests", { projectId: project })).result;
      assert.deepEqual(asked.items.map((r: any) => [r.trigger, r.assignee, r.approval]), [["reapproval", rev.id, approve.result.id]]);
      const policyLines = ((await call(O, "status.ask", { request: { kind: "qa_policy", projectId: project } })).result.item.lines as { text: string }[]).map((l) => l.text);
      assert.ok(policyLines.some((l) => new RegExp(`its approval no longer counts, so it is reviewed again \\(why: .*file dependency .*src/parser\\.ts.* was recorded again with a different observation.*\\), assigned to ${rev.id}`).test(l)), policyLines.join("\n"));
      assert.ok(policyLines.some((l) => l.includes("A rejection must name the requirement it found unmet (the default).")), policyLines.join("\n"));
      assert.equal((await call(O, "qa.review.sweep", {}, "sw2")).result.created, 0, "asked once");
      // Rev reviews again against what the work relies on now: the request is settled.
      assert.equal((await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: code, verdict: "approve" }, "v2")).ok, true);
      assert.equal((await call(O, "qa.review.sweep", {}, "sw3")).result.settled, 1);
      assert.equal((await call(O, "qa.review.requests", { projectId: project })).result.total, 0);
      assert.match(await ask("m3", "is the Fix the parser code approved now?"), new RegExp(`Review: approved by ${rev.id}\\.`));

      // A one-agent project: Sol's code is accepted without a review, against the owner's decision; the owner corrects the decision and the code no longer lands on that acceptance.
      const p2 = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Shed" })).id;
      const solo = (await s.projects.createTask({ commandId: "t2", actor: rob.id, projectId: p2, title: "Solo work" })).id;
      await s.projects.transitionTask({ commandId: "r2", actor: rob.id, taskId: solo, expectedRevision: 1, to: "ready" });
      const sol = await hire("Sol", ["author", "reviewer"], p2);
      await s.assignments.assignTask({ commandId: "as2", actor: rob.id, taskId: solo, owner: { kind: "agent", id: sol.id } } as never);
      await s.assignments.admitAttempt({ commandId: "adm2", actor: rob.id, taskId: solo, expectedRevision: (await s.assignments.getAssignment(solo))!.revision, generation: 1, owner: { kind: "agent", id: sol.id }, harness: "pi" } as never);
      const dec = await call(O, "decision.record", { projectId: p2, category: "decision", topic: "paint", statement: "Paint it green", wording: "paint the shed green", basedOn: 0 }, "d1");
      assert.equal(dec.ok, true, JSON.stringify(dec));
      assert.equal((await call(O, "decision.link", { taskId: solo, subject: { kind: "task", id: solo }, decisions: [dec.result.id] }, "l1")).ok, true);
      const soloCode = await call(sol.token, "submission.record", { taskId: solo, kind: "code", role: "author", base: sha, tree: "d".repeat(40), patchId: "e".repeat(40) }, "s2");
      assert.equal(soloCode.ok, true, JSON.stringify(soloCode));
      await c.chat!.setFocus(O, { commandId: "f2", projectId: p2 });
      assert.match(await ask("m4", "what happened to the Solo work code?"), /Review: not required \(no other agent of the project could review it\)/);
      const fix = await call(O, "decision.record", { projectId: p2, category: "decision", topic: "paint", statement: "Paint it red", wording: "paint the shed red instead", basedOn: 1 }, "d2");
      assert.equal(fix.ok, true, JSON.stringify(fix));
      assert.match(await ask("m5", "why has the Solo work not landed?"), new RegExp(`Review: accepted without a review at [^ ]+ \\(no other agent could review it\\), but that no longer counts and the work does not land on it: owner decision ${dec.result.id} was superseded by [^ ]+ at [^.]+\\.\\d+Z\\. It has to be submitted again against the current decisions and criteria, or reviewed by an agent added to the project`));
      // The guide says it in the owner's words.
      const guide = readFileSync(fileURLToPath(new URL("../../../../docs/nimblenewt/user-guide.md", import.meta.url)), "utf8");
      assert.match(guide, /The same holds when something the task recorded that it relied on changes after the approval .* the controller asks the reviewer who approved it \(or another reviewer who did not work on the task\) to review it again, once, and tells you when nobody can/);
      assert.match(guide, /Code accepted without a review because no other agent could review it is held to the same rules/);
      assert.match(guide, /By default a reviewer's rejection must name the requirement of yours that is not met/);
    } finally { await c.close(); await db.close(); }
  });
}

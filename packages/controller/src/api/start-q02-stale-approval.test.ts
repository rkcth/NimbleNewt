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

// Card Q02 (stale approvals) through the composed controller: an approval given before the owner corrects a decision the task relies on, or before the task's acceptance criteria change, stops counting. The owner asks in
// free words why the work did not land and is told (the `submissions` view, chosen by the interpreter from the owner's words alone) which decision changed, when, and that a new review is needed; the landing queue view says
// the queued work does not land now and why; a new review restores it. Nothing new is approved by the owner.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-q02-stale-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `q02stale_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
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
  test(`${store.name}: an approval given before the owner corrected a relied-on decision, or changed the criteria, stops counting; the owner is told why in chat and in the landing queue; a new review restores it (card Q02)`, async () => {
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
      const hire = async (name: string, roles: string[]) => {
        const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
        const id = `agent:${made.id}`;
        await s.grants.grant(rob, { commandId: `g-${name}`, grantee: id, action: "task.read", project, source: "direct", basis: "test" } as never);
        return { id, token: (await s.principals.issueCredential(rob, id)).token };
      };
      const ann = await hire("Ann", ["author"]);
      const rev = await hire("Rev", ["reviewer"]);
      await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
      await s.assignments.admitAttempt({ commandId: "adm1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
      const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
      const review = async (commandId: string, args: Record<string, unknown> = {}): Promise<any> => call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: code, verdict: "approve", ...args }, commandId);
      await c.chat!.setFocus(O, { commandId: "f1", projectId: project });
      const ask = async (messageId: string, text: string): Promise<string> => {
        const out = (await c.chat!.submit(O, { messageId, text })).outcomes[0] as { status: string; lines?: readonly { text: string }[] };
        assert.equal(out.status, "answered", JSON.stringify(out));
        return (out.lines ?? []).map((l) => l.text)[1]!;
      };
      const reviewLine = async (): Promise<string> => ((await call(O, "status.ask", { request: { kind: "submissions", taskId: task } })).result.item.lines as { text: string }[])[1]!.text;
      const approved = async (): Promise<boolean> => { const l = await reviewLine(); return new RegExp(`Review: approved by ${rev.id}(\\.| \\(it cites)`).test(l); };
      const queueLine = async (): Promise<string> => ((await call(O, "status.ask", { request: { kind: "landing_queue", projectId: project } })).result.item.lines as { text: string }[]).map((l) => l.text).find((t) => t.startsWith("1. "))!;

      assert.equal((await call(O, "contract.set", { taskId: task, expectedVersion: 0, acceptanceCriteria: ["the parser reads old files"] }, "c1")).ok, true);
      const dec = await call(O, "decision.record", { projectId: project, category: "decision", topic: "format", statement: "Keep the old file format", wording: "keep reading the old file format", basedOn: 0 }, "d1");
      assert.equal(dec.ok, true, JSON.stringify(dec));
      const old = dec.result.id as string;
      assert.equal((await call(O, "decision.link", { taskId: task, subject: { kind: "task", id: task }, decisions: [old] }, "l1")).ok, true);
      assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, "lb1")).ok);
      const made = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base: sha, tree, patchId: patch }, "s1");
      assert.equal(made.ok, true, JSON.stringify(made));
      const code = made.result.id as string;

      // Approved against the decision in force: it counts and is queued to land.
      assert.equal((await review("v1")).ok, true);
      assert.equal(await approved(), true);
      assert.match(await ask("m1", "was the Fix the parser code approved?"), new RegExp(`Review: approved by ${rev.id}\\.`));
      if (!(await queueLine())?.includes(code)) assert.equal((await call(O, "landing.queue.add", { submissionId: code }, "qa1")).ok, true);
      assert.doesNotMatch(await queueLine(), /does not land now/);

      // The owner corrects the decision. The earlier approval no longer counts: the owner is told which decision changed, when, and that a review is needed (not new work).
      const fix = await call(O, "decision.record", { projectId: project, category: "decision", topic: "format", statement: "Write the new file format", wording: "write the new file format instead", basedOn: 1 }, "d2");
      assert.equal(fix.ok, true, JSON.stringify(fix));
      const fixId = (fix.result.decisionId ?? fix.result.id) as string;
      assert.equal(await approved(), false);
      const told = await ask("m2", "why has the Fix the parser work not landed?");
      assert.match(told, new RegExp(`Review: approved by ${rev.id} at [^,]+, but that approval no longer counts and the work does not land on it: owner decision ${old} was superseded by ${fixId} at [^.]+\\.\\d+Z\\. It waits for a reviewer to review it again against the current decisions and criteria \\(a new approval restores it\\)\\.`));
      assert.match(await queueLine(), new RegExp(`^1\\. Task ${task}: submission ${code} .*; it does not land now: the approval by ${rev.id} at .* no longer counts: owner decision ${old} was superseded by ${fixId}`));
      // The author is told the same on its own code.
      const own = ((await call(ann.token, "status.ask", { request: { kind: "submissions", taskId: task } })).result.item.lines as { text: string }[])[1]!.text;
      assert.match(own, /but that approval no longer counts and the work does not land on it: owner decision/);

      // The work is revalidated against the new decision: the old approval was given on the old one, so it still does not count; a new review restores it.
      assert.equal((await call(O, "decision.revalidate", { taskId: task, decisions: [fixId], note: "checked against the new format" }, "rv1")).ok, true);
      assert.match(await reviewLine(), new RegExp(`no longer counts and the work does not land on it: the task has relied on owner decision ${fixId} since [^,]+, which this approval was not judged against\\.`));
      assert.equal((await review("v2")).ok, true);
      assert.equal(await approved(), true);
      assert.match(await ask("m3", "is the Fix the parser code approved now?"), new RegExp(`Review: approved by ${rev.id}\\. Director sign-off`));
      assert.doesNotMatch(await queueLine(), /does not land now/);

      // The owner changes the acceptance criteria: the approval stops counting until it is reviewed against the new version; a priority change alone does not.
      assert.equal((await call(O, "contract.set", { taskId: task, expectedVersion: 1, priority: 2 }, "c2")).ok, true);
      assert.equal(await approved(), true, "a priority change leaves the approval");
      assert.equal((await call(O, "contract.set", { taskId: task, expectedVersion: 2, acceptanceCriteria: ["the parser reads old files", "and writes new ones"] }, "c3")).ok, true);
      assert.match(await ask("m4", "why is the Fix the parser work held back?"), /no longer counts and the work does not land on it: the task contract's acceptanceCriteria changed since version 1 \(now version 3, stored at [^)]+\)\. It waits for a reviewer to review it again/);
      assert.equal((await review("v3", { criteriaRevision: 3, decisions: [fixId] })).ok, true);
      assert.equal(await approved(), true);
      assert.doesNotMatch(await queueLine(), /does not land now/);
      // The guide says it in the owner's words.
      const guide = readFileSync(fileURLToPath(new URL("../../../../docs/nimblenewt/user-guide.md", import.meta.url)), "utf8");
      assert.match(guide, /An approval given before you corrected a decision the work relies on, before that decision went into dispute, or before you changed what the task must do .* no longer counts: the work does not land on it, and the line says which decision or which part of the task changed and when; the work waits for a reviewer to review it again/);
      assert.match(guide, /When one of the first ten would not land now \(for example its approval no longer counts because a decision of yours or the task's criteria changed after it\), its line says why\./);
    } finally { await c.close(); await db.close(); }
  });
}

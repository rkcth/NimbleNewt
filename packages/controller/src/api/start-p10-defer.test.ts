import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NotificationService } from "../notifications/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);

// Card P10, twelfth slice, through the composed controller: the dispatcher's regular round moves an APPROVED first place that has held the branch for twenty-four hours to the back while another task's approved work
// waits behind it, with nobody asking to land; the owner sees the plan before and the result after in chat (the same lines as the state API), through the real chat and interpreter path (the interpreter is only
// given the owner's own words); the owner is told once; the moved work is still queued as approved.
test("the controller's round moves an approved first place past twenty-four hours to the back, and the owner sees it in chat (card P10, twelfth slice)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10d-"));
  let now = Date.now();
  const say: Record<string, unknown[]> = {};
  const seen: string[] = [];
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => { seen.push(JSON.stringify(input)); return say[input.text] ?? []; }) }, dispatch: { timer: new ManualTimer(), manual: true, clock: () => new Date(now).toISOString() } } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const O = boot.token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const hire = async (name: string, roles: string[], more: string[] = []) => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
      const id = `agent:${made.id}`;
      for (const [i, action] of ["task.read", "message.receive", ...more].entries()) await s.grants.grant(rob, { commandId: `g-${name}-${i}`, grantee: id, action, project, source: "direct", basis: "test" } as never);
      return { id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author"]);
    const rev = await hire("Rev", ["reviewer"]);
    const submit = async (title: string, n: string) => {
      const task = (await s.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId: project, title })).id;
      await s.projects.transitionTask({ commandId: `r-${n}`, actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as-${n}`, actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
      await s.assignments.admitAttempt({ commandId: `adm-${n}`, actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
      const made = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base, tree, patchId: patch }, `code-${n}`);
      assert.equal(made.ok, true, JSON.stringify(made));
      assert.ok((await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: made.result.id, verdict: "approve" }, `rev-${n}`)).ok);
      return { task, id: made.result.id as string };
    };
    assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, "lb1")).ok);
    const one = await submit("Fix the gate", "1");
    now += 1; // queued after the first one (a move needs newer work waiting behind)
    const two = await submit("Water plan", "2");
    const order = async (): Promise<string[]> => (await call(O, "landing.queue.list", { projectId: project })).result.items.map((e: any) => e.taskId);
    assert.deepEqual(await order(), [one.task, two.task]);
    const front = (await call(O, "landing.queue.list", { projectId: project })).result.front;
    assert.deepEqual([front.taskId, front.waitingForApproval, front.deferMs, front.holdMs], [one.task, false, 24 * 3_600_000, 4 * 3_600_000], JSON.stringify(front));

    await c.chat!.setFocus(O, { commandId: "f1", projectId: project });
    const ask = async (id: string, text: string): Promise<string[]> => {
      say[text] = [{ kind: "status", request: { kind: "landing_queue" }, evidence: text, basis: "owner" }];
      const out = (await c.chat!.submit(O, { messageId: id, text })).outcomes as any[];
      assert.equal(out[0].status, "answered", JSON.stringify(out));
      const api = await call(O, "status.ask", { request: { kind: "landing_queue", projectId: project } });
      const lines = (out[0].lines as { text: string }[]).map((l) => l.text);
      assert.deepEqual(lines, (api.result.item.lines as { text: string }[]).map((l) => l.text), "chat shows what the state API shows");
      return lines;
    };
    const iso = (ms: number): string => new Date(ms).toISOString().replace(/[.]/g, "\\.");
    const before = await ask("m1", "why is nothing landing?");
    const plan = before.filter((l) => /approved work is first since/.test(l));
    assert.equal(plan.length, 1, before.join("\n"));
    assert.match(plan[0]!, new RegExp(`^Task ${one.task}'s approved work is first since ${iso(Date.parse(front.since))}; if it has not landed by ${iso(Date.parse(front.since) + 24 * 3_600_000)} \\(24 h as first\\) the controller moves it to the back`));
    assert.match(plan[0]!, /nothing is removed/);

    const round = async (): Promise<any> => { const t = await c.dispatch!.dispatcher.tick(); const loop = t.loops.find((x: any) => x.name === "landing.queue.bounds"); assert.ok(loop !== undefined); assert.equal(loop.ok, true, JSON.stringify(loop)); return loop; };
    const told = async () => (await NotificationService.withEpoch(c.storage, c.epoch).inbox(rob)).items.filter((i) => i.ref.kind === "landing-move" && i.ref.id === one.task);
    // Just under the bound at a round: nothing moved.
    now = Date.parse(front.since) + 24 * 3_600_000 - 30_000;
    await round();
    assert.deepEqual(await order(), [one.task, two.task]);
    assert.equal((await told()).length, 0);
    const late = (await ask("m2", "is the queue stuck?")).filter((l) => /approved work is first since|approved work has been first since/.test(l));
    assert.equal(late.length, 1);
    // A minute on (past the throttle) the round moves it; nobody asked to land.
    now += 60_000;
    const loop = await round();
    assert.deepEqual(await order(), [two.task, one.task], JSON.stringify(loop));
    const items = await told();
    assert.equal(items.length, 1, JSON.stringify(items));
    assert.match(items[0]!.detail ?? "", /approved work had been first for a day without landing/);
    assert.equal(items[0]!.level, "notice", "a notice: nothing is needed from the owner");
    assert.match(items[0]!.detail ?? "", /moved to the back/);
    // An open item about the same task (the hold escalation: no director could be told, so it needs the owner) keeps its own text: the move is not merged into it.
    const same = (await NotificationService.withEpoch(c.storage, c.epoch).inbox(rob)).items.filter((i) => i.ref.kind === "task" && i.ref.id === one.task);
    assert.ok(same.length >= 1, "the hold escalation is open");
    assert.ok(same.every((i) => !/moved to the back|nothing is needed from you/.test(i.detail ?? "")), JSON.stringify(same));
    await round(); now += 120_000; await round(); await round();
    assert.equal((await told()).length, 1, "later rounds tell nobody again");
    const items2 = (await call(O, "landing.queue.list", { projectId: project })).result.items;
    assert.deepEqual(items2.map((e: any) => [e.taskId, e.submissionId]), [[two.task, two.id], [one.task, one.id]], "both submissions are still queued as approved");
    // The owner sees the new first place (with its own count) in chat, and the interpreter was only ever given the owner's own words.
    const after = await ask("m3", "what is first in the queue now?");
    assert.ok(after.some((l) => l.startsWith(`Task ${two.task}'s approved work is first since`)), after.join("\n"));
    assert.ok(seen.every((x) => !/approved work is first since|moved it to the back|moved to the back/.test(x)), "the interpreter sees no earlier answer");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

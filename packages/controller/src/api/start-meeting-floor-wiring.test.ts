import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { defaultReply } from "../meetings/floor-suite.js";
import { startController } from "./index.js";

// The running controller (card M05): an agent's answer to the owner has its cited sources checked (a changed one is marked stale, another project's is not checked), and when the owner ends the meeting what it left open
// becomes follow-up tasks given to the agents that own them.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("in the running controller a changed source is marked stale, another project's is not checked, and the owner's end of a meeting makes its follow-ups, each given to its agent (card M05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-mfw-"));
  const clock = Date.now();
  let cites = "";
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000, clock: () => new Date(clock).toISOString() },
    notifications: { clock: () => new Date(clock).toISOString() },
    meetingFloor: { runner: { turn: async (r) => (r.kind === "owner-answer" ? { text: `ANSWER: It runs at midnight.\nSOURCES: ${cites}\nCOMPLETED: none\nPROPOSED: none\nINVESTIGATE: measure the warm cache for a week`, usage: { visibleTokens: 20, hiddenTokens: 0 } } : defaultReply(r)) } },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = (await c.services.principals.authenticate(boot.token))!;
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const ok = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => { const r = await call(token, op, args, commandId); assert.ok(r.ok, `${op}: ${JSON.stringify(r)}`); return r.result; };
    const project = (await ok(boot.token, "project.create", { name: "Garden" }, "p1")).id as string;
    const elsewhere = (await ok(boot.token, "project.create", { name: "Shed" }, "p2")).id as string;
    const task = await ok(boot.token, "task.create", { projectId: project, title: "Warmer" }, "t1");
    await ok(boot.token, "task.update", { taskId: task.id, expectedRevision: task.revision, title: "Warmer v2" }, "t1u");
    const away = await ok(boot.token, "task.create", { projectId: elsewhere, title: "Hidden" }, "t2");
    await ok(boot.token, "task.update", { taskId: away.id, expectedRevision: away.revision, title: "Hidden v2" }, "t2u");
    cites = `task:${task.id}@1, task:${away.id}@1`;
    const tokens = new Map<string, string>();
    for (const name of ["ann", "bob", "cat"]) {
      await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants: [{ action: "task.read", project }, { action: "meeting.attend", project }] });
      tokens.set(name, (await c.services.principals.issueCredential(rob, `agent:${name}`)).token);
    }
    const urgent = await ok(boot.token, "meeting.call-urgent", { projectId: project, title: "Beds", reason: "frost tonight", roster: ["agent:ann", "agent:bob", "agent:cat"], durationMinutes: 180 }, "mu1");
    const rec = (await ok(boot.token, "meeting.record.open", { occurrenceId: urgent.id, chair: "agent:cat" }, "mo1")).id as string;
    for (const [name, token] of tokens) await ok(token, "meeting.record.join", { recordId: rec }, `j${name}`);
    await ok(boot.token, "meeting.floor.start", { recordId: rec, motion: { text: "Cover the beds tonight." } }, "fs1");
    await ok(boot.token, "meeting.floor.ask", { recordId: rec, agent: "agent:bob", question: "When does the warmer run?" }, "fa1");
    const odd = await call(boot.token, "meeting.floor.drive", { recordId: rec, maxUnits: 1, extra: true }, "fd0");
    assert.equal(odd.ok, false, "an unknown field is still refused");
    await ok(boot.token, "meeting.floor.drive", { recordId: rec, maxUnits: 200 }, "fd1");
    const before = (await ok(boot.token, "meeting.floor.state", { recordId: rec })).item;
    const answer = before.ownerAnswers.at(-1);
    assert.deepEqual(answer.stale, [`task:${task.id}@1 (now at revision 2)`], JSON.stringify(answer));
    assert.deepEqual(answer.unchecked, [`task:${away.id}@1`], "another project's task is not checked");
    await ok(boot.token, "meeting.floor.end", { recordId: rec }, "fe1");
    const after = (await ok(boot.token, "meeting.floor.state", { recordId: rec })).item;
    assert.ok(typeof after.followUpsAt === "string", JSON.stringify(after.followUps));
    const inv = (after.followUps as { title: string; taskId: string; owner?: string; assigned?: boolean }[]).find((f) => f.title.startsWith("Investigate: measure the warm cache"))!;
    assert.deepEqual([inv.owner, inv.assigned], ["agent:bob", true]);
    assert.deepEqual((await c.services.assignments.getAssignment(inv.taskId))?.owner, { kind: "agent", id: "bob" }, "the follow-up is bob's");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

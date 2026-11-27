import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

// Card B06 (first slice) in the composed controller: with the feature off an agent's request is refused saying the owner can enable it; the owner enables it naming the development project; the agent asks;
// no attempt starts in that project on a task no request made, nor before approval; the owner's approval makes the task and its attempt starts through the controller's own attempt gate (alongside the harness
// check); after a restart the owner withdraws the approval and the next attempt is refused. Tasks of other projects start as before throughout.
test("work on NimbleNewt's own code through the running controller: off by default, asked ahead, owner-approved, gated at attempt start, withdrawn (card B06)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-b06-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }) } });
  let c = await open();
  let n = 0;
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const devProject = (await c.services.projects.createProject({ commandId: "p-dev", actor: rob.id, name: "NimbleNewt development" })).id;
    const garden = (await c.services.projects.createProject({ commandId: "p-garden", actor: rob.id, name: "Garden" })).id;
    const made = await c.services.agents.create(rob, { commandId: "mk-ann", friendlyName: "Ann", roles: ["author"] });
    const ann = `agent:${made.id}`;
    const annToken = (await c.services.principals.issueCredential(rob, ann)).token;
    /** Makes the task ready (if new), assigns it to Ann (if not assigned) and admits an attempt in the pi harness through the composed controller's assignments; returns the attempt ID. */
    const start = async (taskId: string): Promise<string> => {
      const s = c.services;
      const t = (await s.projects.getTask(taskId))!;
      if (t.state === "proposed") await s.projects.transitionTask({ commandId: `r${++n}`, actor: rob.id, taskId, expectedRevision: t.revision, to: "ready" });
      let a = await s.assignments.getAssignment(taskId);
      if (a === undefined || a.state !== "assigned") { await s.assignments.assignTask({ commandId: `as${++n}`, actor: rob.id, taskId, owner: { kind: "agent", id: ann }, ...(a === undefined ? {} : { expectedRevision: a.revision }) }); a = await s.assignments.getAssignment(taskId); }
      return (await s.assignments.admitAttempt({ commandId: `ad${++n}`, actor: "inbox", taskId, expectedRevision: a!.revision, generation: a!.generation, owner: { kind: "agent", id: ann }, harness: "pi" })).id;
    };
    const finish = async (taskId: string, attemptId: string): Promise<void> => {
      const a = (await c.services.assignments.getAssignment(taskId))!;
      await c.services.assignments.finishAttempt({ commandId: `f${++n}`, actor: "inbox", taskId, expectedRevision: a.revision, fence: { generation: a.generation, attemptId }, outcome: "succeeded" });
    };
    const ask = { what: "list blocked tasks first in the stand-up brief", why: "owners miss them", effort: "two hours", cost: "a few cents" };

    // Off by default.
    const settings0 = await call(boot.token, "owncode.settings", {});
    assert.deepEqual(settings0.result, { revision: 0, enabled: false, history: [] }, JSON.stringify(settings0));
    assert.equal((await call(annToken, "owncode.settings", {})).error.code, "forbidden");
    const off = await call(annToken, "owncode.request", ask, "ask-0");
    assert.equal(off.error.code, "unavailable", JSON.stringify(off));
    assert.match(off.error.message, /off in this installation\. The owner can enable it/);

    assert.equal((await call(annToken, "owncode.enable", { projectId: devProject }, "en-x")).error.code, "forbidden", "an agent cannot enable it");
    const enabled = await call(boot.token, "owncode.enable", { projectId: devProject }, "en-1");
    assert.deepEqual(enabled.result, { revision: 1, projectId: devProject }, JSON.stringify(enabled));

    // A task of the development project that no approved request made does not start; one of another project does.
    const byHand = (await c.services.projects.createTask({ commandId: "t-hand", actor: rob.id, projectId: devProject, title: "by hand" })).id;
    await assert.rejects(() => start(byHand), /came from no approved request/);
    const weed = (await c.services.projects.createTask({ commandId: "t-weed", actor: rob.id, projectId: garden, title: "weed" })).id;
    assert.ok(await start(weed));

    const asked = await call(annToken, "owncode.request", ask, "ask-1");
    assert.ok(asked.ok, JSON.stringify(asked));
    const id = asked.result.id as string;
    assert.equal((await call(annToken, "owncode.decide", { requestId: id, expectedRevision: 1, decision: "approve" }, "d-x")).error.code, "forbidden", "only the owner approves");
    const mine = await call(annToken, "owncode.list", {});
    assert.deepEqual(mine.result.items.map((i: { id: string; status: string }) => [i.id, i.status]), [[id, "pending"]]);
    const approved = await call(boot.token, "owncode.decide", { requestId: id, expectedRevision: 1, decision: "approve", note: "go ahead" }, "d-1");
    assert.equal(approved.result.status, "approved", JSON.stringify(approved));
    const taskId = approved.result.taskId as string;
    assert.equal((await c.services.projects.getTask(taskId))!.projectId, devProject);
    const first = await start(taskId);
    await finish(taskId, first);

    // A restart keeps the settings, the request and the gate.
    await c.close();
    c = await open();
    const got = (await call(annToken, "owncode.get", { requestId: id })).result.item;
    assert.deepEqual([got.status, got.taskId, got.decidedBy], ["approved", taskId, rob.id]);
    assert.equal((await call(annToken, "owncode.withdraw", { requestId: id, expectedRevision: got.revision, reason: "mine" }, "w-x")).error.code, "forbidden", "the requester cannot withdraw an approval");
    const withdrawn = await call(boot.token, "owncode.withdraw", { requestId: id, expectedRevision: got.revision, reason: "no longer wanted" }, "w-1");
    assert.ok(withdrawn.ok, JSON.stringify(withdrawn));
    await assert.rejects(() => start(taskId), /the owner withdrew the approval/);
    // Off again: the development project is closed to work, other projects are not.
    const s1 = (await call(boot.token, "owncode.settings", {})).result;
    assert.ok((await call(boot.token, "owncode.disable", { expectedRevision: s1.revision }, "dis-1")).ok);
    await assert.rejects(() => start(byHand), /The owner can enable it/);
    const sow = (await c.services.projects.createTask({ commandId: "t-sow", actor: rob.id, projectId: garden, title: "sow" })).id;
    assert.ok(await start(sow));
    assert.equal((await call(boot.token, "owncode.list", { status: "withdrawn" })).result.items.length, 1);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

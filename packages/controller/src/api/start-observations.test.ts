import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

// Card B02 in the composed controller: a failed review and a denied request become observations by themselves, an agent's retelling of the same review joins it, the owner reads them, and a restart counts nothing twice.
test("a failed review and a denied request are observed by the running controller, an agent's retelling joins, the owner sees one each, and after a restart nothing is counted twice (card B02)", async (ctx) => {
  // The observation rate is counted per UTC hour on the system clock, so Date is held at one instant: on the real clock a run that crossed an hour counted
  // the two observations in two hours (1 or 0, not 2).
  ctx.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-26T12:30:00.000Z") });
  const d = mkdtempSync(join(tmpdir(), "nn-obs-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI] });
  let c = await open();
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Write the login" })).id;
    const hire = async (n: string, roles: string[], extra: string[] = []) => {
      const made = await s.agents.create(rob, { commandId: `mk-${n}`, friendlyName: n, roles });
      const id = `agent:${made.id}`;
      for (const action of ["task.read", ...(roles.includes("reviewer") ? ["review.decide"] : []), ...extra]) await s.grants.grant(rob, { commandId: `g-${n}-${action}`, grantee: id, action, project, source: "direct", basis: "test" } as never);
      return { id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author"], ["meeting.agenda", "review.request", "attempt.work", "tool.run-script"]);
    const rev = await hire("Rev", ["reviewer"]);
    const zed = await hire("Zed", ["author"]);
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
    await s.assignments.admitAttempt({ commandId: "adm1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
    const sbm = (await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base: "a".repeat(40), tree: "b".repeat(40), patchId: "c".repeat(40) }, "s1")).result.id as string;
    // An approving review is not a failure; one asking for changes is.
    const reviewed = await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: sbm, verdict: "changes" }, "rv1");
    assert.ok(reviewed.ok, JSON.stringify(reviewed));
    const list = async () => (await call(boot.token, "observation.list", { projectId: project })).result.item;
    const first = await list();
    assert.equal(first.items.length, 1, JSON.stringify(first));
    const obs = first.items[0];
    assert.deepEqual([obs.kind, obs.origin, obs.reportedBy, obs.sources, obs.taskId], ["failed-review", "controller", "service:observations", [{ kind: "submission", id: reviewed.result.id }], task]);
    assert.match(obs.summary, /asked for changes to the work submitted on task/);

    // The author tells the same review again as friction: one observation, two reports. A stranger to the meetings sees nothing.
    const told = await call(ann.token, "observation.submit", { projectId: project, summary: "my change was sent back for the error path", sources: [{ kind: "submission", id: reviewed.result.id }] }, "f1");
    assert.deepEqual([told.result.outcome, told.result.id], ["joined", obs.id], JSON.stringify(told));
    assert.equal((await call(zed.token, "observation.submit", { projectId: project, summary: "me too" }, "f2")).error.code, "forbidden");
    assert.equal((await call(zed.token, "observation.list", { projectId: project })).error.code, "not_found");
    assert.equal((await call(ann.token, "observation.get", { observationId: obs.id })).result.item.reporters.length, 1, "a reporter sees only itself");

    // A request the owner denies is a correction, observed once.
    const asked = await s.reviews.request(await s.principals.authenticate(ann.token), { commandId: "rq1", taskId: task, operation: { name: "run-script", args: { cwd: "/work" }, script: "rm -rf build\n", target: { kind: "workspace", id: "main" } }, note: "clean up", context: { toolVersion: "1", authoritySource: "task grant", expectedEffects: ["cleans"], affectedResources: ["workspace:main"] } } as never);
    const pending = (await c.storage.getAggregate({ kind: "review", id: asked.id }))!;
    await s.reviews.decide(rob, { commandId: "dn1", requestId: asked.id, expectedRevision: pending.revision, verdict: "deny", reason: "not on the shared tree" });
    const second = await list();
    assert.equal(second.items.length, 2);
    const correction = second.items.find((x: { kind: string }) => x.kind === "correction");
    assert.deepEqual([correction.sources, correction.detail], [[{ kind: "review", id: asked.id }], "not on the shared tree"]);
    assert.match(correction.summary, /denied a request to use run-script/);

    // The owner's status view names both, in plain lines.
    const view = await call(boot.token, "status.ask", { request: { kind: "observations", projectId: project } });
    assert.ok(view.ok, JSON.stringify(view));
    const lines = (view.result.item.lines as { text: string }[]).map((l) => l.text).join("\n");
    assert.match(lines, /2 open observation\(s\)/);
    assert.match(lines, /failed-review \(seen by the controller, 2 reports from 2 reporter\(s\)/);

    // A restart: the hooks' command IDs are stable, so the same events told again are answered with what was recorded.
    await c.close();
    c = await open();
    const replayed = await c.api.handle(rev.token, { v: 1, op: "submission.record", commandId: "rv1", args: { taskId: task, kind: "review", role: "reviewer", subject: sbm, verdict: "changes" } } as never) as any;
    assert.ok(replayed.ok, JSON.stringify(replayed));
    await c.services.reviews.decide(rob, { commandId: "dn1", requestId: asked.id, expectedRevision: pending.revision, verdict: "deny", reason: "not on the shared tree" });
    const again = (await c.api.handle(boot.token, { v: 1, op: "observation.list", args: { projectId: project } } as never) as any).result.item;
    assert.deepEqual(again.items.map((x: { id: string; reports: number }) => [x.id, x.reports]), second.items.map((x: { id: string; reports: number }) => [x.id, x.reports]));
    assert.equal(again.rate.created, 2);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

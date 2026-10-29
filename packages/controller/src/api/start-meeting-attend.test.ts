import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { ProjectPlanService } from "../projects/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a meeting room is opened, joined, left and ended through the state API, and agents cannot run another's attendance (card M04b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-attend-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const a = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    const b = (await c.services.agents.create(rob, { commandId: "ag-b", friendlyName: "B" })).id;
    const grant = async (agent: string) => { const pid = `agent:${agent}`; const f = await c.storage.getAggregate({ kind: "principal", id: pid }); await c.services.principals.setGrants(rob, { commandId: `g-${agent}`, principalId: pid, expectedRevision: f!.revision, grants: [{ action: "history.*", project }, { action: "task.read", project }] }); return (await c.services.principals.issueCredential(rob, pid)).token; };
    const ta = await grant(a); const tb = await grant(b);
    const proj = await c.storage.getAggregate({ kind: "project", id: project });
    await ProjectPlanService.withEpoch(c.storage, c.epoch).setPlan(rob, { commandId: "pl", projectId: project, expectedRevision: proj!.revision, participants: [{ principalId: `agent:${a}` }, { principalId: `agent:${b}` }] } as never);

    const room = await call(boot.token, "meeting.attend.call-now", { projectId: project, title: "Frost", reason: "frost tonight", scope: { kind: "project" } }, "cn1");
    assert.ok(room.ok, JSON.stringify(room));
    assert.equal(room.result.status, "started", JSON.stringify(room));
    const occ = room.result.occurrenceId as string;
    const status = await call(boot.token, "meeting.attend.status", { occurrenceId: occ });
    assert.ok(status.ok, JSON.stringify(status));
    const prep = await call(boot.token, "meeting.attend.prepare", { occurrenceId: occ, agent: `agent:${a}`, interrupted: [] }, "pr1");
    assert.ok(prep.ok, JSON.stringify(prep));
    assert.equal((await call(tb, "meeting.attend.prepare", { occurrenceId: occ, agent: `agent:${a}`, interrupted: [] }, "pr2")).ok, false, "B cannot prepare A");
    const join = await call(ta, "meeting.attend.join", { occurrenceId: occ, agent: `agent:${a}` }, "j1");
    assert.ok(join.ok && join.result.joined === true, JSON.stringify(join));
    assert.equal((await call(tb, "meeting.attend.join", { occurrenceId: occ, agent: `agent:${a}` }, "j2")).ok, false, "B cannot join for A");
    assert.ok((await call(ta, "meeting.attend.leave", { occurrenceId: occ, agent: `agent:${a}` }, "l1")).ok);
    const ended = await call(boot.token, "meeting.attend.end", { occurrenceId: occ }, "e1");
    assert.ok(ended.ok, JSON.stringify(ended));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

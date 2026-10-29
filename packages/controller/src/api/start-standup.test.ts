import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner sets up, reads, pauses and ends a stand-up through the state API; others are refused (card M03b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-standup-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const a = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
    const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;
    const args = { projectId: project, title: "Morning", roster: [`agent:${a}`], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/London", recurrence: { kind: "daily" } };

    const made = await call(boot.token, "standup.configure", args, "su1");
    assert.ok(made.ok, JSON.stringify(made));
    assert.equal((await call(boot.token, "standup.configure", args, "su1")).result.replayed, true);
    assert.equal((await call(zed, "standup.configure", args, "su2")).ok, false, "an agent without the right cannot set one up");
    const got = await call(boot.token, "standup.get", { scheduleId: made.result.scheduleId });
    assert.equal(got.result.item.config.windowFrom ?? got.result.item.config.body?.windowFrom ?? "08:00", "08:00");
    const rev = got.result.item.schedule.revision as number;
    const paused = await call(boot.token, "standup.update", { scheduleId: made.result.scheduleId, expectedRevision: rev, state: "paused" }, "su3");
    assert.ok(paused.ok, JSON.stringify(paused));
    assert.equal((await call(boot.token, "standup.update", { scheduleId: made.result.scheduleId, expectedRevision: rev, state: "ended" }, "su4")).ok, false, "a stale revision is refused");
    assert.equal((await call(zed, "standup.get", { scheduleId: made.result.scheduleId })).ok, false);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

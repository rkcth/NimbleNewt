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

test("the stand-up's balance review shows the P/PC allocation the owner configured, read through the running controller (card M03g)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-standup-alloc-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
    const a = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    const review = async (key: string): Promise<{ floor?: number; target?: number; ceiling?: number; text: string }> => {
      const m = await call("meeting.call-urgent", { projectId: project, title: `Sync ${key}`, reason: "check", roster: [`agent:${a}`] }, `u-${key}`);
      assert.ok(m.ok, JSON.stringify(m));
      assert.ok((await call("standup.prepare", { occurrenceId: m.result.id }, `pp-${key}`)).ok);
      return JSON.stringify((await call("standup.prepared", { occurrenceId: m.result.id })).result.item.review) as never;
    };
    const before = await review("1") as unknown as string;
    assert.doesNotMatch(before, /ceiling 50%/);
    const staged = await c.services.configuration.stage(rob, { commandId: "cfg1", layer: "installation", set: { "workClass.pcFloor": 10, "workClass.pcTarget": 30, "workClass.pcCeiling": 50 } });
    await c.services.configuration.apply(rob, { commandId: "cfg2", layer: "installation", expectedRevision: staged.revision });
    const after = await review("2") as unknown as string;
    assert.match(after, /planned PC share: floor 10%, target 30%, ceiling 50%/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("integration policy: a project gets the installation default or the profile's setting when created and keeps it; only the owner changes it; the lock holds main-automatic back (card P08)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-integration-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "project.read", project: "*" }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const make = async (name: string, id: string) => (await call(boot.token, "project.create", { name }, id)).result.id as string;

    // No default, strict profile: a human promotes.
    const a = await make("A", "c1");
    const first = (await call(boot.token, "integration.get", { project: a })).result.item;
    assert.deepEqual([first.landing, first.integrator, first.source, first.requiredChecks], ["human-promotes", "agent", "profile", ["tests", "review"]]);
    // An installation default applies to new projects only.
    assert.ok((await call(boot.token, "integration.default.set", { landing: "main-automatic", refreshRounds: 2 }, "d1")).ok);
    const b = await make("B", "c2");
    const second = (await call(boot.token, "integration.get", { project: b })).result.item;
    assert.deepEqual([second.landing, second.source, second.refreshRounds], ["main-automatic", "installation-default", 2]);
    assert.equal((await call(boot.token, "integration.get", { project: a })).result.item.landing, "human-promotes", "the earlier project is untouched");
    // The owner changes a project, with a revision check; other fields stay.
    const set = await call(boot.token, "integration.set", { project: a, landing: "integration-branch", requiredChecks: ["review", "tests", "tests"], expectedRevision: first.revision }, "s1");
    assert.ok(set.ok, JSON.stringify(set));
    const third = (await call(boot.token, "integration.get", { project: a })).result.item;
    assert.deepEqual([third.landing, third.source, third.requiredChecks, third.integrator], ["integration-branch", "owner", ["tests", "review"], "agent"]);
    assert.equal((await call(boot.token, "integration.set", { project: a, landing: "human-promotes", expectedRevision: first.revision }, "s2")).error.code, "stale_revision");
    // Promotion to main with no check at all is refused.
    assert.equal((await call(boot.token, "integration.set", { project: a, landing: "main-automatic", requiredChecks: [] }, "nochk")).error.code, "invalid_command");
    // Bad values are refused.
    for (const args of [{ landing: "yolo" }, { refreshRounds: 11 }, { requiredChecks: ["magic"] }, { integrator: "bot" }, { surprise: 1 }, {}])
      assert.equal((await call(boot.token, "integration.set", { project: a, ...args }, `bad-${JSON.stringify(args)}`)).error.code, "invalid_command", JSON.stringify(args));
    // Only the owner reads or changes it.
    for (const [op, args] of [["integration.get", { project: a }], ["integration.set", { project: a, landing: "main-automatic" }], ["integration.default.get", {}], ["integration.default.set", { landing: "human-promotes" }]] as const)
      assert.equal((await call(ann, op, args as never, op.endsWith("set") ? "ann-1" : undefined)).error.code, "forbidden", op);
    // The lock: no project may be set to main-automatic, one already so is held back, and the default cannot be main-automatic under it.
    assert.ok((await call(boot.token, "integration.default.set", { forbidMainAutomatic: true }, "d2")).ok, "the lock always applies, even over a default of main-automatic");
    assert.deepEqual([(await call(boot.token, "integration.default.get", {})).result.item.landing, (await call(boot.token, "integration.default.get", {})).result.item.forbidMainAutomatic], ["integration-branch", true]);
    assert.equal((await call(boot.token, "integration.default.set", { landing: "main-automatic" }, "d2b")).error.code, "invalid_command", "no default of main-automatic under the lock");
    assert.ok((await call(boot.token, "integration.default.set", { landing: "human-promotes" }, "d3")).ok);
    assert.equal((await call(boot.token, "integration.set", { project: a, landing: "main-automatic" }, "s3")).error.code, "forbidden");
    const held = (await call(boot.token, "integration.get", { project: b })).result.item;
    assert.deepEqual([held.landing, held.lockedMainAutomatic, held.heldFrom], ["integration-branch", true, "main-automatic"], "the owner can see what is held back");
    assert.equal((await call(boot.token, "integration.set", { project: a, landing: "integration-branch", requiredChecks: [] }, "s4")).ok, true, "no checks are fine short of main");
    assert.ok((await call(boot.token, "integration.default.set", { forbidMainAutomatic: false }, "d4")).ok);
    assert.equal((await call(boot.token, "integration.get", { project: b })).result.item.landing, "main-automatic", "lifting the lock restores what the owner chose");
    // Replay: the same command ID is the same answer.
    const beforeReplay = (await call(boot.token, "integration.get", { project: a })).result.item.revision;
    const again = await call(boot.token, "integration.set", { project: a, landing: "integration-branch", requiredChecks: ["review", "tests", "tests"], expectedRevision: first.revision }, "s1");
    assert.ok(again.ok);
    assert.equal((await call(boot.token, "integration.get", { project: a })).result.item.revision, beforeReplay, "a replay changes nothing");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

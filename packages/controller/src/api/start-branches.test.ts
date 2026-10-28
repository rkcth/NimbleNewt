import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ProtectedBranchService } from "../policy/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner sets which branches of a project are protected through the state API; main and master are protected until then; an unnamed or malformed branch counts as protected; nobody else can read or change it (card A07f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-branches-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const branches = ProtectedBranchService.withEpoch(c.storage, c.epoch);
    // Until the owner sets it: main and master.
    const first = await call(boot.token, "project.branches.get", { project });
    assert.deepEqual([first.result.item.protected, first.result.item.isDefault, first.result.item.revision], [["main", "master"], true, 0]);
    assert.deepEqual([await branches.isProtected(project, "main"), await branches.isProtected(project, "master"), await branches.isProtected(project, "feature-x")], [true, true, false]);
    // The owner's list replaces the default; a prefix covers a family of branches.
    const set = await call(boot.token, "project.branches.set", { project, protected: ["trunk", "release/*"], landing: "integration" }, "b1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.deepEqual([await branches.isProtected(project, "trunk"), await branches.isProtected(project, "release/2.0"), await branches.isProtected(project, "main"), await branches.isProtected(project, "releases")], [true, true, false, false], "the owner's list is the whole list");
    const got = (await call(boot.token, "project.branches.get", { project })).result.item;
    assert.deepEqual([got.protected, got.landing, got.isDefault], [["release/*", "trunk"], "integration", false]);
    // A branch that is not named, or not a valid name, counts as protected.
    assert.equal(await branches.isProtected(project, undefined), true);
    assert.equal(await branches.isProtected(project, "../main"), true);
    assert.equal(await branches.isProtected(project, "a b"), true);
    // Stale revisions, bad input, and a replay.
    assert.equal((await call(boot.token, "project.branches.set", { project, protected: ["main"], expectedRevision: 0 }, "b2")).error?.code, "stale_revision");
    assert.equal((await call(boot.token, "project.branches.set", { project, protected: ["*"] }, "b3")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "project.branches.set", { project, protected: ["a..b"] }, "b4")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "project.branches.set", { project }, "b5")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "project.branches.set", { project: "nope", protected: ["main"] }, "b6")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "project.branches.set", { project, protected: ["trunk", "release/*"], landing: "integration" }, "b1")).result?.revision, set.result.revision, "a replay answers the same");
    // Landing can be cleared; the list stays.
    await call(boot.token, "project.branches.set", { project, landing: null }, "b7");
    const cleared = (await call(boot.token, "project.branches.get", { project })).result.item;
    assert.deepEqual([cleared.protected, cleared.landing], [["release/*", "trunk"], undefined]);
    // Only the owner reads or changes it.
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "project.update", project }, { action: "project.read", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    assert.equal((await call(ann, "project.branches.get", { project })).error?.code, "forbidden");
    assert.equal((await call(ann, "project.branches.set", { project, protected: [] }, "b8")).error?.code, "forbidden");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

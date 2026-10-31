import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { personalNamespace } from "../catalog/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const manifest = {
  purpose: "check a page", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/check.js", interpreter: { name: "node", version: "22.19.0" },
  os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none",
};
const host = { os: "linux" as const, arch: "x64" as const, interpreters: { node: "22.19.0" }, packages: {}, cpus: 4, memoryMb: 4096 };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

async function world(d: string) {
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  const s = c.services;
  const boot = await s.principals.bootstrapOwner({ name: "rob" });
  const rob = await s.principals.authenticate(boot.token);
  const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
  const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
  await s.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "desk.write", project }, { action: "desk.read", project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }, { action: `tool.${personalNamespace("agent:ann").replace(/^a_/, "a-")}.*`, project }] });
  const ann = await s.principals.authenticate((await s.principals.issueCredential(rob, "agent:ann")).token);
  const task = async (n: string) => { const id = (await s.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId: project, title: `Task ${n}` })).id; await s.projects.transitionTask({ commandId: `r-${n}`, actor: rob.id, taskId: id, expectedRevision: 1, to: "ready" }); return id; };
  return { c, s, boot, rob, ann, call, project, task };
}

test("catalogue retention (card T02c, K06): off by default; with a count set the runner drops older versions, keeps the latest, revoked ones and any a resumable task ran, shows them as retained, and drops them once the task is over", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-catret-"));
  const { c, s, boot, rob, ann, call, project, task } = await world(d);
  try {
    const note = async (t: string) => (await s.desks.write(ann, { commandId: `w-${t}`, projectId: project, kind: "note", title: t, body: t, visibility: "shared", status: "accepted" } as never)).id;
    const readme = await note("readme");
    let name = "";
    for (const v of ["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5"]) name = (await s.catalog.register(ann, { commandId: `reg-${v}`, name: "check", kind: "tool", version: v, manifest, instructionsRecordId: readme, executableRecordId: await note(`code ${v}`) } as never)).name;
    // Task T1 ran 1.0.1 and can still resume; 1.0.2 is revoked.
    const t1 = await task("one");
    assert.equal((await s.catalog.authorizeRun(ann, { commandId: "run-1", name, version: "1.0.1", taskId: t1, projectId: project, host })).ready, true);
    await s.catalog.revoke(rob, { commandId: "rv", name, version: "1.0.2", reason: "bad" });

    // Off by default: nothing is a candidate.
    const off = (await call(boot.token, "retention.run", { dryRun: true }, "p0")).result;
    assert.equal(off.catalogVersions, undefined);
    assert.equal((await call(boot.token, "retention.settings.get", {})).result.item.effective.catalogVersionsKept, null);
    assert.equal((await call((await s.principals.issueCredential(rob, "agent:ann")).token, "retention.settings.set", { catalogVersionsKept: 2 }, "x")).error?.code, "forbidden");
    assert.equal((await call(boot.token, "retention.settings.set", { catalogVersionsKept: 0 }, "s0")).error?.code, "invalid_command");
    const set = await call(boot.token, "retention.settings.set", { catalogVersionsKept: 2, expectedRevision: 0 }, "s1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.deepEqual(set.result.changed, [{ field: "catalogVersionsKept", old: null, new: 2 }]);

    const preview = (await call(boot.token, "retention.run", { dryRun: true }, "p1")).result;
    assert.deepEqual(preview.catalogVersions.candidates.map((v: any) => v.version), ["1.0.0", "1.0.3"], "the used version and the revoked one are not candidates; the newest two and the latest stay");
    assert.deepEqual(preview.catalogVersions.retained.map((v: any) => v.version), ["1.0.1"]);
    assert.match(preview.catalogVersions.retained[0].reasons[0], /run by task/);
    // A run needs the digest of what was shown.
    assert.equal((await call(boot.token, "retention.run", { dryRun: false, confirm: "nope" }, "rbad")).error?.code, "invalid_command");
    const ran = await call(boot.token, "retention.run", { dryRun: false, confirm: preview.digest }, "r1");
    assert.ok(ran.ok, JSON.stringify(ran));
    assert.equal(ran.result.catalogVersions.removed, 2);
    const have = async (v: string) => (await s.catalog.get(rob, name, v))?.version;
    assert.deepEqual([await have("1.0.0"), await have("1.0.1"), await have("1.0.2"), await have("1.0.3"), await have("1.0.4"), await have("1.0.5")], [undefined, "1.0.1", "1.0.2", undefined, "1.0.4", "1.0.5"]);
    assert.equal((await s.catalog.get(rob, name))!.version, "1.0.5", "the latest is still chosen");
    // The revocation stays on record, and a new version is still accepted.
    assert.equal((await call(boot.token, "catalog.revocations", {})).result.items[0].version, "1.0.2");
    await s.catalog.register(ann, { commandId: "reg-next", name: "check", kind: "tool", version: "1.0.6", manifest, instructionsRecordId: readme, executableRecordId: await note("code next") } as never);

    // When the task is over its version is no longer held.
    await s.projects.transitionTask({ commandId: "cancel-1", actor: rob.id, taskId: t1, expectedRevision: (await s.projects.getTask(t1))!.revision, to: "cancelled" } as never);
    const again = (await call(boot.token, "retention.run", { dryRun: true }, "p2")).result;
    assert.deepEqual(again.catalogVersions.candidates.map((v: any) => v.version), ["1.0.1", "1.0.4"]);
    assert.deepEqual(again.catalogVersions.retained, []);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

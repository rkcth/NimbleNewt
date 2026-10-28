import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("working notes through the state API: the agent writes for its project, members read, peers cannot write, a credential is refused (card C01b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-notes-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const other = (await call(boot.token, "project.create", { name: "Orchard" }, "p2")).result.id as string;
    const agent = async (name: string, grants: unknown[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants } as never); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await agent("ann", [{ action: "desk.write", project }, { action: "desk.read", project }]);
    const ben = await agent("ben", [{ action: "desk.write", project }, { action: "desk.read", project }]);
    const cat = await agent("cat", [{ action: "desk.read", project: other }]);

    const wrote = await call(ann, "note.write", { projectId: project, category: "status", title: "Where I am", body: "Weeding the north bed; two beds left." }, "n1");
    assert.ok(wrote.ok, JSON.stringify(wrote));
    const id = wrote.result.id as string;
    // Members read it; the author revises; a peer cannot write or revise it.
    assert.equal((await call(ben, "note.get", { noteId: id })).result.item.title, "Where I am");
    assert.equal((await call(ben, "note.revise", { noteId: id, expectedRevision: wrote.result.revision, body: "hijacked" }, "n2")).ok, false);
    const revised = await call(ann, "note.revise", { noteId: id, expectedRevision: wrote.result.revision, body: "One bed left." }, "n3");
    assert.ok(revised.ok, JSON.stringify(revised));
    assert.equal((await call(ben, "note.versions", { noteId: id })).result.items.length, 2);
    assert.deepEqual((await call(ben, "note.list", { projectId: project })).result.items.map((n: { id: string }) => n.id), [id]);
    // Another project's member reads nothing without an opened path.
    assert.equal((await call(cat, "note.get", { noteId: id })).ok, false);
    // Private again: peers no longer see it; the owner still does.
    assert.ok((await call(ann, "note.visibility", { noteId: id, expectedRevision: revised.result.revision, visibility: "private" }, "n4")).ok);
    assert.equal((await call(ben, "note.get", { noteId: id })).ok, false);
    assert.equal((await call(boot.token, "note.get", { noteId: id })).ok, true);
    // A credential-shaped text is refused at write time; unknown fields are refused.
    assert.equal((await call(ann, "note.write", { projectId: project, category: "status", title: "key", body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, "n5")).error.code, "invalid_command");
    assert.equal((await call(ann, "note.write", { projectId: project, category: "status", title: "t", body: "b", surprise: 1 }, "n6")).error.code, "invalid_command");
    // A replay is the same note.
    assert.equal((await call(ann, "note.write", { projectId: project, category: "status", title: "Where I am", body: "Weeding the north bed; two beds left." }, "n1")).result.replayed, true);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

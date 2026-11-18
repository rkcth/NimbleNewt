import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { personalNamespace } from "../catalog/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

// Card T08 (first slice) through the real wiring: the state API as each agent's own credential, the owner's chat and status.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const manifest = { purpose: "lint the code", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/lint.js", interpreter: { name: "node", version: "22.19.0" }, os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

test("shared toolbox (card T08): a maintainer publishes for a role, the role finds, reads and copies it, others do not; the owner changes the audience by chat, reads it in status, and a revocation reaches the copy", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-toolbox-"));
  const sayText: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ScriptedInterpreter((input) => sayText[input.text] ?? []) } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const say = async (id: string, text: string, intents: unknown[]) => { sayText[text] = intents; const r = await c.chat!.submit(boot.token, { messageId: id, text }); return r.outcomes as any[]; };
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    // Standard role templates may already be defined (card H11b); a missing one is defined here.
    for (const role of ["coder", "reviewer"]) if ((await s.agents.getRole(rob, role)) === undefined) await s.agents.defineRole(rob, { commandId: `role-${role}`, name: role, capabilities: [] });
    const worker = [{ action: "desk.write", project }, { action: "desk.read", project }, { action: "catalog.read", project: "*" }, { action: "catalog.register", project: "*" }];
    const agent = async (name: string, roles: string[], extra: { action: string; project: string }[] = []) => {
      const id = (await s.agents.create(rob, { commandId: `ag-${name}`, friendlyName: name, roles })).id;
      const pid = `agent:${id}`;
      await s.principals.setGrants(rob, { commandId: `g-${name}`, principalId: pid, expectedRevision: (await s.principals.get(pid))!.revision, grants: [...worker, ...extra] });
      const token = (await s.principals.issueCredential(rob, pid)).token;
      return { id, pid, token, p: await s.principals.authenticate(token) };
    };
    const ann = await agent("Ann", []);
    const maya = await agent("Maya", [], [{ action: "toolbox.manage", project: "*" }]);
    const cody = await agent("Cody", ["coder"]);
    const rita = await agent("Rita", ["reviewer"]);
    const note = async (t: string) => (await s.desks.write(ann.p, { commandId: `w-${t}`, projectId: project, kind: "note", title: t, body: t, visibility: "shared", status: "accepted" } as never)).id;
    const readme = await note("Run lint on the changed files."); const code = await note("console.log('lint')");

    // Publishing: only a holder of toolbox.manage, never a nimblenewt name.
    const pubArgs = { name: "lint", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code, roles: ["coder"] };
    assert.equal((await call(rita.token, "toolbox.publish", pubArgs, "pub-rita")).error?.code, "forbidden");
    assert.equal((await call(maya.token, "toolbox.publish", { ...pubArgs, name: "nimblenewt.lint" }, "pub-sys")).error?.code, "invalid_command", "the op takes shared names only");
    const pub = await call(maya.token, "toolbox.publish", pubArgs, "pub-1");
    assert.ok(pub.ok, JSON.stringify(pub));
    assert.equal(pub.result.name, "toolbox.lint");

    // Discovery, source and copies follow the audience.
    const listed = (await call(cody.token, "toolbox.list", {})).result.items;
    assert.deepEqual(listed.map((x: any) => [x.name, x.latest, x.os, x.arch, x.audience, x.maintainable]), [["toolbox.lint", "1.0.0", ["linux"], ["x64"], { roles: ["coder"] }, false]]);
    assert.deepEqual((await call(rita.token, "toolbox.list", {})).result.items, []);
    const src = (await call(cody.token, "toolbox.source", { name: "lint" })).result;
    assert.deepEqual([src.instructions, src.executable, src.author], ["Run lint on the changed files.", "console.log('lint')", ann.pid]);
    assert.equal((await call(rita.token, "toolbox.source", { name: "lint" })).error?.code, "not_found");
    assert.equal((await call(rita.token, "toolbox.copy", { name: "lint", as: "mine" }, "cp-rita")).error?.code, "not_found");
    const copy = await call(cody.token, "toolbox.copy", { name: "lint", as: "my-lint" }, "cp-1");
    assert.ok(copy.ok, JSON.stringify(copy));
    assert.equal(copy.result.name, `${personalNamespace(cody.pid)}.my-lint`);
    assert.deepEqual(copy.result.copiedFrom, { name: "toolbox.lint", version: "1.0.0", digest: pub.result.digest });
    assert.deepEqual((await call(cody.token, "toolbox.copy", { name: "lint", as: "my-lint" }, "cp-1")).result, copy.result, "a retry answers again");
    // The shared name still resolves to the shared release for the copier.
    assert.equal((await s.catalog.get(cody.p, "toolbox.lint"))!.digest, pub.result.digest);
    assert.equal((await call(maya.token, "toolbox.forks", { name: "lint" })).result.forks.length, 1);
    assert.equal((await call(cody.token, "toolbox.forks", { name: "lint" })).error?.code, "forbidden");

    // The owner, by chat: who it is for, shown first, applied on the owner's word.
    const ask = "let only the reviewer role use the lint tool";
    const proposed = (await say("m1", ask, [{ kind: "command", op: "toolbox.audience.set", args: { name: "lint", roles: ["reviewer"] }, evidence: ask, basis: "owner" }]))[0];
    assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
    assert.equal((await call(rita.token, "toolbox.list", {})).result.items.length, 0, "nothing changes before the owner accepts");
    const applied = (await say("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed.proposalId, evidence: "do that", basis: "owner" }]))[0];
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    assert.deepEqual((await call(rita.token, "toolbox.list", {})).result.items.map((x: any) => x.name), ["toolbox.lint"]);
    assert.deepEqual((await call(cody.token, "toolbox.list", {})).result.items, []);
    assert.equal((await call(cody.token, "toolbox.copies", {})).result.items.length, 1, "the copy already made stays Cody's");

    // The owner asks in chat what is in the toolbox.
    const q = "what shared tools are there";
    const status = (await say("m3", q, [{ kind: "status", request: { kind: "toolbox" }, evidence: q, basis: "owner" }]))[0];
    assert.equal(status.status, "answered", JSON.stringify(status));
    const text = status.lines.map((l: any) => l.text).join("\n");
    assert.match(text, /toolbox\.lint 1\.0\.0 \(tool\) is for the roles reviewer; it declares linux on x64\. 1 personal copy was made of it\./);
    assert.equal((await call(cody.token, "status.ask", { request: { kind: "toolbox" } })).error?.code, "not_found", "an agent is not given the owner's view");

    // A revocation reaches the fork as a notice.
    assert.ok((await call(boot.token, "catalog.revoke", { name: "toolbox.lint", version: "1.0.0", reason: "it deletes files", runningCalls: "finish" }, "rv-1")).ok);
    const mine = (await call(cody.token, "toolbox.copies", {})).result.items[0];
    assert.deepEqual([mine.copiedFrom.version, mine.baseRevoked?.reason], ["1.0.0", "it deletes files"]);
    assert.equal((await call(boot.token, "toolbox.forks", { name: "lint" })).result.forks[0].baseRevoked, true);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

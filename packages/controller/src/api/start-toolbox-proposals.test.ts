import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SNAPSHOT_KIND, versionIdOf } from "../catalog/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

// Card T08 (second slice) through the real wiring: agents propose with their own credentials on the state API, a maintainer decides, the owner decides by chat and reads the proposals in status, a maintainer revokes and the
// fork owner is told, and the owner's deletion of a record removes the release's text.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const manifest = { purpose: "lint the code", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/lint.js", interpreter: { name: "node", version: "22.19.0" }, os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

test("toolbox proposals (card T08): an agent proposes, a maintainer asks for changes and accepts with a release, the owner decides another by chat and sees them in status, a maintainer revokes and the copy's owner is told", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-toolbox-prop-"));
  const sayText: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ScriptedInterpreter((input) => sayText[input.text] ?? []) } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const ok = async (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<any> => { const r = await call(token, op, args, commandId); assert.ok(r.ok, `${op}: ${JSON.stringify(r)}`); return r.result; };
    const say = async (id: string, text: string, intents: unknown[]) => { sayText[text] = intents; const r = await c.chat!.submit(boot.token, { messageId: id, text }); return r.outcomes as any[]; };
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
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
    let w = 0;
    // Desk records are written by the agent's own principal (the desk is not a state-API operation).
    const note = async (who: { p: any }, t: string, visibility = "shared") => (await s.desks.write(who.p, { commandId: `w-${w++}`, projectId: project, kind: "note", title: t.slice(0, 40), body: t, visibility, status: "accepted" } as never)).id;
    const readme = await note(ann, "Run lint on the changed files."); const code = await note(ann, "console.log('lint')");
    await ok(maya.token, "toolbox.publish", { name: "lint", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code, roles: ["coder"] }, "pub-1");
    await ok(cody.token, "toolbox.copy", { name: "lint", as: "my-lint" }, "cp-1");

    // Cody proposes with its own credential; Rita (outside the audience) cannot; nobody but the author and the deciders sees it.
    const faster = await note(cody, "console.log('lint, faster')");
    assert.equal((await call(rita.token, "toolbox.propose", { name: "lint", executableRecordId: faster, rationale: "faster", tests: "ran it" }, "pp-r")).error?.code, "not_found");
    const prop = await ok(cody.token, "toolbox.propose", { name: "lint", executableRecordId: faster, manifest: { ...manifest, requestedAccess: ["web.read"] }, rationale: "Lint only changed lines.", tests: "Same findings on the garden checkout." }, "pp-1");
    assert.deepEqual(prop.permissionChanges, { added: ["web.read"], removed: [] });
    assert.equal((await call(rita.token, "toolbox.proposal.get", { proposalId: prop.proposalId })).error?.code, "not_found");
    assert.equal((await ok(maya.token, "toolbox.proposal.get", { proposalId: prop.proposalId })).executable, "console.log('lint, faster')");
    // The maintainer asks for changes; the author is told and revises.
    await ok(maya.token, "toolbox.proposal.decide", { proposalId: prop.proposalId, decision: "request_changes", reason: "do not ask for web access" }, "d-1");
    assert.match((await ok(cody.token, "toolbox.notices", {})).items[0].text, /do not ask for web access/);
    await ok(cody.token, "toolbox.proposal.revise", { proposalId: prop.proposalId, executableRecordId: faster }, "rv-1");
    // Accepted and released as 1.1.0 in one decision; the shared tool now resolves to it; the copy is untouched.
    const acc = await ok(maya.token, "toolbox.proposal.decide", { proposalId: prop.proposalId, decision: "accept", version: "1.1.0" }, "d-2");
    assert.match(acc.authorizes, /no grant, push, merge or deploy/);
    assert.equal((await ok(cody.token, "toolbox.source", { name: "lint" })).executable, "console.log('lint, faster')");
    assert.equal((await ok(cody.token, "toolbox.copies", {})).items[0].copiedFrom.version, "1.0.0");
    assert.equal((await call(maya.token, "toolbox.proposal.decide", { proposalId: prop.proposalId, decision: "accept", version: "1.1.0" }, "d-2")).ok, true, "a retry answers again");

    // A second proposal: the owner reads it in status and defers it by chat; the default list then leaves it out.
    const docs = await note(cody, "Run lint on the changed files and the tests.");
    const p2 = await ok(cody.token, "toolbox.propose", { name: "lint", instructionsRecordId: docs, rationale: "cover tests", tests: "read it" }, "pp-2");
    const ask = "what has been proposed for the toolbox";
    const status = (await say("m1", ask, [{ kind: "status", request: { kind: "toolbox_proposals" }, evidence: ask, basis: "owner" }]))[0];
    assert.equal(status.status, "answered", JSON.stringify(status));
    const text = status.lines.map((l: any) => l.text).join("\n");
    assert.match(text, new RegExp(`Proposal ${p2.proposalId}: "Cody" \\(${cody.pid}\\) proposes changing the instructions of toolbox\\.lint 1\\.1\\.0; it is open\\.`));
    assert.doesNotMatch(text, new RegExp(prop.proposalId), "an accepted proposal is not waiting");
    const viaApi = await ok(boot.token, "status.ask", { request: { kind: "toolbox_proposals" } });
    assert.deepEqual(viaApi.item.lines.map((l: any) => l.text), status.lines.map((l: any) => l.text), "the chat answer is the state API's answer");
    assert.equal((await call(maya.token, "status.ask", { request: { kind: "toolbox_proposals" } })).error?.code, "not_found", "a maintainer is not given the owner's view (nor the names in it)");
    const park = "park Cody's lint docs idea until next month";
    const proposed = (await say("m2", park, [{ kind: "command", op: "toolbox.proposal.decide", args: { proposalId: p2.proposalId, decision: "defer", reason: "until next month" }, evidence: park, basis: "owner" }]))[0];
    assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
    assert.equal((await ok(maya.token, "toolbox.proposals", {})).items.length, 1, "nothing changes before the owner accepts");
    const applied = (await say("m3", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed.proposalId, evidence: "do that", basis: "owner" }]))[0];
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    assert.deepEqual((await ok(maya.token, "toolbox.proposals", {})).items, [], "a deferred proposal is not listed as available");
    assert.equal((await ok(maya.token, "toolbox.proposals", { state: "deferred" })).items[0].id, p2.proposalId);
    const after = (await say("m4", ask + "?", [{ kind: "status", request: { kind: "toolbox_proposals" }, evidence: ask, basis: "owner" }]))[0];
    assert.match(after.lines.map((l: any) => l.text).join("\n"), /1 deferred proposal is set aside and not listed/);
    assert.equal((await call(cody.token, "status.ask", { request: { kind: "toolbox_proposals" } })).error?.code, "not_found", "an agent is not given the owner's view");

    // A promotion with Cody's own tool, accepted by the maintainer for coders.
    const fmtDocs = await note(cody, "Format the code."); const fmtCode = await note(cody, "console.log('fmt')");
    // A personal tool is registered through the tool bridge's tool.register in a run; here the catalogue is called as Cody.
    await s.catalog.register(cody.p, { commandId: "reg-fmt", name: "fmt", kind: "tool", version: "1.0.0", manifest: { ...manifest, purpose: "format" }, instructionsRecordId: fmtDocs, executableRecordId: fmtCode });
    const pm = await ok(cody.token, "toolbox.promote", { name: "fmt", from: "fmt", roles: ["coder"], rationale: "everyone formats", tests: "formatted the garden" }, "pm-1");
    await ok(maya.token, "toolbox.proposal.decide", { proposalId: pm.proposalId, decision: "accept", version: "1.0.0" }, "d-3");
    assert.deepEqual((await ok(cody.token, "toolbox.list", {})).items.map((x: any) => x.name), ["toolbox.fmt", "toolbox.lint"]);

    // The maintainer revokes 1.0.0 of lint (it must say what happens to running calls); Cody, who keeps a copy of it, is told.
    assert.equal((await call(maya.token, "toolbox.revoke", { name: "lint", version: "1.0.0", reason: "it deletes files" }, "rv-x")).error?.code, "invalid_command");
    await ok(maya.token, "toolbox.revoke", { name: "lint", version: "1.0.0", reason: "it deletes files", runningCalls: "cancel" }, "rv-2");
    assert.equal((await call(rita.token, "toolbox.revoke", { name: "lint", version: "1.1.0", reason: "x", runningCalls: "cancel" }, "rv-3")).error?.code, "forbidden");
    const notices = await ok(cody.token, "toolbox.notices", {});
    assert.equal(notices.items.at(-1).kind, "revocation");
    assert.match(notices.items.at(-1).text, /toolbox\.lint 1\.0\.0 was revoked: it deletes files/);

    // The owner deletes the record the fmt release's executable came from: its snapshot goes too, and the text is reported removed.
    const del = await call(boot.token, "retention.delete", { recordId: fmtCode, reason: "the owner asked" }, "del-1");
    assert.ok(del.ok, JSON.stringify(del));
    assert.equal((await call(cody.token, "toolbox.source", { name: "fmt" })).error?.code, "not_found");
    assert.equal(await c.storage.getAggregate({ kind: SNAPSHOT_KIND, id: versionIdOf("toolbox.fmt", "1.0.0") }), undefined, "the release's snapshot of the deleted text is gone too");
    assert.notEqual(await c.storage.getAggregate({ kind: SNAPSHOT_KIND, id: versionIdOf("toolbox.lint", "1.1.0") }), undefined, "other releases keep theirs");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

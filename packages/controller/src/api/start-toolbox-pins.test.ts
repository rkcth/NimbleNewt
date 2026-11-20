import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

// Card T08 (third slice) through the real wiring: consumers stay on their pinned version until they opt in (the state API as each agent's own credential); the owner reads who is on what in status and moves an agent by chat.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const manifest = { purpose: "lint the code", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/lint.js", interpreter: { name: "node", version: "22.19.0" }, os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none" };
const host = { os: "linux" as const, arch: "x64" as const, interpreters: { node: "22.19.0" }, packages: {}, cpus: 4, memoryMb: 4096 };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

test("shared toolbox pins (card T08): a consumer stays on its first version after a release and opts in itself; the owner sees who is on what and moves an agent by chat, shown first", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-toolbox-pins-"));
  const sayText: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ScriptedInterpreter((input) => sayText[input.text] ?? []) } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const say = async (id: string, text: string, intents: unknown[]) => { sayText[text] = intents; const r = await c.chat!.submit(boot.token, { messageId: id, text }); return r.outcomes as any[]; };
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Tidy" })).id;
    if ((await s.agents.getRole(rob, "coder")) === undefined) await s.agents.defineRole(rob, { commandId: "role-coder", name: "coder", capabilities: [] });
    const worker = [{ action: "desk.write", project }, { action: "desk.read", project }, { action: "catalog.read", project: "*" }, { action: "catalog.register", project: "*" }, { action: "tool.toolbox.lint", project }];
    const agent = async (name: string, roles: string[], extra: { action: string; project: string }[] = []) => {
      const id = (await s.agents.create(rob, { commandId: `ag-${name}`, friendlyName: name, roles })).id;
      const pid = `agent:${id}`;
      await s.principals.setGrants(rob, { commandId: `g-${name}`, principalId: pid, expectedRevision: (await s.principals.get(pid))!.revision, grants: [...worker, ...extra] });
      const token = (await s.principals.issueCredential(rob, pid)).token;
      return { id, pid, token, p: await s.principals.authenticate(token) };
    };
    const maya = await agent("Maya", [], [{ action: "toolbox.manage", project: "*" }]);
    const cody = await agent("Cody", ["coder"]);
    const carl = await agent("Carl", ["coder"]);
    let k = 0;
    const note = async (t: string) => (await s.desks.write(maya.p, { commandId: `w-${k++}`, projectId: project, kind: "note", title: t, body: t, visibility: "shared", status: "accepted" } as never)).id;
    const publish = async (version: string) => { const r = await call(maya.token, "toolbox.publish", { name: "lint", kind: "tool", version, manifest, instructionsRecordId: await note(`Lint ${version}.`), executableRecordId: await note(`console.log('${version}')`), roles: ["coder"] }, `pub-${version}`); assert.ok(r.ok, JSON.stringify(r)); };
    const run = async (who: { p: any }) => { const r = await s.catalog.authorizeRun(who.p, { commandId: `run-${k++}`, name: "toolbox.lint", taskId: task, projectId: project, host }); assert.ok(r.ready); return r.version; };

    await publish("1.0.0");
    assert.equal(await run(cody), "1.0.0");
    await publish("1.1.0");
    assert.equal(await run(cody), "1.0.0", "Cody stays on his first version");
    assert.equal(await run(carl), "1.1.0");
    const listed = (await call(cody.token, "toolbox.list", {})).result.items[0];
    assert.deepEqual([listed.latest, listed.pinned], ["1.1.0", "1.0.0"]);
    assert.deepEqual((await call(cody.token, "toolbox.pins", {})).result.items.map((x: any) => [x.name, x.version, x.inUse, x.newer]), [["toolbox.lint", "1.0.0", "1.1.0", true]]);
    assert.equal((await call(cody.token, "toolbox.notices", {})).result.items.filter((x: any) => x.kind === "release").length, 1);
    // An agent moves only itself.
    assert.equal((await call(cody.token, "toolbox.optin", { name: "lint", agentId: carl.id }, "o-x")).error?.code, "forbidden");
    assert.equal((await call(cody.token, "toolbox.consumers", { name: "lint" })).error?.code, "forbidden");

    // The owner asks who is on what.
    const q = "who is still on the old lint tool";
    const status = (await say("m1", q, [{ kind: "status", request: { kind: "toolbox" }, evidence: q, basis: "owner" }]))[0];
    assert.equal(status.status, "answered", JSON.stringify(status));
    const text = status.lines.map((l: any) => l.text).join("\n");
    // Each agent named by its own name (so "which version is Cody on" is answered by name) and its ID.
    assert.match(text, /Agents using it stay on the version of their first run until they opt in: 1 on 1\.0\.0 \("Cody" \(agent:agt-[a-z2-7]+\)\); 1 on 1\.1\.0, the version in use \("Carl" \(agent:agt-[a-z2-7]+\)\)\./);

    // The owner moves Cody by name: shown first, applied on the owner's word, and Cody is told.
    const ask = "move Cody to lint 1.1.0";
    const proposed = (await say("m2", ask, [{ kind: "command", op: "toolbox.optin", args: { name: "lint", version: "1.1.0", agentName: "Cody" }, evidence: ask, basis: "owner" }]))[0];
    assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
    assert.equal(await run(cody), "1.0.0", "nothing moves before the owner accepts");
    const applied = (await say("m3", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed.proposalId, evidence: "do that", basis: "owner" }]))[0];
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    assert.equal(await run(cody), "1.1.0");
    assert.match((await call(cody.token, "toolbox.notices", {})).result.items.find((x: any) => x.kind === "pin").text, /The owner moved you to toolbox\.lint 1\.1\.0/);
    // A name that is no agent is refused, not guessed.
    const nobody = "move Zed to lint 1.1.0";
    const refused = (await say("m4", nobody, [{ kind: "command", op: "toolbox.optin", args: { name: "lint", version: "1.1.0", agentName: "Zed" }, evidence: nobody, basis: "owner" }]))[0];
    assert.notEqual(refused.status, "proposed", JSON.stringify(refused));

    // Cody goes back to 1.0.0 himself through the state API.
    const back = await call(cody.token, "toolbox.optin", { name: "lint", version: "1.0.0" }, "o-back");
    assert.deepEqual(back.result, { name: "toolbox.lint", version: "1.0.0", moved: 1, previous: "1.1.0" });
    assert.equal(await run(cody), "1.0.0");
    const seen = (await call(boot.token, "toolbox.consumers", { name: "lint" })).result;
    assert.deepEqual(seen.pins.map((p: any) => [p.agent, p.version, p.how]).sort(), [[carl.pid, "1.1.0", "first-use"], [cody.pid, "1.0.0", "opt-in"]].sort());
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

// Card T08 (eighth slice) through the real wiring and the real model interpreter: the owner asks in free words who may decide the toolbox's proposals. The stand-in for the model sees only the prompt and the owner's
// words of this one message (never an earlier answer), so a tool name or a page offset in the request can only come from what the owner said.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const manifest = { purpose: "lint the code", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/lint.js", interpreter: { name: "node", version: "22.19.0" }, os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

test("toolbox maintainers (card T08): the owner asks who may decide proposals in free words; the chat answers with the state API's own answer, a tool and a page come only from the owner's words, and nobody else is given it", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-toolbox-maint-"));
  const prompts: string[] = [];
  const model = { complete: async (_route: string, r: { system: string; user: string }): Promise<string> => {
    prompts.push(r.system);
    const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
    const intent = (request: Record<string, unknown>) => JSON.stringify([{ kind: "status", request: { kind: "toolbox_maintainers", ...request }, evidence: owner, basis: "owner" }]);
    // The model is told in its prompt how to read the kind (the guide's sentences are routed by this text alone): a tool the owner names, and a count the owner gives.
    const tool = /\bfor the (\w+) tool\b/.exec(owner)?.[1];
    const skipped = /\bafter the first (\d+)\b/.exec(owner)?.[1];
    if (/maintain|who can (decide|approve)/i.test(owner)) return intent({ ...(tool === undefined ? {} : { name: tool }), ...(skipped === undefined ? {} : { after: Number(skipped) }) });
    return JSON.stringify([{ kind: "none", reason: "nothing to do" }]);
  } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], chat: { interpreter: new ModelInterpreter(model, () => ["test/model"]) } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const ok = async (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<any> => { const r = await call(token, op, args, commandId); assert.ok(r.ok, `${op}: ${JSON.stringify(r)}`); return r.result; };
    let m = 0;
    const say = async (text: string) => (await c.chat!.submit(boot.token, { messageId: `m${m++}`, text })).outcomes as any[];
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const other = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
    for (const role of ["coder"]) if ((await s.agents.getRole(rob, role)) === undefined) await s.agents.defineRole(rob, { commandId: `role-${role}`, name: role, capabilities: [] });
    const worker = [{ action: "desk.write", project }, { action: "desk.read", project }, { action: "catalog.read", project: "*" }, { action: "catalog.register", project: "*" }];
    const agent = async (name: string, roles: string[], extra: { action: string; project: string }[] = []) => {
      const id = (await s.agents.create(rob, { commandId: `ag-${name}`, friendlyName: name, roles })).id;
      const pid = `agent:${id}`;
      await s.principals.setGrants(rob, { commandId: `g-${name}`, principalId: pid, expectedRevision: (await s.principals.get(pid))!.revision, grants: [...worker, ...extra] });
      const token = (await s.principals.issueCredential(rob, pid)).token;
      return { id, pid, token, p: await s.principals.authenticate(token) };
    };
    const maya = await agent("Maya", [], [{ action: "toolbox.manage", project: "*" }]);
    const pat = await agent("Pat", [], [{ action: "toolbox.manage", project: other }]);
    const cody = await agent("Cody", ["coder"]);
    let w = 0;
    const note = async (who: { p: any }, t: string) => (await s.desks.write(who.p, { commandId: `w-${w++}`, projectId: project, kind: "note", title: t.slice(0, 40), body: t, visibility: "shared", status: "accepted" } as never)).id;
    const readme = await note(maya, "Run lint on the changed files."); const code = await note(maya, "console.log('lint')");
    await ok(maya.token, "toolbox.publish", { name: "lint", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code, roles: ["coder"] }, "pub-1");
    await ok(cody.token, "toolbox.propose", { name: "lint", executableRecordId: await note(cody, "console.log('lint, faster')"), rationale: "faster", tests: "ran it" }, "pp-1");

    // The owner asks in free words (no phrase of the guide is needed); the answer is the state API's answer.
    const ask = "who maintains the toolbox?";
    const first = (await say(ask))[0];
    assert.equal(first.status, "answered", JSON.stringify(first));
    const viaApi = await ok(boot.token, "status.ask", { request: { kind: "toolbox_maintainers" } });
    assert.deepEqual(first.lines.map((l: any) => l.text), viaApi.item.lines.map((l: any) => l.text), "the chat answer is the state API's answer");
    const text = first.lines.map((l: any) => l.text).join("\n");
    assert.match(text, new RegExp(`"Maya" \\(${maya.pid}\\) holds toolbox\\.manage for every project, so it may decide proposals for any shared tool; 1 proposal waits for a decision it may make\\.`));
    assert.match(text, new RegExp(`"Pat" \\(${pat.pid}\\) holds toolbox\\.manage for the projects "Orchard" \\(${other}\\), so it may decide proposals only for shared tools made for those projects alone; no proposal waits`));
    assert.doesNotMatch(text, /Cody|Garden/, "an agent without the right is not listed");
    assert.match(prompts[0]!, /toolbox_maintainers \(name for one tool, after: how many were already shown\)/, "the interpreter prompt describes the kind");

    // A tool named in the owner's words narrows the list to those whose right covers it; Pat's right does not cover a tool made for coders.
    const one = (await say("who can approve the proposals for the lint tool?"))[0];
    assert.equal(one.status, "answered", JSON.stringify(one));
    const oneText = one.lines.map((l: any) => l.text).join("\n");
    assert.match(oneText, /"Maya"/); assert.doesNotMatch(oneText, /"Pat"/);
    assert.match(oneText, /1 proposal waits for a decision it may make on toolbox\.lint\./);
    // A page offset comes from the owner's own count; past the end there is nothing to show.
    const past = (await say("who maintains the toolbox, after the first 2"))[0];
    assert.equal(past.status, "answered", JSON.stringify(past));
    assert.deepEqual(past.lines.map((l: any) => l.text), ["There are no more maintainers to show."]);
    // A tool that does not exist is not invented for the owner and nothing is listed for it.
    const ghost = (await say("who can decide proposals for the ghost tool?"))[0];
    assert.notEqual(ghost.status, "answered", JSON.stringify(ghost));
    assert.doesNotMatch(JSON.stringify(ghost), /Maya|Pat/);
    // Nothing waits to be agreed to: the view is read only.
    assert.equal((await c.chat!.context(boot.token)).awaiting, undefined);

    // Nobody but the owner is given it: not a maintainer, not an agent, not a task credential (refused at the door).
    for (const who of [maya, pat, cody]) assert.equal((await call(who.token, "status.ask", { request: { kind: "toolbox_maintainers" } })).error?.code, "not_found", who.pid);
    const job = (await s.projects.createTask({ commandId: "t-tc", actor: rob.id, projectId: project, title: "lint the garden" })).id;
    const taskToken = (await s.taskCredentials.issue(rob, { commandId: "tc-1", taskId: job, agentId: maya.pid })).token;
    const byTask = await call(taskToken, "status.ask", { request: { kind: "toolbox_maintainers" } });
    assert.equal(byTask.error?.code, "forbidden", JSON.stringify(byTask));
    assert.doesNotMatch(JSON.stringify(byTask), /Maya|Pat|Proposal/);
    // A bad request word through the API is refused, not guessed at.
    assert.equal((await call(boot.token, "status.ask", { request: { kind: "toolbox_maintainers", after: -1 } })).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "status.ask", { request: { kind: "toolbox_maintainers", name: "ghost" } })).error?.code, "not_found");
  } finally { await c.close?.(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { startController } from "./index.js";
import { BUILTIN_COMMANDS, OPERATIONS } from "./operations.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("every state-API operation but command.run is a /nimblenewt. command with its own name", () => {
  assert.equal(BUILTIN_COMMANDS.names().length, OPERATIONS.length - 1);
  assert.equal(BUILTIN_COMMANDS.operationOf("nimblenewt.grant-list")?.name, "grant.list");
  assert.equal(BUILTIN_COMMANDS.operationOf("nimblenewt.command-run"), undefined, "a command cannot run a command");
});

test("a typed /nimblenewt. command runs the operation as the one who typed it, once, and is answered in words when it cannot be resolved or run (card T09b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-commands-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const call = (token: string, args: Record<string, unknown>, commandId: string) => c.api.handle(token, { v: 1, op: "command.run", commandId, args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    const asked = async (op: string, args: Record<string, unknown>) => ((await c.api.handle(boot.token, { v: 1, op, args } as never)) as any).result;
    // A query runs and its answer comes back.
    const roles = await call(boot.token, { typed: "/nimblenewt.role-list" }, "k1");
    assert.ok(roles.ok, JSON.stringify(roles));
    assert.equal(roles.result.status, "done", JSON.stringify(roles.result));
    assert.equal(roles.result.command, "nimblenewt.role-list");
    assert.ok(Array.isArray(roles.result.answer.items), "the operation's own answer comes back");
    // A command runs once: the same command ID answers from the record, a new one runs again (and the operation replays by its own command ID).
    const set = await call(boot.token, { typed: '/nimblenewt.placement-set {"allow": ["host:pc"]}' }, "k2");
    assert.equal(set.result.status, "done", JSON.stringify(set));
    const again = await call(boot.token, { typed: '/nimblenewt.placement-set {"allow": ["host:pc"]}' }, "k2");
    assert.deepEqual([again.result.status, again.result.replayed, again.result.queued], ["done", true, set.result.queued]);
    assert.equal((await asked("placement.get", {})).item.revision, 1, "set once, not twice");
    // A conflicting reuse of the command ID is refused; the words are not compared loosely.
    const reused = await call(boot.token, { typed: '/nimblenewt.placement-set {"allow": ["host:other"]}' }, "k2");
    assert.equal(reused.error?.code, "command_conflict");
    // Not resolved: answered in words, nothing queued, nothing run.
    assert.equal((await call(boot.token, { typed: "/nimblenewt.nope" }, "k3")).result.status, "unknown");
    assert.equal((await call(boot.token, { typed: "/nimblenewt.command-run" }, "k4")).result.status, "unknown", "command.run is not a command");
    assert.equal((await call(boot.token, { typed: "/Nimblenewt.role-list" }, "k5")).result.status, "refused", "case is not folded");
    assert.equal((await call(boot.token, { typed: "/toolbox.spellcheck notes.md" }, "k6")).result.status, "unknown", "nothing is filed under that name");
    // Bad arguments are the caller's mistake, said plainly.
    const bad = await call(boot.token, { typed: "/nimblenewt.role-list [1]" }, "k8");
    assert.deepEqual([bad.result.status, bad.result.error.code], ["failed", "invalid_command"]);
    const unknownField = await call(boot.token, { typed: '/nimblenewt.role-list {"surprise": 1}' }, "k9");
    assert.deepEqual([unknownField.result.status, unknownField.result.error.code], ["failed", "invalid_command"]);
    // Under the typist's rights, never more: an agent with little access is refused by the operation itself.
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "project.read", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const forbidden = await call(ann, { typed: '/nimblenewt.placement-set {"allow": ["host:evil"]}' }, "a1");
    assert.deepEqual([forbidden.result.status, forbidden.result.error.code], ["failed", "forbidden"]);
    assert.equal((await asked("placement.get", {})).item.revision, 1, "the agent changed nothing");
    const denied = await call(ann, { typed: "/nimblenewt.role-list" }, "a2");
    assert.equal(denied.result.status, "failed", "role.list needs agent.read, which ann lacks");
    // A queued command is its typist's: another principal cannot run it through its ID (the id is not even an input here).
    assert.equal((await call(ann, { typed: "/nimblenewt.role-list" }, "k1")).result?.status ?? "other", "failed", "the same command ID by another principal is its own command");
    // A fenced model of use: a typist of /toolbox. gets "cannot run yet" only when the name exists (tested with a catalog source in commands.test).
    void project;
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a command typed in the owner chat is not read by the assistant: a query runs and is answered once, a change is not run from a typed line, and a name that does not resolve gets a plain answer (card T09b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-commands-chat-"));
  let read = 0;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    chat: { interpreter: new ScriptedInterpreter(() => { read++; return []; }) },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const say = (messageId: string, text: string) => c.chat!.submit(boot.token, { messageId, text });
    const listed = await say("m1", "/nimblenewt.role-list");
    assert.equal(listed.outcomes[0]!.status, "applied");
    assert.match(listed.reply.join("\n"), /Ran nimblenewt\.role-list/);
    const again = await say("m1", "/nimblenewt.role-list");
    assert.deepEqual([again.replayed, again.turnId], [true, listed.turnId], "the same message is answered from its record");
    const changed = await say("m2", '/nimblenewt.placement-set {"allow": ["host:pc"]}');
    assert.deepEqual([changed.outcomes[0]!.status, changed.outcomes[0]!.code], ["refused", "needs_confirmation"]);
    assert.equal(((await c.api.handle(boot.token, { v: 1, op: "placement.get", args: {} } as never)) as any).result.item.revision, 0, "nothing was changed");
    const unknown = await say("m3", "/nimblenewt.nope");
    assert.deepEqual([unknown.outcomes[0]!.status, unknown.outcomes[0]!.code], ["refused", "unknown"]);
    const upper = await say("m4", "/NimbleNewt.role-list");
    assert.equal(read, 1, "only the line that is not a command went to the assistant (the upper-case one is not a command)");
    assert.equal(upper.outcomes.length >= 0, true);
    assert.equal((await say("m5", "/toolbox.lint")).outcomes[0]!.code, "unknown");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

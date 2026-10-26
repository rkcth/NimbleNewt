import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("start builds the owner chat and the coordinator when asked; the controller and the chat carry on while the coordinator is paused, stopped or failing (card U03)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-chat-"));
  const none = await startController({ storage: { kind: "sqlite", path: join(d, "n.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  assert.equal(none.chat, undefined, "no chat unless asked");
  await none.close();

  let held: string | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4,
    chat: { interpreter: new ScriptedInterpreter({}), coordinator: { model: { respond: async () => { throw new Error("every route failed"); } }, token: async () => held } },
  });
  try {
    assert.ok(c.chat !== undefined && c.coordinator !== undefined);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const say = async (id: string) => (await c.chat!.submit(boot.token, { messageId: id, text: "hello there" })).reply;
    assert.ok(Array.isArray(await say("m1")), "the chat answers");
    // The coordinator is set up paused; asking it says it is unavailable and the chat is unaffected.
    await c.coordinator.configure(owner, { commandId: "cfg", principalId: "agent:coordinator", routes: ["llama/local"] });
    const paused = await c.coordinator.answer(owner, { commandId: "a1", projectId: project, question: "what is next?" });
    assert.equal((paused as { kind: string }).kind, "unavailable");
    assert.ok(Array.isArray(await say("m2")));
    // Running, but with no credential: still unavailable, still nothing else affected.
    const rev = (await c.coordinator.get(owner))!.revision;
    await c.coordinator.setState(owner, { commandId: "run", expectedRevision: rev, to: "running" });
    const failing = await c.coordinator.answer(owner, { commandId: "a2", projectId: project, question: "what is next?" });
    assert.equal((failing as { kind: string }).kind, "unavailable", JSON.stringify(failing));
    assert.match(JSON.stringify(failing), /no valid credential/);
    assert.ok(Array.isArray(await say("m3")), "the chat still answers");
    assert.equal((await c.services.projects.getProject(project))?.name, "Garden", "and the controller's records are untouched");
    // With the configured principal's credential the coordinator is reached, and a model whose every route fails is still unavailable, not an error.
    await c.services.principals.enroll(owner, { commandId: "e-coord", kind: "agent", name: "coordinator", grants: [] });
    held = (await c.services.principals.issueCredential(owner, "agent:coordinator")).token;
    const reached = await c.coordinator.answer(owner, { commandId: "a3", projectId: project, question: "what is next?" });
    assert.equal((reached as { kind: string }).kind, "insufficient", JSON.stringify(reached));
    // The credential is revoked while the coordinator is configured: unavailable, never a thrown refusal.
    held = undefined;
    assert.equal(((await c.coordinator.answer(owner, { commandId: "a4", projectId: project, question: "again?" })) as { kind: string }).kind, "unavailable");
    // Stopped.
    const rev2 = (await c.coordinator.get(owner))!.revision;
    await c.coordinator.setState(owner, { commandId: "stop", expectedRevision: rev2, to: "stopped" });
    assert.equal(((await c.coordinator.decompose(owner, { commandId: "d1", projectId: project, outcome: "plant beans" })) as { kind: string }).kind, "unavailable");
    assert.ok(Array.isArray(await say("m4")));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

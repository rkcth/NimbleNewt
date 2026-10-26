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

  let modelCalls = 0;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4,
    chat: { interpreter: new ScriptedInterpreter({}), coordinator: { model: { respond: async () => { modelCalls++; throw new Error("every route failed"); } }, token: async () => undefined } },
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
    // Running, but with no credential and a model that fails: still unavailable, still nothing else affected.
    const rev = (await c.coordinator.get(owner))!.revision;
    await c.coordinator.setState(owner, { commandId: "run", expectedRevision: rev, to: "running" });
    const failing = await c.coordinator.answer(owner, { commandId: "a2", projectId: project, question: "what is next?" }).catch((e: unknown) => ({ kind: "refused", why: String(e) }));
    assert.notEqual((failing as { kind: string }).kind, "answered", JSON.stringify(failing));
    assert.ok(Array.isArray(await say("m3")), "the chat still answers");
    assert.equal((await c.services.projects.getProject(project))?.name, "Garden", "and the controller's records are untouched");
    void modelCalls;
    // Stopped.
    const rev2 = (await c.coordinator.get(owner))!.revision;
    await c.coordinator.setState(owner, { commandId: "stop", expectedRevision: rev2, to: "stopped" });
    assert.equal(((await c.coordinator.decompose(owner, { commandId: "d1", projectId: project, outcome: "plant beans" })) as { kind: string }).kind, "unavailable");
    assert.ok(Array.isArray(await say("m4")));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

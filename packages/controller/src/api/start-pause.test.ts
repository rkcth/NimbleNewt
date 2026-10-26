import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the pause gates supply the availability the controller's conversations consult: a paused agent's messages are queued, a resumed agent's are not, and a message never lifts the pause (card L01)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-pause-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const s = c.services;
    const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const grants = ["conversation.start", "conversation.send", "conversation.receive"].map((action) => ({ action, project }));
    // An agent is a record (its ID names its principal), enrolled with the grants its conversations need.
    const enroll = async (friendlyName: string) => {
      const id = (await s.agents.create(owner, { commandId: `ag-${friendlyName}`, friendlyName })).id;
      for (const g of grants) await s.grants.grant(owner, { commandId: `g-${id}-${g.action}`, grantee: `agent:${id}`, action: g.action, project, source: "direct", basis: "test" });
      return { id, principal: await s.principals.authenticate((await s.principals.issueCredential(owner, `agent:${id}`)).token) };
    };
    const [a, b] = [await enroll("Ann"), await enroll("Bob")];
    const [ann, bob] = [a.principal, b.principal];
    const state = async (threadId: string) => (await s.conversations.read(bob, { threadId, afterSeq: 0 }))!.items.at(-1)!.availability;
    const first = await s.conversations.start(ann, { commandId: "s1", projectId: project, subject: "hello", to: [bob.id], text: "are you there?" });
    assert.equal(await state(first.threadId), "ready");
    await s.pauses.pause(owner, { commandId: "pz1", scope: { kind: "agent", id: b.id }, reason: "the owner asked" });
    const second = await s.conversations.start(ann, { commandId: "s2", projectId: project, subject: "again", to: [bob.id], text: "still there?" });
    assert.equal(await state(second.threadId), "queued", "a paused agent's messages are queued");
    await s.conversations.send(ann, { commandId: "m2", threadId: second.threadId, text: "please answer" });
    assert.equal((await s.pauses.availability(bob.id)), "paused", "a message does not lift the pause");
    await s.pauses.resume(owner, { commandId: "rs1", scope: { kind: "agent", id: b.id }, reason: "back" });
    const third = await s.conversations.start(ann, { commandId: "s3", projectId: project, subject: "third", to: [bob.id], text: "now?" });
    assert.equal(await state(third.threadId), "ready");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

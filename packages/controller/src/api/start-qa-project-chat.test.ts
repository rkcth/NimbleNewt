import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

// Card Q02, the project QA view by chat: with no project named, the project in focus is used (no magic phrase; the interpreter turns any wording into the status kind).
test("the owner asks in plain words what waits for QA and is answered for the project in focus (card Q02)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-qaproj-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) as never } } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Fix the login" });
    const turn = async (messageId: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId, text })).outcomes as any[]; };
    const q = "what is waiting for QA?";
    const none = await turn("m0", q, [{ kind: "status", request: { kind: "qa_project" }, evidence: q, basis: "owner" }]);
    assert.equal(none[0].status, "refused", "without a project in focus it asks which project");
    await c.chat!.setFocus(boot.token, { commandId: "f1", projectId: project });
    const asked = await turn("m1", q, [{ kind: "status", request: { kind: "qa_project" }, evidence: q, basis: "owner" }]);
    assert.equal(asked[0].status, "answered", JSON.stringify(asked));
    assert.match((asked[0].lines as { text: string }[]).map((l) => l.text).join("\n"), /nothing waits for QA/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

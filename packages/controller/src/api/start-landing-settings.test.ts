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

test("through the running controller the owner reads and changes another project's landing checks by naming it in chat, while a different project is in focus (chat gaps)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-landing-settings-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], artifacts: { directory: join(d, "blobs") }, chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const garden = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const orchard = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const turn = async (mid: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: mid, text })).outcomes as any[]; };
    const checksOf = async (project: string) => (await call(boot.token, "integration.get", { project })).result.item.requiredChecks as string[];
    await c.chat!.setFocus(boot.token, { commandId: "f1", projectId: garden });
    const gardenBefore = await checksOf(garden);

    // Reading: the owner names Orchard (focus moves to it from their words), then asks for the view.
    const q = "what checks does Orchard need before its work lands?";
    const shown = await turn("m1", q, [{ kind: "switch_focus", projectName: "Orchard", evidence: "Orchard need", basis: "owner" }, { kind: "status", request: { kind: "landing_settings" }, evidence: q, basis: "owner" }]);
    const answered = shown.find((o) => o.status === "answered");
    assert.ok(answered !== undefined, JSON.stringify(shown));
    assert.equal(shown[0].status, "focused", JSON.stringify(shown));
    const viaApi = (await call(boot.token, "status.ask", { request: { kind: "landing_settings", projectId: orchard } })).result.item.lines.map((l: any) => l.text);
    assert.deepEqual(answered.lines.map((l: any) => l.text), viaApi, "the chat prints the view's own lines");
    assert.match(viaApi[0], /project Orchard/);
    // Garden is in focus again and is asked for by its own focus, no name needed.
    await c.chat!.setFocus(boot.token, { commandId: "f2", projectId: garden });
    const g = "and what does the project I am working in require?";
    const own = await turn("m2", g, [{ kind: "status", request: { kind: "landing_settings" }, evidence: g, basis: "owner" }]);
    assert.match(own[0].lines[0].text, /project Garden/, JSON.stringify(own));
    // An agent gets nothing of it through the state API.
    const made = await s.agents.create(rob, { commandId: "mk", friendlyName: "Ivy", roles: ["author"] });
    await s.grants.grant(rob, { commandId: "g1", grantee: `agent:${made.id}`, action: "task.read", project: orchard, source: "direct", basis: "test" } as never);
    const ivy = (await s.principals.issueCredential(rob, `agent:${made.id}`)).token;
    assert.equal((await call(ivy, "status.ask", { request: { kind: "landing_settings", projectId: orchard } })).error.code, "not_found");

    // Changing: Garden stays in focus, the owner names Orchard; the change is shown first and lands on Orchard only.
    const orchardBefore = await checksOf(orchard);
    const words = "Orchard should require review and QA before anything lands";
    const proposed = await turn("m3", words, [{ kind: "command", op: "integration.set", args: { projectName: "Orchard", requiredChecks: ["review", "qa"] }, evidence: words, basis: "owner" }]);
    assert.equal(proposed[0].status, "proposed", JSON.stringify(proposed));
    assert.deepEqual(await checksOf(orchard), orchardBefore, "nothing changed until the owner agrees");
    assert.equal(JSON.stringify(proposed).includes("Orchard"), true, "the proposal names the project it is for");
    const applied = await turn("m4", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed[0].proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    assert.deepEqual(await checksOf(orchard), ["review", "qa"]);
    assert.deepEqual(await checksOf(garden), gardenBefore, "the project in focus was not touched");
    // The view now says it, through chat, for the project named.
    const after = await turn("m5", q + " now?", [{ kind: "switch_focus", projectName: "Orchard", evidence: "Orchard need", basis: "owner" }, { kind: "status", request: { kind: "landing_settings" }, evidence: q + " now?", basis: "owner" }]);
    assert.match(JSON.stringify(after), /review \(an independent reviewer approved the change\); QA/);
    // With no name the project in focus is the one changed (the old way still works).
    const own2 = "Garden should also require QA";
    await c.chat!.setFocus(boot.token, { commandId: "f3", projectId: garden });
    const p2 = await turn("m6", own2, [{ kind: "command", op: "integration.set", args: { requiredChecks: ["tests", "qa"] }, evidence: own2, basis: "owner" }]);
    assert.equal(p2[0].status, "proposed", JSON.stringify(p2));
    const done = await turn("m7", "yes, do that too", [{ kind: "apply_proposal", proposalId: p2[0].proposalId, evidence: "do that too", basis: "owner" }]);
    assert.equal(done[0].status, "applied", JSON.stringify(done));
    assert.deepEqual(await checksOf(garden), ["tests", "qa"]);
    assert.deepEqual(await checksOf(orchard), ["review", "qa"]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

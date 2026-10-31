import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "../api/index.js";
import { StreamSettingsService } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the model stream settings: both on by default, owner-only, changed by the state API and in chat with expectedRevision, enable and disable", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-stream-settings-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    assert.deepEqual((await call("generation.stream.get", {})).result.item, { revision: 0, record: true, cut: true });
    const off = await call("generation.stream.change", { disable: ["cut"], expectedRevision: 0 }, "s1");
    assert.ok(off.ok, JSON.stringify(off));
    assert.deepEqual((await call("generation.stream.get", {})).result.item, { revision: 1, record: true, cut: false });
    // A change made against an old reading is refused, not applied.
    const stale = await call("generation.stream.change", { disable: ["record"], expectedRevision: 0 }, "s2");
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, "stale_revision");
    assert.equal((await call("generation.stream.get", {})).result.item.record, true);
    // Chat: shown first, applied on the owner's word; enable turns it back on.
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const text = "turn the cut back on";
    const shown = await turn("m1", text, [{ kind: "command", op: "generation.stream.change", args: { enable: ["cut"], expectedRevision: 1 }, evidence: text, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.equal((await call("generation.stream.get", {})).result.item.cut, false, "nothing changed while it waits for the owner");
    const applied = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.deepEqual((await call("generation.stream.get", {})).result.item, { revision: 2, record: true, cut: true });
    // A non-owner may not read or change it.
    await c.services.principals.enroll(await c.services.principals.authenticate(boot.token), { commandId: "e-ann", kind: "agent", name: "ann", grants: [] });
    const ann = await c.services.principals.authenticate((await c.services.principals.issueCredential(await c.services.principals.authenticate(boot.token), "agent:ann")).token);
    const settings = StreamSettingsService.withEpoch(c.storage, c.epoch);
    await assert.rejects(settings.get(ann), /may not read/);
    await assert.rejects(settings.change(ann, { commandId: "x1", enable: ["cut"] }), /may not change/);
    // Bad input is refused; naming nothing is refused; a non-owner may not read or change it.
    assert.equal((await call("generation.stream.change", { enable: ["nope"] }, "s3")).ok, false);
    assert.equal((await call("generation.stream.change", {}, "s4")).ok, false);
    assert.equal((await call("generation.stream.change", { enable: ["cut"], disable: ["cut"] }, "s5")).ok, false);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

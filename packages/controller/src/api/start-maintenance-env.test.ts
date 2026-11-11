import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { EnvironmentRuntime, ReloadInput, TrialResult, ValidateResult } from "../maintenance/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };
const D = (c: string): string => `sha256:${c.repeat(64)}`;
const pkg = (name: string, extra: Record<string, unknown> = {}) => ({ name, version: "1.2.3", digest: D("a"), source: "https://registry.example.org/pkg", installScripts: false, ...extra });

class Host implements EnvironmentRuntime {
  calls: string[] = [];
  validate_: ValidateResult[] = [];
  async trial(): Promise<TrialResult> { this.calls.push("trial"); return { ok: true, digestVerified: true, scriptsDeclared: false, scriptsRan: false }; }
  async reload(i: ReloadInput) { this.calls.push(`reload:${i.revision}`); return { ok: true as const, observed: {} }; }
  async validate(i: ReloadInput): Promise<ValidateResult> { this.calls.push(`validate:${i.revision}`); return this.validate_.shift() ?? { ok: true, sessionIntact: true, compactionIntact: true }; }
}

test("an approved package request is carried out by the real applier through the controller (suspend, reload, activate, validate, resume), a failed validation is rolled back, and the owner reads both in chat (card A09)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-a09e-"));
  const host = new Host();
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    maintenance: { environmentRuntime: host },
  } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    let n = 0;
    const cid = (l: string): string => `${l}-${n++}`;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const ann = await c.services.agents.create(rob, { commandId: cid("ag"), friendlyName: "Ann", roles: ["author"] } as never);
    const annToken = (await c.services.principals.issueCredential(rob, `agent:${ann.id}`)).token;
    const agentId = `agent:${ann.id}`;
    await c.services.environments.change(rob, { commandId: cid("env"), agentId, manifest: { base: { name: "nimblenewt-base", version: "1.0.0", digest: D("1") }, packages: [], skills: [], capabilities: [], configuration: { installation: 1 }, limits: { cpus: 1, memoryMb: 1024, diskMb: 5000, processes: 100 }, protectedExtensions: [] }, reason: "first environment" });
    await c.services.environments.activate(rob, { commandId: cid("act"), agentId, revision: 1, observed: {} });
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };

    // ---- the request waits for the owner (strict profile); the owner approves it in words, after seeing it
    const asked = await call(annToken, "maintenance.request", { kind: "package", spec: pkg("ripgrep"), reason: "search faster", rollbackPlan: "remove it" }, "e1");
    assert.equal(asked.result.status, "pending");
    const mid = asked.result.maintenanceId as string;
    const words = `approve ${mid}`;
    const shown = await turn("t1", words, [{ kind: "command", op: "maintenance.decide", args: { maintenanceId: mid, verdict: "approve" }, evidence: words, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed");
    assert.deepEqual(host.calls, [], "nothing runs before the owner agrees");
    const done = (await turn("t2", "yes, go ahead", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "go ahead", basis: "owner" }]))[0]!;
    assert.equal(done.status, "applied", JSON.stringify(done));
    await c.services.maintenance.idle();
    const item = (await call(boot.token, "maintenance.get", { maintenanceId: mid })).result.item;
    assert.equal(item.status, "applied", JSON.stringify(item));
    assert.deepEqual(host.calls, ["trial", "reload:2", "validate:2"]);
    assert.equal(item.effect.environmentRevision, 2);
    assert.equal(item.effect.restoredIntent, "resumed");
    const env = (await call(boot.token, "environment.get", { agentId })).result.item;
    assert.deepEqual([env.active.revision, env.active.manifest.packages.map((p: any) => p.name)], [2, ["ripgrep"]]);
    assert.equal((await call(annToken, "environment.get", { agentId })).ok, true, "the agent reads its own environment");
    assert.equal((await call(annToken, "environment.get", { agentId: "agent:agt-aaaaaaaaaaaaaaaaaaaa" })).result.item, null, "and nobody else's");
    assert.equal((await c.services.pauses.gate(rob, { kind: "agent", id: ann.id }))?.intent, "active", "the agent works again");

    // ---- a second change fails validation: rolled back, the request says why, the environment is the one it was
    host.validate_ = [{ ok: true, sessionIntact: false, compactionIntact: true }];
    const second = await call(annToken, "maintenance.request", { kind: "package", spec: pkg("fd", { digest: D("b") }), reason: "find files", rollbackPlan: "remove it" }, "e2");
    const mid2 = second.result.maintenanceId as string;
    const spec2 = (await call(boot.token, "maintenance.get", { maintenanceId: mid2 })).result.item.specDigest;
    assert.ok((await call(boot.token, "maintenance.decide", { maintenanceId: mid2, verdict: "approve", specDigest: spec2 }, cid("d"))).ok);
    await c.services.maintenance.idle();
    const failed = (await call(boot.token, "maintenance.get", { maintenanceId: mid2 })).result.item;
    assert.equal(failed.status, "failed");
    assert.match(failed.failure.reason, /session was not intact/);
    const env2 = (await call(boot.token, "environment.get", { agentId })).result.item;
    assert.deepEqual(env2.active.manifest.packages.map((p: any) => p.name), ["ripgrep"], "the failed package is not in the active environment");
    assert.equal((await c.services.pauses.gate(rob, { kind: "agent", id: ann.id }))?.intent, "active");

    // ---- the owner asks in free words, by the agent's name
    const q1 = "what is in Ann's environment";
    const env3 = await turn("t3", q1, [{ kind: "status", request: { kind: "environment", agentName: "Ann" }, evidence: q1, basis: "owner" }]);
    assert.equal(env3[0]!.status, "answered", JSON.stringify(env3[0]));
    assert.match(JSON.stringify(env3[0]), /ripgrep 1\.2\.3/);
    assert.match(JSON.stringify(env3[0]), /rolled back|restores revision/);
    const q2 = "did Ann's package requests go through";
    const m3 = await turn("t4", q2, [{ kind: "status", request: { kind: "maintenance", agentName: "ann" }, evidence: q2, basis: "owner" }]);
    assert.match(JSON.stringify(m3[0]), /failed - .*session was not intact/);
    assert.match(JSON.stringify(m3[0]), /now revision 2/);
    // someone who is not the owner has no such view
    assert.equal((await call(annToken, "maintenance.list", {})).result.items.length, 2);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});

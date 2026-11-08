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

/**
 * The `capacity` status view through the composed controller: the chat reads the same three services the state API reads (the wiring in `startController`), the owner's changes made by the
 * state-API operations come back in the answer, and a caller that is not the owner is answered exactly as one asking for a view that does not exist (cards H10, H10b).
 */
test("the capacity view in chat shows what the owner set by the state API, in the controller as it starts; an agent's status.ask reads as missing", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-capview-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }] });
    await c.services.principals.enroll(rob, { commandId: "e-pc", kind: "host", name: "pc", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const as = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => as(boot.token, op, args, commandId);
    const QUESTION = "what are my capacity limits?";
    let m = 0;
    const ask = async (): Promise<string> => {
      say[QUESTION] = [{ kind: "status", request: { kind: "capacity" }, evidence: QUESTION, basis: "owner" }];
      const o = (await c.chat!.submit(boot.token, { messageId: `m${m++}`, text: QUESTION })).outcomes[0] as { status: string; message?: string; lines?: readonly { text: string; cites: readonly unknown[] }[] };
      assert.equal(o.status, "answered", JSON.stringify(o));
      return (o.lines ?? []).map((l) => l.text).join("\n");
    };

    // Nothing set: all three groups, every figure the installation's default and every cap off.
    const before = await ask();
    assert.match(before, /^Capacity caps \(your setting is at revision 0\)/m);
    assert.match(before, /^perProject \(.*\): off, nothing is capped \(the default\)$/m);
    assert.match(before, /^Host and global quotas/m);
    assert.match(before, /^productive \(.*\): 4 \(the default\); 0 running now$/m);
    assert.match(before, /^Limits on spawning child tasks \(your setting is at revision 0\):$/m);
    assert.match(before, /^totalChildren \(.*\): 16 \(the default\)$/m);

    // The owner changes one figure of each group by the state API, and declares a host.
    assert.ok((await call("capacity.limits.change", { set: { perAgent: 3 } }, "v1")).ok);
    assert.ok((await call("capacity.quotas.change", { set: { productive: 5 } }, "v2")).ok);
    assert.ok((await call("swarm.limits.change", { set: { depth: 1 } }, "v3")).ok);
    assert.ok((await call("capacity.quotas.change", { hosts: { "host:pc": { cpus: 8, memoryMb: 16_384 } } }, "v4")).ok);
    const after = await ask();
    assert.match(after, /^perAgent \(.*\): 3 at once \(you set it\)$/m);
    assert.match(after, /^perProject \(.*\): off, nothing is capped \(the default\)$/m, "a cap the owner did not touch stays the default");
    assert.match(after, /^productive \(.*\): 5 \(you set it\); 0 running now$/m);
    assert.match(after, /^depth \(.*\): 1 \(you set it\)$/m);
    assert.match(after, /^Host "host:pc": 8 CPU\(s\), 16384 MB declared \(you declared it\); 0 productive attempt\(s\) running on it\.$/m);

    // The same three reads through the state API are what the view showed.
    assert.deepEqual((await call("capacity.limits.get", {})).result.item.limits.perAgent, { enabled: true, value: 3 });
    assert.equal((await call("capacity.quotas.get", {})).result.item.limits.productive, 5);
    assert.equal((await call("swarm.limits.get", {})).result.item.limits.depth, 1);

    // A damaged caps record is not a record that simply does nothing: admission refuses every new request until it is repaired, and the answer in the composed controller says so.
    const capsRef = { kind: "capacity-limits-settings", id: "main" };
    const stored = await c.storage.getAggregate(capsRef);
    await c.storage.applyOperation({
      operationId: "cap-damage", epoch: c.epoch, actor: "owner:rob", correlationId: "cap-damage", at: new Date().toISOString(),
      changes: [{ type: "update", ref: capsRef, expectedRevision: stored!.revision, body: { perProject: { enabled: true, value: "many" } } }],
      audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
    } as never);
    const damaged = await ask();
    assert.match(damaged, /^Capacity caps: the caps record you stored is damaged - nothing new is admitted, not an inquiry, not a review, not productive work - until it is repaired with capacity\.limits\.change; what is already running is not stopped\.$/m, "the honest consequence, in the controller as it starts");
    assert.match(damaged, /^Host and global quotas/m, "the other two groups are still read");
    assert.match(damaged, /^Limits on spawning child tasks/m);
    assert.equal((await call("capacity.limits.get", {})).error?.code, "integrity", "the state API reads the same damaged record");

    // A caller that is not the owner reads exactly what it would read if nothing of the kind existed.
    assert.equal((await as(ann, "status.ask", { request: { kind: "capacity" } })).error?.code, "not_found");
    assert.equal((await as(ann, "capacity.limits.get", {})).error?.code, "forbidden", "the state API itself still refuses the read");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

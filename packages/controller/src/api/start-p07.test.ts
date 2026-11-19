import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { PI } from "../dispatch/testing/world.js";
import { SIMULATED_EFFECT_LABEL } from "../domain/effects.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { SimulatedServices } from "../service-ops/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const LAYOUT = {
  billing: { db: { state: { size: 10 }, dependents: [{ service: "billing", resource: "api" }] }, api: { state: {} }, cache: { state: {} } },
  shop: { cart: { state: { replicas: 1 } } },
};

// Card P07 (first slice): a simulation scope through the RUNNING controller: the API, the chat and a restart. The scope works on its own stand-in, every result is labelled simulated,
// nothing reaches the real service target or queues a delivery, a simulated result cannot back a deliverable, and real access stays the owner's separate grant.
test("a simulation scope through the composed controller: labelled results, no real write or delivery, not a real outcome, owner only, reachable in chat, kept over a restart (card P07)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p07-"));
  const say: { [text: string]: unknown[] } = {};
  const interpreter = new ScriptedInterpreter((input) => say[input.text] ?? []);
  const real = new SimulatedServices(LAYOUT);
  const start = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], artifacts: { directory: join(d, "blobs") }, serviceTarget: real, chat: { interpreter } });
  let c = await start();
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Restart the cart" })).id;
    const made = await s.agents.create(rob, { commandId: "mk-ann", friendlyName: "Ann", roles: ["author"] });
    const annId = `agent:${made.id}`;
    await s.grants.grant(rob, { commandId: "g-ann", grantee: annId, action: "task.read", project, source: "direct", basis: "test" } as never);
    await s.grants.grant(rob, { commandId: "g-ann2", grantee: annId, action: "effect.perform", project, source: "direct", basis: "test" } as never);
    const ann = (await s.principals.issueCredential(rob, annId)).token;
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const readTable = async (table: "deliveries" | "state"): Promise<Record<string, unknown>[]> => {
      const snap = await c.storage.snapshot();
      try { return await snap.read(table, { limit: 500 }); } finally { await snap.close(); }
    };
    const outbox = async () => JSON.stringify({ rows: await readTable("deliveries"), seq: (await readTable("state"))[0]!["delivery_seq"] });
    const outbox0 = await outbox();

    // An agent may not open or use a scope, even with the right to operate the real service.
    assert.equal((await call(ann, "simulation.open", { taskId: task, layout: LAYOUT }, "o0")).error.code, "forbidden");
    const opened = await call(boot.token, "simulation.open", { taskId: task, layout: LAYOUT, purpose: "try the restart first" }, "o1");
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const scopeId = opened.result.id as string;
    assert.match(opened.result.scope.label, /^Simulated\./);
    assert.equal(opened.result.scope.isolation.realServices, false);

    const op = await call(boot.token, "simulation.operate", { scopeId, service: "billing", resource: "db", action: { type: "restart" } }, "s1");
    assert.equal(op.ok, true, JSON.stringify(op));
    assert.equal(op.result.status, "confirmed");
    assert.equal(op.result.simulated, true);
    assert.equal(op.result.label, SIMULATED_EFFECT_LABEL);
    assert.equal(op.result.evidence.simulated, true);
    assert.equal((await call(boot.token, "simulation.operate", { scopeId, service: "billing", resource: "db", action: { type: "restart" } }, "s1")).result.effectId, op.result.effectId, "the same command once");
    const failed = await call(boot.token, "simulation.operate", { scopeId, service: "shop", resource: "cart", action: { type: "restart" }, inject: "refuse" }, "s2");
    assert.equal(failed.result.status, "failed");
    assert.equal((await call(ann, "simulation.operate", { scopeId, service: "shop", resource: "cart", action: { type: "restart" } }, "s3")).error.code, "forbidden");
    assert.equal((await call(ann, "simulation.get", { scopeId })).error.code, "not_found");
    const seen = await call(boot.token, "simulation.observe", { scopeId, service: "billing", resource: "api" });
    assert.equal(seen.result.state.restarts, 1, "the dependent restarted in the stand-in");
    assert.equal(seen.result.simulated, true);

    // Nothing real: the connected service target was never reached, no delivery was queued.
    assert.deepEqual(real.calls, []);
    assert.equal(real.stateOf({ service: "billing", resource: "api" })?.["restarts"], undefined);
    assert.equal(await outbox(), outbox0, "the scope queued no delivery");

    // A simulated result cannot back a deliverable: the outcome check refuses it by name.
    const draft = await call(boot.token, "deliverable.draft", { taskId: task, type: "operational-outcome", title: "Restarted", responsibleAgent: annId, outcome: { reference: op.result.effectId, systemVersion: op.result.evidence.systemVersion, observedAt: op.result.evidence.observedAt } }, "d1");
    assert.equal(draft.ok, false, JSON.stringify(draft));
    assert.match(JSON.stringify(draft.error), /simulated/);

    // The chat reaches every scope control in free words (no fixed phrase), and applies them at once: they change nothing real.
    const words = "in that simulation, set the cart to three replicas";
    say[words] = [{ kind: "command", op: "simulation.operate", args: { scopeId, service: "shop", resource: "cart", action: { type: "set", params: { fields: { replicas: 3 } } } }, evidence: words, basis: "owner" }];
    const chatted = await c.chat!.submit(boot.token, { messageId: "m1", text: words });
    assert.ok((chatted.outcomes as readonly { status: string }[]).some((o) => o.status === "applied"), JSON.stringify(chatted));
    assert.equal((await call(boot.token, "simulation.observe", { scopeId, service: "shop", resource: "cart" })).result.state.replicas, 3);
    assert.deepEqual(real.calls, [], "still nothing on the real target");
    // A text given as state is still the owner's own words: one the model made up is refused, nothing done.
    const invented = "in that simulation, label the cart";
    say[invented] = [{ kind: "command", op: "simulation.operate", args: { scopeId, service: "shop", resource: "cart", action: { type: "set", params: { fields: { note: "invented by the model" } } } }, evidence: invented, basis: "owner" }];
    const refused = await c.chat!.submit(boot.token, { messageId: "m1b", text: invented });
    assert.ok((refused.outcomes as readonly { status: string; code?: string }[]).some((o) => o.code === "unsupported_value"), JSON.stringify(refused));
    assert.equal((await call(boot.token, "simulation.observe", { scopeId, service: "shop", resource: "cart" })).result.state.note, undefined);

    // A restart keeps the scope, its world and its effects.
    await c.close();
    c = await start();
    const after = await call(boot.token, "simulation.get", { scopeId });
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.deepEqual(after.result.effects.map((e: any) => e.status), ["confirmed", "failed", "confirmed"]);
    assert.ok(after.result.effects.every((e: any) => e.simulated === true));
    assert.equal((await call(boot.token, "simulation.observe", { scopeId, service: "shop", resource: "cart" })).result.state.replicas, 3);

    const close = "close that simulation";
    say[close] = [{ kind: "command", op: "simulation.close", args: { scopeId }, evidence: close, basis: "owner" }];
    const closed = await c.chat!.submit(boot.token, { messageId: "m2", text: close });
    assert.ok((closed.outcomes as readonly { status: string }[]).some((o) => o.status === "applied"), JSON.stringify(closed));
    assert.equal((await call(boot.token, "simulation.operate", { scopeId, service: "shop", resource: "cart", action: { type: "restart" } }, "s9")).error.code, "invalid_command", "a closed scope refuses");

    // Real access is separate: the real operation is the agent's own, under its own grant, and reaches the real target once.
    const realOp = await call(boot.token, "service.operate", { taskId: task, service: "shop", resource: "cart", action: { type: "restart" } }, "r1");
    assert.equal(realOp.result.status, "confirmed", JSON.stringify(realOp));
    assert.equal(realOp.result.evidence.simulated, undefined);
    assert.equal(real.calls.length, 1);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

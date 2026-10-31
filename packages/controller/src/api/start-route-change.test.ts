import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contextRouteKey } from "../context/index.js";
import { BlockerService } from "../domain/index.js";
import { derivedId } from "../domain/ids.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const provider = { enabled: true, paid: false, location: "local" as const };
const table = { providers: { big: provider, tiny: provider }, routes: { "big/one": { contextTokens: 200_000, capabilities: ["tools"] }, "tiny/one": { contextTokens: 8_192, capabilities: ["tools"] }, "tiny/fresh": { contextTokens: 8_192, capabilities: ["tools"] } }, profiles: { main: ["big/one", "tiny/one", "tiny/fresh"] }, roles: { coordinator: "main", "safety-supervisor": "main" } };

// Card C07f, through the real composition: the dispatcher's route-change hook reaches the context service, a refusal is shown with its remedies, a task back on its route has the refusal closed, and the owner's setting turns the check off.
test("a task that moves to a route too small for its fixed part is refused with the ways out, the stale refusal is closed when it returns to its route, and the check can be turned off in the settings", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-route-"));
  let current = "big/one";
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, route: async () => ({ route: current, harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }) },
  } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.routing.setTable(rob, { commandId: "tbl", expectedRevision: 0, table } as never);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-worker", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: workGrants(project, ["read-file"]) });
    const taskId = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Order seeds" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId, owner: { kind: "agent", id: "agt-abcdefghijklmnopqrst" } });
    const a = (await c.services.assignments.getAssignment(taskId))!;
    await c.services.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "agt-abcdefghijklmnopqrst" }, harness: "pi" });
    // The task last ran on the big route.
    await c.storage.applyOperation({ operationId: "op-placed", epoch: c.epoch, actor: rob.id, correlationId: "op-placed", at: new Date().toISOString(), changes: [{ type: "create", ref: { kind: "task-placement", id: taskId }, body: { hostId: "host:pc", route: "big/one" } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    // The small route was measured before (its window was larger then): a prompt and tools that do not fit 8,192 tokens. A route nobody measured is never refused on a guess.
    await c.storage.applyOperation({ operationId: "op-fixed", epoch: c.epoch, actor: rob.id, correlationId: "op-fixed", at: new Date().toISOString(), changes: [{ type: "create", ref: { kind: "ctx-route-fixed", id: derivedId("ctx", `route\0${contextRouteKey("tiny/one")}\0pi\0fixed`) }, body: { route: contextRouteKey("tiny/one"), harness: "pi", samples: [{ systemPromptChars: 15_000, toolSchemaChars: 9_000, attemptId: "old" }] } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    const blockers = BlockerService.withEpoch(c.storage, c.epoch);
    const subject = { kind: "task", id: taskId } as const;

    // The settings: on by default, owner only.
    const first = (await call(boot.token, "context.route.get", {})).result.item;
    assert.deepEqual([first.effective.check, first.effective.floorChars], [true, 14_000]);

    // The route moves to a window too small for the prompt and tools of any harness: the attempt does not start, and the reason names the ways out.
    current = "tiny/one";
    await c.dispatch!.dispatcher.tick();
    const refused = await blockers.openFor("dispatch_blocked", subject);
    assert.match(refused?.summary ?? "", /essential constraints do not fit the 8192-token route/);
    assert.match(refused?.summary ?? "", /moved from big\/one to tiny\/one/);
    const overflow = await blockers.openFor("context_overflow", subject);
    assert.match(overflow?.summary ?? "", /larger window.*task contract.*supersede.*reassign/s);

    // Back on the route it ran on: the context refusal that was left behind is closed.
    current = "big/one";
    await c.dispatch!.dispatcher.tick();
    assert.equal(await blockers.openFor("context_overflow", subject), undefined, "the stale context blocker was closed");

    // The owner follows the advice and raises the small route's window while the refusal is still open: the route is rebuilt, fits, and the refusal does not hold the first call.
    current = "tiny/one";
    await c.dispatch!.dispatcher.tick();
    assert.ok(await blockers.openFor("context_overflow", subject), "refused again");
    const routing = (await c.services.routing.get())!;
    await c.services.routing.setTable(rob, { commandId: "tbl2", expectedRevision: routing.revision, table: { ...table, routes: { ...table.routes, "tiny/one": { contextTokens: 200_000, capabilities: ["tools"] } } } } as never);
    await c.dispatch!.dispatcher.tick();
    assert.equal(await blockers.openFor("context_overflow", subject), undefined, "the refusal of the old window was closed when the raised window fits");
    // The owner turns the check off in chat terms (the operation): the move is no longer asked.
    assert.ok((await call(boot.token, "context.route.change", { disable: ["check"] }, "rc1")).ok);
    assert.equal((await call(boot.token, "context.route.get", {})).result.item.effective.check, false);
    assert.ok((await call(boot.token, "context.route.change", { enable: ["check"], set: { floorChars: 9_000 } }, "rc2")).ok);
    assert.equal((await call(boot.token, "context.route.get", {})).result.item.effective.floorChars, 9_000);

    // A route nobody measured whose assumed fixed part does not fit is not refused: the owner gets a notice, once per attempt and route (finding 7 of the third review).
    const notices = async (): Promise<string[]> => (await c.storage.listAggregates("notification-item", { limit: 500 })).map((x) => JSON.stringify(x.body)).filter((t) => t.includes("has not been measured yet"));
    assert.equal((await notices()).length, 0);
    current = "tiny/fresh";
    await c.dispatch!.dispatcher.tick();
    assert.equal(await blockers.openFor("context_overflow", subject), undefined, "an unmeasured route is not refused on a guess");
    assert.equal((await notices()).length, 1, "the owner is told that the route was not measured");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});

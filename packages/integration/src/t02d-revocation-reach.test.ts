import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CatalogService, DeskService, SqliteStorage, ToolExecutionService, personalNamespace, type BridgeResponse } from "@nimblenewt/controller";
import { buildWorld, workGrants } from "@nimblenewt/controller/testing";
import { hostScriptRunner, type LaunchRecord } from "@nimblenewt/worker";

// Card T02d, composed: a REAL sandboxed script is running for a call served by one tool execution service ("the other process": its catalogue view has no revoke listener), the owner revokes the version through the catalogue
// the other service shares only through the store, and the production runner (`hostScriptRunner`) has its process killed. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const manifest = {
  purpose: "wait", input: { type: "object", properties: { url: { type: "string", maxLength: 200 } }, required: ["url"], additionalProperties: false }, output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  entryPoint: "bin/wait.js", interpreter: { name: "node", version: process.versions.node }, os: ["linux", "darwin", "win32"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 256, seconds: 60 }, cancellation: "cooperative", recovery: "none",
};
const good = (r: BridgeResponse): Record<string, unknown> => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { result: Record<string, unknown> }).result; };

describe("a revoke taken by another process stops a real sandboxed script (card T02d)", () => {
  test("the production script runner's process is killed, the call fails, and nothing is left behind", async (t) => {
    const records: LaunchRecord[] = [];
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn t02d ")));
    const storage = await SqliteStorage.open({ path: join(directory, "db.sqlite") });
    const host = await hostScriptRunner({ base: join(directory, "runs"), audit: (r) => { records.push(r); }, requireEnforced: false });
    try {
      if (host.problem() !== undefined) {
        if (required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${host.problem()}`);
        return t.skip(`unusable here: ${host.problem()}`);
      }
      const world = await buildWorld(storage);
      const desks = DeskService.withEpoch(world.storage, world.epoch, world.options);
      const catalog = CatalogService.withEpoch(world.storage, world.epoch, desks, world.options);
      // The other process: it reads the catalogue, but is never told of a revocation (no `onRevoked`).
      const view = { get: catalog.get.bind(catalog), list: catalog.list.bind(catalog), register: catalog.register.bind(catalog), content: catalog.content.bind(catalog), authorizeRun: catalog.authorizeRun.bind(catalog), revocationOf: catalog.revocationOf.bind(catalog) };
      const make = (c: typeof view | CatalogService): ToolExecutionService => new ToolExecutionService({
        principal: world.dispatcherPrincipal, credentials: world.credentials, dispatch: { get: (...a) => world.dispatcher.get(...a), toolOperation: (...a) => world.dispatcher.toolOperation(...a) }, assignments: world.assignments, catalog: c, hosts: world.hosts, admission: world.admission, pauses: world.pauses, desks,
        runner: host.runner, facts: host.facts, isLocalHost: () => true, revocationPolicy: () => "finish", revocationWatchMs: 50,
      });
      const here = make(catalog);
      const other = make(view);
      const ann = await world.agent("ann", [...workGrants(world.project), { action: "desk.write", project: world.project }, { action: "desk.read", project: world.project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }, { action: `tool.${personalNamespace("agent:ann").replace(/^a_/, "a-")}.*`, project: world.project }]);
      await world.task("Wait for a long time", ann);
      await world.policy.set(world.owner, { scope: "installation", commandId: "pol", profile: "autonomous" });
      const out: { answer?: BridgeResponse; elapsed?: number; leftover?: string[] } = {};
      world.worker.script = async ({ order, gateway }) => {
        const send = (svc: ToolExecutionService, op: string, args: Record<string, unknown>, callId: string) => svc.handle(order.credential, gateway, { op, callId, args } as never);
        const doc = good(await send(here, "desk.write", { kind: "note", title: "wait notes", body: "waits", visibility: "shared", status: "accepted" }, "w1"));
        const code = good(await send(here, "desk.write", { kind: "note", title: "wait code", body: "console.log('{\"ok\":true}'); setInterval(() => {}, 1000);", visibility: "shared", status: "accepted" }, "w2"));
        const made = good(await send(here, "tool.register", { name: "wait", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: doc["id"], executableRecordId: code["id"] }, "w3"));
        const args = { tool: made["name"], version: "1.0.0", input: { url: "u" } };
        const first = good(await send(here, "tool.invoke", args, "long"));
        assert.equal(first["state"], "awaiting-approval");
        const review = (await world.reviews.get(world.owner, first["reviewId"] as string))!;
        await world.reviews.decide(world.owner, { commandId: "dec", requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "fine" });
        const started = Date.now();
        const running = send(other, "tool.invoke", args, "long");
        // Wait until the script's process really exists in the sandbox.
        const until = Date.now() + 15_000;
        while (records.length < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
        while (other.runningTotal(made["name"] as string, "1.0.0") === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(here.runningTotal(made["name"] as string, "1.0.0"), 0, "the process that takes the command has no call of it");
        await catalog.revoke(world.owner, { commandId: "rev", name: made["name"] as string, version: "1.0.0", reason: "found a bug", runningCalls: "cancel" });
        out.answer = await running;
        out.elapsed = Date.now() - started;
        out.leftover = readdirSync(join(directory, "runs"));
        return { status: "completed", text: "done" };
      };
      await world.dispatcher.tick();
      await world.dispatcher.idle();
      assert.ok(out.answer !== undefined, "the scenario ran to its end");
      assert.equal(good(out.answer)["state"], "failed", JSON.stringify(out.answer));
      assert.ok(out.elapsed! < 30_000, `the script was killed by the revocation, not left to its 60 seconds (${out.elapsed} ms)`);
      assert.deepEqual(out.leftover, []);
      here.dispose(); other.dispose();
    } finally {
      await host.stop();
      await storage.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

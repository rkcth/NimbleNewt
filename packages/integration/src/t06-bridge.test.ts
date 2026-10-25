import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId } from "@nimblenewt/contracts";
import { CatalogService, DeskService, SqliteStorage, ToolExecutionService, personalNamespace, type ScriptLaunch, type ToolGateway, type WorkOrder, type WorkerHandle, type WorkerHost } from "@nimblenewt/controller";
import { buildWorld, workGrants } from "@nimblenewt/controller/testing";
import { PiAdapter, boundTransport, composeTools, createBridge } from "@nimblenewt/pi-adapter";

const manifest = {
  purpose: "double a number", input: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false }, output: { type: "object", properties: { result: { type: "integer" } }, required: ["result"] },
  entryPoint: "bin/double.js", interpreter: { name: "node", version: "22.19.0" }, os: ["linux", "darwin", "win32"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 64, seconds: 10 }, cancellation: "cooperative", recovery: "none",
};
const recordIdIn = (messages: readonly unknown[]): string => {
  const found = /"id\\?":\\?"(dsk-[a-z2-7]{20})/g;
  const all = [...JSON.stringify(messages).matchAll(found)].map((m) => m[1]!);
  return all[all.length - 1]!;
};

test("one conversation, one worker start: a real Pi agent writes a script to its desk, registers it, finds it, reads its description and runs it through the protected bridge, and the controller checked and recorded every step", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nn t06 "));
  const storage = await SqliteStorage.open({ path: join(directory, "db.sqlite") });
  try {
    const models = createModels();
    const faux = fauxProvider({ provider: "offline", models: [{ id: "scripted" }] });
    models.setProvider(faux.provider);
    const world = await buildWorld(storage);
    const desks = DeskService.withEpoch(world.storage, world.epoch, world.options);
    const catalog = CatalogService.withEpoch(world.storage, world.epoch, desks, world.options);
    const launches: ScriptLaunch[] = [];
    let dispatcher = world.dispatcher;
    const service = new ToolExecutionService({
      principal: world.dispatcherPrincipal, credentials: world.credentials, dispatch: { get: (...a) => dispatcher.get(...a), toolOperation: (...a) => dispatcher.toolOperation(...a) }, assignments: world.assignments, catalog, hosts: world.hosts, admission: world.admission, pauses: world.pauses, desks,
      runner: { run: async (launch) => { launches.push(launch); return { text: JSON.stringify({ result: (JSON.parse(launch.stdin) as { n: number }).n * 2 }) }; } },
      facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 }), isLocalHost: () => true });
    const ann = await world.agent("ann", [...workGrants(world.project), { action: "desk.write", project: world.project }, { action: "desk.read", project: world.project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }, { action: `tool.${personalNamespace("agent:ann").replace(/^a_/, "a-")}.*`, project: world.project }]);
    const { attemptId } = await world.task("Double a number with a tool of my own", ann);
    await world.policy.set(world.owner, { scope: "installation", commandId: "pol", profile: "autonomous" });

    let starts = 0;
    const host: WorkerHost = {
      hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 },
      start: async (order: WorkOrder): Promise<WorkerHandle> => {
        starts++;
        let gateway: ToolGateway | undefined;
        // A reviewer who answers at once: an ask that is parked is approved and the same request is made again with the same call ID.
        const transport = boundTransport(order.credential, async (token, request) => {
          const first = await service.handle(token, gateway!, request as never);
          if (first.ok && first.result["state"] === "awaiting-approval") {
            const review = (await world.reviews.get(world.owner, first.result["reviewId"] as string))!;
            await world.reviews.decide(world.owner, { commandId: `dec-${request.callId}`, requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "reviewed" });
            return service.handle(token, gateway!, request as never) as never;
          }
          return first as never;
        });
        const bridge = createBridge(transport);
        const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(join(directory, order.attemptId), BACKGROUND_CONTEXT), models, model: { provider: "offline", modelId: "scripted" }, tools: composeTools(bridge, [], personalNamespace(order.agentId).slice(2)) });
        return {
          workerVersion: "pi-worker-1.0.0",
          run: async (g) => {
            gateway = g;
            const result = await (await adapter.root().submit({ kind: "input", requestId: requestId(order.requestId), content: order.content })).result();
            return { status: result.status === "completed" ? "completed" : "failed", ...("text" in result && typeof result.text === "string" ? { text: result.text } : {}) };
          },
          checkpoint: async () => ({}), restart: async () => undefined, stop: async () => { await adapter.close(); },
        };
      },
    };
    world.worker.script = async () => ({ status: "failed", error: "unused" });
    dispatcher = world.restart({ workers: [host], replaySafe: service.replaySafe });

    let notes = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("nimblenewt__desk-write", { kind: "note", title: "double notes", body: "Doubles the integer n.", visibility: "shared", status: "accepted" }, { id: "c1" }), { stopReason: "toolUse" }),
      (context) => { notes = recordIdIn(context.messages); return fauxAssistantMessage(fauxToolCall("nimblenewt__desk-write", { kind: "note", title: "double code", body: "// double.js", visibility: "shared", status: "accepted" }, { id: "c2" }), { stopReason: "toolUse" }); },
      (context) => fauxAssistantMessage(fauxToolCall("nimblenewt__tool-register", { name: "double", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: notes, executableRecordId: recordIdIn(context.messages) }, { id: "c3" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("nimblenewt__tool-discover", { query: "double" }, { id: "c4" }), { stopReason: "toolUse" }),
      (context) => { const name = /(a_[a-z0-9]+\.double)/.exec(JSON.stringify(context.messages))![1]!; return fauxAssistantMessage(fauxToolCall("nimblenewt__tool-describe", { tool: name }, { id: "c5" }), { stopReason: "toolUse" }); },
      (context) => { const name = /(a_[a-z0-9]+\.double)/.exec(JSON.stringify(context.messages))![1]!; return fauxAssistantMessage(fauxToolCall("nimblenewt__tool-invoke", { tool: name, input: { n: 21 } }, { id: "c6" }), { stopReason: "toolUse" }); },
      (context) => fauxAssistantMessage(`The tool answered: ${/result[^0-9]{0,6}(\d+)/.exec(JSON.stringify(context.messages.slice(-1)))?.[1] ?? "?"}`),
    ]);
    const report = await dispatcher.tick();
    await dispatcher.idle();
    assert.deepEqual(report.started, [attemptId]);
    assert.equal(starts, 1, "created, registered and used without a worker reload");
    const record = (await dispatcher.get(world.owner, attemptId!))!;
    assert.equal(record.outcome?.status, "succeeded", JSON.stringify(record.outcome));
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0]!.argv, ["bin/double.js"]);
    assert.deepEqual(JSON.parse(launches[0]!.stdin), { n: 21 });
    const ops = (await dispatcher.operations(world.owner, attemptId!))!;
    assert.deepEqual(ops.map((o) => [o.callId, o.state]), [["c6", "confirmed"]], "the invocation is a durable operation of the attempt on the exact version");
    assert.equal(ops[0]!.tool.version, "1.0.0");
    assert.equal((await catalog.usage(world.owner, { projectId: world.project })).items.length, 1);
    const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(join(directory, attemptId!), BACKGROUND_CONTEXT), models, model: { provider: "offline", modelId: "scripted" }, tools: [] });
    const transcript = JSON.stringify(await adapter.root().transcript());
    await adapter.close();
    assert.match(transcript, /The tool answered: 42/);
  } finally {
    await storage.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

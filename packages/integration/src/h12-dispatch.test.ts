import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId } from "@nimblenewt/contracts";
import { SqliteStorage, type ToolGateway, type WorkOrder, type WorkerHandle, type WorkerHost } from "@nimblenewt/controller";
import { buildWorld, workGrants } from "@nimblenewt/controller/testing";
import { PiAdapter, type AdapterTool } from "@nimblenewt/pi-adapter";

/** A worker host whose harness is the real Pi adapter over durable storage with a scripted model: every tool the model calls goes through the gateway the dispatcher bound to the attempt. */
function piWorker(directory: string, faux: ReturnType<typeof fauxProvider>, models: ReturnType<typeof createModels>): { host: WorkerHost; seen: string[] } {
  const seen: string[] = [];
  const host: WorkerHost = {
    hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 },
    start: async (order: WorkOrder): Promise<WorkerHandle> => {
      let gateway: ToolGateway | undefined;
      const tool = (name: string): AdapterTool => ({
        name, description: `${name} of a file`, parameters: Type.Object({ path: Type.String() }),
        execute: async (args: { path: string }, context) => {
          const result = await gateway!.call({ callId: context.callId, tool: { name, version: "1.0.0" }, args }, { kind: "local", run: async () => { seen.push(`${name} ${args.path}`); return { text: `contents of ${args.path}` }; } });
          return result.state === "confirmed" ? result.text : `[${result.state}] ${result.reason}`;
        },
      } as AdapterTool);
      const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(join(directory, order.attemptId), BACKGROUND_CONTEXT), models, model: { provider: "offline", modelId: "scripted" }, tools: [tool("read-file"), tool("write-file")] });
      return {
        workerVersion: "pi-worker-1.0.0",
        run: async (g) => {
          gateway = g;
          const handle = await adapter.root().submit({ kind: "input", requestId: requestId(order.requestId), content: order.content });
          const result = await handle.result();
          return { status: result.status === "completed" ? "completed" : "failed", ...("text" in result && typeof result.text === "string" ? { text: result.text } : {}), checkpoint: JSON.parse(JSON.stringify(await adapter.root().checkpoint())) as never };
        },
        checkpoint: async () => JSON.parse(JSON.stringify(await adapter.root().checkpoint())) as never,
        restart: async () => undefined,
        stop: async () => { await adapter.close(); },
      };
    },
  };
  void faux;
  return { host, seen };
}

test("an admitted attempt runs a real Pi turn with the scripted offline model: every tool call is a durable operation, a call outside the grants is refused and the model sees it, and the attempt records what it ran under", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nn h12 "));
  const storage = await SqliteStorage.open({ path: join(directory, "db.sqlite") });
  try {
    const models = createModels();
    const faux = fauxProvider({ provider: "offline", models: [{ id: "scripted" }] });
    models.setProvider(faux.provider);
    const world = await buildWorld(storage);
    const ann = await world.agent("ann", workGrants(world.project, ["read-file"]));
    const { taskId, attemptId } = await world.task("Read the README", ann);
    const { host, seen } = piWorker(directory, faux, models);
    world.worker.script = async () => ({ status: "failed", error: "unused" });
    const dispatcher = world.restart({ workers: [host] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read-file", { path: "README.md" }, { id: "call-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write-file", { path: "README.md" }, { id: "call-2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("I read the file and was not allowed to write it."),
    ]);
    const report = await dispatcher.tick();
    await dispatcher.idle();
    assert.deepEqual(report.started, [attemptId]);
    assert.deepEqual(seen, ["read-file README.md"], "the refused call never reached the sandbox");
    const record = (await dispatcher.get(world.owner, attemptId!))!;
    assert.equal(record.state, "finished");
    assert.equal(record.outcome?.status, "succeeded");
    assert.deepEqual([record.harness, record.route, record.workerVersion], ["pi", "localp/small", "pi-worker-1.0.0"]);
    const ops = (await dispatcher.operations(world.owner, attemptId!))!;
    assert.deepEqual(ops.map((o) => [o.callId, o.tool.name, o.state]), [["call-1", "read-file", "confirmed"], ["call-2", "write-file", "refused"]]);
    assert.match(ops[1]!.diagnostics[0]!, /no grant for tool\.write-file/);
    assert.equal(ops[0]!.taskId, taskId);
    assert.equal((await world.assignments.getAttempt(attemptId!))!.state, "succeeded");
    assert.equal((await world.projects.getTask(taskId))!.state, "ready", "the attempt does not decide the task's outcome");
    // The model saw the refusal: the request that followed it carried it.
    const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(join(directory, attemptId!), BACKGROUND_CONTEXT), models, model: { provider: "offline", modelId: "scripted" }, tools: [] });
    const transcript = JSON.stringify(await adapter.root().transcript());
    await adapter.close();
    assert.match(transcript, /not allowed to write it/);
  } finally {
    await storage.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

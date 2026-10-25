import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId } from "@nimblenewt/contracts";
import { CatalogService, DeskService, SqliteStorage, ToolExecutionService, personalNamespace, type ToolGateway, type WorkOrder, type WorkerHandle, type WorkerHost } from "@nimblenewt/controller";
import { buildWorld, workGrants } from "@nimblenewt/controller/testing";
import { PiAdapter, boundTransport, composeTools, createBridge } from "@nimblenewt/pi-adapter";
import { SandboxLauncher, scriptRunner, type LaunchRecord } from "@nimblenewt/worker";

// Card T06b, the script runner: the controller's tool execution service runs a registered script through the real sandbox launcher (bubblewrap), with the model's input on standard input and the manifest's
// time and output limits enforced; a run that breaks a limit is a failed operation of the attempt. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));

const manifest = (limits: { cpus: number; memoryMb: number; seconds: number }) => ({
  purpose: "double a number", input: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false }, output: { type: "object", properties: { result: { type: "integer" } }, required: ["result"] },
  entryPoint: "bin/double.js", interpreter: { name: "node", version: process.versions.node }, os: ["linux", "darwin", "win32"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits, cancellation: "cooperative", recovery: "none",
});
const recordIdIn = (messages: readonly unknown[]): string => {
  const found = /"id\\?":\\?"(dsk-[a-z2-7]{20})/g;
  const all = [...JSON.stringify(messages).matchAll(found)].map((m) => m[1]!);
  return all[all.length - 1]!;
};

interface Outcome { readonly operation: { readonly callId: string; readonly state: string; readonly diagnostics: readonly string[] }; readonly final: string; readonly records: readonly LaunchRecord[]; readonly leftBehind: readonly string[] }

/** One conversation: a Pi agent writes `source` to its desk, registers it as a tool with the limits, and invokes it with `{ n: 21 }` through the protected bridge, whose scripts run in the real sandbox. */
async function converse(launcher: SandboxLauncher, records: LaunchRecord[], source: string, limits: { cpus: number; memoryMb: number; seconds: number }): Promise<Outcome> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn t06b ")));
  const runs = join(directory, "runs");
  mkdirSync(runs);
  const storage = await SqliteStorage.open({ path: join(directory, "db.sqlite") });
  try {
    const models = createModels();
    const faux = fauxProvider({ provider: "offline", models: [{ id: "scripted" }] });
    models.setProvider(faux.provider);
    const world = await buildWorld(storage);
    const desks = DeskService.withEpoch(world.storage, world.epoch, world.options);
    const catalog = CatalogService.withEpoch(world.storage, world.epoch, desks, world.options);
    let dispatcher = world.dispatcher;
    const service = new ToolExecutionService({
      principal: world.dispatcherPrincipal, credentials: world.credentials, dispatch: { get: (...a) => dispatcher.get(...a), toolOperation: (...a) => dispatcher.toolOperation(...a) }, assignments: world.assignments, catalog, hosts: world.hosts, admission: world.admission, pauses: world.pauses, desks,
      // The real runner over the real launcher. This host may not be able to enforce cgroup limits (a container), so they are not required here; the launch record shows how each was applied.
      runner: scriptRunner({ launcher, interpreters: (name, version) => (name === "node" && version === process.versions.node ? { root: nodeRoot, executable: "bin/node" } : undefined), base: runs, requireEnforced: false }),
      facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: process.versions.node }, packages: {}, cpus: 8, memoryMb: 16_384 }),
    });
    const ann = await world.agent("ann", [...workGrants(world.project), { action: "desk.write", project: world.project }, { action: "desk.read", project: world.project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }, { action: `tool.${personalNamespace("agent:ann").replace(/^a_/, "a-")}.*`, project: world.project }]);
    const { attemptId } = await world.task("Double a number with a tool of my own", ann);
    await world.policy.set(world.owner, { scope: "installation", commandId: "pol", profile: "autonomous" });

    const host: WorkerHost = {
      hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 },
      start: async (order: WorkOrder): Promise<WorkerHandle> => {
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
        const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(join(directory, order.attemptId), BACKGROUND_CONTEXT), models, model: { provider: "offline", modelId: "scripted" }, tools: composeTools(createBridge(transport), [], personalNamespace(order.agentId).slice(2)) });
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
      (context) => { notes = recordIdIn(context.messages); return fauxAssistantMessage(fauxToolCall("nimblenewt__desk-write", { kind: "note", title: "double code", body: source, visibility: "shared", status: "accepted" }, { id: "c2" }), { stopReason: "toolUse" }); },
      (context) => fauxAssistantMessage(fauxToolCall("nimblenewt__tool-register", { name: "double", kind: "tool", version: "1.0.0", manifest: manifest(limits), instructionsRecordId: notes, executableRecordId: recordIdIn(context.messages) }, { id: "c3" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("nimblenewt__tool-discover", { query: "double" }, { id: "c4" }), { stopReason: "toolUse" }),
      (context) => { const name = /(a_[a-z0-9]+\.double)/.exec(JSON.stringify(context.messages))![1]!; return fauxAssistantMessage(fauxToolCall("nimblenewt__tool-invoke", { tool: name, input: { n: 21 } }, { id: "c6" }), { stopReason: "toolUse" }); },
      (context) => fauxAssistantMessage(`Done: ${/result[^0-9]{0,6}42/.test(JSON.stringify(context.messages.slice(-1))) ? "42" : `no result; told: ${/(longer than its limit of \d+ seconds|wrote more than \d+ bytes)/.exec(JSON.stringify(context.messages.slice(-1)))?.[1] ?? "nothing"}`}`),
    ]);
    const before = records.length;
    const report = await dispatcher.tick();
    await dispatcher.idle();
    assert.deepEqual(report.started, [attemptId]);
    const ops = (await dispatcher.operations(world.owner, attemptId!))!;
    assert.equal(ops.length, 1);
    const reader = await PiAdapter.open({ storage: await openNodeJsonlStorage(join(directory, attemptId!), BACKGROUND_CONTEXT), models, model: { provider: "offline", modelId: "scripted" }, tools: [] });
    const transcript = JSON.stringify(await reader.root().transcript());
    await reader.close();
    return { operation: ops[0] as never, final: /Done: (42|no result; told: [^"\\]*)/.exec(transcript)?.[1] ?? "", records: records.slice(before), leftBehind: readdirSync(runs) };
  } finally {
    await storage.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe("the controller's script runner is the sandbox launcher", () => {
  const records: LaunchRecord[] = [];
  const open = async (): Promise<SandboxLauncher | undefined> => {
    const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: (r) => { records.push(r); } });
    const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
    if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`);
    return usable ? launcher : undefined;
  };
  const withSandbox = (name: string, fn: (launcher: SandboxLauncher) => Promise<void>): void => {
    test(name, async (t) => {
      const launcher = await open();
      if (launcher === undefined) return t.skip("bubblewrap or a node install it can mount is unusable");
      try { await fn(launcher); } finally { await launcher.stop(); }
    });
  };

  withSandbox("a tool the agent registered runs confined, takes its input on standard input and answers; the launch is recorded", async (l) => {
    const out = await converse(l, records, `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({result:JSON.parse(s).n*2})));`, { cpus: 1, memoryMb: 512, seconds: 20 });
    assert.equal(out.operation.state, "confirmed", JSON.stringify(out.operation));
    assert.equal(out.final, "42");
    assert.equal(out.records.length, 1, "one confined launch, recorded before it happened");
    assert.equal(out.records[0]!.mode, "sandboxed");
    assert.deepEqual(out.records[0]!.limits.map((x) => x.limit).sort(), ["cpus", "memoryMb"], "the manifest's limits reached the launcher and are accounted for");
    assert.deepEqual(out.leftBehind, [], "nothing is left behind");
  });

  withSandbox("a script over its time limit fails and is recorded as a failed operation; the agent is told", async (l) => {
    const out = await converse(l, records, `while(true){}`, { cpus: 1, memoryMb: 512, seconds: 1 });
    assert.equal(out.operation.state, "failed", JSON.stringify(out.operation));
    assert.match(out.operation.diagnostics.join(" | "), /longer than its limit of 1 seconds/);
    assert.equal(out.final, "no result; told: longer than its limit of 1 seconds", "the model was given the reason");
    assert.deepEqual(out.leftBehind, []);
  });

  withSandbox("a script over its output limit fails and is recorded as a failed operation", async (l) => {
    const out = await converse(l, records, `process.stdout.write("x".repeat(200000));`, { cpus: 1, memoryMb: 512, seconds: 20 });
    assert.equal(out.operation.state, "failed", JSON.stringify(out.operation));
    assert.match(out.operation.diagnostics.join(" | "), /wrote more than 65536 bytes and was cut off/);
    assert.equal(out.final, "no result; told: wrote more than 65536 bytes", "the model was given the reason");
    assert.deepEqual(out.leftBehind, []);
  });
});

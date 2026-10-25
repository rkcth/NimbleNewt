import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { requestId } from "@nimblenewt/contracts";
import { agentNamespace } from "@nimblenewt/registry";
import { BRIDGE_TOOL_NAMES, DeclarationBoard, PiAdapter, boundTransport, bridgeToolName, composeTools, createBridge, InvalidToolError, type AdapterTool, type BridgeReply, type BridgeRequest, type BridgeTransport } from "./index.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const AGENT = "ann0123456789abc";
/** A controller stand-in: records every request and answers from a table. */
function fakeController(catalogue: { name: string; kind: string; version: string }[] = []) {
  const seen: BridgeRequest[] = [];
  let revision = 0;
  const transport: BridgeTransport = {
    send: async (request): Promise<BridgeReply> => {
      seen.push(request);
      if (request.op === "tool.discover") return { ok: true, result: { revision: `r${revision}`, tools: catalogue.map((t) => ({ ...t, layer: "agent" })) } };
      if (request.op === "tool.invoke") return { ok: true, result: { state: "confirmed", text: "ran" } };
      return { ok: false, code: "forbidden", message: "not for you" };
    },
  };
  return { seen, transport, publish: (tool: { name: string; kind: string; version: string }) => { catalogue.push(tool); revision++; } };
}

test("the bridge declares a fixed set of stable tools in the reserved namespace, with wire names, shared by every agent and carrying no replay flag", () => {
  const bridge = createBridge(fakeController().transport);
  assert.deepEqual(bridge.tools.map((t) => t.name), BRIDGE_TOOL_NAMES.slice());
  assert.deepEqual(BRIDGE_TOOL_NAMES, ["desk-read", "desk-write", "message-send", "task-get", "task-transition", "task-update", "tool-discover", "tool-describe", "tool-invoke", "tool-register"].map((n) => `nimblenewt__${n}`));
  assert.equal(bridgeToolName("tool.invoke"), "nimblenewt__tool-invoke");
  for (const tool of bridge.tools) {
    assert.equal(tool.shared, true);
    assert.equal(tool.replay, undefined, "whether a call may be run again is the controller's decision from the approved manifest, never declared here");
    assert.ok(Object.isFrozen(tool));
  }
  assert.ok(Object.isFrozen(bridge) && Object.isFrozen(bridge.tools));
  // Two workers get the same declarations byte for byte (the head of every prompt is shared).
  const other = createBridge(fakeController().transport);
  assert.equal(JSON.stringify(bridge.tools.map((t) => [t.name, t.description, t.parameters])), JSON.stringify(other.tools.map((t) => [t.name, t.description, t.parameters])));
});

test("the extension holds only a send function bound to the worker's credential: no service, no admin method, no way to name a principal", async () => {
  const delivered: { token: string; request: BridgeRequest }[] = [];
  const transport = boundTransport("tcr-secret.value", async (token, request) => { delivered.push({ token, request }); return { ok: true, result: {} }; });
  assert.deepEqual(Object.keys(transport), ["send"]);
  assert.ok(Object.isFrozen(transport));
  assert.throws(() => { (transport as { send: unknown }).send = () => undefined; }, TypeError);
  assert.throws(() => boundTransport("", async () => ({ ok: true, result: {} })), InvalidToolError);
  const bridge = createBridge(transport);
  assert.deepEqual(Object.keys(bridge).sort(), ["declarations", "seed", "tools"]);
  await bridge.tools.find((t) => t.name === "nimblenewt__task-get")!.execute({} as never, { signal: undefined, callId: "c1" });
  assert.deepEqual(delivered, [{ token: "tcr-secret.value", request: { op: "task.get", callId: "c1", args: {} } }]);
  // The tool's own context carries only the call ID and a signal: nothing about who asks is ever sent.
  assert.deepEqual(Object.keys(delivered[0]!.request).sort(), ["args", "callId", "op"]);
});

test("a real Pi turn calls the bridge by its wire name; the model's call ID reaches the controller and its refusal comes back as text", async () => {
  const offline = createOfflineModels();
  const controller = fakeController([{ name: "toolbox.check", kind: "tool", version: "1.0.0" }]);
  const bridge = createBridge(controller.transport);
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF, tools: composeTools(bridge, [], AGENT) });
  cleanup.push(() => adapter.close());
  offline.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("nimblenewt__tool-invoke", { tool: "toolbox.check", input: { url: "u" } }, { id: "model-call-1" }), fauxToolCall("nimblenewt__desk-read", { recordId: "dsk-x" }, { id: "model-call-2" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const handle = await adapter.root().submit({ kind: "input", requestId: requestId("bridge-1"), content: "use the tool" });
  const result = await handle.result();
  assert.equal(result.status, "completed");
  assert.deepEqual(controller.seen.map((r) => [r.op, r.callId]), [["tool.invoke", "model-call-1"], ["desk.read", "model-call-2"]]);
  const transcript = JSON.stringify(await adapter.root().transcript());
  assert.match(transcript, /refused \(forbidden\): not for you/);
  assert.match(transcript, /confirmed/);
});

test("declarations: a tool published while a request is in flight appears at the next request, never in the one in flight; only names and versions are listed", async () => {
  const controller = fakeController([{ name: "toolbox.alpha", kind: "tool", version: "1.0.0" }]);
  const board = new DeclarationBoard(controller.transport);
  const a = await board.openRequest("req-a");
  assert.deepEqual(a.tools.map((t) => t.name), ["toolbox.alpha"]);
  controller.publish({ name: "a_ann0123456789abc.beta", kind: "tool", version: "1.0.0" });
  assert.deepEqual(board.snapshotOf("req-a")!.tools.map((t) => t.name), ["toolbox.alpha"], "the request in flight is unchanged");
  assert.equal(board.textOf("req-a").includes("beta"), false);
  assert.equal(await board.openRequest("req-a"), a, "opening the same request again is the same snapshot");
  const b = await board.openRequest("req-b");
  assert.deepEqual(b.tools.map((t) => t.name), ["toolbox.alpha", "a_ann0123456789abc.beta"]);
  assert.notEqual(a.revision, b.revision);
  assert.deepEqual(Object.keys(b.tools[0]!).sort(), ["kind", "name", "version"], "no description or schema is loaded into the prompt");
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.tools));
  board.closeRequest("req-a");
  assert.equal(board.snapshotOf("req-a"), undefined);
});

test("declarations: a catalogue longer than the limit says so; it is never cut silently", async () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ name: `toolbox.t${i}`, kind: "tool", version: "1.0.0" }));
  const transport: BridgeTransport = {
    send: async (request) => {
      const after = request.args?.["after"] as string | undefined;
      const limit = request.args?.["limit"] as number;
      const rest = many.filter((t) => after === undefined || t.name > after).slice(0, limit);
      const more = many.filter((t) => after === undefined || t.name > after).length > rest.length;
      return { ok: true, result: { revision: "r", tools: rest, ...(more ? { next: rest[rest.length - 1]!.name } : {}) } };
    },
  };
  const snapshot = await new DeclarationBoard(transport, { maxTools: 3 }).openRequest("r1");
  assert.equal(snapshot.tools.length, 3);
  assert.equal(snapshot.complete, false);
  const board = new DeclarationBoard(transport, { maxTools: 3 });
  await board.openRequest("r2");
  assert.match(board.textOf("r2"), /more exist/);
  assert.equal((await new DeclarationBoard(transport, { maxTools: 50 }).openRequest("r3")).complete, true);
});

test("personal extensions cannot disable or shadow the bridge: reserved and foreign namespaces, bare names and duplicates are refused, and the bridge tools are always present", () => {
  const bridge = createBridge(fakeController().transport);
  const tool = (name: string): AdapterTool => ({ name, description: "x", parameters: Type.Object({}), execute: async () => "ok" });
  const own = `${agentNamespace(AGENT)}__format`;
  const composed = composeTools(bridge, [tool(own)], AGENT);
  assert.deepEqual(composed.map((t) => t.name), [...BRIDGE_TOOL_NAMES, own]);
  assert.ok(Object.isFrozen(composed));
  for (const bad of ["nimblenewt__tool-invoke", "nimblenewt__evil", "toolbox__shared", "a_other0123456789__format", "format", "bash", `${agentNamespace(AGENT)}__Format`, `${agentNamespace(AGENT)}.format`]) {
    assert.throws(() => composeTools(bridge, [tool(bad)], AGENT), InvalidToolError, bad);
  }
  assert.throws(() => composeTools(bridge, [tool(own), tool(own)], AGENT), /duplicate/);
  assert.throws(() => composeTools(bridge, [], "Not An Agent"), InvalidToolError);
  // A bridge with a tool left out (an attempt to switch part of it off) is not accepted.
  const maimed = { ...bridge, tools: bridge.tools.filter((t) => t.name !== "nimblenewt__tool-invoke") };
  assert.throws(() => composeTools(maimed, [], AGENT), /cannot be switched off/);
  const forged = { ...bridge, tools: [...bridge.tools, tool("nimblenewt__extra")] };
  assert.throws(() => composeTools(forged, [], AGENT), /not a bridge tool/);
});

test("a personal tool gets no handle to the transport or the controller: it sees only its arguments and its call context", async () => {
  const controller = fakeController();
  const bridge = createBridge(controller.transport);
  let seenArgs: unknown[] = [];
  const spy: AdapterTool = { name: `${agentNamespace(AGENT)}__spy`, description: "x", parameters: Type.Object({}), execute: async (...args: unknown[]) => { seenArgs = args; return "ok"; } };
  const [, , , , , , , , , , personal] = composeTools(bridge, [spy], AGENT);
  await personal!.execute({} as never, { signal: undefined, callId: "p1" });
  assert.deepEqual(Object.keys(seenArgs[1] as object).sort(), ["callId", "signal"]);
  assert.equal(controller.seen.length, 0);
});

test("an attempt resumed in a new process goes on numbering after the call IDs already in its conversation, and no provider ID equals a number the bridge gave", async () => {
  const c = fakeController();
  const bridge = createBridge(c.transport);
  bridge.seed(["call_0", "call_0:2"]);
  const tool = bridge.tools.find((t) => t.name === bridgeToolName("task.get"))!;
  const ctx = (callId: string) => ({ callId }) as never;
  await tool.execute({}, ctx("call_0"));
  await tool.execute({}, ctx("call_0:2"));
  const ids = c.seen.map((r) => r.callId);
  assert.match(ids[0]!, /^d:[0-9a-f]{40}$/, "call_0 was used before the restart");
  assert.notEqual(ids[1], "call_0:2", "the second use of a seeded ID is renumbered too");
  assert.notEqual(ids[0], ids[1]);
});

test("a provider call ID the controller would refuse (a `|`, or too long) is sent as a digest of itself, always the same one; a fitting ID is sent as it is", async () => {
  const c = fakeController();
  const bridge = createBridge(c.transport);
  const tool = bridge.tools.find((t) => t.name === bridgeToolName("task.get"))!;
  const ctx = (callId: string) => ({ callId }) as never;
  await tool.execute({}, ctx("call_1|fc_9"));
  await tool.execute({}, ctx("call_1|fc_9"));
  await tool.execute({}, ctx("x".repeat(200)));
  await tool.execute({}, ctx("call_2"));
  const ids = c.seen.map((r) => r.callId);
  assert.match(ids[0]!, /^h:[0-9a-f]{40}$/);
  assert.notEqual(ids[0], ids[1], "the second use of a provider ID is another request to the controller");
  const again = fakeController();
  const tool2 = createBridge(again.transport).tools.find((t) => t.name === bridgeToolName("task.get"))!;
  await tool2.execute({}, ctx("call_1|fc_9"));
  await tool2.execute({}, ctx("call_1|fc_9"));
  assert.deepEqual(again.seen.map((r) => r.callId), [ids[0], ids[1]], "the same sequence of calls always gets the same IDs, so a restart replays them as the same calls");
  assert.match(ids[2]!, /^h:[0-9a-f]{40}$/);
  assert.equal(ids[3], "call_2");
});

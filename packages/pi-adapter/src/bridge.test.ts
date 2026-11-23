import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { requestId } from "@nimblenewt/contracts";
import { agentNamespace } from "@nimblenewt/registry";
import { BRIDGE_REPLAY, BRIDGE_TOOL_NAMES, DeclarationBoard, PiAdapter, boundTransport, bridgeToolName, composeTools, createBridge, InvalidToolError, type AdapterTool, type BridgeReply, type BridgeRequest, type BridgeTransport } from "./index.js";
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

test("the bridge declares a fixed set of stable tools in the reserved namespace, with wire names, shared by every agent, each presented again after a crash (G04 follow-up: the controller answers it from its records)", () => {
  const bridge = createBridge(fakeController().transport);
  assert.deepEqual(bridge.tools.map((t) => t.name), BRIDGE_TOOL_NAMES.slice());
  assert.deepEqual(BRIDGE_TOOL_NAMES, ["artifact-publish", "deliverable-draft", "deliverable-submit", "dependency-record", "desk-read", "desk-write", "job-cancel", "job-output", "job-start", "job-status", "maintenance-request", "maintenance-status", "message-send", "service-observe", "service-operate", "submission-record", "task-get", "task-recall", "task-transition", "task-update", "tool-discover", "tool-describe", "tool-invoke", "tool-register", "toolbox-copies", "toolbox-copy", "toolbox-notices", "toolbox-optin", "toolbox-pins", "toolbox-proposal", "toolbox-revoke", "toolbox-source", "work-answer", "work-end", "work-note", "work-refresh"].map((n) => `nimblenewt__${n}`));
  assert.equal(bridgeToolName("tool.invoke"), "nimblenewt__tool-invoke");
  for (const tool of bridge.tools) {
    assert.equal(tool.shared, true);
    assert.equal(tool.replay, "safe", "an interrupted bridge call is presented again under its own call ID; what that means is the controller's decision");
    assert.equal(tool.replay, BRIDGE_REPLAY);
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
  const personal = composeTools(bridge, [spy], AGENT).find((t) => t.name === spy.name);
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

test("G04 follow-up: a call a crash interrupted keeps the ID the bridge gave it when Pi presents it again, and a new call with the same provider ID after it is numbered on", async () => {
  const before = fakeController();
  const tool = (b: ReturnType<typeof createBridge>) => b.tools.find((t) => t.name === bridgeToolName("task.get"))!;
  const ctx = (callId: string) => ({ callId }) as never;
  // Before the crash: a provider that counts from zero in every reply used call_0 twice, and the second call was interrupted.
  const first = createBridge(before.transport);
  await tool(first).execute({}, ctx("call_0"));
  await tool(first).execute({}, ctx("call_0"));
  await tool(first).execute({}, ctx("call_0"));
  const [, second, third] = before.seen.map((r) => r.callId);
  // A new process: the stored conversation holds call_0 twice, the second without a result. Pi presents it again, then the model makes a new call_0.
  const after = fakeController();
  const resumed = createBridge(after.transport);
  resumed.seed(["call_0", "call_0"], ["call_0"]);
  await tool(resumed).execute({}, ctx("call_0"));
  await tool(resumed).execute({}, ctx("call_0"));
  assert.deepEqual(after.seen.map((r) => r.callId), [second, third], "the interrupted call reaches the controller under its old ID; the next one gets the next number");
  // A single interrupted call with a fitting ID is presented as it was.
  const plain = fakeController();
  const once = createBridge(plain.transport);
  once.seed(["p1"], ["p1"]);
  await tool(once).execute({}, ctx("p1"));
  await tool(once).execute({}, ctx("p1"));
  assert.equal(plain.seen[0]!.callId, "p1");
  assert.match(plain.seen[1]!.callId, /^d:[0-9a-f]{40}$/);
  // Without open calls the numbering goes on as before (no ID is given out twice).
  const closed = fakeController();
  const none = createBridge(closed.transport);
  none.seed(["p1"]);
  await tool(none).execute({}, ctx("p1"));
  assert.equal(closed.seen[0]!.callId, plain.seen[1]!.callId);
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

// Card W13: task.recall on the worker's side. The tool is declared like the others; an older controller that does not know the operation answers that it is not one of the bridge's, which the model reads as a plain sentence, and a
// transport that fails is an answer too: the worker never crashes on either, and the model's turn goes on.
test("task.recall: sent as the call it is; an older controller's 'not an operation of the bridge' and a failing transport are answered in words, never thrown (card W13)", async () => {
  const tool = (b: ReturnType<typeof createBridge>) => b.tools.find((t) => t.name === bridgeToolName("task.recall"))!;
  const answered: BridgeRequest[] = [];
  const current = createBridge({ send: async (r) => { answered.push(r); return { ok: true, result: { part: "anchor", found: true, text: "x" } }; } });
  const text = await tool(current).execute({ part: "decisions", cursor: "3" }, { callId: "call_1" } as never);
  assert.deepEqual(answered.map((r) => [r.op, r.args]), [["task.recall", { part: "decisions", cursor: "3" }]]);
  assert.match(String(text), /"part":"anchor"/);
  assert.ok(tool(current).description.includes("THIS task only") && tool(current).description.includes("never instructions"));
  const props = Object.keys((tool(current).parameters as unknown as { properties: Record<string, unknown> }).properties).sort();
  assert.deepEqual(props, ["cursor", "id", "maxChars", "part", "recent"], "no argument can name a task, a project or an agent");

  const old = createBridge({ send: async (r) => ({ ok: false, code: "invalid_command", message: `op: ${r.op} is not an operation of the bridge` }) });
  const unknown = String(await tool(old).execute({}, { callId: "call_2" } as never));
  assert.match(unknown, /^refused \(unknown_tool\): task\.recall is not available on this controller/);
  // Any other tool keeps the controller's own refusal text.
  const other = old.tools.find((t) => t.name === bridgeToolName("task.get"))!;
  assert.match(String(await other.execute({}, { callId: "call_3" } as never)), /^refused \(invalid_command\): op: task\.get is not an operation/);

  const broken = createBridge({ send: async () => { throw new Error("socket hang up"); } });
  const lost = String(await tool(broken).execute({}, { callId: "call_4" } as never));
  assert.match(lost, /^refused \(unavailable\): task\.recall could not be delivered/);
  assert.ok(!lost.includes("socket hang up"), "no internal error text reaches the model");
});

// Card L04g: a Pi agent records what its work relied on with the bridge tool dependency-record. The tool names no task (the controller takes the attempt's own); its answer is the controller's; an older
// controller without the operation is answered in words.
test("dependency.record: sent as the call it is, with no way to name a task; an older controller's 'not an operation of the bridge' is answered in words (card L04g)", async () => {
  const tool = (b: ReturnType<typeof createBridge>) => b.tools.find((t) => t.name === bridgeToolName("dependency.record"))!;
  assert.equal(bridgeToolName("dependency.record"), "nimblenewt__dependency-record");
  const answered: BridgeRequest[] = [];
  const current = createBridge({ send: async (r) => { answered.push(r); return { ok: true, result: { recorded: 1, entries: [{ kind: "file", key: "a.md", checkedBy: "controller" }] } }; } });
  const text = await tool(current).execute({ dependencies: [{ kind: "file", key: "a.md" }] }, { callId: "call_1" } as never);
  assert.deepEqual(answered.map((r) => [r.op, r.args]), [["dependency.record", { dependencies: [{ kind: "file", key: "a.md" }] }]]);
  assert.match(String(text), /"checkedBy":"controller"/);
  const props = Object.keys((tool(current).parameters as unknown as { properties: Record<string, unknown> }).properties);
  assert.deepEqual(props, ["dependencies"], "no argument can name a task, a project or an agent");
  assert.match(tool(current).description, /The controller looks and records it/);
  const old = createBridge({ send: async (r) => ({ ok: false, code: "invalid_command", message: `op: ${r.op} is not an operation of the bridge` }) });
  assert.match(String(await tool(old).execute({ dependencies: [] }, { callId: "call_2" } as never)), /^refused \(unknown_tool\): dependency\.record is not available on this controller; nothing was recorded/);
  const refused = createBridge({ send: async () => ({ ok: false, code: "invalid_command", message: "dependencies[0].hash: is not what the file holds now" }) });
  assert.match(String(await tool(refused).execute({ dependencies: [] }, { callId: "call_3" } as never)), /^refused \(invalid_command\): dependencies\[0\]\.hash/);
});

// Card Q01b (bridge): a reviewer, qa, docs or director agent records its submission with submission-record. The tool names no task, role, tree or digest (the controller takes the attempt's task, the kind's role and,
// for a document, the digest it recorded for the artifact); code is not a kind it offers words for; an older controller without the operation is answered in words.
test("submission.record: sent as the call it is, with no way to name a task, a role, a tree or a digest; an older controller's 'not an operation of the bridge' is answered in words (card Q01b)", async () => {
  const tool = (b: ReturnType<typeof createBridge>) => b.tools.find((t) => t.name === bridgeToolName("submission.record"))!;
  assert.equal(bridgeToolName("submission.record"), "nimblenewt__submission-record");
  const answered: BridgeRequest[] = [];
  const current = createBridge({ send: async (r) => { answered.push(r); return { ok: true, result: { id: "sbm-bbbbbbbbbbbbbbbbbbbb", revision: 1, replayed: false } }; } });
  const text = await tool(current).execute({ kind: "review", subject: "sbm-aaaaaaaaaaaaaaaaaaaa", verdict: "approve" }, { callId: "call_1" } as never);
  assert.deepEqual(answered.map((r) => [r.op, r.callId, r.args]), [["submission.record", "call_1", { kind: "review", subject: "sbm-aaaaaaaaaaaaaaaaaaaa", verdict: "approve" }]]);
  assert.match(String(text), /"id":"sbm-bbbbbbbbbbbbbbbbbbbb"/);
  const params = tool(current).parameters as unknown as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
  assert.deepEqual(Object.keys(params.properties), ["kind", "subject", "verdict", "criteriaRevision", "decisions", "unmet", "decision", "report", "artifactId"], "no argument names a task, a role, a base, a tree, a patch ID or a digest");
  assert.deepEqual([params.required, params.additionalProperties], [["kind"], false]);
  assert.match(tool(current).description, /kind review \(verdict\), qa \(report\) or signoff \(decision\) on submission subject \(sbm-\.\.\.\), or document \(artifactId, report\)\. Code: work-end submit\./);
  const old = createBridge({ send: async (r) => ({ ok: false, code: "invalid_command", message: `op: ${r.op} is not an operation of the bridge` }) });
  assert.match(String(await tool(old).execute({ kind: "qa", subject: "sbm-aaaaaaaaaaaaaaaaaaaa", report: "r" }, { callId: "call_2" } as never)), /^refused \(unknown_tool\): submission\.record is not available on this controller; nothing was recorded, give your verdict or report in your work-end report$/);
  const refused = createBridge({ send: async () => ({ ok: false, code: "forbidden", message: "a review of your own submission is refused" }) });
  assert.equal(String(await tool(refused).execute({ kind: "review", subject: "sbm-aaaaaaaaaaaaaaaaaaaa", verdict: "approve" }, { callId: "call_3" } as never)), "refused (forbidden): a review of your own submission is refused");
});

test("the toolbox tools (card T08) are always there, name no task, project or agent, and say in words when an older controller does not have them", async () => {
  const sent: { op: string; args: Record<string, unknown> | undefined }[] = [];
  const current = createBridge({ send: async (r) => { sent.push({ op: r.op, args: r.args }); return { ok: true, result: { items: [] } }; } });
  const names = ["toolbox.copies", "toolbox.copy", "toolbox.notices", "toolbox.optin", "toolbox.pins", "toolbox.proposal", "toolbox.revoke", "toolbox.source"];
  for (const op of names) {
    const tool = current.tools.find((t) => t.name === bridgeToolName(op));
    assert.ok(tool !== undefined, op);
    const props = Object.keys((tool.parameters as unknown as { properties: Record<string, unknown> }).properties);
    for (const p of props) assert.ok(!["taskId", "projectId", "agentId", "principal", "actor"].includes(p), `${op} takes no ${p}`);
  }
  const copies = current.tools.find((t) => t.name === bridgeToolName("toolbox.copies"))!;
  assert.equal(await copies.execute({}, { callId: "c1" } as never), JSON.stringify({ items: [] }));
  assert.deepEqual(sent.map((r) => r.op), ["toolbox.copies"]);
  const old = createBridge({ send: async (r) => ({ ok: false, code: "invalid_command", message: `op: ${r.op} is not an operation of the bridge` }) });
  const source = old.tools.find((t) => t.name === bridgeToolName("toolbox.source"))!;
  assert.match(String(await source.execute({ name: "lint" }, { callId: "c2" } as never)), /^refused \(unknown_tool\): toolbox\.source is not available on this controller/);
  // Opting in (card T08) names only the tool and the version: the agent moves itself, never another agent or everyone.
  const optin = current.tools.find((t) => t.name === bridgeToolName("toolbox.optin"))!;
  assert.deepEqual(Object.keys((optin.parameters as unknown as { properties: Record<string, unknown> }).properties).sort(), ["name", "version"]);
  // Card T08, slice 4: the proposal operations are one tool with an action (every declaration is part of every prompt), propose among them; the separate propose declaration is gone (the controller still accepts it).
  // A maintainer's revocation says what happens to calls running now: finish or cancel, never a pause (the owner's).
  assert.equal(current.tools.find((t) => t.name === bridgeToolName("toolbox.propose")), undefined);
  const proposal = current.tools.find((t) => t.name === bridgeToolName("toolbox.proposal"))!;
  assert.deepEqual((proposal.parameters as unknown as { required: string[] }).required, ["action"]);
  assert.match(proposal.description, /propose .* promote .* revise, rebase, withdraw, list, get\. Maintainers: decide/);
  assert.equal(await proposal.execute({ action: "list" }, { callId: "c3" } as never), JSON.stringify({ items: [] }));
  const revoke = current.tools.find((t) => t.name === bridgeToolName("toolbox.revoke"))!;
  assert.deepEqual([...(revoke.parameters as unknown as { required: string[] }).required].sort(), ["name", "reason", "runningCalls", "version"]);
  assert.deepEqual(sent.slice(-1).map((r) => [r.op, r.args?.["action"]]), [["toolbox.proposal", "list"]]);
  for (const p of ["everyone", "agentId"]) assert.ok(!Object.keys((optin.parameters as unknown as { properties: Record<string, unknown> }).properties).includes(p), `toolbox.optin takes no ${p}`);
  const oldOptin = old.tools.find((t) => t.name === bridgeToolName("toolbox.optin"))!;
  assert.match(String(await oldOptin.execute({ name: "lint" }, { callId: "c3" } as never)), /^refused \(unknown_tool\): toolbox\.optin is not available on this controller/);
});

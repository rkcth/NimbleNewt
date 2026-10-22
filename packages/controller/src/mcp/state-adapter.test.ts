import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { StateApi } from "../api/index.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import { InquiryService } from "../inquiries/index.js";
import { ContractService, WaitGraphService } from "../planning/index.js";
import { PrincipalService, TaskCredentialService, type Grant } from "../security/index.js";
import { McpStateAdapter, MCP_SUPPORT, type RpcResponse } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T19:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
type Ok = Extract<RpcResponse, { result: unknown }>;
type Err = Extract<RpcResponse, { error: unknown }>;

for (const backend of backends) {
  test(`${backend.name}: the state API through MCP: same door, same rules, safe to repeat`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
      const waits = WaitService.withEpoch(world.storage, projects.epoch, assignments, options);
      const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
      const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
      const retrieval = RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options);
      const inquiries = InquiryService.withEpoch(world.storage, projects.epoch, { histories, retrieval, waits, assignments }, options);
      const agents = AgentService.withEpoch(world.storage, projects.epoch, options);
      const contracts = ContractService.withEpoch(world.storage, projects.epoch, options);
      const graph = WaitGraphService.withEpoch(world.storage, projects.epoch, contracts, BlockerService.withEpoch(world.storage, projects.epoch, options), options);
      const taskCredentials = TaskCredentialService.withEpoch(world.storage, projects.epoch, options);
      const internal: unknown[] = [];
      const api = new StateApi({ principals, taskCredentials, projects, assignments, retrieval, inquiries, agents, contracts, graph, onInternalError: (e: unknown) => { internal.push(e); } });
      const mcp = new McpStateAdapter(api);
      const ownerToken = (await principals.bootstrapOwner({ name: "rob" })).token;
      const owner = await principals.authenticate(ownerToken);
      const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
      const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
      const grants: Grant[] = [{ action: "project.read", project: a }, { action: "task.read", project: a }];
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants });
      const ann = (await principals.issueCredential(owner, "agent:ann")).token;
      const rpc = (token: string, method: string, params?: unknown, id: number | string = 1) => mcp.handle(token, { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

      // Protocol: only revisions this release has been checked against.
      const init = await rpc(ann, "initialize", { protocolVersion: MCP_SUPPORT.revisions[0] }) as Ok;
      assert.equal((init.result as { protocolVersion: string }).protocolVersion, MCP_SUPPORT.revisions[0]);
      const bad = await rpc(ann, "initialize", { protocolVersion: "1999-01-01" }) as Err;
      assert.deepEqual((bad.error.data as { supported: string[] }).supported, [...MCP_SUPPORT.revisions]);
      assert.equal(((await rpc(ann, "initialize", {})) as Err).error.code, -32602);

      // Envelope: notifications get no reply; batches and junk are refused; unknown methods and tools.
      assert.equal(await mcp.handle(ann, { jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
      assert.equal(((await mcp.handle(ann, [{ jsonrpc: "2.0", id: 1, method: "ping" }])) as Err).error.code, -32600);
      assert.equal(((await mcp.handle(ann, "x")) as Err).error.code, -32600);
      assert.equal(((await mcp.handle(ann, { jsonrpc: "1.0", id: 1, method: "ping" })) as Err).error.code, -32600);
      assert.equal(((await rpc(ann, "nope")) as Err).error.code, -32601);
      assert.equal(((await rpc(ann, "tools/call", { name: "project_erase", arguments: {} })) as Err).error.code, -32602);
      assert.deepEqual((await rpc(ann, "ping")) as Ok, { jsonrpc: "2.0", id: 1, result: {} });

      // Tools come from the operation table; commands require a commandId in their schema.
      const tools = ((await rpc(ann, "tools/list")) as Ok).result as { tools: { name: string; inputSchema: { required: string[]; properties: Record<string, unknown> } }[] };
      const create = tools.tools.find((t) => t.name === "task_create")!;
      assert.ok(create.inputSchema.required.includes("commandId") && create.inputSchema.required.includes("projectId"));
      assert.ok(!tools.tools.find((t) => t.name === "task_get")!.inputSchema.required.includes("commandId"));

      // Same rules as the native door: ann may read A and not B, and may not create.
      const call = async (token: string, name: string, args: unknown) => ((await rpc(token, "tools/call", { name, arguments: args })) as Ok).result as { isError: boolean; content: { text: string }[]; structuredContent?: unknown };
      const ta = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "in A" })).id;
      const tb = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: b, title: "in B" })).id;
      assert.equal((await call(ann, "task_get", { taskId: ta })).isError, false);
      const denied = await call(ann, "task_get", { taskId: tb });
      assert.equal(denied.isError, true);
      assert.equal(JSON.parse(denied.content[0]!.text).code, "forbidden");
      assert.equal((await call(ann, "task_create", { commandId: cid("c"), projectId: a, title: "x" })).isError, true, "no create right");
      assert.equal(((await rpc("nnt-bogus", "tools/call", { name: "task_get", arguments: { taskId: ta } })) as Ok).result !== undefined, true);
      assert.equal((await call("nnt-bogus", "task_get", { taskId: ta })).isError, true);

      // A command needs a commandId; a query takes none; repeating a command answers from the record.
      assert.equal(((await rpc(ownerToken, "tools/call", { name: "task_create", arguments: { projectId: a, title: "t" } })) as Err).error.code, -32602);
      assert.equal(((await rpc(ownerToken, "tools/call", { name: "task_get", arguments: { taskId: ta, commandId: "c1" } })) as Err).error.code, -32602);
      assert.equal(((await rpc(ownerToken, "tools/call", { name: "task_get", arguments: [] })) as Err).error.code, -32602);
      const key = cid("keep");
      const first = await call(ownerToken, "task_create", { commandId: key, projectId: a, title: "made once" });
      const again = await call(ownerToken, "task_create", { commandId: key, projectId: a, title: "made once" });
      assert.equal(first.isError, false);
      assert.equal((again.structuredContent as { id: string; replayed: boolean }).id, (first.structuredContent as { id: string }).id);
      assert.equal((again.structuredContent as { replayed: boolean }).replayed, true);
      assert.equal((await call(ownerToken, "task_create", { commandId: key, projectId: a, title: "different" })).isError, true, "same key, different command");

      // Resources: projects and tasks, readable only where the credential allows; not-there and not-allowed look the same.
      const listed = ((await rpc(ann, "resources/list")) as Ok).result as { resources: { uri: string }[] };
      assert.deepEqual(listed.resources.map((r) => r.uri), [`nimblenewt://project/${a}`]);
      const read = ((await rpc(ann, "resources/read", { uri: `nimblenewt://task/${ta}` })) as Ok).result as { contents: { text: string }[] };
      assert.equal(JSON.parse(read.contents[0]!.text).id, ta);
      const hidden = (await rpc(ann, "resources/read", { uri: `nimblenewt://task/${tb}` })) as Err;
      const missing = (await rpc(ann, "resources/read", { uri: "nimblenewt://task/tsk-aaaaaaaaaaaaaaaaaaaa" })) as Err;
      assert.deepEqual([hidden.error.code, hidden.error.message], [missing.error.code, missing.error.message]);
      for (const uri of ["file:///etc/passwd", "nimblenewt://project/../x", 5, undefined]) assert.equal(((await rpc(ann, "resources/read", { uri })) as Err).error.code, -32002);
      assert.deepEqual(((await rpc(ann, "resources/templates/list")) as Ok).result !== undefined, true);
      assert.deepEqual(internal, []);
    } finally { await world.close(); }
  });
}

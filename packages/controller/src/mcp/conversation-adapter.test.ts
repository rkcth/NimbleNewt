import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ConversationService } from "../conversations/index.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant } from "../security/index.js";
import { McpConversationAdapter, MCP_SUPPORT, type RpcResponse } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T20:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
type Ok = Extract<RpcResponse, { result: unknown }>;
type Err = Extract<RpcResponse, { error: unknown }>;
interface ToolResult { isError: boolean; content: { text: string }[]; structuredContent?: Record<string, any> }

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) => test(`${backend.name}: ${name}`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
      const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
      const grants = (p: string): Grant[] => ["conversation.start", "conversation.send", "conversation.receive"].map((action) => ({ action, project: p }));
      const enroll = async (kind: "agent" | "client" | "host" | "service", nm: string, g: Grant[]): Promise<string> => {
        await principals.enroll(owner, { commandId: cid("e"), kind, name: nm, grants: g });
        return (await principals.issueCredential(owner, `${kind}:${nm}`)).token;
      };
      const ann = await enroll("agent", "ann", grants(a));
      const bob = await enroll("agent", "bob", grants(a));
      const ext = await enroll("client", "ext", grants(a));
      const eve = await enroll("agent", "eve", []);
      const host = await enroll("host", "w1", grants(a));
      const service = await enroll("service", "s1", []);
      const zed = await enroll("agent", "zed", grants(b));
      const make = () => new McpConversationAdapter(ConversationService.withEpoch(world.storage, projects.epoch, options), principals);
      const mcp = make();
      const rpc = (token: unknown, method: string, params?: unknown, id: number | string = 1, via: McpConversationAdapter = mcp) => via.handle(token, { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      const call = async (token: unknown, name: string, args: unknown, via: McpConversationAdapter = mcp): Promise<ToolResult> => ((await rpc(token, "tools/call", { name, arguments: args }, 1, via)) as Ok).result as ToolResult;
      await body({ world, mcp, make, rpc, call, a, b, ann, bob, ext, eve, zed, host, service, principals, owner });
    } finally { await world.close(); }
  });
  interface Ctx {
    world: { storage: import("../storage/types.js").ControllerStorage };
    mcp: McpConversationAdapter; make(): McpConversationAdapter;
    rpc(token: unknown, method: string, params?: unknown, id?: number | string, via?: McpConversationAdapter): Promise<RpcResponse | undefined>;
    call(token: unknown, name: string, args: unknown, via?: McpConversationAdapter): Promise<ToolResult>;
    a: string; b: string; ann: string; bob: string; ext: string; eve: string; zed: string; host: string; service: string;
    principals: PrincipalService; owner: import("../security/index.js").Principal;
  }
  const code = (r: ToolResult): string => JSON.parse(r.content[0]!.text).code;

  suite("both sides start threads through MCP, reconnect from their cursor, and every turn is seen once", async (c) => {
    // An agent starts; an outside client answers.
    const s1 = await c.call(c.ann, "conversation_start", { commandId: cid("s"), projectId: c.a, subject: "build", to: ["client:ext"], kind: "question", text: "is the build green?" });
    assert.equal(s1.isError, false, s1.content[0]!.text);
    const t1 = s1.structuredContent!["threadId"] as string;
    const unread = await c.call(c.ext, "conversation_unread", {});
    assert.deepEqual(unread.structuredContent!["threads"], [{ threadId: t1, count: 1 }]);
    const r1 = (await c.call(c.ext, "conversation_read", { threadId: t1 })).structuredContent!;
    assert.deepEqual([r1["items"].length, r1["items"][0].seq, r1["items"][0].sender, r1["items"][0].trust, r1["cursor"]], [1, 1, "agent:ann", "untrusted-content", 1]);
    // The client drops and a new adapter instance (a new process, a new connection) picks up from the cursor it kept: nothing repeated, nothing missed.
    const reply = { commandId: cid("r"), threadId: t1, text: "green", kind: "answer", replyTo: s1.structuredContent!["messageId"], claimedSender: "ci" };
    const sent = await c.call(c.ext, "conversation_send", reply);
    const again = await c.call(c.ext, "conversation_send", reply);
    assert.deepEqual([sent.structuredContent!["replayed"], again.structuredContent!["replayed"], again.structuredContent!["messageId"]], [false, true, sent.structuredContent!["messageId"]]);
    assert.equal(code(await c.call(c.ext, "conversation_send", { ...reply, text: "red" })), "command_conflict");
    const later = c.make();
    assert.deepEqual((await c.call(c.ext, "conversation_acknowledge", { commandId: cid("k"), threadId: t1, upToSeq: 1 }, later)).structuredContent, { deliveredSeq: 1, more: false });
    const got = (await c.call(c.ann, "conversation_read", { threadId: t1, after: 1 }, later)).structuredContent!;
    assert.deepEqual([got["items"].map((m: any) => [m.seq, m.sender, m.claimedSender]), got["cursor"]], [[[2, "client:ext", "ci"]], 2]);
    assert.equal((await c.call(c.ann, "conversation_read", { threadId: t1, after: 2 }, later)).structuredContent!["items"].length, 0);
    assert.equal((await c.call(c.ann, "conversation_read", { threadId: t1, after: 2 }, later)).structuredContent!["cursor"], 2);
    // The client starts the other direction.
    const s2 = await c.call(c.ext, "conversation_start", { commandId: "fixed", projectId: c.a, subject: "from outside", to: ["agent:bob"], text: "deploy needs a look" });
    const s2b = await c.call(c.ext, "conversation_start", { commandId: "fixed", projectId: c.a, subject: "from outside", to: ["agent:bob"], text: "deploy needs a look" }, later);
    assert.deepEqual([s2b.structuredContent!["threadId"], s2b.structuredContent!["replayed"]], [s2.structuredContent!["threadId"], true]);
    const t2 = s2.structuredContent!["threadId"] as string;
    const first = (await c.call(c.bob, "conversation_read", { threadId: t2 })).structuredContent!;
    assert.equal(first["items"].length, 1);
    await c.call(c.bob, "conversation_acknowledge", { commandId: cid("k"), threadId: t2, upToSeq: 1 });
    assert.equal(code(await c.call(c.bob, "conversation_handled", { commandId: cid("h"), messageId: "nope" })), "invalid_command");
    assert.equal((await c.call(c.bob, "conversation_handled", { commandId: cid("h"), messageId: `${t2}.00000001` })).isError, false);
    await c.call(c.bob, "conversation_send", { commandId: cid("r"), threadId: t2, text: "looking" });
    const seen = (await c.call(c.ext, "conversation_read", { threadId: t2 })).structuredContent!;
    assert.deepEqual(seen["items"].map((m: any) => m.seq), [1, 2], "the client sees its own message and the reply, once each");
    const threads = (await c.call(c.ext, "conversation_threads", {})).structuredContent!;
    assert.deepEqual(threads["items"].map((t: any) => t.id).sort(), [t1, t2].sort());
    assert.equal((await c.call(c.ext, "conversation_thread", { threadId: t2 })).isError, false);
    const view = (await c.call(c.ann, "conversation_thread", { threadId: t1 })).structuredContent!;
    assert.equal((await c.call(c.ann, "conversation_close", { commandId: cid("x"), threadId: t1, expectedRevision: view["revision"] })).isError, false);
    assert.equal(code(await c.call(c.ann, "conversation_send", { commandId: cid("r"), threadId: t1, text: "late" })), "invalid_command");
  });

  suite("no leakage across projects or to outsiders; unreadable looks like missing; credentials are checked each call", async (c) => {
    const s = await c.call(c.ann, "conversation_start", { commandId: cid("s"), projectId: c.a, subject: "private", to: ["agent:bob"], text: "only for bob" });
    const t = s.structuredContent!["threadId"] as string;
    const missing = await c.call(c.zed, "conversation_read", { threadId: "thr-aaaaaaaaaaaaaaaaaaaa" });
    for (const who of [c.zed, c.eve]) {
      const hidden = await c.call(who, "conversation_read", { threadId: t });
      assert.deepEqual([hidden.isError, code(hidden)], [true, "not_found"]);
      assert.deepEqual(hidden.content, missing.content);
      assert.deepEqual((await c.call(who, "conversation_thread", { threadId: t })).content, (await c.call(who, "conversation_thread", { threadId: "thr-aaaaaaaaaaaaaaaaaaaa" })).content);
      assert.deepEqual((await c.call(who, "conversation_threads", {})).structuredContent!["items"], []);
      const gone = "thr-aaaaaaaaaaaaaaaaaaaa";
      const intrude = await c.call(who, "conversation_send", { commandId: cid("r"), threadId: t, text: "intrude" });
      assert.deepEqual([intrude.isError, intrude.content], [true, (await c.call(who, "conversation_send", { commandId: cid("r"), threadId: gone, text: "intrude" })).content]);
      const ack = await c.call(who, "conversation_acknowledge", { commandId: cid("k"), threadId: t, upToSeq: 1 });
      assert.deepEqual([ack.isError, ack.content], [true, (await c.call(who, "conversation_acknowledge", { commandId: cid("k"), threadId: gone, upToSeq: 1 })).content]);
    }
    // Starting in a project without the grant, or addressing someone unreachable, is refused.
    assert.equal((await c.call(c.zed, "conversation_start", { commandId: cid("s"), projectId: c.a, subject: "x", to: ["agent:ann"], text: "x" })).isError, true);
    assert.equal((await c.call(c.ann, "conversation_start", { commandId: cid("s"), projectId: c.a, subject: "x", to: ["agent:zed"], text: "x" })).isError, true);
    // An outside client gains no other capability by joining: it cannot send notices and the state tools do not exist here.
    assert.equal((await c.call(c.ext, "conversation_start", { commandId: cid("s"), projectId: c.a, subject: "n", to: ["agent:ann"], kind: "notice", text: "x" })).isError, true);
    assert.equal(((await c.rpc(c.ext, "tools/call", { name: "task_get", arguments: {} })) as Err).error.code, -32602);
    // A message cannot claim to be from someone else: unknown arguments (sender, actor) are refused.
    assert.equal(code(await c.call(c.ann, "conversation_send", { commandId: cid("r"), threadId: t, text: "x", sender: "owner:rob" })), "invalid_command");
    assert.equal(code(await c.call(c.ann, "conversation_send", { commandId: cid("r"), threadId: t, text: "x", actor: "owner:rob" })), "invalid_command");
    assert.equal(code(await c.call(c.ann, "conversation_read", { threadId: t, sender: "x" })), "invalid_command");
    // Errors never echo something credential-shaped.
    const echoed = await c.call(c.ann, "conversation_read", { threadId: t, "sk-abcdefghijklmnopqrstuvwxyz0123456789": 1 });
    assert.equal(code(echoed), "invalid_command");
    assert.ok(!echoed.content[0]!.text.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
    // Text that looks like a credential is replaced on the way in.
    const secret = await c.call(c.ann, "conversation_send", { commandId: cid("r"), threadId: t, text: "key sk-abcdefghijklmnopqrstuvwxyz0123456789 here" });
    assert.equal(secret.isError, false);
    const seen = (await c.call(c.bob, "conversation_read", { threadId: t, after: 1 })).structuredContent!;
    assert.equal(seen["items"][0].redacted, true);
    assert.ok(!JSON.stringify(seen).includes("abcdefghijklmnopqrstuvwxyz0123456789"));
    // Workers and the controller's own services are not accepted, even with grants.
    for (const who of [c.host, c.service]) {
      assert.equal(code(await c.call(who, "conversation_unread", {})), "unauthenticated");
      assert.equal(code(await c.call(who, "conversation_start", { commandId: cid("s"), projectId: c.a, subject: "x", to: ["agent:ann"], text: "x" })), "unauthenticated");
    }
    // Credentials: bad ones and revoked ones fail on the very next call; workers are not accepted.
    for (const bad of ["nnt-bogus", "", 5, undefined, null]) assert.equal(code(await c.call(bad, "conversation_unread", {})), "unauthenticated");
    assert.equal((await c.call(c.bob, "conversation_unread", {})).isError, false);
    // Taking a participant's grants away stops it on its next call.
    const found = await c.world.storage.getAggregate({ kind: "principal", id: "agent:bob" });
    await c.principals.setGrants(c.owner, { commandId: cid("rv"), principalId: "agent:bob", expectedRevision: found!.revision, grants: [] });
    assert.equal((await c.call(c.bob, "conversation_read", { threadId: t })).isError, true);
    assert.equal((await c.call(c.bob, "conversation_send", { commandId: cid("r"), threadId: t, text: "still here?" })).isError, true);
  });

  suite("a protocol session is not an owner: an upgrade keeps threads, cursors and the audit trail, and nothing hangs on the handshake", async (c) => {
    const [oldRev, newRev] = [MCP_SUPPORT.revisions[1]!, MCP_SUPPORT.revisions[0]!];
    const init = (await c.rpc(c.ann, "initialize", { protocolVersion: oldRev }, 1)) as Ok;
    assert.equal((init.result as { protocolVersion: string }).protocolVersion, oldRev);
    assert.ok(!JSON.stringify(init.result).toLowerCase().includes("session"), "no session identity is issued");
    const s = await c.call(c.ann, "conversation_start", { commandId: cid("s"), projectId: c.a, subject: "upgrade", to: ["agent:bob"], text: "one" });
    const t = s.structuredContent!["threadId"] as string;
    await c.call(c.ann, "conversation_send", { commandId: cid("r"), threadId: t, text: "two" });
    await c.call(c.bob, "conversation_acknowledge", { commandId: cid("k"), threadId: t, upToSeq: 1 });
    const auditBefore = await c.world.storage.listAudit({ afterSeq: 0, limit: 1000 });
    const before = (await c.call(c.bob, "conversation_read", { threadId: t, after: 0 })).structuredContent!;
    const listBefore = (await c.call(c.bob, "conversation_threads", {})).structuredContent!;
    // The client reconnects with a new instance, a different handshake and the newer revision. No session id or handshake is needed to act, and none is an owner of anything.
    const upgraded = c.make();
    assert.equal(((await c.rpc(c.bob, "initialize", { protocolVersion: newRev }, 2, upgraded)) as Ok).result !== undefined, true);
    assert.equal(((await c.rpc(c.bob, "initialize", { protocolVersion: "1999-01-01" }, 3, upgraded)) as Err).error.code, -32602);
    assert.deepEqual(((await c.rpc(c.bob, "initialize", {}, 4, upgraded)) as Err).error.data, { supported: [...MCP_SUPPORT.revisions] });
    const after = (await c.call(c.bob, "conversation_read", { threadId: t, after: 0 }, upgraded)).structuredContent!;
    assert.deepEqual(after, before);
    assert.deepEqual((await c.call(c.bob, "conversation_threads", {}, upgraded)).structuredContent, listBefore);
    // The cursor is where it was; a repeat of an old command across the upgrade is still one message.
    assert.deepEqual((await c.call(c.bob, "conversation_read", { threadId: t }, upgraded)).structuredContent!["items"].map((m: any) => m.seq), [2]);
    const dup = await c.call(c.ann, "conversation_send", { commandId: "kept-across-upgrade", threadId: t, text: "three" });
    const dupAfter = await c.call(c.ann, "conversation_send", { commandId: "kept-across-upgrade", threadId: t, text: "three" }, upgraded);
    assert.deepEqual([dupAfter.structuredContent!["replayed"], dupAfter.structuredContent!["messageId"]], [true, dup.structuredContent!["messageId"]]);
    // The audit trail written before is untouched and the sender is still the authenticated principal.
    const auditAfter = await c.world.storage.listAudit({ afterSeq: 0, limit: 1000 });
    assert.deepEqual(auditAfter.slice(0, auditBefore.length), auditBefore);
    assert.ok(auditAfter.length > auditBefore.length);
    assert.deepEqual(after["items"].map((m: any) => [m.seq, m.sender]), [[1, "agent:ann"], [2, "agent:ann"]]);
    // The handshake owns nothing: another connection of the same principal sees the same, and an unauthenticated one sees none of it; tools may be called without initializing.
    assert.equal(code(await c.call("nnt-bogus", "conversation_read", { threadId: t }, upgraded)), "unauthenticated");
    // No task is created or owned by talking: the tools do not touch tasks, and a thread has no task field.
    const view = (await c.call(c.ann, "conversation_thread", { threadId: t })).structuredContent!;
    assert.ok(!("taskId" in view) && !("session" in view) && !("sessionId" in view));
    // The cursor falls back to the reader's confirmed position: bob confirmed 1 and messages 2 and 3 wait, then none.
    assert.equal((await c.call(c.bob, "conversation_read", { threadId: t })).structuredContent!["cursor"], 3);
    await c.call(c.bob, "conversation_acknowledge", { commandId: cid("k"), threadId: t, upToSeq: 2 });
    assert.equal((await c.call(c.bob, "conversation_read", { threadId: t })).structuredContent!["cursor"], 3);
    await c.call(c.bob, "conversation_acknowledge", { commandId: cid("k"), threadId: t, upToSeq: 3 });
    const none = (await c.call(c.bob, "conversation_read", { threadId: t })).structuredContent!;
    assert.deepEqual([none["items"].length, none["cursor"]], [0, 3]);
    // Queries take no extra arguments.
    for (const [tool, args] of [["conversation_thread", { threadId: t, x: 1 }], ["conversation_threads", { x: 1 }], ["conversation_unread", { x: 1 }]] as const) assert.equal(code(await c.call(c.ann, tool, args)), "invalid_command", tool);
    // A fault of ours is described without detail.
    const faulty = new McpConversationAdapter({ unread: async () => { throw new DomainError("integrity", "record thr-internal-id is damaged"); } } as never, c.principals);
    const fault = await c.call(c.ann, "conversation_unread", {}, faulty);
    assert.deepEqual([code(fault), JSON.parse(fault.content[0]!.text).message], ["integrity", "the request could not be completed"]);
    // Envelope: notifications, batches, junk, unknown tools and methods.
    assert.equal(await c.mcp.handle(c.ann, { jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
    assert.equal(((await c.mcp.handle(c.ann, [{ jsonrpc: "2.0", id: 1, method: "ping" }])) as Err).error.code, -32600);
    assert.equal(((await c.mcp.handle(c.ann, "x")) as Err).error.code, -32600);
    assert.equal(((await c.rpc(c.ann, "nope")) as Err).error.code, -32601);
    assert.equal(((await c.rpc(c.ann, "tools/call", { name: "constructor", arguments: {} })) as Err).error.code, -32602);
    assert.equal(((await c.rpc(c.ann, "tools/call", { name: "conversation_send", arguments: { threadId: t, text: "x" } })) as Err).error.code, -32602, "a command needs a commandId");
    assert.equal(((await c.rpc(c.ann, "tools/call", { name: "conversation_unread", arguments: { commandId: "k" } })) as Err).error.code, -32602);
    assert.equal(((await c.rpc(c.ann, "tools/call", { name: "conversation_unread", arguments: [] })) as Err).error.code, -32602);
    const tools = ((await c.rpc(undefined, "tools/list")) as Ok).result as { tools: { name: string; inputSchema: { required: string[] } }[] };
    assert.ok(tools.tools.find((x) => x.name === "conversation_send")!.inputSchema.required.includes("commandId"));
    assert.ok(!tools.tools.find((x) => x.name === "conversation_read")!.inputSchema.required.includes("commandId"));
  });
}

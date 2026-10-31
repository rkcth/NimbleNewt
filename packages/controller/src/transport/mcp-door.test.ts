import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { after, test } from "node:test";
import { ConversationService } from "../conversations/index.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant } from "../security/index.js";
import { MCP_SUPPORT } from "../mcp/index.js";
import { ConversationTransport, type TransportOptions } from "./index.js";

const MCP_REVISION = (): string => MCP_SUPPORT.revisions[0]!;

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: any }
const post = (base: string, path: string, init: { token?: string; body?: unknown; raw?: string; method?: string; type?: string }): Promise<Reply> => new Promise((resolve, reject) => {
  const url = new URL(path, base);
  const data = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  const headers: Record<string, string> = { ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }), ...(data === undefined ? {} : { "content-type": init.type ?? "application/json", "content-length": String(Buffer.byteLength(data)) }) };
  const req = httpRequest(url, { method: init.method ?? "POST", headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (d: Buffer) => chunks.push(d));
    res.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); let body: unknown; try { body = raw === "" ? undefined : JSON.parse(raw); } catch { body = undefined; } resolve({ status: res.statusCode!, headers: res.headers, body }); });
  });
  req.on("error", reject);
  if (data !== undefined) req.write(data);
  req.end();
});

const post2 = (base: string, path: string, init: { token?: string; scheme?: string; headers?: Record<string, string>; method?: string; body?: unknown }): Promise<Reply> => new Promise((resolve, reject) => {
  const data = init.body === undefined ? undefined : JSON.stringify(init.body);
  const headers: Record<string, string> = { ...(init.token === undefined ? {} : { authorization: `${init.scheme ?? "Bearer"} ${init.token}` }), ...(data === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) }), ...(init.headers ?? {}) };
  const req = httpRequest(new URL(path, base), { method: init.method ?? "POST", headers, agent: false }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (d: Buffer) => chunks.push(d));
    res.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); let body: unknown; try { body = raw === "" ? undefined : JSON.parse(raw); } catch { body = undefined; } resolve({ status: res.statusCode!, headers: res.headers, body }); });
  });
  req.on("error", reject);
  if (data !== undefined) req.write(data);
  req.end();
});

for (const backend of backends) {
  test(`${backend.name}: limits count failed sign-ins per address, MCP has its own per-principal allowance, the switch refuses the next request, Origin and scheme case are checked`, async () => {
    const world = await backend.open();
    const running: ConversationTransport[] = [];
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "P" })).id;
      const g: Grant[] = ["conversation.start", "conversation.send", "conversation.receive"].map((action) => ({ action, project }));
      const login = async (name: string) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name, grants: g }); return (await principals.issueCredential(owner, `agent:${name}`)).token; };
      const ann = await login("ann"); const bob = await login("bob");
      const conversations = ConversationService.withEpoch(world.storage, projects.epoch, options);
      const listen = async (extra: Partial<TransportOptions>) => { const t = await ConversationTransport.listen({ conversations, principals, ...extra }); running.push(t); return t; };
      const ping = (url: string, token: string | undefined, extra: { scheme?: string; headers?: Record<string, string> } = {}) => post2(url, "/mcp", { ...(token === undefined ? {} : { token }), ...extra, body: { jsonrpc: "2.0", id: 1, method: "ping" } });

      // Authenticated traffic from one address does not use up the address allowance: with an allowance of 3, ten requests from ann leave bob (same address) untouched, on both doors.
      const a = await listen({ limits: { perAddressPerMinute: 3 } });
      for (let i = 0; i < 10; i++) assert.equal((await ping(a.url, ann)).status, 200);
      assert.equal((await post2(a.url, "/v1/unread", { token: ann, method: "GET" })).status, 200);
      assert.equal((await ping(a.url, bob)).status, 200);
      // Failed sign-ins from the address do count: the fourth is refused with 429, and afterwards even before the credential is looked at.
      const bad = "x".repeat(40);
      assert.deepEqual([(await ping(a.url, bad)).status, (await ping(a.url, bad)).status, (await ping(a.url, bad)).status], [401, 401, 401]);
      const limited = await ping(a.url, bad);
      assert.equal(limited.status, 429);
      assert.equal((await ping(a.url, bob)).status, 429);

      // MCP messages have their own allowance per principal, apart from REST and from other principals.
      const m = await listen({ limits: { mcpPerPrincipalPerMinute: 3 } });
      for (let i = 0; i < 3; i++) assert.equal((await ping(m.url, ann)).status, 200);
      assert.equal((await ping(m.url, ann)).status, 429);
      assert.equal((await ping(m.url, bob)).status, 200);
      assert.equal((await post2(m.url, "/v1/unread", { token: ann, method: "GET" })).status, 200);

      // The switch is read on every request: off answers 404 on the next one, on again answers; an unreadable switch answers 503.
      let state: "on" | "off" | "broken" = "on";
      const s = await listen({ mcpEnabled: async () => { if (state === "broken") throw new Error("down"); return state === "on"; } });
      assert.equal((await ping(s.url, ann)).status, 200);
      state = "off";
      assert.equal((await ping(s.url, ann)).status, 404);
      assert.equal((await post2(s.url, "/v1/unread", { token: ann, method: "GET" })).status, 200, "the REST door is not switched");
      state = "broken";
      assert.equal((await ping(s.url, ann)).status, 503);
      state = "on";
      assert.equal((await ping(s.url, ann)).status, 200);

      // Origin: absent is fine (not a browser), the listener's own is fine, any other is refused. The scheme word may be in any case.
      const t = await listen({});
      assert.equal((await ping(t.url, ann, { headers: { origin: t.url } })).status, 200);
      assert.equal((await ping(t.url, ann, { headers: { origin: "http://evil.example" } })).status, 403);
      assert.equal((await ping(t.url, ann, { headers: { origin: "null" } })).status, 403);
      assert.equal((await ping(t.url, ann, { scheme: "bearer" })).status, 200);

      // A body with no length is cut off at the bound as it streams (chunked): the sender is told 413 or loses the connection, and nothing is read.
      const outcome = await new Promise<string>((resolve) => {
        const req = httpRequest(new URL("/mcp", t.url), { method: "POST", headers: { authorization: `Bearer ${ann}`, "content-type": "application/json", "transfer-encoding": "chunked" }, agent: false }, (res) => { res.resume(); res.on("end", () => resolve(String(res.statusCode))); });
        req.on("error", () => resolve("closed"));
        req.write('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"');
        for (let i = 0; i < 40; i++) req.write("x".repeat(4096));
        req.end('"}}');
      });
      assert.ok(outcome === "413" || outcome === "closed", outcome);
      assert.equal((await ping(t.url, ann)).status, 200);
    } finally { for (const t of running) await t.close(); await world.close(); }
  });


  test(`${backend.name}: the MCP door over the conversation transport: both sides talk, a reconnect keeps the cursor, nothing is session-owned`, async () => {
    const world = await backend.open();
    let transport: ConversationTransport | undefined;
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "P" })).id;
      const other = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "Q" })).id;
      const grants = (p: string): Grant[] => ["conversation.start", "conversation.send", "conversation.receive"].map((action) => ({ action, project: p }));
      const enroll = async (kind: "agent" | "client" | "host", name: string, g: Grant[]) => {
        await principals.enroll(owner, { commandId: cid("e"), kind, name, grants: g });
        const token = (await principals.issueCredential(owner, `${kind}:${name}`)).token;
        return { token, id: (await principals.authenticate(token)).id };
      };
      const ann = await enroll("agent", "ann", grants(project));
      const ext = await enroll("client", "ext", grants(project));
      const zed = await enroll("agent", "zed", grants(other));
      const host = await enroll("host", "h1", []);
      const conversations = ConversationService.withEpoch(world.storage, projects.epoch, options);
      transport = await ConversationTransport.listen({ conversations, principals });
      const url = transport.url;
      const rpc = (token: string | undefined, method: string, params?: unknown, id: number = 1) => post(url, "/mcp", { ...(token === undefined ? {} : { token }), body: { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) } });
      const tool = async (token: string, name: string, args: unknown) => { const r = await rpc(token, "tools/call", { name, arguments: args }); assert.equal(r.status, 200); return r.body.result as { isError: boolean; structuredContent?: Record<string, any>; content: { text: string }[] }; };

      // The handshake issues no session and the tools list is served.
      const init = await rpc(ann.token, "initialize", { protocolVersion: MCP_REVISION(), capabilities: {}, clientInfo: { name: "t", version: "1" } });
      assert.equal(init.status, 200);
      assert.equal(init.headers["mcp-session-id"], undefined);
      assert.ok((await rpc(ann.token, "tools/list")).body.result.tools.length >= 9);

      // The agent starts, the client reads from the start and answers; a retried send with the same commandId is the same message.
      const s = await tool(ann.token, "conversation_start", { commandId: cid("s"), projectId: project, subject: "build", to: [ext.id], text: "green?" });
      assert.equal(s.isError, false, s.content[0]!.text);
      const threadId = s.structuredContent!["threadId"] as string;
      const r1 = (await tool(ext.token, "conversation_read", { threadId })).structuredContent!;
      assert.equal(r1["items"].length, 1);
      const answer = { commandId: "reply-once", threadId, text: "yes", kind: "answer" };
      const a1 = await tool(ext.token, "conversation_send", answer);
      const a2 = await tool(ext.token, "conversation_send", answer);
      assert.deepEqual([a1.structuredContent!["messageId"] === a2.structuredContent!["messageId"], a2.structuredContent!["replayed"]], [true, true]);

      // Reconnecting (no state in the connection) reads on from the cursor; the REST door sees the same record.
      const r2 = (await tool(ann.token, "conversation_read", { threadId })).structuredContent!;
      assert.equal(r2["items"].length, 2);
      const rest = await post(url, `/v1/threads/${threadId}/messages?after=${r2["cursor"]}`, { token: ann.token, method: "GET" });
      assert.equal(rest.body.items.length, 0);

      // Another project's agent learns nothing; a host credential is refused; a bad credential answers 401; no credential 401.
      const hidden = await tool(zed.token, "conversation_read", { threadId });
      assert.equal(hidden.isError, true);
      assert.equal((await rpc(host.token, "tools/list")).status, 403);
      assert.equal((await rpc("x".repeat(30), "tools/list")).status, 401);
      assert.equal((await rpc(undefined, "tools/list")).status, 401);

      // A revoked client is refused on its next request.
      const rec = await world.storage.getAggregate({ kind: "principal", id: ext.id });
      await principals.disable(owner, { commandId: cid("d"), principalId: ext.id, expectedRevision: rec!.revision });
      assert.equal((await rpc(ext.token, "tools/list")).status, 401);

      // Framing: a notification gets 202 and no body; GET and DELETE have no stream or session to offer; wrong type, bad JSON and a batch are refused as such.
      const note = await post(url, "/mcp", { token: ann.token, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
      assert.deepEqual([note.status, note.body], [202, undefined]);
      assert.equal((await post(url, "/mcp", { token: ann.token, method: "GET" })).status, 405);
      assert.equal((await post(url, "/mcp", { token: ann.token, method: "DELETE" })).status, 405);
      assert.equal((await post(url, "/mcp", { token: ann.token, body: {}, type: "text/plain" })).status, 415);
      assert.equal((await post(url, "/mcp", { token: ann.token, raw: "{nope" })).body.error.code, -32700);
      assert.equal((await post(url, "/mcp", { token: ann.token, body: [{ jsonrpc: "2.0", id: 1, method: "ping" }] })).body.error.code, -32600);
      assert.equal((await post(url, "/mcp", { token: ann.token, raw: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(70_000) } }) })).status, 413);
    } finally { await transport?.close(); await world.close(); }
  });
}

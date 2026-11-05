import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConversationService } from "../conversations/index.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant } from "../security/index.js";
import { ConversationTransport } from "./index.js";

// Card T05b: a stock MCP client (the official SDK's, as a user's own tool would be) can use the conversation door. The door's own tests speak JSON-RPC by hand; this one shows that what a real client sends
// and expects (its headers, its handshake, its notification, its attempt to open a stream) is accepted.

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  test(`${backend.name}: a stock MCP client connects, lists the tools, holds a conversation, reads a thread as a resource, and a new connection carries on from the cursor`, async () => {
    const world = await backend.open();
    let transport: ConversationTransport | undefined;
    const clients: Client[] = [];
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "P" })).id;
      const grants: Grant[] = ["conversation.start", "conversation.send", "conversation.receive"].map((action) => ({ action, project }));
      const enroll = async (kind: "agent" | "client", name: string) => {
        await principals.enroll(owner, { commandId: cid("e"), kind, name, grants });
        const token = (await principals.issueCredential(owner, `${kind}:${name}`)).token;
        return { token, id: (await principals.authenticate(token)).id };
      };
      const ann = await enroll("agent", "ann");
      const ext = await enroll("client", "ext");
      const conversations = ConversationService.withEpoch(world.storage, projects.epoch, options);
      transport = await ConversationTransport.listen({ conversations, principals });
      const connect = async (token: string): Promise<Client> => {
        const client = new Client({ name: "stock-client", version: "1.0.0" });
        // The SDK's own types do not satisfy this repository's exactOptionalPropertyTypes (its transport's sessionId), so the cast is only for the compiler.
        await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", transport!.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as never);
        clients.push(client);
        return client;
      };
      const call = async (client: Client, name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        assert.notEqual(r["isError"], true, JSON.stringify(r));
        return r["structuredContent"] as Record<string, any>;
      };

      const agent = await connect(ann.token);
      const names = (await agent.listTools()).tools.map((t) => t.name);
      for (const wanted of ["conversation_start", "conversation_send", "conversation_read"]) assert.ok(names.includes(wanted), `${wanted} is listed: ${names.join(", ")}`);
      const started = await call(agent, "conversation_start", { commandId: cid("s"), projectId: project, subject: "build", to: [ext.id], text: "green?" });
      const threadId = started["threadId"] as string;

      const client = await connect(ext.token);
      const first = await call(client, "conversation_read", { threadId });
      assert.equal(first["items"].length, 1);
      await call(client, "conversation_send", { commandId: cid("a"), threadId, text: "yes", kind: "answer" });

      // The thread is a resource the stock client lists and reads.
      const listed = await agent.listResources();
      assert.deepEqual(listed.resources.map((r) => r.uri), [`nimblenewt://thread/${threadId}`]);
      const read = await agent.readResource({ uri: `nimblenewt://thread/${threadId}` });
      const text = (read.contents[0] as { text: string }).text;
      assert.ok(text.includes("agent:ann: green?") && text.includes("client:ext: yes"), text);

      // The connection holds nothing: closing it and connecting again reads on from the cursor.
      const cursor = (await call(agent, "conversation_read", { threadId }))["cursor"] as string;
      await agent.close();
      const again = await connect(ann.token);
      const rest = await call(again, "conversation_read", { threadId, after: cursor });
      assert.equal(rest["items"].length, 0);
      await call(client, "conversation_send", { commandId: cid("b"), threadId, text: "and now?", kind: "message" });
      assert.equal((await call(again, "conversation_read", { threadId, after: cursor }))["items"].length, 1);
    } finally { for (const c of clients) await c.close().catch(() => undefined); await transport?.close(); await world.close(); }
  });
}

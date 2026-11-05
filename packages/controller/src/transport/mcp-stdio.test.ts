import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ConversationService } from "../conversations/index.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant } from "../security/index.js";
import { ConversationTransport } from "./index.js";

// Card T05b: a local MCP client starts the stdio entry as a program and uses the conversation door through it. The stock SDK client is the client; the bridge is a real child process; the door is the real listener.

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const MAIN = fileURLToPath(new URL("../mcp/stdio-main.js", import.meta.url));

for (const backend of backends) {
  test(`${backend.name}: a stock MCP client uses the conversation door through the stdio bridge; the credential stays out of the arguments, a bad one is refused, and switching the door off is seen by the next request`, async () => {
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
      let on = true;
      transport = await ConversationTransport.listen({ conversations, principals, mcpEnabled: async () => on });
      const door = new URL("/mcp", transport.url).href;
      const connect = async (token: string, url = door): Promise<{ client: Client; transport: StdioClientTransport }> => {
        const stdio = new StdioClientTransport({ command: process.execPath, args: [MAIN], env: { NIMBLENEWT_MCP_URL: url, NIMBLENEWT_TOKEN: token }, stderr: "pipe" });
        const client = new Client({ name: "stdio-client", version: "1.0.0" });
        await client.connect(stdio as never);
        clients.push(client);
        return { client, transport: stdio };
      };
      const call = async (client: Client, name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        assert.notEqual(r["isError"], true, JSON.stringify(r));
        return r["structuredContent"] as Record<string, any>;
      };

      const agent = await connect(ann.token);
      assert.ok(!(agent.transport as unknown as { _serverParams: { args: string[] } })._serverParams.args.join(" ").includes(ann.token), "the credential is not an argument");
      const names = (await agent.client.listTools()).tools.map((t) => t.name);
      for (const wanted of ["conversation_start", "conversation_send", "conversation_read"]) assert.ok(names.includes(wanted), `${wanted} is listed`);
      const started = await call(agent.client, "conversation_start", { commandId: cid("s"), projectId: project, subject: "build", to: [ext.id], text: "green?" });
      const threadId = started["threadId"] as string;
      const other = await connect(ext.token);
      assert.equal((await call(other.client, "conversation_read", { threadId }))["items"].length, 1);
      await call(other.client, "conversation_send", { commandId: cid("a"), threadId, text: "yes", kind: "answer" });
      const read = await agent.client.readResource({ uri: `nimblenewt://thread/${threadId}` });
      assert.ok((read.contents[0] as { text: string }).text.includes("client:ext: yes"));

      // A credential the door does not accept: the handshake itself is refused, with a message that names the problem and not the credential.
      let refused = "";
      try { await connect("x".repeat(30)); } catch (error) { refused = error instanceof Error ? error.message : String(error); }
      assert.match(refused, /credential was not accepted/);
      assert.ok(!refused.includes("x".repeat(30)));

      // The chat switch closes the door; the next request through the same bridge is refused, and turning it back on lets it through.
      on = false;
      await assert.rejects(agent.client.listTools(), /switched off/);
      assert.ok(!(await agent.client.listTools().catch((e: Error) => e.message)).toString().includes(ann.token));
      on = true;
      assert.ok((await agent.client.listTools()).tools.length > 0, "turned back on, the same bridge works again");
    } finally { for (const c of clients) await c.close().catch(() => undefined); await transport?.close(); await world.close(); }
  });
}

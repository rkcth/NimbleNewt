import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { after, test } from "node:test";
import { ConversationService } from "../conversations/index.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant } from "../security/index.js";
import { Ids, mismatch, readExamples } from "../api/testing/doc-examples.js";
import { ConversationTransport } from "./index.js";

// Card D02: every request and answer in docs/nimblenewt/conversation-and-mcp-protocol.md is sent to a real listener, on each storage backend.

after(stopServer);
const GUIDE = "docs/nimblenewt/conversation-and-mcp-protocol.md";
const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };

const send = (base: string, method: string, path: string, token: string | undefined, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: unknown }> => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const h: Record<string, string> = { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(data === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) }), ...headers };
  const req = httpRequest(new URL(path, base), { method, headers: h, agent: false }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (d: Buffer) => chunks.push(d));
    res.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); resolve({ status: res.statusCode!, body: raw === "" ? undefined : JSON.parse(raw) }); });
  });
  req.on("error", reject);
  if (data !== undefined) req.write(data);
  req.end();
});

test("the guide has examples for the routes, the refusals and the MCP door (card D02)", () => {
  const examples = readExamples(GUIDE);
  assert.ok(examples.length >= 12, `only ${examples.length} examples`);
  assert.ok(examples.some((e) => e.kind === "json"), "no MCP example");
  const statuses = new Set(examples.flatMap((e) => (e.response.status === undefined ? [] : [e.response.status])));
  for (const s of [200, 201, 400, 401, 404, 405]) assert.ok(statuses.has(s), `no example answers ${s}`);
});

for (const backend of backends) {
  test(`${backend.name}: every example in the conversation and MCP guide gives the answer the guide shows (card D02)`, async () => {
    const world = await backend.open();
    let transport: ConversationTransport | undefined;
    try {
      const projects = await ProjectService.open(world.storage, { holder: "d02", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const ownerToken = (await principals.issueCredential(owner, "owner:rob")).token;
      const project = (await projects.createProject({ commandId: "d02-p", actor: "owner:rob", name: "Garden" })).id;
      const grants: Grant[] = ["conversation.start", "conversation.send", "conversation.receive"].map((action) => ({ action, project }));
      await principals.enroll(owner, { commandId: "d02-ann", kind: "agent", name: "ann", grants });
      const ann = (await principals.issueCredential(owner, "agent:ann")).token;
      const conversations = ConversationService.withEpoch(world.storage, projects.epoch, options);
      transport = await ConversationTransport.listen({ conversations, principals });
      const tokens: Record<string, string | undefined> = { owner: ownerToken, ann, nobody: "x".repeat(40) };
      const ids = new Ids();
      ids.seed(project);
      for (const example of readExamples(GUIDE)) {
        assert.ok(example.as in tokens, `${GUIDE}:${example.line}: nobody called ${example.as}`);
        const token = tokens[example.as];
        const where = `${GUIDE}:${example.line}`;
        const live: { status: number; body: unknown } = example.kind === "http"
          ? await send(transport.url, example.request.method!, ids.fill(example.request.path!), token, ids.fill(example.request.headers), ids.fill(example.request.body))
          : await send(transport.url, "POST", "/mcp", token, {}, ids.fill(example.request.body));
        ids.learn(live.body);
        if (example.kind === "http") assert.equal(live.status, example.response.status, `${where}: status ${live.status}, the guide shows ${example.response.status}`);
        else assert.equal(live.status, 200, `${where}: status ${live.status}`);
        if (example.response.body !== undefined) { const bad = mismatch(example.response.body, live.body); assert.equal(bad, undefined, `${where}: ${bad}`); }
      }
    } finally {
      await transport?.close();
      await world.close();
    }
  });
}

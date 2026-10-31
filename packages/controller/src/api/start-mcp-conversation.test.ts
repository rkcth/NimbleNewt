import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

const rpc = (url: string, token: string, body: unknown): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const r = httpRequest(new URL("/mcp", url), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (d: Buffer) => chunks.push(d));
    res.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); resolve({ status: res.statusCode!, body: raw === "" ? undefined : JSON.parse(raw) }); });
  });
  r.on("error", reject); r.end(data);
});

test("a started controller serves the MCP door on its conversation listener for the owner, the chat-settable switch refuses the next request, and without the listener there is no door", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-mcpconv-"));
  const none = await startController({ storage: { kind: "sqlite", path: join(d, "a.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try { assert.equal(none.conversationUrl, undefined); } finally { await none.close(); }
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "b.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, conversationTransport: {} });
  try {
    const owner = (await c.services.principals.bootstrapOwner({ name: "rob" })).token;
    const listed = await rpc(c.conversationUrl!, owner, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.result.tools.some((t: { name: string }) => t.name === "conversation_unread"));
    const unread = await rpc(c.conversationUrl!, owner, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "conversation_unread", arguments: {} } });
    assert.equal(unread.body.result.isError, false);
    assert.equal((await rpc(c.conversationUrl!, "x".repeat(40), { jsonrpc: "2.0", id: 3, method: "tools/list" })).status, 401);
    // The owner switches the door off (the same setting the chat edits): the next request is refused, the setting is owner-only, and switching it on again restores it.
    const principal = await c.services.principals.authenticate(owner);
    let rev: number | undefined;
    const set = async (n: string, value: boolean): Promise<void> => { const st = await c.services.configuration.stage(principal, { commandId: `${n}s`, layer: "installation", ...(rev === undefined ? {} : { expectedRevision: rev }), set: { "conversation.mcp.enabled": value } }); rev = (await c.services.configuration.apply(principal, { commandId: `${n}a`, layer: "installation", expectedRevision: st.revision })).revision; };
    await set("off", false);
    assert.equal((await rpc(c.conversationUrl!, owner, { jsonrpc: "2.0", id: 4, method: "tools/list" })).status, 404);
    await set("on", true);
    assert.equal((await rpc(c.conversationUrl!, owner, { jsonrpc: "2.0", id: 5, method: "tools/list" })).status, 200);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

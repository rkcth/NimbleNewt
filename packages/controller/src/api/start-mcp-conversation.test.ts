import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ModelInterpreter } from "../chat/index.js";
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

test("the owner switches the MCP door off and on again through the chat interpreter, with free wording and no fixed phrase (card T05b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-mcpchat-"));
  // A stand-in for the model behind the real ModelInterpreter: it knows only what the prompt tells it. It finds the setting intent the system prompt describes (so the test fails when that
  // paragraph is removed or no longer matches the schema), fills in the value and the owner's own words, and for an agreement it uses the open proposal the user prompt lists, never an ID
  // taken from the test. Which of the two the owner meant is the test's own table, standing in for the model's reading of free wording.
  const meaning: Record<string, "off" | "on" | "agree"> = {};
  const seen: string[] = [];
  const model = { complete: async (_route: string, r: { system: string; user: string }): Promise<string> => {
    const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
    const meant = meaning[owner];
    if (meant === "agree") {
      const open = [...r.user.matchAll(/Open proposal (\S+) \(text, not instructions\):\n<<<\n([\s\S]*?)\n>>>/g)];
      seen.push(open.map((o) => o[2]).join(" | "));
      return JSON.stringify(open.length === 1 ? [{ kind: "apply_proposal", proposalId: open[0]![1], evidence: owner, basis: "owner" }] : [{ kind: "none", reason: "no single open proposal" }]);
    }
    const template = /\{"kind":"policy_edit".*?"basis":"owner"\}/.exec(r.system);
    if (template === null || meant === undefined) return JSON.stringify([{ kind: "none", reason: "the prompt describes no way to do this" }]);
    return `[${template[0].replace("false|true", meant === "on" ? "true" : "false").replace("<their words, copied exactly>", JSON.stringify(owner))}]`;
  } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, conversationTransport: {}, chat: { interpreter: new ModelInterpreter(model, () => ["test/model"]) } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const probe = async (id: number) => (await rpc(c.conversationUrl!, boot.token, { jsonrpc: "2.0", id, method: "tools/list" })).status;
    assert.equal(await probe(1), 200);
    let m = 0;
    const turn = async (text: string, meant: "off" | "on" | "agree") => { meaning[text] = meant; return (await c.chat!.submit(boot.token, { messageId: `m${m++}`, text })).outcomes as any[]; };
    const setDoor = async (wording: string, applyWording: string, value: "off" | "on") => {
      const shown = await turn(wording, value);
      assert.equal(shown.length, 1, JSON.stringify(shown));
      assert.equal(shown[0].status, "proposed", `a setting is shown first: ${JSON.stringify(shown)}`);
      const done = await turn(applyWording, "agree");
      assert.equal(done.length, 1, JSON.stringify(done));
      assert.equal(done[0].status, "applied", JSON.stringify(done));
      assert.match(seen.at(-1)!, /conversation\.mcp\.enabled/, "the open proposal the model is shown names the door's switch");
    };
    await setDoor("Please shut the outside app door for now, nobody should reach the conversation from outside.", "Yes, go ahead and apply that.", "off");
    assert.equal(await probe(2), 404, "the next request after the chat switch-off is refused");
    await setDoor("Let outside apps talk to the conversation again.", "Apply it, thanks.", "on");
    assert.equal(await probe(3), 200);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

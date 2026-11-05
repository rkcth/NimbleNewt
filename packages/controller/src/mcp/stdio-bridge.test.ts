import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { checkDoorUrl, checkToken, runStdioBridge, STDIO_LIMITS, type DoorReply, type SendToDoor } from "./stdio-bridge.js";

const TOKEN = "nn_secret_credential_value_1234567890";

/** Runs the bridge over the given input lines with a fake door; returns what it wrote to the output and the error stream, and what it sent. */
async function run(lines: string[], send: SendToDoor, url = "http://127.0.0.1:9/mcp", tail = ""): Promise<{ out: string[]; err: string; sent: { body: string; token: string }[] }> {
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
  const sent: { body: string; token: string }[] = [];
  const out: string[] = []; let err = "";
  output.on("data", (d: Buffer) => out.push(...d.toString("utf8").split("\n").filter((l) => l !== "")));
  error.on("data", (d: Buffer) => { err += d.toString("utf8"); });
  const done = runStdioBridge({ url, token: TOKEN, input, output, error, send: async (door, body) => { sent.push({ body, token: door.token }); return send(door, body); } });
  for (const l of lines) input.write(`${l}\n`);
  if (tail !== "") input.write(tail);
  input.end();
  await done;
  await new Promise((r) => setImmediate(r));
  return { out, err, sent };
}
const answer = (status: number, body: unknown = undefined): DoorReply => ({ status, text: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body) });
const ping = { jsonrpc: "2.0", id: 7, method: "ping" };

test("each line is sent to the door with the credential and its answer written as one line; a notification gets no answer", async () => {
  const r = await run([JSON.stringify(ping), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })], async (_d, body) => (body.includes('"ping"') ? answer(200, { jsonrpc: "2.0", id: 7, result: {} }) : answer(202)));
  assert.deepEqual(r.out, [JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} })]);
  assert.equal(r.sent.length, 2);
  assert.ok(r.sent.every((s) => s.token === TOKEN));
  assert.equal(r.err, "");
});

test("messages are sent one at a time, in order, and an unterminated last line is still sent", async () => {
  const order: string[] = [];
  const r = await run(["{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"a\"}", "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"b\"}"], async (_d, body) => { const id = (JSON.parse(body) as { id: number }).id; order.push(`start ${id}`); await new Promise((x) => setTimeout(x, id === 1 ? 30 : 1)); order.push(`end ${id}`); return answer(200, { jsonrpc: "2.0", id, result: {} }); }, undefined, "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"c\"}");
  assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  assert.deepEqual(r.out.map((l) => (JSON.parse(l) as { id: number }).id), [1, 2, 3]);
});

test("a refusal by the door becomes a JSON-RPC error for that request, naming the problem and never the credential; a refused notification goes to the error stream only", async () => {
  for (const [status, text] of [[401, /credential was not accepted/], [403, /may not use the door/], [404, /switched off/], [413, /too large/], [503, /busy or in maintenance/], [500, /HTTP 500/]] as const) {
    const r = await run([JSON.stringify(ping)], async () => answer(status, { error: { code: "x", message: `echo ${TOKEN}` } }));
    const reply = JSON.parse(r.out[0]!) as { id: number; error: { code: number; message: string } };
    assert.deepEqual([reply.id, reply.error.code], [7, -32000]);
    assert.match(reply.error.message, text);
    assert.ok(!r.out.join("").includes(TOKEN) && !r.err.includes(TOKEN), "the credential is never written");
  }
  const note = await run([JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })], async () => answer(401));
  assert.deepEqual(note.out, []);
  assert.match(note.err, /notification was refused: the credential was not accepted/);
});

test("an unreachable controller and an answer that is not JSON-RPC are errors for the request; the cause of the failure is not copied", async () => {
  const down = await run([JSON.stringify(ping)], async () => { throw new Error(`connect ECONNREFUSED 127.0.0.1:9 with ${TOKEN}`); });
  assert.deepEqual(JSON.parse(down.out[0]!), { jsonrpc: "2.0", id: 7, error: { code: -32000, message: "the controller could not be reached" } });
  assert.ok(!down.out.join("").includes(TOKEN) && !down.err.includes(TOKEN));
  const junk = await run([JSON.stringify(ping)], async () => answer(200, "<html>proxy</html>"));
  assert.match((JSON.parse(junk.out[0]!) as { error: { message: string } }).error.message, /not a JSON-RPC message/);
  const list = await run([JSON.stringify(ping)], async () => answer(200, "[1,2]"));
  assert.match((JSON.parse(list.out[0]!) as { error: { message: string } }).error.message, /not a JSON-RPC message/);
});

test("a line over the door's size bound is answered here, not sent, and the next line still goes through; bad JSON is left for the door to answer", async () => {
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { pad: "x".repeat(STDIO_LIMITS.line + 10) } });
  const r = await run([big, JSON.stringify(ping), "{nope"], async (_d, body) => (body === "{nope" ? answer(200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "the body is not valid JSON" } }) : answer(200, { jsonrpc: "2.0", id: 7, result: {} })));
  assert.equal(r.sent.length, 2, "the long line was not sent");
  const replies = r.out.map((l) => JSON.parse(l) as { id: number | null; error?: { code: number } });
  assert.deepEqual(replies.map((x) => [x.id, x.error?.code]), [[null, -32600], [7, undefined], [null, -32700]]);
});

test("a long line that arrives in pieces is refused once and its rest dropped", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const out: string[] = [];
  output.on("data", (d: Buffer) => out.push(...d.toString("utf8").split("\n").filter((l) => l !== "")));
  const sent: string[] = [];
  const done = runStdioBridge({ url: "http://localhost:9/mcp", token: TOKEN, input, output, send: async (_d, body) => { sent.push(body); return answer(200, { jsonrpc: "2.0", id: 7, result: {} }); } });
  for (let i = 0; i < 5; i++) input.write("y".repeat(STDIO_LIMITS.line / 2));
  input.write(`\n${JSON.stringify(ping)}\n`);
  input.end();
  await done;
  assert.equal(out.length, 2);
  assert.equal((JSON.parse(out[0]!) as { error: { code: number } }).error.code, -32600);
  assert.equal((JSON.parse(out[1]!) as { id: number }).id, 7);
  assert.equal(sent.length, 1);
});

test("the door's address and the credential are checked before anything is sent", async () => {
  assert.equal(checkDoorUrl("http://127.0.0.1:8080/mcp?x=1#y").href, "http://127.0.0.1:8080/mcp");
  assert.equal(checkDoorUrl("https://newt.example.org/mcp").protocol, "https:");
  assert.equal(checkDoorUrl("http://localhost/mcp").hostname, "localhost");
  assert.throws(() => checkDoorUrl("http://newt.example.org/mcp"), /only over https/);
  assert.throws(() => checkDoorUrl("https://rob:pw@newt.example.org/mcp"), /must not carry a user name/);
  assert.throws(() => checkDoorUrl("ftp://x/mcp"), /http:\/\/ or https:\/\//);
  assert.throws(() => checkDoorUrl("not a url"), /not a valid URL/);
  assert.throws(() => checkDoorUrl(undefined), /address is missing/);
  assert.equal(checkToken("abc.DEF-123_x"), "abc.DEF-123_x");
  for (const bad of ["", "has space", "line\nbreak", "tab\there", "x".repeat(STDIO_LIMITS.token + 1), undefined]) assert.throws(() => checkToken(bad), /credential/);
  await assert.rejects(runStdioBridge({ url: "http://newt.example.org/mcp", token: TOKEN, input: new PassThrough(), output: new PassThrough(), send: async () => answer(200, {}) }), /only over https/);
});

// Card W01b: the bench's repair of tool-call arguments in Pi's requests (lib/arg-clean.mjs, arg-clean-extension.mjs).
// Offline: no model call, no request to any server. The real Pi run against a stand-in server is in isolation.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import argCleanExtension, { createArgClean } from "./arg-clean-extension.mjs";
import { cleanJsonText, cleanPayload, strictJson, wellFormed } from "./lib/arg-clean.mjs";
import { readArgClean } from "./lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-eval-argclean-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** Pi 1.5.0's step (pi-coding-agent edit.js prepareEditArguments): a string `edits` that parses to an array is assigned into the same object. */
function piPrepare(args) {
  if (typeof args?.edits === "string") { try { const p = JSON.parse(args.edits); if (Array.isArray(p)) args.edits = p; } catch { /* left a string */ } }
  return args;
}
/** A request body as the openai SDK sends it, then decoded as a strict server would: UTF-8 with no replacement, then JSON, then each arguments text. */
function serverAccepts(payload) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return (body.messages ?? []).every((m) => (m.tool_calls ?? []).every((t) => strictJson(t.function.arguments)));
}
const toolCallPayload = (args) => ({ model: "m", messages: [{ role: "user", content: "go" }, { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "edit", arguments: args } }] }, { role: "tool", tool_call_id: "c1", content: "ok" }] });

test("the cleaner on JSON text: only lone surrogates change, escaped or raw; pairs, other escapes and formatting stay byte for byte", () => {
  const same = ["", "{}", '{"a":"\\u00e9\\n\\t\\\\"}', '{"a":"\\ud83d\\ude00 \\uD83D\\uDE00"}', '{"a":"😀 𐏿"}', '{"a":"\\\\ud800 is text"}', '{"a":"\\u12"}', '{ "spaced" :  [1, 2.50, "x"] }'];
  for (const s of same) { const r = cleanJsonText(s); assert.equal(r.text, s, s); assert.equal(r.replaced, 0, s); }
  const cases = [
    ['{"a":"\\ud800"}', '{"a":"\\ufffd"}', 1],
    ['{"a":"\\udfff"}', '{"a":"\\ufffd"}', 1],
    ['{"a":"\\ud800-\\udfff"}', '{"a":"\\ufffd-\\ufffd"}', 2],
    ['{"a":"\\uD800\\uD800\\uDC00"}', '{"a":"\\ufffd\\uD800\\uDC00"}', 1],
    ['{"a":"\\udc00\\ud800"}', '{"a":"\\ufffd\\ufffd"}', 2],
    ['{"a":"x\\ud800"}', '{"a":"x\\ufffd"}', 1],
    ['{"a":"\\\\\\ud800"}', '{"a":"\\\\\\ufffd"}', 1],
    [`{"a":"${String.fromCharCode(0xd800)}x"}`, '{"a":"�x"}', 1],
    [`{"a":"${String.fromCharCode(0xdfff)}${String.fromCharCode(0xd800)}"}`, '{"a":"��"}', 2],
    ['{"a":"\\ud800\\udfff \\ud800-"}', '{"a":"\\ud800\\udfff \\ufffd-"}', 1],
  ];
  for (const [input, want, n] of cases) {
    const r = cleanJsonText(input);
    assert.equal(r.text, want, input);
    assert.equal(r.replaced, n, input);
    assert.equal(strictJson(r.text), true, input);
  }
  assert.equal(wellFormed("a\uD800b"), "a�b");
  assert.equal(wellFormed("😀"), "😀");
});

test("exact cases: a pair is kept however its halves are written; text that is not JSON is not read as escapes; keys are strings too; idempotent; linear on a megabyte", () => {
  const H = String.fromCharCode(0xd800); const L = String.fromCharCode(0xdfff);
  for (const s of [`{"a":"\\ud800${L}"}`, `{"a":"${H}\\udfff"}`]) assert.deepEqual(cleanJsonText(s), { text: s, replaced: 0 }, s);
  assert.deepEqual(cleanJsonText(`{"a":"\\ud800${H}"}`), { text: '{"a":"\\ufffd\ufffd"}', replaced: 2 });
  for (const s of ['{"a":"\\ud800', "\\ud800 not json", '{"a":"\\ud800"} trailing']) assert.deepEqual(cleanJsonText(s), { text: s, replaced: 0 }, s);
  assert.deepEqual(cleanJsonText(`{"a":"\\ud800 ${L}`), { text: '{"a":"\\ud800 \ufffd', replaced: 1 });
  const input = { first: 1, [`k${H}`]: "v", last: [2] };
  Object.defineProperty(input, "__proto__", { value: "own", enumerable: true, writable: true, configurable: true });
  const k = cleanPayload({ messages: [{ role: "assistant", content: [{ type: "tool_use", input }] }] });
  const got = k.payload.messages[0].content[0].input;
  assert.deepEqual(Object.keys(got), ["first", "k\ufffd", "last", "__proto__"]);
  assert.equal(Object.getPrototypeOf(got), Object.prototype);
  assert.equal(got.__proto__, "own");
  assert.equal(k.strings, 1);
  const once = cleanPayload(toolCallPayload('{"a":"\\ud800 \\udfff"}'));
  const twice = cleanPayload(once.payload);
  assert.equal(twice.payload, once.payload); assert.equal(twice.strings, 0);
  for (const s of [`{"a":"${"x\\ud800\\udfff\\n".repeat(80_000)}\\ud800"}`, `{"a":"${"\\\\".repeat(500_000)}\\ud800"}`, `{"a":"${H.repeat(1_000_000)}"}`]) {
    const t0 = performance.now();
    const r = cleanPayload({ ...toolCallPayload(s), other: s });
    assert.equal(r.arguments, 1);
    assert.ok(performance.now() - t0 < 3000, `${Math.round(performance.now() - t0)} ms`);
  }
});

test("the night batch's failure shape: a string `edits` with \\ud800 and \\udfff escapes, decoded by Pi's step and re-sent, is refused; cleaned, it is valid Unicode JSON", () => {
  // As the model sent it: `edits` is a JSON string whose text holds the escapes (and an escaped pair that is fine).
  const edits = JSON.stringify([{ oldText: "const BAD = /x/;", newText: "const BAD = /[\\u0000-\\u001f]/u; // RANGE" }]).replace("RANGE", "\\ud800-\\udfff \\ud800\\udfff");
  const modelArguments = JSON.stringify({ path: "src/commands.ts", edits });
  assert.equal(strictJson(modelArguments), true, "what the model sent is valid JSON");
  const stored = piPrepare(JSON.parse(modelArguments));
  assert.ok(Array.isArray(stored.edits), "Pi decoded the string in place");
  assert.equal(stored.edits[0].newText.isWellFormed(), false, "the stored call holds lone surrogates");
  const resent = JSON.stringify(stored); // pi-ai openai-completions: arguments: JSON.stringify(tc.arguments)
  assert.match(resent, /\\ud800-\\udfff/);
  assert.equal(strictJson(resent), false, "a strict parser refuses it");
  const payload = toolCallPayload(resent);
  assert.equal(serverAccepts(payload), false);
  const before = JSON.stringify(payload);
  const r = cleanPayload(payload);
  assert.equal(JSON.stringify(payload), before, "the payload given is not changed in place");
  assert.equal(r.strings, 1); assert.equal(r.arguments, 1);
  const args = r.payload.messages[1].tool_calls[0].function.arguments;
  assert.equal(strictJson(args), true);
  assert.equal(serverAccepts(r.payload), true);
  assert.equal(JSON.parse(args).edits[0].newText, "const BAD = /[\\u0000-\\u001f]/u; // �-� 𐏿", "the broken pair is U+FFFD, the whole pair and everything else kept");
  assert.equal(args, resent.replace("\\ud800-\\udfff", "\\ufffd-\\ufffd"), "nothing else of the text changed");
  // Untouched parts of the payload are the same objects (copied only along the changed path).
  assert.equal(r.payload.messages[0], payload.messages[0]);
  assert.equal(r.payload.messages[2], payload.messages[2]);
});

test("a payload that needs nothing comes back as the same object with zero counts; escape-like text outside arguments is the author's and stays", () => {
  const payload = { model: "m", stream: true, max_tokens: 10, messages: [{ role: "system", content: "Pairs 😀, text \\ud800 written out" }, { role: "assistant", content: [{ type: "text", text: "ok 𐏿" }], tool_calls: [{ id: "a", type: "function", function: { name: "bash", arguments: '{"command":"echo \\"\\\\ud800\\""}' } }] }], tools: [{ type: "function", function: { name: "t", parameters: { type: "object", properties: { arguments: { type: "string", description: "\\ud800" } } } } }] };
  const text = JSON.stringify(payload);
  const r = cleanPayload(payload);
  assert.equal(r.payload, payload);
  assert.equal(r.strings, 0); assert.equal(r.arguments, 0);
  assert.equal(JSON.stringify(r.payload), text);
});

test("raw lone surrogates in any other string become U+FFFD; OpenAI responses function_call arguments are cleaned like chat ones", () => {
  const lone = String.fromCharCode(0xd83d);
  const payload = { input: [{ role: "user", content: [{ type: "input_text", text: `hi ${lone}` }] }, { type: "function_call", call_id: "c", name: "edit", arguments: '{"a":"\\udc00"}' }, { type: "message", arguments: '{"a":"\\udc00"}' }], instructions: "fine" };
  const r = cleanPayload(payload);
  assert.equal(r.strings, 2); assert.equal(r.arguments, 1);
  assert.equal(r.payload.input[0].content[0].text, "hi �");
  assert.equal(r.payload.input[1].arguments, '{"a":"\\ufffd"}');
  assert.equal(r.payload.input[2].arguments, '{"a":"\\udc00"}', "only function_call items are read as arguments JSON");
  assert.equal(payload.input[0].content[0].text, `hi ${lone}`, "not changed in place");
});

test("the cleaner never throws: a throwing object, a cycle, a deep nest and things that are not plain data leave the payload as it was", () => {
  const trap = new Proxy({}, { ownKeys() { throw new Error("boom"); }, getPrototypeOf() { return Object.prototype; } });
  const r1 = cleanPayload({ messages: [trap] });
  assert.equal(r1.strings, 0);
  const cyc = { a: `x${String.fromCharCode(0xd800)}` }; cyc.self = cyc;
  const r2 = cleanPayload(cyc);
  assert.equal(r2.payload.a, "x�");
  let deep = { s: String.fromCharCode(0xd800) }; for (let i = 0; i < 200; i++) deep = { d: deep };
  assert.doesNotThrow(() => cleanPayload(deep));
  const date = new Date(0); const buf = Buffer.from("x");
  const r3 = cleanPayload({ date, buf, n: null, u: undefined, f: 1.5, b: false });
  assert.equal(r3.payload.date, date); assert.equal(r3.payload.buf, buf); assert.equal(r3.strings, 0);
  for (const v of [null, undefined, 3, "x", String.fromCharCode(0xdc00)]) assert.doesNotThrow(() => cleanPayload(v));
});

test("the extension through a fake Pi runner: registered on before_provider_request, returns nothing for a clean request, the cleaned payload otherwise, counts only in its file, never throws", async () => {
  const file = join(root, "ext", "arg-clean.json");
  mkdirSync(dirname(file), { recursive: true });
  const handlers = {};
  const prev = process.env.PI_EVAL_ARG_CLEAN_FILE;
  process.env.PI_EVAL_ARG_CLEAN_FILE = file;
  try { argCleanExtension({ on: (name, h) => { (handlers[name] ??= []).push(h); } }); } finally { if (prev === undefined) delete process.env.PI_EVAL_ARG_CLEAN_FILE; else process.env.PI_EVAL_ARG_CLEAN_FILE = prev; }
  assert.deepEqual(Object.keys(handlers), ["before_provider_request"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { requests: 0, requestsChanged: 0, stringsChanged: 0, argumentsChanged: 0, errors: 0 }, "written at load");
  // Pi's runner (extensions/runner.js emitBeforeProviderRequest): a handler's result replaces the payload unless undefined.
  const emit = async (payload) => { let p = payload; for (const h of handlers.before_provider_request) { const x = await h({ type: "before_provider_request", payload: p }, {}); if (x !== undefined) p = x; } return p; };
  const clean = toolCallPayload('{"path":"a","edits":[]}');
  assert.equal(await emit(clean), clean, "a request that needs nothing is passed on as it was");
  const bad = toolCallPayload(JSON.stringify(piPrepare({ path: "a", edits: '[{"oldText":"a","newText":"b \\ud800"}]' })));
  const sent = await emit(bad);
  assert.notEqual(sent, bad);
  assert.equal(serverAccepts(sent), true);
  const counts = readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(counts), { requests: 2, requestsChanged: 1, stringsChanged: 1, argumentsChanged: 1, errors: 0 });
  assert.doesNotMatch(counts, /oldText|newText|ud800|ufffd/, "no content of the request");
  // A handler error (a payload that cannot be read) and an unwritable record do not throw.
  const { handler, counts: c2 } = createArgClean({ file: join(root, "no-such-dir", "x.json") });
  const throwing = { type: "before_provider_request", get payload() { throw new Error("unreadable"); } };
  assert.equal(handler(throwing), undefined);
  assert.equal(c2.errors, 1);
  assert.equal(handler({ payload: clean }), undefined);
  const { handler: h3 } = createArgClean({ file: "" });
  assert.equal(serverAccepts(h3({ payload: bad })), true, "works without a record file");
});

test("the run record: readArgClean takes the counts only, says whether a repair was applied, and is null when the extension wrote nothing", () => {
  const f = join(root, "rec.json");
  assert.equal(readArgClean(f), null);
  writeFileSync(f, "not json");
  assert.equal(readArgClean(f), null);
  writeFileSync(f, JSON.stringify({ requests: 3, requestsChanged: 0, stringsChanged: 0, argumentsChanged: 0, errors: 0 }));
  assert.deepEqual(readArgClean(f), { applied: false, requests: 3, requestsChanged: 0, stringsChanged: 0, argumentsChanged: 0, errors: 0 });
  writeFileSync(f, JSON.stringify({ requests: 3, requestsChanged: 1, stringsChanged: 2, argumentsChanged: 1, errors: -1, text: "x", extra: "y" }));
  assert.deepEqual(readArgClean(f), { applied: true, requests: 3, requestsChanged: 1, stringsChanged: 2, argumentsChanged: 1, errors: 0 });
});

test("pi-agent.mjs starts Pi with the extension (a file beside it, inside what the sandbox already lets it read) and names the record file beside the log", () => {
  const fakePi = join(root, "fake-pi.mjs");
  const out = join(root, "fake-pi-out.json");
  writeFileSync(fakePi, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), file: process.env.PI_EVAL_ARG_CLEAN_FILE }));\n`);
  const logDir = join(root, "run"); mkdirSync(logDir, { recursive: true });
  const prompt = join(logDir, "prompt.md"); writeFileSync(prompt, "hello\n");
  const r = spawnSync(process.execPath, [join(here, "pi-agent.mjs"), root, prompt, join(logDir, "agent.jsonl")], { env: { PATH: process.env.PATH, PI_EVAL_PI_BIN: fakePi }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(readFileSync(out, "utf8"));
  const i = seen.argv.indexOf("-e");
  assert.ok(i >= 0, JSON.stringify(seen.argv));
  assert.equal(seen.argv[i + 1], join(here, "arg-clean-extension.mjs"));
  assert.ok(existsSync(seen.argv[i + 1]));
  assert.equal(dirname(seen.argv[i + 1]), here, "beside pi-agent.mjs: the sandbox binds this folder readable for the agent script already");
  assert.equal(seen.file, join(logDir, "arg-clean.json"));
});

// The acceptance replay: the night batch run's 77 logged messages (scripts/pi-eval/fixtures/w01b-night-run-messages.jsonl:
// every text left out except the tool calls' arguments, exactly as the model sent them), with Pi's edit step applied, built
// into a request by pi-ai's own OpenAI chat builder, which hands the body to onPayload; the test stops it there, so nothing
// is sent. Pi 1.5.0's builder and edit tool are used when the owner's Pi is installed; NimbleNewt's pinned pi-ai 1.3.0
// always (the same JSON.stringify of the arguments).
const fixture = readFileSync(join(here, "fixtures", "w01b-night-run-messages.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const piCli = join(homedir(), ".local", "pi-cli", "node_modules", "@earendil-works");
const builders = [
  ["NimbleNewt's pinned pi-ai 1.3.0", async () => (await import("@earendil-works/pi-ai/api/openai-completions")).streamSimple],
  ["Pi 1.5.0 (the bench's)", existsSync(join(piCli, "pi-ai", "dist", "api", "openai-completions.js")) ? async () => (await import(pathToFileURL(join(piCli, "pi-ai", "dist", "api", "openai-completions.js")).href)).streamSimple : null],
];
async function piEditStep() {
  const f = join(piCli, "pi-coding-agent", "dist", "core", "tools", "edit.js");
  if (!existsSync(f)) return piPrepare;
  const { createEditToolDefinition } = await import(pathToFileURL(f).href);
  return createEditToolDefinition(root).prepareArguments;
}
async function buildRequest(streamSimple, messages) {
  const model = { id: "m", name: "m", api: "openai-completions", provider: "stand-in", baseUrl: "http://127.0.0.1:9/v1", reasoning: true, input: ["text"], contextWindow: 262144, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let body;
  const options = { apiKey: "test", onPayload: async (p) => { body = p; throw new Error("captured, not sent"); } };
  for await (const ev of streamSimple(model, { messages }, options)) void ev;
  assert.ok(body, "pi-ai built a request");
  return body;
}
const refusedAt = (body) => body.messages.flatMap((m, i) => ((m.tool_calls ?? []).some((t) => !strictJson(t.function.arguments)) ? [i] : []));

for (const [label, load] of builders) {
  test(`the night batch replay through the extension (${label}): only messages[74] is refused without it; with it every arguments text passes a strict check and one argument is counted`, { skip: load === null ? "Pi 1.5.0 is not installed" : false }, async () => {
    const streamSimple = await load();
    const prepare = await piEditStep();
    assert.equal(fixture.length, 77);
    const asLogged = structuredClone(fixture);
    const decoded = structuredClone(fixture);
    for (const m of decoded) if (m.role === "assistant") for (const c of m.content) if (c.type === "toolCall" && c.name === "edit") { const p = prepare(c.arguments); assert.equal(p, c.arguments, "Pi keeps the same object"); }
    // As logged (before Pi's step): nothing to repair, and the extension passes the request on unchanged with zero counts.
    const plainBody = await buildRequest(streamSimple, asLogged);
    assert.deepEqual(refusedAt(plainBody), []);
    const e0 = createArgClean({ file: "" });
    assert.equal(e0.handler({ type: "before_provider_request", payload: plainBody }), undefined);
    assert.deepEqual(e0.counts, { requests: 1, requestsChanged: 0, stringsChanged: 0, argumentsChanged: 0, errors: 0 });
    // After Pi's step: the request the server refused, at the index it named.
    const body = await buildRequest(streamSimple, decoded);
    assert.deepEqual(refusedAt(body), [74]);
    assert.equal(serverAccepts(body), false);
    const e = createArgClean({ file: "" });
    const sent = e.handler({ type: "before_provider_request", payload: body });
    assert.ok(sent, "the extension replaced the payload");
    assert.deepEqual(refusedAt(sent), []);
    assert.equal(serverAccepts(sent), true);
    assert.deepEqual(e.counts, { requests: 1, requestsChanged: 1, stringsChanged: 1, argumentsChanged: 1, errors: 0 });
    // Only that one arguments text differs, and only by the two escapes.
    const diff = body.messages.flatMap((m, i) => (JSON.stringify(m) === JSON.stringify(sent.messages[i]) ? [] : [i]));
    assert.deepEqual(diff, [74]);
    const a0 = body.messages[74].tool_calls[0].function.arguments;
    assert.equal(sent.messages[74].tool_calls[0].function.arguments, a0.replace("\\ud800", "\\ufffd").replace("\\udfff", "\\ufffd"));
  });
}

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId } from "@nimblenewt/contracts";
import { PiAdapter, removeStoredThinking } from "./index.js";
import { scanStorage } from "./storage-compat.js";
import { rig, wireBody } from "./testing/wire.js";

// Card K06c: the model's stored thinking is removed from the conversation store itself, not only from the controller's copy, and the conversation still works afterwards.

const dirs: string[] = [];
const adapters: PiAdapter[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) await a.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "nn-purge-")); dirs.push(d); return d; };
const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;
const SIGNED = { ...fauxThinking("THOUGHT-the vendor quote looks low"), thinkingSignature: "SIGNATURE-ONLY-THE-PROVIDER-NEEDS" };
const ENCRYPTED = { type: "thinking" as const, thinking: "[Reasoning redacted]", thinkingSignature: "ENCRYPTED-PAYLOAD-123", redacted: true };
const tool = { name: "lookup", description: "look something up", parameters: Type.Object({}), execute: async () => "found" };
const text = (dir: string): string => readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
const snapshot = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const providerHistory = (body: Record<string, unknown>): { role: string; content: { type: string; text?: string }[] | string }[] => body["messages"] as never;

async function open(world: ReturnType<typeof rig>, dir: string): Promise<PiAdapter> {
  const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: world.models, model: world.ref, tools: [tool], promptLayout: { preamble: "Be exact." } });
  adapters.push(adapter);
  return adapter;
}

test("removing the stored thinking leaves no text, signature or encrypted payload in any file, keeps the words said, and the conversation goes on without it", async () => {
  const dir = tmp();
  const world = rig("anthropic-messages");
  const one = await open(world, dir);
  world.reply(fauxAssistantMessage([SIGNED, ENCRYPTED, fauxToolCall("lookup", {}), ], { stopReason: "toolUse" }), fauxAssistantMessage([SIGNED, fauxText("The quote is in euros.")]));
  await (await one.root().submit(input("r1", "is the quote right?"))).result();
  assert.equal((await one.root().thinking()).length, 3, "three blocks are stored before");
  await one.close();
  const before = text(dir);
  for (const secret of ["THOUGHT-the vendor quote", "SIGNATURE-ONLY-THE-PROVIDER-NEEDS", "ENCRYPTED-PAYLOAD-123"]) assert.ok(before.includes(secret), `${secret} is in the store`);

  const result = await removeStoredThinking(dir);
  assert.equal(result.blocks, 3); assert.equal(result.files, 1); assert.equal(result.emptied, 0);
  const after = text(dir);
  for (const secret of ["THOUGHT-the vendor quote", "SIGNATURE-ONLY-THE-PROVIDER-NEEDS", "ENCRYPTED-PAYLOAD-123", "Reasoning redacted"]) assert.ok(!after.includes(secret), `${secret} is gone from every file`);
  assert.ok(after.includes("The quote is in euros.") && after.includes("is the quote right?"), "the words said stay");
  assert.ok(!/"type"\s*:\s*"thinking"/.test(after));

  // Idempotent and byte-exact when there is nothing left to remove.
  const kept = snapshot(dir);
  const again = await removeStoredThinking(dir);
  assert.deepEqual([again.blocks, again.files, again.emptied], [0, 0, 0]);
  assert.deepEqual(snapshot(dir), kept, "nothing changes the second time");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".purge")), [], "no temporary file is left");

  // The store opens, checks out, shows no thinking, and the next request carries none (a half block would be refused by the provider).
  const storage = await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT);
  assert.deepEqual((await scanStorage(storage)).findings, []);
  await storage.close(BACKGROUND_CONTEXT);
  const two = await open(world, dir);
  assert.deepEqual(await two.root().thinking(), []);
  world.reply("Delivery is on the 5th.");
  await (await two.root().submit(input("r2", "and the delivery date?"))).result();
  const wire = providerHistory(await wireBody(world.seen[world.seen.length - 1]!));
  const assistant = wire.filter((m) => m.role === "assistant");
  assert.ok(assistant.length >= 1);
  for (const m of assistant) for (const b of Array.isArray(m.content) ? m.content : []) assert.ok(b.type !== "thinking" && b.type !== "redacted_thinking", "the request carries no thinking block");
  assert.ok(JSON.stringify(wire).includes("The quote is in euros."));
  assert.ok(!JSON.stringify(wire).includes("SIGNATURE-ONLY"));
});

test("an assistant message that held only thinking keeps one empty text block, and a provider request built from it has no thinking", async () => {
  const dir = tmp();
  const world = rig("anthropic-messages");
  const one = await open(world, dir);
  world.reply(fauxAssistantMessage([SIGNED]), "a plain answer");
  await (await one.root().submit(input("r1", "think about it"))).result();
  await one.close();
  const result = await removeStoredThinking(dir);
  assert.equal(result.blocks, 1); assert.equal(result.emptied, 1);
  const two = await open(world, dir);
  world.reply("next");
  await (await two.root().submit(input("r2", "go on"))).result();
  const wire = providerHistory(await wireBody(world.seen[world.seen.length - 1]!));
  assert.ok(!JSON.stringify(wire).includes("thinking"), "no thinking in the request");
});

test("a store that is not valid JSON lines, or has a leftover of an earlier try, is handled without losing the original", async () => {
  const dir = tmp();
  const world = rig("anthropic-messages");
  const one = await open(world, dir);
  world.reply(fauxAssistantMessage([SIGNED, fauxText("fine")]));
  await (await one.root().submit(input("r1", "q"))).result();
  await one.close();
  // A leftover of a try that stopped half way is removed.
  writeFileSync(join(dir, "main.jsonl.purge"), "half a file");
  const original = snapshot(dir);
  delete original["main.jsonl.purge"];
  // A line that mentions thinking but is not JSON: nothing is changed, and the leftover of this try is gone too.
  writeFileSync(join(dir, "doc-99.jsonl"), '{"type":"thinking" broken\n');
  await assert.rejects(removeStoredThinking(dir), /not JSON/);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".purge")), [], "a failed try leaves no temporary file");
  const now = snapshot(dir);
  delete now["doc-99.jsonl"];
  assert.deepEqual(now, original, "the real files are as they were");
  rmSync(join(dir, "doc-99.jsonl"));
  assert.equal((await removeStoredThinking(dir)).blocks, 1, "and once the damage is gone it works");
  await assert.rejects(removeStoredThinking(join(dir, "nope")), /ENOENT|no such/i);
});

test("a link in place of a store file is not followed, and a link in place of the folder is refused", { skip: process.platform === "win32" ? "creating links needs a privilege on Windows" : false }, async () => {
  const outside = tmp();
  writeFileSync(join(outside, "target.jsonl"), '{"role":"assistant","content":[{"type":"thinking","thinking":"X"}]}\n');
  const dir = tmp();
  symlinkSync(join(outside, "target.jsonl"), join(dir, "main.jsonl"));
  const r = await removeStoredThinking(dir);
  assert.equal(r.blocks, 0);
  assert.ok(readFileSync(join(outside, "target.jsonl"), "utf8").includes('"thinking":"X"'), "what a link points at is left alone");
  const link = join(tmp(), "store-link");
  symlinkSync(dir, link);
  await assert.rejects(removeStoredThinking(link), /plain folder/);
});

// ---- review (2026-11-13): the store must still open in Pi, and nothing but the thinking may change ------------------------------

async function storeWithThinking(): Promise<{ dir: string; world: ReturnType<typeof rig> }> {
  const dir = tmp();
  const world = rig("anthropic-messages");
  const one = await open(world, dir);
  world.reply(fauxAssistantMessage([SIGNED, fauxText("kept answer")]));
  await (await one.root().submit(input("r1", "question one"))).result();
  await one.close();
  return { dir, world };
}

test("an unfinished last write (no line end) is not turned into a complete line: Pi still opens the store and the conversation goes on", async () => {
  const { dir, world } = await storeWithThinking();
  // What a crash in the middle of an append leaves: part of a line with no line end. Pi cuts it off when it opens the store; a complete line that is not JSON would make the store unopenable.
  const { appendFileSync } = await import("node:fs");
  appendFileSync(join(dir, "main.jsonl"), '{"format":1,"type":"commit","seq":99,"writ');
  const r = await removeStoredThinking(dir);
  assert.equal(r.blocks, 1);
  assert.ok(readFileSync(join(dir, "main.jsonl"), "utf8").endsWith('"seq":99,"writ'), "the unfinished tail is left exactly as it was, with no line end added");
  const two = await open(world, dir);
  assert.deepEqual(await two.root().thinking(), []);
  world.reply("still here");
  await (await two.root().submit(input("r2", "go on"))).result();
});

test("an unfinished last write that mentions thinking is left out (as Pi's own opening does), and lines without thinking are copied byte for byte (CRLF, any bytes)", async () => {
  const dir = tmp();
  const other = Buffer.concat([Buffer.from('{"role":"user","content":"caf'), Buffer.from([0xc3, 0xa9]), Buffer.from('"}\r\n')]);
  const think = Buffer.from('{"role":"assistant","content":[{"type":"thinking","thinking":"T","thinkingSignature":"S"},{"type":"text","text":"A"}],"usage":{"input":7,"output":9}}\r\n');
  const torn = Buffer.from('{"role":"assistant","content":[{"type":"thinking","thinking":"half');
  writeFileSync(join(dir, "doc-3.jsonl"), Buffer.concat([other, think, other, torn]));
  const r = await removeStoredThinking(dir);
  assert.equal(r.blocks, 1);
  const out = readFileSync(join(dir, "doc-3.jsonl"));
  const expected = Buffer.concat([other, Buffer.from('{"role":"assistant","content":[{"type":"text","text":"A"}],"usage":{"input":7,"output":9}}\r\n'), other]);
  assert.deepEqual(out, expected, "the answer, the token counts and the line endings stay; the thinking and the unfinished tail go");
});

test("a file that changes between its read and its replacement is left as it is (nothing is lost), and the next try cleans it", async () => {
  const { dir } = await storeWithThinking();
  const { appendFileSync } = await import("node:fs");
  const added = '{"note":"written by someone else meanwhile"}\n';
  await assert.rejects(removeStoredThinking(dir, { afterRead: async (name) => { if (name === "main.jsonl") appendFileSync(join(dir, name), added); } }), /changed while/);
  const text1 = readFileSync(join(dir, "main.jsonl"), "utf8");
  assert.ok(text1.endsWith(added) && text1.includes("SIGNATURE-ONLY"), "the late write is kept and the original was not replaced");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".purge") || f.endsWith(".lock")), [], "no temporary or lock file is left");
  // A replacement of the same size (a different file put in its place) is noticed too.
  await assert.rejects(removeStoredThinking(dir, { afterRead: async (name) => { if (name === "main.jsonl") { const t = readFileSync(join(dir, name)); rmSync(join(dir, name)); writeFileSync(join(dir, name), t); } } }), /changed while/);
  const r = await removeStoredThinking(dir);
  assert.equal(r.blocks, 1);
  assert.ok(readFileSync(join(dir, "main.jsonl"), "utf8").endsWith(added));
});

test("two removals never work on one store at once; a lock left by a crash is taken over once it is old", async () => {
  const { dir } = await storeWithThinking();
  const { utimesSync } = await import("node:fs");
  let inner: Promise<unknown> | undefined;
  await removeStoredThinking(dir, { afterRead: async () => { inner ??= removeStoredThinking(dir).then(() => "ran", (e: Error) => e.message); await inner; } });
  assert.match(String(await inner), /another removal/);
  writeFileSync(join(dir, ".thinking-purge.lock"), "");
  const before = snapshot(dir);
  await assert.rejects(removeStoredThinking(dir), /another removal/);
  assert.deepEqual(snapshot(dir), before);
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(join(dir, ".thinking-purge.lock"), old, old);
  await removeStoredThinking(dir);
  assert.ok(!readdirSync(dir).includes(".thinking-purge.lock"));
});

test("the rewritten file keeps its mode, and a leftover of Pi's own sidecar shortening (which may hold thinking) is removed", { skip: process.platform === "win32" ? "file modes are POSIX" : false }, async () => {
  const { dir } = await storeWithThinking();
  const { chmodSync, statSync } = await import("node:fs");
  chmodSync(join(dir, "main.jsonl"), 0o640);
  writeFileSync(join(dir, "doc-0.jsonl.reclaim"), '{"role":"assistant","content":[{"type":"thinking","thinking":"LEFT"}]}\n');
  await removeStoredThinking(dir);
  assert.equal(statSync(join(dir, "main.jsonl")).mode & 0o777, 0o640);
  assert.ok(!readdirSync(dir).includes("doc-0.jsonl.reclaim"));
});

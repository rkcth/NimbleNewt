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

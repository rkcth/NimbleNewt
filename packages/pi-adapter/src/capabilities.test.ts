import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SUPPORTED_CAPABILITIES, UNSUPPORTED_CAPABILITIES } from "./index.js";

const planPath = fileURLToPath(new URL("../../../docs/nimblenewt/implementation-plan/task-plan.md", import.meta.url));

test("every card named in the unsupported-capabilities list exists in the task plan", () => {
  const plan = readFileSync(planPath, "utf8");
  const cards = new Set([...plan.matchAll(/^### ([A-Z]\d+[a-z]?) /gm)].map((m) => m[1]));
  for (const capability of UNSUPPORTED_CAPABILITIES) {
    assert.ok(capability.blocks.length > 0, `${capability.id} blocks nothing`);
    for (const card of capability.blocks) assert.ok(cards.has(card), `${capability.id} names unknown card ${card}`);
  }
});

test("capability ids are unique and none is both supported and unsupported", () => {
  const ids = [...SUPPORTED_CAPABILITIES, ...UNSUPPORTED_CAPABILITIES].map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the controller port still lacks the capabilities the manifest says are missing; adding one must update the manifest", async () => {
  const { PiAdapter } = await import("./index.js");
  const conversationMethods = new Set(Object.getOwnPropertyNames((await import("./adapter.js")).AdapterConversation.prototype));
  const unsupported = new Set(UNSUPPORTED_CAPABILITIES.map((c) => c.id));
  // If one of these methods appears, the matching capability is no longer missing: remove it from the manifest (and from the
  // `blocks` of dependent cards) deliberately.
  const probes: readonly (readonly [string, string])[] = [["wait", "wait-by-request-id"], ["cancelRequest", "cancel-single-request"], ["transcriptPage", "transcript-paging"], ["events", "progress-events"], ["exportHistory", "portable-history-export"]];
  for (const [method, capability] of probes) {
    assert.equal(conversationMethods.has(method), false, `AdapterConversation now has "${method}": update the "${capability}" entry`);
    assert.ok(unsupported.has(capability), `${capability} should be listed as unsupported`);
  }
  assert.equal(typeof PiAdapter.open, "function");
});

test("the G02 acceptance record lists every unsupported capability and the cards it blocks", () => {
  const record = readFileSync(fileURLToPath(new URL("../../../docs/nimblenewt/implementation-plan/g02-acceptance.md", import.meta.url)), "utf8");
  for (const capability of UNSUPPORTED_CAPABILITIES) {
    const row = record.split("\n").find((line) => line.includes(`\`${capability.id}\``));
    assert.ok(row, `g02-acceptance.md does not list ${capability.id}`);
    for (const card of capability.blocks) assert.ok(row.includes(card), `g02-acceptance.md row for ${capability.id} omits blocked card ${card}`);
  }
});

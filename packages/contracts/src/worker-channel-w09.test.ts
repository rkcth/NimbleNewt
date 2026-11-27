import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelError, MAX_REPLY_CEILING, encodeMessage, parseFromChild, parseToChild, replyCutOf, type ChannelStart } from "./index.js";

// W09 fixes, item 3: the host's reply ceiling in the start, and the process's reply cuts in a turn result.

const start: ChannelStart = {
  attemptId: "att-1", agentId: "agent:ann", namespaceId: "abcdef0123456789", credential: "task-credential", storeDir: "/home/agent/pi", relayBase: "http://relay.invalid",
  model: { alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] },
};
const startLine = (model: Record<string, unknown>): unknown => ({ t: "start", v: 1, start: { ...start, model: { ...start.model, ...model } } });

test("a start carries the reply ceiling when given: at least the reply limit, at most the channel's maximum; absent stays absent", () => {
  const withCeiling = parseToChild(startLine({ replyCeiling: 4096 }));
  assert.equal(withCeiling.t === "start" ? withCeiling.start.model.replyCeiling : null, 4096);
  const same = parseToChild(startLine({ replyCeiling: 1024 }));
  assert.equal(same.t === "start" ? same.start.model.replyCeiling : null, 1024);
  const none = parseToChild(startLine({}));
  assert.equal(none.t === "start" ? "replyCeiling" in none.start.model : null, false);
  for (const bad of [1023, -1, 1.5, "4096", MAX_REPLY_CEILING + 1]) assert.throws(() => parseToChild(startLine({ replyCeiling: bad })), ChannelError, String(bad));
  assert.doesNotThrow(() => parseToChild(startLine({ replyCeiling: MAX_REPLY_CEILING })));
  // It goes through the channel unchanged.
  const m = { t: "start", v: 1, start: { ...start, model: { ...start.model, replyCeiling: 8192 } } } as const;
  assert.deepEqual(parseToChild(JSON.parse(encodeMessage(m as never))), m);
});

test("a turn result carries the reply cuts, exactly shaped; anything else is refused", () => {
  const ok = { t: "result", status: "completed", text: "x", endKind: "length", visibleChars: 0, nudges: 3, replyCut: { cuts: 4, limit: 8192, ceiling: 8192 } };
  assert.deepEqual(parseFromChild((ok)), ok);
  assert.deepEqual(parseFromChild(({ t: "result", status: "failed", error: "e", replyCut: { cuts: 1, limit: 1, ceiling: 1 } })), { t: "result", status: "failed", error: "e", replyCut: { cuts: 1, limit: 1, ceiling: 1 } });
  for (const bad of [{ cuts: 1, limit: 9000, ceiling: 8192 }, { cuts: 1, limit: 0, ceiling: 8192 }, { cuts: -1, limit: 1, ceiling: 2 }, { cuts: 1001, limit: 1, ceiling: 2 }, { cuts: 1, limit: 1 }, { cuts: 1, limit: 1, ceiling: 2, more: 1 }, [1, 2, 3], null, "x", { cuts: 1, limit: 1, ceiling: MAX_REPLY_CEILING + 1 }]) {
    assert.throws(() => parseFromChild(({ t: "result", status: "completed", replyCut: bad })), ChannelError, JSON.stringify(bad));
    assert.equal(replyCutOf(bad), undefined, JSON.stringify(bad));
  }
});

// First review of the W09 fixes: the bound is the same figure the controller's own check (dispatch/ports.ts replyCutOf) and the worker's saved-limit reader (pi-adapter reply-room.ts) use, so it is pinned as a figure.
test("the largest reply ceiling is 1,000,000, and a start or result above it is refused", () => {
  assert.equal(MAX_REPLY_CEILING, 1_000_000);
  assert.throws(() => parseToChild(startLine({ replyCeiling: 1_000_001 })), ChannelError);
  assert.throws(() => parseFromChild({ t: "result", status: "completed", replyCut: { cuts: 1, limit: 1, ceiling: 1_000_001 } }), ChannelError);
});

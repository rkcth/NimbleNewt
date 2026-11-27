import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_REPLY_CEILING, MAX_REPLY_CUTS, replyCutOf as channelReplyCutOf } from "@nimblenewt/contracts";
import { REPLY_CUT_MAX_TOKENS, ROUTING_LIMITS, replyCeilingFor, replyCutOf as controllerReplyCutOf } from "@nimblenewt/controller";

// Second review of the W09 fixes: the controller restates the worker channel's reply-cut check (it does not depend on the contracts package). The two must read every record the same way, with the same bounds, so a record the
// process sends and the host passes on is never refused by the controller, and the largest ceiling a route can be given fits the channel's bound.

test("the controller's and the channel's reply-cut checks agree on every record, and the bounds line up", () => {
  const records: unknown[] = [
    { cuts: 1, limit: 8192, ceiling: 32_768 }, { cuts: 0, limit: 1, ceiling: 1 }, { cuts: MAX_REPLY_CUTS, limit: MAX_REPLY_CEILING, ceiling: MAX_REPLY_CEILING },
    { cuts: MAX_REPLY_CUTS + 1, limit: 1, ceiling: 2 }, { cuts: 1, limit: 1, ceiling: MAX_REPLY_CEILING + 1 }, { cuts: 1, limit: 0, ceiling: 2 }, { cuts: 1, limit: 3, ceiling: 2 },
    { cuts: -1, limit: 1, ceiling: 2 }, { cuts: 1.5, limit: 1, ceiling: 2 }, { cuts: "1", limit: 1, ceiling: 2 }, { cuts: 1, limit: 1 }, { cuts: 1, limit: 1, ceiling: 2, more: 1 },
    { cuts: Number.NaN, limit: 1, ceiling: 2 }, { cuts: 1, limit: Infinity, ceiling: Infinity }, [1, 2, 3], null, undefined, "x", 7,
  ];
  for (const r of records) assert.deepEqual(controllerReplyCutOf(r), channelReplyCutOf(r), JSON.stringify(r));
  // The largest reply limit an owner may declare, and the largest ceiling the controller gives without one, both fit the channel.
  assert.ok(ROUTING_LIMITS.maxTokens <= MAX_REPLY_CEILING);
  assert.ok(REPLY_CUT_MAX_TOKENS <= MAX_REPLY_CEILING);
  assert.ok(replyCeilingFor({ contextTokens: ROUTING_LIMITS.contextTokens, maxTokens: ROUTING_LIMITS.maxTokens }) <= MAX_REPLY_CEILING);
  assert.ok(replyCeilingFor({ contextTokens: ROUTING_LIMITS.contextTokens }) <= MAX_REPLY_CEILING);
});

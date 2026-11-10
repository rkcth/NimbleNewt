import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { RoutingService } from "../routing/service.js";
import type { Outcome } from "./index.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);

// Card W07: the owner sets a route's reply limit and reasoning cap in free-form chat. The change is shown first in every profile with what it does, and nothing is set until the owner agrees; the figures are read back through the API.
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const options = { clock: () => "2026-11-10T10:00:00.000Z", pause: async () => undefined };
const table = {
  providers: { local: { enabled: true, paid: false, location: "local" } },
  routes: { "local/qwen": { contextTokens: 64_000, capabilities: ["tools"] } },
  profiles: { main: ["local/qwen"] },
  roles: { coder: "main" },
};

for (const backend of backends) {
  test(`${backend.name}: the owner limits a route's replies and reasoning in chat; it is shown first with its consequence, applied only when the owner agrees, and read back through the API (card W07)`, async () => {
    const script: Record<string, unknown> = {};
    let routing: RoutingService | undefined;
    const w = await openWorld(backend, script, undefined, (storage, epoch) => { routing = RoutingService.withEpoch(storage, epoch, options); return { routeBudgets: routing }; });
    try {
      await routing!.setTable(w.owner, { commandId: cid("rt"), expectedRevision: 0, table });
      const chat = w.chat();
      w.profile.value = "autonomous";
      const say = async (text: string, plan: unknown[]): Promise<Outcome> => { script[text] = plan; const o = (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes; assert.equal(o.length, 1); return o[0]!; };
      let text = "The local/qwen model rambles: keep its answers under 8000 tokens and let it think for at most 2000.";
      const proposed = await say(text, [cmd("routing.budget.set", { route: "local/qwen", maxTokens: 8000, reasoningTokens: 2000 }, text)]);
      assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
      const shown = JSON.stringify(proposed);
      assert.match(shown, /maxTokens=8000/);
      assert.match(shown, /reasoningTokens=2000/);
      assert.match(shown, /Limit a model route's replies \(maxTokens\) and reasoning/);
      assert.match(proposed.message ?? "", /apply from its next model call, and a reply cut off at the limit is continued with a nudge to stop deliberating and act/, "the owner reads what the change does");
      assert.deepEqual(await routing!.budget("local/qwen"), {}, "nothing is set before the owner agrees");
      text = "Yes, do that.";
      const done = await say(text, [{ kind: "apply_proposal", proposalId: proposed.proposalId, evidence: text, basis: "owner" }]);
      assert.equal(done.status, "applied", JSON.stringify(done));
      assert.deepEqual(await routing!.budget("local/qwen"), { maxTokens: 8000, reasoningTokens: 2000 });
      // Read back through the API, and removed by chat ('no limit' is null).
      const read = (await w.api.handle(w.ownerToken, { v: 1, op: "routing.budgets", args: {} } as never)) as unknown as { ok: boolean; result: { routes: unknown[] } };
      assert.deepEqual(read.result.routes, [{ route: "local/qwen", contextTokens: 64_000, maxTokens: 8000, reasoningTokens: 2000 }]);
      text = "Drop the reasoning cap on local/qwen.";
      const lift = await say(text, [cmd("routing.budget.set", { route: "local/qwen", reasoningTokens: null }, text)]);
      assert.equal(lift.status, "proposed");
      await say("Go ahead.", [{ kind: "apply_proposal", proposalId: lift.proposalId, evidence: "Go ahead.", basis: "owner" }]);
      assert.deepEqual(await routing!.budget("local/qwen"), { maxTokens: 8000 });
      // A figure out of bounds is refused when the owner agrees, with the reason, and nothing changes.
      text = "Let local/qwen answer with up to 100000 tokens.";
      const big = await say(text, [cmd("routing.budget.set", { route: "local/qwen", maxTokens: 100_000 }, text)]);
      const refused = await say("Yes, set that limit.", [{ kind: "apply_proposal", proposalId: big.proposalId, evidence: "Yes, set that limit.", basis: "owner" }]);
      assert.notEqual(refused.status, "applied");
      assert.match(JSON.stringify(refused), /from 1 to 64000/);
      assert.deepEqual(await routing!.budget("local/qwen"), { maxTokens: 8000 });
      // Only the owner (or routing.write) reads or changes them.
      const zed = await w.agent("zed", [{ action: "task.read", project: "*" }]);
      for (const [op, args, commandId] of [["routing.budgets", {}, undefined], ["routing.budget.set", { route: "local/qwen", maxTokens: 10 }, "z1"]] as const) {
        const r = (await w.api.handle(zed.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as unknown as { ok: boolean; error?: { code: string } };
        assert.deepEqual([r.ok, r.error?.code], [false, "forbidden"], op);
      }
    } finally { await w.close(); }
  });
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatSpendService, launch, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets } from "@nimblenewt/controller";

// T2: the daily cap on the controller's own (reviewing) model calls can never lock the owner out of the chat. The controller as the launcher composes it, with the real chat interpreter on a
// scripted OpenAI-compatible endpoint behind an injected fetch (nothing leaves the machine): with today's count far over the cap, the owner's chat still reads the cap and raises it on a yes.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const secrets = (): LauncherSecrets => { const values = new Map<string, string>(); return { resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) }; };
const configFor = (dir: string): LauncherConfig => ({ installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {
  primary: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:8002/v1", enabled: true, paid: false, models: ["local-x"] },
  backup: { adapter: "openai-compatible", endpoint: "https://free.example.invalid/v1", enabled: true, paid: false, models: ["free-y"] },
} } });

function scriptedServer(script: Record<string, unknown[]>) {
  const seen: { system: string; text: string }[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === "user")!.content;
    const text = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(user)?.[1] ?? "";
    seen.push({ system: body.messages.find((m) => m.role === "system")?.content ?? "", text });
    const intents = script[text] ?? [{ kind: "none", reason: "nothing asked" }];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intents) } }], usage: { prompt_tokens: 400, completion_tokens: 100 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, seen };
}

test("at the daily cap the owner's chat still answers: it reads the cap and raises it on the owner's yes (T2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-t2cap-"));
  const script: Record<string, unknown[]> = {};
  const server = scriptedServer(script);
  try {
    const l = await launch({ config: configFor(dir), secrets: secrets(), argv: [], env: {}, print: () => undefined, start: { facts, filesystem: ext4 }, fetch: server.fetch });
    try {
      const call = (op: string, args: Record<string, unknown> = {}, commandId?: string) => l.controller.api.handle(l.ownerToken, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
      const say = async (text: string, intents: unknown[]) => { script[text] = intents; return (await l.controller.chat!.submit(l.ownerToken, { messageId: `m-${Math.random().toString(36).slice(2)}`, text })).outcomes as unknown as { status: string; proposalId?: string; lines?: { text: string }[] }[]; };

      // A low cap, and the reviewing agents have used far more than it today.
      assert.ok((await call("chat.budget.set", { maxTokensPerDay: 100 }, "low")).ok);
      await ChatSpendService.withEpoch(l.controller.storage, l.controller.epoch).record(5000, "reviewers-today");
      const before = (await call("chat.budget.get")).result.item;
      assert.deepEqual({ cap: before.maxTokensPerDay, tokens: before.tokens, remaining: before.remaining }, { cap: 100, tokens: 5000, remaining: 0 });

      // Asked in free words: the chat's model is still asked and the answer comes from the records.
      const q = "how much of today's token allowance have you used?";
      const [read] = await say(q, [{ kind: "status", request: { kind: "chat_budget" }, evidence: q, basis: "owner" }]);
      assert.equal(read!.status, "answered", JSON.stringify(read));
      assert.match(read!.lines!.map((x) => x.text).join("\n"), /may use 100 tokens a day[\s\S]*used 5000 tokens/);
      assert.ok(server.seen[0]!.system.includes("chat.budget.set(maxTokensPerDay") && server.seen[0]!.system.includes("chat_budget()"), "the shipped interpreter prompt lists the operation");

      // Raised in free words: shown first, applied on yes.
      const r = "raise your daily token cap to two million";
      const [proposed] = await say(r, [{ kind: "command", op: "chat.budget.set", args: { maxTokensPerDay: 2_000_000 }, evidence: r, basis: "owner" }]);
      assert.equal(proposed!.status, "proposed", JSON.stringify(proposed));
      assert.equal((await call("chat.budget.get")).result.item.maxTokensPerDay, 100, "nothing changes before the yes");
      const yes = `yes, go ahead with ${proposed!.proposalId}`;
      const [applied] = await say(yes, [{ kind: "apply_proposal", proposalId: proposed!.proposalId, evidence: yes, basis: "owner" }]);
      assert.equal(applied!.status, "applied", JSON.stringify(applied));
      const after = (await call("chat.budget.get")).result.item;
      assert.equal(after.maxTokensPerDay, 2_000_000);
      assert.equal(server.seen.length, 3, "every owner message reached the chat's model although the count was over the cap");
      assert.deepEqual({ tokens: after.tokens, calls: after.calls }, { tokens: 5000, calls: 1 }, "the chat's own calls are not counted against the cap");
    } finally { await l.close(); }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

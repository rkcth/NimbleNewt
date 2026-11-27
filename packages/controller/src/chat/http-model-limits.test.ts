import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpModelCall, type HttpCallLimits } from "./http-model.js";

// W09 fixes, item 2: the second agent's HTTP client with per-route limits: the reply limit and reasoning cap sent, one retry at the ceiling for a reply cut before any text, a named reply-cut failure, one time limit for the whole call.

type Body = Record<string, unknown>;
const reply = (content: unknown, finish: string | null = "stop", usage: unknown = { prompt_tokens: 10, completion_tokens: 5 }): Response => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage }), { status: 200 });
function client(limits: HttpCallLimits | undefined, answers: ((body: Body, n: number) => Response)[], seen: { body: Body; signal: AbortSignal | undefined }[] = [], failures: string[] = []) {
  return new HttpModelCall({
    endpoint: () => ({ url: "http://radiance:8002/v1" }),
    ...(limits === undefined ? {} : { limits: async () => limits }),
    fetch: async (_url, init) => { const body = JSON.parse(String(init?.body)) as Body; seen.push({ body, signal: init?.signal ?? undefined }); return answers[Math.min(seen.length - 1, answers.length - 1)]!(body, seen.length); },
    onFailure: (_r, k) => failures.push(k),
  });
}

test("the route's reply limit and its reasoning cap go into the request, in the field the kind names", async () => {
  const seen: { body: Body; signal: AbortSignal | undefined }[] = [];
  const m = client({ replyTokens: 8192, ceilingTokens: 32_768, timeoutMs: 300_000, reasoningTokens: 2048, kind: "radiance" }, [() => reply('{"verdict":"supported"}')], seen);
  const r = await m.completeDetailed("radiance/qwen", { system: "s", user: "u" });
  assert.equal(r.text, '{"verdict":"supported"}');
  assert.deepEqual([seen[0]!.body["max_tokens"], seen[0]!.body["thinking_token_budget"], seen.length], [8192, 2048, 1]);
  // llama.cpp names its own field; a kind with no known field sends only the reply limit.
  const l: { body: Body; signal: AbortSignal | undefined }[] = [];
  await client({ replyTokens: 4000, timeoutMs: 60_000, reasoningTokens: 1000, kind: "llama-cpp" }, [() => reply("ok")], l).complete("x/y", { system: "s", user: "u" });
  assert.deepEqual([l[0]!.body["max_tokens"], l[0]!.body["thinking_budget_tokens"]], [4000, 1000]);
  const g: { body: Body; signal: AbortSignal | undefined }[] = [];
  await client({ replyTokens: 1500, timeoutMs: 60_000, reasoningTokens: 1000, kind: "generic" }, [() => reply("ok")], g).complete("x/y", { system: "s", user: "u" });
  assert.deepEqual([g[0]!.body["max_tokens"], Object.keys(g[0]!.body).some((k) => /thinking/.test(k))], [1500, false]);
});

test("a reply cut at its limit before any text is asked once more at the ceiling, within the same time limit, and its usage is the sum of both", async () => {
  const seen: { body: Body; signal: AbortSignal | undefined }[] = [];
  const m = client({ replyTokens: 8192, ceilingTokens: 32_768, timeoutMs: 300_000, kind: "radiance" }, [() => reply("", "length", { prompt_tokens: 100, completion_tokens: 8192 }), () => reply('{"verdict":"supported"}', "stop", { prompt_tokens: 100, completion_tokens: 9000 })], seen);
  const r = await m.completeDetailed("radiance/qwen", { system: "s", user: "u" });
  assert.equal(r.text, '{"verdict":"supported"}');
  assert.deepEqual(seen.map((s) => s.body["max_tokens"]), [8192, 32_768]);
  assert.equal(seen[0]!.signal, seen[1]!.signal, "one time limit for the whole call");
  assert.deepEqual(r.usage, { inputTokens: 200, outputTokens: 17_192 });
  // A null content (some servers send it with only reasoning) is the same as no text.
  const n: { body: Body; signal: AbortSignal | undefined }[] = [];
  assert.equal(await client({ replyTokens: 100, ceilingTokens: 400, timeoutMs: 60_000 }, [() => reply(null, "length"), () => reply("fine")], n).complete("a/b", { system: "s", user: "u" }), "fine");
  assert.deepEqual(n.map((s) => s.body["max_tokens"]), [100, 400]);
});

test("a reply still cut at the ceiling, or cut where the limit is the ceiling, fails as reply-cut; it is never asked a third time", async () => {
  const seen: { body: Body; signal: AbortSignal | undefined }[] = [];
  const failures: string[] = [];
  const m = client({ replyTokens: 8192, ceilingTokens: 32_768, timeoutMs: 300_000, kind: "radiance" }, [() => reply("", "length")], seen, failures);
  await assert.rejects(m.complete("radiance/qwen", { system: "s", user: "u" }), (e: Error) => /^reply-cut: the reply was cut at the 32768-token reply limit before it held any text \(the route's ceiling\)$/.test(e.message));
  assert.equal(seen.length, 2);
  assert.deepEqual(failures, ["reply-cut"]);
  const once: { body: Body; signal: AbortSignal | undefined }[] = [];
  await assert.rejects(client({ replyTokens: 16_384, ceilingTokens: 16_384, timeoutMs: 300_000 }, [() => reply("", "length")], once).complete("a/b", { system: "s", user: "u" }), (e: Error) => e.message.startsWith("reply-cut: "));
  assert.equal(once.length, 1, "a declared limit is the ceiling: no second call");
  // A reply with no text that was not cut is the old failure, not a reply cut, and is not asked again.
  const stop: { body: Body; signal: AbortSignal | undefined }[] = [];
  await assert.rejects(client({ replyTokens: 100, ceilingTokens: 400, timeoutMs: 60_000 }, [() => reply("", "stop")], stop).complete("a/b", { system: "s", user: "u" }), /held no text/);
  assert.equal(stop.length, 1);
});

test("without limits the client is as before: max_tokens 1,500 (or its own), one request, a cut reply is the old no-text failure", async () => {
  const seen: { body: Body; signal: AbortSignal | undefined }[] = [];
  const m = client(undefined, [() => reply("", "length")], seen);
  await assert.rejects(m.complete("a/b", { system: "s", user: "u" }), (e: Error) => /held no text/.test(e.message) && !/^reply-cut/.test(e.message));
  assert.deepEqual([seen.length, seen[0]!.body["max_tokens"], "thinking_token_budget" in seen[0]!.body], [1, 1500, false]);
});

test("a server that refuses the reasoning field the client added is asked once more without it; a refusal of something else is a failure", async () => {
  const seen: { body: Body; signal: AbortSignal | undefined }[] = [];
  const refuse = (): Response => new Response(JSON.stringify({ error: { message: "thinking_token_budget is set but reasoning_config is not configured" } }), { status: 400 });
  const m = client({ replyTokens: 8192, ceilingTokens: 32_768, timeoutMs: 300_000, reasoningTokens: 2048, kind: "vllm" }, [refuse, () => reply("ok")], seen);
  assert.equal(await m.complete("v/m", { system: "s", user: "u" }), "ok");
  assert.deepEqual(seen.map((s) => "thinking_token_budget" in s.body), [true, false]);
  const other: { body: Body; signal: AbortSignal | undefined }[] = [];
  await assert.rejects(client({ replyTokens: 8192, timeoutMs: 60_000, reasoningTokens: 2048, kind: "vllm" }, [() => new Response("bad request: messages", { status: 400 })], other).complete("v/m", { system: "s", user: "u" }), (e: Error) => e.message.startsWith("invalid-request: "));
  assert.equal(other.length, 1);
});

test("the call's time limit is the route's; limits that cannot be read fail the call before anything is sent", async () => {
  let sent = 0;
  const slow = new HttpModelCall({ endpoint: () => ({ url: "http://x/v1" }), limits: () => ({ replyTokens: 10, timeoutMs: 30 }), fetch: async (_u, init) => { sent++; return await new Promise<Response>((_ok, fail) => init?.signal?.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "TimeoutError" })))); } });
  const keep = setTimeout(() => undefined, 5000); // the time limit's own timer does not keep the test's event loop alive
  try { await assert.rejects(slow.complete("a/b", { system: "s", user: "u" }), (e: Error) => e.message.startsWith("outage: timed out")); } finally { clearTimeout(keep); }
  assert.equal(sent, 1);
  let none = 0;
  const broken = new HttpModelCall({ endpoint: () => ({ url: "http://x/v1" }), limits: async () => { throw new Error("the routing table could not be read"); }, fetch: async () => { none++; return reply("x"); } });
  await assert.rejects(broken.complete("a/b", { system: "s", user: "u" }), /reply limits could not be read: the routing table could not be read/);
  assert.equal(none, 0);
});

// First review of the W09 fixes: a call that ends as reply-cut was still answered (and paid for) twice; its tokens are counted under the daily cap of the controller's own calls.
test("a call that fails as reply-cut carries the tokens its cut replies used, and the guarded client counts them under the cap", async () => {
  const { GuardedModelCall } = await import("./routed-model.js");
  const { failedUsage } = await import("./http-model.js");
  const cut = () => reply("", "length", { prompt_tokens: 100, completion_tokens: 8192 });
  const m = client({ replyTokens: 8192, ceilingTokens: 32_768, timeoutMs: 300_000, kind: "radiance" }, [cut, () => reply("", "length", { prompt_tokens: 100, completion_tokens: 32_768 })]);
  const recorded: number[] = [];
  const spend = { allow: async () => ({ allowed: true, cap: null }), record: async (tokens: number) => { recorded.push(tokens); } };
  const guarded = new GuardedModelCall(m, { spend: spend as never });
  let thrown: unknown;
  await guarded.completeDetailed("radiance/qwen", { system: "s", user: "u" }).catch((e: unknown) => { thrown = e; });
  assert.match(String((thrown as Error).message), /^reply-cut: /);
  assert.deepEqual(failedUsage(thrown), { inputTokens: 200, outputTokens: 40_960 });
  assert.deepEqual(recorded, [41_160]);
  // A failure with no counted reply (an outage) carries nothing and records nothing; a failing count never changes the failure.
  const down = new HttpModelCall({ endpoint: () => ({ url: "http://radiance:8002/v1" }), limits: async () => ({ replyTokens: 8192, timeoutMs: 60_000 }), fetch: async () => new Response("bad gateway", { status: 502 }) });
  const r2: number[] = [];
  await assert.rejects(new GuardedModelCall(down, { spend: { allow: async () => ({ allowed: true }), record: async (n: number) => { r2.push(n); } } as never }).completeDetailed("radiance/qwen", { system: "s", user: "u" }), /^Error: outage: /);
  assert.deepEqual(r2, []);
  let told = 0;
  await assert.rejects(new GuardedModelCall(client({ replyTokens: 8192, ceilingTokens: 8192, timeoutMs: 60_000 }, [cut]), { spend: { allow: async () => ({ allowed: true }), record: async () => { throw new Error("store down"); } } as never, onSpendFailure: () => { told++; } }).completeDetailed("radiance/qwen", { system: "s", user: "u" }), /^Error: reply-cut: /);
  assert.equal(told, 1);
});

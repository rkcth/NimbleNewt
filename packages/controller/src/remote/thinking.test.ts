import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { after, test } from "node:test";
// The worker channel's bounds (`THINKING_REPORT` in the contracts package, which the controller's package rules do not let a test import): the process cuts to these, the route refuses more.
const THINKING_REPORT = { blocks: 50, chars: 8000 } as const;
import { backends, stopServer } from "../domain/testing/backends.js";
import { PROTOCOL_HEADER, REMOTE_LIMITS, SESSION_HEADER, type ThinkingWire } from "./protocol.js";
import { RemoteOfferRunner } from "./runner.js";
import { WorkerRequestError } from "./client.js";
import { FULL_ABILITIES, remoteSuite, wireRefuses } from "./testing/suite.js";
import { rawRequest } from "./testing/world.js";

after(stopServer);

// Card U09c: a remote host reports the model's thinking to the controller's thinking store over the worker protocol, with the same checks as every message about an attempt and the same bounds as a local process's report.
// This world has a stub store that logs what it was handed; the composed controller with the real store is in `api/start-thinking-remote.test.ts`.

const MARK = "SECRET-THINKING-MARKER-4711";
const block = (entryId: number, text = `thought ${entryId}`, extra: Partial<ThinkingWire> = {}): ThinkingWire => ({ entryId, block: 0, provider: "llama", model: "local-m", text, opaque: false, ...extra });

test("the route's bounds are the worker channel's figures (50 blocks of 8000 characters)", () => {
  assert.equal(REMOTE_LIMITS.thinkingBlocks, THINKING_REPORT.blocks);
  assert.equal(REMOTE_LIMITS.thinkingChars, THINKING_REPORT.chars);
});

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("a thinking message reaches the store with the attempt facts of the HOST'S OWN placement, not anything the message names", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, taskId, attempt } = await c.started(r1, "Order seeds");
    const a = await attempt.thinking([block(1), block(2)]);
    assert.deepEqual(a, { kept: 2 });
    assert.equal(c.thinking.calls.length, 1);
    const call = c.thinking.calls[0]!;
    assert.equal(call.attempt.attemptId, attemptId);
    assert.equal(call.attempt.taskId, taskId);
    assert.match(call.attempt.projectId, /^proj-/);
    assert.equal(typeof call.attempt.generation, "number");
    assert.deepEqual(call.blocks.map((b) => b.entryId), [1, 2]);
    // The store's reason comes back; the answer never carries a block's text.
    c.thinking.answer = async () => ({ kept: 0, reason: "off" });
    assert.deepEqual(await attempt.thinking([block(3, MARK)]), { kept: 0, reason: "off" });
  });

  suite("another host, a stale placement, an unknown attempt and an unconfirmed contract are refused before the store is reached; no refusal carries the text", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const { attemptId, placement, attempt } = await c.started(r1, "Order seeds");
    const theirs = r2.client.attempt(attemptId, placement);
    const clean = (e: Error) => assert.equal(e.message.includes(MARK), false);
    await wireRefuses("not_found", () => theirs.thinking([block(1, MARK)]), 404, clean);
    assert.ok(c.security.detected.some((d) => d.event.kind === "credential-misused"), "a host that names another host's attempt is a security signal");
    await wireRefuses("fenced", () => r1.client.attempt(attemptId, placement + 1).thinking([block(1, MARK)]), 409, clean);
    await wireRefuses("not_found", () => r2.client.attempt("att-aaaaaaaaaaaaaaaaaaaa", 1).thinking([block(1, MARK)]), 404, clean);
    const raw = await rawRequest(c.transport.url, "POST", `/worker/attempts/${attemptId}/thinking`, { token: r2.token, body: { placement, blocks: [block(1, MARK)] }, headers: { "idempotency-key": "k", [SESSION_HEADER]: "ses-nonexistent", [PROTOCOL_HEADER]: "1" } });
    assert.ok(raw.status === 409 || raw.status === 404, String(raw.status));
    assert.equal(JSON.stringify(raw.body).includes(MARK), false);
    const r3 = await c.host("r3");
    const fresh = await c.started(r3, "Order beans", { agent: "bob", unconfirmed: true });
    await wireRefuses("invalid_transition", () => fresh.attempt.thinking([block(1, MARK)]), 409, (e) => assert.match(e.message, /confirm/));
    assert.deepEqual(c.thinking.calls, [], "nothing reached the store");
    // A placement that ended is fenced as well.
    await attempt.complete({ status: "completed", text: "done" } as never);
    await wireRefuses("fenced", () => attempt.thinking([block(9, MARK)]), 409, clean);
    assert.deepEqual(c.thinking.calls, []);
  });

  suite("a malformed message is refused by shape: unknown or prototype members, wrong types, too many blocks, too long text; nothing reaches the store and no error carries the text", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, placement, attempt } = await c.started(r1, "Order seeds");
    const post = (body: unknown) => r1.client.send("POST", `/worker/attempts/${attemptId}/thinking`, { body: body as never, session: true, key: "k1" });
    const bad = async (body: unknown, field?: string): Promise<void> => { await wireRefuses("invalid_command", () => post(body), 400, (e) => { if (field !== undefined) assert.match(e.message, new RegExp(field)); assert.equal(e.message.includes(MARK), false); }); };
    await bad({ placement, blocks: [block(1, MARK)], extra: 1 });
    await bad({ placement }, "blocks");
    await bad({ placement, blocks: "text" }, "blocks");
    await bad({ placement, blocks: [] }, "blocks");
    await bad({ placement, blocks: Array.from({ length: THINKING_REPORT.blocks + 1 }, (_, i) => block(i, MARK)) }, "blocks");
    await bad({ placement, blocks: [null] }, "blocks");
    await bad({ placement, blocks: [[block(1)]] }, "blocks");
    await bad({ placement, blocks: [{ ...block(1, MARK), extra: 1 }] });
    await bad({ placement, blocks: [{ ...block(1, MARK), task: "task-aaaaaaaaaaaaaaaaaaaa" }] });
    await bad({ placement, blocks: [JSON.parse(`{"entryId":1,"block":0,"provider":"p","model":"m","text":"${MARK}","opaque":false,"__proto__":{"polluted":true}}`)] });
    await bad({ placement, blocks: [JSON.parse(`{"__proto__":{"entryId":1},"block":0,"provider":"p","model":"m","text":"${MARK}","opaque":false}`)] }, "__proto__");
    await bad({ placement, blocks: [JSON.parse(`{"constructor":{"prototype":{}},"entryId":1,"block":0,"provider":"p","model":"m","text":"${MARK}","opaque":false}`)] });
    await bad({ placement, blocks: [{ ...block(1, MARK), entryId: -1 }] }, "entryId");
    await bad({ placement, blocks: [{ ...block(1, MARK), entryId: 1.5 }] }, "entryId");
    await bad({ placement, blocks: [{ ...block(1, MARK), entryId: "1" }] }, "entryId");
    await bad({ placement, blocks: [{ ...block(1, MARK), block: 1e12 }] }, "block");
    await bad({ placement, blocks: [{ ...block(1, MARK), provider: "" }] }, "provider");
    await bad({ placement, blocks: [{ ...block(1, MARK), provider: "p".repeat(81) }] }, "provider");
    await bad({ placement, blocks: [{ ...block(1, MARK), model: "m".repeat(201) }] }, "model");
    await bad({ placement, blocks: [{ ...block(1, MARK), model: 5 }] }, "model");
    await bad({ placement, blocks: [{ ...block(1, MARK), opaque: "no" }] }, "opaque");
    await bad({ placement, blocks: [{ ...block(1), text: 5 }] }, "text");
    await bad({ placement, blocks: [{ ...block(1), text: "x".repeat(THINKING_REPORT.chars + 1) }] }, "text");
    const { text: _t, ...noText } = block(1);
    await bad({ placement, blocks: [noText] }, "text");
    assert.deepEqual(c.thinking.calls, []);
    // The largest legal message (50 blocks of 8000 characters) is a message.
    const big = Array.from({ length: THINKING_REPORT.blocks }, (_, i) => block(i, "x".repeat(THINKING_REPORT.chars)));
    assert.deepEqual(await attempt.thinking(big), { kept: 50 });
    assert.equal((c.thinking.calls as { blocks: unknown[] }[])[0]!.blocks.length, 50);
  });

  suite("a message too large for the route's body is sent by the client in parts and arrives whole; a body over the limit sent without a length (chunked) is refused while it streams", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, placement, attempt } = await c.started(r1, "Order seeds");
    // Text that escapes to six bytes a character in JSON: 50 blocks of it are far over the body limit as one message.
    const heavy = Array.from({ length: THINKING_REPORT.blocks }, (_, i) => block(i, "\u0001".repeat(THINKING_REPORT.chars)));
    assert.deepEqual(await attempt.thinking(heavy), { kept: 50 });
    assert.ok(c.thinking.calls.length > 1, "sent in parts");
    assert.deepEqual(c.thinking.calls.flatMap((x) => x.blocks.map((b) => b.entryId)), heavy.map((b) => b.entryId));
    const before = c.thinking.calls.length;
    // The same message directly is over the route's limit.
    const post = (body: unknown) => r1.client.send("POST", `/worker/attempts/${attemptId}/thinking`, { body: body as never, session: true, key: "k-big" });
    await wireRefuses("too_large", () => post({ placement, blocks: heavy }), 413);
    const session = r1.client.session!;
    const url = new URL(`/worker/attempts/${attemptId}/thinking`, c.transport.url);
    assert.equal(url.protocol, "http:");
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(url, { method: "POST", headers: { authorization: `Bearer ${r1.token}`, "content-type": "application/json", "transfer-encoding": "chunked", "idempotency-key": "k2", [SESSION_HEADER]: session.sessionId, [PROTOCOL_HEADER]: String(session.protocol) } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
      const chunk = "x".repeat(16 * 1024);
      req.write(`{"placement":${placement},"blocks":[{"entryId":1,"block":0,"provider":"p","model":"m","opaque":false,"text":"`);
      for (let sent = 0; sent <= REMOTE_LIMITS.thinkingBytes; sent += chunk.length) req.write(chunk);
      setTimeout(() => { req.destroy(); reject(new Error("no answer before the body ended: the limit is applied only after buffering")); }, 5000).unref();
    });
    assert.equal(status, 413);
    assert.equal(c.thinking.calls.length, before);
  });

  suite("a missing key and a session at another protocol version are refused before the body is read", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, placement } = await c.started(r1, "Order seeds");
    const base = { token: r1.token, body: { placement, blocks: [block(1)] } };
    const session = r1.client.session!;
    const noKey = await rawRequest(c.transport.url, "POST", `/worker/attempts/${attemptId}/thinking`, { ...base, headers: { [SESSION_HEADER]: session.sessionId, [PROTOCOL_HEADER]: String(session.protocol) } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error.code, "idempotency_key_required");
    const old = await rawRequest(c.transport.url, "POST", `/worker/attempts/${attemptId}/thinking`, { ...base, headers: { "idempotency-key": "k2", [SESSION_HEADER]: session.sessionId, [PROTOCOL_HEADER]: String(session.protocol + 1) } });
    assert.equal(old.status, 426);
    const get = await rawRequest(c.transport.url, "GET", `/worker/attempts/${attemptId}/thinking`, { token: r1.token, headers: { [SESSION_HEADER]: session.sessionId, [PROTOCOL_HEADER]: String(session.protocol) } });
    assert.ok(get.status === 405 || get.status === 404, String(get.status));
    // What a controller without the route answers (it reads the message as one it does not know, as this controller does a route it lacks): the very refusal the worker's runner takes for "not supported".
    const unknown = await r1.client.send("POST", `/worker/attempts/${attemptId}/no-such-message`, { body: { placement, blocks: [block(1)] } as never, session: true, key: "k3" }).then(() => undefined, (e: unknown) => e as WorkerRequestError);
    assert.ok(unknown instanceof WorkerRequestError);
    assert.deepEqual([unknown.status, unknown.code, unknown.message.startsWith("blocks is not a field")], [400, "invalid_command", true]);
    assert.deepEqual(c.thinking.calls, []);
  });

  suite("an attempt may have two thinking messages in the controller at once and send a bounded number; past that a message is answered 'limit' and dropped, the next attempt is unaffected", async (c) => {
    const r1 = await c.host("r1");
    const { attempt } = await c.started(r1, "Order seeds");
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    c.thinking.answer = async (blocks) => { await held; return { kept: blocks.length }; };
    const first = [attempt.thinking([block(1)]), attempt.thinking([block(2)])];
    for (let i = 0; i < 200 && c.thinking.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(c.thinking.calls.length, 2);
    assert.deepEqual(await attempt.thinking([block(3)]), { kept: 0, reason: "limit" });
    assert.equal(c.thinking.calls.length, 2, "the third did not reach the store");
    release();
    assert.deepEqual(await Promise.all(first), [{ kept: 1 }, { kept: 1 }]);
    assert.deepEqual(await attempt.thinking([block(4)]), { kept: 1 }, "the slots are free again");
  });

  suite("an attempt may send only so many thinking messages", async (c) => {
    const r1 = await c.host("r1");
    const { attempt } = await c.started(r1, "Order seeds");
    for (let i = 0; i < 3; i++) assert.deepEqual(await attempt.thinking([block(i)]), { kept: 1 });
    assert.deepEqual(await attempt.thinking([block(9)]), { kept: 0, reason: "limit" });
    const calls = c.thinking.calls.length;
    assert.equal(calls, 3);
    const r2 = await c.host("r2");
    const other = await c.started(r2, "Order beans", { agent: "bob" });
    assert.deepEqual(await other.attempt.thinking([block(1)]), { kept: 1 });
  }, { thinkingMessages: 3 });

  suite("the message budget is the placement's: a move to another host starts it again, so what the old holder spent is not taken from the new one", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const { attemptId, attempt } = await c.started(r1, "Order seeds");
    for (let i = 0; i < 3; i++) assert.deepEqual(await attempt.thinking([block(i)]), { kept: 1 });
    assert.deepEqual(await attempt.thinking([block(9)]), { kept: 0, reason: "limit" });
    await c.remote.relocate(c.owner, { commandId: "mv-1", attemptId, toHostId: r2.id, reason: "r1 retired" });
    assert.deepEqual((await c.tick()).started, [attemptId]);
    const offer = (await r2.client.offers())[0]!;
    const next = r2.client.attempt(attemptId, offer.placement);
    await next.accept();
    assert.deepEqual(await next.honorContract(offer.order, FULL_ABILITIES, c.clock.now()), { ok: true });
    assert.deepEqual(await next.thinking([block(10)]), { kept: 1 }, "the new placement has its own budget");
    await wireRefuses("fenced", () => attempt.thinking([block(11)]), 409);
  }, { thinkingMessages: 3, policy: async () => ({ dataHosts: ["host:r1", "host:r2"] }) });

  suite("a block longer than the route takes (the worker channel allows 20,000 characters) is cut by the client, not refused", async (c) => {
    const r1 = await c.host("r1");
    const { attempt } = await c.started(r1, "Order seeds");
    // A surrogate pair across the cut: the cut keeps whole characters.
    const long = "z".repeat(REMOTE_LIMITS.thinkingChars - 1) + "\u{1F600}" + "z".repeat(12_000);
    assert.deepEqual(await attempt.thinking([block(1, long), block(2)]), { kept: 2 });
    const sent = c.thinking.calls[0]!.blocks;
    assert.equal(sent[0]!.text, "z".repeat(REMOTE_LIMITS.thinkingChars - 1));
    assert.equal(sent[1]!.text, "thought 2");
  });

  suite("the text is not kept by the route: it is not in the placement or the controller's operations", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1, "Order seeds");
    await attempt.thinking([block(1, MARK)]);
    const everything = JSON.stringify([await c.remote.placement(c.dispatcherPrincipal, attemptId), await c.ops(attemptId)]);
    assert.equal(everything.includes(MARK), false);
  });
}

// ---- the worker side: a controller without the route, and a failing connection, never break the turn -----------------

const fakeRunner = (thinking: (blocks: readonly ThinkingWire[]) => Promise<unknown>, troubles: string[] = []) => {
  const attempt = { thinking, accept: async () => ({}), honorContract: async () => ({ ok: true }), complete: async () => undefined, pollControl: async () => [], putCheckpoint: async () => undefined } as never;
  const runner = new RemoteOfferRunner({ client: { attempt: () => attempt } as never, host: { start: async () => { await new Promise((r) => setTimeout(r, 300)); return { run: async () => ({ status: "completed", text: "ok" }), checkpoint: async () => ({}), stop: async () => undefined, restart: async () => undefined } as never; } }, abilities: {} as never, controlMs: 20, onTrouble: (_a, what, error) => troubles.push(`${what}: ${String((error as Error).message)}`) });
  return runner;
};
const offer = { placement: 1, order: { attemptId: "att-aaaaaaaaaaaaaaaaaaaa", taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa", agentId: "agent:ann", generation: 1 } } as never;

test("version skew: a controller without the thinking route (404 or a refused message) is not asked again for the attempt; the report is dropped silently and nothing carries the text", async () => {
  // What an older controller answers: its body check refuses the unknown `blocks` field (400), or the route is unknown (404/405).
  for (const [status, code, message] of [[404, "not_found", "no such route"], [405, "method_not_allowed", "use POST"], [400, "invalid_command", "blocks is not a field of this message"]] as const) {
    const troubles: string[] = [];
    let asked = 0;
    const runner = fakeRunner(async () => { asked++; throw new WorkerRequestError(status, code, message); }, troubles);
    const running = runner.run(offer);
    for (let i = 0; i < 100 && runner.running.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await runner.thinking("att-aaaaaaaaaaaaaaaaaaaa", [block(1, MARK)]);
    await runner.thinking("att-aaaaaaaaaaaaaaaaaaaa", [block(2, MARK)]);
    assert.equal(asked, 1, `${status}: asked once, then not again`);
    assert.equal(troubles.length, 1);
    assert.equal(troubles.join().includes(MARK), false);
    await running;
  }
});

test("a refusal of one message by a controller that has the route (400 naming a block's field) drops that message only; later reports are sent", async () => {
  const troubles: string[] = [];
  let asked = 0;
  const runner = fakeRunner(async () => { asked++; if (asked === 1) throw new WorkerRequestError(400, "invalid_command", "model: must be text of 1 to 200 characters"); return { kept: 1 }; }, troubles);
  const running = runner.run(offer);
  for (let i = 0; i < 100 && runner.running.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  await runner.thinking("att-aaaaaaaaaaaaaaaaaaaa", [block(1, MARK)]);
  await runner.thinking("att-aaaaaaaaaaaaaaaaaaaa", [block(2)]);
  await runner.thinking("att-aaaaaaaaaaaaaaaaaaaa", [block(3)]);
  assert.equal(asked, 3, "one malformed message does not turn reports off for the attempt");
  assert.deepEqual(troubles, []);
  await running;
});

test("a failing connection or a busy controller drops that message only; an attempt the runner does not run, and an empty report, send nothing", async () => {
  let asked = 0;
  const runner = fakeRunner(async () => { asked++; if (asked < 3) throw new WorkerRequestError(0, "unavailable", "could not connect"); return { kept: 1 }; });
  await runner.thinking("att-aaaaaaaaaaaaaaaaaaaa", [block(1)]);
  assert.equal(asked, 0, "not running here: nothing sent");
  const running = runner.run(offer);
  for (let i = 0; i < 100 && runner.running.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  await runner.thinking("att-aaaaaaaaaaaaaaaaaaaa", []);
  assert.equal(asked, 0);
  await runner.thinking("att-aaaaaaaaaaaaaaaaaaaa", [block(1)]);
  await runner.thinking("att-aaaaaaaaaaaaaaaaaaaa", [block(2)]);
  await runner.thinking("att-aaaaaaaaaaaaaaaaaaaa", [block(3)]);
  assert.equal(asked, 3, "a connection trouble does not stop later reports");
  await running;
});

import assert from "node:assert/strict";
import { after } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ModelStreamTap } from "../dispatch/model-stream.js";
import { STREAM_MIN_BATCH_MS } from "./client.js";
import { PROTOCOL_HEADER, SESSION_HEADER } from "./protocol.js";
import { DEFAULT_WORKER_TRANSPORT_LIMITS } from "./server.js";
import { remoteSuite, type Ctx } from "./testing/suite.js";
import { rawRequest } from "./testing/world.js";

after(stopServer);

// Card L05d finish: the controller bounds stream messages (`stream-events`) per attempt and minute, in the transport's clock window. The tests use real streams (started through the protocol, recorded by a recorder that counts what it was
// given), an injected transport clock and no waiting. An honest worker keeps all the calls of an attempt to one line of messages 50 ms apart, so it stays inside the bound however many calls are open.
const recorder = (): { tap: (attempt: { attemptId: string }) => ModelStreamTap; events: Map<string, number> } => {
  const events = new Map<string, number>();
  return { events, tap: (attempt) => ({ started: async () => ({ events: async (e: readonly unknown[]) => { events.set(attempt.attemptId, (events.get(attempt.attemptId) ?? 0) + e.length); return {}; }, ended: async () => undefined }) }) };
};

for (const backend of backends) {
  const suite = remoteSuite(backend);

  const rec = recorder();
  const clock = { now: 7_000_000 };
  suite("a worker that floods stream messages is refused per attempt: valid streams on two attempts, independent counters, refused at 30 s and 59 s of its window, recorded again at 60 s", async (c: Ctx) => {
    const r1 = await c.host("r1");
    const A = await c.started(r1, "Order seeds");
    const B = await c.started(r1, "Water beans", { agent: "bob" });
    assert.notEqual(A.attemptId, B.attemptId);
    const session = r1.client.session!;
    const post = (attemptId: string, action: string, body: unknown, key: string) => rawRequest(c.transport.url, "POST", `/worker/attempts/${attemptId}/${action}`, { token: r1.token, body, headers: { "idempotency-key": key, [SESSION_HEADER]: session.sessionId, [PROTOCOL_HEADER]: String(session.protocol) } });
    const open = async (x: typeof A): Promise<{ streamId: string; n: number }> => {
      const r = await post(x.attemptId, "stream-start", { placement: x.placement, call: { requestChars: 1 } }, `start-${x.attemptId}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { streamId: (r.body as { streamId: string }).streamId, n: 0 };
    };
    const send = async (x: typeof A, s: { streamId: string; n: number }) => (await post(x.attemptId, "stream-events", { placement: x.placement, streamId: s.streamId, n: ++s.n, events: [{ kind: "text", text: "x" }] }, `ev-${x.attemptId}-${s.n}`)).status;
    const sa = await open(A);
    const sb = await open(B);
    const T0 = clock.now;
    // Attempt A: five messages are recorded, the sixth and the rest of the flood are refused (the number is retried as the same message, so a refusal never moves the count).
    for (let i = 0; i < 5; i++) assert.equal(await send(A, sa), 200);
    assert.equal(rec.events.get(A.attemptId), 5, "five messages recorded");
    for (let i = 0; i < 7; i++) { const before = sa.n; assert.equal(await send(A, sa), 429); sa.n = before; }
    assert.equal(rec.events.get(A.attemptId), 5, "a refused message is not recorded");
    // Attempt B has its own counter and its own window (it opens a second later): A's flood did not use it up.
    clock.now = T0 + 1_000;
    for (let i = 0; i < 5; i++) assert.equal(await send(B, sb), 200, `B message ${i + 1}`);
    assert.equal(rec.events.get(B.attemptId), 5);
    assert.equal(await send(B, sb), 429); sb.n -= 1;
    // A is still refused half a window later and one second before its window ends.
    for (const at of [30_000, 59_000, 59_999]) { clock.now = T0 + at; const before = sa.n; assert.equal(await send(A, sa), 429, `A at ${at} ms`); sa.n = before; }
    assert.equal(rec.events.get(A.attemptId), 5);
    // B's window (opened at T0 + 1 s) is still closed at T0 + 60 s, while A's has reopened: the counters are independent in time as well.
    clock.now = T0 + 60_000;
    assert.equal(await send(A, sa), 200, "A is recorded again in the next window");
    assert.equal(rec.events.get(A.attemptId), 6);
    assert.equal(await send(B, sb), 429, "B's own window has not ended");
    sb.n -= 1;
    clock.now = T0 + 61_000;
    assert.equal(await send(B, sb), 200);
    assert.equal(rec.events.get(B.attemptId), 6);
  }, { transport: { limits: { streamEventsPerMinute: 5 }, clock: () => clock.now }, streams: (a) => rec.tap(a) });

  // The same proportions as the product's (a pace of one message per gap, a bound one and a half times a minute of it), scaled to a 600 ms gap so that the test sends 240 messages, not 2,000.
  const GAP = 600;
  const TOTAL = 240;
  const rec2 = recorder();
  const clock2 = { now: 9_000_000 };
  suite("an honest worker's calls are all accepted however many are open: two and four concurrent streams of one attempt, paced as one line, never reach the attempt's bound", async (c: Ctx) => {
    const r1 = await c.host("r1");
    for (const calls of [2, 4]) {
      const x = await c.started(r1, `Order seeds ${calls}`, { agent: `ann${calls}` });
      const refusals: unknown[] = [];
      const send = r1.client.send.bind(r1.client);
      r1.client.send = (async (method: string, path: string, call: never) => { const r = await send(method, path, call); if (r.status === 429) refusals.push(path); return r; }) as never;
      // Every call sends one message per piece; the clock is the transport's, and only the tap's own waiting moves it (to its slot, never back).
      const sleep = async (ms: number): Promise<void> => { clock2.now += ms; };
      const taps = Array.from({ length: calls }, () => x.attempt.streamTap({ now: () => clock2.now, sleep, batchMs: GAP, batchChars: 1 }));
      const streams = await Promise.all(taps.map((t) => t.started({ requestChars: 1 })));
      assert.ok(streams.every((s) => s !== undefined));
      const start = clock2.now;
      const perCall = Math.ceil(TOTAL / calls); // TOTAL messages in all: past one minute of the honest pace and past the bound at the speed of the calls added up
      await Promise.all(streams.map(async (s) => { for (let i = 0; i < perCall; i++) assert.deepEqual(await s!.events([{ kind: "text", text: "t" }]), {}); }));
      for (const s of streams) await s!.ended({ ok: true });
      assert.deepEqual(refusals, [], `${calls} calls: no message was refused`);
      assert.equal(rec2.events.get(x.attemptId), perCall * calls, "everything was recorded");
      assert.ok(clock2.now - start >= (perCall * calls - 1) * GAP, `the messages were one line, ${GAP} ms apart: ${clock2.now - start} ms for ${perCall * calls}`);
      r1.client.send = send as never;
      clock2.now += 120_000;
    }
  }, { transport: { limits: { streamEventsPerMinute: Math.ceil((60_000 / GAP) * 1.5) }, clock: () => clock2.now }, streams: (a) => rec2.tap(a) });

  suite("the default bound covers the most an honest worker sends (four open calls as one line of messages 50 ms apart) and stays below the host's own allowance", async () => {
    const honestPerMinute = Math.ceil(60_000 / STREAM_MIN_BATCH_MS);
    assert.ok(DEFAULT_WORKER_TRANSPORT_LIMITS.streamEventsPerMinute > honestPerMinute, "room above the honest pace");
    assert.equal(DEFAULT_WORKER_TRANSPORT_LIMITS.streamEventsPerMinute, Math.ceil(honestPerMinute * 1.5), "the proportion the scaled test uses");
    assert.ok(DEFAULT_WORKER_TRANSPORT_LIMITS.streamEventsPerMinute <= 2 * honestPerMinute, "an aggregate abuse bound, not a free pass");
    assert.ok(DEFAULT_WORKER_TRANSPORT_LIMITS.streamEventsPerMinute < DEFAULT_WORKER_TRANSPORT_LIMITS.perPrincipalPerMinute);
    assert.ok(honestPerMinute < DEFAULT_WORKER_TRANSPORT_LIMITS.perAddressPerMinute);
  });
}

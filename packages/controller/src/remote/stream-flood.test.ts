import assert from "node:assert/strict";
import { after } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PROTOCOL_HEADER, SESSION_HEADER } from "./protocol.js";
import { remoteSuite } from "./testing/suite.js";
import { rawRequest } from "./testing/world.js";

after(stopServer);

// Card L05d finish: a hostile worker that sends stream messages far faster than the 50 ms an honest one keeps to is answered `rate_limited` by the controller (a bound of its own for stream messages, per attempt and minute, on the
// worker transport), while the same host's other messages and another attempt's stream are not affected. The window is the transport's clock, so the test needs no waiting.
for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("a worker that floods stream messages is refused with rate_limited after the bound, per attempt, and is let in again in the next window; its other messages are not blocked", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId } = await c.started(r1, "Order seeds");
    let now = 5_000_000;
    const limited = await c.listen({ limits: { streamEventsPerMinute: 5 }, clock: () => now });
    const session = r1.client.session!;
    const post = (action: string, body: unknown) => rawRequest(limited.url, "POST", `/worker/attempts/${attemptId}/${action}`, { token: r1.token, body, headers: { "idempotency-key": `k-${Math.random().toString(36).slice(2)}`, [SESSION_HEADER]: session.sessionId, [PROTOCOL_HEADER]: String(session.protocol) } });
    const flood = (): Promise<number[]> => (async () => { const out: number[] = []; for (let i = 0; i < 12; i++) out.push((await post("stream-events", { placement: 1, streamId: "rs-00000000-0000-0000-0000-000000000000", n: 1, events: [{ kind: "text", text: "x" }] })).status); return out; })();
    const first = await flood();
    assert.equal(first.filter((s) => s === 429).length, 7, `five reach the service (whatever it answers), the other seven are refused: ${first.join(",")}`);
    assert.ok(first.slice(0, 5).every((s) => s !== 429) && first.slice(5).every((s) => s === 429));
    const refused = await post("stream-events", { placement: 1, streamId: "rs-00000000-0000-0000-0000-000000000000", n: 1, events: [] });
    assert.equal(refused.status, 429);
    assert.equal((refused.body as { error: { code: string } }).error.code, "rate_limited");
    // Another message of the same attempt is not a stream message and is not counted against the bound.
    assert.notEqual((await post("stream-end", { placement: 1, streamId: "rs-00000000-0000-0000-0000-000000000000", ok: true })).status, 429);
    // Another window of the clock lets the stream in again.
    now += 60_000;
    assert.notEqual((await post("stream-events", { placement: 1, streamId: "rs-00000000-0000-0000-0000-000000000000", n: 1, events: [{ kind: "text", text: "x" }] })).status, 429);
  });

  suite("an honest worker's pace (one message every 50 ms, 1,200 a minute) is inside the default bound", async () => {
    const { DEFAULT_WORKER_TRANSPORT_LIMITS } = await import("./server.js");
    const { STREAM_MIN_BATCH_MS } = await import("./client.js");
    assert.ok(DEFAULT_WORKER_TRANSPORT_LIMITS.streamEventsPerMinute >= Math.ceil(60_000 / STREAM_MIN_BATCH_MS));
    assert.ok(DEFAULT_WORKER_TRANSPORT_LIMITS.streamEventsPerMinute < DEFAULT_WORKER_TRANSPORT_LIMITS.perPrincipalPerMinute);
  });
}

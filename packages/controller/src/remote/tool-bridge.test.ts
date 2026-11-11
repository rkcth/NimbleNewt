import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { after } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { JsonObject } from "../storage/types.js";
import { PROTOCOL_HEADER, REMOTE_LIMITS, SESSION_HEADER } from "./protocol.js";
import { remoteSuite, wireRefuses } from "./testing/suite.js";
import { rawRequest } from "./testing/world.js";

after(stopServer);

// Card L05e: the tool bridge has a route in the worker protocol. A remote worker's tool request (the task credential and the request its tool extension made) reaches the controller's bridge bound to the attempt, after the session, the host,
// the placement and the dispatch contract of that attempt were checked. This world has a stub bridge that logs what it was handed; the composed controller with the real bridge is in `api/start-l05e.test.ts`.

const REQUEST = (callId: string, args: JsonObject = { kind: "note" }) => ({ op: "desk.write", callId, args });
const TOKEN = "nnt-secret-credential-0123456789";

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("a tool request goes to the controller's bridge bound to the attempt it came through, and the bridge's answer (a result or a refusal) comes back as it was", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1, "Order seeds");
    const a = await attempt.toolBridge(TOKEN, REQUEST("call_1"));
    assert.deepEqual(a, { ok: true, result: { callId: "call_1" } });
    assert.deepEqual(c.toolBridge.calls, [{ token: TOKEN, attemptId, request: REQUEST("call_1") }]);
    // A refusal by the bridge is an answer, not a failed request.
    c.toolBridge.handle = async () => ({ ok: false, code: "generation_refused", message: "the call was written for a generation that was corrected" });
    assert.deepEqual(await attempt.toolBridge(TOKEN, REQUEST("call_2")), { ok: false, code: "generation_refused", message: "the call was written for a generation that was corrected" });
    // A request without arguments is a request.
    c.toolBridge.handle = async (_t, _a, request) => ({ ok: true, result: { args: request.args === undefined } });
    assert.deepEqual(await attempt.toolBridge(TOKEN, { op: "desk.read", callId: "call_3" }), { ok: true, result: { args: true } });
  });

  suite("copies of one request that overlap (a retry after a timeout) share one answer and reach the bridge once; the same call ID with other content is not the same request", async (c) => {
    const r1 = await c.host("r1");
    const { attempt } = await c.started(r1, "Order seeds");
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const begun = new Promise<void>((r) => { started = r; });
    c.toolBridge.handle = async (_t, _a, request) => { started(); await held; return { ok: true, result: { callId: request.callId } }; };
    const first = attempt.toolBridge(TOKEN, REQUEST("call_1"));
    // A failing request must not leave the held bridge call (and the test process) waiting.
    const gaveUp = first.catch(() => release());
    await Promise.race([begun, gaveUp]);
    const copies = [attempt.toolBridge(TOKEN, REQUEST("call_1"), "retry-1"), attempt.toolBridge(TOKEN, REQUEST("call_1"), "retry-2")];
    const other = await attempt.toolBridge(TOKEN, REQUEST("call_1", { kind: "other" }), "other");
    assert.equal(other.ok, false);
    assert.equal((other as { code: string }).code, "invalid_command");
    assert.match((other as { message: string }).message, /already used in this attempt for a different request/);
    // The copies are on the controller's side of the wire before the first is let go (a slower store takes longer to read the placement).
    await new Promise((r) => setTimeout(r, 400));
    release();
    const answers = await Promise.all([first, ...copies]);
    for (const x of answers) assert.deepEqual(x, { ok: true, result: { callId: "call_1" } });
    assert.equal(c.toolBridge.calls.length, 1, "one request reached the bridge " + JSON.stringify(c.toolBridge.calls.map((x) => x.request)));
    // After it was answered, asking again goes to the bridge again, which answers from its ledger (it keys by attempt and call ID); the route adds no state.
    await attempt.toolBridge(TOKEN, REQUEST("call_1"));
    assert.equal(c.toolBridge.calls.length, 2);
  });

  suite("another host, a stale placement, an unknown attempt and an unconfirmed contract are refused before the bridge is reached; no refusal carries the credential", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const { attemptId, placement, attempt } = await c.started(r1, "Order seeds");
    const theirs = r2.client.attempt(attemptId, placement);
    await wireRefuses("not_found", () => theirs.toolBridge(TOKEN, REQUEST("x1")), 404, (e) => assert.equal(e.message.includes(TOKEN), false));
    assert.ok(c.security.detected.some((d) => d.event.kind === "credential-misused"), "a host that names another host's attempt is a security signal");
    await wireRefuses("fenced", () => r1.client.attempt(attemptId, placement + 1).toolBridge(TOKEN, REQUEST("x2")), 409, (e) => assert.equal(e.message.includes(TOKEN), false));
    await wireRefuses("not_found", () => r2.client.attempt("att-aaaaaaaaaaaaaaaaaaaa", 1).toolBridge(TOKEN, REQUEST("x3")), 404);
    // A session of the right host that has not been told about the attempt cannot use another session's number either: the session header must be this host's own.
    const raw = await rawRequest(c.transport.url, "POST", `/worker/attempts/${attemptId}/tool`, { token: r2.token, body: { placement, token: TOKEN, request: REQUEST("x4") }, headers: { "idempotency-key": "k", [SESSION_HEADER]: "ses-nonexistent", [PROTOCOL_HEADER]: "1" } });
    assert.ok(raw.status === 409 || raw.status === 404, String(raw.status));
    assert.equal(JSON.stringify(raw.body).includes(TOKEN), false);
    assert.deepEqual(c.toolBridge.calls, [], "nothing reached the bridge");
    // A worker that has not confirmed the dispatch contract of the placement does nothing the attempt counts.
    const r3 = await c.host("r3");
    const fresh = await c.started(r3, "Order beans", { agent: "bob", unconfirmed: true });
    await wireRefuses("invalid_transition", () => fresh.attempt.toolBridge(TOKEN, REQUEST("x5")), 409, (e) => assert.match(e.message, /confirm/));
    assert.deepEqual(c.toolBridge.calls, []);
    // The rightful host, confirmed, is let through.
    assert.equal((await attempt.toolBridge(TOKEN, REQUEST("x6"))).ok, true);
  });

  suite("the route is limited: an unknown field, a credential that cannot be one, a bad request shape and an over-size body are refused; a missing key and a session at another protocol version are refused before the body is read", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, placement, attempt } = await c.started(r1, "Order seeds");
    const post = (body: unknown) => r1.client.send("POST", `/worker/attempts/${attemptId}/tool`, { body: body as never, session: true, key: "k1" });
    const bad = async (body: unknown, field?: string): Promise<void> => { await wireRefuses("invalid_command", () => post(body), 400, (e) => { if (field !== undefined) assert.match(e.message, new RegExp(field)); assert.equal(e.message.includes(TOKEN), false); }); };
    await bad({ placement, token: TOKEN, request: REQUEST("a"), extra: 1 });
    await bad({ placement, token: "", request: REQUEST("a") }, "credential");
    await bad({ placement, token: "x".repeat(REMOTE_LIMITS.toolTokenChars + 1), request: REQUEST("a") }, "credential");
    await bad({ placement, token: 42, request: REQUEST("a") }, "credential");
    await bad({ placement, token: TOKEN }, "request");
    await bad({ placement, token: TOKEN, request: [] }, "request");
    await bad({ placement, token: TOKEN, request: { ...REQUEST("a"), credential: "x" } });
    await bad({ placement, token: TOKEN, request: { op: "", callId: "a" } }, "op");
    await bad({ placement, token: TOKEN, request: { op: "desk.write", callId: "has space" } }, "callId");
    await bad({ placement, token: TOKEN, request: { op: "desk.write", callId: "x".repeat(121) } }, "callId");
    await bad({ placement, token: TOKEN, request: { op: "desk.write", callId: "a", args: [1] } }, "args");
    await bad({ placement, token: TOKEN, request: { op: "desk.write", callId: "a", args: "text" } }, "args");
    assert.deepEqual(c.toolBridge.calls, []);
    // A body over the route's limit is refused by size, not parsed.
    await wireRefuses("too_large", () => post({ placement, token: TOKEN, request: REQUEST("big", { text: "x".repeat(REMOTE_LIMITS.toolBytes) }) }), 413);
    // The bridge's own argument limit (64 KB) is the bridge's to apply: a request below the route's limit reaches it.
    assert.equal((await attempt.toolBridge(TOKEN, REQUEST("mid", { text: "x".repeat(100_000) }))).ok, true);
    // Without a key, or at another protocol version than the session's, nothing is read.
    const base = { token: r1.token, body: { placement, token: TOKEN, request: REQUEST("k") } };
    const session = r1.client.session!;
    const noKey = await rawRequest(c.transport.url, "POST", `/worker/attempts/${attemptId}/tool`, { ...base, headers: { [SESSION_HEADER]: session.sessionId, [PROTOCOL_HEADER]: String(session.protocol) } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error.code, "idempotency_key_required");
    const old = await rawRequest(c.transport.url, "POST", `/worker/attempts/${attemptId}/tool`, { ...base, headers: { "idempotency-key": "k2", [SESSION_HEADER]: session.sessionId, [PROTOCOL_HEADER]: String(session.protocol + 1) } });
    assert.equal(old.status, 426);
    assert.equal(c.toolBridge.calls.length, 1, "only the one valid request reached the bridge");
  });

  suite("an overlapping copy with ANOTHER credential is not handed the first copy's answer: the bridge judges its credential itself (review of L05e)", async (c) => {
    const r1 = await c.host("r1");
    const { attempt } = await c.started(r1, "Order seeds");
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const begun = new Promise<void>((r) => { started = r; });
    c.toolBridge.handle = async (token, _a, request) => {
      if (token !== TOKEN) return { ok: false, code: "unauthenticated", message: "the credential was not accepted" };
      started(); await held; return { ok: true, result: { callId: request.callId } };
    };
    const first = attempt.toolBridge(TOKEN, REQUEST("call_1"));
    const gaveUp = first.catch(() => release());
    await Promise.race([begun, gaveUp]);
    const forgedP = attempt.toolBridge("nnt-some-other-credential-000000", REQUEST("call_1"), "forged");
    // The copy is on the controller's side of the wire before the first is let go (a shared answer would then be the first's result).
    await new Promise((r) => setTimeout(r, 400));
    release();
    const forged = await forgedP;
    assert.deepEqual(forged, { ok: false, code: "unauthenticated", message: "the credential was not accepted" });
    assert.deepEqual(await first, { ok: true, result: { callId: "call_1" } });
    assert.equal(c.toolBridge.calls.length, 2, "the copy with another credential reached the bridge on its own");
  });

  suite("a body over the route's limit sent without a length (chunked) is refused while it streams, not after it was buffered", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId } = await c.started(r1, "Order seeds");
    const session = r1.client.session!;
    const url = new URL(`/worker/attempts/${attemptId}/tool`, c.transport.url);
    assert.equal(url.protocol, "http:");
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(url, { method: "POST", headers: { authorization: `Bearer ${r1.token}`, "content-type": "application/json", "transfer-encoding": "chunked", "idempotency-key": "k1", [SESSION_HEADER]: session.sessionId, [PROTOCOL_HEADER]: String(session.protocol) } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
      // More than the limit, and the request is never ended: only a check while reading can answer.
      const chunk = "x".repeat(16 * 1024);
      req.write(`{"placement":1,"token":"${TOKEN}","request":{"op":"desk.write","callId":"c","args":{"t":"`);
      for (let sent = 0; sent <= REMOTE_LIMITS.toolBytes; sent += chunk.length) req.write(chunk);
      setTimeout(() => { req.destroy(); reject(new Error("no answer before the body ended: the limit is applied only after buffering")); }, 5000).unref();
    });
    assert.equal(status, 413);
    assert.deepEqual(c.toolBridge.calls, []);
  });

  suite("the credential is not kept: it is not in the placement, the controller's operations or the stored records", async (c) => {
    const r1 = await c.host("r1");
    const { attemptId, attempt } = await c.started(r1, "Order seeds");
    await attempt.toolBridge(TOKEN, REQUEST("call_1"));
    const everything = JSON.stringify([await c.remote.placement(c.dispatcherPrincipal, attemptId), await c.ops(attemptId)]);
    assert.equal(everything.includes(TOKEN), false);
  });
}

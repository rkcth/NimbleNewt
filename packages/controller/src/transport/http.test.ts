import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { after, test } from "node:test";
import { ConversationService, type Availability } from "../conversations/index.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ConversationTransport, type TransportOptions } from "./index.js";
import { selfSigned } from "./testing/selfsigned.js";

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const key = (label: string): string => `${label}-${n++}`;

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: any; raw: string }
interface Ctx {
  url: string; call(method: string, path: string, init?: { token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string; host?: string; idem?: boolean }): Promise<Reply>;
  ann: { token: string; principal: Principal }; ext: { token: string; principal: Principal }; project: string; owner: { token: string };
  principals: PrincipalService; conversations: ConversationService; states: Map<string, Availability>;
  start(extra?: Partial<TransportOptions>): Promise<ConversationTransport>; transport: ConversationTransport; hostToken: string; serviceToken: string; ownerPrincipal: Principal;
  revoke(id: string): Promise<void>;
}

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const running: ConversationTransport[] = [];
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const states = new Map<string, Availability>();
        const conversations = ConversationService.withEpoch(world.storage, projects.epoch, { ...options, availability: async (id) => states.get(id) ?? "available" });
        const bootstrap = await principals.bootstrapOwner({ name: "rob" });
        const ownerPrincipal = await principals.authenticate(bootstrap.token);
        const project = (await projects.createProject({ commandId: key("p"), actor: "owner:rob", name: "P" })).id;
        const grants = (p: string): Grant[] => ["conversation.start", "conversation.send", "conversation.receive"].map((action) => ({ action, project: p }));
        const login = async (kind: "agent" | "client" | "host" | "service", name: string, g: Grant[]) => {
          await principals.enroll(ownerPrincipal, { commandId: key("e"), kind, name, grants: g });
          const token = (await principals.issueCredential(ownerPrincipal, `${kind}:${name}`)).token;
          return { token, principal: await principals.authenticate(token) };
        };
        const ann = await login("agent", "ann", grants(project));
        const ext = await login("client", "ext", grants(project));
        const host = await login("host", "h1", []);
        const service = await login("service", "recovery", [{ action: "recovery.read", project: "*" }]);
        const start = async (extra: Partial<TransportOptions> = {}) => { const t = await ConversationTransport.listen({ conversations, principals, ...extra }); running.push(t); return t; };
        const transport = await start();
        const send = (tp: ConversationTransport) => (method: string, path: string, init: { token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string; host?: string; idem?: boolean } = {}): Promise<Reply> =>
          new Promise((resolve, reject) => {
            const url = new URL(path, tp.url);
            const data = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
            const headers: Record<string, string> = { ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }), ...(data === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) }), ...(method === "POST" && init.idem !== false ? { "idempotency-key": key("k") } : {}), ...(init.host === undefined ? {} : { host: init.host }), ...(init.headers ?? {}) };
            const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method, headers, ...(url.protocol === "https:" ? { ca: ctxCa.value, servername: "localhost" } : {}) }, (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (d: Buffer) => chunks.push(d));
              res.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); let parsed: unknown; try { parsed = raw === "" ? undefined : JSON.parse(raw); } catch { parsed = undefined; } resolve({ status: res.statusCode!, headers: res.headers, body: parsed, raw }); });
            });
            req.on("error", reject);
            if (data !== undefined) req.write(data);
            req.end();
          });
        const ctxCa = { value: undefined as string | undefined };
        const c: Ctx = {
          url: transport.url, call: send(transport), ann, ext, project, owner: { token: bootstrap.token }, principals, conversations, states, transport, hostToken: host.token, serviceToken: service.token, ownerPrincipal,
          start: async (extra) => { const t = await start(extra); if (extra?.tls !== undefined) ctxCa.value = extra.tls.cert as string; c.call = send(t); c.url = t.url; return t; },
          revoke: async (id) => { const f = await world.storage.getAggregate({ kind: "principal", id }); await principals.disable(ownerPrincipal, { commandId: key("dis"), principalId: id, expectedRevision: f!.revision }); },
        };
        await body(c);
      } finally { for (const t of running) await t.close(); await world.close(); }
    });

  suite("an agent and an outside client carry on a conversation over HTTP; a retry applies once and a changed retry is refused", async (c) => {
    const started = await c.call("POST", "/v1/threads", { token: c.ann.token, body: { projectId: c.project, subject: "hello", to: ["client:ext"], kind: "question", text: "are you there?" } });
    assert.equal(started.status, 201, started.raw);
    const { threadId, messageId } = started.body;
    const unread = await c.call("GET", "/v1/unread", { token: c.ext.token });
    assert.deepEqual([unread.status, unread.body.undelivered], [200, 1]);
    const first = await c.call("GET", `/v1/threads/${threadId}/messages`, { token: c.ext.token });
    assert.deepEqual([first.status, first.body.items.length, first.body.items[0].trust, first.body.items[0].sender], [200, 1, "untrusted-content", "agent:ann"]);
    const ack = await c.call("POST", `/v1/threads/${threadId}/ack`, { token: c.ext.token, body: { upToSeq: 1 } });
    assert.deepEqual([ack.status, ack.body], [200, { deliveredSeq: 1, more: false }]);
    // The client answers; sending the same request again returns the same message, not a second one.
    const idem = "reply-once";
    const reply = { token: c.ext.token, body: { kind: "answer", text: "yes", replyTo: messageId, claimedSender: "the build service" }, headers: { "idempotency-key": idem } };
    const one = await c.call("POST", `/v1/threads/${threadId}/messages`, reply);
    const two = await c.call("POST", `/v1/threads/${threadId}/messages`, reply);
    assert.deepEqual([one.status, two.status, one.body.messageId === two.body.messageId, two.body.replayed], [201, 200, true, true]);
    const changed = await c.call("POST", `/v1/threads/${threadId}/messages`, { ...reply, body: { kind: "answer", text: "something else", replyTo: messageId } });
    assert.deepEqual([changed.status, changed.body.error.code], [409, "command_conflict"]);
    const seen = await c.call("GET", `/v1/threads/${threadId}/messages?after=1`, { token: c.ann.token });
    assert.deepEqual(seen.body.items.map((m: { sender: string; claimedSender?: string }) => [m.sender, m.claimedSender]), [["client:ext", "the build service"]]);
    // Handling comes after delivery: ann is told to confirm receipt first, then may mark it handled; a stranger has no such message.
    const early = await c.call("POST", `/v1/messages/${one.body.messageId}/handled`, { token: c.ann.token, body: {} });
    assert.deepEqual([early.status, /acknowledge it first/.test(early.body.error.message)], [400, true]);
    await c.call("POST", `/v1/threads/${threadId}/ack`, { token: c.ann.token, body: { upToSeq: 2 } });
    assert.equal((await c.call("POST", `/v1/messages/${one.body.messageId}/handled`, { token: c.ann.token, body: {} })).status, 204);
    assert.equal((await c.call("POST", `/v1/messages/${one.body.messageId}/handled`, { token: c.owner.token, body: {} })).status, 403);
    const listed = await c.call("GET", "/v1/threads?limit=5", { token: c.ext.token });
    assert.equal(listed.body.items.length, 1);
    const one2 = await c.call("GET", `/v1/threads/${threadId}`, { token: c.ext.token });
    assert.equal(one2.body.participants.length, 2);
    const closed = await c.call("POST", `/v1/threads/${threadId}/close`, { token: c.ann.token, body: { expectedRevision: one2.body.revision } });
    assert.equal(closed.status, 204);
    const late = await c.call("POST", `/v1/threads/${threadId}/messages`, { token: c.ext.token, body: { text: "late" } });
    assert.deepEqual([late.status, late.body.error.code], [400, "invalid_command"]);
  });

  suite("a long-poll waits for a new message and returns it; a dropped client reconnects from its cursor and misses and repeats nothing", async (c) => {
    const t = (await c.call("POST", "/v1/threads", { token: c.ann.token, body: { projectId: c.project, subject: "poll", to: ["client:ext"], text: "first" } })).body;
    await c.call("POST", `/v1/threads/${t.threadId}/ack`, { token: c.ext.token, body: { upToSeq: 1 } });
    const waiting = c.call("GET", `/v1/threads/${t.threadId}/messages?wait=5000`, { token: c.ext.token });
    await new Promise((r) => setTimeout(r, 400));
    await c.call("POST", `/v1/threads/${t.threadId}/messages`, { token: c.ann.token, body: { text: "second" } });
    const got = await waiting;
    assert.deepEqual([got.status, got.body.items.map((m: { text: string }) => m.text)], [200, ["second"]]);
    // A client that gives up mid-wait and comes back with its cursor gets the next message exactly once.
    const dropped = new Promise<void>((resolve) => {
      const req = httpRequest(new URL(`/v1/threads/${t.threadId}/messages?after=2&wait=20000`, c.url), { headers: { authorization: `Bearer ${c.ext.token}` } });
      req.on("error", () => resolve()); req.on("response", () => resolve());
      req.end(); setTimeout(() => req.destroy(), 300);
    });
    await dropped;
    await c.call("POST", `/v1/threads/${t.threadId}/messages`, { token: c.ann.token, body: { text: "third" } });
    const again = await c.call("GET", `/v1/threads/${t.threadId}/messages?after=2`, { token: c.ext.token });
    assert.deepEqual(again.body.items.map((m: { text: string }) => m.text), ["third"]);
    // With nothing new, the wait ends empty at its limit.
    const quiet = await c.call("GET", `/v1/threads/${t.threadId}/messages?after=3&wait=600`, { token: c.ext.token });
    assert.deepEqual([quiet.status, quiet.body.items], [200, []]);
  });

  suite("the credential is checked afresh on every request: unknown, malformed, hosts and disabled principals are refused, and a revoked client at once", async (c) => {
    const probe = (token?: string, headers?: Record<string, string>) => c.call("GET", "/v1/unread", { ...(token === undefined ? {} : { token }), ...(headers === undefined ? {} : { headers }) });
    for (const reply of [await probe(), await probe("short"), await probe(`${c.ann.token}x`), await probe(undefined, { authorization: "Basic abc" })]) {
      assert.deepEqual([reply.status, reply.body.error.code, reply.headers["www-authenticate"]], [401, "unauthenticated", "Bearer"]);
    }
    assert.equal((await probe(c.hostToken)).status, 403);
    assert.equal((await probe(c.serviceToken)).status, 403, "the recovery service has no use for the conversation API");
    assert.equal((await probe(c.ext.token)).status, 200);
    await c.revoke("client:ext");
    const after = await probe(c.ext.token);
    assert.deepEqual([after.status, after.body.error.code], [401, "unauthenticated"]);
    assert.equal((await probe(c.owner.token)).status, 200);
    assert.ok(!after.raw.includes(c.ext.token));
  });

  suite("a request is bounded: body size, content type, JSON, methods and routes; errors never carry the credential", async (c) => {
    const post = (init: Parameters<Ctx["call"]>[2]) => c.call("POST", "/v1/threads", { token: c.ann.token, ...init });
    assert.equal((await post({ rawBody: JSON.stringify({ text: "x".repeat(70_000) }) })).status, 413);
    assert.equal((await post({ rawBody: "{}", headers: { "content-type": "text/plain" } })).status, 415);
    assert.deepEqual([(await post({ rawBody: "{not json" })).status, (await post({ rawBody: "[1]" })).status], [400, 400]);
    assert.deepEqual([(await post({ body: {}, idem: false })).status, (await post({ body: {}, idem: false })).body.error.code], [400, "idempotency_key_required"]);
    assert.equal((await c.call("DELETE", "/v1/unread", { token: c.ann.token })).status, 405);
    assert.equal((await c.call("GET", "/v1/nope", { token: c.ann.token })).status, 404);
    assert.equal((await c.call("GET", "/other", { token: c.ann.token })).status, 404);
    assert.equal((await c.call("GET", "/v1/threads/thr-aaaaaaaaaaaaaaaaaaaa", { token: c.ann.token })).status, 404);
    assert.equal((await c.call("GET", "/v1/threads/not-an-id/messages", { token: c.ann.token })).status, 400);
    assert.equal((await c.call("GET", "/v1/threads?limit=abc", { token: c.ann.token })).status, 400);
    const leaky = await post({ body: { projectId: c.project, subject: "x", to: ["agent:bob"], text: `my token is ${c.ann.token}` } });
    assert.ok(!leaky.raw.includes(c.ann.token));
    // The service's own refusals map to their statuses.
    assert.deepEqual([(await post({ body: { projectId: c.project, subject: "x", to: ["agent:nobody"], text: "x" } })).status, (await post({ body: { projectId: "proj-aaaaaaaaaaaaaaaaaaaa", subject: "x", to: ["client:ext"], text: "x" } })).status], [403, 403]);
    const ok = await post({ body: { projectId: c.project, subject: "x", to: ["client:ext"], text: "x" } });
    assert.equal(ok.headers["cache-control"], "no-store");
    assert.equal(ok.headers["x-content-type-options"], "nosniff");
    assert.equal(ok.headers["access-control-allow-origin"], undefined);
  });

  suite("requests are rate limited per client and per address, and long-polls are capped, with a reason and a time to retry", async (c) => {
    const t = await c.start({ limits: { perPrincipalPerMinute: 5, perAddressPerMinute: 1000, pollsPerPrincipal: 2, pollsTotal: 3, maxWaitMs: 3000 } });
    void t;
    const thread = (await c.call("POST", "/v1/threads", { token: c.ann.token, body: { projectId: c.project, subject: "limits", to: ["client:ext"], text: "x" } })).body.threadId;
    const results: number[] = [];
    for (let i = 0; i < 6; i++) results.push((await c.call("GET", "/v1/unread", { token: c.ext.token })).status);
    assert.deepEqual(results, [200, 200, 200, 200, 200, 429]);
    const limited = await c.call("GET", "/v1/unread", { token: c.ext.token });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
    // The owner has its own allowance; long-polls: two per client, three in all.
    const polls = [1, 2, 3].map(() => c.call("GET", `/v1/threads/${thread}/messages?after=1&wait=1500`, { token: c.owner.token }));
    await new Promise((r) => setTimeout(r, 300));
    const refused = await c.call("GET", `/v1/threads/${thread}/messages?after=1&wait=1500`, { token: c.owner.token });
    assert.deepEqual([refused.status, refused.body.error.code], [503, "too_many_polls"]);
    assert.ok((await Promise.all(polls)).some((p) => p.status === 200 || p.status === 429 || p.status === 503));
    // Addresses are limited before anything is checked, so guessing credentials is slow.
    const t2 = await c.start({ limits: { perAddressPerMinute: 3 } });
    void t2;
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await c.call("GET", "/v1/unread", { token: "x".repeat(40) })).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  });

  suite("local only unless remote exposure is asked for; remote needs TLS and host names; a request for any other host name is refused", async (c) => {
    await assert.rejects(ConversationTransport.listen({ conversations: c.conversations, principals: c.principals, host: "0.0.0.0" }), /remote exposure is off/);
    await assert.rejects(ConversationTransport.listen({ conversations: c.conversations, principals: c.principals, host: "192.0.2.1" }), /remote exposure is off/);
    const cert = selfSigned();
    await assert.rejects(ConversationTransport.listen({ conversations: c.conversations, principals: c.principals, allowRemote: true, publicHosts: ["localhost"] }), /needs TLS/);
    await assert.rejects(ConversationTransport.listen({ conversations: c.conversations, principals: c.principals, allowRemote: true, tls: cert }), /needs publicHosts/);
    await assert.rejects(ConversationTransport.listen({ conversations: c.conversations, principals: c.principals, allowRemote: true, tls: cert, publicHosts: ["bad host!"] }), /not a host name/);
    // Bound locally, requests addressed to a foreign name (DNS rebinding) are refused.
    assert.equal((await c.call("GET", "/v1/unread", { token: c.ann.token, host: "evil.example.com" })).status, 421);
    assert.equal((await c.call("GET", "/v1/unread", { token: c.ann.token, host: `localhost:${c.transport.port}` })).status, 200);
    assert.equal((await c.call("GET", "/v1/unread", { token: c.ann.token })).status, 200);
  });

  suite("over TLS the certificate is checked and plain HTTP does not work; the listener answers only to its own host names", async (c) => {
    const cert = selfSigned();
    const secure = await c.start({ tls: cert, allowRemote: true, publicHosts: ["localhost"] });
    assert.ok(secure.url.startsWith("https://"));
    const ok = await c.call("GET", "/v1/unread", { token: c.ann.token });
    assert.deepEqual([ok.status, ok.body.undelivered], [200, 0]);
    assert.equal((await c.call("GET", "/v1/unread", { token: c.ann.token, host: "evil.example.com" })).status, 421);
    // A client that does not trust the certificate cannot connect.
    await assert.rejects(new Promise((resolve, reject) => { const r = httpsRequest(new URL("/v1/unread", secure.url), { servername: "localhost" }, resolve); r.on("error", reject); r.end(); }), /self[- ]signed|unable to verify|certificate/i);
    // Plain HTTP to the TLS port gets nothing usable.
    await assert.rejects(new Promise((resolve, reject) => { const r = httpRequest(new URL("/v1/unread", secure.url.replace("https:", "http:")), { timeout: 1500 }, (res) => { res.resume(); res.on("end", resolve); }); r.on("error", reject); r.on("timeout", () => { r.destroy(new Error("timed out")); }); r.end(); }));
  });

  suite("the lifecycle gate applies to API calls: a sender that is not available is refused, and closing the listener ends waiting polls", async (c) => {
    c.states.set("agent:ann", "paused");
    const refused = await c.call("POST", "/v1/threads", { token: c.ann.token, body: { projectId: c.project, subject: "x", to: ["client:ext"], text: "x" } });
    assert.deepEqual([refused.status, /paused/.test(refused.body.error.message)], [503, true]);
    assert.ok(refused.headers["retry-after"] !== undefined);
    c.states.set("agent:ann", "available");
    const thread = (await c.call("POST", "/v1/threads", { token: c.ann.token, body: { projectId: c.project, subject: "close", to: ["client:ext"], text: "x" } })).body.threadId;
    const waiting = c.call("GET", `/v1/threads/${thread}/messages?after=1&wait=20000`, { token: c.ext.token }).then((r) => r.status, () => "closed");
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    await c.transport.close();
    const outcome = await waiting;
    assert.ok(Date.now() - started < 3000, "closing should end the wait quickly");
    assert.ok(outcome === "closed" || outcome === 200, String(outcome));
  });
}

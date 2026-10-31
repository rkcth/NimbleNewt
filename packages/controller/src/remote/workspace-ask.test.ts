import assert from "node:assert/strict";
import { after } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { WorkspaceCall } from "../workspace-ops/index.js";
import { PROTOCOL_HEADER, SESSION_HEADER } from "./protocol.js";
import { WorkspaceResponder } from "./responder.js";
import { remoteSuite, refuses, wireRefuses } from "./testing/suite.js";
import { rawRequest } from "./testing/world.js";

after(stopServer);

// Card H12m: a remote host carries the same workspace request over the authenticated transport and answers the same typed outcomes.
let n = 0;
const id = (): string => `wsr-${"abcdefghijklmnop"}${(++n + 4096).toString(8).split("").map((d) => "abcdefgh"[Number(d)]).join("").slice(-4)}`;
const call = (more: Partial<WorkspaceCall> = {}): WorkspaceCall => ({ requestId: id(), operation: "refresh", taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa", reason: "base moved", quietAttempts: [], ...more });

for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("a workspace request reaches the remote host over the transport and the host's typed answer comes back: done with a detail, and a refusal with its reason (card H12m)", async (c) => {
    const r1 = await c.host("r1");
    const seen: WorkspaceCall[] = [];
    const responder = new WorkspaceResponder({ client: r1.client, port: { run: async (x) => { seen.push(x); return x.operation === "quarantine" ? { ok: false, reason: "the checkout of that task is not on this host" } : { ok: true, summary: "the checkout moved", detail: { changed: true, base: "abc" } }; } } });
    const ask = (x: WorkspaceCall) => c.remote.askWorkspace(c.dispatcherPrincipal, "host:r1", x, { waitMs: 5000 });
    const first = call({ assignee: "agent:ann", quietAttempts: ["att-aaaaaaaaaaaaaaaaaaaa"] });
    const pending = ask(first);
    for (let i = 0; i < 100 && (await r1.client.workspaceRequests()).length === 0; i++) await new Promise((ok) => setTimeout(ok, 10));
    const listed = await r1.client.workspaceRequests();
    assert.deepEqual(listed.map((x) => x.requestId), [first.requestId]);
    const { expiresAt: deadline, ...bare } = listed[0]!;
    assert.ok(deadline !== undefined && Number.isFinite(Date.parse(deadline)));
    assert.deepEqual(bare, { ...first });
    responder.handle(listed);
    responder.handle(listed); // listed again before it was answered: not started twice
    assert.deepEqual(await pending, { ok: true, summary: "the checkout moved", detail: { changed: true, base: "abc" } });
    await responder.idle();
    assert.equal(seen.length, 1);
    assert.deepEqual({ ...seen[0], expiresAt: undefined }, { ...first, expiresAt: undefined }, "the host got exactly the request the controller made");
    assert.deepEqual(await r1.client.workspaceRequests(), [], "answered: no longer listed");
    // A refusal is carried as a refusal.
    const refused = ask(call({ operation: "quarantine" }));
    for (let i = 0; i < 100 && (await r1.client.workspaceRequests()).length === 0; i++) await new Promise((ok) => setTimeout(ok, 10));
    responder.handle(await r1.client.workspaceRequests());
    assert.deepEqual(await refused, { ok: false, reason: "the checkout of that task is not on this host" });
  });

  suite("only the owner and the dispatcher may ask; a request is checked before it is sent; a host that is not connected, or at its limit, is told nothing and the answer says so (card H12m)", async (c) => {
    const r1 = await c.host("r1");
    const idle = await c.host("idle", { connect: false });
    const ann = await c.agent("ann");
    const annPrincipal = await c.principals.authenticate((await c.principals.issueCredential(c.owner, ann.id)).token);
    await refuses("forbidden", () => c.remote.askWorkspace(annPrincipal, "host:r1", call(), { waitMs: 100 }));
    await refuses("forbidden", () => c.remote.askWorkspace(r1.principal, "host:r1", call(), { waitMs: 100 }));
    for (const bad of [{ requestId: "wsr-nope" }, { operation: "deploy" as never }, { taskId: "a/b" }, { reason: "" }, { quietAttempts: ["x"] }, { assignee: "../x" }] as Partial<WorkspaceCall>[]) {
      await refuses("invalid_command", () => c.remote.askWorkspace(c.dispatcherPrincipal, "host:r1", call(bad), { waitMs: 100 }));
    }
    await refuses("invalid_command", () => c.remote.askWorkspace(c.dispatcherPrincipal, "r1", call(), { waitMs: 100 }));
    const never = await c.remote.askWorkspace(c.dispatcherPrincipal, "host:idle", call(), { waitMs: 100 });
    assert.equal(never.ok, false);
    assert.match((never as { reason: string }).reason, /nothing was sent/);
    assert.equal(idle.client.session, undefined);
    // Four wait, a fifth is not sent.
    const waits = [0, 1, 2, 3].map(() => c.remote.askWorkspace(c.dispatcherPrincipal, "host:r1", call(), { waitMs: 2000 }).catch((e: Error) => e));
    // Wait until all four are really listed (a slow machine may take long), well inside their 2 s, before the fifth.
    for (let i = 0; i < 100 && (await r1.client.workspaceRequests()).length < 4; i++) await new Promise((ok) => setTimeout(ok, 10));
    const fifth = await c.remote.askWorkspace(c.dispatcherPrincipal, "host:r1", call(), { waitMs: 100 });
    assert.equal(fifth.ok, false);
    assert.match((fifth as { reason: string }).reason, /already has 4 workspace requests waiting/);
    assert.equal((await Promise.all(waits)).every((x) => x instanceof Error), true, "unanswered: the ask gives up and says the operation may have been done");
  });

  suite("only the host asked may see or answer a request; the first answer stands; a stale session, a malformed answer and a hostile request ID are refused (card H12m)", async (c) => {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    const x = call();
    const pending = c.remote.askWorkspace(c.dispatcherPrincipal, "host:r1", x, { waitMs: 5000 });
    for (let i = 0; i < 100 && (await r1.client.workspaceRequests()).length === 0; i++) await new Promise((ok) => setTimeout(ok, 10));
    assert.deepEqual(await r2.client.workspaceRequests(), [], "another host sees nothing");
    await wireRefuses("not_found", () => r2.client.answerWorkspace(x.requestId, { ok: true, summary: "forged" }), 404);
    await wireRefuses("not_found", () => r2.client.answerWorkspace(id(), { ok: true, summary: "nothing" }), 404);
    const url = c.transport.url;
    const withSession = (h: typeof r1) => ({ [SESSION_HEADER]: h.client.session!.sessionId, [PROTOCOL_HEADER]: String(h.client.session!.protocol), "idempotency-key": "k" });
    const post = (h: typeof r1, path: string, body: unknown) => rawRequest(url, "POST", path, { token: h.token, body, headers: withSession(h) });
    assert.equal((await post(r1, `/worker/session/workspace/${x.requestId}`, { outcome: { ok: true, summary: "x", extra: 1 } })).status, 400, "a field that is not part of an answer");
    assert.equal((await post(r1, `/worker/session/workspace/${x.requestId}`, { outcome: { ok: true, summary: "x".repeat(1001) } })).status, 400);
    assert.equal((await post(r1, `/worker/session/workspace/${x.requestId}`, { outcome: { ok: true, summary: "x", detail: { big: "y".repeat(5000) } } })).status, 400, "a detail over the limit");
    assert.equal((await post(r1, `/worker/session/workspace/${x.requestId}`, { outcome: { ok: false } })).status, 400);
    assert.equal((await post(r1, `/worker/session/workspace/${x.requestId}`, { outcome: { ok: false, reason: "no", summary: "mixed" } })).status, 400);
    assert.equal((await post(r1, `/worker/session/workspace/${x.requestId}`, { outcome: { ok: true, summary: "x" }, requestId: "wsr-other" })).status, 400);
    assert.equal((await post(r1, "/worker/session/workspace/..%2F..%2Fetc", { outcome: { ok: true, summary: "x" } })).status, 404);
    assert.equal((await rawRequest(url, "POST", `/worker/session/workspace/${x.requestId}`, { token: r1.token, body: { outcome: { ok: true, summary: "x" } }, headers: { [SESSION_HEADER]: r1.client.session!.sessionId, [PROTOCOL_HEADER]: "1" } })).status, 400, "a change needs an idempotency key");
    assert.equal((await rawRequest(url, "GET", "/worker/session/workspace?x=1", { token: r1.token, headers: withSession(r1) })).status, 400);
    // A session that is not the host's current one is fenced.
    const stale = r1.client.session!;
    await r1.client.connect({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: ["garden"] } as never, "again");
    assert.equal((await rawRequest(url, "POST", `/worker/session/workspace/${x.requestId}`, { token: r1.token, body: { outcome: { ok: true, summary: "late" } }, headers: { [SESSION_HEADER]: stale.sessionId, [PROTOCOL_HEADER]: "1", "idempotency-key": "k2" } })).status, 409);
    // The right host, once: it stands; the same again is a repeat; another answer is a conflict.
    await r1.client.answerWorkspace(x.requestId, { ok: true, summary: "the real answer", detail: { n: 1 } });
    assert.deepEqual(await pending, { ok: true, summary: "the real answer", detail: { n: 1 } });
    await r1.client.answerWorkspace(x.requestId, { ok: true, summary: "the real answer", detail: { n: 1 } });
    await wireRefuses("command_conflict", () => r1.client.answerWorkspace(x.requestId, { ok: true, summary: "another" }), 409);
    assert.deepEqual(await c.remote.askWorkspace(c.dispatcherPrincipal, "host:r1", x, { waitMs: 100 }), { ok: true, summary: "the real answer", detail: { n: 1 } }, "the same request asked again gets the same answer and is not sent again");
  });

  suite("a host that is slow leaves the request withdrawn: it is not started later, and an answer that comes after is accepted and only a repeat of the same request would see it (card H12m)", async (c) => {
    const r1 = await c.host("r1");
    const x = call();
    await refuses("unavailable", () => c.remote.askWorkspace(c.dispatcherPrincipal, "host:r1", x, { waitMs: 80 }), (e) => assert.match(e.message, /may or may not have been carried out/));
    assert.deepEqual(await r1.client.workspaceRequests(), [], "withdrawn: a host that comes back does not start it");
    await r1.client.answerWorkspace(x.requestId, { ok: true, summary: "too late" });
    assert.deepEqual(await c.remote.askWorkspace(c.dispatcherPrincipal, "host:r1", x, { waitMs: 50 }), { ok: true, summary: "too late" }, "kept for a repeat of the same request, which the workspace service never makes (it records the first as failed)");
  });

}

// Review fixes for H12m (2026-10-31).
for (const backend of backends) {
  const suite = remoteSuite(backend);

  suite("a request that timed out is listed as withdrawn, carries its deadline, and a repeat of its ID fails fast; a responder drops a queued request that was withdrawn or expired instead of starting it (review fix 1, 2)", async (c) => {
    const r1 = await c.host("r1");
    const a = call(); const b = call({ operation: "integration" });
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((ok) => { release = ok; });
    const responder = new WorkspaceResponder({ client: r1.client, port: { run: async (x) => { started.push(x.requestId); if (x.requestId === a.requestId) await gate; return { ok: true, summary: "done" }; } } });
    const askA = c.remote.askWorkspace(c.dispatcherPrincipal, "host:r1", a, { waitMs: 5000 });
    const askB = c.remote.askWorkspace(c.dispatcherPrincipal, "host:r1", b, { waitMs: 1500 });
    const outcomeB = askB.then(() => "answered", (e: Error) => e.message);
    for (let i = 0; i < 100 && (await r1.client.workspaceRequests()).length < 2; i++) await new Promise((ok) => setTimeout(ok, 10));
    const listed = await r1.client.workspaceRequests();
    assert.equal(listed.length, 2, await Promise.race([outcomeB, new Promise((ok) => setTimeout(() => ok('B pending'), 50))]) as string);
    assert.ok(listed.every((x) => typeof x.expiresAt === "string" && Number.isFinite(Date.parse(x.expiresAt))), "each request carries the time the controller stops waiting");
    responder.handle(listed); // A starts and holds the queue; B waits behind it.
    assert.match(await outcomeB, /may or may not have been carried out/, "B timed out while A was running");
    const list = await r1.client.workspaceList();
    assert.deepEqual(list.withdrawn, [b.requestId]);
    assert.deepEqual(list.requests.map((x) => x.requestId), [a.requestId], "only A is still listed");
    responder.handle(list.requests, list.withdrawn);
    release(); await responder.idle();
    assert.deepEqual(started, [a.requestId], "B was not started on the host after the controller released the freeze");
    // A repeat of B's ID is refused at once with a clear error, not joined to a dead ask.
    await refuses("unavailable", () => c.remote.askWorkspace(c.dispatcherPrincipal, "host:r1", b, { waitMs: 5000 }), (e) => assert.match(e.message, /timed out earlier and was withdrawn/));
    await askA;
  });

  suite("a responder does not start a request whose deadline passed while it waited, even before the controller lists it as withdrawn (review fix 1)", async (c) => {
    const r1 = await c.host("r1");
    const ran: string[] = [];
    let now = 1_000;
    const responder = new WorkspaceResponder({ client: r1.client, now: () => now, port: { run: async (x) => { ran.push(x.requestId); now += 10_000; return { ok: true, summary: "ok" }; } } });
    const first = call(); const second = call();
    responder.handle([{ ...first, quietAttempts: [] }, { ...second, quietAttempts: [], expiresAt: new Date(0).toISOString() }]);
    await responder.idle();
    assert.deepEqual(ran, [first.requestId], "the expired one never reached the port");
  });
}

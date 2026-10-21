import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { CONVERSATION_LIMITS, ConversationService, type Availability } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-21T10:00:00.000Z");
const seconds = (s: number): void => { now += s * 1000; };
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    conv: ConversationService; owner: Principal; a: string; b: string;
    ann: Principal; bob: Principal; carol: Principal; eve: Principal; ext: Principal;
    principals: PrincipalService; grants: GrantService;
    states: Map<string, Availability>;
    reopen(): ConversationService;
    revokeAll(id: string): Promise<void>;
    login(id: string): Promise<Principal>;
    enroll(kind: "agent" | "client", name: string, grants: Grant[]): Promise<Principal>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-21T10:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const enroll = async (kind: "agent" | "client", nm: string, g: Grant[]) => {
          await principals.enroll(owner, { commandId: cid("e"), kind, name: nm, grants: g });
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${nm}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const full = (p: string): Grant[] => ["conversation.start", "conversation.send", "conversation.receive"].map((action) => ({ action, project: p }));
        const ann = await enroll("agent", "ann", full(a));
        const bob = await enroll("agent", "bob", full(a));
        const carol = await enroll("agent", "carol", [{ action: "conversation.receive", project: a }, { action: "conversation.send", project: a }]);
        const eve = await enroll("agent", "eve", []);
        const ext = await enroll("client", "ext", full(a));
        const states = new Map<string, Availability>();
        const make = () => ConversationService.withEpoch(world.storage, projects.epoch, { ...options, availability: async (id) => states.get(id) ?? "available" });
        await body({ revokeAll: async (id) => { const f = await world.storage.getAggregate({ kind: "principal", id }); await principals.setGrants(owner, { commandId: cid("rv"), principalId: id, expectedRevision: f!.revision, grants: [] }); }, conv: make(), owner, a, b, ann, bob, carol, eve, ext, principals, grants, states, reopen: make, login: async (id) => principals.authenticate((await principals.issueCredential(owner, id)).token), enroll });
      } finally { await world.close(); }
    });
  const say = (c: Ctx, who: Principal, threadId: string, text: string, extra: Record<string, unknown> = {}) => c.conv.send(who, { commandId: cid("m"), threadId, text, ...extra });

  suite("a client may hold only conversation actions, however the grant is made", async (c) => {
    for (const bad of [[{ action: "task.read", project: c.a }], [{ action: "*", project: c.a }], [{ action: "conversation.*", project: c.a }], [{ action: "desk.write", project: "*" }]]) {
      await refuses("invalid_command", () => c.principals.enroll(c.owner, { commandId: cid("e"), kind: "client", name: `bad${n}`, grants: bad }), (e) => assert.match(e.message, /only conversation actions/));
    }
    const found = await c.enroll("client", "ok", []);
    const revision = (await c.principals.authenticate((await c.principals.issueCredential(c.owner, "client:ok")).token)).id;
    void found; void revision;
    await refuses("invalid_command", () => c.grants.grant(c.owner, { commandId: cid("g"), grantee: "client:ok", action: "task.read", project: c.a, source: "direct", basis: "test" }), (e) => assert.match(e.message, /only conversation actions/));
    await refuses("invalid_command", () => c.grants.grant(c.owner, { commandId: cid("g"), grantee: "client:ok", action: "*", project: c.a, source: "direct", basis: "test" }));
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "client:ok", action: "conversation.send", project: c.a, source: "direct", basis: "test" });
    // An agent is not limited this way.
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:eve", action: "task.read", project: c.a, source: "direct", basis: "test" });
  });

  suite("either side starts a thread and they carry on several turns; each reads from its own cursor and sees each turn once", async (c) => {
    const started = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "build plan", to: ["agent:bob"], kind: "question", text: "can you take the build step?" });
    assert.deepEqual((await c.conv.unread(c.bob)).threads, [{ threadId: started.threadId, count: 1 }]);
    const first = (await c.conv.read(c.bob, { threadId: started.threadId }))!;
    assert.deepEqual([first.items.length, first.items[0]!.seq, first.items[0]!.sender, first.items[0]!.trust, first.items[0]!.delivery, first.lastSeq, first.deliveredSeq], [1, 1, "agent:ann", "untrusted-content", "accepted", 1, 0]);
    // Reading does not confirm delivery: asking again gives the same.
    assert.equal((await c.conv.read(c.bob, { threadId: started.threadId }))!.items.length, 1);
    assert.deepEqual(await c.conv.acknowledge(c.bob, { commandId: cid("k"), threadId: started.threadId, upToSeq: 1 }), { deliveredSeq: 1, more: false });
    assert.equal((await c.conv.read(c.bob, { threadId: started.threadId }))!.items.length, 0);
    assert.equal((await c.conv.unread(c.bob)).undelivered, 0);
    assert.equal((await c.conv.read(c.bob, { threadId: started.threadId, afterSeq: 0 }))!.items[0]!.delivery, "delivered");
    // A reply answers the question.
    const reply = await say(c, c.bob, started.threadId, "yes, on it", { kind: "answer", replyTo: started.messageId });
    assert.equal((await c.conv.read(c.bob, { threadId: started.threadId, afterSeq: 0 }))!.items[0]!.delivery, "answered");
    // Ann's own first message is in the listing too (her cursor only moves when she confirms something addressed to her).
    assert.deepEqual((await c.conv.read(c.ann, { threadId: started.threadId, afterSeq: 1 }))!.items.map((m) => m.seq), [2]);
    assert.equal(reply.messageId, `${started.threadId}.00000002`);
    // The other side starts the next one, with an outside client in the same thread.
    const theirs = await c.conv.start(c.ext, { commandId: cid("s"), projectId: c.a, subject: "from outside", to: ["agent:ann"], text: "hello from a client", claimedSender: "the build service" });
    await c.conv.acknowledge(c.ann, { commandId: cid("k"), threadId: theirs.threadId, upToSeq: 1 });
    await say(c, c.ann, theirs.threadId, "hello back", { replyTo: theirs.messageId });
    await say(c, c.ext, theirs.threadId, "one more thing", { kind: "question" });
    const seen = (await c.conv.read(c.ext, { threadId: theirs.threadId, afterSeq: 0 }))!;
    assert.deepEqual(seen.items.map((m) => [m.seq, m.sender]), [[1, "client:ext"], [2, "agent:ann"], [3, "client:ext"]]);
    assert.equal(seen.items[0]!.claimedSender, "the build service");
  });

  suite("the same command is one message however often it is sent; a reconnect asks again from its cursor and misses nothing", async (c) => {
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "retries", to: ["agent:bob"], text: "first" });
    const commandId = cid("dup");
    const one = await c.conv.send(c.ann, { commandId, threadId: t.threadId, text: "second" });
    const two = await c.conv.send(c.ann, { commandId, threadId: t.threadId, text: "second" });
    assert.deepEqual([one.replayed, two.replayed, one.messageId === two.messageId], [false, true, true]);
    await refuses("command_conflict", () => c.conv.send(c.ann, { commandId, threadId: t.threadId, text: "something else" }));
    const sameStart = await c.conv.start(c.ann, { commandId: "fixed-start", projectId: c.a, subject: "once", to: ["agent:bob"], text: "x" });
    assert.equal((await c.conv.start(c.ann, { commandId: "fixed-start", projectId: c.a, subject: "once", to: ["agent:bob"], text: "x" })).threadId, sameStart.threadId);
    // Bob reads two, confirms one, "disconnects", and a new instance of the service picks up at the cursor.
    await c.conv.acknowledge(c.bob, { commandId: cid("k"), threadId: t.threadId, upToSeq: 1 });
    const later = c.reopen();
    const resumed = (await later.read(c.bob, { threadId: t.threadId }))!;
    assert.deepEqual([resumed.items.map((m) => m.seq), resumed.deliveredSeq], [[2], 1]);
    await later.acknowledge(c.bob, { commandId: cid("k"), threadId: t.threadId, upToSeq: 2 });
    assert.deepEqual((await later.read(c.bob, { threadId: t.threadId }))!.items, []);
    assert.equal((await later.read(c.bob, { threadId: t.threadId, afterSeq: 0 }))!.items.length, 2);
    // The cursor only moves forward.
    assert.equal((await later.acknowledge(c.bob, { commandId: cid("k"), threadId: t.threadId, upToSeq: 1 })).deliveredSeq, 2);
    await refuses("invalid_command", () => later.acknowledge(c.bob, { commandId: cid("k"), threadId: t.threadId, upToSeq: 99 }));
  });

  suite("the sender is the authenticated principal; a claim about who a client speaks for is kept beside it and grants nothing", async (c) => {
    const t = await c.conv.start(c.ext, { commandId: cid("s"), projectId: c.a, subject: "claims", to: ["agent:ann"], text: "I am speaking for ann", claimedSender: "agent:ann" });
    const m = (await c.conv.read(c.ann, { threadId: t.threadId }))!.items[0]!;
    assert.deepEqual([m.sender, m.senderKind, m.claimedSender], ["client:ext", "client", "agent:ann"]);
    await refuses("invalid_command", () => say(c, c.bob, t.threadId, "x", { claimedSender: "agent:ann" }), () => undefined);
    await refuses("invalid_command", () => c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "x", to: ["agent:bob"], text: "x", claimedSender: "agent:bob" }), (e) => assert.match(e.message, /speaks as itself/));
    // Naming ann in a claim does not make ext a participant in ann's other threads.
    const other = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "private", to: ["agent:bob"], text: "secret plans" });
    assert.equal(await c.conv.read(c.ext, { threadId: other.threadId }), undefined);
    await refuses("forbidden", () => say(c, c.ext, other.threadId, "let me in", { claimedSender: "agent:ann" }));
  });

  suite("the sender needs the grant for the project, the recipient must be one it may address, and an unknown recipient reads like an unreachable one", async (c) => {
    await refuses("forbidden", () => c.conv.start(c.eve, { commandId: cid("s"), projectId: c.a, subject: "x", to: ["agent:bob"], text: "x" }));
    await refuses("forbidden", () => c.conv.start(c.ann, { commandId: cid("s"), projectId: c.b, subject: "x", to: ["agent:bob"], text: "x" }));
    const reachable = (id: string) => c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "x", to: [id], text: "x" });
    await refuses("forbidden", () => reachable("agent:eve"), (e) => assert.match(e.message, /cannot be addressed/));
    await refuses("forbidden", () => reachable("agent:nobody"), (e) => assert.match(e.message, /cannot be addressed/));
    await refuses("forbidden", () => reachable("client:nobody"), (e) => assert.match(e.message, /cannot be addressed/));
    await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "to the owner", to: ["owner:rob"], text: "a question for you", kind: "question" });
    assert.equal((await c.conv.unread(c.owner)).undelivered, 1);
    await refuses("invalid_command", () => c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "x", to: ["agent:ann"], text: "x" }), (e) => assert.match(e.message, /sender/));
    for (const to of [[], Array.from({ length: 21 }, (_, i) => `agent:a${i}`), ["agent:bob", "agent:bob"], ["bob"], "agent:bob"]) {
      await refuses("invalid_command", () => c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "x", to: to as never, text: "x" }));
    }
    // Addressing someone new in a thread adds them; only participants can read it.
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "grow", to: ["agent:bob"], text: "hi" });
    assert.equal(await c.conv.read(c.carol, { threadId: t.threadId }), undefined);
    await say(c, c.ann, t.threadId, "adding carol", { to: ["agent:carol"] });
    // Carol sees the message that added her, not the earlier one that was for bob.
    assert.deepEqual((await c.conv.read(c.carol, { threadId: t.threadId, afterSeq: 0 }))!.items.map((m) => m.text), ["adding carol"]);
    assert.deepEqual((await c.conv.thread(c.carol, t.threadId))!.participants, ["agent:ann", "agent:bob", "agent:carol"]);
    assert.equal(await c.conv.thread(c.eve, t.threadId), undefined);
    assert.equal((await c.conv.read(c.owner, { threadId: t.threadId, afterSeq: 0 }))!.items.length, 2);
    await refuses("forbidden", () => say(c, c.eve, t.threadId, "x"));
    // Bob has no right to send in this project beyond what he was given; carol may send but was never granted start.
    await refuses("forbidden", () => c.conv.start(c.carol, { commandId: cid("s"), projectId: c.a, subject: "x", to: ["agent:bob"], text: "x" }));
  });

  suite("an action request is only a request, urgent needs its own grant, and a client cannot send a notice", async (c) => {
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "work", to: ["agent:bob"], text: "hi" });
    await refuses("forbidden", () => say(c, c.ann, t.threadId, "please deploy", { kind: "action-request" }), (e) => assert.match(e.message, /action requests/));
    await refuses("forbidden", () => say(c, c.ann, t.threadId, "now!", { priority: "urgent" }), (e) => assert.match(e.message, /urgent/));
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "conversation.request-action", project: c.a, source: "direct", basis: "test" });
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "conversation.urgent", project: c.a, source: "direct", basis: "test" });
    const ann = await c.login("agent:ann");
    const req = await say(c, ann, t.threadId, "please deploy", { kind: "action-request", priority: "urgent" });
    const m = (await c.conv.read(c.bob, { threadId: t.threadId, afterSeq: 1 }))!.items[0]!;
    assert.deepEqual([m.id, m.kind, m.priority, m.needsAuthorization], [req.messageId, "action-request", "urgent", true]);
    await refuses("invalid_command", () => c.conv.start(c.ext, { commandId: cid("s"), projectId: c.a, subject: "x", to: ["agent:ann"], text: "x", kind: "notice" }), (e) => assert.match(e.message, /client cannot send a notice/));
    await refuses("invalid_command", () => say(c, c.ann, t.threadId, "x", { kind: "shout" }));
    await refuses("invalid_command", () => say(c, c.ann, t.threadId, "x", { priority: "now" }));
  });

  suite("content is untrusted text: credentials are replaced and flagged, and it is bounded", async (c) => {
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "secrets", to: ["agent:bob"], text: "use Bearer abcdefghijklmnopqrstuvwxyz0123456789 to log in" });
    const m = (await c.conv.read(c.bob, { threadId: t.threadId }))!.items[0]!;
    assert.deepEqual([m.redacted, m.text.includes("abcdefghijklmnopqrstuvwxyz")], [true, false]);
    for (const bad of ["", "x".repeat(CONVERSATION_LIMITS.text + 1), "bad\u0000text"]) await refuses("invalid_command", () => say(c, c.ann, t.threadId, bad));
    await refuses("invalid_command", () => c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "x".repeat(201), to: ["agent:bob"], text: "x" }));
    await refuses("invalid_command", () => c.conv.read(c.bob, { threadId: t.threadId, limit: 0 }));
    await refuses("invalid_command", () => c.conv.read(c.bob, { threadId: "nope" }));
    await refuses("invalid_command", () => say(c, c.ann, t.threadId, "x", { replyTo: "thr-aaaaaaaaaaaaaaaaaaaa.00000001" }), (e) => assert.match(e.message, /another thread/));
  });

  suite("a sender is limited per minute and a recipient's queue is bounded, so no one can bury another", async (c) => {
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "flood", to: ["agent:bob"], text: "0" });
    for (let i = 1; i < CONVERSATION_LIMITS.perMinute; i++) await say(c, c.ann, t.threadId, `m${i}`);
    await refuses("unavailable", () => say(c, c.ann, t.threadId, "too many"), (e) => assert.match(e.message, /slow down/));
    seconds(61);
    await say(c, c.ann, t.threadId, "next window");
    // Bob's queue: 31 waiting now; keep adding (turn the clock so the rate is not the limit) until it is full.
    let queued = (await c.conv.unread(c.bob)).undelivered;
    assert.equal(queued, CONVERSATION_LIMITS.perMinute + 1);
    let sent = 0;
    while (queued < CONVERSATION_LIMITS.queue) {
      if (sent % 20 === 0) seconds(61);
      await c.conv.start(c.ext, { commandId: cid("s"), projectId: c.a, subject: `more ${sent}`, to: ["agent:bob"], text: `q${sent}` });
      sent += 1; queued += 1;
    }
    seconds(61);
    await refuses("unavailable", () => c.conv.start(c.ext, { commandId: cid("s"), projectId: c.a, subject: "one too many", to: ["agent:bob"], text: "x" }), (e) => assert.match(e.message, /already has 100 messages waiting/));
    // Confirming receipt makes room.
    await c.conv.acknowledge(c.bob, { commandId: cid("k"), threadId: t.threadId, upToSeq: 31 });
    await c.conv.start(c.ext, { commandId: cid("s"), projectId: c.a, subject: "now there is room", to: ["agent:bob"], text: "x" });
    assert.equal((await c.conv.unread(c.bob)).undelivered, CONVERSATION_LIMITS.queue - 31 + 1);
  });

  suite("a chain of replies and a run of messages without the owner are bounded; the owner speaking resets the run", async (c) => {
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "loop", to: ["agent:bob"], text: "ping" });
    let last = t.messageId;
    let sender = c.bob;
    for (let depth = 1; depth <= CONVERSATION_LIMITS.depth; depth++) {
      if (depth % 10 === 0) seconds(61);
      last = (await say(c, sender, t.threadId, `pong ${depth}`, { replyTo: last })).messageId;
      sender = sender === c.bob ? c.ann : c.bob;
    }
    seconds(61);
    await refuses("unavailable", () => say(c, sender, t.threadId, "one more", { replyTo: last }), (e) => assert.match(e.message, /looks like a loop/));
    // Messages that are not replies are not a chain, but a long run without the owner is still stopped.
    const run = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "chatter", to: ["agent:bob"], text: "1" });
    for (let i = 2; i <= CONVERSATION_LIMITS.turnsWithoutOwner; i++) { if (i % 25 === 0) seconds(61); await say(c, c.ann, run.threadId, `${i}`); }
    seconds(61);
    await refuses("unavailable", () => say(c, c.ann, run.threadId, "41"), (e) => assert.match(e.message, /without the owner/));
    await c.conv.send(c.owner, { commandId: cid("m"), threadId: run.threadId, text: "I am here", to: ["agent:ann", "agent:bob"] });
    await say(c, c.ann, run.threadId, "thanks");
  });

  suite("a recipient that is paused, suspended or stopped has its messages accepted and kept as queued; a sender that is not available cannot send; nothing is resumed", async (c) => {
    c.states.set("agent:bob", "paused");
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "hold", to: ["agent:bob"], text: "are you there?" });
    const m = (await c.conv.read(c.bob, { threadId: t.threadId }))!.items[0]!;
    assert.deepEqual([m.delivery, m.availability], ["accepted", "queued"]);
    // A paused agent can read and confirm what is queued but cannot start work of its own.
    await c.conv.acknowledge(c.bob, { commandId: cid("k"), threadId: t.threadId, upToSeq: 1 });
    await refuses("unavailable", () => say(c, c.bob, t.threadId, "reply", { replyTo: t.messageId }), (e) => assert.match(e.message, /paused/));
    for (const state of ["suspended", "stopped"] as const) {
      c.states.set("agent:bob", state);
      await refuses("unavailable", () => c.conv.start(c.bob, { commandId: cid("s"), projectId: c.a, subject: "x", to: ["agent:ann"], text: "x" }), (e) => assert.match(e.message, new RegExp(state)));
      assert.equal((await c.conv.read(c.bob, { threadId: t.threadId, afterSeq: 0 }))!.items.length, 1);
    }
    c.states.set("agent:bob", "available");
    await say(c, c.bob, t.threadId, "back", { replyTo: t.messageId });
    c.states.set("agent:ann", "stopped");
    await say(c, c.owner, t.threadId, "owner note", { to: ["agent:ann"] });
    assert.equal((await c.conv.read(c.ann, { threadId: t.threadId, afterSeq: 1 }))!.items.find((x) => x.sender === "owner:rob")!.availability, "queued");
  });

  suite("a message is handled only after it is delivered; a reply marks it answered, which is not the same as done", async (c) => {
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "states", to: ["agent:bob"], text: "do it" });
    await refuses("invalid_command", () => c.conv.markHandled(c.bob, { commandId: cid("h"), messageId: t.messageId }), (e) => assert.match(e.message, /acknowledge it first/));
    await refuses("forbidden", () => c.conv.markHandled(c.carol, { commandId: cid("h"), messageId: t.messageId }));
    await c.conv.acknowledge(c.bob, { commandId: cid("k"), threadId: t.threadId, upToSeq: 1 });
    await c.conv.markHandled(c.bob, { commandId: cid("h"), messageId: t.messageId });
    await c.conv.markHandled(c.bob, { commandId: cid("h"), messageId: t.messageId });
    const state = async () => (await c.conv.read(c.bob, { threadId: t.threadId, afterSeq: 0 }))!.items[0]!.delivery;
    assert.equal(await state(), "handled");
    await say(c, c.bob, t.threadId, "done", { replyTo: t.messageId });
    assert.equal(await state(), "answered");
    // The sender's own copy of its message is not a delivery to it.
    assert.equal((await c.conv.read(c.ann, { threadId: t.threadId, afterSeq: 0 }))!.items[0]!.delivery, undefined);
  });

  suite("answering a message without confirming it first also takes it off the waiting count, so replies cannot fill a queue for good", async (c) => {
    for (let i = 0; i < 3; i++) {
      const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: `q${i}`, to: ["agent:bob"], kind: "question", text: "?" });
      assert.equal((await c.conv.unread(c.bob)).undelivered, 1);
      await say(c, c.bob, t.threadId, "answer", { kind: "answer", replyTo: t.messageId });
      assert.deepEqual(await c.conv.unread(c.bob), { undelivered: 0, threads: [] });
      // Confirming afterwards changes nothing further.
      await c.conv.acknowledge(c.bob, { commandId: cid("k"), threadId: t.threadId, upToSeq: 1 });
      assert.equal((await c.conv.unread(c.bob)).undelivered, 0);
    }
  });

  suite("a participant sees the messages it sent and the ones addressed to it, not the rest of the thread or what came before it joined; the owner sees everything", async (c) => {
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "shared", to: ["agent:bob"], text: "early, for bob" });
    await say(c, c.ann, t.threadId, "adding carol", { to: ["agent:carol"] });
    await say(c, c.ann, t.threadId, "secret for bob only", { to: ["agent:bob"] });
    await say(c, c.ann, t.threadId, "for everyone");
    const seen = async (who: Principal) => (await c.conv.read(who, { threadId: t.threadId, afterSeq: 0 }))!.items.map((m) => m.text);
    assert.deepEqual(await seen(c.carol), ["adding carol", "for everyone"]);
    assert.deepEqual(await seen(c.bob), ["early, for bob", "secret for bob only", "for everyone"]);
    assert.equal((await seen(c.ann)).length, 4);
    assert.equal((await seen(c.owner)).length, 4);
    // A reply to a message the replier cannot see reads like a reply to nothing.
    await refuses("invalid_command", () => say(c, c.carol, t.threadId, "what secret?", { replyTo: `${t.threadId}.00000003` }), (e) => assert.match(e.message, /is not a message/));
    // Paging through what is visible still fills a page when hidden messages sit in between.
    const first = (await c.conv.read(c.carol, { threadId: t.threadId, afterSeq: 0, limit: 1 }))!.items;
    assert.deepEqual(first.map((m) => m.seq), [2]);
    assert.deepEqual((await c.conv.read(c.carol, { threadId: t.threadId, afterSeq: 2, limit: 1 }))!.items.map((m) => m.seq), [4]);
  });

  suite("taking a participant's conversation grants away ends its access at once, to reading and confirming as well as sending", async (c) => {
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "revoke", to: ["client:ext"], text: "hello" });
    assert.equal((await c.conv.read(c.ext, { threadId: t.threadId }))!.items.length, 1);
    await c.revokeAll("client:ext");
    const ext = await c.login("client:ext");
    assert.equal(await c.conv.read(ext, { threadId: t.threadId }), undefined);
    assert.equal(await c.conv.thread(ext, t.threadId), undefined);
    assert.deepEqual((await c.conv.threads(ext)).items, []);
    await refuses("forbidden", () => c.conv.acknowledge(ext, { commandId: cid("k"), threadId: t.threadId, upToSeq: 1 }));
    await refuses("forbidden", () => say(c, ext, t.threadId, "still here?"));
    // The thread and its history are intact for everyone else.
    assert.equal((await c.conv.read(c.owner, { threadId: t.threadId, afterSeq: 0 }))!.items.length, 1);
  });

  suite("a send to a thread fails if any addressee's queue is full, and a command ID reused for a different message fails at once", async (c) => {
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "pressure", to: ["agent:bob", "agent:carol"], text: "0" });
    // Fill bob's queue from other threads.
    let queued = (await c.conv.unread(c.bob)).undelivered;
    for (let i = 0; queued < CONVERSATION_LIMITS.queue; i++, queued++) { if (i % 20 === 0) seconds(61); await c.conv.start(c.ext, { commandId: cid("s"), projectId: c.a, subject: `f${i}`, to: ["agent:bob"], text: "x" }); }
    seconds(61);
    await refuses("unavailable", () => say(c, c.ann, t.threadId, "to everyone"), (e) => assert.match(e.message, /agent:bob already has/));
    // Naming only carol still works.
    await say(c, c.ann, t.threadId, "only carol", { to: ["agent:carol"] });
    const commandId = cid("reuse");
    await c.conv.send(c.ann, { commandId, threadId: t.threadId, text: "one", to: ["agent:carol"] });
    const started = Date.now();
    await refuses("command_conflict", () => c.conv.send(c.ann, { commandId, threadId: t.threadId, text: "two", to: ["agent:carol"] }));
    assert.ok(Date.now() - started < 1500, "a reused command ID should fail at once, not after retries");
  });

  suite("closing a thread is for its starter or the owner and stops further sends", async (c) => {
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "temp", to: ["agent:bob"], text: "x" });
    const v = (await c.conv.thread(c.ann, t.threadId))!;
    await refuses("forbidden", () => c.conv.close(c.bob, { commandId: cid("c"), threadId: t.threadId, expectedRevision: v.revision }));
    await refuses("stale_revision", () => c.conv.close(c.ann, { commandId: cid("c"), threadId: t.threadId, expectedRevision: v.revision + 5 }));
    await c.conv.close(c.ann, { commandId: cid("c"), threadId: t.threadId, expectedRevision: v.revision });
    assert.equal((await c.conv.thread(c.bob, t.threadId))!.state, "closed");
    await refuses("invalid_command", () => say(c, c.bob, t.threadId, "late"), (e) => assert.match(e.message, /closed/));
    assert.equal((await c.conv.read(c.bob, { threadId: t.threadId }))!.items.length, 1);
  });

  suite("senders at the same moment get distinct, gapless sequence numbers and every inbox count is right", async (c) => {
    const t = await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "race", to: ["agent:bob", "agent:carol"], text: "0" });
    const results = await Promise.allSettled([
      ...Array.from({ length: 6 }, (_, i) => say(c, c.ann, t.threadId, `a${i}`)),
      ...Array.from({ length: 6 }, (_, i) => say(c, c.bob, t.threadId, `b${i}`)),
      ...Array.from({ length: 4 }, (_, i) => say(c, c.carol, t.threadId, `c${i}`)),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    assert.ok(ok >= 10, `only ${ok} of 16 sends succeeded: ${results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)).slice(0, 3).join(" | ")}`);
    const all = (await c.conv.read(c.owner, { threadId: t.threadId, afterSeq: 0, limit: 100 }))!;
    assert.deepEqual(all.items.map((m) => m.seq), Array.from({ length: ok + 1 }, (_, i) => i + 1));
    assert.equal(all.lastSeq, ok + 1);
    for (const who of [c.ann, c.bob, c.carol]) {
      const expected = all.items.filter((m) => m.to.includes(who.id)).length;
      assert.equal((await c.conv.unread(who)).undelivered, expected, who.id);
      await c.conv.acknowledge(who, { commandId: cid("k"), threadId: t.threadId, upToSeq: ok + 1 });
      assert.equal((await c.conv.unread(who)).undelivered, 0, who.id);
    }
  });

  suite("threads are listed for their participants only, in pages", async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: `t${i}`, to: ["agent:bob"], text: "x" })).threadId);
    await c.conv.start(c.ann, { commandId: cid("s"), projectId: c.a, subject: "not bob's", to: ["agent:carol"], text: "x" });
    const first = await c.conv.threads(c.bob, { limit: 2 });
    assert.equal(first.items.length, 2);
    const second = await c.conv.threads(c.bob, { limit: 10, afterId: first.next! });
    assert.deepEqual([...first.items, ...second.items].map((t) => t.id).sort(), [...ids].sort());
    assert.equal((await c.conv.threads(c.owner, { limit: 100 })).items.length, 6);
    assert.deepEqual((await c.conv.threads(c.eve)).items, []);
  });
}

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Outcome } from "./index.js";
import { cid, openWorld, type World } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string, extra: Record<string, unknown> = {}) => ({ kind: "command", op, args, evidence, basis: "owner", ...extra });

for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      const w = await openWorld(backend, script);
      try { await body(w, script); } finally { await w.close(); }
    });
  const only = (outcomes: readonly Outcome[]): Outcome => { assert.equal(outcomes.length, 1); return outcomes[0]!; };

  suite("a decision the owner states in chat is recorded from that turn with their own words; the version it is based on is read, not said; a correction supersedes it (card C08b)", async (w, script) => {
    const a = await w.project("A");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const text = "We will use PostgreSQL for the reporting store. That is decided.";
    script[text] = [cmd("decision.record", { category: "decision", topic: "reporting store", statement: "use PostgreSQL for the reporting store", wording: "We will use PostgreSQL for the reporting store" }, "We will use PostgreSQL for the reporting store")];
    const r = await chat.submit(w.ownerToken, { messageId: "m-d1", text });
    const o = only(r.outcomes);
    assert.deepEqual([o.status, o.op, o.message], ["applied", "decision.record", undefined]);
    const first = await w.decisions.authoritative(w.owner, { projectId: a, topic: "reporting store" });
    assert.equal(first?.status, "decided");
    if (first?.status !== "decided") return;
    assert.deepEqual([first.decision.source.channel, (first.decision.source as { turnId?: string }).turnId], ["chat", r.turnId]);
    assert.equal(first.decision.version, 1);
    // A correction says the new choice; the chat reads that version 1 stands, so the old decision is superseded and not disputed.
    const fix = "Actually we will use SQLite for the reporting store, not PostgreSQL.";
    script[fix] = [cmd("decision.record", { category: "decision", topic: "reporting store", statement: "use SQLite for the reporting store", wording: "we will use SQLite for the reporting store" }, "we will use SQLite for the reporting store")];
    const r2 = await chat.submit(w.ownerToken, { messageId: "m-d2", text: fix });
    assert.equal(only(r2.outcomes).status, "applied");
    const second = await w.decisions.authoritative(w.owner, { projectId: a, topic: "reporting store" });
    assert.equal(second?.status, "decided");
    assert.equal(second?.status === "decided" ? second.decision.version : 0, 2);
    assert.equal((await w.decisions.history(w.owner, { projectId: a, topic: "reporting store" }))?.length, 2);
  });

  suite("words the owner did not say are refused as a decision, and the interpreter cannot name the source turn (card C08b)", async (w, script) => {
    const a = await w.project("A");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const text = "Maybe we should use Redis for the cache?";
    script[text] = [cmd("decision.record", { category: "decision", topic: "cache", statement: "use Redis for the cache", wording: "use Redis for the cache" }, "use Redis for the cache")];
    const o = only((await chat.submit(w.ownerToken, { messageId: "m-d3", text })).outcomes);
    const reply = (await chat.submit(w.ownerToken, { messageId: "m-d3b", text })).reply.join("\n");
    assert.equal((await w.decisions.authoritative(w.owner, { projectId: a, topic: "cache" }))?.status, "none", `a question is not a decision: ${JSON.stringify(o)} ${reply}`);
    assert.match(reply, /nothing was recorded/i, reply);
    const forged = "We will use Redis for the cache.";
    script[forged] = [cmd("decision.record", { category: "decision", topic: "cache", statement: "use Redis for the cache", wording: "We will use Redis for the cache", sourceTurnId: "turn-aaaa" }, "We will use Redis for the cache")];
    const f = only((await chat.submit(w.ownerToken, { messageId: "m-d4", text: forged })).outcomes);
    assert.notEqual(f.status, "applied");
    assert.match(f.message ?? "", /sourceTurnId is set by the controller/);
  });

  suite("two decisions on one topic in one message supersede each other instead of becoming a dispute; a project-wide decision reads the task-level version too; the interpreter cannot name basedOn or session (card C08b)", async (w, script) => {
    const a = await w.project("A");
    const t = await w.task(a, "Report");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const both = "We will use PostgreSQL for the store. Then we will use SQLite for the store instead.";
    const dec = (statement: string, wording: string, extra: Record<string, unknown> = {}) => cmd("decision.record", { category: "decision", topic: "Store", statement, wording, ...extra }, wording);
    script[both] = [dec("use PostgreSQL for the store", "We will use PostgreSQL for the store"), dec("use SQLite for the store", "we will use SQLite for the store instead")];
    const r = await chat.submit(w.ownerToken, { messageId: "m-t1", text: both });
    assert.deepEqual(r.outcomes.map((o) => o.status), ["applied", "applied"], JSON.stringify(r.outcomes));
    const now = await w.decisions.authoritative(w.owner, { projectId: a, topic: "store" });
    assert.equal(now?.status === "decided" ? now.decision.version : -1, 2, "the second superseded the first; no dispute");
    // A decision for one task, then a project-wide one: the project-wide one is based on the task-level version.
    const scoped = "For the report we will use MySQL for the store.";
    script[scoped] = [dec("use MySQL for the store", "we will use MySQL for the store", { taskId: t })];
    assert.equal(only((await chat.submit(w.ownerToken, { messageId: "m-t2", text: scoped })).outcomes).status, "applied");
    const wide = "From now on we will use SQLite for the store everywhere.";
    script[wide] = [dec("we will use SQLite for the store everywhere", "we will use SQLite for the store everywhere")];
    const o = only((await chat.submit(w.ownerToken, { messageId: "m-t3", text: wide })).outcomes);
    assert.equal(o.status, "applied", JSON.stringify(o));
    assert.equal((await w.decisions.history(w.owner, { projectId: a, topic: "store" })).some((d) => d.state === "disputed"), false);
    // The interpreter may not say basedOn or session.
    const said = "We will use Oracle for the store.";
    script[said] = [dec("use Oracle for the store", "We will use Oracle for the store", { basedOn: 0 })];
    const refused = only((await chat.submit(w.ownerToken, { messageId: "m-t4", text: said })).outcomes);
    assert.notEqual(refused.status, "applied");
    assert.match(refused.message ?? "", /basedOn and session are set by the controller/);
  });
}

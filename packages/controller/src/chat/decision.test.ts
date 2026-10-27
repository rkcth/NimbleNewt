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
    script[text] = [cmd("decision.record", { category: "decision", topic: "cache", statement: "use Redis for the cache", wording: "We will use Redis for the cache" }, "Maybe we should use Redis")];
    const o = only((await chat.submit(w.ownerToken, { messageId: "m-d3", text })).outcomes);
    assert.notEqual(o.status, "applied", JSON.stringify(o));
    assert.equal((await w.decisions.authoritative(w.owner, { projectId: a, topic: "cache" }))?.status, "none");
    const forged = "We will use Redis for the cache.";
    script[forged] = [cmd("decision.record", { category: "decision", topic: "cache", statement: "use Redis for the cache", wording: "We will use Redis for the cache", sourceTurnId: "turn-aaaa" }, "We will use Redis for the cache")];
    const f = only((await chat.submit(w.ownerToken, { messageId: "m-d4", text: forged })).outcomes);
    assert.notEqual(f.status, "applied");
    assert.match(f.message ?? "", /sourceTurnId is set by the controller/);
  });
}

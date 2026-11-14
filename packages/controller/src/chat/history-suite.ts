import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backendsNamed, stopServer } from "../domain/testing/backends.js";
import type { Outcome } from "./index.js";
import { cid, openWorld, type World } from "./testing/harness.js";

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

/**
 * The owner's recorded conversation read back (card U07 finish): the newest turns first with the words, the plain reply and the outcomes, each proposal marked open, applied or discarded, pages by a cursor,
 * the owner's own turns only, read only. One backend per file.
 */
export function defineHistoryTests(backendName: string): void {
  after(stopServer);
  for (const backend of backendsNamed(backendName)) {
    const suite = (name: string, body: (w: World, script: Record<string, unknown>) => Promise<void>) =>
      test(`${backend.name}: ${name}`, async () => {
        const script: Record<string, unknown> = {};
        const w = await openWorld(backend, script);
        try { await body(w, script); } finally { await w.close(); }
      });

    suite("the history lists the owner's turns newest first with the words, the reply and the outcomes, and pages by a cursor", async (w, script) => {
      await w.project("Alpha");
      // The harness clock is fixed, so every turn has the same time: the order is then the turn's identity, and the cursor must still page without a gap or a repeat.
      const chat = w.chat();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const text = `add task T${i} to Alpha`;
        script[text] = [cmd("task.create", { title: `T${i}`, projectName: "alpha" }, text)];
        const r = await chat.submit(w.ownerToken, { messageId: `m-hist-${i}`, text });
        ids.push(r.turnId);
      }
      const all = await chat.history(w.ownerToken, { limit: 50 });
      assert.equal(all.turns.length, 5);
      assert.equal(all.complete, true);
      assert.equal(all.next, undefined, "nothing older than the last page");
      assert.deepEqual(new Set(all.turns.map((t) => t.turnId)), new Set(ids));
      for (const t of all.turns) {
        assert.match(t.text, /^add task T\d to Alpha$/);
        assert.equal(t.status, "done");
        assert.ok(t.reply.length > 0, "a plain reply line");
        assert.ok(t.outcomes.length === 1 && t.outcomes[0]!.status === "proposed");
        assert.ok(t.completedAt !== undefined);
      }
      // Pages of two: 2, 2, 1 with no turn repeated or missing.
      const seen: string[] = [];
      let before: string | undefined;
      const sizes: number[] = [];
      for (let guard = 0; guard < 6; guard++) {
        const page = await chat.history(w.ownerToken, { limit: 2, ...(before === undefined ? {} : { before }) });
        sizes.push(page.turns.length);
        seen.push(...page.turns.map((t) => t.turnId));
        if (page.next === undefined) break;
        before = page.next;
      }
      assert.deepEqual(sizes, [2, 2, 1]);
      assert.deepEqual(seen, all.turns.map((t) => t.turnId), "the same order, each turn once");
    });

    suite("a proposal in the history says whether it is still open, was applied or was discarded", async (w, script) => {
      await w.project("Alpha");
      const chat = w.chat();
      const propose = async (n: number): Promise<{ proposalId: string; turnId: string }> => {
        const text = `add task P${n} to Alpha`;
        script[text] = [cmd("task.create", { title: `P${n}`, projectName: "alpha" }, text)];
        const r = await chat.submit(w.ownerToken, { messageId: `m-prop-${n}`, text });
        const o = r.outcomes[0]!;
        assert.equal(o.status, "proposed");
        return { proposalId: o.proposalId!, turnId: r.turnId };
      };
      const open = await propose(1), applied = await propose(2), dropped = await propose(3);
      await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: applied.proposalId });
      await chat.discardProposal(w.ownerToken, { commandId: cid("dp"), proposalId: dropped.proposalId });
      const state = new Map<string, string | undefined>();
      for (const t of (await chat.history(w.ownerToken, { limit: 10 })).turns) for (const o of t.outcomes) if (o.status === "proposed") state.set(o.proposalId!, (o as Outcome & { proposalState?: string }).proposalState);
      assert.equal(state.get(open.proposalId), "open");
      assert.equal(state.get(applied.proposalId), "applied");
      assert.equal(state.get(dropped.proposalId), "discarded");
    });

    suite("the history refuses an agent, a bad limit and a made-up cursor, and reading it changes nothing", async (w, script) => {
      await w.project("Alpha");
      const chat = w.chat();
      script["add task Q to Alpha"] = [cmd("task.create", { title: "Q", projectName: "alpha" }, "add task Q to Alpha")];
      await chat.submit(w.ownerToken, { messageId: "m-q", text: "add task Q to Alpha" });
      const ann = await w.agent("ann", [{ action: "*", project: "*" }]);
      await assert.rejects(chat.history(ann.token, {}), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
      for (const bad of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { before: "nonsense" }, { before: "2026-11-10T10:00:00.000Z|turn-xyz" }, { extra: 1 }]) {
        await assert.rejects(chat.history(w.ownerToken, bad as never), (e: unknown) => e instanceof DomainError && e.code === "invalid_command", JSON.stringify(bad));
      }
      // Reading writes nothing: the audit trail and the interpreter are untouched by any number of reads.
      const calls = w.interpreter.calls.length;
      const audit = async (): Promise<number> => { const snap = await w.world.storage.snapshot(); try { let n = 0; for (let after: Record<string, string | number | null> | undefined; ;) { const page = await snap.read("audit", { ...(after === undefined ? {} : { after }), limit: 500 }); n += page.length; if (page.length < 500) return n; after = page[page.length - 1]; } } finally { await snap.close(); } };
      const before = await audit();
      for (let i = 0; i < 3; i++) await chat.history(w.ownerToken, { limit: 5 });
      assert.equal(await audit(), before);
      assert.equal(w.interpreter.calls.length, calls);
    });

    suite("a history longer than the scan bound says it is incomplete, still answers a page, and another owner's turns never show", async (w) => {
      // Recorded turns written straight into the store (as a long-used installation would have them): 4100 of the owner's and 50 of someone else's.
      const at = (i: number): string => new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString();
      const turn = (ownerId: string, i: number) => {
        const id = `turn-${createHash("sha256").update(`${ownerId}\0${i}`).digest("hex").slice(0, 32)}`;
        return { type: "create" as const, ref: { kind: "chat-turn", id }, body: { ownerId, messageId: `seed-${i}`, text: `seeded ${i}`, quotedCount: 0, status: "done", plan: [], outcomes: [], createdAt: at(i), completedAt: at(i) } as never };
      };
      const all = [...Array.from({ length: 4100 }, (_, i) => turn(w.owner.id, i)), ...Array.from({ length: 50 }, (_, i) => turn("owner:someone-else", 10_000 + i))];
      for (let k = 0; k < all.length; k += 100) {
        await w.world.storage.applyOperation({ operationId: `seed-turns-${k}`, epoch: w.projects.epoch, actor: "owner:rob", correlationId: `seed-turns-${k}`, at: at(0), changes: all.slice(k, k + 100), audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
      }
      const page = await w.chat().history(w.ownerToken, { limit: 50 });
      assert.equal(page.complete, false, "more turns than the scan reads");
      assert.equal(page.turns.length, 50);
      assert.ok(page.turns.every((t) => /^seeded \d+$/.test(t.text) && Number(t.text.slice(7)) < 4100), "only the owner's own turns");
      for (let i = 1; i < page.turns.length; i++) assert.ok(page.turns[i - 1]!.createdAt >= page.turns[i]!.createdAt, "newest first among those read");
      assert.equal(typeof page.next, "string");
      const older = await w.chat().history(w.ownerToken, { limit: 50, before: page.next! });
      assert.equal(older.turns.length, 50);
      assert.ok(older.turns[0]!.createdAt <= page.turns[49]!.createdAt, "the next page is older");
    });
  }
}

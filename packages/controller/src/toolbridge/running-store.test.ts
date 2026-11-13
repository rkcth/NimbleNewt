import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { RUNNING_CALL_KIND, RunningCallStore } from "./running-store.js";

after(stopServer);

// Card T02d close-out: the durable record of running calls that another controller process on the same store reads.
const entry = (callId: string, extra: Partial<{ name: string; version: string; seconds: number }> = {}) => ({ name: "a-ann.slow", version: "1.0.0", attemptId: "att-1", callId, taskId: "tsk-1", agentId: "agent:ann", seconds: 30, ...extra });

for (const backend of backends) {
  test(`${backend.name}: T02d close-out: a running call is listed by another writer until it ends or its time is up; a fenced writer's leftover is swept once past its time; nothing else is listed`, async () => {
    const w = await backend.open();
    try {
      let now = Date.parse("2026-11-11T10:00:00.000Z");
      const clock = () => new Date(now).toISOString();
      const a1 = (await w.storage.acquireEpoch({ holder: "a", at: clock() })).epoch;
      const a = RunningCallStore.withEpoch(w.storage, a1, { clock, graceMs: 1000 });
      const b0 = RunningCallStore.withEpoch(w.storage, a1, { clock, graceMs: 1000 });

      // Begin, listed by the other writer (not by its own), with no input or content.
      const id = await a.begin(entry("c1"));
      assert.equal(id, RunningCallStore.idOf("att-1", "c1"));
      const seen = await b0.elsewhere("a-ann.slow", "1.0.0");
      assert.equal(seen.total, 1);
      assert.deepEqual(Object.keys(seen.calls[0]!).sort(), ["agentId", "attemptId", "callId", "name", "startedAt", "taskId", "until", "version"]);
      assert.equal(seen.calls[0]!.until, "2026-11-11T10:00:31.000Z", "start + the manifest's seconds + the grace");
      assert.equal((await a.elsewhere("a-ann.slow", "1.0.0")).total, 0, "a writer's own records are not elsewhere");
      assert.equal((await b0.elsewhere("a-ann.slow", "2.0.0")).total, 0, "another version");
      assert.equal((await b0.elsewhere("a-ann.other", "1.0.0")).total, 0, "another tool");

      // Only the writer removes its record before its time; its end removes it.
      await b0.end(id!);
      assert.equal((await b0.elsewhere("a-ann.slow", "1.0.0")).total, 1, "another writer's end changes nothing");
      await a.end(id!);
      assert.equal((await b0.elsewhere("a-ann.slow", "1.0.0")).total, 0);
      assert.equal(await w.storage.getAggregate({ kind: RUNNING_CALL_KIND, id: id! }), undefined);

      // The same attempt and call again (after a removal) is recorded again.
      const again = await a.begin(entry("c1"));
      assert.equal(again, id);
      assert.equal((await b0.elsewhere("a-ann.slow", "1.0.0")).total, 1);
      await a.end(again!);
      // Review: the second removal is its own command, never answered as a replay of the first removal (its command ID names the record's revision, which is not reused after a delete).
      assert.equal((await b0.elsewhere("a-ann.slow", "1.0.0")).total, 0, "the second end removes the second record too");
      assert.equal(await w.storage.getAggregate({ kind: RUNNING_CALL_KIND, id: id! }), undefined);

      // A writer that lost the epoch cannot remove its record: the newer process lists it until it can no longer be running, then sweeps it.
      const left = await a.begin(entry("c2", { seconds: 5 }));
      assert.ok(left !== undefined);
      const b1 = (await w.storage.acquireEpoch({ holder: "b", at: clock() })).epoch;
      const b = RunningCallStore.withEpoch(w.storage, b1, { clock, graceMs: 1000 });
      await a.end(left!);
      assert.equal((await b.elsewhere("a-ann.slow", "1.0.0")).total, 1, "the fenced writer's end wrote nothing; the call may still run there");
      assert.equal(await a.begin(entry("c3")), undefined, "a fenced writer records nothing and says so (the call itself is not refused by this)");
      assert.equal(await b.sweep(), 0, "nothing is past its time");
      now += 5_999;
      assert.equal((await b.elsewhere("a-ann.slow", "1.0.0")).total, 1, "still within its time");
      now += 1;
      assert.equal((await b.elsewhere("a-ann.slow", "1.0.0")).total, 0, "past start + limit + grace: never listed");
      // A damaged record names no time, so it is never listed and is swept too.
      await w.storage.applyOperation({ operationId: "op-damaged", epoch: b1, actor: "test", correlationId: "op-damaged", at: clock(), changes: [{ type: "create", ref: { kind: RUNNING_CALL_KIND, id: "trun-damaged" }, body: { name: "a-ann.slow", version: "1.0.0" } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
      assert.equal((await b.elsewhere("a-ann.slow", "1.0.0")).total, 0);
      const live = await b.begin(entry("c4", { seconds: 600 }));
      assert.equal(await b.sweep(), 2, "the expired leftover and the damaged record; the live one stays");
      assert.equal(await w.storage.getAggregate({ kind: RUNNING_CALL_KIND, id: left! }), undefined);
      assert.ok(await w.storage.getAggregate({ kind: RUNNING_CALL_KIND, id: live! }));
      assert.equal(await a.sweep(), 0, "a fenced writer's sweep removes nothing and never throws");
    } finally { await w.close(); }
  });

  test(`${backend.name}: T02d close-out review: more records than one bounded look reads are never presented as all of them`, async () => {
    const w = await backend.open();
    try {
      const epoch = (await w.storage.acquireEpoch({ holder: "a", at: new Date().toISOString() })).epoch;
      const a = RunningCallStore.withEpoch(w.storage, epoch, { page: 2, pages: 2 });
      const b = RunningCallStore.withEpoch(w.storage, epoch, { page: 2, pages: 2 });
      for (const c of ["c1", "c2", "c3"]) assert.ok(await a.begin(entry(c)));
      const three = await b.elsewhere("a-ann.slow", "1.0.0");
      assert.equal(three.total, 3);
      assert.equal(three.incomplete, undefined, "three records fit in two pages of two");
      assert.ok(await a.begin(entry("c4")));
      assert.ok(await a.begin(entry("c5", { name: "a-ann.other" })));
      const cut = await b.elsewhere("a-ann.slow", "1.0.0");
      assert.equal(cut.incomplete, true, "the look ended on a full page, so more may follow: said, not hidden");
      assert.ok(cut.total <= 4);
      assert.throws(() => RunningCallStore.withEpoch(w.storage, epoch, { page: 0 }), RangeError);
      assert.throws(() => RunningCallStore.withEpoch(w.storage, epoch, { pages: 11 }), RangeError);
    } finally { await w.close(); }
  });

  test(`${backend.name}: T02d finish: a sweep reaches leftovers on later pages, not only on the first page, and keeps live records`, async () => {
    const w = await backend.open();
    try {
      let now = Date.parse("2026-11-12T10:00:00.000Z");
      const clock = () => new Date(now).toISOString();
      const epoch = (await w.storage.acquireEpoch({ holder: "a", at: clock() })).epoch;
      const a = RunningCallStore.withEpoch(w.storage, epoch, { clock, graceMs: 0, page: 2, pages: 5 });
      const b = RunningCallStore.withEpoch(w.storage, epoch, { clock, graceMs: 0, page: 2, pages: 5 });
      const short = ["s1", "s2", "s3", "s4"], long = ["l1", "l2", "l3"];
      for (const c of short) assert.ok(await a.begin(entry(c, { seconds: 5 })));
      for (const c of long) assert.ok(await a.begin(entry(c, { seconds: 600 })));
      now += 10_000;
      assert.equal(await b.sweep(), 4, "all four expired leftovers, wherever they sit in the ordering of the records (page size 2)");
      const left = await w.storage.listAggregates(RUNNING_CALL_KIND, { limit: 20 });
      assert.equal(left.length, 3, "only the live records remain");
      assert.equal(await b.sweep(), 0);
    } finally { await w.close(); }
  });
}

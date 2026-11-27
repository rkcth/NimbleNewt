import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { stopServer } from "../domain/testing/backends.js";
import { FLOOR_LIMITS } from "./floor.js";
import type { FloorBody } from "./floor-types.js";
import { floorSuite, type FloorWorld } from "./floor-suite.js";

// Card M05, bounds: the open owner inquiries are one list kept in the same write as each floor change that opens or ends one. The idle reminder (every scheduled turn), the Needs-you list and the status view read that list and
// the floors on it, never every floor record ever kept.

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const MOTION = "Move the nightly build to 01:00 because the cache is warm then.";
const INDEX = { kind: "meeting-floor-inquiries", id: "installation" };
const start = async (w: FloorWorld, rec: string, settings?: Record<string, unknown>): Promise<void> => { await w.floor.start(w.service, { commandId: cid("st"), recordId: rec, motion: { text: MOTION }, ...(settings === undefined ? {} : { settings }) }); };
const open = async (w: FloorWorld, rec: string): Promise<void> => { await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec }); };
const end = async (w: FloorWorld, rec: string): Promise<void> => { await w.floor.endInquiry(w.owner, { commandId: cid("ie"), recordId: rec }); };
const stored = async (w: FloorWorld): Promise<unknown> => (await w.storage.getAggregate(INDEX))?.body;
const listed = async (w: FloorWorld): Promise<string[] | undefined> => ((await stored(w)) as { ids?: string[] } | undefined)?.ids;
const floorOf = async (w: FloorWorld, rec: string): Promise<FloorBody> => (await w.floor.state(w.owner, rec)) as unknown as FloorBody;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (e: unknown) => e instanceof DomainError && e.code === code);
};
/** A fake but well-formed meeting record ID (no floor behind it). */
const fakeId = (i: number): string => `mrc-${"a".repeat(16)}${"abcdefghijklmnopqrstuvwxyz234567"[Math.floor(i / 32) % 32]}${"abcdefghijklmnopqrstuvwxyz234567"[i % 32]}aa`;
const apply = async (w: FloorWorld, kind: string, id: string, change: (revision: number | undefined) => unknown): Promise<void> => {
  const found = await w.storage.getAggregate({ kind, id });
  const ref = { kind, id };
  await w.storage.applyOperation({ operationId: cid("op"), epoch: await w.storage.currentEpoch(), actor: "service:test", correlationId: cid("op"), at: w.iso(), changes: [{ ref, ...(change(found?.revision) as object) }], audit: [{ type: "test.write", subject: ref, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
};
/** Writes the stored list as given (a list kept before a crash, a corrupted one, a planted one). */
const plant = async (w: FloorWorld, body: unknown): Promise<void> => apply(w, INDEX.kind, INDEX.id, (r) => (r === undefined ? { type: "create", body } : { type: "update", expectedRevision: r, body }));
/** Removes the stored list, as before this list existed (floors kept by an earlier version). */
const unplant = async (w: FloorWorld): Promise<void> => apply(w, INDEX.kind, INDEX.id, (r) => ({ type: "delete", expectedRevision: r }));
/** Counts the pages of floor records read while `run` runs. */
const walks = async (w: FloorWorld, run: () => Promise<unknown>): Promise<number> => {
  const s = w.storage as unknown as { listAggregates: (kind: string, page: unknown) => Promise<unknown> };
  const real = s.listAggregates;
  let count = 0;
  s.listAggregates = async (kind: string, page: unknown) => { if (kind === "meeting-floor") count += 1; return real.call(w.storage, kind, page); };
  try { await run(); } finally { s.listAggregates = real; }
  return count;
};
const reads = async (w: FloorWorld): Promise<void> => { await w.floor.sweep(w.service); await w.floor.ownerPending(w.owner); await w.floor.openInquiries(w.owner, 10); };

floorSuite(test, "the open inquiries are one list, oldest first, changed in the same write as the floor: opened, ended, ended with the meeting, and kept over a restart", async (w) => {
  const a = (await w.meet()).rec, b = (await w.meet()).rec, c = (await w.meet()).rec;
  for (const r of [a, b, c]) await start(w, r);
  assert.equal(await stored(w), undefined, "no list before any inquiry");
  await open(w, b);
  w.clock.tick(1);
  await open(w, a);
  assert.deepEqual(await listed(w), [b, a], "in the order the inquiries opened");
  await open(w, a);
  assert.deepEqual(await listed(w), [b, a], "opening again (a replay) adds nothing");
  assert.deepEqual((await w.floor.ownerPending(w.owner)).items.map((i) => i.recordId), [b, a]);
  assert.deepEqual((await w.floor.ownerPending(w.owner, 1)).items.map((i) => i.recordId), [b], "the limit");
  assert.deepEqual((await w.floor.openInquiries(w.owner, 10)).items.map((i) => i.recordId), [b, a]);
  const cut = await w.floor.openInquiries(w.owner, 1);
  assert.deepEqual([cut.items.map((i) => i.recordId), cut.truncated], [[b], true]);
  await end(w, b);
  assert.deepEqual(await listed(w), [a], "an ended inquiry leaves the list");
  await end(w, b);
  assert.deepEqual(await listed(w), [a], "ending again changes nothing");
  // ended with the meeting: the owner ends the floor
  await open(w, c);
  assert.deepEqual(await listed(w), [a, c]);
  await w.floor.end(w.owner, { commandId: cid("end"), recordId: c });
  assert.equal((await floorOf(w, c)).inquiry, undefined);
  assert.deepEqual(await listed(w), [a], "a meeting ended with its inquiry open leaves the list");
  // a restart reads the same list
  w.reopen();
  assert.deepEqual((await w.floor.ownerPending(w.owner)).items.map((i) => i.recordId), [a]);
  assert.deepEqual((await w.floor.openInquiries(w.owner, 10)).items.map((i) => i.recordId), [a]);
  // nobody but the owner, and no task-scoped owner, reads it
  await refuses("forbidden", () => w.floor.ownerPending(w.asA));
  assert.deepEqual((await w.floor.openInquiries(w.asA, 10)).items, []);
  assert.deepEqual((await w.floor.openInquiries({ ...w.owner, taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa" } } as never, 10)).items, []);
});

floorSuite(test, "a meeting closed by other means takes its inquiry off the list when the scheduled turn reaches it", async (w) => {
  const { rec } = await w.meet();
  await start(w, rec, { inquiryIdleMinutes: 10 });
  await open(w, rec);
  assert.deepEqual(await listed(w), [rec]);
  await w.records.finish(w.owner, { commandId: cid("fin"), recordId: rec });
  assert.deepEqual(await listed(w), [rec], "the record's own finish does not touch the floor");
  w.clock.tick(11);
  assert.deepEqual((await w.floor.sweep(w.service)).reminded, [], "a closed meeting is not reminded");
  assert.deepEqual(await listed(w), [], "and leaves the list");
  assert.deepEqual((await w.floor.openInquiries(w.owner, 10)).items, []);
});

floorSuite(test, "reading the open inquiries walks no floor records once the list exists: the reminder, the Needs-you list and the status view read the list and the floors on it", async (w) => {
  const a = (await w.meet()).rec, b = (await w.meet()).rec;
  await start(w, a, { inquiryIdleMinutes: 10 });
  await start(w, b, { inquiryIdleMinutes: 10 });
  // no inquiry has ever been opened: the first read walks the floors once and stores an empty list; later reads walk nothing
  assert.ok((await walks(w, () => w.floor.sweep(w.service))) >= 1, "the first read builds the list");
  assert.deepEqual(await listed(w), [], "an empty list is stored");
  assert.equal(await walks(w, () => reads(w)), 0, "later reads walk no floor");
  await open(w, a);
  assert.equal(await walks(w, () => open(w, b)), 0, "opening an inquiry walks no floor");
  assert.equal(await walks(w, () => reads(w)), 0);
  w.clock.tick(11);
  let reminded: readonly string[] = [];
  assert.equal(await walks(w, async () => { reminded = (await w.floor.sweep(w.service)).reminded; }), 0);
  assert.deepEqual([...reminded].sort(), [a, b].sort(), "both idle inquiries are reminded");
  assert.equal(await walks(w, () => end(w, a)), 0, "ending one walks no floor");
  assert.deepEqual(await listed(w), [b]);
  // the scheduled turn still reminds from the list (its own walk drives the running meetings, bounded by tickPages)
  w.clock.tick(11);
  assert.deepEqual((await w.floor.tick(w.service)).reminded, [b]);
});

floorSuite(test, "floors kept before the list existed: the first read builds the list from them, so an open inquiry is still reminded and listed", async (w) => {
  const a = (await w.meet()).rec, b = (await w.meet()).rec;
  await start(w, a, { inquiryIdleMinutes: 10 });
  await start(w, b, { inquiryIdleMinutes: 10 });
  await open(w, a);
  w.clock.tick(1);
  await open(w, b);
  await unplant(w);
  assert.equal(await stored(w), undefined, "as an earlier version kept it: no list");
  w.reopen();
  assert.deepEqual((await w.floor.ownerPending(w.owner)).items.map((i) => i.recordId), [a, b], "rebuilt, oldest first");
  assert.deepEqual(await listed(w), [a, b], "and stored");
  // an inquiry that ends before any read builds the list: the end builds it too
  await unplant(w);
  await end(w, a);
  assert.deepEqual(await listed(w), [b], "built from the floors, without the one that just ended");
  await unplant(w);
  const c = (await w.meet()).rec;
  await start(w, c, { inquiryIdleMinutes: 10 });
  await open(w, c);
  assert.deepEqual(await listed(w), [b, c], "an inquiry opened with no list keeps the older ones");
  w.clock.tick(11);
  assert.deepEqual([...(await w.floor.sweep(w.service)).reminded].sort(), [b, c].sort());
});

floorSuite(test, "a stored list that cannot be trusted is built again from the floors, never believed", async (w) => {
  const a = (await w.meet()).rec;
  await start(w, a, { inquiryIdleMinutes: 10 });
  await open(w, a);
  const bad: unknown[] = [
    { ids: "not a list" }, { ids: [a, a] }, { ids: [a, 7] }, { ids: ["mrc-short"] }, { ids: [`${a} `] }, {}, { ids: null }, { ids: { 0: a, length: 1 } },
    { ids: Array.from({ length: FLOOR_LIMITS.openInquiries + 1 }, (_, i) => fakeId(i)) }, JSON.parse(`{"__proto__":{"ids":["${a}"]}}`),
  ];
  for (const body of bad) {
    await plant(w, body);
    assert.deepEqual((await w.floor.ownerPending(w.owner)).items.map((i) => i.recordId), [a], `rebuilt for ${JSON.stringify(body).slice(0, 60)}`);
    assert.deepEqual(await listed(w), [a], "and stored again");
  }
  // a well-formed list that left an open inquiry out is believed (it is written only with the floors); the floor ending still works
  await plant(w, { ids: [] });
  assert.deepEqual((await w.floor.ownerPending(w.owner)).items, []);
  await end(w, a);
  assert.deepEqual(await listed(w), []);
});

floorSuite(test, "the list is bounded: one more inquiry than the limit is refused before anything is written, ending one is never refused, and listed floors that are gone are dropped by the reminder", async (w) => {
  const a = (await w.meet()).rec, b = (await w.meet()).rec;
  await start(w, a);
  await start(w, b);
  const fakes = Array.from({ length: FLOOR_LIMITS.openInquiries - 1 }, (_, i) => fakeId(i));
  assert.equal(new Set(fakes).size, fakes.length);
  await w.floor.ownerPending(w.owner); // the first read after the start checks the list against the floors; the planted list below is then believed
  await plant(w, { ids: fakes });
  await open(w, a);
  assert.equal((await listed(w))!.length, FLOOR_LIMITS.openInquiries, "the last place is taken");
  const transcript = async (): Promise<number> => (await w.records.discussion(w.owner, b, { limit: 100 }))!.entries.length;
  const before = await transcript();
  await refuses("invalid_command", () => open(w, b));
  assert.equal((await floorOf(w, b)).inquiry, undefined, "no inquiry");
  assert.equal(await transcript(), before, "no owner note is written for a refused inquiry");
  assert.equal(w.notices.some((x) => x.kind === "inquiry-open" && x.recordId === b), false, "and no notice");
  assert.deepEqual((await w.floor.ownerPending(w.owner)).items.map((i) => i.recordId), [a], "the fake IDs have no floor and are not shown");
  await end(w, a);
  assert.equal((await listed(w))!.length, FLOOR_LIMITS.openInquiries - 1, "ending is never refused");
  await open(w, b);
  assert.equal((await listed(w))!.at(-1), b);
  // the reminder drops listed IDs whose floor is gone; the real one stays
  await w.floor.sweep(w.service);
  assert.deepEqual(await listed(w), [b]);
  await open(w, a);
  assert.deepEqual(await listed(w), [b, a]);
});

floorSuite(test, "the reminder drops a listed floor that has no inquiry, but never one whose inquiry is open", async (w) => {
  const a = (await w.meet()).rec, b = (await w.meet()).rec;
  await start(w, a, { inquiryIdleMinutes: 10 });
  await start(w, b, { inquiryIdleMinutes: 10 });
  await open(w, a);
  await plant(w, { ids: [b, a] });
  assert.deepEqual((await w.floor.ownerPending(w.owner)).items.map((i) => i.recordId), [a], "a listed floor without an inquiry is not shown");
  await w.floor.sweep(w.service);
  assert.deepEqual(await listed(w), [a]);
  w.clock.tick(11);
  // a sweep of another project neither reminds this one nor takes it off the list
  assert.deepEqual((await w.floor.sweep(w.service, { projectId: "prj-aaaaaaaaaaaaaaaaaaaa" })).reminded, []);
  assert.deepEqual(await listed(w), [a]);
  assert.deepEqual((await w.floor.sweep(w.service, { projectId: w.project })).reminded, [a]);
  assert.deepEqual(await listed(w), [a]);
  assert.equal(w.notices.filter((x) => x.kind === "inquiry-idle" && x.recordId === b).length, 0);
});

floorSuite(test, "inquiries opened and ended at the same moment on different meetings are all kept right on the list", async (w) => {
  const recs: string[] = [];
  for (let i = 0; i < 4; i += 1) { const r = (await w.meet()).rec; await start(w, r); recs.push(r); }
  await Promise.all(recs.map((r) => open(w, r)));
  assert.deepEqual([...(await listed(w))!].sort(), [...recs].sort(), "every inquiry is listed once");
  await Promise.all([end(w, recs[0]!), end(w, recs[1]!), w.floor.sweep(w.service)]);
  assert.deepEqual([...(await listed(w))!].sort(), [recs[2]!, recs[3]!].sort());
  // with no list at all, opens racing the first build still end up all listed
  await Promise.all(recs.slice(2).map((r) => end(w, r)));
  await unplant(w);
  await Promise.all([...recs.map((r) => open(w, r)), w.floor.sweep(w.service), w.floor.ownerPending(w.owner)]);
  assert.deepEqual([...(await listed(w))!].sort(), [...recs].sort());
  for (const r of recs) assert.ok((await floorOf(w, r)).inquiry !== undefined);
});

floorSuite(test, "two inquiries opened at the same moment for the last place: exactly one opens, and the list stays within its bound", async (w) => {
  const a = (await w.meet()).rec, b = (await w.meet()).rec;
  await start(w, a);
  await start(w, b);
  await w.floor.ownerPending(w.owner); // checked once after the start, as above
  await plant(w, { ids: Array.from({ length: FLOOR_LIMITS.openInquiries - 1 }, (_, i) => fakeId(i)) });
  const out = await Promise.allSettled([open(w, a), open(w, b)]);
  assert.equal(out.filter((o) => o.status === "fulfilled").length, 1, JSON.stringify(out.map((o) => o.status)));
  const refused = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
  assert.ok(refused.reason instanceof DomainError && refused.reason.code === "invalid_command");
  const ids = (await listed(w))!;
  assert.equal(ids.length, FLOOR_LIMITS.openInquiries, "the bound holds");
  const opened = [a, b].filter((r) => ids.includes(r));
  assert.equal(opened.length, 1);
  for (const r of [a, b]) assert.equal((await floorOf(w, r)).inquiry !== undefined, opened.includes(r), "the list matches the floors");
});

floorSuite(test, "an inquiry opened for a floor a stale list already names is listed once", async (w) => {
  const a = (await w.meet()).rec;
  await start(w, a);
  await plant(w, { ids: [a] });
  await open(w, a);
  assert.deepEqual(await listed(w), [a]);
  await end(w, a);
  assert.deepEqual(await listed(w), []);
});

floorSuite(test, "a rebuilt list leaves out a floor record whose meeting record ID is malformed", async (w) => {
  const a = (await w.meet()).rec;
  await start(w, a);
  await open(w, a);
  await apply(w, "meeting-floor", "mfl-planted", () => ({ type: "create", body: { recordId: "mrc-NOT-A-RECORD", projectId: w.project, state: "running", inquiry: { openedAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-01-01T00:00:00.000Z", questions: 0, voteHeld: false, addressed: [], messages: [] } } }));
  await unplant(w);
  assert.deepEqual((await w.floor.ownerPending(w.owner)).items.map((i) => i.recordId), [a]);
  assert.deepEqual(await listed(w), [a], "only well-formed meeting record IDs are listed");
});

floorSuite(test, "an inquiry refused at the write because the last place was taken meanwhile resumes the vote it held, so no vote stays held without an inquiry", async (w) => {
  const { rec } = await w.meet();
  const motionId = (await w.floor.start(w.service, { commandId: cid("st"), recordId: rec, motion: { text: MOTION } })).motionId!;
  for (let i = 0; i < 200 && ((await floorOf(w, rec)) as { phase?: string }).phase !== "voting"; i += 1) await w.floor.advance(w.service, { recordId: rec });
  const motion = async (): Promise<{ state: string; heldAt?: string }> => (await w.records.motion(w.owner, motionId)) as never;
  assert.equal((await motion()).state, "voting");
  await w.floor.ownerPending(w.owner); // checked once after the start; the planted list below is then believed
  await plant(w, { ids: Array.from({ length: FLOOR_LIMITS.openInquiries - 1 }, (_, i) => fakeId(i)) });
  // another inquiry takes the last place between the early check and the write (as when two open at once)
  const records = w.records as unknown as { hold: (...a: unknown[]) => Promise<unknown> };
  const real = records.hold;
  records.hold = async (...a: unknown[]) => { const out = await real.apply(w.records, a); await plant(w, { ids: Array.from({ length: FLOOR_LIMITS.openInquiries }, (_, i) => fakeId(i)) }); return out; };
  const same = cid("iq-same");
  try { await refuses("invalid_command", () => w.floor.openInquiry(w.owner, { commandId: same, recordId: rec })); } finally { records.hold = real; }
  assert.equal((await floorOf(w, rec)).inquiry, undefined);
  assert.equal((await motion()).heldAt, undefined, "the vote this call held is resumed");
  assert.equal((await motion()).state, "voting");
  // the owner sends the same command again once a place is free: the vote is held again, not answered from the earlier hold
  await plant(w, { ids: [] });
  assert.equal((await w.floor.openInquiry(w.owner, { commandId: same, recordId: rec })).voteHeld, true);
  assert.notEqual((await motion()).heldAt, undefined, "the vote is held while the inquiry is open");
  assert.deepEqual(await listed(w), [rec]);
});

floorSuite(test, "a well-formed list that leaves out an open inquiry (an earlier release, after a rollback, wrote the floor without the list) is put right by the first read after a start, and later reads walk no floor", async (w) => {
  const a = (await w.meet()).rec, b = (await w.meet()).rec, c = (await w.meet()).rec;
  for (const r of [a, b, c]) await start(w, r, { inquiryIdleMinutes: 10 });
  await open(w, a);
  w.clock.tick(1);
  await open(w, b);
  await open(w, c);
  await end(w, c);
  assert.deepEqual(await listed(w), [a, b]);
  // The earlier release opened b and ended c: its list still names a and c (well formed, so not rebuilt for its form).
  await plant(w, { ids: [a, c] });
  const f = w.reopen();
  assert.deepEqual((await f.ownerPending(w.owner)).items.map((i) => i.recordId), [a, b], "b is on the Needs-you list again, oldest first");
  assert.deepEqual(await listed(w), [a, b], "and the list is stored again");
  assert.equal(await walks(w, () => reads(w)), 0, "checked once: later reads walk no floor");
  // the same list read again after another start is checked and left as it is
  w.reopen();
  const rev = (await w.storage.getAggregate(INDEX))!.revision;
  assert.deepEqual((await w.floor.openInquiries(w.owner, 10)).items.map((i) => i.recordId), [a, b]);
  assert.equal((await w.storage.getAggregate(INDEX))!.revision, rev, "a list that matches the floors is not written");
  // a list that still names an inquiry the earlier release ended (c) is put right too
  await plant(w, { ids: [a, b, c] });
  w.reopen();
  assert.deepEqual((await w.floor.ownerPending(w.owner)).items.map((i) => i.recordId), [a, b]);
  assert.deepEqual(await listed(w), [a, b], "the ended one leaves the list");
  // a check whose write loses (another write got there first) checks again on the next read
  await plant(w, { ids: [a] });
  const g = w.reopen();
  const st = w.storage as unknown as { applyOperation: (op: { changes: { ref: { kind: string } }[] }) => Promise<unknown> };
  const realApply = st.applyOperation;
  let lost = 0;
  st.applyOperation = async (op) => {
    if (lost === 0 && op.changes.some((c) => c.ref.kind === INDEX.kind)) { lost += 1; await plant(w, { ids: [a] }); }
    return realApply.call(w.storage, op);
  };
  try { assert.deepEqual((await g.ownerPending(w.owner)).items.map((i) => i.recordId), [a, b], "the answer is from the floors"); } finally { st.applyOperation = realApply; }
  assert.equal(lost, 1);
  assert.deepEqual(await listed(w), [a], "the write lost");
  assert.ok((await walks(w, () => g.ownerPending(w.owner))) >= 1, "so the next read checks again");
  assert.deepEqual(await listed(w), [a, b]);
  // the idle reminder after a start also sees an inquiry the list left out
  await plant(w, { ids: [] });
  w.reopen();
  w.clock.tick(11);
  assert.deepEqual([...(await w.floor.sweep(w.service)).reminded].sort(), [a, b].sort(), "both idle inquiries are reminded");
});

floorSuite(test, "too many floor records to walk: with no list the reads are refused (unavailable) and the scheduled turn goes on; a well-formed list is then believed, and walked once a start", async (w) => {
  const { rec } = await w.meet();
  await start(w, rec);
  await open(w, rec);
  const s = w.storage as unknown as { listAggregates: (kind: string, page: { afterId?: string; limit: number }) => Promise<unknown[]> };
  const real = s.listAggregates;
  let pages = 0;
  // every page of floor records is full, so the walk never reaches the end
  s.listAggregates = async (kind, page) => {
    if (kind !== "meeting-floor") return real.call(w.storage, kind, page);
    pages += 1;
    return Array.from({ length: page.limit }, (_, i) => ({ kind, id: `mfl-${String(pages).padStart(8, "0")}-${String(i).padStart(4, "0")}`, revision: 1, body: {}, createdAt: w.iso(), updatedAt: w.iso() }));
  };
  try {
    await unplant(w);
    const f = w.reopen();
    await refuses("unavailable", () => f.ownerPending(w.owner));
    assert.equal(pages, FLOOR_LIMITS.indexPages, "the walk stops at its bound");
    await refuses("unavailable", () => f.sweep(w.service));
    pages = 0;
    const turn = await f.tick(w.service);
    assert.deepEqual(turn.reminded, [], "the scheduled turn is not stopped by the reminder");
    await plant(w, { ids: [rec] });
    const g = w.reopen();
    pages = 0;
    assert.deepEqual((await g.ownerPending(w.owner)).items.map((i) => i.recordId), [rec], "a well-formed list is believed");
    assert.equal(pages, FLOOR_LIMITS.indexPages, "after one bounded walk");
    pages = 0;
    await g.ownerPending(w.owner);
    await g.openInquiries(w.owner, 10);
    assert.equal(pages, 0, "and not walked again until the next start");
  } finally { s.listAggregates = real; }
});

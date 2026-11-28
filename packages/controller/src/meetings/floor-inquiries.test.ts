import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { stopServer } from "../domain/testing/backends.js";
import { FLOOR_LIMITS } from "./floor.js";
import type { FloorBody } from "./floor-types.js";
import { floorSuite, type FloorWorld } from "./floor-suite.js";

// Card M05, bounds: the open owner inquiries are one list kept in the same write as each floor change that opens or ends one. The idle reminder (every scheduled turn), the Needs-you list and the status view read that list and
// the floors on it, never every floor record ever kept. A read (the Needs-you list, the status view) writes nothing (card U05): when the list is missing, untrusted or not yet checked after a start, the reminder (a write path
// that runs on every scheduled turn) and opening an inquiry store it; a read answers from its own walk of the floors.

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
/** The floor as stored (the view leaves out the unit in flight). */
const rawFloor = async (w: FloorWorld, rec: string): Promise<FloorBody> => (((await w.storage.listAggregates("meeting-floor", { limit: 200 })) as { body: object }[]).find((x) => (x.body as FloorBody).recordId === rec)!.body as FloorBody);
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
  // no inquiry has ever been opened: the first reminder walks the floors once and stores an empty list; later reads walk nothing
  assert.ok((await walks(w, () => w.floor.sweep(w.service))) >= 1, "the first reminder builds the list");
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

floorSuite(test, "floors kept before the list existed: a read answers from them and writes nothing, the reminder builds and stores the list, so an open inquiry is still reminded and listed", async (w) => {
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
  assert.equal(await stored(w), undefined, "a read stores nothing");
  await w.floor.sweep(w.service);
  assert.deepEqual(await listed(w), [a, b], "the reminder stores it");
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

floorSuite(test, "a stored list that cannot be trusted is built again from the floors, never believed: a read answers from the floors and writes nothing, the reminder stores the list again", async (w) => {
  const a = (await w.meet()).rec;
  await start(w, a, { inquiryIdleMinutes: 10 });
  await open(w, a);
  const bad: unknown[] = [
    { ids: "not a list" }, { ids: [a, a] }, { ids: [a, 7] }, { ids: ["mrc-short"] }, { ids: [`${a} `] }, {}, { ids: null }, { ids: { 0: a, length: 1 } },
    { ids: Array.from({ length: FLOOR_LIMITS.openInquiries + 1 }, (_, i) => fakeId(i)) }, JSON.parse(`{"__proto__":{"ids":["${a}"]}}`),
  ];
  for (const body of bad) {
    await plant(w, body);
    const revision = (await w.storage.getAggregate(INDEX))!.revision;
    assert.deepEqual((await w.floor.ownerPending(w.owner)).items.map((i) => i.recordId), [a], `rebuilt for ${JSON.stringify(body).slice(0, 60)}`);
    assert.deepEqual((await w.floor.openInquiries(w.owner, 10)).items.map((i) => i.recordId), [a]);
    assert.equal((await w.storage.getAggregate(INDEX))!.revision, revision, "a read writes nothing");
    await w.floor.sweep(w.service);
    assert.deepEqual(await listed(w), [a], "the reminder stores it again");
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
  await w.floor.sweep(w.service); // the first reminder after the start checks the list against the floors and stores it; the planted list below is then believed
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
  await w.floor.sweep(w.service); // checked once after the start, as above
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
  await w.floor.sweep(w.service); // checked once after the start, so the planted list below is believed
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
  await w.floor.sweep(w.service);
  assert.deepEqual(await listed(w), [a], "only well-formed meeting record IDs are listed");
});

floorSuite(test, "an inquiry refused at the write because the last place was taken meanwhile resumes the vote it held, so no vote stays held without an inquiry", async (w) => {
  const { rec } = await w.meet();
  const motionId = (await w.floor.start(w.service, { commandId: cid("st"), recordId: rec, motion: { text: MOTION } })).motionId!;
  for (let i = 0; i < 200 && ((await floorOf(w, rec)) as { phase?: string }).phase !== "voting"; i += 1) await w.floor.advance(w.service, { recordId: rec });
  const motion = async (): Promise<{ state: string; heldAt?: string }> => (await w.records.motion(w.owner, motionId)) as never;
  assert.equal((await motion()).state, "voting");
  await w.floor.sweep(w.service); // checked once after the start; the planted list below is then believed
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

floorSuite(test, "a well-formed list that leaves out an open inquiry (an earlier release, after a rollback, wrote the floor without the list) is answered right by the first read after a start without a write, put right by the first reminder, and later reads walk no floor", async (w) => {
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
  assert.deepEqual(await listed(w), [a, c], "a read writes nothing");
  assert.equal(await walks(w, async () => { await f.ownerPending(w.owner); await f.openInquiries(w.owner, 10); }), 0, "the walk is kept while the list is unchanged: the next reads walk no floor");
  assert.deepEqual((await f.openInquiries(w.owner, 10)).items.map((i) => i.recordId), [a, b]);
  await f.sweep(w.service);
  assert.deepEqual(await listed(w), [a, b], "the reminder stores the list again");
  assert.equal(await walks(w, () => reads(w)), 0, "checked once: later reads walk no floor");
  // the same list read again after another start is checked and left as it is
  w.reopen();
  const rev = (await w.storage.getAggregate(INDEX))!.revision;
  assert.deepEqual((await w.floor.openInquiries(w.owner, 10)).items.map((i) => i.recordId), [a, b]);
  assert.equal((await w.storage.getAggregate(INDEX))!.revision, rev, "a list that matches the floors is not written");
  assert.equal(await walks(w, () => reads(w)), 0, "and it is marked checked: later reads and the reminder walk no floor");
  // a list that still names an inquiry the earlier release ended (c) is put right too
  await plant(w, { ids: [a, b, c] });
  w.reopen();
  assert.deepEqual((await w.floor.ownerPending(w.owner)).items.map((i) => i.recordId), [a, b]);
  assert.deepEqual(await listed(w), [a, b, c], "a read writes nothing");
  await w.floor.sweep(w.service);
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
  try { await g.sweep(w.service); } finally { st.applyOperation = realApply; }
  assert.equal(lost, 1);
  assert.deepEqual(await listed(w), [a], "the write lost");
  assert.deepEqual((await g.ownerPending(w.owner)).items.map((i) => i.recordId), [a, b], "a read answers from the floors");
  assert.ok((await walks(w, () => g.sweep(w.service))) >= 1, "so the next reminder checks again");
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

floorSuite(test, "the first check after a start never takes off the list an inquiry another controller opened while the floors were walked: its write loses, and the next reminder stores both", async (w) => {
  const a = (await w.meet()).rec, b = (await w.meet()).rec;
  await start(w, a);
  await start(w, b);
  await open(w, a);
  w.clock.tick(1);
  const other = w.reopen();
  await other.sweep(w.service); // this controller has checked the list already, so its open below reads the list and walks no floor
  await plant(w, { ids: [] }); // a stale but well-formed list (it leaves out a)
  const g = w.reopen();
  const s = w.storage as unknown as { listAggregates: (kind: string, page: unknown) => Promise<unknown> };
  const real = s.listAggregates;
  let raced = false;
  // the walk reads its page of floors, and only then does the other controller open b: the page shows b without an inquiry
  s.listAggregates = async (kind, page) => {
    const out = await real.call(w.storage, kind, page);
    if (kind === "meeting-floor" && !raced) { raced = true; await other.openInquiry(w.owner, { commandId: cid("iq-race"), recordId: b }); }
    return out;
  };
  try { await g.sweep(w.service); } finally { s.listAggregates = real; }
  assert.equal(raced, true);
  assert.ok((await listed(w))!.includes(b), "the inquiry opened during the walk stays on the list");
  assert.deepEqual((await g.ownerPending(w.owner)).items.map((i) => i.recordId), [a, b], "a read answers from the floors");
  await g.sweep(w.service);
  assert.deepEqual(await listed(w), [a, b], "the next reminder checks again and stores both");
});

floorSuite(test, "with no list and too many floor records to build one, ending an inquiry and ending a meeting are not refused", async (w) => {
  const a = (await w.meet()).rec, b = (await w.meet()).rec, c = (await w.meet()).rec;
  await start(w, a);
  await start(w, b);
  await start(w, c);
  await open(w, a);
  await open(w, b);
  await open(w, c);
  await w.records.finish(w.owner, { commandId: cid("fin"), recordId: c }); // closed by other means: the owner's done closes its floor out
  const s = w.storage as unknown as { listAggregates: (kind: string, page: { afterId?: string; limit: number }) => Promise<unknown[]> };
  const real = s.listAggregates;
  let pages = 0;
  s.listAggregates = async (kind, page) => {
    if (kind !== "meeting-floor") return real.call(w.storage, kind, page);
    pages += 1;
    return Array.from({ length: page.limit }, (_, i) => ({ kind, id: `mfl-${String(pages).padStart(8, "0")}-${String(i).padStart(4, "0")}`, revision: 1, body: {}, createdAt: w.iso(), updatedAt: w.iso() }));
  };
  try {
    await unplant(w);
    const f = w.reopen();
    await f.endInquiry(w.owner, { commandId: cid("ie"), recordId: a });
    assert.equal((await floorOf(w, a)).inquiry, undefined, "the inquiry ended");
    await f.end(w.owner, { commandId: cid("end"), recordId: b });
    assert.equal((await floorOf(w, b)).inquiry, undefined, "the meeting ended with its inquiry");
    await f.endInquiry(w.owner, { commandId: cid("ie"), recordId: c });
    const fc = await floorOf(w, c);
    assert.deepEqual([fc.state, fc.inquiry], ["ended", undefined], "a meeting closed by other means is closed out with its inquiry");
    assert.equal(await stored(w), undefined, "no list is written from part of the floors");
    await refuses("unavailable", () => f.openInquiry(w.owner, { commandId: cid("iq"), recordId: a }));
  } finally { s.listAggregates = real; }
});

floorSuite(test, "an open whose list goes missing after the first check, with too many floor records to build it again, is refused at the write", async (w) => {
  const a = (await w.meet()).rec, x = (await w.meet()).rec;
  await start(w, a);
  await start(w, x);
  await open(w, x);
  await w.floor.ownerPending(w.owner); // the list exists and is checked, so the open's first check reads it and walks no floor
  const s = w.storage as unknown as { getAggregate: (ref: { kind: string; id: string }) => Promise<unknown>; listAggregates: (kind: string, page: { afterId?: string; limit: number }) => Promise<unknown[]> };
  const realGet = s.getAggregate, realList = s.listAggregates;
  let indexReads = 0, pages = 0;
  // the first read of the list (the open's check before any note or hold) sees it; every later read finds none, and the floors are too many to walk
  s.getAggregate = async (ref) => (ref.kind === INDEX.kind && ref.id === INDEX.id && ++indexReads > 1 ? undefined : realGet.call(w.storage, ref));
  s.listAggregates = async (kind, page) => {
    if (kind !== "meeting-floor") return realList.call(w.storage, kind, page);
    pages += 1;
    return Array.from({ length: page.limit }, (_, i) => ({ kind, id: `mfl-${String(pages).padStart(8, "0")}-${String(i).padStart(4, "0")}`, revision: 1, body: {}, createdAt: w.iso(), updatedAt: w.iso() }));
  };
  try {
    await refuses("unavailable", () => w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: a }));
  } finally { s.getAggregate = realGet; s.listAggregates = realList; }
  assert.ok(indexReads > 1, "the write read the list again");
  assert.equal((await floorOf(w, a)).inquiry, undefined, "no inquiry was opened without the list");
  assert.deepEqual(await listed(w), [x], "the stored list is unchanged");
});

floorSuite(test, "the reads (the Needs-you list and the status view's list) write nothing when the stored list is missing, untrusted or stale after a start, and answer from the floors; the walk is redone when the list changes (card U05)", async (w) => {
  const a = (await w.meet()).rec, b = (await w.meet()).rec;
  await start(w, a);
  await start(w, b);
  await open(w, a);
  w.clock.tick(1);
  await open(w, b);
  const s = w.storage as unknown as { applyOperation: (op: unknown) => Promise<unknown> };
  for (const [label, body] of [["missing", undefined], ["untrusted", { ids: "x" }], ["stale, one left out", { ids: [a] }], ["stale, an ended one kept", { ids: [a, b, fakeId(1)] }], ["empty", { ids: [] }]] as const) {
    if (body === undefined) { if (await stored(w) !== undefined) await unplant(w); } else await plant(w, body);
    const f = w.reopen();
    const before = await w.storage.getAggregate(INDEX);
    const real = s.applyOperation;
    let writes = 0;
    s.applyOperation = async (op) => { writes += 1; return real.call(w.storage, op); };
    try {
      assert.deepEqual((await f.ownerPending(w.owner)).items.map((i) => i.recordId), [a, b], `${label}: the Needs-you list`);
      assert.deepEqual((await f.openInquiries(w.owner, 10)).items.map((i) => i.recordId), [a, b], `${label}: the status view's list`);
      assert.deepEqual((await f.ownerPending(w.owner, 1)).items.map((i) => i.recordId), [a], `${label}: the limit`);
    } finally { s.applyOperation = real; }
    assert.equal(writes, 0, `${label}: no read writes`);
    assert.deepEqual(await w.storage.getAggregate(INDEX), before, `${label}: the stored list is as it was`);
  }
  // the kept walk is redone once the stored list changes: an inquiry that ends after the walk is not shown again
  await unplant(w);
  const c = (await w.meet()).rec;
  await start(w, c);
  const f = w.reopen();
  const other = w.reopen();
  assert.deepEqual((await f.openInquiries(w.owner, 10)).items.map((i) => i.recordId), [a, b]);
  await other.endInquiry(w.owner, { commandId: cid("ie"), recordId: a });
  assert.deepEqual((await f.ownerPending(w.owner)).items.map((i) => i.recordId), [b], "an inquiry another controller ended after the walk is not shown");
  await other.openInquiry(w.owner, { commandId: cid("iq"), recordId: c });
  assert.deepEqual((await f.openInquiries(w.owner, 10)).items.map((i) => i.recordId), [b, c], "an inquiry another controller opened after the walk is shown");
  // with no list and too many floor records to walk, the reads are refused and still write nothing
  await unplant(w);
  const g = w.reopen();
  const l = w.storage as unknown as { listAggregates: (kind: string, page: { afterId?: string; limit: number }) => Promise<unknown[]> };
  const realList = l.listAggregates;
  let pages = 0;
  l.listAggregates = async (kind, page) => {
    if (kind !== "meeting-floor") return realList.call(w.storage, kind, page);
    pages += 1;
    return Array.from({ length: page.limit }, (_, i) => ({ kind, id: `mfl-${String(pages).padStart(8, "0")}-${String(i).padStart(4, "0")}`, revision: 1, body: {}, createdAt: w.iso(), updatedAt: w.iso() }));
  };
  const real = s.applyOperation;
  let writes = 0;
  s.applyOperation = async (op) => { writes += 1; return real.call(w.storage, op); };
  try {
    await refuses("unavailable", () => g.ownerPending(w.owner));
    await refuses("unavailable", () => g.openInquiries(w.owner, 10));
  } finally { l.listAggregates = realList; s.applyOperation = real; }
  assert.equal(writes, 0, "a refused read writes nothing");
  assert.equal(await stored(w), undefined);
});

floorSuite(test, "a meeting that ends at a unit boundary while the owner's inquiry is open ends the inquiry with it; a floor an earlier release left ended with its inquiry open is put right by the owner's done and by the reminder", async (w) => {
  const settled: string[] = [];
  w.reopen({ settleOwner: async (x) => { settled.push(`${x.recordId} ${x.kinds.join(",")}`); } });
  const a = (await w.meet()).rec, b = (await w.meet()).rec, c = (await w.meet()).rec;
  for (const r of [a, b, c]) await start(w, r, { inquiryIdleMinutes: 10 });
  for (const r of [a, b, c]) await open(w, r);
  assert.deepEqual(await listed(w), [a, b, c]);
  // the meeting record of a ends while one of its units is in flight (the owner's question to a member)
  let armed = true;
  w.script.rules.unshift(async () => { if (armed) { armed = false; await w.records.finish(w.owner, { commandId: cid("fin"), recordId: a }); } return undefined; });
  await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: a, agent: w.pB, question: "What did the last run cost?" }).catch(() => undefined);
  for (let i = 0; i < 20 && (await floorOf(w, a)).state !== "ended"; i += 1) await w.floor.advance(w.service, { recordId: a }).catch(() => undefined);
  assert.equal(armed, false, "a unit ran");
  assert.equal((await floorOf(w, a)).state, "ended");
  assert.equal((await floorOf(w, a)).inquiry, undefined, "the inquiry ended with the meeting");
  assert.equal((await floorOf(w, a)).clock.pausedAt, undefined, "the clock is not left paused");
  assert.equal((await rawFloor(w, a)).inflight, undefined, "the dropped unit is not left in flight");
  assert.deepEqual(settled, [`${a} inquiry-open,inquiry-idle`], "its notices are closed");
  assert.deepEqual(await listed(w), [b, c], "and left the list in the same write");
  assert.deepEqual((await w.floor.ownerPending(w.owner)).items.map((i) => i.recordId), [b, c], "it is not on the Needs-you list");
  // floors an earlier release left ended with the inquiry open (the list still names them)
  for (const r of [b, c]) {
    await w.records.finish(w.owner, { commandId: cid("fin"), recordId: r });
    const agg = ((await w.storage.listAggregates("meeting-floor", { limit: 200 })) as { id: string; body: object }[]).find((x) => (x.body as FloorBody).recordId === r)!;
    assert.ok((agg.body as FloorBody).inquiry !== undefined);
    await apply(w, "meeting-floor", agg.id, (rev) => ({ type: "update", expectedRevision: rev, body: { ...agg.body, state: "ended", endedAt: w.iso() } }));
  }
  const plantedAt = w.iso();
  assert.deepEqual(await listed(w), [b, c]);
  w.clock.tick(1);
  await end(w, b);
  assert.equal((await floorOf(w, b)).inquiry, undefined, "the owner's done ends it");
  assert.equal((await floorOf(w, b)).clock.pausedAt, undefined);
  assert.equal((await floorOf(w, b)).endedAt, plantedAt, "the first end time is kept");
  assert.deepEqual(await listed(w), [c]);
  assert.deepEqual(settled.slice(1), [`${b} inquiry-open,inquiry-idle`], "its notices are closed");
  // the owner's done said again: nothing is left to end, and nothing changes
  await refuses("invalid_command", () => end(w, b));
  assert.deepEqual(await listed(w), [c]);
  assert.equal(settled.length, 2);
  w.clock.tick(11);
  assert.deepEqual((await w.floor.sweep(w.service)).reminded, [], "an ended meeting is not reminded");
  assert.equal(w.notices.filter((x) => x.kind === "inquiry-idle").length, 0, "no reminder is sent");
  assert.equal((await floorOf(w, c)).inquiry, undefined, "the reminder ends it");
  assert.equal((await floorOf(w, c)).state, "ended");
  assert.equal((await floorOf(w, c)).endedAt, plantedAt, "the first end time is kept");
  assert.deepEqual(settled.slice(2), [`${c} inquiry-open,inquiry-idle`], "its notices are closed");
  assert.deepEqual(await listed(w), []);
  // a second reminder finds nothing to do
  assert.deepEqual((await w.floor.sweep(w.service)).reminded, []);
  assert.equal(settled.length, 3);
  assert.deepEqual((await w.floor.ownerPending(w.owner)).items, []);
  assert.deepEqual((await w.floor.openInquiries(w.owner, 10)).items, []);
});

floorSuite(test, "the owner ends the meeting while the inquiry is open and a unit is in flight: the inquiry's notices are closed, it leaves the list, and the end time of the owner's end is kept at the unit boundary", async (w) => {
  const settled: string[] = [];
  w.reopen({ settleOwner: async (x) => { settled.push(`${x.recordId} ${x.kinds.join(",")}`); } });
  const a = (await w.meet()).rec, b = (await w.meet()).rec;
  for (const r of [a, b]) await start(w, r, { inquiryIdleMinutes: 10 });
  for (const r of [a, b]) await open(w, r);
  let armed = true;
  let endedAt: string | undefined;
  w.script.rules.unshift(async () => {
    if (armed) { armed = false; endedAt = w.iso(); await w.floor.end(w.owner, { commandId: cid("fe"), recordId: a }); w.clock.tick(1); }
    return undefined;
  });
  await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: a, agent: w.pB, question: "What did the last run cost?" }).catch(() => undefined);
  const raw = (rec: string): Promise<FloorBody> => rawFloor(w, rec);
  for (let i = 0; i < 20 && (armed || (await raw(a)).inflight !== undefined); i += 1) await w.floor.advance(w.service, { recordId: a }).catch(() => undefined);
  assert.equal(armed, false, "a unit ran");
  const fa = await raw(a);
  assert.equal(fa.state, "ended");
  assert.equal(fa.inflight, undefined);
  assert.equal(fa.inquiry, undefined);
  assert.equal(fa.clock.pausedAt, undefined);
  assert.equal(fa.endedAt, endedAt, "the owner's end time is kept");
  assert.ok(settled.includes(`${a} inquiry-open,inquiry-idle`), "the inquiry's notices are closed");
  assert.ok(!settled.some((x) => x.startsWith(b)), "another meeting's inquiry is left alone");
  assert.deepEqual(await listed(w), [b]);
  assert.deepEqual((await w.floor.ownerPending(w.owner)).items.map((i) => i.recordId), [b]);
  assert.equal((await floorOf(w, b)).state, "running");
  assert.ok((await floorOf(w, b)).inquiry !== undefined);
});

floorSuite(test, "the reminder goes on past a floor whose close-out fails: the next ended floor still listed with its inquiry is put right in the same turn", async (w) => {
  const b = (await w.meet()).rec, c = (await w.meet()).rec;
  const settled: string[] = [];
  // closing b's notices fails at once (not as a rejected promise), so its close-out throws
  w.reopen({ settleOwner: (x) => { if (x.recordId === b) throw new Error("the notices cannot be reached"); settled.push(x.recordId); return Promise.resolve(); } });
  for (const r of [b, c]) await start(w, r, { inquiryIdleMinutes: 10 });
  for (const r of [b, c]) await open(w, r);
  for (const r of [b, c]) {
    await w.records.finish(w.owner, { commandId: cid("fin"), recordId: r });
    const agg = ((await w.storage.listAggregates("meeting-floor", { limit: 200 })) as { id: string; body: object }[]).find((x) => (x.body as FloorBody).recordId === r)!;
    await apply(w, "meeting-floor", agg.id, (rev) => ({ type: "update", expectedRevision: rev, body: { ...agg.body, state: "ended", endedAt: w.iso() } }));
  }
  assert.deepEqual(await listed(w), [b, c]);
  assert.deepEqual((await w.floor.sweep(w.service)).reminded, []);
  assert.equal((await rawFloor(w, c)).inquiry, undefined, "the floor after the failing one is put right");
  assert.deepEqual(settled, [c]);
  assert.deepEqual(await listed(w), [], "b's own write had already taken it off the list");
});

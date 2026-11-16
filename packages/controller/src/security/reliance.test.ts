import assert from "node:assert/strict";
import { test } from "node:test";
import { relianceHead, relianceLines, relianceSummary } from "../status/reliance-words.js";
import { RELIANCE_RUNNING_MAX, RELIANCE_SCAN_MAX, relianceOf, runningWork, type Reliance } from "./reliance.js";

// T7b review: the scan caps (10,000 assignment records, 500 running attempts) and what the words say when a cap is hit. A stub runner stands in for the store: the caps need more records than a storage
// test can write in reasonable time on every backend, and only the reading logic is under test here (the storage-backed tests are in chat/grant-reliance.test.ts, on all four backends).

const NOW = "2026-10-22T10:00:00.000Z";
type Rec = { id: string; body: Record<string, unknown>; revision: number; createdAt: string; updatedAt: string };
const rec = (id: string, body: Record<string, unknown>): Rec => ({ id, body, revision: 1, createdAt: NOW, updatedAt: NOW });
const pad = (n: number) => String(n).padStart(6, "0");

/** A stub of the runner's list/get/now over in-memory records, paged by ID as the store pages them. */
function stub(kinds: Record<string, Rec[]>): never {
  const sorted = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, [...v].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))]));
  const byId = new Map<string, Rec>();
  for (const [k, v] of Object.entries(kinds)) for (const r of v) byId.set(`${k}\u0000${r.id}`, r);
  return {
    now: () => NOW,
    list: async (kind: string, q: { afterId?: string; limit: number }) => (sorted[kind] ?? []).filter((r) => q.afterId === undefined || r.id > q.afterId).slice(0, q.limit),
    get: async (kind: string, id: string) => byId.get(`${kind}\u0000${id}`),
  } as never;
}

/** `running` agent assignments with an active attempt on a ready task, then `idle` assignments with no attempt (records that are read but are no running work). */
function world(running: number, idle: number, grants: Rec[] = []): never {
  const assignment: Rec[] = [], attempt: Rec[] = [], task: Rec[] = [];
  for (let i = 0; i < running; i++) {
    assignment.push(rec(`asg-r${pad(i)}`, { taskId: `task-r${pad(i)}`, generation: 1, state: "assigned", owner: { kind: "agent", id: "ann" }, activeAttemptId: `att-${pad(i)}`, attempts: 1 }));
    attempt.push(rec(`att-${pad(i)}`, { taskId: `task-r${pad(i)}`, generation: 1, owner: { kind: "agent", id: "ann" }, number: 1, state: "active", admittedBy: "inbox" }));
    task.push(rec(`task-r${pad(i)}`, { projectId: "proj-1", title: `Task ${i}`, state: "in_progress" }));
  }
  for (let i = 0; i < idle; i++) assignment.push(rec(`asg-i${pad(i)}`, { taskId: `task-i${pad(i)}`, generation: 1, state: "assigned", owner: { kind: "agent", id: "ann" }, attempts: 0 }));
  return stub({ assignment, attempt, task, "grant-record": grants });
}
const right = (id: string, extra: Record<string, unknown> = {}): Rec => rec(id, { grantee: "agent:ann", action: "task.update", project: "*", source: "direct", decidedBy: "owner:rob", basis: "test", state: "active", ...extra });

test("the running-attempt cap: past 500 running attempts the look says it is incomplete and never reads as complete", async () => {
  const at = await runningWork(world(RELIANCE_RUNNING_MAX, 0));
  assert.deepEqual([at.work.length, at.complete], [RELIANCE_RUNNING_MAX, true], "exactly at the cap every attempt was read");
  const over = await runningWork(world(RELIANCE_RUNNING_MAX + 1, 0));
  assert.deepEqual([over.work.length, over.complete], [RELIANCE_RUNNING_MAX, false]);
  const got = (await relianceOf(world(RELIANCE_RUNNING_MAX + 1, 0, [right("grt-a")]), { grantId: "grt-a" }))!;
  const r = got.items[0]!;
  assert.deepEqual([r.total, r.items.length, r.complete], [RELIANCE_RUNNING_MAX, 10, false]);
  const lines = relianceLines(r);
  assert.match(lines[0]!, /: 500 or more running tasks may rely on it/);
  assert.match(lines.at(-1)!, /^490 more running tasks are not listed\.$/);
});

test("the record cap: past 10,000 assignment records the look says it is incomplete, also when what it read held no running work", async () => {
  const under = await runningWork(world(0, RELIANCE_SCAN_MAX - 1));
  assert.equal(under.complete, true);
  const over = await runningWork(world(0, RELIANCE_SCAN_MAX + 1));
  assert.deepEqual([over.work.length, over.complete], [0, false]);
  // Running work behind the cap is not found, and the answer does not claim there is none.
  const got = (await relianceOf(world(0, RELIANCE_SCAN_MAX + 1, [right("grt-a")]), { grantId: "grt-a" }))!;
  const r = got.items[0]!;
  assert.deepEqual([r.total, r.complete], [0, false]);
  const head = relianceHead(r);
  assert.match(head, /no running work relies on it, but not every record could be read, so some may not be listed\.$/);
  // Every active right: the summary says the look was partial whether or not some right had work.
  const all = (await relianceOf(world(0, RELIANCE_SCAN_MAX + 1, [right("grt-a"), right("grt-b", { project: "proj-2" })])))!;
  assert.match(relianceSummary(all.items, all.more), /^No running work relies on any of the 2 standing rights; not every record could be read, so some work may not be listed\.$/);
  const busy = (await relianceOf(world(RELIANCE_RUNNING_MAX + 1, 0, [right("grt-a"), right("grt-b", { project: "proj-2" })])))!;
  assert.match(relianceSummary(busy.items, busy.more), /^1 of the 2 standing rights has running work that may rely on it; not every record could be read/);
});

test("more than 50 active rights: the summary names only the rights looked at and never says nothing relies on the rest", async () => {
  const grants = Array.from({ length: 51 }, (_, i) => right(`grt-${pad(i)}`, { project: `proj-${i}` }));
  const got = (await relianceOf(world(0, 0, grants)))!;
  assert.deepEqual([got.items.length, got.more], [50, true]);
  const said = relianceSummary(got.items, got.more);
  assert.match(said, /^No running work relies on any of the first 50 standing rights looked at \(there are more, not checked here/);
  assert.doesNotMatch(said, /any of the 50 or more/);
});

test("a right that is not in force now relies on nothing: ended, not started, lapsed from non-use, or derived from a right taken back or ended", async () => {
  const parentOut = right("grt-p1", { state: "revoked" });
  const parentIn = right("grt-p2");
  const grants = [
    right("grt-ended", { expiresAt: "2026-10-01T00:00:00.000Z" }),
    right("grt-later", { notBefore: "2026-12-01T00:00:00.000Z" }),
    right("grt-lapsed", { idleDays: 3, lastUsedAt: "2026-10-01T00:00:00.000Z" }),
    right("grt-unused", { idleDays: 30, lastUsedAt: "2026-10-01T00:00:00.000Z" }),
    right("grt-kid1", { source: "derived", parentId: "grt-p1" }),
    right("grt-kid2", { source: "derived", parentId: "grt-p2" }),
    right("grt-kid3", { source: "derived", parentId: "grt-missing" }),
    right("grt-open"),
    parentOut, parentIn,
  ];
  const w = world(2, 0, grants);
  const of = async (id: string) => (await relianceOf(w, { grantId: id }))!.items[0]!;
  for (const id of ["grt-ended", "grt-later", "grt-lapsed", "grt-kid1", "grt-kid3"]) {
    const r = await of(id);
    assert.deepEqual([id, r.state, r.inForce, r.total, r.items.length], [id, "active", false, 0, 0]);
    assert.match(relianceHead(r), /is not in force now \(it ended, lapsed or has not started\), so no running work relies on it now\.$/);
  }
  for (const id of ["grt-unused", "grt-kid2", "grt-open"]) {
    const r = await of(id);
    assert.deepEqual([id, r.inForce, r.total], [id, true, 2]);
  }
  const revoked = await of("grt-p1");
  assert.deepEqual([revoked.state, revoked.inForce, revoked.total], ["revoked", false, 0]);
  assert.match(relianceHead(revoked), /is already taken back\.$/);
  // A right on a principal that is not an agent (a host, a service) covers no agent's work.
  const host = (await relianceOf(world(2, 0, [right("grt-host", { grantee: "host:box" })]), { grantId: "grt-host" }))!.items[0]!;
  assert.deepEqual([host.inForce, host.total], [true, 0]);
});

test("the words stay within their bounds for long, hostile and emoji names and titles", () => {
  const long = "\u{1F600}".repeat(200);
  // The IDs and the action are as long as the controller lets them be (an action is at most 60 characters, a principal 46, a project 25); a title is anything an author wrote.
  const r: Reliance = { grantId: "grt-" + "a".repeat(20), grantee: "agent:" + "a".repeat(40), action: "tool." + "x".repeat(55), project: "proj-" + "b".repeat(20), state: "active", inForce: true, revision: 1, total: 12, complete: false,
    items: Array.from({ length: 10 }, (_, i) => ({ agentId: "a".repeat(40), taskId: "task-" + "c".repeat(20), title: `${long}\u202e<b>sk-LEAK-0123456789abcdef`, projectId: "p", attemptId: "a", attemptNumber: i + 1 })) };
  const cutAt = relianceLines({ ...r, items: [{ ...r.items[0]!, title: "x".repeat(56) + "\u{1F600}" + "y".repeat(20) }] })[1]!;
  assert.match(cutAt, /^"x{56}\.\.\." is running/, "an emoji at the cut point is left out whole");
  const lines = relianceLines(r);
  assert.equal(lines.length, 12);
  for (const l of lines) {
    assert.ok(l.length < 400, `${l.length}: ${l}`);
    assert.doesNotMatch(l, /\u202e|sk-LEAK/);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(l), "no half of a character is left at a cut");
  }
  assert.ok(relianceHead(r, 2).length < 400);
  assert.ok(relianceHead({ ...r, inForce: false }).length < 400);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNER_LOAD_LIMITS, ownerLoadReport, parseAuditLines, readAuditLog, type OwnerLoadRecord } from "./owner-load.js";

// Card Y02: the owner-decisions-per-day and stall report. The pure rules here; the same report over the audit a real controller wrote on every backend is in stall.test.ts.
let seq = 0;
const rec = (at: string, actor: string, type: string, extra: Partial<OwnerLoadRecord> = {}): OwnerLoadRecord => ({ seq: ++seq, operationId: `op-${seq}`, actor, at, type, detail: {}, ...extra });
const concern = (at: string, id: string, taskId: string, state: string, kind = "silent"): OwnerLoadRecord => rec(at, "controller", "stall.concern", { subject: { kind: "stall-concern", id }, detail: { taskId, state, kind } });
const task = (at: string, taskId: string, projectId: string): OwnerLoadRecord => rec(at, "owner:rob", "task.create", { subject: { kind: "task", id: taskId }, detail: { projectId } });

test("owner decisions: distinct owner operations per UTC day in the window; agents, the controller and owner-like helpers are not counted", () => {
  const shared = rec("2026-11-02T10:00:00.000Z", "owner:rob", "task.update");
  const records = [
    rec("2026-10-31T23:59:59.000Z", "owner:rob", "task.create"), // before the window
    rec("2026-11-01T00:00:00.000Z", "owner:rob", "task.create"),
    rec("2026-11-01T12:00:00.000Z", "agent:ann", "task.update"),
    rec("2026-11-01T12:00:00.000Z", "controller", "stall.report"),
    rec("2026-11-01T13:00:00.000Z", "owner:meeting-record", "meeting.record"),
    shared, { ...shared, seq: ++seq, type: "effect.settled" }, // two audit records of one operation: one decision
    rec("2026-11-03T23:59:59.999Z", "owner:rob", "grant.accept"),
    rec("2026-11-04T00:00:00.000Z", "owner:rob", "grant.accept"), // after the window
  ];
  const r = ownerLoadReport(records, { now: "2026-11-03T18:00:00.000Z", days: 3 });
  assert.deepEqual([r.from, r.to, r.days], ["2026-11-01", "2026-11-03", 3]);
  assert.deepEqual(r.perDay, [{ day: "2026-11-01", ownerDecisions: 1 }, { day: "2026-11-02", ownerDecisions: 1 }, { day: "2026-11-03", ownerDecisions: 1 }]);
  assert.deepEqual([r.ownerDecisions, r.maxOwnerDecisionsPerDay, r.averageOwnerDecisionsPerDay, r.recordsRead], [3, 1, 1, records.length]);
  // A second owner (two owners can exist) is still the owner.
  assert.equal(ownerLoadReport([rec("2026-11-03T01:00:00.000Z", "owner:ann", "x")], { now: "2026-11-03T18:00:00.000Z", days: 1 }).ownerDecisions, 1);
});

test("stalls: open from suspected or confirmed to cleared or dismissed; a reopened concern is a second stall; one still open runs to now", () => {
  const records = [
    task("2026-11-01T00:00:00.000Z", "t1", "p1"), task("2026-11-01T00:00:00.000Z", "t2", "p2"), task("2026-11-01T00:00:00.000Z", "t3", "p1"),
    concern("2026-11-01T08:00:00.000Z", "c1", "t1", "suspected"),
    concern("2026-11-01T08:30:00.000Z", "c1", "t1", "confirmed"), // still the same stall
    concern("2026-11-01T09:00:00.000Z", "c2", "t2", "suspected", "loop"), // another project, while c1 is open
    concern("2026-11-01T09:30:00.000Z", "c2", "t2", "dismissed"),
    concern("2026-11-01T10:00:00.000Z", "c1", "t1", "cleared"),
    concern("2026-11-01T11:00:00.000Z", "c3", "t3", "suspected"), // same project as t1, after c1 ended: reaches nothing, reached by nothing
    concern("2026-11-01T12:00:00.000Z", "c1", "t1", "suspected"), // reopened: a new stall, open at the end, reached by nothing later... t3's is earlier
  ];
  const r = ownerLoadReport(records, { now: "2026-11-01T14:00:00.000Z", days: 1 });
  assert.equal(r.stallCount, 4);
  assert.deepEqual(r.stalls.map((s) => [s.concernId, s.taskId, s.projectId, s.kind, s.endState ?? "open", s.openMinutes]), [
    ["c1", "t1", "p1", "silent", "cleared", 120], ["c2", "t2", "p2", "loop", "dismissed", 30], ["c3", "t3", "p1", "silent", "open", 180], ["c1", "t1", "p1", "silent", "open", 120],
  ]);
  assert.deepEqual(r.stalls[0]!.reached, [{ taskId: "t2", projectId: "p2", sameProject: false, openedAt: "2026-11-01T09:00:00.000Z" }]);
  assert.deepEqual(r.stalls[2]!.reached, [{ taskId: "t1", projectId: "p1", sameProject: true, openedAt: "2026-11-01T12:00:00.000Z" }], "a stall on another task of the same project is listed with sameProject true");
  assert.deepEqual(r.stalls[3]!.reached, [], "its own task's earlier stall is not unrelated work");
  assert.equal(r.stallsReachingUnrelatedWork, 2);
  // A project not known from the log gives null, not a guess.
  const unknown = ownerLoadReport([concern("2026-11-01T08:00:00.000Z", "a", "x", "suspected"), concern("2026-11-01T08:01:00.000Z", "b", "y", "suspected")], { now: "2026-11-01T09:00:00.000Z", days: 1 });
  assert.deepEqual(unknown.stalls[0]!.reached.map((x) => [x.projectId, x.sameProject]), [[null, null]]);
});

test("stalls outside the window are left out; one that began before the window and was still open inside it is kept", () => {
  const records = [
    concern("2026-10-20T08:00:00.000Z", "old", "t1", "suspected"), concern("2026-10-20T09:00:00.000Z", "old", "t1", "cleared"),
    concern("2026-10-25T08:00:00.000Z", "long", "t2", "suspected"), concern("2026-11-01T09:00:00.000Z", "long", "t2", "cleared"),
  ];
  const r = ownerLoadReport(records, { now: "2026-11-01T12:00:00.000Z", days: 2 });
  assert.deepEqual(r.stalls.map((s) => s.concernId), ["long"]);
});

test("malformed records are counted and named, not silently dropped; bad options are refused", () => {
  const r = ownerLoadReport([rec("not a time", "owner:rob", "x"), rec("2026-11-01T08:00:00.000Z", "controller", "stall.concern", { subject: { kind: "stall-concern", id: "c" }, detail: { state: "suspected" } })], { now: "2026-11-01T12:00:00.000Z", days: 1 });
  assert.equal(r.ownerDecisions, 0);
  assert.ok(r.notes.some((n) => /2 audit records were malformed/.test(n)), r.notes.join("; "));
  assert.ok(ownerLoadReport([], { now: "2026-11-01T12:00:00.000Z", truncated: true }).notes.some((n) => /cut at/.test(n)));
  for (const days of [0, OWNER_LOAD_LIMITS.maxDays + 1, 1.5]) assert.throws(() => ownerLoadReport([], { now: "2026-11-01T12:00:00.000Z", days }), RangeError);
  assert.throws(() => ownerLoadReport([], { now: "yesterday" }), RangeError);
});

test("an exported audit log is read in either the listAudit shape or the snapshot row shape; a bad line is an error with its number", () => {
  const raw = [
    JSON.stringify({ seq: 1, operationId: "o1", correlationId: "c", actor: "owner:rob", at: "2026-11-01T08:00:00.000Z", type: "task.create", subject: { kind: "task", id: "t1" }, detail: { projectId: "p1" } }),
    "",
    JSON.stringify({ seq: 2, operation_id: "o2", correlation_id: "c", actor: "controller", at: "2026-11-01T09:00:00.000Z", type: "stall.concern", subject_kind: "stall-concern", subject_id: "c1", detail: JSON.stringify({ taskId: "t1", state: "suspected", kind: "silent" }) }),
  ].join("\r\n");
  const parsed = parseAuditLines(raw);
  assert.ok("records" in parsed);
  assert.deepEqual(parsed.records.map((r) => [r.seq, r.operationId, r.subject?.kind, r.detail["taskId"] ?? r.detail["projectId"]]), [[1, "o1", "task", "p1"], [2, "o2", "stall-concern", "t1"]]);
  const r = ownerLoadReport(parsed.records, { now: "2026-11-01T12:00:00.000Z", days: 1 });
  assert.deepEqual([r.ownerDecisions, r.stalls[0]!.projectId], [1, "p1"]);
  for (const [bad, why] of [["{", /line 1: not JSON/], ["[1]", /line 1: not an object/], [`${JSON.stringify({ seq: 1, operationId: "o", actor: "a", at: "2026-11-01T00:00:00Z", type: "t", detail: {} })}\n{"seq":"2"}`, /line 2: an audit record needs/], [JSON.stringify({ seq: 1, operation_id: "o", actor: "a", at: "2026-11-01T00:00:00Z", type: "t", detail: "{" }), /detail is not JSON/], [JSON.stringify({ seq: 1, operationId: "o", actor: "a", at: "soon", type: "t", detail: {} }), /needs seq/]] as const) {
    const p = parseAuditLines(bad);
    assert.ok("error" in p && why.test(p.error), JSON.stringify(p));
  }
  const two = `${JSON.stringify({ seq: 1, operationId: "o", actor: "a", at: "2026-11-01T00:00:00Z", type: "t", detail: {} })}\n`.repeat(2);
  const capped = parseAuditLines(two, 1);
  assert.ok("error" in capped && /more than 1/.test(capped.error));
});

test("the whole audit log is read a page at a time, and a limit says it cut", async () => {
  const all = Array.from({ length: 2500 }, (_, i) => ({ seq: i + 1, operationId: `o${i}`, correlationId: "c", actor: "owner:rob", at: "2026-11-01T00:00:00.000Z", type: "t", detail: {} }));
  const asked: number[] = [];
  const storage = { listAudit: async ({ afterSeq, limit }: { afterSeq: number; limit: number }) => { asked.push(afterSeq); return all.filter((r) => r.seq > afterSeq).slice(0, limit); } };
  const full = await readAuditLog(storage);
  assert.deepEqual([full.records.length, full.truncated, asked], [2500, false, [0, 1000, 2000]]);
  const cut = await readAuditLog(storage, 1500);
  assert.deepEqual([cut.records.length, cut.truncated], [1500, true]);
  // Exactly a page boundary: one more (empty) page is read and nothing is cut.
  const exact = { listAudit: async ({ afterSeq, limit }: { afterSeq: number; limit: number }) => all.slice(0, 2000).filter((r) => r.seq > afterSeq).slice(0, limit) };
  assert.deepEqual([(await readAuditLog(exact)).records.length, (await readAuditLog(exact)).truncated], [2000, false]);
});

test("two concerns of one task (two kinds) are one task's trouble, not unrelated work reached", () => {
  const r = ownerLoadReport([
    concern("2026-11-01T08:00:00.000Z", "t1-silent", "t1", "suspected", "silent"),
    concern("2026-11-01T08:10:00.000Z", "t1-loop", "t1", "suspected", "loop"),
  ], { now: "2026-11-01T09:00:00.000Z", days: 1 });
  assert.equal(r.stallCount, 2);
  assert.deepEqual(r.stalls.map((s) => s.reached.length), [0, 0]);
  assert.equal(r.stallsReachingUnrelatedWork, 0);
});

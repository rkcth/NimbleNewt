import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { DeskService, WorkingNoteService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { InspectionService } from "../context/index.js";
import { InspectionService as Inspections } from "../context/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { ContractService } from "../planning/contracts.js";
import { StatusService } from "../status/index.js";
import { MeetingDeskReadService, MeetingRecordService, MeetingService, REFUSED_OPERATIONS } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-20T08:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, (error as Error).message); return true; });
};

for (const backend of backends) {
  test(`${backend.name}: the chair's meeting desk read is read-only, recorded once per file read, and records both revisions of a changed file`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      const agents = AgentService.withEpoch(world.storage, epoch, options);
      const grants = GrantService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
      const other = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "B" })).id;
      const ids: string[] = [];
      for (const nm of ["A", "B", "C", "D", "E"]) ids.push(`agent:${(await agents.create(owner, { commandId: cid("ag"), friendlyName: nm })).id}`);
      const [pA, pB, pC, pD, pE] = ids as [string, string, string, string, string];
      await grants.grant(owner, { commandId: cid("g"), grantee: pD, action: "desk.scratch.read", project, source: "direct", basis: "test" } as never);
      const login = async (id: string): Promise<Principal> => principals.authenticate((await principals.issueCredential(owner, id)).token);
      for (const p of [pB, pC]) for (const pr of [project, other]) await grants.grant(owner, { commandId: cid("g"), grantee: p, action: "desk.write", project: pr, source: "direct", basis: "test" } as never);
      const [asA, asB, asC, asD, asE] = [await login(pA), await login(pB), await login(pC), await login(pD), await login(pE)] as [Principal, Principal, Principal, Principal, Principal];
      const mgr = await (async () => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "mgr", grants: [{ action: "meeting.manage", project }] }); return principals.authenticate((await principals.issueCredential(owner, "agent:mgr")).token); })();
      const meetings = MeetingService.withEpoch(world.storage, epoch, {}, { ...options, availability: async () => "available" });
      const records = MeetingRecordService.withEpoch(world.storage, epoch, { meetings, decisions: undefined as never }, { ...options, authority: async () => undefined } as never);
      const desks = DeskService.withEpoch(world.storage, epoch, options);
      const reads = MeetingDeskReadService.withEpoch(world.storage, epoch, options);
      const occ = (await meetings.callUrgent(mgr, { commandId: cid("urg"), projectId: project, title: "Sync", reason: "decide something", roster: [pA, pB, pC] })).id;
      const rec = (await records.open(mgr, { commandId: cid("open"), occurrenceId: occ, chair: pD })).id;
      // A speaks, so A is present; B and C are absent.
      await records.append(asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "I am here." } as never);

      const w = (by: Principal, projectId: string, title: string, body: string, visibility: "shared" | "private" = "shared", status: "draft" | "accepted" = "accepted") =>
        desks.write(by, { commandId: cid("w"), projectId, kind: "note", title, body, visibility, status } as never);
      const f1draft = await w(asB, project, "plan", "B's plan, first", "shared", "draft");
      const draft = await w(asB, project, "wip", "B's draft", "shared", "draft");
      const f2 = await w(asB, project, "scratch", "B's private thinking", "private");
      const f3 = await w(asB, project, "unread", "never read in the meeting");
      const foreign = await w(asB, other, "elsewhere", "another project");
      const present = await w(asA as never, project, "mine", "A is present").catch(() => undefined);

      await refuses("forbidden", () => reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f1draft.id }));
      const f1 = await desks.revise(asB, { commandId: cid("rv"), recordId: f1draft.id, expectedRevision: f1draft.revision, body: "B's plan", status: "accepted" } as never);
      const snapshot = async () => JSON.stringify(await Promise.all([f1, f2, f3, foreign].map((f) => world.storage.getAggregate({ kind: "desk-record", id: f.id }))));
      const before = await snapshot();

      // (b) one record per file read, none for files not read; the record names occurrence, file, revision, digest, bytes, reader, time.
      const r1 = await reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f1.id });
      assert.equal(r1.record!.body, "B's plan");
      await reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f2.id });
      const list = (await reads.reads(owner, { occurrenceId: occ })).reads;
      assert.equal(list.length, 2);
      const one = list.find((x) => x.deskRecordId === f1.id)!;
      assert.deepEqual({ o: one.occurrenceId, m: one.meetingRecordId, owner: one.deskOwner, rev: one.deskRevision, reader: one.reader, at: one.at, bytes: one.bytes }, { o: occ, m: rec, owner: pB, rev: f1.revision, reader: pD, at: options.clock(), bytes: Buffer.byteLength("plan" + "B's plan") });
      assert.match(one.sha256, /^[0-9a-f]{64}$/);
      assert.ok(!list.some((x) => x.deskRecordId === f3.id), "an unread file leaves no record");
      // The desk's owner and the roster see the reads; an agent outside the roster and not the chair sees none.
      assert.equal((await reads.reads(asB, { occurrenceId: occ })).reads.length, 2);
      assert.equal((await reads.reads(asC, { occurrenceId: occ })).reads.length, 2, "a roster member sees the reads of the occurrence");
      assert.equal((await reads.reads(asE, { occurrenceId: occ })).reads.length, 0);
      // A repeated command is the same read: no second record.
      const again = await reads.read(asD, { commandId: "rd-replay", meetingRecordId: rec, deskRecordId: f3.id });
      const again2 = await reads.read(asD, { commandId: "rd-replay", meetingRecordId: rec, deskRecordId: f3.id });
      assert.equal(again2.replayed, true); assert.equal(again2.record, undefined); assert.equal(again.readId, again2.readId);
      assert.equal((await reads.reads(owner, { occurrenceId: occ })).reads.length, 3);

      // (c) the same accepted revision read twice is two records with the same digest (an accepted record is never edited in place).
      const second = f1;
      const r2 = await reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f1.id });
      assert.equal(r2.record!.body, "B's plan");
      const hist = (await reads.reads(owner, { occurrenceId: occ, deskRecordId: f1.id })).reads;
      assert.deepEqual(hist.map((h) => h.deskRevision), [f1.revision, second.revision]);
      assert.equal(hist[0]!.sha256, hist[1]!.sha256);

      // Refusals: not the chair, a present member's desk, another project's desk, a missing file.
      await refuses("forbidden", () => reads.read(asC, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f1.id }));
      await refuses("forbidden", () => reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: foreign.id }));
      if (present !== undefined) await refuses("forbidden", () => reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: present.id }));
      await refuses("forbidden", () => reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: "dsk-aaaaaaaaaaaaaaaaaaaa" }));
      const total = (await reads.reads(owner, { occurrenceId: occ })).reads.length;
      assert.equal(total, 4, "refused reads leave no record");

      // (a) read-only: the service has no mutating method, and the desk records are unchanged by reads (only the revise above moved f1).
      const methods = Object.getOwnPropertyNames(MeetingDeskReadService.prototype).filter((m) => m !== "constructor").sort();
      assert.deepEqual(methods, ["attemptChange", "attempts", "read", "readNote", "reads"]);
      assert.ok(!methods.some((m) => /write|revise|delete|rename|remove|lock|update/i.test(m)));
      const after1 = JSON.stringify(await Promise.all([f2, f3, foreign].map((f) => world.storage.getAggregate({ kind: "desk-record", id: f.id }))));
      assert.equal(after1, JSON.stringify(JSON.parse(before).slice(1)), "reads changed no desk record");

      // The digest and size cover exactly what was returned (title and body), and the returned content has nothing else of the record.
      assert.deepEqual(Object.keys(r2.record!).sort(), ["body", "id", "revision", "title"]);
      const last = hist.find((h) => h.deskRevision === second.revision)!;
      assert.equal(last.sha256, createHash("sha256").update(JSON.stringify([r2.record!.title, r2.record!.body])).digest("hex"));
      assert.equal(last.bytes, Buffer.byteLength(r2.record!.title + r2.record!.body, "utf8"));

      // Chair checks as in record.ts: an agent, authenticated (asOf), and in task scope of the meeting's project.
      const rdc = (by: Principal) => reads.read(by, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f3.id });
      await refuses("forbidden", () => rdc({ ...asD, taskScope: { taskId: "tsk-aaaaaaaaaaaaaaaaaaaa", projectId: other } } as Principal));
      await refuses("forbidden", () => rdc({ ...asD, asOf: undefined } as unknown as Principal));
      await refuses("forbidden", () => rdc({ ...asD, kind: "service" } as unknown as Principal));
      assert.equal((await reads.reads(owner, { occurrenceId: occ })).reads.length, 4, "refused reads leave no record");

      // A draft is never returned; a private record needs the exact scratch grant and is refused under a 'denied' inspection policy.
      await refuses("forbidden", () => reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: draft.id }));
      const inspection = InspectionService.withEpoch(world.storage, epoch, options);
      const f4 = await w(asB, project, "scratch2", "B's second private note", "private");
      await inspection.setPolicy(owner, { commandId: cid("pol"), scratch: "denied" });
      await refuses("forbidden", () => reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f4.id }));
      assert.equal((await reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f3.id })).record!.body, "never read in the meeting", "shared records are still readable");
      await inspection.setPolicy(owner, { commandId: cid("pol"), scratch: "allowed", expectedRevision: 1 });
      assert.equal((await reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f4.id })).record!.body, "B's second private note");
      // A chair without the scratch grant cannot read private records (a second occurrence is not needed: use the ungranted principal on the same meeting via setChair).
      const noScratch = { ...asD, grants: asD.grants.filter((g) => g.action !== "desk.scratch.read") } as Principal;
      await refuses("forbidden", () => reads.read(noScratch, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f2.id }));
      assert.equal((await reads.reads(owner, { occurrenceId: occ })).reads.length, 6);

      // Paging: default 100, a cursor, a maximum of 500, and a later chair sees the reads of the occurrence.
      const p1 = await reads.reads(owner, { occurrenceId: occ, limit: 4 });
      assert.equal(p1.reads.length, 4); assert.ok(p1.next !== undefined);
      const p2 = await reads.reads(owner, { occurrenceId: occ, limit: 4, after: p1.next! });
      assert.equal(p2.reads.length, 2); assert.equal(p2.next, undefined);
      assert.deepEqual([...p1.reads, ...p2.reads].map((x) => x.id), (await reads.reads(owner, { occurrenceId: occ })).reads.map((x) => x.id));
      await refuses("invalid_command", () => reads.reads(owner, { occurrenceId: occ, limit: 501 }));
      await refuses("invalid_command", () => reads.reads(owner, { occurrenceId: occ, limit: 0 }));
      await records.setChair(mgr, { commandId: cid("chair"), recordId: rec, chair: pE } as never);
      assert.equal((await reads.reads(asE, { occurrenceId: occ })).reads.length, 6, "a later chair sees the reads of the occurrence");
      await refuses("forbidden", () => reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f3.id }));

      // The meeting ends: reads are refused.
      await records.finish(owner, { commandId: cid("end"), recordId: rec });
      await refuses("forbidden", () => reads.read(asE, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f3.id }));
      assert.equal((await reads.reads(owner, { occurrenceId: occ })).reads.length, 6);
    } finally { await world.close(); }
  });
}

/** A storage that refuses to commit while `broken.on` is set; everything else is the real thing. */
const flaky = (storage: ControllerStorage, broken: { on: boolean }): ControllerStorage => new Proxy(storage, {
  get(target, prop) {
    const value = Reflect.get(target, prop, target) as unknown;
    if (prop === "applyOperation") return async (...args: unknown[]) => { if (broken.on) throw new Error("the disk went away"); return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args); };
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  },
});

/** A storage that runs `before` (once, when set) just ahead of the next commit of a chair read or attempt: another writer getting in between the read and its commit. */
const racing = (storage: ControllerStorage, hook: { before?: (() => Promise<void>) | undefined }): ControllerStorage => new Proxy(storage, {
  get(target, prop) {
    const value = Reflect.get(target, prop, target) as unknown;
    if (prop === "applyOperation") return async (...args: unknown[]) => {
      const op = args[0] as { audit?: readonly { type: string }[] };
      const run = hook.before;
      if (run !== undefined && op.audit?.some((a) => a.type.startsWith("meeting.desk-") || a.type === "meeting.note-read") === true) { hook.before = undefined; await run(); }
      return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
    };
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  },
});

for (const backend of backends) {
  test(`${backend.name}: a chair read or refused attempt that races another writer of the meeting is done again, not lost or misreported; concurrent attempts are all counted`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      const agents = AgentService.withEpoch(world.storage, epoch, options);
      const grants = GrantService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
      const ids: string[] = [];
      for (const nm of ["A", "B", "D"]) ids.push(`agent:${(await agents.create(owner, { commandId: cid("ag"), friendlyName: nm })).id}`);
      const [pA, pB, pD] = ids as [string, string, string];
      await grants.grant(owner, { commandId: cid("g"), grantee: pB, action: "desk.write", project, source: "direct", basis: "test" } as never);
      const login = async (id: string): Promise<Principal> => principals.authenticate((await principals.issueCredential(owner, id)).token);
      const [asA, asB, asD] = [await login(pA), await login(pB), await login(pD)] as [Principal, Principal, Principal];
      const mgr = await (async () => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "mgr", grants: [{ action: "meeting.manage", project }] }); return principals.authenticate((await principals.issueCredential(owner, "agent:mgr")).token); })();
      const meetings = MeetingService.withEpoch(world.storage, epoch, {}, { ...options, availability: async () => "available" });
      const records = MeetingRecordService.withEpoch(world.storage, epoch, { meetings, decisions: undefined as never }, { ...options, authority: async () => undefined } as never);
      const desks = DeskService.withEpoch(world.storage, epoch, options);
      const notes = WorkingNoteService.withEpoch(world.storage, epoch, options);
      const occ = (await meetings.callUrgent(mgr, { commandId: cid("urg"), projectId: project, title: "Sync", reason: "decide something", roster: [pA, pB] })).id;
      const rec = (await records.open(mgr, { commandId: cid("open"), occurrenceId: occ, chair: pD })).id;
      await records.append(asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "I am here." } as never);
      const file = await desks.write(asB, { commandId: cid("w"), projectId: project, kind: "note", title: "plan", body: "B's plan", visibility: "shared", status: "accepted" } as never);
      const shared = await notes.write(asB, { commandId: cid("n"), projectId: project, category: "status", title: "Status", body: "Step three." });
      const hook: { before?: (() => Promise<void>) | undefined } = {};
      const reads = MeetingDeskReadService.withEpoch(racing(world.storage, hook), epoch, options);
      const speak = () => async () => { await records.append(asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "Still talking." } as never); };

      // A present member speaks between the chair's read and its commit (the meeting record moves on): the read is done again and succeeds, once.
      hook.before = speak();
      assert.equal((await reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: file.id })).record!.body, "B's plan");
      assert.equal(hook.before, undefined, "the race happened");
      hook.before = speak();
      assert.equal((await reads.readNote(asD, { commandId: cid("nr"), meetingRecordId: rec, noteId: shared.id })).record!.body, "Step three.");
      // B revises its note in between: the read returns the new revision, and the record names it.
      hook.before = async () => { await notes.revise(asB, { commandId: cid("rv"), noteId: shared.id, expectedRevision: shared.revision, body: "Step four." }); };
      const fresh = await reads.readNote(asD, { commandId: cid("nr"), meetingRecordId: rec, noteId: shared.id });
      assert.equal(fresh.record!.body, "Step four.");
      assert.ok(fresh.record!.revision > shared.revision);
      const listed = (await reads.reads(owner, { occurrenceId: occ })).reads;
      assert.equal(listed.length, 3, "one record per read, none left by the lost tries");
      assert.equal(listed.find((r) => r.id === fresh.readId)!.deskRevision, fresh.record!.revision);
      assert.equal((await world.storage.listAggregates("inspection", { limit: 100 })).length, 3, "one inspection per read");
      // An attempt racing a statement is refused as forbidden (not a command conflict) and counted.
      hook.before = speak();
      await refuses("forbidden", () => reads.attemptChange(asD, { commandId: cid("at"), meetingRecordId: rec, targetId: file.id, operation: "write" }));
      // Attempts sent at the same moment are each refused and each counted, exactly once.
      await Promise.all(Array.from({ length: 4 }, () => refuses("forbidden", () => reads.attemptChange(asD, { commandId: cid("at"), meetingRecordId: rec, targetId: file.id, operation: "write" }))));
      assert.equal((await reads.attempts(owner, { occurrenceId: occ })).attempts.find((t) => t.operation === "write")!.count, 5);
    } finally { await world.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: the chair's desk read leaves a record per file (and an inspection the owner of the file sees), refuses and records attempts to change, reads shared notes as shared, disturbs nobody, and survives a restart`, async () => {
    const world = await backend.open();
    try {
      let tick = 0;
      const clock = () => new Date(Date.UTC(2026, 9, 20, 8, 0, 0) + tick * 1000).toISOString();
      const opts = { clock, pause: async () => undefined };
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...opts });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, opts);
      const agents = AgentService.withEpoch(world.storage, epoch, opts);
      const grants = GrantService.withEpoch(world.storage, epoch, opts);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
      const other = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "B" })).id;
      const ids: string[] = [];
      for (const nm of ["A", "B", "C", "D", "E"]) ids.push(`agent:${(await agents.create(owner, { commandId: cid("ag"), friendlyName: nm })).id}`);
      const [pA, pB, pC, pD, pE] = ids as [string, string, string, string, string];
      for (const p of [pA, pB]) for (const pr of [project, other]) await grants.grant(owner, { commandId: cid("g"), grantee: p, action: "desk.write", project: pr, source: "direct", basis: "test" } as never);
      const login = async (id: string): Promise<Principal> => principals.authenticate((await principals.issueCredential(owner, id)).token);
      const [asA, asB, asC, asD, asE] = [await login(pA), await login(pB), await login(pC), await login(pD), await login(pE)] as [Principal, Principal, Principal, Principal, Principal];
      const mgr = await (async () => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "mgr", grants: [{ action: "meeting.manage", project }] }); return principals.authenticate((await principals.issueCredential(owner, "agent:mgr")).token); })();
      const meetings = MeetingService.withEpoch(world.storage, epoch, {}, { ...opts, availability: async () => "available" });
      const records = MeetingRecordService.withEpoch(world.storage, epoch, { meetings, decisions: undefined as never }, { ...opts, authority: async () => undefined } as never);
      const desks = DeskService.withEpoch(world.storage, epoch, opts);
      const notes = WorkingNoteService.withEpoch(world.storage, epoch, opts);
      const inspections = Inspections.withEpoch(world.storage, epoch, opts);
      const reads = MeetingDeskReadService.withEpoch(world.storage, epoch, opts);
      const occ = (await meetings.callUrgent(mgr, { commandId: cid("urg"), projectId: project, title: "Sync", reason: "decide something", roster: [pA, pB, pC] })).id;
      const rec = (await records.open(mgr, { commandId: cid("open"), occurrenceId: occ, chair: pD })).id;
      await records.append(asA, { commandId: cid("s"), recordId: rec, kind: "statement", text: "I am here." } as never);
      const file = await desks.write(asB, { commandId: cid("w"), projectId: project, kind: "note", title: "plan", body: "B's plan", visibility: "shared", status: "accepted" } as never);
      const file2 = await desks.write(asB, { commandId: cid("w"), projectId: project, kind: "note", title: "plan 2", body: "B's second plan", visibility: "shared", status: "accepted" } as never);
      const shared = await notes.write(asB, { commandId: cid("n"), projectId: project, category: "status", title: "Status", body: "Step three of five." });
      const hidden = await notes.write(asB, { commandId: cid("n"), projectId: project, category: "status", title: "Mine", body: "private text" });
      await notes.setVisibility(asB, { commandId: cid("v"), noteId: hidden.id, expectedRevision: hidden.revision, visibility: "private" });
      const foreign = await notes.write(asB, { commandId: cid("n"), projectId: other, category: "status", title: "Elsewhere", body: "another project" });
      const presentNote = await notes.write(asA, { commandId: cid("n"), projectId: project, category: "status", title: "Here", body: "from a present member" });
      const gone = await notes.write(asB, { commandId: cid("n"), projectId: project, category: "status", title: "Removed", body: "soon gone" });
      await notes.delete(owner, { commandId: cid("d"), noteId: gone.id, expectedRevision: gone.revision, reason: "test" });

      // The chair has no desk or notes grant at all: a note read needs none.
      assert.ok(!asD.grants.some((g) => g.action === "desk.read" || g.action === "notes.chair.read"));
      const auditAfter = async (seq: number) => { const out: Awaited<ReturnType<typeof world.storage.listAudit>> = []; for (;;) { const page = await world.storage.listAudit({ afterSeq: out.at(-1)?.seq ?? seq, limit: 1000 }); out.push(...page); if (page.length < 1000) return out; } };
      const marker = (await auditAfter(0)).at(-1)!.seq;
      const kinds = ["desk-record", "agent", "working-note", "working-note-version", "meeting-record", "principal", "grant"];
      const snap = async () => JSON.stringify(await Promise.all(kinds.map(async (k) => [k, await world.storage.listAggregates(k, { limit: 1000 })])));
      const before = await snap();

      // A note read: no grant, a present member's shared note too; the record says note and shared and the note's agent sees it as an inspection by the meeting chair.
      tick = 10;
      const n1 = await reads.readNote(asD, { commandId: cid("nr"), meetingRecordId: rec, noteId: shared.id });
      assert.deepEqual([n1.record!.title, n1.record!.body, n1.record!.revision], ["Status", "Step three of five.", shared.revision]);
      tick = 11;
      assert.equal((await reads.readNote(asD, { commandId: cid("nr"), meetingRecordId: rec, noteId: presentNote.id })).record!.body, "from a present member");
      tick = 12;
      const d1 = await reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: file.id });
      assert.equal(d1.record!.body, "B's plan");
      const after = await snap();
      assert.equal(after, before, "reads changed no desk record, note, agent, grant, principal or meeting record");
      // Every write the system made since is audited; there are exactly the three reads, all by the chair, and nothing for the member whose files were read.
      const audit = await auditAfter(marker);
      assert.equal(audit.length, 3, JSON.stringify(audit.map((a) => a.type)));
      assert.ok(audit.every((a) => a.actor === pD && a.subject?.kind === "meeting-desk-read"), JSON.stringify(audit.map((a) => [a.actor, a.subject])));
      // No message, wake or delivery was queued for anyone.
      for (const dest of [pB, pA, pC, "owner:rob"]) assert.deepEqual(await world.storage.claimDeliveries({ epoch, destination: dest, claimant: "t", now: clock(), leaseMs: 1000, limit: 10 }), []);

      const list = (await reads.reads(owner, { occurrenceId: occ })).reads;
      assert.equal(list.length, 3);
      assert.deepEqual(list.map((r) => r.source), ["note", "note", "desk"]);
      assert.deepEqual(list.map((r) => r.visibility), ["shared", "shared", "shared"]);
      assert.deepEqual(list.map((r) => r.at), [10, 11, 12].map((t) => new Date(Date.UTC(2026, 9, 20, 8, 0, t)).toISOString()), "listed in the order the reads happened");
      // Refusals for notes: private, another project's, deleted, malformed, not the chair.
      for (const id of [hidden.id, foreign.id, gone.id]) await refuses("forbidden", () => reads.readNote(asD, { commandId: cid("nr"), meetingRecordId: rec, noteId: id }));
      await refuses("forbidden", () => reads.readNote(asC, { commandId: cid("nr"), meetingRecordId: rec, noteId: shared.id }));
      await refuses("forbidden", () => reads.readNote(asB, { commandId: cid("nr"), meetingRecordId: rec, noteId: shared.id }));
      await refuses("forbidden", () => reads.readNote({ ...asD, asOf: undefined } as unknown as Principal, { commandId: cid("nr"), meetingRecordId: rec, noteId: shared.id }));
      await refuses("invalid_command", () => reads.readNote(asD, { commandId: cid("nr"), meetingRecordId: rec, noteId: file.id }));
      assert.equal((await reads.reads(owner, { occurrenceId: occ })).reads.length, 3, "refused note reads leave no record");

      // Each file read left an inspection by the meeting chair that the file's agent (and only it, besides the owner) sees; it names the meeting and the revision.
      const mine = (await inspections.inspections(asB)).items;
      assert.equal(mine.length, 2, "B sees its two files, not A's note");
      assert.ok(mine.every((i) => i.via === "meeting-chair" && i.inspector === pD && i.meetingRecordId === rec && i.recordOwner === pB));
      assert.deepEqual(mine.map((i) => i.recordId).sort(), [shared.id, file.id].sort());
      assert.deepEqual((await inspections.inspections(asA)).items.map((i) => i.recordId), [presentNote.id], "the present member sees the read of its own note");
      assert.equal(mine.find((i) => i.recordId === file.id)!.revision, file.revision);
      assert.equal((await inspections.inspections(asC)).items.length, 0);
      assert.equal((await inspections.inspections(owner)).items.length, 3);

      // Records are complete: each read has its inspection, each inspection its read.
      for (const r of list) assert.ok(r.inspectionId !== undefined && (await world.storage.getAggregate({ kind: "inspection", id: r.inspectionId })) !== undefined, "no read without its inspection");

      // Attempts to change something through the read path: refused every time, recorded once per operation and target with a count, and nothing changes.
      const deskBefore = JSON.stringify(await world.storage.getAggregate({ kind: "desk-record", id: file.id }));
      const counts = async () => (await Promise.all(["desk-record", "working-note", "meeting-desk-read", "inspection"].map(async (k) => (await world.storage.listAggregates(k, { limit: 1000 })).length))).join(",");
      const aggregatesBefore = await counts();
      for (const operation of REFUSED_OPERATIONS) {
        tick += 1;
        await refuses("forbidden", () => reads.attemptChange(asD, { commandId: cid("at"), meetingRecordId: rec, targetId: file.id, operation }));
      }
      await refuses("forbidden", () => reads.attemptChange(asD, { commandId: cid("at"), meetingRecordId: rec, targetId: file.id, operation: "delete" }));
      await refuses("forbidden", () => reads.attemptChange(asD, { commandId: "at-replay", meetingRecordId: rec, targetId: shared.id, operation: "write" }));
      await refuses("forbidden", () => reads.attemptChange(asD, { commandId: "at-replay", meetingRecordId: rec, targetId: shared.id, operation: "write" }));
      await refuses("forbidden", () => reads.attemptChange(asD, { commandId: cid("at"), meetingRecordId: rec, targetId: "dsk-aaaaaaaaaaaaaaaaaaaa", operation: "lock" }));
      assert.equal(JSON.stringify(await world.storage.getAggregate({ kind: "desk-record", id: file.id })), deskBefore, "the desk record is byte for byte as it was");
      assert.equal(await counts(), aggregatesBefore, "no desk record, note, read or inspection was made or removed by an attempt");
      const tried = (await reads.attempts(owner, { occurrenceId: occ })).attempts;
      assert.equal(tried.length, REFUSED_OPERATIONS.length + 2, "one record per operation and target");
      assert.equal(tried.find((t) => t.targetId === file.id && t.operation === "delete")!.count, 2, "a repeat counts");
      assert.equal(tried.find((t) => t.targetId === shared.id)!.count, 1, "the same command repeated is one attempt");
      assert.equal(tried.find((t) => t.targetId === file.id && t.operation === "write")!.deskOwner, pB);
      assert.equal(tried.find((t) => t.targetId === "dsk-aaaaaaaaaaaaaaaaaaaa")!.deskOwner, undefined);
      assert.ok(tried.every((t) => t.lastBy === pD && t.occurrenceId === occ));
      assert.equal((await reads.attempts(asB, { occurrenceId: occ })).attempts.length, tried.length, "the file's agent sees the attempts");
      assert.equal((await reads.attempts(asE, { occurrenceId: occ })).attempts.length, 0);
      await refuses("invalid_command", () => reads.attemptChange(asD, { commandId: cid("at"), meetingRecordId: rec, targetId: file.id, operation: "peek" }));
      await refuses("invalid_command", () => reads.attemptChange(asD, { commandId: cid("at"), meetingRecordId: rec, targetId: "not-an-id", operation: "write" }));
      // Only the chair is recorded: anyone else is refused and no record is made.
      await refuses("forbidden", () => reads.attemptChange(asC, { commandId: cid("at"), meetingRecordId: rec, targetId: file.id, operation: "write" }));
      assert.equal((await reads.attempts(owner, { occurrenceId: occ })).attempts.length, tried.length);

      // A read whose records cannot be committed returns nothing and leaves nothing; the retry then works.
      const broken = { on: true };
      const bad = MeetingDeskReadService.withEpoch(flaky(world.storage, broken), epoch, opts);
      await assert.rejects(() => bad.read(asD, { commandId: "rd-broken", meetingRecordId: rec, deskRecordId: file2.id }));
      await assert.rejects(() => bad.readNote(asD, { commandId: "nr-broken", meetingRecordId: rec, noteId: shared.id }));
      assert.equal((await reads.reads(owner, { occurrenceId: occ, deskRecordId: file2.id })).reads.length, 0, "a failed commit leaves no read record");
      assert.equal((await inspections.inspections(asB)).items.filter((i) => i.recordId === file2.id).length, 0, "nor an inspection");
      broken.on = false;
      tick += 1;
      assert.equal((await bad.read(asD, { commandId: "rd-broken", meetingRecordId: rec, deskRecordId: file2.id })).record!.body, "B's second plan");
      assert.equal((await reads.reads(owner, { occurrenceId: occ, deskRecordId: file2.id })).reads.length, 1);

      const total = (await reads.reads(owner, { occurrenceId: occ })).reads.length;
      // The owner's chat asks about it through the status view: each read and each refused attempt is a line citing its record; a stranger gets the empty answer; the view is absent without the service.
      const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, opts);
      const base = { assignments, waits: WaitService.withEpoch(world.storage, epoch, assignments, opts), blockers: BlockerService.withEpoch(world.storage, epoch, opts), contracts: ContractService.withEpoch(world.storage, epoch, opts) };
      const status = StatusService.withEpoch(world.storage, epoch, { ...base, deskReads: reads }, opts);
      const said = (await status.ask(owner, { kind: "meeting_desk_reads", occurrenceId: occ }))!.lines;
      assert.equal(said.filter((l) => l.cites.some((c) => c.kind === "meeting-desk-read")).length, total, "a line for every read");
      assert.equal(said.filter((l) => l.cites.some((c) => c.kind === "meeting-desk-attempt")).length, REFUSED_OPERATIONS.length + 2, "and for every refused attempt");
      assert.ok(said.some((l) => /read a shared note of agent:/.test(l.text) && l.cites.some((c) => c.kind === "working-note" && c.id === shared.id)), said.map((l) => l.text).join("\n"));
      assert.match((await status.ask(asE, { kind: "meeting_desk_reads", occurrenceId: occ }))!.lines[0]!.text, /read nothing/);
      assert.equal((await status.ask(owner, { kind: "meeting_desk_reads", occurrenceId: occ, deskRecordId: file2.id }))!.lines.length, 1);
      assert.equal(await StatusService.withEpoch(world.storage, epoch, base, opts).ask(owner, { kind: "meeting_desk_reads", occurrenceId: occ }), undefined);
      await refuses("invalid_command", () => status.ask(owner, { kind: "meeting_desk_reads", occurrenceId: occ, limit: 0 }));
      const short = (await status.ask(owner, { kind: "meeting_desk_reads", occurrenceId: occ, limit: 1 }))!.lines.map((l) => l.text);
      assert.ok(short.includes("There are more reads than shown.") && short.includes("There are more refused attempts than shown."), short.join("\n"));

      // A controller restart: a new epoch. The old service is stale; the new one reads again (a new record), and a repeat of an earlier command is answered from its record with no content and no new record.
      const restarted = await ProjectService.open(world.storage, { holder: "c2", ...opts });
      assert.ok(restarted.epoch > epoch);
      const reads2 = MeetingDeskReadService.withEpoch(world.storage, restarted.epoch, opts);
      const meetings2 = MeetingService.withEpoch(world.storage, restarted.epoch, {}, { ...opts, availability: async () => "available" });
      const records2 = MeetingRecordService.withEpoch(world.storage, restarted.epoch, { meetings: meetings2, decisions: undefined as never }, { ...opts, authority: async () => undefined } as never);
      await assert.rejects(() => reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: file.id }), (e: unknown) => e instanceof DomainError && e.code === "stale_epoch");
      assert.equal((await reads2.reads(owner, { occurrenceId: occ })).reads.length, total, "the records survive the restart");
      assert.equal((await reads2.read(asD, { commandId: "rd-replay-1", meetingRecordId: rec, deskRecordId: file.id })).replayed, false);
      assert.equal((await reads2.read(asD, { commandId: "rd-replay-1", meetingRecordId: rec, deskRecordId: file.id })).replayed, true);
      assert.equal((await reads2.reads(owner, { occurrenceId: occ })).reads.length, total + 1, "a second read of the same file after the restart is a second record, its repeat is none");
      await refuses("forbidden", () => reads2.attemptChange(asD, { commandId: cid("at"), meetingRecordId: rec, targetId: file.id, operation: "rename" }));
      assert.equal((await reads2.attempts(owner, { occurrenceId: occ })).attempts.find((t) => t.operation === "rename")!.count, 2, "attempts are counted across the restart");

      // The chair changes: the former chair can neither read nor attempt; the new chair can. The meeting ends: nobody can.
      await records2.setChair(mgr, { commandId: cid("chair"), recordId: rec, chair: pE } as never);
      await refuses("forbidden", () => reads2.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: file.id }));
      await refuses("forbidden", () => reads2.readNote(asD, { commandId: cid("nr"), meetingRecordId: rec, noteId: shared.id }));
      await refuses("forbidden", () => reads2.attemptChange(asD, { commandId: cid("at"), meetingRecordId: rec, targetId: file.id, operation: "lock" }));
      assert.equal((await reads2.readNote(asE, { commandId: cid("nr"), meetingRecordId: rec, noteId: shared.id })).record!.body, "Step three of five.");
      await records2.finish(owner, { commandId: cid("end"), recordId: rec });
      await refuses("forbidden", () => reads2.readNote(asE, { commandId: cid("nr"), meetingRecordId: rec, noteId: shared.id }));
      await refuses("forbidden", () => reads2.read(asE, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: file.id }));
      await refuses("forbidden", () => reads2.attemptChange(asE, { commandId: cid("at"), meetingRecordId: rec, targetId: file.id, operation: "write" }));
      // Paging in time order across all the reads.
      const everything = (await reads2.reads(owner, { occurrenceId: occ })).reads;
      const pages: string[] = [];
      let cursor: string | undefined;
      do { const p = await reads2.reads(owner, { occurrenceId: occ, limit: 2, ...(cursor === undefined ? {} : { after: cursor }) }); pages.push(...p.reads.map((r) => r.id)); cursor = p.next; } while (cursor !== undefined);
      assert.deepEqual(pages, everything.map((r) => r.id));
      assert.deepEqual(everything.map((r) => r.at), [...everything.map((r) => r.at)].sort());
      await refuses("invalid_command", () => reads2.reads(owner, { occurrenceId: occ, after: "mdr-aaaaaaaaaaaaaaaaaaaa" }));
    } finally { await world.close(); }
  });
}

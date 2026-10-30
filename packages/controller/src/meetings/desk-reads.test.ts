import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { DeskService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { MeetingDeskReadService, MeetingRecordService, MeetingService } from "./index.js";

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
      for (const nm of ["A", "B", "C", "D"]) ids.push(`agent:${(await agents.create(owner, { commandId: cid("ag"), friendlyName: nm })).id}`);
      const [pA, pB, pC, pD] = ids as [string, string, string, string];
      const login = async (id: string): Promise<Principal> => principals.authenticate((await principals.issueCredential(owner, id)).token);
      for (const p of [pB, pC]) for (const pr of [project, other]) await grants.grant(owner, { commandId: cid("g"), grantee: p, action: "desk.write", project: pr, source: "direct", basis: "test" } as never);
      const [asA, asB, asC, asD] = [await login(pA), await login(pB), await login(pC), await login(pD)] as [Principal, Principal, Principal, Principal];
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
      const f1 = await w(asB, project, "plan", "B's plan", "shared", "draft");
      const f2 = await w(asB, project, "scratch", "B's private thinking", "private");
      const f3 = await w(asB, project, "unread", "never read in the meeting");
      const foreign = await w(asB, other, "elsewhere", "another project");
      const present = await w(asA as never, project, "mine", "A is present").catch(() => undefined);

      const snapshot = async () => JSON.stringify(await Promise.all([f1, f2, f3, foreign].map((f) => world.storage.getAggregate({ kind: "desk-record", id: f.id }))));
      const before = await snapshot();

      // (b) one record per file read, none for files not read; the record names occurrence, file, revision, digest, bytes, reader, time.
      const r1 = await reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f1.id });
      assert.equal(r1.record!.body, "B's plan");
      await reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f2.id });
      const list = await reads.reads(owner, { occurrenceId: occ });
      assert.equal(list.length, 2);
      const one = list.find((x) => x.deskRecordId === f1.id)!;
      assert.deepEqual({ o: one.occurrenceId, m: one.meetingRecordId, owner: one.deskOwner, rev: one.deskRevision, reader: one.reader, at: one.at, bytes: one.bytes }, { o: occ, m: rec, owner: pB, rev: f1.revision, reader: pD, at: options.clock(), bytes: Buffer.byteLength("plan" + "B's plan") });
      assert.match(one.sha256, /^[0-9a-f]{64}$/);
      assert.ok(!list.some((x) => x.deskRecordId === f3.id), "an unread file leaves no record");
      // The absent member sees the reads of its desk; another absent member does not.
      assert.equal((await reads.reads(asB, { occurrenceId: occ })).length, 2);
      assert.equal((await reads.reads(asC, { occurrenceId: occ })).length, 0);
      // A repeated command is the same read: no second record.
      const again = await reads.read(asD, { commandId: "rd-replay", meetingRecordId: rec, deskRecordId: f3.id });
      const again2 = await reads.read(asD, { commandId: "rd-replay", meetingRecordId: rec, deskRecordId: f3.id });
      assert.equal(again2.replayed, true); assert.equal(again2.record, undefined); assert.equal(again.readId, again2.readId);
      assert.equal((await reads.reads(owner, { occurrenceId: occ })).length, 3);

      // (c) a file changed between two reads is recorded with both revisions.
      const second = await desks.revise(asB, { commandId: cid("rv"), recordId: f1.id, expectedRevision: f1.revision, body: "B's plan, changed" } as never);
      const r2 = await reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f1.id });
      assert.equal(r2.record!.body, "B's plan, changed");
      const hist = await reads.reads(owner, { occurrenceId: occ, deskRecordId: f1.id });
      assert.deepEqual(hist.map((h) => h.deskRevision).sort(), [f1.revision, second.revision]);
      assert.notEqual(hist[0]!.sha256, hist[1]!.sha256);

      // Refusals: not the chair, a present member's desk, another project's desk, a missing file.
      await refuses("forbidden", () => reads.read(asC, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f1.id }));
      await refuses("forbidden", () => reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: foreign.id }));
      if (present !== undefined) await refuses("forbidden", () => reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: present.id }));
      await refuses("forbidden", () => reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: "dsk-aaaaaaaaaaaaaaaaaaaa" }));
      const total = (await reads.reads(owner, { occurrenceId: occ })).length;
      assert.equal(total, 4, "refused reads leave no record");

      // (a) read-only: the service has no mutating method, and the desk records are unchanged by reads (only the revise above moved f1).
      const methods = Object.getOwnPropertyNames(MeetingDeskReadService.prototype).filter((m) => m !== "constructor").sort();
      assert.deepEqual(methods, ["read", "reads"]);
      assert.ok(!methods.some((m) => /write|revise|delete|rename|remove|lock|update/i.test(m)));
      const after1 = JSON.stringify(await Promise.all([f2, f3, foreign].map((f) => world.storage.getAggregate({ kind: "desk-record", id: f.id }))));
      assert.equal(after1, JSON.stringify(JSON.parse(before).slice(1)), "reads changed no desk record");

      // The meeting ends: reads are refused.
      await records.finish(owner, { commandId: cid("end"), recordId: rec });
      await refuses("forbidden", () => reads.read(asD, { commandId: cid("rd"), meetingRecordId: rec, deskRecordId: f3.id }));
      assert.equal((await reads.reads(owner, { occurrenceId: occ })).length, 4);
    } finally { await world.close(); }
  });
}

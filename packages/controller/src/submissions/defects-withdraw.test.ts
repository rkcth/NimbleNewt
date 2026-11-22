import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OPERATIONS } from "../api/operations.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { CommandRunner } from "../domain/runner.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { AcceptanceService, DefectService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  test(`${backend.name}: a defect reported by mistake is withdrawn: nothing is erased, nothing is counted as unfinished (card Q04)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const p1 = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P1" })).id;
      const p2 = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P2" })).id;
      const t1 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: p1, title: "T1" })).id;
      const t2 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: p2, title: "T2" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[], inProjects: string[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: inProjects.map((project) => ({ action: "task.read", project })) });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (project: string, task: string): Promise<string> => {
        const art = derivedId("art", cid("art"));
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { id: art }, build: async () => ({ ref: { kind: "artifact", id: art }, creates: true, changes: [{ type: "create" as const, ref: { kind: "artifact", id: art }, body: { name: "one", projectId: project, taskId: task, entries: [], manifestDigest: "m-one", totalBytes: 0, createdBy: owner.id } as unknown as JsonObject }], detail: {} }) }));
        return art;
      };
      const acc = AcceptanceService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        contractVersion: async () => 0,
        verifyArtifact: async () => ({ ok: true, problems: 0 }),
        reviewersAvailableIn: async (_p, worker) => [...roles].filter(([id, r]) => id !== worker && r.includes("reviewer")).map(([id]) => id),
      }, options);
      // One repair and review cycle, so a single failed check escalates.
      const svc = DefectService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        mayReadDeliverable: async (by, id) => (await acc.get(by, id)) !== undefined,
        cycleLimit: async () => 1,
      }, options);
      const ann = await agent("ann", ["author", "docs"], [p1, p2]);
      const rev = await agent("rev", ["reviewer"], [p1, p2]);
      const far = await agent("far", ["reviewer"], [p2]);

      const deliverable = async (project: string, task: string, title: string): Promise<{ id: string; art: string }> => {
        const art = await plant(project, task);
        const made = await acc.draft(ann, { commandId: cid("d"), taskId: task, type: "document", title, artifacts: [{ artifactId: art }] });
        await acc.submit(ann, { commandId: cid("s"), id: made.id, expectedRevision: made.revision, contractVersion: 0 });
        await acc.startReview(owner, { commandId: cid("r"), id: made.id, version: 1 });
        await acc.reject(owner, { commandId: cid("j"), id: made.id, version: 1, reason: "not good enough" });
        return { id: made.id, art };
      };
      const newVersion = async (d: { id: string; art: string }): Promise<number> => {
        const cur = (await acc.get(owner, d.id))!;
        const nv = await acc.newVersion(ann, { commandId: cid("n"), id: d.id, expectedRevision: cur["revision"] as number, artifacts: [{ artifactId: d.art }] });
        await acc.submit(ann, { commandId: cid("s"), id: d.id, expectedRevision: nv.revision, contractVersion: 0 });
        return (await acc.get(owner, d.id))!["currentVersion"] as number;
      };
      const g1 = await deliverable(p1, t1, "Guide");
      const report = (by: Principal, finding: string, severity = "major"): Promise<{ id: string; revision: number }> => svc.report(by, { commandId: cid("f"), deliverableId: g1.id, version: 1, finding, severity });
      const rev2 = await agent("rev2", ["reviewer"], [p1]);
      const get = async (id: string): Promise<Record<string, any>> => (await svc.get(owner, id)) as Record<string, any>;
      const code = (e: unknown, c: string): boolean => e instanceof DomainError && e.code === c;

      // An open defect: only its reporter or the owner takes it back, and the reason is required.
      const open = await report(rev, "wrong version");
      await assert.rejects(() => svc.withdraw(rev2, { commandId: cid("w"), id: open.id, reason: "not mine" }), (e) => code(e, "forbidden"));
      await assert.rejects(() => svc.withdraw(ann, { commandId: cid("w"), id: open.id, reason: "responsible agent" }), (e) => code(e, "forbidden"));
      await assert.rejects(() => svc.withdraw(rev, { commandId: cid("w"), id: open.id, reason: "  " }), (e) => code(e, "invalid_command"));
      await assert.rejects(() => svc.withdraw(rev, { commandId: cid("w"), id: open.id, reason: "x", expectedRevision: open.revision + 5 }), (e) => code(e, "stale_revision"));
      // Another project's agent, a client and the reporter's credential for another task do not learn the defect exists; the owner's task credential is not the owner.
      await assert.rejects(() => svc.withdraw(far, { commandId: cid("w"), id: open.id, reason: "far" }), (e) => code(e, "not_found"));
      await assert.rejects(() => svc.withdraw({ kind: "client", id: "client:web" } as unknown as Principal, { commandId: cid("w"), id: open.id, reason: "client" }), (e) => code(e, "not_found"));
      await assert.rejects(() => svc.withdraw({ ...rev, taskScope: { taskId: t2, projectId: p2 } } as Principal, { commandId: cid("w"), id: open.id, reason: "other task" }), (e) => code(e, "not_found"));
      await assert.rejects(() => svc.withdraw({ ...owner, taskScope: { taskId: t1, projectId: p1 } } as Principal, { commandId: cid("w"), id: open.id, reason: "task credential" }), (e) => code(e, "forbidden"));
      assert.equal((await get(open.id))["state"], "open");
      const command = cid("w");
      const done = await svc.withdraw(rev, { commandId: command, id: open.id, reason: "I read version 1, it was version 2", expectedRevision: open.revision });
      const w = await get(open.id);
      assert.equal(w["state"], "withdrawn");
      assert.deepEqual([w["resolution"].kind, w["resolution"].by, w["resolution"].reason], ["withdrawn", rev.id, "I read version 1, it was version 2"]);
      assert.equal(w["finding"].text, "wrong version", "the finding stays on the record");
      // The same command again is answered from the record.
      const again = await svc.withdraw(rev, { commandId: command, id: open.id, reason: "I read version 1, it was version 2", expectedRevision: open.revision });
      assert.deepEqual([again.replayed, again.revision], [true, done.revision]);
      // A withdrawn defect is finished: nothing else can be done to it, and it is not withdrawn twice.
      await assert.rejects(() => svc.withdraw(owner, { commandId: cid("w"), id: open.id, reason: "again" }), (e) => code(e, "invalid_transition"));
      await assert.rejects(() => svc.repair(ann, { commandId: cid("rp"), id: open.id, version: 2 }), (e) => code(e, "invalid_transition"));
      await assert.rejects(() => svc.review(rev2, { commandId: cid("rv"), id: open.id, verdict: "fixed" }), (e) => code(e, "invalid_transition"));
      await assert.rejects(() => svc.override(owner, { commandId: cid("o"), id: open.id, outcome: "accept-as-is", reason: "ship" }), (e) => code(e, "invalid_transition"));

      // An escalated defect withdrawn by the owner: its failed check stays failed, it leaves the unfinished and Needs-you reads, the others' override no longer lists it.
      const esc = await report(rev, "failed repair");
      const other = await report(rev, "other open one", "minor");
      const v2 = await newVersion(g1);
      await svc.repair(ann, { commandId: cid("rp"), id: esc.id, version: v2 });
      await svc.review(rev, { commandId: cid("rv"), id: esc.id, verdict: "not-fixed", reason: "still wrong" });
      assert.deepEqual((await svc.unresolved(owner, { escalatedOnly: true })).items.map((x) => x.id), [esc.id]);
      // A failed check confirmed the finding and it waits for the owner: its reporter can no longer take it back (and so never restarts its count by reporting it again).
      await assert.rejects(() => svc.withdraw(rev, { commandId: cid("w"), id: esc.id, reason: "never mind" }), (e) => code(e, "forbidden"));
      assert.equal((await get(esc.id))["state"], "escalated");
      await svc.withdraw(owner, { commandId: cid("w"), id: esc.id, reason: "the report itself was mistaken" });
      assert.deepEqual((await svc.unresolved(owner, { escalatedOnly: true })).items, []);
      assert.deepEqual((await svc.unresolved(owner, { projectId: p1 })).items.map((x) => x.id), [other.id]);
      assert.deepEqual((await svc.unresolved(owner, { projectId: p1 })).counts, { escalated: 0, awaitingCheck: 0, open: 1 });
      const e = await get(esc.id);
      assert.equal(e["state"], "withdrawn");
      assert.deepEqual(e["checks"].map((c: any) => c.verdict), ["not-fixed"], "a failed check is never rewritten");
      assert.equal(e["cycles"], 1);
      const decided = await svc.override(owner, { commandId: cid("o"), id: other.id, outcome: "accept-as-is", reason: "minor, ship it" });
      const record = (await get(other.id))["overrideRecords"][0];
      assert.equal(decided.overrideId, record.id);
      assert.deepEqual(record.remaining.map((x: any) => x.defectId), [other.id], "a withdrawn defect is not a remaining finding");
      // A fixed or accepted defect cannot be withdrawn either.
      await assert.rejects(() => svc.withdraw(owner, { commandId: cid("w"), id: other.id, reason: "too late" }), (x) => code(x, "invalid_transition"));
      const listed = (await svc.list(owner, g1.id)).items.map((x) => [x["id"], x["state"]]);
      assert.deepEqual(listed, [[open.id, "withdrawn"], [esc.id, "withdrawn"], [other.id, "overridden"]]);

      // Concurrency on a second deliverable. A repair and a withdrawal both pinned to the revision read: exactly one applies, the other is refused as stale.
      const g2 = await deliverable(p1, t1, "Guide 2");
      const g2v2 = await newVersion(g2);
      const report2 = (finding: string): Promise<{ id: string; revision: number }> => svc.report(rev, { commandId: cid("f"), deliverableId: g2.id, version: 1, finding, severity: "minor" });
      const a = await report2("race pinned");
      const pinned = await Promise.allSettled([
        svc.repair(ann, { commandId: cid("rp"), id: a.id, version: g2v2, expectedRevision: a.revision }),
        svc.withdraw(rev, { commandId: cid("w"), id: a.id, reason: "race", expectedRevision: a.revision }),
      ]);
      assert.equal(pinned.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(pinned));
      assert.ok(pinned.every((r) => r.status === "fulfilled" || code(r.reason, "stale_revision")), JSON.stringify(pinned));
      assert.equal((await get(a.id))["state"], pinned[0].status === "fulfilled" ? "repair-submitted" : "withdrawn");
      // Unpinned: a command that loses the race is refused (stale or no longer possible), never applied over the other; the record says what won, and nothing brings a withdrawn defect back.
      const b = await report2("race unpinned");
      const loose = await Promise.allSettled([svc.repair(ann, { commandId: cid("rp"), id: b.id, version: g2v2 }), svc.withdraw(rev, { commandId: cid("w"), id: b.id, reason: "race" })]);
      assert.ok(loose.some((r) => r.status === "fulfilled"), JSON.stringify(loose));
      assert.ok(loose.every((r) => r.status === "fulfilled" || code(r.reason, "stale_revision") || code(r.reason, "invalid_transition")), JSON.stringify(loose));
      assert.equal((await get(b.id))["state"], loose[1].status === "fulfilled" ? "withdrawn" : "repair-submitted");
      if (loose[1].status === "fulfilled") await assert.rejects(() => svc.repair(ann, { commandId: cid("rp"), id: b.id, version: g2v2 }), (e) => code(e, "invalid_transition"));
      // The owner's decision and the owner's withdrawal at once: exactly one applies and the record says which.
      const c2 = await report2("race decision");
      const decision = await Promise.allSettled([
        svc.override(owner, { commandId: cid("o"), id: c2.id, outcome: "accept-as-is", reason: "fine" }),
        svc.withdraw(owner, { commandId: cid("w"), id: c2.id, reason: "mistaken" }),
      ]);
      assert.equal(decision.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(decision));
      assert.ok(decision.every((r) => r.status === "fulfilled" || code(r.reason, "invalid_transition") || code(r.reason, "stale_revision")), JSON.stringify(decision));
      assert.equal((await get(c2.id))["state"], decision[0].status === "fulfilled" ? "overridden" : "withdrawn");
      // A reporter that did work of the repair under check may not withdraw the defect (it would dismiss the check of its own work); the owner may.
      const mine = await report2("repaired with the reporter's help");
      await svc.repair(ann, { commandId: cid("rp"), id: mine.id, version: g2v2 });
      const vRef = { kind: "deliverable-version", id: `${g2.id}.${g2v2}` };
      const vAgg = (await runner.get("deliverable-version", vRef.id))!;
      await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { id: vRef.id }, build: async () => ({ ref: vRef, creates: false, changes: [{ type: "update" as const, ref: vRef, expectedRevision: vAgg.revision, body: { ...vAgg.body, createdBy: rev.id } as unknown as JsonObject }], detail: {} }) }));
      await assert.rejects(() => svc.withdraw(rev, { commandId: cid("w"), id: mine.id, reason: "it is fine now" }), (e) => code(e, "forbidden"));
      assert.equal((await get(mine.id))["state"], "repair-submitted");
      await svc.withdraw(owner, { commandId: cid("w"), id: mine.id, reason: "a duplicate of another report" });
      assert.equal((await get(mine.id))["state"], "withdrawn");
      // The reason is redacted: a credential-shaped value does not reach the record.
      const secret = await report2("secret reason");
      const key = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
      await svc.withdraw(rev, { commandId: cid("w"), id: secret.id, reason: `mistaken, the key ${key} was not the problem` });
      assert.ok(!JSON.stringify(await get(secret.id)).includes(key), "the secret is redacted from the record");
      // Through the operation table, on every backend: the arguments are checked, the same command ID with another reason is a conflict, a repeat is answered from the record, and the Needs-you answer
      // to an escalated defect that was withdrawn meanwhile is refused rather than deciding it.
      const op = OPERATIONS.find((o) => o.name === "defect.withdraw")!;
      const answer = OPERATIONS.find((o) => o.name === "needs-you.answer")!;
      const run = (principal: Principal, args: Record<string, unknown>, commandId?: string): Promise<Record<string, any>> => op.run({ principal, defects: svc } as never, args as never, commandId as never) as Promise<Record<string, any>>;
      const viaOp = await report2("reported through the operation table");
      await assert.rejects(() => run(rev, { id: viaOp.id, reason: "x", extra: 1 }, cid("w")), (e) => code(e, "invalid_command"));
      await assert.rejects(() => run(rev, { id: viaOp.id, reason: "x".repeat(2001) }, cid("w")), (e) => code(e, "invalid_command"));
      await assert.rejects(() => run(rev, { id: viaOp.id, reason: "no command ID" }), (e) => code(e, "invalid_command") && /commandId/.test((e as Error).message));
      await assert.rejects(() => run(far, { id: viaOp.id, reason: "far" }, cid("w")), (e) => code(e, "not_found"));
      await assert.rejects(() => run(ann, { id: viaOp.id, reason: "responsible" }, cid("w")), (e) => code(e, "forbidden"));
      assert.equal((await get(viaOp.id))["state"], "open", "nothing applied by a refused call");
      const opCommand = cid("w");
      const first = await run(rev, { id: viaOp.id, reason: "x".repeat(2000), expectedRevision: viaOp.revision }, opCommand);
      assert.deepEqual([first["id"], first["revision"], first["replayed"]], [viaOp.id, viaOp.revision + 1, false]);
      assert.equal((await run(rev, { id: viaOp.id, reason: "x".repeat(2000), expectedRevision: viaOp.revision }, opCommand))["replayed"], true);
      await assert.rejects(() => run(rev, { id: viaOp.id, reason: "another reason", expectedRevision: viaOp.revision }, opCommand), (e) => code(e, "command_conflict"));
      assert.equal((await get(viaOp.id))["state"], "withdrawn");
      // A failed check counts even after the owner let the repair go on: the defect is open again with its cycle kept, and its reporter still may not take it back (withdrawing and reporting again
      // would start the confirmed finding over at cycle 0); the owner may.
      // (Reported by rev2, which did none of version 2's work, so only the failed check stands in the way; rev3 checks it.)
      const rev3 = await agent("rev3", ["reviewer"], [p1]);
      const again2 = await svc.report(rev2, { commandId: cid("f"), deliverableId: g2.id, version: 1, finding: "failed once, repair goes on", severity: "minor" });
      await svc.repair(ann, { commandId: cid("rp"), id: again2.id, version: g2v2 });
      await svc.review(rev3, { commandId: cid("rv"), id: again2.id, verdict: "not-fixed", reason: "still wrong" });
      await svc.override(owner, { commandId: cid("o"), id: again2.id, outcome: "repair-again", reason: "once more" });
      assert.deepEqual([(await get(again2.id))["state"], (await get(again2.id))["cycles"]], ["open", 1]);
      await assert.rejects(() => run(rev2, { id: again2.id, reason: "never mind" }, cid("w")), (e) => code(e, "forbidden") && /found it not fixed/.test((e as Error).message));
      assert.equal((await get(again2.id))["state"], "open");
      await run(owner, { id: again2.id, reason: "the owner takes it back" }, cid("w"));
      assert.equal((await get(again2.id))["state"], "withdrawn");
      // An escalation listed on the Needs-you list, then withdrawn by the owner before the answer: the answer decides nothing.
      const late = await report2("escalates, then withdrawn");
      await svc.repair(ann, { commandId: cid("rp"), id: late.id, version: g2v2 });
      await svc.review(rev2, { commandId: cid("rv"), id: late.id, verdict: "not-fixed", reason: "still wrong" });
      const listed2 = await get(late.id);
      assert.equal(listed2["state"], "escalated");
      await run(owner, { id: late.id, reason: "a duplicate", expectedRevision: listed2["revision"] }, cid("w"));
      await assert.rejects(() => answer.run({ principal: owner, defects: svc } as never, { kind: "defect", id: late.id, answer: "accept-as-is", expectedRevision: listed2["revision"] } as never, cid("a")), (e) => code(e, "invalid_transition"));
      const answered = await get(late.id);
      assert.deepEqual([answered["state"], answered["overrideRecords"].length, answered["cycles"]], ["withdrawn", 0, 1]);
      void (null as unknown as JsonObject);
    } finally {
      await world.close();
    }
  });
}

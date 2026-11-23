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
import { AcceptanceService, DefectService, MAX_DEFECT_EDITS } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  test(`${backend.name}: an unfinished defect's finding and severity are corrected by its reporter or the owner, each edit kept, nothing else changed (card Q04)`, async () => {
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
      const rev3 = await agent("rev3", ["reviewer"], [p1]);
      const full = async (id: string): Promise<Record<string, any>> => (await svc.get(owner, id)) as Record<string, any>;

      // Arguments and access, on a fresh open defect. Nothing is applied by a refused call.
      const a = await report(rev, "The guide skips the backup step.", "major");
      await assert.rejects(() => svc.edit(rev, { commandId: cid("e"), id: a.id }), (e) => code(e, "invalid_command"), "nothing to change is named");
      await assert.rejects(() => svc.edit(rev, { commandId: cid("e"), id: a.id, finding: "   " }), (e) => code(e, "invalid_command"));
      await assert.rejects(() => svc.edit(rev, { commandId: cid("e"), id: a.id, finding: "x".repeat(2001) }), (e) => code(e, "invalid_command"));
      await assert.rejects(() => svc.edit(rev, { commandId: cid("e"), id: a.id, severity: "huge" }), (e) => code(e, "invalid_command"));
      await assert.rejects(() => svc.edit(rev, { commandId: cid("e"), id: a.id, severity: "minor", reason: " " }), (e) => code(e, "invalid_command"));
      await assert.rejects(() => svc.edit(rev, { commandId: cid("e"), id: a.id, severity: "minor", extra: 1 } as never), (e) => code(e, "invalid_command"));
      await assert.rejects(() => svc.edit(rev, { commandId: cid("e"), id: "nope", severity: "minor" }), (e) => code(e, "invalid_command"));
      await assert.rejects(() => svc.edit(rev2, { commandId: cid("e"), id: a.id, severity: "minor" }), (e) => code(e, "forbidden"));
      await assert.rejects(() => svc.edit(ann, { commandId: cid("e"), id: a.id, severity: "minor" }), (e) => code(e, "forbidden"), "the responsible agent may not soften findings against its work");
      await assert.rejects(() => svc.edit(far, { commandId: cid("e"), id: a.id, severity: "minor" }), (e) => code(e, "not_found"));
      await assert.rejects(() => svc.edit({ kind: "client", id: "client:web" } as unknown as Principal, { commandId: cid("e"), id: a.id, severity: "minor" }), (e) => code(e, "not_found"));
      await assert.rejects(() => svc.edit({ ...rev, taskScope: { taskId: t2, projectId: p2 } } as Principal, { commandId: cid("e"), id: a.id, severity: "minor" }), (e) => code(e, "not_found"));
      await assert.rejects(() => svc.edit({ ...owner, taskScope: { taskId: t1, projectId: p1 } } as Principal, { commandId: cid("e"), id: a.id, severity: "minor" }), (e) => code(e, "forbidden"));
      await assert.rejects(() => svc.edit(rev, { commandId: cid("e"), id: a.id, severity: "minor", expectedRevision: a.revision + 3 }), (e) => code(e, "stale_revision"));
      await assert.rejects(() => svc.edit(rev, { commandId: cid("e"), id: a.id, finding: "The guide skips the backup step.", severity: "major" }), (e) => code(e, "invalid_command"), "values equal to the current ones are not an edit");
      const before = await full(a.id);
      assert.equal(before["revision"], a.revision, "no refused call changed the record");
      assert.equal(before["edits"], undefined, "a defect never edited carries no edits");
      assert.deepEqual((await svc.list(owner, g1.id)).items.map((x) => x["edits"]), [undefined]);

      // Reads create nothing: the record and the deliverable's list are as they were after reading every way.
      await svc.get(owner, a.id); await svc.list(owner, g1.id); await svc.forTask(owner, t1); await svc.unresolved(owner, { projectId: p1 });
      assert.equal((await full(a.id))["revision"], a.revision);

      // The reporter corrects the finding: only the text changes, the edit keeps what it replaced; the same command again is answered from the record.
      const command = cid("e");
      const first = await svc.edit(rev, { commandId: command, id: a.id, finding: "The guide skips the restore step.", reason: "I named the wrong step", expectedRevision: a.revision });
      assert.deepEqual([first.revision, first.replayed], [a.revision + 1, false]);
      const e1 = await full(a.id);
      assert.deepEqual([e1["finding"].text, e1["severity"], e1["state"], e1["cycles"], e1["checkSeq"], e1["version"]], ["The guide skips the restore step.", "major", "open", 0, 0, 1]);
      assert.equal(e1["edits"].length, 1);
      assert.deepEqual([e1["edits"][0].by, e1["edits"][0].previousFinding, e1["edits"][0].previousSeverity, e1["edits"][0].reason], [rev.id, "The guide skips the backup step.", undefined, "I named the wrong step"]);
      const again = await svc.edit(rev, { commandId: command, id: a.id, finding: "The guide skips the restore step.", reason: "I named the wrong step", expectedRevision: a.revision });
      assert.deepEqual([again.replayed, again.revision], [true, first.revision]);
      await assert.rejects(() => svc.edit(rev, { commandId: command, id: a.id, finding: "something else", reason: "I named the wrong step", expectedRevision: a.revision }), (e) => code(e, "command_conflict"));
      assert.equal((await full(a.id))["edits"].length, 1, "a replay and a conflicting replay add no edit");
      // Severity alone, by the owner; a finding equal to the current text is no change in it, so only the severity is kept in the entry.
      await svc.edit(owner, { commandId: cid("e"), id: a.id, finding: "The guide skips the restore step.", severity: "critical" });
      const e2 = await full(a.id);
      assert.deepEqual([e2["severity"], e2["finding"].text, e2["edits"].length], ["critical", "The guide skips the restore step.", 2]);
      assert.deepEqual([e2["edits"][1].by, e2["edits"][1].previousFinding, e2["edits"][1].previousSeverity], [owner.id, undefined, "major"]);
      // A secret-shaped value is redacted in the finding and the reason.
      const key = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
      await svc.edit(rev, { commandId: cid("e"), id: a.id, finding: `Fails with the key ${key} set`, reason: `see ${key}` });
      assert.ok(!JSON.stringify(await full(a.id)).includes(key));

      // A repair under check: the reporter may still correct it unless it did work of the repair; the owner may.
      const g2 = await deliverable(p1, t1, "Guide 2");
      const g2v2 = await newVersion(g2);
      const report2 = (by: Principal, finding: string, severity = "minor"): Promise<{ id: string; revision: number }> => svc.report(by, { commandId: cid("f"), deliverableId: g2.id, version: 1, finding, severity });
      const mine = await report2(rev, "repaired with the reporter's help");
      await svc.repair(ann, { commandId: cid("rp"), id: mine.id, version: g2v2 });
      await svc.edit(rev, { commandId: cid("e"), id: mine.id, severity: "major" });
      assert.deepEqual([(await full(mine.id))["state"], (await full(mine.id))["repairVersion"]], ["repair-submitted", g2v2], "state and repair are untouched");
      const vRef = { kind: "deliverable-version", id: `${g2.id}.${g2v2}` };
      const vAgg = (await runner.get("deliverable-version", vRef.id))!;
      await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { id: vRef.id }, build: async () => ({ ref: vRef, creates: false, changes: [{ type: "update" as const, ref: vRef, expectedRevision: vAgg.revision, body: { ...vAgg.body, createdBy: rev.id } as unknown as JsonObject }], detail: {} }) }));
      await assert.rejects(() => svc.edit(rev, { commandId: cid("e"), id: mine.id, severity: "critical" }), (e) => code(e, "forbidden"));
      await svc.edit(owner, { commandId: cid("e"), id: mine.id, severity: "critical" });
      assert.equal((await full(mine.id))["severity"], "critical");

      // After a failed check the finding is confirmed: only the owner corrects it (cycle limit 1: the defect escalated). Checks, cycles and state stay; an owner decision made earlier keeps the text it saw.
      const esc = await report2(rev2, "escalates");
      const other = await report2(rev2, "decided before the edit");
      await svc.repair(ann, { commandId: cid("rp"), id: esc.id, version: g2v2 });
      await svc.review(rev3, { commandId: cid("rv"), id: esc.id, verdict: "not-fixed", reason: "still wrong" });
      const escBefore = await full(esc.id);
      assert.equal(escBefore["state"], "escalated");
      await assert.rejects(() => svc.edit(rev2, { commandId: cid("e"), id: esc.id, severity: "minor" }), (e) => code(e, "forbidden") && /only the owner/.test((e as Error).message));
      await svc.override(owner, { commandId: cid("o"), id: other.id, outcome: "accept-as-is", reason: "minor, ship it" });
      const kept = (await full(other.id))["overrideRecords"][0].remaining.map((x: any) => [x.defectId, x.finding]);
      await svc.edit(owner, { commandId: cid("e"), id: esc.id, finding: "escalates, restated", severity: "major" });
      const escAfter = await full(esc.id);
      assert.deepEqual([escAfter["state"], escAfter["cycles"], escAfter["checks"].length, escAfter["checks"][0].verdict, escAfter["finding"].text, escAfter["severity"]], ["escalated", 1, 1, "not-fixed", "escalates, restated", "major"]);
      assert.deepEqual((await full(other.id))["overrideRecords"][0].remaining.map((x: any) => [x.defectId, x.finding]), kept, "an earlier decision keeps the finding it was made on");
      assert.deepEqual((await svc.unresolved(owner, { escalatedOnly: true })).items.map((x) => [x.id, x["finding"]]), [[esc.id, { text: "escalates, restated" }]]);
      // The owner's later repair-again keeps the edits and the count.
      await svc.override(owner, { commandId: cid("o"), id: esc.id, outcome: "repair-again", reason: "once more" });
      assert.deepEqual([(await full(esc.id))["state"], (await full(esc.id))["edits"].length, (await full(esc.id))["cycles"]], ["open", 1, 1]);
      await assert.rejects(() => svc.edit(rev2, { commandId: cid("e"), id: esc.id, severity: "minor" }), (e) => code(e, "forbidden"), "after a failed check the reporter stays out even once it is open again");

      // A finished defect is no longer corrected: withdrawn, accepted as it is, or found fixed.
      await assert.rejects(() => svc.edit(owner, { commandId: cid("e"), id: other.id, severity: "critical" }), (e) => code(e, "invalid_transition"));
      const gone = await report2(rev, "withdrawn soon");
      await svc.withdraw(rev, { commandId: cid("w"), id: gone.id, reason: "mistaken" });
      await assert.rejects(() => svc.edit(owner, { commandId: cid("e"), id: gone.id, severity: "critical" }), (e) => code(e, "invalid_transition"));
      const fixed = await report2(rev2, "fixed soon");
      await svc.repair(ann, { commandId: cid("rp"), id: fixed.id, version: g2v2 });
      await svc.review(rev3, { commandId: cid("rv"), id: fixed.id, verdict: "fixed" });
      assert.equal((await full(fixed.id))["state"], "resolved");
      await assert.rejects(() => svc.edit(owner, { commandId: cid("e"), id: fixed.id, severity: "critical" }), (e) => code(e, "invalid_transition"));
      assert.equal((await full(fixed.id))["edits"], undefined);

      // The count is bounded: 20 edits are kept, the 21st is refused and nothing is lost.
      const many = await report2(rev, "edited often");
      for (let i = 0; i < MAX_DEFECT_EDITS; i++) await svc.edit(owner, { commandId: cid("e"), id: many.id, finding: `edited often, round ${i}` });
      assert.equal((await full(many.id))["edits"].length, MAX_DEFECT_EDITS);
      await assert.rejects(() => svc.edit(owner, { commandId: cid("e"), id: many.id, finding: "one too many" }), (e) => code(e, "invalid_transition") && /withdraw it and report it again/.test((e as Error).message));
      assert.deepEqual([(await full(many.id))["finding"].text, (await full(many.id))["edits"][0].previousFinding], [`edited often, round ${MAX_DEFECT_EDITS - 1}`, "edited often"]);
      // An edits value that is not a list (a hand-edited record) reads as none and the next edit starts a fresh list.
      const odd = await report2(rev, "odd record");
      const oRef = { kind: "defect", id: odd.id };
      const oAgg = (await runner.get("defect", odd.id))!;
      await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { id: odd.id }, build: async () => ({ ref: oRef, creates: false, changes: [{ type: "update" as const, ref: oRef, expectedRevision: oAgg.revision, body: { ...oAgg.body, edits: "junk" } as unknown as JsonObject }], detail: {} }) }));
      await svc.edit(owner, { commandId: cid("e"), id: odd.id, severity: "major" });
      assert.equal((await full(odd.id))["edits"].length, 1);

      // Races. Two edits pinned to the revision read: exactly one applies, the other is stale. An edit and a withdrawal: whichever lost is refused, never applied over the other.
      const r1 = await report2(rev, "race edits");
      const pinned = await Promise.allSettled([
        svc.edit(rev, { commandId: cid("e"), id: r1.id, finding: "race edits, one", expectedRevision: r1.revision }),
        svc.edit(owner, { commandId: cid("e"), id: r1.id, finding: "race edits, two", expectedRevision: r1.revision }),
      ]);
      assert.equal(pinned.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(pinned));
      assert.ok(pinned.every((r) => r.status === "fulfilled" || code(r.reason, "stale_revision")), JSON.stringify(pinned));
      assert.equal((await full(r1.id))["edits"].length, 1);
      const r2 = await report2(rev, "race withdraw");
      const mixed = await Promise.allSettled([
        svc.edit(rev, { commandId: cid("e"), id: r2.id, finding: "race withdraw, edited" }),
        svc.withdraw(rev, { commandId: cid("w"), id: r2.id, reason: "race" }),
      ]);
      assert.ok(mixed.some((r) => r.status === "fulfilled"), JSON.stringify(mixed));
      assert.ok(mixed.every((r) => r.status === "fulfilled" || code(r.reason, "stale_revision") || code(r.reason, "invalid_transition")), JSON.stringify(mixed));
      const r2end = await full(r2.id);
      assert.equal(r2end["state"] === "withdrawn", mixed[1].status === "fulfilled");
      assert.equal((r2end["edits"] ?? []).length, mixed[0].status === "fulfilled" ? 1 : 0, "an edit that was refused left nothing");
      const r3 = await report2(rev, "race decision");
      const decided = await Promise.allSettled([
        svc.edit(owner, { commandId: cid("e"), id: r3.id, severity: "critical" }),
        svc.override(owner, { commandId: cid("o"), id: r3.id, outcome: "accept-as-is", reason: "fine" }),
      ]);
      assert.ok(decided.some((r) => r.status === "fulfilled"), JSON.stringify(decided));
      assert.ok(decided.every((r) => r.status === "fulfilled" || code(r.reason, "stale_revision") || code(r.reason, "invalid_transition")), JSON.stringify(decided));
      assert.equal((await full(r3.id))["state"] === "overridden", decided[1].status === "fulfilled");

      // Through the operation table: the arguments are checked, a command ID is needed, a repeat is answered from the record.
      const op = OPERATIONS.find((o) => o.name === "defect.edit")!;
      const run = (principal: Principal, args: Record<string, unknown>, commandId?: string): Promise<Record<string, any>> => op.run({ principal, defects: svc } as never, args as never, commandId as never) as Promise<Record<string, any>>;
      const viaOp = await report2(rev, "through the operation table");
      await assert.rejects(() => run(rev, { id: viaOp.id, severity: "major", extra: 1 }, cid("e")), (e) => code(e, "invalid_command"));
      await assert.rejects(() => run(rev, { id: viaOp.id, severity: "major" }), (e) => code(e, "invalid_command") && /commandId/.test((e as Error).message));
      await assert.rejects(() => run(far, { id: viaOp.id, severity: "major" }, cid("e")), (e) => code(e, "not_found"));
      await assert.rejects(() => run(ann, { id: viaOp.id, severity: "major" }, cid("e")), (e) => code(e, "forbidden"));
      assert.equal((await full(viaOp.id))["edits"], undefined);
      const opCommand = cid("e");
      const done = await run(rev, { id: viaOp.id, finding: "x".repeat(2000), severity: "major", expectedRevision: viaOp.revision }, opCommand);
      assert.deepEqual([done["id"], done["revision"], done["replayed"]], [viaOp.id, viaOp.revision + 1, false]);
      assert.equal((await run(rev, { id: viaOp.id, finding: "x".repeat(2000), severity: "major", expectedRevision: viaOp.revision }, opCommand))["replayed"], true);
      await assert.rejects(() => run(rev, { id: viaOp.id, finding: "y", severity: "major", expectedRevision: viaOp.revision }, opCommand), (e) => code(e, "command_conflict"));
      assert.equal((await full(viaOp.id))["finding"].text.length, 2000);
    } finally {
      await world.close();
    }
  });
}

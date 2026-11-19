import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { CommandRunner } from "../domain/runner.js";
import type { JsonObject } from "../storage/types.js";
import { AcceptanceService, DefectService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};

for (const backend of backends) {
  test(`${backend.name}: a defect links to its version and finding, repair and review cycles escalate at the limit, an override never rewrites a failed check (card Q04)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[], grants = [{ action: "task.read", project }]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const artifact = async (name: string): Promise<string> => {
        const id = derivedId("art", cid("art"));
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { id }, build: async () => ({ ref: { kind: "artifact", id }, creates: true, changes: [{ type: "create" as const, ref: { kind: "artifact", id }, body: { name, projectId: project, taskId: task, entries: [], manifestDigest: `m-${name}`, totalBytes: 0, createdBy: owner.id } as unknown as JsonObject }], detail: {} }) }));
        return id;
      };
      const acc = AcceptanceService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        contractVersion: async () => 0,
        verifyArtifact: async () => ({ ok: true, problems: 0 }),
        reviewersAvailableIn: async (_p, worker) => [...roles].filter(([id, r]) => id !== worker && (r.includes("reviewer") || r.includes("director"))).map(([id]) => id),
      }, options);
      let limit = 2;
      const notices: { defectId: string; text: string; commandId: string }[] = [];
      let failNotify = false;
      const svc = DefectService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        mayReadDeliverable: async (by, id) => (await acc.get(by, id)) !== undefined,
        cycleLimit: async () => limit,
        notify: async (x) => { if (failNotify) throw new Error("notice not sent"); notices.push(x); },
      }, options);
      const ann = await agent("ann", ["author", "docs"]);
      const rev = await agent("rev", ["reviewer"]);
      const quinn = await agent("quinn", ["qa", "docs"]);
      const eve = await agent("eve", []);
      const far = await agent("far", ["reviewer"], []);
      const a1 = await artifact("one");

      // Version 1 is submitted, reviewed and rejected; the rejection is event 4 of the deliverable.
      const made = await acc.draft(ann, { commandId: cid("d"), taskId: task, type: "document", title: "Guide", artifacts: [{ artifactId: a1 }] });
      const id = made.id;
      await acc.submit(ann, { commandId: cid("s"), id, expectedRevision: made.revision, contractVersion: 0 });
      await acc.startReview(owner, { commandId: cid("r"), id, version: 1 });
      await acc.reject(owner, { commandId: cid("j"), id, version: 1, reason: "the backup step is missing" });
      const rejection = (await acc.events(owner, id, { limit: 50 })).items.find((e) => e.kind === "rejected")!;
      assert.equal(rejection.seq, 4);
      let next = 2;
      const newVersion = async (): Promise<number> => {
        const cur = (await acc.get(owner, id))!;
        const nv = await acc.newVersion(ann, { commandId: cid("n"), id, expectedRevision: cur["revision"] as number, artifacts: [{ artifactId: a1 }] });
        await acc.submit(ann, { commandId: cid("s"), id, expectedRevision: nv.revision, contractVersion: 0 });
        return next++;
      };

      // Who may report: not the worker, not an agent without a checking role, not someone who cannot read it.
      const report = { deliverableId: id, version: 1, finding: "The guide skips the backup step.", findingEvent: rejection.seq, severity: "major", evidence: [a1, "token=abcdefghijklmnop0123456789"] };
      await refuses("forbidden", () => svc.report(ann, { commandId: cid("f"), ...report }), /contributors/);
      await refuses("forbidden", () => svc.report(eve, { commandId: cid("f"), ...report }), /role/);
      await refuses("not_found", () => svc.report(far, { commandId: cid("f"), ...report }));
      await refuses("invalid_command", () => svc.report(rev, { commandId: cid("f"), ...report, version: 9 }), /versions 1 to 1/);
      await refuses("invalid_command", () => svc.report(rev, { commandId: cid("f"), ...report, findingEvent: 99 }), /findingEvent/);
      await refuses("invalid_command", () => svc.report(rev, { commandId: cid("f"), ...report, severity: "huge" }), /severity/);
      await refuses("invalid_command", () => svc.report(rev, { commandId: cid("f"), ...report, extra: 1 } as never), /extra/);
      const first = await svc.report(rev, { commandId: "rep-1", ...report });
      assert.equal((await svc.report(rev, { commandId: "rep-1", ...report })).replayed, true, "a repeat records once");
      await refuses("command_conflict", () => svc.report(rev, { commandId: "rep-1", ...report, severity: "minor" }));
      const d1 = first.id;
      let got = (await svc.get(owner, d1))!;
      assert.deepEqual([got["deliverableId"], got["version"], (got["finding"] as JsonObject)["eventSeq"], got["severity"], got["state"], got["cycles"], got["limit"], got["responsibleAgent"]], [id, 1, 4, "major", "open", 0, 2, ann.id], "the defect links to the deliverable, the version and the finding");
      assert.ok(!JSON.stringify(got["evidence"]).includes("abcdefghijklmnop0123456789"), "evidence is redacted");
      assert.equal(await svc.get(far, d1), undefined, "unreadable reads as missing");
      await refuses("not_found", () => svc.list(far, id));
      assert.deepEqual((await svc.list(rev, id)).items.map((x) => x["id"]), [d1]);

      // A draft has no defects.
      const cur = (await acc.get(owner, id))!;
      await acc.newVersion(ann, { commandId: cid("n"), id, expectedRevision: cur["revision"] as number, artifacts: [{ artifactId: a1 }] });
      await refuses("invalid_transition", () => svc.report(rev, { commandId: cid("f"), ...report, version: 2, findingEvent: undefined } as never), /draft/);

      // A repair names a newer submitted version; only the responsible agent or the owner submits one.
      await refuses("forbidden", () => svc.repair(rev, { commandId: cid("rp"), id: d1, version: 2 }));
      await refuses("invalid_command", () => svc.repair(ann, { commandId: cid("rp"), id: d1, version: 1 }), /newer than 1/);
      await refuses("invalid_transition", () => svc.repair(ann, { commandId: cid("rp"), id: d1, version: 2 }), /draft/);
      const v2rev = (await acc.get(owner, id))!["revision"] as number;
      await acc.submit(ann, { commandId: cid("s"), id, expectedRevision: v2rev, contractVersion: 0 });
      next = 3;
      await svc.repair(ann, { commandId: cid("rp"), id: d1, version: 2 });
      await refuses("invalid_transition", () => svc.repair(ann, { commandId: cid("rp"), id: d1, version: 2 }), /repair-submitted/);

      // A check by the worker is refused; a failed check needs its reason; the first failure counts one cycle (limit 2).
      await refuses("forbidden", () => svc.review(ann, { commandId: cid("rv"), id: d1, verdict: "fixed" }), /contributors/);
      await refuses("invalid_command", () => svc.review(rev, { commandId: cid("rv"), id: d1, verdict: "not-fixed" }), /reason/);
      const c1 = await svc.review(rev, { commandId: "chk-1", id: d1, verdict: "not-fixed", reason: "still no backup step" });
      assert.deepEqual([c1.state, c1.cycles, c1.limit, c1.replayed], ["open", 1, 2, false]);
      const again = await svc.review(rev, { commandId: "chk-1", id: d1, verdict: "not-fixed", reason: "still no backup step" });
      assert.deepEqual([again.state, again.cycles, again.limit, again.replayed], ["open", 1, 2, true], "a repeat answers with what it recorded");
      assert.equal(notices.length, 0);
      await refuses("invalid_transition", () => svc.review(rev, { commandId: cid("rv"), id: d1, verdict: "fixed" }), /only a submitted repair/);
      await refuses("invalid_command", () => svc.repair(ann, { commandId: cid("rp"), id: d1, version: 2 }), /newer than 2/, );

      // The second failed check reaches the limit: the defect escalates and the owner is told once.
      const v3 = await newVersion();
      await svc.repair(ann, { commandId: cid("rp"), id: d1, version: v3 });
      const c2 = await svc.review(rev, { commandId: "chk-2", id: d1, verdict: "not-fixed", reason: "the step is there but wrong" });
      assert.deepEqual([c2.state, c2.cycles, c2.limit], ["escalated", 2, 2]);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]!.defectId, d1);
      assert.match(notices[0]!.text, /waits for your decision/);
      await svc.review(rev, { commandId: "chk-2", id: d1, verdict: "not-fixed", reason: "the step is there but wrong" });
      assert.deepEqual([...new Set(notices.map((x) => x.commandId))], [notices[0]!.commandId], "a repeat sends the notice again only under the same command ID (recorded once)");
      await refuses("invalid_transition", () => svc.repair(ann, { commandId: cid("rp"), id: d1, version: v3 }), /escalated/);

      // A QA agent reports a second finding in the current version.
      const second = await svc.report(quinn, { commandId: cid("f"), deliverableId: id, version: v3, finding: "Typo in step 2.", severity: "minor" });
      const d2 = second.id;

      // The owner overrides: only the owner; the decision names the remaining findings; the failed checks stay failed.
      const checksBefore = (await svc.get(owner, d1))!["checks"];
      await refuses("forbidden", () => svc.override(rev, { commandId: cid("o"), id: d1, outcome: "accept-as-is", reason: "ok" }));
      await refuses("invalid_command", () => svc.override(owner, { commandId: cid("o"), id: d1, outcome: "pass", reason: "ok" }), /outcome/);
      const ov = await svc.override(owner, { commandId: "ov-1", id: d1, outcome: "accept-as-is", reason: "Ship it; the backup step goes in the next release." });
      assert.equal((await svc.override(owner, { commandId: "ov-1", id: d1, outcome: "accept-as-is", reason: "Ship it; the backup step goes in the next release." })).replayed, true);
      got = (await svc.get(owner, d1))!;
      assert.equal(got["state"], "overridden");
      assert.deepEqual(got["checks"], checksBefore, "no check is changed by the override");
      assert.deepEqual((got["checks"] as JsonObject[]).map((c) => c["verdict"]), ["not-fixed", "not-fixed"], "a failed check is never shown as passed");
      assert.equal(got["cycles"], 2);
      const record = (got["overrideRecords"] as JsonObject[])[0]!;
      assert.equal(record["id"], ov.overrideId);
      assert.deepEqual(record["before"], { state: "escalated", cycles: 2, lastVerdict: "not-fixed" });
      assert.deepEqual((record["remaining"] as JsonObject[]).map((r) => [r["defectId"], r["state"], r["lastVerdict"] ?? null]), [[d1, "escalated", "not-fixed"], [d2, "open", null]], "the decision records every finding still unresolved");
      assert.deepEqual(got["resolution"], { kind: "accepted-as-is", by: owner.id, at: options.clock(), ref: ov.overrideId });
      await refuses("invalid_transition", () => svc.override(owner, { commandId: cid("o"), id: d1, outcome: "repair-again", reason: "no" }), /already overridden/);

      // repair-again keeps the cycle count: after it, the next failure escalates at once.
      await refuses("invalid_transition", () => svc.override(owner, { commandId: cid("o"), id: d2, outcome: "repair-again", reason: "go on" }), /open already/);
      for (let i = 0; i < 2; i++) {
        const v = await newVersion();
        await svc.repair(ann, { commandId: cid("rp"), id: d2, version: v });
        await svc.review(rev, { commandId: cid("rv"), id: d2, verdict: "not-fixed", reason: `round ${i}` });
      }
      assert.equal((await svc.get(owner, d2))!["state"], "escalated");
      // The notice lost to a stop between the check and the notice: the repeat of the check sends it.
      const told = notices.length;
      failNotify = true;
      let v = await newVersion();
      await svc.override(owner, { commandId: cid("o"), id: d2, outcome: "repair-again", reason: "Try again." });
      await svc.repair(ann, { commandId: cid("rp"), id: d2, version: v });
      // repair-again does not drop a repair that waits for its check.
      await refuses("invalid_transition", () => svc.override(owner, { commandId: cid("o"), id: d2, outcome: "repair-again", reason: "go on" }), /waiting for its check/);
      const lost = { commandId: cid("rv"), id: d2, verdict: "not-fixed", reason: "round 2" };
      assert.equal((await svc.review(rev, lost)).state, "escalated");
      assert.equal(notices.length, told, "the notice failed");
      failNotify = false;
      assert.equal((await svc.review(rev, lost)).replayed, true);
      assert.equal(notices.length, told + 1, "the repeat of the check tells the owner");
      assert.match(notices.at(-1)!.text, /failed 3 repair check\(s\), the limit of 2/);
      await svc.override(owner, { commandId: cid("o"), id: d2, outcome: "repair-again", reason: "One more try." });
      // Once the owner decided, a repeat of the check answers as before but tells the owner nothing (the defect no longer waits for them).
      assert.deepEqual([(await svc.review(rev, lost)).replayed, notices.length], [true, told + 1], "no notice after the decision");
      got = (await svc.get(owner, d2))!;
      assert.deepEqual([got["state"], got["cycles"]], ["open", 3], "the count is kept");
      v = await newVersion();
      await svc.repair(ann, { commandId: cid("rp"), id: d2, version: v });
      const c3 = await svc.review(rev, { commandId: cid("rv"), id: d2, verdict: "not-fixed", reason: "still a typo" });
      assert.deepEqual([c3.state, c3.cycles], ["escalated", 4]);
      // The owner raises the limit; a repair then passes and resolves the defect.
      limit = 5;
      await svc.override(owner, { commandId: cid("o"), id: d2, outcome: "repair-again", reason: "Last try." });
      v = await newVersion();
      await svc.repair(ann, { commandId: cid("rp"), id: d2, version: v });
      const fixed = await svc.review(quinn, { commandId: cid("rv"), id: d2, verdict: "fixed" });
      assert.deepEqual([fixed.state, fixed.cycles, fixed.limit], ["resolved", 4, 5]);
      got = (await svc.get(owner, d2))!;
      assert.deepEqual((got["checks"] as JsonObject[]).map((c) => c["verdict"]), ["not-fixed", "not-fixed", "not-fixed", "not-fixed", "fixed"]);
      assert.equal((got["resolution"] as JsonObject)["kind"], "fixed");
      assert.equal((got["overrideRecords"] as JsonObject[]).length, 3);

      // A QA agent that made the repair is one of its contributors and cannot pass it.
      const qa = await acc.draft(quinn, { commandId: cid("d"), taskId: task, type: "report", title: "QA notes", artifacts: [{ artifactId: a1 }] });
      await acc.submit(quinn, { commandId: cid("s"), id: qa.id, expectedRevision: qa.revision, contractVersion: 0 });
      const d3 = (await svc.report(rev, { commandId: cid("f"), deliverableId: qa.id, version: 1, finding: "Numbers do not add up.", severity: "critical" })).id;
      const qcur = (await acc.get(owner, qa.id))!;
      const qnv = await acc.newVersion(quinn, { commandId: cid("n"), id: qa.id, expectedRevision: qcur["revision"] as number, artifacts: [{ artifactId: a1 }] });
      await acc.submit(quinn, { commandId: cid("s"), id: qa.id, expectedRevision: qnv.revision, contractVersion: 0 });
      await svc.repair(quinn, { commandId: cid("rp"), id: d3, version: 2 });
      await refuses("forbidden", () => svc.review(quinn, { commandId: cid("rv"), id: d3, verdict: "fixed" }), /contributors/);

      // Two checks at once: exactly one lands.
      const results = await Promise.allSettled([svc.review(rev, { commandId: cid("rv"), id: d3, verdict: "fixed" }), svc.review(owner, { commandId: cid("rv"), id: d3, verdict: "not-fixed", reason: "no" })]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(((await svc.get(owner, d3))!["checks"] as JsonObject[]).length, 1);
    } finally { await world.close(); }
  });
}

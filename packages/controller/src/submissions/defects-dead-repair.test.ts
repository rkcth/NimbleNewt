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
  test(`${backend.name}: a repair in a rejected or replaced version cannot be found fixed; a newer repair takes its place without a cycle (card Q04)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const art = derivedId("art", cid("art"));
      await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { id: art }, build: async () => ({ ref: { kind: "artifact", id: art }, creates: true, changes: [{ type: "create" as const, ref: { kind: "artifact", id: art }, body: { name: "one", projectId: project, taskId: task, entries: [], manifestDigest: "m-one", totalBytes: 0, createdBy: owner.id } as unknown as JsonObject }], detail: {} }) }));
      const acc = AcceptanceService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        contractVersion: async () => 0,
        verifyArtifact: async () => ({ ok: true, problems: 0 }),
        reviewersAvailableIn: async (_p, worker) => [...roles].filter(([id, r]) => id !== worker && (r.includes("reviewer") || r.includes("director"))).map(([id]) => id),
      }, options);
      const svc = DefectService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        mayReadDeliverable: async (by, id) => (await acc.get(by, id)) !== undefined,
        cycleLimit: async () => 3,
      }, options);
      const ann = await agent("ann", ["author", "docs"]);
      const rev = await agent("rev", ["reviewer"]);

      const made = await acc.draft(ann, { commandId: cid("d"), taskId: task, type: "document", title: "Guide", artifacts: [{ artifactId: art }] });
      const id = made.id;
      await acc.submit(ann, { commandId: cid("s"), id, expectedRevision: made.revision, contractVersion: 0 });
      // A new submitted version of the deliverable (the previous one is replaced unless it was rejected).
      const submitNew = async (): Promise<number> => {
        const cur = (await acc.get(owner, id))!;
        const nv = await acc.newVersion(ann, { commandId: cid("n"), id, expectedRevision: cur["revision"] as number, artifacts: [{ artifactId: art }] });
        await acc.submit(ann, { commandId: cid("s"), id, expectedRevision: nv.revision, contractVersion: 0 });
        return ((await acc.get(owner, id))!["currentVersion"] as number);
      };
      const reject = async (version: number): Promise<void> => {
        await acc.startReview(owner, { commandId: cid("r"), id, version });
        await acc.reject(owner, { commandId: cid("j"), id, version, reason: "not good enough" });
      };
      await reject(1);
      const report = (finding: string): Promise<{ id: string }> => svc.report(rev, { commandId: cid("f"), deliverableId: id, version: 1, finding, severity: "major" });
      const d1 = (await report("First finding.")).id;

      // Repair in version 2, which is then rejected: it cannot be found fixed, and the repair is not checked.
      const v2 = await submitNew();
      await svc.repair(ann, { commandId: cid("rp"), id: d1, version: v2 });
      await refuses("invalid_transition", () => svc.repair(ann, { commandId: cid("rp"), id: d1, version: v2 + 1 }), /repair-submitted/);
      await reject(v2);
      await refuses("invalid_transition", () => svc.review(rev, { commandId: cid("rv"), id: d1, verdict: "fixed" }), /rejected: it cannot be found fixed/);
      assert.deepEqual([(await svc.get(owner, d1))!["state"], (await svc.get(owner, d1))!["cycles"]], ["repair-submitted", 0], "nothing was recorded");
      // The repair names a newer version in its place (never one that is not newer, never a draft); no cycle is counted.
      await refuses("invalid_command", () => svc.repair(ann, { commandId: cid("rp"), id: d1, version: v2 }), /newer than 2/);
      const v3 = await submitNew();
      // Only the responsible agent or the owner names the replacement.
      await refuses("forbidden", () => svc.repair(rev, { commandId: cid("rp"), id: d1, version: v3 }), /responsible agent or the owner/);
      const replace = { commandId: cid("rp"), id: d1, version: v3 };
      assert.equal((await svc.repair(ann, replace)).replayed, false);
      let got = (await svc.get(owner, d1))!;
      assert.deepEqual([got["state"], got["cycles"], got["repairVersion"]], ["repair-submitted", 0, v3]);
      // A repeat of the replacement records nothing more.
      const again = await svc.repair(ann, replace);
      assert.deepEqual([again.replayed, again.revision], [true, got["revision"]]);
      // A version replaced by a newer one is no longer found fixed either: the newer version is the repair to check.
      const seen = got["revision"] as number;
      const v4 = await submitNew();
      await refuses("invalid_transition", () => svc.review(rev, { commandId: cid("rv"), id: d1, verdict: "fixed" }), /superseded: it cannot be found fixed/);
      await svc.repair(owner, { commandId: cid("rp"), id: d1, version: v4 });
      // A check written for the repair the reviewer examined (version 3) does not apply to its replacement.
      await refuses("stale_revision", () => svc.review(rev, { commandId: cid("rv"), id: d1, verdict: "fixed", expectedRevision: seen }));
      got = (await svc.get(owner, d1))!;
      assert.deepEqual([got["state"], got["repairVersion"], (got["checks"] as JsonObject[]).length], ["repair-submitted", v4, 0]);
      const done = await svc.review(rev, { commandId: cid("rv"), id: d1, verdict: "fixed", expectedRevision: got["revision"] as number });
      assert.deepEqual([done.state, done.cycles], ["resolved", 0]);
      assert.deepEqual(((await svc.get(owner, d1))!["checks"] as JsonObject[]).map((c) => [c["version"], c["verdict"]]), [[v4, "fixed"]], "the one check names the version it judged");

      // A repair in a dead version may still be found not fixed: that counts one cycle as before.
      const d2 = (await report("Second finding.")).id;
      const v5 = await submitNew();
      await svc.repair(ann, { commandId: cid("rp"), id: d2, version: v5 });
      await submitNew();
      const nf = await svc.review(rev, { commandId: cid("rv"), id: d2, verdict: "not-fixed", reason: "still wrong" });
      assert.deepEqual([nf.state, nf.cycles], ["open", 1]);
      // A live repair is unaffected: a second repair is refused while one waits.
      const v7 = (await acc.get(owner, id))!["currentVersion"] as number;
      await svc.repair(ann, { commandId: cid("rp"), id: d2, version: v7 });
      await refuses("invalid_transition", () => svc.repair(ann, { commandId: cid("rp"), id: d2, version: v7 + 1 }), /repair-submitted/);
      // A replacement keeps the cycles already counted (never resets them).
      const v8 = await submitNew();
      await svc.repair(ann, { commandId: cid("rp"), id: d2, version: v8 });
      got = (await svc.get(owner, d2))!;
      assert.deepEqual([got["state"], got["cycles"], got["repairVersion"]], ["repair-submitted", 1, v8]);
      // Two replacements at once: exactly one lands; the other is refused (the defect changed meanwhile, or now holds a live repair).
      const v9 = await submitNew();
      const raced = await Promise.allSettled([svc.repair(ann, { commandId: cid("rp"), id: d2, version: v9 }), svc.repair(owner, { commandId: cid("rp"), id: d2, version: v9 })]);
      assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(raced.map((r) => r.status)));
      const lost = raced.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assert.ok(lost.reason instanceof DomainError && ["invalid_transition", "stale_revision"].includes(lost.reason.code), String(lost.reason));
      got = (await svc.get(owner, d2))!;
      assert.deepEqual([got["state"], got["cycles"], got["repairVersion"]], ["repair-submitted", 1, v9]);
      // Failed checks of dead versions count toward the limit: the third escalates to the owner.
      assert.equal((await svc.review(rev, { commandId: cid("rv"), id: d2, verdict: "not-fixed", reason: "still wrong" })).cycles, 2);
      const v10 = await submitNew();
      await svc.repair(ann, { commandId: cid("rp"), id: d2, version: v10 });
      await submitNew();
      const last = await svc.review(rev, { commandId: cid("rv"), id: d2, verdict: "not-fixed", reason: "still wrong" });
      assert.deepEqual([last.state, last.cycles, last.limit], ["escalated", 3, 3]);
      await refuses("invalid_transition", () => svc.repair(ann, { commandId: cid("rp"), id: d2, version: v10 + 1 }), /escalated to the owner/);
    } finally { await world.close(); }
  });
}

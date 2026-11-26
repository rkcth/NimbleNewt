import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { assignmentIdOf } from "../domain/assignment-model.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { DocObligationService, QaEvidenceService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-19T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const treeA = "a".repeat(40);
const treeB = "b".repeat(40);
const treeC = "f".repeat(40);

for (const backend of backends) {
  test(`${backend.name}: documentation obligations are verified only against tested code; a behaviour change or a release flags them and opens assigned update tasks (card Q03)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const other = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Q" })).id;
      const login = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Login" })).id;
      const search = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Search" })).id;
      const elsewhere = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: other, title: "X" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[], inProject = project): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project: inProject }] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id }, build: async () => ({ ref: { kind, id }, creates: true, changes: [{ type: "create" as const, ref: { kind, id }, body: body as JsonObject }], detail: {} }) }));
      };
      const rolesOf = async (id: string): Promise<string[]> => roles.get(id) ?? [];
      const qa = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf }, options);
      const docs = DocObligationService.withEpoch(world.storage, projects.epoch, {
        rolesOf,
        gate: (by, s) => qa.gate(by, s),
        newestChecked: async (by, t) => (await qa.list(by, t)).items.find((e) => e.source === "independent")?.submissionId,
        projects, assignments,
        readDocument: async () => ({ files: [{ path: "index.html", text: "Sign in with a passkey." }], skipped: [] }),
      }, options);
      const ann = await agent("ann", ["author"]);
      const quinn = await agent("quinn", ["qa"]);
      const dora = await agent("dora", ["docs"]);
      await docs.setCapability(owner, { commandId: cid("cap"), projectId: project, capabilityId: "passkey-sign-in", name: "passkey sign-in", maturity: "supported" });
      const pat = await agent("pat", ["author"]);
      const far = await agent("far", ["docs"], other);
      const code = async (task: string, tree: string): Promise<string> => {
        const id = derivedId("sbm", cid("code"));
        await plant("submission", id, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: ann.id, submittedAt: "2026-11-19T09:00:00.000Z", makesCommit: true, base: "c".repeat(40), tree, patchId: "d".repeat(40), evidence: [] });
        return id;
      };
      const tested = async (sub: string, result: "passed" | "failed" = "passed"): Promise<void> => {
        await qa.record(quinn, { commandId: cid("qa"), submissionId: sub, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-19T09:30:00.000Z", checks: [{ name: "unit", result }] });
      };
      const document = derivedId("sbm", cid("doc"));
      await plant("submission", document, { taskId: login, projectId: project, kind: "document", role: "docs", submittedBy: dora.id, submittedAt: "2026-11-19T09:40:00.000Z", makesCommit: false, artifactId: "art-aaaaaaaaaaaaaaaaaaaa", artifactDigest: `sha256:${"e".repeat(64)}`, evidence: [] });

      // Recording: a claim must name one of the document's implementing tasks; the owner must be an active agent; a keeper of documents records; others see nothing.
      const promo = { projectId: project, title: "Landing page", location: "site/index.html", audience: "promotional", owner: dora.id, applicableVersion: "1.0", implementationRefs: [login], claims: [{ text: "Sign in with a passkey", taskId: login, capabilityId: "passkey-sign-in" }] };
      await refuses("invalid_command", () => docs.record(owner, { commandId: cid("r"), ...promo, claims: [{ text: "Instant search", taskId: search }] }), /unsupported claim/);
      await refuses("invalid_command", () => docs.record(owner, { commandId: cid("r"), ...promo, owner: "agent:nobody" }), /not an active agent/);
      await refuses("invalid_command", () => docs.record(owner, { commandId: cid("r"), ...promo, owner: far.id }), /may not read this project's tasks/);
      await refuses("invalid_command", () => docs.record(owner, { commandId: cid("r"), ...promo, implementationRefs: [login, elsewhere], claims: [] }), /not a task of this project/);
      await refuses("forbidden", () => docs.record(pat, { commandId: cid("r"), ...promo }));
      await refuses("not_found", () => docs.record(far, { commandId: cid("r"), ...promo }));
      const p1 = await docs.record(dora, { commandId: "promo", ...promo });
      assert.equal(p1.state, "unverified");
      assert.equal((await docs.record(dora, { commandId: "promo", ...promo })).replayed, true);
      const guide = await docs.record(owner, { commandId: cid("r"), projectId: project, title: "User guide: signing in", location: "docs/guide.md", audience: "user", owner: dora.id, applicableVersion: "1.0", implementationRefs: [login] });
      assert.deepEqual((await docs.list(pat, project)).items.map((i) => [i.id, i.state, i.flagged]), [[p1.id, "unverified", true], [guide.id, "unverified", true]], "unverified documents are flagged");
      await refuses("not_found", () => docs.list(far, project));

      // Verification: only against code whose QA gate passes; a claim on untested code is unsupported.
      const sub1 = await code(login, treeA);
      const verify = { obligationId: p1.id, expectedRevision: 1, documentSubmissionId: document, evidence: [sub1] };
      await refuses("invalid_command", () => docs.verify(dora, { commandId: cid("v"), ...verify }), /unsupported: "Sign in with a passkey"/);
      await tested(sub1);
      await refuses("invalid_command", () => docs.verify(dora, { commandId: cid("v"), ...verify, documentSubmissionId: sub1 }), /kind document/);
      await refuses("forbidden", () => docs.verify(pat, { commandId: cid("v"), ...verify }));
      const foreignDoc = derivedId("sbm", cid("doc"));
      await plant("submission", foreignDoc, { taskId: elsewhere, projectId: other, kind: "document", role: "docs", submittedBy: far.id, submittedAt: "2026-11-19T09:40:00.000Z", makesCommit: false, artifactId: "art-aaaaaaaaaaaaaaaaaaaa", artifactDigest: `sha256:${"e".repeat(64)}`, evidence: [] });
      await refuses("invalid_command", () => docs.verify(dora, { commandId: cid("v"), ...verify, documentSubmissionId: foreignDoc }), /not a submission of this project/);
      const searchCode = await code(search, treeA);
      await refuses("invalid_command", () => docs.verify(dora, { commandId: cid("v"), ...verify, evidence: [searchCode] }), /does not describe/);
      const v1 = await docs.verify(dora, { commandId: cid("v"), ...verify });
      const verified = (await docs.get(owner, p1.id)) as unknown as { state: string; verification: { evidence: { submissionId: string; tree: string }[]; artifactDigest: string } };
      assert.equal(verified.state, "verified");
      assert.deepEqual(verified.verification.evidence.map((e) => [e.submissionId, e.tree]), [[sub1, treeA]], "the document links to the tested artifact");

      // A behaviour change: new tested code of the task. The verified document goes stale, the unverified one is flagged too, each with an update task assigned to its owner.
      const sub2 = await code(login, treeB);
      await tested(sub2);
      await refuses("forbidden", () => docs.impact(pat, { commandId: cid("i"), taskId: login }));
      const impact = await docs.impact(owner, { commandId: "impact-1", taskId: login });
      assert.equal(impact.submissionId, sub2, "the newest independently checked code is used when none is named");
      assert.deepEqual([...impact.flagged].sort(), [p1.id, guide.id].sort());
      assert.equal(impact.tasks.length, 2);
      for (const t of impact.tasks) {
        assert.equal(t.assigned, true);
        const task = (await runner.get("task", t.taskId))?.body as unknown as { state: string; title: string; description: string; projectId: string };
        assert.equal(task.state, "ready");
        assert.match(task.description, new RegExp(sub2));
        const a = (await runner.get("assignment", assignmentIdOf(t.taskId)))?.body as unknown as { owner: { id: string } };
        assert.equal(a.owner.id, "dora", "assigned to the document's owner");
      }
      const stale = (await docs.get(owner, p1.id)) as unknown as { state: string; reasons: { kind: string; from?: string; tree: string }[] };
      assert.equal(stale.state, "stale");
      assert.deepEqual(stale.reasons.map((r) => [r.kind, r.from, r.tree]), [["behavior_changed", treeA, treeB]]);
      assert.equal(((await docs.get(owner, guide.id)) as unknown as { state: string }).state, "unverified");
      const again = await docs.impact(owner, { commandId: "impact-1", taskId: login });
      assert.deepEqual([again.flagged, again.tasks.length], [[], 0], "a repeat flags nothing and opens nothing new");
      assert.deepEqual((await docs.impact(owner, { commandId: cid("i"), taskId: login, submissionId: sub2 })).flagged, [], "asked again for the same code: nothing is repeated");
      const revOf = async (id: string): Promise<number> => (await docs.get(owner, id))!["revision"] as number;
      const rev0 = await revOf(p1.id);
      await refuses("invalid_command", () => docs.verify(dora, { commandId: cid("v"), obligationId: p1.id, expectedRevision: rev0, documentSubmissionId: document, evidence: [sub1] }), /flagged for its new tested code/);

      // Code whose QA gate does not pass is not tested behaviour: it flags nothing.
      const sub3 = await code(login, treeC);
      const untested = await docs.impact(owner, { commandId: cid("i"), taskId: login, submissionId: sub3 });
      assert.deepEqual([untested.verdict, untested.flagged, untested.tasks.length, await revOf(p1.id)], ["failed", [], 0, rev0], "untested code flags nothing");
      // A further tested change of the same task while its update task is open: noted on the record, no second task; the verification must be against the newest tree.
      await tested(sub3);
      const further = await docs.impact(owner, { commandId: cid("i"), taskId: login, submissionId: sub3 });
      assert.deepEqual([[...further.flagged].sort(), further.tasks.length], [[p1.id, guide.id].sort(), 0], "one open update task per described task");
      const noted = (await docs.get(owner, p1.id)) as unknown as { updates: unknown[]; reasons: { tree: string }[] };
      assert.deepEqual([noted.updates.length, noted.reasons.map((r) => r.tree)], [1, [treeB, treeC]]);
      const rev1 = await revOf(p1.id);
      await refuses("invalid_command", () => docs.verify(dora, { commandId: cid("v"), obligationId: p1.id, expectedRevision: rev1, documentSubmissionId: document, evidence: [sub2] }), /verify it against that tree/);

      // Verifying against the newest tested code settles the update.
      const v2 = await docs.verify(dora, { commandId: cid("v"), obligationId: p1.id, expectedRevision: await revOf(p1.id), documentSubmissionId: document, evidence: [sub3] });
      assert.equal(v2.settled.length, 1);
      void v1;

      // The tested code it was checked against fails QA later: the document goes stale again.
      await tested(sub3, "failed");
      const lost = await docs.impact(dora, { commandId: cid("i"), taskId: login, submissionId: sub3 });
      assert.deepEqual(lost.flagged, [p1.id]);
      assert.deepEqual(((await docs.get(owner, p1.id)) as unknown as { reasons: { kind: string }[] }).reasons.map((r) => r.kind), ["evidence_lost"], "a verification cleared the earlier reasons");

      // A release flags every document that applies to another version, of every audience, and a verification must then name the release version.
      const rel = await docs.release(owner, { commandId: cid("rel"), projectId: project, version: "2.0" });
      assert.deepEqual(rel.byAudience, { user: 1, developer: 0, support: 0, promotional: 1 });
      assert.equal(rel.tasks.length, 2);
      assert.deepEqual((await docs.release(owner, { commandId: cid("rel"), projectId: project, version: "2.0" })).flagged, [], "the same release flags nothing twice");
      await tested(sub3);
      const rev = (await docs.get(owner, p1.id))!["revision"] as number;
      await refuses("invalid_command", () => docs.verify(dora, { commandId: cid("v"), obligationId: p1.id, expectedRevision: rev, documentSubmissionId: document, evidence: [sub3] }), /version 2\.0/);
      await refuses("stale_revision", () => docs.verify(dora, { commandId: cid("v"), obligationId: p1.id, expectedRevision: rev - 1, documentSubmissionId: document, evidence: [sub3], applicableVersion: "2.0" }));
      const v3 = await docs.verify(owner, { commandId: cid("v"), obligationId: p1.id, expectedRevision: rev, documentSubmissionId: document, evidence: [sub3], applicableVersion: "2.0" });
      assert.equal(v3.settled.length, 2, "the evidence-lost and release updates are settled");
      const now = (await docs.get(owner, p1.id)) as unknown as { state: string; applicableVersion: string; releaseVersion?: string };
      assert.deepEqual([now.state, now.applicableVersion, now.releaseVersion], ["verified", "2.0", undefined]);

      // Going back to code the document was flagged for in an earlier, settled round flags it again, with a new update task.
      const back = await docs.impact(owner, { commandId: cid("i"), taskId: login, submissionId: sub2 });
      assert.deepEqual(back.flagged, [p1.id], "the guide still has its update task open for the login task, so only the page is new");
      const firstTask = impact.tasks.find((t) => t.obligationId === p1.id)!.taskId;
      assert.equal(back.tasks.length, 1);
      assert.notEqual(back.tasks[0]!.taskId, firstTask, "a new update task, not the settled one again");
      assert.equal(((await runner.get("task", back.tasks[0]!.taskId))?.body as unknown as { state: string }).state, "ready");
      await docs.verify(dora, { commandId: cid("v"), obligationId: p1.id, expectedRevision: await revOf(p1.id), documentSubmissionId: document, evidence: [sub2] });

      // Replacing the obligation with new claims makes it unverified again; a new owner alone keeps its state.
      const r1 = (await docs.get(owner, p1.id))!["revision"] as number;
      const kept = await docs.record(owner, { commandId: cid("r"), ...promo, obligationId: p1.id, expectedRevision: r1, applicableVersion: "2.0", owner: dora.id, title: "Landing page (new)" });
      assert.equal(kept.state, "verified");
      const changed = await docs.record(owner, { commandId: cid("r"), ...promo, obligationId: p1.id, expectedRevision: kept.revision, applicableVersion: "2.0", claims: [{ text: "Sign in with a passkey or a code", taskId: login, capabilityId: "passkey-sign-in" }] });
      assert.equal(changed.state, "unverified");

      // Two release checks at once (different command IDs): one update task per document, none twice. The guide's release update for 2.0 is still open, so 3.0 is only noted on it.
      const both = await Promise.allSettled([1, 2].map((k) => docs.release(owner, { commandId: cid(`race${k}`), projectId: project, version: "3.0" })));
      for (const r of both) if (r.status === "rejected") assert.equal((r.reason as DomainError).code, "stale_revision", String(r.reason));
      const opened = both.flatMap((r) => (r.status === "fulfilled" ? r.value.tasks : []));
      // Both callers may finish opening the same task (a crash between the flag and the task is finished by whoever asks next): it is one task, made once.
      assert.deepEqual([...new Set(opened.map((t) => `${t.obligationId}/${t.taskId}`))], [`${p1.id}/${opened[0]!.taskId}`], "one new update task, for the page only");
      assert.ok(opened.every((t) => t.assigned));
      const page = (await docs.get(owner, p1.id)) as unknown as { updates: { reason: { kind: string; to?: string } }[] };
      assert.equal(page.updates.filter((u) => u.reason.kind === "release_changed" && u.reason.to === "3.0").length, 1);
      const guideNow = (await docs.get(owner, guide.id)) as unknown as { releaseVersion: string; updates: { state: string }[] };
      assert.deepEqual([guideNow.releaseVersion, guideNow.updates.filter((u) => u.state === "open").length], ["3.0", 2], "noted on the guide; its open login and release tasks stay the only ones");
    } finally {
      await world.close();
    }
  });

  test(`${backend.name}: a flag is answered only by a document change made since it, re-recording keeps it, a command ID is not reused for other arguments, the update task text is redacted and a half-opened update task is finished (card Q03)`, async () => {
    const world = await backend.open();
    try {
      // A clock that moves, so a document change can be older than a flag.
      let at = Date.parse("2026-11-19T10:00:00.000Z");
      const moving = { clock: () => new Date((at += 1000)).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...moving });
      const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, moving);
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, moving);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const login = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Login" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const runner = new CommandRunner(world.storage, projects.epoch, moving);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id }, build: async () => ({ ref: { kind, id }, creates: true, changes: [{ type: "create" as const, ref: { kind, id }, body: body as JsonObject }], detail: {} }) }));
      };
      const rolesOf = async (id: string): Promise<string[]> => roles.get(id) ?? [];
      const qa = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf }, moving);
      let failReady = false;
      let failAssign = false;
      const docs = DocObligationService.withEpoch(world.storage, projects.epoch, {
        rolesOf,
        gate: (by, sub) => qa.gate(by, sub),
        newestChecked: async (by, t) => (await qa.list(by, t)).items.find((e) => e.source === "independent")?.submissionId,
        // Making an update task ready fails once, as a crash between the steps of opening it would.
        projects: { createTask: (c) => projects.createTask(c), transitionTask: async (c) => { if (failReady) { failReady = false; throw new Error("stopped between steps"); } return projects.transitionTask(c); } },
        // Assigning an update task fails once the same way: the task is left ready with no assignment.
        assignments: { assignTask: async (c) => { if (failAssign) { failAssign = false; throw new Error("stopped between steps"); } return assignments.assignTask(c); } },
        readDocument: async () => ({ files: [{ path: "index.html", text: "Sign in with a passkey." }], skipped: [] }),
      }, moving);
      const ann = await agent("ann", ["author"]);
      const quinn = await agent("quinn", ["qa"]);
      const dora = await agent("dora", ["docs"]);
      await docs.setCapability(owner, { commandId: cid("cap"), projectId: project, capabilityId: "passkey-sign-in", name: "passkey sign-in", maturity: "supported" });
      const code = async (tree: string): Promise<string> => {
        const id = derivedId("sbm", cid("code"));
        await plant("submission", id, { taskId: login, projectId: project, kind: "code", role: "author", submittedBy: ann.id, submittedAt: "2026-11-19T09:00:00.000Z", makesCommit: true, base: "c".repeat(40), tree, patchId: "d".repeat(40), evidence: [] });
        await qa.record(quinn, { commandId: cid("qa"), submissionId: id, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-19T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] });
        return id;
      };
      const docChange = async (): Promise<string> => {
        const id = derivedId("sbm", cid("doc"));
        await plant("submission", id, { taskId: login, projectId: project, kind: "document", role: "docs", submittedBy: dora.id, submittedAt: "2026-11-19T09:40:00.000Z", makesCommit: false, artifactId: "art-aaaaaaaaaaaaaaaaaaaa", artifactDigest: `sha256:${"e".repeat(64)}`, evidence: [] });
        return id;
      };
      const get = async (id: string) => (await docs.get(owner, id)) as unknown as { revision: number; state: string; title: string; location: string; reasons?: { tree?: string }[]; releaseVersion?: string; updates: { taskId: string; state: string }[] };

      // The title and the place are kept redacted, like the claims, and so is the update task's text made from them.
      const shaped = "token=abcdefghijklmnop0123456789";
      const page = await docs.record(owner, { commandId: cid("r"), projectId: project, title: `Landing page ${shaped}`, location: `site/index.html?${shaped}`, audience: "promotional", owner: dora.id, applicableVersion: "1.0", implementationRefs: [login], claims: [{ text: "Sign in with a passkey", taskId: login, capabilityId: "passkey-sign-in" }] });
      const recorded = await get(page.id);
      assert.ok(!recorded.title.includes("abcdefghijklmnop0123456789") && !recorded.location.includes("abcdefghijklmnop0123456789"), "title and location are redacted");
      assert.match(recorded.title, /^Landing page /);
      const sub1 = await code(treeA);
      const first = await docChange();
      await docs.verify(dora, { commandId: cid("v"), obligationId: page.id, expectedRevision: recorded.revision, documentSubmissionId: first, evidence: [sub1] });

      // New tested code, and the step that makes the update task ready stops: the flag is written, the task stays proposed. The next check with nothing new finishes it.
      const sub2 = await code(treeB);
      failReady = true;
      await assert.rejects(() => docs.impact(owner, { commandId: "impact-a", taskId: login, submissionId: sub2 }), /stopped between steps/);
      const half = (await get(page.id)).updates.find((u) => u.state === "open")!.taskId;
      const halfTask = (await runner.get("task", half))?.body as unknown as { state: string; title: string; description: string };
      assert.equal(halfTask.state, "proposed");
      assert.ok(!`${halfTask.title}\n${halfTask.description}`.includes("abcdefghijklmnop0123456789"), "the update task's text carries no secret-shaped text");
      const finish = await docs.impact(owner, { commandId: cid("i"), taskId: login, submissionId: sub2 });
      assert.deepEqual([finish.flagged, finish.tasks], [[], [{ obligationId: page.id, taskId: half, assigned: true }]], "nothing new is flagged; the half-opened task is opened");
      assert.equal(((await runner.get("task", half))?.body as unknown as { state: string }).state, "ready");
      assert.equal(((await runner.get("assignment", assignmentIdOf(half)))?.body as unknown as { owner: { id: string } }).owner.id, "dora");

      // The same command ID with other arguments is refused even when nothing new is to be written, for the impact check and the release check alike.
      await refuses("command_conflict", () => docs.impact(owner, { commandId: "impact-a", taskId: login, submissionId: sub1 }));
      assert.equal((await docs.impact(owner, { commandId: "impact-a", taskId: login, submissionId: sub2 })).replayed, true, "the same command again is a replay");
      // The release's update task is made ready but the assignment step stops; the exact repeat is a replay and finishes it.
      failAssign = true;
      await assert.rejects(() => docs.release(owner, { commandId: "rel-a", projectId: project, version: "2.0" }), /stopped between steps/);
      await refuses("command_conflict", () => docs.release(owner, { commandId: "rel-a", projectId: project, version: "1.0" }));
      const unassigned = (await get(page.id)).updates.filter((u) => u.state === "open").map((u) => u.taskId).find((t) => t !== half)!;
      assert.equal(((await runner.get("task", unassigned))?.body as unknown as { state: string }).state, "ready");
      assert.equal(await runner.get("assignment", assignmentIdOf(unassigned)), undefined);
      const again = await docs.release(owner, { commandId: "rel-a", projectId: project, version: "2.0" });
      assert.deepEqual([again.replayed, again.flagged, again.tasks], [true, [], [{ obligationId: page.id, taskId: unassigned, assigned: true }]], "the repeat assigns the ready, unassigned update task");
      assert.equal(((await runner.get("assignment", assignmentIdOf(unassigned)))?.body as unknown as { owner: { id: string } }).owner.id, "dora");

      // Re-recording the flagged document with another claim makes it unverified but keeps what flagged it: the old code, the old version and the old document change still do not verify it.
      const flagged = await get(page.id);
      assert.deepEqual([flagged.state, flagged.releaseVersion, flagged.reasons?.map((r) => r.tree)], ["stale", "2.0", [treeB, undefined]]);
      const replaced = await docs.record(dora, { commandId: cid("r"), obligationId: page.id, expectedRevision: flagged.revision, projectId: project, title: "Landing page", location: "site/index.html", audience: "promotional", owner: dora.id, applicableVersion: "1.0", implementationRefs: [login], claims: [{ text: "Sign in with a passkey or a code", taskId: login, capabilityId: "passkey-sign-in" }] });
      assert.equal(replaced.state, "unverified");
      const kept = await get(page.id);
      assert.deepEqual([kept.releaseVersion, kept.reasons?.map((r) => r.tree)], ["2.0", [treeB, undefined]], "re-recording keeps the flags");
      const fresh = await docChange();
      await refuses("invalid_command", () => docs.verify(dora, { commandId: cid("v"), obligationId: page.id, expectedRevision: kept.revision, documentSubmissionId: fresh, evidence: [sub1], applicableVersion: "2.0" }), /verify it against that tree/);
      await refuses("invalid_command", () => docs.verify(dora, { commandId: cid("v"), obligationId: page.id, expectedRevision: kept.revision, documentSubmissionId: fresh, evidence: [sub2] }), /version 2\.0/);
      await refuses("invalid_command", () => docs.verify(dora, { commandId: cid("v"), obligationId: page.id, expectedRevision: kept.revision, documentSubmissionId: first, evidence: [sub2], applicableVersion: "2.0" }), /before the document was flagged/);
      const done = await docs.verify(dora, { commandId: cid("v"), obligationId: page.id, expectedRevision: kept.revision, documentSubmissionId: fresh, evidence: [sub2], applicableVersion: "2.0" });
      assert.equal(done.settled.length, 2);
      const after = (await docs.get(owner, page.id)) as unknown as { state: string; flaggedAt?: string; reasons?: unknown };
      assert.deepEqual([after.state, after.flaggedAt, after.reasons], ["verified", undefined, undefined], "a verification clears the flags");
    } finally {
      await world.close();
    }
  });
}

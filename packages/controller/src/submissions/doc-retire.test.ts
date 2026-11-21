import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { DOC_AUTO_PRINCIPAL, DocObligationService, type DocObligationBody } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const treeA = "a".repeat(40);
const treeB = "b".repeat(40);

for (const backend of backends) {
  test(`${backend.name}: a document can be retired (it leaves every check and its unstarted update tasks are cancelled), and the owner is told when verified documents go stale on a check they did not run (card Q03)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const login = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Login" })).id;
      const search = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Search" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      // A QA gate the test sets per code submission; the project service is wrapped so a step can run while an update task is being created.
      const gates = new Map<string, { verdict: "passed" | "failed"; tree: string; taskId: string }>();
      let onCreate: ((title: string) => Promise<void>) | undefined;
      const created: string[] = [];
      const wrapped = {
        createTask: async (c: Parameters<ProjectService["createTask"]>[0]) => { created.push(c.title); const run = onCreate; onCreate = undefined; if (run !== undefined) await run(c.title); return projects.createTask(c); },
        transitionTask: (c: Parameters<ProjectService["transitionTask"]>[0]) => projects.transitionTask(c),
      };
      const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
      const notices: { commandId: string; projectId: string; obligationId: string; text: string }[] = [];
      const docs = DocObligationService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        gate: async (_by, s) => gates.get(s) ?? ((): never => { throw new DomainError("not_found", "no such submission"); })(),
        projects: wrapped as never, assignments,
        notify: async (x) => { notices.push(x); },
      }, options);
      const ann = await agent("ann", ["author"]);
      const dora = await agent("dora", ["docs"]);
      const code = (task: string, tree: string): string => { const id = derivedId("sbm", cid("code")); gates.set(id, { verdict: "passed", tree, taskId: task }); return id; };
      const documentChange = async (): Promise<string> => {
        const id = derivedId("sbm", cid("doc"));
        await plant("submission", id, { taskId: login, projectId: project, kind: "document", role: "docs", submittedBy: dora.id, submittedAt: "2026-11-21T10:00:00.000Z", makesCommit: false, artifactDigest: `sha256:${"e".repeat(64)}`, evidence: [] });
        return id;
      };
      const read = async (id: string): Promise<DocObligationBody & { revision: number }> => (await docs.get(owner, id)) as unknown as DocObligationBody & { revision: number };
      const listed = async (): Promise<string[]> => (await docs.list(owner, project)).items.map((i) => i.id);
      const taskState = async (id: string): Promise<string | undefined> => (await projects.getTask(id))?.state;

      // ---- the notice -----------------------------------------------------------------------------------------------------------
      const guide = (await docs.record(owner, { commandId: cid("r"), projectId: project, title: "User guide", location: "docs/guide.md", audience: "user", owner: dora.id, applicableVersion: "1.0", implementationRefs: [login, search] })).id;
      const faq = (await docs.record(dora, { commandId: cid("r"), projectId: project, title: "FAQ", location: "docs/faq.md", audience: "support", owner: dora.id, applicableVersion: "1.0", implementationRefs: [login] })).id;
      const l1 = code(login, treeA);
      const s1 = code(search, treeA);
      // Unverified documents flagged by an agent's check: nothing was verified, so nothing went stale and the owner is not told.
      await docs.impact(dora, { commandId: cid("i"), taskId: login, submissionId: l1 });
      assert.equal(notices.length, 0, "an unverified document flagged is not a stale one");
      const verify = async (id: string, evidence: string[]): Promise<void> => {
        await docs.verify(dora, { commandId: cid("v"), obligationId: id, expectedRevision: (await read(id)).revision, documentSubmissionId: await documentChange(), evidence });
      };
      await verify(guide, [l1, s1]);
      await verify(faq, [l1]);
      // The owner's own check: the owner reads the answer, no notice.
      const l2 = code(login, treeB);
      assert.deepEqual([...(await docs.impact(owner, { commandId: cid("i"), taskId: login, submissionId: l2 })).flagged].sort(), [guide, faq].sort());
      assert.equal(notices.length, 0, "the owner's own check sends no notice");
      await verify(guide, [l2, s1]);
      await verify(faq, [l2]);
      // A docs agent's check that makes verified documents stale: one notice naming them, about the first.
      const l3 = code(login, treeA);
      const agentCheck = cid("i");
      await docs.impact(dora, { commandId: agentCheck, taskId: login, submissionId: l3 });
      assert.equal(notices.length, 1);
      assert.equal(notices[0]!.projectId, project);
      assert.ok([guide, faq].includes(notices[0]!.obligationId));
      assert.match(notices[0]!.text, /^2 verified documents went stale: .*"User guide".*"FAQ"|^2 verified documents went stale: .*"FAQ".*"User guide"/);
      assert.ok(notices[0]!.text.length <= 200);
      // The same check again is a replay: no second notice.
      await docs.impact(dora, { commandId: agentCheck, taskId: login, submissionId: l3 });
      assert.equal(notices.length, 1, "a repeat sends nothing");
      await verify(guide, [l3, s1]);
      await verify(faq, [l3]);
      // A title of characters written as two UTF-16 units each, cut inside one at 60 (first review): the notice is cut on a whole character, so its text stays well-formed (a half character is refused, and the notice would be lost).
      const gr = await read(guide);
      await docs.record(owner, { commandId: cid("r"), projectId: project, obligationId: guide, expectedRevision: gr.revision, title: `a${"\u{1F4D8}".repeat(40)}`, location: "docs/guide.md", audience: "user", owner: dora.id, applicableVersion: "1.0", implementationRefs: [login, search] });
      assert.equal((await read(guide)).state, "verified", "a new title keeps the document verified");
      // A long second title (second review): the two names together make the notice longer than 200 characters, so it is cut to 200 with "..." at the end.
      await docs.record(owner, { commandId: cid("r"), projectId: project, obligationId: faq, expectedRevision: (await read(faq)).revision, title: `Frequently asked questions ${"x".repeat(80)}`, location: "docs/faq.md", audience: "support", owner: dora.id, applicableVersion: "1.0", implementationRefs: [login] });
      assert.equal((await read(faq)).state, "verified");
      // The controller's automatic check after independent QA evidence: the owner is told.
      const l4 = code(login, treeB);
      await docs.afterQaEvidence({ evidenceId: derivedId("qae", cid("qa")), taskId: login, submissionId: l4, source: "independent" });
      assert.equal(notices.length, 2);
      assert.match(notices[1]!.text, /2 verified documents went stale/);
      assert.ok(notices[1]!.text.includes(`"a${"\u{1F4D8}".repeat(29)}"`), notices[1]!.text);
      assert.doesNotMatch(notices[1]!.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no half character");
      assert.ok(notices[1]!.text.length <= 200 && notices[1]!.text.length >= 190 && notices[1]!.text.endsWith("..."), notices[1]!.text);
      assert.notEqual(notices[1]!.commandId, notices[0]!.commandId);
      assert.equal((await read(guide)).updates.find((u) => u.state === "open")?.requestedBy, DOC_AUTO_PRINCIPAL.id);
      // A notice that cannot be sent is not the check's failure.
      await verify(guide, [l4, s1]);
      const failing = DocObligationService.withEpoch(world.storage, projects.epoch, { rolesOf: async (id) => roles.get(id) ?? [], gate: async (_by, s) => gates.get(s)!, projects: wrapped as never, assignments, notify: async () => { throw new DomainError("unavailable", "no channel"); } }, options);
      const l5 = code(login, treeA);
      // (The FAQ was last verified against tree A, the tree of this code, so only the guide is flagged.)
      assert.deepEqual((await failing.impact(dora, { commandId: cid("i"), taskId: login, submissionId: l5 })).flagged, [guide]);
      assert.equal((await read(guide)).state, "stale");

      // ---- retiring -------------------------------------------------------------------------------------------------------------
      // The guide now has an open update task for the login task (from the check just made); a search change opens a second one. One of them is started.
      const s2 = code(search, treeB);
      await docs.impact(owner, { commandId: cid("i"), taskId: search, submissionId: s2 });
      let g = await read(guide);
      const open = g.updates.filter((u) => u.state === "open").map((u) => u.taskId);
      assert.equal(open.length, 2, JSON.stringify(g.updates));
      const started = open[1]!;
      await projects.transitionTask({ commandId: cid("start"), actor: owner.id, taskId: started, expectedRevision: (await projects.getTask(started))!.revision, to: "in_progress" });
      // Who may retire: not an agent without the docs or director role, and only at the revision shown.
      await refuses("forbidden", () => docs.retire(ann, { commandId: cid("x"), obligationId: guide, expectedRevision: g.revision }));
      await refuses("stale_revision", () => docs.retire(dora, { commandId: cid("x"), obligationId: guide, expectedRevision: g.revision - 1 }));
      await refuses("invalid_command", () => docs.retire(dora, { commandId: cid("x"), obligationId: guide, expectedRevision: g.revision, reason: "" }));
      const retireId = cid("x");
      const shown = g.revision;
      const r = await docs.retire(dora, { commandId: retireId, obligationId: guide, expectedRevision: shown, reason: "merged into the handbook" });
      assert.deepEqual([r.replayed, r.cancelled, r.running], [false, [open[0]], [started]]);
      assert.equal(await taskState(open[0]!), "cancelled", "an update task not yet started is cancelled");
      assert.equal(await taskState(started), "in_progress", "one already in progress is left to its agent");
      g = await read(guide);
      assert.deepEqual([g.retired?.by, g.retired?.reason, g.updates.filter((u) => u.state === "open").length, g.updates.filter((u) => u.state === "dropped").length], [dora.id, "merged into the handbook", 0, 2]);
      assert.deepEqual(await listed(), [faq], "a retired document leaves the project's list");
      // The repeat is a replay; nothing is retired twice.
      const again = await docs.retire(dora, { commandId: retireId, obligationId: guide, expectedRevision: shown, reason: "merged into the handbook" });
      assert.deepEqual([again.replayed, again.revision, again.cancelled, again.running], [true, r.revision, [open[0]], [started]]);
      assert.equal((await read(guide)).revision, g.revision);
      await refuses("command_conflict", () => docs.retire(dora, { commandId: retireId, obligationId: guide, expectedRevision: shown, reason: "something else" }));
      // A retired document can be neither retired again, verified nor replaced.
      await refuses("invalid_command", () => docs.retire(owner, { commandId: cid("x"), obligationId: guide, expectedRevision: g.revision }), /was retired/);
      await refuses("invalid_command", () => docs.verify(dora, { commandId: cid("v"), obligationId: guide, expectedRevision: g.revision, documentSubmissionId: derivedId("sbm", "none"), evidence: [l5, s2] }), /was retired/);
      await refuses("invalid_command", () => docs.record(owner, { commandId: cid("r"), projectId: project, obligationId: guide, expectedRevision: g.revision, title: "User guide", location: "docs/guide.md", audience: "user", owner: dora.id, applicableVersion: "1.0", implementationRefs: [login, search] }), /was retired/);
      // No check flags it again: not an impact check, not a release.
      const l6 = code(login, treeB);
      assert.deepEqual((await docs.impact(owner, { commandId: cid("i"), taskId: login, submissionId: l6 })).flagged, [faq]);
      assert.deepEqual((await docs.release(owner, { commandId: cid("rel"), projectId: project, version: "2.0" })).flagged, [faq]);
      assert.equal((await read(guide)).revision, g.revision, "the retired record is not touched by any check");
      // A check that read the project's list before the retirement and the record after it skips the retired record (planted: the list still names it).
      const index = (await runner.get("doc-obligation-index", project))!;
      await plant("doc-obligation-index", project, { ids: [guide, ...((index.body as unknown as { ids: string[] }).ids)] });
      assert.deepEqual((await docs.release(owner, { commandId: cid("rel"), projectId: project, version: "3.0" })).flagged, [faq]);
      // New tested code of the search task (a tree the guide was never checked against), and the code the guide was verified with losing its QA gate: neither flags the retired guide.
      assert.deepEqual((await docs.impact(owner, { commandId: cid("i"), taskId: search, submissionId: code(search, "c".repeat(40)) })).flagged, []);
      gates.set(s1, { ...gates.get(s1)!, verdict: "failed" });
      assert.deepEqual((await docs.afterQaInvalidation({ taskId: search, evidence: [{ evidenceId: derivedId("qae", cid("qa")), submissionId: s1 }] })).flagged, []);
      gates.set(s1, { ...gates.get(s1)!, verdict: "passed" });
      assert.equal((await read(guide)).revision, g.revision);
      await plant("doc-obligation-index", project, { ids: (index.body as unknown as { ids: string[] }).ids });

      // A document retired after a check wrote its flags but before its update task was created: the task is never created.
      const onboard = (await docs.record(owner, { commandId: cid("r"), projectId: project, title: "Onboarding", location: "docs/onboard.md", audience: "user", owner: dora.id, applicableVersion: "3.0", implementationRefs: [search] })).id;
      const notes = (await docs.record(owner, { commandId: cid("r"), projectId: project, title: "Release notes", location: "docs/notes.md", audience: "developer", owner: dora.id, applicableVersion: "3.0", implementationRefs: [search] })).id;
      onCreate = async () => { await docs.retire(owner, { commandId: cid("x"), obligationId: notes, expectedRevision: (await read(notes)).revision }); };
      created.length = 0;
      const raced = await docs.impact(owner, { commandId: cid("i"), taskId: search, submissionId: code(search, treeB) });
      assert.deepEqual([...raced.flagged].sort(), [onboard, notes].sort());
      assert.equal(created.length, 1, `only the kept document's update task is created: ${JSON.stringify(created)}`);
      assert.match(created[0]!, /Onboarding/);
      const dropped = (await read(notes)).updates;
      assert.deepEqual([dropped.length, dropped[0]?.state], [1, "dropped"]);
      assert.equal(await projects.getTask(dropped[0]!.taskId), undefined);
      assert.deepEqual(raced.tasks.find((t) => t.obligationId === notes)?.assigned, false);

      // Retired after the check read the record and before the update task was written (the retirement found no task to cancel): the task just created is cancelled at once, never assigned.
      const late = (await docs.record(owner, { commandId: cid("r"), projectId: project, title: "Changelog", location: "docs/changes.md", audience: "developer", owner: dora.id, applicableVersion: "3.0", implementationRefs: [search] })).id;
      onCreate = async () => { await docs.retire(owner, { commandId: cid("x"), obligationId: late, expectedRevision: (await read(late)).revision }); };
      created.length = 0;
      const raced2 = await docs.impact(owner, { commandId: cid("i"), taskId: search, submissionId: code(search, treeA) });
      assert.equal(created.length, 1, JSON.stringify(created));
      assert.match(created[0]!, /Changelog/);
      const lateUpdate = (await read(late)).updates[0]!;
      assert.equal(lateUpdate.state, "dropped");
      assert.equal(await taskState(lateUpdate.taskId), "cancelled", "the task written after the retirement is cancelled");
      assert.equal(await assignments.getAssignment(lateUpdate.taskId), undefined, "and never assigned");
      assert.equal(raced2.tasks.find((t) => t.obligationId === late)?.assigned, false);

      // A repeat of a retirement whose cancellation failed (the task moved between the read and the cancel) finishes it.
      const old = (await docs.record(owner, { commandId: cid("r"), projectId: project, title: "Old FAQ", location: "docs/old.md", audience: "support", owner: dora.id, applicableVersion: "3.0", implementationRefs: [login] })).id;
      await docs.impact(owner, { commandId: cid("i"), taskId: login, submissionId: code(login, treeA) });
      const oldTask = (await read(old)).updates.find((u) => u.state === "open")!.taskId;
      const moving = DocObligationService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [], gate: async (_by, s) => gates.get(s)!, assignments,
        projects: { createTask: wrapped.createTask, transitionTask: async (c: Parameters<ProjectService["transitionTask"]>[0]) => { await projects.transitionTask({ commandId: cid("block"), actor: owner.id, taskId: c.taskId, expectedRevision: (await projects.getTask(c.taskId))!.revision, to: "blocked" }); return projects.transitionTask(c); } } as never,
      }, options);
      const oldRetire = cid("x");
      const first = await moving.retire(owner, { commandId: oldRetire, obligationId: old, expectedRevision: (await read(old)).revision });
      assert.deepEqual([first.cancelled, first.running], [[], []], "the cancel lost the race: not reported as cancelled");
      assert.equal(await taskState(oldTask), "blocked");
      const second = await docs.retire(owner, { commandId: oldRetire, obligationId: old, expectedRevision: (await read(old)).revision - 1 });
      assert.deepEqual([second.replayed, second.cancelled, second.running], [true, [oldTask], []]);
      assert.equal(await taskState(oldTask), "cancelled");

      // A verification made before the retirement and sent again with its command ID (its answer was lost) is answered with its result, not refused because the document was retired since (second review).
      const tips = (await docs.record(owner, { commandId: cid("r"), projectId: project, title: "Tips", location: "docs/tips.md", audience: "user", owner: dora.id, applicableVersion: "3.0", implementationRefs: [login] })).id;
      const tipsVerify = { commandId: cid("v"), obligationId: tips, expectedRevision: (await read(tips)).revision, documentSubmissionId: await documentChange(), evidence: [code(login, treeA)] };
      const verified = await docs.verify(dora, tipsVerify);
      await docs.retire(owner, { commandId: cid("x"), obligationId: tips, expectedRevision: verified.revision });
      const verifiedAgain = await docs.verify(dora, tipsVerify);
      assert.deepEqual([verifiedAgain.replayed, verifiedAgain.id, verifiedAgain.revision], [true, tips, verified.revision]);
      // The same command ID with other arguments is still a conflict (the repeat check comes before the retired check), not answered and not refused as retired.
      await refuses("command_conflict", () => docs.verify(dora, { ...tipsVerify, expectedRevision: verified.revision }));
      await refuses("invalid_command", () => docs.verify(dora, { ...tipsVerify, commandId: cid("v"), expectedRevision: verified.revision + 1 }), /was retired/);
    } finally {
      await world.close();
    }
  });
}

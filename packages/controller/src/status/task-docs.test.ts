import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { ContractService } from "../planning/contracts.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { DocObligationService } from "../submissions/index.js";
import { StatusService, type Line } from "./index.js";

after(stopServer);

/** Card Q03 slice 7: the `task_docs` status view answers "what documentation is due for this task" from the project's documentation obligations. */
const options = { clock: () => "2026-11-22T10:00:00.000Z", pause: async () => undefined };
const said = (lines: readonly Line[]): string => lines.map((l) => l.text).join("\n");
const treeA = "a".repeat(40);
const treeB = "b".repeat(40);
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  test(`${backend.name}: the task_docs view lists only the documents that describe the task and counts every flagged one as due for it, as the landing docs gate does (card Q03)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const elsewhere = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Q" })).id;
      const task = async (title: string): Promise<string> => (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
      const login = await task("Login");
      const search = await task("Search");
      const export_ = await task("Export");
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[], inProject: string): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project: inProject }] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const runner = new CommandRunner(world.storage, epoch, options);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id }, build: async () => ({ ref: { kind, id }, creates: true, changes: [{ type: "create" as const, ref: { kind, id }, body: body as never }], result: {}, audit: [] }) }) as never);
      };
      const gates = new Map<string, { verdict: "passed" | "failed"; tree: string; taskId: string }>();
      const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
      const docs = DocObligationService.withEpoch(world.storage, epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        gate: async (_by, s) => gates.get(s) ?? ((): never => { throw new DomainError("not_found", "no such submission"); })(),
        projects, assignments,
      }, options);
      const dora = await agent("dora", ["docs"], project);
      const stranger = await agent("stranger", ["docs"], elsewhere);
      const code = (taskId: string, tree: string): string => { const id = derivedId("sbm", cid("code")); gates.set(id, { verdict: "passed", tree, taskId }); return id; };
      const documentChange = async (): Promise<string> => {
        const id = derivedId("sbm", cid("doc"));
        await plant("submission", id, { taskId: login, projectId: project, kind: "document", role: "docs", submittedBy: dora.id, submittedAt: "2026-11-22T10:00:00.000Z", makesCommit: false, artifactDigest: `sha256:${"e".repeat(64)}`, evidence: [] });
        return id;
      };
      const record = async (title: string, refs: string[]): Promise<string> => (await docs.record(owner, { commandId: cid("r"), projectId: project, title, location: `docs/${title}.md`, audience: "user", owner: dora.id, applicableVersion: "1.0", implementationRefs: refs })).id;
      const verify = async (id: string, evidence: string[]): Promise<void> => {
        const stored = (await docs.get(owner, id)) as unknown as { revision: number };
        await docs.verify(dora, { commandId: cid("v"), obligationId: id, expectedRevision: stored.revision, documentSubmissionId: await documentChange(), evidence });
      };
      const base = { assignments, waits: WaitService.withEpoch(world.storage, epoch, assignments, options), blockers: BlockerService.withEpoch(world.storage, epoch, options), contracts: ContractService.withEpoch(world.storage, epoch, options) };
      const status = StatusService.withEpoch(world.storage, epoch, { ...base, docs }, options);
      const status0 = StatusService.withEpoch(world.storage, epoch, base, options);
      const ask = async (by: Principal, taskId: string) => status.ask(by, { kind: "task_docs", taskId });
      const text = async (taskId: string): Promise<string> => said((await ask(owner, taskId))!.lines);
      // The view's count of documents due must be what the landing docs gate holds pending for the task's code (review: a view that says nothing is due while the gate refuses landing misleads).
      const agrees = async (taskId: string, submissionId: string): Promise<void> => {
        const pending = (await docs.landing(owner, { taskId, submissionId })).pending.length;
        const first = (await ask(owner, taskId))!.lines[0]!.text;
        const due = /No documentation is due for this task/.test(first) ? 0 : Number(/Documentation is due for this task: (\d+) document/.exec(first)?.[1] ?? "-1");
        assert.equal(due, pending, `view and gate disagree for ${taskId}: ${first}`);
      };

      // No document at all, and a task nothing describes: said plainly, not an empty answer.
      assert.match(await text(login), /No documentation obligations are recorded for this project/);
      const guide = await record("Guide", [login, search]);
      const faq = await record("FAQ", [login]);
      const pricing = await record("Pricing", [search]);
      assert.match(await text(export_), /No document is tied to Export: none of this project's 3 tracked document/);
      assert.doesNotMatch(await text(export_), /Guide|FAQ|Pricing/);

      // Never checked: both documents of the login task are due, the pricing page (search only) is not mentioned.
      const unchecked = await text(login);
      assert.match(unchecked, /^2 document\(s\) describe Login: 2 flagged \(0 stale, 2 unverified\), 0 verified against tested code\. Documentation is due for this task: 2 document\(s\); the docs gate holds its landing/);
      assert.match(unchecked, /Guide/); assert.match(unchecked, /FAQ/);
      assert.doesNotMatch(unchecked, /Pricing/, "a document that does not describe the task is left out");
      for (const l of (await ask(owner, login))!.lines) assert.ok(l.cites.length > 0, `uncited: ${l.text}`);
      assert.ok((await ask(owner, login))!.lines[0]!.cites.some((c) => c.kind === "task" && c.id === login), "the summary cites the task");

      // Verified against tested code: nothing is due.
      const l1 = code(login, treeA);
      const s1 = code(search, treeA);
      await verify(guide, [l1, s1]);
      await verify(faq, [l1]);
      await verify(pricing, [s1]);
      assert.match(await text(login), /^2 document\(s\) describe Login: 0 flagged \(0 stale, 0 unverified\), 2 verified against tested code\. No documentation is due for this task \(the docs gate still checks/);
      assert.match(await text(search), /^2 document\(s\) describe Search: 0 flagged/);
      await agrees(login, l1); await agrees(search, s1);

      // New tested code of the login task: the guide and the FAQ go stale and are due for login. The guide is flagged for login only, yet the docs gate holds the
      // search task's landing too (a verification names code of every task the document describes), so it is due for search as well, with a note that the flag names its other task.
      const l2 = code(login, treeB);
      await docs.impact(owner, { commandId: cid("i"), taskId: login, submissionId: l2 });
      const loginNow = await text(login);
      assert.match(loginNow, /^2 document\(s\) describe Login: 2 flagged \(2 stale, 0 unverified\), 0 verified against tested code\. Documentation is due for this task: 2 document\(s\); the docs gate holds its landing/);
      assert.match(loginNow, /Update tasks open: /);
      assert.doesNotMatch(loginNow, /Flagged for other tasks/);
      const searchNow = await text(search);
      assert.match(searchNow, /^2 document\(s\) describe Search: 1 flagged \(1 stale, 0 unverified\), 1 verified against tested code\. Documentation is due for this task: 1 document\(s\); the docs gate holds its landing until each is verified again\./);
      assert.match(searchNow, /Guide.*Flagged for other tasks it describes, not for this one; it still holds this task's landing until it is verified again/);
      assert.doesNotMatch(searchNow, /Pricing.*Flagged for other tasks/, "a verified document carries no flag note");
      await agrees(login, l2); await agrees(search, s1);
      assert.doesNotMatch(searchNow, /FAQ/, "the FAQ does not describe the search task");

      // A release flags every document, so it is due for every task the document describes.
      await verify(guide, [l2, s1]);
      await verify(faq, [l2]);
      await docs.release(owner, { commandId: cid("rel"), projectId: project, version: "2.0" });
      assert.match(await text(search), /^2 document\(s\) describe Search: 2 flagged .*Documentation is due for this task: 2 document\(s\); the docs gate holds its landing/);
      assert.doesNotMatch(await text(search), /Flagged for other tasks/, "a release flag names every task of the document");
      await agrees(search, s1);

      // Who may ask: a task the viewer may not read is not found (nothing about its documents is said); a controller with no documentation service says so.
      assert.equal(await ask(stranger, login), undefined);
      assert.equal(await status.ask(owner, { kind: "task_docs", taskId: "task-aaaaaaaaaaaaaaaaaaaa" }), undefined);
      assert.match(said((await status0.ask(owner, { kind: "task_docs", taskId: login }))!.lines), /not kept on this controller/);
      // A task credential reads only its own task: the documents of another task of the same project are not shown through it, though the project's documents are readable.
      const scoped = (taskId: string): Principal => ({ ...dora, taskScope: { taskId, projectId: project } } as Principal);
      assert.equal(await ask(scoped(search), login), undefined, "a credential of another task may not ask about this one");
      assert.ok((await ask(scoped(login), login)) !== undefined, "a credential of the task itself may");
      assert.ok((await ask(dora, login)) !== undefined, "an agent that may read the project's tasks may ask");
      // An agent of the project with no right to read its tasks, and a client that may read the task but not the documents (they are kept for the owner and agents): not found, nothing said.
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "nogrant", grants: [] });
      const nogrant = await principals.authenticate((await principals.issueCredential(owner, "agent:nogrant")).token);
      assert.equal(await ask(nogrant, login), undefined);
      assert.equal(await ask({ ...dora, id: "client:c", kind: "client" } as Principal, login), undefined);
      await assert.rejects(async () => status.ask(owner, { kind: "task_docs", taskId: login, projectId: project } as never), /projectId: is not a field/);

      // At most 30 documents are shown, but the counts cover all of them and the view says how many are left out.
      for (let i = 0; i < 31; i++) await record(`Export page ${i}`, [export_]);
      const many = (await ask(owner, export_))!.lines;
      assert.match(many[0]!.text, /^31 document\(s\) describe Export: 31 flagged \(0 stale, 31 unverified\), 0 verified against tested code\. Documentation is due for this task: 31 document\(s\)/);
      assert.equal(many.filter((l) => /^User document /.test(l.text)).length, 30);
      assert.match(many[many.length - 1]!.text, /^1 more document\(s\) are not shown here/);
    } finally { await world.close(); }
  });
}

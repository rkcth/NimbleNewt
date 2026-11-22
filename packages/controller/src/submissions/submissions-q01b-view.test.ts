// Card Q01b (fourth slice): the owner (and chat) can see what was submitted on a task and where each piece stands (the `submissions` status view). Real submission and status services on every backend.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { ProjectService } from "../domain/service.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ContractService } from "../planning/contracts.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { StatusService } from "../status/index.js";
import { SubmissionService } from "./index.js";

after(stopServer);

let now = Date.parse("2026-11-22T10:00:00.000Z");
const tick = (): void => { now += 60_000; };
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T = (c: string): string => c.repeat(40);
const BASE = T("c"), PATCH = T("d");

for (const backend of backends) {
  const suite = (name: string, body: (c: {
    ask(by: Principal, taskId: string): Promise<string[] | undefined>; owner: Principal; task: string; project: string; svc: SubmissionService;
    agent(name: string, roles: string[], project?: string): Promise<Principal>; mkTask(title: string): Promise<string>; bare(): StatusService;
    assign(reviewer: Principal, submissionId: string): void; scanned(pageSize: number, reads: number): StatusService; elsewhere: string;
    lone(reviewersAvailable: () => Promise<string[]>): StatusService & { svc: SubmissionService };
  }) => Promise<void>) => test(`${backend.name}: ${name}`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const elsewhere = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Q" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[], proj = project): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project: proj }] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const mkTask = async (title: string): Promise<string> => (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
      const task = await mkTask("Fix the parser");
      const asked = new Map<string, string[]>();
      const svcOptions = { ...options, reviewAssignments: async (principalId: string) => asked.get(principalId) ?? [] };
      const svc = SubmissionService.withEpoch(world.storage, epoch, async (id) => roles.get(id) ?? [], svcOptions);
      const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
      const base = { assignments, waits: WaitService.withEpoch(world.storage, epoch, assignments, options), blockers: BlockerService.withEpoch(world.storage, epoch, options), contracts: ContractService.withEpoch(world.storage, epoch, options) };
      const status = StatusService.withEpoch(world.storage, epoch, { ...base, submissions: { list: (by, t, q) => svc.list(by, t, q), approvalOf: (id) => svc.approvalOf(id) } }, options);
      const ask = async (by: Principal, taskId: string): Promise<string[] | undefined> => (await status.ask(by, { kind: "submissions", taskId }))?.lines.map((l) => l.text);
      const scanned = (pageSize: number, reads: number): StatusService => {
        const small = SubmissionService.withEpoch(world.storage, epoch, async (id) => roles.get(id) ?? [], { ...svcOptions, listScan: { pageSize, reads } });
        return StatusService.withEpoch(world.storage, epoch, { ...base, submissions: { list: (by, t, q) => small.list(by, t, q), approvalOf: (id) => small.approvalOf(id) } }, options);
      };
      const assign = (reviewer: Principal, submissionId: string): void => { asked.set(reviewer.id, [...(asked.get(reviewer.id) ?? []), submissionId]); };
      // A service that knows who could review (card H12o): with no other agent, a code submission records that no review is required.
      const lone = (reviewersAvailable: () => Promise<string[]>): StatusService & { svc: SubmissionService } => {
        const s = SubmissionService.withEpoch(world.storage, epoch, async (id) => roles.get(id) ?? [], { ...svcOptions, reviewersAvailableIn: async () => reviewersAvailable() });
        return Object.assign(StatusService.withEpoch(world.storage, epoch, { ...base, submissions: { list: (by, t, q) => s.list(by, t, q), approvalOf: (id) => s.approvalOf(id) } }, options), { svc: s });
      };
      await body({ ask, owner, task, project, svc, agent, mkTask, bare: () => StatusService.withEpoch(world.storage, epoch, base, options), assign, scanned, elsewhere, lone });
    } finally { await world.close(); }
  });

  suite("nothing submitted says so; an unknown task is not found; a controller without the service says it is not kept", async (c) => {
    assert.deepEqual(await c.ask(c.owner, c.task), ["Nothing you may read has been submitted on Fix the parser yet: no code, review, QA report, document change or director sign-off."]);
    assert.equal(await c.ask(c.owner, "task-zzzzzzzzzzzzzzzzzzzz"), undefined);
    assert.deepEqual((await c.bare().ask(c.owner, { kind: "submissions", taskId: c.task }))?.lines.map((l) => l.text), ["Submissions are not kept on this controller."]);
  });

  suite("a code submission waits for a reviewer; its review and the director's sign-off are told apart, a later decline takes an approval back", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const dee = await c.agent("dee", ["director"]);
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T("a"), patchId: PATCH, evidence: [{ check: "unit", result: "pass", boundTo: T("a") }, { check: "ui", result: "not_run", boundTo: T("a") }] });
    let text = (await c.ask(c.owner, c.task))!;
    assert.match(text[0]!, /^1 submission\(s\) of Fix the parser on record, newest first: 1 code, 0 review, 0 QA, 0 document, 0 sign-off\.$/);
    assert.match(text[1]!, new RegExp(`^Newest code submission ${code.id} by ${ann.id} at \\S+: tree ${"a".repeat(12)}, base ${"c".repeat(12)}, refresh round 0\\. Review: none yet; it waits for a reviewer\\. Director sign-off: none\\. Its author's own check evidence: 1 pass, 0 fail, 1 not run\\.$`));
    tick();
    await c.svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "changes" });
    text = (await c.ask(c.owner, c.task))!;
    assert.match(text[1]!, /Review: the newest review says changes; it waits for a new submission from its author\./);
    tick();
    await c.svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve" });
    tick();
    await c.svc.record(dee, { commandId: cid("so"), taskId: c.task, kind: "signoff", role: "director", subject: code.id, decision: "decline" });
    text = (await c.ask(c.owner, c.task))!;
    assert.match(text[1]!, new RegExp(`Review: approved by ${rev.id}\\. Director sign-off: declined by ${dee.id} \\(a project that requires the director check does not land it\\)\\.`));
    tick();
    await c.svc.record(dee, { commandId: cid("so"), taskId: c.task, kind: "signoff", role: "director", subject: code.id, decision: "approve" });
    text = (await c.ask(c.owner, c.task))!;
    assert.match(text[1]!, new RegExp(`Director sign-off: approved by ${dee.id}\\.`));
    // The other submissions are listed newest first, each with its subject.
    assert.match(text[0]!, /5 submission\(s\) .*1 code, 2 review, 0 QA, 0 document, 2 sign-off/);
    assert.match(text[2]!, new RegExp(`^Director sign-off on ${code.id}: approve\\. sbm-\\S+ by ${dee.id} at `));
    assert.match(text[3]!, new RegExp(`^Director sign-off on ${code.id}: decline\\.`));
    assert.match(text[4]!, new RegExp(`^Review on ${code.id}: approve\\.`));
    assert.match(text[5]!, new RegExp(`^Review on ${code.id}: changes\\.`));
    assert.equal(text.length, 6);
  });

  suite("a newer code submission makes the older one 'older'; QA reports and document changes are listed with their text quoted; counts stay by kind", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const qa = await c.agent("qa", ["qa"]);
    const docs = await c.agent("doc", ["docs"]);
    const first = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T("a"), patchId: PATCH });
    tick();
    const second = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T("b"), patchId: PATCH, refreshRound: 0 });
    tick();
    await c.svc.record(qa, { commandId: cid("q"), taskId: c.task, kind: "qa", role: "qa", subject: second.id, report: "ran the parser‮ suite: green" });
    tick();
    await c.svc.record(docs, { commandId: cid("d"), taskId: c.task, kind: "document", role: "docs", artifactDigest: `sha256:${"e".repeat(64)}`, report: "guide updated" });
    const text = (await c.ask(c.owner, c.task))!;
    assert.match(text[0]!, /4 submission\(s\) .*2 code, 0 review, 1 QA, 1 document, 0 sign-off/);
    assert.match(text[1]!, new RegExp(`^Newest code submission ${second.id} `));
    assert.doesNotMatch(text[1]!, /A newer code submission exists/);
    assert.match(text[2]!, new RegExp(`^Older code submission ${first.id} .*A newer code submission exists\\.$`));
    assert.match(text[3]!, /^Document change: "guide updated"\./);
    assert.match(text[4]!, new RegExp(`^QA report on ${second.id}: "ran the parser.*suite: green"\\.`));
    assert.doesNotMatch(text.join("\n"), /‮/, "a bidi control in a report is not shown raw");
  });

  suite("only what the caller may read is shown: the author sees its own code, a stranger with task read sees nothing, an agent of another project gets not found", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const stranger = await c.agent("stranger", []);
    // An agent with task read in another project only (an earlier version enrolled it on a project that does not exist, so the check never ran).
    const alien = await c.agent("alien", ["author"], c.elsewhere);
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T("a"), patchId: PATCH });
    assert.match((await c.ask(ann, c.task))![0]!, /^1 submission\(s\)/);
    assert.match((await c.ask(stranger, c.task))![0]!, /^Nothing you may read has been submitted on Fix the parser yet/);
    assert.equal(await c.ask(alien, c.task), undefined);
    // A task credential reads its own task only: the author scoped to another task of the project gets not found, scoped to this one it sees its code.
    const other = await c.mkTask("Another task");
    assert.equal(await c.ask({ ...ann, taskScope: { taskId: other, projectId: c.project } }, c.task), undefined);
    assert.match((await c.ask({ ...ann, taskScope: { taskId: c.task, projectId: c.project } }, c.task))![1]!, new RegExp(`^Newest code submission ${code.id} .*Review: none yet`));
  });

  suite("a reject is shown as the newest review (the landing gate fails it), and a code submission no other agent could review says review is not required", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T("a"), patchId: PATCH });
    tick();
    await c.svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve" });
    tick();
    await c.svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "reject" });
    let text = (await c.ask(c.owner, c.task))!;
    assert.match(text[1]!, /Review: the newest review says reject; it waits for a new submission from its author\. Director sign-off: none\.$/, "a later reject takes the approval back and no approval note is given");
    const solo = c.lone(async () => [ann.id]);
    const other = await c.mkTask("Fix the parser");
    tick();
    const alone = await solo.svc.record(ann, { commandId: cid("s"), taskId: other, kind: "code", role: "author", base: BASE, tree: T("b"), patchId: PATCH });
    text = (await solo.ask(c.owner, { kind: "submissions", taskId: other }))!.lines.map((l) => l.text);
    assert.match(text[1]!, new RegExp(`^Newest code submission ${alone.id} .*Review: not required \\(no other agent of the project could review it\\)\\. Director sign-off: none\\. An approval counts at landing only while the change's patch stays the one approved\\.$`));
  });

  suite("a scan that stops early before finding anything does not say that nothing was submitted", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const busy = await c.mkTask("Busy task");
    for (let i = 0; i < 6; i++) { tick(); await c.svc.record(ann, { commandId: cid("s"), taskId: busy, kind: "code", role: "author", base: BASE, tree: String(i).repeat(40), patchId: PATCH }); }
    // Pages of 1 row, one read a call: 5 calls look at 5 of the 6 rows, none of them this task's.
    const text = (await c.scanned(1, 1).ask(c.owner, { kind: "submissions", taskId: c.task }))!.lines.map((l) => l.text);
    assert.deepEqual(text, ["No submission you may read on Fix the parser was found among the stored submissions looked at, but not every stored submission was looked at, so some may exist; submission.list can page through the rest."]);
    // With the whole table read it is a plain "nothing submitted".
    assert.match((await c.scanned(2, 5).ask(c.owner, { kind: "submissions", taskId: c.task }))!.lines[0]!.text, /^Nothing you may read has been submitted on Fix the parser yet/);
  });

  suite("more than five code submissions and ten others are cut with a line saying so; a view is bounded, not silent", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    let last = "";
    for (let i = 0; i < 7; i++) { tick(); last = (await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: String(i).repeat(40), patchId: PATCH })).id; }
    for (let i = 0; i < 12; i++) { tick(); await c.svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: last, verdict: "changes" }); }
    const text = (await c.ask(c.owner, c.task))!;
    assert.match(text[0]!, /19 submission\(s\) .*7 code, 12 review/);
    assert.equal(text.filter((l) => /^(Newest|Older) code submission/.test(l)).length, 5);
    assert.ok(text.includes("2 older code submission(s) are not shown here (submission.list has them all)."));
    assert.ok(text.includes("2 older review, QA, document or sign-off submission(s) are not shown here (submission.list has them all)."));
    assert.equal(text.filter((l) => /^Review on/.test(l)).length, 10);
  });

  suite("the newest code submission is found when the task's submissions span several list pages; past the page bound the view says newer ones may exist", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) { tick(); ids.push((await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: String(i).repeat(40), patchId: PATCH })).id); }
    const newest = ids[ids.length - 1]!;
    // Pages of 2 rows, one read a call: 7 rows need 4 calls, within the bound of 5; the IDs are random, so a first page alone is not the newest.
    const whole = (await c.scanned(2, 1).ask(c.owner, { kind: "submissions", taskId: c.task }))!.lines.map((l) => l.text);
    assert.match(whole[0]!, /^7 submission\(s\) of Fix the parser on record, newest first: 7 code/);
    assert.doesNotMatch(whole[0]!, /Not every stored submission/);
    assert.match(whole[1]!, new RegExp(`^Newest code submission ${newest} `));
    // Pages of 1 row: 5 calls read 5 of the 7, and the view says it is partial and that newer ones may exist.
    const part = (await c.scanned(1, 1).ask(c.owner, { kind: "submissions", taskId: c.task }))!.lines.map((l) => l.text);
    assert.match(part[0]!, /^5 submission\(s\) .* Not every stored submission was looked at, so newer or older ones may exist; "newest" here means the newest of those read\.$/);
  });

  suite("a reviewer asked to review a code submission sees it but not other reviewers' verdicts or the director's decision; its author and the owner do, with the patch binding said", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const rev2 = await c.agent("rev2", ["reviewer"]);
    const dee = await c.agent("dee", ["director"]);
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T("a"), patchId: PATCH, evidence: [{ check: "unit", result: "fail", boundTo: T("a") }] });
    c.assign(rev, code.id); c.assign(rev2, code.id);
    tick();
    await c.svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve" });
    tick();
    await c.svc.record(dee, { commandId: cid("so"), taskId: c.task, kind: "signoff", role: "director", subject: code.id, decision: "decline" });
    const seen = (await c.ask(rev2, c.task))!;
    assert.match(seen[0]!, /^1 submission\(s\) of Fix the parser you may read, newest first: 1 code, 0 review/);
    assert.match(seen[1]!, new RegExp(`^Newest code submission ${code.id} by ${ann.id} .*Its review and director sign-off state are shown to the owner and its author only\.$`));
    assert.doesNotMatch(seen.join("\n"), new RegExp(`${rev.id}|${dee.id}|approve|decline`));
    const mine = (await c.ask(ann, c.task))!;
    assert.match(mine[0]!, /^1 submission\(s\) of Fix the parser you may read/);
    assert.match(mine[1]!, new RegExp(`Review: approved by ${rev.id}\. Director sign-off: declined by ${dee.id} \\(a project that requires the director check does not land it\\)\. An approval counts at landing only while the change's patch stays the one approved\. Its author's own check evidence: 0 pass, 1 fail, 0 not run\.$`));
    const owner = (await c.ask(c.owner, c.task))!;
    assert.match(owner[0]!, /^3 submission\(s\) of Fix the parser on record/);
    assert.match(owner[1]!, /Review: approved by .* An approval counts at landing only while the change's patch stays the one approved\./);
    // The reviewer that gave the review reads its own review, not the decision of the director.
    const giver = (await c.ask(rev, c.task))!.join("\n");
    assert.match(giver, new RegExp(`Review on ${code.id}: approve\.`));
    assert.doesNotMatch(giver, new RegExp(`${dee.id}|decline`));
  });
}

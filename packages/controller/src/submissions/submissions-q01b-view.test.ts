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
      void elsewhere;
      const mkTask = async (title: string): Promise<string> => (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
      const task = await mkTask("Fix the parser");
      const svc = SubmissionService.withEpoch(world.storage, epoch, async (id) => roles.get(id) ?? [], options);
      const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
      const base = { assignments, waits: WaitService.withEpoch(world.storage, epoch, assignments, options), blockers: BlockerService.withEpoch(world.storage, epoch, options), contracts: ContractService.withEpoch(world.storage, epoch, options) };
      const status = StatusService.withEpoch(world.storage, epoch, { ...base, submissions: { list: (by, t, q) => svc.list(by, t, q), approvalOf: (id) => svc.approvalOf(id) } }, options);
      const ask = async (by: Principal, taskId: string): Promise<string[] | undefined> => (await status.ask(by, { kind: "submissions", taskId }))?.lines.map((l) => l.text);
      await body({ ask, owner, task, project, svc, agent, mkTask, bare: () => StatusService.withEpoch(world.storage, epoch, base, options) });
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
    const alien = await c.agent("alien", ["author"], "prj-zzzzzzzzzzzzzzzzzzzz").catch(() => undefined);
    await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T("a"), patchId: PATCH });
    assert.match((await c.ask(ann, c.task))![0]!, /^1 submission\(s\)/);
    assert.match((await c.ask(stranger, c.task))![0]!, /^Nothing you may read has been submitted on Fix the parser yet/);
    if (alien !== undefined) assert.equal(await c.ask(alien, c.task), undefined);
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
}

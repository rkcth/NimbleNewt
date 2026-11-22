// Card Q01b (fifth slice): the owner (and chat) can see what code is waiting across a whole project and where review and the director's sign-off stand (the `submissions_project` status view).
// Real submission and status services on every backend; the clock is a variable that is advanced, so there are no pauses.
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
    ask(by: Principal, projectId?: string): Promise<string[] | undefined>; owner: Principal; project: string; elsewhere: string; svc: SubmissionService;
    agent(name: string, roles: string[], project?: string): Promise<Principal>; mkTask(title: string): Promise<string>; finish(taskId: string, to: "done" | "cancelled"): Promise<void>;
    lone(reviewersAvailable: () => Promise<string[]>): { svc: SubmissionService; status: StatusService }; bare(): StatusService; withoutWaiting(): StatusService; scanned(pageSize: number, reads: number): StatusService; capped(tasks: number): StatusService; count(): Promise<number>;
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
      const finish = async (taskId: string, to: "done" | "cancelled"): Promise<void> => {
        const path = to === "done" ? ["ready", "in_progress", "done"] as const : ["ready", "cancelled"] as const;
        for (const step of path) await projects.transitionTask({ commandId: cid("tr"), actor: owner.id, taskId, expectedRevision: (await projects.getTask(taskId))!.revision, to: step });
      };
      const svcOptions = { ...options, reviewAssignments: async () => [] as string[] };
      const svc = SubmissionService.withEpoch(world.storage, epoch, async (id) => roles.get(id) ?? [], svcOptions);
      const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
      const base = { assignments, waits: WaitService.withEpoch(world.storage, epoch, assignments, options), blockers: BlockerService.withEpoch(world.storage, epoch, options), contracts: ContractService.withEpoch(world.storage, epoch, options) };
      const withService = (s: SubmissionService): StatusService => StatusService.withEpoch(world.storage, epoch, { ...base, submissions: { list: (by, t, q) => s.list(by, t, q), approvalOf: (id) => s.approvalOf(id), waiting: (by, p) => s.waiting(by, p) } }, options);
      const status = withService(svc);
      const ask = async (by: Principal, projectId = project): Promise<string[] | undefined> => (await status.ask(by, { kind: "submissions_project", projectId }))?.lines.map((l) => l.text);
      const scanned = (pageSize: number, reads: number): StatusService => withService(SubmissionService.withEpoch(world.storage, epoch, async (id) => roles.get(id) ?? [], { ...svcOptions, listScan: { pageSize, reads } }));
      const capped = (tasks: number): StatusService => withService(SubmissionService.withEpoch(world.storage, epoch, async (id) => roles.get(id) ?? [], { ...svcOptions, waitingTasks: tasks }));
      const withoutWaiting = (): StatusService => StatusService.withEpoch(world.storage, epoch, { ...base, submissions: { list: (by, t, q) => svc.list(by, t, q), approvalOf: (id) => svc.approvalOf(id) } }, options);
      const lone = (reviewersAvailable: () => Promise<string[]>): { svc: SubmissionService; status: StatusService } => { const l = SubmissionService.withEpoch(world.storage, epoch, async (id) => roles.get(id) ?? [], { ...svcOptions, reviewersAvailableIn: async () => reviewersAvailable() }); return { svc: l, status: withService(l) }; };
      // Everything stored of the kinds a view could wrongly create: all submissions of every task of the project.
      const count = async (): Promise<number> => {
        let total = 0;
        for (const t of (await projects.listTasks({ projectId: project, limit: 100 })).items) { const l = await svc.list(owner, t.id, { limit: 100 }); total += l.items.length; }
        return total;
      };
      await body({ lone, ask, owner, project, elsewhere, svc, agent, mkTask, finish, bare: () => StatusService.withEpoch(world.storage, epoch, base, options), withoutWaiting, scanned, capped, count });
    } finally { await world.close(); }
  });

  const code = (c: { svc: SubmissionService }, by: Principal, taskId: string, tree: string) => c.svc.record(by, { commandId: cid("s"), taskId, kind: "code", role: "author", base: BASE, tree: T(tree), patchId: PATCH });

  suite("nothing submitted says so; an unknown project is not found; a controller without the service, or without the project view, says it is not kept", async (c) => {
    assert.match((await c.ask(c.owner))![0]!, /^No unfinished task of this project has code you may read that is waiting: nothing is waiting for a reviewer or a director\.$/);
    assert.equal(await c.ask(c.owner, "proj-zzzzzzzzzzzzzzzzzzzz"), undefined);
    assert.deepEqual((await c.bare().ask(c.owner, { kind: "submissions_project", projectId: c.project }))?.lines.map((l) => l.text), ["Submissions are not kept on this controller."]);
    assert.deepEqual((await c.withoutWaiting().ask(c.owner, { kind: "submissions_project", projectId: c.project }))?.lines.map((l) => l.text), ["Submissions are not kept on this controller."]);
  });

  suite("each task's newest code is told apart: waiting for a reviewer, changes asked for, approved with the director declined, approved with no sign-off, approved and signed off; the one needing a reviewer is first", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const dee = await c.agent("dee", ["director"]);
    const [t1, t2, t3, t4, t5] = [await c.mkTask("Parser"), await c.mkTask("Lexer"), await c.mkTask("Printer"), await c.mkTask("Linker"), await c.mkTask("Cache")];
    const s: Record<string, { id: string }> = {};
    for (const [name, task, tree] of [["t5", t5, "5"], ["t4", t4, "4"], ["t3", t3, "3"], ["t2", t2, "2"], ["t1", t1, "1"]] as const) { s[name] = await code(c, ann, task, tree); tick(); }
    await c.svc.record(rev, { commandId: cid("r"), taskId: t2, kind: "review", role: "reviewer", subject: s["t2"]!.id, verdict: "changes" });
    for (const [task, name] of [[t3, "t3"], [t4, "t4"], [t5, "t5"]] as const) await c.svc.record(rev, { commandId: cid("r"), taskId: task, kind: "review", role: "reviewer", subject: s[name]!.id, verdict: "approve" });
    await c.svc.record(dee, { commandId: cid("so"), taskId: t3, kind: "signoff", role: "director", subject: s["t3"]!.id, decision: "decline" });
    await c.svc.record(dee, { commandId: cid("so"), taskId: t5, kind: "signoff", role: "director", subject: s["t5"]!.id, decision: "approve" });
    const before = await c.count();
    const text = (await c.ask(c.owner))!;
    assert.equal(await c.count(), before, "asking creates no record");
    assert.equal(text[0], "1 task(s) wait for a reviewer, 1 wait for their author (changes were asked for), 1 were approved but the director declined, 1 are approved with no director sign-off yet, 1 are approved and signed off; each is the task's newest code submission, and tasks that are done or cancelled are left out.");
    assert.match(text[1]!, new RegExp(`^Task "Parser" \\(${t1}\\) waits for a reviewer: submission ${s["t1"]!.id} by ${ann.id}, tree ${"1".repeat(12)}, submitted \\S+\\.$`));
    assert.match(text[2]!, new RegExp(`^Task "Lexer" \\(${t2}\\) waits for its author \\(changes were asked for\\): submission ${s["t2"]!.id}`));
    assert.match(text[3]!, new RegExp(`^Task "Printer" \\(${t3}\\) was approved but the director declined: .*, approved by ${rev.id}\\.$`));
    assert.match(text[4]!, new RegExp(`^Task "Linker" \\(${t4}\\) is approved, with no director sign-off yet: `));
    assert.match(text[5]!, new RegExp(`^Task "Cache" \\(${t5}\\) is approved and signed off: `));
    assert.equal(text.length, 6);
  });

  suite("a newer code submission replaces the older one's standing; a done or cancelled task is left out; a task of another project is not counted", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const t1 = await c.mkTask("Parser");
    const gone = await c.mkTask("Old work");
    const dead = await c.mkTask("Dropped work");
    const first = await code(c, ann, t1, "a");
    await code(c, ann, gone, "b"); await code(c, ann, dead, "c");
    tick();
    await c.svc.record(rev, { commandId: cid("r"), taskId: t1, kind: "review", role: "reviewer", subject: first.id, verdict: "approve" });
    assert.match((await c.ask(c.owner))![0]!, /^2 task\(s\) wait for a reviewer, 0 wait for their author \(changes were asked for\), 0 were approved but the director declined, 1 are approved with no director sign-off yet/);
    tick();
    const second = await code(c, ann, t1, "e");
    await c.finish(gone, "done"); await c.finish(dead, "cancelled");
    const text = (await c.ask(c.owner))!;
    assert.match(text[0]!, /^1 task\(s\) wait for a reviewer, 0 wait for their author \(changes were asked for\), 0 were approved but the director declined, 0 are approved with no director sign-off yet, 0 are approved and signed off;/);
    assert.match(text[1]!, new RegExp(`submission ${second.id} `));
    assert.equal(text.length, 2, "the finished tasks are not listed");
    // Only finished work left: nothing is waiting.
    await c.finish(t1, "done");
    assert.match((await c.ask(c.owner))![0]!, /^No unfinished task of this project has code you may read that is waiting/);
    assert.match((await c.ask(c.owner, c.elsewhere))![0]!, /^No unfinished task of this project has code you may read that is waiting/);
  });

  suite("an agent sees only the code it submitted itself, never another agent's review or sign-off state; a stranger sees none; an agent of another project and a task credential get not found", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const alien = await c.agent("alien", ["author"], c.elsewhere);
    const t1 = await c.mkTask("Parser"), t2 = await c.mkTask("Lexer");
    const mine = await code(c, ann, t1, "a");
    await code(c, bob, t2, "b");
    await c.svc.record(rev, { commandId: cid("r"), taskId: t1, kind: "review", role: "reviewer", subject: mine.id, verdict: "approve" });
    const own = (await c.ask(ann))!;
    assert.match(own[0]!, /Only the code you submitted yourself is shown/);
    assert.match(own[0]!, /^0 task\(s\) wait for a reviewer, 0 wait for their author \(changes were asked for\), 0 were approved but the director declined, 1 are approved with no director sign-off yet, 0 are approved and signed off; each is the newest code you submitted on the task,/);
    assert.doesNotMatch(own[0]!, /the task's newest code submission/, "an agent's own newest code need not be the task's newest");
    assert.equal(own.length, 2);
    assert.doesNotMatch(own.join("\n"), /Lexer/);
    // A bystander with task read, and the reviewer (who authored nothing), see no code and no state.
    for (const other of [await c.agent("nobody", []), rev]) {
      const text = (await c.ask(other))!;
      assert.equal(text.length, 1);
      assert.match(text[0]!, /^No unfinished task of this project has code you may read that is waiting/);
      assert.doesNotMatch(text[0]!, /Parser|Lexer/);
    }
    assert.equal(await c.ask(alien), undefined);
    assert.equal(await c.ask(await c.agent("nogrant", [], c.elsewhere)), undefined);
    const scoped: Principal = { ...ann, taskScope: { taskId: t1, projectId: c.project } };
    assert.equal(await c.ask(scoped), undefined, "a task credential is scoped to one task, so it gets no project view");
  });

  suite("a partial scan is said and never reads as 'nothing waits'", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["author"]);
    for (const title of ["A1", "A2", "A3"]) await code(c, ann, await c.mkTask(title), "a");
    const small = c.scanned(1, 1);
    const text = (await small.ask(c.owner, { kind: "submissions_project", projectId: c.project }))!.lines.map((l) => l.text);
    assert.match(text.join("\n"), /Only part of the stored submissions was looked at, so other tasks, or newer code of a listed task, may exist\./);
    // Nothing found in a short look is not "nothing is waiting".
    const empty = (await small.ask(bob, { kind: "submissions_project", projectId: c.project }))!.lines.map((l) => l.text);
    assert.equal(empty.length, 1);
    assert.match(empty[0]!, /^No code submission of an unfinished task you may read was found in what was looked at, but this view is incomplete, so code may still be waiting\. Only part of the stored submissions was looked at, so code of other tasks may exist\./);
    assert.doesNotMatch(empty[0]!, /listed task/, "nothing is listed, so the empty answer names no listed task");
    const whole = (await c.ask(c.owner))!;
    assert.doesNotMatch(whole.join("\n"), /Only part of the stored/);
    assert.match(whole[0]!, /^3 task\(s\) wait for a reviewer/);
    assert.match((await c.ask(bob))![0]!, /^No unfinished task of this project has code you may read that is waiting/);
  });

  suite("code no other agent could review reads as approved with no sign-off yet (review not required), as the landing gate does", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const t1 = await c.mkTask("Parser");
    const { svc, status } = c.lone(async () => []);
    await svc.record(ann, { commandId: cid("s"), taskId: t1, kind: "code", role: "author", base: BASE, tree: T("a"), patchId: PATCH });
    assert.match((await status.ask(c.owner, { kind: "submissions_project", projectId: c.project }))!.lines[1]!.text, /is approved, with no director sign-off yet: submission \S+ by \S+, tree a{12}, submitted \S+, review not required \(no other agent of the project could review it\)\.$/);
  });

  suite("only the tasks with the newest code are read up to the limit, and that is said; a finished task read within the limit is not listed but still uses it", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const ids: string[] = [];
    for (const title of ["Oldest", "Middle", "Newest"]) { const t = await c.mkTask(title); ids.push(t); await code(c, ann, t, "a"); tick(); }
    const capped = c.capped(2);
    const text = (await capped.ask(c.owner, { kind: "submissions_project", projectId: c.project }))!.lines.map((l) => l.text);
    assert.match(text[0]!, /^2 task\(s\) wait for a reviewer,.* Only the tasks with the newest code were read; more tasks with code may exist\.$/);
    assert.equal(text.length, 3);
    assert.doesNotMatch(text.join("\n"), /"Oldest"/, "the oldest code is beyond the limit");
    await c.finish(ids[2]!, "done");
    const after = (await capped.ask(c.owner, { kind: "submissions_project", projectId: c.project }))!.lines.map((l) => l.text);
    assert.match(after[0]!, /^1 task\(s\) wait for a reviewer,.* Only the tasks with the newest code were read; more tasks with code may exist\.$/);
    assert.match(after[1]!, /"Middle"/);
    // Within the limit nothing is said about it.
    assert.doesNotMatch((await c.ask(c.owner))!.join("\n"), /Only the tasks with the newest code/);
  });

  suite("a sign-off or approval of older code does not carry to newer code; the newest sign-off decides; equal submit times pick one submission the same way each time", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const dee = await c.agent("dee", ["director"]);
    const t1 = await c.mkTask("Parser"), t2 = await c.mkTask("Lexer");
    const old = await code(c, ann, t1, "a");
    await c.svc.record(rev, { commandId: cid("r"), taskId: t1, kind: "review", role: "reviewer", subject: old.id, verdict: "approve" });
    await c.svc.record(dee, { commandId: cid("so"), taskId: t1, kind: "signoff", role: "director", subject: old.id, decision: "approve" });
    assert.match((await c.ask(c.owner))![1]!, /"Parser".* is approved and signed off: /);
    tick();
    const newer = await code(c, ann, t1, "b");
    const text = (await c.ask(c.owner))!;
    assert.match(text[1]!, new RegExp(`"Parser".* waits for a reviewer: submission ${newer.id} `));
    await c.svc.record(rev, { commandId: cid("r"), taskId: t1, kind: "review", role: "reviewer", subject: newer.id, verdict: "approve" });
    assert.match((await c.ask(c.owner))![1]!, /"Parser".* is approved, with no director sign-off yet: /);
    await c.svc.record(dee, { commandId: cid("so"), taskId: t1, kind: "signoff", role: "director", subject: newer.id, decision: "decline" });
    assert.match((await c.ask(c.owner))![1]!, /"Parser".* was approved but the director declined: /);
    await c.svc.record(dee, { commandId: cid("so"), taskId: t1, kind: "signoff", role: "director", subject: newer.id, decision: "approve" });
    assert.match((await c.ask(c.owner))![1]!, /"Parser".* is approved and signed off: /);
    await c.svc.record(rev, { commandId: cid("r"), taskId: t1, kind: "review", role: "reviewer", subject: newer.id, verdict: "changes" });
    assert.match((await c.ask(c.owner))![1]!, /"Parser".* waits for its author \(changes were asked for\): /, "a later review asking for changes takes the approval back");
    // Two code submissions at the same instant: the one with the greater ID is the newest, as the task's submissions view reads it.
    const x = await code(c, ann, t2, "c"), y = await code(c, ann, t2, "d");
    const winner = x.id > y.id ? x.id : y.id;
    for (let i = 0; i < 2; i++) assert.match((await c.ask(c.owner))!.find((l) => l.includes("Lexer"))!, new RegExp(`submission ${winner} `));
  });
}

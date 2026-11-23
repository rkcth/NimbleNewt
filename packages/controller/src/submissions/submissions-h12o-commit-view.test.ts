// Card H12o (sixth slice): the submissions view tells the owner and the author whether the platform has committed an approved code submission (the commit, permit or plain, or not yet). Read-only. Real services on every backend.
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

type Commit = { commitId: string; at: string; permitted?: boolean };
for (const backend of backends) {
  const suite = (name: string, body: (c: {
    ask(by: Principal): Promise<string>; owner: Principal; task: string; svc: SubmissionService; calls: string[];
    agent(name: string, roles: string[]): Promise<Principal>; commits: Map<string, Commit>; opens: Map<string, { operation: string; at: string }>; failing: { on: boolean }; asked: Map<string, string[]>;
    plain(): Promise<string>; autos: Map<string, { state: string; at: string; finishedAt?: string; summary?: string; hostAnswer?: boolean }>; solo(): SubmissionService; older(): Promise<string>;
  }) => Promise<void>) => test(`${backend.name}: ${name}`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Fix the parser" })).id;
      const asked = new Map<string, string[]>();
      const svc = SubmissionService.withEpoch(world.storage, epoch, async (id) => roles.get(id) ?? [], { ...options, reviewAssignments: async (principalId: string) => asked.get(principalId) ?? [] });
      const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
      const base = { assignments, waits: WaitService.withEpoch(world.storage, epoch, assignments, options), blockers: BlockerService.withEpoch(world.storage, epoch, options), contracts: ContractService.withEpoch(world.storage, epoch, options) };
      const commits = new Map<string, Commit>();
      const opens = new Map<string, { operation: string; at: string }>();
      const calls: string[] = [];
      const failing = { on: false };
      const autos = new Map<string, { state: string; at: string; finishedAt?: string; summary?: string; hostAnswer?: boolean }>();
      const submissionRelease = { commit: async (id: string) => { calls.push(`commit:${id}`); if (failing.on) throw new Error("storage went away"); return commits.get(id); }, open: async (t: string) => { calls.push(`open:${t}`); return opens.get(t); }, automatic: async (id: string, review: string) => { calls.push(`auto:${id}:${review}`); if (failing.on) throw new Error("storage went away"); return autos.get(`${id}:${review}`); } };
      const view = (extra: object) => StatusService.withEpoch(world.storage, epoch, { ...base, submissions: { list: (by, t, q) => svc.list(by, t, q), approvalOf: (id) => svc.approvalOf(id) }, ...extra }, options);
      const status = view({ submissionRelease });
      const text = async (s: StatusService, by: Principal): Promise<string> => ((await s.ask(by, { kind: "submissions", taskId: task }))?.lines ?? []).map((l) => l.text).join("\n");
      await body({ ask: (by) => text(status, by), owner, task, svc, calls, agent, commits, opens, failing, asked, autos, solo: () => SubmissionService.withEpoch(world.storage, epoch, async (id) => roles.get(id) ?? [], { ...options, reviewersAvailableIn: async () => [] }), plain: () => text(view({}), owner), older: () => text(view({ submissionRelease: { commit: submissionRelease.commit, open: submissionRelease.open } }), owner) });
    } finally { await world.close(); }
  });

  const code = (c: { svc: SubmissionService; task: string }, by: Principal, tree: string) => c.svc.record(by, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: T("c"), tree, patchId: T("d") });

  suite("an approved submission is told committed (permit or plain), not committed, or release open; unapproved code and other agents' code say nothing of commits", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const stranger = await c.agent("stranger", []);
    const sub = await code(c, ann, T("a"));
    // Not approved: no commit sentence, and the commit record is not even read.
    assert.doesNotMatch(await c.ask(c.owner), /Commit:/);
    assert.deepEqual(c.calls, []);
    tick();
    await c.svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: sub.id, verdict: "approve" });
    // Nothing open: no later automatic commit is promised, and nothing is said of what the checkout holds now.
    const none = await c.ask(c.owner);
    assert.match(none, /Commit: not made yet; it is committed only when a release request commits it\. The owner may ask for one; a reviewer's approval asks for one only at the moment it is given and does not try again\./);
    assert.doesNotMatch(none, /stays uncommitted in the task's checkout/);
    c.opens.set(c.task, { operation: "release", at: "2026-11-22T10:05:00.000Z" });
    assert.match(await c.ask(ann), /Commit: not made yet; a release request has been open on the task's checkout since 2026-11-22T10:05:00\.000Z\./);
    c.opens.set(c.task, { operation: "integration", at: "2026-11-22T10:05:30.000Z" });
    assert.match(await c.ask(ann), /Commit: not made yet; an integration request has been open on the task's checkout since 2026-11-22T10:05:30\.000Z\./);
    c.opens.clear();
    c.commits.set(sub.id, { commitId: "ab".repeat(20), at: "2026-11-22T10:06:00.000Z", permitted: true });
    assert.match(await c.ask(c.owner), /Commit: made in the task's checkout \(abababababab\) at 2026-11-22T10:06:00\.000Z, as a review-gate permit commit\./);
    c.commits.set(sub.id, { commitId: "cd".repeat(20), at: "2026-11-22T10:06:00.000Z" });
    assert.match(await c.ask(c.owner), /\(cdcdcdcdcdcd\) .* as a plain platform commit \(not a permit commit, so a landing that requires the permit does not take it\)\./);
    // Someone who may read the task but did not write the code is told nothing about its commit or review, and nothing is read for it.
    c.calls.length = 0;
    assert.doesNotMatch(await c.ask(stranger), /Commit:/);
    assert.deepEqual(c.calls, []);
    // A reviewer asked to review this code reads it but did not write it: the line is shown without review or commit state, and nothing is read for it.
    c.asked.set(rev.id, [sub.id]);
    const seen = await c.ask(rev);
    assert.match(seen, new RegExp(`code submission ${sub.id} .*shown to the owner and its author only`));
    assert.doesNotMatch(seen, /Commit:/);
    assert.deepEqual(c.calls, []);
  });

  suite("a commit that cannot be read is said so, never 'not made'; a controller without the release reads says nothing; the view creates no records", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const sub = await code(c, ann, T("a"));
    await c.svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: sub.id, verdict: "approve" });
    c.failing.on = true;
    const failed = await c.ask(c.owner);
    assert.match(failed, /Commit: could not be read just now\./);
    assert.doesNotMatch(failed, /not made yet/);
    c.failing.on = false;
    assert.doesNotMatch(await c.plain(), /Commit:/);
    const before = JSON.stringify(await c.svc.list(c.owner, c.task, { limit: 100 }));
    await c.ask(c.owner); await c.ask(ann);
    assert.equal(JSON.stringify(await c.svc.list(c.owner, c.task, { limit: 100 })), before);
  });

  suite("a refused, failed or unsure automatic release is told with what it said; only for a reviewer's approval, only to the owner and the author, nothing else says it, and the view creates nothing (card H12o, seventh slice)", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const stranger = await c.agent("stranger", []);
    const sub = await code(c, ann, T("a"));
    tick();
    const review = await c.svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: sub.id, verdict: "approve" });
    // Nothing recorded: the generic words, and the automatic answer was asked about with this very review.
    assert.match(await c.ask(c.owner), /Commit: not made yet; it is committed only when a release request commits it\./);
    assert.ok(c.calls.includes(`auto:${sub.id}:${review.id}`));
    c.autos.set(`${sub.id}:${review.id}`, { state: "refused", at: "2026-11-22T10:02:00.000Z", finishedAt: "2026-11-22T10:02:01.000Z", summary: "the checkout holds files that were not approved", hostAnswer: true });
    const refused = await c.ask(c.owner);
    assert.match(refused, /Commit: not made yet; the release that this approval asked for was refused at 2026-11-22T10:02:01\.000Z\. It said: "the checkout holds files that were not approved"\. It is committed only when a release request commits it; the owner may ask for one\./);
    assert.match(await c.ask(ann), /the release that this approval asked for was refused at 2026-11-22T10:02:01\.000Z\. It said: "the checkout holds files that were not approved"\./);
    // A refusal that is not the host's own answer (built from an error thrown on the controller's side, e.g. an attempt that could not be made quiet): its words go to the owner only.
    c.autos.set(`${sub.id}:${review.id}`, { state: "refused", at: "2026-11-22T10:02:00.000Z", summary: "release did not run: attempt att-1 could not be made quiet (ENOENT: open '/srv/host/runs/att-1')" });
    const authorRefused = await c.ask(ann);
    assert.match(authorRefused, /the release that this approval asked for was refused at 2026-11-22T10:02:00\.000Z\. What the host said is shown to the owner\./);
    assert.doesNotMatch(authorRefused, /\/srv\/host|ENOENT|made quiet/);
    assert.match(await c.ask(c.owner), /It said: "release did not run: attempt att-1 could not be made quiet/);
    c.autos.set(`${sub.id}:${review.id}`, { state: "failed", at: "2026-11-22T10:02:00.000Z", summary: "the host is down" });
    assert.match(await c.ask(c.owner), /the release that this approval asked for failed at 2026-11-22T10:02:00\.000Z\. It said: "the host is down"\./);
    // A failure's words may be a raw error of the host (its folders, git's own message): the author is told that it failed and when, not the words.
    c.autos.set(`${sub.id}:${review.id}`, { state: "failed", at: "2026-11-22T10:02:00.000Z", summary: "git add failed: cannot open /srv/host/checkouts/t1/x" });
    const authorFailed = await c.ask(ann);
    assert.match(authorFailed, /the release that this approval asked for failed at 2026-11-22T10:02:00\.000Z\. What the host said is shown to the owner\./);
    assert.doesNotMatch(authorFailed, /\/srv\/host|git add failed/);
    assert.match(await c.ask(c.owner), /It said: "git add failed: cannot open \/srv\/host\/checkouts\/t1\/x"/);
    c.autos.set(`${sub.id}:${review.id}`, { state: "uncertain", at: "2026-11-22T10:02:00.000Z", summary: "lost the answer at /srv/host/checkouts/t1" });
    assert.doesNotMatch(await c.ask(ann), /\/srv\/host|lost the answer/);
    c.autos.set(`${sub.id}:${review.id}`, { state: "uncertain", at: "2026-11-22T10:02:00.000Z" });
    const unsure = await c.ask(c.owner);
    assert.match(unsure, /was left unsure \(the checkout may have changed; check it before asking again\) at 2026-11-22T10:02:00\.000Z\. It is committed only/);
    assert.doesNotMatch(unsure, /It said/);
    // A request that ended well but left no commit is not explained; an open request is told as before and the automatic answer is not read then.
    c.autos.set(`${sub.id}:${review.id}`, { state: "done", at: "2026-11-22T10:02:00.000Z", summary: "fine" });
    assert.doesNotMatch(await c.ask(c.owner), /asked for/);
    c.autos.set(`${sub.id}:${review.id}`, { state: "refused", at: "2026-11-22T10:02:00.000Z", summary: "no" });
    c.opens.set(c.task, { operation: "release", at: "2026-11-22T10:05:00.000Z" });
    c.calls.length = 0;
    const open = await c.ask(c.owner);
    assert.match(open, /a release request has been open on the task's checkout since/);
    assert.doesNotMatch(open, /asked for/);
    assert.equal(c.calls.some((x) => x.startsWith("auto:")), false);
    c.opens.clear();
    // A recorded commit wins over any automatic answer, and then nothing is read about the automatic release.
    c.commits.set(sub.id, { commitId: "ab".repeat(20), at: "2026-11-22T10:06:00.000Z", permitted: true });
    c.calls.length = 0;
    const made = await c.ask(c.owner);
    assert.match(made, /Commit: made in the task's checkout/);
    assert.equal(c.calls.some((x) => x.startsWith("auto:")), false);
    c.commits.clear();
    // Other readers are told nothing and nothing is read; a failing read says it could not be read, never the refusal.
    c.calls.length = 0;
    assert.doesNotMatch(await c.ask(stranger), /Commit:|asked for/);
    assert.deepEqual(c.calls, []);
    // The reviewer who approved it is not the code's author: it is not told the host's words either, and nothing is read for it.
    c.autos.set(`${sub.id}:${review.id}`, { state: "refused", at: "2026-11-22T10:02:00.000Z", summary: "words only the owner and the author see", hostAnswer: true });
    c.asked.set(rev.id, [sub.id]);
    const toReviewer = await c.ask(rev);
    assert.match(toReviewer, new RegExp(`submission ${sub.id} by`), "the reviewer asked to review it reads the code line");
    assert.doesNotMatch(toReviewer, /Commit:|asked for|words only the owner/);
    assert.deepEqual(c.calls, []);
    assert.match(await c.ask(ann), /It said: "words only the owner and the author see"/);
    c.calls.length = 0;
    c.failing.on = true;
    assert.match(await c.ask(c.owner), /Commit: could not be read just now\./);
    c.failing.on = false;
    // Without the optional read (an older composition) the generic words stand; a view creates no record.
    c.calls.length = 0;
    const older = await c.older();
    assert.match(older, /Commit: not made yet; it is committed only when a release request commits it\./);
    assert.doesNotMatch(older, /asked for was|words only the owner/);
    assert.equal((c.calls as string[]).some((x) => x.startsWith("auto:")), false);
    const before = JSON.stringify(await c.svc.list(c.owner, c.task, { limit: 100 }));
    await c.ask(c.owner); await c.ask(ann);
    assert.equal(JSON.stringify(await c.svc.list(c.owner, c.task, { limit: 100 })), before);
  });

  suite("the one-agent approval is never asked about an automatic release (nothing asks one)", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const sub = await c.solo().record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: T("c"), tree: T("a"), patchId: T("d") });
    // The only agent of the project: no other agent could review, so the code is approved without a review and nothing asks for a release.
    c.autos.set(`${sub.id}:anything`, { state: "refused", at: "2026-11-22T10:02:00.000Z", summary: "no" });
    const text = await c.ask(c.owner);
    assert.match(text, /not required \(no other agent of the project could review it\)/);
    assert.match(text, /Commit: not made yet/);
    assert.doesNotMatch(text, /asked for/);
    assert.equal(c.calls.some((x) => x.startsWith("auto:")), false, text);
  });

  suite("only the newest code's approval counts: a later submission is not told committed from an older one's record, and code with changes asked for says nothing", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const rev = await c.agent("rev", ["reviewer"]);
    const first = await code(c, ann, T("a"));
    await c.svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: first.id, verdict: "approve" });
    c.commits.set(first.id, { commitId: "ef".repeat(20), at: "2026-11-22T10:06:00.000Z", permitted: true });
    tick();
    const second = await code(c, ann, T("b"));
    tick();
    await c.svc.record(rev, { commandId: cid("r"), taskId: c.task, kind: "review", role: "reviewer", subject: second.id, verdict: "changes" });
    const lines = (await c.ask(c.owner)).split("\n");
    const newest = lines.find((l) => l.startsWith(`Newest code submission ${second.id}`))!;
    const older = lines.find((l) => l.startsWith(`Older code submission ${first.id}`))!;
    assert.doesNotMatch(newest, /Commit:/);
    assert.match(older, /Commit: made in the task's checkout \(efefefefefef\)/);
  });
}

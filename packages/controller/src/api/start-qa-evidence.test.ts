import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { CHAT_OPS, acceptedArgs } from "../chat/commands.js";
import { STATUS_KINDS } from "../status/index.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40);
const tree = "b".repeat(40);
const tree2 = "d".repeat(40);
const patch = "c".repeat(40);
const ran = "2026-11-18T09:00:00.000Z";

async function world(name: string) {
  const d = mkdtempSync(join(tmpdir(), `nn-${name}-`));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI] });
  const s = c.services;
  const boot = await s.principals.bootstrapOwner({ name: "rob" });
  const rob = await s.principals.authenticate(boot.token);
  const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
  const other = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
  const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Fix the login" })).id;
  await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
  const hire = async (n: string, roles: string[], inProject: string, read = true) => {
    const made = await s.agents.create(rob, { commandId: `mk-${n}`, friendlyName: n, roles });
    const id = `agent:${made.id}`;
    if (read) await s.grants.grant(rob, { commandId: `g-${n}`, grantee: id, action: "task.read", project: inProject, source: "direct", basis: "test" } as never);
    return { id, token: (await s.principals.issueCredential(rob, id)).token };
  };
  const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
  const ann = await hire("Ann", ["author"], project);
  await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
  await s.assignments.admitAttempt({ commandId: "adm1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
  const code = async (t: string, cid: string): Promise<string> => {
    const r = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base, tree: t, patchId: patch }, cid);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.result.id as string;
  };
  const done = async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); };
  return { c, s, boot, rob, project, other, task, hire, call, ann, code, done };
}

test("QA evidence through the state API: bound to the tree, the criteria and the decisions; four results kept apart; missing evidence fails; self-checks and role titles grant nothing (card Q02)", async () => {
  const w = await world("qa-record");
  try {
    const { call, boot, task, project, ann } = w;
    const qa = await w.hire("Quinn", ["qa"], project);
    const titled = await w.hire("Tia", ["qa"], project, false);
    const plain = await w.hire("Pat", ["author"], project);
    const far = await w.hire("Far", ["qa"], w.other);
    const sub = await w.code(tree, "s1");
    // The contract names two checks the gate requires.
    const set = await call(boot.token, "contract.set", { taskId: task, expectedVersion: 0, acceptanceCriteria: ["a user can log in"], checks: [{ name: "unit", run: ["npm", "test"] }], requiredEvidence: ["login screenshot"] }, "c1");
    assert.equal(set.ok, true, JSON.stringify(set));
    const dec = await call(boot.token, "decision.record", { projectId: project, category: "decision", topic: "auth", statement: "Use passkeys", wording: "we use passkeys for login", basedOn: 0 }, "d1");
    assert.equal(dec.result.recorded, true, JSON.stringify(dec));
    const link = await call(boot.token, "decision.link", { taskId: task, subject: { kind: "task", id: task }, decisions: [dec.result.id] }, "l1");
    assert.equal(link.ok, true, JSON.stringify(link));

    const ev = { submissionId: sub, criteriaRevision: 1, decisions: [dec.result.id], environment: "Linux 6.8, Node 22.19, Chromium 131", observedAt: ran, checks: [{ name: "unit", result: "passed" }, { name: "login screenshot", result: "blocked", detail: "the staging host was down" }] };
    // The gate fails before any evidence exists.
    const empty = await call(boot.token, "qa.evidence.gate", { submissionId: sub });
    assert.equal(empty.ok, true, JSON.stringify(empty));
    assert.deepEqual([empty.result.item.verdict, empty.result.item.reasons, empty.result.item.counts.missing], ["failed", ["no_evidence", "check_missing"], 2], "absent evidence fails the gate");

    assert.equal((await call(titled.token, "qa.evidence.record", ev, "q0")).error.code, "not_found", "the qa role without the right to read the task opens nothing");
    assert.equal((await call(far.token, "qa.evidence.record", ev, "q0")).error.code, "not_found", "another project's qa agent cannot see the task");
    assert.equal((await call(plain.token, "qa.evidence.record", ev, "q0")).error.code, "forbidden", "an agent with neither qa nor reviewer role records nothing");
    assert.equal((await call(qa.token, "qa.evidence.record", { ...ev, criteriaRevision: 0 }, "q0")).error.code, "stale_revision", "the criteria named must be the ones in force");
    assert.equal((await call(qa.token, "qa.evidence.record", { ...ev, decisions: [] }, "q0")).error.code, "invalid_command", "every decision the task relies on is named");
    assert.equal((await call(qa.token, "qa.evidence.record", { ...ev, checks: [{ name: "unit", result: "pass" }] }, "q0")).error.code, "invalid_command", "only the four results");
    assert.equal((await call(qa.token, "qa.evidence.record", { ...ev, checks: [{ name: "unit", result: "passed" }, { name: "unit", result: "failed" }] }, "q0")).error.code, "invalid_command", "a check is listed once");
    assert.equal((await call(qa.token, "qa.evidence.record", { ...ev, observedAt: "2027-01-01T00:00:00.000Z" }, "q0")).error.code, "invalid_command", "not in the future");
    assert.equal((await call(qa.token, "qa.evidence.record", ev)).error.code, "invalid_command", "a command ID is required");

    // The author's self-check is kept, never counted.
    const self = await call(ann.token, "qa.evidence.record", { ...ev, checks: [{ name: "unit", result: "passed" }, { name: "login screenshot", result: "passed" }] }, "q-self");
    assert.equal(self.ok, true, JSON.stringify(self));
    assert.equal(self.result.source, "self");
    assert.equal((await call(boot.token, "qa.evidence.gate", { submissionId: sub })).result.item.verdict, "failed", "a self-check does not pass the gate");

    const first = await call(qa.token, "qa.evidence.record", ev, "q1");
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.result.source, "independent");
    assert.equal((await call(qa.token, "qa.evidence.record", ev, "q1")).result.replayed, true, "a replay records once");
    const got = await call(boot.token, "qa.evidence.get", { id: first.result.id });
    assert.deepEqual([got.result.item.tree, got.result.item.criteriaRevision, got.result.item.decisions[0].id, got.result.item.decisions[0].version, got.result.item.environment, got.result.item.observedAt, typeof got.result.item.recordedAt], [tree, 1, dec.result.id, 1, ev.environment, ran, "string"], "findings record tree, criteria revision, decision revision, environment and time");
    assert.equal((await call(far.token, "qa.evidence.get", { id: first.result.id })).error.code, "not_found");

    const g1 = (await call(qa.token, "qa.evidence.gate", { submissionId: sub })).result.item;
    assert.deepEqual([g1.verdict, g1.reasons, g1.counts, g1.required, g1.criteriaRevision, g1.tree], ["failed", ["check_blocked"], { passed: 1, failed: 0, blocked: 1, notRun: 0, missing: 0 }, ["unit", "login screenshot"], 1, tree], "blocked is counted apart and fails");

    const notRun = await call(qa.token, "qa.evidence.record", { ...ev, checks: [{ name: "login screenshot", result: "not-run" }] }, "q2");
    assert.equal(notRun.ok, true, JSON.stringify(notRun));
    const g2 = (await call(qa.token, "qa.evidence.gate", { submissionId: sub })).result.item;
    assert.deepEqual([g2.verdict, g2.reasons, g2.counts.notRun, g2.counts.passed], ["failed", ["check_not_run"], 1, 1], "the newest record naming a check decides it; not-run fails");
    const failed = await call(qa.token, "qa.evidence.record", { ...ev, checks: [{ name: "unit", result: "failed" }, { name: "login screenshot", result: "passed" }] }, "q3");
    assert.equal(failed.ok, true);
    const g3 = (await call(qa.token, "qa.evidence.gate", { submissionId: sub })).result.item;
    assert.deepEqual([g3.verdict, g3.reasons, g3.counts.failed], ["failed", ["check_failed"], 1]);
    const passed = await call(qa.token, "qa.evidence.record", { ...ev, checks: [{ name: "unit", result: "passed" }] }, "q4");
    assert.equal(passed.ok, true);
    const g4 = (await call(boot.token, "qa.evidence.gate", { submissionId: sub })).result.item;
    assert.deepEqual([g4.verdict, g4.reasons, g4.counts], ["passed", [], { passed: 2, failed: 0, blocked: 0, notRun: 0, missing: 0 }]);
    assert.deepEqual(g4.decisions.map((d: { id: string }) => d.id), [dec.result.id], "the verdict cites the decisions it stands on");

    // Another tree has no evidence: a different version never passes on this one's checks.
    const sub2 = await w.code(tree2, "s2");
    assert.deepEqual((await call(boot.token, "qa.evidence.gate", { submissionId: sub2 })).result.item.reasons, ["no_evidence", "check_missing"]);

    // The owner reads it by status (the chat's `qa` kind).
    const view = await call(boot.token, "status.ask", { request: { kind: "qa", taskId: task } });
    assert.equal(view.ok, true, JSON.stringify(view));
    const text = view.result.item.lines.map((l: { text: string }) => l.text).join("\n");
    assert.match(text, new RegExp(`QA gate for tree ${tree.slice(0, 12)} \\(submission ${sub}\\) passes`));
    assert.match(text, /Self-check qae-/);
    assert.match(text, /blocked 1/);
  } finally { await w.done(); }
});

test("a changed dependency invalidates QA evidence and schedules a re-check; new independent evidence settles it; a superseded decision fails the gate (card Q02)", async () => {
  const w = await world("qa-invalidate");
  try {
    const { call, boot, task, project, s } = w;
    const qa = await w.hire("Quinn", ["qa"], project);
    const rev = await w.hire("Rev", ["reviewer"], project);
    const sub = await w.code(tree, "s1");
    await call(boot.token, "contract.set", { taskId: task, expectedVersion: 0, acceptanceCriteria: ["a user can log in"] }, "c1");
    const dec = await call(boot.token, "decision.record", { projectId: project, category: "decision", topic: "auth", statement: "Use passkeys", wording: "we use passkeys for login", basedOn: 0 }, "d1");
    await call(boot.token, "decision.link", { taskId: task, subject: { kind: "task", id: task }, decisions: [dec.result.id] }, "l1");
    const ev = { submissionId: sub, criteriaRevision: 1, decisions: [dec.result.id], environment: "Linux", observedAt: ran, checks: [{ name: "login works", result: "passed" }] };
    const first = await call(qa.token, "qa.evidence.record", ev, "q1");
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal((await call(boot.token, "qa.evidence.gate", { submissionId: sub })).result.item.verdict, "passed", "with no required checks, every check named in current independent evidence passed");

    // A change of priority is not a change of what the work must be: nothing goes stale.
    await call(boot.token, "contract.set", { taskId: task, expectedVersion: 1, priority: 8 }, "c2");
    const quiet = await call(qa.token, "qa.evidence.check", { taskId: task }, "k0");
    assert.deepEqual([quiet.ok, quiet.result.invalidated], [true, []], JSON.stringify(quiet));
    assert.equal((await call(boot.token, "qa.evidence.gate", { submissionId: sub })).result.item.verdict, "passed");

    // The acceptance criteria change: the evidence no longer holds, even before anyone asks.
    await call(boot.token, "contract.set", { taskId: task, expectedVersion: 2, acceptanceCriteria: ["a user can log in", "a user can log out"] }, "c3");
    const before = (await call(boot.token, "qa.evidence.gate", { submissionId: sub })).result.item;
    assert.deepEqual([before.verdict, before.reasons, before.stale[0].reasons[0].kind, before.stale[0].reasons[0].fields], ["failed", ["stale_evidence"], "criteria_changed", ["acceptanceCriteria"]], "stale evidence never passes");
    const listed = (await call(qa.token, "qa.evidence.list", { taskId: task })).result;
    assert.equal(listed.items[0].staleNow[0].kind, "criteria_changed");

    const checked = await call(rev.token, "qa.evidence.check", { taskId: task }, "k1");
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.deepEqual(checked.result.invalidated, [first.result.id]);
    assert.equal(checked.result.rechecks.length, 1);
    const recheckId = checked.result.rechecks[0] as string;
    assert.equal((await call(rev.token, "qa.evidence.check", { taskId: task }, "k1")).result.replayed, false, "nothing stale is left, so nothing is written again");
    const inv = (await call(boot.token, "qa.evidence.get", { id: first.result.id })).result.item;
    assert.deepEqual([inv.state, inv.recheckId, inv.reasons[0].kind, inv.checks[0].result], ["invalidated", recheckId, "criteria_changed", "passed"], "the record is kept with its results and the reasons");
    const rc = (await call(qa.token, "qa.evidence.get", { id: recheckId })).result.item;
    assert.deepEqual([rc.state, rc.assignee, rc.evidenceId, rc.tree], ["pending", qa.id, first.result.id, tree], "the re-check goes to whoever recorded the evidence");
    const inbox = (await NotificationService.withEpoch(w.c.storage, w.c.epoch).inbox(w.rob)).items.filter((i) => i.ref.kind === "qa-recheck");
    assert.deepEqual(inbox.map((i) => i.ref.id), [recheckId], "the owner is told");
    const pend = (await call(boot.token, "qa.evidence.gate", { submissionId: sub })).result.item;
    assert.deepEqual([pend.verdict, pend.pendingRechecks], ["failed", [recheckId]]);
    const view = await call(boot.token, "status.ask", { request: { kind: "qa", taskId: task } });
    assert.match(view.result.item.lines.map((l: { text: string }) => l.text).join("\n"), new RegExp(`Re-check ${recheckId} .* scheduled for ${qa.id}.*acceptanceCriteria changed`));

    // The re-check is done by recording new independent evidence against the current criteria.
    const again = await call(qa.token, "qa.evidence.record", { ...ev, criteriaRevision: 3 }, "q2");
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual(again.result.settled, [recheckId]);
    assert.equal((await call(qa.token, "qa.evidence.get", { id: recheckId })).result.item.state, "done");
    assert.equal((await call(boot.token, "qa.evidence.gate", { submissionId: sub })).result.item.verdict, "passed");

    // The owner corrects the decision: the work bound to the superseded one fails, and its evidence is invalidated.
    const v2 = await call(boot.token, "decision.record", { projectId: project, category: "decision", topic: "auth", statement: "Use passwords", wording: "actually use passwords instead", basedOn: 1 }, "d2");
    assert.equal(v2.result.recorded, true, JSON.stringify(v2));
    const g = (await call(boot.token, "qa.evidence.gate", { submissionId: sub })).result.item;
    assert.equal(g.verdict, "failed");
    assert.ok(g.reasons.includes("decision_superseded") && g.reasons.includes("stale_evidence"), JSON.stringify(g.reasons));
    const refused = await call(qa.token, "qa.evidence.record", { ...ev, criteriaRevision: 3, decisions: [dec.result.id] }, "q3");
    assert.equal(refused.error.code, "invalid_command", "evidence is never judged against a superseded decision");
    const k2 = await call(boot.token, "qa.evidence.check", { taskId: task }, "k2");
    assert.deepEqual(k2.result.invalidated, [again.result.id]);
    const r2 = (await call(boot.token, "qa.evidence.get", { id: k2.result.rechecks[0] })).result.item;
    assert.equal(r2.reasons[0].kind, "decision_superseded");
    void s;
  } finally { await w.done(); }
});

test("the owner reaches QA by chat: the qa status kind and qa.evidence.check are offered to the interpreter by name, with the task's title (card Q02)", () => {
  assert.ok(STATUS_KINDS["qa"] !== undefined && STATUS_KINDS["qa"]!.keys.includes("taskId|taskTitle"));
  assert.equal(CHAT_OPS["qa.evidence.check"]?.mode, "apply");
  assert.ok((acceptedArgs("qa.evidence.check") ?? []).includes("taskTitle"));
});

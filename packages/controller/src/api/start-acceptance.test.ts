import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";
import { CHAT_OPS } from "../chat/commands.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

async function world(name: string) {
  const d = mkdtempSync(join(tmpdir(), `nn-${name}-`));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], artifacts: { directory: join(d, "blobs") } });
  const s = c.services;
  const boot = await s.principals.bootstrapOwner({ name: "rob" });
  const rob = await s.principals.authenticate(boot.token);
  const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
  const other = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
  const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Write the guide" })).id;
  const task2 = (await s.projects.createTask({ commandId: "t2", actor: rob.id, projectId: project, title: "Other" })).id;
  const hire = async (n: string, roles: string[], inProject: string, read = true) => {
    const made = await s.agents.create(rob, { commandId: `mk-${n}`, friendlyName: n, roles });
    const id = `agent:${made.id}`;
    if (read) await s.grants.grant(rob, { commandId: `g-${n}`, grantee: id, action: "task.read", project: inProject, source: "direct", basis: "test" } as never);
    return { id, token: (await s.principals.issueCredential(rob, id)).token };
  };
  const artifacts = ArtifactService.withEpoch(c.storage, c.epoch, await FileBlobStore.open({ directory: join(d, "blobs") }));
  const publish = async (n: string, taskId: string, projectId = project) => (await artifacts.publish({ commandId: `a-${n}`, actor: rob.id, name: n, projectId, taskId, files: [{ path: `${n}.txt`, content: Buffer.from(`content of ${n}`) }] })).id;
  const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
  const done = async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); };
  return { c, d, s, boot, rob, project, other, task, task2, hire, publish, call, done };
}

test("a deliverable moves draft, submitted, under-review, accepted as separate events; the worker cannot accept, a reviewer who did none of the work can; tool completion alone accepts nothing (card Q01)", async () => {
  const w = await world("acc-flow");
  try {
    const { s, call, boot, task, project } = w;
    const ann = await w.hire("Ann", ["author", "docs"], project);
    const rev = await w.hire("Rev", ["reviewer"], project);
    const dir = await w.hire("Dir", ["director"], project);
    const far = await w.hire("Far", ["author", "docs", "reviewer"], w.other);
    const src = await w.publish("guide-src", task);
    const exp = await w.publish("guide-pdf", task);
    const elsewhere = await w.publish("not-mine", w.task2);
    const draft = { taskId: task, type: "document", title: "Guide", audience: ["owner", "director"], artifacts: [{ artifactId: src, role: "source" }, { artifactId: exp, role: "exported", exportedFrom: src }] };

    assert.equal((await call(far.token, "deliverable.draft", draft, "d0")).error.code, "not_found", "another project's agent cannot see the task");
    assert.equal((await call(rev.token, "deliverable.draft", draft, "d0")).error.code, "forbidden", "a reviewer makes no deliverables");
    assert.equal((await call(ann.token, "deliverable.draft", draft)).error.code, "invalid_command", "a command ID is required");
    assert.equal((await call(ann.token, "deliverable.draft", { ...draft, artifacts: [{ artifactId: elsewhere }] }, "d0b")).error.code, "invalid_command", "an artifact of another task is refused");
    assert.equal((await call(ann.token, "deliverable.draft", { ...draft, type: "novel" }, "d0c")).error.code, "invalid_command");
    assert.equal((await call(ann.token, "deliverable.draft", { ...draft, extra: 1 }, "d0d")).error.code, "invalid_command");
    assert.equal((await call(ann.token, "deliverable.draft", { ...draft, responsibleAgent: rev.id }, "d0e")).error.code, "forbidden", "an agent creates for itself only");

    const made = await call(ann.token, "deliverable.draft", draft, "d1");
    assert.equal(made.ok, true, JSON.stringify(made));
    const id = made.result.id as string;
    assert.equal((await call(ann.token, "deliverable.draft", draft, "d1")).result.replayed, true, "a replay records once");
    const got = await call(ann.token, "deliverable.record.get", { id });
    assert.deepEqual([got.result.item.type, got.result.item.responsibleAgent, got.result.item.accessScope, got.result.item.audience, got.result.item.state], ["document", ann.id, "task", ["owner", "director"], "draft"]);
    assert.deepEqual(got.result.item.version.content.artifacts.map((a: any) => [a.role, a.exportedFrom ?? null]), [["source", null], ["exported", src]], "source and exported artifacts are grouped under one version");

    // Not yet submitted: nobody can review or accept a draft; the worker cannot submit through someone else.
    assert.equal((await call(rev.token, "deliverable.review.start", { id, version: 1 }, "rs0")).error.code, "invalid_transition");
    assert.equal((await call(rev.token, "deliverable.submit", { id, expectedRevision: 1, contractVersion: 0 }, "sb0")).error.code, "forbidden", "only the responsible agent submits");
    // The contract changes: a submission is checked against the version in force.
    await s.contracts.setContract(w.rob, { commandId: "ct1", taskId: task, expectedVersion: 0, acceptanceCriteria: ["guide is clear"] } as never);
    const stale = await call(ann.token, "deliverable.submit", { id, expectedRevision: 1, contractVersion: 0 }, "sb1");
    assert.equal(stale.error.code, "stale_revision", "the task contract moved on");
    assert.equal((await call(ann.token, "deliverable.submit", { id, expectedRevision: 5, contractVersion: 1 }, "sb1b")).error.code, "stale_revision", "stale deliverable revision");
    const sub = await call(ann.token, "deliverable.submit", { id, expectedRevision: 1, contractVersion: 1 }, "sb2");
    assert.equal(sub.ok, true, JSON.stringify(sub));
    assert.equal((await call(ann.token, "deliverable.submit", { id, expectedRevision: 1, contractVersion: 1 }, "sb2")).result.replayed, true);

    // Tool completion alone: the task is finished by the owner's transition, yet nothing is accepted.
    await s.projects.transitionTask({ commandId: "r1", actor: w.rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    assert.equal((await call(boot.token, "deliverable.record.get", { id })).result.item.state, "submitted");
    assert.deepEqual(await s.acceptance.acceptedFor(task), { accepted: false, deliverables: [] });
    // The worker cannot accept (not even by starting its own review), nor can a stranger.
    assert.equal((await call(ann.token, "deliverable.review.start", { id, version: 1 }, "rs1")).error.code, "forbidden", "no self-review");
    assert.equal((await call(ann.token, "deliverable.accept", { id, version: 1 }, "ac0")).error.code, "invalid_transition");
    const rs = await call(rev.token, "deliverable.review.start", { id, version: 1 }, "rs2");
    assert.equal(rs.ok, true, JSON.stringify(rs));
    assert.equal((await call(ann.token, "deliverable.accept", { id, version: 1 }, "ac1")).error.code, "forbidden", "the worker cannot accept");
    assert.equal((await call(far.token, "deliverable.accept", { id, version: 1 }, "ac2")).error.code, "not_found");
    assert.equal((await call(rev.token, "deliverable.accept", { id, version: 2 }, "ac3")).error.code, "stale_revision", "wrong version");
    assert.equal((await call(rev.token, "deliverable.accept", { id, version: 1, bogus: 1 }, "ac3b")).error.code, "invalid_command");
    const acc = await call(rev.token, "deliverable.accept", { id, version: 1, reason: "reads well" }, "ac4");
    assert.equal(acc.ok, true, JSON.stringify(acc));
    assert.equal((await call(rev.token, "deliverable.accept", { id, version: 1, reason: "reads well" }, "ac4")).result.replayed, true, "a replay accepts once");
    assert.equal((await call(dir.token, "deliverable.accept", { id, version: 1 }, "ac5")).error.code, "invalid_transition", "accepted once");
    assert.deepEqual(await s.acceptance.acceptedFor(task), { accepted: true, deliverables: [id] });

    const events = await call(boot.token, "deliverable.record.events", { id });
    assert.deepEqual(events.result.items.map((e: any) => [e.seq, e.version, e.kind]), [[1, 1, "draft"], [2, 1, "submitted"], [3, 1, "under-review"], [4, 1, "accepted"]], "distinct versioned events");
    const paged = await call(boot.token, "deliverable.record.events", { id, limit: 3 });
    assert.deepEqual([paged.result.items.length, paged.result.next], [3, 3]);
    assert.deepEqual((await call(boot.token, "deliverable.record.events", { id, after: 3, limit: 3 })).result.items.map((e: any) => e.kind), ["accepted"]);
    assert.equal((await call(ann.token, "deliverable.record.events", { id, limit: 0 })).error.code, "invalid_command");
    assert.equal((await call(far.token, "deliverable.record.events", { id })).error.code, "not_found");
    assert.deepEqual((await call(boot.token, "deliverable.record.list", { taskId: task })).result.items.map((i: any) => i.id), [id]);
    assert.equal((await call(far.token, "deliverable.record.list", { taskId: task })).error.code, "not_found");
  } finally { await w.done(); }
});

test("a missing or changed artifact voids the review, rejected history is kept, a new version supersedes (card Q01)", async () => {
  const w = await world("acc-damage");
  try {
    const { call, boot, task, project } = w;
    const ann = await w.hire("Ann", ["author", "docs"], project);
    const rev = await w.hire("Rev", ["reviewer"], project);
    const dir = await w.hire("Dir", ["director"], project);
    const a1 = await w.publish("v1", task);
    const id = (await call(ann.token, "deliverable.draft", { taskId: task, type: "report", title: "Report", artifacts: [{ artifactId: a1 }] }, "d1")).result.id as string;
    assert.equal((await call(ann.token, "deliverable.submit", { id, expectedRevision: 1, contractVersion: 0 }, "s1")).ok, true);
    assert.equal((await call(rev.token, "deliverable.review.start", { id, version: 1 }, "rs1")).ok, true);

    // The bytes change under the review.
    const find = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile() && /^[0-9a-f]{64}$/.test(e.name)).map((e) => join(e.parentPath, e.name));
    const blob = find(join(w.d, "blobs")).find((f) => f.includes("/blobs/blobs/"))!;
    chmodSync(blob, 0o600); writeFileSync(blob, "tampered");
    const bad = await call(rev.token, "deliverable.accept", { id, version: 1 }, "ac1");
    assert.equal(bad.error.code, "integrity", JSON.stringify(bad));
    let item = (await call(boot.token, "deliverable.record.get", { id })).result.item;
    assert.equal(item.state, "submitted", "the review is voided, not accepted");
    assert.equal(item.version.reviewer, undefined);
    assert.deepEqual((await call(boot.token, "deliverable.record.events", { id })).result.items.map((e: any) => e.kind), ["draft", "submitted", "under-review", "invalidated"]);
    assert.equal((await call(rev.token, "deliverable.accept", { id, version: 1 }, "ac1")).error.code === undefined, false, "the same command does not accept on a retry");
    assert.equal((await call(rev.token, "deliverable.review.start", { id, version: 1 }, "rs2")).error.code, "integrity", "damaged work cannot go back into review");
    assert.equal((await call(rev.token, "deliverable.check", { id }, "ck1")).result.ok, false);
    // A stranger to the deliverable cannot trigger a check.
    const stranger = await w.hire("Nobody", ["author"], project, false);
    assert.equal((await call(stranger.token, "deliverable.check", { id }, "ck0")).error.code, "not_found");

    // The responsible agent starts version 2 (v1 is superseded); the new bytes pass; the director rejects it with a reason.
    const a2 = await w.publish("v2", task);
    const rv = (await call(boot.token, "deliverable.record.get", { id })).result.item.revision;
    assert.equal((await call(ann.token, "deliverable.version.new", { id, expectedRevision: rv - 1, artifacts: [{ artifactId: a2 }] }, "n0")).error.code, "stale_revision");
    assert.equal((await call(ann.token, "deliverable.version.new", { id, expectedRevision: rv, artifacts: [{ artifactId: a2 }] }, "n1")).ok, true);
    item = (await call(boot.token, "deliverable.record.get", { id })).result.item;
    assert.deepEqual(item.versions, [{ version: 1, state: "superseded" }, { version: 2, state: "draft" }]);
    assert.equal((await call(ann.token, "deliverable.revise", { id, expectedRevision: item.revision, artifacts: [{ artifactId: a2 }], note: "second try" }, "rv1")).ok, true);
    assert.equal((await call(ann.token, "deliverable.submit", { id, expectedRevision: item.revision + 1, contractVersion: 0 }, "s2")).ok, true);
    assert.equal((await call(dir.token, "deliverable.review.start", { id, version: 2 }, "rs3")).ok, true);
    assert.equal((await call(dir.token, "deliverable.reject", { id, version: 2 }, "rj0")).error.code, "invalid_command", "a reason is required");
    assert.equal((await call(rev.token, "deliverable.reject", { id, version: 2, reason: "no" }, "rj1")).error.code, "forbidden", "a reviewer decides only on a review it started");
    assert.equal((await call(dir.token, "deliverable.reject", { id, version: 2, reason: "thin, key sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234" }, "rj2")).ok, true);
    // A rejected version stays rejected when the next one starts.
    item = (await call(boot.token, "deliverable.record.get", { id })).result.item;
    const a3 = await w.publish("v3", task);
    assert.equal((await call(ann.token, "deliverable.version.new", { id, expectedRevision: item.revision, artifacts: [{ artifactId: a3 }] }, "n2")).ok, true);
    item = (await call(boot.token, "deliverable.record.get", { id })).result.item;
    assert.deepEqual(item.versions, [{ version: 1, state: "superseded" }, { version: 2, state: "rejected" }, { version: 3, state: "draft" }]);
    const old = (await call(boot.token, "deliverable.record.get", { id, version: 2 })).result.item.version;
    assert.equal(old.state, "rejected");
    assert.ok(!String(old.reason).includes("sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234"), "reasons are redacted");
    const kinds = (await call(boot.token, "deliverable.record.events", { id, limit: 100 })).result.items.map((e: any) => `${e.version}:${e.kind}`);
    assert.deepEqual(kinds, ["1:draft", "1:submitted", "1:under-review", "1:invalidated", "1:superseded", "2:draft", "2:submitted", "2:under-review", "2:rejected", "3:draft"]);
  } finally { await w.done(); }
});

test("who may decide: external audience is the owner's alone, a single-agent project is decided by the owner, access scope hides it, outcomes and code deliverables are completed correctly (card Q01)", async () => {
  const w = await world("acc-who");
  try {
    const { call, boot, task, project, s } = w;
    const ann = await w.hire("Ann", ["author", "docs", "reviewer", "director"], project);
    // One agent only: review is disabled and recorded; Ann can neither review nor accept her own work.
    const out = { reference: "eff-123", systemVersion: "svc 4.2", observedAt: "2026-10-30T10:00:00.000Z" };
    assert.equal((await call(ann.token, "deliverable.draft", { taskId: task, type: "operational-outcome", title: "Restart" , outcome: { ...out, observedAt: "yesterday" } }, "o0")).error.code, "invalid_command");
    const id = (await call(ann.token, "deliverable.draft", { taskId: task, type: "operational-outcome", title: "Restart", outcome: out }, "o1")).result.id as string;
    assert.equal((await call(ann.token, "deliverable.submit", { id, expectedRevision: 1, contractVersion: 0 }, "o2")).ok, true);
    const item = (await call(boot.token, "deliverable.record.get", { id })).result.item;
    assert.deepEqual([item.version.review, item.version.content.outcome.reference], [{ required: false, reason: "review_disabled_single_agent" }, "eff-123"]);
    assert.equal((await call(ann.token, "deliverable.review.start", { id, version: 1 }, "o3")).error.code, "forbidden");
    assert.equal((await call(boot.token, "deliverable.review.start", { id, version: 1 }, "o4")).ok, true);
    assert.equal((await call(ann.token, "deliverable.accept", { id, version: 1 }, "o5")).error.code, "forbidden");
    assert.equal((await call(boot.token, "deliverable.accept", { id, version: 1 }, "o6")).ok, true, "the owner accepts");

    // A second agent joins; an external-audience deliverable is still the owner's to accept.
    const dir = await w.hire("Dir", ["director"], project);
    const ext = (await call(ann.token, "deliverable.draft", { taskId: task, type: "operational-outcome", title: "Publish", audience: ["external"], outcome: out }, "e1")).result.id as string;
    await call(ann.token, "deliverable.submit", { id: ext, expectedRevision: 1, contractVersion: 0 }, "e2");
    assert.equal((await call(dir.token, "deliverable.review.start", { id: ext, version: 1 }, "e3")).error.code, "forbidden");
    assert.equal((await call(boot.token, "deliverable.review.start", { id: ext, version: 1 }, "e4")).ok, true);
    assert.equal((await call(dir.token, "deliverable.accept", { id: ext, version: 1 }, "e5")).error.code, "forbidden");

    // Access scope owner: the director cannot even see it.
    const hid = (await call(ann.token, "deliverable.draft", { taskId: task, type: "report", title: "Private", accessScope: "owner", artifacts: [{ artifactId: await w.publish("priv", task) }] }, "h1")).result.id as string;
    assert.equal((await call(dir.token, "deliverable.record.get", { id: hid })).error.code, "not_found");
    assert.deepEqual((await call(dir.token, "deliverable.record.list", { taskId: task })).result.items.map((i: any) => i.id).includes(hid), false);
    assert.deepEqual((await call(ann.token, "deliverable.record.list", { taskId: task })).result.items.map((i: any) => i.id).includes(hid), true);

    // A code deliverable names a code submission of the task; an empty one cannot be submitted.
    const code = (await call(ann.token, "deliverable.draft", { taskId: task, type: "code", title: "Patch" }, "c1")).result.id as string;
    assert.equal((await call(ann.token, "deliverable.submit", { id: code, expectedRevision: 1, contractVersion: 0 }, "c2")).error.code, "invalid_command");
    assert.equal((await call(ann.token, "deliverable.revise", { id: code, expectedRevision: 1, submissionIds: ["sbm-aaaaaaaaaaaaaaaaaaaa"] }, "c3")).error.code, "invalid_command", "an unknown submission");
    // A task credential acts for its one task only.
    const credA = (await s.taskCredentials.issue(w.rob, { commandId: "tca", taskId: task, agentId: ann.id })).token;
    const credB = (await s.taskCredentials.issue(w.rob, { commandId: "tcb", taskId: w.task2, agentId: ann.id })).token;
    assert.equal((await call(credA, "deliverable.record.get", { id: hid })).ok, true, "its own task");
    assert.equal((await call(credB, "deliverable.record.get", { id: hid })).error.code, "not_found", "another task's credential");
    assert.equal((await call(credB, "deliverable.record.list", { taskId: task })).error.code, "not_found");
    assert.equal((await call(credB, "deliverable.draft", { taskId: task, type: "report", title: "x" }, "tc1")).error.code, "not_found");
    // The owner's chat commands exist for the review steps.
    for (const op of ["deliverable.review.start", "deliverable.accept", "deliverable.reject"]) assert.ok(CHAT_OPS[op], op);
    // Concurrent accepts: exactly one wins.
    const dir2 = await w.hire("Dir2", ["director"], project);
    const race = (await call(ann.token, "deliverable.draft", { taskId: task, type: "operational-outcome", title: "Race", outcome: out }, "r1")).result.id as string;
    await call(ann.token, "deliverable.submit", { id: race, expectedRevision: 1, contractVersion: 0 }, "r2");
    assert.equal((await call(dir.token, "deliverable.review.start", { id: race, version: 1 }, "r3")).ok, true);
    const both = await Promise.all([call(dir.token, "deliverable.accept", { id: race, version: 1 }, "r4"), call(dir2.token, "deliverable.accept", { id: race, version: 1 }, "r5")]);
    assert.equal(both.filter((r) => r.ok === true).length, 1, JSON.stringify(both));
    assert.deepEqual((await call(boot.token, "deliverable.record.events", { id: race })).result.items.map((e: any) => e.kind), ["draft", "submitted", "under-review", "accepted"]);
    void s;
  } finally { await w.done(); }
});

test("a code deliverable is the responsible agent's own code submission; the submitter of the linked work cannot review it, and a document submission must match its artifact (card Q01)", async () => {
  const w = await world("acc-code");
  try {
    const { call, boot, task, project, s } = w;
    const ann = await w.hire("Ann", ["author", "docs"], project);
    const bob = await w.hire("Bob", ["author", "reviewer"], project);
    const rev = await w.hire("Rev", ["reviewer"], project);
    await s.projects.transitionTask({ commandId: "r1", actor: w.rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: w.rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
    await s.assignments.admitAttempt({ commandId: "adm1", actor: w.rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
    const sbm = (await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base: "a".repeat(40), tree: "b".repeat(40), patchId: "c".repeat(40) }, "s1")).result.id as string;
    const mine = await call(ann.token, "deliverable.draft", { taskId: task, type: "code", title: "Patch", submissionIds: [sbm] }, "d1");
    assert.equal(mine.ok, true, JSON.stringify(mine));
    const theirs = await call(bob.token, "deliverable.draft", { taskId: task, type: "code", title: "Stolen", submissionIds: [sbm] }, "d2");
    assert.equal(theirs.error.code, "invalid_command", "another agent's submission cannot be claimed");
    const id = mine.result.id as string;
    assert.equal((await call(ann.token, "deliverable.submit", { id, expectedRevision: 1, contractVersion: 0 }, "sb")).ok, true);
    assert.equal((await call(boot.token, "deliverable.record.get", { id })).result.item.version.review.required, true);
    assert.equal((await call(ann.token, "deliverable.review.start", { id, version: 1 }, "rs0")).error.code, "forbidden");
    assert.equal((await call(rev.token, "deliverable.review.start", { id, version: 1 }, "rs1")).ok, true);
    assert.equal((await call(bob.token, "deliverable.accept", { id, version: 1 }, "ac0")).error.code, "forbidden", "not the reviewer that started it");
    assert.equal((await call(rev.token, "deliverable.accept", { id, version: 1 }, "ac1")).ok, true);

    // A document submission must carry the digest of one of the version's artifacts.
    const art = await w.publish("doc", task);
    const manifest = ((await w.c.storage.getAggregate({ kind: "artifact", id: art }))!.body as unknown as { manifestDigest: string }).manifestDigest;
    const doc = await call(ann.token, "submission.record", { taskId: task, kind: "document", role: "docs", artifactDigest: `sha256:${manifest}`, artifactId: art }, "s2");
    assert.equal(doc.ok, true, JSON.stringify(doc));
    const other = await w.publish("doc2", task);
    assert.equal((await call(ann.token, "deliverable.draft", { taskId: task, type: "document", title: "D", artifacts: [{ artifactId: other }], submissionIds: [doc.result.id] }, "d3")).error.code, "invalid_command", "digest of another artifact");
    assert.equal((await call(ann.token, "deliverable.draft", { taskId: task, type: "document", title: "D", artifacts: [{ artifactId: art }], submissionIds: [doc.result.id] }, "d4")).ok, true);
  } finally { await w.done(); }
});

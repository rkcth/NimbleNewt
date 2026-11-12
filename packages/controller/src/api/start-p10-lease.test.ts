import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptedArgs, CHAT_OPS, ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

// Card P10 (first slice): through the composed controller, the state API takes, renews, lists and releases the integrator lease; a landing without a lease is refused; the owner ends a lease by chat.
test("the integrator lease through the state API and chat, and a landing that must show it (card P10)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const O = boot.token;
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Plant the garden" })).id;
    const grants = [{ action: "integration.lease", project }, { action: "workspace.manage", project }];
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants });
    await c.services.principals.enroll(rob, { commandId: "e-bob", kind: "agent", name: "bob", grants: [{ action: "workspace.manage", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const bob = (await c.services.principals.issueCredential(rob, "agent:bob")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;

    // P10 second slice: no lease can be taken while the project names no landing branch, nor on any other branch than that one.
    assert.equal((await call(ann, "integrator.lease.acquire", { taskId: task, branch: "main", ttlMs: 600_000 }, "a0")).error?.code, "forbidden");
    assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, "lb1")).ok);
    assert.equal((await call(ann, "integrator.lease.acquire", { taskId: task, branch: "squat", ttlMs: 600_000 }, "a0b")).error?.code, "forbidden", "an agent cannot take a branch name that is not the landing branch");
    // The right is its own: bob can manage a checkout but not take the lease.
    assert.equal((await call(bob, "integrator.lease.acquire", { taskId: task, branch: "main", ttlMs: 600_000 }, "b1")).error?.code, "not_found");
    const taken = await call(ann, "integrator.lease.acquire", { taskId: task, branch: "main", ttlMs: 600_000 }, "a1");
    assert.ok(taken.ok, JSON.stringify(taken));
    const lease = taken.result.item;
    assert.deepEqual([lease.holder, lease.fence, lease.live], ["ann", 1, true]);
    assert.equal((await call(ann, "integrator.lease.acquire", { taskId: task, branch: "main", ttlMs: 600_000 }, "a2")).error?.code, "unavailable", "one integrator per branch, even for the holder's second ask");
    assert.equal((await call(ann, "integrator.lease.acquire", { taskId: task, branch: "main", ttlMs: 5 }, "a3")).error?.code, "invalid_command");
    assert.equal((await call(ann, "integrator.lease.acquire", { taskId: task, branch: "main", ttlMs: 600_000, extra: 1 }, "a4")).error?.code, "invalid_command", "unknown arguments are refused");
    assert.equal((await call(bob, "integrator.lease.renew", { leaseId: lease.leaseId, fence: 1 }, "b2")).error?.code, "not_found");
    assert.ok((await call(ann, "integrator.lease.renew", { leaseId: lease.leaseId, fence: 1 }, "a5")).ok);
    assert.equal((await call(ann, "integrator.lease.renew", { leaseId: lease.leaseId, fence: 9 }, "a6")).error?.code, "fenced");
    assert.equal((await call(bob, "integrator.lease.list", { projectId: project })).error?.code, "not_found");
    const listed = (await call(ann, "integrator.lease.list", { projectId: project })).result.items;
    assert.deepEqual(listed.map((l: any) => [l.branch, l.holder, l.live]), [["main", "ann", true]]);

    // A landing without the lease is refused before anything is recorded or asked of a host; with the wrong fence too; a refresh may not carry one.
    const land = (token: string, id: string, extra: Record<string, unknown> = {}) => call(token, "workspace.request", { operation: "landing", taskId: task, reason: "land it", ...extra }, id);
    assert.equal((await land(ann, "w1")).error?.code, "invalid_command");
    assert.equal((await land(ann, "w2", { leaseId: lease.leaseId, fence: 4 })).error?.code, "fenced");
    assert.equal((await land(bob, "w3", { leaseId: lease.leaseId, fence: 1 })).error?.code, "forbidden", "a lease is its holder's: another agent (here without the right at all) is refused");
    const past = await land(ann, "w5", { leaseId: lease.leaseId, fence: 1 });
    assert.equal(past.error?.code, undefined, JSON.stringify(past));
    assert.equal(past.result.state, "refused", "the lease passed; with no host on this controller the landing is refused for that reason, not for the lease");
    assert.match(past.result.summary, /no host/);
    assert.equal(past.result.lease.fence, 1);
    assert.equal((await call(ann, "workspace.request", { operation: "refresh", taskId: task, reason: "x", leaseId: lease.leaseId, fence: 1 }, "w6")).error?.code, "invalid_command");

    // P10 review. The owner may leave the lease out (a lease ID is never the owner's own words, so this is how a landing asked in chat can pass): the live lease of the landing branch is used and recorded.
    const byOwner = await land(O, "wo1");
    assert.equal(byOwner.error?.code, undefined, JSON.stringify(byOwner));
    assert.deepEqual(byOwner.result.lease, { leaseId: lease.leaseId, fence: 1 });
    assert.match(byOwner.result.summary, /no host/);
    // The owner names only an active agent as holder (a typo or the principal form would block the branch for nobody).
    assert.equal((await call(O, "integrator.lease.acquire", { taskId: task, branch: "dev", ttlMs: 600_000, holder: "agent:ann" }, "oa1")).error?.code, "invalid_command");
    assert.equal((await call(O, "integrator.lease.acquire", { taskId: task, branch: "dev", ttlMs: 600_000, holder: "nobody-by-that-name" }, "oa2")).error?.code, "invalid_command");
    await c.services.principals.enroll(rob, { commandId: "e-gone", kind: "agent", name: "gone", grants });
    await c.services.principals.disable(rob, { commandId: "d-gone", principalId: "agent:gone", expectedRevision: (await c.services.principals.get("agent:gone"))!.revision });
    assert.equal((await call(O, "integrator.lease.acquire", { taskId: task, branch: "dev", ttlMs: 600_000, holder: "gone" }, "oa3")).error?.code, "invalid_command", "a disabled agent cannot be named");
    // Taking the right away stops the holder's landings at once, not when its hold runs out.
    const annRev = async () => (await c.services.principals.get("agent:ann"))!.revision;
    await c.services.principals.setGrants(rob, { commandId: "sg1", principalId: "agent:ann", expectedRevision: await annRev(), grants: [{ action: "workspace.manage", project }] });
    assert.equal((await land(ann, "w5r", { leaseId: lease.leaseId, fence: 1 })).error?.code, "forbidden", "the right was taken away");
    assert.equal((await land(O, "w5o")).error?.code, "forbidden", "nor can the owner land for a holder whose right was taken away (P10 second slice review)");
    await c.services.principals.setGrants(rob, { commandId: "sg2", principalId: "agent:ann", expectedRevision: await annRev(), grants });

    // Giving it back: a stranger's release is refused, the holder's works; the owner can end one without a fence.
    assert.equal((await call(bob, "integrator.lease.release", { leaseId: lease.leaseId, fence: 1 }, "r1")).error?.code, "not_found");
    assert.equal((await call(ann, "integrator.lease.release", { leaseId: lease.leaseId }, "r2")).error?.code, "invalid_command");
    assert.equal((await call(ann, "integrator.lease.release", { leaseId: lease.leaseId, fence: 1 }, "r3")).result.item.state, "released");
    assert.equal((await land(ann, "w7", { leaseId: lease.leaseId, fence: 1 })).error?.code, "fenced", "after the release the same numbers land nothing");

    // Chat: the owner ends the lease of a branch in plain words; shown first, applied on the owner's word.
    assert.equal(CHAT_OPS["integrator.lease.release"]?.mode, "propose");
    assert.ok(acceptedArgs("integrator.lease.release")!.includes("branch") && !acceptedArgs("integrator.lease.release")!.includes("commandId"));
    const again = await call(ann, "integrator.lease.acquire", { taskId: task, branch: "main", ttlMs: 600_000 }, "a7");
    assert.equal(again.result.item.fence, 2);
    await c.chat!.setFocus(O, { commandId: "f1", projectId: project });
    const text = "ann is stuck on the main branch landing, take the integrator lease away from her";
    say[text] = [{ kind: "command", op: "integrator.lease.release", args: { branch: "main" }, evidence: text, basis: "owner" }];
    const out = (await c.chat!.submit(O, { messageId: "m1", text })).outcomes;
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    assert.equal((await call(O, "integrator.lease.list", { projectId: project })).result.items[0].live, true, "nothing happens until the owner agrees");
    say["yes, go ahead"] = [{ kind: "apply_proposal", proposalId: out[0]!.proposalId, evidence: "yes, go ahead", basis: "owner" }];
    const done = (await c.chat!.submit(O, { messageId: "m2", text: "yes, go ahead" })).outcomes;
    assert.equal(done[0]!.status, "applied", JSON.stringify(done));
    assert.deepEqual((await call(O, "integrator.lease.list", { projectId: project })).result.items.map((l: any) => [l.state, l.live]), [["released", false]]);
    assert.equal((await call(ann, "integrator.lease.renew", { leaseId: lease.leaseId, fence: 2 }, "a8")).error?.code, "fenced", "the holder it was taken from can no longer renew");
    // P10 second slice: the owner's forced release is a line in the task's activity.
    const steps1 = (await call(O, "activity.steps", { taskId: task })).result.steps as { summary: string }[];
    assert.equal(steps1.filter((x) => /took the integrator lease of branch main away from ann/.test(x.summary)).length, 1, JSON.stringify(steps1));
    // A retired holder: its lease is not usable for a landing at once, and the next agent takes the branch without waiting for expiry (that too is a line in the activity).
    await c.services.principals.enroll(rob, { commandId: "e-cy", kind: "agent", name: "cy", grants });
    const cy = (await c.services.principals.issueCredential(rob, "agent:cy")).token;
    const cyLease = (await call(cy, "integrator.lease.acquire", { taskId: task, branch: "main", ttlMs: 600_000 }, "c1")).result.item;
    assert.equal((await call(ann, "integrator.lease.acquire", { taskId: task, branch: "main", ttlMs: 600_000 }, "a9")).error?.code, "unavailable", "a live holder keeps the branch");
    await c.services.principals.disable(rob, { commandId: "d-cy", principalId: "agent:cy", expectedRevision: (await c.services.principals.get("agent:cy"))!.revision });
    assert.equal((await land(O, "wcy")).error?.code, "fenced", "the owner acting for a retired holder lands nothing");
    const next = await call(ann, "integrator.lease.acquire", { taskId: task, branch: "main", ttlMs: 600_000 }, "a10");
    assert.equal(next.result?.item.holder, "ann", JSON.stringify(next));
    assert.equal(next.result.item.fence, cyLease.fence + 1);
    const steps2 = (await call(O, "activity.steps", { taskId: task })).result.steps as { summary: string }[];
    assert.equal(steps2.filter((x) => /cy is no longer an active agent/.test(x.summary)).length, 1, JSON.stringify(steps2));
  } finally { await c.close(); }
});

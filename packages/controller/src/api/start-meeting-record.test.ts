import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a meeting held through the state API produces a record, a vote, a decision with its reason, and a summary readable by those allowed (card M02b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-mrec-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await tok("ann", [{ action: "task.read", project }, { action: "meeting.attend", project }]);
    const bob = await tok("bob", [{ action: "task.read", project }, { action: "meeting.attend", project }]);
    const zed = await tok("zed", [{ action: "task.read", project }]);

    const urgent = await call(boot.token, "meeting.call-urgent", { projectId: project, title: "Beds", reason: "frost tonight", roster: ["agent:ann", "agent:bob"] }, "mu1");
    assert.ok(urgent.ok, JSON.stringify(urgent));
    const opened = await call(boot.token, "meeting.record.open", { occurrenceId: urgent.result.id, chair: "agent:ann" }, "mo1");
    assert.ok(opened.ok, JSON.stringify(opened));
    const rec = opened.result.id as string;
    assert.equal((await call(zed, "meeting.record.open", { occurrenceId: urgent.result.id }, "mo2")).ok, false);
    for (const [t, id] of [[ann, "j1"], [bob, "j2"]] as const) assert.ok((await call(t, "meeting.record.join", { recordId: rec }, id)).ok, id);
    const said = await call(ann, "meeting.record.append", { recordId: rec, kind: "statement", text: "Frost is forecast for tonight." }, "ap1");
    assert.ok(said.ok && said.result.seq > 0, JSON.stringify(said));
    const motion = await call(ann, "meeting.record.move", { recordId: rec, text: "Cover the beds tonight." }, "mv1");
    assert.ok(motion.ok, JSON.stringify(motion));
    const mid = motion.result.id as string;
    const vote = await call(boot.token, "meeting.record.open-vote", { motionId: mid, expectedVersion: 1 }, "ov1");
    assert.ok(vote.ok, JSON.stringify(vote));
    assert.ok((await call(ann, "meeting.record.cast-ballot", { motionId: mid, version: 1, value: "yes", reason: "frost kills seedlings" }, "b1")).ok);
    assert.ok((await call(bob, "meeting.record.cast-ballot", { motionId: mid, version: 1, value: "yes", reason: "cheap to do" }, "b2")).ok);
    const hidden = await call(zed, "meeting.record.ballots", { motionId: mid });
    assert.notEqual(hidden.result?.item?.ballots?.length, 2, "a stranger does not read the ballots");
    const closed = await call(boot.token, "meeting.record.close-vote", { motionId: mid }, "cv1");
    assert.ok(closed.ok, JSON.stringify(closed));
    assert.equal(closed.result.state, "adopted");
    const decisionId = closed.result.decisionId as string;
    const why = await call(boot.token, "meeting.record.why", { decisionId });
    assert.ok(why.ok && why.result.item.lines.length > 0, JSON.stringify(why));
    assert.ok((await call(boot.token, "meeting.record.discussion", { recordId: rec })).result.item.entries.length >= 2);
    assert.ok((await call(boot.token, "meeting.record.finish", { recordId: rec }, "f1")).ok);
    assert.ok((await call(boot.token, "meeting.record.summarize", { recordId: rec }, "s1")).ok);
    const summary = await call(boot.token, "meeting.record.summary", { recordId: rec });
    assert.ok(summary.ok, JSON.stringify(summary));
    assert.equal((await call(zed, "meeting.record.summary", { recordId: rec })).error?.code ?? "hidden", (await call(zed, "meeting.record.get", { recordId: rec })).error?.code ?? "hidden");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

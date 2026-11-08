import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

// Card C07j through the running controller: the owner marks what a task's hand-offs keep, a section over the limit is cut with a marker, and its original is read back through the state API.
test("a hand-off section over the limit is cut with a marker naming its archive, keeps the owner's marked lines, and the original reads back through the state API to those who may see it (card C07j)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-handoff-cut-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    // The brief is the task's title and description, one entry per line: 100 lines is more than a section holds.
    const lines = Array.from({ length: 100 }, (_, i) => `step ${String(i).padStart(3, "0")}: clear bed ${i} and note what grew there`);
    lines[4] = "step 004: KEEP-ME never dig up the roses";
    lines[10] = "step 010: the shed code is token sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234";
    const description = lines.join("\n");
    const task = (await call(boot.token, "task.create", { projectId: project, title: "weed the beds", description }, "t1")).result.id as string;
    const a = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    const b = (await c.services.agents.create(rob, { commandId: "ag-b", friendlyName: "B" })).id;
    await c.services.contracts.setContract(rob, { commandId: "ct1", taskId: task, expectedVersion: 0, acceptanceCriteria: ["beds are clear"] } as never);
    await call(boot.token, "task.transition", { taskId: task, to: "ready", expectedRevision: 1 }, "tr1");
    assert.ok((await call(boot.token, "task.assign", { taskId: task, owner: { kind: "agent", id: a } }, "as1")).ok);
    await c.services.grants.grant(rob, { commandId: "g-b", grantee: `agent:${b}`, action: "attempt.work", project, source: "direct", basis: "test" });
    await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
    const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;

    // Only the owner marks; the marks are read back.
    assert.equal((await call(zed, "handoff.marks.change", { taskId: task, add: ["keep-me"] }, "m0")).error.code, "forbidden");
    const marked = await call(boot.token, "handoff.marks.change", { taskId: task, add: ["keep-me"] }, "m1");
    assert.ok(marked.ok, JSON.stringify(marked));
    assert.deepEqual(marked.result.item.marks, ["keep-me"]);
    assert.deepEqual((await call(boot.token, "handoff.marks.get", { taskId: task })).result.item.marks, ["keep-me"]);
    assert.equal((await call(boot.token, "handoff.marks.change", { taskId: task, add: ["keep-me"] }, "m1")).result.item.replayed, true);
    // Marks apply to the next package, so the status the chat answers with shows them before any hand-off starts (card C07j review, round 3).
    const before = await call(boot.token, "status.ask", { request: { kind: "handoff", taskId: task } });
    assert.deepEqual(before.result.item.lines.map((l: { text: string }) => l.text), ["No hand-off is going on for this task.", "When a section is cut, entries holding one of the owner's marks are kept first: \"keep-me\"."]);

    const prepared = await call(boot.token, "handoff.prepare", { taskId: task, to: { kind: "agent", id: b }, reason: "A is going on leave" }, "h1");
    assert.ok(prepared.ok, JSON.stringify(prepared));
    const pkg = prepared.result.item.package;
    const brief: string = pkg.sections.brief;
    assert.ok(brief.length <= 4000, `${brief.length}`);
    const m = /^\[cut: (\d+) of (\d+) entries, archive (hnd-[a-z2-7]{20})\]/.exec(brief);
    assert.ok(m !== null, brief.slice(0, 200));
    assert.equal(Number(m[2]), 101, "the title and the 100 lines");
    assert.equal(brief.split("\n")[1], "weed the beds", "the brief's title heads it after the marker, though it is its oldest line");
    assert.ok(brief.includes(lines[4]!), "the owner's marked line is kept");
    assert.ok(brief.includes(lines[99]!), "the newest line is kept");
    assert.doesNotMatch(brief, /sk-live/);
    assert.deepEqual(pkg.cuts.map((x: { section: string; archiveId: string }) => [x.section, x.archiveId]), [["brief", m[3]]]);

    // The original, through the state API: whole (credentials removed), for the owner and the recipient; not found for anyone else.
    const read = await call(boot.token, "handoff.archive.read", { archiveId: m[3] });
    assert.ok(read.ok, JSON.stringify(read));
    const back: string[] = read.result.item.text.split("\n");
    assert.deepEqual(back.filter((_, i) => i !== 11), ["weed the beds", ...lines].filter((_, i) => i !== 11), "every line of the original, in order");
    assert.match(back[11]!, /^step 010: the shed code is token /);
    assert.doesNotMatch(read.result.item.text, /sk-live/, "credentials are removed before anything is kept");
    assert.deepEqual([read.result.item.section, read.result.item.entries, read.result.item.parts], ["brief", 101, 1]);
    const recipient = (await c.services.principals.issueCredential(rob, `agent:${b}`)).token;
    assert.equal((await call(recipient, "handoff.archive.read", { archiveId: m[3] })).error?.code, "not_found", "not before the task is the recipient's");
    const sender = (await c.services.principals.issueCredential(rob, `agent:${a}`)).token;
    assert.equal((await call(sender, "handoff.archive.read", { archiveId: m[3] })).result?.item.text, read.result.item.text, "the sender reads it");
    assert.equal((await call(zed, "handoff.archive.read", { archiveId: m[3] })).error.code, "not_found");
    assert.equal((await call(boot.token, "handoff.archive.read", { archiveId: "hnd-zzzzzzzzzzzzzzzzzzzz" })).error.code, "not_found");
    assert.equal((await call(boot.token, "handoff.archive.read", { archiveId: m[3], part: 1 })).error.code, "invalid_command");

    // The status the chat answers with says what was cut and what the owner keeps.
    const status = await call(boot.token, "status.ask", { request: { kind: "handoff", taskId: task } });
    assert.ok(status.ok, JSON.stringify(status));
    const text = status.result.item.lines.map((l: { text: string }) => l.text).join("\n");
    assert.match(text, new RegExp(`The brief section was cut to fit: ${Number(m[1])} of 101 entries left out or shortened`));
    assert.match(text, new RegExp(`archive ${m[3]}`));
    assert.match(text, /owner's marks are kept first: "keep-me"/);

    // Once the task is the recipient's, it reads the whole of what was cut.
    assert.equal((await call(boot.token, "handoff.complete", { handoffId: prepared.result.item.id, acceptGaps: true }, "h2")).result.item.phase, "transferred");
    assert.equal((await call(recipient, "handoff.archive.read", { archiveId: m[3] })).result?.item.text, read.result.item.text, "the recipient reads it");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

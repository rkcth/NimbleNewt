import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { API_VERSION } from "./index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("an agent's question to the owner appears in the owner's list with its task's context, and the owner's answer closes it; only the owner sees and answers (card U12)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-ownerq-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const agent = (await s.agents.create(owner, { commandId: "ag1", friendlyName: "Ann" })).id;
    const token = (await s.principals.issueCredential(owner, `agent:${agent}`)).token;
    const task = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Order seeds" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
    for (const action of ["attempt.work", "history.append", "history.read"]) await s.grants.grant(owner, { commandId: `g-${action}`, grantee: `agent:${agent}`, action, project, source: "direct", basis: "test" }).catch(() => undefined);
    const call = (t: string, op: string, args: Record<string, unknown> = {}, commandId?: string) => c.api.handle(t, { v: API_VERSION, op, args, ...(commandId === undefined ? {} : { commandId }) });

    const asked = await call(token, "owner.ask", { taskId: task, question: "Which seed supplier should I use?" }, "q1");
    assert.ok(asked.ok, JSON.stringify(asked));
    const id = (asked as unknown as { result: { id: string } }).result.id;
    // A repeat of the same command is the same question.
    assert.equal(((await call(token, "owner.ask", { taskId: task, question: "Which seed supplier should I use?" }, "q1")) as unknown as { result: { id: string; replayed: boolean } }).result.replayed, true);

    const shown = await call(boot.token, "owner.questions");
    assert.ok(shown.ok, JSON.stringify(shown));
    const items = (shown as unknown as { result: { items: { inquiryId: string; question: string; task: { title: string; projectName: string } }[] } }).result.items;
    assert.deepEqual(items.map((i) => [i.inquiryId, i.question, i.task.title, i.task.projectName]), [[id, "Which seed supplier should I use?", "Order seeds", "Garden"]]);
    // Nobody else sees the owner's questions or answers them.
    const peek = await call(token, "owner.questions");
    assert.ok(!peek.ok && peek.error.code === "forbidden", JSON.stringify(peek));
    const sneak = await call(token, "owner.answer", { inquiryId: id, answer: "mine" }, "a0");
    assert.ok(!sneak.ok && sneak.error.code === "forbidden", JSON.stringify(sneak));

    const answered = await call(boot.token, "owner.answer", { inquiryId: id, answer: "Use the co-op" }, "a1");
    assert.ok(answered.ok, JSON.stringify(answered));
    assert.deepEqual(((await call(boot.token, "owner.questions")) as unknown as { result: { items: unknown[] } }).result.items, [], "an answered question leaves the list");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

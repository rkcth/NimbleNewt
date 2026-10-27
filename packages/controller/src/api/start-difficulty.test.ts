import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

// Illustrative names only: nothing here is a default of the product.
const table = {
  providers: { cloudp: { enabled: true, paid: true, location: "cloud" }, localp: { enabled: true, paid: false, location: "local" }, freecloud: { enabled: true, paid: false, location: "cloud" } },
  routes: {
    "localp/small": { contextTokens: 128_000, capabilities: ["tools", "reasoning"] }, "cloudp/big": { contextTokens: 200_000, capabilities: ["tools", "reasoning"] },
    "freecloud/lite": { contextTokens: 64_000, capabilities: ["tools"] },
  },
  profiles: { "r-local": ["localp/small"], "r-cloud": ["cloudp/big", "freecloud/lite"], "r-lite": ["freecloud/lite"] },
  roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" },
};
const profiles = {
  profiles: {
    quick: { harness: "h-one", routingProfile: "r-local", reasoning: { effort: "low" }, tools: ["task.read"] },
    deep: { harness: "h-two", provider: "cloudp", model: "big", routingProfile: "r-local", reasoning: { effort: "high", maxThinkingTokens: 8000 }, contextTokens: 100_000, needs: ["reasoning"], spendLimitMicros: 5_000_000 },
    thrifty: { routingProfile: "r-cloud", spendLimitMicros: 0 },
    lite: { routingProfile: "r-lite" },
  },
  // An expert task on the small local model and a trivial one on the cloud: the owner's choice, and the point of the test: no tier implies where it runs.
  mapping: { trivial: "deep", easy: "quick", medium: "lite", hard: "deep", expert: "quick" },
};

test("difficulty profiles, delegation, escalation and routing decisions work through the state API with rights (card R03)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-diff-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const childTask = (await c.services.projects.createTask({ commandId: "t2", actor: rob.id, projectId: project, title: "Child" })).id;
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const pam = await tok("pam", [{ action: "task.read", project }, { action: "task.contract.write", project }, { action: "task.difficulty.write", project }]);
    const cal = await tok("cal", [{ action: "task.read", project }]);
    const oz = await tok("oz", []);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;

    // Profiles: the owner sets them; others may not read or change them.
    assert.equal((await call(boot.token, "difficulty.profiles", {})).error?.code, "not_found", "no built-in profiles");
    assert.equal((await call(pam, "difficulty.set-profiles", { expectedRevision: 0, profiles }, "sp0")).error?.code, "forbidden");
    assert.equal((await call(oz, "difficulty.profiles", {})).ok, false);
    await c.services.routing.setTable(rob, { commandId: "tbl", expectedRevision: 0, table } as never);
    const set = await call(boot.token, "difficulty.set-profiles", { expectedRevision: 0, profiles }, "sp1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.equal((await call(boot.token, "difficulty.set-profiles", { expectedRevision: 1, profiles: { profiles: {}, mapping: { trivial: "nope" } } }, "sp2")).ok, false, "a bad proposal applies nothing");
    assert.equal((await call(boot.token, "difficulty.profiles", {})).result.item.revision, 1);

    // Delegation and difficulty: the parent sets the child's difficulty; priority is separate.
    const contract = async (id: string) => (await c.services.contracts.get(rob, id))!;
    assert.ok((await call(pam, "difficulty.delegate", { taskId: childTask, child: "agent:cal", ceiling: "medium", retryBudget: 1, totalBudget: 3 }, "dg1")).ok);
    const del = await call(pam, "difficulty.delegation", { taskId: childTask });
    assert.ok(del.ok, JSON.stringify(del));
    assert.equal((await call(oz, "difficulty.set", { taskId: childTask, expectedVersion: (await contract(childTask)).version, difficulty: "hard" }, "ds0")).ok, false, "a non-parent without a grant cannot set difficulty");
    assert.ok((await call(pam, "difficulty.set", { taskId: childTask, expectedVersion: (await contract(childTask)).version, difficulty: "easy" }, "ds1")).ok);

    // Escalation: the child's word is not evidence (a failing child needs recorded attempts), a non-child cannot ask, and the list and decision are reached through the API. The full escalation paths are proven in difficulty.test.ts.
    const esc = await call(cal, "escalation.request", { taskId: childTask, kind: "failing", reason: "three failures", to: "hard" }, "es1");
    assert.equal(esc.error?.code, "invalid_command");
    assert.match(JSON.stringify(esc), /attempts admitted/);
    assert.equal((await call(pam, "escalation.request", { taskId: childTask, kind: "failing", reason: "x" }, "es2")).ok, false, "only the child asks");
    assert.deepEqual((await call(pam, "escalation.list", { taskId: childTask })).result.items, []);
    assert.deepEqual((await call(oz, "escalation.list", { taskId: childTask })).result.items, [], "a task you may not read lists nothing");
    assert.equal((await call(oz, "escalation.decide", { taskId: childTask, escalationId: "esc-aaaaaaaaaaaaaaaaaaaa", approve: true, reason: "x" }, "ed0")).ok, false);

    // Decisions are persisted and queryable once a dispatch has resolved a profile.
    const decisions = await call(boot.token, "routing.decisions", { taskId: childTask });
    assert.ok(decisions.ok, JSON.stringify(decisions));
    assert.ok(Array.isArray(decisions.result.items));
    assert.equal((await call(oz, "routing.decision", { taskId: childTask, decisionId: "dec-aaaaaaaaaaaaaaaaaaaa" })).ok, false);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

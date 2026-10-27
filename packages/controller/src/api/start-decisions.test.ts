import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DecisionService } from "../decisions/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner records, corrects and gates through the state API; the correction supersedes only what conflicts, stays visible, and a gate blocks work at the stored guard (card C08)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-dec-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Dig" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const base = { projectId: project, category: "decision", topic: "database" };

    // Only the owner decides, and only decided words count.
    assert.equal((await call(ann, "decision.record", { ...base, statement: "Use SQLite", wording: "use SQLite", basedOn: 0 }, "dr0")).error?.code, "forbidden");
    const hypo = await call(boot.token, "decision.record", { ...base, statement: "Use DuckDB", wording: "what if we used DuckDB", basedOn: 0, stance: "hypothetical" }, "dr1");
    assert.ok(hypo.ok && hypo.result.recorded === false, JSON.stringify(hypo));
    const v1 = await call(boot.token, "decision.record", { ...base, statement: "Use PostgreSQL", wording: "we will use PostgreSQL", basedOn: 0 }, "dr2");
    assert.ok(v1.ok && v1.result.recorded === true, JSON.stringify(v1));
    assert.equal((await call(boot.token, "decision.record", { ...base, statement: "Use PostgreSQL", wording: "we will use PostgreSQL", basedOn: 1 }, "dr3")).result.recorded, false, "the same decision said again is not a new one");

    // A correction supersedes the old one at once; the old stays visible, marked.
    const v2 = await call(boot.token, "decision.record", { ...base, statement: "Use SQLite", wording: "actually use SQLite instead", basedOn: 1 }, "dr4");
    assert.ok(v2.ok && v2.result.recorded === true && v2.result.superseded.length === 1, JSON.stringify(v2));
    const hist = await call(boot.token, "decision.history", { projectId: project, topic: "database" });
    assert.deepEqual(hist.result.item.map((x: { state: string }) => x.state), ["superseded", "active"]);
    assert.equal((await call(boot.token, "decision.authoritative", { projectId: project, topic: "database" })).result.item.decision.statement, "Use SQLite");
    assert.equal((await call(boot.token, "decision.get", { decisionId: v1.result.id })).result.item.state, "superseded");
    assert.equal((await call(ann, "decision.get", { decisionId: v2.result.id })).error?.code, "not_found", "an agent without the right reads like a missing one");
    assert.ok((await call(boot.token, "decision.context", { projectId: project })).ok);

    // A session that did not see the latest version does not overwrite it: the conflict is surfaced.
    const stale = await call(boot.token, "decision.record", { ...base, statement: "Use MySQL", wording: "use MySQL", basedOn: 1, session: "phone" }, "dr5");
    assert.ok(stale.ok, JSON.stringify(stale));
    assert.ok(stale.result.disputeId !== undefined, JSON.stringify(stale));
    assert.match(stale.result.shown[0], /conflicts with a decision made after/);

    // A gate blocks the task at the stored guard, which the dispatcher consults.
    const gate = await call(boot.token, "decision.record", { projectId: project, category: "gate", gate: "implementation-hold", topic: "implementation-gate", statement: "Hold implementation", wording: "hold all implementation", basedOn: 0 }, "dr6");
    assert.ok(gate.ok && gate.result.recorded === true, JSON.stringify(gate));
    const guard = await DecisionService.withEpoch(c.storage, c.epoch).guard(task, "start");
    assert.equal(guard.blockedBy.length, 1);
    assert.match(guard.blockedBy[0]!, /implementation-hold/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

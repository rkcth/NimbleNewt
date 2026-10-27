import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { GenerationService } from "../generation/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

for (const paused of [false, true]) test(`${paused ? "with the agent paused: " : ""}a correction recorded through the API leaves the generation step pending there; the dispatcher's tick interrupts the running generation, the step is marked done only then, and a restart in between loses nothing (card C08b)`, async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-dec-"));
  const file = join(d, "c.sqlite");
  const open = () => startController({ storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  let c = await open();
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden", repositories: [] } as never)).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Build the store" } as never)).id;
    await s.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "attempt.work", project }] });
    const ann = await s.principals.authenticate((await s.principals.issueCredential(rob, "agent:ann")).token);
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    const decide = (n: string, statement: string, wording: string, basedOn: number) => call("decision.record", { projectId: project, category: "decision", topic: "store", statement, wording, basedOn }, n);
    const first = await decide("d1", "Use PostgreSQL", "use PostgreSQL for the store", 0);
    assert.ok(first.ok && first.result.recorded, JSON.stringify(first));
    const decisionId = first.result.decisionId ?? first.result.id;
    const run = async (storageOwner: typeof c) => GenerationService.withEpoch(storageOwner.storage, storageOwner.epoch, {});
    const gen = await run(c);
    const gate = await gen.gate(rob, task);
    const begun = await gen.begin(ann, { commandId: "g1", taskId: task, contextRevision: gate?.gate.contextRevision ?? 1 });
    await gen.record(ann, { commandId: "r1", runId: begun.id, seq: 1, text: "deploying with PostgreSQL now" });
    assert.ok((await call("decision.link", { taskId: task, subject: { kind: "task", id: task }, decisions: [decisionId] }, "l1")).ok);
    // The correction commits at once. The API's own instance has no generation service, so that step is not done there: it says pending.
    if (paused) await s.pauses.pause(rob, { commandId: "pz", scope: { kind: "task", id: task }, reason: "the owner asked" });
    const fix = await decide("d2", "Use MySQL", "use MySQL, not PostgreSQL", 1);
    assert.ok(fix.ok, JSON.stringify(fix));
    assert.equal(fix.result.propagation, "pending");
    assert.equal((await gen.view(rob, begun.id))!.run.state, "streaming", "not interrupted by a process that has no generation service");
    // A restart before the dispatcher ran: the propagation is still pending and nothing is lost.
    await c.close();
    c = await open();
    const gen2 = await run(c);
    assert.equal((await gen2.view(rob, begun.id))!.run.state, "streaming");
    for (let i = 0; i < 2; i++) await c.dispatch!.dispatcher.tick();
    const cut = (await gen2.view(rob, begun.id))!;
    assert.deepEqual([cut.run.state, cut.run.interrupted?.kind], ["interrupted", "corrected"]);
    const late = await gen2.record(ann, { commandId: "r2", runId: begun.id, seq: 2, text: "...and pushing" });
    assert.deepEqual([late.applied, late.late], [false, true]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { stopServer } from "../domain/testing/backends.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { startTestServer, type TestServer } from "../storage/postgres/testing/server.js";
import { startController } from "./index.js";

after(stopServer);

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

// Card U14e: a task given to an agent starts by itself when the start asks for it (`admitAssigned`): the assignment's event reaches the inbox, which admits one attempt for the one harness the installation ships.
// Without the flag nothing admits an attempt (the controller is driven by hand, as before). The controller starts on SQLite or PostgreSQL; the delivery, inbox and admission records are the domain's, tested on every backend.
async function run(storage: "sqlite" | { pg: TestServer }, extra: Record<string, unknown>, expectAttempts: number): Promise<void> {
  const d = mkdtempSync(join(tmpdir(), "nn-admit-"));
  const choice = storage === "sqlite" ? { kind: "sqlite" as const, path: join(d, "c.sqlite") } : { kind: "postgres" as const, url: storage.pg.url(), schema: `ad_${process.pid}_${Math.random().toString(36).slice(2, 8)}` };
  const c = await startController({ storage: choice, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], ...extra,
    dispatch: { timer: new ManualTimer(), intervalMs: 1000, route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }) } } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const ann = (await s.agents.create(rob, { commandId: "ag1", friendlyName: "Ann" })).id;
    const t = await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Say hello" });
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: t.id, expectedRevision: t.revision, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: t.id, owner: { kind: "agent", id: ann } });
    // Several ticks: the same assignment is never admitted twice.
    for (let i = 0; i < 4; i++) await c.dispatch!.dispatcher.tick();
    const a = (await s.assignments.getAssignment(t.id))!;
    assert.equal(a.attempts, expectAttempts, JSON.stringify(a));
    assert.equal(a.activeAttemptId !== undefined, expectAttempts === 1);
    if (expectAttempts === 1) assert.equal((await s.assignments.getAttempt(a.activeAttemptId!))!.owner.id, ann);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

test("with admitAssigned a task given to an agent gets exactly one attempt from the controller itself; without it nothing admits one (card U14e)", async () => {
  await run("sqlite", { admitAssigned: true }, 1);
  await run("sqlite", {}, 0);
});

test("the same on PostgreSQL (card U14e)", async () => {
  const pg = await startTestServer();
  try { await run({ pg }, { admitAssigned: true }, 1); await run({ pg }, {}, 0); } finally { await pg.stop(); }
});

test("admitAssigned with no harness, or two, admits nothing: it needs exactly one harness to name (card U14e)", async () => {
  await run("sqlite", { admitAssigned: true, harnesses: [] }, 0);
  await run("sqlite", { admitAssigned: true, harnesses: [PI, { ...PI, harness: "other" }] }, 0);
});
